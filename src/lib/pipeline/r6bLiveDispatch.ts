import type { Sql } from '@/lib/db/sql';
import { loadManifestByIdForUpdate, type Transport } from '@/lib/pipeline/r6bDispatch';
import {
  buildDispatchEnvelope,
  DispatchBlockedError,
  insertDispatchAttempt,
  resolveDispatchTarget,
  type DispatchBlockCode,
} from '@/lib/pipeline/r6bDispatcher';
import { hasLiveAdapter, type DispatchEnvelope } from '@/lib/pipeline/r6bTransportAdapters';
import { getLiveReadiness } from '@/lib/pipeline/r6bTransportPayload';
import {
  buildEmailSendRequest,
  deriveIdempotencyKey,
  hashProviderPayload,
  validateSenderIdentity,
  PROVIDER_CONCURRENT_IDEMPOTENT_REQUEST,
  PROVIDER_IDEMPOTENCY_WINDOW_MS,
  PROVIDER_INVALID_IDEMPOTENT_REQUEST,
  type EmailProvider,
  type EmailSendRequest,
  type ProviderEmailRecord,
  type ProviderSendOutcome,
  type SenderIdentity,
} from '@/lib/pipeline/r6bLiveEmail';

/**
 * R6B-C.2B — la porte d'un envoi réel, et tout ce qui l'empêche de s'ouvrir
 * seule (mission « Hermes R6B-C.2B — Single Manifest Live Email
 * Gate »).
 *
 * Ce module n'importe aucun client réseau : il orchestre, il ne parle pas au
 * provider. L'unique appel sortant est délégué à un `EmailProvider` **fourni
 * par l'appelant** — jamais construit ici. Un test qui oublierait de brancher
 * un faux provider ne compilerait pas ; il n'existe pas de valeur par défaut
 * qui irait sur Internet.
 *
 * ---------------------------------------------------------------------------
 * Ce qui doit être vrai simultanément pour qu'un octet parte (§ « triple gate »)
 * ---------------------------------------------------------------------------
 *
 *   1. `mode = LIVE`                       — demandé explicitement ;
 *   2. `OUTBOUND_ALLOW_SENDING = 1`        — l'invariant du dépôt, levé à la main ;
 *   3. `OUTBOUND_LIVE_MANIFEST_ID` == le manifeste armé de cette mission ;
 *   4. `--manifest-id` de la commande      == le même manifeste armé.
 *
 * Les quatre sont comparés à `R6B_LIVE_ARMED_MANIFEST_ID`, une constante du
 * code. Ni la base ni l'environnement ne peuvent désigner un autre manifeste :
 * armer un second envoi demandera de modifier cette ligne, donc une revue.
 * Les quatre autres manifestes verrouillés du pilote restent inatteignables,
 * même avec un `.env` complet et le drapeau à 1.
 *
 * Tout écart : refus AVANT le réseau, journalisé `BLOCKED`, avec
 * `network_attempted = false` garanti par la base (0023).
 */

/**
 * L'unique manifeste que cette mission autorise en LIVE : le premier email
 * commercial de Hermes, verrouillé et complété par un opérateur (transport email,
 * objet approuvé, texte approuvé mot pour mot).
 *
 * Volontairement en dur. Une garde qu'un `UPDATE` ou un `.env` peut déplacer
 * n'est pas une garde ; celle-ci se déplace par un diff.
 */
export const R6B_LIVE_ARMED_MANIFEST_ID = 'a4f2f9d5-785c-4a91-8326-2828e77bf942';

/** Le seul transport doté d'un adapter LIVE dans cette mission. */
export const R6B_LIVE_ARMED_TRANSPORT: Transport = 'email';

export type LiveGateCode =
  | 'LIVE_MODE_REQUIRED'
  | 'LIVE_SENDING_DISABLED'
  | 'LIVE_MANIFEST_NOT_ARMED'
  | 'LIVE_MANIFEST_MISMATCH';

export interface LiveGateInput {
  readonly mode: string;
  /** Valeur lue de `OUTBOUND_ALLOW_SENDING`, déjà interprétée en booléen. */
  readonly allowSending: boolean;
  /** Valeur brute de `OUTBOUND_LIVE_MANIFEST_ID`, `undefined` si absente. */
  readonly envManifestId: string | undefined;
  /** Ce que la ligne de commande a demandé, verbatim. */
  readonly requestedManifestId: string;
}

export type LiveGateVerdict =
  | { readonly armed: true }
  | { readonly armed: false; readonly code: LiveGateCode; readonly reason: string };

/**
 * La triple garde, pure et testable sans base ni réseau. Aucune des quatre
 * conditions n'est facultative et aucune n'est déduite d'une autre.
 */
export function evaluateLiveGate(input: LiveGateInput): LiveGateVerdict {
  if (input.mode !== 'LIVE') {
    return { armed: false, code: 'LIVE_MODE_REQUIRED', reason: `mode « ${input.mode} » — un envoi réel exige LIVE` };
  }
  if (!input.allowSending) {
    return {
      armed: false,
      code: 'LIVE_SENDING_DISABLED',
      reason: 'OUTBOUND_ALLOW_SENDING n’est pas à 1 — l’envoi reste interdit par l’invariant du dépôt',
    };
  }
  const armedFromEnv = (input.envManifestId ?? '').trim();
  if (armedFromEnv !== R6B_LIVE_ARMED_MANIFEST_ID) {
    return {
      armed: false,
      code: 'LIVE_MANIFEST_NOT_ARMED',
      reason:
        armedFromEnv.length === 0
          ? 'OUTBOUND_LIVE_MANIFEST_ID absent — aucun manifeste n’est armé'
          : `OUTBOUND_LIVE_MANIFEST_ID désigne ${armedFromEnv}, qui n’est pas le manifeste armé de cette mission`,
    };
  }
  if (input.requestedManifestId.trim() !== R6B_LIVE_ARMED_MANIFEST_ID) {
    return {
      armed: false,
      code: 'LIVE_MANIFEST_MISMATCH',
      reason: `--manifest-id ${input.requestedManifestId} ne correspond pas au manifeste armé`,
    };
  }
  return { armed: true };
}

// ---------------------------------------------------------------------------
// Résultat
// ---------------------------------------------------------------------------

