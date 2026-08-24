/**
 * HERMES-SALES-KNOWLEDGE-R1 §16, §17 — la HIÉRARCHIE DE VÉRITÉ, écrite une fois
 * et opposable.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi ce fichier ne contient presque rien
 * ---------------------------------------------------------------------------
 * Parce que son travail n'est pas d'arbitrer des cas : c'est de rendre
 * IMPOSSIBLE un arbitrage qui irait dans le mauvais sens. Le dépôt vient
 * d'acquérir sa première source extérieure. La question « et si la vidéo
 * disait le contraire de ce qu'on fait ? » ne doit pas se poser au cas par cas
 * dans six mois, au milieu d'un round pressé — elle se tranche ici, à froid,
 * pendant que personne n'a d'enjeu.
 *
 * Le rang n'est pas décoratif : il est comparé par du code
 * (`sourceOutranks`), et le seul membre de `PrincipleConflict.resolution` est
 * `POLICY_WINS`. Un conflit ne peut donc pas se résoudre en faveur d'une
 * source, quel que soit son rang, parce qu'aucune valeur ne permet de l'écrire.
 *
 * ---------------------------------------------------------------------------
 * §17 — soutenu par un expert ≠ prouvé pour Hermes
 * ---------------------------------------------------------------------------
 * Les deux niveaux d'appui sont nommés séparément et ne se convertissent pas
 * l'un dans l'autre. Un principe peut être `SUPPORTED_BY_EXPERT` pendant des
 * années sans jamais devenir `PROVEN_FOR_HERMES` — et c'est un état normal,
 * pas une dette. Ce qui ferait passer de l'un à l'autre est une mesure sur des
 * résultats Hermes réels, que la boucle d'apprentissage produira ou ne
 * produira pas ; aucune quantité de lecture ne le fera.
 *
 * Mélanger les deux dans une seule métrique de causalité est l'erreur que §17
 * demande d'éviter, et elle est facile à commettre : il suffirait d'un champ
 * `score` unique alimenté par les deux.
 */

/**
 * Les rangs d'autorité, du plus fort au plus faible.
 *
 * L'ordre du tableau EST la hiérarchie ; `sourceOutranks` ne fait que le lire.
 * Un rang qui se réglerait ailleurs qu'ici finirait par décrire autre chose que
 * ce qui a réellement tranché.
 */
export const TRUTH_TIERS = Object.freeze([
  /** Ce que un opérateur a décidé, explicitement, pour cette entreprise. */
  'EXPLICIT_BUSINESS_POLICY',
  /** Les invariants déterministes de sécurité et de politique — le code des gardes. */
  'DETERMINISTIC_INVARIANT',
  /** Des résultats Hermes réels, sur un effectif suffisant. */
  'HERMES_OUTCOME_DATA',
  /** Un playbook Hermes validé. */
  'VALIDATED_HERMES_PLAYBOOK',
  /** Un principe tiré d'une source experte extérieure. */
  'EXPERT_SOURCE_PRINCIPLE',
  /** Une heuristique générique, sans source nommée. */
  'GENERIC_HEURISTIC',
] as const);

export type TruthTier = (typeof TRUTH_TIERS)[number];

/**
 * Le rang numérique d'un niveau. Plus petit = plus fort.
 *
 * Exposé parce qu'un rapport doit pouvoir trier ; jamais utilisé pour composer
 * un score. Une hiérarchie est un ORDRE, pas une pondération : additionner
 * « deux sources expertes » n'a jamais fait une politique.
 */
export function truthRank(tier: TruthTier): number {
  return TRUTH_TIERS.indexOf(tier);
}

/** `a` l'emporte-t-il sur `b` ? Strictement : l'égalité n'est pas une victoire. */
export function sourceOutranks(a: TruthTier, b: TruthTier): boolean {
  return truthRank(a) < truthRank(b);
}

/**
 * Le niveau d'appui d'un principe, qui n'est PAS son rang d'autorité.
 *
 *   * `SUPPORTED_BY_EXPERT` — quelqu'un d'expérimenté l'affirme ;
 *   * `PROVEN_FOR_HERMES` — des résultats Hermes l'établissent ;
 *   * `UNSUPPORTED` — ni l'un, ni l'autre.
 *
 * Aucune fonction de ce dépôt ne fait passer de la première valeur à la
 * seconde. C'est délibéré : le jour où cette promotion existera, elle devra
 * lire des mesures réelles, et elle sera écrite par le round qui les produit.
 */
export type PrincipleSupport = 'SUPPORTED_BY_EXPERT' | 'PROVEN_FOR_HERMES' | 'UNSUPPORTED';

/**
 * Le niveau d'appui d'un principe de cette bibliothèque.
 *
 * Rend toujours `SUPPORTED_BY_EXPERT` — la bibliothèque ne contient
 * aujourd'hui que des sources expertes, et aucune mesure Hermes n'y entre. Le
 * type de retour le dit, de sorte qu'un futur round qui voudrait promouvoir un
 * principe devra changer cette signature, donc passer par une revue, plutôt que
 * basculer une condition.
 */
export function principleSupport(): 'SUPPORTED_BY_EXPERT' {
  return 'SUPPORTED_BY_EXPERT';
}

/**
 * Le rang d'un principe de source experte.
 *
 * Constante, et volontairement : c'est le cinquième rang sur six. Une source
 * extérieure passe APRÈS les données Hermes, et très loin après les
 * invariants. Il n'existe aucun chemin pour la faire monter.
 */
export const EXPERT_PRINCIPLE_TIER: TruthTier = 'EXPERT_SOURCE_PRINCIPLE';

/**
 * La hiérarchie, rendue pour un rapport ou une documentation.
 *
 * Une seule source : si `TRUTH_TIERS` change, ce texte change avec lui.
 */
export function renderTruthHierarchy(): string {
  const labels: Readonly<Record<TruthTier, string>> = Object.freeze({
    EXPLICIT_BUSINESS_POLICY: 'politique explicite de un opérateur / de l’entreprise',
    DETERMINISTIC_INVARIANT: 'invariant déterministe de sécurité ou de politique (le code des gardes)',
    HERMES_OUTCOME_DATA: 'résultats Hermes réels, sur un effectif suffisant',
    VALIDATED_HERMES_PLAYBOOK: 'playbook Hermes validé',
    EXPERT_SOURCE_PRINCIPLE: 'principe tiré d’une source experte extérieure',
    GENERIC_HEURISTIC: 'heuristique générique, sans source nommée',
  });
  return TRUTH_TIERS.map((tier, index) => `${String(index + 1)}. ${labels[tier]}`).join('\n');
}
