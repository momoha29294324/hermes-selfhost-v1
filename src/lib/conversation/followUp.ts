/**
 * HERMES-CONVERSATION-R2 §14 à §20 — la relance : deux, puis l'arrêt.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce module est, et ce qu'il n'est pas
 * ---------------------------------------------------------------------------
 * Il décide s'il y a lieu de relancer, laquelle des deux relances, et à partir
 * de quand. Il ne planifie rien lui-même : la date qu'il rend devient le
 * `not_before` d'un plan (`hermes_conversation_plans`), et c'est
 * `evaluateSchedule` — l'ordonnanceur du rail Instagram, inchangé — qui dira
 * ensuite si l'instant est ouvert. §14 demande une architecture minimale, et le
 * minimum est exactement cela : une décision, une date, et aucune horloge à
 * soi.
 *
 * §20 est tenu par ABSENCE plutôt que par discipline : ce fichier n'a aucun
 * compteur, aucun quota, aucune notion de « combien de relances par jour ». Une
 * relance est un effet Instagram comme un autre ; elle consomme les plafonds de
 * `config/instagram.json`, comptés par `loadSafetySnapshot`. Un second quota
 * serait la façon la plus simple de dépasser le premier sans le voir.
 *
 * ---------------------------------------------------------------------------
 * La séquence, et pourquoi elle s'arrête
 * ---------------------------------------------------------------------------
 *
 *     FIRST_TOUCH → FOLLOW_UP_1 → FOLLOW_UP_2 → STOP_NO_REPLY
 *
 * Trois messages sans une seule réponse, c'est déjà une réponse. §16 refuse la
 * séquence infinie, et le plafond n'est pas seulement un défaut : le schéma de
 * configuration le borne à deux (`followUp.maxAttempts`, max 2), si bien
 * qu'aucune édition de fichier ne peut demander cinq relances — il faudrait un
 * diff, donc une revue.
 *
 * ---------------------------------------------------------------------------
 * §17 — « pas maintenant » n'est pas « pas de réponse »
 * ---------------------------------------------------------------------------
 * Quelqu'un qui écrit « rappelez-moi en septembre » a répondu, et il a même dit
 * quand. Le traiter comme un silence serait le relancer dans trois jours ; le
 * traiter comme un refus serait perdre un prospect qui a dit oui-plus-tard. Le
 * délai demandé est donc LU quand il est lisible (`parseRequestedResume`), et
 * remplacé par une fenêtre prudente quand il ne l'est pas. Jamais deviné.
 */

import { CONVERSATION_POLICY_VERSION } from '@/lib/conversation/autonomy';
import {
  containsCorporateJargon,
  measureDraft,
  openingFamily,
} from '@/lib/conversation/naturalness';
import { normalizeForMatching } from '@/lib/conversation/text';
import type { ConversationPolicyConfig, InstagramRailConfig } from '@/lib/config/schema';
import { nextWindowOpening } from '@/lib/instagram/scheduler';
import type { OutreachState, ReplyCategory } from '@/lib/replies/taxonomy';

/**
 * L'identité de la politique de RELANCE.
 *
 * La même que celle des réponses, et c'est une décision : les deux sont les
 * deux moitiés d'une seule conversation autonome. Faire évoluer l'une sans
 * refermer les décisions de l'autre laisserait une relance partir sous des
 * règles de réponse abrogées. Réexportée sous son propre nom pour que la
 * dépendance se lise là où elle sert.
 */
export const CONVERSATION_FOLLOW_UP_POLICY_VERSION = CONVERSATION_POLICY_VERSION;

// ---------------------------------------------------------------------------
// Le vocabulaire
// ---------------------------------------------------------------------------

/** Où en est la séquence de relance d'un prospect. Dérivé, jamais stocké. */
export type FollowUpSequenceState = 'FIRST_TOUCH' | 'FOLLOW_UP_1' | 'FOLLOW_UP_2' | 'STOP_NO_REPLY';

/** Le genre d'intention qu'une relance produit, tel que le registre le porte. */
export type FollowUpKind = 'FOLLOW_UP_1' | 'FOLLOW_UP_2';

