/**
 * R6B-D2 — ce qu'une réponse veut dire, et ce que le système a le droit d'en
 * faire.
 *
 * Ce fichier est PUR : aucune base, aucun réseau, aucun modèle. Tout ce qui
 * décide — la conséquence d'une catégorie, le seuil de confiance, la
 * dégradation d'une conclusion trop faible, le refus d'une action externe sous
 * corrélation faible — vit ici, en code testé, jamais dans un prompt
 * (CLAUDE.md, conventions techniques). Le modèle propose une étiquette ; c'est
 * ce fichier qui dit ce qui s'ensuit.
 *
 * ---------------------------------------------------------------------------
 * L'asymétrie qui gouverne tout
 * ---------------------------------------------------------------------------
 *
 * Une action PROTECTRICE (cesser de contacter, supprimer, geler une séquence)
 * et une action EXPANSIVE (écrire dans un CRM externe, ouvrir un dossier chez
 * un tiers) n'ont pas le même coût quand on se trompe :
 *
 *   * se tromper en protégeant coûte un prospect qu'on n'aurait pas dû
 *     arrêter — réversible, interne, visible ;
 *   * se tromper en écrivant chez un tiers écrit le dossier d'un prospect sous
 *     le nom d'un autre, dans un système que ce dépôt ne contrôle pas et ne
 *     sait pas défaire.
 *
 * Les deux ne demandent donc pas la même preuve : la protection s'applique dès
 * `HIGH_CONFIDENCE`, l'écriture externe exige `EXACT`.
 */

import { normalizeForMatching } from '@/lib/conversation/text';
import type { CorrelationStatus } from '@/lib/inbound/correlation';

// ---------------------------------------------------------------------------
// Taxonomie
// ---------------------------------------------------------------------------

export type ReplyCategory =
  /** Intérêt exprimé pour la proposition. */
  | 'INTERESTED'
  /** Demande d'information, sans refus ni engagement. */
  | 'QUESTION'
  /**
   * La personne LIVRE une information sur sa situation — le plus souvent en
   * répondant à ce que nous venons de lui demander.
   *
   * -------------------------------------------------------------------------
   * Le trou que cette étiquette bouche
   * -------------------------------------------------------------------------
   * Hermes ouvre une conversation par une QUESTION (« vous faites comment pour
   * avoir de nouvelles demandes ? »). La réponse attendue est donc, dans le cas
   * NORMAL, un fait sur l'entreprise : « surtout via le bouche à oreille »,
   * « non, jamais essayé », « c'est moi qui gère ».
   *
   * Aucune des neuf autres étiquettes ne décrit cela. Ce n'est pas un intérêt
   * (rien n'est demandé), pas une QUESTION (personne n'interroge), pas une
   * OBJECTION (aucun frein), pas un refus, pas un report, et surtout pas
   * `OTHER` — qui veut dire « ce message ne nous est pas destiné ». Un modèle
   * placé devant ce choix fait ce qu'un humain ferait : il prend la moins
   * fausse et baisse sa confiance, ce qui rabat en `REVIEW_REQUIRED` une phrase
   * parfaitement claire.
   *
   * L'étiquette manquante, c'est le cas le plus fréquent d'une prospection qui
   * marche.
   */
  | 'INFORMATION_SHARED'
  /** Objection explicite (prix, délai, prestataire en place) — conversation ouverte. */
  | 'OBJECTION'
  /** Report explicite dans le temps. */
  | 'NOT_NOW'
  /** Refus, sans demande d'arrêt des contacts. */
  | 'NOT_INTERESTED'
  /** Demande explicite d'arrêter de contacter. */
  | 'UNSUBSCRIBE'
  /** Réponse automatique (absence, accusé de réception). */
  | 'AUTO_REPLY'
  /** Rapport de non-remise émis par un serveur. */
  | 'BOUNCE'
  /** Réponse humaine réelle, hors des cas ci-dessus. */
  | 'OTHER'
  /** Le système ne tranche pas — et le dit plutôt que de choisir au hasard. */
  | 'REVIEW_REQUIRED';

export const REPLY_CATEGORIES: readonly ReplyCategory[] = [
  'INTERESTED',
  'QUESTION',
  'INFORMATION_SHARED',
  'OBJECTION',
  'NOT_NOW',
  'NOT_INTERESTED',
  'UNSUBSCRIBE',
  'AUTO_REPLY',
  'BOUNCE',
  'OTHER',
  'REVIEW_REQUIRED',
];

/**
 * Les seules catégories qu'un MODÈLE a le droit de rendre.
 *
 * `BOUNCE` et `AUTO_REPLY` en sont absents volontairement : ce sont des faits
 * d'en-tête, tranchés avant tout appel (voir `classifyDeterministically`).
 * Laisser le modèle les proposer ouvrirait un second chemin vers la même
 * conclusion, avec une règle différente — donc deux vérités possibles sur le
 * même message.
 */
