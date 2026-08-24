import { buildQueryPlan, shouldStopEscalating, type PlannedQuery } from '@/lib/discovery/search/queryPlan';
import { classifyHits, matchSocialProfile, type SearchCandidate } from '@/lib/discovery/search/classify';
import { SearchBudget, SearchBudgetExceededError } from '@/lib/discovery/search/budget';
import { assertNoSearchResultContent } from '@/lib/discovery/search/terms';
import { probeAndVerify } from '@/lib/discovery/openweb/railOpenWeb';
import { isAttachable, type IdentityVerdictLevel } from '@/lib/discovery/openweb/identityVerify';
import { hasUsableMentions } from '@/lib/discovery/openweb/legalMentions';
import { SearchProviderError, classifySearchFailure, type WebSearchProvider } from '@/lib/enrichment/webSearch';
import { ProviderUnavailableError, type ProviderScheduler } from '@/lib/http/scheduler';
import { identityKeys } from '@/lib/identity/resolve';
import { normalizeUrl } from '@/lib/identity/normalize';
import type { NicheConfig } from '@/lib/config/schema';
import type { HttpClient } from '@/lib/http/client';
import type { Logger } from '@/lib/logging/logger';
import type { ProspectRepository } from '@/lib/repo/prospects';
import type { ProspectRow } from '@/lib/repo/types';
import type { DnsResolver } from '@/lib/discovery/openweb/domainVerify';
import type { Sql } from '@/lib/db/sql';

/**
 * Rail C — l'index web payant.
 *
 * Le trajet d'un prospect, et le point important est ce qui N'Y figure pas :
 *
 *   nom + ville
 *        │  plan de requêtes borné, escalade seulement si nécessaire (§4)
 *        ▼
 *   Brave  ──────────►  résultats, EN MÉMOIRE, jamais écrits (§ terms.ts)
 *        │
 *        │  filtre annuaire / plateforme / bruit (§6)
 *        ▼
 *   candidats de site propre  +  candidats sociaux (§7)
 *        │
 *        │  ◄── ici le rail s'arrête de faire confiance au moteur
 *        ▼
 *   probeAndVerify() — LE VÉRIFICATEUR R3, INCHANGÉ (§5)
 *        │  DNS → HTTP → redirection → HTML → mentions légales → identité
 *        ▼
 *   confirmed / probable / uncertain / rejected
 *        │  seul `confirmed`, ou `probable` sans risque d'homonymie, rattache
 *        ▼
 *   WebIntel, par l'appelant (§8)
 *
 * Trois choix méritent d'être défendus.
 *
 * **Le moteur ne rattache rien.** Il propose des URLs et c'est tout. Le verdict
 * vient de `probeAndVerify`, dont ce fichier n'appelle aucune variante et ne
 * modifie aucun seuil. La raison est mesurée plutôt que théorique : R3 a rejeté
 * 74,3 % des candidats qui résolvaient, et c'est cette sévérité qui fait qu'un
 * domaine rattaché signifie quelque chose. Un rail qui l'assouplirait pour
 * améliorer son taux de résolution rendrait son propre chiffre inutilisable.
 *
 * **Un domaine venu du moteur est `observed`, jamais `generated`.** La
 * distinction est celle de `identityVerify.ts` : le cœur d'un domaine fabriqué
 * depuis le nom du prospect ne peut pas servir d'indice sur ce nom, sous peine
 * de raisonnement circulaire. Un domaine que Brave a associé à cette
 * entreprise a, lui, été vu quelque part par quelqu'un — il a donc le droit de
 * compter comme indice. C'est précisément ce que le rail achète.
 *
 * **Une requête refusée par le budget arrête le prospect, pas le run.** Sauf si
 * le motif est l'authentification : une clé refusée le restera pour les 52
 * suivants, et payer 52 refus pour l'apprendre serait absurde.
 */

export const SEARCH_PROVIDER_QUEUE = 'web_search';

