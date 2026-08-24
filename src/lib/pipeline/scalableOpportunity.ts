import {
  foldWeightedContributions,
  type AxisBand,
  type AxisConfidence,
  type ConfidenceThresholds,
  type WeightedAxisFold,
  type WeightedContribution,
} from '@/lib/pipeline/weightedAxis';
import type { IcpAssessment } from '@/lib/pipeline/icpEligibility';
import type { CoreActivityAssessment } from '@/lib/pipeline/coreActivity';
import type { SocialMaturityResult } from '@/lib/pipeline/socialMaturity';
import type { ScalableOpportunityConfig } from '@/lib/config/schema';

/**
 * R7.6 — « SCALABLE OPPORTUNITY », et non « DIGITAL MATURITY ».
 *
 * ---------------------------------------------------------------------------
 * La confusion que ce module existe pour défaire
 * ---------------------------------------------------------------------------
 * R7.1 avait déjà séparé « bon business » de « bon prospect ». La revue humaine
 * de R7.5 montre qu'il restait une seconde confusion, d'un autre ordre : le
 * moteur lisait une entreprise MÛRE comme une entreprise SERVIE, et une
 * entreprise VIVANTE sur les réseaux comme une entreprise qui a déjà organisé sa
 * demande. Les deux lectures sont fausses, et elles se corrigent séparément.
 *
 * La cible réelle est un petit ou moyen opérateur indépendant, au service
 * crédible, à l'activité réelle, capable de payer — et dont l'acquisition n'est
 * PAS encore une machine. Ce qui la définit n'est donc ni la qualité du site, ni
 * le nombre d'abonnés, ni l'âge de l'entreprise pris isolément : c'est la
 * MARGE DE PROGRESSION, mesurée sur des faits observés.
 *
 * ---------------------------------------------------------------------------
 * Deux objets de nature différente, jamais fondus dans un score
 * ---------------------------------------------------------------------------
 * Le round a comparé cinq architectures.
 * Celle-ci gagne parce qu'elle refuse de mélanger deux CATÉGORIES de jugement :
 *
 *   ÉLIGIBILITÉ    un VERDICT. « Cette entreprise est-elle du type que nous
 *                  servons ? » Une franchise, une antenne de réseau, un compte
 *                  déjà hors de notre créneau ne sont pas des prospects
 *                  FAIBLES : ils sont HORS CIBLE, et aucun besoin, aussi criant
 *                  soit-il, ne les y ramène. Le moteur possédait déjà exactement
 *                  une porte de cette famille — `icpVerdict === NOT_TARGET` — et
 *                  ce module la GÉNÉRALISE au lieu d'en ouvrir une seconde.
 *
 *   OPPORTUNITÉ    des BANDES lisibles. Marge d'audience, ancienneté du
 *                  business, intention organique. Publiées, explicables, et
 *                  ARMÉES À ZÉRO en R7.6 : aucune n'entre dans la formule de
 *                  priorité. C'est la discipline de R7.4 appliquée à nouveau —
 *                  on MESURE un round, on ARME le suivant, et un poids choisi
 *                  sur soixante-deux avis n'est pas un poids, c'est un souvenir.
 *
 * Aucun nombre nouveau n'est donc ajusté sur le jeu d'or. Les deux seuls
 * changements qui déplacent une décision sont STRUCTURELS et se défendent sans
 * les étiquettes : la porte d'éligibilité, et la dé-confusion de l'activité
 * organique (`partitionSocialReading`).
 *
 * ---------------------------------------------------------------------------
 * Ce qui n'entre jamais ici
 * ---------------------------------------------------------------------------
 * L'ÂGE D'UNE PERSONNE. Ni collecté, ni inféré, ni approché par un proxy — pas
 * d'année de naissance, pas d'âge apparent sur une photo, pas de signal
 * démographique. `classifyBusinessTenure` lit `dateCreation`, qui est la date
 * d'immatriculation d'une ENTREPRISE au registre, et rien d'autre. La distinction
 * n'est pas rhétorique : l'ancienneté d'une société est un fait public et
 * commercial, l'âge de son dirigeant est une donnée personnelle sensible qui
 * n'a aucune place dans un scoring.
 *
 * Tout est pur et déterministe : mêmes observations, même sortie, sans horloge
 * implicite, sans réseau, sans prompt.
 */

// ---------------------------------------------------------------------------
// A — ÉCHELLE D'AUDIENCE
// ---------------------------------------------------------------------------

