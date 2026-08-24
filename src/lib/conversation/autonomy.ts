/**
 * HERMES-CONVERSATION-R2 §2 à §6 — la décision de RÉPONDRE SEUL, séparée de la
 * décision de rédiger.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi un second module de décision, alors que `decision.ts` existe
 * ---------------------------------------------------------------------------
 * `decideReply` (CONVERSATION-R1) répond à « faut-il écrire quelque chose, et
 * quoi ? ». Ce module répond à une question différente et strictement plus
 * exigeante : « ce qui a été écrit peut-il partir sans que personne ne le
 * relise ? ». §2 le dit en une phrase — **une bonne réponse générée n'est PAS
 * automatiquement envoyable**.
 *
 * Les fusionner aurait produit le pire arrangement possible : une seule
 * fonction dont la sortie sert à la fois de conseil de rédaction et
 * d'autorisation d'effet, si bien qu'assouplir l'une assouplirait l'autre sans
 * que personne ne s'en aperçoive. `decideReply.autoSendAllowed` reste donc le
 * littéral `false` qu'il a toujours été ; ce module ne le lit pas comme une
 * permission, il le lit comme un fait, et ajoute par-dessus ses propres portes.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce module ne fait pas
 * ---------------------------------------------------------------------------
 *   * il n'appelle aucun modèle et ne lit aucune base : il est PUR, ce qui est
 *     la seule façon d'éprouver la politique sur des états que les données
 *     réelles ne produiront pas de sitôt (§34) ;
 *   * il n'évalue ni l'arrêt global, ni les plafonds, ni la fenêtre, ni le bail
 *     navigateur. Ces quatre-là sont des faits de RUNTIME qui changent entre
 *     deux instants ; les lire ici les figerait dans une décision qu'on
 *     relirait plus tard comme un feu vert. Ils vivent dans `preEffect.ts`, et
 *     ils sont relus immédiatement avant l'effet ;
 *   * il n'écrit rien et n'autorise rien à lui seul : `AUTO_REPLY_ELIGIBLE`
 *     signifie « aucune porte de CONTENU ne s'y oppose », pas « envoie ».
 *
 * ---------------------------------------------------------------------------
 * Le sens de la sortie
 * ---------------------------------------------------------------------------
 * Quatre issues, et l'ordre dans lequel elles sont écrites est celui de leur
 * durée : `TERMINAL_STOP` est une réponse définitive, `HUMAIN` un transfert,
 * `SKIP` une question encore ouverte, `ELIGIBLE` un feu vert de contenu.
 *
 * Le doute ne produit JAMAIS `AUTO_REPLY_ELIGIBLE`. C'est la même règle que la
 * politique sortante (`autonomousPolicy.ts`), énoncée pour la même raison :
 * supprimer la review ne supprime pas le doute, elle supprime l'humain qui
 * l'arbitrait.
 */

import type { AppointmentQualification } from '@/lib/sales/objective';
import {
  COMMERCIAL_POLICY_VERSION,
  firstEscalatingDemand,
  GAP_ESCALATION,
  type CommercialDemandFinding,
} from '@/lib/conversation/commercialPolicy';
import type { GroundingGap } from '@/lib/conversation/grounding';
import type { NaturalnessCode, NaturalnessVerdict } from '@/lib/conversation/naturalness';
import type { OfferProgression } from '@/lib/conversation/offerProgression';
import type { ReplyDecision } from '@/lib/conversation/decision';
import type { ConversationSignals } from '@/lib/conversation/signals';
import type { ConversationState } from '@/lib/conversation/state';
import type { OutreachState, ProcessableCorrelation, ReplyCategory } from '@/lib/replies/taxonomy';

/**
 * L'identifiant de CETTE politique, inscrit dans chaque plan
 * (`hermes_conversation_plans.policy_version`).
 *
 * Il vit ICI, à côté des règles, et non dans `config/conversation.json` : une
 * version qui se règle sans toucher aux règles finirait par décrire autre chose
 * que ce qui a réellement décidé. Toute modification des portes ci-dessous
 * demande de l'incrémenter — c'est ce qui referme les décisions rendues sous
 * les règles d'hier (§40).
 *
 * Il est DISTINCT de `AUTONOMOUS_POLICY_VERSION` (`hermes-targeting-r1`), qui
 * gouverne le premier contact. Les deux politiques répondent à deux questions
 * — « à qui écrire ? » et « que répondre, seul ? » — et partager une étiquette
 * ferait couvrir l'une par les approbations de l'autre.
 *
 * r7 — HERMES-PLAN-STALE-TRIGGER-FIX-R1. La porte de FRAÎCHEUR du crochet
 * pré-effet a changé : elle reconnaît désormais le déclencheur du plan et ne le
 * traite plus comme un message qui l'aurait dépassé. Une porte qui change
 * impose d'incrémenter, même quand elle refuse MOINS souvent : les plans écrits
 * sous r6 ont été jugés par une autre porte, et c'est aussi la seule façon de
 * rejuger un tour clos sous une règle qu'on sait fausse — sans reclasser un
 * message que personne n'a mal compris.
 */
/**
 * HERMES-TRIAL-COST-VS-POST-TRIAL-PRICING-R1 §7 — pourquoi r9.
 *
 * Aucune porte de ce fichier ne bouge. Ce qui bouge est ce que les portes
 * LISENT : une demande `EXACT_PRICE` peut désormais être répondable quand elle
 * porte sur le coût du test ou sur le budget publicitaire
 * (`sales/priceSubject.ts`), et deux manques de grounding cessent de s'ouvrir
 * dans ce cas. Un tour jugé sous r8 a donc été jugé sous des règles qui ne sont
 * plus les nôtres, et l'incrément le referme : la clé d'idempotence d'un plan
 * porte cette version, si bien qu'un tour rejugé s'inscrit À CÔTÉ du plan
 * précédent au lieu de le ressusciter.
 *
 * Ce que l'incrément ne fait PAS : il ne débloque aucun plan existant.
 * `8d3e80f4` reste `BLOCKED`, intact, sans effet tenté — et
 * `recordConversationPlan` refuse toujours d'inscrire quoi que ce soit sur un
 * déclencheur qui porte déjà un effet tenté.
 */

