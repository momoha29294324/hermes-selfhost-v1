#!/usr/bin/env tsx
import { getSql } from '@/lib/db';
import { linkBusinessEntities } from '@/lib/pipeline/businessEntityLink';

/**
 * HERMES-CLEANING-ONLY-ICP-R1 §13-§14 — « cette entreprise existe-t-elle déjà
 * dans la base, peu importe la campagne ? »
 *
 *   npm run business:link                        # lecture seule : ce qui SERAIT rattaché
 *   npm run business:link -- --apply --as "<nom>"  # rattache réellement
 *
 * Ce que cette commande ne fait pas : elle ne fusionne aucune ligne, n'en
 * supprime aucune, ne touche ni `dedupe_status`, ni `merged_into_id`, ni un
 * manifeste, ni un job, ni l'arrêt global. Elle écrit exactement deux choses —
 * des lignes `business_entities`, et `prospects.business_entity_id`.
 */

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const operator = arg('as');
  if (apply && (operator === null || operator.trim().length === 0)) {
    throw new Error('--apply exige --as "<nom de l’opérateur>" : une écriture porte le nom de qui la décide.');
  }

  const sql = await getSql();
  try {
    const report = await linkBusinessEntities(sql, { apply });
    const out = (line: string): void => void process.stdout.write(`${line}\n`);

    out('');
    out(`HERMES-CLEANING-ONLY-ICP-R1 — entités métier ${apply ? '(APPLIQUÉ)' : '(LECTURE SEULE)'}`);
    if (apply) out(`  opérateur                 ${operator ?? ''}`);
    out(`  lignes examinées          ${String(report.prospectsScanned)}`);
    out(`  lignes rattachées         ${String(report.prospectsLinked)}`);
    out(`  lignes sans clé décisive  ${String(report.prospectsWithoutKey)}`);
    out(`  entités créées            ${String(report.entitiesCreated)}`);
    out(`  entités réutilisées       ${String(report.entitiesReused)}`);
    out(`  entités à plusieurs lignes ${String(report.multiRowEntities)}`);
    out(`  dont multi-campagnes      ${String(report.crossCampaignEntities)}`);

    const shared = report.groups.filter((group) => group.members.length > 1);
    if (shared.length > 0) {
      out('');
      out('Entreprises portées par plusieurs lignes :');
      for (const group of shared) {
        out(`  ${group.canonicalKey}  [${group.campaignSlugs.join(' + ')}]`);
        for (const member of group.members) {
          const mark = member.isRepresentative ? '→' : ' ';
          out(
            `    ${mark} ${member.displayName} (${member.campaignSlug ?? '—'}, ${member.stage ?? '—'}, ` +
              `dedupe=${member.dedupeStatus ?? '—'}) ${member.prospectId}`,
          );
        }
      }
      out('');
      out('  « → » désigne la ligne que l’entité autorise à porter une intention.');
      out('  Aucune ligne n’a été fusionnée ni supprimée : `dedupe_status` est inchangé.');
    }
    out('');
  } finally {
    await sql.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
