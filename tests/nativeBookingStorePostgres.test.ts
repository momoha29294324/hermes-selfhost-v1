import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BookingStoreRefusal,
  cancelAppointment,
  listAppointments,
  loadBusyIntervals,
  loadLiveAppointment,
  recordConfirmationOutcome,
  recordProposal,
  loadLatestProposal,
  rescheduleAppointment,
  reserveAppointment,
} from '@/lib/booking/store';
import type { PostgresConfig } from '@/lib/db/config';
import { migrate } from '@/lib/db/migrate';
import { createPostgresSql } from '@/lib/db/postgres';
import type { Sql } from '@/lib/db/sql';

/**
 * HERMES-NATIVE-BOOKING-R1 §5 — l'anti-double-réservation, sur un PostgreSQL
 * RÉEL et avec deux connexions INDÉPENDANTES.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi le moteur embarqué ne suffit pas ici
 * ---------------------------------------------------------------------------
 * PGlite est un vrai PostgreSQL, mais un seul processus peut l'ouvrir : il sait
 * donc prouver que la contrainte d'exclusion REFUSE un chevauchement, et pas ce
 * qui compte réellement — deux connexions qui se disputent le même créneau à la
 * même microseconde. Ce fichier ouvre deux pools distincts sur le même cluster,
 * ce qui est la situation réelle du runtime (trois runtimes Hermes tournent en
 * permanence sur cette machine).
 *
 * Sauté tant que `OUTBOUND_TEST_DATABASE_URL` ne pointe pas sur une base
 * jetable. Cette base n'est jamais le corpus.
 *
 * Aucun test n'envoie quoi que ce soit : le module sous test n'importe aucune
 * primitive d'envoi, et aucune ligne d'effet externe n'est écrite ici.
 */

const TEST_URL = process.env['OUTBOUND_TEST_DATABASE_URL'];
const describeIfPostgres = TEST_URL ? describe : describe.skip;

const TZ = 'Europe/Paris';

function config(applicationName: string): PostgresConfig {
  return {
    backend: 'postgres',
    connectionString: TEST_URL as string,
    poolMax: 5,
    applicationName,
    ssl: 'disable',
    statementTimeoutMs: 0,
    idleTimeoutMs: 5_000,
    connectionTimeoutMs: 10_000,
  };
}

function at(iso: string): Date {
  return new Date(iso);
}

function slot(startIso: string, minutes = 30) {
  const startsAt = at(startIso);
  return { startsAt, endsAt: new Date(startsAt.getTime() + minutes * 60_000) };
}

