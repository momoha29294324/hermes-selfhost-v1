import { env, envInt, envRequired } from '@/lib/env';
import { HttpClient, HttpError } from '@/lib/http/client';
import { sha256Hex } from '@/lib/util/hash';
import { TimeoutError } from '@/lib/util/retry';
import type { DispatchEnvelope } from '@/lib/pipeline/r6bTransportAdapters';
import { canonicalJson } from '@/lib/pipeline/r6bTransportPayload';

/**
 * R6B-C.2B — l'adapter LIVE email (Resend) et rien d'autre.
 *
 * Ce module est le seul du domaine autorisé à parler à un provider d'envoi. Il
 * ne décide jamais *si* un envoi doit avoir lieu — cette décision appartient à
 * la triple garde de `r6bLiveDispatch` — et il ne fabrique jamais le contenu :
 * destinataire, objet et corps viennent de l'enveloppe figée, la seule chose
 * qu'il ajoute est l'identité d'expéditeur configurée.
 *
 * ---------------------------------------------------------------------------
 * Comportements du provider effectivement vérifiés dans la documentation
 * Resend avant d'écrire ce code (aucun n'est supposé) :
 * ---------------------------------------------------------------------------
 *
 *   * Envoi              — `POST https://api.resend.com/emails`, en-têtes
 *                          `Authorization: Bearer <clé>` et
 *                          `Content-Type: application/json`. Corps :
 *                          `from`, `to`, `subject`, et `html` et/ou `text`,
 *                          `reply_to` optionnel. Réponse 200 : `{ "id": "…" }`.
 *   * Idempotence        — en-tête `Idempotency-Key`, 1 à 256 caractères,
 *                          conservée 24 h (« Idempotency keys are kept in the
 *                          system for 24 hours »). Rejouer la même clé avec le
 *                          même payload : « our API will give the same
 *                          response, without actually sending the email
 *                          again » — donc même `id`, sans réexpédition. Même
 *                          clé + payload différent → 409
 *                          `invalid_idempotent_request`. Même clé pendant que
 *                          la première requête est en vol → 409
 *                          `concurrent_idempotent_requests`, documenté « it is
 *                          safe to retry this request later if needed ».
 *   * Erreurs            — corps `{ statusCode, name, message }`. Noms
 *                          documentés utilisés ici : `validation_error`,
 *                          `missing_api_key`, `invalid_api_key`,
 *                          `restricted_api_key`, `invalid_idempotency_key`,
 *                          `rate_limit_exceeded`, `daily_quota_exceeded`,
 *                          `monthly_quota_exceeded`, `application_error`,
 *                          `internal_server_error`.
 *   * Relecture          — `GET /emails/{id}` renvoie `id`, `to`, `from`,
 *                          `subject`, `created_at`, `last_event` et
 *                          `message_id`. Ce dernier est l'en-tête `Message-ID`
 *                          RFC 5322 réellement présent dans l'email
 *                          (`<111-222-333@email.example.com>`) : il est
 *                          DISTINCT de `id`, l'identifiant interne Resend, et
 *                          aucun des deux ne se dérive de l'autre. C'est
 *                          `message_id`, et lui seul, qu'un `In-Reply-To`
 *                          entrant citera.
 *   * Liste              — `GET /emails?limit=N` (1..100, défaut 20) plus
 *                          `after` / `before` pour la pagination, et RIEN
 *                          d'autre : aucun filtre par destinataire, par objet
 *                          ou par clé d'idempotence n'existe.
 *
 * Les deux dernières primitives n'existent ici que pour la réconciliation
 * (lecture seule). Aucune ne renvoie d'email.
 *
 * Ce que la documentation NE fournit pas, et qui commande toute la stratégie
 * de réconciliation (`r6bLiveDispatch`) : il n'existe aucune primitive pour
 * retrouver un email PAR sa clé d'idempotence. Après un POST dont la réponse
 * n'est jamais revenue, le seul moyen documenté d'apprendre l'identifiant du
 * message est donc de rejouer la requête à l'identique dans les 24 h — ce que
 * le provider garantit sans réexpédition.
 */

