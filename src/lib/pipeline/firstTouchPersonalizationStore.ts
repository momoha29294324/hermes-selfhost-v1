/**
 * HERMES-END-TO-END-CERTIFICATION-R1 — la LECTURE des preuves, séparée de leur
 * interprétation.
 *
 * `firstTouchPersonalization.ts` est pur : il reçoit des lignes et rend une
 * accroche. Ce module est la seule chose qui touche la base, et il ne fait que
 * lire — aucun `insert`, aucun `update`, aucun `delete`.
 *
 * La séparation n'est pas décorative : elle rend la décision testable sans base
 * et rejouable sur des lignes figées, ce que la certification exige.
 */

import {
  buildFirstTouchPersonalization,
  type FirstTouchPersonalization,
  type PersonalizationEvidence,
} from '@/lib/pipeline/firstTouchPersonalization';
import type { Sql } from '@/lib/db/sql';

/**
 * Les champs que la personnalisation sait lire.
 *
 * Une liste POSITIVE plutôt qu'un `select *` : `prospect_evidence` porte aussi
 * des adresses, des numéros de registre et des identifiants de résolution, qui
 * n'ont rien à faire dans une conversation. Ce qui n'est pas nommé ici n'entre
 * pas, et ajouter un champ est une décision qu'un diff montre.
 */
export const PERSONALIZATION_FIELDS: readonly string[] = Object.freeze([
  'services',
  'premium_services',
  'website_description',
  'website_title',
  'funnel_synthesis',
  'booking_system',
  'city',
]);

/** Les lignes de preuve d'un prospect, bornées aux champs utilisables. */
export async function loadPersonalizationEvidence(
  sql: Sql,
  prospectId: string,
): Promise<readonly PersonalizationEvidence[]> {
  return sql.query<PersonalizationEvidence>(
    `select id, field, value_text as "valueText", provider, method,
            confidence, source_url as "sourceUrl"
       from prospect_evidence
      where prospect_id = $1
        and field = any($2::text[])
      order by field asc, observed_at asc, id asc`,
    [prospectId, [...PERSONALIZATION_FIELDS]],
  );
}

export interface LoadPersonalizationInput {
  readonly prospectId: string;
  readonly displayName: string;
  readonly city: string | null;
  /** L'accroche de l'angle commercial, quand une existe. Elle gagne. */
  readonly angleHook?: string | null;
}

/** Lit les preuves d'un prospect et en tire son accroche. Lecture seule. */
export async function loadFirstTouchPersonalization(
  sql: Sql,
  input: LoadPersonalizationInput,
): Promise<FirstTouchPersonalization> {
  const evidence = await loadPersonalizationEvidence(sql, input.prospectId);
  return buildFirstTouchPersonalization({
    evidence,
    displayName: input.displayName,
    city: input.city,
    angleHook: input.angleHook ?? null,
  });
}
