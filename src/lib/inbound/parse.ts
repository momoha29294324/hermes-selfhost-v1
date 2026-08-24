/**
 * R6B-D1 — primitives d'analyse d'un message entrant. Pures, déterministes,
 * sans base ni réseau.
 *
 * Tout ce que la corrélation utilise pour décider passe d'abord par ici. C'est
 * la raison pour laquelle ces fonctions sont séparées : une règle de
 * corrélation qui parserait elle-même ses adresses serait testable seulement à
 * travers la base, et les cas qui comptent (une adresse entre chevrons, un
 * `References` à cinq identifiants, un jeton mal formé) ne seraient jamais
 * exercés directement.
 */

import { sha256Hex } from '@/lib/util/hash';
import { getHeader, getHeaders, getHeaderValues, type InboundRawMessage } from '@/lib/inbound/mailbox';

// ---------------------------------------------------------------------------
// Adresses
// ---------------------------------------------------------------------------

/**
 * Même forme d'adresse que celle exigée côté sortant (`r6bLiveEmail`) :
 * permissive sur la partie locale, stricte sur l'absence d'espace et la
 * présence d'un TLD. « Adressable » veut ainsi dire la même chose des deux
 * côtés du système.
 */
const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export interface ParsedAddress {
  /** Minuscules, sans chevrons ni nom d'affichage. La forme comparable. */
  readonly address: string;
  /** Nom d'affichage tel qu'écrit, ou `null`. Jamais utilisé pour décider. */
  readonly displayName: string | null;
}

/**
 * Découpe une liste d'adresses en respectant les guillemets et les chevrons.
 *
 * Un `split(',')` naïf coupe au milieu de `"Dupont, Jean" <j@ex.fr>` et
 * fabrique deux adresses dont aucune n'existe. Le coût d'un vrai découpage est
 * une boucle de vingt lignes ; le coût de l'autre est une corrélation qui
 * échoue sur les seuls prospects dont le nom porte une virgule.
 */
