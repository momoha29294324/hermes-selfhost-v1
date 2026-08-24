/**
 * R6B-D2.1 §3 / §14 — la vérification d'une destination, en lecture seule.
 *
 * Le seul endroit du dépôt où un nom d'étape sert à quelque chose.
 *
 * §3 de la mission interdit de DÉDUIRE un identifiant d'étape à partir d'un nom
 * « after initial configuration ». La distinction est celle-ci :
 *
 *   * ICI, à la configuration, la déduction par nom est le seul moyen de
 *     proposer une correspondance à un humain — et elle lui est PROPOSÉE, pas
 *     appliquée : c'est `--confirm` qui la fige ;
 *   * À L'EXÉCUTION, plus aucun nom n'est lu. `applyCrmProjection` ne connaît
 *     que `r6b_crm_stage_map`, donc des identifiants. Renommer « Intéressé » en
 *     « Chaud » chez le fournisseur ne casse rien, et créer une étape nommée
 *     « Perdu » ne capture aucun prospect.
 *
 * Rien de ce fichier n'écrit chez le fournisseur : `probe` ne fait que des
 * lectures, et tout ce qui est persisté l'est en local.
 */

import type { Sql } from '@/lib/db/sql';
import { CRM_STAGE_LABELS } from '@/lib/crm/payload';
import {
  confirmDestination,
  observeDestination,
  replacePipelineStages,
  setStageMapping,
} from '@/lib/crm/store';
import {
  CRM_MAPPABLE_FIELDS,
  type CrmCustomFieldProbe,
  type CrmDestination,
  type CrmFieldMap,
  type CrmMappableField,
  type CrmPipelineProbe,
  type CrmProbe,
  type CrmProvider,
  type CrmStage,
  type MappableOutreachState,
} from '@/lib/crm/types';
import { OUTREACH_STATES } from '@/lib/replies/taxonomy';

