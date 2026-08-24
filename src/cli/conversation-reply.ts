#!/usr/bin/env tsx
/**
 * HERMES-REPLY-DELIVERY-R1 §15/§17 — le rail de RÉPONSE, en quatre modes dont
 * un seul peut produire un effet.
 *
 *   npm run conversation:reply                          # OMBRE, lecture seule
 *   npm run conversation:reply -- --inbound <uuid>      # ombre d'un seul tour
 *   npm run conversation:reply -- --preview             # navigateur, arrêt avant saisie
 *   npm run conversation:reply -- --draft               # navigateur, saisie constatée, aucun clic
 *   npm run conversation:reply -- --live --as "<nom>"   # le seul mode qui clique
 *
 * ---------------------------------------------------------------------------
 * Ce qui rend les trois premiers modes incapables d'envoyer
 * ---------------------------------------------------------------------------
 *
 *   * **OMBRE** — la connexion passe par un `Sql` enveloppé qui refuse toute
 *     instruction non-SELECT au niveau de la SYNTAXE (`assertReadOnlyStatement`),
 *     et dont `exec` et `transaction` lèvent. Aucun navigateur n'est construit :
 *     le rail n'est pas instancié du tout. Une écriture n'est pas « interdite
 *     par convention », elle ne parvient pas au serveur ;
 *
 *   * **APERÇU** et **BROUILLON** — le rail est construit, mais `stopAfter` vaut
 *     `'thread'` ou `'draft'`, et la primitive rend son résultat AVANT
 *     `onBeforeExternalEffect`. Le crochet n'est donc jamais appelé, la
 *     réservation n'a pas lieu, `external_effect_attempted` reste faux, et une
 *     contrainte de base (`hermes_effect_dry_modes_have_no_effect`) REFUSERAIT
 *     la ligne d'audit si l'un des deux prétendait le contraire.
 *
 * ---------------------------------------------------------------------------
 * Ce qu'il faut réunir pour que `--live` clique
 * ---------------------------------------------------------------------------
 * Aucune de ces conditions n'est levée par cette commande, et elle n'en lève
 * aucune :
 *
 *   1. `OUTBOUND_ALLOW_SENDING=1` dans l'environnement de l'invocation —
 *      éphémère, jamais dans `.env` (CLAUDE.md, interdit n° 1) ;
 *   2. `--as "<nom>"` : un opérateur nommé, inscrit dans le journal ;
 *   3. l'ARRÊT GLOBAL désengagé, par le geste dédié
 *      (`npm run ig:kill-switch -- --release …`). Cette commande n'importe pas
 *      `setKillSwitch` : elle ne SAIT pas le lever ;
 *   4. la fenêtre, les plafonds et l'espacement du rail Instagram, inchangés ;
 *   5. un plan `AUTO_REPLY_ELIGIBLE` vivant, dont la politique tient encore
 *      quand on la rejoue.
 *
 * Le mode `--live` ne relâche rien : il NOMME simplement qu'on accepte que le
 * dernier geste ait lieu si toutes les portes restent vertes.
 */
import { loadConversationPolicy, loadInstagramRail } from '@/lib/config/load';
import {
  observeReplyShadow,
  renderReplyShadow,
  summarizeReplyShadow,
  type ReplyShadowObservation,
} from '@/lib/conversation/replyShadow';
import { executeConversationReply } from '@/lib/conversation/replyExecution';
import type { ReplyEffectMode } from '@/lib/conversation/replyEffect';
import { getSql } from '@/lib/db';
import { readOnlySql } from '@/lib/db/readOnlySql';
import type { Sql } from '@/lib/db/sql';
import { PlaywrightInstagramReplyRail } from '@/lib/instagram/playwrightReplyRail';
import { loadKillSwitch } from '@/lib/instagram/safety';

class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgError';
  }
}

type Mode = 'SHADOW' | ReplyEffectMode;

interface Args {
  readonly mode: Mode;
  readonly inboundId: string | null;
  readonly planId: string | null;
  readonly recent: number;
  readonly operator: string | null;
  readonly headless: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  // Les modes demandés sont COLLECTÉS puis résolus après la boucle, plutôt
  // qu'affectés au fil de l'eau : deux modes donnés ensemble ne doivent pas
  // laisser le dernier gagner en silence, et une affectation faite dans une
  // fermeture empêcherait le compilateur de raisonner sur la valeur finale.
  const requested: ReplyEffectMode[] = [];
  let inboundId: string | null = null;
  let planId: string | null = null;
  let recent = 20;
  let operator: string | null = null;
  let headless = true;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const next = argv[i + 1];
    if (arg === '--preview') {
      requested.push('PREVIEW');
      continue;
    }
    if (arg === '--draft') {
      requested.push('DRAFT');
      continue;
    }
    if (arg === '--live') {
      requested.push('LIVE');
      continue;
    }
    if (arg === '--headed') {
      headless = false;
      continue;
    }
    if (arg === '--inbound') {
      if (next === undefined || next.startsWith('--')) throw new ArgError('--inbound attend un identifiant');
      inboundId = next;
      i += 1;
      continue;
    }
    if (arg === '--plan') {
      if (next === undefined || next.startsWith('--')) throw new ArgError('--plan attend un identifiant');
      planId = next;
      i += 1;
      continue;
    }
    if (arg === '--as') {
      if (next === undefined || next.startsWith('--')) throw new ArgError('--as attend un nom d’opérateur');
      operator = next.trim();
      i += 1;
      continue;
    }
    if (arg === '--recent') {
      const parsed = Number.parseInt(next ?? '', 10);
      if (!Number.isFinite(parsed) || parsed < 1) throw new ArgError('--recent attend un entier ≥ 1');
      recent = Math.min(200, parsed);
      i += 1;
      continue;
    }
    throw new ArgError(`option inconnue : ${arg}`);
  }

  if (requested.length > 1) throw new ArgError('un seul mode peut être demandé');
  const mode: Mode = requested[0] ?? 'SHADOW';

  if (mode !== 'SHADOW' && operator === null) {
    throw new ArgError(
      'ouvrir un navigateur sur la session Instagram demande un opérateur nommé : --as "<nom>"',
    );
  }
  if (mode === 'LIVE' && process.env.OUTBOUND_ALLOW_SENDING !== '1') {
    throw new ArgError(
      '--live demande OUTBOUND_ALLOW_SENDING=1 dans l’environnement de CETTE invocation. ' +
        'Le défaut du dépôt est « ne rien envoyer », et il ne se change pas dans un fichier.',
    );
  }

  return { mode, inboundId, planId, recent, operator, headless };
}

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

