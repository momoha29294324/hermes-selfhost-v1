/**
 * CONVERSATION-R1 / R1.1 — le cerveau conversationnel.
 *
 * R1.1 ne change pas où ce module se pose ni ce qu'il rend. Il change ce qu'on
 * lui demande d'écrire : non plus « la réponse de Hermes », mais la prochaine
 * phrase naturelle de la conversation (§6). Et il ajoute la seule chose qui
 * rende cette exigence vérifiable — un contrôle déterministe relu AVANT que le
 * brouillon soit rendu, avec une unique tentative de correction. Un modèle à
 * qui on dit « sois naturel » l'est en moyenne ; ce qui est mesuré l'est
 * toujours.
 *
 * Ce module ne crée PAS un second pipeline. Il se pose exactement là où
 * `generateReplyDraft` (R6B-D2) se posait, avec les mêmes entrées (`ReplyContext`,
 * `StoredAnalysis`), la même sortie (`DraftResult`, donc le même `persistDraft`
 * et le même statut `PROPOSED`), et les mêmes garde-fous (`checkReplyDraft`).
 * Ce qu'il ajoute tient en une phrase : le modèle voit désormais le FIL, l'ÉTAT
 * et le STYLE, au lieu d'un unique message hors contexte.
 *
 * Deux conséquences assumées :
 *
 *   1. **Une nouvelle version de prompt.** Le dépôt pose qu'un prompt différent
 *      ne partage pas un numéro de version avec un autre, sans quoi
 *      `prompt_version` cesse de dire ce qui a réellement été demandé. Le
 *      chemin R6B-D2 garde donc sa version, intacte, et reste utilisable ; le
 *      cerveau porte la sienne.
 *
 *   2. **Aucun envoi.** Il n'y a pas d'import de provider, pas d'identité
 *      d'expéditeur, pas de file sortante dans ce fichier ni dans ses
 *      dépendances. `decideReply` porte `autoSendAllowed: false` comme littéral
 *      de type. R1 produit un texte destiné à un humain, point.
 */

import { currentUtterance, type LogicalUtterance } from '@/lib/conversation/burst';
import {
  answerBlockedByGaps,
  buildGrounding,
  renderGroundingBlock,
  type Grounding,
} from '@/lib/conversation/grounding';
import { loadConversationGuards, type ConversationGuards } from '@/lib/conversation/guards';
import { assessOfferProgression, type OfferProgression } from '@/lib/conversation/offerProgression';
import { terminalCategoryIn } from '@/lib/conversation/autonomy';
import { BOOKING_MECHANISM_DEFAULT } from '@/lib/sales/booking';
import {
  loadLiveBookingIntent,
  loadConfirmedBookingDestination,
  resolveBookingMechanism,
} from '@/lib/sales/bookingStore';
import {
  assessAppointmentQualification,
  renderObjectiveBlock,
  type AppointmentAssessment,
  type IcpConformity,
} from '@/lib/sales/objective';
import { renderOfferBlock, trialDisclosure, type TrialDisclosure } from '@/lib/sales/offer';
import {
  contactPurposeDisclosure,
  renderContactPurposeBlock,
  type ContactPurposeDisclosure,
} from '@/lib/sales/contactPurpose';
import {
  ANSWER_FIRST_DIRECTIVE,
  acquisitionDisclosure,
  renderAcquisitionServiceBlock,
  type AcquisitionDisclosure,
} from '@/lib/sales/acquisitionService';
import { loadIcpConformity } from '@/lib/sales/conformity';
import {
  emptyBookingSnapshot,
  loadBookingSnapshot,
  type BookingSnapshot,
} from '@/lib/booking/runtime';
import { renderBookingBlock } from '@/lib/booking/prompt';
import type { Interval } from '@/lib/booking/availability';
import type { Appointment } from '@/lib/booking/store';
import { checkBookingStatement, presentedDurationSentence } from '@/lib/booking/statement';
import { loadBookingPolicy } from '@/lib/config/load';
import { readCommercialDemands } from '@/lib/conversation/commercialPolicy';
import { resolvePriceSubject } from '@/lib/sales/priceSubject';
import {
  buildSalesKnowledgeInjection,
  renderSalesKnowledgeBlock,
  type SalesKnowledgeInjection,
} from '@/lib/sales/injection';
import {
  checkNaturalness,
  computeLengthBudget,
  concreteAnchors,
  renderCorrections,
  renderLengthDirective,
  type LengthBudget,
  type NaturalnessReport,
} from '@/lib/conversation/naturalness';
import { decideReply, type ReplyDecision } from '@/lib/conversation/decision';
import { renderLearningBlock, type LearningInjection } from '@/lib/learning/injection';
import { readSignals, type ConversationSignals, type ObjectionTopic, type QuestionTopic } from '@/lib/conversation/signals';
import { deriveConversationState, renderStateBlock, type ConversationState } from '@/lib/conversation/state';
import { buildStyleProfile, type StyleProfile } from '@/lib/conversation/style';
import { loadConversationThread, renderThreadBlock, type ConversationThread } from '@/lib/conversation/thread';
import { CONVERSATION_FRAME, HERMES_VOICE, renderStyleDirective } from '@/lib/conversation/voice';
import type { Sql } from '@/lib/db/sql';
import type { ModelRouter } from '@/lib/models/router';
import type { GuardrailFlag } from '@/lib/pipeline/guardrails';
import type { StoredAnalysis } from '@/lib/replies/analyses';
import type { ReplyContext } from '@/lib/replies/context';
import type { ReplyCategory } from '@/lib/replies/taxonomy';
import { DraftFailure, MAX_DRAFT_CHARS, checkReplyDraft, sha256Hex, type DraftResult } from '@/lib/replies/draft';

/**
 * Les versions de consigne vivent désormais dans un module feuille
 * (`conversation/promptVersion.ts`) et sont RÉEXPORTÉES ici : `replies/draft.ts`
 * en a besoin et ne peut pas importer ce fichier — `brain.ts` importe `draft.ts`,
 * donc l'inverse ferait un cycle. Aucun appelant existant ne change.
 */
import { conversationPromptVersionFor } from '@/lib/conversation/promptVersion';

export {
  CONVERSATION_PROMPT_VERSION_EMAIL,
  CONVERSATION_PROMPT_VERSION_INSTAGRAM,
  CURRENT_DRAFT_PROMPT_VERSIONS,
  conversationPromptVersionFor,
} from '@/lib/conversation/promptVersion';

