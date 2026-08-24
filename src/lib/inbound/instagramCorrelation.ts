import type { CorrelationStatus } from '@/lib/inbound/correlation';
import type { DirectionBasis } from '@/lib/instagram/inboundThread';

/**
 * IG5.1 §7 — rattacher une réponse Instagram à un prospect, avec prudence.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi ce module est distinct de `correlation.ts` (e-mail)
 * ---------------------------------------------------------------------------
 *
 * Le VOCABULAIRE de décision est partagé — `CorrelationStatus` est importé, pas
 * recopié, parce que c'est lui que tout l'aval lit (`taxonomy.isProcessableCorrelation`,
 * les quatre contraintes de `r6b_inbound_messages`, l'Inbox du CRM). Deux
 * échelles de confiance parallèles auraient produit deux définitions de
 * « corrélé », et l'aval en aurait cru une au hasard.
 *
 * La PREUVE, elle, ne peut pas être partagée : `In-Reply-To`, `References`,
 * une adresse plus-taguée et un objet normalisé n'existent pas sur Instagram.
 * Réutiliser `CorrelationEvidence` aurait demandé de remplir six champs e-mail
 * avec des valeurs vides, c'est-à-dire d'écrire « aucun identifiant RFC observé »
 * là où la vérité est « ce canal n'a pas d'identifiant RFC ». Une preuve
 * spécifique au canal est la seule qui ne mente pas.
 *
 * ---------------------------------------------------------------------------
 * L'échelle, et où elle s'arrête
 * ---------------------------------------------------------------------------
 *
 *   EXACT             le fil est LIÉ à un manifeste, par une preuve observée
 *                     (une bulle sortante portant le texte approuvé, mot pour
 *                     mot). C'est l'équivalent Instagram d'un `In-Reply-To` :
 *                     un identifiant fort qui désigne UN envoi.
 *
 *   HIGH_CONFIDENCE   aucun lien de fil, mais le handle de l'expéditeur est
 *                     celui d'exactement UN envoi Instagram antérieur. Plafonné
 *                     ici, jamais promu — exactement comme
 *                     `sole_outbound_recipient` l'est côté e-mail. Un handle
 *                     est un identifiant exact, mais « nous lui avons écrit »
 *                     ne prouve pas « ceci répond à ce message-là ».
 *
 *   REVIEW_REQUIRED   plusieurs candidats, ou deux preuves qui se contredisent.
 *                     Aucune n'est choisie : l'ambiguïté se tranche à la main.
 *
 *   UNMATCHED         personne. Un message Instagram sans lien avec un envoi
 *                     n'est pas une réponse commerciale, et ne doit polluer ni
 *                     le prospect ni le CRM (§7). Il reste visible dans l'Inbox
 *                     avec son statut, ce qui est autre chose que d'être
 *                     rattaché à quelqu'un.
 *
 * Ce que l'échelle ne contient PAS, délibérément : le nom d'affichage. « Car
 * Wash Atelier » n'est pas `atelieratelier_`, et deux entreprises peuvent
 * porter le même nom. Aucun chemin ci-dessous ne lit un nom d'affichage.
 */

export type InstagramCorrelationMethod =
  /** EXACT — le fil porte une bulle sortante au texte approuvé d'un manifeste. */
  | 'instagram_thread_binding'
  /** HIGH_CONFIDENCE — un seul envoi Instagram antérieur vers ce handle. */
  | 'instagram_sole_outbound_handle'
  /** REVIEW_REQUIRED — plusieurs envois antérieurs vers ce handle. */
  | 'instagram_ambiguous_outbound_candidates'
  /** REVIEW_REQUIRED — le fil est lié à plusieurs manifestes. */
  | 'instagram_conflicting_thread_bindings'
  /** REVIEW_REQUIRED — le lien du fil et le handle de l'expéditeur se contredisent. */
  | 'instagram_binding_handle_mismatch';

/** Un envoi Instagram réellement parti, tel qu'`outreach_events` l'atteste. */
export interface InstagramOutboundSend {
  readonly manifestId: string;
  readonly outreachEventId: string;
  readonly prospectId: string;
  /** Destinataire du manifeste — un handle, en minuscules. */
  readonly recipientHandle: string;
  readonly sentAt: Date;
}

/** Un fil rattaché à un manifeste par une preuve observée (`ig_inbound_thread_bindings`). */
export interface InstagramThreadBinding {
  readonly threadId: string;
  readonly manifestId: string;
  readonly outreachEventId: string;
  readonly prospectId: string;
  readonly counterpartyHandle: string;
}

