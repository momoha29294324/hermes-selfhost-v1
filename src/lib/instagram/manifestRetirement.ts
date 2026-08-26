import type { Sql } from '@/lib/db/sql';
import { sha256Hex } from '@/lib/pipeline/r6bDispatch';
import { claimNextInstagramJob, finalizeInstagramJob } from '@/lib/instagram/queue';
import { recordJobEvent } from '@/lib/instagram/events';
import { CLAIMABLE_JOB_STATUSES, type InstagramJobStatus } from '@/lib/instagram/types';

/**
 * HERMES-MANIFEST-OPERATOR-RETIREMENT-R1 — retirer une intention de dispatch
 * qu'une politique n'a aucune raison de refuser.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi ce module existe alors que `queueInvalidation` existe déjà
 * ---------------------------------------------------------------------------
 * `invalidateQueueUnderCurrentPolicy` répond à « la politique courante
 * autorise-t-elle encore ce prospect ? ». C'est une question sur le PROSPECT, et
 * le module refuse — à raison — d'inventer un motif que la politique ne
 * prononce pas.
 *
 * Le 25 août 2026, trois jobs `PENDING` visaient @wash.lh, @laveautocaen et
 * @caautodetail_. La politique les approuvait tous les trois, et elle avait
 * raison : ces prospects sont éligibles, leur identité est établie, aucun
 * n'avait été joint. Ce qui n'allait pas était le TEXTE — rédigé avant le
 * correctif 0fec132, sous un prompt qui demandait au premier tour d'ouvrir une
 * conversation ET de qualifier le canal d'acquisition. `ig:queue:invalidate`
 * ne pouvait rien pour eux, et c'était correct : rien, dans l'état du monde,
 * n'était devenu faux.
 *
 * Ce qui manquait n'était donc pas une politique de plus. C'était un GESTE :
 * une personne nommée décide qu'une intention ne partira pas, et le dépôt
 * l'inscrit — au lieu de laisser cette personne écrire un `update` à la main,
 * c'est-à-dire la seule façon de se tromper que ce dépôt n'avait pas fermée.
 *
 * ---------------------------------------------------------------------------
 * Ce que le geste FAIT, et ce qu'il ne peut pas faire
 * ---------------------------------------------------------------------------
 * Il fait DEUX écritures d'état et UNE écriture d'histoire :
 *
 *   1. le manifeste passe `SUPERSEDED`, `superseded_reason = 'operator_retired'`
 *      — le même patron append-only qu'un re-lock (0019/0020). Son texte, son
 *      empreinte, son destinataire, sa provenance et son vote ne bougent pas
 *      d'un caractère ;
 *   2. le job passe `INELIGIBLE` / `operator_retired`, c'est-à-dire le SEUL
 *      statut absorbant dont la base garantit qu'il n'a rien tenté
 *      (`ig_job_ineligible_has_no_effect`, 0039) ;
 *   3. `ig_manifest_retirements` conserve qui, quand, pourquoi, et le message
 *      retiré mot pour mot.
 *
 * Aucun DELETE, nulle part. Le manifeste, le vote, le brouillon et le job
 * SURVIVENT tous : ce qui cesse est la RÉCLAMABILITÉ, pas l'existence.
 *
 * Il ne peut pas s'appliquer à une intention qui a touché le monde, et cela ne
 * dépend pas de ce module : `previous_external_effect_attempted` ne peut porter
 * que `false` (contrainte `ig_manifest_retirement_never_after_effect`). Le code
 * refuse d'abord, la base refuserait ensuite.
 *
 * Il n'ouvre aucun envoi, n'importe aucun provider, aucun rail, aucun
 * navigateur, et ne sait pas lever l'arrêt global — il ne l'interroge même pas,
 * parce que fermer une intention n'a jamais eu besoin d'une permission
 * d'envoyer.
 *
 * ---------------------------------------------------------------------------
 * La double sécurité qui fait que ce module n'est pas ce qui protège
 * ---------------------------------------------------------------------------
 * Superséder le manifeste suffirait seul : `buildDispatchEnvelope` lève
 * `MANIFEST_SUPERSEDED` sur tout manifeste non `LOCKED`, et il est appelé par
 * `resolveDispatchTarget`, donc par le worker AVANT le moindre geste. Refermer
 * le job est ce qui rend l'état LISIBLE — un `PENDING` éternel donne
 * l'impression d'attendre son tour — exactement l'argument que
 * `queueInvalidation` a écrit avant nous.
 */

