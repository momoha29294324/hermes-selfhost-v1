/**
 * CONVERSATION-R1 — le fil, reconstitué depuis les sources canoniques.
 *
 * Aucune table n'est créée ici, et c'est délibéré. Les messages existent déjà :
 * les entrants dans `r6b_inbound_messages`, le premier sortant dans le
 * manifeste verrouillé, nos réponses validées dans `r6b_reply_drafts`. Une
 * quatrième copie serait une transcription dupliquée qui divergerait au premier
 * correctif — le fil est donc DÉRIVÉ, jamais stocké.
 *
 * La porte d'entrée reste celle de R6B-D2 : on part d'un `ReplyContext` déjà
 * corrélé et on ne lit que ce que la corrélation a désigné, c'est-à-dire les
 * messages portant `correlated_prospect_id = ce prospect`. Il n'y a pas de
 * requête « tous les messages de cette boîte » dans ce fichier, et il ne doit
 * pas y en avoir : c'est ce qui tient la promesse §4 de R6B-D2 sur le contenu
 * qu'un modèle a le droit de voir.
 *
 * Une distinction porte tout le reste du module : **la provenance d'un tour
 * sortant**. Le premier message est prouvé parti (manifeste + `outreach_event`
 * de type `sent`). Un brouillon `APPROVED`/`EDITED` est un texte qu'un humain a
 * validé — le schéma R6B-D2 est explicite, « TOUJOURS PAS ENVOYÉ ». Les
 * confondre ferait dire au système « je vous ai déjà expliqué » sur un message
 * que personne n'a peut-être jamais lu. Les deux entrent donc dans le fil, mais
 * étiquetés, et le prompt reprend l'étiquette.
 */

import type { Sql } from '@/lib/db/sql';
import { MAX_FIRST_TOUCH_CHARS, MAX_REPLY_BODY_CHARS, clampBody, type ReplyContext } from '@/lib/replies/context';
import { draftChannelOf } from '@/lib/replies/draft';
import type { ReplyCategory } from '@/lib/replies/taxonomy';

export type TurnDirection = 'INBOUND' | 'OUTBOUND';

export type TurnProvenance =
  /** La personne a écrit. Fait observé, corrélé à ce prospect. */
  | 'inbound_message'
  /** Notre premier message, prouvé parti par son `outreach_event`. */
  | 'sent_first_touch'
  /** Un brouillon validé par un humain. Validé ≠ remis. */
  | 'human_approved_reply'
  /**
   * HERMES-REPLY-DELIVERY-R1 §14 — une réponse autonome dont la REMISE a été
   * confirmée (`hermes_conversation_plans.status = 'SENT'`).
   */
  | 'sent_autonomous_reply'
  /**
   * Une réponse autonome dont le clic a eu lieu et dont l'issue est inconnue
   * (`AMBIGUOUS`).
   *
   * Elle entre dans le fil, et c'est délibéré. L'omettre serait pire que
   * l'inclure : le tour suivant reprendrait la conversation comme si rien
   * n'avait été écrit, et pourrait redire mot pour mot ce que le prospect a
   * peut-être déjà lu. L'inclure avec son étiquette dit la seule chose vraie —
   * « on a écrit ça, on ne sait pas si c'est arrivé ».
   */
  | 'attempted_autonomous_reply';

export interface ConversationTurn {
  readonly direction: TurnDirection;
  readonly provenance: TurnProvenance;
  /** ISO 8601. */
  readonly at: string;
  readonly text: string;
  /** L'identifiant de la ligne d'origine, pour remonter à la source. */
  readonly sourceId: string;
  /** La conclusion D2 déjà rendue sur ce tour entrant, si elle existe. */
  readonly classification: ReplyCategory | null;
  /**
   * HERMES-SEMANTIC-GROUNDING-R1 — ce tour a-t-il été EXPOSÉ à la personne ?
   *
   * La distinction existait déjà dans `provenance` ; elle n'était lue nulle
   * part. Ce champ la rend opposable, et il ne dit qu'une chose : un texte
   * qu'un humain a validé dans `r6b_reply_drafts` n'a JAMAIS été remis — le
   * schéma R6B-D2 l'écrit en toutes lettres, « TOUJOURS PAS ENVOYÉ ».
   *
   * Ce que cela change : la logique de RÉPÉTITION. « Tu as déjà expliqué ça »,
   * « cette ouverture a déjà servi », « un appel a déjà été proposé » sont des
   * affirmations sur ce que le prospect a LU. Les fonder sur un brouillon qui
   * n'a jamais quitté la base fabrique une histoire conversationnelle qui n'a
   * pas eu lieu — et met en silence un tour parfaitement neuf pour lui.
   *
   * Une tentative dont la remise n'est pas confirmée (`AMBIGUOUS`) compte
   * comme exposée, et c'est le côté sûr : le clic a eu lieu, la personne l'a
   * peut-être lue, et redire mot pour mot ce qu'elle a peut-être déjà reçu
   * serait pire que de se répéter par prudence.
   */
  readonly exposed: boolean;
}

