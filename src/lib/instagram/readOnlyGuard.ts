/**
 * IG-R1 §6 — la garde réseau du rail : lecture seule, appliquée à l'octet près.
 *
 * Pourquoi cette couche existe alors que `InstagramReadOnlyRail` n'expose
 * aucune méthode capable d'agir : parce qu'un navigateur pilotable n'est pas un
 * client HTTP. Un `page.goto` charge une application React complète, qui peut
 * émettre des requêtes que personne n'a écrites, et une frappe accidentelle
 * (ou un futur diff imprudent) resterait un simple appel Playwright.
 *
 * Cette garde répond donc à une question différente de celle du contrat de
 * type : non pas « le worker peut-il demander un envoi ? » (non — la méthode
 * n'existe pas) mais « une requête produisant un effet chez Instagram peut-elle
 * seulement SORTIR de ce processus ? ». La réponse est non, et elle ne dépend
 * d'aucune discipline d'appelant.
 *
 * Deux règles, dans cet ordre :
 *
 *   1. **Denylist d'effets** — les chemins qui envoient un DM, commentent,
 *      suivent, aiment ou modifient un profil sont refusés QUELLE QUE SOIT la
 *      méthode HTTP. Une denylist par chemin est ici plus sûre qu'un filtre par
 *      méthode : elle bloque aussi une navigation directe vers `/direct/`.
 *   2. **Défaut fermé sur toute écriture** — hors GET/HEAD, seule une courte
 *      liste de points d'entrée strictement lecture est autorisée, parce
 *      qu'Instagram sert ses lectures en POST (`/api/graphql`). Tout le reste
 *      est refusé sans avoir à être nommé, y compris ce que personne n'a encore
 *      inventé.
 *
 * Ce que cette garde n'est pas : une technique d'évitement. Elle ne masque
 * rien, ne falsifie aucune empreinte, ne fait passer aucune requête pour une
 * autre. Elle en supprime — c'est l'inverse exact d'un contournement.
 */

/** Chemins dont l'appel produit un effet chez Instagram. Refusés, toutes méthodes confondues. */
const EFFECT_PATH_PREFIXES: readonly string[] = [
  // Messages directs — la raison d'être de cette liste.
  '/api/v1/direct_v2/',
  '/api/v1/direct/',
  '/direct/',
  // Commentaires.
  '/api/v1/web/comments/',
  '/api/v1/media/',
  // Abonnements.
  '/api/v1/friendships/',
  '/api/v1/web/friendships/',
  // Mentions « j'aime » et enregistrements.
  '/api/v1/web/likes/',
  '/api/v1/web/save/',
  // Modification du compte utilisé.
  '/api/v1/accounts/edit',
  '/api/v1/accounts/set_biography',
  '/api/v1/accounts/change_profile_picture',
  '/accounts/edit',
  // Signalements et blocages.
  '/api/v1/web/blocks/',
  '/api/v1/users/report',
];

/**
 * Les seuls chemins non-GET tolérés : Instagram sert ses LECTURES en POST.
 * Interdire tout POST rendrait la page blanche — donc inexploitable pour
 * vérifier une identité, qui est le seul but du rail.
 */
const READ_ONLY_WRITE_METHOD_PATHS: readonly string[] = ['/api/graphql', '/graphql/query', '/ajax/bulk-route-definitions/'];

/**
 * Ce qui, dans le corps d'une requête GraphQL, trahit autre chose qu'une
 * lecture. Instagram nomme ses opérations dans `fb_api_req_friendly_name` ;
 * une opération d'écriture y porte `Mutation`, et toute opération de messagerie
 * porte `direct`. Les deux sont refusées.
 *
 * Volontairement conservateur : refuser une lecture par excès de prudence rend
 * la page incomplète (échec visible, fail-closed), tandis que laisser passer
 * une mutation produirait un effet irréversible chez un prospect.
 */
const GRAPHQL_EFFECT_MARKERS: readonly RegExp[] = [/mutation/i, /direct_v2/i, /\bdirect[A-Za-z]*(send|thread|message)/i];

export interface GuardedRequest {
  readonly url: string;
  readonly method: string;
  /** Corps de la requête, si Playwright a pu le lire. `null` compte comme illisible, pas comme vide. */
  readonly postData: string | null;
}