/** Les raisons de REFUSER. Toutes définitives : aucune ne se réessaie seule. */
export type ManifestRetirementRefusal =
  | 'OPERATOR_MISSING'
  | 'REASON_MISSING'
  | 'MANIFEST_NOT_FOUND'
  | 'MANIFEST_NOT_LOCKED'
  | 'EXTERNAL_EFFECT_ATTEMPTED'
  | 'JOB_BORE_EXTERNAL_EFFECT'
  | 'JOB_LEASE_HELD'
  | 'CLAIM_LOST';

/**
 * Les statuts terminaux qui PEUVENT avoir produit un effet extérieur.
 *
 * `INELIGIBLE` en est absent, et c'est un fait et non une indulgence : la base
 * interdit qu'il porte un effet (`ig_job_ineligible_has_no_effect`, 0039). Un
 * job déjà refermé par la politique laisse donc son manifeste retirable — il
 * reste `LOCKED` après `ig:queue:invalidate`, qui ne touche que la file.
 */
export const EFFECT_BEARING_JOB_STATUSES: readonly InstagramJobStatus[] = [
  'SENT',
  'REVIEW_REQUIRED',
  'DELIVERY_FAILED',
];

export interface RetirementJobState {
  readonly jobId: string;
  readonly status: InstagramJobStatus;
  readonly externalEffectAttempted: boolean;
  readonly leaseExpiresAt: string | Date | null;
}

export interface RetirementSubject {
  readonly manifestStatus: 'LOCKED' | 'SUPERSEDED';
  /** Une ligne `ig_manifest_retirements` existe-t-elle déjà pour ce manifeste ? */
  readonly alreadyRetired: boolean;
  /** `null` = le manifeste a été verrouillé sans qu'aucun job ne soit enfilé. */
  readonly job: RetirementJobState | null;
  readonly now: Date;
}

export type RetirementAssessment =
  | { readonly verdict: 'REFUSED'; readonly refusal: ManifestRetirementRefusal; readonly detail: string }
  | { readonly verdict: 'ALREADY_RETIRED'; readonly detail: string }
  | { readonly verdict: 'RETIRABLE'; readonly claimRequired: boolean; readonly detail: string };

/**
 * Le jugement, en code PUR et fail-closed.
 *
 * Il ne reçoit ni prospect nommé, ni compte, ni campagne, ni coquille, ni
 * configuration : il n'existe donc aucune donnée depuis laquelle une exception
 * pourrait être écrite. Il ne lit ni horloge globale, ni base — l'instant lui
 * est passé, de sorte qu'un test puisse le rejouer à la milliseconde.
 *
 * L'ORDRE des lectures est la garantie, pas la liste. L'effet extérieur est lu
 * AVANT le statut, comme `assessPlanReclaim` le fait sur le rail de réponse :
 * une intention qui a touché le monde ne se retire pas, même si un statut mal
 * écrit prétendait le contraire.
 */
export function assessManifestRetirement(subject: RetirementSubject): RetirementAssessment {
  const job = subject.job;

  if (job !== null && job.externalEffectAttempted) {
    return Object.freeze({
      verdict: 'REFUSED' as const,
      refusal: 'EXTERNAL_EFFECT_ATTEMPTED' as const,
      detail:
        `le job ${job.jobId} porte external_effect_attempted — un message a pu partir. ` +
        'La cause d’un fait extérieur ne se réécrit pas : rien n’est retiré.',
    });
  }

  if (job !== null && EFFECT_BEARING_JOB_STATUSES.includes(job.status)) {
    return Object.freeze({
      verdict: 'REFUSED' as const,
      refusal: 'JOB_BORE_EXTERNAL_EFFECT' as const,
      detail:
        `le job ${job.jobId} est au statut « ${job.status} », qui n’existe qu’après un geste ` +
        'vers Instagram. Retirer l’intention effacerait la raison d’un fait extérieur.',
    });
  }

  if (subject.alreadyRetired) {
    return Object.freeze({
      verdict: 'ALREADY_RETIRED' as const,
      detail: 'ce manifeste porte déjà un retrait journalisé — rien à écrire une seconde fois',
    });
  }

  if (subject.manifestStatus !== 'LOCKED') {
    return Object.freeze({
      verdict: 'REFUSED' as const,
      refusal: 'MANIFEST_NOT_LOCKED' as const,
      detail:
        `manifeste au statut « ${subject.manifestStatus} » sans retrait journalisé — il a été ` +
        'remplacé par un re-lock, pas par un geste d’opérateur. Il n’est déjà plus dispatchable.',
    });
  }

  if (job !== null && job.status === 'CLAIMED') {
    const expiry = job.leaseExpiresAt === null ? null : new Date(job.leaseExpiresAt);
    const expired = expiry !== null && Number.isFinite(expiry.getTime()) && expiry.getTime() <= subject.now.getTime();
    return Object.freeze({
      verdict: 'REFUSED' as const,
      refusal: 'JOB_LEASE_HELD' as const,
      detail: expired
        ? `le bail du job ${job.jobId} a expiré sans avoir été repris — laisser la reprise de bail ` +
          '(`recoverExpiredLeases`) trancher d’abord, elle seule sait lire ce qui a été tenté'
        : `un worker tient le bail du job ${job.jobId} en ce moment — rien n’est écrit par-dessus`,
    });
  }

  const claimRequired = job !== null && CLAIMABLE_JOB_STATUSES.includes(job.status);
  return Object.freeze({
    verdict: 'RETIRABLE' as const,
    claimRequired,
    detail:
      job === null
        ? 'manifeste LOCKED sans job enfilé — seul le manifeste est à refermer'
        : claimRequired
          ? `job ${job.jobId} au statut « ${job.status} », réclamable, aucun effet tenté`
          : `job ${job.jobId} déjà absorbant sans effet (« ${job.status} ») — seul le manifeste reste à refermer`,
  });
}

