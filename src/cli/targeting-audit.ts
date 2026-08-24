#!/usr/bin/env tsx
import { getSql } from '@/lib/db';
import { loadNiche } from '@/lib/config/load';
import { assessServiceScope, type ServiceScopeVerdict } from '@/lib/pipeline/serviceScope';
import { assessMarketScope } from '@/lib/pipeline/marketScope';
import { AUTONOMOUS_POLICY_VERSION } from '@/lib/instagram/autonomousPolicy';

/**
 * HERMES-CLEANING-ONLY-ICP-R1 §11-§12, §21 — le corpus entier relu sous la
 * politique cleaning-only.
 *
 *   npm run targeting:audit                 # tout le corpus
 *   npm run targeting:audit -- --campaign hermes-fresh-supply-r1
 *   npm run targeting:audit -- --scope IN_SCOPE_ONLY --list
 *
 * LECTURE SEULE, sans exception : aucune écriture, aucun navigateur, aucun
 * réseau, et rien ici ne rend un prospect éligible. La commande répond à « que
 * dirait la politique d'aujourd'hui ? », jamais à « applique-la ».
 *
 * Ce qu'elle NE fait PAS non plus : rejouer l'historique commercial. §12 est
 * explicite — un prospect déjà contacté reste déjà contacté, un opt-out reste
 * terminal. Ce rapport dit seulement si un prospect SERAIT compatible avec
 * l'ICP actuel ; les colonnes `contacté` et `exclu` sont affichées à côté pour
 * qu'on ne confonde jamais les deux questions.
 */

const SCOPES: readonly ServiceScopeVerdict[] = [
  'IN_SCOPE_ONLY',
  'MIXED_WITH_OUT_OF_SCOPE',
  'OUT_OF_SCOPE_SPECIALIST',
  'UNKNOWN',
];

interface Row {
  prospectId: string;
  displayName: string;
  campaignSlug: string | null;
  nicheKey: string | null;
  stage: string | null;
  instagramHandle: string | null;
  registryId: string | null;
  postalCode: string | null;
  domain: string | null;
  websiteUrl: string | null;
  businessEntityId: string | null;
  contacted: number;
  suppressed: number;
}

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

