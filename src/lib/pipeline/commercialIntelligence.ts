import {
  markerState,
  type CommercialFacts,
  type CommercialMarker,
  type EmailShape,
  type MarkerState,
} from '@/lib/pipeline/commercialSignals';
import {
  bandOf,
  foldWeightedContributions,
  type AxisBand,
  type AxisConfidence,
  type WeightedContribution,
} from '@/lib/pipeline/weightedAxis';
import type { IcpAssessment } from '@/lib/pipeline/icpEligibility';
import type { SocialChannelGap } from '@/lib/pipeline/socialAcquisitionGap';
import type { ScalableOpportunityAssessment } from '@/lib/pipeline/scalableOpportunity';
import type { CoreActivityAssessment } from '@/lib/pipeline/coreActivity';
import type { EvidenceQuality } from '@/lib/pipeline/evidenceQuality';
import type { CommercialIntelligenceProfile } from '@/lib/config/schema';
import type { ProspectRow } from '@/lib/repo/types';

/**
 * R7.1 — « devrions-nous contacter cette entreprise maintenant ? »
 *
 * ---------------------------------------------------------------------------
 * La question a changé, et c'est tout le sujet
 * ---------------------------------------------------------------------------
 * `score.ts` répond à « est-ce un bon business dans la niche ». Il le fait
 * bien, et il continue : R7 n'y touche pas, ne renomme rien, n'écrit ni
 * `prospects.score` ni `prospects.score_band`.
 *
 * Mais la réponse à cette question-là ne classe pas du travail commercial. Le
 * cas qui l'a montré est un artisan lyonnais noté 87/A : site soigné, offre
 * premium, branding cohérent, cinq canaux publics. Chacun de ces faits lui a
 * rapporté des points — et chacun est une raison de PENSER QU'IL N'A PAS BESOIN
 * DE NOUS. Le score mesurait l'excellence de l'entreprise et l'appelait
 * « potentiel commercial ».
 *
 * ---------------------------------------------------------------------------
 * Cinq axes, parce qu'un seul nombre mentait
 * ---------------------------------------------------------------------------
 *   ICP FIT               savons-nous servir ce type d'entreprise ?
 *   ACQUISITION MATURITY  son acquisition est-elle DÉJÀ structurée ?
 *   NEED / GAP            quel manque observable savons-nous corriger ?
 *   ABILITY TO PAY        peut-elle acheter, et absorber des clients ?
 *   TIMING                pourquoi maintenant ?
 *
 * Le fit ne fait plus monter personne au sommet : il ne peut que QUALIFIER. La
 * priorité est portée par le besoin, freinée par la maturité, bornée par la
 * capacité. Une entreprise excellente dont l'acquisition est déjà mature et
 * dont aucun manque n'a été observé descend — ce n'est pas un mauvais business,
 * c'est un mauvais prospect POUR NOUS, et ce sont deux phrases différentes.
 *
 * ---------------------------------------------------------------------------
 * UNKNOWN n'est ni bas, ni mauvais
 * ---------------------------------------------------------------------------
 * Chaque axe rend `null` plutôt qu'un zéro quand rien n'a été observé, et
 * publie sa confiance à côté de sa valeur. « maturité 25, confiance HAUTE » et
 * « maturité inconnue, confiance NULLE » sont deux affirmations opposées qu'un
 * même nombre aurait confondues. Un prospect dont le site n'a jamais été ouvert
 * ne gagne donc pas de besoin par ignorance, et ne perd pas de maturité non
 * plus : il sort en `INSUFFICIENT_EVIDENCE`, ce qui est une demande de
 * collecte, pas un verdict commercial.
 *
 * Tout est déterministe : mêmes lignes d'evidence, même sortie, sans horloge ni
 * modèle. Aucun prompt n'entre ici (CLAUDE.md — la logique déterministe reste
 * du code testé).
 */

export type AxisKey = 'icpFit' | 'acquisitionMaturity' | 'need' | 'abilityToPay' | 'timing';

export type { AxisConfidence, AxisBand };

/**
 * Un contributeur retenu, avec de quoi le contester.
 *
 * R7.3C : la forme vit désormais dans `weightedAxis.ts`, partagée avec l'axe
 * social. L'alias est conservé pour que rien de ce qui l'importait déjà n'ait à
 * bouger — et parce que « contributeur d'axe commercial » reste le bon nom ici.
 */
export type AxisContribution = WeightedContribution;

export interface AxisResult {
  readonly key: AxisKey;
  /** 0..100, ou `null` quand rien n'a pu être observé. Jamais 0 par défaut. */
  readonly score: number | null;
  readonly band: AxisBand;
  readonly confidence: AxisConfidence;
  /** Part du poids total réellement observée. La mesure de ce qu'on sait. */
  readonly coverage: number;
  readonly contributions: readonly AxisContribution[];
  /** Ce qui n'a pas pu être observé — la liste de courses de la collecte suivante. */
  readonly missing: readonly string[];
  readonly reasons: readonly string[];
}

export type CommercialDecision =
  | 'PRIORITIZE'
  | 'CONSIDER'
  | 'DEPRIORITIZE'
  | 'DO_NOT_PRIORITIZE'
  | 'INSUFFICIENT_EVIDENCE';

export interface CommercialIntelligenceResult {
  readonly axes: Readonly<Record<AxisKey, AxisResult>>;
  /**
   * Le verdict ICP tel quel, republié à côté de la note de fit.
   *
   * Les deux ne disent pas la même chose et il faut pouvoir lire les deux : le
   * fit peut valoir 40 sur une franchise parce que son MÉTIER est bien le
   * nôtre, tandis que le verdict, lui, dit que ce TYPE d'entreprise ne l'est
   * pas. C'est le verdict qui ferme la porte, jamais la note.
   */
  readonly icpVerdict: IcpAssessment['verdict'] | null;
  /**
   * R7.6 — l'opportunité scalable, publiée à côté du verdict ICP et jamais
   * fondue dedans.
   *
   * `null` quand l'appelant ne l'a pas fournie, ce qui rend le moteur
   * IDENTIQUE à ce qu'il était : un test l'exécute sur tout le corpus. Fournie,
   * elle n'agit que par sa PORTE (`eligibility.verdict === 'OUT_OF_SCOPE'`) —
   * ses bandes sont publiées, aucune n'est pondérée.
   */
  readonly opportunity: ScalableOpportunityAssessment | null;
  /** 0..100, ou `null` quand le besoin n'a pas pu être observé. */
  readonly commercialPriority: number | null;
  readonly priorityBand: AxisBand;
  readonly decision: CommercialDecision;
  readonly confidence: AxisConfidence;
  readonly reasons: readonly string[];
  readonly missingSignals: readonly string[];
  readonly profileKey: string;
  readonly profileVersion: string;
}

// ---------------------------------------------------------------------------
// Le mécanisme commun
// ---------------------------------------------------------------------------

/**
 * Additionne des contributeurs pondérés en laissant les non-observés HORS du
 * dénominateur.
 *
 * C'est la même discipline que `score.ts` (`onMissing: neutral`) et pour la
 * même raison : diviser par un poids qu'on n'a pas mesuré transformerait un
 * manque de données en jugement. La différence est qu'ici la couverture n'est
 * pas seulement un garde-fou tardif — elle est PUBLIÉE, axe par axe, sous le
 * nom de confiance.
 */
function computeAxis(
  key: AxisKey,
  contributions: readonly AxisContribution[],
  confidenceThresholds: CommercialIntelligenceProfile['confidence'],
): AxisResult {
  const fold = foldWeightedContributions(contributions, confidenceThresholds);
  return { key, contributions, ...fold };
}

/** Le poids déclaré pour un contributeur. Absent = le profil n'a pas tranché : erreur. */
function weightOf(map: Readonly<Record<string, number>>, key: string, axis: AxisKey): number {
  const weight = map[key];
  if (weight === undefined) {
    throw new Error(
      `profil commercial-intelligence : aucun poids déclaré pour « ${key} » (axe ${axis}). ` +
        'Ajouter un contributeur au code demande de décider de son poids dans config/commercial-intelligence/.',
    );
  }
  return weight;
}

/**
 * L'état d'un GROUPE de marqueurs, en ne comptant que ceux réellement cherchés.
 *
 * `checked` est le dénominateur, jamais la taille du groupe : un crawler qui
 * n'a pas cherché `pixel_tiktok` n'a pas constaté son absence, et le §2 de
 * CLAUDE.md interdit de traiter les deux pareil.
 */
