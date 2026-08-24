import {
  COMMERCIAL_MARKERS,
  markerState,
  type CommercialFacts,
  type CommercialMarker,
  type MarkerState,
} from '@/lib/pipeline/commercialSignals';

/**
 * R7.7 §4 — la qualité de la preuve, parce que « lu » n'est pas « inspecté ».
 *
 * ---------------------------------------------------------------------------
 * Le défaut, mesuré avant d'être corrigé
 * ---------------------------------------------------------------------------
 * `commercialSignals` publie depuis R7.1 un tri-état dont la troisième valeur
 * est la garantie du §2 de CLAUDE.md :
 *
 *   observed        le crawler a lu la chose ;
 *   checked_absent  il l'a cherchée et ne l'a pas trouvée ;
 *   not_checked     personne n'a regardé.
 *
 * Sur le corpus, `not_checked` était MORT. Cinquante-quatre prospects ont un
 * site lu ; les cinquante-quatre publient une couverture du besoin de 100 % et
 * une confiance HIGH — qu'une page ait été ouverte ou six. La cause est en
 * amont : `funnel_not_observed` liste tout ce qu'il n'a pas vu SUR LES PAGES
 * QU'IL A LUES, et `readCommercialFacts` traduit chaque entrée en
 * `checked_absent`. Une page d'accueil produisait ainsi vingt-deux absences
 * constatées. `ESTHETIC CAR ATELIER` en est le cas net : une page, zéro
 * marqueur observé, vingt-trois absences déclarées, besoin 93, confiance HIGH,
 * décision PRIORITIZE — et l'humain a répondu NOT_TARGET.
 *
 * Le tri-état existait donc, et le rail le repliait en bi-état dès qu'un octet
 * avait été lu. « Je n'ai pas observé » redevenait « j'ai observé que c'est
 * absent », par le chemin le plus discret possible.
 *
 * ---------------------------------------------------------------------------
 * La correction : la PORTÉE d'un fait, pas le nombre de pages
 * ---------------------------------------------------------------------------
 * Le §4 de la mission interdit une pénalité fondée sur `pageCount` seul, et il
 * a raison : un site d'une page peut être un site complet. Ce module ne compte
 * donc pas les pages pour retirer des points. Il demande, marqueur par
 * marqueur, une question antérieure :
 *
 *   « quelle lecture SUFFIT à établir l'absence de cette chose-là ? »
 *
 * Et la réponse n'est pas la même pour toutes :
 *
 *   page_local    la chose vit dans le HTML de la page lue. Un pixel Meta est
 *                 dans le `<head>` de chaque page ; un numéro de téléphone, un
 *                 lien Instagram, un bandeau promotionnel sont dans l'en-tête
 *                 ou le pied. Ne pas les y trouver EST une observation, et une
 *                 seule page suffit à la porter ;
 *   site_scoped   la chose est une DESTINATION : une page de tarifs, une page
 *                 de prestations, un formulaire de devis, un outil de
 *                 réservation, une FAQ. Son absence ne se constate pas depuis
 *                 la page d'accueil — elle se constate en ayant parcouru la
 *                 surface navigable du site.
 *
 * Un `checked_absent` de portée `site_scoped` déclaré par un crawl qui n'a
 * jamais quitté la page d'entrée n'est donc pas une absence : c'est un
 * `not_checked` mal nommé. Ce module le RENOMME. Il ne retire aucun point, il
 * ne pénalise personne : il retire une AFFIRMATION que personne n'a vérifiée,
 * et laisse ensuite la discipline de `foldWeightedContributions` faire son
 * travail habituel — un contributeur `null` quitte le dénominateur, et la
 * couverture publiée devient enfin ce qu'elle prétendait être.
 *
 * C'est la différence entre « ce site n'a pas de page tarifs » et « je n'ai lu
 * que sa page d'accueil ». La première est un argument commercial ; la seconde
 * est une demande de collecte.
 *
 * ---------------------------------------------------------------------------
 * Ce que la confiance veut dire APRÈS ce module
 * ---------------------------------------------------------------------------
 * Avant : « combien de contributeurs ont une valeur », c'est-à-dire, en
 * pratique, « le site a-t-il été ouvert ». Une constante déguisée en mesure.
 *
 * Après : « quelle part du poids nécessaire au calcul repose sur une preuve
 * qu'une lecture de cette portée pouvait établir ». La couverture varie enfin
 * avec la lecture — une page d'entrée seule établit les contributeurs de portée
 * page, pas les autres — et le seuil `confidence.high` du profil, inchangé,
 * cesse d'être atteint par tout le monde. Aucun seuil nouveau n'a été
 * introduit ; c'est la GRANDEUR mesurée qui a été corrigée, pas la règle qui la
 * lit.
 */

