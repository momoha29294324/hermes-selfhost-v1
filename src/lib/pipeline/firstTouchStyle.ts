import { containsForcedSlang, containsTextism } from '@/lib/conversation/naturalness';
import { countAddressMarkers, countEmojis, countSentences, countWords } from '@/lib/conversation/style';
import { normalizeForMatching } from '@/lib/conversation/text';
import { detectBuyerRole, type BuyerRoleFinding } from '@/lib/pipeline/firstTouchSenderRole';
import { stripAccents } from '@/lib/identity/normalize';

/**
 * HERMES-TARGETING-R1 §14-§20 — un premier message n'est pas un mini-audit.
 *
 * ---------------------------------------------------------------------------
 * Ce qui partait réellement
 * ---------------------------------------------------------------------------
 * Deux messages, tels qu'envoyés en production, 384 et 397 caractères :
 *
 *   « … Une piste serait de distinguer les demandes liées à chaque prestation
 *     et à chaque parcours de contact. Cela aiderait à voir lesquels attirent
 *     les projets les plus pertinents localement. »
 *
 *   « … Une piste serait de tester une page dédiée à une seule prestation, puis
 *     de suivre quels contacts débouchent sur les demandes les plus
 *     pertinentes. »
 *
 * Ce sont des recommandations. Elles sont peut-être justes ; elles sont
 * certainement prématurées. Quelqu'un qui reçoit cela en DM ne lit pas une
 * question, il lit un diagnostic non demandé sur son entreprise, rédigé par
 * quelqu'un qu'il ne connaît pas. Le premier objectif d'un premier message est
 * qu'on ait envie d'y répondre (§15), et un audit gratuit ne le sert pas.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi ces règles sont ici et pas dans le prompt
 * ---------------------------------------------------------------------------
 * Le prompt les dit déjà — et les disait déjà avant, y compris « pas d'audit »
 * et « pas de jargon d'acquisition ». Les messages ci-dessus sont sortis quand
 * même. Une consigne de style se respecte en moyenne ; une règle se vérifie.
 * C'est le même raisonnement, mot pour mot, que celui de
 * `conversation/naturalness.ts` pour les RÉPONSES — et ce fichier lui emprunte
 * ses lexiques plutôt que d'en écrire une seconde copie (§21).
 *
 * ---------------------------------------------------------------------------
 * Ce que ce contrôle n'est pas
 * ---------------------------------------------------------------------------
 * Ce n'est pas une garde de sécurité. Le chiffre inventé, la promesse, la
 * fausse urgence, l'absence non vérifiée restent l'affaire de
 * `pipeline/guardrails.ts`, qui est ailleurs et le reste. Ici, tout parle de
 * FORME et d'INTENTION — trop long, deux questions, un conseil qu'on n'a pas
 * demandé. Les deux verdicts sont produits séparément ; c'est l'appelant qui
 * décide de refuser un message pour l'un ou pour l'autre.
 */

/**
 * La cible, en mots. Le message idéal tient dedans (§16).
 *
 * ---------------------------------------------------------------------------
 * Pourquoi 45 et non plus 35
 * ---------------------------------------------------------------------------
 * FIRST-TOUCH-NATURALNESS-TUNE-R1. Le gold set — cinq messages jugés SEND par
 * l'opérateur, c'est-à-dire la seule VOIX qu'une instance ait validée — fait
 * 43, 48, 49, 49 et 51 mots. La cible à 35 n'en couvrait aucun : le corpus
 * validé et la production n'avaient AUCUNE intersection, et le contrôle
 * enseignait donc l'inverse de ce que le gold set enseigne.
 *
 * Ce que ces mots achètent est nommé, et c'est un seul beat : la RÉACTION
 * personnelle entre l'observation et la question (« je connaissais mal le
 * principe », « je vois ça moins souvent »). Elle tient en cinq à huit mots, et
 * c'est elle qui sépare un message écrit par quelqu'un d'un message écrit par
 * un système. À 35 mots, observation + question saturaient déjà le budget, donc
 * la seule chose que le modèle pouvait couper était précisément celle-là.
 *
 * 45 n'est pas une permission d'écrire long : `FIRST_TOUCH_MAX_WORDS` n'a pas
 * bougé, et le message reste un DM lu sur un téléphone.
 */
export const FIRST_TOUCH_TARGET_WORDS = Object.freeze({ min: 15, max: 45 });

/**
 * Le plafond réellement opposable, plus haut que la cible.
 *
 * §16 accorde une « tolérance légèrement supérieure si vraie personnalisation
 * nécessaire », et un plafond posé à 35 rendrait cette phrase inapplicable :
 * toute observation un peu précise ferait basculer le message en refus. 48 mots
 * laisse la place d'une observation concrète et d'une question, et ferme
 * toujours la porte aux paragraphes de 60 mots que la production produisait.
 */
export const FIRST_TOUCH_MAX_WORDS = 48;

/** Sous ce seuil, ce n'est plus un message court, c'est un message vide. */
export const FIRST_TOUCH_MIN_WORDS = 8;

/**
 * Le plafond en caractères.
 *
 * Redondant avec les mots, et volontairement : un message de 40 mots très longs
 * reste un pavé à l'écran d'un téléphone, et c'est l'écran qui compte en DM.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi 300, et pourquoi ce n'est pas « un peu plus de marge »
 * ---------------------------------------------------------------------------
 * FIRST-TOUCH-NATURALNESS-TUNE-R1. À 260, ce plafond n'était pas redondant :
 * il DÉCIDAIT, en silence, et il décidait autre chose que ce que le plafond de
 * mots annonçait. Un DM français mesuré sur le gold set coûte entre 6,0 et 6,5
 * caractères par mot espaces comprises (278/43, 290/48, 297/49, 311/49,
 * 313/51). 260 caractères valaient donc ~42 mots — c'est-à-dire que le plafond
 * de mots à 48 était inatteignable, et que la « tolérance légèrement
 * supérieure » de §16 n'existait que sur le papier.
 *
 * 300 est le chiffre qui rend les deux plafonds D'ACCORD plutôt que
 * concurrents : 48 mots × ~6,2 ≈ 298. Ce qui borne un premier message reste
 * donc le nombre de mots, qui est ce qu'on a voulu borner ; le compte de
 * caractères redevient ce qu'il prétendait être, un garde-fou contre les mots
 * anormalement longs.
 */
