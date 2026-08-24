import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import {
  SEARCH_FREE_CREDIT_USD_PER_MONTH,
  SearchBudget,
  SearchBudgetExceededError,
  braveKey,
  braveKeyVariable,
  searchLimitsFromEnv,
  searchPriceUsdPerQuery,
  type SearchBudgetLimits,
  type SearchUsageRecord,
} from '@/lib/discovery/search/budget';
import type { Sql } from '@/lib/db/sql';

/**
 * Brave a supprimé son palier gratuit en février 2026 : il n'y a plus 2 000
 * requêtes offertes par mois, il y a 5 $ de crédit puis un débit sur la carte
 * enregistrée. Ce garde-fou est donc la seule chose entre une boucle mal écrite
 * et une facture.
 *
 * La propriété qui le rend réel, et que ce fichier protège : il décide depuis un
 * registre PERSISTANT. Un compteur en mémoire remis à zéro par un redémarrage
 * est exactement celui qui laisse passer la deuxième moitié de la dépense.
 */

let sql: Sql;
let dir: string;

function limits(overrides: Partial<SearchBudgetLimits> = {}): SearchBudgetLimits {
  return { run: 10, daily: 20, monthly: 50, ...overrides };
}

function usage(overrides: Partial<SearchUsageRecord> = {}): SearchUsageRecord {
  return {
    provider: 'brave',
    query: '"Éclat Auto" Lyon',
    queryVariant: 'name_city',
    prospectId: null,
    resultsCount: 8,
    candidatesKept: 2,
    avoided: false,
    avoidedReason: null,
    billable: true,
    httpStatus: 200,
    latencyMs: 210,
    error: null,
    ...overrides,
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'search-budget-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);
});

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await sql.query('delete from search_provider_usage');
});

describe('SearchBudget — portée run', () => {
  it('autorise jusqu’au plafond puis refuse', async () => {
    const budget = new SearchBudget({ sql, provider: 'brave', campaignSlug: null, runId: null, limits: limits({ run: 2 }) });

    await budget.assertCanSpend();
    await budget.record(usage());
    await budget.assertCanSpend();
    await budget.record(usage());

    await expect(budget.assertCanSpend()).rejects.toThrow(SearchBudgetExceededError);
    expect(budget.exhausted).toBe(true);
    expect(budget.stopReason?.scope).toBe('run');
  });

  /**
   * Une fois que le budget a dit non, il ne doit plus être consulté : la réponse
   * ne peut pas s'améliorer. Le drapeau `exhausted` existe pour que l'appelant
   * cesse de demander plutôt que de réessayer.
   */
  it('reste refusé une fois épuisé', async () => {
    const budget = new SearchBudget({ sql, provider: 'brave', campaignSlug: null, runId: null, limits: limits({ run: 0 }) });
    await expect(budget.assertCanSpend()).rejects.toThrow(SearchBudgetExceededError);
    await expect(budget.assertCanSpend()).rejects.toThrow(SearchBudgetExceededError);
  });

  it('ne compte pas une requête évitée contre le plafond', async () => {
    const budget = new SearchBudget({ sql, provider: 'brave', campaignSlug: null, runId: null, limits: limits({ run: 1 }) });
    await budget.record(usage({ avoided: true, billable: false, avoidedReason: 'déjà posée' }));
    await budget.record(usage({ avoided: true, billable: false, avoidedReason: 'déjà posée' }));
    // Aucune dépense : le run peut encore émettre sa requête.
    await expect(budget.assertCanSpend()).resolves.toBeUndefined();
  });
});

