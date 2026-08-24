import 'server-only';
import { getSql } from '@/lib/db';
import type { Sql } from '@/lib/db/sql';
import { commercialVisibility } from '@/lib/pipeline/reach';
import type { ProspectRow } from '@/lib/repo/types';

export interface Kpis {
  discovered: number;
  inNiche: number;
  qualified: number;
  readyForReview: number;
  approved: number;
  rejected: number;
  needsDedupeReview: number;
  // Prepared for the outreach phase; always 0 while V1 is review-only.
  contacted: number;
  replies: number;
  positiveReplies: number;
  calls: number;
  clients: number;
  revenue: number;
}

export interface FunnelStep {
  key: string;
  label: string;
  count: number;
  future: boolean;
}

export interface CampaignSummary {
  id: string;
  slug: string;
  name: string;
  nicheKey: string;
  status: string;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunStats: Record<string, unknown> | null;
}

export interface ProspectListItem extends ProspectRow {
  message_state: string | null;
  message_count: number;
  guardrail_blocked: boolean;
  /** Fournisseurs ayant vu cette entreprise, dans l'ordre de découverte. */
  origins: string[];
}

/** Une ville observée sur au moins un prospect de la campagne. */
export interface CityOption {
  city: string;
  count: number;
}

export interface R2Kpis {
  total: number;
  byRail: { commercial: number; longTail: number; multiSource: number };
  contactable: number;
  funnelObservable: number;
  /**
   * Prospects dont la portée n'a jamais été calculée (colonnes nulles).
   *
   * Sans ce compteur, un corpus antérieur à la migration 0003 affiche
   * « 0 contactable », ce qui est une affirmation d'absence — précisément ce que
   * ce dépôt s'interdit. Un zéro n'est lisible que si l'on sait combien de
   * prospects ont réellement été mesurés.
   */
  notMeasured: number;
  /** in_niche ET contactable ET parcours observable — la mesure de tête de R2. */
  qualifiedContactableObservable: number;
  placesCandidates: {
    discovered: number;
    identified: number;
    unidentified: number;
    rejected: number;
  };
}

/**
 * Le résumé demandé au §16, et l'ordre des colonnes est l'entonnoir lui-même.
 *
 * Chaque nombre est une restriction du précédent, ce qui rend les fuites
 * lisibles d'un coup d'œil : « 30 découvertes, 24 qualifiées, 21 contactables,
 * 9 parcours lus » désigne immédiatement l'étage à travailler. Publier ces cinq
 * nombres côte à côte est ce qui empêche de célébrer un volume de découverte
 * dont rien ne sort.
 *
 * `messageReady` compte les prospects, pas les messages : deux variantes pour
 * une entreprise, c'est un prospect prêt, pas deux.
 */
export interface R5Kpis {
  discovered: number;
  qualified: number;
  contactable: number;
  funnelObservable: number;
  messageReady: number;
  /** Le KPI de tête (§17) : qualifiée ET contactable ET parcours lu. */
  qualifiedContactableObservable: number;
  /** Entreprises dont le parcours a été lu et présente au moins un manque exploitable. */
  withFunnelOpportunity: number;
  identityConfirmed: number;
  identityManualReview: number;
  recommendation: { send: number; edit: number; reject: number; none: number };
  /** Candidats du rail, promus ou non. Un rail doit dire où il fuit. */
  candidates: { total: number; promoted: number; rejected: number; notProbed: number };
}

export interface PlacesCostTier {
  tier: string;
  calls: number;
  billable: number;
  free: number;
  cacheHits: number;
}

export interface PlacesCost {
  byTier: PlacesCostTier[];
  totals: { calls: number; billable: number; free: number; cacheHits: number };
  /** Appels facturables depuis le 1er du mois UTC en cours. */
  billableThisMonth: number;
}

async function sql(): Promise<Sql> {
  return getSql();
}

function toInt(value: string | number | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  return Number.parseInt(value ?? '0', 10) || 0;
}

