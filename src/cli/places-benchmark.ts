#!/usr/bin/env tsx
/**
 * Mesure du corpus R2 (Places-first) et comparaison avec la ligne de base R1
 * (registry-first), sur les données déjà en base.
 *
 *   npm run places:benchmark
 *   npm run places:benchmark -- --campaign example-campaign --limit 100
 *   npm run places:benchmark -- --baseline example-campaign --dry-run
 *
 * Ce que cette commande est, et ce qu'elle n'est pas :
 *
 *   - elle MESURE un corpus existant. Elle ne découvre rien, n'appelle aucune
 *     API et n'écrit RIEN en base : c'est `campaign:run` qui produit le corpus,
 *     et un outil de mesure qui modifie ce qu'il mesure ne mesure plus rien.
 *     Elle compte au passage les coordonnées Places dont le bail de 30 jours a
 *     expiré (Maps Service Specific Terms §14.3) et l'imprime ; la suppression
 *     elle-même appartient au rail Places, qui l'exécute au début de chaque run.
 *   - les deux mesures R2 (`contactable`, `funnel_observable`) sont recalculées
 *     ici par les mêmes fonctions testées que le pipeline
 *     (`src/lib/pipeline/reach.ts`) plutôt que lues dans les colonnes. R1 est
 *     antérieur à ces colonnes : les lire donnerait « 0 » pour R1, ce qui
 *     mesurerait l'âge du schéma, pas la réalité des prospects.
 *   - si la campagne R2 n'a aucun prospect, elle le dit et sort en erreur.
 *     Un tableau de zéros ressemble à un résultat et n'en est pas un.
 *
 * `--dry-run` mesure et imprime sans écrire les deux fichiers de rapport.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { getSql } from '@/lib/db';
import { envBool } from '@/lib/env';
import { limitsFromEnv, type PlacesBudgetLimits } from '@/lib/discovery/places/budget';
import { placesAvailability } from '@/lib/discovery/places/client';
import { countExpiredLocations } from '@/lib/discovery/places/retention';
import { assessReach, isQualifiedContactableObservable } from '@/lib/pipeline/reach';
import type { EvidenceLike, SignalResult } from '@/lib/pipeline/score';
import type { ProspectRow } from '@/lib/repo/types';
import type { Sql } from '@/lib/db/sql';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * `ProspectRow` porte déjà les colonnes de provenance et de reach ajoutées par
 * la migration 0003 ; l'alias existe pour que le corpus se nomme dans le code.
 */
type CorpusProspect = ProspectRow;

interface OriginRow {
  prospect_id: string;
  provider: string;
  rail: string;
}

interface CorpusMetrics {
  prospects: number;
  inNiche: number;
  withWebsite: number;
  withPhone: number;
  withEmail: number;
  withInstagram: number;
  withFacebook: number;
  crawled: number;
  withFunnelEvidence: number;
  contactable: number;
  funnelObservable: number;
  qualifiedContactableObservable: number;
  registryResolved: number;
  multiSource: number;
  evidenceTotal: number;
  evidenceAverage: number;
}

interface CampaignCorpus {
  slug: string;
  name: string;
  totalInDb: number;
  measured: number;
  all: CorpusMetrics;
  inNiche: CorpusMetrics;
  prospects: CorpusProspect[];
  evidence: Map<string, EvidenceLike[]>;
  origins: Map<string, OriginRow[]>;
}

interface PlacesFunnel {
  expiredLocationsPending: number;
  discovered: number;
  inArea: number;
  qualified: number;
  identified: number;
  unidentified: number;
  rejected: number;
  rejectReasons: { reason: string; count: number }[];
}

interface TierUsage {
  skuTier: string;
  calls: number;
  billable: number;
  free: number;
  cacheHits: number;
  results: number;
  errors: number;
}

