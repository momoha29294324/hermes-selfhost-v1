/**
 * HERMES-REAL-THREAD-PREVIEW-R1 §2 — le contrat d'INSPECTION d'un fil, et la
 * seule raison pour laquelle il existe séparément.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi un quatrième contrat, et pas un mode de plus
 * ---------------------------------------------------------------------------
 * `sendThreadReply` sait déjà s'arrêter avant la saisie (`stopAfter: 'thread'`).
 * Cet arrêt est réel, il est testé, et il ne suffit pas ici — pour deux raisons
 * qui n'ont rien à voir avec la confiance qu'on lui accorde :
 *
 *   1. **il n'est pas atteignable.** Le seul chemin vers lui part d'un plan
 *      `AUTO_REPLY_ELIGIBLE` pris atomiquement. Tant qu'aucune conversation
 *      fraîche n'est éligible — et au 22 août 2026 les deux seules qui aient
 *      répondu sont terminalement closes —, `--preview` n'ouvre rien du tout.
 *      Un aperçu qui exige la même éligibilité que l'envoi ne peut pas servir à
 *      valider le chemin AVANT qu'un envoi soit possible ;
 *   2. **il est un booléen sur l'objet qui sait envoyer.** `stopAfter` est un
 *      champ ; le champ voisin est `body`, et la méthode qui les lit est celle
 *      qui clique. Ce que ce round doit exercer contre un vrai fil Instagram
 *      est le CIBLAGE, et il n'y a aucune raison que l'objet qui l'exerce
 *      détienne de quoi écrire.
 *
 * Ce contrat-ci ne porte donc ni texte, ni crochet pré-effet, ni mode :
 * **il n'existe aucune valeur d'entrée qui le ferait écrire quelque part**.
 * L'absence de `body` n'est pas une précaution, c'est le type.
 *
 * ---------------------------------------------------------------------------
 * Ce qu'il rend, et pourquoi trois valeurs plutôt que deux
 * ---------------------------------------------------------------------------
 * Chaque étape rend `MATCH`, `MISMATCH` ou `UNKNOWN`, et les deux dernières
 * refusent également. La distinction n'autorise rien de plus : elle sert au
 * DIAGNOSTIC, qui est tout l'objet de ce round. « L'en-tête nomme quelqu'un
 * d'autre » et « l'en-tête n'a rien laissé lire » demandent deux corrections
 * opposées — la première dit que la cible est fausse, la seconde que notre
 * lecture l'est —, et les confondre sous un même `false` a exactement l'effet
 * qu'on cherche à éviter : desserrer une porte pour réparer un sélecteur.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce contrat n'ouvre pas
 * ---------------------------------------------------------------------------
 *   * il ne rend jamais une conversation éligible — il ne lit aucune décision,
 *     n'écrit aucun plan, ne touche ni `hermes_conversation_plans` ni
 *     `hermes_conversation_effects` ;
 *   * il ne porte pas `sendThreadReply`, et l'implémentation Playwright qui le
 *     réalise est la CLASSE DE BASE de celle qui l'implémente — jamais
 *     l'inverse. Un rail d'inspection ne peut donc pas hériter d'un envoi par
 *     accident : il faudrait l'écrire ;
 *   * il ne conclut rien sur la FRAÎCHEUR. La page est une preuve de plus, pas
 *     la source métier du temps — celle-ci reste
 *     `r6b_inbound_messages.received_at`.
 */

import type { ThreadHistoryVerdict } from '@/lib/instagram/replyHistory';
import type { InstagramReplyAbortCode } from '@/lib/instagram/replyRail';
import type {
  ThreadIdentityObservation,
  ThreadIdentityVerdict,
  ThreadIdentityVia,
} from '@/lib/instagram/threadIdentity';
import type { InstagramSessionState } from '@/lib/instagram/types';

/** Le nom de la primitive d'inspection, en constante, pour les gardes d'exécution. */
export const THREAD_INSPECTION_PRIMITIVE = 'inspectThread';

/**
 * La CIBLE d'une inspection — les trois mêmes identités que celles d'une
 * réponse, et pas une de plus.
 *
 * Identiques à dessein : ce qu'on valide ici est le ciblage de
 * `sendThreadReply`, donc lui donner une cible d'une autre forme reviendrait à
 * valider autre chose.
 */
export interface ThreadInspectionTarget {
  readonly expectedThreadId: string;
  readonly expectedHandle: string;
  readonly expectedAccountHandle: string;
}

