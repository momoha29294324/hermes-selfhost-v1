import type { Sql } from '@/lib/db/sql';
import { logger as rootLogger, type Logger } from '@/lib/logging/logger';
import { correlateInstagramInbound, type InstagramCorrelationResult } from '@/lib/inbound/instagramCorrelation';
import {
  InstagramInboundError,
  bindThreadFromObservation,
  closeInboundPoll,
  loadInstagramOutboundSends,
  loadThreadBindings,
  openInboundPoll,
  persistInstagramInboundMessage,
  recordMessageObservation,
  recordThreadObservation,
  type MessageObservationOutcome,
  type ThreadMessageSourceTag,
  type ThreadReplyStatus,
} from '@/lib/inbound/instagramIntake';
import type { InstagramSendWithText } from '@/lib/inbound/instagramIntake';
import type { InstagramThreadBinding, ReceivedAtBasis } from '@/lib/inbound/instagramCorrelation';
import {
  forbiddenMethodsOn,
  type ObservedInboundThread,
  type InstagramInboundRail,
  type ThreadReadOutcome,
} from '@/lib/instagram/inboundRail';
import {
  instagramMessageFingerprint,
  instagramNetworkMessageFingerprint,
  type MessageDirection,
  type ObservedThreadMessage,
} from '@/lib/instagram/inboundThread';

/**
 * IG5.1 §4 — l'orchestration, et la seule chose qu'elle a le droit de faire.
 *
 * ---------------------------------------------------------------------------
 * Les six étapes restent séparées
 * ---------------------------------------------------------------------------
 *
 *   OBSERVATION    le rail lit la boîte et rend des données (aucune écriture)
 *   INGESTION      les observations sont journalisées, y compris les refus
 *   DÉDUPLICATION  un index unique sur une empreinte déterministe
 *   CORRÉLATION    pure, et elle peut refuser
 *   ACTION MÉTIER  hors de ce fichier — `processReply` (D2), inchangé
 *   BROUILLON      hors de ce fichier — `generateReplyDraft` (D2), inchangé
 *
 * Ce module ne classe rien, n'écrit aucun état commercial, ne rédige aucun
 * brouillon et ne touche à aucune alerte. Il s'arrête à « voici une réponse
 * entrante, corrélée ou non ». La suite est celle du rail e-mail, mot pour
 * mot — c'est tout l'intérêt d'avoir partagé `r6b_inbound_messages`.
 *
 * ---------------------------------------------------------------------------
 * Ce qu'il vérifie avant de commencer
 * ---------------------------------------------------------------------------
 *
 * Que l'objet qu'on lui a passé ne sait pas agir. Pas « qu'il n'a pas été
 * appelé pour agir » — qu'il n'en a pas la méthode. C'est la demande explicite
 * de §20 : un contrat de type décrit ce qu'on croit avoir, et cette
 * vérification-ci porte sur ce qu'on a réellement reçu.
 */

export interface CollectDeps {
  readonly rail: InstagramInboundRail;
  readonly logger?: Logger;
  /** Horloge injectable — les tests ont besoin d'un instant reproductible. */
  readonly now?: () => Date;
}

export interface CollectOptions {
  /** Le compte qui relève : le nôtre, tel qu'il s'appelle AUJOURD'HUI. */
  readonly accountHandle: string;
  /**
   * HERMES-IDENTITY-CANONICALIZATION-R1 §6 — les noms que ce MÊME compte a
   * portés avant. Ils ne servent qu'à reconnaître un message déjà ingéré sous
   * l'un d'eux ; rien n'est jamais ÉCRIT sous un ancien nom.
   */
  readonly formerAccountHandles?: readonly string[];
  readonly polledBy: string;
  readonly maxThreads: number;
  readonly leaseMs: number;
}

export interface CollectedMessage {
  readonly inboundMessageId: string;
  readonly threadId: string;
  readonly senderHandle: string;
  readonly correlationStatus: InstagramCorrelationResult['status'];
  readonly correlationMethod: string | null;
  readonly prospectId: string | null;
  readonly created: boolean;
}

/**
 * IG5 R3 §8 — le verdict de réponse d'un fil, tel qu'il a été ÉTABLI.
 *
 * Rendu au niveau du rapport, et non déduit par l'appelant, parce que la
 * distinction entre « pas de réponse » et « je n'ai pas su lire » ne survit
 * jamais à une reconstitution à distance : elle dépend de ce que le tour a
 * réellement vu, et cette information n'existe qu'ici.
 */
