import { partitionEvidence } from '@/lib/pipeline/workers/partition';
import { buildWorkerRequest, groundWorker, parseWorkerAnswer } from '@/lib/pipeline/workers/workers';
import { mergeWorkerOutputs } from '@/lib/pipeline/workers/merge';
import { buildSynthesizerRequest, groundSynthesis } from '@/lib/pipeline/workers/synthesize';
import { parseResearchAnswer } from '@/lib/pipeline/research';
import type { ModelRouter } from '@/lib/models/router';
import type { ProspectRow } from '@/lib/repo/types';
import type { ScoreResult } from '@/lib/pipeline/score';
import type { ResearchEvidence, ResearchResult } from '@/lib/pipeline/research';
import type { WorkerLane } from '@/lib/pipeline/workers/partition';
import type { WorkerOutput } from '@/lib/pipeline/workers/workers';
import type { Logger } from '@/lib/logging/logger';

export { partitionEvidence } from '@/lib/pipeline/workers/partition';
export { mergeWorkerOutputs } from '@/lib/pipeline/workers/merge';

const LANES: WorkerLane[] = ['funnel', 'offer', 'contact'];

export interface WorkerResearchStats {
  lanesRun: number;
  lanesFailed: string[];
  factsKept: number;
  factsDropped: number;
}

/**
 * Architecture B in production: three specialists, a deterministic merge, one
 * synthesizer. Same signature and same return type as `researchProspect`, which
 * is what makes the switch a one-line change and the rollback free.
 *
 * ---------------------------------------------------------------------------
 * The failure mode this fixes
 * ---------------------------------------------------------------------------
 * R5 lost two prospects outright: one research call, one timeout after retry,
 * nothing to show. Here the three lanes fail independently. Losing the funnel
 * worker costs the funnel section of the sheet — the offer and contact facts
 * still arrive, the synthesizer is told which specialist is missing, and the
 * prospect keeps a sheet that says what it does not know.
 *
 * Only an all-lanes failure returns null, and that is deliberate: synthesising
 * from an empty merge would produce a confident sheet about nothing, which is
 * strictly worse than no sheet at all.
 */
export async function researchWithWorkers(
  router: ModelRouter,
  prospect: ProspectRow,
  evidence: ResearchEvidence[],
  score: ScoreResult,
  logger?: Logger,
): Promise<(ResearchResult & { workerStats: WorkerResearchStats }) | null> {
  const partition = partitionEvidence(evidence);

  const laneOutcomes = await Promise.all(
    LANES.map(async (lane) => {
      const laneEvidence = partition[lane];
      const request = buildWorkerRequest(lane, prospect, laneEvidence);
      const outcome = await router.run(
        {
          task: `worker_${lane}`,
          system: request.system,
          prompt: request.prompt,
          schema: request.schema,
          inputRef: `prospect:${prospect.id}`,
        },
        parseWorkerAnswer,
      );
      if (!outcome.ok || !outcome.data) {
        logger?.warn('research.worker_failed', { lane, prospect: prospect.id, error: outcome.error });
        return { lane, output: null as WorkerOutput | null, dropped: [] as string[] };
      }
      const grounded = groundWorker(lane, outcome.data, laneEvidence);
      return { lane, output: grounded.output, dropped: grounded.dropped };
    }),
  );

  const merged = mergeWorkerOutputs({
    outputs: laneOutcomes.map((outcome) => outcome.output),
    requested: LANES,
    droppedFacts: laneOutcomes.flatMap((outcome) => outcome.dropped),
    residual: partition.residual,
    evidence,
  });

  if (merged.missingLanes.length === LANES.length) {
    logger?.warn('research.all_workers_failed', { prospect: prospect.id });
    return null;
  }

  const request = buildSynthesizerRequest(prospect, merged, score);
  const outcome = await router.run(
    {
      task: 'synthesize',
      system: request.system,
      prompt: request.prompt,
      schema: request.schema,
      inputRef: `prospect:${prospect.id}`,
    },
    parseResearchAnswer,
  );
  if (!outcome.ok || !outcome.data) return null;

  const research = groundSynthesis(outcome.data, evidence, merged, outcome.modelRunId);
  return {
    ...research,
    workerStats: {
      lanesRun: LANES.length - merged.missingLanes.length,
      lanesFailed: merged.missingLanes,
      factsKept: merged.facts.length,
      factsDropped: merged.droppedFacts.length,
    },
  };
}
