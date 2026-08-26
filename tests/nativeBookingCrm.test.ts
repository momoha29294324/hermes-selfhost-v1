import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commitBookingTurn, loadBookingSnapshot, type BookingTurnRef } from '@/lib/booking/runtime';
import { loadCrmWorkspace } from '@/lib/crm/queries';
import { CRM_LANES, CRM_PRIMARY_LANES, resolveCommercialState, resolveLane } from '@/lib/crm/view';
import { migrate } from '@/lib/db/migrate';
import { createPgliteSql } from '@/lib/db/pglite';
import type { Sql } from '@/lib/db/sql';
import { testBookingPolicy } from './support/bookingPolicy';

/**
 * HERMES-NATIVE-BOOKING-R1 §16/§17 — le rendez-vous est VISIBLE et EXPLOITABLE
 * dans le CRM existant.
 *
 * Ce round n'a pas rouvert le chantier UI : il ajoute une lecture, une colonne
 * et une carte. Ces tests vérifient les deux premières — la troisième est du
 * JSX qui lit exactement ce que la première rend.
 */

const NOW = new Date('2026-08-24T09:00:00.000Z');
const POLICY = testBookingPolicy();

let sql: Sql;
let campaignId: string;

async function prospect(): Promise<string> {
  const rows = await sql.query<{ id: string }>(
    `insert into prospects (campaign_id, canonical_key, display_name, stage)
     values ($1,$2,$3,'qualified') returning id`,
    [campaignId, `crm-booking-${randomUUID()}`, 'Test Prestation standard'],
  );
  return rows[0]!.id;
}

function ref(prospectId: string): BookingTurnRef {
  return { prospectId, channel: 'instagram_dm', triggerInboundMessageId: null, actor: 'hermes' };
}

beforeAll(async () => {
  sql = await createPgliteSql(mkdtempSync(join(tmpdir(), 'hermes-booking-crm-')));
  await migrate(sql);
  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
    ['atelier-crm-booking', 'Test', 'atelier', '{}'],
  );
  campaignId = rows[0]!.id;
}, 180_000);

afterAll(async () => {
  await sql.close();
});

describe('§16 — la fiche prospect voit le rendez-vous', () => {
  it('un rendez-vous pris apparaît dans le workspace, avec sa source et son état', async () => {
    const p = await prospect();
    const booked = await commitBookingTurn(sql, {
      ref: ref(p),
      snapshot: await loadBookingSnapshot(sql, ref(p), POLICY, NOW),
      intent: 'PROPOSE_TIME',
      utterance: 'mercredi à 15h ?',
      now: NOW,
      mayPropose: true,
    });
    expect(booked.kind).toBe('BOOKED');

    const workspace = await loadCrmWorkspace(p, sql);
    expect(workspace).not.toBeNull();
    expect(workspace!.appointments).toHaveLength(1);
    const [entry] = workspace!.appointments;
    expect(entry).toMatchObject({
      id: booked.written!.id,
      status: 'CONFIRMED',
      source: 'instagram_hermes',
      confirmationState: 'PENDING',
      timezone: 'Europe/Paris',
    });
    expect(entry!.startsAt).toBe('2026-08-26T13:00:00.000Z');
  });

  it('un prospect SANS rendez-vous rend une liste vide, pas une erreur', async () => {
    const p = await prospect();
    const workspace = await loadCrmWorkspace(p, sql);
    expect(workspace!.appointments).toEqual([]);
  });

  it('l’HISTORIQUE d’un report est lisible : deux lignes, une seule confirmée', async () => {
    const p = await prospect();
    await commitBookingTurn(sql, {
      ref: ref(p),
      snapshot: await loadBookingSnapshot(sql, ref(p), POLICY, NOW),
      intent: 'PROPOSE_TIME',
      utterance: 'jeudi à 10h ?',
      now: NOW,
      mayPropose: true,
    });
    await commitBookingTurn(sql, {
      ref: ref(p),
      snapshot: await loadBookingSnapshot(sql, ref(p), POLICY, NOW),
      intent: 'RESCHEDULE',
      utterance: 'finalement plutôt jeudi à 16h ?',
      now: NOW,
      mayPropose: true,
    });

    const workspace = await loadCrmWorkspace(p, sql);
    expect(workspace!.appointments).toHaveLength(2);
    expect(workspace!.appointments.filter((entry) => entry.status === 'CONFIRMED')).toHaveLength(1);
    expect(workspace!.appointments.filter((entry) => entry.status === 'CANCELLED')).toHaveLength(1);
  });

  it('le prospect porte le FAIT « un rendez-vous existe »', async () => {
    const p = await prospect();
    const before = await loadCrmWorkspace(p, sql);
    expect(before!.prospect.hasConfirmedAppointment).toBe(false);

    await commitBookingTurn(sql, {
      ref: ref(p),
      snapshot: await loadBookingSnapshot(sql, ref(p), POLICY, NOW),
      intent: 'PROPOSE_TIME',
      utterance: 'vendredi à 11h ?',
      now: NOW,
      mayPropose: true,
    });

    const after = await loadCrmWorkspace(p, sql);
    expect(after!.prospect.hasConfirmedAppointment).toBe(true);
    expect(after!.prospect.lane).toBe('APPOINTMENT');
  });

  it('une ANNULATION retire le prospect de la colonne « Rendez-vous pris »', async () => {
    const p = await prospect();
    await commitBookingTurn(sql, {
      ref: ref(p),
      snapshot: await loadBookingSnapshot(sql, ref(p), POLICY, NOW),
      intent: 'PROPOSE_TIME',
      utterance: 'samedi à 14h ?',
      now: NOW,
      mayPropose: true,
    });
    expect((await loadCrmWorkspace(p, sql))!.prospect.lane).toBe('APPOINTMENT');

    await commitBookingTurn(sql, {
      ref: ref(p),
      snapshot: await loadBookingSnapshot(sql, ref(p), POLICY, NOW),
      intent: 'CANCEL',
      utterance: 'je dois annuler',
      now: NOW,
      mayPropose: true,
    });

    const after = await loadCrmWorkspace(p, sql);
    expect(after!.prospect.hasConfirmedAppointment).toBe(false);
    expect(after!.prospect.lane).not.toBe('APPOINTMENT');
    // Mais l'historique est toujours là.
    expect(after!.appointments).toHaveLength(1);
  });
});

