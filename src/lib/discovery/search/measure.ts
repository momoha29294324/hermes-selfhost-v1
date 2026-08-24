import { readOnlyQuery } from '@/lib/db/safety';
import type { Sql } from '@/lib/db/sql';

/**
 * Les requêtes de mesure du benchmark R4, dans un module plutôt que dans le CLI.
 *
 * Deux raisons, et la seconde est la vraie.
 *
 * D'abord, la définition du corpus est une décision du gate (§10 : « les
 * `in_niche` n'ayant pas actuellement le KPI combiné »), pas un détail
 * d'implémentation d'un script. Elle mérite un nom.
 *
 * Ensuite, et surtout : un CLI exécute `main()` à l'import. Un test qui voudrait
 * vérifier que ces requêtes ne peuvent que lire devrait donc soit importer le
 * benchmark — et le lancer — soit recopier le SQL, auquel cas la copie
 * divergerait du code au premier ajout de colonne et cesserait silencieusement
 * de protéger quoi que ce soit. Ici les deux lisent la même chaîne.
 *
 * Tout passe par `readOnlyQuery` : un outil de mesure qui écrit mesure son
 * propre effet.
 */

/**
 * Le KPI, et rien d'autre autour.
 *
 * `contactable and funnel_observable` est la définition arrêtée en R2 et reprise
 * telle quelle par R3 — la recopier ici plutôt que de l'améliorer est ce qui
 * rend « avant R3 : 5, après R3 : 7, après R4 : ? » comparable.
 */
export const CORPUS_METRICS_SQL = `
  select count(*)::text                                                       as prospects,
         count(*) filter (where website_url is not null)::text                as with_site,
         count(*) filter (where domain is not null)::text                     as with_domain,
         count(*) filter (where instagram_handle is not null)::text           as with_ig,
         count(*) filter (where facebook_url is not null)::text               as with_fb,
         count(*) filter (where phone is not null)::text                      as with_phone,
         count(*) filter (where email is not null)::text                      as with_email,
         count(*) filter (where registry_id is not null)::text                as with_registry,
         count(*) filter (where contactable)::text                            as contactable,
         count(*) filter (where funnel_observable)::text                      as funnel_observable,
         count(*) filter (where contactable and funnel_observable)::text      as kpi
    from prospects where id = any($1::uuid[])
`;

/**
 * Le corpus ciblé : dans la niche, et privé du KPI combiné.
 *
 * `coalesce(..., false)` est nécessaire et pas décoratif : `contactable` est
 * nullable, et `not (null and null)` vaut `null`, ce qui exclurait de la cible
 * précisément les prospects dont la joignabilité n'a jamais été évaluée — les
 * plus susceptibles d'avoir besoin de ce rail.
 */
export const TARGET_CORPUS_SQL = `
  select * from prospects
   where niche_verdict = 'in_niche'
     and dedupe_status <> 'merged'
     and not (coalesce(contactable, false) and coalesce(funnel_observable, false))
   order by display_name asc
   limit $1
`;

/** La population de référence, pour situer le KPI dans son ensemble. */
export const ALL_IN_NICHE_SQL = `
  select id from prospects
   where niche_verdict = 'in_niche' and dedupe_status <> 'merged'
`;

export interface CorpusMetrics {
  prospects: number;
  withWebsite: number;
  withDomain: number;
  withInstagram: number;
  withFacebook: number;
  withPhone: number;
  withEmail: number;
  withRegistryId: number;
  contactable: number;
  funnelObservable: number;
  /** Le KPI principal : dans la niche, joignable, lisible. */
  qualifiedContactableObservable: number;
}

export function emptyMetrics(): CorpusMetrics {
  return {
    prospects: 0,
    withWebsite: 0,
    withDomain: 0,
    withInstagram: 0,
    withFacebook: 0,
    withPhone: 0,
    withEmail: 0,
    withRegistryId: 0,
    contactable: 0,
    funnelObservable: 0,
    qualifiedContactableObservable: 0,
  };
}

export async function measureCorpus(sql: Sql, ids: string[], label: string): Promise<CorpusMetrics> {
  if (ids.length === 0) return emptyMetrics();

  const rows = await readOnlyQuery<Record<string, string>>(sql, CORPUS_METRICS_SQL, [ids], label);
  const row = rows[0] ?? {};
  const n = (key: string): number => Number.parseInt(row[key] ?? '0', 10);

  return {
    prospects: n('prospects'),
    withWebsite: n('with_site'),
    withDomain: n('with_domain'),
    withInstagram: n('with_ig'),
    withFacebook: n('with_fb'),
    withPhone: n('with_phone'),
    withEmail: n('with_email'),
    withRegistryId: n('with_registry'),
    contactable: n('contactable'),
    funnelObservable: n('funnel_observable'),
    qualifiedContactableObservable: n('kpi'),
  };
}

/** Toutes les requêtes de ce module, pour qu'un test les passe au garde-fou. */
export const MEASUREMENT_STATEMENTS: readonly { label: string; sql: string }[] = [
  { label: 'CORPUS_METRICS_SQL', sql: CORPUS_METRICS_SQL },
  { label: 'TARGET_CORPUS_SQL', sql: TARGET_CORPUS_SQL },
  { label: 'ALL_IN_NICHE_SQL', sql: ALL_IN_NICHE_SQL },
];
