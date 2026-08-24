import { describe, expect, it } from 'vitest';
import {
  classifyVisualMaturity,
  describeInstagramGap,
  VISUAL_MATURITY_LEVELS,
  type InstagramObservations,
} from '@/lib/pipeline/instagramMaturity';

/**
 * R7.2 §11–§12 — une spécification calibrable, pas un devin.
 *
 * Ce module ne collecte rien : aucun rail ne remplit encore ses observations.
 * Ce que les tests figent, c'est donc son COMPORTEMENT PAR DÉFAUT — rendre
 * `UNKNOWN` et nommer ce qui manque — et l'interdiction qui compte le plus :
 * le nombre d'abonnés ne décide de rien.
 */

const COMPLETE: InstagramObservations = {
  postCount: 889,
  lastPostAt: new Date('2026-08-10T00:00:00Z'),
  postsPerMonth: 12,
  profileCompleteness: 0.9,
  bioHasCta: true,
  highlightCount: 6,
  visualConsistency: 0.85,
};

describe('sans collecte, la réponse est UNKNOWN', () => {
  it('aucune observation → UNKNOWN, confiance NONE, aucune preuve inventée', () => {
    const assessment = classifyVisualMaturity();
    expect(assessment.level).toBe('UNKNOWN');
    expect(assessment.confidence).toBe('NONE');
    expect(assessment.evidence).toEqual([]);
  });

  it('la liste de ce qui manque est la liste de courses de R7.3', () => {
    const assessment = classifyVisualMaturity();
    expect(assessment.missing).toContain('post_count');
    expect(assessment.missing).toContain('last_post_at');
    expect(assessment.missing).toContain('posting_cadence');
    expect(assessment.missing).toContain('visual_consistency');
  });

  it('un comptage manquant bloque le verdict, même quand tout le reste est là', () => {
    const { postCount: _omitted, ...partial } = COMPLETE;
    expect(classifyVisualMaturity(partial).level).toBe('UNKNOWN');
  });

  it('« jamais collecté » se dit, il ne se devine pas', () => {
    expect(describeInstagramGap(classifyVisualMaturity())).toContain('jamais collecté');
  });
});

describe('le nombre d’abonnés ne décide de rien', () => {
  it('un compte à 200 000 abonnés sans publication reste AMATEUR', () => {
    const assessment = classifyVisualMaturity({
      ...COMPLETE,
      postCount: 3,
      postsPerMonth: 0,
      followerCount: 200_000,
    });
    expect(assessment.level).toBe('AMATEUR');
  });

  it('le nombre d’abonnés ne change aucun verdict, à observations égales', () => {
    const without = classifyVisualMaturity(COMPLETE);
    const with100k = classifyVisualMaturity({ ...COMPLETE, followerCount: 100_000 });
    const with12 = classifyVisualMaturity({ ...COMPLETE, followerCount: 12 });
    expect(with100k).toEqual(without);
    expect(with12).toEqual(without);
  });

  it('il n’apparaît dans aucune preuve publiée', () => {
    const assessment = classifyVisualMaturity({ ...COMPLETE, followerCount: 2278 });
    expect(assessment.evidence.join(' ')).not.toContain('2278');
    expect(assessment.evidence.join(' ').toLowerCase()).not.toContain('abonné');
  });
});

describe('le vocabulaire est fermé et ordonné', () => {
  it('six valeurs, UNKNOWN comprise', () => {
    expect([...VISUAL_MATURITY_LEVELS]).toEqual([
      'AMATEUR',
      'BASIC',
      'CONSISTENT',
      'PROFESSIONAL',
      'HIGHLY_MATURE',
      'UNKNOWN',
    ]);
  });

  it('un compte très travaillé atteint le haut du vocabulaire', () => {
    const assessment = classifyVisualMaturity(COMPLETE);
    expect(assessment.level).toBe('HIGHLY_MATURE');
    expect(assessment.confidence).toBe('HIGH');
    expect(assessment.evidence.length).toBeGreaterThan(0);
  });

  it('un compte régulier mais modeste se range au milieu', () => {
    expect(classifyVisualMaturity({ ...COMPLETE, postCount: 45, postsPerMonth: 1.5, visualConsistency: 0.4 }).level).toBe(
      'CONSISTENT',
    );
  });

  it('la confiance suit la couverture, jamais la netteté du verdict', () => {
    const sparse = classifyVisualMaturity({
      postCount: 889,
      lastPostAt: new Date('2026-08-10T00:00:00Z'),
      postsPerMonth: 12,
    });
    expect(sparse.level).not.toBe('UNKNOWN');
    expect(sparse.confidence).toBe('LOW');
  });

  it('la classification est déterministe', () => {
    expect(classifyVisualMaturity(COMPLETE)).toEqual(classifyVisualMaturity(COMPLETE));
  });
});
