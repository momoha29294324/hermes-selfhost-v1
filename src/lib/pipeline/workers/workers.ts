import type { ResearchEvidence } from '@/lib/pipeline/research';
import type { WorkerLane } from '@/lib/pipeline/workers/partition';
import type { ProspectRow } from '@/lib/repo/types';

/**
 * The three specialists.
 *
 * ---------------------------------------------------------------------------
 * What a worker is allowed to return
 * ---------------------------------------------------------------------------
 * A fact with an `evidence_id`, a `state`, and nothing else. In particular a
 * worker does not get to write prose about the business: the summary field is a
 * single sentence and the merger never quotes it as evidence.
 *
 * `state` carries the distinction the whole repo turns on (rule 2):
 *
 *   observed      a fact is in the pack and says this;
 *   not_observed  the pack does not say; we do not know; nobody may conclude.
 *
 * There is no third value, and specifically no "absent". A worker that wants to
 * say "they have no booking system" can only say "not_observed", because the
 * pack cannot distinguish a site without booking from a page we did not read.
 * `absent` would be a value the evidence cannot justify, so the schema does not
 * offer it — which is cheaper than forbidding it in prose and hoping.
 *
 * `evidenceIds` is a array for the same reason as the monolith's
 * `ResearchObservation` (see research.ts): a claim can legitimately combine two
 * facts, and a single-string slot pushed models to pack several ids into one
 * field, which then failed to resolve as a whole and dropped a true claim.
 */
export interface WorkerFact {
  claim: string;
  evidenceIds: string[];
  state: 'observed' | 'not_observed';
  confidence: number;
}

export interface WorkerOutput {
  lane: WorkerLane;
  facts: WorkerFact[];
  uncertainties: string[];
  summary: string;
}

export const WORKER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['facts', 'uncertainties', 'summary'],
  properties: {
    facts: {
      type: 'array',
      minItems: 0,
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'evidence_ids', 'state', 'confidence'],
        properties: {
          claim: { type: 'string', maxLength: 180 },
          evidence_ids: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string' } },
          state: { type: 'string', enum: ['observed', 'not_observed'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
    uncertainties: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 180 } },
    summary: { type: 'string', maxLength: 240 },
  },
} as const;

/**
 * The shared half of every worker instruction.
 *
 * Kept identical across the three on purpose: the lanes must differ by the
 * facts they receive and by the question they are asked, never by how strictly
 * they are held to their evidence. A worker with looser rules would look better
 * in the merge for a reason that has nothing to do with the model.
 */
const COMMON_RULES = `Règles absolues :
- chaque fait DOIT citer dans evidence_ids l'identifiant (ou les identifiants, si le fait combine
  plusieurs lignes) entre crochets de la liste fournie — un tableau, jamais une chaîne du type
  "id1, id2" ;
- si la liste ne dit rien d'un point, l'état est "not_observed" — jamais "absent", jamais nié :
  nous ne pouvons pas distinguer une chose qui n'existe pas d'une page que nous n'avons pas lue ;
- pas de chiffre absent de la liste, pas de supposition présentée comme un fait ;
- ne parle QUE de ton domaine ; ce que tu ne vois pas ici, quelqu'un d'autre le regarde ;
- résumé : une phrase, factuelle, sans jugement commercial ;
- réponds uniquement en JSON conforme au schéma.`;

const LANE_BRIEFS: Record<WorkerLane, { title: string; scope: string }> = {
  funnel: {
    title: "Tu analyses le PARCOURS COMMERCIAL d'une entreprise de atelier automobile.",
    scope: `Ton domaine, et rien d'autre :
- appels à l'action et leur formulation ;
- devis, formulaire, réservation en ligne, prise de rendez-vous ;
- WhatsApp, téléphone, DM comme étape de conversion ;
- étapes entre l'arrivée du visiteur et la demande ;
- frictions observables, prochaine action attendue.`,
  },
  offer: {
    title: "Tu analyses l'OFFRE ET LES SIGNAUX DE CONFIANCE d'une entreprise de atelier automobile.",
    scope: `Ton domaine, et rien d'autre :
- prestations proposées et segmentation ;
- prix affichés, positionnement, gamme ;
- garanties, avis, preuves, certifications ;
- éléments de différenciation réellement écrits.`,
  },
  contact: {
    title: "Tu analyses les CANAUX DE CONTACT ET L'IDENTITÉ d'une entreprise de atelier automobile.",
    scope: `Ton domaine, et rien d'autre :
- téléphone, email, adresse ;
- Instagram, Facebook et autres comptes rattachés ;
- identité déclarée par le site (raison sociale, SIREN, mentions légales) ;
- cohérence entre l'identité déclarée et le nom commercial.`,
  },
};