function groupRatio(
  facts: CommercialFacts,
  markers: readonly CommercialMarker[],
): { ratio: number | null; observed: CommercialMarker[]; absent: CommercialMarker[] } {
  const observed: CommercialMarker[] = [];
  const absent: CommercialMarker[] = [];
  for (const marker of markers) {
    const state: MarkerState = markerState(facts, marker);
    if (state === 'observed') observed.push(marker);
    else if (state === 'checked_absent') absent.push(marker);
  }
  const checked = observed.length + absent.length;
  return { ratio: checked === 0 ? null : observed.length / checked, observed, absent };
}

/** Le miroir : ce qui a été cherché et NON vu. Le besoin se lit ici. */
function gapRatio(
  facts: CommercialFacts,
  markers: readonly CommercialMarker[],
): { ratio: number | null; observed: CommercialMarker[]; absent: CommercialMarker[] } {
  const group = groupRatio(facts, markers);
  return { ...group, ratio: group.ratio === null ? null : 1 - group.ratio };
}

// ---------------------------------------------------------------------------
// Les groupes de marqueurs — nommés une fois, lus par deux axes
// ---------------------------------------------------------------------------

const TRACKING_MARKERS: readonly CommercialMarker[] = [
  'analytics_google',
  'tag_manager',
  'pixel_meta',
  'pixel_tiktok',
  'session_recording',
];
const TRANSACTION_MARKERS: readonly CommercialMarker[] = ['booking_online', 'checkout', 'calendar_embed'];
const STRUCTURED_OFFER_MARKERS: readonly CommercialMarker[] = ['form_quote', 'page_pricing', 'price_displayed'];
const CONVERSION_SUPPORT_MARKERS: readonly CommercialMarker[] = [
  'reviews_embedded',
  'faq',
  'social_proof',
  'promo_offer',
];
const PUBLISHED_CHANNEL_MARKERS: readonly CommercialMarker[] = [
  'cta_phone',
  'cta_email',
  'cta_instagram',
  'cta_facebook',
  'cta_whatsapp',
];

export interface CommercialIntelligenceInput {
  readonly prospect: ProspectRow;
  readonly facts: CommercialFacts;
  readonly email: EmailShape;
  /** Le verdict ICP déjà calculé par `evaluateIcpEligibility`, s'il existe. */
  readonly icp: IcpAssessment | null;
  readonly profile: CommercialIntelligenceProfile;
  /**
   * R7.3C §25 — l'apport SOCIAL, optionnel, et absent par défaut.
   *
   * ---------------------------------------------------------------------------
   * Pourquoi ici plutôt que dans un second moteur
   * ---------------------------------------------------------------------------
   * Model B aurait pu être une copie de `commercialPriority` avec une ligne de
   * plus. Ç'aurait été la même erreur que deux implémentations de « lecture
   * seule » : la copie et l'original divergent, et c'est toujours la comparaison
   * A/B qui devient fausse — c'est-à-dire exactement la mesure que le round
   * existe pour produire.
   *
   * Le champ est donc porté par l'entrée, et son absence rend le moteur
   * IDENTIQUE À CE QU'IL ÉTAIT. Un test le vérifie sur tout le corpus : Model A
   * évalué avec ce champ absent rend, prospect par prospect, la même priorité,
   * la même décision et la même confiance qu'avant R7.3C.
   */
  readonly social?: SocialPriorityInput;
  /**
   * R7.6 — l'opportunité scalable, fournie comme une FONCTION des axes finis.
   *
   * ---------------------------------------------------------------------------
   * Pourquoi une fonction plutôt qu'une valeur
   * ---------------------------------------------------------------------------
   * L'évaluation d'opportunité LIT deux axes que ce moteur produit — le besoin
   * (l'écart de funnel) et la capacité à payer — et elle ne doit surtout pas les
   * recalculer : deux implémentations de « quel manque avons-nous observé »
   * finiraient par se contredire, et c'est le défaut que R7.1 avait déjà nommé
   * en extrayant la feuille de faits.
   *
   * Une valeur aurait donc exigé d'évaluer le moteur deux fois — une passe pour
   * obtenir les axes, une seconde pour appliquer la porte. Une fonction dit la
   * même chose en une passe, et rend la dépendance explicite plutôt que
   * temporelle.
   *
   * Absente, le moteur est mot pour mot celui de R7.4 : un test l'exécute sur
   * tout le corpus.
   */
  readonly opportunityFor?: (context: OpportunityContext) => ScalableOpportunityAssessment;
  /**
   * R7.7 — les deux corrections structurelles du round, armées ensemble.
   *
   * Absent, le moteur est mot pour mot celui de R7.6 : un test l'exécute sur
   * tout le corpus, décision par décision. C'est la même discipline que
   * `social` et `opportunityFor`, et pour la même raison — un round qui ne
   * saurait plus reproduire le précédent ne peut plus rien lui comparer.
   */
  readonly evidence?: EvidenceR77Input;
}

/**
 * R7.7 — ce que le round ajoute à l'entrée du moteur.
 *
 * Les deux champs voyagent ensemble parce qu'ils sont armés ensemble par
 * MODEL E, mais ils restent SÉPARÉS : `r7:opportunity` construit une variante
 * pour chacun, de sorte que le rapport puisse dire lequel des deux a déplacé
 * quoi. Un drapeau unique « R7.7 » ne l'aurait jamais permis.
 */
export interface EvidenceR77Input {
  /**
   * La qualité de preuve calculée par `qualifyEvidence`, quand le round demande
   * que les absences hors de portée soient retirées. Les faits transmis dans
   * `facts` sont alors DÉJÀ nettoyés : ce champ est le rapport de ce qui a été
   * retiré, pas l'instruction de le retirer.
   */
  readonly quality?: EvidenceQuality;
  /** L'activité déclarée par le cadre du site, quand le round la lit. */
  readonly coreActivity?: CoreActivityAssessment;
}

/** Les axes finis que l'évaluation d'opportunité lit, et qu'elle ne recalcule jamais. */
export interface OpportunityContext {
  readonly need: AxisResult;
  readonly abilityToPay: AxisResult;
}

/**
 * L'entrée sociale de Model B : un score d'axe, et de combien on l'autorise à
 * compter.
 */
export interface SocialPriorityInput {
  /** Le score de l'axe `socialAcquisitionMaturity`, ou `null` si jamais collecté. */
  readonly score: number | null;
  /**
   * 0 → Model A exactement. 1 → la maturité effective est le MAXIMUM des deux
   * canaux. Entre les deux, une part.
   *
   * Le paramètre est unique et continu délibérément : il contient Model A comme
   * cas particulier, donc le balayage compare des variantes d'un même modèle au
   * lieu de comparer deux modèles dont on ne saurait pas ce qui les sépare.
   */
  readonly blend: number;
  /**
   * R7.4 — l'ÉCART d'acquisition sociale, déjà MESURÉ, et pas encore jugé.
   *
   * Absent, le moteur est exactement Model B : aucun contributeur n'est ajouté
   * au besoin, aucun dénominateur ne bouge, et un test l'exécute sur tout le
   * corpus. Présent, il n'agit encore que si le profil lui a donné un poids ET
   * si les portes commerciales de `needAxis` l'autorisent.
   *
   * Le champ porte une MESURE (`ratio`), jamais une décision : décider qu'un
   * canal muet est un besoin exige le fit et la capacité, qui sont des axes, et
   * cette décision est donc prise ici, dans le moteur.
   */
  readonly gap?: SocialChannelGap;
  /**
   * R7.6 §7 — la part ACQUISITION du canal social, quand on refuse de lire
   * l'activité organique comme de la structure.
   *
   * ---------------------------------------------------------------------------
   * Ce que ce champ corrige
   * ---------------------------------------------------------------------------
   * `score` est la maturité sociale complète de R7.3C, dont 64 % du poids vient
   * de la RÉCENCE et de la CADENCE des publications. Injectée dans la maturité
   * effective, elle FREINE la priorité — le moteur dit donc « ce artisan publie
   * beaucoup, donc son acquisition est structurée, donc il a moins besoin de
   * nous ». La revue humaine réfute cette phrase et la mission la déclare
   * fausse : publier régulièrement démontre une intention digitale, pas une
   * machine de conversion.
   *
   * Fourni, ce champ REMPLACE `score` dans le mélange de maturité — et lui seul.
   * `score` reste publié, MODEL B et MODEL C restent reproductibles mot pour
   * mot, et son absence (`undefined`) laisse le moteur exactement tel qu'il
   * était. `null` signifie « observé mais non mesurable » et se comporte comme
   * une maturité sociale inconnue : hors du calcul, jamais à zéro.
   */
  readonly acquisitionStructureScore?: number | null;
}

