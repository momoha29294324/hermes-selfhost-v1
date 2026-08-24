import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SearchClient, normaliseResults, SEARXNG_BREAKER_KEY } from '../../services/webintel/src/searxng';
import { BreakerRegistry } from '../../services/webintel/src/breaker';
import { DiskCache } from '../../services/webintel/src/cache';
import { createLogger } from '../../services/webintel/src/log';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'webintel-search-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const silent = createLogger('error', {}, () => undefined);

interface FakeCall {
  url: string;
}

function makeClient(
  responder: (url: URL, call: number) => { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>,
  options: { engines?: string[]; failureThreshold?: number } = {},
) {
  const calls: FakeCall[] = [];
  const breakers = new BreakerRegistry({
    failureThreshold: options.failureThreshold ?? 3,
    cooldownMs: 600_000,
  });
  const cache = new DiskCache({ dir, maxEntryBytes: 1_000_000 });

  const fetchImpl = (async (input: string | URL) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString() });
    const result = await responder(url, calls.length);
    const status = result.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => result.body,
    };
  }) as unknown as typeof fetch;

  const client = new SearchClient({
    baseUrl: 'http://127.0.0.1:8088',
    timeoutMs: 5_000,
    defaultEngines: options.engines ?? ['bing', 'duckduckgo', 'yep'],
    locale: 'fr',
    cache,
    cacheTtlMs: 60_000,
    breakers,
    logger: silent,
    fetchImpl,
  });

  return { client, calls, breakers, cache };
}

describe('normaliseResults', () => {
  it('déduplique par URL et fusionne les moteurs qui la remontent', () => {
    const hits = normaliseResults(
      [
        { url: 'https://a.fr', title: 'A', content: 'snippet A', engine: 'bing' },
        { url: 'https://b.fr', title: 'B', content: 'snippet B', engine: 'yep' },
        { url: 'https://a.fr', title: 'A bis', content: '', engine: 'duckduckgo' },
      ],
      10,
    );
    expect(hits).toHaveLength(2);
    // Two independent engines agreeing outranks a single-engine result.
    expect(hits[0]?.url).toBe('https://a.fr');
    expect(hits[0]?.engine.split('+').sort()).toEqual(['bing', 'duckduckgo']);
    expect(hits[0]?.rank).toBe(1);
  });

  it('complète un extrait manquant depuis un doublon', () => {
    const hits = normaliseResults(
      [
        { url: 'https://a.fr', title: 'A', content: '', engine: 'bing' },
        { url: 'https://a.fr', title: 'A', content: 'le vrai extrait', engine: 'yep' },
      ],
      10,
    );
    expect(hits[0]?.snippet).toBe('le vrai extrait');
  });

  it('écarte ce qui n’est pas une URL http(s)', () => {
    const hits = normaliseResults(
      [
        { url: '', title: 'vide', engine: 'bing' },
        { url: 'ftp://x.fr/f', title: 'ftp', engine: 'bing' },
        { url: 'https://ok.fr', title: 'ok', engine: 'bing' },
      ],
      10,
    );
    expect(hits.map((hit) => hit.url)).toEqual(['https://ok.fr']);
  });

  it('respecte la limite demandée', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      url: `https://site${i}.fr`,
      title: `S${i}`,
      engine: 'bing',
    }));
    expect(normaliseResults(many, 5)).toHaveLength(5);
  });

  it('rend une liste vide sur une réponse vide', () => {
    expect(normaliseResults([], 10)).toEqual([]);
  });
});

