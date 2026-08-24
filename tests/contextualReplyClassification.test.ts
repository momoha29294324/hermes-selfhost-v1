import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { createLogger } from '@/lib/logging/logger';
import { ModelRouter } from '@/lib/models/router';
import type { LlmProvider } from '@/lib/models/types';
import type { Sql } from '@/lib/db/sql';
import type { CrmResolution } from '@/lib/crm/types';
import { assessInboundMessage } from '@/lib/conversation/assessment';
import {
  CONVERSATION_POLICY_VERSION,
  decideAutonomousReply,
  type AutonomousReplyFacts,
} from '@/lib/conversation/autonomy';
import { COMMERCIAL_POLICY_VERSION } from '@/lib/conversation/commercialPolicy';
import { decideReply } from '@/lib/conversation/decision';
import { assessOfferProgression } from '@/lib/conversation/offerProgression';
import type { ConversationSignals } from '@/lib/conversation/signals';
import type { ConversationState } from '@/lib/conversation/state';
import { planConversationReply } from '@/lib/conversation/planning';
import {
  CLASSIFIER_CONTEXT_TURNS,
  loadConversationThread,
  precedingTurns,
  precedingTurnsDigest,
  renderPrecedingTurnsBlock,
  type ConversationThread,
} from '@/lib/conversation/thread';
import { loadConversationPolicy } from '@/lib/config/load';
import { loadActiveAnalysis } from '@/lib/replies/analyses';
import { loadReplyContext, hashReplyContext } from '@/lib/replies/context';
import { REPLY_CLASSIFIER_PROMPT_VERSION } from '@/lib/replies/classifier';
import { processReply } from '@/lib/replies/process';
import {
  CATEGORY_POLICY,
  MIN_ACTIONABLE_CONFIDENCE,
  MODEL_REPLY_CATEGORIES,
  decideCategory,
  type ReplyCategory,
} from '@/lib/replies/taxonomy';
import { makeReplyFixtures, type ReplyFixtures } from './support/replyFixture';
import { turnAnswer } from './support/turnAnswer';

/**
 * HERMES-CONTEXTUAL-REPLY-CLASSIFICATION-R1 — comprendre une réponse COURTE
 * quand son sens tient au tour d'avant.
 *
 * ---------------------------------------------------------------------------
 * Le défaut réel, et ce qu'il n'était PAS
 * ---------------------------------------------------------------------------
 * Le 22 août 2026, « Surtout via le bouche à oreille » a fini en
 * `HUMAN_ESCALATION:unclassifiable`. La première hypothèse — le classifieur ne
 * voit pas la question posée — était fausse : le contexte portait déjà le
 * premier message du manifeste, et le `reasoning_summary` conservé en base dit
 * mot pour mot que le modèle avait compris (« La personne répond factuellement
 * à la question sur son canal actuel d'acquisition »).
 *
 * Ce qui manquait était une ÉTIQUETTE. Le modèle a dû choisir entre huit cases
 * dont aucune ne décrivait « elle répond à ce qu'on lui a demandé », a pris la
 * moins fausse et a baissé sa confiance à 0,55 pour le dire — puis le
 * rabattement de `decideCategory` a fait le reste.
 *
 * Un second défaut, latent, a été trouvé au passage : le contexte portait le
 * PREMIER message, jamais le tour précédent. Les deux coïncident au deuxième
 * message d'une conversation et divergent dès le troisième.
 *
 * Ces tests couvrent les deux, et surtout ce qu'ils ne doivent PAS avoir
 * ouvert : aucun seuil n'a bougé, aucun doute n'est devenu une conclusion.
 *
 * Aucun réseau : le modèle est un faux transport dans le VRAI `ModelRouter`.
 * Aucune donnée réelle de prospect n'entre ici, à une exception assumée — le
 * texte du tour du 22 août, qui est NOTRE message et la réponse d'un compte
 * d'opérateur consentant, jamais celle d'une entreprise.
 */

