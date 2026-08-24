/**
 * LEARNING-R1 §13, §14 — le funnel, et pourquoi le taux de réponse ne suffit pas.
 *
 * §14 est la règle qui structure ce fichier : « ne jamais optimiser uniquement
 * reply rate ». La traduire en prose n'aurait servi à rien — un tableau qui
 * affiche le taux de réponse en première colonne se fait lire comme un
 * classement, quoi qu'on écrive à côté. Elle est donc traduite en TYPES :
 *
 *   * un segment ne porte pas un taux, il porte une ÉCHELLE de taux, un par
 *     barreau du funnel ;
 *   * chaque taux porte son effectif et son statut (`Rate`) ;
 *   * chaque barreau porte son observabilité, donc un barreau qu'aucune source
 *     ne renseigne s'affiche « non observable » et jamais « 0 % » ;
 *   * le classement des segments se fait sur la PROGRESSION moyenne, pas sur le
 *     premier barreau. Un angle à 50 % de réponses sans intérêt tombe derrière
 *     un angle à 20 % avec des conversations engagées, mécaniquement.
 */

import {
  FUNNEL_STAGES,
  STAGE_OBSERVABILITY,
  funnelRank,
  type FunnelStage,
  type Observability,
  type ProspectOutcome,
} from '@/lib/learning/outcome';
import { rate, type Rate, type SignalStatus } from '@/lib/learning/sufficiency';
import { segmentValue, type PreSendFeatures, type SegmentKey } from '@/lib/learning/targeting';

/** Le taux d'atteinte d'un barreau, avec ce qui permet de ne pas le sur-lire. */
export interface StageMetric {
  readonly stage: FunnelStage;
  readonly rate: Rate;
  readonly observability: Observability;
}

export interface SegmentMetrics {
  readonly key: SegmentKey;
  readonly value: string;
  /** Le dénominateur commun : combien de prospects contactés dans ce groupe. */
  readonly sent: number;
  /** Un taux par barreau, dans l'ordre du funnel. */
  readonly stages: readonly StageMetric[];
  /**
   * La progression moyenne, en rangs.
   *
   * `0` = personne n'a répondu. `2` = les prospects atteignent en moyenne
   * `ENGAGED`. C'est la mesure qui refuse de confondre du volume de réponses
   * avec de l'avancement, et c'est elle qui trie.
   */
  readonly meanProgression: number;
  /** Combien ont fini par un refus ou une demande d'arrêt. */
  readonly lost: number;
  readonly unsubscribed: number;
  /** Le statut de l'effectif du segment, tous barreaux confondus. */
  readonly status: SignalStatus;
}

/**
 * Un prospect a-t-il ATTEINT ce barreau ?
 *
 * « Atteint » et non « est à » : un prospect qui a fini `INTERESTED` a
 * forcément traversé `REPLIED`, et compter les barreaux comme exclusifs ferait
 * baisser le taux de réponse à mesure que la prospection s'améliore.
 */
export function reached(outcome: ProspectOutcome, stage: FunnelStage): boolean {
  return funnelRank(outcome.stage) >= funnelRank(stage);
}

/** Les taux d'un groupe de prospects, barreau par barreau. */
export function stageMetricsFor(outcomes: readonly ProspectOutcome[]): readonly StageMetric[] {
  const total = outcomes.length;
  return Object.freeze(
    FUNNEL_STAGES.filter((stage) => stage !== 'NO_REPLY').map((stage) => {
      const observability = STAGE_OBSERVABILITY[stage].level;
      // Un barreau non observable ne produit pas « 0 sur 12 » : il produit
      // « rien d'observé ». La nuance est celle de CLAUDE.md §2, et elle est
      // ici la différence entre « aucun client gagné » et « on ne sait pas
      // lire les clients gagnés ».
      const value =
        observability === 'NOT_OBSERVABLE'
          ? rate(0, 0)
          : rate(outcomes.filter((outcome) => reached(outcome, stage)).length, total);
      return Object.freeze({ stage, rate: value, observability });
    }),
  );
}

export function meanProgressionOf(outcomes: readonly ProspectOutcome[]): number {
  if (outcomes.length === 0) return 0;
  const sum = outcomes.reduce((total, outcome) => total + funnelRank(outcome.stage), 0);
  return sum / outcomes.length;
}

/** Une ligne de prospect : ses features d'avant l'envoi, et son issue. */
export interface OutcomeRow {
  readonly features: PreSendFeatures;
  readonly outcome: ProspectOutcome;
}

/**
 * Découpe un corpus selon un axe et mesure chaque groupe.
 *
 * Les groupes vides n'existent pas : on ne fabrique pas une ligne « OVER_10K :
 * 0 prospect » pour faire joli. Un tableau qui montre des groupes sans données
 * apprend à ignorer les lignes à zéro, y compris celles qui en disent quelque
 * chose.
 */
export function segmentBy(rows: readonly OutcomeRow[], key: SegmentKey): readonly SegmentMetrics[] {
  const groups = new Map<string, OutcomeRow[]>();
  for (const row of rows) {
    const value = segmentValue(row.features, key);
    const bucket = groups.get(value);
    if (bucket === undefined) groups.set(value, [row]);
    else bucket.push(row);
  }

  const metrics = [...groups.entries()].map(([value, bucket]) => {
    const outcomes = bucket.map((row) => row.outcome);
    const replied = rate(outcomes.filter((outcome) => reached(outcome, 'REPLIED')).length, outcomes.length);
    return Object.freeze({
      key,
      value,
      sent: outcomes.length,
      stages: stageMetricsFor(outcomes),
      meanProgression: meanProgressionOf(outcomes),
      lost: outcomes.filter((outcome) => outcome.terminal === 'LOST').length,
      unsubscribed: outcomes.filter((outcome) => outcome.terminal === 'UNSUBSCRIBED').length,
      status: replied.status,
    });
  });

  // Tri par PROGRESSION, jamais par taux de réponse (§14). À progression égale,
  // l'effectif départage — un groupe de 30 vaut mieux qu'un groupe de 2.
  return Object.freeze(
    metrics.sort((left, right) =>
      right.meanProgression === left.meanProgression
        ? right.sent - left.sent
        : right.meanProgression - left.meanProgression,
    ),
  );
}

/** Le funnel global, tous segments confondus. */
export interface FunnelSummary {
  readonly sent: number;
  readonly stages: readonly StageMetric[];
  readonly meanProgression: number;
  readonly lost: number;
  readonly unsubscribed: number;
  readonly medianFirstReplyLatencyMs: number | null;
}

export function summarizeFunnel(outcomes: readonly ProspectOutcome[]): FunnelSummary {
  const latencies = outcomes
    .map((outcome) => outcome.firstReplyLatencyMs)
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);
  const middle = Math.floor(latencies.length / 2);
  const median =
    latencies.length === 0
      ? null
      : latencies.length % 2 === 1
        ? (latencies[middle] ?? null)
        : ((latencies[middle - 1] ?? 0) + (latencies[middle] ?? 0)) / 2;

  return Object.freeze({
    sent: outcomes.length,
    stages: stageMetricsFor(outcomes),
    meanProgression: meanProgressionOf(outcomes),
    lost: outcomes.filter((outcome) => outcome.terminal === 'LOST').length,
    unsubscribed: outcomes.filter((outcome) => outcome.terminal === 'UNSUBSCRIBED').length,
    medianFirstReplyLatencyMs: median,
  });
}
