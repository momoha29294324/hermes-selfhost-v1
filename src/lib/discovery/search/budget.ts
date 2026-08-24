import { envInt, env } from '@/lib/env';
import type { Sql } from '@/lib/db/sql';

/**
 * Notre propre plafond de dépense chez un moteur de recherche.
 *
 * Le contexte a changé et il faut le dire précisément : Brave a supprimé son
 * palier gratuit en février 2026. Il n'existe plus de « 2 000 requêtes par mois
 * offertes » — un compte reçoit 5 $ de crédit mensuel, soit environ mille
 * requêtes à 5 $ les mille, puis **la carte enregistrée est débitée**. Le
 * garde-fou n'est donc plus une commodité : c'est la seule chose entre une
 * boucle mal écrite et une facture.
 *
 * Il en découle deux principes que ce fichier applique.
 *
 * **Le refus précède l'appel.** `assertCanSpend` est consultée avant qu'une
 * requête ne quitte le processus, jamais après. Rien du côté de Brave ne
 * s'interpose : le crédit gratuit borne ce qui est offert, pas ce qui est
 * appelé.
 *
 * **Le compteur survit au crash.** Les portées jour et mois se lisent dans une
 * table, pas dans une variable : un compteur en mémoire remis à zéro par un
 * redémarrage est exactement le compteur qui laisse passer la deuxième moitié
 * de la facture. Seule la portée « run » est en mémoire, parce qu'un run est
 * précisément ce qui ne survit pas au processus.
 *
 * Un dépassement est un arrêt propre, jamais une nouvelle tentative : la
 * réponse ne peut pas s'améliorer en réessayant.
 */

export type SearchBudgetScope = 'run' | 'daily' | 'monthly';

export class SearchBudgetExceededError extends Error {
  constructor(
    readonly scope: SearchBudgetScope,
    readonly used: number,
    readonly limit: number,
  ) {
    super(`Budget de recherche épuisé : ${scope} ${used}/${limit}. Arrêt propre.`);
    this.name = 'SearchBudgetExceededError';
  }
}

export interface SearchBudgetLimits {
  /** Requêtes que CE run peut émettre. Le mur anti-boucle. */
  run: number;
  daily: number;
  monthly: number;
}

/**
 * Volontairement bas.
 *
 * 200 requêtes par run couvrent le corpus de 53 prospects avec de la marge pour
 * l'escalade, et restent deux ordres de grandeur sous ce qu'une boucle folle
 * atteindrait en une minute. Le plafond mensuel est calé SOUS le crédit gratuit
 * mensuel (~1 000 requêtes) pour que le premier euro dépensé demande une
 * modification délibérée de la configuration, pas un après-midi chargé.
 */
export function searchLimitsFromEnv(): SearchBudgetLimits {
  return {
    run: envInt('OUTBOUND_SEARCH_RUN_LIMIT', 200),
    daily: envInt('OUTBOUND_SEARCH_DAILY_LIMIT', 400),
    monthly: envInt('OUTBOUND_SEARCH_MONTHLY_LIMIT', 900),
  };
}

/**
 * Prix unitaire, en dollars, d'une requête facturée chez Brave.
 *
 * Brave publie 5 $ les 1 000 requêtes. Conservé sous ce nom parce qu'il est le
 * défaut historique de ce module ; la table par fournisseur ci-dessous est ce
 * qu'il faut lire depuis R4-S.
 */
export const SEARCH_PRICE_USD_PER_1000 = 5;

/** Crédit mensuel offert par Brave, en dollars. */
export const SEARCH_FREE_CREDIT_USD_PER_MONTH = 5;

/**
 * Ce qu'un fournisseur coûte, et sous quelle forme il offre.
 *
 * R4-S a rendu cette table nécessaire : comparer Brave et Serper avec un prix
 * unitaire codé en dur pour Brave ferait dire au rapport que Serper coûte
 * 5 $ les 1 000, soit **cinq fois son tarif d'entrée réel**. Un A/B dont la
 * colonne « coût » est fausse pour une des deux branches ne mesure rien.
 *
 * Les deux modèles d'offre sont différents en nature, et les confondre serait la
 * seconde erreur :
 *
 *   — Brave offre 5 $ **par mois**, qui se reconstituent. Le compteur pertinent
 *     est mensuel, et c'est celui que `snapshot()` publiait déjà ;
 *   — Serper offre 2 500 requêtes **une seule fois**, à l'ouverture du compte,
 *     sans carte bancaire. Le compteur pertinent est donc cumulé depuis le
 *     début, pas remis à zéro le 1er du mois. Publier un « crédit mensuel
 *     restant » pour Serper laisserait croire à une allocation qui revient.
 */
