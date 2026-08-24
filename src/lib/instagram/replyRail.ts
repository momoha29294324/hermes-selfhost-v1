/**
 * HERMES-REPLY-DELIVERY-R1 §2/§3/§9 — le contrat de la primitive de RÉPONSE, et
 * ce qu'elle refuse de savoir faire.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi un TROISIÈME contrat, et pas un paramètre de plus sur le second
 * ---------------------------------------------------------------------------
 * Le dépôt en avait deux : `InstagramReadOnlyRail` (ouvrir, lire, fermer) et
 * `InstagramLiveRail`, qui ajoute `sendFirstTouchDm` — la seule primitive
 * capable de toucher un prospect qui ne nous a jamais écrit. Ajouter un
 * `mode: 'reply'` à cette dernière aurait été le pire arrangement : un seul
 * objet saurait alors démarcher ET répondre, et tout possesseur d'un rail de
 * réponse détiendrait aussi de quoi produire un premier contact.
 *
 * Les deux gestes se ressemblent — un composeur, un texte, un clic — et c'est
 * exactement pourquoi ils doivent être séparés dans le TYPE. Ce qui les
 * distingue n'est pas la mécanique, c'est ce qu'ils engagent :
 *
 *   * `sendFirstTouchDm` part d'un PROFIL, clique « Message », et CRÉE une
 *     conversation. Sa cible est un handle ;
 *   * `sendThreadReply` part d'un FIL EXISTANT désigné par son identifiant,
 *     n'ouvre rien, et refuse un fil sans historique. Sa cible est un
 *     `threadId` observé, pas un nom.
 *
 * Un rail de réponse n'a donc aucune raison de connaître la page de profil
 * comme point de départ, ni `/direct/new/` : sa garde de navigation
 * (`isAllowedReplyNavigation`) ne les lui donne pas.
 *
 * ---------------------------------------------------------------------------
 * Trois choses que ce contrat rend impossibles
 * ---------------------------------------------------------------------------
 *   1. **répondre à côté** — le fil est désigné par `expectedThreadId`, une
 *      suite de chiffres venue de `r6b_inbound_messages.provider_thread_id`. Ni
 *      « le premier fil de la liste », ni « celui qui porte ce nom », ni une
 *      URL libre : l'appelant ne passe pas d'URL, le rail la construit ;
 *   2. **répondre à quelqu'un d'autre** — trois preuves doivent concorder avant
 *      la moindre saisie : l'URL réellement atteinte porte l'identifiant
 *      attendu, l'en-tête du fil nomme le correspondant attendu, et le compte
 *      connecté est bien le nôtre. Une seule qui manque, et rien n'est saisi ;
 *   3. **premier contact déguisé** — un fil sans aucun message antérieur
 *      lisible n'est pas une conversation, c'est une page vide. La primitive
 *      s'y arrête (`IG_REPLY_EMPTY_THREAD`) : « répondre » suppose que quelque
 *      chose a été dit.
 *
 * ---------------------------------------------------------------------------
 * §9 — trois niveaux de certitude, jamais confondus
 * ---------------------------------------------------------------------------
 * Le résultat distingue ce que le dépôt a appris à distinguer le 14 août :
 *
 *   * **effet tenté** (`kind: 'ATTEMPTED'`) — le clic a eu lieu. C'est tout ce
 *     que le rail sait de lui-même ;
 *   * **effet observé** (`observation.harvestReadableAfter`) — la récolte
 *     d'après-clic a pu s'exécuter. « Je n'ai pas pu lire » n'est pas
 *     « il n'y a rien » ;
 *   * **remise confirmée** (`observation.deliveryVerdict === 'SENT'`) — le code
 *     pur d'`deliveryProof` a conclu, sur une observation lisible, qu'une bulle
 *     sortante porte le texte exact.
 *
 * Le rail ne rend jamais « envoyé ». Il rend ce qu'il a VU, et l'orchestrateur
 * tranche — même partage qu'IG2 §8.
 */

import type { SendControlDecision } from '@/lib/instagram/sendControl';
import type { InstagramSessionState } from '@/lib/instagram/types';

/**
 * Le nom de la primitive, en constante, pour que les gardes qui interrogent un
 * objet à l'exécution posent la même question que les types.
 */
export const REPLY_SEND_PRIMITIVE = 'sendThreadReply';

/**
 * La forme d'un identifiant de fil Instagram, telle que la base la contraint
 * déjà (`ig_inbound_thread_observations.thread_id ~ '^[0-9]{1,40}$'`).
 *
 * Vérifiée ICI en plus de là-bas parce que les deux gardes protègent contre des
 * choses différentes : la contrainte de base empêche d'ÉCRIRE une valeur
 * douteuse, celle-ci empêche de NAVIGUER vers une valeur qui ne viendrait pas
 * de la base.
 */
