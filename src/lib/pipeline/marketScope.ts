/**
 * HERMES-SERVICE-SCOPE-TARGETING-R1 §17 — « ce commerce est-il seulement sur notre
 * marché ? »
 *
 * ---------------------------------------------------------------------------
 * Le trou, nommé avant d'être bouché
 * ---------------------------------------------------------------------------
 * La mission demande de confirmer la géographie ICP, et de ne pas l'inventer si
 * elle n'existe pas. Elle n'existait pas. Voici ce que le dépôt contenait
 * réellement le 22 août 2026 :
 *
 *   * chaque campagne DÉCLARE une géographie (`config/campaigns/*.yaml`,
 *     `geography.country: FR`), et `matchesGeography` sait l'appliquer — mais
 *     uniquement pendant la DÉCOUVERTE, sur des lignes qui portent une ville ou
 *     des coordonnées. Les prospects du rail commercial n'en portent pas ;
 *   * `prospects.country` vaut `'FR'` pour tout le corpus, parce que la valeur
 *     est ÉCRITE EN DUR dans le rail de découverte commerciale
 *     (`railCommercial.ts`, `country: 'FR'`) et dans les autres sources. Ce
 *     n'est pas une observation, c'est une constante — et CLAUDE.md §2 interdit
 *     de présenter une supposition comme un fait ;
 *   * la politique autonome ne posait aucune question de géographie.
 *
 * D'où `@demo_account_32montreal` : une école de mécanique de MONTRÉAL (Québec),
 * domaine `.com`, aucun SIREN, aucun code postal — entrée dans le corpus avec
 * `country = 'FR'` et arrivée jusqu'à `message_ready`.
 *
 * ---------------------------------------------------------------------------
 * La règle minimale, et pourquoi elle est celle-là
 * ---------------------------------------------------------------------------
 * On ne remplace pas une constante non observée par une autre. Ce module ne LIT
 * PAS `prospects.country` — il serait faux de s'appuyer dessus, et le lire
 * ferait passer la constante pour une preuve.
 *
 * Il demande à la place une ANCRE POSITIVE, observée, du marché français, parmi
 * trois faits que le corpus porte déjà et qui ne s'inventent pas :
 *
 *   * un identifiant de registre français (SIREN/SIRET : 9 ou 14 chiffres),
 *     posé par le registre ou lu dans les mentions légales du site ;
 *   * un code postal français à cinq chiffres, dans la plage réellement
 *     attribuée (01000–98999) ;
 *   * un domaine sous un TLD français (`.fr`, `.corsica`, `.paris`, …).
 *
 * Aucune ancre ⇒ pas d'envoi AUTOMATIQUE, et le refus est RECONSIDÉRABLE : une
 * mention légale lue plus tard, un SIREN retrouvé, et le prospect revient tout
 * seul. C'est un « nous ne savons pas », jamais un « nous savons que non ».
 *
 * Mesuré sur le corpus avant d'être écrit : 77 des 83 prospects `message_ready`
 * portent au moins une ancre. La règle coûte six lignes et attrape l'école de
 * Montréal — elle borne le marché sans assécher la file.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce module ne fait pas
 * ---------------------------------------------------------------------------
 * Il ne décide d'aucune ville, d'aucun département, d'aucun rayon : la
 * géographie FINE reste celle des campagnes, qui la déclarent et l'appliquent à
 * la découverte. Il ne prononce jamais `OUT_OF_MARKET` sur une absence — seule
 * une ancre CONTRADICTOIRE le ferait, et le corpus n'en porte aucune de
 * suffisamment fiable pour l'affirmer.
 */

export type MarketScopeVerdict =
  /** Au moins une ancre observée place ce commerce sur le marché français. */
  | 'IN_MARKET'
  /** Aucune ancre. Ni dedans ni dehors — une question ouverte. */
  | 'UNKNOWN';

export type MarketAnchorKind = 'registry_id' | 'postal_code' | 'domain_tld';