export const CONVERSATION_DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['body', 'rationale', 'used_facts'],
  properties: {
    body: { type: 'string', maxLength: 1200 },
    rationale: { type: 'string', maxLength: 300 },
    used_facts: { type: 'array', minItems: 0, maxItems: 4, items: { type: 'string' } },
  },
} as const;

// ---------------------------------------------------------------------------
// Le prompt
// ---------------------------------------------------------------------------

const CHANNEL_VOICE: Readonly<Record<'email' | 'instagram_dm', string>> = Object.freeze({
  email: "par email : court, direct, poli sans être formel, sans jargon d'agence.",
  instagram_dm:
    "en message privé Instagram : très court, direct, sans formule d'appel ni signature, poli sans être formel, sans jargon d'agence.",
});

/**
 * Ce que l'objectif du tour demande concrètement.
 *
 * C'est ici que vit l'anti-amnésie de §5 : « n'explique pas ce qui a déjà été
 * expliqué » n'est pas une consigne générale de politesse, c'est une consigne
 * attachée à un objectif, avec la liste de ce qui a déjà été couvert juste
 * au-dessus dans le prompt.
 */
const GOAL_BRIEF: Readonly<Record<ConversationState['goal'], string>> = Object.freeze({
  UNDERSTAND_NEED:
    "Cherche à comprendre. UNE question courte sur leur situation, rien d'autre. Pas d'argumentaire, pas de proposition d'échange.",
  QUALIFY_LIGHTLY:
    "L'échange est engagé. Avance d'un cran avec UNE question courte, facile à répondre, qui part de ce qu'ils viennent de dire. Ne repose pas une question déjà posée.",
  ANSWER_QUESTION:
    "Réponds à CE qui est demandé, précisément, avec ce que tu sais réellement — et rien de plus. N'empile pas un argumentaire par-dessus la réponse.",
  HANDLE_OBJECTION:
    "Prends le frein au sérieux. Réponds honnêtement dans le contexte de ce qui a DÉJÀ été dit dans ce fil, et laisse la porte ouverte sans insister ni contre-argumenter.",
  PROPOSE_CALL:
    "Le moment est mûr : propose un échange court, simplement, et laisse la personne choisir le moment. Une seule proposition, pas d'insistance.",
  ACKNOWLEDGE_AND_CLOSE:
    "Accuse réception sans négocier et referme proprement, en une phrase. Ne propose aucune alternative, ne plaide pas, ne tente aucun retournement.",
  AWAIT_HUMAN:
    "Un humain doit reprendre : n'écris qu'un accusé de réception neutre et très court, sans engagement commercial.",
});

const systemFor = (channel: 'email' | 'instagram_dm'): string =>
  `Tu écris la réponse de Hermes (petite agence d'acquisition) à un professionnel du atelier/prestation standard, dans une conversation DÉJÀ ENGAGÉE.

Tu écris en français, comme une vraie personne qui répond ${CHANNEL_VOICE[channel]}

${CONVERSATION_FRAME}

${HERMES_VOICE}

Interdictions absolues :
- inventer un fait, un chiffre, un résultat, un prix, un délai ou une référence client ;
- citer une étude de cas, un résultat chiffré ou un montant : aucun n'est autorisé dans cette réponse ;
- affirmer une absence non vérifiée (« vous n'avez pas de site », « vous ne faites pas de pub ») ;
- promettre un résultat, garantir quoi que ce soit, créer une urgence ou une rareté ;
- insérer un lien, une URL, un lien de calendrier ou de réservation : aucun n'est configuré ;
- répéter ce qui a déjà été dit dans ce fil : ni le pitch, ni une question déjà posée, ni une proposition d'échange déjà faite ;
- recommencer la présentation depuis le début alors que la conversation est engagée ;
- laisser une variable de gabarit non remplie.

Ce que tu dois faire :
- répondre à ce que la personne vient d'écrire, dans le contexte de tout le fil ;
- rester sous ${MAX_DRAFT_CHARS} caractères — et très en dessous : vise le budget donné plus bas ;
- terminer sur une phrase complète ;
- ne poser au maximum qu'une seule question.

Réponds uniquement en JSON conforme au schéma.`;

// ---------------------------------------------------------------------------
// Le résultat
// ---------------------------------------------------------------------------