export async function listCampaigns(): Promise<CampaignSummary[]> {
  const db = await sql();
  const rows = await db.query<{
    id: string;
    slug: string;
    name: string;
    niche_key: string;
    status: string;
    last_run_at: string | null;
    last_run_status: string | null;
    last_run_stats: Record<string, unknown> | null;
  }>(
    `select c.id, c.slug, c.name, c.niche_key, c.status,
            r.started_at as last_run_at, r.status as last_run_status, r.stats as last_run_stats
       from campaigns c
       left join lateral (
         select started_at, status, stats from campaign_runs
          where campaign_id = c.id order by started_at desc limit 1
       ) r on true
      order by c.created_at desc`,
  );
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    nicheKey: row.niche_key,
    status: row.status,
    lastRunAt: row.last_run_at,
    lastRunStatus: row.last_run_status,
    lastRunStats: row.last_run_stats,
  }));
}

export async function getKpis(campaignId: string): Promise<Kpis> {
  const db = await sql();
  const [counts] = await db.query<{
    discovered: string;
    in_niche: string;
    qualified: string;
    needs_review: string;
  }>(
    `select
       count(*) filter (where dedupe_status <> 'merged')::text as discovered,
       count(*) filter (where niche_verdict = 'in_niche')::text as in_niche,
       count(*) filter (where stage in ('qualified','researched','message_ready','approved'))::text as qualified,
       count(*) filter (where dedupe_status = 'needs_review')::text as needs_review
     from prospects where campaign_id = $1`,
    [campaignId],
  );

  const [messages] = await db.query<{ ready: string; approved: string; rejected: string }>(
    `select
       count(distinct prospect_id) filter (where state = 'draft')::text as ready,
       count(distinct prospect_id) filter (where state = 'approved')::text as approved,
       count(distinct prospect_id) filter (where state = 'rejected')::text as rejected
     from outreach_messages where campaign_id = $1 and is_primary = true`,
    [campaignId],
  );

  const [events] = await db.query<{ contacted: string; replies: string }>(
    `select
       count(distinct prospect_id) filter (where kind = 'sent')::text as contacted,
       count(distinct prospect_id) filter (where kind = 'replied')::text as replies
     from outreach_events e
     where exists (select 1 from prospects p where p.id = e.prospect_id and p.campaign_id = $1)`,
    [campaignId],
  );

  return {
    discovered: toInt(counts?.discovered),
    inNiche: toInt(counts?.in_niche),
    qualified: toInt(counts?.qualified),
    readyForReview: toInt(messages?.ready),
    approved: toInt(messages?.approved),
    rejected: toInt(messages?.rejected),
    needsDedupeReview: toInt(counts?.needs_review),
    contacted: toInt(events?.contacted),
    replies: toInt(events?.replies),
    positiveReplies: 0,
    calls: 0,
    clients: 0,
    revenue: 0,
  };
}

export async function getFunnel(campaignId: string): Promise<FunnelStep[]> {
  const db = await sql();
  const rows = await db.query<{ stage: string; count: string }>(
    `select stage, count(*)::text as count from prospects
      where campaign_id = $1 and dedupe_status <> 'merged'
      group by stage`,
    [campaignId],
  );
  const byStage = new Map(rows.map((row) => [row.stage, Number.parseInt(row.count, 10) || 0]));

  const [approved] = await db.query<{ count: string }>(
    `select count(distinct prospect_id)::text as count from outreach_messages
      where campaign_id = $1 and state = 'approved'`,
    [campaignId],
  );

  const reached = (stages: string[]): number =>
    stages.reduce((sum, stage) => sum + (byStage.get(stage) ?? 0), 0);

  return [
    { key: 'discovered', label: 'Discovered', count: reached(['discovered', 'enriched', 'qualified', 'researched', 'message_ready', 'approved', 'rejected', 'excluded']), future: false },
    { key: 'enriched', label: 'Enriched', count: reached(['enriched', 'qualified', 'researched', 'message_ready', 'approved', 'rejected', 'excluded']), future: false },
    { key: 'qualified', label: 'Qualified', count: reached(['qualified', 'researched', 'message_ready', 'approved']), future: false },
    { key: 'researched', label: 'Researched', count: reached(['researched', 'message_ready', 'approved']), future: false },
    { key: 'message_ready', label: 'Message Ready', count: reached(['message_ready', 'approved']), future: false },
    { key: 'approved', label: 'Approved', count: Number.parseInt(approved?.count ?? '0', 10) || 0, future: false },
    { key: 'contacted', label: 'Contacted', count: 0, future: true },
    { key: 'replied', label: 'Replied', count: 0, future: true },
    { key: 'interested', label: 'Interested', count: 0, future: true },
    { key: 'client', label: 'Client', count: 0, future: true },
  ];
}