export interface ConversationThread {
  readonly prospectId: string;
  /** Tous les tours, du plus ancien au plus récent. */
  readonly turns: readonly ConversationTurn[];
  readonly inboundTurns: readonly ConversationTurn[];
  readonly outboundTurns: readonly ConversationTurn[];
  /**
   * Nos tours dont la personne a REÇU le texte. Sous-ensemble d'`outboundTurns`.
   *
   * C'est celui-ci que lit tout ce qui mesure une répétition. `outboundTurns`
   * reste entier pour le prompt, qui montre les brouillons validés avec leur
   * étiquette « envoi non prouvé » — le modèle doit savoir qu'un humain avait
   * écrit cela, sans en conclure que le prospect l'a lu.
   */
  readonly exposedOutboundTurns: readonly ConversationTurn[];
  /** Le message entrant en cours de traitement. */
  readonly currentInboundId: string;
  /** Combien de fois cette personne avait déjà écrit AVANT ce message. */
  readonly priorInboundCount: number;
  readonly channel: 'email' | 'instagram_dm';
  /** Vrai quand des tours ont été écartés du prompt faute de place. */
  readonly truncated: boolean;
}

/**
 * Combien de tours partent dans le prompt.
 *
 * Une conversation de prospection qui dépasse vingt tours n'est plus une
 * conversation de prospection ; et les tours anciens comptent moins que les
 * trois derniers. On garde les plus RÉCENTS, jamais les premiers : c'est
 * l'inverse d'un journal, parce que c'est le présent qui se répond.
 */
export const MAX_THREAD_TURNS = 20;

interface InboundRow {
  id: string;
  receivedAt: string | Date;
  bodyText: string;
  classification: ReplyCategory | null;
}

interface OutboundDraftRow {
  id: string;
  body: string;
  humanText: string | null;
  reviewedAt: string | Date | null;
  createdAt: string | Date;
}

interface AutonomousReplyRow {
  id: string;
  body: string;
  status: 'SENT' | 'AMBIGUOUS';
  at: string | Date;
}

function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

/**
 * Charge le fil complet autour d'un message entrant déjà corrélé.
 *
 * Ne lève pas : un prospect sans historique rend un fil à deux tours (notre
 * premier message, sa réponse), ce qui est exactement le cas du premier
 * échange.
 */