export interface ConversationReply {
  /** Le brouillon, dans la forme exacte que `persistDraft` attend. */
  readonly draft: DraftResult | null;
  /**
   * HERMES-MULTI-TURN-BURSTS-R1 — la prise de parole entière, et non la
   * dernière bulle.
   *
   * Tout ce qui LIT le message reçu part d'ici : le lexique commercial, le
   * sujet du prix, le cadre d'énonciation, le budget de longueur, les
   * citations vérifiées et le bloc que le modèle a sous les yeux. Une seule
   * lecture pour tous — deux lectures voisines du « message reçu » finiraient
   * par diverger, et c'est toujours la plus indulgente qui déciderait.
   */
  readonly utterance: LogicalUtterance;
  readonly category: StoredAnalysis['classification'];
  readonly state: ConversationState;
  readonly style: StyleProfile;
  readonly signals: ConversationSignals;
  readonly grounding: Grounding;
  readonly decision: ReplyDecision;
  readonly thread: ConversationThread;
  /** Le palier commercial du tour. Calculé ICI depuis R1 de cette mission. */
  readonly offer: OfferProgression;
  /** Les faits durables du prospect, lus une fois pour tout le tour. */
  readonly guards: ConversationGuards;
  /** La catégorie terminale du fil, courant compris. Jamais les tours suivants. */
  readonly terminalCategoryInThread: ReplyCategory | null;
  /** La conformité de ciblage OBSERVABLE. Rien n'est rejugé (§35). */
  readonly icpConformity: IcpConformity;
  /** §3 à §5 — cette conversation vaut-elle un appel ? */
  readonly appointment: AppointmentAssessment;
  /**
   * HERMES-BOOKING-MECHANISM-R1 — l'URL de réservation CONFIRMÉE, s'il y en a
   * une. `null` est le cas du dépôt aujourd'hui, et il rend la garde de lien
   * strictement identique à ce qu'elle était.
   */
  readonly bookingUrl: string | null;
  /**
   * HERMES-NATIVE-BOOKING-R1 — l'agenda RÉEL, lu une fois pour tout le tour.
   *
   * Distinct de `bookingUrl`, qui appartient au mécanisme EXTERNE de 0053 et
   * reste `null` : celui-ci est l'agenda natif, et il n'a pas de lien. Les deux
   * cohabitent sans se toucher — une destination confirmée transmettrait un
   * lien, cet agenda-ci propose des créneaux, et aucune des deux lectures ne
   * peut faire naître l'autre.
   */
  readonly booking: BookingSnapshot;
  /**
   * §19 — a-t-on le droit de PROPOSER un créneau à ce tour ?
   *
   * Recopié de `appointment.qualification`, jamais recalculé : la barre est
   * celle que `assessAppointmentQualification` tenait déjà, et elle n'a pas
   * bougé d'un cran dans ce round.
   */
  readonly mayProposeBooking: boolean;
  /** §27 — l'essai peut-il être mis sur la table à ce tour ? */
  readonly trialDisclosure: TrialDisclosure;
  /**
   * HERMES-CONTACT-PURPOSE-R1 — le motif de contact entre-t-il dans le prompt ?
   *
   * Séparé de `trialDisclosure` à dessein : « pourquoi tu m'écris ? » et
   * « qu'est-ce que ça coûte ? » sont deux questions, et les répondre ensemble
   * transformerait la première en occasion de pitcher la seconde.
   */
  readonly contactPurpose: ContactPurposeDisclosure;
  /**
   * HERMES-ACQUISITION-SERVICE-TRUTH-R1 — quelles facettes de la vérité de
   * service entrent dans le prompt, et quels montants ce tour autorise.
   *
   * Séparé de `contactPurpose` et de `trialDisclosure` pour la même raison
   * qu'eux : « pourquoi tu m'écris », « ce que tu fais » et « ce que coûte le
   * test » sont trois questions, et les répondre ensemble transformerait la
   * première en occasion de dérouler les deux autres.
   */
  readonly acquisition: AcquisitionDisclosure;
  /**
   * Une vérité canonique couvre-t-elle ce qui vient d'être demandé ?
   *
   * Vrai dès qu'un des trois blocs de vérité est ouvert. Le prompt en tire le
   * principe RÉPONDS D'ABORD, et `checkNaturalness` en tire le droit de refuser
   * un brouillon qui répondrait par une question. Les deux lisent le MÊME
   * booléen — sans quoi le contrôle exigerait une réponse que le prompt n'avait
   * pas demandée.
   */
  readonly answerExpected: boolean;
  /** §18 — les repères montrés au modèle. `null` = aucun (§20). */
  readonly salesKnowledge: SalesKnowledgeInjection | null;
  /** Le budget de longueur du tour. Calculé sans modèle, donc toujours présent. */
  readonly lengthBudget: LengthBudget;
  /** Les éléments concrets que leur dernier message porte. Vide s'il n'en porte aucun. */
  readonly anchors: readonly string[];
  /** Les faits que le modèle déclare avoir utilisés. Vide si aucun brouillon. */
  readonly usedFacts: readonly string[];
  readonly guardrailFlags: readonly GuardrailFlag[];
  /**
   * Le contrôle de naturalité du brouillon rendu. `null` quand rien n'a été
   * rédigé.
   *
   * Séparé de `guardrailFlags` et de `draft.blocked` à dessein : la sécurité et
   * le style ne se mélangent pas. Un brouillon peut être parfaitement sûr et
   * parfaitement artificiel, et l'inverse ; les confondre apprendrait à un
   * relecteur à passer outre le mot « bloquant ».
   */
  readonly naturalness: NaturalnessReport | null;
  /** Combien de rédactions ont été tentées : 0, 1 ou 2. Jamais davantage. */
  readonly attempts: number;
  /** Le statut de publication. Constante : R1 ne connaît rien d'autre. */
  readonly publicationStatus: 'PROPOSED';
}

interface RawAnswer {
  readonly body: string;
  readonly rationale: string;
  readonly used_facts: readonly string[];
}

function parseAnswer(value: unknown): RawAnswer {
  const record = value as Record<string, unknown>;
  const body = record['body'];
  const rationale = record['rationale'];
  const usedFacts = record['used_facts'];
  if (typeof body !== 'string') throw new Error('champ `body` manquant ou non textuel');
  if (typeof rationale !== 'string') throw new Error('champ `rationale` manquant ou non textuel');
  if (!Array.isArray(usedFacts)) throw new Error('champ `used_facts` manquant ou non tabulaire');
  return { body, rationale, used_facts: usedFacts.map((fact) => String(fact)) };
}

// ---------------------------------------------------------------------------
// L'orchestration
// ---------------------------------------------------------------------------

/**
 * Lit les sujets déjà rencontrés sur les tours entrants ANTÉRIEURS.
 *
 * Les tours passés sont relus avec leur propre classification quand elle
 * existe, et avec `OTHER` sinon — pas avec la classification du message
 * courant, qui ne dit rien d'eux.
 */
function priorTopics(
  thread: ConversationThread,
): { questions: QuestionTopic[]; objections: ObjectionTopic[] } {
  const questions: QuestionTopic[] = [];
  const objections: ObjectionTopic[] = [];

  for (const turn of thread.inboundTurns) {
    if (turn.sourceId === thread.currentInboundId) continue;
    const signals = readSignals(turn.text, turn.classification ?? 'OTHER', thread);
    if (signals.questionTopic !== 'NONE') questions.push(signals.questionTopic);
    if (signals.objectionTopic !== 'NONE') objections.push(signals.objectionTopic);
  }

  return { questions, objections };
}

/**
 * Construit la compréhension complète d'un tour, sans appeler de modèle.
 *
 * Séparé de la rédaction pour une raison de testabilité : §18 demande vingt
 * scénarios dont la plupart portent sur la compréhension (style, état,
 * décision, ancrage) et non sur le texte produit. Les exercer sans modèle les
 * rend déterministes.
 */
/**
 * HERMES-SEMANTIC-GROUNDING-R1 — ce dont la compréhension a réellement besoin.
 *
 * `understandConversation` recevait un `StoredAnalysis` et n'en lisait que deux
 * champs. La signature disait donc « il faut une analyse déjà écrite en base »,
 * ce qui était faux et surtout bloquant : le tour unifié (`turn.ts`) doit
 * construire son prompt AVANT que le modèle n'ait rendu sa lecture, donc avant
 * qu'aucune analyse n'existe.
 *
 * `StoredAnalysis` satisfait ce type : aucun appelant existant ne change.
 */
export interface TurnReading {
  readonly classification: ReplyCategory;
  readonly confidence: number;
}

export type ConversationUnderstanding = Omit<
  ConversationReply,
  'draft' | 'usedFacts' | 'guardrailFlags' | 'naturalness' | 'attempts'
>;

