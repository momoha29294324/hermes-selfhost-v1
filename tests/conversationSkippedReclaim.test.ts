import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assessPlanReclaim,
  CLAIMABLE_PLAN_STATUSES,
  TERMINAL_PLAN_STATUSES,
  type ConversationPlan,
  type ConversationPlanStatus,
} from '@/lib/conversation/plan';

/**
 * HERMES-CONVERSATION-SKIPPED-RECLAIM-R1 — ce qu'un plan REPORTÉ a le droit de
 * redevenir, et ce qu'il ne redeviendra jamais.
 *
 * ---------------------------------------------------------------------------
 * Le défaut mesuré
 * ---------------------------------------------------------------------------
 * Le 23 août 2026, le plan `232ce410` portait tout ce qu'il faut : décision
 * `AUTO_REPLY_ELIGIBLE`, brouillon jugé, `external_effect_attempted = false`,
 * statut `SKIPPED` sur un `BROWSER_PROFILE_BUSY` — c'est-à-dire une contention
 * de profil, pendant laquelle AUCUN navigateur n'a été ouvert et AUCUN effet
 * tenté. Sa borne de réclamation était échue depuis vingt-cinq secondes, et
 * `claimConversationPlan` savait déjà le reprendre. Le runner, lui, exigeait
 * `status === 'PLANNED'` et rendait « la politique ne l'autorise pas ».
 *
 * Ce que ce fichier fige n'est PAS « un SKIPPED repart ». C'est la frontière :
 * un report échu redevient PROPOSABLE, et tout ce qui a touché le monde — ou
 * pourrait l'avoir touché — reste absorbant, quoi qu'en dise l'horloge.
 *
 * ---------------------------------------------------------------------------
 * Ce que la fonction ne fait pas
 * ---------------------------------------------------------------------------
 * `assessPlanReclaim` ne relit ni l'arrêt global, ni les plafonds, ni la
 * fenêtre, ni la fraîcheur, ni l'identité : elle dit seulement si le registre
 * laisse le plan repartir. Toutes ces portes vivent dans le crochet pré-effet,
 * elles restent intégralement devant, et les tests d'exécution
 * (`replyExecution.test.ts`) les exercent sur la reprise elle-même.
 */

const NOW = new Date('2026-08-23T10:10:00.000Z');
const PAST = '2026-08-23T10:07:43.368Z';
const FUTURE = '2026-08-23T10:30:00.000Z';

type PlanFacts = Pick<
  ConversationPlan,
  'status' | 'decision' | 'externalEffectAttempted' | 'notBefore' | 'lastReasonCode'
>;

function plan(overrides: Partial<PlanFacts> = {}): PlanFacts {
  return {
    status: 'SKIPPED',
    decision: 'AUTO_REPLY_ELIGIBLE',
    externalEffectAttempted: false,
    notBefore: PAST,
    lastReasonCode: 'BROWSER_PROFILE_BUSY',
    ...overrides,
  };
}

describe('§A/§B — la borne de réclamation, dans les deux sens', () => {
  it('un report TEMPORAIRE dont la borne n’est pas atteinte n’est pas réclamable', () => {
    const verdict = assessPlanReclaim(plan({ notBefore: FUTURE }), NOW);
    expect(verdict.reclaimable).toBe(false);
    expect(verdict.class).toBe('PENDING');
    expect(verdict.reclaimable === false && verdict.refusal).toBe('PLAN_NOT_DUE');
  });

  it('le MÊME plan, une fois sa borne échue, est réclamable', () => {
    const verdict = assessPlanReclaim(plan(), NOW);
    expect(verdict.reclaimable).toBe(true);
    expect(verdict.class).toBe('RECLAIMABLE');
  });

  it('la borne est stricte à la milliseconde — rien n’est arrondi', () => {
    const notBefore = '2026-08-23T10:10:00.001Z';
    expect(assessPlanReclaim(plan({ notBefore }), NOW).reclaimable).toBe(false);
    expect(assessPlanReclaim(plan({ notBefore: NOW.toISOString() }), NOW).reclaimable).toBe(true);
  });

  it('une borne ILLISIBLE refuse — fail-closed, jamais « donc c’est dû »', () => {
    const verdict = assessPlanReclaim(plan({ notBefore: 'pas une date' }), NOW);
    expect(verdict.reclaimable).toBe(false);
    expect(verdict.reclaimable === false && verdict.refusal).toBe('PLAN_NOT_DUE');
  });
});

describe('§C — le cas réel : BROWSER_PROFILE_BUSY n’a rien tenté', () => {
  it('un report de contention échu est réclamable, et le motif est dit', () => {
    const verdict = assessPlanReclaim(plan(), NOW);
    expect(verdict.reclaimable).toBe(true);
    expect(verdict.detail).toContain('BROWSER_PROFILE_BUSY');
    expect(verdict.detail).toContain('aucun effet');
  });
});