const logger = createLogger({ level: 'error' });
const MAILBOX = 'hermes__';

const NO_CRM: CrmResolution = {
  configured: false,
  kind: 'NOT_CONFIGURED',
  reason: 'aucune destination CRM configurée',
  missing: ['OUTBOUND_CRM_PROVIDER'],
};

/** Le tour réel du 22 août 2026, mot pour mot. */
// Échantillons SYNTHÉTIQUES. Le classifieur est simulé dans ces tests : le
// contenu ne pilote aucune assertion, il sert seulement à vérifier ce que le
// prompt transporte. Rien ici ne provient d'une conversation réelle.
const FIRST_TOUCH_SAMPLE =
  'Bonjour, petite question : aujourd’hui, vous faites comment pour avoir régulièrement de nouvelles ' +
  'demandes ?';
const REPLY_SAMPLE = 'Surtout par recommandation';

let sql: Sql;
let dir: string;
let campaignId: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-contextual-classify-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);
  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
    ['contextual-classification-test', 'Test', 'example-services', '{}'],
  );
  campaignId = rows[0]!.id;
});

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const table of [
    'hermes_conversation_plans',
    'r6b_alerts',
    'r6b_crm_projections',
    'r6b_reply_drafts',
    'r6b_prospect_state_transitions',
    'r6b_prospect_outreach_states',
    'r6b_reply_analyses',
    'r6b_inbound_messages',
    'do_not_contact',
    'r6b_dispatch_attempts',
    'r6b_live_send_attempts',
    'outreach_events',
    'r6b_dispatch_manifests',
    'r6b_batch_votes',
    'r6b_batch_items',
    'r6b_batches',
    'prospect_angles',
    'prospect_research',
    'prospect_evidence',
    'prospects',
  ]) {
    await sql.query(`delete from ${table}`);
  }
});

// ---------------------------------------------------------------------------
// Outillage
// ---------------------------------------------------------------------------

interface Answer {
  readonly category: ReplyCategory;
  readonly confidence: number;
  readonly excerpts?: readonly { readonly quote: string; readonly why: string }[];
}

interface Spy {
  readonly router: ModelRouter;
  /** Les prompts de CLASSIFICATION, dans l'ordre. */
  readonly prompts: string[];
  readonly systems: string[];
}

/**
 * Un routeur qui répond ce qu'on lui dit et retient ce qu'on lui a demandé.
 *
 * Aucun test de ce fichier ne prétend mesurer le jugement d'un modèle : ce qui
 * s'éprouve ici est la QUESTION posée (le prompt) et la CONSÉQUENCE d'une
 * réponse (le code). Prétendre tester l'un par l'autre serait un test qui
 * passe le jour où le modèle change d'avis.
 */
function spyRouter(answer: Answer): Spy {
  const prompts: string[] = [];
  const systems: string[] = [];
  const provider: LlmProvider = {
    name: 'codex',
    availability: () => ({ ok: true }),
    generate: async (request) => {
      // HERMES-SEMANTIC-GROUNDING-R1 — un tour, un appel. Le prompt observé est
      // donc celui du TOUR, qui porte le fil entier avec ses étiquettes de
      // provenance là où le prompt du classifieur portait un bloc à part.
      prompts.push(request.prompt);
      systems.push(request.system ?? '');
      return {
        text: JSON.stringify(
          turnAnswer(
            {
              category: answer.category,
              confidence: answer.confidence,
              reasoning_summary: `classé ${answer.category} par le faux routeur.`,
              evidence_excerpts: answer.excerpts ?? [],
            },
            {
              body: 'Compris, merci. Et vous, vous êtes combien à vous en occuper ?',
              rationale: 'Court, une seule question, aucun chiffre.',
              used_facts: [],
            },
          ),
        ),
      };
    },
  };
  return { router: new ModelRouter({ sql, logger, providers: { codex: provider } }), prompts, systems };
}

interface Scene {
  readonly prospectId: string;
  readonly inboundIds: readonly string[];
  readonly fixtures: ReplyFixtures;
}