export type GuardDecision =
  | { readonly allowed: true; readonly rule: 'read_method' | 'read_only_endpoint' | 'graphql_direct_send' }
  | { readonly allowed: false; readonly rule: 'effect_path' | 'write_method' | 'graphql_effect'; readonly reason: string };

/**
 * Le nom d'opération qu'Instagram met dans ses corps de requête, s'il y est.
 *
 * Il vit ici, et non dans la trace, depuis IG2.7 : ce n'est plus seulement une
 * étiquette de diagnostic, c'est la valeur sur laquelle une DÉCISION se prend.
 * L'alphabet capturé est volontairement sans séparateur — le motif ne peut pas
 * déborder sur le reste du corps, donc il ne peut pas ramener de payload.
 */
export function readFriendlyName(postData: string | null): string | null {
  if (postData === null) return null;
  const match = /fb_api_req_friendly_name=([A-Za-z0-9_.-]{1,120})/.exec(postData);
  if (match?.[1] !== undefined) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
  const json = /"fb_api_req_friendly_name"\s*:\s*"([A-Za-z0-9_.-]{1,120})"/.exec(postData);
  return json?.[1] ?? null;
}

/**
 * IG2.7 — les opérations GraphQL nommément autorisées, et le chemin sur lequel
 * elles le sont. Uniquement pour le rail LIVE DM.
 *
 * IG2.6 a observé la cause racine plutôt que de la supposer : 45 ms après le
 * clic, notre propre garde refusait `POST /api/graphql` portant
 * `IGDirectTextSendMutation`, sous la règle `graphql_effect`. La requête d'envoi
 * du DM ne sortait pas du processus. Le rail n'était pas détecté ; il se
 * bloquait lui-même.
 *
 * Pourquoi une ÉGALITÉ et non une regex élargie
 * ---------------------------------------------
 * Le correctif évident — retirer la frontière de mot de
 * `\bdirect[A-Za-z]*(send|thread|message)` — aurait marché, et aurait ouvert
 * bien plus que ce qu'on a mesuré : toute opération dont le nom contient
 * `direct…send`, `direct…thread` ou `direct…message`, y compris celles que
 * personne n'a encore vues. Une égalité de chaîne n'autorise que ce qui est
 * écrit ici. Ce que la mesure a montré, et rien de plus.
 *
 * Ce qui reste refusé, délibérément
 * ---------------------------------
 * `useIGDMarkThreadAsReadMutation` et sa validation ont été refusées dans la
 * même seconde, et elles le restent : marquer un fil comme lu est une écriture
 * d'état, pas une remise de message. Les deux capacités sont distinctes et le
 * moindre privilège demande de les tenir séparées — si l'envoi fonctionne sans
 * elles, elles n'ont aucune raison d'être accordées.
 */
export const LIVE_DM_GRAPHQL_PATH = '/api/graphql';
export const LIVE_DM_ALLOWED_GRAPHQL_OPERATIONS: readonly string[] = ['IGDirectTextSendMutation'];

/**
 * L'opération est-elle nommément autorisée sur ce chemin ?
 *
 * Comparaison exacte et sensible à la casse : `IGDirectTextSendMutationFoo`,
 * `NotIGDirectTextSendMutation` et `igdirecttextsendmutation` sont trois noms
 * différents de celui qu'on a observé, donc trois refus.
 */
function isAllowedLiveDmOperation(path: string, postData: string | null): boolean {
  if (path !== LIVE_DM_GRAPHQL_PATH) return false;
  const friendlyName = readFriendlyName(postData);
  if (friendlyName === null) return false;
  return LIVE_DM_ALLOWED_GRAPHQL_OPERATIONS.includes(friendlyName);
}

function pathOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).pathname;
  } catch {
    return null;
  }
}

/**
 * Le cœur de la garde, pur et testable sans navigateur : une requête, une
 * décision. Aucune I/O, aucun état.
 */
