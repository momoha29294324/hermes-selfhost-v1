import type {
  ObservationConfidence,
  ObservationMethod,
  ObservedPost,
  ObservedValue,
  ProfileFacts,
} from '@/lib/pipeline/instagramObservation';

/**
 * R7.3C §12–§14 — lire une charge utile Instagram sans jamais inventer un champ.
 *
 * ---------------------------------------------------------------------------
 * Le principe qui gouverne tout ce fichier
 * ---------------------------------------------------------------------------
 * Une clé absente rend `undefined`, jamais une valeur de repli. C'est le §2 de
 * CLAUDE.md porté au niveau du parseur : si `biography` n'est pas dans la
 * réponse, nous ne savons pas si le compte a une bio — nous ne savons pas
 * qu'il n'en a pas. La différence tient en une ligne de code ici et décide de
 * tout le reste de la chaîne.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi plusieurs formes sont acceptées
 * ---------------------------------------------------------------------------
 * Instagram sert le même profil sous au moins trois enveloppes selon l'A/B en
 * cours (`data.user`, `graphql.user`, `data.xdt_api__v1__users__…`). Les
 * chercher toutes n'est pas de la complaisance : ne connaître qu'une forme
 * produirait des `UNREADABLE` massifs et — bien pire — silencieux, qu'on lirait
 * comme « Instagram ne donne rien » alors qu'il donnait tout sous un autre nom.
 *
 * Aucune de ces formes n'est demandée par le rail : elles arrivent parce que la
 * PAGE les charge. Ce module ne fait que lire ce qui a déjà transité.
 */

