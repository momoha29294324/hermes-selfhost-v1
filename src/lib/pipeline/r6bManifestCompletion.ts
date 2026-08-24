import { randomUUID } from 'node:crypto';
import type { Sql } from '@/lib/db/sql';
import {
  loadActiveLockedManifestIdsForItem,
  loadDispatchContext,
  loadManifestByIdForUpdate,
  resolveIdentityAudit,
  sha256Hex,
  type DispatchManifest,
  type Transport,
} from '@/lib/pipeline/r6bDispatch';
import {
  getLiveReadiness,
  hashTransportPayload,
  validateEmailSubject,
  type TransportPayload,
} from '@/lib/pipeline/r6bTransportPayload';

/**
 * R6B-C.2A §5/§6/§8 — compléter le payload transport d'un manifeste
 * verrouillé, sans jamais le modifier.
 *
 * Un manifeste LOCKED est une décision humaine figée : on ne lui ajoute pas
 * un objet d'email après coup. Le seul chemin est celui qui existe déjà pour
 * un changement de transport ou de texte (R6B-B) : l'ancien manifeste passe
 * `SUPERSEDED`, un nouveau manifeste `LOCKED` naît avec un nouvel
 * identifiant, et l'historique reste lisible intégralement. La seule
 * différence ici est la raison : `live_transport_payload_completion`.
 *
 * Ce module n'envoie rien et ne peut rien envoyer : il n'importe aucun client
 * réseau, n'écrit que dans `r6b_dispatch_manifests`, et ne touche jamais
 * `outreach_events` — compléter un payload n'est pas un contact.
 */

/** §5 — la raison exacte portée par le manifeste remplacé. Valeur d'audit, jamais reformulée. */
export const TRANSPORT_PAYLOAD_COMPLETION_REASON = 'live_transport_payload_completion';

export type CompletionBlockCode =
  | 'MANIFEST_NOT_FOUND'
  | 'MANIFEST_NOT_LOCKED'
  | 'MANIFEST_NOT_CURRENT'
  | 'BATCH_ITEM_DRIFT'
  | 'TRANSPORT_DRIFT'
  | 'TRANSPORT_NOT_COMPLETABLE'
  | 'RECIPIENT_DRIFT'
  | 'RECIPIENT_EVIDENCE_DRIFT'
  | 'APPROVED_TEXT_SHA_DRIFT'
  | 'APPROVED_TEXT_SHA_MISMATCH'
  | 'IDENTITY_DRIFT'
  | 'IDENTITY_AMBIGUITY'
  | 'TRANSPORT_PAYLOAD_DRIFT'
  | 'TRANSPORT_PAYLOAD_UNCHANGED'
  | 'TRANSPORT_PAYLOAD_SHA_DRIFT'
  | 'SUBJECT_INVALID'
  | 'COMPLETION_NOT_READY'
  | 'CONTEXT_NOT_FOUND';

export class ManifestCompletionError extends Error {
  readonly code: CompletionBlockCode;

  constructor(code: CompletionBlockCode, message: string) {
    super(message);
    this.name = 'ManifestCompletionError';
    this.code = code;
  }
}

/**
 * L'état du manifeste tel qu'il était affiché à l'écran au moment où un opérateur
 * a confirmé. Chaque champ est recomparé côté serveur : c'est la définition
 * même du contrôle TOCTOU — sans cet instantané, « rien n'a changé » ne
 * pourrait être vérifié que contre soi-même.
 *
 * Ce n'est jamais une source de données : aucune de ces valeurs n'est écrite
 * dans le nouveau manifeste. Elles ne servent qu'à comparer, et une
 * divergence bloque.
 */
export interface CompletionExpectedState {
  readonly batchItemId: string;
  readonly transport: Transport;
  readonly recipient: string;
  readonly recipientEvidenceIds: readonly string[];
  readonly approvedTextSha256: string;
  readonly identityReview: string;
  /** Empreinte du payload **avant** complétion — prouve qu'aucune complétion concurrente n'a eu lieu. */
  readonly transportPayloadSha256: string;
}

export interface CompleteEmailSubjectInput {
  readonly manifestId: string;
  readonly expected: CompletionExpectedState;
  /** Saisi par un humain, jamais proposé ni complété par le système. */
  readonly subject: string;
  /**
   * Empreinte du payload complété telle qu'affichée dans l'écran de
   * confirmation. Recalculée ici et exigée identique : ce que un opérateur a
   * validé est exactement ce qui sera figé, pas un payload reconstruit
   * autrement entre l'affichage et l'écriture.
   */
  readonly previewedTransportPayloadSha256: string;
}

export interface CompletionResult {
  /** L'ancien manifeste, relu après supersede — préservé, jamais réécrit sur le fond. */
  readonly superseded: DispatchManifest;
  readonly locked: DispatchManifest;
}

