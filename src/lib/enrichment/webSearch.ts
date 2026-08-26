import { env } from '@/lib/env';
import { HttpClient, HttpError } from '@/lib/http/client';
import { isPlatformDomain, normalizeDomain, nameSimilarity } from '@/lib/identity/normalize';
import { WebIntelSearchProvider } from '@/lib/enrichment/webintel';
import { braveKey, braveKeyVariable, serperKey, serperKeyVariable } from '@/lib/discovery/search/budget';
import type { Logger } from '@/lib/logging/logger';

/**
 * Web search port used to find a business's own website and socials.
 *
 * Deliberately key-gated. There is no key-free provider here on purpose: the
 * key-free options all require scraping a search engine whose robots.txt forbids
 * it, and this project does not ship anything that circumvents a platform's
 * stated rules. With OUTBOUND_SEARCH_PROVIDER=none the pipeline simply records
 * "no source available" for the website of prospects that have none in the open
 * registries — it never guesses a domain.
 *
 * Setting OUTBOUND_SEARCH_PROVIDER=brave|serper|google_cse plus the matching key
 * unlocks website + Instagram discovery for every prospect, with no code change.
 */
export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
}

export interface WebSearchProvider {
  readonly name: string;
  availability(): { ok: boolean; reason?: string };
  search(query: string, limit: number): Promise<SearchHit[]>;
}

/**
 * Pourquoi une recherche a échoué, en une valeur exploitable.
 *
 * Un rail réagit très différemment selon le motif, et lire un code HTTP dans un
 * message d'erreur pour décider n'est pas une façon de tenir cette différence :
 *
 *   `auth`      — la clé est absente, révoquée ou refusée. Rien ne s'améliorera
 *                 en réessayant, et surtout : rien ne s'améliorera pour les 52
 *                 prospects suivants. Le run s'arrête.
 *   `quota`     — cadence ou crédit dépassés chez le fournisseur. Notre propre
 *                 garde-fou aurait dû arriver avant ; si nous sommes ici, c'est
 *                 lui qu'il faut corriger, pas la requête qu'il faut répéter.
 *   `timeout`   — pas de réponse à temps. Le prospect est perdu, pas le run.
 *   `transport` — tout le reste.
 */
export type SearchFailureKind = 'auth' | 'quota' | 'timeout' | 'transport';

export class SearchProviderError extends Error {
  constructor(
    readonly kind: SearchFailureKind,
    readonly provider: string,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'SearchProviderError';
  }

  /** Vrai quand insister est inutile pour tout le reste du run. */
  get fatal(): boolean {
    return this.kind === 'auth';
  }
}

/**
 * Traduit un échec HTTP en motif.
 *
 * 401 et 403 disent tous deux « pas avec cette clé » ; 429 dit « pas
 * maintenant ». Les distinguer est ce qui permet à un run de s'arrêter net dans
 * le premier cas au lieu de payer 52 refus.
 */
export function classifySearchFailure(error: unknown, provider: string): SearchProviderError {
  if (error instanceof SearchProviderError) return error;

  if (error instanceof HttpError) {
    const status = error.status;
    if (status === 401 || status === 403) {
      return new SearchProviderError('auth', provider, `clé refusée (HTTP ${status})`, status);
    }
    if (status === 429) {
      return new SearchProviderError('quota', provider, 'cadence ou crédit dépassés (HTTP 429)', status);
    }
    return new SearchProviderError('transport', provider, error.message, status ?? null);
  }

  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out|abort/i.test(message)) {
    return new SearchProviderError('timeout', provider, message);
  }
  return new SearchProviderError('transport', provider, message);
}

class NoopSearchProvider implements WebSearchProvider {
  readonly name = 'none';
  availability() {
    return { ok: false, reason: 'OUTBOUND_SEARCH_PROVIDER=none' };
  }
  async search(): Promise<SearchHit[]> {
    return [];
  }
}

export const SERPER_ENDPOINT = 'https://google.serper.dev/search';

/**
 * Nombre maximal de résultats qu'un compte gratuit a le droit de demander.
 *
 * Ce n'est pas une préférence, c'est un refus du fournisseur, constaté à la
 * source le 10 août 2026 : `num: 20` répond
 *
 *   `400 {"message":"Query pattern not allowed for free accounts."}`
 *
 * La conséquence à retenir dépasse le plafond lui-même. Sans cette borne, un
 * `--results 20` — la valeur que `BRAVE_MAX_COUNT` autorise, donc la première
 * qu'un opérateur essaierait pour « donner sa chance » à Serper — ferait échouer
 * *toutes* les requêtes du run avec un 400 classé `transport`, prospect après
 * prospect. Le rapport conclurait « Serper ne trouve rien » alors que Serper n'a
 * jamais été interrogé. Le clamp rend ce faux verdict impossible.
 *
 * Il aligne aussi les deux branches de l'A/B sur 10 résultats par requête, ce
 * qui est la seule façon de comparer un taux de bruit.
 */