// ---------------------------------------------------------------------------
// A — ICP FIT
// ---------------------------------------------------------------------------

/**
 * Le verdict de métier tel que R7.1–R7.6 le lisait : la colonne
 * `prospects.niche_verdict`, prise pour argent comptant.
 *
 * Conservée telle quelle, et pas seulement pour rejouer les modèles anciens :
 * elle reste la seule réponse disponible quand aucune page de présentation n'a
 * été lue, parce qu'elle s'appuie aussi sur le code registre et la catégorie
 * OSM. Ce que R7.7 lui retire, c'est le DERNIER MOT — jamais la parole.
 */
function storedVerdictRatio(prospect: ProspectRow): number | null {
  switch (prospect.niche_verdict) {
    case null:
      return null;
    case 'in_niche':
      return 1;
    case 'adjacent':
      return 0.45;
    case 'uncertain':
      return 0.25;
    default:
      return 0;
  }
}

/**
 * R7.7 §6 — « ce métier est-il le sien ? », posée à la preuve plutôt qu'à une
 * colonne.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi le minimum des deux lectures, et pas une moyenne
 * ---------------------------------------------------------------------------
 * Deux sources répondent : la colonne `niche_verdict`, produite par un
 * classificateur qui verse tout le texte du site dans un seul sac et conclut
 * `in_niche` dès qu'un terme positif y apparaît ; et le CADRE du site, lu par
 * `assessCoreActivity`, qui distingue « nous lavons des voitures » de
 * « nous enseignons à laver des voitures ».
 *
 * La seconde a été écrite parce que la première se trompait dans un sens
 * connu : elle est TROP PERMISSIVE. Une moyenne laisserait donc l'erreur peser
 * la moitié de son poids ; le minimum la retire. La propriété qui en découle
 * mérite d'être énoncée, parce qu'elle est ce qui rend le round contestable :
 *
 *   sur ce contributeur, R7.7 ne peut être que PLUS SÉVÈRE que R7.6, jamais
 *   plus indulgent. Aucun prospect ne gagne de fit ici ; certains en perdent,
 *   et le rapport doit dire lesquels.
 *
 * ---------------------------------------------------------------------------
 * Et l'inconnu, qui est la moitié du sujet
 * ---------------------------------------------------------------------------
 * `UNPROVEN` — cadre lu, rien de reconnaissable — vaut un crédit, pas `null`.
 * C'est la correction du §7 : sous R7.6, un métier jamais classifié faisait
 * quitter QUARANTE POINTS du dénominateur, et les deux contributeurs restants
 * se renormalisaient à 100. Huit prospects du corpus sortaient ainsi à fit 100
 * sans qu'aucune preuve d'activité n'existe. Le crédit les ramène à 80, ce qui
 * est la note d'un doute et non celle d'une certitude.
 *
 * `UNKNOWN` — rien n'a été lu — reste `null`. Un prospect jamais ouvert ne perd
 * toujours aucun point, sauf si `niche_verdict` dit quelque chose : alors c'est
 * cette voix-là qu'on entend, faute d'une meilleure.
 */
function activityContribution(input: CommercialIntelligenceInput): AxisContribution {
  const { prospect, profile } = input;
  const weights = profile.weights.icpFit;
  const stored = storedVerdictRatio(prospect);
  const activity = input.evidence?.coreActivity;

  if (activity === undefined) {
    return {
      key: 'niche_verdict',
      weight: weightOf(weights, 'niche_verdict', 'icpFit'),
      ratio: stored,
      detail: prospect.niche_verdict === null ? 'métier non classifié' : `métier ${prospect.niche_verdict}`,
    };
  }

  const credits = profile.businessType;
  const frameRatio =
    activity.verdict === 'CORE_ACTIVITY'
      ? 1
      : activity.verdict === 'ADJACENT_WITH_CORE'
        ? credits.adjacentWithCoreCredit
        : activity.verdict === 'ADJACENT_ONLY'
          ? credits.adjacentOnlyCredit
          : activity.verdict === 'UNPROVEN'
            ? credits.unprovenCoreActivityCredit
            : null;

  const ratio =
    frameRatio === null ? stored : stored === null ? frameRatio : Math.min(frameRatio, stored);

  return {
    key: 'core_activity',
    weight: weightOf(weights, 'core_activity', 'icpFit'),
    ratio,
    detail:
      frameRatio === null
        ? `activité déclarée inconnue — ${activity.reason}` +
          (prospect.niche_verdict === null ? '' : ` (colonne : métier ${prospect.niche_verdict})`)
        : `${activity.verdict} — ${activity.reason}` +
          (stored !== null && stored < frameRatio ? ` ; la colonne est plus sévère (métier ${prospect.niche_verdict})` : ''),
  };
}

/**
 * « Savons-nous servir ce type d'entreprise ? »
 *
 * Volontairement pauvre en points : le fit QUALIFIE, il ne classe pas. Un fit
 * parfait sans besoin observé ne produit aucune priorité — c'est exactement
 * l'erreur de `example-v1`, où `niche_fit` valait 18 points sur 100 et où
 * un atelier parfaitement classé partait avec une avance qu'aucun manque
 * n'avait justifiée.
 */
function icpFitAxis(input: CommercialIntelligenceInput): AxisResult {
  const { prospect, icp, profile } = input;
  const weights = profile.weights.icpFit;
  const contributions: AxisContribution[] = [];

  contributions.push(activityContribution(input));

  contributions.push({
    key: 'icp_eligibility',
    weight: weightOf(weights, 'icp_eligibility', 'icpFit'),
    ratio: icp === null ? null : icp.verdict === 'GOOD_ICP' ? 1 : icp.verdict === 'REVIEW_REQUIRED' ? 0.45 : 0,
    detail: icp === null ? 'éligibilité ICP non évaluée' : `ICP ${icp.verdict} — ${icp.reason}`,
  });

  /**
   * Un opérateur indépendant plutôt qu'un point d'un réseau.
   *
   * ---------------------------------------------------------------------------
   * R7.3B §8 — ce contributeur était la mécanique du fit à 100
   * ---------------------------------------------------------------------------
   * La v1 rendait trois valeurs : `0` hors cible, `1` immatriculé, `null` sinon.
   * Le `null` est le problème, et il est subtil : son poids quittait le
   * dénominateur, si bien qu'un prospect dont le TYPE d'entreprise n'avait jamais
   * été établi obtenait exactement la même note qu'un prospect dont
   * l'indépendance était prouvée. `wash-totalenergies.fr` — opérateur national
   * de stations de prestation — sortait ainsi à **fit 100** : métier `in_niche`,
   * aucun marqueur de réseau trouvé par un vocabulaire qui ne les cherchait pas,
   * identité légale non résolue, contributeur absent du calcul.
   *
   * L'absence de contre-preuve rendait donc le même verdict que la preuve. Un
   * quatrième état les sépare :
   *
   *   1        identité légale résolue — une entité unique, nommée, existante ;
   *   crédit   contenu LU, aucun marqueur de réseau trouvé. Preuve partielle
   *            d'indépendance : quelqu'un a regardé et n'a rien vu ;
   *   null     rien n'a été lu. Inconnu, donc hors du dénominateur — un prospect
   *            jamais ouvert ne perd toujours AUCUN point ici ;
   *   0        réseau / franchise constaté.
   *
   * Ce n'est pas une pénalité sur l'inconnu : c'est la fin d'une récompense
   * accordée à l'inconnu. Un fit de 100 affirme une certitude, et il exige
   * désormais une preuve positive d'identité.
   */
  const registered = prospect.registry_id !== null && prospect.registry_id.trim().length > 0;
  const notTarget = icp?.verdict === 'NOT_TARGET';
  const readWithoutLegalIdentity = icp !== null && icp.coverage === 'read';
  const credit = profile.businessType.unresolvedLegalIdentityCredit;
  contributions.push({
    key: 'independent_operator',
    weight: weightOf(weights, 'independent_operator', 'icpFit'),
    ratio: notTarget ? 0 : registered ? 1 : readWithoutLegalIdentity ? credit : null,
    detail: notTarget
      ? 'réseau / franchise : hors cible'
      : registered
        ? `identité légale résolue (${prospect.registry_id})`
        : readWithoutLegalIdentity
          ? 'contenu lu sans marqueur de réseau, mais aucune identité légale résolue — ' +
            `preuve partielle d’indépendance (${credit})`
          : 'structure juridique non résolue et aucun contenu lu',
  });

  return computeAxis('icpFit', contributions, profile.confidence);
}

