import type { Sql } from '@/lib/db/sql';
import type { DispatchEnvelope } from '@/lib/pipeline/r6bTransportAdapters';
import { ensureContacted } from '@/lib/replies/state';
import { recordJobEvent } from '@/lib/instagram/events';
import type { DeliveryAdjudication } from '@/lib/instagram/deliveryProof';
import type { InstagramJob } from '@/lib/instagram/queue';
import type { ThreadObservation } from '@/lib/instagram/threadObservation';
import type { InstagramJobStatus, InstagramReasonCode } from '@/lib/instagram/types';

/**
 * IG2.1 §5 — inscrire l'issue d'un canari déjà tenté, et rien de plus.
 *
 * La règle qui gouverne tout ce fichier : une adjudication RÉCONCILIE un effet
 * déjà observé, elle n'en produit aucun. Aucune fonction d'ici n'ouvre de
 * navigateur, ne consomme d'autorisation, ne lève l'arrêt global, ni ne
 * réenfile un job. La seule chose qui bouge est la description de ce qui s'est
 * passé le 14 août — pas ce qui se passe aujourd'hui chez le prospect.
 *
 * Les trois issues n'écrivent pas les mêmes choses, et l'écart est le sujet :
 *
 *   * `DELIVERY_FAILED` — journal, statut du job, ligne d'adjudication. AUCUN
 *     `outreach_event` : rien n'est parti, donc personne n'a été joint, donc la
 *     table qui atteste d'un contact n'a rien à dire. Écrire l'événement
 *     « pour la trace » ferait entrer un contact fictif dans le CRM, le gate et
 *     les plafonds ;
 *   * `SENT` — les trois mêmes écritures PLUS l'`outreach_event` canonique qui
 *     manquait, exactement une fois, sous l'index unique de 0023 ;
 *   * `AMBIGUOUS` — rien. Le job reste `REVIEW_REQUIRED`. Un « je ne sais
 *     toujours pas » n'est pas une décision à graver.
 */

export interface CanaryAdjudicationRow {
  readonly id: string;
  readonly jobId: string;
  readonly manifestId: string;
  readonly verdict: DeliveryAdjudication['verdict'];
  readonly adjudicatedBy: string;
  readonly observedBy: string;
  readonly detail: string;
  readonly screenshotPath: string | null;
  readonly blockedWriteRequests: number;
  readonly openClicks: number;
  readonly createdAt: string;
}

const ADJUDICATION_COLUMNS = `id, job_id as "jobId", manifest_id as "manifestId", verdict,
        adjudicated_by as "adjudicatedBy", observed_by as "observedBy", detail,
        screenshot_path as "screenshotPath", blocked_write_requests as "blockedWriteRequests",
        open_clicks as "openClicks", created_at as "createdAt"`;

/** La décision la plus récente sur ce job, s'il y en a une. */
export async function loadCanaryAdjudication(sql: Sql, jobId: string): Promise<CanaryAdjudicationRow | null> {
  const rows = await sql.query<CanaryAdjudicationRow>(
    `select ${ADJUDICATION_COLUMNS} from ig_canary_adjudications
      where job_id = $1 order by created_at desc limit 1`,
    [jobId],
  );
  return rows[0] ?? null;
}

export async function listCanaryAdjudications(sql: Sql, jobId: string): Promise<CanaryAdjudicationRow[]> {
  return sql.query<CanaryAdjudicationRow>(
    `select ${ADJUDICATION_COLUMNS} from ig_canary_adjudications where job_id = $1 order by created_at desc`,
    [jobId],
  );
}

export class CanaryAdjudicationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CanaryAdjudicationError';
    this.code = code;
  }
}

export interface CommitAdjudicationInput {
  readonly job: InstagramJob;
  readonly envelope: DispatchEnvelope;
  readonly adjudication: DeliveryAdjudication;
  readonly observation: ThreadObservation;
  readonly adjudicatedBy: string;
  readonly workerId: string;
}

export interface CommittedAdjudication {
  readonly adjudicationId: string | null;
  readonly jobStatus: InstagramJobStatus;
  readonly eventId: string | null;
  readonly outreachEventId: string | null;
  readonly outreachState: string | null;
  readonly detail: string;
}

/**
 * Inscrit le verdict, ou refuse.
 *
 * Les préconditions sont vérifiées ici plutôt que supposées par l'appelant,
 * parce que ce sont elles qui distinguent une réconciliation d'une invention :
 * on ne peut adjuger que ce qui a été TENTÉ, sous l'autorisation qui a couvert
 * la tentative, et à partir d'un état qui attend justement une décision.
 */
