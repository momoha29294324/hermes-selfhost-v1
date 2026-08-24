#!/usr/bin/env tsx
/**
 * Benchmark A — le rail web ouvert sur le corpus existant.
 *
 *   npm run discovery:benchmark -- --limit 60
 *   npm run discovery:benchmark -- --dry-run        # mesure seule, rien écrit
 *   npm run discovery:benchmark -- --no-common-crawl
 *
 * Ce que le §20 du gate exige et que ce fichier respecte :
 *
 *   - il tourne sur les prospects DÉJÀ en base, pas sur une découverte
 *     fraîche : « avant » et « après » décrivent les mêmes entreprises ;
 *   - il appelle les MÊMES fonctions que le pipeline (`resolveProspectDomain`,
 *     `crawlViaWebIntel`, `assessReach`), jamais un raccourci de benchmark ;
 *   - il ne touche ni pondération, ni seuil, ni prompt ;
 *   - **aucun prospect n'est modifié à la main pour améliorer le résultat.**
 *
 * Les deux mesures encadrantes passent par `readOnlyQuery` : un outil de mesure
 * qui écrit mesure son propre effet. Le rail, lui, écrit — c'est son travail,
 * et c'est la seule mutation que ce fichier autorise.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { getSql } from '@/lib/db';
import { logger } from '@/lib/logging/logger';
import { loadNiche } from '@/lib/config/load';
import { HttpClient } from '@/lib/http/client';
import { ProspectRepository } from '@/lib/repo/prospects';
import { readOnlyQuery } from '@/lib/db/safety';
import { ProviderScheduler } from '@/lib/http/scheduler';
import { CommonCrawlClient, commonCrawlEnabled } from '@/lib/discovery/openweb/commonCrawl';
import {
  openWebSchedulerLimits,
  resolveProspectDomain,
  type OpenWebProspectOutcome,
} from '@/lib/discovery/openweb/railOpenWeb';
import { createWebIntelClient, crawlViaWebIntel } from '@/lib/enrichment/webintel';
import { assessReach } from '@/lib/pipeline/reach';
import { metaAccessStates, recordSourceAccess } from '@/lib/discovery/meta/access';
import type { Sql } from '@/lib/db/sql';
import type { ProspectRow } from '@/lib/repo/types';

interface CorpusMetrics {
  prospects: number;
  withWebsite: number;
  withDomain: number;
  withInstagram: number;
  withFacebook: number;
  withPhone: number;
  withEmail: number;
  withRegistryId: number;
  contactable: number;
  funnelObservable: number;
  /** Le KPI principal du §22 : dans la niche, joignable, lisible. */
  qualifiedContactableObservable: number;
  evidenceTotal: number;
  evidencePerProspect: number;
}

const MEASURE = `
  select count(*)::text                                                       as prospects,
         count(*) filter (where website_url is not null)::text                as with_site,
         count(*) filter (where domain is not null)::text                     as with_domain,
         count(*) filter (where instagram_handle is not null)::text           as with_ig,
         count(*) filter (where facebook_url is not null)::text               as with_fb,
         count(*) filter (where phone is not null)::text                      as with_phone,
         count(*) filter (where email is not null)::text                      as with_email,
         count(*) filter (where registry_id is not null)::text                as with_registry,
         count(*) filter (where contactable)::text                            as contactable,
         count(*) filter (where funnel_observable)::text                      as funnel_observable,
         count(*) filter (where contactable and funnel_observable)::text      as kpi
    from prospects where id = any($1::uuid[])
`;