/**
 * La taille de l'audience sociale, en bandes plutôt qu'en points.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi le nombre d'abonnés entre ici, et NULLE PART ailleurs
 * ---------------------------------------------------------------------------
 * `score.ts` refuse depuis R5 de bouger d'un point quand on lui ajoute une
 * preuve d'abonnés, et `abilityToPayAxis` le redit en toutes lettres. Cette
 * règle ne change pas et ce module ne la contredit pas : elle interdit de lire
 * un compteur d'abonnés comme une PREUVE DE BESOIN D'ACQUISITION, et cette
 * lecture reste fausse. Un compte à 40 abonnés et un compte à 13 000 abonnés,
 * muets depuis la même durée, décrivent le même silence.
 *
 * Ce que le compteur dit en revanche honnêtement, c'est une TAILLE. Et la taille
 * est une question d'éligibilité, pas de besoin : au-delà d'un certain volume,
 * une entreprise n'est plus dans le créneau que nous savons servir, quelle que
 * soit la qualité de son funnel. C'est une règle métier, elle est écrite comme
 * telle, et elle est publiée en configuration plutôt que dissoute dans un poids.
 *
 * ---------------------------------------------------------------------------
 * L'exigence d'attribution
 * ---------------------------------------------------------------------------
 * Un compteur ne vaut que si le compte est bien celui du prospect. Le corpus
 * porte le contre-exemple : un profil à 308 000 abonnés dont l'identité est
 * `UNCORROBORATED`. L'attribuer aurait fait d'un artisan une marque nationale.
 * La bande n'est donc calculée qu'à partir d'une observation dont l'identité est
 * corroborée — la même barre que `assessSocialMaturity`, qui refuse déjà de
 * noter un profil non corroboré. Sans elle : `UNKNOWN`, jamais une supposition.
 */
export type AudienceScaleBand = 'EMERGING' | 'GROWING' | 'ESTABLISHED' | 'OUT_OF_SWEET_SPOT' | 'UNKNOWN';

export interface AudienceScale {
  readonly band: AudienceScaleBand;
  /** Le compteur RÉELLEMENT observé, ou `null`. Jamais estimé, jamais complété. */
  readonly followers: number | null;
  /** Le compte est-il attribué à ce prospect ? `false` ⇒ la bande reste UNKNOWN. */
  readonly attributed: boolean;
  readonly detail: string;
}

export interface AudienceObservation {
  /** Le nombre d'abonnés lu sur le profil, ou `null` si jamais lu. */
  readonly followers: number | null;
  /** L'identité du compte a-t-elle été corroborée (`MATCH`) ? */
  readonly attributed: boolean;
}

export function classifyAudienceScale(
  observation: AudienceObservation | null,
  config: ScalableOpportunityConfig,
): AudienceScale {
  if (observation === null) {
    return {
      band: 'UNKNOWN',
      followers: null,
      attributed: false,
      detail: 'aucun profil social observé — l’audience est inconnue, ni petite ni grande',
    };
  }
  if (!observation.attributed) {
    return {
      band: 'UNKNOWN',
      followers: observation.followers,
      attributed: false,
      detail:
        'compte social non attribué à ce prospect — son audience ne lui est pas comptée, ' +
        'quelle qu’en soit la taille',
    };
  }
  const followers = observation.followers;
  if (followers === null) {
    return {
      band: 'UNKNOWN',
      followers: null,
      attributed: true,
      detail: 'profil ouvert mais nombre d’abonnés non lu — inconnu, pas nul',
    };
  }

  const { audience } = config;
  if (followers >= audience.outOfSweetSpotAtOrAbove) {
    return {
      band: 'OUT_OF_SWEET_SPOT',
      followers,
      attributed: true,
      detail:
        `${followers} abonnés — au-delà de ${audience.outOfSweetSpotAtOrAbove}, une audience de cette taille ` +
        'décrit une entreprise déjà installée sur le canal, hors du créneau que nous savons servir',
    };
  }
  if (followers >= audience.growingBelow) {
    return {
      band: 'ESTABLISHED',
      followers,
      attributed: true,
      detail: `${followers} abonnés — audience installée, marge de progression plus faible`,
    };
  }
  if (followers >= audience.emergingBelow) {
    return {
      band: 'GROWING',
      followers,
      attributed: true,
      detail: `${followers} abonnés — audience en construction, marge de progression réelle`,
    };
  }
  return {
    band: 'EMERGING',
    followers,
    attributed: true,
    detail: `${followers} abonnés — audience naissante : une faible audience n’est ni un défaut ni un mérite en soi`,
  };
}

/**
 * « Cette audience ferme-t-elle la porte ? » — la question posée UNE fois.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi un prédicat exporté plutôt que la condition recopiée
 * ---------------------------------------------------------------------------
 * Depuis l'audit du 21 août 2026, cette règle n'est plus lue par le seul rail
 * d'analyse R7 : les deux portes qui décident réellement d'un envoi — le
 * verrouillage d'un manifeste (`lockManifestForItem`) et l'entrée de la file
 * Instagram (`evaluateInstagramEligibility`) — la lisent aussi. Trois lecteurs
 * pour une règle, c'est trois occasions de la recopier, et trois copies d'un
 * seuil finissent toujours par diverger — exactement ce que le dépôt refuse
 * partout ailleurs (« deux réponses à “est-ce une franchise ?” est une de
 * trop »).
 *
 * Le prédicat vit donc ici, à côté des bandes qu'il lit, et `hardExclude…`
 * reste ce qui l'arme : désarmé, la bande est publiée et ne ferme rien.
 */
export function audienceIsOutOfScope(audience: AudienceScale, config: ScalableOpportunityConfig): boolean {
  return audience.band === 'OUT_OF_SWEET_SPOT' && config.audience.hardExcludeOutOfSweetSpot;
}

// ---------------------------------------------------------------------------
// B — ANCIENNETÉ DU BUSINESS (jamais de l'humain)
// ---------------------------------------------------------------------------