export interface ThreadInspectionInput {
  readonly target: ThreadInspectionTarget;
  /**
   * La marque de fraîcheur CANONIQUE (`r6b_inbound_messages.received_at`) et le
   * texte du dernier message reçu, tels que la base les porte.
   *
   * Fournis pour être CONFRONTÉS à la page, jamais pour être remplacés par
   * elle. Le rail ne rend qu'une concordance ; il ne rend aucun horodatage lu
   * dans l'interface, parce qu'un horodatage d'interface est relatif
   * (« 20 min »), localisé, et arrondi.
   */
  readonly latestInbound: {
    readonly receivedAt: string;
    readonly bodyText: string | null;
  } | null;
}

// ---------------------------------------------------------------------------
// Ce que chaque étape rend
// ---------------------------------------------------------------------------

/** Fail-closed : seul `MATCH` est une concordance établie. */
export type IdentityOutcome = 'MATCH' | 'MISMATCH' | 'UNKNOWN';

export interface AccountIdentityFinding {
  readonly outcome: IdentityOutcome;
  readonly expectedAccountHandle: string;
  /**
   * Les libellés d'action réellement lus sur la page de NOTRE profil, bornés et
   * normalisés par `relationship.ts`.
   *
   * Rendus parce qu'un `UNKNOWN` sans eux n'apprend rien : « aucun libellé lu »
   * et « des libellés lus, mais aucun connu » demandent deux corrections
   * opposées, et ce round existe pour trancher entre les deux.
   */
  readonly labels: readonly string[];
  readonly detail: string;
}

export interface ThreadNavigationFinding {
  readonly requestedThreadId: string;
  readonly requestedUrl: string;
  /** L'URL réellement atteinte. `null` quand la navigation n'a pas eu lieu. */
  readonly landedUrl: string | null;
  /** L'identifiant relu DANS l'URL atteinte — jamais celui qu'on a demandé. */
  readonly threadIdFromUrl: string | null;
  readonly match: boolean;
  /**
   * L'URL a changé mais désigne le même fil (barre oblique finale, casse).
   * Documenté plutôt que toléré en silence : §5 demande de décrire le
   * comportement réel d'Instagram, pas de l'absorber.
   */
  readonly rewritten: boolean;
  readonly detail: string;
}

export interface ThreadIdentityFinding {
  readonly outcome: IdentityOutcome;
  readonly via: ThreadIdentityVia | null;
  readonly expectedHandle: string;
  /** Le nom d'affichage relu sur la page de profil du handle attendu. */
  readonly expectedDisplayNameResolved: boolean;
  readonly panelFound: boolean;
  readonly panelAmbiguous: boolean;
  readonly headerFound: boolean;
  readonly headerHandleCount: number;
  readonly headerTextCount: number;
  readonly panelLabelPresent: boolean;
  readonly bodyHandleCount: number;
  /**
   * §6/§11 — la chaîne d'ancêtres du composeur, mesurée par la page.
   *
   * Rendue telle quelle, tags / rôles / libellés / rectangles seulement : c'est
   * la seule description de la VRAIE structure de `/direct/t/…` que ce dépôt
   * puisse produire sans capturer de contenu privé. Aucune classe CSS n'y
   * figure — elles sont minifiées et changent à chaque déploiement.
   */
  readonly ancestorChain: readonly string[];
  readonly detail: string;
}

export interface ThreadHistoryFinding {
  readonly verdict: ThreadHistoryVerdict;
  readonly textNodes: number;
  readonly harvestReadable: boolean;
  readonly harvestTruncated: boolean;
  readonly detail: string;
}

export interface ComposerFinding {
  readonly found: boolean;
  /** Éditable et non désactivé. `false` en cas de doute — lire n'est pas conclure. */
  readonly enabled: boolean;
  /** Ce que le composeur déclare de lui-même. Aucune classe CSS. */
  readonly descriptor: string | null;
  readonly detail: string;
}

/**
 * §9 — ce que la page corrobore du dernier message reçu.
 *
 * `matched` vaut `true` quand un élément porteur de texte du fil porte
 * exactement le texte que la base a enregistré comme dernier message entrant.
 * `null` quand la question n'a pas pu être posée (récolte illisible, base sans
 * texte). Jamais un horodatage : voir `ThreadInspectionInput.latestInbound`.
 */