export const FIRST_TOUCH_MAX_CHARS = 300;

/** Salutation + observation + question. Au-delà, c'est un paragraphe. */
export const FIRST_TOUCH_MAX_SENTENCES = 3;

export type FirstTouchCode =
  /** Plus long que ce qu'un premier message justifie. */
  | 'TOO_LONG'
  /** Si court qu'il n'y a rien à quoi répondre. */
  | 'TOO_SHORT'
  /** Plus de phrases qu'un DM n'en porte. */
  | 'TOO_MANY_SENTENCES'
  /** Deux questions : la personne doit choisir laquelle ignorer (§18). */
  | 'MULTIPLE_QUESTIONS'
  /** Aucune question : rien n'invite à répondre (§15). */
  | 'NO_QUESTION'
  /** Recommandation stratégique non demandée (§18). */
  | 'UNSOLICITED_ADVICE'
  /** Proposition de page dédiée / landing page (§18). */
  | 'LANDING_PAGE_ADVICE'
  /** Vocabulaire d'attribution, de funnel, de parcours (§18). */
  | 'ATTRIBUTION_JARGON'
  /** Offre gratuite ou paiement à la performance dans le premier message (§20). */
  | 'PERFORMANCE_OFFER'
  /** Proposition d'appel dès le premier message (§18). */
  | 'IMMEDIATE_CALL_CTA'
  /** Présentation complète de l'agence (§18). */
  | 'FULL_PITCH'
  /** Formule de plaquette. */
  | 'CORPORATE_JARGON'
  /** Plus d'un emoji. */
  | 'EMOJI_INFLATION'
  /** Tutoie et vouvoie dans le même message. */
  | 'ADDRESS_MODE_MIXED'
  /** Abréviation de français écrit rapide. */
  | 'TEXTISM'
  /** Registre familier surjoué. */
  | 'FORCED_SLANG'
  /** Prétend avoir observé quelque chose qui n'est dans aucun fait vérifié (§19). */
  | 'UNGROUNDED_OBSERVATION'
  /** Plus d'une observation : la personnalisation doit rester légère (§19). */
  | 'OVER_PERSONALIZED'
  /**
   * La QUESTION ferait passer l'expéditeur pour un client potentiel
   * (SENDER-ROLE-R1) : couverture, prérequis, éligibilité, prix, créneau,
   * déroulé d'intervention.
   */
  | 'BUYER_ROLE_QUESTION'
  /**
   * Le MESSAGE pose l'expéditeur en acheteur, sans même qu'une question s'en
   * charge : son véhicule, son domicile, son intention d'acheter.
   */
  | 'BUYER_ROLE_INTENT'
  /**
   * Une accroche ancrée existait et le message ne s'en sert pas
   * (PERSONALIZATION-FLOOR-R1). Ce n'est pas une faute de style : c'est un
   * message générique envoyé à quelqu'un dont on avait observé quelque chose.
   */
  | 'MISSING_GROUNDED_HOOK'
  /**
   * Le message reprend bien une observation, mais ne cite aucune ligne de
   * preuve : le texte reste vrai et le dépôt ne sait plus dire sur quoi.
   */
  | 'HOOK_NOT_CITED';

export type FirstTouchSeverity = 'BLOCKING' | 'WARNING';

export interface FirstTouchFinding {
  readonly code: FirstTouchCode;
  readonly severity: FirstTouchSeverity;
  readonly message: string;
  readonly excerpt: string | null;
}

export type FirstTouchVerdict = 'CONVERSATIONAL' | 'ACCEPTABLE' | 'OFF_TONE';

export interface FirstTouchMetrics {
  readonly chars: number;
  readonly words: number;
  readonly sentences: number;
  readonly questions: number;
  readonly emojis: number;
}

export interface FirstTouchReport {
  readonly verdict: FirstTouchVerdict;
  readonly findings: readonly FirstTouchFinding[];
  readonly metrics: FirstTouchMetrics;
}

export interface FirstTouchInput {
  readonly body: string;
  /**
   * Les faits VÉRIFIÉS que le message avait le droit d'utiliser.
   *
   * Vide, aucune observation n'est reprochée ni exigée : un message
   * volontairement générique (« vous cherchez encore à avoir plus de
   * demandes ? ») est parfaitement admissible, et c'est même ce que le prompt
   * demande quand rien n'a été observé.
   */
  readonly groundedFacts: readonly string[];
  /**
   * L'accroche ANCRÉE que le prompt a réellement montrée, s'il y en avait une.
   *
   * -------------------------------------------------------------------------
   * HERMES-FIRST-TOUCH-PERSONALIZATION-FLOOR-R1 — le plancher
   * -------------------------------------------------------------------------
   * Le rejeu du round précédent a montré que **5 candidats sur 18** repartaient
   * en générique — « simple curiosité : qu'est-ce qui vous a donné envie de
   * lancer WASH LH ? » — alors qu'une observation ancrée leur avait été donnée,
   * avec ses identifiants de preuve. Rien ne le refusait : `checkFirstTouch`
   * n'exige une observation nulle part, et c'est VOULU — un message
   * volontairement générique est licite quand rien n'a été observé.
   *
   * Ce champ dit la seule chose qui manquait : *quelque chose AVAIT été
   * observé*. Il ne dit pas quoi. Aucune liste blanche sémantique n'est
   * introduite : l'ancrage se juge exactement comme avant, par
   * `observationClaims` contre `groundedFacts`.
   *
   * Absent — le défaut — reproduit le comportement d'avant ce round au
   * caractère près : sans accroche annoncée, rien n'est exigé.
   */
  readonly hook?: FirstTouchHookState | null;
  /**
   * Le vocabulaire du MÉTIER, déclaré par l'opérateur dans sa niche.
   *
   * Il ne sert QU'au plancher de personnalisation, pour distinguer « ce
   * message reprend quelque chose qu'on a observé sur CETTE entreprise » de
   * « ce message nomme le métier de toute la cible ». Absent, le plancher
   * reste actif et simplement plus lâche — voir `floorHollowWords`.
   */
  readonly tradeTerms?: readonly string[];
}