async function measure(sql: Sql, ids: string[]): Promise<CorpusMetrics> {
  const empty: CorpusMetrics = {
    prospects: 0,
    withWebsite: 0,
    withDomain: 0,
    withInstagram: 0,
    withFacebook: 0,
    withPhone: 0,
    withEmail: 0,
    withRegistryId: 0,
    contactable: 0,
    funnelObservable: 0,
    qualifiedContactableObservable: 0,
    evidenceTotal: 0,
    evidencePerProspect: 0,
  };
  if (ids.length === 0) return empty;

  const rows = await readOnlyQuery<Record<string, string>>(sql, MEASURE, [ids], 'benchmark.measure');
  const row = rows[0] ?? {};
  const evidence = await readOnlyQuery<{ total: string }>(
    sql,
    'select count(*)::text as total from prospect_evidence where prospect_id = any($1::uuid[])',
    [ids],
    'benchmark.measure_evidence',
  );

  const n = (key: string): number => Number.parseInt(row[key] ?? '0', 10);
  const prospects = n('prospects');
  const evidenceTotal = Number.parseInt(evidence[0]?.total ?? '0', 10);

  return {
    prospects,
    withWebsite: n('with_site'),
    withDomain: n('with_domain'),
    withInstagram: n('with_ig'),
    withFacebook: n('with_fb'),
    withPhone: n('with_phone'),
    withEmail: n('with_email'),
    withRegistryId: n('with_registry'),
    contactable: n('contactable'),
    funnelObservable: n('funnel_observable'),
    qualifiedContactableObservable: n('kpi'),
    evidenceTotal,
    evidencePerProspect: prospects === 0 ? 0 : Number((evidenceTotal / prospects).toFixed(2)),
  };
}

