import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { HttpClient } from '@/lib/http/client';
import {
  SERPER_ENDPOINT,
  SERPER_MAX_NUM_FREE,
  SearchProviderError,
  createWebSearchProvider,
  observedCredits,
} from '@/lib/enrichment/webSearch';
import {
  SEARCH_PROVIDER_PRICING,
  searchKeyVariable,
  searchPriceUsdPerQuery,
  searchPricing,
  serperKeyVariable,
} from '@/lib/discovery/search/budget';
import { classifyHits } from '@/lib/discovery/search/classify';
import type { Sql } from '@/lib/db/sql';

/**
 * L'adaptateur Serper, mis pour la première fois sur le chemin d'un run payant.
 *
 * Le test qui justifie ce fichier est `403 devient une erreur fatale`. Avant
 * R4-S, l'adaptateur faisait `if (!res.ok) return []` : une clé refusée
 * ressemblait donc à un moteur qui ne trouve rien, le run continuait sur les
 * cinquante prospects suivants, et le benchmark rendait un rapport
 * irréprochable concluant « Serper : FAIL ». Un banc d'essai qui se plante
 * bruyamment est réparable ; celui-ci mentait.
 *
 * Le reste du fichier tient les contraintes constatées à la source le 10 août
 * 2026, et notamment le refus `400 Query pattern not allowed for free accounts.`
 * au-delà de dix résultats.
 */

let sql: Sql;
let dir: string;

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
  method: string;
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
    calls.push({ url, headers, body: String(init?.body ?? ''), method: init?.method ?? 'GET' });

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

/** La forme réelle d'une réponse Serper, relevée sur l'API le 10 août 2026. */
const PAYLOAD = JSON.stringify({
  searchParameters: { q: '"DEMO YANKEE" Lyon', gl: 'fr', hl: 'fr', type: 'search', num: 10, engine: 'google' },
  organic: [
    { title: 'Éclat Auto — Atelier Lyon', link: 'https://demo-54-exemple.fr/', snippet: 'Vente de produits', position: 1 },
    { title: 'DEMO YANKEE', link: 'https://www.societe.com/x', snippet: 'Chiffre d’affaires', position: 2 },
    { title: 'sans lien', snippet: 'ignoré', position: 3 },
  ],
  credits: 1,
});

async function withProvider(fn: () => Promise<void>): Promise<void> {
  const previous = {
    provider: process.env['OUTBOUND_SEARCH_PROVIDER'],
    key: process.env['OUTBOUND_SERPER_API_KEY'],
  };
  process.env['OUTBOUND_SEARCH_PROVIDER'] = 'serper';
  process.env['OUTBOUND_SERPER_API_KEY'] = 'serper-test-key';
  try {
    await fn();
  } finally {
    restore('OUTBOUND_SEARCH_PROVIDER', previous.provider);
    restore('OUTBOUND_SERPER_API_KEY', previous.key);
  }
}

async function withoutKey(fn: () => Promise<void>): Promise<void> {
  const previous = {
    provider: process.env['OUTBOUND_SEARCH_PROVIDER'],
    key: process.env['OUTBOUND_SERPER_API_KEY'],
  };
  process.env['OUTBOUND_SEARCH_PROVIDER'] = 'serper';
  delete process.env['OUTBOUND_SERPER_API_KEY'];
  try {
    await fn();
  } finally {
    restore('OUTBOUND_SEARCH_PROVIDER', previous.provider);
    restore('OUTBOUND_SERPER_API_KEY', previous.key);
  }
}

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function serperCalls(calls: Call[]): Call[] {
  return calls.filter((call) => call.url.includes('serper.dev'));
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'serper-provider-'));
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