/** Ce que le prompt a montré, et ce que le modèle en a cité. */
export interface FirstTouchHookState {
  /**
   * Une accroche portée par AU MOINS une ligne `prospect_evidence` existait.
   *
   * Une accroche venue de `prospect_angles` ne compte pas : elle ne porte
   * aucun identifiant, c'est un raisonnement et non une observation, et le
   * dépôt refuse depuis FIRST-TOUCH-NATURALNESS-TUNE-R1 qu'elle ancre quoi que
   * ce soit.
   */
  readonly available: boolean;
  /**
   * Les identifiants de preuve que le modèle a cités ET qui figuraient dans la
   * liste blanche. Déjà filtrés par l'appelant : un identifiant inventé n'est
   * jamais arrivé jusqu'ici.
   */
  readonly citedEvidenceIds: readonly string[];
}

// ---------------------------------------------------------------------------
// Lexiques — ce qui relève du CONSEIL, du JARGON et de l'OFFRE
// ---------------------------------------------------------------------------

/**
 * Les frontières de mot, écrites sans `\b` quand une lettre accentuée est en
 * jeu.
 *
 * `\b` se calcule sur `[A-Za-z0-9_]` : « é », « à » et « ç » n'en sont pas, si
 * bien que `\bça\b` ou `regardé\b` ne matchent JAMAIS — pas « rarement »,
 * jamais. Le défaut est silencieux, puisque la fonction rend simplement « rien
 * trouvé », une valeur parfaitement plausible. `conversation/naturalness.ts`
 * porte la même mise en garde, découverte de la même façon : par un test qui
 * échouait sans raison apparente.
 */
const START = "(?<![a-z0-9à-öø-ÿ'])";
const END = '(?![a-z0-9à-öø-ÿ])';

/**
 * Le conseil non demandé.
 *
 * Les motifs exigent tous une forme PRESCRIPTIVE — « une piste serait »,
 * « vous pourriez », « il faudrait » — et pas seulement un mot de stratégie.
 * C'est ce qui les empêche de mordre sur une question honnête (« vous cherchez
 * à développer ça ? »), qui parle du même sujet sans rien recommander.
 */
