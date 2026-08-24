/**
 * HERMES-SEMANTIC-GROUNDING-R1 — UN tour, UN appel.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce module remplace, et pourquoi
 * ---------------------------------------------------------------------------
 * Un tour de conversation coûtait DEUX appels de modèle : `classifyReply`
 * lisait le message, puis `buildConversationReply` écrivait la réponse. Les
 * deux lisaient le même fil, avec deux consignes différentes, et pouvaient
 * donc ne pas être d'accord — ce qui est exactement la classe de défauts que
 * ce round ferme. Le 23 août 2026, le rédacteur a écrit un texte juste sur un
 * message que la couche d'à côté jugeait « demande de prix ».
 *
 * Un seul appel supprime la question : la lecture et la rédaction sortent du
 * même raisonnement, donc ne peuvent pas se contredire. Et le tour nominal
 * coûte deux fois moins.
 *
 * ---------------------------------------------------------------------------
 * Ce qui n'a PAS bougé
 * ---------------------------------------------------------------------------
 * Tout ce qui décide reste du code, et reste APRÈS le modèle :
 *
 *   * `classifyDeterministically` court-circuite le modèle sur une non-remise
 *     ou une réponse d'absence — zéro appel, comme avant ;
 *   * `detectUnsubscribeDemand` et `decideCategory` corrigent la conclusion du
 *     modèle (rabattement sous seuil, filet anti-désabonnement) ;
 *   * `keepGroundedExcerpts` écarte une citation absente du corps reçu ;
 *   * `checkReplyDraft`, `checkNaturalness`, `checkTrialStatement` et
 *     `detectPerformanceClaims` relisent le texte écrit, mot pour mot comme
 *     avant, via `evaluateConversationDraft` ;
 *   * `isDraftEligible` reste seul maître de ce qui obtient un brouillon : un
 *     texte rendu sur une catégorie qui n'en mérite pas est JETÉ ici, pas
 *     persisté.
 *
 * ---------------------------------------------------------------------------
 * La lecture PROVISOIRE, et ce qu'elle peut coûter
 * ---------------------------------------------------------------------------
 * Le prompt se compose avant que le modèle n'ait rendu sa lecture. Il est donc
 * bâti sur une lecture PROVISOIRE, déterministe, tirée du texte seul
 * (`provisionalReading`) — et il ne l'affiche jamais au modèle : elle ne sert
 * qu'à choisir quels blocs de vérité entrent.
 *
 * Ce qu'elle ne peut pas faire : ouvrir une porte. Toutes les décisions —
 * `decideAutonomousReply`, les manques de grounding, les demandes commerciales
 * — sont rejouées APRÈS l'appel sur la lecture RÉELLE, dans une seconde
 * compréhension. Une lecture provisoire trop généreuse coûte au pire un bloc
 * de vérité de trop dans un prompt, jamais un envoi de plus.
 */

import { currentUtterance } from '@/lib/conversation/burst';
import {
  betterAttempt,
  composeConversationPrompt,
  evaluateConversationDraft,
  understandConversation,
  type Attempt,
  type ConversationReplyOptions,
  type ConversationUnderstanding,
  type TurnReading,
} from '@/lib/conversation/brain';
import {
  CURRENT_REQUEST_TOPICS,
  isCurrentRequestTopic,
  type CurrentRequestTopic,
} from '@/lib/conversation/currentRequest';
import { renderCorrections } from '@/lib/conversation/naturalness';
import { readSignals } from '@/lib/conversation/signals';
import { precedingTurnsDigest, type ConversationThread } from '@/lib/conversation/thread';
import type { Sql } from '@/lib/db/sql';
import type { ModelRouter } from '@/lib/models/router';
import {
  ClassificationFailure,
  REPLY_CLASSIFIER_PROMPT_VERSION,
  keepGroundedExcerpts,
  type ClassificationResult,
  type EvidenceExcerpt,
} from '@/lib/replies/classifier';
import { hashReplyContext, type ReplyContext } from '@/lib/replies/context';
import { DraftFailure, isDraftEligible, type DraftResult } from '@/lib/replies/draft';
import {
  MODEL_REPLY_CATEGORIES,
  classifyDeterministically,
  decideCategory,
  detectUnsubscribeDemand,
  resolveNextAction,
  type ReplyCategory,
} from '@/lib/replies/taxonomy';

// ---------------------------------------------------------------------------
// Le schéma
// ---------------------------------------------------------------------------

