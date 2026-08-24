import type { InboxReadability } from '@/lib/instagram/inboxScan';
import type { ThreadIdSource } from '@/lib/instagram/inboxNetwork';
import type { ObservedThreadMessage, ThreadMessageSource } from '@/lib/instagram/inboundThread';
import type { ThreadIdentityVerdict } from '@/lib/instagram/threadDetailNetwork';
import type { InstagramSessionState } from '@/lib/instagram/types';

/**
 * IG5.1 §5 — le contrat du rail ENTRANT, et ce qu'il rend impossible.
 *
 * ---------------------------------------------------------------------------
 * La propriété centrale : il n'y a rien à appeler pour envoyer
 * ---------------------------------------------------------------------------
 *
 * `InstagramInboundRail` expose trois méthodes : vérifier la session, relever
 * la boîte, fermer. Il n'y a pas de `sendFirstTouchDm`, pas de `reply`, pas de
 * `markAsRead`, pas de `click`, pas de `type`, pas de `evaluate`. Ce n'est pas
 * une méthode désactivée derrière un booléen — c'est une absence, donc une
 * erreur de compilation pour qui essaierait.
 *
 * C'est la même discipline que R1 avait posée pour le DRY-RUN
 * (`InstagramReadOnlyRail`), et elle est reprise ici parce que la mission la
 * redemande explicitement : « le chemin inbound ne doit pas pouvoir appeler
 * IGDirectTextSendMutation, même par erreur ».
 *
 * ---------------------------------------------------------------------------
 * Trois barrières, pas une
 * ---------------------------------------------------------------------------
 *
 *   1. **Le type** — ce contrat n'a pas de méthode d'envoi (ici) ;
 *   2. **L'exécution** — le collecteur refuse de tourner si l'objet qu'on lui
 *      passe expose quand même la primitive (`hasSendPrimitive`), parce qu'un
 *      type décrit ce qu'on croit avoir, pas ce qu'on a ;
 *   3. **Le réseau** — la garde installée sur le contexte navigateur refuse
 *      qu'une requête d'effet SORTE du processus, y compris celle qu'aucune
 *      ligne de ce dépôt n'a demandée. Le rail entrant réutilise la garde
 *      d'adjudication (`classifyAdjudicationRequest`), qui refuse tout `POST`
 *      vers un chemin de messagerie et TOUTE mutation GraphQL —
 *      `IGDirectTextSendMutation` comme `useIGDMarkThreadAsReadMutation`.
 *
 * La troisième est celle qui compte le plus, parce qu'elle ne dépend d'aucune
 * discipline d'appelant : un navigateur pilotable n'est pas un client HTTP, et
 * l'application React d'Instagram émet des requêtes que personne n'a écrites.
 *
 * ---------------------------------------------------------------------------
 * Ce que le rail rend, et ce qu'il ne rend pas
 * ---------------------------------------------------------------------------
 *
 * Il rend des DONNÉES (`InstagramInboundSweep`), jamais une `Page` Playwright :
 * aucun appelant ne reçoit d'objet capable d'agir sur le DOM. Il n'écrit rien
 * en base — la persistance vit dans `instagramIntake`, et cette séparation est
 * ce qui permet d'exercer tout l'aval sur des relevés reconstitués, sans
 * navigateur et sans Instagram.
 */

/** Ce qu'une ligne de la boîte a laissé lire, et si son fil a pu être ouvert. */
export type ThreadReadOutcome = 'READ' | 'NOT_OPENED' | 'UNREADABLE' | 'SKIPPED_LIMIT';