export type FollowUpOutcome =
  /** Une relance est due maintenant. Le runtime reste à consulter. */
  | 'FOLLOW_UP_DUE'
  /** Une relance aura lieu, plus tard. `dueAt` dit quand. */
  | 'FOLLOW_UP_SCHEDULED'
  /** Pas de relance pour l'instant ; un fait nouveau peut rouvrir. */
  | 'FOLLOW_UP_SKIP'
  /** Plus jamais de relance automatique sur ce prospect. */
  | 'FOLLOW_UP_STOP';

export type FollowUpReason =
  // --- Définitifs -----------------------------------------------------------
  | 'opt_out'
  | 'suppressed_state'
  | 'not_interested'
  | 'unsubscribe_requested'
  | 'channel_unusable'
  | 'conversation_closed'
  | 'reply_received'
  | 'max_attempts_reached'
  // --- Pas maintenant -------------------------------------------------------
  | 'first_touch_not_sent'
  | 'identity_changed'
  | 'contact_history_conflict'
  | 'policy_version_mismatch'
  | 'not_due_yet'
  | 'outside_window';

export interface FollowUpDecision {
  readonly outcome: FollowUpOutcome;
  /** La relance visée. `null` quand aucune ne l'est. */
  readonly step: FollowUpKind | null;
  readonly sequence: FollowUpSequenceState;
  readonly reason: FollowUpReason | null;
  readonly gate: string;
  readonly detail: string;
  /** L'instant à partir duquel la relance devient possible. `null` si aucune. */
  readonly dueAt: Date | null;
  /** D'où vient la date : la politique, ou une demande du prospect. */
  readonly dueBasis: 'policy_delay' | 'prospect_requested' | 'policy_not_now_default' | null;
  readonly reconsiderable: boolean;
}

// ---------------------------------------------------------------------------
// Les faits
// ---------------------------------------------------------------------------

export interface FollowUpFacts {
  readonly policyVersion: string;
  readonly prospectId: string;
  /** Le manifeste du premier message — le déclencheur d'une relance. */
  readonly manifestId: string;

  /** L'instant PROUVÉ où le premier message est parti. `null` ⇒ rien n'est parti. */
  readonly firstTouchSentAt: string | null;
  /** Combien de relances ont RÉELLEMENT été remises. 0, 1 ou 2. */
  readonly followUpsSent: number;
  /** L'instant de la dernière relance remise, `null` s'il n'y en a aucune. */
  readonly lastFollowUpAt: string | null;

  /** Combien de messages ce prospect a écrits. Zéro = séquence sans réponse. */
  readonly inboundCount: number;
  /** L'instant du message le plus récent, `null` s'il n'y en a aucun. */
  readonly lastInboundAt: string | null;
  /** La conclusion D2 du message le plus récent. */
  readonly lastCategory: ReplyCategory | null;
  /** Une catégorie terminale déjà rencontrée dans le fil. */
  readonly terminalCategoryInThread: ReplyCategory | null;
  /**
   * Le délai que le prospect a lui-même demandé, déjà lu par
   * `parseRequestedResume`. `null` quand rien de lisible n'a été dit.
   */
  readonly requestedResumeAt: string | null;

  readonly outreachState: OutreachState | null;
  readonly suppressed: boolean;
  /** L'identité du compte est-elle TOUJOURS celle approuvée au premier message ? */
  readonly identityConfirmed: boolean;
  /** Une autre intention, un doublon, un contact établi ailleurs. */
  readonly contactHistoryConflict: boolean;
}

/** Les catégories qui referment définitivement la séquence. */
const CLOSING_CATEGORIES: ReadonlySet<ReplyCategory> = new Set<ReplyCategory>([
  'UNSUBSCRIBE',
  'NOT_INTERESTED',
  'BOUNCE',
]);

const CLOSING_REASON: Readonly<Partial<Record<ReplyCategory, FollowUpReason>>> = Object.freeze({
  UNSUBSCRIBE: 'unsubscribe_requested',
  NOT_INTERESTED: 'not_interested',
  BOUNCE: 'channel_unusable',
});

