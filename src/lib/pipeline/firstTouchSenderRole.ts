/**
 * HERMES-FIRST-TOUCH-SENDER-ROLE-R1 — qui le message laisse-t-il croire que
 * j'étais ?
 *
 * ---------------------------------------------------------------------------
 * Ce qui partait réellement
 * ---------------------------------------------------------------------------
 * Les trois manifestes verrouillés le 25 août 2026 à 18:42, tous les trois
 * `CONVERSATIONAL` pour `checkFirstTouch`, tous les trois irréprochables sur
 * l'ancrage, la longueur, le ton et l'absence de pitch :
 *
 *   @wash.lh        « … Il faut prévoir un accès à l'eau sur place ? »
 *   @laveautocaen   « … Les professionnels peuvent aussi vous confier un seul véhicule ? »
 *   @caautodetail_  « … Vous vous déplacez dans quelles communes en général ? »
 *
 * Lues à froid, sans le contexte que le destinataire n'a pas, ces trois
 * questions disent la même chose : *je songe à faire nettoyer quelque chose et
 * je vérifie si vous pouvez le faire.* C'est faux. L'expéditeur ne veut pas de
 * prestation, et l'entreprise qui répondra « oui, je me déplace jusqu'à Caen,
 * vous êtes où ? » aura répondu à quelqu'un qui n'existe pas.
 *
 * Ce n'est pas un défaut de style, et c'est ce qui le rend différent de tous
 * ceux que `firstTouchStyle.ts` attrape : le message est naturel, court, ancré
 * et sans jargon. Ce qui ne va pas est le RÔLE qu'il fait porter à celui qui
 * l'écrit.
 *
 * ---------------------------------------------------------------------------
 * L'espace visé, et ses deux bords
 * ---------------------------------------------------------------------------
 *   curieux de l'ENTREPRISE     ← ce qu'on veut
 *   curieux en tant que CLIENT  ← ce que ce module refuse
 *   interrogatoire commercial   ← ce que le prompt refuse (et pas ce module)
 *
 * Le second bord n'est PAS ici, et c'est délibéré : « aujourd'hui vos nouveaux
 * clients viennent surtout des recommandations ? » est une question de
 * qualification, pas une question de client, et le gold set — la seule voix que
 * ce dépôt ait validée — la porte dans trois de ses cinq messages. En faire une
 * règle rendrait le corpus de référence illégal contre lui-même. Elle reste
 * donc une STRATÉGIE, écrite là où vivent les stratégies : dans le prompt.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce module regarde, et où
 * ---------------------------------------------------------------------------
 * Deux portées, et la différence compte.
 *
 * Les familles de PRESTATION (prérequis, couverture, éligibilité, prix,
 * disponibilité, logistique) ne sont lues que dans les portions
 * INTERROGATIVES. La raison est mesurable : « j'ai vu que vous intervenez
 * jusqu'à Caen » est une observation ancrée, parfaitement licite, et la même
 * suite de mots posée en question — « vous intervenez jusqu'où ? » — est une
 * vérification de couverture. Lire le message entier confondrait les deux et
 * ferait refuser la moitié des observations vraies.
 *
 * Les familles de PERSONNE (mon véhicule, mon intention d'acheter) sont lues
 * sur le message ENTIER, parce qu'elles n'ont pas besoin d'une question pour
 * poser le rôle : « je cherche quelqu'un pour ma voiture » l'a déjà posé.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi du code, et pas seulement une consigne
 * ---------------------------------------------------------------------------
 * Le prompt de 0fec132 disait déjà « pose une question légère sur leur
 * activité », et il AUTORISAIT explicitement « leur zone d'intervention ». Les
 * trois messages ci-dessus sont sortis en faisant exactement ce qu'on leur
 * demandait. La consigne change donc aussi — mais une consigne se respecte en
 * moyenne, et une règle se vérifie. C'est le raisonnement de
 * `firstTouchStyle.ts`, et il vaut ici pour la même raison.
 *
 * Ce que ce module N'EST PAS : une exigence POSITIVE. Il ne demande à aucun
 * moment qu'une question porte un marqueur d'histoire, de mixte ou de choix —
 * « d'autres questions peu engageantes sur l'entreprise elle-même » est une
 * famille ouverte, et la refermer par une liste blanche produirait exactement
 * le gabarit que R6A a mis un round à retirer. Il refuse ce qui est reconnu,
 * jamais ce qui n'est pas reconnu.
 *
 * Fonction PURE. Elle ne reçoit qu'un texte : ni prospect, ni compte, ni
 * campagne, ni configuration, ni coquille — il n'existe donc aucune donnée
 * depuis laquelle une exception pourrait être écrite.
 */

