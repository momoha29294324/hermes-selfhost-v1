/**
 * HERMES-FIRST-TOUCH-BOUNDED-ACTIVATION-R1 — les deux défauts que le canari
 * RED du 25 août 2026 a révélés, et qui ne doivent jamais revenir.
 *
 * ---------------------------------------------------------------------------
 * 1. Prévisualiser détruisait la cible
 * ---------------------------------------------------------------------------
 * Le rail autonome n'armait une autorisation d'effet que lorsqu'il n'en
 * existait AUCUNE (`existing === null`), et il révoque la sienne à la fin de
 * chaque processus. Toute exécution qui armait sans consommer laissait donc une
 * ligne `REVOKED` que rien ne remplaçait, et le manifeste devenait
 * définitivement inenvoyable. `--preview` fait exactement cela par
 * construction : il arme, ne clique pas, révoque en sortant.
 *
 * Sur la seule cible réellement éligible du dépôt, un aperçu a suffi à rendre
 * l'envoi impossible — deux tentatives live l'ont ensuite confirmé, à
 * l'identique, sur `IG_CANARY_REVOKED`.
 *
 * ---------------------------------------------------------------------------
 * 2. `--max-effects` bornait un CYCLE, pas un déploiement
 * ---------------------------------------------------------------------------
 * En `--loop`, trois effets étaient autorisés, puis trois de plus, sans fin, et
 * le compteur vivait en mémoire — donc repartait à zéro à chaque redémarrage.
 * Un opérateur qui lisait « max-effects 3 » croyait borner un déploiement.
 *
 * Les scénarios ci-dessous mesurent les deux réparations SANS qu'un seul DM ne
 * parte : le rail est un double injecté.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { loadInstagramRail } from '@/lib/config/load';
import type { InstagramRailConfig } from '@/lib/config/schema';
import type { Sql } from '@/lib/db/sql';
import { setKillSwitch } from '@/lib/instagram/safety';
import { AUTONOMOUS_POLICY_VERSION } from '@/lib/instagram/autonomousPolicy';
import { AUTONOMOUS_RAIL_ACTOR, runAutonomousDispatch } from '@/lib/instagram/autonomousDispatch';
import { runAutonomousLiveWorker } from '@/lib/instagram/autonomousLiveWorker';
import {
  isReplaceableCanaryAuthorization,
  loadCanaryForManifest,
  revokeCanaryAuthorization,
} from '@/lib/instagram/canary';
import {
  activateFirstTouch,
  assessFirstTouchBudget,
  countFirstTouchActivationEffects,
  loadActiveFirstTouchActivation,
  revokeFirstTouchActivation,
  type FirstTouchActivation,
} from '@/lib/instagram/firstTouchActivation';
import { loadInstagramJob } from '@/lib/instagram/queue';
import { frozenClock, IG_WEEKDAY_IN_WINDOW } from './support/instagramClock';
import { FakeLiveRail, seedEligibleProspect } from './support/autonomousFixtures';

const ROOT = resolve(__dirname, '..');

/** Le CODE d'un fichier, commentaires retirés. Voir les tests de source plus bas. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    })
    .join('\n');
}

let sql: Sql;
let dir: string;
let campaignId: string;
let config: InstagramRailConfig;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-ig-ft-budget-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);
  config = loadInstagramRail();
  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
    ['example-ft-budget-test', 'Test', 'example-services', '{}'],
  );
  campaignId = rows[0]!.id;
});

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await sql.query('update ig_live_canary_authorizations set reserved_job_id = null, consumed_job_id = null');
  for (const table of [
    'ig_job_events',
    'ig_identity_checks',
    'ig_enqueue_decisions',
    'ig_dispatch_jobs',
    'ig_live_canary_authorizations',
    'ig_browser_sessions',
    'ig_kill_switch',
    'r6b_dispatch_attempts',
    'r6b_prospect_state_transitions',
    'r6b_prospect_outreach_states',
    'outreach_events',
    'do_not_contact',
    'prospect_icp_assessments',
    'prospect_audience_observations',
    'r6b_dispatch_manifests',
    'r6b_batch_votes',
    'r6b_batch_items',
    'r6b_batches',
    'prospect_evidence',
    'prospects',
    'hermes_firsttouch_activations',
  ]) {
    await sql.query(`delete from ${table}`);
  }
  await setKillSwitch(sql, {
    engaged: false,
    setBy: 'Operator Example',
    reason: 'suite HERMES-FIRST-TOUCH-BOUNDED-ACTIVATION-R1 — transport simulé',
  });
});

async function arm(maxEffects: number | null): Promise<FirstTouchActivation> {
  return activateFirstTouch(sql, {
    activatedBy: 'Operator Example',
    reason: 'canari borné',
    policyVersion: AUTONOMOUS_POLICY_VERSION,
    maxEffects,
  });
}

async function ready(handle: string): Promise<{ manifestId: string; jobId: string }> {
  const { batchSlug } = await seedEligibleProspect(sql, { campaignId, handle, root: ROOT });
  const report = await runAutonomousDispatch(sql, {
    batchSlug,
    apply: true,
    enqueuedBy: AUTONOMOUS_RAIL_ACTOR,
  });
  const outcome = report.outcomes[0];
  expect(outcome?.status, outcome?.reason ?? 'aucun résultat').toBe('QUEUED');
  return { manifestId: outcome!.manifestId!, jobId: outcome!.jobId! };
}

/**
 * Une note sur ce que ces scénarios NE peuvent pas mesurer, et pourquoi.
 *
 * L'espacement de quinze minutes et les plafonds vivent dans `evaluateSafety`,
 * qui est relu AVANT le budget. Après un envoi, le motif d'arrêt visible est
 * donc la CADENCE, pas le budget — jusqu'à ce que la cadence s'écoule, après
 * quoi le budget reprend la main. C'est sûr dans les deux cas (aucun effet ne
 * part), mais cela veut dire qu'un scénario post-envoi ne peut pas affirmer le
 * `stopCode` du budget sans mesurer la cadence en croyant mesurer autre chose.
 *
 * Les scénarios ci-dessous affirment donc la PROPRIÉTÉ — zéro effet, budget
 * refermé, compte lu en base — et réservent l'affirmation du `stopCode` au seul
 * cas où rien ne peut le masquer : un budget nul, sans envoi préalable.
 */
