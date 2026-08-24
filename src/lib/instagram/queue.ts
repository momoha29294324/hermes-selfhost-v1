import type { Sql } from '@/lib/db/sql';
import type { InstagramRailConfig } from '@/lib/config/schema';
import { DispatchBlockedError } from '@/lib/pipeline/r6bDispatcher';
import type { DispatchEnvelope } from '@/lib/pipeline/r6bTransportAdapters';
import { evaluateInstagramEligibility, type EligibilityDecision } from '@/lib/instagram/eligibility';
import { recordEnqueueDecision, recordJobEvent } from '@/lib/instagram/events';
import {
  CLAIMABLE_JOB_STATUSES,
  skipClassOf,
  TERMINAL_JOB_STATUSES,
  type InstagramAction,
  type InstagramJobStatus,
  type InstagramReasonCode,
  type InstagramSkipClass,
  type InstagramSkipReason,
} from '@/lib/instagram/types';

/**
 * IG-R1 §3/§4 — la file durable Instagram et sa prise atomique.
 *
 * Ce module ne sait rien d'un navigateur, ne charge pas Playwright et ne peut
 * produire aucun effet Instagram. Il fait trois choses :
 *
 *   1. transformer une intention déjà approuvée (un manifeste R6B verrouillé)
 *      en un travail repris après un redémarrage ;
 *   2. attribuer ce travail à UN worker, et à un seul, quelle que soit la
 *      fenêtre de course ;
 *   3. refuser de rejouer ce qui ne doit pas l'être.
 *
 * Le point 2 ne repose sur aucune lecture préalable : ni « personne ne l'a
 * pris », ni un verrou applicatif. Il repose sur `for update skip locked`,
 * évalué par PostgreSQL dans la même instruction que l'écriture — deux workers
 * qui interrogent la file à la microseconde près obtiennent deux lignes
 * différentes, ou l'un d'eux n'obtient rien. C'est la primitive, pas une
 * précaution autour d'elle.
 */

// ---------------------------------------------------------------------------
// Idempotence
// ---------------------------------------------------------------------------

/**
 * IG-R1 §4 — la clé d'idempotence d'une intention Instagram.
 *
 * Déterministe et sans horloge : le même manifeste et la même action donnent
 * la même clé dans dix ans, sur une autre machine, après n'importe quel
 * redémarrage. C'est ce qui permet à la contrainte d'unicité de 0029 de
 * signifier quelque chose — une clé qui contiendrait un timestamp ou un UUID
 * aléatoire rendrait l'unicité vraie et inutile.
 *
 * Le préfixe nomme le rail et l'action. Un futur envoi le transmettra tel quel
 * au transport, comme `deriveIdempotencyKey` le fait pour l'email R6B ; deux
 * actions différentes sur le même manifeste ne se confondront donc jamais.
 */