async function correlatedInbound(sql: Sql, limit: number): Promise<string[]> {
  const rows = await sql.query<{ id: string }>(
    `select i.id
       from r6b_inbound_messages i
       join r6b_reply_analyses a on a.inbound_message_id = i.id and a.status = 'ACTIVE'
      where i.correlation_status in ('EXACT','HIGH_CONFIDENCE')
      order by i.received_at asc
      limit $1`,
    [limit],
  );
  return rows.map((row) => row.id);
}

async function runShadow(args: Args): Promise<void> {
  const conversation = loadConversationPolicy();
  const config = loadInstagramRail();
  const now = new Date();

  const live = await getSql();
  const sql = readOnlySql(live, 'le mode ombre de conversation:reply');

  try {
    const killSwitch = await loadKillSwitch(sql);
    out('');
    out('HERMES-REPLY-DELIVERY-R1 — mode OMBRE (aucun navigateur, aucune écriture, aucun envoi)');
    out('');
    out(`  arrêt global   ${killSwitch.engaged ? 'ARMÉ' : 'désengagé'}`);
    const windows = config.schedule.windows
      .map((w) => `j${w.days.join('')} ${String(Math.floor(w.startMinute / 60))}h–${String(Math.floor(w.endMinute / 60))}h`)
      .join(' | ');
    out(`  fenêtre        ${config.schedule.timezone} · ${windows}`);

    const ids = args.inboundId === null ? await correlatedInbound(sql, args.recent) : [args.inboundId];
    const observations: ReplyShadowObservation[] = [];
    for (const id of ids) {
      const observation = await observeReplyShadow(sql, id, { config, conversation, now });
      observations.push(observation);
      out('');
      for (const line of renderReplyShadow(observation)) out(line);
    }

    const summary = summarizeReplyShadow(observations);
    out('');
    out('— RÉSUMÉ');
    out(`  évalués            ${String(summary.evaluated)}`);
    for (const [stage, count] of Object.entries(summary.byStage)) {
      out(`  ${stage.padEnd(18)} ${String(count)}`);
    }
    out(`  prêts pour effet   ${String(summary.readyForEffect)}`);
    out(`  envois             ${String(summary.sends)}  (littéral : ce mode ne peut pas en produire)`);
    out('');
  } finally {
    await sql.close();
  }
}

async function runBrowser(args: Args): Promise<void> {
  const conversation = loadConversationPolicy();
  const config = loadInstagramRail();
  const mode: ReplyEffectMode = args.mode === 'SHADOW' ? 'PREVIEW' : args.mode;
  const workerId = `conversation-reply/${args.operator ?? 'inconnu'}`;

  const sql = await getSql();
  const rail = new PlaywrightInstagramReplyRail({ config, workerId, headless: args.headless });

  try {
    const killSwitch = await loadKillSwitch(sql);
    out('');
    out(`HERMES-REPLY-DELIVERY-R1 — mode ${mode}`);
    out(`  opérateur      ${args.operator ?? '—'}`);
    out(`  arrêt global   ${killSwitch.engaged ? 'ARMÉ' : 'désengagé'}`);
    if (mode !== 'LIVE') {
      out('  effet          IMPOSSIBLE : la primitive rend son résultat avant le crochet pré-effet');
    }

    const outcome = await executeConversationReply(
      {
        sql,
        config,
        conversation,
        workerId,
        mode,
        ...(args.planId === null ? {} : { planId: args.planId }),
      },
      { rail },
    );

    out('');
    out(`  plan           ${outcome.planId ?? '—'}`);
    out(`  fil            ${outcome.threadId ?? '—'}`);
    out(`  issue          ${outcome.status} [${outcome.reasonCode}]`);
    out(`  effet tenté    ${outcome.externalEffectAttempted ? 'OUI' : 'non'}`);
    out(`  clics du rail  ${String(rail.clickCount)}`);
    out(`  trace          ${outcome.effectId ?? '—'}`);
    out(`  détail         ${outcome.detail}`);
    out('');
  } finally {
    await rail.close();
    await sql.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'SHADOW') {
    await runShadow(args);
    return;
  }
  await runBrowser(args);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
