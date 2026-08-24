/**
 * R6B-D2.1 §9 — l'historique déposé chez le fournisseur.
 *
 * Une note CRM doit permettre à un humain de reprendre la conversation sans
 * ouvrir ce dépôt : ce qui est parti, ce qui est revenu, ce que le système en a
 * conclu, ce qu'il recommande, et où en est la réponse proposée.
 *
 * ---------------------------------------------------------------------------
 * Ce qu'elle ne contient pas, et pourquoi
 * ---------------------------------------------------------------------------
 *
 *   * aucun raisonnement caché. `reasoning_summary` est, depuis 0026, une
 *     justification PUBLIABLE, courte, demandée comme telle au modèle ; rien de
 *     ce que le modèle « pense » en chemin n'est persisté nulle part, donc rien
 *     de tel ne peut sortir d'ici ;
 *
 *   * aucun bloc de recherche intégral. La fiche prospect porte le RÉSUMÉ,
 *     tronqué : les observations, leurs preuves et leurs sources restent en
 *     base, où elles sont auditables. Les recopier à chaque réponse ferait
 *     grossir l'historique d'une redite sans rien apprendre de plus ;
 *
 *   * aucun brouillon de réponse. Son STATUT figure — « une réponse est
 *     proposée, elle attend un humain » — mais pas son texte : un brouillon non
 *     approuvé posé dans un CRM se fait copier-coller tôt ou tard, et ce dépôt
 *     n'a le droit de rien envoyer.
 *
 * La fiche prospect est TOUJOURS présente, même quand les champs personnalisés
 * du sous-compte portent déjà les mêmes valeurs. C'est délibéré : sans elle, le
 * contenu de la note dépendrait de la configuration, et cartographier un champ
 * plus tard changerait le texte, donc l'empreinte, donc produirait une seconde
 * note pour la même réponse.
 *
 * Le texte est DÉTERMINISTE : mêmes entrées, même note, donc même empreinte,
 * donc `r6b_crm_notes` la reconnaît et ne la repose pas.
 */

import { createHash } from 'node:crypto';
import type { CrmPayload } from '@/lib/crm/payload';
import type { CrmNoteRequest } from '@/lib/crm/types';

/** Bornes de citation. Les corps intégraux restent en base, intacts. */
export const NOTE_FIRST_TOUCH_CHARS = 900;
export const NOTE_REPLY_CHARS = 1_200;
export const NOTE_RESEARCH_CHARS = 400;

export type ProposedResponseStatus = 'NONE' | 'PROPOSED' | 'FAILED';

export interface CrmNoteInput {
  readonly payload: CrmPayload;
  readonly firstTouchSentAt: string | null;
  readonly firstTouchSubject: string | null;
  readonly firstTouchBody: string;
  readonly replyFrom: string;
  readonly replySubject: string | null;
  readonly replyBody: string;
  readonly reasoningSummary: string;
  readonly recommendedNextAction: string;
  readonly proposedResponseStatus: ProposedResponseStatus;
}

function clamp(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}\n[…tronqué ; texte intégral dans Hermes]`;
}

const PROPOSED_LABELS: Readonly<Record<ProposedResponseStatus, string>> = Object.freeze({
  NONE: 'aucune (cette catégorie n’en justifie pas)',
  PROPOSED: 'rédigée, en attente de validation humaine — NON ENVOYÉE',
  FAILED: 'rédaction en échec, à reprendre',
});

function fact(label: string, value: string | number | null): string | null {
  if (value === null) return null;
  const text = String(value).trim();
  return text.length === 0 ? null : `- ${label} : ${text}`;
}

export function renderCrmNote(input: CrmNoteInput): string {
  const { payload } = input;

  const card = [
    fact('entreprise', payload.company),
    fact('raison sociale', payload.legalName),
    fact('ville', payload.city),
    fact('site', payload.website),
    fact('Instagram', payload.instagram),
    fact('téléphone', payload.phone),
    fact(
      'score Hermes',
      payload.prospectScore === null
        ? null
        : `${payload.prospectScore}${payload.prospectScoreBand === null ? '' : ` (${payload.prospectScoreBand})`}`,
    ),
    fact(
      'synthèse de recherche',
      payload.researchSummary === null ? null : clamp(payload.researchSummary, NOTE_RESEARCH_CHARS),
    ),
    fact('prospect Hermes', payload.prospectId),
    fact('manifeste', payload.manifestId),
  ].filter((row): row is string => row !== null);

  const lines = [
    `Hermes — réponse reçue le ${payload.replyReceivedAt}`,
    '',
    `Classification : ${payload.replyClassification} (confiance ${payload.replyConfidence.toFixed(2)}, corrélation ${payload.correlationStatus})`,
    `Justification : ${input.reasoningSummary.trim()}`,
    `Action recommandée : ${input.recommendedNextAction}`,
    `Étape visée : ${payload.targetStage ?? 'aucune (conclusion non tranchée)'}`,
    `Réponse proposée : ${PROPOSED_LABELS[input.proposedResponseStatus]}`,
    '',
    '— FICHE PROSPECT (faits observés ; rien n’est déduit)',
    ...card,
    '',
    `— MESSAGE ENVOYÉ (${input.firstTouchSentAt ?? 'date inconnue'})`,
  ];
  if (input.firstTouchSubject !== null) lines.push(`Objet : ${input.firstTouchSubject}`);
  lines.push(clamp(input.firstTouchBody, NOTE_FIRST_TOUCH_CHARS));
  lines.push('', `— RÉPONSE REÇUE (de ${input.replyFrom})`);
  if (input.replySubject !== null) lines.push(`Objet : ${input.replySubject}`);
  lines.push(clamp(input.replyBody, NOTE_REPLY_CHARS));

  return lines.join('\n');
}

export function buildCrmNote(input: CrmNoteInput): CrmNoteRequest {
  const body = renderCrmNote(input);
  return Object.freeze({
    body,
    bodySha256: createHash('sha256').update(body).digest('hex'),
  });
}
