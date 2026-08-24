import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_FOLLOW_UP_POLICY_VERSION,
  checkFollowUpDraft,
  FOLLOW_UP_BRIEF,
  followUpSequenceState,
  formatFollowUpDecision,
  parseRequestedResume,
  planFollowUp,
  postponeToWindow,
  type FollowUpFacts,
} from '@/lib/conversation/followUp';
import { loadConversationPolicy, loadInstagramRail } from '@/lib/config/load';
import { isInsideWindow } from '@/lib/instagram/scheduler';

/**
 * HERMES-CONVERSATION-R2 §35 — les relances.
 *
 * La configuration RÉELLE est chargée (`config/conversation.json`,
 * `config/instagram.json`) : un test qui inventerait ses propres délais
 * prouverait que le code sait additionner, pas que la politique livrée fait ce
 * qu'on croit. Les instants, eux, sont injectés — `now` est un paramètre
 * partout, et une suite qui lirait l'horloge murale échouerait un samedi.
 *
 * Entreprises et textes sont fictifs.
 */

const policy = loadConversationPolicy();
const rail = loadInstagramRail();

const DAY = 24 * 60 * 60 * 1000;
const SENT_AT = '2026-08-03T09:30:00.000Z'; // un lundi matin, dans la fenêtre

const BASE: FollowUpFacts = Object.freeze({
  policyVersion: CONVERSATION_FOLLOW_UP_POLICY_VERSION,
  prospectId: 'p1',
  manifestId: 'm1',
  firstTouchSentAt: SENT_AT,
  followUpsSent: 0,
  lastFollowUpAt: null,
  inboundCount: 0,
  lastInboundAt: null,
  lastCategory: null,
  terminalCategoryInThread: null,
  requestedResumeAt: null,
  outreachState: 'CONTACTED',
  suppressed: false,
  identityConfirmed: true,
  contactHistoryConflict: false,
});

function facts(overrides: Partial<FollowUpFacts> = {}): FollowUpFacts {
  return Object.freeze({ ...BASE, ...overrides });
}

function at(offsetMs: number): Date {
  return new Date(Date.parse(SENT_AT) + offsetMs);
}

