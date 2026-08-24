/**
 * LEARNING-R1 §9, §11, §14 — l'issue commerciale d'un prospect contacté.
 *
 * Ce fichier ne crée PAS un statut concurrent de `r6b_prospect_outreach_states`.
 * Il fait l'inverse : il lit l'état canonique, les messages canoniques et — dès
 * qu'une destination existera — la projection CRM, et il en DÉRIVE un rang sur
 * une échelle. Le rang est ce qui manquait, pas l'état : « REPLIED » et
 * « INTERESTED » sont deux valeurs d'une énumération que rien n'ordonne, et §14
 * demande précisément de pouvoir dire qu'un client gagné vaut mieux qu'une
 * réponse polie.
 *
 * ---------------------------------------------------------------------------
 * Ce que le fichier refuse de faire
 * ---------------------------------------------------------------------------
 *
 * Il n'invente aucun barreau. `CALL_BOOKED` et `CLIENT_WON` figurent dans
 * l'échelle parce que §9 les demande, et ils ne sont JAMAIS émis : aucune
 * source du dépôt ne les porte aujourd'hui — pas de calendrier, pas d'étape CRM
 * lue, `r6b_crm_projections` vide. Les marquer `NOT_OBSERVABLE` plutôt que de
 * les deviner est la seule lecture compatible avec CLAUDE.md §2, et c'est aussi
 * ce qui rend la lacune visible : un barreau qu'on ne peut pas observer est un
 * chantier nommé, pas un zéro silencieux.
 */

import type { OutreachState } from '@/lib/replies/taxonomy';
import type { ReplyCategory } from '@/lib/replies/taxonomy';

// ---------------------------------------------------------------------------
// L'échelle
// ---------------------------------------------------------------------------

/**
 * Les barreaux, du plus bas au plus haut.
 *
 * L'ordre du tableau EST la politique de §14 : c'est lui qui fait qu'un
 * `CLIENT_WON` l'emporte sur un `REPLIED`, et qu'un angle à 50 % de réponses
 * sans intérêt vaut moins qu'un angle à 20 % avec des appels.
 */
export const FUNNEL_STAGES = [
  'NO_REPLY',
  'REPLIED',
  'ENGAGED',
  'INTERESTED',
  'CALL_PROPOSED',
  'CALL_BOOKED',
  'CLIENT_WON',
] as const;

export type FunnelStage = (typeof FUNNEL_STAGES)[number];

/** Comment une relation s'arrête. `null` quand elle ne s'est pas arrêtée. */
export type TerminalOutcome = 'LOST' | 'UNSUBSCRIBED';

/** Le rang d'un barreau. Un entier, comparable, jamais une chaîne. */
export function funnelRank(stage: FunnelStage): number {
  return FUNNEL_STAGES.indexOf(stage);
}

/** Le plus haut des deux. Sert à faire monter un prospect, jamais descendre. */
export function highestStage(left: FunnelStage, right: FunnelStage): FunnelStage {
  return funnelRank(left) >= funnelRank(right) ? left : right;
}

// ---------------------------------------------------------------------------
// Ce qu'on sait observer, et ce qu'on ne sait pas
// ---------------------------------------------------------------------------

export type Observability =
  /** Une source canonique porte ce barreau, entièrement. */
  | 'OBSERVABLE'
  /** Une source le porte, mais incomplètement — la lacune est nommée. */
  | 'PARTIALLY_OBSERVABLE'
  /** Aucune source du dépôt ne le porte. Il ne sera jamais émis. */
  | 'NOT_OBSERVABLE';

export interface StageObservability {
  readonly level: Observability;
  /** D'où viendrait la preuve. Une phrase, lisible dans le rapport. */
  readonly source: string;
}