export function classifyInstagramRequest(request: GuardedRequest): GuardDecision {
  const path = pathOf(request.url);
  if (path === null) {
    return { allowed: false, rule: 'write_method', reason: `URL illisible : « ${request.url} »` };
  }

  const lowerPath = path.toLowerCase();
  const effect = EFFECT_PATH_PREFIXES.find((prefix) => lowerPath.startsWith(prefix));
  if (effect !== undefined) {
    return {
      allowed: false,
      rule: 'effect_path',
      reason: `chemin à effet « ${effect} » — refusé quelle que soit la méthode`,
    };
  }

  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') {
    return { allowed: true, rule: 'read_method' };
  }

  const readOnlyEndpoint = READ_ONLY_WRITE_METHOD_PATHS.find((prefix) => lowerPath.startsWith(prefix));
  if (readOnlyEndpoint === undefined) {
    return {
      allowed: false,
      rule: 'write_method',
      reason: `${method} ${path} — hors de la liste des points d'entrée de lecture, donc refusé par défaut`,
    };
  }

  const body = request.postData ?? '';
  const marker = GRAPHQL_EFFECT_MARKERS.find((pattern) => pattern.test(body));
  if (marker !== undefined) {
    return {
      allowed: false,
      rule: 'graphql_effect',
      reason: `corps GraphQL portant ${String(marker)} — opération d'écriture ou de messagerie, refusée`,
    };
  }

  return { allowed: true, rule: 'read_only_endpoint' };
}

/**
 * IG2 §2 — la garde du canari LIVE : la denylist d'effets, MOINS les messages
 * directs, et rien d'autre.
 *
 * Ce qui change par rapport à la lecture seule, exhaustivement : les chemins de
 * messagerie (`/direct/`, `/api/v1/direct_v2/`, `/api/v1/direct/`) cessent
 * d'être refusés, et un corps GraphQL de messagerie cesse de l'être. C'est la
 * définition même de « envoyer un DM » ; une garde qui l'interdirait encore
 * rendrait la primitive inopérante, et on la contournerait ailleurs.
 *
 * Ce qui NE change pas, et qui est l'essentiel : suivre, aimer, commenter,
 * enregistrer, bloquer, signaler et modifier le compte restent refusés, quelle
 * que soit la méthode HTTP. La mission autorise UN message ; elle n'autorise
 * pas « le mode Instagram complet », et la différence entre les deux est cette
 * liste-ci. Les mutations GraphQL restent refusées sauf quand elles portent un
 * marqueur de messagerie — un `follow` passé en mutation reste bloqué.
 *
 * Cette garde ne compte pas les envois et ne saurait pas le faire : elle voit
 * des requêtes, pas des intentions. Ce qui limite le canari à UN effet est
 * l'autorisation consommée atomiquement (`canary.ts`) et l'unique clic de la
 * primitive, pas cette fonction.
 */
const DIRECT_MESSAGE_PREFIXES: readonly string[] = ['/api/v1/direct_v2/', '/api/v1/direct/', '/direct/'];

/** Marqueurs GraphQL de messagerie — tolérés en LIVE, refusés partout ailleurs. */
const GRAPHQL_DIRECT_MARKERS: readonly RegExp[] = [/direct_v2/i, /\bdirect[A-Za-z]*(send|thread|message)/i];

export function classifyLiveDmRequest(request: GuardedRequest): GuardDecision {
  const path = pathOf(request.url);
  if (path === null) {
    return { allowed: false, rule: 'write_method', reason: `URL illisible : « ${request.url} »` };
  }
  const lowerPath = path.toLowerCase();

  const messaging = DIRECT_MESSAGE_PREFIXES.some((prefix) => lowerPath.startsWith(prefix));
  if (!messaging) {
    const effect = EFFECT_PATH_PREFIXES.find((prefix) => lowerPath.startsWith(prefix));
    if (effect !== undefined) {
      return {
        allowed: false,
        rule: 'effect_path',
        reason: `chemin à effet « ${effect} » — le canari autorise un message direct, pas ${effect}`,
      };
    }
  }

  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') {
    return { allowed: true, rule: 'read_method' };
  }
  if (messaging) {
    return { allowed: true, rule: 'read_only_endpoint' };
  }

  const readOnlyEndpoint = READ_ONLY_WRITE_METHOD_PATHS.find((prefix) => lowerPath.startsWith(prefix));
  if (readOnlyEndpoint === undefined) {
    return {
      allowed: false,
      rule: 'write_method',
      reason: `${method} ${path} — hors de la liste des points d'entrée de lecture, donc refusé par défaut`,
    };
  }

  // IG2.7 — l'opération d'envoi observée, nommément. Elle est évaluée avant la
  // règle générale parce qu'elle en est l'exception mesurée, pas un
  // assouplissement : hors de cette égalité de chaîne, rien ne change.
  if (isAllowedLiveDmOperation(lowerPath, request.postData)) {
    return { allowed: true, rule: 'graphql_direct_send' };
  }

  const body = request.postData ?? '';
  // Une mutation GraphQL reste refusée, SAUF si elle porte un marqueur de
  // messagerie : c'est ainsi qu'Instagram envoie un DM depuis le web.
  if (/mutation/i.test(body) && !GRAPHQL_DIRECT_MARKERS.some((pattern) => pattern.test(body))) {
    return {
      allowed: false,
      rule: 'graphql_effect',
      reason: 'mutation GraphQL sans marqueur de messagerie — hors de ce que le canari autorise',
    };
  }

  return { allowed: true, rule: 'read_only_endpoint' };
}