function assert(condition: boolean, code: CompletionBlockCode, message: string): asserts condition {
  if (!condition) throw new ManifestCompletionError(code, message);
}

/** Comparaison d'ensembles d'identifiants, insensible à l'ordre de lecture SQL. */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

/**
 * §6/§8 — fige un objet d'email saisi par un humain, en remplaçant le
 * manifeste plutôt qu'en le modifiant.
 *
 * Le sujet est le seul apport extérieur ; tout le reste du nouveau manifeste
 * est recopié depuis l'ancien, jamais recalculé : même batch, même item, même
 * prospect, même vote d'approbation, même transport, même destinataire, même
 * provenance, mêmes preuves, même identité, même texte, même empreinte de
 * texte. Un futur relecteur peut donc diff-er les deux lignes et ne voir
 * changer que le payload.
 *
 * Fail-closed sur la moindre divergence : mieux vaut refaire un tour d'écran
 * que verrouiller un manifeste bâti sur un état périmé.
 */
export async function completeEmailSubject(sql: Sql, input: CompleteEmailSubjectInput): Promise<CompletionResult> {
  // §6 — la validation du sujet précède tout accès à la base : une saisie
  // invalide ne doit même pas ouvrir de transaction.
  const validated = validateEmailSubject(input.subject);
  assert(validated.ok, 'SUBJECT_INVALID', validated.ok ? '' : validated.reason);

  const payload: TransportPayload = { subject: validated.subject };
  const payloadSha256 = hashTransportPayload(payload);
  assert(
    payloadSha256 === input.previewedTransportPayloadSha256,
    'TRANSPORT_PAYLOAD_SHA_DRIFT',
    `l'empreinte du payload confirmé (${input.previewedTransportPayloadSha256}) ne correspond pas au payload recalculé ` +
      `(${payloadSha256}) — l'écran de confirmation ne montrait pas ce qui serait figé`,
  );

  const newId = randomUUID();

  return sql.transaction(async (tx) => {
    const manifest = await loadManifestByIdForUpdate(tx, input.manifestId);
    assert(manifest !== null, 'MANIFEST_NOT_FOUND', `aucun manifeste ${input.manifestId}`);
    assert(
      manifest.status === 'LOCKED',
      'MANIFEST_NOT_LOCKED',
      `manifeste ${manifest.id} au statut « ${manifest.status} » — seul un manifeste actif se complète`,
    );

    // §8 — il ne doit jamais exister deux manifestes LOCKED pour un même item,
    // même transitoirement. Revérifié plutôt que déduit de l'index partiel.
    const active = await loadActiveLockedManifestIdsForItem(tx, manifest.batchItemId);
    assert(
      active.length === 1 && active[0] === manifest.id,
      'MANIFEST_NOT_CURRENT',
      `manifeste ${manifest.id} n'est pas l'unique manifeste actif de l'item ${manifest.batchItemId} ` +
        `(actifs : ${active.length === 0 ? 'aucun' : active.join(', ')})`,
    );

    assert(
      manifest.batchItemId === input.expected.batchItemId,
      'BATCH_ITEM_DRIFT',
      `le manifeste ${manifest.id} porte l'item ${manifest.batchItemId}, l'écran affichait ${input.expected.batchItemId}`,
    );
    assert(
      manifest.transport === input.expected.transport,
      'TRANSPORT_DRIFT',
      `transport « ${String(manifest.transport)} » en base, « ${input.expected.transport} » à l'écran`,
    );
    assert(
      manifest.transport === 'email',
      'TRANSPORT_NOT_COMPLETABLE',
      `un objet ne complète qu'un manifeste email — transport « ${String(manifest.transport)} »`,
    );
    assert(
      manifest.recipient === input.expected.recipient,
      'RECIPIENT_DRIFT',
      `destinataire « ${manifest.recipient} » en base, « ${input.expected.recipient} » à l'écran`,
    );
    assert(
      sameIds(manifest.recipientEvidenceIds, input.expected.recipientEvidenceIds),
      'RECIPIENT_EVIDENCE_DRIFT',
      `les preuves du destinataire ont changé depuis l'affichage (base : ${manifest.recipientEvidenceIds.join(', ') || 'aucune'})`,
    );
    assert(
      manifest.approvedTextSha256 === input.expected.approvedTextSha256,
      'APPROVED_TEXT_SHA_DRIFT',
      `empreinte du texte approuvé ${manifest.approvedTextSha256} en base, ${input.expected.approvedTextSha256} à l'écran`,
    );

    // Le corps lui-même : recalculé, jamais supposé. Couvre le cas où le
    // texte a été altéré sans que son empreinte stockée bouge.
    const recomputedTextSha = sha256Hex(manifest.approvedText);
    assert(
      recomputedTextSha === manifest.approvedTextSha256,
      'APPROVED_TEXT_SHA_MISMATCH',
      `le texte stocké du manifeste ${manifest.id} ne correspond plus à son empreinte approuvée ` +
        `(attendu ${manifest.approvedTextSha256}, recalculé ${recomputedTextSha})`,
    );

    assert(
      manifest.identityReview === input.expected.identityReview,
      'IDENTITY_DRIFT',
      `identité « ${manifest.identityReview} » en base, « ${input.expected.identityReview} » à l'écran`,
    );
    assert(
      manifest.transportPayloadSha256 === input.expected.transportPayloadSha256,
      'TRANSPORT_PAYLOAD_DRIFT',
      `le payload transport a changé depuis l'affichage (base : ${manifest.transportPayloadSha256})`,
    );
    assert(
      manifest.transportPayloadSha256 !== payloadSha256,
      'TRANSPORT_PAYLOAD_UNCHANGED',
      'le payload complété est identique au payload déjà verrouillé — rien à remplacer',
    );

    // §8 « identity remains acceptable » — la même porte que celle du lock
    // initial (`lockManifestForItem`), puisqu'on est en train de verrouiller
    // un manifeste. Purement local : lecture de la fiche prospect et de
    // `prospect_evidence`, aucune requête réseau, aucun modèle, aucun
    // recalcul commercial (ni score, ni angle, ni message).
    const context = await loadDispatchContext(tx, manifest.batchItemId);
    assert(context !== null, 'CONTEXT_NOT_FOUND', `item ${manifest.batchItemId} introuvable`);
    const identity = resolveIdentityAudit(context.prospect, context.evidence);
    assert(!identity.ambiguous, 'IDENTITY_AMBIGUITY', identity.reasons.join(' ; '));
    assert(
      identity.identityReview === manifest.identityReview,
      'IDENTITY_DRIFT',
      `l'identité du prospect est passée de « ${manifest.identityReview} » (figée au lock) à ` +
        `« ${identity.identityReview} » — un manifeste ne se reverrouille pas sur une identité qui a bougé`,
    );

    // L'UPDATE précède l'INSERT : l'index partiel `..._one_locked_idx` n'est
    // pas différable, donc l'ancienne ligne doit quitter LOCKED avant que la
    // nouvelle y entre. `superseded_by` pointe une ligne qui n'existe pas
    // encore — c'est ce que la FK `deferrable initially deferred` (0019)
    // autorise, vérifiée au commit.
    await tx.query(
      `update r6b_dispatch_manifests
          set status = 'SUPERSEDED', superseded_at = now(), superseded_by = $2, superseded_reason = $3
        where id = $1 and status = 'LOCKED'`,
      [manifest.id, newId, TRANSPORT_PAYLOAD_COMPLETION_REASON],
    );

    await tx.query(
      `insert into r6b_dispatch_manifests
         (id, batch_id, batch_item_id, prospect_id, approval_vote_id, business_name, legal_name,
          channel, transport, recipient, recipient_provenance, recipient_evidence_ids, identity_review,
          approved_text, approved_text_sha256, transport_payload, transport_payload_sha256,
          hook_type, hook_evidence_ids, status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'LOCKED')`,
      [
        newId,
        manifest.batchId,
        manifest.batchItemId,
        manifest.prospectId,
        manifest.approvalVoteId,
        manifest.businessName,
        manifest.legalName,
        manifest.legacyChannel,
        manifest.transport,
        manifest.recipient,
        JSON.stringify(manifest.recipientProvenance),
        JSON.stringify(manifest.recipientEvidenceIds),
        manifest.identityReview,
        manifest.approvedText,
        manifest.approvedTextSha256,
        JSON.stringify(payload),
        payloadSha256,
        manifest.hookType,
        JSON.stringify(manifest.hookEvidenceIds),
      ],
    );

    const superseded = await loadManifestByIdForUpdate(tx, manifest.id);
    const locked = await loadManifestByIdForUpdate(tx, newId);
    if (!superseded || !locked) throw new Error('manifest completion did not return both rows');

    // Dernière garde avant commit : le nouveau manifeste doit être prêt pour
    // un LIVE, sinon la complétion n'a pas fait ce qu'elle prétend faire.
    // Prêt ≠ envoyable : aucun adapter LIVE n'existe (voir `LIVE_ADAPTERS`).
    const readiness = getLiveReadiness(locked);
    if (!readiness.ready) {
      throw new ManifestCompletionError(
        'COMPLETION_NOT_READY',
        `le manifeste complété reste incomplet pour un LIVE (manque : ${readiness.missing.join(', ')})`,
      );
    }

    return { superseded, locked };
  });
}
