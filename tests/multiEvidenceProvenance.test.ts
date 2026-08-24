import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { groundResearch, parseResearchAnswer, RESEARCH_SCHEMA } from '@/lib/pipeline/research';
import { groundAngle, parseAngleAnswer } from '@/lib/pipeline/angle';
import { checkGeneratedMessages, parseMessageAnswer } from '@/lib/pipeline/message';
import { groundWorker, parseWorkerAnswer, WORKER_SCHEMA } from '@/lib/pipeline/workers/workers';
import { mergeWorkerOutputs } from '@/lib/pipeline/workers/merge';
import { groundSynthesis } from '@/lib/pipeline/workers/synthesize';
import type { ResearchEvidence } from '@/lib/pipeline/research';
import type { WorkerOutput } from '@/lib/pipeline/workers/workers';
import type { CampaignConfig } from '@/lib/config/schema';

/**
 * R5.1b — le défaut que R5.1 avait mesuré sans le corriger.
 *
 * `evidence_id` typé chaîne poussait les modèles à empiler plusieurs
 * identifiants dans un seul champ ("id1, id2, id3", ou un identifiant suivi
 * d'une note) dès qu'une observation combinait légitimement deux faits.
 * Le rattachement cherchait alors la chaîne entière comme UN identifiant,
 * échouait, et jetait toute l'observation — 18 des 20 violations de provenance
 * mesurées sur la baseline R5 étaient de cette nature, pas des inventions.
 *
 * Le correctif : `evidence_ids: string[]`, résolu identifiant par identifiant.
 * Ces tests fixent la propriété qui compte — une observation combinant un
 * identifiant réel et un identifiant fabriqué ne doit plus être perdue en bloc,
 * et ne doit jamais faire passer l'identifiant fabriqué pour réel.
 */

function evidence(id: string, field: string, value = 'valeur'): ResearchEvidence {
  return {
    id,
    field,
    value_text: value,
    value_json: null,
    provider: 'website',
    source_url: `https://example.fr/${field}`,
    observed_at: '2026-08-10T00:00:00.000Z',
  };
}

describe('RESEARCH_SCHEMA — la forme du champ, pas seulement son nom', () => {
  it('déclare evidence_ids comme un tableau, jamais une chaîne', () => {
    const items = (
      RESEARCH_SCHEMA.properties.observations.items as unknown as {
        properties: Record<string, { type: string }>;
        required: string[];
      }
    ).properties;
    expect(items['evidence_ids']?.type).toBe('array');
    expect(items['evidence_id']).toBeUndefined();
  });

  it('exige au moins un identifiant, mais en autorise plusieurs', () => {
    const idsSchema = (
      RESEARCH_SCHEMA.properties.observations.items as unknown as {
        properties: Record<string, { type: string; minItems: number; maxItems: number }>;
      }
    ).properties['evidence_ids'];
    expect(idsSchema?.minItems).toBe(1);
    expect(idsSchema?.maxItems).toBeGreaterThan(1);
  });
});

describe('WORKER_SCHEMA — même correction pour les trois spécialistes', () => {
  it('déclare evidence_ids comme un tableau', () => {
    const items = (
      WORKER_SCHEMA.properties.facts.items as unknown as {
        properties: Record<string, { type: string }>;
      }
    ).properties;
    expect(items['evidence_ids']?.type).toBe('array');
    expect(items['evidence_id']).toBeUndefined();
  });
});

describe('parseResearchAnswer', () => {
  it('lit un tableau de plusieurs identifiants pour une seule observation', () => {
    const parsed = parseResearchAnswer({
      summary: 'ok',
      observations: [{ text: 'prix affichés et réservation en ligne', evidence_ids: ['e1', 'e2'] }],
      opportunities: [],
      unknowns: [],
      confidence: 0.9,
    });
    expect(parsed.observations[0]?.evidence_ids).toEqual(['e1', 'e2']);
  });

  it('tolère encore un modèle qui répond au singulier plutôt que planter', () => {
    // Pas le schéma qu'on envoie — mais un fournisseur imparfait ne doit pas
    // faire perdre un appel qui portait une observation réelle et sourcée.
    const parsed = parseResearchAnswer({
      summary: 'ok',
      observations: [{ text: 'CTA réserver', evidence_id: 'e1' }],
      opportunities: [],
      unknowns: [],
      confidence: 0.9,
    });
    expect(parsed.observations[0]?.evidence_ids).toEqual(['e1']);
  });
});

