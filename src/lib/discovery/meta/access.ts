import { env, envBool } from '@/lib/env';
import type { Sql } from '@/lib/db/sql';

/**
 * Ce à quoi Meta nous donne réellement accès, et ce qu'il faudrait pour le
 * reste.
 *
 * Ce fichier est le résultat exécutable de l'audit documenté dans
 * la documentation d’installation, mené sur la documentation officielle le
 * 2026-08-10. Il existe parce qu'un état d'accès est un fait daté : le laisser
 * uniquement dans un document en ferait une rumeur au bout d'un trimestre, et
 * le déduire de la présence d'un jeton en ferait un mensonge.
 *
 * Trois règles y sont codées en dur, et elles sont volontairement plus strictes
 * que ce que le réseau autoriserait :
 *
 *   1. **Un jeton ne vaut pas une permission.** `/pages/search` exige la
 *      fonctionnalité Page Public Content Access, obtenue par App Review et
 *      vérification d'entreprise. Tant que `OUTBOUND_META_PPCA_GRANTED` n'est
 *      pas explicitement à 1, le rail refuse d'appeler — même si un jeton
 *      traîne dans l'environnement. Tenter pour voir, c'est contourner.
 *   2. **Aucun jeton d'un autre projet.** Seules les variables préfixées
 *      `OUTBOUND_META_` sont lues. Les applications un projet isole, moderation ou
 *      client ne sont ni lues, ni réutilisées, ni auditées (CLAUDE.md §4).
 *   3. **Une capacité qui n'existe pas ne reçoit pas d'adaptateur.** La
 *      recherche par hashtag ne renvoie pas l'auteur d'un média tiers ; elle ne
 *      peut donc pas découvrir de comptes. Elle est enregistrée `not_viable`
 *      et n'a pas de code — construire un rail autour serait une mise en scène.
 */

export type ExternalSourceStatus =
  | 'available'
  | 'blocked_pending_app_review'
  | 'not_viable'
  | 'not_configured'
  | 'disabled';

export interface SourceAccessState {
  source: string;
  status: ExternalSourceStatus;
  /** Ce qu'il faudrait obtenir pour débloquer, en clair. */
  requirement: string | null;
  detail: Record<string, unknown>;
}

/** Identifiants dédiés à Hermes. Jamais ceux d'un autre projet. */
export interface MetaCredentials {
  appId: string | null;
  accessToken: string | null;
  /** Notre propre compte Instagram professionnel, exigé par Business Discovery. */
  igUserId: string | null;
  /** App Review a-t-elle accordé Page Public Content Access ? Déclaratif. */
  ppcaGranted: boolean;
  /** App Review a-t-elle accordé Instagram Public Content Access ? */
  ipcaGranted: boolean;
  graphVersion: string;
}

export function metaCredentials(): MetaCredentials {
  return {
    appId: env('OUTBOUND_META_APP_ID') ?? null,
    accessToken: env('OUTBOUND_META_ACCESS_TOKEN') ?? null,
    igUserId: env('OUTBOUND_META_IG_USER_ID') ?? null,
    ppcaGranted: envBool('OUTBOUND_META_PPCA_GRANTED', false),
    ipcaGranted: envBool('OUTBOUND_META_IPCA_GRANTED', false),
    graphVersion: env('OUTBOUND_META_GRAPH_VERSION', 'v26.0') as string,
  };
}

export const META_GRAPH_BASE = 'https://graph.facebook.com';

