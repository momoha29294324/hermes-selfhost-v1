import type { Sql } from '@/lib/db/sql';
import {
  ALL_TRANSPORTS,
  loadActiveLockedManifestIdsForItem,
  loadManifestById,
  sha256Hex,
  type DispatchManifest,
  type Transport,
} from '@/lib/pipeline/r6bDispatch';
import {
  getLiveReadiness,
  hashTransportPayload,
  unsupportedPayloadKeys,
} from '@/lib/pipeline/r6bTransportPayload';
import { DRY_RUN_ADAPTERS, type DispatchEnvelope, type DryRunPreview } from '@/lib/pipeline/r6bTransportAdapters';
import { loadBlockingProspectState, loadRecipientSuppression } from '@/lib/replies/state';

/**
 * R6B-C.1 — dispatcher à manifeste exact (mission « Hermes R6B-C.1
 * — Exact Manifest Dispatcher / DRY-RUN Gate »).
 *
 * Une seule porte d'entrée, un seul argument de sélection :
 *
 *     dispatchManifest(sql, manifestId, mode)
 *
 * §1 — il n'existe aucun moyen de désigner une cible autrement : pas de
 * `prospectId`, pas de `batchId`, pas de `sendAll`, pas de requête dynamique.
 * Trois paramètres positionnels plutôt qu'un objet d'options, précisément
 * pour qu'on ne puisse pas y glisser plus tard un `recipient` ou un `text`
 * fourni par l'appelant sans que la signature change sous les yeux d'un
 * relecteur.
 *
 * §2 — le manifeste est la source de vérité. Transport, destinataire et texte
 * sont lus depuis `r6b_dispatch_manifests` et jamais recalculés :
 * `resolveTransportOptions`, la fiche prospect, le crawl, les canaux observés
 * et tout appel LLM sont hors de ce chemin. Le choix commercial a été fait
 * par un humain au moment du lock ; ce module en vérifie l'intégrité, il ne
 * le refait pas. Un prospect dont l'email change après le lock est donc
 * toujours dispatché — en DRY_RUN — vers l'adresse figée, pas la nouvelle.
 *
 * §6/§7 — LIVE est impossible ici, et pas parce qu'un drapeau est à 0 :
 * aucun adapter capable de contacter qui que ce soit n'existe dans ce dépôt
 * (voir `LIVE_ADAPTERS`, vide par construction). `OUTBOUND_ALLOW_SENDING`
 * n'est donc lu nulle part dans ce module — un flag ne peut pas autoriser du
 * code qui n'existe pas, et le laisser intervenir ici donnerait l'illusion
 * inverse.
 */

export type DispatchMode = 'DRY_RUN' | 'LIVE';

export const DISPATCH_MODES: readonly DispatchMode[] = ['DRY_RUN', 'LIVE'];

