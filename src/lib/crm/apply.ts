/**
 * R6B-D2.1 — le SEUL chemin qui écrit chez un fournisseur CRM.
 *
 * Un seul, et c'est le point : le traitement d'une réponse
 * (`r6b:replies:process`) et la reprise d'une projection en attente
 * (`r6b:crm:sync`) passent tous deux par ici. Deux chemins d'écriture
 * finiraient par diverger, et l'un des deux perdrait une garde.
 *
 * ---------------------------------------------------------------------------
 * L'ordre des étapes, et pourquoi il est celui-là
 * ---------------------------------------------------------------------------
 *
 *   étape visée → identité → refus de fusion → note déjà posée ?
 *   → écriture fournisseur → persistance du lien → persistance de la note
 *
 * Tout ce qui peut REFUSER se passe avant la première écriture. C'est la
 * différence entre « on ne fusionne pas deux entreprises » et « on a fusionné
 * puis on s'en est aperçu » : la seconde ne se répare pas chez un tiers.
 *
 * La persistance du lien vient APRÈS l'écriture parce qu'elle a besoin de
 * l'identifiant rendu. La fenêtre entre les deux est le seul point non
 * atomique de la chaîne, et elle est sans conséquence : un lien manquant fait
 * qu'au passage suivant l'identité est RECHERCHÉE (email exact), donc le même
 * contact est retrouvé et mis à jour — jamais dupliqué.
 */

import type { Sql } from '@/lib/db/sql';
import { normalizeCrmEmail, normalizeCrmPhone, type CrmPayload } from '@/lib/crm/payload';
import {
  loadContactLink,
  loadLinkByContactId,
  noteAlreadyRecorded,
  recordNote,
  saveContactLink,
} from '@/lib/crm/store';
import {
  CrmPermanentError,
  type CrmContactLink,
  type CrmNoteRequest,
  type CrmProvider,
  type CrmResolvedContact,
  type CrmStage,
  type CrmTarget,
  type CrmUpsertOutcome,
  type MappableOutreachState,
} from '@/lib/crm/types';

/**
 * Un refus, avec l'état de projection qu'il produit.
 *
 * Porter l'état dans l'erreur évite que l'appelant ait à le déduire d'un
 * message — une déduction qui se trompe un jour et transforme un refus de
 * politique en échec retentable, c'est-à-dire en boucle.
 */
export type CrmRefusalStatus = 'BLOCKED_CONFIG' | 'BLOCKED_POLICY' | 'FAILED_PERMANENT';

export class CrmProjectionRefusal extends Error {
  readonly status: CrmRefusalStatus;
  constructor(status: CrmRefusalStatus, message: string) {
    super(message);
    this.name = 'CrmProjectionRefusal';
    this.status = status;
  }
}

export interface ApplyCrmInput {
  readonly provider: CrmProvider;
  readonly target: CrmTarget;
  readonly payload: CrmPayload;
  /** L'historique à déposer. `null` quand la projection n'en porte pas. */
  readonly note: CrmNoteRequest | null;
  readonly analysisId: string | null;
}

export interface ApplyCrmResult {
  readonly outcome: CrmUpsertOutcome;
  readonly link: CrmContactLink;
  readonly stage: CrmStage;
  readonly noteSkipped: boolean;
}

/**
 * Projette un prospect chez le fournisseur, une fois.
 *
 * Lève `CrmProjectionRefusal` pour tout ce qui ne doit PAS être rejoué tel
 * quel, `CrmPermanentError` pour un refus définitif du fournisseur, et une
 * erreur ordinaire pour ce qui est retentable (réseau, 429, 5xx).
 */
