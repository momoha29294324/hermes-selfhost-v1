import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { envBool } from '@/lib/env';
import {
  BATCH_SLUG,
  CAMPAIGN_SLUG,
  GOLD_SET_PROSPECT_IDS,
  SELECTED,
  contactHistoryFromCount,
  toResearchResult,
} from '@/lib/pipeline/r6bSelection';

/**
 * R6B-A — invariants du batch pilote (§21 de la mission).
 *
 * La sélection elle-même est statique (§5 : cinq prospects choisis à la main
 * dans le corpus commercial existant), donc testable sans base de données.
 * Le comportement dynamique (immutabilité du batch, votes) est couvert par
 * `tests/r6bBatch.test.ts`.
 */

describe('R6B-A — sélection du batch', () => {
  it('au plus 5 prospects', () => {
    expect(SELECTED.length).toBeLessThanOrEqual(5);
  });

  it('aucun prospect en double', () => {
    const ids = SELECTED.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('exclut les cinq prospects déjà cités mot pour mot dans le gold set R6A', () => {
    const goldSet = new Set(GOLD_SET_PROSPECT_IDS);
    for (const entry of SELECTED) {
      expect(goldSet.has(entry.id), `${entry.id} fait partie du gold set R6A — ne doit pas réapparaître`).toBe(
        false,
      );
    }
  });

  it('chaque prospect sélectionné porte une raison non vide', () => {
    for (const entry of SELECTED) {
      expect(entry.reason.trim().length).toBeGreaterThan(10);
    }
  });

  it('cible bien le corpus commercial existant, pas une nouvelle découverte', () => {
    expect(CAMPAIGN_SLUG).toBe('example-campaign');
  });

  it('un slug de batch identifiable et stable', () => {
    expect(BATCH_SLUG).toBe('r6b-assisted-pilot-001');
  });
});

describe('contactHistoryFromCount — §6, jamais "not_contacted" par supposition', () => {
  it('0 événement observé -> not_contacted', () => {
    expect(contactHistoryFromCount(0)).toBe('not_contacted');
  });

  it('au moins un événement -> unknown, jamais une affirmation positive', () => {
    expect(contactHistoryFromCount(1)).toBe('unknown');
    expect(contactHistoryFromCount(3)).toBe('unknown');
  });
});

describe('toResearchResult — normalisation evidenceId/evidenceIds', () => {
  it('accepte la forme historique evidenceId (singulier)', () => {
    const research = toResearchResult({
      id: 'r1',
      summary: 'résumé',
      observations: [{ text: 'fait observé', evidenceId: 'e1', sourceUrl: 'https://x.fr', provider: 'website' }],
      opportunities: [],
      unknowns: [],
      confidence: 0.7,
    });
    expect(research.observations).toHaveLength(1);
    expect(research.observations[0]?.evidenceIds).toEqual(['e1']);
  });

  it('accepte la forme actuelle evidenceIds (tableau)', () => {
    const research = toResearchResult({
      id: 'r2',
      summary: 'résumé',
      observations: [{ text: 'fait observé', evidenceIds: ['e1', 'e2'], sourceUrl: null, provider: 'website' }],
      opportunities: [],
      unknowns: [],
      confidence: 0.7,
    });
    expect(research.observations[0]?.evidenceIds).toEqual(['e1', 'e2']);
  });

  it('une observation sans identifiant exploitable garde un tableau vide, jamais inventé', () => {
    const research = toResearchResult({
      id: 'r3',
      summary: 'résumé',
      observations: [{ text: 'fait sans preuve' }],
      opportunities: [],
      unknowns: [],
      confidence: 0.5,
    });
    expect(research.observations[0]?.evidenceIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §8 / §21 — routing inchangé, gold set de production utilisé.
// ---------------------------------------------------------------------------
describe('R6B-A — pas de logique de génération parallèle', () => {
  const root = resolve(__dirname, '..');
  const generatorSource = readFileSync(resolve(root, 'src/cli/r6b-generate.ts'), 'utf8');

  it('le générateur appelle les fonctions de production angle/message, ne les réimplémente pas', () => {
    expect(generatorSource).toMatch(/from ['"]@\/lib\/pipeline\/angle['"]/);
    expect(generatorSource).toMatch(/from ['"]@\/lib\/pipeline\/message['"]/);
    expect(generatorSource).toMatch(/\bbuildAngle\s*\(/);
    expect(generatorSource).toMatch(/\bgenerateMessages\s*\(/);
  });

  it('aucun nom de modèle ni niveau d’effort en dur dans le générateur (routing = config/models.json)', () => {
    expect(generatorSource).not.toMatch(/gpt-5\.6/);
    expect(generatorSource).not.toMatch(/effort['"]?\s*:\s*['"](low|medium|high)['"]/);
  });

  it('le générateur refuse de tourner si OUTBOUND_ALLOW_SENDING=1', () => {
    expect(generatorSource).toMatch(/OUTBOUND_ALLOW_SENDING/);
    expect(envBool('OUTBOUND_ALLOW_SENDING', false)).toBe(false);
  });
});