export interface SearchProviderPricing {
  /** Tarif d'entrée publié, en dollars les 1 000 requêtes. */
  usdPer1000: number;
  /** Crédit offert chaque mois, en dollars. Zéro quand le modèle est un one-shot. */
  freeUsdPerMonth: number;
  /** Requêtes offertes une seule fois à l'ouverture du compte. Zéro sinon. */
  freeQueriesOneOff: number;
  /** L'endpoint réellement appelé — recopié dans le rapport, jamais deviné. */
  endpoint: string;
  /** Une phrase citable dans un rapport, avec la date de vérification. */
  note: string;
}

/**
 * Vérifié le 10 août 2026. Voir la documentation d’installation §2 pour les sources et la
 * part de ces chiffres qui vient d'une page publique plutôt que du tableau de
 * bord (la page `serper.dev/pricing` répond 404 ; les paliers ne sont visibles
 * qu'après création de compte).
 */
export const SEARCH_PROVIDER_PRICING: Record<string, SearchProviderPricing> = {
  brave: {
    usdPer1000: SEARCH_PRICE_USD_PER_1000,
    freeUsdPerMonth: SEARCH_FREE_CREDIT_USD_PER_MONTH,
    freeQueriesOneOff: 0,
    endpoint: 'https://api.search.brave.com/res/v1/web/search',
    note: 'Brave Search API — 5 $ les 1 000 requêtes, 5 $ de crédit mensuel offert (palier gratuit supprimé en février 2026).',
  },
  serper: {
    usdPer1000: 1,
    freeUsdPerMonth: 0,
    freeQueriesOneOff: 2_500,
    endpoint: 'https://google.serper.dev/search',
    note: 'Serper — crédits prépayés, 1 $ les 1 000 requêtes au palier d’entrée (50 $ / 50 000), 2 500 requêtes offertes une fois, sans carte.',
  },
};

/** Le tarif d'un fournisseur, ou celui de Brave si nous n'en connaissons pas d'autre. */
export function searchPricing(provider: string): SearchProviderPricing {
  return SEARCH_PROVIDER_PRICING[provider.toLowerCase()] ?? SEARCH_PROVIDER_PRICING.brave!;
}

/**
 * Prix unitaire d'une requête facturée, en dollars.
 *
 * Le paramètre est optionnel et le défaut reste Brave : les appelants d'avant
 * R4-S continuent de dire la vérité sans être modifiés.
 */
export function searchPriceUsdPerQuery(provider = 'brave'): number {
  return searchPricing(provider).usdPer1000 / 1000;
}

export interface SearchUsageRecord {
  provider: string;
  /** Notre requête, que nous avons écrite nous-mêmes. Jamais un résultat. */
  query: string;
  queryVariant: string;
  prospectId: string | null;
  /** Nombre de résultats reçus — un entier, pas leur contenu. */
  resultsCount: number;
  /** Candidats retenus après filtrage annuaire/plateforme. */
  candidatesKept: number;
  /**
   * Vrai quand la requête a été évitée : déjà posée pour ce prospect lors d'un
   * run précédent, ou rendue inutile par un résultat suffisant en amont.
   */
  avoided: boolean;
  avoidedReason: string | null;
  billable: boolean;
  httpStatus: number | null;
  latencyMs: number | null;
  error: string | null;
}

export interface SearchBudgetOptions {
  sql: Sql;
  provider: string;
  campaignSlug: string | null;
  runId: string | null;
  limits?: SearchBudgetLimits;
  /** Injecté pour qu'un test traverse une frontière de mois sans attendre. */
  now?: () => Date;
}

