/**
 * R6B-D1 — la frontière d'un fournisseur de boîte entrante (mission « Hermes
 * Outbound R6B-D1 — Gmail Reply Intake & Correlation »).
 *
 * Ce module ne parle à personne : il définit ce qu'un fournisseur doit savoir
 * faire, et rien de plus. La seule implémentation de production
 * (`GmailInboundProvider`) est en lecture seule, et cette interface est ce qui
 * rend « lecture seule » vérifiable plutôt que promis.
 *
 * ---------------------------------------------------------------------------
 * Ce que l'interface ne contient pas, délibérément
 * ---------------------------------------------------------------------------
 *
 * Aucune primitive d'écriture. Pas d'envoi, pas de réponse, pas de brouillon,
 * mais aussi : pas de « marquer comme lu », pas d'archivage, pas de libellé,
 * pas de suppression. Un module qui ne peut pas nommer une opération ne peut
 * pas l'exécuter par accident — c'est la même logique que l'`EmailProvider`
 * sortant, qui n'expose que trois verbes et qu'aucun appelant ne construit
 * lui-même.
 *
 * Conséquence pratique : lire la boîte de un opérateur avec ce module ne change
 * rien à ce qu'il verra dans Gmail. Un message ingéré reste non lu.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi `getHeaders` et `getPlainTextBody` ne sont pas des méthodes
 * ---------------------------------------------------------------------------
 *
 * La mission les cite comme capacités attendues. Elles existent — mais comme
 * fonctions PURES sur un message déjà récupéré (voir plus bas), pas comme
 * appels réseau supplémentaires. Deux raisons :
 *
 *   1. un aller-retour par champ multiplierait les appels sur une API dont le
 *      quota est partagé avec la boîte personnelle de un opérateur ;
 *   2. deux lectures successives peuvent renvoyer des états différents. Un
 *      en-tête et un corps qui ne viennent pas de la MÊME réponse peuvent se
 *      contredire, et une corrélation bâtie sur deux observations
 *      désynchronisées serait fausse sans être détectable.
 *
 * Un message est donc lu une fois, entier, puis interrogé en mémoire.
 */

/** Un en-tête tel que le fournisseur l'expose, sans interprétation. */
export interface InboundHeader {
  readonly name: string;
  readonly value: string;
}

/** D'où vient le texte retenu — voir `extractPlainTextBody`. */
export type InboundBodySource = 'text/plain' | 'text/html' | 'none';

export interface InboundBody {
  readonly text: string;
  readonly source: InboundBodySource;
  /** Vrai si le corps a été coupé à la borne de taille (jamais silencieusement). */
  readonly truncated: boolean;
}

/**
 * Un message entrant, normalisé, tel qu'un fournisseur le rend. Volontairement
 * pauvre : pas de pièces jointes, pas de HTML brut, pas d'en-têtes de routage.
 * Tout ce qui n'est ni une identité ni un corps lisible n'a pas sa place dans
 * une base de prospection.
 */
export interface InboundRawMessage {
  readonly providerMessageId: string;
  readonly providerThreadId: string | null;
  readonly providerHistoryId: string | null;
  /** Millisecondes epoch. `null` si le fournisseur ne l'a pas donné — jamais inventé. */
  readonly internalDateMs: number | null;
  readonly headers: readonly InboundHeader[];
  readonly body: InboundBody;
}

/**
 * Ce qu'un tour de lecture couvre. Borné par construction, jamais « toute la
 * boîte » — et la borne qui compte est `counterparties`, pas une adresse de
 * boîte : lire « à qui on a écrit » plutôt que « quelle boîte on lit » est ce
 * qui empêche une requête de redevenir large par accident (R6B-D1.3).
 */
export interface MailboxScope {
  /** Borne basse. `null` seulement si l'appelant n'a aucun envoi connu. */
  readonly since: Date | null;
  /** Plafond dur du nombre d'identifiants rendus par un tour. */
  readonly maxMessages: number;
  /**
   * Adresses ayant reçu un envoi sortant réel (`outreach_events.kind = 'sent'`),
   * en minuscules. C'est la SEULE frontière qui borne ce qui est demandé à
   * Gmail : une réponse plausible ne peut venir que de l'une d'elles. Vide
   * tant qu'aucun envoi n'existe — et dans ce cas aucune requête n'est
   * envoyée (rien à corréler).
   */
  readonly counterparties: readonly string[];
}

