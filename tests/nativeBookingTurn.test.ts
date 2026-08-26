/**
 * HERMES-NATIVE-BOOKING-R1 §12/§18/§20 — le tour COMPLET, avec l'agenda dedans.
 *
 * Ce fichier éprouve trois choses qu'aucun autre ne mesure :
 *
 *   1. le COÛT — l'agenda n'ajoute AUCUN appel de modèle sur le chemin
 *      nominal, et au plus un sur le chemin de réparation (§20) ;
 *   2. l'ORDRE — la réservation est écrite AVANT que le texte ne soit jugé, et
 *      un texte qui confirme un créneau perdu ne survit pas (§12) ;
 *   3. le PROMPT — un tour sans agenda reçoit exactement le prompt d'avant ce
 *      round, ce qui est l'affirmation que `promptVersion.ts` porte.
 *
 * Le modèle est un faux provider injecté dans le VRAI `ModelRouter`. Rien ici
 * ne peut envoyer : ni `turn.ts` ni `runtime.ts` n'importent de provider
 * d'envoi.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { intervalFor } from '@/lib/booking/availability';
import { reserveAppointment, listAppointments, loadLiveAppointment } from '@/lib/booking/store';
import { formatSlot } from '@/lib/booking/statement';
import { composeConversationPrompt, understandConversation } from '@/lib/conversation/brain';
import { runConversationTurn } from '@/lib/conversation/turn';
import { loadBookingPolicy } from '@/lib/config/load';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { createLogger } from '@/lib/logging/logger';
import { ModelRouter } from '@/lib/models/router';
import type { LlmProvider } from '@/lib/models/types';
import { loadReplyContext } from '@/lib/replies/context';
import { loadConversationThread } from '@/lib/conversation/thread';
import { makeReplyFixtures, type ReplyFixtures } from './support/replyFixture';
import { turnAnswer } from './support/turnAnswer';
import type { Sql } from '@/lib/db/sql';

const logger = createLogger({ test: 'native-booking-turn' });
const MAILBOX = 'reponse@exemple-test.fr';
const FIRST_TOUCH = 'Bonjour, comment vos clients vous trouvent aujourd’hui ?';

let sql: Sql;
let dir: string;
let campaignId: string;
let fixtures: ReplyFixtures;
let calls: { prompt: string; hasCategory: boolean }[] = [];

interface Script {
  readonly bookingIntent?: string;
  readonly reply?: string;
  readonly repair?: string;
  readonly category?: string;
}

function makeRouter(script: Script): ModelRouter {
  const provider: LlmProvider = {
    name: 'codex',
    availability: () => ({ ok: true }),
    generate: async (request) => {
      const properties = (request.schema as { properties?: Record<string, unknown> } | undefined)
        ?.properties;
      const hasCategory = properties !== undefined && 'category' in properties;
      calls.push({ prompt: request.prompt, hasCategory });
      if (!hasCategory) {
        return {
          text: JSON.stringify({
            reply: script.repair ?? script.reply ?? 'Compris.',
            reply_rationale: 'réécriture de test',
            used_facts: [],
          }),
        };
      }
      return {
        text: JSON.stringify(
          turnAnswer(
            {
              category: script.category ?? 'INTERESTED',
              confidence: 0.95,
              reasoning_summary: 'lecture de test',
              evidence_excerpts: [],
            },
            { body: script.reply ?? 'Compris.', rationale: 'test', used_facts: [] },
            { booking_intent: script.bookingIntent ?? 'NONE' },
          ),
        ),
      };
    },
  };
  return new ModelRouter({ sql, logger, providers: { codex: provider } });
}

let seq = 0;
async function scene(body: string): Promise<{ inboundId: string; prospectId: string }> {
  seq += 1;
  const prospect = await fixtures.contactedProspect(`booking-turn-${String(seq)}@exemple-test.fr`);
  const inboundId = await fixtures.inbound({
    manifest: prospect.manifest,
    outreachEventId: prospect.outreachEventId,
    prospectId: prospect.prospectId,
    body,
  });
  return { inboundId, prospectId: prospect.prospectId };
}

async function runTurn(inboundId: string, script: Script) {
  const context = await loadReplyContext(sql, inboundId);
  if (context === null) throw new Error('contexte introuvable');
  const thread = await loadConversationThread(sql, context);
  return runConversationTurn(sql, makeRouter(script), context, thread);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-booking-turn-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);
  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
    ['atelier-booking-turn', 'Test', 'atelier', '{}'],
  );
  campaignId = rows[0]!.id;
  fixtures = makeReplyFixtures(sql, { campaignId, mailbox: MAILBOX, firstTouch: FIRST_TOUCH });
}, 180_000);

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  calls = [];
});

describe('§20 — l’agenda ne coûte aucun appel de modèle de plus', () => {
  it('un tour ordinaire coûte UN appel, et ne touche à aucun agenda', async () => {
    const { inboundId, prospectId } = await scene('Surtout par le bouche à oreille');
    const result = await runTurn(inboundId, {
      category: 'INFORMATION_SHARED',
      reply: 'Ok. Et ça t’amène combien de demandes ?',
    });

    expect(calls).toHaveLength(1);
    expect(result.llmCalls).toBe(1);
    expect(result.booking?.kind).toBe('NO_BOOKING');
    expect(await listAppointments(sql, prospectId)).toHaveLength(0);
  });

  it('RÉSERVER ne coûte pas un appel de plus que ne pas réserver', async () => {
    // La comparaison est la seule mesure honnête de §20. Le nombre ABSOLU
    // d'appels d'un tour dépend de la naturalité du texte — une confirmation
    // sèche déclenche la réécriture que ce dépôt fait depuis
    // HERMES-SEMANTIC-GROUNDING-R1, agenda ou pas. Ce qu'on doit prouver n'est
    // donc pas « un appel », c'est « pas un de plus À CAUSE de l'agenda ».
    //
    // Même texte, même lecture, même prospect-type : seule l'intention
    // d'agenda change.
    const confirmation = 'Parfait, c’est calé pour mardi à 14h.';

    const withoutBooking = await scene('On dit mardi à 14h ?');
    const idle = await runTurn(withoutBooking.inboundId, {
      bookingIntent: 'NONE',
      reply: confirmation,
    });
    const idleCalls = calls.length;
    expect(idle.booking?.kind).toBe('NO_BOOKING');
    expect(await loadLiveAppointment(sql, withoutBooking.prospectId)).toBeNull();

    calls = [];
    const withBooking = await scene('On dit mardi à 14h ?');
    const booking = await runTurn(withBooking.inboundId, {
      bookingIntent: 'PROPOSE_TIME',
      reply: confirmation,
    });

    expect(booking.booking?.kind).toBe('BOOKED');
    expect(await loadLiveAppointment(sql, withBooking.prospectId)).not.toBeNull();
    expect(calls.length).toBe(idleCalls);
    expect(booking.llmCalls).toBe(idle.llmCalls);
    // Et aucun de ces appels n'a été provoqué par l'agenda.
    expect(
      booking.draft?.guardrailFlags.filter((flag) => flag.code.startsWith('booking_')),
    ).toEqual([]);
  });

  it('le plafond de DEUX appels par tour n’est jamais dépassé, agenda compris', async () => {
    const { inboundId } = await scene('On dit mardi à 15h ?');
    const result = await runTurn(inboundId, {
      bookingIntent: 'PROPOSE_TIME',
      reply: 'Super, à très vite !',
      repair: 'Parfait, c’est calé pour mardi à 15h.',
    });
    expect(result.llmCalls).toBeLessThanOrEqual(2);
    expect(calls.length).toBeLessThanOrEqual(2);
    expect(result.booking?.kind).toBe('BOOKED');
  });
});

describe('§12 — l’ordre : réserver, PUIS juger le texte', () => {
  it('le rendez-vous est écrit en base, et le brouillon n’est pas bloqué', async () => {
    const { inboundId, prospectId } = await scene('On dit vendredi à 10h ?');
    const result = await runTurn(inboundId, {
      bookingIntent: 'PROPOSE_TIME',
      reply: 'Nickel, c’est calé pour vendredi à 10h.',
    });

    expect(result.booking?.kind).toBe('BOOKED');
    const live = await loadLiveAppointment(sql, prospectId);
    expect(live).not.toBeNull();
    expect(result.draft?.blocked).toBe(false);
    expect(result.draft?.guardrailFlags.filter((flag) => flag.code.startsWith('booking_'))).toEqual(
      [],
    );
  });

  it('un texte qui CONFIRME un créneau que la base a refusé est corrigé ou bloqué', async () => {
    const { inboundId, prospectId } = await scene('On dit lundi à 9h ?');

    // Quelqu'un d'autre tient déjà ce créneau : la réservation va échouer.
    const policy = loadBookingPolicy();
    const other = await fixtures.contactedProspect(`booking-taken-${String(seq)}@exemple-test.fr`);
    const context = await loadReplyContext(sql, inboundId);
    const { readTemporal, instantOf } = await import('@/lib/booking/temporal');
    const reading = readTemporal('lundi à 9h', new Date(context!.reply.receivedAt), policy.timezone);
    if (reading.date.kind !== 'RESOLVED' || reading.time.kind !== 'RESOLVED') {
      throw new Error('la lecture de test doit résoudre');
    }
    const startsAt = instantOf(reading.date.date, reading.time.minuteOfDay, policy.timezone);
    if (startsAt === null) throw new Error('créneau inexistant');
    await reserveAppointment(sql, {
      prospectId: other.prospectId,
      calendarKey: policy.calendarKey,
      conversationKey: `instagram_dm:${other.prospectId}`,
      interval: intervalFor(startsAt, policy),
      timezone: policy.timezone,
      source: 'instagram_hermes',
      triggerInboundMessageId: null,
      idempotencyKey: `taken-${String(seq)}`,
      createdBy: 'test',
    });

    const result = await runTurn(inboundId, {
      bookingIntent: 'PROPOSE_TIME',
      reply: 'Parfait, c’est réservé pour lundi à 9h.',
      // La réécriture, elle, dit la vérité.
      repair: 'Ah, ce créneau vient d’être pris. Je te propose autre chose ?',
    });

    // Rien n'a été réservé pour CE prospect.
    expect(result.booking?.kind).toBe('SLOT_UNAVAILABLE');
    expect(await loadLiveAppointment(sql, prospectId)).toBeNull();

    // Et le texte qui affirmait le contraire n'est jamais retenu tel quel.
    expect(result.draft?.body).not.toContain('c’est réservé');
    // Une réécriture a bien été demandée, avec le constat sous les yeux.
    expect(calls.length).toBe(2);
    expect(calls[1]!.prompt).toContain('CE QUE TON TEXTE AFFIRME À TORT SUR LE RENDEZ-VOUS');
  });

  it('la réécriture reçoit le créneau RÉSERVÉ quand le texte ne le nommait pas', async () => {
    const { inboundId } = await scene('On peut se caler mardi à 11h ?');
    const result = await runTurn(inboundId, {
      bookingIntent: 'PROPOSE_TIME',
      // Ne nomme aucun créneau : le rendez-vous serait pris sans que la
      // personne le sache.
      reply: 'Super, à très vite alors !',
      repair: 'Parfait, c’est calé pour mardi à 11h.',
    });

    expect(result.booking?.kind).toBe('BOOKED');
    expect(calls.length).toBe(2);
    expect(calls[1]!.prompt).toContain('LE RENDEZ-VOUS EST RÉSERVÉ');
    expect(result.draft?.body).toContain('11h');
  });
});

describe('§19/§6 — le PROMPT', () => {
  it('un tour sans agenda ne porte AUCUN bloc de créneaux', async () => {
    const { inboundId } = await scene('Ah ok je vois');
    const context = await loadReplyContext(sql, inboundId);
    const understanding = await understandConversation(sql, context!, {
      classification: 'INFORMATION_SHARED',
      confidence: 0.9,
    });
    const composed = composeConversationPrompt(understanding);

    expect(understanding.mayProposeBooking).toBe(false);
    expect(composed.prompt).not.toContain('CRÉNEAUX RÉELLEMENT LIBRES');
    // Et l'objectif dit toujours ce qu'il disait avant ce round.
    expect(composed.prompt).toContain('Aucun lien de réservation n’existe');
  });

  it('un tour avec un rendez-vous PRIS le montre, et n’offre aucun créneau', async () => {
    const { inboundId, prospectId } = await scene('Très bien');
    const policy = loadBookingPolicy();
    const context = await loadReplyContext(sql, inboundId);
    // Un instant qu'aucun autre scénario de ce fichier ne peut atteindre : la
    // contrainte d'exclusion porte sur TOUS les agendas, donc deux tests qui
    // visent la même demi-heure se refusent l'un l'autre.
    const startsAt = new Date(Date.parse(context!.reply.receivedAt) + 11 * 24 * 3_600_000 + 37 * 60_000);
    const interval = intervalFor(startsAt, policy);
    await reserveAppointment(sql, {
      prospectId,
      calendarKey: policy.calendarKey,
      conversationKey: `instagram_dm:${prospectId}`,
      interval,
      timezone: policy.timezone,
      source: 'instagram_hermes',
      triggerInboundMessageId: null,
      idempotencyKey: `prompt-live-${String(seq)}`,
      createdBy: 'test',
    });

    const understanding = await understandConversation(sql, context!, {
      classification: 'INFORMATION_SHARED',
      confidence: 0.9,
    });
    const composed = composeConversationPrompt(understanding);

    expect(composed.prompt).toContain('UN RENDEZ-VOUS EST DÉJÀ PRIS');
    expect(composed.prompt).toContain(formatSlot(interval, policy.timezone));
    expect(composed.prompt).not.toContain('CRÉNEAUX RÉELLEMENT LIBRES');
    // L'objectif ne dit plus « un humain reprend ensuite » : ce serait faux.
    expect(composed.prompt).not.toContain('Aucun lien de réservation n’existe');
    expect(composed.prompt).toContain('Tu peux fixer le rendez-vous toi-même');
  });
});