const RESEND_BASE_URL = 'https://api.resend.com';
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Adresse acceptée pour l'identité d'expéditeur. Volontairement permissive sur
 * la partie locale, stricte sur l'absence d'espace et la présence d'un TLD —
 * la même forme que celle exigée d'un destinataire email par l'adapter
 * DRY_RUN, pour qu'« adressable » veuille dire la même chose des deux côtés.
 */
const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** `Nom <adresse@exemple.fr>` — la forme que Resend documente pour `from`. */
const NAMED_ADDRESS = /^(?<name>[^<>]+?)\s*<(?<address>[^<>\s]+)>$/;

// ---------------------------------------------------------------------------
// Identité d'expéditeur
// ---------------------------------------------------------------------------

export interface SenderIdentity {
  /** Tel qu'envoyé au provider : `Nom <adresse>` ou `adresse`. */
  readonly from: string;
  readonly replyTo: string;
}

export type SenderIdentityRejection = 'missing' | 'control_characters' | 'malformed';

export type SenderIdentityResult =
  | { readonly ok: true; readonly identity: SenderIdentity }
  | { readonly ok: false; readonly code: SenderIdentityRejection; readonly reason: string };

/**
 * C0, DEL et C1 — tout ce qu'un en-tête SMTP interpréterait comme une fin de
 * champ. Refusé plutôt que nettoyé : nettoyer ferait disparaître une tentative
 * d'injection d'en-tête au lieu de la signaler (même règle que pour l'objet,
 * `validateEmailSubject`).
 */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/** L'adresse nue d'un `from`, que celui-ci porte un nom d'affichage ou non. */
export function extractEmailAddress(value: string): string | null {
  const named = NAMED_ADDRESS.exec(value.trim());
  const candidate = named?.groups?.address ?? value.trim();
  return EMAIL_ADDRESS.test(candidate) ? candidate : null;
}

/**
 * Valide une identité d'expéditeur. Ne la corrige pas et n'en propose aucune :
 * une identité mal formée bloque l'envoi, elle n'est pas rattrapée.
 */
export function validateSenderIdentity(from: unknown, replyTo: unknown): SenderIdentityResult {
  for (const [label, raw] of [
    ['OUTBOUND_EMAIL_FROM', from],
    ['OUTBOUND_EMAIL_REPLY_TO', replyTo],
  ] as const) {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      return { ok: false, code: 'missing', reason: `${label} absent ou vide` };
    }
    if (hasControlCharacter(raw)) {
      return {
        ok: false,
        code: 'control_characters',
        reason: `${label} contient un caractère de contrôle (injection d’en-tête)`,
      };
    }
  }

  const fromValue = (from as string).trim();
  const replyToValue = (replyTo as string).trim();

  if (extractEmailAddress(fromValue) === null) {
    return { ok: false, code: 'malformed', reason: 'OUTBOUND_EMAIL_FROM n’est ni « adresse » ni « Nom <adresse> »' };
  }
  // Le reply-to part tel quel dans l'en-tête : on exige une adresse nue plutôt
  // qu'une forme nommée, pour qu'aucune interprétation ne soit nécessaire.
  if (!EMAIL_ADDRESS.test(replyToValue)) {
    return { ok: false, code: 'malformed', reason: 'OUTBOUND_EMAIL_REPLY_TO n’est pas une adresse email' };
  }

  return { ok: true, identity: Object.freeze({ from: fromValue, replyTo: replyToValue }) };
}

export class SenderIdentityError extends Error {
  readonly code: SenderIdentityRejection;

  constructor(code: SenderIdentityRejection, message: string) {
    super(message);
    this.name = 'SenderIdentityError';
    this.code = code;
  }
}

/**
 * Lit l'identité d'expéditeur configurée. Aucune valeur par défaut : une
 * identité absente est une erreur, jamais une adresse inventée.
 */
export function readSenderIdentity(): SenderIdentity {
  const result = validateSenderIdentity(env('OUTBOUND_EMAIL_FROM'), env('OUTBOUND_EMAIL_REPLY_TO'));
  if (!result.ok) throw new SenderIdentityError(result.code, result.reason);
  return result.identity;
}

// ---------------------------------------------------------------------------
// Le payload exact transmis au provider
// ---------------------------------------------------------------------------

