import { matchVocabulary } from '@/lib/enrichment/websiteExtract';
import type { PageFacts } from '@/lib/enrichment/websiteExtract';
import type { NicheConfig } from '@/lib/config/schema';
import type { EvidenceInput } from '@/lib/repo/types';

/**
 * Le parcours commercial, décrit plutôt que noté (§10).
 *
 * Jusqu'ici le funnel se résumait à deux ratios — `website_quality` et
 * `cta_quality` — et à un booléen, `funnel_observable`. C'était assez pour
 * répondre « avons-nous lu le site ? » et beaucoup trop pauvre pour répondre
 * « qu'est-ce qui cloche dans sa façon de vendre ? », qui est la seule question
 * dont un message d'approche puisse partir. Un ratio de 0,5 ne se raconte pas ;
 * « il n'y a aucun moyen de demander un devis, seulement un numéro de
 * téléphone » se raconte en une phrase et se vérifie en dix secondes.
 *
 * ---------------------------------------------------------------------------
 * Trois états, jamais deux
 * ---------------------------------------------------------------------------
 * C'est la décision structurante de ce fichier, et elle vient directement de la
 * règle 2 du dépôt :
 *
 *   `observed`     — nous l'avons vu sur une page que nous avons lue.
 *   `not_observed` — nous l'avons cherché sur les N pages lues et pas vu.
 *   `not_checked`  — nous n'avons lu aucune page. Nous ne savons rien.
 *
 * Un booléen aurait écrasé les deux derniers en « false », et un rapport aurait
 * alors écrit « aucun système de réservation » pour un site jamais ouvert.
 * C'est une affirmation d'absence non vérifiée, c'est-à-dire une donnée
 * inventée. `not_observed` porte d'ailleurs son sens dans son libellé, parce
 * qu'un état ne se lit pas toujours avec sa documentation sous les yeux.
 *
 * ---------------------------------------------------------------------------
 * Ce qui manque est ce qui vaut de l'argent
 * ---------------------------------------------------------------------------
 * `opportunitySignals` est l'inversion utile : un site sans devis en ligne,
 * sans tarif, sans réservation, qui renvoie vers un DM Instagram, n'est pas un
 * mauvais prospect — c'est le meilleur. Il vend déjà, et il vend malgré son
 * parcours. Le §12 du gate le dit autrement (« funnel faible / réservation par
 * DM » figure dans le portrait du profil excellent), et ce module rend cette
 * lecture calculable.
 *
 * Tout est déterministe. Aucun prompt ne décide de ce qui a été vu sur une page.
 */

export type FunnelObservationState = 'observed' | 'not_observed' | 'not_checked';

export type FunnelKey =
  | 'primary_cta'
  | 'quote_form'
  | 'booking_system'
  | 'phone_only'
  | 'instagram_dm_path'
  | 'whatsapp_path'
  | 'form_depth'
  | 'service_segmentation'
  | 'visible_offer'
  | 'price_visibility'
  | 'trust_signals'
  | 'conversion_friction'
  | 'unclear_next_step';

export interface FunnelObservation {
  key: FunnelKey;
  state: FunnelObservationState;
  /** Ce qui a été lu, mot pour mot quand c'est un texte de la page. */
  detail: string;
  /** Valeur mesurée quand il y en a une (profondeur d'un formulaire, nombre de prestations). */
  value: number | null;
}

export interface FunnelSynthesis {
  observations: FunnelObservation[];
  /** Vrai seulement si au moins une page a été lue. */
  observable: boolean;
  pagesRead: number;
  /** L'appel à l'action principal, tel qu'il est écrit sur la page. */
  primaryCta: string | null;
  /** Ce qui manque et que nous savons corriger. Le point de départ d'un message. */
  opportunitySignals: string[];
  /** Ce qui freine la conversion sur ce qui existe déjà. */
  frictionSignals: string[];
  /** Une phrase, lisible dans un tableau de revue. */
  summary: string;
}

/**
 * Au-delà de ce nombre de champs, un formulaire est un obstacle plutôt qu'un
 * chemin. Le seuil est empirique et assumé comme tel : il ne sert pas à noter
 * un site, il sert à signaler à un humain qu'il y a là quelque chose à regarder.
 */
