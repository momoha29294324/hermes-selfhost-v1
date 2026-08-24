/**
 * HERMES-SEMANTIC-GROUNDING-R1 — ce que le prospect nous demande MAINTENANT.
 *
 * Module feuille, sans dépendance : il est lu par le tour unifié
 * (`conversation/turn.ts`), par la forme d'une analyse persistée
 * (`replies/classifier.ts`) et par la politique commerciale
 * (`conversation/commercialPolicy.ts`). Le poser ailleurs ferait un cycle
 * d'imports entre trois fichiers qui n'ont rien à se dire.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce vocabulaire fait, et ce qu'il ne fait PAS
 * ---------------------------------------------------------------------------
 * Il répond à une question distincte de la catégorie : « qu'est-ce que cette
 * personne nous demande, en son nom propre, maintenant ? ». `NONE` est une
 * réponse à part entière, et c'est la plus fréquente d'une prospection qui
 * fonctionne — quelqu'un qui répond à une question n'en pose aucune.
 *
 * Il ne DÉCIDE rien. Le cadre d'énonciation est lu par `utteranceScope.ts`,
 * qui est du code testé sur un corpus de plusieurs centaines de cas. Ce
 * vocabulaire-ci porte la lecture du MODÈLE, et le seul pouvoir qu'on lui a
 * donné est d'AJOUTER une escalade que le lexique aurait manquée. Il ne peut
 * jamais en retirer une.
 *
 * C'est la direction sûre, et c'est la seule ouverte : un modèle qui se
 * tromperait en disant « elle demande un prix » coûte une escalade — le
 * comportement d'avant ce round. Un modèle qui se tromperait dans l'autre sens
 * ne coûte rien, parce qu'on ne l'écoute pas dans ce sens-là.
 */

export const CURRENT_REQUEST_TOPICS = [
  /** Elle ne nous demande rien. Le cas le plus fréquent. */
  'NONE',
  /** Ce que Hermes facture APRÈS l'essai. Jamais écrit nulle part. */
  'POST_TRIAL_PRICE',
  /** Ce que coûte le test de sept jours. Écrit. */
  'TRIAL_COST',
  /** Le budget publicitaire du prospect. Écrit. */
  'AD_BUDGET',
  /** Une part : pourcentage, commission, frais. Jamais écrit. */
  'PERCENTAGE_OR_FEE',
  /** Une garantie de résultat. Jamais écrite, et jamais offerte. */
  'GUARANTEE',
  /** Une politique de remboursement. Jamais écrite. */
  'REFUND',
  /** Un engagement, une durée de contrat, un préavis. Jamais écrit. */
  'COMMITMENT',
  /** Un nombre de leads, de clients, un ROI promis. Jamais écrit. */
  'EXPECTED_RESULTS',
  /** En combien de temps ça marche. Un délai qu'on ne peut pas annoncer. */
  'RESULT_TIMING',
  /** Ce qu'on fait, concrètement. Écrit. */
  'SERVICE_EXPLANATION',
  /** Pourquoi on écrit. Écrit. */
  'CONTACT_PURPOSE',
  /** L'exclusivité de zone. Une vérité partielle existe. */
  'EXCLUSIVITY',
  /** Un rendez-vous, un créneau. */
  'BOOKING',
  /** Une demande lisible mais hors de cette liste. */
  'OTHER',
] as const;

export type CurrentRequestTopic = (typeof CURRENT_REQUEST_TOPICS)[number];

/**
 * Les demandes courantes qu'AUCUNE vérité de ce dépôt ne couvre.
 *
 * Ce sont celles, et seulement celles, sur lesquelles la lecture du modèle a le
 * droit d'ajouter une escalade. Un sujet couvert n'en ouvre aucune : la réponse
 * existe, elle est écrite et datée, et escalader dessus ferait attendre un
 * humain pour un fait déjà signé — c'est-à-dire le défaut que les six derniers
 * rounds ont passé leur temps à refermer.
 *
 * `RESULT_TIMING` n'y est PAS, et c'est délibéré : la vérité de service dit
 * déjà qu'aucun délai ne peut être annoncé, et cette réponse-là est écrite.
 * `EXCLUSIVITY` non plus : une vérité partielle existe (la zone commerciale qui
 * se chevauche), et le refus est déjà porté par les gardes de contenu.
 */
export const UNCOVERED_CURRENT_REQUESTS: ReadonlySet<CurrentRequestTopic> =
  new Set<CurrentRequestTopic>([
    'POST_TRIAL_PRICE',
    'PERCENTAGE_OR_FEE',
    'GUARANTEE',
    'REFUND',
    'COMMITMENT',
    'EXPECTED_RESULTS',
  ]);

export function isCurrentRequestTopic(value: unknown): value is CurrentRequestTopic {
  return typeof value === 'string' && (CURRENT_REQUEST_TOPICS as readonly string[]).includes(value);
}
