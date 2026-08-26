/**
 * HERMES-SALES-KNOWLEDGE-R1 §3 à §5, §22 à §26 — l'OBJECTIF COMMERCIAL de
 * Hermes, nommé, et la qualification qui y mène.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce module ajoute, et ce qu'il n'ajoute surtout pas
 * ---------------------------------------------------------------------------
 * Le dépôt savait déjà répondre à « ce tour peut-il partir seul ? »
 * (`autonomy.ts`) et à « où en est la conversation sur l'échelle
 * commerciale ? » (`offerProgression.ts`). Il ne savait pas répondre à la
 * question que un opérateur pose réellement : **cette conversation vaut-elle un
 * appel ?**
 *
 * C'est une troisième question, et elle a une réponse différente des deux
 * autres. Un tour peut être parfaitement envoyable et ne mener nulle part ; une
 * conversation peut mériter un appel alors que le brouillon du jour est mauvais.
 * Les confondre aurait produit le pire arrangement possible — une sortie qui
 * sert à la fois d'autorisation d'effet et de jugement commercial, si bien
 * qu'assouplir l'un assouplirait l'autre sans que personne ne s'en aperçoive.
 *
 * Ce module ne peut donc PAS autoriser un envoi. Il est pur, il n'a aucun
 * import d'effet, et `decideAutonomousReply` reste seul juge de ce qui part.
 * Ce qu'il fait bouger est nommément une chose, et une seule : la porte
 * `call_too_early` accepte désormais aussi `QUALIFIED_FOR_CALL`, en plus des
 * deux conditions qu'elle acceptait déjà.
 *
 * ---------------------------------------------------------------------------
 * §5 — être prêt pour un APPEL n'est pas être prêt à SIGNER
 * ---------------------------------------------------------------------------
 * C'est le déplacement de fond de ce round. La barre historique
 * (`resolveCallReadiness`) a été réglée pour éviter une faute réelle et
 * coûteuse : proposer un appel à quelqu'un qui a simplement été poli. Elle
 * reste juste, et elle n'est pas abaissée.
 *
 * Mais elle répondait implicitement à « en sait-on assez pour vendre ? », et ce
 * n'est pas la bonne question. Le rendez-vous que Hermes obtient est un
 * rendez-vous de QUALIFICATION — la source de ce round le confirme d'ailleurs
 * pour son propre compte (sales-source-001-p032, 41:01-41:52 : le premier appel
 * qualifie, la démonstration et la conclusion viennent après). Hermes n'a donc
 * besoin de savoir ni le budget publicitaire, ni toutes les objections, ni le
 * prix final — il a besoin de savoir qu'un humain aurait une vraie raison de
 * décrocher.
 *
 * L'élargissement est délibérément étroit, et il tient en une ligne : une
 * personne qui demande comment cela fonctionne, qui montre un intérêt modéré,
 * et avec qui un échange a déjà eu lieu, devient `QUALIFIED_FOR_CALL` — là où
 * l'ancienne barre exigeait deux échanges. Tout le reste est inchangé.
 *
 * ---------------------------------------------------------------------------
 * §22 — une qualification n'est pas un questionnaire
 * ---------------------------------------------------------------------------
 * Aucune porte de ce module ne compte des informations recueillies. Il n'existe
 * pas de liste de champs à remplir avant de mériter un appel, et c'est un choix
 * : une machine à qui l'on donne une liste la remplit, une question à la fois,
 * et produit exactement l'interrogatoire que §22 interdit. Ce qui est lu ici est
 * ce que la personne a MONTRÉ — un signal d'achat, une demande, une objection
 * qui nomme sa situation — pas ce qu'elle a déclaré case par case.
 */

import {
  BOOKING_MECHANISM_DEFAULT,
  assessBookingLifecycle,
  canBookAutonomously,
  type BookingIntentFacts,
  type BookingLifecycleAssessment,
  type BookingMechanism,
} from '@/lib/sales/booking';
import type { ConversationSignals } from '@/lib/conversation/signals';
import type { ConversationState } from '@/lib/conversation/state';
import type { OfferReadiness } from '@/lib/learning/offer';
import type { OutreachState, ReplyCategory } from '@/lib/replies/taxonomy';

