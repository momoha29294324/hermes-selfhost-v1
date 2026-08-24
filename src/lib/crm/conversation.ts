/**
 * La conversation d'un prospect — une VUE, jamais une copie.
 *
 * Rien ici ne lit la base. Le fil est reconstruit à partir des événements
 * canoniques déjà chargés par `loadTimeline` : un envoi reste un
 * `outreach_event`, une réponse reste une ligne `r6b_inbound_messages`, un
 * brouillon reste un `r6b_reply_drafts`. Dupliquer l'historique dans une table
 * « conversation » créerait une seconde vérité qui divergerait au premier bug ;
 * on se contente donc de RELIRE la première dans l'ordre où elle s'est
 * produite.
 *
 * Trois différences avec la timeline dont elle dérive :
 *
 *   1. l'ordre est CROISSANT — on lit une discussion du début vers la fin,
 *      alors qu'on balaie une timeline de la fin vers le début ;
 *   2. seuls les événements qui PORTENT UN TEXTE échangé entrent dans le fil.
 *      Un verrouillage de manifeste ou une transition d'état sont des faits
 *      réels, mais personne ne les a « dits » — ils restent dans l'activité ;
 *   3. chaque entrée sait de quel CÔTÉ elle vient, ce que la timeline
 *      n'exprimait qu'indirectement par `direction`.
 *
 * Ce que le fil ne fait pas : envoyer. Il n'existe ici aucune primitive
 * d'écriture, aucun identifiant de destinataire exploitable comme cible, aucun
 * appel provider. Le rail entrant reste en lecture seule tant que la réponse
 * automatique n'est pas ouverte ailleurs, explicitement.
 */

import type { CrmChannel, CrmTimelineEntry, CrmTimelineKind } from '@/lib/crm/view';
import { CRM_CHANNELS, dayKey, formatDayLabel } from '@/lib/crm/view';

/**
 * Qui parle.
 *
 * `system` n'est pas un interlocuteur : c'est une note du rail lui-même —
 * typiquement un envoi qui n'a pas abouti. La distinguer d'une bulle évite
 * d'attribuer à quelqu'un une phrase que personne n'a lue.
 */
export type CrmConversationSide = 'hermes' | 'prospect' | 'system';

/**
 * Ce qu'il est advenu du texte.
 *
 *   `sent`     — parti pour de bon, il existe un `outreach_event` ;
 *   `received` — reçu et corrélé à ce prospect ;
 *   `draft`    — rédigé, JAMAIS envoyé ;
 *   `failed`   — une tentative d'envoi qui n'a rien remis.
 */
export type CrmConversationStatus = 'sent' | 'received' | 'draft' | 'failed';

/**
 * QUI a écrit ce texte — HERMES-CONVERSATION-R2 §29.
 *
 * `null` n'est pas « on ne sait pas encore » : c'est « ce fil ne l'établit
 * pas ». Un premier message parti porte sa provenance dans son vote
 * (`r6b_batch_votes.actor_kind`), que cette vue ne lit pas ; l'inventer ici
 * ferait dire « écrit par une machine » à un texte qu'un humain a peut-être
 * relu, ou l'inverse. Seuls les deux cas ÉTABLIS sont affirmés : un brouillon
 * de réponse attend une relecture humaine, un plan conversationnel a été
 * décidé par une politique.
 */
export type CrmConversationOrigin = 'human_reviewed' | 'machine';

export interface CrmConversationEntry {
  readonly id: string;
  readonly side: CrmConversationSide;
  readonly status: CrmConversationStatus;
  readonly origin: CrmConversationOrigin | null;
  readonly kind: CrmTimelineKind;
  readonly occurredAt: string;
  readonly channel: CrmChannel | null;
  /** Le texte échangé. Vide quand la tentative n'a produit aucun contenu. */
  readonly body: string;
  /** Les faits courts déjà établis par la timeline. Jamais une interprétation. */
  readonly facts: readonly string[];
}

export interface CrmConversation {
  readonly entries: readonly CrmConversationEntry[];
  /** Les canaux qui ont réellement porté un message de ce fil. */
  readonly channels: readonly CrmChannel[];
  readonly sent: number;
  readonly received: number;
  readonly drafts: number;
  readonly failures: number;
  /** L'horodatage du dernier message échangé, `null` si le fil est vide. */
  readonly lastAt: string | null;
}

/**
 * Comment chaque genre d'événement entre — ou n'entre pas — dans le fil.
 *
 * La table est exhaustive par construction : ajouter un `CrmTimelineKind` sans
 * décider de son sort ne compile pas. C'est voulu — un nouvel événement
 * porteur de texte doit être classé à la main, pas tomber silencieusement dans
 * un défaut qui l'exclurait du fil.
 */
