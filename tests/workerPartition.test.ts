import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { partitionEvidence, fieldsFor, knownFields } from '@/lib/pipeline/workers/partition';
import { mergeWorkerOutputs } from '@/lib/pipeline/workers/merge';
import { buildWorkerRequest, groundWorker, parseWorkerAnswer } from '@/lib/pipeline/workers/workers';
import { buildSynthesizerRequest, groundSynthesis } from '@/lib/pipeline/workers/synthesize';
import { buildResearchRequest } from '@/lib/pipeline/research';
import type { ResearchEvidence } from '@/lib/pipeline/research';
import type { WorkerOutput } from '@/lib/pipeline/workers/workers';
import type { ProspectRow } from '@/lib/repo/types';
import type { ScoreResult } from '@/lib/pipeline/score';

function evidence(id: string, field: string, value = 'valeur'): ResearchEvidence {
  return {
    id,
    field,
    value_text: value,
    value_json: null,
    provider: 'website',
    source_url: 'https://example.fr',
    observed_at: '2026-08-10T00:00:00.000Z',
  };
}

const prospect = {
  display_name: 'Atelier Test',
  city: 'Lyon',
  website_url: 'https://example.fr',
} as Pick<ProspectRow, 'display_name' | 'city' | 'website_url'>;

describe('partitionEvidence', () => {
  it('sends every row to exactly one lane', () => {
    const pack = [
      evidence('a', 'cta'),
      evidence('b', 'services'),
      evidence('c', 'phone'),
      evidence('d', 'un_champ_inconnu'),
    ];
    const partition = partitionEvidence(pack);

    const all = [...partition.funnel, ...partition.offer, ...partition.contact, ...partition.residual];
    expect(all).toHaveLength(pack.length);
    expect(new Set(all.map((item) => item.id)).size).toBe(pack.length);
  });

  it('never loses a field it has not been taught about', () => {
    // A new extractor shipping a new field must degrade to "the specialist did
    // not see it", never to "nobody did".
    const partition = partitionEvidence([evidence('x', 'champ_futur')]);
    expect(partition.residual.map((item) => item.id)).toEqual(['x']);
  });

  it('keeps the lanes disjoint', () => {
    const lanes = [fieldsFor('funnel'), fieldsFor('offer'), fieldsFor('contact')];
    const seen = new Set<string>();
    for (const lane of lanes) {
      for (const field of lane) {
        expect(seen.has(field)).toBe(false);
        seen.add(field);
      }
    }
    expect(seen.size).toBe(knownFields().length);
  });

  it('covers the fields the real R5 corpus actually contains', () => {
    // A partition that is total in theory and misses the corpus in practice
    // would push everything into `residual` and quietly rebuild the monolith.
    const path = resolve(process.cwd(), 'var/benchmarks/r51/corpus.json');
    if (!existsSync(path)) return;

    const corpus = JSON.parse(readFileSync(path, 'utf8')) as {
      prospects: { evidence: ResearchEvidence[] }[];
    };
    const all = corpus.prospects.flatMap((entry) => entry.evidence);
    const partition = partitionEvidence(all);
    const residualShare = partition.residual.length / all.length;

    expect(all.length).toBeGreaterThan(100);
    expect(residualShare).toBeLessThan(0.05);
    expect(partition.funnel.length).toBeGreaterThan(0);
    expect(partition.offer.length).toBeGreaterThan(0);
    expect(partition.contact.length).toBeGreaterThan(0);
  });

  it('gives each worker less context than the monolith receives', () => {
    // §12 exists to reduce context per call. If a lane prompt were not smaller
    // than the monolithic one, the architecture would cost more for nothing.
    const path = resolve(process.cwd(), 'var/benchmarks/r51/corpus.json');
    if (!existsSync(path)) return;
    const corpus = JSON.parse(readFileSync(path, 'utf8')) as {
      prospects: { prospect: ProspectRow; evidence: ResearchEvidence[]; score: ScoreResult }[];
    };
    const entry = corpus.prospects[0];
    if (!entry) return;

    const partition = partitionEvidence(entry.evidence);
    const mono = buildResearchRequest(entry.prospect, entry.evidence, entry.score);
    const monoChars = mono.system.length + mono.prompt.length;

    for (const lane of ['funnel', 'offer', 'contact'] as const) {
      const request = buildWorkerRequest(lane, entry.prospect, partition[lane]);
      expect(request.system.length + request.prompt.length).toBeLessThan(monoChars);
    }
  });
});

