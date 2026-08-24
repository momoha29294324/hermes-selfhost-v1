import type { BindingKind, IdentityLink } from '@/lib/pipeline/businessContactGuard';

/**
 * HERMES-CLEANING-ONLY-ICP-R1 §13-§15 — « cette entreprise existe-t-elle déjà
 * dans la base, peu importe la campagne ? »
 *
 * ---------------------------------------------------------------------------
 * Le défaut DEMOJULIET, exactement
 * ---------------------------------------------------------------------------
 * Deux lignes portent la MÊME clé canonique — `registry_id:484122452`, même
 * domaine `demo-56-exemple.fr`, même compte `@demojuliet_france` — l'une dans
 * `example-campaign`, l'autre dans `example-campaign`. Les deux
 * affichent `dedupe_status = 'unique'`.
 *
 * Ce n'est pas une défaillance du moteur de déduplication : la seule contrainte
 * d'unicité est `(campaign_id, canonical_key)`, l'index d'identité est
 * `(campaign_id, kind, value)`, et `findByIdentityKeys` filtre sur
 * `campaign_id`. Deux campagnes ne peuvent pas se voir. On n'a jamais montré
 * les deux lignes au moteur.
 *
 * Ce cloisonnement est DÉFENDABLE pour la fusion — deux campagnes sont deux
 * corpus, deux provenances, deux dates, et fusionner effacerait de la
 * traçabilité que personne n'a demandé d'effacer, y compris sous des manifestes
 * verrouillés. Il devient faux dès qu'on lit `unique` comme une réponse à une
 * autre question : « combien d'entreprises distinctes ce lot contient-il ? ».
 *
 * ---------------------------------------------------------------------------
 * Ce que ce module ajoute, et ce qu'il refuse d'ajouter
 * ---------------------------------------------------------------------------
 * Il n'ajoute PAS un second moteur de déduplication, et ne touche pas à
 * `dedupe_status` : cette colonne dit ce qu'elle a toujours dit — « au sein de
 * SA campagne, cette ligne est-elle un doublon ? » — et la réponse `unique` y
 * reste juste. Une colonne dont on changerait le sens sous les lignes déjà
 * écrites mentirait sur tout l'historique.
 *
 * Il ajoute une couche AU-DESSUS : l'ENTITÉ MÉTIER, qui regroupe les lignes de
 * campagne sans les détruire —
 *
 *     ligne de découverte (campagne A)  →  entité métier  ←  ligne (campagne B)
 *
 * — et la notion de REPRÉSENTANT : parmi les lignes d'une même entité, une
 * seule peut porter une intention autonome. Les autres sont écartées en
 * `duplicate`, terminal, sans qu'aucune ligne ne soit supprimée ni fusionnée.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi le représentant est DÉRIVÉ et non stocké
 * ---------------------------------------------------------------------------
 * Un pointeur stocké se périme en silence : la ligne désignée peut perdre son
 * handle, changer de stade, être exclue — et la garde continuerait de refuser
 * les bonnes lignes au profit d'une mauvaise, sans qu'aucune écriture ne
 * signale la dérive. Le représentant est donc RECALCULÉ à chaque lecture, par
 * une règle totale et déterministe, exactement comme `deriveQueueState` refuse
 * de matérialiser `SCHEDULED`.
 *
 * L'entité, elle, est stockée (`business_entities`, migration 0052) : c'est une
 * MÉMOIRE — elle répond à « connaît-on déjà ce commerce ? » sans rejouer une
 * résolution transitive, et elle survit à la disparition d'une campagne.
 */

/**
 * L'ordre des clés dans la clé canonique d'une entité, du plus décisif au
 * moins.
 *
 * `registry_id` en tête parce qu'un SIREN est délivré par l'État à une personne
 * morale et à une seule ; le domaine ensuite, qui se loue mais ne se partage
 * pas ; puis l'identifiant de lieu, le compte social, l'adresse e-mail. Le
 * TÉLÉPHONE et le NOM n'y figurent pas, et pour les raisons déjà établies par
 * `businessContactGuard` : un standard se partage, et « ATELIER CAR » est un
 * nom de métier que plusieurs sociétés portent. §13 le dit mot pour mot — « ne
 * déduplique jamais deux entreprises uniquement sur un nom similaire ».
 */
const KEY_PRECEDENCE: readonly BindingKind[] = [
  'registry_id',
  'domain',
  'google_place_id',
  'instagram',
  'email',
];

/**
 * La clé canonique d'une entité : la meilleure clé décisive du groupe, préfixée
 * de son genre.
 *
 * Une seule clé, et pas leur concaténation : une entité dont on apprendrait
 * demain le compte Instagram changerait de clé si celle-ci les listait toutes,
 * et l'entité se dédoublerait au lieu de s'enrichir. Prendre la plus décisive
 * DISPONIBLE la rend stable tant que ce fait-là ne change pas — et un SIREN ne
 * change pas.
 */
export function canonicalBusinessKey(keys: readonly IdentityLink[]): string | null {
  for (const kind of KEY_PRECEDENCE) {
    const matching = keys
      .filter((key) => key.kind === kind && key.value.trim().length > 0)
      .map((key) => key.value.trim().toLowerCase())
      .sort();
    const best = matching[0];
    if (best !== undefined) return `${kind}:${best}`;
  }
  return null;
}

/**
 * Le stade pipeline, transformé en rang de PRÉPARATION.
 *
 * Le représentant doit être la ligne la mieux armée pour porter un message, pas
 * la plus ancienne : désigner une ligne `discovered` sans handle bloquerait la
 * ligne `message_ready` du même commerce, et la garde se retournerait contre le
 * but qu'elle sert. Les stades terminaux négatifs valent 0 — une ligne exclue
 * ne représente rien.
 */
const STAGE_RANK: Readonly<Record<string, number>> = Object.freeze({
  message_ready: 5,
  approved: 4,
  qualified: 3,
  discovered: 2,
  excluded: 0,
  rejected: 0,
});

export function stageRank(stage: string | null): number {
  return STAGE_RANK[stage ?? ''] ?? 1;
}

export interface BusinessMemberLike {
  readonly prospectId: string;
  readonly stage: string | null;
  /** `first_seen_at`, ISO. Départage deux lignes également avancées. */
  readonly firstSeenAt: string | null;
}

/**
 * Le représentant d'une entité, par une règle TOTALE et déterministe.
 *
 * Trois critères, dans cet ordre, et le troisième garantit qu'il n'y a jamais
 * d'égalité : le stade le plus avancé, puis la découverte la plus ancienne
 * (l'antériorité, à préparation égale), puis l'identifiant le plus petit. Le
 * dernier n'a aucun sens métier — il n'est là que pour rendre la fonction
 * totale, parce qu'une règle qui laisserait deux gagnants laisserait deux
 * intentions.
 */
export function electRepresentative(members: readonly BusinessMemberLike[]): string | null {
  let best: BusinessMemberLike | null = null;
  let bestRank = -1;
  for (const member of members) {
    const rank = stageRank(member.stage);
    if (best === null || rank > bestRank) {
      best = member;
      bestRank = rank;
      continue;
    }
    if (rank < bestRank) continue;
    const a = member.firstSeenAt ?? '';
    const b = best.firstSeenAt ?? '';
    if (a !== b) {
      if (a < b) best = member;
      continue;
    }
    if (member.prospectId < best.prospectId) best = member;
  }
  return best?.prospectId ?? null;
}