export interface MarketAnchor {
  readonly kind: MarketAnchorKind;
  readonly value: string;
}

export interface MarketScopeAssessment {
  readonly verdict: MarketScopeVerdict;
  readonly anchors: readonly MarketAnchor[];
  readonly reason: string;
}

export interface MarketScopeInput {
  readonly registryId?: string | null;
  readonly postalCode?: string | null;
  readonly domain?: string | null;
  readonly websiteUrl?: string | null;
}

/**
 * Les TLD qui ne peuvent appartenir qu'à un acteur français.
 *
 * `.com`, `.net` et consorts en sont ABSENTS et doivent le rester : un artisan
 * français sur `.com` est banal, et l'exclure ferait de ce module un filtre de
 * nom de domaine plutôt qu'une ancre de marché. Leur absence ne refuse
 * personne — elle demande seulement une autre ancre.
 */
const FRENCH_TLDS: readonly string[] = ['.fr', '.corsica', '.paris', '.alsace', '.bzh'];

/** SIREN (9 chiffres) ou SIRET (14). Les séparateurs usuels sont tolérés. */
function frenchRegistryId(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/[^0-9]/g, '');
  return digits.length === 9 || digits.length === 14 ? digits : null;
}

/**
 * Code postal français : cinq chiffres, dans la plage attribuée.
 *
 * La borne basse écarte `00000` et les codes à zéro initial qui n'existent pas ;
 * la borne haute laisse passer les DOM (971xx–988xx), qui SONT le marché
 * français. Un code postal à cinq chiffres existe aussi ailleurs — en Espagne,
 * en Italie, aux États-Unis. Il n'est donc pas une preuve à lui seul de
 * nationalité ; il l'est en revanche d'un adressage compatible, et c'est tout
 * ce que ce module prétend établir. `@demo_account_32montreal` n'en porte aucun :
 * les codes canadiens sont alphanumériques.
 */
function frenchPostalCode(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim();
  if (!/^[0-9]{5}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= 1000 && value <= 98999 ? trimmed : null;
}

function frenchDomain(domain: string | null | undefined, websiteUrl: string | null | undefined): string | null {
  const raw = (domain ?? websiteUrl ?? '').trim().toLowerCase();
  if (raw.length === 0) return null;
  const host = raw
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '');
  return FRENCH_TLDS.some((tld) => host.endsWith(tld)) ? host : null;
}

export function assessMarketScope(input: MarketScopeInput): MarketScopeAssessment {
  const anchors: MarketAnchor[] = [];

  const registry = frenchRegistryId(input.registryId);
  if (registry !== null) anchors.push({ kind: 'registry_id', value: registry });

  const postal = frenchPostalCode(input.postalCode);
  if (postal !== null) anchors.push({ kind: 'postal_code', value: postal });

  const domain = frenchDomain(input.domain, input.websiteUrl);
  if (domain !== null) anchors.push({ kind: 'domain_tld', value: domain });

  if (anchors.length === 0) {
    return Object.freeze({
      verdict: 'UNKNOWN',
      anchors: Object.freeze([]),
      reason:
        'aucune ancre de marché observée — ni identifiant de registre français, ni code postal ' +
        'français, ni domaine sous TLD français. `prospects.country` n’est pas lu : il vaut « FR » ' +
        'pour tout le corpus parce qu’il est écrit en dur à la découverte',
    });
  }

  return Object.freeze({
    verdict: 'IN_MARKET',
    anchors: Object.freeze(anchors),
    reason: `ancre(s) de marché observée(s) : ${anchors.map((a) => `${a.kind}=${a.value}`).join(', ')}`,
  });
}

/** Le verdict autorise-t-il un envoi AUTOMATIQUE ? Égalité stricte, comme partout ailleurs. */
export function marketScopeAllowsAutoSend(verdict: MarketScopeVerdict): boolean {
  return verdict === 'IN_MARKET';
}