describe('buildWorkerRequest', () => {
  it('shows a lane only its own facts', () => {
    const pack = [evidence('f1', 'cta', 'Réserver'), evidence('o1', 'services', 'boutique en ligne')];
    const partition = partitionEvidence(pack);
    const request = buildWorkerRequest('funnel', prospect, partition.funnel);

    expect(request.prompt).toContain('[f1]');
    expect(request.prompt).not.toContain('[o1]');
  });

  it('says so plainly when a lane has nothing to read', () => {
    const request = buildWorkerRequest('funnel', prospect, []);
    expect(request.prompt).toContain('aucun fait disponible');
  });

  it('offers no way to assert an absence', () => {
    // The schema has two states and no "absent": a worker cannot distinguish a
    // site without booking from a page we did not read, so it may not claim to.
    const request = buildWorkerRequest('funnel', prospect, []);
    const states = (request.schema as { properties: Record<string, unknown> }).properties;
    expect(JSON.stringify(states)).toContain('not_observed');
    expect(JSON.stringify(states)).not.toContain('"absent"');
  });
});

describe('groundWorker', () => {
  const lane = [evidence('f1', 'cta')];

  it('drops a fact citing evidence its worker never received', () => {
    const { output, dropped } = groundWorker(
      'funnel',
      parseWorkerAnswer({
        summary: 'ok',
        uncertainties: [],
        facts: [
          { claim: 'CTA réserver', evidence_ids: ['f1'], state: 'observed', confidence: 0.9 },
          { claim: 'ils vendent de la boutique en ligne', evidence_ids: ['o1'], state: 'observed', confidence: 0.9 },
        ],
      }),
      lane,
    );

    expect(output.facts.map((fact) => fact.evidenceIds)).toEqual([['f1']]);
    expect(dropped).toEqual(['ils vendent de la boutique en ligne']);
  });

  it('forces an unknown state to not_observed rather than trusting it', () => {
    const { output } = groundWorker(
      'funnel',
      parseWorkerAnswer({
        summary: 'ok',
        uncertainties: [],
        facts: [{ claim: 'x', evidence_ids: ['f1'], state: 'absent', confidence: 1 }],
      }),
      lane,
    );
    expect(output.facts[0]?.state).toBe('not_observed');
  });
});

describe('mergeWorkerOutputs', () => {
  const pack = [evidence('f1', 'cta'), evidence('o1', 'services'), evidence('c1', 'phone')];

  function output(lane: WorkerOutput['lane'], facts: WorkerOutput['facts']): WorkerOutput {
    return { lane, facts, uncertainties: [], summary: `résumé ${lane}` };
  }

  it('keeps every grounded fact from every lane', () => {
    const merged = mergeWorkerOutputs({
      outputs: [
        output('funnel', [{ claim: 'CTA', evidenceIds: ['f1'], state: 'observed', confidence: 0.9 }]),
        output('offer', [{ claim: 'boutique en ligne', evidenceIds: ['o1'], state: 'observed', confidence: 0.8 }]),
        output('contact', [{ claim: 'tél', evidenceIds: ['c1'], state: 'observed', confidence: 1 }]),
      ],
      requested: ['funnel', 'offer', 'contact'],
      droppedFacts: [],
      residual: [],
      evidence: pack,
    });

    expect(merged.facts).toHaveLength(3);
    expect(merged.missingLanes).toEqual([]);
  });

  it('names the lane that failed instead of silently shrinking the sheet', () => {
    const merged = mergeWorkerOutputs({
      outputs: [
        null,
        output('offer', [{ claim: 'boutique en ligne', evidenceIds: ['o1'], state: 'observed', confidence: 0.8 }]),
        output('contact', []),
      ],
      requested: ['funnel', 'offer', 'contact'],
      droppedFacts: [],
      residual: [],
      evidence: pack,
    });

    expect(merged.missingLanes).toEqual(['funnel']);
    expect(merged.facts).toHaveLength(1);
  });

  it('invents nothing: an unknown evidence id is dropped, not repaired', () => {
    const merged = mergeWorkerOutputs({
      outputs: [output('funnel', [{ claim: 'inventé', evidenceIds: ['zz'], state: 'observed', confidence: 1 }])],
      requested: ['funnel'],
      droppedFacts: [],
      residual: [],
      evidence: pack,
    });

    expect(merged.facts).toHaveLength(0);
    expect(merged.droppedFacts).toEqual(['inventé']);
  });

  it('puts observed facts before unobserved ones', () => {
    const merged = mergeWorkerOutputs({
      outputs: [
        output('funnel', [
          { claim: 'pas vu', evidenceIds: ['f1'], state: 'not_observed', confidence: 0.9 },
          { claim: 'vu', evidenceIds: ['o1'], state: 'observed', confidence: 0.4 },
        ]),
      ],
      requested: ['funnel'],
      droppedFacts: [],
      residual: [],
      evidence: pack,
    });
    expect(merged.facts[0]?.state).toBe('observed');
  });

  it('carries the residual evidence through rather than dropping it', () => {
    const extra = evidence('r1', 'champ_inconnu');
    const merged = mergeWorkerOutputs({
      outputs: [output('funnel', [])],
      requested: ['funnel'],
      droppedFacts: [],
      residual: [extra],
      evidence: [...pack, extra],
    });
    expect(merged.residual.map((item) => item.id)).toEqual(['r1']);
  });
});