/**
 * Depuis combien de temps l'ENTREPRISE existe, lu au registre.
 *
 * ---------------------------------------------------------------------------
 * La ligne qu'il ne faut pas franchir, et pourquoi elle est ici
 * ---------------------------------------------------------------------------
 * Le §11 de la mission R7.6 l'interdit sans réserve : aucun âge de personne,
 * aucune année de naissance, aucun âge apparent, aucun proxy démographique. Une
 * revue humaine du corpus porte pourtant, noir sur blanc, une décision motivée
 * par « il a l'air vieux » — ce qui prouve que la tentation est réelle et qu'elle
 * s'exprime spontanément. Ce module est l'endroit où elle aurait pu se glisser,
 * puisqu'il parle d'ancienneté ; il est donc l'endroit où le refus doit être
 * écrit et testé.
 *
 * `dateCreation` est la date d'immatriculation d'une personne MORALE. Elle ne
 * renseigne pas l'âge de qui que ce soit, elle n'est corrélée à aucune donnée
 * personnelle que nous détenons, et c'est la seule ancienneté que ce dépôt
 * connaîtra.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi des bandes descriptives et aucun point
 * ---------------------------------------------------------------------------
 * Le §10 dit une PRÉFÉRENCE — des entreprises récentes ou en croissance plutôt
 * qu'installées depuis très longtemps — et interdit dans la même phrase
 * d'inventer un seuil pour faire monter une métrique. Une préférence sans preuve
 * mesurée est une hypothèse : elle se publie, elle ne se pondère pas. Les
 * frontières viennent de la configuration, pas du code, et elles sont armées à
 * zéro dans la formule de priorité.
 *
 * `operating_history` (axe CAPACITÉ) lit la même date et récompense l'ancienneté.
 * Il n'y a pas de contradiction : cet axe-là mesure « cette entreprise
 * survivra-t-elle assez pour payer », qui est une autre question, et une
 * entreprise de dix ans y répond mieux. Les deux lectures coexistent parce
 * qu'elles ne portent pas sur la même chose.
 */
export type BusinessTenureBand = 'NEW' | 'GROWING' | 'ESTABLISHED' | 'LEGACY' | 'UNKNOWN';

export interface BusinessTenure {
  readonly band: BusinessTenureBand;
  readonly years: number | null;
  readonly detail: string;
}

/** Années écoulées depuis une date ISO, ou `null`. Aucune horloge implicite. */
function yearsSince(dateIso: unknown, now: Date): number | null {
  if (typeof dateIso !== 'string') return null;
  const date = new Date(dateIso);
  if (Number.isNaN(date.getTime())) return null;
  return (now.getTime() - date.getTime()) / (365.25 * 24 * 3600 * 1000);
}

export function classifyBusinessTenure(
  registryDateCreation: unknown,
  now: Date,
  config: ScalableOpportunityConfig,
): BusinessTenure {
  const years = yearsSince(registryDateCreation, now);
  if (years === null) {
    return {
      band: 'UNKNOWN',
      years: null,
      detail: 'date de création de l’entreprise non observée au registre',
    };
  }
  const { tenure } = config;
  const rounded = Math.round(years * 10) / 10;
  if (years < tenure.newBelowYears) {
    return { band: 'NEW', years: rounded, detail: `entreprise immatriculée depuis ${rounded} an(s)` };
  }
  if (years < tenure.growingBelowYears) {
    return { band: 'GROWING', years: rounded, detail: `entreprise immatriculée depuis ${rounded} an(s)` };
  }
  if (years < tenure.establishedBelowYears) {
    return { band: 'ESTABLISHED', years: rounded, detail: `entreprise immatriculée depuis ${rounded} an(s)` };
  }
  return { band: 'LEGACY', years: rounded, detail: `entreprise immatriculée depuis ${rounded} an(s)` };
}

// ---------------------------------------------------------------------------
// C — ACTIVITÉ ORGANIQUE ≠ STRUCTURE D'ACQUISITION
// ---------------------------------------------------------------------------

/**
 * R7.6 §7 — la correction la plus lourde de conséquences du round.
 *
 * ---------------------------------------------------------------------------
 * L'hypothèse implicite que R7.3C avait armée
 * ---------------------------------------------------------------------------
 * `socialAcquisitionMaturity` porte cinq contributeurs, dont
 * `posting_recency` (34) et `posting_cadence` (30) : à eux deux, 64 % du poids.
 * Ce score alimente ensuite la maturité EFFECTIVE du moteur commercial, laquelle
 * FREINE la priorité (`maturityDrag`). Le circuit complet dit donc, sans que
 * personne l'ait décidé :
 *
 *     « ce artisan publie régulièrement, donc son acquisition est structurée,
 *       donc il a moins besoin de nous. »
 *
 * La revue humaine réfute exactement cette phrase, et la mission la déclare
 * fausse : un artisan qui poste trois fois par semaine démontre qu'il croit aux
 * réseaux, qu'il sait produire du contenu et qu'il accepte le digital. C'est un
 * argument POUR l'appeler, pas contre.
 *
 * ---------------------------------------------------------------------------
 * Partitionner plutôt que repondérer
 * ---------------------------------------------------------------------------
 * On aurait pu changer les poids de `config/r7-social-maturity.json`. Ç'aurait
 * été une erreur de méthode : R7.3C et R7.4 ont été MESURÉS avec ces poids, et
 * les modifier rendrait MODEL B et MODEL C irreproductibles — donc la
 * comparaison A/B/C/D fausse, c'est-à-dire précisément ce que le round existe
 * pour produire.
 *
 * Cette fonction ne recalcule donc RIEN. Elle relit les contributeurs DÉJÀ
 * calculés et les replie en deux sous-lectures, avec la même arithmétique et la
 * même discipline du `null` :
 *
 *   ACTIVITÉ ORGANIQUE      récence, cadence, qualité visuelle. « Cette
 *                           entreprise anime-t-elle son canal ? » C'est de
 *                           l'INTENTION, et elle ne freine plus rien.
 *   STRUCTURE D'ACQUISITION complétude du profil, stories à la une. Un lien
 *                           externe, une catégorie, un bouton de contact, des
 *                           rubriques permanentes : de la machinerie de
 *                           conversion, la seule part qui mérite d'être lue
 *                           comme une acquisition déjà organisée.
 *
 * Le score original reste intact et publié à côté : rien de ce qui le lisait n'a
 * à bouger, et MODEL B/C restent évaluables mot pour mot.
 */