export async function loadConversationThread(sql: Sql, context: ReplyContext): Promise<ConversationThread> {
  const inboundRows = await sql.query<InboundRow>(
    `select i.id                        as "id",
            i.received_at               as "receivedAt",
            i.body_text                 as "bodyText",
            a.classification            as "classification"
       from r6b_inbound_messages i
       left join r6b_reply_analyses a
              on a.inbound_message_id = i.id and a.status = 'ACTIVE'
      where i.correlated_prospect_id = $1
        and i.correlation_status in ('EXACT', 'HIGH_CONFIDENCE')
      order by i.received_at asc, i.id asc`,
    [context.prospect.id],
  );

  // Les réponses que des humains ont validées. `EDITED` porte le texte humain :
  // c'est CE texte qui a été retenu, pas la proposition du modèle.
  const draftRows = await sql.query<OutboundDraftRow>(
    `select id, body, human_text as "humanText", reviewed_at as "reviewedAt", created_at as "createdAt"
       from r6b_reply_drafts
      where prospect_id = $1 and status in ('APPROVED', 'EDITED')
      order by coalesce(reviewed_at, created_at) asc, id asc`,
    [context.prospect.id],
  );

  // §14 — nos réponses AUTONOMES, celles qui ont réellement produit un geste.
  //
  // Lues depuis le registre des intentions et non depuis une table à part : le
  // fil reste DÉRIVÉ, comme il l'a toujours été. Seuls les plans qui portent une
  // tentative d'effet entrent — un plan `PLANNED`, `SKIPPED` ou `BLOCKED` n'a
  // rien écrit à personne, et le faire figurer ferait dire au système « comme je
  // vous le disais » sur un message qui n'a jamais quitté la base.
  const autonomousRows = await sql.query<AutonomousReplyRow>(
    `select id, body, status,
            coalesce(external_effect_started_at, terminated_at, created_at) as "at"
       from hermes_conversation_plans
      where prospect_id = $1
        and channel = 'instagram_dm'
        and external_effect_attempted = true
        and status in ('SENT', 'AMBIGUOUS')
        and body is not null
      order by coalesce(external_effect_started_at, terminated_at, created_at) asc, id asc`,
    [context.prospect.id],
  );

  const turns: ConversationTurn[] = [];

  // Tour zéro : le premier message. `sentAt` peut être nul si l'événement n'a
  // pas d'horodatage ; on retombe alors sur la réception du premier entrant
  // moins rien du tout — non, on garde l'époque zéro, qui trie avant tout le
  // reste et ne prétend pas connaître une heure qu'on n'a pas.
  turns.push({
    direction: 'OUTBOUND',
    provenance: 'sent_first_touch',
    exposed: true,
    at: context.firstTouch.sentAt ?? new Date(0).toISOString(),
    text: clampBody(context.firstTouch.body, MAX_FIRST_TOUCH_CHARS),
    sourceId: context.firstTouch.manifestId,
    classification: null,
  });

  for (const row of inboundRows) {
    turns.push({
      direction: 'INBOUND',
      provenance: 'inbound_message',
      exposed: true,
      at: iso(row.receivedAt),
      text: clampBody(row.bodyText, MAX_REPLY_BODY_CHARS),
      sourceId: row.id,
      classification: row.classification,
    });
  }

  for (const row of draftRows) {
    const text = row.humanText ?? row.body;
    turns.push({
      direction: 'OUTBOUND',
      provenance: 'human_approved_reply',
      // Validé n'est pas remis. Le schéma R6B-D2 le dit, ce champ le rend
      // opposable, et un test vérifie qu'un tel tour ne peut pas faire
      // apparaître une répétition.
      exposed: false,
      at: iso(row.reviewedAt ?? row.createdAt),
      text: clampBody(text, MAX_FIRST_TOUCH_CHARS),
      sourceId: row.id,
      classification: null,
    });
  }

  for (const row of autonomousRows) {
    turns.push({
      direction: 'OUTBOUND',
      provenance: row.status === 'SENT' ? 'sent_autonomous_reply' : 'attempted_autonomous_reply',
      // `AMBIGUOUS` compte comme exposé : le clic a eu lieu.
      exposed: true,
      at: iso(row.at),
      text: clampBody(row.body, MAX_FIRST_TOUCH_CHARS),
      sourceId: row.id,
      classification: null,
    });
  }

  // HERMES-END-TO-END-CERTIFICATION-R1 — une égalité d'horodatage se départage,
  // elle ne se laisse pas décider par l'ordre d'empilement.
  //
  // Rendre `0` sur une égalité laisse `Array.prototype.sort` conserver l'ordre
  // d'insertion : ici les entrants d'abord, puis nos brouillons, puis nos
  // réponses autonomes. Un de NOS tours horodaté à la même seconde qu'un
  // message entrant se retrouvait donc APRÈS lui quelle que soit la réalité —
  // et c'est ce fil, dans cet ordre, que `precedingTurnsDigest` donne au
  // classifieur et que `burstContaining` découpe en salves.
  //
  // Le départage est le sens de la conversation : à heure égale, ce que NOUS
  // avons écrit précède ce qu'on nous a répondu — on ne répond pas avant
  // d'avoir été lu. `sourceId` tranche le reste, pour que deux exécutions sur
  // les mêmes données rendent le même fil.
  const rank = (direction: string): number => (direction === 'OUTBOUND' ? 0 : 1);
  turns.sort((left, right) => {
    if (left.at !== right.at) return left.at < right.at ? -1 : 1;
    if (left.direction !== right.direction) return rank(left.direction) - rank(right.direction);
    return left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0;
  });

  const truncated = turns.length > MAX_THREAD_TURNS;
  const kept = truncated ? turns.slice(turns.length - MAX_THREAD_TURNS) : turns;

  // « Avant ce message » se compte sur le fil ENTIER, pas sur la fenêtre
  // envoyée au modèle : tronquer le prompt ne doit pas faire oublier au système
  // combien de fois quelqu'un a écrit.
  const currentIndex = turns.findIndex(
    (turn) => turn.direction === 'INBOUND' && turn.sourceId === context.reply.id,
  );
  const priorInboundCount =
    currentIndex < 0
      ? turns.filter((turn) => turn.direction === 'INBOUND').length
      : turns.slice(0, currentIndex).filter((turn) => turn.direction === 'INBOUND').length;

  return Object.freeze({
    prospectId: context.prospect.id,
    turns: Object.freeze(kept),
    inboundTurns: Object.freeze(kept.filter((turn) => turn.direction === 'INBOUND')),
    outboundTurns: Object.freeze(kept.filter((turn) => turn.direction === 'OUTBOUND')),
    exposedOutboundTurns: Object.freeze(
      kept.filter((turn) => turn.direction === 'OUTBOUND' && turn.exposed),
    ),
    currentInboundId: context.reply.id,
    priorInboundCount,
    channel: draftChannelOf(context.firstTouch.transport),
    truncated,
  });
}

