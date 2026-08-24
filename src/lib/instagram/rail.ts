import type { InstagramRelationshipObservation } from '@/lib/instagram/relationship';
import type { InstagramIdentitySignal, InstagramSessionState } from '@/lib/instagram/types';

/**
 * IG-R1 §1/§6 — le contrat du rail navigateur, et ce qu'il rend impossible.
 *
 * Ce fichier est la garde structurelle du DRY-RUN. Regardez ce que
 * `InstagramReadOnlyRail` expose : ouvrir une session, la vérifier, ouvrir un
 * profil, la fermer. Il n'y a pas de méthode `sendDm`, pas de `click`, pas de
 * `type`, pas de `follow`, pas de `like`. Pas une méthode désactivée derrière
 * un booléen — aucune méthode.
 *
 * C'est la différence entre « le worker a pour consigne de ne pas envoyer » et
 * « le worker n'a rien à appeler pour envoyer ». La première est une
 * convention qu'un futur diff peut oublier ; la seconde est une erreur de
 * compilation. La mission demande explicitement la seconde (§6 : « Le code doit
 * rendre cette séparation structurelle, pas dépendre d'une convention
 * humaine »).
 *
 * Trois autres propriétés du contrat, toutes vérifiées par les tests :
 *
 *   * `openProfile` prend un HANDLE, pas une URL. Le rail construit lui-même
 *     l'URL canonique (`profileUrl`) : un appelant ne peut donc pas le
 *     conduire vers `/direct/inbox/` ni vers une page d'action.
 *   * la lecture de profil rend des DONNÉES (`InstagramProfileObservation`),
 *     jamais une `Page` Playwright. Aucun appelant ne reçoit d'objet capable
 *     d'agir sur le DOM.
 *   * `ensureSession` peut rendre un état d'arrêt dur ; c'est au worker de
 *     refuser, et le type l'y oblige (union fermée, pas de booléen « ok »).
 */

export interface InstagramSessionStatus {
  readonly state: InstagramSessionState;
  /** Phrase courte pour un humain. Jamais un cookie, jamais un jeton, jamais du HTML brut. */
  readonly detail: string;
  /** Étiquette du profil persistant utilisé, jamais son chemin. */
  readonly profileLabel: string;
  readonly headless: boolean;
}

/** Ce qu'une visite de profil a permis d'OBSERVER. Aucune interprétation ici. */
export interface InstagramProfileObservation {
  /** L'URL demandée par le rail — toujours l'URL canonique du handle attendu. */
  readonly requestedUrl: string;
  /** L'URL réellement atteinte après redirections. */
  readonly finalUrl: string;
  readonly redirected: boolean;
  /** Le profil est introuvable (page d'indisponibilité d'Instagram). */
  readonly profileMissing: boolean;
  /** L'état de session constaté SUR CETTE PAGE — un mur de connexion peut n'apparaître qu'ici. */
  readonly sessionState: InstagramSessionState;
  readonly signals: readonly InstagramIdentitySignal[];
  /**
   * IG2.2 §2 — la relation d'abonnement lue sur cette page.
   *
   * Une LECTURE de plus, pas une capacité de plus : le contrat reste sans
   * méthode d'action, et rien ici ne suit, ne se désabonne ni ne clique. Elle
   * vit sur l'observation de profil plutôt que derrière une méthode dédiée
   * parce qu'elle se lit sur la page déjà ouverte — une seconde méthode
   * signifierait une seconde navigation, donc une charge de plus chez
   * Instagram pour une information déjà à l'écran.
   */
  readonly relationship: InstagramRelationshipObservation;
  /** Chemin d'une capture d'écran, sous `var/` donc hors Git. `null` si non demandée. */
  readonly screenshotPath: string | null;
  readonly durationMs: number;
}

/**
 * Le rail, tel que le worker le voit. Lecture seule, par absence de tout le
 * reste.
 */
export interface InstagramReadOnlyRail {
  /** Ouvre (ou réutilise) la session persistante et dit dans quel état elle est. */
  ensureSession(): Promise<InstagramSessionStatus>;
  /** Ouvre le profil canonique du handle et rend ce qui a été observé. */
  openProfile(handle: string): Promise<InstagramProfileObservation>;
  close(): Promise<void>;
}

