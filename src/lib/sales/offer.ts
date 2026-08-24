/**
 * HERMES-SALES-KNOWLEDGE-R1 §6 à §9, §27 à §30 — l'OFFRE Hermes réelle, et la
 * seule façon vraie de la dire.
 *
 * ---------------------------------------------------------------------------
 * Ce qui change, et pourquoi ce fichier n'est pas une permission
 * ---------------------------------------------------------------------------
 * Jusqu'ici, ce dépôt ne portait AUCUNE condition commerciale, et il le disait
 * en toutes lettres : `COMMERCIAL_POLICY_STATUS = 'MISSING'`. Toute question
 * qui touchait au prix, à la garantie ou au modèle de rémunération escaladait,
 * parce que la réponse honnête n'était pas rédigeable sans inventer.
 *
 * Une chose, et une seule, existe désormais : un essai de sept jours pendant
 * lequel Hermes ne facture pas ses frais de service, le budget publicitaire
 * restant à la charge du prospect. Ce fichier l'écrit, la borne, et écrit
 * surtout tout ce qui N'EST TOUJOURS PAS défini — ce qui reste, de loin, la
 * plus longue des deux listes.
 *
 * Il n'ouvre donc pas une porte : il déplace UNE brique de la colonne « on ne
 * sait pas » vers la colonne « on sait ». Le prix après l'essai, l'abonnement,
 * l'engagement, le minimum de budget, le remboursement — tout cela escalade
 * exactement comme avant, et un test le vérifie phrase par phrase.
 *
 * ---------------------------------------------------------------------------
 * §9 — les deux offres qu'il ne faut jamais confondre
 * ---------------------------------------------------------------------------
 * La source experte de ce round propose « ne me payez pas tant que je n'ai pas
 * obtenu vos résultats » (sales-source-001-p023, 35:53-36:19). L'offre Hermes
 * dit autre chose :
 *
 *     source  : le prospect ne dépense RIEN tant qu'il n'a pas de résultat ;
 *     Hermes : le prospect ne paie pas NOS FRAIS pendant sept jours,
 *               et il paie SON BUDGET PUBLICITAIRE dès le premier.
 *
 * La distance entre les deux est un compte en banque. Quelqu'un qui lit
 * « essai gratuit » et découvre qu'il doit financer des annonces a reçu une
 * promesse fausse, écrite par une machine, sans que personne l'ait relue. C'est
 * ce que `checkTrialStatement` empêche, et c'est la raison d'être de
 * `TRIAL_AD_SPEND_OMITTED` : aucune autre garde du dépôt ne l'attrape.
 *
 * ---------------------------------------------------------------------------
 * Les montants, et pourquoi ce paragraphe a changé
 * ---------------------------------------------------------------------------
 * Ce fichier a longtemps porté une règle plus courte : *aucun montant n'est
 * écrit ici, pas même « 0 € »*, parce que `checkReplyDraft` passait
 * `allowedNumbers: []` et bloquait tout. Cette phrase n'est plus exacte, et la
 * laisser serait le pire des deux mondes — une garde qui autorise deux montants
 * sous une règle écrite qui les nie.
 *
 * Ce qui n'a PAS changé : aucun montant n'est écrit dans CE fichier. Les faits
 * de l'essai restent une durée, une absence de frais et une attribution de
 * charge ; `HERMES_TRIAL.hermesServiceFeeDuringTrial` est un zéro typé, pas
 * une formulation.
 *
 * Ce qui a changé : depuis `HERMES-ACQUISITION-SERVICE-TRUTH-R1`, le budget
 * publicitaire de départ est écrit, donc citable — et depuis
 * `HERMES-TRIAL-COST-VS-POST-TRIAL-PRICING-R1`, un tour qui demande ce que
 * coûte le TEST reçoit ces montants ET le zéro des frais de service. La garde
 * n'est pas desserrée : elle reçoit, pour ce tour-là et par
 * `sales/priceSubject.ts`, la liste exacte de ce qu'une vérité couvre. Tout
 * autre montant — à commencer par le prix de la suite — bloque comme avant.
 *
 * La préférence, elle, tient toujours : « je ne facture pas mes frais de
 * service sur cette période » se lit mieux qu'un « 0 € » qui se confond avec
 * « gratuit ». Le prompt la porte ; la garde, elle, autorise sans obliger.
 */

