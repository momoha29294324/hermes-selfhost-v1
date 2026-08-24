/**
 * La pagination des listes du CRM.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi une liste de 424 lignes coûtait 1,8 seconde
 * ---------------------------------------------------------------------------
 *
 * La requête n'y était pour rien : elle rend ses lignes en 13 ms, mesurées à
 * l'`explain analyze`. Ce qui coûtait, c'était de RENDRE les 424 lignes puis de
 * les sérialiser deux fois dans le document — une fois en HTML, une fois dans
 * la charge utile que React inline pour le routeur. Le rapport était
 * strictement linéaire, mesuré à quatre tailles de lot :
 *
 *     0 ligne     73 ms      69 Ko
 *    10 lignes   156 ms     172 Ko
 *    54 lignes   537 ms     485 Ko
 *   424 lignes  1708 ms   2 484 Ko
 *
 * soit environ 3,9 ms et 5,7 Ko par ligne. Aucune optimisation de rendu ne
 * rattrape un facteur quatre cents ; il faut en rendre moins.
 *
 * ---------------------------------------------------------------------------
 * Ce que la pagination ne doit PAS abîmer
 * ---------------------------------------------------------------------------
 *
 * Les COMPTEURS. Les cartes du haut de page et les pastilles de filtre disent
 * « combien il y en aurait », pas « combien il en reste sur cette page ». Ils
 * continuent donc d'être calculés sur le lot entier ; seule la table est
 * découpée. Un compteur qui suivrait la page n'apprendrait rien.
 *
 * Et la pagination n'est pas le premier outil de tri : la recherche et les
 * filtres le sont. Elle est le filet pour le cas « aucun filtre », où personne
 * ne lit quatre cents lignes de toute façon.
 */

/**
 * Cinquante lignes : environ trois écrans à la densité de la table (40 px par
 * ligne), donc on fait défiler sans jamais chercher le bouton suivant, et le
 * document retombe sous les trois cents kilo-octets.
 */
export const CRM_PAGE_SIZE = 50;

export interface CrmPage<T> {
  readonly rows: readonly T[];
  /** Numéro de page, à partir de 1. Vaut 1 sur une liste vide. */
  readonly page: number;
  readonly pages: number;
  readonly total: number;
  /** Rang de la première et de la dernière ligne affichées, à partir de 1. */
  readonly from: number;
  readonly to: number;
}

/**
 * Le numéro de page demandé, ou 1.
 *
 * Comme `resolveProspectTab`, une valeur illisible ne lève pas et n'affiche pas
 * une page vide : elle retombe sur la première. Un lien périmé doit rester un
 * lien qui marche.
 */
export function parsePage(value: string | null | undefined): number {
  if (value === null || value === undefined) return 1;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

/**
 * Découpe un lot déjà trié et déjà filtré.
 *
 * Une page au-delà de la fin est RAMENÉE à la dernière plutôt que rendue vide :
 * retirer un filtre depuis la page 7 ne doit pas donner un écran blanc dont on
 * ne comprend pas la cause.
 */
export function paginate<T>(
  rows: readonly T[],
  page: number,
  size: number = CRM_PAGE_SIZE,
): CrmPage<T> {
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Math.trunc(page)), pages);
  const start = (current - 1) * size;
  const slice = rows.slice(start, start + size);
  return Object.freeze({
    rows: Object.freeze(slice),
    page: current,
    pages,
    total,
    from: total === 0 ? 0 : start + 1,
    to: start + slice.length,
  });
}