/**
 * Où en est la séquence, lu sur les FAITS.
 *
 * Dérivé et jamais stocké, pour la même raison que l'état conversationnel de
 * R1 : une colonne « étape de relance » se désynchroniserait au premier message
 * parti hors de ce chemin, et il faudrait alors décider laquelle on croit.
 */
export function followUpSequenceState(facts: FollowUpFacts, maxAttempts: number): FollowUpSequenceState {
  if (facts.followUpsSent >= maxAttempts) return 'STOP_NO_REPLY';
  if (facts.followUpsSent === 0) return 'FIRST_TOUCH';
  return facts.followUpsSent === 1 ? 'FOLLOW_UP_1' : 'FOLLOW_UP_2';
}

/** La prochaine relance à produire, ou `null` quand la séquence est épuisée. */
function nextStep(facts: FollowUpFacts, maxAttempts: number): FollowUpKind | null {
  if (facts.followUpsSent >= maxAttempts) return null;
  return facts.followUpsSent === 0 ? 'FOLLOW_UP_1' : 'FOLLOW_UP_2';
}

// ---------------------------------------------------------------------------
// La décision
// ---------------------------------------------------------------------------

export interface FollowUpInput {
  readonly facts: FollowUpFacts;
  readonly config: ConversationPolicyConfig;
  readonly now: Date;
}

/**
 * Tranche : ce prospect doit-il être relancé, et quand ?
 *
 * L'ordre des portes est celui de leur durée, comme dans `autonomy.ts` : ce qui
 * ferme définitivement d'abord, ce qui attend ensuite. Le premier refus gagne.
 */