describe('§17 — la colonne, et ce qu’elle ne renverse pas', () => {
  const base = {
    stage: 'qualified' as const,
    outreachState: null,
    sentCount: 0,
    hasLockedManifest: false,
    isClient: false,
    doNotContact: false,
  };

  it('« Rendez-vous pris » est une colonne du parcours actif', () => {
    expect(CRM_PRIMARY_LANES).toContain('APPOINTMENT');
    expect(CRM_LANES.map((lane) => lane.key)).toContain('APPOINTMENT');
  });

  it('un rendez-vous l’emporte sur l’état commercial de la machine', () => {
    expect(resolveLane({ ...base, outreachState: 'REPLIED', sentCount: 1 })).toBe('REPLIED');
    expect(
      resolveLane({ ...base, outreachState: 'REPLIED', sentCount: 1, hasConfirmedAppointment: true }),
    ).toBe('APPOINTMENT');
  });

  it('mais il ne renverse NI une suppression, NI un refus, NI un client', () => {
    expect(resolveLane({ ...base, hasConfirmedAppointment: true, doNotContact: true })).toBe(
      'PROTECTED',
    );
    expect(
      resolveLane({ ...base, hasConfirmedAppointment: true, outreachState: 'SUPPRESSED' }),
    ).toBe('PROTECTED');
    expect(resolveLane({ ...base, hasConfirmedAppointment: true, isClient: true })).toBe('CLIENT');
  });

  it('sans le champ, le comportement est celui d’AVANT ce round, au champ près', () => {
    expect(resolveLane({ ...base, outreachState: 'INTERESTED', sentCount: 1 })).toBe('INTERESTED');
    expect(
      resolveLane({ ...base, outreachState: 'INTERESTED', sentCount: 1, hasConfirmedAppointment: false }),
    ).toBe('INTERESTED');
  });

  it('la phrase affichée et la colonne sortent du MÊME calcul', () => {
    const state = resolveCommercialState({
      ...base,
      outreachState: 'INTERESTED',
      sentCount: 1,
      hasConfirmedAppointment: true,
      lastReplyAt: NOW.toISOString(),
    });
    expect(state.lane).toBe('APPOINTMENT');
    expect(state.label).toContain('Rendez-vous');
  });
});
