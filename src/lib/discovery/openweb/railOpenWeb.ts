import { generateDomainCandidates, tldsForCountry } from '@/lib/discovery/openweb/domainCandidates';
import {
  nodeDnsResolver,
  probeDomain,
  resolveDomainAddresses,
  type DnsResolver,
  type DomainProbe,
} from '@/lib/discovery/openweb/domainVerify';
import {
  collectRegistryIds,
  extractLegalMentions,
  hasUsableMentions,
  type LegalMentions,
} from '@/lib/discovery/openweb/legalMentions';
import { isAttachable, verifyIdentity, type IdentityVerdict, type IdentityVerdictLevel } from '@/lib/discovery/openweb/identityVerify';
import {
  captureAgeDays,
  recordCommonCrawlLookup,
  type CommonCrawlClient,
  type CommonCrawlLookup,
} from '@/lib/discovery/openweb/commonCrawl';
import { lookupRdapRegistrant, rdapSupports, type RdapRegistrant } from '@/lib/discovery/openweb/rdap';
import { ProviderUnavailableError, type ProviderScheduler } from '@/lib/http/scheduler';
import { extractPageFacts, matchVocabulary, stripTags } from '@/lib/enrichment/websiteExtract';
import { identityKeys } from '@/lib/identity/resolve';
import { normalizeDomain, normalizeUrl } from '@/lib/identity/normalize';
import { siteDeclaredName } from '@/lib/discovery/places/identify';
import type { NicheConfig } from '@/lib/config/schema';
import type { HttpClient } from '@/lib/http/client';
import type { Logger } from '@/lib/logging/logger';
import type { ProspectRepository } from '@/lib/repo/prospects';
import type { ProspectRow } from '@/lib/repo/types';
import type { Sql } from '@/lib/db/sql';

/**
 * Rail B — le web ouvert.
 *
 * Le registre français donne une identité légale irréprochable et pas une
 * seule adresse web. C'est le blocage que R1 et R2 ont mesuré sans le lever :
 * sur 60 prospects `in_niche`, cinq ont un site. Ce rail essaie de le lever
 * avec des moyens gratuits et officiels, en assumant que la plupart de ses
 * hypothèses seront fausses.
 *
 * Le trajet d'un prospect :
 *
 *   nom + ville
 *        │  fabrication bornée de domaines candidats (§10)
 *        ▼
 *   candidats  ←── candidats OBSERVÉS (site déclaré sur Instagram, proposition
 *        │          SearXNG écartée par WebIntel, lien trouvé ailleurs)
 *        │  Common Crawl : a-t-il déjà servi des pages ? (corroboration seule)
 *        ▼
 *   DNS → HTTP → redirection → HTML → mentions légales (§11, §13)
 *        │
 *        ▼
 *   vérification d'identité (§12) → confirmed / probable / uncertain / rejected
 *        │  seul `confirmed`, ou `probable` sans risque d'homonymie, rattache
 *        ▼
 *   WebIntel : crawl complet, funnel, contacts (§17)
 *
 * Deux choix méritent d'être défendus explicitement.
 *
 * **Chaque étage est écrit, y compris ses refus.** Une ligne
 * `discovery_domain_candidates` est créée pour un candidat qui ne résout même
 * pas en DNS. C'est ce qui permet au §23 de dire où le rail fuit — et à un
 * futur run de ne pas repayer la même question.
 *
 * **Le SIREN lu sur un site vaut mieux que le nom.** Quand les mentions
 * légales publient un identifiant de registre valide et que le prospect n'en a
 * pas, on le lui attribue : le site vient de nous donner une identité légale
 * vérifiable, ce qu'aucune similarité de nom ne remplace.
 */

export interface OpenWebRailDeps {
  sql: Sql;
  repo: ProspectRepository;
  http: HttpClient;
  logger: Logger;
  niche: NicheConfig;
  scheduler: ProviderScheduler;
  /** Null quand Common Crawl est désactivé : le rail fonctionne sans. */
  commonCrawl: CommonCrawlClient | null;
  campaignId: string;
  runId: string | null;
  /** Pays de la campagne, d'où sont dérivées les extensions candidates. */
  country: string;
  resolver?: DnsResolver;
  now?: () => Date;
}