// ---------------------------------------------------------------------------
// L'écriture
// ---------------------------------------------------------------------------

export interface RetireManifestInput {
  readonly manifestId: string;
  readonly operator: string;
  readonly reason: string;
  /** Faux — le DÉFAUT — n'écrit rien et rend le geste qui serait fait. */
  readonly apply?: boolean;
  /** La révision du dépôt sous laquelle le geste est posé, si elle est lisible. */
  readonly codeRevision?: string | null;
}

export interface RetiredIntent {
  readonly manifestId: string;
  readonly jobId: string | null;
  readonly prospectId: string;
  readonly batchItemId: string;
  readonly handle: string;
  readonly businessName: string;
  readonly previousManifestStatus: string;
  readonly previousJobStatus: string | null;
  readonly retiredText: string;
  readonly retiredTextSha256: string;
  /** §10 — la révision qui a produit le brouillon, `null` si non observée. */
  readonly generationCodeRevision: string | null;
}

export type RetireManifestResult =
  | { readonly outcome: 'REFUSED'; readonly refusal: ManifestRetirementRefusal; readonly detail: string }
  | { readonly outcome: 'ALREADY_RETIRED'; readonly detail: string; readonly intent: RetiredIntent }
  | {
      readonly outcome: 'PLANNED' | 'APPLIED';
      readonly detail: string;
      readonly intent: RetiredIntent;
      /** Identifiant de la ligne de journal, seulement quand `APPLIED`. */
      readonly retirementId: string | null;
    };

const WORKER_ID = 'hermes-manifest-retirement';
const LEASE_MS = 60_000;

interface SubjectRow {
  manifest_id: string;
  manifest_status: 'LOCKED' | 'SUPERSEDED';
  prospect_id: string;
  batch_item_id: string;
  approval_vote_id: string;
  business_name: string;
  recipient: string;
  approved_text: string;
  approved_text_sha256: string;
  generation_code_revision: string | null;
  already_retired: boolean;
  job_id: string | null;
  job_status: InstagramJobStatus | null;
  job_effect: boolean | null;
  job_lease_expires_at: string | Date | null;
}

function refuse(refusal: ManifestRetirementRefusal, detail: string): RetireManifestResult {
  return Object.freeze({ outcome: 'REFUSED' as const, refusal, detail });
}

/**
 * Retire UNE intention de dispatch.
 *
 * `apply = false` par défaut, comme `replies:analysis:retire` et
 * `ig:queue:invalidate` : un opérateur lit d'abord exactement ce qui serait
 * fermé, avec le message qui ne partira pas.
 */
