#!/usr/bin/env tsx
/**
 * Benchmark R4 — une vraie API de recherche, sur le corpus que R3 n'a pas résolu.
 *
 *   npm run search:benchmark -- --dry-run          # mesure seule, rien écrit
 *   npm run search:benchmark -- --limit 5          # sous-ensemble, pour un essai
 *   npm run search:benchmark
 *
 * La question posée est précise, et elle n'est pas « Brave trouve-t-il des
 * sites ». C'est :
 *
 *   > une recherche web indexée transforme-t-elle une part significative des 53
 *   > prospects restants en entreprises indépendamment résolues, joignables et
 *   > analysables ?
 *
 * Trois exigences du gate que ce fichier tient littéralement :
 *
 *   - **la même population.** Le corpus est constitué par requête depuis la base
 *     — les `in_niche` qui n'ont PAS le KPI combiné — jamais par une découverte
 *     fraîche. « Avant » et « après » décrivent les mêmes entreprises, ce qui est
 *     la seule façon d'attribuer un delta à une source ;
 *   - **les mêmes fonctions que le pipeline.** `resolveProspectViaSearch`,
 *     `crawlViaWebIntel`, `assessReach`. Aucun raccourci de benchmark, sans quoi
 *     la mesure décrirait le benchmark et non le produit ;
 *   - **aucune pondération, aucun seuil, aucun prompt touché.** R4 évalue une
 *     source, pas un scoring.
 *
 * Les mesures encadrantes passent par `readOnlyQuery` (§17) : un outil de mesure
 * qui écrit mesure son propre effet. Le rail, lui, écrit — c'est son travail, et
 * `--dry-run` le rend muet.
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
import {
  createWebSearchProvider,
  observedCredits,
  SearchProviderError,
  SERPER_MAX_NUM_FREE,
} from '@/lib/enrichment/webSearch';
import {
  SearchBudget,
  searchKeyVariable,
  searchLimitsFromEnv,
  searchPricing,
} from '@/lib/discovery/search/budget';
import {
  resolveProspectViaSearch,
  searchSchedulerLimits,
  type SearchProspectOutcome,
} from '@/lib/discovery/search/railSearch';
import {
  ALL_IN_NICHE_SQL,
  TARGET_CORPUS_SQL,
  measureCorpus,
  type CorpusMetrics,
} from '@/lib/discovery/search/measure';
import { createWebIntelClient, crawlViaWebIntel } from '@/lib/enrichment/webintel';
import { assessReach } from '@/lib/pipeline/reach';
import type { ProspectRow } from '@/lib/repo/types';

function arg(name: string, fallback: string | null = null): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number(((numerator / denominator) * 100).toFixed(1));
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Number((((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2).toFixed(1))
    : (sorted[middle] ?? null);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const limit = Number.parseInt(arg('limit', '100') as string, 10);
  const reportDir = resolvePath(process.cwd(), arg('report', 'var/benchmarks') as string);
  const nicheKey = arg('niche', 'example-services') as string;
  const maxQueries = Number.parseInt(arg('max-queries', '3') as string, 10);
  const resultsPerQuery = Number.parseInt(arg('results', '10') as string, 10);

  /**
   * Repose les variantes déjà posées lors d'un run précédent.
   *
   * En production, « cette question a déjà été payée » est une économie franche
   * et le rail l'applique par défaut. Sur un banc d'essai, c'est un biais : un
   * essai à trois prospects laisse une trace qui fera *sauter* ces trois-là au
   * run complet, sans résultat pour autant puisque `--dry-run` n'a rien
   * persisté. Le corpus mesuré serait alors plus petit que le corpus annoncé, et
   * le fournisseur paraîtrait d'autant moins performant.
   *
   * Le drapeau rétablit la condition dans laquelle Brave a été mesuré : un
   * fournisseur neuf, à qui rien n'a encore été demandé. Il ne fait rien
   * oublier — la dépense reste inscrite, elle est seulement rejouée.
   */
  const ignorePrevious = process.argv.includes('--ignore-previous');

  const sql = await getSql();
  const repo = new ProspectRepository(sql, logger);
  const niche = await loadNiche(nicheKey);
  const http = new HttpClient({ sql });

  // ------------------------------------------------------------- fournisseur
  /**
   * Le fournisseur est choisi pour CE run, sans toucher à
   * `OUTBOUND_SEARCH_PROVIDER` : cette variable gouverne le rail R3, qui joint
   * le WebIntel auto-hébergé, et la basculer pour lancer un benchmark changerait
   * silencieusement le reste du pipeline. C'est aussi ce qui rendra l'A/B Serper
   * du §14 reproductible sur le même corpus.
   */
  const providerName = (arg('provider', 'brave') as string).toLowerCase();
  const provider = createWebSearchProvider(http, providerName);
  const keyVariable = searchKeyVariable(provider.name);
  const pricing = searchPricing(provider.name);
  const availability = provider.availability();

  /**
   * Le refus précède l'appel, y compris sur une option de ligne de commande.
   *
   * Un compte Serper gratuit répond `400 Query pattern not allowed` dès que
   * `num` dépasse 10. L'adaptateur borne déjà la valeur, mais un opérateur qui
   * écrit `--results 20` doit l'apprendre ici, en une ligne, plutôt que de
   * découvrir dans le rapport que la borne a silencieusement changé la question
   * qu'il croyait poser. C'est aussi la borne qui garde l'A/B comparable.
   */
  if (provider.name === 'serper' && resultsPerQuery > SERPER_MAX_NUM_FREE) {
    process.stdout.write(
      `\n--results ${resultsPerQuery} est refusé par un compte Serper gratuit ` +
        `(400 « Query pattern not allowed for free accounts. »).\n` +
        `Maximum : ${SERPER_MAX_NUM_FREE}. C'est aussi la valeur du run Brave, ` +
        `donc celle qui garde l'A/B comparable.\n`,
    );
    await sql.close();
    process.exitCode = 2;
    return;
  }

  process.stdout.write(
    `Fournisseur : ${provider.name} · clé ${keyVariable.present ? `présente (${keyVariable.name})` : 'ABSENTE'}\n`,
  );

  /**
   * Sans clé, le benchmark s'arrête ici et dit où la mettre — il ne la réclame
   * jamais dans un message, et n'essaie aucun repli silencieux vers un autre
   * fournisseur.
   */
  if (!availability.ok) {
    const dashboard =
      provider.name === 'serper'
        ? 'https://serper.dev/api-key (2 500 requêtes offertes, sans carte bancaire)'
        : 'https://api-dashboard.search.brave.com/app/keys (plan « Search »)';
    process.stdout.write(
      `\nRecherche indisponible : ${availability.reason ?? 'inconnue'}\n\n` +
        `Pour lancer le benchmark live, ajouter la ligne suivante dans ` +
        `${resolvePath(process.cwd(), '.env')} :\n\n` +
        `  ${keyVariable.name}=<la clé>\n\n` +
        `La clé s'obtient sur ${dashboard}.\n` +
        `${pricing.note}\n\n` +
        `Ne pas réutiliser la clé d'un autre projet de cette machine : le préfixe ` +
        `OUTBOUND_ est ce qui garde ce dépôt isolé.\n`,
    );
    await sql.close();
    process.exitCode = 3;
    return;
  }

  const scheduler = new ProviderScheduler({ logger, limits: searchSchedulerLimits() });
  const budget = new SearchBudget({
    sql,
    provider: provider.name,
    campaignSlug: null,
    runId: null,
    limits: searchLimitsFromEnv(),
  });

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

  /**
   * Le corpus : les `in_niche` qui n'ont PAS le KPI combiné.
   *
   * C'est la définition du §10, écrite en SQL plutôt qu'en liste d'identifiants
   * recopiée — une liste figée cesserait d'être vraie dès qu'un prospect change
   * d'état, et le benchmark mesurerait alors une population imaginaire.
   */
  const corpus = await readOnlyQuery<ProspectRow>(sql, TARGET_CORPUS_SQL, [limit], 'search_benchmark.corpus');

  const ids = corpus.map((prospect) => prospect.id);
  const campaignId = corpus[0]?.campaign_id ?? '';

  // La population de référence complète, pour situer le KPI dans son ensemble.
  const allInNiche = await readOnlyQuery<{ id: string }>(sql, ALL_IN_NICHE_SQL, [], 'search_benchmark.all_in_niche');
  const allIds = allInNiche.map((row) => row.id);

  logger.info('bench.corpus', { targeted: ids.length, inNiche: allIds.length, campaignId });
  process.stdout.write(
    `Corpus : ${ids.length} prospects ciblés sur ${allIds.length} \`in_niche\` · ` +
      `plafonds ${budget.limits.run}/run ${budget.limits.daily}/jour ${budget.limits.monthly}/mois` +
      `${dryRun ? ' · MESURE SEULE' : ''}\n\n`,
  );

  const beforeTargeted = await measureCorpus(sql, ids, 'search_benchmark.before_targeted');
  const beforeAll = await measureCorpus(sql, allIds, 'search_benchmark.before_all');

  const startedAt = Date.now();
  const outcomes: SearchProspectOutcome[] = [];
  const crawls: { prospectId: string; pages: number; funnelObserved: number; ms: number }[] = [];
  let stoppedEarly: string | null = null;

  for (const [index, prospect] of corpus.entries()) {
    if (budget.exhausted) {
      stoppedEarly = budget.stopReason?.message ?? 'budget épuisé';
      process.stdout.write(`\nArrêt propre : ${stoppedEarly}\n`);
      break;
    }

    let outcome: SearchProspectOutcome;
    try {
      outcome = await resolveProspectViaSearch(
        {
          sql,
          repo,
          http,
          logger,
          niche,
          scheduler,
          provider,
          budget,
          campaignId,
          runId: null,
        },
        prospect,
        { maxQueriesPerProspect: maxQueries, resultsPerQuery, persist: !dryRun, skipAlreadyAsked: !ignorePrevious },
      );
    } catch (error) {
      // Une clé refusée ne s'améliore pas au prospect suivant : le run s'arrête
      // plutôt que de répéter 52 fois la même erreur.
      if (error instanceof SearchProviderError && error.fatal) {
        stoppedEarly = `${error.kind}: ${error.message}`;
        process.stdout.write(`\nArrêt : ${stoppedEarly}\n`);
        break;
      }
      throw error;
    }

    outcomes.push(outcome);

    /**
     * Handoff WebIntel (§8).
     *
     * Trouver un domaine ne fait pas avancer le KPI : c'est le crawl qui rend le
     * parcours commercial observable. Un site rattaché et jamais lu compte pour
     * zéro dans `funnel_observable`, ce qui est la bonne mesure.
     */
    if (outcome.attachedDomain && webintel && !dryRun) {
      const crawlStarted = Date.now();
      const crawl = await crawlViaWebIntel(webintel, logger, `https://${outcome.attachedDomain}/`, niche, 6);
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

    const issued = outcome.queries.filter((query) => query.issued).length;
    process.stdout.write(
      `[${index + 1}/${corpus.length}] ${prospect.display_name.slice(0, 34).padEnd(34)} ` +
        `${issued} requête(s)` +
        `${outcome.attachedDomain ? ` → ${outcome.attachedDomain} (${outcome.attachedVerdict}, rang ${outcome.attachedRank})` : ' → aucun site'}` +
        `${outcome.instagramAttached ? ` · IG @${outcome.instagramAttached}` : ''}` +
        ` (${Math.round(outcome.durationMs)} ms)\n`,
    );
  }

  const durationMs = Date.now() - startedAt;
  const afterTargeted = await measureCorpus(sql, ids, 'search_benchmark.after_targeted');
  const afterAll = await measureCorpus(sql, allIds, 'search_benchmark.after_all');
  const snapshot = await budget.snapshot();

  // ------------------------------------------------------------- agrégations
  const allQueries = outcomes.flatMap((outcome) => outcome.queries);
  const issuedQueries = allQueries.filter((query) => query.issued && query.error === null);
  const allCandidates = outcomes.flatMap((outcome) => outcome.candidates);
  const attachedOutcomes = outcomes.filter((outcome) => outcome.attachedDomain !== null);
  const ranks = attachedOutcomes
    .map((outcome) => outcome.attachedRank)
    .filter((rank): rank is number => rank !== null);
  const latencies = issuedQueries
    .map((query) => query.latencyMs)
    .filter((value): value is number => value !== null);

  const resultsSeen = issuedQueries.reduce((sum, query) => sum + query.resultsCount, 0);
  /**
   * Dénominateur des taux du §16 : les résultats APRÈS déduplication par
   * domaine. Quatre pages du même annuaire sont quatre résultats et un seul
   * candidat ; rapporter le bruit aux résultats bruts le ferait paraître plus
   * faible qu'il n'est.
   */
  const classifiedSeen = issuedQueries.reduce((sum, query) => sum + query.classifiedCandidates, 0);
  const ownSiteSeen = issuedQueries.reduce((sum, query) => sum + query.ownSiteCandidates, 0);
  const directorySeen = issuedQueries.reduce((sum, query) => sum + query.directoryResults, 0);
  const socialSeen = issuedQueries.reduce((sum, query) => sum + query.socialResults, 0);
  const noiseSeen = issuedQueries.reduce((sum, query) => sum + query.noiseResults, 0);

  const kpiDelta = afterAll.qualifiedContactableObservable - beforeAll.qualifiedContactableObservable;
  const usefulGains =
    afterTargeted.withWebsite -
    beforeTargeted.withWebsite +
    (afterTargeted.withInstagram - beforeTargeted.withInstagram) +
    (afterTargeted.withFacebook - beforeTargeted.withFacebook);

  const usdSpent = snapshot.estimatedUsdThisRun;

  const report = {
    generatedAt: new Date().toISOString(),
    dryRun,
    provider: {
      name: provider.name,
      endpoint: pricing.endpoint,
      keyVariable: keyVariable.name,
      priceUsdPer1000: pricing.usdPer1000,
      freeCreditUsdPerMonth: pricing.freeUsdPerMonth,
      freeQueriesOneOff: pricing.freeQueriesOneOff,
      resultsStored: false,
      limits: budget.limits,
    },
    options: { limit, maxQueries, resultsPerQuery, niche: nicheKey, ignorePrevious },
    corpus: {
      targeted: ids.length,
      processed: outcomes.length,
      inNicheTotal: allIds.length,
      stoppedEarly,
    },
    targeted: { before: beforeTargeted, after: afterTargeted },
    inNiche: { before: beforeAll, after: afterAll },
    delta: {
      withWebsite: afterTargeted.withWebsite - beforeTargeted.withWebsite,
      withDomain: afterTargeted.withDomain - beforeTargeted.withDomain,
      withInstagram: afterTargeted.withInstagram - beforeTargeted.withInstagram,
      withFacebook: afterTargeted.withFacebook - beforeTargeted.withFacebook,
      withPhone: afterTargeted.withPhone - beforeTargeted.withPhone,
      withEmail: afterTargeted.withEmail - beforeTargeted.withEmail,
      withRegistryId: afterTargeted.withRegistryId - beforeTargeted.withRegistryId,
      contactable: afterTargeted.contactable - beforeTargeted.contactable,
      funnelObservable: afterTargeted.funnelObservable - beforeTargeted.funnelObservable,
      kpiTargeted:
        afterTargeted.qualifiedContactableObservable - beforeTargeted.qualifiedContactableObservable,
      kpiInNiche: kpiDelta,
      usefulGains,
    },
    kpi: {
      before: `${beforeAll.qualifiedContactableObservable} / ${allIds.length}`,
      after: `${afterAll.qualifiedContactableObservable} / ${allIds.length}`,
      beforePercent: rate(beforeAll.qualifiedContactableObservable, allIds.length),
      afterPercent: rate(afterAll.qualifiedContactableObservable, allIds.length),
    },
    funnel: {
      prospectsSearched: outcomes.filter((outcome) => outcome.queries.some((query) => query.issued)).length,
      prospectsSkipped: outcomes.filter((outcome) => !outcome.queries.some((query) => query.issued)).length,
      queriesPlanned: allQueries.length,
      queriesIssued: issuedQueries.length,
      queriesAvoided: allQueries.filter((query) => !query.issued).length,
      queriesFailed: allQueries.filter((query) => query.error !== null).length,
      queriesPerProspect:
        outcomes.length === 0 ? 0 : Number((issuedQueries.length / outcomes.length).toFixed(2)),
      resultsSeen,
      classifiedCandidates: classifiedSeen,
      ownSiteCandidates: ownSiteSeen,
      directoryResults: directorySeen,
      socialResults: socialSeen,
      noiseResults: noiseSeen,
      candidatesProbed: allCandidates.length,
      dnsResolved: allCandidates.filter((candidate) => candidate.dnsResolved).length,
      servedPage: allCandidates.filter(
        (candidate) => candidate.httpStatus !== null && candidate.httpStatus < 400,
      ).length,
      verdicts: {
        confirmed: allCandidates.filter((candidate) => candidate.verdict === 'confirmed').length,
        probable: allCandidates.filter((candidate) => candidate.verdict === 'probable').length,
        uncertain: allCandidates.filter((candidate) => candidate.verdict === 'uncertain').length,
        rejected: allCandidates.filter((candidate) => candidate.verdict === 'rejected').length,
      },
      sitesConfirmed: attachedOutcomes.length,
      instagramAttached: outcomes.filter((outcome) => outcome.instagramAttached !== null).length,
      facebookAttached: outcomes.filter((outcome) => outcome.facebookAttached !== null).length,
      socialRejected: outcomes.reduce((sum, outcome) => sum + outcome.socialRejected.length, 0),
      registryIdsResolvedFromSite: outcomes.filter((outcome) => outcome.registryIdResolved !== null).length,
      domainCollisions: outcomes.filter((outcome) => outcome.domainCollisionWith !== null).length,
      webintelCrawls: crawls.length,
      webintelPages: crawls.reduce((sum, crawl) => sum + crawl.pages, 0),
      webintelFunnelObserved: crawls.reduce((sum, crawl) => sum + crawl.funnelObserved, 0),
    },
    /**
     * §16 — le fournisseur vaut-il son coût ?
     *
     * `noResultRate` et `noiseRate` mesurent l'index ; `falseIdentityRate`
     * mesure ce que le vérificateur a dû écarter parmi ce que l'index a proposé.
     * Un `falseIdentityRate` élevé n'est PAS un défaut du vérificateur : c'est le
     * prix de sa sévérité, et R3 avait la même forme.
     */
    quality: {
      noResultRatePercent: rate(
        issuedQueries.filter((query) => query.resultsCount === 0).length,
        issuedQueries.length,
      ),
      queriesWithoutOwnSitePercent: rate(
        issuedQueries.filter((query) => query.ownSiteCandidates === 0).length,
        issuedQueries.length,
      ),
      noiseRatePercent: rate(directorySeen + noiseSeen, classifiedSeen),
      ownSiteRatePercent: rate(ownSiteSeen, classifiedSeen),
      falseIdentityRatePercent: rate(
        allCandidates.filter((candidate) => candidate.verdict === 'rejected').length,
        allCandidates.length,
      ),
      confirmedRankMedian: median(ranks),
      confirmedRankMax: ranks.length > 0 ? Math.max(...ranks) : null,
      rankDistribution: ranks.reduce<Record<string, number>>((accumulator, rank) => {
        accumulator[String(rank)] = (accumulator[String(rank)] ?? 0) + 1;
        return accumulator;
      }, {}),
      confirmedDomainsPerQuery:
        issuedQueries.length === 0 ? 0 : Number((attachedOutcomes.length / issuedQueries.length).toFixed(3)),
      contactableGainPerQuery:
        issuedQueries.length === 0
          ? 0
          : Number(((afterTargeted.contactable - beforeTargeted.contactable) / issuedQueries.length).toFixed(3)),
      funnelGainPerQuery:
        issuedQueries.length === 0
          ? 0
          : Number(
              ((afterTargeted.funnelObservable - beforeTargeted.funnelObservable) / issuedQueries.length).toFixed(3),
            ),
      latencyMedianMs: median(latencies),
      latencyMaxMs: latencies.length > 0 ? Math.max(...latencies) : null,
    },
    cost: {
      billableCalls: snapshot.runCalls,
      avoidedCalls: snapshot.avoided,
      usdPerQuery: pricing.usdPer1000 / 1000,
      estimatedUsdThisRun: usdSpent,
      estimatedUsdThisMonth: snapshot.estimatedUsdThisMonth,
      freeCreditRemainingUsd: snapshot.freeCreditRemainingUsd,
      lifetimeCalls: snapshot.lifetimeCalls,
      freeQueriesRemaining: snapshot.freeQueriesRemaining,
      /**
       * Payé de notre poche.
       *
       * Deux formes d'offre, donc deux calculs. Brave reconstitue 5 $ par mois :
       * le débours est ce qui dépasse ce crédit. Serper offre 2 500 requêtes une
       * fois : le débours est ce qui dépasse cette allocation depuis toujours,
       * et un compteur mensuel dirait « 0 $ » indéfiniment après l'épuisement.
       */
      outOfPocketUsd:
        snapshot.freeQueriesRemaining !== null
          ? Number((Math.max(0, -snapshot.freeQueriesRemaining) * (pricing.usdPer1000 / 1000)).toFixed(4))
          : Number(Math.max(0, -snapshot.freeCreditRemainingUsd).toFixed(4)),
      usdPerSiteConfirmed:
        attachedOutcomes.length === 0 ? null : Number((usdSpent / attachedOutcomes.length).toFixed(4)),
      usdPerKpiGained: kpiDelta === 0 ? null : Number((usdSpent / kpiDelta).toFixed(4)),
      /**
       * Ce que le fournisseur dit avoir facturé, quand il sait le dire.
       *
       * Serper renvoie un champ `credits` par appel ; Brave n'a pas
       * d'équivalent. C'est la seule ligne *mesurée* de ce tableau — tout le
       * reste est notre estimation. Les publier côte à côte est ce qui permet de
       * repérer un modèle de coût faux plutôt que de le propager.
       */
      providerReportedCredits: observedCredits(provider),
      note: pricing.note,
    },
    scheduler: scheduler.snapshot(),
    latency: {
      totalMs: durationMs,
      averagePerProspectMs: Math.round(durationMs / Math.max(1, outcomes.length)),
    },
    outcomes,
  };

  await mkdir(reportDir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, '-');
  const jsonPath = resolvePath(reportDir, `search-r4-${stamp}.json`);
  const mdPath = resolvePath(reportDir, `search-r4-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(mdPath, renderMarkdown(report), 'utf8');

  process.stdout.write(`\n${renderMarkdown(report)}\n`);
  process.stdout.write(`Rapport JSON : ${jsonPath}\n`);
  process.stdout.write(`Rapport MD   : ${mdPath}\n`);

  await sql.close();
}

/** Ce que le renderer a besoin de lire. Volontairement plus étroit que le rapport. */
interface Report {
  generatedAt: string;
  dryRun: boolean;
  provider: {
    name: string;
    keyVariable: string;
    resultsStored: boolean;
    limits: { run: number; daily: number; monthly: number };
  };
  corpus: { targeted: number; processed: number; inNicheTotal: number; stoppedEarly: string | null };
  targeted: { before: CorpusMetrics; after: CorpusMetrics };
  delta: Record<string, number>;
  kpi: { before: string; after: string; beforePercent: number; afterPercent: number };
  funnel: Record<string, unknown>;
  quality: Record<string, unknown>;
  cost: Record<string, unknown>;
  latency: Record<string, number>;
}

function renderMarkdown(report: Report): string {
  const line = (label: string, before: number, after: number): string =>
    `| ${label} | ${before} | ${after} | ${after - before >= 0 ? '+' : ''}${after - before} |`;

  const verdicts = report.funnel['verdicts'] as Record<string, number>;
  const distribution = report.quality['rankDistribution'] as Record<string, number>;

  return [
    `# Benchmark R4 — ${report.provider.name} — ${report.generatedAt}`,
    '',
    `Corpus : ${report.corpus.targeted} prospects \`in_niche\` SANS le KPI combiné, ` +
      `sur ${report.corpus.inNicheTotal} au total` +
      `${report.dryRun ? ' — **mesure seule, rien écrit**' : ''}.`,
    ...(report.corpus.stoppedEarly ? ['', `**Arrêt anticipé** : ${report.corpus.stoppedEarly}`] : []),
    '',
    '## Le KPI',
    '',
    `**${report.kpi.before} → ${report.kpi.after}** ` +
      `(${report.kpi.beforePercent} % → ${report.kpi.afterPercent} %), ` +
      `soit ${report.delta['kpiInNiche'] ?? 0 >= 0 ? '+' : ''}${report.delta['kpiInNiche'] ?? 0}.`,
    '',
    '## Avant / après, sur les prospects ciblés',
    '',
    '| Métrique | Avant | Après | Δ |',
    '| --- | ---: | ---: | ---: |',
    line('Site web', report.targeted.before.withWebsite, report.targeted.after.withWebsite),
    line('Domaine confirmé', report.targeted.before.withDomain, report.targeted.after.withDomain),
    line('Instagram', report.targeted.before.withInstagram, report.targeted.after.withInstagram),
    line('Facebook', report.targeted.before.withFacebook, report.targeted.after.withFacebook),
    line('Téléphone', report.targeted.before.withPhone, report.targeted.after.withPhone),
    line('E-mail', report.targeted.before.withEmail, report.targeted.after.withEmail),
    line('Identité légale (SIREN)', report.targeted.before.withRegistryId, report.targeted.after.withRegistryId),
    line('Joignable', report.targeted.before.contactable, report.targeted.after.contactable),
    line('Funnel observable', report.targeted.before.funnelObservable, report.targeted.after.funnelObservable),
    line(
      '**KPI (joignable ET funnel)**',
      report.targeted.before.qualifiedContactableObservable,
      report.targeted.after.qualifiedContactableObservable,
    ),
    '',
    '## Où le rail fuit',
    '',
    '| Étage | Nombre |',
    '| --- | ---: |',
    `| Prospects traités | ${String(report.corpus.processed)} |`,
    `| … réellement cherchés | ${String(report.funnel['prospectsSearched'])} |`,
    `| … sautés (site connu, nom non discriminant) | ${String(report.funnel['prospectsSkipped'])} |`,
    `| Requêtes planifiées | ${String(report.funnel['queriesPlanned'])} |`,
    `| **Requêtes émises** | ${String(report.funnel['queriesIssued'])} |`,
    `| Requêtes évitées | ${String(report.funnel['queriesAvoided'])} |`,
    `| Requêtes en échec | ${String(report.funnel['queriesFailed'])} |`,
    `| Requêtes par prospect | ${String(report.funnel['queriesPerProspect'])} |`,
    `| Résultats bruts reçus | ${String(report.funnel['resultsSeen'])} |`,
    `| Résultats après déduplication | ${String(report.funnel['classifiedCandidates'])} |`,
    `| … annuaires / plateformes | ${String(report.funnel['directoryResults'])} |`,
    `| … profils sociaux | ${String(report.funnel['socialResults'])} |`,
    `| … bruit | ${String(report.funnel['noiseResults'])} |`,
    `| … candidats de site propre | ${String(report.funnel['ownSiteCandidates'])} |`,
    `| Candidats sondés (DNS + HTTP) | ${String(report.funnel['candidatesProbed'])} |`,
    `| … qui résolvent en DNS | ${String(report.funnel['dnsResolved'])} |`,
    `| … qui servent une page | ${String(report.funnel['servedPage'])} |`,
    `| Verdicts \`confirmed\` | ${verdicts?.['confirmed'] ?? 0} |`,
    `| Verdicts \`probable\` | ${verdicts?.['probable'] ?? 0} |`,
    `| Verdicts \`uncertain\` | ${verdicts?.['uncertain'] ?? 0} |`,
    `| Verdicts \`rejected\` | ${verdicts?.['rejected'] ?? 0} |`,
    `| **Sites confirmés** | ${String(report.funnel['sitesConfirmed'])} |`,
    `| Instagram rattachés | ${String(report.funnel['instagramAttached'])} |`,
    `| Facebook rattachés | ${String(report.funnel['facebookAttached'])} |`,
    `| Profils sociaux écartés | ${String(report.funnel['socialRejected'])} |`,
    `| SIREN retrouvés via mentions légales | ${String(report.funnel['registryIdsResolvedFromSite'])} |`,
    `| Collisions de domaine mises en revue | ${String(report.funnel['domainCollisions'])} |`,
    `| Crawls WebIntel | ${String(report.funnel['webintelCrawls'])} |`,
    `| Pages lues | ${String(report.funnel['webintelPages'])} |`,
    '',
    '## Qualité du fournisseur',
    '',
    '| Mesure | Valeur |',
    '| --- | ---: |',
    `| requêtes sans aucun résultat | ${String(report.quality['noResultRatePercent'])} % |`,
    `| requêtes sans candidat de site propre | ${String(report.quality['queriesWithoutOwnSitePercent'])} % |`,
    `| bruit (annuaires + hors-sujet, après dédup) | ${String(report.quality['noiseRatePercent'])} % |`,
    `| résultats exploitables (site propre, après dédup) | ${String(report.quality['ownSiteRatePercent'])} % |`,
    `| candidats écartés par le vérificateur | ${String(report.quality['falseIdentityRatePercent'])} % |`,
    `| rang médian du domaine confirmé | ${String(report.quality['confirmedRankMedian'] ?? '—')} |`,
    `| rang maximal du domaine confirmé | ${String(report.quality['confirmedRankMax'] ?? '—')} |`,
    `| distribution des rangs | ${Object.entries(distribution ?? {}).map(([rank, count]) => `rang ${rank} × ${count}`).join(', ') || '—'} |`,
    `| domaines confirmés / requête | ${String(report.quality['confirmedDomainsPerQuery'])} |`,
    `| gain « joignable » / requête | ${String(report.quality['contactableGainPerQuery'])} |`,
    `| gain « funnel » / requête | ${String(report.quality['funnelGainPerQuery'])} |`,
    `| latence médiane | ${String(report.quality['latencyMedianMs'] ?? '—')} ms |`,
    `| latence maximale | ${String(report.quality['latencyMaxMs'] ?? '—')} ms |`,
    '',
    '## Coût',
    '',
    '| Poste | Valeur |',
    '| --- | ---: |',
    `| requêtes facturables émises | ${String(report.cost['billableCalls'])} |`,
    `| requêtes évitées | ${String(report.cost['avoidedCalls'])} |`,
    `| prix unitaire | ${String(report.cost['usdPerQuery'])} $ |`,
    `| **coût de ce run** | ${String(report.cost['estimatedUsdThisRun'])} $ |`,
    `| coût du mois en cours | ${String(report.cost['estimatedUsdThisMonth'])} $ |`,
    /**
     * Une seule des deux lignes d'offre est affichée : celle qui existe chez ce
     * fournisseur. Publier « crédit mensuel restant » pour Serper laisserait
     * croire à une allocation qui se reconstitue, et « requêtes offertes
     * restantes » pour Brave à une allocation qui n'a jamais existé.
     */
    report.cost['freeQueriesRemaining'] !== null && report.cost['freeQueriesRemaining'] !== undefined
      ? `| requêtes offertes restantes (une seule fois) | ${String(report.cost['freeQueriesRemaining'])} |`
      : `| crédit mensuel restant | ${String(report.cost['freeCreditRemainingUsd'])} $ |`,
    `| requêtes facturables cumulées chez ce fournisseur | ${String(report.cost['lifetimeCalls'])} |`,
    ...(report.cost['providerReportedCredits']
      ? [
          `| **crédits déclarés par le fournisseur** | ${String(
            (report.cost['providerReportedCredits'] as { credits: number }).credits,
          )} sur ${String(
            (report.cost['providerReportedCredits'] as { calls: number }).calls,
          )} appels |`,
        ]
      : []),
    `| **réellement déboursé** | ${String(report.cost['outOfPocketUsd'])} $ |`,
    `| coût par site confirmé | ${String(report.cost['usdPerSiteConfirmed'] ?? '—')} $ |`,
    `| coût par KPI gagné | ${String(report.cost['usdPerKpiGained'] ?? '—')} $ |`,
    '',
    String(report.cost['note']),
    '',
    '## Conformité',
    '',
    `- résultats de recherche stockés : **${report.provider.resultsStored ? 'OUI — anomalie' : 'non'}**`,
    `- variable de clé : \`${report.provider.keyVariable}\``,
    `- plafonds actifs : ${report.provider.limits.run}/run · ${report.provider.limits.daily}/jour · ${report.provider.limits.monthly}/mois`,
    '',
    '## Latence',
    '',
    `- total : ${Math.round((report.latency['totalMs'] ?? 0) / 1000)} s`,
    `- par prospect : ${report.latency['averagePerProspectMs']} ms`,
    '',
  ].join('\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