import { normalizeForMatching } from '@/lib/conversation/text';

/**
 * Les bornes de mot, écrites sans `\b` quand une lettre accentuée est en jeu.
 *
 * Même mise en garde que `firstTouchStyle.ts` et `conversation/naturalness.ts` :
 * `\b` se calcule sur `[A-Za-z0-9_]`, donc `\bça\b` ne matche jamais. Le défaut
 * est silencieux, puisque la fonction rend « rien trouvé », une valeur
 * parfaitement plausible.
 */
const START = "(?<![a-z0-9à-öø-ÿ'])";
const END = '(?![a-z0-9à-öø-ÿ])';

/** La famille à laquelle appartient un constat — nommée, jamais devinée. */
export type BuyerRoleFamily =
  /** Ce qu'il faut réunir AVANT une prestation : accès, place, matériel. */
  | 'PREREQUISITE'
  /** « Venez-vous jusqu'à moi ? » — la vérification de couverture. */
  | 'COVERAGE'
  /** « Est-ce que vous prenez aussi ceci ? » — la vérification d'éligibilité. */
  | 'ELIGIBILITY'
  /** Le prix, le tarif, le devis. */
  | 'PRICE_QUOTE'
  /** Le créneau, le délai, la réservation. */
  | 'AVAILABILITY'
  /** Le déroulé d'une intervention qu'on envisage de commander. */
  | 'JOB_LOGISTICS'
  /** Un véhicule ou un domicile qui est le MIEN. */
  | 'OWN_PROPERTY'
  /** L'intention d'achat, dite à la première personne. */
  | 'PURCHASE_INTENT';

export type BuyerRoleScope = 'QUESTION' | 'WHOLE_MESSAGE';

export interface BuyerRoleFinding {
  readonly family: BuyerRoleFamily;
  /** Le motif reconnu, nommé en clair — c'est lui qui part dans les rapports. */
  readonly label: string;
  /** Le fragment réellement reconnu, borné. */
  readonly excerpt: string;
  readonly scope: BuyerRoleScope;
}

type Rule = readonly [BuyerRoleFamily, string, RegExp];

// ---------------------------------------------------------------------------
// Les familles lues dans la QUESTION seulement
// ---------------------------------------------------------------------------

/**
 * Le prérequis, c'est-à-dire ce que le CLIENT doit réunir.
 *
 * Les motifs exigent tous la forme déontique (« il faut », « faut-il », « je
 * dois »), et jamais le simple objet. Sans cela, « j'ai vu que vous travaillez
 * sans eau » serait un prérequis, ce qui est l'inverse d'une vérité.
 */
