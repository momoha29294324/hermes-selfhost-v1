import type { Sql } from '@/lib/db/sql';
import {
  evaluateItemAutonomously,
  type AutonomousCandidate,
} from '@/lib/instagram/autonomousCandidate';
import { formatAutonomousDecision, isAutoSendEligible } from '@/lib/instagram/autonomousPolicy';
import { TERMINAL_JOB_STATUSES, type InstagramJobStatus } from '@/lib/instagram/types';

/**
 * HERMES-TARGETING-R1 §22 — « un prospect devenu hors cible ne doit pas rester
 * envoyable simplement parce que son job est ancien ».
 *
 * ---------------------------------------------------------------------------
 * Pourquoi ce module ne mute rien
 * ---------------------------------------------------------------------------
 * Parce que deux mécanismes traitent déjà le cas, et qu'un troisième qui
 * écrirait dans la file serait le seul à pouvoir se tromper :
 *
 *   1. la VERSION de politique. `AUTONOMOUS_POLICY_VERSION` est passée à
 *      `hermes-targeting-r1`, et `assertAutonomousProvenance` refuse toute
 *      approbation machine rendue sous une autre. Aucune approbation d'avant ne
 *      couvre les règles d'aujourd'hui — la file est donc déjà refermée, par le
 *      code, sans qu'aucune ligne n'ait besoin d'être réécrite ;
 *
 *   2. le CROCHET PRÉ-EFFET. Le worker autonome rejoue la politique juste avant
 *      le clic, sur les faits du moment (`evaluateItemAutonomously`). Un
 *      prospect devenu `SPECIALIST_OUT_OF_SCOPE` est écarté à cet instant-là,
 *      qu'on ait ou non annulé son job auparavant.
 *
 * Ce qui manquait n'était donc pas une écriture, c'était un REGARD : savoir,
 * avant de relâcher l'arrêt global, ce que la file contient encore et ce que la
 * politique en dirait maintenant. C'est ce que rend cette lecture, et rien de
 * plus. Elle n'ouvre aucun navigateur, ne touche pas à l'arrêt global, n'écrit
 * aucune ligne.
 */

export interface ReevaluatedJob {
  readonly jobId: string;
  readonly status: InstagramJobStatus;
  readonly manifestId: string;
  readonly prospectId: string;
  readonly displayName: string;
  readonly instagramHandle: string | null;
  readonly enqueuedBy: string;
  readonly createdAt: string;
  /** `null` quand l'item du batch n'existe plus — un job orphelin, donc non envoyable. */
  readonly candidate: AutonomousCandidate | null;
  readonly stillEligible: boolean;
  readonly verdict: string;
}

export interface QueueReevaluation {
  readonly jobs: readonly ReevaluatedJob[];
  readonly stillEligible: number;
  readonly newlySkipped: number;
  readonly orphaned: number;
}

interface JobRow {
  jobId: string;
  status: InstagramJobStatus;
  manifestId: string;
  prospectId: string;
  displayName: string;
  instagramHandle: string | null;
  enqueuedBy: string;
  createdAt: string | Date;
  itemId: string | null;
}

/**
 * Les jobs NON TERMINAUX, c'est-à-dire ceux qui pourraient encore produire un
 * message.
 *
 * Les terminaux sont exclus par la liste que la file elle-même publie
 * (`TERMINAL_JOB_STATUSES`) plutôt que par une énumération recopiée ici : le
 * jour où un cinquième statut absorbant apparaît, cette lecture le suit sans
 * qu'on y touche. `CLAIMED` en fait partie — un bail en cours est exactement ce
 * qu'on veut voir avant de relâcher quoi que ce soit.
 */
async function loadOpenJobs(sql: Sql): Promise<JobRow[]> {
  return sql.query<JobRow>(
    `select j.id                as "jobId",
            j.status            as "status",
            j.manifest_id       as "manifestId",
            j.prospect_id       as "prospectId",
            p.display_name      as "displayName",
            p.instagram_handle  as "instagramHandle",
            j.enqueued_by       as "enqueuedBy",
            j.created_at        as "createdAt",
            m.batch_item_id     as "itemId"
       from ig_dispatch_jobs j
       join prospects p on p.id = j.prospect_id
       left join r6b_dispatch_manifests m on m.id = j.manifest_id
      where not (j.status = any($1::text[]))
      order by j.created_at asc`,
    [[...TERMINAL_JOB_STATUSES]],
  );
}

/** LECTURE SEULE. Rejoue la politique courante sur chaque job encore ouvert. */
export async function reevaluateQueue(sql: Sql): Promise<QueueReevaluation> {
  const rows = await loadOpenJobs(sql);
  const jobs: ReevaluatedJob[] = [];
  let stillEligible = 0;
  let newlySkipped = 0;
  let orphaned = 0;

  for (const row of rows) {
    const candidate =
      row.itemId === null
        ? null
        : await evaluateItemAutonomously(sql, row.itemId, { ignoreManifestId: row.manifestId });

    const eligible = candidate !== null && isAutoSendEligible(candidate.decision);
    if (candidate === null) orphaned += 1;
    if (eligible) stillEligible += 1;
    else newlySkipped += 1;

    jobs.push(
      Object.freeze({
        jobId: row.jobId,
        status: row.status,
        manifestId: row.manifestId,
        prospectId: row.prospectId,
        displayName: row.displayName,
        instagramHandle: row.instagramHandle,
        enqueuedBy: row.enqueuedBy,
        createdAt: new Date(row.createdAt).toISOString(),
        candidate,
        stillEligible: eligible,
        verdict:
          candidate === null
            ? 'ORPHELIN:item_absent'
            : formatAutonomousDecision(candidate.decision),
      }),
    );
  }

  return Object.freeze({ jobs: Object.freeze(jobs), stillEligible, newlySkipped, orphaned });
}