/**
 * IG2.1 §1/§2 — la garde de l'ADJUDICATION : lire un fil déjà écrit, sans
 * pouvoir y écrire.
 *
 * Le problème qu'elle résout tient en une phrase : pour savoir si le message
 * est parti, il faut ouvrir la conversation ; or les deux gardes existantes
 * refusent l'une et l'autre pour des raisons opposées.
 *
 *   * `classifyInstagramRequest` (lecture seule) refuse `/direct/` sous TOUTES
 *     les méthodes. Un panneau de discussion ouvert sous cette garde reste
 *     vide : on ne verrait pas la bulle, donc on ne pourrait rien adjuger.
 *   * `classifyLiveDmRequest` (canari) accepte les messages directs sous toutes
 *     les méthodes — c'est ce qu'il faut pour ENVOYER, et c'est exactement ce
 *     que l'adjudication n'a pas le droit de refaire.
 *
 * Celle-ci coupe entre les deux, sur la seule ligne qui compte : la MÉTHODE.
 * Les chemins de messagerie sont lisibles en GET/HEAD, et rien d'autre ne passe
 * — un envoi de DM depuis le web est un POST, donc il est refusé, y compris
 * celui que l'application Instagram tenterait d'elle-même en rejouant un
 * message resté en échec. C'est la propriété qui rend l'ouverture du fil sûre :
 * la garantie « aucun nouvel effet » ne repose pas sur « le rail ne clique
 * pas », elle repose sur « la requête ne peut pas sortir ».
 *
 * Tout le reste est celui de la lecture seule, mot pour mot : suivre, aimer,
 * commenter, bloquer, signaler et modifier le compte restent refusés, et une
 * mutation GraphQL reste refusée — y compris quand elle porte un marqueur de
 * messagerie, ce qui est précisément la différence avec la garde du canari.
 */
export function classifyAdjudicationRequest(request: GuardedRequest): GuardDecision {
  const path = pathOf(request.url);
  if (path === null) {
    return { allowed: false, rule: 'write_method', reason: `URL illisible : « ${request.url} »` };
  }
  const lowerPath = path.toLowerCase();
  const method = request.method.toUpperCase();
  const messaging = DIRECT_MESSAGE_PREFIXES.some((prefix) => lowerPath.startsWith(prefix));

  if (messaging) {
    // Une lecture de fil, et seulement une lecture. Un POST vers un chemin de
    // messagerie est un envoi ou une modification : refusé sans être nommé.
    if (method === 'GET' || method === 'HEAD') return { allowed: true, rule: 'read_method' };
    return {
      allowed: false,
      rule: 'effect_path',
      reason: `${method} ${path} — l'adjudication lit un fil, elle n'y écrit jamais`,
    };
  }

  const effect = EFFECT_PATH_PREFIXES.find((prefix) => lowerPath.startsWith(prefix));
  if (effect !== undefined) {
    return {
      allowed: false,
      rule: 'effect_path',
      reason: `chemin à effet « ${effect} » — refusé quelle que soit la méthode`,
    };
  }

  if (method === 'GET' || method === 'HEAD') return { allowed: true, rule: 'read_method' };

  const readOnlyEndpoint = READ_ONLY_WRITE_METHOD_PATHS.find((prefix) => lowerPath.startsWith(prefix));
  if (readOnlyEndpoint === undefined) {
    return {
      allowed: false,
      rule: 'write_method',
      reason: `${method} ${path} — hors de la liste des points d'entrée de lecture, donc refusé par défaut`,
    };
  }

  // Une mutation reste une mutation, même de messagerie. C'est le seul point où
  // cette garde est PLUS stricte que celle du canari, et c'est voulu : envoyer
  // un DM depuis le web est une mutation GraphQL portant un marqueur `direct`.
  const body = request.postData ?? '';
  if (/mutation/i.test(body)) {
    return {
      allowed: false,
      rule: 'graphql_effect',
      reason: 'mutation GraphQL — l’adjudication n’écrit rien, pas même un accusé de lecture',
    };
  }

  return { allowed: true, rule: 'read_only_endpoint' };
}

