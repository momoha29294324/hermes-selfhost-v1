/**
 * R6B-D2 / D2.1 puis CRM1 — la frontière CRM EXTERNE, côté « réponse ».
 *
 * ---------------------------------------------------------------------------
 * Ce que CRM1 change : le CRM canonique est ici, pas ailleurs
 * ---------------------------------------------------------------------------
 *
 * D2/D2.1 supposaient qu'un CRM était forcément un tiers. Le dossier commercial
 * d'un prospect vit pourtant intégralement dans ce dépôt — identité, preuve,
 * recherche, score, manifeste, envoi, réponse, classification, brouillon, état
 * commercial, alertes — et `/crm` le lit directement (`src/lib/crm/queries.ts`).
 *
 * Ce module ne décrit donc plus « la » destination : il décrit la projection
 * EXTERNE, optionnelle, vers un CRM tiers. Son absence n'est plus un manque à
 * combler, c'est le régime normal — d'où `LOCAL_ONLY`, qui remplace
 * `SKIPPED_NOT_CONFIGURED` : le dossier est complet, localement, et personne
 * n'attend GoHighLevel pour travailler.
 *
 * ---------------------------------------------------------------------------
 * Ce qui n'a pas changé
 * ---------------------------------------------------------------------------
 *
 *   * une corrélation `HIGH_CONFIDENCE` reste `BLOCKED_POLICY` dès qu'une
 *     destination externe existe — savoir ce qu'un message dit n'est pas savoir
 *     qui l'a écrit, et une écriture chez un tiers exige `EXACT` ;
 *   * une catégorie non `crmEligible` ne projette toujours rien ;
 *   * `BLOCKED_CONFIG` reste le refus d'une destination NOMMÉE mais non
 *     confirmée en base (sous-compte non confirmé, `location_id` qui ne
 *     correspond pas, étape non cartographiée) ;
 *   * une ligne existe toujours, parce que l'état de la copie externe doit
 *     rester VISIBLE plutôt que silencieux.
 */

import type { Sql } from '@/lib/db/sql';
import { applyCrmProjection, CrmProjectionRefusal } from '@/lib/crm/apply';
import { buildCrmNote, type ProposedResponseStatus } from '@/lib/crm/note';
import { buildCrmPayload, hashCrmPayload, type CrmPayload } from '@/lib/crm/payload';
import { CrmPermanentError, type CrmNoteRequest, type CrmResolution } from '@/lib/crm/types';
import type { StoredAnalysis } from '@/lib/replies/analyses';
import type { ReplyContext } from '@/lib/replies/context';
import type { OutreachState } from '@/lib/replies/taxonomy';

// ---------------------------------------------------------------------------
// La projection
// ---------------------------------------------------------------------------

export type CrmProjectionStatus =
  | 'PENDING'
  /**
   * Le dossier canonique est tenu localement et aucune projection externe n'a
   * été demandée. Ni un échec, ni une attente : le régime normal du dépôt.
   */
  | 'LOCAL_ONLY'
  /** Ancien nom de `LOCAL_ONLY` (migration 0028). Plus jamais écrit. */
  | 'SKIPPED_NOT_CONFIGURED'
  | 'BLOCKED_POLICY'
  | 'BLOCKED_CONFIG'
  | 'APPLIED'
  | 'FAILED'
  | 'FAILED_PERMANENT';

/**
 * Les états qu'une exécution ultérieure peut faire avancer sans reclasser.
 *
 * `LOCAL_ONLY` en fait partie, et ce n'est pas une contradiction avec « le CRM
 * externe n'est pas requis » : cette liste n'est lue que par
 * `npm run r6b:crm:sync`, une commande explicite, en dry-run par défaut. Elle
 * sert à RATTRAPER l'historique le jour où quelqu'un confirmerait une
 * destination externe. Aucun chemin de runtime — ni le traitement des
 * réponses, ni les alertes, ni `/crm` — ne s'arrête sur l'un de ces états.
 */
export const RETRYABLE_CRM_STATUSES: readonly CrmProjectionStatus[] = [
  'PENDING',
  'LOCAL_ONLY',
  'SKIPPED_NOT_CONFIGURED',
  'BLOCKED_CONFIG',
  'FAILED',
];

