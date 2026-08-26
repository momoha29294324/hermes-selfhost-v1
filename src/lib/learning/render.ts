/**
 * LEARNING-R1 §18, §28, §29 — le rapport, tel qu'un humain le lit.
 *
 * Deux règles gouvernent chaque ligne produite ici :
 *
 *   1. **Aucun texte de message.** Ni un extrait de réponse de prospect, ni un
 *      brouillon, ni une phrase d'un opérateur. Le rendu ne manipule que des codes,
 *      des identifiants et des compteurs — c'est §22 appliqué à l'endroit où il
 *      est le plus facile de le trahir, la sortie.
 *
 *   2. **Aucun taux sans son effectif.** `renderRate` refuse de produire un
 *      pourcentage nu : il porte le numérateur, le dénominateur, l'intervalle
 *      et le statut. Un tableau de rapport se lit en diagonale, et un « 50 % »
 *      lu en diagonale sur 1/2 est exactement l'erreur que §12 veut empêcher.
 */

import type { LearningReport } from '@/lib/learning/report';
import { renderProposal } from '@/lib/learning/proposal';
import { renderRate } from '@/lib/learning/sufficiency';

/**
 * Une ligne de dimension.
 *
 * `basis` est affiché à côté de la valeur, jamais en note de bas de page :
 * « MEDIUM, base VALIDATED_ONLY » dit qu'un humain a laissé passer des messages
 * moyens, et « MEDIUM, base REWRITTEN » qu'il en a écrit. Les deux se lisent
 * pareil sans cette colonne, et se concluent très différemment (§3).
 */
function dimensionLine(
  label: string,
  dimension: { value: unknown; sample: { denominator: number }; status: string; basis: string },
): string {
  const value = dimension.value === 'UNKNOWN' ? 'UNKNOWN' : String(dimension.value);
  return `  ${label.padEnd(26)} ${value.padEnd(14)} n=${String(dimension.sample.denominator).padEnd(4)} ${dimension.status.padEnd(18)} base=${dimension.basis}`;
}

