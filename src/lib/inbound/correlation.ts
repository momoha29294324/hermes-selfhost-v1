/**
 * R6B-D1 — à quel envoi une réponse répond, et avec quelle certitude.
 *
 * Pur : aucune base, aucun réseau. La fonction reçoit le message normalisé, la
 * liste des envois connus et la résolution des jetons déjà faite en base ; elle
 * rend un verdict et la preuve de ce verdict. C'est cette séparation qui rend
 * la règle testable sur les cas qui comptent — deux candidats, un jeton
 * révoqué, deux identifiants forts qui se contredisent — sans avoir à
 * fabriquer un état de base pour chacun.
 *
 * ---------------------------------------------------------------------------
 * La règle qui commande toutes les autres
 * ---------------------------------------------------------------------------
 *
 * Une heuristique faible ne devient JAMAIS `EXACT`. Deux chemins seulement y
 * mènent, et tous deux sont une égalité d'identifiant :
 *
 *   1. `rfc_in_reply_to` — un `In-Reply-To`/`References` de la réponse porte le
 *      `Message-ID` RFC 5322 d'un envoi connu. C'est le lien que la norme
 *      prévoit pour dire « ceci répond à cela » ; il est produit par le client
 *      mail du prospect à partir de notre propre message.
 *   2. `reply_token` — l'adresse de destination porte un jeton opaque qui se
 *      RÉSOUT en base. Rien n'y est décodé : un jeton inventé ne désigne rien.
 *
 * Tout le reste — expéditeur, objet, proximité temporelle — est au mieux une
 * corroboration. Un expéditeur et un objet identiques ne sont pas une identité
 * d'envoi : deux prospects du même lot reçoivent des objets bâtis sur le même
 * modèle, et une adresse peut écrire pour une raison sans rapport.
 */

import type { NormalizedInboundMessage } from '@/lib/inbound/parse';
import { parsePlusAddress } from '@/lib/inbound/parse';

export type CorrelationStatus = 'EXACT' | 'HIGH_CONFIDENCE' | 'REVIEW_REQUIRED' | 'UNMATCHED';

export type CorrelationMethod =
  /** EXACT — `In-Reply-To`/`References` porte le Message-ID RFC d'un envoi connu. */
  | 'rfc_in_reply_to'
  /** EXACT — adresse plus-taguée dont le jeton se résout en base. */
  | 'reply_token'
  /** HIGH_CONFIDENCE — un seul envoi possible vers cet expéditeur, avec preuve de réponse compatible. */
  | 'sole_outbound_recipient'
  /** REVIEW_REQUIRED — plusieurs envois possibles vers cet expéditeur. */
  | 'ambiguous_outbound_candidates'
  /** REVIEW_REQUIRED — expéditeur connu, mais rien n'indique une réponse. */
  | 'recipient_without_reply_evidence'
  /** REVIEW_REQUIRED — deux identifiants forts désignent deux envois différents. */
  | 'conflicting_strong_identifiers';

/**
 * Un envoi réellement parti, tel que la base le connaît. Construit à partir
 * d'`outreach_events` (kind = 'sent') : la seule table du dépôt qui affirme
 * qu'un humain a été contacté.
 */
export interface OutboundSend {
  readonly manifestId: string;
  readonly outreachEventId: string;
  readonly prospectId: string;
  /** Destinataire du manifeste, en minuscules. */
  readonly recipient: string;
  readonly sentAt: Date;
  /** `Message-ID` RFC 5322 de l'email envoyé, chevrons compris. `null` = non observé. */
  readonly rfcMessageId: string | null;
  /** Objet approuvé, normalisé comme celui d'un message entrant. */
  readonly normalizedSubject: string;
}

/** Ce qu'un jeton de réponse désigne, tel que `r6b_reply_tokens` le porte. */
export interface ReplyTokenBinding {
  readonly token: string;
  readonly manifestId: string;
  readonly revoked: boolean;
}

export interface CorrelationEvidence {
  /** Identifiants RFC de la réponse confrontés aux envois connus. */
  readonly examinedMessageIds: readonly string[];
  /** Jetons lus dans les adresses de destination, quel que soit leur sort. */
  readonly observedTokens: readonly string[];
  /** Jetons écartés, avec le motif. Un jeton refusé est un fait, pas un silence. */
  readonly rejectedTokens: readonly string[];
  /** Envois dont le destinataire est l'expéditeur de ce message, antérieurs à sa réception. */
  readonly recipientCandidates: readonly string[];
  /** Nombre total d'envois antérieurs à la réception — le contexte d'une ambiguïté. */
  readonly priorSendCount: number;
  /** L'objet normalisé coïncide avec celui de l'envoi retenu. Corroboration, jamais preuve. */
  readonly subjectMatches: boolean;
  /** La réponse porte des en-têtes de réponse (`In-Reply-To`/`References`). */
  readonly hasReplyHeaders: boolean;
  readonly notes: readonly string[];
}