export type EvidenceScope = 'page_local' | 'site_scoped';

/**
 * La portée de chaque marqueur du vocabulaire unifié.
 *
 * La table est exhaustive et le type l'impose : ajouter un marqueur à
 * `COMMERCIAL_MARKERS` sans décider quelle lecture établit son absence ne
 * compile pas. C'est délibéré — c'est exactement la décision qu'on oublie de
 * prendre.
 */
export const MARKER_EVIDENCE_SCOPE: Readonly<Record<CommercialMarker, EvidenceScope>> = Object.freeze({
  // — mesure : des balises dans le `<head>`, présentes sur toutes les pages —
  analytics_google: 'page_local',
  tag_manager: 'page_local',
  pixel_meta: 'page_local',
  pixel_tiktok: 'page_local',
  session_recording: 'page_local',

  // — transaction : des DESTINATIONS, atteintes depuis une navigation —
  booking_online: 'site_scoped',
  checkout: 'site_scoped',
  calendar_embed: 'site_scoped',

  // — offre structurée : des pages, sauf le prix qui peut s'afficher partout —
  form_quote: 'site_scoped',
  page_pricing: 'site_scoped',
  price_displayed: 'site_scoped',
  page_services: 'site_scoped',

  // — soutien à la conversion : des blocs de page —
  reviews_embedded: 'page_local',
  faq: 'site_scoped',
  social_proof: 'page_local',
  promo_offer: 'page_local',

  // — chemin : en-tête et pied de page, donc sur toute page lue —
  cta_primary: 'page_local',
  form_contact: 'page_local',

  // — canaux publiés : pied de page, sur toute page lue —
  cta_phone: 'page_local',
  cta_email: 'page_local',
  cta_instagram: 'page_local',
  cta_facebook: 'page_local',
  cta_whatsapp: 'page_local',

  // — frictions : des jugements de parcours rendus par R5 sur ce qu'il a lu —
  conversion_friction: 'page_local',
  unclear_next_step: 'page_local',
  phone_only: 'page_local',
});

/**
 * Ce qu'une lecture a couvert, dit en termes de SURFACE et non de volume.
 *
 *   none              rien n'a été ouvert ;
 *   entry_page_only   une seule page. Tout ce qui vit sur une page est
 *                     établi ; rien de ce qui vit ailleurs ne l'est ;
 *   multi_page        la navigation a été suivie. Les destinations ont pu
 *                     être atteintes, donc leur absence peut être constatée.
 *
 * Le seuil est « au moins une page AU-DELÀ de la page d'entrée », et il n'est
 * pas un réglage : c'est la définition même de « avoir parcouru un site ». Un
 * crawl qui n'a lu que l'accueil n'a pas visité la page tarifs, quelle que
 * soit la richesse de cet accueil.
 */
export type CrawlReach = 'none' | 'entry_page_only' | 'multi_page';

export function crawlReachOf(facts: Pick<CommercialFacts, 'pagesRead' | 'siteRead'>): CrawlReach {
  if (facts.pagesRead >= 2) return 'multi_page';
  if (facts.pagesRead === 1 || facts.siteRead) return 'entry_page_only';
  return 'none';
}

/** Une lecture de cette portée peut-elle établir l'ABSENCE de ce marqueur ? */
export function canEstablishAbsence(marker: CommercialMarker, reach: CrawlReach): boolean {
  if (reach === 'none') return false;
  if (reach === 'multi_page') return true;
  return MARKER_EVIDENCE_SCOPE[marker] === 'page_local';
}

export type EvidenceSufficiency = 'SUFFICIENT' | 'PARTIAL' | 'INSUFFICIENT' | 'NONE';

export interface EvidenceQuality {
  readonly reach: CrawlReach;
  readonly pagesRead: number;
  /** Marqueurs réellement observés sur les pages lues. */
  readonly observedCount: number;
  /** Absences que la portée de la lecture AUTORISE à affirmer. */
  readonly establishedAbsenceCount: number;
  /**
   * Absences RETIRÉES : déclarées par le rail, mais hors de portée de la
   * lecture. Ce ne sont pas des erreurs du crawler — il a honnêtement dit « pas
   * vu sur ce que j'ai lu ». C'est la traduction en « absent » qui était fausse.
   */
  readonly withdrawnAbsences: readonly CommercialMarker[];
  /** Marqueurs dont l'état reste inconnu après retrait. */
  readonly unknownCount: number;
  /** Part du vocabulaire dont l'état est ÉTABLI, 0..1. */
  readonly sufficiency: number;
  readonly verdict: EvidenceSufficiency;
  readonly detail: string;
}

