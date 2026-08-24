import { readOnlyQuery } from '@/lib/db/safety';
import { probeAndVerify } from '@/lib/discovery/openweb/railOpenWeb';
import { lookupRdapRegistrant, rdapSupports } from '@/lib/discovery/openweb/rdap';
import { hasUsableMentions } from '@/lib/discovery/openweb/legalMentions';
import { extractPageFacts } from '@/lib/enrichment/websiteExtract';
import { crawlViaWebIntel, createWebIntelClient } from '@/lib/enrichment/webintel';
import { identityKeys } from '@/lib/identity/resolve';
import {
  adjudicateProbableDomain,
  adjudicateProspect,
  type ProbableDomainAdjudication,
  type ProspectDomainAdjudication,
} from '@/lib/identity/probableDomain';
import { isDirectoryDomain, isPlatformDomain, normalizeDomain, normalizeUrl } from '@/lib/identity/normalize';
import type { HttpClient } from '@/lib/http/client';
import type { Logger } from '@/lib/logging/logger';
import type { NicheConfig } from '@/lib/config/schema';
import type { ProspectRepository } from '@/lib/repo/prospects';
import type { Sql } from '@/lib/db/sql';
import type { DnsResolver } from '@/lib/discovery/openweb/domainVerify';

/**
 * R7.2B.1 — le rail qui donne au vérificateur de quoi trancher.
 *
 * R7.2 s'est arrêté devant 34 domaines en statut `probable`, laissés
 * délibérément non rattachés (`OUTBOUND_WEBINTEL_ATTACH_PROBABLE=0`). Le
 * réglage n'était pas le problème : le résolveur avait proposé un domaine sans
 * jamais ouvrir la page, et « proposé avec un score élevé » n'est pas « vérifié ».
 *
 * Ce rail ne relâche donc aucune garde. Il fait ce que la garde attendait de
 * quelqu'un : il **ouvre le site**, lit ses mentions légales, interroge le
 * registre du domaine, et soumet le tout au vérificateur d'identité — puis à
 * l'adjudication de `probableDomain.ts`. Un `probable` ne devient jamais un
 * rattachement ; il devient un `CONFIRMED`, un `REJECTED` ou une question pour
 * un humain, et seul le premier autorise l'écriture.
 *
 * Ce qu'il ne touche pas : `prospects.score`, `score_band`, `stage`, le canal
 * canonique, les manifestes, les files. Ses seules écritures sont
 * `prospect_evidence` (append-only) et `fillMissingColumns`, qui ne remplit que
 * des blancs — la frontière que le dépôt trace lui-même pour un rail de
 * collecte.
 */

export const IDENTITY_VERIFIER_PROVIDER = 'identity_verifier';

/**
 * Combien de candidats d'un même prospect sont réellement ouverts.
 *
 * Le premier est celui que le résolveur a proposé. Le second existe pour deux
 * raisons opposées et également nécessaires : rattraper un prospect dont la
 * proposition était une fiche d'annuaire, et détecter l'ambiguïté — deux
 * domaines qui réunissent chacun une preuve ne font pas deux sites, ils font
 * une question. Au-delà de deux, on ne vérifie plus, on ratisse.
 */
export const MAX_CANDIDATES_PROBED = 2;

interface ResolutionCandidate {
  domain?: unknown;
  score?: unknown;
  signals?: unknown;
}

export interface ProbableProspectRow {
  id: string;
  campaign_id: string;
  campaign_slug: string | null;
  display_name: string;
  brand_name: string | null;
  legal_name: string | null;
  registry_id: string | null;
  city: string | null;
  postal_code: string | null;
  phone: string | null;
  email: string | null;
  instagram_handle: string | null;
  resolution_reason: string | null;
  candidates: ResolutionCandidate[] | null;
}

/**
 * Les prospects dont la dernière résolution vaut `probable` et qui n'ont
 * toujours aucun domaine.
 *
 * `distinct on` prend la résolution la plus récente : une preuve est
 * append-only, et un prospect re-résolu depuis porte plusieurs lignes.
 */
