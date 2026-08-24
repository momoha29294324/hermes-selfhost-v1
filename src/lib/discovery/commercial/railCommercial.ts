import { planFromConfig, zonesFromGeography, type CommercialQuery } from '@/lib/discovery/commercial/queryPlan';
import {
  addKindCounts,
  classifyCommercialHits,
  countByKind,
  type ClassifiedResult,
  type CommercialResultKind,
} from '@/lib/discovery/commercial/classifyResult';
import {
  groupIntoBusinesses,
  provisionalName,
  type CommercialBusinessCandidate,
  type QueryResults,
} from '@/lib/discovery/commercial/businessCandidate';
import { readSiteIdentity, zoneMatch, type BusinessIdentity } from '@/lib/discovery/commercial/siteIdentity';
import { SearchBudget, SearchBudgetExceededError } from '@/lib/discovery/search/budget';
import { assertNoSearchResultContent } from '@/lib/discovery/search/terms';
import { SEARCH_PROVIDER_QUEUE } from '@/lib/discovery/search/railSearch';
import {
  isAttachable,
  verifyIdentity,
  NAME_AGREEMENT_FLOOR,
  type IdentityVerdict,
} from '@/lib/discovery/openweb/identityVerify';
import { probeDomain, type DnsResolver, type DomainProbe } from '@/lib/discovery/openweb/domainVerify';
import { analyseFunnel, funnelEvidence, type FunnelSynthesis } from '@/lib/pipeline/funnel';
import { assessReach } from '@/lib/pipeline/reach';
import { classifyDeterministic } from '@/lib/pipeline/classify';
import { crawlWebsite } from '@/lib/enrichment/websiteCrawl';
import { crawlViaWebIntel, type WebIntelClient } from '@/lib/enrichment/webintel';
import { SearchProviderError, classifySearchFailure, type WebSearchProvider } from '@/lib/enrichment/webSearch';
import { ProviderUnavailableError, type ProviderScheduler } from '@/lib/http/scheduler';
import { identityKeys } from '@/lib/identity/resolve';
import { nameSimilarity, normalizeUrl } from '@/lib/identity/normalize';
import type { CampaignConfig, NicheConfig } from '@/lib/config/schema';
import type { DiscoveredBusiness } from '@/lib/discovery/types';
import type { HttpClient } from '@/lib/http/client';
import type { Logger } from '@/lib/logging/logger';
import type { ProspectRepository } from '@/lib/repo/prospects';
import type { ProspectRow } from '@/lib/repo/types';
import type { Sql } from '@/lib/db/sql';

/**
 * Rail R5 — la découverte commerciale.
 *
 * Le trajet, et ce qui a changé de sens par rapport aux quatre rails précédents :
 *
 *   métier × zone                     ← la question du client, pas celle du registre
 *        │  plan borné, paliers ordonnés (§3)
 *        ▼
 *   index web (Serper)                ← résultats EN MÉMOIRE, jamais écrits
 *        │  classement en sept catégories (§5)
 *        ▼
 *   entreprises candidates            ← regroupement, PAS un prospect par URL (§6)
 *        │
 *        │  ◄── ici le rail cesse de croire le moteur
 *        ▼
 *   nous ouvrons le site nous-mêmes   ← DNS, HTTP, accueil, mentions légales
 *        │  ce que le site déclare de lui-même (siteIdentity.ts)
 *        ▼
 *   déjà connu ? → VÉRIFICATEUR R3, seuils inchangés (§7)
 *        │
 *        ▼
 *   prospect + crawl + parcours commercial (§9, §10)
 *
 * ---------------------------------------------------------------------------
 * Ce que le rail refuse de faire
 * ---------------------------------------------------------------------------
 *
 * **Il ne croit pas le moteur sur l'identité.** Un résultat est un pointeur.
 * Tout ce qui devient une ligne de la base vient de la page que nous avons
 * ouverte, avec cette page pour source. Aucun titre, aucune description, aucun
 * classement n'atteint un chemin d'écriture — `assertNoSearchResultContent`
 * garde ce chemin et refuse en levant plutôt qu'en nettoyant.
 *
 * **Il ne fusionne pas sur une ressemblance quand le vérificateur a dit non.**
 * Quand une entreprise découverte sur le web ressemble à un prospect déjà en
 * base, le rail soumet le domaine au vérificateur de R3 — dont il ne touche
 * aucun seuil — et propage son refus jusqu'au rapprochement (`blockFuzzyMerge`).
 * Laisser une similarité de nom trancher après un refus du test le plus strict
 * serait rendre ce test décoratif.
 *
 * **Il n'invente jamais un nom.** Tant que le site n'a pas été lu, une
 * entreprise porte un `provisionalName` dérivé de son domaine, et ce nom ne
 * devient un `display_name` que si le site n'en déclare aucun — auquel cas
 * l'évidence enregistrée dit d'où il vient.
 */

export const COMMERCIAL_RAIL = 'commercial_web_discovery' as const;
/** Le fournisseur inscrit sur les faits : c'est notre lecture du site. */
export const COMMERCIAL_EVIDENCE_PROVIDER = 'website';
/** Le fournisseur inscrit sur l'origine : « par où avons-nous appris son existence ». */
export const COMMERCIAL_ORIGIN_PROVIDER = 'commercial_web';

