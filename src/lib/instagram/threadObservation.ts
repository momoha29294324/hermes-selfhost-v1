import type { InboxWitness } from '@/lib/instagram/inboxScan';
import type { InstagramSessionState } from '@/lib/instagram/types';

/**
 * IG2.1 §2 — le vocabulaire de ce qu'un fil de discussion a laissé LIRE.
 *
 * Ce module ne contient que des types. Il existe pour qu'une seule et même
 * description serve deux mondes qui ne peuvent pas s'importer l'un l'autre :
 * le code qui s'exécute DANS la page (Playwright `evaluate`, sans modules) et
 * le code qui DÉCIDE (`deliveryProof.ts`, pur, testable sans navigateur).
 *
 * La règle qui structure tout le reste : la page ne décide de rien. Elle
 * mesure, elle nomme, elle rend des nombres et des chaînes. Le choix du
 * périmètre, la comparaison des textes, la lecture d'un marqueur d'échec et le
 * verdict final vivent tous du côté pur — donc s'exercent sur des cas
 * reconstitués, sans Instagram et sans navigateur.
 *
 * C'est ce partage qui manquait au premier canari. Le périmètre de recherche
 * était choisi dans la page, par un `break` sur le premier ancêtre portant un
 * `aria-label` ; personne ne pouvait écrire un test qui l'aurait pris en défaut,
 * parce qu'il n'existait aucune valeur à donner à ce test. Ici, le choix du
 * périmètre est une fonction pure de la chaîne d'ancêtres MESURÉE.
 */

export interface ObservedRect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/**
 * Un niveau de la remontée depuis le composeur vers la racine, avec les mesures
 * qui permettent de dire s'il contient une CONVERSATION ou seulement un champ
 * de saisie.
 *
 * `textBearingOutsideComposer` est la mesure décisive, et elle est là parce que
 * le canari du 14 août a échoué exactement dessus : le conteneur retenu portait
 * le champ, l'émoji et le bouton d'envoi — trois éléments, zéro texte hors du
 * composeur — et on y a cherché une bulle de message.
 */
export interface AncestorLevel {
  /** 0 = parent immédiat du composeur. */
  readonly index: number;
  readonly tag: string;
  readonly role: string | null;
  readonly ariaLabel: string | null;
  readonly rect: ObservedRect;
  /** Éléments porteurs de texte visible situés HORS du sous-arbre du composeur. */
  readonly textBearingOutsideComposer: number;
  /** Hauteur de ce niveau rapportée à celle du composeur. */
  readonly heightRatio: number;
  /** Ce niveau est `main` ou `body` : la remontée s'arrête ici, quoi qu'il arrive. */
  readonly isDocumentRoot: boolean;
}

/**
 * Un élément observé dans le fil. Rendu tel quel : aucune normalisation, aucun
 * verdict, aucune interprétation.
 *
 * Ce qui n'y figure jamais : `href`, `src`, `class`, le HTML, et toute valeur
 * susceptible de porter un jeton de session. Les classes CSS d'Instagram sont
 * minifiées et changent à chaque déploiement — les lire donnerait un rail qui
 * marche aujourd'hui et ment demain (mission §6).
 */
export interface ObservedNode {
  readonly id: number;
  readonly parentId: number | null;
  /**
   * Index du PLUS PETIT niveau de `ancestorChain` qui contient cet élément.
   * `-1` quand il est dans le sous-arbre du composeur.
   */
  readonly level: number;
  readonly tag: string;
  readonly role: string | null;
  readonly ariaLabel: string | null;
  readonly title: string | null;
  /**
   * `textContent` complet de l'élément, borné. C'est la concaténation de TOUS
   * ses descendants : un message qu'Instagram découpe en dix `<span>` s'y lit
   * d'un seul tenant, et c'est la raison pour laquelle cette valeur est
   * préférée à `innerText` (qui insère des sauts de ligne aux frontières de
   * blocs) et aux nœuds texte pris un par un.
   */
  readonly text: string;
  readonly rect: ObservedRect;
  readonly visible: boolean;
  /**
   * Couleur calculée du texte et remplissage SVG, quand ils existent.
   *
   * Corroboration seulement, jamais preuve : une couleur nomme un style, pas un
   * état. `deliveryProof` n'en fait rien tant qu'un signal accessible ne dit pas
   * la même chose.
   */
  readonly color: string | null;
  readonly fill: string | null;
}

/**
 * Un lien de profil lu dans le fil, avec le niveau d'ancêtre qui le contient.
 *
 * Le niveau est rendu plutôt que filtré : c'est le code pur qui décide du
 * périmètre, donc c'est lui qui décide quels liens comptent. Une observation
 * qui aurait déjà filtré ne permettrait pas de rejouer un autre périmètre sur
 * la même récolte.
 */
export interface ObservedHandleLink {
  readonly handle: string;
  readonly level: number;
}

/** Ce que la conversation a laissé lire, une fois. Aucune décision ici. */
export interface ThreadObservation {
  readonly threadUrl: string;
  /**
   * Ce que la boîte de réception a montré, CLASSÉ (IG2.4).
   *
   * `null` quand elle n'a pas été lue du tout. Un témoin illisible n'est pas
   * `null` : il porte `INBOX_UNREADABLE` / `THREAD_UNKNOWN` et dit pourquoi —
   * la différence est exactement celle qui manquait le 14 août.
   */
  readonly inbox: InboxWitness | null;
  /** Pourquoi l'observation s'est arrêtée là où elle s'est arrêtée. */
  readonly stopReason: string | null;
  readonly sessionState: InstagramSessionState;
  /** Liens de profil lus sous la racine bornée, chacun avec son niveau. */
  readonly handleLinks: readonly ObservedHandleLink[];
  readonly composerRect: ObservedRect | null;
  readonly composerText: string;
  readonly ancestorChain: readonly AncestorLevel[];
  readonly nodes: readonly ObservedNode[];
  /** La récolte a atteint sa borne : l'observation est INCOMPLÈTE, jamais « vide ». */
  readonly truncated: boolean;
  readonly screenshotPath: string | null;
  /** Requêtes d'écriture refusées par la garde pendant l'observation. Attendu : 0. */
  readonly blockedWriteRequests: number;
  /** Clics posés pour ouvrir la conversation. Aucun ne vise un contrôle d'envoi. */
  readonly openClicks: number;
  readonly durationMs: number;
}
