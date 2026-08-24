import { readFunnelSynthesis, stateOf, type FunnelKey } from '@/lib/pipeline/funnel';
import type { EvidenceLike } from '@/lib/pipeline/score';
import type { ProspectRow } from '@/lib/repo/types';

/**
 * R7.1 — la feuille de faits.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi cette couche existe séparément du score
 * ---------------------------------------------------------------------------
 * Le score R5 lit l'evidence et rend un nombre dans le même geste. Tant qu'on
 * ne posait qu'une question, c'était suffisant. R7 en pose cinq (fit, maturité,
 * besoin, capacité, moment) sur les MÊMES observations, et cinq lecteurs
 * indépendants de la même evidence finiraient par ne plus être d'accord sur ce
 * qui a été vu.
 *
 * Ce module lit donc une fois, et rend des faits — jamais des points. Aucune
 * pondération ici, aucun seuil de décision : seulement « qu'avons-nous
 * réellement observé ».
 *
 * ---------------------------------------------------------------------------
 * Le tri-état, qui est tout l'intérêt
 * ---------------------------------------------------------------------------
 * Un marqueur vaut `observed`, `checked_absent` ou `not_checked`, et les
 * confondre est précisément l'erreur que le §2 de CLAUDE.md interdit :
 *
 *   observed       — le crawler a lu la chose sur la page. Un fait.
 *   checked_absent — le crawler a cherché la chose sur les pages lues et ne l'a
 *                    pas trouvée. C'est un fait AUSSI, et c'est celui qui porte
 *                    le besoin commercial : « ce site n'affiche aucun tarif »
 *                    n'est exploitable que si quelqu'un a regardé.
 *   not_checked    — personne n'a ouvert le site. Ce n'est pas une absence,
 *                    c'est un trou dans nos données, et il ne doit ni faire
 *                    monter le besoin ni faire baisser la maturité.
 *
 * `webintel` publie déjà les deux premiers états séparément
 * (`funnel_observed` / `funnel_not_observed`, dont le texte dit mot pour mot
 * « absence d'observation, pas absence constatée »). Ce module ne fait que
 * refuser de perdre cette distinction.
 *
 * ---------------------------------------------------------------------------
 * Deux rails, un seul vocabulaire
 * ---------------------------------------------------------------------------
 * Le corpus a été lu par deux rails qui ne nomment pas les mêmes choses :
 * `funnel_observed`/`funnel_not_observed` (webintel, jetons `clé: valeur`) et
 * `funnel_synthesis` (R5, treize `FunnelKey` typées). Les traduire ici dans un
 * vocabulaire unique est ce qui permet de comparer un prospect de R5 à un
 * prospect de la campagne historique — sans quoi la moitié du corpus paraîtrait
 * simplement « sans parcours ».
 *
 * Tout est déterministe. Aucun prompt ne décide de ce qui a été vu.
 */

export type MarkerState = 'observed' | 'checked_absent' | 'not_checked';

/**
 * Le vocabulaire unifié. Fermé volontairement : un marqueur qu'aucun rail ne
 * produit ne doit pas pouvoir apparaître dans une explication de score.
 *
 * Les noms sont ceux de `webintel`, qui est le rail le plus riche et le seul à
 * publier explicitement le « cherché et non vu ».
 */
export const COMMERCIAL_MARKERS = [
  // — mesure et acquisition —
  'analytics_google',
  'tag_manager',
  'pixel_meta',
  'pixel_tiktok',
  'session_recording',
  // — transaction —
  'booking_online',
  'checkout',
  'calendar_embed',
  // — offre structurée —
  'form_quote',
  'page_pricing',
  'price_displayed',
  'page_services',
  // — soutien à la conversion —
  'reviews_embedded',
  'faq',
  'social_proof',
  'promo_offer',
  // — chemin —
  'cta_primary',
  'form_contact',
  // — canaux publiés par l'entreprise elle-même —
  'cta_phone',
  'cta_email',
  'cta_instagram',
  'cta_facebook',
  'cta_whatsapp',
  // — frictions (R5 uniquement) —
  'conversion_friction',
  'unclear_next_step',
  'phone_only',
] as const;

export type CommercialMarker = (typeof COMMERCIAL_MARKERS)[number];

const MARKER_SET = new Set<string>(COMMERCIAL_MARKERS);

