import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { understandConversation } from '@/lib/conversation/brain';
import { renderShadowObservation, observeConversationShadow } from '@/lib/conversation/shadow';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import type { Sql } from '@/lib/db/sql';
import { createLogger } from '@/lib/logging/logger';
import { ModelRouter } from '@/lib/models/router';
import type { LlmProvider } from '@/lib/models/types';
import { persistAnalysis, type StoredAnalysis } from '@/lib/replies/analyses';
import type { CrmResolution } from '@/lib/crm/types';
import { loadReplyContext, type ReplyContext } from '@/lib/replies/context';
import { processReply } from '@/lib/replies/process';
import { decideCategory, detectUnsubscribeDemand, resolveNextAction, type ReplyCategory } from '@/lib/replies/taxonomy';
import { makeReplyFixtures, type ContactedProspect, type ReplyFixtures } from './support/replyFixture';
import { turnAnswer } from './support/turnAnswer';

/**
 * CONVERSATION-R1.1 §27 — l'ombre, et ce qu'elle ne peut pas faire.
 *
 * Deux familles de vérifications vivent ici, et elles ne se ressemblent pas :
 *
 *   * ce que l'ombre OBSERVE — la comparaison entre le brouillon canonique et
 *     celui du cerveau, sur le premier cas réel du round ;
 *
 *   * ce que l'ombre NE PEUT PAS FAIRE. Pas « ne fait pas » : ne peut pas. La
 *     clôture d'imports est lue fichier par fichier plutôt que promise, parce
 *     qu'une promesse tenue aujourd'hui ne dit rien de l'import qu'un futur
 *     round ajouterait sans y penser.
 *
 * Aucun test n'ouvre de connexion réseau : le modèle est un faux provider
 * injecté dans le VRAI `ModelRouter`. Entreprises et adresses sont fictives.
 * Le seul texte réel est la réponse du premier cas de référence, reproduite
 * telle quelle et sans aucune identité — c'est la donnée que ce round devait
 * savoir traiter.
 */

const logger = createLogger({ test: 'conversation-r1-1' });
const MAILBOX = 'reponse@example.com';

/** La question commerciale à laquelle le cas réel répond. */
const FIRST_TOUCH_IG =
  'Bonjour, je vois que vous faites du atelier. Vos clients vous trouvent comment aujourd’hui ?';

/**
 * §5 / §26 — la réponse réelle, mot pour mot.
 *
 * Rien d'autre du cas réel n'entre dans ce dépôt : ni le compte, ni le nom, ni
 * l'identifiant du fil. Ce qui compte pour la mission est ce que ce TEXTE fait
 * au moteur, et le texte suffit à le montrer.
 */
const REAL_REPLY = 'Bonjour, Principalement mon site internet ainsi que ma fiche Google';

/** Ce que le chemin canonique R6B-D2 produit typiquement : correct, et scripté. */
const SCRIPTED_DRAFT =
  'Je vois, merci ! Et aujourd’hui cela vous apporte-t-il déjà un flux régulier de demandes ' +
  'ou cherchez-vous à développer davantage votre acquisition ?';

/** Ce que §11 donne comme la formulation naturelle. */
const NATURAL_DRAFT = 'Et ça vous apporte déjà régulièrement des demandes ou pas vraiment ?';

const NO_CRM: CrmResolution = {
  configured: false,
  kind: 'NOT_CONFIGURED',
  reason: 'aucune destination CRM configurée pour Hermes',
  missing: ['OUTBOUND_CRM_PROVIDER'],
};

let sql: Sql;
let dir: string;
let campaignId: string;
let fixtures: ReplyFixtures;
let igFixtures: ReplyFixtures;

/** Les réponses que le faux modèle rend, dans l'ordre. La dernière se répète. */
let answers: unknown[] = [];
/** Combien de RÉDACTIONS ont été demandées. Les classifications ne comptent pas. */
let calls = 0;
/** La catégorie que le faux classifieur rend, quand le pipeline le sollicite. */
let classifiesAs: ReplyCategory = 'QUESTION';