/**
 * Une conversation Instagram : un premier message, puis des tours alternés.
 *
 * `turns` décrit ce que le PROSPECT a écrit, dans l'ordre. Nos réponses
 * intermédiaires sont des brouillons `APPROVED`, c'est-à-dire la seule forme
 * de tour sortant qu'un test puisse produire sans effet réel.
 */
async function conversation(
  handle: string,
  firstTouch: string,
  turns: readonly { readonly body: string; readonly ourReplyBefore?: string; readonly receivedAt: string }[],
): Promise<Scene> {
  const fixtures = makeReplyFixtures(sql, { campaignId, mailbox: MAILBOX, firstTouch });
  // Le handle DOIT ressembler au nom de l'entreprise : `enforceIcpEligibility`
  // refuse de verrouiller un manifeste vers un compte sans rapport lexical avec
  // la fiche. Cette garde est réelle et s'applique au premier contact ; la
  // contourner ferait valider une forme de donnée qui n'existe pas.
  const contacted = await fixtures.contactedProspect(handle, {
    transport: 'instagram_dm',
    displayName: handle.toUpperCase(),
  });
  await sql.query(`update prospects set identity_review = 'confirmed' where id = $1`, [
    contacted.prospectId,
  ]);

  const inboundIds: string[] = [];
  for (const [index, turn] of turns.entries()) {
    if (turn.ourReplyBefore !== undefined) {
      // Notre tour intermédiaire passe par le VRAI chemin : le message
      // précédent est traité (analyse + brouillon), puis le brouillon est
      // réécrit et validé par un humain. C'est la seule forme de tour sortant
      // qu'un test puisse produire sans effet réel — et c'est exactement celle
      // que `loadConversationThread` sait relire.
      const previous = inboundIds[index - 1];
      if (previous === undefined) throw new Error('un tour sortant intermédiaire suppose un tour reçu avant lui');
      await processReply(sql, spyRouter({ category: 'INFORMATION_SHARED', confidence: 0.9 }).router, previous, {
        crm: NO_CRM,
      });
      await sql.query(
        `update r6b_reply_drafts
            set status = 'EDITED', human_text = $2, reviewed_by = 'Operator Example', reviewed_at = $3
          where inbound_message_id = $1`,
        // Une minute AVANT le message qui suit : le fil est trié par horodatage,
        // et deux tours à la même seconde laisseraient l'ordre d'insertion
        // décider lequel « précède » l'autre.
        [previous, turn.ourReplyBefore, new Date(Date.parse(turn.receivedAt) - 60_000).toISOString()],
      );
    }
    inboundIds.push(
      await fixtures.instagramInbound({
        manifest: contacted.manifest,
        outreachEventId: contacted.outreachEventId,
        prospectId: contacted.prospectId,
        body: turn.body,
        threadId: '107403793987175',
        accountHandle: MAILBOX,
        receivedAt: turn.receivedAt,
      }),
    );
  }

  return { prospectId: contacted.prospectId, inboundIds, fixtures };
}

async function threadFor(inboundId: string): Promise<ConversationThread> {
  const context = await loadReplyContext(sql, inboundId);
  if (context === null) throw new Error('contexte introuvable');
  return loadConversationThread(sql, context);
}

// ---------------------------------------------------------------------------
// A — le cas RÉEL du 22 août 2026
// ---------------------------------------------------------------------------