/**
 * Un candidat, augmenté du texte qui a servi à le juger.
 *
 * `socialContext` est le titre et la description du résultat, concaténés. Il
 * n'existe que le temps d'un prospect et n'a aucun chemin vers la base : c'est
 * l'exception « transient storage required for operation » des conditions Brave,
 * tenue par la portée du type plutôt que par une convention. Le champ est
 * volontairement absent de `SearchCandidate`, qui est le type que les fonctions
 * de persistance manipulent.
 */
interface RankedCandidate extends SearchCandidate {
  socialContext: string;
}

/**
 * Cadence du moteur.
 *
 * Le plan Brave « Search » annonce 50 requêtes par seconde, très au-delà de nos
 * besoins : le facteur limitant ici n'est pas le débit autorisé mais notre
 * volonté de ne pas transformer une boucle en facture. Une requête à la fois,
 * espacée, et un repos net au troisième échec consécutif — au troisième, parce
 * qu'un refus d'authentification ou de quota se reconnaît en bien moins que ça
 * et remonte par une autre voie.
 */
export function searchSchedulerLimits(): Record<string, Partial<import('@/lib/http/scheduler').ProviderLimits>> {
  return {
    [SEARCH_PROVIDER_QUEUE]: {
      concurrency: 1,
      minIntervalMs: 1_200,
      jitterMs: 300,
      failureThreshold: 3,
      cooldownMs: 120_000,
    },
  };
}

export interface SearchRailDeps {
  sql: Sql;
  repo: ProspectRepository;
  http: HttpClient;
  logger: Logger;
  niche: NicheConfig;
  scheduler: ProviderScheduler;
  provider: WebSearchProvider;
  budget: SearchBudget;
  campaignId: string;
  runId: string | null;
  resolver?: DnsResolver;
  now?: () => Date;
}

export interface SearchRailOptions {
  /** Variantes de requête au plus, par prospect. */
  maxQueriesPerProspect?: number;
  /** Résultats demandés par requête. Brave plafonne à 20. */
  resultsPerQuery?: number;
  /** Candidats de site réellement sondés, par prospect. */
  maxCandidatesPerProspect?: number;
  /** Écrire le résultat. `false` = mesure seule. */
  persist?: boolean;
  /** Ne pas reposer une requête déjà posée pour ce prospect lors d'un run précédent. */
  skipAlreadyAsked?: boolean;
}

export interface SearchQueryOutcome {
  variant: string;
  query: string;
  /** Émise, ou évitée avec son motif. */
  issued: boolean;
  avoidedReason: string | null;
  /** Résultats bruts renvoyés par le moteur. */
  resultsCount: number;
  /**
   * Résultats après déduplication par domaine.
   *
   * Distinct de `resultsCount`, et il faut les deux : un moteur qui renvoie
   * quatre pages du même annuaire a renvoyé quatre résultats et un seul
   * candidat. Confondre les deux ferait paraître le bruit plus faible qu'il
   * n'est, puisque le dénominateur inclurait des doublons que le filtre a déjà
   * écartés. C'est le dénominateur des taux du §16.
   */
  classifiedCandidates: number;
  ownSiteCandidates: number;
  directoryResults: number;
  socialResults: number;
  noiseResults: number;
  latencyMs: number | null;
  error: string | null;
}

export interface SearchCandidateOutcome {
  domain: string;
  /** Rang auquel le moteur l'a proposé. Mesure de pertinence (§16). */
  rank: number;
  variant: string;
  dnsResolved: boolean;
  httpStatus: number | null;
  verdict: IdentityVerdictLevel;
  confidence: number;
  homonymRisk: boolean;
  attached: boolean;
  rejectReason: string | null;
}

