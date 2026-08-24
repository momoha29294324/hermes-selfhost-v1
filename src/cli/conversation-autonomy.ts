#!/usr/bin/env tsx
/**
 * HERMES-CONVERSATION-R2 §30/§31/§38/§39 — le mode OMBRE de la conversation
 * autonome, en LECTURE SEULE.
 *
 *   npm run conversation:autonomy                      # toutes les réponses corrélées
 *   npm run conversation:autonomy -- --inbound <uuid>  # une seule
 *   npm run conversation:autonomy -- --recent 5
 *
 * ---------------------------------------------------------------------------
 * Ce que cette commande ne fait pas, et ce qui l'en empêche
 * ---------------------------------------------------------------------------
 *
 *   * elle n'écrit RIEN : la connexion passe par un `Sql` enveloppé qui refuse
 *     toute instruction non-SELECT au niveau de la SYNTAXE
 *     (`assertReadOnlyStatement`), et dont `exec` et `transaction` lèvent. Une
 *     écriture n'est pas « interdite par convention » : elle ne parvient pas au
 *     serveur ;
 *
 *   * elle n'appelle AUCUN modèle : `assessInboundMessage` ne prend pas de
 *     `ModelRouter`. Elle relit le brouillon déjà écrit et lui applique les
 *     contrôles déterministes. Aucune ligne `model_runs`, aucun coût ;
 *
 *   * elle n'envoie RIEN : aucun provider, aucune primitive d'envoi, aucun bail
 *     navigateur n'entre dans sa clôture d'imports. L'arrêt global n'est ni lu
 *     comme une permission ni levé — il est simplement AFFICHÉ, parce qu'un
 *     rapport qui ne dirait pas dans quel état est le rail serait un rapport
 *     qu'on lirait de travers.
 *
 * Ce qu'elle rend : pour chaque réponse réelle, la décision d'autonomie, le
 * motif du refus quand il y en a un, la maturité pour l'offre, la maturité pour
 * un échange, l'état de la relance — et, à la fin, le CANDIDAT canari s'il en
 * existe un, avec son texte et la raison pour laquelle il serait sûr.
 */
import { loadConversationPolicy, loadInstagramRail } from '@/lib/config/load';
import {
  assessInboundMessage,
  loadFollowUpFacts,
  type ConversationAssessment,
} from '@/lib/conversation/assessment';
import { formatAutonomousReplyDecision } from '@/lib/conversation/autonomy';
import {
  formatFollowUpDecision,
  planFollowUp,
  postponeToWindow,
  type FollowUpDecision,
} from '@/lib/conversation/followUp';
import { getSql } from '@/lib/db';
import { assertReadOnlyStatement } from '@/lib/db/safety';
import type { Sql } from '@/lib/db/sql';
import { loadKillSwitch } from '@/lib/instagram/safety';

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
  let recent = 20;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
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
      recent = Math.min(200, parsed);
      i += 1;
      continue;
    }
    throw new ArgError(`option inconnue : ${arg}`);
  }

  return { inboundId, recent };
}

