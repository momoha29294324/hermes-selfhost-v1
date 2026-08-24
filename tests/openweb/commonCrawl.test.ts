import { describe, expect, it } from 'vitest';
import { HttpClient } from '@/lib/http/client';
import { createLogger } from '@/lib/logging/logger';
import {
  captureAgeDays,
  captureTimestampToDate,
  CommonCrawlClient,
  parseCdxResponse,
  summariseCaptures,
} from '@/lib/discovery/openweb/commonCrawl';

/**
 * Common Crawl est un index public, gratuit, lent et parfois indisponible. Ces
 * tests portent d'abord sur sa dégradation : ce qui compte n'est pas qu'il
 * réponde, c'est qu'un rail entier ne tombe pas quand il ne répond pas — et
 * surtout qu'une absence de capture ne soit jamais lue comme une absence de
 * domaine.
 */

const logger = createLogger({ test: 'common-crawl' });

const COLLINFO = [
  { id: 'CC-MAIN-2026-30', name: 'July 2026 Index', 'cdx-api': 'https://index.commoncrawl.org/CC-MAIN-2026-30-index' },
  { id: 'CC-MAIN-2026-26', name: 'June 2026 Index', 'cdx-api': 'https://index.commoncrawl.org/CC-MAIN-2026-26-index' },
];

function ndjson(records: Record<string, unknown>[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n');
}

interface StubResponse {
  status?: number;
  body: string;
  contentType?: string;
  delayMs?: number;
}

function harness(responder: (url: string) => StubResponse | Promise<StubResponse>): {
  urls: string[];
  http: HttpClient;
} {
  const urls: string[] = [];
  const fetchImpl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    urls.push(url);
    const result = await responder(url);
    if (result.delayMs) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, result.delayMs);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(init.signal?.reason ?? new Error('aborted'));
        });
      });
    }
    const status = result.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      url,
      headers: new Headers({ 'content-type': result.contentType ?? 'application/x-ndjson' }),
      body: null,
      text: async () => result.body,
    } as unknown as Response;
  };
  return { urls, http: new HttpClient({ sql: null, minHostIntervalMs: 0, fetchImpl }) };
}

