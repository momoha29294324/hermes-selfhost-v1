/**
 * R6B-D2.1 — le contrat entre ce dépôt et un CRM.
 *
 * Un seul fichier de types, sans base ni réseau, pour que la frontière soit
 * lisible d'un coup d'œil : ce qu'un fournisseur reçoit, ce qu'il rend, et ce
 * qu'il ne peut pas faire.
 *
 * ---------------------------------------------------------------------------
 * Ce qu'un `CrmProvider` NE PEUT PAS faire
 * ---------------------------------------------------------------------------
 *
 * L'interface n'a aucune méthode d'envoi, et ce n'est pas un oubli à combler :
 * les CRM modernes exposent tous une API de messagerie (GoHighLevel a
 * `/conversations/messages`), et une interface qui porterait « envoyer » finirait
 * par être appelée. Le contrat se limite donc à trois verbes — vérifier, lire,
 * projeter — et `tests/r6bCrm.test.ts` relit le code source de l'adapter pour
 * vérifier qu'aucun chemin de messagerie n'y est atteignable.
 */

import type { CrmPayload } from '@/lib/crm/payload';
import type { OutreachState } from '@/lib/replies/taxonomy';

// ---------------------------------------------------------------------------
// La destination
// ---------------------------------------------------------------------------

export type CrmDestinationStatus = 'UNCONFIRMED' | 'CONFIRMED' | 'REVOKED';

/** Un champ personnalisé du sous-compte, tel qu'il a été OBSERVÉ. */
export interface CrmFieldBinding {
  readonly id: string;
  readonly key: string;
}

/** Les champs de la charge utile qu'un champ personnalisé peut porter. */
export type CrmMappableField =
  | 'prospectId'
  | 'manifestId'
  | 'prospectScore'
  | 'prospectScoreBand'
  | 'researchSummary'
  | 'replyClassification'
  | 'replyReceivedAt'
  | 'instagram';

export const CRM_MAPPABLE_FIELDS: readonly CrmMappableField[] = [
  'prospectId',
  'manifestId',
  'prospectScore',
  'prospectScoreBand',
  'researchSummary',
  'replyClassification',
  'replyReceivedAt',
  'instagram',
];

export type CrmFieldMap = Readonly<Partial<Record<CrmMappableField, CrmFieldBinding>>>;

export interface CrmDestination {
  readonly id: string;
  readonly provider: string;
  readonly locationId: string;
  readonly locationName: string | null;
  readonly pipelineId: string | null;
  readonly pipelineName: string | null;
  readonly fieldMap: CrmFieldMap;
  readonly status: CrmDestinationStatus;
  readonly confirmedBy: string | null;
  readonly confirmedAt: string | null;
}

export interface CrmStage {
  readonly stageId: string;
  readonly stageName: string;
  readonly position: number | null;
}

/**
 * Correspondance état → étape, telle qu'elle est PERSISTÉE.
 *
 * `REVIEW_REQUIRED` n'y figure jamais : `r6b_crm_stage_map` refuse cet état, et
 * le type le dit aussi pour que l'oubli soit une erreur de compilation.
 */
export type MappableOutreachState = Exclude<OutreachState, 'REVIEW_REQUIRED'>;

export type CrmStageMap = Readonly<Partial<Record<MappableOutreachState, CrmStage>>>;

/** Une destination confirmée, avec tout ce qu'il faut pour écrire. */
export interface CrmTarget {
  readonly destination: CrmDestination;
  readonly pipelineId: string;
  readonly stages: CrmStageMap;
}

// ---------------------------------------------------------------------------
// L'identité d'un contact
// ---------------------------------------------------------------------------

/**
 * COMMENT un contact a été rattaché à un prospect local.
 *
 * Liste fermée, et aucun de ses membres n'est un nom : une entreprise ne se
 * reconnaît pas à sa raison sociale (« Demo Papa » existe cent fois), et deux
 * dossiers fusionnés par ressemblance ne se séparent plus.
 */
export type CrmMatchKind = 'link' | 'provider_contact_id' | 'email' | 'phone' | 'created';

export interface CrmContactLink {
  readonly destinationId: string;
  readonly prospectId: string;
  readonly externalContactId: string;
  readonly externalOpportunityId: string | null;
  readonly matchKind: CrmMatchKind;
  readonly matchValue: string | null;
}

/** Ce qu'une recherche d'identité forte a trouvé chez le fournisseur. */
export interface CrmIdentityMatch {
  readonly externalContactId: string;
  readonly matchKind: Extract<CrmMatchKind, 'email' | 'phone' | 'provider_contact_id'>;
  readonly matchValue: string | null;
}

/**
 * Le contact que le fournisseur doit METTRE À JOUR, déjà tranché.
 *
 * Résolu par l'orchestrateur, jamais par l'adapter — c'est ce qui permet de
 * refuser une fusion AVANT la première écriture. Un adapter qui chercherait
 * lui-même son contact aurait déjà écrit quand le refus arriverait.
 */
export interface CrmResolvedContact {
  readonly externalContactId: string;
  readonly externalOpportunityId: string | null;
  readonly matchKind: CrmMatchKind;
  readonly matchValue: string | null;
}