/**
 * IG2.1 §2 — les URL de l'adjudication : la boîte de réception et un fil.
 *
 * Pourquoi la boîte, alors que le canari s'en passait explicitement (« le
 * canari n'a rien à faire dans une boîte de réception »).
 *
 * Parce que les deux commandes ne cherchent pas la même chose. Le canari
 * cherchait un COMPOSEUR : il partait du profil autorisé et n'avait aucune
 * raison de regarder ailleurs. L'adjudication cherche un FAIT — le message
 * est-il chez Instagram ? — et ce fait ne vit pas dans le panneau de discussion
 * ouvert depuis un profil.
 *
 * Le premier essai l'a montré sans ambiguïté : ouvrir ce panneau demande un
 * `POST …/create_group_thread/`, que cette garde refuse et doit refuser. Ce
 * panneau est d'ailleurs le mauvais témoin — c'est un état CLIENT, celui-là même
 * qui affichait la bulle en échec. La boîte de réception, elle, rend ce que les
 * serveurs d'Instagram ont réellement enregistré, et elle le rend en GET.
 *
 * La liste reste étroite : la boîte, et un fil désigné par son identifiant. Ni
 * recherche, ni nouveau message (`/direct/new/`, que le canari s'autorisait,
 * n'est PAS ici — l'adjudication n'ouvre pas de conversation, elle en relit
 * une).
 */
export function isAllowedAdjudicationNavigation(rawUrl: string): boolean {
  if (isAllowedNavigation(rawUrl)) return true;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.hostname !== 'www.instagram.com') return false;
  if (url.search.length > 0 || url.hash.length > 0) return false;
  return /^\/direct\/(inbox|t\/\d{1,40})\/$/.test(url.pathname);
}

/**
 * Les URL vers lesquelles le rail LIVE accepte de naviguer : celles de la
 * lecture seule, plus un fil de discussion.
 *
 * `/direct/t/<id>/` et `/direct/new/` seulement — pas `/direct/inbox/`, parce
 * que le canari n'a rien à faire dans une boîte de réception : il ouvre le
 * profil autorisé, en part vers le fil de CE prospect, et s'arrête.
 */
export function isAllowedLiveNavigation(rawUrl: string): boolean {
  if (isAllowedNavigation(rawUrl)) return true;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.hostname !== 'www.instagram.com') return false;
  if (url.search.length > 0 || url.hash.length > 0) return false;
  return /^\/direct\/(t\/\d{1,40}|new)\/$/.test(url.pathname);
}

