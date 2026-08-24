#!/usr/bin/env tsx
/**
 * La revue manuelle obligatoire (§19).
 *
 *   npm run review:table -- --campaign example-campaign
 *   npm run review:table -- --limit 20 --dry-run
 *
 * Produit les vingt meilleurs prospects sous une forme relisible à la main, et
 * y ajoute l'avis du système : SEND, EDIT ou REJECT.
 *
 * Deux choses que cet outil ne fait pas, et qu'il ne doit jamais faire :
 *
 *   - **il n'envoie rien.** Aucun chemin d'envoi n'existe dans ce dépôt, et
 *     `OUTBOUND_ALLOW_SENDING` reste à 0. « SEND » est une phrase adressée à
 *     un opérateur, pas un ordre adressé à une machine ;
 *   - **il ne décide pas.** L'avis est écrit sur le prospect pour que le tableau
 *     de bord puisse trier par risque ; la décision reste celle d'un humain, et
 *     elle continue de vivre sur `outreach_messages.state`.
 *
 * L'écriture de la recommandation est la seule écriture de ce script. Elle est
 * dérivée — recalculable à tout moment depuis les mêmes colonnes — et
 * `--dry-run` la supprime.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { getSql } from '@/lib/db';
import { logger } from '@/lib/logging/logger';
import { ProspectRepository } from '@/lib/repo/prospects';
import { readOnlyQuery } from '@/lib/db/safety';
import { recommendOutreach } from '@/lib/pipeline/recommendation';
import type { ProspectRow } from '@/lib/repo/types';

const CAMPAIGN_SQL = 'select id from campaigns where slug = $1';

/**
 * Le corpus de revue, trié par score.
 *
 * `left join lateral` sur le message principal plutôt qu'un `join` : un
 * prospect sans message doit apparaître dans le tableau — c'est précisément un
 * cas que la revue doit voir, et un `join` l'aurait fait disparaître en silence.
 */
const REVIEW_SQL = `
  select p.*,
         m.state              as message_state,
         m.personalization_level as personalization_level,
         m.body               as message_body,
         coalesce(jsonb_array_length(m.guardrail_flags), 0) as guardrail_count,
         a.pain_point         as angle_pain_point,
         a.approach           as angle_approach
    from prospects p
    left join lateral (
      select state, personalization_level, body, guardrail_flags
        from outreach_messages
       where prospect_id = p.id and is_primary = true
       order by created_at desc limit 1
    ) m on true
    left join lateral (
      select pain_point, approach from prospect_angles
       where prospect_id = p.id order by created_at desc limit 1
    ) a on true
   where p.campaign_id = $1
     and p.dedupe_status <> 'merged'
   order by p.score desc nulls last, p.display_name asc
   limit $2
`;

interface ReviewRow extends ProspectRow {
  message_state: string | null;
  personalization_level: string | null;
  message_body: string | null;
  guardrail_count: number;
  angle_pain_point: string | null;
  angle_approach: string | null;
}

function arg(name: string, fallback: string | null = null): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function channelsOf(prospect: ProspectRow): string {
  return (
    [
      prospect.instagram_handle ? `IG @${prospect.instagram_handle}` : null,
      prospect.email ? 'email' : null,
      prospect.phone ? 'tél' : null,
      prospect.facebook_url ? 'FB' : null,
      prospect.website_url ? 'site' : null,
    ]
      .filter(Boolean)
      .join(' · ') || '—'
  );
}

function cell(value: string | null | undefined, fallback = '—'): string {
  const text = (value ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
  return text.length > 0 ? text : fallback;
}

async function main(): Promise<void> {
  const campaignSlug = arg('campaign', 'example-campaign') as string;
  const limit = Number.parseInt(arg('limit', '20') as string, 10);
  const dryRun = process.argv.includes('--dry-run');
  const reportDir = resolvePath(process.cwd(), arg('report', 'var/benchmarks') as string);

  const sql = await getSql();
  const repo = new ProspectRepository(sql, logger);

  const campaigns = await readOnlyQuery<{ id: string }>(sql, CAMPAIGN_SQL, [campaignSlug], 'review.campaign');
  const campaignId = campaigns[0]?.id;
  if (!campaignId) {
    process.stdout.write(`Aucune campagne « ${campaignSlug} » en base.\n`);
    await sql.close();
    process.exitCode = 2;
    return;
  }

  const rows = await readOnlyQuery<ReviewRow>(sql, REVIEW_SQL, [campaignId, limit], 'review.rows');
  if (rows.length === 0) {
    process.stdout.write(`La campagne « ${campaignSlug} » n'a aucun prospect à relire.\n`);
    await sql.close();
    process.exitCode = 2;
    return;
  }

  const reviewed = rows.map((row) => {
    const result = recommendOutreach({
      prospect: row,
      message: {
        exists: row.message_body !== null,
        blocked: row.guardrail_count > 0,
        personalizationLevel:
          (row.personalization_level as 'none' | 'low' | 'medium' | 'high' | null) ?? null,
      },
    });
    return { row, result };
  });

  if (!dryRun) {
    for (const { row, result } of reviewed) {
      await repo.saveRecommendation(row.id, result.recommendation, result.reason);
    }
  }

  const counts = reviewed.reduce<Record<string, number>>((acc, entry) => {
    acc[entry.result.recommendation] = (acc[entry.result.recommendation] ?? 0) + 1;
    return acc;
  }, {});

  const lines: string[] = [
    `# Revue manuelle — ${campaignSlug}`,
    '',
    `${rows.length} prospect(s), classés par score. ` +
      `SEND ${counts['send'] ?? 0} · EDIT ${counts['edit'] ?? 0} · REJECT ${counts['reject'] ?? 0}.`,
    '',
    'La recommandation est celle du **système**. Elle n’autorise ni ne déclenche aucun envoi :',
    'aucun code d’envoi n’existe dans ce dépôt et `OUTBOUND_ALLOW_SENDING` reste à 0.',
    '',
    '| # | entreprise | ville | site | Instagram | score | parcours | canal | identité | angle | message | RECOMMANDATION | motif |',
    '| ---: | --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- |',
  ];

  for (const [index, { row, result }] of reviewed.entries()) {
    lines.push(
      `| ${index + 1} ` +
        `| ${cell(row.display_name)} ` +
        `| ${cell(row.city)} ` +
        `| ${cell(row.website_url)} ` +
        `| ${row.instagram_handle ? `@${row.instagram_handle}` : '—'} ` +
        `| ${row.score ?? '—'} ` +
        `| ${cell(row.funnel_summary, 'non observé')} ` +
        `| ${cell(channelsOf(row))} ` +
        `| ${cell(row.identity_review)} ` +
        `| ${cell(row.angle_pain_point)} ` +
        `| ${cell(row.message_state, 'aucun')} ` +
        `| **${result.recommendation.toUpperCase()}** ` +
        `| ${cell(result.reason)} |`,
    );
  }

  lines.push('', '## Motifs détaillés', '');
  for (const [index, { row, result }] of reviewed.entries()) {
    lines.push(`### ${index + 1}. ${row.display_name}`, '');
    for (const reason of result.reasons) lines.push(`- ${reason}`);
    lines.push('');
  }

  const markdown = lines.join('\n');
  await mkdir(reportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = resolvePath(reportDir, `review-${campaignSlug}-${stamp}.md`);
  await writeFile(path, markdown, 'utf8');

  process.stdout.write(`${markdown}\n\nTableau : ${path}\n`);
  await sql.close();
}

void (async (): Promise<void> => {
  try {
    await main();
  } catch (error) {
    logger.error('review.table_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
})();
