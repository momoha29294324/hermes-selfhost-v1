import {
  facebookPagesAccess,
  MetaAccessBlockedError,
  META_GRAPH_BASE,
  metaCredentials,
  type MetaCredentials,
  type SourceAccessState,
} from '@/lib/discovery/meta/access';
import { normalizeUrl } from '@/lib/identity/normalize';
import type { HttpClient } from '@/lib/http/client';
import type { Logger } from '@/lib/logging/logger';

/**
 * Rail A' — Facebook Pages Search.
 *
 * Écrit, testé, et **volontairement inerte** tant que Meta n'a pas accordé
 * Page Public Content Access. Le §5 du gate demandait exactement cela : livrer
 * l'adaptateur, les interfaces, les mocks, les tests et le runbook, puis
 * marquer le rail `BLOCKED_PENDING_META_APP_REVIEW` — plutôt que d'abandonner
 * la mission ou, pire, de tenter l'appel pour voir.
 *
 * L'architecture reprend celle du rail Places, et pour la même raison : les
 * conditions de la plateforme encadrent la conservation des contenus de Page.
 * Une Page trouvée ici n'est donc **pas un prospect**. Elle donne :
 *
 *   - un `pageId`, conservé comme clé de jointure ;
 *   - des indices transitoires (nom, ville, site, téléphone) utilisés comme
 *     *termes de requête* vers des sources dont les réponses nous appartiennent
 *     — le registre français, ou le site de l'entreprise que nous crawlons.
 *
 * Ce qui finit en base est ce que le registre ou le site ont dit. Une Page mal
 * résolue reste candidate (§6).
 *
 * Une limite structurelle mérite d'être lue avant de compter sur ce rail :
 * l'endpoint **ne filtre pas par géographie**. Aucun paramètre officiel de
 * pays, de ville ou de rayon. La restriction géographique ne peut donc
 * s'appliquer qu'après identification, sur l'adresse fournie par la source
 * indépendante — exactement comme le rail Places le fait depuis R2.1.
 */

/** Champs demandés. Tous sont transitoires sauf `id`. */
export const PAGES_SEARCH_FIELDS = [
  'id',
  'name',
  'category',
  'location',
  'website',
  'phone',
  'is_permanently_closed',
] as const;

export interface FacebookPageCandidate {
  /** Le seul champ conservable comme clé de jointure. */
  pageId: string;
  /** INDICES TRANSITOIRES. Utilisables comme termes de requête, jamais persistés tels quels. */
  nameHint: string | null;
  categoryHint: string | null;
  cityHint: string | null;
  postalCodeHint: string | null;
  websiteHint: string | null;
  phoneHint: string | null;
  permanentlyClosed: boolean;
}

export interface PagesSearchResult {
  candidates: FacebookPageCandidate[];
  nextCursor: string | null;
  rawCount: number;
}

interface GraphLocation {
  city?: string | null;
  zip?: string | null;
  country?: string | null;
}

interface GraphPage {
  id?: string;
  name?: string;
  category?: string;
  location?: GraphLocation;
  website?: string;
  phone?: string;
  is_permanently_closed?: boolean;
}

interface GraphResponse {
  data?: GraphPage[];
  paging?: { cursors?: { after?: string }; next?: string };
  error?: { message?: string; type?: string; code?: number; error_subcode?: number };
}

/** Erreur renvoyée par Graph, classée pour que l'appelant sache quoi en faire. */
export class MetaApiError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly kind: 'permission_denied' | 'invalid_token' | 'rate_limited' | 'api_error',
  ) {
    super(message);
    this.name = 'MetaApiError';
  }
}

export function classifyGraphError(code: number | null, message: string): MetaApiError {
  // Codes documentés par Meta. Les distinguer change la conduite à tenir :
  // une permission refusée est définitive pour ce run, une limite de débit ne
  // l'est pas.
  if (code === 190) return new MetaApiError(message, code, 'invalid_token');
  if (code === 200 || code === 10 || code === 3) return new MetaApiError(message, code, 'permission_denied');
  if (code === 4 || code === 17 || code === 32 || code === 613 || code === 80001) {
    return new MetaApiError(message, code, 'rate_limited');
  }
  return new MetaApiError(message, code, 'api_error');
}

/** Traduit une Page Graph en candidat. Renvoie null si l'objet n'a pas d'identifiant. */
export function normalizePageCandidate(page: GraphPage): FacebookPageCandidate | null {
  const pageId = (page.id ?? '').trim();
  if (!pageId) return null;
  return {
    pageId,
    nameHint: page.name?.trim() || null,
    categoryHint: page.category?.trim() || null,
    cityHint: page.location?.city?.trim() || null,
    postalCodeHint: page.location?.zip?.trim() || null,
    websiteHint: normalizeUrl(page.website ?? null),
    phoneHint: page.phone?.trim() || null,
    permanentlyClosed: page.is_permanently_closed === true,
  };
}

export interface FacebookPagesClientOptions {
  http: HttpClient;
  logger: Logger;
  credentials?: MetaCredentials;
  /** Injectable pour les tests, qui ne doivent jamais appeler Meta. */
  access?: SourceAccessState;
}

export class FacebookPagesClient {
  private readonly http: HttpClient;
  private readonly logger: Logger;
  private readonly credentials: MetaCredentials;
  private readonly accessState: SourceAccessState;

  constructor(options: FacebookPagesClientOptions) {
    this.http = options.http;
    this.logger = options.logger;
    this.credentials = options.credentials ?? metaCredentials();
    this.accessState = options.access ?? facebookPagesAccess(this.credentials);
  }