/** Ce qu'on sait du message à corréler. Aucune interprétation. */
export interface InstagramInboundFacts {
  readonly accountHandle: string;
  readonly threadId: string;
  /**
   * Le handle de l'expéditeur, lu dans le FIL. Non nullable : un message dont
   * l'expéditeur n'est pas nommé n'est jamais ingéré (contrainte
   * `ig_inbound_msg_obs_ingest_has_sender`, 0042), donc n'arrive jamais ici.
   */
  readonly senderHandle: string;
  readonly observedAt: Date;
  readonly occurrenceIndex: number;
  readonly directionBasis: DirectionBasis;
  /** Comment `received_at` a été établi. Voir `InstagramCorrelationEvidence`. */
  readonly receivedAtBasis: ReceivedAtBasis;
  readonly rowAgeMs: number | null;
  /**
   * IG5 R3 — l'identifiant natif du message, quand la source en donne un.
   * Conservé dans la PREUVE, jamais dans la clé : `provider_message_id` porte
   * un condensé, et 0042 interdit de prétendre le contraire.
   */
  readonly providerMessageId?: string | null;
}

/**
 * D'où vient la date d'arrivée d'un message.
 *
 * Trois valeurs, par force de preuve décroissante :
 *
 *   `provider_timestamp`      IG5 R3 — l'horodatage qu'Instagram porte sur le
 *                             message lui-même, à la milliseconde. C'est une
 *                             MESURE.
 *   `inbox_row_relative_age`  l'âge affiché par la ligne d'inbox (« 2 h »),
 *                             arrondi et relatif. C'est une ESTIMATION.
 *   `observed_at`             l'instant où nous avons regardé, faute de mieux.
 *                             Ce n'est pas la date du message.
 *
 * La distinction est écrite dans la preuve pour la même raison qu'en IG5.1 :
 * inscrire une valeur sans dire laquelle des trois l'a produite ferait passer
 * une estimation pour une mesure.
 */
export type ReceivedAtBasis = 'provider_timestamp' | 'inbox_row_relative_age' | 'observed_at';

export interface InstagramCorrelationEvidence {
  readonly channel: 'instagram';
  readonly threadId: string;
  readonly senderHandle: string;
  readonly accountHandle: string;
  /** Liens de fil trouvés pour ce fil, par manifeste. */
  readonly threadBindings: readonly string[];
  /** Envois Instagram antérieurs vers ce handle, par manifeste. */
  readonly handleCandidates: readonly string[];
  /** Envois Instagram antérieurs, tous destinataires confondus. Contexte d'une ambiguïté. */
  readonly priorSendCount: number;
  /**
   * La provenance de la ligne, conservée avec la preuve parce qu'elle en fait
   * partie : sur quoi la direction a été tranchée, quel rang d'occurrence a
   * produit l'empreinte, et comment `received_at` a été obtenu.
   *
   * Ce dernier point compte : Instagram web n'affiche qu'un âge RELATIF
   * (« 2 h »), arrondi. `received_at` est donc soit dérivé de cet âge
   * (`inbox_row_relative_age`), soit l'instant de l'observation
   * (`observed_at`) quand l'âge était illisible. Écrire la valeur sans dire
   * laquelle des deux ferait passer une estimation pour une mesure.
   */
  readonly observation: {
    readonly directionBasis: DirectionBasis;
    readonly occurrenceIndex: number;
    readonly receivedAtBasis: ReceivedAtBasis;
    readonly rowAgeMs: number | null;
    /** L'identifiant natif du message, quand la source en donne un. */
    readonly providerMessageId: string | null;
  };
  readonly notes: readonly string[];
}