export interface CommercialRailDeps {
  sql: Sql;
  repo: ProspectRepository;
  http: HttpClient;
  logger: Logger;
  niche: NicheConfig;
  campaign: CampaignConfig;
  campaignId: string;
  runId: string | null;
  scheduler: ProviderScheduler;
  provider: WebSearchProvider;
  budget: SearchBudget;
  /** Null quand le worker distant n'est pas joignable : le rail crawle en direct. */
  webintel: WebIntelClient | null;
  resolver?: DnsResolver;
  now?: () => Date;
}

export interface CommercialRailOptions {
  /** `false` = mesure seule, rien n'est écrit. */
  persist?: boolean;
  /** Surcharge les plafonds de la campagne, pour un essai. */
  maxBusinesses?: number;
  maxSitesProbed?: number;
  maxQueries?: number;
}

export interface CommercialQueryOutcome {
  tier: CommercialQuery['tier'];
  zone: string;
  term: string;
  query: string;
  issued: boolean;
  avoidedReason: string | null;
  resultsCount: number;
  byKind: Record<CommercialResultKind, number>;
  latencyMs: number | null;
  error: string | null;
}

export interface CommercialCandidateOutcome {
  groupingKey: string;
  provisionalName: string;
  domain: string | null;
  form: CommercialBusinessCandidate['form'];
  sightings: number;
  bestRank: number;
  zones: string[];
  probed: boolean;
  httpStatus: number | null;
  declaredName: string | null;
  declaredCity: string | null;
  registryIdOnSite: string | null;
  identityReview: BusinessIdentity['review'] | null;
  identityConfidence: number;
  inZone: boolean | null;
  nicheTerms: string[];
  nicheVerdict: string | null;
  promoted: boolean;
  prospectId: string | null;
  mergedIntoExisting: boolean;
  verifierBlockedMerge: boolean;
  funnelObservable: boolean;
  funnelSummary: string | null;
  opportunityCount: number;
  contactable: boolean;
  rejectReason: string | null;
}

export interface CommercialRailStats {
  zones: string[];
  queriesPlanned: number;
  queriesIssued: number;
  queriesAvoided: number;
  resultsSeen: number;
  byKind: Record<CommercialResultKind, number>;
  candidatesFound: number;
  duplicateSightings: number;
  leadsAttached: number;
  leadsUnattached: number;
  candidatesProbed: number;
  sitesRead: number;
  promoted: number;
  createdProspects: number;
  mergedIntoExisting: number;
  verifierBlockedMerges: number;
  outOfZone: number;
  inNiche: number;
  adjacent: number;
  outOfNiche: number;
  uncertainNiche: number;
  contactable: number;
  funnelObservable: number;
  identityConfirmed: number;
  identityManualReview: number;
  identityUncertain: number;
  queries: CommercialQueryOutcome[];
  candidates: CommercialCandidateOutcome[];
  stoppedReason: string | null;
  errors: string[];
  durationMs: number;
}

function emptyStats(zones: string[]): CommercialRailStats {
  return {
    zones,
    queriesPlanned: 0,
    queriesIssued: 0,
    queriesAvoided: 0,
    resultsSeen: 0,
    byKind: countByKind([]),
    candidatesFound: 0,
    duplicateSightings: 0,
    leadsAttached: 0,
    leadsUnattached: 0,
    candidatesProbed: 0,
    sitesRead: 0,
    promoted: 0,
    createdProspects: 0,
    mergedIntoExisting: 0,
    verifierBlockedMerges: 0,
    outOfZone: 0,
    inNiche: 0,
    adjacent: 0,
    outOfNiche: 0,
    uncertainNiche: 0,
    contactable: 0,
    funnelObservable: 0,
    identityConfirmed: 0,
    identityManualReview: 0,
    identityUncertain: 0,
    queries: [],
    candidates: [],
    stoppedReason: null,
    errors: [],
    durationMs: 0,
  };
}

/**
 * Lance le rail.
 *
 * Ne lève jamais pour une raison métier : un fournisseur absent, un budget
 * épuisé ou une clé refusée sont des `stoppedReason` renseignés, pas des
 * exceptions. Un pilote qui s'arrête doit rendre ce qu'il a déjà appris.
 */