export function deriveInstagramIdempotencyKey(manifestId: string, action: InstagramAction): string {
  return `ig-r1/${action}/${manifestId}`;
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

export interface InstagramJob {
  readonly id: string;
  readonly manifestId: string;
  readonly prospectId: string;
  readonly action: InstagramAction;
  readonly idempotencyKey: string;
  readonly expectedHandle: string;
  readonly approvedTextSha256: string;
  readonly transportPayloadSha256: string;
  readonly status: InstagramJobStatus;
  readonly attempts: number;
  readonly claimedBy: string | null;
  readonly claimToken: string | null;
  readonly leaseExpiresAt: string | null;
  readonly externalEffectAttempted: boolean;
  /** IG2 §4 — quand la primitive d'envoi a été appelée. `null` tant qu'elle ne l'a pas été. */
  readonly externalEffectStartedAt: string | null;
  /** L'autorisation canari consommée pour cette tentative, s'il y en a eu une. */
  readonly canaryAuthorizationId: string | null;
  /** IG3 — la borne de réclamation, c'est-à-dire le `scheduled_at` du job. */
  readonly notBefore: string;
  readonly lastReasonCode: string | null;
  readonly lastDetail: string | null;
  /** IG3 §8 — le dernier motif de report ou de refus, dans le vocabulaire fermé. */
  readonly lastSkipReason: InstagramSkipReason | null;
  readonly lastSkipClass: InstagramSkipClass | null;
  readonly skipCount: number;
  /** IG3 §4 — l'instant où le worker aurait agi, tel que l'ordonnanceur l'a calculé. */
  readonly lastPlannedFor: string | null;
  readonly lastDryRunAt: string | null;
  readonly terminatedAt: string | null;
  readonly createdAt: string;
}

const JOB_COLUMNS = `id, manifest_id as "manifestId", prospect_id as "prospectId", action,
        idempotency_key as "idempotencyKey", expected_handle as "expectedHandle",
        approved_text_sha256 as "approvedTextSha256", transport_payload_sha256 as "transportPayloadSha256",
        status, attempts, claimed_by as "claimedBy", claim_token as "claimToken",
        lease_expires_at as "leaseExpiresAt", external_effect_attempted as "externalEffectAttempted",
        external_effect_started_at as "externalEffectStartedAt",
        canary_authorization_id as "canaryAuthorizationId",
        not_before as "notBefore", last_reason_code as "lastReasonCode", last_detail as "lastDetail",
        last_skip_reason as "lastSkipReason", last_skip_class as "lastSkipClass",
        skip_count as "skipCount", last_planned_for as "lastPlannedFor", last_dry_run_at as "lastDryRunAt",
        terminated_at as "terminatedAt", created_at as "createdAt"`;

export async function loadInstagramJob(sql: Sql, jobId: string): Promise<InstagramJob | null> {
  const rows = await sql.query<InstagramJob>(`select ${JOB_COLUMNS} from ig_dispatch_jobs where id = $1`, [jobId]);
  return rows[0] ?? null;
}

export async function loadInstagramJobForManifest(
  sql: Sql,
  manifestId: string,
  action: InstagramAction,
): Promise<InstagramJob | null> {
  const rows = await sql.query<InstagramJob>(
    `select ${JOB_COLUMNS} from ig_dispatch_jobs where manifest_id = $1 and action = $2`,
    [manifestId, action],
  );
  return rows[0] ?? null;
}

export async function listInstagramJobs(sql: Sql, limit = 50): Promise<InstagramJob[]> {
  return sql.query<InstagramJob>(`select ${JOB_COLUMNS} from ig_dispatch_jobs order by created_at desc limit $1`, [
    limit,
  ]);
}

// ---------------------------------------------------------------------------
// Enfilement
// ---------------------------------------------------------------------------

export class InstagramQueueError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'InstagramQueueError';
    this.code = code;
  }
}

export interface EnqueueResult {
  readonly job: InstagramJob;
  /** `false` quand le job existait déjà : enfiler deux fois n'en crée jamais un second. */
  readonly created: boolean;
  readonly envelope: DispatchEnvelope;
  /** IG3 §2 — le verdict qui a autorisé l'entrée, et les portes qu'il a franchies. */
  readonly eligibility: EligibilityDecision;
  /** L'identifiant de la ligne `ig_enqueue_decisions` écrite pour cet appel. */
  readonly decisionId: string;
}

/**
 * IG3 §2 — refus d'éligibilité. Porte le verdict entier, pas seulement un code.
 *
 * Distincte de `InstagramQueueError` parce qu'elle dit autre chose : la file
 * fonctionne, et c'est le PROSPECT qui n'a rien à y faire. Un appelant peut donc
 * traiter les deux différemment — une erreur de file se corrige, un refus
 * d'éligibilité se respecte.
 */
export class InstagramEligibilityError extends Error {
  readonly code: string;
  readonly decision: EligibilityDecision;
  readonly decisionId: string;

  constructor(decision: EligibilityDecision, decisionId: string) {
    super(decision.detail);
    this.name = 'InstagramEligibilityError';
    this.code = decision.reasonCode;
    this.decision = decision;
    this.decisionId = decisionId;
  }
}

/**
 * Enfile l'intention portée par un manifeste verrouillé — si et seulement si
 * les dix portes de l'éligibilité passent.
 *
 * Ce qui a changé avec IG3, et pourquoi c'est ici plutôt que dans les CLI :
 * `evaluateInstagramEligibility` était tentant à mettre dans `ig:queue`, où on
 * l'aurait relu facilement. Mais une garde qui vit dans un CLI est une garde
 * qu'un second CLI, un test, ou un futur script contournera sans le savoir — et
 * la mission demande qu'AUCUN mécanisme ne puisse remettre un prospect hors ICP
 * dans une file commerciale. La seule façon de tenir cette phrase est de mettre
 * la porte sur le chemin, pas à côté.
 *
 * Le verdict est journalisé dans les trois cas (`ig_enqueue_decisions`), y
 * compris quand il refuse : un refus qui ne laisse pas de trace n'est ni
 * contestable ni comptable.
 *
 * Enfiler deux fois le même manifeste ne crée pas un second job : la ligne
 * existante est rendue telle quelle. Ce n'est pas une politesse, c'est la
 * contrainte `ig_dispatch_jobs_one_per_intent` (0029) — et si deux processus
 * enfilent simultanément, c'est la base qui départage, pas la lecture qui
 * précède.
 */
