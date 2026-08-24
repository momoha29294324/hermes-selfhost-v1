/**
 * HERMES-END-TO-END-CERTIFICATION-R1 — la matrice conversationnelle, exécutée.
 *
 * Chaque scénario de `src/lib/certification/conversationMatrix.ts` est rejoué
 * contre le VRAI chemin de compréhension (`understandConversation`) et la VRAIE
 * décision d'autonomie (`decideAutonomousReply`), sur une base éphémère.
 * Aucun modèle n'est appelé pour la compréhension : elle est déterministe, et
 * c'est ce qui rend cette matrice reproductible.
 *
 * Aucun envoi n'est possible depuis ce fichier : il n'importe aucun provider,
 * aucun rail, et ne connaît pas `setKillSwitch`.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { understandConversation } from '@/lib/conversation/brain';
import {
  CONVERSATION_POLICY_VERSION,
  decideAutonomousReply,
  type AutonomousDraftFacts,
} from '@/lib/conversation/autonomy';
import {
  COMMERCIAL_POLICY_VERSION,
  readCommercialDemands,
} from '@/lib/conversation/commercialPolicy';
import { resolveAddressMode } from '@/lib/conversation/style';
import { persistAnalysis, type StoredAnalysis } from '@/lib/replies/analyses';
import { loadReplyContext, type ReplyContext } from '@/lib/replies/context';
import {
  decideCategory,
  detectUnsubscribeDemand,
  resolveNextAction,
  type ReplyCategory,
} from '@/lib/replies/taxonomy';
import {
  CONVERSATION_MATRIX,
  MATRIX_FIRST_TOUCH,
  SAFETY_CRITICAL_KEYS,
  type MatrixScenario,
} from '@/lib/certification/conversationMatrix';
import { makeReplyFixtures, type ContactedProspect, type ReplyFixtures } from '../support/replyFixture';
import type { Sql } from '@/lib/db/sql';

const MAILBOX = 'reponse@example.com';

let sql: Sql;
let dir: string;
let fixtures: ReplyFixtures;
let counter = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-certif-conv-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);
  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
    ['example-certification', 'Certification', 'example-services', '{}'],
  );
  fixtures = makeReplyFixtures(sql, {
    campaignId: rows[0]!.id,
    mailbox: MAILBOX,
    firstTouch: MATRIX_FIRST_TOUCH,
  });
}, 180_000);

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

async function inboundTurn(
  prospect: ContactedProspect,
  body: string,
  category: ReplyCategory,
  hour: number,
  confidence: number,
): Promise<{ context: ReplyContext; analysis: StoredAnalysis }> {
  const id = await fixtures.inbound({
    manifest: prospect.manifest,
    outreachEventId: prospect.outreachEventId,
    prospectId: prospect.prospectId,
    body,
    receivedAt: new Date(Date.UTC(2026, 7, 22, hour, 0, 0)).toISOString(),
  });
  const context = await loadReplyContext(sql, id);
  if (context === null) throw new Error('contexte introuvable');

  const decision = decideCategory({
    category,
    confidence,
    correlationStatus: context.reply.correlationStatus,
    deterministic: true,
    unsubscribeDemand: detectUnsubscribeDemand(body),
  });
  const persisted = await persistAnalysis(sql, context, {
    category: decision.category,
    confidence: decision.confidence,
    reasoningSummary: 'classé pour la matrice de certification',
    evidenceExcerpts: [],
    currentRequest: 'NONE' as const,
    reportedContent: [],
    requiresHumanReview: decision.requiresHumanReview,
    recommendedNextAction: resolveNextAction(decision),
    decision,
    decidedDeterministically: true,
    model: 'certification',
    effort: null,
    promptVersion: 'certification-1',
    inputSha256: createHash('sha256').update(`${id}:${category}:${String(hour)}`).digest('hex'),
    modelRunId: null,
  });
  return { context, analysis: persisted.analysis };
}

/** Un de NOS tours, écrit comme un brouillon relu — c'est ce que le fil lit. */
async function ourTurn(context: ReplyContext, analysis: StoredAnalysis, body: string): Promise<void> {
  await sql.query(
    `insert into r6b_reply_drafts
       (inbound_message_id, analysis_id, prospect_id, manifest_id, body, body_sha256,
        model, prompt_version, status, reviewed_by, reviewed_at)
     values ($1,$2,$3,$4,$5,$6,'certification','certification-1','APPROVED','certification',now())`,
    [
      context.reply.id,
      analysis.id,
      context.prospect.id,
      context.firstTouch.manifestId,
      body,
      createHash('sha256').update(body).digest('hex'),
    ],
  );
}

/**
 * Un brouillon PROPRE.
 *
 * La matrice mesure la COMPRÉHENSION et les portes de contenu, pas la qualité
 * d'un texte : le brouillon est donc irréprochable par construction, si bien
 * qu'un refus ne peut venir que d'une porte de politique. Un brouillon réel
 * ajouterait un modèle, donc du non-déterminisme, à une matrice dont tout
 * l'intérêt est d'être rejouable.
 */
const CLEAN_DRAFT: AutonomousDraftFacts = Object.freeze({
  bodySha256: 'a'.repeat(64),
  guardrailBlocked: false,
  naturalnessVerdict: 'NATURAL' as const,
  naturalnessBlockingCodes: Object.freeze([]),
  naturalnessWarningCodes: Object.freeze([]),
  questions: 1,
  proposesCall: false,
  containsPitch: false,
  performanceClaims: Object.freeze([]),
  trialStatementCodes: Object.freeze([]),
});