/** Minuscules, sans accents, espaces normalisés. Pour comparer des libellés. */
export function normalizeLabel(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export interface StageProposal {
  readonly state: MappableOutreachState;
  readonly label: string;
  readonly stage: CrmStage | null;
}

/**
 * Propose une correspondance état → étape à partir des libellés observés.
 *
 * Correspondance EXACTE après normalisation, jamais approximative : une
 * distance d'édition ferait tomber « Non intéressé » sur « Intéressé », c'est-
 * à-dire un refus rangé parmi les prospects chauds. Ce qui ne correspond pas
 * exactement reste `null` et devra être tranché à la main.
 */
export function proposeStageMapping(stages: readonly CrmStage[]): StageProposal[] {
  const byLabel = new Map<string, CrmStage>();
  for (const stage of stages) {
    const key = normalizeLabel(stage.stageName);
    if (!byLabel.has(key)) byLabel.set(key, stage);
  }

  const proposals: StageProposal[] = [];
  for (const state of OUTREACH_STATES) {
    const label = CRM_STAGE_LABELS[state];
    // `REVIEW_REQUIRED` n'a pas de libellé, donc pas de proposition (§6).
    if (label === null) continue;
    proposals.push(
      Object.freeze({
        state: state as MappableOutreachState,
        label,
        stage: byLabel.get(normalizeLabel(label)) ?? null,
      }),
    );
  }
  return proposals;
}

/**
 * Clés de champ personnalisé attendues, par champ projetable.
 *
 * Le préfixe `hermes_` est délibéré : un sous-compte partagé peut déjà porter
 * un champ « Score » qui veut dire tout autre chose, et écrire dedans
 * corromprait des données qui ne sont pas les nôtres.
 */
export const CRM_FIELD_KEYS: Readonly<Record<CrmMappableField, string>> = Object.freeze({
  prospectId: 'hermes_prospect_id',
  manifestId: 'hermes_manifest_id',
  prospectScore: 'hermes_prospect_score',
  prospectScoreBand: 'hermes_score_band',
  researchSummary: 'hermes_research_summary',
  replyClassification: 'hermes_reply_classification',
  replyReceivedAt: 'hermes_reply_received_at',
  instagram: 'hermes_instagram',
});

/**
 * Associe les champs projetables aux champs personnalisés OBSERVÉS.
 *
 * Un champ absent du sous-compte n'est pas inventé : il reste hors de la carte,
 * et sa valeur voyage alors dans la note (qui, elle, existe toujours). Un
 * identifiant de champ approximatif écrirait une valeur dans le mauvais champ,
 * ce qu'aucune relecture ultérieure ne rattraperait.
 */
export function proposeFieldMap(fields: readonly CrmCustomFieldProbe[]): CrmFieldMap {
  const map: Record<string, { id: string; key: string }> = {};
  for (const field of CRM_MAPPABLE_FIELDS) {
    const expected = CRM_FIELD_KEYS[field];
    const found = fields.find((candidate) => {
      const key = candidate.key.toLowerCase();
      return key === expected || key.endsWith(`.${expected}`);
    });
    if (found !== undefined) map[field] = { id: found.id, key: found.key };
  }
  return Object.freeze(map) as CrmFieldMap;
}

export interface VerifyOptions {
  /** Pipeline à retenir. Par défaut celui dont le nom ressemble à Hermes, sinon l'unique. */
  readonly pipelineId?: string;
  /** Nom de l'humain qui confirme. Sans lui, rien n'est confirmé. */
  readonly confirmedBy?: string;
  readonly note?: string;
}

export interface VerifyResult {
  readonly probe: CrmProbe;
  readonly destination: CrmDestination;
  readonly pipeline: CrmPipelineProbe | null;
  readonly proposals: readonly StageProposal[];
  readonly fieldMap: CrmFieldMap;
  readonly confirmed: boolean;
  /** Ce qui empêche une confirmation, quand elle est demandée. */
  readonly blockers: readonly string[];
}

/**
 * Vérifie une destination et, si un humain le demande explicitement, la
 * confirme.
 *
 * Sans `confirmedBy`, la fonction OBSERVE : elle lit le sous-compte, conserve
 * les identifiants d'étape et propose une correspondance. La destination reste
 * `UNCONFIRMED`, donc aucune écriture n'est possible. Observer n'est pas
 * confirmer.
 */
export async function verifyCrmDestination(
  sql: Sql,
  provider: CrmProvider,
  locationId: string,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  const probe = await provider.probe(locationId);

  const pipeline = selectPipeline(probe.pipelines, options.pipelineId);
  const fieldMap = proposeFieldMap(probe.customFields);

  let destination = await observeDestination(sql, {
    provider: provider.name,
    locationId: probe.locationId,
    locationName: probe.locationName,
    pipelineId: pipeline?.pipelineId ?? null,
    pipelineName: pipeline?.pipelineName ?? null,
    fieldMap,
  });

  const proposals = pipeline === null ? [] : proposeStageMapping(pipeline.stages);
  if (pipeline !== null) await replacePipelineStages(sql, destination.id, pipeline.stages);

  const blockers: string[] = [];
  if (pipeline === null) {
    blockers.push(
      probe.pipelines.length === 0
        ? 'le sous-compte ne porte aucun pipeline — en créer un avec les étapes attendues'
        : `${probe.pipelines.length} pipelines : préciser lequel avec --pipeline <id>`,
    );
  }
  const unmatched = proposals.filter((proposal) => proposal.stage === null);
  if (unmatched.length > 0) {
    blockers.push(
      `étapes introuvables sur ce pipeline : ${unmatched.map((proposal) => `« ${proposal.label} » (${proposal.state})`).join(', ')}`,
    );
  }

  let confirmed = false;
  if (options.confirmedBy !== undefined && blockers.length === 0 && pipeline !== null) {
    for (const proposal of proposals) {
      if (proposal.stage === null) continue;
      await setStageMapping(sql, destination.id, proposal.state, proposal.stage.stageId);
    }
    destination = await confirmDestination(sql, destination.id, options.confirmedBy, options.note ?? null);
    confirmed = true;
  }

  return Object.freeze({
    probe,
    destination,
    pipeline,
    proposals: Object.freeze(proposals),
    fieldMap,
    confirmed,
    blockers: Object.freeze(blockers),
  });
}

/**
 * Choisit le pipeline.
 *
 * Un identifiant explicite gagne toujours. Sinon, un pipeline unique s'impose
 * de lui-même. Sinon — plusieurs pipelines, aucun désigné — on ne choisit PAS :
 * deviner ferait ranger des prospects Hermes dans le pipeline d'une autre
 * activité du même sous-compte.
 */
function selectPipeline(
  pipelines: readonly CrmPipelineProbe[],
  requested: string | undefined,
): CrmPipelineProbe | null {
  if (requested !== undefined) {
    return pipelines.find((pipeline) => pipeline.pipelineId === requested) ?? null;
  }
  return pipelines.length === 1 ? (pipelines[0] ?? null) : null;
}