export function planFollowUp(input: FollowUpInput): FollowUpDecision {
  const { facts, config, now } = input;
  const maxAttempts = config.followUp.maxAttempts;
  const sequence = followUpSequenceState(facts, maxAttempts);

  const stop = (reason: FollowUpReason, gate: string, detail: string): FollowUpDecision =>
    Object.freeze({
      outcome: 'FOLLOW_UP_STOP' as const,
      step: null,
      sequence,
      reason,
      gate,
      detail,
      dueAt: null,
      dueBasis: null,
      reconsiderable: false,
    });

  const skip = (reason: FollowUpReason, gate: string, detail: string): FollowUpDecision =>
    Object.freeze({
      outcome: 'FOLLOW_UP_SKIP' as const,
      step: null,
      sequence,
      reason,
      gate,
      detail,
      dueAt: null,
      dueBasis: null,
      reconsiderable: true,
    });

  // ---- 1. L'exclusion enregistrée -----------------------------------------
  if (facts.suppressed) {
    return stop('opt_out', 'opt_out', 'ce commerce figure dans do_not_contact — aucune relance, jamais');
  }
  if (facts.outreachState === 'SUPPRESSED') {
    return stop('suppressed_state', 'outreach_state', 'état SUPPRESSED — terminal pour la machine');
  }

  // ---- 2. Ce que le fil dit déjà ------------------------------------------
  //
  // §17 le demande explicitement : « ne jamais relancer quelqu'un ayant dit
  // NOT_INTERESTED ». La porte est ici, en tête, et elle lit le FIL et pas
  // seulement l'état — un état peut avoir été écarté par la marque d'eau, un
  // message reçu ne s'efface pas.
  if (facts.terminalCategoryInThread !== null) {
    const reason = CLOSING_REASON[facts.terminalCategoryInThread] ?? 'conversation_closed';
    return stop(
      reason,
      'thread_terminal',
      `ce fil porte un ${facts.terminalCategoryInThread} — une conversation refermée ne se relance pas`,
    );
  }
  if (facts.lastCategory !== null && CLOSING_CATEGORIES.has(facts.lastCategory)) {
    const reason = CLOSING_REASON[facts.lastCategory] ?? 'conversation_closed';
    return stop(reason, 'category', `dernier message ${facts.lastCategory} — la séquence s’arrête`);
  }
  if (facts.outreachState === 'NOT_INTERESTED') {
    return stop('not_interested', 'outreach_state', 'état NOT_INTERESTED — la prospection froide est close');
  }
  if (facts.outreachState === 'BOUNCED') {
    return stop('channel_unusable', 'outreach_state', 'état BOUNCED — le canal ne délivre pas');
  }

  // ---- 3. La politique sous laquelle ces faits ont été lus -----------------
  if (facts.policyVersion !== CONVERSATION_FOLLOW_UP_POLICY_VERSION) {
    return skip(
      'policy_version_mismatch',
      'policy_version',
      `faits rassemblés sous « ${facts.policyVersion} », politique courante ` +
        `« ${CONVERSATION_FOLLOW_UP_POLICY_VERSION} » — une décision d’hier ne couvre pas les règles d’aujourd’hui`,
    );
  }

  // ---- 4. L'identité et l'historique de contact ---------------------------
  //
  // §18 : une relance planifiée doit être bloquée si l'identité a changé ou si
  // un doublon apparaît. Ces deux portes sont ici ET dans le crochet pré-effet,
  // et la redondance est délibérée : celle-ci empêche de PLANIFIER, l'autre
  // d'AGIR sur un plan devenu faux entre-temps.
  if (!facts.identityConfirmed) {
    return skip(
      'identity_changed',
      'identity',
      'le rapprochement entreprise ↔ compte n’est plus établi — relancer écrirait à quelqu’un qu’on n’identifie pas',
    );
  }
  if (facts.contactHistoryConflict) {
    return skip(
      'contact_history_conflict',
      'contact_history',
      'une autre intention ou un contact établi ailleurs porte sur ce commerce — une à la fois',
    );
  }

  // ---- 5. Y a-t-il seulement eu un premier message ? ----------------------
  if (facts.firstTouchSentAt === null) {
    return skip(
      'first_touch_not_sent',
      'first_touch',
      'aucun premier message prouvé parti — il n’y a rien à relancer',
    );
  }

  // ---- 6. Le prospect a-t-il répondu ? ------------------------------------
  //
  // §17 : « NOT_NOW n'est pas équivalent à NO_REPLY ». Une réponse gèle la
  // séquence sans réponse (`freezesNoReplySequence` dans la taxonomie D2) ; la
  // SEULE réponse qui produit encore une relance est un report explicite.
  if (facts.inboundCount > 0 && facts.lastCategory !== 'NOT_NOW') {
    return stop(
      'reply_received',
      'reply_received',
      'ce prospect a répondu — la séquence sans réponse est gelée, et la conversation appartient au rail de réponse',
    );
  }

  // ---- 7. La séquence est-elle épuisée ? ----------------------------------
  const step = nextStep(facts, maxAttempts);
  if (step === null) {
    return stop(
      'max_attempts_reached',
      'max_attempts',
      `${String(facts.followUpsSent)} relance(s) déjà remise(s) sur un plafond de ${String(maxAttempts)} — ` +
        'trois messages sans une seule réponse sont déjà une réponse',
    );
  }

  // ---- 8. La DATE --------------------------------------------------------
  const schedule = resolveDueAt(facts, config, step);

  const due = schedule.dueAt.getTime() <= now.getTime();
  return Object.freeze({
    outcome: due ? ('FOLLOW_UP_DUE' as const) : ('FOLLOW_UP_SCHEDULED' as const),
    step,
    sequence,
    reason: due ? null : ('not_due_yet' as const),
    gate: 'schedule',
    detail: due
      ? `${step} due depuis ${schedule.dueAt.toISOString()} (${schedule.basis})`
      : `${step} planifiée pour ${schedule.dueAt.toISOString()} (${schedule.basis})`,
    dueAt: schedule.dueAt,
    dueBasis: schedule.basis,
    reconsiderable: true,
  });
}

interface ResolvedDue {
  readonly dueAt: Date;
  readonly basis: NonNullable<FollowUpDecision['dueBasis']>;
}

/**
 * D'où part le compte à rebours, et de combien.
 *
 * Trois cas, et un seul point d'ancrage par cas — jamais `now`, qui ferait
 * repousser la relance à chaque passage du worker :
 *
 *   * un report explicite part de ce que le prospect a demandé, borné ;
 *   * la relance 1 part du PREMIER MESSAGE prouvé parti ;
 *   * la relance 2 part de la relance 1 remise.
 */