export async function enqueueInstagramJob(
  sql: Sql,
  input: { manifestId: string; action: InstagramAction; enqueuedBy: string },
): Promise<EnqueueResult> {
  const eligibility = await evaluateInstagramEligibility(sql, {
    manifestId: input.manifestId,
    action: input.action,
  });

  if (eligibility.verdict !== 'ELIGIBLE' || eligibility.envelope === null) {
    const decisionId = await recordEnqueueDecision(sql, {
      requestedManifestId: input.manifestId,
      action: input.action,
      decision: eligibility,
      jobId: null,
      jobCreated: false,
      requestedBy: input.enqueuedBy,
    });
    throw new InstagramEligibilityError(eligibility, decisionId);
  }

  const envelope = eligibility.envelope;
  const idempotencyKey = deriveInstagramIdempotencyKey(envelope.manifestId, input.action);

  const inserted = await sql.query<InstagramJob>(
    `insert into ig_dispatch_jobs
       (manifest_id, prospect_id, action, idempotency_key, expected_handle,
        approved_text_sha256, transport_payload_sha256, status, enqueued_by)
     values ($1,$2,$3,$4,$5,$6,$7,'PENDING',$8)
     on conflict (manifest_id, action) do nothing
     returning ${JOB_COLUMNS}`,
    [
      envelope.manifestId,
      envelope.prospectId,
      input.action,
      idempotencyKey,
      envelope.recipient,
      envelope.approvedTextSha256,
      envelope.transportPayloadSha256,
      input.enqueuedBy,
    ],
  );

  const created = inserted[0];
  const job =
    created ??
    // `do nothing` a mordu sur une contrainte : la ligne existe déjà.
    (await loadInstagramJobForManifest(sql, envelope.manifestId, input.action));

  if (!job) {
    // Introuvable par (manifest, action) : c'est la clé d'idempotence qui a
    // mordu, donc un job d'un AUTRE manifeste porte déjà cette clé. Impossible
    // tant que la dérivation reste injective — refuser plutôt que supposer.
    throw new InstagramQueueError(
      'IG_IDEMPOTENCY_KEY_COLLISION',
      `la clé ${idempotencyKey} est déjà prise par un autre job — la file refuse d'en créer un second`,
    );
  }

  const decisionId = await recordEnqueueDecision(sql, {
    requestedManifestId: input.manifestId,
    action: input.action,
    decision: eligibility,
    jobId: job.id,
    jobCreated: created !== undefined,
    requestedBy: input.enqueuedBy,
  });

  // IG3 §10 — l'entrée en file devient un fait daté, pas seulement une ligne
  // qui apparaît. Écrit une seule fois, à la création : un second enfilement
  // n'a rien enfilé, et un journal qui prétendrait le contraire ferait compter
  // deux intentions là où il n'y en a qu'une.
  if (created !== undefined) {
    await recordJobEvent(sql, {
      jobId: job.id,
      manifestId: job.manifestId,
      prospectId: job.prospectId,
      sessionId: null,
      workerId: input.enqueuedBy,
      mode: 'DRY_RUN',
      status: 'ENQUEUED',
      reasonCode: 'IG_ELIGIBLE',
      idempotencyKey: job.idempotencyKey,
      expectedHandle: job.expectedHandle,
      observedHandle: null,
      sessionState: null,
      gates: eligibility.gates,
      durationMs: null,
      detail: eligibility.detail,
      externalEffectAttempted: false,
      canaryAuthorizationId: null,
      skipReason: null,
      nextEligibleAt: job.notBefore,
    });
  }

  return { job, created: created !== undefined, envelope, eligibility, decisionId };
}

// ---------------------------------------------------------------------------
// Prise atomique
// ---------------------------------------------------------------------------