export function buildWorkerRequest(
  lane: WorkerLane,
  prospect: Pick<ProspectRow, 'display_name' | 'city' | 'website_url'>,
  evidence: readonly ResearchEvidence[],
): { system: string; prompt: string; schema: Record<string, unknown> } {
  const brief = LANE_BRIEFS[lane];
  const factLines = evidence
    .filter((item) => item.value_text || item.value_json)
    .map((item) => {
      const value = item.value_text ?? JSON.stringify(item.value_json);
      const truncated = value.length > 300 ? `${value.slice(0, 300)}…` : value;
      return `[${item.id}] ${item.field} = ${truncated}  (source: ${item.provider}${item.source_url ? ` — ${item.source_url}` : ''})`;
    });

  // The identity header is three prospect columns, not evidence: a worker has to
  // know whose site it is reading, and routing that through the evidence split
  // would break the disjointness the partition guarantees.
  const prompt = `ENTREPRISE : ${prospect.display_name}${prospect.city ? ` — ${prospect.city}` : ''}${
    prospect.website_url ? `\nSITE : ${prospect.website_url}` : ''
  }

FAITS DE TON DOMAINE (les seuls autorisés, cite leur identifiant entre crochets)
${factLines.join('\n') || '- aucun fait disponible dans ton domaine'}

Produis ton analyse.`;

  return {
    system: `${brief.title}\n\n${brief.scope}\n\n${COMMON_RULES}`,
    prompt,
    schema: WORKER_SCHEMA as unknown as Record<string, unknown>,
  };
}

export function parseWorkerAnswer(value: unknown): {
  facts: { claim: string; evidence_ids: string[]; state: string; confidence: number }[];
  uncertainties: string[];
  summary: string;
} {
  const parsed = value as Record<string, unknown>;
  if (typeof parsed['summary'] !== 'string') throw new Error('summary missing');
  const facts = Array.isArray(parsed['facts']) ? parsed['facts'] : [];
  return {
    facts: facts.map((item) => {
      const fact = item as Record<string, unknown>;
      // Tolerate the old singular shape rather than crash on it: not what the
      // schema asks for, but a provider is allowed to be imperfect.
      const ids = Array.isArray(fact['evidence_ids'])
        ? fact['evidence_ids'].map(String)
        : typeof fact['evidence_id'] === 'string'
          ? [fact['evidence_id']]
          : [];
      return {
        claim: String(fact['claim'] ?? ''),
        evidence_ids: ids,
        state: String(fact['state'] ?? 'not_observed'),
        confidence: typeof fact['confidence'] === 'number' ? fact['confidence'] : 0.5,
      };
    }),
    uncertainties: Array.isArray(parsed['uncertainties']) ? parsed['uncertainties'].map(String) : [],
    summary: parsed['summary'],
  };
}

/**
 * Re-grounds a worker answer against the facts that worker was actually given.
 *
 * Note `lane` evidence, not the whole pack: a worker citing an id it never
 * received has not made a lucky guess, it has been handed something by a bug or
 * has invented an identifier that happens to exist. Both must be dropped, and
 * checking against the full pack would let the second one through.
 *
 * Grounding is per-id: a fact keeps only the ids that resolve within its own
 * lane, and survives as long as at least one does — the same rule as the
 * monolith's `groundResearch`, for the same reason.
 */
export function groundWorker(
  lane: WorkerLane,
  data: ReturnType<typeof parseWorkerAnswer>,
  laneEvidence: readonly ResearchEvidence[],
): { output: WorkerOutput; dropped: string[] } {
  const known = new Set(laneEvidence.map((item) => item.id));
  const facts: WorkerFact[] = [];
  const dropped: string[] = [];

  for (const fact of data.facts) {
    if (!fact.claim.trim()) continue;
    const validIds = fact.evidence_ids.filter((id) => known.has(id));
    if (validIds.length === 0) {
      dropped.push(fact.claim);
      continue;
    }
    facts.push({
      claim: fact.claim.trim(),
      evidenceIds: validIds,
      state: fact.state === 'observed' ? 'observed' : 'not_observed',
      confidence: Math.max(0, Math.min(1, fact.confidence)),
    });
  }

  return {
    output: { lane, facts, uncertainties: data.uncertainties, summary: data.summary.trim() },
    dropped,
  };
}
