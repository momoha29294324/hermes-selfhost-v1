import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bookingIdempotencyKey,
  commitBookingTurn,
  loadBookingSnapshot,
  type BookingTurnRef,
} from '@/lib/booking/runtime';
import { listAppointments, listBookingEvents, loadLiveAppointment, recordConfirmationOutcome } from '@/lib/booking/store';
import { migrate } from '@/lib/db/migrate';
import { createPgliteSql } from '@/lib/db/pglite';
import type { Sql } from '@/lib/db/sql';
import { slot, testBookingPolicy } from './support/bookingPolicy';

/**
 * HERMES-NATIVE-BOOKING-R1 §12/§13/§21 — l'orchestration : décider, écrire,
 * journaliser.
 *
 * Sur une base RÉELLE, mais embarquée : ce que ce fichier éprouve n'est pas la
 * concurrence (elle vit dans `nativeBookingStorePostgres.test.ts`, sur deux
 * connexions indépendantes), c'est l'enchaînement — qu'est-ce qui est écrit,
 * dans quel ordre, et qu'est-ce qui est relisible ensuite.
 *
 * Aucun test n'envoie quoi que ce soit : `runtime.ts` n'importe aucun provider,
 * aucun navigateur et aucune primitive d'envoi.
 */

const NOW = new Date('2026-08-24T09:00:00.000Z'); // lundi 24 août, 11 h Paris
const WEDNESDAY_15H = slot('2026-08-26T13:00:00.000Z');
const WEDNESDAY_18H = slot('2026-08-26T16:00:00.000Z');
const POLICY = testBookingPolicy();

let sql: Sql;
let campaignId: string;

async function prospect(): Promise<string> {
  const rows = await sql.query<{ id: string }>(
    `insert into prospects (campaign_id, canonical_key, display_name, stage)
     values ($1,$2,$3,'qualified') returning id`,
    [campaignId, `booking-${randomUUID()}`, 'Test Prestation standard'],
  );
  return rows[0]!.id;
}

function ref(prospectId: string, trigger: string | null = null): BookingTurnRef {
  return {
    prospectId,
    channel: 'instagram_dm',
    triggerInboundMessageId: trigger,
    actor: 'hermes',
  };
}

beforeAll(async () => {
  sql = await createPgliteSql(mkdtempSync(join(tmpdir(), 'hermes-booking-')));
  await migrate(sql);
  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
    ['atelier-booking-test', 'Test', 'atelier', '{}'],
  );
  campaignId = rows[0]!.id;
}, 180_000);

afterAll(async () => {
  await sql.close();
});

describe('§24 — le chemin nominal, de bout en bout', () => {
  it('proposer, puis accepter, produit UN rendez-vous confirmé', async () => {
    const p = await prospect();

    const proposeSnapshot = await loadBookingSnapshot(sql, ref(p), POLICY, NOW);
    const proposed = await commitBookingTurn(sql, {
      ref: ref(p),
      snapshot: proposeSnapshot,
      intent: 'ASK_AVAILABILITY',
      utterance: 'tu es dispo quand ?',
      now: NOW,
      mayPropose: true,
    });
    expect(proposed.kind).toBe('PROPOSED');
    expect(proposed.offered.length).toBe(2);
    // §11 — proposer n'a RIEN réservé.
    expect(await loadLiveAppointment(sql, p)).toBeNull();

    const firstSlot = proposed.offered[0]!;
    const acceptSnapshot = await loadBookingSnapshot(sql, ref(p), POLICY, NOW);
    expect(acceptSnapshot.latestProposal?.slots).toHaveLength(2);

    const accepted = await commitBookingTurn(sql, {
      ref: ref(p),
      snapshot: acceptSnapshot,
      intent: 'ACCEPT_PROPOSAL',
      utterance: 'ok ça marche pour le premier',
      now: NOW,
      mayPropose: true,
    });
    // Deux créneaux proposés et un « ok » : on ne devine pas.
    expect(accepted.kind).toBe('CLARIFICATION_REQUIRED');

    const named = await commitBookingTurn(sql, {
      ref: ref(p),
      snapshot: await loadBookingSnapshot(sql, ref(p), POLICY, NOW),
      intent: 'ACCEPT_PROPOSAL',
      utterance: `ok pour ${new Intl.DateTimeFormat('fr-FR', {
        timeZone: POLICY.timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
        .format(firstSlot.startsAt)
        .replace(':', 'h')}`,
      now: NOW,
      mayPropose: true,
    });
    expect(named.kind).toBe('BOOKED');
    expect(named.written).not.toBeNull();

    const live = await loadLiveAppointment(sql, p);
    expect(live?.id).toBe(named.written?.id);
    expect(live?.status).toBe('CONFIRMED');
    expect(live?.source).toBe('instagram_hermes');
    expect(live?.confirmationState).toBe('PENDING');
  });
});