function resolveDueAt(
  facts: FollowUpFacts,
  config: ConversationPolicyConfig,
  step: FollowUpKind,
): ResolvedDue {
  const followUp = config.followUp;

  if (facts.lastCategory === 'NOT_NOW') {
    const anchor = Date.parse(facts.lastInboundAt ?? facts.firstTouchSentAt ?? '');
    const base = Number.isFinite(anchor) ? anchor : Date.parse(facts.firstTouchSentAt ?? '');

    if (facts.requestedResumeAt !== null) {
      const requested = Date.parse(facts.requestedResumeAt);
      if (Number.isFinite(requested) && Number.isFinite(base)) {
        // Les bornes ne sont pas une méfiance envers le prospect : la LECTURE
        // d'une date est déterministe mais faillible, et un plancher est ce qui
        // empêche une erreur d'analyse de devenir un harcèlement.
        const delay = Math.min(
          Math.max(requested - base, followUp.requestedMinDelayMs),
          followUp.requestedMaxDelayMs,
        );
        return { dueAt: new Date(base + delay), basis: 'prospect_requested' };
      }
    }
    return {
      dueAt: new Date((Number.isFinite(base) ? base : Date.now()) + followUp.notNowDefaultDelayMs),
      basis: 'policy_not_now_default',
    };
  }

  if (step === 'FOLLOW_UP_1') {
    const sent = Date.parse(facts.firstTouchSentAt ?? '');
    return {
      dueAt: new Date((Number.isFinite(sent) ? sent : Date.now()) + followUp.firstDelayMs),
      basis: 'policy_delay',
    };
  }

  const previous = Date.parse(facts.lastFollowUpAt ?? facts.firstTouchSentAt ?? '');
  return {
    dueAt: new Date((Number.isFinite(previous) ? previous : Date.now()) + followUp.secondDelayMs),
    basis: 'policy_delay',
  };
}

/**
 * §21/§30 — reporte une date dans la fenêtre ouverte la plus proche.
 *
 * La fenêtre EST celle du rail sortant : `nextWindowOpening` est appelé sur
 * `config/instagram.json → schedule`, sans copie ni variante. Une relance due
 * un dimanche à 3 h attend donc lundi 9 h, exactement comme un premier message.
 *
 * Rend la date telle quelle si aucune ouverture n'est trouvée sous quinze jours
 * — l'appelant verra un report sans échéance plutôt qu'une date fabriquée, et
 * c'est le comportement déjà retenu par l'ordonnanceur.
 */
export function postponeToWindow(dueAt: Date, config: InstagramRailConfig): Date {
  return nextWindowOpening(dueAt, config.schedule) ?? dueAt;
}

// ---------------------------------------------------------------------------
// §17 — lire une date que quelqu'un a dite
// ---------------------------------------------------------------------------

const MONTHS: Readonly<Record<string, number>> = Object.freeze({
  janvier: 1,
  fevrier: 2,
  février: 2,
  mars: 3,
  avril: 4,
  mai: 5,
  juin: 6,
  juillet: 7,
  aout: 8,
  août: 8,
  septembre: 9,
  octobre: 10,
  novembre: 11,
  decembre: 12,
  décembre: 12,
});