function isMarker(key: string): key is CommercialMarker {
  return MARKER_SET.has(key);
}

/** Traduction `funnel_synthesis` (R5) → vocabulaire unifié. */
const FUNNEL_KEY_TO_MARKER: Partial<Record<FunnelKey, CommercialMarker>> = {
  booking_system: 'booking_online',
  quote_form: 'form_quote',
  price_visibility: 'price_displayed',
  primary_cta: 'cta_primary',
  trust_signals: 'social_proof',
  instagram_dm_path: 'cta_instagram',
  whatsapp_path: 'cta_whatsapp',
  service_segmentation: 'page_services',
  phone_only: 'phone_only',
  conversion_friction: 'conversion_friction',
  unclear_next_step: 'unclear_next_step',
};

/**
 * Les clés R5 dont le `not_observed` ne prouve PAS l'absence du marqueur
 * unifié, parce que les deux rails ne mesurent pas la même chose.
 *
 * `instagram_dm_path` en est le cas net. R5 le marque `observed` uniquement
 * quand un lien de CONVERSATION est exposé (`ig.me/m/`, `instagram.com/direct`)
 * — un simple lien vers le profil vaut `not_observed`. Le marqueur unifié
 * `cta_instagram`, lui, vient de `webintel` et signifie « le site pointe vers
 * Instagram », ce qui est bien plus large.
 *
 * Traduire `not_observed` en `checked_absent` ferait donc dire à un site qui
 * lie son compte Instagram qu'il n'y renvoie pas — une affirmation d'absence
 * que personne n'a vérifiée, exactement ce que le §2 de CLAUDE.md interdit. La
 * traduction ne garde ici que le sens qui se déduit sûrement : un lien de
 * conversation EST un lien Instagram.
 */
const OBSERVATION_ONLY_KEYS: ReadonlySet<FunnelKey> = new Set<FunnelKey>(['instagram_dm_path', 'whatsapp_path']);

export interface CommercialFacts {
  /** Vrai seulement si au moins une page du site a été réellement lue. */
  readonly siteRead: boolean;
  readonly pagesRead: number;
  /** L'état de chaque marqueur du vocabulaire. Jamais de trou : `not_checked` par défaut. */
  readonly markers: ReadonlyMap<CommercialMarker, MarkerState>;
  /** Qualité éditoriale du site, 0..1. `null` = site non analysé. */
  readonly websiteQuality: number | null;
  /** Qualité de l'appel à l'action, 0..1. `null` = non analysé. */
  readonly ctaQuality: number | null;
  /** Prestations nommées sur le site. Vide ≠ absentes si le site n'a pas été lu. */
  readonly services: readonly string[];
  readonly premiumServices: readonly string[];
  /** Nombre de mentions de prix relevées. */
  readonly priceMentionCount: number;
  /** Nombre de titres de page relevés — une mesure de densité éditoriale. */
  readonly headingCount: number;
  /** Attributs registre fusionnés (`dateCreation`, `trancheEffectif`, `natureJuridique`…). */
  readonly registryAttributes: Readonly<Record<string, unknown>>;
  /** Le handle Instagram a-t-il été lu SUR LE SITE de l'entreprise ? */
  readonly instagramLinkedFromSite: boolean;
  /** Le compte Instagram est-il cité par une preuve quelconque ? */
  readonly instagramEvidenceCount: number;
}

export function markerState(facts: CommercialFacts, marker: CommercialMarker): MarkerState {
  return facts.markers.get(marker) ?? 'not_checked';
}