// ---------------------------------------------------------------------------
// B — ACQUISITION MATURITY
// ---------------------------------------------------------------------------

/**
 * « À quel point son acquisition est-elle DÉJÀ structurée ? »
 *
 * Une maturité haute n'est pas un défaut de l'entreprise. C'est une
 * probabilité plus faible qu'elle ait un besoin évident de nous, et c'est tout
 * ce que cet axe prétend dire.
 *
 * Le contributeur le plus lourd est la pile de mesure (analytics, GTM, pixels,
 * enregistrement de session), et ce choix mérite d'être défendu : une
 * entreprise qui MESURE son acquisition en fait déjà, ou s'apprête à en faire.
 * C'est un fait technique lisible sur la page, pas une impression esthétique —
 * contrairement à la beauté d'un feed, qu'aucune de nos données ne porte
 * aujourd'hui.
 */
function acquisitionMaturityAxis(input: CommercialIntelligenceInput): AxisResult {
  const { facts, email, profile } = input;
  const weights = profile.weights.acquisitionMaturity;
  const contributions: AxisContribution[] = [];

  const push = (key: string, ratio: number | null, detail: string): void => {
    contributions.push({ key, ratio, weight: weightOf(weights, key, 'acquisitionMaturity'), detail });
  };

  const tracking = groupRatio(facts, TRACKING_MARKERS);
  push(
    'tracking_stack',
    tracking.ratio,
    tracking.ratio === null
      ? 'pile de mesure non cherchée'
      : tracking.observed.length > 0
        ? `mesure en place : ${tracking.observed.join(', ')}`
        : 'aucun outil de mesure observé sur les pages lues',
  );

  const transaction = groupRatio(facts, TRANSACTION_MARKERS);
  push(
    'transactional_path',
    transaction.ratio,
    transaction.ratio === null
      ? 'chemin transactionnel non cherché'
      : transaction.observed.length > 0
        ? `transaction en ligne : ${transaction.observed.join(', ')}`
        : 'aucune réservation ni paiement en ligne observé',
  );

  const offer = groupRatio(facts, STRUCTURED_OFFER_MARKERS);
  push(
    'structured_offer',
    offer.ratio,
    offer.ratio === null
      ? 'structuration de l’offre non cherchée'
      : offer.observed.length > 0
        ? `offre structurée : ${offer.observed.join(', ')}`
        : 'ni devis, ni page tarifs, ni prix affiché',
  );

  const support = groupRatio(facts, CONVERSION_SUPPORT_MARKERS);
  push(
    'conversion_support',
    support.ratio,
    support.ratio === null
      ? 'soutien à la conversion non cherché'
      : support.observed.length > 0
        ? `soutien à la conversion : ${support.observed.join(', ')}`
        : 'aucune preuve sociale ni FAQ observée',
  );

  push(
    'site_quality',
    facts.websiteQuality,
    facts.websiteQuality === null
      ? 'site non analysé'
      : `qualité éditoriale du site ${Math.round(facts.websiteQuality * 100)}%`,
  );

  push(
    'cta_quality',
    facts.ctaQuality,
    facts.ctaQuality === null ? 'appel à l’action non analysé' : `qualité du CTA ${Math.round(facts.ctaQuality * 100)}%`,
  );

  /**
   * Densité éditoriale : combien de titres et de prestations distinctes le site
   * porte. Un site à trente titres est entretenu par quelqu'un dont c'est le
   * travail. Plafonné, parce qu'au-delà la mesure ne distingue plus rien.
   */
  const depth = facts.siteRead ? Math.min(1, (facts.headingCount + facts.services.length * 2) / 40) : null;
  push(
    'content_depth',
    depth,
    depth === null
      ? 'densité éditoriale non observée (site non lu)'
      : `${facts.headingCount} titre(s), ${facts.services.length} prestation(s) nommée(s)`,
  );

  push(
    'professional_email',
    email.kind === 'none'
      ? null
      : email.kind === 'own_domain_role'
        ? 1
        : email.kind === 'own_domain_personal'
          ? 0.8
          : email.kind === 'other_domain'
            ? 0.4
            : 0.15,
    email.detail,
  );

  const channels = groupRatio(facts, PUBLISHED_CHANNEL_MARKERS);
  push(
    'published_channels',
    channels.ratio,
    channels.ratio === null
      ? 'canaux publiés non cherchés'
      : `${channels.observed.length} canal/canaux publiés sur le site`,
  );

  return computeAxis('acquisitionMaturity', contributions, profile.confidence);
}

// ---------------------------------------------------------------------------
// C — NEED / GAP
// ---------------------------------------------------------------------------

/**
 * « Quel manque RÉEL et OBSERVABLE savons-nous corriger ? »
 *
 * Le besoin doit être démontré positivement. « Ce prospect est dans la niche »
 * n'est pas un besoin ; « ce site a été lu sur cinq pages et n'affiche aucun
 * tarif, aucun devis et aucun outil de mesure » en est un, parce que quelqu'un
 * a regardé.
 *
 * D'où l'asymétrie assumée avec la maturité : ici, `checked_absent` VAUT 1, et
 * `not_checked` vaut `null`. Un site jamais ouvert ne produit aucun besoin —
 * il produit une demande de collecte.
 */