/**
 * Filtres de la liste de prospects. Ils se **combinent** (ET logique) : un
 * relecteur peut demander « rail commercial ET contactable » sans que l'un
 * remplace l'autre. Une clé inconnue est ignorée plutôt que de vider la liste.
 */
export const PROSPECT_FILTERS: Readonly<Record<string, string>> = {
  in_niche: "p.niche_verdict = 'in_niche'",
  ready: "p.stage = 'message_ready'",
  excluded: "p.stage = 'excluded'",
  review: "p.dedupe_status = 'needs_review'",
  places: "p.discovery_rail = 'commercial'",
  registry: "p.discovery_rail = 'long_tail'",
  multi_source: 'o.origin_count > 1',
  contactable: 'p.contactable is true',
  funnel: 'p.funnel_observable is true',
  site: 'p.website_url is not null',
  instagram: 'p.instagram_handle is not null',

  /**
   * Filtres R3.
   *
   * Ils passent par les tables de provenance plutôt que par
   * `p.discovery_rail` : cette colonne garde le PREMIER rail qui a vu
   * l'entreprise, donc un prospect trouvé au registre puis résolu par le rail
   * web ouvert reste `long_tail` — ce qui est correct, et inutilisable pour
   * répondre à « qu'a rapporté le rail web ouvert ». La question porte sur les
   * origines, qui sont plurielles.
   */
  open_web: "exists (select 1 from prospect_discovery_origins d2 where d2.prospect_id = p.id and d2.rail = 'open_web')",
  facebook_discovered:
    "exists (select 1 from prospect_discovery_origins d3 where d3.prospect_id = p.id and d3.provider = 'facebook_pages')",
  common_crawl:
    'exists (select 1 from discovery_domain_candidates c1 where c1.prospect_id = p.id and coalesce(c1.cc_captures, 0) > 0)',
  /** Un domaine réellement vérifié, pas seulement une colonne `website_url` remplie. */
  domain_confirmed:
    "exists (select 1 from discovery_domain_candidates c2 where c2.prospect_id = p.id and c2.attached and c2.identity_verdict = 'confirmed')",
  /** Candidats écartés pour risque d'homonymie : la file de relecture du rail. */
  homonym_risk:
    'exists (select 1 from discovery_domain_candidates c3 where c3.prospect_id = p.id and c3.homonym_risk and not c3.attached)',

  /**
   * Filtres R5.
   *
   * `commercial_web_discovery` passe par les origines et non par
   * `p.discovery_rail`, pour la même raison qu'en R3 : cette colonne garde le
   * PREMIER rail qui a vu l'entreprise. Une société trouvée au registre en R1
   * puis retrouvée sur le web par R5 reste `long_tail`, ce qui est exact et
   * inutilisable pour répondre à « qu'a rapporté la découverte commerciale ».
   */
  commercial_web_discovery:
    "exists (select 1 from prospect_discovery_origins d4 where d4.prospect_id = p.id and d4.rail = 'commercial_web_discovery')",
  /** Le parcours a été lu ET quelque chose y manque : la file de travail commerciale. */
  funnel_opportunity: 'p.funnel_observable is true and p.funnel_opportunity_count > 0',
  /** Identité à trancher par un humain : le site ne publie aucune identité légale. */
  identity_review: "p.identity_review = 'manual_review'",
  identity_confirmed: "p.identity_review = 'confirmed'",
  recommend_send: "p.outreach_recommendation = 'send'",
  recommend_edit: "p.outreach_recommendation = 'edit'",
  recommend_reject: "p.outreach_recommendation = 'reject'",
};

/** Accepte une clé, un tableau de clés ou une liste séparée par des virgules. */
export function parseProspectFilters(filter?: string | readonly string[] | null): string[] {
  if (filter == null) return [];
  const raw = typeof filter === 'string' ? filter.split(',') : [...filter];
  const seen = new Set<string>();
  for (const entry of raw) {
    const key = entry.trim();
    if (key.length > 0 && key !== 'all') seen.add(key);
  }
  return [...seen];
}

