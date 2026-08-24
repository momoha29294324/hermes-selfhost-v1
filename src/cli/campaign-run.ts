#!/usr/bin/env tsx
/**
 * Runs a campaign end to end. Nothing is ever sent: the last stage writes drafts.
 *
 *   npm run campaign:run -- --campaign example-campaign
 *   npm run campaign:run -- --campaign example-campaign --stop-after discovery
 *   npm run campaign:run -- --campaign example-campaign --limit 20
 */
import { getSql } from '@/lib/db';
import { migrate } from '@/lib/db/migrate';
import { loadCampaign, loadNiche, loadScoringProfile } from '@/lib/config/load';
import { runCampaign } from '@/lib/pipeline/runCampaign';
import { createLogger } from '@/lib/logging/logger';
import { envBool } from '@/lib/env';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const slug = arg('campaign') ?? 'example-campaign';
  const stopAfter = arg('stop-after') as
    | 'discovery'
    | 'enrichment'
    | 'qualification'
    | 'scoring'
    | 'research'
    | 'message'
    | undefined;
  const limitRaw = arg('limit');
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;

  if (envBool('OUTBOUND_ALLOW_SENDING', false)) {
    throw new Error('OUTBOUND_ALLOW_SENDING must stay 0 in V1: this build has no sending code and must not pretend to.');
  }

  const logger = createLogger({ cmd: 'campaign:run', campaign: slug });
  const campaign = loadCampaign(slug);
  const niche = loadNiche(campaign.niche);
  const profile = loadScoringProfile(campaign.scoring.profile);

  const sql = await getSql();
  await migrate(sql);

  const started = Date.now();
  const { campaignId, runId, stats } = await runCampaign({
    sql,
    logger,
    campaign,
    niche,
    profile,
    ...(stopAfter ? { stopAfter } : {}),
    ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
  });

  const durationMs = Date.now() - started;
  logger.info('campaign.done', { campaignId, runId, durationMs, ...stats });

  process.stdout.write(`\nCampagne : ${campaign.name}\n`);
  process.stdout.write(`Run      : ${runId}\n`);
  process.stdout.write(`Durée    : ${(durationMs / 1000).toFixed(1)} s\n\n`);
  const rows: [string, string | number][] = [
    ['Entreprises trouvées (brut)', stats.discovered],
    ['Prospects créés', stats.newProspects],
    ['Rattachés à un prospect existant (dédup)', stats.mergedIntoExisting],
    ['Fusions à arbitrer', stats.reviewCandidates],
    ['Enrichis', stats.enriched],
    ['Sites web trouvés', stats.websitesFound],
    ['Sites web crawlés', stats.websitesCrawled],
    ['Classifiés', stats.classified],
    ['in_niche', stats.inNiche],
    ['Scorés', stats.scored],
    ['Fiches research', stats.researched],
    ['Angles commerciaux', stats.angles],
    ['Messages générés (draft)', stats.messages],
    ['Messages bloqués par garde-fous', stats.blockedMessages],
    ['Appels LLM', stats.llmCalls],
  ];
  for (const [label, value] of rows) {
    process.stdout.write(`${label.padEnd(42, '.')} ${value}\n`);
  }
  if (Object.keys(stats.bySource).length > 0) {
    process.stdout.write('\nPar source :\n');
    for (const [provider, count] of Object.entries(stats.bySource)) {
      process.stdout.write(`  ${provider.padEnd(16)} ${count}\n`);
    }
  }
  if (stats.notes.length > 0) {
    process.stdout.write('\nLimitations observées :\n');
    for (const note of [...new Set(stats.notes)]) process.stdout.write(`  - ${note}\n`);
  }
  process.stdout.write('\nAucun message n’a été envoyé (V1 = review only).\n');

  await sql.close();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