export async function runCommercialDiscovery(
  deps: CommercialRailDeps,
  options: CommercialRailOptions = {},
): Promise<CommercialRailStats> {
  const startedAt = Date.now();
  const config = deps.campaign.discovery.commercialWeb;
  const persist = options.persist !== false;
  const zones = zonesFromGeography(deps.campaign.geography);
  const stats = emptyStats(zones.map((zone) => zone.label));

  const maxBusinesses = options.maxBusinesses ?? config.maxBusinesses;
  const maxSitesProbed = options.maxSitesProbed ?? config.maxSitesProbed;

  const availability = deps.provider.availability();
  if (!availability.ok) {
    stats.stoppedReason = `fournisseur indisponible : ${availability.reason ?? 'raison inconnue'}`;
    stats.durationMs = Date.now() - startedAt;
    return stats;
  }
  if (zones.length === 0) {
    stats.stoppedReason =
      'aucune zone : une campagne « national » ne produit pas de requête de découverte commerciale — énumérer des villes';
    stats.durationMs = Date.now() - startedAt;
    return stats;
  }

  const plan = planFromConfig(deps.niche, deps.campaign.geography, {
    ...config,
    ...(options.maxQueries !== undefined ? { maxQueries: options.maxQueries } : {}),
  });
  stats.queriesPlanned = plan.length;
  if (plan.length === 0) {
    stats.stoppedReason = 'aucun terme commercial configuré pour cette niche (niche.commercialQueries)';
    stats.durationMs = Date.now() - startedAt;
    return stats;
  }

  // ------------------------------------------------------------- découverte
  const batches: QueryResults[] = [];
  for (const query of plan) {
    if (deps.budget.exhausted) {
      await recordAvoided(deps, query, stats, deps.budget.stopReason?.message ?? 'budget épuisé');
      continue;
    }
    const outcome = await issueQuery(deps, query, config.resultsPerQuery, stats);
    if (outcome === 'fatal') {
      stats.stoppedReason = stats.errors[stats.errors.length - 1] ?? 'échec fatal du fournisseur';
      break;
    }
    if (outcome === 'stop') break;
    batches.push({ query, results: outcome });
  }

  // ------------------------------------------------------- regroupement (§6)
  const grouping = groupIntoBusinesses(batches);
  stats.candidatesFound = grouping.candidates.length;
  stats.duplicateSightings = grouping.duplicateSightings;
  stats.leadsAttached = grouping.leadsAttached;
  stats.leadsUnattached = grouping.leadsUnattached;

  /**
   * Ce que le pilote emporte.
   *
   * Les entreprises avec un site propre passent devant, et non par préférence
   * esthétique : un compte social seul ne donne ni mentions légales, ni
   * parcours commercial à lire, c'est-à-dire aucune des deux choses que R5
   * existe pour mesurer. Il reste candidat et consultable ; il n'est
   * simplement pas ce qu'on ouvre en premier quand le plafond est à trente.
   */
  const ordered = [...grouping.candidates].sort((left, right) => {
    if (left.form !== right.form) return left.form === 'site' ? -1 : 1;
    return right.sightings.length - left.sightings.length || left.bestRank - right.bestRank;
  });

  const zoneLabels = zones.map((zone) => zone.label);
  let probed = 0;

  for (const candidate of ordered) {
    if (stats.promoted >= maxBusinesses) {
      stats.stoppedReason = stats.stoppedReason ?? `plafond de ${maxBusinesses} entreprises atteint`;
      break;
    }
    if (probed >= maxSitesProbed) {
      stats.stoppedReason = stats.stoppedReason ?? `plafond de ${maxSitesProbed} sites sondés atteint`;
      break;
    }

    const outcome = emptyCandidateOutcome(candidate);

    if (candidate.form !== 'site' || !candidate.domain) {
      /**
       * Un compte social ou une page hébergée sans site : conservé comme
       * candidat, jamais promu en prospect par ce rail. Le rattacher à une
       * entreprise demanderait le rapprochement social — qui exige une
       * corroboration que nous n'avons pas encore ici (§8) — et le promouvoir
       * seul créerait un prospect dont nous ne saurions ni le nom, ni la ville,
       * ni comment il vend.
       */
      outcome.rejectReason = 'présence sans site propre : candidat conservé, non promu';
      if (persist) await persistCandidate(deps, candidate, outcome, 'discovered');
      stats.candidates.push(outcome);
      continue;
    }

    probed += 1;
    stats.candidatesProbed += 1;

    let probe: DomainProbe;
    try {
      probe = await probeDomain(
        { http: deps.http, logger: deps.logger, ...(deps.resolver ? { resolver: deps.resolver } : {}) },
        candidate.domain,
        { readLegalPage: true, guessLegalPaths: true },
      );
    } catch (error) {
      outcome.rejectReason = error instanceof Error ? error.message : String(error);
      stats.errors.push(outcome.rejectReason);
      if (persist) await persistCandidate(deps, candidate, outcome, 'rejected');
      stats.candidates.push(outcome);
      continue;
    }

    outcome.probed = true;
    outcome.httpStatus = probe.httpStatus;

    const identity = readSiteIdentity(probe, deps.niche);
    outcome.declaredName = identity.name;
    outcome.declaredCity = identity.city;
    outcome.registryIdOnSite = identity.registryId;
    outcome.identityReview = identity.review;
    outcome.identityConfidence = Number(identity.confidence.toFixed(3));
    outcome.nicheTerms = identity.nicheTermsFound;

    if (identity.facts.length === 0) {
      outcome.rejectReason = `site injoignable ou illisible (HTTP ${probe.httpStatus ?? '—'}${
        probe.robotsDisallowed ? ', robots.txt' : ''
      })`;
      if (persist) await persistCandidate(deps, candidate, outcome, 'rejected');
      stats.candidates.push(outcome);
      continue;
    }
    stats.sitesRead += 1;

    const inZone = zoneMatch(identity, zoneLabels);
    outcome.inZone = inZone;
    if (inZone === false) {
      stats.outOfZone += 1;
      outcome.rejectReason = `l’entreprise se déclare à « ${identity.city ?? '—'} », hors des zones du pilote`;
      if (persist) await persistCandidate(deps, candidate, outcome, 'rejected');
      stats.candidates.push(outcome);
      continue;
    }

    /**
     * Le métier, avant de créer quoi que ce soit.
     *
     * Un site sans un seul mot du métier remonté par une requête métier est le
     * cas normal du bruit d'index : un garage, un loueur, un revendeur de
     * produits. Le refuser ici évite d'écrire un prospect qu'il faudrait
     * exclure trois étapes plus loin, après l'avoir crawlé.
     */
    if (identity.nicheTermsFound.length === 0) {
      outcome.nicheVerdict = 'out_of_niche';
      stats.outOfNiche += 1;
      outcome.rejectReason = 'aucun terme du métier sur les pages lues';
      if (persist) await persistCandidate(deps, candidate, outcome, 'rejected');
      stats.candidates.push(outcome);
      continue;
    }

    if (!persist) {
      outcome.promoted = true;
      stats.promoted += 1;
      stats.candidates.push(outcome);
      continue;
    }

    // ------------------------------------------- déjà connu ? (vérificateur R3)
    const verification = await verifyAgainstExisting(deps, candidate.domain, identity, probe);
    outcome.verifierBlockedMerge = verification.blockedMerge;
    if (verification.blockedMerge) stats.verifierBlockedMerges += 1;

    const business = toDiscoveredBusiness(candidate, identity, probe);
    const upsert = await deps.repo.upsertDiscovered(deps.campaignId, business, {
      blockFuzzyMerge: verification.blockedMerge,
    });

    outcome.prospectId = upsert.prospectId;
    outcome.mergedIntoExisting = !upsert.created;
    if (upsert.created) stats.createdProspects += 1;
    else stats.mergedIntoExisting += 1;

    await deps.repo.recordIdentityKeys(
      deps.campaignId,
      upsert.prospectId,
      identityKeys({
        name: business.name,
        domain: candidate.domain,
        city: identity.city,
        instagramHandle: business.instagramHandle ?? null,
      }),
    );
    await deps.repo.recordDiscoveryOrigin(deps.campaignId, upsert.prospectId, {
      provider: COMMERCIAL_ORIGIN_PROVIDER,
      rail: COMMERCIAL_RAIL,
      externalId: candidate.domain,
    });
    await writeDiscoveryEvidence(deps, upsert.prospectId, candidate, identity, probe, verification.verdicts);
    await deps.repo.saveIdentityReview(upsert.prospectId, identity.review);

    if (identity.review === 'confirmed') stats.identityConfirmed += 1;
    else if (identity.review === 'manual_review') stats.identityManualReview += 1;
    else stats.identityUncertain += 1;

    // ------------------------------------------------- parcours commercial (§9)
    const funnel = await readFunnel(deps, upsert.prospectId, probe, identity);
    outcome.funnelObservable = funnel.observable;
    outcome.funnelSummary = funnel.observable ? funnel.summary : null;
    outcome.opportunityCount = funnel.opportunitySignals.length;
    if (funnel.observable) stats.funnelObservable += 1;

    // ------------------------------------------------------------- métier
    const fresh = (await deps.repo.get(upsert.prospectId)) ?? null;
    if (fresh) {
      const verdict = await classifyAndStore(deps, fresh);
      outcome.nicheVerdict = verdict;
      if (verdict === 'in_niche') stats.inNiche += 1;
      else if (verdict === 'adjacent') stats.adjacent += 1;
      else if (verdict === 'out_of_niche') stats.outOfNiche += 1;
      else stats.uncertainNiche += 1;

      const evidence = await deps.repo.evidenceFor(upsert.prospectId);
      const refreshed = (await deps.repo.get(upsert.prospectId)) ?? fresh;
      const reach = assessReach({ prospect: refreshed, evidence });
      await deps.repo.saveReach(upsert.prospectId, {
        contactable: reach.contactable,
        channels: reach.channels,
        funnelObservable: reach.funnelObservable,
        funnelSignalCount: reach.funnelSignalCount,
        commercialVisibility: reach.commercialVisibility,
      });
      outcome.contactable = reach.contactable;
      if (reach.contactable) stats.contactable += 1;
      if (refreshed.stage === 'discovered') await deps.repo.setStage(upsert.prospectId, 'enriched');
    }

    outcome.promoted = true;
    stats.promoted += 1;
    await persistCandidate(deps, candidate, outcome, 'promoted');
    stats.candidates.push(outcome);
  }

  stats.durationMs = Date.now() - startedAt;
  return stats;
}