export interface OpenWebOptions {
  /** Plafond de candidats réellement sondés par prospect. */
  maxCandidatesPerProspect?: number;
  /** Interroger Common Crawl avant de sonder. */
  useCommonCrawl?: boolean;
  /** Interroger le registre du nom de domaine (RDAP) avant de sonder. */
  useRdap?: boolean;
  /** Écrire le résultat. `false` = mesure seule. */
  persist?: boolean;
}

export interface CandidateOutcome {
  domain: string;
  origin: 'generated' | 'observed';
  form: string | null;
  dnsResolved: boolean;
  httpStatus: number | null;
  finalDomain: string | null;
  ccCaptures: number | null;
  ccAgeDays: number | null;
  verdict: IdentityVerdictLevel;
  confidence: number;
  homonymRisk: boolean;
  attached: boolean;
  rejectReason: string | null;
  registryIdOnSite: string | null;
  /** Raison sociale du titulaire publiée par le registre, ou null si anonymisée. */
  rdapHolder: string | null;
}

export interface OpenWebProspectOutcome {
  prospectId: string;
  displayName: string;
  hadWebsiteBefore: boolean;
  candidatesGenerated: number;
  candidatesProbed: number;
  outcomes: CandidateOutcome[];
  attachedDomain: string | null;
  attachedVerdict: IdentityVerdictLevel | null;
  /** SIREN découvert sur le site alors que le prospect n'en avait pas. */
  registryIdResolved: string | null;
  /** Un autre prospect portait déjà ce domaine : mis en revue, pas fusionné. */
  domainCollisionWith: string | null;
  ccLookups: number;
  ccCorroborated: number;
  rdapLookups: number;
  /** Domaines dont le registre publie une personne morale (les autres sont anonymisés de droit). */
  rdapNamedHolders: number;
  errors: string[];
  durationMs: number;
}

/** Fournisseurs cadencés par ce rail. Les noms servent aussi à l'attribution. */
export const OPEN_WEB_PROVIDERS = {
  commonCrawl: 'common_crawl',
  domainProbe: 'domain_probe',
  rdap: 'rdap',
} as const;

/**
 * Cadence par fournisseur.
 *
 * Les valeurs ne sont pas des estimations : Common Crawl demande explicitement
 * de rester sous 10 requêtes par seconde *tous utilisateurs confondus*, de
 * dormir entre les appels y compris d'une exécution à l'autre, et de ne pas
 * paralléliser depuis une même IP. Un dépassement soutenu vaut un blocage d'IP
 * de 24 heures — soit, pour un benchmark, la perte de la mesure entière.
 *
 * `domain_probe` est plus souple parce que chaque candidat est un hôte
 * différent : `HttpClient` applique déjà un espacement par hôte, et la limite
 * utile ici est notre propre parallélisme, pas la politesse envers un serveur
 * unique.
 */
export function openWebSchedulerLimits(): Record<string, Partial<import('@/lib/http/scheduler').ProviderLimits>> {
  return {
    [OPEN_WEB_PROVIDERS.commonCrawl]: {
      concurrency: 1,
      minIntervalMs: 1_500,
      jitterMs: 400,
      failureThreshold: 3,
      // Le blocage officiel dure jusqu'à 24 h ; cinq minutes de repos suffisent
      // à distinguer un incident passager d'un refus durable sans transformer
      // le run en attente.
      cooldownMs: 300_000,
    },
    [OPEN_WEB_PROVIDERS.domainProbe]: {
      concurrency: 2,
      minIntervalMs: 250,
      jitterMs: 150,
      failureThreshold: 25,
      cooldownMs: 60_000,
    },
    // Les limites du registre ne sont pas publiées. Une limite inconnue est une
    // raison d'être plus prudent, pas moins : un appel à la fois, une seconde
    // d'écart, et un repos rapide au moindre refus.
    [OPEN_WEB_PROVIDERS.rdap]: {
      concurrency: 1,
      minIntervalMs: 1_000,
      jitterMs: 300,
      failureThreshold: 3,
      cooldownMs: 180_000,
    },
  };
}