import { detectPerformanceClaims } from '@/lib/learning/offer';
import { loadOfferProfile } from '@/lib/sales/offerProfile';
import { normalizeForMatching } from '@/lib/conversation/text';

/**
 * L'identifiant de l'OFFRE, distinct de celui de la politique commerciale.
 *
 * Deux questions différentes : « que propose Hermes ? » et « qu'est-ce que
 * Hermes a le droit d'engager ? ». L'offre peut changer sans que les
 * interdictions bougent, et l'inverse. Une étiquette commune ferait couvrir
 * l'une par les décisions rendues sous l'autre.
 */
/**
 * HERMES-ACQUISITION-SERVICE-TRUTH-R1 §5 — pourquoi r2.
 *
 * Un fait de plus, et un seul : ce qui est réellement MIS EN PLACE pendant les
 * sept jours. L'opérateur l'a écrit le 23 août 2026 — au minimum les
 * publicités Meta et le CRM, c'est-à-dire ce qu'il faut pour que le test teste
 * quelque chose.
 *
 * Il manquait, et l'omission se voyait : r1 disait combien de temps dure le
 * test et qui paie quoi, sans jamais dire ce qui tourne pendant. Un prospect
 * qui demande « et pendant les sept jours, il se passe quoi ? » recevait une
 * réponse sur la facturation.
 *
 * Rien d'autre ne bouge : la durée, l'absence de frais de service, le budget
 * publicitaire à la charge du prospect et la suite payante sont inchangés mot
 * pour mot, et `checkTrialStatement` continue d'exiger les trois ensemble.
 */
/**
 * HERMES-TRIAL-COST-VS-POST-TRIAL-PRICING-R1 §5 — pourquoi r3.
 *
 * AUCUN fait de l'essai ne change : la durée, l'absence de frais de service, le
 * budget publicitaire à la charge du prospect et la suite payante sont
 * inchangés mot pour mot, et `checkTrialStatement` continue d'exiger les trois
 * ensemble.
 *
 * Ce qui change est la CONSIGNE sur les montants, et il fallait la changer.
 * L'en-tête de ce fichier expliquait pourquoi « 0 € » ne s'écrivait pas :
 * `checkReplyDraft` bloquait tout montant, et la gratuité des frais de service
 * se dit très bien sans chiffre. L'argument tenait tant qu'AUCUN montant
 * n'était citable. Depuis `HERMES-ACQUISITION-SERVICE-TRUTH-R1`, le budget
 * publicitaire de départ l'est — et sur un tour qui demande le coût du test,
 * les deux blocs entraient dans le même prompt en se contredisant : l'un
 * donnait 20 à 25 € par jour, l'autre interdisait tout montant « pas même
 * zéro ». Un modèle placé devant deux règles contraires en suit une, et
 * personne ne sait laquelle.
 *
 * La consigne devient donc conditionnelle, et elle reste fermée par défaut :
 * sans montant citable, le bloc rendu est celui d'avant AU CARACTÈRE PRÈS.
 */
export const HERMES_OFFER_VERSION = 'hermes-offer-trial-r3';

/**
 * Les faits de l'essai. Rien d'autre n'est vrai à son sujet.
 *
 * `as const` et gelé : ce sont des FAITS commerciaux, pas des réglages. Les
 * mettre dans `config/` inviterait à les modifier sans revue, alors que chaque
 * champ engage Hermes auprès de quelqu'un.
 */
