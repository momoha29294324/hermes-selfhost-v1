import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConversationPolicy, loadInstagramRail } from '@/lib/config/load';
import { conversationPromptVersionFor } from '@/lib/conversation/brain';
import { loadConversationPlan } from '@/lib/conversation/plan';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import type { Sql } from '@/lib/db/sql';
import { InstagramBrowserProfileBusyError } from '@/lib/instagram/browserProfileLease';
import type {
  InstagramReplyInput,
  InstagramReplyRail,
  InstagramReplyResult,
} from '@/lib/instagram/replyRail';
import { setKillSwitch } from '@/lib/instagram/safety';
import { persistAnalysis, loadActiveAnalysis } from '@/lib/replies/analyses';
import { loadReplyContext } from '@/lib/replies/context';
import { persistDraft, sha256Hex } from '@/lib/replies/draft';
import {
  decideCategory,
  detectUnsubscribeDemand,
  resolveNextAction,
  type ReplyCategory,
} from '@/lib/replies/taxonomy';
import { REPLY_CLASSIFIER_PROMPT_VERSION } from '@/lib/replies/classifier';
import {
  assessAutoReplyEligibility,
  loadAutoReplyCandidates,
  loadAutoReplyEligibilityFacts,
} from '@/lib/autoreply/eligibility';
import { loadActiveAutoReplyActivation, revokeAutoReplyActivation } from '@/lib/autoreply/activation';
import { runAutoReplyCycle, runAutoReplyRuntime } from '@/lib/autoreply/runtime';
import { loadAutoReplyStatus } from '@/lib/autoreply/status';
import { makeReplyFixtures, type ContactedProspect, type ReplyFixtures } from './support/replyFixture';

/**
 * HERMES-AUTO-REPLY-PRODUCTION-R1 §10 — le runtime de production, sur une vraie
 * base.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce fichier prouve, et que rien de pur ne peut prouver
 * ---------------------------------------------------------------------------
 *   * qu'allumer le runtime ne répond PAS au retard historique — la propriété
 *     qui décide si ce round est livrable ;
 *   * que les portes tiennent DANS L'ORDRE sur des données réellement
 *     écrites ;
 *   * qu'un effet tenté ne se rejoue jamais, quel que soit le moment où le
 *     processus meurt ;
 *   * que le profil navigateur n'est jamais tenu pendant une attente.
 *
 * ---------------------------------------------------------------------------
 * Le rail est un DOUBLE, et il COMPTE
 * ---------------------------------------------------------------------------
 * Aucun navigateur n'est ouvert. Le double appelle `onBeforeExternalEffect`
 * exactement quand la vraie primitive l'appelle, et compte ses appels : c'est
 * ce compteur qui rend vérifiable la phrase « zéro effet externe ». Un test qui
 * se contenterait du statut final ne verrait pas la différence entre « refusé
 * avant le crochet » et « refusé après ».
 *
 * Aucune donnée réelle : entreprises, handles et textes sont fictifs.
 */

const MAILBOX_EMAIL = 'reponse@example.com';
const ACCOUNT_HANDLE = 'compte_test_hermes';
const FIRST_TOUCH =
  'Bonjour, j’ai vu que vous faisiez du prestation standard à domicile. Comment vos clients vous trouvent aujourd’hui ?';
const THREAD_ID = '107403793987175';

/** Le fil du temps de ces scénarios. La frontière tombe entre les deux tours. */
const HISTORICAL_AT = '2026-08-21T13:00:00.000Z';
const FRONTIER_AT = '2026-08-21T14:00:00.000Z';
const FRESH_AT = '2026-08-21T15:00:00.000Z';
const NOW = new Date('2026-08-21T16:00:00.000Z');

const conversation = loadConversationPolicy();
const loaded = loadInstagramRail();
const config = {
  ...loaded,
  inbound: { ...loaded.inbound, accountHandle: ACCOUNT_HANDLE, formerAccountHandles: [] },
};

let sql: Sql;
let dir: string;
let fixtures: ReplyFixtures;
let handleCounter = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-autoreply-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);
  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
    ['example-autoreply-test', 'Test', 'example-services', '{}'],
  );
  fixtures = makeReplyFixtures(sql, {
    campaignId: rows[0]!.id,
    mailbox: MAILBOX_EMAIL,
    firstTouch: FIRST_TOUCH,
  });
});

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  // Le défaut du dépôt, réaffirmé avant CHAQUE test : arrêt global armé, aucune
  // activation. Un test qui a besoin d'une porte ouverte l'ouvre lui-même, et
  // aucun ne peut hériter de celle du précédent.
  await setKillSwitch(sql, { engaged: true, setBy: 'test', reason: 'défaut du dépôt' });
  await sql.query(
    `update hermes_autoreply_activations
        set revoked_at = now(), revoked_by = 'test', revoke_reason = 'reset'
      where revoked_at is null`,
  );
  // Les tours des scénarios PRÉCÉDENTS deviennent du retard historique. Ce
  // n'est pas une commodité de test : c'est exactement le mécanisme sous test.
  // Chaque test repart donc sur une base où sa propre conversation est la seule
  // que la frontière laisse passer.
  await sql.query(`update r6b_inbound_messages set received_at = timestamptz '2026-01-01T00:00:00Z'`);
  // Et aucun effet récent ne pèse sur la cadence ni sur les plafonds : sans
  // cela, le premier test qui envoie fermerait l'espacement de quinze minutes
  // pour tous les suivants.
  await sql.query(
    `update hermes_conversation_plans
        set external_effect_started_at = now() - interval '2 days'
      where external_effect_attempted = true`,
  );
});

// ---------------------------------------------------------------------------
// L'activation, posée à une date CHOISIE
// ---------------------------------------------------------------------------

/**
 * Écrit une activation dont la frontière est `frontierAt`.
 *
 * Les scénarios ont besoin de placer la frontière entre deux tours écrits à des
 * dates fixes ; `activateAutoReply` ne le permet pas — et c'est justement ce
 * qu'un test séparé vérifie. La ligne écrite ici a exactement la forme qu'une
 * activation réelle aurait eue à cet instant : `frontier_at = activated_at`.
 */
