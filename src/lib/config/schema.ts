import { z } from 'zod';

/**
 * All behaviour that a non-developer should be able to change lives in config/:
 * geography, niche vocabulary, scoring weights, model routing. The engine reads
 * these; it never hardcodes a city, a keyword or a model name.
 */

// ---------------------------------------------------------------------------
// Geography
// ---------------------------------------------------------------------------
export const geographySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('national'), country: z.string().default('FR') }),
  z.object({
    mode: z.literal('region'),
    country: z.string().default('FR'),
    regions: z.array(z.string()).min(1),
  }),
  z.object({
    mode: z.literal('department'),
    country: z.string().default('FR'),
    departments: z.array(z.string()).min(1),
  }),
  z.object({
    mode: z.literal('cities'),
    country: z.string().default('FR'),
    cities: z.array(z.object({ name: z.string(), postalCode: z.string().optional() })).min(1),
  }),
  z.object({
    mode: z.literal('radius'),
    country: z.string().default('FR'),
    center: z.object({
      label: z.string(),
      latitude: z.number(),
      longitude: z.number(),
    }),
    radiusKm: z.number().positive().max(200),
  }),
]);

export type GeographyConfig = z.infer<typeof geographySchema>;

// ---------------------------------------------------------------------------
// Niche
// ---------------------------------------------------------------------------
/**
 * Le vocabulaire commercial, en trois paliers — R5.
 *
 * `searchQueries` existait déjà et sert à interroger une source *par
 * établissement* : on sait qui l'on cherche, la requête sert à le retrouver.
 * R5 pose la question inverse — « qui exerce ce métier ici ? » — et ce
 * renversement change la nature des termes utiles.
 *
 * Les trois paliers ne sont pas trois synonymes de la même idée :
 *
 *   core             — le mot du métier, celui que le professionnel écrit sur
 *                      sa page d'accueil. Fort rappel, faible bruit.
 *   secondary        — le mot que le CLIENT tape, qui n'est pas toujours celui
 *                      du métier. « prestation standard intérieur voiture » ramène des
 *                      entreprises qui ne se disent jamais « artisan ».
 *   service_specific — une prestation précise (boutique en ligne, vente de produits). Faible
 *                      rappel, mais ce qu'il ramène est très qualifié, et il
 *                      atteint des entreprises que les deux premiers ratent.
 *
 * Le palier est ce qui permet de dépenser par ordre de rendement décroissant et
 * de s'arrêter net : sans lui, « ajouter un terme » redevient la façon dont un
 * run grossit sans qu'on l'ait décidé.
 *
 * Vide par défaut : une niche qui n'a pas encore été pensée pour la découverte
 * commerciale doit produire zéro requête, pas des requêtes devinées.
 */
export const commercialQueryTiersSchema = z
  .object({
    core: z.array(z.string().min(2)).default([]),
    secondary: z.array(z.string().min(2)).default([]),
    serviceSpecific: z.array(z.string().min(2)).default([]),
    /**
     * HERMES-CLEANING-ONLY-ICP-R1 §18 — le vocabulaire qui cherche des
     * PRESTATAIRES, et rien d'autre.
     *
     * Les trois paliers ci-dessus ont été écrits sous un ICP qui accueillait la
     * boutique en ligne et le vente de produits : `core` interroge « atelier automobile » et
     * « prestation premium », `serviceSpecific` interroge « protection
     * boutique en ligne automobile » et « vente de produits automobile ». Ils font exactement
     * ce qu'on leur demande — et ce qu'ils ramènent est massivement hors cible
     * depuis le 22 août 2026 : sur 49 entreprises fraîches, 42 vendent au moins
     * une prestation non-prestation standard.
     *
     * Ce palier est la réponse en amont. Il ne remplace pas les autres, qui
     * gardent leur sens pour un ICP plus large ; il donne à une campagne
     * cleaning-only de quoi chercher ce qu'elle veut vraiment trouver.
     */
    inScope: z.array(z.string().min(2)).default([]),
  })
  .default({ core: [], secondary: [], serviceSpecific: [], inScope: [] });

export type CommercialQueryTiers = z.infer<typeof commercialQueryTiersSchema>;

/**
 * R7.7 — une famille d'activité voisine du métier cible.
 *
 * `label` et `why` ne sont pas décoratifs : un prospect écarté parce que son
 * site ne parle que de reprogrammation moteur doit pouvoir lire, en une phrase,
 * pourquoi — et un humain doit pouvoir contester la famille elle-même plutôt
 * que d'avoir à relire du code.
 */
export const adjacentActivityFamilySchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  why: z.string().min(1),
  phrases: z.array(z.string().min(3)).min(1),
});

export type AdjacentActivityFamily = z.infer<typeof adjacentActivityFamilySchema>;

/**
 * HERMES-TARGETING-R1 §10 — une famille de PRESTATION SPÉCIALISÉE, à
 * distinguer d'une famille d'activité voisine.
 *
 * `adjacentActivityFamilySchema` décrit un AUTRE MÉTIER (formation, mécanique,
 * VTC). Celle-ci décrit une spécialité DE NOTRE MÉTIER — REVENTE, revente, vitrage
 * teinté, boutique en ligne — qui, lorsqu'elle devient l'offre principale, désigne un
 * atelier de protection premium plutôt qu'un artisan du prestation standard. Les deux
 * axes sont indépendants : un centre REVENTE n'est pas « voisin », il est dedans, et
 * c'est précisément pour cela qu'aucune famille voisine ne l'attrapait.
 */
export const serviceSpecialistFamilySchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  why: z.string().min(1),
  phrases: z.array(z.string().min(2)).min(1),
});

export type ServiceSpecialistFamily = z.infer<typeof serviceSpecialistFamilySchema>;

/**
 * Le vocabulaire qui sépare « ce commerce lave des voitures » de « ce commerce
 * pose des films ».
 *
 * Vide par défaut, et le défaut n'est PAS permissif : `assessCoreServiceFit`
 * rend `UNKNOWN` quand il n'a rien à mesurer, et `UNKNOWN` n'autorise aucun
 * envoi automatique. Ajouter une niche sans déclarer ce bloc ne l'ouvre donc
 * pas silencieusement.
 */
export const coreServiceFitSchema = z
  .object({
    /** Ce qu'un artisan du prestation standard écrit quand il décrit son métier. */
    inScopeTerms: z.array(z.string().min(2)).default([]),
    specialistFamilies: z.array(serviceSpecialistFamilySchema).default([]),
  })
  .default({ inScopeTerms: [], specialistFamilies: [] });

export type CoreServiceFitConfig = z.infer<typeof coreServiceFitSchema>;

/**
 * HERMES-CLEANING-ONLY-ICP-R1 §3 — une famille de prestation NON-PRESTATION STANDARD.
 *
 * À ne pas confondre avec `serviceSpecialistFamilySchema`, qui décrivait une
 * spécialité de NOTRE métier dont on mesurait la dominance. Celle-ci décrit une
 * prestation qui, dès qu'elle est réellement commercialisée, sort l'entreprise
 * de la cible autonome — quelle que soit sa part dans l'offre.
 *
 * `label` et `why` ne sont pas décoratifs : un dirigeant écarté parce que son
 * site vend du vente de produits doit pouvoir lire pourquoi, et un humain doit pouvoir
 * contester la FAMILLE plutôt que d'avoir à relire du code. Aucune famille ne
 * nomme une entreprise, un domaine ou un compte.
 */
export const outOfScopeServiceFamilySchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  why: z.string().min(1),
  phrases: z.array(z.string().min(2)).min(1),
});

export type NonCleaningServiceFamily = z.infer<typeof outOfScopeServiceFamilySchema>;

/**
 * Le vocabulaire à TROIS niveaux qui sépare « ce commerce ne fait que laver »
 * de « ce commerce vend aussi autre chose ».
 *
 * Trois listes et non deux, parce que le corpus contient un vocabulaire qui ne
 * tranche pas : « atelier », « prestation premium », « préparation ». §4
 * de la mission l'exige explicitement — ces mots doivent être résolus par les
 * prestations observées, jamais lus comme une preuve.
 *
 * Vide par défaut, et le défaut n'est PAS permissif : `assessServiceScope` rend
 * `UNKNOWN` quand il n'a rien à mesurer, et `UNKNOWN` n'autorise aucun envoi.
 */
export const serviceScopeSchema = z
  .object({
    /** Ce qui PROUVE du prestation standard, sans ambiguïté possible. */
    inScopeTerms: z.array(z.string().min(2)).default([]),
    /** Ce qui ne prouve rien et n'exclut rien (§4). Compté, publié, jamais décisif. */
    ambiguousTerms: z.array(z.string().min(2)).default([]),
    /** Ce dont la seule présence commercialisée écarte (§3). */
    outOfScopeFamilies: z.array(outOfScopeServiceFamilySchema).default([]),
  })
  .default({ inScopeTerms: [], ambiguousTerms: [], outOfScopeFamilies: [] });

export type ServiceScopeConfig = z.infer<typeof serviceScopeSchema>;