const PREREQUISITE_RULES: readonly Rule[] = [
  ['PREREQUISITE', 'il faut prévoir', /\bil\s+faut\s+(pr[ée]voir|avoir|compter|fournir|disposer|laisser|penser)\b/i],
  ['PREREQUISITE', 'faut-il', /\bfaut[-\s]il\b/i],
  ['PREREQUISITE', 'il faut un / une', /\bil\s+faut\s+(un|une|de\s+l'|de\s+la|du|des)\b/i],
  ['PREREQUISITE', 'je dois prévoir', /\b(je\s+dois|on\s+doit)\s+(pr[ée]voir|avoir|fournir|laisser|disposer)\b/i],
  ['PREREQUISITE', 'il vous faut', /\bil\s+(vous\s+)?faut\s+que\s+(je|j'|on)\b/i],
];

/**
 * La couverture — « venez-vous jusque chez moi ? ».
 *
 * Le verbe seul ne suffit JAMAIS : il faut un objet de PORTÉE (jusqu'où, quelle
 * commune, quel secteur, quel rayon). C'est ce qui laisse passer « c'est vous
 * qui vous déplacez ou les gens viennent à vous ? », qui parle du modèle de
 * l'entreprise et non de son rayon, et « vous vous déplacez surtout chez des
 * pros ou des particuliers ? », qui parle de sa clientèle.
 */
const REACH_VERB = "vous\\s+(?:vous\\s+d[ée]placez|intervenez|venez|allez|passez|bougez|rayonnez|desservez|couvrez)";
/**
 * L'objet de PORTÉE, chaque forme bornée en DÉBUT de mot.
 *
 * Le `START` n'est pas décoratif, et son absence a été mesurée : « au
 * quotidien, vous intervenez plutôt pour **les-quel-s** ? » — une question de
 * clientèle, parfaitement licite — était refusée comme une vérification de
 * couverture, parce que `quel` matchait à l'intérieur de « lesquels ». La
 * famille interrogative porte aussi une borne de FIN, sans quoi
 * « quelquefois » rouvrirait le même trou par l'autre bout.
 */
const REACH_OBJECT =
  `(?:${START}(?:jusqu'|dans\\s+tout|sur\\s+tout|autour\\s+d|quels?${END}|quelles?${END}` +
  `|secteur|zone|commune|rayon|p[ée]rim[èe]tre|d[ée]partement|alentours|coin|ville))`;

/**
 * Le nom de PORTÉE — « zone », « commune », « secteur ».
 *
 * Il ne suffit JAMAIS à lui seul, et la mesure l'a montré : sur les 420
 * messages réellement écrits, « quelle zone » nu attrapait six messages, dont
 * quatre demandaient « quelle zone souhaitez-vous DÉVELOPPER en priorité ? » —
 * une question sur leur ambition commerciale, exactement le contraire d'une
 * vérification de couverture. Le verbe est donc exigé, des deux côtés.
 */
const GEO_NOUN =
  "(?:communes?|villes?|secteurs?|zones?|coins?|rayons?|p[ée]rim[èe]tres?|d[ée]partements?|alentours)";
const SERVICE_REACH_VERB =
  "(?:desservez|couvrez|intervenez|d[ée]placez|venez|allez|travaillez|bougez|rayonnez)";

const COVERAGE_RULES: readonly Rule[] = [
  ['COVERAGE', 'jusqu’où', /\bjusqu'o[ùu]\b/i],
  [
    'COVERAGE',
    'quelle zone … desservez-vous',
    new RegExp(`\\b(?:quelles?|quel)\\s+${GEO_NOUN}\\b[^?]{0,40}\\b${SERVICE_REACH_VERB}\\b`, 'i'),
  ],
  [
    'COVERAGE',
    'vous intervenez … quelle zone',
    new RegExp(`\\b${SERVICE_REACH_VERB}\\b[^?]{0,40}\\b(?:quelles?|quel|dans\\s+quel)\\s+${GEO_NOUN}\\b`, 'i'),
  ],
  ['COVERAGE', 'vous couvrez', /\bvous\s+couvrez\b/i],
  ['COVERAGE', 'votre zone d’intervention', /\b(votre|quelle)\s+(zone|secteur|rayon)\s+d'intervention\b/i],
  ['COVERAGE', 'vous vous déplacez jusqu’à …', new RegExp(`\\b${REACH_VERB}[^?]{0,50}${REACH_OBJECT}`, 'i')],
  /**
   * « Vous venez à Caen ? » — la majuscule du nom propre est la PREUVE, donc ce
   * motif est le seul du fichier à être sensible à la casse. `V` est écrit en
   * classe plutôt qu'en `i` : ajouter `i` ferait de « à domicile » un nom de
   * ville et rendrait la règle absurde.
   */
  [
    'COVERAGE',
    'vous venez à <ville> ?',
    new RegExp(`\\b[Vv]${REACH_VERB.slice(1)}\\s+(?:aussi\\s+)?(?:jusqu'[àa]|[àa]\\s+[A-ZÀ-ÖØ-Þ])`, ''),
  ],
];

/**
 * L'éligibilité — « est-ce que ce que j'ai entre bien dans ce que vous faites ? »
 *
 * Le discriminant est le MODAL. « Les pros vous confient souvent leurs flottes ? »
 * est une question sur leur clientèle réelle, donc sur leur entreprise ; « les
 * pros peuvent vous confier un seul véhicule ? » demande si une commande serait
 * acceptée, donc pose l'expéditeur en commanditaire. Un seul mot les sépare, et
 * c'est celui-là.
 *
 * L'exclusion des noms de PUBLIC dans la règle « vous faites aussi » suit la
 * même logique : « vous travaillez aussi avec des pros ? » interroge le mixte
 * de clientèle (recherché), « vous faites aussi les motos ? » interroge le
 * catalogue (refusé).
 */
const AUDIENCE_NOUNS =
  "(?:des\\s+)?(?:pros?|professionnels?|particuliers?|entreprises?|soci[ée]t[ée]s?|garages?|" +
  "concessions?|flottes?|clients?)";

const ELIGIBILITY_RULES: readonly Rule[] = [
  [
    'ELIGIBILITY',
    'on peut vous confier …',
    /\b(peut|peuvent|pourrait|pourraient|puis[-\s]je|je\s+peux|on\s+peut|c'est\s+possible)\b[^?]{0,60}\bvous\s+(confier|d[ée]poser|amener|apporter|laisser)\b/i,
  ],
  ['ELIGIBILITY', 'vous acceptez les …', /\bvous\s+acceptez\s+(aussi\s+|[ée]galement\s+)?(les|le|la|l'|des|du)\b/i],
  [
    'ELIGIBILITY',
    'vous faites aussi …',
    new RegExp(
      `\\bvous\\s+(faites|proposez|traitez|nettoyez|lavez|g[ée]rez)\\s+(aussi|[ée]galement)\\b(?!\\s+${AUDIENCE_NOUNS})`,
      'i',
    ),
  ],
  ['ELIGIBILITY', 'c’est possible de / pour', /\bc'est\s+possible\s+(de|d'|pour|sur)\b/i],
  [
    'ELIGIBILITY',
    'ça marche aussi pour …',
    new RegExp(`${START}[çc]a\\s+(marche|fonctionne|passe)\\s+(aussi\\s+)?(pour|sur)\\s+(les|un|une|mon|ma)${END}`, 'i'),
  ],
];

/**
 * Le prix.
 *
 * Le mot « devis » NU n'y est pas, et c'est voulu : « vous avez des clients qui
 * vous demandent un devis avant même de venir ? » est une question sur leur
 * quotidien commercial, pas une demande de prix. Ce qui est reconnu est la
 * DEMANDE — « combien », « quel tarif », « faire un devis ».
 */
const PRICE_RULES: readonly Rule[] = [
  ['PRICE_QUOTE', 'combien ça coûte', /\bcombien\s+([çc]a\s+)?(co[ûu]te|revient)\b/i],
  ['PRICE_QUOTE', 'ça coûte combien', new RegExp(`${START}[çc]a\\s+(co[ûu]te|revient)\\s+combien${END}`, 'i')],
  ['PRICE_QUOTE', 'c’est combien', /\bc'est\s+combien\b/i],
  ['PRICE_QUOTE', 'à partir de combien', /\b[àa]\s+partir\s+de\s+combien\b/i],
  ['PRICE_QUOTE', 'quel tarif / quel prix', /\bquels?\s+(est\s+)?(le\s+|votre\s+|vos\s+)?(tarifs?|prix|budget)\b/i],
  ['PRICE_QUOTE', 'vous prenez combien', /\bvous\s+(prenez|facturez|comptez|demandez)\s+combien\b/i],
  ['PRICE_QUOTE', 'faire un devis', /\b(faire|avoir|obtenir|demander)\s+un\s+devis\b/i],
  ['PRICE_QUOTE', 'combien faut-il compter', /\bcombien\s+(faut[-\s]il|il\s+faut)\s+compter\b/i],
];

/** Le créneau. */
const AVAILABILITY_RULES: readonly Rule[] = [
  ['AVAILABILITY', 'vous avez de la dispo', /\bvous\s+avez\s+(de\s+la\s+)?(dispo|disponibilit[ée])/i],
  ['AVAILABILITY', 'vous êtes dispo', /\bvous\s+[êe]tes\s+(dispo|disponible)/i],
  ['AVAILABILITY', 'quel délai', /\b(sous\s+)?quels?\s+d[ée]lais?\b/i],
  ['AVAILABILITY', 'vous prenez encore des …', /\bvous\s+prenez\s+encore\s+(des|de\s+nouveaux)\b/i],
  ['AVAILABILITY', 'on peut réserver', /\b(on\s+peut|je\s+peux|comment)\s+(r[ée]server|prendre\s+rendez[-\s]vous)\b/i],
  [
    'AVAILABILITY',
    'vous travaillez le samedi',
    // Le verbe n'est pas toujours « travaillez » : « vous intervenez le
    // week-end ? » demande la même chose, et c'est le JOUR qui fait la question
    // de client, pas le verbe.
    /\bvous\s+(travaillez|intervenez|venez|passez|[êe]tes\s+l[àa])\s+(aussi\s+|quelquefois\s+|parfois\s+)?(le\s+|les\s+)?(samedi|dimanche|week[-\s]?end|soir|f[ée]ri[ée])/i,
  ],
  ['AVAILABILITY', 'il reste de la place', /\bil\s+(vous\s+)?reste\s+(de\s+la\s+)?(place|dispo|cr[ée]neau)/i],
  ['AVAILABILITY', 'vous pouvez passer quand', /\bvous\s+(pouvez|pourriez)\s+(passer|venir|intervenir)\s+(quand|d[èe]s|cette|la\s+semaine)/i],
];

/** Le déroulé d'une intervention qu'on envisage de commander. */
const LOGISTICS_RULES: readonly Rule[] = [
  ['JOB_LOGISTICS', 'ça prend combien de temps', new RegExp(`${START}[çc]a\\s+(prend|dure)\\s+combien\\s+de\\s+temps${END}`, 'i')],
  ['JOB_LOGISTICS', 'combien de temps ça prend', /\bcombien\s+de\s+temps\s+([çc]a\s+)?(prend|dure)\b/i],
  ['JOB_LOGISTICS', 'vous venez avec le matériel', /\bvous\s+(venez|arrivez|amenez)\s+(avec\s+)?(le|votre|tout\s+le)\s+mat[ée]riel\b/i],
  ['JOB_LOGISTICS', 'il faut laisser la voiture', /\b(il\s+faut|on\s+doit|je\s+dois)\s+laisser\s+(la\s+voiture|le\s+v[ée]hicule|les\s+cl[ée]s)\b/i],
  ['JOB_LOGISTICS', 'on vous laisse les clés', /\bon\s+vous\s+(laisse|d[ée]pose|confie)\b/i],
];

const QUESTION_RULES: readonly Rule[] = Object.freeze([
  ...PREREQUISITE_RULES,
  ...COVERAGE_RULES,
  ...ELIGIBILITY_RULES,
  ...PRICE_RULES,
  ...AVAILABILITY_RULES,
  ...LOGISTICS_RULES,
]);

// ---------------------------------------------------------------------------
// Les familles lues sur le message ENTIER
// ---------------------------------------------------------------------------

/**
 * Un bien qui est le MIEN, ou une intention d'achat dite à la première
 * personne. Aucune de ces deux familles n'a besoin d'une question pour poser le
 * rôle : l'affirmation suffit.
 */
const WHOLE_MESSAGE_RULES: readonly Rule[] = Object.freeze([
  ['OWN_PROPERTY', 'ma voiture / mon véhicule', /\b(ma|mon)\s+(voiture|v[ée]hicule|caisse|auto|utilitaire|van|camion|moto|berline|suv|break)\b/i],
  ['OWN_PROPERTY', 'mes véhicules', /\bmes\s+(voitures|v[ée]hicules|autos)\b/i],
  ['OWN_PROPERTY', 'chez moi', /\bchez\s+moi\b/i],
  ['OWN_PROPERTY', 'à mon domicile', /\b[àa]\s+mon\s+(domicile|adresse|bureau|travail)\b/i],
  ['PURCHASE_INTENT', 'je cherche quelqu’un', /\bje\s+cherche\s+(quelqu'un|un\s+pro|une\s+entreprise|[àa]\s+faire)/i],
  ['PURCHASE_INTENT', 'j’aurais besoin de', /\bj'(aurais|ai)\s+besoin\s+(d'un|d'une|de\s+faire)\b/i],
  [
    'PURCHASE_INTENT',
    'je voudrais faire nettoyer',
    /\bje\s+(voudrais|souhaite|aimerais|compte)\s+(faire\s+(nettoyer|laver|d[ée]tailler)|r[ée]server|prendre\s+rendez[-\s]vous|un\s+devis)/i,
  ],
  ['PURCHASE_INTENT', 'si je veux faire …', /\bsi\s+je\s+(veux|voulais|dois|devais)\s+(faire|passer|r[ée]server|vous)/i],
  ['PURCHASE_INTENT', 'je passe vous voir', /\bje\s+(passe|viens)\s+(vous\s+voir|chez\s+vous)\b/i],
]);

// ---------------------------------------------------------------------------
// Le découpage
// ---------------------------------------------------------------------------

/**
 * Les portions INTERROGATIVES du message.
 *
 * Un enchaînement de caractères qui ne contient aucun terminateur et qui
 * s'achève sur « ? ». Pas de découpage savant : `checkFirstTouch` garantit déjà
 * qu'un premier message porte une question et une seule (`NO_QUESTION`,
 * `MULTIPLE_QUESTIONS`), si bien que ce découpage rend en pratique exactement
 * la phrase qui pose la question.
 *
 * Exportée parce qu'un test doit pouvoir montrer CE QUI a été lu, plutôt que
 * de déduire la portée d'un verdict.
 */
export function interrogativeSpans(body: string): readonly string[] {
  const text = normalizeForMatching(body);
  return Object.freeze([...text.matchAll(/[^.!?\n]+\?/gu)].map((match) => match[0].trim()));
}

function excerptOf(text: string, max = 60): string {
  const flat = text.trim().replace(/\s+/gu, ' ');
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

function scan(haystack: string, rules: readonly Rule[], scope: BuyerRoleScope): BuyerRoleFinding[] {
  const found: BuyerRoleFinding[] = [];
  for (const [family, label, pattern] of rules) {
    const match = haystack.match(pattern);
    if (match === null) continue;
    found.push(Object.freeze({ family, label, excerpt: excerptOf(match[0]), scope }));
  }
  return found;
}

/**
 * Le message laisse-t-il croire que celui qui l'écrit veut acheter la
 * prestation ?
 *
 * Rend TOUS les constats plutôt que le premier : deux familles distinctes dans
 * un même message se corrigent différemment, et n'en montrer qu'une ferait
 * réécrire deux fois là où une suffit.
 *
 * Fonction pure, ne lève jamais.
 */
export function detectBuyerRole(body: string): readonly BuyerRoleFinding[] {
  const whole = normalizeForMatching(body);
  const findings: BuyerRoleFinding[] = [...scan(whole, WHOLE_MESSAGE_RULES, 'WHOLE_MESSAGE')];
  for (const span of interrogativeSpans(body)) {
    findings.push(...scan(span, QUESTION_RULES, 'QUESTION'));
  }
  return Object.freeze(findings);
}