export async function understandConversation(
  sql: Sql,
  context: ReplyContext,
  analysis: TurnReading,
): Promise<ConversationUnderstanding> {
  const thread = await loadConversationThread(sql, context);

  // HERMES-MULTI-TURN-BURSTS-R1 — la prise de parole entière, calculée UNE
  // fois et partagée par tout ce qui lit le message.
  //
  // Elle s'arrête au message qu'on traite : jamais un tour arrivé depuis.
  const utterance = currentUtterance(thread.turns, context.reply.id, context.reply.bodyText);

  // Le profil de style ne lit QUE les messages entrants — ceux de cette
  // personne. Y mêler nos propres tours ferait converger le profil vers notre
  // voix, et chaque tour se calquerait sur le précédent.
  const style = buildStyleProfile(thread.inboundTurns.map((turn) => ({ text: turn.text, at: turn.at })));

  const signals = readSignals(utterance.text, analysis.classification, thread);
  const topics = priorTopics(thread);

  const state = deriveConversationState({
    thread,
    counterparty: context.prospect.displayName,
    category: analysis.classification,
    signals,
    priorObjectionTopics: topics.objections,
    priorQuestionTopics: topics.questions,
  });

  const grounding = buildGrounding(context, signals, utterance.text);

  const decision = decideReply({
    category: analysis.classification,
    signals,
    state,
    groundingGaps: grounding.gaps,
    confidence: analysis.confidence,
  });

  // HERMES-TRIAL-COST-VS-POST-TRIAL-PRICING-R1 §6 — le sujet du prix demandé,
  // lu UNE fois et partagé par les quatre décisions qui en dépendent : le
  // palier commercial, ce que le prompt reçoit de l'essai, ce qu'il reçoit du
  // budget, et quels montants la garde acceptera. Les recalculer séparément les
  // ferait diverger, et c'est toujours le plus indulgent qui finirait par
  // décider.
  const priceSubject = resolvePriceSubject(utterance.text);

  const offer = assessOfferProgression({
    category: analysis.classification,
    signals,
    state,
    // §8 — sans lui, une question de prix réclamerait des conditions
    // commerciales même quand la vérité de l'essai y répond.
    priceSubject,
  });

  // La catégorie terminale se lit sur les tours JUSQU'À CELUI-CI, courant
  // compris — jamais sur ceux qui l'ont suivi. Le calcul vit ICI, et non plus
  // en double dans `assessment.ts` : deux lectures voisines de la même question
  // finissent toujours par diverger sur une borne, et c'est la plus indulgente
  // qui gagne.
  const currentIndex = thread.inboundTurns.findIndex(
    (turn) => turn.sourceId === thread.currentInboundId,
  );
  const upToCurrent =
    currentIndex < 0 ? thread.inboundTurns : thread.inboundTurns.slice(0, currentIndex + 1);
  const terminalCategoryInThread = terminalCategoryIn(
    upToCurrent.map((turn) => turn.classification),
  );

  const guards = await loadConversationGuards(sql, context.prospect.id, thread.channel);
  const icpConformity = await loadIcpConformity(sql, context.prospect.id);

  // HERMES-BOOKING-MECHANISM-R1 — la réservation, LUE, jamais supposée.
  //
  // Trois lectures qui n'autorisent rien : l'état du mécanisme (fail-closed,
  // `MISSING_BOOKING_MECHANISM` sur la moindre incertitude), la destination
  // confirmée s'il y en a une, et la piste vivante de ce prospect. Aucune
  // n'écrit, et aucune ne peut faire partir quoi que ce soit.
  //
  // La lecture est enveloppée plutôt que laissée nue, et ce n'est pas de la
  // prudence décorative : `understandConversation` tourne sur des bases qui
  // n'ont pas toutes la même migration (une base de test, une reprise en
  // cours). Une lecture qui lève doit rendre « aucune réservation », jamais
  // interrompre la compréhension du tour — et « aucune réservation » est
  // précisément le refus. Le mécanisme échouant en même temps, aucune
  // proposition ne peut naître d'une lecture ratée.
  const booking = await (async () => {
    try {
      const mechanism = await resolveBookingMechanism(sql);
      const destination =
        mechanism === 'BOOKING_MECHANISM_READY'
          ? await loadConfirmedBookingDestination(sql)
          : null;
      const intent = await loadLiveBookingIntent(sql, context.prospect.id);
      return { mechanism, destination, intent };
    } catch {
      return { mechanism: BOOKING_MECHANISM_DEFAULT, destination: null, intent: null };
    }
  })();
  const bookingMechanism = booking.mechanism;
  const bookingDestination = booking.destination;
  const bookingIntent = booking.intent;

  // HERMES-NATIVE-BOOKING-R1 — l'agenda NATIF, lu une fois pour tout le tour.
  //
  // Enveloppé pour la même raison exacte que la lecture ci-dessus, et avec la
  // même conséquence : une base sans la migration 0061, une configuration
  // absente ou une lecture qui lève rendent un agenda VIDE — donc aucun créneau
  // proposable et aucune réservation possible. « Je ne sais pas » vaut « je ne
  // propose rien », jamais « tout est libre ».
  //
  // La configuration est lue ici plutôt que passée en paramètre : `bookingPolicy`
  // décrit l'opérateur, pas le tour, et la faire remonter par tous les appelants
  // aurait obligé chaque test à la fabriquer pour ne rien en faire.
  const nativeBooking = await (async () => {
    try {
      const policy = loadBookingPolicy();
      return await loadBookingSnapshot(
        sql,
        {
          prospectId: context.prospect.id,
          channel: thread.channel,
          triggerInboundMessageId: context.reply.id,
          actor: 'hermes',
        },
        policy,
        new Date(context.reply.receivedAt),
      );
    } catch {
      try {
        return emptyBookingSnapshot(loadBookingPolicy());
      } catch {
        // Même la configuration est illisible : on rend un agenda fermé, dont
        // aucune fenêtre n'est ouverte. Rien ne peut en sortir.
        return emptyBookingSnapshot({
          calendarKey: 'unavailable',
          timezone: 'UTC',
          appointmentDurationMinutes: 30,
          presentedDuration: { minMinutes: 30, maxMinutes: 30 },
          slotGranularityMinutes: 30,
          minNoticeMinutes: 0,
          maxHorizonDays: 1,
          maxProposedSlots: 1,
          weeklyWindows: [],
          blackouts: [],
        });
      }
    }
  })();

  // La fraîcheur se lit comme partout ailleurs (§24) : sur l'heure de
  // RÉCEPTION, jamais sur l'ordre de traitement. Un message plus récent arrivé
  // depuis rend ce tour dépassé, et un tour dépassé ne propose pas de créneau.
  const conversationFresh =
    guards.latestInboundAt === null ||
    Date.parse(guards.latestInboundAt) <= Date.parse(context.reply.receivedAt);

  const appointment = assessAppointmentQualification({
    identityConfirmed: guards.identityConfirmed,
    suppressed: guards.suppressed,
    outreachState: guards.outreachState,
    terminalCategoryInThread,
    category: analysis.classification,
    signals,
    state,
    offerReadiness: offer.readiness,
    icpConformity,
    booking: {
      mechanism: bookingMechanism,
      intent: bookingIntent,
      // Un refus se lit sur la catégorie du tour, qui est déjà la lecture
      // faisant foi ailleurs. Rien n'est réinterprété ici.
      declined: analysis.classification === 'NOT_INTERESTED',
      conversationFresh,
    },
  });

  // §27 — l'essai n'est pas une accroche. Il n'entre dans le prompt que lorsque
  // la conversation l'appelle réellement.
  // §6 — « ça me coûte combien de tester ? » NOMME l'essai, même sans le mot.
  //
  // `TRIAL_TERMS` ne l'attrapait pas : son ancre refuse les formes verbales
  // (« tester », « essayer »), qui sont précisément celles sous lesquelles un
  // humain pose cette question. Le sujet de prix les lit, et un sujet
  // `TRIAL_COST` est par définition une question sur l'essai.
  //
  // Rien n'est élargi au-delà : `POST_TRIAL_PRICE` et `UNRESOLVED` n'ouvrent
  // pas l'essai, et un message qui ne parle pas d'argent ne le lit même pas.
  //
  // HERMES-TRIAL-IMPLEMENTATION-ROUTING-R1 — deux sujets de plus, et ils NOMMENT
  // l'essai par construction.
  //
  // « Pendant les 7 jours tu mets quoi en place ? » ne relevait aucune demande
  // commerciale (elle ne parle ni de payer, ni de ce qui est inclus au sens du
  // lexique) et aucun sujet de prix (elle ne parle pas d'argent). L'essai
  // n'entrait donc pas dans le prompt, alors que la personne venait de le
  // nommer — et que `TRIAL_FACTS` porte la réponse exacte : « pendant ces sept
  // jours, je mets en place au minimum les publicités Meta et le CRM ».
  //
  // Rien n'est élargi au-delà : ces deux sujets exigent tous deux une ancre
  // d'essai dans le message, `tests?` y refuse les formes verbales, et un
  // message qui ne parle pas de l'essai ne peut pas les relever.
  const asksAboutTrial =
    readCommercialDemands(utterance.text).some(
      (finding) => finding.demand === 'TRIAL_TERMS',
    ) ||
    priceSubject.subject === 'TRIAL_COST' ||
    signals.questionTopic === 'TRIAL_IMPLEMENTATION' ||
    signals.questionTopic === 'TRIAL_DURATION';
  const disclosure = trialDisclosure({
    offerStage: offer.stage,
    asksHowItWorks:
      signals.questionTopic === 'HOW_IT_WORKS' ||
      signals.questionTopic === 'WHAT_YOU_DO' ||
      signals.questionTopic === 'MORE_INFO',
    asksAboutTrial,
    humanNeeded: state.humanNeeded,
  });

  // HERMES-CONTACT-PURPOSE-R1 — le motif, seulement quand on le DEMANDE.
  //
  // Lu depuis les signaux déjà calculés, jamais recalculé ici, et jamais
  // déclenché par autre chose qu'une question : un prospect qui répond à ce
  // qu'on lui a demandé ne reçoit pas une explication qu'il n'a pas réclamée.
  const purpose = contactPurposeDisclosure({
    questionTopic: signals.questionTopic,
    humanNeeded: state.humanNeeded,
  });

  // HERMES-ACQUISITION-SERVICE-TRUTH-R1 — la vérité de service, facette par
  // facette, et seulement quand on la DEMANDE.
  //
  // Même mécanique que les deux au-dessus, et pour la même raison : un prospect
  // qui répond à ce qu'on lui a demandé ne reçoit pas une explication de ce
  // qu'on fait. La différence est qu'ici le bloc n'est même pas entier — un
  // sujet ouvre les facettes qui le concernent, pas les dix.
  const acquisition = acquisitionDisclosure({
    questionTopic: signals.questionTopic,
    humanNeeded: state.humanNeeded,
    // §6 — `questionTopic` seul ne suffit pas : « et ça me coûte combien de
    // tester ? » sort de `readSignals` en `PRICE`, un sujet qui n'ouvre aucune
    // facette. Sans cette entrée, le modèle recevrait la consigne de répondre
    // et pas de quoi le faire.
    priceSubject,
  });

  // Une vérité canonique couvre-t-elle CE QU'ON VIENT DE DEMANDER ?
  //
  // Deux conditions, et la seconde est celle qui empêche la règle de se
  // retourner contre le dépôt.
  //
  // La première : une vérité est réellement ouverte — une facette de service,
  // le motif de contact, ou l'essai que la personne a NOMMÉ elle-même. C'est
  // volontairement plus étroit que `disclosure === 'ALLOWED'`, qui vaut vrai
  // dès le palier `EXPLAIN_MODEL` sans que personne n'ait parlé du test :
  // exiger une réponse factuelle sur cette base reviendrait à exiger qu'on
  // parle de l'essai à quelqu'un qui demandait autre chose.
  //
  // La seconde : aucun manque ne dit déjà « on ne sait pas ». Sur une question
  // de prix, « ça dépend de ce qu'il y a à mettre en place » est la réponse que
  // `PRICING_POLICY_MISSING` demande textuellement d'écrire ; la traiter comme
  // une esquive ferait s'annuler deux règles du dépôt.
  //
  // Lu depuis ce qui a déjà été décidé, jamais recalculé : le prompt et le
  // contrôle de naturalité doivent lire la même chose, sinon le second reproche
  // au modèle de ne pas avoir répondu avec des faits que le premier ne lui a
  // pas donnés.
  const answerExpected =
    !answerBlockedByGaps(grounding.gaps) &&
    (acquisition.facets.length > 0 || purpose === 'ALLOWED' || asksAboutTrial);

  const salesKnowledge = buildSalesKnowledgeInjection({
    context: {
      goal: state.goal,
      offerStage: offer.stage,
      questionTopic: signals.questionTopic,
      objectionTopic: signals.objectionTopic,
      appointmentQualification: appointment.qualification,
    },
  });

  return {
    category: analysis.classification,
    offer,
    guards,
    terminalCategoryInThread,
    icpConformity,
    appointment,
    bookingUrl: bookingDestination?.bookingUrl ?? null,
    booking: nativeBooking,
    // §19 — la même barre qu'avant ce round, recopiée et non rejugée.
    mayProposeBooking: appointment.qualification === 'QUALIFIED_FOR_CALL',
    trialDisclosure: disclosure,
    contactPurpose: purpose,
    acquisition,
    answerExpected,
    salesKnowledge,
    state,
    style,
    signals,
    grounding,
    decision,
    thread,
    utterance,
    // Le budget se lit sur le message COURANT, pas sur l'habitude : quelqu'un
    // qui a développé hier et écrit « ok » aujourd'hui attend une réponse à
    // « ok ». Le profil sert au registre, le message du jour à la longueur.
    lengthBudget: computeLengthBudget(utterance.text, thread.channel),
    anchors: Object.freeze(concreteAnchors(utterance.text)),
    publicationStatus: 'PROPOSED',
  };
}