export const FORM_DEPTH_FRICTION_THRESHOLD = 6;

/** Nombre de prestations distinctes au-delà duquel l'offre est réellement segmentée. */
export const SERVICE_SEGMENTATION_THRESHOLD = 3;

function observation(
  key: FunnelKey,
  state: FunnelObservationState,
  detail: string,
  value: number | null = null,
): FunnelObservation {
  return { key, state, detail, value };
}

const ALL_KEYS: readonly FunnelKey[] = [
  'primary_cta',
  'quote_form',
  'booking_system',
  'phone_only',
  'instagram_dm_path',
  'whatsapp_path',
  'form_depth',
  'service_segmentation',
  'visible_offer',
  'price_visibility',
  'trust_signals',
  'conversion_friction',
  'unclear_next_step',
];

/**
 * Le parcours d'un site, lu sur les pages effectivement récupérées.
 *
 * `facts` vide n'est pas un site sans funnel : c'est un site que nous n'avons
 * pas ouvert. La fonction rend alors treize `not_checked` et `observable:
 * false`, et refuse d'aller plus loin.
 */
export function analyseFunnel(facts: readonly PageFacts[], niche: NicheConfig): FunnelSynthesis {
  if (facts.length === 0) {
    return {
      observations: ALL_KEYS.map((key) =>
        observation(key, 'not_checked', 'aucune page lue : rien n’a été cherché sur ce site'),
      ),
      observable: false,
      pagesRead: 0,
      primaryCta: null,
      opportunitySignals: [],
      frictionSignals: [],
      summary: 'parcours non observé — aucune page lue',
    };
  }

  const pagesRead = facts.length;
  const scope = `sur les ${pagesRead} page(s) lue(s)`;

  const ctas = facts.flatMap((page) => page.ctaTexts);
  const primaryCta = ctas[0] ?? null;
  const bookingProviders = [...new Set(facts.flatMap((page) => page.bookingProviders))];
  const quoteRequest = facts.some((page) => page.quoteRequest);
  const hasForm = facts.some((page) => page.hasContactForm);
  const hasTel = facts.some((page) => page.hasTelLink) || facts.some((page) => page.phones.length > 0);
  const hasMail = facts.some((page) => page.hasMailtoLink) || facts.some((page) => page.emails.length > 0);
  const whatsapp = facts.some((page) => page.whatsapp);
  const instagramDm = facts.some((page) => page.instagramDm);
  const instagram = facts.some((page) => page.instagram.length > 0);
  const prices = [...new Set(facts.flatMap((page) => page.priceMentions))];
  const trust = [...new Set(facts.flatMap((page) => page.trustSignals))];
  const formFields = facts.reduce((max, page) => Math.max(max, page.formFieldCount), 0);

  const offerText = facts
    .map((page) => `${page.title ?? ''} ${page.description ?? ''} ${page.headings.join(' ')}`)
    .join(' ');
  const services = matchVocabulary(offerText, niche.serviceTerms);

  const observations: FunnelObservation[] = [];

  observations.push(
    primaryCta
      ? observation('primary_cta', 'observed', `appel à l’action « ${primaryCta} »`)
      : observation('primary_cta', 'not_observed', `aucun appel à l’action explicite ${scope}`),
  );

  observations.push(
    quoteRequest
      ? observation('quote_form', 'observed', 'demande de devis proposée')
      : hasForm
        ? observation('quote_form', 'not_observed', `formulaire de contact générique, pas de devis ${scope}`)
        : observation('quote_form', 'not_observed', `aucun formulaire de devis ${scope}`),
  );

  observations.push(
    bookingProviders.length > 0
      ? observation('booking_system', 'observed', `réservation en ligne (${bookingProviders.join(', ')})`)
      : observation('booking_system', 'not_observed', `aucun système de réservation ${scope}`),
  );

  /**
   * `phone_only` ne se déduit pas de la présence d'un téléphone : il se déduit
   * de l'absence de tout le reste. C'est le portrait d'une entreprise qui prend
   * ses rendez-vous à la voix, et c'est le signal commercial le plus net de
   * tout ce module.
   */
  const phoneOnly = hasTel && !hasForm && bookingProviders.length === 0 && !quoteRequest;
  observations.push(
    phoneOnly
      ? observation('phone_only', 'observed', 'le téléphone est le seul chemin de conversion trouvé')
      : observation('phone_only', 'not_observed', `d’autres chemins que le téléphone existent ${scope}`),
  );

  observations.push(
    instagramDm
      ? observation('instagram_dm_path', 'observed', 'lien de conversation Instagram exposé sur le site')
      : instagram
        ? observation('instagram_dm_path', 'not_observed', `Instagram lié, mais aucun lien de conversation direct ${scope}`)
        : observation('instagram_dm_path', 'not_observed', `aucun chemin Instagram ${scope}`),
  );

  observations.push(
    whatsapp
      ? observation('whatsapp_path', 'observed', 'WhatsApp proposé comme canal de conversation')
      : observation('whatsapp_path', 'not_observed', `aucun chemin WhatsApp ${scope}`),
  );

  observations.push(
    hasForm
      ? observation(
          'form_depth',
          'observed',
          `formulaire de ${formFields} champ(s) à remplir`,
          formFields,
        )
      : observation('form_depth', 'not_observed', `aucun formulaire ${scope}`),
  );

  observations.push(
    services.length >= SERVICE_SEGMENTATION_THRESHOLD
      ? observation(
          'service_segmentation',
          'observed',
          `offre segmentée : ${services.slice(0, 5).join(', ')}`,
          services.length,
        )
      : observation(
          'service_segmentation',
          'not_observed',
          `${services.length} prestation(s) nommée(s) ${scope} — offre peu segmentée`,
          services.length,
        ),
  );

  const visibleOffer = services.length >= 1 && facts.some((page) => page.headings.length >= 2);
  observations.push(
    visibleOffer
      ? observation('visible_offer', 'observed', `prestations annoncées en titre (${services.slice(0, 3).join(', ')})`)
      : observation('visible_offer', 'not_observed', `l’offre n’est pas lisible en titre ${scope}`),
  );

  observations.push(
    prices.length > 0
      ? observation('price_visibility', 'observed', `tarifs affichés (${prices.slice(0, 3).join(', ')})`, prices.length)
      : observation('price_visibility', 'not_observed', `aucun tarif affiché ${scope}`, 0),
  );

  observations.push(
    trust.length > 0
      ? observation('trust_signals', 'observed', `réassurance : ${trust.slice(0, 3).join(', ')}`, trust.length)
      : observation('trust_signals', 'not_observed', `aucune marque de réassurance ${scope}`, 0),
  );

  const frictionSignals: string[] = [];
  if (hasForm && formFields > FORM_DEPTH_FRICTION_THRESHOLD) {
    frictionSignals.push(`formulaire de ${formFields} champs : trop long pour un mobile`);
  }
  if (hasForm && !quoteRequest && bookingProviders.length === 0) {
    frictionSignals.push('formulaire générique : le visiteur ne sait pas ce qu’il obtient en l’envoyant');
  }
  if (services.length >= SERVICE_SEGMENTATION_THRESHOLD && prices.length === 0) {
    frictionSignals.push('plusieurs prestations annoncées, aucun tarif : le visiteur doit demander pour savoir');
  }
  if (!primaryCta && (hasTel || hasMail)) {
    frictionSignals.push('des coordonnées existent mais rien n’invite à s’en servir');
  }

  observations.push(
    frictionSignals.length > 0
      ? observation('conversion_friction', 'observed', frictionSignals.join(' ; '), frictionSignals.length)
      : observation('conversion_friction', 'not_observed', `aucun frein évident ${scope}`, 0),
  );

  const noPathAtAll =
    !primaryCta && !hasForm && bookingProviders.length === 0 && !hasTel && !whatsapp && !instagramDm;
  observations.push(
    noPathAtAll
      ? observation('unclear_next_step', 'observed', `aucun chemin de conversion identifiable ${scope}`)
      : observation('unclear_next_step', 'not_observed', 'au moins un chemin de conversion existe'),
  );

  const opportunitySignals: string[] = [];
  if (bookingProviders.length === 0) opportunitySignals.push('aucune réservation en ligne observée');
  if (!quoteRequest) opportunitySignals.push('aucune demande de devis observée');
  if (prices.length === 0) opportunitySignals.push('aucun tarif visible observé');
  if (phoneOnly) opportunitySignals.push('conversion par téléphone uniquement');
  if (!primaryCta) opportunitySignals.push('aucun appel à l’action explicite observé');
  if (trust.length === 0) opportunitySignals.push('aucune preuve sociale observée sur le site');
  if (noPathAtAll) opportunitySignals.push('aucun chemin de conversion identifiable');

  return {
    observations,
    observable: true,
    pagesRead,
    primaryCta,
    opportunitySignals,
    frictionSignals,
    summary: summarise({ primaryCta, bookingProviders, quoteRequest, phoneOnly, prices, pagesRead }),
  };
}