export interface LatestMessageFinding {
  readonly watermark: string | null;
  readonly matched: boolean | null;
  readonly detail: string;
}

export interface ThreadInspection {
  readonly target: ThreadInspectionTarget;
  readonly sessionState: InstagramSessionState;
  readonly account: AccountIdentityFinding;
  readonly navigation: ThreadNavigationFinding;
  readonly threadIdentity: ThreadIdentityFinding;
  readonly history: ThreadHistoryFinding;
  readonly composer: ComposerFinding;
  readonly latestMessage: LatestMessageFinding;
  /**
   * Toutes les portes que `sendThreadReply` franchit AVANT sa première saisie
   * seraient-elles vertes sur ce fil, maintenant ?
   *
   * Ce n'est pas une autorisation et ça n'en devient jamais une : les plafonds,
   * la fenêtre, l'arrêt global, l'exclusion, l'état commercial et la fraîcheur
   * ne sont pas regardés ici. C'est la réponse à « le CIBLAGE tient-il contre
   * la vraie interface ? », et à rien d'autre.
   */
  readonly targetingCompatible: boolean;
  /** Le code que `sendThreadReply` aurait rendu, s'il s'était arrêté. */
  readonly blockedBy: InstagramReplyAbortCode | null;
  /**
   * Littéral, et c'est le point : aucune valeur d'entrée ne peut le rendre
   * vrai, parce qu'aucun chemin de ce contrat n'écrit dans une page.
   */
  readonly externalEffect: false;
  readonly diagnostics: readonly string[];
  readonly screenshotPath: string | null;
  readonly durationMs: number;
}

/**
 * Le rail capable d'INSPECTER un fil. Une méthode, aucune écriture.
 *
 * Il n'étend pas `InstagramReplyRail` et celui-ci ne l'étend pas non plus au
 * niveau du TYPE : c'est l'implémentation Playwright de la réponse qui hérite
 * de celle de l'inspection, pour que les deux exercent littéralement le même
 * code de ciblage. Un appelant qui demande une inspection reçoit ce contrat-ci,
 * donc `inspectThread` et une fermeture — et rien qui sache écrire.
 */
export interface InstagramThreadInspectionRail {
  inspectThread(input: ThreadInspectionInput): Promise<ThreadInspection>;
  close(): Promise<void>;
}

/**
 * Les méthodes qu'un rail d'inspection ne doit JAMAIS porter.
 *
 * Interrogée par un test sur l'objet réel, pas seulement sur son type — même
 * raison que `FORBIDDEN_REPLY_METHODS` : la question est « quelqu'un m'a-t-il
 * donné plus que ce que je demande ? », et un type n'y répond pas.
 */
