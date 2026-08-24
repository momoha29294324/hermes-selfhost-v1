import { assessChannelFits, selectChannel, type ChannelFit, type ChannelSelection } from '@/lib/pipeline/channelFit';
import {
  assessCommercialIntelligence,
  type CommercialIntelligenceResult,
} from '@/lib/pipeline/commercialIntelligence';
import { emailShape, observedContact, readCommercialFacts, type CommercialFacts } from '@/lib/pipeline/commercialSignals';
import { qualifyEvidence, type EvidenceQuality } from '@/lib/pipeline/evidenceQuality';
import { assessCoreActivity, type CoreActivityAssessment } from '@/lib/pipeline/coreActivity';
import { loadNiche } from '@/lib/config/load';
import { evaluateIcpEligibility, icpLockRefusal, type IcpAssessment, type IcpEvidenceLike } from '@/lib/pipeline/icpEligibility';
import {
  assessOutboundActionability,
  type OutboundActionabilityResult,
  type OutboundSuppression,
} from '@/lib/pipeline/outboundActionability';
import { scoreProspect, type EvidenceLike, type ScoreResult } from '@/lib/pipeline/score';
import {
  assessScalableOpportunity,
  partitionSocialReading,
  type AudienceObservation,
  type PaidAcquisitionReading,
  type ScalableOpportunityAssessment,
} from '@/lib/pipeline/scalableOpportunity';
import type { SocialChannelGap } from '@/lib/pipeline/socialAcquisitionGap';
import type { SocialMaturityResult } from '@/lib/pipeline/socialMaturity';
import { observedChannels, type CrmChannel } from '@/lib/crm/view';
import type { CommercialIntelligenceProfile, IcpProfile, ScoringProfile } from '@/lib/config/schema';
import type { ProspectRow } from '@/lib/repo/types';

/**
 * R7.1 — l'assemblage d'un prospect, ancien et nouveau côte à côte.
 *
 * Ce module ne décide de rien : il compose. Son unique raison d'être est que la
 * COMPARAISON soit calculée au même endroit que les deux valeurs comparées —
 * sans quoi un rapport pourrait affirmer une divergence que le moteur ne
 * produit pas.
 *
 * SHADOW, au sens strict : rien ici n'écrit. Ni `prospects.score`, ni
 * `score_band`, ni `outreach_recommendation`, ni un manifeste, ni une file.
 * L'ancien score est RECALCULÉ à partir de l'evidence pour être décomposable,
 * et il est vérifié contre la valeur stockée (`storedScoreMatches`) : si les
 * deux divergent, le rapport le dit plutôt que de laisser croire que la
 * comparaison porte sur ce qui est en base.
 */

export interface ShadowEvaluation {
  readonly prospect: ProspectRow;

  // — l'existant, tel qu'il est aujourd'hui —
  readonly currentScore: number | null;
  readonly currentBand: string | null;
  /** Le score recalculé depuis l'evidence, décomposé signal par signal. */
  readonly currentScoreRecomputed: ScoreResult;
  /** Faux quand le stocké et le recalculé diffèrent — une alerte, jamais un silence. */
  readonly storedScoreMatches: boolean;
  /** Les canaux observés, dans l'ordre où `bestChannel()` les classe aujourd'hui. */
  readonly currentObservedChannels: readonly CrmChannel[];
  /** Ce que `bestChannel()` retiendrait — c'est-à-dire le premier de la liste. */
  readonly currentBestChannel: CrmChannel | null;

  // — R7 —
  readonly facts: CommercialFacts;
  readonly icp: IcpAssessment | null;
  readonly intelligence: CommercialIntelligenceResult;
  readonly channelFits: readonly ChannelFit[];
  readonly channelSelection: ChannelSelection;
  /**
   * R7.3B — « peut-on faire un premier contact propre maintenant ? », séparé de
   * « est-ce un prospect intéressant ». Les deux vivent côte à côte ici, et
   * aucune des deux ne corrige l'autre.
   */
  readonly actionability: OutboundActionabilityResult;

  /**
   * R7.3C §23 — la maturité d'acquisition SOCIALE, tenue à côté de la maturité
   * web et jamais fondue dedans.
   *
   * `null` quand aucun profil Instagram n'a été observé pour ce prospect — ce qui
   * est le cas de la très grande majorité du corpus et n'est ni un score bas ni
   * un défaut. Publiée dans les deux modèles : Model A la porte SANS l'utiliser,
   * de sorte qu'un lecteur voie exactement ce que Model B ajoute.
   */
  readonly socialMaturity: SocialMaturityResult | null;