/**
 * Le faux modèle est conscient de la TÂCHE.
 *
 * `processReply` reclasse quand l'analyse en base ne porte pas la version de
 * prompt canonique — ce qui est le cas des analyses posées par les fixtures.
 * Un provider qui rendrait un corps de message à une demande de classification
 * ferait échouer le classifieur, et le test croirait mesurer une rédaction
 * alors qu'il mesurerait une panne.
 */
function makeRouter(...bodies: readonly string[]): ModelRouter {
  answers = bodies.map((body) => ({ body, rationale: 'test', used_facts: [] }));
  calls = 0;
  const provider: LlmProvider = {
    name: 'codex',
    availability: () => ({ ok: true }),
    generate: async () => {
      // HERMES-SEMANTIC-GROUNDING-R1 — un tour, un appel. L'ombre en fait un
      // second de son côté, et c'est précisément ce qu'elle mesure : le même
      // faux modèle sert les deux.
      const answer = answers[Math.min(calls, answers.length - 1)];
      calls += 1;
      return {
        text: JSON.stringify(
          turnAnswer(
            {
              category: classifiesAs,
              confidence: 0.9,
              reasoning_summary: 'classification de test',
              evidence_excerpts: [],
            },
            answer,
          ),
        ),
      };
    },
  };
  return new ModelRouter({ sql, logger, providers: { codex: provider } });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-conversation-r1-1-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);
  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
    ['example-conversation-r1-1-test', 'Test', 'example-services', '{}'],
  );
  campaignId = rows[0]!.id;
  fixtures = makeReplyFixtures(sql, {
    campaignId,
    mailbox: MAILBOX,
    firstTouch: 'Bonjour, comment vos clients vous trouvent-ils aujourd’hui ?',
  });
  igFixtures = makeReplyFixtures(sql, { campaignId, mailbox: MAILBOX, firstTouch: FIRST_TOUCH_IG });
});

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  calls = 0;
});

let counter = 0;

async function emailProspect(): Promise<ContactedProspect> {
  counter += 1;
  return fixtures.contactedProspect(`contact-r11-${counter}@example.com`);
}

/**
 * Un prospect Instagram qui franchit RÉELLEMENT la porte d'éligibilité.
 *
 * Le handle doit avoir un rapport lexical avec le nom de l'entreprise : sans
 * lui, `lockManifestForItem` refuse le verrouillage, et il a raison — c'est
 * exactement la garde qui empêche d'écrire à un compte homonyme. Un test qui
 * la contournerait validerait une forme de donnée qui n'existe pas.
 */
async function instagramProspect(): Promise<ContactedProspect> {
  counter += 1;
  return igFixtures.contactedProspect(`acmeatelier${counter}`, {
    transport: 'instagram_dm',
    displayName: 'ACME ATELIER',
  });
}

async function inboundTurn(
  source: ReplyFixtures,
  prospect: ContactedProspect,
  body: string,
  category: ReplyCategory,
  hour: number,
  instagram = false,
): Promise<{ id: string; context: ReplyContext; analysis: StoredAnalysis }> {
  const id = await source.inbound({
    manifest: prospect.manifest,
    outreachEventId: prospect.outreachEventId,
    prospectId: prospect.prospectId,
    body,
    subject: instagram ? null : undefined,
    receivedAt: new Date(Date.UTC(2026, 7, 20, hour, 0, 0)).toISOString(),
  });

  const context = await loadReplyContext(sql, id);
  if (context === null) throw new Error('contexte introuvable');

  // Le pipeline reclassera peut-être (version de prompt différente) : le faux
  // classifieur doit alors rendre LA MÊME catégorie, sinon le test mesurerait
  // deux lectures différentes du même message.
  classifiesAs = category;

  const decision = decideCategory({
    category,
    confidence: 0.9,
    correlationStatus: context.reply.correlationStatus,
    deterministic: true,
    unsubscribeDemand: detectUnsubscribeDemand(body),
  });
  const persisted = await persistAnalysis(sql, context, {
    category: decision.category,
    confidence: decision.confidence,
    reasoningSummary: `classé ${decision.category} pour le test`,
    evidenceExcerpts: [],
    currentRequest: 'NONE' as const,
    reportedContent: [],
    requiresHumanReview: decision.requiresHumanReview,
    recommendedNextAction: resolveNextAction(decision),
    decision,
    decidedDeterministically: true,
    model: 'test-model',
    effort: null,
    promptVersion: 'test-1',
    inputSha256: createHash('sha256').update(`${id}:${category}`).digest('hex'),
    modelRunId: null,
  });

  return { id, context, analysis: persisted.analysis };
}

