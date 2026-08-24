/**
 * HERMES-CONVERSATION-R2 §23/§24 — la SALVE : trois bulles, une réponse.
 *
 * Instagram encourage à écrire d'affilée. « oui », puis « je fais déjà de la
 * pub », puis « mais ça marche moyen » sont trois lignes en base et une seule
 * phrase dans la tête de celui qui les a tapées. Y répondre trois fois est la
 * signature la plus lisible d'un robot — et y répondre à la DEUXIÈME est pire
 * encore, parce que la troisième arrive pendant qu'on écrit.
 *
 * ---------------------------------------------------------------------------
 * Aucune seconde notion de salve
 * ---------------------------------------------------------------------------
 * `BURST_GAP_MS` existe déjà (LEARNING-R1, `src/lib/learning/outcome.ts`) et
 * vaut cinq minutes. Ce module l'IMPORTE plutôt que de le redéfinir : deux
 * définitions du mot « salve » finiraient par compter deux nombres différents
 * de tours pour la même conversation, et la boucle d'apprentissage n'observerait
 * plus ce que le rail de réponse a réellement vu.
 *
 * Ce que ce module ajoute, et que le comptage n'avait pas besoin de savoir :
 * quelle salve porte un message donné, quel message la CLÔT, et si le silence
 * qui la suit est assez long pour qu'on puisse répondre sans couper la parole.
 *
 * Tout est pur : aucune base, aucun réseau, aucune horloge implicite — `now`
 * est un paramètre, comme partout où ce dépôt décide d'un moment.
 *
 * ---------------------------------------------------------------------------
 * HERMES-MULTI-TURN-BURSTS-R1 — ce qui BORNE une salve
 * ---------------------------------------------------------------------------
 * Ce module ne connaissait qu'une borne : le silence. Trois autres manquaient,
 * et chacune fabriquait une salve qui n'a pas eu lieu.
 *
 *   * NOTRE PROPRE MESSAGE. Les tours sortants étaient IGNORÉS plutôt que
 *     traités comme des séparateurs, et la raison écrite ici était : « deux
 *     bulles reçues à deux secondes d'intervalle sont une seule prise de
 *     parole, que nous ayons ou non écrit entre les deux (nous ne pouvons pas :
 *     l'intervalle est de deux secondes) ». La prémisse est fausse depuis que
 *     Hermes répond seul : l'espacement minimal de la coquille est à zéro, et
 *     le rail autonome répond en quelques secondes. Un message reçu APRÈS notre
 *     réponse répond à cette réponse — le coller à ce qui la précédait fait
 *     relire une question déjà traitée et fabrique un tour qui n'a jamais été
 *     prononcé d'un seul souffle.
 *
 *     Seul un tour sortant EXPOSÉ sépare. Un brouillon validé par un humain et
 *     jamais remis (`exposed: false`, schéma R6B-D2) n'a interrompu personne :
 *     le compter couperait une salve sur un texte que le prospect n'a pas lu.
 *     C'est la même distinction que R12 a rendue opposable, au même endroit.
 *
 *   * LE NOMBRE et LA TAILLE. Une salve sans plafond est une invitation à
 *     donner un fil entier au modèle sous le nom de « dernier message ». Les
 *     deux bornes coupent la salve — elles ne tronquent jamais un message, et
 *     ne masquent jamais le plus récent : le découpage repart AU message qui
 *     dépasse, si bien que la salve qui porte le dernier tour est toujours
 *     complète de son côté récent.
 *
 * Ce que ce module ne fait toujours pas : décider. Il découpe. Ce qui se répond
 * est décidé par `decideAutonomousReply`, et ce qui part par le crochet
 * pré-effet.
 */

import type { ConversationTurn } from '@/lib/conversation/thread';
import { BURST_GAP_MS } from '@/lib/learning/outcome';

export { BURST_GAP_MS };

/**
 * Le nombre maximal de bulles qu'une seule prise de parole peut porter.
 *
 * Huit : au-delà, ce n'est plus « il a écrit d'affilée », c'est un fil. La
 * borne coupe la salve, elle ne jette rien — les bulles au-delà forment la
 * salve précédente, qui garde son propre horodatage et ses propres
 * identifiants.
 */