/**
 * Combien de fois on réécrit. Deux, jamais trois.
 *
 * Une correction est utile : le premier jet d'un modèle est souvent trop long
 * ou ouvre par un remerciement, et lui montrer le constat suffit à le corriger.
 * Une deuxième correction ne l'est plus : elle coûte un appel de plus pour un
 * gain qui n'est plus lisible, et une boucle « jusqu'à ce que ce soit bon »
 * s'arrêterait un jour sur un compteur arbitraire de toute façon — autant que
 * ce compteur soit petit, visible, et décidé ici.
 */
const MAX_DRAFT_ATTEMPTS = 2;

interface Attempt {
  readonly draft: DraftResult;
  readonly usedFacts: readonly string[];
  readonly guardrailFlags: readonly GuardrailFlag[];
  readonly naturalness: NaturalnessReport;
}

function blockingCount(report: NaturalnessReport): number {
  return report.findings.filter((finding) => finding.severity === 'BLOCKING').length;
}

/**
 * Choisit entre deux jets.
 *
 * L'ordre est celui des enjeux : un brouillon que les garde-fous bloquent est
 * pire que n'importe quelle maladresse de style, donc la sécurité tranche
 * d'abord. À sécurité égale, le moins artificiel gagne. À égalité parfaite, le
 * second — il a été écrit en connaissance du constat, et rien ne justifie de
 * préférer celui qui l'ignorait.
 */