export interface CrmProjectionRow {
  readonly id: string;
  readonly prospectId: string;
  readonly provider: string;
  readonly status: CrmProjectionStatus;
  readonly payloadSha256: string;
  readonly externalContactId: string | null;
  readonly attempts: number;
  readonly lastError: string | null;
}

/**
 * Le CRM canonique de Hermes : ce dépôt lui-même.
 *
 * Nommer le fournisseur `hermes_local` plutôt que `unconfigured` n'est pas
 * cosmétique. `unconfigured` affirmait qu'il manquait quelque chose ; c'est
 * l'inverse qui est vrai — le dossier commercial complet est ici, et
 * GoHighLevel n'en serait qu'une copie pour un tiers.
 */
export const LOCAL_CRM_PROVIDER = 'hermes_local';

export interface ProjectInput {
  readonly context: ReplyContext;
  readonly analysis: StoredAnalysis;
  readonly outreachState: OutreachState;
  /** Faux quand la politique de corrélation interdit toute écriture externe (§14 D2). */
  readonly externalWriteAllowed: boolean;
  readonly resolution: CrmResolution;
  /** L'état de la réponse proposée, pour l'historique déposé chez le fournisseur. */
  readonly proposedResponseStatus?: ProposedResponseStatus;
}

export interface ProjectResult {
  readonly projection: CrmProjectionRow;
  readonly status: CrmProjectionStatus;
  readonly wrote: boolean;
  readonly detail: string;
}

interface UpsertRowInput {
  readonly prospectId: string;
  readonly inboundMessageId: string | null;
  readonly analysisId: string | null;
  readonly manifestId: string;
  readonly provider: string;
  readonly destinationId: string | null;
  readonly status: CrmProjectionStatus;
  readonly payload: CrmPayload;
  readonly payloadSha256: string;
  readonly lastError: string | null;
  readonly externalContactId: string | null;
  readonly externalOpportunityId: string | null;
  readonly externalStage: string | null;
  readonly countsAsAttempt: boolean;
}

/**
 * Écrit (ou met à jour) LA ligne de projection de ce prospect.
 *
 * Une seule par prospect, garantie par l'index unique de 0027. Le conflit porte
 * sur `prospect_id` seul, et pas sur `(prospect_id, provider)` : `provider`
 * passe de `'unconfigured'` à un vrai nom le jour où une destination est
 * confirmée, et traiter ces deux valeurs comme deux clés produirait deux lignes
 * pour le même prospect — dont une périmée que la reprise relirait sans fin.
 */