/**
 * L'objectif commercial canonique de Hermes.
 *
 * Un littéral, pas une chaîne libre : c'est LA phrase que ce round ajoute au
 * dépôt, et elle doit désigner la même chose partout. Hermes prospecte,
 * qualifie, crée de l'intérêt, obtient le rendez-vous. un opérateur prend l'appel et
 * conclut.
 */
export const HERMES_PRIMARY_COMMERCIAL_OBJECTIVE = 'QUALIFIED_APPOINTMENT_BOOKED' as const;

/**
 * L'identifiant de la politique de RENDEZ-VOUS.
 *
 * Une quatrième version, distincte des trois qui existaient. Les quatre
 * répondent à quatre questions — « à qui écrire ? », « peut-on répondre
 * seul ? », « que peut-on engager ? », « cela vaut-il un appel ? » — et
 * partager une étiquette ferait couvrir l'une par les décisions de l'autre.
 */
export const APPOINTMENT_POLICY_VERSION = 'hermes-appointment-r3';

/**
 * Ce que Hermes ne fait JAMAIS, quelle que soit la qualification.
 *
 * Rendu dans le prompt et dans les rapports : « obtenir un rendez-vous » se
 * comprend de travers si l'on ne dit pas ce que cela exclut.
 */
export const HERMES_OUT_OF_SCOPE: readonly string[] = Object.freeze([
  'conclure une vente dans un message',
  'négocier un contrat ou ses conditions',
  'obtenir un paiement ou faire signer quoi que ce soit',
  'dérouler un entretien de vente complet par messages',
  'fixer une date ferme, choisir un créneau, ou écrire dans un agenda',
]);

/**
 * HERMES-NATIVE-BOOKING-R1 — le même hors-champ, MOINS la dernière ligne.
 *
 * Cette liste remplace la précédente quand — et seulement quand — l'agenda
 * natif porte des créneaux réels pour ce tour. La raison est celle que ce dépôt
 * répète : laisser « ne fixe aucune date » dans le prompt d'un rail qui vient
 * précisément d'en fixer une serait le pire des deux mondes — une consigne
 * écrite qui nie ce que le code fait, sans que personne sache laquelle des deux
 * fait foi.
 *
 * Les quatre autres interdits ne bougent pas d'un pouce, et le cinquième n'est
 * pas remplacé par une permission : ce que Hermes fait n'est pas « écrire dans
 * un agenda » à sa guise, c'est proposer les créneaux que le moteur a calculés
 * et confirmer celui que la personne choisit. `closingAllowed` reste `false` en
 * littéral de type, et `HUMAN_CLOSE_REQUIRED` reste la sortie de toute
 * conversation qualifiée qui n'aboutit pas à un créneau.
 */
export const HERMES_OUT_OF_SCOPE_WITH_NATIVE_BOOKING: readonly string[] = Object.freeze([
  'conclure une vente dans un message',
  'négocier un contrat ou ses conditions',
  'obtenir un paiement ou faire signer quoi que ce soit',
  'dérouler un entretien de vente complet par messages',
  'inventer un créneau, une date ou une disponibilité que le système ne t’a pas donnée',
]);

/** Le verdict de qualification pour un rendez-vous. */
export type AppointmentQualification =
  /** Rien ne justifie un appel — trop tôt, ou la conversation est refermée. */
  | 'NOT_READY'
  /** Un intérêt réel existe, pas encore de quoi proposer un échange. */
  | 'POTENTIALLY_QUALIFIED'
  /** Un échange humain est la prochaine action naturelle. */
  | 'QUALIFIED_FOR_CALL'
  /** La machine n'a pas de lecture sûre : un humain regarde. */
  | 'HUMAN_REVIEW';

/** L'état du passage de relais. */
export type HandoffState =
  /** Rien à passer. */
  | 'NONE'
  /**
   * §25 — la conversation a atteint son objectif côté machine.
   *
   * Ce n'est pas un échec ni une escalade de sécurité : c'est la RÉUSSITE de
   * Hermes. Il a fait son travail, et la suite appartient à un humain.
   */
  | 'HUMAN_CLOSE_REQUIRED';

