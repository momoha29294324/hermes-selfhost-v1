import { readFunnelSynthesis, stateOf, type FunnelObservation } from '@/lib/pipeline/funnel';
import type { ScoringProfile } from '@/lib/config/schema';
import type { ProspectRow } from '@/lib/repo/types';

/**
 * Scoring is deliberately boring: every point comes from an observation we can
 * point at. The LLM never returns "the score"; it may only contribute a small,
 * separately-capped qualitative adjustment, and the two are stored apart.
 *
 * Missing observations are not penalised by default (`onMissing: neutral`): the
 * signal leaves the denominator instead of counting as zero, because "we did not
 * observe it" is not the same claim as "it does not exist". To stop thin profiles
 * from scoring like rich ones, a coverage cap applies when too little was observed.
 */

export interface EvidenceLike {
  id?: string;
  field: string;
  value_text: string | null;
  value_json: unknown;
  provider: string;
  source_url: string | null;
}

export interface SignalResult {
  key: string;
  label: string;
  observed: boolean;
  ratio: number | null;
  points: number;
  max: number;
  detail: string;
  evidenceFields: string[];
}

export interface LlmObservation {
  key: string;
  label: string;
  /** -1..1 — how much this qualitative read argues for the prospect. */
  direction: number;
  rationale: string;
}

export interface ScoreResult {
  total: number;
  band: 'A' | 'B' | 'C' | 'D';
  signals: SignalResult[];
  missingSignals: string[];
  coverage: number;
  coverageCapped: boolean;
  llmPoints: number;
  llmObservations: LlmObservation[];
  weights: Record<string, number>;
}

function evidenceByField(evidence: EvidenceLike[]): Map<string, EvidenceLike[]> {
  const map = new Map<string, EvidenceLike[]>();
  for (const item of evidence) {
    const list = map.get(item.field) ?? [];
    list.push(item);
    map.set(item.field, list);
  }
  return map;
}

function providerAttributes(evidence: EvidenceLike[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const item of evidence) {
    if (item.field !== 'provider_attributes') continue;
    const value = item.value_json;
    if (value && typeof value === 'object') Object.assign(merged, value as Record<string, unknown>);
  }
  return merged;
}

function ratioFromJson(items: EvidenceLike[] | undefined): number | null {
  if (!items || items.length === 0) return null;
  for (const item of items) {
    const value = item.value_json as { ratio?: unknown } | null;
    if (value && typeof value.ratio === 'number') return Math.max(0, Math.min(1, value.ratio));
  }
  return null;
}

function yearsSince(dateIso: string | null | undefined, now: Date): number | null {
  if (!dateIso) return null;
  const date = new Date(dateIso);
  if (Number.isNaN(date.getTime())) return null;
  return (now.getTime() - date.getTime()) / (365.25 * 24 * 3600 * 1000);
}

export interface ScoreInput {
  prospect: ProspectRow;
  evidence: EvidenceLike[];
  profile: ScoringProfile;
  llmObservations?: LlmObservation[];
  now?: Date;
}