export const THREAD_ID_PATTERN = /^[0-9]{1,40}$/;

export function isThreadId(value: string): boolean {
  return THREAD_ID_PATTERN.test(value);
}

/** L'URL canonique d'un fil. Construite par le rail, jamais reçue d'un appelant. */
export function threadUrlOf(threadId: string): string {
  if (!isThreadId(threadId)) {
    throw new Error(`identifiant de fil Instagram invalide : « ${threadId} »`);
  }
  return `https://www.instagram.com/direct/t/${threadId}/`;
}

// ---------------------------------------------------------------------------
// Ce que la primitive reçoit
// ---------------------------------------------------------------------------

/**
 * La CIBLE, en trois identités qui doivent toutes se vérifier sur place.
 *
 * Aucune n'est déductible des deux autres, et c'est pourquoi les trois sont
 * exigées plutôt que devinées :
 *
 *   * `expectedThreadId` vient de `r6b_inbound_messages.provider_thread_id` du
 *     message DÉCLENCHEUR — l'identifiant qu'Instagram a lui-même donné au fil
 *     où la personne a écrit. C'est la preuve la plus forte disponible ;
 *   * `expectedHandle` vient de `prospects.instagram_handle`, confronté au
 *     `from_address` du message déclencheur. Il sert à relire l'EN-TÊTE du fil :
 *     un identifiant peut être juste et la page montrer autre chose ;
 *   * `expectedAccountHandle` est NOTRE compte (`r6b_inbound_messages.mailbox`).
 *     Il répond à une question que ni l'un ni l'autre ne pose : sommes-nous
 *     connectés sous le compte qui a reçu ce message ? Une session qui aurait
 *     basculé sur un autre profil ouvrirait un fil inexistant, ou pire, un fil
 *     homonyme.
 */
export interface InstagramReplyTarget {
  readonly expectedThreadId: string;
  readonly expectedHandle: string;
  readonly expectedAccountHandle: string;
}

/**
 * §10 — la PROVENANCE, portée par l'appel lui-même.
 *
 * Elle n'influence aucune décision du rail : elle est journalisée et rendue
 * telle quelle, pour qu'une réponse autonome soit distinguable d'un premier
 * contact, d'un geste humain, d'un brouillon hérité ou d'une relance sans avoir
 * à reconstituer l'histoire.
 *
 * Elle est REÇUE et non calculée : un rail qui fabriquerait sa propre
 * provenance décrirait ce qu'il croit être, pas ce qui l'a mandaté.
 */
export interface InstagramReplyProvenance {
  readonly source: 'HERMES_AUTONOMOUS_REPLY';
  readonly planId: string;
  readonly idempotencyKey: string;
  readonly inboundMessageId: string;
  readonly policyVersion: string;
  readonly commercialPolicyVersion: string;
  readonly brainVersion: string;
  /** L'empreinte du texte approuvé. Le rail vérifie que c'est bien celui-là qu'il saisit. */
  readonly bodySha256: string;
}

export interface InstagramReplyInput {
  readonly target: InstagramReplyTarget;
  readonly provenance: InstagramReplyProvenance;
  /** Le texte du plan, mot pour mot. Le rail n'en fabrique jamais et n'en retouche aucun. */
  readonly body: string;
  /**
   * §5 — appelé juste AVANT l'unique clic, et jamais ailleurs.
   *
   * Même contrat qu'IG2 §4 : l'orchestrateur y relit l'arrêt global,
   * l'ordonnanceur, les plafonds, la fraîcheur et l'identité, PUIS inscrit
   * durablement « un effet va être tenté ». Si l'un de ces gestes échoue, la
   * fonction remonte l'erreur SANS cliquer.
   *
   * L'ordre n'est pas une convention : c'est le flot de contrôle. Un processus
   * tué à cet instant laisse « on a essayé, on ne sait pas » — la seule chose
   * vraie — plutôt que « rien n'a été fait ».
   */
  readonly onBeforeExternalEffect: () => Promise<void>;
  /**
   * Où le parcours s'arrête.
   *
   *   * `'thread'` — le fil est ouvert, les trois identités confirmées,
   *     l'historique constaté, et la fonction sort AVANT toute saisie ;
   *   * `'draft'` — le texte est saisi, l'état du composeur et du contrôle
   *     d'envoi sont CONSTATÉS, puis le composeur est vidé. Aucun clic ;
   *   * `null` — le parcours complet, jusqu'à l'unique clic.
   */
  readonly stopAfter: 'thread' | 'draft' | null;
}

