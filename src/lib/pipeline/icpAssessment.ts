import type { Sql } from '@/lib/db/sql';
import type { IcpProfile } from '@/lib/config/schema';
import {
  evaluateIcpEligibility,
  type IcpAssessment,
  type IcpEvidenceLike,
  type IcpSubject,
  type IcpVerdict,
} from '@/lib/pipeline/icpEligibility';

/**
 * ICP-R1 — la couche base du gate d'éligibilité.
 *
 * Ce module lit, écrit et relit. Il ne DÉCIDE pas : la règle vit dans
 * `icpEligibility.ts`, pure et testable sans base. La séparation est celle de
 * `safety.ts` sur le rail Instagram (`loadSafetySnapshot` / `evaluateSafety`),
 * et elle sert la même chose — pouvoir éprouver la décision sur des états que
 * les données réelles ne produiront pas avant longtemps.
 *
 * Une seule règle d'écriture, et elle est absolue : **INSERT uniquement**.
 * Aucune fonction de ce fichier ne fait d'`update` ni de `delete` sur
 * `prospect_icp_assessments`. Un verdict qu'on réécrit ne prouve rien, et la
 * mission demande nommément de ne pas muter l'historique en silence — un
 * humain qui contredit le gate ajoute une ligne signée à côté, jamais à la
 * place.
 */

// ---------------------------------------------------------------------------
// Lecture des entrées
// ---------------------------------------------------------------------------

export interface IcpInput {
  /** La ligne ÉVALUÉE — celle contre laquelle le verdict sera inscrit. */
  readonly prospectId: string;
  /**
   * La ligne dont l'IDENTITÉ COMMERCIALE est jugée.
   *
   * Égale à `prospectId` partout, sauf pour une coquille d'effet — voir
   * `loadIcpInputs`. Rendue plutôt que déduite : un verdict qui décrirait
   * silencieusement une AUTRE entreprise que celle qu'il nomme serait pire que
   * le défaut qu'il corrige.
   */
  readonly subjectProspectId: string;
  readonly subject: IcpSubject;
  readonly evidence: readonly IcpEvidenceLike[];
}

interface ProspectRowForIcp {
  id: string;
  subjectProspectId: string;
  displayName: string;
  brandName: string | null;
  legalName: string | null;
  city: string | null;
  department: string | null;
  domain: string | null;
  instagramHandle: string | null;
}

interface EvidenceRowForIcp {
  id: string;
  prospectId: string;
  field: string;
  valueText: string | null;
  valueJson: unknown;
  provider: string;
  sourceUrl: string | null;
}

/**
 * Charge les entrées du gate pour un lot de prospects.
 *
 * `value_json` est sélectionné, et c'est le correctif le plus discret de cette
 * mission. `loadDispatchContext` (R6B-B.1) ne lit que `value_text` ; or
 * `website_headings` — le champ qui portait « Devenez franchisé DetailCar » —
 * n'est stocké QU'EN `value_json`. Un gate branché sur le chargeur existant
 * aurait reproduit l'angle mort qu'il est censé fermer.
 */