export type LiveDispatchStatus = 'SENT' | 'AMBIGUOUS' | 'FAILED';

export interface LiveDispatchResult {
  /** Ligne du journal append-only `r6b_dispatch_attempts`. */
  readonly attemptId: string;
  /** Ligne du registre `r6b_live_send_attempts`. */
  readonly liveAttemptId: string;
  readonly manifestId: string;
  readonly provider: 'resend';
  readonly providerMessageId: string | null;
  readonly transport: Transport;
  readonly recipient: string;
  readonly approvedTextSha256: string;
  readonly transportPayloadSha256: string;
  readonly idempotencyKey: string;
  /** Empreinte des cinq champs exacts transmis au provider (0024). */
  readonly providerPayloadSha256: string;
  /** Toujours `true` : ce résultat n'existe que si le réseau a été touché. */
  readonly networkAttempted: true;
  readonly sent: boolean;
  readonly status: LiveDispatchStatus;
  /** Exactement un sur un `SENT`, `null` sinon. */
  readonly outreachEventId: string | null;
  readonly failureCode: string | null;
  readonly detail: string | null;
}

export interface LiveDispatchDeps {
  /** Exigé, jamais construit ici : le domaine n'ouvre pas de connexion de lui-même. */
  readonly provider: EmailProvider;
  readonly senderIdentity: SenderIdentity;
}

// ---------------------------------------------------------------------------
// Registre des envois LIVE
// ---------------------------------------------------------------------------

interface LiveAttemptRow {
  id: string;
  status: 'CLAIMED' | 'SENT' | 'AMBIGUOUS' | 'FAILED';
  networkAttempted: boolean;
  providerMessageId: string | null;
  idempotencyKey: string;
  /** Empreinte des cinq champs réellement transmis au provider (0024). */
  providerPayloadSha256: string;
  /** Fin de la fenêtre d'idempotence Resend pour cette tentative (0024). */
  providerIdempotencyExpiresAt: string;
  recipient: string;
  claimedAt: string;
  failureCode: string | null;
}

const LIVE_ATTEMPT_COLUMNS = `id, status, network_attempted as "networkAttempted",
        provider_message_id as "providerMessageId", idempotency_key as "idempotencyKey",
        provider_payload_sha256 as "providerPayloadSha256",
        provider_idempotency_expires_at as "providerIdempotencyExpiresAt",
        recipient, claimed_at as "claimedAt", failure_code as "failureCode"`;

async function loadLiveAttempts(sql: Sql, manifestId: string): Promise<LiveAttemptRow[]> {
  return sql.query<LiveAttemptRow>(
    `select ${LIVE_ATTEMPT_COLUMNS} from r6b_live_send_attempts
      where manifest_id = $1 order by claimed_at asc`,
    [manifestId],
  );
}

/** Violation d'unicité Postgres — le refus de la base, pas une panne. */
function isUniqueViolation(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (code === '23505') return true;
  const message = error instanceof Error ? error.message : '';
  return /duplicate key value|unique constraint/i.test(message);
}

/**
 * Réserve le droit d'envoyer, avant tout réseau.
 *
 * L'atomicité ne vient pas d'un `select` suivi d'un `insert` — deux processus
 * peuvent lire « rien en cours » en même temps. Elle vient de l'index unique
 * partiel `r6b_live_send_attempts_one_open_per_manifest_idx` (0023) : le
 * second `insert` échoue, en base, quelle que soit la fenêtre de course. Les
 * lectures qui précèdent ne servent qu'à donner un motif de refus lisible.
 *
 * Le manifeste est relu `for update` et revalidé intégralement dans la même
 * transaction : entre la validation initiale et ici, la ligne a pu bouger.
 */
async function claimLiveAttempt(
  sql: Sql,
  envelope: DispatchEnvelope,
  idempotencyKey: string,
  providerPayloadSha256: string,
  providerName: 'resend',
): Promise<string> {
  return sql.transaction(async (tx) => {
    const manifest = await loadManifestByIdForUpdate(tx, envelope.manifestId);
    if (!manifest) {
      throw new DispatchBlockedError('MANIFEST_NOT_FOUND', `manifeste ${envelope.manifestId} disparu avant réservation`);
    }
    // Revalidation complète — pas une comparaison de champs choisis : si la
    // ligne a changé de quelque façon que ce soit, elle échoue ici.
    const fresh = buildDispatchEnvelope(manifest);
    if (
      fresh.recipient !== envelope.recipient ||
      fresh.approvedTextSha256 !== envelope.approvedTextSha256 ||
      fresh.transportPayloadSha256 !== envelope.transportPayloadSha256 ||
      fresh.transport !== envelope.transport
    ) {
      throw new DispatchBlockedError(
        'LIVE_MANIFEST_DRIFT',
        `le manifeste ${envelope.manifestId} a changé entre sa validation et la réservation`,
      );
    }

    const existing = await loadLiveAttempts(tx, envelope.manifestId);
    const sent = existing.find((row) => row.status === 'SENT');
    if (sent) {
      throw new DispatchBlockedError(
        'LIVE_ALREADY_SENT',
        `manifeste ${envelope.manifestId} déjà envoyé (message ${sent.providerMessageId ?? 'inconnu'}) — un envoi ne se rejoue pas`,
      );
    }
    const ambiguous = existing.find((row) => row.status === 'AMBIGUOUS');
    if (ambiguous) {
      throw new DispatchBlockedError(
        'LIVE_ATTEMPT_AMBIGUOUS_PENDING',
        `une tentative d'issue inconnue (${ambiguous.id}) existe pour ce manifeste — ` +
          'elle doit être tranchée par un humain avant toute autre tentative',
      );
    }
    const inFlight = existing.find((row) => row.status === 'CLAIMED');
    if (inFlight) {
      throw new DispatchBlockedError(
        'LIVE_ATTEMPT_IN_FLIGHT',
        `une réservation (${inFlight.id}) est déjà ouverte pour ce manifeste`,
      );
    }

    try {
      const rows = await tx.query<{ id: string }>(
        // `provider_idempotency_expires_at` est calculée par la base, à partir
        // de son propre `now()` et de la fenêtre documentée de 24 h : la même
        // horloge que `claimed_at`, donc une fenêtre qui ne dépend pas de
        // celle du processus appelant.
        `insert into r6b_live_send_attempts
           (manifest_id, provider, idempotency_key, transport, recipient,
            approved_text_sha256, transport_payload_sha256, provider_payload_sha256,
            provider_idempotency_expires_at, status, network_attempted)
         values ($1,$2,$3,$4,$5,$6,$7,$8, now() + ($9::bigint * interval '1 millisecond'), 'CLAIMED', false)
         returning id`,
        [
          envelope.manifestId,
          providerName,
          idempotencyKey,
          envelope.transport,
          envelope.recipient,
          envelope.approvedTextSha256,
          envelope.transportPayloadSha256,
          providerPayloadSha256,
          String(PROVIDER_IDEMPOTENCY_WINDOW_MS),
        ],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error('r6b_live_send_attempts insert did not return a row');
      return id;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DispatchBlockedError(
          'LIVE_ATTEMPT_IN_FLIGHT',
          `une autre tentative LIVE occupe déjà ce manifeste — refusée par la base avant tout appel réseau`,
        );
      }
      throw error;
    }
  });
}