/**
 * Facebook Pages Search — `GET /pages/search`.
 *
 * L'endpoint existe toujours en v26.0 (`GET /search?type=page`, lui, a été
 * retiré et ne doit pas être tenté). Trois constats de l'audit décident de son
 * sort ici, et ils vont en s'aggravant :
 *
 *   1. **Il est derrière une fonctionnalité, pas seulement derrière une
 *      revue.** C'est Page Public Content Access — ou Page Public Metadata
 *      Access, que PPCA supersède — qui ouvre l'API de recherche de Pages.
 *      Les deux exigent App Review *et* vérification d'entreprise.
 *   2. **Il ne filtre pas par géographie.** Deux paramètres documentés, `q` et
 *      `fields`. Ni pays, ni ville, ni coordonnées, ni rayon. L'ancien
 *      `GET /search?type=place`, qui portait `center`/`distance`, est supprimé
 *      depuis le 2 novembre 2020. Une recherche « atelier automobile » ne
 *      peut donc pas être restreinte à la France côté fournisseur.
 *   3. **L'usage autorisé de PPCA ne couvre pas ce que nous voulons en
 *      faire.** L'Allowed Usage publié tient en une ligne — « Analyze and/or
 *      display posts and engagement on Pages » — et la documentation de Search
 *      Pages cadre le jeton applicatif sur l'analyse concurrentielle. Bâtir une
 *      liste de prospects n'y figure pas, et les Platform Terms §3.a
 *      interdisent de traiter des données de plateforme « for purposes other
 *      than those authorized in Meta's developer documentation ».
 *
 * Le point 3 est le plus important, et c'est celui qu'il serait le plus facile
 * de passer sous silence : il signifie que ce rail ne se débloque pas en
 * attendant. Obtenir PPCA ne suffirait pas — il faudrait que Meta autorise
 * explicitement cet usage. C'est ce que le runbook d'App Review doit déclarer
 * honnêtement, quitte à se faire refuser.
 */
export function facebookPagesAccess(credentials = metaCredentials()): SourceAccessState {
  const detail = {
    endpoint: '/pages/search',
    removedEndpoints: ['/search?type=page', '/search?type=place (retiré le 2020-11-02)'],
    graphVersion: credentials.graphVersion,
    requiredFeature: 'Page Public Content Access (ou Page Public Metadata Access, superseded par PPCA)',
    featureAlsoRequires: 'App Review + vérification d’entreprise',
    documentedParameters: ['q', 'fields'],
    geographicFilter: 'aucun — filtrage possible seulement côté client, après identification',
    allowedUsage: 'Analyze and/or display posts and engagement on Pages',
    usageConcern:
      'la constitution d’une liste de prospects ne figure pas dans l’usage autorisé de PPCA ; ' +
      'Platform Terms §3.a interdit tout traitement hors usages documentés',
    audit: 'la documentation d’installation',
    hasAppId: Boolean(credentials.appId),
    hasToken: Boolean(credentials.accessToken),
  };

  if (!credentials.appId || !credentials.accessToken) {
    return {
      source: 'facebook_pages',
      status: 'not_configured',
      requirement:
        'Une application Meta DÉDIÉE à Hermes (OUTBOUND_META_APP_ID + OUTBOUND_META_ACCESS_TOKEN). ' +
        'Aucune application existante d’un autre projet ne peut être réutilisée.',
      detail,
    };
  }

  if (!credentials.ppcaGranted) {
    return {
      source: 'facebook_pages',
      status: 'blocked_pending_app_review',
      requirement:
        'Page Public Content Access accordé par App Review, avec vérification d’entreprise, ' +
        'puis OUTBOUND_META_PPCA_GRANTED=1.',
      detail,
    };
  }

  return { source: 'facebook_pages', status: 'available', requirement: null, detail };
}

/**
 * Instagram Business Discovery.
 *
 * Disponible, et strictement borné : il faut posséder un compte Instagram
 * professionnel lié à une Page, et **connaître à l'avance le username visé**.
 * Ce n'est pas un moteur de recherche, et le §7 du gate interdit explicitement
 * de le présenter comme tel. Il enrichit ce qu'une autre source a trouvé.
 */
