import type { ModelRouter } from '@/lib/models/router';
import type { ProspectRow } from '@/lib/repo/types';
import type { ResearchResult } from '@/lib/pipeline/research';
import type { Sql } from '@/lib/db/sql';

/**
 * Commercial angle: turns the research sheet into one approach, one concrete hook
 * and a decision about whether the case study helps.
 *
 * The personalisation hook must quote an observation that survived grounding, so
 * "j'ai vu que ..." can only refer to something the pipeline genuinely saw.
 */
export interface CaseStudy {
  key: string;
  claim: string;
  clientLabel: string;
  metrics: unknown[];
}

export interface AngleResult {
  painPoint: string;
  opportunity: string;
  approach: string;
  personalization: string;
  personalizationEvidence: string[];
  useCaseStudy: boolean;
  caseStudyKey: string | null;
  confidence: number;
  modelRunId: string | null;
}

export const ANGLE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pain_point', 'opportunity', 'approach', 'personalization', 'personalization_evidence_ids', 'use_case_study', 'confidence'],
  properties: {
    pain_point: { type: 'string', maxLength: 320 },
    opportunity: { type: 'string', maxLength: 360 },
    approach: { type: 'string', maxLength: 460 },
    personalization: { type: 'string', maxLength: 320 },
    personalization_evidence_ids: { type: 'array', minItems: 0, maxItems: 3, items: { type: 'string' } },
    use_case_study: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
} as const;

function buildSystem(caseStudy: CaseStudy | null): string {
  return `Tu prépares l'angle d'approche commercial d'une agence d'acquisition (Hermes) vers une entreprise de atelier automobile.

Règles absolues :
- l'accroche de personnalisation doit reposer sur une observation citée (evidence_id) ; sinon laisse-la vide et baisse la confiance ;
- interdiction d'affirmer une absence non vérifiée (publicité, budget, résultats, concurrence) ;
- le "pain point" est une hypothèse plausible, pas un diagnostic asséné ;
- pas de promesse chiffrée, pas de garantie, pas de fausse urgence ;
${
  caseStudy
    ? `- une seule preuve sociale est autorisée, mot pour mot : "${caseStudy.claim}". Aucune autre métrique (ROAS, nombre de leads, budget, période, marge) n'existe : ne rien ajouter.
- décide si cette preuve sert vraiment ce prospect ; elle n'est pas obligatoire.`
    : `- aucune preuve sociale n'est disponible : use_case_study doit être false.`
}
- réponds uniquement en JSON conforme au schéma.`;
}

/** The angle request as a value — see `buildResearchRequest` for the reason. */
export function buildAngleRequest(
  prospect: ProspectRow,
  research: ResearchResult,
  caseStudy: CaseStudy | null,
): { system: string; prompt: string; schema: Record<string, unknown> } {
  const observations = research.observations
    .map((observation) => `[${observation.evidenceIds.join(', ')}] ${observation.text}`)
    .join('\n');

  const prompt = `ENTREPRISE : ${prospect.display_name}${prospect.city ? ` — ${prospect.city}` : ''}

SYNTHÈSE
${research.summary}

OBSERVATIONS VÉRIFIÉES (seule base autorisée pour la personnalisation)
${observations || '- aucune observation vérifiée'}

OPPORTUNITÉS IDENTIFIÉES
${research.opportunities.map((item) => `- ${item}`).join('\n') || '- aucune'}

INCONNUES (ne rien affirmer à ce sujet)
${research.unknowns.map((item) => `- ${item}`).join('\n') || '- aucune'}

Produis l'angle d'approche.`;

  return {
    system: buildSystem(caseStudy),
    prompt,
    schema: ANGLE_SCHEMA as unknown as Record<string, unknown>,
  };
}

export function parseAngleAnswer(value: unknown): {
  pain_point: string;
  opportunity: string;
  approach: string;
  personalization: string;
  personalization_evidence_ids: string[];
  use_case_study: boolean;
  confidence: number;
} {
  const parsed = value as Record<string, unknown>;
  for (const key of ['pain_point', 'opportunity', 'approach', 'personalization']) {
    if (typeof parsed[key] !== 'string') throw new Error(`${key} missing`);
  }
  return {
    pain_point: parsed['pain_point'] as string,
    opportunity: parsed['opportunity'] as string,
    approach: parsed['approach'] as string,
    personalization: parsed['personalization'] as string,
    personalization_evidence_ids: Array.isArray(parsed['personalization_evidence_ids'])
      ? parsed['personalization_evidence_ids'].map(String)
      : [],
    use_case_study: parsed['use_case_study'] === true,
    confidence: typeof parsed['confidence'] === 'number' ? parsed['confidence'] : 0.5,
  };
}

/**
 * Applies the grounding rule to a raw angle answer.
 *
 * An ungrounded hook is not a hook: it is dropped rather than allowed to reach a
 * message, and the confidence is capped so the drop is visible downstream.
 */
export function groundAngle(
  data: ReturnType<typeof parseAngleAnswer>,
  research: ResearchResult,
  caseStudy: CaseStudy | null,
  modelRunId: string | null,
): AngleResult {
  const allowedIds = new Set(research.observations.flatMap((observation) => observation.evidenceIds));
  const grounded = data.personalization_evidence_ids.filter((id) => allowedIds.has(id));

  const personalization = grounded.length > 0 ? data.personalization.trim() : '';
  const confidence = grounded.length > 0 ? data.confidence : Math.min(data.confidence, 0.35);

  return {
    painPoint: data.pain_point.trim(),
    opportunity: data.opportunity.trim(),
    approach: data.approach.trim(),
    personalization,
    personalizationEvidence: grounded,
    useCaseStudy: Boolean(caseStudy) && data.use_case_study,
    caseStudyKey: caseStudy && data.use_case_study ? caseStudy.key : null,
    confidence: Math.max(0, Math.min(1, confidence)),
    modelRunId,
  };
}

export async function buildAngle(
  router: ModelRouter,
  prospect: ProspectRow,
  research: ResearchResult,
  caseStudy: CaseStudy | null,
): Promise<AngleResult | null> {
  const request = buildAngleRequest(prospect, research, caseStudy);

  const outcome = await router.run<{
    pain_point: string;
    opportunity: string;
    approach: string;
    personalization: string;
    personalization_evidence_ids: string[];
    use_case_study: boolean;
    confidence: number;
  }>(
    {
      task: 'angle',
      system: request.system,
      prompt: request.prompt,
      schema: request.schema,
      inputRef: `prospect:${prospect.id}`,
    },
    parseAngleAnswer,
  );

  if (!outcome.ok || !outcome.data) return null;
  return groundAngle(outcome.data, research, caseStudy, outcome.modelRunId);
}

/** The single approved case study, if one exists and is currently usable. */
export async function loadCaseStudy(sql: Sql): Promise<CaseStudy | null> {
  const rows = await sql.query<{ key: string; claim: string; client_label: string; metrics: unknown }>(
    `select key, claim, client_label, metrics from case_studies
      where is_approved = true and usable_from <= now()
      order by created_at asc limit 1`,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    key: row.key,
    claim: row.claim,
    clientLabel: row.client_label,
    metrics: Array.isArray(row.metrics) ? row.metrics : [],
  };
}
