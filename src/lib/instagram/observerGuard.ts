import { classifyInstagramRequest, type GuardedRequest } from '@/lib/instagram/readOnlyGuard';

/**
 * R7.3C §7 — la garde réseau de l'OBSERVER : la lecture seule du dépôt, plus
 * trois refus qu'elle ne portait pas.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi ne pas simplement réutiliser `classifyInstagramRequest`
 * ---------------------------------------------------------------------------
 * On la réutilise — littéralement, par délégation, et c'est délibéré : deux
 * implémentations de « lecture seule » finiraient par diverger, et celle qui
 * diverge est toujours la plus récente, donc la moins relue. Ce module n'en
 * réécrit pas une ligne. Il AJOUTE, en amont, ce que l'observation demande de
 * plus que le rail d'identité :
 *
 *   1. **Les surfaces de story.** Ouvrir une story ou un « à la une » produit
 *      une VUE — un effet visible par le prospect, qui n'est ni un message ni
 *      une mutation et qu'aucune denylist d'écriture n'attrape. Le §18 de la
 *      mission interdit d'y cliquer ; cette garde interdit que la requête parte,
 *      ce qui est une propriété plus forte que la discipline de l'appelant.
 *   2. **Les surfaces de notification.** Lire la boîte de notifications n'a
 *      aucune raison d'exister ici, et la marquer comme lue est une écriture
 *      d'état sur NOTRE compte.
 *   3. **L'hôte des points d'entrée POST.** La lecture seule autorise
 *      `POST /api/graphql` parce qu'Instagram y sert ses lectures. Ce chemin
 *      n'appartient pourtant pas à Instagram : `graph.facebook.com` l'expose
 *      aussi, et R7.3C interdit tout appel Meta Graph. L'autorisation est donc
 *      restreinte aux hôtes Instagram.
 *
 * ---------------------------------------------------------------------------
 * Ce que POST ne prouve pas
 * ---------------------------------------------------------------------------
 * La mission insiste, et elle a raison : Instagram transporte ses LECTURES en
 * POST. Refuser tout POST rendrait la page vide, donc l'observation impossible,
 * et pousserait à contourner la garde ailleurs. Ce qui décide n'est donc pas la
 * méthode mais l'OPÉRATION — un corps portant `mutation`, `direct_v2` ou un
 * marqueur de messagerie est refusé, un corps de lecture passe. Tout le reste,
 * y compris ce que personne n'a encore vu, est refusé par défaut.
 *
 * Cette garde ne masque rien, ne falsifie aucune empreinte et ne fait passer
 * aucune requête pour une autre. Elle en SUPPRIME — l'inverse d'un contournement.
 */

/** Hôtes sur lesquels une lecture transportée en POST est tolérée. */
const INSTAGRAM_HOSTS: readonly string[] = ['www.instagram.com', 'instagram.com', 'i.instagram.com'];

/**
 * Surfaces dont l'ouverture produit une VUE chez le prospect.
 *
 * Refusées quelle que soit la méthode, y compris en GET : c'est le point. Une
 * story vue est un effet externe, et un effet externe ne se rattrape pas.
 */
const STORY_SURFACE_PREFIXES: readonly string[] = [
  '/api/v1/feed/reels_media/',
  '/api/v1/feed/reels_tray/',
  '/api/v1/feed/user/', // …/story/ — le préfixe couvre la famille entière
  '/api/v1/stories/',
  '/stories/',
];

/** Surfaces de notification — ni utiles ici, ni sans effet d'état. */
const NOTIFICATION_SURFACE_PREFIXES: readonly string[] = [
  '/api/v1/news/',
  '/api/v1/notifications/',
  '/accounts/activity/',
];

/**
 * Les chemins que la lecture seule autorise hors GET. Recopiés ici pour une
 * seule raison : décider si l'exception d'hôte s'applique. La décision finale
 * reste rendue par `classifyInstagramRequest`.
 */
const POST_READ_PATHS: readonly string[] = ['/api/graphql', '/graphql/query', '/ajax/bulk-route-definitions/'];

export type ObserverGuardRule =
  | 'read_method'
  | 'read_only_endpoint'
  | 'effect_path'
  | 'write_method'
  | 'graphql_effect'
  | 'graphql_direct_send'
  | 'story_surface'
  | 'notification_surface'
  | 'foreign_host_write';

