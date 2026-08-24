import { z } from 'zod';
import { VISUAL_MATURITY_LEVELS, type VisualMaturityLevel } from '@/lib/pipeline/instagramMaturity';

/**
 * R7.3C §20–§21 — la RUBRIQUE de maturité visuelle.
 *
 * ---------------------------------------------------------------------------
 * Le partage du travail, et pourquoi il est fait ainsi
 * ---------------------------------------------------------------------------
 * La mission autorise l'agent à regarder lui-même les captures de profil et à
 * produire une classification. Elle interdit aussi de se contenter d'écrire
 * `PROFESSIONAL` sans explication — et c'est le même problème vu deux fois : un
 * verdict qui sort d'un regard n'est pas rejouable, et il dérive dès que le juge
 * change.
 *
 * D'où la coupure appliquée ici :
 *
 *   * l'AGENT observe des DIMENSIONS, une par une, chacune tranchée en
 *     « présent / absent / illisible ». Ce sont des constats sur une image, du
 *     même ordre que « la page porte un bouton de devis » ;
 *   * le CODE dérive la CLASSE de ces dimensions, par une règle écrite, testée
 *     et versionnée.
 *
 * Conséquence directe : deux relectures qui voient la même chose écrivent la
 * même classe, et un désaccord se discute dimension par dimension au lieu de se
 * discuter sur le mot `PROFESSIONAL`. C'est aussi ce qu'exige CLAUDE.md — la
 * logique déterministe reste du code testé, jamais un prompt.
 *
 * ---------------------------------------------------------------------------
 * Ce que la rubrique refuse de dire
 * ---------------------------------------------------------------------------
 * Rien sur la performance commerciale. Un feed superbe ne prouve aucun chiffre
 * d'affaires, aucune conversion, aucune audience — il prouve qu'une entreprise
 * sait produire une image. Aucune dimension ci-dessous ne parle de résultat, et
 * aucune n'est autorisée à en suggérer un.
 */

/** Version du barème. Toute observation en porte une : un barème qui change ne réécrit pas le passé. */
export const RUBRIC_VERSION = 'r7.3c-visual-1';

/**
 * Les onze dimensions observables (§20).
 *
 * `core: true` marque celles qui décrivent la TENUE du compte plutôt que son
 * contenu. Ce sont les seules dont l'absence empêche le haut du vocabulaire :
 * un feed sans cohérence ni branding peut être riche en contenus éducatifs, il
 * n'est pas « hautement mature ».
 */
export const RUBRIC_DIMENSIONS = [
  { key: 'feed_coherence', core: true, label: 'cohérence visuelle du feed (palette, cadrage, rythme)' },
  { key: 'media_quality', core: true, label: 'qualité apparente des photos et vidéos' },
  { key: 'recurring_branding', core: true, label: 'branding récurrent (logo, gabarit, typographie)' },
  { key: 'apparent_regularity', core: true, label: 'régularité apparente de la publication' },
  { key: 'worked_covers', core: false, label: 'covers / vignettes travaillées' },
  { key: 'structured_before_after', core: false, label: 'avant / après structurés' },
  { key: 'editorial_variety', core: false, label: 'variété et qualité éditoriale' },
  { key: 'visual_cta', core: false, label: 'appels à l’action visuels' },
  { key: 'educational_content', core: false, label: 'contenus éducatifs' },
  { key: 'commercial_content', core: false, label: 'contenus commerciaux (offres, prestations)' },
  { key: 'visible_social_proof', core: false, label: 'preuve sociale visible (avis, résultats clients)' },
] as const;

export type RubricDimensionKey = (typeof RUBRIC_DIMENSIONS)[number]['key'];

export const DIMENSION_VERDICTS = ['PRESENT', 'ABSENT', 'UNREADABLE'] as const;
export type DimensionVerdict = (typeof DIMENSION_VERDICTS)[number];

/**
 * En deçà, la capture ne porte pas de quoi juger et la classe vaut `UNKNOWN`.
 *
 * §39 le demande explicitement : `visual_maturity = UNKNOWN` est préférable à
 * une fausse précision. Quatre dimensions lisibles sur onze est un plancher, pas
 * un objectif.
 */
export const MINIMUM_READABLE_DIMENSIONS = 4;

/** Poids d'une dimension dans le calcul. Les « core » comptent double, et rien d'autre ne varie. */
const CORE_WEIGHT = 2;
const SECONDARY_WEIGHT = 1;

export const rubricObservationSchema = z.object({
  rubricVersion: z.literal(RUBRIC_VERSION),
  /** Qui a regardé. Un jugement sans auteur n'est pas contestable. */
  reviewer: z.string().min(1),
  method: z.literal('agent_visual_review'),
  /** L'image RÉELLEMENT regardée, par son empreinte. Une revue ne peut pas être recyclée. */
  screenshotSha256: z.string().length(64),
  observedAt: z.string().min(1),
  dimensions: z.record(z.enum(RUBRIC_DIMENSIONS.map((d) => d.key) as [string, ...string[]]), z.enum(DIMENSION_VERDICTS)),
  /** Ce que l'agent dit avoir vu. Une puce par constat, jamais une conclusion. */
  evidence: z.array(z.string().min(1)),
});

export type RubricObservation = z.infer<typeof rubricObservationSchema>;

export interface VisualMaturityVerdict {
  readonly level: VisualMaturityLevel;
  readonly rubricVersion: string;
  readonly reviewer: string;
  readonly method: 'agent_visual_review';
  readonly screenshotSha256: string;
  readonly confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
  readonly readableDimensions: number;
  readonly presentDimensions: number;
  readonly weightedRatio: number | null;
  /** Les dimensions « core » absentes — ce qui plafonne la classe, nommément. */
  readonly missingCore: readonly RubricDimensionKey[];
  readonly evidence: readonly string[];
  readonly reason: string;
}

