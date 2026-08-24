import type { ProspectRow } from '@/lib/repo/types';

/**
 * L'avis du système sur ce qu'il faut faire d'un prospect (§19).
 *
 * Trois valeurs, et la première chose à dire est ce qu'elles ne sont pas : ni
 * une action, ni une autorisation. `send` signifie « un humain qui enverrait ce
 * message tel quel ne commettrait pas d'erreur que nous sachions détecter ».
 * Rien ne part de ce dépôt — il n'y a aucun code d'envoi, et
 * `OUTBOUND_ALLOW_SENDING` reste à 0.
 *
 * L'intérêt d'écrire cet avis est de rendre la relecture humaine efficace
 * plutôt que de la remplacer. Vingt prospects à relire sans tri, c'est vingt
 * fois la même charge mentale ; vingt prospects dont le système dit « celui-ci
 * a un doute d'identité, celui-là n'a pas de parcours lu, ces huit-là sont
 * propres » se relisent dans l'ordre du risque.
 *
 * ---------------------------------------------------------------------------
 * La règle de décision, et son asymétrie
 * ---------------------------------------------------------------------------
 * `reject` est prononcé sur des faits durs — hors niche, injoignable, identité
 * non tranchée. `edit` est le verdict par défaut du doute : un message dont la
 * personnalisation est faible ou dont le parcours n'a pas été lu n'est pas
 * mauvais, il est insuffisamment fondé, et le corriger coûte deux minutes là où
 * l'envoyer coûte une réputation.
 *
 * `send` exige donc que **tout** soit réuni. C'est le seul verdict conjonctif,
 * et c'est voulu : dans une revue, le coût d'un faux « à corriger » est une
 * minute perdue, celui d'un faux « prêt à partir » est un message qui parle du
 * site de quelqu'un d'autre.
 */

export type OutreachRecommendation = 'send' | 'edit' | 'reject';

export interface RecommendationInput {
  prospect: Pick<
    ProspectRow,
    | 'niche_verdict'
    | 'contactable'
    | 'funnel_observable'
    | 'identity_review'
    | 'dedupe_status'
    | 'score'
  >;
  message: {
    exists: boolean;
    /** Un garde-fou bloquant : preuve non sourcée, chiffre interdit, promesse. */
    blocked: boolean;
    personalizationLevel: 'none' | 'low' | 'medium' | 'high' | null;
  };
}

export interface RecommendationResult {
  recommendation: OutreachRecommendation;
  /** Une phrase, celle qui s'affiche dans le tableau de revue. */
  reason: string;
  /** Tous les motifs retenus, pour que l'avis soit contestable point par point. */
  reasons: string[];
}

export function recommendOutreach(input: RecommendationInput): RecommendationResult {
  const { prospect, message } = input;
  const blockers: string[] = [];
  const doubts: string[] = [];

  // ------------------------------------------------------------ refus francs
  if (prospect.niche_verdict !== 'in_niche') {
    blockers.push(`métier non confirmé (${prospect.niche_verdict ?? 'non classé'})`);
  }
  if (prospect.contactable !== true) {
    blockers.push('aucun canal de contact professionnel observé');
  }
  if (prospect.identity_review === 'uncertain') {
    blockers.push('identité non tranchée : le site ne déclare pas assez pour savoir à qui l’on écrit');
  }
  if (message.blocked) {
    blockers.push('un garde-fou bloquant s’est déclenché sur le message');
  }

  if (blockers.length > 0) {
    return {
      recommendation: 'reject',
      reason: blockers[0] ?? 'prospect à écarter',
      reasons: blockers,
    };
  }

  // ------------------------------------------------------------------ doutes
  if (!message.exists) doubts.push('aucun message rédigé');
  if (prospect.funnel_observable !== true) {
    doubts.push('parcours commercial non observé : le message ne peut pas partir d’un levier vérifié');
  }
  if (prospect.identity_review === 'manual_review') {
    doubts.push('identité à confirmer par un humain (aucune identité légale publiée sur le site)');
  }
  if (prospect.dedupe_status === 'needs_review') {
    doubts.push('doublon possible à arbitrer avant tout envoi');
  }
  if (message.personalizationLevel === 'none' || message.personalizationLevel === 'low') {
    doubts.push(`personnalisation ${message.personalizationLevel} : le message ne cite presque rien d’observé`);
  }

  if (doubts.length > 0) {
    return { recommendation: 'edit', reason: doubts[0] ?? 'à retravailler', reasons: doubts };
  }

  return {
    recommendation: 'send',
    reason: 'métier confirmé, joignable, parcours lu, identité établie, message sourcé et sans garde-fou',
    reasons: [
      'métier confirmé',
      'canal de contact observé',
      'parcours commercial lu',
      'identité établie',
      'message personnalisé sans garde-fou déclenché',
    ],
  };
}