export async function listProspects(
  campaignId: string,
  filter?: string | readonly string[] | null,
  city?: string | null,
): Promise<ProspectListItem[]> {
  const db = await sql();
  const clauses: string[] = ['p.campaign_id = $1', "p.dedupe_status <> 'merged'"];
  const params: unknown[] = [campaignId];

  for (const key of parseProspectFilters(filter)) {
    const clause = PROSPECT_FILTERS[key];
    if (clause) clauses.push(clause);
  }

  const cityFilter = city?.trim();
  if (cityFilter) {
    params.push(cityFilter);
    clauses.push(`lower(p.city) = lower($${params.length})`);
  }

  return db.query<ProspectListItem>(
    `select p.*,
            m.state as message_state,
            coalesce(mc.count, 0)::int as message_count,
            coalesce(m.blocked, false) as guardrail_blocked,
            o.providers as origins
       from prospects p
       left join lateral (
         select state, jsonb_array_length(guardrail_flags) > 0 as blocked
           from outreach_messages
          where prospect_id = p.id and is_primary = true
          order by created_at desc limit 1
       ) m on true
       left join lateral (
         select count(*) as count from outreach_messages where prospect_id = p.id
       ) mc on true
       left join lateral (
         select coalesce(array_agg(d.provider order by d.first_seen_at), '{}'::text[]) as providers,
                count(*)::int as origin_count
           from prospect_discovery_origins d where d.prospect_id = p.id
       ) o on true
      where ${clauses.join(' and ')}
      order by p.score desc nulls last, p.display_name asc
      limit 500`,
    params,
  );
}

/** Villes observées, les plus peuplées d'abord, pour le filtre géographique. */
export async function listCities(campaignId: string): Promise<CityOption[]> {
  const db = await sql();
  const rows = await db.query<{ city: string; count: string }>(
    `select p.city, count(*)::text as count
       from prospects p
      where p.campaign_id = $1
        and p.dedupe_status <> 'merged'
        and p.city is not null and p.city <> ''
      group by p.city
      order by count(*) desc, p.city asc
      limit 50`,
    [campaignId],
  );
  return rows.map((row) => ({ city: row.city, count: toInt(row.count) }));
}

/**
 * Les compteurs propres à R2 : par quel rail les prospects sont arrivés, et ce
 * que nous savons en faire. `commercial_visibility` n'apparaît pas ici : c'est
 * une mesure d'observabilité par prospect, pas un indicateur de campagne.
 */
export async function getR2Kpis(campaignId: string): Promise<R2Kpis> {
  const db = await sql();

  const [prospects] = await db.query<{
    total: string;
    commercial: string;
    long_tail: string;
    contactable: string;
    funnel_observable: string;
    not_measured: string;
    qualified_contactable_observable: string;
  }>(
    `select
       count(*)::text as total,
       count(*) filter (where discovery_rail = 'commercial')::text as commercial,
       count(*) filter (where discovery_rail = 'long_tail')::text as long_tail,
       count(*) filter (where contactable is true)::text as contactable,
       count(*) filter (where funnel_observable is true)::text as funnel_observable,
       count(*) filter (where contactable is null)::text as not_measured,
       count(*) filter (
         where niche_verdict = 'in_niche' and contactable is true and funnel_observable is true
       )::text as qualified_contactable_observable
     from prospects
     where campaign_id = $1 and dedupe_status <> 'merged'`,
    [campaignId],
  );

  const [multiSource] = await db.query<{ count: string }>(
    `select count(*)::text as count from (
       select d.prospect_id
         from prospect_discovery_origins d
         join prospects p on p.id = d.prospect_id
        where d.campaign_id = $1 and p.dedupe_status <> 'merged'
        group by d.prospect_id
       having count(*) > 1
     ) t`,
    [campaignId],
  );

  const [candidates] = await db.query<{
    discovered: string;
    identified: string;
    unidentified: string;
    rejected: string;
  }>(
    `select
       count(*)::text as discovered,
       count(*) filter (where status = 'identified')::text as identified,
       count(*) filter (where status = 'unidentified')::text as unidentified,
       count(*) filter (where status = 'rejected')::text as rejected
     from google_place_candidates where campaign_id = $1`,
    [campaignId],
  );

  return {
    total: toInt(prospects?.total),
    byRail: {
      commercial: toInt(prospects?.commercial),
      longTail: toInt(prospects?.long_tail),
      multiSource: toInt(multiSource?.count),
    },
    contactable: toInt(prospects?.contactable),
    funnelObservable: toInt(prospects?.funnel_observable),
    notMeasured: toInt(prospects?.not_measured),
    qualifiedContactableObservable: toInt(prospects?.qualified_contactable_observable),
    placesCandidates: {
      discovered: toInt(candidates?.discovered),
      identified: toInt(candidates?.identified),
      unidentified: toInt(candidates?.unidentified),
      rejected: toInt(candidates?.rejected),
    },
  };
}