  /**
   * R7.6 — l'opportunité scalable, quand le round la demande.
   *
   * `null` en MODEL A/B/C : ces trois modèles ne l'évaluent pas, et le rapport
   * doit pouvoir le montrer plutôt que d'afficher une bande calculée qui
   * n'aurait influencé aucune décision.
   */
  readonly opportunity: ScalableOpportunityAssessment | null;

  /**
   * R7.7 — la qualité de la preuve, publiée à côté des axes qu'elle borne.
   *
   * `null` quand le round ne l'évalue pas : un rapport doit pouvoir montrer que
   * MODEL C et D n'en tenaient aucun compte, plutôt qu'afficher une mesure qui
   * n'a rien décidé.
   */
  readonly evidenceQuality: EvidenceQuality | null;
  /** R7.7 — l'activité déclarée par le cadre du site, quand le round la lit. */
  readonly coreActivity: CoreActivityAssessment | null;
  /** Les faits BRUTS, avant retrait des absences hors de portée. La relation du rail. */
  readonly rawFacts: CommercialFacts;
}

export interface ShadowInput {
  readonly prospect: ProspectRow;
  readonly evidence: readonly (EvidenceLike & { readonly id: string })[];
  readonly scoringProfile: ScoringProfile;
  readonly icpProfile: IcpProfile;
  readonly commercialProfile: CommercialIntelligenceProfile;
  /**
   * L'entrée de `do_not_contact` qui vise ce prospect, si elle existe.
   *
   * Fournie par l'appelant plutôt que lue ici : ce module reste pur, et la
   * suppression est un FAIT EN BASE, pas une déduction. Absente (`undefined`)
   * signifie « la question n'a pas été posée » et non « personne n'est
   * supprimé » — les deux se comportent pareil ici parce que la porte de
   * suppression réelle vit dans le chemin d'envoi (`r6bDispatcher`), qui la
   * relit systématiquement. Ce qu'on calcule ici est un rapport, jamais une
   * autorisation.
   */
  readonly suppression?: OutboundSuppression | null;
  /**
   * R7.3C §25/§42 — l'observation Instagram de ce prospect, si elle existe.
   *
   * Absente, tout se comporte comme avant R7.3C — c'est ce qui définit Model A.
   * Présente avec `blend > 0`, c'est Model B.
   *
   * `identityObserved` mérite d'être distingué du reste : c'est le seul canal par
   * lequel une collecte peut DÉBLOQUER un premier contact (§42). Le moteur
   * utilisait jusqu'ici un proxy — le handle partage-t-il un mot avec le nom de
   * l'entreprise ? Une observation qui a ouvert le profil et lu son nom
   * d'utilisateur est une preuve d'un autre ordre, et elle remplace le proxy
   * plutôt que de s'y ajouter. Une contradiction, elle, ferme la porte.
   */
  readonly social?: SocialShadowInput;
  /**
   * R7.6 — MODEL D. Absent, le moteur est mot pour mot celui de R7.4, et un test
   * l'exécute sur tout le corpus.
   *
   * Les deux corrections structurelles du round sont ARMABLES SÉPARÉMENT, et
   * ce n'est pas une commodité de test : le §16 de la mission interdit un
   * balayage et exige qu'un changement qui déplace une décision soit
   * interprétable. Deux interrupteurs nommés permettent de dire lequel des deux
   * a bougé quoi ; un seul drapeau « R7.6 » ne l'aurait jamais permis.
   */
  readonly opportunity?: OpportunityShadowInput;
  /**
   * R7.11 §16 — l'observation Paid de ce prospect, quand le rail un projet isole en a
   * produit une.
   *
   * Absente, l'évaluation est mot pour mot celle d'avant R7.11 : c'est la même
   * discipline que `social` et `opportunity`, et c'est ce qui permet de MESURER
   * ce que le signal déplace au lieu de l'affirmer. Ici, il ne déplace rien —
   * aucun score ne le lit — et un test l'exige.
   */
  readonly paid?: PaidAcquisitionReading;
  /**
   * R7.7 — MODEL E. Absent, le moteur est mot pour mot celui de R7.6, et un
   * test l'exécute sur tout le corpus.
   *
   * Deux interrupteurs séparés, pour la raison déjà écrite en R7.6 : le round
   * doit pouvoir dire lequel des deux défauts a déplacé quelle décision.
   */
  readonly evidencePolicy?: EvidenceShadowInput;
  /** Injectée : le moteur doit être rejouable, donc jamais dépendant de l'heure réelle. */
  readonly now: Date;
}