async function activateAt(frontierAt: string, maxEffects: number | null = null): Promise<void> {
  await sql.query(
    `insert into hermes_autoreply_activations
       (frontier_at, activated_at, activated_by, reason, policy_version,
        commercial_policy_version, max_effects)
     values ($1::timestamptz, $1::timestamptz, 'Test', 'scénario', 'p', 'c', $2)`,
    [frontierAt, maxEffects],
  );
}

// ---------------------------------------------------------------------------
// Le double de rail
// ---------------------------------------------------------------------------

interface RailScript {
  readonly result?: InstagramReplyResult;
  readonly throwAfterHook?: Error;
  readonly throwBeforeHook?: Error;
}

class FakeReplyRail implements InstagramReplyRail {
  hookCalls = 0;
  calls = 0;
  closes = 0;
  lastInput: InstagramReplyInput | null = null;

  constructor(private readonly script: RailScript = {}) {}

  async sendThreadReply(input: InstagramReplyInput): Promise<InstagramReplyResult> {
    this.calls += 1;
    this.lastInput = input;
    if (this.script.throwBeforeHook !== undefined) throw this.script.throwBeforeHook;
    if (input.stopAfter === 'thread') {
      return Object.freeze({
        kind: 'PREVIEWED' as const,
        detail: 'fil atteint (double)',
        sessionState: 'SESSION_READY' as const,
        threadUrl: `https://www.instagram.com/direct/t/${input.target.expectedThreadId}/`,
        threadHandle: input.target.expectedHandle,
        priorBubbles: 6,
        composerReady: true,
        screenshotPath: null,
      });
    }
    await input.onBeforeExternalEffect();
    this.hookCalls += 1;
    if (this.script.throwAfterHook !== undefined) throw this.script.throwAfterHook;
    return this.script.result ?? sent(input);
  }

  async close(): Promise<void> {
    this.closes += 1;
  }
}

function sent(input: InstagramReplyInput): InstagramReplyResult {
  return Object.freeze({
    kind: 'ATTEMPTED' as const,
    observation: Object.freeze({
      threadUrl: `https://www.instagram.com/direct/t/${input.target.expectedThreadId}/`,
      observedThreadId: input.target.expectedThreadId,
      threadHandle: input.target.expectedHandle,
      priorBubbles: 6,
      matchingBubblesBefore: 0,
      matchingBubblesAfter: 1,
      harvestReadableBefore: true,
      harvestReadableAfter: true,
      composerCleared: true,
      outgoingBubbleConfirmed: true,
      deliveryFailureMarkers: Object.freeze([]),
      deliveryVerdict: 'SENT' as const,
      scopeDetail: 'niveau 3 (double)',
      sessionState: 'SESSION_READY' as const,
      screenshotPath: null,
      durationMs: 3_100,
      detail: 'clic unique (double)',
    }),
  });
}

// ---------------------------------------------------------------------------
// Le montage
// ---------------------------------------------------------------------------

interface Scene {
  readonly prospect: ContactedProspect;
  readonly handle: string;
  readonly threadId: string;
}

async function newProspect(options: { identityConfirmed?: boolean } = {}): Promise<Scene> {
  handleCounter += 1;
  const displayName = `ACME ATELIER ${String(handleCounter)}`;
  const handle = `acmeatelier${String(handleCounter)}`;
  const prospect = await fixtures.contactedProspect(handle, {
    transport: 'instagram_dm',
    displayName,
  });
  await sql.query(`update prospects set identity_review = $2 where id = $1`, [
    prospect.prospectId,
    options.identityConfirmed === false ? null : 'confirmed',
  ]);
  return { prospect, handle, threadId: `${THREAD_ID}${String(handleCounter)}` };
}

async function turn(
  scene: Scene,
  spec: {
    body: string;
    category?: ReplyCategory;
    receivedAt: string;
    draftBody?: string | null;
    correlationStatus?: 'EXACT' | 'HIGH_CONFIDENCE' | 'REVIEW_REQUIRED' | 'UNMATCHED';
    promptVersion?: string;
  },
): Promise<string> {
  const id = await fixtures.instagramInbound({
    manifest: scene.prospect.manifest,
    outreachEventId: scene.prospect.outreachEventId,
    prospectId: scene.prospect.prospectId,
    body: spec.body,
    threadId: scene.threadId,
    accountHandle: ACCOUNT_HANDLE,
    from: scene.handle,
    receivedAt: spec.receivedAt,
    ...(spec.correlationStatus === undefined ? {} : { correlationStatus: spec.correlationStatus }),
  });
  if (spec.correlationStatus === 'UNMATCHED' || spec.correlationStatus === 'REVIEW_REQUIRED') return id;

  const context = await loadReplyContext(sql, id);
  if (context === null) throw new Error('contexte introuvable');
  const decision = decideCategory({
    category: spec.category ?? 'OBJECTION',
    confidence: 0.95,
    correlationStatus: context.reply.correlationStatus,
    deterministic: true,
    unsubscribeDemand: detectUnsubscribeDemand(spec.body),
  });
  await persistAnalysis(sql, context, {
    category: decision.category,
    confidence: decision.confidence,
    reasoningSummary: 'classé pour le test',
    evidenceExcerpts: [],
    currentRequest: 'NONE' as const,
    reportedContent: [],
    requiresHumanReview: decision.requiresHumanReview,
    recommendedNextAction: resolveNextAction(decision),
    decision,
    decidedDeterministically: true,
    model: 'test-model',
    effort: null,
    promptVersion: spec.promptVersion ?? REPLY_CLASSIFIER_PROMPT_VERSION,
    inputSha256: 'f'.repeat(64),
    modelRunId: null,
  });

  const draftBody = spec.draftBody === undefined ? 'Et ça vous ramène des demandes régulièrement ?' : spec.draftBody;
  if (draftBody !== null) {
    const analysis = await loadActiveAnalysis(sql, id);
    if (analysis === null) throw new Error('analyse introuvable');
    await persistDraft(sql, context, analysis, {
      body: draftBody,
      bodySha256: sha256Hex(draftBody),
      rationale: 'test',
      guardrailFlags: [],
      blocked: false,
      model: 'test-model',
      effort: null,
      promptVersion: conversationPromptVersionFor('instagram_dm'),
      modelRunId: null,
    });
  }
  return id;
}

