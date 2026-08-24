/**
 * R6B-D2 — la persistance d'une analyse de réponse.
 *
 * L'idempotence de cette couche est le socle de tout le reste : l'état
 * commercial, la projection CRM, l'alerte et le brouillon pendent tous d'une
 * analyse. Si retraiter un message pouvait produire une seconde analyse, il
 * produirait aussi une seconde alerte, un second brouillon et une seconde
 * écriture CRM — la duplication se propagerait vers l'extérieur.
 *
 * Deux index la garantissent, tous deux en base :
 *
 *   * `r6b_reply_analyses_one_active_idx` — au plus une analyse ACTIVE par
 *     message entrant. Un lecteur qui demande « l'analyse de cette réponse »
 *     ne peut jamais trouver deux réponses possibles ;
 *   * `r6b_reply_analyses_identity_idx` — le quadruplet (message, version de
 *     prompt, modèle, empreinte du contexte) n'apparaît qu'une fois dans toute
 *     l'histoire. Rejouer exactement le même traitement n'écrit rien.
 */

import { randomUUID } from 'node:crypto';
import {
  isCurrentRequestTopic,
  type CurrentRequestTopic,
} from '@/lib/conversation/currentRequest';
import type { Sql } from '@/lib/db/sql';
import type { ClassificationResult } from '@/lib/replies/classifier';
import type { ReplyContext } from '@/lib/replies/context';
import type { NextAction, ReplyCategory } from '@/lib/replies/taxonomy';
import type { ProcessableCorrelation } from '@/lib/replies/taxonomy';

export interface StoredAnalysis {
  readonly id: string;
  readonly inboundMessageId: string;
  readonly manifestId: string;
  readonly prospectId: string;
  readonly correlationStatus: ProcessableCorrelation;
  readonly classification: ReplyCategory;
  readonly confidence: number;
  readonly reasoningSummary: string;
  readonly recommendedNextAction: NextAction;
  readonly requiresHumanReview: boolean;
  readonly decidedDeterministically: boolean;
  readonly model: string;
  readonly effort: string | null;
  readonly promptVersion: string;
  readonly inputSha256: string;
  /**
   * HERMES-SEMANTIC-GROUNDING-R1 — ce que la personne nous demandait MAINTENANT,
   * selon le modèle qui a rendu cette analyse.
   *
   * `null` sur toute analyse écrite avant ce round, et sur une lecture
   * déterministe. Le code le traite comme une ABSENCE D'OPINION, jamais comme
   * une absence de demande : il ne s'en sert que pour AJOUTER une escalade, si
   * bien que `null` ne peut rien ouvrir.
   */
  readonly currentRequest: CurrentRequestTopic | null;
  /** Ce qu'elle RAPPORTE. Descriptif : aucune porte ne le lit. */
  readonly reportedContent: readonly string[];
  readonly createdAt: string;
}

interface AnalysisRow {
  id: string;
  inboundMessageId: string;
  manifestId: string;
  prospectId: string;
  correlationStatus: ProcessableCorrelation;
  classification: ReplyCategory;
  confidence: string | number;
  reasoningSummary: string;
  recommendedNextAction: NextAction;
  requiresHumanReview: boolean;
  decidedDeterministically: boolean;
  model: string;
  effort: string | null;
  promptVersion: string;
  inputSha256: string;
  currentRequest: string | null;
  reportedContent: string[] | null;
  createdAt: string | Date;
}

const ANALYSIS_COLUMNS = `id,
        inbound_message_id        as "inboundMessageId",
        manifest_id               as "manifestId",
        prospect_id               as "prospectId",
        correlation_status        as "correlationStatus",
        classification,
        confidence,
        reasoning_summary         as "reasoningSummary",
        recommended_next_action   as "recommendedNextAction",
        requires_human_review     as "requiresHumanReview",
        decided_deterministically as "decidedDeterministically",
        model,
        effort,
        prompt_version            as "promptVersion",
        input_sha256              as "inputSha256",
        current_request           as "currentRequest",
        reported_content          as "reportedContent",
        created_at                as "createdAt"`;

function toAnalysis(row: AnalysisRow): StoredAnalysis {
  return Object.freeze({
    id: row.id,
    inboundMessageId: row.inboundMessageId,
    manifestId: row.manifestId,
    prospectId: row.prospectId,
    correlationStatus: row.correlationStatus,
    classification: row.classification,
    confidence: Number(row.confidence),
    reasoningSummary: row.reasoningSummary,
    recommendedNextAction: row.recommendedNextAction,
    requiresHumanReview: row.requiresHumanReview,
    decidedDeterministically: row.decidedDeterministically,
    model: row.model,
    effort: row.effort,
    promptVersion: row.promptVersion,
    inputSha256: row.inputSha256,
    // Fail-closed sur la FORME : une valeur hors vocabulaire vaut `null`, donc
    // « aucune opinion », donc aucune escalade ajoutée. La contrainte `check`
    // de 0058 la refuserait de toute façon à l'écriture.
    currentRequest: isCurrentRequestTopic(row.currentRequest) ? row.currentRequest : null,
    reportedContent: Object.freeze(row.reportedContent ?? []),
    createdAt: new Date(row.createdAt).toISOString(),
  });
}