export interface EvidenceShadowInput {
  /**
   * Retirer les absences qu'une lecture de cette portée ne pouvait pas
   * établir — la correction du §4. Voir `evidenceQuality.ts`.
   */
  readonly scopedAbsence: boolean;
  /**
   * Lire l'activité déclarée dans le CADRE du site — la correction du §6. La
   * clé de niche est portée par l'appelant plutôt que devinée : un corpus
   * multi-campagnes n'a pas une seule niche.
   */
  readonly coreActivityNiche: string | null;
  /**
   * R7.7 — la porte DURE sur l'activité voisine seule, construite pour être
   * mesurée avant d'être jugée. Le round la mesure et ne l'arme pas : voir le
   * rapport. `false` par défaut ; un round ultérieur peut la reprendre.
   */
  readonly gateAdjacentOnly?: boolean;
}

export interface OpportunityShadowInput {
  /**
   * La porte d'éligibilité est-elle armée ?
   *
   * Elle ne peut que FERMER (`OUT_OF_SCOPE` ⇒ priorité 0), jamais ouvrir. Un
   * `REVIEW_REQUIRED` ou un `UNKNOWN` ne déplacent rien.
   */
  readonly gateEligibility: boolean;
  /**
   * Que le canal social a-t-il le droit de faire lire comme une ACQUISITION
   * DÉJÀ STRUCTURÉE ?
   *
   *   'full'            la maturité sociale complète de R7.3C — c'est MODEL B/C.
   *   'structure_only'  seulement la part « machinerie » (complétude, rubriques).
   *   'none'            rien. Le canal social ne fait plus monter la maturité.
   *
   * Trois valeurs plutôt qu'un booléen parce que le round doit pouvoir MONTRER
   * pourquoi il a choisi, et que les trois lectures ne se réfutent pas de la
   * même façon. Voir la documentation d’installation : `structure_only` a été
   * construite, mesurée, et REJETÉE — ce que `profile_completeness` mesure est
   * une bio remplie, pas un tunnel de conversion.
   */
  readonly socialAcquisitionStructure: 'full' | 'structure_only' | 'none';
}

export interface SocialShadowInput {
  readonly maturity: SocialMaturityResult;
  /** 0 → Model A. 1 → la maturité effective est le maximum des deux canaux. */
  readonly blend: number;
  /**
   * `true` : profil ouvert, nom d'utilisateur conforme au handle attendu.
   * `false` : contradiction d'identité constatée.
   * `null` : rien d'observable — on retombe sur le proxy ICP, sans le contredire.
   */
  readonly identityObserved: boolean | null;
  /**
   * R7.4 — l'écart d'acquisition sociale MESURÉ sur ce canal, ou `undefined`
   * quand le round ne l'évalue pas.
   *
   * Absent, l'évaluation est exactement Model B — c'est ce qui rend la
   * comparaison B/C lisible : un seul champ les sépare, et son absence rend le
   * moteur identique à ce qu'il était.
   */
  readonly gap?: SocialChannelGap;
  /**
   * R7.6 — l'audience LUE sur ce profil, et son attribution.
   *
   * Portée ici plutôt que dérivée du score social, parce que ce sont deux
   * questions distinctes : `SocialMaturityResult` répond « ce canal est-il
   * animé », le compteur d'abonnés répond « quelle taille ». Confondre les deux
   * est exactement l'erreur que le §6 de la mission demande d'éviter.
   */
  readonly audience?: AudienceObservation;
}

function toIcpEvidence(evidence: ShadowInput['evidence']): IcpEvidenceLike[] {
  return evidence.map((row) => ({
    id: row.id,
    field: row.field,
    valueText: row.value_text,
    valueJson: row.value_json,
    provider: row.provider,
    sourceUrl: row.source_url,
  }));
}