describe('SearchBudget — portées persistantes', () => {
  /**
   * Le test qui compte : un nouveau `SearchBudget` — donc un compteur run à
   * zéro, comme après un crash — se heurte quand même au plafond journalier
   * parce qu'il le lit dans la table.
   */
  it('un run neuf hérite de la dépense du jour', async () => {
    const first = new SearchBudget({ sql, provider: 'brave', campaignSlug: null, runId: null, limits: limits({ daily: 3 }) });
    for (let i = 0; i < 3; i += 1) {
      await first.assertCanSpend();
      await first.record(usage());
    }

    const second = new SearchBudget({ sql, provider: 'brave', campaignSlug: null, runId: null, limits: limits({ daily: 3 }) });
    expect(second.callsThisRun).toBe(0);
    await expect(second.assertCanSpend()).rejects.toThrow(SearchBudgetExceededError);
    expect(second.stopReason?.scope).toBe('daily');
  });

  it('applique le plafond mensuel', async () => {
    const budget = new SearchBudget({
      sql,
      provider: 'brave',
      campaignSlug: null,
      runId: null,
      limits: limits({ run: 100, daily: 100, monthly: 2 }),
    });
    await budget.assertCanSpend();
    await budget.record(usage());
    await budget.assertCanSpend();
    await budget.record(usage());
    await expect(budget.assertCanSpend()).rejects.toThrow(SearchBudgetExceededError);
    expect(budget.stopReason?.scope).toBe('monthly');
  });

  /** La dépense d'un autre fournisseur n'entame pas le budget de celui-ci. */
  it('cloisonne par fournisseur', async () => {
    const brave = new SearchBudget({ sql, provider: 'brave', campaignSlug: null, runId: null, limits: limits({ daily: 1 }) });
    await brave.record(usage({ provider: 'serper' }));
    await expect(brave.assertCanSpend()).resolves.toBeUndefined();
  });

  it('ne compte ni les échecs non facturés ni les requêtes évitées', async () => {
    const budget = new SearchBudget({ sql, provider: 'brave', campaignSlug: null, runId: null, limits: limits({ daily: 1 }) });
    await budget.record(usage({ billable: false, error: 'auth: clé refusée', httpStatus: 401 }));
    await budget.record(usage({ billable: false, avoided: true, avoidedReason: 'budget' }));
    await expect(budget.assertCanSpend()).resolves.toBeUndefined();
  });
});