function run(
  rail: FakeLiveRail,
  over: { maxEffects?: number; previewOnly?: boolean; workerId?: string; now?: Date } = {},
) {
  return runAutonomousLiveWorker(
    {
      sql,
      config,
      workerId: over.workerId ?? 'test-ft-budget',
      maxEffects: over.maxEffects ?? 5,
      previewOnly: over.previewOnly ?? false,
      now: frozenClock(over.now ?? IG_WEEKDAY_IN_WINDOW),
    },
    { rail },
  );
}

// ===========================================================================
// 1 — APERÇU puis ENVOI
// ===========================================================================

describe('un aperçu ne condamne plus sa cible', () => {
  it('APERÇU → LIVE : le même manifeste part, là où il était définitivement bloqué', async () => {
    await arm(3);
    const { manifestId, jobId } = await ready('atelier_demo_apercu');

    // 1. L'aperçu parcourt tout le chemin. Il arme une autorisation et la
    //    révoque en sortant : c'est SON comportement, inchangé.
    const preview = await run(new FakeLiveRail(), { previewOnly: true });
    expect(preview.effects).toBe(0);

    // La révocation de fin de processus, telle que le runtime la fait :
    // « une autorisation d'effet ne survit pas au processus qui l'a armée ».
    // Elle vit dans l'enveloppe du runtime, pas dans le worker — on la rejoue
    // ici pour reproduire EXACTEMENT la séquence du 25 août.
    const armed = await loadCanaryForManifest(sql, manifestId);
    expect(armed?.state).toBe('ARMED');
    await revokeCanaryAuthorization(sql, {
      id: armed!.id,
      revokedBy: 'hermes-autonomous-rail',
      reason: 'fin du runtime autonome — une autorisation d’effet ne survit pas au processus qui l’a armée',
    });

    const afterPreview = await loadCanaryForManifest(sql, manifestId);
    expect(afterPreview).not.toBeNull();
    expect(afterPreview!.state).toBe('REVOKED');
    expect(afterPreview!.externalAttemptsUsed).toBe(0);

    // 2. LE point du correctif : le live qui suit doit ARMER UNE NEUVE plutôt
    //    que buter sur la morte. Avant, il rendait IG_CANARY_REVOKED.
    const rail = new FakeLiveRail();
    const live = await run(rail);

    expect(live.outcomes.map((o) => o.reasonCode)).not.toContain('IG_CANARY_REVOKED');
    expect(live.effects).toBe(1);
    expect(rail.effectsStarted).toBe(1);

    const job = await loadInstagramJob(sql, jobId);
    expect(job?.status).toBe('SENT');
  });

  it('une autorisation CONSOMMÉE n’est JAMAIS remplacée — un effet a eu lieu', async () => {
    await arm(3);
    const { manifestId, jobId } = await ready('atelier_demo_consommee');

    const first = await run(new FakeLiveRail());
    expect(first.effects).toBe(1);
    expect((await loadInstagramJob(sql, jobId))?.status).toBe('SENT');

    const consumed = await loadCanaryForManifest(sql, manifestId);
    expect(consumed!.state).toBe('CONSUMED');
    // La ligne de sûreté du correctif, lue directement.
    expect(isReplaceableCanaryAuthorization(consumed!)).toBe(false);

    // Un second passage ne réarme pas et ne renvoie rien.
    const rail = new FakeLiveRail();
    const again = await run(rail);
    expect(again.effects).toBe(0);
    expect(rail.effectsStarted).toBe(0);
  });

  it('le prédicat de remplacement est fail-closed sur le compteur d’essais', () => {
    const base = {
      id: 'a',
      manifestId: 'm',
      prospectId: 'p',
      action: 'first_touch_dm' as const,
      transport: 'instagram_dm' as const,
      expectedHandle: 'h',
      approvedTextSha256: 'x',
      transportPayloadSha256: 'y',
      armedBy: 'rail',
      armedByKind: 'AUTONOMOUS_POLICY' as const,
      policyVersion: AUTONOMOUS_POLICY_VERSION,
      reason: 'r',
      maxExternalAttempts: 1,
      externalAttemptsUsed: 0,
      consumedAt: null,
    };
    const make = (over: Record<string, unknown>) =>
      ({ ...base, ...over }) as unknown as Parameters<typeof isReplaceableCanaryAuthorization>[0];

    expect(isReplaceableCanaryAuthorization(make({ state: 'REVOKED' }))).toBe(true);
    expect(isReplaceableCanaryAuthorization(make({ state: 'EXPIRED' }))).toBe(true);
    // Vivantes : on les UTILISE, on ne les remplace pas.
    expect(isReplaceableCanaryAuthorization(make({ state: 'ARMED' }))).toBe(false);
    expect(isReplaceableCanaryAuthorization(make({ state: 'RESERVED' }))).toBe(false);
    // Un effet a eu lieu : jamais.
    expect(isReplaceableCanaryAuthorization(make({ state: 'CONSUMED' }))).toBe(false);
    expect(isReplaceableCanaryAuthorization(make({ state: 'REVOKED', externalAttemptsUsed: 1 }))).toBe(false);
    expect(
      isReplaceableCanaryAuthorization(make({ state: 'REVOKED', consumedAt: '2026-08-25T00:00:00Z' })),
    ).toBe(false);
  });
});