export interface SearchProspectOutcome {
  prospectId: string;
  displayName: string;
  hadWebsiteBefore: boolean;
  queries: SearchQueryOutcome[];
  candidates: SearchCandidateOutcome[];
  attachedDomain: string | null;
  attachedVerdict: IdentityVerdictLevel | null;
  /** Rang du résultat finalement confirmé. Le nombre qui dit si le moteur est bon. */
  attachedRank: number | null;
  instagramAttached: string | null;
  facebookAttached: string | null;
  socialRejected: string[];
  registryIdResolved: string | null;
  domainCollisionWith: string | null;
  errors: string[];
  durationMs: number;
}

function emptyOutcome(prospect: ProspectRow): SearchProspectOutcome {
  return {
    prospectId: prospect.id,
    displayName: prospect.display_name,
    hadWebsiteBefore: prospect.website_url !== null,
    queries: [],
    candidates: [],
    attachedDomain: null,
    attachedVerdict: null,
    attachedRank: null,
    instagramAttached: null,
    facebookAttached: null,
    socialRejected: [],
    registryIdResolved: null,
    domainCollisionWith: null,
    errors: [],
    durationMs: 0,
  };
}

/**
 * Requêtes déjà posées pour ce prospect, tous runs confondus.
 *
 * C'est la seule mémoire que nous ayons le droit d'avoir du moteur, et elle
 * porte sur nos questions, pas sur ses réponses. Elle suffit pourtant à ne pas
 * repayer : une requête qui n'a rien donné hier ne donnera rien de plus
 * aujourd'hui, et le web bouge moins vite qu'un budget.
 */
export async function alreadyAskedVariants(
  sql: Sql,
  provider: string,
  prospectId: string,
): Promise<Set<string>> {
  const rows = await sql.query<{ query_variant: string }>(
    `select distinct query_variant from search_provider_usage
      where provider = $1 and prospect_id = $2 and billable = true and error is null`,
    [provider, prospectId],
  );
  return new Set(rows.map((row) => row.query_variant));
}

/**
 * Résout un prospect par la recherche web.
 *
 * S'arrête au premier domaine rattachable, comme le rail R3 : un deuxième site
 * pour la même entreprise n'existe presque jamais et coûterait des requêtes.
 */