export const STAGE_OBSERVABILITY: Readonly<Record<FunnelStage, StageObservability>> = Object.freeze({
  NO_REPLY: Object.freeze({
    level: 'OBSERVABLE' as const,
    source: "outreach_events 'sent' sans message entrant corrélé",
  }),
  REPLIED: Object.freeze({
    level: 'OBSERVABLE' as const,
    source: 'r6b_inbound_messages corrélé EXACT ou HIGH_CONFIDENCE',
  }),
  ENGAGED: Object.freeze({
    level: 'OBSERVABLE' as const,
    source: 'au moins deux salves entrantes distinctes sur le même prospect',
  }),
  INTERESTED: Object.freeze({
    level: 'OBSERVABLE' as const,
    source: "r6b_prospect_outreach_states = 'INTERESTED' ou analyse ACTIVE 'INTERESTED'",
  }),
  CALL_PROPOSED: Object.freeze({
    level: 'PARTIALLY_OBSERVABLE' as const,
    source:
      "brouillon r6b_reply_drafts APPROVED/EDITED proposant un échange ; un message tapé à la main " +
      "hors de cette table ne laisse aucun texte observable",
  }),
  CALL_BOOKED: Object.freeze({
    level: 'NOT_OBSERVABLE' as const,
    source: "aucune source : ni calendrier, ni rendez-vous CRM lu par le dépôt",
  }),
  CLIENT_WON: Object.freeze({
    level: 'NOT_OBSERVABLE' as const,
    source: "aucune source : aucune étape CRM « gagné » n'est relue par le dépôt",
  }),
});

/** Les barreaux qu'aucune source ne porte. Un rapport le dit en toutes lettres. */
export function unobservableStages(): readonly FunnelStage[] {
  return FUNNEL_STAGES.filter((stage) => STAGE_OBSERVABILITY[stage].level === 'NOT_OBSERVABLE');
}

// ---------------------------------------------------------------------------
// L'issue d'un prospect
// ---------------------------------------------------------------------------

/**
 * D'où vient la conclusion.
 *
 * `CRM` d'abord — §9 demande de préférer les événements réels du CRM. Aucune
 * ligne n'existe aujourd'hui, mais la préférence est écrite ici plutôt que
 * dans une mission future, pour qu'elle n'ait pas à être redécouverte.
 */
export type OutcomeSource = 'CRM' | 'OUTREACH_STATE' | 'INBOUND_OBSERVATION';

export interface ProspectOutcome {
  readonly prospectId: string;
  /** Le canal du PREMIER envoi. Un prospect contacté deux fois garde le premier. */
  readonly channel: string;
  readonly manifestId: string | null;
  readonly firstSentAt: string;
  /** Le plus haut barreau atteint, observé. */
  readonly stage: FunnelStage;
  readonly terminal: TerminalOutcome | null;
  readonly source: OutcomeSource;
  readonly inboundCount: number;
  readonly inboundBursts: number;
  readonly firstReplyAt: string | null;
  /** Délai entre l'envoi et la première réponse. `null` s'il n'y a pas de réponse. */
  readonly firstReplyLatencyMs: number | null;
  /** L'état canonique, recopié tel quel. Jamais réécrit ici. */
  readonly outreachState: OutreachState | null;
  /** Les classifications ACTIVE rencontrées sur ce prospect, dédupliquées. */
  readonly classifications: readonly ReplyCategory[];
}

/**
 * L'écart au-delà duquel deux messages entrants sont deux SALVES.
 *
 * Instagram encourage à écrire trois bulles d'affilée ; les compter comme trois
 * tours ferait passer un unique « bonjour / oui / merci » pour une conversation
 * engagée. Cinq minutes est le compromis observable : au-delà, la personne est
 * revenue, ce qui est le fait qu'on veut compter.
 */
export const BURST_GAP_MS = 5 * 60 * 1000;

/** Compte les salves d'une suite d'horodatages triés. */
export function countBursts(timestamps: readonly string[]): number {
  if (timestamps.length === 0) return 0;
  let bursts = 1;
  for (let i = 1; i < timestamps.length; i += 1) {
    const previous = Date.parse(timestamps[i - 1] ?? '');
    const current = Date.parse(timestamps[i] ?? '');
    if (!Number.isFinite(previous) || !Number.isFinite(current)) continue;
    if (current - previous >= BURST_GAP_MS) bursts += 1;
  }
  return bursts;
}

