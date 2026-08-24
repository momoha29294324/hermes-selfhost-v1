/**
 * HERMES-BOOKING-MECHANISM-R1 — le chemin de `QUALIFIED_FOR_CALL` à un
 * rendez-vous PROUVÉ, éprouvé de bout en bout.
 *
 * Aucun test de ce fichier ne produit d'effet Instagram : les modules sous test
 * n'importent aucune primitive d'envoi, aucun navigateur n'est ouvert, aucune
 * ligne d'effet externe n'est écrite, et l'arrêt global n'est ni lu ni touché.
 * Aucun rendez-vous réel n'est créé non plus — la seule chose qui ressemble à
 * un agenda ici est une URL `https://example.invalid`, qui n'existe pas.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import type { Sql } from '@/lib/db/sql';
import {
  BOOKING_MECHANISM_DEFAULT,
  BOOKING_POLICY_VERSION,
  LIVE_BOOKING_STATES,
  assessBookingLifecycle,
  canBookAutonomously,
  checkBookingProof,
  formatBookingLifecycle,
  type BookingLifecycleInput,
} from '@/lib/sales/booking';
import {
  DEMAND_ESCALATION,
  firstEscalatingDemand,
  readCommercialDemands,
} from '@/lib/conversation/commercialPolicy';
import {
  APPOINTMENT_POLICY_VERSION,
  HERMES_OUT_OF_SCOPE,
  HERMES_PRIMARY_COMMERCIAL_OBJECTIVE,
  assessAppointmentQualification,
  renderObjectiveBlock,
  type AppointmentFacts,
} from '@/lib/sales/objective';
import { checkReplyDraft } from '@/lib/replies/draft';
import type { ReplyContext } from '@/lib/replies/context';
import type { ConversationSignals } from '@/lib/conversation/signals';
import type { ConversationState } from '@/lib/conversation/state';
import {
  confirmBookingDestination,
  declineBookingIntent,
  listBookingDestinations,
  loadConfirmedBookingDestination,
  loadLiveBookingIntent,
  markBookingProposalDelivered,
  observeBookingDestination,
  openBookingIntent,
  recordAppointmentProof,
  resolveBookingMechanism,
  revokeBookingDestination,
} from '@/lib/sales/bookingStore';

const NOW = new Date('2026-08-22T12:00:00.000Z');
const FUTURE = '2026-08-27T09:30:00.000Z';
const PAST = '2026-08-01T09:30:00.000Z';
const URL_A = 'https://booking.example.invalid/hermes';
const URL_B = 'https://booking.example.invalid/autre';

async function withDb(fn: (sql: Sql) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-booking-'));
  const sql = await createPgliteSql(dir);
  try {
    await migrate(sql);
    await fn(sql);
  } finally {
    await sql.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function aProspect(sql: Sql): Promise<string> {
  const campaign = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config)
     values ($1, 'Booking Test', 'example-services', '{}'::jsonb) returning id`,
    [`booking-test-${randomUUID()}`],
  );
  const rows = await sql.query<{ id: string }>(
    `insert into prospects (campaign_id, canonical_key, display_name, city, score, score_band)
     values ($1, $2, 'ACME PRESTATION STANDARD', 'Lyon', 74, 'A') returning id`,
    [campaign[0]!.id, `prospect-${randomUUID()}`],
  );
  return rows[0]!.id;
}

/** Une destination CONFIRMED, par les VRAIES fonctions — jamais par un insert. */
async function confirmedDestination(sql: Sql, url = URL_A): Promise<string> {
  const observed = await observeBookingDestination(sql, {
    provider: 'fournisseur-de-test',
    bookingUrl: url,
    reachableStatus: 200,
    observedAt: NOW,
  });
  const confirmed = await confirmBookingDestination(sql, observed.id, 'Opérateur Test', null);
  return confirmed.id;
}