/**
 * Note que le réseau va être touché — **avant** de le toucher, et dans sa
 * propre transaction déjà validée.
 *
 * L'ordre est le sujet : marquer après l'appel ferait qu'un processus tué
 * pendant la requête laisserait une ligne disant « réseau non touché », alors
 * que l'email a pu partir. Marquer avant fait dire à la ligne « on a essayé,
 * on ne sait pas » — la seule chose vraie dans ce cas.
 */
async function markNetworkAttempted(sql: Sql, liveAttemptId: string): Promise<void> {
  await sql.query(
    `update r6b_live_send_attempts
        set network_attempted = true, network_started_at = now()
      where id = $1 and status = 'CLAIMED'`,
    [liveAttemptId],
  );
}

interface FinalizeInput {
  readonly envelope: DispatchEnvelope;
  readonly liveAttemptId: string;
  readonly idempotencyKey: string;
  readonly providerPayloadSha256: string;
  readonly providerName: 'resend';
  readonly outcome: ProviderSendOutcome;
  readonly requestedManifestId: string;
}

/**
 * Inscrit l'issue : registre, journal, et — sur un succès incontestable
 * seulement — l'unique `outreach_event`. Une seule transaction : « SENT » et
 * « un humain a été contacté » ne peuvent pas exister l'un sans l'autre.
 */
async function finalizeOutcome(sql: Sql, input: FinalizeInput): Promise<LiveDispatchResult> {
  const { envelope, outcome } = input;

  return sql.transaction(async (tx) => {
    const sent = outcome.status === 'SENT';
    const providerMessageId = outcome.status === 'SENT' ? outcome.providerMessageId : null;
    const failureCode = outcome.status === 'SENT' ? null : outcome.failureCode;
    const detail = outcome.status === 'SENT' ? null : outcome.detail;

    await tx.query(
      `update r6b_live_send_attempts
          set status = $2, provider_message_id = $3, failure_code = $4, detail = $5, completed_at = now()
        where id = $1 and status = 'CLAIMED'`,
      [input.liveAttemptId, outcome.status, providerMessageId, failureCode, detail],
    );

    let outreachEventId: string | null = null;
    if (sent) {
      // Exactement un événement, lié au manifeste, sans le texte : le corps
      // vit dans le manifeste et n'a pas à être recopié pour être prouvé.
      const rows = await tx.query<{ id: string }>(
        `insert into outreach_events (prospect_id, kind, channel, payload, manifest_id)
         values ($1,'sent',$2,$3::jsonb,$4)
         returning id`,
        [
          envelope.prospectId,
          envelope.transport,
          JSON.stringify({
            provider: input.providerName,
            provider_message_id: providerMessageId,
            recipient: envelope.recipient,
            approved_text_sha256: envelope.approvedTextSha256,
            transport_payload_sha256: envelope.transportPayloadSha256,
            provider_payload_sha256: input.providerPayloadSha256,
            idempotency_key: input.idempotencyKey,
            live_attempt_id: input.liveAttemptId,
          }),
          envelope.manifestId,
        ],
      );
      outreachEventId = rows[0]?.id ?? null;
      if (!outreachEventId) throw new Error('outreach_events insert did not return a row');
    }

    const attemptId = await insertDispatchAttempt(tx, {
      requestedManifestId: input.requestedManifestId,
      manifestId: envelope.manifestId,
      mode: 'LIVE',
      transport: envelope.transport,
      recipient: envelope.recipient,
      approvedTextSha256: envelope.approvedTextSha256,
      transportPayloadSha256: envelope.transportPayloadSha256,
      liveReady: true,
      missingForLive: [],
      status: outcome.status,
      errorCode: failureCode,
      networkAttempted: true,
      sent,
      provider: input.providerName,
      providerMessageId,
      liveAttemptId: input.liveAttemptId,
    });

    return Object.freeze({
      attemptId,
      liveAttemptId: input.liveAttemptId,
      manifestId: envelope.manifestId,
      provider: input.providerName,
      providerMessageId,
      transport: envelope.transport,
      recipient: envelope.recipient,
      approvedTextSha256: envelope.approvedTextSha256,
      transportPayloadSha256: envelope.transportPayloadSha256,
      idempotencyKey: input.idempotencyKey,
      providerPayloadSha256: input.providerPayloadSha256,
      networkAttempted: true as const,
      sent,
      status: outcome.status,
      outreachEventId,
      failureCode,
      detail,
    });
  });
}

/** Journalise un refus pré-réseau puis rend l'erreur à lever, comme le fait le DRY_RUN. */
async function blockedBeforeNetwork(
  sql: Sql,
  requestedManifestId: string,
  envelope: DispatchEnvelope | null,
  code: DispatchBlockCode,
  message: string,
): Promise<DispatchBlockedError> {
  const attemptId = await insertDispatchAttempt(sql, {
    requestedManifestId,
    manifestId: envelope?.manifestId ?? null,
    mode: 'LIVE',
    transport: envelope?.transport ?? null,
    recipient: envelope?.recipient ?? null,
    approvedTextSha256: envelope?.approvedTextSha256 ?? null,
    transportPayloadSha256: envelope?.transportPayloadSha256 ?? null,
    liveReady: null,
    missingForLive: null,
    status: 'BLOCKED',
    errorCode: code,
    // La base refuse `network_attempted = true` sur un BLOCKED (0023) : un
    // refus ne peut pas mentir sur le fait qu'il a précédé le réseau.
    networkAttempted: false,
    sent: false,
    provider: null,
    providerMessageId: null,
    liveAttemptId: null,
  });
  return new DispatchBlockedError(code, message, attemptId);
}