export const BURST_MAX_MESSAGES = 8;

/**
 * Le nombre maximal de caractères d'une salve.
 *
 * Un message seul peut dépasser cette borne — il est alors sa propre salve, et
 * rien n'est coupé : tronquer un message ferait raisonner sur une phrase
 * amputée, ce qui est pire que de raisonner sur une bulle de trop.
 */
export const BURST_MAX_CHARS = 4_000;

/** Une suite de tours entrants séparés par moins que l'écart de salve. */
export interface InboundBurst {
  /** Les tours de la salve, du plus ancien au plus récent. Jamais vide. */
  readonly turns: readonly ConversationTurn[];
  readonly startedAt: string;
  readonly endedAt: string;
  /** L'identifiant du DERNIER tour — celui auquel on répond. */
  readonly lastSourceId: string;
  /**
   * Les identifiants des messages qui la composent, dans l'ordre.
   *
   * Reconstruire une salve depuis un rapport doit être possible sans relire le
   * fil : c'est ce qui rend le tour logique AUDITABLE plutôt que plausible.
   */
  readonly messageIds: readonly string[];
}

function toBurst(turns: readonly ConversationTurn[]): InboundBurst {
  const first = turns[0];
  const last = turns[turns.length - 1];
  if (first === undefined || last === undefined) {
    // Inatteignable : `groupInboundBursts` n'appelle jamais avec un tableau
    // vide. Refuser bruyamment plutôt que fabriquer une salve sans message.
    throw new Error('salve vide : une salve porte au moins un tour');
  }
  return Object.freeze({
    turns: Object.freeze([...turns]),
    startedAt: first.at,
    endedAt: last.at,
    lastSourceId: last.sourceId,
    messageIds: Object.freeze(turns.map((turn) => turn.sourceId)),
  });
}

/**
 * Découpe le fil en salves entrantes.
 *
 * Quatre choses ferment une salve, et une seule est le silence :
 *
 *   1. l'écart de silence (`gapMs`) — la personne est revenue plus tard ;
 *   2. un tour sortant EXPOSÉ — nous avons parlé entre les deux, donc ce qui
 *      suit répond à ce que nous avons dit, et non à ce qui le précédait ;
 *   3. le nombre de bulles (`BURST_MAX_MESSAGES`) ;
 *   4. le nombre de caractères (`BURST_MAX_CHARS`).
 *
 * Un tour sortant NON exposé — un brouillon validé que personne n'a reçu — est
 * ignoré : il n'a interrompu personne. C'est le seul cas où l'on traverse un
 * tour sortant, et il est écrit ici plutôt que déduit ailleurs.
 *
 * Les bornes 3 et 4 coupent en REPARTANT au message qui dépasse. La salve qui
 * porte le tour le plus récent est donc toujours complète de son côté récent :
 * une borne ne peut jamais masquer la dernière bulle, qui est celle à laquelle
 * on répond.
 *
 * Les tours sont supposés TRIÉS par date croissante — c'est ce que rend
 * `loadConversationThread`, et les retrier ici masquerait un jour un chargement
 * cassé.
 */
export function groupInboundBursts(
  turns: readonly ConversationTurn[],
  gapMs: number = BURST_GAP_MS,
): readonly InboundBurst[] {
  const bursts: InboundBurst[] = [];
  let current: ConversationTurn[] = [];
  let chars = 0;

  const flush = (): void => {
    if (current.length > 0) bursts.push(toBurst(current));
    current = [];
    chars = 0;
  };

  for (const turn of turns) {
    if (turn.direction === 'OUTBOUND') {
      // Un texte que le prospect n'a jamais reçu n'a rien interrompu.
      if (turn.exposed) flush();
      continue;
    }

    const size = turn.text.trim().length;
    const previous = current[current.length - 1];
    if (previous === undefined) {
      current = [turn];
      chars = size;
      continue;
    }

    const gap = Date.parse(turn.at) - Date.parse(previous.at);
    // Un horodatage illisible ne CASSE pas la salve : « je n'ai pas pu
    // comparer » n'est pas « la personne est revenue ». Le côté sûr est de
    // garder les deux ensemble — donc de répondre une fois plutôt que deux.
    const returned = Number.isFinite(gap) && gap >= gapMs;
    const tooMany = current.length >= BURST_MAX_MESSAGES;
    // `current.length > 0` est toujours vrai ici : un message seul plus long
    // que la borne devient sa propre salve au tour suivant, jamais un message
    // tronqué.
    const tooLong = chars + size > BURST_MAX_CHARS;

    if (returned || tooMany || tooLong) {
      flush();
      current = [turn];
      chars = size;
      continue;
    }
    current.push(turn);
    chars += size;
  }
  flush();

  return Object.freeze(bursts);
}