/**
 * La conformité au ciblage, telle qu'elle est OBSERVABLE depuis une
 * conversation.
 *
 * §35 met le ciblage hors périmètre, et ce type s'y tient scrupuleusement : il
 * ne recalcule aucun ICP, ne relit aucune prestation, ne rejuge personne. Il
 * constate ce qui est déjà écrit.
 *
 * `PASSED_AT_FIRST_TOUCH` mérite d'être lu pour ce qu'il dit exactement : un
 * premier message est réellement parti, donc les portes de ciblage en vigueur
 * CE JOUR-LÀ étaient vertes. Ce n'est pas une promesse que le prospect passerait
 * les portes d'aujourd'hui — la cible s'est resserrée le 22 août 2026
 * (`hermes-targeting-cleaning-only-r1`) et certains contacts d'avant ne
 * repasseraient pas. Rejuger ici serait rouvrir le ciblage, ce que cette
 * mission ne fait pas ; le fait est donc porté avec sa date implicite, et
 * n'autorise rien à lui seul.
 */
export type IcpConformity =
  /** Un refus de ciblage TERMINAL est enregistré sur ce prospect. */
  | 'REJECTED_BY_TARGETING'
  /** Un premier contact est prouvé parti : les portes du jour étaient vertes. */
  | 'PASSED_AT_FIRST_TOUCH'
  /** Ni l'un ni l'autre. */
  | 'UNKNOWN';

export interface AppointmentFacts {
  readonly identityConfirmed: boolean;
  readonly suppressed: boolean;
  readonly outreachState: OutreachState | null;
  readonly terminalCategoryInThread: ReplyCategory | null;
  readonly category: ReplyCategory;
  readonly signals: ConversationSignals;
  readonly state: ConversationState;
  readonly offerReadiness: OfferReadiness;
  readonly icpConformity: IcpConformity;
  /**
   * HERMES-BOOKING-MECHANISM-R1 — ce que l'on sait de la RÉSERVATION.
   *
   * Optionnel, et son absence n'est pas une permission : le défaut ci-dessous
   * est `MISSING_BOOKING_MECHANISM`, aucune piste, conversation non fraîche —
   * c'est-à-dire l'état exact du dépôt avant ce round. Un appelant qui ne sait
   * rien de la réservation obtient donc le comportement d'avant, à la lettre.
   */
  readonly booking?: AppointmentBookingFacts;
}

/** Les faits de réservation, tous LUS ailleurs, aucun recalculé ici. */
export interface AppointmentBookingFacts {
  readonly mechanism: BookingMechanism;
  readonly intent: BookingIntentFacts | null;
  readonly declined: boolean;
  readonly conversationFresh: boolean;
}

/** Le défaut fail-closed, appliqué quand l'appelant ne dit rien. */
const NO_BOOKING_FACTS: AppointmentBookingFacts = Object.freeze({
  mechanism: BOOKING_MECHANISM_DEFAULT,
  intent: null,
  declined: false,
  conversationFresh: false,
});

export interface AppointmentAssessment {
  readonly policyVersion: string;
  readonly objective: typeof HERMES_PRIMARY_COMMERCIAL_OBJECTIVE;
  readonly qualification: AppointmentQualification;
  /** La porte qui a tranché, pour qu'un verdict se relise sans l'ordre. */
  readonly gate: string;
  /** Des codes, jamais des phrases libres : ils entrent dans des rapports. */
  readonly reasons: readonly string[];
  readonly handoff: HandoffState;
  readonly booking: BookingMechanism;
  /**
   * Où en est la RÉSERVATION — les sept états de `booking.ts`.
   *
   * Distinct de `qualification`, et pas par goût de la nuance : la première
   * répond à « cette conversation vaut-elle un appel ? », la seconde à « un
   * rendez-vous existe-t-il ? ». Les confondre ferait compter comme un
   * rendez-vous toute conversation qui en méritait un.
   */
  readonly bookingLifecycle: BookingLifecycleAssessment;
  /**
   * Ce tour peut-il proposer un échange sans être jugé prématuré ?
   *
   * C'est la SEULE sortie de ce module qui change une décision existante, et
   * elle ne fait que s'ajouter aux conditions déjà en place (`call_too_early`).
   * Elle ne peut donc jamais refuser un échange que l'ancienne barre acceptait.
   */
  readonly callTransitionAllowed: boolean;
  /**
   * Hermes peut-il conclure ? Non, et le TYPE le dit.
   *
   * Littéral `false` : aucune branche ne peut produire `true`, et un futur round
   * qui voudrait l'ouvrir devra changer la signature, donc passer par une revue.
   */
  readonly closingAllowed: false;
}

