/**
 * L'action suivante, et d'où elle vient.
 *
 * Extrait de la fiche prospect pour être TESTABLE : c'est la phrase la plus en
 * évidence de l'écran, donc celle dont une régression silencieuse coûterait le
 * plus cher. La règle est inchangée depuis CRM2, au mot près.
 *
 * L'analyse de réponse a le dernier mot quand elle existe — c'est la seule
 * source qui ait lu un message entrant. Sinon, la colonne du pipeline dit ce
 * qu'elle affirme déjà. Rien n'est daté : ce dépôt ne contient aucun
 * ordonnanceur, donc aucune échéance ne peut être affichée.
 *
 * Aucune branche n'INVENTE d'action. Quand aucune règle ne s'applique, la
 * réponse est `none` — un tiret et sa raison — jamais une action plausible.
 */

import type { CrmLane, CrmTone } from '@/lib/crm/view';

export type CrmNextActionKey =
  | 'recommended'
  | 'do_not_contact'
  | 'manifest_ready'
  | 'await_reply'
  | 'none';

export interface CrmNextAction {
  readonly key: CrmNextActionKey;
  readonly label: string;
  readonly basis: string;
  readonly tone: CrmTone;
}

export interface CrmNextActionInput {
  readonly recommendedNextAction: string | null;
  readonly doNotContact: boolean;
  readonly lane: CrmLane | null;
}

export function resolveNextAction(input: CrmNextActionInput): CrmNextAction {
  if (input.recommendedNextAction !== null) {
    return Object.freeze({
      key: 'recommended' as const,
      label: input.recommendedNextAction,
      basis: 'recommandée par l’analyse de la réponse',
      tone: 'orange' as const,
    });
  }
  if (input.doNotContact) {
    return Object.freeze({
      key: 'do_not_contact' as const,
      label: 'ne pas contacter',
      basis: 'entrée dans do_not_contact',
      tone: 'red' as const,
    });
  }
  if (input.lane === 'READY_TO_CONTACT') {
    return Object.freeze({
      key: 'manifest_ready' as const,
      label: 'manifeste prêt',
      basis: 'texte, transport et destinataire figés',
      tone: 'blue' as const,
    });
  }
  if (input.lane === 'CONTACTED') {
    return Object.freeze({
      key: 'await_reply' as const,
      label: 'attendre la réponse',
      basis: 'envoi réel, aucune réponse reçue',
      tone: 'violet' as const,
    });
  }
  return Object.freeze({
    key: 'none' as const,
    label: '—',
    basis: 'aucune action enregistrée',
    tone: 'slate' as const,
  });
}
