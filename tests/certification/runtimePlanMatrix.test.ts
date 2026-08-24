/**
 * HERMES-END-TO-END-CERTIFICATION-R1 — l'automate d'un plan, en entier.
 *
 * Ce fichier ne rejoue pas les scénarios déjà couverts ailleurs
 * (`replyExecution`, `conversationSkippedReclaim`, `planStaleTrigger`) : les
 * recopier créerait la divergence que cette mission passe son temps à
 * refermer. Il vérifie ce qu'aucun test unitaire ne vérifie — que l'automate
 * est COMPLET et COHÉRENT sur toute sa grille, et qu'il n'a qu'une seule
 * lecture.
 *
 * Rien ici n'ouvre de base ni de navigateur : `assessPlanReclaim` est pure.
 */

import { describe, expect, it } from 'vitest';
import {
  ACTIONABLE_PLAN_DECISIONS,
  CLAIMABLE_PLAN_STATUSES,
  LIVE_PLAN_STATUSES,
  TERMINAL_PLAN_STATUSES,
  assessPlanReclaim,
  instant,
  isLivePlanStatus,
  type ConversationPlan,
  type ConversationPlanDecision,
  type ConversationPlanStatus,
} from '@/lib/conversation/plan';

const ALL_STATUSES: readonly ConversationPlanStatus[] = Object.freeze([
  'PLANNED',
  'CLAIMED',
  'SKIPPED',
  'SUPERSEDED',
  'CANCELLED',
  'BLOCKED',
  'FAILED',
  'SENT',
  'AMBIGUOUS',
]);

const ALL_DECISIONS: readonly ConversationPlanDecision[] = Object.freeze([
  'AUTO_REPLY_ELIGIBLE',
  'AUTO_REPLY_SKIP',
  'HUMAN_ESCALATION',
  'TERMINAL_STOP',
  'FOLLOW_UP_DUE',
  'FOLLOW_UP_SCHEDULED',
  'FOLLOW_UP_SKIP',
  'FOLLOW_UP_STOP',
]);

const NOW = new Date('2026-08-23T12:00:00.000Z');
const PAST = '2026-08-23T11:00:00.000Z';
const FUTURE = '2026-08-23T13:00:00.000Z';

type ReclaimInput = Pick<
  ConversationPlan,
  'status' | 'decision' | 'externalEffectAttempted' | 'notBefore' | 'lastReasonCode'
>;

function plan(overrides: Partial<ReclaimInput> = {}): ReclaimInput {
  return {
    status: 'PLANNED',
    decision: 'AUTO_REPLY_ELIGIBLE',
    externalEffectAttempted: false,
    notBefore: PAST,
    lastReasonCode: null,
    ...overrides,
  } as ReclaimInput;
}

// ---------------------------------------------------------------------------
// A — les trois listes sont une PARTITION
// ---------------------------------------------------------------------------

describe('A · les listes de statuts couvrent l’automate sans se chevaucher', () => {
  it('vivant et terminal partitionnent l’ensemble des statuts', () => {
    const union = [...LIVE_PLAN_STATUSES, ...TERMINAL_PLAN_STATUSES].sort();
    expect(union).toEqual([...ALL_STATUSES].sort());
  });

  it('aucun statut n’est à la fois vivant et terminal', () => {
    const both = LIVE_PLAN_STATUSES.filter((status) => TERMINAL_PLAN_STATUSES.includes(status));
    expect(both).toEqual([]);
  });

  it('les statuts réclamables sont un sous-ensemble strict des vivants', () => {
    for (const status of CLAIMABLE_PLAN_STATUSES) expect(isLivePlanStatus(status)).toBe(true);
    // `CLAIMED` est vivant sans être réclamable : un worker le tient.
    expect(CLAIMABLE_PLAN_STATUSES).not.toContain('CLAIMED');
    expect(LIVE_PLAN_STATUSES).toContain('CLAIMED');
  });
});

// ---------------------------------------------------------------------------
// B — la grille entière, sans trou
// ---------------------------------------------------------------------------

