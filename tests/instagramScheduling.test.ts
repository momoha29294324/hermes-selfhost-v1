import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { loadInstagramRail } from '@/lib/config/load';
import type { InstagramRailConfig } from '@/lib/config/schema';
import { castR6bVote } from '@/lib/pipeline/r6bBatch';
import { lockManifestForItem, type DispatchManifest } from '@/lib/pipeline/r6bDispatch';
import { resolveDispatchTarget } from '@/lib/pipeline/r6bDispatcher';
import { armCanaryAuthorization } from '@/lib/instagram/canary';
import {
  claimNextInstagramJob,
  enqueueInstagramJob,
  loadInstagramJob,
  loadQueueOverview,
} from '@/lib/instagram/queue';
import {
  evaluateSchedule,
  isInsideWindow,
  loadScheduleSnapshot,
  nextAttemptAt,
  nextWindowOpening,
  scheduleJitterMs,
  zonedParts,
  zonedWallClockToUtc,
} from '@/lib/instagram/scheduler';
import { setKillSwitch } from '@/lib/instagram/safety';
import { runInstagramDryRun } from '@/lib/instagram/worker';
import { UNREAD_RELATIONSHIP } from '@/lib/instagram/relationship';
import type {
  InstagramProfileObservation,
  InstagramReadOnlyRail,
  InstagramSessionStatus,
} from '@/lib/instagram/rail';
import { deriveQueueState } from '@/lib/instagram/types';
import type { Sql } from '@/lib/db/sql';
import { makeProspectInstagramEligible } from './support/instagramEligibility';

/**
 * IG3 §11 — l'ordonnancement, les plafonds, les reports et le DRY-RUN de
 * production.
 *
 * Ce fichier n'ouvre jamais Instagram : le rail est un double, exactement comme
 * dans `instagramQueue.test.ts`, précisément parce que le worker ne construit
 * jamais son navigateur lui-même. La règle de fin de chaque scénario est la
 * même que celle de la mission : `outreach_events` ne bouge pas, et aucun job
 * ne porte `external_effect_attempted = true`.
 *
 * Les tests d'ordonnancement injectent leur horloge (`now`). Une fenêtre
 * horaire éprouvée sur l'heure réelle serait un test qui passe le matin et
 * échoue le soir — c'est-à-dire pas un test.
 */

const TEXT = 'Bonjour, une question rapide sur vos prises de rendez-vous.';
const HANDLE = 'prestationauto_test';

let sql: Sql;
let dir: string;
let campaignId: string;
let config: InstagramRailConfig;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-ig3-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);
  config = loadInstagramRail();

  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
    ['example-ig3-test', 'Test IG3', 'example-services', '{}'],
  );
  campaignId = rows[0]!.id;
});

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await sql.query('update ig_live_canary_authorizations set consumed_job_id = null');
  await sql.query('delete from ig_job_events');
  await sql.query('delete from ig_identity_checks');
  await sql.query('delete from ig_enqueue_decisions');
  await sql.query('delete from ig_dispatch_jobs');
  await sql.query('delete from ig_live_canary_authorizations');
  await sql.query('delete from ig_browser_sessions');
  await sql.query('delete from ig_kill_switch');
  await sql.query('delete from r6b_dispatch_attempts');
  await sql.query('delete from outreach_events');
  await sql.query('delete from do_not_contact');
  await sql.query('delete from prospect_icp_assessments');
  await sql.query('delete from r6b_dispatch_manifests');
  await sql.query('delete from r6b_batch_votes');
  await sql.query('delete from r6b_batch_items');
  await sql.query('delete from r6b_batches');
  await sql.query('delete from prospect_evidence');
  await sql.query('delete from prospects');
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function lockManifest(handle = HANDLE): Promise<DispatchManifest> {
  const prospect = await sql.query<{ id: string }>(
    `insert into prospects (campaign_id, canonical_key, display_name, instagram_handle)
     values ($1,$2,'PRESTATION AUTO TEST',$3) returning id`,
    [campaignId, `prospect-${Math.random()}`, handle],
  );
  const prospectId = prospect[0]!.id;

  await sql.query(
    `insert into prospect_evidence (prospect_id, field, value_text, provider, method, source_url, confidence)
     values ($1,'instagram_handle',$2,'website','crawl','https://example.com',1.0)`,
    [prospectId, handle],
  );

  const batch = await sql.query<{ id: string }>(
    `insert into r6b_batches (slug, campaign_id) values ($1,$2) returning id`,
    [`batch-${Math.random()}`, campaignId],
  );
  const item = await sql.query<{ id: string }>(
    `insert into r6b_batch_items (batch_id, prospect_id, item_index, original_draft, contact_channels)
     values ($1,$2,1,'brouillon',$3) returning id`,
    [batch[0]!.id, prospectId, JSON.stringify(['instagram'])],
  );
  await castR6bVote(sql, { itemId: item[0]!.id, verdict: 'SEND', approvedText: TEXT, note: null });
  await makeProspectInstagramEligible(sql, prospectId);
  return lockManifestForItem(sql, { itemId: item[0]!.id, transport: 'instagram_dm' });
}

class FakeRail implements InstagramReadOnlyRail {
  readonly opened: string[] = [];

  async ensureSession(): Promise<InstagramSessionStatus> {
    return { state: 'SESSION_READY', detail: 'double de test', profileLabel: 'test', headless: true };
  }