export function instagramBusinessDiscoveryAccess(credentials = metaCredentials()): SourceAccessState {
  const detail = {
    endpoint: '/{ig-user-id}?fields=business_discovery.username(<username>){...}',
    graphVersion: credentials.graphVersion,
    requiredPermissions: ['instagram_basic', 'pages_read_engagement / pages_show_list'],
    inputRequirement: 'un username professionnel déjà connu — aucune énumération possible',
    returnsContactData: false,
    audit: 'la documentation d’installation',
  };

  if (!credentials.accessToken || !credentials.igUserId) {
    return {
      source: 'instagram_business_discovery',
      status: 'not_configured',
      requirement:
        'OUTBOUND_META_ACCESS_TOKEN + OUTBOUND_META_IG_USER_ID (compte Instagram professionnel Hermes, ' +
        'lié à une Page Facebook Hermes).',
      detail,
    };
  }

  return { source: 'instagram_business_discovery', status: 'available', requirement: null, detail };
}

/**
 * Instagram Hashtag Search.
 *
 * Conclusion de l'audit, et elle ne dépend d'aucune configuration : les
 * endpoints `top_media` / `recent_media` ne renvoient **pas** le propriétaire
 * d'un média qui ne nous appartient pas. Pas de `username`, pas d'identifiant
 * de compte, pas de lien vers un profil. On obtient une légende, une URL de
 * média et un permalien.
 *
 * Il n'existe donc aucun chemin légitime du média vers l'entreprise : le seul
 * qui existe passe par le scraping du permalien, que ce dépôt s'interdit.
 *
 * `not viable for account discovery`. Pas d'adaptateur, pas de rail, pas de
 * « au cas où ». Le §8 du gate demandait exactement cette réponse, et la
 * documenter honnêtement vaut mieux que de livrer un module qui ne trouvera
 * jamais personne.
 */
export function instagramHashtagAccess(credentials = metaCredentials()): SourceAccessState {
  return {
    source: 'instagram_hashtag_search',
    status: 'not_viable',
    requirement: null,
    detail: {
      verdict: 'not viable for account discovery',
      endpoints: ['/ig_hashtag_search', '/{ig-hashtag-id}/top_media', '/{ig-hashtag-id}/recent_media'],
      graphVersion: credentials.graphVersion,
      ownerExposed: false,
      why:
        'les médias tiers ne portent ni username ni identifiant de compte ; passer du média à ' +
        'l’entreprise exigerait de scraper le permalien, ce que ce dépôt refuse',
      alsoNoted: [
        'exige Instagram Public Content Access (App Review + vérification d’entreprise)',
        '30 hashtags distincts par période glissante de 7 jours et par compte',
        'recent_media ne couvre que les 24 dernières heures',
      ],
      audit: 'la documentation d’installation',
    },
  };
}

/** Tous les états Meta, pour l'audit et le rapport de gate. */
export function metaAccessStates(credentials = metaCredentials()): SourceAccessState[] {
  return [
    facebookPagesAccess(credentials),
    instagramBusinessDiscoveryAccess(credentials),
    instagramHashtagAccess(credentials),
  ];
}

/** Levé quand un appel est tenté alors que l'accès n'est pas accordé. */
export class MetaAccessBlockedError extends Error {
  constructor(readonly state: SourceAccessState) {
    super(
      `Accès « ${state.source} » indisponible (${state.status})` +
        (state.requirement ? ` — requis : ${state.requirement}` : ''),
    );
    this.name = 'MetaAccessBlockedError';
  }
}

export async function recordSourceAccess(sql: Sql, state: SourceAccessState): Promise<void> {
  await sql.query(
    `insert into external_source_access (source, status, requirement, detail, checked_at, updated_at)
     values ($1,$2,$3,$4,now(),now())
     on conflict (source) do update
       set status = excluded.status,
           requirement = excluded.requirement,
           detail = excluded.detail,
           checked_at = now(),
           updated_at = now()`,
    [state.source, state.status, state.requirement, JSON.stringify(state.detail)],
  );
}

export async function loadSourceAccess(sql: Sql): Promise<
  { source: string; status: ExternalSourceStatus; requirement: string | null; checked_at: string }[]
> {
  return sql.query(
    'select source, status, requirement, checked_at from external_source_access order by source asc',
  );
}