export interface SearchBudgetSnapshot {
  runCalls: number;
  dailyCalls: number;
  monthlyCalls: number;
  avoided: number;
  limits: SearchBudgetLimits;
  estimatedUsdThisRun: number;
  estimatedUsdThisMonth: number;
  /** Ce qui reste du crédit mensuel offert, en dollars. Négatif = facturé. */
  freeCreditRemainingUsd: number;
  /**
   * Requêtes facturables déjà émises chez ce fournisseur depuis toujours.
   *
   * Le mois ne veut rien dire face à une allocation offerte une seule fois : ce
   * qui reste des 2 500 requêtes Serper se compte depuis le premier appel, pas
   * depuis le 1er du mois.
   */
  lifetimeCalls: number;
  /**
   * Ce qui reste de l'allocation offerte une seule fois. `null` quand le
   * fournisseur n'en propose pas — dire « 0 » laisserait croire qu'elle est
   * épuisée alors qu'elle n'a jamais existé.
   */
  freeQueriesRemaining: number | null;
  pricing: SearchProviderPricing;
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcMonthStart(date: Date): string {
  return `${date.toISOString().slice(0, 7)}-01`;
}

export class SearchBudget {
  private readonly sql: Sql;
  private readonly provider: string;
  private readonly campaignSlug: string | null;
  private readonly runId: string | null;
  private readonly now: () => Date;
  readonly limits: SearchBudgetLimits;

  private runCalls = 0;
  private avoided = 0;
  private stopped: SearchBudgetExceededError | null = null;

  constructor(options: SearchBudgetOptions) {
    this.sql = options.sql;
    this.provider = options.provider;
    this.campaignSlug = options.campaignSlug;
    this.runId = options.runId;
    this.limits = options.limits ?? searchLimitsFromEnv();
    this.now = options.now ?? ((): Date => new Date());
  }

  /** Vrai dès que le budget a refusé une requête ; les appelants cessent de demander. */
  get exhausted(): boolean {
    return this.stopped !== null;
  }

  get stopReason(): SearchBudgetExceededError | null {
    return this.stopped;
  }

  get callsThisRun(): number {
    return this.runCalls;
  }

  /**
   * Demande l'autorisation d'émettre une requête. Lève avant tout appel réseau.
   *
   * L'ordre des trois portées n'est pas indifférent : la portée run est en
   * mémoire et gratuite à consulter, les deux autres coûtent une lecture SQL.
   * Le mur anti-boucle est donc aussi le moins cher à heurter.
   */
  async assertCanSpend(): Promise<void> {
    if (this.stopped) throw this.stopped;

    if (this.runCalls >= this.limits.run) {
      throw this.stop(new SearchBudgetExceededError('run', this.runCalls, this.limits.run));
    }

    const now = this.now();
    const daily = await this.countSince(utcDay(now));
    if (daily >= this.limits.daily) {
      throw this.stop(new SearchBudgetExceededError('daily', daily, this.limits.daily));
    }

    const monthly = await this.countSince(utcMonthStart(now));
    if (monthly >= this.limits.monthly) {
      throw this.stop(new SearchBudgetExceededError('monthly', monthly, this.limits.monthly));
    }
  }

  private stop(error: SearchBudgetExceededError): SearchBudgetExceededError {
    this.stopped = error;
    return error;
  }