export interface LiveEnvironment {
  readonly allowSending: boolean;
  readonly liveManifestId: string | undefined;
}

/**
 * Le seul chemin d'un envoi réel.
 *
 * Refuse par une exception (`DispatchBlockedError`) tant que rien n'est parti,
 * et retourne un résultat dès que le réseau a été touché : un appelant ne peut
 * donc pas confondre « rien ne s'est passé » et « quelque chose a peut-être
 * été envoyé ». Ne retente jamais, quelle que soit l'issue.
 */
export async function dispatchManifestLive(
  sql: Sql,
  requestedManifestId: string,
  deps: LiveDispatchDeps,
  environment: LiveEnvironment,
): Promise<LiveDispatchResult> {
  const requested = String(requestedManifestId ?? '');

  // 1. La triple garde, avant tout accès à la base.
  const gate = evaluateLiveGate({
    mode: 'LIVE',
    allowSending: environment.allowSending,
    envManifestId: environment.liveManifestId,
    requestedManifestId: requested,
  });
  if (!gate.armed) {
    throw await blockedBeforeNetwork(sql, requested, null, gate.code, gate.reason);
  }

  // 2. Les mêmes validations qu'un DRY_RUN — statut, unicité, empreintes du
  // texte et du payload, forme du destinataire. Un LIVE n'en relâche aucune.
  const { envelope } = await resolveDispatchTarget(sql, requested, 'LIVE');

  // IG2 — comparé au transport ARMÉ de cette mission, et non au registre des
  // capacités. Le registre dit désormais que `instagram_dm` sait envoyer, ce qui
  // est vrai ; mais ce chemin-ci construit un email et parle à un provider
  // d'email. Un transport « capable » ailleurs ne doit pas devenir dispatchable
  // ici du seul fait qu'une autre mission a écrit son adapter.
  if (envelope.transport !== R6B_LIVE_ARMED_TRANSPORT) {
    throw await blockedBeforeNetwork(
      sql,
      requested,
      envelope,
      'LIVE_TRANSPORT_UNSUPPORTED',
      `transport « ${envelope.transport} » — ce chemin n'envoie que du ${R6B_LIVE_ARMED_TRANSPORT} ` +
        '(un DM Instagram passe par le canari, jamais par ici)',
    );
  }
  if (!hasLiveAdapter(envelope.transport)) {
    throw await blockedBeforeNetwork(
      sql,
      requested,
      envelope,
      'LIVE_TRANSPORT_UNSUPPORTED',
      `aucun adapter LIVE pour le transport « ${envelope.transport} »`,
    );
  }

  const readiness = getLiveReadiness(envelope);
  if (!readiness.ready) {
    throw await blockedBeforeNetwork(
      sql,
      requested,
      envelope,
      'LIVE_MANIFEST_NOT_READY',
      `manifeste incomplet pour un envoi réel (manque : ${readiness.missing.join(', ')})`,
    );
  }

  const identity = validateSenderIdentity(deps.senderIdentity.from, deps.senderIdentity.replyTo);
  if (!identity.ok) {
    throw await blockedBeforeNetwork(sql, requested, envelope, 'SENDER_IDENTITY_INVALID', identity.reason);
  }

  // 3. Le payload exact — construit ici, à partir de l'enveloppe figée et de
  // la seule identité d'expéditeur. Rien de ce que l'appelant a fourni n'y
  // entre : ni destinataire, ni objet, ni corps, ni transport.
  let request: EmailSendRequest;
  try {
    request = buildEmailSendRequest(envelope, identity.identity);
  } catch (error) {
    throw await blockedBeforeNetwork(
      sql,
      requested,
      envelope,
      'LIVE_PAYLOAD_INVALID',
      error instanceof Error ? error.message : String(error),
    );
  }

  const idempotencyKey = deriveIdempotencyKey(envelope.manifestId);
  // Calculée sur la requête exacte, donc identique à celle qu'une
  // réconciliation recalculera plus tard : c'est la comparaison des deux qui
  // autorisera — ou non — un rejeu à l'identique.
  const providerPayloadSha256 = hashProviderPayload(request);

  // 4. Réservation atomique. Deux processus simultanés : un seul en sort.
  let liveAttemptId: string;
  try {
    liveAttemptId = await claimLiveAttempt(sql, envelope, idempotencyKey, providerPayloadSha256, deps.provider.name);
  } catch (error) {
    if (error instanceof DispatchBlockedError) {
      throw await blockedBeforeNetwork(sql, requested, envelope, error.code, error.message);
    }
    throw error;
  }

  // 5. Le réseau. Un appel, un seul, jamais retenté — y compris sur timeout :
  // rejouer une requête d'envoi dont on n'a pas vu la réponse est exactement
  // la façon d'envoyer deux fois.
  await markNetworkAttempted(sql, liveAttemptId);
  const outcome = await deps.provider.send(request, idempotencyKey);

  // 6. L'issue, et elle seule, décide s'il existe un outreach_event.
  return finalizeOutcome(sql, {
    envelope,
    liveAttemptId,
    idempotencyKey,
    providerPayloadSha256,
    providerName: deps.provider.name,
    outcome,
    requestedManifestId: requested,
  });
}


// ---------------------------------------------------------------------------
// Réconciliation d'une issue inconnue
// ---------------------------------------------------------------------------

/**
 * R6B-C.2B.1 — ce qu'une réconciliation peut conclure.
 *
 * La distinction qui compte est celle entre « on peut encore apprendre la
 * réponse par un moyen documenté » et « plus aucun moyen automatique
 * n'existe » : la première laisse la machine travailler, la seconde réveille
 * un humain. Elles ne se déduisent pas d'un code d'erreur mais de la fenêtre
 * d'idempotence du provider, qui est un fait daté.
 */
