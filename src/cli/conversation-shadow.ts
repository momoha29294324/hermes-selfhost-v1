#!/usr/bin/env tsx
/**
 * CONVERSATION-R1.1 §24, §25 — le diagnostic d'ombre, en LECTURE SEULE.
 *
 *   npm run conversation:shadow -- --recent 5
 *   npm run conversation:shadow -- --inbound <uuid>
 *
 * ---------------------------------------------------------------------------
 * Ce que cette commande ne fait pas, et ce qui l'en empêche
 * ---------------------------------------------------------------------------
 *
 * Elle n'écrit rien, n'envoie rien, et n'appelle AUCUN modèle. Ce ne sont pas
 * trois promesses, ce sont trois conséquences :
 *
 *   * la connexion passe par un `Sql` enveloppé qui refuse toute instruction
 *     non-SELECT au niveau de la SYNTAXE (`assertReadOnlyStatement`), et dont
 *     `exec` et `transaction` lèvent. Une écriture n'est pas « interdite par
 *     convention » : elle ne compile pas jusqu'au serveur ;
 *
 *   * elle appelle `understandConversation`, qui ne prend pas de `ModelRouter`.
 *     Il n'y a pas de rédaction à faire ici, donc pas de modèle à appeler, donc
 *     pas de ligne `model_runs` ni de coût ;
 *
 *   * elle relit le brouillon canonique DÉJÀ écrit, quand il existe, et lui
 *     applique le contrôle de naturalité. C'est la question du round posée sur
 *     de vraies données : ce qui est parti en revue humaine était-il naturel ?
 *
 * Pour la comparaison COMPLÈTE — ce que le cerveau aurait écrit à la place —
 * il faut une rédaction, donc un modèle, donc le chemin du pipeline :
 * `OUTBOUND_CONVERSATION_SHADOW_ENABLED=1 npm run r6b:replies:process -- --resume`.
 */
import { understandConversation } from '@/lib/conversation/brain';
import { checkNaturalness } from '@/lib/conversation/naturalness';
import { getSql } from '@/lib/db';
import { assertReadOnlyStatement } from '@/lib/db/safety';
import type { Sql } from '@/lib/db/sql';
import { loadActiveAnalysis } from '@/lib/replies/analyses';
import { loadReplyContext } from '@/lib/replies/context';
import { loadDraftForAnalysis } from '@/lib/replies/draft';
import { CONVERSATION_SHADOW_ENV, conversationShadowEnabled } from '@/lib/conversation/shadow';

class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgError';
  }
}

interface Args {
  readonly inboundId: string | null;
  readonly recent: number;
}

function parseArgs(argv: readonly string[]): Args {
  let inboundId: string | null = null;
  let recent = 5;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    if (arg === '--inbound') {
      if (next === undefined || next.startsWith('--')) throw new ArgError('--inbound attend un identifiant');
      inboundId = next;
      i += 1;
      continue;
    }
    if (arg === '--recent') {
      const parsed = Number.parseInt(next ?? '', 10);
      if (!Number.isFinite(parsed) || parsed < 1) throw new ArgError('--recent attend un entier ≥ 1');
      recent = Math.min(50, parsed);
      i += 1;
      continue;
    }
    throw new ArgError(`option inconnue : ${arg}`);
  }

  return { inboundId, recent };
}

/**
 * La même base, privée du droit d'écrire.
 *
 * `exec` et `transaction` lèvent plutôt que de rendre une version « inoffensive »
 * d'eux-mêmes : un diagnostic qui ouvrirait silencieusement une transaction
 * vide donnerait à croire qu'un chemin d'écriture existe et qu'il est neutre.
 */
function readOnly(sql: Sql): Sql {
  return {
    driver: sql.driver,
    async query<T>(text: string, params?: readonly unknown[]): Promise<T[]> {
      assertReadOnlyStatement(text, 'conversation:shadow');
      return sql.query<T>(text, params);
    },
    async exec(): Promise<void> {
      throw new Error('conversation:shadow est en lecture seule : exec est refusé');
    },
    async transaction<T>(): Promise<T> {
      throw new Error('conversation:shadow est en lecture seule : transaction est refusée');
    },
    async close(): Promise<void> {
      await sql.close();
    },
  };
}

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