describeIfPostgres('HERMES-NATIVE-BOOKING-R1 §5 — réservation atomique', () => {
  let alpha: Sql;
  let beta: Sql;
  let campaignId: string;

  async function prospect(): Promise<string> {
    const rows = await alpha.query<{ id: string }>(
      `insert into prospects (campaign_id, canonical_key, display_name, stage)
       values ($1,$2,$3,'qualified') returning id`,
      [campaignId, `booking-r1-${randomUUID()}`, `Test ${randomUUID().slice(0, 8)}`],
    );
    return rows[0]!.id;
  }

  function reserveInput(prospectId: string, interval: ReturnType<typeof slot>, key: string) {
    return {
      prospectId,
      calendarKey: 'hermes-operator',
      conversationKey: `instagram_dm:${prospectId}`,
      interval,
      timezone: TZ,
      source: 'instagram_hermes' as const,
      triggerInboundMessageId: null,
      idempotencyKey: key,
      createdBy: 'test',
    };
  }

  beforeAll(async () => {
    alpha = await createPostgresSql(config('native-booking-alpha'));
    beta = await createPostgresSql(config('native-booking-beta'));
    await migrate(alpha);
    // Une base jetable qu'on relance garde ses lignes. Les créneaux de ce
    // fichier sont des dates FIXES — c'est ce qui les rend lisibles — donc une
    // seconde exécution se heurterait à ses propres rendez-vous. On repart d'un
    // agenda vide, et seulement de celui-là : aucune autre table n'est touchée.
    await alpha.exec(
      'truncate hermes_booking_events, hermes_booking_proposals, hermes_appointments cascade',
    );
    const rows = await alpha.query<{ id: string }>(
      `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
      [`booking-r1-${randomUUID().slice(0, 8)}`, 'Test', 'atelier', '{}'],
    );
    campaignId = rows[0]!.id;
  }, 180_000);

  afterAll(async () => {
    await alpha.close();
    await beta.close();
  });

  it('deux conversations concurrentes : exactement UNE obtient le créneau', async () => {
    const a = await prospect();
    const b = await prospect();
    const interval = slot('2026-09-02T13:00:00.000Z');

    // Les deux ont LU « libre » — c'est la prémisse du test, et elle est vraie.
    const busyBefore = await loadBusyIntervals(alpha, {
      from: interval.startsAt,
      to: interval.endsAt,
    });
    expect(busyBefore).toHaveLength(0);

    const results = await Promise.allSettled([
      reserveAppointment(alpha, reserveInput(a, interval, `race-a-${randomUUID()}`)),
      reserveAppointment(beta, reserveInput(b, interval, `race-b-${randomUUID()}`)),
    ]);

    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);

    const rejection = (lost[0] as PromiseRejectedResult).reason;
    expect(rejection).toBeInstanceOf(BookingStoreRefusal);
    expect((rejection as BookingStoreRefusal).code).toBe('SLOT_TAKEN');

    // Et la base le confirme : un seul confirmé sur cet intervalle.
    const busyAfter = await loadBusyIntervals(alpha, {
      from: interval.startsAt,
      to: interval.endsAt,
    });
    expect(busyAfter).toHaveLength(1);
  });

  it('un chevauchement PARTIEL est refusé, un créneau adjacent ne l’est pas', async () => {
    const a = await prospect();
    const b = await prospect();
    const c = await prospect();

    await reserveAppointment(alpha, reserveInput(a, slot('2026-09-03T10:00:00.000Z'), randomUUID()));

    await expect(
      reserveAppointment(beta, reserveInput(b, slot('2026-09-03T10:15:00.000Z'), randomUUID())),
    ).rejects.toMatchObject({ code: 'SLOT_TAKEN' });

    // 10 h 30 – 11 h 00 touche 10 h 00 – 10 h 30 sans le chevaucher : `[)`.
    const adjacent = await reserveAppointment(
      beta,
      reserveInput(c, slot('2026-09-03T10:30:00.000Z'), randomUUID()),
    );
    expect(adjacent.created).toBe(true);
  });

  it('§13 — le même message rejoué ne crée pas un second rendez-vous', async () => {
    const p = await prospect();
    const interval = slot('2026-09-04T09:00:00.000Z');
    const key = `replay-${randomUUID()}`;

    const first = await reserveAppointment(alpha, reserveInput(p, interval, key));
    const second = await reserveAppointment(alpha, reserveInput(p, interval, key));

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.appointment.id).toBe(first.appointment.id);
    expect(await listAppointments(alpha, p)).toHaveLength(1);
  });

  it('§13 — deux processus rejouant le MÊME tour n’en créent qu’un', async () => {
    const p = await prospect();
    const interval = slot('2026-09-04T14:00:00.000Z');
    const key = `replay-race-${randomUUID()}`;

    const results = await Promise.all([
      reserveAppointment(alpha, reserveInput(p, interval, key)),
      reserveAppointment(beta, reserveInput(p, interval, key)),
    ]);

    expect(results[0].appointment.id).toBe(results[1].appointment.id);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await listAppointments(alpha, p)).toHaveLength(1);
  });

  it('§14 — un prospect ne peut pas porter DEUX rendez-vous vivants', async () => {
    const p = await prospect();
    await reserveAppointment(alpha, reserveInput(p, slot('2026-09-05T08:00:00.000Z'), randomUUID()));

    await expect(
      reserveAppointment(alpha, reserveInput(p, slot('2026-09-05T15:00:00.000Z'), randomUUID())),
    ).rejects.toMatchObject({ code: 'PROSPECT_ALREADY_BOOKED' });
  });

  it('§14 — le report déplace, et ne laisse qu’un seul vivant', async () => {
    const p = await prospect();
    const first = await reserveAppointment(
      alpha,
      reserveInput(p, slot('2026-09-06T13:00:00.000Z'), randomUUID()),
    );

    const moved = await rescheduleAppointment(alpha, {
      ...reserveInput(p, slot('2026-09-06T16:00:00.000Z'), randomUUID()),
      previousAppointmentId: first.appointment.id,
      at: at('2026-09-01T10:00:00.000Z'),
      reason: 'le prospect a demandé 18h',
    });

    expect(moved.created).toBe(true);
    expect(moved.appointment.supersedesId).toBe(first.appointment.id);

    const live = await loadLiveAppointment(alpha, p);
    expect(live?.id).toBe(moved.appointment.id);
    expect(live?.startsAt).toBe('2026-09-06T16:00:00.000Z');

    const history = await listAppointments(alpha, p);
    expect(history).toHaveLength(2);
    expect(history.filter((entry) => entry.status === 'CONFIRMED')).toHaveLength(1);

    // L'ancien créneau est REDEVENU libre.
    const busy = await loadBusyIntervals(alpha, {
      from: at('2026-09-06T13:00:00.000Z'),
      to: at('2026-09-06T13:30:00.000Z'),
    });
    expect(busy).toHaveLength(0);
  });

  it('§14 — un report vers un créneau OCCUPÉ échoue et laisse l’ancien intact', async () => {
    const p = await prospect();
    const other = await prospect();
    const mine = await reserveAppointment(
      alpha,
      reserveInput(p, slot('2026-09-07T09:00:00.000Z'), randomUUID()),
    );
    await reserveAppointment(beta, reserveInput(other, slot('2026-09-07T11:00:00.000Z'), randomUUID()));

    await expect(
      rescheduleAppointment(alpha, {
        ...reserveInput(p, slot('2026-09-07T11:00:00.000Z'), randomUUID()),
        previousAppointmentId: mine.appointment.id,
        at: at('2026-09-01T10:00:00.000Z'),
        reason: 'tentative vers un créneau pris',
      }),
    ).rejects.toMatchObject({ code: 'SLOT_TAKEN' });

    const live = await loadLiveAppointment(alpha, p);
    expect(live?.id).toBe(mine.appointment.id);
    expect(live?.status).toBe('CONFIRMED');
  });

  it('§15 — annuler rend le créneau disponible', async () => {
    const p = await prospect();
    const other = await prospect();
    const interval = slot('2026-09-08T12:00:00.000Z');
    const booked = await reserveAppointment(alpha, reserveInput(p, interval, randomUUID()));

    const cancelled = await cancelAppointment(alpha, {
      appointmentId: booked.appointment.id,
      at: at('2026-09-01T10:00:00.000Z'),
      reason: 'le prospect a annulé',
    });
    expect(cancelled.status).toBe('CANCELLED');
    expect(await loadLiveAppointment(alpha, p)).toBeNull();

    // Quelqu'un d'autre peut désormais le prendre.
    const reused = await reserveAppointment(beta, reserveInput(other, interval, randomUUID()));
    expect(reused.created).toBe(true);
  });

  it('§12 — l’échec du DM ne détruit pas le rendez-vous', async () => {
    const p = await prospect();
    const booked = await reserveAppointment(
      alpha,
      reserveInput(p, slot('2026-09-09T07:00:00.000Z'), randomUUID()),
    );
    expect(booked.appointment.confirmationState).toBe('PENDING');

    const after = await recordConfirmationOutcome(alpha, {
      appointmentId: booked.appointment.id,
      state: 'DELIVERY_UNCONFIRMED',
      at: at('2026-09-01T10:00:00.000Z'),
    });

    expect(after?.confirmationState).toBe('DELIVERY_UNCONFIRMED');
    expect(after?.status).toBe('CONFIRMED');
    expect((await loadLiveAppointment(alpha, p))?.id).toBe(booked.appointment.id);
  });

  it('§11 — une proposition ne bloque AUCUN créneau', async () => {
    const a = await prospect();
    const b = await prospect();
    const interval = slot('2026-09-10T13:00:00.000Z');

    await recordProposal(alpha, {
      prospectId: a,
      conversationKey: `instagram_dm:${a}`,
      triggerInboundMessageId: null,
      calendarKey: 'hermes-operator',
      timezone: TZ,
      slots: [interval],
    });

    // Le créneau proposé à A reste libre, et B peut le prendre.
    const busy = await loadBusyIntervals(alpha, { from: interval.startsAt, to: interval.endsAt });
    expect(busy).toHaveLength(0);

    const taken = await reserveAppointment(beta, reserveInput(b, interval, randomUUID()));
    expect(taken.created).toBe(true);

    const latest = await loadLatestProposal(alpha, a);
    expect(latest?.slots).toHaveLength(1);
    expect(latest?.slots[0]?.startsAt.toISOString()).toBe(interval.startsAt.toISOString());
  });
});