// ---------------------------------------------------------------------------
// Navigation typée dans de l'inconnu
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pick(value: unknown, ...path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.replace(/[\s  ,]/g, ''), 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

// ---------------------------------------------------------------------------
// L'objet « user », sous ses enveloppes connues
// ---------------------------------------------------------------------------

/** Les chemins où Instagram place l'objet profil. Ordre : du plus récent au plus ancien. */
const USER_PATHS: readonly (readonly string[])[] = [
  ['data', 'user'],
  ['data', 'xdt_api__v1__users__web_profile_info__username', 'user'],
  ['data', 'xdt_user_by_username'],
  ['graphql', 'user'],
  ['user'],
];

/**
 * Les clés qui font d'un objet portant `username` un objet PROFIL.
 *
 * Sans elles, la recherche récursive ramènerait n'importe quel `{username}` —
 * l'auteur d'un commentaire, un compte suggéré, l'utilisateur connecté. Le
 * nombre de ces clés présentes sert aussi à départager plusieurs candidats :
 * on garde le plus riche, c'est-à-dire celui dont la page a réellement affiché
 * la fiche.
 */
const PROFILE_MARKER_KEYS: readonly string[] = [
  'edge_owner_to_timeline_media',
  'timeline_media',
  'biography',
  'edge_followed_by',
  'follower_count',
  'media_count',
  'external_url',
  'highlight_reel_count',
  'category_name',
  'full_name',
  'is_private',
];

function profileRichness(candidate: Record<string, unknown>): number {
  return PROFILE_MARKER_KEYS.filter((key) => candidate[key] !== undefined).length;
}

/**
 * Recherche RÉCURSIVE de l'objet profil, bornée.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi une recherche et non un chemin
 * ---------------------------------------------------------------------------
 * Le premier profil réel observé l'a tranché : Instagram ne renvoie plus le
 * profil dans une réponse d'API à un visiteur anonyme, il l'embarque dans des
 * `<script type="application/json">` du document. Ces blobs sont des enveloppes
 * de chargement (`require` / `__bbox` / `define`) où la profondeur de l'objet
 * `user` dépend de l'ordre des modules — elle n'est pas stable, donc elle n'est
 * pas adressable par un chemin.
 *
 * Les bornes ne sont pas décoratives : un blob Instagram fait plusieurs centaines
 * de kilo-octets, et une descente non bornée sur chacun des quarante blobs d'une
 * page transformerait une lecture en calcul. `MAX_DEPTH` et `MAX_NODES` gardent
 * le coût constant et connu.
 */
const MAX_DEPTH = 14;
const MAX_NODES = 60_000;

function findUserObjectDeep(payload: unknown, expectedUsername?: string): Record<string, unknown> | null {
  let best: Record<string, unknown> | null = null;
  let bestScore = 0;
  let visited = 0;

  const walk = (node: unknown, depth: number): void => {
    if (visited > MAX_NODES || depth > MAX_DEPTH) return;
    visited += 1;

    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (!isRecord(node)) return;

    if (
      typeof node['username'] === 'string' &&
      (expectedUsername === undefined || sameUsername(node['username'], expectedUsername))
    ) {
      const score = profileRichness(node);
      if (score > bestScore) {
        best = node;
        bestScore = score;
      }
    }
    for (const value of Object.values(node)) walk(value, depth + 1);
  };

  walk(payload, 0);
  // Un `{username}` nu (score 0) n'est pas une fiche de profil : c'est un
  // auteur de commentaire ou un compte suggéré. On préfère ne rien rendre.
  return bestScore > 0 ? best : null;
}

/** Un nom d'utilisateur comparable : minuscules, sans arobase ni espace. */
function sameUsername(a: unknown, b: string): boolean {
  return typeof a === 'string' && a.trim().replace(/^@/, '').toLowerCase() === b.trim().replace(/^@/, '').toLowerCase();
}

/**
 * L'objet profil d'une charge utile — et, si on le demande, celui d'un compte
 * PRÉCIS.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi `expectedUsername` est devenu indispensable sous session
 * ---------------------------------------------------------------------------
 * Anonyme, la page d'un profil ne parlait que de ce profil. Authentifiée, elle
 * en charge cinq : le compte demandé, deux comptes « suggérés », l'auteur d'une
 * publication du fil d'accueil, et le compte de l'observer lui-même. Tous
 * portent un objet `user` complet, tous passent `profileRichness`.
 *
 * Sans filtre, ce qui gagne est un ACCIDENT D'ORDRE D'ARRIVÉE. La première
 * collecte authentifiée l'a montré sans ambiguïté : deux prospects sur quatre
 * se sont vu attribuer le nom d'utilisateur du compte OBSERVER. Ce n'est pas une
 * imprécision de mesure, c'est la bio et les abonnés de quelqu'un d'autre écrits
 * sous le nom d'un prospect — l'exacte donnée inventée que le §2 de CLAUDE.md
 * interdit.
 *
 * Le filtre n'est pas circulaire vis-à-vis du contrôle d'identité : ce qu'on
 * passe ici est le compte sur lequel le navigateur a ATTERRI (lu dans l'URL
 * finale), pas celui que le prospect prétend avoir. Une redirection vers un
 * autre compte reste donc parfaitement visible — l'URL finale diffère de l'URL
 * demandée, et `checkIdentity` tranche.
 */
export function extractUserObject(payload: unknown, expectedUsername?: string): Record<string, unknown> | null {
  const acceptable = (candidate: unknown): candidate is Record<string, unknown> =>
    isRecord(candidate) &&
    (typeof candidate['username'] === 'string' || typeof candidate['id'] === 'string') &&
    (expectedUsername === undefined || sameUsername(candidate['username'], expectedUsername));

  for (const path of USER_PATHS) {
    const candidate = pick(payload, ...path);
    if (acceptable(candidate)) return candidate;
  }
  const deep = findUserObjectDeep(payload, expectedUsername);
  return deep;
}

/** Les chemins où vit la grille de publications, dans le même ordre de préférence. */
const MEDIA_PATHS: readonly (readonly string[])[] = [
  ['edge_owner_to_timeline_media'],
  ['timeline_media'],
  ['edge_felix_video_timeline'],
];

function mediaContainer(user: Record<string, unknown>): Record<string, unknown> | null {
  for (const path of MEDIA_PATHS) {
    const candidate = pick(user, ...path);
    if (isRecord(candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Faits
// ---------------------------------------------------------------------------

export interface PayloadReadContext {
  readonly observedAt: string;
  readonly source: string;
  readonly method: ObservationMethod;
  readonly confidence: ObservationConfidence;
}

function value<T>(raw: T | null, context: PayloadReadContext): ObservedValue<T> | undefined {
  if (raw === null) return undefined;
  return {
    value: raw,
    observedAt: context.observedAt,
    source: context.source,
    method: context.method,
    confidence: context.confidence,
  };
}

/**
 * Les faits du profil, tels que la charge utile les porte.
 *
 * `highlightsPresent` mérite un mot : `highlight_reel_count` n'est pas toujours
 * servi, et son absence ne prouve rien. On ne l'écrit donc que lorsqu'il est là
 * — sinon la présence de stories à la une reste `UNKNOWN`, comme le §18 le
 * demande, plutôt que `false` faute d'avoir cherché ailleurs.
 */
export function readProfileFacts(
  payload: unknown,
  context: PayloadReadContext,
  expectedUsername?: string,
): ProfileFacts {
  const user = extractUserObject(payload, expectedUsername);
  if (user === null) return {};

  const highlightCount = asNumber(user['highlight_reel_count']);
  const media = mediaContainer(user);

  const facts: ProfileFacts = {
    username: value(asString(user['username']), context),
    displayName: value(asString(user['full_name']), context),
    biography: value(asString(user['biography']), context),
    externalWebsite: value(asString(user['external_url']), context),
    category: value(asString(user['category_name']) ?? asString(user['category']), context),
    verified: value(asBoolean(user['is_verified']), context),
    isPrivate: value(asBoolean(user['is_private']), context),
    postCount: value(media === null ? null : asNumber(media['count']), context),
    followersCount: value(asNumber(pick(user, 'edge_followed_by', 'count')) ?? asNumber(user['follower_count']), context),
    followingCount: value(asNumber(pick(user, 'edge_follow', 'count')) ?? asNumber(user['following_count']), context),
    highlightsPresent: value(highlightCount === null ? null : highlightCount > 0, context),
    highlightsCount: value(highlightCount, context),
    contactCtaPresent: value(
      asBoolean(user['is_business_account']) === null && asString(user['business_email']) === null
        ? null
        : asString(user['business_email']) !== null ||
            asString(user['business_phone_number']) !== null ||
            asBoolean(user['should_show_category']) === true,
      context,
    ),
  };

  // Les clés `undefined` sont retirées : « absent de l'objet » et « présent à
  // undefined » se sérialisent différemment en JSON, et seule la première dit
  // « jamais lu ».
  return Object.fromEntries(Object.entries(facts).filter(([, entry]) => entry !== undefined)) as ProfileFacts;
}

// ---------------------------------------------------------------------------
// Publications
// ---------------------------------------------------------------------------

/** Secondes epoch → ISO. `null` sur tout ce qui n'est pas une date plausible. */
export function timestampToIso(seconds: unknown): string | null {
  const value = asNumber(seconds);
  if (value === null || value <= 0) return null;
  const date = new Date(value * 1_000);
  if (!Number.isFinite(date.getTime())) return null;
  // Une date antérieure au lancement d'Instagram ou postérieure de plus d'un an
  // à aujourd'hui trahit une unité mal lue (millisecondes prises pour des
  // secondes, ou l'inverse). On préfère ne rien dire.
  const year = date.getUTCFullYear();
  if (year < 2010 || year > 2100) return null;
  return date.toISOString();
}

/**
 * Les publications visibles depuis le profil.
 *
 * Ni légende, ni image, ni compteur de « j'aime » : la cadence se calcule sur
 * des horodatages, et tout ce qu'on ne lit pas est une donnée qu'on n'a pas à
 * justifier d'avoir prise.
 *
 * `pinned` est extrait parce qu'il change le sens de la date : Instagram remonte
 * les publications épinglées en tête de grille quel que soit leur âge. Les
 * confondre avec les plus récentes ferait passer un compte dormant pour vivant.
 */
export function readPosts(payload: unknown): ObservedPost[] {
  const merged = new Map<string, ObservedPost>();

  /**
   * Source 1 — la grille portée par l'objet PROFIL lui-même.
   *
   * C'est la forme que sert un visiteur anonyme. Le propriétaire n'y est pas
   * répété publication par publication : il est celui de la fiche qui les
   * contient, et c'est pour ça qu'on peut le renseigner ici sans le supposer.
   */
  const user = extractUserObject(payload);
  if (user !== null) {
    const media = mediaContainer(user);
    const owner = asString(user['username']);
    if (media !== null) {
      for (const edge of asArray(media['edges'])) {
        const node = pick(edge, 'node');
        if (!isRecord(node)) continue;
        const post = toObservedPost(node, owner);
        if (post !== null) mergePost(merged, post);
      }
    }
  }

  /**
   * Source 2 — les connexions de fil servies à une session AUTHENTIFIÉE.
   *
   * `xdt_api__v1__feed__user_timeline_graphql_connection` porte les
   * horodatages que la forme anonyme ne donne plus. On la lit par sa STRUCTURE
   * (`edges[].node`) plutôt que par son nom : Instagram renomme ces champs à
   * chaque A/B, et un nom en dur ferait retomber la cadence à `UNKNOWN` sans
   * que rien ne le signale.
   */
  for (const node of collectConnectionMediaNodes(payload)) {
    /**
     * Un horodatage EXIGÉ ici, et seulement ici.
     *
     * La source 1 est déjà encadrée par un objet profil, donc ce qu'elle rend
     * est une publication même sans date. Une connexion quelconque, elle, peut
     * être une liste de comptes suggérés ou de hashtags — dont les nœuds
     * portent aussi un `pk`. `taken_at` est ce qui distingue une publication
     * d'autre chose, et l'exiger vaut mieux que de deviner à quoi ressemble
     * une enveloppe qu'on n'a pas encore vue.
     */
    if (timestampToIso(node['taken_at_timestamp'] ?? node['taken_at']) === null) continue;
    const post = toObservedPost(node, null);
    if (post !== null) mergePost(merged, post);
  }

  return [...merged.values()];
}

/**
 * Les nœuds média d'une connexion, sans jamais descendre dans un carrousel.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi la structure, et pourquoi si peu profond
 * ---------------------------------------------------------------------------
 * La tentation serait de chercher partout « un objet qui a un `taken_at` ». Le
 * premier profil observé sous session montre pourquoi c'est faux : ses douze
 * publications contenaient quinze enfants de carrousel, chacun avec son propre
 * `pk` et son propre `taken_at`. Une recherche par forme en aurait compté
 * vingt-sept — l'échantillon doublé, la cadence multipliée par deux, et rien
 * dans la sortie pour le dire.
 *
 * Un carrousel de huit photos est UNE publication. On ne lit donc que ce qu'une
 * connexion appelle une entrée : `edges[].node`, ou `edges[].node.media` quand
 * l'entrée est un élément de fil qui enveloppe son média. On ne descend pas
 * SOUS ce nœud, ce qui écarte d'un seul geste les enfants de carrousel, les
 * médias publicitaires (`node.ad.items[]`) et les vignettes d'exploration
 * (`node.explore_story.media`) — trois choses qui ne sont pas des publications
 * de ce prospect.
 */
function collectConnectionMediaNodes(payload: unknown): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  let visited = 0;

  const walk = (node: unknown, depth: number): void => {
    if (visited > MAX_NODES || depth > MAX_DEPTH || nodes.length >= MAX_CONNECTION_NODES) return;
    visited += 1;

    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (!isRecord(node)) return;

    const edges = node['edges'];
    if (Array.isArray(edges)) {
      for (const edge of edges) {
        if (!isRecord(edge)) continue;
        const inner = edge['node'];
        if (!isRecord(inner)) continue;
        const media = isRecord(inner['media']) ? inner['media'] : inner;
        nodes.push(media);
      }
    }

    for (const [key, value] of Object.entries(node)) {
      // Descendre dans `edges` rouvrirait les carrousels qu'on vient d'exclure.
      if (key === 'edges') continue;
      walk(value, depth + 1);
    }
  };

  walk(payload, 0);
  return nodes;
}

/** Borne le coût d'une page qui servirait des centaines d'entrées. */
const MAX_CONNECTION_NODES = 400;

/**
 * Un nœud média → une publication, ou `null` si ce n'en est pas une.
 *
 * `fallbackOwner` n'est utilisé que lorsque le nœud lui-même ne nomme pas son
 * auteur : on ne réécrit jamais un propriétaire que la charge utile a donné.
 */
function toObservedPost(node: Record<string, unknown>, fallbackOwner: string | null): ObservedPost | null {
  const shortcode = asString(node['shortcode']) ?? asString(node['code']);
  const rawPk = node['pk'];
  const mediaId =
    asString(node['id']) ?? (typeof rawPk === 'string' || typeof rawPk === 'number' ? String(rawPk) : null);
  const takenAt = timestampToIso(node['taken_at_timestamp'] ?? node['taken_at']);
  if (shortcode === null && mediaId === null && takenAt === null) return null;

  /**
   * `timeline_pinned_user_ids` est la forme authentifiée de l'épingle, et elle
   * n'était pas lue : sur le premier profil observé, les TROIS publications de
   * tête étaient épinglées et dataient de 2025, tandis que l'activité réelle
   * était de juillet 2026. Sans cette clé, le compte serait sorti `INACTIVE`
   * alors qu'il publie chaque semaine.
   */
  const pinned =
    asArray(node['pinned_for_users']).length > 0 ||
    asArray(node['timeline_pinned_user_ids']).length > 0 ||
    asBoolean(node['is_pinned']) === true;

  return {
    mediaId,
    permalink: shortcode === null ? null : `https://www.instagram.com/p/${shortcode}/`,
    takenAt,
    /**
     * Le libellé le plus INFORMATIF des trois, pas le premier trouvé.
     *
     * La forme authentifiée porte `__typename: "XDTMediaDict"` — un nom
     * d'enveloppe GraphQL, vrai et sans contenu — à côté d'un `product_type`
     * qui dit réellement « clips » ou « carousel_container ». La forme
     * historique, elle, n'a pas de `product_type` et met l'information dans
     * `__typename` (« GraphImage »). D'où cet ordre : le champ spécifique
     * d'abord, l'enveloppe ensuite. `media_type` est un ENTIER dans la forme
     * authentifiée et ne sert que de dernier recours.
     */
    mediaType: asString(node['product_type']) ?? asString(node['__typename']) ?? asString(node['media_type']),
    pinned,
    owner: asString(pick(node, 'user', 'username')) ?? asString(pick(node, 'owner', 'username')) ?? fallbackOwner,
  };
}

/** Fusionne par identité stable ; une entrée plus riche remplace une plus pauvre, jamais l'inverse. */
function mergePost(into: Map<string, ObservedPost>, post: ObservedPost): void {
  const key = post.mediaId ?? post.permalink;
  if (key === null || key.length === 0) return;
  const existing = into.get(key);
  if (existing === undefined) {
    into.set(key, post);
    return;
  }
  into.set(key, {
    mediaId: existing.mediaId ?? post.mediaId,
    permalink: existing.permalink ?? post.permalink,
    takenAt: existing.takenAt ?? post.takenAt,
    mediaType: existing.mediaType ?? post.mediaType,
    // Une épingle constatée par l'une des deux formes reste une épingle.
    pinned: existing.pinned || post.pinned,
    owner: existing.owner ?? post.owner,
  });
}

// ---------------------------------------------------------------------------
// Repli : la méta `og:description`
// ---------------------------------------------------------------------------

export interface OgCounts {
  readonly followers: number | null;
  readonly following: number | null;
  readonly posts: number | null;
}

/**
 * Les trois compteurs qu'Instagram écrit dans `og:description`.
 *
 * Un REPLI, pas une source : la ligne est localisée, abrégée (« 12,3 k ») et
 * réordonnée selon les versions. On n'en tire donc que des entiers exacts —
 * toute forme abrégée est refusée plutôt qu'arrondie, parce qu'un `12 300` qui
 * vaut en réalité `12 349` est un chiffre faux présenté comme un fait.
 *
 * `null` sur chaque champ qu'on n'a pas su lire, jamais zéro.
 */
export function readOgDescriptionCounts(description: string): OgCounts {
  const normalized = description.replace(/[  ]/g, ' ');
  const grab = (labels: readonly string[]): number | null => {
    for (const label of labels) {
      const pattern = new RegExp(`([0-9][0-9 .,]*)\\s*${label}`, 'i');
      const match = pattern.exec(normalized);
      const raw = match?.[1];
      if (raw === undefined) continue;
      // Une forme abrégée (« 12,3 k », « 2.4M ») n'est pas un compte exact.
      const compact = raw.replace(/[\s.,]/g, '');
      if (!/^\d+$/.test(compact)) continue;
      const parsed = Number.parseInt(compact, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  };

  return {
    followers: grab(['followers', "abonn[ée]s"]),
    following: grab(['following', 'abonnements']),
    posts: grab(['posts', 'publications']),
  };
}