describe('SerperProvider — contrat de requête', () => {
  it('appelle l’endpoint documenté en POST avec l’en-tête x-api-key', async () => {
    await withProvider(async () => {
      const { http, calls } = harness(() => ({ body: PAYLOAD }));
      await createWebSearchProvider(http).search('"Éclat Auto" Lyon', 10);

      const call = serperCalls(calls)[0];
      expect(call?.url).toBe(SERPER_ENDPOINT);
      expect(call?.method).toBe('POST');
      expect(call?.headers['x-api-key']).toBe('serper-test-key');
      expect(call?.headers['content-type']).toBe('application/json');
    });
  });

  it('envoie la requête, le pays et la langue dans le corps JSON', async () => {
    await withProvider(async () => {
      const { http, calls } = harness(() => ({ body: PAYLOAD }));
      await createWebSearchProvider(http).search('"Éclat Auto" Lyon', 10);

      expect(JSON.parse(serperCalls(calls)[0]?.body ?? '{}')).toEqual({
        q: '"Éclat Auto" Lyon',
        gl: 'fr',
        hl: 'fr',
        num: 10,
      });
    });
  });

  /**
   * La borne qui empêche un faux verdict.
   *
   * Un compte gratuit répond `400 Query pattern not allowed for free accounts.`
   * dès `num: 11`. Sans ce clamp, `--results 20` — la valeur que Brave accepte,
   * donc la première qu'un opérateur essaierait — ferait échouer les cinquante
   * requêtes du run et le rapport conclurait que Serper ne trouve rien.
   */
  it('borne num au maximum autorisé par un compte gratuit', async () => {
    await withProvider(async () => {
      const { http, calls } = harness(() => ({ body: PAYLOAD }));
      await createWebSearchProvider(http).search('x', 500);
      expect(JSON.parse(serperCalls(calls)[0]?.body ?? '{}').num).toBe(SERPER_MAX_NUM_FREE);
      expect(SERPER_MAX_NUM_FREE).toBe(10);
    });
  });

  it('demande au moins un résultat même si on lui en demande zéro', async () => {
    await withProvider(async () => {
      const { http, calls } = harness(() => ({ body: PAYLOAD }));
      await createWebSearchProvider(http).search('x', 0);
      expect(JSON.parse(serperCalls(calls)[0]?.body ?? '{}').num).toBe(1);
    });
  });
});

describe('SerperProvider — normalisation', () => {
  it('traduit `organic` en SearchHit et ignore un résultat sans lien', async () => {
    await withProvider(async () => {
      const { http } = harness(() => ({ body: PAYLOAD }));
      const hits = await createWebSearchProvider(http).search('"Éclat Auto" Lyon', 10);

      expect(hits).toHaveLength(2);
      expect(hits[0]).toEqual({
        url: 'https://demo-54-exemple.fr/',
        title: 'Éclat Auto — Atelier Lyon',
        snippet: 'Vente de produits',
      });
    });
  });

  it('supporte les champs absents sans lever', async () => {
    await withProvider(async () => {
      const { http } = harness(() => ({ body: JSON.stringify({ organic: [{ link: 'https://a.fr/' }] }) }));
      const hits = await createWebSearchProvider(http).search('x', 5);
      expect(hits[0]).toEqual({ url: 'https://a.fr/', title: '', snippet: '' });
    });
  });

  /**
   * Une requête sans résultat répond 200 avec `organic: []` — et elle est
   * facturée. Le distinguer d'un échec est ce qui rend le taux « sans résultat »
   * du rapport honnête.
   */
  it('renvoie une liste vide quand le moteur ne trouve rien', async () => {
    await withProvider(async () => {
      const { http } = harness(() => ({
        body: JSON.stringify({ searchParameters: {}, searchInformation: {}, organic: [], credits: 1 }),
      }));
      expect(await createWebSearchProvider(http).search('x', 5)).toEqual([]);
    });
  });

  it('supporte une réponse sans tableau organic du tout', async () => {
    await withProvider(async () => {
      const { http } = harness(() => ({ body: JSON.stringify({ credits: 1 }) }));
      expect(await createWebSearchProvider(http).search('x', 5)).toEqual([]);
    });
  });

  /** `rating`, `priceRange` et `position` appartiennent au moteur : ils ne sortent pas. */
  it('ne laisse échapper aucun champ du moteur au-delà des trois attendus', async () => {
    await withProvider(async () => {
      const { http } = harness(() => ({ body: PAYLOAD }));
      const hits = await createWebSearchProvider(http).search('x', 10);
      for (const hit of hits) expect(Object.keys(hit).sort()).toEqual(['snippet', 'title', 'url']);
    });
  });
});

describe('SerperProvider — crédits mesurés', () => {
  /**
   * Serper déclare `credits` dans chaque réponse ; Brave n'a pas d'équivalent.
   * C'est la seule dépense mesurée du rapport, et elle sert à contrôler notre
   * estimation plutôt qu'à la remplacer.
   */
  it('accumule les crédits déclarés par le fournisseur', async () => {
    await withProvider(async () => {
      const { http } = harness(() => ({ body: PAYLOAD }));
      const provider = createWebSearchProvider(http);
      await provider.search('a', 10);
      await provider.search('b', 10);
      expect(observedCredits(provider)).toEqual({ credits: 2, calls: 2 });
    });
  });

  it('ne compte pas un appel dont la réponse ne déclare aucun crédit', async () => {
    await withProvider(async () => {
      const { http } = harness(() => ({ body: JSON.stringify({ organic: [] }) }));
      const provider = createWebSearchProvider(http);
      await provider.search('a', 10);
      expect(observedCredits(provider)).toEqual({ credits: 0, calls: 0 });
    });
  });

  it('Brave ne prétend pas mesurer ce qu’il ne déclare pas', async () => {
    const previous = process.env['OUTBOUND_BRAVE_SEARCH_KEY'];
    process.env['OUTBOUND_BRAVE_SEARCH_KEY'] = 'BSA-test';
    try {
      const { http } = harness(() => ({ body: '{}' }));
      expect(observedCredits(createWebSearchProvider(http, 'brave'))).toBeNull();
    } finally {
      restore('OUTBOUND_BRAVE_SEARCH_KEY', previous);
    }
  });
});

