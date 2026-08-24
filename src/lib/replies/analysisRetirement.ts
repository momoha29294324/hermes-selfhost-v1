/**
 * HERMES-ACTIVE-ANALYSIS-VERSION-CONFLICT-R1 — écarter une analyse rendue par
 * un runtime périmé.
 *
 * ---------------------------------------------------------------------------
 * Le défaut que ce module répare, et le seul
 * ---------------------------------------------------------------------------
 * Un processus long — `ig:inbound:run --loop` — garde le code chargé à son
 * démarrage. Un commit qui change `REPLY_CLASSIFIER_PROMPT_VERSION` ne
 * l'atteint pas, et il continue d'écrire des analyses sous une version que plus
 * aucun code ne produit. Quand il en écrit une, `persistAnalysis` fait ce qu'on
 * lui demande : la conclusion vivante — canonique — passe en `SUPERSEDED`.
 *
 * Rejouer le traitement ne peut pas défaire cela. `r6b_reply_analyses_identity_idx`
 * est unique sur toute l'histoire : la conclusion canonique existe déjà, donc
 * elle ne peut pas être réécrite, et `persistAnalysis` lève
 * `AnalysisHistoryConflict`. C'est le bon comportement — revenir en arrière
 * demande une décision humaine. Ce module EST cette décision, écrite.
 *
 * ---------------------------------------------------------------------------
 * Ce qu'il ne fait pas
 * ---------------------------------------------------------------------------
 * Il ne juge AUCUN contenu. La seule chose qu'il sait constater est
 * arithmétique : la version d'exécution de la ligne vivante n'est pas la
 * version canonique d'aujourd'hui. Une analyse rendue sous la version courante
 * lui est INTOUCHABLE, quoi qu'un opérateur en pense — c'est un refus par
 * construction (`ANALYSIS_VERSION_IS_CANONICAL`), pas une politesse.
 *
 * Il n'automatise RIEN. Aucun appelant de production ne l'importe : ni
 * `processReply`, ni le rail entrant, ni le rail de réponse. La seule porte est
 * `npm run replies:analysis:retire`, qui exige un nom, un motif et `--apply`.
 *
 * Il n'efface RIEN. La ligne écartée reste en base, avec son modèle, son
 * prompt, sa confiance et son résumé. Le lien de supersession qu'il faut
 * dénouer pour réinstaller la ligne canonique est consigné dans
 * `r6b_reply_analysis_retirements` avant de disparaître de la ligne.
 *
 * Il ne touche à AUCUN effet. Si un plan porte déjà une tentative d'effet sur
 * ce message — `external_effect_attempted` —, il refuse : l'analyse est le
 * socle sur lequel ce message est parti, et la déplacer réécrirait la raison
 * d'un fait extérieur. Un effet tenté n'est jamais rejoué, et sa cause n'est
 * jamais réécrite.
 */

import type { Sql } from '@/lib/db/sql';
import { REPLY_CLASSIFIER_PROMPT_VERSION } from '@/lib/replies/classifier';
import { loadActiveAnalysis, type StoredAnalysis } from '@/lib/replies/analyses';

/** Les raisons de REFUSER. Toutes terminales — aucune n'est réessayée seule. */
export type RetirementRefusal =
  | 'NO_ACTIVE_ANALYSIS'
  | 'ANALYSIS_VERSION_IS_CANONICAL'
  | 'EXTERNAL_EFFECT_ATTEMPTED'
  | 'REINSTATEMENT_AMBIGUOUS'
  | 'REINSTATEMENT_NOT_FOUND'
  | 'OPERATOR_MISSING'
  | 'REASON_MISSING';

export interface RetirementRefused {
  readonly outcome: 'REFUSED';
  readonly refusal: RetirementRefusal;
  readonly detail: string;
}

export interface RetirementPlanned {
  /** `PLANNED` en simulation, `APPLIED` quand la transaction a écrit. */
  readonly outcome: 'PLANNED' | 'APPLIED';
  /** L'analyse écartée. */
  readonly retired: StoredAnalysis;
  /** La ligne canonique remise en vie, ou `null` s'il n'y en avait aucune. */
  readonly reinstated: StoredAnalysis | null;
  /** Le lien de supersession dénoué pour cela, le cas échéant. */
  readonly unlinkedSupersededBy: string | null;
  readonly canonicalPromptVersion: string;
  /** Identifiant de la ligne de journal, seulement quand `APPLIED`. */
  readonly journalId: string | null;
}