function cycleInput(mode: 'PLAN' | 'PREVIEW' | 'LIVE', maxEffects = 1) {
  return {
    sql,
    config,
    conversation,
    workerId: 'test-autoreply',
    mode,
    maxEffectsPerCycle: maxEffects,
    now: (): Date => NOW,
  } as const;
}

async function openTheGates(): Promise<void> {
  await setKillSwitch(sql, { engaged: false, setBy: 'test', reason: 'scénario' });
}

// ===========================================================================
// §6 — LA FRONTIÈRE D'ACTIVATION
// ===========================================================================

describe('§6 — allumer le runtime ne répond pas au retard historique', () => {
  it('un tour ANTÉRIEUR à la frontière n’est pas candidat, et n’inscrit aucun plan', async () => {
    const scene = await newProspect();
    const inboundId = await turn(scene, { body: 'ah oui je vois', receivedAt: HISTORICAL_AT });
    await activateAt(FRONTIER_AT);
    await openTheGates();

    const activation = await loadActiveAutoReplyActivation(sql);
    expect(activation).not.toBeNull();

    const candidates = await loadAutoReplyCandidates(sql, { frontierAt: activation!.frontierAt });
    expect(candidates.map((row) => row.inboundMessageId)).not.toContain(inboundId);

    const facts = await loadAutoReplyEligibilityFacts(sql, inboundId, activation!.frontierAt);
    const verdict = assessAutoReplyEligibility(facts!);
    expect(verdict.eligible).toBe(false);
    expect(verdict.eligible === false && verdict.refusal).toBe('BEFORE_ACTIVATION_FRONTIER');

    const rail = new FakeReplyRail();
    const result = await runAutoReplyCycle(cycleInput('LIVE'), { rail });
    expect(result.outcome).toBe('NO_ELIGIBLE_CONVERSATION');
    expect(rail.calls).toBe(0);
    expect(rail.hookCalls).toBe(0);
    expect(await plansFor(scene)).toHaveLength(0);
  });

  it('un retard historique de PLUSIEURS conversations ne produit aucune rafale', async () => {
    // Le scénario réel du 24 août : deux entreprises avaient répondu trois
    // jours plus tôt, et personne ne leur avait répondu. Allumer un runtime
    // sans frontière les aurait toutes reprises d'un coup.
    const scenes = [await newProspect(), await newProspect(), await newProspect()];
    for (const scene of scenes) {
      await turn(scene, { body: 'merci, bonne continuation', receivedAt: HISTORICAL_AT });
    }
    await activateAt(FRONTIER_AT);
    await openTheGates();

    const rail = new FakeReplyRail();
    const result = await runAutoReplyCycle(cycleInput('LIVE', 5), { rail });
    expect(result.effects).toBe(0);
    expect(rail.hookCalls).toBe(0);
    for (const scene of scenes) expect(await plansFor(scene)).toHaveLength(0);
  });

  it('un tour POSTÉRIEUR à la frontière est traité normalement', async () => {
    const scene = await newProspect();
    const inboundId = await turn(scene, { body: 'ah oui je vois', receivedAt: FRESH_AT });
    await activateAt(FRONTIER_AT);
    await openTheGates();

    const activation = await loadActiveAutoReplyActivation(sql);
    const candidates = await loadAutoReplyCandidates(sql, { frontierAt: activation!.frontierAt });
    expect(candidates.map((row) => row.inboundMessageId)).toContain(inboundId);

    const facts = await loadAutoReplyEligibilityFacts(sql, inboundId, activation!.frontierAt);
    expect(assessAutoReplyEligibility(facts!).eligible).toBe(true);
  });

  it('la frontière SURVIT à un redémarrage : elle est une ligne, pas une variable', async () => {
    await activateAt(FRONTIER_AT);
    const first = await loadActiveAutoReplyActivation(sql);
    // Un « redémarrage » est, pour ce qui nous occupe, une seconde lecture par
    // un processus qui n'a rien gardé en mémoire.
    const second = await loadActiveAutoReplyActivation(sql);
    expect(second?.frontierAt).toBe(first?.frontierAt);
    expect(second?.id).toBe(first?.id);
  });

  it('la base REFUSE une frontière antidatée', async () => {
    await expect(
      sql.query(
        `insert into hermes_autoreply_activations
           (frontier_at, activated_at, activated_by, reason, policy_version, commercial_policy_version)
         values ('2026-08-01T00:00:00Z', '2026-08-21T00:00:00Z', 'Test', 'antidater', 'p', 'c')`,
      ),
    ).rejects.toThrow();
  });

  it('une SEULE activation peut vivre à la fois', async () => {
    await activateAt(FRONTIER_AT);
    await expect(activateAt(FRESH_AT)).rejects.toThrow();
  });

  it('sans activation vivante, le runtime ne regarde RIEN', async () => {
    const scene = await newProspect();
    await turn(scene, { body: 'ah oui je vois', receivedAt: FRESH_AT });
    await openTheGates();

    const rail = new FakeReplyRail();
    const result = await runAutoReplyCycle(cycleInput('LIVE'), { rail });
    expect(result.outcome).toBe('RUNTIME_NOT_ACTIVATED');
    expect(result.candidates).toBe(0);
    expect(rail.calls).toBe(0);
    expect(await plansFor(scene)).toHaveLength(0);
  });

  it('une RÉVOCATION referme le rail sans toucher aux plans déjà inscrits', async () => {
    const scene = await newProspect();
    await turn(scene, { body: 'ah oui je vois', receivedAt: FRESH_AT });
    await activateAt(FRONTIER_AT);
    await openTheGates();

    const rail = new FakeReplyRail();
    await runAutoReplyCycle(cycleInput('LIVE'), { rail });
    const before = await plansFor(scene);
    expect(before.length).toBeGreaterThan(0);

    await revokeAutoReplyActivation(sql, { revokedBy: 'Test', reason: 'fin du scénario' });
    const after = await runAutoReplyCycle(cycleInput('LIVE'), { rail: new FakeReplyRail() });
    expect(after.outcome).toBe('RUNTIME_NOT_ACTIVATED');
    expect(await plansFor(scene)).toHaveLength(before.length);
  });
});