async function main(): Promise<void> {
  const campaign = arg('campaign');
  const scopeFilter = arg('scope');
  const list = process.argv.includes('--list');
  const sql = await getSql();

  try {
    const rows = await sql.query<Row>(
      `select p.id                as "prospectId",
              p.display_name      as "displayName",
              c.slug              as "campaignSlug",
              c.niche_key         as "nicheKey",
              p.stage             as "stage",
              p.instagram_handle  as "instagramHandle",
              p.registry_id       as "registryId",
              p.postal_code       as "postalCode",
              p.domain            as "domain",
              p.website_url       as "websiteUrl",
              p.business_entity_id as "businessEntityId",
              (select count(*) from outreach_events o where o.prospect_id = p.id)::int as "contacted",
              (select count(*) from do_not_contact d
                where (d.match_kind = 'instagram'   and lower(d.value) = lower(p.instagram_handle))
                   or (d.match_kind = 'email'       and lower(d.value) = lower(p.email))
                   or (d.match_kind = 'domain'      and lower(d.value) = lower(p.domain))
                   or (d.match_kind = 'registry_id' and d.value = p.registry_id))::int as "suppressed"
         from prospects p
         left join campaigns c on c.id = p.campaign_id
        where p.dedupe_status <> 'merged'
          and ($1::text is null or c.slug = $1)
        order by c.slug, p.display_name`,
      [campaign],
    );

    // Les preuves de tout le corpus en une requête : une par prospect ferait
    // 380 allers-retours pour un rapport de lecture.
    const evidence = await sql.query<{
      prospectId: string;
      field: string;
      value_text: string | null;
      value_json: unknown;
    }>(
      `select prospect_id as "prospectId", field, value_text, value_json
         from prospect_evidence
        where prospect_id = any($1::uuid[])
        order by observed_at asc`,
      [rows.map((row) => row.prospectId)],
    );
    const byProspect = new Map<string, { field: string; value_text: string | null; value_json: unknown }[]>();
    for (const row of evidence) {
      const list_ = byProspect.get(row.prospectId) ?? [];
      list_.push({ field: row.field, value_text: row.value_text, value_json: row.value_json });
      byProspect.set(row.prospectId, list_);
    }

    const byScope = new Map<ServiceScopeVerdict, Row[]>(SCOPES.map((scope) => [scope, []]));
    const families = new Map<string, number>();
    const entities = new Set<string>();
    let inMarket = 0;
    const results: { row: Row; scope: ServiceScopeVerdict; anchored: boolean; families: readonly string[] }[] = [];

    for (const row of rows) {
      if (row.businessEntityId !== null) entities.add(row.businessEntityId);
      const nicheKey = row.nicheKey?.trim() ?? '';
      let scope: ServiceScopeVerdict = 'UNKNOWN';
      let found: readonly string[] = [];
      if (nicheKey.length > 0) {
        try {
          const assessment = assessServiceScope({
            evidence: byProspect.get(row.prospectId) ?? [],
            niche: loadNiche(nicheKey),
          });
          scope = assessment.verdict;
          found = assessment.outOfScopeFamilies;
        } catch {
          scope = 'UNKNOWN';
        }
      }
      for (const family of found) families.set(family, (families.get(family) ?? 0) + 1);
      const market = assessMarketScope(row);
      if (market.verdict === 'IN_MARKET') inMarket += 1;
      byScope.get(scope)?.push(row);
      results.push({ row, scope, anchored: market.verdict === 'IN_MARKET', families: found });
    }

    const out = (line: string): void => void process.stdout.write(`${line}\n`);
    out('');
    out(`HERMES-CLEANING-ONLY-ICP-R1 — audit de ciblage (LECTURE SEULE)`);
    out(`  politique                 ${AUTONOMOUS_POLICY_VERSION}`);
    out(`  périmètre                 ${campaign ?? 'tout le corpus'}`);
    out(`  lignes prospects          ${String(rows.length)}`);
    out(`  entreprises canoniques    ${String(entities.size)}`);
    out(`  lignes en doublon métier  ${String(rows.length - entities.size)}`);
    out('');
    out('  Portée de service :');
    for (const scope of SCOPES) {
      const bucket = byScope.get(scope) ?? [];
      out(`    ${scope.padEnd(24)} ${String(bucket.length).padStart(4)}`);
    }
    out('');
    out(`  Ancre de marché française ${String(inMarket)} / ${String(rows.length)}`);
    out('');
    if (families.size > 0) {
      out('  Familles non-prestation standard rencontrées :');
      for (const [family, count] of [...families].sort((a, b) => b[1] - a[1])) {
        out(`    ${family.padEnd(28)} ${String(count).padStart(4)}`);
      }
      out('');
    }

    if (list) {
      const wanted = scopeFilter === null ? null : scopeFilter.toUpperCase();
      out('  Détail :');
      for (const result of results) {
        if (wanted !== null && result.scope !== wanted) continue;
        const flags = [
          result.anchored ? 'FR' : 'marché?',
          result.row.contacted > 0 ? 'contacté' : '',
          result.row.suppressed > 0 ? 'opt-out' : '',
        ]
          .filter((flag) => flag.length > 0)
          .join(' ');
        out(
          `    ${result.scope.padEnd(24)} @${(result.row.instagramHandle ?? '—').padEnd(26)} ` +
            `${(result.row.stage ?? '—').padEnd(14)} ${result.row.displayName.slice(0, 34).padEnd(35)} ` +
            `${flags}${result.families.length > 0 ? ` [${result.families.join(',')}]` : ''}`,
        );
      }
      out('');
    }
  } finally {
    await sql.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