export const HERMES_TRIAL = Object.freeze({
  durationDays: 7,
  /** Frais de service Hermes pendant l'essai. Zéro. */
  hermesServiceFeeDuringTrial: 0,
  /** Qui finance les annonces pendant l'essai. Le prospect, dès le premier jour. */
  adSpendDuringTrialPaidBy: 'PROSPECT' as const,
  /** Ce qui se passe au terme des sept jours. */
  continuationAfterTrial: 'PROSPECT_DECIDES' as const,
});

/**
 * §8 — ce que cette mission n'a PAS défini, et qui escalade donc toujours.
 *
 * Une liste positive de manques plutôt qu'un silence : « tout ce qui n'est pas
 * l'essai est inconnu » se relit mal, et se relit surtout comme une invitation
 * à combler au jugé. Ces entrées sont rendues dans le prompt, exactement comme
 * les manques de grounding, parce qu'un modèle à qui l'on nomme le trou le
 * contourne, là où un modèle à qui l'on ne dit rien le comble.
 */
export const UNDEFINED_COMMERCIAL_TERMS: readonly string[] = Object.freeze([
  'le prix après les sept jours — aucun montant, aucune fourchette, aucun ordre de grandeur',
  'l’abonnement, sa périodicité et ce qu’il contient',
  'tout pourcentage, commission ou part de résultat',
  'les frais de mise en place éventuels',
  'la durée d’engagement, le préavis et les conditions de sortie',
  'les conditions contractuelles, quelles qu’elles soient',
  'toute politique de remboursement',
  'un budget publicitaire minimum, recommandé ou journalier',
  'toute garantie chiffrée de résultat',
]);

/**
 * Ce que Hermes peut dire de l'essai, et qui est vrai.
 *
 * Des FAITS destinés au prompt, pas des phrases à réciter (§7 : « ne pas
 * obliger Hermes à réciter tout cela dans chaque conversation », et
 * sales-source-001-p007 : le cadre, jamais le script). Aucune entrée n'est une
 * formulation prête à l'emploi.
 */
export const TRIAL_FACTS: readonly string[] = Object.freeze([...loadOfferProfile().trialFacts]);

// ---------------------------------------------------------------------------
// Lire un texte qui parle de l'essai
// ---------------------------------------------------------------------------

/** La frontière de mot en Unicode. Même raison que `commercialPolicy.ts`. */
const WORD_START = '(?<![\\p{L}\\p{N}_])';

/**
 * L'ancre qui dit « ce texte parle de l'essai ».
 *
 * Volontairement large. Un faux positif coûte une vérification de plus sur un
 * message qui ne parlait pas de l'essai — donc, au pire, une escalade. Un faux
 * négatif laisse partir une description tronquée de l'offre, c'est-à-dire
 * exactement ce que ce module existe pour empêcher.
 *
 * `essais?` est borné à droite pour ne pas attraper « essaie » ni « essayer »,
 * qui sont des verbes et ne parlent de rien.
 */
const TRIAL_ANCHOR = new RegExp(
  `${WORD_START}(?:(?:7|sept)\\s*jours?|essais?(?![\\p{L}])|` +
    `p[ée]riode\\s+de\\s+(?:test|d[ée]couverte)|phase\\s+de\\s+test|` +
    `(?:une\\s+)?semaine\\s+(?:de\\s+)?(?:test|d[ée]ssai|essai))`,
  'iu',
);

/**
 * La seconde ancre : une remise de frais annoncée.
 *
 * Elle existe parce que la première ne suffisait pas, et le trou a été mesuré
 * plutôt que supposé : « on peut tester pendant une semaine sans qu'on te
 * facture » ne contient ni « essai », ni « sept jours » — et décrit pourtant
 * l'offre, en omettant précisément ce qui coûte de l'argent au prospect.
 *
 * Ce qui déclenche n'est donc pas le vocabulaire de l'essai mais la PROMESSE
 * qui le caractérise : nous ne facturons pas. Dès qu'un texte annonce cela, il
 * doit dire l'essai en entier — sinon il décrit une offre plus généreuse que la
 * vraie.
 */