// ===========================================================================
// §2 — L'ÉLIGIBILITÉ, SUR DE VRAIES LIGNES
// ===========================================================================

describe('§2 — le périmètre, sur des lignes réellement écrites', () => {
  it('un DM d’INCONNU n’est jamais candidat', async () => {
    const scene = await newProspect();
    const unknown = await turn(scene, {
      body: 'salut, tu vends quoi ?',
      receivedAt: FRESH_AT,
      correlationStatus: 'UNMATCHED',
    });
    await activateAt(FRONTIER_AT);
    const activation = await loadActiveAutoReplyActivation(sql);

    const candidates = await loadAutoReplyCandidates(sql, { frontierAt: activation!.frontierAt });
    expect(candidates.map((row) => row.inboundMessageId)).not.toContain(unknown);

    const facts = await loadAutoReplyEligibilityFacts(sql, unknown, activation!.frontierAt);
    expect(assessAutoReplyEligibility(facts!).eligible).toBe(false);
  });

  it('une corrélation FAIBLE (REVIEW_REQUIRED) n’est jamais candidate', async () => {
    const scene = await newProspect();
    const weak = await turn(scene, {
      body: 'c’est vous qui m’aviez écrit ?',
      receivedAt: FRESH_AT,
      correlationStatus: 'REVIEW_REQUIRED',
    });
    await activateAt(FRONTIER_AT);
    const activation = await loadActiveAutoReplyActivation(sql);
    const facts = await loadAutoReplyEligibilityFacts(sql, weak, activation!.frontierAt);
    const verdict = assessAutoReplyEligibility(facts!);
    expect(verdict.eligible).toBe(false);
    expect(verdict.eligible === false && verdict.refusal).toBe('NOT_CORRELATED');
  });

  it('une identité NON confirmée n’est pas candidate', async () => {
    const scene = await newProspect({ identityConfirmed: false });
    const inboundId = await turn(scene, { body: 'ah oui', receivedAt: FRESH_AT });
    await activateAt(FRONTIER_AT);
    const activation = await loadActiveAutoReplyActivation(sql);
    const facts = await loadAutoReplyEligibilityFacts(sql, inboundId, activation!.frontierAt);
    const verdict = assessAutoReplyEligibility(facts!);
    expect(verdict.eligible).toBe(false);
    expect(verdict.eligible === false && verdict.refusal).toBe('IDENTITY_UNCONFIRMED');
  });

  it('un prospect EXCLU (do_not_contact) n’est pas candidat', async () => {
    const scene = await newProspect();
    const inboundId = await turn(scene, { body: 'ah oui', receivedAt: FRESH_AT });
    await sql.query(
      `insert into do_not_contact (match_kind, value, reason, added_by) values ('instagram',$1,'test','test')`,
      [scene.handle],
    );
    await activateAt(FRONTIER_AT);
    await openTheGates();
    const activation = await loadActiveAutoReplyActivation(sql);
    const facts = await loadAutoReplyEligibilityFacts(sql, inboundId, activation!.frontierAt);
    const verdict = assessAutoReplyEligibility(facts!);
    expect(verdict.eligible).toBe(false);
    expect(verdict.eligible === false && verdict.refusal).toBe('PROSPECT_SUPPRESSED');

    const rail = new FakeReplyRail();
    const result = await runAutoReplyCycle(cycleInput('LIVE'), { rail });
    expect(rail.hookCalls).toBe(0);
    expect(result.effects).toBe(0);
  });

  it('une conversation CLOSE (NOT_INTERESTED) n’est pas candidate', async () => {
    const scene = await newProspect();
    const inboundId = await turn(scene, { body: 'non merci', receivedAt: FRESH_AT });
    await sql.query(
      `insert into r6b_prospect_outreach_states (prospect_id, state) values ($1,'NOT_INTERESTED')
       on conflict (prospect_id) do update set state = 'NOT_INTERESTED'`,
      [scene.prospect.prospectId],
    );
    await activateAt(FRONTIER_AT);
    const activation = await loadActiveAutoReplyActivation(sql);
    const facts = await loadAutoReplyEligibilityFacts(sql, inboundId, activation!.frontierAt);
    const verdict = assessAutoReplyEligibility(facts!);
    expect(verdict.eligible).toBe(false);
    expect(verdict.eligible === false && verdict.refusal).toBe('CONVERSATION_CLOSED');
  });

  it('une lecture rendue sous une CONSIGNE PÉRIMÉE n’est pas candidate', async () => {
    const scene = await newProspect();
    const inboundId = await turn(scene, {
      body: 'ah oui',
      receivedAt: FRESH_AT,
      promptVersion: 'hermes-turn-1',
    });
    await activateAt(FRONTIER_AT);
    const activation = await loadActiveAutoReplyActivation(sql);
    const candidates = await loadAutoReplyCandidates(sql, { frontierAt: activation!.frontierAt });
    expect(candidates.map((row) => row.inboundMessageId)).not.toContain(inboundId);
    const facts = await loadAutoReplyEligibilityFacts(sql, inboundId, activation!.frontierAt);
    const verdict = assessAutoReplyEligibility(facts!);
    expect(verdict.eligible === false && verdict.refusal).toBe('ANALYSIS_VERSION_STALE');
  });
});

// ===========================================================================
// §4 / §11 — LE NAVIGATEUR, LES SALVES, LA FRAÎCHEUR
// ===========================================================================