/**
 * Erreur technique du rail : le navigateur n'a pas démarré, la navigation a
 * échoué, la page n'a pas répondu. Distincte d'un refus métier — personne n'a
 * été contacté et rien n'a été décidé, il n'y a qu'une panne à journaliser.
 *
 * `IG_BROWSER_PROFILE_BUSY` est la seule de la liste qui ne soit PAS une
 * panne, et elle est ici parce que c'est par ce canal qu'elle remonte : le
 * profil navigateur est tenu par l'autre runtime Hermes, donc rien n'a été
 * ouvert et il n'y a rien à réparer. Les appelants la distinguent — le worker
 * LIVE la traduit en refus (`BLOCKED`) et non en échec, le tour entrant la
 * traduit en `BROWSER_PROFILE_BUSY` — précisément pour qu'une contention
 * normale ne finisse jamais comptée comme une session Instagram en panne.
 */
export class InstagramRailError extends Error {
  readonly code: 'IG_BROWSER_LAUNCH_FAILED' | 'IG_NAVIGATION_FAILED' | 'IG_RAIL_ERROR' | 'IG_BROWSER_PROFILE_BUSY';

  constructor(code: InstagramRailError['code'], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InstagramRailError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// IG2 §2 — le rail LIVE, et la seule primitive qui peut toucher un prospect
// ---------------------------------------------------------------------------

/**
 * Pourquoi ce contrat est SÉPARÉ de `InstagramReadOnlyRail` plutôt qu'un
 * booléen sur le premier.
 *
 * Tout ce que R1 avait construit tenait sur une phrase : « le worker n'a rien à
 * appeler pour envoyer ». Ajouter `sendFirstTouchDm?: …` au contrat de lecture
 * aurait effacé cette phrase pour tout le dépôt — chaque appelant aurait alors
 * détenu un objet potentiellement capable d'agir, et la sûreté serait retombée
 * sur la discipline de chacun.
 *
 * Avec deux contrats, la propriété de R1 tient mot pour mot pour qui ne demande
 * que le premier : le worker DRY-RUN reçoit un `InstagramReadOnlyRail`, n'a
 * toujours aucune méthode d'envoi à appeler, et refuse en plus de tourner si
 * l'objet qu'on lui a passé en expose une (`hasSendPrimitive`). Le seul
 * possesseur d'un `InstagramLiveRail` est le worker canari, et il ne peut
 * l'obtenir que d'un CLI qui l'a construit explicitement.
 */
export const LIVE_SEND_PRIMITIVE = 'sendFirstTouchDm';

/** Ce qu'une tentative d'envoi a permis d'OBSERVER. Aucune interprétation ici. */
export interface InstagramSendObservation {
  /** URL du fil de discussion atteint. */
  readonly threadUrl: string | null;
  /** Handle relu DANS le fil, juste avant la saisie — pas celui du profil. */
  readonly threadHandle: string | null;
  /** Occurrences du texte exact visibles dans le fil AVANT le clic. Attendu : 0. */
  readonly matchingBubblesBefore: number;
  /** Occurrences du texte exact visibles dans le fil APRÈS le clic. */
  readonly matchingBubblesAfter: number;
  /**
   * IG2.1 §3 — les deux récoltes ont-elles pu s'EXÉCUTER ?
   *
   * Ces deux booléens existent à cause du 14 août. Le code qui comptait les
   * bulles levait `ReferenceError: __name is not defined` dès sa première
   * ligne ; le `catch` qui l'entourait rendait une mesure vide, et l'appelant
   * n'en lisait que `matches.length`, c'est-à-dire `0`. « Je n'ai pas pu lire »
   * est devenu « il n'y a rien », et il n'existait aucun champ pour dire la
   * différence. Il en existe deux maintenant, et `judgeSendOutcome` refuse de
   * conclure sans eux.
   */
  readonly harvestReadableBefore: boolean;
  readonly harvestReadableAfter: boolean;
  /** Le composeur s'est vidé — signe que l'UI a accepté l'envoi. */
  readonly composerCleared: boolean;
  /**
   * Le texte exact a été retrouvé dans un élément que l'UI place du côté
   * SORTANT du fil. Vaut `false` si le rail n'a pas su trancher le côté :
   * « je n'ai pas pu lire » n'est jamais « c'est bon » (même règle que
   * `decideIdentity`).
   */
  readonly outgoingBubbleConfirmed: boolean;
  /**
   * IG2.1 §4 — ce qu'Instagram AFFICHE de la remise, quand il en dit quelque
   * chose : « non envoyé », « réessayer », un marqueur d'erreur accolé à la
   * bulle. Vide quand il ne dit rien.
   */
  readonly deliveryFailureMarkers: readonly string[];
  /** Le verdict rendu par `deliveryProof` sur la récolte d'après le clic. */
  readonly deliveryVerdict: 'SENT' | 'DELIVERY_FAILED' | 'AMBIGUOUS';
  /** Comment le périmètre du fil a été retenu — ou pourquoi il ne l'a pas été. */
  readonly scopeDetail: string;
  readonly sessionState: InstagramSessionState;
  readonly screenshotPath: string | null;
  readonly durationMs: number;
  readonly detail: string;
}

/**
 * Pourquoi la primitive n'a pas cliqué. Toutes ces situations précèdent le
 * moindre effet : personne n'a été contacté.
 */
export type InstagramSendAbortCode =
  /** La session s'est dégradée entre le profil et le composeur. */
  | 'IG_SEND_SESSION_LOST'
  /** Le fil ouvert ne porte pas le handle attendu — ou ne le dit pas lisiblement. */
  | 'IG_SEND_THREAD_IDENTITY_UNCONFIRMED'
  /** Aucun bouton « Message » sur le profil. */
  | 'IG_SEND_COMPOSER_NOT_FOUND'
  /** Le champ de saisie n'a pas reçu le texte exact — rien n'est prêt à partir. */
  | 'IG_SEND_PAYLOAD_NOT_ENTERED'
  /** Aucun contrôle d'envoi identifiable : il n'y a rien à cliquer. */
  | 'IG_SEND_CONTROL_NOT_FOUND';

/**
 * Le résultat d'un appel à la primitive, en union fermée.
 *
 * Un booléen `sent` aurait laissé un appelant confondre « rien ne s'est passé »
 * et « quelque chose est peut-être parti ». Ici les deux mondes ne portent
 * même pas les mêmes champs : `NOT_ATTEMPTED` n'a aucune observation à offrir,
 * et `ATTEMPTED` ne dit jamais « envoyé » — il rend ce qui a été VU, et c'est
 * le worker qui tranche (IG2 §8).
 */
export type InstagramSendResult =
  | {
      readonly kind: 'NOT_ATTEMPTED';
      readonly code: InstagramSendAbortCode;
      readonly detail: string;
      readonly sessionState: InstagramSessionState;
      readonly screenshotPath: string | null;
    }
  /**
   * IG2.5 — le brouillon a été saisi et CONSTATÉ, puis retiré. Aucun clic.
   *
   * Ce que ce résultat rend, et que l'aperçu ne pouvait pas rendre : l'état
   * réel du composeur après une saisie automatisée, et celui du contrôle
   * d'envoi qu'Instagram fait apparaître — ou non — en réponse.
   */
  | {
      readonly kind: 'DRAFT_READY';
      readonly detail: string;
      readonly sessionState: InstagramSessionState;
      readonly threadUrl: string | null;
      readonly threadHandle: string | null;
      /** Le texte réellement lu dans le composeur après saisie. */
      readonly composerText: string;
      /** Il correspond EXACTEMENT au payload attendu. */
      readonly payloadExact: boolean;
      /** Un contrôle d'envoi est apparu dans le panneau vérifié. */
      readonly sendControlPresent: boolean;
      /** Il est actif — `aria-disabled` absent ou faux, et il est cliquable. */
      readonly sendControlEnabled: boolean;
      /** Ce que le composeur déclare de lui-même : rôle, contenteditable, focus. */
      readonly composerDescriptor: string;
      /** Le composeur a été vidé avant de rendre la main. */
      readonly composerCleared: boolean;
      readonly screenshotPath: string | null;
    }
  /** IG2 §6 — le chemin a été parcouru jusqu'au dernier point, sans saisie et sans clic. */
  | {
      readonly kind: 'PREVIEWED';
      readonly detail: string;
      readonly sessionState: InstagramSessionState;
      readonly threadUrl: string | null;
      readonly threadHandle: string | null;
      readonly composerReady: boolean;
      readonly screenshotPath: string | null;
    }
  | { readonly kind: 'ATTEMPTED'; readonly observation: InstagramSendObservation };

export interface InstagramSendInput {
  /** Handle figé par le manifeste. Le rail refuse tout fil qui ne le porte pas. */
  readonly expectedHandle: string;
  /** Le texte du manifeste verrouillé, mot pour mot. Le rail n'en fabrique jamais. */
  readonly body: string;
  /**
   * IG2 §4 — appelé juste AVANT l'unique clic, et jamais ailleurs.
   *
   * C'est le crochet qui rend l'ordre non négociable : le worker y inscrit
   * durablement « un effet va être tenté », et si cette écriture échoue, la
   * fonction remonte l'erreur SANS cliquer. Un processus tué à cet instant
   * laisse donc « on a essayé, on ne sait pas » — la seule chose vraie — plutôt
   * que « rien n'a été fait ».
   */
  readonly onBeforeExternalEffect: () => Promise<void>;
  /**
   * IG2.5 — où le parcours s'arrête.
   *
   *   * `'thread'` — le fil est ouvert, l'identité confirmée, et la fonction
   *     sort AVANT toute saisie. Un aperçu ne dépose pas de brouillon.
   *   * `'draft'` — le texte est saisi, l'état du composeur et du contrôle
   *     d'envoi sont CONSTATÉS, puis le composeur est vidé. Aucun clic d'envoi.
   *     C'est le mode qui permet de diagnostiquer la saisie automatisée sans
   *     produire d'effet, et il exerce exactement le même code que l'envoi.
   *   * `null` — le parcours complet, jusqu'à l'unique clic.
   *
   * Une union fermée plutôt que deux booléens : `previewOnly && draftOnly`
   * n'aurait aucun sens, et un état qui n'a pas de sens ne doit pas pouvoir
   * s'écrire.
   */
  readonly stopAfter: 'thread' | 'draft' | null;
}

/**
 * Le rail capable d'agir. UNE méthode, une seule action, aucun paramètre libre :
 * ni URL, ni sélecteur, ni « nombre de tentatives », ni destinataire arbitraire
 * — le handle et le texte viennent du manifeste et sont revérifiés sur place.
 *
 * Ce qu'il n'expose toujours pas, et n'exposera pas : `follow`, `like`,
 * `comment`, `click(selector)`, `evaluate`, ou quoi que ce soit qui rendrait la
 * page pilotable de l'extérieur.
 */
export interface InstagramLiveRail extends InstagramReadOnlyRail {
  sendFirstTouchDm(input: InstagramSendInput): Promise<InstagramSendResult>;
}

/**
 * Le rail qu'on m'a passé sait-il agir ?
 *
 * Vérifié à l'exécution et pas seulement au type, parce que la question posée
 * est justement « quelqu'un m'a-t-il donné plus que ce que je demande ? » — un
 * type ne répond pas à cela, il décrit ce qu'on croit avoir.
 *
 * Le paramètre est `object` et non `InstagramReadOnlyRail` pour cette raison
 * exacte : exiger un rail de lecture aurait interdit de poser la question à
 * tout ce qui n'en est pas un — au rail ENTRANT d'IG5, par exemple, dont le
 * contrat est plus étroit encore (`InstagramInboundRail` n'a même pas
 * `openProfile`). Une garde qu'on ne peut appeler que sur les objets déjà
 * soupçonnés ne garde rien. L'élargissement ne relâche rien : tous les appels
 * existants restent valides, et la question posée à l'exécution est la même.
 */
export function hasSendPrimitive(rail: object): rail is InstagramLiveRail {
  return typeof (rail as Partial<InstagramLiveRail>)[LIVE_SEND_PRIMITIVE] === 'function';
}