export interface ListNewMessagesRequest {
  readonly scope: MailboxScope;
  /**
   * Marqueur de version de la boîte mémorisé au tour précédent. `null` force
   * une lecture bornée. Il ne sert JAMAIS à borner ce qui est lu — c'est
   * `scope.since` qui le fait — mais seulement à savoir si quoi que ce soit a
   * changé depuis le dernier tour.
   */
  readonly startHistoryId: string | null;
}

export interface MailboxListResult {
  /**
   * `query`             — une requête bornée a été exécutée ;
   * `unchanged`          — le marqueur de version de la boîte est identique au
   *                        marqueur mémorisé : rien n'a changé, aucune lecture
   *                        n'a eu lieu ;
   * `no_counterparties` — aucun envoi sortant connu : rien à corréler, donc
   *                        aucun appel Gmail (ni liste, ni profil) n'a été fait.
   */
  readonly strategy: 'query' | 'unchanged' | 'no_counterparties';
  /** Identifiants candidats, dédupliqués par le fournisseur. */
  readonly messageIds: readonly string[];
  /** Curseur à mémoriser SI le tour se termine sans perte. `null` si inconnu. */
  readonly latestHistoryId: string | null;
  /**
   * Vrai quand le marqueur de version mémorisé s'est révélé inutilisable et a
   * forcé une resynchronisation bornée. Jamais avalé : l'appelant doit le
   * compter et le rapporter, parce qu'un marqueur qu'on ne peut plus comparer
   * est la situation où un système naïf saute silencieusement des messages.
   */
  readonly historyCursorInvalid: boolean;
  /**
   * Vrai si le plafond `maxMessages` a coupé la liste. L'appelant refuse alors
   * d'avancer le curseur — sinon le reste disparaîtrait en silence.
   */
  readonly truncated: boolean;
}

/**
 * Le contrat. Trois lectures, zéro écriture.
 *
 * `canSend: false` est une propriété de type littéral, pas un commentaire :
 * une implémentation qui prétendrait pouvoir envoyer ne compilerait pas.
 */
export interface InboundMailboxProvider {
  readonly name: string;
  readonly capabilities: {
    readonly canSend: false;
    readonly canModifyMailbox: false;
  };
  listNewMessages(request: ListNewMessagesRequest): Promise<MailboxListResult>;
  /** `null` si le message a disparu entre la liste et la lecture (supprimé, déplacé). */
  getMessage(providerMessageId: string): Promise<InboundRawMessage | null>;
  /** Curseur courant de la boîte, pour amorcer une première synchronisation. */
  currentHistoryId(): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Accès purs à un message déjà lu
// ---------------------------------------------------------------------------

/**
 * Les en-têtes d'un message, indexés en minuscules.
 *
 * RFC 5322 §3.6.8 : un nom de champ est insensible à la casse, et rien
 * n'oblige un client mail à écrire `In-Reply-To` plutôt que `IN-REPLY-TO`.
 * Chercher la casse exacte marcherait presque toujours — c'est-à-dire
 * échouerait exactement sur les clients qu'on n'a pas testés.
 *
 * Les occurrences multiples sont conservées : `Received` et `Delivered-To`
 * apparaissent plusieurs fois par construction, et n'en garder qu'une ferait
 * disparaître l'adresse de livraison réelle dans les cas de redirection.
 */
export function getHeaders(message: InboundRawMessage): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const header of message.headers) {
    const key = header.name.trim().toLowerCase();
    if (key.length === 0) continue;
    const existing = map.get(key);
    if (existing) existing.push(header.value);
    else map.set(key, [header.value]);
  }
  return map;
}

/** Première valeur d'un en-tête, ou `null`. Jamais une chaîne vide déguisée. */
export function getHeader(headers: ReadonlyMap<string, string[]>, name: string): string | null {
  const values = headers.get(name.toLowerCase());
  const first = values?.[0]?.trim();
  return first !== undefined && first.length > 0 ? first : null;
}

/** Toutes les valeurs d'un en-tête, dans l'ordre de lecture. */
export function getHeaderValues(headers: ReadonlyMap<string, string[]>, name: string): readonly string[] {
  return headers.get(name.toLowerCase()) ?? [];
}

/**
 * Le texte lisible d'un message déjà récupéré.
 *
 * Rend le corps tel qu'il a été extrait, sans rognage de citation : la mission
 * (§9) autorise à laisser la correspondance citée en place, et une heuristique
 * de découpe se trompe précisément sur les clients mail qu'elle n'a pas vus.
 */
export function getPlainTextBody(message: InboundRawMessage): string {
  return message.body.text;
}
