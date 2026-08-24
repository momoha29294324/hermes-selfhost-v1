import { HttpClient } from '@/lib/http/client';
import { ProspectRepository } from '@/lib/repo/prospects';
import { ModelRouter } from '@/lib/models/router';
import { createDiscoverySource } from '@/lib/discovery/registry';
import { crawlWebsite } from '@/lib/enrichment/websiteCrawl';
import { matchOpenStreetMap } from '@/lib/enrichment/osmMatch';
import { createWebSearchProvider, findWebsiteFor } from '@/lib/enrichment/webSearch';
import { createWebIntelClient, decideFromResolution, crawlViaWebIntel } from '@/lib/enrichment/webintel';
import { classifyDeterministic, classifyWithLlm } from '@/lib/pipeline/classify';
import { assessReach, isQualifiedContactableObservable, type ReachAssessment } from '@/lib/pipeline/reach';
import { PlacesBudget } from '@/lib/discovery/places/budget';
import { PlacesClient, placesAvailability } from '@/lib/discovery/places/client';
import { placeIdentifier } from '@/lib/discovery/places/identify';
import { runPlacesRail, type PlacesRailStats } from '@/lib/discovery/places/railA';
import { scoreProspect, type LlmObservation } from '@/lib/pipeline/score';
import { researchProspect } from '@/lib/pipeline/research';
import { researchWithWorkers } from '@/lib/pipeline/workers';
import { buildAngle, loadCaseStudy } from '@/lib/pipeline/angle';
import { generateMessages } from '@/lib/pipeline/message';
import { normalizeDomain, normalizeUrl } from '@/lib/identity/normalize';
import type { CampaignConfig, NicheConfig, ScoringProfile } from '@/lib/config/schema';
import { loadOperatorProfile } from '@/lib/config/load';
import type { Sql } from '@/lib/db/sql';
import type { Logger } from '@/lib/logging/logger';
import type { ProspectRow } from '@/lib/repo/types';

export interface RunOptions {
  sql: Sql;
  logger: Logger;
  campaign: CampaignConfig;
  niche: NicheConfig;
  profile: ScoringProfile;
  /** Stop after discovery + dedup (useful to inspect the funnel cheaply). */
  stopAfter?: 'discovery' | 'enrichment' | 'qualification' | 'scoring' | 'research' | 'message';
  /** Cap on prospects taken through the expensive stages. */
  limit?: number;
}

export interface RunStats {
  discovered: number;
  newProspects: number;
  mergedIntoExisting: number;
  reviewCandidates: number;
  enriched: number;
  websitesFound: number;
  websitesCrawled: number;
  /** Prospects submitted to the Web Intelligence resolver. */
  webintelResolved: number;
  /** …of which a website / handle was safe enough to attach. */
  webintelWebsitesAttached: number;
  webintelInstagramAttached: number;
  webintelFacebookAttached: number;
  /** Pages that only became readable after a browser render. */
  browserFallbacks: number;
  funnelSignals: number;
  prospectsWithFunnelSignals: number;
  classified: number;
  inNiche: number;
  /** R2: at least one publicly usable professional channel. Measurement only. */
  contactable: number;
  /** R2: enough of the commercial path was read to judge part of it. */
  funnelObservable: number;
  /** The R2 headline — in_niche AND contactable AND funnel observable. */
  qualifiedContactableObservable: number;
  /** Rail A report, or null when the commercial rail did not run. */
  places: PlacesRailStats | null;
  scored: number;
  researched: number;
  /** R5.1 — fiches produites avec au moins un analyste manquant. */
  researchDegraded: number;
  angles: number;
  messages: number;
  blockedMessages: number;
  llmCalls: number;
  bySource: Record<string, number>;
  notes: string[];
}

const STAGE_ORDER = ['discovery', 'enrichment', 'qualification', 'scoring', 'research', 'message'] as const;

function shouldRun(stage: (typeof STAGE_ORDER)[number], stopAfter?: RunOptions['stopAfter']): boolean {
  if (!stopAfter) return true;
  return STAGE_ORDER.indexOf(stage) <= STAGE_ORDER.indexOf(stopAfter);
}