export const MODEL_REPLY_CATEGORIES: readonly ReplyCategory[] = [
  'INTERESTED',
  'QUESTION',
  'INFORMATION_SHARED',
  'OBJECTION',
  'NOT_NOW',
  'NOT_INTERESTED',
  'UNSUBSCRIBE',
  'OTHER',
  'REVIEW_REQUIRED',
];

export type NextAction =
  | 'HUMAN_REPLY_NOW'
  | 'HUMAN_REVIEW'
  | 'NURTURE_LATER'
  | 'STOP_COLD_FOLLOW_UP'
  | 'SUPPRESS_PERMANENTLY'
  | 'MARK_CHANNEL_UNUSABLE'
  | 'NO_ACTION';

/**
 * États commerciaux post-contact.
 *
 * L'avant-contact n'est PAS ici : `prospects.stage` (0001) décrit le cycle de
 * fabrication d'un message (`discovered → … → approved`), qui n'avance pas sur
 * le même axe. Dupliquer ces valeurs ferait deux colonnes en désaccord.
 */
export type OutreachState =
  | 'CONTACTED'
  | 'REPLIED'
  | 'INTERESTED'
  | 'NOT_NOW'
  | 'NOT_INTERESTED'
  | 'BOUNCED'
  | 'SUPPRESSED'
  | 'REVIEW_REQUIRED';

export const OUTREACH_STATES: readonly OutreachState[] = [
  'CONTACTED',
  'REPLIED',
  'INTERESTED',
  'NOT_NOW',
  'NOT_INTERESTED',
  'BOUNCED',
  'SUPPRESSED',
  'REVIEW_REQUIRED',
];

/**
 * `SUPPRESSED` est terminal pour la machine.
 *
 * Un prospect qui a demandé qu'on arrête ne peut pas être ramené dans un état
 * actif par un traitement automatique — y compris par un message ultérieur qui
 * ressemblerait à de l'intérêt. Seul un humain peut le sortir de là, et il
 * devra le faire explicitement (`cause_kind = 'human'`).
 */
export const TERMINAL_STATES: readonly OutreachState[] = ['SUPPRESSED'];

// ---------------------------------------------------------------------------
// La politique
// ---------------------------------------------------------------------------

/** Ce qu'un désabonnement ou une non-remise inscrit dans `do_not_contact`. */
export type SuppressionScope =
  /** Aucune suppression. */
  | 'none'
  /** L'adresse ne délivre pas — elle devient inutilisable. */
  | 'address_undeliverable'
  /** Demande explicite d'arrêt — suppression outbound permanente. */
  | 'permanent';

export interface CategoryPolicy {
  readonly action: NextAction;
  /**
   * État visé. `null` = aucune transition.
   *
   * Le seul `null` est `AUTO_REPLY`, et il est délibéré : une réponse
   * d'absence est un fait sur l'agenda de quelqu'un, pas sur son intérêt.
   * La traiter comme une réponse ferait sortir de la séquence tous ceux qui
   * sont en vacances — c'est-à-dire perdre des prospects pour une raison qui
   * n'a rien de commercial.
   */
  readonly nextState: OutreachState | null;
  readonly suppression: SuppressionScope;
  /**
   * Un humain a-t-il réellement répondu ? C'est cela qui gèle une future
   * séquence de relance sans réponse — pas le simple fait qu'un octet soit
   * revenu. R6B-D2 n'implémente aucune séquence : ce drapeau est ce qu'une
   * mission de nurture devra respecter, exposé dès maintenant pour qu'elle ne
   * l'invente pas.
   */
  readonly freezesNoReplySequence: boolean;
  /** Un brouillon de réponse a-t-il un sens ? */
  readonly draftEligible: boolean;
  /** Faut-il réveiller un humain tout de suite (speed-to-lead) ? */
  readonly urgentAlert: boolean;
  /**
   * La projection CRM a-t-elle un sens ? Faux quand le système ne sait pas ce
   * que la réponse veut dire : projeter « on ne sait pas » salit un CRM sans
   * rien apprendre à personne.
   */
  readonly crmEligible: boolean;
  /**
   * La conséquence de cette catégorie ne fait que RÉDUIRE le contact futur.
   *
   * C'est le côté sûr de l'asymétrie décrite en tête de fichier, et c'est ce
   * qui autorise une conclusion protectrice à s'appliquer sous corrélation
   * `HIGH_CONFIDENCE` : arrêter d'écrire à quelqu'un qui l'a demandé ne coûte
   * rien à ce quelqu'un, même si on s'est trompé de dossier. Une conséquence
   * commerciale (répondre, projeter dans un CRM) n'a pas cette propriété.
   */
  readonly protective: boolean;
  /**
   * HERMES-TARGETING-R1 §5 — cette catégorie établit-elle qu'un HUMAIN a écrit
   * en retour ?
   *
   * Distinct de tout le reste de cette table, et volontairement : les autres
   * champs disent ce que la réponse VEUT DIRE, celui-ci dit qu'il y a eu
   * réponse. Ce sont deux faits différents, et les confondre est exactement ce
   * qui rendait l'état `REPLIED` inatteignable — aucune catégorie ne le visait,
   * parce que chacune visait déjà une intention, et un prospect qui venait de
   * répondre passait donc de `CONTACTED` à `INTERESTED` sans que le journal ne
   * dise nulle part qu'il avait répondu.
   *
   * Faux pour `AUTO_REPLY` et `BOUNCE`, et pour la même raison qu'ailleurs dans
   * ce fichier : une réponse d'absence est un fait sur un agenda, une
   * non-remise un fait sur une adresse. Ni l'une ni l'autre n'est quelqu'un qui
   * a écrit.
   */
  readonly evidencesHumanReply: boolean;
}

