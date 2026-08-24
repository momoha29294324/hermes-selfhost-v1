#!/usr/bin/env tsx
/**
 * HERMES-END-TO-END-CERTIFICATION-R1 — `npm run hermes:certify`.
 *
 * ---------------------------------------------------------------------------
 * Ce que cette commande répond, et ce qu'elle ne répond pas
 * ---------------------------------------------------------------------------
 * Elle répond à UNE question : « le moteur est-il dans l'état où on l'a
 * certifié ? ». Elle ne répond pas à « faut-il envoyer maintenant » — c'est le
 * crochet pré-effet qui décide de cela, immédiatement avant le clic, et rien
 * ici ne peut le remplacer ni le devancer.
 *
 * ---------------------------------------------------------------------------
 * Elle n'envoie RIEN, et ce n'est pas une promesse
 * ---------------------------------------------------------------------------
 * Ce fichier n'importe aucun provider, aucun rail, aucune primitive d'envoi, et
 * n'importe pas `setKillSwitch` — un test le vérifie en lisant cette source.
 * Ses lectures de production sont des `select` ; sa matrice conversationnelle
 * tourne sur une base ÉPHÉMÈRE, jamais sur celle du dépôt.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi la matrice est déléguée à vitest
 * ---------------------------------------------------------------------------
 * Parce qu'une matrice qui vit à deux endroits diverge, et que la copie
 * indulgente finit par servir de preuve. Les scénarios vivent dans
 * `src/lib/certification/`, les tests qui les exécutent dans
 * `tests/certification/`, et `npm run validate` les fait donc tourner à chaque
 * livraison. Cette commande ne les réécrit pas : elle les LANCE et rend leur
 * verdict avec le reste.
 *
 *   npm run hermes:certify              # tout, y compris la matrice
 *   npm run hermes:certify -- --fast    # sans la matrice (contrôles statiques)
 *   npm run hermes:certify -- --json    # sortie machine
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSql } from '@/lib/db';
import { CONVERSATION_POLICY_VERSION } from '@/lib/conversation/autonomy';
import { COMMERCIAL_POLICY_VERSION } from '@/lib/conversation/commercialPolicy';
import { CURRENT_DRAFT_PROMPT_VERSIONS } from '@/lib/conversation/promptVersion';
import { REPLY_CLASSIFIER_PROMPT_VERSION } from '@/lib/replies/classifier';
import {
  assessRolloutBudget,
  countActivationEffects,
  loadActiveAutoReplyActivation,
} from '@/lib/autoreply/activation';
import { loadAutoReplyHeartbeats, isHeartbeatFresh } from '@/lib/autoreply/heartbeat';
import { createCodeRevisionSentinel } from '@/lib/inbound/codeRevision';
import { CONVERSATION_MATRIX } from '@/lib/certification/conversationMatrix';
import {
  REAL_CANARY_CORPUS,
  expandedSemanticCorpus,
} from '@/lib/certification/semanticCorpus';
import { UNCOVERED_CURRENT_REQUESTS } from '@/lib/conversation/currentRequest';
import { NATURALNESS_CLASS } from '@/lib/conversation/naturalness';
import { PRICE_SUBJECT_VERSION } from '@/lib/sales/priceSubject';
import type { Sql } from '@/lib/db/sql';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

type Status = 'PASS' | 'FAIL' | 'AMBER' | 'SKIP';

interface Check {
  readonly group: string;
  readonly name: string;
  readonly status: Status;
  readonly detail: string;
}

const checks: Check[] = [];
function record(group: string, name: string, status: Status, detail: string): void {
  checks.push({ group, name, status, detail });
}

// ---------------------------------------------------------------------------
// 1. Le dépôt
// ---------------------------------------------------------------------------

function certifyRepository(): void {
  const sentinel = createCodeRevisionSentinel(ROOT);
  if (sentinel.startedAt === null) {
    // Fail-open documenté : hors dépôt Git, il n'y a rien à protéger. AMBER et
    // non FAIL, parce que ce n'est pas une anomalie du moteur.
    record('DÉPÔT', 'révision lisible', 'AMBER', 'aucune révision Git lisible depuis ce répertoire');
  } else {
    record('DÉPÔT', 'révision lisible', 'PASS', sentinel.startedAt.slice(0, 12));
  }

  // Les migrations sur disque, comparées à ce que la base a appliqué : voir
  // `certifyDatabase`. Ici, seulement qu'elles existent et se suivent.
  const dir = join(ROOT, 'db', 'migrations');
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const numbers = files.map((name) => Number.parseInt(name.slice(0, 4), 10));
  const gaps = numbers.filter((value, index) => index > 0 && value !== (numbers[index - 1] ?? 0) + 1);
  record(
    'DÉPÔT',
    'migrations sur disque',
    gaps.length === 0 ? 'PASS' : 'FAIL',
    `${String(files.length)} fichier(s), dernière ${files.at(-1) ?? 'aucune'}`,
  );
}

// ---------------------------------------------------------------------------
// 2. Les versions qui décident d'un envoi
// ---------------------------------------------------------------------------

function certifyVersions(): void {
  record(
    'VERSIONS',
    'politique de conversation',
    'PASS',
    CONVERSATION_POLICY_VERSION,
  );
  record('VERSIONS', 'politique commerciale', 'PASS', COMMERCIAL_POLICY_VERSION);
  record('VERSIONS', 'lecture d’un tour (prompt unifié)', 'PASS', REPLY_CLASSIFIER_PROMPT_VERSION);
  record('VERSIONS', 'sujet du prix', 'PASS', PRICE_SUBJECT_VERSION);
  record(
    'VERSIONS',
    'consignes de rédaction',
    'PASS',
    CURRENT_DRAFT_PROMPT_VERSIONS.join(' + '),
  );

  // Les trois versions qu'un plan porte doivent TOUTES être comparées avant
  // l'effet. Lu dans la source, parce que c'est la seule façon de vérifier
  // qu'une comparaison n'a pas disparu d'un refactor.
  const preEffect = readFileSync(join(ROOT, 'src', 'lib', 'conversation', 'preEffect.ts'), 'utf8');
  const compared = [
    ['politique', 'plan.policyVersion !== CONVERSATION_POLICY_VERSION'],
    ['commerciale', 'plan.commercialPolicyVersion !== COMMERCIAL_POLICY_VERSION'],
    ['rédacteur', 'plan.brainVersion !== conversationPromptVersionFor(plan.channel)'],
  ] as const;
  const missing = compared.filter(([, needle]) => !preEffect.includes(needle)).map(([label]) => label);
  record(
    'VERSIONS',
    'les trois versions d’un plan sont comparées avant l’effet',
    missing.length === 0 ? 'PASS' : 'FAIL',
    missing.length === 0 ? 'politique + commerciale + rédacteur' : `manquante(s) : ${missing.join(', ')}`,
  );

  // HERMES-SEMANTIC-GROUNDING-R1 — le CADRE d'énonciation borne l'escalade.
  //
  // Lu dans la source, comme les comparaisons de version ci-dessus, et pour la
  // même raison : c'est la seule façon de vérifier qu'un refactor n'a pas fait
  // disparaître la condition. Sans elle, « mes clients demandaient le prix »
  // redevient une demande de prix.
  const commercial = readFileSync(
    join(ROOT, 'src', 'lib', 'conversation', 'commercialPolicy.ts'),
    'utf8',
  );
  record(
    'VERSIONS',
    'une demande RAPPORTÉE n’escalade pas',
    commercial.includes('frameEngages(finding.frame) && finding.reason !== null') ? 'PASS' : 'FAIL',
    'firstEscalatingDemand lit le cadre avant le motif',
  );

  // La lecture du modèle ne sait qu'AJOUTER une escalade. La borne est la
  // liste des sujets NON couverts : si elle s'élargissait à un sujet couvert,
  // un fait déjà écrit se remettrait à faire attendre un humain.
  record(
    'VERSIONS',
    'la lecture du modèle ne peut qu’ajouter une escalade',
    commercial.includes('if (!UNCOVERED_CURRENT_REQUESTS.has(topic)) return null;') ? 'PASS' : 'FAIL',
    `${String(UNCOVERED_CURRENT_REQUESTS.size)} sujets non couverts`,
  );

  // Les quatre constats de naturalité qui refusent un tour sont ceux qui
  // portent une règle écrite ailleurs. Les autres ont déjà coûté leur
  // réécriture ; les laisser refuser remettrait des tours justes en silence.
  const policyCodes = Object.entries(NATURALNESS_CLASS)
    .filter(([, klass]) => klass === 'POLICY')
    .map(([code]) => code)
    .sort();
  record(
    'VERSIONS',
    'les constats qui REFUSENT un tour',
    policyCodes.length === 4 ? 'PASS' : 'FAIL',
    policyCodes.join(', '),
  );

  // Le rail autonome doit lire le brouillon de la consigne COURANTE.
  const assessment = readFileSync(join(ROOT, 'src', 'lib', 'conversation', 'assessment.ts'), 'utf8');
  record(
    'VERSIONS',
    'le rail juge le texte de CE tour',
    assessment.includes('loadDraftForAnalysisVersion(') && !/loadDraftForAnalysis\(/.test(assessment)
      ? 'PASS'
      : 'FAIL',
    'assessment lit par version de prompt',
  );
}

// ---------------------------------------------------------------------------
// 3. Ce que cette commande ne peut pas faire
// ---------------------------------------------------------------------------

/**
 * Les importations qui rendraient un envoi possible depuis ici.
 *
 * Vérifié sur la SOURCE de ce fichier, pas sur une intention : c'est la même
 * technique que le dépôt applique aux rails d'inspection et de sonde.
 */
