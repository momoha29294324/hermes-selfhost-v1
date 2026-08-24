import type { ModelRouter } from '@/lib/models/router';
import type { ProspectRow } from '@/lib/repo/types';
import type { ScoreResult } from '@/lib/pipeline/score';

/**
 * Prospect research: an internal fact sheet produced BEFORE any message exists.
 *
 * Grounding rule enforced in code, not just in the prompt: every observation must
 * cite the id of an evidence row that was actually handed to the model. Anything
 * else is dropped and counted, so hallucinated observations cannot reach a message.
 *
 * `evidenceIds` is an array, not a single id — R5.1's benchmark measured why.
 * An observation legitimately depends on more than one fact ("prix affichés ET
 * réservation en ligne" cites two evidence rows), and when the schema offered
 * only one slot, models packed several ids into it as one string
 * ("id1, id2, id3", or an id plus a trailing note). The grounding lookup then
 * failed on the whole string and dropped a true, sourced observation — 18 of the
 * 20 provenance violations measured on the R5 baseline were exactly this. The
 * array lets each id resolve independently: a mix of valid and bogus ids keeps
 * the valid ones rather than discarding the observation outright, and only an
 * observation with zero valid ids is still dropped.
 */
export interface ResearchEvidence {
  id: string;
  field: string;
  value_text: string | null;
  value_json: unknown;
  provider: string;
  source_url: string | null;
  observed_at: string;
}

export interface ResearchObservation {
  text: string;
  /** One or more evidence ids, all of which resolved against the pack. */
  evidenceIds: string[];
  sourceUrl: string | null;
  provider: string;
}

export interface ResearchResult {
  summary: string;
  observations: ResearchObservation[];
  opportunities: string[];
  unknowns: string[];
  confidence: number;
  droppedObservations: string[];
  modelRunId: string | null;
}

export const RESEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'observations', 'opportunities', 'unknowns', 'confidence'],
  properties: {
    summary: { type: 'string', maxLength: 600 },
    observations: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'evidence_ids'],
        properties: {
          text: { type: 'string', maxLength: 220 },
          // Un tableau, pas une chaîne : une observation peut légitimement
          // reposer sur plusieurs faits, et un seul emplacement texte poussait
          // les modèles à empiler les identifiants dans une seule chaîne — que
          // le rattachement ne pouvait plus résoudre.
          evidence_ids: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string' } },
        },
      },
    },
    opportunities: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 240 } },
    unknowns: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 240 } },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
} as const;

const SYSTEM = `Tu es analyste avant-vente pour une agence d'acquisition (Hermes).
Tu produis une fiche interne factuelle sur une entreprise, destinée à préparer une prise de contact.

Règles absolues :
- chaque observation DOIT s'appuyer sur un ou plusieurs faits de la liste fournie et citer leurs
  identifiants dans evidence_ids (un tableau — mets-en plusieurs si l'observation combine
  plusieurs faits, jamais une chaîne du type "id1, id2") ;
- interdiction formelle d'affirmer l'absence de quelque chose que nous n'avons pas vérifié
  (ex : ne jamais écrire "ils ne font pas de publicité" si aucun fait ne le montre) ;
- ce qui n'est pas observé va dans "unknowns", formulé comme une inconnue, pas comme un fait ;
- les opportunités sont des hypothèses de travail, formulées avec prudence ;
- pas de chiffre inventé, pas de superlatif, pas de jugement gratuit ;
- réponds uniquement en JSON conforme au schéma.`;

/**
 * The research request, as a value.
 *
 * Extracted from `researchProspect` so the R5.1 benchmark drives the exact
 * production prompt through every model rather than a paraphrase of it. §26
 * forbids tuning the prompt per variant, and the cheapest way to guarantee that
 * is to leave one builder and no copy of it.
 */
export function buildResearchRequest(
  prospect: ProspectRow,
  evidence: ResearchEvidence[],
  score: ScoreResult,
): { system: string; prompt: string; schema: Record<string, unknown> } {
  const factLines = evidence
    .filter((item) => item.value_text || item.value_json)
    .slice(0, 45)
    .map((item) => {
      const value = item.value_text ?? JSON.stringify(item.value_json);
      const truncated = value.length > 300 ? `${value.slice(0, 300)}…` : value;
      return `[${item.id}] ${item.field} = ${truncated}  (source: ${item.provider}${item.source_url ? ` — ${item.source_url}` : ''})`;
    });

  const missing = score.missingSignals.length > 0 ? score.missingSignals.join(', ') : 'aucun';

  const prompt = `ENTREPRISE
- nom : ${prospect.display_name}
- raison sociale : ${prospect.legal_name ?? 'inconnue'}
- ville : ${prospect.city ?? 'inconnue'}${prospect.postal_code ? ` (${prospect.postal_code})` : ''}
- site : ${prospect.website_url ?? 'aucun site connu'}
- Instagram : ${prospect.instagram_handle ? `@${prospect.instagram_handle}` : 'inconnu'}
- classification : ${prospect.niche_verdict ?? 'inconnue'} (confiance ${prospect.niche_confidence ?? '?'})
- score interne : ${score.total}/100 (bande ${score.band}, couverture des signaux ${Math.round(score.coverage * 100)}%)

FAITS DISPONIBLES (les seuls autorisés, cite leur identifiant entre crochets)
${factLines.join('\n') || '- aucun fait complémentaire'}

SIGNAUX NON OBSERVÉS (ne rien affirmer à leur sujet) : ${missing}

Produis la fiche interne.`;

  return { system: SYSTEM, prompt, schema: RESEARCH_SCHEMA as unknown as Record<string, unknown> };
}