export interface ClaimInput {
  readonly workerId: string;
  readonly leaseMs: number;
  /** Restreint la prise à ce job précis. Absent : le prochain job dû de la file. */
  readonly jobId?: string;
  /**
   * IG2 §1 — jobs que CETTE exécution a déjà traités, donc à ne pas reprendre.
   *
   * Nécessaire depuis que l'intervalle de cadence a cessé d'être facturé aux
   * jobs sans effet : un DRY_RUN redevient réclamable immédiatement, et la
   * boucle du worker le reprendrait aussitôt — même profil rouvert cinq fois
   * dans la même minute. Repousser `not_before` pour l'éviter aurait été
   * réintroduire le bug corrigé, sous un autre nom : la charge se borne ici,
   * dans l'ordonnancement d'une exécution, pas dans un plafond d'envoi.
   */
  readonly excludeJobIds?: readonly string[];
}

/**
 * Réserve UN job pour UN worker, ou rien.
 *
 * Le `select … for update skip locked` verrouille la ligne candidate à
 * l'intérieur même de l'`update` : un second worker qui arrive pendant ce
 * verrou ne se met pas en attente (`skip locked`) — il passe au job suivant,
 * ou repart les mains vides. Aucune lecture applicative ne précède, donc
 * aucune fenêtre entre « c'est libre » et « je le prends ».
 *
 * Le bail reçoit un `claim_token` NEUF à chaque prise. C'est ce jeton, et pas
 * l'identité du worker, que `finalizeInstagramJob` exige : un worker dont le
 * bail a expiré et dont le job a été repris ne peut plus écrire le résultat
 * d'un travail qui ne lui appartient plus.
 *
 * Les statuts absorbants (`SENT`, `REVIEW_REQUIRED`) sont absents du `where` :
 * un job terminal n'est pas « ignoré », il est hors de la requête.
 */