function emptyCandidateOutcome(candidate: CommercialBusinessCandidate): CommercialCandidateOutcome {
  return {
    groupingKey: candidate.key,
    provisionalName: provisionalName(candidate),
    domain: candidate.domain,
    form: candidate.form,
    sightings: candidate.sightings.length,
    bestRank: candidate.bestRank,
    zones: candidate.zones,
    probed: false,
    httpStatus: null,
    declaredName: null,
    declaredCity: null,
    registryIdOnSite: null,
    identityReview: null,
    identityConfidence: 0,
    inZone: null,
    nicheTerms: [],
    nicheVerdict: null,
    promoted: false,
    prospectId: null,
    mergedIntoExisting: false,
    verifierBlockedMerge: false,
    funnelObservable: false,
    funnelSummary: null,
    opportunityCount: 0,
    contactable: false,
    rejectReason: null,
  };
}

/**
 * Émet une requête, ou explique ce qui l'a empêchée.
 *
 * Le registre de dépense reçoit une ligne dans tous les cas — émise, évitée ou
 * en échec. `query_variant` porte ici le palier et la zone (`core@Lyon`) :
 * c'est notre façon de nommer la question posée, et elle rend le rapport
 * capable de dire quel palier a rapporté quoi.
 */
async function issueQuery(
  deps: CommercialRailDeps,
  query: CommercialQuery,
  resultsPerQuery: number,
  stats: CommercialRailStats,
): Promise<ClassifiedResult[] | 'stop' | 'fatal'> {
  try {
    await deps.budget.assertCanSpend();
  } catch (error) {
    if (error instanceof SearchBudgetExceededError) {
      await recordAvoided(deps, query, stats, error.message);
      return 'stop';
    }
    throw error;
  }

  const startedAt = Date.now();
  const variant = `${query.tier}@${query.zone}`;

  try {
    const hits = await deps.scheduler.run(SEARCH_PROVIDER_QUEUE, () =>
      deps.provider.search(query.query, resultsPerQuery),
    );
    const latencyMs = Date.now() - startedAt;
    const classified = classifyCommercialHits(hits);
    const byKind = countByKind(classified);

    await deps.budget.record({
      provider: deps.provider.name,
      query: query.query,
      queryVariant: variant,
      prospectId: null,
      resultsCount: hits.length,
      candidatesKept: byKind.official_site + byKind.social_profile,
      avoided: false,
      avoidedReason: null,
      billable: true,
      httpStatus: 200,
      latencyMs,
      error: null,
    });

    stats.queriesIssued += 1;
    stats.resultsSeen += hits.length;
    addKindCounts(stats.byKind, byKind);
    stats.queries.push({
      tier: query.tier,
      zone: query.zone,
      term: query.term,
      query: query.query,
      issued: true,
      avoidedReason: null,
      resultsCount: hits.length,
      byKind,
      latencyMs,
      error: null,
    });

    return classified;
  } catch (error) {
    const latencyMs = Date.now() - startedAt;

    if (error instanceof ProviderUnavailableError) {
      await recordAvoided(deps, query, stats, error.message);
      return 'stop';
    }

    const failure = error instanceof SearchProviderError ? error : classifySearchFailure(error, deps.provider.name);

    // Un refus d'authentification ou de quota n'a rien servi : le consigner
    // comme facturable gonflerait le coût annoncé, dans le sens qui compte.
    await deps.budget.record({
      provider: deps.provider.name,
      query: query.query,
      queryVariant: variant,
      prospectId: null,
      resultsCount: 0,
      candidatesKept: 0,
      avoided: false,
      avoidedReason: null,
      billable: failure.kind !== 'auth' && failure.kind !== 'quota',
      httpStatus: failure.status,
      latencyMs,
      error: `${failure.kind}: ${failure.message}`,
    });

    stats.queries.push({
      tier: query.tier,
      zone: query.zone,
      term: query.term,
      query: query.query,
      issued: true,
      avoidedReason: null,
      resultsCount: 0,
      byKind: countByKind([]),
      latencyMs,
      error: `${failure.kind}: ${failure.message}`,
    });
    stats.errors.push(`${failure.kind}: ${failure.message}`);
    deps.logger.warn('commercial.query_failed', {
      provider: deps.provider.name,
      kind: failure.kind,
      tier: query.tier,
      zone: query.zone,
    });

    return failure.fatal ? 'fatal' : 'stop';
  }
}