export type RetirementResult = RetirementRefused | RetirementPlanned;

export interface RetireStaleAnalysisInput {
  readonly inboundMessageId: string;
  readonly operator: string;
  readonly reason: string;
  /**
   * La ligne canonique à réinstaller, quand plusieurs candidates existent.
   * Jamais nécessaire dans le cas ordinaire — il n'y en a qu'une, ou aucune.
   */
  readonly reinstateAnalysisId?: string | null;
  /** Faux — le défaut — n'écrit RIEN et rend le geste qui serait fait. */
  readonly apply?: boolean;
  /**
   * La version qui fait autorité. Injectable pour les tests uniquement ; en
   * production c'est la constante du classifieur, et rien d'autre.
   */
  readonly canonicalPromptVersion?: string;
}

interface CandidateRow {
  id: string;
  status: string;
  superseded_by: string | null;
  created_at: string | Date;
}

function refuse(refusal: RetirementRefusal, detail: string): RetirementRefused {
  return Object.freeze({ outcome: 'REFUSED' as const, refusal, detail });
}

/**
 * Écarte l'analyse vivante d'un message quand sa version d'exécution n'est plus
 * canonique, et réinstalle la conclusion canonique si elle existe.
 *
 * Tout se joue dans UNE transaction : l'index partiel `..._one_active_idx`
 * n'autorise qu'une ligne ACTIVE par message, donc la sortie de l'une doit
 * précéder l'entrée de l'autre, et une interruption entre les deux laisserait
 * un message sans analyse vivante.
 */