export const ORGANIC_ACTIVITY_KEYS: readonly string[] = ['posting_recency', 'posting_cadence', 'visual_maturity'];
export const ACQUISITION_STRUCTURE_KEYS: readonly string[] = ['profile_completeness', 'highlights'];

export interface SocialReadingPartition {
  /** L'intention : le canal est-il animé ? Ne freine JAMAIS la priorité. */
  readonly organicActivity: WeightedAxisFold;
  /** La machinerie : le canal convertit-il ? Seule part lue comme une maturité. */
  readonly acquisitionStructure: WeightedAxisFold;
}

export function partitionSocialReading(
  maturity: SocialMaturityResult | null,
  thresholds: ConfidenceThresholds,
): SocialReadingPartition | null {
  if (maturity === null) return null;
  const pick = (keys: readonly string[]): readonly WeightedContribution[] =>
    maturity.contributions.filter((contribution) => keys.includes(contribution.key));
  return {
    organicActivity: foldWeightedContributions(pick(ORGANIC_ACTIVITY_KEYS), thresholds),
    acquisitionStructure: foldWeightedContributions(pick(ACQUISITION_STRUCTURE_KEYS), thresholds),
  };
}

/**
 * L'intention organique, en bandes lisibles.
 *
 * `DORMANT` n'est pas un défaut : c'est le point de départ de l'écart
 * d'acquisition sociale de R7.4, qui reste désarmé. `UNKNOWN` n'est pas
 * `DORMANT` — un canal jamais observé n'est pas un canal muet.
 */
export type OrganicIntentBand = 'ACTIVE' | 'INTERMITTENT' | 'DORMANT' | 'UNKNOWN';

export interface OrganicIntent {
  readonly band: OrganicIntentBand;
  readonly score: number | null;
  readonly detail: string;
}

export function classifyOrganicIntent(partition: SocialReadingPartition | null): OrganicIntent {
  if (partition === null) {
    return { band: 'UNKNOWN', score: null, detail: 'aucun canal social observé — l’intention organique est inconnue' };
  }
  const score = partition.organicActivity.score;
  if (score === null) {
    return {
      band: 'UNKNOWN',
      score: null,
      detail: 'canal social observé mais ni récence ni cadence mesurables — inconnu, pas muet',
    };
  }
  const band: OrganicIntentBand = score >= 60 ? 'ACTIVE' : score >= 25 ? 'INTERMITTENT' : 'DORMANT';
  return {
    band,
    score,
    detail:
      band === 'ACTIVE'
        ? `canal réellement animé (${score}/100) — une intention digitale démontrée, jamais une pénalité`
        : band === 'INTERMITTENT'
          ? `canal animé par intermittence (${score}/100)`
          : `canal possédé mais muet (${score}/100)`,
  };
}

// ---------------------------------------------------------------------------
// D — ACQUISITION PAYANTE : le contrat, et rien d'autre
// ---------------------------------------------------------------------------

/**
 * R7.6 §9 — la place, nommée et vide.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi déclarer un type qu'aucun collecteur ne remplit
 * ---------------------------------------------------------------------------
 * Parce que la SÉMANTIQUE est la partie difficile, et qu'elle se décide mieux
 * avant d'avoir des données que sous la pression d'en avoir. Le point qui coûte
 * cher est un seul, et il est écrit dans le type plutôt que dans un commentaire
 * qu'on oubliera :
 *
 *     NO_ACTIVE_OBSERVED  ≠  « cette entreprise n'a jamais fait de publicité »
 *
 * C'est « nous avons cherché une campagne active, à cet instant, par ce moyen, et
 * nous n'en avons pas trouvé ». Une campagne arrêtée hier, une campagne servie
 * sous un autre compte, une bibliothèque incomplète : trois façons de rendre
 * `NO_ACTIVE_OBSERVED` sur un annonceur chevronné. Le jour où ce signal sera
 * collecté, il devra donc entrer comme un ÉCART POSSIBLE — jamais comme une
 * preuve d'absence, et jamais comme un motif de message.
 *
 * ---------------------------------------------------------------------------
 * Ce que R7.6 ne fait pas
 * ---------------------------------------------------------------------------
 * Aucune intégration un projet isole, aucun crawler Meta, aucun appel externe, aucune
 * collecte. La valeur est CONSTAMMENT `UNKNOWN`, un test le vérifie, et
 * `UNKNOWN` n'ajoute ni ne retire un seul point : il quitte le dénominateur,
 * comme tout non-observé de ce dépôt.
 */