/**
 * Le handle observé est-il cohérent avec l'identité connue de l'entreprise ?
 *
 * La réponse existe déjà : `icpEligibility` produit un signal
 * `social_identity_mismatch` quand un handle ne partage aucun mot avec le nom,
 * l'enseigne, la raison sociale ou le domaine. Ce module le LIT plutôt que de
 * refaire la comparaison — deux implémentations de « est-ce bien eux » finiraient
 * par se contredire, et c'est la question sur laquelle une erreur coûte le plus
 * cher (écrire à un inconnu).
 *
 * `null` quand il n'y a pas de handle ou pas de verdict ICP : ne pas savoir
 * n'est pas savoir le contraire.
 */
function identityCorroboration(prospect: ProspectRow, icp: IcpAssessment | null): boolean | null {
  const handle = prospect.instagram_handle?.trim() ?? '';
  if (handle.length === 0) return null;
  if (icp === null) return null;
  return !icp.signals.some((signal) => signal.groupKey === 'social_identity_mismatch');
}

export function evaluateShadow(input: ShadowInput): ShadowEvaluation {
  const { prospect, evidence, now } = input;

  const currentScoreRecomputed = scoreProspect({
    prospect,
    evidence: [...evidence],
    profile: input.scoringProfile,
    now,
  });

  const icp = evaluateIcpEligibility({
    subject: {
      displayName: prospect.display_name,
      brandName: prospect.brand_name,
      legalName: prospect.legal_name,
      city: prospect.city,
      department: prospect.department,
      domain: prospect.domain,
      instagramHandle: prospect.instagram_handle,
    },
    evidence: toIcpEvidence(evidence),
    profile: input.icpProfile,
  });

  const rawFacts = readCommercialFacts(evidence);
  /**
   * R7.7 §4 — la portée des absences, appliquée AVANT tout calcul d'axe.
   *
   * Ici et pas dans `readCommercialFacts` : ce module-là doit rester la relation
   * fidèle de ce que les rails ont dit. Ce qu'on a le droit d'en conclure est une
   * seconde question, et la garder séparée est ce qui permet au rapport de
   * publier les deux — ce qui a été déclaré, et ce qui a été retenu.
   */
  const qualified = input.evidencePolicy?.scopedAbsence === true
    ? qualifyEvidence(rawFacts, input.commercialProfile.confidence)
    : null;
  const facts = qualified?.facts ?? rawFacts;
  const evidenceQuality = qualified?.quality ?? null;

  const coreActivity =
    input.evidencePolicy?.coreActivityNiche == null
      ? null
      : assessCoreActivity({
          evidence: evidence.map((row) => ({
            field: row.field,
            value_text: row.value_text,
            value_json: row.value_json,
          })),
          niche: loadNiche(input.evidencePolicy.coreActivityNiche),
        });

  const contact = observedContact(prospect);
  const email = emailShape(contact.email, contact.domain);

  /**
   * R7.6 — la partition organique / structure, calculée une fois et lue deux
   * fois : par la maturité effective (si le round la dé-confond) et par la
   * bande d'intention organique publiée. Elle ne RECALCULE rien : elle replie
   * les contributeurs déjà produits par `assessSocialMaturity`.
   */
  const socialPartition =
    input.social === undefined
      ? null
      : partitionSocialReading(input.social.maturity, input.commercialProfile.confidence);

  const opportunityOptions = input.opportunity;
  /**
   * R7.6 §7 — ce que le canal social a le droit de faire monter.
   *
   * `undefined` ⇒ le champ n'est pas transmis et le moteur lit la maturité
   * sociale complète, exactement comme R7.3C/R7.4.
   */
  const socialStructureScore: number | null | undefined =
    opportunityOptions === undefined || opportunityOptions.socialAcquisitionStructure === 'full'
      ? undefined
      : opportunityOptions.socialAcquisitionStructure === 'none'
        ? null
        : (socialPartition?.acquisitionStructure.score ?? null);

  const intelligence = assessCommercialIntelligence(
    {
      prospect,
      facts,
      email,
      icp,
      profile: input.commercialProfile,
      social:
        input.social === undefined
          ? undefined
          : {
              score: input.social.maturity.score,
              blend: input.social.blend,
              gap: input.social.gap,
              ...(socialStructureScore === undefined ? {} : { acquisitionStructureScore: socialStructureScore }),
            },
      ...(evidenceQuality === null && coreActivity === null
        ? {}
        : {
            evidence: {
              ...(evidenceQuality === null ? {} : { quality: evidenceQuality }),
              ...(coreActivity === null ? {} : { coreActivity }),
            },
          }),
      ...(opportunityOptions === undefined
        ? {}
        : {
            opportunityFor: (context) => {
              const assessment = assessScalableOpportunity({
                icp,
                ...(input.evidencePolicy?.gateAdjacentOnly === true && coreActivity !== null
                  ? { coreActivity }
                  : {}),
                socialMaturity: input.social?.maturity ?? null,
                audienceObservation: input.social?.audience ?? null,
                registryDateCreation: facts.registryAttributes['dateCreation'],
                funnelGap: context.need.score,
                abilityToPay: context.abilityToPay.score,
                ...(input.paid === undefined ? {} : { paid: input.paid }),
                config: input.commercialProfile.opportunity,
                confidence: input.commercialProfile.confidence,
                profileKey: input.commercialProfile.key,
                profileVersion: input.commercialProfile.version,
                now,
              });
              /**
               * La porte est ARMÉE PAR LE ROUND, pas par le module : rendre une
               * éligibilité neutralisée plutôt que ne rien rendre laisse les
               * bandes publiées et mesurables même quand la porte est désarmée.
               * C'est ce qui permet de compter, dans le rapport, combien de
               * prospects elle FERMERAIT avant de décider de l'armer.
               */
              return opportunityOptions.gateEligibility
                ? assessment
                : {
                    ...assessment,
                    eligibility:
                      assessment.eligibility.verdict === 'OUT_OF_SCOPE'
                        ? {
                            verdict: 'REVIEW_REQUIRED' as const,
                            reason: `porte d’éligibilité désarmée pour ce modèle — ${assessment.eligibility.reason}`,
                            reasons: assessment.eligibility.reasons,
                          }
                        : assessment.eligibility,
                  };
            },
          }),
    },
    now,
  );

  /**
   * Le proxy ICP reste la réponse par défaut ; l'observation le REMPLACE quand
   * elle a tranché. Elle ne s'y ajoute pas : deux avis sur « est-ce bien eux »
   * finiraient par se contredire, et c'est la question où une erreur coûte le
   * plus cher (écrire à un inconnu).
   */
  const identityCorroborated = input.social?.identityObserved ?? identityCorroboration(prospect, icp);
  const channelFits = assessChannelFits({
    contact,
    facts,
    email,
    profile: input.commercialProfile,
    identityCorroborated,
  });
  const channelSelection = selectChannel(channelFits, intelligence.decision, input.commercialProfile);

  const actionability = assessOutboundActionability({
    intelligence,
    selection: channelSelection,
    identity: {
      instagramCorroborated: identityCorroborated,
      icpLockRefusal: icp === null ? null : icpLockRefusal(icp),
    },
    suppression: input.suppression ?? null,
    profile: input.commercialProfile,
  });

  const observed = observedChannels({
    email: prospect.email,
    instagramHandle: prospect.instagram_handle,
    facebookUrl: prospect.facebook_url,
    phone: prospect.phone,
  });

  return {
    prospect,
    currentScore: prospect.score,
    currentBand: prospect.score_band,
    currentScoreRecomputed,
    storedScoreMatches: prospect.score === null || prospect.score === currentScoreRecomputed.total,
    currentObservedChannels: observed,
    currentBestChannel: observed[0] ?? null,
    facts,
    icp,
    intelligence,
    channelFits,
    channelSelection,
    actionability,
    socialMaturity: input.social?.maturity ?? null,
    /**
     * Ce qui est publié est ce qui a RÉELLEMENT décidé — porte désarmée
     * comprise. Republier l'évaluation « pure » à côté ferait croire à un
     * lecteur que la porte a joué là où elle était neutralisée.
     */
    opportunity: intelligence.opportunity,
    evidenceQuality,
    coreActivity,
    rawFacts,
  };
}