/**
 * Parses and re-grounds a research answer.
 *
 * Split out for the same reason as the builder: the benchmark must judge every
 * variant with the grounding rule production applies, not a looser one.
 *
 * Grounding is now per-id, not per-observation: `evidence_ids` is filtered down
 * to the ids that actually exist in the pack, and the observation survives if
 * at least one does. A fabricated id sitting next to a real one is silently
 * excluded — never trusted, never used to sink the real one alongside it. Only
 * an observation whose every id is bogus (or that names none) is dropped, and
 * counted in `droppedObservations` exactly as before.
 */
export function groundResearch(
  data: {
    summary: string;
    observations: { text: string; evidence_ids: string[] }[];
    opportunities: string[];
    unknowns: string[];
    confidence: number;
  },
  evidence: readonly ResearchEvidence[],
  modelRunId: string | null,
): ResearchResult {
  const byId = new Map(evidence.map((item) => [item.id, item]));
  const observations: ResearchObservation[] = [];
  const dropped: string[] = [];

  for (const observation of data.observations) {
    const validIds = observation.evidence_ids.filter((id) => byId.has(id));
    if (validIds.length === 0 || !observation.text.trim()) {
      dropped.push(observation.text || observation.evidence_ids.join(', '));
      continue;
    }
    // The primary source — first valid citation — carries the displayed
    // provider/url. Every valid id is still kept in `evidenceIds` for grounding
    // checks downstream (angle, message, the deterministic quality metrics).
    const primary = byId.get(validIds[0] as string);
    observations.push({
      text: observation.text.trim(),
      evidenceIds: validIds,
      sourceUrl: primary?.source_url ?? null,
      provider: primary?.provider ?? '',
    });
  }

  return {
    summary: data.summary.trim(),
    observations,
    opportunities: data.opportunities,
    unknowns: data.unknowns,
    confidence: Math.max(0, Math.min(1, data.confidence)),
    droppedObservations: dropped,
    modelRunId,
  };
}

export function parseResearchAnswer(value: unknown): {
  summary: string;
  observations: { text: string; evidence_ids: string[] }[];
  opportunities: string[];
  unknowns: string[];
  confidence: number;
} {
  const parsed = value as Record<string, unknown>;
  if (typeof parsed['summary'] !== 'string') throw new Error('summary missing');
  const observations = Array.isArray(parsed['observations']) ? parsed['observations'] : [];
  return {
    summary: parsed['summary'],
    observations: observations.map((item) => {
      const obs = item as { text?: unknown; evidence_ids?: unknown; evidence_id?: unknown };
      // Tolerate a model that still answers the old singular shape (or a bare
      // string instead of an array): normalise rather than crash. This is not
      // the schema we send — the schema only offers `evidence_ids` — but a
      // provider is allowed to be imperfect, and refusing to parse would waste
      // a call that otherwise carried a real, sourced observation.
      const ids = Array.isArray(obs.evidence_ids)
        ? obs.evidence_ids.map(String)
        : typeof obs.evidence_id === 'string'
          ? [obs.evidence_id]
          : [];
      return { text: String(obs.text ?? ''), evidence_ids: ids };
    }),
    opportunities: Array.isArray(parsed['opportunities']) ? parsed['opportunities'].map(String) : [],
    unknowns: Array.isArray(parsed['unknowns']) ? parsed['unknowns'].map(String) : [],
    confidence: typeof parsed['confidence'] === 'number' ? parsed['confidence'] : 0.5,
  };
}

export async function researchProspect(
  router: ModelRouter,
  prospect: ProspectRow,
  evidence: ResearchEvidence[],
  score: ScoreResult,
): Promise<ResearchResult | null> {
  const request = buildResearchRequest(prospect, evidence, score);

  const outcome = await router.run<{
    summary: string;
    observations: { text: string; evidence_ids: string[] }[];
    opportunities: string[];
    unknowns: string[];
    confidence: number;
  }>(
    {
      task: 'research',
      system: request.system,
      prompt: request.prompt,
      schema: request.schema,
      inputRef: `prospect:${prospect.id}`,
    },
    parseResearchAnswer,
  );

  if (!outcome.ok || !outcome.data) return null;
  return groundResearch(outcome.data, evidence, outcome.modelRunId);
}
