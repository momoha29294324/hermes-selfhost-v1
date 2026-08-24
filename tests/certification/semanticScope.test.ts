/**
 * HERMES-SEMANTIC-GROUNDING-R1 — le corpus sémantique, exécuté contre le VRAI
 * chemin de lecture commerciale.
 *
 * Aucun modèle, aucune base : `scopeUtterance`, `readCommercialDemands`,
 * `firstEscalatingDemand` et `resolvePriceSubject` sont pures. C'est ce qui
 * rend ce corpus gratuit, donc rejouable à chaque `npm run validate` — et c'est
 * la condition pour qu'il serve réellement de garde plutôt que de rapport.
 */

import { describe, expect, it } from 'vitest';

import {
  MUTATIONS,
  SEMANTIC_CORPUS,
  expandedSemanticCorpus,
  type SemanticFamily,
} from '@/lib/certification/semanticCorpus';
import {
  firstEscalatingDemand,
  readCommercialDemands,
} from '@/lib/conversation/commercialPolicy';
import { frameOfPattern, scopeUtterance } from '@/lib/conversation/utteranceScope';
import { resolvePriceSubject } from '@/lib/sales/priceSubject';

function escalationOf(text: string): { escalates: boolean; reason: string | null; frames: string } {
  const findings = readCommercialDemands(text);
  const escalating = firstEscalatingDemand(findings);
  return {
    escalates: escalating !== null,
    reason: escalating?.reason ?? null,
    frames: findings.map((finding) => `${finding.demand}:${finding.frame}`).join(', ') || '—',
  };
}

describe('corpus sémantique — la demande ADRESSÉE contre la demande ÉVOQUÉE', () => {
  it('couvre au moins cent cas une fois les mutations appliquées', () => {
    const expanded = expandedSemanticCorpus();
    expect(expanded.length).toBeGreaterThanOrEqual(100);
    // Chaque cas de base est bien décliné : le compte est un produit, pas une
    // somme, ce qui interdit qu'une mutation disparaisse en silence.
    expect(expanded.length).toBe(SEMANTIC_CORPUS.length * MUTATIONS.length);
  });

  it('aucune famille sémantique n’est vide', () => {
    const families = new Set<SemanticFamily>(SEMANTIC_CORPUS.map((entry) => entry.family));
    const expected: readonly SemanticFamily[] = [
      'DIRECT_PRICE',
      'HISTORICAL_PRICE',
      'DIRECT_GUARANTEE',
      'HISTORICAL_GUARANTEE',
      'DIRECT_REFUND',
      'HYPOTHETICAL_REFUND',
      'DIRECT_DURATION',
      'THIRD_PARTY_DURATION',
      'DIRECT_BUDGET',
      'PAST_BUDGET',
      'DIRECT_SERVICE',
      'OLD_PROVIDER',
      'NEGATED_REQUEST',
      'QUOTED_REQUEST',
      'COMPARISON',
      'AMBIGUOUS',
    ];
    for (const family of expected) expect(families, family).toContain(family);
  });

  it('les deux bords sont représentés — un corpus qui n’escaladerait jamais ne prouverait rien', () => {
    const escalating = SEMANTIC_CORPUS.filter((entry) => entry.escalates).length;
    expect(escalating).toBeGreaterThanOrEqual(10);
    expect(SEMANTIC_CORPUS.length - escalating).toBeGreaterThanOrEqual(20);
  });

  describe.each(expandedSemanticCorpus())('$key — $label', (entry) => {
    it(entry.escalates ? 'escalade (demande réelle)' : 'n’escalade pas (demande évoquée)', () => {
      const read = escalationOf(entry.text);
      expect(read.escalates, `${entry.text} → ${read.frames}`).toBe(entry.escalates);
      if (entry.escalates && entry.reason !== undefined) {
        expect(read.reason, entry.text).toBe(entry.reason);
      }
    });
  });

  describe.each(SEMANTIC_CORPUS)('$key — cadre attendu', (entry) => {
    it(`le motif commercial est lu en ${entry.frame}`, () => {
      const scope = scopeUtterance(entry.text);
      const findings = readCommercialDemands(entry.text);
      if (findings.length === 0) {
        // Aucun motif reconnu : la question du cadre ne se pose pas, et
        // l'attente d'escalade (fausse) est déjà vérifiée ci-dessus.
        expect(entry.escalates, entry.text).toBe(false);
        return;
      }
      const frames = new Set(findings.map((finding) => finding.frame));
      if (entry.frame === 'CURRENT') {
        expect(frames, entry.text).toContain('CURRENT');
      } else {
        expect(frames.has('CURRENT'), `${entry.text} → ${[...frames].join(', ')}`).toBe(false);
      }
      expect(scope.clauses.length).toBeGreaterThan(0);
    });
  });

  describe.each(SEMANTIC_CORPUS.filter((entry) => entry.priceSubject !== undefined))(
    '$key — sujet du prix',
    (entry) => {
      it(`se lit ${String(entry.priceSubject)}`, () => {
        expect(resolvePriceSubject(entry.text).subject, entry.text).toBe(entry.priceSubject);
      });
    },
  );
});


describe('le module de portée ne connaît ni prospect, ni coquille, ni configuration', () => {
  it('sa source ne porte aucune exception nominative', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../../src/lib/conversation/utteranceScope.ts', import.meta.url), 'utf8'),
    );
    for (const forbidden of ['controlledSelfTest', 'operator_second_account', 'northstar_studio', 'prospectId']) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it('frameOfPattern rend null quand le motif ne matche pas', () => {
    expect(frameOfPattern(scopeUtterance('bonjour'), /garantie/iu)).toBeNull();
  });
});
