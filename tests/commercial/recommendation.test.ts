import { describe, expect, it } from 'vitest';
import { recommendOutreach, type RecommendationInput } from '@/lib/pipeline/recommendation';

/**
 * L'avis du système (§19), et son asymétrie voulue.
 *
 * Dans une revue, le coût d'un faux « à corriger » est une minute perdue ;
 * celui d'un faux « prêt à partir » est un message qui parle du site de
 * quelqu'un d'autre. `send` est donc le seul verdict conjonctif : tout doit
 * être réuni.
 */

function input(overrides: {
  prospect?: Partial<RecommendationInput['prospect']>;
  message?: Partial<RecommendationInput['message']>;
} = {}): RecommendationInput {
  return {
    prospect: {
      niche_verdict: 'in_niche',
      contactable: true,
      funnel_observable: true,
      identity_review: 'confirmed',
      dedupe_status: 'unique',
      score: 78,
      ...overrides.prospect,
    },
    message: {
      exists: true,
      blocked: false,
      personalizationLevel: 'high',
      ...overrides.message,
    },
  };
}

describe('SEND', () => {
  it('exige que tout soit réuni', () => {
    const result = recommendOutreach(input());
    expect(result.recommendation).toBe('send');
    expect(result.reasons).toHaveLength(5);
  });
});

describe('REJECT — sur des faits durs', () => {
  it('écarte un métier non confirmé', () => {
    expect(recommendOutreach(input({ prospect: { niche_verdict: 'adjacent' } })).recommendation).toBe('reject');
    expect(recommendOutreach(input({ prospect: { niche_verdict: null } })).recommendation).toBe('reject');
  });

  it('écarte un prospect injoignable', () => {
    expect(recommendOutreach(input({ prospect: { contactable: false } })).recommendation).toBe('reject');
    expect(recommendOutreach(input({ prospect: { contactable: null } })).recommendation).toBe('reject');
  });

  /**
   * Une identité non tranchée est un refus franc et non un doute : nous ne
   * savons pas à qui nous écririons.
   */
  it('écarte une identité non tranchée', () => {
    const result = recommendOutreach(input({ prospect: { identity_review: 'uncertain' } }));
    expect(result.recommendation).toBe('reject');
    expect(result.reason).toContain('identité');
  });

  it('écarte un message qui a déclenché un garde-fou bloquant', () => {
    expect(recommendOutreach(input({ message: { blocked: true } })).recommendation).toBe('reject');
  });

  it('énumère tous les motifs, pour que l’avis soit contestable point par point', () => {
    const result = recommendOutreach(
      input({ prospect: { niche_verdict: 'out_of_niche', contactable: false } }),
    );
    expect(result.reasons.length).toBeGreaterThanOrEqual(2);
  });
});

describe('EDIT — le verdict du doute', () => {
  it('demande une correction quand le parcours n’a pas été lu', () => {
    const result = recommendOutreach(input({ prospect: { funnel_observable: false } }));
    expect(result.recommendation).toBe('edit');
    expect(result.reason).toContain('parcours');
  });

  it('demande une correction quand l’identité doit être confirmée par un humain', () => {
    expect(recommendOutreach(input({ prospect: { identity_review: 'manual_review' } })).recommendation).toBe(
      'edit',
    );
  });

  it('demande une correction quand un doublon reste à arbitrer', () => {
    expect(recommendOutreach(input({ prospect: { dedupe_status: 'needs_review' } })).recommendation).toBe('edit');
  });

  it('demande une correction quand le message ne cite presque rien d’observé', () => {
    expect(recommendOutreach(input({ message: { personalizationLevel: 'low' } })).recommendation).toBe('edit');
    expect(recommendOutreach(input({ message: { personalizationLevel: 'none' } })).recommendation).toBe('edit');
  });

  it('demande une correction quand aucun message n’a été rédigé', () => {
    const result = recommendOutreach(input({ message: { exists: false, personalizationLevel: null } }));
    expect(result.recommendation).toBe('edit');
  });
});

describe('la recommandation n’est qu’un avis', () => {
  /**
   * Le type lui-même le dit : trois valeurs, aucune n'est un verbe d'action et
   * aucune n'ouvre un chemin. « send » veut dire « un humain qui enverrait
   * cela ne commettrait pas d'erreur détectable », pas « envoyé ».
   */
  it('ne rend que send, edit ou reject', () => {
    const verdicts = new Set(
      [
        recommendOutreach(input()),
        recommendOutreach(input({ prospect: { funnel_observable: false } })),
        recommendOutreach(input({ prospect: { contactable: false } })),
      ].map((result) => result.recommendation),
    );
    expect([...verdicts].every((verdict) => ['send', 'edit', 'reject'].includes(verdict))).toBe(true);
  });
});
