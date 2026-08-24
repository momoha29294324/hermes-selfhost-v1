/**
 * LEARNING-R1 §15, §16, §17 — quand l'offre devient une question légitime.
 *
 * Ce fichier OBSERVE. Il ne produit aucune phrase, il n'autorise aucune mention,
 * et il ne touche à aucune règle de rédaction. C'est la contrainte de §16 prise
 * au sérieux : « Dans R1 : analyse seulement ». Le type de sortie n'a pas de
 * champ textuel, donc rien de ce qui sort d'ici ne peut se retrouver dans un
 * message même par accident.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi aucun lexique nouveau
 * ---------------------------------------------------------------------------
 *
 * La maturité se lit sur les signaux DÉJÀ calculés par CONVERSATION-R1
 * (`readSignals`) : sujet de question, sujet d'objection, force du signal
 * d'achat, demande explicite d'échange. Écrire un second lexique « pour
 * l'offre » créerait une seconde lecture du même message, et les deux
 * finiraient par se contredire sur un cas limite. Le seul apport de ce fichier
 * est l'ARBITRAGE : quel niveau de maturité ces signaux composent.
 *
 * ---------------------------------------------------------------------------
 * §17 — la sécurité des promesses
 * ---------------------------------------------------------------------------
 *
 * `detectPerformanceClaims` existe pour que « rémunération liée aux résultats »
 * ne se transforme jamais tout seul en « vous ne payez que si vous gagnez ».
 * Les garde-fous du dépôt attrapent déjà « garanti » ; ils n'attrapent pas les
 * formulations de rémunération à la performance, qui sont exactement celles que
 * cette mission met sur la table. Le détecteur est ici, il est testé, et rien
 * dans ce round ne l'utilise pour autoriser quoi que ce soit — il n'existe que
 * pour refuser.
 */

import { normalizeForMatching } from '@/lib/conversation/text';
import type { ConversationSignals } from '@/lib/conversation/signals';
import type { CoveredTopic } from '@/lib/conversation/state';
import type { ReplyCategory } from '@/lib/replies/taxonomy';

// ---------------------------------------------------------------------------
// La maturité
// ---------------------------------------------------------------------------

export type OfferReadiness = 'LOW' | 'MEDIUM' | 'HIGH';

export interface OfferReadinessAssessment {
  readonly readiness: OfferReadiness;
  /** Les faits qui ont porté la conclusion. Des codes, pas des phrases libres. */
  readonly reasons: readonly string[];
  /**
   * L'autorisation de mentionner un modèle de rémunération à la performance.
   *
   * Littéral `false`, pas un booléen : aucune branche de ce round ne peut
   * produire `true`, et le TYPE le dit — un futur round devra changer la
   * signature, donc passer par une revue, plutôt que basculer une condition.
   */
  readonly performanceModelMentionAllowed: false;
}

/** Les questions qui demandent l'offre frontalement. */
const HIGH_QUESTION_TOPICS = new Set(['PRICE', 'HOW_IT_WORKS', 'GUARANTEE', 'CALL_REQUEST']);

/**
 * Les questions qui ouvrent la porte sans la franchir.
 *
 * HERMES-ACQUISITION-SERVICE-TRUTH-R1 — les sept sujets neufs entrent tous ici,
 * y compris `AD_BUDGET`, et y compris quand on pourrait plaider `HIGH`.
 *
 * `AD_BUDGET` est le cas discutable : demander quel budget prévoir ressemble à
 * demander un prix, et `PRICE` vaut `HIGH`. Ils sont pourtant `MEDIUM` ici, et
 * c'est le côté sûr — la maturité `HIGH` combinée à une maturité d'échange
 * `HIGH` fait basculer le palier sur `PROPOSE_CALL` (`offerProgression.ts`),
 * donc proposer un appel à quelqu'un qui s'informe. Aucun de ces sept sujets
 * n'est un « je veux acheter » ; ce sont des questions sur le métier.
 */