/**
 * HERMES-REPLY-DELIVERY-R1 §3/§4 — les URL vers lesquelles le rail de RÉPONSE
 * accepte de naviguer.
 *
 * Elle est plus étroite que celle du canari, et la différence est le cœur de ce
 * round : **`/direct/new/` n'est pas ici**. Le canari en a besoin — il OUVRE
 * une conversation avec quelqu'un qui n'en a pas. Répondre, non : le fil existe
 * déjà, il a un identifiant, il a été observé par le rail entrant, et un rail
 * de réponse qui saurait atteindre « nouveau message » saurait produire un
 * premier contact déguisé en réponse.
 *
 * C'est la même méthode que partout ailleurs dans ce dépôt : la sûreté ne vient
 * pas d'une consigne (« ne réponds qu'à des fils existants »), elle vient de
 * l'absence de tout ce qu'il faudrait pour faire autrement. Un `sendThreadReply`
 * à qui l'on passerait un identifiant inventé n'ouvrirait pas une conversation
 * neuve — il n'irait nulle part.
 *
 * `/direct/inbox/` n'y est pas non plus, pour la raison du canari : un rail qui
 * répond n'a rien à faire dans une boîte de réception, et la relève entrante
 * a déjà lu ce qu'il fallait.
 *
 * Ce qui EST autorisé en plus du fil : la liste de lecture seule — la racine et
 * une page de profil canonique. La page de profil sert à une seule chose, et
 * c'est une LECTURE : y relire le nom d'affichage déclaré par le compte, qui
 * corrobore l'identité quand l'en-tête du fil affiche « Moha » plutôt que
 * « operator_second_account » (`decideThreadIdentity`, preuve faible corroborée). Sans
 * elle, tout fil dont l'en-tête n'écrit pas le handle échouerait fermé — ce qui
 * est sûr, et inutilisable.
 */
export function isAllowedReplyNavigation(rawUrl: string): boolean {
  if (isAllowedNavigation(rawUrl)) return true;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.hostname !== 'www.instagram.com') return false;
  if (url.search.length > 0 || url.hash.length > 0) return false;
  return /^\/direct\/t\/\d{1,40}\/$/.test(url.pathname);
}

/**
 * La garde du bootstrap de session — une variante assouplie, et seulement
 * sur la règle 2.
 *
 * Se connecter demande d'écrire (`POST …/accounts/login/ajax/`). Le bootstrap
 * est une commande distincte, lancée à la main, fenêtre visible, où un humain
 * s'authentifie sur SON propre compte : aucun prospect n'est ouvert, aucun
 * profil n'est visité. La règle 1 — la denylist d'effets — reste appliquée mot
 * pour mot : même pendant un bootstrap, un DM, un follow ou un like ne peut pas
 * sortir de ce processus.
 */
export function classifyBootstrapRequest(request: GuardedRequest): GuardDecision {
  const path = pathOf(request.url);
  if (path === null) {
    return { allowed: false, rule: 'write_method', reason: `URL illisible : « ${request.url} »` };
  }
  const effect = EFFECT_PATH_PREFIXES.find((prefix) => path.toLowerCase().startsWith(prefix));
  if (effect !== undefined) {
    return {
      allowed: false,
      rule: 'effect_path',
      reason: `chemin à effet « ${effect} » — refusé même pendant un bootstrap de session`,
    };
  }
  return { allowed: true, rule: 'read_only_endpoint' };
}

/**
 * Les URL vers lesquelles le rail accepte de naviguer. Deux, et pas une de
 * plus : la racine (vérification de session) et une page de profil canonique.
 *
 * Une liste blanche de navigation, en plus de la garde réseau, parce que les
 * deux protègent contre des choses différentes : la garde réseau empêche une
 * requête d'effet de partir, celle-ci empêche le rail d'aller se placer devant
 * un composeur de message — c'est-à-dire de créer la situation où une frappe
 * accidentelle aurait un sens.
 */
export function isAllowedNavigation(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.hostname !== 'www.instagram.com') return false;
  if (url.search.length > 0 || url.hash.length > 0) return false;
  if (url.pathname === '/') return true;
  return /^\/[A-Za-z0-9._]{1,30}\/$/.test(url.pathname) && !url.pathname.toLowerCase().startsWith('/direct');
}