const FEE_WAIVER = new RegExp(
  `${WORD_START}(?:ne\\s+(?:te\\s+|vous\\s+|se\\s+)?factur\\w*\\s+(?:pas|rien)|` +
    `pas\\s+de\\s+frais|aucun\\s+frais|z[ée]ro\\s+frais|` +
    `sans[^.!?]{0,20}factur\\w*|` +
    `frais\\s+de\\s+service[^.!?]{0,40}(?:pas|aucun|z[ée]ro|offerts?))`,
  'iu',
);

/** La durée est-elle réellement énoncée ? */
const DURATION_STATED = new RegExp(`${WORD_START}(?:7|sept)\\s*jours?`, 'iu');

/**
 * Le budget publicitaire est-il nommé ?
 *
 * On exige qu'un mot de dépense et un mot de publicité se tiennent dans la même
 * proposition, dans un sens ou dans l'autre. Ce qui n'est PAS exigé : que la
 * phrase attribue explicitement la charge au prospect. Le motif serait alors si
 * étroit qu'une formulation naturelle sur deux passerait au travers, et
 * l'omission ne serait plus détectée là où elle compte.
 *
 * Le prompt, lui, demande l'attribution complète ; ce contrôle attrape le cas
 * grave — le budget publicitaire jamais mentionné du tout.
 */
const AD_SPEND_STATED =
  /(?:budget|d[ée]penses?|investissement|co[ûu]ts?)[^.!?]{0,40}(?:publicitaires?|pub\b|m[ée]dias?\b|ads?\b|annonces?)|(?:publicitaires?|pub\b|annonces?)[^.!?]{0,40}(?:budget|charge|d[ée]penses?|financ)/iu;

export type TrialStatementCode =
  /**
   * L'essai est décrit sans que le budget publicitaire soit mentionné.
   *
   * LE défaut que ce module existe pour attraper, et le seul qu'aucune autre
   * garde du dépôt ne voit : le texte peut être parfaitement sourcé, poli,
   * naturel, sans promesse interdite — et faux par omission.
   */
  | 'TRIAL_AD_SPEND_OMITTED'
  /** L'essai est décrit sans sa durée : « on peut tester » n'est pas l'offre. */
  | 'TRIAL_DURATION_OMITTED'
  /**
   * L'essai est présenté comme gratuit ou sans risque.
   *
   * Ce code ne porte AUCUN lexique nouveau : il délègue à
   * `detectPerformanceClaims`, qui bloque déjà « gratuit », « sans frais »,
   * « aucun risque » et « vous ne payez rien ». Il existe pour NOMMER le
   * défaut — un rapport qui dit « l'essai a été présenté comme gratuit »
   * apprend plus qu'un rapport qui dit « promesse interdite détectée » — et
   * pour rendre visible que ces mots-là sont justement faux à propos de cet
   * essai-ci, et non seulement interdits en général.
   */
  | 'TRIAL_FRAMED_AS_FREE';

export interface TrialStatementFinding {
  readonly code: TrialStatementCode;
  readonly message: string;
  /** Les libellés rendus par `detectPerformanceClaims`, quand c'est lui. */
  readonly claims: readonly string[];
}

/** Ce texte parle-t-il de l'essai ? */
export function mentionsTrial(text: string): boolean {
  const body = normalizeForMatching(text);
  return TRIAL_ANCHOR.test(body) || FEE_WAIVER.test(body);
}

