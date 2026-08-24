import { assessSocialChannelGap, type SocialChannelGap } from '@/lib/pipeline/socialAcquisitionGap';
import { assessSocialMaturity, notCollectedSocialMaturity, type SocialMaturityResult } from '@/lib/pipeline/socialMaturity';
import { deriveVisualMaturity, type VisualMaturityVerdict } from '@/lib/pipeline/visualMaturityRubric';
import type { InstagramArtifactStore } from '@/lib/pipeline/instagramArtifactStore';
import type { ProfileObservation } from '@/lib/pipeline/instagramObservation';
import type { SocialShadowInput } from '@/lib/pipeline/commercialShadow';
import type { SocialMaturityProfile } from '@/lib/config/schema';

/**
 * R7.3C §25/§36/§42 — la couche qui transforme des OBSERVATIONS en entrée de
 * modèle, et rien d'autre.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi ce module existe séparément de la collecte
 * ---------------------------------------------------------------------------
 * Parce que le §36 l'exige et que c'est ce qui rend la calibration possible :
 * un même fichier d'observations doit produire exactement le même résultat R7,
 * autant de fois qu'on veut, sans rouvrir un seul profil. Tout ce qui est ici
 * est PUR — pas de réseau, pas de navigateur, pas d'horloge implicite.
 *
 * Conséquence pratique : balayer dix valeurs de `blend` coûte dix évaluations en
 * mémoire et zéro visite chez Instagram.
 */

export interface SocialInputs {
  readonly byProspect: ReadonlyMap<string, SocialShadowInput>;
  readonly maturityByProspect: ReadonlyMap<string, SocialMaturityResult>;
  readonly visualByProspect: ReadonlyMap<string, VisualMaturityVerdict>;
  /** R7.4 — l'écart mesuré, publié à part pour être lu même quand il n'est pas armé. */
  readonly gapByProspect: ReadonlyMap<string, SocialChannelGap>;
  readonly observations: readonly ProfileObservation[];
}

/**
 * §42 — quand une observation CORROBORE-t-elle une identité ?
 *
 * La réponse est étroite, et elle doit l'être : c'est le seul chemin par lequel
 * une collecte peut débloquer un premier contact commercial.
 *
 *   MATCH            le compte visé a été ouvert ET ce qu'il affiche rattache
 *                    ce compte à cette entreprise → `true` ;
 *   CONTRADICTION    un autre compte → `false`, la porte se ferme ;
 *   UNCORROBORATED   le compte visé, mais rien ne le rattache au prospect →
 *                    `null`. Ni corroboré, ni contredit : on retombe sur le
 *                    proxy ICP, sans rien affirmer ;
 *   UNREADABLE       `null` pour la même raison.
 *
 * Un état de collecte qui n'a pas permis de lire le profil rend `null` lui
 * aussi : un compte privé reste un compte dont on n'a pas vérifié l'identité.
 */
export function identityCorroborationOf(observation: ProfileObservation): boolean | null {
  if (observation.identity.verdict === 'CONTRADICTION') return false;
  if (observation.identity.verdict !== 'MATCH') return null;
  if (observation.state === 'OBSERVED' || observation.state === 'PARTIAL') return true;
  return null;
}

export interface BuildSocialInputsOptions {
  readonly store: InstagramArtifactStore;
  readonly profile: SocialMaturityProfile;
  readonly blend: number;
  readonly now: Date;
  /** Force l'inclusion (ou l'exclusion) de la maturité visuelle, pour comparer les deux. */
  readonly includeVisualMaturity?: boolean;
  /**
   * R7.4 — l'écart d'acquisition sociale est-il TRANSMIS au moteur ?
   *
   * `false` par défaut, et c'est la définition de Model B : l'écart est mesuré
   * et publié dans `gapByProspect` — donc lisible dans un rapport — mais il
   * n'entre dans aucune évaluation. Passer à `true` ne suffit d'ailleurs pas :
   * le profil commercial doit AUSSI donner un poids au contributeur.
   */
  readonly withGap?: boolean;
}