async function recordAvoided(
  deps: CommercialRailDeps,
  query: CommercialQuery,
  stats: CommercialRailStats,
  reason: string,
): Promise<void> {
  await deps.budget.record({
    provider: deps.provider.name,
    query: query.query,
    queryVariant: `${query.tier}@${query.zone}`,
    prospectId: null,
    resultsCount: 0,
    candidatesKept: 0,
    avoided: true,
    avoidedReason: reason,
    billable: false,
    httpStatus: null,
    latencyMs: null,
    error: null,
  });
  stats.queriesAvoided += 1;
  stats.queries.push({
    tier: query.tier,
    zone: query.zone,
    term: query.term,
    query: query.query,
    issued: false,
    avoidedReason: reason,
    resultsCount: 0,
    byKind: countByKind([]),
    latencyMs: null,
    error: null,
  });
}

interface VerificationOutcome {
  /** Vrai quand le vérificateur a refusé toute association avec un prospect proche. */
  blockedMerge: boolean;
  verdicts: { prospectId: string; displayName: string; verdict: IdentityVerdict }[];
}

/**
 * Le vérificateur de R3, appliqué à sa question d'origine.
 *
 * C'est ici — et seulement ici — que « ce domaine appartient-il à ce prospect ? »
 * a un sens en R5 : deux choses connues sont comparées, un prospect déjà en base
 * et un site que nous venons de lire. Aucun seuil n'est touché, aucune variante
 * n'est appelée (§7).
 *
 * Le raisonnement circulaire est écarté par construction : `domainOrigin` vaut
 * `observed` parce que ce domaine a été *vu* proposé par un index pour ce
 * métier et cette zone, et non fabriqué à partir du nom du prospect.
 *
 * Un refus n'est pas un rejet du candidat — c'est le refus de le confondre avec
 * un prospect existant. Le rail crée alors une entreprise distincte et laisse
 * un candidat de fusion à arbitrer.
 */