export const nicheSchema = z.object({
  key: z.string(),
  label: z.string(),
  language: z.string().default('fr'),
  /** Terms that, when present, argue for the niche. */
  positiveTerms: z.array(z.string()).min(1),
  /** Terms that strongly argue against it. */
  negativeTerms: z.array(z.string()).default([]),
  /** Terms typical of adjacent-but-not-target businesses. */
  adjacentTerms: z.array(z.string()).default([]),
  /**
   * R7.7 §6 — le vocabulaire du MÉTIER, celui qui prouve une activité quand il
   * apparaît dans le CADRE d'un site (titre, description, titres de section).
   *
   * Séparé de `positiveTerms`, qui sert la découverte et doit donc ratisser
   * large : « car care » ou « pressing auto » ramènent des candidats utiles à
   * une requête, mais ne suffisent pas à établir qu'une entreprise lave des
   * voitures pour ses clients. Vide, `coreActivityTerms` retombe sur
   * `positiveTerms` — une niche qui n'a pas encore tranché garde le
   * comportement de R7.6 plutôt qu'un comportement deviné.
   */
  coreActivityTerms: z.array(z.string().min(2)).default([]),
  /**
   * R7.7 §6 — les FAMILLES d'activité voisine, chacune nommée et justifiée.
   *
   * Une famille est une catégorie de métier — formation, performance,
   * transport de personnes, vente — jamais une entreprise, jamais un domaine.
   * C'est la garantie que demande le §6 : « ne crée aucun fix par nom/domaine
   * spécifique ». Ses phrases sont recherchées COMPLÈTES et retirées du texte
   * avant que le vocabulaire de métier n'y soit cherché, sans quoi le
   * « atelier » de « formation atelier » ferait d'un centre de formation un
   * atelier.
   */
  adjacentActivityFamilies: z.array(adjacentActivityFamilySchema).default([]),
  /**
   * HERMES-TARGETING-R1 §10 — la partition prestation standard / protection spécialisée,
   * lue par `assessCoreServiceFit` et par la seule politique autonome.
   *
   * Ce bloc ne touche à aucun score : il ne change ni `positiveTerms`, ni
   * `coreActivityTerms`, ni les familles voisines. Il répond à une question que
   * les autres ne posaient pas — quelle prestation est le métier — et sa seule
   * conséquence est une porte d'envoi automatique.
   */
  coreServiceFit: coreServiceFitSchema,
  /**
   * HERMES-CLEANING-ONLY-ICP-R1 §3-§7 — la partition PRESTATION STANDARD / NON-PRESTATION STANDARD,
   * lue par `assessServiceScope` et par la seule politique autonome.
   *
   * Elle ne remplace pas `coreServiceFit` et ne le modifie pas : les verdicts
   * rendus sous `hermes-targeting-r1` restent relisibles sous la règle qui les
   * a rendus (§5). Les deux blocs coexistent parce qu'ils répondent à deux
   * questions différentes, posées à deux dates différentes.
   */
  serviceScope: serviceScopeSchema,
  /** Registry activity codes that are compatible with the niche (FR: NAF). */
  registryCodes: z.array(z.string()).default([]),
  /** Registry codes that disqualify outright. */
  excludedRegistryCodes: z.array(z.string()).default([]),
  /** Service vocabulary used for evidence extraction on websites. */
  serviceTerms: z.array(z.string()).default([]),
  /** Premium-service vocabulary, used as a scoring signal. */
  premiumTerms: z.array(z.string()).default([]),
  /** Search phrases the discovery sources expand into queries. */
  searchQueries: z.array(z.string()).min(1),
  /** R5 — vocabulaire de la découverte commerciale, par palier de rendement. */
  commercialQueries: commercialQueryTiersSchema,
  description: z.string().default(''),
});

export type NicheConfig = z.infer<typeof nicheSchema>;

// ---------------------------------------------------------------------------
// Éligibilité ICP
// ---------------------------------------------------------------------------

/**
 * ICP-R1 — le vocabulaire du profil de client idéal, séparé de celui de la
 * niche, et la séparation est le sujet.
 *
 * `config/niches` répond « quel MÉTIER ? ». Ce fichier répond « quel TYPE
 * d'entreprise ? ». Les deux questions ont été confondues une fois, et cela a
 * coûté un faux positif : le mot « franchise » vivait dans les `negativeTerms`
 * de la niche atelier, où il ne pouvait s'exprimer que sous la forme « ce
 * n'est pas le bon métier ». Or une franchise de prestation standard EST du
 * prestation standard. Le classificateur a donc eu raison de passer outre — et
 * personne ne posait l'autre question.
 *
 * Le vocabulaire vit ici ; la RÈGLE de décision vit dans `icpEligibility.ts`,
 * en code testé (CLAUDE.md : « toute logique déterministe reste du code
 * testé »). Un fichier de configuration ne doit jamais pouvoir décider seul
 * qu'un prospect est écarté.
 */
export const icpSeveritySchema = z.enum(['DISQUALIFYING', 'STRONG', 'WEAK']);

export const icpSignalGroupSchema = z.object({
  key: z.string().min(1),
  severity: icpSeveritySchema,
  label: z.string().min(1),
  /** Pourquoi ce groupe existe, en une phrase lisible par un humain qui conteste un verdict. */
  why: z.string().min(1),
  /**
   * Phrases recherchées, déjà sans accents et en minuscules — la comparaison
   * normalise des deux côtés. Recherchées sur des frontières de mots, jamais en
   * sous-chaîne : « franchise » ne doit pas être trouvé dans « affranchissement ».
   */
  phrases: z.array(z.string().min(2)).min(1),
});

export const icpProfileSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  /** Incrémenté à chaque changement de vocabulaire : un verdict archivé dit sur quelle version il a été rendu. */
  version: z.number().int().min(1),
  description: z.string().default(''),
  thresholds: z
    .object({
      /**
       * Nombre de signaux faibles distincts au-delà duquel une revue est
       * demandée. Trois, et non deux : « nos actualités » sur le site d'un
       * artisan soigné ne doit pas encombrer la file de revue.
       */
      weakSignalsForReview: z.number().int().min(2).max(10).default(3),
      /**
       * Nombre de SOURCES distinctes portant un signal fort au-delà duquel le
       * verdict devient NOT_TARGET. Deux sources indépendantes valent une
       * corroboration ; deux occurrences de la même page n'en sont pas une.
       */
      strongSourcesForNotTarget: z.number().int().min(2).max(5).default(2),
      /**
       * R7.3B — nombre de zones de découverte distinctes au-delà duquel la
       * DOMINATION du classement devient elle-même un fait de portée.
       *
       * Un exploitant local sort bien classé chez lui, et éventuellement dans la
       * commune d'à côté. Sortir en tête sur trois bassins séparés de centaines
       * de kilomètres est une propriété du SITE, pas de l'adresse — et elle
       * s'observe même quand aucune adresse n'a été résolue, là où
       * `zoneDepartments` ne peut rien comparer.
       */
      zonesForNationalReach: z.number().int().min(2).max(10).default(3),
    })
    .default({ weakSignalsForReview: 3, strongSourcesForNotTarget: 2, zonesForNationalReach: 3 }),
  signalGroups: z.array(icpSignalGroupSchema).min(1),
  /**
   * Contextes qui neutralisent une phrase trouvée. « réseaux sociaux » contient
   * « réseau » ; « franchise d'assurance » n'a rien d'un modèle de
   * distribution. Une exclusion est retirée du texte AVANT la recherche, donc
   * elle ne peut pas produire de faux positif ni en masquer un vrai ailleurs
   * dans la même page.
   */
  exclusions: z.array(z.string().min(2)).default([]),
  /**
   * Marqueurs d'un handle social qui revendique une portée nationale alors que
   * l'entité découverte est locale. Signal STRUCTUREL, pas lexical : il ne lit
   * pas le contenu d'une page mais compare deux identités entre elles.
   */
  nationalScopeHandleMarkers: z.array(z.string().min(2)).default([]),
  /**
   * Département de chaque zone de découverte, en clé normalisée (sans accent,
   * minuscules). Sans cette table, comparer « trouvée à Lyon » à « déclarée à
   * Corbas » ne distingue pas une commune de l'agglomération d'une entreprise
   * située à 400 km — le premier passage sur le corpus réel a produit six faux
   * positifs de cette nature. Une zone absente d'ici n'invalide pas le signal :
   * elle le fait retomber au niveau faible, qui ne rejette jamais seul.
   *
   * La géographie vit en configuration, jamais en dur (CLAUDE.md).
   */
  zoneDepartments: z.record(z.string(), z.string().min(1)).default({}),
  /**
   * R7.3B — les mots qu'un nom de domaine peut porter sans désigner personne.
   *
   * Le signal `domain_brand_relationship` demande « ce domaine nomme-t-il une
   * marque que rien dans l'identité de l'entreprise n'explique ? ». Sans cette
   * liste, `prestation`, `auto` ou `atelier` seraient traités comme des marques
   * inconnues et tout domaine composé deviendrait suspect. Ce sont des mots de
   * MÉTIER et de LIEU, donc ils vivent en configuration (CLAUDE.md : aucun
   * vocabulaire de niche ni géographie en dur).
   */
  genericDomainTokens: z.array(z.string().min(2)).default([]),
});

export type IcpSeverity = z.infer<typeof icpSeveritySchema>;
export type IcpSignalGroup = z.infer<typeof icpSignalGroupSchema>;
export type IcpProfile = z.infer<typeof icpProfileSchema>;

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------
export const scoringSignalSchema = z.object({
  key: z.string(),
  label: z.string(),
  /** Maximum points this signal can contribute. */
  weight: z.number().min(0).max(100),
  /**
   * How a missing observation is treated:
   *   zero    -> counts as 0 points (absence penalised)
   *   neutral -> removed from the denominator (absence never invents a fact)
   */
  onMissing: z.enum(['zero', 'neutral']).default('neutral'),
  description: z.string().default(''),
});

