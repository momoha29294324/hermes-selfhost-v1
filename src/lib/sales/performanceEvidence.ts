/**
 * HERMES-ACQUISITION-SERVICE-TRUTH-R1 §7 — les performances OBSERVÉES, et
 * pourquoi elles ne sortent pas d'ici.
 *
 * ---------------------------------------------------------------------------
 * Ce que l'opérateur a transmis
 * ---------------------------------------------------------------------------
 * Sur le client actuellement utilisé comme référence opérationnelle, les
 * performances observées sont d'environ 5 à 6 € de coût par demande, et un
 * retour sur investissement d'environ 4,5 à 5. Ce sont des RÉSULTATS
 * CONSTATÉS SUR UN CAS EXISTANT, pas des promesses — l'opérateur l'écrit
 * lui-même, et la distinction est le sujet entier de ce fichier.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi ces chiffres n'entrent dans AUCUN message
 * ---------------------------------------------------------------------------
 * Parce que la règle de preuve de ce dépôt ne les couvre pas, et que la mission
 * demande explicitement de ne pas la contourner.
 *
 * CLAUDE.md, interdit n°3 : une seule preuve chiffrée est autorisée, mot pour
 * mot, et « une nouvelle preuve passe d'abord par la table `case_studies` avec
 * ses métriques sourcées ». Aucune ligne `case_studies` ne porte ces valeurs.
 *
 * Et même si elle en portait : `checkReplyDraft` (R6B-D2) passe
 * `allowedCaseStudyClaim: null` en RÉPONSE. Aucune preuve chiffrée n'est
 * citable dans une réponse, y compris la seule preuve approuvée du dépôt, qui
 * appartient au premier contact. Ce round ne desserre pas cette garde d'un
 * pouce.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi les écrire ici, alors
 * ---------------------------------------------------------------------------
 * Parce que la mission le demande dans ces termes : « conserve-les comme faits
 * opérateur nécessitant la provenance appropriée avant utilisation autonome ».
 * Un fait qu'on ne consigne nulle part est un fait qu'on redécouvre par
 * hasard, et qu'on finit par citer de mémoire.
 *
 * Ils sont donc consignés, datés, attribués — et STRUCTURELLEMENT hors de
 * portée du modèle : aucune fonction de ce fichier ne rend un chiffre dans un
 * texte destiné à un prompt, `renderPerformanceEvidenceGap` ne contient aucun
 * chiffre du tout, et un test le vérifie caractère par caractère plutôt que sur
 * parole.
 *
 * ---------------------------------------------------------------------------
 * Ce qu'il faudrait pour que cela change
 * ---------------------------------------------------------------------------
 * Trois choses ensemble, et aucune n'est faite ici : une ligne `case_studies`
 * portant ces métriques avec leur source, une décision explicite d'autoriser
 * une preuve chiffrée EN RÉPONSE (ce qui est aujourd'hui refusé par type), et
 * la revue qui va avec. `performanceEvidenceDisclosure` rend un littéral, donc
 * ce jour-là il faudra changer une signature — pas basculer une condition.
 */

import type { TruthTier } from '@/lib/sales/truth';

/** L'identifiant de ce qui suit, distinct de la vérité de service. */
export const PERFORMANCE_EVIDENCE_VERSION = 'hermes-performance-evidence-r1';

/**
 * Le rang d'autorité.
 *
 * `EXPLICIT_BUSINESS_POLICY` : c'est l'opérateur qui l'atteste. Ce rang dit qui
 * l'affirme, PAS que la chose soit citable — les deux questions sont
 * distinctes, et `truth.ts` le pose déjà pour les principes empruntés
 * (« soutenu par un expert ≠ prouvé pour Hermes »).
 */
export const PERFORMANCE_EVIDENCE_TIER: TruthTier = 'EXPLICIT_BUSINESS_POLICY';

/**
 * L'usage autonome d'une observation de performance.
 *
 * Une union à une seule valeur aujourd'hui, comme `CommercialPolicyStatus`. Ce
 * n'est pas une maladresse : elle documente un état constaté et rend impossible
 * d'écrire une branche « si c'est citable » qui compilerait sans que ce soit
 * citable.
 */
