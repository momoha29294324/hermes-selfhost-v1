/**
 * R6B-D1 — décodage d'une ressource `Message` de l'API Gmail, sans réseau.
 *
 * Tout ce fichier est pur : il transforme le JSON que Gmail renvoie en un
 * `InboundRawMessage`. C'est délibéré — l'extraction d'un corps est l'endroit
 * où un système d'ingestion se trompe silencieusement (partie choisie au
 * hasard, base64 mal décodé, charset ignoré, pièce jointe prise pour un
 * corps), et une fonction pure est la seule forme qu'on peut couvrir de tests
 * sans jamais toucher une vraie boîte.
 *
 * ---------------------------------------------------------------------------
 * Ce que la documentation Gmail garantit (vérifié le 2026-08-13, pas supposé)
 * ---------------------------------------------------------------------------
 *
 *   * `MessagePartBody.data` — « The body data of a MIME message part as a
 *     base64url encoded string. » Base64URL, donc `-` et `_` à la place de
 *     `+` et `/`, et un remplissage `=` généralement absent.
 *   * `Message.internalDate` — « The internal message creation timestamp
 *     (epoch ms), which determines ordering in the inbox. » C'est l'heure à
 *     laquelle Gmail a accepté le message, pas l'en-tête `Date` que
 *     l'expéditeur contrôle : la seule des deux sur laquelle on peut ordonner.
 *   * `Message.raw` — « The entire email message in an RFC 2822 formatted and
 *     base64url encoded string », renvoyé seulement avec `format=RAW`. Non
 *     utilisé ici : le format `full` donne déjà les en-têtes et les parties
 *     décodables, sans faire entrer le message entier dans la mémoire du
 *     processus.
 */

import type { InboundBody, InboundBodySource, InboundHeader, InboundRawMessage } from '@/lib/inbound/mailbox';

// ---------------------------------------------------------------------------
// La forme que Gmail renvoie
// ---------------------------------------------------------------------------

export interface GmailHeader {
  readonly name?: unknown;
  readonly value?: unknown;
}

export interface GmailMessagePartBody {
  readonly attachmentId?: unknown;
  readonly size?: unknown;
  readonly data?: unknown;
}

export interface GmailMessagePart {
  readonly partId?: unknown;
  readonly mimeType?: unknown;
  readonly filename?: unknown;
  readonly headers?: readonly GmailHeader[];
  readonly body?: GmailMessagePartBody;
  readonly parts?: readonly GmailMessagePart[];
}

export interface GmailMessage {
  readonly id?: unknown;
  readonly threadId?: unknown;
  readonly historyId?: unknown;
  readonly internalDate?: unknown;
  readonly labelIds?: readonly unknown[];
  readonly payload?: GmailMessagePart;
}

/**
 * Plafond de taille du texte retenu. Une réponse commerciale tient en quelques
 * kilo-octets ; au-delà, ce qu'on lit est une chaîne de citations ou un
 * message auto-généré. La coupe est signalée (`truncated`) plutôt que muette —
 * un corps tronqué sans le dire ferait mentir `body_sha256`.
 */
export const MAX_BODY_CHARS = 200_000;

// ---------------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------------

/**
 * Décode le `data` d'une partie Gmail.
 *
 * Base64URL et non Base64 : `-`/`_` remplacent `+`/`/`, et le remplissage est
 * omis. `Buffer.from(x, 'base64')` de Node tolère l'alphabet URL, mais le
 * conversion est faite explicitement — dépendre d'une tolérance non
 * documentée d'un runtime est exactement le genre d'hypothèse qui casse à une
 * montée de version.
 *
 * Rend `null` sur une entrée illisible plutôt qu'une chaîne vide : « pas de
 * corps » et « corps illisible » ne sont pas le même fait.
 */
export function decodeBase64Url(data: string, charset: string | null): string | null {
  if (data.length === 0) return null;
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.length % 4 === 0 ? normalized : normalized.padEnd(normalized.length + (4 - (normalized.length % 4)), '=');
  let bytes: Buffer;
  try {
    bytes = Buffer.from(padded, 'base64');
  } catch {
    return null;
  }
  if (bytes.length === 0) return null;
  return decodeBytes(bytes, charset);
}