function betterAttempt(first: Attempt, second: Attempt): Attempt {
  if (first.draft.blocked !== second.draft.blocked) return first.draft.blocked ? second : first;
  const firstBlocking = blockingCount(first.naturalness);
  const secondBlocking = blockingCount(second.naturalness);
  if (firstBlocking !== secondBlocking) return firstBlocking < secondBlocking ? first : second;
  if (first.naturalness.findings.length !== second.naturalness.findings.length) {
    return first.naturalness.findings.length < second.naturalness.findings.length ? first : second;
  }
  return second;
}

/**
 * Comprend, puis rédige quand cela a du sens.
 *
 * Rend un `ConversationReply` dont `draft` vaut `null` quand la décision est de
 * ne PAS écrire (arrêt, escalade). Ce n'est pas un échec : c'est la bonne
 * réponse, et elle porte sa raison dans `decision.escalationReason`.
 *
 * Quand un brouillon est écrit, il est relu par le contrôle de naturalité et,
 * s'il est jugé artificiel, réécrit UNE fois avec le constat sous les yeux du
 * modèle. Le résultat rendu est le meilleur des deux — pas le dernier.
 */
export interface ConversationReplyOptions {
  /**
   * Ce que la boucle d'apprentissage a observé (LEARNING-R1 §20).
   *
   * `null` ou absent — le cas par défaut, et le seul de ce round — laisse le
   * prompt EXACTEMENT tel qu'il était : le bloc n'est pas rendu vide, il n'est
   * pas rendu du tout, pas même une ligne blanche. C'est ce qui rend la
   * vérification de §25.27 possible par comparaison de chaînes.
   */
  readonly learning?: LearningInjection | null;
  /**
   * HERMES-NATIVE-BOOKING-R1 — ce que le runtime a CALCULÉ pour ce tour.
   *
   * Absents partout sauf sur la réécriture qui suit une écriture d'agenda, et
   * c'est le défaut du type : un appelant qui ne dit rien obtient exactement le
   * prompt d'avant ce round, au caractère près, dès lors qu'aucun créneau n'est
   * proposable — ce qui est le cas de la quasi-totalité des tours.
   */
  readonly bookingOffer?: readonly Interval[] | null;
  readonly bookingJustBooked?: Appointment | null;
  readonly bookingLostSlot?: Interval | null;
}

/**
 * Le PROMPT d'un tour, composé une seule fois pour les deux appelants.
 *
 * HERMES-SEMANTIC-GROUNDING-R1 — extrait de `buildConversationReply` pour que
 * le tour unifié (`turn.ts`) et la relecture d'un tour déjà classé lisent
 * littéralement le même texte. Deux compositions pour la même question
 * finiraient par diverger, et c'est toujours la plus indulgente qui gagne.
 *
 * Une ligne a disparu au passage : « LECTURE DE CE MESSAGE : <catégorie>
 * (confiance <x>) ». Elle renvoyait au modèle une étiquette que, dans le
 * chemin unifié, c'est LUI qui produit — un prompt qui affirme la réponse
 * qu'il demande. Les sous-signaux, eux, restent : ils sont déterministes et
 * lus du texte, pas de la catégorie.
 */