  /**
   * Écrit une ligne par requête — émise, évitée ou en échec.
   *
   * Les requêtes évitées sont consignées avec `billable = false`, parce que
   * « combien la stratégie progressive a-t-elle épargné » est le nombre qui
   * justifie sa complexité, et il n'est crédible que s'il sort du même registre
   * que la dépense.
   */
  async record(record: SearchUsageRecord): Promise<void> {
    if (record.billable) this.runCalls += 1;
    if (record.avoided) this.avoided += 1;

    await this.sql.query(
      `insert into search_provider_usage
         (provider, campaign_slug, run_id, prospect_id, query, query_variant,
          results_count, candidates_kept, avoided, avoided_reason, billable,
          http_status, latency_ms, error)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        record.provider,
        this.campaignSlug,
        this.runId,
        record.prospectId,
        record.query,
        record.queryVariant,
        record.resultsCount,
        record.candidatesKept,
        record.avoided,
        record.avoidedReason,
        record.billable,
        record.httpStatus,
        record.latencyMs,
        record.error,
      ],
    );
  }

  private async countSince(fromDate: string): Promise<number> {
    const rows = await this.sql.query<{ count: string }>(
      `select count(*)::text as count from search_provider_usage
        where billable = true and provider = $1 and occurred_on >= $2::date`,
      [this.provider, fromDate],
    );
    return Number.parseInt(rows[0]?.count ?? '0', 10) || 0;
  }

  async snapshot(): Promise<SearchBudgetSnapshot> {
    const now = this.now();
    const monthlyCalls = await this.countSince(utcMonthStart(now));
    const lifetimeCalls = await this.countSince('1970-01-01');
    const pricing = searchPricing(this.provider);
    const unit = pricing.usdPer1000 / 1000;
    return {
      runCalls: this.runCalls,
      dailyCalls: await this.countSince(utcDay(now)),
      monthlyCalls,
      avoided: this.avoided,
      limits: this.limits,
      estimatedUsdThisRun: Number((this.runCalls * unit).toFixed(4)),
      estimatedUsdThisMonth: Number((monthlyCalls * unit).toFixed(4)),
      freeCreditRemainingUsd: Number((pricing.freeUsdPerMonth - monthlyCalls * unit).toFixed(4)),
      lifetimeCalls,
      freeQueriesRemaining:
        pricing.freeQueriesOneOff > 0 ? pricing.freeQueriesOneOff - lifetimeCalls : null,
      pricing,
    };
  }
}

/**
 * Le nom de la variable qui porte la clé Brave.
 *
 * Deux noms coexistent et c'est assumé : l'adaptateur d'origine lisait
 * `OUTBOUND_BRAVE_API_KEY`, la mission R4 et le `.env` de la machine portent
 * `OUTBOUND_BRAVE_SEARCH_KEY`. Renommer sans compatibilité casserait une
 * configuration existante ; ignorer le nouveau nom ferait échouer un run alors
 * que la clé est là. On lit donc les deux, le nom explicite d'abord, et la
 * fonction dit lequel a répondu pour que le rapport ne soit pas ambigu.
 *
 * Elle ne retourne jamais la clé.
 */
export function braveKeyVariable(): { name: string; present: boolean } {
  for (const name of ['OUTBOUND_BRAVE_SEARCH_KEY', 'OUTBOUND_BRAVE_API_KEY']) {
    if (env(name)) return { name, present: true };
  }
  return { name: 'OUTBOUND_BRAVE_SEARCH_KEY', present: false };
}

export function braveKey(): string | undefined {
  return env('OUTBOUND_BRAVE_SEARCH_KEY') ?? env('OUTBOUND_BRAVE_API_KEY');
}

/**
 * La clé Serper, sous le nom que ce dépôt lui donne déjà.
 *
 * `OUTBOUND_SERPER_API_KEY` est le nom canonique depuis l'adaptateur d'origine,
 * et la mission R4-S recommandait exactement celui-là. Il n'y a donc rien à
 * renommer, et un alias supplémentaire n'ajouterait qu'un endroit où se tromper.
 *
 * Le préfixe `OUTBOUND_` n'est pas décoratif : il est ce qui garantit qu'aucune
 * clé d'un autre projet de cette machine ne peut être ramassée par accident.
 *.
 */
export function serperKeyVariable(): { name: string; present: boolean } {
  return { name: 'OUTBOUND_SERPER_API_KEY', present: Boolean(env('OUTBOUND_SERPER_API_KEY')) };
}

export function serperKey(): string | undefined {
  return env('OUTBOUND_SERPER_API_KEY');
}

/**
 * Le nom de la variable qui porte la clé d'un fournisseur donné.
 *
 * Existe parce que le benchmark affichait `braveKeyVariable()` quel que soit le
 * `--provider` : un run Serper annonçait « clé ABSENTE (OUTBOUND_BRAVE_SEARCH_KEY) »
 * et renvoyait vers le tableau de bord de Brave. Sur un A/B, un message qui
 * désigne le mauvais fournisseur ne fait pas perdre une minute, il fait conclure
 * à tort.
 */
export function searchKeyVariable(provider: string): { name: string; present: boolean } {
  switch (provider.toLowerCase()) {
    case 'serper':
      return serperKeyVariable();
    case 'brave':
      return braveKeyVariable();
    default:
      return { name: `OUTBOUND_${provider.toUpperCase()}_API_KEY`, present: false };
  }
}