function summarise(input: {
  primaryCta: string | null;
  bookingProviders: string[];
  quoteRequest: boolean;
  phoneOnly: boolean;
  prices: string[];
  pagesRead: number;
}): string {
  const parts: string[] = [];
  parts.push(
    input.bookingProviders.length > 0
      ? `réservation en ligne (${input.bookingProviders[0]})`
      : input.quoteRequest
        ? 'devis en ligne'
        : input.phoneOnly
          ? 'téléphone seul'
          : 'pas de chemin de conversion structuré',
  );
  parts.push(input.prices.length > 0 ? 'tarifs affichés' : 'tarifs non affichés');
  if (input.primaryCta) parts.push(`CTA « ${input.primaryCta} »`);
  return `${parts.join(', ')} — ${input.pagesRead} page(s) lue(s)`;
}

/**
 * L'evidence à écrire pour ce parcours.
 *
 * Une seule ligne, `funnel_synthesis`, portant la structure entière. Écrire
 * treize lignes séparées gonflerait `funnel_signal_count` — un compteur R2 qui
 * mesure les *sources* de signal — et rendrait incomparables les prospects
 * enrichis avant et après R5. Le compteur doit continuer de mesurer la même
 * chose.
 *
 * `not_observed` est recopié tel quel dans la valeur textuelle, et c'est
 * volontaire : quiconque relit cette ligne dans six mois doit y trouver la
 * nuance, pas la reconstituer.
 */