const ADVICE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['une piste serait', /\bune?\s+piste\s+(serait|possible|int[ée]ressante)/i],
  ['vous pourriez', /\bvous\s+pourriez\s+(tester|essayer|mettre|cr[ée]er|structurer|distinguer|suivre)/i],
  ['il faudrait', /\bil\s+(faudrait|suffirait)\s+(de|d'|que)/i],
  ['je vous conseille', /\bje\s+(vous\s+)?(conseille|recommande|sugg[èe]re)\b/i],
  ['ce qui aiderait', new RegExp(`${START}(cela|ça|ce)\\s+(aiderait|permettrait|vous\\s+permettrait)${END}`, 'i')],
  ['un moyen de', /\bun\s+(bon\s+)?moyen\s+(de|d')\s+\w+/i],
  ['première chose à faire', /\b(premi[èe]re|prochaine)\s+chose\s+[àa]\s+faire\b/i],
  ['ce que je ferais', /\bce\s+que\s+je\s+ferais\b/i],
  ['audit', /\b(audit|diagnostic|analyse)\s+(gratuit|de\s+votre|rapide|complet)/i],
  ['j’ai analysé', /\bj'ai\s+(analys[ée]|audit[ée]|[ée]tudi[ée]|pass[ée]\s+en\s+revue)\b/i],
];

/** La recommandation de page dédiée, nommée à part (§18, test 27). */
const LANDING_PAGE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['page dédiée', /\bpage\s+(d[ée]di[ée]e|d'atterrissage|de\s+capture|de\s+vente)/i],
  ['landing page', /\blanding\s?page\b/i],
  ['site dédié', /\b(site|mini[- ]site)\s+d[ée]di[ée]\b/i],
];

/**
 * Le vocabulaire de l'acquisition, adressé au PROSPECT.
 *
 * Il est légitime entre nous ; il ne l'est pas dans un premier DM à un artisan,
 * où il ne fait qu'établir que le message vient d'un système. Volontairement
 * restreint aux termes qui n'existent que dans ce champ — « demandes »,
 * « clients », « réseaux » n'y sont pas et ne doivent pas y être.
 */
const ATTRIBUTION_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['tunnel / funnel', /\b(tunnel\s+de\s+(conversion|vente)|funnel)\b/i],
  ['attribution', /\battribution\b/i],
  ['taux de conversion', /\btaux\s+de\s+(conversion|transformation|clic)\b/i],
  ['parcours de contact', /\bparcours\s+(de\s+contact|client|d'achat|utilisateur)\b/i],
  ['coût par lead', /\b(co[ûu]t\s+par\s+(lead|acquisition|contact)|cpl|cpa|cpc|cpm|ctr)\b/i],
  ['lead', /\bleads?\b/i],
  ['canal d’acquisition', /\b(canal|canaux|levier|leviers)\s+d'acquisition\b/i],
  ['stratégie d’acquisition', /\bstrat[ée]gie\s+(d'acquisition|marketing|digitale)\b/i],
  ['retargeting / ciblage', /\b(retargeting|remarketing|pixel|ciblage\s+publicitaire)\b/i],
  ['scaler', /\b(scaler|scaling|disruptif|synergie)\b/i],
  ['KPI', /\b(kpi|roas|ltv|panier\s+moyen)\b/i],
];

/**
 * L'offre commerciale, interdite au premier message (§20).
 *
 * « Conversation / Learning décideront plus tard quand l'offre est suffisamment
 * mûre » : la question n'est pas de savoir si l'offre est bonne, mais si c'est
 * le moment. Ce n'est jamais le premier message.
 */
const OFFER_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['travail gratuit', /\b(gratuitement|sans\s+frais|c'est\s+gratuit|offert\s+et\s+sans)\b/i],
  [
    'paiement aux résultats',
    new RegExp(
      `${START}(pay[ée]s?\\s+(uniquement\\s+)?(aux?|sur)\\s+(r[ée]sultats?|performance)` +
        `|[àa]\\s+la\\s+performance|au\\s+r[ée]sultat)${END}`,
      'i',
    ),
  ],
  ['vous ne payez rien', /\bvous\s+ne\s+payez\s+(rien|que\s+si)/i],
  ['sans engagement', /\bsans\s+(engagement|risque)\b/i],
  ['commission', /\bcommission\s+(sur|uniquement)\b/i],
];

/** La proposition d'échange, dans NOTRE texte. Reprise de §17 de R1.1. */
const CALL_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['appel', /\b(s'appeler|un\s+appel|se\s+parler|par\s+t[ée]l[ée]phone|de\s+vive\s+voix)\b/i],
  ['créneau', /\b(quinze\s+minutes|15\s+minutes|un\s+cr[ée]neau|vous\s+[êe]tes\s+dispo|on\s+se\s+cale|prendre\s+rendez[- ]vous\s+avec\s+(moi|nous))\b/i],
  ['visio', /\b(visio|un\s+call|un\s+z(oo|)m)\b/i],
];

/** La présentation complète de l'agence. */
const PITCH_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['on aide / nous accompagnons', /\b(on\s+aide|nous\s+aidons|on\s+accompagne|nous\s+accompagnons)\s+(les|des|nos)\b/i],
  ['notre agence', /\b(notre|mon)\s+(agence|structure|soci[ée]t[ée])\s+(est|fait|propose|s'occupe)/i],
  ['on met en place', /\b(on\s+met\s+en\s+place|nous\s+mettons\s+en\s+place|on\s+s'occupe\s+de)\b/i],
  ['notre solution', /\bnotre\s+(solution|dispositif|offre|m[ée]thode)\b/i],
];

const CORPORATE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['sur-mesure', /\b(sur[- ]mesure|cl[ée]s?\s+en\s+main)\b/i],
  ['valeur ajoutée', /\bvaleur\s+ajout[ée]e\b/i],
  ['accompagnement personnalisé', /\baccompagnement\s+personnalis[ée]\b/i],
  ['prise de contact', /\bprise\s+de\s+contact\b/i],
  ['seriez-vous disponible', /\bseriez[- ]vous\s+disponible\b/i],
  ['dans le cadre de notre', /\bdans\s+le\s+cadre\s+de\s+(notre|nos)\b/i],
  ['n’hésitez pas', /\bn'h[ée]sitez\s+pas\s+[àa]\b/i],
];

// ---------------------------------------------------------------------------
// L'observation : ce que le message prétend avoir vu
// ---------------------------------------------------------------------------

/**
 * Les tournures par lesquelles NOTRE message affirme avoir observé quelque
 * chose.
 *
 * Aucun groupe capturant : ce sont des BORNES, pas des extracteurs. La suite
 * est découpée par `observationClaims`, qui a besoin de connaître TOUTES les
 * tournures d'une phrase et pas seulement celle qui l'ouvre — voir plus bas.
 */
/**
 * La tournure à la DEUXIÈME personne, isolée des autres.
 *
 * Elle est la seule AMBIGUË de la liste. « J'ai vu », « j'ai regardé », « je
 * suis tombé sur » sont des assertions à la première personne : elles affirment
 * toujours, elles ne demandent jamais. « Vous faites » affirme dans « j'ai vu
 * que vous faites du portrait en lumière naturelle » et DEMANDE dans « vous faites comment
 * pour avoir de nouveaux clients ? ».
 *
 * Elle reste dans `OBSERVATION_TRIGGERS` — donc elle borne et elle est retirée
 * des clauses exactement comme avant. Ce qui la distingue est ailleurs : voir
 * `addressesAQuestion`, qui l'empêche seule d'OUVRIR une affirmation.
 */
const SECOND_PERSON_TRIGGER =
  /\bvous\s+(?:proposez|faites|faisiez|mettez\s+en\s+avant|avez\s+mis\s+en\s+place)\b/gi;

const OBSERVATION_TRIGGERS: readonly RegExp[] = [
  /\bj'ai\s+vu\s+que\b/gi,
  /\bj'ai\s+vu\s+(?=votre|vos|le\b|la\b|les\b)/gi,
  // « j'ai regardé », et non « je ai regardé » : l'élision est la seule forme
  // qui existe en français, et un motif qui l'oublie ne matche jamais rien.
  new RegExp(`\\bj'ai\\s+(?:regard[ée]|remarqu[ée]|aper[çc]u|not[ée])${END}`, 'gi'),
  /\bje\s+(?:suis\s+tomb[ée]\s+sur|regardais)\b/gi,
  SECOND_PERSON_TRIGGER,
];

/**
 * Le mot interrogatif lui-même.
 *
 * `où` y est, `ou` n'y est PAS, et la différence est un accent. Elle tient
 * parce que `normalizeForMatching` ne touche pas aux accents (c'est écrit dans
 * son en-tête, et c'est délibéré). Les écraser ferait de « vous faites du
 * reportage ou du cadrage » une question, donc perdrait une observation
 * vraie — l'exact contraire de ce que ce correctif doit faire.
 */
const INTERROGATIVE_WORD = "(?:comment|combien|pourquoi|quand|où|quoi|qu'est-ce|quel|quelle|quels|quelles)";

/** Le mot interrogatif COLLÉ devant la tournure : « comment vous faites … ». */
const INTERROGATIVE_BEFORE = new RegExp(`(?:^|[^\\p{L}])${INTERROGATIVE_WORD}[\\s,]+$`, 'iu');

/** Le mot interrogatif COLLÉ derrière : « vous faites comment … ». */
const INTERROGATIVE_AFTER = new RegExp(`^[\\s,]*${INTERROGATIVE_WORD}(?![\\p{L}])`, 'iu');

/**
 * Cette occurrence de « vous <verbe> » DEMANDE-t-elle, au lieu d'affirmer ?
 *
 * ---------------------------------------------------------------------------
 * Ce qu'elle regarde, et ce qu'elle refuse de regarder
 * ---------------------------------------------------------------------------
 * Uniquement le mot interrogatif ADJACENT, des deux côtés. Les deux seules
 * formes que le corpus produit réellement sont « vous faites **comment** pour
 * … ? » et « **comment** vous faites pour … ? » — mesurées sur les 420 messages
 * déjà écrits.
 *
 * Elle ne regarde PAS si la phrase se termine par « ? », et c'est le point
 * important. « J'ai vu que vous faites du portrait en lumière naturelle, ça tourne bien ? »
 * est une phrase interrogative qui contient une observation parfaitement
 * factuelle, et qui doit rester ancrée. Prendre le « ? » de la phrase pour
 * preuve aurait fait disparaître une garde réelle sous couvert d'en réparer une
 * fausse.
 *
 * Pure, et strictement PLUS ÉTROITE que ce qui existait : elle ne peut que
 * retirer des affirmations, jamais en ajouter.
 */
function addressesAQuestion(sentence: string, start: number, end: number): boolean {
  return INTERROGATIVE_BEFORE.test(sentence.slice(0, start)) || INTERROGATIVE_AFTER.test(sentence.slice(end));
}

/**
 * Les mots trop communs pour prouver qu'une observation vient d'un fait.
 *
 * Reprend l'intention de `personalizationLevel` (`guardrails.ts`) : sans cette
 * liste, « vos prestations » suffirait à faire passer n'importe quelle
 * affirmation pour ancrée, puisque « prestations » figure dans presque toutes
 * les lignes de preuve.
 */
const HOLLOW_WORDS: ReadonlySet<string> = new Set([
  'prestation', 'prestations', 'service', 'services', 'client', 'clients', 'entreprise',
  'societe', 'activite', 'travail', 'travaux', 'realisation', 'realisations', 'voiture',
  'voitures', 'vehicule', 'vehicules', 'chose', 'choses', 'possibilite', 'plusieurs',
  'differentes', 'differents', 'notamment', 'egalement', 'vraiment', 'quelque', 'quelques',
  'aujourd', 'actuellement', 'regulierement', 'directement', 'facilement', 'assez',
  'pratique', 'interessant', 'interessante', 'surtout', 'encore', 'depuis',
  'votre', 'vos', 'vous', 'nous', 'avec', 'pour', 'dans', 'leur', 'plus', 'sont', 'cette',
]);

function contentWords(text: string): Set<string> {
  const words = stripAccents(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word.length >= 5 && !HOLLOW_WORDS.has(word));
  return new Set(words);
}

/**
 * Les mots que le PLANCHER de personnalisation ne compte pas.
 *
 * `HOLLOW_WORDS` plus le vocabulaire du MÉTIER. Le nom d'un métier décrit
 * l'activité de TOUTE la cible : le partager avec une ligne de preuve ne
 * prouve pas qu'on a regardé cette entreprise-là. C'est le même raisonnement
 * que `GENERIC_SERVICE_TERMS` (`firstTouchPersonalization.ts`), et c'est
 * mesuré : sans cette liste, « qu'est-ce qui vous a donné envie de vous lancer
 * dans ce métier ? » — un message parfaitement générique — satisfait le
 * plancher grâce au seul nom du métier.
 *
 * ---------------------------------------------------------------------------
 * Le vocabulaire du métier n'est PAS écrit ici
 * ---------------------------------------------------------------------------
 * Hermes ne sait rien d'un métier tant qu'un opérateur ne le lui a pas déclaré
 * (`AGENTS.md` : « aucun vocabulaire de niche en dur »). Les termes viennent
 * donc de `config/niches/<votre-niche>.json` — `serviceTerms` et
 * `coreActivityTerms` — et l'appelant les passe.
 *
 * Sans eux, le plancher retombe sur `HOLLOW_WORDS` seul : il exige toujours un
 * mot PARTAGÉ avec un fait vérifié, mais il ne peut pas savoir lequel de ces
 * mots est le nom du métier. C'est une borne plus LÂCHE, pas une borne
 * absente — et la façon de la resserrer est de décrire sa niche, ce qui est
 * exactement ce que cette édition demande partout ailleurs.
 *
 * Cette liste est PROPRE au plancher. `HOLLOW_WORDS` n'est pas touché :
 * l'élargir déplacerait la frontière d'`observationClaims`, dont la régression
 * est gelée forme par forme depuis FIRST-TOUCH-NATURALNESS-TUNE-R1.
 */
function floorHollowWords(tradeTerms: readonly string[]): ReadonlySet<string> {
  const words = new Set(HOLLOW_WORDS);
  for (const term of tradeTerms) {
    for (const word of stripAccents(term).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')) {
      // Le seuil de `contentWords` : en dessous, le mot ne compte de toute
      // façon pas, et l'ajouter ne dirait rien.
      if (word.length >= 5) words.add(word);
    }
  }
  return words;
}

/**
 * Les mots distinctifs que le message PARTAGE avec les faits vérifiés.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi ce n'est pas `observationClaims`
 * ---------------------------------------------------------------------------
 * Le plancher a d'abord été bâti dessus, et il rendait CINQ faux refus sur 24
 * au premier rejeu. La raison est structurelle : `observationClaims` reconnaît
 * un jeu ÉTROIT de tournures d'ouverture (« j'ai vu que », « je suis tombé
 * sur »), et cette étroitesse est voulue — pour DÉTECTER une prétention à
 * sourcer, en rater une est sans danger.
 *
 * Le plancher inverse ce sens de lecture : il demande « une observation
 * a-t-elle été reprise ? », et là une tournure ratée devient un refus. « J'ai vu
 * SUR VOTRE SITE que vous travaillez avec les particuliers » et « votre site
 * mentionne des prestations pour les particuliers » reprennent l'observation
 * mot pour mot et ne portent aucune tournure connue.
 *
 * Le signal juste est donc le VOCABULAIRE PARTAGÉ, indépendant de la façon dont
 * la phrase s'ouvre — exactement ce que `personalizationLevel`
 * (`guardrails.ts`) mesure depuis toujours pour dire à quel point un message
 * est bâti sur ce qu'on a observé. Ici on n'a besoin que de la question la plus
 * simple : partage-t-il au moins UN mot ?
 *
 * Exportée pour qu'un test montre CE QUI a été reconnu plutôt que de le déduire
 * d'un verdict.
 */
export function sharedGroundedWords(
  body: string,
  groundedFacts: readonly string[],
  tradeTerms: readonly string[] = [],
): readonly string[] {
  const hollow = floorHollowWords(tradeTerms);
  const inBody = new Set([...contentWords(body)].filter((word) => !hollow.has(word)));
  const shared = new Set<string>();
  for (const fact of groundedFacts) {
    for (const word of contentWords(fact)) {
      if (hollow.has(word)) continue;
      if (inBody.has(word)) shared.add(word);
    }
  }
  return Object.freeze([...shared]);
}

export interface ObservationClaim {
  readonly clause: string;
  readonly grounded: boolean;
}

/**
 * Les affirmations d'observation du message, et leur ancrage.
 *
 * ---------------------------------------------------------------------------
 * Une phrase, une affirmation
 * ---------------------------------------------------------------------------
 * Le découpage se fait par PHRASE, et pas par tournure, parce que les tournures
 * se chevauchent : « j'ai vu que vous faisiez du prestation standard intérieur » en
 * contient deux, et les compter séparément ferait d'une seule observation deux
 * affirmations — dont l'une, réduite au mot « vous », ne dirait rien.
 *
 * Dans chaque phrase, la première tournure ouvre l'affirmation ; les suivantes
 * sont RETIRÉES du texte plutôt que de le tronquer. Retirer plutôt que tronquer
 * a une conséquence précise et voulue : le vocabulaire de la tournure elle-même
 * (« regardé », « vu », « tombé ») ne compte pas comme contenu observé, alors
 * que son OBJET, lui, reste dans la clause et doit être ancré.
 *
 * ---------------------------------------------------------------------------
 * Ce qu'une clause sans mot distinctif vaut
 * ---------------------------------------------------------------------------
 * Elle est traitée comme ancrée. « J'ai vu votre travail » n'affirme rien de
 * vérifiable, donc rien qui puisse être faux. Le seuil d'ancrage est bas dans
 * l'autre sens aussi — UN mot distinctif partagé suffit — parce qu'un message
 * naturel reformule au lieu de recopier la ligne de preuve, et qu'exiger
 * davantage pousserait à écrire moins bien pour paraître plus honnête.
 */
export function observationClaims(
  body: string,
  groundedFacts: readonly string[],
): readonly ObservationClaim[] {
  const factWords = new Set<string>();
  for (const fact of groundedFacts) for (const word of contentWords(fact)) factWords.add(word);

  // Le MÊME piège que celui qui a produit `conversation/text.ts` : un clavier
  // réel écrit « j’ai », un lexique de code écrit « j'ai », et sans
  // normalisation la détection marcherait sur les fixtures et échouerait en
  // silence sur les vrais messages — donc exactement à l'envers.
  const text = normalizeForMatching(body);
  const claims: ObservationClaim[] = [];

  for (const sentence of text.split(/[.!?\n]+/u)) {
    let firstEnd = -1;
    let firstIndex = Number.POSITIVE_INFINITY;
    for (const trigger of OBSERVATION_TRIGGERS) {
      const scan = new RegExp(trigger.source, trigger.flags);
      // Toutes les occurrences, et non la première : la tournure à la deuxième
      // personne peut DEMANDER une fois puis AFFIRMER ensuite dans la même
      // phrase, et s'arrêter à la première ferait perdre la seconde.
      for (const match of sentence.matchAll(scan)) {
        const start = match.index;
        const end = start + match[0].length;
        // Une QUESTION n'ouvre pas une affirmation. La garde ne vaut que pour
        // la tournure ambiguë : les autres sont à la première personne et
        // affirment toujours.
        if (trigger === SECOND_PERSON_TRIGGER && addressesAQuestion(sentence, start, end)) continue;
        if (start < firstIndex) {
          firstIndex = start;
          firstEnd = end;
        }
        break;
      }
    }
    if (firstEnd < 0) continue;

    let clause = sentence.slice(firstEnd);
    for (const trigger of OBSERVATION_TRIGGERS) {
      clause = clause.replace(new RegExp(trigger.source, trigger.flags), ' ');
    }
    clause = clause.trim();

    const words = contentWords(clause);
    const grounded = words.size === 0 || [...words].some((word) => factWords.has(word));
    claims.push(Object.freeze({ clause, grounded }));
  }

  return Object.freeze(claims);
}

// ---------------------------------------------------------------------------
// Le contrôle
// ---------------------------------------------------------------------------

function excerptOf(text: string, max = 60): string {
  const flat = text.trim().replace(/\s+/gu, ' ');
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/**
 * Relit un premier message et dit ce qui, dedans, ne ressemble pas à une
 * ouverture de conversation.
 *
 * Fonction pure. Ne lève jamais — un corps vide rend un rapport, pas une
 * exception.
 */
export function checkFirstTouch(input: FirstTouchInput): FirstTouchReport {
  const body = input.body.trim();
  const normalized = normalizeForMatching(body);
  const metrics: FirstTouchMetrics = Object.freeze({
    chars: body.length,
    words: countWords(body),
    sentences: countSentences(body),
    questions: (body.match(/\?/g) ?? []).length,
    emojis: countEmojis(body),
  });

  const findings: FirstTouchFinding[] = [];
  const add = (
    code: FirstTouchCode,
    severity: FirstTouchSeverity,
    message: string,
    excerpt: string | null = null,
  ): void => {
    findings.push(Object.freeze({ code, severity, message, excerpt }));
  };

  const first = (
    entries: ReadonlyArray<readonly [string, RegExp]>,
  ): readonly [string, RegExpMatchArray] | null => {
    for (const entry of entries) {
      const match = normalized.match(entry[1]);
      if (match) return [entry[0], match] as const;
    }
    return null;
  };

  if (body.length === 0) {
    add('TOO_SHORT', 'BLOCKING', 'message vide');
    return Object.freeze({ verdict: 'OFF_TONE', findings: Object.freeze(findings), metrics });
  }

  // --- longueur (§16) ----------------------------------------------------
  if (metrics.words > FIRST_TOUCH_MAX_WORDS) {
    add(
      'TOO_LONG',
      'BLOCKING',
      `${String(metrics.words)} mots — un premier message vise ${String(FIRST_TOUCH_TARGET_WORDS.min)}–${String(FIRST_TOUCH_TARGET_WORDS.max)}`,
    );
  } else if (metrics.words > FIRST_TOUCH_TARGET_WORDS.max) {
    add(
      'TOO_LONG',
      'WARNING',
      `${String(metrics.words)} mots — au-dessus de la cible, admissible seulement si la personnalisation l’exige`,
    );
  }
  if (metrics.chars > FIRST_TOUCH_MAX_CHARS) {
    add('TOO_LONG', 'BLOCKING', `${String(metrics.chars)} caractères — un DM se lit sur un téléphone`);
  }
  if (metrics.words < FIRST_TOUCH_MIN_WORDS) {
    add('TOO_SHORT', 'BLOCKING', `${String(metrics.words)} mots — il n’y a rien à quoi répondre`);
  }
  if (metrics.sentences > FIRST_TOUCH_MAX_SENTENCES) {
    add(
      'TOO_MANY_SENTENCES',
      'BLOCKING',
      `${String(metrics.sentences)} phrases — une ou deux suffisent, la troisième est déjà de trop`,
    );
  }

  // --- une seule question (§16, §18) -------------------------------------
  if (metrics.questions > 1) {
    add(
      'MULTIPLE_QUESTIONS',
      'BLOCKING',
      `${String(metrics.questions)} questions — la personne devrait choisir laquelle ignorer`,
    );
  } else if (metrics.questions === 0) {
    add('NO_QUESTION', 'BLOCKING', 'aucune question — rien n’invite à répondre, et une réponse est le but');
  }

  // --- l'audit non demandé (§18) -----------------------------------------
  const advice = first(ADVICE_PATTERNS);
  if (advice !== null) {
    add('UNSOLICITED_ADVICE', 'BLOCKING', `recommandation non demandée : « ${advice[0]} »`, advice[1][0]);
  }
  const landing = first(LANDING_PAGE_PATTERNS);
  if (landing !== null) {
    add(
      'LANDING_PAGE_ADVICE',
      'BLOCKING',
      `propose une page dédiée dès le premier message : « ${landing[0]} »`,
      landing[1][0],
    );
  }
  const jargon = first(ATTRIBUTION_PATTERNS);
  if (jargon !== null) {
    add('ATTRIBUTION_JARGON', 'BLOCKING', `vocabulaire d’acquisition : « ${jargon[0]} »`, jargon[1][0]);
  }

  // --- l'offre, trop tôt (§20) -------------------------------------------
  const offer = first(OFFER_PATTERNS);
  if (offer !== null) {
    add(
      'PERFORMANCE_OFFER',
      'BLOCKING',
      `l’offre n’a pas sa place au premier message : « ${offer[0]} »`,
      offer[1][0],
    );
  }

  // --- l'appel, trop tôt (§18) -------------------------------------------
  const call = first(CALL_PATTERNS);
  if (call !== null) {
    add('IMMEDIATE_CALL_CTA', 'BLOCKING', `propose un échange avant toute réponse : « ${call[0]} »`, call[1][0]);
  }

  // --- le pitch complet (§18) --------------------------------------------
  const pitch = first(PITCH_PATTERNS);
  if (pitch !== null) {
    add('FULL_PITCH', 'BLOCKING', `présentation de l’agence : « ${pitch[0]} »`, pitch[1][0]);
  }
  const corporate = first(CORPORATE_PATTERNS);
  if (corporate !== null) {
    add('CORPORATE_JARGON', 'BLOCKING', `formule de plaquette : « ${corporate[0]} »`, corporate[1][0]);
  }

  // --- emojis (§27, test 35) ---------------------------------------------
  if (metrics.emojis > 1) {
    add('EMOJI_INFLATION', 'BLOCKING', `${String(metrics.emojis)} emojis dans un premier message`);
  }

  // --- tu / vous (§17) ---------------------------------------------------
  // Le choix entre les deux appartient au message ; ce qui est fautif est de
  // faire les deux. Un premier message n'a personne à imiter — il n'y a pas
  // encore eu de réponse — donc rien ici ne compare à un profil.
  const address = countAddressMarkers(body);
  if (address.tu > 0 && address.vous > 0) {
    add(
      'ADDRESS_MODE_MIXED',
      'BLOCKING',
      `tutoiement et vouvoiement dans le même message (${String(address.tu)} / ${String(address.vous)})`,
    );
  }

  // --- registre (§17) ----------------------------------------------------
  const textism = containsTextism(body);
  if (textism !== null) add('TEXTISM', 'BLOCKING', `abréviation de message rapide : « ${textism} »`, textism);
  const slang = containsForcedSlang(body);
  if (slang !== null) add('FORCED_SLANG', 'BLOCKING', `registre familier surjoué : « ${slang} »`, slang);

  // --- personnalisation (§19) --------------------------------------------
  const claims = observationClaims(body, input.groundedFacts);
  const ungrounded = claims.filter((claim) => !claim.grounded);
  if (ungrounded.length > 0) {
    const clause = ungrounded[0]?.clause ?? '';
    add(
      'UNGROUNDED_OBSERVATION',
      'BLOCKING',
      'affirme avoir observé quelque chose qu’aucun fait vérifié ne porte',
      excerptOf(clause),
    );
  }
  if (claims.length > 1) {
    add(
      'OVER_PERSONALIZED',
      'WARNING',
      `${String(claims.length)} observations — §19 demande une personnalisation légère, une seule suffit`,
    );
  }

  // --- le PLANCHER de personnalisation (FLOOR-R1) ------------------------
  //
  // Deux constats, et ils ne disent pas la même chose. Le premier dit « ce
  // message est générique alors qu'on avait quelque chose à dire » ; le second
  // dit « ce message est personnalisé et on ne sait plus sur quoi ». Le
  // second ne peut se déclencher que si le premier ne l'a pas fait, sinon un
  // message générique récolterait les deux et le rapport dirait deux fois la
  // même chose.
  //
  // Le seuil est le plus bas qui ait un sens : UNE observation ancrée. Rien
  // n'exige qu'elle reprenne l'accroche RETENUE plutôt qu'un autre fait
  // vérifié — `groundedFacts` porte le contexte métier autant que l'accroche,
  // et une ouverture sur « vous mettez en avant le reportage en intérieur » est
  // une personnalisation aussi réelle que celle qu'on avait suggérée.
  const hook = input.hook ?? null;
  if (hook !== null && hook.available) {
    const shared = sharedGroundedWords(body, input.groundedFacts, input.tradeTerms ?? []);
    if (shared.length === 0) {
      add(
        'MISSING_GROUNDED_HOOK',
        'BLOCKING',
        'une observation vérifiée était disponible et le message n’en reprend rien — ' +
          'un premier message générique envoyé à quelqu’un qu’on a regardé est une occasion perdue',
      );
    } else if (hook.citedEvidenceIds.length === 0) {
      add(
        'HOOK_NOT_CITED',
        'BLOCKING',
        'le message reprend une observation mais ne cite aucune ligne de preuve — ' +
          'la provenance ne se reconstitue pas après coup',
        excerptOf(shared.join(', ')),
      );
    }
  }

  // --- le RÔLE de l'expéditeur (SENDER-ROLE-R1) --------------------------
  // Placé APRÈS la personnalisation, et c'est l'ordre qui compte pour la
  // lecture : les constats précédents disent « ce message est mal écrit »,
  // celui-ci dit « ce message est bien écrit et se fait passer pour quelqu'un
  // d'autre ». Ce sont deux natures de défaut, et les mélanger dans le rapport
  // ferait lire le second comme une faute de style de plus.
  for (const buyer of detectBuyerRole(body)) {
    const code: FirstTouchCode =
      buyer.scope === 'QUESTION' ? 'BUYER_ROLE_QUESTION' : 'BUYER_ROLE_INTENT';
    add(code, 'BLOCKING', describeBuyerRole(buyer), buyer.excerpt);
  }

  const blocking = findings.some((finding) => finding.severity === 'BLOCKING');
  const verdict: FirstTouchVerdict = blocking
    ? 'OFF_TONE'
    : findings.length > 0
      ? 'ACCEPTABLE'
      : 'CONVERSATIONAL';

  return Object.freeze({ verdict, findings: Object.freeze(findings), metrics });
}

/**
 * Ce qu'un constat de rôle reproche, dit en français plutôt qu'en code.
 *
 * Le message est LU par le modèle à la reprise : il doit donc nommer la faute
 * ET l'espace de sortie, sinon la seule correction évidente est de retirer la
 * question — c'est-à-dire de produire un message sans rien à quoi répondre.
 */
function describeBuyerRole(buyer: BuyerRoleFinding): string {
  const why: Record<BuyerRoleFinding['family'], string> = {
    PREREQUISITE: 'demande ce qu’il faudrait réunir pour une prestation',
    COVERAGE: 'vérifie s’ils se déplacent jusqu’à un endroit donné',
    ELIGIBILITY: 'vérifie si une prestation serait acceptée',
    PRICE_QUOTE: 'demande un prix ou un devis',
    AVAILABILITY: 'demande un créneau, un délai ou une réservation',
    JOB_LOGISTICS: 'demande comment se déroulerait une intervention',
    OWN_PROPERTY: 'parle d’un véhicule ou d’un domicile qui serait le tien',
    PURCHASE_INTENT: 'annonce une intention d’acheter la prestation',
  };
  return (
    `${why[buyer.family]} (« ${buyer.label} ») — lu à froid, ça fait de toi un client ` +
    'potentiel, ce que tu n’es pas. Pose une question sur l’ENTREPRISE elle-même ' +
    '(son fonctionnement, son histoire, sa clientèle, le type de travail qu’elle fait).'
  );
}

/** Les constats bloquants, rendus au modèle pour qu'il réécrive (une seule fois). */
export function renderFirstTouchCorrections(report: FirstTouchReport): string {
  const blocking = report.findings.filter((finding) => finding.severity === 'BLOCKING');
  const lines = ['CE QUI N’ALLAIT PAS DANS TA PREMIÈRE VERSION — réécris en corrigeant'];
  for (const finding of blocking) lines.push(`- ${finding.code} : ${finding.message}`);
  if (blocking.some((finding) => finding.code === 'MISSING_GROUNDED_HOOK')) {
    lines.push(
      '- OUVRE sur le détail vérifié qu’on t’a donné. Ne pars pas en « simple curiosité » : ' +
        'c’est ce détail qui fait que ce message ne pouvait être écrit qu’à eux.',
    );
  }
  if (blocking.some((finding) => finding.code === 'HOOK_NOT_CITED')) {
    lines.push('- cite les identifiants du détail repris dans `used_evidence_ids`.');
  }
  lines.push(
    `- vise ${String(FIRST_TOUCH_TARGET_WORDS.min)}–${String(FIRST_TOUCH_TARGET_WORDS.max)} mots, ` +
      'une ou deux phrases, une seule question.',
  );
  return lines.join('\n');
}
