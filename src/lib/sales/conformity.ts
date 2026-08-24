/**
 * HERMES-SALES-KNOWLEDGE-R1 §35 — la conformité de ciblage, OBSERVÉE et jamais
 * rejugée.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi cette lecture est aussi pauvre, et pourquoi c'est volontaire
 * ---------------------------------------------------------------------------
 * §35 met le ciblage hors du périmètre de cette mission, en toutes lettres :
 * « La mission sales knowledge n'est pas une mission ICP ». Ce module s'y tient
 * scrupuleusement. Il n'appelle ni `assessServiceScope`, ni `assessIcp`, ni
 * `coreServiceFit` ; il ne relit aucune prestation, n'ouvre aucune page, et ne
 * rend aucun verdict neuf.
 *
 * Il constate deux choses DÉJÀ écrites par d'autres :
 *
 *   * un refus de ciblage TERMINAL enregistré sur la file d'envoi. La cible
 *     s'est resserrée le 22 août 2026 (`hermes-targeting-cleaning-only-r1`), et
 *     des prospects contactés sous l'ancienne règle ont été écartés depuis.
 *     Proposer un appel à ceux-là ferait perdre son temps à un opérateur — c'est le
 *     seul coût que la qualification de rendez-vous doit vraiment éviter ;
 *   * un premier message PROUVÉ parti (`outreach_events.kind = 'sent'`), qui
 *     établit que les portes en vigueur CE JOUR-LÀ étaient vertes. Pas celles
 *     d'aujourd'hui : le fait est daté, et il n'autorise rien à lui seul.
 *
 * ---------------------------------------------------------------------------
 * Ce qui n'est délibérément PAS lu
 * ---------------------------------------------------------------------------
 * `market_scope_unknown` est absent de la liste des refus, et ce n'est pas un
 * oubli. La migration 0052 le qualifie de TEMPORAIRE et l'explique mieux que ce
 * commentaire ne le ferait : « nous ne savons pas qu'il est hors marché, nous
 * savons que nous ne savons pas ». Le traiter comme un refus condamnerait un
 * prospect sur une absence d'observation — exactement ce que CLAUDE.md §2
 * interdit. Il tombe donc dans `UNKNOWN`, qui n'écarte personne.
 */

import type { Sql } from '@/lib/db/sql';
import type { IcpConformity } from '@/lib/sales/objective';

/**
 * Les refus de ciblage qui FERMENT la question d'un rendez-vous.
 *
 * Tous deux TERMINAUX au sens de la file d'envoi. Une liste nommée plutôt
 * qu'un littéral dans la requête : elle se relit, et un futur motif terminal
 * s'y ajoute à un seul endroit.
 */
const TERMINAL_TARGETING_REFUSALS: readonly string[] = Object.freeze([
  'service_scope_not_in_scope_only',
  'icp_not_target',
]);

interface ConformityRow {
  readonly terminalSkip: string | null;
  readonly firstTouchSent: boolean;
}

/** Lit la conformité de ciblage observable d'un prospect. */
export async function loadIcpConformity(sql: Sql, prospectId: string): Promise<IcpConformity> {
  const rows = await sql.query<ConformityRow>(
    `select
       (select j.last_skip_reason from ig_dispatch_jobs j
         where j.prospect_id = $1
           and j.last_skip_reason = any($2)
         order by j.updated_at desc limit 1)                            as "terminalSkip",
       exists (select 1 from outreach_events e
                where e.prospect_id = $1 and e.kind = 'sent')           as "firstTouchSent"`,
    [prospectId, TERMINAL_TARGETING_REFUSALS],
  );
  const row = rows[0];
  if (row === undefined) return 'UNKNOWN';
  if (row.terminalSkip !== null) return 'REJECTED_BY_TARGETING';
  return row.firstTouchSent ? 'PASSED_AT_FIRST_TOUCH' : 'UNKNOWN';
}