export async function applyCrmProjection(sql: Sql, input: ApplyCrmInput): Promise<ApplyCrmResult> {
  const { provider, target, payload } = input;
  const destinationId = target.destination.id;
  const state = payload.outreachState;

  // 1. L'étape visée. `REVIEW_REQUIRED` n'en a jamais (§6) : une conclusion que
  //    le système n'a pas tranchée ne déplace rien chez un tiers.
  if (state === 'REVIEW_REQUIRED') {
    throw new CrmProjectionRefusal(
      'BLOCKED_POLICY',
      'REVIEW_REQUIRED — aucune évolution d’étape automatique sur une conclusion non tranchée',
    );
  }
  const stage = target.stages[state as MappableOutreachState];
  if (stage === undefined) {
    throw new CrmProjectionRefusal(
      'BLOCKED_CONFIG',
      `l’état ${state} n’a aucune étape cartographiée sur le pipeline confirmé — ` +
        'compléter la correspondance avec « npm run r6b:crm:verify »',
    );
  }

  // 2. L'identité, dans l'ordre : lien persisté, puis email, puis téléphone.
  const email = normalizeCrmEmail(payload.email);
  const phone = normalizeCrmPhone(payload.phone);
  if (email === null && phone === null) {
    throw new CrmProjectionRefusal(
      'FAILED_PERMANENT',
      `prospect ${payload.prospectId} : ni email ni téléphone observés — aucune identité forte à projeter`,
    );
  }

  const existingLink = await loadContactLink(sql, destinationId, payload.prospectId);
  let contact: CrmResolvedContact | null = null;

  if (existingLink !== null) {
    contact = Object.freeze({
      externalContactId: existingLink.externalContactId,
      externalOpportunityId: existingLink.externalOpportunityId,
      matchKind: 'link' as const,
      matchValue: existingLink.matchValue,
    });
  } else {
    const match = await provider.lookup(target.destination.locationId, { email, phone });
    if (match !== null) {
      // 3. Le refus de fusion, AVANT toute écriture. Un contact déjà rattaché à
      //    un autre prospect local n'est pas notre contact : écrire dessus
      //    mêlerait deux entreprises dans un seul dossier.
      const owner = await loadLinkByContactId(sql, destinationId, match.externalContactId);
      if (owner !== null && owner.prospectId !== payload.prospectId) {
        throw new CrmProjectionRefusal(
          'FAILED_PERMANENT',
          `le contact ${match.externalContactId} est déjà rattaché au prospect ${owner.prospectId} — ` +
            'fusion refusée, aucune écriture effectuée',
        );
      }
      contact = Object.freeze({
        externalContactId: match.externalContactId,
        externalOpportunityId: owner?.externalOpportunityId ?? null,
        matchKind: match.matchKind,
        matchValue: match.matchValue,
      });
    }
  }

  // 4. La note déjà déposée ne se repose pas — le fournisseur n'est même pas
  //    appelé pour elle.
  let noteSkipped = false;
  let noteToSend: CrmNoteRequest | null = input.note;
  if (input.note !== null) {
    const already = await noteAlreadyRecorded(sql, destinationId, payload.prospectId, input.note.bodySha256);
    if (already) {
      noteToSend = null;
      noteSkipped = true;
    }
  }

  // 5. L'écriture.
  const outcome = await provider.upsert({
    payload,
    target,
    contact,
    stage,
    note: noteToSend,
    // Une demande d'arrêt se propage jusque chez le fournisseur : sans elle,
    // les automatisations du CRM continueraient d'écrire à quelqu'un qui a
    // demandé qu'on arrête. Expansif par le canal, protecteur par l'effet.
    doNotContact: state === 'SUPPRESSED',
  });

  // 6. Le lien. L'index unique `(destination_id, external_contact_id)` est le
  //    dernier verrou contre une fusion arrivée par une course.
  let link: CrmContactLink;
  try {
    link = await saveContactLink(sql, {
      destinationId,
      prospectId: payload.prospectId,
      externalContactId: outcome.externalContactId,
      externalOpportunityId: outcome.externalOpportunityId,
      matchKind: outcome.matchKind,
      matchValue: outcome.matchValue,
    });
  } catch (error) {
    throw new CrmPermanentError(
      `contact ${outcome.externalContactId} déjà rattaché à un autre prospect — lien refusé ` +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }

  // 7. La note posée est enregistrée pour ne jamais l'être deux fois.
  if (noteToSend !== null) {
    await recordNote(sql, {
      destinationId,
      prospectId: payload.prospectId,
      analysisId: input.analysisId,
      bodySha256: noteToSend.bodySha256,
      externalNoteId: outcome.externalNoteId,
    });
  }

  return Object.freeze({ outcome, link, stage, noteSkipped });
}
