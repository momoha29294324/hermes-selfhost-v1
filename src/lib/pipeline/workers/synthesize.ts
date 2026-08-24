import { RESEARCH_SCHEMA, type ResearchEvidence, type ResearchResult } from '@/lib/pipeline/research';
import type { MergedEvidence } from '@/lib/pipeline/workers/merge';
import type { ProspectRow } from '@/lib/repo/types';
import type { ScoreResult } from '@/lib/pipeline/score';

/**
 * The research synthesizer.
 *
 * ---------------------------------------------------------------------------
 * What it may not do (§14)
 * ---------------------------------------------------------------------------
 * It does not browse, it does not re-query a search provider, it does not re-read
 * the site. It sees the merged facts and the residual evidence, and that is all.
 * The restriction is structural rather than instructed: nothing in this call
 * carries the raw page text, so the temptation does not exist.
 *
 * ---------------------------------------------------------------------------
 * Why its output is deliberately shaped like the monolith's
 * ---------------------------------------------------------------------------
 * The same `RESEARCH_SCHEMA`, the same grounding rule, the same fields. That is
 * what makes the architecture comparison honest: angle and message downstream
 * cannot tell which architecture produced the sheet, so any difference the
 * benchmark measures at the message stage comes from the sheet's content and not
 * from the shape it arrived in.
 *
 * It also keeps the rollback cheap. Switching architectures changes which
 * function fills `ResearchResult`, and nothing else in the pipeline.
 */
export function buildSynthesizerRequest(
  prospect: ProspectRow,
  merged: MergedEvidence,
  score: ScoreResult,
): { system: string; prompt: string; schema: Record<string, unknown> } {
  const factLines = merged.facts.map(
    (fact) =>
      `[${fact.evidenceIds.join(', ')}] ${fact.claim}${fact.state === 'not_observed' ? ' (NON OBSERVÉ)' : ''}`,
  );

  // The residual pack is small by construction — fields no specialist owns — so
  // it is passed verbatim rather than summarised. Summarising it would be a
  // second place where a fact can change wording without a source.
  const residualLines = merged.residual
    .filter((item) => item.value_text || item.value_json)
    .slice(0, 12)
    .map((item) => {
      const value = item.value_text ?? JSON.stringify(item.value_json);
      const truncated = value.length > 200 ? `${value.slice(0, 200)}…` : value;
      return `[${item.id}] ${item.field} = ${truncated}  (source: ${item.provider})`;
    });

  const missing = score.missingSignals.length > 0 ? score.missingSignals.join(', ') : 'aucun';

  const system = `Tu es analyste avant-vente pour une agence d'acquisition (Hermes).
Trois analystes spécialisés ont lu chacun une partie des données publiques d'une entreprise.
Tu reçois leurs constats vérifiés. Tu produis la fiche interne de synthèse.

Règles absolues :
- tu ne disposes d'AUCUNE autre source : pas de navigation, pas de recherche, pas de relecture du site ;
- chaque observation DOIT reprendre un ou plusieurs constats fournis et citer leurs identifiants
  dans evidence_ids (un tableau — jamais une chaîne du type "id1, id2") ;
- un constat marqué NON OBSERVÉ signifie « nous n'avons pas vu », jamais « cela n'existe pas » :
  il va dans "unknowns", formulé comme une inconnue ;
- interdiction formelle d'affirmer l'absence de quelque chose que nous n'avons pas vérifié ;
- les opportunités sont des hypothèses de travail, formulées avec prudence ;
- pas de chiffre inventé, pas de superlatif, pas de jugement gratuit ;
- réponds uniquement en JSON conforme au schéma.`;

  const prompt = `ENTREPRISE
- nom : ${prospect.display_name}
- raison sociale : ${prospect.legal_name ?? 'inconnue'}
- ville : ${prospect.city ?? 'inconnue'}${prospect.postal_code ? ` (${prospect.postal_code})` : ''}
- site : ${prospect.website_url ?? 'aucun site connu'}
- Instagram : ${prospect.instagram_handle ? `@${prospect.instagram_handle}` : 'inconnu'}
- classification : ${prospect.niche_verdict ?? 'inconnue'} (confiance ${prospect.niche_confidence ?? '?'})
- score interne : ${score.total}/100 (bande ${score.band}, couverture des signaux ${Math.round(score.coverage * 100)}%)

CONSTATS VÉRIFIÉS DES ANALYSTES (seule base autorisée)
${factLines.join('\n') || '- aucun constat'}

SYNTHÈSES DE CHAQUE ANALYSTE
${merged.laneSummaries.map((entry) => `- ${entry.lane} : ${entry.summary}`).join('\n') || '- aucune'}

POINTS D'INCERTITUDE REMONTÉS
${merged.uncertainties.map((item) => `- ${item}`).join('\n') || '- aucun'}
${
  merged.missingLanes.length > 0
    ? `\nANALYSTES INDISPONIBLES : ${merged.missingLanes.join(', ')}\nCe domaine n'a pas été examiné. Ne conclus rien à son sujet ; place-le dans "unknowns".`
    : ''
}${residualLines.length > 0 ? `\n\nAUTRES FAITS BRUTS\n${residualLines.join('\n')}` : ''}

SIGNAUX NON OBSERVÉS (ne rien affirmer à leur sujet) : ${missing}

Produis la fiche interne.`;

  return { system, prompt, schema: RESEARCH_SCHEMA as unknown as Record<string, unknown> };
}

/**
 * Grounds a synthesized sheet.
 *
 * Checked against the full evidence pack rather than against the merged facts:
 * the residual rows are legitimate citations too, and holding the synthesizer to
 * the merge alone would drop observations that are perfectly sourced.
 *
 * Per-id grounding, same rule as `groundResearch`: an observation keeps only the
 * ids that resolve, and survives as long as at least one does.
 */
export function groundSynthesis(
  data: {
    summary: string;
    observations: { text: string; evidence_ids: string[] }[];
    opportunities: string[];
    unknowns: string[];
    confidence: number;
  },
  evidence: readonly ResearchEvidence[],
  merged: MergedEvidence,
  modelRunId: string | null,
): ResearchResult {
  const byId = new Map(evidence.map((item) => [item.id, item]));
  const observations: ResearchResult['observations'] = [];
  const dropped: string[] = [];

  for (const observation of data.observations) {
    const validIds = observation.evidence_ids.filter((id) => byId.has(id));
    if (validIds.length === 0 || !observation.text.trim()) {
      dropped.push(observation.text || observation.evidence_ids.join(', '));
      continue;
    }
    const primary = byId.get(validIds[0] as string);
    observations.push({
      text: observation.text.trim(),
      evidenceIds: validIds,
      sourceUrl: primary?.source_url ?? null,
      provider: primary?.provider ?? '',
    });
  }

  // A lane that never ran is an unknown of the sheet, whatever the model wrote.
  // Adding it here rather than trusting the prompt is what keeps a degraded
  // fan-out from reading as a confident, complete picture.
  const unknowns = [...data.unknowns];
  for (const lane of merged.missingLanes) {
    unknowns.push(`domaine « ${lane} » non examiné : analyste indisponible sur ce run`);
  }

  return {
    summary: data.summary.trim(),
    observations,
    opportunities: data.opportunities,
    unknowns,
    confidence: Math.max(0, Math.min(1, data.confidence)),
    droppedObservations: dropped,
    modelRunId,
  };
}