describe('SearchClient', () => {
  it('épingle la liste des moteurs dans la requête', async () => {
    const { client, calls } = makeClient(() => ({ body: { results: [] } }));
    await client.search('atelier lyon');
    const url = new URL(calls[0]?.url as string);
    expect(url.searchParams.get('engines')).toBe('bing,duckduckgo,yep');
    expect(url.searchParams.get('format')).toBe('json');
    expect(url.searchParams.get('language')).toBe('fr');
  });

  it('sert le cache au second appel identique', async () => {
    const { client, calls } = makeClient(() => ({
      body: { results: [{ url: 'https://a.fr', title: 'A', engine: 'bing' }] },
    }));
    const first = await client.search('atelier lyon');
    const second = await client.search('atelier lyon');
    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('contourne le cache quand on le demande', async () => {
    const { client, calls } = makeClient(() => ({ body: { results: [] } }));
    await client.search('q');
    await client.search('q', { noCache: true });
    expect(calls).toHaveLength(2);
  });

  it('compte un échec par moteur muet et un succès pour les autres', async () => {
    const { client, breakers } = makeClient(() => ({
      body: {
        results: [{ url: 'https://a.fr', title: 'A', engine: 'bing' }],
        unresponsive_engines: [['duckduckgo', 'CAPTCHA']],
      },
    }));
    const response = await client.search('q');
    expect(response.enginesUnresponsive).toEqual([{ engine: 'duckduckgo', reason: 'CAPTCHA' }]);
    expect(breakers.snapshot()['engine:duckduckgo']?.failures).toBe(1);
    expect(breakers.snapshot()['engine:bing']?.failures).toBe(0);
  });

  it('retire un moteur de la requête une fois son disjoncteur ouvert', async () => {
    const { client, calls } = makeClient(
      () => ({
        body: { results: [], unresponsive_engines: [['duckduckgo', 'CAPTCHA']] },
      }),
      { failureThreshold: 2 },
    );
    await client.search('q1', { noCache: true });
    await client.search('q2', { noCache: true });
    const response = await client.search('q3', { noCache: true });

    expect(response.enginesSkipped).toEqual(['duckduckgo']);
    expect(new URL(calls[2]?.url as string).searchParams.get('engines')).toBe('bing,yep');
  });

  it('rend une réponse vide et honnête quand tous les moteurs sont ouverts', async () => {
    const { client, breakers } = makeClient(() => ({ body: { results: [] } }), { failureThreshold: 1 });
    for (const engine of ['bing', 'duckduckgo', 'yep']) breakers.failure(`engine:${engine}`, 'CAPTCHA');

    const response = await client.search('q');
    expect(response.results).toEqual([]);
    expect(response.enginesQueried).toEqual([]);
    expect(response.enginesSkipped).toEqual(['bing', 'duckduckgo', 'yep']);
  });

  it('n’explose pas quand SearXNG est injoignable, et ouvre son disjoncteur', async () => {
    const { client, breakers } = makeClient(
      () => {
        throw new Error('ECONNREFUSED');
      },
      { failureThreshold: 2 },
    );
    const first = await client.search('q1', { noCache: true });
    expect(first.results).toEqual([]);
    expect(first.enginesUnresponsive[0]?.engine).toBe('searxng');

    await client.search('q2', { noCache: true });
    expect(breakers.state(SEARXNG_BREAKER_KEY)).toBe('open');

    const third = await client.search('q3', { noCache: true });
    expect(third.enginesUnresponsive).toEqual([{ engine: 'searxng', reason: 'circuit_open' }]);
  });

  it('traite un HTTP non-2xx comme un échec du fournisseur', async () => {
    const { client } = makeClient(() => ({ status: 502, body: {} }));
    const response = await client.search('q', { noCache: true });
    expect(response.results).toEqual([]);
    expect(response.enginesUnresponsive[0]?.reason).toContain('502');
  });

  it('survit à un JSON invalide', async () => {
    const { client } = makeClient(() => ({
      status: 200,
      get body(): unknown {
        throw new Error('Unexpected token');
      },
    }));
    const response = await client.search('q', { noCache: true });
    expect(response.results).toEqual([]);
  });

  it('searchMany enchaîne les requêtes sans les perdre', async () => {
    const { client } = makeClient((url) => ({
      body: {
        results: [{ url: `https://${url.searchParams.get('q')}.fr`, title: 'T', engine: 'bing' }],
      },
    }));
    const responses = await client.searchMany(['a', 'b', 'c'], { pauseMs: 0 });
    expect(responses.map((response) => response.results[0]?.url)).toEqual([
      'https://a.fr',
      'https://b.fr',
      'https://c.fr',
    ]);
  });

  it('rapporte la santé de l’instance', async () => {
    const { client } = makeClient(() => ({ status: 200, body: {} }));
    expect(await client.health()).toEqual({ ok: true, detail: 'SearXNG 200' });
  });
});