/**
 * Le tableau de bord du rail R5, restreint aux entreprises qu'il a trouvées.
 *
 * La restriction est le point : mélanger les 257 prospects registry-first au
 * corpus du pilote ferait paraître les taux de conversion catastrophiques
 * (l'ancien corpus a très peu de sites) ou excellents (il est déjà classé),
 * selon le sens du vent. La question du §17 porte sur ce que ce rail rapporte,
 * et sur rien d'autre.
 */
export async function getR5Kpis(campaignId: string): Promise<R5Kpis> {
  const db = await sql();

  const railScope = `exists (
    select 1 from prospect_discovery_origins d
     where d.prospect_id = p.id and d.rail = 'commercial_web_discovery'
  )`;

  const [prospects] = await db.query<{
    discovered: string;
    qualified: string;
    contactable: string;
    funnel_observable: string;
    message_ready: string;
    kpi: string;
    with_opportunity: string;
    identity_confirmed: string;
    identity_manual: string;
    rec_send: string;
    rec_edit: string;
    rec_reject: string;
    rec_none: string;
  }>(
    `select
       count(*)::text                                                        as discovered,
       count(*) filter (where niche_verdict = 'in_niche')::text              as qualified,
       count(*) filter (where contactable is true)::text                     as contactable,
       count(*) filter (where funnel_observable is true)::text               as funnel_observable,
       count(*) filter (where stage in ('message_ready','approved'))::text   as message_ready,
       count(*) filter (
         where niche_verdict = 'in_niche' and contactable is true and funnel_observable is true
       )::text                                                               as kpi,
       count(*) filter (where funnel_observable is true and funnel_opportunity_count > 0)::text
                                                                             as with_opportunity,
       count(*) filter (where identity_review = 'confirmed')::text           as identity_confirmed,
       count(*) filter (where identity_review = 'manual_review')::text       as identity_manual,
       count(*) filter (where outreach_recommendation = 'send')::text        as rec_send,
       count(*) filter (where outreach_recommendation = 'edit')::text        as rec_edit,
       count(*) filter (where outreach_recommendation = 'reject')::text      as rec_reject,
       count(*) filter (where outreach_recommendation is null)::text         as rec_none
     from prospects p
     where p.campaign_id = $1 and p.dedupe_status <> 'merged' and ${railScope}`,
    [campaignId],
  );

  const [candidates] = await db.query<{
    total: string;
    promoted: string;
    rejected: string;
    not_probed: string;
  }>(
    `select count(*)::text                                        as total,
            count(*) filter (where status = 'promoted')::text      as promoted,
            count(*) filter (where status = 'rejected')::text      as rejected,
            count(*) filter (where probed_at is null)::text        as not_probed
       from commercial_business_candidates where campaign_id = $1`,
    [campaignId],
  );

  return {
    discovered: toInt(prospects?.discovered),
    qualified: toInt(prospects?.qualified),
    contactable: toInt(prospects?.contactable),
    funnelObservable: toInt(prospects?.funnel_observable),
    messageReady: toInt(prospects?.message_ready),
    qualifiedContactableObservable: toInt(prospects?.kpi),
    withFunnelOpportunity: toInt(prospects?.with_opportunity),
    identityConfirmed: toInt(prospects?.identity_confirmed),
    identityManualReview: toInt(prospects?.identity_manual),
    recommendation: {
      send: toInt(prospects?.rec_send),
      edit: toInt(prospects?.rec_edit),
      reject: toInt(prospects?.rec_reject),
      none: toInt(prospects?.rec_none),
    },
    candidates: {
      total: toInt(candidates?.total),
      promoted: toInt(candidates?.promoted),
      rejected: toInt(candidates?.rejected),
      notProbed: toInt(candidates?.not_probed),
    },
  };
}