export type PaidAcquisitionPresence = 'ACTIVE_OBSERVED' | 'NO_ACTIVE_OBSERVED' | 'UNKNOWN';

export interface PaidAcquisitionSignal {
  readonly presence: PaidAcquisitionPresence;
  /** Le fournisseur qui a répondu, ou `null` tant que personne n'a été interrogé. */
  readonly provider: string | null;
  readonly observedAt: string | null;
  readonly detail: string;
}

/**
 * La valeur par défaut, et elle n'est plus la SEULE.
 *
 * R7.6 ne savait produire que celle-ci : aucun collecteur n'était branché. Elle
 * reste le défaut exact — un prospect pour lequel personne n'a interrogé de
 * fournisseur porte toujours ceci, et `UNKNOWN` n'est ni un point positif ni un
 * point négatif. Ce qui a changé en R7.11, c'est qu'un prospect RÉELLEMENT
 * observé porte désormais son observation au lieu de cette constante.
 */
export const PAID_ACQUISITION_NOT_COLLECTED: PaidAcquisitionSignal = Object.freeze({
  presence: 'UNKNOWN' as const,
  provider: null,
  observedAt: null,
  detail:
    'présence publicitaire non collectée en R7.6 — emplacement réservé, aucun fournisseur interrogé. ' +
    'UNKNOWN n’est ni un point positif ni un point négatif.',
});

/**
 * La lecture « publicité payante » — mécanisme générique, aucune source imposée.
 *
 * Hermes ne fournit AUCUN connecteur vers une bibliothèque publicitaire : cette
 * lecture reste `UNKNOWN` tant qu'un opérateur ne branche pas une observation.
 * Les trois symboles ci-dessous décrivent seulement comment une observation, si
 * elle existe, se traduit en opportunité — jamais comment l'obtenir.
 */
export type PaidMaturity = 'NONE_OBSERVED' | 'LIGHT' | 'ACTIVE' | 'STRUCTURED' | 'UNKNOWN';

export type PaidOpportunity =
  /** Cible retenue, intention organique réelle, funnel incomplet, aucune publicité. */
  | 'HIGH_PAID_OPPORTUNITY'
  /** Cible retenue qui fait déjà tourner une acquisition structurée. */
  | 'PAID_ALREADY_STRUCTURED'
  /** Cible retenue, mais rien ne prouve un manque exploitable. */
  | 'NO_CLEAR_PAID_ANGLE'
  /** L'ICP ne suit pas : le signal payant ne sauve rien. */
  | 'NOT_APPLICABLE'
  | 'UNKNOWN';

export interface PaidOpportunityInput {
  readonly targetEligible: boolean;
  readonly organicIntentPresent: boolean;
  readonly funnelGapProven: boolean;
  readonly presence: PaidAcquisitionPresence;
  readonly maturity: PaidMaturity;
}

/**
 * Fail-closed : une cible hors ICP ne devient jamais une opportunité, et une
 * présence inconnue reste inconnue. Aucune bande n'est déduite d'une absence
 * d'observation — ne pas avoir regardé n'est pas avoir constaté.
 */
export function assessPaidOpportunity(input: PaidOpportunityInput): PaidOpportunity {
  if (!input.targetEligible) return 'NOT_APPLICABLE';
  if (input.presence === 'UNKNOWN') return 'UNKNOWN';

  if (input.presence === 'NO_ACTIVE_OBSERVED') {
    // Un effort nul partout n'est PAS automatiquement une bonne opportunité.
    if (!input.organicIntentPresent) return 'NO_CLEAR_PAID_ANGLE';
    if (!input.funnelGapProven) return 'NO_CLEAR_PAID_ANGLE';
    return 'HIGH_PAID_OPPORTUNITY';
  }

  return input.maturity === 'STRUCTURED' ? 'PAID_ALREADY_STRUCTURED' : 'NO_CLEAR_PAID_ANGLE';
}


/**
 * R7.11 §16 — ce qu'un rail Paid apporte à une évaluation, quand il a observé.
 *
 * Le couple est indissociable : une maturité sans son verdict ne veut rien dire,
 * et un verdict sans maturité ne sait pas séparer `PAID_ALREADY_STRUCTURED` de
 * `NO_CLEAR_PAID_ANGLE`. Les deux viennent du MÊME appel fournisseur
 * (`resolveFromun projet isolePresence`), jamais de deux lectures qui pourraient diverger.
 */
export interface PaidAcquisitionReading {
  readonly signal: PaidAcquisitionSignal;
  readonly maturity: PaidMaturity;
}

// ---------------------------------------------------------------------------
// E — ÉLIGIBILITÉ DE CIBLE
// ---------------------------------------------------------------------------

