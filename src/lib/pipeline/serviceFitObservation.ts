import type { Sql } from '@/lib/db/sql';
import { loadNiche } from '@/lib/config/load';
import {
  assessCoreServiceFit,
  type CoreServiceFitAssessment,
} from '@/lib/pipeline/coreServiceFit';

/**
 * HERMES-TARGETING-R1 §10 — la couche BASE de `coreServiceFit`.
 *
 * Même séparation qu'ailleurs dans ce répertoire (`audienceObservation` /
 * `scalableOpportunity`, `icpAssessment` / `icpEligibility`) : ce module LIT,
 * l'autre DÉCIDE. C'est ce qui permet d'éprouver la règle sur des cadres de site
 * que les données réelles ne produiront pas de sitôt, sans base ni fixture.
 *
 * La niche n'est pas devinée : elle vient de la campagne du prospect
 * (`campaigns.niche_key`). Un prospect sans campagne, ou dont la niche n'existe
 * plus sur le disque, rend `null` — et `null` se lit comme `UNKNOWN` par
 * l'appelant, donc comme un refus d'envoi automatique. Deviner « atelier »
 * parce que c'est la seule niche du dépôt ferait qu'ajouter une seconde niche
 * appliquerait silencieusement le mauvais vocabulaire.
 */

interface NicheRow {
  nicheKey: string | null;
}

interface EvidenceRow {
  field: string;
  value_text: string | null;
  value_json: unknown;
}

export async function loadCoreServiceFit(
  sql: Sql,
  prospectId: string,
): Promise<CoreServiceFitAssessment | null> {
  const nicheRows = await sql.query<NicheRow>(
    `select c.niche_key as "nicheKey"
       from prospects p
       left join campaigns c on c.id = p.campaign_id
      where p.id = $1`,
    [prospectId],
  );
  const nicheKey = nicheRows[0]?.nicheKey?.trim() ?? '';
  if (nicheKey.length === 0) return null;

  let niche;
  try {
    niche = loadNiche(nicheKey);
  } catch {
    // Une niche référencée en base et absente du disque n'est pas une panne du
    // prospect : c'est une configuration incomplète. Elle se lit comme un
    // inconnu, jamais comme un feu vert.
    return null;
  }

  const evidence = await sql.query<EvidenceRow>(
    `select field, value_text, value_json
       from prospect_evidence
      where prospect_id = $1
      order by observed_at asc`,
    [prospectId],
  );

  return assessCoreServiceFit({ evidence, niche });
}
