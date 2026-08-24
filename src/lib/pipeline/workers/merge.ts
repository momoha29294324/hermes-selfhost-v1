import type { ResearchEvidence } from '@/lib/pipeline/research';
import type { WorkerFact, WorkerOutput } from '@/lib/pipeline/workers/workers';

/**
 * The merger.
 *
 * ---------------------------------------------------------------------------
 * Why it is code and not a model
 * ---------------------------------------------------------------------------
 * §13 says the merger invents no fact. That is a guarantee, and a prompt cannot
 * give a guarantee — it can only ask for one. Everything the merge does is
 * decidable: keep facts that cite a real evidence row, drop the rest, deduplicate
 * identical claims, order by lane and confidence. None of it needs a model, and
 * a model doing it would introduce the one failure the architecture exists to
 * remove: a second place where text can be produced without a source.
 *
 * A partially failed fan-out is the interesting case, and it is handled by
 * saying so rather than by pretending. If the funnel worker times out, the merge
 * returns the other two lanes' facts and records `missingLanes: ['funnel']`. The
 * synthesizer is told which specialist is missing, so a thin sheet is explained
 * rather than mistaken for a thin business. R5's monolith had no equivalent: a
 * failed research call produced nothing at all, and the prospect was skipped.
 */
export interface MergedEvidence {
  facts: WorkerFact[];
  uncertainties: string[];
  laneSummaries: { lane: string; summary: string }[];
  /** Lanes whose worker failed. Named so a thin sheet stays explainable. */
  missingLanes: string[];
  /** Facts dropped for citing an evidence id their worker never received. */
  droppedFacts: string[];
  /** Evidence that no worker owns, handed straight to the synthesizer. */
  residual: ResearchEvidence[];
}

export interface MergeInput {
  outputs: (WorkerOutput | null)[];
  /** Lanes requested, so a null output can be named rather than counted. */
  requested: string[];
  droppedFacts: string[];
  residual: readonly ResearchEvidence[];
  /** The full pack — the last check that a citation points at something real. */
  evidence: readonly ResearchEvidence[];
}

export function mergeWorkerOutputs(input: MergeInput): MergedEvidence {
  const known = new Set(input.evidence.map((item) => item.id));
  const facts: WorkerFact[] = [];
  const dropped = [...input.droppedFacts];
  const seen = new Set<string>();
  const uncertainties: string[] = [];
  const laneSummaries: { lane: string; summary: string }[] = [];
  const present = new Set<string>();

  for (const output of input.outputs) {
    if (!output) continue;
    present.add(output.lane);
    if (output.summary) laneSummaries.push({ lane: output.lane, summary: output.summary });
    for (const item of output.uncertainties) {
      if (item.trim() && !uncertainties.includes(item.trim())) uncertainties.push(item.trim());
    }

    for (const fact of output.facts) {
      // `groundWorker` already filtered each fact's ids down to its own lane —
      // this check is the last-line guard against a fact that reached the merge
      // some other way (a future caller, a test double) still citing something
      // outside the full pack.
      const validIds = fact.evidenceIds.filter((id) => known.has(id));
      if (validIds.length === 0) {
        dropped.push(fact.claim);
        continue;
      }
      // Two lanes reaching the same claim from the same evidence is a duplicate,
      // not a corroboration: the partition is disjoint, so it can only mean the
      // same sentence twice. Keyed on the full (sorted) id set — two facts
      // citing different rows must not collide because their first id matches.
      const key = `${[...validIds].sort().join(',')}|${normalise(fact.claim)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push(validIds.length === fact.evidenceIds.length ? fact : { ...fact, evidenceIds: validIds });
    }
  }

  // Observed facts first, then by confidence: the synthesizer reads top-down and
  // a truncated pack must lose its weakest material, not its first lane.
  facts.sort((a, b) => {
    if (a.state !== b.state) return a.state === 'observed' ? -1 : 1;
    return b.confidence - a.confidence;
  });

  return {
    facts,
    uncertainties,
    laneSummaries,
    missingLanes: input.requested.filter((lane) => !present.has(lane)),
    droppedFacts: dropped,
    residual: [...input.residual],
  };
}

function normalise(claim: string): string {
  return claim.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