export const PROBABLE_CANDIDATES_SQL = `
  with latest as (
    select distinct on (e.prospect_id)
           e.prospect_id,
           e.value_json
      from prospect_evidence e
     where e.provider = 'webintel'
       and e.field = 'webintel_resolution'
     order by e.prospect_id, e.observed_at desc
  )
  select p.id,
         p.campaign_id,
         c.slug              as campaign_slug,
         p.display_name,
         p.brand_name,
         p.legal_name,
         p.registry_id,
         p.city,
         p.postal_code,
         p.phone,
         p.email,
         p.instagram_handle,
         l.value_json->>'reason'     as resolution_reason,
         l.value_json->'candidates'  as candidates
    from latest l
    join prospects p on p.id = l.prospect_id
    join campaigns c on c.id = p.campaign_id
   where p.dedupe_status <> 'merged'
     and l.value_json->>'status' = 'probable'
     and p.website_url is null
     and p.domain is null
   order by p.display_name
`;

export async function loadProbableCandidates(sql: Sql): Promise<ProbableProspectRow[]> {
  return readOnlyQuery<ProbableProspectRow>(sql, PROBABLE_CANDIDATES_SQL, [], 'r7-verify-domains');
}

/**
 * Les sites que ce vérificateur a rattachés et que personne n'a encore lus.
 *
 * Un rattachement sans lecture ne vaut rien : c'est la lecture qui produit les
 * faits commerciaux, et sans elle le prospect reste exactement là où il était.
 * Le rail crawle normalement dans la foulée du rattachement — cette requête
 * existe pour que l'enchaînement reste vrai même quand il a été interrompu,
 * ou quand le rattachement et la lecture ont été décidés à deux moments
 * différents. Le rattachement ayant rempli `domain`, ces prospects sont sortis
 * de la cohorte des `probable` : sans ce rattrapage ils ne seraient plus jamais
 * repris par personne.
 *
 * « Jamais lu » se lit sur les champs que le moteur commercial consomme, pas
 * sur `prospects.domain` — même définition que `webintel:benchmark`.
 */
export const CRAWL_BACKLOG_SQL = `
  select p.id, p.website_url
    from prospects p
   where p.dedupe_status <> 'merged'
     and p.website_url is not null
     and exists (
       select 1 from prospect_evidence e
        where e.prospect_id = p.id
          and e.provider = '${IDENTITY_VERIFIER_PROVIDER}'
          and e.field = 'website_url')
     and not exists (
       select 1 from prospect_evidence e
        where e.prospect_id = p.id
          and e.field in ('website_quality','cta_quality','funnel_observed',
                          'funnel_not_observed','booking_system','funnel_synthesis'))
   order by p.display_name
`;

export async function loadCrawlBacklog(sql: Sql): Promise<{ id: string; website_url: string }[]> {
  return readOnlyQuery<{ id: string; website_url: string }>(sql, CRAWL_BACKLOG_SQL, [], 'r7-verify-domains-backlog');
}

/**
 * Le domaine enregistrable, approximation assumée.
 *
 * Sert uniquement à regrouper `44.lavieduvillage.fr` et `34.lavieduvillage.fr`
 * lorsqu'on compte pour combien de prospects distincts un domaine est proposé.
 * Deux entreprises différentes ne peuvent pas détenir le même domaine
 * enregistrable, donc le regroupement ne peut pas confondre deux vrais sites.
 * Les suffixes composés (`co.uk`, `com.au`) sont traités à part, sans quoi
 * `a.co.uk` et `b.co.uk` seraient comptés comme un seul domaine.
 */
const COMPOUND_SUFFIX = /^(co|com|net|org|gov|ac|edu)\.[a-z]{2}$/;