/**
 * HERMES-CONTEXTUAL-REPLY-CLASSIFICATION-R1 — combien de tours le CLASSIFIEUR
 * reçoit.
 *
 * Trois, et pas vingt. Ce n'est pas une économie de jetons, c'est ce que la
 * question demande : pour savoir ce que « surtout via le bouche à oreille »
 * VEUT DIRE, il faut la question qui précède, et rien de plus. Un historique
 * complet apporterait surtout des occasions de classer le message d'aujourd'hui
 * sur l'ambiance d'avant-hier — c'est exactement l'erreur qu'on veut éviter,
 * dans l'autre sens.
 *
 * Le rédacteur, lui, garde ses vingt tours (`MAX_THREAD_TURNS`) : écrire une
 * réponse demande de ne pas se répéter, ce qui est une autre question.
 */
export const CLASSIFIER_CONTEXT_TURNS = 3;

/**
 * Les tours qui PRÉCÈDENT strictement le message en cours de classification.
 *
 * « Strictement » porte tout le sens. Le message courant est déjà rendu par
 * `renderContextBlock` sous l'intitulé « RÉPONSE REÇUE », et c'est le seul
 * texte dont le classifieur a le droit de citer un extrait
 * (`keepGroundedExcerpts` le vérifie sur le corps reçu). Le faire figurer une
 * seconde fois dans l'historique inviterait le modèle à le citer depuis le
 * mauvais endroit, et brouillerait la frontière entre « ce qu'on interprète »
 * et « ce sur quoi on s'appuie ».
 *
 * Rend les `limit` derniers, du plus ancien au plus récent. Vide quand rien ne
 * précède — auquel cas le contexte ne désambiguïse rien, et le prompt le dit.
 */
export function precedingTurns(
  thread: ConversationThread,
  limit: number = CLASSIFIER_CONTEXT_TURNS,
): readonly ConversationTurn[] {
  const index = thread.turns.findIndex(
    (turn) => turn.direction === 'INBOUND' && turn.sourceId === thread.currentInboundId,
  );
  // Le message courant absent de la fenêtre gardée (fil très long) : tout ce
  // qui est là le précède, puisque le tri est chronologique.
  const before = index < 0 ? thread.turns : thread.turns.slice(0, index);
  const bounded = Math.max(0, Math.trunc(limit));
  return Object.freeze(before.slice(Math.max(0, before.length - bounded)));
}

/**
 * Le bloc que le CLASSIFIEUR lit avant de trancher.
 *
 * Il porte une seule chose que `renderContextBlock` ne portait pas : le tour
 * que nous venons réellement d'écrire. Jusqu'ici le classifieur ne voyait que
 * le PREMIER message du manifeste — ce qui coïncide avec le tour précédent au
 * deuxième message d'une conversation, et devient faux à partir du troisième :
 * « non, jamais » se classait alors contre une question posée trois messages
 * plus tôt.
 *
 * Chaque tour garde sa provenance, comme dans `renderThreadBlock` et pour la
 * même raison : un brouillon validé mais jamais remis ne prouve pas que le
 * prospect l'a lu, et une phrase courte ne peut pas être interprétée comme la
 * réponse à quelque chose qu'il n'a peut-être jamais reçu.
 */
export function renderPrecedingTurnsBlock(
  thread: ConversationThread,
  limit: number = CLASSIFIER_CONTEXT_TURNS,
): string {
  const turns = precedingTurns(thread, limit);
  const lines: string[] = ['CE QUI PRÉCÈDE DANS CETTE CONVERSATION (du plus ancien au plus récent)'];

  if (turns.length === 0) {
    lines.push(
      '- aucun tour lisible ne précède ce message. Le contexte ne peut donc RIEN',
      '  désambiguïser : juge le message sur ce qu’il porte seul.',
    );
    return lines.join('\n');
  }

  for (const turn of turns) {
    const label =
      turn.direction === 'INBOUND'
        ? 'EUX'
        : turn.provenance === 'sent_first_touch'
          ? 'NOUS (premier message, réellement envoyé)'
          : turn.provenance === 'sent_autonomous_reply'
            ? 'NOUS (réponse automatique, remise confirmée)'
            : turn.provenance === 'attempted_autonomous_reply'
              ? 'NOUS (réponse tentée — remise NON confirmée, ils ne l’ont peut-être jamais lue)'
              : 'NOUS (réponse validée par un humain — envoi non prouvé)';
    const suffix = turn.classification === null ? '' : ` [classé ${turn.classification}]`;
    lines.push('', `--- ${label}${suffix}`, turn.text);
  }

  return lines.join('\n');
}