describe('A. « Surtout via le bouche à oreille » — le tour qui a échoué', () => {
  it('la question posée part bien dans le prompt du classifieur, mot pour mot', async () => {
    const scene = await conversation('washindustrytest', FIRST_TOUCH_SAMPLE, [
      { body: REPLY_SAMPLE, receivedAt: '2026-08-22T21:37:36.461Z' },
    ]);
    const spy = spyRouter({ category: 'INFORMATION_SHARED', confidence: 0.92 });
    await processReply(sql, spy.router, scene.inboundIds[0]!, { crm: NO_CRM });

    // HERMES-SEMANTIC-GROUNDING-R1 — un tour coûte UN appel, plus au plus une
    // réécriture bornée quand la naturalité du premier jet ne passe pas. Ce que
    // ce test fige est le contenu du prompt, pas le nombre de jets.
    expect(spy.prompts.length).toBeGreaterThanOrEqual(1);
    expect(spy.prompts.length).toBeLessThanOrEqual(2);
    const prompt = spy.prompts[0]!;
    expect(prompt).toContain('HISTORIQUE DE LA CONVERSATION');
    expect(prompt).toContain(FIRST_TOUCH_SAMPLE);
    expect(prompt).toContain(REPLY_SAMPLE);
    // Le message courant est NOMMÉ dans le fil, et il l'est en toutes lettres :
    // le prompt du tour ne le sépare plus dans un bloc à part, il le désigne.
    expect(prompt).toContain('EUX (le message auquel tu réponds maintenant)');
    const beforeCurrent = prompt.slice(
      0,
      prompt.indexOf('EUX (le message auquel tu réponds maintenant)'),
    );
    expect(beforeCurrent).toContain(FIRST_TOUCH_SAMPLE);
    expect(beforeCurrent).not.toContain(REPLY_SAMPLE);
  });

  it('l’étiquette qui manquait est proposée au modèle, et décrite', async () => {
    const scene = await conversation('washindustrytest2', FIRST_TOUCH_SAMPLE, [
      { body: REPLY_SAMPLE, receivedAt: '2026-08-22T21:37:36.461Z' },
    ]);
    const spy = spyRouter({ category: 'INFORMATION_SHARED', confidence: 0.92 });
    await processReply(sql, spy.router, scene.inboundIds[0]!, { crm: NO_CRM });

    expect(MODEL_REPLY_CATEGORIES).toContain('INFORMATION_SHARED');
    expect(spy.systems[0]).toContain('INFORMATION_SHARED');
    expect(spy.systems[0]).toContain('elle LIVRE une information sur sa situation');
  });

  it('classé INFORMATION_SHARED, le tour n’est plus « unclassifiable » et le plan n’est plus BLOCKED', async () => {
    const scene = await conversation('washindustrytest3', FIRST_TOUCH_SAMPLE, [
      { body: REPLY_SAMPLE, receivedAt: '2026-08-22T21:37:36.461Z' },
    ]);
    const spy = spyRouter({
      category: 'INFORMATION_SHARED',
      confidence: 0.92,
      excerpts: [{ quote: REPLY_SAMPLE, why: 'canal d’acquisition indiqué' }],
    });
    await processReply(sql, spy.router, scene.inboundIds[0]!, { crm: NO_CRM });

    const analysis = await loadActiveAnalysis(sql, scene.inboundIds[0]!);
    expect(analysis?.classification).toBe('INFORMATION_SHARED');
    expect(analysis?.confidence).toBe(0.92);

    const config = await loadConversationPolicy();
    const assessment = await assessInboundMessage(sql, scene.inboundIds[0]!, {
      config,
      now: new Date('2026-08-22T22:10:00.000Z'),
    });
    expect(assessment).not.toBeNull();
    expect(assessment!.autonomous.reason).not.toBe('unclassifiable');

    const recorded = await planConversationReply(sql, assessment!);
    expect(recorded.plan.decision).not.toBe('HUMAN_ESCALATION');
    expect(recorded.plan.status).not.toBe('BLOCKED');
  });

  it('le MÊME tour rendu comme avant — QUESTION à 0,55 — reste rabattu : rien n’a été desserré', async () => {
    const scene = await conversation('washindustrytest4', FIRST_TOUCH_SAMPLE, [
      { body: REPLY_SAMPLE, receivedAt: '2026-08-22T21:37:36.461Z' },
    ]);
    const spy = spyRouter({ category: 'QUESTION', confidence: 0.55 });
    await processReply(sql, spy.router, scene.inboundIds[0]!, { crm: NO_CRM });

    const analysis = await loadActiveAnalysis(sql, scene.inboundIds[0]!);
    expect(analysis?.classification).toBe('REVIEW_REQUIRED');
    expect(MIN_ACTIONABLE_CONFIDENCE).toBe(0.6);
  });
});

