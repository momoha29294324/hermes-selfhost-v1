/**
 * HERMES-REPLY-DELIVERY-R1 §2 — « ce fil a-t-il un PASSÉ ? », en code pur.
 *
 * ---------------------------------------------------------------------------
 * La question, et pourquoi elle est structurelle
 * ---------------------------------------------------------------------------
 * Une primitive de réponse et une primitive de premier contact se ressemblent
 * assez pour être confondues par accident : même composeur, même saisie, même
 * clic. Ce qui les sépare vraiment n'est pas la mécanique, c'est un fait
 * observable — **une réponse arrive dans une conversation qui existe déjà**.
 *
 * Le dépôt en tire une garde plutôt qu'une consigne. `sendThreadReply` refuse
 * un fil dont l'historique n'est pas CONSTATÉ, ce qui rend impossible le
 * scénario qui inquiéterait le plus : un identifiant de fil erroné, un fil vide
 * ouvert par erreur, et un message commercial remis à quelqu'un qui ne nous a
 * jamais écrit — c'est-à-dire un premier contact passé par une porte qui n'a
 * pas les gardes du premier contact (audience, doublon, contact établi,
 * approbation `AUTONOMOUS_POLICY`).
 *
 * ---------------------------------------------------------------------------
 * Fail-closed, comme partout ailleurs
 * ---------------------------------------------------------------------------
 * Trois issues, jamais deux. Une récolte ILLISIBLE ne dit pas « fil vide », et
 * elle ne dit pas non plus « fil peuplé » : elle dit qu'on n'a pas pu lire, et
 * l'appelant s'arrête. C'est la leçon du 14 août, reprise ici sans
 * aménagement — « je n'ai pas pu lire » n'est jamais « c'est bon ».
 */

import type { ThreadHarvest } from '@/lib/instagram/threadHarvest';
import { normalizeMessageText } from '@/lib/instagram/deliveryProof';

/**
 * Combien d'éléments porteurs de texte, hors composeur, suffisent à dire qu'une
 * conversation a eu lieu.
 *
 * Deux, et pas un. Un fil réellement vide n'en porte aucun ; un fil qui a servi
 * en porte des dizaines. Le seuil bas n'est pas une tolérance : c'est le refus
 * d'exiger une quantité qui ferait échouer un fil légitime peu bavard — un
 * premier message et une réponse d'un mot suffisent, et c'est exactement le cas
 * nominal de ce round.
 *
 * Il est délibérément plus strict que `MIN_TEXT_BEARING_OUTSIDE_COMPOSER` (3),
 * qui répond à une autre question : celle-là cherche le PÉRIMÈTRE d'un fil,
 * celle-ci son CONTENU. Les confondre reviendrait à conclure « il y a eu une
 * conversation » à partir d'un en-tête et d'un horodatage.
 */
export const MIN_HISTORY_TEXT_NODES = 2;

/**
 * La longueur minimale d'un texte pour compter comme un message.
 *
 * Écarte les fragments d'interface qui portent une lettre ou un chiffre — un
 * séparateur, un compteur, une initiale d'avatar — sans écarter « ok », qui est
 * une réponse parfaitement ordinaire dans un DM.
 */
export const MIN_HISTORY_TEXT_LENGTH = 2;

export type ThreadHistoryVerdict =
  /** La récolte n'a pas pu s'exécuter. Aucune conclusion, dans aucun sens. */
  | 'UNREADABLE'
  /** La récolte a été lue, et le fil ne porte rien. */
  | 'EMPTY'
  /** La récolte a été lue, et le fil porte des messages antérieurs. */
  | 'HAS_HISTORY';

export interface ThreadHistory {
  readonly verdict: ThreadHistoryVerdict;
  /** Combien d'éléments porteurs de texte, hors composeur, ont été comptés. */
  readonly textNodes: number;
  readonly detail: string;
}

/**
 * Le fil porte-t-il des messages antérieurs ?
 *
 * Ne compte QUE ce qui vit hors du sous-arbre du composeur (`level >= 0` — la
 * convention d'`ObservedNode`, où `-1` désigne l'intérieur du composeur). Ce
 * détail est la moitié de la garde : sans lui, le texte qu'on vient de saisir
 * ferait à lui seul passer un fil vide pour un fil peuplé.
 *
 * Une récolte TRONQUÉE n'est pas un obstacle ici, contrairement à
 * `adjudicateDelivery` : la troncature borne ce qu'on a vu, et ce qu'on a vu
 * suffit à répondre « il y a quelque chose ». Elle ne pourrait fausser que la
 * conclusion inverse — et la conclusion inverse n'autorise rien.
 */
export function readThreadHistory(harvest: ThreadHarvest): ThreadHistory {
  if (!harvest.readable) {
    return Object.freeze({
      verdict: 'UNREADABLE' as const,
      textNodes: 0,
      detail:
        'la récolte du fil n’a pas pu s’exécuter — on ne sait pas si cette conversation a un passé, ' +
        'et « je n’ai pas pu lire » n’autorise pas à répondre',
    });
  }

  let textNodes = 0;
  for (const node of harvest.nodes) {
    if (node.level < 0) continue;
    if (!node.visible) continue;
    if (normalizeMessageText(node.text).length < MIN_HISTORY_TEXT_LENGTH) continue;
    textNodes += 1;
  }

  if (textNodes < MIN_HISTORY_TEXT_NODES) {
    return Object.freeze({
      verdict: 'EMPTY' as const,
      textNodes,
      detail:
        `${String(textNodes)} élément(s) porteur(s) de texte hors composeur, seuil ` +
        `${String(MIN_HISTORY_TEXT_NODES)} — ce fil n’a pas d’historique lisible. Y écrire ne serait pas ` +
        'répondre : ce serait un premier contact, et le premier contact a ses propres gardes',
    });
  }

  return Object.freeze({
    verdict: 'HAS_HISTORY' as const,
    textNodes,
    detail: `${String(textNodes)} élément(s) porteur(s) de texte hors composeur — la conversation a un passé`,
  });
}