function client(http: HttpClient, indexDepth = 2): CommonCrawlClient {
  return new CommonCrawlClient({ http, logger, indexDepth, timeoutMs: 200 });
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------
describe('parseCdxResponse', () => {
  it('lit le NDJSON ligne par ligne', () => {
    const parsed = parseCdxResponse(
      ndjson([
        {
          urlkey: 'fr,northstarstudio)/',
          timestamp: '20260714032627',
          url: 'https://example.net/',
          mime: 'text/html',
          status: '200',
          digest: 'AAA',
          length: '7529',
          offset: '136244955',
          filename: 'crawl-data/CC-MAIN-2026-30/segments/x.warc.gz',
        },
      ]),
    );
    expect(parsed.captures).toHaveLength(1);
    expect(parsed.captures[0]?.status).toBe(200);
    expect(parsed.captures[0]?.offset).toBe(136_244_955);
    expect(parsed.captures[0]?.length).toBe(7529);
    expect(parsed.noCaptures).toBe(false);
  });

  it('reconnaît l’absence de capture annoncée sous « message »', () => {
    // Le serveur répond en 404 avec ce corps. Ce n'est pas une panne.
    const parsed = parseCdxResponse('{"message": "No Captures found for: example.net"}');
    expect(parsed.noCaptures).toBe(true);
    expect(parsed.captures).toEqual([]);
    expect(parsed.serverMessage).toContain('No Captures found');
  });

  it('remonte un paramètre invalide sans le confondre avec une absence', () => {
    const parsed = parseCdxResponse('{"message": "Invalid match_type: bogus"}');
    expect(parsed.noCaptures).toBe(false);
    expect(parsed.serverMessage).toBe('Invalid match_type: bogus');
  });

  it('déduplique une même capture répétée (url + digest)', () => {
    const record = {
      timestamp: '20260714032627',
      url: 'https://example.net/',
      mime: 'text/html',
      status: '200',
      digest: 'SAMEDIGEST',
    };
    const parsed = parseCdxResponse(ndjson([record, { ...record, timestamp: '20260715112233' }, record]));
    // Trois lignes brutes, un seul document distinct : un site figé recapturé
    // ne doit pas ressembler à un site actif.
    expect(parsed.rawRecords).toBe(3);
    expect(parsed.captures).toHaveLength(1);
  });

  it('ignore une ligne illisible sans faire tomber la réponse', () => {
    const parsed = parseCdxResponse(
      `{"url":"https://a.fr/","timestamp":"20260101000000"}\n{tronqué\n{"url":"https://b.fr/","timestamp":"20260101000000"}`,
    );
    expect(parsed.captures).toHaveLength(2);
    expect(parsed.malformedLines).toBe(1);
  });

  it('ignore une ligne sans url ni timestamp', () => {
    const parsed = parseCdxResponse('{"mime":"text/html"}');
    expect(parsed.captures).toEqual([]);
    expect(parsed.malformedLines).toBe(1);
  });

  it('renvoie un résultat vide pour un corps vide', () => {
    expect(parseCdxResponse('').captures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Synthèse
// ---------------------------------------------------------------------------
describe('summariseCaptures', () => {
  it('distingue www de l’apex et repère le HTML réellement servi', () => {
    const summary = summariseCaptures('example.net', [
      { url: 'https://www.example.net/', timestamp: '20260101000000', status: 200, mime: 'text/html', digest: 'A', filename: null, offset: null, length: null },
      { url: 'https://example.net/contact', timestamp: '20250101000000', status: 404, mime: 'text/html', digest: 'B', filename: null, offset: null, length: null },
    ]);
    expect(summary.hasWww).toBe(true);
    expect(summary.hasApex).toBe(true);
    expect(summary.distinctUrls).toBe(2);
    expect(summary.firstCapture).toBe('20250101000000');
    expect(summary.lastCapture).toBe('20260101000000');
    expect(summary.servedHtml).toBe(true);
  });

  it('ne conclut pas au HTML servi si toutes les captures sont en erreur', () => {
    const summary = summariseCaptures('parked.fr', [
      { url: 'https://parked.fr/', timestamp: '20260101000000', status: 404, mime: 'text/html', digest: 'A', filename: null, offset: null, length: null },
    ]);
    expect(summary.servedHtml).toBe(false);
  });
});

describe('captureTimestampToDate / captureAgeDays', () => {
  it('convertit un horodatage CDX', () => {
    expect(captureTimestampToDate('20260714032627')?.toISOString()).toBe('2026-07-14T03:26:27.000Z');
    expect(captureTimestampToDate('20260714')?.toISOString()).toBe('2026-07-14T00:00:00.000Z');
  });

  it('refuse un horodatage mal formé', () => {
    expect(captureTimestampToDate('juillet 2026')).toBeNull();
    expect(captureTimestampToDate(null)).toBeNull();
  });

  it('mesure l’âge d’une vieille capture', () => {
    // Un site capturé en 2017 a existé. Il ne prouve pas qu'il vit encore, et
    // c'est exactement ce que la vérification d'identité doit pouvoir pondérer.
    const age = captureAgeDays({ lastCapture: '20170101000000' }, new Date('2026-08-10T00:00:00Z'));
    expect(age).toBeGreaterThan(3_000);
  });

  it('renvoie null quand aucune capture n’a été vue', () => {
    expect(captureAgeDays({ lastCapture: null })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------
describe('CommonCrawlClient', () => {
  it('interroge l’index le plus récent et s’arrête dès qu’il a trouvé', async () => {
    const { urls, http } = harness((url) => {
      if (url.endsWith('collinfo.json')) return { body: JSON.stringify(COLLINFO) };
      return {
        body: ndjson([
          { url: 'https://example.net/', timestamp: '20260714032627', mime: 'text/html', status: '200', digest: 'A' },
        ]),
      };
    });

    const lookup = await client(http).lookupDomain('example.net');
    expect(lookup.captures).toHaveLength(1);
    expect(lookup.indexId).toBe('CC-MAIN-2026-30');
    expect(lookup.error).toBeNull();
    // collinfo + un seul index : le second n'est pas payé.
    expect(urls.filter((url) => url.includes('-index')).length).toBe(1);
  });

  it('essaie l’index suivant quand le plus récent n’a rien vu', async () => {
    const { urls, http } = harness((url) => {
      if (url.endsWith('collinfo.json')) return { body: JSON.stringify(COLLINFO) };
      if (url.includes('2026-30')) return { status: 404, body: '{"message": "No Captures found for: x"}' };
      return { body: ndjson([{ url: 'https://x.fr/', timestamp: '20260601000000', mime: 'text/html', status: '200' }]) };
    });

    const lookup = await client(http).lookupDomain('x.fr');
    expect(lookup.indexId).toBe('CC-MAIN-2026-26');
    expect(lookup.captures).toHaveLength(1);
    expect(urls.filter((url) => url.includes('-index')).length).toBe(2);
  });

  it('renvoie zéro capture SANS erreur pour un domaine candidat inventé', async () => {
    // Le point le plus important du fichier : « pas dans l'index » n'est pas
    // une panne, et surtout pas une preuve que le domaine n'existe pas.
    const { http } = harness((url) =>
      url.endsWith('collinfo.json')
        ? { body: JSON.stringify(COLLINFO) }
        : { status: 404, body: '{"message": "No Captures found for: demo-02-exemple.fr"}' },
    );

    const lookup = await client(http).lookupDomain('demo-02-exemple.fr');
    expect(lookup.captures).toEqual([]);
    expect(lookup.servedHtml).toBe(false);
    expect(lookup.error).toBeNull();
  });

  it('signale une panne d’index sans lever', async () => {
    const { http } = harness((url) =>
      url.endsWith('collinfo.json') ? { body: JSON.stringify(COLLINFO) } : { status: 400, body: '{"message":"Invalid match_type: bogus"}' },
    );

    const lookup = await client(http, 1).lookupDomain('x.fr');
    expect(lookup.error).toContain('400');
    expect(lookup.captures).toEqual([]);
  });

  it('survit à un dépassement de délai', async () => {
    const { http } = harness((url) =>
      url.endsWith('collinfo.json')
        ? { body: JSON.stringify(COLLINFO) }
        : { body: '', delayMs: 2_000 },
    );

    const lookup = await client(http, 1).lookupDomain('lent.fr');
    expect(lookup.captures).toEqual([]);
    expect(lookup.error).toBeTruthy();
  });

  it('dégrade proprement quand la liste des index est injoignable', async () => {
    const { http } = harness(() => ({ status: 500, body: 'boom' }));
    const lookup = await client(http).lookupDomain('x.fr');
    expect(lookup.error).toContain('aucun index');
    expect(lookup.captures).toEqual([]);
  });

  it('demande du HTML et interroge le domaine, sous-domaines compris', async () => {
    const { urls, http } = harness((url) =>
      url.endsWith('collinfo.json')
        ? { body: JSON.stringify(COLLINFO) }
        : { body: ndjson([{ url: 'https://x.fr/', timestamp: '20260714000000', mime: 'text/html', status: '200' }]) },
    );

    await client(http, 1).lookupDomain('x.fr');
    const query = urls.find((url) => url.includes('-index'));
    expect(query).toContain('matchType=domain');
    expect(query).toContain('output=json');
    expect(query).toContain(encodeURIComponent('mime:text/html'));
  });
});