export interface InstagramCorrelationResult {
  readonly status: CorrelationStatus;
  readonly method: InstagramCorrelationMethod | null;
  readonly manifestId: string | null;
  readonly outreachEventId: string | null;
  readonly prospectId: string | null;
  readonly evidence: InstagramCorrelationEvidence;
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Corrèle une réponse Instagram.
 *
 * @param facts    le message, tel qu'il a été observé
 * @param sends    les envois Instagram réellement partis (`outreach_events`,
 *                 `kind = 'sent'`, manifestes `transport = 'instagram_dm'`)
 * @param bindings les liens de fil déjà établis pour CE fil
 */
export function correlateInstagramInbound(
  facts: InstagramInboundFacts,
  sends: readonly InstagramOutboundSend[],
  bindings: readonly InstagramThreadBinding[],
): InstagramCorrelationResult {
  const notes: string[] = [];
  const sender = facts.senderHandle.toLowerCase();

  const threadBindings = bindings.filter((binding) => binding.threadId === facts.threadId);
  const priorSends = sends.filter((send) => send.sentAt.getTime() <= facts.observedAt.getTime());
  const handleCandidates = priorSends.filter((send) => send.recipientHandle.toLowerCase() === sender);

  const evidence = (extra: readonly string[]): InstagramCorrelationEvidence =>
    Object.freeze({
      channel: 'instagram' as const,
      threadId: facts.threadId,
      senderHandle: sender,
      accountHandle: facts.accountHandle.toLowerCase(),
      threadBindings: Object.freeze(distinct(threadBindings.map((binding) => binding.manifestId))),
      handleCandidates: Object.freeze(distinct(handleCandidates.map((send) => send.manifestId))),
      priorSendCount: priorSends.length,
      observation: Object.freeze({
        directionBasis: facts.directionBasis,
        occurrenceIndex: facts.occurrenceIndex,
        receivedAtBasis: facts.receivedAtBasis,
        rowAgeMs: facts.rowAgeMs,
        providerMessageId: facts.providerMessageId ?? null,
      }),
      notes: Object.freeze([...notes, ...extra]),
    });

  // ---- 1. Le lien de fil : l'identifiant fort ------------------------------
  const boundManifests = distinct(threadBindings.map((binding) => binding.manifestId));
  if (boundManifests.length > 1) {
    return Object.freeze({
      status: 'REVIEW_REQUIRED' as CorrelationStatus,
      method: 'instagram_conflicting_thread_bindings' as const,
      manifestId: null,
      outreachEventId: null,
      prospectId: null,
      evidence: evidence([
        `${boundManifests.length} manifestes sont liés à ce fil — aucun n’est retenu, l’ambiguïté se tranche à la main`,
      ]),
    });
  }

  const binding = threadBindings[0];
  if (binding !== undefined) {
    // Le lien désigne une contrepartie ; si le fil nomme quelqu'un d'autre,
    // c'est que l'un des deux a changé. On ne choisit pas lequel.
    if (binding.counterpartyHandle.toLowerCase() !== sender) {
      return Object.freeze({
        status: 'REVIEW_REQUIRED' as CorrelationStatus,
        method: 'instagram_binding_handle_mismatch' as const,
        manifestId: null,
        outreachEventId: null,
        prospectId: null,
        evidence: evidence([
          `le fil est lié à @${binding.counterpartyHandle} mais ce message vient de @${sender}`,
        ]),
      });
    }
    return Object.freeze({
      status: 'EXACT' as CorrelationStatus,
      method: 'instagram_thread_binding' as const,
      manifestId: binding.manifestId,
      outreachEventId: binding.outreachEventId,
      prospectId: binding.prospectId,
      evidence: evidence([
        'le fil porte une bulle sortante au texte approuvé de ce manifeste — identifiant fort',
      ]),
    });
  }

  notes.push('aucun lien de fil observé pour cette conversation');

  // ---- 2. Le handle : un seul envoi antérieur ------------------------------
  const candidateManifests = distinct(handleCandidates.map((send) => send.manifestId));
  if (candidateManifests.length > 1) {
    return Object.freeze({
      status: 'REVIEW_REQUIRED' as CorrelationStatus,
      method: 'instagram_ambiguous_outbound_candidates' as const,
      manifestId: null,
      outreachEventId: null,
      prospectId: null,
      evidence: evidence([`${candidateManifests.length} envois Instagram antérieurs vers @${sender}`]),
    });
  }

  const send = handleCandidates[0];
  if (send !== undefined) {
    return Object.freeze({
      status: 'HIGH_CONFIDENCE' as CorrelationStatus,
      method: 'instagram_sole_outbound_handle' as const,
      manifestId: send.manifestId,
      outreachEventId: send.outreachEventId,
      prospectId: send.prospectId,
      evidence: evidence([
        `un seul envoi Instagram antérieur vers @${sender} — plafonné à HIGH_CONFIDENCE, ` +
          'le fil ne porte aucune preuve du message envoyé',
      ]),
    });
  }

  // ---- 3. Personne ---------------------------------------------------------
  //
  // `UNMATCHED` porte `method: null` — c'est la contrainte
  // `r6b_inbound_unmatched_has_no_method` (0025), et c'est juste : il n'y a pas
  // de méthode quand il n'y a pas de rattachement. Le motif vit dans la preuve.
  return Object.freeze({
    status: 'UNMATCHED' as CorrelationStatus,
    method: null,
    manifestId: null,
    outreachEventId: null,
    prospectId: null,
    evidence: evidence([
      `aucun envoi Instagram vers @${sender} (${priorSends.length} envoi(s) Instagram antérieur(s) au total) — ` +
        'ce message n’est pas une réponse commerciale et n’est rattaché à personne',
    ]),
  });
}