// ---------------------------------------------------------------------------
// Ce que la primitive rend
// ---------------------------------------------------------------------------

/**
 * Pourquoi la primitive n'a pas cliqué. Toutes ces situations précèdent le
 * moindre effet : personne n'a été contacté, et le crochet pré-effet n'a même
 * pas été appelé.
 */
export type InstagramReplyAbortCode =
  /** La session s'est dégradée, ou n'était pas utilisable. */
  | 'IG_REPLY_SESSION_LOST'
  /** Le compte connecté n'est pas celui qui a reçu le message. */
  | 'IG_REPLY_ACCOUNT_MISMATCH'
  /** L'URL atteinte n'est pas celle du fil demandé — redirection, fil disparu. */
  | 'IG_REPLY_THREAD_NOT_REACHED'
  /** Le fil ouvert ne nomme pas le correspondant attendu — ou ne le dit pas lisiblement. */
  | 'IG_REPLY_THREAD_IDENTITY_UNCONFIRMED'
  /** Aucun champ de saisie dans le fil. */
  | 'IG_REPLY_COMPOSER_NOT_FOUND'
  /**
   * Le fil ne porte aucun message antérieur lisible.
   *
   * Le refus le plus important du lot : sans historique, « répondre » n'a pas
   * d'objet, et ce qui partirait serait un premier contact par une porte qui
   * n'a pas été construite pour ça.
   */
  | 'IG_REPLY_EMPTY_THREAD'
  /** Le champ de saisie n'a pas reçu le texte exact — rien n'est prêt à partir. */
  | 'IG_REPLY_PAYLOAD_NOT_ENTERED'
  /**
   * Aucun contrôle d'envoi identifiable DANS le fil vérifié — ou aucun
   * périmètre où le chercher, ce que le détail distingue
   * (`SEND_CONTROL_NOT_FOUND` / `SEND_CONTROL_SCOPE_UNKNOWN` /
   * `SEND_CONTROL_DISABLED`, voir `sendControl.ts`).
   */
  | 'IG_REPLY_CONTROL_NOT_FOUND'
  /**
   * HERMES-SEND-CONTROL-PROBE-R1 §18 — PLUSIEURS contrôles d'envoi distincts
   * dans le panneau confirmé.
   *
   * Un refus à part, et non un `CONTROL_NOT_FOUND` de plus : « je n'ai rien
   * trouvé » fait chercher un sélecteur, « j'en ai trouvé deux » fait regarder
   * la page avant de toucher quoi que ce soit. Et surtout, il n'est PAS
   * temporaire : une page qui porte deux boutons d'envoi ne se clarifiera pas
   * toute seule, et prendre le premier reviendrait à laisser l'ordre du
   * document décider où le message part.
   */
  | 'IG_REPLY_CONTROL_AMBIGUOUS';

/** Ce qu'une tentative de réponse a permis d'OBSERVER. Aucune interprétation ici. */
export interface InstagramReplyObservation {
  readonly threadUrl: string;
  /** L'identifiant relu DANS l'URL atteinte, pas celui qu'on a demandé. */
  readonly observedThreadId: string | null;
  /** Le handle relu dans l'EN-TÊTE du fil, pas celui du profil. */
  readonly threadHandle: string | null;
  /** Combien de bulles portaient déjà du texte AVANT la saisie. Preuve d'historique. */
  readonly priorBubbles: number;
  readonly matchingBubblesBefore: number;
  readonly matchingBubblesAfter: number;
  readonly harvestReadableBefore: boolean;
  readonly harvestReadableAfter: boolean;
  readonly composerCleared: boolean;
  readonly outgoingBubbleConfirmed: boolean;
  readonly deliveryFailureMarkers: readonly string[];
  readonly deliveryVerdict: 'SENT' | 'DELIVERY_FAILED' | 'AMBIGUOUS';
  readonly scopeDetail: string;
  readonly sessionState: InstagramSessionState;
  readonly screenshotPath: string | null;
  readonly durationMs: number;
  readonly detail: string;
}