function needAxis(input: CommercialIntelligenceInput, gates: NeedGates): AxisResult {
  const { facts, profile } = input;
  const weights = profile.weights.need;
  const contributions: AxisContribution[] = [];

  const push = (key: string, ratio: number | null, detail: string): void => {
    contributions.push({ key, ratio, weight: weightOf(weights, key, 'need'), detail });
  };

  const measurement = gapRatio(facts, TRACKING_MARKERS);
  push(
    'no_measurement',
    measurement.ratio,
    measurement.ratio === null
      ? 'mesure non cherchée'
      : measurement.absent.length > 0
        ? `aucune mesure d’acquisition sur les pages lues (${measurement.absent.join(', ')})`
        : 'acquisition déjà mesurée',
  );

  const booking = gapRatio(facts, TRANSACTION_MARKERS);
  push(
    'no_booking_path',
    booking.ratio,
    booking.ratio === null
      ? 'chemin de réservation non cherché'
      : booking.absent.length > 0
        ? 'aucune réservation en ligne observée'
        : 'réservation en ligne en place',
  );

  push(
    'no_quote_path',
    ratioOfGap(markerState(facts, 'form_quote')),
    describeGap(markerState(facts, 'form_quote'), 'demande de devis'),
  );

  const price = gapRatio(facts, ['page_pricing', 'price_displayed']);
  push(
    'no_price_visibility',
    price.ratio,
    price.ratio === null
      ? 'visibilité des prix non cherchée'
      : price.absent.length > 0
        ? 'aucun tarif visible sur les pages lues'
        : 'tarifs affichés',
  );

  /**
   * Le CTA compte deux fois : sa présence (marqueur) et sa qualité (ratio lu
   * par le crawler). Un « contactez-nous » en pied de page est un CTA au sens
   * du marqueur et un manque au sens commercial.
   */
  const ctaGap =
    facts.ctaQuality !== null
      ? 1 - facts.ctaQuality
      : ratioOfGap(markerState(facts, 'cta_primary'));
  push(
    'weak_cta',
    ctaGap,
    facts.ctaQuality !== null
      ? `qualité du CTA ${Math.round(facts.ctaQuality * 100)}% — ${Math.round((1 - facts.ctaQuality) * 100)}% de marge`
      : describeGap(markerState(facts, 'cta_primary'), 'appel à l’action'),
  );

  const trust = gapRatio(facts, ['social_proof', 'reviews_embedded']);
  push(
    'no_trust_signals',
    trust.ratio,
    trust.ratio === null
      ? 'preuve sociale non cherchée'
      : trust.absent.length > 0
        ? 'aucune preuve sociale sur les pages lues'
        : 'preuve sociale présente',
  );

  push(
    'thin_site',
    facts.websiteQuality === null ? null : 1 - facts.websiteQuality,
    facts.websiteQuality === null
      ? 'site non analysé'
      : `qualité du site ${Math.round(facts.websiteQuality * 100)}% — ${Math.round((1 - facts.websiteQuality) * 100)}% de marge`,
  );

  /**
   * Conversion par téléphone seul : un fait, pas un défaut. Il devient une
   * opportunité quand aucun chemin écrit n'existe à côté — c'est le prospect
   * qui perd les demandes hors horaires.
   */
  /**
   * R7.7 §4 — deux contributeurs affirmaient un fait à partir d'un trou.
   *
   * « Un chemin écrit existe à côté du téléphone » se déduisait de
   * `form_quote !== checked_absent`, ce qui est vrai aussi bien quand un devis
   * a été VU que quand personne ne l'a cherché. Le contributeur rendait donc
   * `0` — « pas de manque » — sur une ignorance, et le libellé publié affirmait
   * une existence que rien n'avait établie. Même défaut pour la lisibilité de
   * l'offre, qui concluait « offre peu lisible » sans savoir si une page de
   * prestations avait été cherchée.
   *
   * Tant que le rail traduisait tout en `checked_absent`, le défaut restait
   * invisible : il n'existait pas de troisième état à mal lire. La correction
   * de la portée des absences le rend actif, et c'est pourquoi il est corrigé
   * ici plutôt qu'ailleurs — les deux ne sont qu'une seule et même règle.
   */
  const writtenPath = [markerState(facts, 'form_quote'), markerState(facts, 'booking_online')] as const;
  const writtenPathChecked = writtenPath.every((state) => state !== 'not_checked');
  const phoneObserved = markerState(facts, 'cta_phone') === 'observed' || markerState(facts, 'phone_only') === 'observed';
  const writtenPathAbsent = writtenPath.every((state) => state === 'checked_absent');
  push(
    'phone_only_conversion',
    !facts.siteRead || !writtenPathChecked ? null : phoneObserved && writtenPathAbsent ? 1 : 0,
    !facts.siteRead
      ? 'parcours non observé'
      : !writtenPathChecked
        ? 'chemin écrit non cherché — ni présent ni absent'
        : phoneObserved && writtenPathAbsent
          ? 'conversion par téléphone seul — aucune demande écrite possible'
          : 'un chemin écrit existe à côté du téléphone',
  );

  const servicesState = markerState(facts, 'page_services');
  const servicesLegible = !facts.siteRead
    ? null
    : servicesState === 'observed' || facts.services.length >= 3
      ? true
      : servicesState === 'checked_absent'
        ? false
        : null;
  push(
    'offer_not_legible',
    servicesLegible === null ? null : servicesLegible ? 0 : 1,
    !facts.siteRead
      ? 'offre non observée (site non lu)'
      : servicesLegible === null
        ? 'page de prestations non cherchée — la lisibilité de l’offre reste inconnue'
        : servicesLegible
          ? `offre lisible (${facts.services.length} prestation(s))`
          : 'offre peu lisible sur les pages lues',
  );

  pushSocialChannelGap(input, gates, weights, contributions, push);

  /**
   * R7.7 §5 — la confiance dit désormais la SUFFISANCE de la preuve, pas le
   * nombre de contributeurs présents.
   *
   * Les deux se confondaient tant que `checked_absent` était produit par le
   * simple fait qu'un octet ait été lu : la couverture valait 1 pour les
   * cinquante-quatre sites ouverts du corpus, une page comme six, et la
   * confiance publiée était donc une constante déguisée en mesure.
   *
   * Le retrait des absences hors de portée l'a rendue variable. Le plafond
   * ci-dessous ferme le dernier chemin par lequel une preuve mince pouvait
   * encore se dire haute : un écart d'acquisition SOCIALE, lui, est observé
   * intégralement, et son poids suffisait à ramener la couverture d'un crawl
   * d'une page au-dessus du seuil haut. Un canal social pleinement lu ne rend
   * pas suffisante la lecture d'un SITE ; il ajoute une preuve, il n'en répare
   * aucune.
   *
   * `weakest` plutôt qu'un remplacement : le plafond ne peut que baisser la
   * confiance. Une couverture faible reste faible même sur un site parcouru de
   * bout en bout.
   */
  const axis = computeAxis('need', contributions, profile.confidence);
  const quality = input.evidence?.quality;
  if (quality === undefined) return axis;
  const cap: AxisConfidence =
    quality.verdict === 'SUFFICIENT'
      ? 'HIGH'
      : quality.verdict === 'PARTIAL'
        ? 'MEDIUM'
        : quality.verdict === 'INSUFFICIENT'
          ? 'LOW'
          : 'NONE';
  return { ...axis, confidence: weakest(axis.confidence, cap) };
}

/**
 * R7.4 — l'écart d'acquisition SOCIALE, entré dans le besoin sous condition.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi ici, et pas dans un sixième axe
 * ---------------------------------------------------------------------------
 * Quatre architectures ont été comparées avant celle-ci (voir
 * la documentation d’installation). Celle-ci gagne pour une raison
 * structurelle : le besoin est déjà l'axe qui MESURE DES MANQUES, avec une
 * discipline écrite pour ça — un manque doit avoir été cherché pour compter,
 * `checked_absent` vaut 1, `not_checked` vaut `null`. Un canal social possédé,
 * ouvert, et mesuré muet est un manque de cette famille. Un sixième axe aurait
 * exigé une place dans la formule de priorité, donc un poids de plus décidé sur
 * trente-trois avis, et il aurait doublé le besoin sans rien dire de neuf.
 *
 * La conséquence est la BIDIRECTIONNALITÉ demandée, et elle sort de la
 * structure plutôt que d'une règle :
 *
 *   canal vivant   ratio ≈ 0 → il entre au dénominateur sans rien rapporter,
 *                  donc il FAIT BAISSER le besoin, exactement comme « tarifs
 *                  affichés » le fait baisser ;
 *   canal muet     ratio ≈ 1 → il fait MONTER le besoin, exactement comme
 *                  « aucun tarif visible » le fait monter.
 *
 * ---------------------------------------------------------------------------
 * La porte COMMERCIALE — la garantie du §7 de la mission
 * ---------------------------------------------------------------------------
 * Un compte mort ne doit pas pouvoir, À LUI SEUL, faire monter un prospect
 * médiocre. La formule de priorité amortit déjà (le besoin est multiplié par le
 * fit et la capacité), mais amortir n'est pas garantir : un fit de 46 laisse
 * encore passer 57 % de la contribution.
 *
 * La garantie est donc explicite, et elle est ÉCRITE COMME UN PLAFOND plutôt
 * que comme un interrupteur : sans dossier commercial établi, l'écart est
 * ramené à zéro. Le contributeur reste au dénominateur, il peut donc encore
 * FAIRE BAISSER le besoin d'un prospect au canal vivant — la direction sûre —
 * mais il ne peut plus en faire monter aucun. C'est la même asymétrie que celle
 * qui gouverne la maturité depuis R7.3C, appliquée au signal inverse.
 *
 * Le dossier commercial est établi par trois preuves, toutes ANTÉRIEURES et
 * INDÉPENDANTES de l'observation Instagram :
 *
 *   1. le VERDICT ICP vaut `GOOD_ICP`. Le verdict, pas la note : « c'est le
 *      verdict qui ferme la porte, jamais la note » est la doctrine de cet
 *      axe depuis R7.1, et s'en écarter ici demanderait d'inventer un seuil de
 *      fit que rien ne justifie ;
 *   2. la CAPACITÉ atteint au moins `abilityNeutral` — la valeur que le moteur
 *      s'accorde à lui-même quand il ne sait pas. Exiger au moins cela, c'est
 *      exiger « pas moins que ce qu'on supposerait par défaut ». Aucun nombre
 *      nouveau n'est introduit ;
 *   3. et elle est CONNUE : confiance `MEDIUM` ou `HIGH`. Une capacité devinée
 *      sur un quart des preuves ne fonde pas une hausse.
 *
 * Sur le corpus R7.4, aucune de ces portes ne retire un seul prospect : les cinq
 * comptes dormants observés sont tous `GOOD_ICP` et tous au-dessus du plancher.
 * C'est dit ici parce que ça compte : ces portes sont une GARANTIE, pas un
 * filtre observé à l'œuvre, et un rapport qui laisserait croire l'inverse
 * mentirait sur ce qui a été démontré.
 */