describe('HERMES-CONVERSATION-R2 §35 — relances', () => {
  it('§35.21 — sans réponse, la relance 1 devient due après le délai de politique', () => {
    const before = planFollowUp({ facts: facts(), config: policy, now: at(DAY) });
    expect(before.outcome).toBe('FOLLOW_UP_SCHEDULED');
    expect(before.step).toBe('FOLLOW_UP_1');
    expect(before.reason).toBe('not_due_yet');

    const after = planFollowUp({
      facts: facts(),
      config: policy,
      now: at(policy.followUp.firstDelayMs + 1_000),
    });
    expect(after.outcome).toBe('FOLLOW_UP_DUE');
    expect(after.step).toBe('FOLLOW_UP_1');
    expect(after.dueBasis).toBe('policy_delay');
  });

  it('§35.21 bis — l’échéance part du PREMIER MESSAGE, pas de l’instant du calcul', () => {
    const first = planFollowUp({ facts: facts(), config: policy, now: at(DAY) });
    const later = planFollowUp({ facts: facts(), config: policy, now: at(2 * DAY) });
    expect(first.dueAt?.toISOString()).toBe(later.dueAt?.toISOString());
  });

  it('§35.22 — une réponse reçue avant l’échéance arrête la séquence', () => {
    const decision = planFollowUp({
      facts: facts({ inboundCount: 1, lastCategory: 'QUESTION', lastInboundAt: at(DAY).toISOString() }),
      config: policy,
      now: at(policy.followUp.firstDelayMs + 1_000),
    });
    expect(decision.outcome).toBe('FOLLOW_UP_STOP');
    expect(decision.reason).toBe('reply_received');
    expect(decision.dueAt).toBeNull();
  });

  it('§35.23 — un refus clair n’est JAMAIS relancé', () => {
    for (const scenario of [
      { lastCategory: 'NOT_INTERESTED' as const, inboundCount: 1 },
      { terminalCategoryInThread: 'NOT_INTERESTED' as const, inboundCount: 2 },
      { outreachState: 'NOT_INTERESTED' as const },
    ]) {
      const decision = planFollowUp({
        facts: facts(scenario),
        config: policy,
        now: at(30 * DAY),
      });
      expect(decision.outcome, JSON.stringify(scenario)).toBe('FOLLOW_UP_STOP');
      expect(decision.reason, JSON.stringify(scenario)).toBe('not_interested');
    }
  });

  it('§35.24 — un désabonnement n’est JAMAIS relancé', () => {
    const decision = planFollowUp({
      facts: facts({ inboundCount: 1, lastCategory: 'UNSUBSCRIBE' }),
      config: policy,
      now: at(30 * DAY),
    });
    expect(decision.outcome).toBe('FOLLOW_UP_STOP');
    expect(decision.reason).toBe('unsubscribe_requested');
  });

  it('un opt-out enregistré arrête la séquence avant tout le reste', () => {
    const decision = planFollowUp({ facts: facts({ suppressed: true }), config: policy, now: at(30 * DAY) });
    expect(decision.gate).toBe('opt_out');
    expect(decision.outcome).toBe('FOLLOW_UP_STOP');
  });

  it('§35.25 — un report avec date explicite est planifié à la date demandée, bornée', () => {
    const requested = new Date(Date.parse(SENT_AT) + 60 * DAY).toISOString();
    const decision = planFollowUp({
      facts: facts({
        inboundCount: 1,
        lastCategory: 'NOT_NOW',
        lastInboundAt: SENT_AT,
        requestedResumeAt: requested,
      }),
      config: policy,
      now: at(DAY),
    });
    expect(decision.outcome).toBe('FOLLOW_UP_SCHEDULED');
    expect(decision.dueBasis).toBe('prospect_requested');
    expect(decision.dueAt?.toISOString()).toBe(requested);
  });

  it('§35.25 bis — un report sans date lisible retombe sur la fenêtre prudente', () => {
    const decision = planFollowUp({
      facts: facts({ inboundCount: 1, lastCategory: 'NOT_NOW', lastInboundAt: SENT_AT }),
      config: policy,
      now: at(DAY),
    });
    expect(decision.dueBasis).toBe('policy_not_now_default');
    expect(decision.dueAt?.getTime()).toBe(Date.parse(SENT_AT) + policy.followUp.notNowDefaultDelayMs);
  });

  it('§35.25 ter — un délai demandé trop court est remonté au plancher de politique', () => {
    const soon = new Date(Date.parse(SENT_AT) + DAY).toISOString();
    const decision = planFollowUp({
      facts: facts({
        inboundCount: 1,
        lastCategory: 'NOT_NOW',
        lastInboundAt: SENT_AT,
        requestedResumeAt: soon,
      }),
      config: policy,
      now: at(0),
    });
    expect(decision.dueAt?.getTime()).toBe(Date.parse(SENT_AT) + policy.followUp.requestedMinDelayMs);
  });

  it('§35.26 — après une relance remise, la suivante est la RELANCE 2, jamais la même', () => {
    const decision = planFollowUp({
      facts: facts({ followUpsSent: 1, lastFollowUpAt: at(3 * DAY).toISOString() }),
      config: policy,
      now: at(3 * DAY + policy.followUp.secondDelayMs + 1_000),
    });
    expect(decision.step).toBe('FOLLOW_UP_2');
    expect(decision.outcome).toBe('FOLLOW_UP_DUE');
  });

  it('§35.27/§35.28 — après deux relances, la séquence s’arrête définitivement', () => {
    const decision = planFollowUp({
      facts: facts({ followUpsSent: 2, lastFollowUpAt: at(10 * DAY).toISOString() }),
      config: policy,
      now: at(365 * DAY),
    });
    expect(decision.outcome).toBe('FOLLOW_UP_STOP');
    expect(decision.reason).toBe('max_attempts_reached');
    expect(decision.sequence).toBe('STOP_NO_REPLY');
    expect(decision.reconsiderable).toBe(false);
  });

  it('§35.27 bis — la séquence se lit FIRST_TOUCH → FOLLOW_UP_1 → FOLLOW_UP_2 → STOP_NO_REPLY', () => {
    const max = policy.followUp.maxAttempts;
    expect(followUpSequenceState(facts({ followUpsSent: 0 }), max)).toBe('FIRST_TOUCH');
    expect(followUpSequenceState(facts({ followUpsSent: 1 }), max)).toBe('FOLLOW_UP_1');
    expect(followUpSequenceState(facts({ followUpsSent: 2 }), max)).toBe('STOP_NO_REPLY');
  });

  it('§35.27 ter — la configuration ne peut pas demander plus de deux relances', () => {
    expect(policy.followUp.maxAttempts).toBeLessThanOrEqual(2);
  });

  it('§35.30 — une échéance hors fenêtre est reportée à la prochaine ouverture', () => {
    // Un dimanche à 3 h du matin, heure de Paris : aucune fenêtre n'est ouverte.
    const sunday = new Date('2026-08-09T01:00:00.000Z');
    expect(isInsideWindow(sunday, rail.schedule)).toBe(false);
    const postponed = postponeToWindow(sunday, rail);
    expect(postponed.getTime()).toBeGreaterThan(sunday.getTime());
    expect(isInsideWindow(postponed, rail.schedule)).toBe(true);
  });

  it('§35.30 bis — une échéance déjà dans la fenêtre n’est pas déplacée', () => {
    const monday = new Date('2026-08-03T10:00:00.000Z');
    expect(isInsideWindow(monday, rail.schedule)).toBe(true);
    expect(postponeToWindow(monday, rail).toISOString()).toBe(monday.toISOString());
  });

  it('§35.31 — une politique différente fait ré-examiner la relance au lieu de l’exécuter', () => {
    const decision = planFollowUp({
      facts: facts({ policyVersion: 'hermes-conversation-r1' }),
      config: policy,
      now: at(30 * DAY),
    });
    expect(decision.outcome).toBe('FOLLOW_UP_SKIP');
    expect(decision.reason).toBe('policy_version_mismatch');
  });

  it('§35.32 — une identité qui n’est plus établie bloque la relance', () => {
    const decision = planFollowUp({
      facts: facts({ identityConfirmed: false }),
      config: policy,
      now: at(30 * DAY),
    });
    expect(decision.outcome).toBe('FOLLOW_UP_SKIP');
    expect(decision.reason).toBe('identity_changed');
  });

  it('§35.33 — une autre intention en vol bloque la relance', () => {
    const decision = planFollowUp({
      facts: facts({ contactHistoryConflict: true }),
      config: policy,
      now: at(30 * DAY),
    });
    expect(decision.outcome).toBe('FOLLOW_UP_SKIP');
    expect(decision.reason).toBe('contact_history_conflict');
  });

  it('sans premier message prouvé parti, il n’y a rien à relancer', () => {
    const decision = planFollowUp({
      facts: facts({ firstTouchSentAt: null }),
      config: policy,
      now: at(30 * DAY),
    });
    expect(decision.outcome).toBe('FOLLOW_UP_SKIP');
    expect(decision.reason).toBe('first_touch_not_sent');
    expect(formatFollowUpDecision(decision)).toBe('FOLLOW_UP_SKIP:first_touch_not_sent');
  });

  // -------------------------------------------------------------------------
  // §17 — lire une date que quelqu'un a dite
  // -------------------------------------------------------------------------

  it('§17 — les formes explicites sont lues, les formes vagues ne le sont pas', () => {
    const from = new Date('2026-08-21T12:00:00.000Z');
    expect(parseRequestedResume('revenez dans un mois', from)?.at).toBe(
      new Date(from.getTime() + 30 * DAY).toISOString(),
    );
    expect(parseRequestedResume('rappelez-moi la semaine prochaine', from)?.at).toBe(
      new Date(from.getTime() + 7 * DAY).toISOString(),
    );
    expect(parseRequestedResume('pas avant septembre', from)?.at).toBe('2026-09-01T00:00:00.000Z');
    expect(parseRequestedResume('d’ici 3 semaines si possible', from)?.at).toBe(
      new Date(from.getTime() + 21 * DAY).toISOString(),
    );

    // Vague : rien n'est rendu, et la politique prendra sa fenêtre prudente.
    expect(parseRequestedResume('on verra plus tard', from)).toBeNull();
    expect(parseRequestedResume('après les vacances', from)).toBeNull();
    expect(parseRequestedResume('quand ce sera plus calme', from)).toBeNull();
  });

  it('§17 bis — un mois déjà passé désigne l’année suivante', () => {
    const december = new Date('2026-12-15T12:00:00.000Z');
    expect(parseRequestedResume('en septembre', december)?.at).toBe('2027-09-01T00:00:00.000Z');
  });

  // -------------------------------------------------------------------------
  // §19, §35.34 à §35.36 — le CONTENU d'une relance
  // -------------------------------------------------------------------------

  const FIRST_TOUCH =
    'Bonjour, j’ai vu votre atelier sur Instagram. Comment vos clients vous trouvent aujourd’hui ?';

  it('§35.34 — une relance qui reprend le premier message est refusée', () => {
    const check = checkFollowUpDraft({
      body: 'Bonjour, comment vos clients vous trouvent aujourd’hui ?',
      firstTouchBody: FIRST_TOUCH,
    });
    expect(check.ok).toBe(false);
    expect(check.findings.map((finding) => finding.code)).toContain('REPEATS_FIRST_TOUCH');
  });

  it('§35.34 bis — « je reviens vers vous suite à mon précédent message » est refusé deux fois', () => {
    const check = checkFollowUpDraft({
      body: 'Bonjour, je reviens vers vous suite à mon précédent message.',
      firstTouchBody: FIRST_TOUCH,
    });
    const codes = check.findings.map((finding) => finding.code);
    expect(codes).toContain('CORPORATE_JARGON');
    expect(codes).toContain('GUILT_TRIP');
  });

  it('§35.34 ter — culpabiliser est refusé, même poliment', () => {
    for (const body of [
      'Sans retour de votre part, je me permets d’insister.',
      'Je n’ai pas eu de réponse, vous n’avez pas eu le temps ?',
      'Toujours pas de nouvelles de votre côté.',
    ]) {
      const check = checkFollowUpDraft({ body, firstTouchBody: FIRST_TOUCH });
      expect(check.findings.map((finding) => finding.code), body).toContain('GUILT_TRIP');
    }
  });

  it('§35.35 — une relance ne pose qu’une question', () => {
    const check = checkFollowUpDraft({
      body: 'Vous cherchez encore à développer les demandes ? Ou c’est calé de votre côté ?',
      firstTouchBody: FIRST_TOUCH,
    });
    expect(check.findings.map((finding) => finding.code)).toContain('MULTIPLE_QUESTIONS');
  });

  it('§35.36 — une relance trop longue est refusée', () => {
    const check = checkFollowUpDraft({
      body: 'x'.repeat(400),
      firstTouchBody: FIRST_TOUCH,
    });
    expect(check.findings.map((finding) => finding.code)).toContain('TOO_LONG');
  });

  it('§19 — une relance courte, contextuelle et sans reproche passe', () => {
    const check = checkFollowUpDraft({
      body: 'Je vous repose la question au cas où : vous cherchez encore à développer les demandes en ce moment ?',
      firstTouchBody: FIRST_TOUCH,
    });
    expect(check.findings, JSON.stringify(check.findings)).toEqual([]);
    expect(check.ok).toBe(true);
  });

  it('§19 bis — le cadrage interdit explicitement le gabarit et le reproche', () => {
    expect(FOLLOW_UP_BRIEF).toContain('ne répète pas le premier message');
    expect(FOLLOW_UP_BRIEF).toContain('ne culpabilise pas');
    expect(FOLLOW_UP_BRIEF).toContain('au plus UNE question');
  });
});
