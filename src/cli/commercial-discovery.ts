#!/usr/bin/env tsx
/**
 * Pilote R5 — trouver de vrais artisans commercialement actifs.
 *
 *   npm run commercial:discover -- --dry-run           # plan + mesure, rien écrit
 *   npm run commercial:discover -- --plan-only         # ce que le run coûterait
 *   npm run commercial:discover
 *
 * La question a changé de sens depuis R4-S, et c'est tout le sujet :
 *
 *   > partant du métier et de la zone plutôt que d'une société du registre,
 *   > combien d'entreprises réellement actives obtient-on, et combien d'entre
 *   > elles sont qualifiées, joignables et dont le parcours commercial est
 *   > lisible ?
 *
 * Trois exigences du gate que ce fichier tient littéralement :
 *
 *   - **le plan est connu avant de payer.** `--plan-only` imprime les requêtes
 *     exactes et leur coût. Un plafond qu'on ne peut vérifier qu'après la
 *     facture n'est pas un plafond ;
 *   - **les mêmes fonctions que le pipeline.** `runCommercialDiscovery` appelle
 *     le vérificateur d'identité de R3, le crawl de R1 et `assessReach` de R2.
 *     Aucun raccourci de banc d'essai, sans quoi la mesure décrirait le banc et
 *     non le produit ;
 *   - **rien ne part.** Ce fichier n'a aucun chemin d'envoi, et
 *     `OUTBOUND_ALLOW_SENDING` reste à 0.
 *
 * Les mesures encadrantes passent par `readOnlyQuery` : un outil de mesure qui
 * écrit mesure son propre effet. Le rail, lui, écrit — c'est son travail, et
 * `--dry-run` le rend muet.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { getSql } from '@/lib/db';
import { logger } from '@/lib/logging/logger';
import { loadCampaign, loadNiche } from '@/lib/config/load';
import { HttpClient } from '@/lib/http/client';
import { ProspectRepository } from '@/lib/repo/prospects';
import { readOnlyQuery } from '@/lib/db/safety';
import { ProviderScheduler } from '@/lib/http/scheduler';
import { createWebIntelClient } from '@/lib/enrichment/webintel';
import { createWebSearchProvider, observedCredits, SERPER_MAX_NUM_FREE } from '@/lib/enrichment/webSearch';
import {
  SearchBudget,
  searchKeyVariable,
  searchLimitsFromEnv,
  searchPricing,
} from '@/lib/discovery/search/budget';
import { searchSchedulerLimits } from '@/lib/discovery/search/railSearch';
import { planFromConfig, zonesFromGeography } from '@/lib/discovery/commercial/queryPlan';
import {
  runCommercialDiscovery,
  type CommercialRailStats,
} from '@/lib/discovery/commercial/railCommercial';
import { COMMERCIAL_RESULT_KINDS } from '@/lib/discovery/commercial/classifyResult';

function arg(name: string, fallback: string | null = null): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number(((numerator / denominator) * 100).toFixed(1));
}

/** Le corpus produit par ce rail, relu depuis la base. Lecture seule. */
const RAIL_CORPUS_SQL = `
  select count(*)::text                                                     as prospects,
         count(*) filter (where niche_verdict = 'in_niche')::text            as in_niche,
         count(*) filter (where niche_verdict = 'adjacent')::text            as adjacent,
         count(*) filter (where niche_verdict = 'uncertain')::text           as uncertain,
         count(*) filter (where niche_verdict = 'out_of_niche')::text        as out_of_niche,
         count(*) filter (where website_url is not null)::text               as with_site,
         count(*) filter (where instagram_handle is not null)::text          as with_ig,
         count(*) filter (where facebook_url is not null)::text              as with_fb,
         count(*) filter (where phone is not null)::text                     as with_phone,
         count(*) filter (where email is not null)::text                     as with_email,
         count(*) filter (where contactable)::text                           as contactable,
         count(*) filter (where funnel_observable)::text                     as funnel_observable,
         count(*) filter (where identity_review = 'confirmed')::text         as identity_confirmed,
         count(*) filter (where identity_review = 'manual_review')::text     as identity_manual,
         count(*) filter (where stage in ('message_ready','approved'))::text as message_ready,
         count(*) filter (where niche_verdict = 'in_niche' and contactable)::text
                                                                             as qualified_contactable,
         count(*) filter (where niche_verdict = 'in_niche' and funnel_observable)::text
                                                                             as qualified_funnel,
         count(*) filter (
           where niche_verdict = 'in_niche' and contactable and funnel_observable
         )::text                                                             as kpi
    from prospects
   where campaign_id = $1
     and dedupe_status <> 'merged'
     and exists (
       select 1 from prospect_discovery_origins d
        where d.prospect_id = prospects.id and d.rail = 'commercial_web_discovery'
     )
`;

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const planOnly = process.argv.includes('--plan-only');
  const campaignSlug = arg('campaign', 'example-campaign') as string;
  const reportDir = resolvePath(process.cwd(), arg('report', 'var/benchmarks') as string);

  const campaign = loadCampaign(campaignSlug);
  const niche = loadNiche(campaign.niche);
  const config = campaign.discovery.commercialWeb;

  const zones = zonesFromGeography(campaign.geography);
  const maxQueriesArg = arg('max-queries');
  const plan = planFromConfig(niche, campaign.geography, {
    ...config,
    ...(maxQueriesArg ? { maxQueries: Number.parseInt(maxQueriesArg, 10) } : {}),
  });

  const provider = createWebSearchProvider(new HttpClient({ sql: null }), config.provider);
  const pricing = searchPricing(provider.name);
  const keyVariable = searchKeyVariable(provider.name);

  process.stdout.write(
    `Campagne : ${campaign.slug}\n` +
      `Zones    : ${zones.map((zone) => zone.label).join(', ') || '(aucune)'}\n` +
      `Paliers  : ${config.tiers.join(', ')} · ${config.maxTermsPerTier} terme(s) par palier\n` +
      `Requêtes : ${plan.length} planifiées, plafond ${config.maxQueries}\n` +
      `Coût max : ${((plan.length * pricing.usdPer1000) / 1000).toFixed(4)} $ ` +
      `(${provider.name}, ${pricing.usdPer1000} $ / 1 000)\n` +
      `Clé      : ${keyVariable.present ? `présente (${keyVariable.name})` : `ABSENTE (${keyVariable.name})`}\n\n`,
  );

  for (const query of plan) {
    process.stdout.write(`  [${query.tier}] ${query.query}\n`);
  }
  process.stdout.write('\n');

  if (planOnly) return;

  /**
   * Le refus précède l'appel, y compris sur une valeur de configuration.
   *
   * Un compte Serper gratuit répond `400 Query pattern not allowed` dès que
   * `num` dépasse 10. L'adaptateur borne déjà la valeur, mais découvrir la
   * borne dans un rapport plutôt qu'ici ferait croire que la question posée
   * était celle qu'on croyait.
   */
  if (provider.name === 'serper' && config.resultsPerQuery > SERPER_MAX_NUM_FREE) {
    process.stdout.write(
      `resultsPerQuery = ${config.resultsPerQuery} est refusé par un compte Serper gratuit ` +
        `(maximum ${SERPER_MAX_NUM_FREE}).\n`,
    );
    process.exitCode = 2;
    return;
  }

  const availability = provider.availability();
  if (!availability.ok) {
    process.stdout.write(
      `\nRecherche indisponible : ${availability.reason ?? 'inconnue'}\n\n` +
        `Ajouter dans ${resolvePath(process.cwd(), '.env')} :\n\n  ${keyVariable.name}=<la clé>\n\n` +
        `${pricing.note}\n\n` +
        `Ne pas réutiliser la clé d'un autre projet de cette machine : le préfixe ` +
        `OUTBOUND_ est ce qui garde ce dépôt isolé.\n`,
    );
    process.exitCode = 3;
    return;
  }

  const sql = await getSql();
  const repo = new ProspectRepository(sql, logger);
  const http = new HttpClient({ sql });
  const scheduler = new ProviderScheduler({ logger, limits: searchSchedulerLimits() });

  const campaignId = await upsertCampaignRow(sql, campaign.slug, campaign.name, campaign.niche, campaign);
  const runId = dryRun ? null : await startRun(sql, campaignId);

  const budget = new SearchBudget({
    sql,
    provider: provider.name,
    campaignSlug: campaign.slug,
    runId,
    limits: searchLimitsFromEnv(),
  });

  const before = await measureRail(sql, campaignId, 'corpus.before');

  const stats = await runCommercialDiscovery(
    {
      sql,
      repo,
      http,
      logger: logger.child({ rail: 'commercial_web' }),
      niche,
      campaign,
      campaignId,
      runId,
      scheduler,
      provider,
      budget,
      webintel: createWebIntelClient(http),
    },
    {
      persist: !dryRun,
      ...(maxQueriesArg ? { maxQueries: Number.parseInt(maxQueriesArg, 10) } : {}),
    },
  );

  const after = await measureRail(sql, campaignId, 'corpus.after');
  const snapshot = await budget.snapshot();
  const credits = observedCredits(provider);

  const usdSpent = Number((snapshot.runCalls * (pricing.usdPer1000 / 1000)).toFixed(4));
  const qualified = after.inNiche;
  const usefulProspects = after.kpi;

  const report = {
    generatedAt: new Date().toISOString(),
    campaign: campaign.slug,
    dryRun,
    provider: {
      name: provider.name,
      endpoint: pricing.endpoint,
      keyVariable: keyVariable.name,
      priceUsdPer1000: pricing.usdPer1000,
      resultsStored: false,
    },
    zones: stats.zones,
    plan: {
      planned: stats.queriesPlanned,
      tiers: config.tiers,
      maxTermsPerTier: config.maxTermsPerTier,
      queries: plan.map((query) => ({ tier: query.tier, zone: query.zone, query: query.query })),
    },
    discovery: {
      queriesIssued: stats.queriesIssued,
      queriesAvoided: stats.queriesAvoided,
      resultsSeen: stats.resultsSeen,
      byKind: stats.byKind,
      candidatesFound: stats.candidatesFound,
      duplicateSightings: stats.duplicateSightings,
      leadsAttached: stats.leadsAttached,
      leadsUnattached: stats.leadsUnattached,
      candidatesProbed: stats.candidatesProbed,
      sitesRead: stats.sitesRead,
      outOfZone: stats.outOfZone,
      promoted: stats.promoted,
      createdProspects: stats.createdProspects,
      mergedIntoExisting: stats.mergedIntoExisting,
      verifierBlockedMerges: stats.verifierBlockedMerges,
      stoppedReason: stats.stoppedReason,
    },
    qualification: {
      inNiche: stats.inNiche,
      adjacent: stats.adjacent,
      outOfNiche: stats.outOfNiche,
      uncertain: stats.uncertainNiche,
    },
    identity: {
      confirmed: stats.identityConfirmed,
      manualReview: stats.identityManualReview,
      uncertain: stats.identityUncertain,
    },
    corpus: { before, after },
    kpi: {
      discovered: stats.candidatesFound,
      qualified,
      contactable: after.contactable,
      funnelObservable: after.funnelObservable,
      qualifiedContactableObservable: usefulProspects,
      /**
       * Les taux, avec le même dénominateur ET le même numérateur.
       *
       * Le premier pilote a publié « qualifiée → contactable : 116 % », parce
       * que le numérateur comptait toutes les entreprises joignables du rail et
       * le dénominateur seulement les qualifiées. Un taux supérieur à 100 %
       * signale toujours ce défaut ; le publier tel quel serait présenter une
       * incohérence de mesure comme un résultat.
       */
      conversion: {
        discoveryToQualified: rate(qualified, stats.candidatesFound),
        qualifiedToContactable: rate(after.qualifiedContactable, Math.max(1, qualified)),
        qualifiedToFunnelObservable: rate(after.qualifiedFunnelObservable, Math.max(1, qualified)),
        funnelObservableToMessageReady: rate(after.messageReady, Math.max(1, after.qualifiedFunnelObservable)),
      },
    },
    cost: {
      billableCalls: snapshot.runCalls,
      avoidedCalls: snapshot.avoided,
      usdPerQuery: pricing.usdPer1000 / 1000,
      estimatedUsdThisRun: usdSpent,
      lifetimeCalls: snapshot.lifetimeCalls,
      freeQueriesRemaining: snapshot.freeQueriesRemaining,
      providerReportedCredits: credits,
      queriesPerCandidate:
        stats.candidatesFound === 0 ? null : Number((stats.queriesIssued / stats.candidatesFound).toFixed(2)),
      queriesPerQualified: qualified === 0 ? null : Number((stats.queriesIssued / qualified).toFixed(2)),
      usdPerQualified: qualified === 0 ? null : Number((usdSpent / qualified).toFixed(4)),
      usdPerFunnelObservable:
        after.funnelObservable === 0 ? null : Number((usdSpent / after.funnelObservable).toFixed(4)),
      note: pricing.note,
    },
    scheduler: scheduler.snapshot(),
    candidates: stats.candidates,
    queries: stats.queries,
    errors: stats.errors,
    durationMs: stats.durationMs,
    outreach: { sent: 0, allowSending: false, note: 'aucun code d’envoi n’existe dans ce dépôt' },
  };

  if (runId) await finishRun(sql, runId, stats);

  await mkdir(reportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = resolvePath(reportDir, `commercial-r5-${stamp}.json`);
  const mdPath = resolvePath(reportDir, `commercial-r5-${stamp}.md`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  await writeFile(mdPath, renderMarkdown(report), 'utf8');

  process.stdout.write(
    `\n${stats.queriesIssued} requête(s) · ${stats.resultsSeen} résultat(s) · ` +
      `${stats.candidatesFound} entreprise(s) unique(s) · ${stats.promoted} promue(s)\n` +
      `in_niche ${after.inNiche} · contactables ${after.contactable} · ` +
      `parcours lisible ${after.funnelObservable} · KPI ${usefulProspects}\n` +
      `Coût : ${usdSpent} $\n\nRapport : ${mdPath}\n`,
  );

  await sql.close();
}

interface RailCorpus {
  prospects: number;
  inNiche: number;
  adjacent: number;
  uncertain: number;
  outOfNiche: number;
  withSite: number;
  withInstagram: number;
  withFacebook: number;
  withPhone: number;
  withEmail: number;
  contactable: number;
  funnelObservable: number;
  identityConfirmed: number;
  identityManualReview: number;
  messageReady: number;
  /** Restreints aux qualifiées : les seuls numérateurs comparables à `inNiche`. */
  qualifiedContactable: number;
  qualifiedFunnelObservable: number;
  kpi: number;
}

async function measureRail(
  sql: Awaited<ReturnType<typeof getSql>>,
  campaignId: string,
  label: string,
): Promise<RailCorpus> {
  const rows = await readOnlyQuery<Record<string, string>>(sql, RAIL_CORPUS_SQL, [campaignId], label);
  const row = rows[0] ?? {};
  const n = (key: string): number => Number.parseInt(row[key] ?? '0', 10) || 0;
  return {
    prospects: n('prospects'),
    inNiche: n('in_niche'),
    adjacent: n('adjacent'),
    uncertain: n('uncertain'),
    outOfNiche: n('out_of_niche'),
    withSite: n('with_site'),
    withInstagram: n('with_ig'),
    withFacebook: n('with_fb'),
    withPhone: n('with_phone'),
    withEmail: n('with_email'),
    contactable: n('contactable'),
    funnelObservable: n('funnel_observable'),
    identityConfirmed: n('identity_confirmed'),
    identityManualReview: n('identity_manual'),
    messageReady: n('message_ready'),
    qualifiedContactable: n('qualified_contactable'),
    qualifiedFunnelObservable: n('qualified_funnel'),
    kpi: n('kpi'),
  };
}

async function upsertCampaignRow(
  sql: Awaited<ReturnType<typeof getSql>>,
  slug: string,
  name: string,
  nicheKey: string,
  config: unknown,
): Promise<string> {
  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, status, config)
     values ($1,$2,$3,'running',$4)
     on conflict (slug) do update
       set name = excluded.name, niche_key = excluded.niche_key,
           config = excluded.config, status = 'running', updated_at = now()
     returning id`,
    [slug, name, nicheKey, JSON.stringify(config)],
  );
  const row = rows[0];
  if (!row) throw new Error('failed to upsert campaign');
  return row.id;
}

async function startRun(sql: Awaited<ReturnType<typeof getSql>>, campaignId: string): Promise<string> {
  const rows = await sql.query<{ id: string }>(
    'insert into campaign_runs (campaign_id) values ($1) returning id',
    [campaignId],
  );
  const row = rows[0];
  if (!row) throw new Error('failed to create campaign run');
  return row.id;
}

async function finishRun(
  sql: Awaited<ReturnType<typeof getSql>>,
  runId: string,
  stats: CommercialRailStats,
): Promise<void> {
  await sql.query(
    'update campaign_runs set status = $2, stats = $3, finished_at = now() where id = $1',
    [runId, 'succeeded', JSON.stringify(stats)],
  );
}

function renderMarkdown(report: Record<string, unknown>): string {
  const discovery = report['discovery'] as Record<string, number | string | null>;
  const kpi = report['kpi'] as Record<string, unknown>;
  const cost = report['cost'] as Record<string, unknown>;
  const identity = report['identity'] as Record<string, number>;
  const qualification = report['qualification'] as Record<string, number>;
  const byKind = discovery['byKind'] as unknown as Record<string, number>;
  const conversion = kpi['conversion'] as Record<string, number>;
  const candidates = report['candidates'] as Record<string, unknown>[];

  const lines: string[] = [
    `# Pilote R5 — découverte commerciale (${String(report['campaign'])})`,
    '',
    `Généré le ${String(report['generatedAt'])}${report['dryRun'] ? ' — **dry-run, rien écrit**' : ''}.`,
    `Zones : ${(report['zones'] as string[]).join(', ')}.`,
    '',
    '## KPI',
    '',
    '| mesure | valeur |',
    '| --- | ---: |',
    `| entreprises uniques découvertes | ${String(kpi['discovered'])} |`,
    `| qualifiées (in_niche) | ${String(kpi['qualified'])} |`,
    `| contactables (toutes) | ${String(kpi['contactable'])} |`,
    `| parcours observable (toutes) | ${String(kpi['funnelObservable'])} |`,
    `| **KPI R5 (qualifiée + contactable + parcours lu)** | ${String(kpi['qualifiedContactableObservable'])} |`,
    '',
    '### Conversions',
    '',
    '| étape | taux |',
    '| --- | ---: |',
    `| découverte → qualifiée | ${String(conversion['discoveryToQualified'])} % |`,
    `| qualifiée → contactable | ${String(conversion['qualifiedToContactable'])} % |`,
    `| qualifiée → parcours observable | ${String(conversion['qualifiedToFunnelObservable'])} % |`,
    `| parcours observable → message prêt | ${String(conversion['funnelObservableToMessageReady'])} % |`,
    '',
    '## Découverte',
    '',
    '| mesure | valeur |',
    '| --- | ---: |',
    `| requêtes émises | ${String(discovery['queriesIssued'])} |`,
    `| requêtes évitées | ${String(discovery['queriesAvoided'])} |`,
    `| résultats vus | ${String(discovery['resultsSeen'])} |`,
    `| entreprises uniques | ${String(discovery['candidatesFound'])} |`,
    `| doublons regroupés | ${String(discovery['duplicateSightings'])} |`,
    `| pistes de tiers rattachées | ${String(discovery['leadsAttached'])} |`,
    `| pistes non rattachées | ${String(discovery['leadsUnattached'])} |`,
    `| sites sondés | ${String(discovery['candidatesProbed'])} |`,
    `| sites réellement lus | ${String(discovery['sitesRead'])} |`,
    `| écartés hors zone | ${String(discovery['outOfZone'])} |`,
    `| promus en prospects | ${String(discovery['promoted'])} |`,
    `| dont fusionnés avec un prospect existant | ${String(discovery['mergedIntoExisting'])} |`,
    `| fusions refusées par le vérificateur | ${String(discovery['verifierBlockedMerges'])} |`,
    '',
    '### Classification des résultats',
    '',
    '| catégorie | résultats |',
    '| --- | ---: |',
    ...COMMERCIAL_RESULT_KINDS.map((kind) => `| ${kind} | ${String(byKind[kind] ?? 0)} |`),
    '',
    '## Qualification',
    '',
    `in_niche ${qualification['in_niche'] ?? qualification['inNiche'] ?? 0} · ` +
      `adjacent ${qualification['adjacent'] ?? 0} · ` +
      `out_of_niche ${qualification['outOfNiche'] ?? 0} · ` +
      `uncertain ${qualification['uncertain'] ?? 0}`,
    '',
    '## Identité',
    '',
    `confirmée par une identité légale publiée : ${identity['confirmed'] ?? 0} · ` +
      `revue manuelle : ${identity['manualReview'] ?? 0} · ` +
      `incertaine : ${identity['uncertain'] ?? 0}`,
    '',
    '## Coût',
    '',
    '| mesure | valeur |',
    '| --- | ---: |',
    `| requêtes facturables | ${String(cost['billableCalls'])} |`,
    `| prix unitaire | ${String(cost['usdPerQuery'])} $ |`,
    `| **coût de ce run** | ${String(cost['estimatedUsdThisRun'])} $ |`,
    `| requêtes offertes restantes | ${String(cost['freeQueriesRemaining'] ?? '—')} |`,
    `| requêtes par entreprise découverte | ${String(cost['queriesPerCandidate'] ?? '—')} |`,
    `| requêtes par entreprise qualifiée | ${String(cost['queriesPerQualified'] ?? '—')} |`,
    `| coût par entreprise qualifiée | ${String(cost['usdPerQualified'] ?? '—')} $ |`,
    `| coût par parcours observable | ${String(cost['usdPerFunnelObservable'] ?? '—')} $ |`,
    '',
    (cost['providerReportedCredits']
      ? `Crédits déclarés par le fournisseur : ${String(
          (cost['providerReportedCredits'] as { credits: number }).credits,
        )} sur ${String((cost['providerReportedCredits'] as { calls: number }).calls)} appels. ` +
        'C’est la seule ligne mesurée de ce tableau — le reste est notre estimation.'
      : ''),
    '',
    '## Entreprises',
    '',
    '| entreprise | domaine | zones | rang | identité | métier | parcours | opportunités | statut |',
    '| --- | --- | --- | ---: | --- | --- | --- | ---: | --- |',
    ...candidates.map(
      (candidate) =>
        `| ${String(candidate['declaredName'] ?? candidate['provisionalName'])} ` +
        `| ${String(candidate['domain'] ?? '—')} ` +
        `| ${(candidate['zones'] as string[]).join(', ')} ` +
        `| ${String(candidate['bestRank'])} ` +
        `| ${String(candidate['identityReview'] ?? '—')} ` +
        `| ${String(candidate['nicheVerdict'] ?? '—')} ` +
        `| ${String(candidate['funnelSummary'] ?? 'non observé')} ` +
        `| ${String(candidate['opportunityCount'])} ` +
        `| ${candidate['promoted'] ? 'promue' : String(candidate['rejectReason'] ?? 'écartée')} |`,
    ),
    '',
    '## Envois',
    '',
    '0 message envoyé. Aucun code d’envoi n’existe dans ce dépôt et `OUTBOUND_ALLOW_SENDING` reste à 0.',
    '',
  ];

  return lines.join('\n');
}

void (async (): Promise<void> => {
  try {
    await main();
  } catch (error) {
    logger.error('commercial.discovery_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
})();
