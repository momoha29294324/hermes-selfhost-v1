/**
 * CONVERSATION-R1.1 — le cerveau en OMBRE, à côté du pipeline canonique.
 *
 * Ce module répond à une question et à une seule : « qu'aurait proposé le
 * cerveau conversationnel sur cette réponse, et en quoi est-ce différent de ce
 * que le chemin actuel a produit ? ». Il ne remplace rien. Le brouillon
 * canonique reste celui de `generateReplyDraft`, il reste le seul écrit en
 * base, et il reste le seul qu'un humain voit dans le CRM.
 *
 * ---------------------------------------------------------------------------
 * Ce qui garantit qu'un shadow reste un shadow
 * ---------------------------------------------------------------------------
 *
 *   * **Rien n'est persisté.** Le brouillon du cerveau n'est jamais passé à
 *     `persistDraft`. Ce n'est pas une discipline d'écriture : ce fichier
 *     n'importe pas `persistDraft`, et la seule chose qu'il rend est un objet
 *     de mesures. Il n'existe pas de chemin d'ici vers `r6b_reply_drafts`.
 *
 *   * **Rien n'est envoyé.** Aucun provider, aucune identité d'expéditeur,
 *     aucune file sortante n'entre dans la clôture d'imports de ce module ni de
 *     ses dépendances — un test le vérifie fichier par fichier plutôt que de le
 *     promettre. `autoSendAllowed` reste le littéral `false` que porte
 *     `decideReply`.
 *
 *   * **Rien n'échoue vers l'amont.** `observeConversationShadow` ne lève
 *     jamais. Une observation qui casserait le traitement d'une vraie réponse
 *     serait pire qu'une observation absente : le shadow existe pour être
 *     ignoré sans conséquence, et un `status: 'FAILED'` dit ce qui s'est passé
 *     sans que personne n'ait à s'en soucier tout de suite.
 *
 *   * **Rien de privé n'est journalisé.** §24 : identifiants, mesures et
 *     verdicts. Le seul texte qui sort d'ici est un extrait de NOTRE brouillon
 *     — celui que nous venons d'écrire. Pas une ligne du message du prospect,
 *     jamais, ni en extrait ni en résumé.
 */

import { buildConversationReply, type ConversationReply } from '@/lib/conversation/brain';
import {
  checkNaturalness,
  measureDraft,
  type LengthBudget,
  type NaturalnessCode,
  type NaturalnessVerdict,
} from '@/lib/conversation/naturalness';
import type { CallReadiness } from '@/lib/conversation/signals';
import type { ConversationGoal } from '@/lib/conversation/state';
import type { AddressMode, LengthBand, StyleConfidence } from '@/lib/conversation/style';
import type { Sql } from '@/lib/db/sql';
import { envBool } from '@/lib/env';
import type { ModelRouter } from '@/lib/models/router';
import type { StoredAnalysis } from '@/lib/replies/analyses';
import type { ReplyContext } from '@/lib/replies/context';
import { DraftFailure } from '@/lib/replies/draft';
import type { NextAction, ReplyCategory } from '@/lib/replies/taxonomy';

// ---------------------------------------------------------------------------
// Le drapeau
// ---------------------------------------------------------------------------

/**
 * Le plus petit mécanisme possible (§4) : une variable d'environnement lue par
 * `envBool`, comme `GOOGLE_PLACES_ENABLED` ou `OUTBOUND_IG_INBOUND_ENABLED`.
 *
 * Pas de fichier de configuration nouveau, pas de table, pas de schéma : un
 * shadow qui demanderait une migration pour être allumé serait plus lourd que
 * ce qu'il observe. Et surtout : à `0` — le défaut — le pipeline n'appelle même
 * pas ce module, donc son comportement est celui d'avant au sens strict, pas au
 * sens « équivalent ».
 */
export const CONVERSATION_SHADOW_ENV = 'OUTBOUND_CONVERSATION_SHADOW_ENABLED';