export async function loadIcpInputs(sql: Sql, prospectIds?: readonly string[]): Promise<IcpInput[]> {
  const restrict = prospectIds !== undefined && prospectIds.length > 0;

  // L'identité jugée est celle du COMMERCE lui-même. `subjectProspectId` nomme
  // explicitement la ligne évaluée : le gate doit toujours pouvoir dire DE QUI
  // il a rendu un verdict, plutôt que de le laisser deviner par l'appelant.
  const prospects = await sql.query<ProspectRowForIcp>(
    `select p.id                as "id",
            p.id                as "subjectProspectId",
            p.display_name      as "displayName",
            p.brand_name        as "brandName",
            p.legal_name        as "legalName",
            p.city              as "city",
            p.department        as "department",
            p.domain            as "domain",
            p.instagram_handle  as "instagramHandle"
       from prospects p
      where ($1::uuid[] is null or p.id = any($1::uuid[]))
      order by p.created_at asc`,
    [restrict ? [...prospectIds] : null],
  );
  if (prospects.length === 0) return [];

  // Les preuves suivent le SUJET, pas la ligne évaluée. Une coquille porte la
  // preuve de son adresse de routage et une copie du récit du persona ; le
  // gate doit lire le dossier de preuves du commerce, entier et à sa source.
  const evidence = await sql.query<EvidenceRowForIcp>(
    `select id, prospect_id as "prospectId", field, value_text as "valueText", value_json as "valueJson",
            provider, source_url as "sourceUrl"
       from prospect_evidence
      where prospect_id = any($1::uuid[])
      order by observed_at asc`,
    [[...new Set(prospects.map((row) => row.subjectProspectId))]],
  );

  const byProspect = new Map<string, IcpEvidenceLike[]>();
  for (const row of evidence) {
    const list = byProspect.get(row.prospectId) ?? [];
    list.push({
      id: row.id,
      field: row.field,
      valueText: row.valueText,
      valueJson: row.valueJson,
      provider: row.provider,
      sourceUrl: row.sourceUrl,
    });
    byProspect.set(row.prospectId, list);
  }

  return prospects.map((row) => ({
    prospectId: row.id,
    subjectProspectId: row.subjectProspectId,
    subject: {
      displayName: row.displayName,
      brandName: row.brandName,
      legalName: row.legalName,
      city: row.city,
      department: row.department,
      domain: row.domain,
      instagramHandle: row.instagramHandle,
    },
    evidence: byProspect.get(row.subjectProspectId) ?? [],
  }));
}

/** Évalue un prospect depuis la base, sans rien écrire. */
export async function assessProspect(
  sql: Sql,
  prospectId: string,
  profile: IcpProfile,
): Promise<IcpAssessment | null> {
  const inputs = await loadIcpInputs(sql, [prospectId]);
  const input = inputs[0];
  if (!input) return null;
  return evaluateIcpEligibility({ subject: input.subject, evidence: input.evidence, profile });
}

// ---------------------------------------------------------------------------
// Écriture
// ---------------------------------------------------------------------------

export interface RecordAssessmentInput {
  readonly prospectId: string;
  readonly assessment: IcpAssessment;
  readonly decidedBy: 'deterministic' | 'human';
  /** Qui a rendu ce verdict. Pour `human`, un nom d'humain — la base le vérifie. */
  readonly assessedBy: string;
}

/**
 * Ajoute un verdict au journal. INSERT, jamais UPDATE.
 *
 * Deux évaluations successives du même prospect créent deux lignes, même si le
 * verdict est identique : ce sont deux observations, faites à deux instants,
 * potentiellement sur deux versions du profil. Les confondre reviendrait à
 * perdre la réponse à « depuis quand le sait-on ? ».
 */