export interface ThreadReplyReport {
  readonly rowIndex: number;
  readonly threadId: string;
  readonly counterpartyHandle: string | null;
  readonly messageSource: ThreadMessageSourceTag;
  readonly messagesRead: number;
  /** Notre propre DM a-t-il été retrouvé dans le fil ? */
  readonly outboundFound: boolean;
  /** La date de notre envoi de référence. `null` quand aucun envoi ne s'y rattache. */
  readonly outreachSentAt: Date | null;
  readonly replyStatus: ThreadReplyStatus;
}

/**
 * HERMES-CONTROLLED-THREAD-INBOUND-INGESTION-DIAGNOSTIC-R1 §4 — le SORT du
 * dernier message de chaque fil, dit dans le tour qui l'a observé.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi ce registre existe
 * ---------------------------------------------------------------------------
 *
 * Tout ce qu'il porte était DÉJÀ écrit — `ig_inbound_thread_observations` et
 * `ig_inbound_message_observations` le consignent depuis 0042. Rien n'y
 * manquait. Ce qui manquait, c'est qu'un opérateur regardant défiler
 * `ig:inbound:run --loop` puisse répondre « ce fil-là, ce message-là, où en
 * est-il ? » sans ouvrir la base.
 *
 * Le 23 août 2026, ce manque a coûté un diagnostic entier : un tour affichant
 * `ingested = 0, alreadyKnown = 13` a été lu comme « le nouveau message n'est
 * pas ingéré », alors qu'il l'était depuis le tour précédent et que
 * `alreadyKnown` disait exactement cela. Un agrégat ne distingue pas « rien de
 * neuf » de « quelque chose de neuf a été perdu ». Le registre, lui, nomme la
 * ligne, le fil, le dernier message et son verdict.
 *
 * ---------------------------------------------------------------------------
 * Ce qu'il n'est pas
 * ---------------------------------------------------------------------------
 *
 * Ce n'est pas une décision : rien ne le lit pour agir, il ne referme aucune
 * porte et n'en ouvre aucune. Il ne porte AUCUN corps de message — ni texte, ni
 * extrait, ni condensé de texte : un identifiant, un instant, une direction et
 * une clé tronquée. Sa taille est bornée par le nombre de lignes que la boîte
 * expose (`INBOX_READ_LIMITS.maxRows`), donc par construction.
 */
export type ThreadLedgerVerdict =
  /** Le dernier message du fil est entré en base pendant CE tour. */
  | 'NEW'
  /** Ce message Instagram exact portait déjà une ligne canonique. */
  | 'ALREADY_KNOWN'
  /** Il a été observé et consigné, mais une règle l'a écarté — `reason` dit laquelle. */
  | 'REJECTED'
  /** Le fil n'a rien montré : pas ouvert, pas lisible, ou lu sans aucun message. */
  | 'NOT_VISIBLE'
  /** La borne de fils par tour a été atteinte avant cette ligne. */
  | 'NOT_SELECTED';

export interface ThreadLedgerEntry {
  readonly rowIndex: number;
  /** `null` quand la ligne ne s'est nommée d'aucun identifiant — on ne devine pas d'URL. */
  readonly threadId: string | null;
  readonly counterpartyHandle: string | null;
  readonly outcome: ThreadReadOutcome;
  readonly messageSource: ThreadMessageSourceTag | null;
  readonly messagesRead: number;
  /** L'identifiant que le FOURNISSEUR a émis pour le dernier message. `null` sur le chemin DOM. */
  readonly lastMessageId: string | null;
  /** L'instant RÉEL du dernier message, ISO. `null` quand la source ne date pas. */
  readonly lastMessageAt: string | null;
  readonly lastMessageDirection: MessageDirection | null;
  /**
   * La clé de déduplication du dernier message, tronquée.
   *
   * Tronquée parce qu'elle sert à COMPARER deux tours entre eux, pas à
   * reconstituer une identité : seize caractères suffisent à voir qu'une clé a
   * bougé, et n'invitent personne à s'en servir comme d'un identifiant.
   */
  readonly lastMessageKey: string | null;
  readonly verdict: ThreadLedgerVerdict;
  /** Le code EXACT qui a produit ce verdict. Jamais une paraphrase. */
  readonly reason: string;
}

/**
 * Le verdict d'un fil, à partir de ce qui a été observé et de rien d'autre.
 *
 * Pure, donc exerçable sans navigateur et sans base. L'ordre des questions est
 * celui de la prudence, et il est fail-closed : tout ce qui n'est pas
 * explicitement « lu, avec un dernier message dont le sort est connu » retombe
 * sur `NOT_VISIBLE`, jamais sur un verdict qui laisserait croire qu'on a
 * conclu quelque chose du fil.
 */