export type InstagramReplyResult =
  | {
      readonly kind: 'NOT_ATTEMPTED';
      readonly code: InstagramReplyAbortCode;
      readonly detail: string;
      readonly sessionState: InstagramSessionState;
      readonly screenshotPath: string | null;
    }
  /** Le fil a été atteint et vérifié, sans aucune saisie. */
  | {
      readonly kind: 'PREVIEWED';
      readonly detail: string;
      readonly sessionState: InstagramSessionState;
      readonly threadUrl: string;
      readonly threadHandle: string | null;
      readonly priorBubbles: number;
      readonly composerReady: boolean;
      readonly screenshotPath: string | null;
    }
  /** Le brouillon a été saisi et CONSTATÉ, puis retiré. Aucun clic. */
  | {
      readonly kind: 'DRAFT_READY';
      readonly detail: string;
      readonly sessionState: InstagramSessionState;
      readonly threadUrl: string;
      readonly threadHandle: string | null;
      readonly priorBubbles: number;
      readonly composerText: string;
      readonly payloadExact: boolean;
      readonly sendControlPresent: boolean;
      readonly sendControlEnabled: boolean;
      /**
       * Le verdict COMPLET de `decideSendControl` — celui-là même dont dépend
       * le clic en mode LIVE. Rendu ici pour qu'un brouillon constate le
       * ciblage de production, et non une variante d'observation.
       */
      readonly sendControl: SendControlDecision;
      readonly composerDescriptor: string;
      readonly composerCleared: boolean;
      readonly screenshotPath: string | null;
    }
  | { readonly kind: 'ATTEMPTED'; readonly observation: InstagramReplyObservation };

/**
 * Le rail capable de RÉPONDRE. Une méthode, un geste, aucun paramètre libre :
 * ni URL, ni sélecteur, ni destinataire arbitraire, ni « nombre de tentatives ».
 *
 * Il n'étend PAS `InstagramReadOnlyRail`, et ce n'est pas un oubli : ce que
 * l'orchestrateur reçoit est ce contrat-ci, donc un `sendThreadReply` et une
 * fermeture. L'implémentation Playwright, elle, hérite bien du rail de lecture
 * — elle a besoin d'ouvrir un profil pour relire un nom d'affichage — mais
 * cette capacité ne remonte pas jusqu'à l'appelant métier, qui ne peut pas s'en
 * servir sans changer le type qu'il demande.
 *
 * Ce qu'aucune des deux faces n'expose, et n'exposera pas : `follow`, `like`,
 * `comment`, `click(selector)`, `evaluate`, `sendFirstTouchDm`.
 */
export interface InstagramReplyRail {
  sendThreadReply(input: InstagramReplyInput): Promise<InstagramReplyResult>;
  close(): Promise<void>;
}

/**
 * L'objet qu'on m'a passé sait-il répondre ?
 *
 * Vérifié à l'exécution et pas seulement au type, pour la raison exacte de
 * `hasSendPrimitive` : la question posée est « quelqu'un m'a-t-il donné plus
 * que ce que je demande ? », et un type ne répond pas à cela.
 */
export function hasReplyPrimitive(rail: object): rail is InstagramReplyRail {
  return typeof (rail as Partial<InstagramReplyRail>)[REPLY_SEND_PRIMITIVE] === 'function';
}

/**
 * Les méthodes qu'un rail de réponse ne doit JAMAIS porter.
 *
 * Interrogée par un test sur l'objet réel, pas seulement sur son type : un rail
 * de réponse qui hériterait un jour de `sendFirstTouchDm` saurait démarcher, et
 * la séparation construite ici disparaîtrait sans qu'aucune ligne ne l'annonce.
 */
export const FORBIDDEN_REPLY_METHODS: readonly string[] = Object.freeze([
  'sendFirstTouchDm',
  'sendDm',
  'sendMessage',
  'follow',
  'like',
  'comment',
  'evaluate',
  'click',
  'type',
  'fill',
]);

/** Les refus qui attendent leur heure, par opposition à ceux qui referment. */
const TEMPORARY_ABORTS: ReadonlySet<InstagramReplyAbortCode> = new Set<InstagramReplyAbortCode>([
  'IG_REPLY_SESSION_LOST',
  'IG_REPLY_THREAD_NOT_REACHED',
  'IG_REPLY_COMPOSER_NOT_FOUND',
  'IG_REPLY_CONTROL_NOT_FOUND',
]);

/**
 * Ce refus peut-il cesser d'être vrai tout seul ?
 *
 * `true` ⇒ une session qui revient, une page qui charge, une interface qui
 * réaffiche son bouton. `false` ⇒ une identité qui ne concorde pas, un fil
 * vide, un texte qui ne s'est pas saisi : réessayer ne les change pas, et
 * réessayer sans les avoir regardés est exactement ce que ce dépôt refuse.
 */
export function isTemporaryReplyAbort(code: InstagramReplyAbortCode): boolean {
  return TEMPORARY_ABORTS.has(code);
}
