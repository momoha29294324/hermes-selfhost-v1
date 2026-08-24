#!/usr/bin/env tsx
/**
 * Verdict for the Sprint-1 product gate, computed from the database — not from
 * anybody's memory of what happened.
 *
 *   npm run gate:report -- --campaign example-campaign
 */
import { getSql } from '@/lib/db';
import { nameSimilarity } from '@/lib/identity/normalize';

interface Check {
  label: string;
  pass: boolean;
  detail: string;
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const slug = arg('campaign') ?? 'example-campaign';
  const target = Number.parseInt(arg('target') ?? '20', 10);
  const sql = await getSql();

  const [campaign] = await sql.query<{ id: string; name: string }>(
    'select id, name from campaigns where slug = $1',
    [slug],
  );
  if (!campaign) throw new Error(`Campagne inconnue: ${slug}`);

  const prospects = await sql.query<{
    id: string;
    display_name: string;
    city: string | null;
    registry_id: string | null;
    domain: string | null;
    niche_verdict: string | null;
    score: number | null;
    stage: string;
  }>(
    `select id, display_name, city, registry_id, domain, niche_verdict, score, stage
       from prospects
      where campaign_id = $1 and dedupe_status <> 'merged'
      order by score desc nulls last`,
    [campaign.id],
  );

  const inNiche = prospects.filter((p) => p.niche_verdict === 'in_niche');

  const counts = await sql.query<{ label: string; count: string }>(
    `select 'evidence' as label, count(distinct prospect_id)::text as count from prospect_evidence
       where prospect_id in (select id from prospects where campaign_id = $1)
     union all
     select 'classification', count(distinct prospect_id)::text from prospect_classifications
       where prospect_id in (select id from prospects where campaign_id = $1)
     union all
     select 'score', count(distinct prospect_id)::text from prospect_scores where campaign_id = $1
     union all
     select 'research', count(distinct prospect_id)::text from prospect_research
       where prospect_id in (select id from prospects where campaign_id = $1)
     union all
     select 'angle', count(distinct prospect_id)::text from prospect_angles
       where prospect_id in (select id from prospects where campaign_id = $1)
     union all
     select 'message', count(distinct prospect_id)::text from outreach_messages where campaign_id = $1`,
    [campaign.id],
  );
  const stat = (label: string): number =>
    Number.parseInt(counts.find((row) => row.label === label)?.count ?? '0', 10);

  // Any pair of surviving prospects that still looks like the same business.
  const suspicious: string[] = [];
  for (let i = 0; i < prospects.length; i += 1) {
    for (let j = i + 1; j < prospects.length; j += 1) {
      const a = prospects[i]!;
      const b = prospects[j]!;
      if (a.registry_id && b.registry_id && a.registry_id === b.registry_id) {
        suspicious.push(`${a.display_name} / ${b.display_name} (même SIREN)`);
        continue;
      }
      if (a.domain && b.domain && a.domain === b.domain) {
        suspicious.push(`${a.display_name} / ${b.display_name} (même domaine)`);
        continue;
      }
      const sameCity = a.city && b.city && a.city.toLowerCase() === b.city.toLowerCase();
      if (sameCity && nameSimilarity(a.display_name, b.display_name) >= 0.92) {
        suspicious.push(`${a.display_name} / ${b.display_name} (nom+ville quasi identiques)`);
      }
    }
  }

  const [sent] = await sql.query<{ count: string }>(
    `select count(*)::text as count from outreach_events where kind in ('sent','delivered')`,
  );
  const [approvedNotSent] = await sql.query<{ count: string }>(
    `select count(*)::text as count from outreach_messages where campaign_id = $1 and state <> 'draft'`,
    [campaign.id],
  );

  const checks: Check[] = [
    {
      label: `1. ${target} entreprises réelles trouvées`,
      pass: prospects.length >= target,
      detail: `${prospects.length} prospects distincts en base`,
    },
    {
      label: '2. Aucune duplication manifeste',
      pass: suspicious.length === 0,
      detail: suspicious.length === 0 ? 'aucun doublon détecté' : suspicious.slice(0, 5).join(' · '),
    },
    {
      label: `3. ${target} enrichis`,
      pass: stat('evidence') >= target,
      detail: `${stat('evidence')} prospects avec au moins une evidence sourcée`,
    },
    {
      label: `4. ${target} classifiés`,
      pass: stat('classification') >= target,
      detail: `${stat('classification')} classifiés · ${inNiche.length} in_niche`,
    },
    {
      label: `5. ${target} scorés`,
      pass: stat('score') >= target,
      detail: `${stat('score')} scores enregistrés`,
    },
    {
      label: `6. ${target} fiches research`,
      pass: stat('research') >= target,
      detail: `${stat('research')} fiches`,
    },
    {
      label: `7. ${target} angles commerciaux`,
      pass: stat('angle') >= target,
      detail: `${stat('angle')} angles`,
    },
    {
      label: `8. ${target} messages personnalisés`,
      pass: stat('message') >= target,
      detail: `${stat('message')} prospects avec un message`,
    },
    {
      label: '9. Personne n’a été contacté',
      pass: Number.parseInt(sent?.count ?? '0', 10) === 0,
      detail: `${sent?.count ?? 0} évènement d'envoi · ${approvedNotSent?.count ?? 0} message hors état draft`,
    },
  ];

  process.stdout.write(`\nGate Sprint 1 — ${campaign.name}\n`);
  process.stdout.write('═'.repeat(78) + '\n');
  for (const check of checks) {
    process.stdout.write(`${check.pass ? '✅' : '❌'} ${check.label.padEnd(38)} ${check.detail}\n`);
  }
  process.stdout.write('═'.repeat(78) + '\n');
  const passed = checks.filter((check) => check.pass).length;
  process.stdout.write(`Verdict : ${passed}/${checks.length} critères remplis\n\n`);

  process.stdout.write('Top prospects :\n');
  for (const prospect of prospects.filter((p) => p.score !== null).slice(0, 10)) {
    process.stdout.write(
      `  ${String(prospect.score).padStart(3)}  ${prospect.display_name.padEnd(38).slice(0, 38)} ${(prospect.city ?? '').padEnd(18).slice(0, 18)} ${prospect.stage}\n`,
    );
  }
  process.stdout.write('\n');

  await sql.close();
  process.exitCode = passed === checks.length ? 0 : 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 2;
});