function pushSocialChannelGap(
  input: CommercialIntelligenceInput,
  gates: NeedGates,
  weights: Readonly<Record<string, number>>,
  siteContributions: readonly AxisContribution[],
  push: (key: string, ratio: number | null, detail: string) => void,
): void {
  const gap = input.social?.gap;
  if (gap === undefined) return;

  /**
   * LA PORTE QUE LA PREMIÈRE MESURE A RENDUE OBLIGATOIRE — l'écart MODULE un
   * besoin observé, il n'en CRÉE jamais un.
   *
   * ---------------------------------------------------------------------------
   * Ce qui s'est passé sans elle
   * ---------------------------------------------------------------------------
   * Un prospect dont le site n'a JAMAIS été lu n'a aucun contributeur de besoin
   * observé : l'axe rend `null`, et le moteur sort en `INSUFFICIENT_EVIDENCE` —
   * « ce n'est pas un besoin faible, c'est une absence de preuve ». C'est la
   * deuxième étape de la thèse de R7, écrite noir sur blanc dans
   * `commercialPriority`.
   *
   * Le contributeur d'écart, lui, s'observe SANS le site. Sur le premier
   * passage, il est donc devenu le seul contributeur observé d'un prospect
   * jamais crawlé, et l'axe a rendu un besoin de 100 sur la foi d'un compte
   * Instagram. Le moteur a cessé de s'abstenir sur un cas où il n'avait rien lu
   * — il est passé de 28 à 29 avis notés — et la réponse qu'il a fabriquée était
   * fausse (`CAR ATELIER`, humain OUI, moteur NON).
   *
   * ---------------------------------------------------------------------------
   * Pourquoi ce n'est pas un correctif de circonstance
   * ---------------------------------------------------------------------------
   * Parce que l'abstention est un RÉSULTAT, pas un trou à combler. Un canal
   * social muet ne dit rien de la présence d'un tarif, d'un devis, d'une mesure
   * d'acquisition ou d'un chemin de réservation — c'est-à-dire de tout ce que
   * l'axe du besoin mesure. Lui laisser porter l'axe à lui seul, c'est répondre
   * à une question qu'on n'a pas instruite, et c'est exactement l'erreur que le
   * §5 de la mission range sous « absence de preuve ≠ preuve d'absence ».
   *
   * La porte est donc STRUCTURELLE : au moins un manque du site doit avoir été
   * observé. La liste est lue plutôt que devinée — `facts.siteRead` aurait été
   * un proxy, et un proxy se désaligne du jour où un contributeur change.
   */
  const siteNeedObserved = siteContributions.some((contribution) => contribution.ratio !== null);
  if (!siteNeedObserved) return;

  /**
   * Le poids est lu SEULEMENT quand un écart est fourni : un profil qui n'a
   * jamais entendu parler de ce contributeur reste chargeable, et Model A comme
   * Model B restent évaluables mot pour mot avec le fichier d'aujourd'hui.
   * Poids zéro ⇒ le contributeur n'existe pas, plutôt qu'il pèse zéro : un
   * contributeur à zéro polluerait quand même les motifs publiés.
   */
  const weight = weightOf(weights, 'social_channel_gap', 'need');
  if (weight <= 0) return;

  if (gap.ratio === null) {
    push('social_channel_gap', null, gap.detail);
    return;
  }

  const settings = input.profile.priority;
  const ability = gates.abilityToPay;
  const icpEstablished = input.icp?.verdict === 'GOOD_ICP';
  const abilityKnown = ability.confidence === 'HIGH' || ability.confidence === 'MEDIUM';
  const abilityEstablished = ability.score !== null && ability.score >= settings.abilityNeutral && abilityKnown;
  const commercialCase = icpEstablished && abilityEstablished;

  if (commercialCase) {
    push('social_channel_gap', gap.ratio, gap.detail);
    return;
  }

  const refusals: string[] = [];
  if (!icpEstablished) refusals.push(`verdict ICP ${input.icp?.verdict ?? 'non évalué'} au lieu de GOOD_ICP`);
  if (!abilityEstablished) {
    refusals.push(
      ability.score === null
        ? 'capacité à payer non observée'
        : `capacité ${ability.score}/100 (confiance ${ability.confidence}) sous le plancher ${settings.abilityNeutral}/CONNUE`,
    );
  }
  /**
   * Plafonné à `0` : le contributeur reste au dénominateur — un canal VIVANT
   * fait donc toujours baisser le besoin, y compris sans dossier commercial —
   * mais aucun écart ne peut plus rien ajouter.
   */
  push(
    'social_channel_gap',
    0,
    `${gap.detail} — mais aucune hausse n’est accordée : ${refusals.join(' ; ')}. ` +
      'Un canal social négligé ne fabrique pas à lui seul un prospect.',
  );
}

/**
 * R7.4 — les axes déjà tranchés dont le besoin a besoin pour PLAFONNER l'écart
 * social, et pour rien d'autre.
 *
 * C'est une dépendance nouvelle et à sens unique entre deux axes, et il faut la
 * nommer plutôt que la glisser : jusqu'ici les cinq axes étaient indépendants et
 * ne se rencontraient que dans la formule de priorité. Elle est acceptée parce
 * que la question posée l'exige — « un manque est-il un BESOIN ? » ne se répond
 * pas sans savoir si quelqu'un pourrait l'adresser — et parce qu'elle ne
 * recalcule rien : le besoin LIT un verdict fini, comme `icpFitAxis` lit déjà le
 * verdict ICP. Deux implémentations de « cette entreprise peut-elle acheter ? »
 * finiraient par se contredire.
 *
 * Elle reste acyclique : la capacité ne lit pas le besoin.
 */
interface NeedGates {
  readonly abilityToPay: AxisResult;
}

function ratioOfGap(state: MarkerState): number | null {
  if (state === 'not_checked') return null;
  return state === 'checked_absent' ? 1 : 0;
}

function describeGap(state: MarkerState, label: string): string {
  if (state === 'not_checked') return `${label} non cherché`;
  return state === 'checked_absent' ? `aucun(e) ${label} sur les pages lues` : `${label} en place`;
}

// ---------------------------------------------------------------------------
// D — ABILITY TO PAY
// ---------------------------------------------------------------------------

function yearsSince(dateIso: unknown, now: Date): number | null {
  if (typeof dateIso !== 'string') return null;
  const date = new Date(dateIso);
  if (Number.isNaN(date.getTime())) return null;
  return (now.getTime() - date.getTime()) / (365.25 * 24 * 3600 * 1000);
}

/**
 * « Peut-elle acheter, et absorber les clients que nous lui apporterions ? »
 *
 * Cet axe est écrit CONTRE une tentation précise : rejeter les petits. Un jeune
 * artisan au budget modeste mais au travail réel est souvent le meilleur
 * client, parce qu'un premier chiffre le transforme. La capacité sert donc à
 * écarter le loisir — quelqu'un qui ne vend rien — et rien de plus. C'est
 * pourquoi elle n'entre dans la priorité que comme un PLANCHER
 * (`abilityFloor`), jamais comme un multiplicateur qui récompenserait la
 * taille.
 *
 * Le nombre d'abonnés n'y figure pas, et n'y figurera pas. La règle est plus
 * ancienne que R7 (`score.ts`, `tests/commercial/commercialScore.test.ts` :
 * « ne bouge pas d'un point quand on ajoute une evidence d'abonnés ») et R7 ne
 * la relâche pas.
 */