/**
 * Table de conséquences. Exhaustive par construction : `Record<ReplyCategory,…>`
 * fait échouer la compilation le jour où une catégorie est ajoutée sans que sa
 * conséquence ait été décidée.
 */
export const CATEGORY_POLICY: Readonly<Record<ReplyCategory, CategoryPolicy>> = Object.freeze({
  INTERESTED: {
    action: 'HUMAN_REPLY_NOW',
    nextState: 'INTERESTED',
    suppression: 'none',
    freezesNoReplySequence: true,
    draftEligible: true,
    urgentAlert: true,
    crmEligible: true,
    protective: false,
    evidencesHumanReply: true,
  },
  QUESTION: {
    action: 'HUMAN_REPLY_NOW',
    nextState: 'INTERESTED',
    suppression: 'none',
    freezesNoReplySequence: true,
    draftEligible: true,
    urgentAlert: true,
    crmEligible: true,
    protective: false,
    evidencesHumanReply: true,
  },
  INFORMATION_SHARED: {
    // Répondre à ce qu'on lui a demandé est ce qu'un prospect engagé fait ;
    // c'est donc un tour qui appelle la SUITE de la conversation, et
    // `draftEligible` le dit — ce qui suffit à le rendre auto-répondable, la
    // matrice d'autonomie étant dérivée de ce champ et non écrite à part.
    action: 'HUMAN_REPLY_NOW',

    // `REPLIED`, et surtout PAS `INTERESTED`.
    //
    // « Surtout via le bouche à oreille » établit un fait sur l'acquisition de
    // cette entreprise ; cela n'établit RIEN sur son intérêt pour nous.
    // Inscrire `INTERESTED` affirmerait une chose que personne n'a observée —
    // exactement ce que l'interdit n°2 de CLAUDE.md refuse. `REPLIED` dit la
    // seule chose vraie : ils ont écrit, l'intention commerciale reste ouverte.
    // `intentTransitionTarget` empêche déjà cet état de faire REDESCENDRE un
    // prospect déjà conclu.
    nextState: 'REPLIED',
    suppression: 'none',
    freezesNoReplySequence: true,
    draftEligible: true,

    // Pas d'alerte : quelqu'un qui répond à une question de qualification n'est
    // pas un speed-to-lead. Réveiller un humain à chaque tour d'une
    // conversation qui se déroule normalement viderait l'alerte de son sens.
    urgentAlert: false,
    crmEligible: true,
    protective: false,
    evidencesHumanReply: true,
  },
  OBJECTION: {
    // Une objection est une conversation, pas un refus : quelqu'un qui prend le
    // temps d'expliquer pourquoi c'est trop cher est plus proche d'un client
    // qu'un silence.
    action: 'HUMAN_REPLY_NOW',
    nextState: 'INTERESTED',
    suppression: 'none',
    freezesNoReplySequence: true,
    draftEligible: true,
    urgentAlert: true,
    crmEligible: true,
    protective: false,
    evidencesHumanReply: true,
  },
  NOT_NOW: {
    // §3 — candidat nurture. R6B-D2 ne PLANIFIE rien : aucune date, aucune
    // file, aucun rappel. Marquer l'état est tout ce qui est autorisé ici.
    // Pas « protecteur » au sens strict : un brouillon de réponse a du sens ici
    // (§10), donc la conséquence n'est pas purement une réduction de contact.
    action: 'NURTURE_LATER',
    nextState: 'NOT_NOW',
    suppression: 'none',
    freezesNoReplySequence: true,
    draftEligible: true,
    urgentAlert: false,
    crmEligible: true,
    protective: false,
    evidencesHumanReply: true,
  },
  NOT_INTERESTED: {
    action: 'STOP_COLD_FOLLOW_UP',
    nextState: 'NOT_INTERESTED',
    suppression: 'none',
    freezesNoReplySequence: true,
    draftEligible: false,
    urgentAlert: false,
    crmEligible: true,
    protective: true,
    evidencesHumanReply: true,
  },
  UNSUBSCRIBE: {
    action: 'SUPPRESS_PERMANENTLY',
    nextState: 'SUPPRESSED',
    suppression: 'permanent',
    freezesNoReplySequence: true,
    draftEligible: false,
    urgentAlert: false,
    crmEligible: true,
    protective: true,
    evidencesHumanReply: true,
  },
  AUTO_REPLY: {
    action: 'NO_ACTION',
    nextState: null,
    suppression: 'none',
    freezesNoReplySequence: false,
    draftEligible: false,
    urgentAlert: false,
    crmEligible: false,
    protective: true,
    evidencesHumanReply: false,
  },
  BOUNCE: {
    action: 'MARK_CHANNEL_UNUSABLE',
    nextState: 'BOUNCED',
    suppression: 'address_undeliverable',
    // Un serveur n'est pas un humain : une non-remise ne prouve rien sur
    // l'intérêt du prospect, seulement sur son adresse.
    freezesNoReplySequence: false,
    draftEligible: false,
    urgentAlert: false,
    crmEligible: true,
    protective: true,
    evidencesHumanReply: false,
  },
  OTHER: {
    action: 'HUMAN_REVIEW',
    nextState: 'REVIEW_REQUIRED',
    suppression: 'none',
    freezesNoReplySequence: true,
    draftEligible: false,
    urgentAlert: false,
    crmEligible: false,
    protective: false,
    evidencesHumanReply: true,
  },
  REVIEW_REQUIRED: {
    action: 'HUMAN_REVIEW',
    // HERMES-TARGETING-R1 §5 — `REPLIED`, et non `REVIEW_REQUIRED`.
    //
    // Le classifieur rend `REVIEW_REQUIRED` quand le message est « trop
    // court/ambigu pour conclure » — c'est-à-dire quand il n'arrive pas à
    // trancher l'INTENTION. Or c'est mot pour mot la règle affichée de la
    // colonne `REPLIED` : « une réponse corrélée, intention non tranchée ».
    // L'état `REVIEW_REQUIRED` reste atteignable par `OTHER`, qui est autre
    // chose : un message qui ne nous est pas destiné, écrit par un tiers ou
    // hors sujet, et sur lequel un humain doit réellement arbitrer.
    //
    // `action` reste `HUMAN_REVIEW` : l'état dit qu'ils ont répondu, l'action
    // dit qu'un humain devrait lire. Deux questions, deux réponses.
    nextState: 'REPLIED',
    suppression: 'none',
    // Une réponse qu'on n'arrive pas à classer reste une réponse : quelqu'un a
    // écrit. Continuer à relancer serait la pire des lectures d'un doute.
    freezesNoReplySequence: true,
    draftEligible: false,
    urgentAlert: false,
    crmEligible: false,
    protective: false,
    evidencesHumanReply: true,
  },
});