const FORBIDDEN_IMPORTS: readonly string[] = Object.freeze([
  'setKillSwitch',
  'sendFirstTouchDm',
  'sendThreadReply',
  'executeConversationReply',
  'playwrightRail',
  'r6bLiveDispatch',
]);

function certifyNoEffect(): void {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  // Les IMPORTATIONS, pas le fichier : la documentation de tête NOMME
  // `setKillSwitch` pour dire qu'elle ne l'importe pas, et une lecture naïve y
  // voyait un import. Une garde qui se déclenche sur sa propre explication est
  // pire qu'absente — elle apprend à ignorer le mot « échec ».
  const imports = (source.match(/^import[\s\S]*?from\s+'[^']+';$/gmu) ?? []).join('\n');
  const offenders = FORBIDDEN_IMPORTS.filter((name) => imports.includes(name));
  record(
    'SÛRETÉ',
    'cette commande ne sait pas envoyer',
    offenders.length === 0 ? 'PASS' : 'FAIL',
    offenders.length === 0 ? 'aucun provider, aucun rail, aucun arrêt global' : offenders.join(', '),
  );
}

// ---------------------------------------------------------------------------
// 4. L'état RÉEL, en lecture seule
// ---------------------------------------------------------------------------

async function certifyDatabase(sql: Sql): Promise<void> {
  const applied = await sql.query<{ version: string }>(
    `select version from schema_migrations order by version desc limit 1`,
  );
  const onDisk = readdirSync(join(ROOT, 'db', 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .at(-1);
  const last = applied[0]?.version ?? null;
  const expected = onDisk === undefined ? null : onDisk.replace(/\.sql$/, '');
  record(
    'BASE',
    'migrations appliquées',
    last !== null && last === expected ? 'PASS' : 'FAIL',
    `base ${last ?? 'aucune'} / disque ${expected ?? 'aucune'}`,
  );

  // L'arrêt global. Lu, JAMAIS touché : cette commande ne connaît pas
  // `setKillSwitch`, et le relever reste un geste d'opérateur nommé.
  const kill = await sql.query<{ engaged: boolean }>(
    `select engaged from ig_kill_switch order by updated_at desc limit 1`,
  );
  const engaged = kill[0]?.engaged ?? true;
  record(
    'SÛRETÉ',
    'arrêt global',
    'PASS',
    engaged ? 'ARMÉ — aucun effet possible' : 'LEVÉ — un effet devient possible si tout le reste est vert',
  );

  // Aucun plan vivant ne doit porter une version périmée : ce serait un texte
  // d'hier prêt à partir sous les règles d'aujourd'hui.
  const stale = await sql.query<{ n: string }>(
    `select count(*)::text as n from hermes_conversation_plans
      where status in ('PLANNED','CLAIMED','SKIPPED')
        and (policy_version <> $1 or commercial_policy_version <> $2 or brain_version <> all($3::text[]))`,
    [CONVERSATION_POLICY_VERSION, COMMERCIAL_POLICY_VERSION, [...CURRENT_DRAFT_PROMPT_VERSIONS]],
  );
  const staleCount = Number(stale[0]?.n ?? '0');
  record(
    'BASE',
    'aucun plan vivant sous une version périmée',
    staleCount === 0 ? 'PASS' : 'AMBER',
    staleCount === 0 ? 'aucun' : `${String(staleCount)} plan(s) — ils seront refusés au crochet pré-effet`,
  );

  // Un effet tenté ne se rejoue jamais : aucun plan ne doit être à la fois
  // « effet tenté » et vivant.
  const replayable = await sql.query<{ n: string }>(
    `select count(*)::text as n from hermes_conversation_plans
      where external_effect_attempted = true and status in ('PLANNED','CLAIMED','SKIPPED')`,
  );
  const replayCount = Number(replayable[0]?.n ?? '0');
  record(
    'BASE',
    'aucun effet tenté n’est rejouable',
    replayCount === 0 ? 'PASS' : 'FAIL',
    replayCount === 0 ? 'aucun' : `${String(replayCount)} plan(s) vivants portent un effet tenté`,
  );

  // L'idempotence entrante : un identifiant de message = un événement.
  const duplicates = await sql.query<{ n: string }>(
    `select count(*)::text as n from (
       select provider, mailbox, provider_message_id
         from r6b_inbound_messages
        group by 1,2,3 having count(*) > 1) d`,
  );
  const duplicateCount = Number(duplicates[0]?.n ?? '0');
  record(
    'BASE',
    'idempotence entrante',
    duplicateCount === 0 ? 'PASS' : 'FAIL',
    duplicateCount === 0
      ? 'un identifiant fournisseur = un événement'
      : `${String(duplicateCount)} identifiant(s) portent plusieurs lignes`,
  );

  // Combien d'effets extérieurs le rail de réponse a-t-il RÉELLEMENT tentés ?
  //
  // C'est un compte, pas un verdict : une instance en service en produit, et
  // c'est ce qu'on lui demande. Ce qui serait un défaut — un effet tenté sans
  // activation vivante — est refusé en amont par le crochet pré-effet, pas ici.
  // Sur une instance fraîche ce compte vaut zéro, et c'est ce que le guide
  // d'installation attend du smoke sans effet.
  const effects = await sql.query<{ total: string }>(
    `select count(*)::text as total
       from hermes_conversation_plans p
      where p.external_effect_attempted = true`,
  );
  const totalEffects = Number(effects[0]?.total ?? '0');
  record(
    'ÉTAT',
    'REPLY_EFFECTS_ATTEMPTED',
    'PASS',
    totalEffects === 0
      ? 'aucun — le rail de réponse n’a jamais touché un fil'
      : `${String(totalEffects)} effet(s) tenté(s) par le rail de réponse`,
  );

  // Le runtime d'auto-réponse est-il PERMANENT ? Il ne doit pas l'être : le
  // runner du test contrôlé est un processus au premier plan, nommé et
  // temporaire. Ce contrôle lit ce qui est observable — un plan CLAIMED dont le
  // bail court encore signale un worker vivant.
  const leased = await sql.query<{ n: string }>(
    `select count(*)::text as n from hermes_conversation_plans
      where status = 'CLAIMED' and lease_expires_at > now()`,
  );
  const leasedCount = Number(leased[0]?.n ?? '0');
  record(
    'SÛRETÉ',
    'AUTO_REPLY_RUNTIME_LIVE',
    leasedCount === 0 ? 'PASS' : 'AMBER',
    leasedCount === 0
      ? 'NO — aucun plan sous bail vivant'
      : `${String(leasedCount)} plan(s) sous bail : un worker tourne`,
  );
}

// ---------------------------------------------------------------------------
// 4bis. HERMES-AUTO-REPLY-PRODUCTION-R1 — l'état du rail d'auto-réponse
// ---------------------------------------------------------------------------

/**
 * Les QUATRE états que ce round a cessé de confondre, lus séparément.
 *
 * Aucun n'est un défaut en soi : un rail au repos est l'état normal du dépôt,
 * et un plafond atteint n'est pas une panne. Ce qui serait un défaut, c'est du
 * RETARD HISTORIQUE dans le périmètre autonome — et c'est la seule chose que
 * ce bloc peut faire échouer.
 */
async function certifyAutoReplyProduction(sql: Sql): Promise<void> {
  const activation = await loadActiveAutoReplyActivation(sql);
  if (activation === null) {
    record(
      'AUTO-RÉPONSE',
      'AUTO_REPLY_ACTIVATED',
      'PASS',
      'NO — aucune activation vivante ; le runtime ne traite aucune conversation',
    );
  } else {
    const effects = await countActivationEffects(sql, activation);
    const budget = assessRolloutBudget(activation, effects);
    record(
      'AUTO-RÉPONSE',
      'AUTO_REPLY_ACTIVATED',
      'PASS',
      `YES — frontière ${activation.frontierAt}, posée par ${activation.activatedBy}`,
    );
    record(
      'AUTO-RÉPONSE',
      'budget de déploiement',
      'PASS',
      activation.maxEffects === null
        ? `aucune borne — ${String(effects)} réponse(s) depuis la frontière`
        : `${String(effects)}/${String(activation.maxEffects)} — ${budget.open ? 'ouvert' : 'épuisé'}`,
    );
  }

  // LA question qui décide si ce round est livrable : un message ANTÉRIEUR à la
  // frontière a-t-il reçu une réponse autonome ? Sans activation vivante, la
  // réponse est vide par construction — il n'y a pas de frontière à franchir.
  const backlog =
    activation === null
      ? 0
      : Number(
          (
            await sql.query<{ n: string }>(
              `select count(*)::text as n
                 from hermes_conversation_plans p
                 join r6b_inbound_messages i on i.id = p.trigger_inbound_message_id
                where p.external_effect_attempted = true
                  and p.kind = 'AUTO_REPLY'
                  and p.created_at >= $1::timestamptz
                  and i.received_at < $1::timestamptz`,
              [activation.frontierAt],
            )
          )[0]?.n ?? '0',
        );
  record(
    'AUTO-RÉPONSE',
    'HISTORICAL_BACKLOG_AUTO_REPLY',
    backlog === 0 ? 'PASS' : 'FAIL',
    backlog === 0
      ? 'NO — aucun effet sur un message antérieur à la frontière'
      : `${String(backlog)} effet(s) sur du retard historique`,
  );

  const heartbeats = await loadAutoReplyHeartbeats(sql, 10);
  const now = new Date();
  const alive = heartbeats.filter((beat) => isHeartbeatFresh(beat, now, 5 * 60 * 1000));
  record(
    'AUTO-RÉPONSE',
    'AUTO_REPLY_WORKER_ALIVE',
    'PASS',
    alive.length === 0
      ? 'NO — aucun battement frais'
      : `YES — ${alive.map((beat) => `${beat.workerId} (${beat.mode})`).join(', ')}`,
  );

  // Un worker LIVE qui tourne sous une révision autre que celle du dépôt est
  // exactement l'incident du 23 août, côté sortant cette fois.
  const sentinel = createCodeRevisionSentinel(ROOT);
  const drifted = alive.filter(
    (beat) =>
      beat.mode === 'LIVE' &&
      beat.codeRevision !== null &&
      sentinel.startedAt !== null &&
      beat.codeRevision !== sentinel.startedAt,
  );
  record(
    'AUTO-RÉPONSE',
    'aucun worker LIVE sous une révision périmée',
    drifted.length === 0 ? 'PASS' : 'FAIL',
    drifted.length === 0 ? 'aucun' : drifted.map((beat) => beat.workerId).join(', '),
  );
}

// ---------------------------------------------------------------------------
// 5. Les matrices
// ---------------------------------------------------------------------------

function certifyMatrices(): void {
  const dir = join(ROOT, 'tests', 'certification');
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => join('tests', 'certification', name));

  const result = spawnSync('npx', ['vitest', 'run', ...files, '--reporter=dot'], {
    cwd: ROOT,
    encoding: 'utf8',
    // Cette commande ne doit pas hériter d'un armement d'envoi.
    env: { ...process.env, OUTBOUND_ALLOW_SENDING: '0' },
  });
  const output = `${result.stdout}${result.stderr}`;
  const summary = /Tests\s+(.+)/.exec(output)?.[1]?.trim() ?? 'sortie illisible';
  record(
    'MATRICES',
    `matrice conversationnelle (${String(CONVERSATION_MATRIX.length)} scénarios) + ` +
      `corpus sémantique (${String(expandedSemanticCorpus().length)} cas, ` +
      `${String(REAL_CANARY_CORPUS.length)} tours réels) + invariants + first-touch`,
    result.status === 0 ? 'PASS' : 'FAIL',
    summary,
  );
}

// ---------------------------------------------------------------------------
// Le rapport
// ---------------------------------------------------------------------------

const ICON: Readonly<Record<Status, string>> = Object.freeze({
  PASS: '✓',
  FAIL: '✗',
  AMBER: '~',
  SKIP: '·',
});

/**
 * Le verdict.
 *
 * `PARTIAL` existe parce que la première version de cette fonction n'avait que
 * OUI et NON : un contrôle SAUTÉ ne comptait pas comme un échec, si bien que
 * `--fast` imprimait « HERMES_CERTIFIED = YES » sans avoir exécuté une seule
 * matrice. Une commande qui affirme sans avoir regardé est exactement le défaut
 * que cette mission passe son temps à refermer — et celui-là aurait été dans
 * l'outil censé les trouver.
 *
 * Un SKIP n'est pas un échec : il n'y a rien à reprocher au moteur. Mais ce
 * n'est pas une certification non plus, et le mot doit le dire.
 */
function report(json: boolean): number {
  const failed = checks.filter((check) => check.status === 'FAIL');
  const amber = checks.filter((check) => check.status === 'AMBER');
  const skipped = checks.filter((check) => check.status === 'SKIP');
  const certified = failed.length === 0 && skipped.length === 0;
  const verdict = failed.length > 0 ? 'NO' : skipped.length > 0 ? 'PARTIAL' : 'YES';

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        { certified, verdict, checks, failed: failed.length, amber: amber.length, skipped: skipped.length },
        null,
        2,
      )}\n`,
    );
    return failed.length === 0 ? 0 : 1;
  }

  const lines: string[] = [];
  let group = '';
  for (const check of checks) {
    if (check.group !== group) {
      group = check.group;
      lines.push('', group);
    }
    lines.push(`  ${ICON[check.status]} ${check.name.padEnd(58)} ${check.detail}`);
  }
  lines.push('');
  lines.push(`HERMES_CERTIFIED = ${verdict}`);
  if (failed.length > 0) lines.push(`  échecs : ${failed.map((check) => check.name).join(' | ')}`);
  if (amber.length > 0) lines.push(`  amber  : ${amber.map((check) => check.name).join(' | ')}`);
  if (skipped.length > 0) {
    lines.push(
      `  sautés : ${skipped.map((check) => check.name).join(' | ')} — relancer sans --fast pour un OUI`,
    );
  }
  lines.push('');
  lines.push('Cette commande n’envoie rien. Le dernier geste reste humain.');
  process.stdout.write(`${lines.join('\n')}\n`);
  // Un SKIP ne fait pas échouer la commande : `--fast` est un usage légitime,
  // et le faire sortir en erreur apprendrait à ignorer son code de retour.
  // C'est le MOT qui porte la nuance, pas le code.
  return failed.length === 0 ? 0 : 1;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const fast = argv.includes('--fast');
  const json = argv.includes('--json');

  certifyRepository();
  certifyVersions();
  certifyNoEffect();

  try {
    const sql = await getSql();
    try {
      await certifyDatabase(sql);
      await certifyAutoReplyProduction(sql);
    } finally {
      await sql.close();
    }
  } catch (error) {
    // Une base injoignable n'invalide pas le moteur : elle empêche de le
    // constater. AMBER, jamais un faux vert.
    record(
      'BASE',
      'lecture de la base',
      'AMBER',
      error instanceof Error ? error.message.slice(0, 120) : 'injoignable',
    );
  }

  if (fast) record('MATRICES', 'matrices', 'SKIP', '--fast : non exécutées');
  else certifyMatrices();

  process.exitCode = report(json);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