// ===========================================================================
// 2 — LE BUDGET DURABLE
// ===========================================================================

describe('le budget est DURABLE — cycles et redémarrages compris', () => {
  it('sans activation, le rail est au repos : aucun effet, aucune ouverture', async () => {
    await ready('atelier_demo_repos');
    const rail = new FakeLiveRail();
    const result = await run(rail);

    expect(result.stopCode).toBe('NOT_ACTIVATED');
    expect(result.effects).toBe(0);
    expect(rail.effectsStarted).toBe(0);
  });

  it('budget à zéro : le rail s’arrête sur le BUDGET, sans rien ouvrir', async () => {
    // Le seul cas où le motif ne peut être masqué par rien : aucun envoi n'a
    // précédé, donc ni cadence ni plafond n'ont leur mot à dire.
    await arm(0);
    await ready('atelier_demo_zero');

    const rail = new FakeLiveRail();
    const result = await run(rail);

    expect(result.stopCode).toBe('ROLLOUT_BUDGET_EXHAUSTED');
    expect(result.effects).toBe(0);
    expect(rail.effectsStarted).toBe(0);
  });

  it('le compte vit en BASE, donc un worker NEUF hérite du budget déjà dépensé', async () => {
    /**
     * La propriété qui manquait, et la raison d'être de cette table.
     *
     * `--max-effects` comptait en mémoire : un worker neuf repartait à zéro, et
     * redémarrer est le cas NORMAL d'un runtime (crash, sentinelle de révision,
     * reboot). Ici le compte est relu en base à chaque tour, donc un processus
     * qui n'a jamais rien envoyé lui-même voit quand même la dette.
     */
    const activation = await arm(1);
    await ready('atelier_demo_bornee_a');
    await ready('atelier_demo_bornee_b');

    const first = await run(new FakeLiveRail(), { workerId: 'worker-premier' });
    expect(first.effects).toBe(1);

    // Le compte est DÉRIVÉ de la base, pas d'un compteur du processus.
    expect(await countFirstTouchActivationEffects(sql, activation)).toBe(1);
    expect(assessFirstTouchBudget(activation, 1).open).toBe(false);

    // Trois workers NEUFS, chacun avec son propre compteur en mémoire à zéro :
    // aucun ne produit d'effet, parce qu'aucun ne lit sa mémoire.
    for (const workerId of ['worker-neuf-1', 'worker-neuf-2', 'worker-neuf-3']) {
      const rail = new FakeLiveRail();
      const again = await run(rail, { workerId });
      expect(again.effects, workerId).toBe(0);
      expect(rail.effectsStarted, workerId).toBe(0);
    }

    // Et l'activation n'a pas mué : jamais de bascule silencieuse en illimité.
    const live = await loadActiveFirstTouchActivation(sql);
    expect(live?.maxEffects).toBe(1);
    expect(live?.id).toBe(activation.id);
  });

  it('un budget de 2 laisse UN effet restant après le premier — il ne se referme pas trop tôt', async () => {
    const activation = await arm(2);
    await ready('atelier_demo_deux');

    expect(assessFirstTouchBudget(activation, 0).remaining).toBe(2);
    const first = await run(new FakeLiveRail());
    expect(first.effects).toBe(1);

    const used = await countFirstTouchActivationEffects(sql, activation);
    expect(used).toBe(1);
    const verdict = assessFirstTouchBudget(activation, used);
    expect(verdict.open).toBe(true);
    expect(verdict.remaining).toBe(1);
  });

  it('un effet ANTÉRIEUR à la frontière ne consomme pas le budget', async () => {
    // Un premier déploiement dépense son unique effet…
    await arm(1);
    await ready('atelier_demo_frontiere');
    expect((await run(new FakeLiveRail())).effects).toBe(1);
    await revokeFirstTouchActivation(sql, { revokedBy: 'Operator Example', reason: 'fin du premier canari' });

    // …puis un second est armé : sa frontière est postérieure, donc son budget
    // est intact. Sans cela, un déploiement hériterait de la dette du précédent.
    const second = await arm(1);
    expect(await countFirstTouchActivationEffects(sql, second)).toBe(0);
    expect(assessFirstTouchBudget(second, 0).open).toBe(true);
  });

  it('un compte illisible referme — fail-closed', () => {
    const activation = {
      maxEffects: 3,
      frontierAt: '2026-08-25T00:00:00Z',
    } as unknown as FirstTouchActivation;
    expect(assessFirstTouchBudget(activation, -1).open).toBe(false);
    expect(assessFirstTouchBudget(activation, Number.NaN).open).toBe(false);
  });

  it('« sans borne » reste possible, mais il faut l’avoir écrit', async () => {
    const activation = await arm(null);
    expect(activation.maxEffects).toBeNull();
    expect(assessFirstTouchBudget(activation, 99).open).toBe(true);
  });
});