/**
 * Le registre `google_places_usage` relu tel quel : combien d'appels, à quel
 * palier de SKU, combien facturables, combien évités par le cache. Aucun coût
 * en euros n'est calculé ici — les tarifs vivent chez Google, pas dans le code.
 */
export async function getPlacesCost(campaignSlug: string): Promise<PlacesCost> {
  const db = await sql();
  const rows = await db.query<{
    tier: string;
    calls: string;
    billable: string;
    free: string;
    cache_hits: string;
  }>(
    `select sku_tier as tier,
            count(*)::text as calls,
            count(*) filter (where billable)::text as billable,
            count(*) filter (where not billable and not cache_hit)::text as free,
            count(*) filter (where cache_hit)::text as cache_hits
       from google_places_usage
      where campaign_slug = $1
      group by sku_tier
      order by count(*) desc, sku_tier asc`,
    [campaignSlug],
  );

  const [month] = await db.query<{ count: string }>(
    `select count(*)::text as count
       from google_places_usage
      where campaign_slug = $1
        and billable
        and occurred_on >= date_trunc('month', (now() at time zone 'utc'))::date`,
    [campaignSlug],
  );

  const byTier: PlacesCostTier[] = rows.map((row) => ({
    tier: row.tier,
    calls: toInt(row.calls),
    billable: toInt(row.billable),
    free: toInt(row.free),
    cacheHits: toInt(row.cache_hits),
  }));

  const totals = byTier.reduce(
    (acc, tier) => ({
      calls: acc.calls + tier.calls,
      billable: acc.billable + tier.billable,
      free: acc.free + tier.free,
      cacheHits: acc.cacheHits + tier.cacheHits,
    }),
    { calls: 0, billable: 0, free: 0, cacheHits: 0 },
  );

  return { byTier, totals, billableThisMonth: toInt(month?.count) };
}

export interface DiscoveryOrigin {
  provider: string;
  rail: 'commercial' | 'long_tail';
  external_id: string | null;
  first_seen_at: string;
}

/**
 * Ce que le prospect nous laisse faire. `commercialVisibility` mesure
 * l'observabilité de l'entreprise depuis l'extérieur — jamais sa qualité.
 * Les valeurs viennent des colonnes persistées ; `visibilityReasons` est
 * recalculé par la même fonction déterministe (`src/lib/pipeline/reach.ts`).
 */
export interface ProspectReachView {
  contactable: boolean | null;
  channels: string[];
  funnelObservable: boolean | null;
  funnelSignalCount: number;
  commercialVisibility: number | null;
  visibilityReasons: string[];
}

export interface ProspectDetail {
  prospect: ProspectRow;
  origins: DiscoveryOrigin[];
  reach: ProspectReachView;
  sources: { provider: string; url: string | null; external_id: string | null; collected_at: string }[];
  evidence: {
    id: string;
    field: string;
    value_text: string | null;
    value_json: unknown;
    provider: string;
    method: string;
    source_url: string | null;
    confidence: number;
    observed_at: string;
  }[];
  classification: {
    verdict: string;
    confidence: number;
    decided_by: string;
    reasons: string[];
    created_at: string;
  } | null;
  score: {
    total: number;
    band: string;
    deterministic: { signals: SignalView[]; coverage: number; capped: boolean };
    missing_signals: string[];
    profile_key: string;
    profile_version: string;
  } | null;
  research: {
    id: string;
    summary: string;
    // R5.1b — la colonne JSONB porte les deux formes selon la date d'écriture :
    // `evidenceId: string` pour les fiches antérieures au correctif, `evidenceIds:
    // string[]` depuis. Aucune migration n'a réécrit l'historique — une valeur
    // JSONB sans schéma imposé n'en a pas besoin — donc la lecture tolère les deux
    // et la page normalise plutôt que de supposer la forme récente.
    observations: {
      text: string;
      evidenceIds?: string[];
      evidenceId?: string;
      sourceUrl: string | null;
      provider: string;
    }[];
    opportunities: string[];
    unknowns: string[];
    confidence: number;
    created_at: string;
  } | null;
  angle: {
    pain_point: string;
    opportunity: string;
    approach: string;
    personalization: string;
    use_case_study: boolean;
    confidence: number;
  } | null;
  messages: {
    id: string;
    variant: string;
    is_primary: boolean;
    body: string;
    state: string;
    personalization_level: string;
    rationale: string | null;
    used_facts: string[];
    guardrail_flags: { code: string; message: string; blocking: boolean; excerpt?: string }[];
    created_at: string;
    review_note: string | null;
  }[];
  mergeCandidates: { id: string; other_name: string; similarity: number; status: string }[];
}