/**
 * « Cette entreprise est-elle du TYPE que nous servons ? »
 *
 * ---------------------------------------------------------------------------
 * Un verdict, pas une note — et la raison tient en un cas
 * ---------------------------------------------------------------------------
 * Une franchise au site excellent marque HAUT sur tout ce que le moteur sait
 * lire : meilleur contenu, meilleurs CTA, tarifs lisibles, mesure en place. Lui
 * opposer une NOTE reviendrait à espérer qu'elle marque assez bas ailleurs pour
 * ne pas ressortir — c'est-à-dire à parier. Un verdict ne parie pas.
 *
 * C'est déjà la doctrine du dépôt (`icpVerdict === NOT_TARGET` ⇒ priorité 0), et
 * ce module ne la double pas : il la LIT et l'étend d'une seule règle métier
 * nouvelle, l'échelle d'audience. Les signaux de réseau — franchise, multi-site,
 * relation de marque dans le domaine, portée multi-bassins, identité sociale
 * nationale — restent tous produits par `evaluateIcpEligibility`, qui les
 * corrobore par source. Rien n'est corrigé par un nom.
 *
 * ---------------------------------------------------------------------------
 * Les quatre valeurs
 * ---------------------------------------------------------------------------
 *   OUT_OF_SCOPE      hors cible. Réseau constaté, ou audience au-delà du
 *                     créneau. Ferme la porte, comme R7.1 la ferme déjà.
 *   REVIEW_REQUIRED   un doute qu'un humain doit trancher. N'ouvre ni ne ferme.
 *   UNKNOWN           rien n'a été lu. Une demande de collecte, pas un verdict.
 *   ELIGIBLE          lu, et rien qui disqualifie.
 *
 * `UNKNOWN` ne descend jamais vers `OUT_OF_SCOPE` : ne pas savoir n'est pas
 * savoir le contraire, et c'est la règle n°2 de CLAUDE.md.
 */
export type TargetEligibilityVerdict = 'ELIGIBLE' | 'REVIEW_REQUIRED' | 'OUT_OF_SCOPE' | 'UNKNOWN';

export interface TargetEligibility {
  readonly verdict: TargetEligibilityVerdict;
  readonly reason: string;
  readonly reasons: readonly string[];
}

export interface TargetEligibilityInput {
  readonly icp: IcpAssessment | null;
  readonly audience: AudienceScale;
  readonly config: ScalableOpportunityConfig;
  /**
   * R7.7 — l'activité déclarée par le cadre du site, quand le round ARME la
   * porte sur elle.
   *
   * Absente, l'éligibilité est mot pour mot celle de R7.6. Présente, un
   * `ADJACENT_ONLY` ferme, exactement comme un réseau ferme : ce sont deux
   * façons de n'être pas l'entreprise qu'on croyait regarder.
   *
   * La porte est armée par le ROUND et non par le module, pour la raison déjà
   * écrite en R7.6 : il faut pouvoir compter ce qu'elle FERMERAIT avant de
   * décider de l'armer. Le rapport de R7.7 le fait, et conclut de ne pas
   * l'armer.
   */
  readonly coreActivity?: CoreActivityAssessment;
}

export function assessTargetEligibility(input: TargetEligibilityInput): TargetEligibility {
  const { icp, audience, config } = input;
  const reasons: string[] = [];

  /**
   * 1 — le réseau, tel que l'ICP l'a déjà tranché. Cette porte n'est pas
   * réécrite ici : la dupliquer produirait deux réponses à « est-ce une
   * franchise ? », et deux réponses à cette question-là est une de trop.
   */
  if (icp?.verdict === 'NOT_TARGET') {
    return {
      verdict: 'OUT_OF_SCOPE',
      reason: `réseau ou franchise constaté — ${icp.reason}`,
      reasons: [...icp.reasons],
    };
  }

  /**
   * 2 — l'échelle d'audience, EXCLUSION DOCUMENTÉE plutôt que poids caché.
   *
   * La mission le demande explicitement : si une règle métier exige une
   * exclusion dure à très grande audience, elle doit être écrite comme une
   * exclusion, pas dissimulée dans un coefficient. Le seuil vit en configuration
   * et sa sensibilité est publiée dans le rapport du round.
   *
   * Elle n'est appliquée que sur un compte ATTRIBUÉ : sinon, l'audience de
   * quelqu'un d'autre fermerait la porte à ce prospect.
   */
  if (input.coreActivity?.verdict === 'ADJACENT_ONLY') {
    return {
      verdict: 'OUT_OF_SCOPE',
      reason: `activité voisine seule — ${input.coreActivity.reason}`,
      reasons: [input.coreActivity.reason],
    };
  }

  if (audienceIsOutOfScope(audience, config)) {
    return {
      verdict: 'OUT_OF_SCOPE',
      reason: `audience hors du créneau — ${audience.detail}`,
      reasons: [audience.detail],
    };
  }

  if (icp?.verdict === 'REVIEW_REQUIRED') {
    /**
     * Le REVIEW_REQUIRED « rien n'a été lu » n'est pas le REVIEW_REQUIRED
     * « un signal fort isolé ». Le premier est une absence de données, le second
     * un doute constaté — et `icpLockRefusal` fait déjà exactement cette
     * distinction sur le chemin d'envoi. On la reprend ici plutôt que d'inventer
     * une seconde façon de lire le même verdict.
     */
    if (icp.signals.length === 0) {
      return {
        verdict: 'UNKNOWN',
        reason: 'aucun contenu d’entreprise n’a été lu — le type d’entreprise reste inconnu',
        reasons: [icp.reason],
      };
    }
    return {
      verdict: 'REVIEW_REQUIRED',
      reason: `doute sur le type d’entreprise, à trancher par un humain — ${icp.reason}`,
      reasons: [...icp.reasons],
    };
  }

  if (icp === null) {
    return {
      verdict: 'UNKNOWN',
      reason: 'éligibilité ICP non évaluée — le type d’entreprise reste inconnu',
      reasons: [],
    };
  }

  reasons.push(icp.reason);
  if (audience.band === 'ESTABLISHED') reasons.push(audience.detail);
  return {
    verdict: 'ELIGIBLE',
    reason: 'opérateur indépendant, aucun marqueur de réseau, audience dans le créneau',
    reasons,
  };
}