export const CONVERSATION_TURN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'category',
    'confidence',
    'reasoning_summary',
    'evidence_excerpts',
    'current_request',
    'reported_content',
    'reply',
    'reply_rationale',
    'used_facts',
  ],
  properties: {
    category: { type: 'string', enum: [...MODEL_REPLY_CATEGORIES] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reasoning_summary: { type: 'string', maxLength: 600 },
    evidence_excerpts: {
      type: 'array',
      minItems: 0,
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['quote', 'why'],
        properties: {
          quote: { type: 'string', maxLength: 300 },
          why: { type: 'string', maxLength: 200 },
        },
      },
    },
    current_request: { type: 'string', enum: [...CURRENT_REQUEST_TOPICS] },
    reported_content: { type: 'array', minItems: 0, maxItems: 3, items: { type: 'string', maxLength: 200 } },
    reply: { type: 'string', maxLength: 1200 },
    reply_rationale: { type: 'string', maxLength: 300 },
    used_facts: { type: 'array', minItems: 0, maxItems: 4, items: { type: 'string' } },
  },
} as const;

const TURN_SYSTEM = `Tu tiens une conversation de prospection B2B en français, dans un DM Instagram, à la première personne, en tant que un opérateur (Hermes).

Tu fais TROIS choses dans le même raisonnement, dans cet ordre, et tu ne décides rien d'autre.

1. TU LIS le dernier message reçu, et tu lui donnes une catégorie :
- INTERESTED : la personne manifeste un intérêt, demande à en discuter, propose un créneau, dit oui.
- QUESTION : ELLE nous demande une information sans se prononcer.
- INFORMATION_SHARED : elle LIVRE une information sur sa situation — le plus souvent en répondant à ce que nous venons de lui demander. Elle ne demande rien, n'exprime ni intérêt ni frein, et l'échange continue.
- OBJECTION : elle exprime un frein explicite (trop cher, déjà un prestataire, mauvaise expérience) tout en restant dans l'échange.
- NOT_NOW : elle reporte explicitement dans le temps.
- NOT_INTERESTED : elle refuse, sans demander d'arrêter de la contacter.
- UNSUBSCRIBE : elle demande explicitement d'arrêter de la contacter.
- OTHER : vraie réponse humaine, mais aucune des catégories ci-dessus.
- REVIEW_REQUIRED : tu n'arrives pas à trancher, même en tenant compte de ce qui précède.

2. TU SÉPARES ce qu'elle DEMANDE de ce qu'elle RACONTE. C'est la distinction la plus importante de ce prompt.
- "current_request" décrit ce qu'ELLE nous demande à NOUS, maintenant, en son nom propre. Si elle ne nous demande rien, c'est NONE — et c'est le cas le plus fréquent.
- "reported_content" liste ce qu'elle RAPPORTE : ce que ses propres clients demandaient, ce qu'un ancien prestataire promettait, ce qu'elle envisage, ce qu'elle cite, ce qu'elle dit ne PAS demander.
- « mes anciens clients demandaient toujours le prix » → current_request = NONE, reported_content = ["ses anciens clients demandaient le prix"].
- « et après les 7 jours ça coûte combien ? » → current_request = POST_TRIAL_PRICE.
- « je ne te demande pas de garantie » → current_request = NONE.
- Dans le doute sur une demande qui engage de l'argent, un pourcentage, une garantie, un remboursement ou un engagement : nomme-la. Un doute se tranche du côté prudent.

3. TU ÉCRIS la prochaine phrase de la conversation, en suivant les blocs ci-dessous.
- Si la catégorie est UNSUBSCRIBE, NOT_INTERESTED, BOUNCE, AUTO_REPLY, OTHER ou REVIEW_REQUIRED, "reply" vaut la chaîne vide : on n'écrit rien, et fabriquer un texte mettrait sous les yeux d'un humain pressé un message prêt à être copié-collé.
- Sinon "reply" est le message, et lui seul : pas de signature, pas de guillemets, pas de préambule.

Règles absolues :
- REVIEW_REQUIRED est une réponse légitime. Une catégorie choisie faute de mieux est pire qu'un doute assumé.
- "confidence" reflète ce que le texte prouve, replacé dans son contexte — pas ton envie de conclure.
- "reasoning_summary" est destiné à un humain qui auditera la décision : une à trois phrases factuelles.
- "evidence_excerpts" cite MOT POUR MOT des extraits du DERNIER MESSAGE REÇU, et de lui seul.
- N'invente aucun fait sur cette entreprise, aucun chiffre, aucun prix, aucune garantie, aucun lien.

Réponds uniquement en JSON conforme au schéma.`;