interface CostSection {
  enabled: boolean;
  availabilityReason: string | null;
  campaignCalls: number;
  byTier: TierUsage[];
  billable: number;
  free: number;
  cacheHits: number;
  monthToDateBillable: number;
  monthToDateDiscovery: number;
  monthToDateDetails: number;
  todayBillable: number;
  limits: PlacesBudgetLimits;
}

interface TopProspect {
  rank: number;
  name: string;
  city: string | null;
  score: number | null;
  band: string | null;
  rails: string;
  channels: string;
  funnelObservable: boolean;
  reason: string;
}

const FUNNEL_EVIDENCE_FIELDS = ['funnel_observed', 'funnel_not_observed'];
const CRAWL_EVIDENCE_FIELD = 'website_quality';

// ---------------------------------------------------------------------------
// Mesure
// ---------------------------------------------------------------------------

function emptyMetrics(): CorpusMetrics {
  return {
    prospects: 0,
    inNiche: 0,
    withWebsite: 0,
    withPhone: 0,
    withEmail: 0,
    withInstagram: 0,
    withFacebook: 0,
    crawled: 0,
    withFunnelEvidence: 0,
    contactable: 0,
    funnelObservable: 0,
    qualifiedContactableObservable: 0,
    registryResolved: 0,
    multiSource: 0,
    evidenceTotal: 0,
    evidenceAverage: 0,
  };
}

/**
 * Snapshot d'un ensemble de prospects.
 *
 * Tout se calcule ici sur des observations stockées : une colonne renseignée,
 * une ligne `prospect_evidence`, une ligne `prospect_discovery_origins`. Rien
 * n'est déduit ni supposé.
 */
function measure(
  prospects: CorpusProspect[],
  evidence: Map<string, EvidenceLike[]>,
  origins: Map<string, OriginRow[]>,
): CorpusMetrics {
  const metrics = emptyMetrics();
  metrics.prospects = prospects.length;

  for (const prospect of prospects) {
    const items = evidence.get(prospect.id) ?? [];
    const fields = new Set(items.map((item) => item.field));

    if (prospect.niche_verdict === 'in_niche') metrics.inNiche += 1;
    if (prospect.website_url) metrics.withWebsite += 1;
    if (prospect.phone) metrics.withPhone += 1;
    if (prospect.email) metrics.withEmail += 1;
    if (prospect.instagram_handle) metrics.withInstagram += 1;
    if (prospect.facebook_url) metrics.withFacebook += 1;
    if (fields.has(CRAWL_EVIDENCE_FIELD)) metrics.crawled += 1;
    if (FUNNEL_EVIDENCE_FIELDS.some((field) => fields.has(field))) metrics.withFunnelEvidence += 1;
    if (prospect.registry_id) metrics.registryResolved += 1;
    if ((origins.get(prospect.id) ?? []).length > 1) metrics.multiSource += 1;

    const reach = assessReach({ prospect, evidence: items });
    if (reach.contactable) metrics.contactable += 1;
    if (reach.funnelObservable) metrics.funnelObservable += 1;
    if (isQualifiedContactableObservable(prospect, items)) metrics.qualifiedContactableObservable += 1;

    metrics.evidenceTotal += items.length;
  }

  metrics.evidenceAverage =
    metrics.prospects === 0 ? 0 : Number((metrics.evidenceTotal / metrics.prospects).toFixed(2));
  return metrics;
}