/**
 * Le seuil de suffisance reprend `confidence.high` / `confidence.medium` du
 * profil plutôt que d'en inventer deux : la question posée est la même — « quelle
 * part de ce qu'il fallait savoir sait-on ? » — et deux échelles pour une seule
 * question finiraient par se contredire.
 */
export interface EvidenceSufficiencyThresholds {
  readonly high: number;
  readonly medium: number;
}

/**
 * Rend une copie des faits dans laquelle aucune absence n'est affirmée au-delà
 * de ce que la lecture pouvait établir, et le rapport de ce qui a été retiré.
 *
 * Les faits d'origine ne sont pas modifiés : `readCommercialFacts` reste la
 * relation fidèle de ce que les rails ont dit, et ce module reste la relation
 * fidèle de ce qu'on a le droit d'en conclure. Confondre les deux serait
 * réintroduire, un étage plus haut, exactement le défaut qu'on corrige.
 */
export function qualifyEvidence(
  facts: CommercialFacts,
  thresholds: EvidenceSufficiencyThresholds,
): { readonly facts: CommercialFacts; readonly quality: EvidenceQuality } {
  const reach = crawlReachOf(facts);
  const markers = new Map<CommercialMarker, MarkerState>(facts.markers);
  const withdrawn: CommercialMarker[] = [];

  let observedCount = 0;
  let establishedAbsenceCount = 0;

  for (const marker of COMMERCIAL_MARKERS) {
    const state = markerState(facts, marker);
    if (state === 'observed') {
      observedCount += 1;
      continue;
    }
    if (state !== 'checked_absent') continue;
    if (canEstablishAbsence(marker, reach)) {
      establishedAbsenceCount += 1;
      continue;
    }
    markers.set(marker, 'not_checked');
    withdrawn.push(marker);
  }

  const established = observedCount + establishedAbsenceCount;
  const sufficiency = established / COMMERCIAL_MARKERS.length;
  /**
   * R7.7 §5 — une navigation suivie est NÉCESSAIRE à une preuve dite suffisante.
   *
   * Dire d'une preuve qu'elle est suffisante, c'est affirmer qu'on sait ce que
   * ce site offre ET ce qu'il n'offre pas. Une page d'entrée, si riche soit-elle,
   * ne peut pas porter la seconde moitié de cette affirmation : toute une
   * CATÉGORIE des faits nécessaires — les destinations, page de tarifs, page de
   * prestations, outil de réservation, formulaire de devis — était hors de sa
   * portée par construction.
   *
   * Ce n'est donc pas un seuil sur `pageCount`, que le §4 interdit à juste
   * titre. C'est la conséquence directe de la table de portée : la part du
   * vocabulaire qu'une lecture de page unique établit est plafonnée, et la
   * confiance qu'elle autorise l'est avec elle. Le plafond est MEDIUM, jamais
   * zéro — une page lue reste une observation, et beaucoup de faits y sont
   * réellement établis.
   */
  const verdict: EvidenceSufficiency =
    reach === 'none' || established === 0
      ? 'NONE'
      : reach === 'entry_page_only'
        ? sufficiency >= thresholds.medium
          ? 'PARTIAL'
          : 'INSUFFICIENT'
        : sufficiency >= thresholds.high
          ? 'SUFFICIENT'
          : sufficiency >= thresholds.medium
            ? 'PARTIAL'
            : 'INSUFFICIENT';

  const detail =
    reach === 'none'
      ? 'aucune page lue — aucun fait commercial n’est établi, ni présent ni absent'
      : reach === 'entry_page_only'
        ? `page d’entrée seule (${facts.pagesRead} page) — ${established} fait(s) établi(s), ` +
          `${withdrawn.length} absence(s) de portée site retirée(s) faute de navigation`
        : `${facts.pagesRead} pages parcourues — ${established} fait(s) établi(s), toutes portées confondues`;

  return {
    facts: { ...facts, markers },
    quality: {
      reach,
      pagesRead: facts.pagesRead,
      observedCount,
      establishedAbsenceCount,
      withdrawnAbsences: withdrawn,
      unknownCount: COMMERCIAL_MARKERS.length - established,
      sufficiency: Math.round(sufficiency * 100) / 100,
      verdict,
      detail,
    },
  };
}