describe('§4 — le profil navigateur n’est jamais tenu pendant une attente', () => {
  it('le rail est refermé après CHAQUE tour, y compris quand il lève', async () => {
    const scene = await newProspect();
    await turn(scene, { body: 'ah oui je vois', receivedAt: FRESH_AT });
    await activateAt(FRONTIER_AT);
    await openTheGates();

    const rail = new FakeReplyRail({ throwBeforeHook: new Error('page morte') });
    await runAutoReplyCycle(cycleInput('LIVE'), { rail });
    expect(rail.closes).toBeGreaterThanOrEqual(1);
  });

  it('un profil TENU par l’autre runtime est une file d’attente, pas une panne', async () => {
    const scene = await newProspect();
    await turn(scene, { body: 'ah oui je vois', receivedAt: FRESH_AT });
    await activateAt(FRONTIER_AT);
    await openTheGates();

    const rail = new FakeReplyRail({
      throwBeforeHook: new InstagramBrowserProfileBusyError('/tmp/profile', '/tmp/profile.browser-lease', {
        pid: 4242,
        hostname: 'autre-runtime',
        startedAt: '2026-08-21T15:30:00.000Z',
        cmd: 'ig:inbound:run --loop',
      }),
    });
    const result = await runAutoReplyCycle(cycleInput('LIVE'), { rail });
    const turnResult = result.turns.at(-1)!;
    expect(turnResult.outcome).toBe('BROWSER_PROFILE_BUSY');
    expect(turnResult.externalEffectAttempted).toBe(false);
    expect(rail.hookCalls).toBe(0);

    // Et le plan REPART : c'est un report, pas une fermeture.
    const plan = await loadConversationPlan(sql, turnResult.planId!);
    expect(plan?.status).toBe('SKIPPED');
    expect(plan?.externalEffectAttempted).toBe(false);
  });
});

describe('§11 — les salves', () => {
  it('une bulle ABSORBÉE n’est jamais candidate ; seule celle qui CLÔT l’est', async () => {
    const scene = await newProspect();
    const first = await turn(scene, { body: 'j’avais essayé', receivedAt: '2026-08-21T15:00:00.000Z' });
    const last = await turn(scene, {
      body: 'mais ça n’avait rien donné',
      receivedAt: '2026-08-21T15:00:30.000Z',
    });
    await activateAt(FRONTIER_AT);

    const activation = await loadActiveAutoReplyActivation(sql);
    const ids = (await loadAutoReplyCandidates(sql, { frontierAt: activation!.frontierAt })).map(
      (row) => row.inboundMessageId,
    );
    // Le premier n'est pas encore ABSORBÉ en base — il est simplement DÉPASSÉ.
    // Les deux exclusions se recouvrent, et c'est voulu : la seconde protège
    // même quand la première n'a pas encore eu lieu.
    expect(ids).toContain(last);
    expect(ids).not.toContain(first);

    const facts = await loadAutoReplyEligibilityFacts(sql, first, activation!.frontierAt);
    expect(assessAutoReplyEligibility(facts!).eligible).toBe(false);
  });

  it('une bulle arrivée APRÈS l’inscription périme le plan — aucun effet', async () => {
    const scene = await newProspect();
    await turn(scene, { body: 'j’avais essayé', receivedAt: FRESH_AT });
    await activateAt(FRONTIER_AT);
    await openTheGates();

    // Un premier cycle inscrit l'intention mais n'exécute pas (mode PLAN).
    const planned = await runAutoReplyCycle(cycleInput('PLAN'), { rail: null });
    const planId = planned.turns.at(-1)?.planId;
    expect(planId).toBeTruthy();

    // Puis une bulle arrive.
    await turn(scene, { body: 'enfin je crois', receivedAt: '2026-08-21T15:10:00.000Z' });

    const rail = new FakeReplyRail();
    const after = await runAutoReplyCycle(cycleInput('LIVE'), { rail });
    // Le tour NEUF est celui qu'on regarde ; l'ancien n'est plus candidat.
    expect(after.turns.some((row) => row.planId === planId && row.externalEffectAttempted)).toBe(false);
    const stale = await loadConversationPlan(sql, planId!);
    expect(stale?.externalEffectAttempted).toBe(false);
  });
});

// ===========================================================================
// §3 / §7 — LES PORTES DE SÛRETÉ ET LES PLAFONDS
// ===========================================================================

describe('§3 — l’arrêt global et les portes de contenu', () => {
  it('l’arrêt global ARMÉ ne laisse passer aucun effet', async () => {
    const scene = await newProspect();
    await turn(scene, { body: 'ah oui je vois', receivedAt: FRESH_AT });
    await activateAt(FRONTIER_AT);
    // L'arrêt est armé par le `beforeEach` : on ne l'ouvre pas.

    const rail = new FakeReplyRail();
    const result = await runAutoReplyCycle(cycleInput('LIVE'), { rail });
    const last = result.turns.at(-1)!;
    expect(last.outcome).toBe('HARD_BLOCKED_SAFETY');
    expect(last.reasonCode).toBe('BLOCKED_KILL_SWITCH');
    expect(rail.hookCalls).toBe(0);
    expect(result.effects).toBe(0);
  });

  it('une demande d’ARRÊT ferme la conversation, définitivement, sans effet', async () => {
    const scene = await newProspect();
    await turn(scene, {
      body: 'arrête de me contacter s’il te plaît',
      category: 'UNSUBSCRIBE',
      receivedAt: FRESH_AT,
      draftBody: null,
    });
    await activateAt(FRONTIER_AT);
    await openTheGates();

    const rail = new FakeReplyRail();
    const result = await runAutoReplyCycle(cycleInput('LIVE'), { rail });
    const last = result.turns.at(-1)!;
    expect(last.outcome).toBe('CONVERSATION_STOPPED');
    expect(rail.hookCalls).toBe(0);

    const plans = await plansFor(scene);
    expect(plans[0]?.decision).toBe('TERMINAL_STOP');
    expect(plans[0]?.status).toBe('CANCELLED');
  });

  it('une escalade humaine est INSCRITE et VISIBLE, sans aucun effet', async () => {
    const scene = await newProspect();
    await turn(scene, {
      // La demande que ce dépôt ne peut PAS satisfaire seul : le prix APRÈS
      // l'essai n'est écrit nulle part, et `resolvePriceSubject` le dit.
      body: 'Et après les 7 jours ça coûte combien par mois ?',
      category: 'QUESTION',
      receivedAt: FRESH_AT,
      draftBody: null,
    });
    await activateAt(FRONTIER_AT);
    await openTheGates();

    const rail = new FakeReplyRail();
    const result = await runAutoReplyCycle(cycleInput('LIVE'), { rail });
    const last = result.turns.at(-1)!;
    expect(last.outcome).toBe('HUMAN_ESCALATION');
    expect(rail.hookCalls).toBe(0);

    const status = await loadAutoReplyStatus(sql, config, { root: process.cwd(), now: NOW });
    const escalation = status.escalations.find((row) => row.prospectId === scene.prospect.prospectId);
    expect(escalation).toBeDefined();
    expect(escalation?.inboundText).toContain('7 jours');
    expect(escalation?.reason).toBeTruthy();
    expect(escalation?.gate).toBeTruthy();
  });
});