async function loadCorpus(sql: Sql, slug: string, limit: number): Promise<CampaignCorpus | null> {
  const [campaign] = await sql.query<{ id: string; name: string }>(
    'select id, name from campaigns where slug = $1',
    [slug],
  );
  if (!campaign) return null;

  const [total] = await sql.query<{ count: string }>(
    `select count(*)::text as count from prospects where campaign_id = $1 and dedupe_status <> 'merged'`,
    [campaign.id],
  );

  const prospects = await sql.query<CorpusProspect>(
    `select * from prospects
      where campaign_id = $1 and dedupe_status <> 'merged'
      order by score desc nulls last, display_name asc
      limit $2`,
    [campaign.id, limit],
  );

  const ids = prospects.map((prospect) => prospect.id);
  const evidence = new Map<string, EvidenceLike[]>();
  const origins = new Map<string, OriginRow[]>();

  if (ids.length > 0) {
    const rows = await sql.query<EvidenceLike & { prospect_id: string }>(
      `select prospect_id, field, value_text, value_json, provider, source_url
         from prospect_evidence where prospect_id = any($1::uuid[])`,
      [ids],
    );
    for (const row of rows) {
      const list = evidence.get(row.prospect_id) ?? [];
      list.push(row);
      evidence.set(row.prospect_id, list);
    }

    const originRows = await sql.query<OriginRow>(
      `select prospect_id, provider, rail from prospect_discovery_origins
        where prospect_id = any($1::uuid[]) order by first_seen_at`,
      [ids],
    );
    for (const row of originRows) {
      const list = origins.get(row.prospect_id) ?? [];
      list.push(row);
      origins.set(row.prospect_id, list);
    }
  }

  const inNicheProspects = prospects.filter((prospect) => prospect.niche_verdict === 'in_niche');

  return {
    slug,
    name: campaign.name,
    totalInDb: Number.parseInt(total?.count ?? '0', 10),
    measured: prospects.length,
    all: measure(prospects, evidence, origins),
    inNiche: measure(inNicheProspects, evidence, origins),
    prospects,
    evidence,
    origins,
  };
}

// ---------------------------------------------------------------------------
// Entonnoir Places et coût
// ---------------------------------------------------------------------------

async function placesFunnel(sql: Sql, slug: string, expiredLocationsPending: number): Promise<PlacesFunnel> {
  const statuses = await sql.query<{ status: string; count: string }>(
    `select status, count(*)::text as count from google_place_candidates
       where campaign_id = (select id from campaigns where slug = $1)
       group by status`,
    [slug],
  );
  const of = (status: string): number =>
    Number.parseInt(statuses.find((row) => row.status === status)?.count ?? '0', 10);

  const reasons = await sql.query<{ reject_reason: string | null; count: string }>(
    `select reject_reason, count(*)::text as count from google_place_candidates
       where campaign_id = (select id from campaigns where slug = $1)
         and reject_reason is not null
       group by reject_reason order by count(*) desc`,
    [slug],
  );

  const discovered = statuses.reduce((sum, row) => sum + Number.parseInt(row.count, 10), 0);

  return {
    expiredLocationsPending,
    discovered,
    inArea: of('in_area'),
    qualified: of('qualified'),
    identified: of('identified'),
    unidentified: of('unidentified'),
    rejected: of('rejected'),
    rejectReasons: reasons.map((row) => ({
      reason: row.reject_reason ?? 'motif non renseigné',
      count: Number.parseInt(row.count, 10),
    })),
  };
}