describe('groundResearch — la propriété centrale du correctif', () => {
  const pack = [evidence('e1', 'price_mentions'), evidence('e2', 'booking_system'), evidence('e3', 'cta')];

  it('garde tous les identifiants valides d’une observation qui combine plusieurs faits', () => {
    const research = groundResearch(
      {
        summary: 'S',
        observations: [{ text: 'prix affichés et réservation en ligne', evidence_ids: ['e1', 'e2'] }],
        opportunities: [],
        unknowns: [],
        confidence: 0.9,
      },
      pack,
      null,
    );
    expect(research.observations).toHaveLength(1);
    expect(research.observations[0]?.evidenceIds).toEqual(['e1', 'e2']);
    expect(research.droppedObservations).toHaveLength(0);
  });

  it("récupère l'observation quand elle mélange un identifiant réel et un identifiant fabriqué", () => {
    // C'est le scénario exact du défaut mesuré : avant le correctif, la chaîne
    // packée "e1, zz-invente" échouait à se résoudre et TOUTE l'observation
    // était jetée — y compris le fait réel qu'elle portait.
    const research = groundResearch(
      {
        summary: 'S',
        observations: [{ text: 'prix affichés', evidence_ids: ['e1', 'zz-invente'] }],
        opportunities: [],
        unknowns: [],
        confidence: 0.9,
      },
      pack,
      null,
    );
    expect(research.droppedObservations).toHaveLength(0);
    expect(research.observations).toHaveLength(1);
    // L'identifiant fabriqué n'est jamais gardé comme s'il était réel.
    expect(research.observations[0]?.evidenceIds).toEqual(['e1']);
  });

  it("jette l'observation seulement quand AUCUN identifiant cité n'existe", () => {
    const research = groundResearch(
      {
        summary: 'S',
        observations: [{ text: 'inventé', evidence_ids: ['zz1', 'zz2'] }],
        opportunities: [],
        unknowns: [],
        confidence: 0.9,
      },
      pack,
      null,
    );
    expect(research.observations).toHaveLength(0);
    expect(research.droppedObservations).toEqual(['inventé']);
  });

  it('reste correct pour le cas courant : un seul identifiant, valide', () => {
    const research = groundResearch(
      {
        summary: 'S',
        observations: [{ text: 'CTA réserver', evidence_ids: ['e3'] }],
        opportunities: [],
        unknowns: [],
        confidence: 0.9,
      },
      pack,
      null,
    );
    expect(research.observations[0]?.evidenceIds).toEqual(['e3']);
  });

  it('attribue la source affichée au premier identifiant valide', () => {
    const research = groundResearch(
      {
        summary: 'S',
        observations: [{ text: 'x', evidence_ids: ['zz-invente', 'e2'] }],
        opportunities: [],
        unknowns: [],
        confidence: 0.9,
      },
      pack,
      null,
    );
    expect(research.observations[0]?.sourceUrl).toBe('https://example.fr/booking_system');
  });
});

describe('groundWorker — même récupération pour les spécialistes', () => {
  const lane = [evidence('f1', 'cta'), evidence('f2', 'booking_system')];

  it('garde un fait citant deux identifiants valides de sa voie', () => {
    const { output, dropped } = groundWorker(
      'funnel',
      parseWorkerAnswer({
        summary: 'ok',
        uncertainties: [],
        facts: [{ claim: 'CTA + réservation', evidence_ids: ['f1', 'f2'], state: 'observed', confidence: 0.9 }],
      }),
      lane,
    );
    expect(output.facts[0]?.evidenceIds).toEqual(['f1', 'f2']);
    expect(dropped).toHaveLength(0);
  });

  it('récupère un fait mélangeant un identifiant réel et un identifiant hors voie', () => {
    const { output, dropped } = groundWorker(
      'funnel',
      parseWorkerAnswer({
        summary: 'ok',
        uncertainties: [],
        facts: [
          { claim: 'CTA réserver', evidence_ids: ['f1', 'o1-hors-voie'], state: 'observed', confidence: 0.9 },
        ],
      }),
      lane,
    );
    expect(dropped).toHaveLength(0);
    expect(output.facts[0]?.evidenceIds).toEqual(['f1']);
  });

  it('jette un fait dont aucun identifiant ne résout dans sa voie', () => {
    const { output, dropped } = groundWorker(
      'funnel',
      parseWorkerAnswer({
        summary: 'ok',
        uncertainties: [],
        facts: [{ claim: 'inventé', evidence_ids: ['o1', 'c1'], state: 'observed', confidence: 0.9 }],
      }),
      lane,
    );
    expect(output.facts).toHaveLength(0);
    expect(dropped).toEqual(['inventé']);
  });
});

describe('groundSynthesis — la synthèse hérite de la même règle', () => {
  const pack = [evidence('e1', 'cta'), evidence('e2', 'price_mentions')];
  const merged = mergeWorkerOutputs({
    outputs: [{ lane: 'funnel', facts: [], uncertainties: [], summary: 'ok' } as WorkerOutput],
    requested: ['funnel'],
    droppedFacts: [],
    residual: [],
    evidence: pack,
  });

  it("récupère une observation de synthèse qui combine un vrai et un faux identifiant", () => {
    const research = groundSynthesis(
      {
        summary: 'S',
        observations: [{ text: 'prix et CTA', evidence_ids: ['e1', 'e2', 'zz'] }],
        opportunities: [],
        unknowns: [],
        confidence: 0.85,
      },
      pack,
      merged,
      null,
    );
    expect(research.observations[0]?.evidenceIds).toEqual(['e1', 'e2']);
    expect(research.droppedObservations).toHaveLength(0);
  });
});