// ---------------------------------------------------------------------------
// L'accusé de réponse — HERMES-TARGETING-R1, partie A
// ---------------------------------------------------------------------------

/**
 * Les états depuis lesquels « ils ont répondu » est une information NOUVELLE.
 *
 * ---------------------------------------------------------------------------
 * Le défaut que cette liste corrige
 * ---------------------------------------------------------------------------
 * `REPLIED` existait dans `OUTREACH_STATES` depuis R6B-D2, la colonne « Ont
 * répondu » existait dans `CRM_LANES`, et aucune ligne de code ne pouvait
 * produire l'un ni peupler l'autre : chaque catégorie visait directement une
 * INTENTION (`INTERESTED`, `NOT_NOW`, …), si bien qu'un prospect passait de
 * « contacté » à « intéressé » sans que le journal ne dise jamais qu'il avait
 * écrit. Quand l'intention n'était pas tranchable, il tombait en
 * `REVIEW_REQUIRED`, et la colonne restait à zéro pendant que la boîte de
 * réception se remplissait.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi une LISTE et pas une comparaison d'ordre
 * ---------------------------------------------------------------------------
 * Un rang numérique inviterait à écrire « on ne redescend jamais », et il
 * faudrait alors décider si `NOT_NOW` est au-dessus ou en dessous de
 * `INTERESTED` — question qui n'a pas de réponse, parce que ces états ne sont
 * pas sur un axe. La seule chose dont on ait besoin est plus étroite : depuis
 * quels états l'accusé de réponse apprend-il quelque chose ? Depuis
 * `CONTACTED`, et depuis lui seul.
 *
 * Tout le reste — `REPLIED` (déjà dit), `INTERESTED`, `NOT_NOW`,
 * `NOT_INTERESTED`, `REVIEW_REQUIRED` (déjà au-delà), `BOUNCED`, `SUPPRESSED`
 * (protégés) — refuse l'accusé. Un second message d'un prospect déjà intéressé
 * ne doit PAS le ramener en « ont répondu » : ce serait une régression d'état
 * produite par une bonne nouvelle.
 */
export const REPLY_ACKNOWLEDGEABLE_FROM: readonly OutreachState[] = Object.freeze(['CONTACTED']);

/** L'état que pose l'accusé de réponse. Nommé une fois, lu partout. */
export const REPLY_ACKNOWLEDGED_STATE: OutreachState = 'REPLIED';