// ---------------------------------------------------------------------------
// La lecture provisoire
// ---------------------------------------------------------------------------

/**
 * Ce qu'on peut dire du message SANS modèle, pour composer le prompt.
 *
 * Déterministe, tirée des lexiques déjà écrits, et jamais persistée. Elle ne
 * sert qu'à choisir quels blocs de vérité entrent dans le prompt — et la
 * confiance qu'elle porte n'est jamais montrée au modèle.
 *
 * L'ordre est celui de la prudence : une demande d'arrêt d'abord (elle est
 * détectée par le même filet que la taxonomie), puis un frein, puis une
 * question, et le reste est une information partagée — la lecture la plus
 * fréquente d'une prospection qui fonctionne.
 */
export function provisionalReading(text: string, thread: ConversationThread): TurnReading {
  if (detectUnsubscribeDemand(text) !== null) {
    return Object.freeze({ classification: 'UNSUBSCRIBE' as const, confidence: 1 });
  }
  // La catégorie passée est neutre à dessein : on ne veut ici QUE ce que les
  // lexiques lisent du texte, sans le repli qu'une catégorie induirait.
  const signals = readSignals(text, 'OTHER', thread);
  if (signals.objectionTopic !== 'NONE') {
    return Object.freeze({ classification: 'OBJECTION' as const, confidence: 1 });
  }
  if (signals.questionTopic !== 'NONE') {
    return Object.freeze({ classification: 'QUESTION' as const, confidence: 1 });
  }
  return Object.freeze({ classification: 'INFORMATION_SHARED' as const, confidence: 1 });
}

// ---------------------------------------------------------------------------
// Le tour
// ---------------------------------------------------------------------------

export interface ConversationTurnResult {
  /** La lecture, dans la forme exacte que `persistAnalysis` attend. */
  readonly classification: ClassificationResult;
  /** Ce que la personne nous demande MAINTENANT, selon le modèle. */
  readonly currentRequest: CurrentRequestTopic;
  /** Ce qu'elle RAPPORTE, selon le modèle. Descriptif, jamais décisif. */
  readonly reportedContent: readonly string[];
  /** Le brouillon, ou `null` quand aucun texte ne doit être écrit. */
  readonly draft: DraftResult | null;
  /** La compréhension bâtie sur la lecture RÉELLE. */
  readonly understanding: ConversationUnderstanding | null;
  readonly usedFacts: readonly string[];
  /** Combien d'appels de modèle ce tour a réellement coûté : 0, 1 ou 2. */
  readonly llmCalls: number;
  /** Combien de rédactions ont été tentées : 0, 1 ou 2. */
  readonly attempts: number;
  /** Pourquoi aucun texte n'a été écrit, quand c'est le cas. */
  readonly draftSkipped: string | null;
}

interface RawTurnAnswer {
  readonly category: ReplyCategory;
  readonly confidence: number;
  readonly reasoning_summary: string;
  readonly evidence_excerpts: readonly EvidenceExcerpt[];
  readonly current_request: CurrentRequestTopic;
  readonly reported_content: readonly string[];
  readonly reply: string;
  readonly reply_rationale: string;
  readonly used_facts: readonly string[];
}