async function verifyAgainstExisting(
  deps: CommercialRailDeps,
  domain: string,
  identity: BusinessIdentity,
  probe: DomainProbe,
): Promise<VerificationOutcome> {
  const owner = await deps.repo.findByIdentityKey(deps.campaignId, 'domain', domain);
  // Le domaine est une clé décisive : si un prospect le porte déjà, c'est lui.
  if (owner) return { blockedMerge: false, verdicts: [] };

  const nearby = await deps.repo.findVerificationCandidates(deps.campaignId, {
    city: identity.city,
    postalCode: identity.postalCode,
    latitude: null,
    longitude: null,
  });
  if (nearby.length === 0) return { blockedMerge: false, verdicts: [] };

  const verdicts: VerificationOutcome['verdicts'] = [];
  let confusable = 0;
  let anyAttachable = false;

  /**
   * Qui pourrait être confondu avec cette entreprise ?
   *
   * La sélection se fait sur le nom, avant de demander son avis au vérificateur,
   * et l'ordre importe. Un verdict `rejected` ne dit pas la même chose selon le
   * prospect auquel il s'applique : sur une entreprise sans rapport, c'est du
   * bruit ; sur un prospect qui porte le même nom dans la même ville, c'est un
   * refus argumenté — typiquement « le site publie une autre identité légale ».
   * Ne garder que les seconds est ce qui donne un sens au blocage.
   */
  const businessName = identity.name ?? '';

  for (const prospect of nearby) {
    const resemblance = Math.max(
      nameSimilarity(businessName, prospect.display_name),
      nameSimilarity(businessName, prospect.brand_name ?? ''),
    );
    if (resemblance < NAME_AGREEMENT_FLOOR) continue;
    confusable += 1;

    const verdict = verifyIdentity({
      prospect: {
        displayName: prospect.display_name,
        brandName: prospect.brand_name,
        legalName: prospect.legal_name,
        registryId: prospect.registry_id,
        city: prospect.city,
        postalCode: prospect.postal_code,
        phone: prospect.phone,
      },
      candidateDomain: domain,
      domainOrigin: 'observed',
      finalDomain: probe.finalDomain,
      httpStatus: probe.httpStatus,
      siteName: identity.name,
      pageText: identity.pageText,
      registryIdsOnSite: identity.registryId ? { sirens: [identity.registryId], sirets: [] } : { sirens: [], sirets: [] },
      observed: {
        phones: identity.phone ? [identity.phone] : [],
        emails: identity.email ? [identity.email] : [],
      },
      nicheTermsFound: identity.nicheTermsFound,
    });

    verdicts.push({ prospectId: prospect.id, displayName: prospect.display_name, verdict });
    if (isAttachable(verdict)) anyAttachable = true;
  }

  /**
   * Le blocage ne s'arme que si un prospect proche a *failli* correspondre.
   * Sans candidat confondable, il n'y a rien à protéger, et bloquer le
   * rapprochement flou empêcherait des fusions légitimes que rien ne conteste.
   */
  const blockedMerge = confusable > 0 && !anyAttachable;
  return { blockedMerge, verdicts };
}

/**
 * L'entreprise, telle que SON SITE la décrit.
 *
 * Chaque champ vient d'une page que nous avons ouverte. `observationMethod:
 * 'crawl'` le dit à `recordEvidenceFromBusiness`, pour que la provenance
 * inscrite sur chaque evidence soit exacte plutôt que commode.
 */
function toDiscoveredBusiness(
  candidate: CommercialBusinessCandidate,
  identity: BusinessIdentity,
  probe: DomainProbe,
): DiscoveredBusiness {
  const siteUrl = normalizeUrl(probe.finalUrl ?? `https://${candidate.domain}/`);
  const name = identity.name ?? provisionalName(candidate);

  const business: DiscoveredBusiness = {
    provider: COMMERCIAL_EVIDENCE_PROVIDER,
    externalId: candidate.domain,
    sourceUrl: siteUrl,
    observedAt: new Date().toISOString(),
    observationMethod: 'crawl',
    name,
    legalName: identity.legalName,
    brandName: identity.name,
    registryId: identity.registryId,
    country: 'FR',
    addressLine: identity.addressLine,
    postalCode: identity.postalCode,
    city: identity.city,
    department: identity.department,
    websiteUrl: siteUrl,
    phone: identity.phone,
    email: identity.email,
    instagramHandle: identity.instagramHandle ?? candidate.instagramHandle,
    facebookUrl: identity.facebookUrl ?? candidate.facebookUrl,
    attributes: {
      commercialDiscovery: {
        groupingKey: candidate.key,
        zones: candidate.zones,
        terms: candidate.terms,
        bestRank: candidate.bestRank,
        sightings: candidate.sightings.length,
      },
    },
    raw: null,
  };

  // Dernière ligne de défense : rien de ce que le moteur a écrit ne doit
  // atteindre une table, quel que soit le chemin emprunté.
  assertNoSearchResultContent(business as unknown as Record<string, unknown>, 'commercial.to_business');
  return business;
}