export type ReconcileStatus =
  /** Rien à trancher : aucune tentative, ou une tentative déjà terminale et connue. */
  | 'NOTHING_TO_RECONCILE'
  /** Le registre disait déjà SENT — aucun appel n'a été nécessaire. */
  | 'ALREADY_SENT'
  /** Le provider confirme l'existence de l'email : l'issue devient SENT. */
  | 'CONFIRMED_SENT'
  /**
   * Non conclu, mais un chemin documenté reste ouvert (fenêtre d'idempotence
   * encore valide) : relancer la réconciliation plus tard a un sens.
   */
  | 'UNRESOLVED'
  /**
   * Plus aucun chemin automatique. Fenêtre d'idempotence expirée, ou conflit
   * de payload chez le provider. Un humain doit aller regarder le tableau de
   * bord Resend et trancher — le système, lui, ne rejouera plus rien.
   */
  | 'REQUIRES_HUMAN_RECONCILIATION';

export interface ReconcileResult {
  readonly status: ReconcileStatus;
  readonly manifestId: string;
  readonly liveAttemptId: string | null;
  readonly providerMessageId: string | null;
  readonly outreachEventId: string | null;
  readonly detail: string;
  /** Vrai dès qu'une lecture provider a eu lieu (`GET`). Aucune n'envoie quoi que ce soit. */
  readonly providerQueried: boolean;
  /** Vrai si le `POST` d'origine a été rejoué à l'identique (même clé, même payload). */
  readonly providerReplayed: boolean;
  /** Où en est la fenêtre d'idempotence de 24 h du provider au moment de l'appel. */
  readonly withinIdempotencyWindow: boolean;
  /**
   * Identifiants d'envois récents qui *ressemblent* à celui-ci (destinataire +
   * objet + fenêtre temporelle). Diagnostic pour un humain, jamais une preuve :
   * voir `matchesEnvelope`.
   */
  readonly diagnosticCandidates: readonly string[];
}

export interface ReconcileDeps {
  readonly provider: EmailProvider;
  /**
   * L'identité d'expéditeur configurée. Exigée même en lecture seule : sans
   * elle, impossible de recalculer la requête d'origine, donc impossible de
   * vérifier qu'un rejeu porterait le même payload.
   */
  readonly senderIdentity: SenderIdentity;
  /** Nombre d'envois récents relus pour le diagnostic. */
  readonly listLimit?: number;
  /**
   * §2A — autorise le rejeu à l'identique du `POST` (même clé, même payload,
   * dans la fenêtre de 24 h).
   *
   * Faux par défaut, et c'est délibéré : `--reconcile` ne fait que lire, comme
   * son nom le promet. Le rejeu peut délivrer un email dans le monde où la
   * première requête n'était jamais arrivée — un humain doit donc le demander
   * explicitement (`--allow-idempotent-replay`), même si le résultat reste
   * « exactement un email » dans tous les cas.
   */
  readonly allowIdempotentReplay?: boolean;
  /** Bornes du rejeu sur `concurrent_idempotent_requests`. Jamais de boucle infinie. */
  readonly maxReplayAttempts?: number;
  readonly replayDelayMs?: number;
  /** Injectables pour les tests : aucun test n'attend réellement. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Bornes du rejeu. Trois requêtes au maximum, espacées de deux secondes — assez
 * pour laisser passer une requête concurrente, trop peu pour ressembler à une
 * boucle de retry généraliste (que §4 interdit explicitement).
 */
const DEFAULT_MAX_REPLAY_ATTEMPTS = 3;
const DEFAULT_REPLAY_DELAY_MS = 2_000;

/**
 * Heuristique de diagnostic, et rien de plus.
 *
 * `GET /emails` ne sait pas filtrer : ni par destinataire, ni par objet, ni par
 * clé d'idempotence — seulement paginer. Un « match » ici n'est donc qu'une
 * comparaison faite côté client sur destinataire + objet + fenêtre temporelle,
 * c'est-à-dire trois attributs qu'un second envoi au même prospect porterait
 * à l'identique. Ce n'est pas une identité d'envoi, et §5 en tire la seule
 * conclusion possible : cela ne suffit jamais à écrire `SENT`.
 */
function matchesEnvelope(record: ProviderEmailRecord, envelope: DispatchEnvelope, claimedAt: string): boolean {
  const subject = envelope.transportPayload.subject;
  if (typeof subject !== 'string') return false;
  if (!record.to.includes(envelope.recipient)) return false;
  if (record.subject !== subject) return false;
  if (record.createdAt === null) return true;
  const created = Date.parse(record.createdAt);
  const claimed = Date.parse(claimedAt);
  if (!Number.isFinite(created) || !Number.isFinite(claimed)) return true;
  // Une minute de marge avant la réservation : les horloges du provider et de
  // la base ne sont pas les mêmes, et un envoi ne peut pas précéder sa
  // réservation de plus que cela.
  return created >= claimed - 60_000;
}

/** Envois récents qui ressemblent à celui-ci — pour un humain, jamais pour décider. */
async function collectDiagnosticCandidates(
  deps: ReconcileDeps,
  envelope: DispatchEnvelope,
  claimedAt: string,
): Promise<string[]> {
  try {
    const recent = await deps.provider.listRecent(deps.listLimit ?? 100);
    return recent.filter((record) => matchesEnvelope(record, envelope, claimedAt)).map((record) => record.id);
  } catch {
    // Le diagnostic est un confort : son échec ne doit pas transformer une
    // issue inconnue en exception, ni faire croire qu'il n'y a rien à trouver.
    return [];
  }
}

/**
 * Inscrit un envoi confirmé : registre, journal, et l'unique `outreach_event`.
 *
 * Une seule transaction, et `where status in ('CLAIMED','AMBIGUOUS')` : si un
 * autre processus a conclu entre-temps, l'`update` ne touche rien et l'index
 * unique `outreach_events_one_sent_per_manifest_idx` (0023) refuse le second
 * événement. Le « exactement un » ne dépend donc pas de l'ordonnancement.
 */
async function confirmSent(
  sql: Sql,
  envelope: DispatchEnvelope,
  open: LiveAttemptRow,
  providerMessageId: string,
  providerName: 'resend',
  detail: string,
): Promise<string> {
  return sql.transaction(async (tx) => {
    await tx.query(
      `update r6b_live_send_attempts
          set status = 'SENT', provider_message_id = $2, failure_code = null,
              detail = $3, completed_at = now()
        where id = $1 and status in ('CLAIMED', 'AMBIGUOUS')`,
      [open.id, providerMessageId, detail],
    );

    const rows = await tx.query<{ id: string }>(
      `insert into outreach_events (prospect_id, kind, channel, payload, manifest_id)
       values ($1,'sent',$2,$3::jsonb,$4)
       returning id`,
      [
        envelope.prospectId,
        envelope.transport,
        JSON.stringify({
          provider: providerName,
          provider_message_id: providerMessageId,
          recipient: envelope.recipient,
          approved_text_sha256: envelope.approvedTextSha256,
          transport_payload_sha256: envelope.transportPayloadSha256,
          provider_payload_sha256: open.providerPayloadSha256,
          idempotency_key: open.idempotencyKey,
          live_attempt_id: open.id,
          reconciled: true,
        }),
        envelope.manifestId,
      ],
    );
    const eventId = rows[0]?.id;
    if (!eventId) throw new Error('outreach_events insert did not return a row');

    await insertDispatchAttempt(tx, {
      requestedManifestId: envelope.manifestId,
      manifestId: envelope.manifestId,
      mode: 'LIVE',
      transport: envelope.transport,
      recipient: envelope.recipient,
      approvedTextSha256: envelope.approvedTextSha256,
      transportPayloadSha256: envelope.transportPayloadSha256,
      liveReady: true,
      missingForLive: [],
      status: 'SENT',
      errorCode: null,
      networkAttempted: true,
      sent: true,
      provider: providerName,
      providerMessageId,
      liveAttemptId: open.id,
    });

    return eventId;
  });
}

/** Note ce qu'une réconciliation non conclusive a appris, sans changer le statut. */
async function recordReconcileNote(sql: Sql, liveAttemptId: string, note: string): Promise<void> {
  await sql.query(
    `update r6b_live_send_attempts set detail = $2
      where id = $1 and status in ('CLAIMED', 'AMBIGUOUS')`,
    [liveAttemptId, note.slice(0, 500)],
  );
}

/**
 * Le rejeu à l'identique, borné.
 *
 * Ce que Resend garantit et qui rend ce chemin sûr — vérifié dans la
 * documentation, pas supposé : « If you're using the same request […] our API
 * will give the same response, without actually sending the email again »,
 * pendant 24 h.
 *
 * Les deux mondes possibles après un `POST` dont la réponse n'est jamais
 * revenue, et pourquoi le rejeu est légitime dans les deux :
 *
 *   1. la requête était arrivée → le rejeu renvoie sa réponse d'origine, et
 *      rien ne repart ;
 *   2. la requête n'était jamais arrivée → le rejeu l'envoie, et c'est le
 *      premier et unique envoi de ce manifeste.
 *
 * Dans les deux cas : exactement un email, celui que un opérateur a approuvé. Ce
 * n'est donc pas une nouvelle intention commerciale, c'est la même, poursuivie
 * jusqu'à une issue connue — d'où l'interdiction absolue d'y toucher à la clé
 * (§2B) : une clé neuve ferait du monde 1 un double envoi.
 */
async function replayIdenticalRequest(
  deps: ReconcileDeps,
  request: EmailSendRequest,
  idempotencyKey: string,
): Promise<{ readonly outcome: ProviderSendOutcome; readonly attempts: number }> {
  const maxAttempts = Math.max(1, deps.maxReplayAttempts ?? DEFAULT_MAX_REPLAY_ATTEMPTS);
  const delayMs = deps.replayDelayMs ?? DEFAULT_REPLAY_DELAY_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));

  let outcome = await deps.provider.send(request, idempotencyKey);
  let attempts = 1;

  // Une seule situation justifie de recommencer, et elle est documentée mot
  // pour mot : `concurrent_idempotent_requests` — « it is safe to retry this
  // request later if needed ». Tout le reste sort immédiatement : ce n'est pas
  // une boucle de retry généraliste, c'est l'attente d'une requête concurrente
  // que le provider nous dit d'attendre.
  while (
    attempts < maxAttempts &&
    outcome.status === 'AMBIGUOUS' &&
    outcome.failureCode === PROVIDER_CONCURRENT_IDEMPOTENT_REQUEST
  ) {
    await sleep(delayMs);
    outcome = await deps.provider.send(request, idempotencyKey);
    attempts += 1;
  }

  return { outcome, attempts };
}

