/**
 * R6B-D2.1 — la mémoire de la configuration CRM.
 *
 * Tout ce qui, une fois observé chez le fournisseur, ne doit plus jamais être
 * redevine à l'exécution : le sous-compte confirmé, les identifiants d'étape,
 * la correspondance état → étape, le lien prospect → contact, les empreintes de
 * notes déjà déposées.
 *
 * Aucune fonction d'ici n'appelle le réseau. C'est volontaire : la lecture de
 * la configuration doit rester possible (et gratuite) quand le fournisseur est
 * injoignable, sinon `r6b:crm:status` mentirait dès la première panne.
 */

import type { Sql } from '@/lib/db/sql';
import type {
  CrmContactLink,
  CrmDestination,
  CrmDestinationStatus,
  CrmFieldMap,
  CrmMatchKind,
  CrmStage,
  CrmStageMap,
  MappableOutreachState,
} from '@/lib/crm/types';

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

interface DestinationRow {
  id: string;
  provider: string;
  locationId: string;
  locationName: string | null;
  pipelineId: string | null;
  pipelineName: string | null;
  fieldMap: unknown;
  status: CrmDestinationStatus;
  confirmedBy: string | null;
  confirmedAt: string | Date | null;
}

const DESTINATION_COLUMNS = `id,
       provider,
       location_id    as "locationId",
       location_name  as "locationName",
       pipeline_id    as "pipelineId",
       pipeline_name  as "pipelineName",
       field_map      as "fieldMap",
       status,
       confirmed_by   as "confirmedBy",
       confirmed_at   as "confirmedAt"`;

function toDestination(row: DestinationRow): CrmDestination {
  return Object.freeze({
    id: row.id,
    provider: row.provider,
    locationId: row.locationId,
    locationName: row.locationName,
    pipelineId: row.pipelineId,
    pipelineName: row.pipelineName,
    fieldMap: normalizeFieldMap(row.fieldMap),
    status: row.status,
    confirmedBy: row.confirmedBy,
    confirmedAt: row.confirmedAt === null ? null : new Date(row.confirmedAt).toISOString(),
  });
}

/**
 * Relit la carte des champs personnalisés en écartant tout ce qui n'a pas la
 * forme attendue.
 *
 * Une entrée mal formée est ignorée plutôt que corrigée : un identifiant de
 * champ personnalisé approximatif ferait écrire une valeur dans le mauvais
 * champ du CRM, ce qu'aucune relecture ultérieure ne rattraperait.
 */
function normalizeFieldMap(value: unknown): CrmFieldMap {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return Object.freeze({});
  const out: Record<string, { id: string; key: string }> = {};
  for (const [field, binding] of Object.entries(value as Record<string, unknown>)) {
    if (binding === null || typeof binding !== 'object') continue;
    const id = (binding as { id?: unknown }).id;
    const key = (binding as { key?: unknown }).key;
    if (typeof id !== 'string' || id.length === 0) continue;
    if (typeof key !== 'string' || key.length === 0) continue;
    out[field] = Object.freeze({ id, key });
  }
  return Object.freeze(out) as CrmFieldMap;
}

/** La destination confirmée d'un fournisseur, ou `null`. Au plus une (index unique). */
export async function loadConfirmedDestination(
  sql: Sql,
  provider: string,
): Promise<CrmDestination | null> {
  const rows = await sql.query<DestinationRow>(
    `select ${DESTINATION_COLUMNS} from r6b_crm_destinations
      where provider = $1 and status = 'CONFIRMED'`,
    [provider],
  );
  const row = rows[0];
  return row ? toDestination(row) : null;
}

export async function loadDestination(
  sql: Sql,
  provider: string,
  locationId: string,
): Promise<CrmDestination | null> {
  const rows = await sql.query<DestinationRow>(
    `select ${DESTINATION_COLUMNS} from r6b_crm_destinations
      where provider = $1 and location_id = $2`,
    [provider, locationId],
  );
  const row = rows[0];
  return row ? toDestination(row) : null;
}