/**
 * Candidats déjà OBSERVÉS pour ce prospect.
 *
 * Les evidences `website_candidate` sont des propositions que quelque chose a
 * faites et que personne n'a validées : un domaine remonté par SearXNG et
 * refusé par la contre-vérification de nom, un site déclaré sur un compte
 * Instagram. Ils sont bien meilleurs qu'un domaine fabriqué — quelqu'un les a
 * vus quelque part — et R2 les laissait dormir dans la table d'evidence.
 */
export async function observedDomainCandidates(
  repo: ProspectRepository,
  prospectId: string,
): Promise<{ domain: string; from: string }[]> {
  const evidence = await repo.evidenceFor(prospectId);
  const found = new Map<string, string>();

  for (const item of evidence) {
    if (item.field !== 'website_candidate' && item.field !== 'website_url') continue;
    const fromJson = item.value_json as { url?: unknown } | null;
    const raw =
      typeof fromJson?.url === 'string'
        ? fromJson.url
        : (item.value_text ?? '').split(/\s|—/)[0] ?? '';
    const domain = normalizeDomain(raw) ?? normalizeDomain(item.source_url ?? '');
    if (!domain) continue;
    if (!found.has(domain)) found.set(domain, item.provider);
  }

  return [...found.entries()].map(([domain, from]) => ({ domain, from }));
}

interface ProbeBundle {
  probe: DomainProbe;
  mentions: LegalMentions | null;
  verdict: IdentityVerdict;
  siteName: string | null;
  nicheTerms: string[];
  registryIdsOnSite: { sirens: string[]; sirets: string[] };
  rdap: RdapRegistrant | null;
}

/** Sonde un candidat et le juge. Aucun écrit en base : la décision revient au rail. */
export async function probeAndVerify(
  deps: Pick<OpenWebRailDeps, 'http' | 'logger' | 'niche' | 'resolver'>,
  prospect: Pick<ProspectRow, 'display_name' | 'brand_name' | 'legal_name' | 'registry_id' | 'city' | 'postal_code' | 'phone'>,
  domain: string,
  domainOrigin: 'generated' | 'observed' = 'generated',
  rdap: RdapRegistrant | null = null,
): Promise<ProbeBundle> {
  const probe = await probeDomain(
    {
      http: deps.http,
      logger: deps.logger,
      ...(deps.resolver ? { resolver: deps.resolver } : {}),
    },
    domain,
    { readLegalPage: true, guessLegalPaths: true },
  );

  const homeHtml = probe.html ?? '';
  const legalHtml = probe.legalHtml ?? '';
  const combinedHtml = `${homeHtml}\n${legalHtml}`;
  const pageText = stripTags(combinedHtml);

  const facts = homeHtml ? extractPageFacts(homeHtml, probe.finalUrl ?? `https://${domain}/`) : null;
  const legalFacts = legalHtml ? extractPageFacts(legalHtml, probe.legalPageUrl ?? `https://${domain}/`) : null;

  const mentions = legalHtml
    ? extractLegalMentions(legalHtml, probe.legalPageUrl ?? `https://${domain}/`)
    : homeHtml
      ? extractLegalMentions(homeHtml, probe.finalUrl ?? `https://${domain}/`)
      : null;

  const registryIdsOnSite = combinedHtml.trim() ? collectRegistryIds(combinedHtml) : { sirens: [], sirets: [] };
  const siteName = facts ? siteDeclaredName([{ field: 'website_title', valueText: facts.title }], domain) : null;
  const nicheTerms = pageText ? matchVocabulary(pageText, [...deps.niche.positiveTerms, ...deps.niche.serviceTerms]) : [];

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
    domainOrigin,
    finalDomain: probe.finalDomain,
    httpStatus: probe.httpStatus,
    siteName,
    pageText,
    mentions: mentions && hasUsableMentions(mentions) ? mentions : null,
    registryIdsOnSite,
    observed: {
      phones: [...(facts?.phones ?? []), ...(legalFacts?.phones ?? [])],
      emails: [...(facts?.emails ?? []), ...(legalFacts?.emails ?? [])],
      instagram: [...(facts?.instagram ?? []), ...(legalFacts?.instagram ?? [])],
      facebook: [...(facts?.facebook ?? []), ...(legalFacts?.facebook ?? [])],
    },
    nicheTermsFound: nicheTerms,
    rdapRegistrant: rdap ? { organizationName: rdap.organizationName, anonymised: rdap.anonymised } : null,
  });

  return { probe, mentions, verdict, siteName, nicheTerms, registryIdsOnSite, rdap };
}