function parseTurnAnswer(value: unknown): RawTurnAnswer {
  const parsed = value as Record<string, unknown>;
  const category = parsed['category'];
  if (typeof category !== 'string' || !MODEL_REPLY_CATEGORIES.includes(category as ReplyCategory)) {
    throw new Error(`catégorie hors taxonomie : ${String(category)}`);
  }
  const confidence = typeof parsed['confidence'] === 'number' ? parsed['confidence'] : Number.NaN;
  if (!Number.isFinite(confidence)) throw new Error('confidence absente ou non numérique');
  const summary = typeof parsed['reasoning_summary'] === 'string' ? parsed['reasoning_summary'].trim() : '';
  if (summary.length === 0) throw new Error('reasoning_summary vide');

  const rawExcerpts = Array.isArray(parsed['evidence_excerpts']) ? parsed['evidence_excerpts'] : [];
  const excerpts = rawExcerpts
    .map((entry) => {
      const record = entry as Record<string, unknown>;
      return {
        quote: typeof record['quote'] === 'string' ? record['quote'] : '',
        why: typeof record['why'] === 'string' ? record['why'] : '',
      };
    })
    .filter((entry) => entry.quote.length > 0);

  // Fail-closed : une demande courante illisible vaut `OTHER`, qui n'ouvre
  // aucune escalade supplémentaire mais ne prétend pas non plus qu'il n'y a
  // rien. `NONE` serait une affirmation, et on n'a rien à affirmer.
  const currentRequest = isCurrentRequestTopic(parsed['current_request'])
    ? parsed['current_request']
    : ('OTHER' as const);

  const reported = Array.isArray(parsed['reported_content'])
    ? parsed['reported_content'].map((entry) => String(entry).slice(0, 200)).filter((entry) => entry.length > 0)
    : [];

  return {
    category: category as ReplyCategory,
    confidence: Math.max(0, Math.min(1, confidence)),
    reasoning_summary: summary.slice(0, 600),
    evidence_excerpts: excerpts,
    current_request: currentRequest,
    reported_content: reported.slice(0, 3),
    reply: typeof parsed['reply'] === 'string' ? parsed['reply'].trim() : '',
    reply_rationale: typeof parsed['reply_rationale'] === 'string' ? parsed['reply_rationale'].slice(0, 300) : '',
    used_facts: Array.isArray(parsed['used_facts']) ? parsed['used_facts'].map(String) : [],
  };
}

/**
 * Lit un message et écrit la réponse, en UN appel de modèle.
 *
 * Rend `draft: null` quand aucun texte ne doit être écrit — ce n'est pas un
 * échec, c'est la bonne réponse, et elle porte sa raison dans `draftSkipped`.
 *
 * Lève `ClassificationFailure` quand aucune lecture n'a pu être obtenue :
 * « je ne sais pas quoi conclure » et « je n'ai pas réussi à demander » sont
 * deux états différents, et le second doit laisser le message NON TRAITÉ pour
 * que la prochaine exécution réessaie.
 */