/**
 * Exactement les champs que Resend recevra — pas un de plus. Le type est fermé
 * et l'objet est gelé : ni signature, ni pied de page, ni pixel de suivi, ni
 * variante HTML ne peuvent y être ajoutés sans changer cette interface, donc
 * sans passer par une revue.
 *
 * `text` seul, jamais `html` : réécrire le texte approuvé en HTML serait le
 * transformer, et le manifeste fige le texte mot pour mot.
 */
export interface EmailSendRequest {
  readonly from: string;
  readonly to: string;
  readonly reply_to: string;
  readonly subject: string;
  readonly text: string;
}

export const EMAIL_SEND_REQUEST_FIELDS: readonly string[] = ['from', 'to', 'reply_to', 'subject', 'text'];

export class LiveEmailPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveEmailPayloadError';
  }
}

/**
 * Construit le payload provider à partir de l'enveloppe figée et de la seule
 * identité d'expéditeur. Aucun autre paramètre n'existe : un appelant ne peut
 * fournir ni destinataire, ni objet, ni corps, ni transport.
 *
 * Pur et déterministe : deux appels sur la même enveloppe donnent le même
 * objet, sans horloge, sans aléa, sans réseau.
 */
export function buildEmailSendRequest(envelope: DispatchEnvelope, identity: SenderIdentity): EmailSendRequest {
  if (envelope.transport !== 'email') {
    throw new LiveEmailPayloadError(`adapter email appelé avec une enveloppe « ${envelope.transport} »`);
  }
  const subject = envelope.transportPayload.subject;
  if (typeof subject !== 'string' || subject.length === 0) {
    throw new LiveEmailPayloadError(
      `manifeste ${envelope.manifestId} sans objet approuvé — un objet ne se fabrique pas au moment de l’envoi`,
    );
  }
  if (envelope.approvedText.length === 0) {
    throw new LiveEmailPayloadError(`manifeste ${envelope.manifestId} sans texte approuvé`);
  }

  return Object.freeze({
    from: identity.from,
    to: envelope.recipient,
    reply_to: identity.replyTo,
    subject,
    // Mot pour mot le texte approuvé par un opérateur. Rien n'est concaténé ici :
    // ni signature, ni mention légale, ni lien de désinscription — ajouter
    // quoi que ce soit ferait mentir `approved_text_sha256`.
    text: envelope.approvedText,
  });
}

/**
 * Clé d'idempotence, dérivée déterministement du seul identifiant de
 * manifeste.
 *
 * Pourquoi le manifeste et rien d'autre : un manifeste est immuable (toute
 * correction crée un nouvel identifiant via un supersede), donc « même
 * manifeste » et « même email » sont le même fait. Y mêler une empreinte de
 * payload donnerait au contraire une clé neuve à un contenu altéré — c'est-à-
 * dire exactement la porte que l'idempotence doit fermer.
 *
 * Format `<type>/<id>` recommandé par Resend, 1 à 256 caractères.
 */
export function deriveIdempotencyKey(manifestId: string): string {
  return `r6b-c2b-first-touch-email/${manifestId}`;
}

// ---------------------------------------------------------------------------
// Identité de la requête provider
// ---------------------------------------------------------------------------

/**
 * Durée de vie d'une clé d'idempotence chez Resend : « Idempotency keys are
 * kept in the system for 24 hours ».
 *
 * Elle n'est pas configurable ici. Ce n'est pas un réglage du dépôt mais un
 * fait du provider ; l'allonger par une variable d'environnement ferait
 * rejouer un POST alors que la clé n'est plus honorée — c'est-à-dire enverrait
 * un second email en croyant en relire un premier.
 */
export const PROVIDER_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Forme canonique des cinq champs exacts transmis au provider.
 *
 * Même sérialisation déterministe que `transport_payload_sha256` (clés triées,
 * aucune espace — `canonicalJson`), pour que « même payload logique » veuille
 * dire la même chose partout dans le dépôt.
 *
 * Pourquoi une empreinte de plus alors que `transport_payload_sha256` existe :
 * celle-ci couvre uniquement ce que le manifeste fige, c'est-à-dire l'objet.
 * L'expéditeur et le reply-to viennent de la configuration, pas du manifeste.
 * Deux requêtes au même destinataire, même texte et même objet, mais parties
 * d'un `from` différent sont deux requêtes différentes pour Resend — et
 * l'empreinte du manifeste, elle, ne le verrait pas.
 */