export const SERPER_MAX_NUM_FREE = 10;

/**
 * Serper, audité et durci pour R4-S.
 *
 * L'adaptateur d'origine datait de R1 et n'avait jamais servi. Le benchmark le
 * met pour la première fois sur le chemin d'un run payant, ce qui a rendu
 * visibles trois défauts dont un seul comptait vraiment :
 *
 * **`if (!res.ok) return []` était le défaut grave.** `HttpClient.request` ne
 * lève que sur 429 et 5xx ; un 403 « Unauthorized » revient comme une réponse
 * normale avec `ok = false`. L'ancien code le traduisait donc en « zéro
 * résultat ». Une clé absente ou révoquée n'aurait pas arrêté le run : elle
 * aurait produit cinquante prospects sans aucun résultat, un rapport
 * parfaitement bien formé, et la conclusion « Serper : FAIL ». C'est le pire
 * mode de défaillance qu'un banc d'essai puisse avoir — il ne se plante pas, il
 * ment. Le rail sait déjà s'arrêter net sur un `auth` (`SearchProviderError.fatal`) ;
 * encore fallait-il le lui dire.
 *
 * Les deux autres sont mineurs et corrigés au passage : `attempts` alignés sur
 * Brave pour que les latences soient comparables, et `noCache` explicite.
 *
 * ### Sur `noCache`, et pourquoi il est mis alors qu'il ne sert à rien
 *
 * `HttpClient` ne lit et n'écrit son cache que pour les `GET` ; Serper est
 * interrogé en `POST`, donc rien n'est écrit aujourd'hui même sans le drapeau.
 * Il est posé quand même, pour deux raisons.
 *
 * La première est qu'une propriété de conformité ne doit pas reposer sur un
 * invariant situé dans un autre fichier : le jour où `HttpClient` cachera les
 * `POST` — un changement raisonnable, que personne ne relierait à Serper — la
 * régression serait silencieuse.
 *
 * La seconde est que les conditions de Serper, contrairement à celles de Brave,
 * **n'interdisent pas** de stocker les résultats.
 * Nous ne les stockons pas davantage pour autant, et c'est délibéré : la règle
 * qui nous l'interdit n'est pas contractuelle, elle est la règle 2 du dépôt —
 * une preuve doit être quelque chose que nous avons vu, pas quelque chose qu'on
 * nous a résumé. Relâcher la règle pour Serper aurait aussi rendu l'A/B
 * incomparable, en donnant à une branche une mémoire que l'autre n'a pas.
 */
class SerperProvider implements WebSearchProvider {
  readonly name = 'serper';

  /**
   * Crédits réellement facturés, tels que Serper les déclare dans sa réponse.
   *
   * Serper renvoie un champ `credits` par appel — Brave n'a pas d'équivalent.
   * C'est une dépense **mesurée** là où le reste du module estime, et le
   * benchmark s'en sert pour vérifier son propre calcul plutôt que pour le
   * remplacer : si les deux divergent, c'est notre modèle de coût qui est faux.
   */
  private creditsCharged = 0;
  private creditedCalls = 0;

  constructor(private readonly http: HttpClient) {}

  get observedCredits(): { credits: number; calls: number } {
    return { credits: this.creditsCharged, calls: this.creditedCalls };
  }

  availability() {
    const variable = serperKeyVariable();
    return variable.present ? { ok: true } : { ok: false, reason: `${variable.name} is not set` };
  }