/**
 * L'empreinte de ce contexte conversationnel.
 *
 * Elle entre dans `hashReplyContext`, donc dans l'identité de l'analyse. Sans
 * elle, deux questions RÉELLEMENT différentes — le même message court, mais
 * précédé de deux échanges différents — porteraient la même empreinte, et
 * l'idempotence rendrait la seconde réponse de la première question.
 */
export function precedingTurnsDigest(
  thread: ConversationThread,
  limit: number = CLASSIFIER_CONTEXT_TURNS,
): string {
  return precedingTurns(thread, limit)
    .map((turn) => `${turn.direction}:${turn.provenance}:${turn.sourceId}:${turn.text}`)
    .join('\u0000');
}

/**
 * Rend le fil sous la forme que le modèle lit.
 *
 * Chaque tour sortant porte sa provenance en toutes lettres. Un modèle à qui on
 * écrirait « MOI » sur un brouillon jamais remis répondrait « comme je vous le
 * disais » à quelqu'un qui n'a rien reçu.
 */
export function renderThreadBlock(thread: ConversationThread): string {
  const lines: string[] = ['HISTORIQUE DE LA CONVERSATION (du plus ancien au plus récent)'];
  if (thread.truncated) {
    lines.push(`[…tours plus anciens omis ; seuls les ${MAX_THREAD_TURNS} derniers sont repris]`);
  }

  // HERMES-SEMANTIC-GROUNDING-R1 — le fil s'arrête au message qu'on traite.
  //
  // Mesuré, pas supposé. Le 23 août 2026, rejouer d'anciens tours à travers le
  // tour unifié a rendu des lectures FAUSSES : « Pourquoi tu me demande ça »
  // sortait en `INFORMATION_SHARED` et « Sa fais 11 ans que j'exerce » en
  // `NOT_INTERESTED`. Le modèle voyait les messages ARRIVÉS DEPUIS — dont le
  // dernier, qui était bien une information partagée, et dont la clôture du
  // fil, qui était bien un refus — et classait celui-là.
  //
  // C'est la leçon que le dépôt avait déjà tirée pour `terminalCategoryInThread`
  // (« les tours JUSQU'À CELUI-CI, courant compris — jamais ceux qui l'ont
  // suivi »), appliquée à l'endroit qui l'avait laissée passer.
  //
  // En PRODUCTION cette borne ne change rien : le message traité est le dernier
  // du fil, donc `slice` rend le fil entier. Elle ne vaut que pour un
  // retraitement — et un retraitement qui ment sur ce qu'on savait au moment du
  // tour ne vaut rien.
  //
  // Elle ne borne QUE l'affichage. La salve, la fraîcheur et l'ordonnancement
  // continuent de lire le fil entier : `burstSettled` a besoin de savoir si
  // quelque chose est arrivé APRÈS, et le lui cacher ferait répondre au milieu
  // d'une salve ouverte.
  const currentIndex = thread.turns.findIndex(
    (turn) => turn.direction === 'INBOUND' && turn.sourceId === thread.currentInboundId,
  );
  const shown = currentIndex < 0 ? thread.turns : thread.turns.slice(0, currentIndex + 1);

  for (const turn of shown) {
    const isCurrent = turn.direction === 'INBOUND' && turn.sourceId === thread.currentInboundId;
    const label =
      turn.direction === 'INBOUND'
        ? isCurrent
          ? 'EUX (le message auquel tu réponds maintenant)'
          : 'EUX'
        : turn.provenance === 'sent_first_touch'
          ? 'NOUS (premier message, réellement envoyé)'
          : turn.provenance === 'sent_autonomous_reply'
            ? 'NOUS (réponse automatique, remise confirmée)'
            : turn.provenance === 'attempted_autonomous_reply'
              ? 'NOUS (réponse automatique tentée — remise NON confirmée, ne t’y réfère pas comme à un acquis)'
              : 'NOUS (réponse validée par un humain — envoi non prouvé)';
    const suffix = turn.classification === null ? '' : ` [classé ${turn.classification}]`;
    lines.push('', `--- ${label}${suffix}`, turn.text);
  }

  return lines.join('\n');
}