export const scoringProfileSchema = z.object({
  key: z.string(),
  version: z.string(),
  label: z.string(),
  bands: z
    .object({ a: z.number(), b: z.number(), c: z.number() })
    .default({ a: 75, b: 60, c: 40 }),
  signals: z.array(scoringSignalSchema).min(1),
  /** Cap the qualitative LLM contribution so the score stays mostly deterministic. */
  llmObservationWeight: z.number().min(0).max(30).default(10),
});

export type ScoringProfile = z.infer<typeof scoringProfileSchema>;
export type ScoringSignalConfig = z.infer<typeof scoringSignalSchema>;

// ---------------------------------------------------------------------------
// Commercial intelligence (R7.1 — SHADOW)
// ---------------------------------------------------------------------------
/**
 * R7.1 — les poids de la priorité commerciale, et rien d'autre.
 *
 * Ce qui vit ici : des nombres qu'un humain corrigera en R7.2 après avoir relu
 * trente cas. Ce qui n'y vit PAS : la logique. Quels faits comptent, et dans
 * quel sens, reste du code testé (`commercialIntelligence.ts`) — un fichier de
 * configuration ne doit pas pouvoir inventer un signal.
 *
 * Le schéma est fermé (`strict`) et sans défaut sur les poids : ajouter un
 * contributeur au code sans décider de son poids ici fait échouer le
 * chargement, plutôt que de le faire entrer silencieusement à zéro.
 */
const weightMapSchema = z.record(z.string(), z.number().min(0).max(100));

/**
 * R7.6 — le créneau commercial de Hermes, écrit comme une règle et non comme un poids.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi une exclusion assumée plutôt qu'une pénalité
 * ---------------------------------------------------------------------------
 * Une entreprise dont l'audience sociale dépasse largement notre créneau n'est
 * pas un prospect « qui marque un peu moins ». C'est un prospect d'un autre
 * métier que le nôtre, et le lui signifier par un malus reviendrait à espérer
 * qu'il tombe sous une bande — c'est-à-dire à parier sur le reste de son
 * dossier. Le §6 de la mission R7.6 tranche : si une règle métier exige une
 * exclusion dure, elle doit être DOCUMENTÉE comme telle.
 *
 * Le seuil de 10 000 est celui que le métier a énoncé. Le corpus de calibration
 * en suggère un nettement plus bas ; il n'est PAS retenu, pour deux raisons qui
 * tiennent toutes les deux à l'honnêteté de la mesure : le relecteur humain
 * voyait le nombre d'abonnés à l'écran quand il a étiqueté, donc l'accord entre
 * ce nombre et ses réponses est en partie tautologique ; et régler un seuil sur
 * soixante-deux avis est exactement le balayage que le §16 interdit. La
 * sensibilité est publiée dans la documentation d’installation, et le
 * resserrer est une décision humaine, pas une optimisation.
 */
export const scalableOpportunityConfigSchema = z
  .object({
    audience: z
      .object({
        /** En dessous : audience naissante. Ni un défaut, ni un mérite. */
        emergingBelow: z.number().int().positive(),
        /** En dessous : audience en construction. Au-dessus : audience installée. */
        growingBelow: z.number().int().positive(),
        /** À partir d'ici, l'entreprise sort du créneau que nous savons servir. */
        outOfSweetSpotAtOrAbove: z.number().int().positive(),
        /** L'exclusion est-elle DURE ? `false` la publie sans fermer la porte. */
        hardExcludeOutOfSweetSpot: z.boolean(),
      })
      .strict(),
    /**
     * L'ancienneté de l'ENTREPRISE, en années. Jamais celle d'une personne :
     * voir `scalableOpportunity.ts`, où l'interdit est écrit et testé.
     */
    tenure: z
      .object({
        newBelowYears: z.number().positive(),
        growingBelowYears: z.number().positive(),
        establishedBelowYears: z.number().positive(),
      })
      .strict(),
    /**
     * Les planchers de la marge de progression. Un manque de funnel sous le
     * plancher n'est pas une opportunité, et une capacité sous le plancher n'est
     * pas un client — le §13 cas B l'exige : petit ne veut pas dire bon.
     */
    headroom: z
      .object({
        funnelGapFloor: z.number().min(0).max(100),
        abilityFloor: z.number().min(0).max(100),
      })
      .strict(),
  })
  .strict();

export type ScalableOpportunityConfig = z.infer<typeof scalableOpportunityConfigSchema>;

export const commercialIntelligenceProfileSchema = z
  .object({
    key: z.string(),
    version: z.string(),
    label: z.string(),
    note: z.string().default(''),
    weights: z
      .object({
        icpFit: weightMapSchema,
        acquisitionMaturity: weightMapSchema,
        need: weightMapSchema,
        abilityToPay: weightMapSchema,
        timing: weightMapSchema,
      })
      .strict(),
    /** Seuils de couverture au-delà desquels une confiance est dite haute/moyenne. */
    confidence: z.object({ high: z.number().min(0).max(1), medium: z.number().min(0).max(1) }).strict(),
    /**
     * R7.3B §8 — « activité compatible » n'est pas « type d'entreprise compatible ».
     *
     * Un fit de 100 est une affirmation de certitude. R7.3 en a trouvé un sur
     * `wash-totalenergies.fr` : métier `in_niche`, aucun marqueur de réseau
     * trouvé, aucune identité légale résolue — et le contributeur
     * `independent_operator` rendait `null`, donc ses vingt points quittaient le
     * dénominateur et les deux contributeurs restants suffisaient à 100.
     *
     * L'ABSENCE de contre-preuve rendait donc le même verdict que la PREUVE.
     * Le crédit ci-dessous est ce qui les sépare : un site lu sans marqueur de
     * réseau vaut une preuve PARTIELLE d'indépendance, jamais une preuve
     * complète. Ce n'est pas une pénalité sur l'inconnu — un prospect dont rien
     * n'a été lu garde `null`, et son poids quitte toujours le dénominateur.
     */
    businessType: z
      .object({
        /** Crédit accordé quand le contenu est lu mais qu'aucune identité légale n'est résolue. */
        unresolvedLegalIdentityCredit: z.number().min(0).max(1),
        /**
         * R7.7 §7 — la SECONDE source du fit à 100, traitée comme la première.
         *
         * R7.3B avait fermé la porte sur l'identité légale ; elle est restée
         * grande ouverte sur l'ACTIVITÉ. Trente-deux prospects sortaient à
         * fit 100, dont huit dont le métier n'avait JAMAIS été classifié :
         * `niche_verdict` valait `null`, son poids quittait le dénominateur, et
         * les deux contributeurs restants — « pas de franchise trouvée » et
         * « SIREN résolu » — se renormalisaient à 100. Un prospect dont
         * personne ne savait le métier obtenait la note maximale de
         * « savons-nous servir ce type d'entreprise ».
         *
         * Les trois crédits ci-dessous rendent le contributeur d'activité
         * TOUJOURS présent dès qu'une page de présentation a été lue, à une
         * valeur qui dit ce qu'on sait :
         *
         *   unprovenCoreActivityCredit  cadre lu, rien de reconnaissable ;
         *   adjacentWithCoreCredit      métier déclaré à côté d'un autre ;
         *   adjacentOnlyCredit          seule une activité voisine est déclarée.
         *
         * Rien n'a été balayé : `unprovenCoreActivityCredit` reprend la valeur
         * déjà retenue pour l'identité légale, parce que c'est la même question
         * — « lu, non conclu » — et qu'un second nombre pour une même question
         * serait un réglage déguisé.
         */
        unprovenCoreActivityCredit: z.number().min(0).max(1).default(0.5),
        /** Deux métiers ne valent pas un rejet : le métier cible est déclaré, il compte. */
        adjacentWithCoreCredit: z.number().min(0).max(1).default(0.7),
        /** Le métier cible n'est déclaré nulle part dans le cadre du site. */
        adjacentOnlyCredit: z.number().min(0).max(1).default(0.15),
      })
      .strict(),
    priority: z
      .object({
        /** Part du besoin qu'une maturité maximale retire. 0 = la maturité n'a aucun effet. */
        maturityDrag: z.number().min(0).max(1),
        /** Ce qu'il reste de la priorité quand le fit est nul mais non disqualifiant. */
        fitFloor: z.number().min(0).max(1),
        /** Plancher du facteur « capacité à payer » : un petit opérateur sérieux perd peu. */
        abilityFloor: z.number().min(0).max(1),
        /** En dessous, ce n'est plus une entreprise qu'on peut servir — un loisir. */
        abilityHobbyFloor: z.number().min(0).max(100),
        /** Valeur retenue quand l'axe est UNKNOWN : ni récompense, ni punition. */
        maturityNeutral: z.number().min(0).max(100),
        abilityNeutral: z.number().min(0).max(100),
        /** Le moment ne peut qu'ajouter, et très peu : on n'invente pas une urgence. */
        timingBonusMax: z.number().min(0).max(20),
        bands: z.object({ prioritize: z.number(), consider: z.number() }).strict(),
      })
      .strict(),
    channels: z
      .object({
        /** En dessous, un canal n'est pas retenu même s'il est le seul observé. */
        minimumFit: z.number().min(0).max(100),
        /**
         * R7.2 §1 — les canaux que l'outbound automatique a le droit de RETENIR.
         *
         * Un canal absent d'ici garde son fit : il est observé, calculé, publié,
         * et il peut servir à comprendre une entreprise. Il ne peut simplement
         * pas devenir la recommandation.
         *
         * C'est une décision produit, donc elle vit en configuration. Elle ne
         * peut cependant qu'ATTEINDRE la capacité du dépôt, jamais la dépasser :
         * `CHANNELS_WITH_OUTBOUND_RAIL` (code) intersecte cette liste, si bien
         * qu'y ajouter un canal sans rail n'ouvre rien.
         */
        selectable: z.array(z.enum(['instagram', 'email', 'phone'])).min(1),
        instagram: weightMapSchema,
        email: weightMapSchema,
        phone: weightMapSchema,
      })
      .strict(),
    /**
     * L'affinité d'une niche pour un canal, 0..1. Dans `config/` et non dans le
     * code : le atelier se vend en DM, un autre métier peut-être pas, et une
     * règle technique ne doit pas porter ce jugement de niche.
     */
    nicheChannelAffinity: z
      .object({
        instagram: z.number().min(0).max(1),
        email: z.number().min(0).max(1),
        phone: z.number().min(0).max(1),
      })
      .strict(),
    /**
     * R7.6 — les frontières de l'opportunité scalable, en configuration.
     *
     * Elles sont ici et non dans le code pour la raison qui vaut déjà pour la
     * géographie et le vocabulaire de niche : ce sont des DÉCISIONS MÉTIER. Le
     * créneau d'audience que Hermes sait servir n'est pas une propriété de
     * l'algorithme, il se discute, et il doit pouvoir changer sans qu'on
     * recompile un jugement.
     *
     * `.default()` est délibéré : un profil écrit avant R7.6 reste chargeable
     * mot pour mot, donc MODEL A, B et C restent évaluables sans qu'aucun
     * fichier ne bouge. C'est la condition d'une comparaison honnête entre
     * quatre modèles.
     */
    opportunity: scalableOpportunityConfigSchema.default({
      audience: {
        emergingBelow: 500,
        growingBelow: 2_000,
        outOfSweetSpotAtOrAbove: 10_000,
        hardExcludeOutOfSweetSpot: true,
      },
      tenure: { newBelowYears: 2, growingBelowYears: 5, establishedBelowYears: 12 },
      headroom: { funnelGapFloor: 45, abilityFloor: 55 },
    }),
  })
  .strict();