/**
 * Dérive la classe depuis les dimensions. Pure, testée, sans regard.
 *
 * Le plafond « core » mérite d'être défendu : sans lui, un compte qui coche sept
 * dimensions secondaires (éducatif, commercial, avis, CTA…) et aucune des quatre
 * dimensions de tenue sortirait `PROFESSIONAL`. Or ces sept-là décrivent ce que
 * le compte PUBLIE, pas s'il est tenu. C'est exactement le raccourci
 * « ça fait beaucoup de contenu, donc c'est mature » que la mission refuse.
 */
export function deriveVisualMaturity(observation: RubricObservation): VisualMaturityVerdict {
  const entries = RUBRIC_DIMENSIONS.map((dimension) => ({
    ...dimension,
    verdict: (observation.dimensions[dimension.key] ?? 'UNREADABLE') as DimensionVerdict,
  }));

  const readable = entries.filter((entry) => entry.verdict !== 'UNREADABLE');
  const present = readable.filter((entry) => entry.verdict === 'PRESENT');

  /**
   * `missingCore` compte les dimensions de tenue observées ABSENTES — jamais
   * celles qu'on n'a pas pu lire.
   *
   * La première version confondait les deux, et la confusion se voyait sur des
   * données réelles : `apparent_regularity` est illisible pour TOUS les profils
   * en collecte anonyme (Instagram ne sert aucun horodatage). Tout compte,
   * fût-il impeccable, se retrouvait donc plafonné pour un manque de données —
   * c'est-à-dire pénalisé pour ce que nous n'avons pas regardé, et non pour ce
   * que l'entreprise n'a pas fait.
   *
   * C'est la faute exacte que ce round combat partout ailleurs. Une dimension
   * illisible fait baisser la CONFIANCE (elle réduit `readableDimensions`) ;
   * elle ne fait pas baisser le NIVEAU. Un compte peut donc sortir
   * `HIGHLY_MATURE` en confiance `MEDIUM` — « ce que j'ai vu penche fort, mais
   * j'ai vu peu » — et c'est une phrase que le vocabulaire doit pouvoir dire.
   */
  const missingCore = entries.filter((entry) => entry.core && entry.verdict === 'ABSENT').map((entry) => entry.key);

  const shell = {
    rubricVersion: observation.rubricVersion,
    reviewer: observation.reviewer,
    method: 'agent_visual_review' as const,
    screenshotSha256: observation.screenshotSha256,
    readableDimensions: readable.length,
    presentDimensions: present.length,
    missingCore,
    evidence: observation.evidence,
  };

  if (readable.length < MINIMUM_READABLE_DIMENSIONS) {
    return {
      ...shell,
      level: 'UNKNOWN',
      confidence: 'NONE',
      weightedRatio: null,
      reason:
        `${readable.length} dimension(s) lisible(s) sur ${RUBRIC_DIMENSIONS.length} — sous le plancher de ` +
        `${MINIMUM_READABLE_DIMENSIONS} : la capture ne porte pas de quoi juger, et UNKNOWN vaut mieux qu’une fausse précision`,
    };
  }

  const weightOf = (core: boolean): number => (core ? CORE_WEIGHT : SECONDARY_WEIGHT);
  const readableWeight = readable.reduce((sum, entry) => sum + weightOf(entry.core), 0);
  const presentWeight = present.reduce((sum, entry) => sum + weightOf(entry.core), 0);
  const ratio = readableWeight === 0 ? 0 : presentWeight / readableWeight;

  const uncapped: VisualMaturityLevel =
    ratio >= 0.8 ? 'HIGHLY_MATURE' : ratio >= 0.6 ? 'PROFESSIONAL' : ratio >= 0.4 ? 'CONSISTENT' : ratio >= 0.2 ? 'BASIC' : 'AMATEUR';

  /** Le haut du vocabulaire exige la tenue, pas seulement le volume. */
  const capped: VisualMaturityLevel =
    missingCore.length === 0
      ? uncapped
      : missingCore.length === 1 && uncapped === 'HIGHLY_MATURE'
        ? 'PROFESSIONAL'
        : uncapped === 'HIGHLY_MATURE' || uncapped === 'PROFESSIONAL'
          ? 'CONSISTENT'
          : uncapped;

  const confidence: VisualMaturityVerdict['confidence'] =
    readable.length >= 9 ? 'HIGH' : readable.length >= 6 ? 'MEDIUM' : 'LOW';

  return {
    ...shell,
    level: capped,
    confidence,
    weightedRatio: Math.round(ratio * 100) / 100,
    reason:
      `${present.length}/${readable.length} dimension(s) présentes (pondéré ${Math.round(ratio * 100)} %)` +
      (capped === uncapped
        ? ''
        : ` — plafonné de ${uncapped} à ${capped} : dimension(s) de tenue absente(s) (${missingCore.join(', ')})`),
  };
}

/** Le niveau, ou `null` quand aucune revue n'a été enregistrée. Jamais `AMATEUR` par défaut. */
export function visualLevelOf(verdict: VisualMaturityVerdict | null): VisualMaturityLevel | null {
  if (verdict === null) return null;
  return verdict.level;
}

/** Distribution publiable, avec toutes les classes présentes — y compris à zéro. */
export function visualDistribution(verdicts: readonly (VisualMaturityVerdict | null)[]): Map<VisualMaturityLevel, number> {
  const tally = new Map<VisualMaturityLevel, number>(VISUAL_MATURITY_LEVELS.map((level) => [level, 0]));
  for (const verdict of verdicts) {
    const level = verdict?.level ?? 'UNKNOWN';
    tally.set(level, (tally.get(level) ?? 0) + 1);
  }
  return tally;
}