/** La salve qui porte ce message entrant, ou `null` s'il n'en fait partie d'aucune. */
export function burstContaining(
  turns: readonly ConversationTurn[],
  inboundId: string,
  gapMs: number = BURST_GAP_MS,
): InboundBurst | null {
  for (const burst of groupInboundBursts(turns, gapMs)) {
    if (burst.turns.some((turn) => turn.sourceId === inboundId)) return burst;
  }
  return null;
}

/**
 * Ce message CLÔT-il sa salve ?
 *
 * C'est la question qui décide à quel message on répond : au dernier, jamais à
 * un intermédiaire. Un message qui ne clôt pas sa salve est déjà dépassé par un
 * message plus récent — le rail le traite comme périmé, exactement comme il
 * traiterait une réponse arrivée après coup.
 */
export function closesBurst(burst: InboundBurst, inboundId: string): boolean {
  return burst.lastSourceId === inboundId;
}

/**
 * Le silence qui suit cette salve est-il assez long pour qu'on prenne la parole ?
 *
 * `quietMs` vient de la configuration (`conversation.reply.burstQuietMs`) et
 * vaut cinq minutes par défaut — le même ordre de grandeur que l'écart qui
 * sépare deux salves, parce que c'est la même question vue de l'autre côté :
 * tant qu'on ne sait pas si la salve est finie, on ne répond pas.
 */
export function burstSettled(burst: InboundBurst, now: Date, quietMs: number): boolean {
  const ended = Date.parse(burst.endedAt);
  if (!Number.isFinite(ended)) return false;
  return now.getTime() - ended >= quietMs;
}

/**
 * Le texte de la salve, tel qu'un lecteur humain le lirait.
 *
 * Utilisé pour MESURER (longueur du tour, éléments concrets) et pour donner au
 * cerveau la prise de parole entière plutôt que sa dernière bulle. Les bulles
 * sont jointes par un retour à la ligne : ce sont des messages distincts, pas
 * une phrase coupée, et les coller bout à bout produirait des mots collés.
 */
export function burstText(burst: InboundBurst): string {
  return burst.turns
    .map((turn) => turn.text.trim())
    .filter((text) => text.length > 0)
    .join('\n');
}

