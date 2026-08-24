/**
 * Ce que les conditions de Brave Search API nous autorisent à garder — en code,
 * pas en commentaire.
 *
 * La clause qui gouverne tout ce répertoire, mot pour mot :
 *
 *   « store, cache, or create a database of Search Results, in whole or in
 *     part, other than transient storage required for operation of Customer
 *     Applications or related software, service or systems »
 *
 * Autrement dit : un résultat de recherche traverse le processus, il ne s'y
 * dépose pas. Aucun titre, aucune description, aucun classement ne devient une
 * ligne de notre base. C'est la même asymétrie que pour Places en R2.1, et elle
 * mène à la même architecture : **le moteur est un pointeur, pas un magasin.**
 *
 * Ce que cela autorise, et qui suffit :
 *
 *   Brave dit « regarde par là »  →  nous allons voir nous-mêmes  →  ce que
 *   NOUS avons lu sur le site est notre observation, avec le site pour source.
 *
 * Un domaine confirmé est donc écrit parce que nous avons ouvert la page, lu le
 * nom, comparé les mentions légales — pas parce qu'un moteur l'a listé. La
 * différence n'est pas rhétorique : elle change la provenance inscrite dans
 * `prospect_evidence`, qui reste `open_web` avec l'URL du site, jamais Brave.
 *
 * Trois conséquences directes, toutes exécutables :
 *
 *   1. `noCache: true` sur chaque appel. Le cache HTTP persistant de ce projet
 *      écrirait la réponse JSON entière dans `http_cache` — soit exactement la
 *      base de résultats que la clause interdit. Le drapeau existe depuis
 *      Places pour cette raison, et il coupe la lecture ET l'écriture.
 *   2. `assertNoSearchResultContent` garde le chemin d'écriture. Elle refuse en
 *      levant, au lieu de nettoyer en silence : un prestation standard silencieux rendrait
 *      une régression invisible.
 *   3. Ce que nous mémorisons pour ne pas repayer deux fois la même question,
 *      c'est **notre question et notre conclusion** (`discovery_search_queries`),
 *      pas la réponse du moteur. Une requête déjà posée est un fait sur nous.
 *
 * Deux autres clauses, notées ici parce qu'elles bornent des usages futurs :
 *
 *   — entraînement : « use the Search Results to create, evaluate, train,
 *     re-train, fine-tune, benchmark or otherwise improve artificial
 *     intelligence models ». Aucun résultat n'entre dans un prompt de ce
 *     projet ; `tests/searchNeutrality.test.ts` en fait une propriété testée.
 *   — attribution : « POWERED BY BRAVE » est exigé dans la description d'une
 *     *Customer Application*. Rien ici n'est publié à des tiers ; la mention
 *     est portée par `BRAVE_ATTRIBUTION` et par la documentation, et devra
 *     devenir visible le jour où une interface expose ces résultats.
 *
 * Source : https://api-dashboard.search.brave.com/documentation/resources/terms-of-service
 */

/**
 * Les résultats de recherche peuvent-ils être stockés ?
 *
 * Non, et ce n'est pas un réglage. La constante existe pour que le refus soit
 * lisible à l'endroit où quelqu'un chercherait un moyen de le contourner. Un
 * plan « storage rights » existe chez Brave ; il n'est pas celui-ci.
 */
export const SEARCH_RESULTS_MAY_BE_STORED = false;

/** Mention exigée dès qu'une interface expose ces résultats à un tiers. */
export const BRAVE_ATTRIBUTION = 'POWERED BY BRAVE';

/**
 * Champs qui appartiennent au moteur et ne doivent jamais atteindre une table.
 *
 * Le titre et la description SONT le résultat de recherche. L'URL occupe une
 * place à part : nous ne l'écrivons qu'après avoir nous-mêmes joint le domaine
 * et vérifié à qui il appartient — à ce moment-là ce que nous enregistrons est
 * le fruit de notre lecture, et la clause ne s'y applique plus.
 */
const NON_STORABLE_SEARCH_FIELDS = [
  'title',
  'snippet',
  'description',
  'extra_snippets',
  'search_title',
  'search_snippet',
  'result_rank_title',
] as const;

/**
 * Dernière ligne de défense sur le chemin d'écriture.
 *
 * Appelée par le rail sur chaque sac de colonnes et chaque evidence avant
 * insertion. Elle lève : voir §2 du préambule.
 */
export function assertNoSearchResultContent(columns: Record<string, unknown>, context: string): void {
  for (const field of NON_STORABLE_SEARCH_FIELDS) {
    const value = columns[field];
    if (value !== null && value !== undefined && value !== '') {
      throw new Error(
        `${context}: refus d’écrire « ${field} », qui provient des résultats du moteur. ` +
          'Les conditions Brave interdisent de stocker un résultat de recherche.',
      );
    }
  }
}

/**
 * Vrai quand une valeur textuelle a l'air d'être un extrait de moteur plutôt
 * qu'une observation à nous.
 *
 * Heuristique volontairement grossière et utilisée seulement en test : elle
 * attrape la faute de frappe architecturale (« je colle le snippet dans
 * value_text »), pas un adversaire.
 */
export function looksLikeSearchSnippet(value: string): boolean {
  return value.includes(' … ') || value.includes('...') || value.length > 300;
}