describe('B · toute combinaison statut × décision rend un verdict', () => {
  it.each(ALL_STATUSES)('%s rend une classe pour chaque décision', (status) => {
    for (const decision of ALL_DECISIONS) {
      const verdict = assessPlanReclaim(plan({ status, decision }), NOW);
      expect(['RECLAIMABLE', 'PENDING', 'TERMINAL']).toContain(verdict.class);
      // Une classe non réclamable porte TOUJOURS un motif : un refus muet se
      // relit six mois plus tard comme une panne.
      if (!verdict.reclaimable) expect(verdict.refusal).toBeTruthy();
    }
  });

  it('RECLAIMABLE n’arrive QUE sur un statut réclamable et une décision actionnable', () => {
    for (const status of ALL_STATUSES) {
      for (const decision of ALL_DECISIONS) {
        const verdict = assessPlanReclaim(plan({ status, decision }), NOW);
        if (!verdict.reclaimable) continue;
        expect(CLAIMABLE_PLAN_STATUSES, `${status}/${decision}`).toContain(status);
        expect(ACTIONABLE_PLAN_DECISIONS, `${status}/${decision}`).toContain(decision);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// C — ce qui est absorbant l'est quoi qu'en dise l'horloge
// ---------------------------------------------------------------------------

describe('C · un effet tenté ne repart jamais, et il est lu AVANT le statut', () => {
  it.each(ALL_STATUSES)('%s + effet tenté = TERMINAL', (status) => {
    const verdict = assessPlanReclaim(plan({ status, externalEffectAttempted: true }), NOW);
    expect(verdict.class).toBe('TERMINAL');
    expect(verdict.reclaimable).toBe(false);
    if (!verdict.reclaimable) expect(verdict.refusal).toBe('PLAN_EFFECT_ATTEMPTED');
  });

  it('l’effet tenté prime sur un statut PLANNED mal écrit', () => {
    // Un plan qui a touché le monde ne repart pas même si un statut prétend le
    // contraire : l'ordre de lecture est le fond de la garantie.
    const verdict = assessPlanReclaim(
      plan({ status: 'PLANNED', externalEffectAttempted: true, notBefore: PAST }),
      NOW,
    );
    expect(verdict.reclaimable).toBe(false);
    if (!verdict.reclaimable) expect(verdict.refusal).toBe('PLAN_EFFECT_ATTEMPTED');
  });

  it.each(['SENT', 'AMBIGUOUS'] as const)('%s reste absorbant quelle que soit la borne', (status) => {
    for (const notBefore of [PAST, FUTURE]) {
      expect(assessPlanReclaim(plan({ status, notBefore }), NOW).class).toBe('TERMINAL');
    }
  });
});

// ---------------------------------------------------------------------------
// D — la borne de réclamation, à la milliseconde
// ---------------------------------------------------------------------------

describe('D · la borne se lit sans perdre de milliseconde', () => {
  it('une borne future d’une milliseconde refuse encore', () => {
    const now = new Date('2026-08-23T12:18:19.500Z');
    const verdict = assessPlanReclaim(plan({ notBefore: '2026-08-23T12:18:19.501Z' }), now);
    expect(verdict.class).toBe('PENDING');
    if (!verdict.reclaimable) expect(verdict.refusal).toBe('PLAN_NOT_DUE');
  });

  it('une borne remontée en Date garde ses millisecondes', () => {
    // Le pilote Postgres rend un `timestamptz` en `Date`. `Date.parse` d'une
    // `Date` passe par `toString()`, qui n'a pas de millisecondes : `…19.900`
    // devenait `…19.000`, et le plan se déclarait dû 900 ms trop tôt.
    const now = new Date('2026-08-23T12:18:19.500Z');
    const notBefore = new Date('2026-08-23T12:18:19.900Z') as unknown as string;
    expect(assessPlanReclaim(plan({ notBefore }), now).class).toBe('PENDING');
  });

  it('instant() ne perd rien, sur une chaîne comme sur une Date', () => {
    const iso = '2026-08-23T12:18:19.297Z';
    expect(instant(iso)).toBe(instant(new Date(iso)));
    expect(instant(new Date(iso)) % 1000).toBe(297);
  });

  it('une borne illisible refuse — fail-closed', () => {
    const verdict = assessPlanReclaim(plan({ notBefore: 'pas une date' }), NOW);
    expect(verdict.class).toBe('PENDING');
    if (!verdict.reclaimable) expect(verdict.refusal).toBe('PLAN_NOT_DUE');
  });
});

// ---------------------------------------------------------------------------
// E — RECLAIMABLE ne veut pas dire ENVOYABLE
// ---------------------------------------------------------------------------

describe('E · une reprise ne relit AUCUNE porte de runtime', () => {
  it('la signature ne voit ni prospect, ni cadence, ni configuration', () => {
    // Il n'existe donc aucune donnée depuis laquelle une exception pourrait
    // être écrite — la propriété que le round de la reprise a posée, et qu'un
    // refactor pourrait défaire sans que rien ne le dise.
    expect(assessPlanReclaim.length).toBe(2);
  });

  it('un plan SKIPPED sur un profil occupé redevient réclamable, sans rien promettre', () => {
    const verdict = assessPlanReclaim(
      plan({ status: 'SKIPPED', lastReasonCode: 'BROWSER_PROFILE_BUSY' as never }),
      NOW,
    );
    expect(verdict.class).toBe('RECLAIMABLE');
    // Et c'est tout ce que cela dit : l'arrêt global, les plafonds, la fenêtre,
    // la cadence, la fraîcheur et l'identité restent intégralement devant.
  });
});