/**
 * HERMES-MULTI-TURN-BURSTS-R1 — le TOUR LOGIQUE : ce que la personne vient de
 * dire, en une seule prise de parole.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi cette fonction existe
 * ---------------------------------------------------------------------------
 * `burstText` existait depuis R2 et n'avait AUCUN appelant de production : le
 * découpage en salves servait à décider QUAND répondre (`burstSettled`,
 * `closesBurst`), jamais à décider SUR QUOI raisonner. Tout ce qui lit
 * réellement le message — le lexique commercial, le sujet du prix, la demande
 * d'arrêt, le cadre d'énonciation, le budget de longueur, les citations
 * vérifiées — recevait `context.reply.bodyText`, c'est-à-dire la DERNIÈRE
 * BULLE seule.
 *
 * Les conséquences se lisent sur des cas réels :
 *
 *   « ok » / « mais toi après les 7 jours » / « ça coûte combien ? »
 *      la dernière bulle ne porte aucune ancre d'essai : le sujet du prix
 *      sortait en `UNRESOLVED` là où la phrase entière dit `POST_TRIAL_PRICE`.
 *      Les deux escaladent — mais l'une sait pourquoi, et l'autre pas.
 *
 *   « laisse tomber » / « me recontacte pas »
 *      une demande d'arrêt éclatée en deux bulles n'est lue que si le mot
 *      décisif tombe dans la dernière.
 *
 *   « j'avais surtout des curieux » / « et toi tu fais quoi différemment ? »
 *      la question courante était lue sans ce qu'elle commente.
 *
 * ---------------------------------------------------------------------------
 * Le tour logique ne regarde JAMAIS devant lui
 * ---------------------------------------------------------------------------
 * Il s'arrête au message qu'on traite, exactement comme `renderThreadBlock`
 * depuis HERMES-SEMANTIC-GROUNDING-R1 — et pour la même raison, mesurée ce
 * jour-là : montrer au modèle ce qui est arrivé APRÈS lui fait classer le
 * dernier message à la place de celui qu'on juge. En production le message
 * traité EST le dernier de sa salve, donc la borne ne retire rien ; elle ne
 * vaut que pour un retraitement, et un retraitement qui ment sur ce qu'on
 * savait ne vaut rien.
 *
 * ---------------------------------------------------------------------------
 * Ce qu'il n'est pas
 * ---------------------------------------------------------------------------
 * Ce n'est PAS une écriture. Les lignes `r6b_inbound_messages` restent une par
 * bulle, avec leur horodatage et leur identifiant de fournisseur ; rien n'est
 * fusionné, rien n'est réécrit. Le tour logique vit le temps d'un raisonnement
 * et porte la liste de ce qui le compose, pour qu'un rapport puisse le
 * reconstruire.
 */
export interface LogicalUtterance {
  /** Le texte donné au raisonnement — les bulles jointes par un retour à la ligne. */
  readonly text: string;
  /** Les messages qui le composent, du plus ancien au plus récent. Jamais vide. */
  readonly messageIds: readonly string[];
  readonly startedAt: string;
  readonly endedAt: string;
  /** Vrai dès que la prise de parole porte plus d'une bulle. */
  readonly aggregated: boolean;
}

/**
 * Le tour logique qui se termine par ce message.
 *
 * `fallbackText` est le corps du message tel que la base le porte. Il est rendu
 * TEL QUEL quand la prise de parole n'a qu'une bulle — donc dans l'écrasante
 * majorité des cas, et dans tout le corpus de certification existant : le
 * texte du fil est écrêté (`MAX_REPLY_BODY_CHARS`), et faire passer un chemin
 * d'écrêtage sous un correctif de salve aurait changé, en silence, ce que le
 * modèle lit d'un message ordinaire.
 */
export function currentUtterance(
  turns: readonly ConversationTurn[],
  inboundId: string,
  fallbackText: string,
  gapMs: number = BURST_GAP_MS,
): LogicalUtterance {
  const single = (): LogicalUtterance =>
    Object.freeze({
      text: fallbackText,
      messageIds: Object.freeze([inboundId]),
      startedAt: '',
      endedAt: '',
      aggregated: false,
    });

  const burst = burstContaining(turns, inboundId, gapMs);
  if (burst === null) return single();

  const index = burst.turns.findIndex((turn) => turn.sourceId === inboundId);
  if (index < 0) return single();

  const upToCurrent = burst.turns.slice(0, index + 1);
  const first = upToCurrent[0];
  const last = upToCurrent[upToCurrent.length - 1];
  if (first === undefined || last === undefined) return single();
  if (upToCurrent.length === 1) {
    return Object.freeze({
      text: fallbackText,
      messageIds: Object.freeze([inboundId]),
      startedAt: first.at,
      endedAt: last.at,
      aggregated: false,
    });
  }

  return Object.freeze({
    // Un retour à la ligne, jamais une espace : ce sont des messages distincts,
    // et les coller bout à bout produirait des mots collés.
    text: upToCurrent
      .map((turn) => turn.text.trim())
      .filter((text) => text.length > 0)
      .join('\n'),
    messageIds: Object.freeze(upToCurrent.map((turn) => turn.sourceId)),
    startedAt: first.at,
    endedAt: last.at,
    aggregated: true,
  });
}
