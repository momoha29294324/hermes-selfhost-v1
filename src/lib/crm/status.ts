/**
 * R6B-D2.1 §11 — l'état de la configuration CRM, en lecture seule.
 *
 * Séparé de la résolution et de l'écriture pour la même raison qu'en D2 :
 * REGARDER ne doit exiger ni réseau, ni fournisseur joignable, ni décision.
 * `r6b:crm:status` doit répondre la vérité même quand le CRM est en panne —
 * sinon la première panne rendrait le diagnostic impossible.
 *
 * Aucune valeur secrète n'entre ici. `apiKeyPresent` est un booléen : il dit
 * qu'une variable est renseignée, jamais ce qu'elle contient, jamais sa
 * longueur (CLAUDE.md §6). Le `location_id`, lui, est affiché en clair et doit
 * l'être : c'est précisément ce qu'un humain doit relire pour vérifier qu'on ne
 * s'apprête pas à écrire dans le sous-compte d'un autre projet.
 */

import { env } from '@/lib/env';
import type { Sql } from '@/lib/db/sql';
import { CRM_ENV_KEYS } from '@/lib/crm/ghl';
import { listContactLinks, listDestinations, loadPipelineStages, loadStageMap } from '@/lib/crm/store';
import type { CrmDestination, CrmResolution, CrmStage, CrmStageMap } from '@/lib/crm/types';
import type { CrmProjectionStatus } from '@/lib/replies/crm';

export interface CrmDestinationStatusView {
  readonly destination: CrmDestination;
  readonly stages: readonly CrmStage[];
  readonly stageMap: CrmStageMap;
  readonly linkedContacts: number;
  /** Vrai quand `OUTBOUND_CRM_LOCATION_ID` désigne CE sous-compte. */
  readonly matchesEnvironment: boolean;
}

export interface CrmStatus {
  readonly providerName: string | null;
  readonly envLocationId: string | null;
  readonly apiKeyPresent: boolean;
  readonly resolution: CrmResolution;
  readonly destinations: readonly CrmDestinationStatusView[];
  readonly projections: Readonly<Record<CrmProjectionStatus, number>>;
  readonly notes: number;
  readonly alertsPending: number;
}

const EMPTY_PROJECTION_COUNTS: Readonly<Record<CrmProjectionStatus, number>> = Object.freeze({
  PENDING: 0,
  LOCAL_ONLY: 0,
  SKIPPED_NOT_CONFIGURED: 0,
  BLOCKED_POLICY: 0,
  BLOCKED_CONFIG: 0,
  APPLIED: 0,
  FAILED: 0,
  FAILED_PERMANENT: 0,
});

export async function loadCrmStatus(sql: Sql, resolution: CrmResolution): Promise<CrmStatus> {
  const providerName = (env(CRM_ENV_KEYS.provider) ?? '').trim();
  const envLocationId = (env(CRM_ENV_KEYS.locationId) ?? '').trim();

  const destinations = await listDestinations(sql);
  const views: CrmDestinationStatusView[] = [];
  for (const destination of destinations) {
    views.push(
      Object.freeze({
        destination,
        stages: await loadPipelineStages(sql, destination.id),
        stageMap: await loadStageMap(sql, destination.id),
        linkedContacts: (await listContactLinks(sql, destination.id)).length,
        matchesEnvironment: envLocationId.length > 0 && envLocationId === destination.locationId,
      }),
    );
  }

  const counts = await sql.query<{ status: CrmProjectionStatus; n: string }>(
    'select status, count(*)::text as n from r6b_crm_projections group by status',
  );
  const projections: Record<CrmProjectionStatus, number> = { ...EMPTY_PROJECTION_COUNTS };
  for (const row of counts) projections[row.status] = Number(row.n);

  const [totals] = await sql.query<{ notes: string; alerts: string }>(
    `select (select count(*) from r6b_crm_notes)::text as notes,
            (select count(*) from r6b_alerts
              where status in ('PENDING','NO_PROVIDER','FAILED'))::text as alerts`,
  );

  return Object.freeze({
    providerName: providerName.length === 0 ? null : providerName,
    envLocationId: envLocationId.length === 0 ? null : envLocationId,
    // Présence seulement. La valeur ne quitte jamais `env()`.
    apiKeyPresent: (env(CRM_ENV_KEYS.apiKey) ?? '').trim().length > 0,
    resolution,
    destinations: Object.freeze(views),
    projections: Object.freeze(projections),
    notes: Number(totals?.notes ?? '0'),
    alertsPending: Number(totals?.alerts ?? '0'),
  });
}