export function registrableDomain(domain: string): string {
  const parts = (normalizeDomain(domain) ?? domain).split('.');
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  return COMPOUND_SUFFIX.test(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}

/**
 * Les domaines à ouvrir pour un prospect.
 *
 * Le premier candidat du résolveur toujours ; puis le meilleur suivant qui ne
 * soit ni une plateforme ni un annuaire connu — celui-là seulement, et
 * seulement s'il diffère du premier.
 */
export function candidatesToProbe(row: ProbableProspectRow): string[] {
  const domains: string[] = [];
  for (const candidate of row.candidates ?? []) {
    const domain = typeof candidate.domain === 'string' ? normalizeDomain(candidate.domain) : null;
    if (!domain || domains.includes(domain)) continue;
    if (domains.length === 0) {
      domains.push(domain);
      continue;
    }
    if (isPlatformDomain(domain) || isDirectoryDomain(domain)) continue;
    domains.push(domain);
    if (domains.length >= MAX_CANDIDATES_PROBED) break;
  }
  return domains;
}

/**
 * Pour chaque domaine, les prospects dont il est la MEILLEURE réponse du
 * résolveur.
 *
 * Aucune liste n'intervient : c'est notre propre corpus qui témoigne. Un
 * domaine que le résolveur donne comme meilleure réponse à quatre entreprises
 * différentes n'est le site propre d'aucune des quatre — c'est un annuaire, et
 * `societe.politologue.com` l'a été pour quatre des trente-quatre.
 *
 * Seul le premier candidat compte, et ce détail est la règle elle-même. Un
 * domaine qui apparaît en troisième position dans la liste d'une autre
 * entreprise n'a rien prouvé : `demo-51-exemple.fr` est la meilleure réponse pour
 * « DEMO GOLF » et une coïncidence de vocabulaire pour « BIRDIE ATELIER ».
 * Compter les deux de la même façon rejetterait le vrai site à cause du bruit
 * qui l'entoure — l'erreur exacte que ce module existe pour ne pas commettre.
 */
export function countDomainSharing(plan: { prospectId: string; domains: string[] }[]): Map<string, Set<string>> {
  const byDomain = new Map<string, Set<string>>();
  for (const entry of plan) {
    const proposed = entry.domains[0];
    if (!proposed) continue;
    const key = registrableDomain(proposed);
    const owners = byDomain.get(key) ?? new Set<string>();
    owners.add(entry.prospectId);
    byDomain.set(key, owners);
  }
  return byDomain;
}

/**
 * Combien d'AUTRES entreprises revendiquent ce domaine comme meilleure réponse.
 *
 * Le prospect examiné ne se compte jamais lui-même — mais il ne « s'exclut »
 * pas non plus d'un ensemble auquel il n'appartient pas : un prospect qui teste
 * en second choix le domaine proposé à quelqu'un d'autre voit bien ce
 * quelqu'un d'autre.
 */
export function sharedWithOtherProspects(
  sharing: Map<string, Set<string>>,
  domain: string,
  prospectId: string,
): number {
  const owners = sharing.get(registrableDomain(domain));
  if (!owners) return 0;
  return owners.has(prospectId) ? owners.size - 1 : owners.size;
}

// ---------------------------------------------------------------------------
// Corroboration inter-campagne — LECTURE SEULE
// ---------------------------------------------------------------------------
const CROSS_CAMPAIGN_SQL = `
  select p.id, c.slug as campaign_slug, p.domain
    from prospects p
    join campaigns c on c.id = p.campaign_id
   where p.dedupe_status <> 'merged'
     and p.registry_id = $1
     and p.id <> $2
     and p.domain is not null
`;

/**
 * Une identité déjà prouvée ailleurs peut corroborer celle-ci.
 *
 * Strictement en lecture : aucune ligne n'est fusionnée, aucune contrainte de
 * déduplication n'est touchée. Le même identifiant de registre sur deux lignes
 * de deux campagnes est le même établissement vu deux fois — c'est une preuve
 * d'appartenance du domaine, pas une instruction de fusion. Voir §5.
 */
export async function crossCampaignCorroboration(
  sql: Sql,
  prospectId: string,
  registryId: string | null,
  domain: string,
): Promise<{ prospectId: string; campaignSlug: string | null }[]> {
  if (!registryId) return [];
  const rows = await readOnlyQuery<{ id: string; campaign_slug: string | null; domain: string }>(
    sql,
    CROSS_CAMPAIGN_SQL,
    [registryId, prospectId],
    'r7-verify-domains-cross-campaign',
  );
  const target = registrableDomain(domain);
  return rows
    .filter((row) => registrableDomain(row.domain) === target)
    .map((row) => ({ prospectId: row.id, campaignSlug: row.campaign_slug }));
}

// ---------------------------------------------------------------------------
// Exécution
// ---------------------------------------------------------------------------
export interface ProbableDomainRailDeps {
  sql: Sql;
  repo: ProspectRepository;
  http: HttpClient;
  logger: Logger;
  niche: NicheConfig;
  resolver?: DnsResolver;
  now?: () => Date;
}

export interface ProbableDomainRailOptions {
  /** `false` (défaut) = ombre stricte : rien n'est écrit, pas même une preuve. */
  persist?: boolean;
  /** `true` = rattacher les domaines adjugés CONFIRMED. Suppose `persist`. */
  attach?: boolean;
  /**
   * `true` = lire le site fraîchement rattaché avec le crawler existant.
   *
   * C'est l'étape qui donne au rattachement sa valeur : un domaine sans page
   * lue ne produit aucun fait commercial, et le prospect reste exactement là
   * où il était. Le crawl passe par `crawlViaWebIntel`, la fonction que le
   * pipeline appelle déjà — aucun second crawler.
   */
  crawl?: boolean;
  limit?: number;
  useRdap?: boolean;
}

export interface ProbableDomainOutcome extends ProspectDomainAdjudication {
  campaignSlug: string | null;
  resolutionReason: string | null;
  attachedDomain: string | null;
  attachedUrl: string | null;
  collisionWith: string | null;
  /** Pages lues après rattachement, ou null quand aucun crawl n'a été demandé. */
  crawlPages: number | null;
  errors: string[];
}

export interface ProbableDomainReport {
  prospects: number;
  domainsProbed: number;
  confirmed: number;
  rejected: number;
  reviewRequired: number;
  attached: number;
  crawlSucceeded: number;
  crawlFailed: number;
  outcomes: ProbableDomainOutcome[];
}

export async function runProbableDomainVerification(
  deps: ProbableDomainRailDeps,
  options: ProbableDomainRailOptions = {},
): Promise<ProbableDomainReport> {
  const persist = options.persist === true;
  const attach = options.attach === true && persist;
  const now = deps.now ?? ((): Date => new Date());

  const all = await loadProbableCandidates(deps.sql);
  const rows = options.limit !== undefined ? all.slice(0, options.limit) : all;

  const plan = rows.map((row) => ({ prospectId: row.id, domains: candidatesToProbe(row) }));
  const sharing = countDomainSharing(plan);

  const report: ProbableDomainReport = {
    prospects: rows.length,
    domainsProbed: 0,
    confirmed: 0,
    rejected: 0,
    reviewRequired: 0,
    attached: 0,
    crawlSucceeded: 0,
    crawlFailed: 0,
    outcomes: [],
  };

  const webintel = options.crawl === true ? createWebIntelClient(deps.http) : null;
  if (options.crawl === true && !webintel) {
    throw new Error(
      '--crawl demande le worker Web Intelligence : renseignez OUTBOUND_WEBINTEL_URL et OUTBOUND_WEBINTEL_TOKEN.',
    );
  }

  for (const row of rows) {
    const domains = plan.find((entry) => entry.prospectId === row.id)?.domains ?? [];
    const adjudications: ProbableDomainAdjudication[] = [];
    const errors: string[] = [];
    // Gardé pour l'écriture : le probe porte l'URL finale et les mentions.
    const bundles = new Map<string, Awaited<ReturnType<typeof probeAndVerify>>>();

    for (const domain of domains) {
      let rdap = null;
      if (options.useRdap !== false && rdapSupports(domain)) {
        try {
          rdap = await lookupRdapRegistrant({ http: deps.http, logger: deps.logger }, domain);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }

      let bundle: Awaited<ReturnType<typeof probeAndVerify>>;
      try {
        bundle = await probeAndVerify(deps, row, domain, 'observed', rdap);
      } catch (error) {
        errors.push(`${domain}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      report.domainsProbed += 1;
      bundles.set(domain, bundle);

      const facts = bundle.probe.html ?? bundle.probe.legalHtml ?? '';
      const crossCampaign = await crossCampaignCorroboration(deps.sql, row.id, row.registry_id, domain);

      adjudications.push(
        adjudicateProbableDomain({
          prospectId: row.id,
          displayName: row.display_name,
          candidateDomain: domain,
          verdict: bundle.verdict,
          prospect: { email: row.email, instagramHandle: row.instagram_handle },
          observed: {
            instagram: instagramLinksOf(bundle),
            registryIdsOnSite: bundle.registryIdsOnSite.sirens,
          },
          readable: facts.trim().length > 0,
          proposedForOtherProspects: sharedWithOtherProspects(sharing, domain, row.id),
          crossCampaignSameRegistryId: crossCampaign,
        }),
      );
    }

    const prospectVerdict = adjudicateProspect(row.id, row.display_name, adjudications);
    const outcome: ProbableDomainOutcome = {
      ...prospectVerdict,
      campaignSlug: row.campaign_slug,
      resolutionReason: row.resolution_reason,
      attachedDomain: null,
      attachedUrl: null,
      collisionWith: null,
      crawlPages: null,
      errors,
    };

    if (persist) {
      for (const adjudication of prospectVerdict.candidates) {
        await deps.repo.addEvidence(row.id, {
          field: 'domain_identity_adjudication',
          valueText: `${adjudication.decision} — ${adjudication.candidateDomain}${
            adjudication.decidedBy ? ` (${adjudication.decidedBy})` : ''
          }`,
          valueJson: adjudication,
          provider: IDENTITY_VERIFIER_PROVIDER,
          method: 'derived',
          sourceUrl: `https://${adjudication.candidateDomain}/`,
          confidence: adjudication.confidence,
          observedAt: now().toISOString(),
        });
      }
    }

    if (attach && prospectVerdict.attachableDomain) {
      const domain = prospectVerdict.attachableDomain;
      const bundle = bundles.get(domain);
      if (bundle) {
        const owner = await deps.repo.findByIdentityKey(row.campaign_id, 'domain', domain);
        if (owner && owner !== row.id) {
          /**
           * Un autre prospect porte déjà ce domaine. Deux entreprises ne
           * partagent pas un site : plutôt que d'écrire par-dessus, on met les
           * deux lignes en revue et on n'attache rien.
           */
          outcome.collisionWith = owner;
          await deps.repo.recordMergeCandidate(row.campaign_id, row.id, owner, bundle.verdict.confidence, {
            reason: 'même domaine adjugé CONFIRMED par le vérificateur R7.2B.1',
            domain,
          });
        } else {
          const url = normalizeUrl(bundle.probe.finalUrl ?? `https://${domain}/`);
          await attachConfirmedDomain(deps, row, bundle, domain, url, now());
          outcome.attachedDomain = domain;
          outcome.attachedUrl = url;
          report.attached += 1;

          if (webintel && url) {
            const pages = await crawlAttachedSite(deps, webintel, row.id, url);
            outcome.crawlPages = pages;
            if (pages === null) report.crawlFailed += 1;
            else report.crawlSucceeded += 1;
          }
        }
      }
    }

    if (outcome.decision === 'CONFIRMED') report.confirmed += 1;
    else if (outcome.decision === 'REJECTED') report.rejected += 1;
    else report.reviewRequired += 1;

    report.outcomes.push(outcome);
    deps.logger.info('r7.verify_domains.prospect', {
      prospectId: row.id,
      decision: outcome.decision,
      domains: domains.length,
      attached: outcome.attachedDomain,
    });
  }

  /**
   * Le rattrapage : les sites rattachés par ce vérificateur qu'aucun crawl n'a
   * encore lus. Après un rattachement, le prospect n'a plus sa place dans la
   * cohorte des `probable` — sans cette passe, un enchaînement interrompu
   * laisserait un domaine écrit et jamais ouvert.
   */
  if (webintel) {
    const done = new Set(report.outcomes.filter((item) => item.crawlPages !== null).map((item) => item.prospectId));
    for (const row of await loadCrawlBacklog(deps.sql)) {
      if (done.has(row.id)) continue;
      const pages = await crawlAttachedSite(deps, webintel, row.id, row.website_url);
      if (pages === null) report.crawlFailed += 1;
      else report.crawlSucceeded += 1;
      const existing = report.outcomes.find((item) => item.prospectId === row.id);
      if (existing) existing.crawlPages = pages;
      deps.logger.info('r7.verify_domains.crawl_backlog', { prospectId: row.id, pages });
    }
  }

  return report;
}

/**
 * Lit le site fraîchement rattaché avec le crawler du pipeline.
 *
 * `fillMissingColumns` ne remplit là encore que des blancs : un e-mail ou un
 * téléphone déjà observés ailleurs ne sont pas écrasés par ce que dit la page.
 * Renvoie le nombre de pages lues, ou null quand le crawl a échoué.
 */
async function crawlAttachedSite(
  deps: ProbableDomainRailDeps,
  webintel: NonNullable<ReturnType<typeof createWebIntelClient>>,
  prospectId: string,
  websiteUrl: string,
): Promise<number | null> {
  const crawl = await crawlViaWebIntel(webintel, deps.logger, websiteUrl, deps.niche, 6);
  if (!crawl) return null;
  for (const item of crawl.evidence) await deps.repo.addEvidence(prospectId, item);
  await deps.repo.fillMissingColumns(prospectId, {
    email: crawl.contact.email,
    phone: crawl.contact.phone,
    instagram_handle: crawl.contact.instagramHandle,
    facebook_url: crawl.contact.facebookUrl,
  });
  return crawl.pagesCrawled.length;
}

/**
 * Les comptes Instagram que le site lie lui-même.
 *
 * Relus depuis le HTML déjà en mémoire — `probeAndVerify` les a donnés au
 * vérificateur R3, qui n'en fait rien et ne les ressort pas. Aucune page n'est
 * ouverte une seconde fois.
 */
export function instagramLinksOf(bundle: Pick<Awaited<ReturnType<typeof probeAndVerify>>, 'probe'>): string[] {
  const pages: [string, string][] = [];
  if (bundle.probe.html) pages.push([bundle.probe.html, bundle.probe.finalUrl ?? 'https://example.invalid/']);
  if (bundle.probe.legalHtml) pages.push([bundle.probe.legalHtml, bundle.probe.legalPageUrl ?? 'https://example.invalid/']);
  return [...new Set(pages.flatMap(([html, url]) => extractPageFacts(html, url).instagram))];
}

/** Écrit ce que le site a dit, avec sa provenance. Aucune colonne déjà remplie. */
async function attachConfirmedDomain(
  deps: ProbableDomainRailDeps,
  row: ProbableProspectRow,
  bundle: Awaited<ReturnType<typeof probeAndVerify>>,
  domain: string,
  websiteUrl: string | null,
  now: Date,
): Promise<void> {
  const sourceUrl = bundle.probe.finalUrl ?? `https://${domain}/`;
  const observedAt = now.toISOString();

  await deps.repo.addEvidence(row.id, {
    field: 'website_url',
    valueText: websiteUrl ?? sourceUrl,
    valueJson: {
      adjudication: 'CONFIRMED',
      verdict: bundle.verdict.verdict,
      confidence: bundle.verdict.confidence,
      signals: bundle.verdict.signals.filter((signal) => signal.matched).map((signal) => signal.key),
      reasons: bundle.verdict.reasons,
    },
    provider: IDENTITY_VERIFIER_PROVIDER,
    method: 'crawl',
    sourceUrl,
    confidence: bundle.verdict.confidence,
    observedAt,
  });

  await deps.repo.fillMissingColumns(row.id, { website_url: websiteUrl, domain });

  if (bundle.mentions && hasUsableMentions(bundle.mentions)) {
    await deps.repo.addEvidence(row.id, {
      field: 'legal_mentions',
      valueText: [bundle.mentions.legalName, bundle.mentions.city, bundle.mentions.siren].filter(Boolean).join(' — '),
      valueJson: bundle.mentions,
      provider: IDENTITY_VERIFIER_PROVIDER,
      method: 'crawl',
      sourceUrl: bundle.probe.legalPageUrl ?? sourceUrl,
      confidence: 1,
      observedAt,
    });
  }

  await deps.repo.recordIdentityKeys(row.campaign_id, row.id, identityKeys({ domain, websiteUrl }));
}