const WORD_NUMBERS: Readonly<Record<string, number>> = Object.freeze({
  un: 1,
  une: 1,
  deux: 2,
  trois: 3,
  quatre: 4,
  cinq: 5,
  six: 6,
  sept: 7,
  huit: 8,
  neuf: 9,
  dix: 10,
  quinze: 15,
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** Les durées, en jours, des unités qu'on sait lire. Rien d'autre n'est lu. */
const UNIT_DAYS: Readonly<Record<string, number>> = Object.freeze({
  jour: 1,
  jours: 1,
  semaine: 7,
  semaines: 7,
  mois: 30,
  an: 365,
  ans: 365,
  annee: 365,
  année: 365,
  annees: 365,
  années: 365,
});

export interface RequestedResume {
  readonly at: string;
  /** Ce qui a été lu, en clair, pour qu'un humain puisse contester la lecture. */
  readonly basis: string;
}

/**
 * Lit une date de reprise dans un message de report.
 *
 * DÉTERMINISTE et volontairement PAUVRE : elle ne reconnaît que des formes dont
 * le sens ne se discute pas. « Après les vacances », « quand ce sera plus
 * calme », « on verra » ne rendent RIEN — et rendre `null` est la bonne réponse,
 * parce que la politique a une fenêtre prudente pour ce cas et qu'une date
 * devinée serait une affirmation non observée (CLAUDE.md §2).
 *
 * `from` est l'instant de réception du message : « dans un mois » se compte à
 * partir du moment où la phrase a été écrite, jamais du moment où on la relit.
 */
export function parseRequestedResume(text: string, from: Date): RequestedResume | null {
  const body = normalizeForMatching(text).toLowerCase();

  // « dans deux semaines », « d'ici 3 mois », « sous 15 jours »
  const relative = body.match(
    /\b(?:dans|d'ici|sous)\s+(\d{1,3}|un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|quinze)\s+(jours?|semaines?|mois|ans?|ann[ée]es?)\b/u,
  );
  if (relative) {
    const rawCount = relative[1] ?? '';
    const unit = relative[2] ?? '';
    const count = WORD_NUMBERS[rawCount] ?? Number.parseInt(rawCount, 10);
    const days = UNIT_DAYS[unit];
    if (Number.isFinite(count) && count > 0 && days !== undefined) {
      return {
        at: new Date(from.getTime() + count * days * DAY_MS).toISOString(),
        basis: `${String(count)} ${unit}`,
      };
    }
  }

  // « la semaine prochaine », « le mois prochain », « l'année prochaine »
  const nextPeriod = body.match(/\b(?:la\s+semaine|le\s+mois|l'ann[ée]e)\s+(?:prochaine?|d'apr[èe]s)\b/u);
  if (nextPeriod) {
    const matched = nextPeriod[0];
    const days = matched.includes('semaine') ? 7 : matched.includes('mois') ? 30 : 365;
    return {
      at: new Date(from.getTime() + days * DAY_MS).toISOString(),
      basis: matched.trim(),
    };
  }

  // « en septembre », « à partir de janvier », « pas avant mars »
  const month = body.match(
    /\b(?:en|d[èe]s|[àa]\s+partir\s+de|pas\s+avant|apr[èe]s)\s+(janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[ûu]t|septembre|octobre|novembre|d[ée]cembre)\b/u,
  );
  if (month) {
    const name = month[1] ?? '';
    const target = MONTHS[name];
    if (target !== undefined) {
      return { at: firstDayOfNextOccurrence(from, target).toISOString(), basis: `mois de ${name}` };
    }
  }

  return null;
}

/**
 * Le premier jour de la prochaine occurrence de ce mois, à partir de `from`.
 *
 * En UTC, et sans fuseau : cette date est une BORNE de planification, pas une
 * heure d'envoi — c'est `postponeToWindow` qui la ramènera dans la fenêtre
 * locale du rail. Y mêler un fuseau ici ferait décider deux modules du même
 * moment.
 */
function firstDayOfNextOccurrence(from: Date, month: number): Date {
  const year = from.getUTCFullYear();
  const candidate = Date.UTC(year, month - 1, 1, 0, 0, 0, 0);
  if (candidate > from.getTime()) return new Date(candidate);
  return new Date(Date.UTC(year + 1, month - 1, 1, 0, 0, 0, 0));
}

/** La forme lisible des rapports : `FOLLOW_UP_STOP:not_interested`, … */
export function formatFollowUpDecision(decision: FollowUpDecision): string {
  return decision.reason === null ? decision.outcome : `${decision.outcome}:${decision.reason}`;
}

// ---------------------------------------------------------------------------
// §19 — ce qu'une relance a le droit d'être
// ---------------------------------------------------------------------------

/**
 * Le CADRAGE d'une relance, pour le rédacteur.
 *
 * Ce n'est pas un gabarit, et §19 l'interdit explicitement (« ne hardcode pas
 * un seul template »). C'est une consigne : ce qu'il faut faire, ce qu'il ne
 * faut pas faire, et l'unique raison d'écrire. Le TEXTE, lui, sortira du même
 * cerveau conversationnel que les réponses — pas d'un second moteur de message,
 * qui finirait par avoir sa propre voix.
 *
 * Les deux interdictions du milieu sont celles que la mission nomme : ne pas
 * répéter le premier message, ne pas culpabiliser. Les deux se vérifient
 * ensuite (`checkFollowUpDraft`), parce qu'une consigne de style se respecte en
 * moyenne et qu'une règle se vérifie.
 */
export const FOLLOW_UP_BRIEF = [
  'CE QUE TU ÉCRIS — UNE RELANCE',
  'Cette personne n’a pas répondu à ton premier message. Tu lui réécris UNE fois, court.',
  '',
  '- une seule phrase suffit le plus souvent, deux au maximum ;',
  '- au plus UNE question, courte et facile à répondre ;',
  '- ne répète pas le premier message : ni sa formulation, ni son ouverture, ni son argument ;',
  '- ne culpabilise pas : pas de « sans réponse de votre part », pas de « je me permets d’insister »,',
  '  pas de « je n’ai pas eu de retour » ;',
  '- n’ouvre pas par « je reviens vers vous suite à mon précédent message » ni par une formule',
  '  d’excuse : c’est le réflexe qui trahit une séquence automatique ;',
  '- donne une raison simple de répondre — une question précise sur leur situation vaut mieux',
  '  qu’une relance polie qui ne demande rien ;',
  '- n’ajoute aucun argument nouveau, aucun chiffre, aucune promesse.',
].join('\n');

export type FollowUpDraftCode =
  /** Reprend le premier message : sa formulation, ou son ouverture mot pour mot. */
  | 'REPEATS_FIRST_TOUCH'
  /** Plus d'une question. */
  | 'MULTIPLE_QUESTIONS'
  /** Plus long que ce qu'une relance justifie. */
  | 'TOO_LONG'
  /** Formule de plaquette — « je reviens vers vous », « dans le cadre de notre »… */
  | 'CORPORATE_JARGON'
  /** Reproche la non-réponse, même poliment. */
  | 'GUILT_TRIP'
  /** Ouverture d'accusé de réception là où il n'y a rien à accuser. */
  | 'GENERIC_OPENING';

export interface FollowUpDraftFinding {
  readonly code: FollowUpDraftCode;
  readonly message: string;
}

export interface FollowUpDraftCheck {
  /** Vrai quand AUCUN constat n'a été relevé. Une relance passe ou ne passe pas. */
  readonly ok: boolean;
  readonly findings: readonly FollowUpDraftFinding[];
}

/**
 * Les tournures qui font porter la non-réponse à celui qui n'a pas répondu.
 *
 * Un lexique NEUF, et c'est justifié : ni les garde-fous ni le contrôle de
 * naturalité ne connaissent cette famille — elle n'existe que dans une relance,
 * parce qu'il faut un silence pour pouvoir le reprocher. Volontairement
 * restreint aux formulations qui ne disent QUE cela.
 */
const GUILT_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['sans réponse de votre part', /\bsans\s+(retour|r[ée]ponse)\s+de\s+votre\s+part\b/i],
  ['je me permets d’insister', /\bje\s+me\s+permets\s+(d'insister|de\s+revenir|de\s+relancer)\b/i],
  ['je n’ai pas eu de retour', /\bje\s+n'ai\s+(pas\s+)?(eu|re[çc]u)\s+(de\s+)?(retour|r[ée]ponse)\b/i],
  ['vous n’avez pas eu le temps', /\bvous\s+n'avez\s+(pas\s+)?(eu\s+le\s+temps|pris\s+le\s+temps)\b/i],
  ['mon précédent message', /\b(mon|notre)\s+(pr[ée]c[ée]dent|dernier)\s+(message|mail|e-?mail)\b/i],
  ['relance', /\b(je\s+)?(vous\s+)?relance\b/i],
  ['toujours pas de nouvelles', /\btoujours\s+(pas\s+de\s+nouvelles|rien)\b/i],
];

/** Une relance est courte. Au-delà, ce n'est plus une relance, c'est un second pitch. */
export const MAX_FOLLOW_UP_CHARS = 240;
export const MAX_FOLLOW_UP_SENTENCES = 2;

/**
 * Relit une relance et dit ce qui, dedans, ne devrait pas partir.
 *
 * Fonction PURE et déterministe, comme le contrôle de naturalité dont elle
 * réutilise les lexiques : `containsCorporateJargon` et `openingFamily` sont
 * importés, pas recopiés. Une seconde définition de « formule de plaquette »
 * finirait par répondre non ici et oui là.
 *
 * La comparaison au premier message porte sur les MOTS PLEINS, pas sur la
 * chaîne : deux textes qui disent la même chose autrement se ressemblent, et
 * c'est cette ressemblance-là qui trahit une séquence.
 */
export function checkFollowUpDraft(input: {
  readonly body: string;
  readonly firstTouchBody: string;
  readonly maxChars?: number;
}): FollowUpDraftCheck {
  const body = input.body.trim();
  const normalized = normalizeForMatching(body);
  const findings: FollowUpDraftFinding[] = [];
  const add = (code: FollowUpDraftCode, message: string): void => {
    findings.push(Object.freeze({ code, message }));
  };

  const metrics = measureDraft(body);
  const maxChars = input.maxChars ?? MAX_FOLLOW_UP_CHARS;
  if (metrics.chars > maxChars) {
    add('TOO_LONG', `${String(metrics.chars)} caractères pour une relance (budget ${String(maxChars)})`);
  }
  if (metrics.sentences > MAX_FOLLOW_UP_SENTENCES) {
    add('TOO_LONG', `${String(metrics.sentences)} phrases : une relance en fait une, deux au plus`);
  }
  if (metrics.questions > 1) {
    add('MULTIPLE_QUESTIONS', `${String(metrics.questions)} questions dans une relance`);
  }

  if (containsCorporateJargon(body)) {
    add('CORPORATE_JARGON', 'formule de plaquette — une relance en est le terrain le plus fréquent');
  }

  const family = openingFamily(body);
  if (family !== null) {
    add('GENERIC_OPENING', `ouverture d’accusé de réception (${family}) : il n’y a rien à accuser`);
  }

  for (const entry of GUILT_PATTERNS) {
    if (entry[1].test(normalized)) {
      add('GUILT_TRIP', `reproche la non-réponse : « ${entry[0]} »`);
      break;
    }
  }

  const overlap = contentOverlap(body, input.firstTouchBody);
  if (overlap.sameOpening) {
    add('REPEATS_FIRST_TOUCH', 'la relance ouvre par les mêmes mots que le premier message');
  } else if (overlap.ratio >= 0.5) {
    add(
      'REPEATS_FIRST_TOUCH',
      `${String(Math.round(overlap.ratio * 100))} % des mots pleins sont ceux du premier message`,
    );
  }

  return Object.freeze({ ok: findings.length === 0, findings: Object.freeze(findings) });
}

/** Les mots pleins d'un texte, minuscules et sans ponctuation. */
function contentTokens(text: string): string[] {
  return normalizeForMatching(text)
    .toLowerCase()
    .split(/[^a-zà-öø-ÿ0-9]+/u)
    .filter((token) => token.length >= 4);
}

function contentOverlap(
  body: string,
  firstTouch: string,
): { readonly ratio: number; readonly sameOpening: boolean } {
  const draftTokens = contentTokens(body);
  const firstTokens = new Set(contentTokens(firstTouch));
  if (draftTokens.length === 0 || firstTokens.size === 0) {
    return { ratio: 0, sameOpening: false };
  }
  const shared = draftTokens.filter((token) => firstTokens.has(token)).length;
  const opening = draftTokens.slice(0, 3).join(' ');
  const firstOpening = contentTokens(firstTouch).slice(0, 3).join(' ');
  return {
    ratio: shared / draftTokens.length,
    sameOpening: opening.length > 0 && opening === firstOpening,
  };
}
