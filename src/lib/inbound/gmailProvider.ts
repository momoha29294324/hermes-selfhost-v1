/**
 * R6B-D1 — l'implémentation Gmail, en lecture seule.
 *
 * Deux couches, et la séparation est le cœur du fichier :
 *
 *   * `GmailApi` — le transport. Quatre appels, tous des `GET` vers
 *     `gmail.googleapis.com`. C'est la seule surface qui touche le réseau ;
 *   * `GmailInboundProvider` — la stratégie de lecture (quoi demander, comment
 *     borner, comment paginer, quand ne rien demander du tout). Pure vis-à-vis
 *     du réseau : elle reçoit un `GmailApi` et n'en construit jamais.
 *
 * Les tests injectent un faux `GmailApi` et exercent donc le VRAI code de
 * bornage, de pagination et de décodage — pas une maquette de celui-ci.
 *
 * ===========================================================================
 * Pourquoi l'API History n'est pas le curseur, alors qu'elle en a le nom
 * ===========================================================================
 *
 * `users.history.list` est la primitive incrémentale de Gmail, et la mission
 * demandait de l'utiliser « seulement si c'est réellement le mécanisme correct
 * d'après la documentation courante ». Vérification faite le 2026-08-13, ce
 * n'est pas le cas ici, et pour une raison qui ne se contourne pas :
 *
 *   * `users.history.list` accepte `startHistoryId`, `labelId`, `historyTypes`
 *     — et AUCUN paramètre `q`. Il rend donc tout ce qui a changé dans la
 *     boîte, sans distinction ;
 *   * pour savoir si un changement concerne l'outbound, il faudrait lire
 *     chaque message rendu. C'est-à-dire lire le courrier personnel de
 *     un opérateur, ce que §13 de la mission interdit explicitement ;
 *   * s'y ajoute sa fragilité documentée : « History records are typically
 *     available for at least one week », et un `startHistoryId` hors fenêtre
 *     renvoie « an HTTP 404 error response », auquel cas « your client must
 *     perform a full sync ».
 *
 * Le curseur durable est donc `internalDate` — « The internal message creation
 * timestamp (epoch ms), which determines ordering in the inbox » —, exploité
 * par l'opérateur `after:` d'une requête `users.messages.list` bornée aux
 * adresses de l'outbound. Il ne périme jamais, et surtout il borne la lecture
 * AVANT que quoi que ce soit ne soit lu.
 *
 * `historyId` garde un rôle, mais un seul : un marqueur de version de la
 * boîte. Il croît à chaque changement ; s'il est identique à celui du tour
 * précédent, rien n'a bougé et aucune requête n'est envoyée. C'est une
 * économie, jamais un bornage — et c'est pour cela qu'un marqueur inutilisable
 * ne peut faire sauter aucun message : la borne temporelle, elle, est toujours
 * là.
 */

import { env } from '@/lib/env';
import { HttpClient, HttpError } from '@/lib/http/client';
import { toInboundRawMessage, type GmailMessage } from '@/lib/inbound/gmailMessage';
import type {
  InboundMailboxProvider,
  InboundRawMessage,
  ListNewMessagesRequest,
  MailboxListResult,
} from '@/lib/inbound/mailbox';

// ---------------------------------------------------------------------------
// Identifiants — jamais en base, jamais journalisés
// ---------------------------------------------------------------------------

export const GMAIL_ENV_KEYS = {
  clientId: 'GMAIL_OAUTH_CLIENT_ID',
  clientSecret: 'GMAIL_OAUTH_CLIENT_SECRET',
  refreshToken: 'GMAIL_OAUTH_REFRESH_TOKEN',
  inboxAddress: 'GMAIL_INBOX_ADDRESS',
} as const;

export interface GmailCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly inboxAddress: string;
}

export type GmailCredentialsResult =
  | { readonly ok: true; readonly credentials: GmailCredentials }
  | { readonly ok: false; readonly missing: readonly string[] };

/**
 * Lit les identifiants Gmail. Fail-closed : sans eux, il n'y a pas de
 * fournisseur dégradé, il n'y a pas de fournisseur du tout.
 *
 * Ne rend QUE des noms de variables manquantes — jamais une valeur, jamais un
 * fragment, jamais une longueur (CLAUDE.md §6). Un appelant qui affiche ce
 * résultat ne peut donc pas divulguer un secret même en le voulant.
 */