/**
 * Relit un texte QUE NOUS ÉCRIRIONS et vérifie que l'essai y est dit en entier.
 *
 * Ne rend rien quand le texte ne parle pas de l'essai : ce contrôle n'a pas
 * d'avis sur les messages qui parlent d'autre chose, et lui en donner un ferait
 * de lui un second contrôle de style.
 *
 * Les constatations sont TOUTES bloquantes du point de vue de l'autonomie. Il
 * n'y a pas de version tolérable d'une offre décrite à moitié : soit le
 * prospect sait ce qu'il paie, soit il ne le sait pas.
 */
export function checkTrialStatement(text: string): readonly TrialStatementFinding[] {
  const body = normalizeForMatching(text);
  if (!TRIAL_ANCHOR.test(body) && !FEE_WAIVER.test(body)) return Object.freeze([]);

  const findings: TrialStatementFinding[] = [];

  if (!AD_SPEND_STATED.test(body)) {
    findings.push(
      Object.freeze({
        code: 'TRIAL_AD_SPEND_OMITTED' as const,
        message:
          'le test est évoqué sans que le budget publicitaire soit mentionné — un prospect qui lit ' +
          'cela comprend qu’il ne paiera rien, ce qui est faux',
        claims: Object.freeze([]),
      }),
    );
  }

  if (!DURATION_STATED.test(body)) {
    findings.push(
      Object.freeze({
        code: 'TRIAL_DURATION_OMITTED' as const,
        message: 'le test est évoqué sans sa durée — « on peut tester » n’est pas l’offre',
        claims: Object.freeze([]),
      }),
    );
  }

  const claims = detectPerformanceClaims(text);
  if (claims.length > 0) {
    findings.push(
      Object.freeze({
        code: 'TRIAL_FRAMED_AS_FREE' as const,
        message:
          `le test est présenté avec une formulation qui n’est pas la nôtre (${claims.join(', ')}) — ` +
          'Hermes ne facture pas ses frais de service, ce qui n’est ni « gratuit », ni « sans risque »',
        claims,
      }),
    );
  }

  return Object.freeze(findings);
}

// ---------------------------------------------------------------------------
// §27 — QUAND l'essai peut être introduit
// ---------------------------------------------------------------------------

/**
 * L'essai peut-il être mis sur la table à ce tour ?
 *
 *   * `ALLOWED` — la conversation l'appelle réellement ;
 *   * `NOT_YET` — rien ne le demande encore ; l'annoncer serait le balancer ;
 *   * `FORBIDDEN` — la conversation est close ou revient à un humain.
 *
 * Une valeur intermédiaire existe parce que le cas fréquent n'est ni oui ni
 * non : c'est « pas maintenant ». Un booléen aurait forcé à trancher, et il
 * aurait tranché du côté du oui — c'est toujours ce qui arrive.
 */
export type TrialDisclosure = 'ALLOWED' | 'NOT_YET' | 'FORBIDDEN';

export interface TrialDisclosureInput {
  /** Le palier commercial du tour, tel qu'`assessOfferProgression` le lit. */
  readonly offerStage:
    | 'UNDERSTAND_SITUATION'
    | 'EXPLORE_NEED'
    | 'EXPLAIN_OFFER'
    | 'EXPLAIN_MODEL'
    | 'PROPOSE_CALL'
    | 'HOLD';
  /** La personne a-t-elle demandé comment cela fonctionne, ou ce que nous faisons ? */
  readonly asksHowItWorks: boolean;
  /** La personne a-t-elle nommé l'essai elle-même ? */
  readonly asksAboutTrial: boolean;
  readonly humanNeeded: boolean;
}

/**
 * Décide si l'essai peut être introduit.
 *
 * L'ordre est la politique. Ce qui referme passe devant ; une question de la
 * personne l'emporte ensuite sur toute considération de palier — quelqu'un qui
 * demande comment cela marche a le droit d'obtenir une réponse ; et le silence
 * est le défaut.
 *
 * §27 en un exemple : un message qui dit seulement « Salut » laisse le palier à
 * `UNDERSTAND_SITUATION` et n'ouvre aucune question, donc `NOT_YET`. L'essai ne
 * se balance pas.
 */
