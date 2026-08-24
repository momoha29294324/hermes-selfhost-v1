/**
 * CRM-UX-R1 — les mots de la machine, dits à un opérateur.
 *
 * ---------------------------------------------------------------------------
 * Traduire n'est pas remplacer
 * ---------------------------------------------------------------------------
 *
 * L'écran affichait `HUMAN_REPLY_NOW`, `INFORMATION_SHARED`, `EXACT` — les
 * identifiants exacts de la base. C'est irréprochable côté fidélité et illisible
 * côté travail : sur une ligne d'Inbox, la colonne qui compte demandait une
 * traduction mentale à chaque lecture, pendant qu'une pastille verte de
 * corrélation technique attirait l'œil.
 *
 * Ce module rend une PHRASE, un POIDS et une TEINTE pour chaque identifiant —
 * et conserve l'identifiant. La règle est stricte :
 *
 *   1. la phrase est une traduction, jamais une interprétation. « Répondre —
 *      maintenant » dit ce que `HUMAN_REPLY_NOW` dit, ni plus ni moins ;
 *   2. l'identifiant reste ATTEIGNABLE — en infobulle, et en clair dans les
 *      surfaces de provenance. Un opérateur qui ouvre la base doit retrouver
 *      le même mot ;
 *   3. un identifiant INCONNU n'est pas masqué et n'est pas deviné : il est
 *      rendu tel quel, en ardoise, et `known` vaut `false`. Le jour où la
 *      taxonomie gagne une valeur, l'écran l'affiche brute plutôt que de
 *      mentir ou de disparaître.
 *
 * Les unions viennent de `@/lib/replies/taxonomy`, mais les tables ci-dessous
 * sont indexées par CHAÎNE : ces colonnes sont du texte en base, et une valeur
 * écrite par une version antérieure du classifieur doit pouvoir s'afficher sans
 * faire tomber la page.
 */

import type { CrmTier, CrmTone } from '@/lib/crm/view';

export interface CrmTerm {
  /** La phrase montrée à l'opérateur. */
  readonly label: string;
  /** L'identifiant canonique, tel qu'il est en base. Jamais perdu. */
  readonly raw: string;
  readonly tone: CrmTone;
  readonly tier: CrmTier;
  /** `false` quand aucune traduction n'existe : le libellé EST l'identifiant. */
  readonly known: boolean;
}

interface Entry {
  readonly label: string;
  readonly tone: CrmTone;
  readonly tier: CrmTier;
}

function term(raw: string, entry: Entry | undefined): CrmTerm {
  if (entry === undefined) {
    return Object.freeze({ label: raw, raw, tone: 'slate' as const, tier: 4 as const, known: false });
  }
  return Object.freeze({ label: entry.label, raw, tone: entry.tone, tier: entry.tier, known: true });
}

/**
 * `NextAction` — ce que le système dit qu'il faut faire ensuite.
 *
 * Deux valeurs seulement sont de palier 1, et ce sont les deux qui ne peuvent
 * pas attendre : quelqu'un a écrit et attend une réponse, ou une porte doit
 * être fermée définitivement. Tout le reste peut être lu plus tard, donc recule.
 *
 * ---------------------------------------------------------------------------
 * Le palier écrit ici est une urgence INTRINSÈQUE, pas un ordre d'affichage
 * ---------------------------------------------------------------------------
 *
 * Une surface a le droit de le RABAISSER quand cette urgence y est la norme, et
 * `TermBadge` accepte un palier explicite pour cela. Le cas est réel : dans la
 * liste des prospects, `HUMAN_REPLY_NOW` est l'exception au milieu de cinquante
 * lignes sans action, et doit sauter aux yeux ; dans l'Inbox, presque chaque
 * ligne le porte — l'y peindre en palier 1 vingt fois de suite ne hiérarchise
 * plus rien, cela repeint simplement la page en orange.
 *
 * Aucune surface n'a le droit de le REMONTER : c'est ce qui garantit qu'une
 * teinte d'alerte ne peut pas apparaître là où la taxonomie n'en met pas.
 */
const NEXT_ACTIONS: Readonly<Record<string, Entry>> = Object.freeze({
  HUMAN_REPLY_NOW: { label: 'Répondre — maintenant', tone: 'orange', tier: 1 },
  SUPPRESS_PERMANENTLY: { label: 'Supprimer définitivement', tone: 'red', tier: 1 },
  HUMAN_REVIEW: { label: 'À relire par un humain', tone: 'orange', tier: 2 },
  STOP_COLD_FOLLOW_UP: { label: 'Arrêter la relance à froid', tone: 'red', tier: 2 },
  MARK_CHANNEL_UNUSABLE: { label: 'Canal inutilisable', tone: 'red', tier: 2 },
  NURTURE_LATER: { label: 'Reprendre plus tard', tone: 'slate', tier: 3 },
  NO_ACTION: { label: 'Rien à faire', tone: 'slate', tier: 4 },
});

export function nextActionTerm(value: string | null | undefined): CrmTerm | null {
  if (value === null || value === undefined || value.length === 0) return null;
  return term(value, NEXT_ACTIONS[value]);
}

/**
 * `ReplyCategory` — ce que le classifieur a compris du message.
 *
 * Aucune de ces valeurs n'est de palier 1 : comprendre un message n'est pas une
 * consigne. Ce qui demande une décision, c'est l'action recommandée qui en
 * découle, et elle a sa propre colonne. Deux paliers 1 côte à côte reviendraient
 * à n'en avoir aucun.
 */