/**
 * PITCH_REPEATED-FALSE-POSITIVE-R1 — pourquoi r11.
 *
 * Une seule porte change, et c'est la naturalité (`naturalness.ts`), lue par la
 * porte 21 bis (`naturalness_blocking`). `PITCH_REPEATED` confrontait le corps
 * ENTIER du brouillon au lexique d'offre, sans distinguer une AFFIRMATION d'une
 * QUESTION — « tu faisais la pub sur quelle prestation à l'époque ? » contient
 * « pub » et se faisait donc écarter comme une répétition, alors qu'elle ne
 * réaffirme rien : elle demande. Le contrôle ne confronte désormais au lexique
 * que les segments AFFIRMATIFS du brouillon (`statementSegments`) ; une
 * question pure n'en produit aucun, donc ne peut plus déclencher ce code.
 *
 * La porte refuse MOINS, jamais plus : un vrai pitch réaffirmé reste détecté
 * (§ tests `conversationNaturalness.test.ts`), et aucune autre porte n'est
 * touchée. L'incrément referme malgré tout les décisions rendues sous r10, y
 * compris celles qui refusaient — c'est la seule façon de rejuger le tour du
 * 23 août 2026 (plan `3086e93d-af09-4c26-b279-4ca92124ce29`, `CANCELLED`, sans
 * effet tenté) sans le ressusciter : `recordConversationPlan` inscrit le tour
 * rejugé À CÔTÉ, sur une clé d'idempotence neuve.
 */
export const CONVERSATION_POLICY_VERSION = 'hermes-conversation-r12';

/**
 * HERMES-ACQUISITION-SERVICE-TRUTH-R1 — pourquoi r8.
 *
 * Aucune porte n'est retirée, aucun seuil ne bouge, aucun plafond ne bouge. Ce
 * qui change est, comme en r6, ce qu'une porte LIT — mais à deux endroits cette
 * fois :
 *
 *   * la porte 15 bis (grounding). Six questions ont désormais un sujet à elles
 *     (`ACQUISITION_METHOD`, `LEAD_HANDLING`, `SEARCH_ADS`, `AD_BUDGET`,
 *     `ASSET_ACCESS`, `GEO_EXCLUSIVITY`, `RESULT_TIMING`), n'ouvrent donc plus
 *     `TOPIC_NOT_COVERED_BY_DATA`, et ne tombent donc plus ici. Le refus du
 *     23 août était exact — le dépôt ne savait pas dire ce qu'il fait — et il
 *     est faux depuis que `sales/acquisitionService.ts` l'écrit ;
 *
 *   * la porte 15 (demande commerciale). `AD_SPEND_AMOUNT` n'escalade plus,
 *     parce qu'une réponse vraie existe (`hermes-commercial-r4`). Toutes les
 *     autres demandes escaladent à l'identique, y compris dans le même message.
 *
 * Une porte qui refuse moins est une politique différente, pas une politique
 * corrigée : l'incrément referme par construction les décisions rendues sous
 * r7, y compris celles qui refusaient. C'est précisément ce qui permet de
 * REPLANIFIER le tour du 23 août sans toucher à son plan d'origine, qui reste
 * lisible avec la politique sous laquelle il a été rendu.
 *
 * Une porte refuse aussi PLUS, et il faut le dire : le contrôle de naturalité
 * connaît maintenant `QUESTION_WITHOUT_ANSWER`, donc un brouillon qui esquive
 * une question dont la réponse existe est écarté en `naturalness_blocking`. Ce
 * n'est pas une porte de plus — c'est un code de plus dans une porte qui
 * existait.
 */

/**
 * HERMES-CONTACT-PURPOSE-R1 — pourquoi r6.
 *
 * Aucune porte n'est retirée et aucun seuil ne bouge. Ce qui change est ce
 * qu'une porte LIT : « pourquoi tu me demandes ça ? » a désormais un sujet à
 * elle (`CONTACT_PURPOSE`), donc n'ouvre plus `TOPIC_NOT_COVERED_BY_DATA`, donc
 * ne tombe plus dans la porte 15 bis. Le refus de la veille était exact — le
 * dépôt ne portait pas son motif de contact — et il est faux depuis que
 * `sales/contactPurpose.ts` l'écrit.
 *
 * Une porte qui refuse moins est une politique différente, pas une politique
 * corrigée : l'incrément referme par construction les décisions rendues sous
 * r5, y compris celles qui refusaient. C'est précisément ce qui permet de
 * REPLANIFIER le tour du 23 août sans toucher à son plan d'origine, qui reste
 * lisible avec la politique sous laquelle il a été rendu.
 */

/**
 * HERMES-REPLY-DELIVERY-R1 §1 — pourquoi cette version a été incrémentée.
 *
 * Ce round ajoute une porte : la POLITIQUE COMMERCIALE lue directement sur le
 * message entrant (`commercialPolicy.ts`, porte 15 bis). Une porte de plus, ce
 * sont d'autres règles ; et la règle du dépôt sur ce point ne souffre pas
 * d'exception — « modifier une porte impose d'incrémenter la version, ce qui
 * referme les approbations d'avant ». Les décisions rendues sous
 * « hermes-conversation-r2 » n'ont jamais vu cette porte : les laisser couvrir
 * un effet reviendrait à faire autoriser un envoi par un texte abrogé.
 *
 * Aucun plan n'existait sous r2 au moment du changement (`select count(*) from
 * hermes_conversation_plans` = 0), donc rien n'a été invalidé rétroactivement.
 * La porte reste vraie même si un jour ce n'est plus le cas : la comparaison
 * porte sur la CONSTANTE, jamais sur un littéral recopié.
 */

/**
 * HERMES-SALES-KNOWLEDGE-R1 — pourquoi r4.
 *
 * Trois portes changent, et une seule dans le sens permissif :
 *
 *   1. la porte commerciale n'escalade plus sur TOUTE demande reconnue mais sur
 *      la première demande NON RÉPONDABLE (`firstEscalatingDemand`). C'est la
 *      conséquence directe de `hermes-commercial-r2` : « qu'est-ce que je paie
 *      pendant le test ? » a désormais une réponse vraie, et l'escalader
 *      reviendrait à faire attendre un humain pour un fait déjà écrit ;
 *   2. une porte NEUVE, `trial_misstated` : un brouillon qui évoque l'essai
 *      sans dire le budget publicitaire ne part pas. Strictement restrictive,
 *      et c'est la contrepartie exacte de la première ;
 *   3. `call_too_early` accepte une condition de plus — `QUALIFIED_FOR_CALL`
 *      (`sales/objective.ts`). C'est le seul assouplissement du round, et il
 *      s'AJOUTE : il ne peut refuser aucun échange que r3 acceptait.
 *
 * Le vote de version referme les décisions rendues sous r3, comme toujours.
 * `select count(*) from hermes_conversation_plans` valait 0 au moment du
 * changement : rien n'a été invalidé rétroactivement.
 */