async function costSection(sql: Sql, slug: string): Promise<CostSection> {
  const availability = placesAvailability();

  const tiers = await sql.query<{
    sku_tier: string;
    calls: string;
    billable: string;
    cache_hits: string;
    results: string;
    errors: string;
  }>(
    `select sku_tier,
            count(*)::text                                   as calls,
            count(*) filter (where billable)::text           as billable,
            count(*) filter (where cache_hit)::text          as cache_hits,
            coalesce(sum(results_count), 0)::text            as results,
            count(*) filter (where error is not null)::text  as errors
       from google_places_usage where campaign_slug = $1
      group by sku_tier order by sku_tier`,
    [slug],
  );

  const byTier: TierUsage[] = tiers.map((row) => {
    const calls = Number.parseInt(row.calls, 10);
    const billable = Number.parseInt(row.billable, 10);
    return {
      skuTier: row.sku_tier,
      calls,
      billable,
      free: calls - billable,
      cacheHits: Number.parseInt(row.cache_hits, 10),
      results: Number.parseInt(row.results, 10),
      errors: Number.parseInt(row.errors, 10),
    };
  });

  // Les plafonds du garde-fou comptent tous les appels facturables, campagnes
  // confondues : c'est cette portée-là qu'il faut afficher à côté des limites.
  const [global] = await sql.query<{
    month_billable: string;
    month_discovery: string;
    month_details: string;
    today_billable: string;
  }>(
    `select count(*) filter (where billable and occurred_on >= date_trunc('month', now() at time zone 'utc')::date)::text as month_billable,
            count(*) filter (where billable and occurred_on >= date_trunc('month', now() at time zone 'utc')::date
                             and (sku_tier like 'essentials:%' or sku_tier like 'pro:%'))::text as month_discovery,
            count(*) filter (where billable and occurred_on >= date_trunc('month', now() at time zone 'utc')::date
                             and (sku_tier like 'enterprise:%' or sku_tier like 'enterprise_atmosphere:%'))::text as month_details,
            count(*) filter (where billable and occurred_on = (now() at time zone 'utc')::date)::text as today_billable
       from google_places_usage`,
  );

  return {
    enabled: availability.ok,
    availabilityReason: availability.ok ? null : (availability.reason ?? 'indisponible'),
    campaignCalls: byTier.reduce((sum, tier) => sum + tier.calls, 0),
    byTier,
    billable: byTier.reduce((sum, tier) => sum + tier.billable, 0),
    free: byTier.reduce((sum, tier) => sum + tier.free, 0),
    cacheHits: byTier.reduce((sum, tier) => sum + tier.cacheHits, 0),
    monthToDateBillable: Number.parseInt(global?.month_billable ?? '0', 10),
    monthToDateDiscovery: Number.parseInt(global?.month_discovery ?? '0', 10),
    monthToDateDetails: Number.parseInt(global?.month_details ?? '0', 10),
    todayBillable: Number.parseInt(global?.today_billable ?? '0', 10),
    limits: limitsFromEnv(),
  };
}

// ---------------------------------------------------------------------------
// Top 20
// ---------------------------------------------------------------------------

interface ScoreRow {
  prospect_id: string;
  total: number;
  band: string;
  deterministic: unknown;
}

function signalsOf(deterministic: unknown): SignalResult[] {
  if (!deterministic || typeof deterministic !== 'object') return [];
  const signals = (deterministic as { signals?: unknown }).signals;
  if (!Array.isArray(signals)) return [];
  return signals.filter((signal): signal is SignalResult => {
    if (!signal || typeof signal !== 'object') return false;
    const candidate = signal as Partial<SignalResult>;
    return typeof candidate.key === 'string' && typeof candidate.label === 'string';
  });
}

/**
 * Le motif du classement, tiré des signaux stockés — jamais d'une reformulation.
 * Les trois signaux qui rapportent le plus, avec leur détail tel qu'il a été
 * enregistré au moment du scoring.
 */
function rankingReason(signals: SignalResult[]): string {
  const observed = signals
    .filter((signal) => signal.observed && signal.points > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, 3);
  if (observed.length === 0) return 'aucun signal positif observé';
  return observed
    .map((signal) => `${signal.label} ${signal.points}/${signal.max} (${signal.detail})`)
    .join(' · ');
}

