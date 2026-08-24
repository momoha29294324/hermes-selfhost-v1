import { stripAccents } from '@/lib/identity/normalize';
import type { NicheConfig } from '@/lib/config/schema';
import type { ModelRouter } from '@/lib/models/router';
import type { NicheVerdict, ProspectRow } from '@/lib/repo/types';

export interface ClassificationEvidence {
  field: string;
  value_text: string | null;
  value_json: unknown;
  provider: string;
  source_url: string | null;
}

export interface ClassificationOutcome {
  verdict: NicheVerdict;
  confidence: number;
  decidedBy: 'deterministic' | 'llm';
  reasons: string[];
  evidenceRefs: string[];
  modelRunId: string | null;
}

export interface DeterministicSignals {
  positiveHits: string[];
  negativeHits: string[];
  adjacentHits: string[];
  registryCode: string | null;
  registryCodeAllowed: boolean | null;
  verdict: NicheVerdict;
  confidence: number;
  decisive: boolean;
}

function haystack(prospect: ProspectRow, evidence: ClassificationEvidence[]): string {
  const parts: string[] = [prospect.display_name, prospect.brand_name ?? '', prospect.legal_name ?? ''];
  for (const item of evidence) {
    if (['website_title', 'website_description', 'services', 'website_text', 'osm_category'].includes(item.field)) {
      if (item.value_text) parts.push(item.value_text);
      if (Array.isArray(item.value_json)) parts.push((item.value_json as unknown[]).join(' '));
    }
  }
  return stripAccents(parts.join(' \n ')).toLowerCase();
}

function findTerms(text: string, terms: string[]): string[] {
  const found: string[] = [];
  for (const term of terms) {
    const normalized = stripAccents(term).toLowerCase().trim();
    if (!normalized) continue;
    if (text.includes(normalized)) found.push(term);
  }
  return [...new Set(found)];
}

/**
 * Rules-only pass. It is deliberately allowed to be decisive in the easy cases
 * (an explicit "example-services" in the trading name, or an explicit disqualifier) so
 * that the LLM is only asked about genuinely ambiguous businesses.
 */
export function classifyDeterministic(
  prospect: ProspectRow,
  evidence: ClassificationEvidence[],
  niche: NicheConfig,
): DeterministicSignals {
  const text = haystack(prospect, evidence);
  const positiveHits = findTerms(text, niche.positiveTerms);
  const negativeHits = findTerms(text, niche.negativeTerms);
  const adjacentHits = findTerms(text, niche.adjacentTerms);

  const registryCode =
    evidence.find((e) => e.field === 'registry_code')?.value_text ?? null;
  const registryCodeAllowed =
    registryCode === null
      ? null
      : niche.excludedRegistryCodes.includes(registryCode)
        ? false
        : niche.registryCodes.length === 0
          ? null
          : niche.registryCodes.includes(registryCode);

  // An unambiguous trading-name match with no contradicting signal.
  if (positiveHits.length > 0 && negativeHits.length === 0) {
    const nameText = stripAccents(`${prospect.display_name} ${prospect.brand_name ?? ''}`).toLowerCase();
    const inName = findTerms(nameText, niche.positiveTerms).length > 0;
    const confidence = Math.min(0.95, 0.6 + 0.1 * positiveHits.length + (inName ? 0.15 : 0));
    return {
      positiveHits,
      negativeHits,
      adjacentHits,
      registryCode,
      registryCodeAllowed,
      verdict: 'in_niche',
      confidence,
      decisive: inName && registryCodeAllowed !== false,
    };
  }

  if (negativeHits.length > 0 && positiveHits.length === 0) {
    return {
      positiveHits,
      negativeHits,
      adjacentHits,
      registryCode,
      registryCodeAllowed,
      verdict: 'out_of_niche',
      confidence: Math.min(0.9, 0.6 + 0.1 * negativeHits.length),
      decisive: registryCodeAllowed === false,
    };
  }

  if (adjacentHits.length > 0 && positiveHits.length === 0) {
    return {
      positiveHits,
      negativeHits,
      adjacentHits,
      registryCode,
      registryCodeAllowed,
      verdict: 'adjacent',
      confidence: 0.55,
      decisive: false,
    };
  }

  return {
    positiveHits,
    negativeHits,
    adjacentHits,
    registryCode,
    registryCodeAllowed,
    verdict: 'uncertain',
    confidence: 0.3,
    decisive: false,
  };
}

/**
 * Turns a provider name into the epistemic class the prompt actually needs.
 *
 * The classifier used to render `[source: google_places]` / `[source: sirene]`
 * straight into the prompt. That put a vendor brand on the path to the score:
 * the LLM's confidence feeds `niche_fit`, the heaviest signal in the profile, so
 * a model that reads "Google Places" as corroboration scores that prospect
 * higher than an identical one found in the registry. Discovery provenance must
 * not be worth points — R2 gate criterion 7.
 *
 * What the prompt legitimately needs is how much an observation can be trusted,
 * which is a property of the KIND of source, not of the vendor. The real
 * provider stays in prospect_evidence for audit.
 */