export function threadLedgerVerdict(input: {
  readonly outcome: ThreadReadOutcome;
  readonly messagesRead: number;
  readonly lastMessageOutcome: MessageObservationOutcome | null;
}): { readonly verdict: ThreadLedgerVerdict; readonly reason: string } {
  if (input.outcome === 'SKIPPED_LIMIT') {
    return { verdict: 'NOT_SELECTED', reason: 'thread_limit_reached' };
  }
  if (input.outcome === 'NOT_OPENED') {
    return { verdict: 'NOT_VISIBLE', reason: 'thread_not_opened' };
  }
  if (input.outcome === 'UNREADABLE') {
    return { verdict: 'NOT_VISIBLE', reason: 'thread_unreadable' };
  }
  if (input.outcome !== 'READ') {
    return { verdict: 'NOT_VISIBLE', reason: 'thread_not_read' };
  }
  if (input.messagesRead === 0) {
    // Un fil « lu » qui n'a rendu aucun message n'a rien montré. C'est le même
    // refus de conclure que `replyStatusFor`, à la même hauteur.
    return { verdict: 'NOT_VISIBLE', reason: 'thread_read_without_messages' };
  }
  const last = input.lastMessageOutcome;
  if (last === null) {
    return { verdict: 'NOT_VISIBLE', reason: 'last_message_not_observed' };
  }
  if (last === 'INGESTED') return { verdict: 'NEW', reason: 'ingested' };
  if (last === 'ALREADY_KNOWN') return { verdict: 'ALREADY_KNOWN', reason: 'already_known' };
  return { verdict: 'REJECTED', reason: last.toLowerCase() };
}

export interface CollectReport {
  readonly pollId: string;
  readonly accountHandle: string;
  readonly sessionState: string;
  readonly readability: 'INBOX_READABLE' | 'INBOX_UNREADABLE';
  readonly stopReason: string | null;
  readonly rowsSeen: number;
  /** IG5 R2 — la liste de fils d'Instagram a-t-elle été comprise ? Voir le rail. */
  readonly threadListReadable: boolean;
  readonly threadListSize: number;
  readonly threadsRead: number;
  readonly threadsNotOpened: number;
  readonly threadsUnreadable: number;
  readonly threadsSkipped: number;
  readonly messagesObserved: number;
  readonly outgoingSkipped: number;
  readonly unknownDirectionSkipped: number;
  readonly unidentifiedSenderSkipped: number;
  /** IG5 R3 §7 — messages de la contrepartie ANTÉRIEURS à notre DM. Consignés, jamais ingérés. */
  readonly preOutreachSkipped: number;
  /**
   * IG5 R3 §7 — messages de fils vers lesquels AUCUN envoi n'est connu.
   *
   * Ce ne sont pas des réponses : ce sont des conversations. Elles restent
   * observées — on sait qu'elles existent, de qui et quand — mais leur contenu
   * n'entre pas en base.
   */
  readonly noOutreachSkipped: number;
  /** IG5 R3 — messages sans texte (photo, note vocale). Ils comptent comme réponse, pas comme corps. */
  readonly nonTextSkipped: number;
  readonly ingested: number;
  readonly alreadyKnown: number;
  readonly threadsBound: number;
  readonly correlated: readonly CollectedMessage[];
  /** IG5 R3 §8 — ce que chaque fil LU permet de dire d'une réponse, ou de son absence. */
  readonly replyStatuses: readonly ThreadReplyReport[];
  /**
   * Le sort du dernier message de CHAQUE ligne de la boîte, y compris celles
   * qui n'ont pas été ouvertes. Une ligne par ligne vue, jamais moins.
   */
  readonly threadLedger: readonly ThreadLedgerEntry[];
  readonly blockedWriteRequests: number;
  readonly truncatedThreads: number;
  readonly durationMs: number;
}

/**
 * Le sujet d'une empreinte DOM, selon la direction.
 *
 * Une bulle sortante et une bulle entrante portant le même texte doivent
 * produire deux empreintes distinctes — sinon la seconde serait avalée par
 * l'unicité `(poll_id, fingerprint)` du journal, et une vraie réponse
 * disparaîtrait parce qu'elle ressemble à notre propre message.
 *
 * Ce détour n'existe que faute d'identifiant. Il disparaît sur le chemin
 * réseau, où Instagram en émet un.
 */