export type CommercialIntelligenceProfile = z.infer<typeof commercialIntelligenceProfileSchema>;

// ---------------------------------------------------------------------------
// Model routing
// ---------------------------------------------------------------------------
export const modelRouteSchema = z.object({
  provider: z.enum(['codex', 'openai_compatible', 'none']),
  model: z.string(),
  effort: z.string().nullable().default(null),
  timeoutMs: z.number().int().positive().default(180_000),
  maxAttempts: z.number().int().min(1).max(5).default(2),
  /**
   * R5.1 — le délai par essai, dans l'ordre des essais.
   *
   * `timeoutMs` seul décrit une politique où le second essai attend aussi
   * longtemps que le premier, qui vient pourtant de prouver que cette durée ne
   * suffisait pas. C'est ainsi qu'un appel mort immobilisait un prospect six
   * minutes en R5. Une liste permet de borner le repli — et le §16 exige que
   * ses valeurs viennent de la mesure, pas d'une intuition : elles vivent donc
   * dans `config/models.json` et nulle part dans le code.
   *
   * Absent : chaque essai reçoit `timeoutMs`, c'est-à-dire le comportement R5.
   */
  timeoutScheduleMs: z.array(z.number().int().positive()).min(1).max(5).optional(),
});

export const modelRoutingSchema = z.object({
  version: z.string(),
  /** Effort values the router is allowed to send; validated by `models:probe`. */
  declaredEfforts: z.array(z.string()).default([]),
  defaultRoute: modelRouteSchema,
  tasks: z.record(z.string(), modelRouteSchema.partial().extend({}).optional()).default({}),
});

export type ModelRoute = z.infer<typeof modelRouteSchema>;
export type ModelRoutingConfig = z.infer<typeof modelRoutingSchema>;

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------
export const discoverySourceSchema = z.object({
  provider: z.enum(['sirene', 'overpass', 'google_places', 'seed']),
  enabled: z.boolean().default(true),
  maxResults: z.number().int().positive().max(2000).default(200),
  /** Provider-specific options, validated by the adapter itself. */
  options: z.record(z.string(), z.unknown()).default({}),
});

/**
 * Google Places, the commercial rail.
 *
 * Kept out of `options` because these values decide how much money the run may
 * cost, and a cost decision deserves a validated schema rather than a bag of
 * unknowns. Defaults are sized for one benchmark run, not for a sweep.
 */
export const placesDiscoverySchema = z
  .object({
    /**
     * Radius of each search tile. Text Search returns at most 60 results per
     * query, so a dense area is covered by asking several smaller questions
     * rather than by trying to page past a documented ceiling. Smaller tiles
     * mean better coverage and more (free) discovery calls.
     */
    tileRadiusKm: z.number().positive().max(50).default(5),
    /** Ceiling on candidates carried into the billable stages. */
    maxCandidates: z.number().int().positive().max(5000).default(300),
    /**
     * Search queries for this campaign, overriding the niche's full list.
     *
     * The niche carries ten phrasings because a production sweep wants recall.
     * A gate does not: every extra phrasing multiplies discovery calls across
     * every tile to surface mostly the same establishments, and then the
     * candidate cap truncates the result anyway — so the corpus ends up shaped
     * by traversal order rather than by the area. Capped at six so "add another
     * query" cannot quietly become the way a run grows.
     */
    queries: z.array(z.string().min(2)).min(1).max(6).optional(),
  })
  .default({ tileRadiusKm: 5, maxCandidates: 300 });

/**
 * R5 — le rail de découverte commerciale.
 *
 * Chaque valeur ici décide d'une dépense, donc aucune ne vit dans un sac
 * d'`unknown` : c'est la même règle que pour Places en R2.1, et pour la même
 * raison — un plafond qu'un schéma ne valide pas est un plafond qu'une faute de
 * frappe désactive.
 *
 * Les défauts sont dimensionnés pour **un pilote**, pas pour un balayage :
 * trente entreprises uniques, quelques dizaines de requêtes. Le §4 du gate
 * demande explicitement de la qualité plutôt que cinq cents résultats, et un
 * défaut généreux serait la façon la plus simple de désobéir sans le décider.
 */
export const commercialDiscoverySchema = z
  .object({
    enabled: z.boolean().default(false),
    /**
     * Le fournisseur d'index. `serper` par défaut parce que R4-S l'a mesuré :
     * 1,7 % de requêtes sans résultat, tarif d'entrée cinq fois moindre que
     * Brave. Le champ reste ouvert pour qu'un repli soit un changement de
     * configuration et non de code — mais R5 n'ouvre aucun nouvel A/B (§2).
     */
    provider: z.string().default('serper'),
    /** Paliers de vocabulaire réellement interrogés, dans cet ordre. */
    tiers: z
      .array(z.enum(['core', 'secondary', 'service_specific', 'in_scope']))
      .min(1)
      .default(['core', 'secondary']),
    /** Termes retenus par palier. Le garde-fou contre l'explosion combinatoire (§3). */
    maxTermsPerTier: z.number().int().min(1).max(10).default(3),
    /** Résultats demandés par requête. Un compte Serper gratuit refuse au-delà de 10. */
    resultsPerQuery: z.number().int().min(1).max(10).default(10),
    /** Plafond dur de requêtes pour ce run. */
    maxQueries: z.number().int().min(1).max(300).default(60),
    /** Plafond dur d'entreprises uniques retenues (§4 : 30 au maximum). */
    maxBusinesses: z.number().int().min(1).max(200).default(30),
    /** Sites réellement ouverts et lus. Borne le temps, pas l'argent. */
    maxSitesProbed: z.number().int().min(1).max(300).default(45),
  })
  .default({
    enabled: false,
    provider: 'serper',
    tiers: ['core', 'secondary'],
    maxTermsPerTier: 3,
    resultsPerQuery: 10,
    maxQueries: 60,
    maxBusinesses: 30,
    maxSitesProbed: 45,
  });

export type CommercialDiscoveryConfig = z.infer<typeof commercialDiscoverySchema>;

