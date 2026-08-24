/**
 * CE QUE L'OPÉRATEUR VEND — et ce qu'il n'a pas encore écrit.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi cette édition ne livre AUCUNE offre
 * ---------------------------------------------------------------------------
 * Une offre commerciale — une durée d'essai, un prix, un budget, une chaîne de
 * service — appartient à celui qui la vend. Elle ne se transporte pas d'une
 * instance à une autre : la recopier ferait dire à Hermes, mot pour mot, les
 * conditions de quelqu'un d'autre, à des prospects qui ne les ont jamais
 * acceptées. Cette édition part donc VIDE.
 *
 * ---------------------------------------------------------------------------
 * Ce que « vide » veut dire ici
 * ---------------------------------------------------------------------------
 * Pas « permissif ». Le moteur de conversation est construit pour ESCALADER
 * dès qu'une vérité manque : une question de prix, de garantie, de durée ou de
 * périmètre sans fait écrit devient `HUMAN_ESCALATION`, et aucun brouillon
 * autonome ne part. Une instance fraîche répond donc aux questions
 * commerciales par le silence et une escalade — ce qui est le bon défaut, et
 * non une régression.
 *
 * Remplir `config/offer.json` est une étape d'installation à part entière.
 * Voir `config/offer.example.json` et CLAUDE_SETUP.md.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

export const offerProfileSchema = z.object({
  /** La version opposable de CETTE offre. Change-la quand l'offre change. */
  version: z.string().min(1),
  /**
   * L'essai, s'il en existe un. Les faits sont écrits en toutes lettres et se
   * disent ENSEMBLE : annoncer une durée sans dire qui paie quoi est un
   * mensonge par omission, et `checkTrialStatement` le refuse.
   */
  trial: z
    .object({
      facts: z.array(z.string().min(10)).min(1),
      durationDays: z.number().int().positive().nullable().default(null),
      /** Montants CITABLES sur une question de budget, et sur elle seule. */
      quotableAmounts: z.array(z.number()).default([]),
    })
    .nullable()
    .default(null),
  /**
   * Ce que l'opérateur FAIT, facette par facette. Les clés sont celles de
   * `AcquisitionFacet` ; une facette absente reste muette et escalade.
   */
  serviceFacts: z.record(z.string(), z.array(z.string().min(10))).default({}),
});

export type OfferProfileConfig = z.infer<typeof offerProfileSchema>;

export interface OfferProfile {
  readonly status: 'CONFIGURED' | 'UNCONFIGURED';
  readonly version: string;
  readonly trialFacts: readonly string[];
  readonly trialDurationDays: number | null;
  readonly quotableAmounts: readonly number[];
  readonly serviceFacts: Readonly<Record<string, readonly string[]>>;
}

/** L'état d'une instance dont personne n'a encore écrit l'offre. */
export const UNCONFIGURED_OFFER: OfferProfile = Object.freeze({
  status: 'UNCONFIGURED',
  version: 'offer-unconfigured',
  trialFacts: Object.freeze([]),
  trialDurationDays: null,
  quotableAmounts: Object.freeze([]),
  serviceFacts: Object.freeze({}),
});

let cached: OfferProfile | null = null;

/**
 * Lue UNE fois par processus. Un fichier absent n'est pas une erreur — c'est
 * le statut `UNCONFIGURED`. Un fichier présent mais invalide, si : on ne
 * devine pas ce qu'un opérateur a voulu vendre.
 */
export function loadOfferProfile(): OfferProfile {
  if (cached !== null) return cached;
  const path = ['json', 'yaml', 'yml']
    .map((ext) => resolve(process.cwd(), 'config', `offer.${ext}`))
    .find((candidate) => existsSync(candidate));
  if (path === undefined) {
    cached = UNCONFIGURED_OFFER;
    return cached;
  }
  const parsed = offerProfileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  cached = Object.freeze({
    status: 'CONFIGURED' as const,
    version: parsed.version,
    trialFacts: Object.freeze([...(parsed.trial?.facts ?? [])]),
    trialDurationDays: parsed.trial?.durationDays ?? null,
    quotableAmounts: Object.freeze([...(parsed.trial?.quotableAmounts ?? [])]),
    serviceFacts: Object.freeze(
      Object.fromEntries(
        Object.entries(parsed.serviceFacts).map(([key, value]) => [key, Object.freeze([...value])]),
      ),
    ),
  });
  return cached;
}

/** Pour les tests : relire le disque après avoir écrit une configuration. */
export function resetOfferProfileCache(): void {
  cached = null;
}