function abilityToPayAxis(input: CommercialIntelligenceInput, now: Date): AxisResult {
  const { prospect, facts, profile } = input;
  const weights = profile.weights.abilityToPay;
  const attributes = facts.registryAttributes;
  const contributions: AxisContribution[] = [];

  const push = (key: string, ratio: number | null, detail: string): void => {
    contributions.push({ key, ratio, weight: weightOf(weights, key, 'abilityToPay'), detail });
  };

  const registered = prospect.registry_id !== null && prospect.registry_id.trim().length > 0;
  push(
    'registered_business',
    registered ? 1 : null,
    registered ? `entreprise immatriculée (${prospect.registry_id})` : 'immatriculation non observée',
  );

  const years = yearsSince(attributes['dateCreation'], now);
  push(
    'operating_history',
    years === null ? null : years < 0.5 ? 0.35 : years < 1 ? 0.6 : years < 3 ? 0.85 : 1,
    years === null ? 'date de création non observée' : `${years.toFixed(1)} an(s) d’activité`,
  );

  const tranche = attributes['trancheEffectif'];
  const nature = String(attributes['natureJuridique'] ?? '');
  const trancheCode = tranche === undefined || tranche === null ? null : String(tranche);
  const hasEmployees = trancheCode !== null && trancheCode !== 'NN' && trancheCode !== '00';
  const isCompany = nature.startsWith('5') || nature.startsWith('6');
  push(
    'employer_or_company',
    trancheCode === null && nature.length === 0 ? null : hasEmployees ? 1 : isCompany ? 0.7 : 0.5,
    trancheCode === null && nature.length === 0
      ? 'effectif et forme juridique non observés'
      : hasEmployees
        ? `salariés déclarés (tranche INSEE ${trancheCode})`
        : isCompany
          ? 'société sans salarié déclaré'
          : 'entrepreneur individuel',
  );

  push(
    'basket_size',
    facts.siteRead ? Math.min(1, 0.3 + 0.14 * facts.premiumServices.length) : null,
    facts.siteRead
      ? facts.premiumServices.length > 0
        ? `panier moyen élevé (${facts.premiumServices.slice(0, 3).join(', ')})`
        : 'aucune prestation à panier élevé citée'
      : 'prestations non observées (site non lu)',
  );

  /**
   * Vend-elle vraiment ? Des prestations nommées, un site lu, des avis publics.
   * C'est ce contributeur qui sépare un artisan qui travaille d'un compte qui
   * existe — et il ne mesure jamais la taille.
   */
  const activityProofs: string[] = [];
  let activity = 0;
  if (facts.services.length >= 3) {
    activity += 0.4;
    activityProofs.push(`${facts.services.length} prestations nommées`);
  } else if (facts.services.length > 0) {
    activity += 0.2;
    activityProofs.push(`${facts.services.length} prestation(s) nommée(s)`);
  }
  if (facts.siteRead) {
    activity += 0.3;
    activityProofs.push('site ouvert et lu');
  }
  if ((prospect.google_review_count ?? 0) > 0) {
    activity += 0.3;
    activityProofs.push(`${prospect.google_review_count} avis publics`);
  }
  push(
    'commercial_activity',
    activityProofs.length === 0 ? null : Math.min(1, activity),
    activityProofs.length === 0 ? 'aucune activité commerciale observée' : activityProofs.join(', '),
  );

  return computeAxis('abilityToPay', contributions, profile.confidence);
}

// ---------------------------------------------------------------------------
// E — TIMING
// ---------------------------------------------------------------------------

/**
 * « Pourquoi maintenant ? »
 *
 * Presque toujours UNKNOWN, et c'est la réponse honnête. Nos données ne portent
 * aujourd'hui aucun signal de moment : ni date de dernière publication, ni
 * ouverture récente, ni recrutement, ni saisonnalité observée. Le seul fait
 * lisible est `promo_offer` — une opération commerciale en cours sur le site.
 *
 * Le §14 de la mission est explicite et ce module s'y tient : ne fabrique pas
 * d'urgence. Un axe qui rend UNKNOWN pour 95 % du corpus n'est pas un axe raté,
 * c'est un axe qui refuse de mentir, et sa contribution à la priorité est
 * plafonnée à quelques points pour cette raison.
 */
function timingAxis(input: CommercialIntelligenceInput): AxisResult {
  const { facts, profile } = input;
  const weights = profile.weights.timing;
  const state = markerState(facts, 'promo_offer');
  return computeAxis(
    'timing',
    [
      {
        key: 'promotional_push',
        weight: weightOf(weights, 'promotional_push', 'timing'),
        ratio: ratioOfGap(state) === null ? null : state === 'observed' ? 1 : 0,
        detail:
          state === 'not_checked'
            ? 'aucun signal de moment observable dans nos données'
            : state === 'observed'
              ? 'opération commerciale en cours sur le site'
              : 'aucune opération commerciale en cours sur les pages lues',
      },
    ],
    profile.confidence,
  );
}

// ---------------------------------------------------------------------------
// COMMERCIAL PRIORITY
// ---------------------------------------------------------------------------

function weakest(a: AxisConfidence, b: AxisConfidence): AxisConfidence {
  const order: readonly AxisConfidence[] = ['NONE', 'LOW', 'MEDIUM', 'HIGH'];
  return order.indexOf(a) <= order.indexOf(b) ? a : b;
}

/**
 * La priorité commerciale.
 *
 * L'ordre des opérations EST la thèse de R7, et chaque étape est écrite contre
 * une façon précise de se tromper :
 *
 *   1. hors cible → on s'arrête. Aucun besoin, aussi criant soit-il, ne rend
 *      une franchise contactable ;
 *   2. besoin non observé → `INSUFFICIENT_EVIDENCE`, jamais « faible ». C'est
 *      la distinction que le §16 de la mission exige et que le score actuel ne
 *      sait pas faire ;
 *   3. le BESOIN porte le score. Pas le fit, pas la qualité, pas la taille ;
 *   4. la MATURITÉ le freine. C'est la correction du cas à 87 ;
 *   5. le FIT qualifie — il multiplie, il n'ajoute pas. Un fit parfait sans
 *      besoin reste à zéro, ce qui est le point de départ de toute la mission ;
 *   6. la CAPACITÉ borne par le bas, sans jamais récompenser la taille ;
 *   7. le MOMENT ajoute quelques points, et seulement s'il a été observé.
 */