export const FORBIDDEN_INSPECTION_METHODS: readonly string[] = Object.freeze([
  'sendThreadReply',
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

export function hasInspectionPrimitive(rail: object): rail is InstagramThreadInspectionRail {
  return typeof (rail as Partial<InstagramThreadInspectionRail>)[THREAD_INSPECTION_PRIMITIVE] === 'function';
}

// ---------------------------------------------------------------------------
// Les classements — purs, donc éprouvables sans navigateur
// ---------------------------------------------------------------------------

/**
 * Le compte connecté est-il celui qui a reçu le message ?
 *
 * `readRelationship` rend `isOwnProfile` en trois états, et ce module ne fait
 * que les nommer : « Modifier le profil » lu chez nous ⇒ `MATCH` ; un témoin de
 * relation ⇒ la preuve qu'on n'est PAS chez nous, donc `MISMATCH` ; un en-tête
 * qui n'a rien laissé lire ⇒ `UNKNOWN`.
 */
export function classifyAccountIdentity(isOwnProfile: boolean | null): IdentityOutcome {
  if (isOwnProfile === true) return 'MATCH';
  if (isOwnProfile === false) return 'MISMATCH';
  return 'UNKNOWN';
}

/**
 * Le fil ouvert est-il celui du correspondant attendu ?
 *
 * Le verdict d'AUTORISATION reste celui de `decideThreadIdentity`, et il n'est
 * pas rejugé ici : `ok` ⇒ `MATCH`, un point c'est tout. Ce que cette fonction
 * ajoute est la seule chose que le verdict ne dit pas — POURQUOI il a refusé :
 *
 *   * `MISMATCH` demande une preuve POSITIVE que le fil nomme quelqu'un
 *     d'autre : au moins un handle lu dans l'en-tête, et aucun n'est le nôtre.
 *     C'est le seul cas où la page affirme quelque chose ;
 *   * tout le reste est `UNKNOWN` — panneau introuvable, panneaux
 *     contradictoires, en-tête muet, nom d'affichage non corroboré. Ce sont des
 *     défauts de LECTURE, pas des affirmations de la page, et les traiter en
 *     `MISMATCH` ferait croire à une cible fausse là où c'est notre sélecteur
 *     qui l'est.
 *
 * Les deux refusent identiquement. La distinction ne sert qu'à savoir quoi
 * corriger.
 */
export function classifyThreadIdentityOutcome(
  observation: ThreadIdentityObservation,
  verdict: ThreadIdentityVerdict,
  expectedHandle: string,
): IdentityOutcome {
  if (verdict.ok) return 'MATCH';
  const expected = expectedHandle.toLowerCase();
  const headerHandles = observation.headerHandles.map((handle) => handle.toLowerCase());
  if (headerHandles.length > 0 && !headerHandles.includes(expected)) return 'MISMATCH';
  return 'UNKNOWN';
}

/**
 * L'URL atteinte désigne-t-elle le fil demandé, et l'a-t-elle réécrite ?
 *
 * `rewritten` n'est pas une tolérance : la concordance porte sur
 * l'IDENTIFIANT, jamais sur la chaîne. Une URL qui change en gardant le même
 * identifiant est un fait à documenter (§5) ; une URL qui en porte un autre, ou
 * aucun, n'est pas un fil de repli.
 */
export function describeThreadNavigation(input: {
  readonly requestedThreadId: string;
  readonly requestedUrl: string;
  readonly landedUrl: string | null;
  readonly threadIdFromUrl: string | null;
}): ThreadNavigationFinding {
  const match = input.threadIdFromUrl !== null && input.threadIdFromUrl === input.requestedThreadId;
  const rewritten = match && input.landedUrl !== null && input.landedUrl !== input.requestedUrl;
  const detail = match
    ? rewritten
      ? `fil ${input.requestedThreadId} atteint ; Instagram a réécrit l’URL en « ${input.landedUrl ?? ''} » ` +
        'sans changer d’identifiant'
      : `fil ${input.requestedThreadId} atteint à l’URL demandée, sans réécriture`
    : `fil ${input.requestedThreadId} demandé, page atteinte portant ` +
      `${input.threadIdFromUrl ?? 'aucun identifiant de fil'} — une redirection n’est pas un fil de repli`;
  return Object.freeze({
    requestedThreadId: input.requestedThreadId,
    requestedUrl: input.requestedUrl,
    landedUrl: input.landedUrl,
    threadIdFromUrl: input.threadIdFromUrl,
    match,
    rewritten,
    detail,
  });
}

/**
 * Le code de refus que `sendThreadReply` aurait rendu, dérivé des mêmes
 * constats et dans le MÊME ordre que le sien.
 *
 * L'ordre importe autant que les valeurs : la primitive s'arrête au premier
 * refus, donc un diagnostic qui nommerait le dernier ferait chercher au mauvais
 * endroit. `null` ⇒ toutes les portes de ciblage sont vertes.
 */
export function firstTargetingRefusal(input: {
  readonly sessionUsable: boolean;
  readonly account: IdentityOutcome;
  readonly navigationMatch: boolean;
  readonly composerFound: boolean;
  readonly threadIdentity: IdentityOutcome;
  readonly history: ThreadHistoryVerdict;
}): InstagramReplyAbortCode | null {
  if (!input.sessionUsable) return 'IG_REPLY_SESSION_LOST';
  if (input.account === 'MISMATCH') return 'IG_REPLY_ACCOUNT_MISMATCH';
  // Une identité de compte indécidable n'est pas une identité fausse : la
  // primitive la traite en session perdue, et ce diagnostic dit la même chose.
  if (input.account === 'UNKNOWN') return 'IG_REPLY_SESSION_LOST';
  if (!input.navigationMatch) return 'IG_REPLY_THREAD_NOT_REACHED';
  if (!input.composerFound) return 'IG_REPLY_COMPOSER_NOT_FOUND';
  if (input.threadIdentity !== 'MATCH') return 'IG_REPLY_THREAD_IDENTITY_UNCONFIRMED';
  if (input.history !== 'HAS_HISTORY') return 'IG_REPLY_EMPTY_THREAD';
  return null;
}
