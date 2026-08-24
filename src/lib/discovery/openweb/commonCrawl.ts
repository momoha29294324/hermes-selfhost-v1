import { env, envInt } from '@/lib/env';
import { normalizeDomain } from '@/lib/identity/normalize';
import type { HttpClient } from '@/lib/http/client';
import type { Logger } from '@/lib/logging/logger';
import type { Sql } from '@/lib/db/sql';

/**
 * Common Crawl — index d'URL public, gratuit, sans clé.
 *
 * Ce qu'il est : un index qui répond à « cette URL a-t-elle été vue par le
 * crawl, quand, avec quel code HTTP ». Interrogeable par URL, par hôte ou par
 * domaine.
 *
 * Ce qu'il n'est pas, et ce que ce fichier ne prétendra jamais : un moteur de
 * recherche plein texte. On ne peut pas lui demander « qui fait du atelier à
 * Lyon ». L'index CDX ne connaît que des URL. (Une recherche par contenu
 * existe côté Common Crawl, mais elle passe par les tables columnar sur S3 et
 * une infrastructure de requête — hors périmètre R3, et hors du « zéro euro ».)
 *
 * D'où son rôle exact ici, qui est utile et modeste : **corroborer qu'un
 * domaine candidat a réellement servi des pages.** Un domaine fabriqué à partir
 * d'un nom d'entreprise a de bonnes chances d'être une invention pure ; savoir
 * qu'un index public l'a déjà vu servir du HTML est une observation gratuite,
 * obtenue chez quelqu'un qui la propose explicitement. En prime, l'index dit si
 * c'est `www.` ou l'apex qui a répondu, ce que le DNS seul ne tranche pas.
 *
 * Deux limites, vérifiées en direct le 2026-08-10, gouvernent la façon dont ce
 * rail s'en sert — et elles sont plus importantes que ses capacités :
 *
 *   - **Une absence n'est pas une preuve d'absence.** Common Crawl
 *     échantillonne le web ; il ne l'énumère pas, et il couvre mal exactement
 *     la population qui nous intéresse (petites entreprises locales, peu
 *     liées). Un 404 de l'index veut dire « pas dans ce crawl », jamais « ce
 *     site n'existe pas ». Aucun candidat n'est donc rejeté faute de capture :
 *     la vérification DNS/HTTP tranche seule.
 *   - **La donnée est datée.** L'index le plus récent a 3 à 8 semaines de
 *     retard. Il atteste d'un passé, pas d'un présent — d'où `captureAgeDays`,
 *     que la vérification d'identité pondère au lieu de le croire.
 *
 * Le serveur est explicitement « frequently abused and therefore heavily rate
 * limited » : les appels passent par `ProviderScheduler` avec une concurrence
 * de 1 et un espacement d'au moins une seconde.
 *
 * Aucune fonction ici ne lève pour une raison réseau : un index indisponible
 * dégrade le rail, il ne l'arrête pas.
 */

export interface CommonCrawlCapture {
  url: string;
  /** Horodatage brut du crawl, `YYYYMMDDhhmmss`. */
  timestamp: string;
  status: number | null;
  mime: string | null;
  digest: string | null;
  /** Coordonnées WARC de la capture, quand l'index les expose. */
  filename: string | null;
  offset: number | null;
  length: number | null;
}

export interface CommonCrawlLookup {
  domain: string;
  indexId: string;
  matchType: 'domain' | 'host' | 'exact';
  /** Captures distinctes après déduplication (url + digest). */
  captures: CommonCrawlCapture[];
  /** Nombre de lignes renvoyées par l'index, doublons compris. */
  rawRecords: number;
  distinctUrls: number;
  firstCapture: string | null;
  lastCapture: string | null;
  /** Le domaine a été vu sous `www.` / sans `www.`. */
  hasWww: boolean;
  hasApex: boolean;
  /** Au moins une capture HTML répondant en 2xx : le domaine a servi du contenu. */
  servedHtml: boolean;
  httpStatus: number | null;
  durationMs: number;
  fromCache: boolean;
  /** Renseigné quand l'index n'a pas pu répondre. Zéro capture n'est pas une erreur. */
  error: string | null;
}

export interface CommonCrawlIndex {
  id: string;
  name: string;
  cdxApi: string;
}

const DEFAULT_BASE_URL = 'https://index.commoncrawl.org';

/**
 * Combien d'index récents interroger au maximum.
 *
 * Un seul index couvre environ un mois de crawl et ne voit qu'une fraction du
 * web ; un domaine réel mais petit peut manquer au dernier. Deux index
 * remontent nettement le rappel pour un coût borné. Au-delà, on paie des
 * requêtes pour confirmer ce qu'on sait déjà.
 */