/**
 * Faut-il inscrire « ils ont répondu » avant d'inscrire ce que la réponse dit ?
 *
 * Les deux conditions sont nécessaires, et aucune n'est une opinion : la
 * catégorie doit établir qu'un humain a écrit (`evidencesHumanReply`), et
 * l'état courant doit être un état d'avant-réponse. Une corrélation faible ne
 * se teste pas ici parce qu'elle ne peut pas arriver : seules `EXACT` et
 * `HIGH_CONFIDENCE` entrent dans le traitement (`isProcessableCorrelation`),
 * et la requête de sélection ne charge pas les autres.
 */
export function shouldAcknowledgeReply(
  category: ReplyCategory,
  currentState: OutreachState | null,
): boolean {
  if (!CATEGORY_POLICY[category].evidencesHumanReply) return false;
  if (currentState === null) return false;
  return REPLY_ACKNOWLEDGEABLE_FROM.includes(currentState);
}

/**
 * L'état que l'INTENTION doit écrire, une fois l'accusé de réponse posé.
 *
 * ---------------------------------------------------------------------------
 * La seule règle que cette fonction ajoute, et le cas qui l'exige
 * ---------------------------------------------------------------------------
 * `REPLIED` n'est pas une conclusion, c'est une ATTENTE : « quelqu'un a écrit,
 * on ne sait pas encore quoi en faire ». Une attente ne peut donc jamais
 * remplacer une conclusion déjà prise.
 *
 * Sans cette garde, le cas suivant régresse — et il est banal : un prospect
 * répond « oui ça m'intéresse » (état `INTERESTED`), puis écrit deux heures
 * plus tard « j'ai beaucoup de travail en ce moment », que le classifieur ne
 * sait pas trancher. Cette seconde phrase vaut `REVIEW_REQUIRED`, dont l'état
 * de repos est `REPLIED` — et le prospect redescendrait donc d'« intéressé » à
 * « a répondu », par l'effet d'un message qui n'annule rien.
 *
 * Les autres états ne sont pas concernés : `INTERESTED`, `NOT_NOW`,
 * `NOT_INTERESTED`, `SUPPRESSED` et `BOUNCED` sont des conclusions, et une
 * conclusion nouvelle a le droit d'en remplacer une ancienne — quelqu'un qui
 * dit non après avoir dit oui a changé d'avis, et l'état doit le suivre.
 */
export function intentTransitionTarget(
  category: ReplyCategory,
  stateBeforeReply: OutreachState | null,
): OutreachState | null {
  const next = CATEGORY_POLICY[category].nextState;
  if (next !== REPLY_ACKNOWLEDGED_STATE) return next;
  if (stateBeforeReply === null) return next;
  return REPLY_ACKNOWLEDGEABLE_FROM.includes(stateBeforeReply) ? next : null;
}

/**
 * Sous ce seuil, une étiquette de modèle n'est pas une conclusion.
 *
 * 0.60 plutôt qu'une valeur plus haute : au-dessus, on renverrait en revue
 * humaine des réponses correctement classées, ce qui vide la file de son sens ;
 * en dessous, on laisserait une machine agir sur un « je crois ». Le
 * rabattement va toujours vers `REVIEW_REQUIRED`, jamais vers une autre
 * catégorie — dégrader vers un doute est sûr, dégrader vers une conclusion
 * différente ne l'est pas.
 */
export const MIN_ACTIONABLE_CONFIDENCE = 0.6;

// ---------------------------------------------------------------------------
// Le chemin déterministe : ce qui se lit dans les en-têtes
// ---------------------------------------------------------------------------

/**
 * Signaux d'automatisation OBSERVÉS par R6B-D1 (`detectAutomationSignals`) qui
 * établissent une non-remise.
 *
 * Chacun correspond à un en-tête réellement présent, pas à une tournure du
 * corps : `multipart/report; report-type=delivery-status` EST un rapport de
 * remise au sens de la RFC 3464, un `X-Failed-Recipients` n'est émis que par un
 * MTA, et `mailer-daemon`/`postmaster` sont des boîtes système.
 */
const BOUNCE_SIGNALS: readonly string[] = [
  'delivery_status_report',
  'failed_recipients_header',
  'system_sender:mailer-daemon',
  'system_sender:postmaster',
];

/** Signaux qui établissent une réponse automatique. */
const AUTO_REPLY_SIGNAL_PREFIXES: readonly string[] = ['auto_submitted:'];
const AUTO_REPLY_SIGNALS: readonly string[] = ['auto_reply_header', 'precedence:auto_reply'];

export interface DeterministicVerdict {
  readonly category: ReplyCategory;
  readonly reason: string;
  readonly evidence: readonly string[];
}

/**
 * Tranche ce qui n'a pas besoin d'un modèle.
 *
 * Rend `null` quand rien d'observé ne suffit — et c'est le cas normal d'une
 * vraie réponse humaine. Ne devine JAMAIS à partir du corps : « je suis absent
 * du 3 au 17 » écrit à la main par un dirigeant est une vraie réponse, pas une
 * auto-réponse, et seul l'en-tête fait la différence.
 */