async function recentInbound(sql: Sql, limit: number): Promise<string[]> {
  const rows = await sql.query<{ id: string }>(
    `select i.id
       from r6b_inbound_messages i
       join r6b_reply_analyses a on a.inbound_message_id = i.id and a.status = 'ACTIVE'
      where i.correlation_status in ('EXACT','HIGH_CONFIDENCE')
      order by i.received_at desc
      limit $1`,
    [limit],
  );
  return rows.map((row) => row.id);
}

async function inspect(sql: Sql, inboundMessageId: string): Promise<void> {
  const context = await loadReplyContext(sql, inboundMessageId);
  if (context === null) {
    out(`\n${inboundMessageId} : message inexistant ou corrélation non exploitable.`);
    return;
  }
  const analysis = await loadActiveAnalysis(sql, inboundMessageId);
  if (analysis === null) {
    out(`\n${inboundMessageId} : aucune analyse vivante — rien à comparer.`);
    return;
  }

  const understanding = await understandConversation(sql, context, analysis);
  const budget = understanding.lengthBudget;

  out('');
  out(`— ${context.firstTouch.businessName} — ${inboundMessageId}`);
  out(`  canal              ${understanding.thread.channel}`);
  out(`  D2                 ${analysis.classification} (${analysis.confidence.toFixed(2)})`);
  out(`  objectif           ${understanding.state.goal} | décision ${understanding.decision.decision}`);
  out(`  maturité appel     ${understanding.signals.callReadiness}`);
  out(
    `  style              ${understanding.style.addressMode} / ${understanding.style.avgLength} / ` +
      `confiance ${understanding.style.confidence} (${understanding.style.observedMessages} msg)`,
  );
  out(
    `  budget du tour     ${budget.band} → ${budget.maxSentences} phrase(s), ${budget.maxChars} car. ` +
      `(message reçu : ${budget.inboundChars} car.)`,
  );
  out(`  éléments concrets  ${understanding.anchors.length}`);
  out(`  déjà couvert       ${understanding.state.coveredTopics.join(', ') || 'rien'}`);

  const draft = await loadDraftForAnalysis(sql, analysis.id);
  if (draft === null) {
    out('  brouillon          aucun brouillon canonique sur ce tour.');
    return;
  }

  const body = draft.humanText ?? draft.body;
  const report = checkNaturalness({
    body,
    lastInboundText: context.reply.bodyText,
    style: understanding.style,
    state: understanding.state,
    signals: understanding.signals,
    channel: understanding.thread.channel,
    previousOutboundTexts: understanding.thread.exposedOutboundTurns.map((turn) => turn.text),
  });

  out(
    `  brouillon [${draft.status}]   ${report.metrics.chars} car. / ${report.metrics.sentences} phrase(s) / ` +
      `${report.metrics.questions} question(s) / ${report.metrics.emojis} emoji(s)`,
  );
  out(`  naturalité         ${report.verdict} | rebond ${report.rebound}`);
  for (const finding of report.findings) {
    out(`    ${finding.severity === 'BLOCKING' ? '✗' : '·'} ${finding.code} — ${finding.message}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const live = await getSql();
  const sql = readOnly(live);

  try {
    out('\nCONVERSATION-R1.1 — OMBRE (lecture seule, aucun modèle appelé)');
    out(
      `  ${CONVERSATION_SHADOW_ENV} = ${conversationShadowEnabled() ? '1 (pipeline en ombre)' : '0 (pipeline inchangé)'}`,
    );

    const ids = args.inboundId !== null ? [args.inboundId] : await recentInbound(sql, args.recent);
    if (ids.length === 0) out('\nAucune réponse corrélée et analysée.');
    for (const id of ids) await inspect(sql, id);

    out('\nAucun envoi. Aucune écriture. Aucun brouillon persisté.\n');
  } finally {
    await sql.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ArgError) {
    process.stderr.write(`\n${error.message}\n\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