export async function resolveProspectViaSearch(
  deps: SearchRailDeps,
  prospect: ProspectRow,
  options: SearchRailOptions = {},
): Promise<SearchProspectOutcome> {
  const startedAt = Date.now();
  const outcome = emptyOutcome(prospect);
  const persist = options.persist !== false;
  const maxQueries = options.maxQueriesPerProspect ?? 3;
  const resultsPerQuery = options.resultsPerQuery ?? 10;
  const maxCandidates = options.maxCandidatesPerProspect ?? 3;

  const availability = deps.provider.availability();
  if (!availability.ok) {
    outcome.errors.push(availability.reason ?? 'fournisseur indisponible');
    outcome.durationMs = Date.now() - startedAt;
    return outcome;
  }

  /**
   * Ce que le rail achète, c'est un site que nous ne connaissions pas. Un
   * prospect qui en a déjà un n'a donc rien à acheter, et la requête ne pourrait
   * que confirmer ce que nous savons.
   *
   * Les profils sociaux ne changent pas ce raisonnement, et c'est délibéré : ils
   * sont récoltés sur des pages de résultats que nous payions de toute façon,
   * jamais une raison d'en payer une. Un Instagram absent se trouve gratuitement
   * en lisant le site, ce que WebIntel fait déjà à l'étape suivante.
   */
  if (prospect.domain !== null || prospect.website_url !== null) {
    outcome.errors.push('site déjà connu : aucune requête à acheter');
    outcome.durationMs = Date.now() - startedAt;
    return outcome;
  }

  const plan = buildQueryPlan(
    {
      displayName: prospect.display_name,
      brandName: prospect.brand_name,
      legalName: prospect.legal_name,
      city: prospect.city,
      addressLine: prospect.address_line,
    },
    deps.niche,
    { maxQueries, postalCode: prospect.postal_code },
  );

  if (plan.length === 0) {
    outcome.errors.push('nom trop peu distinctif pour valoir une requête');
    outcome.durationMs = Date.now() - startedAt;
    return outcome;
  }

  const asked = options.skipAlreadyAsked === false
    ? new Set<string>()
    : await alreadyAskedVariants(deps.sql, deps.provider.name, prospect.id);

  // ------------------------------------------------------------- recherche
  const siteCandidates: RankedCandidate[] = [];
  const socialCandidates: RankedCandidate[] = [];
  const seenDomains = new Set<string>();

  for (const planned of plan) {
    if (shouldStopEscalating({ websiteCandidates: siteCandidates.length, socialCandidates: socialCandidates.length })) {
      await recordAvoided(deps, prospect, planned, outcome, 'candidat de site déjà trouvé par une variante précédente');
      continue;
    }
    if (asked.has(planned.variant)) {
      await recordAvoided(deps, prospect, planned, outcome, 'variante déjà posée lors d’un run précédent');
      continue;
    }
    if (deps.budget.exhausted) {
      await recordAvoided(deps, prospect, planned, outcome, deps.budget.stopReason?.message ?? 'budget épuisé');
      continue;
    }

    const result = await issueQuery(deps, prospect, planned, resultsPerQuery, outcome);
    if (result === 'fatal') {
      outcome.durationMs = Date.now() - startedAt;
      return outcome;
    }
    if (result === 'stop') break;

    for (const candidate of result) {
      if (candidate.kind === 'own_site' && candidate.domain && !seenDomains.has(candidate.domain)) {
        seenDomains.add(candidate.domain);
        siteCandidates.push(candidate);
      } else if (candidate.kind === 'social') {
        socialCandidates.push(candidate);
      }
    }
  }

  // ------------------------------------------- vérification, par le code de R3
  /**
   * Ordre de sondage : le rang du moteur.
   *
   * Nous n'avons aucune raison de croire que notre propre tri ferait mieux que
   * celui d'un index web sur la pertinence — et le mesurer suppose justement de
   * ne pas le remplacer. `attachedRank` dira ensuite à quel rang la vérité se
   * trouvait, ce qui est la mesure demandée au §16.
   */
  const ordered = [...siteCandidates].sort((left, right) => left.rank - right.rank);

  for (const candidate of ordered.slice(0, maxCandidates)) {
    if (outcome.attachedDomain || !candidate.domain) break;

    let bundle: Awaited<ReturnType<typeof probeAndVerify>>;
    try {
      bundle = await probeAndVerify(deps, prospect, candidate.domain, 'observed', null);
    } catch (error) {
      outcome.errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }

    const attachable = isAttachable(bundle.verdict);
    const candidateOutcome: SearchCandidateOutcome = {
      domain: candidate.domain,
      rank: candidate.rank,
      variant: candidate.variant,
      dnsResolved: bundle.probe.dnsResolved,
      httpStatus: bundle.probe.httpStatus,
      verdict: bundle.verdict.verdict,
      confidence: Number(bundle.verdict.confidence.toFixed(3)),
      homonymRisk: bundle.verdict.homonymRisk,
      attached: false,
      rejectReason: bundle.verdict.rejectReason,
    };

    if (attachable) {
      const attachDomain = bundle.probe.finalDomain ?? candidate.domain;
      const websiteUrl = normalizeUrl(bundle.probe.finalUrl ?? `https://${attachDomain}/`);

      const owner = await deps.repo.findByIdentityKey(deps.campaignId, 'domain', attachDomain);
      if (owner && owner !== prospect.id) {
        outcome.domainCollisionWith = owner;
        if (persist) {
          await deps.repo.recordMergeCandidate(deps.campaignId, prospect.id, owner, bundle.verdict.confidence, {
            reason: 'même domaine résolu par le rail de recherche',
            domain: attachDomain,
            verdict: bundle.verdict.verdict,
          });
        }
      }

      if (persist) {
        await attachSearchResolution(deps, prospect, bundle, attachDomain, websiteUrl, candidate);
      }

      candidateOutcome.attached = true;
      outcome.attachedDomain = attachDomain;
      outcome.attachedVerdict = bundle.verdict.verdict;
      outcome.attachedRank = candidate.rank;
      const registryIdOnSite = bundle.registryIdsOnSite.sirens[0] ?? null;
      if (!prospect.registry_id && registryIdOnSite) outcome.registryIdResolved = registryIdOnSite;
    }

    outcome.candidates.push(candidateOutcome);
    if (persist) await persistSearchCandidate(deps, prospect, candidate, bundle, candidateOutcome);
  }

  // ------------------------------------------------------------------ social
  await attachSocials(deps, prospect, socialCandidates, outcome, persist);

  outcome.durationMs = Date.now() - startedAt;
  return outcome;
}