  async search(query: string, limit: number): Promise<SearchHit[]> {
    const key = serperKey();
    if (!key) {
      throw new SearchProviderError('auth', this.name, `${serperKeyVariable().name} is not set`);
    }

    const num = Math.max(1, Math.min(SERPER_MAX_NUM_FREE, limit));

    let res;
    try {
      res = await this.http.request(SERPER_ENDPOINT, {
        method: 'POST',
        body: JSON.stringify({ q: query, gl: 'fr', hl: 'fr', num }),
        headers: { 'content-type': 'application/json', 'x-api-key': key },
        timeoutMs: 20_000,
        attempts: 2,
        noCache: true,
      });
    } catch (error) {
      throw classifySearchFailure(error, this.name);
    }

    /**
     * Un 4xx revient ici comme une réponse, pas comme une exception. Le traduire
     * en `HttpError` puis en `SearchProviderError` est ce qui rend un 403
     * fatal — voir le préambule de cette classe.
     */
    if (!res.ok) {
      throw classifySearchFailure(new HttpError(`HTTP ${res.status}`, res.status, SERPER_ENDPOINT), this.name);
    }

    let payload: {
      organic?: { link?: string; title?: string; snippet?: string }[];
      credits?: number;
    };
    try {
      payload = JSON.parse(res.body) as typeof payload;
    } catch {
      throw new SearchProviderError('transport', this.name, 'réponse JSON illisible', res.status);
    }

    if (typeof payload.credits === 'number') {
      this.creditsCharged += payload.credits;
      this.creditedCalls += 1;
    }

    return (payload.organic ?? [])
      .filter((item): item is { link: string; title?: string; snippet?: string } => Boolean(item.link))
      .map((item) => ({ url: item.link, title: item.title ?? '', snippet: item.snippet ?? '' }));
  }
}

/** Les crédits mesurés, quand le fournisseur sait les déclarer. */
export function observedCredits(provider: WebSearchProvider): { credits: number; calls: number } | null {
  return provider instanceof SerperProvider ? provider.observedCredits : null;
}

/** `count` maximal documenté par Brave. Au-delà, l'API refuse la requête. */
export const BRAVE_MAX_COUNT = 20;

class BraveProvider implements WebSearchProvider {
  readonly name = 'brave';
  constructor(private readonly http: HttpClient) {}

  availability() {
    const variable = braveKeyVariable();
    return variable.present
      ? { ok: true }
      : { ok: false, reason: `${variable.name} is not set` };
  }

  async search(query: string, limit: number): Promise<SearchHit[]> {
    const key = braveKey();
    if (!key) {
      throw new SearchProviderError('auth', this.name, `${braveKeyVariable().name} is not set`);
    }

    const count = Math.max(1, Math.min(BRAVE_MAX_COUNT, limit));
    const url =
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}` +
      `&count=${count}&country=fr&search_lang=fr`;

    let payload: { web?: { results?: { url?: string; title?: string; description?: string }[] } };
    try {
      payload = await this.http.getJson(url, {
        headers: { accept: 'application/json', 'x-subscription-token': key },
        timeoutMs: 20_000,
        attempts: 2,
        /**
         * Obligatoire, et pour une raison de conditions d'utilisation plutôt que
         * de performance : sans ce drapeau, `HttpClient` écrit la réponse JSON
         * entière dans `http_cache`, ce qui constitue exactement la « database of
         * Search Results » que les conditions Brave interdisent. Le drapeau coupe
         * la lecture ET l'écriture depuis R2.1. Voir `search/terms.ts`.
         */
        noCache: true,
      });
    } catch (error) {
      throw classifySearchFailure(error, this.name);
    }

    return (payload.web?.results ?? [])
      .filter((item): item is { url: string; title?: string; description?: string } => Boolean(item.url))
      .map((item) => ({ url: item.url, title: item.title ?? '', snippet: item.description ?? '' }));
  }
}

/**
 * Google Custom Search — conservé, non candidat.
 *
 * R4 a évalué ce fournisseur sur documents plutôt que sur code, et la conclusion
 * est de ne pas y investir davantage. Deux raisons, dans cet ordre :
 *
 *   - le produit vise la recherche *dans un ensemble de sites que l'on désigne*.
 *     Nous cherchons l'inverse : un site dont nous ignorons l'existence. Utiliser
 *     CSE pour cela demande de le configurer à « chercher tout le web », un mode
 *     dégradé de son propre objet ;
 *   - 100 requêtes gratuites par jour puis 5 $ les 1 000, plafonné à 10 000 par
 *     jour, pour un index qui n'est pas celui de Google Search.
 *
 * L'adaptateur reste en place : le supprimer casserait
 * `OUTBOUND_SEARCH_PROVIDER=google_cse` pour rien, et coûterait une régression
 * là où un commentaire suffit. Il n'est simplement plus une piste.
 *
 * @deprecated Non candidat pour R4..
 */
class GoogleCseProvider implements WebSearchProvider {
  readonly name = 'google_cse';
  constructor(private readonly http: HttpClient) {}
  availability() {
    if (!env('OUTBOUND_GOOGLE_CSE_KEY')) return { ok: false, reason: 'OUTBOUND_GOOGLE_CSE_KEY is not set' };
    if (!env('OUTBOUND_GOOGLE_CSE_CX')) return { ok: false, reason: 'OUTBOUND_GOOGLE_CSE_CX is not set' };
    return { ok: true };
  }
  async search(query: string, limit: number): Promise<SearchHit[]> {
    const url =
      `https://www.googleapis.com/customsearch/v1?key=${env('OUTBOUND_GOOGLE_CSE_KEY')}` +
      `&cx=${env('OUTBOUND_GOOGLE_CSE_CX')}&q=${encodeURIComponent(query)}&num=${Math.min(10, limit)}&gl=fr&hl=fr`;
    const payload = await this.http.getJson<{ items?: { link?: string; title?: string; snippet?: string }[] }>(
      url,
      { timeoutMs: 20_000 },
    );
    return (payload.items ?? [])
      .filter((item): item is { link: string; title?: string; snippet?: string } => Boolean(item.link))
      .map((item) => ({ url: item.link, title: item.title ?? '', snippet: item.snippet ?? '' }));
  }
}