export function renderLearningReport(report: LearningReport): string {
  const lines: string[] = [];

  lines.push('HERMES LEARNING R1');
  lines.push(`généré le ${report.generatedAt}`);
  lines.push(`fenêtre observée : ${report.corpus.range.from ?? '—'} → ${report.corpus.range.to ?? '—'}`);
  lines.push('');

  lines.push('CORPUS');
  lines.push(`  prospects contactés        = ${report.corpus.prospectsContacted}`);
  lines.push(`  prospects ayant répondu    = ${report.corpus.prospectsWhoReplied}`);
  lines.push(`  messages entrants          = ${report.corpus.inboundMessages}`);
  lines.push(`  analyses ACTIVE            = ${report.corpus.analyses}`);
  lines.push(`  brouillons Hermes          = ${report.corpus.hermesDrafts}`);
  lines.push(`  couples brouillon → retenu = ${report.corpus.overridePairs}`);
  lines.push('');

  lines.push('FUNNEL (un barreau ATTEINT compte tous ceux d’en dessous)');
  lines.push(`  envoyés                    = ${report.funnel.sent}`);
  for (const stage of report.funnel.stages) {
    const value =
      stage.observability === 'NOT_OBSERVABLE'
        ? `NON OBSERVABLE — ${stage.observability}`
        : renderRate(stage.rate);
    lines.push(`  ${stage.stage.padEnd(16)} ${value}`);
  }
  lines.push(`  progression moyenne        = ${report.funnel.meanProgression.toFixed(2)} rang(s)`);
  lines.push(`  perdus / désabonnés        = ${report.funnel.lost} / ${report.funnel.unsubscribed}`);
  lines.push(
    `  délai médian de réponse    = ${
      report.funnel.medianFirstReplyLatencyMs === null
        ? '—'
        : `${Math.round(report.funnel.medianFirstReplyLatencyMs / 60_000)} min`
    }`,
  );
  lines.push('');

  lines.push('CORRECTIONS HUMAINES (brouillon → texte retenu)');
  lines.push(`  couples observés           = ${report.overrides.pairs}`);
  lines.push(`  sans transformation lisible= ${report.overrides.cosmeticOnly}`);
  const observedDeltas = report.overrides.byDelta.filter((entry) => entry.rate.numerator > 0);
  if (observedDeltas.length === 0) {
    lines.push('  aucune transformation reconnue');
  } else {
    for (const entry of observedDeltas) {
      lines.push(`  ${entry.delta.padEnd(26)} ${renderRate(entry.rate)}`);
    }
  }
  lines.push('');

  lines.push('OPERATOR_CONVERSATION_STYLE');
  lines.push(dimensionLine('preferredLength', report.style.preferredLength));
  lines.push(dimensionLine('maxQuestions', report.style.maxQuestions));
  lines.push(dimensionLine('genericOpeningTolerance', report.style.genericOpeningTolerance));
  lines.push(dimensionLine('pitchDirectness', report.style.pitchDirectness));
  lines.push(dimensionLine('preferredFormality', report.style.preferredFormality));
  lines.push(dimensionLine('useOfAcknowledgements', report.style.useOfAcknowledgements));
  lines.push(dimensionLine('ctaAggressiveness', report.style.ctaAggressiveness));
  lines.push(dimensionLine('conversationalFrench', report.style.conversationalFrench));
  lines.push(dimensionLine('averageTurnsBeforePitch', report.style.averageTurnsBeforePitch));
  lines.push(dimensionLine('averageTurnsBeforeCall', report.style.averageTurnsBeforeCall));
  lines.push('');

  lines.push('CIBLAGE (features connues AVANT l’envoi)');
  for (const segment of report.segments) {
    if (segment.rows.length === 0) continue;
    lines.push(`  ${segment.key}`);
    for (const row of segment.rows) {
      const replied = row.stages.find((stage) => stage.stage === 'REPLIED');
      const engaged = row.stages.find((stage) => stage.stage === 'ENGAGED');
      const interested = row.stages.find((stage) => stage.stage === 'INTERESTED');
      lines.push(
        `    ${row.value.padEnd(18)} n=${String(row.sent).padEnd(4)} prog=${row.meanProgression.toFixed(2)}` +
          `  replied ${replied === undefined ? '—' : renderRate(replied.rate)}`,
      );
      lines.push(
        `    ${''.padEnd(18)} ${''.padEnd(6)}` +
          `  engaged ${engaged === undefined ? '—' : renderRate(engaged.rate)}` +
          ` | interested ${interested === undefined ? '—' : renderRate(interested.rate)}`,
      );
    }
  }
  lines.push('');

  lines.push('OFFRE (observation seule — aucune règle d’exposition)');
  lines.push(
    `  maturité des tours         = LOW ${report.offer.readinessCounts.LOW} / MEDIUM ${report.offer.readinessCounts.MEDIUM} / HIGH ${report.offer.readinessCounts.HIGH}`,
  );
  const withGap = report.offer.observations.filter((observation) => observation.gap !== null).length;
  lines.push(`  calendrier non observable  = ${withGap} / ${report.offer.observations.length} conversation(s)`);
  lines.push('');

  lines.push('BANQUE D’EXEMPLES (références, aucun contenu dupliqué)');
  if (report.exemplars.length === 0) {
    lines.push('  aucune conversation n’atteint le barreau minimal');
  } else {
    for (const exemplar of report.exemplars) {
      lines.push(`  ${exemplar.prospectId} — ${exemplar.summary}`);
      lines.push(
        `    messages référencés = ${exemplar.inboundMessageIds.length} | brouillons = ${exemplar.draftIds.length} | issue commerciale = ${exemplar.commercialOutcome}`,
      );
    }
  }
  lines.push('');

  lines.push('CE QUI N’EST PAS OBSERVABLE');
  lines.push(
    `  barreaux sans source       = ${report.observability.unobservableStages.join(', ') || 'aucun'}`,
  );
  lines.push(`  tours sans texte humain    = ${report.observability.turnsWithoutObservableHumanText}`);
  lines.push(`  entrants sans analyse      = ${report.observability.inboundWithoutAnalysis}`);
  lines.push(`  contactés sans état        = ${report.observability.prospectsWithoutOutreachState}`);
  lines.push('');

  lines.push('PROPOSITIONS (aucune n’est appliquée)');
  for (const proposal of report.proposals) {
    lines.push(renderProposal(proposal));
  }
  lines.push('');
  lines.push('Aucune écriture, aucun envoi, aucune politique modifiée.');

  return lines.join('\n');
}