/**
 * HERMES-CONTEXTUAL-REPLY-CLASSIFICATION-R1 — pourquoi r5.
 *
 * Une seule porte change, la porte 11 (« ce que D2 n'a pas su lire ») : la
 * matrice des catégories auto-répondables accueille `INFORMATION_SHARED`.
 * L'assouplissement est réel et il est nommé — un tour que r4 escaladait en
 * `unclassifiable` peut désormais recevoir une réponse — mais il ne vient
 * d'aucun desserrage : c'est une étiquette NEUVE, qui décrit ce que r4 n'avait
 * pas de mot pour décrire, et qui franchit ensuite les mêmes portes que les
 * trois autres.
 *
 * Ce qui n'a PAS bougé, et qui aurait pu si on s'était trompé de correctif :
 * `reply.minConfidence` reste 0,85, `MIN_ACTIONABLE_CONFIDENCE` reste 0,60,
 * aucune porte protectrice n'est déplacée, et l'ordre des portes est
 * identique — un opt-out, un contenu sensible, un fil terminal ou une salve
 * ouverte refusent avant que la catégorie ne soit seulement lue.
 *
 * Le vote de version referme les décisions rendues sous r4. Le seul plan
 * inscrit sous r4 au moment du changement était un `HUMAN_ESCALATION` clos
 * (`BLOCKED`, aucun effet tenté) : rien de vivant n'a été invalidé.
 */

/**
 * §21 — la fenêtre horaire des réponses et des relances.
 *
 * DÉCISION EXPLICITE, écrite en code plutôt qu'en configuration : la
 * conversation hérite intégralement de la fenêtre du rail sortant
 * (`config/instagram.json → schedule`, 09:00–20:00 Europe/Paris, du lundi au
 * vendredi).
 *
 * Le raisonnement, puisque la mission demande de trancher plutôt que de laisser
 * filer un 24/7 implicite :
 *
 *   * c'est le MÊME compte émetteur, le même navigateur, la même session. Une
 *     activité nocturne sur ce compte est visible qu'elle réponde ou qu'elle
 *     démarche ;
 *   * une réponse à 3 h du matin ne rend service à personne : le prospect la
 *     lira le matin, et elle aura seulement dit qu'une machine l'a écrite ;
 *   * élargir une fenêtre est un changement que personne n'a demandé, et le
 *     défaut prudent de la mission est « aucun changement non justifié ».
 *
 * Ce que cela coûte, et qui est assumé : quelqu'un qui écrit à 21 h reçoit sa
 * réponse le lendemain matin. Le speed-to-lead en souffre ; l'alternative
 * — ouvrir la nuit pour une machine — demanderait une décision humaine que
 * cette mission n'a pas prise.
 */
export const CONVERSATION_WINDOW_POLICY = 'INHERIT_OUTBOUND_WINDOW' as const;

// ---------------------------------------------------------------------------
// Le vocabulaire
// ---------------------------------------------------------------------------

export type AutonomousReplyOutcome =
  /** Aucune porte de contenu ne s'y oppose. Le runtime reste à consulter. */
  | 'AUTO_REPLY_ELIGIBLE'
  /** Un fait manque ou n'est pas encore vrai. Le tour reviendra tout seul. */
  | 'AUTO_REPLY_SKIP'
  /** Un humain doit reprendre. Ce n'est pas une erreur : c'est une issue normale. */
  | 'HUMAN_ESCALATION'
  /** Plus jamais, par aucun chemin automatique. */
  | 'TERMINAL_STOP';

/**
 * Pourquoi, dans un vocabulaire FERMÉ.
 *
 * Une chaîne libre laisserait un appelant inventer « probablement_ok ». Ici,
 * tout refus a dû être nommé dans un diff — et se retrouve tel quel dans
 * `hermes_conversation_plans.decision_reason`, donc dans les rapports.
 */
export type AutonomousReplyReason =
  // --- Définitifs -----------------------------------------------------------
  | 'opt_out'
  | 'unsubscribe_requested'
  | 'not_interested'
  | 'conversation_closed'
  | 'channel_unusable'
  | 'suppressed_state'
  // --- Un humain reprend ----------------------------------------------------
  | 'sensitive_content'
  | 'identity_uncertain'
  | 'unclassifiable'
  | 'low_confidence'
  | 'human_needed'
  | 'ambiguous_message'
  | 'pricing_policy_missing'
  | 'guarantee_requested'
  | 'proof_requested'
  | 'topic_not_covered'
  | 'commercial_policy_missing'
  // HERMES-REPLY-DELIVERY-R1 §1 — deux demandes que la politique commerciale
  // nomme et que rien ne nommait avant : un engagement contractuel et les
  // conditions d'un modèle à la performance. Elles tombaient jusqu'ici dans
  // `topic_not_covered`, qui est vrai mais muet — un opérateur y lisait « la
  // donnée manque » là où il fallait lire « personne n'a écrit ce contrat ».
  | 'contract_terms_requested'
  | 'performance_model_requested'
  | 'performance_claim'
  // HERMES-SALES-KNOWLEDGE-R1 §9 — l'essai décrit à moitié.
  //
  // Distinct de `performance_claim`, qui attrape une promesse INTERDITE. Ici,
  // rien n'est interdit : tout ce qui est écrit peut être vrai. Ce qui manque
  // est ce qui coûte de l'argent au prospect, et une offre amputée de son prix
  // est plus trompeuse qu'une promesse trop belle — elle ne déclenche aucune
  // méfiance.
  | 'trial_misstated'
  | 'guardrail_blocked'
  // --- Pas maintenant -------------------------------------------------------
  | 'not_now_deferred'
  | 'automated_counterparty'
  | 'burst_open'
  | 'stale_reply'
  | 'policy_version_mismatch'
  | 'draft_missing'
  | 'naturalness_blocking'
  | 'multiple_questions'
  | 'call_too_early'
  | 'pitch_too_early';

export interface AutonomousReplyDecision {
  readonly outcome: AutonomousReplyOutcome;
  /** `null` seulement quand la décision est `AUTO_REPLY_ELIGIBLE`. */
  readonly reason: AutonomousReplyReason | null;
  /** La porte qui a tranché — pour qu'un refus se relise sans reconstituer l'ordre. */
  readonly gate: string;
  readonly detail: string;
  /**
   * Ce tour peut-il redevenir éligible sans qu'un humain ne décide quoi que ce
   * soit ? `true` ⇒ un fait nouveau suffit ; `false` ⇒ la réponse est connue et
   * durable, ou elle appartient à un humain.
   */
  readonly reconsiderable: boolean;
}

// ---------------------------------------------------------------------------
// Les faits
// ---------------------------------------------------------------------------

/**
 * Ce qu'on sait du BROUILLON, réduit à des mesures.
 *
 * Aucun texte n'entre : la décision ne relit pas la prose, elle relit ce que
 * les contrôles déterministes en ont dit. C'est ce qui la rend testable sans
 * modèle, et ce qui empêche qu'une future porte se mette à juger le style avec
 * un troisième barème.
 */