export async function retireStaleAnalysis(
  sql: Sql,
  input: RetireStaleAnalysisInput,
): Promise<RetirementResult> {
  const operator = input.operator.trim();
  const reason = input.reason.trim();
  const canonical = input.canonicalPromptVersion ?? REPLY_CLASSIFIER_PROMPT_VERSION;
  const apply = input.apply === true;

  if (operator.length < 2) {
    return refuse('OPERATOR_MISSING', 'un geste d’opérateur porte le nom d’une personne, pas un vide');
  }
  if (reason.length < 8) {
    return refuse('REASON_MISSING', 'écarter une analyse demande un motif écrit, conservé au journal');
  }

  return sql.transaction(async (tx) => {
    const active = await loadActiveAnalysis(tx, input.inboundMessageId);
    if (active === null) {
      return refuse(
        'NO_ACTIVE_ANALYSIS',
        `aucune analyse vivante pour ${input.inboundMessageId} — il n’y a rien à écarter`,
      );
    }

    // LA porte. Une analyse rendue sous la version d'aujourd'hui n'est pas
    // périmée, et aucun opérateur ne peut le décider à la place de cette
    // comparaison. C'est ce refus qui empêche cette commande de devenir « un
    // moyen de reclasser ce qui déplaît ».
    if (active.promptVersion === canonical) {
      return refuse(
        'ANALYSIS_VERSION_IS_CANONICAL',
        `l’analyse vivante ${active.id} porte la version canonique (${canonical}) — ` +
          'elle n’est pas périmée, et cette commande ne juge pas les contenus',
      );
    }

    // Un effet extérieur déjà tenté sur ce message : refus définitif. Déplacer
    // l'analyse réécrirait la raison pour laquelle quelque chose est parti.
    const effects = await tx.query<{ id: string }>(
      `select id from hermes_conversation_plans
        where trigger_inbound_message_id = $1 and external_effect_attempted = true
        limit 1`,
      [input.inboundMessageId],
    );
    if (effects.length > 0) {
      return refuse(
        'EXTERNAL_EFFECT_ATTEMPTED',
        `le plan ${effects[0]!.id} porte une tentative d’effet sur ce message — ` +
          'la cause d’un fait extérieur ne se réécrit pas',
      );
    }

    // Les candidates à la réinstallation : les conclusions rendues sous la
    // version canonique, écartées par la ligne périmée ou par une autre.
    const candidates = await tx.query<CandidateRow>(
      `select id, status, superseded_by, created_at
         from r6b_reply_analyses
        where inbound_message_id = $1 and prompt_version = $2 and status = 'SUPERSEDED'
        order by created_at desc`,
      [input.inboundMessageId, canonical],
    );

    let chosen: CandidateRow | null = null;
    const named = input.reinstateAnalysisId ?? null;
    if (named !== null) {
      chosen = candidates.find((row) => row.id === named) ?? null;
      if (chosen === null) {
        return refuse(
          'REINSTATEMENT_NOT_FOUND',
          `${named} n’est pas une analyse ${canonical} écartée de ce message`,
        );
      }
    } else if (candidates.length > 1) {
      // Plusieurs conclusions canoniques ont existé — contextes différents.
      // Choisir « la plus récente » serait une décision de produit prise par
      // une commande de réparation. Elle demande le nom.
      return refuse(
        'REINSTATEMENT_AMBIGUOUS',
        `${candidates.length} analyses ${canonical} écartées existent pour ce message ` +
          `(${candidates.map((row) => row.id).join(', ')}) — nommer celle à réinstaller`,
      );
    } else {
      chosen = candidates[0] ?? null;
    }

    if (!apply) {
      const preview = chosen === null ? null : await readAnalysis(tx, chosen.id);
      return Object.freeze({
        outcome: 'PLANNED' as const,
        retired: active,
        reinstated: preview,
        unlinkedSupersededBy: chosen?.superseded_by ?? null,
        canonicalPromptVersion: canonical,
        journalId: null,
      });
    }

    // Le journal AVANT les `update` : il porte `superseded_by` tel qu'il est
    // encore, et une interruption après lui laisserait une trace de trop, ce
    // qui est le côté sûr. La FK vers l'analyse existe déjà dans les deux cas.
    const journal = await tx.query<{ id: string }>(
      `insert into r6b_reply_analysis_retirements
         (analysis_id, inbound_message_id, previous_status, retired_prompt_version,
          canonical_prompt_version, reinstated_analysis_id, unlinked_superseded_by, operator, reason)
       values ($1,$2,'ACTIVE',$3,$4,$5,$6,$7,$8)
       returning id`,
      [
        active.id,
        input.inboundMessageId,
        active.promptVersion,
        canonical,
        chosen?.id ?? null,
        chosen?.superseded_by ?? null,
        operator,
        reason,
      ],
    );

    // La sortie précède l'entrée : `..._one_active_idx` n'est pas différable.
    await tx.query(`update r6b_reply_analyses set status = 'RETIRED' where id = $1`, [active.id]);

    if (chosen !== null) {
      await tx.query(
        `update r6b_reply_analyses
            set status = 'ACTIVE', superseded_by = null, superseded_at = null
          where id = $1`,
        [chosen.id],
      );
    }

    return Object.freeze({
      outcome: 'APPLIED' as const,
      retired: active,
      reinstated: chosen === null ? null : await readAnalysis(tx, chosen.id),
      unlinkedSupersededBy: chosen?.superseded_by ?? null,
      canonicalPromptVersion: canonical,
      journalId: journal[0]?.id ?? null,
    });
  });
}

async function readAnalysis(tx: Sql, id: string): Promise<StoredAnalysis | null> {
  const rows = await tx.query<{ inboundMessageId: string }>(
    `select inbound_message_id as "inboundMessageId" from r6b_reply_analyses where id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  const active = await loadActiveAnalysis(tx, row.inboundMessageId);
  if (active !== null && active.id === id) return active;
  // La ligne n'est pas (encore) vivante — en simulation, ou avant l'`update`.
  // On la rend telle qu'elle est, sans mentir sur son statut : seuls ses champs
  // de conclusion intéressent l'appelant.
  const full = await tx.query<Record<string, unknown>>(
    `select id, inbound_message_id as "inboundMessageId", manifest_id as "manifestId",
            prospect_id as "prospectId", correlation_status as "correlationStatus", classification,
            confidence, reasoning_summary as "reasoningSummary",
            recommended_next_action as "recommendedNextAction",
            requires_human_review as "requiresHumanReview",
            decided_deterministically as "decidedDeterministically", model, effort,
            prompt_version as "promptVersion", input_sha256 as "inputSha256", created_at as "createdAt"
       from r6b_reply_analyses where id = $1`,
    [id],
  );
  const one = full[0];
  if (!one) return null;
  return Object.freeze({
    ...(one as unknown as StoredAnalysis),
    confidence: Number(one['confidence']),
    createdAt: new Date(one['createdAt'] as string).toISOString(),
  });
}