// ---------------------------------------------------------------------------
// B et C — le contexte n'aide que lorsqu'il désambiguïse
// ---------------------------------------------------------------------------

describe('B/C. une réponse binaire, avec et sans tour exploitable', () => {
  it('B. la question binaire précédente est dans le prompt, avec son étiquette « NOUS »', async () => {
    const question = 'Vous avez déjà essayé de faire de la pub pour trouver des clients ?';
    const scene = await conversation('prestationexpresstest', question, [
      { body: 'Non jamais', receivedAt: '2026-08-22T10:00:00.000Z' },
    ]);
    const spy = spyRouter({ category: 'INFORMATION_SHARED', confidence: 0.9 });
    await processReply(sql, spy.router, scene.inboundIds[0]!, { crm: NO_CRM });

    const prompt = spy.prompts[0]!;
    expect(prompt).toContain('NOUS (premier message, réellement envoyé)');
    expect(prompt).toContain(question);
    expect(prompt).toContain('ta lecture de ce message');
  });

  it('C. sans aucun tour antérieur, le bloc le DIT et n’invente aucun contexte', () => {
    const orphan: ConversationThread = Object.freeze({
      prospectId: 'p1',
      turns: Object.freeze([
        {
          direction: 'INBOUND' as const,
          provenance: 'inbound_message' as const,
          at: '2026-08-22T10:00:00.000Z',
          text: 'oui',
          sourceId: 'i1',
          exposed: true,
          classification: null,
        },
      ]),
      inboundTurns: Object.freeze([]),
      outboundTurns: Object.freeze([]),
      exposedOutboundTurns: Object.freeze([]),
      currentInboundId: 'i1',
      priorInboundCount: 0,
      channel: 'instagram_dm' as const,
      truncated: false,
    });

    expect(precedingTurns(orphan)).toHaveLength(0);
    const block = renderPrecedingTurnsBlock(orphan);
    expect(block).toContain('aucun tour lisible ne précède ce message');
    expect(block).toContain('juge le message sur ce qu’il porte seul');
    expect(block).not.toContain('oui');
  });

  it('C bis. le doute reste un doute : sous le seuil, toute étiquette retombe en REVIEW_REQUIRED', () => {
    for (const category of MODEL_REPLY_CATEGORIES) {
      if (category === 'UNSUBSCRIBE') continue;
      const decision = decideCategory({
        category,
        confidence: 0.55,
        correlationStatus: 'EXACT',
        deterministic: false,
        unsubscribeDemand: null,
      });
      expect(decision.category).toBe('REVIEW_REQUIRED');
      expect(decision.requiresHumanReview).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// D — le contexte ne fabrique jamais de confiance
// ---------------------------------------------------------------------------

describe('D. rien ne fait MONTER une confiance, sauf une demande d’arrêt', () => {
  it('aucune étiquette de modèle ne ressort avec plus de confiance qu’elle n’en portait', () => {
    for (const category of MODEL_REPLY_CATEGORIES) {
      for (const confidence of [0.2, 0.55, 0.6, 0.75, 0.9, 1]) {
        const decision = decideCategory({
          category,
          confidence,
          correlationStatus: 'EXACT',
          deterministic: false,
          unsubscribeDemand: null,
        });
        expect(decision.confidence).toBeLessThanOrEqual(confidence);
      }
    }
  });

  it('une réponse courte reste jugée sur SA confiance : 0,80 sous un seuil de 0,85 refuse encore', () => {
    const facts = autonomyFacts({ category: 'INFORMATION_SHARED', confidence: 0.8 });
    const decision = decideAutonomousReply(facts);
    expect(decision.outcome).toBe('HUMAN_ESCALATION');
    expect(decision.reason).toBe('low_confidence');
  });

  it('la même à 0,92 passe la porte de confiance — la catégorie est auto-répondable', () => {
    const decision = decideAutonomousReply(autonomyFacts({ category: 'INFORMATION_SHARED', confidence: 0.92 }));
    expect(decision.reason).not.toBe('unclassifiable');
    expect(decision.reason).not.toBe('low_confidence');
  });
});

// ---------------------------------------------------------------------------
// E, F, G — ce que la nouvelle étiquette ne prend pas
// ---------------------------------------------------------------------------

describe('E/F/G. les conclusions existantes gardent leur priorité', () => {
  it('E. une objection reste une OBJECTION', async () => {
    const scene = await conversation('objectiontest', 'Comment trouvez-vous vos clients ?', [
      { body: 'On a déjà une agence et franchement c’est trop cher pour ce que c’est', receivedAt: '2026-08-22T10:00:00.000Z' },
    ]);
    const spy = spyRouter({ category: 'OBJECTION', confidence: 0.9 });
    await processReply(sql, spy.router, scene.inboundIds[0]!, { crm: NO_CRM });
    expect((await loadActiveAnalysis(sql, scene.inboundIds[0]!))?.classification).toBe('OBJECTION');
  });

  it('F. une question du prospect reste une QUESTION', async () => {
    const scene = await conversation('questiontest', 'Comment trouvez-vous vos clients ?', [
      { body: 'Vous faites quoi exactement et ça coûte combien ?', receivedAt: '2026-08-22T10:00:00.000Z' },
    ]);
    const spy = spyRouter({ category: 'QUESTION', confidence: 0.9 });
    await processReply(sql, spy.router, scene.inboundIds[0]!, { crm: NO_CRM });
    expect((await loadActiveAnalysis(sql, scene.inboundIds[0]!))?.classification).toBe('QUESTION');
  });

  it('G. une demande d’arrêt l’emporte sur INFORMATION_SHARED, et supprime', async () => {
    const scene = await conversation('optouttest', 'Comment trouvez-vous vos clients ?', [
      {
        body: 'Le bouche à oreille, et arrêtez de me contacter s’il vous plaît',
        receivedAt: '2026-08-22T10:00:00.000Z',
      },
    ]);
    // Le modèle « se trompe » volontairement, et avec beaucoup d'assurance :
    // c'est exactement le cas que le filet existe pour rattraper.
    const spy = spyRouter({ category: 'INFORMATION_SHARED', confidence: 0.99 });
    await processReply(sql, spy.router, scene.inboundIds[0]!, { crm: NO_CRM });

    const analysis = await loadActiveAnalysis(sql, scene.inboundIds[0]!);
    expect(analysis?.classification).toBe('UNSUBSCRIBE');
    expect(analysis?.recommendedNextAction).toBe('SUPPRESS_PERMANENTLY');
    const rows = await sql.query<{ n: string }>(`select count(*)::text as n from do_not_contact`);
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
  });

  it('G bis. INFORMATION_SHARED n’est ni protecteur, ni terminal, ni une preuve d’intérêt', () => {
    const policy = CATEGORY_POLICY.INFORMATION_SHARED;
    expect(policy.protective).toBe(false);
    expect(policy.suppression).toBe('none');
    expect(policy.nextState).toBe('REPLIED');
    expect(policy.evidencesHumanReply).toBe(true);
    expect(policy.draftEligible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// H — la fraîcheur ne dépend pas de la compréhension
// ---------------------------------------------------------------------------

describe('H. un tour dépassé reste dépassé, quelle que soit la classification', () => {
  it('un message plus récent referme le tour, même parfaitement compris', () => {
    const decision = decideAutonomousReply(
      autonomyFacts({ category: 'INFORMATION_SHARED', confidence: 0.99, newerInboundExists: true }),
    );
    expect(decision.outcome).toBe('AUTO_REPLY_SKIP');
    expect(decision.reason).toBe('stale_reply');
  });

  it('une salve encore ouverte referme aussi, avant toute lecture de la catégorie', () => {
    const decision = decideAutonomousReply(
      autonomyFacts({ category: 'INFORMATION_SHARED', confidence: 0.99, burstSettled: false }),
    );
    expect(decision.outcome).toBe('AUTO_REPLY_SKIP');
  });
});

// ---------------------------------------------------------------------------
// I — production et test contrôlé, une seule logique
// ---------------------------------------------------------------------------

describe('I. la coquille du test contrôlé et un vrai prospect sont classés pareil', () => {
  it('aucun module de classification ne connaît l’existence du test contrôlé', () => {
    const root = resolve(__dirname, '..');
    for (const file of [
      'src/lib/replies/classifier.ts',
      'src/lib/replies/taxonomy.ts',
      'src/lib/replies/context.ts',
      'src/lib/conversation/thread.ts',
    ]) {
      const source = readFileSync(resolve(root, file), 'utf8');
      for (const forbidden of ['controlledSelfTest', 'CONTROLLED_SELF_TEST', 'hermes_controlled_self_tests']) {
        expect(source).not.toContain(forbidden);
      }
    }
  });

});

// ---------------------------------------------------------------------------
// Le second défaut : le tour PRÉCÉDENT, pas le PREMIER
// ---------------------------------------------------------------------------

describe('le contexte est BORNÉ, et c’est bien le tour d’avant', () => {
  it('au troisième tour, le prompt porte notre dernière question — pas seulement le premier message', async () => {
    const scene = await conversation('multiturntest', 'Bonjour, comment trouvez-vous vos clients ?', [
      { body: 'Surtout le bouche à oreille', receivedAt: '2026-08-22T10:00:00.000Z' },
      {
        ourReplyBefore: 'Compris. Et vous avez déjà essayé la publicité en ligne ?',
        body: 'Non jamais',
        receivedAt: '2026-08-22T10:30:00.000Z',
      },
    ]);
    const spy = spyRouter({ category: 'INFORMATION_SHARED', confidence: 0.9 });
    await processReply(sql, spy.router, scene.inboundIds[1]!, { crm: NO_CRM });

    const prompt = spy.prompts[0]!;
    expect(prompt).toContain('Et vous avez déjà essayé la publicité en ligne ?');
    expect(prompt).toContain('NOUS (réponse validée par un humain — envoi non prouvé)');
  });

  it('au plus trois tours antérieurs partent, jamais le fil entier', async () => {
    const scene = await conversation('longthreadtest', 'Message zéro, la toute première question ?', [
      { body: 'Réponse un', receivedAt: '2026-08-22T10:00:00.000Z' },
      { ourReplyBefore: 'Notre relance un', body: 'Réponse deux', receivedAt: '2026-08-22T10:30:00.000Z' },
      { ourReplyBefore: 'Notre relance deux', body: 'Réponse trois', receivedAt: '2026-08-22T11:00:00.000Z' },
    ]);
    const thread = await threadFor(scene.inboundIds[2]!);
    const kept = precedingTurns(thread);
    expect(kept.length).toBe(CLASSIFIER_CONTEXT_TURNS);
    const block = renderPrecedingTurnsBlock(thread);
    expect(block).toContain('Notre relance deux');
    expect(block).not.toContain('Message zéro, la toute première question ?');
  });

  it('deux « oui » précédés de deux questions différentes ne posent pas la MÊME question au modèle', async () => {
    const first = await conversation('digesttestone', 'C’est vous qui gérez la communication ?', [
      { body: 'Oui', receivedAt: '2026-08-22T10:00:00.000Z' },
    ]);
    const second = await conversation('digesttesttwo', 'On peut vous rappeler cette semaine ?', [
      { body: 'Oui', receivedAt: '2026-08-22T10:00:00.000Z' },
    ]);

    const threadA = await threadFor(first.inboundIds[0]!);
    const threadB = await threadFor(second.inboundIds[0]!);
    expect(precedingTurnsDigest(threadA)).not.toBe(precedingTurnsDigest(threadB));

    const contextA = (await loadReplyContext(sql, first.inboundIds[0]!))!;
    const contextB = (await loadReplyContext(sql, second.inboundIds[0]!))!;
    expect(
      hashReplyContext(contextA, REPLY_CLASSIFIER_PROMPT_VERSION, precedingTurnsDigest(threadA)),
    ).not.toBe(hashReplyContext(contextB, REPLY_CLASSIFIER_PROMPT_VERSION, precedingTurnsDigest(threadB)));
  });

  it('la version de prompt a été incrémentée : les analyses d’hier ne se relisent pas comme celles d’aujourd’hui', () => {
    // HERMES-SEMANTIC-GROUNDING-R1 — la constante ne nomme plus « le prompt du
    // classifieur » mais LE PROMPT QUI A PRODUIT L'ANALYSE, et ce prompt lit ET
    // écrit désormais dans le même raisonnement.
    expect(REPLY_CLASSIFIER_PROMPT_VERSION).toBe('hermes-turn-3');
  });
});

// ---------------------------------------------------------------------------
// Outillage d'autonomie — le tour PARFAIT, une seule chose changée à la fois
// ---------------------------------------------------------------------------

/**
 * Le tour PARFAIT, dont on ne change qu'UNE chose à la fois.
 *
 * Même discipline que `tests/conversationAutonomy.test.ts` : `decideReply` et
 * `assessOfferProgression` sont les VRAIS, si bien qu'un test qui passe prouve
 * que la chaîne entière conclut — pas qu'une imitation de ses conclusions le
 * fait.
 */
function autonomyFacts(scenario: {
  category: ReplyCategory;
  confidence: number;
  newerInboundExists?: boolean;
  burstSettled?: boolean;
}): AutonomousReplyFacts {
  const signals: ConversationSignals = Object.freeze({
    questionTopic: 'NONE' as const,
    objectionTopic: 'NONE' as const,
    buyingSignal: 'NONE' as const,
    callReadiness: 'LOW' as const,
    sensitiveFlags: Object.freeze([]),
    explicitCallRequest: false,
    tooShortToRead: false,
  });
  const state: ConversationState = Object.freeze({
    prospectId: 'p1',
    counterparty: 'Atelier Fictif',
    channel: 'instagram_dm' as const,
    lastInboundAt: null,
    lastOutboundAt: null,
    inboundTurnCount: 1,
    outboundTurnCount: 1,
    isFirstReply: true,
    goal: 'UNDERSTAND_NEED' as const,
    qualification: 'ENGAGED' as const,
    coveredTopics: Object.freeze([]),
    questionsAskedByUs: 1,
    questionTopicsReceived: Object.freeze([]),
    objectionsEncountered: Object.freeze([]),
    nextAction: 'HUMAN_REPLY_NOW' as const,
    followUpStillRelevant: true,
    humanNeeded: false,
  });

  const { category, confidence } = scenario;
  return Object.freeze({
    policyVersion: CONVERSATION_POLICY_VERSION,
    commercialPolicyVersion: COMMERCIAL_POLICY_VERSION,
    commercialDemands: [],
    appointmentQualification: 'POTENTIALLY_QUALIFIED' as const,
    correlation: 'EXACT' as const,
    identityConfirmed: true,
    suppressed: false,
    outreachState: 'REPLIED' as const,
    terminalCategoryInThread: null,
    category,
    confidence,
    signals,
    state,
    decision: decideReply({ category, signals, state, groundingGaps: [], confidence }),
    groundingGaps: Object.freeze([]),
    offer: assessOfferProgression({ category, signals, state }),
    newerInboundExists: scenario.newerInboundExists ?? false,
    burstSettled: scenario.burstSettled ?? true,
    draft: Object.freeze({
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
    }),
    minConfidence: 0.85,
  });
}