export interface AutonomousDraftFacts {
  readonly bodySha256: string;
  /** Un garde-fou BLOQUANT de `checkReplyDraft`. Un seul suffit à écarter. */
  readonly guardrailBlocked: boolean;
  readonly naturalnessVerdict: NaturalnessVerdict;
  /**
   * Les constats de naturalité qui EMPÊCHENT l'envoi.
   *
   * HERMES-SEMANTIC-GROUNDING-R1 — ils ne sont plus « tous les constats
   * bloquants » mais ceux dont la classe est `POLICY` (`naturalnessSendGate`).
   * La distinction est celle entre une règle écrite ailleurs — une seule
   * question, pas d'appel prématuré, réponds d'abord, pas de langue de
   * plaquette — et une maladresse de forme que le cerveau a déjà eu une chance
   * de réécrire.
   */
  readonly naturalnessBlockingCodes: readonly NaturalnessCode[];
  /**
   * Les constats gardés pour la MESURE. Aucune porte ne les lit pour refuser.
   *
   * Ils existent pour qu'un rapport puisse dire « ce tour est parti avec une
   * ouverture déjà vue » — ce qui est une information de qualité, pas un motif
   * de silence.
   */
  readonly naturalnessWarningCodes: readonly NaturalnessCode[];
  readonly questions: number;
  /** Le brouillon propose-t-il un échange ? Lu par `proposesCall`. */
  readonly proposesCall: boolean;
  /** Le brouillon porte-t-il un argumentaire ? Lu par `containsPitch`. */
  readonly containsPitch: boolean;
  /** Les promesses de rémunération détectées par `detectPerformanceClaims`. */
  readonly performanceClaims: readonly string[];
  /**
   * Les défauts de description de l'essai, lus par `checkTrialStatement`.
   *
   * Des CODES, comme tout le reste ici : la décision ne relit pas la prose du
   * brouillon, elle relit ce que les contrôles déterministes en ont dit.
   */
  readonly trialStatementCodes: readonly string[];
}

export interface AutonomousReplyFacts {
  /** La politique sous laquelle ces faits ont été rassemblés. */
  readonly policyVersion: string;
  /**
   * HERMES-REPLY-DELIVERY-R1 §1 — la politique COMMERCIALE sous laquelle les
   * demandes ci-dessous ont été relevées.
   *
   * Séparée de `policyVersion` parce que les deux répondent à deux questions
   * — « peut-on répondre seul ? » et « que peut-on engager ? » — et qu'une
   * étiquette commune ferait couvrir l'une par les décisions de l'autre.
   */
  readonly commercialPolicyVersion: string;

  // ---- L'identité et le canal ---------------------------------------------
  readonly correlation: ProcessableCorrelation;
  /**
   * Le rapprochement entreprise ↔ compte est-il ÉTABLI, pas seulement
   * ressemblant ? Même barre que le premier contact : l'autonomie n'est pas une
   * raison de répondre à un compte qu'on croit reconnaître.
   */
  readonly identityConfirmed: boolean;

  // ---- Ce qu'un fait durable dit ------------------------------------------
  readonly suppressed: boolean;
  readonly outreachState: OutreachState | null;
  /**
   * Une catégorie TERMINALE déjà rencontrée dans ce fil, courant compris.
   *
   * Lue sur les tours, pas sur l'état : un fil qui contient un « merci, bonne
   * continuation » ne se rouvre pas parce qu'une transition d'état a été
   * ignorée quelque part.
   */
  readonly terminalCategoryInThread: ReplyCategory | null;

  // ---- Ce que ce tour dit --------------------------------------------------
  readonly category: ReplyCategory;
  readonly confidence: number;
  readonly signals: ConversationSignals;
  readonly state: ConversationState;
  readonly decision: ReplyDecision;
  readonly groundingGaps: readonly GroundingGap[];
  readonly offer: OfferProgression;

  // ---- Ce que le TEMPS dit -------------------------------------------------
  /** Un message plus récent existe : ce brouillon est dépassé (§24). */
  readonly newerInboundExists: boolean;
  /** La salve est close : la personne a fini de taper (§23). */
  readonly burstSettled: boolean;

  // ---- Ce que le message DEMANDE, commercialement --------------------------
  /**
   * Les demandes commerciales relevées sur le texte entrant, dans l'ordre du
   * lexique. Vide = aucune.
   *
   * Des FAITS, comme tout le reste ici : la lecture appartient à
   * `commercialPolicy.readCommercialDemands`, cette fonction ne relit aucun
   * texte. C'est ce qui permet d'éprouver la porte sur des demandes que les
   * données réelles ne produiront pas de sitôt.
   */
  readonly commercialDemands: readonly CommercialDemandFinding[];

  // ---- Ce que la conversation VAUT, commercialement ------------------------
  /**
   * Le verdict de qualification pour un rendez-vous
   * (`sales/objective.assessAppointmentQualification`).
   *
   * Un FAIT de plus, pas une seconde autorité. Il n'ouvre qu'une chose et elle
   * est nommée : la porte 21 accepte une proposition d'échange quand il vaut
   * `QUALIFIED_FOR_CALL`. Il ne peut refuser aucun tour — aucune porte ne le
   * lit pour écarter — et il ne remplace aucune des vingt autres.
   */
  readonly appointmentQualification: AppointmentQualification;

  // ---- Ce qui a été écrit --------------------------------------------------
  readonly draft: AutonomousDraftFacts | null;

  /** Le seuil de confiance de la politique, lu dans la configuration. */
  readonly minConfidence: number;
}

interface Verdict {
  readonly outcome: AutonomousReplyOutcome;
  readonly reason: AutonomousReplyReason;
  readonly gate: string;
  readonly detail: string;
  readonly reconsiderable: boolean;
}

/**
 * Les catégories dont la conséquence est de refermer la prospection.
 *
 * Exportée pour que celui qui rassemble les faits (`assessment.ts`) calcule
 * `terminalCategoryInThread` avec la MÊME liste que celle qui l'interprète. Une
 * seconde liste finirait par contenir un membre de plus d'un côté, et un fil
 * refermé serait relu comme ouvert.
 */
export const TERMINAL_REPLY_CATEGORIES: ReadonlySet<ReplyCategory> = new Set<ReplyCategory>([
  'UNSUBSCRIBE',
  'NOT_INTERESTED',
  'BOUNCE',
]);

/** La première catégorie terminale d'une suite de tours, ou `null`. */
export function terminalCategoryIn(
  categories: readonly (ReplyCategory | null)[],
): ReplyCategory | null {
  for (const category of categories) {
    if (category !== null && TERMINAL_REPLY_CATEGORIES.has(category)) return category;
  }
  return null;
}