export type DispatchBlockCode =
  | 'MODE_INVALID'
  /** R6B-C.2B — ce point d'entrée reste celui du DRY_RUN ; un envoi réel a le sien, avec sa triple garde. */
  | 'LIVE_NOT_ON_THIS_PATH'
  // ---------------------------------------------------------------------
  // R6B-C.2B — refus du chemin LIVE (`r6bLiveDispatch`). Tous surviennent
  // AVANT le moindre octet réseau ; la base l'impose (0023 :
  // `r6b_dispatch_attempt_blocked_is_pre_network`).
  // ---------------------------------------------------------------------
  | 'LIVE_MODE_REQUIRED'
  | 'LIVE_SENDING_DISABLED'
  | 'LIVE_MANIFEST_NOT_ARMED'
  | 'LIVE_MANIFEST_MISMATCH'
  | 'LIVE_TRANSPORT_UNSUPPORTED'
  | 'LIVE_MANIFEST_NOT_READY'
  | 'LIVE_PAYLOAD_INVALID'
  | 'SENDER_IDENTITY_INVALID'
  | 'LIVE_MANIFEST_DRIFT'
  // -----------------------------------------------------------------------
  // R6B-C.2B.1 — refus d'une réconciliation avant tout réseau. Un rejeu à
  // l'identique n'est sûr que si la requête est LITTÉRALEMENT la même ; ces
  // deux codes disent qu'elle ne l'est pas, donc qu'aucun rejeu n'aura lieu.
  // -----------------------------------------------------------------------
  | 'LIVE_IDEMPOTENCY_KEY_DRIFT'
  | 'LIVE_PROVIDER_PAYLOAD_DRIFT'
  | 'LIVE_ALREADY_SENT'
  | 'LIVE_ATTEMPT_IN_FLIGHT'
  | 'LIVE_ATTEMPT_AMBIGUOUS_PENDING'
  | 'MANIFEST_NOT_FOUND'
  | 'MANIFEST_SUPERSEDED'
  | 'MANIFEST_NOT_LOCKED'
  | 'MANIFEST_NOT_CURRENT'
  // -----------------------------------------------------------------------
  // R6B-D2 — un prospect qui a répondu « arrêtez » ne peut pas réapparaître
  // dans la file sortante. Le refus vit ici, sur le chemin PARTAGÉ par le
  // DRY_RUN et le LIVE : une suppression que seul le chemin d'envoi
  // vérifierait ne serait pas visible tant que personne n'envoie, donc
  // impossible à tester sans envoyer.
  // -----------------------------------------------------------------------
  | 'RECIPIENT_SUPPRESSED'
  | 'PROSPECT_STATE_BLOCKS_OUTBOUND'
  | 'TRANSPORT_MISSING'
  | 'TRANSPORT_UNSUPPORTED'
  | 'RECIPIENT_MISSING'
  | 'RECIPIENT_EVIDENCE_MISSING'
  | 'RECIPIENT_SHAPE_INVALID'
  | 'APPROVED_TEXT_MISSING'
  | 'APPROVED_TEXT_SHA_INVALID'
  | 'APPROVED_TEXT_SHA_MISMATCH'
  | 'TRANSPORT_PAYLOAD_INVALID'
  | 'TRANSPORT_PAYLOAD_SHA_INVALID'
  | 'TRANSPORT_PAYLOAD_SHA_MISMATCH';

/**
 * Tout refus lève. Rien ne « retourne un échec » : un appelant qui ignore la
 * valeur de retour ne peut pas prendre un blocage pour un succès. La valeur
 * de retour de `dispatchManifest` ne signifie donc qu'une seule chose — un
 * DRY_RUN est allé au bout sans rien envoyer.
 */
export class DispatchBlockedError extends Error {
  readonly code: DispatchBlockCode;
  /** Ligne `r6b_dispatch_attempts` écrite pour ce refus, ou `null` si le refus précède toute écriture. */
  readonly attemptId: string | null;

  constructor(code: DispatchBlockCode, message: string, attemptId: string | null = null) {
    super(message);
    this.name = 'DispatchBlockedError';
    this.code = code;
    this.attemptId = attemptId;
  }
}