const MEDIUM_QUESTION_TOPICS = new Set([
  'WHAT_YOU_DO',
  'RESULTS_PROOF',
  'WHO_ARE_YOU',
  'MORE_INFO',
  'TIMING',
  'OTHER_QUESTION',
  'ACQUISITION_METHOD',
  'LEAD_HANDLING',
  'SEARCH_ADS',
  'AD_BUDGET',
  'ASSET_ACCESS',
  'GEO_EXCLUSIVITY',
  'RESULT_TIMING',
]);

export interface OfferReadinessInput {
  readonly category: ReplyCategory;
  readonly signals: ConversationSignals;
  /** Ce que NOS tours ont déjà couvert, tel que l'état conversationnel le porte. */
  readonly coveredTopics: readonly CoveredTopic[];
}

/**
 * Lit la maturité d'un tour pour l'offre.
 *
 * L'ordre des tests est la politique : un refus ferme la porte quoi qu'il
 * arrive, une question de prix l'ouvre quoi qu'il arrive, et l'objection compte
 * comme un besoin exprimé — quelqu'un qui dit « j'ai déjà quelqu'un » vient de
 * nommer sa situation d'acquisition, ce qui est plus que de la politesse.
 */
export function assessOfferReadiness(input: OfferReadinessInput): OfferReadinessAssessment {
  const reasons: string[] = [];
  const { category, signals } = input;

  const closed =
    category === 'NOT_INTERESTED' ||
    category === 'UNSUBSCRIBE' ||
    category === 'AUTO_REPLY' ||
    category === 'BOUNCE';
  if (closed) {
    return Object.freeze({
      readiness: 'LOW' as const,
      reasons: Object.freeze([`category:${category}`]),
      performanceModelMentionAllowed: false as const,
    });
  }

  if (signals.explicitCallRequest) reasons.push('explicit_call_request');
  if (HIGH_QUESTION_TOPICS.has(signals.questionTopic)) reasons.push(`question:${signals.questionTopic}`);
  if (signals.buyingSignal === 'STRONG') reasons.push('buying_signal:STRONG');

  if (reasons.length > 0) {
    return Object.freeze({
      readiness: 'HIGH' as const,
      reasons: Object.freeze(reasons),
      performanceModelMentionAllowed: false as const,
    });
  }

  if (signals.objectionTopic !== 'NONE') reasons.push(`objection:${signals.objectionTopic}`);
  if (signals.buyingSignal === 'MODERATE') reasons.push('buying_signal:MODERATE');
  if (MEDIUM_QUESTION_TOPICS.has(signals.questionTopic)) reasons.push(`question:${signals.questionTopic}`);

  if (reasons.length > 0) {
    return Object.freeze({
      readiness: 'MEDIUM' as const,
      reasons: Object.freeze(reasons),
      performanceModelMentionAllowed: false as const,
    });
  }

  return Object.freeze({
    readiness: 'LOW' as const,
    reasons: Object.freeze(['no_need_expressed']),
    performanceModelMentionAllowed: false as const,
  });
}

// ---------------------------------------------------------------------------
// §15 — quand l'offre a RÉELLEMENT été expliquée
// ---------------------------------------------------------------------------

/** Une observation de calendrier commercial, sans jugement attaché. */
export interface OfferTimingObservation {
  readonly prospectId: string;
  /** Combien de tours entrants avaient eu lieu quand l'offre a été expliquée. */
  readonly inboundTurnsBeforeOffer: number | null;
  /** Combien de tours entrants avaient eu lieu quand un échange a été proposé. */
  readonly inboundTurnsBeforeCall: number | null;
  /** La maturité lue au tour où l'offre a été expliquée. */
  readonly readinessAtOffer: OfferReadiness | null;
  /** La personne avait-elle posé une question directe avant ? */
  readonly directQuestionBefore: boolean;
  /** Ce qui est arrivé au tour SUIVANT l'explication de l'offre. */
  readonly reactionAfterOffer: ReplyCategory | null;
  /**
   * Pourquoi l'observation est incomplète, quand elle l'est.
   *
   * Sur Instagram, nos messages tapés à la main ne laissent aucun texte
   * observable en base — seulement une empreinte. Un « offre jamais
   * expliquée » y serait une absence NON VÉRIFIÉE, ce que CLAUDE.md §2
   * interdit. Le champ dit donc « je n'ai pas pu voir », et le rapport le
   * reprend au lieu de compter un zéro.
   */
  readonly gap: 'OUTBOUND_TEXT_NOT_OBSERVABLE' | null;
}