/**
 * §4 — la matrice des catégories AUTO-RÉPONDABLES, construite depuis la
 * politique existante plutôt que devinée.
 *
 * Elle n'est pas écrite à la main : une catégorie est candidate si et seulement
 * si `CATEGORY_POLICY[c].draftEligible` est vrai — c'est-à-dire si D2 juge
 * qu'un brouillon a un sens — ET si elle ne demande pas de report. Le second
 * critère écarte `NOT_NOW`, qui est `draftEligible` chez D2 (un accusé de
 * réception a du sens) mais qui, en autonomie, appartient au moteur de relance
 * (§5, §17) et non au rail de réponse immédiate.
 *
 * Il reste donc, factuellement : `INTERESTED`, `QUESTION`, `INFORMATION_SHARED`
 * et `OBJECTION`. Et `OTHER` n'y est PAS, contrairement à ce que §4 laissait
 * ouvert : la taxonomie le définit comme « un message qui ne nous est pas
 * destiné, écrit par un tiers ou hors sujet », c'est-à-dire l'aveu
 * d'incertitude de D2. Une compréhension « suffisamment certaine » d'un `OTHER`
 * n'existe pas — s'il était compris, il ne serait pas `OTHER`.
 *
 * HERMES-CONTEXTUAL-REPLY-CLASSIFICATION-R1 — `INFORMATION_SHARED` entre par la
 * même porte que les trois autres, et par elle seule : la taxonomie le déclare
 * `draftEligible`, et cette liste ne fait que le lire. C'est le cas NORMAL
 * d'une conversation qui avance — la personne répond à ce qu'on lui a demandé.
 * Rien d'autre n'a été desserré pour lui : le seuil de confiance
 * (`reply.minConfidence`, 0,85) s'applique à l'identique porte 12, et un
 * message trop court pour porter un sujet retombe comme avant sur
 * `ambiguous_message` porte 15.
 */
/**
 * HERMES-END-TO-END-CERTIFICATION-R1 — exportée pour être TENUE, pas relue.
 *
 * Le commentaire ci-dessus décrit une DÉRIVATION (`draftEligible` ET pas de
 * report) et le code en est la transcription à la main. Les deux s'accordent
 * aujourd'hui ; rien ne les y obligeait. Un invariant
 * (`tests/certification/invariants.test.ts`) vérifie désormais les deux moitiés
 * de la phrase : cet ensemble est INCLUS dans les catégories rédigeables, et ce
 * qui les sépare est exactement `NOT_NOW` — la seule exclusion documentée, et
 * celle que la porte 9 refuse déjà pour son propre compte.
 *
 * Sans lui, retourner un `draftEligible` dans la taxonomie ouvrirait un
 * décalage silencieux : le rail admettrait une catégorie pour laquelle aucun
 * brouillon n'est jamais écrit, et le tour finirait en `draft_missing` au lieu
 * de refuser sur la porte qu'on croyait tenir.
 */
export const AUTO_REPLYABLE_CATEGORIES: ReadonlySet<ReplyCategory> = new Set<ReplyCategory>([
  'INTERESTED',
  'QUESTION',
  'INFORMATION_SHARED',
  'OBJECTION',
]);

/*
 * `GAP_ESCALATION` vivait ICI et vit maintenant dans `commercialPolicy.ts`.
 *
 * Ce n'était pas une table de plus : c'était la moitié d'une politique
 * commerciale, écrite à côté de l'autre moitié (`grounding.ts`) sans que rien
 * ne les relie ni ne les versionne. Les déplacer ne change aucun verdict — les
 * quatre correspondances sont identiques — et rend possible ce qui manquait :
 * dire sous quelle politique commerciale une réponse est partie.
 */

/**
 * Tranche : ce tour peut-il recevoir une réponse automatique ?
 *
 * L'ordre des portes EST la politique. Il va du plus DURABLE au plus
 * circonstanciel, pour deux raisons qui vont dans le même sens :
 *
 *   1. un refus définitif doit se relire comme définitif six mois plus tard —
 *      un prospect qui a demandé qu'on arrête ne doit pas porter le motif
 *      « salve non close » ;
 *   2. les portes protectrices doivent être évaluées AVANT toute considération
 *      commerciale, pour qu'aucune branche ne puisse les court-circuiter.
 *
 * Le premier refus gagne, et il n'existe aucune seconde chance plus indulgente
 * en aval : `AUTO_REPLY_ELIGIBLE` n'est rendu que si AUCUNE porte ne refuse.
 */
export function decideAutonomousReply(facts: AutonomousReplyFacts): AutonomousReplyDecision {
  const verdict = firstRefusal(facts);
  if (verdict !== null) return Object.freeze({ ...verdict });
  return Object.freeze({
    outcome: 'AUTO_REPLY_ELIGIBLE' as const,
    reason: null,
    gate: 'autonomous_reply',
    detail:
      `${facts.category} (confiance ${facts.confidence.toFixed(2)}), objectif ${facts.state.goal}, ` +
      `palier ${facts.offer.stage} — toutes les portes de contenu sont vertes ; ` +
      'le runtime reste à consulter immédiatement avant l’effet',
    reconsiderable: false,
  });
}

