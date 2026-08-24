import type { Sql } from '@/lib/db/sql';
import type { EligibilityDecision } from '@/lib/instagram/eligibility';
import {
  skipClassOf,
  type GateRecord,
  type InstagramAction,
  type InstagramIdentitySignal,
  type InstagramIdentityVerdict,
  type InstagramMode,
  type InstagramReasonCode,
  type InstagramSessionState,
  type InstagramSkipReason,
} from '@/lib/instagram/types';

/**
 * IG-R1 §8 — les trois écritures d'audit du rail.
 *
 * Toutes sont des INSERT. Aucune fonction de ce module ne met à jour ni ne
 * supprime une ligne : un journal qu'on réécrit ne prouve rien (même
 * raisonnement qu'en 0021 pour `r6b_dispatch_attempts`).
 *
 * Ce que ces écritures ne touchent jamais : `outreach_events`. Un DRY-RUN est
 * un artefact d'audit, pas un contact — et la table qui atteste qu'un humain a
 * été joint reste hors de ce fichier et hors du worker DRY-RUN.
 *
 * IG2 — elle n'est plus hors de TOUT chemin Instagram : un envoi réel existe, et
 * il écrit son `outreach_event`. Mais il l'écrit à un seul endroit
 * (`liveWorker.ts`), dans la transaction terminale d'un `SENT` prouvé, sous
 * l'index unique `outreach_events_one_sent_per_manifest_idx` (0023). Le journal
 * d'audit, lui, reste ce qu'il est : des faits, pas des contacts.
 */

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export async function recordBrowserSession(
  sql: Sql,
  input: {
    workerId: string;
    profileLabel: string;
    headless: boolean;
    state: InstagramSessionState;
    detail: string | null;
  },
): Promise<string> {
  const rows = await sql.query<{ id: string }>(
    `insert into ig_browser_sessions (worker_id, profile_label, headless, state, detail)
     values ($1,$2,$3,$4,$5) returning id`,
    [input.workerId, input.profileLabel, input.headless, input.state, input.detail],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('ig_browser_sessions insert did not return a row');
  return id;
}

export async function closeBrowserSession(sql: Sql, sessionId: string): Promise<void> {
  await sql.query(`update ig_browser_sessions set closed_at = now() where id = $1 and closed_at is null`, [sessionId]);
}

// ---------------------------------------------------------------------------
// Identité
// ---------------------------------------------------------------------------

export async function recordIdentityCheck(
  sql: Sql,
  input: {
    jobId: string | null;
    manifestId: string;
    prospectId: string;
    sessionId: string | null;
    expectedHandle: string;
    observedHandle: string | null;
    observedUrl: string | null;
    redirected: boolean;
    verdict: InstagramIdentityVerdict;
    signals: readonly InstagramIdentitySignal[];
    detail: string | null;
  },
): Promise<string> {
  const rows = await sql.query<{ id: string }>(
    `insert into ig_identity_checks
       (job_id, manifest_id, prospect_id, session_id, expected_handle, observed_handle,
        observed_url, redirected, verdict, provider, method, signals, detail)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'instagram_web','browser_profile_page',$10::jsonb,$11)
     returning id`,
    [
      input.jobId,
      input.manifestId,
      input.prospectId,
      input.sessionId,
      input.expectedHandle,
      input.observedHandle,
      input.observedUrl,
      input.redirected,
      input.verdict,
      JSON.stringify(input.signals),
      input.detail,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('ig_identity_checks insert did not return a row');
  return id;
}

// ---------------------------------------------------------------------------
// Journal des tentatives
// ---------------------------------------------------------------------------

/**
 * IG3 §10 — les statuts d'événement, cycle de vie compris.
 *
 * Les cinq premiers sont des FAITS DE PARCOURS (une intention est entrée, un
 * worker a pris le bail, l'ordonnanceur a reporté, le traitement a commencé, il
 * s'est terminé) ; les suivants sont des ISSUES. La distinction compte parce
 * qu'un fait de parcours ne peut, par construction, porter aucun effet externe
 * — et la base le contraint (`ig_job_event_lifecycle_has_no_effect`, 0039).
 *
 * `DRY_RUN_OK` reste dans l'union pour les lignes écrites avant IG3 ; le worker
 * écrit désormais `DRY_RUN_COMPLETED`, le mot de la mission.
 */
export type JobEventStatus =
  | 'ENQUEUED'
  | 'CLAIMED'
  | 'SKIPPED'
  | 'DRY_RUN_STARTED'
  | 'DRY_RUN_COMPLETED'
  | 'REVIEW_REQUIRED'
  | 'DRY_RUN_OK'
  | 'BLOCKED'
  | 'FAILED'
  | 'SENT'
  | 'AMBIGUOUS'
  | 'DELIVERY_FAILED';

export interface JobEventRecord {
  readonly jobId: string | null;
  readonly manifestId: string | null;
  readonly prospectId: string | null;
  readonly sessionId: string | null;
  readonly workerId: string;
  readonly mode: InstagramMode;
  readonly status: JobEventStatus;
  readonly reasonCode: InstagramReasonCode;
  readonly idempotencyKey: string;
  readonly expectedHandle: string | null;
  readonly observedHandle: string | null;
  readonly sessionState: InstagramSessionState | null;
  readonly gates: readonly GateRecord[];
  readonly durationMs: number | null;
  readonly detail: string | null;
  /**
   * IG2 §4 — la primitive d'envoi a-t-elle été appelée pour cette tentative ?
   *
   * C'était écrit `false` en dur, « parce qu'aucun code de ce dépôt ne peut
   * produire un effet Instagram », et le commentaire annonçait qu'un envoi
   * ferait de cette valeur un diff visible ici. C'est ce diff.
   *
   * Le paramètre n'ouvre pas la porte à un mensonge : la base garde ses trois
   * contraintes (0029) — un DRY_RUN ne peut pas déclarer d'effet, un `BLOCKED`
   * non plus, et `SENT`/`AMBIGUOUS` n'existent qu'en LIVE avec effet. Elle en
   * gagne une quatrième (0031) : un effet déclaré sans autorisation canari
   * rattachée est refusé.
   */
  readonly externalEffectAttempted: boolean;
  readonly canaryAuthorizationId: string | null;
  /**
   * IG3 §8 — le motif de report, dans le vocabulaire fermé. Obligatoire quand
   * `status` vaut `SKIPPED` (la base le contraint), interdit nulle part
   * ailleurs mais rarement utile.
   *
   * La classe TEMPORARY/TERMINAL n'est pas un paramètre : elle se DÉDUIT du
   * motif (`skipClassOf`). Laisser l'appelant la choisir aurait permis
   * d'inscrire un opt-out comme temporaire, c'est-à-dire de le rejouer.
   */
  readonly skipReason?: InstagramSkipReason | null;
  /** IG3 §4 — l'instant à partir duquel ce job redevient traitable. */
  readonly nextEligibleAt?: string | Date | null;
}

/** Écrit une ligne du journal. */
export async function recordJobEvent(sql: Sql, record: JobEventRecord): Promise<string> {
  const skipReason = record.skipReason ?? null;
  const rows = await sql.query<{ id: string }>(
    `insert into ig_job_events
       (job_id, manifest_id, prospect_id, session_id, worker_id, mode, status, reason_code,
        idempotency_key, expected_handle, observed_handle, session_state, gates,
        external_effect_attempted, duration_ms, detail, canary_authorization_id,
        skip_reason, skip_class, next_eligible_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18,$19,$20)
     returning id`,
    [
      record.jobId,
      record.manifestId,
      record.prospectId,
      record.sessionId,
      record.workerId,
      record.mode,
      record.status,
      record.reasonCode,
      record.idempotencyKey,
      record.expectedHandle,
      record.observedHandle,
      record.sessionState,
      JSON.stringify(record.gates),
      record.externalEffectAttempted,
      record.durationMs,
      record.detail,
      record.canaryAuthorizationId,
      skipReason,
      skipReason === null ? null : skipClassOf(skipReason),
      record.nextEligibleAt instanceof Date ? record.nextEligibleAt.toISOString() : (record.nextEligibleAt ?? null),
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('ig_job_events insert did not return a row');
  return id;
}

// ---------------------------------------------------------------------------
// Journal d'éligibilité (IG3 §2/§10)
// ---------------------------------------------------------------------------

/**
 * Écrit le verdict rendu sur une demande d'enfilement — favorable ou non.
 *
 * Append-only comme tout le reste de ce fichier. La contrainte
 * `ig_enqueue_job_only_when_eligible` (0039) fait que cette fonction ne PEUT
 * pas rattacher un job à un refus : si un appelant s'y trompait, la transaction
 * échouerait plutôt que d'inscrire une file peuplée par une porte fermée.
 */
export async function recordEnqueueDecision(
  sql: Sql,
  input: {
    requestedManifestId: string;
    action: InstagramAction;
    decision: EligibilityDecision;
    jobId: string | null;
    jobCreated: boolean;
    requestedBy: string;
  },
): Promise<string> {
  const { decision } = input;
  // `expected_handle` porte une contrainte de FORME (0039). Un manifeste dont le
  // transport n'est pas Instagram a pour destinataire une adresse e-mail, qui
  // n'en est pas un — et un refus qu'on ne peut pas écrire parce que le
  // destinataire n'a pas la bonne tête serait un refus invisible, c'est-à-dire
  // le contraire de ce que cette table sert à garantir. Le destinataire reste
  // dans `reason`, en toutes lettres.
  const handle = decision.expectedHandle !== null && /^[A-Za-z0-9._]{1,30}$/.test(decision.expectedHandle)
    ? decision.expectedHandle
    : null;
  const rows = await sql.query<{ id: string }>(
    `insert into ig_enqueue_decisions
       (prospect_id, manifest_id, requested_manifest_id, action, expected_handle,
        verdict, reason_code, reason, gates, job_id, job_created, requested_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)
     returning id`,
    [
      decision.prospectId,
      decision.manifestId,
      input.requestedManifestId,
      input.action,
      handle,
      decision.verdict,
      decision.reasonCode,
      decision.detail.slice(0, 1000),
      JSON.stringify(decision.gates),
      input.jobId,
      input.jobCreated,
      input.requestedBy,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('ig_enqueue_decisions insert did not return a row');
  return id;
}

export interface StoredEnqueueDecision {
  readonly id: string;
  readonly prospectId: string | null;
  readonly manifestId: string | null;
  readonly expectedHandle: string | null;
  readonly verdict: 'ELIGIBLE' | 'INELIGIBLE' | 'REVIEW_REQUIRED';
  readonly reasonCode: string;
  readonly reason: string;
  readonly jobId: string | null;
  readonly jobCreated: boolean;
  readonly requestedBy: string;
  readonly createdAt: string;
}

export async function listEnqueueDecisions(sql: Sql, limit = 20): Promise<StoredEnqueueDecision[]> {
  return sql.query<StoredEnqueueDecision>(
    `select id, prospect_id as "prospectId", manifest_id as "manifestId",
            expected_handle as "expectedHandle", verdict, reason_code as "reasonCode", reason,
            job_id as "jobId", job_created as "jobCreated", requested_by as "requestedBy",
            created_at as "createdAt"
       from ig_enqueue_decisions order by created_at desc, id desc limit $1`,
    [limit],
  );
}
