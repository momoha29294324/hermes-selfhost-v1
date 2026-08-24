import { describe, expect, it } from 'vitest';
import { ModelRouter } from '@/lib/models/router';
import { createLogger } from '@/lib/logging/logger';
import { LlmError, type LlmProvider, type LlmRequest } from '@/lib/models/types';
import { researchWithWorkers } from '@/lib/pipeline/workers';
import type { ModelRoutingConfig } from '@/lib/config/schema';
import type { ResearchEvidence } from '@/lib/pipeline/research';
import type { ProspectRow } from '@/lib/repo/types';
import type { ScoreResult } from '@/lib/pipeline/score';

const logger = createLogger({ test: 'worker-research' });

const routing: ModelRoutingConfig = {
  version: 'test',
  declaredEfforts: ['medium'],
  defaultRoute: { provider: 'codex', model: 'm', effort: 'medium', timeoutMs: 1000, maxAttempts: 1 },
  tasks: {},
};

const prospect = {
  id: 'p1',
  display_name: 'Atelier Test',
  legal_name: null,
  city: 'Lyon',
  postal_code: null,
  website_url: 'https://example.fr',
  instagram_handle: null,
  niche_verdict: 'in_niche',
  niche_confidence: 0.9,
} as ProspectRow;

const score: ScoreResult = {
  total: 70,
  band: 'B',
  signals: [],
  missingSignals: [],
  coverage: 0.8,
  coverageCapped: false,
  llmPoints: 0,
  llmObservations: [],
  weights: {},
};

const evidence: ResearchEvidence[] = [
  {
    id: 'f1',
    field: 'cta',
    value_text: 'Réserver en ligne',
    value_json: null,
    provider: 'website',
    source_url: 'https://example.fr',
    observed_at: '2026-08-10T00:00:00.000Z',
  },
  {
    id: 'o1',
    field: 'premium_services',
    value_text: 'traitement boutique en ligne',
    value_json: null,
    provider: 'website',
    source_url: 'https://example.fr',
    observed_at: '2026-08-10T00:00:00.000Z',
  },
  {
    id: 'c1',
    field: 'phone',
    value_text: '0472000000',
    value_json: null,
    provider: 'website',
    source_url: 'https://example.fr',
    observed_at: '2026-08-10T00:00:00.000Z',
  },
];

/** A provider that answers per task, so a single lane can be made to fail. */
function scripted(behaviour: Record<string, 'ok' | 'fail'>): LlmProvider {
  return {
    name: 'codex',
    availability: () => ({ ok: true }),
    generate: async (request: LlmRequest) => {
      if (behaviour[request.task] === 'fail') {
        throw new LlmError('codex exec timed out after 1000ms', 'timeout');
      }
      if (request.task === 'synthesize') {
        return {
          text: JSON.stringify({
            summary: 'Une entreprise de atelier avec réservation en ligne.',
            observations: [{ text: 'Réservation en ligne proposée', evidence_ids: ['f1'] }],
            opportunities: ['Mieux qualifier les demandes premium'],
            unknowns: [],
            confidence: 0.85,
          }),
        };
      }
      // Each lane cites the evidence id it legitimately received.
      const id = request.task === 'worker_funnel' ? 'f1' : request.task === 'worker_offer' ? 'o1' : 'c1';
      return {
        text: JSON.stringify({
          summary: `résumé ${request.task}`,
          uncertainties: [],
          facts: [{ claim: `constat ${request.task}`, evidence_ids: [id], state: 'observed', confidence: 0.9 }],
        }),
      };
    },
  };
}

function routerWith(behaviour: Record<string, 'ok' | 'fail'>): ModelRouter {
  return new ModelRouter({ sql: null, logger, routing, providers: { codex: scripted(behaviour) } });
}

/**
 * §24 : panne partielle d'un worker, repli, agrégateur.
 *
 * C'est le comportement qui distingue l'architecture B du monolithe R5. Sous le
 * monolithe, un appel expiré ne produit rien et le prospect est perdu — c'est
 * exactement ce qui a coûté deux prospects en R5.
 */
describe('researchWithWorkers', () => {
  it('produces a sheet from three healthy lanes', async () => {
    const research = await researchWithWorkers(routerWith({}), prospect, evidence, score, logger);
    expect(research).not.toBeNull();
    expect(research?.workerStats.lanesRun).toBe(3);
    expect(research?.workerStats.lanesFailed).toEqual([]);
    expect(research?.observations).toHaveLength(1);
  });

  it('keeps the prospect when one lane dies, and says which one', async () => {
    const research = await researchWithWorkers(
      routerWith({ worker_funnel: 'fail' }),
      prospect,
      evidence,
      score,
      logger,
    );

    expect(research).not.toBeNull();
    expect(research?.workerStats.lanesFailed).toEqual(['funnel']);
    // The missing specialist becomes an unknown of the sheet, whatever the model
    // wrote — a degraded fan-out must not read as a complete picture.
    expect(research?.unknowns.join(' ')).toContain('funnel');
  });

  it('still produces a sheet when two lanes die', async () => {
    const research = await researchWithWorkers(
      routerWith({ worker_funnel: 'fail', worker_offer: 'fail' }),
      prospect,
      evidence,
      score,
      logger,
    );
    expect(research).not.toBeNull();
    expect(research?.workerStats.lanesRun).toBe(1);
  });

  it('returns nothing when every lane dies, rather than a confident sheet about nothing', async () => {
    const research = await researchWithWorkers(
      routerWith({ worker_funnel: 'fail', worker_offer: 'fail', worker_contact: 'fail' }),
      prospect,
      evidence,
      score,
      logger,
    );
    expect(research).toBeNull();
  });

  it('returns nothing when the synthesizer itself fails', async () => {
    const research = await researchWithWorkers(
      routerWith({ synthesize: 'fail' }),
      prospect,
      evidence,
      score,
      logger,
    );
    expect(research).toBeNull();
  });

  it('runs the three lanes concurrently, not one after another', async () => {
    // The whole point of splitting: the prospect's wall-clock is the slowest
    // lane, not the sum of three.
    let active = 0;
    let peak = 0;
    const router = new ModelRouter({
      sql: null,
      logger,
      routing,
      providers: {
        codex: {
          name: 'codex',
          availability: () => ({ ok: true }),
          generate: async (request: LlmRequest) => {
            if (request.task.startsWith('worker_')) {
              active += 1;
              peak = Math.max(peak, active);
              await new Promise((r) => setTimeout(r, 20));
              active -= 1;
            }
            return scripted({}).generate(request, routing.defaultRoute);
          },
        },
      },
    });

    await researchWithWorkers(router, prospect, evidence, score, logger);
    expect(peak).toBe(3);
  });

  it('produces the same shape as the monolith, which is what makes rollback free', async () => {
    const research = await researchWithWorkers(routerWith({}), prospect, evidence, score, logger);
    expect(research).toMatchObject({
      summary: expect.any(String),
      observations: expect.any(Array),
      opportunities: expect.any(Array),
      unknowns: expect.any(Array),
      confidence: expect.any(Number),
      droppedObservations: expect.any(Array),
    });
  });
});
