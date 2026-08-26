import type { Sql } from '@/lib/db/sql';
import { loadNiche } from '@/lib/config/load';
import { assessServiceScope, type ServiceScopeAssessment } from '@/lib/pipeline/serviceScope';

/**
 * HERMES-SERVICE-SCOPE-TARGETING-R1 — la couche BASE de `serviceScope`.
 *
 * Même séparation que partout ailleurs dans ce répertoire
 * (`serviceFitObservation` / `coreServiceFit`, `audienceObservation` /
 * `scalableOpportunity`) : ce module LIT, l'autre DÉCIDE.
 *
 * La niche vient de la campagne du prospect, jamais d'un défaut. Un prospect
 * sans campagne, ou dont la niche n'existe plus sur le disque, rend `null` — et
 * `null` se lit `UNKNOWN` chez l'appelant, donc comme un refus d'envoi
 * automatique. Deviner « atelier » parce que c'est la seule niche du dépôt
 * ferait qu'ajouter une seconde niche appliquerait silencieusement le mauvais
 * vocabulaire.
 */

interface NicheRow {
  nicheKey: string | null;
}

interface EvidenceRow {
  field: string;
  value_text: string | null;
  value_json: unknown;
}

export async function loadServiceScope(
  sql: Sql,
  prospectId: string,
): Promise<ServiceScopeAssessment | null> {
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
    return null;
  }

  const evidence = await sql.query<EvidenceRow>(
    `select field, value_text, value_json
       from prospect_evidence
      where prospect_id = $1
      order by observed_at asc`,
    [prospectId],
  );

  return assessServiceScope({ evidence, niche });
}