export async function upsertProjectionRow(sql: Sql, input: UpsertRowInput): Promise<CrmProjectionRow> {
  const rows = await sql.query<CrmProjectionRow>(
    `insert into r6b_crm_projections
       (prospect_id, provider, destination_id, inbound_message_id, analysis_id, manifest_id, status,
        payload, payload_sha256, external_contact_id, external_opportunity_id, external_stage,
        attempts, last_error, last_attempt_at, applied_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,
             case when $13::boolean then 1 else 0 end,
             $14,
             case when $13::boolean then now() else null end,
             case when $7 = 'APPLIED' then now() else null end)
     on conflict (prospect_id) do update
        set provider = excluded.provider,
            destination_id = coalesce(excluded.destination_id, r6b_crm_projections.destination_id),
            inbound_message_id = excluded.inbound_message_id,
            analysis_id = excluded.analysis_id,
            manifest_id = excluded.manifest_id,
            status = excluded.status,
            payload = excluded.payload,
            payload_sha256 = excluded.payload_sha256,
            -- Un identifiant externe déjà connu n'est JAMAIS effacé par une
            -- tentative ultérieure : c'est lui qui empêche un second contact
            -- d'être créé chez le fournisseur.
            external_contact_id = coalesce(excluded.external_contact_id, r6b_crm_projections.external_contact_id),
            external_opportunity_id = coalesce(excluded.external_opportunity_id, r6b_crm_projections.external_opportunity_id),
            external_stage = coalesce(excluded.external_stage, r6b_crm_projections.external_stage),
            attempts = r6b_crm_projections.attempts + case when $13::boolean then 1 else 0 end,
            last_error = excluded.last_error,
            last_attempt_at = case when $13::boolean then now() else r6b_crm_projections.last_attempt_at end,
            applied_at = case when excluded.status = 'APPLIED' then now() else r6b_crm_projections.applied_at end,
            updated_at = now()
     returning id,
               prospect_id       as "prospectId",
               provider,
               status,
               payload_sha256    as "payloadSha256",
               external_contact_id as "externalContactId",
               attempts,
               last_error        as "lastError"`,
    [
      input.prospectId,
      input.provider,
      input.destinationId,
      input.inboundMessageId,
      input.analysisId,
      input.manifestId,
      input.status,
      JSON.stringify(input.payload),
      input.payloadSha256,
      input.externalContactId,
      input.externalOpportunityId,
      input.externalStage,
      input.countsAsAttempt,
      input.lastError,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('r6b_crm_projections upsert did not return a row');
  return row;
}

/**
 * Construit l'historique à déposer chez le fournisseur pour cette réponse.
 *
 * Extrait ici plutôt qu'en ligne parce que `r6b:crm:sync` doit produire
 * EXACTEMENT la même note pour la même réponse : c'est son empreinte qui
 * empêche un rejeu d'en déposer une seconde.
 */
export function buildProjectionNote(
  context: ReplyContext,
  analysis: StoredAnalysis,
  payload: CrmPayload,
  proposedResponseStatus: ProposedResponseStatus,
): CrmNoteRequest {
  return buildCrmNote({
    payload,
    firstTouchSentAt: context.firstTouch.sentAt,
    firstTouchSubject: context.firstTouch.subject,
    firstTouchBody: context.firstTouch.body,
    replyFrom: context.reply.fromAddress,
    replySubject: context.reply.subject,
    replyBody: context.reply.bodyText,
    reasoningSummary: analysis.reasoningSummary,
    recommendedNextAction: analysis.recommendedNextAction,
    proposedResponseStatus,
  });
}

/**
 * Enregistre l'état de la COPIE externe d'un prospect, ou dit pourquoi il n'y
 * en a pas.
 *
 * Ne lève jamais : un CRM externe indisponible ne doit pas faire échouer la
 * classification qui vient d'aboutir. L'échec devient un ÉTAT retentable
 * (`FAILED`) ou définitif (`FAILED_PERMANENT`), et rien n'oblige à reclasser
 * pour le rejouer.
 *
 * L'ordre des refus commence par l'absence de destination (CRM1) et non plus
 * par la politique de corrélation. La raison est simple : sans destination
 * externe, il n'y a pas d'écriture externe à interdire — annoncer
 * `BLOCKED_POLICY` reviendrait à dire qu'on a refusé quelque chose que
 * personne n'a demandé, et à faire passer un dossier local complet pour un
 * dossier bloqué. La corrélation reste dite, dans `detail`, pour que
 * l'information ne soit pas perdue le jour où une destination apparaîtra.
 */
export async function projectToCrm(sql: Sql, input: ProjectInput): Promise<ProjectResult> {
  const payload = buildCrmPayload(input.context, input.analysis, input.outreachState);
  const payloadSha256 = hashCrmPayload(payload);

  const base = {
    prospectId: input.context.prospect.id,
    inboundMessageId: input.context.reply.id,
    analysisId: input.analysis.id,
    manifestId: input.context.firstTouch.manifestId,
    payload,
    payloadSha256,
    externalContactId: null,
    externalOpportunityId: null,
    externalStage: null,
  } as const;

  // 1. Aucune destination externe NOMMÉE : le dossier canonique est local et
  //    complet. Rien n'attend, rien n'est bloqué, rien n'a échoué.
  if (!input.resolution.configured && input.resolution.kind === 'NOT_CONFIGURED') {
    const projection = await upsertProjectionRow(sql, {
      ...base,
      provider: LOCAL_CRM_PROVIDER,
      destinationId: null,
      status: 'LOCAL_ONLY',
      lastError: null,
      countsAsAttempt: false,
    });
    return Object.freeze({
      projection,
      status: 'LOCAL_ONLY' as const,
      wrote: false,
      detail:
        'dossier commercial canonique tenu localement (/crm) — aucune projection externe demandée' +
        (input.externalWriteAllowed
          ? ''
          : ` · corrélation ${input.context.reply.correlationStatus} : une future destination externe la refuserait`),
    });
  }

  // 2. Une destination externe EST nommée. La politique de corrélation passe
  //    donc devant : une identité d'envoi non prouvée interdit l'écriture chez
  //    un tiers, même si tout le reste est en règle.
  if (!input.externalWriteAllowed) {
    const projection = await upsertProjectionRow(sql, {
      ...base,
      provider: input.resolution.configured ? input.resolution.provider.name : LOCAL_CRM_PROVIDER,
      destinationId: null,
      status: 'BLOCKED_POLICY',
      lastError: null,
      countsAsAttempt: false,
    });
    return Object.freeze({
      projection,
      status: 'BLOCKED_POLICY' as const,
      wrote: false,
      detail:
        `corrélation ${input.context.reply.correlationStatus} — aucune écriture externe sans identité d'envoi ` +
        'prouvée ; le dossier local reste complet et la charge utile attend un arbitrage humain',
    });
  }

  // 3. Une destination nommée mais refusée (sous-compte non confirmé, etc.).
  if (!input.resolution.configured) {
    const projection = await upsertProjectionRow(sql, {
      ...base,
      provider: LOCAL_CRM_PROVIDER,
      destinationId: null,
      status: 'BLOCKED_CONFIG',
      lastError: null,
      countsAsAttempt: false,
    });
    return Object.freeze({
      projection,
      status: 'BLOCKED_CONFIG' as const,
      wrote: false,
      detail: input.resolution.reason,
    });
  }

  // 4. L'écriture externe.
  const { provider, target } = input.resolution;
  const note = buildProjectionNote(
    input.context,
    input.analysis,
    payload,
    input.proposedResponseStatus ?? 'NONE',
  );

  try {
    const applied = await applyCrmProjection(sql, {
      provider,
      target,
      payload,
      note,
      analysisId: input.analysis.id,
    });
    const projection = await upsertProjectionRow(sql, {
      ...base,
      provider: provider.name,
      destinationId: target.destination.id,
      status: 'APPLIED',
      lastError: null,
      externalContactId: applied.outcome.externalContactId,
      externalOpportunityId: applied.outcome.externalOpportunityId,
      externalStage: applied.outcome.externalStage,
      countsAsAttempt: true,
    });
    return Object.freeze({
      projection,
      status: 'APPLIED' as const,
      wrote: true,
      detail:
        `contact ${applied.outcome.externalContactId} ${applied.outcome.contactCreated ? 'créé' : 'mis à jour'} ` +
        `chez ${provider.name} · étape « ${applied.stage.stageName} »` +
        `${applied.outcome.externalOpportunityId === null ? '' : ` · opportunité ${applied.outcome.externalOpportunityId}`}` +
        `${applied.noteSkipped ? ' · note déjà déposée' : ''}`,
    });
  } catch (error) {
    const status = classifyProjectionError(error);
    const message = error instanceof Error ? error.message : String(error);
    const projection = await upsertProjectionRow(sql, {
      ...base,
      provider: provider.name,
      destinationId: status === 'BLOCKED_CONFIG' ? null : target.destination.id,
      status,
      lastError: message.slice(0, 1000),
      // Un refus de configuration ou de politique n'est pas une TENTATIVE :
      // rien n'a été demandé au fournisseur. Le compter gonflerait un
      // compteur d'échecs avec des décisions locales.
      countsAsAttempt: status === 'FAILED' || status === 'FAILED_PERMANENT',
    });
    return Object.freeze({
      projection,
      status,
      wrote: false,
      detail: `${message}${status === 'FAILED' ? ' — retentable sans reclasser' : ''}`,
    });
  }
}

/**
 * Traduit une erreur en état de projection.
 *
 * Le défaut est `FAILED` (retentable) et c'est délibéré : classer par excès une
 * panne inconnue comme définitive ferait abandonner une projection qu'un simple
 * rejeu aurait appliquée.
 */
export function classifyProjectionError(error: unknown): CrmProjectionStatus {
  if (error instanceof CrmProjectionRefusal) return error.status;
  if (error instanceof CrmPermanentError) return 'FAILED_PERMANENT';
  return 'FAILED';
}