export interface CorrelationResult {
  readonly status: CorrelationStatus;
  readonly method: CorrelationMethod | null;
  readonly manifestId: string | null;
  readonly outreachEventId: string | null;
  readonly prospectId: string | null;
  readonly evidence: CorrelationEvidence;
}

function conclude(send: OutboundSend | null, base: Omit<CorrelationResult, 'manifestId' | 'outreachEventId' | 'prospectId'>): CorrelationResult {
  return Object.freeze({
    ...base,
    manifestId: send?.manifestId ?? null,
    outreachEventId: send?.outreachEventId ?? null,
    prospectId: send?.prospectId ?? null,
  });
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/**
 * Corrèle une réponse.
 *
 * @param message  la réponse, déjà normalisée
 * @param sends    les envois email réellement partis (`outreach_events`)
 * @param tokens   la résolution en base des jetons lus dans les adresses de
 *                 destination. Un jeton absent de cette table est un jeton
 *                 inconnu — jamais « probablement valide ».
 */
export function correlateInbound(
  message: NormalizedInboundMessage,
  sends: readonly OutboundSend[],
  tokens: ReadonlyMap<string, ReplyTokenBinding>,
): CorrelationResult {
  const notes: string[] = [];

  // -------------------------------------------------------------------------
  // Chemin fort n°1 — identifiant RFC de réponse
  // -------------------------------------------------------------------------
  const examinedMessageIds = unique([...message.inReplyTo, ...message.referenceIds]);
  const byRfc = sends.filter(
    (send) => send.rfcMessageId !== null && examinedMessageIds.includes(send.rfcMessageId),
  );
  const rfcManifests = unique(byRfc.map((send) => send.manifestId));

  // -------------------------------------------------------------------------
  // Chemin fort n°2 — jeton d'adresse plus-taguée
  // -------------------------------------------------------------------------
  //
  // `To` ET `Delivered-To` : un relais peut réécrire le premier en perdant le
  // tag, tandis que le second garde l'adresse de livraison réelle. Les deux
  // sont lus, et il suffit que l'un porte un jeton résoluble.
  const observedTokens: string[] = [];
  const rejectedTokens: string[] = [];
  const tokenSends: OutboundSend[] = [];

  for (const address of unique([...message.toAddresses, ...message.deliveredToAddresses])) {
    const parsed = parsePlusAddress(address);
    if (!parsed.ok) {
      // `not_plus_addressed` est le cas normal (l'adresse de base) : ce n'est
      // pas un rejet, c'est l'absence de jeton.
      if (parsed.code !== 'not_plus_addressed') rejectedTokens.push(`${address}:${parsed.code}`);
      continue;
    }
    observedTokens.push(parsed.token);

    const binding = tokens.get(parsed.token);
    if (!binding) {
      rejectedTokens.push(`${parsed.token}:unknown`);
      continue;
    }
    if (binding.revoked) {
      rejectedTokens.push(`${parsed.token}:revoked`);
      continue;
    }
    const send = sends.find((candidate) => candidate.manifestId === binding.manifestId);
    if (!send) {
      // Un jeton qui désigne un manifeste dont aucun envoi n'est parti ne peut
      // pas corréler une réponse : il n'y a rien à quoi répondre.
      rejectedTokens.push(`${parsed.token}:no_send_for_manifest`);
      continue;
    }
    tokenSends.push(send);
  }
  const tokenManifests = unique(tokenSends.map((send) => send.manifestId));

  // -------------------------------------------------------------------------
  // Contexte du repli faible, calculé une fois
  // -------------------------------------------------------------------------
  const priorSends = sends.filter((send) => send.sentAt.getTime() < message.receivedAt.getTime());
  const recipientCandidates = priorSends.filter((send) => send.recipient === message.fromAddress);
  const hasReplyHeaders = examinedMessageIds.length > 0;

  const evidenceBase = {
    examinedMessageIds: Object.freeze(examinedMessageIds),
    observedTokens: Object.freeze(unique(observedTokens)),
    rejectedTokens: Object.freeze(unique(rejectedTokens)),
    recipientCandidates: Object.freeze(recipientCandidates.map((send) => send.manifestId)),
    priorSendCount: priorSends.length,
    hasReplyHeaders,
  };

  const evidence = (subjectMatches: boolean): CorrelationEvidence =>
    Object.freeze({ ...evidenceBase, subjectMatches, notes: Object.freeze([...notes]) });

  // -------------------------------------------------------------------------
  // Arbitrage entre les deux chemins forts
  // -------------------------------------------------------------------------
  //
  // Quand les deux concluent, ils doivent conclure la même chose. S'ils
  // divergent, le système ne choisit pas le « plus fort des deux » : il n'y a
  // pas de raison de croire l'un plutôt que l'autre, et se tromper ici
  // rattacherait la réponse d'un prospect au dossier d'un autre.
  if (rfcManifests.length === 1 && tokenManifests.length === 1 && rfcManifests[0] !== tokenManifests[0]) {
    notes.push(
      `identifiant RFC (${rfcManifests[0]}) et jeton de réponse (${tokenManifests[0]}) désignent deux envois différents`,
    );
    return conclude(null, {
      status: 'REVIEW_REQUIRED',
      method: 'conflicting_strong_identifiers',
      evidence: evidence(false),
    });
  }

  if (rfcManifests.length > 1) {
    notes.push(`${rfcManifests.length} envois portent un Message-ID cité par cette réponse`);
    return conclude(null, {
      status: 'REVIEW_REQUIRED',
      method: 'rfc_in_reply_to',
      evidence: evidence(false),
    });
  }
  if (rfcManifests.length === 1) {
    const send = byRfc[0]!;
    notes.push(`In-Reply-To/References porte le Message-ID de l'envoi ${send.manifestId}`);
    return conclude(send, {
      status: 'EXACT',
      method: 'rfc_in_reply_to',
      evidence: evidence(send.normalizedSubject === message.normalizedSubject),
    });
  }

  if (tokenManifests.length > 1) {
    notes.push(`${tokenManifests.length} jetons de réponse valides désignent des envois différents`);
    return conclude(null, {
      status: 'REVIEW_REQUIRED',
      method: 'reply_token',
      evidence: evidence(false),
    });
  }
  if (tokenManifests.length === 1) {
    const send = tokenSends[0]!;
    notes.push(`jeton de réponse résolu en base vers l'envoi ${send.manifestId}`);
    return conclude(send, {
      status: 'EXACT',
      method: 'reply_token',
      evidence: evidence(send.normalizedSubject === message.normalizedSubject),
    });
  }

  // -------------------------------------------------------------------------
  // Repli du premier envoi réel (§7 de la mission)
  // -------------------------------------------------------------------------
  //
  // Le premier email de Hermes est parti avant que les alias `Reply-To`
  // per-manifeste existent, et Resend n'a pas été relu pour connaître son
  // `Message-ID` RFC. Aucun chemin fort ne peut donc s'appliquer à SA réponse.
  //
  // Ce repli est ce qui reste, et il est explicitement plafonné à
  // `HIGH_CONFIDENCE` : ce n'est pas une identité d'envoi, c'est l'absence
  // d'alternative. Il s'éteint de lui-même dès qu'une alternative apparaît —
  // deux envois vers la même adresse rendent `REVIEW_REQUIRED`, sans réglage à
  // changer.
  if (recipientCandidates.length === 0) {
    if (priorSends.length === 0) notes.push('aucun envoi antérieur à ce message');
    else notes.push(`aucun des ${priorSends.length} envoi(s) antérieur(s) ne vise ${message.fromAddress}`);
    return conclude(null, { status: 'UNMATCHED', method: null, evidence: evidence(false) });
  }

  if (recipientCandidates.length > 1) {
    notes.push(
      `${recipientCandidates.length} envois antérieurs visent ${message.fromAddress} — ` +
        'expéditeur et objet ne suffisent pas à choisir, et deviner rattacherait une réponse au mauvais dossier',
    );
    return conclude(null, {
      status: 'REVIEW_REQUIRED',
      method: 'ambiguous_outbound_candidates',
      evidence: evidence(false),
    });
  }

  const candidate = recipientCandidates[0]!;
  const subjectMatches =
    message.normalizedSubject.length > 0 && message.normalizedSubject === candidate.normalizedSubject;

  // « Preuve de réponse compatible » : l'objet est celui de l'envoi, ou le
  // message porte des en-têtes de réponse. À ce stade, aucun de ces en-têtes ne
  // désigne un envoi connu (le chemin fort aurait conclu) — mais leur présence
  // dit tout de même que ce message répond à quelque chose, ce qu'un premier
  // contact spontané ne ferait pas.
  if (!subjectMatches && !hasReplyHeaders) {
    notes.push(
      `${message.fromAddress} a bien reçu l'envoi ${candidate.manifestId}, mais ce message ne porte ` +
        'ni objet correspondant ni en-tête de réponse — un humain doit dire si c\'en est une',
    );
    return conclude(null, {
      status: 'REVIEW_REQUIRED',
      method: 'recipient_without_reply_evidence',
      evidence: evidence(false),
    });
  }

  notes.push(
    `un seul envoi antérieur vise ${message.fromAddress} (${candidate.manifestId}) et ce message en porte ` +
      (subjectMatches ? 'l’objet' : 'les en-têtes de réponse') +
      ' — corrélation plafonnée à HIGH_CONFIDENCE : aucun identifiant fort ne la prouve',
  );
  return conclude(candidate, {
    status: 'HIGH_CONFIDENCE',
    method: 'sole_outbound_recipient',
    evidence: evidence(subjectMatches),
  });
}