// ---------------------------------------------------------------------------
// Divergences — ce que la mission demande de compter
// ---------------------------------------------------------------------------

export type ChannelShift =
  | 'email_to_instagram'
  | 'instagram_to_email'
  | 'phone_to_instagram'
  | 'phone_to_email'
  | 'other_to_contact'
  | 'contact_to_none'
  | 'none_to_contact'
  | 'unchanged'
  | 'both_none';

/**
 * Le déplacement de canal entre l'existant et R7.
 *
 * « Existant » est ici `bestChannel()`, c'est-à-dire le premier canal observé.
 * Le comparer n'est pas une critique de son auteur : c'est la seule façon de
 * chiffrer combien de prospects changeraient de canal si la sélection devenait
 * une décision au lieu d'un ordre de tableau.
 *
 * R7.2 : la catégorie `to_phone` a disparu, puisque le téléphone n'est plus
 * sélectionnable (§1). Elle servait aussi, par erreur, de fourre-tout final —
 * un prospect passant de `phone` à `instagram` était compté « vers le
 * téléphone », c'est-à-dire l'inverse exact de ce qui s'était produit. Les
 * transitions sont donc nommées une par une, et la seule catégorie générique
 * restante dit ce qu'elle est.
 */
export function channelShift(evaluation: ShadowEvaluation): ChannelShift {
  const before = evaluation.currentBestChannel;
  const after = evaluation.channelSelection.selected;
  if (before === null && after === null) return 'both_none';
  if (before !== null && after === null) return 'contact_to_none';
  if (before === null && after !== null) return 'none_to_contact';

  const beforeKey =
    before === 'instagram_dm' ? 'instagram' : before === 'email' ? 'email' : before === 'phone' ? 'phone' : null;
  if (beforeKey === after) return 'unchanged';
  if (beforeKey === 'email' && after === 'instagram') return 'email_to_instagram';
  if (beforeKey === 'instagram' && after === 'email') return 'instagram_to_email';
  if (beforeKey === 'phone' && after === 'instagram') return 'phone_to_instagram';
  if (beforeKey === 'phone' && after === 'email') return 'phone_to_email';
  // `facebook_dm`, `whatsapp`, `sms`, `web_form` : observés par l'existant, sans
  // rail ici. Les nommer un par un donnerait des catégories toujours vides.
  return 'other_to_contact';
}