export function classifyDeterministically(
  automationSignals: readonly string[],
): DeterministicVerdict | null {
  const signals = new Set(automationSignals);

  const bounceHits = BOUNCE_SIGNALS.filter((signal) => signals.has(signal));
  // `multipart/report` seul est ambigu (il sert aussi aux accusés de lecture) ;
  // accompagné d'une enveloppe de retour nulle, il ne l'est plus.
  if (signals.has('multipart_report') && signals.has('null_return_path')) {
    bounceHits.push('multipart_report+null_return_path');
  }
  if (bounceHits.length > 0) {
    return Object.freeze({
      category: 'BOUNCE' as const,
      reason: `rapport de non-remise établi par en-tête (${bounceHits.join(', ')})`,
      evidence: Object.freeze(bounceHits),
    });
  }

  const autoHits = [
    ...AUTO_REPLY_SIGNALS.filter((signal) => signals.has(signal)),
    ...[...signals].filter((signal) => AUTO_REPLY_SIGNAL_PREFIXES.some((prefix) => signal.startsWith(prefix))),
  ];
  if (autoHits.length > 0) {
    return Object.freeze({
      category: 'AUTO_REPLY' as const,
      reason: `réponse automatique déclarée par en-tête (${autoHits.join(', ')})`,
      evidence: Object.freeze(autoHits),
    });
  }

  return null;
}

/**
 * Demande d'arrêt formulée sans ambiguïté.
 *
 * Utilisé UNIQUEMENT comme filet de sécurité au-dessus du modèle, jamais comme
 * classifieur principal, et jamais pour retirer une suppression. La direction
 * compte : ces motifs ne peuvent que faire monter vers `UNSUBSCRIBE`. Un
 * détecteur qui pourrait aussi faire redescendre transformerait une expression
 * régulière en autorisation de recontacter quelqu'un.
 *
 * Les motifs exigent tous un verbe d'arrêt ET une référence au contact, pour ne
 * pas déclencher sur « arrêtez, c'est trop beau » ou sur un « stop » isolé dans
 * une phrase.
 */
/**
 * Ce qui ANNULE la lecture impérative d'un « me recontacte pas ».
 *
 * Un sujet à la troisième personne devant la formule en fait un CONSTAT et non
 * une demande : « personne ne me recontacte plus », « il me relance pas »,
 * « ça ne me contacte pas trop » décrivent la situation du prospect — c'est
 * exactement l'information qu'une prospection cherche à obtenir, et la prendre
 * pour une demande d'arrêt supprimerait le prospect qui vient de nous répondre.
 *
 * Une antéposition (`lookbehind`) plutôt qu'une ancre de début : « ok, me
 * recontacte pas » et « laisse tomber\nme recontacte pas » doivent continuer
 * d'être lus, et une liste de préfixes autorisés en aurait toujours oublié un.
 */
const NOT_THIRD_PERSON =
  // Le début de mot est décrit EN TOUTES LETTRES plutôt que par `\b` : en
  // JavaScript, `\b` est ASCII, si bien qu'il n'existe aucune frontière devant
  // « ça » — et « ça ne me contacte pas trop » passait donc à travers la garde
  // censée l'écarter. Mesuré, pas supposé.
  "(?<!(?:^|[\\s,;:.!?'\"()\\-])(?:il|elle|on|ils|elles|personne|qui|nul|ça|ca|y)\\s(?:ne\\s)?)";