/** Émet une requête, ou explique pourquoi elle n'a rien pu produire. */
async function issueQuery(
  deps: SearchRailDeps,
  prospect: ProspectRow,
  planned: PlannedQuery,
  resultsPerQuery: number,
  outcome: SearchProspectOutcome,
): Promise<RankedCandidate[] | 'stop' | 'fatal'> {
  try {
    await deps.budget.assertCanSpend();
  } catch (error) {
    if (error instanceof SearchBudgetExceededError) {
      await recordAvoided(deps, prospect, planned, outcome, error.message);
      return 'stop';
    }
    throw error;
  }

  const startedAt = Date.now();
  let hits: Awaited<ReturnType<WebSearchProvider['search']>>;
  try {
    hits = await deps.scheduler.run(SEARCH_PROVIDER_QUEUE, () =>
      deps.provider.search(planned.query, resultsPerQuery),
    );
  } catch (error) {
    const latencyMs = Date.now() - startedAt;

    if (error instanceof ProviderUnavailableError) {
      await recordAvoided(deps, prospect, planned, outcome, error.message);
      return 'stop';
    }

    const failure = error instanceof SearchProviderError ? error : classifySearchFailure(error, deps.provider.name);

    /**
     * Un échec d'authentification ou de quota n'est pas facturé : rien n'a été
     * servi. Le consigner comme facturable ferait mentir le registre de dépense
     * dans le sens qui compte — celui qui gonfle le coût annoncé.
     */
    await deps.budget.record({
      provider: deps.provider.name,
      query: planned.query,
      queryVariant: planned.variant,
      prospectId: prospect.id,
      resultsCount: 0,
      candidatesKept: 0,
      avoided: false,
      avoidedReason: null,
      billable: failure.kind !== 'auth' && failure.kind !== 'quota',
      httpStatus: failure.status,
      latencyMs,
      error: `${failure.kind}: ${failure.message}`,
    });

    outcome.queries.push({
      variant: planned.variant,
      query: planned.query,
      issued: true,
      avoidedReason: null,
      resultsCount: 0,
      classifiedCandidates: 0,
      ownSiteCandidates: 0,
      directoryResults: 0,
      socialResults: 0,
      noiseResults: 0,
      latencyMs,
      error: `${failure.kind}: ${failure.message}`,
    });
    outcome.errors.push(`${failure.kind}: ${failure.message}`);

    deps.logger.warn('search.query_failed', {
      provider: deps.provider.name,
      kind: failure.kind,
      variant: planned.variant,
    });

    // Une clé refusée le restera pour tout le corpus : le rail rend la main au
    // benchmark, qui décidera d'arrêter le run entier.
    if (failure.fatal) return 'fatal';
    return 'stop';
  }

  const latencyMs = Date.now() - startedAt;
  const candidates = classifyHits(hits, planned.variant);
  const own = candidates.filter((candidate) => candidate.kind === 'own_site');

  await deps.budget.record({
    provider: deps.provider.name,
    query: planned.query,
    queryVariant: planned.variant,
    prospectId: prospect.id,
    resultsCount: hits.length,
    candidatesKept: own.length,
    avoided: false,
    avoidedReason: null,
    billable: true,
    httpStatus: 200,
    latencyMs,
    error: null,
  });

  outcome.queries.push({
    variant: planned.variant,
    query: planned.query,
    issued: true,
    avoidedReason: null,
    resultsCount: hits.length,
    classifiedCandidates: candidates.length,
    ownSiteCandidates: own.length,
    directoryResults: candidates.filter((candidate) => candidate.kind === 'directory').length,
    socialResults: candidates.filter((candidate) => candidate.kind === 'social').length,
    noiseResults: candidates.filter((candidate) => candidate.kind === 'noise').length,
    latencyMs,
    error: null,
  });

  /**
   * Les titres et descriptions servent au rapprochement social puis
   * disparaissent avec la portée de cette fonction. Rien ne les écrit : c'est
   * l'exception « transient storage required for operation » et non une
   * tolérance élargie.
   */
  return candidates.map((candidate): RankedCandidate => {
    const hit = hits[candidate.rank - 1];
    return {
      ...candidate,
      socialContext: hit ? `${hit.title} ${hit.snippet}` : '',
    };
  });
}