export type PerformanceEvidenceUse = 'WITHHELD_PENDING_PROVENANCE';

export interface ObservedPerformance {
  readonly metric: 'COST_PER_LEAD_EUR' | 'RETURN_ON_INVESTMENT';
  /** La valeur basse et la valeur haute observées. */
  readonly range: readonly [number, number];
  /** Qui l'atteste, nommément. */
  readonly attestedBy: string;
  /** Quand. Une date absolue, jamais « récemment ». */
  readonly attestedOn: string;
  /** Sur quoi. Un cas, pas une moyenne de marché. */
  readonly scope: string;
  /** Ce qui manque pour que cela puisse être dit. */
  readonly provenanceGap: string;
  readonly use: PerformanceEvidenceUse;
}

/**
 * Les performances OBSERVÉES par l'opérateur — vide dans cette édition.
 *
 * Un chiffre de performance appartient à celui qui l'a mesuré, sur ses propres
 * campagnes, chez ses propres clients. Il ne se transporte pas : le publier
 * ici le ferait dire par Hermes à des prospects auxquels il ne s'applique pas,
 * ce qui est exactement l'affirmation non fondée que le dépôt interdit.
 *
 * La liste reste TYPÉE et le mécanisme reste en place : un opérateur qui a ses
 * propres mesures peut les inscrire — et découvrira que même inscrites, elles
 * ne sortent pas. `performanceEvidenceDisclosure()` rend
 * `WITHHELD_PENDING_PROVENANCE` en littéral de type, et `checkReplyDraft` passe
 * de toute façon `allowedCaseStudyClaim: null` en réponse. Citer un chiffre
 * demande une ligne `case_studies` avec sa source, revue par un humain.
 */
export const OBSERVED_PERFORMANCE: readonly ObservedPerformance[] = Object.freeze([]);

/**
 * Une observation de performance peut-elle être citée par Hermes, seul ?
 *
 * Rend toujours `WITHHELD_PENDING_PROVENANCE`, et le type de retour le dit pour
 * que personne n'ait à relire le corps. Aucun paramètre : il n'existe pas de
 * cas où la réponse diffère, et en accepter un laisserait croire le contraire.
 */
export function performanceEvidenceDisclosure(): 'WITHHELD_PENDING_PROVENANCE' {
  return 'WITHHELD_PENDING_PROVENANCE';
}

/**
 * Ce que le prompt reçoit à la place des chiffres.
 *
 * AUCUN chiffre, et c'est vérifié par un test : ce texte ne contient pas un
 * seul caractère numérique. Montrer une valeur à un modèle en lui interdisant
 * de s'en servir est le plus sûr moyen de la voir apparaître — l'interdiction
 * suffit, et elle est plus courte.
 *
 * Ce bloc n'est PAS rendu par le cerveau conversationnel : quand un prospect
 * demande un coût par demande ou un retour sur investissement,
 * `commercialPolicy.ts` escalade AVANT qu'un brouillon soit écrit. Il existe
 * pour les rapports, et pour le jour où un chemin voudrait l'afficher.
 */
export function renderPerformanceEvidenceGap(): string {
  return [
    `PERFORMANCES OBSERVÉES (${PERFORMANCE_EVIDENCE_VERSION}) — NON CITABLES`,
    '',
    'Des résultats existent sur un cas réel. Ils ne sont pas citables ici, et ce n’est pas une',
    'précaution de style : la seule preuve chiffrée approuvée de ce dépôt appartient au premier',
    'contact, et aucune preuve chiffrée n’est autorisée dans une réponse.',
    '',
    '- n’écris aucun coût par demande, aucun retour sur investissement, aucun multiple ;',
    '- n’écris aucune fourchette, même vague, même précédée de « environ » ou « autour de » ;',
    '- ne transforme JAMAIS une observation en promesse : ce qui a été constaté chez quelqu’un',
    '  d’autre n’est promis à personne ;',
    '- si on te demande ces chiffres, dis honnêtement que tu préfères en parler de vive voix plutôt',
    '  que d’avancer un nombre par message.',
  ].join('\n');
}