function arg(name: string, fallback: string | null = null): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number(((numerator / denominator) * 100).toFixed(1));
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const useCommonCrawl = !process.argv.includes('--no-common-crawl') && commonCrawlEnabled().ok;
  const useRdap = !process.argv.includes('--no-rdap');
  const limit = Number.parseInt(arg('limit', '60') as string, 10);
  const reportDir = resolvePath(process.cwd(), arg('report', 'var/benchmarks') as string);
  const nicheKey = arg('niche', 'example-services') as string;

  const sql = await getSql();
  const repo = new ProspectRepository(sql, logger);
  const niche = await loadNiche(nicheKey);
  const http = new HttpClient({ sql });

  // L'état d'accès Meta est daté et consigné à chaque run : « bloqué » est un
  // fait vérifiable, pas une phrase dans un document.
  for (const state of metaAccessStates()) {
    if (!dryRun) await recordSourceAccess(sql, state);
    logger.info('meta.access', { source: state.source, status: state.status });
  }

  const scheduler = new ProviderScheduler({ logger, limits: openWebSchedulerLimits() });
  const commonCrawl = useCommonCrawl ? new CommonCrawlClient({ http, logger }) : null;
  const webintel = createWebIntelClient(http);
  if (webintel) {
    try {
      const health = await webintel.health();
      logger.info('bench.webintel', { status: health.status, version: health.version });
    } catch (error) {
      logger.warn('bench.webintel_unreachable', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const corpus = await readOnlyQuery<ProspectRow>(
    sql,
    `select * from prospects
      where niche_verdict = 'in_niche' and dedupe_status <> 'merged'
      order by score desc nulls last, display_name asc
      limit $1`,
    [limit],
    'benchmark.corpus',
  );
  const ids = corpus.map((prospect) => prospect.id);
  const campaignId = corpus[0]?.campaign_id ?? '';
  const country = corpus[0]?.country ?? 'FR';
  logger.info('bench.corpus', { prospects: ids.length, campaignId });

  const before = await measure(sql, ids);
  const startedAt = Date.now();
  const outcomes: OpenWebProspectOutcome[] = [];
  const crawls: { prospectId: string; pages: number; funnelObserved: number; ms: number }[] = [];

  for (const [index, prospect] of corpus.entries()) {
    const outcome = await resolveProspectDomain(
      {
        sql,
        repo,
        http,
        logger,
        niche,
        scheduler,
        commonCrawl,
        campaignId,
        runId: null,
        country,
      },
      prospect,
      { useCommonCrawl, useRdap, persist: !dryRun },
    );
    outcomes.push(outcome);

    /**
     * Handoff WebIntel (§17).
     *
     * Trouver un domaine ne fait pas avancer le KPI : c'est le crawl qui rend
     * le parcours commercial observable. Un site rattaché et jamais lu compte
     * pour zéro dans `funnel_observable`, ce qui est la bonne mesure.
     */
    const target = outcome.attachedDomain
      ? `https://${outcome.attachedDomain}/`
      : prospect.website_url;

    if (target && webintel && !dryRun) {
      const crawlStarted = Date.now();
      const crawl = await crawlViaWebIntel(webintel, logger, target, niche, 6);
      if (crawl) {
        for (const item of crawl.evidence) await repo.addEvidence(prospect.id, item);
        await repo.fillMissingColumns(prospect.id, {
          email: crawl.contact.email,
          phone: crawl.contact.phone,
          instagram_handle: crawl.contact.instagramHandle,
          facebook_url: crawl.contact.facebookUrl,
        });
        crawls.push({
          prospectId: prospect.id,
          pages: crawl.pagesCrawled.length,
          funnelObserved: crawl.funnelObserved,
          ms: Date.now() - crawlStarted,
        });
      }
    }

    // Les deux mesures R2 sont dérivées, jamais incrémentées.
    if (!dryRun) {
      const evidence = await repo.evidenceFor(prospect.id);
      const fresh = (await repo.get(prospect.id)) ?? prospect;
      const reach = assessReach({ prospect: fresh, evidence });
      await repo.saveReach(prospect.id, {
        contactable: reach.contactable,
        channels: reach.channels,
        funnelObservable: reach.funnelObservable,
        funnelSignalCount: reach.funnelSignalCount,
        commercialVisibility: reach.commercialVisibility,
      });
    }

    process.stdout.write(
      `[${index + 1}/${corpus.length}] ${prospect.display_name} — ` +
        `${outcome.candidatesProbed} candidat(s) sondé(s)` +
        `${outcome.attachedDomain ? ` → ${outcome.attachedDomain} (${outcome.attachedVerdict})` : ' → aucun'}` +
        ` (${Math.round(outcome.durationMs)} ms)\n`,
    );
  }

  const durationMs = Date.now() - startedAt;
  const after = await measure(sql, ids);

  // ------------------------------------------------------------- attribution
  const allCandidates = outcomes.flatMap((outcome) => outcome.outcomes);
  const generated = allCandidates.filter((candidate) => candidate.origin === 'generated');
  const observed = allCandidates.filter((candidate) => candidate.origin === 'observed');

  const perProvider = {
    generated_domains: providerRow(generated),
    observed_domains: providerRow(observed),
    common_crawl: {
      lookups: outcomes.reduce((sum, outcome) => sum + outcome.ccLookups, 0),
      corroborated: outcomes.reduce((sum, outcome) => sum + outcome.ccCorroborated, 0),
      externalCostEur: 0,
    },
    rdap: {
      lookups: outcomes.reduce((sum, outcome) => sum + outcome.rdapLookups, 0),
      namedHolders: outcomes.reduce((sum, outcome) => sum + outcome.rdapNamedHolders, 0),
      externalCostEur: 0,
    },
    webintel: {
      crawls: crawls.length,
      pages: crawls.reduce((sum, crawl) => sum + crawl.pages, 0),
      funnelObserved: crawls.reduce((sum, crawl) => sum + crawl.funnelObserved, 0),
      externalCostEur: 0,
    },
  };

  const report = {
    generatedAt: new Date().toISOString(),
    dryRun,
    options: { useCommonCrawl, useRdap, limit },
    corpus: { prospects: corpus.length, niche: nicheKey },
    before,
    after,
    delta: {
      withWebsite: after.withWebsite - before.withWebsite,
      withDomain: after.withDomain - before.withDomain,
      withInstagram: after.withInstagram - before.withInstagram,
      withFacebook: after.withFacebook - before.withFacebook,
      withPhone: after.withPhone - before.withPhone,
      withEmail: after.withEmail - before.withEmail,
      withRegistryId: after.withRegistryId - before.withRegistryId,
      contactable: after.contactable - before.contactable,
      funnelObservable: after.funnelObservable - before.funnelObservable,
      qualifiedContactableObservable:
        after.qualifiedContactableObservable - before.qualifiedContactableObservable,
      evidencePerProspect: Number((after.evidencePerProspect - before.evidencePerProspect).toFixed(2)),
    },
    funnel: {
      prospectsProcessed: outcomes.length,
      candidatesGenerated: outcomes.reduce((sum, outcome) => sum + outcome.candidatesGenerated, 0),
      candidatesProbed: outcomes.reduce((sum, outcome) => sum + outcome.candidatesProbed, 0),
      dnsResolved: allCandidates.filter((candidate) => candidate.dnsResolved).length,
      servedPage: allCandidates.filter((candidate) => candidate.httpStatus !== null && candidate.httpStatus < 400).length,
      verdicts: {
        confirmed: allCandidates.filter((candidate) => candidate.verdict === 'confirmed').length,
        probable: allCandidates.filter((candidate) => candidate.verdict === 'probable').length,
        uncertain: allCandidates.filter((candidate) => candidate.verdict === 'uncertain').length,
        rejected: allCandidates.filter((candidate) => candidate.verdict === 'rejected').length,
      },
      attached: outcomes.filter((outcome) => outcome.attachedDomain !== null).length,
      registryIdsResolvedFromSite: outcomes.filter((outcome) => outcome.registryIdResolved !== null).length,
      domainCollisions: outcomes.filter((outcome) => outcome.domainCollisionWith !== null).length,
      prospectsWithNoCandidate: outcomes.filter((outcome) => outcome.candidatesGenerated === 0 && outcome.outcomes.length === 0).length,
    },
    rates: {
      prospectToDomainPercent: rate(
        outcomes.filter((outcome) => outcome.attachedDomain !== null).length,
        outcomes.length,
      ),
      poorProspectToDomainPercent: rate(
        outcomes.filter((outcome) => !outcome.hadWebsiteBefore && outcome.attachedDomain !== null).length,
        outcomes.filter((outcome) => !outcome.hadWebsiteBefore).length,
      ),
      candidateToDnsPercent: rate(allCandidates.filter((c) => c.dnsResolved).length, allCandidates.length),
      candidateToAttachedPercent: rate(allCandidates.filter((c) => c.attached).length, allCandidates.length),
      falsePositiveRatePercent: rate(
        allCandidates.filter((c) => c.verdict === 'rejected' && c.dnsResolved).length,
        allCandidates.filter((c) => c.dnsResolved).length,
      ),
    },
    perProvider,
    scheduler: scheduler.snapshot(),
    latency: {
      totalMs: durationMs,
      averagePerProspectMs: Math.round(durationMs / Math.max(1, outcomes.length)),
    },
    cost: {
      externalApiEuros: 0,
      note: 'Common Crawl, RDAP AFNIC, DNS et le worker WebIntel auto-hébergé — aucune API payante',
    },
    outcomes,
  };

  await mkdir(reportDir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, '-');
  const jsonPath = resolvePath(reportDir, `discovery-r3-${stamp}.json`);
  const mdPath = resolvePath(reportDir, `discovery-r3-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(mdPath, renderMarkdown(report), 'utf8');

  process.stdout.write(`\n${renderMarkdown(report)}\n`);
  process.stdout.write(`Rapport JSON : ${jsonPath}\n`);
  process.stdout.write(`Rapport MD   : ${mdPath}\n`);

  await sql.close();
}

function providerRow(candidates: { dnsResolved: boolean; attached: boolean; verdict: string }[]): {
  candidates: number;
  dnsResolved: number;
  attached: number;
  rejected: number;
  externalCostEur: number;
} {
  return {
    candidates: candidates.length,
    dnsResolved: candidates.filter((candidate) => candidate.dnsResolved).length,
    attached: candidates.filter((candidate) => candidate.attached).length,
    rejected: candidates.filter((candidate) => candidate.verdict === 'rejected').length,
    externalCostEur: 0,
  };
}

interface Report {
  generatedAt: string;
  dryRun: boolean;
  corpus: { prospects: number; niche: string };
  before: CorpusMetrics;
  after: CorpusMetrics;
  delta: Record<string, number>;
  funnel: Record<string, unknown>;
  rates: Record<string, number>;
  perProvider: Record<string, Record<string, number>>;
  latency: Record<string, number>;
  cost: { externalApiEuros: number; note: string };
}

function renderMarkdown(report: Report): string {
  const line = (label: string, before: number, after: number): string =>
    `| ${label} | ${before} | ${after} | ${after - before >= 0 ? '+' : ''}${after - before} |`;

  const verdicts = report.funnel['verdicts'] as Record<string, number>;

  return [
    `# Benchmark R3 — rail web ouvert — ${report.generatedAt}`,
    '',
    `Corpus : ${report.corpus.prospects} prospects \`in_niche\` (niche \`${report.corpus.niche}\`)` +
      `${report.dryRun ? ' — **mesure seule, rien écrit**' : ''}.`,
    '',
    '## Avant / après',
    '',
    '| Métrique | Avant | Après | Δ |',
    '| --- | ---: | ---: | ---: |',
    line('Site web', report.before.withWebsite, report.after.withWebsite),
    line('Domaine confirmé', report.before.withDomain, report.after.withDomain),
    line('Instagram', report.before.withInstagram, report.after.withInstagram),
    line('Facebook', report.before.withFacebook, report.after.withFacebook),
    line('Téléphone', report.before.withPhone, report.after.withPhone),
    line('E-mail', report.before.withEmail, report.after.withEmail),
    line('Identité légale (SIREN)', report.before.withRegistryId, report.after.withRegistryId),
    line('Joignable', report.before.contactable, report.after.contactable),
    line('Funnel observable', report.before.funnelObservable, report.after.funnelObservable),
    line(
      '**KPI : joignable ET funnel observable**',
      report.before.qualifiedContactableObservable,
      report.after.qualifiedContactableObservable,
    ),
    line('Evidences (total)', report.before.evidenceTotal, report.after.evidenceTotal),
    `| Evidences par prospect | ${report.before.evidencePerProspect} | ${report.after.evidencePerProspect} | ${report.delta['evidencePerProspect'] ?? 0} |`,
    '',
    '## Où le rail fuit',
    '',
    '| Étage | Nombre |',
    '| --- | ---: |',
    `| Prospects traités | ${String(report.funnel['prospectsProcessed'])} |`,
    `| Prospects sans aucun candidat (nom générique) | ${String(report.funnel['prospectsWithNoCandidate'])} |`,
    `| Domaines candidats fabriqués | ${String(report.funnel['candidatesGenerated'])} |`,
    `| Candidats sondés | ${String(report.funnel['candidatesProbed'])} |`,
    `| … qui résolvent en DNS | ${String(report.funnel['dnsResolved'])} |`,
    `| … qui servent une page | ${String(report.funnel['servedPage'])} |`,
    `| Verdicts \`confirmed\` | ${verdicts?.['confirmed'] ?? 0} |`,
    `| Verdicts \`probable\` | ${verdicts?.['probable'] ?? 0} |`,
    `| Verdicts \`uncertain\` | ${verdicts?.['uncertain'] ?? 0} |`,
    `| Verdicts \`rejected\` | ${verdicts?.['rejected'] ?? 0} |`,
    `| **Domaines rattachés** | ${String(report.funnel['attached'])} |`,
    `| SIREN retrouvés via mentions légales | ${String(report.funnel['registryIdsResolvedFromSite'])} |`,
    `| Collisions de domaine mises en revue | ${String(report.funnel['domainCollisions'])} |`,
    '',
    '## Taux',
    '',
    '| Taux | Valeur |',
    '| --- | ---: |',
    `| prospect → domaine rattaché | ${report.rates['prospectToDomainPercent']} % |`,
    `| prospect SANS site → domaine rattaché | ${report.rates['poorProspectToDomainPercent']} % |`,
    `| candidat → résolution DNS | ${report.rates['candidateToDnsPercent']} % |`,
    `| candidat → rattachement | ${report.rates['candidateToAttachedPercent']} % |`,
    `| faux positifs (résolu puis rejeté) | ${report.rates['falsePositiveRatePercent']} % |`,
    '',
    '## Par fournisseur',
    '',
    '```json',
    JSON.stringify(report.perProvider, null, 2),
    '```',
    '',
    '## Latence',
    '',
    `- total : ${Math.round((report.latency['totalMs'] ?? 0) / 1000)} s`,
    `- par prospect : ${report.latency['averagePerProspectMs']} ms`,
    '',
    '## Coût',
    '',
    `**${report.cost.externalApiEuros} €.** ${report.cost.note}`,
    '',
  ].join('\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