// ---------------------------------------------------------------------------
// §27.29 / §26 — le premier cas réel
// ---------------------------------------------------------------------------

describe('§27.29 / §26 — le cas réel : une réponse concise et contextuelle', () => {
  it('lit le tour correctement, sans rien inventer', async () => {
    const prospect = await instagramProspect();
    const turn = await inboundTurn(igFixtures, prospect, REAL_REPLY, 'INTERESTED', 9, true);
    const understanding = await understandConversation(sql, turn.context, turn.analysis);

    expect(understanding.thread.channel).toBe('instagram_dm');
    expect(understanding.state.goal).toBe('UNDERSTAND_NEED');
    expect(understanding.state.isFirstReply).toBe(true);
    expect(understanding.decision.shouldDraft).toBe(true);

    // §17 — ils ont simplement répondu. Aucun appel ne se propose ici.
    expect(understanding.signals.callReadiness).not.toBe('HIGH');
    expect(understanding.state.goal).not.toBe('PROPOSE_CALL');

    // §11 — les éléments concrets de leur message sont lus, pas devinés.
    expect(understanding.anchors).toContain('site internet');
    expect(understanding.anchors).toContain('fiche google');

    // §7 — le budget du tour se resserre sur ce qu'ils ont écrit.
    expect(understanding.lengthBudget.band).toBe('SHORT');
    expect(understanding.lengthBudget.maxSentences).toBe(2);
    expect(understanding.lengthBudget.maxChars).toBeLessThanOrEqual(180);

    // §12 — ce message ne dit ni « tu » ni « vous ». On ne tranche pas.
    expect(understanding.style.addressMode).toBe('UNKNOWN');
  });

  it('refuse le premier jet scripté et garde la reformulation naturelle', async () => {
    const prospect = await instagramProspect();
    const turn = await inboundTurn(igFixtures, prospect, REAL_REPLY, 'INTERESTED', 9, true);

    // Le modèle rend d'abord la version scriptée que §11 donne en contre-exemple,
    // puis la version naturelle. C'est la boucle réelle, pas une simulation.
    const router = makeRouter(SCRIPTED_DRAFT, NATURAL_DRAFT);
    const observation = await observeConversationShadow(sql, router, turn.context, turn.analysis, {
      legacyBody: SCRIPTED_DRAFT,
      legacyBodySha256: 'a'.repeat(64),
      legacyBlocked: false,
      legacyGuardrailCodes: [],
    });

    expect(observation.status).toBe('OBSERVED');
    expect(calls).toBe(2);
    expect(observation.attempts).toBe(2);

    // Le brouillon canonique passe le MÊME contrôle : c'est ce qui rend la
    // comparaison honnête.
    expect(observation.legacy?.naturalnessVerdict).toBe('UNNATURAL');
    expect(observation.legacy?.naturalnessCodes).toContain('GENERIC_OPENING');

    // Celui du cerveau tient en une phrase et rebondit sur ce qu'ils ont dit.
    expect(observation.conversation?.naturalnessVerdict).toBe('NATURAL');
    expect(observation.conversation?.sentences).toBe(1);
    expect(observation.conversation?.questions).toBe(1);
    expect(observation.conversation?.chars).toBeLessThan(observation.legacy!.chars);
    expect(observation.rebound).toBe('ANAPHOR');

    // Et rien n'est parti, ni écrit.
    expect(observation.autoSendAllowed).toBe(false);
    expect(observation.externalEffects).toBe(false);
    const drafts = await sql.query<{ count: string }>(
      `select count(*)::text as count from r6b_reply_drafts where prospect_id = $1`,
      [prospect.prospectId],
    );
    expect(drafts[0]!.count).toBe('0');
  });

  it('rend la comparaison lisible sans recopier le message du prospect', async () => {
    const prospect = await instagramProspect();
    const turn = await inboundTurn(igFixtures, prospect, REAL_REPLY, 'INTERESTED', 9, true);
    const router = makeRouter(NATURAL_DRAFT);
    const observation = await observeConversationShadow(sql, router, turn.context, turn.analysis, {
      legacyBody: SCRIPTED_DRAFT,
    });

    const rendered = renderShadowObservation(observation);
    expect(rendered).toContain('SHADOW OBSERVED');
    expect(rendered).toContain('[legacy]');
    expect(rendered).toContain('[conversation]');
    expect(rendered).toContain('Aucun envoi');

    // §24 — le message du prospect n'y figure sous aucune forme : ce qui le
    // représente est sa longueur et le nombre d'éléments concrets qu'il portait.
    expect(rendered).not.toContain('fiche Google');
    expect(rendered).not.toContain('site internet');
    expect(JSON.stringify(observation)).not.toContain('Principalement');
    expect(observation.anchorCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// §27.28 — la cohérence multi-tour tient sous R1.1
// ---------------------------------------------------------------------------

describe('§27.28 — plusieurs tours restent cohérents', () => {
  it('retient l’état, refuse de répéter, et resserre la longueur au fil des tours', async () => {
    const prospect = await instagramProspect();

    const turn1 = await inboundTurn(igFixtures, prospect, REAL_REPLY, 'INTERESTED', 9, true);
    const first = await observeConversationShadow(
      sql,
      makeRouter(NATURAL_DRAFT),
      turn1.context,
      turn1.analysis,
      { legacyBody: null },
    );
    expect(first.goal).toBe('UNDERSTAND_NEED');

    const turn2 = await inboundTurn(igFixtures, prospect, 'ça dépend des mois, c’est irrégulier', 'INTERESTED', 11, true);
    const second = await observeConversationShadow(
      sql,
      makeRouter('Et c’est surtout les mois creux qui vous gênent ?'),
      turn2.context,
      turn2.analysis,
      { legacyBody: null },
    );

    // L'échange a avancé : l'objectif change, et le budget suit leur message.
    expect(second.goal).toBe('QUALIFY_LIGHTLY');
    expect(second.lengthBudget.band).toBe('SHORT');
    expect(second.conversation?.naturalnessVerdict).toBe('NATURAL');

    const turn3 = await inboundTurn(igFixtures, prospect, 'j’ai déjà quelqu’un pour les pubs', 'OBJECTION', 14, true);
    const third = await observeConversationShadow(
      sql,
      makeRouter('Ah ok, et ça tourne bien avec lui en ce moment ?'),
      turn3.context,
      turn3.analysis,
      { legacyBody: null },
    );

    // §23 — l'objection est reconnue et traitée, pas balayée.
    expect(third.goal).toBe('HANDLE_OBJECTION');
    expect(third.conversation?.naturalnessVerdict).toBe('NATURAL');
    expect(third.conversation?.questions).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// §27.19 / §27.20 — les arrêts tiennent, y compris en ombre
// ---------------------------------------------------------------------------

describe('§27.19 / §27.20 — un refus et un désabonnement arrêtent l’ombre aussi', () => {
  it('n’écrit aucun brouillon sur un refus clair', async () => {
    const prospect = await instagramProspect();
    const turn = await inboundTurn(igFixtures, prospect, 'pas intéressé', 'NOT_INTERESTED', 9, true);
    const observation = await observeConversationShadow(
      sql,
      makeRouter('peu importe'),
      turn.context,
      turn.analysis,
      { legacyBody: null },
    );

    expect(observation.status).toBe('NO_DRAFT');
    expect(observation.decision).toBe('STOP_COLD');
    expect(observation.conversation).toBeNull();
    // Aucun appel de modèle : il n'y avait rien à écrire.
    expect(calls).toBe(0);
  });

  it('n’écrit aucun brouillon sur un désabonnement', async () => {
    const prospect = await instagramProspect();
    const turn = await inboundTurn(igFixtures, prospect, 'merci de me retirer de votre liste', 'UNSUBSCRIBE', 9, true);
    const observation = await observeConversationShadow(
      sql,
      makeRouter('peu importe'),
      turn.context,
      turn.analysis,
      { legacyBody: null },
    );

    expect(observation.status).toBe('NO_DRAFT');
    expect(observation.decision).toBe('STOP_PERMANENT');
    expect(calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §27.17 / §27.18 — le prix et la preuve ne s'inventent toujours pas
// ---------------------------------------------------------------------------

describe('§27.17 / §27.18 — R1.1 ne desserre aucune garde', () => {
  it('nomme le manque de politique tarifaire et bloque un montant inventé', async () => {
    const prospect = await instagramProspect();
    const turn = await inboundTurn(igFixtures, prospect, 'c’est combien ?', 'QUESTION', 9, true);

    const understanding = await understandConversation(sql, turn.context, turn.analysis);
    expect(understanding.grounding.gaps).toContain('PRICING_POLICY_MISSING');
    expect(understanding.grounding.quotableProofClaim).toBeNull();

    const observation = await observeConversationShadow(
      sql,
      makeRouter('Ça démarre à 1 500 € par mois.'),
      turn.context,
      turn.analysis,
      { legacyBody: null },
    );
    expect(observation.conversation?.guardrailBlocked).toBe(true);
  });

  it('bloque la preuve chiffrée citée en réponse', async () => {
    const prospect = await instagramProspect();
    const turn = await inboundTurn(igFixtures, prospect, 'vous avez des résultats ?', 'QUESTION', 9, true);
    const observation = await observeConversationShadow(
      sql,
      makeRouter('Nous avons déjà généré environ 3 500 € pour un client que nous accompagnons.'),
      turn.context,
      turn.analysis,
      { legacyBody: null },
    );
    expect(observation.conversation?.guardrailBlocked).toBe(true);
  });

  it('§18 — une réponse prix honnête peut rester courte et naturelle', async () => {
    const prospect = await instagramProspect();
    const turn = await inboundTurn(igFixtures, prospect, 'c combien', 'QUESTION', 9, true);
    const observation = await observeConversationShadow(
      sql,
      makeRouter('Ça dépend surtout de ce qu’il y a à mettre en place, vous cherchez à développer quoi ?'),
      turn.context,
      turn.analysis,
      { legacyBody: null },
    );
    expect(observation.conversation?.guardrailBlocked).toBe(false);
    expect(observation.conversation?.naturalnessVerdict).toBe('NATURAL');
    expect(observation.conversation?.sentences).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// §27.21 / §27.22 / §27.23 — le pipeline canonique ne bouge pas
// ---------------------------------------------------------------------------

describe('§27.21 / §27.22 — l’ombre éteinte, le comportement est celui d’avant', () => {
  it('rend exactement le même traitement, sans observation', async () => {
    const prospect = await emailProspect();
    const turn = await inboundTurn(fixtures, prospect, 'oui ça m’intéresse, vous faites quoi ?', 'QUESTION', 9);

    const router = makeRouter('On aide les pros du atelier sur l’acquisition. Vous travaillez sur quelle zone ?');
    const result = await processReply(sql, router, turn.id, { crm: NO_CRM, conversationShadow: false });

    expect(result.conversationShadow).toBeNull();
    expect(result.draftId).not.toBeNull();
    expect(result.draftCreated).toBe(true);
    // Un seul appel de modèle : celui du chemin canonique. L'ombre n'a pas
    // tourné, donc elle n'a rien coûté — c'est la définition de « éteinte ».
    expect(calls).toBe(1);
  });

  it('produit le MÊME résultat canonique, ombre allumée ou éteinte', async () => {
    const off = await emailProspect();
    const offTurn = await inboundTurn(fixtures, off, 'et concrètement ça donne quoi ?', 'QUESTION', 9);
    const offResult = await processReply(sql, makeRouter('On part de ce que vous avez déjà en place.'), offTurn.id, {
      crm: NO_CRM,
      conversationShadow: false,
    });

    const on = await emailProspect();
    const onTurn = await inboundTurn(fixtures, on, 'et concrètement ça donne quoi ?', 'QUESTION', 9);
    const onResult = await processReply(sql, makeRouter('On part de ce que vous avez déjà en place.'), onTurn.id, {
      crm: NO_CRM,
      conversationShadow: true,
    });

    // Tout ce que le pipeline décide est identique. Seul le champ d'observation
    // diffère — et il est produit APRÈS eux, lu par aucun d'eux.
    for (const key of [
      'classification',
      'confidence',
      'analysisCreated',
      'stateFrom',
      'stateTo',
      'stateApplied',
      'suppressed',
      'draftCreated',
      'draftFailure',
      'crmStatus',
      'alertCreated',
    ] as const) {
      expect(onResult[key]).toEqual(offResult[key]);
    }
    expect(offResult.conversationShadow).toBeNull();
    expect(onResult.conversationShadow).not.toBeNull();
  });
});

describe('§27.23 — l’ombre allumée ne produit aucun effet externe', () => {
  it('n’écrit ni second brouillon, ni état, ni événement sortant', async () => {
    const prospect = await emailProspect();
    const turn = await inboundTurn(fixtures, prospect, 'ok et ça marche comment ?', 'QUESTION', 9);

    const before = await sql.query<{ events: string }>(
      `select count(*)::text as events from outreach_events where prospect_id = $1`,
      [prospect.prospectId],
    );

    const router = makeRouter('On regarde ce que vous avez déjà, puis on cible. Vous êtes sur quelle zone ?');
    const result = await processReply(sql, router, turn.id, { crm: NO_CRM, conversationShadow: true });

    expect(result.conversationShadow?.externalEffects).toBe(false);
    expect(result.conversationShadow?.autoSendAllowed).toBe(false);

    // UN seul brouillon en base : celui du chemin canonique.
    const drafts = await sql.query<{ count: string }>(
      `select count(*)::text as count from r6b_reply_drafts where prospect_id = $1`,
      [prospect.prospectId],
    );
    expect(drafts[0]!.count).toBe('1');

    const after = await sql.query<{ events: string }>(
      `select count(*)::text as events from outreach_events where prospect_id = $1`,
      [prospect.prospectId],
    );
    expect(after[0]!.events).toBe(before[0]!.events);

    // Aucune ligne d'envoi nulle part : la table de file Instagram est vide.
    const jobs = await sql.query<{ count: string }>(
      `select count(*)::text as count from ig_dispatch_jobs where prospect_id = $1`,
      [prospect.prospectId],
    );
    expect(jobs[0]!.count).toBe('0');
  });

  it('ne fait jamais échouer un traitement réel', async () => {
    const prospect = await emailProspect();
    const turn = await inboundTurn(fixtures, prospect, 'ok très bien', 'INTERESTED', 9);

    // HERMES-SEMANTIC-GROUNDING-R1 — c'est l'OMBRE qui tombe, et elle seule.
    //
    // Le tour canonique lit et écrit dans le même appel ; l'ombre en fait un
    // second, avec le schéma de rédaction. Les deux se distinguent par leur
    // schéma, et c'est ce qui permet de faire échouer la MESURE sans toucher au
    // traitement — exactement la situation que ce test existe pour éprouver.
    const provider: LlmProvider = {
      name: 'codex',
      availability: () => ({ ok: true }),
      generate: async (request) => {
        const properties = (request.schema as { properties?: Record<string, unknown> } | undefined)
          ?.properties;
        const isTurn = properties !== undefined && 'category' in properties;
        if (!isTurn) throw new Error('rédacteur d’ombre indisponible pour le test');
        return {
          text: JSON.stringify(
            turnAnswer(
              {
                category: 'INTERESTED',
                confidence: 0.9,
                reasoning_summary: 'classification de test',
                evidence_excerpts: [],
              },
              { body: 'Très bien, on en reparle quand vous voulez.', rationale: 'test', used_facts: [] },
            ),
          ),
        };
      },
    };
    const router = new ModelRouter({ sql, logger, providers: { codex: provider } });
    const result = await processReply(sql, router, turn.id, { crm: NO_CRM, conversationShadow: true });

    // Le traitement RÉEL a abouti : la mesure ratée ne lui a rien pris.
    expect(result.draftId).not.toBeNull();
    expect(result.draftFailure).toBeNull();
    expect(result.conversationShadow?.status).toBe('FAILED');
    expect(result.conversationShadow?.failureReason).not.toBeNull();
    expect(result.analysisId).toBeTruthy();
    expect(result.classification).toBe('INTERESTED');
  });
});

// ---------------------------------------------------------------------------
// §27.24 / §28 — l'ombre NE PEUT PAS envoyer
// ---------------------------------------------------------------------------

describe('§27.24 / §28 — la clôture d’imports interdit l’envoi', () => {
  const SRC = resolve(process.cwd(), 'src');

  /** Résout un import `@/...` ou relatif vers un fichier de `src/`. */
  function resolveImport(specifier: string, fromFile: string): string | null {
    const base = specifier.startsWith('@/')
      ? resolve(SRC, specifier.slice(2))
      : specifier.startsWith('.')
        ? resolve(dirname(fromFile), specifier)
        : null;
    if (base === null) return null;
    for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
      try {
        readFileSync(candidate, 'utf8');
        return candidate;
      } catch {
        continue;
      }
    }
    return null;
  }

  /** Tous les fichiers atteignables depuis une racine, imports transitifs compris. */
  function closureOf(entry: string): string[] {
    const seen = new Set<string>();
    const queue = [resolve(SRC, entry)];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
        const resolved = resolveImport(match[1] ?? '', file);
        if (resolved !== null && !seen.has(resolved)) queue.push(resolved);
      }
    }
    return [...seen];
  }

  const FORBIDDEN_PREFIXES = [
    'lib/instagram/',
    'lib/pipeline/r6bDispatch',
    'lib/pipeline/r6bLiveDispatch',
    'lib/pipeline/r6bDispatcher',
    'lib/inbound/instagramRuntime',
  ];

  it('n’atteint aucun module d’envoi, aucun rail Instagram, aucun kill-switch', () => {
    const closure = closureOf('lib/conversation/shadow.ts');
    // La clôture doit être réelle : un résolveur cassé rendrait un seul fichier
    // et le test passerait en ne prouvant rien.
    expect(closure.length).toBeGreaterThan(10);

    const offenders = closure
      .map((file) => relative(SRC, file).replace(/\\/g, '/'))
      .filter((path) => FORBIDDEN_PREFIXES.some((prefix) => path.startsWith(prefix)));
    expect(offenders).toEqual([]);
  });

  it('n’atteint aucun fichier qui lise l’autorisation d’envoi', () => {
    const offenders = closureOf('lib/conversation/shadow.ts')
      .filter((file) => readFileSync(file, 'utf8').includes('OUTBOUND_ALLOW_SENDING'))
      .map((file) => relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it('n’importe aucune primitive d’écriture ni d’envoi', () => {
    // On lit les IMPORTS, pas la prose : ce fichier PARLE de `persistDraft`
    // dans son en-tête pour dire qu'il ne l'appelle pas, et une recherche
    // textuelle naïve prendrait cette phrase pour l'aveu qu'elle dément.
    const source = readFileSync(resolve(SRC, 'lib/conversation/shadow.ts'), 'utf8');
    const imported = [...source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from/g)]
      .flatMap((match) => (match[1] ?? '').split(','))
      .map((binding) => binding.replace(/\btype\b/, '').trim())
      .filter((binding) => binding.length > 0);

    for (const forbidden of ['persistDraft', 'generateReplyDraft', 'reviewDraft', 'applyTransition', 'projectToCrm']) {
      expect(imported).not.toContain(forbidden);
    }
    // Ce qu'il importe vraiment : de quoi comprendre et de quoi mesurer.
    expect(imported).toContain('buildConversationReply');
    expect(imported).toContain('checkNaturalness');
  });
});