export function readGmailCredentials(): GmailCredentialsResult {
  const missing: string[] = [];
  const values: Record<string, string> = {};

  for (const [field, key] of Object.entries(GMAIL_ENV_KEYS)) {
    const value = env(key);
    if (value === undefined || value.trim().length === 0) missing.push(key);
    else values[field] = value.trim();
  }
  if (missing.length > 0) return { ok: false, missing: Object.freeze(missing) };

  return {
    ok: true,
    credentials: Object.freeze({
      clientId: values.clientId!,
      clientSecret: values.clientSecret!,
      refreshToken: values.refreshToken!,
      inboxAddress: values.inboxAddress!.toLowerCase(),
    }),
  };
}

// ---------------------------------------------------------------------------
// Portées OAuth
// ---------------------------------------------------------------------------

/**
 * La portée demandée, et la plus étroite qui permette réellement le travail.
 *
 * `gmail.metadata` est plus étroite encore, mais la documentation Gmail est
 * explicite sur ses deux limites, et chacune suffit à l'écarter : elle ne rend
 * pas le corps des messages (« View your email message metadata such as labels
 * and headers, but not the email body »), et le paramètre `q` de
 * `users.messages.list` « Cannot be used with the gmail.metadata scope » —
 * c'est-à-dire précisément le mécanisme qui borne la lecture à l'outbound.
 * L'utiliser obligerait à lister toute la boîte pour trier ensuite, soit
 * exactement l'inverse de l'effet recherché.
 */
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

/**
 * Portées qui donnent un pouvoir d'écriture sur la boîte. Un jeton qui en
 * porte une est REFUSÉ, même si ce module n'appelle jamais d'endpoint
 * d'écriture : la garde ne doit pas dépendre du fait qu'aucun futur diff
 * n'ajoutera un appel. Refuser le jeton rend l'écriture impossible ; ne pas
 * l'appeler la rend seulement improbable.
 */
export const GMAIL_WRITE_SCOPES: readonly string[] = [
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.insert',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  'https://www.googleapis.com/auth/gmail.settings.sharing',
];

const GMAIL_READ_SCOPES: readonly string[] = [
  GMAIL_READONLY_SCOPE,
  'https://www.googleapis.com/auth/gmail.metadata',
];

export class GmailScopeError extends Error {
  readonly code: 'write_scope_granted' | 'no_read_scope';
  constructor(code: GmailScopeError['code'], message: string) {
    super(message);
    this.name = 'GmailScopeError';
    this.code = code;
  }
}

/**
 * Vérifie la portée réellement accordée, telle que le point d'échange de
 * jetons la renvoie (« The scopes of access granted by the access_token
 * expressed as a list of space-delimited, case-sensitive strings »).
 *
 * Pure et exportée pour être testable sans réseau : c'est une garde de
 * sécurité, elle mérite d'échouer dans un test avant d'échouer en production.
 */