export function sourceClass(provider: string): string {
  const name = provider.toLowerCase();
  if (name.startsWith('search:') || name === 'webintel') return 'moteur de recherche';
  // R3 : le rail web ouvert lit le site de l'entreprise elle-même. Ce qu'il
  // rapporte a la même nature épistémique qu'un crawl direct, et doit donc
  // porter la même étiquette — la façon dont le domaine a été trouvé n'entre
  // pas dans le jugement de niche.
  if (name === 'website' || name === 'open_web') return "site de l'entreprise";
  if (name === 'sirene' || name === 'registry') return 'registre officiel';
  if (name === 'overpass' || name === 'osm') return 'annuaire cartographique ouvert';
  if (name === 'google_places') return 'annuaire cartographique';
  if (name === 'common_crawl' || name === 'domain_probe') return 'archive publique du web';
  if (name === 'facebook_pages') return 'annuaire de pages sociales';
  if (name === 'instagram_business_discovery') return 'profil social professionnel';
  if (name === 'seed' || name === 'manual') return 'saisie manuelle vérifiée';
  if (name === 'system') return 'journal interne';
  return 'source externe';
}

export const CLASSIFICATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'confidence', 'reasons'],
  properties: {
    verdict: { type: 'string', enum: ['in_niche', 'adjacent', 'out_of_niche', 'uncertain'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reasons: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string' } },
  },
} as const;

const SYSTEM = `Tu es un analyste de qualification B2B. Tu classes une entreprise par rapport à une niche cible.
Règles absolues :
- tu ne juges QUE sur les faits fournis ; tu n'inventes aucune information ;
- si les faits sont insuffisants, réponds "uncertain" plutôt que de deviner ;
- "in_niche" = le cœur de métier correspond à la niche ;
- "adjacent" = métier proche mais différent ;
- "out_of_niche" = hors sujet ;
- réponds uniquement en JSON conforme au schéma.`;

export async function classifyWithLlm(
  router: ModelRouter,
  prospect: ProspectRow,
  evidence: ClassificationEvidence[],
  niche: NicheConfig,
  signals: DeterministicSignals,
): Promise<ClassificationOutcome | null> {
  const facts = evidence
    .filter((e) => e.value_text || e.value_json)
    .slice(0, 40)
    .map((e) => `- ${e.field} = ${e.value_text ?? JSON.stringify(e.value_json)} [source: ${sourceClass(e.provider)}]`)
    .join('\n');

  const prompt = `NICHE CIBLE : ${niche.label}
${niche.description}

Exemples de termes qui indiquent la niche : ${niche.positiveTerms.slice(0, 15).join(', ')}
Exemples de termes qui l'excluent : ${niche.negativeTerms.slice(0, 15).join(', ')}

ENTREPRISE
- nom affiché : ${prospect.display_name}
- raison sociale : ${prospect.legal_name ?? 'inconnue'}
- enseigne : ${prospect.brand_name ?? 'inconnue'}
- ville : ${prospect.city ?? 'inconnue'}
- code activité (NAF) : ${signals.registryCode ?? 'inconnu'}

FAITS OBSERVÉS (aucun autre fait n'existe)
${facts || '- aucun fait complémentaire collecté'}

PRÉ-ANALYSE DÉTERMINISTE (indicative)
- termes de niche trouvés : ${signals.positiveHits.join(', ') || 'aucun'}
- termes d'exclusion trouvés : ${signals.negativeHits.join(', ') || 'aucun'}
- termes adjacents trouvés : ${signals.adjacentHits.join(', ') || 'aucun'}

Classe cette entreprise.`;

  const outcome = await router.run<{ verdict: NicheVerdict; confidence: number; reasons: string[] }>(
    {
      task: 'classification',
      system: SYSTEM,
      prompt,
      schema: CLASSIFICATION_SCHEMA as unknown as Record<string, unknown>,
      inputRef: `prospect:${prospect.id}`,
    },
    (value) => {
      const parsed = value as { verdict?: unknown; confidence?: unknown; reasons?: unknown };
      const verdicts: NicheVerdict[] = ['in_niche', 'adjacent', 'out_of_niche', 'uncertain'];
      if (typeof parsed.verdict !== 'string' || !verdicts.includes(parsed.verdict as NicheVerdict)) {
        throw new Error(`invalid verdict: ${String(parsed.verdict)}`);
      }
      const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5;
      const reasons = Array.isArray(parsed.reasons) ? parsed.reasons.map(String) : [];
      return { verdict: parsed.verdict as NicheVerdict, confidence: Math.max(0, Math.min(1, confidence)), reasons };
    },
  );

  if (!outcome.ok || !outcome.data) return null;

  return {
    verdict: outcome.data.verdict,
    confidence: outcome.data.confidence,
    decidedBy: 'llm',
    reasons: outcome.data.reasons,
    evidenceRefs: evidence.slice(0, 40).map((e) => e.field),
    modelRunId: outcome.modelRunId,
  };
}