export const campaignSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  niche: z.string(),
  geography: geographySchema,
  discovery: z.object({
    sources: z.array(discoverySourceSchema).min(1),
    targetProspects: z.number().int().positive().max(1000).default(20),
    places: placesDiscoverySchema,
    commercialWeb: commercialDiscoverySchema,
  }),
  enrichment: z
    .object({
      crawlWebsites: z.boolean().default(true),
      maxPagesPerSite: z.number().int().min(1).max(10).default(3),
      matchOpenStreetMap: z.boolean().default(true),
      searchForWebsite: z.boolean().default(true),
    })
    .default({
      crawlWebsites: true,
      maxPagesPerSite: 3,
      matchOpenStreetMap: true,
      searchForWebsite: true,
    }),
  qualification: z
    .object({
      useLlm: z.boolean().default(true),
      /** Verdicts allowed to continue down the pipeline. */
      keepVerdicts: z.array(z.enum(['in_niche', 'adjacent', 'uncertain', 'out_of_niche'])).default(['in_niche']),
      minConfidence: z.number().min(0).max(1).default(0.6),
    })
    .default({ useLlm: true, keepVerdicts: ['in_niche'], minConfidence: 0.6 }),
  /**
   * R5.1 — quelle architecture produit la fiche de recherche.
   *
   * `monolithic` est le rail R5 : un seul appel qui reçoit tout le pack
   * d'evidence. `workers` découpe le contexte en trois domaines avant tout
   * appel, les fait tourner en parallèle, fusionne de façon déterministe puis
   * synthétise.
   *
   * Le défaut reste `monolithic`, et ce n'est pas de la prudence rituelle : le
   * §22 interdit de basculer le pipeline principal dès qu'un benchmark paraît
   * bon. Le retour arrière doit rester un mot dans un fichier de campagne, pas
   * un `git revert`.
   */
  research: z
    .object({
      architecture: z.enum(['monolithic', 'workers']).default('monolithic'),
    })
    .default({ architecture: 'monolithic' }),
  scoring: z.object({ profile: z.string() }),
  outreach: z
    .object({
      channel: z.enum(['instagram_dm', 'email', 'sms', 'phone', 'other']).default('instagram_dm'),
      language: z.string().default('fr'),
      maxChars: z.number().int().min(200).max(2000).default(650),
      generateVariantB: z.boolean().default(true),
      /** V1 hard stop: nothing may be sent. */
      reviewOnly: z.literal(true).default(true),
    })
    .default({
      channel: 'instagram_dm',
      language: 'fr',
      maxChars: 650,
      generateVariantB: true,
      reviewOnly: true,
    }),
  limits: z
    .object({
      maxLlmCalls: z.number().int().positive().default(400),
      maxHttpRequests: z.number().int().positive().default(2000),
    })
    .default({ maxLlmCalls: 400, maxHttpRequests: 2000 }),
});

export type CampaignConfig = z.infer<typeof campaignSchema>;
export type DiscoverySourceConfig = z.infer<typeof discoverySourceSchema>;

// ---------------------------------------------------------------------------
// Rail Instagram (IG-R1)
// ---------------------------------------------------------------------------
/**
 * Les bornes du rail navigateur Instagram, dans `config/instagram.json`.
 *
 * Pourquoi un fichier de configuration et pas des constantes : ces valeurs
 * doivent pouvoir être resserrées par un humain sans toucher au code, et
 * surtout être lues à voix haute avant d'ouvrir un canari. Une limite qu'on
 * doit aller chercher dans un `const` au fond d'un module n'est pas une limite
 * qu'on relit.
 *
 * Ce que ces plafonds sont, et ce qu'ils ne sont pas : ils bornent les EFFETS
 * et la CHARGE — combien de messages au maximum, à quel rythme au minimum,
 * combien d'échecs avant de s'arrêter. Ils ne cherchent pas à imiter un
 * comportement humain ni à passer sous un radar : aucune valeur ici n'est
 * randomisée, aucune ne dépend de l'heure, et le rail n'a ni empreinte
 * falsifiée, ni proxy, ni technique d'évitement (mission IG-R1 §1).
 *
 * Aucun de ces plafonds n'autorise quoi que ce soit. Ils ne savent que
 * refuser : l'autorisation, elle, dépend de `ig_kill_switch`, qui est fermé
 * tant que personne ne l'a explicitement ouvert.
 */