/** Les catégories qui referment une prospection. Lues, jamais recalculées. */
const CLOSED_CATEGORIES: ReadonlySet<ReplyCategory> = new Set<ReplyCategory>([
  'UNSUBSCRIBE',
  'NOT_INTERESTED',
  'BOUNCE',
  'AUTO_REPLY',
]);

/**
 * Les catégories qui portent un échange commercial vivant.
 *
 * `INFORMATION_SHARED` en fait partie depuis
 * HERMES-CONTEXTUAL-REPLY-CLASSIFICATION-R1, et l'omettre aurait introduit un
 * défaut plutôt que d'en éviter un : cette porte précède celles qui lisent une
 * demande explicite d'appel et un signal d'achat, si bien qu'un « oui appelez-
 * moi quand vous voulez » classé `INFORMATION_SHARED` n'aurait jamais atteint
 * `QUALIFIED_FOR_CALL`.
 *
 * Aucune barre n'est abaissée pour autant : la porte 5 dit seulement que la
 * conversation est encore ouverte. La qualification continue d'exiger, plus
 * bas, une demande explicite ou un signal d'achat — et `readSignals` ne tire
 * AUCUN signal d'achat de cette catégorie, contrairement à `QUESTION` et
 * `OBJECTION` qui valent `WEAK`. Répondre à une question qu'on nous a posée
 * n'est pas une intention d'acheter.
 */
const LIVE_CATEGORIES: ReadonlySet<ReplyCategory> = new Set<ReplyCategory>([
  'INTERESTED',
  'QUESTION',
  'INFORMATION_SHARED',
  'OBJECTION',
]);

/**
 * Juge si cette conversation vaut un appel.
 *
 * L'ordre des portes EST la politique, et il va du plus DURABLE au plus
 * circonstanciel — même discipline que `decideAutonomousReply`, et pour la même
 * raison : un refus définitif doit se relire comme définitif, pas porter le
 * motif « pas encore assez engagé ».
 *
 * Fail-closed : le défaut, en bas de fonction, est `NOT_READY`. Une
 * qualification ne s'obtient qu'en franchissant une porte nommée.
 */