export interface OutcomeInput {
  readonly prospectId: string;
  readonly channel: string;
  readonly manifestId: string | null;
  readonly firstSentAt: string;
  /** Horodatages des messages entrants corrélés, triés croissant. */
  readonly inboundAt: readonly string[];
  readonly outreachState: OutreachState | null;
  readonly classifications: readonly ReplyCategory[];
  /** Vrai quand un brouillon validé par un humain propose un échange. */
  readonly callProposedInValidatedReply: boolean;
  /** L'étape CRM lue chez le fournisseur, quand une projection existe. */
  readonly crmStage: string | null;
}

/**
 * Décide du barreau atteint.
 *
 * L'ordre des tests monte : on ne descend jamais un prospect à cause d'un signal
 * plus faible arrivé après. `INTERESTED` suivi d'un refus reste `INTERESTED`
 * comme barreau ATTEINT, avec `terminal = 'LOST'` — confondre les deux ferait
 * disparaître un angle qui a réellement intéressé quelqu'un.
 */
export function deriveOutcome(input: OutcomeInput): ProspectOutcome {
  const inboundCount = input.inboundAt.length;
  const bursts = countBursts(input.inboundAt);

  let stage: FunnelStage = 'NO_REPLY';
  let source: OutcomeSource = 'INBOUND_OBSERVATION';

  if (inboundCount > 0) stage = 'REPLIED';
  if (bursts >= 2) stage = highestStage(stage, 'ENGAGED');

  const interested =
    input.outreachState === 'INTERESTED' || input.classifications.includes('INTERESTED');
  if (interested) {
    stage = highestStage(stage, 'INTERESTED');
    source = input.outreachState === 'INTERESTED' ? 'OUTREACH_STATE' : 'INBOUND_OBSERVATION';
  }

  // §9 — l'événement CRM prime quand il existe. Il n'en existe aucun à ce jour ;
  // la branche vit ici pour que la préférence soit du code, pas une intention.
  if (input.crmStage !== null) source = 'CRM';

  // Un échange n'est « proposé » que par-dessus un intérêt : proposer un appel
  // à quelqu'un qui n'a pas répondu ne fait pas monter ce quelqu'un d'un cran.
  if (input.callProposedInValidatedReply && funnelRank(stage) >= funnelRank('INTERESTED')) {
    stage = highestStage(stage, 'CALL_PROPOSED');
  }

  // `CALL_BOOKED` et `CLIENT_WON` ne sont jamais atteints ici, et c'est
  // volontaire : voir `STAGE_OBSERVABILITY`.

  const terminal: TerminalOutcome | null =
    input.outreachState === 'SUPPRESSED' || input.classifications.includes('UNSUBSCRIBE')
      ? 'UNSUBSCRIBED'
      : input.outreachState === 'NOT_INTERESTED' || input.classifications.includes('NOT_INTERESTED')
        ? 'LOST'
        : null;

  const firstReplyAt = input.inboundAt[0] ?? null;
  const sentMs = Date.parse(input.firstSentAt);
  const replyMs = firstReplyAt === null ? Number.NaN : Date.parse(firstReplyAt);
  const latency =
    Number.isFinite(sentMs) && Number.isFinite(replyMs) && replyMs >= sentMs ? replyMs - sentMs : null;

  return Object.freeze({
    prospectId: input.prospectId,
    channel: input.channel,
    manifestId: input.manifestId,
    firstSentAt: input.firstSentAt,
    stage,
    terminal,
    source,
    inboundCount,
    inboundBursts: bursts,
    firstReplyAt,
    firstReplyLatencyMs: latency,
    outreachState: input.outreachState,
    classifications: Object.freeze([...new Set(input.classifications)]),
  });
}

/**
 * Compare deux issues sur l'échelle.
 *
 * Rend > 0 quand `left` a progressé plus loin. C'est la fonction que §11
 * demande : un client gagné passe devant une simple réponse, quelles que
 * soient les vitesses de réponse ou le nombre de messages échangés.
 */
export function compareProgression(left: ProspectOutcome, right: ProspectOutcome): number {
  return funnelRank(left.stage) - funnelRank(right.stage);
}
