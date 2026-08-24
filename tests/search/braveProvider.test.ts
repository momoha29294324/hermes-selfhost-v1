import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { HttpClient } from '@/lib/http/client';
import {
  BRAVE_MAX_COUNT,
  SearchProviderError,
  classifySearchFailure,
  createWebSearchProvider,
} from '@/lib/enrichment/webSearch';
import {
  SEARCH_RESULTS_MAY_BE_STORED,
  assertNoSearchResultContent,
  looksLikeSearchSnippet,
} from '@/lib/discovery/search/terms';
import type { Sql } from '@/lib/db/sql';

/**
 * L'adaptateur Brave, et surtout ce qu'il n'a pas le droit de faire.
 *
 * Le test le plus important de ce fichier n'est pas la normalisation : c'est
 * `n'écrit rien dans http_cache`. Sans `noCache`, `HttpClient` dépose la réponse
 * JSON entière dans une table — soit exactement la « database of Search Results »
 * que les conditions Brave interdisent. C'est une clause contractuelle, pas un
 * réglage de performance, et une régression y serait invisible sans ce test.
 */

let sql: Sql;
let dir: string;

interface Call {
  url: string;
  headers: Record<string, string>;
}

interface Route {
  status?: number;
  body?: string;
  throws?: string;
}

function harness(routes: (url: string) => Route): { calls: Call[]; http: HttpClient; withSql: HttpClient } {
  const calls: Call[] = [];
  const fetchImpl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    calls.push({ url, headers });

    const route = routes(url);
    if (route.throws) throw new Error(route.throws);
    const status = route.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      url,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
      text: async () => route.body ?? '{}',
    } as unknown as Response;
  };

  return {
    calls,
    http: new HttpClient({ sql: null, minHostIntervalMs: 0, fetchImpl }),
    withSql: new HttpClient({ sql, minHostIntervalMs: 0, fetchImpl }),
  };
}

const PAYLOAD = JSON.stringify({
  web: {
    results: [
      { url: 'https://demo-54-exemple.fr/', title: 'Éclat Auto — Atelier Lyon', description: 'Vente de produits et boutique en ligne' },
      { url: 'https://www.societe.com/x', title: 'DEMO YANKEE', description: 'Chiffre d’affaires' },
      { title: 'sans url', description: 'ignoré' },
    ],
  },
});

/**
 * Le `await` avant `finally` n'est pas cosmétique : sans lui, `finally` restaure
 * l'environnement dès que `fn()` a rendu sa promesse, donc AVANT que le corps
 * asynchrone ne s'exécute — et l'adaptateur cherche alors une clé qui n'est
 * plus là. Le premier passage l'a montré.
 */
async function withProvider(fn: () => Promise<void>): Promise<void> {
  const previous = {
    provider: process.env['OUTBOUND_SEARCH_PROVIDER'],
    key: process.env['OUTBOUND_BRAVE_SEARCH_KEY'],
    legacy: process.env['OUTBOUND_BRAVE_API_KEY'],
  };
  process.env['OUTBOUND_SEARCH_PROVIDER'] = 'brave';
  process.env['OUTBOUND_BRAVE_SEARCH_KEY'] = 'BSA-test-key';
  delete process.env['OUTBOUND_BRAVE_API_KEY'];
  try {
    await fn();
  } finally {
    restore('OUTBOUND_SEARCH_PROVIDER', previous.provider);
    restore('OUTBOUND_BRAVE_SEARCH_KEY', previous.key);
    restore('OUTBOUND_BRAVE_API_KEY', previous.legacy);
  }
}

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'brave-provider-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);
});

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await sql.query('delete from http_cache');
});