/**
 * Interprète des octets selon le charset annoncé par la partie.
 *
 * UTF-8 par défaut, et par défaut aussi quand l'étiquette est inconnue : un
 * repli sur UTF-8 abîme au pire quelques accents, là qu'une exception ferait
 * disparaître un message entier. Le repli est le comportement voulu, pas un
 * oubli.
 */
function decodeBytes(bytes: Buffer, charset: string | null): string {
  const label = (charset ?? 'utf-8').trim().toLowerCase();
  if (label.length === 0 || label === 'utf-8' || label === 'utf8' || label === 'us-ascii' || label === 'ascii') {
    return bytes.toString('utf8');
  }
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

// ---------------------------------------------------------------------------
// Parcours MIME
// ---------------------------------------------------------------------------

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** `text/plain; charset="ISO-8859-1"` → `iso-8859-1`. */
export function charsetOf(part: GmailMessagePart): string | null {
  for (const header of part.headers ?? []) {
    const name = asString(header.name);
    const value = asString(header.value);
    if (name === null || value === null) continue;
    if (name.toLowerCase() !== 'content-type') continue;
    const match = /charset\s*=\s*"?([^";\s]+)"?/i.exec(value);
    const found = match?.[1];
    if (found) return found.toLowerCase();
  }
  return null;
}

interface LeafPart {
  readonly mimeType: string;
  readonly text: string;
}

/**
 * Aplatit l'arbre MIME en gardant uniquement les feuilles textuelles
 * exploitables.
 *
 * Deux exclusions, et elles comptent autant que l'inclusion :
 *
 *   * une partie qui porte un `filename` est une pièce jointe. Un `.txt`
 *     joint est du texte, mais ce n'est pas le corps du message — le prendre
 *     ferait passer le contenu d'un fichier pour ce que le prospect a écrit ;
 *   * une partie dont le `body` ne porte qu'un `attachmentId` n'a pas de
 *     données inline : Gmail les sert par un second appel, que ce module ne
 *     fait pas (la mission ne demande aucune pièce jointe).
 */
export function flattenTextParts(part: GmailMessagePart | undefined, depth = 0): LeafPart[] {
  if (!part || depth > 20) return [];

  const children = part.parts;
  if (Array.isArray(children) && children.length > 0) {
    const out: LeafPart[] = [];
    for (const child of children) out.push(...flattenTextParts(child, depth + 1));
    return out;
  }

  const filename = asString(part.filename);
  if (filename !== null) return [];

  const mimeType = (asString(part.mimeType) ?? 'text/plain').toLowerCase();
  if (!mimeType.startsWith('text/')) return [];

  const data = asString(part.body?.data);
  if (data === null) return [];

  const text = decodeBase64Url(data, charsetOf(part));
  if (text === null) return [];

  return [{ mimeType, text }];
}

// ---------------------------------------------------------------------------
// HTML → texte
// ---------------------------------------------------------------------------

/**
 * Entités nommées effectivement rencontrées dans du courrier francophone.
 *
 * Volontairement une table courte plutôt qu'un décodeur HTML complet : ce qui
 * n'y figure pas est laissé TEL QUEL (`&xyz;`), donc visible. Un décodeur
 * partiel qui effacerait les entités inconnues rendrait un texte amputé sans
 * que personne ne s'en aperçoive.
 *
 * La casse compte : `&Eacute;` et `&eacute;` ne sont pas la même lettre.
 */
const HTML_ENTITIES: Record<string, string> = {
  eacute: 'é',
  Eacute: 'É',
  egrave: 'è',
  Egrave: 'È',
  ecirc: 'ê',
  Ecirc: 'Ê',
  euml: 'ë',
  agrave: 'à',
  Agrave: 'À',
  acirc: 'â',
  Acirc: 'Â',
  ccedil: 'ç',
  Ccedil: 'Ç',
  icirc: 'î',
  Icirc: 'Î',
  iuml: 'ï',
  ocirc: 'ô',
  Ocirc: 'Ô',
  ouml: 'ö',
  ugrave: 'ù',
  Ugrave: 'Ù',
  ucirc: 'û',
  Ucirc: 'Û',
  uuml: 'ü',
  laquo: '«',
  raquo: '»',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  ndash: '–',
  mdash: '—',
  euro: '€',
  deg: '°',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  // Espace ORDINAIRE, pas U+00A0 : une espace insécable dans un corps stocké
  // est un caractère invisible qui ferait échouer une comparaison de texte
  // sans que rien ne le montre à l'écran.
  nbsp: '\u0020',
};