describe('SerperProvider — échecs', () => {
  it('clé absente : indisponible, et nomme la variable attendue', async () => {
    await withoutKey(async () => {
      const { http } = harness(() => ({ body: PAYLOAD }));
      const availability = createWebSearchProvider(http).availability();
      expect(availability.ok).toBe(false);
      expect(availability.reason).toContain('OUTBOUND_SERPER_API_KEY');
    });
  });

  it('clé absente : chercher lève une erreur fatale sans appeler', async () => {
    await withoutKey(async () => {
      const { http, calls } = harness(() => ({ body: PAYLOAD }));
      await expect(createWebSearchProvider(http).search('x', 5)).rejects.toMatchObject({
        name: 'SearchProviderError',
        kind: 'auth',
        fatal: true,
      });
      expect(serperCalls(calls)).toHaveLength(0);
    });
  });

  /**
   * LA régression que ce fichier existe pour empêcher.
   *
   * Serper répond `403 {"message":"Unauthorized."}` à une clé invalide — vérifié
   * à la source. `HttpClient.request` ne lève pas sur un 4xx : il rend une
   * réponse avec `ok: false`. L'ancien adaptateur la traduisait en « aucun
   * résultat », ce qui laissait le run se poursuivre et produisait un faux
   * verdict d'échec du fournisseur.
   */
  it('403 devient une erreur fatale, jamais une liste vide', async () => {
    await withProvider(async () => {
      const { http } = harness(() => ({ status: 403, body: '{"message":"Unauthorized.","statusCode":403}' }));
      const error = await createWebSearchProvider(http).search('x', 5).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(SearchProviderError);
      expect((error as SearchProviderError).kind).toBe('auth');
      expect((error as SearchProviderError).fatal).toBe(true);
      expect(Array.isArray(error)).toBe(false);
    });
  });

  it('401 devient aussi une erreur d’authentification fatale', async () => {
    await withProvider(async () => {
      const { http } = harness(() => ({ status: 401, body: '{}' }));
      const error = await createWebSearchProvider(http).search('x', 5).catch((e: unknown) => e);
      expect((error as SearchProviderError).kind).toBe('auth');
      expect((error as SearchProviderError).fatal).toBe(true);
    });
  });

  it('429 devient un dépassement de quota, non fatal', async () => {
    await withProvider(async () => {
      const { http } = harness(() => ({ status: 429, body: '{}' }));
      const error = await createWebSearchProvider(http).search('x', 5).catch((e: unknown) => e);
      expect((error as SearchProviderError).kind).toBe('quota');
      expect((error as SearchProviderError).fatal).toBe(false);
    });
  });

  /**
   * Le refus de motif d'un compte gratuit. Le clamp de `num` doit le rendre
   * inatteignable, mais s'il survient il perd le prospect, pas le run.
   */
  it('400 « query pattern not allowed » reste un échec de transport, non fatal', async () => {
    await withProvider(async () => {
      const { http } = harness(() => ({
        status: 400,
        body: '{"message":"Query pattern not allowed for free accounts.","statusCode":400}',
      }));
      const error = await createWebSearchProvider(http).search('x', 5).catch((e: unknown) => e);
      expect((error as SearchProviderError).kind).toBe('transport');
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

  /** Deux tentatives au plus, comme Brave : les latences doivent rester comparables. */
  it('réessaie une fois au plus sur un 500', async () => {
    await withProvider(async () => {
      const { http, calls } = harness(() => ({ status: 500, body: '{}' }));
      await createWebSearchProvider(http).search('x', 5).catch(() => undefined);
      expect(serperCalls(calls)).toHaveLength(2);
    });
  });

  it('ne réessaie pas un refus d’authentification', async () => {
    await withProvider(async () => {
      const { http, calls } = harness(() => ({ status: 403, body: '{}' }));
      await createWebSearchProvider(http).search('x', 5).catch(() => undefined);
      expect(serperCalls(calls)).toHaveLength(1);
    });
  });
});

describe('SerperProvider — le moteur reste un pointeur', () => {
  /**
   * Les conditions de Serper, contrairement à celles de Brave, n'interdisent pas
   * de stocker un résultat. Nous ne le stockons pas davantage : la règle qui
   * l'interdit ici est la règle 2 du dépôt — une preuve est quelque chose que
   * nous avons vu — et relâcher pour une seule branche rendrait l'A/B
   * incomparable en lui donnant une mémoire que l'autre n'a pas.
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
      expect(serperCalls(calls)).toHaveLength(2);
    });
  });

  /**
   * Le filtre annuaire classe sur l'URL seule, donc indépendamment du
   * fournisseur. Le vérifier sur une charge Serper est ce qui garantit que
   * l'A/B compare deux moteurs et non deux filtres.
   */
  it('societe.com reste un annuaire, et le site propre reste un candidat', async () => {
    const candidates = classifyHits(
      [
        { url: 'https://demo-54-exemple.fr/', title: 'Éclat Auto', snippet: '' },
        { url: 'https://www.societe.com/societe/demozulu-auto-944555201.html', title: 'DEMO YANKEE', snippet: '' },
        { url: 'https://www.instagram.com/demo_account_12/', title: 'Éclat Auto', snippet: '' },
      ],
      'name_city',
    );

    expect(candidates.find((c) => c.domain === 'demo-54-exemple.fr')?.kind).toBe('own_site');
    expect(candidates.find((c) => c.domain === 'societe.com')?.kind).toBe('directory');
    expect(candidates.find((c) => c.kind === 'social')?.instagramHandle).toBe('demo_account_12');
  });
});

describe('tarification par fournisseur', () => {
  /**
   * Sans cette table, la colonne « coût » de l'A/B annoncerait 5 $ les 1 000
   * pour Serper — cinq fois son tarif d'entrée. Un A/B dont le coût est faux
   * pour une branche ne mesure rien.
   */
  it('Serper et Brave n’ont pas le même prix unitaire', () => {
    expect(searchPriceUsdPerQuery('brave')).toBeCloseTo(0.005, 6);
    expect(searchPriceUsdPerQuery('serper')).toBeCloseTo(0.001, 6);
  });

  it('le défaut reste Brave, pour les appelants d’avant R4-S', () => {
    expect(searchPriceUsdPerQuery()).toBeCloseTo(searchPriceUsdPerQuery('brave'), 6);
  });

  /**
   * Les deux offres sont de nature différente et le rapport ne doit pas les
   * confondre : Brave reconstitue un crédit chaque mois, Serper offre une
   * allocation qui ne revient pas.
   */
  it('distingue un crédit mensuel d’une allocation unique', () => {
    expect(searchPricing('brave').freeUsdPerMonth).toBe(5);
    expect(searchPricing('brave').freeQueriesOneOff).toBe(0);
    expect(searchPricing('serper').freeUsdPerMonth).toBe(0);
    expect(searchPricing('serper').freeQueriesOneOff).toBe(2_500);
  });

  it('chaque fournisseur tarifé nomme l’endpoint réellement appelé', () => {
    expect(SEARCH_PROVIDER_PRICING['serper']?.endpoint).toBe(SERPER_ENDPOINT);
    expect(SEARCH_PROVIDER_PRICING['brave']?.endpoint).toContain('api.search.brave.com');
  });

  it('un fournisseur inconnu ne fait pas exploser le rapport', () => {
    expect(searchPricing('inconnu').usdPer1000).toBe(searchPricing('brave').usdPer1000);
  });
});

describe('résolution de la variable de clé', () => {
  /**
   * Le benchmark affichait `braveKeyVariable()` quel que soit `--provider` : un
   * run Serper annonçait « clé ABSENTE (OUTBOUND_BRAVE_SEARCH_KEY) » et
   * renvoyait vers le tableau de bord de Brave. Sur un A/B, un message qui
   * désigne le mauvais fournisseur fait conclure à tort.
   */
  it('chaque fournisseur nomme sa propre variable', () => {
    expect(searchKeyVariable('serper').name).toBe('OUTBOUND_SERPER_API_KEY');
    expect(searchKeyVariable('brave').name).toBe('OUTBOUND_BRAVE_SEARCH_KEY');
  });

  it('la variable Serper porte le préfixe qui garde le dépôt isolé', async () => {
    await withProvider(async () => {
      expect(serperKeyVariable()).toEqual({ name: 'OUTBOUND_SERPER_API_KEY', present: true });
    });
    await withoutKey(async () => {
      expect(serperKeyVariable().present).toBe(false);
    });
  });
});
