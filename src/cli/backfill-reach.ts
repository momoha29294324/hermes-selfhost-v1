#!/usr/bin/env tsx
/**
 * Calcule `contactable`, `funnel_observable` et `commercial_visibility` pour des
 * prospects déjà en base.
 *
 *   npm run backfill:reach
 *   npm run backfill:reach -- --campaign example-campaign
 *   npm run backfill:reach -- --dry-run
 *
 * Ces trois colonnes sont écrites par l'étape d'enrichissement depuis R2. Un
 * corpus antérieur les a donc à `null`, et un `null` affiché comme « 0
 * contactable » est une affirmation d'absence — ce que ce dépôt s'interdit.
 * Cette commande mesure ce qui est déjà observé, sans rien collecter de neuf :
 * aucun appel réseau, aucun LLM, aucune modification des observations
 * elles-mêmes. Elle ne fait que dériver, avec les mêmes fonctions testées que le
 * pipeline (`src/lib/pipeline/reach.ts`).
 */
import { getSql } from '@/lib/db';
import { envBool } from '@/lib/env';
import { createLogger } from '@/lib/logging/logger';
import { ProspectRepository } from '@/lib/repo/prospects';
import { assessReach } from '@/lib/pipeline/reach';
import type { EvidenceLike } from '@/lib/pipeline/score';
import type { ProspectRow } from '@/lib/repo/types';

function arg(name: string, fallback: string | null = null): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback);
}

async function main(): Promise<void> {
  if (envBool('OUTBOUND_ALLOW_SENDING', false)) {
    throw new Error('OUTBOUND_ALLOW_SENDING must stay 0 in V1.');
  }

  const slug = arg('campaign');
  const dryRun = process.argv.includes('--dry-run');
  const onlyMissing = !process.argv.includes('--all');

  const sql = await getSql();
  const repo = new ProspectRepository(sql, createLogger({ cli: 'backfill-reach' }));

  const clauses = ["dedupe_status <> 'merged'"];
  const params: unknown[] = [];
  if (slug) {
    params.push(slug);
    clauses.push(`campaign_id = (select id from campaigns where slug = $${params.length})`);
  }
  if (onlyMissing) clauses.push('contactable is null');

  const prospects = await sql.query<ProspectRow>(
    `select * from prospects where ${clauses.join(' and ')} order by display_name`,
    params,
  );

  process.stdout.write(
    `\nBackfill de la portée — ${prospects.length} prospect(s)` +
      `${slug ? ` de la campagne « ${slug} »` : ''}` +
      `${onlyMissing ? ' sans mesure existante' : ''}` +
      `${dryRun ? ' — simulation, rien n’est écrit' : ''}\n\n`,
  );

  let contactable = 0;
  let funnelObservable = 0;
  let both = 0;

  for (const prospect of prospects) {
    const evidence = await sql.query<EvidenceLike>(
      `select id, field, value_text, value_json, provider, source_url
         from prospect_evidence where prospect_id = $1`,
      [prospect.id],
    );
    const reach = assessReach({ prospect, evidence });

    if (reach.contactable) contactable += 1;
    if (reach.funnelObservable) funnelObservable += 1;
    if (reach.contactable && reach.funnelObservable && prospect.niche_verdict === 'in_niche') both += 1;

    if (!dryRun) {
      await repo.saveReach(prospect.id, {
        contactable: reach.contactable,
        channels: reach.channels,
        funnelObservable: reach.funnelObservable,
        funnelSignalCount: reach.funnelSignalCount,
        commercialVisibility: reach.commercialVisibility,
      });
    }
  }

  /**
   * Provenance de découverte, dérivée de `prospect_sources`.
   *
   * `prospect_discovery_origins` date de R2, mais l'information qu'elle porte
   * existait déjà : chaque ligne `prospect_sources` de rôle `discovery` dit quel
   * fournisseur a vu l'entreprise. La dériver n'invente rien — c'est la même
   * observation, rangée là où le dashboard et le benchmark la cherchent. Sans
   * cela, un corpus antérieur affiche « 0 rail long-tail », ce qui est faux.
   */
  const backfilledOrigins = dryRun
    ? 0
    : (
        await sql.query<{ prospect_id: string }>(
          `insert into prospect_discovery_origins (prospect_id, campaign_id, provider, rail, external_id, first_seen_at)
           select s.prospect_id, p.campaign_id, s.provider,
                  case when s.provider = 'google_places' then 'commercial' else 'long_tail' end,
                  s.external_id, s.collected_at
             from prospect_sources s
             join prospects p on p.id = s.prospect_id
            where s.role = 'discovery' and ($1::text is null or p.campaign_id = (select id from campaigns where slug = $1))
           on conflict (prospect_id, provider) do nothing
           returning prospect_id`,
          [slug],
        )
      ).length;

  if (!dryRun && backfilledOrigins > 0) {
    await sql.query(
      `update prospects p
          set discovery_rail = coalesce(p.discovery_rail, o.rail),
              discovery_provider = coalesce(p.discovery_provider, o.provider),
              updated_at = now()
         from (
           select distinct on (prospect_id) prospect_id, rail, provider
             from prospect_discovery_origins
            order by prospect_id, first_seen_at asc
         ) o
        where o.prospect_id = p.id and p.discovery_rail is null`,
    );
  }

  const rows: [string, string][] = [
    ['Prospects mesurés', String(prospects.length)],
    ['Origines de découverte dérivées', String(backfilledOrigins)],
    ['Contactables', String(contactable)],
    ['Parcours observable', String(funnelObservable)],
    ['in_niche + contactable + observable', String(both)],
  ];
  for (const [label, value] of rows) {
    process.stdout.write(`${label.padEnd(40, '.')} ${value}\n`);
  }
  process.stdout.write(
    `\n${dryRun ? 'Simulation : aucune colonne écrite.' : 'Colonnes de portée écrites.'} ` +
      'Aucune observation n’a été collectée ni modifiée — seules des valeurs dérivées ont été mises à jour.\n\n',
  );

  await sql.close();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