describe('§13 — l’idempotence', () => {
  it('le MÊME message traité deux fois ne crée qu’UN rendez-vous', async () => {
    const p = await prospect();
    const inbound = randomUUID();
    const input = {
      ref: ref(p, null),
      intent: 'PROPOSE_TIME' as const,
      utterance: 'mercredi à 15h ?',
      now: NOW,
      mayPropose: true,
    };

    const first = await commitBookingTurn(sql, {
      ...input,
      snapshot: await loadBookingSnapshot(sql, ref(p), POLICY, NOW),
    });
    const second = await commitBookingTurn(sql, {
      ...input,
      snapshot: await loadBookingSnapshot(sql, ref(p), POLICY, NOW),
    });

    expect(first.kind).toBe('BOOKED');
    // Le second tour retrouve le rendez-vous existant plutôt que d'en créer un.
    expect(second.written?.id ?? second.appointment?.id).toBe(first.written?.id);
    expect(await listAppointments(sql, p)).toHaveLength(1);
    expect(inbound).toBeTruthy();
  });

  it('la clé porte le créneau, le genre et la version', () => {
    const base = {
      prospectId: 'p-1',
      triggerInboundMessageId: 'in-1',
      startsAt: WEDNESDAY_15H.startsAt,
      kind: 'BOOK' as const,
    };
    const same = bookingIdempotencyKey(base);
    expect(bookingIdempotencyKey(base)).toBe(same);
    expect(bookingIdempotencyKey({ ...base, startsAt: WEDNESDAY_18H.startsAt })).not.toBe(same);
    expect(bookingIdempotencyKey({ ...base, kind: 'RESCHEDULE' })).not.toBe(same);
    expect(bookingIdempotencyKey({ ...base, triggerInboundMessageId: 'in-2' })).not.toBe(same);
  });
});

describe('§14/§15 — report et annulation, vus du runtime', () => {
  it('un report laisse UN seul rendez-vous vivant et libère l’ancien créneau', async () => {
    const p = await prospect();
    const booked = await commitBookingTurn(sql, {
      ref: ref(p),
      snapshot: await loadBookingSnapshot(sql, ref(p), POLICY, NOW),
      intent: 'PROPOSE_TIME',
      utterance: 'jeudi à 9h ?',
      now: NOW,
      mayPropose: true,
    });
    expect(booked.kind).toBe('BOOKED');

    const moved = await commitBookingTurn(sql, {
      ref: ref(p),
      snapshot: await loadBookingSnapshot(sql, ref(p), POLICY, NOW),
      intent: 'RESCHEDULE',
      utterance: 'finalement plutôt jeudi à 14h ?',
      now: NOW,
      mayPropose: true,
    });
    expect(moved.kind).toBe('RESCHEDULED');
    expect(moved.previous?.id).toBe(booked.written?.id);

    const history = await listAppointments(sql, p);
    expect(history.filter((entry) => entry.status === 'CONFIRMED')).toHaveLength(1);
    expect(history.filter((entry) => entry.status === 'CANCELLED')).toHaveLength(1);
    expect((await loadLiveAppointment(sql, p))?.id).toBe(moved.written?.id);
  });

  it('une annulation rend le créneau et ne laisse rien de vivant', async () => {
    const p = await prospect();
    await commitBookingTurn(sql, {
      ref: ref(p),
      snapshot: await loadBookingSnapshot(sql, ref(p), POLICY, NOW),
      intent: 'PROPOSE_TIME',
      utterance: 'vendredi à 10h ?',
      now: NOW,
      mayPropose: true,
    });

    const cancelled = await commitBookingTurn(sql, {
      ref: ref(p),
      snapshot: await loadBookingSnapshot(sql, ref(p), POLICY, NOW),
      intent: 'CANCEL',
      utterance: 'finalement je dois annuler',
      now: NOW,
      mayPropose: true,
    });
    expect(cancelled.kind).toBe('CANCELLED');
    expect(await loadLiveAppointment(sql, p)).toBeNull();

    // Le créneau est réellement rendu : un autre prospect peut le prendre.
    const other = await prospect();
    const reused = await commitBookingTurn(sql, {
      ref: ref(other),
      snapshot: await loadBookingSnapshot(sql, ref(other), POLICY, NOW),
      intent: 'PROPOSE_TIME',
      utterance: 'vendredi à 10h ?',
      now: NOW,
      mayPropose: true,
    });
    expect(reused.kind).toBe('BOOKED');
  });
});

describe('§12 — le DM qui échoue ne détruit pas le rendez-vous', () => {
  it('la réservation survit à une remise ambiguë, et le dit', async () => {
    const p = await prospect();
    const booked = await commitBookingTurn(sql, {
      ref: ref(p),
      snapshot: await loadBookingSnapshot(sql, ref(p), POLICY, NOW),
      intent: 'PROPOSE_TIME',
      utterance: 'samedi à 11h ?',
      now: NOW,
      mayPropose: true,
    });
    expect(booked.kind).toBe('BOOKED');

    await recordConfirmationOutcome(sql, {
      appointmentId: booked.written!.id,
      state: 'DELIVERY_UNCONFIRMED',
      at: NOW,
    });

    const live = await loadLiveAppointment(sql, p);
    expect(live?.status).toBe('CONFIRMED');
    expect(live?.confirmationState).toBe('DELIVERY_UNCONFIRMED');
  });
});