export function assessAppointmentQualification(facts: AppointmentFacts): AppointmentAssessment {
  const reasons: string[] = [];

  const verdict = ((): { qualification: AppointmentQualification; gate: string } => {
    // ---- 1. L'exclusion enregistrée ---------------------------------------
    if (facts.suppressed) {
      reasons.push('suppressed');
      return { qualification: 'NOT_READY', gate: 'opt_out' };
    }
    if (facts.outreachState === 'SUPPRESSED' || facts.outreachState === 'NOT_INTERESTED') {
      reasons.push(`outreach_state:${facts.outreachState}`);
      return { qualification: 'NOT_READY', gate: 'outreach_state' };
    }

    // ---- 2. Le fil porte déjà une fin -------------------------------------
    if (facts.terminalCategoryInThread !== null) {
      reasons.push(`thread_terminal:${facts.terminalCategoryInThread}`);
      return { qualification: 'NOT_READY', gate: 'thread_terminal' };
    }
    if (CLOSED_CATEGORIES.has(facts.category)) {
      reasons.push(`category:${facts.category}`);
      return { qualification: 'NOT_READY', gate: 'category' };
    }

    // ---- 3. Le ciblage a refusé ce prospect --------------------------------
    //
    // Un refus TERMINAL de ciblage ferme la question : proposer un appel à
    // quelqu'un que la machine a écarté de la cible ferait perdre son temps à
    // un opérateur, ce qui est le seul coût que ce module doit vraiment éviter.
    if (facts.icpConformity === 'REJECTED_BY_TARGETING') {
      reasons.push('icp:rejected_by_targeting');
      return { qualification: 'NOT_READY', gate: 'icp' };
    }

    // ---- 4. Ce qui appartient à un humain ---------------------------------
    if (facts.signals.sensitiveFlags.length > 0) {
      reasons.push(`sensitive:${facts.signals.sensitiveFlags.join('+')}`);
      return { qualification: 'HUMAN_REVIEW', gate: 'sensitive' };
    }
    if (facts.state.humanNeeded || facts.state.goal === 'AWAIT_HUMAN') {
      reasons.push('human_needed');
      return { qualification: 'HUMAN_REVIEW', gate: 'conversation_state' };
    }
    // Un rendez-vous engage un opérateur auprès de quelqu'un. La barre d'identité
    // ne baisse pas parce que la conversation se passe bien.
    if (!facts.identityConfirmed) {
      reasons.push('identity_unconfirmed');
      return { qualification: 'HUMAN_REVIEW', gate: 'identity' };
    }

    // ---- 5. La conversation est-elle seulement vivante ? -------------------
    if (facts.state.goal === 'ACKNOWLEDGE_AND_CLOSE') {
      reasons.push('goal:acknowledge_and_close');
      return { qualification: 'NOT_READY', gate: 'conversation_goal' };
    }
    if (!LIVE_CATEGORIES.has(facts.category)) {
      reasons.push(`category_not_live:${facts.category}`);
      return { qualification: 'NOT_READY', gate: 'category' };
    }

    // ---- 6. La demande explicite, qui l'emporte sur tout le reste ----------
    //
    // Faire patienter quelqu'un qui demande à parler reste la seule erreur
    // vraiment coûteuse ici, et la source de ce round dit la même chose depuis
    // un autre angle (sales-source-001-p028, 38:14-38:32).
    if (facts.signals.explicitCallRequest) {
      reasons.push('explicit_call_request');
      return { qualification: 'QUALIFIED_FOR_CALL', gate: 'explicit_request' };
    }

    // ---- 7. Un signal d'achat franc ---------------------------------------
    if (facts.signals.buyingSignal === 'STRONG') {
      reasons.push('buying_signal:STRONG');
      return { qualification: 'QUALIFIED_FOR_CALL', gate: 'buying_signal' };
    }

    // ---- 8. §5 — l'élargissement, et il tient ici en entier ----------------
    //
    // Un intérêt modéré, une question qui porte réellement sur l'offre
    // (`offerReadiness` HIGH), et un échange qui a déjà eu lieu. L'ancienne
    // barre exigeait DEUX tours reçus ; celle-ci en demande un, parce que la
    // maturité vient ici du CONTENU de la question et non du nombre de
    // messages. « Comment ça marche concrètement ? » au deuxième message est un
    // meilleur signal que trois politesses.
    //
    // Ce qui n'a pas bougé : un simple « oui » ne suffit toujours pas — il ne
    // porte ni signal modéré, ni maturité HIGH.
    const exchangeStarted = facts.state.inboundTurnCount >= 1 || !facts.state.isFirstReply;
    if (
      facts.signals.buyingSignal === 'MODERATE' &&
      facts.offerReadiness === 'HIGH' &&
      exchangeStarted
    ) {
      reasons.push('moderate_interest_with_offer_question');
      return { qualification: 'QUALIFIED_FOR_CALL', gate: 'engagement' };
    }

    // ---- 9. Un intérêt réel, pas encore mûr -------------------------------
    if (facts.signals.buyingSignal === 'MODERATE') {
      reasons.push('buying_signal:MODERATE');
      return { qualification: 'POTENTIALLY_QUALIFIED', gate: 'engagement' };
    }
    if (facts.signals.buyingSignal === 'WEAK' && exchangeStarted) {
      reasons.push('buying_signal:WEAK_with_exchange');
      return { qualification: 'POTENTIALLY_QUALIFIED', gate: 'engagement' };
    }
    if (facts.signals.objectionTopic !== 'NONE') {
      // Une objection nomme une situation : c'est plus qu'une politesse, et
      // moins qu'un intérêt. Elle mérite d'être suivie, pas d'être appelée.
      reasons.push(`objection:${facts.signals.objectionTopic}`);
      return { qualification: 'POTENTIALLY_QUALIFIED', gate: 'engagement' };
    }

    reasons.push('no_engagement_signal');
    return { qualification: 'NOT_READY', gate: 'engagement' };
  })();

  // §25 — le passage de relais.
  //
  // Il ne dépend pas de l'existence d'un mécanisme de réservation : la
  // conversation a atteint son objectif dès que l'appel est justifié, et c'est
  // précisément parce qu'aucune réservation n'existe que la main revient à un
  // humain plutôt qu'à un agenda.
  const handoff: HandoffState =
    verdict.qualification === 'QUALIFIED_FOR_CALL' ? 'HUMAN_CLOSE_REQUIRED' : 'NONE';

  const bookingFacts = facts.booking ?? NO_BOOKING_FACTS;
  const bookingLifecycle = assessBookingLifecycle({
    qualification: verdict.qualification,
    mechanism: bookingFacts.mechanism,
    intent: bookingFacts.intent,
    declined: bookingFacts.declined,
    conversationFresh: bookingFacts.conversationFresh,
  });

  // Hermes n'écrit jamais dans un agenda, mécanisme ou pas — d'où l'appel
  // conservé ici : la raison reste vraie le jour où une destination existe, et
  // c'est le motif du passage de relais.
  if (handoff === 'HUMAN_CLOSE_REQUIRED' && !canBookAutonomously()) {
    reasons.push(`booking:${bookingFacts.mechanism}`);
  }

  return Object.freeze({
    policyVersion: APPOINTMENT_POLICY_VERSION,
    objective: HERMES_PRIMARY_COMMERCIAL_OBJECTIVE,
    qualification: verdict.qualification,
    gate: verdict.gate,
    reasons: Object.freeze(reasons),
    handoff,
    booking: bookingFacts.mechanism,
    bookingLifecycle,
    callTransitionAllowed: verdict.qualification === 'QUALIFIED_FOR_CALL',
    closingAllowed: false as const,
  });
}