function toRatio(value: unknown): number | null {
  if (value && typeof value === 'object' && 'ratio' in value) {
    const ratio = (value as { ratio: unknown }).ratio;
    if (typeof ratio === 'number') return Math.max(0, Math.min(1, ratio));
  }
  return null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/**
 * Lit toute l'evidence d'un prospect en une passe.
 *
 * L'ordre de résolution d'un marqueur est important et il est fail-open vers
 * l'observation : si un rail dit `observed` et un autre `checked_absent`, c'est
 * `observed` qui gagne. Un rail qui n'a pas vu une chose que l'autre a lue n'a
 * pas fait une découverte — il a lu moins de pages.
 */
export function readCommercialFacts(evidence: readonly EvidenceLike[]): CommercialFacts {
  const markers = new Map<CommercialMarker, MarkerState>();

  const observe = (marker: CommercialMarker): void => {
    markers.set(marker, 'observed');
  };
  const checkedAbsent = (marker: CommercialMarker): void => {
    if (markers.get(marker) !== 'observed') markers.set(marker, 'checked_absent');
  };

  let pagesRead = 0;
  let crawlProof = false;
  let websiteQuality: number | null = null;
  let ctaQuality: number | null = null;
  const services = new Set<string>();
  const premiumServices = new Set<string>();
  let priceMentionCount = 0;
  let headingCount = 0;
  const registryAttributes: Record<string, unknown> = {};
  let instagramLinkedFromSite = false;
  let instagramEvidenceCount = 0;

  for (const row of evidence) {
    switch (row.field) {
      case 'website_quality': {
        crawlProof = true;
        const ratio = toRatio(row.value_json);
        if (ratio !== null && (websiteQuality === null || ratio > websiteQuality)) websiteQuality = ratio;
        break;
      }
      case 'cta_quality': {
        crawlProof = true;
        const ratio = toRatio(row.value_json);
        if (ratio !== null && (ctaQuality === null || ratio > ctaQuality)) ctaQuality = ratio;
        break;
      }
      case 'services':
        for (const item of stringArray(row.value_json)) services.add(item);
        break;
      case 'premium_services':
        for (const item of stringArray(row.value_json)) premiumServices.add(item);
        break;
      case 'price_mentions':
        priceMentionCount += Math.max(1, stringArray(row.value_json).length);
        break;
      case 'website_headings':
        headingCount += stringArray(row.value_json).length;
        break;
      case 'provider_attributes':
        if (row.value_json && typeof row.value_json === 'object') {
          Object.assign(registryAttributes, row.value_json as Record<string, unknown>);
        }
        break;
      case 'instagram_handle':
        instagramEvidenceCount += 1;
        break;
      case 'booking_system':
        crawlProof = true;
        observe('booking_online');
        break;
      case 'funnel_observed': {
        crawlProof = true;
        for (const token of parseFunnelTokens(row.value_text)) {
          if (isMarker(token.key)) observe(token.key);
          if (token.key === 'cta_instagram') instagramLinkedFromSite = true;
        }
        break;
      }
      case 'funnel_not_observed': {
        crawlProof = true;
        const json = row.value_json as { notObserved?: unknown; pagesAnalysed?: unknown } | null;
        for (const key of stringArray(json?.notObserved)) {
          if (isMarker(key)) checkedAbsent(key);
        }
        const analysed = json?.pagesAnalysed;
        if (Array.isArray(analysed)) pagesRead = Math.max(pagesRead, analysed.length);
        break;
      }
      case 'funnel_synthesis': {
        const synthesis = readFunnelSynthesis(row.value_json);
        if (!synthesis || synthesis.pagesRead === 0) break;
        crawlProof = true;
        pagesRead = Math.max(pagesRead, synthesis.pagesRead);
        for (const [funnelKey, marker] of Object.entries(FUNNEL_KEY_TO_MARKER)) {
          if (marker === undefined) continue;
          const state = stateOf(synthesis.observations, funnelKey as FunnelKey);
          if (state === 'observed') {
            observe(marker);
            if (marker === 'cta_instagram') instagramLinkedFromSite = true;
          } else if (state === 'not_observed' && !OBSERVATION_ONLY_KEYS.has(funnelKey as FunnelKey)) {
            checkedAbsent(marker);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  return {
    siteRead: crawlProof,
    pagesRead,
    markers,
    websiteQuality,
    ctaQuality,
    services: [...services],
    premiumServices: [...premiumServices],
    priceMentionCount,
    headingCount,
    registryAttributes,
    instagramLinkedFromSite,
    instagramEvidenceCount,
  };
}

interface FunnelToken {
  readonly key: string;
  readonly value: string;
}

/**
 * `funnel_observed.value_text` porte des jetons « clé: valeur » séparés par
 * « | ». Même analyse que `parseFunnelTokens` de `r6bDispatch`, réécrite ici
 * pour ne dépendre que d'un texte : ce module ne connaît pas les lignes de
 * dispatch et n'a pas à les connaître.
 */
function parseFunnelTokens(valueText: string | null): FunnelToken[] {
  if (!valueText) return [];
  const tokens: FunnelToken[] = [];
  for (const segment of valueText.split('|')) {
    const trimmed = segment.trim();
    const separator = trimmed.indexOf(':');
    if (separator === -1) continue;
    tokens.push({ key: trimmed.slice(0, separator).trim(), value: trimmed.slice(separator + 1).trim() });
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Adresses email — une propriété observable, jamais une supposition
// ---------------------------------------------------------------------------

export type EmailKind = 'own_domain_role' | 'own_domain_personal' | 'free_mail' | 'other_domain' | 'none';

/**
 * Fournisseurs de messagerie gratuite. Cette liste ne juge pas une entreprise :
 * elle sépare « adresse hébergée sur le domaine de l'entreprise » de « boîte
 * grand public », qui n'ont pas la même valeur comme canal professionnel.
 *
 * Un artisan sérieux sur gmail reste un artisan sérieux — c'est pourquoi
 * `free_mail` reste un canal valide et non un disqualifiant.
 */
const FREE_MAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'hotmail.fr',
  'outlook.com',
  'outlook.fr',
  'live.fr',
  'live.com',
  'msn.com',
  'yahoo.com',
  'yahoo.fr',
  'orange.fr',
  'wanadoo.fr',
  'free.fr',
  'sfr.fr',
  'laposte.net',
  'bbox.fr',
  'numericable.fr',
  'icloud.com',
  'me.com',
  'protonmail.com',
  'proton.me',
]);

/** Préfixes de boîte fonctionnelle — une adresse d'entreprise, pas d'individu. */
const ROLE_LOCAL_PARTS = new Set([
  'contact',
  'info',
  'infos',
  'hello',
  'bonjour',
  'commercial',
  'devis',
  'rdv',
  'accueil',
  'service',
  'servicesclients',
  'sav',
  'admin',
  'direction',
  'atelier',
]);

export interface EmailShape {
  readonly kind: EmailKind;
  readonly localPart: string | null;
  readonly domain: string | null;
  readonly detail: string;
}

function normalizeDomain(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Ce qu'une adresse email dit d'elle-même.
 *
 * Rien de plus : la fonction ne prétend pas que l'adresse est valide, encore
 * moins qu'elle est relevée. Elle constate la forme, qui est tout ce qu'on peut
 * observer sans écrire à quelqu'un — et écrire est interdit.
 */
export function emailShape(email: string | null, siteDomain: string | null): EmailShape {
  const value = email?.trim().toLowerCase() ?? '';
  if (value.length === 0 || !value.includes('@')) {
    return { kind: 'none', localPart: null, domain: null, detail: 'aucune adresse observée' };
  }
  const at = value.lastIndexOf('@');
  const localPart = value.slice(0, at);
  const domain = value.slice(at + 1);
  const own = normalizeDomain(siteDomain);

  if (FREE_MAIL_DOMAINS.has(domain)) {
    return { kind: 'free_mail', localPart, domain, detail: `boîte grand public (${domain})` };
  }
  if (own !== null && (domain === own || domain.endsWith(`.${own}`) || own.endsWith(`.${domain}`))) {
    const isRole = ROLE_LOCAL_PARTS.has(localPart.replace(/[._-]/g, ''));
    return isRole
      ? { kind: 'own_domain_role', localPart, domain, detail: `boîte fonctionnelle sur le domaine (${value})` }
      : { kind: 'own_domain_personal', localPart, domain, detail: `adresse nominative sur le domaine (${value})` };
  }
  return { kind: 'other_domain', localPart, domain, detail: `domaine tiers (${domain})` };
}

/** Les canaux dont un identifiant a été observé. « Disponible », jamais « recommandé ». */
export interface ObservedContact {
  readonly email: string | null;
  readonly phone: string | null;
  readonly instagramHandle: string | null;
  readonly facebookUrl: string | null;
  readonly websiteUrl: string | null;
  readonly domain: string | null;
}

export function observedContact(prospect: ProspectRow): ObservedContact {
  const clean = (value: string | null): string | null => {
    const trimmed = value?.trim() ?? '';
    return trimmed.length > 0 ? trimmed : null;
  };
  return {
    email: clean(prospect.email),
    phone: clean(prospect.phone),
    instagramHandle: clean(prospect.instagram_handle),
    facebookUrl: clean(prospect.facebook_url),
    websiteUrl: clean(prospect.website_url),
    domain: clean(prospect.domain),
  };
}