function fingerprintSubject(message: ObservedThreadMessage, accountHandle: string, sender: string | null): string {
  if (message.direction === 'OUTGOING') return accountHandle;
  if (message.direction === 'UNKNOWN') return 'direction.indecidable';
  return sender ?? 'expediteur.non.identifie';
}

/**
 * IG5 R3 §5 — l'identité logique d'un message observé.
 *
 * Deux recettes, une par source, et le choix est dicté par ce que la source
 * DONNE, jamais par une préférence :
 *
 *   * réseau — Instagram émet un identifiant natif (`mid.…`). L'empreinte en
 *     est un condensé déterministe : même message ⇒ même identité, quels que
 *     soient l'ordre de lecture, le nombre de relèves, ou l'apparition d'un
 *     message plus ancien dans le fil ;
 *   * DOM — il n'y a aucun identifiant, et l'empreinte repose sur le rang
 *     d'occurrence d'un texte (`ig-dm-v1`, IG5.1). Elle reste correcte, mais
 *     elle est fragile là où l'autre ne l'est pas.
 *
 * Les deux versions sont inscrites DANS l'empreinte, donc un même message ne
 * peut pas produire silencieusement deux identités selon la recette employée :
 * il en produirait deux VISIBLEMENT différentes. C'est la raison pour laquelle
 * un fil n'est jamais lu par les deux sources à la fois — le rail choisit
 * l'une, et le journal d'observation dit laquelle.
 */
function messageFingerprint(
  message: ObservedThreadMessage,
  accountHandle: string,
  threadId: string,
  sender: string | null,
): string {
  const providerMessageId = message.providerMessageId;
  if (message.source === 'THREAD_DETAIL_NETWORK' && providerMessageId !== null) {
    return instagramNetworkMessageFingerprint({ accountHandle, threadId, providerMessageId });
  }
  return instagramMessageFingerprint({
    accountHandle,
    threadId,
    senderHandle: fingerprintSubject(message, accountHandle, sender),
    occurrenceIndex: message.occurrenceIndex,
    text: message.text,
  });
}

const SOURCE_TAG: Record<ObservedThreadMessage['source'], ThreadMessageSourceTag> = {
  DOM_BUBBLE: 'dom_bubble',
  THREAD_DETAIL_NETWORK: 'thread_detail_network',
};

/**
 * IG5 R3 §7 — l'instant de NOTRE envoi dans ce fil, s'il y en a un.
 *
 * C'est la référence contre laquelle un message entrant devient, ou non, une
 * réponse au DM courant. Deux sources, par force de preuve décroissante :
 *
 *   1. un LIEN DE FIL — le fil porte une bulle sortante au texte approuvé d'un
 *      manifeste. C'est l'identifiant fort ;
 *   2. à défaut, un envoi Instagram vers la contrepartie de ce fil.
 *
 * En cas de pluralité, la PLUS ANCIENNE date est retenue. Ce n'est pas
 * indifférent : la référence sert à ÉCARTER des messages, et retenir la plus
 * récente en écarterait davantage — donc risquerait de perdre une vraie
 * réponse. Entre deux erreurs possibles, on choisit celle qui laisse un humain
 * voir le message plutôt que celle qui le fait disparaître.
 *
 * `null` quand aucun envoi ne se rattache au fil. On ne fabrique alors AUCUNE
 * référence : sans DM connu, « antérieur à notre DM » n'a pas de sens, et rien
 * n'est écarté à ce titre.
 */
function outreachReferenceFor(
  counterparty: string | null,
  sends: readonly InstagramSendWithText[],
  bindings: readonly InstagramThreadBinding[],
): Date | null {
  const boundEventIds = new Set(bindings.map((binding) => binding.outreachEventId));
  const bound = sends.filter((send) => boundEventIds.has(send.outreachEventId));
  const candidates =
    bound.length > 0
      ? bound
      : counterparty === null
        ? []
        : sends.filter((send) => send.recipientHandle.toLowerCase() === counterparty.toLowerCase());

  let earliest: Date | null = null;
  for (const send of candidates) {
    if (earliest === null || send.sentAt.getTime() < earliest.getTime()) earliest = send.sentAt;
  }
  return earliest;
}

/**
 * IG5 R3 §8 — ce qu'on a le droit de dire de l'absence de réponse dans ce fil.
 *
 * L'ordre des questions est celui de la prudence : on ne prononce
 * `NO_REPLY_OBSERVED` qu'après avoir effectivement LU des messages ET connu la
 * date de notre envoi. Sans lecture, l'absence n'est pas constatée ; sans
 * envoi de référence, « pas de réponse à notre DM » ne veut rien dire.
 */