describe('§7 — un « pas encore » n’est jamais inscrit', () => {
  it('une salve OUVERTE n’inscrit aucun plan, et le tour reste candidat', async () => {
    // Le défaut que ce runtime referme : `AUTO_REPLY_SKIP` s'inscrit en
    // CANCELLED, statut absorbant, sous une clé que rien ne fait changer. Un
    // « la salve n'est pas close » inscrit gèlerait le tour POUR TOUJOURS —
    // et en production la relève passe toutes les cinq minutes, exactement la
    // durée du silence de salve.
    const scene = await newProspect();
    const inboundId = await turn(scene, { body: 'ah oui je vois', receivedAt: FRESH_AT });
    await activateAt(FRONTIER_AT);
    await openTheGates();

    // `now` juste après le message : la salve n'est pas encore close.
    const tooEarly = {
      ...cycleInput('LIVE'),
      now: (): Date => new Date('2026-08-21T15:00:10.000Z'),
    };
    const rail = new FakeReplyRail();
    const first = await runAutoReplyCycle(tooEarly, { rail });
    const early = first.turns.at(-1)!;
    expect(early.outcome).toBe('DEFERRED_NOT_YET');
    expect(early.planId).toBeNull();
    expect(await plansFor(scene)).toHaveLength(0);
    expect(rail.hookCalls).toBe(0);

    // Et le MÊME tour, la salve close, redevient éligible.
    const later = await runAutoReplyCycle(cycleInput('LIVE'), { rail: new FakeReplyRail() });
    const settled = later.turns.find((row) => row.inboundMessageId === inboundId)!;
    expect(settled.outcome).toBe('AUTO_REPLIED');
    expect(settled.externalEffectAttempted).toBe(true);
  });
});

// ===========================================================================
// §10 — CRASH ET IDEMPOTENCE
// ===========================================================================

describe('§10 — un effet tenté ne se rejoue JAMAIS', () => {
  it('après un envoi prouvé, le tour n’est plus candidat', async () => {
    const scene = await newProspect();
    const inboundId = await turn(scene, { body: 'ah oui je vois', receivedAt: FRESH_AT });
    await activateAt(FRONTIER_AT);
    await openTheGates();

    const rail = new FakeReplyRail();
    const first = await runAutoReplyCycle(cycleInput('LIVE'), { rail });
    expect(first.sent).toBe(1);
    expect(rail.hookCalls).toBe(1);

    const activation = await loadActiveAutoReplyActivation(sql);
    const ids = (await loadAutoReplyCandidates(sql, { frontierAt: activation!.frontierAt })).map(
      (row) => row.inboundMessageId,
    );
    expect(ids).not.toContain(inboundId);

    const again = new FakeReplyRail();
    const second = await runAutoReplyCycle(cycleInput('LIVE'), { rail: again });
    expect(second.effects).toBe(0);
    expect(again.hookCalls).toBe(0);
  });

  it('un crash APRÈS la réservation laisse AMBIGUOUS — terminal, jamais rejoué', async () => {
    const scene = await newProspect();
    const inboundId = await turn(scene, { body: 'ah oui je vois', receivedAt: FRESH_AT });
    await activateAt(FRONTIER_AT);
    await openTheGates();

    const rail = new FakeReplyRail({ throwAfterHook: new Error('navigateur tué après le clic') });
    const result = await runAutoReplyCycle(cycleInput('LIVE'), { rail });
    const last = result.turns.at(-1)!;
    expect(last.outcome).toBe('DELIVERY_AMBIGUOUS');
    expect(last.externalEffectAttempted).toBe(true);
    expect(rail.hookCalls).toBe(1);

    const plan = await loadConversationPlan(sql, last.planId!);
    expect(plan?.status).toBe('AMBIGUOUS');
    expect(plan?.externalEffectAttempted).toBe(true);

    const activation = await loadActiveAutoReplyActivation(sql);
    const ids = (await loadAutoReplyCandidates(sql, { frontierAt: activation!.frontierAt })).map(
      (row) => row.inboundMessageId,
    );
    expect(ids).not.toContain(inboundId);

    const again = new FakeReplyRail();
    const second = await runAutoReplyCycle(cycleInput('LIVE'), { rail: again });
    expect(again.hookCalls).toBe(0);
    expect(second.effects).toBe(0);
  });

  it('un crash AVANT la réservation repose le plan — il repartira, sans effet', async () => {
    const scene = await newProspect();
    await turn(scene, { body: 'ah oui je vois', receivedAt: FRESH_AT });
    await activateAt(FRONTIER_AT);
    await openTheGates();

    const rail = new FakeReplyRail({ throwBeforeHook: new Error('page jamais chargée') });
    const result = await runAutoReplyCycle(cycleInput('LIVE'), { rail });
    const last = result.turns.at(-1)!;
    expect(last.externalEffectAttempted).toBe(false);
    expect(rail.hookCalls).toBe(0);

    const plan = await loadConversationPlan(sql, last.planId!);
    expect(plan?.externalEffectAttempted).toBe(false);
    expect(plan?.status).not.toBe('SENT');
  });
});

// ===========================================================================
// §7 — LES PLAFONDS, LA FENÊTRE, LA CADENCE
// ===========================================================================