/**
 * Réduction volontairement pauvre d'un HTML de mail en texte.
 *
 * Ce n'est pas un moteur de rendu et cela n'essaie pas d'en être un (§9 : « Do
 * not need HTML rendering »). Le seul objectif est qu'un humain puisse lire ce
 * que le prospect a écrit quand son client mail n'a pas joint de partie texte.
 * Ce que le résultat vaut est dit explicitement par `body_source = 'text/html'`
 * en base : personne ne le confondra avec un vrai `text/plain`.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d{1,7});/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_m, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    // Casse exacte d'abord (`&Eacute;` ≠ `&eacute;`), puis repli en minuscules
    // pour les seules entités de base que du vieux courrier écrit `&AMP;`.
    .replace(
      /&([a-zA-Z]+);/g,
      (match, name: string) => HTML_ENTITIES[name] ?? HTML_ENTITIES[name.toLowerCase()] ?? match,
    )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Le corps retenu, et d'où il vient.
 *
 * Ordre de préférence : `text/plain` d'abord, toujours — c'est ce que le
 * prospect a tapé. `text/html` seulement en second recours, reconstruit et
 * annoncé comme tel. Aucune partie exploitable : `none` et un corps vide, ce
 * qui est un fait observable et non une erreur (un accusé de réception peut
 * n'avoir aucun corps).
 */
export function extractPlainTextBody(payload: GmailMessagePart | undefined): InboundBody {
  const leaves = flattenTextParts(payload);

  const plain = leaves.find((leaf) => leaf.mimeType === 'text/plain' && leaf.text.trim().length > 0);
  if (plain) return bounded(plain.text, 'text/plain');

  const html = leaves.find((leaf) => leaf.mimeType === 'text/html' && leaf.text.trim().length > 0);
  if (html) {
    const converted = htmlToText(html.text);
    if (converted.length > 0) return bounded(converted, 'text/html');
  }

  // Une feuille textuelle d'un autre sous-type (`text/calendar`, `text/rfc822-headers`
  // d'un rapport de non-remise…) reste préférable au vide : elle porte souvent
  // la seule information exploitable d'un message automatique.
  const other = leaves.find((leaf) => leaf.text.trim().length > 0);
  if (other) return bounded(other.text, 'text/plain');

  return Object.freeze({ text: '', source: 'none' as InboundBodySource, truncated: false });
}

function bounded(text: string, source: InboundBodySource): InboundBody {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (normalized.length <= MAX_BODY_CHARS) {
    return Object.freeze({ text: normalized, source, truncated: false });
  }
  return Object.freeze({ text: normalized.slice(0, MAX_BODY_CHARS), source, truncated: true });
}

// ---------------------------------------------------------------------------
// Message complet
// ---------------------------------------------------------------------------

function readHeaders(payload: GmailMessagePart | undefined): InboundHeader[] {
  const out: InboundHeader[] = [];
  for (const header of payload?.headers ?? []) {
    const name = asString(header.name);
    const value = typeof header.value === 'string' ? header.value : null;
    if (name === null || value === null) continue;
    out.push({ name, value });
  }
  return out;
}

/**
 * `internalDate` arrive en chaîne (int64 JSON). Une valeur illisible donne
 * `null` — l'ingestion refusera alors le message plutôt que de lui inventer
 * une date de réception, qui est précisément ce sur quoi la corrélation
 * s'appuie pour affirmer « après l'envoi ».
 */
function readInternalDate(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export class GmailMessageShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GmailMessageShapeError';
  }
}

/** Traduit une ressource Gmail en message neutre. Lève si l'identifiant manque. */
export function toInboundRawMessage(message: GmailMessage): InboundRawMessage {
  const id = asString(message.id);
  if (id === null) throw new GmailMessageShapeError('message Gmail sans identifiant — rien à ingérer');

  return Object.freeze({
    providerMessageId: id,
    providerThreadId: asString(message.threadId),
    providerHistoryId: asString(message.historyId),
    internalDateMs: readInternalDate(message.internalDate),
    headers: Object.freeze(readHeaders(message.payload)),
    body: extractPlainTextBody(message.payload),
  });
}
