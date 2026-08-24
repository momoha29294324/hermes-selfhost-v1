/**
 * Fabrique de destination CRM pour les tests.
 *
 * Passe par les VRAIES fonctions de `src/lib/crm/store.ts` — observation,
 * conservation des étapes, correspondance, confirmation — plutôt que par des
 * `insert` à la main : un test qui reconstruirait les lignes lui-même
 * cesserait de vérifier que la garde de confirmation existe.
 *
 * Idempotente : appelée plusieurs fois pour le même fournisseur, elle retrouve
 * la destination déjà confirmée au lieu d'en créer une seconde (ce que l'index
 * unique `r6b_crm_destinations_one_confirmed_idx` refuserait de toute façon).
 */

import type { Sql } from '@/lib/db/sql';
import { CRM_PIPELINE_PLAN, CRM_STAGE_LABELS } from '@/lib/crm/payload';
import {
  confirmDestination,
  loadStageMap,
  observeDestination,
  replacePipelineStages,
  setStageMapping,
} from '@/lib/crm/store';
import type { CrmStage, CrmTarget, MappableOutreachState } from '@/lib/crm/types';
import { OUTREACH_STATES } from '@/lib/replies/taxonomy';

export interface FakeDestinationOptions {
  readonly provider?: string;
  readonly locationId?: string;
  readonly locationName?: string;
  readonly pipelineId?: string;
  /** Étapes du pipeline. Par défaut, le plan complet de `CRM_PIPELINE_PLAN`. */
  readonly stageNames?: readonly string[];
  /** États laissés volontairement sans étape, pour tester `BLOCKED_CONFIG`. */
  readonly unmappedStates?: readonly MappableOutreachState[];
}

function slug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export async function confirmedDestination(
  sql: Sql,
  options: FakeDestinationOptions = {},
): Promise<CrmTarget> {
  const provider = options.provider ?? 'fake-crm';
  const locationId = options.locationId ?? 'loc-hermes-test';
  const pipelineId = options.pipelineId ?? 'pipe-hermes-test';
  const names = options.stageNames ?? CRM_PIPELINE_PLAN;
  const unmapped = new Set<string>(options.unmappedStates ?? []);

  const stages: CrmStage[] = names.map((name, index) => ({
    stageId: `stage-${slug(name)}`,
    stageName: name,
    position: index,
  }));

  const destination = await observeDestination(sql, {
    provider,
    locationId,
    locationName: options.locationName ?? 'Hermes (test)',
    pipelineId,
    pipelineName: 'Hermes (test)',
    fieldMap: {},
  });

  await replacePipelineStages(sql, destination.id, stages);

  const byLabel = new Map(stages.map((stage) => [stage.stageName, stage]));
  for (const state of OUTREACH_STATES) {
    if (state === 'REVIEW_REQUIRED') continue;
    if (unmapped.has(state)) continue;
    const label = CRM_STAGE_LABELS[state];
    const stage = label === null ? undefined : byLabel.get(label);
    if (stage === undefined) continue;
    await setStageMapping(sql, destination.id, state, stage.stageId);
  }

  const confirmed =
    destination.status === 'CONFIRMED'
      ? destination
      : await confirmDestination(sql, destination.id, 'test-operator', 'destination de test');

  return Object.freeze({
    destination: confirmed,
    pipelineId,
    stages: await loadStageMap(sql, confirmed.id),
  });
}