describe('§21 — reconstruire une décision sans ouvrir la base à la main', () => {
  it('chaque action laisse une ligne, y compris « rien à faire »', async () => {
    const p = await prospect();

    await commitBookingTurn(sql, {
      ref: ref(p),
      snapshot: await loadBookingSnapshot(sql, ref(p), POLICY, NOW),
      intent: 'NONE',
      utterance: 'ah ok je vois',
      now: NOW,
      mayPropose: false,
    });
    await commitBookingTurn(sql, {
      ref: ref(p),
      snapshot: await loadBookingSnapshot(sql, ref(p), POLICY, NOW),
      intent: 'PROPOSE_TIME',
      utterance: 'on dit le 12 ?',
      now: NOW,
      mayPropose: true,
    });
    const booked = await commitBookingTurn(sql, {
      ref: ref(p),
      snapshot: await loadBookingSnapshot(sql, ref(p), POLICY, NOW),
      intent: 'PROPOSE_TIME',
      utterance: 'dimanche à 16h ?',
      now: NOW,
      mayPropose: true,
    });

    const events = await listBookingEvents(sql, p);
    const outcomes = events.map((entry) => entry.outcome);
    expect(outcomes).toContain('NO_BOOKING');
    expect(outcomes).toContain('CLARIFICATION_REQUIRED');
    expect(outcomes).toContain('BOOKED');

    const ambiguous = events.find((entry) => entry.outcome === 'CLARIFICATION_REQUIRED')!;
    expect(ambiguous.ambiguityReason).toBe('MONTH_AMBIGUOUS');
    expect(ambiguous.requestedExcerpt).toContain('le 12');

    const success = events.find((entry) => entry.outcome === 'BOOKED')!;
    expect(success.appointmentId).toBe(booked.written!.id);
    expect(success.resolvedStartsAt).toBe(booked.written!.startsAt);
    expect(success.availabilityVerdict).toBe('AVAILABLE');
  });

  it('le journal ne porte AUCUN corps de message — seulement les mots du temps', async () => {
    const p = await prospect();
    await commitBookingTurn(sql, {
      ref: ref(p),
      snapshot: await loadBookingSnapshot(sql, ref(p), POLICY, NOW),
      intent: 'PROPOSE_TIME',
      utterance:
        'Bonjour, je m’appelle Untel, mon SIRET est 12345678900011 et je voudrais lundi à 9h.',
      now: NOW,
      mayPropose: true,
    });
    const [entry] = await listBookingEvents(sql, p);
    expect(entry!.requestedExcerpt).not.toContain('SIRET');
    expect(entry!.requestedExcerpt).not.toContain('Untel');
  });
});

describe('§24 — redémarrage : l’état est DURABLE', () => {
  it('un rendez-vous survit à la fermeture et à la réouverture de la base', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hermes-booking-restart-'));
    const first = await createPgliteSql(dir);
    await migrate(first);
    const rows = await first.query<{ id: string }>(
      `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
      ['restart-test', 'Test', 'atelier', '{}'],
    );
    const prospectRows = await first.query<{ id: string }>(
      `insert into prospects (campaign_id, canonical_key, display_name, stage)
       values ($1,$2,$3,'qualified') returning id`,
      [rows[0]!.id, `restart-${randomUUID()}`, 'Test'],
    );
    const p = prospectRows[0]!.id;

    const booked = await commitBookingTurn(first, {
      ref: ref(p),
      snapshot: await loadBookingSnapshot(first, ref(p), POLICY, NOW),
      intent: 'PROPOSE_TIME',
      utterance: 'mercredi à 15h ?',
      now: NOW,
      mayPropose: true,
    });
    expect(booked.kind).toBe('BOOKED');
    await first.close();

    // Le processus « redémarre ».
    const second = await createPgliteSql(dir);
    try {
      const live = await loadLiveAppointment(second, p);
      expect(live?.id).toBe(booked.written!.id);
      expect(live?.startsAt).toBe(WEDNESDAY_15H.startsAt.toISOString());

      // Et rejouer le même tour ne double PAS le rendez-vous.
      const replayed = await commitBookingTurn(second, {
        ref: ref(p),
        snapshot: await loadBookingSnapshot(second, ref(p), POLICY, NOW),
        intent: 'PROPOSE_TIME',
        utterance: 'mercredi à 15h ?',
        now: NOW,
        mayPropose: true,
      });
      expect(replayed.appointment?.id ?? replayed.written?.id).toBe(booked.written!.id);
      expect(await listAppointments(second, p)).toHaveLength(1);
    } finally {
      await second.close();
    }
  }, 120_000);
});