async function topProspects(sql: Sql, corpus: CampaignCorpus, count: number): Promise<TopProspect[]> {
  const ids = corpus.prospects.map((prospect) => prospect.id);
  const scores = new Map<string, ScoreRow>();
  if (ids.length > 0) {
    const rows = await sql.query<ScoreRow>(
      `select distinct on (prospect_id) prospect_id, total, band, deterministic
         from prospect_scores where prospect_id = any($1::uuid[])
        order by prospect_id, created_at desc`,
      [ids],
    );
    for (const row of rows) scores.set(row.prospect_id, row);
  }

  return corpus.prospects.slice(0, count).map((prospect, index) => {
    const items = corpus.evidence.get(prospect.id) ?? [];
    const reach = assessReach({ prospect, evidence: items });
    const origins = corpus.origins.get(prospect.id) ?? [];
    const score = scores.get(prospect.id);

    const rails =
      origins.length > 0
        ? [...new Set(origins.map((origin) => `${origin.rail}:${origin.provider}`))].join(', ')
        : prospect.discovery_rail
          ? `${prospect.discovery_rail}${prospect.discovery_provider ? `:${prospect.discovery_provider}` : ''}`
          : '—';

    return {
      rank: index + 1,
      name: prospect.display_name,
      city: prospect.city,
      score: prospect.score,
      band: prospect.score_band,
      rails,
      channels: reach.channels.length > 0 ? reach.channels.join(', ') : '—',
      funnelObservable: reach.funnelObservable,
      reason: score ? rankingReason(signalsOf(score.deterministic)) : 'score non enregistré',
    };
  });
}

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number(((numerator / denominator) * 100).toFixed(1));
}

interface BenchmarkReport {
  generatedAt: string;
  dryRun: boolean;
  limit: number;
  baseline: { slug: string; name: string; totalInDb: number; measured: number };
  campaign: { slug: string; name: string; totalInDb: number; measured: number };
  metrics: {
    baselineAll: CorpusMetrics;
    campaignAll: CorpusMetrics;
    baselineInNiche: CorpusMetrics;
    campaignInNiche: CorpusMetrics;
  };
  places: PlacesFunnel;
  cost: CostSection;
  top: TopProspect[];
}

type MetricKey = keyof Omit<CorpusMetrics, 'prospects' | 'evidenceTotal' | 'evidenceAverage'>;

const METRIC_LABELS: { key: MetricKey; label: string }[] = [
  { key: 'inNiche', label: 'in_niche' },
  { key: 'withWebsite', label: 'Site web résolu' },
  { key: 'withPhone', label: 'Téléphone' },
  { key: 'withEmail', label: 'E-mail' },
  { key: 'withInstagram', label: 'Instagram' },
  { key: 'withFacebook', label: 'Facebook' },
  { key: 'crawled', label: 'Site lu (evidence website_quality)' },
  { key: 'withFunnelEvidence', label: 'Signaux funnel observés' },
  { key: 'contactable', label: 'Contactable' },
  { key: 'funnelObservable', label: 'Funnel observable' },
  { key: 'qualifiedContactableObservable', label: '**Qualifié + contactable + observable**' },
  { key: 'registryResolved', label: 'Identité légale résolue (registre)' },
  { key: 'multiSource', label: 'Trouvé par plus d’une source' },
];