// ---------------------------------------------------------------------------
// §17 — les promesses interdites
// ---------------------------------------------------------------------------

/**
 * Les formulations qu'aucune politique commerciale n'a définies.
 *
 * Elles ne sont pas interdites parce qu'elles seraient fausses : elles sont
 * interdites parce que personne n'a écrit ce qu'elles engagent. « Vous ne payez
 * que si vous gagnez » est un contrat, pas une tournure ; l'écrire dans un DM
 * avant que ce contrat existe crée une obligation que le dépôt ne sait pas
 * honorer.
 */
const PERFORMANCE_CLAIM_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['gratuit jusqu’aux résultats', /\bgratuit\s+(jusqu'aux?|tant\s+que)\b/i],
  ['aucun risque', /\b(aucun\s+risque|sans\s+aucun\s+risque|z[ée]ro\s+risque)\b/i],
  ['vous ne payez que si', /\bne\s+pa(?:yez?|ies?)\s+que\s+si\b/i],
  ['payé au résultat', /\bpay[ée]s?\s+(au|aux)\s+r[ée]sultats?\b/i],
  ['on ne se paie que si', /\bon\s+ne\s+(se\s+)?paie\s+que\s+si\b/i],
  ['remboursé si', /\brembours[ée]s?\s+si\b/i],
  ['satisfait ou remboursé', /\bsatisfait\s+ou\s+rembours[ée]\b/i],
  ['garanti', /\bgaranti[es]?\b/i],

  // HERMES-CONVERSATION-R2 §11 — les formulations que la mission met
  // explicitement sur la table, et leurs voisines immédiates.
  //
  // Elles sont ajoutées ICI, dans la liste qui existait déjà, et non dans un
  // second détecteur : deux lexiques de promesses finiraient par répondre non
  // d'un côté et oui de l'autre sur la même phrase, et c'est toujours le plus
  // indulgent qui gagnerait. Le motif « gratuit » nu en fait partie — dans un
  // message qui parle de NOTRE rémunération, il énonce une condition
  // commerciale que personne n'a écrite, et le fait qu'elle soit flatteuse ne
  // la rend pas plus définie.
  ['gratuit', /\bgratuit(e|s|es|ement)?\b/i],
  ['sans frais', /\bsans\s+(frais|co[ûu]t|engagement)\b/i],
  // HERMES-CONTACT-PURPOSE-R1 — la même promesse, au TUTOIEMENT.
  //
  // Ces deux motifs ne connaissaient que « payez » / « paye ». C'était sans
  // conséquence tant que Hermes vouvoyait par défaut ; ce round lui apprend à
  // tutoyer quand le prospect tutoie, et « tu ne paies que si ça marche »
  // serait passé au travers d'une garde qui existe pour l'attraper. Le trou est
  // fermé dans le lexique EXISTANT plutôt que dans un second détecteur : deux
  // lexiques de promesses finiraient par répondre non d'un côté et oui de
  // l'autre, et c'est toujours le plus indulgent qui gagnerait.
  ['vous ne payez rien', /\bne\s+pa(?:yez?|ies?)\s+rien\b/i],
  ['à la performance', /\b(au|[àa]\s+la)\s+performance\b/i],
  // Volontairement large : « notre rémunération dépend des résultats », « on
  // est rémunérés au résultat », « notre rémunération est liée à ce qu'on
  // apporte » disent la même chose et se formulent de dix façons. Le motif
  // exige seulement que les deux mots se tiennent dans la même proposition.
  ['rémunération liée aux résultats', /\br[éèe]mun[éèe]r\w*\b[^.!?]{0,60}\b(r[ée]sultats?|performances?|ce\s+qu'on\s+apporte)\b/i],
  ['on se rémunère si', /\br[éèe]mun[éèe]r\w*\b[^.!?]{0,30}\bsi\b/i],
  ['commission sur les résultats', /\bcommission\s+(sur|au)\b/i],
  ['nos intérêts sont alignés', /\b(nos\s+int[ée]r[êe]ts|int[ée]r[êe]ts)\s+(sont\s+)?align[ée]s\b/i],
  ['que si ça marche', /\bque\s+si\s+([çc]a|cela)\s+(marche|fonctionne)\b/i],
  ['jusqu’aux résultats', /\bjusqu'aux?\s+r[ée]sultats?\b/i],

  // HERMES-ACQUISITION-SERVICE-TRUTH-R1 §6, §8 — le trou qu'OUVRE ce round.
  //
  // Jusqu'ici, aucun montant de budget publicitaire ne pouvait s'écrire : la
  // demande escaladait, et `checkReplyDraft` bloquait tout montant en euros. Ce
  // round autorise DEUX montants — le départ typique, et la borne haute de la
  // zone raisonnable — parce que l'opérateur les a écrits.
  //
  // Ce qui devient possible du même coup est la phrase dangereuse : « avec 20 €
  // par jour tu auras des clients ». Elle n'est ni un prix, ni une garantie, ni
  // un pourcentage — aucune garde existante ne la voyait. Elle est pourtant une
  // PROMESSE, et c'est exactement la matière de cette liste.
  //
  // Ils sont ajoutés ICI, dans le lexique qui existait déjà, et non dans un
  // second détecteur : deux lexiques de promesses finiraient par répondre non
  // d'un côté et oui de l'autre sur la même phrase, et c'est toujours le plus
  // indulgent qui gagnerait.
  //
  // Les trois motifs sont écrits au tutoiement ET au vouvoiement, pour la
  // raison que le round précédent a payée : Hermes tutoie désormais quand le
  // prospect tutoie, et une garde qui ne connaît que « vous » ne garde rien.
  //
  // Les bornes sont des lookarounds UNICODE et non des `\b`. Le `\b` de
  // JavaScript ne connaît que `[A-Za-z0-9_]` : devant « ça te fait », il exige
  // une frontière entre une espace et un « ç », deux caractères qui ne sont NI
  // l'un ni l'autre des mots à ses yeux — donc pas de frontière, donc pas de
  // correspondance. C'est le défaut que ce dépôt a déjà payé deux fois
  // (`signals.ts`, `commercialPolicy.ts`), et il a été mesuré ici aussi, sur
  // « 20 € par jour ça te fait déjà de belles demandes ».
  [
    'budget présenté comme suffisant',
    /\d[\d\s.,]{0,6}\s*(?:€|eur|euros)(?![\p{L}\p{N}])[^.!?]{0,40}(?<![\p{L}\p{N}_])(?:suffi\w*|assez|c'est\s+bon|[çc]a\s+passe|largement)|(?<![\p{L}\p{N}_])(?:suffi\w*|assez)(?![\p{L}\p{N}_])[^.!?]{0,25}\d[\d\s.,]{0,6}\s*(?:€|eur|euros)(?![\p{L}\p{N}])/iu,
  ],
  [
    'budget relié à un résultat',
    /\d[\d\s.,]{0,6}\s*(?:€|eur|euros)(?![\p{L}\p{N}])[^.!?]{0,50}(?<![\p{L}\p{N}_])(?:tu\s+auras|tu\s+vas\s+avoir|vous\s+aurez|vous\s+allez\s+avoir|[çc]a\s+(?:te|vous)\s+(?:fait|donne|rapporte|ram[èe]ne)|tu\s+g[ée]n[èe]res?|vous\s+g[ée]n[ée]rez|de\s+belles?\s+demandes?)/iu,
  ],
  [
    'plus de budget = plus de résultats',
    /(?<![\p{L}\p{N}_])plus\s+(?:tu\s+d[ée]penses|vous\s+d[ée]pensez|de\s+budget|tu\s+mets|vous\s+mettez)[^.!?]{0,40}(?<![\p{L}\p{N}_])plus(?![\p{L}\p{N}_])/iu,
  ],

  // §4 — « QUALIFIED ≠ GARANTI », écrit comme une garde plutôt que comme une
  // consigne. Une préqualification existe et peut être dite ; la promettre
  // parfaite est une affirmation que rien ne soutient, et c'est précisément
  // celle qu'un modèle produit quand on lui apprend qu'on filtre.
  [
    'leads tous qualifiés',
    /(?<![\p{L}\p{N}_])(?:100\s*%|tous\s+(?:les\s+)?(?:leads?|contacts?|demandes?|prospects?)|chaque\s+(?:lead|demande|contact)|que\s+des\s+(?:leads?|clients?|demandes?))[^.!?]{0,40}(?<![\p{L}\p{N}_])(?:qualifi\w*|s[ée]rieux|joignables?|pertinent\w*|int[ée]ress[ée]\w*)/iu,
  ],
  [
    'tous joignables',
    /(?<![\p{L}\p{N}_])(?:tous|toutes|chacun)(?![\p{L}\p{N}_])[^.!?]{0,25}(?<![\p{L}\p{N}_])(?:r[ée]pondront|d[ée]crocheront|joignables?)/iu,
  ],

  // HERMES-END-TO-END-CERTIFICATION-R1 — les MÉTRIQUES promises, et pourquoi
  // aucune garde ne les voyait.
  //
  // Le dépôt connaissait ce vocabulaire du côté de la DEMANDE :
  // `commercialPolicy.ts` relève `PROOF_REQUEST` sur « cpl », « roas », « taux
  // de conversion », et `GUARANTEED_OUTCOME` sur « roi » et « combien de
  // leads ». Il ne le connaissait pas du côté de l'AFFIRMATION. Une question
  // sur le ROI escaladait donc correctement, et un brouillon qui PROMETTAIT un
  // ROI de sa propre initiative passait toutes les portes.
  //
  // Mesuré, pas supposé — onze formes réelles traversaient `checkReplyDraft`,
  // `detectPerformanceClaims` et `checkTrialStatement` sans un seul drapeau :
  // « Tu feras un ROI de 4 », « Le CPL est autour de 5 € », « Tu auras 10
  // clients par mois », « Les premiers résultats arrivent en 15 jours ». Celles
  // qui portaient un montant en euros étaient arrêtées par `unapproved_metric`
  // — mais un ratio, un pourcentage ou un compte n'a pas de devise, et rien ne
  // les regardait.
  //
  // C'est la même divergence que ce fichier a déjà payée deux fois : un
  // vocabulaire connu d'un côté du dépôt et pas de l'autre. Les motifs sont
  // ajoutés ICI, dans le lexique existant, pour la raison écrite plus haut.
  //
  // `performanceEvidence.ts` conserve les valeurs OBSERVÉES chez un client réel
  // (CPL ≈ 5–6 €, ROI ≈ 4,5–5) sous `WITHHELD_PENDING_PROVENANCE`. Ces motifs
  // sont ce qui rend cette retenue effective sur le texte plutôt que sur
  // l'intention.
  // Le NOM d'une métrique est du vocabulaire ; sa VALEUR est la promesse.
  //
  // La première version de ces trois motifs refusait la simple mention. Elle a
  // bloqué une phrase du rapport d'apprentissage — « Le taux de réponse seul ne
  // suffit pas à trancher » — qui est une observation interne destinée à
  // un opérateur, pas une affirmation faite à un prospect. Le même lexique sert aux
  // deux surfaces (`learning/proposal.ts` et `checkReplyDraft`), et un motif
  // qui refuse de NOMMER une métrique rend le rapport muet sans rien protéger.
  //
  // La ligne est donc le CHIFFRE, de part et d'autre du nom et dans la même
  // proposition. « Je ne peux pas te promettre de ROI » reste dicible — c'est
  // même la phrase honnête ; « Tu feras un ROI de 4 » ne l'est pas.
  [
    'coût par lead annoncé',
    /(?<![\p{L}\p{N}_])(?:cpl|cpa|coûts?\s+par\s+(?:lead|contact|demande|acquisition|client|rendez[- ]vous)|cout\s+par\s+(?:lead|contact|demande|acquisition|client)|prix\s+(?:du|par)\s+lead)(?![\p{L}\p{N}])[^.!?]{0,25}\d|\d[\d\s.,]{0,6}\s*(?:€|eur|euros)?[^.!?]{0,15}(?<![\p{L}\p{N}_])(?:de\s+)?(?:cpl|cpa|co[ûu]t\s+par\s+lead)(?![\p{L}\p{N}])/iu,
  ],
  [
    'retour sur investissement annoncé',
    /(?<![\p{L}\p{N}_])(?:roi|roas|retour\s+sur\s+investissement)(?![\p{L}\p{N}])[^.!?]{0,25}\d|\d[\d\s.,]{0,6}[^.!?]{0,15}(?<![\p{L}\p{N}_])(?:de\s+)?(?:roi|roas|retour\s+sur\s+investissement)(?![\p{L}\p{N}])/iu,
  ],
  [
    'taux de conversion annoncé',
    /(?<![\p{L}\p{N}_])taux\s+de\s+(?:conversion|transformation|closing|clic|r[ée]ponse)(?![\p{L}\p{N}])[^.!?]{0,25}\d|\d[\d\s.,]{0,6}\s*%?[^.!?]{0,20}(?<![\p{L}\p{N}_])(?:de\s+)?taux\s+de\s+(?:conversion|transformation|closing)(?![\p{L}\p{N}])/iu,
  ],
  // Un VOLUME promis. Il exige un nombre ET un nom de demande : « 20 à 25 € par
  // jour » ne parle d'aucun volume, et le budget publicitaire doit rester
  // dicible — c'est la seule vérité chiffrée que ce dépôt possède.
  [
    'volume de demandes annoncé',
    /(?<![\p{L}\p{N}_])(?:\d[\d\s.,]{0,5}|une?\s+(?:dizaine|quinzaine|vingtaine|trentaine|cinquantaine)|quelques)\s+(?:de\s+)?(?:leads?|clients?|demandes?|contacts?|rendez[- ]vous|rdv|appels?)(?![\p{L}\p{N}])/iu,
  ],
  [
    'volume moyen annoncé',
    /(?<![\p{L}\p{N}_])(?:en\s+moyenne|g[ée]n[èe]re\w*|ram[èe]ne\w*|fait\w*)[^.!?]{0,30}(?<![\p{L}\p{N}_])\d[\d\s.,]{0,5}\s*(?:leads?|clients?|demandes?|contacts?|rendez[- ]vous|rdv)(?![\p{L}\p{N}])/iu,
  ],
  // Un DÉLAI promis. Il exige une durée ET un résultat : « le test dure sept
  // jours » est un fait écrit, pas une promesse, et doit continuer de se dire.
  [
    'délai de résultat annoncé',
    /(?<![\p{L}\p{N}_])(?:en|d[èe]s|sous|au\s+bout\s+de|apr[èe]s|d'ici)\s+(?:\d[\d\s.,]{0,4}|une?|deux|trois|quatre|cinq|six|sept|huit|quinze)\s*(?:jours?|semaines?|mois)(?![\p{L}\p{N}])[^.!?]{0,50}(?<![\p{L}\p{N}_])(?:r[ée]sultats?|demandes?|clients?|leads?|contacts?|rendez[- ]vous)(?![\p{L}\p{N}])/iu,
  ],
  [
    'résultats datés',
    /(?<![\p{L}\p{N}_])(?:premiers?|premi[èe]res?)\s+(?:r[ée]sultats?|demandes?|clients?|leads?)(?![\p{L}\p{N}])[^.!?]{0,40}(?<![\p{L}\p{N}_])(?:en|d[èe]s|sous|au\s+bout\s+de|arrivent?|arriveront)(?![\p{L}\p{N}])[^.!?]{0,30}(?<![\p{L}\p{N}_])(?:\d|une?|deux|trois|quatre|cinq|six|sept|huit|quinze)/iu,
  ],
];

/** Les promesses détectées dans un texte. Tableau vide = aucune. */
export function detectPerformanceClaims(text: string): readonly string[] {
  const normalized = normalizeForMatching(text);
  return Object.freeze(
    PERFORMANCE_CLAIM_PATTERNS.filter((entry) => entry[1].test(normalized)).map((entry) => entry[0]),
  );
}