/**
 * Tranche une tentative d'issue inconnue.
 *
 * Trois chemins, du plus fort au plus faible, et aucun ne peut être atteint
 * sans que la requête recalculée soit LITTÉRALEMENT celle d'origine (même
 * manifeste, même clé, même empreinte de payload — vérifié avant tout réseau) :
 *
 *   1. identifiant provider déjà connu → `GET /emails/{id}`, autoritaire ;
 *   2. sinon, dans la fenêtre de 24 h et sur demande humaine explicite →
 *      rejeu à l'identique du `POST`, qui est le SEUL moyen documenté
 *      d'apprendre l'identifiant (aucune primitive Resend ne cherche par clé
 *      d'idempotence) ;
 *   3. sinon → aucune conclusion automatique.
 *
 * Ce que cette fonction ne fera jamais :
 *
 *   * changer de clé d'idempotence, y ajouter un compteur, un horodatage ou un
 *     suffixe — ce serait convertir un rejeu en second envoi (§2B) ;
 *   * rejouer un `POST` au-delà de la fenêtre du provider (§3) : la clé n'y
 *     étant plus connue, le « rejeu » serait un envoi neuf ;
 *   * écrire `SENT` sur la foi d'une correspondance destinataire + objet
 *     trouvée dans `GET /emails` (§5) — ce n'est pas une identité d'envoi ;
 *   * conclure « rien n'est parti ». Ne pas retrouver un email n'est pas une
 *     preuve d'absence (CLAUDE.md, interdit n°2) : sans confirmation, la
 *     tentative reste bloquante et attend un humain.
 */