export async function claimNextInstagramJob(sql: Sql, input: ClaimInput): Promise<InstagramJob | null> {
  const rows = await sql.query<InstagramJob>(
    `update ig_dispatch_jobs j
        set status = 'CLAIMED',
            claimed_by = $1,
            claim_token = gen_random_uuid(),
            claimed_at = now(),
            lease_expires_at = now() + ($2::bigint * interval '1 millisecond'),
            attempts = j.attempts + 1,
            updated_at = now()
      where j.id = (
        select c.id
          from ig_dispatch_jobs c
         where c.status = any($3::text[])
           and c.not_before <= now()
           and ($4::uuid is null or c.id = $4::uuid)
           and not (c.id = any($5::uuid[]))
         order by c.not_before asc, c.created_at asc
         for update skip locked
         limit 1
      )
      returning ${JOB_COLUMNS}`,
    [
      input.workerId,
      String(input.leaseMs),
      [...CLAIMABLE_JOB_STATUSES],
      input.jobId ?? null,
      [...(input.excludeJobIds ?? [])],
    ],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Fin de bail
// ---------------------------------------------------------------------------

export interface FinalizeInput {
  readonly jobId: string;
  /** Le jeton reçu à la prise. Sans lui, rien n'est écrit. */
  readonly claimToken: string;
  readonly status: Exclude<InstagramJobStatus, 'PENDING' | 'CLAIMED'>;
  readonly reasonCode: InstagramReasonCode;
  readonly detail: string | null;
  /** Prochaine date de reprise possible, en millisecondes depuis maintenant. */
  readonly notBeforeMs?: number;
  /**
   * IG3 §4 — la même chose, mais à l'instant près.
   *
   * L'emporte sur `notBeforeMs` quand les deux sont fournis. Un plafond qui se
   * libère à 14 h 03 min 12 s n'a pas de raison d'être arrondi à « dans une
   * heure » : la date exacte est connue, et c'est elle que le CLI affiche.
   */
  readonly notBefore?: Date;
  /** IG3 §8 — le motif de report ou de refus. La classe s'en déduit. */
  readonly skipReason?: InstagramSkipReason | null;
  /** IG3 §4 — l'instant où le worker aurait agi, tel que calculé. */
  readonly plannedFor?: Date | null;
  /** IG3 §6 — horodate le dernier passage en DRY-RUN complet. */
  readonly markDryRun?: boolean;
}

/**
 * Clôt le bail et écrit l'issue — si et seulement si le bail est encore celui
 * du worker qui écrit.
 *
 * `false` en retour signifie « ce job ne t'appartient plus » : bail expiré et
 * repris, ou déjà clos. Le worker ne doit alors RIEN faire d'autre — surtout
 * pas réessayer : quelqu'un d'autre a la main.
 *
 * IG3 — le motif de report est écrit ici, avec sa classe DÉDUITE et non
 * fournie. L'appelant ne choisit pas si son refus est temporaire : il nomme le
 * motif, et `skipClassOf` répond. C'est ce qui rend impossible d'inscrire un
 * opt-out comme reportable, et la base ajoute sa propre garde par-dessus
 * (`ig_job_terminal_skip_is_absorbing`, 0039) : un motif TERMINAL sur un statut
 * réclamable fait échouer la transaction.
 */
export async function finalizeInstagramJob(sql: Sql, input: FinalizeInput): Promise<boolean> {
  const skipReason = input.skipReason ?? null;
  const rows = await sql.query<{ id: string }>(
    `update ig_dispatch_jobs
        set status = $3,
            claim_token = null,
            claimed_by = null,
            claimed_at = null,
            lease_expires_at = null,
            last_reason_code = $4,
            last_detail = $5,
            not_before = coalesce($6::timestamptz, now() + ($7::bigint * interval '1 millisecond')),
            last_skip_reason = coalesce($8, last_skip_reason),
            last_skip_class = coalesce($9, last_skip_class),
            skip_count = skip_count + case when $8 is null then 0 else 1 end,
            last_planned_for = coalesce($10::timestamptz, last_planned_for),
            last_dry_run_at = case when $11 then now() else last_dry_run_at end,
            terminated_at = case when $3 = any($12::text[]) then now() else null end,
            updated_at = now()
      where id = $1 and claim_token = $2::uuid and status = 'CLAIMED'
      returning id`,
    [
      input.jobId,
      input.claimToken,
      input.status,
      input.reasonCode,
      input.detail,
      input.notBefore?.toISOString() ?? null,
      String(input.notBeforeMs ?? 0),
      skipReason,
      skipReason === null ? null : skipClassOf(skipReason),
      input.plannedFor?.toISOString() ?? null,
      input.markDryRun === true,
      [...TERMINAL_JOB_STATUSES],
    ],
  );
  return rows.length === 1;
}

// ---------------------------------------------------------------------------
// IG2 §4 — l'inscription durable d'une tentative d'effet
// ---------------------------------------------------------------------------

/**
 * Écrit « un effet externe va être tenté », AVANT qu'il le soit.
 *
 * L'ordre est tout le sujet. Marquer après le clic ferait qu'un processus tué
 * pendant l'envoi laisserait une ligne disant « rien n'a été fait », alors que
 * le message a pu partir — et la reprise de bail, lisant ce `false`, remettrait
 * le job dans la file. C'est exactement la façon dont on envoie deux fois.
 *
 * Marquer avant fait dire à la ligne « on a essayé, on ne sait pas », et
 * `recoverExpiredLeases` en tire la seule conclusion possible :
 * `REVIEW_REQUIRED`, terminal, jamais rejoué.
 *
 * Écrit dans sa propre instruction, donc committé avant que l'appelant clique :
 * l'inclure dans une transaction ouverte autour de l'envoi annulerait la trace
 * au moment précis où elle sert.
 *
 * Le `where external_effect_attempted = false` rend l'opération non répétable :
 * un second appel ne réécrit pas l'horodatage et rend `false`. Une tentative ne
 * peut donc pas être « re-commencée ».
 */
/**
 * IG3 §5 — la même inscription, mais sous un verrou qui rend le plafond
 * infranchissable même à deux workers exactement simultanés.
 *
 * Le problème que ceci résout, et que `evaluateSafety` ne pouvait pas résoudre
 * seul : lire les compteurs puis agir laisse une fenêtre entre les deux. Deux
 * workers qui lisent « 9 envois sur 10 » à la même milliseconde concluent tous
 * deux qu'il reste une place, et le plafond de 10 devient 11. Aucune relecture
 * ne referme cette fenêtre — il faut que la vérification et l'écriture soient
 * la même opération.
 *
 * Trois choix méritent d'être expliqués :
 *
 *   1. **Un verrou consultatif de transaction** plutôt qu'un `for update` sur
 *      une ligne. Il n'existe aucune ligne à verrouiller : `ig_kill_switch` peut
 *      être vide (son absence VAUT l'arrêt), et un plafond porte sur un COMPTE
 *      émetteur, pas sur un enregistrement. `pg_advisory_xact_lock` donne
 *      exactement ce mutex, et il se libère au commit ou au rollback — donc
 *      aussi quand le processus meurt.
 *
 *   2. **Le compteur est celui des TENTATIVES d'effet, pas des envois réussis.**
 *      C'est plus strict que `evaluateSafety`, délibérément. Compter les `SENT`
 *      ne fermerait rien ici : le worker qui vient de réserver n'a pas encore
 *      cliqué, donc pas encore de `SENT`, et le second passerait. Compter les
 *      tentatives ferme la porte à l'instant où elle doit l'être — et refuse en
 *      prime le rail qui échouerait en boucle sans jamais « envoyer ».
 *
 *   3. **La réservation EST l'inscription.** Il n'y a pas de jeton à libérer,
 *      donc rien à fuir : soit la transaction commite et la tentative est
 *      comptée pour toujours, soit elle échoue et rien n'a eu lieu.
 *
 * Aucun code de ce dépôt n'appelle cette fonction en DRY-RUN, et aucun ne le
 * pourra : elle exige une autorisation canari, que seul le chemin LIVE détient.
 */
export async function reserveExternalEffectSlot(
  sql: Sql,
  config: InstagramRailConfig,
  input: { jobId: string; canaryAuthorizationId: string },
): Promise<void> {
  await sql.transaction(async (tx) => {
    // Le mutex du compte émetteur. Tout ce qui suit est sérialisé : le second
    // worker attend ici, puis recompte — et voit la tentative du premier.
    await tx.query(`select pg_advisory_xact_lock(hashtext('ig_external_effect_slot'))`);

    const counts = await tx.query<{ lastDay: string; lastHour: string; msSince: string | null }>(
      `with attempts as (
         select external_effect_started_at as at from ig_dispatch_jobs where external_effect_attempted = true
         union all
         select external_effect_started_at as at from ig_controlled_tests where external_effect_attempted = true
         union all
         -- HERMES-CONVERSATION-R2 §20 — la troisième source de tentatives. Sans
         -- elle, une réponse automatique et un premier contact pourraient
         -- réserver le même créneau à la même seconde.
         select external_effect_started_at as at from hermes_conversation_plans where external_effect_attempted = true
       )
       select
         (select count(*) from attempts where at > now() - interval '24 hours')::text as "lastDay",
         (select count(*) from attempts where at > now() - interval '1 hour')::text   as "lastHour",
         (select (extract(epoch from (now() - max(at))) * 1000)::bigint from attempts) as "msSince"`,
    );
    const row = counts[0];
    const lastDay = Number(row?.lastDay ?? 0);
    const lastHour = Number(row?.lastHour ?? 0);
    const msSince = row?.msSince === null || row?.msSince === undefined ? null : Number(row.msSince);

    if (lastDay >= config.caps.dailySentCap) {
      throw new InstagramQueueError(
        'IG_CAP_DAILY_SENT',
        `${lastDay} tentative(s) d'effet externe sur 24 h, plafond ${config.caps.dailySentCap} — réservation refusée`,
      );
    }
    if (lastHour >= config.caps.hourlySentCap) {
      throw new InstagramQueueError(
        'IG_CAP_HOURLY_SENT',
        `${lastHour} tentative(s) d'effet externe sur 1 h, plafond ${config.caps.hourlySentCap} — réservation refusée`,
      );
    }
    if (msSince !== null && msSince < config.caps.minSendIntervalMs) {
      throw new InstagramQueueError(
        'IG_CAP_MIN_INTERVAL',
        `dernière tentative d'effet externe il y a ${msSince} ms, intervalle minimal ` +
          `${config.caps.minSendIntervalMs} ms — réservation refusée`,
      );
    }

    const marked = await tx.query<{ id: string }>(
      `update ig_dispatch_jobs
          set external_effect_attempted = true,
              external_effect_started_at = now(),
              canary_authorization_id = $2,
              updated_at = now()
        where id = $1 and external_effect_attempted = false
        returning id`,
      [input.jobId, input.canaryAuthorizationId],
    );
    if (marked.length !== 1) {
      throw new InstagramQueueError(
        'IG_EFFECT_ALREADY_MARKED',
        `le job ${input.jobId} porte déjà une tentative d'effet externe — aucun second clic`,
      );
    }
  });
}

export async function markExternalEffectAttempted(
  sql: Sql,
  input: { jobId: string; canaryAuthorizationId: string },
): Promise<boolean> {
  const rows = await sql.query<{ id: string }>(
    `update ig_dispatch_jobs
        set external_effect_attempted = true,
            external_effect_started_at = now(),
            canary_authorization_id = $2,
            updated_at = now()
      where id = $1 and external_effect_attempted = false
      returning id`,
    [input.jobId, input.canaryAuthorizationId],
  );
  if (rows.length !== 1) {
    // Refuser bruyamment : l'appelant est sur le point de cliquer, et il ne
    // doit le faire que si la trace existe.
    throw new InstagramQueueError(
      'IG_EFFECT_ALREADY_MARKED',
      `le job ${input.jobId} porte déjà une tentative d'effet externe — aucun second clic`,
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// Reprise après redémarrage
// ---------------------------------------------------------------------------

export interface RecoveredLease {
  readonly id: string;
  readonly status: InstagramJobStatus;
  readonly externalEffectAttempted: boolean;
  /** IG3 §10 — de quoi journaliser la reprise sans relire le job. */
  readonly manifestId: string;
  readonly prospectId: string;
  readonly idempotencyKey: string;
  readonly expectedHandle: string;
}

/**
 * IG-R1 §4 — la reprise, et la seule décision qu'elle a le droit de prendre.
 *
 * Un bail expiré veut dire que le worker n'a pas rendu son verdict : machine
 * arrêtée, processus tué, navigateur figé. La question n'est PAS « faut-il
 * réessayer ? » mais « sait-on ce qui s'est passé chez Instagram ? ».
 *
 *   * `external_effect_attempted = false` — on sait qu'aucun geste n'a été
 *     posé, parce que le drapeau serait passé à `true` AVANT ce geste. Le job
 *     retourne dans la file, sans risque.
 *   * `external_effect_attempted = true` — on ne sait pas. Le job devient
 *     `REVIEW_REQUIRED`, terminal, et attend un humain. Jamais un rejeu : un
 *     timeout ambigu qui se réessaie tout seul est exactement la façon dont on
 *     envoie deux fois le même message.
 *
 * En R1 la seconde branche est inatteignable — aucun code ne met le drapeau à
 * `true`. Elle est écrite, contrainte et testée maintenant pour que le jour où
 * un envoi existera, la règle soit déjà là plutôt qu'à inventer sous pression.
 */
export async function recoverExpiredLeases(sql: Sql): Promise<RecoveredLease[]> {
  return sql.query<RecoveredLease>(
    `update ig_dispatch_jobs
        set status = case when external_effect_attempted then 'REVIEW_REQUIRED' else 'PENDING' end,
            claim_token = null,
            claimed_by = null,
            claimed_at = null,
            lease_expires_at = null,
            last_reason_code = case
              when external_effect_attempted then 'IG_LEASE_EXPIRED_AFTER_EFFECT'
              else 'IG_LEASE_EXPIRED'
            end,
            last_detail = case
              when external_effect_attempted
                then 'bail expiré après une tentative d''effet externe — issue inconnue, tranchage humain requis'
              else 'bail expiré avant tout effet externe — remis dans la file'
            end,
            -- IG3 §8 — le motif rejoint le vocabulaire fermé. La branche « avant
            -- effet » n'en écrit AUCUN : le job repart PENDING, et lui coller un
            -- motif de report ferait compter un skip là où il n'y a qu'une
            -- reprise. Seule la branche ambiguë en porte un, TERMINAL, ce que la
            -- contrainte ig_job_terminal_skip_is_absorbing accepte parce que
            -- REVIEW_REQUIRED est absorbant.
            last_skip_reason = case when external_effect_attempted then 'review_required' else last_skip_reason end,
            last_skip_class = case when external_effect_attempted then 'TERMINAL' else last_skip_class end,
            terminated_at = case when external_effect_attempted then now() else null end,
            updated_at = now()
      where status = 'CLAIMED' and lease_expires_at <= now()
      returning id, status, external_effect_attempted as "externalEffectAttempted",
                manifest_id as "manifestId", prospect_id as "prospectId",
                idempotency_key as "idempotencyKey", expected_handle as "expectedHandle"`,
  );
}

/**
 * Relit un manifeste et vérifie qu'il porte toujours ce que le job a figé.
 *
 * Un handle qui change entre l'enfilement et l'exécution n'est pas une mise à
 * jour à absorber : c'est un compte différent, ou un compte renommé, donc une
 * cible dont personne n'a validé qu'elle est encore la bonne. Idem pour les
 * empreintes du texte et du payload. Le refus nomme ce qui a bougé.
 */
// ---------------------------------------------------------------------------
// Lecture opérateur (IG3 §9)
// ---------------------------------------------------------------------------

export interface QueueDepthRow {
  readonly status: InstagramJobStatus;
  readonly total: number;
  /** Réclamables et dus maintenant. */
  readonly dueNow: number;
  /** Réclamables mais programmés plus tard. */
  readonly scheduled: number;
}

export interface QueueOverview {
  readonly depth: readonly QueueDepthRow[];
  readonly total: number;
  readonly dueNow: number;
  readonly scheduled: number;
  readonly blocked: number;
  readonly terminal: number;
  /** Le prochain instant où un job devient réclamable, `null` si aucun ne l'est jamais. */
  readonly nextScheduledAt: string | null;
  readonly nextScheduledJobId: string | null;
  /** Motifs de report en cours, du plus fréquent au moins fréquent. */
  readonly skipReasons: readonly { reason: InstagramSkipReason; count: number }[];
}

/**
 * Tout ce que `ig:queue --status` affiche, en trois requêtes plutôt qu'en N.
 *
 * `dueNow` et `scheduled` sont calculés par la base et non par le processus :
 * comparer `not_before` à l'horloge du client donnerait un décompte faux dès
 * que les deux dérivent, et c'est la base qui arbitre la prise.
 */
export async function loadQueueOverview(sql: Sql): Promise<QueueOverview> {
  const depth = await sql.query<{ status: InstagramJobStatus; total: string; dueNow: string; scheduled: string }>(
    `select status,
            count(*)::text as total,
            count(*) filter (where status = any($1::text[]) and not_before <= now())::text as "dueNow",
            count(*) filter (where status = any($1::text[]) and not_before >  now())::text as "scheduled"
       from ig_dispatch_jobs group by status order by status`,
    [[...CLAIMABLE_JOB_STATUSES]],
  );

  const next = await sql.query<{ id: string; notBefore: string }>(
    `select id, not_before as "notBefore" from ig_dispatch_jobs
      where status = any($1::text[]) and not_before > now()
      order by not_before asc limit 1`,
    [[...CLAIMABLE_JOB_STATUSES]],
  );

  const reasons = await sql.query<{ reason: InstagramSkipReason; n: string }>(
    `select last_skip_reason as reason, count(*)::text as n
       from ig_dispatch_jobs
      where status = 'SKIPPED' and last_skip_reason is not null
      group by last_skip_reason order by count(*) desc, last_skip_reason asc`,
  );

  const rows = depth.map((row) => ({
    status: row.status,
    total: Number(row.total),
    dueNow: Number(row.dueNow),
    scheduled: Number(row.scheduled),
  }));

  return Object.freeze({
    depth: Object.freeze(rows),
    total: rows.reduce((sum, row) => sum + row.total, 0),
    dueNow: rows.reduce((sum, row) => sum + row.dueNow, 0),
    scheduled: rows.reduce((sum, row) => sum + row.scheduled, 0),
    blocked: rows.filter((row) => row.status === 'BLOCKED').reduce((sum, row) => sum + row.total, 0),
    terminal: rows
      .filter((row) => TERMINAL_JOB_STATUSES.includes(row.status))
      .reduce((sum, row) => sum + row.total, 0),
    nextScheduledAt: next[0]?.notBefore ?? null,
    nextScheduledJobId: next[0]?.id ?? null,
    skipReasons: Object.freeze(reasons.map((row) => ({ reason: row.reason, count: Number(row.n) }))),
  });
}

export function detectJobManifestDrift(job: InstagramJob, envelope: DispatchEnvelope): string | null {
  const drifted: string[] = [];
  if (envelope.recipient !== job.expectedHandle) {
    drifted.push(`handle « ${job.expectedHandle} » → « ${envelope.recipient} »`);
  }
  if (envelope.approvedTextSha256 !== job.approvedTextSha256) drifted.push('empreinte du texte approuvé');
  if (envelope.transportPayloadSha256 !== job.transportPayloadSha256) drifted.push('empreinte du payload transport');
  if (envelope.prospectId !== job.prospectId) drifted.push('prospect');
  return drifted.length === 0 ? null : drifted.join(', ');
}

export { DispatchBlockedError };