function comparisonTable(
  baseline: CorpusMetrics,
  campaign: CorpusMetrics,
  denominator: 'prospects' | 'inNiche',
  skip: MetricKey[] = [],
): string[] {
  const baseDen = denominator === 'prospects' ? baseline.prospects : baseline.inNiche;
  const campDen = denominator === 'prospects' ? campaign.prospects : campaign.inNiche;

  const lines = [
    '| Métrique | Registry-first R1 | Places-first R2 | Δ |',
    '| --- | ---: | ---: | ---: |',
    `| Prospects mesurés | ${baseline.prospects} | ${campaign.prospects} | ${signed(campaign.prospects - baseline.prospects)} |`,
  ];

  for (const { key, label } of METRIC_LABELS) {
    if (skip.includes(key)) continue;
    const a = baseline[key];
    const b = campaign[key];
    const ra = rate(a, baseDen);
    const rb = rate(b, campDen);
    lines.push(`| ${label} | ${a} (${ra} %) | ${b} (${rb} %) | ${signed(Number((rb - ra).toFixed(1)))} pts |`);
  }

  lines.push(
    `| Evidences (total) | ${baseline.evidenceTotal} | ${campaign.evidenceTotal} | ${signed(campaign.evidenceTotal - baseline.evidenceTotal)} |`,
    `| Evidences par prospect | ${baseline.evidenceAverage} | ${campaign.evidenceAverage} | ${signed(Number((campaign.evidenceAverage - baseline.evidenceAverage).toFixed(2)))} |`,
  );
  return lines;
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value}`;
}

/**
 * Rend une valeur observée sûre dans une cellule de tableau.
 *
 * Un détail de signal peut contenir une barre verticale ou un retour à la ligne
 * — les échapper préserve le tableau sans altérer l'observation.
 */
function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
}

function renderMarkdown(report: BenchmarkReport): string {
  const { cost } = report;
  const pct = (used: number, limit: number): string => `${rate(used, limit)} %`;

  return [
    `# Benchmark Places-first — ${report.generatedAt}`,
    '',
    `Comparaison de deux stratégies de découverte sur les corpus déjà en base.` +
      `${report.dryRun ? ' **Mesure seule, aucun fichier écrit hors stdout.**' : ''}`,
    '',
    `- Ligne de base R1 : \`${report.baseline.slug}\` — ${report.baseline.name} · ` +
      `${report.baseline.measured} prospects mesurés sur ${report.baseline.totalInDb} en base`,
    `- Campagne R2 : \`${report.campaign.slug}\` — ${report.campaign.name} · ` +
      `${report.campaign.measured} prospects mesurés sur ${report.campaign.totalInDb} en base`,
    `- Corpus plafonné à ${report.limit} prospects par campagne (\`--limit\`), triés par score décroissant.`,
    '',
    '## Corpus complet',
    '',
    'Pourcentages rapportés à l’ensemble des prospects de la campagne. Δ en points de pourcentage.',
    '',
    ...comparisonTable(report.metrics.baselineAll, report.metrics.campaignAll, 'prospects'),
    '',
    '## Sous-ensemble `in_niche`',
    '',
    'Pourcentages rapportés aux seuls prospects classés `in_niche`.',
    '',
    ...comparisonTable(report.metrics.baselineInNiche, report.metrics.campaignInNiche, 'inNiche', ['inNiche']),
    '',
    '> « Trouvé par plus d’une source » se lit dans `prospect_discovery_origins`, table créée par la',
    '> migration 0003 (R2). Un corpus antérieur n’y a aucune ligne : la valeur R1 mesure l’absence du',
    '> registre de provenance, pas l’absence de sources multiples.',
    '',
    '## Entonnoir Places',
    '',
    '| Étape | Candidats |',
    '| --- | ---: |',
    `| \`place_id\` découverts | ${report.places.discovered} |`,
    `| dans la zone (\`in_area\`) | ${report.places.inArea} |`,
    `| retenus par le pré-filtre niche (\`qualified\`) | ${report.places.qualified} |`,
    `| identifiés par une source indépendante | ${report.places.identified} |`,
    `| trouvés mais non identifiables | ${report.places.unidentified} |`,
    `| écartés | ${report.places.rejected} |`,
    '',
    ...(report.places.rejectReasons.length > 0
      ? ['Motifs d’écartement :', '', ...report.places.rejectReasons.map((row) => `- ${cell(row.reason)} : ${row.count}`), '']
      : ['Aucun motif d’écartement enregistré.', '']),
    `Coordonnées Places dont le bail de 30 jours est échu : ${report.places.expiredLocationsPending} ` +
      '(supprimées au prochain run du rail — ce rapport ne modifie rien).',
    '',
    '## Coût',
    '',
    cost.enabled
      ? '_Rail Places activé._'
      : `_Rail Places non activé : ${cost.availabilityReason}._`,
    '',
    '| Palier SKU | Appels | Facturables | Gratuits | Cache | Résultats | Erreurs |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...(cost.byTier.length > 0
      ? cost.byTier.map(
          (tier) =>
            `| \`${tier.skuTier}\` | ${tier.calls} | ${tier.billable} | ${tier.free} | ${tier.cacheHits} | ${tier.results} | ${tier.errors} |`,
        )
      : ['| _aucun appel enregistré pour cette campagne_ | 0 | 0 | 0 | 0 | 0 | 0 |']),
    '',
    'Consommation face aux plafonds applicatifs (`limitsFromEnv`, portée : tout le registre,',
    'toutes campagnes confondues — c’est la portée que le garde-fou compte réellement) :',
    '',
    '| Plafond | Consommé | Limite | Part |',
    '| --- | ---: | ---: | ---: |',
    `| Facturables aujourd’hui (UTC) | ${cost.todayBillable} | ${cost.limits.daily} | ${pct(cost.todayBillable, cost.limits.daily)} |`,
    `| Découverte (Essentials + Pro), mois en cours | ${cost.monthToDateDiscovery} | ${cost.limits.monthlyDiscovery} | ${pct(cost.monthToDateDiscovery, cost.limits.monthlyDiscovery)} |`,
    `| Détails (Enterprise), mois en cours | ${cost.monthToDateDetails} | ${cost.limits.monthlyDetails} | ${pct(cost.monthToDateDetails, cost.limits.monthlyDetails)} |`,
    `| Appels facturables par run | — | ${cost.limits.run} | — |`,
    `| Appels totaux par run (garde anti-boucle) | — | ${cost.limits.runCalls} | — |`,
    '',
    `**${cost.monthToDateBillable} appel(s) facturable(s) depuis le début du mois.** Le volume que`,
    'l’application s’autorise reste dans les plafonds mensuels sans frais documentés à ce jour',
    `(découverte ${cost.monthToDateDiscovery}/${cost.limits.monthlyDiscovery}, détails ${cost.monthToDateDetails}/${cost.limits.monthlyDetails},`,
    'eux-mêmes fixés sous les paliers gratuits Google : Essentials 10 000, Pro 5 000, Enterprise 1 000).',
    '',
    'Ce n’est pas une facture. Les paliers de volume s’agrègent **par compte de facturation**, tous',
    'projets confondus : ce tableau est notre propre comptage local, pas le décompte de Google. Si le',
    'compte sert aussi à un autre travail, les paliers gratuits sont partagés et ce comptage ne voit',
    'pas la consommation des autres projets. Voir la documentation d’installation, section 6.',
    '',
    '## Top 20 prospects',
    '',
    '| # | Prospect | Ville | Score | Bande | Rail(s) | Canaux | Funnel observable | Motif du classement |',
    '| ---: | --- | --- | ---: | --- | --- | --- | --- | --- |',
    ...report.top.map(
      (row) =>
        `| ${row.rank} | ${cell(row.name)} | ${cell(row.city ?? '—')} | ${row.score ?? '—'} | ${row.band ?? '—'} | ` +
        `${cell(row.rails)} | ${row.channels} | ${row.funnelObservable ? 'oui' : 'non'} | ${cell(row.reason)} |`,
    ),
    '',
    'Les motifs sont recopiés des signaux déterministes stockés dans `prospect_scores.deterministic`.',
    'Une valeur non observée s’affiche « — » et n’est jamais remplacée par une supposition.',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Entrée