export async function reconcileLiveAttempt(
  sql: Sql,
  requestedManifestId: string,
  deps: ReconcileDeps,
): Promise<ReconcileResult> {
  const requested = String(requestedManifestId ?? '').trim();
  if (requested !== R6B_LIVE_ARMED_MANIFEST_ID) {
    throw new DispatchBlockedError(
      'LIVE_MANIFEST_MISMATCH',
      `réconciliation refusée : ${requested} n'est pas le manifeste armé de cette mission`,
    );
  }

  const manifest = await loadManifestByIdForUpdate(sql, requested);
  if (!manifest) {
    throw new DispatchBlockedError('MANIFEST_NOT_FOUND', `aucun manifeste ${requested}`);
  }
  const envelope = buildDispatchEnvelope(manifest);

  const attempts = await loadLiveAttempts(sql, requested);
  const open = attempts.find((row) => row.status === 'AMBIGUOUS' || row.status === 'CLAIMED');
  const sentRow = attempts.find((row) => row.status === 'SENT');

  const idle = {
    providerQueried: false,
    providerReplayed: false,
    withinIdempotencyWindow: false,
    diagnosticCandidates: Object.freeze([] as string[]),
  } as const;

  // §9 — un manifeste déjà envoyé ne peut pas être « réconcilié » en un second
  // envoi. On sort avant toute construction de requête : il n'existe aucun
  // chemin de code menant d'ici au provider.
  if (sentRow) {
    return Object.freeze({
      ...idle,
      status: 'ALREADY_SENT' as const,
      manifestId: requested,
      liveAttemptId: sentRow.id,
      providerMessageId: sentRow.providerMessageId,
      outreachEventId: null,
      detail: 'le registre porte déjà un envoi confirmé — aucune lecture provider nécessaire',
    });
  }
  if (!open) {
    return Object.freeze({
      ...idle,
      status: 'NOTHING_TO_RECONCILE' as const,
      manifestId: requested,
      liveAttemptId: null,
      providerMessageId: null,
      outreachEventId: null,
      detail: 'aucune tentative LIVE ouverte pour ce manifeste',
    });
  }
  if (!open.networkAttempted) {
    return Object.freeze({
      ...idle,
      status: 'NOTHING_TO_RECONCILE' as const,
      manifestId: requested,
      liveAttemptId: open.id,
      providerMessageId: null,
      outreachEventId: null,
      detail:
        'la réservation n’a jamais touché le réseau — rien n’a pu partir, ' +
        'mais elle doit être levée à la main plutôt que réconciliée',
    });
  }

  // -------------------------------------------------------------------------
  // Identité de la requête — vérifiée AVANT le moindre octet réseau
  // -------------------------------------------------------------------------
  //
  // Tout ce qui suit repose sur une affirmation : « rejouer enverrait
  // exactement la même chose ». Elle se vérifie, elle ne se suppose pas.

  const identity = validateSenderIdentity(deps.senderIdentity.from, deps.senderIdentity.replyTo);
  if (!identity.ok) {
    throw new DispatchBlockedError('SENDER_IDENTITY_INVALID', identity.reason);
  }

  let request: EmailSendRequest;
  try {
    request = buildEmailSendRequest(envelope, identity.identity);
  } catch (error) {
    throw new DispatchBlockedError('LIVE_PAYLOAD_INVALID', error instanceof Error ? error.message : String(error));
  }

  const idempotencyKey = deriveIdempotencyKey(envelope.manifestId);
  const providerPayloadSha256 = hashProviderPayload(request);

  // §2B — la clé recalculée doit être celle qui est réellement partie. Elle
  // est dérivée du seul identifiant de manifeste, donc un écart ici signale
  // que la dérivation a changé sous nos pieds : rejouer produirait un second
  // email au lieu de relire le premier.
  if (open.idempotencyKey !== idempotencyKey) {
    throw new DispatchBlockedError(
      'LIVE_IDEMPOTENCY_KEY_DRIFT',
      `la clé d'idempotence enregistrée (${open.idempotencyKey}) diffère de celle recalculée — ` +
        'aucun rejeu possible : une clé différente ferait un second envoi',
    );
  }

  // §9 — même clé, payload changé : refusé ICI, avant le réseau, et non
  // délégué au 409 du provider. Le provider dirait la même chose, mais après
  // un appel — et un appel de trop est exactement ce qu'on cherche à éviter.
  if (open.providerPayloadSha256 !== providerPayloadSha256) {
    throw new DispatchBlockedError(
      'LIVE_PROVIDER_PAYLOAD_DRIFT',
      `le payload provider a changé depuis la tentative (${open.providerPayloadSha256.slice(0, 12)}… ` +
        `vs ${providerPayloadSha256.slice(0, 12)}…) — expéditeur, reply-to, objet ou texte ne sont plus les mêmes. ` +
        'Aucun rejeu : il enverrait un email différent de celui qui a peut-être déjà été envoyé.',
    );
  }

  const now = deps.now?.() ?? Date.now();
  const expiresAt = Date.parse(open.providerIdempotencyExpiresAt);
  const withinWindow = Number.isFinite(expiresAt) && now < expiresAt;

  // -------------------------------------------------------------------------
  // 1. Identifiant provider connu → relecture autoritaire
  // -------------------------------------------------------------------------
  //
  // Le cas normal après qu'un humain a retrouvé l'email dans le tableau de bord
  // Resend et inscrit son identifiant sur la tentative : le système vérifie
  // alors lui-même, au lieu de croire sur parole.
  if (open.providerMessageId !== null) {
    const record = await deps.provider.retrieve(open.providerMessageId);
    if (record !== null && record.to.includes(envelope.recipient)) {
      const outreachEventId = await confirmSent(
        sql,
        envelope,
        open,
        record.id,
        deps.provider.name,
        `réconcilié depuis « ${open.status} » — confirmé par GET /emails/${record.id}`,
      );
      return Object.freeze({
        status: 'CONFIRMED_SENT' as const,
        manifestId: requested,
        liveAttemptId: open.id,
        providerMessageId: record.id,
        outreachEventId,
        detail: `envoi confirmé par identifiant exact (dernier événement : ${record.lastEvent ?? 'inconnu'})`,
        providerQueried: true,
        providerReplayed: false,
        withinIdempotencyWindow: withinWindow,
        diagnosticCandidates: Object.freeze([] as string[]),
      });
    }

    const detail =
      `l'identifiant enregistré (${open.providerMessageId}) n'est pas confirmé par le provider ` +
      '— ceci ne prouve pas qu’aucun email n’est parti ; vérification humaine requise';
    await recordReconcileNote(sql, open.id, detail);
    return Object.freeze({
      status: 'REQUIRES_HUMAN_RECONCILIATION' as const,
      manifestId: requested,
      liveAttemptId: open.id,
      providerMessageId: open.providerMessageId,
      outreachEventId: null,
      detail,
      providerQueried: true,
      providerReplayed: false,
      withinIdempotencyWindow: withinWindow,
      diagnosticCandidates: Object.freeze([] as string[]),
    });
  }

  // -------------------------------------------------------------------------
  // 2. Hors fenêtre d'idempotence → §3, plus aucun POST automatique
  // -------------------------------------------------------------------------
  if (!withinWindow) {
    const candidates = await collectDiagnosticCandidates(deps, envelope, open.claimedAt);
    const detail =
      `fenêtre d'idempotence du provider expirée (${open.providerIdempotencyExpiresAt}) — ` +
      'aucun rejeu possible : la clé n’étant plus connue de Resend, un rejeu serait un envoi neuf. ' +
      (candidates.length === 0
        ? 'Aucun envoi récent ne ressemble à celui-ci, ce qui ne prouve rien. '
        : `${candidates.length} envoi(s) récent(s) y ressemblent (${candidates.join(', ')}), ` +
          'ce qui n’est pas une preuve d’identité. ') +
      'Un humain doit trancher depuis le tableau de bord Resend.';
    await recordReconcileNote(sql, open.id, detail);
    return Object.freeze({
      status: 'REQUIRES_HUMAN_RECONCILIATION' as const,
      manifestId: requested,
      liveAttemptId: open.id,
      providerMessageId: null,
      outreachEventId: null,
      detail,
      providerQueried: true,
      providerReplayed: false,
      withinIdempotencyWindow: false,
      diagnosticCandidates: Object.freeze(candidates),
    });
  }

  // -------------------------------------------------------------------------
  // 3. Dans la fenêtre → rejeu à l'identique, sur demande humaine explicite
  // -------------------------------------------------------------------------
  if (deps.allowIdempotentReplay !== true) {
    const candidates = await collectDiagnosticCandidates(deps, envelope, open.claimedAt);
    const detail =
      `dans la fenêtre d'idempotence jusqu'à ${open.providerIdempotencyExpiresAt}. ` +
      'Aucune primitive Resend ne retrouve un email par sa clé d’idempotence : le seul moyen documenté ' +
      'd’apprendre l’identifiant est de rejouer la requête à l’identique (même clé, même payload), ' +
      'ce qui n’envoie rien de plus mais doit être demandé explicitement. ' +
      (candidates.length === 0
        ? 'Aucun envoi récent ne ressemble à celui-ci, ce qui ne prouve rien.'
        : `${candidates.length} envoi(s) récent(s) y ressemblent (${candidates.join(', ')}), ` +
          'ce qui n’est pas une preuve d’identité.');
    await recordReconcileNote(sql, open.id, detail);
    return Object.freeze({
      status: 'UNRESOLVED' as const,
      manifestId: requested,
      liveAttemptId: open.id,
      providerMessageId: null,
      outreachEventId: null,
      detail,
      providerQueried: true,
      providerReplayed: false,
      withinIdempotencyWindow: true,
      diagnosticCandidates: Object.freeze(candidates),
    });
  }

  const { outcome, attempts: replayAttempts } = await replayIdenticalRequest(deps, request, idempotencyKey);

  if (outcome.status === 'SENT') {
    const outreachEventId = await confirmSent(
      sql,
      envelope,
      open,
      outcome.providerMessageId,
      deps.provider.name,
      `réconcilié depuis « ${open.status} » — rejeu à l'identique (clé inchangée), ` +
        `réponse du provider : ${outcome.providerMessageId}`,
    );
    return Object.freeze({
      status: 'CONFIRMED_SENT' as const,
      manifestId: requested,
      liveAttemptId: open.id,
      providerMessageId: outcome.providerMessageId,
      outreachEventId,
      detail:
        `envoi confirmé par rejeu idempotent (${replayAttempts} requête(s), clé inchangée). ` +
        'Exactement un email existe : soit celui de la tentative d’origine, soit celui-ci.',
      providerQueried: false,
      providerReplayed: true,
      withinIdempotencyWindow: true,
      diagnosticCandidates: Object.freeze([] as string[]),
    });
  }

  // §4 — `invalid_idempotent_request` : la clé a déjà servi avec un AUTRE
  // payload. Nos gardes locales ont pourtant vu deux empreintes identiques :
  // c'est donc que ce qui est parti ne correspond à rien de ce que la base
  // connaît. Resend conseille « Change your idempotency key or payload » ; ce
  // conseil enverrait un second email et n'est pas suivi.
  const conflicted = outcome.failureCode === PROVIDER_INVALID_IDEMPOTENT_REQUEST;
  const stillConcurrent = outcome.failureCode === PROVIDER_CONCURRENT_IDEMPOTENT_REQUEST;

  const failureCode = outcome.failureCode;
  const detail = conflicted
    ? `le provider signale « ${PROVIDER_INVALID_IDEMPOTENT_REQUEST} » : cette clé a déjà servi avec un payload ` +
      'différent de celui reconstruit ici. Aucun rejeu supplémentaire, et surtout aucune nouvelle clé — ' +
      'un humain doit identifier ce qui est réellement parti.'
    : stillConcurrent
      ? `une requête concurrente portant la même clé est toujours en cours après ${replayAttempts} tentative(s) ` +
        'bornées. Aucun envoi supplémentaire n’a été fait ; relancer la réconciliation plus tard est sans risque.'
      : `rejeu non concluant après ${replayAttempts} requête(s) (${failureCode}) — ` +
        'ceci ne prouve pas qu’aucun email n’est parti ; la tentative reste bloquante.';

  await recordReconcileNote(sql, open.id, detail);

  return Object.freeze({
    status: conflicted ? ('REQUIRES_HUMAN_RECONCILIATION' as const) : ('UNRESOLVED' as const),
    manifestId: requested,
    liveAttemptId: open.id,
    providerMessageId: null,
    outreachEventId: null,
    detail,
    providerQueried: false,
    providerReplayed: true,
    withinIdempotencyWindow: true,
    diagnosticCandidates: Object.freeze([] as string[]),
  });
}