/** Les grandes divergences de rang, celles qu'un humain doit relire en premier. */
export type PriorityShift = 'high_to_low' | 'low_to_high' | 'stable' | 'now_unknown';

// ---------------------------------------------------------------------------
// Le jeu de calibration humaine (§22 / §28 de la mission)
// ---------------------------------------------------------------------------

export interface CalibrationEntry {
  readonly evaluation: ShadowEvaluation;
  /** Pourquoi ce prospect est dans le jeu. Un humain doit savoir ce qu'il relit. */
  readonly buckets: readonly string[];
}

/**
 * Choisit les ~30 cas que un opérateur doit relire pour trancher R7.2.
 *
 * La sélection est faite par PANIERS et non par le haut du classement, et c'est
 * le point : un jeu composé des trente meilleurs prospects ne peut confirmer
 * que ce que le modèle pense déjà. Pour corriger des poids, il faut aussi les
 * cas où il se trompe — donc les gros écarts dans les deux sens, les sites
 * forts comme les faibles, et les deux configurations de canal.
 *
 * Entièrement déterministe : à corpus égal, même jeu. Les égalités sont
 * tranchées par `id`, jamais par l'ordre d'arrivée des lignes.
 */
export function selectCalibrationSet(
  evaluations: readonly ShadowEvaluation[],
  options: { readonly currentHighBand: number; readonly perBucket: number } = {
    currentHighBand: 72,
    perBucket: 4,
  },
): CalibrationEntry[] {
  const byId = (a: ShadowEvaluation, b: ShadowEvaluation): number => a.prospect.id.localeCompare(b.prospect.id);
  const stable =
    (rank: (item: ShadowEvaluation) => number) =>
    (a: ShadowEvaluation, b: ShadowEvaluation): number => {
      const delta = rank(b) - rank(a);
      return delta !== 0 ? delta : byId(a, b);
    };

  const scored = evaluations.filter((item) => item.currentScore !== null);
  const withPriority = evaluations.filter((item) => item.intelligence.commercialPriority !== null);
  const siteRead = evaluations.filter((item) => item.facts.siteRead && item.facts.websiteQuality !== null);

  const byCurrentScore = [...scored].sort(stable((item) => item.currentScore ?? 0));
  const middle = Math.max(0, Math.floor(byCurrentScore.length / 2) - Math.floor(options.perBucket / 2));

  const buckets: Array<{ label: string; items: ShadowEvaluation[] }> = [
    { label: 'score historique haut', items: byCurrentScore.slice(0, options.perBucket) },
    { label: 'score historique médian', items: byCurrentScore.slice(middle, middle + options.perBucket) },
    { label: 'score historique bas', items: byCurrentScore.slice(-options.perBucket) },
    {
      label: 'Instagram + email',
      items: evaluations
        .filter((item) => item.prospect.instagram_handle !== null && item.prospect.email !== null)
        .sort(stable((item) => item.intelligence.commercialPriority ?? -1))
        .slice(0, options.perBucket),
    },
    {
      label: 'Instagram seul',
      items: evaluations
        .filter((item) => item.prospect.instagram_handle !== null && item.prospect.email === null)
        .sort(stable((item) => item.intelligence.commercialPriority ?? -1))
        .slice(0, options.perBucket),
    },
    {
      label: 'email seul',
      items: evaluations
        .filter((item) => item.prospect.email !== null && item.prospect.instagram_handle === null)
        .sort(stable((item) => item.intelligence.commercialPriority ?? -1))
        .slice(0, options.perBucket),
    },
    {
      label: 'site solide',
      items: [...siteRead].sort(stable((item) => item.facts.websiteQuality ?? 0)).slice(0, options.perBucket),
    },
    {
      label: 'site faible',
      items: [...siteRead].sort(stable((item) => -(item.facts.websiteQuality ?? 0))).slice(0, options.perBucket),
    },
    {
      label: 'acquisition très mature',
      items: [...evaluations]
        .filter((item) => item.intelligence.axes.acquisitionMaturity.score !== null)
        .sort(stable((item) => item.intelligence.axes.acquisitionMaturity.score ?? 0))
        .slice(0, options.perBucket),
    },
    {
      label: 'grosse chute de priorité',
      items: [...withPriority]
        .filter((item) => priorityShift(item, options.currentHighBand) === 'high_to_low')
        .sort(stable((item) => (item.currentScore ?? 0) - (item.intelligence.commercialPriority ?? 0)))
        .slice(0, options.perBucket),
    },
    {
      label: 'grosse montée de priorité',
      items: [...withPriority]
        .filter((item) => priorityShift(item, options.currentHighBand) === 'low_to_high')
        .sort(stable((item) => (item.intelligence.commercialPriority ?? 0) - (item.currentScore ?? 0)))
        .slice(0, options.perBucket),
    },
    {
      label: 'changement de canal',
      items: [...withPriority]
        .filter((item) => {
          const shift = channelShift(item);
          return (
            shift === 'email_to_instagram' ||
            shift === 'instagram_to_email' ||
            shift === 'phone_to_instagram' ||
            shift === 'phone_to_email' ||
            shift === 'other_to_contact'
          );
        })
        .sort(stable((item) => item.intelligence.commercialPriority ?? 0))
        .slice(0, options.perBucket),
    },
  ];

  const chosen = new Map<string, { evaluation: ShadowEvaluation; buckets: string[] }>();
  for (const bucket of buckets) {
    for (const item of bucket.items) {
      const existing = chosen.get(item.prospect.id);
      if (existing === undefined) chosen.set(item.prospect.id, { evaluation: item, buckets: [bucket.label] });
      else existing.buckets.push(bucket.label);
    }
  }

  return [...chosen.values()]
    .map((entry) => ({ evaluation: entry.evaluation, buckets: entry.buckets }))
    .sort((a, b) => {
      const delta =
        (b.evaluation.intelligence.commercialPriority ?? -1) - (a.evaluation.intelligence.commercialPriority ?? -1);
      return delta !== 0 ? delta : a.evaluation.prospect.id.localeCompare(b.evaluation.prospect.id);
    });
}

export function priorityShift(evaluation: ShadowEvaluation, currentHighBand: number): PriorityShift {
  const current = evaluation.currentScore;
  const next = evaluation.intelligence.commercialPriority;
  if (next === null) return 'now_unknown';
  if (current === null) return 'stable';
  const wasHigh = current >= currentHighBand;
  const isHigh = evaluation.intelligence.decision === 'PRIORITIZE';
  if (wasHigh && !isHigh) return 'high_to_low';
  if (!wasHigh && isHigh) return 'low_to_high';
  return 'stable';
}