function splitAddressList(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  let inAngle = false;

  for (const char of value) {
    if (char === '"' && !inAngle) {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (char === '<' && !inQuotes) inAngle = true;
    else if (char === '>' && !inQuotes) inAngle = false;

    if (char === ',' && !inQuotes && !inAngle) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/** `Nom <a@b.c>` ou `a@b.c` → adresse normalisée. `null` si ce n'est pas une adresse. */
export function parseAddress(raw: string): ParsedAddress | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const angle = /^(?<name>.*?)<(?<address>[^<>]+)>\s*$/.exec(trimmed);
  const candidate = (angle?.groups?.address ?? trimmed).trim();
  if (!EMAIL_ADDRESS.test(candidate)) return null;

  const rawName = angle?.groups?.name?.trim() ?? '';
  const displayName = rawName.replace(/^"(.*)"$/, '$1').trim();

  return Object.freeze({
    // RFC 5321 : le domaine est insensible à la casse, la partie locale ne
    // l'est formellement pas. En pratique aucun fournisseur grand public ne la
    // distingue, et comparer deux graphies d'une même boîte comme deux boîtes
    // différentes ferait perdre des réponses. Normalisé entièrement, donc.
    address: candidate.toLowerCase(),
    displayName: displayName.length > 0 ? displayName : null,
  });
}

/** Toutes les adresses d'un en-tête de liste (`To`, `Cc`, `Delivered-To`…). */
export function parseAddressList(values: readonly string[]): ParsedAddress[] {
  const out: ParsedAddress[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    for (const chunk of splitAddressList(value)) {
      const parsed = parseAddress(chunk);
      if (parsed === null || seen.has(parsed.address)) continue;
      seen.add(parsed.address);
      out.push(parsed);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Identifiants RFC 5322
// ---------------------------------------------------------------------------

/**
 * Extrait les `msg-id` d'un en-tête `Message-ID`, `In-Reply-To` ou
 * `References`.
 *
 * `References` est une liste par définition (RFC 5322 §3.6.4), et certains
 * clients en mettent plusieurs dans `In-Reply-To` malgré la spécification.
 * Rendre systématiquement une liste évite qu'un identifiant valide soit ignoré
 * parce qu'il n'était pas en première position.
 *
 * Les chevrons sont CONSERVÉS : c'est la forme sous laquelle Resend expose
 * `message_id` (`<111-222-333@email.example.com>`), donc la seule qui se
 * compare sans transformation à ce qui est stocké.
 */
export function parseMessageIds(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    for (const match of value.matchAll(/<[^<>\s]+@[^<>\s]+>/g)) {
      const id = match[0];
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Objet
// ---------------------------------------------------------------------------

/**
 * Préfixes de réponse et de transfert, dans les langues que les clients mail
 * de prospects français produisent réellement. `Aw`/`Antw` (allemand) et
 * `Sv` (nordique) sont là parce qu'ils coûtent une alternative dans une regex
 * et qu'un objet mal normalisé fait rater une comparaison sans le dire.
 */
const REPLY_PREFIX = /^\s*(?:re|ré|rép|rep|réf|ref|aw|antw|sv|fwd?|tr|rv|enc)\s*(?:\[\d+\])?\s*:\s*/i;

/**
 * Objet comparable : préfixes retirés (autant de fois qu'ils sont empilés),
 * blancs réduits, minuscules.
 *
 * Ne sert JAMAIS à conclure seul (§7 de la mission : « Do NOT call
 * sender+subject alone EXACT »). Un objet identique est une corroboration
 * quand une autre preuve désigne déjà un envoi unique, et rien de plus : deux
 * prospects du même lot recevraient des objets construits sur le même modèle.
 */
export function normalizeSubject(subject: string | null): string {
  let current = (subject ?? '').replace(/\s+/g, ' ').trim();
  // Bornée : un objet forgé avec mille « Re: » ne doit pas faire boucler
  // l'ingestion.
  for (let i = 0; i < 12; i += 1) {
    const stripped = current.replace(REPLY_PREFIX, '');
    if (stripped === current) break;
    current = stripped.trim();
  }
  return current.toLowerCase();
}

// ---------------------------------------------------------------------------
// Adresses plus-taguées
// ---------------------------------------------------------------------------

/**
 * Préfixe des jetons de réponse outbound. Distinct pour qu'un `+facture` ou un
 * `+newsletter` déjà utilisé par un opérateur ne soit jamais pris pour un jeton.
 */
export const REPLY_TOKEN_PREFIX = 'ob_';

/**
 * Forme d'un jeton, identique à la contrainte de `r6b_reply_tokens.token`.
 *
 * Minuscules et chiffres : la partie locale d'une adresse peut perdre sa casse
 * en route chez certains serveurs, et un jeton qui ne se résout plus après un
 * relais serait pire qu'inutile — il ferait croire à un jeton falsifié.
 */
export const REPLY_TOKEN_SHAPE = /^[a-z0-9]{16,64}$/;

export type PlusAddressRejection = 'not_plus_addressed' | 'wrong_prefix' | 'malformed_token';

export type PlusAddressResult =
  | { readonly ok: true; readonly base: string; readonly token: string }
  | { readonly ok: false; readonly code: PlusAddressRejection; readonly base: string | null };

/**
 * Lit `operatoragency+ob_<token>@example.com`.
 *
 * Rend le jeton, jamais son sens : ce module ne sait pas ce qu'un jeton
 * désigne et n'a aucun moyen de le savoir. La résolution est une lecture en
 * base (`resolveReplyToken`), et c'est ce qui rend un jeton inventé sans
 * effet — il n'y a rien à décoder, donc rien à falsifier.
 */
export function parsePlusAddress(address: string): PlusAddressResult {
  const normalized = address.trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  if (at <= 0) return { ok: false, code: 'not_plus_addressed', base: null };

  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus < 0) return { ok: false, code: 'not_plus_addressed', base: normalized };

  const base = `${local.slice(0, plus)}@${domain}`;
  const tag = local.slice(plus + 1);

  if (!tag.startsWith(REPLY_TOKEN_PREFIX)) return { ok: false, code: 'wrong_prefix', base };

  const token = tag.slice(REPLY_TOKEN_PREFIX.length);
  if (!REPLY_TOKEN_SHAPE.test(token)) return { ok: false, code: 'malformed_token', base };

  return { ok: true, base, token };
}

// ---------------------------------------------------------------------------
// Indices d'automatisation
// ---------------------------------------------------------------------------

/**
 * Faits observés qui distingueront plus tard un humain d'une machine.
 *
 * Ce sont des OBSERVATIONS, jamais une étiquette. La mission (§10) le demande
 * explicitement : ingérer et identifier, pas classer commercialement. Écrire
 * « bounce » ici obligerait à choisir un seuil, et un seuil mal choisi ferait
 * disparaître une vraie réponse derrière une catégorie.
 *
 * Chaque signal correspond à un en-tête réellement présent — rien n'est déduit
 * d'un mot du corps ni d'une tournure de l'objet.
 */
export function detectAutomationSignals(
  headers: ReadonlyMap<string, string[]>,
  fromAddress: string,
): string[] {
  const signals = new Set<string>();

  const autoSubmitted = getHeader(headers, 'auto-submitted');
  if (autoSubmitted !== null && autoSubmitted.toLowerCase() !== 'no') {
    signals.add(`auto_submitted:${autoSubmitted.toLowerCase().split(';')[0]?.trim() ?? 'unknown'}`);
  }

  for (const name of ['x-autoreply', 'x-autorespond', 'x-auto-response-suppress', 'x-autoreply-domain']) {
    if (getHeaderValues(headers, name).length > 0) signals.add('auto_reply_header');
  }

  const precedence = getHeader(headers, 'precedence');
  if (precedence !== null) signals.add(`precedence:${precedence.toLowerCase()}`);

  if (getHeaderValues(headers, 'list-unsubscribe').length > 0) signals.add('list_unsubscribe');
  if (getHeaderValues(headers, 'x-failed-recipients').length > 0) signals.add('failed_recipients_header');

  const contentType = (getHeader(headers, 'content-type') ?? '').toLowerCase();
  if (contentType.includes('multipart/report')) signals.add('multipart_report');
  if (contentType.includes('report-type=delivery-status')) signals.add('delivery_status_report');

  const returnPath = getHeader(headers, 'return-path');
  if (returnPath !== null && returnPath.replace(/\s/g, '') === '<>') signals.add('null_return_path');

  const local = fromAddress.split('@')[0] ?? '';
  if (['mailer-daemon', 'postmaster', 'no-reply', 'noreply', 'donotreply'].includes(local)) {
    signals.add(`system_sender:${local}`);
  }

  return [...signals].sort();
}

// ---------------------------------------------------------------------------
// Message normalisé
// ---------------------------------------------------------------------------

/** En-têtes conservés en base : ceux dont la corrélation ou un humain a besoin. */
export const CORRELATION_HEADERS: readonly string[] = [
  'message-id',
  'in-reply-to',
  'references',
  'from',
  'to',
  'cc',
  'reply-to',
  'delivered-to',
  'return-path',
  'subject',
  'date',
  'auto-submitted',
  'precedence',
  'content-type',
  'x-failed-recipients',
  'list-unsubscribe',
];

export interface NormalizedInboundMessage {
  readonly providerMessageId: string;
  readonly providerThreadId: string | null;
  readonly providerHistoryId: string | null;
  readonly receivedAt: Date;
  readonly fromAddress: string;
  readonly fromDisplay: string | null;
  readonly toAddresses: readonly string[];
  readonly ccAddresses: readonly string[];
  readonly replyToAddresses: readonly string[];
  readonly deliveredToAddresses: readonly string[];
  readonly subject: string | null;
  readonly normalizedSubject: string;
  readonly rfcMessageId: string | null;
  readonly inReplyTo: readonly string[];
  readonly referenceIds: readonly string[];
  readonly bodyText: string;
  readonly bodySha256: string;
  readonly bodySource: 'text/plain' | 'text/html' | 'none';
  readonly bodyTruncated: boolean;
  readonly rawHeaders: Readonly<Record<string, readonly string[]>>;
  readonly automationSignals: readonly string[];
}

export class InboundNormalizationError extends Error {
  readonly code: 'no_sender' | 'no_received_at';
  constructor(code: InboundNormalizationError['code'], message: string) {
    super(message);
    this.name = 'InboundNormalizationError';
    this.code = code;
  }
}

/**
 * Passe d'un message brut à la forme persistée.
 *
 * Deux refus, et ils sont volontairement durs :
 *
 *   * pas d'expéditeur lisible → refus. Un message entrant sans `From`
 *     exploitable ne peut être corrélé par aucune règle, et lui inventer un
 *     expéditeur vide le ferait ressembler à tous les autres du même genre ;
 *   * pas de date de réception → refus. « Après l'envoi » est la condition
 *     que le repli du premier envoi réel vérifie ; sans date, elle serait
 *     évaluée sur une valeur fabriquée.
 *
 * Refuser fait remonter le message comme un échec visible du tour de poll,
 * ce qui empêche le curseur d'avancer par-dessus (§12).
 */
export function normalizeInboundMessage(message: InboundRawMessage): NormalizedInboundMessage {
  const headers = getHeaders(message);

  const from = parseAddressList(getHeaderValues(headers, 'from'))[0];
  if (!from) {
    throw new InboundNormalizationError(
      'no_sender',
      `message ${message.providerMessageId} sans expéditeur lisible — aucune corrélation possible`,
    );
  }

  if (message.internalDateMs === null) {
    throw new InboundNormalizationError(
      'no_received_at',
      `message ${message.providerMessageId} sans internalDate — une date de réception ne se fabrique pas`,
    );
  }

  const rawHeaders: Record<string, readonly string[]> = {};
  for (const name of CORRELATION_HEADERS) {
    const values = getHeaderValues(headers, name);
    if (values.length > 0) rawHeaders[name] = Object.freeze([...values]);
  }

  const subject = getHeader(headers, 'subject');

  return Object.freeze({
    providerMessageId: message.providerMessageId,
    providerThreadId: message.providerThreadId,
    providerHistoryId: message.providerHistoryId,
    receivedAt: new Date(message.internalDateMs),
    fromAddress: from.address,
    fromDisplay: from.displayName,
    toAddresses: Object.freeze(parseAddressList(getHeaderValues(headers, 'to')).map((a) => a.address)),
    ccAddresses: Object.freeze(parseAddressList(getHeaderValues(headers, 'cc')).map((a) => a.address)),
    replyToAddresses: Object.freeze(parseAddressList(getHeaderValues(headers, 'reply-to')).map((a) => a.address)),
    deliveredToAddresses: Object.freeze(
      parseAddressList(getHeaderValues(headers, 'delivered-to')).map((a) => a.address),
    ),
    subject,
    normalizedSubject: normalizeSubject(subject),
    rfcMessageId: parseMessageIds(getHeaderValues(headers, 'message-id'))[0] ?? null,
    inReplyTo: Object.freeze(parseMessageIds(getHeaderValues(headers, 'in-reply-to'))),
    referenceIds: Object.freeze(parseMessageIds(getHeaderValues(headers, 'references'))),
    bodyText: message.body.text,
    bodySha256: sha256Hex(message.body.text),
    bodySource: message.body.source,
    bodyTruncated: message.body.truncated,
    rawHeaders: Object.freeze(rawHeaders),
    automationSignals: Object.freeze(detectAutomationSignals(headers, from.address)),
  });
}
