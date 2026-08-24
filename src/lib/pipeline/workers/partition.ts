import type { ResearchEvidence } from '@/lib/pipeline/research';

/**
 * Cutting the evidence pack up before any model sees it.
 *
 * ---------------------------------------------------------------------------
 * The rule this file enforces (§12)
 * ---------------------------------------------------------------------------
 * The forbidden design is three workers reading the same large dump. It would
 * be the easiest thing to build and it would make everything worse: three times
 * the input tokens, three times the reasoning over material two of the three
 * must ignore, and — the part that actually hurts — three chances of a worker
 * answering out of its lane, which the merger would then have to arbitrate.
 *
 * So the split happens here, in code, on the field name. A worker receives the
 * facts of its subject and is not told the others exist.
 *
 * ---------------------------------------------------------------------------
 * Total and disjoint, both required, for different reasons
 * ---------------------------------------------------------------------------
 * Disjoint, because an evidence row read by two workers is a fact that can be
 * asserted twice with two confidences, and the merger has no principled way to
 * choose between them.
 *
 * Total, because a partition that silently drops a field is a pipeline that
 * silently stops knowing something. `residual` exists for exactly that: any
 * field this file has not been taught about lands there and is handed to the
 * synthesizer rather than disappearing. A new extractor shipping a new field
 * therefore degrades to "the specialist did not see it", never to "nobody did".
 * `tests/workerPartition.test.ts` pins both properties against the real corpus.
 */
export interface EvidencePartition {
  funnel: ResearchEvidence[];
  offer: ResearchEvidence[];
  contact: ResearchEvidence[];
  /** Fields no worker claims. Given to the synthesizer, never dropped. */
  residual: ResearchEvidence[];
}

export type WorkerLane = 'funnel' | 'offer' | 'contact';

/**
 * Field → lane.
 *
 * Read this as the answer to "which specialist would be wrong to ignore it":
 *
 *   funnel   what a visitor is asked to do next, and what stops them;
 *   offer    what is sold, to whom, at what price, with what proof;
 *   contact  how to reach the business, and who the business is.
 *
 * `website_headings` is the borderline case and it goes to `offer`: headings on
 * a atelier site are a service list far more often than a call to action, and
 * the funnel worker already receives the CTAs themselves — which is the signal
 * it would otherwise have been mining the headings for.
 */
const LANES: Record<string, WorkerLane> = {
  // --- funnel: the commercial path -----------------------------------------
  cta: 'funnel',
  cta_quality: 'funnel',
  funnel_observed: 'funnel',
  funnel_not_observed: 'funnel',
  funnel_synthesis: 'funnel',
  booking_system: 'funnel',
  website_quality: 'funnel',
  crawl_robots_skip: 'funnel',

  // --- offer / trust: what is sold and what backs it -----------------------
  services: 'offer',
  premium_services: 'offer',
  price_mentions: 'offer',
  website_title: 'offer',
  website_description: 'offer',
  website_headings: 'offer',
  provider_attributes: 'offer',

  // --- contact / social: reachability and identity -------------------------
  phone: 'contact',
  email: 'contact',
  instagram_handle: 'contact',
  facebook_url: 'contact',
  website_url: 'contact',
  address_line: 'contact',
  city: 'contact',
  postal_code: 'contact',
  display_name: 'contact',
  brand_name: 'contact',
  legal_name: 'contact',
  registry_id: 'contact',
  site_identity_declarations: 'contact',
  commercial_discovery: 'contact',
  website_lookup: 'contact',
};

export function partitionEvidence(evidence: readonly ResearchEvidence[]): EvidencePartition {
  const partition: EvidencePartition = { funnel: [], offer: [], contact: [], residual: [] };
  for (const item of evidence) {
    const lane = LANES[item.field];
    if (lane === 'funnel') partition.funnel.push(item);
    else if (lane === 'offer') partition.offer.push(item);
    else if (lane === 'contact') partition.contact.push(item);
    else partition.residual.push(item);
  }
  return partition;
}

/** The fields a lane owns. Exposed so the tests can assert the map is total. */
export function fieldsFor(lane: WorkerLane): string[] {
  return Object.entries(LANES)
    .filter(([, value]) => value === lane)
    .map(([field]) => field)
    .sort();
}

export function knownFields(): string[] {
  return Object.keys(LANES).sort();
}