export function canonicalProviderPayload(request: EmailSendRequest): string {
  return canonicalJson({
    from: request.from,
    to: request.to,
    reply_to: request.reply_to,
    subject: request.subject,
    text: request.text,
  });
}

/**
 * Empreinte de la requête provider. C'est elle qui permet d'affirmer — avant
 * de toucher au réseau — qu'un rejeu porte bien le même payload logique que la
 * tentative d'origine, plutôt que de l'espérer.
 */
export function hashProviderPayload(request: EmailSendRequest): string {
  return sha256Hex(canonicalProviderPayload(request));
}

// ---------------------------------------------------------------------------
// Issue d'un appel provider
// ---------------------------------------------------------------------------

/**
 * Trois issues, et la frontière entre elles est la seule chose qui compte :
 *
 *   SENT      — le provider a répondu un identifiant de message. Incontestable.
 *   FAILED    — le provider a refusé la requête d'une manière documentée qui
 *               exclut la création d'un email. Rien n'est parti.
 *   AMBIGUOUS — tout le reste. Un timeout, une coupure, un 5xx, une réponse
 *               illisible ou un conflit d'idempotence peuvent tous suivre une
 *               acceptation côté provider. On ne devine pas : on s'arrête.
 */
export type ProviderSendOutcome =
  | { readonly status: 'SENT'; readonly providerMessageId: string }
  | { readonly status: 'AMBIGUOUS'; readonly failureCode: string; readonly detail: string }
  | { readonly status: 'FAILED'; readonly failureCode: string; readonly detail: string };

/** Ce qui est réellement revenu du transport, avant toute interprétation. */
export type ProviderTransportResult =
  | { readonly kind: 'response'; readonly status: number; readonly body: string }
  /** Le client HTTP a levé sur un statut connu (429 / 5xx) sans lire le corps. */
  | { readonly kind: 'http_error'; readonly status: number | null; readonly message: string }
  /** Timeout, coupure, DNS : la requête est partie, la réponse n'est pas revenue. */
  | { readonly kind: 'transport_error'; readonly message: string };

/**
 * Statuts pour lesquels la documentation Resend garantit que la requête a été
 * rejetée sans qu'aucun email soit créé : erreur de validation, clé d'API
 * absente / invalide / restreinte, clé d'idempotence hors format, ressource
 * inexistante. Rien n'a pu partir, donc un nouvel armement humain peut
 * légitimement retenter.
 */
const DEFINITIVE_REJECTION_STATUSES = new Set([400, 401, 403, 404, 422]);

/** Noms d'erreur 429 documentés comme un refus de traiter la requête. */
const DEFINITIVE_QUOTA_ERRORS = new Set(['rate_limit_exceeded', 'daily_quota_exceeded', 'monthly_quota_exceeded']);

/**
 * Les deux conflits d'idempotence documentés (409). Tous deux ambigus — ils
 * disent qu'une requête portant cette clé existe déjà chez le provider, donc
 * qu'un email a pu être créé — mais ils n'appellent pas la même suite, et
 * `reconcileLiveAttempt` les distingue :
 *
 *   * `concurrent_idempotent_requests` — la première requête est encore en
 *     vol. Documenté « it is safe to retry this request later if needed » :
 *     attendre puis rejouer À L'IDENTIQUE est la conduite recommandée.
 *   * `invalid_idempotent_request` — cette clé a déjà servi avec un payload
 *     DIFFÉRENT. Aucun rejeu ne peut aider : soit la configuration
 *     d'expéditeur a changé sous nos pieds, soit le manifeste a bougé. Resend
 *     suggère « Change your idempotency key or payload » ; suivre ce conseil
 *     ferait partir un second email, donc il n'est pas suivi — un humain
 *     tranche.
 */
export const PROVIDER_CONCURRENT_IDEMPOTENT_REQUEST = 'concurrent_idempotent_requests';
export const PROVIDER_INVALID_IDEMPOTENT_REQUEST = 'invalid_idempotent_request';