export async function listDestinations(sql: Sql): Promise<CrmDestination[]> {
  const rows = await sql.query<DestinationRow>(
    `select ${DESTINATION_COLUMNS} from r6b_crm_destinations order by created_at asc`,
  );
  return rows.map(toDestination);
}

export interface ObserveDestinationInput {
  readonly provider: string;
  readonly locationId: string;
  readonly locationName: string | null;
  readonly pipelineId: string | null;
  readonly pipelineName: string | null;
  readonly fieldMap: CrmFieldMap;
}

/**
 * Enregistre ce qu'une vérification en lecture seule a OBSERVÉ.
 *
 * N'accorde aucune confiance : le statut reste `UNCONFIRMED` si la ligne
 * n'existait pas, et une ligne déjà `CONFIRMED` n'est pas rétrogradée par une
 * simple relecture. Observer n'est pas confirmer — c'est toute la différence
 * entre « ce sous-compte existe » et « ce sous-compte est celui de Hermes ».
 */
export async function observeDestination(
  sql: Sql,
  input: ObserveDestinationInput,
): Promise<CrmDestination> {
  const rows = await sql.query<DestinationRow>(
    `insert into r6b_crm_destinations
       (provider, location_id, location_name, pipeline_id, pipeline_name, field_map, status)
     values ($1,$2,$3,$4,$5,$6::jsonb,'UNCONFIRMED')
     on conflict (provider, location_id) do update
        set location_name = excluded.location_name,
            pipeline_id   = coalesce(excluded.pipeline_id, r6b_crm_destinations.pipeline_id),
            pipeline_name = coalesce(excluded.pipeline_name, r6b_crm_destinations.pipeline_name),
            field_map     = excluded.field_map,
            updated_at    = now()
     returning ${DESTINATION_COLUMNS}`,
    [
      input.provider,
      input.locationId,
      input.locationName,
      input.pipelineId,
      input.pipelineName,
      JSON.stringify(input.fieldMap),
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('r6b_crm_destinations upsert did not return a row');
  return toDestination(row);
}

/**
 * Confirme une destination. C'est la seule porte vers une écriture externe.
 *
 * `confirmedBy` est obligatoire et n'est pas décoratif : la base refuse une
 * confirmation sans auteur, parce qu'une destination que personne n'a nommément
 * validée est exactement ce que §2 de la mission interdit.
 */
export async function confirmDestination(
  sql: Sql,
  destinationId: string,
  confirmedBy: string,
  note: string | null = null,
): Promise<CrmDestination> {
  const author = confirmedBy.trim();
  if (author.length === 0) throw new Error('une confirmation exige le nom de son auteur');

  const rows = await sql.query<DestinationRow>(
    `update r6b_crm_destinations
        set status = 'CONFIRMED', confirmed_by = $2, confirmed_at = now(),
            note = coalesce($3, note), updated_at = now()
      where id = $1 and status <> 'REVOKED'
      returning ${DESTINATION_COLUMNS}`,
    [destinationId, author, note],
  );
  const row = rows[0];
  if (!row) throw new Error(`destination ${destinationId} introuvable ou révoquée`);
  return toDestination(row);
}

// ---------------------------------------------------------------------------
// Étapes de pipeline
// ---------------------------------------------------------------------------

/**
 * Conserve les identifiants d'étape rendus par le fournisseur (§3).
 *
 * Les étapes disparues du pipeline sont retirées dans la même transaction :
 * garder un identifiant qui n'existe plus chez le fournisseur ferait échouer
 * une projection au moment de l'écriture, c'est-à-dire au pire moment.
 */
export async function replacePipelineStages(
  sql: Sql,
  destinationId: string,
  stages: readonly CrmStage[],
): Promise<void> {
  await sql.transaction(async (tx) => {
    const keep = stages.map((stage) => stage.stageId);
    await tx.query(
      `delete from r6b_crm_pipeline_stages
        where destination_id = $1 and not (stage_id = any($2::text[]))`,
      [destinationId, keep],
    );
    for (const stage of stages) {
      await tx.query(
        `insert into r6b_crm_pipeline_stages (destination_id, stage_id, stage_name, position)
         values ($1,$2,$3,$4)
         on conflict (destination_id, stage_id) do update
            set stage_name = excluded.stage_name,
                position   = excluded.position,
                observed_at = now()`,
        [destinationId, stage.stageId, stage.stageName, stage.position],
      );
    }
  });
}

export async function loadPipelineStages(sql: Sql, destinationId: string): Promise<CrmStage[]> {
  const rows = await sql.query<{ stageId: string; stageName: string; position: number | null }>(
    `select stage_id as "stageId", stage_name as "stageName", position
       from r6b_crm_pipeline_stages where destination_id = $1
      order by coalesce(position, 9999), stage_name`,
    [destinationId],
  );
  return rows.map((row) => Object.freeze({ ...row }));
}

// ---------------------------------------------------------------------------
// Correspondance état → étape
// ---------------------------------------------------------------------------

export async function setStageMapping(
  sql: Sql,
  destinationId: string,
  state: MappableOutreachState,
  stageId: string,
): Promise<void> {
  await sql.query(
    `insert into r6b_crm_stage_map (destination_id, outreach_state, stage_id)
     values ($1,$2,$3)
     on conflict (destination_id, outreach_state) do update set stage_id = excluded.stage_id`,
    [destinationId, state, stageId],
  );
}

/**
 * La correspondance persistée, jointe aux étapes réellement observées.
 *
 * La jointure est stricte : une correspondance dont l'étape a disparu n'est pas
 * rendue. Mieux vaut « aucune étape pour cet état » — qui bloque proprement en
 * `BLOCKED_CONFIG` — qu'un identifiant orphelin envoyé au fournisseur.
 */
export async function loadStageMap(sql: Sql, destinationId: string): Promise<CrmStageMap> {
  const rows = await sql.query<{
    state: MappableOutreachState;
    stageId: string;
    stageName: string;
    position: number | null;
  }>(
    `select m.outreach_state as "state",
            s.stage_id       as "stageId",
            s.stage_name     as "stageName",
            s.position
       from r6b_crm_stage_map m
       join r6b_crm_pipeline_stages s
         on s.destination_id = m.destination_id and s.stage_id = m.stage_id
      where m.destination_id = $1`,
    [destinationId],
  );

  const map: Partial<Record<MappableOutreachState, CrmStage>> = {};
  for (const row of rows) {
    map[row.state] = Object.freeze({
      stageId: row.stageId,
      stageName: row.stageName,
      position: row.position,
    });
  }
  return Object.freeze(map);
}

// ---------------------------------------------------------------------------
// Liens prospect → contact
// ---------------------------------------------------------------------------

interface LinkRow {
  destinationId: string;
  prospectId: string;
  externalContactId: string;
  externalOpportunityId: string | null;
  matchKind: CrmMatchKind;
  matchValue: string | null;
}

const LINK_COLUMNS = `destination_id          as "destinationId",
       prospect_id             as "prospectId",
       external_contact_id     as "externalContactId",
       external_opportunity_id as "externalOpportunityId",
       match_kind              as "matchKind",
       match_value             as "matchValue"`;

export async function loadContactLink(
  sql: Sql,
  destinationId: string,
  prospectId: string,
): Promise<CrmContactLink | null> {
  const rows = await sql.query<LinkRow>(
    `select ${LINK_COLUMNS} from r6b_crm_contact_links
      where destination_id = $1 and prospect_id = $2`,
    [destinationId, prospectId],
  );
  const row = rows[0];
  return row ? Object.freeze({ ...row }) : null;
}

/** Le prospect déjà lié à ce contact chez le fournisseur, s'il en existe un. */
export async function loadLinkByContactId(
  sql: Sql,
  destinationId: string,
  externalContactId: string,
): Promise<CrmContactLink | null> {
  const rows = await sql.query<LinkRow>(
    `select ${LINK_COLUMNS} from r6b_crm_contact_links
      where destination_id = $1 and external_contact_id = $2`,
    [destinationId, externalContactId],
  );
  const row = rows[0];
  return row ? Object.freeze({ ...row }) : null;
}

export async function listContactLinks(sql: Sql, destinationId: string): Promise<CrmContactLink[]> {
  const rows = await sql.query<LinkRow>(
    `select ${LINK_COLUMNS} from r6b_crm_contact_links
      where destination_id = $1 order by created_at asc`,
    [destinationId],
  );
  return rows.map((row) => Object.freeze({ ...row }));
}

/**
 * Écrit (ou met à jour) le lien prospect → contact.
 *
 * L'identifiant d'opportunité déjà connu n'est jamais effacé par une écriture
 * ultérieure qui ne le porterait pas : c'est lui qui empêche une seconde
 * opportunité de naître au prochain passage.
 *
 * L'index unique `(destination_id, external_contact_id)` fait le reste : si ce
 * contact appartient déjà à un AUTRE prospect, l'insertion échoue. La fusion de
 * deux entreprises devient donc une erreur de base de données plutôt qu'un
 * silence.
 */
export async function saveContactLink(sql: Sql, link: CrmContactLink): Promise<CrmContactLink> {
  const rows = await sql.query<LinkRow>(
    `insert into r6b_crm_contact_links
       (destination_id, prospect_id, external_contact_id, external_opportunity_id, match_kind, match_value)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (destination_id, prospect_id) do update
        set external_contact_id     = excluded.external_contact_id,
            external_opportunity_id = coalesce(excluded.external_opportunity_id,
                                               r6b_crm_contact_links.external_opportunity_id),
            -- match_kind et match_value ne sont PAS réécrits : ils décrivent
            -- comment le lien a été ÉTABLI, un fait daté. Les remplacer à
            -- chaque passage transformerait « trouvé par email » en « déjà
            -- lié » dès la deuxième projection, et l'audit perdrait justement
            -- ce qu'il vient chercher.
            updated_at              = now()
     returning ${LINK_COLUMNS}`,
    [
      link.destinationId,
      link.prospectId,
      link.externalContactId,
      link.externalOpportunityId,
      link.matchKind,
      link.matchValue,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('r6b_crm_contact_links upsert did not return a row');
  return Object.freeze({ ...row });
}

// ---------------------------------------------------------------------------
// Notes déjà déposées
// ---------------------------------------------------------------------------

/** Vrai quand une note de ce contenu a déjà été déposée pour ce prospect. */
export async function noteAlreadyRecorded(
  sql: Sql,
  destinationId: string,
  prospectId: string,
  bodySha256: string,
): Promise<boolean> {
  const rows = await sql.query<{ id: string }>(
    `select id from r6b_crm_notes
      where destination_id = $1 and prospect_id = $2 and body_sha256 = $3`,
    [destinationId, prospectId, bodySha256],
  );
  return rows.length > 0;
}

export interface RecordNoteInput {
  readonly destinationId: string;
  readonly prospectId: string;
  readonly analysisId: string | null;
  readonly bodySha256: string;
  readonly externalNoteId: string | null;
}

/** Rend `false` quand la note était déjà enregistrée — le cas normal d'un rejeu. */
export async function recordNote(sql: Sql, input: RecordNoteInput): Promise<boolean> {
  const rows = await sql.query<{ id: string }>(
    `insert into r6b_crm_notes
       (destination_id, prospect_id, analysis_id, body_sha256, external_note_id)
     values ($1,$2,$3,$4,$5)
     on conflict (destination_id, prospect_id, body_sha256) do nothing
     returning id`,
    [input.destinationId, input.prospectId, input.analysisId, input.bodySha256, input.externalNoteId],
  );
  return rows.length > 0;
}

export async function countNotes(sql: Sql, destinationId: string): Promise<number> {
  const rows = await sql.query<{ n: string }>(
    'select count(*)::text as n from r6b_crm_notes where destination_id = $1',
    [destinationId],
  );
  return Number(rows[0]?.n ?? '0');
}