// ---------------------------------------------------------------------------
// F — MARGE DE PROGRESSION
// ---------------------------------------------------------------------------

/**
 * « Reste-t-il de la place pour ce que nous savons faire ? »
 *
 * ---------------------------------------------------------------------------
 * Publiée, jamais pondérée — et c'est un choix, pas une timidité
 * ---------------------------------------------------------------------------
 * La bande synthétise trois lectures qui existent déjà et qu'elle ne recalcule
 * pas : l'échelle d'audience, l'intention organique, l'écart de funnel (l'axe
 * BESOIN du moteur). Elle ne s'ajoute donc à aucune formule et ne peut faire
 * monter personne — parce qu'un quatrième poids décidé sur soixante-deux avis
 * serait un poids inventé, et parce que le §16 de la mission l'interdit
 * nommément.
 *
 * Ce qu'elle apporte est ailleurs : elle rend le cas A de la mission LISIBLE.
 * Un opérateur indépendant, à l'audience petite, au canal animé, au funnel
 * troué se lit désormais d'un coup d'œil comme `HIGH` — et un humain peut
 * décider, sur pièces, s'il faut l'armer au round suivant.
 *
 * ---------------------------------------------------------------------------
 * Ce qu'elle refuse
 * ---------------------------------------------------------------------------
 * Une petite audience seule ne produit JAMAIS `HIGH`. Le cas B de la mission est
 * exactement cela : un petit business à l'activité douteuse ne devient pas bon
 * parce qu'il est petit. La bande exige donc, en plus de la marge, une
 * ÉLIGIBILITÉ établie et un besoin OBSERVÉ — deux faits, pas deux absences.
 */
export type GrowthHeadroomBand = 'HIGH' | 'MODERATE' | 'LOW' | 'UNKNOWN';

export interface GrowthHeadroom {
  readonly band: GrowthHeadroomBand;
  readonly detail: string;
}

export interface GrowthHeadroomInput {
  readonly eligibility: TargetEligibility;
  readonly audience: AudienceScale;
  readonly organic: OrganicIntent;
  /** L'axe BESOIN du moteur commercial : l'écart de funnel, déjà mesuré. `null` = non observé. */
  readonly funnelGap: number | null;
  /** La capacité à payer déjà calculée. `null` = non observée. */
  readonly abilityToPay: number | null;
  readonly config: ScalableOpportunityConfig;
}

export function assessGrowthHeadroom(input: GrowthHeadroomInput): GrowthHeadroom {
  const { eligibility, audience, organic, funnelGap, abilityToPay, config } = input;

  if (eligibility.verdict === 'OUT_OF_SCOPE') {
    return { band: 'LOW', detail: `hors cible — ${eligibility.reason}` };
  }
  if (funnelGap === null) {
    return {
      band: 'UNKNOWN',
      detail: 'aucun manque de funnel observé — le site n’a pas été lu. Absence de preuve, pas preuve d’absence.',
    };
  }
  if (eligibility.verdict === 'UNKNOWN') {
    return { band: 'UNKNOWN', detail: 'type d’entreprise inconnu — la marge de progression ne se juge pas sans lui' };
  }

  const smallEnough = audience.band === 'EMERGING' || audience.band === 'GROWING';
  const gapReal = funnelGap >= config.headroom.funnelGapFloor;
  const canBuy = abilityToPay !== null && abilityToPay >= config.headroom.abilityFloor;
  const engaged = organic.band === 'ACTIVE' || organic.band === 'INTERMITTENT';

  if (smallEnough && gapReal && canBuy && engaged) {
    return {
      band: 'HIGH',
      detail:
        `${audience.detail} ; ${organic.detail} ; manque de funnel observé ${funnelGap}/100 ; ` +
        `capacité ${abilityToPay}/100 — marge de progression réelle sur un business qui tourne déjà`,
    };
  }
  if (audience.band === 'OUT_OF_SWEET_SPOT' || (!gapReal && !engaged)) {
    return { band: 'LOW', detail: `marge de progression faible — ${audience.detail} ; manque de funnel ${funnelGap}/100` };
  }
  return {
    band: 'MODERATE',
    detail:
      `marge de progression partielle — ${audience.detail} ; ${organic.detail} ; ` +
      `manque de funnel ${funnelGap}/100${canBuy ? '' : ' ; capacité à payer non établie'}`,
  };
}

// ---------------------------------------------------------------------------
// L'assemblage
// ---------------------------------------------------------------------------