// ---------------------------------------------------------------------------
// Ce qu'un fournisseur reçoit et rend
// ---------------------------------------------------------------------------

/** Une note à déposer sur le contact — §9, l'historique auditable. */
export interface CrmNoteRequest {
  readonly body: string;
  readonly bodySha256: string;
}

export interface CrmUpsertRequest {
  readonly payload: CrmPayload;
  readonly target: CrmTarget;
  /**
   * Le contact à mettre à jour, ou `null` pour en créer un.
   *
   * Tranché en amont : l'adapter ne cherche pas, il applique. C'est ce qui fait
   * d'une reprojection une mise à jour et non un second contact.
   */
  readonly contact: CrmResolvedContact | null;
  /** L'étape visée chez le fournisseur, ou `null` quand aucune ne l'est. */
  readonly stage: CrmStage | null;
  /** `null` quand la note a déjà été déposée (empreinte connue) — on ne la repose pas. */
  readonly note: CrmNoteRequest | null;
  /**
   * Le prospect doit-il être marqué « ne pas contacter » chez le fournisseur ?
   *
   * Vrai sur `SUPPRESSED` uniquement. C'est une écriture EXPANSIVE au sens de
   * la mission (elle touche un tiers) mais d'effet PROTECTEUR : elle empêche
   * les automatisations du CRM d'écrire à quelqu'un qui a demandé l'arrêt.
   * Elle ne relâche donc aucune garde — elle passe par les mêmes.
   */
  readonly doNotContact: boolean;
}

export interface CrmUpsertOutcome {
  readonly externalContactId: string;
  readonly externalOpportunityId: string | null;
  readonly externalStage: string | null;
  readonly matchKind: CrmMatchKind;
  readonly matchValue: string | null;
  readonly contactCreated: boolean;
  readonly opportunityCreated: boolean;
  readonly externalNoteId: string | null;
  readonly noteCreated: boolean;
}

/** Le résultat d'une vérification de connectivité en LECTURE SEULE. */
export interface CrmProbe {
  readonly locationId: string;
  readonly locationName: string | null;
  readonly pipelines: readonly CrmPipelineProbe[];
  readonly customFields: readonly CrmCustomFieldProbe[];
}

export interface CrmPipelineProbe {
  readonly pipelineId: string;
  readonly pipelineName: string;
  readonly stages: readonly CrmStage[];
}

export interface CrmCustomFieldProbe {
  readonly id: string;
  readonly key: string;
  readonly name: string;
}

/**
 * Un refus DÉFINITIF du fournisseur.
 *
 * Séparé d'une erreur ordinaire parce que la conséquence n'est pas la même :
 * une panne réseau se rejoue, une authentification refusée ou un sous-compte
 * inconnu ne se rejouent pas. Sans cette distinction, `r6b:crm:sync`
 * retenterait éternellement une erreur définitive.
 */
export class CrmPermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrmPermanentError';
  }
}

/**
 * Ce qu'un fournisseur CRM doit savoir faire. Trois verbes, aucun n'envoie.
 */
export interface CrmProvider {
  readonly name: string;
  /** Configuration locale utilisable ? Ne touche pas le réseau. */
  availability(): { readonly ok: boolean; readonly reason?: string };
  /** L'opération de lecture la plus étroite qui prouve l'accès au sous-compte. */
  probe(locationId: string): Promise<CrmProbe>;
  /**
   * Cherche un contact par identité FORTE, sans rien écrire.
   *
   * Séparé d'`upsert` pour que l'orchestrateur puisse refuser une fusion avant
   * que le premier octet ne parte.
   */
  lookup(
    locationId: string,
    by: { readonly email: string | null; readonly phone: string | null },
  ): Promise<CrmIdentityMatch | null>;
  /** Projette un prospect. Idempotent : rejoué, il met à jour. */
  upsert(request: CrmUpsertRequest): Promise<CrmUpsertOutcome>;
}

// ---------------------------------------------------------------------------
// La résolution
// ---------------------------------------------------------------------------

/**
 * Pourquoi aucune écriture n'est possible.
 *
 *   NOT_CONFIGURED — rien n'a été demandé : aucun fournisseur nommé. C'est
 *                    l'état par défaut du dépôt, et ce n'est pas une erreur.
 *   BLOCKED_CONFIG — quelque chose A été demandé, et c'est refusé : sous-compte
 *                    non confirmé, `location_id` qui ne correspond pas, clé
 *                    absente, pipeline ou étape manquants.
 */
export type CrmUnconfiguredKind = 'NOT_CONFIGURED' | 'BLOCKED_CONFIG';

export type CrmResolution =
  | {
      readonly configured: true;
      readonly provider: CrmProvider;
      readonly target: CrmTarget;
    }
  | {
      readonly configured: false;
      readonly kind: CrmUnconfiguredKind;
      readonly reason: string;
      /** Noms de variables manquantes. JAMAIS une valeur (CLAUDE.md §6). */
      readonly missing: readonly string[];
    };