export function composeConversationPrompt(
  understanding: ConversationUnderstanding,
  options: ConversationReplyOptions = {},
): { readonly system: string; readonly prompt: string } {
  const channel = understanding.thread.channel;

  // HERMES-NATIVE-BOOKING-R1 §6/§19 — l'agenda, quand la conversation l'appelle.
  //
  // `justBooked` et `lostSlot` viennent des options : ils n'existent QUE sur la
  // seconde passe, quand le runtime a déjà écrit (ou échoué à écrire) et qu'on
  // fait réécrire le texte. Sur la première passe, le bloc ne porte que des
  // créneaux LIBRES, ce qui est tout ce que le modèle a besoin de savoir.
  //
  // Les créneaux ne sont montrés que si l'on a le droit de proposer OU si une
  // proposition existe déjà (auquel cas la personne peut y répondre, et le
  // modèle doit pouvoir la nommer). §19 tient : un tour ordinaire d'une
  // conversation non qualifiée ne voit aucun créneau.
  const bookingBlock = ((): readonly string[] => {
    const showSlots =
      understanding.mayProposeBooking || understanding.booking.latestProposal !== null;
    const rendered = renderBookingBlock({
      presentedDuration: presentedDurationSentence(understanding.booking.policy),
      liveAppointment: understanding.booking.liveAppointment,
      slots: options.bookingOffer ?? (showSlots ? understanding.booking.freeSlots : []),
      timezone: understanding.booking.policy.timezone,
      justBooked: options.bookingJustBooked ?? null,
      lostSlot: options.bookingLostSlot ?? null,
    });
    return rendered === null ? [] : [rendered, ''];
  })();

  const anchorLine =
    understanding.anchors.length > 0
      ? `ÉLÉMENTS CONCRETS QU’ILS VIENNENT DE CITER : ${understanding.anchors.join(', ')}\nRebondis sur l’un d’eux si c’est pertinent — n’en force aucun s’il ne l’est pas.`
      : "LEUR DERNIER MESSAGE NE PORTE AUCUN ÉLÉMENT CONCRET : n’en invente pas un, et reste sur ce qu'ils ont dit.";

  // §20 — l'apprentissage n'entre dans le prompt que s'il existe. Un tableau
  // vide s'aplatit sans laisser de trace dans le `join`, donc le prompt éteint
  // est le prompt d'avant, au caractère près.
  const learningBlock =
    options.learning === undefined || options.learning === null
      ? []
      : [renderLearningBlock(options.learning), ''];

  // §6 — l'OFFRE, seulement quand la conversation l'appelle.
  //
  // Un tour qui n'a rien à voir avec l'essai ne voit pas ce bloc du tout. Ce
  // n'est pas une économie de jetons : montrer une offre à un modèle lui donne
  // l'idée de s'en servir, et §27 demande précisément qu'il ne la balance pas
  // sur un « salut ».
  const offerBlock =
    understanding.trialDisclosure === 'ALLOWED'
      ? [renderOfferBlock(understanding.acquisition.quotableAmounts), '']
      : [];

  // HERMES-CONTACT-PURPOSE-R1 — le MOTIF, quand on vient de le demander.
  //
  // Placé AVANT l'offre : quand quelqu'un demande pourquoi on l'écrit, la
  // réponse est le motif, pas le produit. L'ordre du prompt est ce qu'un modèle
  // suit quand deux blocs pourraient s'appliquer.
  const purposeBlock =
    understanding.contactPurpose === 'ALLOWED' ? [renderContactPurposeBlock(), ''] : [];

  // HERMES-ACQUISITION-SERVICE-TRUTH-R1 — CE QU'ON FAIT, quand on le demande.
  const acquisitionBlock =
    understanding.acquisition.facets.length === 0
      ? []
      : [renderAcquisitionServiceBlock(understanding.acquisition.facets), ''];

  // RÉPONDS D'ABORD, hors vérité de service : rendu une seule fois, jamais deux.
  const answerFirstBlock =
    understanding.answerExpected && understanding.acquisition.facets.length === 0
      ? [ANSWER_FIRST_DIRECTIVE, '']
      : [];

  // §18/§20 — les repères de vente, s'il y en a.
  const salesBlock =
    understanding.salesKnowledge === null
      ? []
      : [renderSalesKnowledgeBlock(understanding.salesKnowledge), ''];

  const prompt = [
    renderThreadBlock(understanding.thread),
    '',
    renderStateBlock(understanding.state),
    '',
    renderGroundingBlock(understanding.grounding),
    '',
    renderStyleDirective(understanding.style),
    '',
    renderLengthDirective(understanding.lengthBudget),
    '',
    anchorLine,
    '',
    'CE QUE LA LECTURE DÉTERMINISTE DE CE MESSAGE RELÈVE',
    `- sujet de question : ${understanding.signals.questionTopic}`,
    `- sujet d'objection : ${understanding.signals.objectionTopic}`,
    `- signal d'achat : ${understanding.signals.buyingSignal}`,
    `- maturité pour un échange : ${understanding.signals.callReadiness}`,
    `- vaut-elle un échange de vive voix : ${understanding.appointment.qualification}`,
    '',
    // L'objectif d'abord : il cadre tout ce qui suit, et il ne dépend pas du
    // tour. Les repères empruntés viennent APRÈS l'offre et après les manques,
    // pour qu'aucun d'eux ne se lise comme une permission de les contourner.
    renderObjectiveBlock({
      mechanism: understanding.appointment.booking,
      bookingUrl: understanding.bookingUrl,
      // HERMES-NATIVE-BOOKING-R1 — l'agenda natif est ACTIF pour ce tour dès
      // qu'il porte quelque chose de réel : des créneaux libres qu'on a le
      // droit de proposer, une proposition en cours à laquelle répondre, ou un
      // rendez-vous déjà pris. Sinon, le bloc est celui d'avant ce round au
      // caractère près.
      nativeBooking:
        (understanding.mayProposeBooking && understanding.booking.freeSlots.length > 0) ||
        understanding.booking.latestProposal !== null ||
        understanding.booking.liveAppointment !== null,
    }),
    '',
    // L'agenda vient APRÈS l'objectif — il en est le moyen — et AVANT le motif
    // et l'offre : quand un créneau est sur la table, c'est de lui qu'on parle,
    // pas du produit.
    ...bookingBlock,
    ...purposeBlock,
    ...acquisitionBlock,
    ...offerBlock,
    ...answerFirstBlock,
    ...salesBlock,
    ...learningBlock,
    'CONSIGNE POUR CE TOUR',
    GOAL_BRIEF[understanding.state.goal],
    '',
    'Écris la réponse.',
  ].join('\n');

  return Object.freeze({ system: systemFor(channel), prompt });
}

/**
 * Relit un texte que le modèle vient d'écrire, et en tire des MESURES.
 *
 * Extrait pour la même raison que la composition du prompt : le tour unifié et
 * la relecture d'un tour déjà classé doivent appliquer LES MÊMES contrôles. Un
 * second barème ferait gagner celui qu'on a choisi de noter avec indulgence.
 */