describe('§7 — les plafonds Instagram restent intégralement devant', () => {
  /** Deux conversations fraîches, prêtes à recevoir une réponse. */
  async function twoFreshTurns(): Promise<readonly [string, string]> {
    const alpha = await newProspect();
    const beta = await newProspect();
    // Deux instants DISTINCTS : les candidats sont ordonnés par heure de
    // réception, et à heure égale c'est un uuid qui tranche — ce qui rendrait
    // ces scénarios non déterministes.
    const first = await turn(alpha, { body: 'ah oui je vois', receivedAt: FRESH_AT });
    const second = await turn(beta, { body: 'ah oui je vois', receivedAt: '2026-08-21T15:01:00.000Z' });
    await activateAt(FRONTIER_AT);
    await openTheGates();
    return [first, second];
  }

  it('la CADENCE de quinze minutes borne le second tour du même cycle', async () => {
    // Aucune configuration n'est touchée : c'est l'espacement du dépôt, celui
    // que la production applique, et il mord au deuxième message.
    const [first, second] = await twoFreshTurns();
    const rail = new FakeReplyRail();
    const result = await runAutoReplyCycle(cycleInput('LIVE', 5), { rail });

    expect(outcomeFor(result, first)).toBe('AUTO_REPLIED');
    expect(outcomeFor(result, second)).toBe('TEMPORARILY_BLOCKED_COOLDOWN');
    expect(result.effects).toBe(1);
    // Le second n'a PAS ouvert de navigateur : le crochet refuse avant.
    expect(rail.hookCalls).toBe(1);
  });

  it('le plafond JOURNALIER bloque, sans corrompre l’état de la conversation', async () => {
    const [first, second] = await twoFreshTurns();
    const capped = {
      ...cycleInput('LIVE', 5),
      config: { ...config, caps: { ...config.caps, dailySentCap: 1, minSendIntervalMs: 0 } },
    };
    const rail = new FakeReplyRail();
    const result = await runAutoReplyCycle(capped, { rail });

    expect(outcomeFor(result, first)).toBe('AUTO_REPLIED');
    expect(outcomeFor(result, second)).toBe('TEMPORARILY_BLOCKED_CAP');

    // Et l'état reste REPRENABLE : rien n'a été fermé, aucun effet tenté.
    const blocked = result.turns.find((row) => row.inboundMessageId === second)!;
    expect(blocked.externalEffectAttempted).toBe(false);
    const plan = await loadConversationPlan(sql, blocked.planId!);
    expect(plan?.status).toBe('SKIPPED');
    expect(plan?.externalEffectAttempted).toBe(false);
  });

  it('la FENÊTRE se juge sur l’horloge du CYCLE, pas sur celle du mur', async () => {
    /**
     * Le garde-fou d'un défaut réel : `runAutoReplyCycle` recevait une horloge,
     * la passait à l'évaluation du message, et l'OUBLIAIT en appelant
     * `executeConversationReply` — dont le crochet pré-effet relisait donc la
     * fenêtre d'envoi sur l'heure réelle. En production les deux valent
     * `new Date()` et l'écart ne se voit pas ; sous horloge injectée, dix
     * scénarios de ce fichier ne passaient qu'entre 9 h et 20 h un jour ouvré.
     *
     * Ce test échoue DANS l'autre sens : un dimanche injecté doit refuser,
     * quelle que soit l'heure qu'il est vraiment. Avec les scénarios voisins —
     * qui, eux, exigent un envoi sous une horloge ouvrée — la paire couvre les
     * deux moitiés de la semaine, et aucune régression ne peut se cacher dans
     * l'heure à laquelle on lance les tests.
     */
    const [first] = await twoFreshTurns();
    const SUNDAY = new Date('2026-08-23T12:00:00.000Z'); // dimanche, hors fenêtre
    const closed = { ...cycleInput('LIVE', 5), now: (): Date => SUNDAY };
    const rail = new FakeReplyRail();
    const result = await runAutoReplyCycle(closed, { rail });

    expect(outcomeFor(result, first)).toBe('TEMPORARILY_BLOCKED_WINDOW');
    // Un refus de fenêtre n'a rien tenté : c'est un report, pas un échec.
    const blocked = result.turns.find((row) => row.inboundMessageId === first)!;
    expect(blocked.externalEffectAttempted).toBe(false);
    // Le rail n'a même pas été sollicité : un refus de fenêtre sort AVANT le
    // navigateur, donc avant `sendThreadReply`.
    expect(rail.calls).toBe(0);
    expect(rail.hookCalls).toBe(0);
  });

  it('le plafond HORAIRE bloque de la même façon', async () => {
    const [first, second] = await twoFreshTurns();
    const capped = {
      ...cycleInput('LIVE', 5),
      config: { ...config, caps: { ...config.caps, hourlySentCap: 1, minSendIntervalMs: 0 } },
    };
    const rail = new FakeReplyRail();
    const result = await runAutoReplyCycle(capped, { rail });
    expect(outcomeFor(result, first)).toBe('AUTO_REPLIED');
    expect(outcomeFor(result, second)).toBe('TEMPORARILY_BLOCKED_CAP');
  });

  it('hors FENÊTRE, rien ne part — et la reprise a une date', async () => {
    const [first] = await twoFreshTurns();
    const closed = {
      ...cycleInput('LIVE', 5),
      config: {
        ...config,
        schedule: {
          ...config.schedule,
          windows: [{ days: [1, 2, 3, 4, 5], startMinute: 0, endMinute: 1 }],
        },
      },
    };
    const rail = new FakeReplyRail();
    const result = await runAutoReplyCycle(closed, { rail });
    expect(outcomeFor(result, first)).toBe('TEMPORARILY_BLOCKED_WINDOW');
    expect(rail.hookCalls).toBe(0);
    expect(result.effects).toBe(0);

    // Le plan est REPORTÉ, pas fermé : la fenêtre rouvre toute seule.
    const blocked = result.turns.find((row) => row.inboundMessageId === first)!;
    const plan = await loadConversationPlan(sql, blocked.planId!);
    expect(plan?.status).toBe('SKIPPED');
    expect(plan?.externalEffectAttempted).toBe(false);
  });

  it('un tour bloqué par un plafond redevient exécutable quand le plafond cesse', async () => {
    const [first] = await twoFreshTurns();
    const capped = {
      ...cycleInput('LIVE', 5),
      config: { ...config, caps: { ...config.caps, dailySentCap: 0 } },
    };
    const blocked = await runAutoReplyCycle(capped, { rail: new FakeReplyRail() });
    expect(outcomeFor(blocked, first)).toBe('TEMPORARILY_BLOCKED_CAP');

    // Le plafond cesse — c'est le seul changement. Le tour repart, tout seul,
    // par la reprise du registre : personne n'a débloqué de plan à la main.
    // La borne de reprise, ramenée dans le passé de l'horloge du SCÉNARIO —
    // pas de celle de la base : `assessPlanReclaim` lit l'horloge qu'on lui
    // donne, et ces tours vivent le 21 août.
    await sql.query(
      `update hermes_conversation_plans set not_before = timestamptz '2026-08-21T15:05:00Z'
        where status = 'SKIPPED'`,
    );
    const rail = new FakeReplyRail();
    const released = await runAutoReplyCycle(cycleInput('LIVE', 5), { rail });
    expect(outcomeFor(released, first)).toBe('AUTO_REPLIED');
    expect(rail.hookCalls).toBe(1);
  });
});