export interface DispatchResult {
  readonly attemptId: string;
  readonly manifestId: string;
  readonly mode: 'DRY_RUN';
  readonly transport: Transport;
  readonly recipient: string;
  readonly approvedTextSha256: string;
  readonly transportPayloadSha256: string;
  /**
   * R6B-C.2A §10 — un manifeste incomplet pour un LIVE **n'est pas** une
   * erreur de DRY_RUN : le dry-run existe précisément pour dire ce qui
   * manquerait à un envoi réel. Il aboutit donc en `DRY_RUN_OK` avec
   * `liveReady = false` et `missingForLive` non vide, plutôt que de refuser
   * de s'exécuter et de priver un opérateur de la seule vérification disponible
   * avant la complétion.
   *
   * Ce qui reste bloquant en DRY_RUN, c'est l'**intégrité** du payload —
   * clé hors taxonomie, empreinte absente ou divergente — parce qu'un
   * payload dont l'empreinte ment n'est pas un payload incomplet : c'est un
   * payload dont on ne sait plus ce qu'il contient.
   */
  readonly liveReady: boolean;
  readonly missingForLive: readonly string[];
  readonly networkAttempted: false;
  readonly sent: false;
  readonly status: 'DRY_RUN_OK';
  readonly preview: DryRunPreview;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const TRANSPORTS = new Set<string>(ALL_TRANSPORTS);

/**
 * §3 — validation fail-closed d'un manifeste déjà chargé, puis construction
 * de l'enveloppe. Pure : aucune I/O, aucune écriture, le manifeste n'est
 * jamais modifié. Séparée de `dispatchManifest` pour être testable sur des
 * états que la base refuse désormais de représenter (un manifeste `LOCKED`
 * sans transport, par exemple, est interdit par
 * `r6b_manifest_locked_has_transport` en 0020 — mais le code ne doit pas
 * dépendre de cette contrainte pour rester sûr).
 */
export function buildDispatchEnvelope(manifest: DispatchManifest): DispatchEnvelope {
  if (manifest.status === 'SUPERSEDED') {
    throw new DispatchBlockedError(
      'MANIFEST_SUPERSEDED',
      `manifeste ${manifest.id} SUPERSEDED${manifest.supersededReason ? ` (${manifest.supersededReason})` : ''} — ` +
        'un choix invalidé ne se dispatche pas',
    );
  }
  if (manifest.status !== 'LOCKED') {
    throw new DispatchBlockedError('MANIFEST_NOT_LOCKED', `manifeste ${manifest.id} au statut « ${manifest.status} »`);
  }

  const transport = manifest.transport;
  if (transport === null) {
    throw new DispatchBlockedError(
      'TRANSPORT_MISSING',
      `manifeste ${manifest.id} sans transport résolu` +
        (manifest.legacyChannel ? ` (canal historique « ${manifest.legacyChannel} », taxonomie R6B-B pré-normalisation)` : ''),
    );
  }
  if (!TRANSPORTS.has(transport)) {
    throw new DispatchBlockedError('TRANSPORT_UNSUPPORTED', `transport « ${transport} » hors taxonomie`);
  }

  const recipient = manifest.recipient;
  if (recipient.trim().length === 0) {
    throw new DispatchBlockedError('RECIPIENT_MISSING', `manifeste ${manifest.id} sans destinataire`);
  }
  if (manifest.recipientEvidenceIds.length === 0) {
    throw new DispatchBlockedError(
      'RECIPIENT_EVIDENCE_MISSING',
      `manifeste ${manifest.id} sans preuve de destinataire — une destination non sourcée ne se dispatche pas`,
    );
  }

  const approvedText = manifest.approvedText;
  if (approvedText.trim().length === 0) {
    throw new DispatchBlockedError('APPROVED_TEXT_MISSING', `manifeste ${manifest.id} sans texte approuvé`);
  }
  if (!SHA256_HEX.test(manifest.approvedTextSha256)) {
    throw new DispatchBlockedError(
      'APPROVED_TEXT_SHA_INVALID',
      `manifeste ${manifest.id} : approved_text_sha256 n'est pas un sha256 hexadécimal`,
    );
  }

  // Le contrôle central : le texte porté par la ligne est-il encore
  // exactement celui qu'un opérateur a approuvé ? Recalculé, jamais supposé.
  const recomputed = sha256Hex(approvedText);
  if (recomputed !== manifest.approvedTextSha256) {
    throw new DispatchBlockedError(
      'APPROVED_TEXT_SHA_MISMATCH',
      `manifeste ${manifest.id} : le texte stocké ne correspond plus à son empreinte approuvée ` +
        `(attendu ${manifest.approvedTextSha256}, recalculé ${recomputed})`,
    );
  }

  // R6B-C.2A — le payload transport subit exactement le même traitement que
  // le texte approuvé : relu, borné à ce que le transport connaît, puis
  // rehaché. Une clé hors taxonomie est refusée plutôt qu'ignorée — un champ
  // qu'aucun adapter ne sait interpréter n'a rien à faire dans une enveloppe
  // destinée à un envoi.
  const transportPayload = manifest.transportPayload;
  if (transportPayload === null) {
    throw new DispatchBlockedError(
      'TRANSPORT_PAYLOAD_INVALID',
      `manifeste ${manifest.id} : transport_payload n'est pas un objet JSON exploitable`,
    );
  }
  const unsupported = unsupportedPayloadKeys(transport, transportPayload);
  if (unsupported.length > 0) {
    throw new DispatchBlockedError(
      'TRANSPORT_PAYLOAD_INVALID',
      `manifeste ${manifest.id} : propriété(s) « ${unsupported.join(', ')} » hors du payload attendu par ${transport}`,
    );
  }
  if (!SHA256_HEX.test(manifest.transportPayloadSha256)) {
    throw new DispatchBlockedError(
      'TRANSPORT_PAYLOAD_SHA_INVALID',
      `manifeste ${manifest.id} : transport_payload_sha256 n'est pas un sha256 hexadécimal`,
    );
  }
  const recomputedPayloadSha = hashTransportPayload(transportPayload);
  if (recomputedPayloadSha !== manifest.transportPayloadSha256) {
    throw new DispatchBlockedError(
      'TRANSPORT_PAYLOAD_SHA_MISMATCH',
      `manifeste ${manifest.id} : le payload transport stocké ne correspond plus à son empreinte ` +
        `(attendu ${manifest.transportPayloadSha256}, recalculé ${recomputedPayloadSha})`,
    );
  }

  const envelope: DispatchEnvelope = Object.freeze({
    manifestId: manifest.id,
    batchId: manifest.batchId,
    batchItemId: manifest.batchItemId,
    prospectId: manifest.prospectId,
    transport,
    recipient,
    approvedText,
    approvedTextSha256: manifest.approvedTextSha256,
    transportPayload: Object.freeze({ ...transportPayload }),
    transportPayloadSha256: manifest.transportPayloadSha256,
    recipientEvidenceIds: Object.freeze([...manifest.recipientEvidenceIds]),
    identityStatus: manifest.identityReview,
  });

  const adapter = DRY_RUN_ADAPTERS[transport];
  const shapeIssue = adapter.validateEnvelope(envelope);
  if (shapeIssue !== null) {
    throw new DispatchBlockedError('RECIPIENT_SHAPE_INVALID', shapeIssue);
  }

  return envelope;
}

export interface DispatchAttemptRecord {
  requestedManifestId: string;
  manifestId: string | null;
  mode: DispatchMode;
  transport: Transport | null;
  recipient: string | null;
  approvedTextSha256: string | null;
  /** R6B-C.2A §11 — nuls tant que la tentative n'a pas lu le payload jusqu'au bout. */
  transportPayloadSha256: string | null;
  liveReady: boolean | null;
  missingForLive: readonly string[] | null;
  status: 'DRY_RUN_OK' | 'BLOCKED' | 'SENT' | 'AMBIGUOUS' | 'FAILED';
  errorCode: string | null;
  /**
   * R6B-C.2B — ces trois-là étaient écrits en dur à `false`/`null` tant
   * qu'aucun envoi n'existait. Ils sont maintenant fournis par l'appelant,
   * parce qu'un envoi réel doit pouvoir dire la vérité : « le réseau a été
   * touché », « le provider a confirmé », « voici son identifiant de message ».
   *
   * Ce qui a remplacé la valeur en dur n'est pas la confiance dans l'appelant,
   * ce sont les contraintes de 0023 : un `BLOCKED` ne peut pas déclarer un
   * appel réseau, un `SENT` ne peut pas exister sans reçu provider, et un
   * `AMBIGUOUS`/`FAILED` ne peut pas exister sans appel réseau. La base
   * refuse la ligne, elle ne fait pas confiance au code qui l'écrit.
   */
  networkAttempted: boolean;
  sent: boolean;
  /** Nom du provider ; la base restreint les valeurs acceptées (0023). */
  provider: string | null;
  providerMessageId: string | null;
  /** Ligne de `r6b_live_send_attempts` dont cette ligne est l'issue journalisée. */
  liveAttemptId: string | null;
}

/**
 * §10 — journal append-only : une ligne y est ajoutée, jamais mise à jour ni
 * supprimée. `outreach_events` reste hors de ce chemin — écrire un événement
 * de contact est la décision du seul chemin LIVE, sur succès confirmé.
 */
export async function insertDispatchAttempt(sql: Sql, record: DispatchAttemptRecord): Promise<string> {
  const rows = await sql.query<{ id: string }>(
    `insert into r6b_dispatch_attempts
       (requested_manifest_id, manifest_id, mode, transport, recipient, approved_text_sha256,
        transport_payload_sha256, live_ready, missing_for_live,
        status, network_attempted, sent, error_code,
        provider, provider_message_id, live_attempt_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     returning id`,
    [
      record.requestedManifestId,
      record.manifestId,
      record.mode,
      record.transport,
      record.recipient,
      record.approvedTextSha256,
      record.transportPayloadSha256,
      record.liveReady,
      record.missingForLive === null ? null : JSON.stringify(record.missingForLive),
      record.status,
      record.networkAttempted,
      record.sent,
      record.errorCode,
      record.provider,
      record.providerMessageId,
      record.liveAttemptId,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('r6b_dispatch_attempts insert did not return a row');
  return id;
}

/** Valeurs d'une tentative qui n'a rien tenté : le socle de tout refus et de tout DRY_RUN. */
const NOTHING_ATTEMPTED = {
  networkAttempted: false,
  sent: false,
  provider: null,
  providerMessageId: null,
  liveAttemptId: null,
} as const;

/**
 * Journalise le refus puis retourne l'erreur à lever. Rendre l'erreur plutôt
 * que la lever ici garde le `throw` visible sur le site d'appel — et permet
 * au compilateur d'y voir la fin du flot de contrôle.
 */
async function blockedError(
  sql: Sql,
  record: Omit<DispatchAttemptRecord, 'status' | 'errorCode' | keyof typeof NOTHING_ATTEMPTED>,
  code: DispatchBlockCode,
  message: string,
): Promise<DispatchBlockedError> {
  const attemptId = await insertDispatchAttempt(sql, {
    ...record,
    ...NOTHING_ATTEMPTED,
    status: 'BLOCKED',
    errorCode: code,
  });
  return new DispatchBlockedError(code, message, attemptId);
}

export interface ResolvedDispatchTarget {
  readonly manifest: DispatchManifest;
  readonly envelope: DispatchEnvelope;
}

/**
 * Charge le manifeste désigné, vérifie qu'il est bien le manifeste actif de
 * son item, et en tire l'enveloppe. Tout refus est journalisé `BLOCKED` puis
 * levé.
 *
 * Partagé mot pour mot par le DRY_RUN et par le chemin LIVE (R6B-C.2B) :
 * deux fonctions de validation seraient deux vérités, et l'une des deux
 * finirait par être la plus indulgente. Un envoi réel ne relâche donc aucune
 * des vérifications d'un dry-run — statut, unicité, empreinte du texte,
 * empreinte du payload, forme du destinataire.
 */
export async function resolveDispatchTarget(
  sql: Sql,
  manifestId: string,
  mode: DispatchMode,
): Promise<ResolvedDispatchTarget> {
  const requested = String(manifestId ?? '');

  // Résolu d'abord pour que même un refus immédiat reste rattaché au
  // manifeste concerné dans l'audit (FK nulle seulement si l'id ne résout rien).
  const manifest = await loadManifestById(sql, requested);
  const base = {
    requestedManifestId: requested,
    manifestId: manifest?.id ?? null,
    mode,
    transport: null,
    recipient: null,
    approvedTextSha256: null,
    transportPayloadSha256: null,
    liveReady: null,
    missingForLive: null,
  } as const;

  if (!manifest) {
    throw await blockedError(sql, base, 'MANIFEST_NOT_FOUND', `aucun manifeste ${requested}`);
  }

  // §3 — le manifeste doit être l'unique manifeste actif LOCKED de son item :
  // un lock plus récent sur le même item rend celui-ci obsolète, même si sa
  // propre ligne n'a pas encore été relue.
  const active = await loadActiveLockedManifestIdsForItem(sql, manifest.batchItemId);
  if (manifest.status === 'LOCKED' && (active.length !== 1 || active[0] !== manifest.id)) {
    throw await blockedError(
      sql,
      base,
      'MANIFEST_NOT_CURRENT',
      `manifeste ${manifest.id} n'est pas l'unique manifeste actif de l'item ${manifest.batchItemId} ` +
        `(actifs : ${active.length === 0 ? 'aucun' : active.join(', ')})`,
    );
  }

  let envelope: DispatchEnvelope;
  try {
    envelope = buildDispatchEnvelope(manifest);
  } catch (error) {
    if (error instanceof DispatchBlockedError) {
      throw await blockedError(sql, base, error.code, error.message);
    }
    throw error;
  }

  // R6B-D2 — les deux verrous d'une réponse déjà reçue, relus juste avant que
  // l'enveloppe soit rendue à un appelant qui pourrait s'en servir pour
  // envoyer. Ils sont vérifiés APRÈS la construction de l'enveloppe pour que le
  // refus nomme le destinataire réellement figé par le manifeste, et pas celui
  // qu'une fiche prospect porterait aujourd'hui.
  //
  // Deux verrous et non un : la liste d'exclusion porte sur une ADRESSE, l'état
  // commercial porte sur un PROSPECT. Une demande d'arrêt envoyée depuis une
  // autre boîte de la même entreprise ne couvrirait que le second ; une adresse
  // exclue avant même tout contact ne couvrirait que le premier.
  const suppression = await loadRecipientSuppression(sql, envelope.recipient);
  if (suppression !== null) {
    throw await blockedError(
      sql,
      base,
      'RECIPIENT_SUPPRESSED',
      `${envelope.recipient} figure dans do_not_contact (${suppression.reason}) — ` +
        'aucun envoi vers une adresse exclue, quel que soit le mode',
    );
  }

  const blockingState = await loadBlockingProspectState(sql, envelope.prospectId);
  if (blockingState !== null) {
    throw await blockedError(
      sql,
      base,
      'PROSPECT_STATE_BLOCKS_OUTBOUND',
      `le prospect ${envelope.prospectId} est en état « ${blockingState} » — ` +
        'une réponse déjà reçue interdit de le remettre dans la file sortante',
    );
  }

  return { manifest, envelope };
}

/**
 * Le point d'exécution d'un DRY_RUN. Charge, valide, construit l'enveloppe,
 * passe l'adapter DRY_RUN, journalise, s'arrête.
 *
 * Ne modifie jamais `r6b_dispatch_manifests` et n'écrit jamais dans
 * `outreach_events` : sa seule écriture est la ligne d'audit
 * `r6b_dispatch_attempts`. Ce chemin n'envoie rien et ne peut rien envoyer —
 * il n'appelle aucun adapter LIVE et ne connaît aucun provider.
 */
export async function dispatchManifest(
  sql: Sql,
  manifestId: string,
  mode: DispatchMode,
): Promise<DispatchResult> {
  const requested = String(manifestId ?? '');

  if (mode !== 'DRY_RUN' && mode !== 'LIVE') {
    // `mode` est typé, mais l'entrée vient aussi d'une ligne de commande.
    throw new DispatchBlockedError('MODE_INVALID', `mode de dispatch inconnu : « ${String(mode)} »`);
  }

  if (mode === 'LIVE') {
    // R6B-C.2B — un envoi réel existe désormais, mais pas ici. Il a son propre
    // point d'entrée (`dispatchManifestLive`), sa triple garde, sa réservation
    // atomique et son registre. Router un LIVE depuis cette fonction ferait
    // d'un chemin de vérification un chemin d'envoi : refusé avant même de
    // relire le manifeste.
    const manifest = await loadManifestById(sql, requested);
    throw await blockedError(
      sql,
      {
        requestedManifestId: requested,
        manifestId: manifest?.id ?? null,
        mode,
        transport: null,
        recipient: null,
        approvedTextSha256: null,
        transportPayloadSha256: null,
        liveReady: null,
        missingForLive: null,
      },
      'LIVE_NOT_ON_THIS_PATH',
      'ce point d’entrée ne fait que des DRY_RUN — un envoi réel passe par la triple garde de R6B-C.2B, ' +
        'jamais par ici',
    );
  }

  const { envelope } = await resolveDispatchTarget(sql, requested, mode);

  const preview = DRY_RUN_ADAPTERS[envelope.transport].dryRun(envelope);
  // Recalculée depuis l'enveloppe plutôt que reprise du preview : la même
  // fonction, appelée sur la même structure, doit donner le même verdict —
  // et le journal ne doit pas dépendre de ce qu'un adapter a bien voulu
  // rapporter.
  const readiness = getLiveReadiness(envelope);

  const attemptId = await insertDispatchAttempt(sql, {
    requestedManifestId: requested,
    manifestId: envelope.manifestId,
    mode: 'DRY_RUN',
    transport: envelope.transport,
    recipient: envelope.recipient,
    approvedTextSha256: envelope.approvedTextSha256,
    transportPayloadSha256: envelope.transportPayloadSha256,
    liveReady: readiness.ready,
    missingForLive: readiness.missing,
    status: 'DRY_RUN_OK',
    errorCode: null,
    ...NOTHING_ATTEMPTED,
  });

  return Object.freeze({
    attemptId,
    manifestId: envelope.manifestId,
    mode: 'DRY_RUN',
    transport: envelope.transport,
    recipient: envelope.recipient,
    approvedTextSha256: envelope.approvedTextSha256,
    transportPayloadSha256: envelope.transportPayloadSha256,
    liveReady: readiness.ready,
    missingForLive: readiness.missing,
    networkAttempted: false,
    sent: false,
    status: 'DRY_RUN_OK',
    preview,
  });
}