/**
 * Écrit pourquoi cette entreprise est entrée dans le corpus.
 *
 * Une ligne d'evidence dédiée, parce que « d'où sort ce prospect » doit rester
 * lisible dans six mois : quelles zones, quels termes, quel rang, et ce que le
 * site a déclaré de lui-même. Aucun titre ni extrait de résultat — seulement
 * notre question et notre lecture.
 */
async function writeDiscoveryEvidence(
  deps: CommercialRailDeps,
  prospectId: string,
  candidate: CommercialBusinessCandidate,
  identity: BusinessIdentity,
  probe: DomainProbe,
  verdicts: VerificationOutcome['verdicts'],
): Promise<void> {
  const sourceUrl = probe.finalUrl ?? (candidate.domain ? `https://${candidate.domain}/` : null);
  const observedAt = (deps.now ?? ((): Date => new Date()))().toISOString();

  const valueJson = {
    rail: COMMERCIAL_RAIL,
    groupingKey: candidate.key,
    zones: candidate.zones,
    terms: candidate.terms,
    bestRank: candidate.bestRank,
    sightings: candidate.sightings.map((sighting) => ({
      tier: sighting.tier,
      zone: sighting.zone,
      term: sighting.term,
      rank: sighting.rank,
      kind: sighting.kind,
    })),
    leads: candidate.leads.map((lead) => ({ kind: lead.kind, domain: lead.domain })),
    declarations: identity.declarations,
    identityReview: identity.review,
    identityConfidence: identity.confidence,
    nicheTermsFound: identity.nicheTermsFound,
    verifiedAgainst: verdicts.map((entry) => ({
      prospectId: entry.prospectId,
      displayName: entry.displayName,
      verdict: entry.verdict.verdict,
      confidence: Number(entry.verdict.confidence.toFixed(3)),
      homonymRisk: entry.verdict.homonymRisk,
    })),
  };
  assertNoSearchResultContent(valueJson as unknown as Record<string, unknown>, 'commercial.discovery_evidence');

  await deps.repo.addEvidence(prospectId, {
    field: 'commercial_discovery',
    valueText: `${candidate.zones.join(', ')} — ${candidate.terms.slice(0, 3).join(', ')} (rang ${candidate.bestRank})`,
    valueJson,
    provider: COMMERCIAL_ORIGIN_PROVIDER,
    method: 'derived',
    sourceUrl,
    confidence: 1,
    observedAt,
  });

  if (identity.declarations.length > 0) {
    await deps.repo.addEvidence(prospectId, {
      field: 'site_identity_declarations',
      valueText: identity.declarations.join(' ; '),
      valueJson: { declarations: identity.declarations, review: identity.review },
      provider: COMMERCIAL_EVIDENCE_PROVIDER,
      method: 'crawl',
      sourceUrl,
      confidence: identity.confidence,
      observedAt,
    });
  }
}

/**
 * Lit le parcours commercial et l'écrit.
 *
 * Le crawl passe par le worker distant quand il est joignable — il rend les
 * pages en JavaScript, ce que beaucoup de sites de artisans exigent — et
 * directement sinon. Les deux chemins traversent la même extraction, donc la
 * synthèse est comparable d'un prospect à l'autre.
 *
 * Le repli sur les pages déjà sondées n'est pas cosmétique : quand les deux
 * crawls échouent, nous avons quand même lu l'accueil et les mentions légales.
 * Analyser ces pages-là plutôt que rien fait la différence entre « parcours non
 * observé » et une observation partielle mais réelle.
 */
async function readFunnel(
  deps: CommercialRailDeps,
  prospectId: string,
  probe: DomainProbe,
  identity: BusinessIdentity,
): Promise<FunnelSynthesis> {
  const websiteUrl = probe.finalUrl ?? `https://${probe.domain}/`;
  const maxPages = deps.campaign.enrichment.maxPagesPerSite;

  let facts = identity.facts;
  let sourceUrl = websiteUrl;

  const remote = deps.webintel
    ? await crawlViaWebIntel(deps.webintel, deps.logger, websiteUrl, deps.niche, maxPages)
    : null;
  const crawl = remote ?? (await safeDirectCrawl(deps, websiteUrl, maxPages));

  if (crawl && crawl.facts.length > 0) {
    facts = crawl.facts;
    sourceUrl = crawl.pagesCrawled[0] ?? websiteUrl;
    for (const item of crawl.evidence) await deps.repo.addEvidence(prospectId, item);
    await deps.repo.fillMissingColumns(prospectId, {
      email: crawl.contact.email,
      phone: crawl.contact.phone,
      instagram_handle: crawl.contact.instagramHandle,
      facebook_url: crawl.contact.facebookUrl,
    });
  }

  const synthesis = analyseFunnel(facts, deps.niche);
  const evidence = funnelEvidence(synthesis, sourceUrl);
  if (evidence) {
    await deps.repo.addEvidence(prospectId, evidence);
    await deps.repo.saveFunnelSynthesis(prospectId, {
      summary: synthesis.summary,
      opportunityCount: synthesis.opportunitySignals.length,
    });
  }
  return synthesis;
}

