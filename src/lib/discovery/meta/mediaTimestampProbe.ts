import {
  instagramBusinessDiscoveryAccess,
  META_GRAPH_BASE,
  metaCredentials,
  type MetaCredentials,
  type SourceAccessState,
} from '@/lib/discovery/meta/access';
import { classifyGraphError } from '@/lib/discovery/meta/pagesSearch';
import { normalizeInstagramHandle } from '@/lib/identity/normalize';
import type { HttpClient } from '@/lib/http/client';

/**
 * R7.3B §13 — `media{timestamp}` est-il réellement disponible ?
 *
 * ---------------------------------------------------------------------------
 * La question, et pourquoi elle n'a pas de réponse documentaire
 * ---------------------------------------------------------------------------
 * La spec R7.3 fait de `last_post_at` et `posting_cadence` le minimum vital des
 * signaux Instagram. Les deux exigent une DATE par publication, donc l'arête
 * `media{timestamp}` sous l'expansion `business_discovery`. Or la référence Meta
 * énumère les champs publics d'un IG User tiers — `biography`, `followers_count`,
 * `id`, `media_count`, `username`, `website` — sans jamais statuer clairement sur
 * ce que rend l'arête `media` d'un compte qui ne nous appartient pas.
 *
 * Trois issues sont donc également plausibles, et le §13 interdit d'en supposer
 * une : l'arête peut être servie avec `timestamp`, servie sans, ou refusée. Ce
 * module ne devine pas — il POSE la question, une fois, dès qu'un jeton existe,
 * et archive la réponse datée.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce module refuse de faire
 * ---------------------------------------------------------------------------
 *   - **aucun appel sans identifiants.** `not_configured` est rendu AVANT toute
 *     construction d'URL, comme le fait déjà `enrichKnownUsername` ;
 *   - **aucune découverte.** Le username sondé est fourni par l'appelant et doit
 *     être un compte professionnel déjà connu. Sonder une liste de usernames
 *     devinés serait de l'énumération, ce que le rail s'interdit (gate §7) ;
 *   - **aucune écriture.** La sonde rend un verdict, elle ne l'enregistre pas et
 *     ne produit aucune `prospect_evidence` : établir qu'une arête existe n'est
 *     pas observer un prospect ;
 *   - **aucun optimisme.** Un compte sans publication ne prouve rien, et le
 *     verdict est alors `UNKNOWN` et non `UNSUPPORTED` : l'arête peut être
 *     parfaitement servie et simplement vide.
 */

/**
 * Le vocabulaire du verdict.
 *
 * `UNKNOWN` n'est pas un échec de la sonde : c'est le cas où l'appel a abouti
 * sans que la réponse tranche — compte introuvable, aucune publication, limite
 * de débit. Le confondre avec `UNSUPPORTED` transformerait un silence en refus,
 * ce qu'interdit la règle 2.
 */
export type MediaTimestampSupport = 'SUPPORTED' | 'UNSUPPORTED' | 'PERMISSION_DENIED' | 'NOT_CONFIGURED' | 'UNKNOWN';

export interface MediaTimestampProbeResult {
  readonly support: MediaTimestampSupport;
  /** Une phrase : ce que la réponse a dit, et ce qu'on en conclut. */
  readonly detail: string;
  /** La chaîne `fields` exacte qui a été demandée — `null` si aucun appel n'a eu lieu. */
  readonly requestedFields: string | null;
  /** Version de l'API interrogée, pour qu'un verdict archivé reste daté et situé. */
  readonly graphVersion: string;
  /** Le compte sondé, ou `null` quand rien n'a été demandé. */
  readonly probedUsername: string | null;
  /** `media_count` observé, quand la réponse l'a rendu. Sert à lire un `UNKNOWN`. */
  readonly mediaCount: number | null;
  /** Nombre de médias rendus par l'arête. `null` quand l'arête est absente. */
  readonly mediaReturned: number | null;
  /** Combien d'entre eux portaient un `timestamp` lisible. */
  readonly withTimestamp: number | null;
  /** Ce que la sonde autorise à dériver — vide sauf en `SUPPORTED`. */
  readonly unlockedSignals: readonly string[];
  /** Code d'erreur Graph, quand il y en a eu un. */
  readonly graphErrorCode: number | null;
  /** État d'accès au moment de la sonde. Publié pour qu'un `NOT_CONFIGURED` s'explique. */
  readonly access: SourceAccessState;
}

/**
 * Les champs demandés par la sonde.
 *
 * `media_count` est demandé À CÔTÉ de l'arête, et c'est ce qui rend le verdict
 * lisible : sans lui, une arête vide et une arête refusée se ressemblent. Avec
 * lui, « 340 publications annoncées, arête absente » et « 0 publication, arête
 * absente » se distinguent — le premier est un `UNSUPPORTED`, le second un
 * `UNKNOWN`.
 */