// ===========================================================================
// 3 — CE QUE LE BUDGET NE REMPLACE PAS
// ===========================================================================

describe('les portes existantes restent intégralement devant', () => {
  it('l’arrêt global refuse AVANT le budget — c’est le geste d’un humain', async () => {
    await arm(3);
    await ready('atelier_demo_arret');
    await setKillSwitch(sql, {
      engaged: true,
      setBy: 'Operator Example',
      reason: 'scénario',
    });

    const rail = new FakeLiveRail();
    const result = await run(rail);
    expect(result.stopCode).toBe('BLOCKED_KILL_SWITCH');
    expect(result.effects).toBe(0);
    expect(rail.effectsStarted).toBe(0);
  });

  it('un budget OUVERT ne dit rien des plafonds ni de la fenêtre', () => {
    // Le module de budget ne lit ni plafond, ni fenêtre, ni cadence : un test
    // de source, parce que c'est une séparation de responsabilité qu'une
    // correction pressée effacerait sans le voir.
    //
    // On lit le CODE et pas les commentaires : ces fichiers nomment
    // volontiers ce qu'ils s'interdisent, et une lecture du texte entier
    // confondrait l'interdiction avec son objet.
    const source = code(resolve(ROOT, 'src/lib/instagram/firstTouchActivation.ts'));
    expect(source).not.toContain('evaluateSafety');
    expect(source).not.toContain('evaluateSchedule');
    expect(source).not.toContain('dailySentCap');
    expect(source).not.toContain('minSendInterval');
  });

  it('l’activation ne sait ni envoyer, ni lever l’arrêt global', () => {
    const cli = code(resolve(ROOT, 'src/cli/ig-autonomous-activation.ts'));
    expect(cli).not.toContain('setKillSwitch');
    expect(cli).not.toContain('playwrightRail');
    expect(cli).not.toContain('runAutonomousLiveWorker');
    // Ni antidatage de frontière. On cherche le HANDLER, pas le mot : le
    // message d'erreur de la commande NOMME ces options pour dire qu'elles
    // n'existent pas, et les interdire en toutes lettres punirait la clarté.
    expect(cli).not.toContain("case '--frontier'");
    expect(cli).not.toContain("case '--since'");
    // La frontière n'est jamais écrite par l'appelant : la base la pose.
    expect(cli).not.toContain('frontier_at');
  });
});