function lifecycle(overrides: Partial<BookingLifecycleInput> = {}): BookingLifecycleInput {
  return {
    qualification: 'QUALIFIED_FOR_CALL',
    mechanism: 'BOOKING_MECHANISM_READY',
    intent: null,
    declined: false,
    conversationFresh: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A — NOT_READY ne peut pas accéder à la réservation
// ---------------------------------------------------------------------------

describe('A — la réservation n’est atteignable que depuis QUALIFIED_FOR_CALL', () => {
  it('refuse toutes les qualifications inférieures, même mécanisme prêt', () => {
    for (const qualification of ['NOT_READY', 'POTENTIALLY_QUALIFIED', 'HUMAN_REVIEW'] as const) {
      const result = assessBookingLifecycle(lifecycle({ qualification }));
      expect(result.state).toBe('NOT_READY');
      expect(result.gate).toBe('qualification');
      expect(result.mayProposeBooking).toBe(false);
    }
  });

  it('ne raccourcit jamais « une réponse est arrivée » en « on peut réserver »', () => {
    // La seule entrée qui ouvre la porte est `qualification`, et elle est
    // décidée ailleurs, par des portes que ce round n'a pas touchées. Aucune
    // combinaison des AUTRES entrées ne peut la remplacer.
    const result = assessBookingLifecycle(
      lifecycle({ qualification: 'POTENTIALLY_QUALIFIED', conversationFresh: true }),
    );
    expect(result.state).toBe('NOT_READY');
  });
});

// ---------------------------------------------------------------------------
// B — QUALIFIED_FOR_CALL peut produire une proposition
// ---------------------------------------------------------------------------

describe('B — une proposition devient possible, et seulement alors', () => {
  it('ouvre BOOKING_PROPOSED sur un mécanisme confirmé et une conversation à jour', () => {
    const result = assessBookingLifecycle(lifecycle());
    expect(result.state).toBe('BOOKING_PROPOSED');
    expect(result.gate).toBe('proposal');
    expect(result.mayProposeBooking).toBe(true);
    expect(formatBookingLifecycle(result)).toBe('BOOKING_PROPOSED:proposal');
  });

  it('ne conclut jamais, quel que soit l’état', () => {
    expect(assessBookingLifecycle(lifecycle()).closingAllowed).toBe(false);
    expect(canBookAutonomously()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C — proposer/envoyer un lien ≠ APPOINTMENT_BOOKED
// ---------------------------------------------------------------------------

describe('C — un lien remis n’est pas un rendez-vous', () => {
  it('une proposition PARTIE mène à BOOKING_PENDING, jamais à APPOINTMENT_BOOKED', () => {
    const result = assessBookingLifecycle(
      lifecycle({
        intent: {
          state: 'BOOKING_PENDING',
          destinationId: 'dest',
          policyVersion: BOOKING_POLICY_VERSION,
          proposalDelivered: true,
        },
      }),
    );
    expect(result.state).toBe('BOOKING_PENDING');
    expect(result.gate).toBe('awaiting_proof');
  });

  it('la machine ne sait PAS fabriquer APPOINTMENT_BOOKED — elle sait le constater', () => {
    // Exhaustif sur les entrées qui n'en portent pas déjà un : aucune
    // combinaison ne produit cet état.
    const states = ['BOOKING_PROPOSED', 'BOOKING_PENDING'] as const;
    for (const qualification of ['NOT_READY', 'POTENTIALLY_QUALIFIED', 'QUALIFIED_FOR_CALL', 'HUMAN_REVIEW'] as const)
      for (const mechanism of ['MISSING_BOOKING_MECHANISM', 'BOOKING_MECHANISM_UNCONFIRMED', 'BOOKING_MECHANISM_READY'] as const)
        for (const declined of [false, true])
          for (const conversationFresh of [false, true])
            for (const intentState of [null, ...states])
              for (const delivered of [false, true]) {
                const result = assessBookingLifecycle({
                  qualification,
                  mechanism,
                  declined,
                  conversationFresh,
                  intent:
                    intentState === null
                      ? null
                      : {
                          state: intentState,
                          destinationId: 'dest',
                          policyVersion: BOOKING_POLICY_VERSION,
                          proposalDelivered: delivered,
                        },
                });
                expect(result.state).not.toBe('APPOINTMENT_BOOKED');
              }
  });

  it('en base non plus : marquer la remise ne réserve rien', async () => {
    await withDb(async (sql) => {
      const prospectId = await aProspect(sql);
      const destinationId = await confirmedDestination(sql);
      const intent = await openBookingIntent(sql, { prospectId, destinationId });
      expect(intent.state).toBe('BOOKING_PROPOSED');

      const delivered = await markBookingProposalDelivered(sql, intent.id);
      expect(delivered.state).toBe('BOOKING_PENDING');
      expect(delivered.proof).toBeNull();

      const reread = await loadLiveBookingIntent(sql, prospectId);
      expect(reread?.state).toBe('BOOKING_PENDING');
    });
  });
});

// ---------------------------------------------------------------------------
// D — une preuve insuffisante est fail-closed
// ---------------------------------------------------------------------------

describe('D — APPOINTMENT_BOOKED exige une preuve, entière', () => {
  const complete = {
    externalBookingRef: 'evt_abc123',
    scheduledStartAt: FUTURE,
    evidenceKind: 'PROVIDER_RECORD' as const,
    observedBy: 'Operator Example',
    observedAt: NOW.toISOString(),
  };

  it('accepte une preuve complète', () => {
    const check = checkBookingProof(complete, NOW);
    expect(check.ok).toBe(true);
  });

  it.each([
    ['référence vide', { externalBookingRef: '   ' }, 'PROOF_REF_MISSING'],
    ['créneau absent', { scheduledStartAt: '' }, 'PROOF_SCHEDULE_MISSING'],
    ['créneau illisible', { scheduledStartAt: 'bientôt' }, 'PROOF_SCHEDULE_INVALID'],
    ['créneau passé', { scheduledStartAt: PAST }, 'PROOF_SCHEDULE_IN_PAST'],
    ['observateur anonyme', { observedBy: '' }, 'PROOF_OBSERVER_MISSING'],
    ['observation sans date', { observedAt: 'hier' }, 'PROOF_OBSERVED_AT_INVALID'],
  ])('refuse : %s', (_label, patch, code) => {
    const check = checkBookingProof({ ...complete, ...patch }, NOW);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.refusals).toContain(code);
  });

  it('la base refuse à son tour un rendez-vous sans preuve', async () => {
    await withDb(async (sql) => {
      const prospectId = await aProspect(sql);
      const destinationId = await confirmedDestination(sql);
      const intent = await openBookingIntent(sql, { prospectId, destinationId });

      // Le contournement du module : un UPDATE direct, tel qu'un appelant futur
      // pourrait l'écrire. La contrainte de 0053 le refuse.
      await expect(
        sql.query(`update booking_intents set state = 'APPOINTMENT_BOOKED' where id = $1`, [
          intent.id,
        ]),
      ).rejects.toThrow();
    });
  });

  it('le module refuse une preuve incomplète avant d’écrire', async () => {
    await withDb(async (sql) => {
      const prospectId = await aProspect(sql);
      const destinationId = await confirmedDestination(sql);
      const intent = await openBookingIntent(sql, { prospectId, destinationId });

      await expect(
        recordAppointmentProof(
          sql,
          { intentId: intent.id, ...complete, externalBookingRef: '' },
          NOW,
        ),
      ).rejects.toMatchObject({ code: 'BOOKING_PROOF_INSUFFICIENT' });

      const reread = await loadLiveBookingIntent(sql, prospectId);
      expect(reread?.state).toBe('BOOKING_PROPOSED');
    });
  });

  it('accepte une preuve complète, et rend APPOINTMENT_BOOKED lisible', async () => {
    await withDb(async (sql) => {
      const prospectId = await aProspect(sql);
      const destinationId = await confirmedDestination(sql);
      const intent = await openBookingIntent(sql, { prospectId, destinationId });
      await markBookingProposalDelivered(sql, intent.id);

      const booked = await recordAppointmentProof(sql, { intentId: intent.id, ...complete }, NOW);
      expect(booked.state).toBe('APPOINTMENT_BOOKED');
      expect(booked.proof?.externalBookingRef).toBe('evt_abc123');
      expect(booked.proof?.observedBy).toBe('Operator Example');

      const assessed = assessBookingLifecycle(
        lifecycle({
          intent: {
            state: booked.state,
            destinationId,
            policyVersion: booked.policyVersion,
            proposalDelivered: booked.proposalDelivered,
          },
        }),
      );
      expect(assessed.state).toBe('APPOINTMENT_BOOKED');
    });
  });
});

// ---------------------------------------------------------------------------
// E — configuration absente ou invalide = fail-closed
// ---------------------------------------------------------------------------

describe('E — sans mécanisme confirmé, la main passe à un humain', () => {
  it('MISSING et UNCONFIRMED mènent tous deux à HUMAN_CLOSE_REQUIRED', () => {
    for (const mechanism of ['MISSING_BOOKING_MECHANISM', 'BOOKING_MECHANISM_UNCONFIRMED'] as const) {
      const result = assessBookingLifecycle(lifecycle({ mechanism }));
      expect(result.state).toBe('HUMAN_CLOSE_REQUIRED');
      expect(result.gate).toBe('booking_mechanism');
      expect(result.mayProposeBooking).toBe(false);
    }
  });

  it('une base vide rend MISSING_BOOKING_MECHANISM — l’état du dépôt', async () => {
    await withDb(async (sql) => {
      expect(await resolveBookingMechanism(sql)).toBe('MISSING_BOOKING_MECHANISM');
      expect(await loadConfirmedBookingDestination(sql)).toBeNull();
      expect(await listBookingDestinations(sql)).toHaveLength(0);
    });
  });

  it('une destination déposée mais non confirmée n’autorise rien', async () => {
    await withDb(async (sql) => {
      await observeBookingDestination(sql, {
        provider: 'fournisseur-de-test',
        bookingUrl: URL_A,
        reachableStatus: 200,
        observedAt: NOW,
      });
      expect(await resolveBookingMechanism(sql)).toBe('BOOKING_MECHANISM_UNCONFIRMED');
    });
  });

  it('un lien jamais vu répondre ne peut pas être confirmé', async () => {
    await withDb(async (sql) => {
      const observed = await observeBookingDestination(sql, {
        provider: 'fournisseur-de-test',
        bookingUrl: URL_A,
        reachableStatus: 404,
        observedAt: NOW,
      });
      await expect(
        confirmBookingDestination(sql, observed.id, 'Opérateur Test', null),
      ).rejects.toMatchObject({ code: 'DESTINATION_UNREACHABLE' });
      expect(await resolveBookingMechanism(sql)).toBe('BOOKING_MECHANISM_UNCONFIRMED');
    });
  });

  it('une confirmation anonyme est refusée', async () => {
    await withDb(async (sql) => {
      const observed = await observeBookingDestination(sql, {
        provider: 'fournisseur-de-test',
        bookingUrl: URL_A,
        reachableStatus: 200,
        observedAt: NOW,
      });
      await expect(confirmBookingDestination(sql, observed.id, '  ', null)).rejects.toMatchObject({
        code: 'CONFIRM_ANONYMOUS',
      });
    });
  });

  it('deux destinations confirmées sont impossibles', async () => {
    await withDb(async (sql) => {
      await confirmedDestination(sql, URL_A);
      const second = await observeBookingDestination(sql, {
        provider: 'autre-fournisseur',
        bookingUrl: URL_B,
        reachableStatus: 200,
        observedAt: NOW,
      });
      await expect(
        confirmBookingDestination(sql, second.id, 'Opérateur Test', null),
      ).rejects.toThrow();
    });
  });

  it('une destination retirée referme le mécanisme et ne revient pas', async () => {
    await withDb(async (sql) => {
      const destinationId = await confirmedDestination(sql);
      await revokeBookingDestination(sql, destinationId, 'Opérateur Test', 'agenda déplacé');
      expect(await resolveBookingMechanism(sql)).toBe('MISSING_BOOKING_MECHANISM');
      await expect(
        confirmBookingDestination(sql, destinationId, 'Opérateur Test', null),
      ).rejects.toMatchObject({ code: 'DESTINATION_REVOKED' });
    });
  });

  it('une piste ne s’ouvre pas sur une destination non confirmée', async () => {
    await withDb(async (sql) => {
      const prospectId = await aProspect(sql);
      const observed = await observeBookingDestination(sql, {
        provider: 'fournisseur-de-test',
        bookingUrl: URL_A,
        reachableStatus: 200,
        observedAt: NOW,
      });
      await expect(
        openBookingIntent(sql, { prospectId, destinationId: observed.id }),
      ).rejects.toMatchObject({ code: 'DESTINATION_NOT_CONFIRMED' });
    });
  });

  it('une lecture qui LÈVE rend l’absence, jamais une permission', async () => {
    const broken = {
      query: () => Promise.reject(new Error('base injoignable')),
    } as unknown as Sql;
    expect(await resolveBookingMechanism(broken)).toBe(BOOKING_MECHANISM_DEFAULT);
  });

  it('une piste ouverte sous une autre politique ne couvre pas celle-ci', () => {
    const result = assessBookingLifecycle(
      lifecycle({
        intent: {
          state: 'BOOKING_PROPOSED',
          destinationId: 'dest',
          policyVersion: 'hermes-booking-r0',
          proposalDelivered: false,
        },
      }),
    );
    expect(result.state).toBe('HUMAN_CLOSE_REQUIRED');
    expect(result.gate).toBe('policy_version');
  });
});

// ---------------------------------------------------------------------------
// H — idempotence : ni doublon, ni rejeu
// ---------------------------------------------------------------------------

describe('H — un prospect, un rendez-vous logique', () => {
  it('deux ouvertures rendent la MÊME piste', async () => {
    await withDb(async (sql) => {
      const prospectId = await aProspect(sql);
      const destinationId = await confirmedDestination(sql);
      const first = await openBookingIntent(sql, { prospectId, destinationId });
      const second = await openBookingIntent(sql, { prospectId, destinationId });
      expect(second.id).toBe(first.id);

      const rows = await sql.query<{ n: string }>(
        `select count(*)::text as n from booking_intents where prospect_id = $1`,
        [prospectId],
      );
      expect(rows[0]!.n).toBe('1');
    });
  });

  it('deux ouvertures CONCURRENTES rendent la même piste', async () => {
    await withDb(async (sql) => {
      const prospectId = await aProspect(sql);
      const destinationId = await confirmedDestination(sql);
      const results = await Promise.all([
        openBookingIntent(sql, { prospectId, destinationId }),
        openBookingIntent(sql, { prospectId, destinationId }),
        openBookingIntent(sql, { prospectId, destinationId }),
      ]);
      expect(new Set(results.map((intent) => intent.id)).size).toBe(1);
    });
  });

  it('rejouer la MÊME preuve rend le même rendez-vous, sans en écrire un second', async () => {
    await withDb(async (sql) => {
      const prospectId = await aProspect(sql);
      const destinationId = await confirmedDestination(sql);
      const intent = await openBookingIntent(sql, { prospectId, destinationId });
      const proof = {
        externalBookingRef: 'evt_replay',
        scheduledStartAt: FUTURE,
        evidenceKind: 'PROVIDER_RECORD' as const,
        observedBy: 'Operator Example',
        observedAt: NOW.toISOString(),
      };
      const first = await recordAppointmentProof(sql, { intentId: intent.id, ...proof }, NOW);
      const again = await recordAppointmentProof(sql, { intentId: intent.id, ...proof }, NOW);
      expect(again.id).toBe(first.id);

      const rows = await sql.query<{ n: string }>(
        `select count(*)::text as n from booking_intents
          where prospect_id = $1 and state = 'APPOINTMENT_BOOKED'`,
        [prospectId],
      );
      expect(rows[0]!.n).toBe('1');
    });
  });

  it('une SECONDE référence sur une piste déjà réservée est un refus, pas une mise à jour', async () => {
    await withDb(async (sql) => {
      const prospectId = await aProspect(sql);
      const destinationId = await confirmedDestination(sql);
      const intent = await openBookingIntent(sql, { prospectId, destinationId });
      const base = {
        scheduledStartAt: FUTURE,
        evidenceKind: 'PROVIDER_RECORD' as const,
        observedBy: 'Operator Example',
        observedAt: NOW.toISOString(),
      };
      await recordAppointmentProof(
        sql,
        { intentId: intent.id, externalBookingRef: 'evt_1', ...base },
        NOW,
      );
      await expect(
        recordAppointmentProof(
          sql,
          { intentId: intent.id, externalBookingRef: 'evt_2', ...base },
          NOW,
        ),
      ).rejects.toMatchObject({ code: 'BOOKING_ALREADY_PROVEN' });
    });
  });

  it('un prospect réservé ne peut pas ouvrir une seconde piste vivante', async () => {
    await withDb(async (sql) => {
      const prospectId = await aProspect(sql);
      const destinationId = await confirmedDestination(sql);
      const intent = await openBookingIntent(sql, { prospectId, destinationId });
      await recordAppointmentProof(
        sql,
        {
          intentId: intent.id,
          externalBookingRef: 'evt_unique',
          scheduledStartAt: FUTURE,
          evidenceKind: 'PROVIDER_RECORD',
          observedBy: 'Operator Example',
          observedAt: NOW.toISOString(),
        },
        NOW,
      );
      const again = await openBookingIntent(sql, { prospectId, destinationId });
      expect(again.id).toBe(intent.id);
      expect(again.state).toBe('APPOINTMENT_BOOKED');
    });
  });

  it('un refus sort du vivant, et une preuve ne le renverse pas en silence', async () => {
    await withDb(async (sql) => {
      const prospectId = await aProspect(sql);
      const destinationId = await confirmedDestination(sql);
      const intent = await openBookingIntent(sql, { prospectId, destinationId });
      const declined = await declineBookingIntent(sql, intent.id);
      expect(declined.state).toBe('BOOKING_DECLINED');
      expect(await loadLiveBookingIntent(sql, prospectId)).toBeNull();

      await expect(
        recordAppointmentProof(
          sql,
          {
            intentId: intent.id,
            externalBookingRef: 'evt_after_decline',
            scheduledStartAt: FUTURE,
            evidenceKind: 'PROVIDER_RECORD',
            observedBy: 'Operator Example',
            observedAt: NOW.toISOString(),
          },
          NOW,
        ),
      ).rejects.toMatchObject({ code: 'INTENT_DECLINED' });
    });
  });

  it('rejouer une remise déjà enregistrée n’est pas une faute', async () => {
    await withDb(async (sql) => {
      const prospectId = await aProspect(sql);
      const destinationId = await confirmedDestination(sql);
      const intent = await openBookingIntent(sql, { prospectId, destinationId });
      const first = await markBookingProposalDelivered(sql, intent.id);
      const again = await markBookingProposalDelivered(sql, intent.id);
      expect(again.id).toBe(first.id);
      expect(again.state).toBe('BOOKING_PENDING');
    });
  });

  it('la définition de « vivant » du code est celle de l’index de 0053', () => {
    expect([...LIVE_BOOKING_STATES].sort()).toEqual(
      ['APPOINTMENT_BOOKED', 'BOOKING_PENDING', 'BOOKING_PROPOSED'].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// I — une conversation dépassée ne réserve rien
// ---------------------------------------------------------------------------

describe('I — la fraîcheur borne la proposition', () => {
  it('une conversation dépassée reste QUALIFIED_FOR_CALL, sans proposition', () => {
    const result = assessBookingLifecycle(lifecycle({ conversationFresh: false }));
    expect(result.state).toBe('QUALIFIED_FOR_CALL');
    expect(result.gate).toBe('freshness');
    expect(result.mayProposeBooking).toBe(false);
  });

  it('un refus l’emporte sur la fraîcheur et sur le mécanisme', () => {
    const result = assessBookingLifecycle(lifecycle({ declined: true }));
    expect(result.state).toBe('BOOKING_DECLINED');
    expect(result.gate).toBe('decline');
  });

  it('un rendez-vous établi survit à un tour dépassé', () => {
    const result = assessBookingLifecycle(
      lifecycle({
        conversationFresh: false,
        qualification: 'NOT_READY',
        mechanism: 'MISSING_BOOKING_MECHANISM',
        intent: {
          state: 'APPOINTMENT_BOOKED',
          destinationId: 'dest',
          policyVersion: BOOKING_POLICY_VERSION,
          proposalDelivered: true,
        },
      }),
    );
    expect(result.state).toBe('APPOINTMENT_BOOKED');
    expect(result.gate).toBe('existing_intent');
  });
});

// ---------------------------------------------------------------------------
// J — aucun effet Instagram n'est nécessaire, et aucun n'est possible
// ---------------------------------------------------------------------------

describe('J — les modules de réservation ne savent pas envoyer', () => {
  it('ne portent aucune primitive d’effet ni d’envoi', async () => {
    const { readFileSync } = await import('node:fs');
    for (const file of ['src/lib/sales/booking.ts', 'src/lib/sales/bookingStore.ts']) {
      const source = readFileSync(file, 'utf8');
      for (const forbidden of [
        'sendThreadReply',
        'sendFirstTouchDm',
        'setKillSwitch',
        'OUTBOUND_ALLOW_SENDING',
        'playwright',
        'chromium',
      ]) {
        expect(source).not.toContain(forbidden);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// F — le prix reste inconnu, et il continue d'escalader
// ---------------------------------------------------------------------------

describe('F — ce que Hermes ne sait pas, un mécanisme de réservation ne l’apprend pas', () => {
  it('une demande de prix escalade toujours vers un humain', () => {
    for (const text of [
      'C’est combien par mois ?',
      'Vous prenez quel pourcentage ?',
      'Il y a des frais de mise en place ?',
      'Vous garantissez des résultats ?',
      'Il y a un contrat à signer ?',
    ]) {
      const escalating = firstEscalatingDemand(readCommercialDemands(text));
      expect(escalating, text).not.toBeNull();
      expect(escalating?.reason).not.toBeNull();
    }
  });

  it('la table d’escalade n’a pas été desserrée par ce round', () => {
    expect(DEMAND_ESCALATION.EXACT_PRICE).toBe('pricing_policy_missing');
    expect(DEMAND_ESCALATION.PERCENTAGE_OR_FEE).toBe('pricing_policy_missing');
    expect(DEMAND_ESCALATION.CONTRACT_COMMITMENT).toBe('contract_terms_requested');
    expect(DEMAND_ESCALATION.GUARANTEE).toBe('guarantee_requested');
    // HERMES-ACQUISITION-SERVICE-TRUTH-R1 — `AD_SPEND_AMOUNT` a changé de camp,
    // et pas par ce round-ci : l'opérateur a écrit le budget publicitaire de
    // départ le 23 août 2026. Ce que CE test protège reste vrai — le mécanisme
    // de réservation n'a desserré aucune de ces entrées.
    expect(DEMAND_ESCALATION.AD_SPEND_AMOUNT).toBeNull();
    // L'essai n'est plus la SEULE chose répondable ; elles sont deux, et pas
    // une de plus.
    expect(DEMAND_ESCALATION.TRIAL_TERMS).toBeNull();
    expect(
      Object.entries(DEMAND_ESCALATION).filter(([, reason]) => reason === null).map(([demand]) => demand).sort(),
    ).toEqual(['AD_SPEND_AMOUNT', 'TRIAL_TERMS']);
  });

  it('l’objectif et ce qu’il exclut restent ceux de la politique', () => {
    expect(HERMES_PRIMARY_COMMERCIAL_OBJECTIVE).toBe('QUALIFIED_APPOINTMENT_BOOKED');
    expect(HERMES_OUT_OF_SCOPE).toContain('conclure une vente dans un message');
    expect(HERMES_OUT_OF_SCOPE).toContain('négocier un contrat ou ses conditions');
    expect(HERMES_OUT_OF_SCOPE).toContain('fixer une date ferme, choisir un créneau, ou écrire dans un agenda');
  });

  it('le bloc d’objectif ne promet aucun lien tant qu’aucun n’existe', () => {
    const block = renderObjectiveBlock();
    expect(block).toContain('Aucun lien de réservation n’existe');
    expect(block).toContain(APPOINTMENT_POLICY_VERSION);
    expect(block).not.toContain('https://');
  });

  it('et il transmet le lien EXACT quand une destination est confirmée', () => {
    const block = renderObjectiveBlock({
      mechanism: 'BOOKING_MECHANISM_READY',
      bookingUrl: URL_A,
    });
    expect(block).toContain(URL_A);
    expect(block).toContain('Recopie-le exactement');
    expect(block).not.toContain('Aucun lien de réservation n’existe');
  });
});

// ---------------------------------------------------------------------------
// G — `call_too_early` reste intact
// ---------------------------------------------------------------------------

function appointmentFacts(overrides: Partial<AppointmentFacts> = {}): AppointmentFacts {
  const signals = {
    questionTopic: 'NONE',
    objectionTopic: 'NONE',
    buyingSignal: 'NONE',
    callReadiness: 'LOW',
    explicitCallRequest: false,
    sensitiveFlags: [],
  } as unknown as ConversationSignals;
  const state = {
    goal: 'ANSWER_QUESTION',
    humanNeeded: false,
    isFirstReply: true,
    inboundTurnCount: 1,
  } as unknown as ConversationState;

  return {
    identityConfirmed: true,
    suppressed: false,
    outreachState: 'REPLIED',
    terminalCategoryInThread: null,
    category: 'QUESTION',
    signals,
    state,
    offerReadiness: 'LOW',
    icpConformity: 'PASSED_AT_FIRST_TOUCH',
    ...overrides,
  } as AppointmentFacts;
}

describe('G — configurer un agenda n’abaisse pas la barre de l’appel', () => {
  it('un mécanisme PRÊT ne rend pas une conversation tiède qualifiée', () => {
    const withoutMechanism = assessAppointmentQualification(appointmentFacts());
    const withMechanism = assessAppointmentQualification(
      appointmentFacts({
        booking: {
          mechanism: 'BOOKING_MECHANISM_READY',
          intent: null,
          declined: false,
          conversationFresh: true,
        },
      }),
    );
    expect(withoutMechanism.qualification).toBe('NOT_READY');
    expect(withMechanism.qualification).toBe('NOT_READY');
    // La sortie qui commande `call_too_early` est identique dans les deux cas.
    expect(withMechanism.callTransitionAllowed).toBe(withoutMechanism.callTransitionAllowed);
    expect(withMechanism.callTransitionAllowed).toBe(false);
    expect(withMechanism.gate).toBe(withoutMechanism.gate);
  });

  it('la porte de l’autonomie ne lit RIEN de la réservation', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/lib/conversation/autonomy.ts', 'utf8');
    // `callJustified` est la condition exacte de `call_too_early`. Elle lit
    // trois choses, et aucune ne vient de ce round.
    const gate = source.slice(source.indexOf('const callJustified'), source.indexOf('if (draft.proposesCall'));
    expect(gate).toContain('explicitCallRequest');
    expect(gate).toContain("callReadiness === 'HIGH'");
    expect(gate).toContain("appointmentQualification === 'QUALIFIED_FOR_CALL'");
    expect(gate).not.toContain('booking');
    expect(gate).not.toContain('BOOKING');
  });

  it('la politique de rendez-vous ne conclut toujours pas', () => {
    expect(assessAppointmentQualification(appointmentFacts()).closingAllowed).toBe(false);
  });

  it('sans faits de réservation, l’assessment se comporte comme avant ce round', () => {
    const result = assessAppointmentQualification(
      appointmentFacts({
        signals: {
          questionTopic: 'NONE',
          objectionTopic: 'NONE',
          buyingSignal: 'NONE',
          callReadiness: 'HIGH',
          explicitCallRequest: true,
          sensitiveFlags: [],
        } as unknown as ConversationSignals,
        category: 'INTERESTED',
      }),
    );
    expect(result.qualification).toBe('QUALIFIED_FOR_CALL');
    expect(result.handoff).toBe('HUMAN_CLOSE_REQUIRED');
    expect(result.booking).toBe('MISSING_BOOKING_MECHANISM');
    expect(result.bookingLifecycle.state).toBe('HUMAN_CLOSE_REQUIRED');
    expect(result.bookingLifecycle.gate).toBe('booking_mechanism');
  });
});

// ---------------------------------------------------------------------------
// La garde de lien — fail-closed par défaut, nominative sinon
// ---------------------------------------------------------------------------

describe('la garde de lien n’accepte que le lien confirmé, à la lettre', () => {
  const context = {
    reply: { bodyText: 'Comment ça marche ?' },
    firstTouch: { body: 'Bonjour' },
    research: null,
  } as unknown as ReplyContext;

  it('bloque tout lien quand aucune destination n’est confirmée', () => {
    const flags = checkReplyDraft(`Voici mon agenda : ${URL_A}`, context);
    expect(flags.some((flag) => flag.code === 'unconfigured_link' && flag.blocking)).toBe(true);
  });

  it('accepte le lien confirmé, ponctuation française comprise', () => {
    for (const body of [`Vous pouvez réserver ici : ${URL_A}`, `Réservez ici : ${URL_A}.`]) {
      const flags = checkReplyDraft(body, context, { allowedBookingUrl: URL_A });
      expect(flags.some((flag) => flag.code === 'unconfigured_link')).toBe(false);
    }
  });

  it('bloque tout AUTRE lien, même du même domaine', () => {
    const flags = checkReplyDraft(`Et aussi ${URL_B}`, context, { allowedBookingUrl: URL_A });
    expect(flags.some((flag) => flag.code === 'unconfigured_link' && flag.blocking)).toBe(true);
  });

  it('bloque le second lien d’un message qui en porte deux', () => {
    const flags = checkReplyDraft(`${URL_A} et ${URL_B}`, context, { allowedBookingUrl: URL_A });
    const blocked = flags.filter((flag) => flag.code === 'unconfigured_link');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.excerpt).toBe(URL_B);
  });
});