export interface SignalView {
  key: string;
  label: string;
  observed: boolean;
  ratio: number | null;
  points: number;
  max: number;
  detail: string;
}

/** Les canaux persistés dans `contact_channels` (jsonb), relus sans supposition. */
function readChannels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

export async function getProspectDetail(prospectId: string): Promise<ProspectDetail | null> {
  const db = await sql();
  const [prospect] = await db.query<ProspectRow>('select * from prospects where id = $1', [prospectId]);
  if (!prospect) return null;

  const [origins, sources, evidence, classification, score, research, angle, messages, mergeCandidates] =
    await Promise.all([
      db.query<DiscoveryOrigin>(
        `select provider, rail, external_id, first_seen_at
           from prospect_discovery_origins where prospect_id = $1 order by first_seen_at`,
        [prospectId],
      ),
      db.query<{ provider: string; url: string | null; external_id: string | null; collected_at: string }>(
        'select provider, url, external_id, collected_at from prospect_sources where prospect_id = $1 order by collected_at',
        [prospectId],
      ),
      db.query<ProspectDetail['evidence'][number]>(
        `select id, field, value_text, value_json, provider, method, source_url, confidence, observed_at
           from prospect_evidence where prospect_id = $1 order by observed_at, field`,
        [prospectId],
      ),
      db.query<{ verdict: string; confidence: number; decided_by: string; reasons: string[]; created_at: string }>(
        `select verdict, confidence, decided_by, reasons, created_at from prospect_classifications
          where prospect_id = $1 order by created_at desc limit 1`,
        [prospectId],
      ),
      db.query<{
        total: number;
        band: string;
        deterministic: { signals: SignalView[]; coverage: number; capped: boolean };
        missing_signals: string[];
        profile_key: string;
        profile_version: string;
      }>(
        `select total, band, deterministic, missing_signals, profile_key, profile_version
           from prospect_scores where prospect_id = $1 order by created_at desc limit 1`,
        [prospectId],
      ),
      db.query<ProspectDetail['research'] & object>(
        `select id, summary, observations, opportunities, unknowns, confidence, created_at
           from prospect_research where prospect_id = $1 order by created_at desc limit 1`,
        [prospectId],
      ),
      db.query<NonNullable<ProspectDetail['angle']>>(
        `select pain_point, opportunity, approach, personalization, use_case_study, confidence
           from prospect_angles where prospect_id = $1 order by created_at desc limit 1`,
        [prospectId],
      ),
      db.query<ProspectDetail['messages'][number]>(
        `select id, variant, is_primary, body, state, personalization_level, rationale,
                used_facts, guardrail_flags, created_at, review_note
           from outreach_messages where prospect_id = $1 order by is_primary desc, variant asc`,
        [prospectId],
      ),
      db.query<{ id: string; other_name: string; similarity: number; status: string }>(
        `select mc.id,
                case when mc.left_id = $1 then rp.display_name else lp.display_name end as other_name,
                mc.similarity, mc.status
           from prospect_merge_candidates mc
           join prospects lp on lp.id = mc.left_id
           join prospects rp on rp.id = mc.right_id
          where mc.left_id = $1 or mc.right_id = $1`,
        [prospectId],
      ),
    ]);

  const visibility = commercialVisibility({ prospect, evidence });

  return {
    prospect,
    origins,
    reach: {
      contactable: prospect.contactable,
      channels: readChannels(prospect.contact_channels),
      funnelObservable: prospect.funnel_observable,
      funnelSignalCount: prospect.funnel_signal_count ?? 0,
      commercialVisibility: prospect.commercial_visibility,
      // Les motifs n'ont pas de colonne : ils sont redérivés des mêmes
      // observations, et ne sont affichés que si une visibilité a été calculée.
      visibilityReasons: prospect.commercial_visibility == null ? [] : visibility.reasons,
    },
    sources,
    evidence,
    classification: classification[0] ?? null,
    score: score[0] ?? null,
    research: (research[0] as ProspectDetail['research']) ?? null,
    angle: angle[0] ?? null,
    messages,
    mergeCandidates,
  };
}