describe('mergeWorkerOutputs — dédoublonnage sur l’ensemble des identifiants', () => {
  const pack = [evidence('f1', 'cta'), evidence('f2', 'booking_system')];

  function output(facts: WorkerOutput['facts']): WorkerOutput {
    return { lane: 'funnel', facts, uncertainties: [], summary: 'ok' };
  }

  it("ne confond pas deux faits qui partagent un identifiant mais pas l'autre", () => {
    const merged = mergeWorkerOutputs({
      outputs: [
        output([
          { claim: 'CTA et réservation', evidenceIds: ['f1', 'f2'], state: 'observed', confidence: 0.9 },
          { claim: 'CTA seul', evidenceIds: ['f1'], state: 'observed', confidence: 0.8 },
        ]),
      ],
      requested: ['funnel'],
      droppedFacts: [],
      residual: [],
      evidence: pack,
    });
    // Deux faits distincts, deux ensembles d'identifiants distincts : les deux
    // doivent survivre — une clé fondée sur un seul identifiant les aurait
    // confondus.
    expect(merged.facts).toHaveLength(2);
  });

  it('déduplique deux voies qui citent exactement les mêmes identifiants pour la même affirmation', () => {
    const claim = 'CTA et réservation';
    const merged = mergeWorkerOutputs({
      outputs: [
        output([{ claim, evidenceIds: ['f1', 'f2'], state: 'observed', confidence: 0.9 }]),
        output([{ claim, evidenceIds: ['f2', 'f1'], state: 'observed', confidence: 0.9 }]),
      ],
      requested: ['funnel'],
      droppedFacts: [],
      residual: [],
      evidence: pack,
    });
    // Même ensemble d'identifiants (ordre différent) et même texte : un seul
    // fait doit survivre, l'ordre de citation ne doit pas créer un doublon.
    expect(merged.facts).toHaveLength(1);
  });
});

describe('en aval — angle et message voient tous les identifiants d’une observation multi-source', () => {
  const research = groundResearch(
    {
      summary: 'Synthèse',
      observations: [
        { text: 'prix affichés et réservation en ligne', evidence_ids: ['e1', 'e2'] },
      ],
      opportunities: [],
      unknowns: [],
      confidence: 0.9,
    },
    [evidence('e1', 'price_mentions'), evidence('e2', 'booking_system')],
    null,
  );

  it('groundAngle accepte une accroche citant le second identifiant d’une observation à deux sources', () => {
    const angle = groundAngle(
      parseAngleAnswer({
        pain_point: 'p',
        opportunity: 'o',
        approach: 'a',
        personalization: 'Vous proposez une réservation en ligne.',
        personalization_evidence_ids: ['e2'],
        use_case_study: false,
        confidence: 0.8,
      }),
      research,
      null,
      null,
    );
    expect(angle.personalizationEvidence).toEqual(['e2']);
    expect(angle.personalization).not.toBe('');
  });

  it('checkGeneratedMessages accepte used_evidence_ids citant un identifiant secondaire', () => {
    const campaign = {
      outreach: { channel: 'instagram_dm', maxChars: 650 },
    } as unknown as CampaignConfig;
    const angle = groundAngle(
      parseAngleAnswer({
        pain_point: 'p',
        opportunity: 'o',
        approach: 'a',
        personalization: 'Vous proposez une réservation en ligne.',
        personalization_evidence_ids: ['e2'],
        use_case_study: false,
        confidence: 0.8,
      }),
      research,
      null,
      null,
    );
    const result = checkGeneratedMessages(
      parseMessageAnswer({
        variant_a: {
          body: 'Bonjour, j’ai vu que vous proposiez une réservation en ligne. Est-ce que ça convertit bien ?',
          rationale: 'r',
          used_evidence_ids: ['e2'],
        },
        variant_b: null,
        chosen_variant: 'A',
        choice_reason: 'r',
      }),
      campaign,
      research,
      angle,
      null,
      null,
    );
    expect(result.messages[0]?.usedFacts).toEqual(['e2']);
  });
});

describe('la migration DB reste inutile', () => {
  it('prospect_research.observations est un jsonb sans contrainte de forme', () => {
    // La raison pour laquelle ce correctif ne nécessite aucune migration : la
    // colonne n'impose aucun schéma, donc renommer un champ TypeScript ne casse
    // rien côté Postgres. Les lignes historiques gardent `evidenceId` au
    // singulier, les nouvelles portent `evidenceIds` ; la lecture (dashboard,
    // bench-report) tolère les deux. Si une future migration ajoutait une
    // contrainte CHECK sur la forme de cette colonne, ce test échouerait et
    // rappellerait qu'il faudrait la mettre à jour pour le tableau.
    const migration = readFileSync(resolve(__dirname, '../db/migrations/0001_init.sql'), 'utf8');
    expect(migration).toMatch(/observations\s+jsonb\s+not\s+null\s+default\s+'\[\]'::jsonb/);
    expect(migration).not.toMatch(/observations[\s\S]{0,80}\bcheck\s*\(/i);
  });
});