export async function runCampaign(options: RunOptions): Promise<{ campaignId: string; runId: string; stats: RunStats }> {
  const { sql, logger, campaign, niche, profile } = options;
  // Lue une fois pour tout le run. UNCONFIGURED ne fait rien échouer ici : la
  // découverte, la recherche et le score tournent sans identité. C'est la
  // génération du premier message, et elle seule, qui refuse sans elle.
  const operatorProfile = loadOperatorProfile();
  const http = new HttpClient({ sql });
  const repo = new ProspectRepository(sql, logger);
  const router = new ModelRouter({ sql, logger, maxCalls: campaign.limits.maxLlmCalls });

  const stats: RunStats = {
    discovered: 0,
    newProspects: 0,
    mergedIntoExisting: 0,
    reviewCandidates: 0,
    enriched: 0,
    websitesFound: 0,
    websitesCrawled: 0,
    webintelResolved: 0,
    webintelWebsitesAttached: 0,
    webintelInstagramAttached: 0,
    webintelFacebookAttached: 0,
    browserFallbacks: 0,
    funnelSignals: 0,
    prospectsWithFunnelSignals: 0,
    classified: 0,
    inNiche: 0,
    contactable: 0,
    funnelObservable: 0,
    qualifiedContactableObservable: 0,
    places: null,
    scored: 0,
    researched: 0,
    researchDegraded: 0,
    angles: 0,
    messages: 0,
    blockedMessages: 0,
    llmCalls: 0,
    bySource: {},
    notes: [],
  };

  const campaignId = await upsertCampaign(sql, campaign);
  const runId = await startRun(sql, campaignId);
  await audit(sql, 'campaign.run_started', 'campaign', campaignId, { slug: campaign.slug });

  try {
    // ---------------------------------------------------------------- discovery
    if (shouldRun('discovery', options.stopAfter)) {
      for (const sourceConfig of campaign.discovery.sources) {
        if (!sourceConfig.enabled) {
          stats.notes.push(`source ${sourceConfig.provider} désactivée dans la campagne`);
          continue;
        }

        /**
         * Rail A does not fit the generic DiscoverySource port, and that is a
         * consequence of the Google terms rather than an inconsistency: a
         * Places candidate has no storable name, so it cannot be returned as a
         * DiscoveredBusiness. It has to pass through identification by an
         * independent source first. Both rails still converge on the same
         * `repo.upsertDiscovered`, which is where deduplication happens.
         */
        if (sourceConfig.provider === 'google_places') {
          const outcome = await runPlacesStage({
            sql,
            repo,
            http,
            logger,
            campaign,
            campaignId,
            runId,
            niche,
            maxCandidates: Math.min(sourceConfig.maxResults, campaign.discovery.places.maxCandidates),
          });
          stats.places = outcome.stats;
          if (outcome.stats) {
            stats.discovered += outcome.stats.identified;
            stats.bySource['google_places'] = outcome.stats.identified;
            stats.newProspects += outcome.stats.prospectsCreated;
            stats.mergedIntoExisting += outcome.stats.prospectsMerged;
          }
          for (const note of outcome.notes) stats.notes.push(note);
          continue;
        }

        const source = createDiscoverySource(sourceConfig.provider);
        const availability = source.availability();
        if (!availability.ok) {
          stats.notes.push(`source ${sourceConfig.provider} indisponible : ${availability.reason}`);
          logger.warn('discovery.source_unavailable', {
            provider: sourceConfig.provider,
            reason: availability.reason,
          });
          continue;
        }

        const found = await source.discover({
          campaign,
          niche,
          source: sourceConfig,
          http,
          logger: logger.child({ provider: sourceConfig.provider }),
          shouldStop: () => false,
        });

        stats.discovered += found.length;
        stats.bySource[sourceConfig.provider] = found.length;
        logger.info('discovery.source_done', { provider: sourceConfig.provider, found: found.length });

        for (const business of found) {
          const blocked = await isDoNotContact(sql, business.registryId ?? null, business.websiteUrl ?? null);
          if (blocked) {
            logger.info('discovery.skipped_dnc', { name: business.name });
            continue;
          }
          const result = await repo.upsertDiscovered(campaignId, business);
          if (result.created) stats.newProspects += 1;
          else stats.mergedIntoExisting += 1;
          stats.reviewCandidates += result.reviewCandidates;
          // Rail B. Recording it is what keeps a registry-only prospect visible
          // as a deliberate long-tail catch rather than an unexplained row.
          await repo.recordDiscoveryOrigin(campaignId, result.prospectId, {
            provider: sourceConfig.provider,
            rail: 'long_tail',
            externalId: business.externalId,
          });
        }
      }
    }

    const limit = options.limit ?? campaign.discovery.targetProspects;

    /**
     * One candidate pool, chosen once, carried through every expensive stage.
     *
     * Discovery can return hundreds of registry hits; enriching, classifying and
     * researching all of them would burn the LLM budget on businesses that will
     * never be contacted. The pool is ranked (niche words in the trading name,
     * known website) and sized at 3× the target so exclusions still leave enough
     * prospects to fill the target.
     */
    const poolSize = Math.max(limit * 3, limit);
    let pool = prioritise(await repo.listByCampaign(campaignId), niche).slice(0, poolSize);
    const poolIds = new Set(pool.map((prospect) => prospect.id));
    logger.info('pipeline.pool_selected', { poolSize: pool.length, target: limit });

    // --------------------------------------------------------------- enrichment
    if (shouldRun('enrichment', options.stopAfter)) {
      const searchProvider = createWebSearchProvider(http);
      const searchAvailability = searchProvider.availability();
      if (!searchAvailability.ok) {
        stats.notes.push(
          `recherche web désactivée (${searchAvailability.reason}) : les sites non présents dans les sources ouvertes restent inconnus`,
        );
      }

      // A degraded public API must not hold the whole run hostage: after a few
      // consecutive provider failures, the source is dropped for this run and the
      // reason is reported instead of silently costing minutes per prospect.
      let osmConsecutiveFailures = 0;
      const OSM_BREAKER_LIMIT = 3;

      // Same rule for the Web Intelligence worker. If le serveur is unreachable,
      // the run degrades to registry-only data and says so, rather than adding
      // a timeout per prospect for the rest of the campaign.
      const webintel = createWebIntelClient(http);
      let webintelConsecutiveFailures = 0;
      const WEBINTEL_BREAKER_LIMIT = 3;
      if (webintel) {
        try {
          const health = await webintel.health();
          logger.info('enrich.webintel_ready', { status: health.status, version: health.version });
          if (health.status !== 'ok') {
            stats.notes.push(`Web Intelligence en état « ${health.status} »`);
          }
        } catch (error) {
          stats.notes.push(
            `Web Intelligence injoignable (${error instanceof Error ? error.message : String(error)}) : ` +
              'les prospects sans site resteront sans site',
          );
          webintelConsecutiveFailures = WEBINTEL_BREAKER_LIMIT;
        }
      }

      for (const prospect of pool) {
        let websiteUrl = prospect.website_url;

        if (campaign.enrichment.matchOpenStreetMap && !websiteUrl && osmConsecutiveFailures < OSM_BREAKER_LIMIT) {
          const { match, providerFailed } = await matchOpenStreetMap(http, logger, prospect);
          if (providerFailed) {
            osmConsecutiveFailures += 1;
            if (osmConsecutiveFailures >= OSM_BREAKER_LIMIT) {
              stats.notes.push(
                'OpenStreetMap (Overpass) indisponible : enrichissement OSM désactivé pour ce run',
              );
              logger.warn('enrich.osm_circuit_open', { failures: osmConsecutiveFailures });
            }
          } else {
            osmConsecutiveFailures = 0;
          }
          if (match) {
            for (const item of match.evidence) await repo.addEvidence(prospect.id, item);
            await repo.fillMissingColumns(prospect.id, {
              website_url: match.contact.websiteUrl,
              domain: normalizeDomain(match.contact.websiteUrl),
              phone: match.contact.phone,
              email: match.contact.email,
              instagram_handle: match.contact.instagramHandle,
              facebook_url: match.contact.facebookUrl,
            });
            websiteUrl = websiteUrl ?? match.contact.websiteUrl;
            logger.info('enrich.osm_matched', {
              prospect: prospect.id,
              osmId: match.osmId,
              similarity: Number(match.similarity.toFixed(2)),
            });
          }
        }

        /**
         * Web Intelligence resolution.
         *
         * Runs when the prospect is missing a website or a social handle — the
         * registries give a name and an address and almost nothing else, and
         * this is the only stage that can turn that into something worth
         * reading. The worker proposes; `decideFromResolution` re-checks the
         * name locally and decides what is safe to write.
         */
        const needsResolution = !websiteUrl || !prospect.instagram_handle;
        if (
          webintel &&
          needsResolution &&
          campaign.enrichment.searchForWebsite &&
          webintelConsecutiveFailures < WEBINTEL_BREAKER_LIMIT
        ) {
          try {
            const resolution = await webintel.resolveBusiness({
              name: prospect.display_name,
              country: prospect.country,
              city: prospect.city,
              postalCode: prospect.postal_code,
              addressLine: prospect.address_line,
              registryId: prospect.registry_id,
              phone: prospect.phone,
              nicheHints: niche.positiveTerms.slice(0, 2),
            });
            webintelConsecutiveFailures = 0;
            stats.webintelResolved += 1;

            const decision = decideFromResolution(prospect.display_name, resolution);
            for (const item of decision.evidence) await repo.addEvidence(prospect.id, item);

            if (decision.attachWebsiteUrl) {
              websiteUrl = websiteUrl ?? decision.attachWebsiteUrl;
              stats.webintelWebsitesAttached += 1;
            }
            if (decision.attachInstagram) stats.webintelInstagramAttached += 1;
            if (decision.attachFacebook) stats.webintelFacebookAttached += 1;

            await repo.fillMissingColumns(prospect.id, {
              website_url: decision.attachWebsiteUrl,
              domain: decision.attachDomain,
              instagram_handle: decision.attachInstagram,
              facebook_url: decision.attachFacebook,
            });

            logger.info('enrich.webintel_resolved', {
              prospect: prospect.id,
              status: decision.status,
              confidence: Number(decision.confidence.toFixed(2)),
              attachedWebsite: Boolean(decision.attachWebsiteUrl),
              attachedInstagram: Boolean(decision.attachInstagram),
            });
          } catch (error) {
            webintelConsecutiveFailures += 1;
            const message = error instanceof Error ? error.message : String(error);
            logger.warn('enrich.webintel_failed', { prospect: prospect.id, error: message });
            if (webintelConsecutiveFailures >= WEBINTEL_BREAKER_LIMIT) {
              stats.notes.push(
                'Web Intelligence indisponible : résolution et crawl distants désactivés pour ce run',
              );
              logger.warn('enrich.webintel_circuit_open', { failures: webintelConsecutiveFailures });
            }
          }
        }

        if (!websiteUrl && !webintel && campaign.enrichment.searchForWebsite) {
          const search = await findWebsiteFor(searchProvider, logger, prospect.display_name, prospect.city);
          if (search.guess) {
            websiteUrl = search.guess.url;
            await repo.addEvidence(prospect.id, {
              field: 'website_url',
              valueText: search.guess.url,
              provider: `search:${searchProvider.name}`,
              method: 'api',
              sourceUrl: search.guess.url,
              confidence: search.guess.confidence,
            });
            await repo.fillMissingColumns(prospect.id, {
              website_url: normalizeUrl(search.guess.url),
              domain: search.guess.domain,
            });
          } else if (search.skipped) {
            await repo.addEvidence(prospect.id, {
              field: 'website_lookup',
              valueText: `aucune source de recherche disponible (${search.skipped})`,
              provider: 'system',
              method: 'derived',
              confidence: 1,
            });
          }
        }

        if (websiteUrl) stats.websitesFound += 1;

        if (websiteUrl && campaign.enrichment.crawlWebsites) {
          // Through the worker when it is available — it renders JavaScript
          // pages and reports funnel signals — and directly otherwise. Both
          // paths run the same extraction, so the evidence is comparable.
          const remote =
            webintel && webintelConsecutiveFailures < WEBINTEL_BREAKER_LIMIT
              ? await crawlViaWebIntel(webintel, logger, websiteUrl, niche, campaign.enrichment.maxPagesPerSite)
              : null;
          if (remote) {
            stats.browserFallbacks += remote.browserFallbacks;
            stats.funnelSignals += remote.funnelObserved;
            if (remote.funnelObserved > 0) stats.prospectsWithFunnelSignals += 1;
          } else if (webintel) {
            webintelConsecutiveFailures += 1;
          }

          const crawl =
            remote ?? (await crawlWebsite(http, websiteUrl, niche, logger, campaign.enrichment.maxPagesPerSite));
          if (crawl.pagesCrawled.length > 0) stats.websitesCrawled += 1;
          for (const item of crawl.evidence) await repo.addEvidence(prospect.id, item);
          await repo.fillMissingColumns(prospect.id, {
            email: crawl.contact.email,
            phone: crawl.contact.phone,
            instagram_handle: crawl.contact.instagramHandle,
            facebook_url: crawl.contact.facebookUrl,
          });
          if (crawl.skippedByRobots.length > 0) {
            await repo.addEvidence(prospect.id, {
              field: 'crawl_robots_skip',
              valueJson: crawl.skippedByRobots,
              provider: 'website',
              method: 'derived',
            });
          }
        }

        await sql.query('update prospects set last_enriched_at = now(), updated_at = now() where id = $1', [
          prospect.id,
        ]);
        if (prospect.stage === 'discovered') await repo.setStage(prospect.id, 'enriched');
        stats.enriched += 1;

        // Everything observable has now been observed for this prospect, so the
        // two R2 measurements are meaningful.
        const reach = await measureReach(repo, prospect);
        if (reach.contactable) stats.contactable += 1;
        if (reach.funnelObservable) stats.funnelObservable += 1;
      }
      pool = (await repo.listByCampaign(campaignId)).filter((prospect) => poolIds.has(prospect.id));
    }

    // ------------------------------------------------------------ qualification
    if (shouldRun('qualification', options.stopAfter)) {
      for (const prospect of pool) {
        const evidence = await repo.evidenceFor(prospect.id);
        const deterministic = classifyDeterministic(prospect, evidence, niche);

        let verdict = deterministic.verdict;
        let confidence = deterministic.confidence;
        let decidedBy: 'deterministic' | 'llm' = 'deterministic';
        let reasons = [
          deterministic.positiveHits.length > 0 ? `termes de niche : ${deterministic.positiveHits.join(', ')}` : null,
          deterministic.negativeHits.length > 0 ? `termes d'exclusion : ${deterministic.negativeHits.join(', ')}` : null,
          deterministic.registryCode ? `code NAF ${deterministic.registryCode}` : null,
        ].filter((value): value is string => value !== null);
        let modelRunId: string | null = null;

        if (campaign.qualification.useLlm && !deterministic.decisive) {
          const llm = await classifyWithLlm(router, prospect, evidence, niche, deterministic);
          if (llm) {
            verdict = llm.verdict;
            confidence = llm.confidence;
            decidedBy = 'llm';
            reasons = llm.reasons;
            modelRunId = llm.modelRunId;
          } else {
            stats.notes.push('classification LLM indisponible : repli sur les règles déterministes');
          }
        }

        await sql.query(
          `insert into prospect_classifications
             (prospect_id, verdict, confidence, decided_by, reasons, evidence_refs, model_run_id)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [
            prospect.id,
            verdict,
            confidence,
            decidedBy,
            JSON.stringify(reasons),
            JSON.stringify(evidence.slice(0, 30).map((item) => item.id)),
            modelRunId,
          ],
        );
        await sql.query(
          'update prospects set niche_verdict = $2, niche_confidence = $3, updated_at = now() where id = $1',
          [prospect.id, verdict, confidence],
        );

        stats.classified += 1;
        if (verdict === 'in_niche') stats.inNiche += 1;

        const keep =
          campaign.qualification.keepVerdicts.includes(verdict) &&
          confidence >= campaign.qualification.minConfidence;
        await repo.setStage(prospect.id, keep ? 'qualified' : 'excluded');
      }
      pool = (await repo.listByCampaign(campaignId)).filter((prospect) => poolIds.has(prospect.id));
    }

    const qualified = pool.filter((prospect) => prospect.stage === 'qualified');

    /**
     * The number this release is judged on.
     *
     * Not "how many businesses did we find" — how many real, in-niche artisans
     * do we understand well enough to approach intelligently. A prospect we
     * cannot reach, or whose commercial path we have never seen, does not count
     * however good the business may be.
     */
    for (const prospect of pool) {
      const evidence = await repo.evidenceFor(prospect.id);
      if (isQualifiedContactableObservable(prospect, evidence)) {
        stats.qualifiedContactableObservable += 1;
      }
    }

    // -------------------------------------------------------------------- score
    if (shouldRun('scoring', options.stopAfter)) {
      for (const prospect of qualified) {
        const evidence = await repo.evidenceFor(prospect.id);
        const fresh = (await repo.get(prospect.id)) ?? prospect;
        const llmObservations: LlmObservation[] = [];
        const result = scoreProspect({ prospect: fresh, evidence, profile, llmObservations });

        await sql.query(
          `insert into prospect_scores
             (prospect_id, campaign_id, profile_key, profile_version, total, band,
              deterministic, llm_observations, weights, missing_signals)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            prospect.id,
            campaignId,
            profile.key,
            profile.version,
            result.total,
            result.band,
            JSON.stringify({ signals: result.signals, coverage: result.coverage, capped: result.coverageCapped }),
            JSON.stringify(result.llmObservations),
            JSON.stringify(result.weights),
            JSON.stringify(result.missingSignals),
          ],
        );
        await sql.query('update prospects set score = $2, score_band = $3, updated_at = now() where id = $1', [
          prospect.id,
          result.total,
          result.band,
        ]);
        stats.scored += 1;
      }
    }

    // ------------------------------------------------------- research + message
    if (shouldRun('research', options.stopAfter)) {
      const caseStudy = await loadCaseStudy(sql);
      // Best-scored first, so a run that is cut short still produced the most
      // useful prospects.
      const ranked = (await repo.listByCampaign(campaignId, ['qualified', 'researched', 'message_ready']))
        .filter((prospect) => poolIds.has(prospect.id))
        .slice(0, limit);

      for (const prospect of ranked) {
        const evidence = await repo.evidenceFor(prospect.id);
        const fresh = (await repo.get(prospect.id)) ?? prospect;
        const score = scoreProspect({ prospect: fresh, evidence, profile });

        /**
         * R5.1 — l'architecture de la recherche est une décision de campagne.
         *
         * Les deux chemins rendent le même `ResearchResult`, donc l'angle et le
         * message en aval ne peuvent pas savoir lequel a tourné. C'est ce qui
         * rend la bascule réversible : changer un mot dans la campagne suffit,
         * et rien d'autre dans le pipeline n'en dépend.
         */
        const withWorkers =
          campaign.research.architecture === 'workers'
            ? await researchWithWorkers(router, fresh, evidence, score, logger)
            : null;
        const research =
          campaign.research.architecture === 'workers'
            ? withWorkers
            : await researchProspect(router, fresh, evidence, score);
        if (!research) {
          stats.notes.push(`research indisponible pour ${fresh.display_name}`);
          continue;
        }
        if (withWorkers && withWorkers.workerStats.lanesFailed.length > 0) {
          // A degraded fan-out is reported rather than absorbed: the sheet is
          // thinner for a reason a reader has to be able to see.
          stats.notes.push(
            `${fresh.display_name} : analyste(s) ${withWorkers.workerStats.lanesFailed.join(', ')} ` +
              'indisponible(s) — la fiche le déclare en inconnue',
          );
          stats.researchDegraded += 1;
        }
        const researchRows = await sql.query<{ id: string }>(
          `insert into prospect_research
             (prospect_id, summary, observations, opportunities, unknowns, confidence, model_run_id)
           values ($1,$2,$3,$4,$5,$6,$7) returning id`,
          [
            fresh.id,
            research.summary,
            JSON.stringify(research.observations),
            JSON.stringify(research.opportunities),
            JSON.stringify(research.unknowns),
            research.confidence,
            research.modelRunId,
          ],
        );
        stats.researched += 1;
        await repo.setStage(fresh.id, 'researched');

        const angle = await buildAngle(router, fresh, research, caseStudy);
        if (!angle) {
          stats.notes.push(`angle indisponible pour ${fresh.display_name}`);
          continue;
        }
        const angleRows = await sql.query<{ id: string }>(
          `insert into prospect_angles
             (prospect_id, research_id, pain_point, opportunity, approach, personalization,
              personalization_evidence, use_case_study, case_study_key, confidence, model_run_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
          [
            fresh.id,
            researchRows[0]?.id ?? null,
            angle.painPoint,
            angle.opportunity,
            angle.approach,
            angle.personalization,
            JSON.stringify(angle.personalizationEvidence),
            angle.useCaseStudy,
            angle.caseStudyKey,
            angle.confidence,
            angle.modelRunId,
          ],
        );
        stats.angles += 1;

        if (!shouldRun('message', options.stopAfter)) continue;

        const generated = await generateMessages(router, campaign, operatorProfile, fresh, research, angle, caseStudy);
        if (!generated) {
          stats.notes.push(`message indisponible pour ${fresh.display_name}`);
          continue;
        }

        for (const message of generated.messages) {
          await sql.query(
            `insert into outreach_messages
               (prospect_id, campaign_id, angle_id, channel, variant, is_primary, body, state,
                personalization_level, rationale, used_facts, guardrail_flags, model_run_id)
             values ($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9,$10,$11,$12)`,
            [
              fresh.id,
              campaignId,
              angleRows[0]?.id ?? null,
              campaign.outreach.channel,
              message.variant,
              message.variant === generated.chosenVariant,
              message.body,
              message.personalizationLevel,
              message.variant === generated.chosenVariant
                ? `${message.rationale} — ${generated.chosenReason}`.trim()
                : message.rationale,
              JSON.stringify(message.usedFacts),
              JSON.stringify(message.guardrailFlags),
              generated.modelRunId,
            ],
          );
          stats.messages += 1;
          if (message.blocked) stats.blockedMessages += 1;
        }

        await repo.setStage(fresh.id, 'message_ready');
      }
    }

    stats.llmCalls = router.callCount;
    await finishRun(sql, runId, 'succeeded', stats, null);
    await audit(sql, 'campaign.run_finished', 'campaign', campaignId, stats as unknown as Record<string, unknown>);
    return { campaignId, runId, stats };
  } catch (error) {
    stats.llmCalls = router.callCount;
    const message = error instanceof Error ? error.message : String(error);
    await finishRun(sql, runId, 'failed', stats, message);
    await audit(sql, 'campaign.run_failed', 'campaign', campaignId, { error: message });
    throw error;
  }
}

interface PlacesStageOptions {
  sql: Sql;
  repo: ProspectRepository;
  http: HttpClient;
  logger: Logger;
  campaign: CampaignConfig;
  campaignId: string;
  runId: string;
  niche: NicheConfig;
  maxCandidates: number;
}

/**
 * Runs rail A, or explains in the run notes why it did not run.
 *
 * Places is opt-in and off by default. An unavailable commercial rail is never
 * an error: the long-tail rail covers the same campaign on its own, and saying
 * so plainly is better than a run that silently found less.
 */
async function runPlacesStage(
  options: PlacesStageOptions,
): Promise<{ stats: PlacesRailStats | null; notes: string[] }> {
  const availability = placesAvailability();
  if (!availability.ok) {
    return { stats: null, notes: [`rail commercial Google Places inactif : ${availability.reason}`] };
  }

  const budget = new PlacesBudget({
    sql: options.sql,
    campaignSlug: options.campaign.slug,
    runId: options.runId,
  });
  const client = new PlacesClient({ http: options.http, budget, logger: options.logger });
  const webintel = createWebIntelClient(options.http);

  const stats = await runPlacesRail({
    sql: options.sql,
    repo: options.repo,
    http: options.http,
    client,
    logger: options.logger.child({ rail: 'places' }),
    campaign: options.campaign,
    campaignId: options.campaignId,
    runId: options.runId,
    niche: options.niche,
    maxCandidates: options.maxCandidates,
    tileRadiusKm: options.campaign.discovery.places.tileRadiusKm,
    ...(options.campaign.discovery.places.queries
      ? { queries: options.campaign.discovery.places.queries }
      : {}),
    identify: placeIdentifier({
      http: options.http,
      logger: options.logger,
      niche: options.niche,
      webintel,
    }),
  });

  const notes: string[] = [];
  if (stats.stoppedReason) notes.push(`rail Places arrêté : ${stats.stoppedReason}`);
  if (stats.unidentified > 0) {
    notes.push(
      `${stats.unidentified} établissement(s) trouvés sur la carte mais non identifiables par une source ` +
        'indépendante : conservés comme identifiants seuls, jamais comme prospects inventés',
    );
  }

  const snapshot = await budget.snapshot();
  options.logger.info('places.budget_snapshot', {
    runBillable: snapshot.runBillable,
    freeCalls: snapshot.freeCalls,
    monthlyDiscovery: snapshot.monthlyDiscovery,
    monthlyDetails: snapshot.monthlyDetails,
  });

  return { stats, notes };
}

/**
 * Recomputes the R2 measurements for a prospect from what is currently observed.
 *
 * Deliberately derived rather than incremented: evidence arrives from several
 * stages and a counter that drifts is worse than no counter. Called after
 * enrichment, when everything that can be observed has been.
 */
async function measureReach(repo: ProspectRepository, prospect: ProspectRow): Promise<ReachAssessment> {
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
  return reach;
}

/**
 * Ranks the candidate pool by how much can actually be learned about a prospect.
 *
 * A known website outranks everything else: it is the only source that yields
 * services, pricing, CTA quality and socials, so it decides whether the research
 * sheet will be substantial or thin. Niche words in the trading name are a
 * tie-breaker, not the driver — with hundreds of registry hits they would
 * otherwise crowd out every prospect we can genuinely study.
 */
export function prioritise(prospects: ProspectRow[], niche: NicheConfig): ProspectRow[] {
  const terms = niche.positiveTerms.map((term) => term.toLowerCase());

  const rank = (prospect: ProspectRow): number => {
    const name = `${prospect.display_name} ${prospect.brand_name ?? ''}`.toLowerCase();
    const nicheHits = Math.min(3, terms.filter((term) => name.includes(term)).length);
    return (
      (prospect.website_url ? 12 : 0) +
      (prospect.instagram_handle ? 5 : 0) +
      (prospect.facebook_url ? 2 : 0) +
      (prospect.phone ? 1 : 0) +
      (prospect.email ? 1 : 0) +
      nicheHits
    );
  };

  return [...prospects].sort((a, b) => rank(b) - rank(a));
}

async function upsertCampaign(sql: Sql, campaign: CampaignConfig): Promise<string> {
  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, status, config)
     values ($1,$2,$3,'running',$4)
     on conflict (slug) do update
       set name = excluded.name, niche_key = excluded.niche_key,
           config = excluded.config, status = 'running', updated_at = now()
     returning id`,
    [campaign.slug, campaign.name, campaign.niche, JSON.stringify(campaign)],
  );
  const row = rows[0];
  if (!row) throw new Error('failed to upsert campaign');
  return row.id;
}

async function startRun(sql: Sql, campaignId: string): Promise<string> {
  const rows = await sql.query<{ id: string }>(
    'insert into campaign_runs (campaign_id) values ($1) returning id',
    [campaignId],
  );
  const row = rows[0];
  if (!row) throw new Error('failed to create campaign run');
  return row.id;
}

async function finishRun(
  sql: Sql,
  runId: string,
  status: 'succeeded' | 'failed',
  stats: RunStats,
  error: string | null,
): Promise<void> {
  await sql.query(
    'update campaign_runs set status = $2, stats = $3, error = $4, finished_at = now() where id = $1',
    [runId, status, JSON.stringify(stats), error],
  );
}

async function audit(
  sql: Sql,
  action: string,
  entityType: string,
  entityId: string,
  data: Record<string, unknown>,
): Promise<void> {
  await sql.query(
    'insert into audit_events (actor, action, entity_type, entity_id, data) values ($1,$2,$3,$4,$5)',
    ['pipeline', action, entityType, entityId, JSON.stringify(data)],
  );
}

async function isDoNotContact(sql: Sql, registryId: string | null, websiteUrl: string | null): Promise<boolean> {
  const values: string[] = [];
  if (registryId) values.push(registryId.replace(/\D/g, ''));
  const domain = normalizeDomain(websiteUrl);
  if (domain) values.push(domain);
  if (values.length === 0) return false;
  const rows = await sql.query<{ count: string }>(
    'select count(*)::text as count from do_not_contact where value = any($1::text[])',
    [values],
  );
  return Number.parseInt(rows[0]?.count ?? '0', 10) > 0;
}