describe('BraveProvider — normalisation', () => {
  it('traduit la réponse en SearchHit et ignore un résultat sans URL', async () => {
    await withProvider(async () => {
      const { http } = harness(() => ({ body: PAYLOAD }));
      const hits = await createWebSearchProvider(http).search('"Éclat Auto" Lyon', 10);

      expect(hits).toHaveLength(2);
      expect(hits[0]).toEqual({
        url: 'https://demo-54-exemple.fr/',
        title: 'Éclat Auto — Atelier Lyon',
        snippet: 'Vente de produits et boutique en ligne',
      });
    });
  });

  it('supporte les champs absents sans lever', async () => {
    await withProvider(async () => {
      const { http } = harness(() => ({ body: JSON.stringify({ web: { results: [{ url: 'https://a.fr/' }] } }) }));
      const hits = await createWebSearchProvider(http).search('x', 5);
      expect(hits[0]).toEqual({ url: 'https://a.fr/', title: '', snippet: '' });
    });
  });

  it('renvoie une liste vide quand le moteur ne trouve rien', async () => {
    await withProvider(async () => {
      const { http } = harness(() => ({ body: JSON.stringify({ web: { results: [] } }) }));
      expect(await createWebSearchProvider(http).search('x', 5)).toEqual([]);
    });
  });

  it('envoie le jeton dans l’en-tête documenté', async () => {
    await withProvider(async () => {
      const { http, calls } = harness(() => ({ body: PAYLOAD }));
      await createWebSearchProvider(http).search('x', 5);
      expect(calls[0]?.headers['x-subscription-token']).toBe('BSA-test-key');
      expect(calls[0]?.url).toContain('api.search.brave.com/res/v1/web/search');
    });
  });

  /** `count` est plafonné à 20 par l'API : au-delà, la requête est refusée. */
  it('borne count au maximum documenté', async () => {
    await withProvider(async () => {
      const { http, calls } = harness(() => ({ body: PAYLOAD }));
      await createWebSearchProvider(http).search('x', 500);
      expect(calls[0]?.url).toContain(`count=${BRAVE_MAX_COUNT}`);
    });
  });

  it('encode la requête', async () => {
    await withProvider(async () => {
      const { http, calls } = harness(() => ({ body: PAYLOAD }));
      await createWebSearchProvider(http).search('"Éclat Auto" Lyon', 5);
      expect(calls[0]?.url).toContain(encodeURIComponent('"Éclat Auto" Lyon'));
    });
  });
});

describe('BraveProvider — conformité aux conditions', () => {
  /**
   * LE test de conformité. Sans `noCache`, la réponse entière atterrit dans
   * `http_cache` et nous constituons la base de résultats que la clause
   * interdit.
   */
  it('n’écrit jamais la réponse dans le cache HTTP persistant', async () => {
    await withProvider(async () => {
      const { withSql } = harness(() => ({ body: PAYLOAD }));
      await createWebSearchProvider(withSql).search('"Éclat Auto" Lyon', 10);

      const cached = await sql.query<{ count: string }>('select count(*)::text as count from http_cache');
      expect(cached[0]?.count).toBe('0');
    });
  });

  it('n’en lit pas non plus : deux recherches identiques appellent deux fois', async () => {
    await withProvider(async () => {
      const { withSql, calls } = harness(() => ({ body: PAYLOAD }));
      const provider = createWebSearchProvider(withSql);
      await provider.search('même requête', 10);
      await provider.search('même requête', 10);
      expect(calls.filter((call) => call.url.includes('brave.com'))).toHaveLength(2);
    });
  });

  it('le stockage des résultats n’est pas une option activable', () => {
    expect(SEARCH_RESULTS_MAY_BE_STORED).toBe(false);
  });

  it('assertNoSearchResultContent lève plutôt que de nettoyer en silence', () => {
    expect(() => assertNoSearchResultContent({ domain: 'demo-54-exemple.fr' }, 'test')).not.toThrow();
    expect(() => assertNoSearchResultContent({ title: 'Éclat Auto — Lyon' }, 'test')).toThrow(/refus d’écrire/);
    expect(() => assertNoSearchResultContent({ snippet: 'Vente de produits…' }, 'test')).toThrow(/résultats du moteur/);
    // Une chaîne vide n'est pas un résultat : elle ne doit pas bloquer un write.
    expect(() => assertNoSearchResultContent({ title: '' }, 'test')).not.toThrow();
    expect(() => assertNoSearchResultContent({ title: null }, 'test')).not.toThrow();
  });

  it('repère un extrait de moteur collé par erreur', () => {
    expect(looksLikeSearchSnippet('Vente de produits … boutique en ligne')).toBe(true);
    expect(looksLikeSearchSnippet('vente de produits')).toBe(false);
  });
});

