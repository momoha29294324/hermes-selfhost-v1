/**
 * LEARNING-R1 §11, §19, §21 — une proposition, jamais une mutation.
 *
 * Le point du fichier tient dans un champ : `kind: 'LEARNING_PROPOSAL'`, un
 * littéral de type. Aucune autre valeur n'existe — il n'y a pas de variante
 * « appliquer », pas de mutation de politique, donc aucune fonction ne peut en
 * construire une, donc aucun chemin ne mène d'ici à un seuil, un score, une
 * éligibilité ou une règle d'envoi. §21 n'est pas une consigne qu'on relira :
 * c'est une absence de code. Un test refuse jusqu'au nom de cette variante
 * dans le fichier, commentaires compris — d'où sa périphrase ici.
 *
 * La deuxième garantie est arithmétique. Une proposition ne se construit pas
 * sans effectif : `sampleSize` est obligatoire, `status` en découle
 * (`statusForSample`), et une proposition `INSUFFICIENT_DATA` est produite
 * quand même — elle dit « voilà ce qu'on croit voir, et voilà pourquoi on ne
 * peut pas encore s'y fier ». La taire serait pire : on la redécouvrirait au
 * round suivant sans savoir qu'elle avait déjà été vue trop tôt.
 *
 * La troisième est la sécurité de §17 : le texte d'une proposition passe par
 * `detectPerformanceClaims`. Une proposition qui contiendrait « vous ne payez
 * que si vous gagnez » ne se construit pas — elle lève.
 */

import { detectPerformanceClaims } from '@/lib/learning/offer';
import type { SignalStatus, Rate } from '@/lib/learning/sufficiency';

export type ProposalType =
  /** Comment écrire le prochain tour. */
  | 'CONVERSATION_STYLE'
  /** Qui contacter, et avec quelle forme de message. */
  | 'TARGETING'
  /** Quand expliquer l'offre. */
  | 'OFFER_TIMING'
  /** Ce qu'on ne sait PAS observer, et qui bloque le reste. */
  | 'OBSERVABILITY';

/** Une preuve chiffrée attachée à une proposition. Jamais un texte de message. */
export interface ProposalEvidence {
  /** Ce qui est compté. Un libellé court, stable, comparable d'un round à l'autre. */
  readonly metric: string;
  readonly rate: Rate | null;
  /** Les identifiants canoniques concernés. Des références, pas du contenu (§22). */
  readonly references: readonly string[];
  /** La fenêtre d'observation : première et dernière donnée retenue. */
  readonly range: { readonly from: string | null; readonly to: string | null };
}

export interface LearningProposal {
  /** Littéral. Il n'existe pas d'autre valeur, donc pas d'autre effet. */
  readonly kind: 'LEARNING_PROPOSAL';
  readonly type: ProposalType;
  readonly status: SignalStatus;
  readonly sampleSize: number;
  /** Ce qui est proposé, en une phrase. Aucune promesse commerciale (§17). */
  readonly proposal: string;
  readonly evidence: ProposalEvidence;
  /** Littéral. Aucune proposition ne s'applique sans un humain. */
  readonly requiresHumanDecision: true;
}

export class ForbiddenClaimError extends Error {
  constructor(readonly claims: readonly string[]) {
    super(`proposition refusée : promesse commerciale non définie (${claims.join(', ')})`);
    this.name = 'ForbiddenClaimError';
  }
}

export interface ProposalInput {
  readonly type: ProposalType;
  readonly status: SignalStatus;
  readonly sampleSize: number;
  readonly proposal: string;
  readonly evidence: ProposalEvidence;
}

/**
 * L'unique constructeur de proposition.
 *
 * Unique par choix : un second point d'entrée finirait par contourner le
 * contrôle de promesse, comme un second lexique finit toujours par être le
 * plus indulgent.
 */
export function buildProposal(input: ProposalInput): LearningProposal {
  const claims = detectPerformanceClaims(input.proposal);
  if (claims.length > 0) throw new ForbiddenClaimError(claims);

  return Object.freeze({
    kind: 'LEARNING_PROPOSAL' as const,
    type: input.type,
    status: input.status,
    sampleSize: input.sampleSize,
    proposal: input.proposal,
    evidence: Object.freeze({
      ...input.evidence,
      references: Object.freeze([...input.evidence.references]),
      range: Object.freeze({ ...input.evidence.range }),
    }),
    requiresHumanDecision: true as const,
  });
}

/** Rend une proposition lisible, effectif et confiance TOUJOURS visibles (§28, §29). */
export function renderProposal(proposal: LearningProposal): string {
  const interval = proposal.evidence.rate?.interval;
  const confidence =
    interval === null || interval === undefined
      ? 'confiance : non calculable (n=0)'
      : `confiance ${(interval.level * 100).toFixed(0)} % : [${(interval.lower * 100).toFixed(0)}–${(
          interval.upper * 100
        ).toFixed(0)} %]`;
  const window =
    proposal.evidence.range.from === null || proposal.evidence.range.to === null
      ? 'fenêtre : aucune donnée'
      : `fenêtre : ${proposal.evidence.range.from} → ${proposal.evidence.range.to}`;

  return [
    `[${proposal.type}] ${proposal.status} — n=${proposal.sampleSize}`,
    `  ${proposal.proposal}`,
    `  métrique : ${proposal.evidence.metric} — ${confidence}`,
    `  ${window}`,
    `  décision humaine requise : oui`,
  ].join('\n');
}