export async function recordIcpAssessment(sql: Sql, input: RecordAssessmentInput): Promise<string> {
  const { assessment } = input;
  const rows = await sql.query<{ id: string }>(
    `insert into prospect_icp_assessments
       (prospect_id, verdict, reason, reasons, signals, evidence_ids, coverage,
        strong_source_count, profile_key, profile_version, decided_by, assessed_by)
     values ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12)
     returning id`,
    [
      input.prospectId,
      assessment.verdict,
      assessment.reason.slice(0, 1000),
      JSON.stringify(assessment.reasons),
      JSON.stringify(assessment.signals),
      JSON.stringify(assessment.evidenceIds),
      assessment.coverage,
      assessment.strongSourceCount,
      assessment.profileKey,
      assessment.profileVersion,
      input.decidedBy,
      input.assessedBy,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('prospect_icp_assessments insert did not return a row');
  return id;
}

// ---------------------------------------------------------------------------
// Relecture du verdict courant
// ---------------------------------------------------------------------------

export interface StoredIcpAssessment {
  readonly id: string;
  readonly prospectId: string;
  readonly verdict: IcpVerdict;
  readonly reason: string;
  readonly coverage: 'none' | 'read';
  readonly profileKey: string;
  readonly profileVersion: number;
  readonly decidedBy: 'deterministic' | 'human';
  readonly assessedBy: string;
  readonly createdAt: string;
}

const STORED_COLUMNS = `id, prospect_id as "prospectId", verdict, reason, coverage,
        profile_key as "profileKey", profile_version as "profileVersion",
        decided_by as "decidedBy", assessed_by as "assessedBy", created_at as "createdAt"`;

/**
 * Le verdict courant d'un prospect : la ligne la PLUS RÉCENTE, tous auteurs
 * confondus.
 *
 * Un verdict humain postérieur l'emporte donc sur un verdict automatique, parce
 * qu'il est plus récent — pas parce qu'un humain « écrase » quoi que ce soit.
 * L'inverse est vrai aussi : relancer l'audit après une décision humaine
 * reposerait la question. C'est voulu, et c'est pourquoi `icp:audit` n'écrit
 * pas de ligne quand le verdict est inchangé. *
 * HERMES-END-TO-END-CERTIFICATION-R1 — et sur une ÉGALITÉ d'horodatage, le
 * verdict le plus strict gagne.
 *
 * `order by created_at desc, id desc` seul faisait décider un uuid aléatoire.
 * `created_at` vaut `now()`, c'est-à-dire l'heure de la TRANSACTION : deux
 * lignes écrites dans le même passage d'audit la partagent, et sous PGlite
 * elles la partagent toujours. Une chance sur deux d'ouvrir la porte n'est pas
 * un comportement défendable sur un premier contact commercial — ce verdict
 * décide de `IG_ICP_NOT_TARGET` et de `IG_ICP_REVIEW_REQUIRED`
 * (`instagram/eligibility.ts`), donc de qui reçoit un DM.
 *
 * Le correctif est celui que `channelIdentity.ts` avait déjà écrit pour la même
 * question, mot pour mot et pour la même raison : à égalité, le refus l'emporte.
 * L'ordre reste `created_at` d'abord — un verdict réellement postérieur gagne
 * toujours, humain compris, et rien de la règle du dessus ne bouge.
 */

/**
 * L'ordre canonique d'un verdict ICP. Écrit une fois, lu par les deux lectures
 * — une seule ligne et un lot — parce que deux copies finiraient par diverger
 * et que celle qui déciderait serait alors la moins stricte.
 */
const EFFECTIVE_ICP_ORDER = `created_at desc,
                                  case verdict when 'NOT_TARGET' then 0
                                               when 'REVIEW_REQUIRED' then 1
                                               else 2 end asc,
                                  id desc`;
export async function loadLatestIcpAssessment(sql: Sql, prospectId: string): Promise<StoredIcpAssessment | null> {
  const rows = await sql.query<StoredIcpAssessment>(
    `select ${STORED_COLUMNS} from prospect_icp_assessments
      where prospect_id = $1
      order by ${EFFECTIVE_ICP_ORDER}
      limit 1`,
    [prospectId],
  );
  return rows[0] ?? null;
}

/** Même lecture, pour un lot — une requête, pas N. */
export async function loadLatestIcpAssessments(
  sql: Sql,
  prospectIds: readonly string[],
): Promise<Map<string, StoredIcpAssessment>> {
  if (prospectIds.length === 0) return new Map();
  const rows = await sql.query<StoredIcpAssessment>(
    `select distinct on (prospect_id) ${STORED_COLUMNS}
       from prospect_icp_assessments
      where prospect_id = any($1::uuid[])
      order by prospect_id, ${EFFECTIVE_ICP_ORDER}`,
    [[...prospectIds]],
  );
  return new Map(rows.map((row) => [row.prospectId, row]));
}