export const instagramRailSchema = z.object({
  session: z
    .object({
      /**
       * Répertoire du profil navigateur persistant, relatif à la racine du
       * dépôt. Il contient des cookies de session : il DOIT rester sous un
       * chemin ignoré par Git (`var/` l'est). Le schéma le vérifie plutôt que
       * de faire confiance — une session commitée serait un secret publié.
       */
      profileDir: z
        .string()
        .min(1)
        .refine((value) => value.startsWith('var/'), {
          message: 'profileDir doit vivre sous var/ (ignoré par Git) — un profil navigateur contient des cookies',
        })
        .default('var/instagram/profile'),
      /** Étiquette journalisée en base. Jamais le chemin, jamais un cookie. */
      profileLabel: z.string().min(1).max(120).default('default'),
      /** Le défaut du worker. Le bootstrap manuel de session force l'affichage. */
      headless: z.boolean().default(true),
      navigationTimeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
      /** Fenêtre de comptage des sessions non saines (plafond `maxSessionFailures`). */
      failureWindowMs: z.number().int().min(60_000).max(86_400_000).default(3_600_000),
      /** Locale et fuseau annoncés au navigateur — cohérence, pas déguisement. */
      locale: z.string().min(2).max(20).default('fr-FR'),
      timezoneId: z.string().min(3).max(60).default('Europe/Paris'),
    }),
  caps: z
    .object({
      /** Envois réussis autorisés sur 24 h glissantes. Jamais atteint en R1 : rien ne part. */
      dailySentCap: z.number().int().min(0).max(200).default(10),
      /** Envois réussis autorisés sur 1 h glissante. */
      hourlySentCap: z.number().int().min(0).max(60).default(3),
      /** Délai minimal entre deux envois réussis. Borne la charge, pas une imitation d'humain. */
      minSendIntervalMs: z.number().int().min(0).max(86_400_000).default(900_000),
      /**
       * Échecs consécutifs (queue du journal) au-delà desquels le rail
       * s'arrête. Un rail qui échoue en boucle sur Instagram doit cesser, pas
       * réessayer plus fort.
       */
      maxConsecutiveFailures: z.number().int().min(1).max(50).default(3),
      /** Sessions navigateur non saines sur `session.failureWindowMs`. */
      maxSessionFailures: z.number().int().min(1).max(50).default(3),
    }),
  queue: z
    .object({
      /**
       * Durée du bail d'un job pris par un worker. Passé ce délai, un autre
       * worker peut le reprendre — mais seulement s'il n'a tenté aucun effet
       * externe ; sinon le job part en `REVIEW_REQUIRED` (jamais un rejeu).
       */
      leaseMs: z.number().int().min(30_000).max(3_600_000).default(300_000),
      /** Jobs traités au plus par invocation du worker. */
      maxJobsPerRun: z.number().int().min(1).max(100).default(5),
    }),
  /**
   * IG3 §4 — la politique d'ordonnancement, et pourquoi elle vit ICI.
   *
   * `caps` borne déjà COMBIEN et À QUEL RYTHME. Ce bloc répond à la question
   * que `caps` ne pose pas : QUAND. Les deux dans le même fichier, parce que
   * la mission interdit une seconde source de vérité — un fuseau dans le code
   * et un plafond dans un JSON, ce serait deux endroits à relire avant
   * d'ouvrir un canari, donc un qu'on oublierait.
   *
   * Rien ici n'imite un humain. Une fenêtre horaire existe parce qu'un premier
   * message commercial reçu à 3 h du matin est un mauvais premier message, pas
   * parce qu'il serait plus discret. Aucune valeur n'est aléatoire, et le
   * `jitterMs` ci-dessous est nul par défaut, déterministe quand il ne l'est
   * pas, et borné.
   */
  schedule: z
    .object({
      /**
       * Le fuseau dans lequel les fenêtres sont exprimées, au format IANA.
       *
       * Configurable, et le code ne connaît aucune géographie : il passe cette
       * chaîne à `Intl.DateTimeFormat` et n'a aucune branche « si France ».
       * Le défaut vaut `Europe/Paris` parce que c'est le fuseau du corpus
       * actuel — pas parce que le rail y serait couplé.
       */
      timezone: z.string().min(3).max(60).default('Europe/Paris'),
      /**
       * Les créneaux d'envoi, en heure locale du fuseau ci-dessus.
       *
       * `days` suit la numérotation ISO : 1 = lundi … 7 = dimanche. Les minutes
       * sont comptées depuis minuit, `endMinute` exclu — 540/1200 = 09:00→20:00,
       * la politique de cold outbound en vigueur (IG4.4C). « Exclu » se lit :
       * 19:59 est dedans, 20:00 pile est dehors.
       * Une liste vide serait une politique qui n'autorise rien et ne le dit
       * pas ; `min(1)` l'interdit.
       */
      windows: z
        .array(
          z
            .object({
              days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
              startMinute: z.number().int().min(0).max(1_439),
              endMinute: z.number().int().min(1).max(1_440),
            })
            .refine((w) => w.endMinute > w.startMinute, {
              message: 'endMinute doit être strictement après startMinute — une fenêtre vide ne se déclare pas',
            }),
        )
        .min(1)
        .default([{ days: [1, 2, 3, 4, 5], startMinute: 540, endMinute: 1_200 }]),
      /**
       * Étalement fonctionnel, borné et DÉTERMINISTE.
       *
       * Ce qu'il est : de quoi éviter que dix jobs enfilés dans la même seconde
       * deviennent dus à la même milliseconde. Il se calcule par un hachage de
       * la clé d'idempotence — même job, même décalage, pour toujours, sur
       * n'importe quelle machine. Un test peut donc l'asserter à la
       * milliseconde près.
       *
       * Ce qu'il n'est pas : une randomisation anti-détection. La mission
       * l'interdit explicitement, et un jitter aléatoire serait par ailleurs
       * intestable. Le défaut est `0` — aucun étalement tant que personne n'en
       * a demandé un.
       */
      jitterMs: z.number().int().min(0).max(3_600_000).default(0),
      /**
       * De combien on repousse un job dont le report n'a pas d'échéance
       * calculable — une panne de rail, une session perdue, une dérive de
       * manifeste. Les reports qui SAVENT quand ils expirent (plafond, fenêtre,
       * cadence) n'utilisent pas cette valeur : ils calculent leur date.
       */
      defaultBackoffMs: z.number().int().min(1_000).max(86_400_000).default(900_000),
    })
    // Un dépôt dont `config/instagram.json` précède IG3 reste lisible : le bloc
    // absent vaut le bloc par défaut, jamais une erreur de démarrage.
    //
    // `prefault` et non `default` : la valeur fournie est une ENTRÉE, qui
    // retraverse donc le schéma et hérite des défauts de chaque champ. Avec
    // `default`, il aurait fallu réécrire ici les quatre valeurs — une seconde
    // source de vérité, à côté de celle qu'on vient d'écrire dix lignes plus haut.
    .prefault({}),
  /**
   * IG5.1 §10 — la RELÈVE ENTRANTE, et pourquoi elle ne partage rien avec
   * `schedule`.
   *
   * `schedule` est une politique de COLD OUTBOUND : elle existe parce qu'un
   * premier message commercial reçu à 3 h du matin est un mauvais premier
   * message. Rien de cela ne s'applique à la lecture d'une boîte — un prospect
   * qui répond à 22:00 doit être détecté à 22:00, et attendre 09:00 pour le
   * SAVOIR ne protège personne : cela ne fait que retarder la réponse d'un
   * humain.
   *
   * Ce bloc n'a donc ni fenêtre, ni jour, ni fuseau. C'est délibéré, et c'est
   * ce qui garantit qu'aucun futur diff ne branchera la collecte sur la fenêtre
   * sortante « pour uniformiser » : il n'y a rien à brancher.
   */
  inbound: z
    .object({
      /**
       * Le compte qui relève — le NÔTRE, tel qu'il s'appelle AUJOURD'HUI.
       * `null` par défaut : personne ne doit hériter d'un compte qu'il n'a pas
       * nommé, et la CLI refuse de tourner sans lui plutôt que d'en deviner un
       * depuis la session ouverte.
       */
      accountHandle: z
        .string()
        .regex(/^[A-Za-z0-9._]{1,30}$/, 'un handle Instagram, sans @')
        .nullable()
        .default(null),
      /**
       * HERMES-IDENTITY-CANONICALIZATION-R1 §6 — les handles que ce MÊME compte
       * a portés avant, et pourquoi ils sont en configuration.
       *
       * Un handle Instagram est mutable. Le 22 août 2026, `hermesagency_` est
       * devenu `hermes__`, et les huit messages déjà relevés portent le nom
       * d'avant dans `r6b_inbound_messages.mailbox` — un fait d'observation
       * daté, qui reste vrai. Les réécrire aurait effacé le seul endroit où le
       * dépôt sait sous quel nom il a lu ces messages ; ne rien faire aurait
       * laissé `sendThreadReply` confronter un nom périmé à la session
       * courante, donc refuser pour toujours.
       *
       * Cette liste est la troisième voie : elle dit « ces noms étaient nous »,
       * ce qui laisse l'histoire intacte ET rend le rattachement décidable. Ce
       * n'est pas une donnée observée — personne ne peut la déduire d'une page —
       * mais une ASSERTION d'exploitation, et sa place est donc un fichier
       * versionné qu'une personne signe, pas une ligne écrite par un worker.
       *
       * Vide par défaut : un compte qui n'a jamais changé de nom n'a rien à
       * déclarer, et une liste non vide doit toujours répondre d'un incident.
       */
      formerAccountHandles: z
        .array(z.string().regex(/^[A-Za-z0-9._]{1,30}$/, 'un handle Instagram, sans @'))
        .default([]),
      /** Fils ouverts au plus par tour. Une borne, jamais « tous ». */
      maxThreadsPerPoll: z.number().int().min(1).max(50).default(10),
      /**
       * Durée du bail d'un tour de relève. Passé ce délai, un tour resté
       * `RUNNING` (processus tué) peut être clos par le suivant — reprendre est
       * gratuit, puisqu'une relève ne produit aucun effet externe et que
       * l'ingestion est protégée par un index unique.
       */
      leaseMs: z.number().int().min(30_000).max(3_600_000).default(300_000),

      /**
       * IG5.2A — le RUNTIME. Désarmé par défaut, et ce défaut n'est pas une
       * précaution de style : un rail qui démarrerait parce qu'il a été
       * déployé ouvrirait un navigateur sur une session Instagram que personne
       * n'a décidé d'ouvrir. L'armer demande un diff ou une variable
       * d'environnement — donc quelqu'un.
       *
       * Ce drapeau n'a AUCUN rapport avec `ig_kill_switch` : celui-ci arrête
       * les effets SORTANTS, et lire une boîte n'en est pas un. Les brancher
       * l'un sur l'autre rendrait un prospect invisible précisément pendant un
       * incident d'envoi.
       */
      enabled: z.boolean().default(false),
      /**
       * L'intervalle entre la FIN d'un tour réussi et le suivant.
       *
       * 5 minutes par défaut. Le raisonnement, puisqu'il n'y avait aucune
       * convention à reprendre — ce dépôt n'a aucun démon, toutes ses
       * commandes font une passe et sortent :
       *
       *   * l'objectif produit est un speed-to-lead de quelques minutes ; à
       *     cette cadence une réponse est découverte en 2 min 30 en moyenne et
       *     5 min au pire, avant l'aval qui suit dans le même tour ;
       *   * c'est 288 ouvertures de boîte par jour, soit moins qu'un humain
       *     attentif — donc rien qui ressemble à du martèlement, ce que §5 de
       *     CLAUDE.md interdit autant que la mission ;
       *   * c'est le même ordre de grandeur que `leaseMs` (300 000), ce qui
       *     évite qu'un tour lent croise le suivant ; et si cela arrivait,
       *     l'index partiel unique de `ig_inbound_polls` tranche de toute
       *     façon.
       *
       * Le minimum de 60 000 ms est une borne dure : aucune configuration ne
       * peut demander une relève par minute.
       */
      pollIntervalMs: z.number().int().min(60_000).max(3_600_000).default(300_000),
      /**
       * Le premier palier de recul après un tour non réussi. Doublé à chaque
       * échec consécutif, plafonné par `maxBackoffMs`. Aucun aléa : deux
       * collecteurs dans le même état attendent la même chose.
       */
      retryBackoffMs: z.number().int().min(60_000).max(3_600_000).default(600_000),
      /** Le plafond du recul exponentiel. Un rail en panne ne s'endort jamais plus que cela. */
      maxBackoffMs: z.number().int().min(60_000).max(21_600_000).default(3_600_000),
      /**
       * Le recul devant un état qui demande un HUMAIN (session à refaire,
       * défi, CAPTCHA, blocage). Long exprès : réessayer serré ne réparerait
       * rien et ressemblerait à un contournement. Ce n'est pas un abandon — on
       * revérifie, parce qu'un humain a pu réparer la session entre-temps.
       */
      awaitingHumanBackoffMs: z.number().int().min(300_000).max(21_600_000).default(1_800_000),
      /** Réponses traitées au plus par tour d'aval. Une borne, jamais « toutes ». */
      downstreamLimit: z.number().int().min(1).max(500).default(50),
    })
    .prefault({})
    // Un plafond sous son plancher n'est pas une configuration prudente, c'est
    // une configuration fausse : le recul cesserait de croître avant d'avoir
    // commencé. Refusé au chargement plutôt que corrigé en silence.
    .refine((inbound) => inbound.maxBackoffMs >= inbound.retryBackoffMs, {
      message: 'inbound.maxBackoffMs doit être ≥ inbound.retryBackoffMs',
      path: ['maxBackoffMs'],
    })
    // Un ancien handle qui est aussi le courant décrit deux choses avec un seul
    // mot — exactement la confusion que `formerAccountHandles` existe pour
    // défaire. Refusé au chargement, où le fichier fautif est encore sous les
    // yeux de celui qui l'a écrit.
    .refine(
      (inbound) =>
        inbound.accountHandle === null ||
        !inbound.formerAccountHandles.some(
          (handle) => handle.toLowerCase() === inbound.accountHandle?.toLowerCase(),
        ),
      {
        message: 'inbound.formerAccountHandles ne peut pas contenir inbound.accountHandle',
        path: ['formerAccountHandles'],
      },
    )
    .refine(
      (inbound) =>
        new Set(inbound.formerAccountHandles.map((handle) => handle.toLowerCase())).size ===
        inbound.formerAccountHandles.length,
      {
        message: 'inbound.formerAccountHandles ne peut pas répéter un handle',
        path: ['formerAccountHandles'],
      },
    ),
});

export type InstagramRailConfig = z.infer<typeof instagramRailSchema>;

/**
 * R7.3C §5 — la configuration de l'OBSERVER, séparée de celle du rail outbound.
 *
 * Deux blocs plutôt qu'un champ de plus dans `instagramRailSchema`, et la raison
 * est la seule qui vaille ici : un champ partagé se modifie par inadvertance.
 * `config/instagram.json` décrit le rail qui a envoyé le canari commercial ;
 * `config/r7-instagram-observer.json` décrit un rail qui ne sait pas envoyer.
 * Les confondre dans un même objet reviendrait à mettre la clé de la porte
 * d'entrée sur le même anneau que celle de la boîte aux lettres.
 *
 * `profileDir` porte la garantie qui compte : le profil navigateur de
 * l'observer n'est pas celui du rail outbound. Le schéma exige `var/r7/` —
 * c'est-à-dire un préfixe que `var/instagram/profile` ne peut pas satisfaire —
 * et `assertObserverProfileIsolated` re-vérifie au démarrage sur les chemins
 * RÉSOLUS, parce qu'un lien symbolique se moque d'un préfixe de chaîne.
 */