export type ObserverGuardDecision =
  | { readonly allowed: true; readonly rule: 'read_method' | 'read_only_endpoint' }
  | { readonly allowed: false; readonly rule: ObserverGuardRule; readonly reason: string };

function parseUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

export function classifyObserverRequest(request: GuardedRequest): ObserverGuardDecision {
  const url = parseUrl(request.url);
  if (url === null) {
    return { allowed: false, rule: 'write_method', reason: `URL illisible : « ${request.url} »` };
  }
  const path = url.pathname.toLowerCase();
  const method = request.method.toUpperCase();

  const story = STORY_SURFACE_PREFIXES.find((prefix) => path.startsWith(prefix));
  if (story !== undefined) {
    return {
      allowed: false,
      rule: 'story_surface',
      reason: `surface de story « ${story} » — l’ouvrir produirait une vue chez le prospect, quelle que soit la méthode`,
    };
  }

  const notification = NOTIFICATION_SURFACE_PREFIXES.find((prefix) => path.startsWith(prefix));
  if (notification !== undefined) {
    return {
      allowed: false,
      rule: 'notification_surface',
      reason: `surface de notification « ${notification} » — hors de ce que l’observation d’un profil demande`,
    };
  }

  /**
   * L'exception « lecture en POST » ne vaut que chez Instagram.
   *
   * `/api/graphql` existe aussi chez Meta, et R7.3C tient Meta Graph pour
   * abandonné (§3). Sans ce garde, une requête vers `graph.facebook.com`
   * emprunterait l'autorisation écrite pour Instagram.
   */
  if (method !== 'GET' && method !== 'HEAD') {
    const postRead = POST_READ_PATHS.some((prefix) => path.startsWith(prefix));
    if (postRead && !INSTAGRAM_HOSTS.includes(url.hostname.toLowerCase())) {
      return {
        allowed: false,
        rule: 'foreign_host_write',
        reason: `${method} ${url.hostname}${path} — l’exception de lecture en POST ne vaut que sur un hôte Instagram`,
      };
    }
  }

  const base = classifyInstagramRequest(request);
  if (base.allowed) {
    // `classifyInstagramRequest` ne rend jamais `graphql_direct_send` : cette
    // règle appartient au rail d'envoi, qui n'est pas celui-ci. Le garde est
    // néanmoins écrit, parce qu'une évolution amont ne doit pas pouvoir ouvrir
    // silencieusement une porte ici.
    if (base.rule === 'graphql_direct_send') {
      return {
        allowed: false,
        rule: 'graphql_direct_send',
        reason: 'opération d’envoi de message direct — jamais autorisée en observation',
      };
    }
    return { allowed: true, rule: base.rule };
  }
  return { allowed: false, rule: base.rule, reason: base.reason };
}

/**
 * R7.3C §5/§8 — les URL vers lesquelles l'observer accepte de naviguer.
 *
 * Une page de profil, et rien d'autre. Ni racine, ni exploration, ni recherche,
 * et surtout ni `/direct/` sous aucune forme : la liste blanche du rail
 * d'identité tolérait la racine pour vérifier une session, ce que l'observation
 * n'a pas à faire — elle ouvre un profil nommé ou elle n'ouvre rien.
 *
 * Une liste blanche de navigation EN PLUS de la garde réseau, parce que les deux
 * répondent à des questions différentes : la garde empêche une requête d'effet
 * de sortir, celle-ci empêche le navigateur d'aller se placer devant une surface
 * où un geste accidentel aurait un sens.
 */
export function isAllowedObserverNavigation(rawUrl: string): boolean {
  const url = parseUrl(rawUrl);
  if (url === null) return false;
  if (url.protocol !== 'https:') return false;
  if (url.hostname !== 'www.instagram.com') return false;
  if (url.search.length > 0 || url.hash.length > 0) return false;
  const path = url.pathname;
  if (!/^\/[A-Za-z0-9._]{1,30}\/$/.test(path)) return false;
  const lower = path.toLowerCase();
  const reserved = ['/direct/', '/explore/', '/accounts/', '/stories/', '/reels/', '/p/', '/challenge/'];
  return !reserved.some((prefix) => lower.startsWith(prefix));
}