function commercialPriority(
  axes: Record<AxisKey, AxisResult>,
  icp: IcpAssessment | null,
  profile: CommercialIntelligenceProfile,
  social: SocialPriorityInput | undefined,
  opportunity: ScalableOpportunityAssessment | undefined,
  /** R7.7 — la qualité de la preuve, quand le round l'évalue. Voir le plafond plus bas. */
  evidenceQuality: EvidenceQuality | undefined,
): Pick<CommercialIntelligenceResult, 'commercialPriority' | 'priorityBand' | 'decision' | 'confidence' | 'reasons'> {
  const settings = profile.priority;
  const reasons: string[] = [];

  if (icp?.verdict === 'NOT_TARGET') {
    return {
      commercialPriority: 0,
      priorityBand: 'LOW',
      decision: 'DO_NOT_PRIORITIZE',
      confidence: axes.icpFit.confidence,
      reasons: [`hors cible ICP — ${icp.reason}`],
    };
  }

  /**
   * R7.6 — la porte d'éligibilité, à la MÊME MARCHE que le verdict ICP.
   *
   * Sa place dans l'ordre EST son sens. Elle vient avant que le besoin ne soit
   * lu, donc aucun manque de funnel, aussi criant soit-il, ne peut ramener dans
   * la cible une entreprise qui n'en est pas — c'est le cas C de la mission
   * (« franchise au site excellent ») et le cas D (« audience déjà très
   * grande »), et c'est la même règle que R7.1 avait déjà écrite pour le réseau.
   *
   * Elle ne fait rien de plus. `REVIEW_REQUIRED` n'abaisse aucune priorité —
   * un doute n'est pas un refus — et `UNKNOWN` encore moins : ne pas savoir
   * quel type d'entreprise on regarde ne rend personne hors cible.
   */
  if (opportunity?.eligibility.verdict === 'OUT_OF_SCOPE') {
    return {
      commercialPriority: 0,
      priorityBand: 'LOW',
      decision: 'DO_NOT_PRIORITIZE',
      confidence: axes.icpFit.confidence,
      reasons: [`hors cible — ${opportunity.eligibility.reason}`, ...opportunity.eligibility.reasons.slice(0, 3)],
    };
  }

  const need = axes.need;
  if (need.score === null) {
    return {
      commercialPriority: null,
      priorityBand: 'UNKNOWN',
      decision: 'INSUFFICIENT_EVIDENCE',
      confidence: 'NONE',
      reasons: [
        'aucun manque commercial observé — le site n’a pas été lu. ' +
          'Ce n’est pas un besoin faible, c’est une absence de preuve.',
      ],
    };
  }

  const ability = axes.abilityToPay;
  if (ability.score !== null && ability.score < settings.abilityHobbyFloor && ability.confidence !== 'LOW') {
    return {
      commercialPriority: 0,
      priorityBand: 'LOW',
      decision: 'DO_NOT_PRIORITIZE',
      confidence: ability.confidence,
      reasons: [`aucune activité commerciale suffisante observée (capacité ${ability.score}/100)`],
    };
  }

  const webMaturity = axes.acquisitionMaturity.score ?? settings.maturityNeutral;
  /**
   * R7.3C §23–§25 — la maturité EFFECTIVE, quand une observation sociale existe.
   *
   * La règle : le social ne peut que FAIRE MONTER la maturité, jamais la faire
   * descendre. L'asymétrie est délibérée et se défend dans les deux sens.
   *
   *   - vers le haut : un compte Instagram tenu, régulier, complet, EST une
   *     acquisition déjà structurée. Le site n'est pas le seul endroit où une
   *     entreprise organise sa demande, et c'est tout le constat de R7.1 sur le
   *     cas à 87 ;
   *   - vers le bas : un Instagram faible ne prouve pas que le SITE ne mesure
   *     rien. Autoriser une baisse ferait monter la priorité de tout prospect au
   *     compte négligé — c'est-à-dire produirait des faux-hauts, l'erreur qui
   *     coûte un message envoyé pour rien.
   *
   * `blend = 0` rend exactement `webMaturity` : Model A est le cas particulier,
   * pas une branche séparée.
   */
  /**
   * R7.6 §7 — ce qui entre ici est la STRUCTURE d'acquisition, pas l'activité.
   *
   * `acquisitionStructureScore` absent ⇒ le champ n'existe pas pour ce modèle et
   * la maturité sociale complète est lue, exactement comme en R7.3C/R7.4.
   * Fourni ⇒ seule la part « machinerie de conversion » du canal social peut
   * faire monter la maturité, donc freiner la priorité. Un compte animé mais
   * sans funnel cesse d'être lu comme une acquisition déjà organisée.
   */
  const socialScore =
    social === undefined
      ? null
      : social.acquisitionStructureScore !== undefined
        ? social.acquisitionStructureScore
        : social.score;
  const blend = social?.blend ?? 0;
  const maturityValue =
    socialScore === null || blend <= 0 ? webMaturity : webMaturity + blend * Math.max(0, socialScore - webMaturity);
  const maturityFactor = 1 - settings.maturityDrag * (maturityValue / 100);
  const fitValue = axes.icpFit.score ?? 100 * settings.fitFloor;
  const fitFactor = settings.fitFloor + (1 - settings.fitFloor) * (fitValue / 100);
  const abilityValue = ability.score ?? settings.abilityNeutral;
  const abilityFactor = settings.abilityFloor + (1 - settings.abilityFloor) * (abilityValue / 100);
  const timingBonus = ((axes.timing.score ?? 0) / 100) * settings.timingBonusMax;

  const raw = need.score * maturityFactor * fitFactor * abilityFactor + timingBonus;
  const priority = Math.max(0, Math.min(100, Math.round(raw)));

  reasons.push(`besoin observé ${need.score}/100`);
  if (axes.acquisitionMaturity.score !== null) {
    reasons.push(
      `acquisition déjà structurée à ${maturityValue}/100 — la priorité est réduite de ` +
        `${Math.round((1 - maturityFactor) * 100)}%`,
    );
  } else {
    reasons.push('maturité d’acquisition inconnue — valeur neutre appliquée, ni bonus ni pénalité');
  }
  // Publié seulement quand le social a RÉELLEMENT déplacé la valeur : une ligne
  // « apport social 0 » sur 244 prospects jamais collectés noierait le signal.
  if (socialScore !== null && blend > 0 && maturityValue !== webMaturity) {
    reasons.push(
      `${
        social?.acquisitionStructureScore === undefined
          ? 'maturité sociale observée'
          : 'structure d’acquisition sociale observée'
      } ${socialScore}/100 — maturité effective portée de ${webMaturity} ` +
        `à ${Math.round(maturityValue)}/100 (apport ${blend})`,
    );
  }
  if (axes.icpFit.score !== null) reasons.push(`fit ICP ${axes.icpFit.score}/100`);
  if (ability.score !== null) reasons.push(`capacité estimée ${ability.score}/100`);
  if (timingBonus > 0) reasons.push('signal de moment observé');

  /**
   * R7.7 §5 — la confiance cesse d'être publiée puis ignorée.
   *
   * Elle l'était : la formule de priorité lit `need.score` et ne regarde jamais
   * `need.confidence`, si bien qu'un besoin de 96 établi sur une page d'accueil
   * conduisait exactement à la même décision qu'un besoin de 96 établi sur six
   * pages parcourues. Publier une mesure qu'aucune décision ne lit, c'est ne pas
   * l'avoir prise.
   *
   * Le plafond ne touche NI le score NI la priorité, et ne transforme aucun
   * inconnu en zéro — le §5 l'interdit et il a raison. Il porte sur ce que la
   * décision AFFIRME : `PRIORITIZE` dit « il faut y aller maintenant », et cette
   * phrase-là demande de savoir ce que ce site offre et n'offre pas. Une preuve
   * qui n'a pas pu établir la seconde moitié ne la soutient pas. `CONSIDER`, qui
   * dit « ça mérite un œil », reste parfaitement accessible.
   *
   * C'est la même forme que la porte d'éligibilité de R7.6 : une garde qui ne
   * peut que FERMER, jamais ouvrir. Une preuve suffisante ne fait monter
   * personne.
   */
  const evidenceCapsPriority =
    axes.need.confidence === 'LOW' || axes.need.confidence === 'MEDIUM' || axes.need.confidence === 'NONE';
  const rawDecision: CommercialDecision =
    priority >= settings.bands.prioritize
      ? 'PRIORITIZE'
      : priority >= settings.bands.consider
        ? 'CONSIDER'
        : 'DEPRIORITIZE';
  const decision: CommercialDecision =
    rawDecision === 'PRIORITIZE' && evidenceCapsPriority && evidenceQuality !== undefined
      ? 'CONSIDER'
      : rawDecision;
  if (decision !== rawDecision) {
    reasons.push(
      `priorité plafonnée à CONSIDER : le besoin est établi sur une preuve ${axes.need.confidence} — ` +
        (evidenceQuality?.detail ?? 'couverture insuffisante'),
    );
  }

  const confidence = weakest(need.confidence, axes.acquisitionMaturity.confidence);

  return { commercialPriority: priority, priorityBand: bandOf(priority), decision, confidence, reasons };
}

/** Le point d'entrée. Pur : mêmes entrées, même sortie, sans horloge implicite. */
export function assessCommercialIntelligence(
  input: CommercialIntelligenceInput,
  now: Date,
): CommercialIntelligenceResult {
  /**
   * R7.4 — l'ordre d'évaluation est désormais SIGNIFIANT, et seulement ici.
   *
   * La capacité est calculée d'abord parce que le besoin la lit pour plafonner
   * l'écart d'acquisition sociale (voir `pushSocialChannelGap`). Le verdict ICP,
   * lui, n'a jamais eu besoin d'un axe : il arrive déjà tranché dans l'entrée.
   * Aucun autre couplage n'existe, et l'objet rendu garde exactement les mêmes
   * cinq clés : rien de ce qui lisait `axes` n'a à bouger.
   */
  const abilityToPay = abilityToPayAxis(input, now);
  const axes: Record<AxisKey, AxisResult> = {
    icpFit: icpFitAxis(input),
    acquisitionMaturity: acquisitionMaturityAxis(input),
    need: needAxis(input, { abilityToPay }),
    abilityToPay,
    timing: timingAxis(input),
  };

  /**
   * L'opportunité est construite APRÈS les axes et AVANT la priorité : elle lit
   * les premiers, et la seconde lit sa porte. L'ordre est une dépendance, pas
   * une commodité.
   */
  const opportunity = input.opportunityFor?.({ need: axes.need, abilityToPay: axes.abilityToPay });
  const priority = commercialPriority(axes, input.icp, input.profile, input.social, opportunity, input.evidence?.quality);
  const missingSignals = [
    ...new Set(
      (Object.keys(axes) as AxisKey[]).flatMap((key) => axes[key].missing.map((entry) => `${key}.${entry}`)),
    ),
  ];

  return {
    axes,
    icpVerdict: input.icp?.verdict ?? null,
    opportunity: opportunity ?? null,
    ...priority,
    missingSignals,
    profileKey: input.profile.key,
    profileVersion: input.profile.version,
  };
}