describe('BraveProvider — échecs', () => {
  it('clé absente : indisponible, et nomme la variable attendue', () => {
    const previous = {
      provider: process.env['OUTBOUND_SEARCH_PROVIDER'],
      key: process.env['OUTBOUND_BRAVE_SEARCH_KEY'],
      legacy: process.env['OUTBOUND_BRAVE_API_KEY'],
    };
    try {
      process.env['OUTBOUND_SEARCH_PROVIDER'] = 'brave';
      delete process.env['OUTBOUND_BRAVE_SEARCH_KEY'];
      delete process.env['OUTBOUND_BRAVE_API_KEY'];

      const { http } = harness(() => ({ body: PAYLOAD }));
      const availability = createWebSearchProvider(http).availability();
      expect(availability.ok).toBe(false);
      expect(availability.reason).toContain('OUTBOUND_BRAVE_SEARCH_KEY');
    } finally {
      restore('OUTBOUND_SEARCH_PROVIDER', previous.provider);
      restore('OUTBOUND_BRAVE_SEARCH_KEY', previous.key);
      restore('OUTBOUND_BRAVE_API_KEY', previous.legacy);
    }
  });

  it('clé absente : chercher lève une erreur fatale sans appeler', async () => {
    const previous = {
      provider: process.env['OUTBOUND_SEARCH_PROVIDER'],
      key: process.env['OUTBOUND_BRAVE_SEARCH_KEY'],
      legacy: process.env['OUTBOUND_BRAVE_API_KEY'],
    };
    try {
      process.env['OUTBOUND_SEARCH_PROVIDER'] = 'brave';
      delete process.env['OUTBOUND_BRAVE_SEARCH_KEY'];
      delete process.env['OUTBOUND_BRAVE_API_KEY'];

      const { http, calls } = harness(() => ({ body: PAYLOAD }));
      await expect(createWebSearchProvider(http).search('x', 5)).rejects.toMatchObject({
        name: 'SearchProviderError',
        kind: 'auth',
        fatal: true,
      });
      expect(calls).toHaveLength(0);
    } finally {
      restore('OUTBOUND_SEARCH_PROVIDER', previous.provider);
      restore('OUTBOUND_BRAVE_SEARCH_KEY', previous.key);
      restore('OUTBOUND_BRAVE_API_KEY', previous.legacy);
    }
  });

  /**
   * 401 dit « pas avec cette clé » : insister est inutile pour tout le corpus.
   * C'est ce que `fatal` exprime, et ce qui évite de payer 52 refus.
   */
  it('401 devient une erreur fatale', async () => {
    await withProvider(async () => {
      const { http } = harness(() => ({ status: 401, body: '{"error":"unauthorized"}' }));
      const error = await createWebSearchProvider(http).search('x', 5).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SearchProviderError);
      expect((error as SearchProviderError).kind).toBe('auth');
      expect((error as SearchProviderError).fatal).toBe(true);
    });
  });

  it('403 devient aussi une erreur d’authentification', async () => {
    await withProvider(async () => {
      const { http } = harness(() => ({ status: 403, body: '{}' }));
      const error = await createWebSearchProvider(http).search('x', 5).catch((e: unknown) => e);
      expect((error as SearchProviderError).kind).toBe('auth');
    });
  });

  /** 429 dit « pas maintenant » : le run peut continuer, pas la requête. */
  it('429 devient un dépassement de quota, non fatal', async () => {
    await withProvider(async () => {
      const { http } = harness(() => ({ status: 429, body: '{}' }));
      const error = await createWebSearchProvider(http).search('x', 5).catch((e: unknown) => e);
      expect((error as SearchProviderError).kind).toBe('quota');
      expect((error as SearchProviderError).fatal).toBe(false);
    });
  });

  it('un timeout est reconnu comme tel', async () => {
    await withProvider(async () => {
      const { http } = harness(() => ({ throws: 'The operation was aborted due to timeout' }));
      const error = await createWebSearchProvider(http).search('x', 5).catch((e: unknown) => e);
      expect((error as SearchProviderError).kind).toBe('timeout');
      expect((error as SearchProviderError).fatal).toBe(false);
    });
  });

  it('un JSON illisible reste un échec de transport', async () => {
    await withProvider(async () => {
      const { http } = harness(() => ({ body: 'pas du json' }));
      const error = await createWebSearchProvider(http).search('x', 5).catch((e: unknown) => e);
      expect((error as SearchProviderError).kind).toBe('transport');
    });
  });

  /**
   * `HttpClient` réessaie 429 et 5xx avec un repli exponentiel. Deux tentatives
   * au plus pour une recherche : chacune est facturée si elle aboutit, donc
   * insister trois fois sur un moteur en difficulté coûterait sans rien gagner.
   */
  it('réessaie une fois au plus sur un 500', async () => {
    await withProvider(async () => {
      const { http, calls } = harness(() => ({ status: 500, body: '{}' }));
      await createWebSearchProvider(http).search('x', 5).catch(() => undefined);
      expect(calls.filter((call) => call.url.includes('brave.com'))).toHaveLength(2);
    });
  });
});

describe('classifySearchFailure', () => {
  it('laisse passer une erreur déjà classée', () => {
    const original = new SearchProviderError('quota', 'brave', 'déjà classée');
    expect(classifySearchFailure(original, 'brave')).toBe(original);
  });

  it('classe un motif inconnu en transport', () => {
    expect(classifySearchFailure(new Error('boom'), 'brave').kind).toBe('transport');
  });

  it('reconnaît un abandon comme timeout', () => {
    expect(classifySearchFailure(new Error('This operation was aborted'), 'brave').kind).toBe('timeout');
  });
});