export async function retireDispatchIntent(
  sql: Sql,
  input: RetireManifestInput,
): Promise<RetireManifestResult> {
  const operator = input.operator.trim();
  const reason = input.reason.trim();
  const apply = input.apply === true;

  if (operator.length < 2) {
    return refuse('OPERATOR_MISSING', 'un geste d’opérateur porte le nom d’une personne, pas un vide');
  }
  if (reason.length < 8) {
    return refuse('REASON_MISSING', 'retirer une intention demande un motif écrit, conservé au journal');
  }

  const row = await readSubject(sql, input.manifestId);
  if (row === null) {
    return refuse('MANIFEST_NOT_FOUND', `aucun manifeste ${input.manifestId}`);
  }

  const intent = toIntent(row);
  const assessment = assessManifestRetirement({
    manifestStatus: row.manifest_status,
    alreadyRetired: row.already_retired,
    job:
      row.job_id === null || row.job_status === null
        ? null
        : {
            jobId: row.job_id,
            status: row.job_status,
            externalEffectAttempted: row.job_effect === true,
            leaseExpiresAt: row.job_lease_expires_at,
          },
    now: new Date(),
  });

  if (assessment.verdict === 'REFUSED') {
    return refuse(assessment.refusal, assessment.detail);
  }
  if (assessment.verdict === 'ALREADY_RETIRED') {
    return Object.freeze({ outcome: 'ALREADY_RETIRED' as const, detail: assessment.detail, intent });
  }

  if (!apply) {
    return Object.freeze({
      outcome: 'PLANNED' as const,
      detail: `${assessment.detail} — rien n’a été écrit (ajouter --apply)`,
      intent,
      retirementId: null,
    });
  }

  // Le chemin canonique, et lui seul : on PREND le bail avant d'écrire l'issue
  // du job. Écrire sans bail contournerait la sérialisation qui protège la
  // file, et `finalizeInstagramJob` refuserait de toute façon — `status =
  // 'CLAIMED'` et `claim_token` sont dans son `where`.
  //
  // Si la transaction qui suit échoue, le job reste `CLAIMED` avec un bail
  // court, que `recoverExpiredLeases` rendra à la file : le pire cas est un
  // retard d'une minute, jamais une ligne perdue.
  let claimToken: string | null = null;
  let idempotencyKey: string | null = null;
  if (assessment.claimRequired && row.job_id !== null) {
    const claimed = await claimNextInstagramJob(sql, {
      workerId: WORKER_ID,
      leaseMs: LEASE_MS,
      jobId: row.job_id,
      // R1.1 — un job reporté à la fenêtre suivante reste retirable. Voir
      // `ignoreSchedule` : `not_before` ordonnance l'ENVOI, et fermer une
      // intention n'a pas à attendre l'heure à laquelle elle serait partie.
      ignoreSchedule: true,
    });
    if (claimed === null || claimed.claimToken === null) {
      // Ne nomme AUCUN coupable. Le bail vivant d'un autre worker est déjà
      // refusé plus haut (`JOB_LEASE_HELD`) ; ce qui reste est une course, un
      // statut devenu non réclamable entre la lecture et ici, ou une ligne
      // verrouillée. Écrire « un autre worker l'a repris » envoyait un
      // opérateur chercher un processus qui n'existait pas — c'est ce que le
      // 25 août a montré.
      return refuse(
        'CLAIM_LOST',
        `le bail du job ${row.job_id} n’a pas pu être pris — son état a changé entre la lecture et l’écriture, rien n’a été écrit`,
      );
    }
    claimToken = claimed.claimToken;
    idempotencyKey = claimed.idempotencyKey;
  }

  const detail = `retiré par ${operator} — ${reason}`;
  const retirementId = await sql.transaction(async (tx) => {
    // Le manifeste : STATUT seulement. Le `where … and status = 'LOCKED'` rend
    // l'écriture inopérante si quelqu'un a reverrouillé entre la lecture et
    // ici — auquel cas la ligne de journal ci-dessous échouera sur sa propre
    // contrainte plutôt que d'inscrire un geste qui n'a rien fermé.
    const superseded = await tx.query<{ id: string }>(
      `update r6b_dispatch_manifests
          set status = 'SUPERSEDED',
              superseded_at = now(),
              superseded_reason = 'operator_retired'
        where id = $1 and status = 'LOCKED'
        returning id`,
      [row.manifest_id],
    );
    if (superseded.length !== 1) {
      throw new ManifestRetirementConflict(
        `le manifeste ${row.manifest_id} n’était plus LOCKED au moment d’écrire — rien n’a été retiré`,
      );
    }

    if (claimToken !== null && row.job_id !== null) {
      const written = await finalizeInstagramJob(tx, {
        jobId: row.job_id,
        claimToken,
        status: 'INELIGIBLE',
        reasonCode: 'IG_MANIFEST_RETIRED_BY_OPERATOR',
        detail,
        skipReason: 'operator_retired',
      });
      if (!written) {
        throw new ManifestRetirementConflict(
          `le bail du job ${row.job_id} a expiré avant l’écriture — rien n’a été retiré`,
        );
      }
    }

    const journal = await tx.query<{ id: string }>(
      `insert into ig_manifest_retirements
         (manifest_id, job_id, prospect_id, batch_item_id, approval_vote_id,
          previous_manifest_status, previous_job_status, previous_external_effect_attempted,
          retired_text, retired_text_sha256, recipient,
          generation_code_revision, retirement_code_revision, operator, reason)
       values ($1,$2,$3,$4,$5,$6,$7,false,$8,$9,$10,$11,$12,$13,$14)
       returning id`,
      [
        row.manifest_id,
        row.job_id,
        row.prospect_id,
        row.batch_item_id,
        row.approval_vote_id,
        row.manifest_status,
        row.job_status,
        intent.retiredText,
        intent.retiredTextSha256,
        row.recipient,
        row.generation_code_revision,
        input.codeRevision ?? null,
        operator,
        reason,
      ],
    );
    const id = journal[0]?.id;
    if (id === undefined) throw new Error('la ligne de retrait n’a pas été rendue par l’insert');
    return id;
  });

  // Le journal du rail, pour que la SÉQUENCE se relise. Hors transaction, comme
  // partout ailleurs : une trace manquante ne doit pas défaire un retrait qui a
  // eu lieu.
  if (row.job_id !== null && claimToken !== null && idempotencyKey !== null) {
    await recordJobEvent(sql, {
      jobId: row.job_id,
      manifestId: row.manifest_id,
      prospectId: row.prospect_id,
      sessionId: null,
      workerId: WORKER_ID,
      mode: 'DRY_RUN',
      status: 'SKIPPED',
      reasonCode: 'IG_MANIFEST_RETIRED_BY_OPERATOR',
      idempotencyKey,
      expectedHandle: row.recipient,
      observedHandle: null,
      sessionState: null,
      gates: [{ gate: 'operator_retirement', verdict: 'BLOCK', detail }],
      durationMs: null,
      detail,
      externalEffectAttempted: false,
      canaryAuthorizationId: null,
      skipReason: 'operator_retired',
      nextEligibleAt: null,
    });
  }

  return Object.freeze({
    outcome: 'APPLIED' as const,
    detail,
    intent,
    retirementId,
  });
}