export function mediaTimestampFields(username: string, limit: number): string {
  return `business_discovery.username(${username}){id,username,media_count,media.limit(${limit}){id,timestamp}}`;
}

interface GraphMedia {
  id?: string;
  timestamp?: string;
}

interface GraphBusinessDiscoveryWithMedia {
  id?: string;
  username?: string;
  media_count?: number;
  media?: { data?: GraphMedia[] };
}

interface GraphProbeResponse {
  business_discovery?: GraphBusinessDiscoveryWithMedia;
  error?: { message?: string; code?: number };
}

/**
 * Graph a-t-il dit « ce champ n'existe pas » ?
 *
 * Meta rend cela en code 100 avec un message de la famille « Tried accessing
 * nonexisting field ». C'est le seul cas où une erreur signifie `UNSUPPORTED` et
 * non `UNKNOWN` : toutes les autres disent qu'on n'a pas obtenu de réponse, pas
 * que la réponse est non.
 */
function readsAsUnknownField(message: string): boolean {
  const lowered = message.toLowerCase();
  return (
    lowered.includes('nonexisting field') ||
    lowered.includes('non-existing field') ||
    lowered.includes('unknown field') ||
    lowered.includes('cannot be used') ||
    lowered.includes('unsupported get request')
  );
}

/**
 * Le verdict, déduit d'une réponse Graph et de rien d'autre.
 *
 * Pur et exporté séparément du client : c'est ce qui permet de tester les six
 * formes de réponse sans jeton, sans réseau et sans compte Instagram — donc de
 * livrer la sonde VÉRIFIÉE avant d'avoir les identifiants, plutôt que de livrer
 * du code dont personne ne sait ce qu'il fera le jour où il servira.
 */
export function classifyMediaTimestampResponse(
  raw: string,
  httpStatus: number,
  context: { readonly requestedFields: string; readonly graphVersion: string; readonly probedUsername: string; readonly access: SourceAccessState },
): MediaTimestampProbeResult {
  const base = {
    requestedFields: context.requestedFields,
    graphVersion: context.graphVersion,
    probedUsername: context.probedUsername,
    access: context.access,
    mediaCount: null,
    mediaReturned: null,
    withTimestamp: null,
    unlockedSignals: [] as readonly string[],
    graphErrorCode: null as number | null,
  };

  let payload: GraphProbeResponse;
  try {
    payload = JSON.parse(raw) as GraphProbeResponse;
  } catch {
    return { ...base, support: 'UNKNOWN', detail: `réponse Graph illisible (HTTP ${httpStatus}) — la question reste ouverte` };
  }

  if (payload.error) {
    const message = payload.error.message ?? 'erreur Graph sans message';
    const error = classifyGraphError(payload.error.code ?? null, message);
    const withCode = { ...base, graphErrorCode: error.code };
    if (error.kind === 'permission_denied' || error.kind === 'invalid_token') {
      return {
        ...withCode,
        support: 'PERMISSION_DENIED',
        detail: `Graph a refusé l’appel (${error.kind}, code ${error.code ?? '—'}) : ${message}`,
      };
    }
    if (error.kind === 'api_error' && readsAsUnknownField(message)) {
      return {
        ...withCode,
        support: 'UNSUPPORTED',
        detail: `Graph déclare le champ inconnu sur ce nœud : ${message}. « last_post_at » et « posting_cadence » restent hors d’atteinte.`,
      };
    }
    return {
      ...withCode,
      support: 'UNKNOWN',
      detail: `Graph a rendu une erreur qui ne tranche pas (${error.kind}, code ${error.code ?? '—'}) : ${message}`,
    };
  }

  const discovery = payload.business_discovery;
  if (discovery === undefined || discovery.username === undefined) {
    return {
      ...base,
      support: 'UNKNOWN',
      detail:
        `le compte « ${context.probedUsername} » n’a rien rendu (inexistant, privé, ou non professionnel) — ` +
        'la sonde n’a pas pu poser sa question, il faut un autre compte cible',
    };
  }

  const mediaCount = typeof discovery.media_count === 'number' ? discovery.media_count : null;
  const media = discovery.media?.data;

  if (media === undefined) {
    // L'arête n'a pas été servie. Un compte sans publication ne le prouve pas.
    if (mediaCount === null || mediaCount === 0) {
      return {
        ...base,
        mediaCount,
        support: 'UNKNOWN',
        detail:
          `l’arête « media » est absente et le compte annonce ${mediaCount === null ? 'un nombre inconnu de' : '0'} ` +
          'publication(s) : une arête vide et une arête refusée se ressemblent ici. Sonder un compte qui publie.',
      };
    }
    return {
      ...base,
      mediaCount,
      support: 'UNSUPPORTED',
      detail:
        `le compte annonce ${mediaCount} publication(s) et l’arête « media » n’a rien rendu : ` +
        'elle n’est pas servie sur une cible tierce via business_discovery',
    };
  }

  const withTimestamp = media.filter((item) => typeof item.timestamp === 'string' && item.timestamp.length > 0).length;

  if (media.length === 0) {
    return {
      ...base,
      mediaCount,
      mediaReturned: 0,
      withTimestamp: 0,
      support: 'UNKNOWN',
      detail:
        'l’arête « media » a été servie mais vide : elle existe, et rien ne dit encore si elle porte ' +
        '« timestamp ». Sonder un compte qui publie.',
    };
  }

  if (withTimestamp === 0) {
    return {
      ...base,
      mediaCount,
      mediaReturned: media.length,
      withTimestamp: 0,
      support: 'UNSUPPORTED',
      detail:
        `${media.length} média(s) rendus, aucun ne porte « timestamp » : le champ est silencieusement retiré. ` +
        '« last_post_at » et « posting_cadence » restent UNKNOWN de plein droit.',
    };
  }

  return {
    ...base,
    mediaCount,
    mediaReturned: media.length,
    withTimestamp,
    support: 'SUPPORTED',
    detail: `${withTimestamp}/${media.length} média(s) portent un « timestamp » lisible sur une cible tierce`,
    /**
     * Et RIEN d'autre. `posting_cadence` se dérive de plusieurs dates, jamais de
     * `media_count` (§14) ; `follower_count` et la maturité visuelle ne sont pas
     * dans cette réponse et ne le deviennent pas parce qu'un timestamp existe.
     */
    unlockedSignals: ['last_post_at', 'posting_cadence'],
  };
}