function replyStatusFor(input: {
  readonly thread: ObservedInboundThread;
  readonly outreachReference: Date | null;
  readonly repliesAfterOutreach: number;
  readonly messagesRead: number;
}): ThreadReplyStatus {
  if (input.thread.outcome === 'UNREADABLE') return 'THREAD_UNREADABLE';
  if (input.thread.outcome !== 'READ') return 'UNKNOWN';
  if (input.repliesAfterOutreach > 0) return 'REPLY_OBSERVED';
  // Un fil « lu » qui n'a rendu aucun message n'a rien montré : c'est
  // exactement le cas des huit fils de R2, et le rendre « pas de réponse »
  // serait le faux verdict qu'on cherche à ne plus jamais produire.
  if (input.messagesRead === 0) return 'THREAD_UNREADABLE';
  if (input.outreachReference === null) return 'UNKNOWN';
  return 'NO_REPLY_OBSERVED';
}

export async function collectInstagramInbound(
  sql: Sql,
  deps: CollectDeps,
  options: CollectOptions,
): Promise<CollectReport> {
  const log = deps.logger ?? rootLogger.child({ rail: 'instagram-inbound' });
  const now = deps.now ?? ((): Date => new Date());

  // ---- La garde structurelle, avant tout le reste -------------------------
  const forbidden = forbiddenMethodsOn(deps.rail);
  if (forbidden.length > 0) {
    throw new InstagramInboundError(
      'IG_INBOUND_PERSIST_FAILED',
      `le rail fourni au collecteur entrant expose ${forbidden.join(', ')} — ` +
        'le chemin entrant ne doit posséder aucune capacité d’action, la relève est refusée',
    );
  }

  const started = now();
  const pollId = await openInboundPoll(sql, {
    accountHandle: options.accountHandle,
    polledBy: options.polledBy,
    leaseMs: options.leaseMs,
  });

  let sessionState = 'UNKNOWN';
  let readability: 'INBOX_READABLE' | 'INBOX_UNREADABLE' = 'INBOX_UNREADABLE';
  let blockedWriteRequests = 0;

  try {
    const sweep = await deps.rail.observeInbox({
      accountHandle: options.accountHandle,
      maxThreads: options.maxThreads,
    });
    sessionState = sweep.sessionState;
    readability = sweep.readability;
    blockedWriteRequests = sweep.blockedWriteRequests;

    const sends = await loadInstagramOutboundSends(sql);

    let threadsRead = 0;
    let threadsNotOpened = 0;
    let threadsUnreadable = 0;
    let threadsSkipped = 0;
    let messagesObserved = 0;
    let outgoingSkipped = 0;
    let unknownDirectionSkipped = 0;
    let unidentifiedSenderSkipped = 0;
    let ingested = 0;
    let alreadyKnown = 0;
    let threadsBound = 0;
    let truncatedThreads = 0;
    let preOutreachSkipped = 0;
    let noOutreachSkipped = 0;
    let nonTextSkipped = 0;
    const correlated: CollectedMessage[] = [];
    const replyStatuses: ThreadReplyReport[] = [];
    const threadLedger: ThreadLedgerEntry[] = [];

    for (const thread of sweep.threads) {
      if (thread.outcome === 'NOT_OPENED') threadsNotOpened += 1;
      if (thread.outcome === 'UNREADABLE') threadsUnreadable += 1;
      if (thread.outcome === 'SKIPPED_LIMIT') threadsSkipped += 1;

      const threadId = thread.threadId;
      if (thread.outcome !== 'READ' || threadId === null) {
        await recordThreadObservation(sql, {
          pollId,
          rowIndex: thread.rowIndex,
          threadId: thread.threadId,
          rowText: thread.rowText,
          ageMs: thread.ageMs,
          counterpartyHandle: thread.counterpartyHandle,
          outcome: thread.outcome,
          messageSource: null,
          replyStatus: replyStatusFor({
            thread,
            outreachReference: null,
            repliesAfterOutreach: 0,
            messagesRead: 0,
          }),
          detail: thread.detail,
        });
        threadLedger.push(
          Object.freeze({
            rowIndex: thread.rowIndex,
            threadId: thread.threadId,
            counterpartyHandle: thread.counterpartyHandle ?? thread.rowCounterpartyHandle,
            outcome: thread.outcome,
            messageSource: null,
            messagesRead: 0,
            lastMessageId: null,
            lastMessageAt: null,
            lastMessageDirection: null,
            lastMessageKey: null,
            ...threadLedgerVerdict({
              outcome: thread.outcome,
              messagesRead: 0,
              lastMessageOutcome: null,
            }),
          }),
        );
        continue;
      }

      threadsRead += 1;
      if (thread.truncated) truncatedThreads += 1;

      // ---- Le lien de fil, AVANT la corrélation ---------------------------
      //
      // Une bulle sortante portant le texte approuvé d'un manifeste prouve que
      // ce fil est celui de cet envoi. Le lien est écrit d'abord pour que les
      // messages du même tour en bénéficient : sinon la première réponse d'un
      // fil serait corrélée plus faiblement que la deuxième, pour la seule
      // raison qu'elle est arrivée en premier.
      const outgoingTexts = thread.messages
        .filter((message) => message.direction === 'OUTGOING')
        .map((message) => message.text);
      if (outgoingTexts.length > 0) {
        const bound = await bindThreadFromObservation(sql, { pollId, threadId, outgoingTexts, sends });
        threadsBound += bound.filter((entry) => entry.created).length;
      }
      const bindings = await loadThreadBindings(sql, threadId);

      // ---- §7 — la date de NOTRE envoi dans ce fil ------------------------
      //
      // Elle est calculée une fois par fil, après le lien : un fil lié rend une
      // référence forte, et tous les messages du fil en profitent.
      const outreachReference = outreachReferenceFor(thread.counterpartyHandle, sends, bindings);

      const sourceTag = SOURCE_TAG[thread.messageSource ?? 'DOM_BUBBLE'];

      // Le dernier message du fil est celui dont l'aperçu de la boîte porte
      // l'âge. Lui seul peut donc hériter d'un `received_at` dérivé ; les
      // autres portent l'instant d'observation, et la preuve dit lequel. Rien
      // de tout cela ne sert quand la source DATE ses messages.
      const lastIndex = thread.messages.length - 1;
      let repliesAfterOutreach = 0;

      // Le SORT du dernier message, retenu pendant qu'il est décidé.
      //
      // Un objet plutôt que deux `let` : la valeur est écrite dans une fermeture
      // (`skip`) et relue après la boucle, et un objet garde son type déclaré là
      // où une variable capturée invite l'analyse de flux à la rétrécir.
      const lastMessage: {
        outcome: MessageObservationOutcome | null;
        key: string | null;
      } = { outcome: null, key: null };

      for (const [index, message] of thread.messages.entries()) {
        messagesObserved += 1;
        // L'expéditeur : celui que la source NOMME, sinon la contrepartie du
        // fil. Le chemin réseau remplit le premier ; le chemin DOM ne connaît
        // que le second.
        const sender = message.senderHandle ?? thread.counterpartyHandle;
        const fingerprint = messageFingerprint(message, sweep.accountHandle, threadId, sender);
        const messageSentAt = message.timestampMs === null ? null : new Date(message.timestampMs);

        const skip = async (outcome: MessageObservationOutcome): Promise<void> => {
          if (index === lastIndex) {
            lastMessage.outcome = outcome;
            lastMessage.key = fingerprint;
          }
          await recordMessageObservation(sql, {
            pollId,
            threadId,
            accountHandle: sweep.accountHandle,
            senderHandle: message.direction === 'OUTGOING' ? sweep.accountHandle : sender,
            direction: message.direction,
            directionBasis: message.directionBasis,
            occurrenceIndex: message.occurrenceIndex,
            textSha256: message.textSha256,
            fingerprint,
            outcome,
            inboundMessageId: null,
            source: sourceTag,
            providerMessageId: message.providerMessageId,
            messageSentAt,
          });
        };

        if (message.direction === 'OUTGOING') {
          outgoingSkipped += 1;
          await skip('SKIPPED_OUTGOING');
          continue;
        }
        if (message.direction === 'UNKNOWN') {
          unknownDirectionSkipped += 1;
          await skip('SKIPPED_UNKNOWN_DIRECTION');
          continue;
        }
        if (sender === null) {
          unidentifiedSenderSkipped += 1;
          await skip('SKIPPED_UNIDENTIFIED_SENDER');
          continue;
        }

        // ---- §7 — ce message répond-il à un DM, et AU BON ? ---------------
        //
        // Deux refus distincts, et l'ordre compte : on demande d'abord s'il y a
        // un envoi, ensuite seulement si le message le suit.
        //
        // 1. AUCUN envoi connu vers ce compte. Ce n'est alors pas une réponse,
        //    c'est la conversation de quelqu'un — et son corps n'a rien à faire
        //    dans la base d'une campagne. Le premier relevé LIVE de R3 l'a
        //    rendu concret : cinq fils personnels, trente-six messages copiés,
        //    tous `UNMATCHED` et sans conséquence commerciale, mais recopiés.
        //    Le message reste consigné (expéditeur, date, identifiant natif,
        //    empreinte) ; seul son contenu ne l'est pas.
        //
        // 2. Le message PRÉCÈDE notre envoi. Le fil d'un prospect peut porter
        //    une conversation vieille de deux ans, et la ranger parmi les
        //    réponses au DM de la semaine dernière serait une invention.
        //
        // Les deux tests exigent que le message soit DATÉ. Le chemin DOM ne
        // date rien, donc il n'écarte rien à ce titre : « je ne sais pas situer
        // ce message » n'est ni « il est ancien » ni « il n'y a pas d'envoi ».
        if (messageSentAt !== null && outreachReference === null) {
          noOutreachSkipped += 1;
          await skip('SKIPPED_NO_OUTREACH');
          continue;
        }
        const preOutreach =
          messageSentAt !== null &&
          outreachReference !== null &&
          messageSentAt.getTime() <= outreachReference.getTime();
        if (preOutreach) {
          preOutreachSkipped += 1;
          await skip('SKIPPED_PRE_OUTREACH');
          continue;
        }

        // À partir d'ici, le message est une réponse POSTÉRIEURE à notre envoi
        // — y compris s'il n'a pas de texte. C'est ce qui empêche un fil où le
        // prospect a répondu par une photo d'être rendu « sans réponse ».
        if (messageSentAt !== null && outreachReference !== null) repliesAfterOutreach += 1;

        if (message.contentKind === 'NON_TEXT') {
          nonTextSkipped += 1;
          await skip('SKIPPED_NON_TEXT');
          continue;
        }

        const useProviderTimestamp = messageSentAt !== null;
        const useRowAge = !useProviderTimestamp && index === lastIndex && thread.ageMs !== null;
        const receivedAtBasis: ReceivedAtBasis = useProviderTimestamp
          ? 'provider_timestamp'
          : useRowAge
            ? 'inbox_row_relative_age'
            : 'observed_at';
        const receivedAt =
          messageSentAt ?? (useRowAge ? new Date(started.getTime() - (thread.ageMs ?? 0)) : started);

        const correlation = correlateInstagramInbound(
          {
            accountHandle: sweep.accountHandle,
            threadId,
            senderHandle: sender,
            // L'instant contre lequel « envoi antérieur » se juge. Quand la
            // source date le message, c'est SA date — un envoi parti après lui
            // n'est pas un envoi auquel il répond.
            observedAt: receivedAt,
            occurrenceIndex: message.occurrenceIndex,
            directionBasis: message.directionBasis,
            receivedAtBasis,
            rowAgeMs: thread.ageMs,
            providerMessageId: message.providerMessageId,
          },
          sends,
          bindings,
        );

        // §6 — les clés que ce message porterait sous chaque nom PRÉCÉDENT du
        // compte. Calculées par la MÊME recette que la clé courante, sinon
        // elles ne reconnaîtraient pas ce qu'elles cherchent.
        const priorKeys = (options.formerAccountHandles ?? []).map((former) => ({
          mailbox: former,
          fingerprint: messageFingerprint(message, former, threadId, sender),
        }));

        const persisted = await persistInstagramInboundMessage(sql, {
          accountHandle: sweep.accountHandle,
          threadId,
          senderHandle: sender,
          fingerprint,
          receivedAt,
          bodyText: message.text,
          bodySha256: message.textSha256,
          correlation,
          priorKeys,
        });

        await recordMessageObservation(sql, {
          pollId,
          threadId,
          accountHandle: sweep.accountHandle,
          senderHandle: sender,
          direction: message.direction,
          directionBasis: message.directionBasis,
          occurrenceIndex: message.occurrenceIndex,
          textSha256: message.textSha256,
          fingerprint,
          outcome: persisted.created ? 'INGESTED' : 'ALREADY_KNOWN',
          inboundMessageId: persisted.id,
          source: sourceTag,
          providerMessageId: message.providerMessageId,
          messageSentAt,
        });

        if (index === lastIndex) {
          lastMessage.outcome = persisted.created ? 'INGESTED' : 'ALREADY_KNOWN';
          lastMessage.key = fingerprint;
        }

        if (persisted.created) ingested += 1;
        else alreadyKnown += 1;

        correlated.push(
          Object.freeze({
            inboundMessageId: persisted.id,
            threadId,
            senderHandle: sender,
            correlationStatus: correlation.status,
            correlationMethod: correlation.method,
            prospectId: correlation.prospectId,
            created: persisted.created,
          }),
        );
      }

      const replyStatus = replyStatusFor({
        thread,
        outreachReference,
        repliesAfterOutreach,
        messagesRead: thread.messages.length,
      });
      replyStatuses.push(
        Object.freeze({
          rowIndex: thread.rowIndex,
          threadId,
          counterpartyHandle: thread.counterpartyHandle,
          messageSource: sourceTag,
          messagesRead: thread.messages.length,
          outboundFound: thread.messages.some((message) => message.direction === 'OUTGOING'),
          outreachSentAt: outreachReference,
          replyStatus,
        }),
      );

      await recordThreadObservation(sql, {
        pollId,
        rowIndex: thread.rowIndex,
        threadId,
        rowText: thread.rowText,
        ageMs: thread.ageMs,
        counterpartyHandle: thread.counterpartyHandle,
        outcome: thread.outcome,
        messageSource: sourceTag,
        replyStatus,
        detail: thread.detail,
      });

      const last = lastIndex >= 0 ? (thread.messages[lastIndex] ?? null) : null;
      threadLedger.push(
        Object.freeze({
          rowIndex: thread.rowIndex,
          threadId,
          counterpartyHandle: thread.counterpartyHandle ?? thread.rowCounterpartyHandle,
          outcome: thread.outcome,
          messageSource: sourceTag,
          messagesRead: thread.messages.length,
          lastMessageId: last?.providerMessageId ?? null,
          lastMessageAt:
            last === null || last.timestampMs === null ? null : new Date(last.timestampMs).toISOString(),
          lastMessageDirection: last?.direction ?? null,
          // Tronquée : elle sert à comparer deux tours, pas à identifier.
          lastMessageKey: lastMessage.key === null ? null : lastMessage.key.slice(0, 16),
          ...threadLedgerVerdict({
            outcome: thread.outcome,
            messagesRead: thread.messages.length,
            lastMessageOutcome: lastMessage.outcome,
          }),
        }),
      );
    }

    const detail =
      sweep.stopReason ??
      `${threadsRead} fil(s) lu(s) sur ${sweep.rowsSeen} ligne(s), ` +
        `${ingested} réponse(s) nouvelle(s), ${alreadyKnown} déjà connue(s)`;

    await closeInboundPoll(sql, pollId, 'COMPLETED', {
      sessionState,
      inboxReadability: readability,
      threadsSeen: sweep.rowsSeen,
      threadsRead,
      messagesObserved,
      messagesIngested: ingested,
      messagesAlreadyKnown: alreadyKnown,
      blockedWriteRequests,
      detail,
    });

    // Un registre par tour, borné par le nombre de lignes que la boîte expose.
    // Aucun corps de message, aucun extrait, aucun condensé de texte.
    log.info('instagram.inbound.thread_ledger', { pollId, threads: threadLedger });

    log.info('instagram.inbound.poll', {
      pollId,
      rowsSeen: sweep.rowsSeen,
      threadListReadable: sweep.threadListReadable,
      threadListSize: sweep.threadListSize,
      threadsRead,
      ingested,
      alreadyKnown,
      blockedWriteRequests,
    });

    return Object.freeze({
      pollId,
      accountHandle: sweep.accountHandle,
      sessionState,
      readability,
      stopReason: sweep.stopReason,
      rowsSeen: sweep.rowsSeen,
      threadListReadable: sweep.threadListReadable,
      threadListSize: sweep.threadListSize,
      threadsRead,
      threadsNotOpened,
      threadsUnreadable,
      threadsSkipped,
      messagesObserved,
      outgoingSkipped,
      unknownDirectionSkipped,
      unidentifiedSenderSkipped,
      preOutreachSkipped,
      noOutreachSkipped,
      nonTextSkipped,
      ingested,
      alreadyKnown,
      threadsBound,
      correlated: Object.freeze(correlated),
      replyStatuses: Object.freeze(replyStatuses),
      threadLedger: Object.freeze(threadLedger),
      blockedWriteRequests,
      truncatedThreads,
      durationMs: sweep.durationMs,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await closeInboundPoll(sql, pollId, 'FAILED', {
      sessionState,
      inboxReadability: readability,
      threadsSeen: 0,
      threadsRead: 0,
      messagesObserved: 0,
      messagesIngested: 0,
      messagesAlreadyKnown: 0,
      blockedWriteRequests,
      detail: `relève interrompue : ${detail}`,
    }).catch(() => undefined);
    throw error;
  }
}