describe('synthesizer', () => {
  const pack = [evidence('f1', 'cta'), evidence('r1', 'champ_inconnu')];
  const score: ScoreResult = {
    total: 70,
    band: 'B',
    signals: [],
    missingSignals: ['ads_activity'],
    coverage: 0.8,
    coverageCapped: false,
    llmPoints: 0,
    llmObservations: [],
    weights: {},
  };
  const fullProspect = {
    display_name: 'Atelier Test',
    legal_name: null,
    city: 'Lyon',
    postal_code: null,
    website_url: 'https://example.fr',
    instagram_handle: null,
    niche_verdict: 'in_niche',
    niche_confidence: 0.9,
  } as ProspectRow;

  it('is given no raw page text — it cannot re-read the site', () => {
    const merged = mergeWorkerOutputs({
      outputs: [{ lane: 'funnel', facts: [], uncertainties: [], summary: 'rien' }],
      requested: ['funnel'],
      droppedFacts: [],
      residual: [],
      evidence: pack,
    });
    const request = buildSynthesizerRequest(fullProspect, merged, score);
    expect(request.system).toContain('AUCUNE autre source');
    expect(request.prompt).not.toContain('website_headings');
  });

  it('tells the synthesizer which specialist is missing', () => {
    const merged = mergeWorkerOutputs({
      outputs: [null, null, { lane: 'contact', facts: [], uncertainties: [], summary: 'ok' }],
      requested: ['funnel', 'offer', 'contact'],
      droppedFacts: [],
      residual: [],
      evidence: pack,
    });
    const request = buildSynthesizerRequest(fullProspect, merged, score);
    expect(request.prompt).toContain('ANALYSTES INDISPONIBLES');
    expect(request.prompt).toContain('funnel');
  });

  it('turns a missing lane into an unknown, whatever the model wrote', () => {
    const merged = mergeWorkerOutputs({
      outputs: [null, { lane: 'offer', facts: [], uncertainties: [], summary: 'ok' }, null],
      requested: ['funnel', 'offer', 'contact'],
      droppedFacts: [],
      residual: [],
      evidence: pack,
    });
    const research = groundSynthesis(
      { summary: 'S', observations: [], opportunities: [], unknowns: [], confidence: 0.9 },
      pack,
      merged,
      null,
    );
    expect(research.unknowns.join(' ')).toContain('funnel');
    expect(research.unknowns.join(' ')).toContain('contact');
  });

  it('accepts a citation of residual evidence no worker owned', () => {
    const merged = mergeWorkerOutputs({
      outputs: [{ lane: 'funnel', facts: [], uncertainties: [], summary: 'ok' }],
      requested: ['funnel'],
      droppedFacts: [],
      residual: [evidence('r1', 'champ_inconnu')],
      evidence: pack,
    });
    const research = groundSynthesis(
      {
        summary: 'S',
        observations: [{ text: 'un fait résiduel', evidence_ids: ['r1'] }],
        opportunities: [],
        unknowns: [],
        confidence: 0.8,
      },
      pack,
      merged,
      null,
    );
    expect(research.observations).toHaveLength(1);
    expect(research.droppedObservations).toHaveLength(0);
  });

  it('drops an observation citing an id that exists nowhere', () => {
    const merged = mergeWorkerOutputs({
      outputs: [{ lane: 'funnel', facts: [], uncertainties: [], summary: 'ok' }],
      requested: ['funnel'],
      droppedFacts: [],
      residual: [],
      evidence: pack,
    });
    const research = groundSynthesis(
      {
        summary: 'S',
        observations: [{ text: 'inventé', evidence_ids: ['nope'] }],
        opportunities: [],
        unknowns: [],
        confidence: 0.8,
      },
      pack,
      merged,
      null,
    );
    expect(research.observations).toHaveLength(0);
    expect(research.droppedObservations).toEqual(['inventé']);
  });
});