const REPLY_CATEGORIES: Readonly<Record<string, Entry>> = Object.freeze({
  INTERESTED: { label: 'Intéressé', tone: 'green', tier: 2 },
  QUESTION: { label: 'Question', tone: 'orange', tier: 2 },
  INFORMATION_SHARED: { label: 'Donne une info', tone: 'green', tier: 2 },
  OBJECTION: { label: 'Objection', tone: 'orange', tier: 2 },
  NOT_NOW: { label: 'Pas maintenant', tone: 'orange', tier: 2 },
  NOT_INTERESTED: { label: 'Pas intéressé', tone: 'red', tier: 2 },
  UNSUBSCRIBE: { label: 'Demande l’arrêt', tone: 'red', tier: 1 },
  AUTO_REPLY: { label: 'Réponse automatique', tone: 'slate', tier: 3 },
  BOUNCE: { label: 'Non remis', tone: 'red', tier: 2 },
  OTHER: { label: 'Autre', tone: 'slate', tier: 3 },
  REVIEW_REQUIRED: { label: 'Non tranché', tone: 'orange', tier: 2 },
});

export function replyCategoryTerm(value: string | null | undefined): CrmTerm | null {
  if (value === null || value === undefined || value.length === 0) return null;
  return term(value, REPLY_CATEGORIES[value]);
}

/**
 * `CorrelationStatus` — à quel point on est sûr que ce message vient bien de ce
 * prospect.
 *
 * C'est une garantie TECHNIQUE, pas un fait commercial : elle appartient au
 * palier 3, et `EXACT` — le cas normal — au palier 4. Une pastille verte vive
 * sur chaque ligne pour dire « rien d'anormal » consommait l'attention que la
 * colonne d'action réclamait. Seul ce qui s'écarte du normal reste visible.
 */
const CORRELATIONS: Readonly<Record<string, Entry>> = Object.freeze({
  EXACT: { label: 'Exacte', tone: 'slate', tier: 4 },
  HIGH_CONFIDENCE: { label: 'Probable', tone: 'blue', tier: 3 },
  AMBIGUOUS: { label: 'Ambiguë', tone: 'orange', tier: 2 },
  UNMATCHED: { label: 'Non corrélé', tone: 'red', tier: 2 },
});

export function correlationTerm(value: string | null | undefined): CrmTerm | null {
  if (value === null || value === undefined || value.length === 0) return null;
  return term(value, CORRELATIONS[value]);
}

/**
 * Le statut d'un brouillon de réponse.
 *
 * `PROPOSED` est le seul qui appelle quelqu'un : un texte écrit que personne
 * n'a encore lu. Les autres sont des constats.
 */
const DRAFT_STATUSES: Readonly<Record<string, Entry>> = Object.freeze({
  PROPOSED: { label: 'À relire', tone: 'orange', tier: 2 },
  APPROVED: { label: 'Approuvé', tone: 'green', tier: 3 },
  EDITED: { label: 'Réécrit', tone: 'green', tier: 3 },
  REJECTED: { label: 'Rejeté', tone: 'red', tier: 3 },
  SENT: { label: 'Remis', tone: 'cyan', tier: 3 },
});

export function draftStatusTerm(value: string | null | undefined): CrmTerm | null {
  if (value === null || value === undefined || value.length === 0) return null;
  return term(value, DRAFT_STATUSES[value]);
}

/**
 * La sévérité d'une alerte, telle que `r6b_alerts` l'écrit.
 *
 * `URGENT` est ORANGE, pas rouge. Le rouge de ce CRM dit une porte fermée —
 * refus, suppression, échec d'envoi — et une alerte speed-to-lead ne ferme
 * rien : elle dit que quelqu'un attend, ce qui est exactement la définition de
 * l'orange. Peindre en rouge la totalité d'une page d'alertes revenait par
 * ailleurs à annoncer vingt-huit catastrophes là où il y a vingt-huit
 * conversations à reprendre.
 */
const SEVERITIES: Readonly<Record<string, Entry>> = Object.freeze({
  URGENT: { label: 'Urgent', tone: 'orange', tier: 2 },
  NORMAL: { label: 'Normal', tone: 'slate', tier: 3 },
});

export function severityTerm(value: string | null | undefined): CrmTerm | null {
  if (value === null || value === undefined || value.length === 0) return null;
  return term(value, SEVERITIES[value]);
}

/**
 * Le statut de REMISE d'une alerte.
 *
 * `NO_PROVIDER` n'est pas une panne : aucun fournisseur de notification n'est
 * configuré dans ce dépôt, et c'est un choix. L'alerte attend donc qu'un humain
 * la voie — ce qui est exactement ce que fait la page où elle s'affiche.
 */
const ALERT_STATUSES: Readonly<Record<string, Entry>> = Object.freeze({
  PENDING: { label: 'En attente', tone: 'orange', tier: 3 },
  NO_PROVIDER: { label: 'Vue ici', tone: 'slate', tier: 4 },
  DELIVERED: { label: 'Remise', tone: 'green', tier: 4 },
  FAILED: { label: 'Échec de remise', tone: 'red', tier: 2 },
});

export function alertStatusTerm(value: string | null | undefined): CrmTerm | null {
  if (value === null || value === undefined || value.length === 0) return null;
  return term(value, ALERT_STATUSES[value]);
}