export interface ScalableOpportunityAssessment {
  readonly eligibility: TargetEligibility;
  readonly audience: AudienceScale;
  readonly tenure: BusinessTenure;
  readonly organic: OrganicIntent;
  readonly headroom: GrowthHeadroom;
  readonly paidAcquisition: PaidAcquisitionSignal;
  /** La bande de maturité Paid, `UNKNOWN` tant qu'aucun fournisseur n'a observé. */
  readonly paidMaturity: PaidMaturity;
  /**
   * La lecture commerciale du signal Paid — publiée, jamais sommée.
   *
   * Aucun score, aucune bande, aucune priorité ne la lit : elle accompagne le
   * verdict commercial et ne le corrige pas. C'est ce qui garantit qu'un
   * `UNKNOWN` Paid — la quasi-totalité du corpus — ne pénalise personne.
   */
  readonly paidOpportunity: PaidOpportunity;
  /** La partition sociale, quand un profil a été observé. `null` sinon. */
  readonly socialReading: SocialReadingPartition | null;
  readonly profileKey: string;
  readonly profileVersion: string;
}

export interface ScalableOpportunityInput {
  readonly icp: IcpAssessment | null;
  /** R7.7 — armée seulement quand le round demande la porte sur l'activité. */
  readonly coreActivity?: CoreActivityAssessment;
  readonly socialMaturity: SocialMaturityResult | null;
  readonly audienceObservation: AudienceObservation | null;
  readonly registryDateCreation: unknown;
  /** L'axe BESOIN déjà calculé. Lu, jamais recalculé. */
  readonly funnelGap: number | null;
  readonly abilityToPay: number | null;
  /**
   * R7.11 — l'observation Paid de ce prospect, quand elle existe.
   *
   * Absente, l'évaluation est mot pour mot celle de R7.6/R7.7 : le champ
   * `paidAcquisition` reste `PAID_ACQUISITION_NOT_COLLECTED` et un test
   * l'exécute sur tout le corpus. C'est la même discipline que `social` :
   * un signal nouveau s'ajoute par une entrée optionnelle, pour que son absence
   * reproduise exactement le moteur d'avant.
   */
  readonly paid?: PaidAcquisitionReading;
  readonly config: ScalableOpportunityConfig;
  readonly confidence: ConfidenceThresholds;
  readonly profileKey: string;
  readonly profileVersion: string;
  readonly now: Date;
}

/**
 * L'objet publié. Pur, rejouable, et sans effet sur la priorité hormis la porte
 * d'éligibilité — que `commercialIntelligence` applique, et lui seul.
 */
export function assessScalableOpportunity(input: ScalableOpportunityInput): ScalableOpportunityAssessment {
  const audience = classifyAudienceScale(input.audienceObservation, input.config);
  const eligibility = assessTargetEligibility({
    icp: input.icp,
    audience,
    config: input.config,
    ...(input.coreActivity === undefined ? {} : { coreActivity: input.coreActivity }),
  });
  const socialReading = partitionSocialReading(input.socialMaturity, input.confidence);
  const organic = classifyOrganicIntent(socialReading);
  const tenure = classifyBusinessTenure(input.registryDateCreation, input.now, input.config);
  const headroom = assessGrowthHeadroom({
    eligibility,
    audience,
    organic,
    funnelGap: input.funnelGap,
    abilityToPay: input.abilityToPay,
    config: input.config,
  });

  /**
   * Les deux prédicats sont ceux que `assessGrowthHeadroom` applique déjà, repris
   * à l'identique : « intention organique présente » = le canal est animé
   * (`ACTIVE` ou `INTERMITTENT`), « manque de funnel prouvé » = l'axe BESOIN
   * dépasse le plancher DÉJÀ configuré. Aucun seuil n'est inventé pour le Paid,
   * et surtout aucun n'est dérivé des cinq Pages observées : brancher un signal
   * n'est pas l'occasion de recalibrer un modèle.
   */
  const paid = input.paid;
  const paidOpportunity = assessPaidOpportunity({
    targetEligible: eligibility.verdict === 'ELIGIBLE',
    organicIntentPresent: organic.band === 'ACTIVE' || organic.band === 'INTERMITTENT',
    funnelGapProven: input.funnelGap !== null && input.funnelGap >= input.config.headroom.funnelGapFloor,
    presence: paid?.signal.presence ?? PAID_ACQUISITION_NOT_COLLECTED.presence,
    maturity: paid?.maturity ?? 'UNKNOWN',
  });

  return {
    eligibility,
    audience,
    tenure,
    organic,
    headroom,
    paidAcquisition: paid?.signal ?? PAID_ACQUISITION_NOT_COLLECTED,
    paidMaturity: paid?.maturity ?? 'UNKNOWN',
    paidOpportunity,
    socialReading,
    profileKey: input.profileKey,
    profileVersion: input.profileVersion,
  };
}

/** Rendu lisible d'une bande, pour les rapports. Aucune décision ici. */
export function describeOpportunity(assessment: ScalableOpportunityAssessment): readonly string[] {
  return [
    `éligibilité ${assessment.eligibility.verdict} — ${assessment.eligibility.reason}`,
    `audience ${assessment.audience.band} — ${assessment.audience.detail}`,
    `ancienneté du business ${assessment.tenure.band} — ${assessment.tenure.detail}`,
    `intention organique ${assessment.organic.band} — ${assessment.organic.detail}`,
    `marge de progression ${assessment.headroom.band} — ${assessment.headroom.detail}`,
    `acquisition payante ${assessment.paidAcquisition.presence} — ${assessment.paidAcquisition.detail}`,
    `opportunité payante ${assessment.paidOpportunity} (maturité ${assessment.paidMaturity})`,
  ];
}

export type { AxisBand, AxisConfidence };