/** La forme lisible des rapports : `QUALIFIED_FOR_CALL:explicit_request`. */
export function formatAppointmentQualification(assessment: AppointmentAssessment): string {
  return `${assessment.qualification}:${assessment.gate}`;
}

// ---------------------------------------------------------------------------
// §26 — l'entonnoir de mesure
// ---------------------------------------------------------------------------

/**
 * Les étapes commerciales, dans l'ordre, du premier message au client signé.
 *
 * Un VOCABULAIRE, pas un compteur : aucune de ces valeurs n'est écrite en base
 * par ce round, et aucun tableau de bord n'en dépend encore. Elles sont ici pour
 * que l'apprentissage futur mesure les bonnes choses — et surtout pour que les
 * deux dernières restent SÉPARÉES des autres.
 *
 * Pourquoi cette séparation est le point : Hermes doit optimiser vers
 * `appointment_booked`. Il ne peut pas optimiser vers `client_won`, parce qu'il
 * n'agit sur rien de ce qui se passe après le passage de relais — l'appel, la
 * démonstration, la négociation et la signature appartiennent à un opérateur. Un
 * système qui mêlerait les deux dans une seule métrique de causalité apprendrait
 * de la performance de quelqu'un d'autre, et corrigerait ses messages en
 * fonction d'appels qu'il n'a pas passés.
 *
 * `client_won` doit néanmoins pouvoir revenir plus tard dans la boucle, comme
 * une observation retardée et clairement étiquetée. D'où sa présence ici : ce
 * qui n'est pas nommé ne se mesure pas.
 */
export const COMMERCIAL_FUNNEL_STEPS = Object.freeze([
  'first_touch_sent',
  'reply',
  'engaged_reply',
  'qualified_conversation',
  'call_proposed',
  'appointment_booked',
  'appointment_completed',
  'client_won',
] as const);

export type CommercialFunnelStep = (typeof COMMERCIAL_FUNNEL_STEPS)[number];

/**
 * La dernière étape sur laquelle Hermes agit.
 *
 * Tout ce qui suit est le travail d'un humain, et une boucle d'apprentissage
 * qui l'attribuerait à un message apprendrait faux.
 */
export const HERMES_TERMINAL_FUNNEL_STEP: CommercialFunnelStep = 'appointment_booked';