export function funnelEvidence(
  synthesis: FunnelSynthesis,
  sourceUrl: string | null,
  observedAt?: string,
): EvidenceInput | null {
  if (!synthesis.observable) return null;
  return {
    field: 'funnel_synthesis',
    valueText: synthesis.summary,
    valueJson: {
      observations: synthesis.observations,
      opportunitySignals: synthesis.opportunitySignals,
      frictionSignals: synthesis.frictionSignals,
      primaryCta: synthesis.primaryCta,
      pagesRead: synthesis.pagesRead,
      meaning: 'not_observed signifie « cherché sur les pages lues et pas vu », jamais « absent »',
    },
    provider: 'website',
    method: 'derived',
    sourceUrl,
    confidence: 0.9,
    ...(observedAt ? { observedAt } : {}),
  };
}

/** Relit une synthèse persistée. Rend `null` si la ligne n'a pas la bonne forme. */
export function readFunnelSynthesis(valueJson: unknown): Pick<
  FunnelSynthesis,
  'observations' | 'opportunitySignals' | 'frictionSignals' | 'primaryCta' | 'pagesRead'
> | null {
  if (!valueJson || typeof valueJson !== 'object') return null;
  const value = valueJson as Record<string, unknown>;
  if (!Array.isArray(value['observations'])) return null;
  return {
    observations: value['observations'] as FunnelObservation[],
    opportunitySignals: Array.isArray(value['opportunitySignals'])
      ? (value['opportunitySignals'] as string[])
      : [],
    frictionSignals: Array.isArray(value['frictionSignals']) ? (value['frictionSignals'] as string[]) : [],
    primaryCta: typeof value['primaryCta'] === 'string' ? value['primaryCta'] : null,
    pagesRead: typeof value['pagesRead'] === 'number' ? value['pagesRead'] : 0,
  };
}

/** L'état d'une observation donnée, ou `not_checked` si la clé est absente. */
export function stateOf(
  observations: readonly FunnelObservation[],
  key: FunnelKey,
): FunnelObservationState {
  return observations.find((item) => item.key === key)?.state ?? 'not_checked';
}