describe('SearchBudget — registre et coût', () => {
  it('écrit une ligne par requête, évitée comprise', async () => {
    const budget = new SearchBudget({ sql, provider: 'brave', campaignSlug: 'example-campaign', runId: null, limits: limits() });
    await budget.record(usage());
    await budget.record(usage({ avoided: true, billable: false, avoidedReason: 'déjà posée' }));

    const rows = await sql.query<{ avoided: boolean; billable: boolean; query: string }>(
      'select avoided, billable, query from search_provider_usage order by avoided',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.billable).toBe(true);
    expect(rows[1]?.avoided).toBe(true);
  });

  /**
   * Les conditions Brave interdisent de constituer une base de résultats. La
   * table n'a donc aucune colonne pour en accueillir : c'est une propriété du
   * schéma, et un test la fige pour qu'une migration future ne la rende pas
   * fausse en silence.
   */
  it('le registre n’a aucune colonne pour un résultat de recherche', async () => {
    const columns = await sql.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'search_provider_usage'`,
    );
    const names = columns.map((row) => row.column_name);
    for (const forbidden of ['title', 'snippet', 'description', 'result_url', 'url', 'payload', 'results']) {
      expect(names).not.toContain(forbidden);
    }
    expect(names).toContain('results_count');
  });

  it('estime la dépense au tarif publié', async () => {
    const budget = new SearchBudget({ sql, provider: 'brave', campaignSlug: null, runId: null, limits: limits() });
    for (let i = 0; i < 4; i += 1) await budget.record(usage());

    const snapshot = await budget.snapshot();
    expect(snapshot.runCalls).toBe(4);
    expect(snapshot.monthlyCalls).toBe(4);
    expect(snapshot.estimatedUsdThisRun).toBeCloseTo(4 * searchPriceUsdPerQuery(), 6);
    expect(snapshot.freeCreditRemainingUsd).toBeCloseTo(
      SEARCH_FREE_CREDIT_USD_PER_MONTH - 4 * searchPriceUsdPerQuery(),
      6,
    );
  });

  it('compte les requêtes évitées dans l’instantané', async () => {
    const budget = new SearchBudget({ sql, provider: 'brave', campaignSlug: null, runId: null, limits: limits() });
    await budget.record(usage({ avoided: true, billable: false, avoidedReason: 'déjà posée' }));
    const snapshot = await budget.snapshot();
    expect(snapshot.avoided).toBe(1);
    expect(snapshot.runCalls).toBe(0);
  });

  it('le tarif publié est 5 $ les 1 000 requêtes', () => {
    expect(searchPriceUsdPerQuery()).toBeCloseTo(0.005, 6);
  });
});

describe('résolution de la clé', () => {
  /**
   * Deux noms coexistent : l'adaptateur d'origine lisait
   * `OUTBOUND_BRAVE_API_KEY`, la mission R4 et le `.env` de la machine portent
   * `OUTBOUND_BRAVE_SEARCH_KEY`. Les deux sont lus, le nom explicite d'abord.
   */
  it('préfère OUTBOUND_BRAVE_SEARCH_KEY', () => {
    const previous = { search: process.env['OUTBOUND_BRAVE_SEARCH_KEY'], api: process.env['OUTBOUND_BRAVE_API_KEY'] };
    try {
      process.env['OUTBOUND_BRAVE_SEARCH_KEY'] = 'nouveau';
      process.env['OUTBOUND_BRAVE_API_KEY'] = 'ancien';
      expect(braveKeyVariable()).toEqual({ name: 'OUTBOUND_BRAVE_SEARCH_KEY', present: true });
      expect(braveKey()).toBe('nouveau');
    } finally {
      restore('OUTBOUND_BRAVE_SEARCH_KEY', previous.search);
      restore('OUTBOUND_BRAVE_API_KEY', previous.api);
    }
  });

  it('accepte encore l’ancien nom', () => {
    const previous = { search: process.env['OUTBOUND_BRAVE_SEARCH_KEY'], api: process.env['OUTBOUND_BRAVE_API_KEY'] };
    try {
      delete process.env['OUTBOUND_BRAVE_SEARCH_KEY'];
      process.env['OUTBOUND_BRAVE_API_KEY'] = 'ancien';
      expect(braveKeyVariable()).toEqual({ name: 'OUTBOUND_BRAVE_API_KEY', present: true });
      expect(braveKey()).toBe('ancien');
    } finally {
      restore('OUTBOUND_BRAVE_SEARCH_KEY', previous.search);
      restore('OUTBOUND_BRAVE_API_KEY', previous.api);
    }
  });

  it('nomme la variable attendue quand aucune clé n’est présente', () => {
    const previous = { search: process.env['OUTBOUND_BRAVE_SEARCH_KEY'], api: process.env['OUTBOUND_BRAVE_API_KEY'] };
    try {
      delete process.env['OUTBOUND_BRAVE_SEARCH_KEY'];
      delete process.env['OUTBOUND_BRAVE_API_KEY'];
      const variable = braveKeyVariable();
      expect(variable.present).toBe(false);
      expect(variable.name).toBe('OUTBOUND_BRAVE_SEARCH_KEY');
      expect(braveKey()).toBeUndefined();
    } finally {
      restore('OUTBOUND_BRAVE_SEARCH_KEY', previous.search);
      restore('OUTBOUND_BRAVE_API_KEY', previous.api);
    }
  });
});

describe('searchLimitsFromEnv', () => {
  /**
   * Le plafond mensuel par défaut est calé SOUS le crédit gratuit (~1 000
   * requêtes) pour que le premier euro dépensé demande une modification
   * délibérée de la configuration.
   */
  it('reste sous le crédit mensuel offert par défaut', () => {
    const defaults = searchLimitsFromEnv();
    const freeQueries = SEARCH_FREE_CREDIT_USD_PER_MONTH / searchPriceUsdPerQuery();
    expect(defaults.monthly).toBeLessThan(freeQueries);
    expect(defaults.run).toBeLessThanOrEqual(defaults.daily);
    expect(defaults.daily).toBeLessThanOrEqual(defaults.monthly);
  });

  it('se laisse configurer', () => {
    const previous = process.env['OUTBOUND_SEARCH_RUN_LIMIT'];
    try {
      process.env['OUTBOUND_SEARCH_RUN_LIMIT'] = '7';
      expect(searchLimitsFromEnv().run).toBe(7);
    } finally {
      restore('OUTBOUND_SEARCH_RUN_LIMIT', previous);
    }
  });
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