async function recordAvoided(
  deps: SearchRailDeps,
  prospect: ProspectRow,
  planned: PlannedQuery,
  outcome: SearchProspectOutcome,
  reason: string,
): Promise<void> {
  await deps.budget.record({
    provider: deps.provider.name,
    query: planned.query,
    queryVariant: planned.variant,
    prospectId: prospect.id,
    resultsCount: 0,
    candidatesKept: 0,
    avoided: true,
    avoidedReason: reason,
    billable: false,
    httpStatus: null,
    latencyMs: null,
    error: null,
  });

  outcome.queries.push({
    variant: planned.variant,
    query: planned.query,
    issued: false,
    avoidedReason: reason,
    resultsCount: 0,
    classifiedCandidates: 0,
    ownSiteCandidates: 0,
    directoryResults: 0,
    socialResults: 0,
    noiseResults: 0,
    latencyMs: null,
    error: null,
  });
}

/**
 * Rattache les profils sociaux qui résistent au rapprochement.
 *
 * Le contexte utilisé pour corroborer (titre, description) est transitoire ; ce
 * qui est écrit est le handle, c'est-à-dire une identité publique que nous avons
 * décidé d'attribuer, avec la raison du rapprochement.
 */
async function attachSocials(
  deps: SearchRailDeps,
  prospect: ProspectRow,
  socials: RankedCandidate[],
  outcome: SearchProspectOutcome,
  persist: boolean,
): Promise<void> {
  const observedAt = (deps.now ?? (() => new Date()))().toISOString();

  for (const candidate of socials) {
    const handle = candidate.instagramHandle;
    if (handle && !prospect.instagram_handle && !outcome.instagramAttached) {
      const match = matchSocialProfile({
        prospect: {
          displayName: prospect.display_name,
          brandName: prospect.brand_name,
          city: prospect.city,
          phone: prospect.phone,
          domain: outcome.attachedDomain ?? prospect.domain,
        },
        handle,
        context: candidate.socialContext,
      });

      if (!match.attachable) {
        outcome.socialRejected.push(match.reason);
        continue;
      }

      outcome.instagramAttached = handle;
      if (persist) {
        const columns = { instagram_handle: handle };
        assertNoSearchResultContent(columns, 'search.attach_instagram');
        await deps.repo.addEvidence(prospect.id, {
          field: 'instagram_handle',
          valueText: handle,
          valueJson: { nameScore: match.nameScore, corroboration: match.corroboration },
          provider: 'search',
          // Un appel d'API, au sens du vocabulaire de provenance : ni un crawl
          // que nous aurions fait, ni une déduction.
          method: 'api',
          sourceUrl: `https://www.instagram.com/${handle}/`,
          confidence: match.nameScore,
          observedAt,
        });
        await deps.repo.fillMissingColumns(prospect.id, columns);
      }
      continue;
    }

    const facebookUrl = candidate.facebookUrl;
    if (facebookUrl && !prospect.facebook_url && !outcome.facebookAttached) {
      const slug = facebookUrl.split('/').filter(Boolean).pop() ?? '';
      const match = matchSocialProfile({
        prospect: {
          displayName: prospect.display_name,
          brandName: prospect.brand_name,
          city: prospect.city,
          phone: prospect.phone,
          domain: outcome.attachedDomain ?? prospect.domain,
        },
        handle: slug,
        context: candidate.socialContext,
      });

      if (!match.attachable) {
        outcome.socialRejected.push(match.reason);
        continue;
      }

      outcome.facebookAttached = facebookUrl;
      if (persist) {
        const columns = { facebook_url: facebookUrl };
        assertNoSearchResultContent(columns, 'search.attach_facebook');
        await deps.repo.addEvidence(prospect.id, {
          field: 'facebook_url',
          valueText: facebookUrl,
          valueJson: { nameScore: match.nameScore, corroboration: match.corroboration },
          provider: 'search',
          // Un appel d'API, au sens du vocabulaire de provenance : ni un crawl
          // que nous aurions fait, ni une déduction.
          method: 'api',
          sourceUrl: facebookUrl,
          confidence: match.nameScore,
          observedAt,
        });
        await deps.repo.fillMissingColumns(prospect.id, columns);
      }
    }
  }
}