/**
 * Construit le fournisseur de recherche.
 *
 * `override` existe pour l'A/B du §14 du gate R4 : comparer deux moteurs exige
 * de pouvoir en choisir un pour UN run sans toucher à `OUTBOUND_SEARCH_PROVIDER`,
 * qui gouverne le reste du pipeline — le rail R3 s'en sert pour joindre le
 * WebIntel auto-hébergé, et le basculer globalement pour lancer un benchmark
 * changerait silencieusement le comportement de tout le reste.
 *
 * Un run explicite est aussi plus honnête dans un rapport : « lancé avec
 * --provider brave » se vérifie, « la variable valait brave à ce moment-là » non.
 */
export function createWebSearchProvider(http: HttpClient, override?: string): WebSearchProvider {
  switch ((override ?? (env('OUTBOUND_SEARCH_PROVIDER', 'none') as string)).toLowerCase()) {
    case 'webintel':
      // Self-hosted: SearXNG + our own crawler. No key, no cost.
      return new WebIntelSearchProvider(http);
    case 'serper':
      return new SerperProvider(http);
    case 'brave':
      return new BraveProvider(http);
    case 'google_cse':
      return new GoogleCseProvider(http);
    default:
      return new NoopSearchProvider();
  }
}

export interface WebsiteGuess {
  url: string;
  domain: string;
  confidence: number;
  reason: string;
}

/**
 * Picks the best candidate for "this business's own website" from search hits.
 * Returns null rather than a weak guess: a wrong website poisons every downstream
 * fact, so the bar is high and the reasoning is recorded.
 */
export function pickWebsite(hits: SearchHit[], businessName: string, city: string | null): WebsiteGuess | null {
  let best: WebsiteGuess | null = null;

  for (const hit of hits) {
    const domain = normalizeDomain(hit.url);
    if (!domain || isPlatformDomain(domain)) continue;

    const domainCore = domain.split('.')[0] ?? '';
    const nameScore = Math.max(
      nameSimilarity(businessName, hit.title),
      nameSimilarity(businessName, domainCore.replace(/-/g, ' ')),
    );
    const cityBonus = city && `${hit.title} ${hit.snippet}`.toLowerCase().includes(city.toLowerCase()) ? 0.1 : 0;
    const confidence = Math.min(1, nameScore + cityBonus);

    if (confidence >= 0.6 && (!best || confidence > best.confidence)) {
      best = {
        url: hit.url,
        domain,
        confidence,
        reason: `titre/domaine proches du nom (${confidence.toFixed(2)})${cityBonus ? ' + ville citée' : ''}`,
      };
    }
  }

  return best;
}

export async function findWebsiteFor(
  provider: WebSearchProvider,
  logger: Logger,
  businessName: string,
  city: string | null,
): Promise<{ guess: WebsiteGuess | null; hits: SearchHit[]; skipped: string | null }> {
  const availability = provider.availability();
  if (!availability.ok) return { guess: null, hits: [], skipped: availability.reason ?? 'unavailable' };

  const query = city ? `${businessName} ${city} atelier` : `${businessName} atelier`;
  try {
    const hits = await provider.search(query, 8);
    return { guess: pickWebsite(hits, businessName, city), hits, skipped: null };
  } catch (error) {
    logger.warn('websearch.failed', {
      provider: provider.name,
      error: error instanceof Error ? error.message : String(error),
    });
    return { guess: null, hits: [], skipped: 'search_failed' };
  }
}
