#!/usr/bin/env tsx
/**
 * HERMES-SALES-KNOWLEDGE-R1 §32 — l'OMBRE sur de vraies conversations, en
 * LECTURE SEULE et sans modèle.
 *
 *   npm run sales:shadow -- --recent 10
 *   npm run sales:shadow -- --inbound <uuid>
 *
 * ---------------------------------------------------------------------------
 * Ce que cette commande compare
 * ---------------------------------------------------------------------------
 * Deux lectures du MÊME message : « sans la connaissance de vente » et « avec ».
 * Ce qui change entre les deux n'est pas la prose — aucun modèle n'est appelé —
 * mais ce que le système DÉCIDE et MONTRE :
 *
 *   * l'escalade commerciale : `hermes-commercial-r1` escaladait sur toute
 *     demande reconnue, r2 escalade sur la première demande NON RÉPONDABLE ;
 *   * la qualification pour un rendez-vous, et le passage de relais ;
 *   * le moment où l'essai peut être mis sur la table ;
 *   * les repères effectivement récupérés, avec leur provenance.
 *
 * ---------------------------------------------------------------------------
 * Ce qu'elle ne peut pas faire
 * ---------------------------------------------------------------------------
 * Elle n'écrit rien et n'envoie rien, et ce ne sont pas deux promesses :
 *
 *   * la connexion passe par un `Sql` enveloppé dont `exec` et `transaction`
 *     lèvent, et dont chaque requête est refusée au niveau de la SYNTAXE si
 *     elle n'est pas un SELECT (`assertReadOnlyStatement`) ;
 *   * elle appelle `understandConversation`, qui ne prend pas de `ModelRouter`.
 *     Aucune rédaction, donc aucun appel de modèle, aucune ligne `model_runs`,
 *     aucun coût ;
 *   * aucun texte de prospect n'est journalisé — des identifiants, des
 *     verdicts et des codes, comme le reste du dépôt.
 */
import { understandConversation } from '@/lib/conversation/brain';
import {
  firstEscalatingDemand,
  readCommercialDemands,
} from '@/lib/conversation/commercialPolicy';
import { getSql } from '@/lib/db';
import { assertReadOnlyStatement } from '@/lib/db/safety';
import type { Sql } from '@/lib/db/sql';
import { loadActiveAnalysis } from '@/lib/replies/analyses';
import { loadReplyContext } from '@/lib/replies/context';
import { buildSalesKnowledgeInjection } from '@/lib/sales/injection';
import { loadSalesKnowledge } from '@/lib/sales/library';

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
  let recent = 10;

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

/** La même base, privée du droit d'écrire. */
function readOnly(sql: Sql): Sql {
  return {
    driver: sql.driver,
    async query<T>(text: string, params?: readonly unknown[]): Promise<T[]> {
      assertReadOnlyStatement(text, 'sales:shadow');
      return sql.query<T>(text, params);
    },
    async exec(): Promise<void> {
      throw new Error('sales:shadow est en lecture seule : exec est refusé');
    },
    async transaction<T>(): Promise<T> {
      throw new Error('sales:shadow est en lecture seule : transaction est refusée');
    },
    async close(): Promise<void> {
      await sql.close();
    },
  };
}