export function conversationShadowEnabled(override?: boolean): boolean {
  return override ?? envBool(CONVERSATION_SHADOW_ENV, false);
}

// ---------------------------------------------------------------------------
// L'observation
// ---------------------------------------------------------------------------

/**
 * Ce qu'on retient d'un brouillon — le nôtre comme celui du chemin canonique.
 *
 * Des mesures, une empreinte, des codes. L'extrait est plafonné court et ne
 * porte que du texte que nous avons produit ; il existe parce qu'une
 * comparaison sans une ligne de texte n'aide personne à juger si c'est plus
 * naturel, et c'est précisément la question de ce round.
 */
export interface DraftObservation {
  readonly source: 'legacy' | 'conversation';
  readonly chars: number;
  readonly words: number;
  readonly sentences: number;
  readonly questions: number;
  readonly emojis: number;
  readonly bodySha256: string;
  readonly guardrailBlocked: boolean;
  readonly guardrailCodes: readonly string[];
  readonly naturalnessVerdict: NaturalnessVerdict;
  readonly naturalnessCodes: readonly NaturalnessCode[];
  /** Un extrait de NOTRE texte, plafonné. Jamais celui du prospect. */
  readonly excerpt: string;
}

export const MAX_EXCERPT_CHARS = 160;

function excerpt(body: string): string {
  const text = body.trim().replace(/\s+/gu, ' ');
  return text.length <= MAX_EXCERPT_CHARS ? text : `${text.slice(0, MAX_EXCERPT_CHARS)}…`;
}

export type ShadowStatus =
  /** Le cerveau a compris et rédigé : la comparaison est complète. */
  | 'OBSERVED'
  /** Le cerveau a compris et conclu qu'il ne fallait pas écrire (arrêt, escalade). */
  | 'NO_DRAFT'
  /** La rédaction du cerveau a échoué. Le pipeline canonique, lui, n'a rien vu. */
  | 'FAILED';

export interface ShadowObservation {
  readonly status: ShadowStatus;
  readonly inboundMessageId: string;
  readonly prospectId: string;
  readonly channel: 'email' | 'instagram_dm';

  readonly category: ReplyCategory;
  readonly confidence: number;
  readonly goal: ConversationGoal;
  readonly decision: ConversationReply['decision']['decision'];
  readonly escalationReason: string | null;
  readonly callReadiness: CallReadiness;
  readonly nextAction: NextAction;

  readonly styleAddressMode: AddressMode;
  readonly styleLength: LengthBand;
  readonly styleConfidence: StyleConfidence;
  readonly styleObservedMessages: number;

  readonly lengthBudget: LengthBudget;
  /** Combien d'éléments concrets leur message portait. Un compteur, pas les mots. */
  readonly anchorCount: number;
  readonly rebound: 'ANCHOR' | 'ANAPHOR' | 'NONE' | null;

  readonly legacy: DraftObservation | null;
  readonly conversation: DraftObservation | null;
  /** Combien de rédactions le cerveau a tentées : 0, 1 ou 2. */
  readonly attempts: number;
  readonly failureReason: string | null;

  /** Rien n'a été écrit, rien n'est parti. Littéral de type, pas un calcul. */
  readonly externalEffects: false;
  readonly autoSendAllowed: false;
}

export interface ShadowInput {
  /** Le texte du brouillon canonique, s'il en existe un pour cette analyse. */
  readonly legacyBody: string | null;
  /** Ses drapeaux de garde-fou, tels que le chemin canonique les a rendus. */
  readonly legacyGuardrailCodes?: readonly string[];
  readonly legacyBlocked?: boolean;
  readonly legacyBodySha256?: string;
}

/**
 * Fait tourner le cerveau à côté du chemin canonique et rend la comparaison.
 *
 * Ne lève jamais. Ne persiste rien. N'envoie rien.
 */