const THREAD_ROLE: Readonly<
  Record<
    CrmTimelineKind,
    {
      readonly side: CrmConversationSide;
      readonly status: CrmConversationStatus;
      readonly origin?: CrmConversationOrigin;
    } | null
  >
> = Object.freeze({
  outbound_sent: { side: 'hermes', status: 'sent' },
  inbound_reply: { side: 'prospect', status: 'received' },
  reply_draft: { side: 'hermes', status: 'draft', origin: 'human_reviewed' },
  // Un plan conversationnel entre dans le fil comme un texte PRÉPARÉ, jamais
  // comme un texte remis : la remise, quand elle aura lieu, produira son propre
  // `outreach_event` et donc sa propre bulle `outbound_sent`. Deux entrées pour
  // un seul message seraient deux vérités sur le même fait.
  conversation_plan: { side: 'hermes', status: 'draft', origin: 'machine' },
  send_failure: { side: 'system', status: 'failed' },
  manifest_locked: null,
  outbound_event: null,
  reply_analysis: null,
  state_transition: null,
  milestone: null,
  alert: null,
});

const EMPTY: CrmConversation = Object.freeze({
  entries: Object.freeze([]),
  channels: Object.freeze([]),
  sent: 0,
  received: 0,
  drafts: 0,
  failures: 0,
  lastAt: null,
});

/**
 * Le fil, dans l'ordre où il s'est déroulé.
 *
 * Les entrées sans texte sont écartées SAUF les échecs : un envoi qui n'a rien
 * remis est justement l'information qu'on cherche quand on se demande pourquoi
 * personne n'a répondu, et son absence de corps ne le rend pas moins vrai.
 */
export function buildConversation(timeline: readonly CrmTimelineEntry[]): CrmConversation {
  const entries: CrmConversationEntry[] = [];

  for (const entry of timeline) {
    const role = THREAD_ROLE[entry.kind];
    if (role === null) continue;

    const body = entry.body === null ? '' : entry.body.trim();
    if (body.length === 0 && role.status !== 'failed') continue;

    entries.push(
      Object.freeze({
        id: entry.id,
        side: role.side,
        status: role.status,
        origin: role.origin ?? null,
        kind: entry.kind,
        occurredAt: entry.occurredAt,
        channel: entry.channel,
        body,
        facts: entry.facts,
      }),
    );
  }

  if (entries.length === 0) return EMPTY;

  entries.sort(compareChronological);

  const seen = new Set<CrmChannel>();
  for (const entry of entries) if (entry.channel !== null) seen.add(entry.channel);

  const last = entries[entries.length - 1];

  return Object.freeze({
    entries: Object.freeze(entries),
    channels: Object.freeze(CRM_CHANNELS.filter((channel) => seen.has(channel))),
    sent: entries.filter((entry) => entry.status === 'sent').length,
    received: entries.filter((entry) => entry.status === 'received').length,
    drafts: entries.filter((entry) => entry.status === 'draft').length,
    failures: entries.filter((entry) => entry.status === 'failed').length,
    lastAt: last === undefined ? null : last.occurredAt,
  });
}

/**
 * Ordre croissant, départagé par l'identifiant.
 *
 * Le départage n'est pas cosmétique : un envoi et la tentative provider qui
 * l'accompagne partagent souvent la seconde. Sans ordre stable, deux rendus de
 * la même fiche donneraient deux fils — et une conversation qui bouge sans que
 * rien n'ait changé n'est plus une preuve.
 */
function compareChronological(a: CrmConversationEntry, b: CrmConversationEntry): number {
  const ta = Date.parse(a.occurredAt);
  const tb = Date.parse(b.occurredAt);
  if (ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Regroupement par jour
// ---------------------------------------------------------------------------

export interface CrmConversationDay {
  readonly key: string;
  readonly label: string;
  readonly entries: readonly CrmConversationEntry[];
}

/**
 * Le fil découpé en journées, dans l'ordre croissant.
 *
 * Le même découpage que la timeline, mais il ne peut pas réutiliser
 * `groupTimelineByDay` : celle-ci regroupe des `CrmTimelineEntry`, et une
 * entrée de conversation n'en est pas une — elle a perdu son titre et gagné un
 * côté. Faire passer l'une pour l'autre demanderait un cast, c'est-à-dire une
 * affirmation que le compilateur ne peut plus vérifier.
 */
export function groupConversationByDay(
  entries: readonly CrmConversationEntry[],
  now: number,
): CrmConversationDay[] {
  const days: { key: string; label: string; entries: CrmConversationEntry[] }[] = [];
  let current: { key: string; label: string; entries: CrmConversationEntry[] } | null = null;
  for (const entry of entries) {
    const key = dayKey(entry.occurredAt);
    if (current === null || current.key !== key) {
      current = { key, label: formatDayLabel(entry.occurredAt, now), entries: [] };
      days.push(current);
    }
    current.entries.push(entry);
  }
  return days;
}