// ---------------------------------------------------------------------------

function arg(name: string, fallback: string | null = null): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  return process.argv[index + 1] ?? fallback;
}

async function main(): Promise<void> {
  // Le garde-fou passe avant la base : rien ne s'ouvre tant que la posture du
  // dépôt n'est pas vérifiée.
  if (envBool('OUTBOUND_ALLOW_SENDING', false)) {
    throw new Error(
      'OUTBOUND_ALLOW_SENDING must stay 0 in V1: this build has no sending code and must not pretend to.',
    );
  }

  const dryRun = process.argv.includes('--dry-run');
  const slug = arg('campaign', 'example-campaign') as string;
  const baselineSlug = arg('baseline', 'example-campaign') as string;
  const limit = Number.parseInt(arg('limit', '100') as string, 10);
  const reportDir = resolvePath(process.cwd(), arg('report', 'var/benchmarks') as string);

  const sql = await getSql();

  // Le bail de 30 jours sur les coordonnées Places est une obligation réelle,
  // mais ce n'est pas à un outil de mesure de l'exécuter : une commande qui
  // annonce « mesure seule » et supprime quand même est indiscernable d'une
  // commande sûre, jusqu'au jour où elle supprime la mauvaise ligne. Le bail est
  // honoré au début de chaque run du rail Places (runPlacesRail). Ici on compte,
  // et on le dit.
  const expiredLocationsPending = await countExpiredLocations(sql);

  const campaign = await loadCorpus(sql, slug, limit);
  if (!campaign || campaign.totalInDb === 0) {
    process.stdout.write(
      `\nLa campagne « ${slug} » ${campaign ? "n'a aucun prospect en base" : "n'existe pas en base"}.\n` +
        'Ce benchmark mesure un corpus existant : il ne découvre rien, et un tableau de zéros\n' +
        'ressemblerait à un résultat sans en être un. Aucun rapport n’est écrit.\n' +
        `Coordonnées Places dont le bail de 30 jours est échu (purgées au prochain run du rail) : ${expiredLocationsPending}.\n\n` +
        'Pour produire le corpus d’abord :\n' +
        `  npm run campaign:run -- --campaign ${slug}\n` +
        '(le rail commercial ne partira que si GOOGLE_PLACES_ENABLED=1 et qu’une clé existe —\n' +
        ' vérifiable sans frais par : npm run places:probe)\n\n',
    );
    await sql.close();
    process.exitCode = 1;
    return;
  }

  const baseline = await loadCorpus(sql, baselineSlug, limit);
  if (!baseline) {
    process.stdout.write(
      `\nLa campagne de référence « ${baselineSlug} » n'existe pas en base : la comparaison\n` +
        'R1 / R2 n’a pas d’objet. Choisir une autre référence avec --baseline.\n\n',
    );
    await sql.close();
    process.exitCode = 1;
    return;
  }

  const report: BenchmarkReport = {
    generatedAt: new Date().toISOString(),
    dryRun,
    limit,
    baseline: {
      slug: baseline.slug,
      name: baseline.name,
      totalInDb: baseline.totalInDb,
      measured: baseline.measured,
    },
    campaign: {
      slug: campaign.slug,
      name: campaign.name,
      totalInDb: campaign.totalInDb,
      measured: campaign.measured,
    },
    metrics: {
      baselineAll: baseline.all,
      campaignAll: campaign.all,
      baselineInNiche: baseline.inNiche,
      campaignInNiche: campaign.inNiche,
    },
    places: await placesFunnel(sql, slug, expiredLocationsPending),
    cost: await costSection(sql, slug),
    top: await topProspects(sql, campaign, 20),
  };

  const markdown = renderMarkdown(report);
  process.stdout.write(`\n${markdown}\n`);

  if (!dryRun) {
    await mkdir(reportDir, { recursive: true });
    const stamp = report.generatedAt.replace(/[:.]/g, '-');
    const jsonPath = resolvePath(reportDir, `places-${stamp}.json`);
    const mdPath = resolvePath(reportDir, `places-${stamp}.md`);
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeFile(mdPath, markdown, 'utf8');
    process.stdout.write(`Rapport JSON : ${jsonPath}\n`);
    process.stdout.write(`Rapport MD   : ${mdPath}\n`);
  } else {
    process.stdout.write('--dry-run : aucun fichier de rapport écrit.\n');
  }

  await sql.close();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