export async function observeConversationShadow(
  sql: Sql,
  router: ModelRouter,
  context: ReplyContext,
  analysis: StoredAnalysis,
  input: ShadowInput,
): Promise<ShadowObservation> {
  try {
    const reply = await buildConversationReply(sql, router, context, analysis);
    return renderObservation(context, analysis, reply, input, null);
  } catch (error) {
    // Une rédaction impossible (modèle absent, schéma refusé) est une issue
    // normale du shadow, pas un incident du pipeline. Tout le reste l'est
    // aussi : ce module ne rend jamais la main par une exception.
    const reason =
      error instanceof DraftFailure
        ? `${error.kind} : ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    return Object.freeze({
      status: 'FAILED' as const,
      inboundMessageId: context.reply.id,
      prospectId: context.prospect.id,
      channel: context.firstTouch.transport === 'instagram_dm' ? ('instagram_dm' as const) : ('email' as const),
      category: analysis.classification,
      confidence: analysis.confidence,
      goal: 'AWAIT_HUMAN' as const,
      decision: 'HUMAN_ESCALATION' as const,
      escalationReason: null,
      callReadiness: 'LOW' as const,
      nextAction: 'HUMAN_REVIEW' as NextAction,
      styleAddressMode: 'UNKNOWN' as const,
      styleLength: 'UNKNOWN' as const,
      styleConfidence: 'LOW' as const,
      styleObservedMessages: 0,
      lengthBudget: Object.freeze({
        band: 'SHORT' as const,
        maxSentences: 2,
        maxChars: 240,
        inboundChars: context.reply.bodyText.trim().length,
      }),
      anchorCount: 0,
      rebound: null,
      legacy: null,
      conversation: null,
      attempts: 0,
      failureReason: reason.slice(0, 300),
      externalEffects: false as const,
      autoSendAllowed: false as const,
    });
  }
}

function renderObservation(
  context: ReplyContext,
  analysis: StoredAnalysis,
  reply: ConversationReply,
  input: ShadowInput,
  failureReason: string | null,
): ShadowObservation {
  const channel = reply.thread.channel;

  // Le brouillon canonique passe par le MÊME contrôle de naturalité que le
  // nôtre, avec les mêmes entrées. C'est ce qui rend la comparaison honnête :
  // deux barèmes différents feraient gagner celui qu'on a choisi de noter avec
  // indulgence, et le shadow ne prouverait plus rien.
  const legacy: DraftObservation | null =
    input.legacyBody === null
      ? null
      : (() => {
          const body = input.legacyBody;
          const report = checkNaturalness({
            body,
            lastInboundText: context.reply.bodyText,
            style: reply.style,
            state: reply.state,
            signals: reply.signals,
            channel,
            previousOutboundTexts: reply.thread.exposedOutboundTurns.map((turn) => turn.text),
          });
          const metrics = measureDraft(body);
          return Object.freeze({
            source: 'legacy' as const,
            ...metrics,
            bodySha256: input.legacyBodySha256 ?? '',
            guardrailBlocked: input.legacyBlocked ?? false,
            guardrailCodes: Object.freeze([...(input.legacyGuardrailCodes ?? [])]),
            naturalnessVerdict: report.verdict,
            naturalnessCodes: Object.freeze(report.findings.map((finding) => finding.code)),
            excerpt: excerpt(body),
          });
        })();

  const conversation: DraftObservation | null =
    reply.draft === null || reply.naturalness === null
      ? null
      : Object.freeze({
          source: 'conversation' as const,
          ...reply.naturalness.metrics,
          bodySha256: reply.draft.bodySha256,
          guardrailBlocked: reply.draft.blocked,
          guardrailCodes: Object.freeze(reply.draft.guardrailFlags.map((flag) => flag.code)),
          naturalnessVerdict: reply.naturalness.verdict,
          naturalnessCodes: Object.freeze(reply.naturalness.findings.map((finding) => finding.code)),
          excerpt: excerpt(reply.draft.body),
        });

  return Object.freeze({
    status: conversation === null ? ('NO_DRAFT' as const) : ('OBSERVED' as const),
    inboundMessageId: context.reply.id,
    prospectId: context.prospect.id,
    channel,
    category: analysis.classification,
    confidence: analysis.confidence,
    goal: reply.state.goal,
    decision: reply.decision.decision,
    escalationReason: reply.decision.escalationReason,
    callReadiness: reply.signals.callReadiness,
    nextAction: reply.state.nextAction,
    styleAddressMode: reply.style.addressMode,
    styleLength: reply.style.avgLength,
    styleConfidence: reply.style.confidence,
    styleObservedMessages: reply.style.observedMessages,
    lengthBudget: reply.lengthBudget,
    anchorCount: reply.anchors.length,
    rebound: reply.naturalness?.rebound ?? null,
    legacy,
    conversation,
    attempts: reply.attempts,
    failureReason,
    externalEffects: false as const,
    autoSendAllowed: false as const,
  });
}

// ---------------------------------------------------------------------------
// La lecture humaine
// ---------------------------------------------------------------------------

/**
 * Rend l'observation lisible pour un humain (§24).
 *
 * Un seul bloc par réponse, avec les deux brouillons côte à côte et leurs
 * verdicts. Aucun message de prospect n'y figure : ce qui le représente est sa
 * longueur, la bande qu'elle produit et le nombre d'éléments concrets qu'il
 * portait.
 */
export function renderShadowObservation(observation: ShadowObservation): string {
  const lines: string[] = [
    `SHADOW ${observation.status} — ${observation.inboundMessageId}`,
    `  canal              ${observation.channel}`,
    `  D2                 ${observation.category} (${observation.confidence.toFixed(2)}) → ${observation.nextAction}`,
    `  objectif           ${observation.goal} | décision ${observation.decision}${
      observation.escalationReason === null ? '' : ` (${observation.escalationReason})`
    }`,
    `  maturité appel     ${observation.callReadiness}`,
    `  style              ${observation.styleAddressMode} / ${observation.styleLength} / confiance ${observation.styleConfidence} (${observation.styleObservedMessages} msg)`,
    `  budget du tour     ${observation.lengthBudget.band} → ${observation.lengthBudget.maxSentences} phrase(s), ${observation.lengthBudget.maxChars} car. (message reçu : ${observation.lengthBudget.inboundChars} car.)`,
    `  éléments concrets  ${observation.anchorCount} | rebond ${observation.rebound ?? '—'}`,
    `  tentatives         ${observation.attempts}`,
  ];

  for (const draft of [observation.legacy, observation.conversation]) {
    if (draft === null) continue;
    lines.push(
      '',
      `  [${draft.source}] ${draft.chars} car. / ${draft.words} mots / ${draft.sentences} phrase(s) / ${draft.questions} question(s) / ${draft.emojis} emoji(s)`,
      `    garde-fous     ${draft.guardrailBlocked ? 'BLOQUANT' : 'ok'}${
        draft.guardrailCodes.length === 0 ? '' : ` [${draft.guardrailCodes.join(', ')}]`
      }`,
      `    naturalité     ${draft.naturalnessVerdict}${
        draft.naturalnessCodes.length === 0 ? '' : ` [${draft.naturalnessCodes.join(', ')}]`
      }`,
      `    « ${draft.excerpt} »`,
    );
  }

  if (observation.legacy === null) lines.push('', '  [legacy] aucun brouillon canonique sur ce tour.');
  if (observation.conversation === null && observation.status !== 'FAILED') {
    lines.push('  [conversation] le cerveau a conclu qu’il ne fallait pas écrire.');
  }
  if (observation.failureReason !== null) lines.push(`  échec : ${observation.failureReason}`);

  lines.push('', '  Aucun envoi, aucune écriture, aucun brouillon persisté.');
  return lines.join('\n');
}