function pad(label: string): string {
  return label.padEnd(26, ' ');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sql = readOnly(await getSql());

  const library = loadSalesKnowledge();
  process.stdout.write(
    `BIBLIOTHÈQUE ${library.version} — ${String(library.sources.length)} source(s), ` +
      `${String(library.principles.length)} principes, ${String(library.injectable.length)} injectables` +
      `${library.gap === null ? '' : ` [${library.gap}]`}\n\n`,
  );

  const ids = args.inboundId !== null
    ? [args.inboundId]
    : (
        await sql.query<{ id: string }>(
          `select i.id
             from r6b_inbound_messages i
             join r6b_reply_analyses a on a.inbound_message_id = i.id and a.status = 'ACTIVE'
            where i.correlation_status in ('EXACT','HIGH_CONFIDENCE')
            order by i.received_at desc
            limit $1`,
          [args.recent],
        )
      ).map((row) => row.id);

  if (ids.length === 0) {
    process.stdout.write('Aucune conversation exploitable.\n');
    await sql.close();
    return;
  }

  let changed = 0;
  const totals = { qualified: 0, handoff: 0, trialAllowed: 0, escalationLifted: 0, withRefs: 0 };

  for (const id of ids) {
    const context = await loadReplyContext(sql, id);
    if (context === null) continue;
    const analysis = await loadActiveAnalysis(sql, id);
    if (analysis === null) continue;

    const understanding = await understandConversation(sql, context, analysis);

    // Les deux lectures commerciales, r1 puis r2, sur le MÊME texte.
    const demands = readCommercialDemands(context.reply.bodyText);
    const beforeEscalation = demands[0] ?? null; // r1 : la première demande, quelle qu'elle soit
    const afterEscalation = firstEscalatingDemand(demands); // r2 : la première qui ENGAGE

    // « Sans la connaissance de vente » : le rail éteint, tout le reste égal.
    const without = buildSalesKnowledgeInjection({
      enabled: false,
      library,
      context: {
        goal: understanding.state.goal,
        offerStage: understanding.offer.stage,
        questionTopic: understanding.signals.questionTopic,
        objectionTopic: understanding.signals.objectionTopic,
        appointmentQualification: understanding.appointment.qualification,
      },
    });
    const withKnowledge = understanding.salesKnowledge;

    const escalationLifted = beforeEscalation !== null && afterEscalation === null;
    if (escalationLifted) totals.escalationLifted += 1;
    if (understanding.appointment.qualification === 'QUALIFIED_FOR_CALL') totals.qualified += 1;
    if (understanding.appointment.handoff === 'HUMAN_CLOSE_REQUIRED') totals.handoff += 1;
    if (understanding.trialDisclosure === 'ALLOWED') totals.trialAllowed += 1;
    if (withKnowledge !== null) totals.withRefs += 1;
    if (escalationLifted || withKnowledge !== null) changed += 1;

    process.stdout.write(`── ${id}  [${context.prospect.displayName}]\n`);
    process.stdout.write(`   ${pad('catégorie / confiance')}${analysis.classification} ${analysis.confidence.toFixed(2)}\n`);
    process.stdout.write(`   ${pad('objectif du tour')}${understanding.state.goal}\n`);
    process.stdout.write(`   ${pad('palier commercial')}${understanding.offer.stage} (${understanding.offer.readiness})\n`);
    process.stdout.write(`   ${pad('maturité échange')}${understanding.signals.callReadiness}\n`);
    process.stdout.write(
      `   ${pad('rendez-vous')}${understanding.appointment.qualification}:${understanding.appointment.gate}` +
        ` → ${understanding.appointment.handoff}\n`,
    );
    process.stdout.write(`   ${pad('ciblage observé')}${understanding.icpConformity}\n`);
    process.stdout.write(`   ${pad('essai divulgable')}${understanding.trialDisclosure}\n`);
    process.stdout.write(
      `   ${pad('escalade r1 → r2')}` +
        `${beforeEscalation === null ? 'aucune' : `${beforeEscalation.demand}`}` +
        ` → ${afterEscalation === null ? 'aucune' : `${afterEscalation.demand}:${afterEscalation.reason ?? ''}`}` +
        `${escalationLifted ? '   ⟵ LEVÉE' : ''}\n`,
    );
    process.stdout.write(
      `   ${pad('repères sans / avec')}${String(without?.directives.length ?? 0)} / ` +
        `${String(withKnowledge?.directives.length ?? 0)}\n`,
    );
    if (withKnowledge !== null) {
      for (const ref of withKnowledge.refs) {
        process.stdout.write(
          `   ${pad('')}· ${ref.id} [${ref.topic}] ${ref.timestampStart}–${ref.timestampEnd} ${ref.classification}\n`,
        );
      }
    }
    process.stdout.write('\n');
  }

  process.stdout.write(
    `RÉSUMÉ — ${String(ids.length)} conversation(s) rejouées, ${String(changed)} avec une différence.\n` +
      `  QUALIFIED_FOR_CALL      : ${String(totals.qualified)}\n` +
      `  HUMAN_CLOSE_REQUIRED    : ${String(totals.handoff)}\n` +
      `  essai divulgable        : ${String(totals.trialAllowed)}\n` +
      `  escalades levées (r1→r2): ${String(totals.escalationLifted)}\n` +
      `  tours avec repères      : ${String(totals.withRefs)}\n` +
      '  messages envoyés        : 0 (aucun chemin d’effet dans ce module)\n',
  );

  await sql.close();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
