#!/usr/bin/env tsx
/**
 * Before/after benchmark of the Web Intelligence worker, on the existing corpus.
 *
 *   npm run webintel:benchmark -- --limit 60
 *   npm run webintel:benchmark -- --dry-run          # measure only, write nothing
 *   npm run webintel:benchmark -- --report var/bench # where the two files land
 *
 * Design constraints that matter for the result to mean anything:
 *
 *   - it runs on the prospects already in the database, not a fresh discovery,
 *     so the "before" and "after" columns describe the same businesses;
 *   - it calls the *same* functions the pipeline calls (`decideFromResolution`,
 *     `crawlViaWebIntel`) rather than a benchmark-only shortcut, so what is
 *     measured is what will actually run;
 *   - it touches no scoring weight, threshold or prompt. Only the data changes.
 *
 * Re-running it is safe: evidence is append-only and `fillMissingColumns` only
 * ever fills blanks, so a second pass cannot overwrite a first result.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { getSql } from '@/lib/db';
import { logger } from '@/lib/logging/logger';
import { loadNiche } from '@/lib/config/load';
import { ProspectRepository } from '@/lib/repo/prospects';
import { HttpClient } from '@/lib/http/client';
import { createWebIntelClient, decideFromResolution, crawlViaWebIntel } from '@/lib/enrichment/webintel';
import type { Sql } from '@/lib/db/sql';
import type { ProspectRow } from '@/lib/repo/types';

interface CorpusMetrics {
  prospects: number;
  withWebsite: number;
  withInstagram: number;
  withFacebook: number;
  withPhone: number;
  withEmail: number;
  withAnyWebPresence: number;
  withFunnelEvidence: number;
  withCrawledPages: number;
  evidenceTotal: number;
  evidenceAverage: number;
}

interface ProspectOutcome {
  id: string;
  name: string;
  city: string | null;
  hadWebsiteBefore: boolean;
  hadInstagramBefore: boolean;
  status: string;
  confidence: number;
  attachedWebsite: string | null;
  attachedInstagram: string | null;
  attachedFacebook: string | null;
  /** A URL was available to crawl — pre-existing or newly attached. */
  websiteAvailable: boolean;
  crawlPages: number;
  browserFallbacks: number;
  funnelObserved: number;
  resolveMs: number;
  crawlMs: number;
  error: string | null;
}

const FUNNEL_FIELDS = ['funnel_observed', 'funnel_not_observed'];

async function measure(sql: Sql, ids: string[]): Promise<CorpusMetrics> {
  if (ids.length === 0) {
    return {
      prospects: 0,
      withWebsite: 0,
      withInstagram: 0,
      withFacebook: 0,
      withPhone: 0,
      withEmail: 0,
      withAnyWebPresence: 0,
      withFunnelEvidence: 0,
      withCrawledPages: 0,
      evidenceTotal: 0,
      evidenceAverage: 0,
    };
  }

  const rows = await sql.query<{
    total: string;
    with_site: string;
    with_ig: string;
    with_fb: string;
    with_phone: string;
    with_email: string;
    with_presence: string;
  }>(
    `select count(*)::text                                                            as total,
            count(*) filter (where website_url is not null)::text                     as with_site,
            count(*) filter (where instagram_handle is not null)::text                as with_ig,
            count(*) filter (where facebook_url is not null)::text                    as with_fb,
            count(*) filter (where phone is not null)::text                           as with_phone,
            count(*) filter (where email is not null)::text                           as with_email,
            count(*) filter (where website_url is not null
                                or instagram_handle is not null
                                or facebook_url is not null)::text                    as with_presence
       from prospects where id = any($1::uuid[])`,
    [ids],
  );
  const row = rows[0];

  const evidence = await sql.query<{ total: string; with_funnel: string; with_pages: string }>(
    `select count(*)::text as total,
            count(distinct prospect_id) filter (where field = any($2::text[]))::text as with_funnel,
            count(distinct prospect_id) filter (where field = 'website_quality')::text as with_pages
       from prospect_evidence where prospect_id = any($1::uuid[])`,
    [ids, FUNNEL_FIELDS],
  );
  const evidenceRow = evidence[0];

  const prospects = Number.parseInt(row?.total ?? '0', 10);
  const evidenceTotal = Number.parseInt(evidenceRow?.total ?? '0', 10);

  return {
    prospects,
    withWebsite: Number.parseInt(row?.with_site ?? '0', 10),
    withInstagram: Number.parseInt(row?.with_ig ?? '0', 10),
    withFacebook: Number.parseInt(row?.with_fb ?? '0', 10),
    withPhone: Number.parseInt(row?.with_phone ?? '0', 10),
    withEmail: Number.parseInt(row?.with_email ?? '0', 10),
    withAnyWebPresence: Number.parseInt(row?.with_presence ?? '0', 10),
    withFunnelEvidence: Number.parseInt(evidenceRow?.with_funnel ?? '0', 10),
    withCrawledPages: Number.parseInt(evidenceRow?.with_pages ?? '0', 10),
    evidenceTotal,
    evidenceAverage: prospects === 0 ? 0 : Number((evidenceTotal / prospects).toFixed(2)),
  };
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number(((numerator / denominator) * 100).toFixed(1));
}