/**
 * HERMES-SEND-CONTROL-PROBE-R1 §12 — la garde de la SONDE : voir le fil, saisir
 * localement, et ne rien remettre.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi ni l'une ni l'autre des deux gardes existantes ne convient
 * ---------------------------------------------------------------------------
 *   * `classifyInstagramRequest` (lecture seule) refuse `/direct/` sous toutes
 *     les méthodes : le fil resterait vide, et il n'y aurait ni composeur, ni
 *     contrôle d'envoi à observer ;
 *   * `classifyLiveDmRequest` (celle du canari, dont le rail d'inspection
 *     hérite) accepte la messagerie sous TOUTES les méthodes, et autorise
 *     nommément l'opération d'envoi. C'est ce qu'il faut pour REMETTRE un
 *     message. Une sonde qui écrit dans un composeur sous cette garde serait à
 *     une touche d'un message réel, et un brouillon persisté côté serveur
 *     passerait sans être vu.
 *
 * Cette garde est donc la troisième : la permissivité de la seconde pour tout
 * ce qui LIT un fil, la sévérité de la première pour tout ce qui l'ÉCRIT.
 *
 * Ce qu'elle refuse en plus du canari, exhaustivement :
 *
 *   1. toute requête non-GET/HEAD vers un chemin de messagerie — c'est là que
 *      vivent la remise, l'indicateur de frappe et la persistance de brouillon ;
 *   2. l'opération de remise nommée par `LIVE_DM_ALLOWED_GRAPHQL_OPERATIONS`,
 *      sans exception ;
 *   3. tout corps GraphQL portant `mutation`, y compris avec un marqueur de
 *      messagerie. Le canari lève cette règle parce qu'il DOIT remettre ; la
 *      sonde n'a rien à écrire, donc rien à lever.
 *
 * Ce qu'elle garde du canari, et pourquoi : les LECTURES de messagerie en GET,
 * et les lectures GraphQL en POST sans marqueur de mutation. Sans elles, la
 * page ne rend pas le fil — et une sonde qui n'observe rien n'observe pas
 * « rien », elle n'observe pas.
 *
 * Ce qu'elle n'est pas : un desserrement. Elle est strictement plus stricte que
 * la garde sous laquelle l'inspection réelle a déjà tourné, et un test l'établit
 * requête par requête.
 */
export function classifySendControlProbeRequest(request: GuardedRequest): GuardDecision {
  const path = pathOf(request.url);
  if (path === null) {
    return { allowed: false, rule: 'write_method', reason: `URL illisible : « ${request.url} »` };
  }
  const lowerPath = path.toLowerCase();
  const method = request.method.toUpperCase();
  const messaging = DIRECT_MESSAGE_PREFIXES.some((prefix) => lowerPath.startsWith(prefix));

  if (!messaging) {
    const effect = EFFECT_PATH_PREFIXES.find((prefix) => lowerPath.startsWith(prefix));
    if (effect !== undefined) {
      return {
        allowed: false,
        rule: 'effect_path',
        reason: `chemin à effet « ${effect} » — une sonde observe, elle n'agit sur rien`,
      };
    }
  }

  if (method === 'GET' || method === 'HEAD') {
    return { allowed: true, rule: 'read_method' };
  }

  // 1. Écrire sur un chemin de messagerie : c'est exactement ce que la sonde ne
  // fait pas. Le canari l'autorise parce qu'il remet un message ; ici il n'y a
  // rien à remettre, donc rien qui justifie qu'une écriture parte.
  if (messaging) {
    return {
      allowed: false,
      rule: 'effect_path',
      reason:
        `${method} ${path} — écriture sur un chemin de messagerie. La sonde saisit dans le DOM et ne ` +
        'remet rien : remise, indicateur de frappe et brouillon distant sont refusés ensemble',
    };
  }

  const readOnlyEndpoint = READ_ONLY_WRITE_METHOD_PATHS.find((prefix) => lowerPath.startsWith(prefix));
  if (readOnlyEndpoint === undefined) {
    return {
      allowed: false,
      rule: 'write_method',
      reason: `${method} ${path} — hors de la liste des points d'entrée de lecture, donc refusé par défaut`,
    };
  }

  // 2. L'opération de REMISE, nommément. Le canari en fait son unique
  // exception ; la sonde en fait un refus explicite, pour que le diff qui
  // l'autoriserait soit visible.
  if (isAllowedLiveDmOperation(lowerPath, request.postData)) {
    return {
      allowed: false,
      rule: 'graphql_effect',
      reason: `${LIVE_DM_ALLOWED_GRAPHQL_OPERATIONS.join(', ')} — l'opération de remise, refusée par la sonde`,
    };
  }

  // 3. Toute mutation, sans l'exception de messagerie du canari.
  const body = request.postData ?? '';
  if (/mutation/i.test(body)) {
    return {
      allowed: false,
      rule: 'graphql_effect',
      reason: 'mutation GraphQL — une sonde ne mute rien, pas même un brouillon',
    };
  }

  return { allowed: true, rule: 'read_only_endpoint' };
}