describe('§D/§E/§F/§G — ce qui reste absorbant, quoi qu’en dise l’horloge', () => {
  it('un plan SENT n’est jamais repris', () => {
    // Et pas seulement parce qu'il porte une tentative : le statut suffit.
    const verdict = assessPlanReclaim(plan({ status: 'SENT', externalEffectAttempted: false }), NOW);
    expect(verdict.reclaimable).toBe(false);
    expect(verdict.class).toBe('TERMINAL');
    expect(verdict.reclaimable === false && verdict.refusal).toBe('PLAN_TERMINAL');
  });

  it('un plan AMBIGUOUS n’est jamais repris', () => {
    const verdict = assessPlanReclaim(plan({ status: 'AMBIGUOUS' }), NOW);
    expect(verdict.class).toBe('TERMINAL');
  });

  it('`external_effect_attempted` ferme AVANT le statut — §8 prime', () => {
    // Le cas qui compte : un statut par ailleurs réclamable, sur un plan qui a
    // touché le monde. Un ordre de lecture inverse l'aurait laissé repartir.
    const verdict = assessPlanReclaim(
      plan({ status: 'SKIPPED', externalEffectAttempted: true }),
      NOW,
    );
    expect(verdict.reclaimable).toBe(false);
    expect(verdict.class).toBe('TERMINAL');
    expect(verdict.reclaimable === false && verdict.refusal).toBe('PLAN_EFFECT_ATTEMPTED');
  });

  it('TOUS les statuts absorbants refusent, sans exception', () => {
    for (const status of TERMINAL_PLAN_STATUSES) {
      const verdict = assessPlanReclaim(plan({ status }), NOW);
      expect(verdict.reclaimable, status).toBe(false);
      expect(verdict.class, status).toBe('TERMINAL');
    }
  });

  it('un SKIPPED dont la DÉCISION n’autorise rien ne repart pas non plus', () => {
    // Un « skip terminal » n'existe pas comme statut : ce qui le rend terminal
    // est la décision, et elle est lue avant l'horloge.
    for (const decision of ['AUTO_REPLY_SKIP', 'HUMAN_ESCALATION', 'TERMINAL_STOP'] as const) {
      const verdict = assessPlanReclaim(plan({ decision }), NOW);
      expect(verdict.reclaimable, decision).toBe(false);
      expect(verdict.reclaimable === false && verdict.refusal, decision).toBe(
        'PLAN_DECISION_NOT_ACTIONABLE',
      );
    }
  });

  it('un plan CLAIMED attend la reprise de bail — il ne se vole pas', () => {
    const verdict = assessPlanReclaim(plan({ status: 'CLAIMED' }), NOW);
    expect(verdict.reclaimable).toBe(false);
    expect(verdict.class).toBe('PENDING');
    expect(verdict.reclaimable === false && verdict.refusal).toBe('PLAN_LEASED');
  });

  it('les seuls statuts qui peuvent rendre `RECLAIMABLE` sont ceux que la base réclame', () => {
    // La lecture applicative et la prise atomique disent la MÊME chose. Deux
    // listes qui divergeraient produiraient une porte verte suivie d'un
    // `NO_PLAN`, ou pire, l'inverse.
    const all: readonly ConversationPlanStatus[] = [
      'PLANNED',
      'CLAIMED',
      'SKIPPED',
      'SUPERSEDED',
      'CANCELLED',
      'BLOCKED',
      'FAILED',
      'SENT',
      'AMBIGUOUS',
    ];
    const reclaimable = all.filter((status) => assessPlanReclaim(plan({ status }), NOW).reclaimable);
    expect([...reclaimable].sort()).toEqual([...CLAIMABLE_PLAN_STATUSES].sort());
  });
});

describe('§L/§M — une sémantique GÉNÉRIQUE, sans destinataire privilégié', () => {
  const ROOT = resolve(__dirname, '..');
  const source = readFileSync(resolve(ROOT, 'src/lib/conversation/plan.ts'), 'utf8');

  it('la réclamation ne connaît ni la coquille, ni le compte du test contrôlé', () => {
    expect(source).not.toContain('controlledSelfTest');
    expect(source).not.toContain('ControlledSelfTest');
    expect(source).not.toContain('operator_second_account');
  });

  it('elle ne reçoit MÊME PAS de quoi distinguer une coquille d’un prospect', () => {
    // La preuve n'est pas une absence de `if` : c'est le TYPE. La fonction ne
    // voit ni `prospectId`, ni cadence, ni configuration — il n'existe donc
    // aucune donnée depuis laquelle une exception pourrait être écrite.
    const shell = plan();
    const production = plan();
    expect(assessPlanReclaim(shell, NOW)).toEqual(assessPlanReclaim(production, NOW));
  });

});