export function evaluateConversationDraft(
  understanding: ConversationUnderstanding,
  context: ReplyContext,
  written: {
    readonly body: string;
    readonly rationale: string;
    readonly usedFacts: readonly string[];
    readonly model: string;
    readonly effort: string | null;
    readonly modelRunId: string | null;
  },
  /**
   * HERMES-NATIVE-BOOKING-R1 §11/§12 — ce que l'agenda autorise ce texte à
   * affirmer.
   *
   * Absent par défaut, et l'absence est un REFUS : sans rendez-vous écrit et
   * sans créneau calculé, `checkBookingStatement` refuse toute affirmation de
   * réservation et n'autorise aucun créneau nommé. Un appelant qui oublie de le
   * passer obtient donc plus strict, jamais plus permissif — c'est le sens que
   * ce dépôt donne à « fail-closed ».
   */
  booking: {
    readonly booked?: Appointment | null;
    readonly offered?: readonly Interval[];
    /**
     * Ce tour vient-il d'ÉCRIRE ce rendez-vous ?
     *
     * Il manquait à ce type, et le manque était SILENCIEUX : l'appelant le
     * passait déjà dans un objet nommé, où TypeScript ne signale pas les
     * propriétés excédentaires. La règle « un rendez-vous réservé doit être
     * nommé dans le texte » ne pouvait donc jamais se déclencher — un créneau
     * pouvait être pris dans l'agenda sans que le message ne le dise.
     *
     * Trouvé par le test « la réécriture reçoit le créneau RÉSERVÉ quand le
     * texte ne le nommait pas », qui échoue si on retire ce champ.
     */
    readonly writtenThisTurn?: boolean;
  } = {},
): Attempt {
  const channel = understanding.thread.channel;

  // Les garde-fous de R6B-D2, réutilisés tels quels. Une réponse multi-tour
  // n'a pas le droit d'inventer ce qu'une réponse mono-tour n'avait pas le
  // droit d'inventer, et deux jeux de règles finiraient par diverger — c'est
  // toujours le plus indulgent qui gagnerait.
  const guardrailFlags = [
    ...checkReplyDraft(written.body, context, {
      allowedBookingUrl: understanding.bookingUrl,
      // Vide sur tous les tours sauf celui qui demande le budget publicitaire.
      allowedAmounts: understanding.acquisition.quotableAmounts,
    }),
    // §11 — « Hermes ne dit jamais "c'est réservé" » quand ça ne l'est pas.
    //
    // Placé avec les autres garde-fous et non à côté : ils partagent le même
    // vocabulaire (`GuardrailFlag`), la même conséquence (`blocked`), et donc
    // la même porte de sortie. Un second barème ferait gagner le plus indulgent.
    ...checkBookingStatement(written.body, {
      booked: booking.booked ?? null,
      offered: booking.offered ?? [],
      timezone: understanding.booking.policy.timezone,
      now: new Date(context.reply.receivedAt),
      writtenThisTurn: booking.writtenThisTurn ?? false,
    }),
  ];

  const naturalness = checkNaturalness({
    body: written.body,
    lastInboundText: understanding.utterance.text,
    style: understanding.style,
    state: understanding.state,
    signals: understanding.signals,
    channel,
    previousOutboundTexts: understanding.thread.exposedOutboundTurns.map((turn) => turn.text),
    answerExpected: understanding.answerExpected,
  });

  return {
    draft: Object.freeze({
      body: written.body,
      bodySha256: sha256Hex(written.body),
      rationale: written.rationale,
      guardrailFlags: Object.freeze(guardrailFlags),
      blocked: guardrailFlags.some((flag) => flag.blocking),
      model: written.model,
      effort: written.effort,
      promptVersion: conversationPromptVersionFor(channel),
      modelRunId: written.modelRunId,
    }),
    usedFacts: Object.freeze(written.usedFacts),
    guardrailFlags: Object.freeze(guardrailFlags),
    naturalness,
  };
}

/** Le meilleur de deux jets, exporté pour le tour unifié. */
export { betterAttempt, MAX_DRAFT_ATTEMPTS };
export type { Attempt };

export async function buildConversationReply(
  sql: Sql,
  router: ModelRouter,
  context: ReplyContext,
  analysis: TurnReading,
  options: ConversationReplyOptions = {},
): Promise<ConversationReply> {
  const understanding = await understandConversation(sql, context, analysis);

  if (!understanding.decision.shouldDraft) {
    return Object.freeze({
      ...understanding,
      draft: null,
      usedFacts: Object.freeze([]),
      guardrailFlags: Object.freeze([]),
      naturalness: null,
      attempts: 0,
    });
  }

  const composed = composeConversationPrompt(understanding, options);

  const write = async (prompt: string): Promise<Attempt> => {
    const outcome = await router.run<RawAnswer>(
      {
        task: 'message',
        system: composed.system,
        prompt,
        schema: CONVERSATION_DRAFT_SCHEMA as unknown as Record<string, unknown>,
        inputRef: `conversation:${context.reply.id}`,
      },
      parseAnswer,
    );

    if (!outcome.ok || outcome.data === null) {
      throw new DraftFailure(
        outcome.error === 'llm_disabled' || outcome.error === 'route_none' ? 'model_unavailable' : 'model_error',
        `rédaction conversationnelle impossible pour ${context.reply.id} : ${outcome.error ?? 'raison inconnue'}`,
      );
    }

    const body = outcome.data.body.trim();
    if (body.length === 0) throw new DraftFailure('empty_body', `réponse vide pour ${context.reply.id}`);

    return evaluateConversationDraft(understanding, context, {
      body,
      rationale: outcome.data.rationale,
      usedFacts: outcome.data.used_facts,
      model: outcome.route.model,
      effort: outcome.route.effort,
      modelRunId: outcome.modelRunId,
    });
  };

  let best = await write(composed.prompt);
  let attempts = 1;

  if (best.naturalness.verdict === 'UNNATURAL' && MAX_DRAFT_ATTEMPTS > 1) {
    // Une seconde tentative RATÉE ne doit pas coûter la première : si le modèle
    // devient indisponible entre les deux appels, le brouillon déjà écrit reste
    // la réponse. L'inverse transformerait une amélioration facultative en
    // point de panne.
    try {
      const repaired = await write(
        [composed.prompt, '', renderCorrections(best.naturalness)].join('\n'),
      );
      attempts = 2;
      best = betterAttempt(best, repaired);
    } catch (error) {
      if (!(error instanceof DraftFailure)) throw error;
    }
  }

  return Object.freeze({
    ...understanding,
    draft: best.draft,
    usedFacts: best.usedFacts,
    guardrailFlags: best.guardrailFlags,
    naturalness: best.naturalness,
    attempts,
  });
}