export class ManifestRetirementConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestRetirementConflict';
  }
}

/**
 * Résout un manifeste LOCKED depuis un compte Instagram.
 *
 * Rend TOUS les candidats plutôt que « le plus récent » : deux manifestes
 * LOCKED visant le même compte sont deux intentions distinctes, et en choisir
 * une à la place de l'opérateur ferait décider l'ordre du tri. Le CLI refuse
 * l'ambiguïté au lieu de la trancher.
 */
export async function findLockedManifestsByHandle(sql: Sql, handle: string): Promise<readonly string[]> {
  const rows = await sql.query<{ id: string }>(
    `select id from r6b_dispatch_manifests
      where status = 'LOCKED' and lower(recipient) = lower($1)
      order by locked_at desc, id asc`,
    [handle.replace(/^@/, '')],
  );
  return Object.freeze(rows.map((r) => r.id));
}

async function readSubject(sql: Sql, manifestId: string): Promise<SubjectRow | null> {
  const rows = await sql.query<SubjectRow>(
    `select m.id                          as manifest_id,
            m.status                      as manifest_status,
            m.prospect_id,
            m.batch_item_id,
            m.approval_vote_id,
            m.business_name,
            m.recipient,
            m.approved_text,
            m.approved_text_sha256,
            i.generation_code_revision,
            exists (select 1 from ig_manifest_retirements r where r.manifest_id = m.id) as already_retired,
            j.id                          as job_id,
            j.status                      as job_status,
            j.external_effect_attempted   as job_effect,
            j.lease_expires_at            as job_lease_expires_at
       from r6b_dispatch_manifests m
       join r6b_batch_items i on i.id = m.batch_item_id
       left join ig_dispatch_jobs j on j.manifest_id = m.id and j.action = 'first_touch_dm'
      where m.id = $1`,
    [manifestId],
  );
  return rows[0] ?? null;
}

function toIntent(row: SubjectRow): RetiredIntent {
  return Object.freeze({
    manifestId: row.manifest_id,
    jobId: row.job_id,
    prospectId: row.prospect_id,
    batchItemId: row.batch_item_id,
    handle: row.recipient,
    businessName: row.business_name,
    previousManifestStatus: row.manifest_status,
    previousJobStatus: row.job_status,
    retiredText: row.approved_text,
    // Recalculée, jamais crue : la copie journalisée doit être vérifiable.
    retiredTextSha256: sha256Hex(row.approved_text),
    generationCodeRevision: row.generation_code_revision,
  });
}