function firstRefusal(facts: AutonomousReplyFacts): Verdict | null {
  // ---- 1. L'exclusion enregistrée -----------------------------------------
  //
  // En tête, avant même de lire ce que le message dit : quelqu'un qui figure
  // dans `do_not_contact` n'a pas à voir sa dernière phrase interprétée.
  if (facts.suppressed) {
    return {
      outcome: 'TERMINAL_STOP',
      reason: 'opt_out',
      gate: 'opt_out',
      detail: 'ce commerce figure dans do_not_contact — aucune réponse, quelle que soit la ligne qui le porte',
      reconsiderable: false,
    };
  }

  // ---- 2. L'état terminal de la machine ------------------------------------
  if (facts.outreachState === 'SUPPRESSED') {
    return {
      outcome: 'TERMINAL_STOP',
      reason: 'suppressed_state',
      gate: 'outreach_state',
      detail:
        'l’état commercial est SUPPRESSED — terminal pour la machine, et seul un humain peut l’en sortir',
      reconsiderable: false,
    };
  }

  // ---- 3. La demande d'arrêt, qui gagne sur tout, y compris sur l'hostilité -
  //
    // Même ordre que `decideReply` : quelqu'un qui insulte ET demande qu'on
  // arrête a d'abord demandé qu'on arrête.
  if (facts.category === 'UNSUBSCRIBE') {
    return {
      outcome: 'TERMINAL_STOP',
      reason: 'unsubscribe_requested',
      gate: 'category',
      detail: 'demande explicite d’arrêt — plus aucun message automatique, par aucun chemin',
      reconsiderable: false,
    };
  }

  // ---- 4. Une non-remise : il n'y a personne au bout ------------------------
  if (facts.category === 'BOUNCE') {
    return {
      outcome: 'TERMINAL_STOP',
      reason: 'channel_unusable',
      gate: 'category',
      detail: 'rapport de non-remise — le canal ne délivre pas, il n’y a personne à qui répondre',
      reconsiderable: false,
    };
  }

  // ---- 5. Le contenu sensible sort du chemin automatique --------------------
  //
  // AVANT le refus commercial, et c'est une différence assumée avec la porte 3 :
  // un « je vous colle un avocat » suivi d'un refus n'appelle pas un arrêt
  // silencieux mais un humain — l'arrêt ne répond pas à la menace.
  if (facts.signals.sensitiveFlags.length > 0) {
    return {
      outcome: 'HUMAN_ESCALATION',
      reason: 'sensitive_content',
      gate: 'sensitive',
      detail: `sujet sensible (${facts.signals.sensitiveFlags.join(', ')}) — un humain reprend la main`,
      reconsiderable: false,
    };
  }

  // ---- 6. Le refus clair ---------------------------------------------------
  if (facts.category === 'NOT_INTERESTED') {
    return {
      outcome: 'TERMINAL_STOP',
      reason: 'not_interested',
      gate: 'category',
      detail: 'refus clair — on s’arrête, sans plaider et sans relancer',
      reconsiderable: false,
    };
  }

  // ---- 7. Le fil porte DÉJÀ une fin ----------------------------------------
  //
  // Un prospect qui a écrit « merci, bonne continuation » puis, dix minutes
  // plus tard, une question anodine, ne rouvre pas une prospection : il est
  // poli. Reprendre le fil commercial sur ce prétexte est exactement ce qu'un
  // humain ne ferait pas.
  if (facts.terminalCategoryInThread !== null) {
    return {
      outcome: 'TERMINAL_STOP',
      reason: 'conversation_closed',
      gate: 'thread_terminal',
      detail:
        `ce fil porte déjà un ${facts.terminalCategoryInThread} — une conversation refermée ne se rouvre ` +
        'pas automatiquement, même sur un message ultérieur qui ressemble à de l’intérêt',
      reconsiderable: false,
    };
  }

  if (facts.outreachState === 'NOT_INTERESTED') {
    return {
      outcome: 'TERMINAL_STOP',
      reason: 'not_interested',
      gate: 'outreach_state',
      detail: 'l’état commercial est NOT_INTERESTED — la prospection froide est close sur ce prospect',
      reconsiderable: false,
    };
  }

  // ---- 8. L'identité du compte ---------------------------------------------
  //
  // Une réponse est un message commercial de plus. La barre ne baisse pas parce
  // que la personne a écrit la première : un fil peut être tenu par quelqu'un
  // d'autre que le commerce qu'on croit avoir joint.
  if (!facts.identityConfirmed) {
    return {
      outcome: 'HUMAN_ESCALATION',
      reason: 'identity_uncertain',
      gate: 'identity',
      detail:
        'le rapprochement entre ce commerce et ce compte n’est pas établi — répondre engagerait un ' +
        'message commercial vers quelqu’un qu’on n’a pas identifié',
      reconsiderable: true,
    };
  }

  // ---- 9. Le report explicite appartient au moteur de relance ---------------
  //
  // §5 : « NOT_NOW : ne pas continuer la conversation immédiatement ». Ce n'est
  // ni un refus ni une escalade — c'est une intention DIFFÉRÉE, et elle a son
  // propre module.
  if (facts.category === 'NOT_NOW') {
    return {
      outcome: 'AUTO_REPLY_SKIP',
      reason: 'not_now_deferred',
      gate: 'category',
      detail:
        'report explicite — aucune réponse commerciale immédiate ; la suite appartient au moteur de ' +
        'relance différée, qui décidera d’une date',
      reconsiderable: true,
    };
  }

  // ---- 10. Une machine en face ---------------------------------------------
  if (facts.category === 'AUTO_REPLY') {
    return {
      outcome: 'AUTO_REPLY_SKIP',
      reason: 'automated_counterparty',
      gate: 'category',
      detail: 'réponse automatique d’absence — un fait sur un agenda, pas quelqu’un à qui répondre',
      reconsiderable: true,
    };
  }

  // ---- 11. Ce que D2 n'a pas su lire ---------------------------------------
  if (!AUTO_REPLYABLE_CATEGORIES.has(facts.category)) {
    return {
      outcome: 'HUMAN_ESCALATION',
      reason: 'unclassifiable',
      gate: 'category',
      detail:
        `la catégorie ${facts.category} n’est pas auto-répondable : elle est l’aveu d’incertitude de D2, ` +
        'et ce qu’il n’a pas su lire ne devient pas lisible ici',
      reconsiderable: false,
    };
  }

  // ---- 12. La confiance ----------------------------------------------------
  if (facts.confidence < facts.minConfidence) {
    return {
      outcome: 'HUMAN_ESCALATION',
      reason: 'low_confidence',
      gate: 'confidence',
      detail:
        `confiance ${facts.confidence.toFixed(2)} sous le seuil autonome ${facts.minConfidence.toFixed(2)} — ` +
        'une étiquette dont il faut discuter n’autorise pas une réponse sans personne',
      reconsiderable: false,
    };
  }

  // ---- 13. Ce que l'état conversationnel dit --------------------------------
  if (facts.state.humanNeeded || facts.state.goal === 'AWAIT_HUMAN') {
    return {
      outcome: 'HUMAN_ESCALATION',
      reason: 'human_needed',
      gate: 'conversation_state',
      detail: 'l’état conversationnel réclame un humain — la machine n’a pas de lecture sûre de ce tour',
      reconsiderable: false,
    };
  }

  // ---- 14. Le message est-il seulement lisible ? ---------------------------
  if (
    facts.signals.tooShortToRead &&
    facts.signals.questionTopic === 'NONE' &&
    facts.signals.buyingSignal === 'NONE'
  ) {
    return {
      outcome: 'HUMAN_ESCALATION',
      reason: 'ambiguous_message',
      gate: 'ambiguity',
      detail:
        'message trop court pour porter un sujet, sans question ni signal d’achat — répondre demanderait ' +
        'de deviner ce qu’il veut dire',
      reconsiderable: false,
    };
  }

  // ---- 15. La POLITIQUE COMMERCIALE, lue sur ce que le prospect DEMANDE -----
  //
  // AVANT le grounding, et l'ordre est le sujet. Les deux portes disent souvent
  // la même chose, mais elles ne se trompent pas au même endroit : le grounding
  // part de `signals.questionTopic`, qui ne retient qu'UN sujet par message et
  // qu'une demande d'appel écrase (`signals.ts`). « Vous prenez combien de % ?
  // On peut s'appeler ? » sortait donc de la lecture en `CALL_REQUEST`, sans
  // manque ouvert, et passait cette porte-ci comme un tour ordinaire.
  //
  // La lecture d'ici est lexicale, cumulative, et indépendante de la conclusion
  // du modèle. Elle passe devant pour que le MOTIF inscrit soit le plus précis
  // des deux : « demande de pourcentage » se relit ; `TOPIC_NOT_COVERED_BY_DATA`
  // laisse chercher.
  // HERMES-SALES-KNOWLEDGE-R1 — la première demande NON RÉPONDABLE, et non
  // plus la première demande tout court.
  //
  // La nuance est tout le round. `hermes-commercial-r2` porte enfin une réponse
  // vraie à une question — celle des conditions du test — et escalader
  // là-dessus ferait attendre un humain pour un fait déjà écrit. Toutes les
  // autres demandes escaladent comme avant, y compris quand elles arrivent dans
  // le MÊME message qu'une demande répondable : la lecture reste cumulative, et
  // la première qui engage l'emporte.
  const demand = firstEscalatingDemand(facts.commercialDemands);
  if (demand !== null && demand.reason !== null) {
    return {
      outcome: 'HUMAN_ESCALATION',
      reason: demand.reason,
      gate: 'commercial_demand',
      detail:
        `${demand.label} (${demand.demand}) — la politique commerciale ${facts.commercialPolicyVersion} ` +
        'ne porte ni montant, ni part, ni durée, ni garantie, et ce qui n’est pas écrit ne s’improvise ' +
        'pas dans un DM : un humain donne cette réponse',
      reconsiderable: false,
    };
  }

  // ---- 15 bis. Ce que le dépôt ne sait pas, et qui ne s'invente pas ---------
  for (const gap of facts.groundingGaps) {
    const reason = GAP_ESCALATION[gap];
    if (reason === undefined) continue;
    return {
      outcome: 'HUMAN_ESCALATION',
      reason,
      gate: 'grounding',
      detail:
        `${gap} — la réponse honnête à cette demande dépend de conditions que ce dépôt ne porte pas ; ` +
        'un humain doit la donner',
      reconsiderable: false,
    };
  }

  // ---- 15 ter. La décision conversationnelle, quand elle n'est pas un
  //              brouillon commercial ------------------------------------------
  //
  // Placée APRÈS l'ambiguïté et le grounding, et l'ordre est le sujet :
  // `decideReply` rend `CLARIFY` pour DEUX raisons différentes — un message
  // illisible et un sujet non couvert — et un rapport qui les confondrait ferait
  // chercher une reformulation là où il manque une politique tarifaire. Les
  // portes précises passent donc devant, et celle-ci attrape le reste.
  //
  // Rejuger le fond ici produirait une seconde politique du doute, et c'est
  // toujours la plus indulgente qui finirait par gagner.
  if (facts.decision.decision !== 'DRAFT_FOR_HUMAN') {
    return {
      outcome: facts.decision.decision === 'CLARIFY' ? 'HUMAN_ESCALATION' : 'TERMINAL_STOP',
      reason: facts.decision.decision === 'CLARIFY' ? 'ambiguous_message' : 'conversation_closed',
      gate: 'reply_decision',
      detail:
        `la décision conversationnelle est ${facts.decision.decision}` +
        (facts.decision.escalationReason === null ? '' : ` (${facts.decision.escalationReason})`) +
        ' — elle n’est pas un brouillon commercial destiné à partir seul',
      reconsiderable: false,
    };
  }

  // ---- 16. Le palier commercial et ses conditions manquantes ----------------
  if (facts.offer.needsCommercialPolicy) {
    return {
      outcome: 'HUMAN_ESCALATION',
      reason: 'commercial_policy_missing',
      gate: 'commercial_policy',
      detail:
        `le tour appelle le palier ${facts.offer.stage}, et aucune politique commerciale canonique ` +
        `n’existe (${facts.offer.commercialPolicy}) — les termes exacts d’un modèle de rémunération ` +
        'ne s’écrivent pas dans un DM avant d’avoir été formalisés',
      reconsiderable: true,
    };
  }

  // ---- 17. La SALVE est-elle finie ? ---------------------------------------
  //
  // Avant la fraîcheur, et l'ordre compte : répondre à une salve encore ouverte
  // et répondre à un message dépassé sont deux fautes différentes, et un
  // opérateur doit pouvoir les distinguer dans un rapport.
  if (!facts.burstSettled) {
    return {
      outcome: 'AUTO_REPLY_SKIP',
      reason: 'burst_open',
      gate: 'burst',
      detail:
        'la salve n’est pas close — la personne est peut-être encore en train d’écrire, et répondre à ' +
        'la deuxième bulle sur trois est la signature la plus lisible d’une machine',
      reconsiderable: true,
    };
  }

  // ---- 18. La FRAÎCHEUR ----------------------------------------------------
  if (facts.newerInboundExists) {
    return {
      outcome: 'AUTO_REPLY_SKIP',
      reason: 'stale_reply',
      gate: 'freshness',
      detail:
        'un message plus récent est arrivé depuis — ce brouillon répond à une phrase qui n’est plus la ' +
        'dernière, et il doit être recalculé sur le contexte à jour',
      reconsiderable: true,
    };
  }

  // ---- 19. La politique qui a rassemblé ces faits ---------------------------
  if (facts.policyVersion !== CONVERSATION_POLICY_VERSION) {
    return {
      outcome: 'AUTO_REPLY_SKIP',
      reason: 'policy_version_mismatch',
      gate: 'policy_version',
      detail:
        `ces faits ont été rassemblés sous « ${facts.policyVersion} » et la politique courante est ` +
        `« ${CONVERSATION_POLICY_VERSION} » — une décision rendue sous d’autres règles ne les couvre pas`,
      reconsiderable: true,
    };
  }

  if (facts.commercialPolicyVersion !== COMMERCIAL_POLICY_VERSION) {
    return {
      outcome: 'AUTO_REPLY_SKIP',
      reason: 'policy_version_mismatch',
      gate: 'commercial_policy_version',
      detail:
        `les demandes commerciales ont été relevées sous « ${facts.commercialPolicyVersion} » et la ` +
        `politique courante est « ${COMMERCIAL_POLICY_VERSION} » — ce qu'on s'autorise à engager a ` +
        'changé depuis, donc ce tour se rejuge avant de partir',
      reconsiderable: true,
    };
  }

  // ---- 20. Le brouillon ----------------------------------------------------
  const draft = facts.draft;
  if (draft === null) {
    return {
      outcome: 'AUTO_REPLY_SKIP',
      reason: 'draft_missing',
      gate: 'draft',
      detail: 'aucun brouillon n’a été rédigé pour ce tour — il n’y a rien à envoyer',
      reconsiderable: true,
    };
  }

  if (draft.guardrailBlocked) {
    return {
      outcome: 'HUMAN_ESCALATION',
      reason: 'guardrail_blocked',
      gate: 'guardrail',
      detail:
        'le brouillon porte un garde-fou bloquant — un chiffre non sourcé, un lien, une promesse : ' +
        'cela se lève par une régénération relue, pas par une tolérance',
      reconsiderable: false,
    };
  }

  if (draft.performanceClaims.length > 0) {
    return {
      outcome: 'HUMAN_ESCALATION',
      reason: 'performance_claim',
      gate: 'performance_claim',
      detail:
        `le brouillon énonce une condition commerciale non formalisée (${draft.performanceClaims.join(', ')}) — ` +
        'ce sont des engagements, pas des tournures',
      reconsiderable: false,
    };
  }

  // §9 — l'essai dit à moitié.
  //
  // Placée juste après les promesses interdites, et pour la même raison
  // qu'elles : ce n'est pas un défaut de style, c'est une affirmation
  // commerciale fausse. Un brouillon qui annonce sept jours sans frais et tait
  // le budget publicitaire est plus dangereux qu'un brouillon maladroit — il se
  // lit très bien, et le prospect découvre la dépense après avoir dit oui.
  if (draft.trialStatementCodes.length > 0) {
    return {
      outcome: 'HUMAN_ESCALATION',
      reason: 'trial_misstated',
      gate: 'trial_statement',
      detail:
        `le brouillon décrit le test de façon incomplète ou fausse (${draft.trialStatementCodes.join(', ')}) — ` +
        'le test se dit en entier (durée, absence de frais de service, budget publicitaire à la ' +
        'charge du prospect) ou ne se dit pas',
      reconsiderable: false,
    };
  }

  // HERMES-SEMANTIC-GROUNDING-R1 — le VERDICT ne refuse plus, les CONSTATS si.
  //
  // Cette porte lisait `verdict === 'UNNATURAL'`, c'est-à-dire « au moins un
  // constat bloquant », quelle que soit sa nature. Une ouverture déjà vue, un
  // dépassement de quelques caractères ou un rebond absent mettaient donc en
  // SILENCE un tour commercialement juste, sûr et compris — trois fois sur le
  // fil contrôlé. Le silence est un choix, et c'est le plus coûteux : le
  // prospect n'a pas de réponse, et personne ne sait qu'il en attendait une.
  //
  // Ce qui refuse désormais est la classe `POLICY` : une seule question (§8),
  // pas d'appel prématuré (§17), réponds d'abord, pas de langue de plaquette.
  // Trois de ces quatre ont d'ailleurs leur propre porte dans cette fonction,
  // ce qui rendait l'ancienne lecture doublement incohérente — ferme là-bas,
  // et floue ici.
  //
  // Ce que cela n'ouvre PAS : le brouillon reste soumis, EN AMONT de cette
  // porte, aux garde-fous de contenu (`guardrail_blocked`), aux promesses de
  // rémunération (`performance_claim`) et à la description de l'essai
  // (`trial_misstated`). Aucune de ces trois n'a bougé d'un cran, et aucune
  // n'est un constat de naturalité.
  if (draft.naturalnessBlockingCodes.length > 0) {
    return {
      outcome: 'AUTO_REPLY_SKIP',
      reason: 'naturalness_blocking',
      gate: 'naturalness',
      detail:
        `le contrôle de naturalité bloque (${draft.naturalnessBlockingCodes.join(', ')}) — ` +
        'ce message ne partirait pas tel quel',
      reconsiderable: true,
    };
  }

  // Redondant avec `MULTIPLE_QUESTIONS` du contrôle de naturalité, et gardé
  // pour cette raison : §3 en fait une condition d'AUTONOMIE, pas seulement de
  // style. Si un jour le contrôle desserrait ce point, l'autonomie ne suivrait
  // pas toute seule.
  if (draft.questions > 1) {
    return {
      outcome: 'AUTO_REPLY_SKIP',
      reason: 'multiple_questions',
      gate: 'one_question',
      detail: `${String(draft.questions)} questions dans le même message — une seule au maximum`,
      reconsiderable: true,
    };
  }

  // ---- 21. Ce que le brouillon PROPOSE, face à la maturité du tour ----------
  // HERMES-SALES-KNOWLEDGE-R1 §5, §23 — une troisième condition, qui S'AJOUTE.
  //
  // Les deux premières sont celles de r3 et n'ont pas bougé d'un cran. La
  // troisième — `QUALIFIED_FOR_CALL` — dit qu'un échange humain est la
  // prochaine action naturelle, sur des critères écrits dans `objective.ts` et
  // délibérément étroits. Elle ne peut REFUSER aucun tour : la porte reste une
  // disjonction, donc tout ce que r3 laissait passer passe encore.
  //
  // Pourquoi elle existe : la maturité historique répondait à « en sait-on
  // assez pour vendre ? », alors que le rendez-vous visé est un rendez-vous de
  // qualification. Quelqu'un qui demande comment cela fonctionne et montre de
  // l'intérêt n'a pas besoin d'un tour de plus pour mériter quinze minutes.
  const callJustified =
    facts.signals.explicitCallRequest ||
    facts.signals.callReadiness === 'HIGH' ||
    facts.appointmentQualification === 'QUALIFIED_FOR_CALL';
  if (draft.proposesCall && !callJustified) {
    return {
      outcome: 'AUTO_REPLY_SKIP',
      reason: 'call_too_early',
      gate: 'call_readiness',
      detail:
        `le brouillon propose un échange alors que la maturité est ${facts.signals.callReadiness}, ` +
        `que la qualification est ${facts.appointmentQualification} et qu’aucune demande explicite ` +
        'n’a été faite',
      reconsiderable: true,
    };
  }

  if (draft.containsPitch && facts.offer.readiness === 'LOW') {
    return {
      outcome: 'AUTO_REPLY_SKIP',
      reason: 'pitch_too_early',
      gate: 'offer_readiness',
      detail:
        'le brouillon porte un argumentaire alors qu’aucun besoin n’a été exprimé — l’offre se présente ' +
        'quand elle répond à quelque chose',
      reconsiderable: true,
    };
  }

  return null;
}

/**
 * Le tour part-il ? La seule question qu'un appelant a le droit de poser.
 *
 * Écrite comme une égalité stricte à l'unique valeur positive plutôt que comme
 * une négation des refus : ajouter un jour une cinquième issue la rendrait
 * non-envoyante par défaut, ce qui est le sens de fail-closed.
 */
export function isAutoReplyEligible(decision: AutonomousReplyDecision): boolean {
  return decision.outcome === 'AUTO_REPLY_ELIGIBLE';
}

/** La décision est-elle ABSORBANTE ? Un arrêt ne se rejoue jamais. */
export function isTerminalReplyDecision(decision: AutonomousReplyDecision): boolean {
  return decision.outcome === 'TERMINAL_STOP';
}

/** La forme lisible des rapports : `HUMAN_ESCALATION:pricing_policy_missing`, … */
export function formatAutonomousReplyDecision(decision: AutonomousReplyDecision): string {
  return decision.reason === null ? decision.outcome : `${decision.outcome}:${decision.reason}`;
}