export function assertReadOnlyScope(granted: string): void {
  const scopes = granted.split(/\s+/).filter((entry) => entry.length > 0);

  const writeScope = scopes.find((scope) => GMAIL_WRITE_SCOPES.includes(scope));
  if (writeScope !== undefined) {
    throw new GmailScopeError(
      'write_scope_granted',
      `le jeton Gmail porte une portée d'écriture (${writeScope}). ` +
        `Cette mission est en lecture seule : régénérer un jeton limité à ${GMAIL_READONLY_SCOPE}.`,
    );
  }

  if (!scopes.some((scope) => GMAIL_READ_SCOPES.includes(scope))) {
    throw new GmailScopeError(
      'no_read_scope',
      `le jeton Gmail ne porte aucune portée de lecture. Attendu : ${GMAIL_READONLY_SCOPE}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Le transport
// ---------------------------------------------------------------------------

export interface GmailListMessagesResponse {
  readonly messages?: readonly { readonly id?: unknown }[];
  readonly nextPageToken?: unknown;
}

export interface GmailProfile {
  readonly emailAddress?: unknown;
  readonly historyId?: unknown;
}

/**
 * Ce que le fournisseur attend du réseau. Trois lectures, aucune écriture —
 * et aucune méthode nommée pour marquer, archiver, étiqueter ou supprimer.
 */
export interface GmailApi {
  listMessages(params: {
    readonly q: string;
    readonly maxResults: number;
    readonly pageToken: string | null;
  }): Promise<GmailListMessagesResponse>;
  getMessage(providerMessageId: string): Promise<GmailMessage | null>;
  getProfile(): Promise<GmailProfile>;
}

// ---------------------------------------------------------------------------
// La requête bornée
// ---------------------------------------------------------------------------

/** `after:` de Gmail attend `YYYY/MM/DD`. UTC, pour ne pas dépendre du fuseau du poste. */
export function gmailDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
}

/**
 * La requête qui borne tout.
 *
 * ===========================================================================
 * R6B-D1.3 — pourquoi ce n'est PAS `to:`/`deliveredto:` sur la boîte lue
 * ===========================================================================
 *
 * La version précédente bornait sur `to:<boîte d'un opérateur>` /
 * `deliveredto:<boîte d'un opérateur>`. C'est une non-borne : TOUT message livré
 * dans une boîte porte forcément cette boîte en `To:` ou `Delivered-To:` —
 * c'est la définition même d'être dans la boîte. La requête produite
 * équivalait donc à « tout ce qui est arrivé après telle date », exactement
 * ce que §13 de la mission interdit (« Do not fetch all mail merely because
 * it is to:<mailbox> / delivered to the mailbox / in inbox / after a
 * timestamp »). Premier tour en production : 17 messages sans rapport avec
 * l'outbound (newsletters, notifications SaaS) ingérés en `UNMATCHED`.
 *
 * La vraie frontière est `from:` sur les adresses qui ont RÉELLEMENT reçu un
 * envoi sortant (`counterparties`, dérivées de `outreach_events.kind =
 * 'sent'`). Une réponse plausible ne peut venir que de l'une d'elles ; tout
 * le reste est, par construction, hors sujet.
 *
 * Trois bornes en tout :
 *
 *   * `from:` sur chaque contrepartie sortante connue ;
 *   * `after:` (§12), dérivé du curseur `internalDate` ;
 *   * `-in:sent -in:draft -in:chats`, pour ne jamais réingérer nos propres
 *     messages ni des brouillons.
 *
 * Aucune clause sur l'objet : §13 interdit de s'appuyer sur le sujet, et pour
 * une bonne raison — une réponse dont le client a réécrit l'objet
 * disparaîtrait, alors que c'est exactement la réponse qu'on attend.
 *
 * `counterparties` est déjà chunké par l'appelant (voir `chunkCounterparties`)
 * — cette fonction construit la requête d'UN chunk, jamais de la liste
 * entière d'un coup.
 */
export function buildInboxQuery(since: Date | null, counterparties: readonly string[]): string {
  const from = counterparties.map((address) => `from:${address}`);
  const clauses = [`{${from.join(' ')}}`, '-in:sent', '-in:draft', '-in:chats'];
  if (since !== null) clauses.push(`after:${gmailDate(since)}`);
  return clauses.join(' ');
}

/**
 * Longueur maximale, en caractères, des clauses `from:` d'un seul chunk.
 *
 * Gmail ne documente aucune limite explicite sur `q` de `users.messages.list`.
 * Cette borne est donc volontairement conservatrice plutôt que dérivée d'une
 * valeur officielle : assez large pour rarement chunker en usage normal, assez
 * étroite pour rester loin des limites d'URL/en-tête qu'un proxy HTTP applique
 * couramment (souvent autour de 8 Ko pour l'URL entière).
 */
export const MAX_QUERY_CLAUSE_LENGTH = 1200;

/**
 * Découpe une liste de contreparties en groupes dont la clause `from:` tient
 * sous `maxLength`. Déterministe et sans perte : chaque adresse apparaît dans
 * exactement un chunk, dans l'ordre d'entrée — aucun prospect n'est
 * silencieusement omis, et deux appels avec la même entrée produisent
 * toujours le même découpage.
 */
export function chunkCounterparties(
  counterparties: readonly string[],
  maxLength: number = MAX_QUERY_CLAUSE_LENGTH,
): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentLength = 0;

  for (const address of counterparties) {
    const clauseLength = `from:${address} `.length;
    if (current.length > 0 && currentLength + clauseLength > maxLength) {
      chunks.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(address);
    currentLength += clauseLength;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// ---------------------------------------------------------------------------
// Le fournisseur
// ---------------------------------------------------------------------------

export interface GmailInboundProviderDeps {
  readonly api: GmailApi;
  /** Taille de page demandée à Gmail. Bornée par l'API à 500. */
  readonly pageSize?: number;
  /** Longueur maximale d'un chunk de contreparties. Injectable pour les tests. */
  readonly maxQueryClauseLength?: number;
}

export class GmailInboundProvider implements InboundMailboxProvider {
  readonly name = 'gmail' as const;
  readonly capabilities = Object.freeze({ canSend: false as const, canModifyMailbox: false as const });

  private readonly api: GmailApi;
  private readonly pageSize: number;
  private readonly maxQueryClauseLength: number;

  constructor(deps: GmailInboundProviderDeps) {
    this.api = deps.api;
    this.pageSize = Math.min(500, Math.max(1, deps.pageSize ?? 100));
    this.maxQueryClauseLength = deps.maxQueryClauseLength ?? MAX_QUERY_CLAUSE_LENGTH;
  }

  async currentHistoryId(): Promise<string | null> {
    const profile = await this.api.getProfile();
    return typeof profile.historyId === 'string' && profile.historyId.length > 0 ? profile.historyId : null;
  }

  async listNewMessages(request: ListNewMessagesRequest): Promise<MailboxListResult> {
    const { scope, startHistoryId } = request;

    const counterparties = [...new Set(scope.counterparties.map((address) => address.trim().toLowerCase()))].filter(
      (address) => address.length > 0,
    );

    if (counterparties.length === 0) {
      // Aucun envoi sortant connu : rien à corréler, donc aucun appel Gmail —
      // ni `messages.list`, ni même `getProfile`. Une boîte qu'on n'a aucune
      // raison de lire n'est pas lue, pas « lue et jetée ».
      return Object.freeze({
        strategy: 'no_counterparties' as const,
        messageIds: Object.freeze([] as string[]),
        latestHistoryId: null,
        historyCursorInvalid: false,
        truncated: false,
      });
    }

    let latestHistoryId: string | null = null;
    let historyCursorInvalid = false;
    try {
      latestHistoryId = await this.currentHistoryId();
    } catch {
      // Le marqueur est un confort. Ne pas l'obtenir n'empêche pas de lire :
      // la borne temporelle, elle, ne dépend de rien.
      latestHistoryId = null;
    }

    if (startHistoryId !== null && latestHistoryId !== null) {
      if (latestHistoryId === startHistoryId) {
        // Rien n'a changé dans la boîte depuis le dernier tour. Aucune requête
        // n'est envoyée, et le marqueur est renvoyé inchangé.
        return Object.freeze({
          strategy: 'unchanged' as const,
          messageIds: Object.freeze([] as string[]),
          latestHistoryId,
          historyCursorInvalid: false,
          truncated: false,
        });
      }
      // Un marqueur qui RECULE est impossible dans une boîte saine : le
      // `historyId` croît à chaque changement. Signalé et non avalé — puis
      // resynchronisation bornée, qui reste sûre parce que `after:` borne
      // toujours ce qui sera lu.
      if (isBackwards(startHistoryId, latestHistoryId)) historyCursorInvalid = true;
    }

    // Plusieurs requêtes bornées, une par chunk de contreparties — jamais une
    // requête unique portant toute la liste (limites d'URL/en-tête HTTP). Les
    // identifiants sont dédupliqués au fur et à mesure : un message dont
    // l'expéditeur apparaît dans deux chunks (ne devrait pas arriver, les
    // chunks partitionnent des adresses uniques, mais Gmail peut aussi rendre
    // un même identifiant deux fois dans une même page) n'est compté qu'une
    // fois.
    const chunks = chunkCounterparties(counterparties, this.maxQueryClauseLength);
    const ids = new Set<string>();
    let truncated = false;

    chunkLoop: for (const chunk of chunks) {
      const q = buildInboxQuery(scope.since, chunk);
      let pageToken: string | null = null;

      do {
        const remaining = scope.maxMessages - ids.size;
        if (remaining <= 0) {
          // Le plafond global est déjà atteint et il reste du travail non fait
          // (cette page, ou un chunk suivant) : c'est une troncature, pas une
          // fin naturelle.
          truncated = true;
          break chunkLoop;
        }

        const page: GmailListMessagesResponse = await this.api.listMessages({
          q,
          maxResults: Math.min(this.pageSize, remaining),
          pageToken,
        });

        for (const entry of page.messages ?? []) {
          const id = entry.id;
          if (typeof id === 'string' && id.length > 0) ids.add(id);
        }

        pageToken = typeof page.nextPageToken === 'string' && page.nextPageToken.length > 0 ? page.nextPageToken : null;

        if (pageToken !== null && ids.size >= scope.maxMessages) {
          // Le plafond a coupé une liste qui continuait. Dit explicitement :
          // l'appelant refusera d'avancer le curseur, donc rien n'est perdu —
          // mais le taire ferait ressembler un tour partiel à un tour complet.
          truncated = true;
          break chunkLoop;
        }
      } while (pageToken !== null);
    }

    return Object.freeze({
      strategy: 'query' as const,
      messageIds: Object.freeze([...ids]),
      latestHistoryId,
      historyCursorInvalid,
      truncated,
    });
  }

  async getMessage(providerMessageId: string): Promise<InboundRawMessage | null> {
    const message = await this.api.getMessage(providerMessageId);
    if (message === null) return null;
    return toInboundRawMessage(message);
  }
}

/** `historyId` est un entier arbitrairement grand : comparé en `BigInt`, jamais en `Number`. */
function isBackwards(previous: string, current: string): boolean {
  try {
    return BigInt(current) < BigInt(previous);
  } catch {
    // Valeurs non numériques : incomparables. Le dire est plus sûr que de
    // supposer qu'elles sont égales.
    return previous !== current;
  }
}

// ---------------------------------------------------------------------------
// Le transport réel
// ---------------------------------------------------------------------------

const GMAIL_BASE_URL = 'https://gmail.googleapis.com/gmail/v1';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_TIMEOUT_MS = 20_000;
/** Marge avant l'expiration annoncée : un jeton qui expire en vol coûte un tour. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

export interface GmailRestApiDeps {
  readonly credentials: GmailCredentials;
  readonly http?: HttpClient;
  readonly timeoutMs?: number;
  readonly baseUrl?: string;
  readonly tokenUrl?: string;
  readonly now?: () => number;
}

/**
 * Le seul objet du dépôt qui parle à Gmail.
 *
 * Deux réglages non négociables sur chaque appel :
 *
 *   * `noCache: true` — ni lecture ni écriture dans `http_cache`. Le corps
 *     d'une réponse porte le texte d'un message privé ; un cache de réponses
 *     HTTP n'a rien à faire avec ça ;
 *   * `attempts: 1` pour l'échange de jeton, bornées pour les lectures. Une
 *     lecture rejouée est sans conséquence, contrairement à un envoi — mais
 *     rien ici ne boucle sans borne.
 *
 * Et une propriété structurelle : `request()` n'accepte que `GET`. Aucun
 * chemin de code de cette classe ne peut émettre autre chose vers Gmail ; le
 * seul `POST` du fichier va au point d'échange de jetons de Google, qui ne
 * touche pas la boîte.
 */
export class GmailRestApi implements GmailApi {
  private readonly credentials: GmailCredentials;
  private readonly http: HttpClient;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly tokenUrl: string;
  private readonly now: () => number;

  private token: { value: string; expiresAtMs: number } | null = null;

  constructor(deps: GmailRestApiDeps) {
    this.credentials = deps.credentials;
    // Sans `sql`, le client n'a même pas de quoi écrire un cache.
    this.http = deps.http ?? new HttpClient();
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.baseUrl = deps.baseUrl ?? GMAIL_BASE_URL;
    this.tokenUrl = deps.tokenUrl ?? GOOGLE_TOKEN_URL;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Échange le jeton de rafraîchissement contre un jeton d'accès.
   *
   * Conforme à la documentation OAuth 2.0 de Google vérifiée le 2026-08-13 :
   * `POST https://oauth2.googleapis.com/token`, corps
   * `client_id` / `client_secret` / `refresh_token` / `grant_type=refresh_token`,
   * réponse `{ access_token, expires_in, scope, token_type }`.
   *
   * La portée accordée est vérifiée à CHAQUE échange, pas seulement au
   * premier : un jeton peut être ré-autorisé plus largement entre deux tours,
   * et une garde qui ne regarde qu'une fois ne garde rien.
   */
  private async accessToken(): Promise<string> {
    const cached = this.token;
    if (cached && cached.expiresAtMs - TOKEN_EXPIRY_MARGIN_MS > this.now()) return cached.value;

    const body = new URLSearchParams({
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
      refresh_token: this.credentials.refreshToken,
      grant_type: 'refresh_token',
    }).toString();

    const response = await this.http.request(this.tokenUrl, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      attempts: 1,
      noCache: true,
      timeoutMs: this.timeoutMs,
    });

    if (!response.ok) {
      // Le corps d'une erreur de jeton peut contenir des fragments de requête.
      // Seul le statut est remonté.
      throw new HttpError(`échange de jeton Gmail refusé (${response.status})`, response.status, this.tokenUrl);
    }

    const parsed = parseJson(response.body);
    const accessToken = readString(parsed, 'access_token');
    if (accessToken === null) throw new HttpError('réponse de jeton Gmail sans access_token', null, this.tokenUrl);

    assertReadOnlyScope(readString(parsed, 'scope') ?? '');

    const expiresIn = readNumber(parsed, 'expires_in') ?? 300;
    this.token = { value: accessToken, expiresAtMs: this.now() + expiresIn * 1000 };
    return accessToken;
  }

  /** Le seul verbe autorisé vers Gmail. Aucune surcharge, aucun paramètre de méthode. */
  private async get(path: string): Promise<{ status: number; body: string }> {
    const token = await this.accessToken();
    const url = `${this.baseUrl}${path}`;
    const response = await this.http.request(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      attempts: 2,
      noCache: true,
      timeoutMs: this.timeoutMs,
    });
    return { status: response.status, body: response.body };
  }

  private get userPath(): string {
    return `/users/${encodeURIComponent(this.credentials.inboxAddress)}`;
  }

  async getProfile(): Promise<GmailProfile> {
    const result = await this.get(`${this.userPath}/profile`);
    if (result.status < 200 || result.status >= 300) {
      throw new HttpError(`lecture du profil Gmail refusée (${result.status})`, result.status, this.baseUrl);
    }
    const parsed = parseJson(result.body);
    return {
      emailAddress: readString(parsed, 'emailAddress') ?? undefined,
      historyId: readString(parsed, 'historyId') ?? undefined,
    };
  }

  async listMessages(params: {
    q: string;
    maxResults: number;
    pageToken: string | null;
  }): Promise<GmailListMessagesResponse> {
    const search = new URLSearchParams({ q: params.q, maxResults: String(params.maxResults) });
    // `includeSpamTrash` reste à sa valeur par défaut (false) : la boîte lue
    // est celle d'un opérateur, et aspirer son spam pour y chercher une réponse
    // ferait entrer en base tout ce qu'un filtre a déjà écarté. Le prix est
    // dit plutôt que caché — une réponse classée en spam ne sera pas vue.
    if (params.pageToken !== null) search.set('pageToken', params.pageToken);

    const result = await this.get(`${this.userPath}/messages?${search.toString()}`);
    if (result.status < 200 || result.status >= 300) {
      throw new HttpError(`liste des messages refusée (${result.status})`, result.status, this.baseUrl);
    }
    const parsed = parseJson(result.body);
    const messages = parsed !== null && typeof parsed === 'object' ? (parsed as { messages?: unknown }).messages : null;
    return {
      messages: Array.isArray(messages) ? (messages as readonly { id?: unknown }[]) : [],
      nextPageToken: readString(parsed, 'nextPageToken') ?? undefined,
    };
  }

  async getMessage(providerMessageId: string): Promise<GmailMessage | null> {
    // `format=full` : en-têtes analysés et parties décodables, sans faire
    // entrer le message RFC 2822 entier en mémoire comme le ferait `raw`.
    const result = await this.get(`${this.userPath}/messages/${encodeURIComponent(providerMessageId)}?format=full`);
    if (result.status === 404) return null;
    if (result.status < 200 || result.status >= 300) {
      throw new HttpError(`lecture du message refusée (${result.status})`, result.status, this.baseUrl);
    }
    const parsed = parseJson(result.body);
    return parsed !== null && typeof parsed === 'object' ? (parsed as GmailMessage) : null;
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

function readString(value: unknown, key: string): string | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function readNumber(value: unknown, key: string): number | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}