interface ResendErrorBody {
  readonly name?: unknown;
  readonly message?: unknown;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

/** Nom d'erreur documenté, ou `null` si le corps n'en porte pas. */
function errorName(body: string): string | null {
  const parsed = parseJson(body);
  if (parsed === null || typeof parsed !== 'object') return null;
  const name = (parsed as ResendErrorBody).name;
  return typeof name === 'string' && name.length > 0 ? name : null;
}

/** Message d'erreur du provider, tronqué. Jamais le corps brut complet. */
function errorDetail(body: string, fallback: string): string {
  const parsed = parseJson(body);
  if (parsed !== null && typeof parsed === 'object') {
    const message = (parsed as ResendErrorBody).message;
    if (typeof message === 'string' && message.length > 0) return message.slice(0, 300);
  }
  return fallback;
}

/**
 * Traduit ce qui est revenu du transport en issue métier. Pure et testable
 * sans réseau — c'est la fonction qui décide si un humain doit être réveillé.
 *
 * Fail-closed par construction : `AMBIGUOUS` est le défaut, et seules les
 * situations explicitement documentées comme « rien n'a été créé » descendent
 * en `FAILED`. Un statut inconnu, une réponse 2xx sans identifiant, un 409
 * d'idempotence : tous ambigus, parce qu'aucun ne prouve qu'aucun email n'est
 * parti.
 */
export function classifySendResult(result: ProviderTransportResult): ProviderSendOutcome {
  if (result.kind === 'transport_error') {
    return {
      status: 'AMBIGUOUS',
      failureCode: 'network_no_response',
      detail: `aucune réponse du provider : ${result.message.slice(0, 300)}`,
    };
  }

  if (result.kind === 'http_error') {
    const status = result.status;
    if (status === 429) {
      return {
        status: 'FAILED',
        failureCode: 'rate_limited',
        detail: 'requête refusée par le provider (429) — aucun email créé',
      };
    }
    return {
      status: 'AMBIGUOUS',
      failureCode: status === null ? 'network_no_response' : `provider_http_${status}`,
      detail: `réponse non concluante du provider : ${result.message.slice(0, 300)}`,
    };
  }

  const { status, body } = result;

  if (status >= 200 && status < 300) {
    const parsed = parseJson(body);
    const id =
      parsed !== null && typeof parsed === 'object' ? (parsed as { readonly id?: unknown }).id : undefined;
    if (typeof id === 'string' && id.trim().length > 0) {
      return { status: 'SENT', providerMessageId: id.trim() };
    }
    // Le provider a accepté (2xx) mais n'a pas dit quoi. Il a très bien pu
    // créer l'email : impossible d'appeler ça un échec.
    return {
      status: 'AMBIGUOUS',
      failureCode: 'provider_response_without_id',
      detail: `réponse ${status} sans identifiant de message exploitable`,
    };
  }

  const name = errorName(body);

  if (DEFINITIVE_REJECTION_STATUSES.has(status)) {
    return {
      status: 'FAILED',
      failureCode: name ?? `provider_http_${status}`,
      detail: errorDetail(body, `requête refusée par le provider (${status})`),
    };
  }

  if (status === 429 && name !== null && DEFINITIVE_QUOTA_ERRORS.has(name)) {
    return {
      status: 'FAILED',
      failureCode: name,
      detail: errorDetail(body, 'quota ou débit dépassé — aucun email créé'),
    };
  }

  // 409 `invalid_idempotent_request` / `concurrent_idempotent_requests` :
  // les deux signalent qu'une requête portant cette clé existe déjà chez le
  // provider — donc qu'un email a pu être créé. Jamais un échec.
  return {
    status: 'AMBIGUOUS',
    failureCode: name ?? `provider_http_${status}`,
    detail: errorDetail(body, `issue non concluante du provider (${status})`),
  };
}

// ---------------------------------------------------------------------------
// Le provider
// ---------------------------------------------------------------------------

/** Une ligne d'email telle que le provider la relit — lecture seule. */
export interface ProviderEmailRecord {
  /** Identifiant interne Resend — celui que `provider_message_id` porte déjà. */
  readonly id: string;
  readonly to: readonly string[];
  /** `from` tel que le provider l'a enregistré. `null` = non exposé, jamais « absent ». */
  readonly from: string | null;
  readonly subject: string | null;
  /**
   * En-tête `Message-ID` RFC 5322 de l'email, chevrons compris — le champ
   * `message_id` de la réponse Resend. DISTINCT de `id` : c'est celui-ci
   * qu'une réponse cite dans `In-Reply-To` / `References`, et le seul qui
   * permette une corrélation entrante par égalité d'identifiant.
   *
   * `null` quand la réponse ne le porte pas : « non observé », jamais une
   * valeur reconstruite.
   */
  readonly rfcMessageId: string | null;
  readonly createdAt: string | null;
  readonly lastEvent: string | null;
}

/**
 * Ce que le dispatcher LIVE attend d'un provider. Trois opérations, dont une
 * seule écrit — les deux autres n'existent que pour réconcilier après coup.
 *
 * L'interface est le point d'injection : `dispatchManifestLive` exige un
 * provider, il n'en construit jamais. Aucun test ne peut donc « oublier » de
 * brancher un faux provider et toucher le vrai réseau par accident : sans
 * provider fourni, rien ne compile.
 */
export interface EmailProvider {
  readonly name: 'resend';
  /** Appelle le provider EXACTEMENT une fois. Ne retente jamais, quoi qu'il arrive. */
  send(request: EmailSendRequest, idempotencyKey: string): Promise<ProviderSendOutcome>;
  /** Lecture seule. `null` si le provider ne connaît pas cet identifiant. */
  retrieve(providerMessageId: string): Promise<ProviderEmailRecord | null>;
  /** Lecture seule — les derniers emails envoyés par ce compte, du plus récent au plus ancien. */
  listRecent(limit: number): Promise<readonly ProviderEmailRecord[]>;
}

function readEmailRecord(value: unknown): ProviderEmailRecord | null {
  if (value === null || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const id = row.id;
  if (typeof id !== 'string' || id.length === 0) return null;
  const to = Array.isArray(row.to) ? row.to.filter((entry): entry is string => typeof entry === 'string') : [];
  // `message_id` est lu tel quel, chevrons compris : c'est la forme sous
  // laquelle un `In-Reply-To` entrant le citera, donc la seule qui se compare
  // sans transformation (voir `parseMessageIds`).
  const rfcMessageId = typeof row.message_id === 'string' ? row.message_id.trim() : '';
  return Object.freeze({
    id,
    to: Object.freeze(to),
    from: typeof row.from === 'string' && row.from.length > 0 ? row.from : null,
    subject: typeof row.subject === 'string' ? row.subject : null,
    rfcMessageId: rfcMessageId.length > 0 ? rfcMessageId : null,
    createdAt: typeof row.created_at === 'string' ? row.created_at : null,
    lastEvent: typeof row.last_event === 'string' ? row.last_event : null,
  });
}

export interface ResendProviderDeps {
  readonly apiKey: string;
  readonly http?: HttpClient;
  readonly timeoutMs?: number;
  readonly baseUrl?: string;
}

/**
 * L'implémentation Resend. Passe par `HttpClient` (timeout borné, limite de
 * débit par hôte) comme tout accès réseau du dépôt, avec deux réglages non
 * négociables :
 *
 *   * `attempts: 1` — aucune retentative, jamais. Une requête d'envoi rejouée
 *     après un timeout est exactement le scénario du double envoi ; la clé
 *     d'idempotence est une ceinture, pas une autorisation de retenter.
 *   * `noCache: true` — ni lecture ni écriture dans `http_cache` : le corps
 *     d'une requête d'envoi porte le texte et l'adresse d'un prospect, et un
 *     cache de réponses n'a rien à voir avec un envoi.
 */
export class ResendProvider implements EmailProvider {
  readonly name = 'resend' as const;

  private readonly apiKey: string;
  private readonly http: HttpClient;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(deps: ResendProviderDeps) {
    if (deps.apiKey.trim().length === 0) throw new Error('RESEND_API_KEY vide');
    this.apiKey = deps.apiKey;
    // Sans `sql`, le client n'a même pas de quoi écrire un cache.
    this.http = deps.http ?? new HttpClient();
    this.timeoutMs = deps.timeoutMs ?? envInt('OUTBOUND_EMAIL_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
    this.baseUrl = deps.baseUrl ?? RESEND_BASE_URL;
  }

  /** Construit la clé depuis l'environnement. Le seul endroit du dépôt qui lit `RESEND_API_KEY`. */
  static fromEnv(deps: Omit<ResendProviderDeps, 'apiKey'> = {}): ResendProvider {
    return new ResendProvider({ ...deps, apiKey: envRequired('RESEND_API_KEY') });
  }

  private headers(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${this.apiKey}`,
      accept: 'application/json',
      ...extra,
    };
  }

  async send(request: EmailSendRequest, idempotencyKey: string): Promise<ProviderSendOutcome> {
    if (idempotencyKey.length < 1 || idempotencyKey.length > 256) {
      // Refusé ici plutôt que côté provider : une clé hors format ferait
      // repartir la requête sans protection d'idempotence.
      throw new LiveEmailPayloadError(`clé d'idempotence hors format (1 à 256 caractères) : ${idempotencyKey.length}`);
    }

    const result = await this.attempt(`${this.baseUrl}/emails`, {
      method: 'POST',
      body: JSON.stringify(request),
      headers: this.headers({ 'content-type': 'application/json', 'idempotency-key': idempotencyKey }),
    });
    return classifySendResult(result);
  }

  async retrieve(providerMessageId: string): Promise<ProviderEmailRecord | null> {
    const encoded = encodeURIComponent(providerMessageId);
    const result = await this.attempt(`${this.baseUrl}/emails/${encoded}`, { headers: this.headers() });
    if (result.kind !== 'response') {
      throw new HttpError(`relecture non concluante : ${result.kind}`, null, `${this.baseUrl}/emails/${encoded}`);
    }
    if (result.status === 404) return null;
    if (result.status < 200 || result.status >= 300) {
      throw new HttpError(`relecture refusée (${result.status})`, result.status, `${this.baseUrl}/emails/${encoded}`);
    }
    return readEmailRecord(parseJson(result.body));
  }

  async listRecent(limit: number): Promise<readonly ProviderEmailRecord[]> {
    // 1..100 documenté ; borné ici plutôt que renvoyé au provider en erreur.
    const bounded = Math.min(100, Math.max(1, Math.trunc(limit)));
    const url = `${this.baseUrl}/emails?limit=${bounded}`;
    const result = await this.attempt(url, { headers: this.headers() });
    if (result.kind !== 'response' || result.status < 200 || result.status >= 300) {
      throw new HttpError('liste des envois non concluante', result.kind === 'response' ? result.status : null, url);
    }
    const parsed = parseJson(result.body);
    const data = parsed !== null && typeof parsed === 'object' ? (parsed as { readonly data?: unknown }).data : null;
    if (!Array.isArray(data)) return [];
    return Object.freeze(
      data.map((entry) => readEmailRecord(entry)).filter((row): row is ProviderEmailRecord => row !== null),
    );
  }

  /**
   * Un appel, un seul, et une description honnête de ce qui en est revenu. Ne
   * classe rien : distinguer « refusé » d'« inconnu » est le travail de
   * `classifySendResult`, qui doit rester testable sans réseau.
   */
  private async attempt(
    url: string,
    options: { method?: 'GET' | 'POST'; body?: string; headers: Record<string, string> },
  ): Promise<ProviderTransportResult> {
    try {
      const response = await this.http.request(url, {
        method: options.method ?? 'GET',
        ...(options.body === undefined ? {} : { body: options.body }),
        headers: options.headers,
        attempts: 1,
        noCache: true,
        timeoutMs: this.timeoutMs,
      });
      return { kind: 'response', status: response.status, body: response.body };
    } catch (error) {
      if (error instanceof HttpError) {
        return { kind: 'http_error', status: error.status, message: error.message };
      }
      if (error instanceof TimeoutError) {
        return { kind: 'transport_error', message: error.message };
      }
      return { kind: 'transport_error', message: error instanceof Error ? error.message : String(error) };
    }
  }
}