export const instagramObserverSchema = z.object({
  session: z.object({
    /**
     * Profil navigateur DÉDIÉ. Sous `var/r7/` : ignoré par Git, et hors du
     * répertoire du rail outbound par construction du préfixe.
     */
    profileDir: z
      .string()
      .min(1)
      .refine((value) => value.startsWith('var/r7/'), {
        message:
          'profileDir de l’observer doit vivre sous var/r7/ — un préfixe distinct de celui du rail outbound, ' +
          'pour qu’aucune édition ne puisse les faire se rejoindre par accident',
      })
      .default('var/r7/instagram-profile-observer'),
    profileLabel: z.string().min(1).max(120).default('r7-observer'),
    headless: z.boolean().default(true),
    navigationTimeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
    locale: z.string().min(2).max(20).default('fr-FR'),
    timezoneId: z.string().min(3).max(60).default('Europe/Paris'),
    viewport: z
      .object({
        width: z.number().int().min(320).max(3_840).default(1_280),
        height: z.number().int().min(320).max(2_160).default(1_400),
      })
      .prefault({}),
  }),
  /**
   * R7.3C §30 — la cadence. Rien ici n'imite un humain et rien n'est aléatoire :
   * `jitterMs` est déterministe (dérivé du handle) et borné, et il existe pour
   * étaler la charge, pas pour la dissimuler.
   */
  pace: z
    .object({
      /** Un profil à la fois. La mission le fixe à 1 et rien n'a besoin de plus. */
      concurrency: z.literal(1).default(1),
      /** Repos minimal entre deux profils. */
      betweenProfilesMs: z.number().int().min(0).max(600_000).default(9_000),
      /** Étalement déterministe ajouté au repos, dérivé du handle. */
      jitterMs: z.number().int().min(0).max(120_000).default(4_000),
      /** Attente de stabilisation après chargement, avant lecture. */
      settleMs: z.number().int().min(0).max(60_000).default(2_500),
      /**
       * R7.3D — attente MAXIMALE d'une charge utile de publications déjà demandée
       * par la page.
       *
       * `settleMs` est un plancher : on écoute au moins ce temps. Ce plafond dit
       * jusqu'où on accepte d'écouter ENCORE si le fil n'est pas arrivé. Onze
       * profils sur vingt-huit sont sortis `PARTIAL` sur une attente fixe de
       * 2,5 s alors que leur fil arrivait ensuite — la donnée existait, nous
       * avions raccroché. Attendre plus longtemps n'émet aucune requête
       * supplémentaire : c'est la même page, écoutée jusqu'au bout.
       */
      maxSettleMs: z.number().int().min(0).max(60_000).default(9_000),
      /**
       * Reprises autorisées, et seulement sur une panne transitoire clairement
       * identifiée (§31). Jamais sur un challenge, un blocage, un compte privé
       * ni une contradiction d'identité.
       */
      maxTransientRetries: z.number().int().min(0).max(1).default(1),
      /** Profils observés au plus par exécution. Un plafond, jamais un objectif. */
      maxProfilesPerRun: z.number().int().min(1).max(200).default(10),
    })
    .prefault({}),
  artifacts: z
    .object({
      /** Racine des artefacts locaux. Sous `var/`, donc hors Git. */
      root: z
        .string()
        .min(1)
        .refine((value) => value.startsWith('var/'), {
          message: 'les artefacts de collecte contiennent des captures d’écran : ils restent sous var/',
        })
        .default('var/r7/instagram-maturity'),
      /** Captures du profil. Désactivables sans rien casser d'autre. */
      screenshots: z.boolean().default(true),
    })
    .prefault({}),
});

export type InstagramObserverConfig = z.infer<typeof instagramObserverSchema>;

/**
 * R7.3C §23 — les poids de l'axe social, dans un fichier à eux.
 *
 * Pas dans `config/commercial-intelligence/example-shadow-v1.json`, et c'est une
 * précaution, pas une préférence de rangement : ce fichier-là décrit MODEL A,
 * c'est-à-dire le modèle dont la mission demande de mesurer les écarts. Y ajouter
 * un bloc rendrait le diff de Model B illisible et ferait passer un ajout
 * expérimental pour une évolution du modèle de référence.
 *
 * `includeVisualMaturity` est ici plutôt qu'en argument de ligne de commande
 * pour que la configuration comparée soit un FICHIER — donc citable dans un
 * rapport, et rejouable à l'identique.
 */
export const socialMaturitySchema = z.object({
  key: z.string().min(1),
  version: z.string().min(1),
  label: z.string().min(1),
  note: z.string().default(''),
  weights: z.object({
    posting_recency: z.number().min(0).max(100),
    posting_cadence: z.number().min(0).max(100),
    profile_completeness: z.number().min(0).max(100),
    highlights: z.number().min(0).max(100),
    visual_maturity: z.number().min(0).max(100),
  }),
  confidence: z.object({
    high: z.number().min(0).max(1),
    medium: z.number().min(0).max(1),
  }),
  includeVisualMaturity: z.boolean(),
  /**
   * R7.3C — le plancher de couverture de l'axe social.
   *
   * `0.5` exige qu'au moins l'un des deux comptages (récence 34, cadence 30)
   * ait été observé : la complétude, les à la une et la maturité visuelle
   * réunies plafonnent à 0,36. C'est une décision de MODÈLE, pas un réglage
   * cosmétique — elle interdit d'affirmer une maturité d'acquisition sans avoir
   * vu une seule publication.
   */
  minimumCoverage: z.number().min(0).max(1),
});

export type SocialMaturityProfile = z.infer<typeof socialMaturitySchema>;

// ---------------------------------------------------------------------------
// HERMES-CONVERSATION-R2 — les bornes de la conversation autonome
// ---------------------------------------------------------------------------

/**
 * Un fichier À PART de `config/instagram.json`, et la raison est celle qui a
 * déjà séparé l'observer du rail : un champ partagé se modifie par
 * inadvertance. `config/instagram.json` décrit ce qui sait ENVOYER — plafonds,
 * fenêtre, cadence, arrêt. Celui-ci décrit ce qui sait DÉCIDER — combien de
 * temps attendre avant de répondre, combien de relances, à quel rythme.
 *
 * Ce que ce fichier ne contient PAS, et ne doit jamais contenir :
 *
 *   * l'identité de la politique. `CONVERSATION_POLICY_VERSION` vit dans
 *     `src/lib/conversation/autonomy.ts`, à côté des règles : une version qui
 *     se règle sans toucher aux règles finirait par décrire autre chose que ce
 *     qui a réellement décidé ;
 *   * une fenêtre horaire. La conversation hérite de celle du rail sortant, et
 *     ce choix est une DÉCISION écrite en code (`CONVERSATION_WINDOW_POLICY`),
 *     pas un réglage qu'une édition de fichier pourrait élargir ;
 *   * un plafond d'envoi. Une réponse et une relance sont des effets Instagram
 *     comme les autres ; elles comptent dans `config/instagram.json → caps`, et
 *     un second quota serait exactement la façon de dépasser le premier sans le
 *     voir.
 */
export const conversationPolicySchema = z.object({
  reply: z
    .object({
      /**
       * Le délai humain minimal avant de répondre (§22).
       *
       * Il n'imite personne et ne dissimule rien : il évite qu'une machine
       * réponde en deux cents millisecondes à quelqu'un qui vient d'écrire, ce
       * qu'aucune personne ne fait. Déterministe — le décalage à l'intérieur de
       * la bande est dérivé de la clé d'idempotence, donc la même conversation
       * obtient toujours la même attente.
       */
      minDelayMs: z.number().int().min(0).max(3_600_000).default(90_000),
      maxDelayMs: z.number().int().min(0).max(7_200_000).default(420_000),
      /**
       * §23 — le silence au bout duquel une salve est CLOSE.
       *
       * Instagram encourage à écrire trois bulles d'affilée. Tant que la
       * dernière est plus récente que ce délai, la personne est peut-être
       * encore en train de taper, et répondre à la deuxième bulle sur trois est
       * la signature la plus lisible d'un robot.
       */
      burstQuietMs: z.number().int().min(0).max(3_600_000).default(300_000),
      /**
       * La confiance D2 minimale pour qu'une réponse parte SANS humain.
       *
       * Strictement au-dessus de `MIN_ACTIONABLE_CONFIDENCE` (0,60), qui dit
       * seulement « cette étiquette est une conclusion ». Répondre seul demande
       * davantage : une lecture dont on n'a pas besoin de discuter.
       */
      minConfidence: z.number().min(0).max(1).default(0.85),
    })
    .prefault({})
    .refine((reply) => reply.maxDelayMs >= reply.minDelayMs, {
      message: 'reply.maxDelayMs doit être ≥ reply.minDelayMs',
      path: ['maxDelayMs'],
    }),

  followUp: z
    .object({
      /**
       * §16 — deux relances, puis l'arrêt. Le plafond est une BORNE de schéma,
       * pas seulement un défaut : aucune édition de fichier ne peut demander
       * une séquence de cinq relances.
       */
      maxAttempts: z.number().int().min(0).max(2).default(2),
      /** §15 — délai entre le premier message resté sans réponse et la relance 1. */
      firstDelayMs: z.number().int().min(3_600_000).max(2_592_000_000).default(259_200_000),
      /** §16 — délai entre la relance 1 et la relance 2. */
      secondDelayMs: z.number().int().min(3_600_000).max(5_184_000_000).default(604_800_000),
      /**
       * §17 — la fenêtre prudente quand quelqu'un a dit « pas maintenant » sans
       * dire quand. Un mois : assez long pour ne pas insister, assez court pour
       * que la conversation ne soit pas oubliée.
       */
      notNowDefaultDelayMs: z.number().int().min(86_400_000).max(15_552_000_000).default(2_592_000_000),
      /**
       * Les bornes d'un délai DEMANDÉ par le prospect. Un « rappelez-moi
       * demain » ne doit pas produire une relance dans dix-huit heures — la
       * lecture d'une date est déterministe mais faillible, et le plancher est
       * ce qui empêche une erreur de lecture de devenir un harcèlement.
       */
      requestedMinDelayMs: z.number().int().min(86_400_000).max(2_592_000_000).default(604_800_000),
      requestedMaxDelayMs: z.number().int().min(86_400_000).max(31_536_000_000).default(15_552_000_000),
    })
    .prefault({})
    .refine((followUp) => followUp.requestedMaxDelayMs >= followUp.requestedMinDelayMs, {
      message: 'followUp.requestedMaxDelayMs doit être ≥ followUp.requestedMinDelayMs',
      path: ['requestedMaxDelayMs'],
    }),
});