const UNSUBSCRIBE_PATTERNS: readonly [RegExp, string][] = [
  [/\bne\s+(?:me|nous)\s+(?:re)?contactez\s+plus\b/i, 'demande de ne plus être contacté'],
  [/\barr[êe]tez\s+de\s+(?:me|nous)\s+(?:contacter|[ée]crire|solliciter|d[ée]marcher|spammer)\b/i, 'demande d’arrêt des sollicitations'],

  // -------------------------------------------------------------------------
  // HERMES-MULTI-TURN-BURSTS-R1 — le TUTOIEMENT, qui manquait entièrement.
  // -------------------------------------------------------------------------
  //
  // Ce lexique ne connaissait QUE le vouvoiement. « me recontacte pas »,
  // « arrête de me contacter », « me relance plus » — les formes qu'un
  // prospect qui tutoie emploie réellement — passaient au travers, et une
  // demande d'arrêt non lue est la pire panne possible de ce dépôt :
  // l'interdit n°1 tient sur elle.
  //
  // Ce n'était pas dangereux tant que Hermes vouvoyait tout le monde et qu'un
  // humain relisait. Ça l'est devenu deux fois depuis :
  // HERMES-CONTACT-PURPOSE-ADDRESS-MODE-R1 fait tutoyer Hermes dès que le
  // prospect tutoie — donc les conversations tutoyées ne sont plus des cas
  // limites, ce sont les nôtres —, et le rail autonome lit ces conclusions
  // sans relecture humaine.
  //
  // C'est exactement le trou que `detectPerformanceClaims` portait, relevé et
  // fermé au même endroit : « le dépôt connaissait ce vocabulaire du côté du
  // VOUVOIEMENT et pas du côté du TUTOIEMENT ».
  //
  // Les formes restent NON AMBIGUËS, comme les précédentes : « laisse tomber »
  // seul n'est pas ici, et n'y sera pas — il peut viser une question autant
  // qu'une relation, et le confondre couperait des conversations vivantes.
  [
    new RegExp(`${NOT_THIRD_PERSON}(?:ne\\s+)?(?:me|nous)\\s+(?:re)?contacte\\s+(?:plus|pas)\\b`, 'i'),
    'demande de ne plus être contacté (tutoiement)',
  ],
  [
    new RegExp(`${NOT_THIRD_PERSON}(?:ne\\s+)?(?:me|nous)\\s+(?:re)?lance\\s+(?:plus|pas)\\b`, 'i'),
    'demande d’arrêt des relances (tutoiement)',
  ],
  [
    new RegExp(`${NOT_THIRD_PERSON}(?:ne\\s+)?(?:m'|me\\s+|nous\\s+)[ée]cris\\s+(?:plus|pas)\\b`, 'i'),
    'demande d’arrêt des envois (tutoiement)',
  ],
  [/\barr[êe]te\s+de\s+(?:me|nous)\s+(?:contacter|[ée]crire|solliciter|d[ée]marcher|spammer|relancer)\b/i, 'demande d’arrêt des sollicitations (tutoiement)'],
  [/\bretire[- ]?(?:moi|nous)\s+de\s+(?:ta|tes)\s+(?:liste|fichier|base|mailing)/i, 'demande de retrait de la liste (tutoiement)'],
  [/\bsupprime\s+(?:mon|notre)\s+(?:adresse|email|e-mail|contact|num[ée]ro)\b/i, 'demande de suppression du contact (tutoiement)'],
  [/\b(?:me\s+)?d[ée]sinscri(?:re|vez|s)\b/i, 'demande de désinscription'],
  [/\bd[ée]sabonn(?:ez|er|e)[- ]?(?:moi|nous)\b/i, 'demande de désabonnement'],
  [/\bretirez[- ]?(?:moi|nous)\s+de\s+(?:votre|vos)\s+(?:liste|fichier|base|mailing)/i, 'demande de retrait de la liste'],
  [/\bsupprimez\s+(?:mon|notre)\s+(?:adresse|email|e-mail|contact)\b/i, 'demande de suppression du contact'],
  [/\bplus\s+(?:jamais\s+)?de\s+(?:mails?|e-mails?|messages?)\s+(?:de\s+votre\s+part|s'?il\s+vous\s+pla[îi]t)/i, 'demande d’arrêt des envois'],
  [/\b(?:unsubscribe|stop\s+(?:contacting|emailing)\s+me|remove\s+me\s+from\s+your\s+list)\b/i, 'demande d’arrêt (anglais)'],
  [/\brgpd\b.{0,40}\b(?:effac|supprim|oppos)/i, 'invocation RGPD avec demande d’effacement/opposition'],
];

export interface UnsubscribeDemand {
  readonly reason: string;
  readonly excerpt: string;
}

/** Rend la première demande d'arrêt non ambiguë trouvée, ou `null`. */
export function detectUnsubscribeDemand(body: string): UnsubscribeDemand | null {
  // HERMES-MULTI-TURN-BURSTS-R1 — la typographie ne doit pas décider d'une
  // suppression. Un clavier de téléphone écrit « m’écris » avec l'apostrophe
  // U+2019 ; le lexique porte l'apostrophe droite. Sans cette normalisation,
  // « ne m’écris plus » tapé sur un vrai téléphone n'était pas lu, et il
  // n'existe pas de panne plus grave dans ce dépôt. C'est la même
  // normalisation que partout ailleurs, jamais une seconde.
  const normalized = normalizeForMatching(body);
  for (const [pattern, reason] of UNSUBSCRIBE_PATTERNS) {
    const match = normalized.match(pattern);
    if (match) return Object.freeze({ reason, excerpt: match[0] });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Politique de corrélation (§14 de la mission)
// ---------------------------------------------------------------------------

/** Les seules corrélations que R6B-D2 accepte de traiter. */
export type ProcessableCorrelation = Extract<CorrelationStatus, 'EXACT' | 'HIGH_CONFIDENCE'>;

export function isProcessableCorrelation(status: CorrelationStatus): status is ProcessableCorrelation {
  return status === 'EXACT' || status === 'HIGH_CONFIDENCE';
}

/**
 * Une écriture chez un tiers exige une identité d'envoi PROUVÉE.
 *
 * `HIGH_CONFIDENCE` ne l'est pas : c'est l'absence d'alternative, pas une
 * égalité d'identifiant (R6B-D1, `sole_outbound_recipient`). Le jour où un
 * second envoi partira vers la même adresse, la même réponse deviendrait
 * `REVIEW_REQUIRED` sans qu'aucune ligne de code ne change — ce qui dit assez
 * que la conclusion n'était pas une preuve.
 */
export function allowsExternalWrite(status: ProcessableCorrelation): boolean {
  return status === 'EXACT';
}

// ---------------------------------------------------------------------------
// Décision finale
// ---------------------------------------------------------------------------

export interface CategoryDecisionInput {
  readonly category: ReplyCategory;
  readonly confidence: number;
  readonly correlationStatus: ProcessableCorrelation;
  /** Vrai quand la catégorie vient des en-têtes, pas d'un modèle. */
  readonly deterministic: boolean;
  /** Demande d'arrêt lue dans le corps, si elle existe. */
  readonly unsubscribeDemand: UnsubscribeDemand | null;
}

export interface CategoryDecision {
  readonly category: ReplyCategory;
  readonly confidence: number;
  readonly policy: CategoryPolicy;
  readonly requiresHumanReview: boolean;
  /** Ce que la décision a changé par rapport à la proposition brute. */
  readonly overrides: readonly string[];
}

/**
 * Applique la politique à une étiquette proposée.
 *
 * Trois rabattements possibles, tous dans le sens de la prudence :
 *
 *   1. une demande d'arrêt lue mot pour mot dans le corps fait monter vers
 *      `UNSUBSCRIBE`, quelle que soit l'étiquette proposée — ne pas contacter
 *      quelqu'un qui l'a demandé prime sur toute lecture commerciale ;
 *   2. une confiance sous le seuil rabat vers `REVIEW_REQUIRED` ;
 *   3. une corrélation `HIGH_CONFIDENCE` marque la conclusion comme à
 *      confirmer, sans changer l'étiquette : on sait ce que le message dit, on
 *      n'est pas certain de qui l'a écrit.
 */
export function decideCategory(input: CategoryDecisionInput): CategoryDecision {
  const overrides: string[] = [];
  let category = input.category;
  let confidence = Math.max(0, Math.min(1, input.confidence));

  if (input.unsubscribeDemand !== null && category !== 'UNSUBSCRIBE' && category !== 'BOUNCE') {
    overrides.push(
      `demande d'arrêt lue dans le corps (« ${input.unsubscribeDemand.excerpt} ») — ` +
        `${category} relevé en UNSUBSCRIBE`,
    );
    category = 'UNSUBSCRIBE';
    confidence = Math.max(confidence, 0.95);
  }

  if (!input.deterministic && category !== 'UNSUBSCRIBE' && confidence < MIN_ACTIONABLE_CONFIDENCE) {
    overrides.push(
      `confiance ${confidence.toFixed(2)} sous le seuil ${MIN_ACTIONABLE_CONFIDENCE} — ` +
        `${category} rabattu en REVIEW_REQUIRED`,
    );
    category = 'REVIEW_REQUIRED';
  }

  const policy = CATEGORY_POLICY[category];

  // `requiresHumanReview` porte sur la CONCLUSION, pas sur l'envoi : une
  // réponse commerciale attend de toute façon une approbation humaine (le
  // brouillon naît `PROPOSED`). Ce drapeau dit « cette étiquette n'est pas sûre
  // d'elle-même », ce qui est autre chose.
  let requiresHumanReview = category === 'REVIEW_REQUIRED' || category === 'OTHER';

  // L'asymétrie, appliquée : une corrélation faible met en revue les
  // conclusions COMMERCIALES, jamais les conclusions protectrices. Faire
  // attendre une suppression le temps qu'un humain confirme reviendrait à
  // continuer d'écrire à quelqu'un qui a demandé qu'on arrête, au motif qu'on
  // n'est pas tout à fait sûr que c'est bien lui.
  if (input.correlationStatus === 'HIGH_CONFIDENCE' && !policy.protective) {
    overrides.push(
      'corrélation HIGH_CONFIDENCE — conclusion commerciale à confirmer par un humain, aucune écriture externe',
    );
    requiresHumanReview = true;
  }

  return Object.freeze({
    category,
    confidence,
    policy,
    requiresHumanReview,
    overrides: Object.freeze(overrides),
  });
}

/**
 * L'action réellement recommandée, une fois la revue humaine prise en compte.
 *
 * Une conclusion à confirmer ne peut pas recommander une action que la machine
 * prendrait seule — sauf `HUMAN_REPLY_NOW`, qui EST une demande d'intervention
 * humaine. La base impose la même règle
 * (`r6b_reply_analysis_review_action`) : le code et le schéma disent la même
 * chose, et c'est le schéma qui a le dernier mot.
 */
export function resolveNextAction(decision: CategoryDecision): NextAction {
  const proposed = decision.policy.action;
  // Une conséquence protectrice ne se met pas en attente : `SUPPRESS_PERMANENTLY`
  // et `MARK_CHANNEL_UNUSABLE` restent ce qu'ils sont, et la base l'exige
  // (`r6b_reply_analysis_unsubscribe_action`, `..._bounce_action`).
  if (decision.policy.protective) return proposed;
  if (!decision.requiresHumanReview) return proposed;
  return proposed === 'HUMAN_REPLY_NOW' ? 'HUMAN_REPLY_NOW' : 'HUMAN_REVIEW';
}