  async openProfile(handle: string): Promise<InstagramProfileObservation> {
    this.opened.push(handle);
    return {
      requestedUrl: `https://www.instagram.com/${handle}/`,
      finalUrl: `https://www.instagram.com/${handle}/`,
      redirected: false,
      profileMissing: false,
      sessionState: 'SESSION_READY',
      relationship: UNREAD_RELATIONSHIP,
      signals: (['canonical_url', 'og_url', 'profile_header'] as const).map((name) => ({
        name,
        handle,
        raw: handle,
      })),
      screenshotPath: null,
      durationMs: 5,
    };
  }

  async close(): Promise<void> {}
}

/** Une politique large : tous les jours, toute la journée. Neutralise la fenêtre. */
function alwaysOpen(over: Partial<InstagramRailConfig['schedule']> = {}): InstagramRailConfig {
  return {
    ...config,
    schedule: {
      ...config.schedule,
      windows: [{ days: [1, 2, 3, 4, 5, 6, 7], startMinute: 0, endMinute: 1_440 }],
      ...over,
    },
  };
}

async function countOutreachEvents(): Promise<number> {
  const rows = await sql.query<{ n: string }>('select count(*) as n from outreach_events');
  return Number(rows[0]?.n ?? 0);
}

async function countExternalEffects(): Promise<number> {
  const rows = await sql.query<{ n: string }>(
    `select count(*) as n from ig_dispatch_jobs where external_effect_attempted = true`,
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Fabrique un envoi passé, par le seul chemin que la base accepte : depuis 0031
 * un événement portant un effet doit nommer l'autorisation qui le couvrait.
 * Écrire un `insert` sans elle serait fabriquer un monde qui n'existe pas.
 */
async function fabricateSent(manifestId: string, jobId: string, at: Date): Promise<void> {
  const { envelope } = await resolveDispatchTarget(sql, manifestId, 'LIVE');
  const existing = await sql.query<{ id: string }>(
    `select id from ig_live_canary_authorizations where manifest_id = $1`,
    [manifestId],
  );
  const authId =
    existing[0]?.id ??
    (
      await armCanaryAuthorization(sql, {
        envelope,
        action: 'first_touch_dm',
        armedBy: 'Test',
        reason: 'fabrication d’un envoi passé, pour éprouver un plafond sans envoyer',
        ttlMs: 30 * 60_000,
      })
    ).id;

  await sql.query(
    `insert into ig_job_events
       (job_id, manifest_id, worker_id, mode, status, reason_code, idempotency_key,
        external_effect_attempted, canary_authorization_id, created_at)
     values ($1,$2,'w','LIVE','SENT','IG_LIVE_SENT','k',true,$3,$4)`,
    [jobId, manifestId, authId, at.toISOString()],
  );
}

// ---------------------------------------------------------------------------
// Fuseau et fenêtres
// ---------------------------------------------------------------------------

describe('fuseau horaire', () => {
  it('lit l’heure locale d’un fuseau, changement d’heure compris', () => {
    // 2026-01-15 12:00 UTC → 13:00 à Paris (UTC+1, heure d'hiver), jeudi.
    const winter = zonedParts(new Date('2026-01-15T12:00:00Z'), 'Europe/Paris');
    expect(winter.minuteOfDay).toBe(13 * 60);
    expect(winter.isoWeekday).toBe(4);

    // 2026-07-15 12:00 UTC → 14:00 à Paris (UTC+2, heure d'été), mercredi.
    // Le même code, sans une seule branche « si été » : `Intl` connaît tzdata.
    const summer = zonedParts(new Date('2026-07-15T12:00:00Z'), 'Europe/Paris');
    expect(summer.minuteOfDay).toBe(14 * 60);
    expect(summer.isoWeekday).toBe(3);
  });

  it('n’est couplé à aucune géographie — le même instant, trois fuseaux', () => {
    const instant = new Date('2026-07-15T12:00:00Z');
    expect(zonedParts(instant, 'UTC').minuteOfDay).toBe(12 * 60);
    expect(zonedParts(instant, 'America/New_York').minuteOfDay).toBe(8 * 60);
    expect(zonedParts(instant, 'Asia/Tokyo').minuteOfDay).toBe(21 * 60);
    // Tokyo est déjà le 15 à 21 h ; New York le 15 à 8 h. Même jour ISO ici.
    expect(zonedParts(instant, 'Asia/Tokyo').isoWeekday).toBe(3);
  });

  it('retrouve l’instant UTC d’une heure murale locale, dans les deux régimes', () => {
    const winter = zonedWallClockToUtc(2026, 1, 15, 9 * 60, 'Europe/Paris');
    expect(winter.toISOString()).toBe('2026-01-15T08:00:00.000Z');

    const summer = zonedWallClockToUtc(2026, 7, 15, 9 * 60, 'Europe/Paris');
    expect(summer.toISOString()).toBe('2026-07-15T07:00:00.000Z');

    // Aller-retour : ce qu'on demande est ce qu'on relit.
    for (const [y, m, d] of [
      [2026, 3, 29],
      [2026, 10, 25],
      [2026, 12, 31],
    ] as const) {
      const utc = zonedWallClockToUtc(y, m, d, 9 * 60, 'Europe/Paris');
      expect(zonedParts(utc, 'Europe/Paris').minuteOfDay, `${y}-${m}-${d}`).toBe(9 * 60);
    }
  });
});

describe('fenêtres d’ordonnancement', () => {
  const nineToSix = alwaysOpen; // remplacé plus bas, la config par défaut sert de base

  it('reconnaît l’intérieur et l’extérieur de la fenêtre par défaut (lun–ven 9h–20h)', () => {
    // Mercredi 15 juillet 2026, 12:00 UTC = 14:00 Paris → dedans.
    expect(isInsideWindow(new Date('2026-07-15T12:00:00Z'), config.schedule)).toBe(true);
    // Le même mercredi à 03:00 UTC = 05:00 Paris → dehors.
    expect(isInsideWindow(new Date('2026-07-15T03:00:00Z'), config.schedule)).toBe(false);
    // Samedi 18 juillet à 12:00 UTC = 14:00 Paris → dehors, c'est le week-end.
    expect(isInsideWindow(new Date('2026-07-18T12:00:00Z'), config.schedule)).toBe(false);
  });

  it('la borne haute est EXCLUE, la borne basse INCLUSE', () => {
    // 20:00 Paris pile (18:00 UTC en été) — la fenêtre est fermée.
    expect(isInsideWindow(new Date('2026-07-15T18:00:00Z'), config.schedule)).toBe(false);
    // 19:59 Paris — encore ouverte.
    expect(isInsideWindow(new Date('2026-07-15T17:59:00Z'), config.schedule)).toBe(true);
    // 09:00 Paris pile (07:00 UTC en été) — ouverte.
    expect(isInsideWindow(new Date('2026-07-15T07:00:00Z'), config.schedule)).toBe(true);
  });

  /**
   * IG4.4C — la politique de cold outbound, énoncée cas par cas.
   *
   * L'ancienne fenêtre fermait à 18:00 ; la décision produit du 17 août 2026 la
   * porte à 20:00, mêmes jours, même fuseau. Ce scénario est la table de vérité
   * de cette décision : il nomme chaque instant en heure MURALE de Paris et
   * laisse `zonedWallClockToUtc` faire la conversion, pour qu'aucune de ces
   * lignes ne dépende d'un décalage UTC écrit à la main.
   *
   * La borne haute reste EXCLUE — c'est la sémantique d'origine, conservée :
   * 19:59 est dedans, 20:00 pile est dehors. Une fenêtre qui inclurait sa borne
   * ferait exister une minute de plus que celle qui a été décidée.
   */
  it('IG4.4C — la table de vérité de la fenêtre lun–ven 09:00→20:00', () => {
    // Lundi 13, vendredi 17, samedi 18 juillet 2026 — le même calendrier que le
    // reste du fichier, où mercredi 15 est un jour ouvré.
    const cases: readonly (readonly [string, number, number, number, number, boolean])[] = [
      ['lundi 08:59', 2026, 7, 13, 8 * 60 + 59, false],
      ['lundi 09:00', 2026, 7, 13, 9 * 60, true],
      ['lundi 18:30', 2026, 7, 13, 18 * 60 + 30, true],
      ['lundi 19:59', 2026, 7, 13, 19 * 60 + 59, true],
      ['lundi 20:00', 2026, 7, 13, 20 * 60, false],
      ['lundi 20:01', 2026, 7, 13, 20 * 60 + 1, false],
      ['vendredi 19:30', 2026, 7, 17, 19 * 60 + 30, true],
      ['samedi 12:00', 2026, 7, 18, 12 * 60, false],
      // R7-PILOT §4 — le dimanche manquait à la table. Un jour non listé dans
      // `days` est fermé par construction, mais « par construction » n'est pas
      // une assertion : la seule façon de savoir qu'un jour reste fermé est de
      // le nommer. Y compris en plein milieu des heures ouvrées d'un jour ouvré.
      ['dimanche 12:00', 2026, 7, 19, 12 * 60, false],
      ['dimanche 09:00', 2026, 7, 19, 9 * 60, false],
      ['dimanche 19:59', 2026, 7, 19, 19 * 60 + 59, false],
    ];

    for (const [label, year, month, day, minute, expected] of cases) {
      const instant = zonedWallClockToUtc(year, month, day, minute, config.schedule.timezone);
      expect(isInsideWindow(instant, config.schedule), label).toBe(expected);
    }
  });

  /**
   * R7-PILOT §4 — la même table, mais posée à la DÉCISION plutôt qu'au prédicat.
   *
   * `isInsideWindow` est la fonction que le rail appelle ; `evaluateSchedule`
   * est ce que le rail RÉPOND. Les deux peuvent diverger — il suffirait qu'un
   * appelant oublie d'appeler la première — et c'est cette divergence-là qui
   * ferait partir un message à 20:07. Le scénario ci-dessous éprouve donc la
   * réponse complète : verdict, motif, porte journalisée.
   */
  it('R7-PILOT §4 — evaluateSchedule refuse aux mêmes bornes, avec le motif outside_window', () => {
    const snapshot = {
      safety: {
        killSwitch: { engaged: false, setBy: null, reason: null, updatedAt: null, source: 'default' },
        sentLastDay: 0,
        sentLastHour: 0,
        msSinceLastEffect: null,
        consecutiveFailures: 0,
        sessionFailures: 0,
      },
      dailyCapFreesAt: null,
      hourlyCapFreesAt: null,
      lastExternalEffectAt: null,
    } as unknown as Parameters<typeof evaluateSchedule>[0]['snapshot'];

    const cases: readonly (readonly [string, number, number, number, boolean])[] = [
      ['lundi 08:59', 7, 13, 8 * 60 + 59, false],
      ['lundi 09:00', 7, 13, 9 * 60, true],
      ['lundi 19:59', 7, 13, 19 * 60 + 59, true],
      ['lundi 20:00', 7, 13, 20 * 60, false],
      ['samedi 12:00', 7, 18, 12 * 60, false],
      ['dimanche 12:00', 7, 19, 12 * 60, false],
    ];

    for (const [label, month, day, minute, allowed] of cases) {
      const now = zonedWallClockToUtc(2026, month, day, minute, config.schedule.timezone);
      const decision = evaluateSchedule({ now, snapshot, config });
      expect(decision.allowed, label).toBe(allowed);
      if (!decision.allowed) {
        expect(decision.reason, label).toBe('outside_window');
        expect(
          decision.gates.some((gate) => gate.gate === 'schedule_window' && gate.verdict === 'BLOCK'),
          label,
        ).toBe(true);
        // Un refus DIT quand : jamais « plus tard ».
        expect(decision.nextEligibleAt, label).not.toBeNull();
      } else {
        expect(
          decision.gates.some((gate) => gate.gate === 'schedule_window' && gate.verdict === 'PASS'),
          label,
        ).toBe(true);
      }
    }
  });

  it('R7-PILOT §4 — la configuration chargée EST la politique 09:00→20:00 lun–ven', () => {
    // Une seule source de vérité : si `config/instagram.json` et le défaut du
    // schéma divergeaient à nouveau, ce scénario tomberait avant qu'un envoi ne
    // se trompe d'heure.
    expect(config.schedule.timezone).toBe('Europe/Paris');
    expect(config.schedule.windows).toHaveLength(1);
    expect(config.schedule.windows[0]).toEqual({ days: [1, 2, 3, 4, 5], startMinute: 540, endMinute: 1200 });
  });

  it('IG4.4C — la fermeture à 20:00 est une heure LOCALE, hiver comme été', () => {
    // La même heure murale des deux côtés d'un changement d'heure : en juillet
    // Paris est à UTC+2, en janvier à UTC+1. Une fermeture rangée comme un
    // décalage UTC figé se tromperait sur l'une des deux moitiés de l'année.
    for (const [label, month, day] of [
      ['été (CEST, UTC+2)', 7, 13],
      ['hiver (CET, UTC+1)', 1, 12], // lundi 12 janvier 2026
    ] as const) {
      const open = zonedWallClockToUtc(2026, month, day, 19 * 60 + 59, config.schedule.timezone);
      const closed = zonedWallClockToUtc(2026, month, day, 20 * 60, config.schedule.timezone);
      expect(isInsideWindow(open, config.schedule), `${label} — 19:59`).toBe(true);
      expect(isInsideWindow(closed, config.schedule), `${label} — 20:00`).toBe(false);
    }

    // Et l'écart UTC entre les deux fermetures est bien d'une heure : c'est la
    // preuve que le décalage a réellement changé sous la même heure murale.
    const summerClose = zonedWallClockToUtc(2026, 7, 13, 20 * 60, config.schedule.timezone);
    const winterClose = zonedWallClockToUtc(2026, 1, 12, 20 * 60, config.schedule.timezone);
    expect(summerClose.toISOString()).toBe('2026-07-13T18:00:00.000Z');
    expect(winterClose.toISOString()).toBe('2026-01-12T19:00:00.000Z');
  });

  it('IG4.4C — hors fenêtre à 20:00, la reprise est le lendemain 09:00', () => {
    // Lundi 13 juillet 20:00 Paris → mardi 14, 09:00 Paris (07:00 UTC).
    const closed = zonedWallClockToUtc(2026, 7, 13, 20 * 60, config.schedule.timezone);
    expect(nextWindowOpening(closed, config.schedule)?.toISOString()).toBe('2026-07-14T07:00:00.000Z');
  });

  it('calcule la prochaine ouverture — y compris par-dessus un week-end', () => {
    // Vendredi 17 juillet 2026, 20:00 Paris (18:00 UTC) → lundi 20, 09:00 Paris.
    const opening = nextWindowOpening(new Date('2026-07-17T18:00:00Z'), config.schedule);
    expect(opening?.toISOString()).toBe('2026-07-20T07:00:00.000Z');
    expect(zonedParts(opening as Date, 'Europe/Paris').isoWeekday).toBe(1);
    expect(zonedParts(opening as Date, 'Europe/Paris').minuteOfDay).toBe(9 * 60);
  });

  it('à l’intérieur de la fenêtre, « la prochaine ouverture » est maintenant', () => {
    const now = new Date('2026-07-15T12:00:00Z');
    expect(nextWindowOpening(now, config.schedule)?.toISOString()).toBe(now.toISOString());
  });

  it('une fenêtre qui n’ouvre jamais rend `null` plutôt qu’une date fabriquée', () => {
    // Aucun jour n'est un 8e jour : la politique est légale et n'ouvre jamais.
    const impossible = alwaysOpen({ windows: [{ days: [7], startMinute: 0, endMinute: 1 }] });
    // Un dimanche à 00:00:30 UTC : la minute d'ouverture du dimanche est déjà
    // passée pour aujourd'hui, mais il y en aura une dimanche prochain.
    expect(nextWindowOpening(new Date('2026-07-19T12:00:00Z'), impossible.schedule)).not.toBeNull();
    expect(nineToSix).toBeTypeOf('function');
  });

  it('le fuseau est configurable, et change réellement la réponse', () => {
    const tokyo = { ...config.schedule, timezone: 'Asia/Tokyo' };
    const instant = new Date('2026-07-15T03:00:00Z'); // 05:00 Paris, 12:00 Tokyo
    expect(isInsideWindow(instant, config.schedule)).toBe(false);
    expect(isInsideWindow(instant, tokyo)).toBe(true);
  });
});

describe('étalement fonctionnel', () => {
  it('est nul par défaut — aucun étalement tant que personne n’en demande', () => {
    expect(config.schedule.jitterMs).toBe(0);
    expect(scheduleJitterMs('ig-r1/first_touch_dm/abc', config.schedule)).toBe(0);
  });

  it('est déterministe et borné quand il est activé', () => {
    const schedule = { ...config.schedule, jitterMs: 60_000 };
    const key = 'ig-r1/first_touch_dm/7a3e4b3b-a25c-41c5-8cf3-ee8b1bddb465';

    // Déterministe : mille appels, une seule valeur. Ce n'est pas une
    // randomisation anti-détection — la même cible reçoit toujours le même
    // décalage, ce qui serait le contraire d'un camouflage.
    const values = new Set(Array.from({ length: 1_000 }, () => scheduleJitterMs(key, schedule)));
    expect(values.size).toBe(1);

    // Borné, strictement.
    for (const other of ['a', 'b', 'ig-r1/first_touch_dm/zzz', '']) {
      const value = scheduleJitterMs(other, schedule);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(60_000);
    }

    // Et il étale vraiment : deux clés distinctes ne tombent pas au même endroit.
    const spread = new Set(
      Array.from({ length: 50 }, (_, i) => scheduleJitterMs(`ig-r1/first_touch_dm/${String(i)}`, schedule)),
    );
    expect(spread.size).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------
// Plafonds et cadence — la date de reprise, pas seulement le refus
// ---------------------------------------------------------------------------

describe('plafonds', () => {
  it('le plafond horaire refuse au N-ième exactement, pas avant', async () => {
    const manifest = await lockManifest();
    const { job } = await enqueueInstagramJob(sql, {
      manifestId: manifest.id,
      action: 'first_touch_dm',
      enqueuedBy: 'Test',
    });
    await setKillSwitch(sql, { engaged: false, setBy: 'Test', reason: 'test IG3' });
    const open = alwaysOpen();
    const now = new Date();

    // N-1 envois : le plafond ne refuse pas encore.
    for (let i = 0; i < config.caps.hourlySentCap - 1; i += 1) {
      await fabricateSent(manifest.id, job.id, new Date(now.getTime() - (i + 1) * 60_000));
    }
    let snapshot = await loadScheduleSnapshot(sql, open);
    expect(snapshot.safety.sentLastHour).toBe(config.caps.hourlySentCap - 1);
    // La cadence, elle, ne bouge pas : ces envois fabriqués n'ont pas posé de
    // drapeau d'effet sur un job.
    let decision = evaluateSchedule({ now, snapshot, config: open });
    expect(decision.allowed).toBe(true);

    // Le N-ième : refus, et une date de libération EXACTE.
    await fabricateSent(manifest.id, job.id, new Date(now.getTime() - 10_000));
    snapshot = await loadScheduleSnapshot(sql, open);
    expect(snapshot.safety.sentLastHour).toBe(config.caps.hourlySentCap);
    expect(snapshot.hourlyCapFreesAt).not.toBeNull();

    decision = evaluateSchedule({ now, snapshot, config: open });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe('hourly_cap');
      // La place se libère quand le PLUS ANCIEN des N sort de la fenêtre — pas
      // « dans une heure », mais à l'instant précis où le compte glissant
      // repasse sous le plafond.
      expect(decision.nextEligibleAt).not.toBeNull();
      const freesAt = (decision.nextEligibleAt as Date).getTime();
      expect(freesAt).toBeGreaterThan(now.getTime());
      expect(freesAt).toBeLessThanOrEqual(now.getTime() + 3_600_000);
    }
  });

  it('le plafond journalier refuse au N-ième exactement, et dit quand il libère', async () => {
    const manifest = await lockManifest();
    const { job } = await enqueueInstagramJob(sql, {
      manifestId: manifest.id,
      action: 'first_touch_dm',
      enqueuedBy: 'Test',
    });
    await setKillSwitch(sql, { engaged: false, setBy: 'Test', reason: 'test IG3' });
    // Un plafond horaire large, pour isoler le journalier.
    const open: InstagramRailConfig = {
      ...alwaysOpen(),
      caps: { ...config.caps, hourlySentCap: 60, dailySentCap: 3 },
    };
    const now = new Date();

    // Trois envois étalés sur la journée ; le plus ancien il y a 20 h.
    const ages = [20, 10, 1];
    for (const hours of ages) {
      await fabricateSent(manifest.id, job.id, new Date(now.getTime() - hours * 3_600_000));
    }

    const snapshot = await loadScheduleSnapshot(sql, open);
    expect(snapshot.safety.sentLastDay).toBe(3);

    const decision = evaluateSchedule({ now, snapshot, config: open });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe('daily_cap');
      // Le plus ancien a 20 h : il sort de la fenêtre de 24 h dans ~4 h.
      const inHours = ((decision.nextEligibleAt as Date).getTime() - now.getTime()) / 3_600_000;
      expect(inHours).toBeGreaterThan(3.9);
      expect(inHours).toBeLessThan(4.1);
    }
  });

  it('la cadence ne compte QUE des tentatives d’effet — jamais un dry-run', async () => {
    const manifest = await lockManifest();
    await enqueueInstagramJob(sql, { manifestId: manifest.id, action: 'first_touch_dm', enqueuedBy: 'Test' });
    const open = alwaysOpen();

    // Trois dry-runs complets, chacun ouvrant une session et un profil.
    for (let i = 0; i < 3; i += 1) {
      const result = await runInstagramDryRun(
        { sql, config: open, workerId: `w-${String(i)}`, mode: 'DRY_RUN' },
        { rail: new FakeRail() },
      );
      expect(result.outcomes[0]!.status).toBe('DRY_RUN_COMPLETED');
    }

    const snapshot = await loadScheduleSnapshot(sql, open);
    // Aucun effet : la cadence n'a rien à mesurer, et le dire `null` plutôt que
    // `0` est ce qui évite de bloquer le tout premier envoi pour toujours.
    expect(snapshot.lastExternalEffectAt).toBeNull();
    expect(snapshot.safety.msSinceLastExternalEffect).toBeNull();
    expect(await countExternalEffects()).toBe(0);
    expect(await countOutreachEvents()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Report / refus : la distinction, du bout en bout
// ---------------------------------------------------------------------------

describe('sémantique des reports', () => {
  it('hors fenêtre : le job est REPORTÉ à l’ouverture, et reste réclamable', async () => {
    const manifest = await lockManifest();
    const { job } = await enqueueInstagramJob(sql, {
      manifestId: manifest.id,
      action: 'first_touch_dm',
      enqueuedBy: 'Test',
    });

    // Samedi 18 juillet 2026, 14:00 Paris : hors fenêtre (lun–ven).
    const saturday = new Date('2026-07-18T12:00:00Z');
    const rail = new FakeRail();
    const result = await runInstagramDryRun(
      { sql, config, workerId: 'w', mode: 'DRY_RUN', now: () => saturday },
      { rail },
    );

    expect(result.outcomes[0]!.status).toBe('SKIPPED');
    expect(result.outcomes[0]!.skipReason).toBe('outside_window');
    expect(result.outcomes[0]!.skipClass).toBe('TEMPORARY');
    // Le navigateur n'a pas été ouvert : un report se décide avant.
    expect(rail.opened).toHaveLength(0);

    // Replanifié au lundi 9 h, pas « dans un quart d'heure ».
    const stored = await loadInstagramJob(sql, job.id);
    expect(stored!.status).toBe('SKIPPED');
    expect(stored!.lastSkipReason).toBe('outside_window');
    expect(stored!.lastSkipClass).toBe('TEMPORARY');
    expect(new Date(stored!.notBefore).toISOString()).toBe('2026-07-20T07:00:00.000Z');
    // Et il reste dans la file : `SKIPPED` est réclamable.
    expect(deriveQueueState(stored!.status, stored!.notBefore, saturday)).toBe('SCHEDULED');
  });

  it('un refus TERMINAL n’est jamais replanifié, et la base l’interdit', async () => {
    const manifest = await lockManifest();
    const { job } = await enqueueInstagramJob(sql, {
      manifestId: manifest.id,
      action: 'first_touch_dm',
      enqueuedBy: 'Test',
    });

    // Un handle observé différent : identité TERMINALE.
    class MismatchRail extends FakeRail {
      override async openProfile(handle: string): Promise<InstagramProfileObservation> {
        const observation = await super.openProfile(handle);
        return {
          ...observation,
          finalUrl: 'https://www.instagram.com/unautrecompte/',
          signals: observation.signals.map((signal) => ({ ...signal, handle: 'unautrecompte', raw: 'unautrecompte' })),
        };
      }
    }

    const result = await runInstagramDryRun(
      { sql, config: alwaysOpen(), workerId: 'w', mode: 'DRY_RUN' },
      { rail: new MismatchRail() },
    );
    expect(result.outcomes[0]!.skipReason).toBe('identity_failure');
    expect(result.outcomes[0]!.skipClass).toBe('TERMINAL');
    expect(result.outcomes[0]!.nextAttemptAt).toBeNull();

    const stored = await loadInstagramJob(sql, job.id);
    expect(stored!.status).toBe('INELIGIBLE');
    expect(stored!.terminatedAt).not.toBeNull();
    // Hors de la file : un second worker ne le reprend pas.
    expect(await claimNextInstagramJob(sql, { workerId: 'w2', leaseMs: 60_000 })).toBeNull();

    // Et la base refuse d'écrire un motif TERMINAL sur un statut réclamable :
    // « un blocage métier terminal ne doit pas être rejoué » est une
    // impossibilité, pas une intention.
    await expect(
      sql.query(`update ig_dispatch_jobs set status = 'PENDING', terminated_at = null where id = $1`, [job.id]),
    ).rejects.toThrow();
  });

  it('un report TEMPORAIRE ne devient jamais terminal par accident', async () => {
    const manifest = await lockManifest();
    const { job } = await enqueueInstagramJob(sql, {
      manifestId: manifest.id,
      action: 'first_touch_dm',
      enqueuedBy: 'Test',
    });

    const saturday = new Date('2026-07-18T12:00:00Z');
    await runInstagramDryRun(
      { sql, config, workerId: 'w', mode: 'DRY_RUN', now: () => saturday },
      { rail: new FakeRail() },
    );
    const skipped = await loadInstagramJob(sql, job.id);
    expect(skipped!.status).toBe('SKIPPED');
    expect(skipped!.terminatedAt).toBeNull();

    // Le lundi venu, il repart — et va au bout.
    await sql.query(`update ig_dispatch_jobs set not_before = now() where id = $1`, [job.id]);
    const monday = new Date('2026-07-20T12:00:00Z');
    const second = await runInstagramDryRun(
      { sql, config, workerId: 'w', mode: 'DRY_RUN', now: () => monday },
      { rail: new FakeRail() },
    );
    expect(second.outcomes[0]!.status).toBe('DRY_RUN_COMPLETED');
    const done = await loadInstagramJob(sql, job.id);
    expect(done!.status).toBe('DRY_RUN_VALIDATED');
    // Deux reports comptés en tout ? Non : un seul, celui du samedi.
    expect(done!.skipCount).toBe(1);
  });

  it('les motifs de report sont persistés et comptés, pas seulement affichés', async () => {
    const manifest = await lockManifest();
    await enqueueInstagramJob(sql, { manifestId: manifest.id, action: 'first_touch_dm', enqueuedBy: 'Test' });

    const saturday = new Date('2026-07-18T12:00:00Z');
    await runInstagramDryRun(
      { sql, config, workerId: 'w', mode: 'DRY_RUN', now: () => saturday },
      { rail: new FakeRail() },
    );

    const overview = await loadQueueOverview(sql);
    expect(overview.skipReasons).toEqual([{ reason: 'outside_window', count: 1 }]);
    expect(overview.total).toBe(1);
    expect(overview.depth).toEqual([{ status: 'SKIPPED', total: 1, dueNow: 1, scheduled: 0 }]);
    // `dueNow` vaut 1 et non 0, et ce n'est pas une anomalie : l'horloge du
    // worker est injectée (samedi 18 juillet 2026), celle de la vue est celle de
    // la BASE. Le lundi calculé est donc déjà passé quand la suite tourne. La
    // vue interroge `now()` côté serveur exprès — comparer `not_before` à
    // l'horloge du client donnerait un décompte faux dès que les deux dérivent,
    // et c'est la base qui arbitre la prise. Le partage dû/programmé est éprouvé
    // par `deriveQueueState` dans le test « hors fenêtre », sur l'horloge du
    // scénario.

    const events = await sql.query<{ status: string; skipReason: string; skipClass: string; next: string }>(
      `select status, skip_reason as "skipReason", skip_class as "skipClass",
              next_eligible_at as "next"
         from ig_job_events where status = 'SKIPPED'`,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.skipReason).toBe('outside_window');
    expect(events[0]!.skipClass).toBe('TEMPORARY');
    expect(events[0]!.next).not.toBeNull();
  });

  it('la replanification ne remonte jamais dans le passé', () => {
    const now = new Date('2026-07-15T12:00:00Z');
    // Une date de libération déjà écoulée — le temps de lire la base.
    const stale = nextAttemptAt({
      now,
      decision: {
        allowed: false,
        reason: 'hourly_cap',
        detail: 'plafond',
        nextEligibleAt: new Date(now.getTime() - 60_000),
        gates: [],
      },
      config,
      idempotencyKey: 'k',
    });
    expect(stale.getTime()).toBeGreaterThan(now.getTime());

    // Sans échéance connue : le backoff par défaut, pas « tout de suite ».
    const unknown = nextAttemptAt({
      now,
      decision: { allowed: false, reason: 'rail_failure', detail: 'panne', nextEligibleAt: null, gates: [] },
      config,
      idempotencyKey: 'k',
    });
    expect(unknown.getTime()).toBe(now.getTime() + config.schedule.defaultBackoffMs);
  });
});

// ---------------------------------------------------------------------------
// DRY-RUN de production : les garanties structurelles
// ---------------------------------------------------------------------------

describe('DRY-RUN de production', () => {
  it('tourne avec l’arrêt global ARMÉ, et ne peut produire aucun effet', async () => {
    const manifest = await lockManifest();
    await enqueueInstagramJob(sql, { manifestId: manifest.id, action: 'first_touch_dm', enqueuedBy: 'Test' });
    // Arrêt par défaut : aucune ligne, ce qui VAUT armé.
    const result = await runInstagramDryRun(
      { sql, config: alwaysOpen(), workerId: 'w', mode: 'DRY_RUN' },
      { rail: new FakeRail() },
    );

    expect(result.outcomes[0]!.status).toBe('DRY_RUN_COMPLETED');
    expect(result.outcomes[0]!.preview).not.toBeNull();
    expect(result.outcomes[0]!.liveProjection?.wouldProceed).toBe(false);
    expect(result.outcomes[0]!.liveProjection?.blockedBy).toBe('kill_switch');
    expect(result.externalEffects).toBe(0);
    expect(await countExternalEffects()).toBe(0);
    expect(await countOutreachEvents()).toBe(0);
  });

  it('le message montré est celui du manifeste, mot pour mot', async () => {
    const manifest = await lockManifest();
    await enqueueInstagramJob(sql, { manifestId: manifest.id, action: 'first_touch_dm', enqueuedBy: 'Test' });
    const result = await runInstagramDryRun(
      { sql, config: alwaysOpen(), workerId: 'w', mode: 'DRY_RUN' },
      { rail: new FakeRail() },
    );
    const preview = result.outcomes[0]!.preview;
    expect(preview?.payloadFields['body']).toBe(TEXT);
    expect(preview?.payloadFields['to_handle']).toBe(HANDLE);
  });

  it('la base REFUSE une ligne d’audit DRY_RUN qui prétendrait avoir agi', async () => {
    const manifest = await lockManifest();
    const { job } = await enqueueInstagramJob(sql, {
      manifestId: manifest.id,
      action: 'first_touch_dm',
      enqueuedBy: 'Test',
    });
    // La garde structurelle : le jour où un bug ferait envoyer un dry-run, la
    // transaction échouerait plutôt que de consigner un mensonge.
    await expect(
      sql.query(
        `insert into ig_job_events
           (job_id, manifest_id, worker_id, mode, status, reason_code, idempotency_key, external_effect_attempted)
         values ($1,$2,'w','DRY_RUN','SENT','IG_LIVE_SENT','k',true)`,
        [job.id, manifest.id],
      ),
    ).rejects.toThrow();

    // Et un fait de parcours ne peut pas déclarer d'effet, même en LIVE.
    await expect(
      sql.query(
        `insert into ig_job_events
           (job_id, manifest_id, worker_id, mode, status, reason_code, idempotency_key, external_effect_attempted)
         values ($1,$2,'w','LIVE','CLAIMED','IG_DRY_RUN_OK','k',true)`,
        [job.id, manifest.id],
      ),
    ).rejects.toThrow();
  });

  it('--drain traite toute la file, sans jamais reprendre deux fois le même job', async () => {
    const handles = ['prestation_un', 'prestation_deux', 'prestation_trois'];
    for (const handle of handles) {
      const manifest = await lockManifest(handle);
      await enqueueInstagramJob(sql, { manifestId: manifest.id, action: 'first_touch_dm', enqueuedBy: 'Test' });
    }

    const rail = new FakeRail();
    const result = await runInstagramDryRun(
      { sql, config: alwaysOpen(), workerId: 'w', mode: 'DRY_RUN', drain: true },
      { rail },
    );

    expect(result.outcomes).toHaveLength(3);
    expect(result.drainTruncated).toBe(false);
    // Un profil par job, jamais deux fois le même.
    expect(new Set(rail.opened).size).toBe(3);
    expect(rail.opened.sort()).toEqual([...handles].sort());
    expect(await countExternalEffects()).toBe(0);
    expect(await countOutreachEvents()).toBe(0);
  });

  it('un redémarrage ne duplique rien : la seconde exécution retrouve les mêmes jobs', async () => {
    const manifest = await lockManifest();
    const { job } = await enqueueInstagramJob(sql, {
      manifestId: manifest.id,
      action: 'first_touch_dm',
      enqueuedBy: 'Test',
    });
    const open = alwaysOpen();

    await runInstagramDryRun({ sql, config: open, workerId: 'w1', mode: 'DRY_RUN' }, { rail: new FakeRail() });
    await runInstagramDryRun({ sql, config: open, workerId: 'w2', mode: 'DRY_RUN' }, { rail: new FakeRail() });

    const jobs = await sql.query<{ n: string }>('select count(*) as n from ig_dispatch_jobs');
    expect(Number(jobs[0]!.n)).toBe(1);
    const stored = await loadInstagramJob(sql, job.id);
    // Deux exécutions, deux tentatives comptées sur LE MÊME job — pas deux jobs.
    expect(stored!.attempts).toBe(2);
    expect(await countExternalEffects()).toBe(0);
  });

  it('un worker tué après la prise laisse une trace, et le job repart sans effet', async () => {
    const manifest = await lockManifest();
    const { job } = await enqueueInstagramJob(sql, {
      manifestId: manifest.id,
      action: 'first_touch_dm',
      enqueuedBy: 'Test',
    });

    // Le worker prend le bail… et meurt : aucun `finalize`.
    const claimed = await claimNextInstagramJob(sql, { workerId: 'crash', leaseMs: 60_000 });
    expect(claimed!.id).toBe(job.id);
    await sql.query(`update ig_dispatch_jobs set lease_expires_at = now() - interval '1 second' where id = $1`, [
      job.id,
    ]);

    // La reprise remet le job dans la file — il n'a rien tenté, on le SAIT.
    const recovered = await runInstagramDryRun(
      { sql, config: alwaysOpen(), workerId: 'w2', mode: 'DRY_RUN' },
      { rail: new FakeRail() },
    );
    expect(recovered.recoveredLeases).toBe(1);
    expect(recovered.reviewRequired).toBe(0);
    expect(recovered.outcomes[0]!.status).toBe('DRY_RUN_COMPLETED');
    expect(await countExternalEffects()).toBe(0);
  });
});