// ===========================================================================
// §11 — LA SALVE, LUE COMME UN SEUL TOUR
// ===========================================================================

describe('§11 — plusieurs bulles, un seul tour logique', () => {
  it('trois bulles ne produisent qu’UN effet, sur la dernière', async () => {
    const scene = await newProspect();
    const a = await turn(scene, { body: 'j’avais essayé les pubs', receivedAt: '2026-08-21T15:00:00.000Z' });
    const b = await turn(scene, { body: 'mais ça n’a rien donné', receivedAt: '2026-08-21T15:00:20.000Z' });
    const c = await turn(scene, { body: 'enfin surtout des curieux', receivedAt: '2026-08-21T15:00:40.000Z' });
    await activateAt(FRONTIER_AT);
    await openTheGates();

    const rail = new FakeReplyRail();
    const result = await runAutoReplyCycle(cycleInput('LIVE', 5), { rail });

    expect(result.effects).toBe(1);
    expect(rail.hookCalls).toBe(1);
    expect(outcomeFor(result, c)).toBe('AUTO_REPLIED');
    // Les deux premières n'ont même pas été regardées : la requête de sélection
    // ne rend que le dernier message de chaque conversation.
    expect(result.turns.map((row) => row.inboundMessageId)).not.toContain(a);
    expect(result.turns.map((row) => row.inboundMessageId)).not.toContain(b);
  });

  it('une demande d’ARRÊT éclatée sur deux bulles ferme quand même la conversation', async () => {
    // La salve est lue ENTIÈRE : « me recontacte » d'un côté, « plus » de
    // l'autre ne doit pas passer entre les mailles.
    const scene = await newProspect();
    await turn(scene, { body: 'écoute', receivedAt: '2026-08-21T15:00:00.000Z', draftBody: null });
    await turn(scene, {
      body: 'ne me recontacte plus s’il te plaît',
      category: 'UNSUBSCRIBE',
      receivedAt: '2026-08-21T15:00:20.000Z',
      draftBody: null,
    });
    await activateAt(FRONTIER_AT);
    await openTheGates();

    const rail = new FakeReplyRail();
    const result = await runAutoReplyCycle(cycleInput('LIVE', 5), { rail });
    expect(result.effects).toBe(0);
    expect(rail.hookCalls).toBe(0);
    expect(result.turns.at(-1)?.outcome).toBe('CONVERSATION_STOPPED');
  });
});

// ===========================================================================
// §7 — LE BUDGET DE DÉPLOIEMENT
// ===========================================================================

describe('§7 — le déploiement borné', () => {
  it('un budget de N s’épuise exactement après N effets, sans en produire un de plus', async () => {
    const alpha = await newProspect();
    const beta = await newProspect();
    await turn(alpha, { body: 'ah oui je vois', receivedAt: FRESH_AT });
    await turn(beta, { body: 'ah oui je vois', receivedAt: FRESH_AT });
    await activateAt(FRONTIER_AT, 1);
    await openTheGates();

    const rail = new FakeReplyRail();
    const first = await runAutoReplyCycle(cycleInput('LIVE', 5), { rail });
    expect(first.effects).toBe(1);

    const again = new FakeReplyRail();
    const second = await runAutoReplyCycle(cycleInput('LIVE', 5), { rail: again });
    expect(second.outcome).toBe('ROLLOUT_BUDGET_EXHAUSTED');
    expect(again.hookCalls).toBe(0);
    expect(second.effects).toBe(0);
  });
});

// ===========================================================================
// §10 — LA SENTINELLE DE RÉVISION
// ===========================================================================

describe('§10 — un long-vivant ne répond pas sous du code périmé', () => {
  it('la boucle s’arrête AVANT un cycle quand la révision a bougé', async () => {
    const scene = await newProspect();
    await turn(scene, { body: 'ah oui je vois', receivedAt: FRESH_AT });
    await activateAt(FRONTIER_AT);
    await openTheGates();

    let drifted = false;
    const rail = new FakeReplyRail();
    const report = await runAutoReplyRuntime(
      cycleInput('LIVE'),
      { rail },
      {
        signal: new AbortController().signal,
        maxCycles: 5,
        idlePollMs: 1_000,
        sleep: async () => {
          drifted = true;
        },
        codeRevision: {
          startedAt: 'a'.repeat(40),
          current: () => (drifted ? 'b'.repeat(40) : 'a'.repeat(40)),
          hasDrifted: () => drifted,
        },
      },
    );
    expect(report.stoppedBy).toBe('CODE_REVISION_CHANGED');
    // Un seul cycle a tourné : le second a été refusé AVANT d'agir.
    expect(report.cycles).toHaveLength(1);
  });

  it('un SIGTERM arrête la boucle sans interrompre le cycle en cours', async () => {
    await activateAt(FRONTIER_AT);
    const controller = new AbortController();
    const report = await runAutoReplyRuntime(
      cycleInput('PLAN'),
      { rail: null },
      {
        signal: controller.signal,
        maxCycles: 10,
        idlePollMs: 1_000,
        sleep: async () => {
          controller.abort();
        },
      },
    );
    expect(report.stoppedBy).toBe('ABORTED');
    expect(report.cycles).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

async function plansFor(scene: Scene): Promise<
  readonly { readonly id: string; readonly decision: string; readonly status: string }[]
> {
  return sql.query(
    `select id, decision, status from hermes_conversation_plans
      where prospect_id = $1 order by created_at desc`,
    [scene.prospect.prospectId],
  );
}

/** L'issue du tour qui porte CE message, et lui seul. */
function outcomeFor(
  result: Awaited<ReturnType<typeof runAutoReplyCycle>>,
  inboundMessageId: string,
): string | undefined {
  return result.turns.find((row) => row.inboundMessageId === inboundMessageId)?.outcome;
}