export function scoreProspect(input: ScoreInput): ScoreResult {
  const { prospect, evidence, profile } = input;
  const now = input.now ?? new Date();
  const byField = evidenceByField(evidence);
  const attributes = providerAttributes(evidence);

  const compute: Record<string, () => { ratio: number | null; detail: string; fields: string[] }> = {
    niche_fit: () => {
      const verdict = prospect.niche_verdict;
      const confidence = prospect.niche_confidence ?? 0;
      if (!verdict) return { ratio: null, detail: 'non classifié', fields: [] };
      const base = verdict === 'in_niche' ? 1 : verdict === 'adjacent' ? 0.4 : verdict === 'uncertain' ? 0.2 : 0;
      return {
        ratio: base * Math.max(0.5, confidence),
        detail: `${verdict} (confiance ${confidence.toFixed(2)})`,
        fields: ['niche_verdict'],
      };
    },

    business_maturity: () => {
      const years = yearsSince(attributes['dateCreation'] as string | null, now);
      if (years === null) return { ratio: null, detail: 'date de création non observée', fields: [] };
      const ratio = years < 0.5 ? 0.15 : years < 1 ? 0.35 : years < 3 ? 0.7 : years < 10 ? 1 : 0.9;
      return { ratio, detail: `créée il y a ${years.toFixed(1)} an(s)`, fields: ['provider_attributes'] };
    },

    employer_status: () => {
      const tranche = attributes['trancheEffectif'];
      const nature = String(attributes['natureJuridique'] ?? '');
      const isCompany = nature.startsWith('5') || nature.startsWith('6');
      if ((tranche === undefined || tranche === null || tranche === 'NN') && !nature) {
        return { ratio: null, detail: 'effectif et forme juridique non observés', fields: [] };
      }
      const code = String(tranche ?? 'NN');
      const hasEmployees = code !== 'NN' && code !== '00';
      const ratio = hasEmployees ? 1 : isCompany ? 0.6 : 0.3;
      return {
        ratio,
        detail: hasEmployees
          ? `salariés déclarés (tranche INSEE ${code})`
          : isCompany
            ? 'société sans salarié déclaré'
            : 'entrepreneur individuel / effectif non déclaré',
        fields: ['provider_attributes'],
      };
    },

    website_presence: () => {
      if (prospect.domain) return { ratio: 1, detail: prospect.domain, fields: ['website_url'] };
      const noSource = byField.get('website_lookup')?.[0];
      if (noSource) return { ratio: null, detail: String(noSource.value_text ?? 'recherche indisponible'), fields: ['website_lookup'] };
      return { ratio: null, detail: 'aucune source de site web disponible', fields: [] };
    },

    website_quality: () => {
      const ratio = ratioFromJson(byField.get('website_quality'));
      if (ratio === null) return { ratio: null, detail: 'site non analysé', fields: [] };
      const reasons = (byField.get('website_quality')?.[0]?.value_json as { reasons?: string[] } | null)?.reasons ?? [];
      return { ratio, detail: reasons.join(', ') || `${Math.round(ratio * 100)}%`, fields: ['website_quality'] };
    },

    cta_quality: () => {
      const ratio = ratioFromJson(byField.get('cta_quality'));
      if (ratio === null) return { ratio: null, detail: 'CTA non analysé', fields: [] };
      const reasons = (byField.get('cta_quality')?.[0]?.value_json as { reasons?: string[] } | null)?.reasons ?? [];
      return { ratio, detail: reasons.join(', ') || `${Math.round(ratio * 100)}%`, fields: ['cta_quality'] };
    },

    booking_system: () => {
      const booking = byField.get('booking_system');
      if (booking && booking.length > 0) {
        return { ratio: 1, detail: `réservation en ligne (${booking[0]?.value_text ?? 'détectée'})`, fields: ['booking_system'] };
      }
      // Only claim absence when we actually read the site.
      if ((byField.get('website_quality')?.length ?? 0) > 0) {
        return { ratio: 0, detail: 'aucun système de réservation détecté sur les pages lues', fields: ['website_quality'] };
      }
      return { ratio: null, detail: 'non vérifiable (site non lu)', fields: [] };
    },

    social_presence: () => {
      const instagram = Boolean(prospect.instagram_handle);
      const facebook = Boolean(prospect.facebook_url);
      if (!instagram && !facebook) {
        const crawled = (byField.get('website_quality')?.length ?? 0) > 0;
        return crawled
          ? { ratio: 0, detail: 'aucun lien social trouvé sur les pages lues', fields: ['website_quality'] }
          : { ratio: null, detail: 'réseaux sociaux non vérifiés', fields: [] };
      }
      const ratio = instagram && facebook ? 1 : instagram ? 0.8 : 0.5;
      return {
        ratio,
        detail: [instagram ? `Instagram @${prospect.instagram_handle}` : null, facebook ? 'Facebook' : null]
          .filter(Boolean)
          .join(' + '),
        fields: [instagram ? 'instagram_handle' : 'facebook_url'],
      };
    },

    reviews: () => {
      const count = prospect.google_review_count;
      const rating = prospect.google_rating;
      if (count == null && rating == null) return { ratio: null, detail: 'avis non collectés', fields: [] };
      const volume = count == null ? 0.5 : Math.min(1, Math.log10(count + 1) / 2);
      const quality = rating == null ? 0.5 : Math.max(0, Math.min(1, (rating - 3) / 2));
      return {
        ratio: 0.5 * volume + 0.5 * quality,
        detail: `${count ?? '?'} avis, note ${rating ?? '?'}`,
        fields: ['google_review_count'],
      };
    },

    premium_services: () => {
      const premium = byField.get('premium_services');
      if (!premium || premium.length === 0) {
        if ((byField.get('website_quality')?.length ?? 0) > 0) {
          return { ratio: 0.15, detail: 'aucune prestation premium citée sur les pages lues', fields: ['website_quality'] };
        }
        return { ratio: null, detail: 'prestations non observées', fields: [] };
      }
      const terms = (premium[0]?.value_json as string[] | null) ?? [];
      return {
        ratio: Math.min(1, 0.4 + 0.15 * terms.length),
        detail: terms.slice(0, 4).join(', '),
        fields: ['premium_services'],
      };
    },

    /**
     * Bloc A — l'entreprise existe-t-elle commercialement ?
     *
     * Pas « est-elle grosse » : « vend-elle ». Un artisan seul avec un site lu,
     * des prestations nommées et un compte actif est plus réel qu'une société
     * de dix ans dont nous n'avons jamais rien pu observer. Le signal additionne
     * donc des preuves d'activité, pas des attributs de taille — et il n'existe
     * pas si rien n'a été observé, plutôt que de valoir zéro.
     */
    business_activity: () => {
      const crawled = (byField.get('website_quality')?.length ?? 0) > 0;
      const services = (byField.get('services')?.[0]?.value_json as string[] | null) ?? [];
      const proofs: string[] = [];
      let points = 0;

      if (prospect.niche_verdict === 'in_niche') {
        points += 0.3;
        proofs.push('classée dans la niche');
      } else if (prospect.niche_verdict === 'adjacent') {
        points += 0.12;
        proofs.push('métier adjacent');
      }
      if (crawled) {
        points += 0.25;
        proofs.push('site ouvert et lu');
      }
      if (services.length >= 3) {
        points += 0.2;
        proofs.push(`${services.length} prestations nommées`);
      } else if (services.length > 0) {
        points += 0.1;
        proofs.push(`${services.length} prestation(s) nommée(s)`);
      }
      if (prospect.instagram_handle || prospect.facebook_url) {
        points += 0.15;
        proofs.push('présence sociale identifiée');
      }
      if ((prospect.google_review_count ?? 0) > 0) {
        points += 0.1;
        proofs.push(`${prospect.google_review_count} avis publics`);
      }

      if (proofs.length === 0) return { ratio: null, detail: 'aucune activité observée', fields: [] };
      return { ratio: Math.min(1, points), detail: proofs.join(', '), fields: ['website_quality', 'services'] };
    },

    /**
     * Bloc B — l'offre commerciale.
     *
     * Ce que l'entreprise vend, et si elle le dit. Le panier moyen probable
     * compte (une boutique en ligne n'est pas un prestation), mais la lisibilité de l'offre
     * compte autant : une entreprise qui ne nomme pas ses prestations ne peut
     * pas être vendue par de l'acquisition tant que ce n'est pas réglé.
     */
    commercial_offer: () => {
      const funnel = readFunnelSynthesis(byField.get('funnel_synthesis')?.[0]?.value_json);
      const services = (byField.get('services')?.[0]?.value_json as string[] | null) ?? [];
      const premium = (byField.get('premium_services')?.[0]?.value_json as string[] | null) ?? [];
      const crawled = (byField.get('website_quality')?.length ?? 0) > 0;

      if (!crawled && services.length === 0) {
        return { ratio: null, detail: 'offre non observée (site non lu)', fields: [] };
      }

      const reasons: string[] = [];
      let points = 0;
      if (services.length >= 3) {
        points += 0.35;
        reasons.push(`offre segmentée (${services.slice(0, 3).join(', ')})`);
      } else if (services.length > 0) {
        points += 0.15;
        reasons.push('offre peu segmentée');
      }
      if (premium.length > 0) {
        points += Math.min(0.35, 0.2 + 0.05 * premium.length);
        reasons.push(`prestations premium (${premium.slice(0, 3).join(', ')})`);
      }
      if (funnel && stateOf(funnel.observations, 'price_visibility') === 'observed') {
        points += 0.15;
        reasons.push('tarifs affichés');
      }
      if (funnel && stateOf(funnel.observations, 'visible_offer') === 'observed') {
        points += 0.15;
        reasons.push('offre lisible en titre');
      }

      return {
        ratio: Math.min(1, points),
        detail: reasons.join(', ') || 'aucune prestation lisible sur les pages lues',
        fields: ['services', 'premium_services', 'funnel_synthesis'],
      };
    },

    /**
     * Bloc C — l'opportunité de parcours. Le signal le plus lourd de R5.
     *
     * Et le seul dont le sens est inversé : **plus le parcours est faible, plus
     * le score monte.** Ce n'est pas une bizarrerie, c'est la définition de
     * notre marché. Une entreprise qui vend déjà bien, avec réservation en
     * ligne, tarifs affichés et devis automatisé, n'a pas besoin de nous. Une
     * entreprise qui vend malgré un site sans le moindre chemin de conversion a
     * une marge de progression que nous savons chiffrer et adresser.
     *
     * La condition d'existence est absolue : `null` si le parcours n'a pas été
     * observé. Sans elle, un site jamais ouvert obtiendrait le score maximal
     * d'opportunité — « aucun funnel observé » deviendrait « aucun funnel »,
     * exactement l'affirmation d'absence que le §10 interdit.
     */
    funnel_opportunity: () => {
      const funnel = readFunnelSynthesis(byField.get('funnel_synthesis')?.[0]?.value_json);
      if (!funnel || funnel.pagesRead === 0) {
        return { ratio: null, detail: 'parcours non observé — le site n’a pas été lu', fields: [] };
      }

      const observations: FunnelObservation[] = funnel.observations;
      const gaps: string[] = [];
      let points = 0;

      if (stateOf(observations, 'booking_system') === 'not_observed') {
        points += 0.25;
        gaps.push('aucune réservation en ligne');
      }
      if (stateOf(observations, 'quote_form') === 'not_observed') {
        points += 0.2;
        gaps.push('aucune demande de devis');
      }
      if (stateOf(observations, 'price_visibility') === 'not_observed') {
        points += 0.15;
        gaps.push('aucun tarif visible');
      }
      if (stateOf(observations, 'primary_cta') === 'not_observed') {
        points += 0.15;
        gaps.push('aucun appel à l’action');
      }
      if (stateOf(observations, 'phone_only') === 'observed') {
        points += 0.15;
        gaps.push('conversion par téléphone seul');
      }
      if (stateOf(observations, 'conversion_friction') === 'observed') {
        points += 0.1;
        gaps.push('frein de conversion observé');
      }
      if (stateOf(observations, 'unclear_next_step') === 'observed') {
        points += 0.15;
        gaps.push('aucun chemin identifiable');
      }
      if (stateOf(observations, 'trust_signals') === 'not_observed') {
        points += 0.05;
        gaps.push('aucune preuve sociale');
      }

      return {
        ratio: Math.min(1, points),
        detail:
          gaps.length > 0
            ? `${gaps.join(', ')} (${funnel.pagesRead} page(s) lue(s))`
            : `parcours complet observé sur ${funnel.pagesRead} page(s) : peu de marge`,
        fields: ['funnel_synthesis'],
      };
    },

    /**
     * Bloc D — la capacité commerciale probable.
     *
     * « Probable » est le mot juste et il est tenu : rien ici n'affirme qu'une
     * entreprise peut payer. Ancienneté, forme juridique, effectif déclaré,
     * panier moyen des prestations et volume d'avis sont des indices, chacun
     * faillible, dont la somme situe un ordre de grandeur.
     *
     * Le nombre d'abonnés n'y figure pas, et n'y figurera pas : le §12 l'exclut
     * nommément, et `tests/score.test.ts` en fait une propriété testée.
     */
    commercial_capacity: () => {
      const years = yearsSince(attributes['dateCreation'] as string | null, now);
      const tranche = String(attributes['trancheEffectif'] ?? 'NN');
      const nature = String(attributes['natureJuridique'] ?? '');
      const premium = (byField.get('premium_services')?.[0]?.value_json as string[] | null) ?? [];
      const reviews = prospect.google_review_count;

      const reasons: string[] = [];
      let points = 0;
      let observedAnything = false;

      if (years !== null) {
        observedAnything = true;
        const maturity = years < 1 ? 0.1 : years < 3 ? 0.25 : 0.35;
        points += maturity;
        reasons.push(`${years.toFixed(1)} an(s) d’existence`);
      }
      if (tranche !== 'NN' && tranche !== '00') {
        observedAnything = true;
        points += 0.25;
        reasons.push(`salariés déclarés (tranche INSEE ${tranche})`);
      } else if (nature.startsWith('5') || nature.startsWith('6')) {
        observedAnything = true;
        points += 0.15;
        reasons.push('société sans salarié déclaré');
      }
      if (premium.length > 0) {
        observedAnything = true;
        points += Math.min(0.25, 0.1 + 0.05 * premium.length);
        reasons.push(`panier moyen élevé (${premium.slice(0, 2).join(', ')})`);
      }
      if (reviews != null && reviews > 0) {
        observedAnything = true;
        points += Math.min(0.2, Math.log10(reviews + 1) / 10);
        reasons.push(`${reviews} avis publics`);
      }

      if (!observedAnything) {
        return { ratio: null, detail: 'aucun indice de capacité observé', fields: [] };
      }
      return {
        ratio: Math.min(1, points),
        detail: reasons.join(', '),
        fields: ['provider_attributes', 'premium_services'],
      };
    },

    contactability: () => {
      const channels = [
        prospect.phone ? 'téléphone' : null,
        prospect.email ? 'email' : null,
        prospect.instagram_handle ? 'Instagram' : null,
        prospect.website_url ? 'site' : null,
      ].filter(Boolean) as string[];
      if (channels.length === 0) return { ratio: 0, detail: 'aucun canal de contact public trouvé', fields: [] };
      return { ratio: Math.min(1, channels.length / 3), detail: channels.join(', '), fields: ['phone', 'email'] };
    },
  };

  const signals: SignalResult[] = [];
  const missingSignals: string[] = [];
  const weights: Record<string, number> = {};
  let earned = 0;
  let applicable = 0;
  let totalWeight = 0;

  for (const config of profile.signals) {
    weights[config.key] = config.weight;
    totalWeight += config.weight;
    const computer = compute[config.key];
    const outcome = computer
      ? computer()
      : { ratio: null, detail: `signal "${config.key}" non implémenté`, fields: [] };

    const observed = outcome.ratio !== null;
    if (!observed) missingSignals.push(config.key);

    const effectiveRatio = observed ? outcome.ratio! : config.onMissing === 'zero' ? 0 : null;
    const counted = effectiveRatio !== null;
    const points = counted ? effectiveRatio * config.weight : 0;

    if (counted) {
      earned += points;
      applicable += config.weight;
    }

    signals.push({
      key: config.key,
      label: config.label,
      observed,
      ratio: outcome.ratio,
      points: Math.round(points * 100) / 100,
      max: config.weight,
      detail: outcome.detail,
      evidenceFields: outcome.fields,
    });
  }

  const llmObservations = input.llmObservations ?? [];
  const llmDirection =
    llmObservations.length === 0
      ? 0
      : llmObservations.reduce((sum, obs) => sum + Math.max(-1, Math.min(1, obs.direction)), 0) /
        llmObservations.length;
  const llmPoints = Math.round(((llmDirection + 1) / 2) * profile.llmObservationWeight * 100) / 100;

  const base = applicable > 0 ? (earned / applicable) * 100 : 0;
  const coverage = totalWeight > 0 ? applicable / totalWeight : 0;

  let total = Math.round(
    (base * (100 - profile.llmObservationWeight)) / 100 + (llmObservations.length > 0 ? llmPoints : (base * profile.llmObservationWeight) / 100),
  );

  // Thin evidence must not masquerade as a strong prospect.
  const coverageCapped = coverage < 0.5;
  if (coverageCapped) total = Math.min(total, 70);
  total = Math.max(0, Math.min(100, total));

  const band: ScoreResult['band'] =
    total >= profile.bands.a ? 'A' : total >= profile.bands.b ? 'B' : total >= profile.bands.c ? 'C' : 'D';

  return {
    total,
    band,
    signals,
    missingSignals,
    coverage: Math.round(coverage * 100) / 100,
    coverageCapped,
    llmPoints,
    llmObservations,
    weights,
  };
}