const DEFAULT_INDEX_DEPTH = 2;

/** Plafond de lignes demandées par requête. */
const DEFAULT_LIMIT = 40;

export function commonCrawlBaseUrl(): string {
  return (env('OUTBOUND_COMMON_CRAWL_URL', DEFAULT_BASE_URL) as string).replace(/\/$/, '');
}

export function commonCrawlEnabled(): { ok: boolean; reason?: string } {
  // Gratuit et sans clé : activé par défaut, désactivable pour un run hors ligne.
  if (env('OUTBOUND_COMMON_CRAWL_ENABLED', '1') === '0') {
    return { ok: false, reason: 'OUTBOUND_COMMON_CRAWL_ENABLED=0' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Parsing — pur, testable, tolérant
// ---------------------------------------------------------------------------

interface RawCdxRecord {
  url?: string;
  timestamp?: string;
  status?: string | number;
  mime?: string;
  'mime-detected'?: string;
  digest?: string;
  filename?: string;
  offset?: string | number;
  length?: string | number;
  /**
   * Le serveur signale l'absence et les paramètres invalides sous `message`
   * (`{"message":"No Captures found for: …"}`, `{"message":"Invalid match_type: …"}`).
   * `error` est conservé parce que d'anciennes réponses l'utilisent et que
   * lire les deux ne coûte rien.
   */
  message?: string;
  error?: string;
}

function toInt(value: string | number | undefined): number | null {
  if (value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Lit une réponse CDX.
 *
 * Le format est du NDJSON : une ligne JSON par capture. Une absence de capture
 * arrive sous la forme d'un objet `{"error": "No Captures found for: …"}`, avec
 * un statut HTTP 404 — ce n'est pas une panne, c'est une réponse. Les deux cas
 * sont distingués ici pour que l'appelant n'ait pas à deviner.
 *
 * Une ligne illisible est ignorée, jamais fatale : un index public qui renvoie
 * une ligne tronquée ne doit pas faire tomber un run.
 */
export function parseCdxResponse(body: string): {
  captures: CommonCrawlCapture[];
  rawRecords: number;
  noCaptures: boolean;
  serverMessage: string | null;
  malformedLines: number;
} {
  const captures: CommonCrawlCapture[] = [];
  const seen = new Set<string>();
  let rawRecords = 0;
  let malformedLines = 0;
  let noCaptures = false;
  let serverMessage: string | null = null;

  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let record: RawCdxRecord;
    try {
      record = JSON.parse(trimmed) as RawCdxRecord;
    } catch {
      malformedLines += 1;
      continue;
    }

    const notice = record.message ?? record.error;
    if (notice) {
      serverMessage = notice;
      // L'index annonce lui-même l'absence de capture. Ce n'est pas une panne,
      // et — point important — ce n'est pas non plus une preuve que le domaine
      // n'existe pas : Common Crawl échantillonne le web, il ne l'énumère pas.
      if (/no captures/i.test(notice)) noCaptures = true;
      continue;
    }
    if (!record.url || !record.timestamp) {
      malformedLines += 1;
      continue;
    }

    rawRecords += 1;

    /**
     * Déduplication sur (url, digest). Un même document réapparaît d'un crawl à
     * l'autre avec le même digest ; le compter plusieurs fois donnerait
     * l'illusion d'un site actif là où il n'y a qu'une page figée recapturée.
     * `rawRecords` conserve le compte brut pour que la différence reste visible.
     */
    const key = `${record.url}|${record.digest ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    captures.push({
      url: record.url,
      timestamp: record.timestamp,
      status: toInt(record.status),
      mime: record.mime ?? record['mime-detected'] ?? null,
      digest: record.digest ?? null,
      filename: record.filename ?? null,
      offset: toInt(record.offset),
      length: toInt(record.length),
    });
  }

  return { captures, rawRecords, noCaptures, serverMessage, malformedLines };
}

/** Réduit un lot de captures aux faits qui servent à décider. */
export function summariseCaptures(
  domain: string,
  captures: CommonCrawlCapture[],
): Pick<CommonCrawlLookup, 'distinctUrls' | 'firstCapture' | 'lastCapture' | 'hasWww' | 'hasApex' | 'servedHtml'> {
  const urls = new Set<string>();
  let first: string | null = null;
  let last: string | null = null;
  let hasWww = false;
  let hasApex = false;
  let servedHtml = false;

  for (const capture of captures) {
    urls.add(capture.url);
    if (first === null || capture.timestamp < first) first = capture.timestamp;
    if (last === null || capture.timestamp > last) last = capture.timestamp;

    let host: string;
    try {
      host = new URL(capture.url).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (host === `www.${domain}`) hasWww = true;
    if (host === domain) hasApex = true;

    if (capture.status !== null && capture.status >= 200 && capture.status < 300) {
      if (!capture.mime || /html/i.test(capture.mime)) servedHtml = true;
    }
  }

  return { distinctUrls: urls.size, firstCapture: first, lastCapture: last, hasWww, hasApex, servedHtml };
}

/** Convertit un horodatage CDX (`YYYYMMDDhhmmss`) en Date, ou null. */
export function captureTimestampToDate(timestamp: string | null): Date | null {
  if (!timestamp || !/^\d{8}(\d{6})?$/.test(timestamp)) return null;
  const iso =
    `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}` +
    (timestamp.length === 14
      ? `T${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)}:${timestamp.slice(12, 14)}Z`
      : 'T00:00:00Z');
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Âge de la dernière capture, en jours.
 *
 * Une capture de 2016 prouve qu'un domaine a existé, pas qu'il vit encore. La
 * vérification d'identité s'en sert pour pondérer, jamais pour rejeter seule :
 * un artisan dont le site est stable depuis huit ans est un client, pas un
 * fantôme.
 */
export function captureAgeDays(lookup: Pick<CommonCrawlLookup, 'lastCapture'>, now = new Date()): number | null {
  const date = captureTimestampToDate(lookup.lastCapture);
  if (!date) return null;
  return Math.floor((now.getTime() - date.getTime()) / 86_400_000);
}

function emptyLookup(
  domain: string,
  indexId: string,
  matchType: CommonCrawlLookup['matchType'],
  overrides: Partial<CommonCrawlLookup> = {},
): CommonCrawlLookup {
  return {
    domain,
    indexId,
    matchType,
    captures: [],
    rawRecords: 0,
    distinctUrls: 0,
    firstCapture: null,
    lastCapture: null,
    hasWww: false,
    hasApex: false,
    servedHtml: false,
    httpStatus: null,
    durationMs: 0,
    fromCache: false,
    error: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface CommonCrawlClientOptions {
  http: HttpClient;
  logger: Logger;
  baseUrl?: string;
  /** Nombre d'index récents interrogés par domaine. */
  indexDepth?: number;
  limit?: number;
  timeoutMs?: number;
  /** Horloge injectable, pour que les tests ne dépendent pas du temps réel. */
  now?: () => number;
}

export class CommonCrawlClient {
  private readonly http: HttpClient;
  private readonly logger: Logger;
  private readonly baseUrl: string;
  private readonly indexDepth: number;
  private readonly limit: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private indexes: CommonCrawlIndex[] | null = null;

  constructor(options: CommonCrawlClientOptions) {
    this.http = options.http;
    this.logger = options.logger;
    this.baseUrl = (options.baseUrl ?? commonCrawlBaseUrl()).replace(/\/$/, '');
    this.indexDepth = options.indexDepth ?? envInt('OUTBOUND_COMMON_CRAWL_INDEX_DEPTH', DEFAULT_INDEX_DEPTH);
    this.limit = options.limit ?? DEFAULT_LIMIT;
    this.timeoutMs = options.timeoutMs ?? envInt('OUTBOUND_COMMON_CRAWL_TIMEOUT_MS', 25_000);
    this.now = options.now ?? Date.now;
  }

  /**
   * Les index disponibles, du plus récent au plus ancien.
   *
   * `collinfo.json` est le point d'entrée officiel ; le coder en dur
   * condamnerait le rail au premier crawl suivant. Le résultat est mémorisé
   * pour la durée du processus — la liste change une fois par mois.
   */
  async listIndexes(): Promise<CommonCrawlIndex[]> {
    if (this.indexes) return this.indexes;
    try {
      const payload = await this.http.getJson<{ id?: string; name?: string; 'cdx-api'?: string }[]>(
        `${this.baseUrl}/collinfo.json`,
        { timeoutMs: this.timeoutMs, attempts: 2 },
      );
      const parsed = (Array.isArray(payload) ? payload : [])
        .filter((entry): entry is { id: string; name?: string; 'cdx-api'?: string } => Boolean(entry.id))
        .map((entry) => ({
          id: entry.id,
          name: entry.name ?? entry.id,
          cdxApi: entry['cdx-api'] ?? `${this.baseUrl}/${entry.id}-index`,
        }));
      this.indexes = parsed;
      return parsed;
    } catch (error) {
      this.logger.warn('commoncrawl.collinfo_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.indexes = [];
      return [];
    }
  }

  /**
   * Interroge un index pour un domaine.
   *
   * Ne lève jamais : une panne d'index revient sous la forme d'un lookup dont
   * `error` est renseigné et `captures` vide, ce qui laisse la décision à
   * l'appelant plutôt que de la lui imposer par une exception.
   */
  async lookupInIndex(
    domain: string,
    index: CommonCrawlIndex,
    matchType: CommonCrawlLookup['matchType'] = 'domain',
  ): Promise<CommonCrawlLookup> {
    const normalized = normalizeDomain(domain);
    if (!normalized) {
      return emptyLookup(domain, index.id, matchType, { error: 'domaine illisible' });
    }

    const params = new URLSearchParams({
      url: normalized,
      matchType,
      output: 'json',
      limit: String(this.limit),
      // Seules les pages HTML nous intéressent : une image indexée ne dit rien
      // sur l'existence d'un site.
      filter: 'mime:text/html',
    });
    const url = `${index.cdxApi}?${params.toString()}`;
    const startedAt = this.now();

    try {
      const response = await this.http.get(url, {
        timeoutMs: this.timeoutMs,
        attempts: 2,
        headers: { accept: 'application/json' },
      });
      const parsed = parseCdxResponse(response.body);
      const summary = summariseCaptures(normalized, parsed.captures);

      // 404 + « no captures » est la façon dont l'index dit « rien vu ».
      const isNoCaptures = parsed.noCaptures || (response.status === 404 && parsed.captures.length === 0);
      const failed = !response.ok && !isNoCaptures;

      return {
        domain: normalized,
        indexId: index.id,
        matchType,
        captures: parsed.captures,
        rawRecords: parsed.rawRecords,
        ...summary,
        httpStatus: response.status,
        durationMs: this.now() - startedAt,
        fromCache: response.fromCache,
        error: failed ? `index HTTP ${response.status}` : null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('commoncrawl.lookup_failed', { domain: normalized, index: index.id, error: message });
      return emptyLookup(normalized, index.id, matchType, {
        durationMs: this.now() - startedAt,
        error: message,
      });
    }
  }

  /**
   * Interroge les index les plus récents et fusionne le résultat.
   *
   * S'arrête dès qu'un index a vu le domaine : au-delà, on paierait des
   * requêtes pour confirmer une réponse déjà obtenue.
   */
  async lookupDomain(
    domain: string,
    matchType: CommonCrawlLookup['matchType'] = 'domain',
  ): Promise<CommonCrawlLookup> {
    const indexes = await this.listIndexes();
    if (indexes.length === 0) {
      return emptyLookup(normalizeDomain(domain) ?? domain, 'unknown', matchType, {
        error: 'aucun index Common Crawl disponible',
      });
    }

    let fallback: CommonCrawlLookup | null = null;
    for (const index of indexes.slice(0, Math.max(1, this.indexDepth))) {
      const lookup = await this.lookupInIndex(domain, index, matchType);
      if (lookup.captures.length > 0) return lookup;
      /**
       * Aucune capture. On garde de préférence une réponse SAINE (« l'index a
       * répondu, il n'a rien vu ») plutôt qu'une panne : les deux donnent zéro
       * capture, mais seule la première autorise à dire que l'index a été
       * consulté. La distinction compte pour le rapport, pas pour la décision —
       * une absence ne rejette jamais un candidat.
       */
      if (fallback === null || (fallback.error !== null && lookup.error === null)) fallback = lookup;
    }
    return fallback ?? emptyLookup(normalizeDomain(domain) ?? domain, indexes[0]?.id ?? 'unknown', matchType);
  }
}

/**
 * Écrit une ligne de journal. Séparé du client pour que celui-ci reste
 * testable sans base de données.
 */
export async function recordCommonCrawlLookup(
  sql: Sql,
  runId: string | null,
  lookup: CommonCrawlLookup,
): Promise<void> {
  await sql.query(
    `insert into common_crawl_lookups
       (run_id, queried_domain, index_id, match_type, http_status, captures, distinct_urls,
        first_capture, last_capture, from_cache, duration_ms, error)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      runId,
      lookup.domain,
      lookup.indexId,
      lookup.matchType,
      lookup.httpStatus,
      lookup.captures.length,
      lookup.distinctUrls,
      lookup.firstCapture,
      lookup.lastCapture,
      lookup.fromCache,
      lookup.durationMs,
      lookup.error,
    ],
  );
}