export async function commitCanaryAdjudication(
  sql: Sql,
  input: CommitAdjudicationInput,
): Promise<CommittedAdjudication> {
  const { job, envelope, adjudication, observation } = input;
  const adjudicatedBy = input.adjudicatedBy.trim();

  if (adjudicatedBy.length === 0) {
    throw new CanaryAdjudicationError(
      'IG_ADJUDICATION_NO_OPERATOR',
      'adjudication refusée : --as est obligatoire — une issue d’envoi réel se constate au nom de quelqu’un',
    );
  }
  if (!job.externalEffectAttempted) {
    throw new CanaryAdjudicationError(
      'IG_ADJUDICATION_NO_EFFECT',
      `le job ${job.id} n'a jamais tenté d'effet externe — il n'y a rien à adjuger`,
    );
  }
  if (job.canaryAuthorizationId === null) {
    throw new CanaryAdjudicationError(
      'IG_ADJUDICATION_NO_AUTHORIZATION',
      `le job ${job.id} porte une tentative sans autorisation rattachée — état incohérent, refus`,
    );
  }

  // ---- L'indécision ne s'inscrit pas -------------------------------------
  if (adjudication.verdict === 'AMBIGUOUS') {
    return Object.freeze({
      adjudicationId: null,
      jobStatus: job.status,
      eventId: null,
      outreachEventId: null,
      outreachState: null,
      detail:
        'verdict AMBIGUOUS — aucune écriture. Le job reste en attente d’un humain, ' +
        'et l’observation reste disponible dans le fichier de preuve.',
    });
  }

  // ---- Déjà tranché ? On ne rejoue pas une décision -----------------------
  const previous = await listCanaryAdjudications(sql, job.id);
  const same = previous.find((row) => row.verdict === adjudication.verdict);
  if (same !== undefined) {
    return Object.freeze({
      adjudicationId: same.id,
      jobStatus: job.status,
      eventId: null,
      outreachEventId: null,
      outreachState: null,
      detail:
        `le job ${job.id} porte déjà une adjudication ${same.verdict} du ${same.createdAt} ` +
        `par ${same.adjudicatedBy} — aucune écriture, une décision ne se recompte pas`,
    });
  }
  const contradicting = previous.find((row) => row.verdict !== adjudication.verdict);
  if (contradicting !== undefined) {
    throw new CanaryAdjudicationError(
      'IG_ADJUDICATION_CONTRADICTS_PRIOR',
      `le job ${job.id} porte déjà une adjudication ${contradicting.verdict} par ${contradicting.adjudicatedBy} — ` +
        `un verdict ${adjudication.verdict} la contredirait. Deux lectures qui divergent se tranchent à la main, ` +
        'pas par écrasement.',
    );
  }

  const jobStatus: InstagramJobStatus = adjudication.verdict === 'SENT' ? 'SENT' : 'DELIVERY_FAILED';
  const reasonCode: InstagramReasonCode =
    adjudication.verdict === 'SENT' ? 'IG_LIVE_SENT_RECONCILED' : 'IG_LIVE_DELIVERY_FAILED';

  const evidence = {
    verdict: adjudication.verdict,
    scope: adjudication.scope,
    bubbles: adjudication.bubbles,
    outgoing_bubbles: adjudication.outgoingBubbles,
    failure_markers: adjudication.failureMarkers,
    thread_handle: adjudication.threadHandle,
    proofs: adjudication.proofs,
    thread_url: observation.threadUrl,
    session_state: observation.sessionState,
    ancestor_chain: observation.ancestorChain,
    nodes_observed: observation.nodes.length,
    harvest_truncated: observation.truncated,
  };

  const adjudicationId = await sql.transaction(async (tx) => {
    const rows = await tx.query<{ id: string }>(
      `insert into ig_canary_adjudications
         (job_id, manifest_id, prospect_id, canary_authorization_id, verdict,
          adjudicated_by, observed_by, evidence, detail, screenshot_path,
          blocked_write_requests, open_clicks)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)
       returning id`,
      [
        job.id,
        job.manifestId,
        job.prospectId,
        job.canaryAuthorizationId,
        adjudication.verdict,
        adjudicatedBy,
        input.workerId,
        JSON.stringify(evidence),
        adjudication.detail.slice(0, 2000),
        observation.screenshotPath,
        observation.blockedWriteRequests,
        observation.openClicks,
      ],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('ig_canary_adjudications insert did not return a row');

    // Le statut du job : `where` restrictif plutôt que confiance dans la
    // lecture qui précède. Un job repris entre-temps ne doit pas être écrasé.
    const updated = await tx.query<{ id: string }>(
      `update ig_dispatch_jobs
          set status = $2,
              last_reason_code = $3,
              last_detail = $4,
              terminated_at = coalesce(terminated_at, now()),
              updated_at = now()
        where id = $1
          and external_effect_attempted = true
          and status in ('REVIEW_REQUIRED', 'DELIVERY_FAILED')
        returning id`,
      [job.id, jobStatus, reasonCode, adjudication.detail.slice(0, 1000)],
    );
    if (updated.length !== 1) {
      throw new CanaryAdjudicationError(
        'IG_ADJUDICATION_JOB_NOT_PENDING_REVIEW',
        `le job ${job.id} n'est pas en attente d'adjudication (statut « ${job.status} ») — refus`,
      );
    }
    return id;
  });

  const eventId = await recordJobEvent(sql, {
    jobId: job.id,
    manifestId: job.manifestId,
    prospectId: job.prospectId,
    sessionId: null,
    workerId: input.workerId,
    mode: 'LIVE',
    status: adjudication.verdict === 'SENT' ? 'SENT' : 'DELIVERY_FAILED',
    reasonCode,
    idempotencyKey: job.idempotencyKey,
    expectedHandle: job.expectedHandle,
    observedHandle: adjudication.threadHandle,
    sessionState: observation.sessionState,
    gates: adjudication.proofs.map((proof) => ({
      gate: proof.proof,
      verdict: proof.verdict,
      detail: proof.detail,
    })),
    durationMs: observation.durationMs,
    detail: `adjudication ${adjudication.verdict} par ${adjudicatedBy} : ${adjudication.detail}`.slice(0, 2000),
    // La tentative EST celle du 14 août : l'événement décrit son issue, il n'en
    // déclare pas une nouvelle. Le drapeau reste donc `true`, et l'autorisation
    // rattachée reste celle qui l'a couverte.
    externalEffectAttempted: true,
    canaryAuthorizationId: job.canaryAuthorizationId,
  });

  if (adjudication.verdict === 'DELIVERY_FAILED') {
    return Object.freeze({
      adjudicationId,
      jobStatus,
      eventId,
      outreachEventId: null,
      outreachState: null,
      detail:
        'échec de livraison inscrit. Aucun outreach_event : rien n’est parti, donc personne n’a été joint. ' +
        'Le job est terminal et ne sera pas rejoué.',
    });
  }

  // ---- SENT : l'artefact canonique manquant, exactement une fois ----------
  const outcome = await reconcileSentOutreach(sql, {
    envelope,
    job,
    canaryId: job.canaryAuthorizationId,
    threadUrl: observation.threadUrl,
    adjudicatedBy,
  });

  return Object.freeze({
    adjudicationId,
    jobStatus,
    eventId,
    outreachEventId: outcome.outreachEventId,
    outreachState: outcome.outreachState,
    detail: outcome.created
      ? 'envoi confirmé et outreach_event canonique créé — réconciliation d’un effet déjà observé'
      : 'envoi confirmé ; l’outreach_event existait déjà — aucune duplication',
  });
}

/**
 * Écrit l'`outreach_event` manquant, ou constate qu'il existe.
 *
 * L'idempotence ne repose pas sur ce code mais sur l'index unique
 * `outreach_events_one_sent_per_manifest_idx` (0023), qui refuserait un second
 * événement pour le même manifeste quel que soit le chemin qui l'écrit. Le
 * `select` préalable sert à rendre un résultat lisible, pas à garantir
 * l'unicité — cette garantie-là appartient à la base.
 */
async function reconcileSentOutreach(
  sql: Sql,
  input: {
    envelope: DispatchEnvelope;
    job: InstagramJob;
    canaryId: string;
    threadUrl: string;
    adjudicatedBy: string;
  },
): Promise<{ outreachEventId: string; outreachState: string | null; created: boolean }> {
  const existing = await sql.query<{ id: string }>(
    `select id from outreach_events where manifest_id = $1 and kind = 'sent' limit 1`,
    [input.envelope.manifestId],
  );
  const known = existing[0]?.id;
  if (known !== undefined) {
    return { outreachEventId: known, outreachState: null, created: false };
  }

  const outreachEventId = await sql.transaction(async (tx) => {
    const rows = await tx.query<{ id: string }>(
      `insert into outreach_events (prospect_id, kind, channel, payload, manifest_id)
       values ($1,'sent',$2,$3::jsonb,$4)
       returning id`,
      [
        input.envelope.prospectId,
        input.envelope.transport,
        JSON.stringify({
          rail: 'instagram',
          action: input.job.action,
          recipient: input.envelope.recipient,
          approved_text_sha256: input.envelope.approvedTextSha256,
          transport_payload_sha256: input.envelope.transportPayloadSha256,
          idempotency_key: input.job.idempotencyKey,
          ig_job_id: input.job.id,
          canary_authorization_id: input.canaryId,
          thread_url: input.threadUrl,
          // Ce qui distingue cette ligne de celle qu'un envoi prouvé aurait
          // écrite sur-le-champ : elle est datée d'aujourd'hui pour un effet
          // d'hier, et elle nomme qui l'a constaté.
          reconciled: true,
          reconciled_by: input.adjudicatedBy,
          external_effect_started_at: input.job.externalEffectStartedAt,
        }),
        input.envelope.manifestId,
      ],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('outreach_events insert did not return a row');
    return id;
  });

  const transition = await ensureContacted(sql, input.envelope.prospectId, outreachEventId);
  return { outreachEventId, outreachState: transition?.toState ?? null, created: true };
}