/**
 * Écrit ce que NOUS avons lu sur le site.
 *
 * La provenance est `open_web` avec l'URL du site pour source, pas `brave` avec
 * une page de résultats : c'est notre crawl qui a établi le fait, le moteur a
 * seulement indiqué où regarder. La distinction est celle des conditions
 * d'utilisation, et elle est aussi la plus honnête des deux.
 *
 * `search_pointer` conserve la trace du rail qui a mené là — sans titre, sans
 * description, sans URL de résultat.
 */
async function attachSearchResolution(
  deps: SearchRailDeps,
  prospect: ProspectRow,
  bundle: Awaited<ReturnType<typeof probeAndVerify>>,
  domain: string,
  websiteUrl: string | null,
  candidate: SearchCandidate,
): Promise<void> {
  const sourceUrl = bundle.probe.finalUrl ?? `https://${domain}/`;
  const observedAt = (deps.now ?? (() => new Date()))().toISOString();
  const registryIdOnSite = bundle.registryIdsOnSite.sirens[0] ?? null;

  const evidenceJson = {
    verdict: bundle.verdict.verdict,
    confidence: bundle.verdict.confidence,
    homonymRisk: bundle.verdict.homonymRisk,
    signals: bundle.verdict.signals.filter((signal) => signal.matched).map((signal) => signal.key),
    reasons: bundle.verdict.reasons,
    // Le pointeur : quel rail, quelle variante, quel rang. Aucun contenu.
    searchPointer: { provider: deps.provider.name, variant: candidate.variant, rank: candidate.rank },
  };
  assertNoSearchResultContent(evidenceJson as unknown as Record<string, unknown>, 'search.attach_website');

  await deps.repo.addEvidence(prospect.id, {
    field: 'website_url',
    valueText: websiteUrl ?? sourceUrl,
    valueJson: evidenceJson,
    provider: 'open_web',
    method: 'crawl',
    sourceUrl,
    confidence: bundle.verdict.confidence,
    observedAt,
  });

  const columns = {
    website_url: websiteUrl,
    domain,
    registry_id: prospect.registry_id ? null : registryIdOnSite,
  };
  assertNoSearchResultContent(columns, 'search.fill_columns');
  await deps.repo.fillMissingColumns(prospect.id, columns);

  if (!prospect.registry_id && registryIdOnSite) {
    await deps.repo.addEvidence(prospect.id, {
      field: 'registry_id',
      valueText: registryIdOnSite,
      valueJson: { from: 'mentions_legales', page: bundle.probe.legalPageUrl ?? sourceUrl },
      provider: 'open_web',
      method: 'crawl',
      sourceUrl: bundle.probe.legalPageUrl ?? sourceUrl,
      confidence: 1,
      observedAt,
    });
  }

  if (bundle.mentions && hasUsableMentions(bundle.mentions)) {
    await deps.repo.addEvidence(prospect.id, {
      field: 'legal_mentions',
      valueText: [bundle.mentions.legalName, bundle.mentions.city, bundle.mentions.siren]
        .filter(Boolean)
        .join(' — '),
      valueJson: bundle.mentions,
      provider: 'open_web',
      method: 'crawl',
      sourceUrl: bundle.mentions.sourceUrl,
      confidence: 1,
      observedAt,
    });
  }

  await deps.repo.recordIdentityKeys(
    deps.campaignId,
    prospect.id,
    identityKeys({ name: prospect.display_name, domain, city: prospect.city }),
  );

  await deps.repo.recordDiscoveryOrigin(deps.campaignId, prospect.id, {
    provider: deps.provider.name,
    rail: 'search',
    externalId: domain,
  });
}