async function safeDirectCrawl(
  deps: CommercialRailDeps,
  websiteUrl: string,
  maxPages: number,
): Promise<Awaited<ReturnType<typeof crawlWebsite>> | null> {
  try {
    return await crawlWebsite(deps.http, websiteUrl, deps.niche, deps.logger, maxPages);
  } catch (error) {
    deps.logger.warn('commercial.crawl_failed', {
      url: websiteUrl,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Le verdict de niche, par les règles seules.
 *
 * Aucun appel de modèle ici, et c'est délibéré : le rail est un outil de
 * découverte dont le coût doit rester prévisible, et `campaign:run` sait déjà
 * arbitrer les cas ambigus avec le LLM sur le corpus consolidé. Ce que le rail
 * doit garantir, c'est de ne pas promouvoir un garage.
 */
async function classifyAndStore(deps: CommercialRailDeps, prospect: ProspectRow): Promise<string> {
  const evidence = await deps.repo.evidenceFor(prospect.id);
  const deterministic = classifyDeterministic(prospect, evidence, deps.niche);

  const reasons = [
    deterministic.positiveHits.length > 0 ? `termes de niche : ${deterministic.positiveHits.join(', ')}` : null,
    deterministic.negativeHits.length > 0 ? `termes d'exclusion : ${deterministic.negativeHits.join(', ')}` : null,
  ].filter((value): value is string => value !== null);

  await deps.sql.query(
    `insert into prospect_classifications
       (prospect_id, verdict, confidence, decided_by, reasons, evidence_refs, model_run_id)
     values ($1,$2,$3,'deterministic',$4,$5,null)`,
    [
      prospect.id,
      deterministic.verdict,
      deterministic.confidence,
      JSON.stringify(reasons),
      JSON.stringify(evidence.slice(0, 30).map((item) => item.id)),
    ],
  );
  await deps.sql.query(
    'update prospects set niche_verdict = $2, niche_confidence = $3, updated_at = now() where id = $1',
    [prospect.id, deterministic.verdict, deterministic.confidence],
  );

  return deterministic.verdict;
}

/** Une ligne par entreprise candidate, promue ou non. Le rail doit dire où il fuit. */
async function persistCandidate(
  deps: CommercialRailDeps,
  candidate: CommercialBusinessCandidate,
  outcome: CommercialCandidateOutcome,
  status: 'discovered' | 'probed' | 'promoted' | 'rejected',
): Promise<void> {
  await deps.sql.query(
    `insert into commercial_business_candidates
       (campaign_id, run_id, prospect_id, grouping_key, form, provisional_name, domain, site_url,
        instagram_handle, facebook_url, sightings, best_rank, zones, terms, leads,
        probed_at, http_status, final_domain, robots_disallowed,
        declared_name, declared_city, declared_postal_code, registry_id_on_site,
        identity_confidence, needs_manual_identity, niche_terms_found, in_zone, status, reject_reason, last_checked_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
             $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29, now())
     on conflict (campaign_id, grouping_key) do update
       set prospect_id = coalesce(excluded.prospect_id, commercial_business_candidates.prospect_id),
           sightings = excluded.sightings,
           best_rank = excluded.best_rank,
           zones = excluded.zones,
           terms = excluded.terms,
           leads = excluded.leads,
           probed_at = excluded.probed_at,
           http_status = excluded.http_status,
           final_domain = excluded.final_domain,
           robots_disallowed = excluded.robots_disallowed,
           declared_name = excluded.declared_name,
           declared_city = excluded.declared_city,
           declared_postal_code = excluded.declared_postal_code,
           registry_id_on_site = excluded.registry_id_on_site,
           identity_confidence = excluded.identity_confidence,
           needs_manual_identity = excluded.needs_manual_identity,
           niche_terms_found = excluded.niche_terms_found,
           in_zone = excluded.in_zone,
           status = excluded.status,
           reject_reason = excluded.reject_reason,
           last_checked_at = now()`,
    [
      deps.campaignId,
      deps.runId,
      outcome.prospectId,
      candidate.key,
      candidate.form,
      outcome.provisionalName,
      candidate.domain,
      candidate.siteUrl,
      candidate.instagramHandle,
      candidate.facebookUrl,
      outcome.sightings,
      outcome.bestRank,
      JSON.stringify(candidate.zones),
      JSON.stringify(candidate.terms),
      JSON.stringify(candidate.leads),
      outcome.probed ? new Date().toISOString() : null,
      outcome.httpStatus,
      null,
      false,
      outcome.declaredName,
      outcome.declaredCity,
      null,
      outcome.registryIdOnSite,
      outcome.identityConfidence,
      outcome.identityReview === 'manual_review' || outcome.identityReview === 'uncertain',
      JSON.stringify(outcome.nicheTerms),
      outcome.inZone,
      status,
      outcome.rejectReason,
    ],
  );
}