/** L'analyse vivante d'un message entrant, s'il en a une. */
export async function loadActiveAnalysis(sql: Sql, inboundMessageId: string): Promise<StoredAnalysis | null> {
  const rows = await sql.query<AnalysisRow>(
    `select ${ANALYSIS_COLUMNS} from r6b_reply_analyses
      where inbound_message_id = $1 and status = 'ACTIVE'`,
    [inboundMessageId],
  );
  const row = rows[0];
  return row ? toAnalysis(row) : null;
}

export interface PersistAnalysisResult {
  readonly analysis: StoredAnalysis;
  /** Faux quand la base connaissait déjà cette conclusion — le cas normal d'un rejeu. */
  readonly created: boolean;
  /** Identifiant de l'analyse invalidée par celle-ci, le cas échéant. */
  readonly supersededId: string | null;
}

/**
 * Erreur d'histoire : cette conclusion exacte a déjà existé, puis a été
 * invalidée.
 *
 * Ne peut survenir qu'en revenant à une version de prompt antérieure après en
 * avoir appliqué une plus récente. Ce n'est pas un cas normal, et le traiter en
 * silence — réactiver l'ancienne, ou en écrire une copie — reviendrait à
 * effacer le fait qu'un humain a changé d'avis deux fois.
 */
export class AnalysisHistoryConflict extends Error {
  constructor(inboundMessageId: string, promptVersion: string) {
    super(
      `une analyse identique (${promptVersion}) existe déjà pour ${inboundMessageId} et a été invalidée — ` +
        'revenir à une version de prompt antérieure demande une décision humaine explicite',
    );
    this.name = 'AnalysisHistoryConflict';
  }
}

/**
 * Écrit une analyse, une seule fois.
 *
 * Trois issues, dans cet ordre :
 *
 *   1. la même conclusion (même prompt, même modèle, même contexte) est déjà
 *      ACTIVE → on la rend telle quelle, sans rien écrire ;
 *   2. une autre conclusion est ACTIVE → elle est invalidée, la nouvelle prend
 *      sa place. L'ancienne reste lisible avec le modèle qui l'a produite ;
 *   3. rien n'est ACTIVE → insertion simple.
 */
export async function persistAnalysis(
  sql: Sql,
  context: ReplyContext,
  result: ClassificationResult,
  evidenceExcerpts: unknown = result.evidenceExcerpts,
): Promise<PersistAnalysisResult> {
  return sql.transaction(async (tx) => {
    const existing = await loadActiveAnalysis(tx, context.reply.id);
    if (
      existing !== null &&
      existing.promptVersion === result.promptVersion &&
      existing.model === result.model &&
      existing.inputSha256 === result.inputSha256
    ) {
      return Object.freeze({ analysis: existing, created: false, supersededId: null });
    }

    const historical = await tx.query<{ id: string }>(
      `select id from r6b_reply_analyses
        where inbound_message_id = $1 and prompt_version = $2 and model = $3 and input_sha256 = $4`,
      [context.reply.id, result.promptVersion, result.model, result.inputSha256],
    );
    if (historical.length > 0) throw new AnalysisHistoryConflict(context.reply.id, result.promptVersion);

    const newId = randomUUID();
    if (existing !== null) {
      // L'UPDATE précède l'INSERT : l'index partiel `..._one_active_idx` n'est
      // pas différable, donc l'ancienne ligne doit quitter le statut ACTIVE
      // avant que la nouvelle y entre. `superseded_by` désigne une ligne qui
      // n'existe pas encore — ce que la FK `deferrable initially deferred`
      // autorise, vérifiée au commit. Même mécanique que `lockManifestForItem`.
      await tx.query(
        `update r6b_reply_analyses
            set status = 'SUPERSEDED', superseded_at = now(), superseded_by = $2
          where id = $1`,
        [existing.id, newId],
      );
    }

    await tx.query(
      `insert into r6b_reply_analyses
         (id, inbound_message_id, manifest_id, prospect_id, correlation_status,
          classification, confidence, reasoning_summary, evidence_excerpts,
          requires_human_review, recommended_next_action, decided_deterministically,
          model, effort, prompt_version, input_sha256, model_run_id,
          current_request, reported_content, status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'ACTIVE')`,
      [
        newId,
        context.reply.id,
        context.firstTouch.manifestId,
        context.prospect.id,
        context.reply.correlationStatus,
        result.category,
        result.confidence,
        result.reasoningSummary,
        JSON.stringify(evidenceExcerpts),
        result.requiresHumanReview,
        result.recommendedNextAction,
        result.decidedDeterministically,
        result.model,
        result.effort,
        result.promptVersion,
        result.inputSha256,
        result.modelRunId,
        result.currentRequest,
        result.reportedContent,
      ],
    );

    const rows = await tx.query<AnalysisRow>(
      `select ${ANALYSIS_COLUMNS} from r6b_reply_analyses where id = $1`,
      [newId],
    );
    const row = rows[0];
    if (!row) throw new Error('r6b_reply_analyses insert did not return a row');

    return Object.freeze({
      analysis: toAnalysis(row),
      created: true,
      supersededId: existing?.id ?? null,
    });
  });
}