/** Cette étape dépend-elle encore de Hermes ? */
export function stepAttributableToHermes(step: CommercialFunnelStep): boolean {
  return (
    COMMERCIAL_FUNNEL_STEPS.indexOf(step) <=
    COMMERCIAL_FUNNEL_STEPS.indexOf(HERMES_TERMINAL_FUNNEL_STEP)
  );
}

/**
 * L'objectif, rendu pour un prompt.
 *
 * Une seule source : si le périmètre change, le prompt change avec lui.
 */
export function renderObjectiveBlock(
  booking: {
    readonly mechanism: BookingMechanism;
    readonly bookingUrl: string | null;
    /**
     * HERMES-NATIVE-BOOKING-R1 — l'agenda natif porte-t-il des créneaux réels
     * pour ce tour ?
     *
     * `false` par défaut, et le défaut rend le bloc IDENTIQUE au caractère près
     * à celui d'avant ce round. C'est ce qui permet de vérifier par comparaison
     * de chaînes qu'un tour sans agenda n'a pas changé de prompt.
     */
    readonly nativeBooking?: boolean;
  } = {
    mechanism: BOOKING_MECHANISM_DEFAULT,
    bookingUrl: null,
  },
): string {
  const native = booking.nativeBooking === true;
  const lines: string[] = [
    `TON OBJECTIF (${APPOINTMENT_POLICY_VERSION}) — ${HERMES_PRIMARY_COMMERCIAL_OBJECTIVE}`,
    '',
    'Tu cherches à obtenir un échange de vive voix avec quelqu’un pour qui cela a du sens.',
    'Ce n’est pas une conversation longue que tu vises, ni un maximum de messages : c’est un',
    'rendez-vous qui vaut la peine d’être pris.',
    '',
    'Tu ne fais JAMAIS :',
  ];
  for (const entry of native ? HERMES_OUT_OF_SCOPE_WITH_NATIVE_BOOKING : HERMES_OUT_OF_SCOPE) {
    lines.push(`- ${entry}`);
  }
  lines.push(
    '',
    'Quand un échange devient l’étape naturelle, propose-le simplement et arrête de dérouler :',
    'ne refais pas le tour de l’offre, n’ajoute pas d’arguments, ne pose pas trois questions de plus.',
  );

  // Le moyen de réserver, dit à l'endroit où il est VRAI.
  //
  // Écrit depuis l'état réel plutôt qu'en dur, parce qu'une consigne figée
  // finirait par mentir dans un sens ou dans l'autre : « aucun lien n'existe »
  // le jour où un lien existe, ou l'inverse — qui est la version coûteuse,
  // puisqu'elle ferait inventer une URL au modèle.
  lines.push('');
  if (native) {
    // L'agenda natif : pas de lien, pas de passage de relais pour prendre la
    // date. Les créneaux eux-mêmes sont dans le bloc d'agenda, jamais ici — ce
    // bloc dit ce que Hermes a le droit de FAIRE, l'autre dit ce qui est LIBRE.
    lines.push(
      'Tu peux fixer le rendez-vous toi-même, dans la conversation : aucun lien, aucun',
      'formulaire, aucune page à ouvrir. Tu proposes les créneaux que le système te donne,',
      'et quand la personne en choisit un, tu confirmes.',
      'Tu ne dis JAMAIS qu’un rendez-vous est pris tant que le système ne te l’a pas confirmé,',
      'et tu n’annonces aucun créneau qui ne figure pas dans la liste qu’il t’a donnée.',
      'L’appel lui-même, c’est un humain qui le passe, jamais toi.',
    );
    return lines.join('\n');
  }
  if (booking.mechanism === 'BOOKING_MECHANISM_READY' && booking.bookingUrl !== null) {
    lines.push(
      'Pour réserver, il existe UN lien, et un seul :',
      booking.bookingUrl,
      'Recopie-le exactement, ou n’en mets aucun. Tu ne choisis pas de créneau, tu ne proposes',
      'aucune date, et tu n’écris dans aucun agenda : la personne réserve elle-même.',
    );
  } else {
    lines.push(
      'Aucun lien de réservation n’existe : n’en écris AUCUN, n’en invente aucun, et ne promets',
      'pas d’en envoyer un. Demande simplement une disponibilité — un humain reprend ensuite.',
    );
  }
  return lines.join('\n');
}
