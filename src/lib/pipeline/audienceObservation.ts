import type { Sql } from '@/lib/db/sql';
import type { ScalableOpportunityConfig } from '@/lib/config/schema';
import {
  audienceIsOutOfScope,
  classifyAudienceScale,
  type AudienceObservation,
  type AudienceScale,
} from '@/lib/pipeline/scalableOpportunity';

/**
 * R7.6-GATE — la couche base de l'échelle d'audience.
 *
 * Ce module lit et écrit ; il ne DÉCIDE pas. La règle — les bandes, le seuil,
 * l'exigence d'attribution — vit dans `scalableOpportunity.ts`, pure et
 * testable sans base. C'est exactement la séparation d'`icpAssessment.ts` /
 * `icpEligibility.ts`, et elle sert la même chose : pouvoir éprouver la
 * décision sur des états que les données réelles ne produiront pas de sitôt.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi cette table existe, alors que R7.3C refusait d'importer les profils
 * ---------------------------------------------------------------------------
 * R7.3C §32 gardait les observations Instagram sous `var/` pour une raison qui
 * tient toujours : une observation ENTIÈRE — biographie, publications,
 * captures — deviendrait consultable par le CRM et finirait lue comme un fait
 * établi. L'audit du 21 août 2026 a montré l'autre moitié du problème : les
 * deux portes qui décident d'un envoi ne lisent QUE la base, et la règle
 * métier « au-delà de 10 000 abonnés attribués, hors créneau » leur était donc
 * structurellement invisible. @demo_account_09 (20 179 abonnés, identité
 * MATCH) est entré dans un batch alors que la donnée ET la règle existaient.
 *
 * Ce qui traverse est donc réduit au strict nécessaire : un compteur, son
 * attribution, sa date, sa source. Le profil complet reste sous `var/`.
 */

export interface StoredAudienceObservation {
  readonly prospectId: string;
  readonly platform: 'instagram';
  readonly handle: string;
  readonly followersCount: number | null;
  readonly attributed: boolean;
  readonly observedAt: string;
  readonly source: string;
}

const STORED_COLUMNS = `prospect_id as "prospectId", platform, handle,
        followers_count as "followersCount", attributed,
        observed_at as "observedAt", source`;

/**
 * La dernière audience observée pour ce prospect, ou `null`.
 *
 * `null` n'est PAS « ce prospect est petit » : c'est « personne n'a ouvert son
 * profil ». Les appelants doivent traiter les deux différemment — c'est la
 * règle n°2 de CLAUDE.md, et c'est aussi ce que `classifyAudienceScale` rend
 * en `UNKNOWN` quand on lui passe `null`.
 */
export async function loadLatestAudienceObservation(
  sql: Sql,
  prospectId: string,
  platform: 'instagram' = 'instagram',
): Promise<StoredAudienceObservation | null> {
  const rows = await sql.query<StoredAudienceObservation>(
    `select ${STORED_COLUMNS} from prospect_audience_observations
      where prospect_id = $1 and platform = $2
      order by observed_at desc, id desc
      limit 1`,
    [prospectId, platform],
  );
  return rows[0] ?? null;
}

export interface RecordAudienceObservationInput {
  readonly prospectId: string;
  readonly platform: 'instagram';
  readonly handle: string;
  readonly followersCount: number | null;
  readonly attributed: boolean;
  readonly observedAt: string;
  readonly source: string;
  readonly observationRunId: string | null;
  readonly importedBy: string;
}

/**
 * Archive une observation d'audience. INSERT seulement.
 *
 * Un compteur qu'on réécrit ne prouve rien, et l'unicité
 * `(prospect_id, platform, handle, observed_at)` rend un import rejouable sans
 * inventer d'historique : réimporter le même fichier ne crée pas une seconde
 * lecture du même instant. `false` quand la ligne existait déjà.
 */
export async function recordAudienceObservation(
  sql: Sql,
  input: RecordAudienceObservationInput,
): Promise<boolean> {
  const rows = await sql.query<{ id: string }>(
    `insert into prospect_audience_observations
       (prospect_id, platform, handle, followers_count, attributed, observed_at, source,
        observation_run_id, imported_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict on constraint prospect_audience_observation_unique do nothing
     returning id`,
    [
      input.prospectId,
      input.platform,
      input.handle,
      input.followersCount,
      input.attributed,
      input.observedAt,
      input.source,
      input.observationRunId,
      input.importedBy,
    ],
  );
  return rows.length > 0;
}

/**
 * Le verdict de taille d'un prospect, tel que les portes d'envoi doivent le
 * lire.
 *
 * Trois sorties possibles, et la différence entre les deux dernières est le
 * sujet :
 *
 *   `excluded: true`   un compteur ATTRIBUÉ au-delà du seuil. La porte ferme.
 *   `excluded: false` avec `scale.band === 'UNKNOWN'` — rien n'a été lu, ou le
 *                     compte n'est pas le sien. La porte ne ferme pas : ne pas
 *                     savoir n'est pas savoir le contraire, et faire de
 *                     l'absence d'observation un refus reviendrait à exclure
 *                     tout prospect dont personne n'a ouvert le profil.
 *   `excluded: false` avec une bande mesurée — dans le créneau.
 */
export interface AudienceScaleVerdict {
  readonly scale: AudienceScale;
  readonly excluded: boolean;
  readonly observed: StoredAudienceObservation | null;
}

export async function assessAudienceScaleForProspect(
  sql: Sql,
  prospectId: string,
  config: ScalableOpportunityConfig,
): Promise<AudienceScaleVerdict> {
  const stored = await loadLatestAudienceObservation(sql, prospectId);
  const observation: AudienceObservation | null =
    stored === null ? null : { followers: stored.followersCount, attributed: stored.attributed };
  const scale = classifyAudienceScale(observation, config);
  return { scale, excluded: audienceIsOutOfScope(scale, config), observed: stored };
}