function arg(name: string, fallback: string | null = null): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  return process.argv[index + 1] ?? fallback;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  // A re-run replays the search cache, which is right for production and wrong
  // for a measurement: it would report the previous run's engine pool.
  const noCache = process.argv.includes('--no-cache');
  const limit = Number.parseInt(arg('limit', '60') as string, 10);
  const reportDir = resolvePath(process.cwd(), arg('report', 'var/benchmarks') as string);
  const nicheKey = arg('niche', 'example-services') as string;
  /**
   * R7.2 §4 — deux restrictions de corpus, pour que la même boucle serve aussi
   * à COMPLÉTER des données et pas seulement à mesurer.
   *
   * Le sélecteur d'origine (`niche_verdict = 'in_niche'`, meilleurs scores
   * d'abord) est le bon corpus pour un benchmark : des prospects comparables,
   * déjà classés. C'est le mauvais corpus pour une collecte, et de deux façons
   * opposées :
   *
   *   - il EXCLUT les 197 prospects jamais classés — exactement ceux qui n'ont
   *     jamais été résolus, faute d'être entrés dans le pool d'enrichissement
   *     (`targetProspects: 20` ⇒ pool de 60 sur 257 en campagne historique) ;
   *   - il INCLUT en tête les prospects déjà lus, qui trient par score
   *     décroissant et repoussent donc les cibles réelles en fin de course —
   *     là où le vivier de moteurs de recherche est le plus dégradé.
   *
   * Ces deux drapeaux ne changent QUE le choix des lignes. La résolution, le
   * crawl, l'extraction et l'écriture restent les mêmes appels, aux mêmes
   * fonctions : aucun second crawler, aucun chemin HTTP neuf, aucune écriture
   * nouvelle.
   */
  const onlyMissing = process.argv.includes('--only-missing');
  const includeUnclassified = process.argv.includes('--include-unclassified');

  const sql = await getSql();
  const repo = new ProspectRepository(sql, logger);
  const niche = await loadNiche(nicheKey);

  const http = new HttpClient({ sql: null, minHostIntervalMs: 0 });
  const webintel = createWebIntelClient(http);
  if (!webintel) {
    throw new Error(
      'Web Intelligence non configuré : renseignez OUTBOUND_WEBINTEL_URL et OUTBOUND_WEBINTEL_TOKEN dans .env',
    );
  }

  const health = await webintel.health();
  logger.info('bench.worker_health', { status: health.status, version: health.version });

  // The corpus: the classified prospects, best-scored first, exactly the ones
  // the pipeline would take through research — unless a restriction below
  // narrows it to the prospects whose site has never been read.
  const nicheClause = includeUnclassified
    ? `(p.niche_verdict = 'in_niche' or p.niche_verdict is null)`
    : `p.niche_verdict = 'in_niche'`;
  /**
   * « Aucune preuve de lecture de site » se lit sur les champs que le moteur
   * consomme réellement (`commercialSignals.readCommercialFacts`), et non sur
   * `prospects.domain` : un prospect peut porter un domaine sans qu'aucune page
   * n'ait été lue, et c'est la lecture qui manque, pas l'URL.
   */
  const missingClause = onlyMissing
    ? `and not exists (
         select 1 from prospect_evidence e
          where e.prospect_id = p.id
            and e.field in ('website_quality','cta_quality','funnel_observed',
                            'funnel_not_observed','booking_system','funnel_synthesis'))`
    : '';
  const corpus = await sql.query<ProspectRow>(
    `select p.* from prospects p
      where ${nicheClause} and p.dedupe_status <> 'merged'
      ${missingClause}
      order by p.score desc nulls last, p.display_name asc
      limit $1`,
    [limit],
  );
  const ids = corpus.map((prospect) => prospect.id);
  logger.info('bench.corpus', { prospects: ids.length, onlyMissing, includeUnclassified });

  const before = await measure(sql, ids);
  const startedAt = Date.now();
  const outcomes: ProspectOutcome[] = [];

  let providerFailures = 0;
  let providerCalls = 0;

  for (const [index, prospect] of corpus.entries()) {
    const outcome: ProspectOutcome = {
      id: prospect.id,
      name: prospect.display_name,
      city: prospect.city,
      hadWebsiteBefore: prospect.website_url !== null,
      hadInstagramBefore: prospect.instagram_handle !== null,
      status: 'skipped',
      confidence: 0,
      attachedWebsite: null,
      attachedInstagram: null,
      attachedFacebook: null,
      websiteAvailable: false,
      crawlPages: 0,
      browserFallbacks: 0,
      funnelObserved: 0,
      resolveMs: 0,
      crawlMs: 0,
      error: null,
    };

    let websiteUrl = prospect.website_url;

    try {
      providerCalls += 1;
      const resolveStarted = Date.now();
      const resolution = await webintel.resolveBusiness({
        name: prospect.display_name,
        country: prospect.country,
        city: prospect.city,
        postalCode: prospect.postal_code,
        addressLine: prospect.address_line,
        registryId: prospect.registry_id,
        phone: prospect.phone,
        nicheHints: niche.positiveTerms.slice(0, 2),
        noCache,
      });
      outcome.resolveMs = Date.now() - resolveStarted;

      const decision = decideFromResolution(prospect.display_name, resolution);
      outcome.status = decision.status;
      outcome.confidence = Number(decision.confidence.toFixed(3));
      outcome.attachedWebsite = decision.attachWebsiteUrl;
      outcome.attachedInstagram = decision.attachInstagram;
      outcome.attachedFacebook = decision.attachFacebook;

      if (!dryRun) {
        for (const item of decision.evidence) await repo.addEvidence(prospect.id, item);
        await repo.fillMissingColumns(prospect.id, {
          website_url: decision.attachWebsiteUrl,
          domain: decision.attachDomain,
          instagram_handle: decision.attachInstagram,
          facebook_url: decision.attachFacebook,
        });
      }
      websiteUrl = websiteUrl ?? decision.attachWebsiteUrl;
    } catch (error) {
      providerFailures += 1;
      outcome.error = error instanceof Error ? error.message : String(error);
      logger.warn('bench.resolve_failed', { prospect: prospect.id, error: outcome.error });
    }

    outcome.websiteAvailable = websiteUrl !== null;

    if (websiteUrl) {
      const crawlStarted = Date.now();
      providerCalls += 1;
      const crawl = await crawlViaWebIntel(webintel, logger, websiteUrl, niche, 6);
      outcome.crawlMs = Date.now() - crawlStarted;
      if (crawl) {
        outcome.crawlPages = crawl.pagesCrawled.length;
        outcome.browserFallbacks = crawl.browserFallbacks;
        outcome.funnelObserved = crawl.funnelObserved;
        if (!dryRun) {
          for (const item of crawl.evidence) await repo.addEvidence(prospect.id, item);
          await repo.fillMissingColumns(prospect.id, {
            email: crawl.contact.email,
            phone: crawl.contact.phone,
            instagram_handle: crawl.contact.instagramHandle,
            facebook_url: crawl.contact.facebookUrl,
          });
        }
      } else {
        providerFailures += 1;
      }
    }

    outcomes.push(outcome);
    process.stdout.write(
      `[${index + 1}/${corpus.length}] ${prospect.display_name} — ${outcome.status}` +
        `${outcome.attachedWebsite ? ` → ${outcome.attachedWebsite}` : ''}` +
        `${outcome.attachedInstagram ? ` → @${outcome.attachedInstagram}` : ''}` +
        ` (${outcome.resolveMs + outcome.crawlMs} ms)\n`,
    );
  }

  const durationMs = Date.now() - startedAt;
  const after = await measure(sql, ids);

  // ---------------------------------------------------------------- rates
  const poorBefore = outcomes.filter((outcome) => !outcome.hadWebsiteBefore);
  const withoutInstagramBefore = outcomes.filter((outcome) => !outcome.hadInstagramBefore);
  const resolvedSites = outcomes.filter((outcome) => outcome.attachedWebsite !== null);
  // A site is crawlable whether the worker found it or the registry already had
  // it. Adding the two would count the pre-existing ones twice.
  const crawlable = outcomes.filter((outcome) => outcome.websiteAvailable);
  const crawled = outcomes.filter((outcome) => outcome.crawlPages > 0);
  const totalPages = outcomes.reduce((sum, outcome) => sum + outcome.crawlPages, 0);
  const totalFallbacks = outcomes.reduce((sum, outcome) => sum + outcome.browserFallbacks, 0);

  const report = {
    generatedAt: new Date().toISOString(),
    dryRun,
    noCache,
    corpus: { prospects: corpus.length, niche: nicheKey },
    worker: { status: health.status, version: health.version },
    before,
    after,
    delta: {
      withWebsite: after.withWebsite - before.withWebsite,
      withInstagram: after.withInstagram - before.withInstagram,
      withFacebook: after.withFacebook - before.withFacebook,
      withPhone: after.withPhone - before.withPhone,
      withEmail: after.withEmail - before.withEmail,
      withAnyWebPresence: after.withAnyWebPresence - before.withAnyWebPresence,
      withFunnelEvidence: after.withFunnelEvidence - before.withFunnelEvidence,
      evidenceAverage: Number((after.evidenceAverage - before.evidenceAverage).toFixed(2)),
    },
    rates: {
      businessToSitePercent: rate(resolvedSites.length, outcomes.length),
      poorBusinessToSitePercent: rate(
        poorBefore.filter((outcome) => outcome.attachedWebsite !== null).length,
        poorBefore.length,
      ),
      businessToInstagramPercent: rate(
        withoutInstagramBefore.filter((outcome) => outcome.attachedInstagram !== null).length,
        withoutInstagramBefore.length,
      ),
      resolvedSiteToCrawlPercent: rate(crawled.length, crawlable.length),
      crawlToFunnelEvidencePercent: rate(
        crawled.filter((outcome) => outcome.funnelObserved > 0).length,
        crawled.length,
      ),
      browserFallbackPercent: rate(totalFallbacks, totalPages),
      providerFailurePercent: rate(providerFailures, providerCalls),
    },
    latency: {
      totalMs: durationMs,
      averagePerProspectMs: Math.round(durationMs / Math.max(1, outcomes.length)),
      averageResolveMs: Math.round(
        outcomes.reduce((sum, outcome) => sum + outcome.resolveMs, 0) / Math.max(1, outcomes.length),
      ),
      averageCrawlMs: Math.round(
        crawled.reduce((sum, outcome) => sum + outcome.crawlMs, 0) / Math.max(1, crawled.length),
      ),
    },
    statusBreakdown: outcomes.reduce<Record<string, number>>((acc, outcome) => {
      acc[outcome.status] = (acc[outcome.status] ?? 0) + 1;
      return acc;
    }, {}),
    cost: { externalApiEuros: 0, note: 'SearXNG et crawler auto-hébergés sur le serveur — aucune API payante' },
    outcomes,
  };

  await mkdir(reportDir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, '-');
  const jsonPath = resolvePath(reportDir, `webintel-${stamp}.json`);
  const mdPath = resolvePath(reportDir, `webintel-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(mdPath, renderMarkdown(report), 'utf8');

  process.stdout.write(`\n${renderMarkdown(report)}\n`);
  process.stdout.write(`Rapport JSON : ${jsonPath}\n`);
  process.stdout.write(`Rapport MD   : ${mdPath}\n`);

  await sql.close();
}

function renderMarkdown(report: {
  generatedAt: string;
  dryRun: boolean;
  corpus: { prospects: number; niche: string };
  before: CorpusMetrics;
  after: CorpusMetrics;
  delta: Record<string, number>;
  rates: Record<string, number>;
  latency: Record<string, number>;
  statusBreakdown: Record<string, number>;
  cost: { externalApiEuros: number; note: string };
}): string {
  const line = (label: string, before: number, after: number): string =>
    `| ${label} | ${before} | ${after} | ${after - before >= 0 ? '+' : ''}${after - before} |`;

  return [
    `# Benchmark Web Intelligence — ${report.generatedAt}`,
    '',
    `Corpus : ${report.corpus.prospects} prospects \`in_niche\` (niche \`${report.corpus.niche}\`)` +
      `${report.dryRun ? ' — **mesure seule, rien écrit**' : ''}.`,
    '',
    '## Avant / après',
    '',
    '| Métrique | Avant | Après | Δ |',
    '| --- | ---: | ---: | ---: |',
    line('Prospects avec un site', report.before.withWebsite, report.after.withWebsite),
    line('Prospects avec un Instagram', report.before.withInstagram, report.after.withInstagram),
    line('Prospects avec un Facebook', report.before.withFacebook, report.after.withFacebook),
    line('Prospects avec un téléphone', report.before.withPhone, report.after.withPhone),
    line('Prospects avec un e-mail', report.before.withEmail, report.after.withEmail),
    line('Prospects avec une présence web', report.before.withAnyWebPresence, report.after.withAnyWebPresence),
    line('Prospects avec des signaux funnel', report.before.withFunnelEvidence, report.after.withFunnelEvidence),
    line('Prospects avec un site lu', report.before.withCrawledPages, report.after.withCrawledPages),
    line('Evidences (total)', report.before.evidenceTotal, report.after.evidenceTotal),
    `| Evidences par prospect (moyenne) | ${report.before.evidenceAverage} | ${report.after.evidenceAverage} | ${report.delta['evidenceAverage'] ?? 0} |`,
    '',
    '## Taux',
    '',
    '| Taux | Valeur |',
    '| --- | ---: |',
    `| business → site | ${report.rates['businessToSitePercent']} % |`,
    `| business sans site → site | ${report.rates['poorBusinessToSitePercent']} % |`,
    `| business → Instagram | ${report.rates['businessToInstagramPercent']} % |`,
    `| site résolu → crawl réussi | ${report.rates['resolvedSiteToCrawlPercent']} % |`,
    `| crawl → signaux funnel exploitables | ${report.rates['crawlToFunnelEvidencePercent']} % |`,
    `| pages passées par le navigateur | ${report.rates['browserFallbackPercent']} % |`,
    `| échecs fournisseur | ${report.rates['providerFailurePercent']} % |`,
    '',
    '## Latence',
    '',
    `- total : ${Math.round((report.latency['totalMs'] ?? 0) / 1000)} s`,
    `- par prospect : ${report.latency['averagePerProspectMs']} ms`,
    `- résolution : ${report.latency['averageResolveMs']} ms`,
    `- crawl : ${report.latency['averageCrawlMs']} ms`,
    '',
    '## Statuts de résolution',
    '',
    ...Object.entries(report.statusBreakdown).map(([status, count]) => `- \`${status}\` : ${count}`),
    '',
    '## Coût',
    '',
    `**${report.cost.externalApiEuros} €.** ${report.cost.note}`,
    '',
  ].join('\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