/** Une ligne par candidat sondé, refus compris — dans la table de R3. */
async function persistSearchCandidate(
  deps: SearchRailDeps,
  prospect: ProspectRow,
  candidate: SearchCandidate,
  bundle: Awaited<ReturnType<typeof probeAndVerify>>,
  outcome: SearchCandidateOutcome,
): Promise<void> {
  await deps.sql.query(
    `insert into discovery_domain_candidates
       (campaign_id, prospect_id, candidate_domain, origin, generation_form,
        dns_checked_at, dns_resolved, dns_error,
        http_checked_at, http_status, final_url, final_domain, http_error, robots_disallowed,
        identity_verdict, identity_confidence, identity_signals, homonym_risk,
        attached, reject_reason, last_checked_at)
     values ($1,$2,$3,'search',$4, now(),$5,$6, now(),$7,$8,$9,$10,$11, $12,$13,$14,$15,$16,$17, now())
     on conflict (campaign_id, prospect_id, candidate_domain) do update
       set dns_resolved = excluded.dns_resolved,
           dns_error = excluded.dns_error,
           http_checked_at = excluded.http_checked_at,
           http_status = excluded.http_status,
           final_url = excluded.final_url,
           final_domain = excluded.final_domain,
           http_error = excluded.http_error,
           robots_disallowed = excluded.robots_disallowed,
           identity_verdict = excluded.identity_verdict,
           identity_confidence = excluded.identity_confidence,
           identity_signals = excluded.identity_signals,
           homonym_risk = excluded.homonym_risk,
           attached = excluded.attached,
           reject_reason = excluded.reject_reason,
           last_checked_at = now()`,
    [
      deps.campaignId,
      prospect.id,
      candidate.domain,
      // `generation_form` nomme d'où vient la forme du domaine. Ici : la variante
      // de requête et le rang, qui sont notre trace, pas le résultat du moteur.
      `${candidate.variant}#${candidate.rank}`,
      bundle.probe.dnsResolved,
      bundle.probe.dnsError,
      bundle.probe.httpStatus,
      bundle.probe.finalUrl,
      bundle.probe.finalDomain,
      bundle.probe.httpError,
      bundle.probe.robotsDisallowed,
      bundle.verdict.verdict,
      bundle.verdict.confidence,
      JSON.stringify({
        signals: bundle.verdict.signals,
        reasons: bundle.verdict.reasons,
        siteName: bundle.siteName,
        nicheTerms: bundle.nicheTerms,
        registryIdsOnSite: bundle.registryIdsOnSite,
        searchPointer: { provider: deps.provider.name, variant: candidate.variant, rank: candidate.rank },
      }),
      bundle.verdict.homonymRisk,
      outcome.attached,
      bundle.verdict.rejectReason,
    ],
  );
}
