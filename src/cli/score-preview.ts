#!/usr/bin/env tsx
/**
 * Aperçu de repondération — ce qui change si l'on change le score (§11).
 *
 *   npm run score:preview -- --campaign example-campaign
 *   npm run score:preview -- --before example-v1 --after example-campaign
 *
 * Le §11 du gate R5 est explicite sur l'ordre des opérations : capturer les
 * scores existants, produire un aperçu, comparer les classements, couvrir la
 * modification par des tests — et **ne changer le score que si le nouveau
 * corpus montre clairement une amélioration**. Cet outil est l'étape « aperçu »,
 * et il n'écrit rien : toutes ses lectures passent par `readOnlyQuery`.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi comparer des classements plutôt que des scores
 * ---------------------------------------------------------------------------
 * Deux profils qui n'ont ni les mêmes pondérations ni le même nombre de signaux
 * ne produisent pas des nombres comparables : passer de 61 à 68 ne veut rien
 * dire si le dénominateur a changé. Ce qui est comparable, et ce qui décide
 * réellement du travail, c'est **l'ordre** — quels prospects un commercial
 * ouvrirait en premier.
 *
 * D'où les trois mesures publiées :
 *
 *   - le recouvrement du top 10 et du top 20 : si les deux profils désignent le
 *     même travail, la repondération est cosmétique et ne mérite pas d'être
 *     adoptée ;
 *   - le déplacement médian et maximal d'un prospect dans le classement ;
 *   - les entrées et sorties du top 10, nommées. C'est la seule façon de juger
 *     une repondération autrement qu'en confiance : il faut pouvoir regarder les
 *     entreprises qui montent et dire si elles méritent de monter.
 */
import { getSql } from '@/lib/db';
import { logger } from '@/lib/logging/logger';
import { loadCampaign, loadScoringProfile } from '@/lib/config/load';
import { readOnlyQuery } from '@/lib/db/safety';
import { scoreProspect } from '@/lib/pipeline/score';
import type { EvidenceLike } from '@/lib/pipeline/score';
import type { ProspectRow } from '@/lib/repo/types';

const CAMPAIGN_SQL = 'select id from campaigns where slug = $1';

const PROSPECTS_SQL = `
  select * from prospects
   where campaign_id = $1
     and dedupe_status <> 'merged'
   order by display_name asc
`;

const EVIDENCE_SQL = `
  select prospect_id, id, field, value_text, value_json, provider, source_url
    from prospect_evidence
   where prospect_id = any($1::uuid[])
`;

function arg(name: string, fallback: string | null = null): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

function overlap(left: readonly string[], right: readonly string[]): number {
  const set = new Set(right);
  return left.filter((id) => set.has(id)).length;
}