function emptyOutcome(prospect: ProspectRow): OpenWebProspectOutcome {
  return {
    prospectId: prospect.id,
    displayName: prospect.display_name,
    hadWebsiteBefore: prospect.website_url !== null,
    candidatesGenerated: 0,
    candidatesProbed: 0,
    outcomes: [],
    attachedDomain: null,
    attachedVerdict: null,
    registryIdResolved: null,
    domainCollisionWith: null,
    ccLookups: 0,
    ccCorroborated: 0,
    rdapLookups: 0,
    rdapNamedHolders: 0,
    errors: [],
    durationMs: 0,
  };
}

/**
 * Résout le domaine d'un prospect.
 *
 * S'arrête au premier candidat rattachable — les suivants ne pourraient que
 * proposer un second site à la même entreprise, ce qui n'existe presque jamais
 * et coûterait des requêtes chez des tiers.
 */
export async function resolveProspectDomain(
  deps: OpenWebRailDeps,
  prospect: ProspectRow,
  options: OpenWebOptions = {},
): Promise<OpenWebProspectOutcome> {
  const now = deps.now ?? (() => new Date());
  const startedAt = Date.now();
  const outcome = emptyOutcome(prospect);
  const persist = options.persist !== false;
  const maxCandidates = options.maxCandidatesPerProspect ?? 8;

  // ------------------------------------------------------------- candidats
  const observed = await observedDomainCandidates(deps.repo, prospect.id);
  const generated = generateDomainCandidates(
    {
      brandName: prospect.brand_name,
      displayName: prospect.display_name,
      legalName: prospect.legal_name,
      city: prospect.city,
    },
    deps.niche,
    { tlds: tldsForCountry(deps.country) },
  );
  outcome.candidatesGenerated = generated.length;

  // Les candidats observés passent devant : quelqu'un les a vus quelque part,
  // là où les autres sortent d'une règle de fabrication.
  const seen = new Set<string>();
  const queue: { domain: string; origin: 'generated' | 'observed'; form: string | null }[] = [];
  for (const item of observed) {
    if (seen.has(item.domain)) continue;
    seen.add(item.domain);
    queue.push({ domain: item.domain, origin: 'observed', form: null });
  }
  for (const candidate of generated) {
    if (seen.has(candidate.domain)) continue;
    seen.add(candidate.domain);
    queue.push({ domain: candidate.domain, origin: 'generated', form: candidate.form });
  }

  for (const candidate of queue.slice(0, maxCandidates)) {
    if (outcome.attachedDomain) break;

    /**
     * DNS d'abord, et c'est le point d'ordonnancement qui compte le plus.
     *
     * Une résolution DNS est locale, instantanée et ne dérange personne. La
     * grande majorité des domaines fabriqués n'existent pas — mesuré : aucun
     * des candidats générés du premier run n'a résolu. Interroger Common Crawl
     * et le registre AFNIC AVANT le DNS revenait donc à poser deux questions à
     * deux services publics à débit limité au sujet de domaines inexistants,
     * environ vingt secondes par prospect, pour une réponse qui ne changeait
     * aucun verdict.
     *
     * Ce n'est pas qu'une question de vitesse : Common Crawl demande
     * explicitement de ne pas surcharger son index, et l'AFNIC ne publie même
     * pas ses limites. Ne les solliciter que pour un domaine qui existe
     * réellement est la seule façon polie de s'en servir.
     */
    const dns = await resolveDomainAddresses(candidate.domain, deps.resolver ?? nodeDnsResolver);

    let lookup: CommonCrawlLookup | null = null;
    let rdap: RdapRegistrant | null = null;

    if (dns.resolved && !dns.privateAddress) {
      const commonCrawl = deps.commonCrawl;
      if (commonCrawl && options.useCommonCrawl !== false) {
        try {
          lookup = await deps.scheduler.run(OPEN_WEB_PROVIDERS.commonCrawl, () =>
            commonCrawl.lookupDomain(candidate.domain),
          );
          outcome.ccLookups += 1;
          if (lookup.servedHtml) outcome.ccCorroborated += 1;
          if (persist) await recordCommonCrawlLookup(deps.sql, deps.runId, lookup);
        } catch (error) {
          // L'index se repose, ou il a échoué. Le rail continue sans lui : une
          // absence de corroboration n'a jamais été une raison de rejeter.
          outcome.errors.push(
            error instanceof ProviderUnavailableError
              ? error.message
              : error instanceof Error
                ? error.message
                : String(error),
          );
        }
      }

      if (options.useRdap !== false && rdapSupports(candidate.domain)) {
        try {
          rdap = await deps.scheduler.run(OPEN_WEB_PROVIDERS.rdap, () =>
            lookupRdapRegistrant({ http: deps.http, logger: deps.logger }, candidate.domain),
          );
          outcome.rdapLookups += 1;
          if (rdap?.organizationName) outcome.rdapNamedHolders += 1;
        } catch (error) {
          outcome.errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }

    // ------------------------------------------------------ HTTP → HTML → identité
    let bundle: ProbeBundle;
    try {
      bundle = await deps.scheduler.run(OPEN_WEB_PROVIDERS.domainProbe, () =>
        probeAndVerify(deps, prospect, candidate.domain, candidate.origin, rdap),
      );
    } catch (error) {
      outcome.errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    outcome.candidatesProbed += 1;

    const registryIdOnSite = bundle.registryIdsOnSite.sirens[0] ?? null;
    const attachable = isAttachable(bundle.verdict);

    const candidateOutcome: CandidateOutcome = {
      domain: candidate.domain,
      origin: candidate.origin,
      form: candidate.form,
      dnsResolved: bundle.probe.dnsResolved,
      httpStatus: bundle.probe.httpStatus,
      finalDomain: bundle.probe.finalDomain,
      ccCaptures: lookup ? lookup.captures.length : null,
      ccAgeDays: lookup ? captureAgeDays(lookup, now()) : null,
      verdict: bundle.verdict.verdict,
      confidence: Number(bundle.verdict.confidence.toFixed(3)),
      homonymRisk: bundle.verdict.homonymRisk,
      attached: false,
      rejectReason: bundle.verdict.rejectReason,
      registryIdOnSite,
      rdapHolder: bundle.rdap?.organizationName ?? null,
    };

    if (attachable) {
      const attachDomain = bundle.probe.finalDomain ?? candidate.domain;
      const websiteUrl = normalizeUrl(bundle.probe.finalUrl ?? `https://${attachDomain}/`);

      // Collision : un autre prospect porte déjà ce domaine. Deux entreprises
      // ne partagent pas un site ; l'une des deux lignes est de trop. On les
      // met en revue plutôt que d'en supprimer une au jugé.
      const owner = await deps.repo.findByIdentityKey(deps.campaignId, 'domain', attachDomain);
      if (owner && owner !== prospect.id) {
        outcome.domainCollisionWith = owner;
        if (persist) {
          await deps.repo.recordMergeCandidate(deps.campaignId, prospect.id, owner, bundle.verdict.confidence, {
            reason: 'même domaine résolu par le rail web ouvert',
            domain: attachDomain,
            verdict: bundle.verdict.verdict,
          });
        }
      }

      if (persist) {
        await attachResolution(deps, prospect, bundle, attachDomain, websiteUrl);
      }

      candidateOutcome.attached = true;
      outcome.attachedDomain = attachDomain;
      outcome.attachedVerdict = bundle.verdict.verdict;
      if (!prospect.registry_id && registryIdOnSite) outcome.registryIdResolved = registryIdOnSite;
    }

    outcome.outcomes.push(candidateOutcome);
    if (persist) await persistCandidate(deps, prospect, candidate, bundle, lookup, candidateOutcome);
  }

  outcome.durationMs = Date.now() - startedAt;
  return outcome;
}

/** Écrit ce que le site a dit, avec sa provenance. */
async function attachResolution(
  deps: OpenWebRailDeps,
  prospect: ProspectRow,
  bundle: ProbeBundle,
  domain: string,
  websiteUrl: string | null,
): Promise<void> {
  const sourceUrl = bundle.probe.finalUrl ?? `https://${domain}/`;
  const observedAt = (deps.now ?? (() => new Date()))().toISOString();
  const registryIdOnSite = bundle.registryIdsOnSite.sirens[0] ?? null;

  await deps.repo.addEvidence(prospect.id, {
    field: 'website_url',
    valueText: websiteUrl ?? sourceUrl,
    valueJson: {
      verdict: bundle.verdict.verdict,
      confidence: bundle.verdict.confidence,
      homonymRisk: bundle.verdict.homonymRisk,
      signals: bundle.verdict.signals.filter((signal) => signal.matched).map((signal) => signal.key),
      reasons: bundle.verdict.reasons,
    },
    provider: 'open_web',
    method: 'crawl',
    sourceUrl,
    confidence: bundle.verdict.confidence,
    observedAt,
  });

  await deps.repo.fillMissingColumns(prospect.id, {
    website_url: websiteUrl,
    domain,
    // Un identifiant de registre lu sur le site de l'entreprise est une
    // observation, pas une déduction : il est cité avec sa page source.
    registry_id: prospect.registry_id ? null : registryIdOnSite,
  });

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

  // Le domaine devient une clé de dédup : la prochaine source qui rencontrera
  // cette entreprise par son site la reconnaîtra.
  await deps.repo.recordIdentityKeys(
    deps.campaignId,
    prospect.id,
    identityKeys({ name: prospect.display_name, domain, city: prospect.city }),
  );

  await deps.repo.recordDiscoveryOrigin(deps.campaignId, prospect.id, {
    provider: 'open_web',
    rail: 'open_web',
    externalId: domain,
  });
}

/** Une ligne par candidat sondé, refus compris. */
async function persistCandidate(
  deps: OpenWebRailDeps,
  prospect: ProspectRow,
  candidate: { domain: string; origin: 'generated' | 'observed'; form: string | null },
  bundle: ProbeBundle,
  lookup: CommonCrawlLookup | null,
  outcome: CandidateOutcome,
): Promise<void> {
  await deps.sql.query(
    `insert into discovery_domain_candidates
       (campaign_id, prospect_id, candidate_domain, origin, generation_form,
        dns_checked_at, dns_resolved, dns_error,
        cc_checked_at, cc_captures, cc_first_capture, cc_last_capture, cc_index,
        http_checked_at, http_status, final_url, final_domain, http_error, robots_disallowed,
        identity_verdict, identity_confidence, identity_signals, homonym_risk,
        attached, reject_reason, last_checked_at)
     values ($1,$2,$3,$4,$5, now(),$6,$7, $8,$9,$10,$11,$12, now(),$13,$14,$15,$16,$17,
             $18,$19,$20,$21,$22,$23, now())
     on conflict (campaign_id, prospect_id, candidate_domain) do update
       set dns_resolved = excluded.dns_resolved,
           dns_error = excluded.dns_error,
           cc_checked_at = excluded.cc_checked_at,
           cc_captures = excluded.cc_captures,
           cc_first_capture = excluded.cc_first_capture,
           cc_last_capture = excluded.cc_last_capture,
           cc_index = excluded.cc_index,
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
      candidate.origin,
      candidate.form,
      bundle.probe.dnsResolved,
      bundle.probe.dnsError,
      lookup ? new Date().toISOString() : null,
      lookup ? lookup.captures.length : null,
      lookup?.firstCapture ?? null,
      lookup?.lastCapture ?? null,
      lookup?.indexId ?? null,
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
        rdap: bundle.rdap
          ? {
              organizationName: bundle.rdap.organizationName,
              anonymised: bundle.rdap.anonymised,
              registrarName: bundle.rdap.registrarName,
              registeredAt: bundle.rdap.registeredAt,
              sourceUrl: bundle.rdap.sourceUrl,
            }
          : null,
      }),
      bundle.verdict.homonymRisk,
      outcome.attached,
      bundle.verdict.rejectReason,
    ],
  );
}