/** La même base, privée du droit d'écrire. */
function readOnly(sql: Sql): Sql {
  return {
    driver: sql.driver,
    async query<T>(text: string, params?: readonly unknown[]): Promise<T[]> {
      assertReadOnlyStatement(text, 'conversation:autonomy');
      return sql.query<T>(text, params);
    },
    async exec(): Promise<void> {
      throw new Error('conversation:autonomy est en lecture seule : exec est refusé');
    },
    async transaction<T>(): Promise<T> {
      throw new Error('conversation:autonomy est en lecture seule : transaction est refusée');
    },
    async close(): Promise<void> {
      await sql.close();
    },
  };
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

function renderAssessment(assessment: ConversationAssessment): void {
  const a = assessment;
  out('');
  out(`— ${a.displayName} · ${a.receivedAt} · ${a.inboundMessageId}`);
  out(`  D2                 ${a.category} (${a.confidence.toFixed(2)}) → objectif ${a.goal}`);
  out(`  DÉCISION           ${formatAutonomousReplyDecision(a.autonomous)}  [porte ${a.autonomous.gate}]`);
  out(`  motif              ${a.autonomous.detail}`);
  out(
    `  au moment du tour  ${formatAutonomousReplyDecision(a.replay)}  [porte ${a.replay.gate}]` +
      ' — mesure, pas une autorisation',
  );
  out(
    `  offre              ${a.offer.readiness} / palier ${a.offer.stage}` +
      `${a.offer.needsCommercialPolicy ? ' (conditions commerciales MANQUANTES)' : ''}`,
  );
  out(`  appel              ${a.callReadiness}`);
  out(
    `  salve              ${String(a.burstSize)} message(s), ${a.closesBurst ? 'clôturée par celui-ci' : 'ce message n’est pas le dernier'}, ` +
      `${a.burstSettled ? 'silence établi' : 'silence non établi'}`,
  );
  out(
    `  fraîcheur          ${a.newerInboundExists ? 'DÉPASSÉE (un message plus récent existe)' : 'à jour'}` +
      `${a.terminalCategoryInThread === null ? '' : ` | fil refermé par ${a.terminalCategoryInThread}`}`,
  );
  out(
    `  garde-fous         opt-out ${a.guards.suppressed ? 'OUI' : 'non'} | état ${a.guards.outreachState ?? '—'} | ` +
      `identité ${a.guards.identityConfirmed ? 'confirmée' : 'NON confirmée'}`,
  );

  if (a.draft === null) {
    out('  brouillon          aucun');
    return;
  }
  const d = a.draft;
  out(
    `  brouillon [${d.status}]  ${String(d.naturalness.metrics.chars)} car. / ` +
      `${String(d.naturalness.metrics.sentences)} phrase(s) / ${String(d.naturalness.metrics.questions)} question(s)`,
  );
  out(
    `  naturalité         ${d.naturalness.verdict}` +
      `${d.facts.naturalnessBlockingCodes.length === 0 ? '' : ` [${d.facts.naturalnessBlockingCodes.join(', ')}]`}`,
  );
  if (d.facts.performanceClaims.length > 0) {
    out(`  promesses          ${d.facts.performanceClaims.join(', ')}`);
  }
  out(`  « ${d.body.replace(/\s+/gu, ' ').slice(0, 200)} »`);
}

function renderFollowUp(displayName: string, decision: FollowUpDecision, windowed: Date | null): void {
  out('');
  out(`— RELANCE · ${displayName}`);
  out(`  séquence           ${decision.sequence}`);
  out(`  DÉCISION           ${formatFollowUpDecision(decision)}  [porte ${decision.gate}]`);
  out(`  motif              ${decision.detail}`);
  if (decision.dueAt !== null) {
    out(
      `  échéance           ${decision.dueAt.toISOString()} (${decision.dueBasis ?? '—'})` +
        `${windowed === null ? '' : ` → dans la fenêtre : ${windowed.toISOString()}`}`,
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const policy = loadConversationPolicy();
  const rail = loadInstagramRail();
  const now = new Date();

  const live = await getSql();
  const sql = readOnly(live);

  try {
    const killSwitch = await loadKillSwitch(sql);

    out('');
    out('HERMES-CONVERSATION-R2 — OMBRE (lecture seule, aucun modèle, aucun effet)');
    out(
      `  arrêt global       ${killSwitch.engaged ? 'ARMÉ' : 'LEVÉ'} ` +
        `(${killSwitch.setBy ?? 'défaut'}${killSwitch.reason === null ? '' : ` : ${killSwitch.reason}`})`,
    );
    out(
      `  politique          seuil de confiance ${policy.reply.minConfidence.toFixed(2)} | ` +
        `délai ${String(Math.round(policy.reply.minDelayMs / 1000))}–${String(Math.round(policy.reply.maxDelayMs / 1000))} s | ` +
        `salve close après ${String(Math.round(policy.reply.burstQuietMs / 60000))} min`,
    );
    out(
      `  relances           ${String(policy.followUp.maxAttempts)} au plus | ` +
        `J+${String(Math.round(policy.followUp.firstDelayMs / 86_400_000))} puis ` +
        `J+${String(Math.round(policy.followUp.secondDelayMs / 86_400_000))} | ` +
        `report par défaut J+${String(Math.round(policy.followUp.notNowDefaultDelayMs / 86_400_000))}`,
    );

    const ids = args.inboundId !== null ? [args.inboundId] : await correlatedInbound(sql, args.recent);
    if (ids.length === 0) {
      out('\nAucune réponse corrélée et analysée.');
      return;
    }

    const assessments: ConversationAssessment[] = [];
    for (const id of ids) {
      const assessment = await assessInboundMessage(sql, id, { config: policy, now });
      if (assessment === null) {
        out(`\n— ${id} : message inexistant, non corrélé, ou sans analyse vivante.`);
        continue;
      }
      assessments.push(assessment);
      renderAssessment(assessment);
    }

    // ---- Les relances, une par prospect ------------------------------------
    const seen = new Set<string>();
    for (const assessment of assessments) {
      if (seen.has(assessment.prospectId)) continue;
      seen.add(assessment.prospectId);
      const facts = await loadFollowUpFacts(sql, assessment.prospectId, assessment.channel);
      if (facts === null) continue;
      const decision = planFollowUp({ facts, config: policy, now });
      renderFollowUp(
        assessment.displayName,
        decision,
        decision.dueAt === null ? null : postponeToWindow(decision.dueAt, rail),
      );
    }

    // ---- Le bilan ----------------------------------------------------------
    const tally = new Map<string, number>();
    const replayTally = new Map<string, number>();
    for (const assessment of assessments) {
      const key = formatAutonomousReplyDecision(assessment.autonomous);
      tally.set(key, (tally.get(key) ?? 0) + 1);
      const replayKey = formatAutonomousReplyDecision(assessment.replay);
      replayTally.set(replayKey, (replayTally.get(replayKey) ?? 0) + 1);
    }
    out('');
    out(`BILAN AUJOURD’HUI — ${String(assessments.length)} réponse(s) évaluée(s)`);
    for (const [key, count] of [...tally.entries()].sort()) {
      out(`  ${String(count).padStart(3)}  ${key}`);
    }
    out('');
    out('BILAN AU MOMENT DE CHAQUE TOUR (mesure de la politique, aucune autorisation)');
    for (const [key, count] of [...replayTally.entries()].sort()) {
      out(`  ${String(count).padStart(3)}  ${key}`);
    }

    // ---- §38 — le candidat canari ------------------------------------------
    const candidates = assessments.filter(
      (assessment) => assessment.autonomous.outcome === 'AUTO_REPLY_ELIGIBLE',
    );
    out('');
    out('CANDIDAT CANARI (§38) — préparé, JAMAIS envoyé');
    if (candidates.length === 0) {
      out('  aucun. Aucune réponse réelle ne franchit toutes les portes de contenu aujourd’hui.');
    } else {
      const candidate = candidates[candidates.length - 1];
      if (candidate !== undefined) {
        out(`  conversation       ${candidate.displayName} · ${candidate.inboundMessageId}`);
        out(`  texte              « ${candidate.draft?.body ?? '(aucun)'} »`);
        out(`  éligibilité        ${formatAutonomousReplyDecision(candidate.autonomous)}`);
        out(`  pourquoi sûr       ${candidate.autonomous.detail}`);
        out(`  clé d’idempotence  ${candidate.idempotencyKey}`);
        out(`  pas avant          ${candidate.notBefore}`);
      }
    }

    out('');
    out('Aucun envoi. Aucune écriture. Aucun plan inscrit. Arrêt global inchangé.');
    out('');
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