  availability(): SourceAccessState {
    return this.accessState;
  }

  /**
   * Recherche de Pages.
   *
   * Lève `MetaAccessBlockedError` **avant tout appel réseau** quand l'accès
   * n'est pas accordé. Ce n'est pas une précaution défensive, c'est le
   * comportement demandé : appeler un endpoint dont on n'a pas la
   * fonctionnalité pour observer le refus, c'est déjà tester une restriction.
   */
  async searchPages(
    query: string,
    options: { limit?: number; after?: string } = {},
  ): Promise<PagesSearchResult> {
    if (this.accessState.status !== 'available') {
      throw new MetaAccessBlockedError(this.accessState);
    }

    const params = new URLSearchParams({
      q: query,
      type: 'page',
      fields: PAGES_SEARCH_FIELDS.join(','),
      limit: String(Math.min(100, Math.max(1, options.limit ?? 25))),
      access_token: this.credentials.accessToken ?? '',
    });
    if (options.after) params.set('after', options.after);

    const url = `${META_GRAPH_BASE}/${this.credentials.graphVersion}/pages/search?${params.toString()}`;
    // `noCache` : la réponse porte le jeton dans l'URL de cache et du contenu
    // de Page dont la conservation est encadrée. Ni l'un ni l'autre n'a sa
    // place dans `http_cache`.
    const response = await this.http.get(url, { timeoutMs: 20_000, attempts: 2, noCache: true });

    let payload: GraphResponse;
    try {
      payload = JSON.parse(response.body) as GraphResponse;
    } catch {
      throw new MetaApiError(`réponse Graph illisible (HTTP ${response.status})`, null, 'api_error');
    }

    if (payload.error) {
      const error = classifyGraphError(payload.error.code ?? null, payload.error.message ?? 'erreur Graph');
      this.logger.warn('facebook.search_error', { code: error.code, kind: error.kind });
      throw error;
    }
    if (!response.ok) {
      throw new MetaApiError(`Graph HTTP ${response.status}`, null, 'api_error');
    }

    const raw = payload.data ?? [];
    const candidates = raw
      .map((page) => normalizePageCandidate(page))
      .filter((candidate): candidate is FacebookPageCandidate => candidate !== null);

    return {
      candidates,
      nextCursor: payload.paging?.cursors?.after ?? null,
      rawCount: raw.length,
    };
  }
}

/**
 * Ce qu'il faut demander à Meta, écrit une fois pour ne pas être réinventé le
 * jour où quelqu'un ouvre la demande. Repris tel quel dans
 * la documentation d’installation.
 */
export const APP_REVIEW_RUNBOOK = {
  feature: 'Page Public Content Access',
  alsoConsider: 'Page Public Metadata Access — mais PPCA la supersède : une app qui demande PPCA ne peut plus demander PPMA',
  permissions: ['pages_read_engagement (selon la configuration de l’app)'],
  prerequisites: [
    'une application Meta dédiée à Hermes — jamais celle d’un autre projet',
    'vérification d’entreprise (Business Verification) complétée',
    'politique de confidentialité publique et URL de suppression de données',
    'Data Protection Assessment à prévoir une fois l’accès accordé',
  ],
  useCaseToDeclare:
    'Identifier des entreprises de atelier automobile en France à partir de leur Page publique, ' +
    'afin de les recontacter commercialement après résolution de leur identité légale auprès du ' +
    'registre français des entreprises. Aucune donnée personnelle d’utilisateur n’est collectée ; ' +
    'seules des Pages professionnelles publiques sont interrogées.',
  demonstrationAssets: [
    'capture d’écran de l’écran de recherche interne consommant /pages/search',
    'vidéo de bout en bout : requête → candidat → résolution registre → fiche prospect',
    'instructions de test pour le relecteur, avec un compte de démonstration',
  ],
  minimalLiveTestAfterApproval:
    'une requête /pages/search sur un terme métier, limit=25, sur une seule ville, ' +
    'puis vérification que zéro champ de Page est écrit en base hors page_id.',
  knownLimitations: [
    'Aucun filtre géographique officiel : deux paramètres documentés, q et fields. La restriction ' +
      'de zone ne peut être appliquée qu’après identification, sur l’adresse fournie par une source ' +
      'indépendante.',
    'GET /search?type=place, qui portait center/distance, est supprimé depuis le 2020-11-02. ' +
      'GET /search?type=page n’est plus documenté nulle part. Ni l’un ni l’autre ne doit être tenté.',
    'Les limites de débit sont celles de l’app — 200 × nombre d’utilisateurs par heure — ce qui, ' +
      'pour un outil interne à un utilisateur, est un budget très petit.',
  ],
  /**
   * À déclarer sans détour dans la demande, parce que c'est le vrai obstacle.
   *
   * L'usage autorisé publié pour PPCA est « Analyze and/or display posts and
   * engagement on Pages ». Constituer une liste de prospects n'en fait pas
   * partie, et Platform Terms §3.a interdit tout traitement en dehors des
   * usages documentés. Une demande qui décrirait notre besoin comme de
   * l'« analyse concurrentielle » pour cocher la case serait une déclaration
   * fausse — donc la demande doit dire ce que nous faisons et accepter le
   * risque d'un refus.
   */
  usageMismatchToDisclose:
    'L’usage autorisé de PPCA (« Analyze and/or display posts and engagement on Pages ») ne couvre pas ' +
    'la constitution d’une liste de prospects. La demande doit décrire l’usage réel et accepter un refus, ' +
    'plutôt que d’emprunter la formulation « analyse concurrentielle » pour passer la revue.',
} as const;