async function main(): Promise<void> {
  const campaignSlug = arg('campaign', 'example-campaign') as string;
  const campaign = loadCampaign(campaignSlug);
  const beforeKey = arg('before', 'example-v1') as string;
  const afterKey = arg('after', campaign.scoring.profile) as string;

  const beforeProfile = loadScoringProfile(beforeKey);
  const afterProfile = loadScoringProfile(afterKey);

  const sql = await getSql();
  const campaigns = await readOnlyQuery<{ id: string }>(sql, CAMPAIGN_SQL, [campaignSlug], 'score.campaign');
  const campaignId = campaigns[0]?.id;
  if (!campaignId) {
    process.stdout.write(`Aucune campagne « ${campaignSlug} » en base. Rien à comparer.\n`);
    await sql.close();
    process.exitCode = 2;
    return;
  }

  const prospects = await readOnlyQuery<ProspectRow>(sql, PROSPECTS_SQL, [campaignId], 'score.prospects');
  if (prospects.length === 0) {
    process.stdout.write(`La campagne « ${campaignSlug} » n'a aucun prospect. Rien à comparer.\n`);
    await sql.close();
    process.exitCode = 2;
    return;
  }

  const evidenceRows = await readOnlyQuery<EvidenceLike & { prospect_id: string }>(
    sql,
    EVIDENCE_SQL,
    [prospects.map((prospect) => prospect.id)],
    'score.evidence',
  );
  const byProspect = new Map<string, EvidenceLike[]>();
  for (const row of evidenceRows) {
    const list = byProspect.get(row.prospect_id) ?? [];
    list.push(row);
    byProspect.set(row.prospect_id, list);
  }

  const scored = prospects.map((prospect) => {
    const evidence = byProspect.get(prospect.id) ?? [];
    return {
      id: prospect.id,
      name: prospect.display_name,
      city: prospect.city,
      stored: prospect.score,
      before: scoreProspect({ prospect, evidence, profile: beforeProfile }),
      after: scoreProspect({ prospect, evidence, profile: afterProfile }),
    };
  });

  const rankBefore = [...scored].sort((a, b) => b.before.total - a.before.total || a.name.localeCompare(b.name));
  const rankAfter = [...scored].sort((a, b) => b.after.total - a.after.total || a.name.localeCompare(b.name));

  const positionBefore = new Map(rankBefore.map((entry, index) => [entry.id, index + 1]));
  const positionAfter = new Map(rankAfter.map((entry, index) => [entry.id, index + 1]));
  const movements = scored.map((entry) =>
    Math.abs((positionBefore.get(entry.id) ?? 0) - (positionAfter.get(entry.id) ?? 0)),
  );

  const top10Before = rankBefore.slice(0, 10).map((entry) => entry.id);
  const top10After = rankAfter.slice(0, 10).map((entry) => entry.id);
  const top20Before = rankBefore.slice(0, 20).map((entry) => entry.id);
  const top20After = rankAfter.slice(0, 20).map((entry) => entry.id);

  const entering = rankAfter.slice(0, 10).filter((entry) => !top10Before.includes(entry.id));
  const leaving = rankBefore.slice(0, 10).filter((entry) => !top10After.includes(entry.id));

  process.stdout.write(
    `\nAperçu de repondération — ${campaignSlug}\n` +
      `Avant : ${beforeProfile.key} v${beforeProfile.version} (${beforeProfile.signals.length} signaux)\n` +
      `Après : ${afterProfile.key} v${afterProfile.version} (${afterProfile.signals.length} signaux)\n` +
      `Corpus : ${prospects.length} prospect(s)\n\n`,
  );

  process.stdout.write(
    `Recouvrement du top 10 : ${overlap(top10Before, top10After)}/${Math.min(10, scored.length)}\n` +
      `Recouvrement du top 20 : ${overlap(top20Before, top20After)}/${Math.min(20, scored.length)}\n` +
      `Déplacement médian    : ${median(movements).toFixed(1)} place(s)\n` +
      `Déplacement maximal   : ${Math.max(0, ...movements)} place(s)\n\n`,
  );

  process.stdout.write('Classement après repondération (20 premiers)\n');
  process.stdout.write(
    `${'rang'.padStart(4)}  ${'entreprise'.padEnd(34)} ${'ville'.padEnd(14)} ${'après'.padStart(5)} ${'avant'.padStart(5)}  écart\n`,
  );
  for (const [index, entry] of rankAfter.slice(0, 20).entries()) {
    const before = positionBefore.get(entry.id) ?? 0;
    const delta = before - (index + 1);
    process.stdout.write(
      `${String(index + 1).padStart(4)}  ${entry.name.slice(0, 34).padEnd(34)} ` +
        `${(entry.city ?? '—').slice(0, 14).padEnd(14)} ` +
        `${String(entry.after.total).padStart(5)} ${String(entry.before.total).padStart(5)}  ` +
        `${delta > 0 ? `+${delta}` : String(delta)}\n`,
    );
  }

  process.stdout.write('\nEntrées dans le top 10\n');
  if (entering.length === 0) process.stdout.write('  (aucune)\n');
  for (const entry of entering) {
    const driver = entry.after.signals
      .filter((signal) => signal.observed)
      .sort((a, b) => b.points - a.points)[0];
    process.stdout.write(
      `  ${entry.name} — ${entry.after.total} pts, portée par « ${driver?.label ?? '—'} » : ${driver?.detail ?? '—'}\n`,
    );
  }

  process.stdout.write('\nSorties du top 10\n');
  if (leaving.length === 0) process.stdout.write('  (aucune)\n');
  for (const entry of leaving) {
    process.stdout.write(
      `  ${entry.name} — ${entry.before.total} → ${entry.after.total} pts ` +
        `(signaux non observés : ${entry.after.missingSignals.join(', ') || 'aucun'})\n`,
    );
  }

  /**
   * La conclusion est délibérément une question posée à un humain, et non un
   * verdict. Un recouvrement faible peut signifier « la nouvelle pondération
   * voit mieux » ou « elle voit n'importe quoi » ; seule la lecture des
   * entreprises qui montent tranche, et aucun nombre ne remplace ce coup d'œil.
   */
  process.stdout.write(
    '\nÀ décider à la lecture : les entreprises qui montent le méritent-elles ?\n' +
      'Un recouvrement élevé signifie que la repondération ne change pas le travail — ' +
      'auquel cas elle ne mérite pas d’être adoptée.\n\n',
  );

  await sql.close();
}

void (async (): Promise<void> => {
  try {
    await main();
  } catch (error) {
    logger.error('score.preview_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
})();