interface Observed {
  readonly questionTopic: string;
  readonly objectionTopic: string;
  readonly outcome: string;
  readonly reason: string | null;
  readonly facets: readonly string[];
  readonly amounts: readonly number[];
  readonly gaps: readonly string[];
  readonly contactPurpose: string;
  readonly addressMode: string;
  readonly answerExpected: boolean;
  readonly shouldDraft: boolean;
}

async function runScenario(scenario: MatrixScenario): Promise<Observed> {
  counter += 1;
  const prospect = await fixtures.contactedProspect(`certif${String(counter)}@example.com`);

  let hour = 8;
  let last: { context: ReplyContext; analysis: StoredAnalysis } | null = null;
  for (const turn of scenario.priorTurns) {
    if (turn.from === 'them') {
      hour += 1;
      last = await inboundTurn(prospect, turn.text, turn.category ?? 'OTHER', hour, 0.99);
    } else {
      if (last === null) throw new Error(`${scenario.key} : un tour sortant sans tour entrant`);
      await ourTurn(last.context, last.analysis, turn.text);
    }
  }

  hour += 1;
  const current = await inboundTurn(
    prospect,
    scenario.message,
    scenario.category,
    hour,
    scenario.confidence,
  );

  const understanding = await understandConversation(sql, current.context, current.analysis);
  const decision = decideAutonomousReply({
    policyVersion: CONVERSATION_POLICY_VERSION,
    commercialPolicyVersion: COMMERCIAL_POLICY_VERSION,
    commercialDemands: readCommercialDemands(scenario.message),
    correlation: current.context.reply.correlationStatus,
    identityConfirmed: true,
    suppressed: false,
    category: current.analysis.classification,
    confidence: current.analysis.confidence,
    signals: understanding.signals,
    state: understanding.state,
    decision: understanding.decision,
    groundingGaps: understanding.grounding.gaps,
    offer: understanding.offer,
    appointmentQualification: understanding.appointment.qualification,
    draft: understanding.decision.shouldDraft ? CLEAN_DRAFT : null,
    minConfidence: 0.85,
    outreachState: 'REPLIED',
    terminalCategoryInThread: understanding.terminalCategoryInThread,
    newerInboundExists: false,
    burstSettled: true,
  });

  return {
    questionTopic: understanding.signals.questionTopic,
    objectionTopic: understanding.signals.objectionTopic,
    outcome: decision.outcome,
    reason: decision.reason,
    facets: understanding.acquisition.facets,
    amounts: understanding.acquisition.quotableAmounts,
    gaps: understanding.grounding.gaps,
    contactPurpose: understanding.contactPurpose,
    addressMode: resolveAddressMode(understanding.thread.inboundTurns.map((turn) => turn.text)),
    answerExpected: understanding.answerExpected,
    shouldDraft: understanding.decision.shouldDraft,
  };
}

describe('matrice conversationnelle — le système répond à ce qu’on lui dit', () => {
  it.each(CONVERSATION_MATRIX.map((scenario) => [`${scenario.key} · ${scenario.label}`, scenario] as const))(
    '%s',
    async (_label, scenario) => {
      const observed = await runScenario(scenario);
      const expected = scenario.expect;

      if (expected.questionTopic !== undefined) {
        expect(observed.questionTopic, 'sujet de question').toBe(expected.questionTopic);
      }
      if (expected.objectionTopic !== undefined) {
        expect(observed.objectionTopic, 'sujet d’objection').toBe(expected.objectionTopic);
      }
      if (expected.outcome !== undefined) {
        expect(expected.outcome, `issue (motif observé : ${observed.reason ?? 'aucun'})`).toContain(
          observed.outcome,
        );
      }
      if (expected.reason !== undefined) expect(observed.reason, 'motif').toBe(expected.reason);
      if (expected.truthFacets !== undefined) {
        expect([...observed.facets], 'facettes de vérité injectées').toEqual([...expected.truthFacets]);
      }
      if (expected.quotableAmounts !== undefined) {
        expect([...observed.amounts], 'montants citables').toEqual([...expected.quotableAmounts]);
      }
      if (expected.gaps !== undefined) {
        for (const gap of expected.gaps) expect(observed.gaps, 'manques').toContain(gap);
      }
      if (expected.contactPurpose !== undefined) {
        expect(observed.contactPurpose, 'motif de contact').toBe(expected.contactPurpose);
      }
      if (expected.addressMode !== undefined) {
        expect(observed.addressMode, 'registre').toBe(expected.addressMode);
      }
      if (expected.answerExpected !== undefined) {
        expect(observed.answerExpected, 'réponse factuelle due').toBe(expected.answerExpected);
      }
      if (expected.shouldDraft !== undefined) {
        expect(observed.shouldDraft, 'brouillon tenté').toBe(expected.shouldDraft);
      }
    },
    180_000,
  );

  it('chaque scénario de sécurité porte une exigence explicite', () => {
    for (const key of SAFETY_CRITICAL_KEYS) {
      const scenario = CONVERSATION_MATRIX.find((entry) => entry.key === key);
      expect(scenario, `scénario ${key} absent de la matrice`).toBeDefined();
      expect(scenario?.expect.outcome, `scénario ${key} sans issue attendue`).toBeDefined();
      expect(
        scenario?.expect.quotableAmounts,
        `scénario ${key} ne dit pas quels montants sont citables`,
      ).toBeDefined();
    }
  });

  it('AUCUN scénario de sécurité n’autorise un montant', () => {
    for (const key of SAFETY_CRITICAL_KEYS) {
      const scenario = CONVERSATION_MATRIX.find((entry) => entry.key === key);
      expect(scenario?.expect.quotableAmounts, `scénario ${key}`).toEqual([]);
    }
  });
});