export interface ObservedInboundThread {
  readonly rowIndex: number;
  /** `null` quand la ligne ne porte aucun identifiant navigable — on ne devine pas d'URL. */
  readonly threadId: string | null;
  /**
   * IG5 R2 — D'OÙ vient cet identifiant : du lien porté par la ligne (`DOM`),
   * ou de la liste de fils qu'Instagram a servie pour construire la boîte
   * (`NETWORK`). `null` quand il n'a pas pu être établi.
   *
   * La provenance est rendue plutôt que déduite parce que les deux sources
   * n'ont pas la même force de preuve, et parce qu'une régression silencieuse
   * de l'une vers l'autre doit se voir dans un rapport, pas s'expliquer six
   * semaines plus tard.
   */
  readonly threadIdSource: ThreadIdSource | null;
  /**
   * La contrepartie que la LIGNE désigne, telle que la liste réseau la nomme.
   *
   * Distincte de `counterpartyHandle`, qui n'est renseignée qu'après ouverture
   * du fil et provient des liens de profil du fil lui-même. Celle-ci existe même
   * quand le fil n'a pas été ouvert : elle dit de qui est la conversation qu'on
   * n'a pas su lire. Elle n'est pas persistée — c'est un élément de rapport.
   */
  readonly rowCounterpartyHandle: string | null;
  /** Le texte visible de la ligne, borné. Ce qu'un humain voit déjà en ouvrant sa boîte. */
  readonly rowText: string;
  /** L'âge affiché, en ms. `null` quand l'horodatage relatif est illisible — jamais 0. */
  readonly ageMs: number | null;
  /**
   * Le handle de la contrepartie, quand le FIL le nomme par un lien de profil.
   * Un nom d'affichage seul ne remplit jamais ce champ (§7).
   */
  readonly counterpartyHandle: string | null;
  /** Plusieurs handles dans le périmètre : fil de groupe, ou rendu ambigu. */
  readonly handles: readonly string[];
  readonly outcome: ThreadReadOutcome;
  readonly messages: readonly ObservedThreadMessage[];
  /**
   * IG5 R3 — D'OÙ viennent ces messages : de la réponse `IGDThreadDetailQuery`
   * que l'ouverture du fil a fait émettre (`THREAD_DETAIL_NETWORK`), ou des
   * bulles du DOM (`DOM_BUBBLE`). `null` quand le fil n'a pas été lu.
   *
   * Rendue plutôt que déduite, pour la même raison que `threadIdSource` : les
   * deux sources n'ont pas la même force de preuve — l'une NOMME l'expéditeur
   * et date le message, l'autre déduit qui parle d'une position à l'écran — et
   * une bascule silencieuse de l'une vers l'autre doit se voir.
   */
  readonly messageSource: ThreadMessageSource | null;
  /**
   * IG5 R3 — la réponse réseau parlait-elle bien du fil demandé ?
   *
   * Ce n'est pas une précaution de principe : ouvrir UN fil fait revenir SEIZE
   * réponses de détail, dont deux seulement nomment le fil ouvert. Les autres
   * sont les conversations voisines, préchargées pour la liste. `null` quand
   * aucune réponse n'a été écoutée pour ce fil.
   */
  readonly threadIdentity: ThreadIdentityVerdict | null;
  /** La récolte a atteint sa borne : l'observation est INCOMPLÈTE, jamais « vide ». */
  readonly truncated: boolean;
  readonly detail: string;
}

/** Un tour de relève, tel qu'il a été OBSERVÉ. Aucune décision commerciale ici. */
export interface InstagramInboundSweep {
  readonly accountHandle: string;
  readonly sessionState: InstagramSessionState;
  /** « Je n'ai pas su lire » n'est jamais « il n'y avait rien ». */
  readonly readability: InboxReadability;
  /** Pourquoi la relève s'est arrêtée là où elle s'est arrêtée. `null` = elle est allée au bout. */
  readonly stopReason: string | null;
  readonly threads: readonly ObservedInboundThread[];
  readonly rowsSeen: number;
  /**
   * IG5 R2 — la liste de fils servie par Instagram a-t-elle été COMPRISE ?
   *
   * `false` ne veut pas dire « boîte vide » : il veut dire que la source
   * d'identifiants n'a rien donné, donc qu'aucune absence de réponse ne peut
   * être déduite des lignes restées fermées.
   */
  readonly threadListReadable: boolean;
  /** Fils nommés par cette liste. `0` sur une liste non comprise. */
  readonly threadListSize: number;
  /** Requêtes d'écriture refusées par la garde pendant la relève. Attendu : 0. */
  readonly blockedWriteRequests: number;
  readonly screenshotPath: string | null;
  readonly durationMs: number;
}

export interface InstagramInboundSweepInput {
  /** Le compte qui relève — le nôtre. Le rail refuse de conclure sans lui. */
  readonly accountHandle: string;
  /** Fils ouverts au plus pendant ce tour. Une borne, jamais « tous ». */
  readonly maxThreads: number;
}

export interface InstagramInboundRail {
  /** Ouvre (ou réutilise) la session persistante et dit dans quel état elle est. */
  ensureSession(): Promise<{ readonly state: InstagramSessionState; readonly detail: string }>;
  /** Relève la boîte de réception, en lecture seule, et rend ce qui a été observé. */
  observeInbox(input: InstagramInboundSweepInput): Promise<InstagramInboundSweep>;
  close(): Promise<void>;
}

/**
 * Le rail qu'on m'a passé sait-il marquer un fil comme lu, ou envoyer ?
 *
 * Vérifié à l'exécution en plus du type, pour la même raison que
 * `hasSendPrimitive` (IG2) : la question posée est « quelqu'un m'a-t-il donné
 * plus que ce que je demande ? », et un type ne répond pas à cela.
 *
 * La liste est nommée plutôt que déduite : ce sont exactement les capacités que
 * la mission interdit au chemin entrant.
 */
export const FORBIDDEN_INBOUND_METHODS: readonly string[] = [
  'sendFirstTouchDm',
  'sendDm',
  'reply',
  'markThreadAsRead',
  'follow',
  'unfollow',
  'like',
  'comment',
];

export function forbiddenMethodsOn(rail: object): string[] {
  const found: string[] = [];
  for (const name of FORBIDDEN_INBOUND_METHODS) {
    if (typeof (rail as Record<string, unknown>)[name] === 'function') found.push(name);
  }
  return found;
}