export type ConversationPolicyConfig = z.infer<typeof conversationPolicySchema>;

// ---------------------------------------------------------------------------
// HERMES-NATIVE-BOOKING-R1 — la DISPONIBILITÉ de l'opérateur
// ---------------------------------------------------------------------------

/**
 * Les bornes du rendez-vous natif, dans `config/booking.json`.
 *
 * Un fichier À PART de `config/instagram.json` et de `config/conversation.json`,
 * pour la raison qui a séparé les deux premiers : ils décrivent trois choses
 * différentes — ce qui ENVOIE, ce qui DÉCIDE de répondre, et ce qui dit QUAND
 * l'opérateur est joignable — et aucune valeur n'est partagée. Élargir une
 * disponibilité ne doit pas pouvoir déplacer un plafond d'envoi par ricochet.
 *
 * ---------------------------------------------------------------------------
 * `appointmentDurationMinutes` n'a PAS de défaut, et c'est délibéré
 * ---------------------------------------------------------------------------
 * L'audit de HERMES-NATIVE-BOOKING-R1 a relu le dépôt : aucune durée canonique
 * de rendez-vous n'existait — ni dans `config/`, ni en base, ni dans
 * l'environnement, ni dans `sales/`. La seule mention d'une durée dans une
 * consigne commerciale est « quinze minutes », qui appartient au LEXIQUE de
 * `naturalness.ts` (ce qu'un texte a le droit de dire) et non à un agenda.
 *
 * Une valeur par défaut dans ce schéma serait donc une connaissance métier
 * CACHÉE : personne ne l'aurait décidée, et elle déciderait pourtant de la
 * durée réelle des rendez-vous d'un vrai commerçant. Le schéma l'exige, le
 * fichier la porte, et le rapport de round la nomme.
 */
export const bookingPolicySchema = z.object({
  /**
   * L'agenda visé. UNE seule valeur en R1 — l'opérateur est seul.
   *
   * La colonne existe pour que le jour où un second agenda apparaît, la donnée
   * sache déjà le dire. Ce que ce round n'ouvre pas : la contrainte d'exclusion
   * de 0061 refuse tout chevauchement TOUS AGENDAS CONFONDUS, ce qui est
   * strictement plus strict que « par agenda ». Refuser trop est la direction
   * sûre ; l'assouplir demandera une migration délibérée (`btree_gist`).
   */
  calendarKey: z.string().min(1).max(64).default('hermes-operator'),
  /** Fuseau IANA. Aucune géographie en dur : la chaîne part telle quelle à `Intl`. */
  timezone: z.string().min(3).max(60).default('Europe/Paris'),
  /**
   * Combien de temps le créneau est BLOQUÉ dans l'agenda. Sans défaut — voir
   * l'en-tête.
   *
   * C'est la durée TECHNIQUE : celle qui occupe le calendrier, qui entre dans
   * la contrainte d'exclusion, et qui décide si deux rendez-vous se
   * chevauchent. Ce n'est PAS forcément celle qu'on annonce — voir
   * `presentedDuration`.
   */
  appointmentDurationMinutes: z.number().int().min(5).max(480),
  /**
   * Ce qu'on ANNONCE au prospect, et qui n'est pas la même chose.
   *
   * Un rendez-vous présenté comme « 20 à 25 minutes » se réserve sur un bloc de
   * 25 : la marge appartient à l'opérateur, pas à la conversation. Les deux
   * valeurs vivent donc côte à côte plutôt que l'une d'elles étant déduite de
   * l'autre — les déduire ferait mentir l'une des deux le jour où elles
   * divergent volontairement.
   *
   * L'invariant qui les relie est vérifié plus bas : on n'annonce JAMAIS plus
   * long que ce qu'on bloque. L'inverse — annoncer plus court que le bloc —
   * est licite et voulu : c'est la marge.
   */
  presentedDuration: z
    .object({
      minMinutes: z.number().int().min(5).max(480),
      maxMinutes: z.number().int().min(5).max(480),
    })
    .refine((d) => d.maxMinutes >= d.minMinutes, {
      message: 'presentedDuration.maxMinutes doit être ≥ minMinutes',
    })
    .default({ minMinutes: 20, maxMinutes: 25 }),
  /**
   * Le pas des créneaux PROPOSÉS.
   *
   * Il ne borne QUE ce que Hermes propose de lui-même. Un créneau demandé par
   * le prospect à 10 h 20 reste jugé sur la disponibilité réelle, pas sur une
   * grille : refuser 10 h 20 parce qu'il n'est pas sur le quart d'heure serait
   * un refus que rien ne justifie.
   */
  slotGranularityMinutes: z.number().int().min(5).max(240).default(30),
  /** Le préavis minimal. Un rendez-vous dans huit minutes n'en est pas un. */
  minNoticeMinutes: z.number().int().min(0).max(20_160).default(120),
  /** Jusqu'où en avant on accepte de fixer quoi que ce soit. */
  maxHorizonDays: z.number().int().min(1).max(120).default(14),
  /**
   * Combien de créneaux Hermes propose à la fois.
   *
   * Deux, et pas cinq : une liste de créneaux est une liste de questions, et
   * §8 du dépôt tient qu'un message porte une idée. Le plafond est ici plutôt
   * que dans le prompt parce qu'un prompt ne se teste pas.
   */
  maxProposedSlots: z.number().int().min(1).max(4).default(2),
  /**
   * Les fenêtres hebdomadaires de disponibilité.
   *
   * Même forme que `instagram.schedule.windows` — jours ISO (1 = lundi),
   * minutes depuis minuit — pour qu'un opérateur qui a déjà lu l'une sache lire
   * l'autre.
   *
   * SANS DÉFAUT, et c'est le point. Ce champ portait autrefois un repli à
   * 24 h / 24, 7 j / 7 : une instance qui oubliait de déclarer ses heures se
   * retrouvait donc à proposer des créneaux à trois heures du matin, un
   * dimanche, sans que personne ne l'ait décidé. « Non déclaré » ne peut pas
   * vouloir dire « toujours disponible » — c'est la définition même d'un
   * défaut permissif, et cette édition n'en livre pas. Un fichier de
   * configuration sans fenêtre est une ERREUR de chargement, refusée avant
   * qu'aucun créneau n'existe.
   */
  weeklyWindows: z
    .array(
      z
        .object({
          days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
          startMinute: z.number().int().min(0).max(1_440),
          endMinute: z.number().int().min(0).max(1_440),
        })
        .refine((w) => w.endMinute > w.startMinute, {
          message: 'endMinute doit être strictement après startMinute — une fenêtre vide ne se déclare pas',
        }),
    )
    .min(1),
  /**
   * Les indisponibilités PONCTUELLES, en instants absolus (ISO 8601).
   *
   * Vide en R1. C'est la place que §22 de la mission demande de préparer sans
   * la remplir : « demain je ne suis pas disponible entre 13 h et 17 h » est
   * une ligne de plus ici, sans changement de code et sans migration. Ce round
   * ne construit PAS l'interface conversationnelle qui l'écrirait.
   */
  blackouts: z
    .array(
      z
        .object({
          startsAt: z.string().min(10).max(40),
          endsAt: z.string().min(10).max(40),
          reason: z.string().min(1).max(200).optional(),
        })
        .refine((b) => Date.parse(b.endsAt) > Date.parse(b.startsAt), {
          message: 'endsAt doit être strictement après startsAt — une indisponibilité vide ne se déclare pas',
        }),
    )
    .default([]),
}).superRefine((policy, ctx) => {
  // On n'annonce jamais plus long que ce qu'on bloque.
  //
  // Une durée annoncée supérieure au bloc réservé produirait des rendez-vous
  // qui se chevauchent DANS LA VRAIE VIE tout en étant parfaitement disjoints
  // en base : la contrainte d'exclusion serait verte, et l'opérateur aurait
  // deux appels qui se marchent dessus. C'est le seul désaccord entre ces deux
  // valeurs qui coûte quelque chose, et il est refusé au chargement.
  if (policy.presentedDuration.maxMinutes > policy.appointmentDurationMinutes) {
    ctx.addIssue({
      code: 'custom',
      path: ['presentedDuration', 'maxMinutes'],
      message:
        `on annonce ${String(policy.presentedDuration.maxMinutes)} min pour un créneau bloqué ` +
        `${String(policy.appointmentDurationMinutes)} min — annoncer plus long que le bloc ` +
        'produit des rendez-vous qui se chevauchent dans la réalité sans se chevaucher en base',
    });
  }
});

export type BookingPolicyConfig = z.infer<typeof bookingPolicySchema>;