export async function runConversationTurn(
  sql: Sql,
  router: ModelRouter,
  context: ReplyContext,
  thread: ConversationThread,
  options: ConversationReplyOptions = {},
): Promise<ConversationTurnResult> {
  const inputSha256 = hashReplyContext(
    context,
    REPLY_CLASSIFIER_PROMPT_VERSION,
    precedingTurnsDigest(thread),
  );
  // HERMES-MULTI-TURN-BURSTS-R1 — la prise de parole entière, et non la
  // dernière bulle.
  //
  // Elle est calculée ICI parce qu'une demande d'arrêt doit être lue AVANT le
  // modèle et avant toute décision : « laisse tomber » puis « me recontacte
  // pas » sont deux bulles et une seule volonté, et n'en lire qu'une la
  // manquait. `currentUtterance` est pure et déterministe — la même fonction,
  // sur le même fil, que celle dont `understandConversation` se sert plus bas.
  const utterance = currentUtterance(thread.turns, context.reply.id, context.reply.bodyText);
  const unsubscribeDemand = detectUnsubscribeDemand(utterance.text);

  // ---- 1. Ce qui se lit dans les en-têtes, sans modèle ---------------------
  const deterministic = classifyDeterministically(context.reply.automationSignals);
  if (deterministic !== null) {
    const decision = decideCategory({
      category: deterministic.category,
      confidence: 1,
      correlationStatus: context.reply.correlationStatus,
      deterministic: true,
      unsubscribeDemand: null,
    });
    return Object.freeze({
      classification: Object.freeze({
        category: decision.category,
        confidence: decision.confidence,
        reasoningSummary: deterministic.reason,
        evidenceExcerpts: Object.freeze(
          deterministic.evidence.map((signal) => ({ quote: signal, why: 'en-tête observé à l’ingestion' })),
        ),
        // Une non-remise ou une réponse d'absence ne demande rien : `NONE` est
        // ici une observation, pas une prudence.
        currentRequest: 'NONE' as const,
        reportedContent: Object.freeze([]),
        requiresHumanReview: decision.requiresHumanReview,
        recommendedNextAction: resolveNextAction(decision),
        decision,
        decidedDeterministically: true,
        model: 'deterministic',
        effort: null,
        promptVersion: REPLY_CLASSIFIER_PROMPT_VERSION,
        inputSha256,
        modelRunId: null,
      }),
      currentRequest: 'NONE' as const,
      reportedContent: Object.freeze([]),
      draft: null,
      understanding: null,
      usedFacts: Object.freeze([]),
      llmCalls: 0,
      attempts: 0,
      draftSkipped: `lecture déterministe (${deterministic.category}) — aucun brouillon`,
    });
  }

  // ---- 2. Le prompt, bâti sur la lecture PROVISOIRE ------------------------
  const provisional = await understandConversation(
    sql,
    context,
    provisionalReading(utterance.text, thread),
  );
  // Le prompt du tour EST celui de la rédaction, plus une ligne.
  //
  // Il ne recopie ni le dossier ni les tours antérieurs : `renderThreadBlock`
  // porte déjà le fil entier avec ses étiquettes de provenance, et
  // `renderGroundingBlock` porte les faits observés avec leur source. Les
  // empiler deux fois ne dirait rien de plus et diluerait la consigne.
  //
  // Ce que l'ancien prompt de classification protégeait par son ORDRE — « le
  // dernier texte lu est le message reçu, donc le seul dont une citation sera
  // acceptée » — est protégé ici par du code : `keepGroundedExcerpts` vérifie
  // chaque citation contre le corps reçu, et écarte celles qui n'y sont pas.
  const composed = composeConversationPrompt(provisional, options);
  const prompt = [
    composed.prompt,
    '',
    'Rends maintenant, dans le MÊME JSON : ta lecture de ce message (catégorie, confiance,',
    'résumé, citations), ce qu’il DEMANDE (`current_request`) et ce qu’il RAPPORTE',
    '(`reported_content`), puis le message à écrire (`reply`).',
  ].join('\n');

  // ---- 3. L'UNIQUE appel ---------------------------------------------------
  const outcome = await router.run<RawTurnAnswer>(
    {
      task: 'message',
      system: TURN_SYSTEM,
      prompt,
      schema: CONVERSATION_TURN_SCHEMA as unknown as Record<string, unknown>,
      inputRef: `conversation:${context.reply.id}`,
    },
    parseTurnAnswer,
  );

  if (!outcome.ok || outcome.data === null) {
    throw new ClassificationFailure(
      outcome.error === 'llm_disabled' || outcome.error === 'route_none' ? 'model_unavailable' : 'model_error',
      `tour conversationnel impossible pour ${context.reply.id} : ${outcome.error ?? 'raison inconnue'}`,
    );
  }

  const answer = outcome.data;

  // ---- 4. Les corrections DÉTERMINISTES de la lecture ----------------------
  const { kept, dropped } = keepGroundedExcerpts(answer.evidence_excerpts, utterance.text);
  const decision = decideCategory({
    category: answer.category,
    confidence: answer.confidence,
    correlationStatus: context.reply.correlationStatus,
    deterministic: false,
    unsubscribeDemand,
  });
  const notes = [...decision.overrides];
  if (dropped.length > 0) notes.push(`${dropped.length} extrait(s) écarté(s) : absents du corps reçu`);

  const classification: ClassificationResult = Object.freeze({
    category: decision.category,
    confidence: decision.confidence,
    reasoningSummary: [answer.reasoning_summary, ...notes].join(' — ').slice(0, 600),
    evidenceExcerpts: Object.freeze(kept),
    currentRequest: answer.current_request,
    reportedContent: Object.freeze(answer.reported_content),
    requiresHumanReview: decision.requiresHumanReview,
    recommendedNextAction: resolveNextAction(decision),
    decision,
    decidedDeterministically: false,
    model: outcome.route.model,
    effort: outcome.route.effort,
    promptVersion: REPLY_CLASSIFIER_PROMPT_VERSION,
    inputSha256,
    modelRunId: outcome.modelRunId,
  });

  // ---- 5. La compréhension RÉELLE, et elle seule décide --------------------
  //
  // Rejouée sur la catégorie que le modèle a rendue, corrigée par le code.
  // C'est CETTE compréhension qui part vers `decideAutonomousReply`, jamais la
  // provisoire.
  const understanding = await understandConversation(sql, context, {
    classification: classification.category,
    confidence: classification.confidence,
  });

  // ---- 6. Le texte, s'il a un sens -----------------------------------------
  if (!isDraftEligible(classification.category)) {
    return Object.freeze({
      classification,
      currentRequest: answer.current_request,
      reportedContent: Object.freeze(answer.reported_content),
      draft: null,
      understanding,
      usedFacts: Object.freeze([]),
      llmCalls: 1,
      attempts: 0,
      draftSkipped: `catégorie ${classification.category} — aucun brouillon n’a de sens`,
    });
  }

  if (!understanding.decision.shouldDraft) {
    return Object.freeze({
      classification,
      currentRequest: answer.current_request,
      reportedContent: Object.freeze(answer.reported_content),
      draft: null,
      understanding,
      usedFacts: Object.freeze([]),
      llmCalls: 1,
      attempts: 0,
      draftSkipped: `aucun brouillon : ${understanding.decision.decision}${
        understanding.decision.escalationReason === null ? '' : ` (${understanding.decision.escalationReason})`
      }`,
    });
  }

  if (answer.reply.length === 0) {
    return Object.freeze({
      classification,
      currentRequest: answer.current_request,
      reportedContent: Object.freeze(answer.reported_content),
      draft: null,
      understanding,
      usedFacts: Object.freeze([]),
      llmCalls: 1,
      attempts: 0,
      draftSkipped: 'le modèle n’a écrit aucun texte pour ce tour',
    });
  }

  let best: Attempt = evaluateConversationDraft(understanding, context, {
    body: answer.reply,
    rationale: answer.reply_rationale,
    usedFacts: answer.used_facts,
    model: outcome.route.model,
    effort: outcome.route.effort,
    modelRunId: outcome.modelRunId,
  });
  let attempts = 1;
  let llmCalls = 1;

  // ---- 7. La RÉPARATION, une fois et jamais deux ---------------------------
  //
  // Le second appel ne rejuge RIEN : il ne redemande pas de lecture, il
  // redemande un texte. La catégorie est déjà arrêtée, et une réécriture qui
  // pourrait la changer ferait dépendre la compréhension d'un défaut de style.
  //
  // Le prompt est celui de la compréhension RÉELLE, cette fois — c'est le seul
  // endroit où la différence compte, et elle joue dans le bon sens.
  if (best.naturalness.verdict === 'UNNATURAL') {
    const realComposed = composeConversationPrompt(understanding, options);
    try {
      const repairPrompt = [
        realComposed.prompt,
        '',
        renderCorrections(best.naturalness),
        '',
        'Réécris UNIQUEMENT le message. Ne change pas ta lecture du tour.',
      ].join('\n');
      const repaired = await router.run<{ reply: string; reply_rationale: string; used_facts: readonly string[] }>(
        {
          task: 'message',
          system: realComposed.system,
          prompt: repairPrompt,
          schema: CONVERSATION_REPAIR_SCHEMA as unknown as Record<string, unknown>,
          inputRef: `conversation:${context.reply.id}`,
        },
        (value) => {
          const record = value as Record<string, unknown>;
          const reply = typeof record['reply'] === 'string' ? record['reply'].trim() : '';
          if (reply.length === 0) throw new Error('réécriture vide');
          return {
            reply,
            reply_rationale: typeof record['reply_rationale'] === 'string' ? record['reply_rationale'] : '',
            used_facts: Array.isArray(record['used_facts']) ? record['used_facts'].map(String) : [],
          };
        },
      );
      llmCalls = 2;
      if (repaired.ok && repaired.data !== null) {
        attempts = 2;
        best = betterAttempt(
          best,
          evaluateConversationDraft(understanding, context, {
            body: repaired.data.reply,
            rationale: repaired.data.reply_rationale,
            usedFacts: repaired.data.used_facts,
            model: repaired.route.model,
            effort: repaired.route.effort,
            modelRunId: repaired.modelRunId,
          }),
        );
      }
    } catch (error) {
      // Une réécriture ratée ne coûte pas le premier jet. L'inverse
      // transformerait une amélioration facultative en point de panne.
      if (!(error instanceof DraftFailure)) {
        if (error instanceof Error) llmCalls = 2;
        else throw error;
      }
    }
  }

  return Object.freeze({
    classification,
    currentRequest: answer.current_request,
    reportedContent: Object.freeze(answer.reported_content),
    draft: best.draft,
    understanding,
    usedFacts: best.usedFacts,
    llmCalls,
    attempts,
    draftSkipped: null,
  });
}

/** Le schéma de la RÉÉCRITURE : un texte, et rien d'autre. */
export const CONVERSATION_REPAIR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'reply_rationale', 'used_facts'],
  properties: {
    reply: { type: 'string', maxLength: 1200 },
    reply_rationale: { type: 'string', maxLength: 300 },
    used_facts: { type: 'array', minItems: 0, maxItems: 4, items: { type: 'string' } },
  },
} as const;