export interface MediaTimestampProbeOptions {
  readonly http: HttpClient;
  readonly credentials?: MetaCredentials;
  readonly access?: SourceAccessState;
  /** Nombre de médias demandés. Petit par défaut : la sonde répond oui ou non, elle ne collecte pas. */
  readonly limit?: number;
}

/**
 * Sonde `media{timestamp}` sur un compte professionnel déjà connu.
 *
 * Rend `NOT_CONFIGURED` sans émettre une seule requête quand le jeton ou
 * l'identifiant de compte manquent — c'est la garantie que le §16 exige : sans
 * identifiants, zéro appel Meta réel.
 */
export async function probeMediaTimestamp(
  knownUsername: string,
  options: MediaTimestampProbeOptions,
): Promise<MediaTimestampProbeResult> {
  const credentials = options.credentials ?? metaCredentials();
  const access = options.access ?? instagramBusinessDiscoveryAccess(credentials);
  const limit = options.limit ?? 5;

  if (access.status !== 'available') {
    return {
      support: 'NOT_CONFIGURED',
      detail:
        `accès « ${access.source} » en ${access.status} — aucun appel n’a été émis` +
        (access.requirement === null ? '' : `. Requis : ${access.requirement}`),
      requestedFields: null,
      graphVersion: credentials.graphVersion,
      probedUsername: null,
      mediaCount: null,
      mediaReturned: null,
      withTimestamp: null,
      unlockedSignals: [],
      graphErrorCode: null,
      access,
    };
  }

  const username = normalizeInstagramHandle(knownUsername);
  if (username === null || username.length === 0) {
    return {
      support: 'UNKNOWN',
      detail:
        `« ${knownUsername} » n’est pas un username exploitable. Business Discovery n’énumère rien : ` +
        'la sonde exige un compte professionnel déjà observé ailleurs.',
      requestedFields: null,
      graphVersion: credentials.graphVersion,
      probedUsername: null,
      mediaCount: null,
      mediaReturned: null,
      withTimestamp: null,
      unlockedSignals: [],
      graphErrorCode: null,
      access,
    };
  }

  const fields = mediaTimestampFields(username, limit);
  const params = new URLSearchParams({ fields, access_token: credentials.accessToken ?? '' });
  const url = `${META_GRAPH_BASE}/${credentials.graphVersion}/${credentials.igUserId}?${params.toString()}`;

  const response = await options.http.get(url, { timeoutMs: 20_000, attempts: 2, noCache: true });
  return classifyMediaTimestampResponse(response.body, response.status, {
    requestedFields: fields,
    graphVersion: credentials.graphVersion,
    probedUsername: username,
    access,
  });
}