/**
 * Lit l'artefact et compose, pour chaque prospect observé, ce que Model B
 * recevra.
 *
 * Les prospects SANS observation n'apparaissent pas dans la table : `evaluateCorpus`
 * leur passera `undefined`, et ils seront donc évalués exactement comme en
 * Model A. C'est le tri-état appliqué à une source de plus — un prospect jamais
 * collecté ne monte ni ne descend.
 */
export function buildSocialInputs(options: BuildSocialInputsOptions): SocialInputs {
  const { observations } = options.store.readObservations();
  const reviews = options.store.readVisualReviews();

  const byProspect = new Map<string, SocialShadowInput>();
  const maturityByProspect = new Map<string, SocialMaturityResult>();
  const visualByProspect = new Map<string, VisualMaturityVerdict>();
  const gapByProspect = new Map<string, SocialChannelGap>();

  const config = {
    key: options.profile.key,
    version: options.profile.version,
    weights: options.profile.weights,
    confidence: options.profile.confidence,
    includeVisualMaturity: options.includeVisualMaturity ?? options.profile.includeVisualMaturity,
    minimumCoverage: options.profile.minimumCoverage,
  };

  for (const observation of observations) {
    /**
     * La revue visuelle est retrouvée par l'EMPREINTE de la capture, jamais par
     * le prospect : une revue ne peut donc pas survivre à l'image qui l'a
     * produite. Une nouvelle collecte crée une nouvelle capture, donc exige une
     * nouvelle revue — et jusque-là, `visual_maturity` vaut `UNKNOWN`.
     */
    const sha = observation.screenshot?.sha256 ?? null;
    const review = sha === null ? undefined : reviews.get(sha);
    const visual = review === undefined ? null : deriveVisualMaturity(review);
    if (visual !== null) visualByProspect.set(observation.prospectId, visual);

    const maturity = assessSocialMaturity({
      observation,
      visualMaturity: visual?.level ?? null,
      config,
      now: options.now,
    });
    maturityByProspect.set(observation.prospectId, maturity);

    /**
     * R7.4 — l'écart est mesuré POUR TOUT LE MONDE, et transmis seulement si le
     * round le demande. Un rapport peut ainsi montrer ce que le moteur ignore,
     * ce qui est la seule façon de juger un signal avant de l'armer.
     */
    const gap = assessSocialChannelGap({ observation, profile: options.profile, now: options.now });
    gapByProspect.set(observation.prospectId, gap);

    /**
     * R7.6 — l'audience LUE, et son droit d'être attribuée.
     *
     * Les deux champs sont portés séparément parce qu'ils répondent à deux
     * questions : « qu'a-t-on lu » et « à qui cela appartient-il ». Le corpus
     * porte le cas qui l'exige — un profil à 308 000 abonnés dont l'identité est
     * `UNCORROBORATED` : le compteur est parfaitement lisible, et il n'est pas
     * celui de ce prospect. `attributed: false` le laisse donc `UNKNOWN` au lieu
     * d'en faire une marque nationale.
     */
    byProspect.set(observation.prospectId, {
      maturity,
      blend: options.blend,
      identityObserved: identityCorroborationOf(observation),
      audience: {
        followers: observation.facts.followersCount?.value ?? null,
        attributed: observation.identity.verdict === 'MATCH',
      },
      ...(options.withGap === true ? { gap } : {}),
    });
  }

  return { byProspect, maturityByProspect, visualByProspect, gapByProspect, observations };
}

/** L'axe social d'un prospect, observé ou non. Jamais `undefined` pour l'affichage. */
export function socialMaturityFor(
  inputs: SocialInputs,
  prospectId: string,
  now: Date,
): SocialMaturityResult {
  return inputs.maturityByProspect.get(prospectId) ?? notCollectedSocialMaturity(now);
}