export function trialDisclosure(input: TrialDisclosureInput): TrialDisclosure {
  if (input.humanNeeded || input.offerStage === 'HOLD') return 'FORBIDDEN';
  if (input.asksAboutTrial) return 'ALLOWED';
  if (input.asksHowItWorks) return 'ALLOWED';
  if (input.offerStage === 'EXPLAIN_OFFER' || input.offerStage === 'EXPLAIN_MODEL') return 'ALLOWED';
  if (input.offerStage === 'PROPOSE_CALL') return 'ALLOWED';
  return 'NOT_YET';
}

// ---------------------------------------------------------------------------
// Ce que le prompt en lit
// ---------------------------------------------------------------------------

/**
 * L'offre, rendue pour un prompt.
 *
 * Le bloc dit trois choses dans cet ordre : ce qui est vrai, comment le dire
 * sans mentir, et ce qui reste inconnu. L'ordre compte — un modèle qui lit
 * d'abord la liste des manques retient surtout qu'il ne sait rien.
 *
 * Il n'est rendu que lorsque l'essai peut être introduit (`ALLOWED`). Un tour
 * qui n'a rien à voir avec l'offre ne voit pas ce bloc du tout, ce qui évite
 * d'apprendre au modèle une réponse dont il n'a pas besoin — et de lui donner
 * l'idée de s'en servir.
 */
export function renderOfferBlock(quotableAmounts: readonly number[] = []): string {
  const lines: string[] = [
    `L’OFFRE HERMES (${HERMES_OFFER_VERSION}) — CE QUI EST VRAI`,
    '',
  ];
  for (const fact of TRIAL_FACTS) lines.push(`- ${fact}`);
  lines.push(
    '',
    'SI TU PARLES DU TEST, DIS-LE EN ENTIER :',
    '- la durée (sept jours) ET le fait que le budget publicitaire reste à la charge du prospect.',
    '  Annoncer le test sans le budget publicitaire est un mensonge par omission, même involontaire.',
    '- n’écris JAMAIS « gratuit », « sans frais », « sans risque », « sans engagement » ni « tu ne',
    '  paies rien » : le prospect paie ses annonces dès le premier jour, ces mots sont faux ici.',
  );
  // §5 — la ligne des montants, et la seule du bloc qui soit conditionnelle.
  //
  // Le cas fermé est rendu à l'identique de r2, volontairement : un tour qui
  // n'a droit à aucun montant doit voir le prompt qu'il voyait hier.
  if (quotableAmounts.length === 0) {
    lines.push('- n’écris aucun montant, pas même zéro.');
  } else {
    lines.push(
      '- les SEULS montants que tu peux écrire sont ceux du bloc budget publicitaire ci-dessus, et',
      '  l’absence de frais de service pendant le test. Tout autre montant est faux — en particulier',
      '  ce que coûte la suite, qui n’est écrit nulle part.',
      '- préfère les mots au chiffre quand tu parles de nos frais : « je ne facture pas mes frais de',
      '  service sur cette période » se lit mieux qu’un zéro, et ne peut pas se confondre avec',
      '  « gratuit ». Le budget publicitaire, lui, se chiffre — c’est ce qu’on te demande.',
    );
  }
  lines.push(
    '- n’en parle que si la conversation l’appelle. Ce n’est pas une accroche.',
    '',
    'CE QUI N’EST PAS DÉFINI — ET QUI NE S’INVENTE PAS :',
  );
  for (const term of UNDEFINED_COMMERCIAL_TERMS) lines.push(`- ${term}`);
  lines.push(
    '',
    'Sur l’un de ces points, ne réponds pas à côté et n’avance aucun chiffre : dis honnêtement que',
    'cela se décide au cas par cas et que tu préfères en parler de vive voix. C’est une issue normale.',
  );
  return lines.join('\n');
}
