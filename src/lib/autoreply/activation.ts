/**
 * HERMES-AUTO-REPLY-PRODUCTION-R1 §6 — la FRONTIÈRE d'activation.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce module répond, et ce qu'il ne répond pas
 * ---------------------------------------------------------------------------
 * Il répond à UNE question : « à partir de quel instant une conversation
 * peut-elle recevoir une réponse autonome ? ». Il ne répond pas à « faut-il
 * répondre maintenant » — c'est le crochet pré-effet qui décide de cela,
 * immédiatement avant le clic, et rien ici ne peut le remplacer ni le devancer.
 *
 * Une activation n'AUTORISE donc rien par elle-même. Elle retire UNE raison de
 * refuser, et laisse les autres exactement où elles sont.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi la frontière est l'instant présent, et rien d'autre
 * ---------------------------------------------------------------------------
 * Parce que la question à laquelle elle répond est « qu'est-ce qui existait
 * avant qu'on allume ? », et que cette question n'a qu'une réponse honnête :
 * tout ce qui est arrivé avant maintenant. Un paramètre `--frontier` aurait
 * permis de la reculer, donc de traiter du retard historique comme du travail
 * neuf — c'est-à-dire exactement ce que cette frontière existe pour empêcher.
 *
 * Il n'y a donc aucune option de date. La base la refuserait de toute façon
 * (`hermes_autoreply_activation_frontier_not_backdated`), et c'est délibéré :
 * une garde applicative seule se retire dans un diff qu'on relit mal.
 *
 * Elle est DURABLE parce que c'est une ligne, pas une variable de processus. Un
 * redémarrage, un crash, une machine qui reboote : la frontière ne bouge pas.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce module n'ouvre pas
 * ---------------------------------------------------------------------------
 * Aucun provider, aucun rail, aucune primitive d'envoi n'entre dans sa clôture
 * d'imports, et il n'importe pas `setKillSwitch`. Aucune exception nominative
 * non plus : ni prospect, ni compte, ni campagne, ni coquille. La frontière est
 * une DATE, la même pour tout le monde.
 */

import { COMMERCIAL_POLICY_VERSION } from '@/lib/conversation/commercialPolicy';
import { CONVERSATION_POLICY_VERSION } from '@/lib/conversation/autonomy';
import type { Sql } from '@/lib/db/sql';

export interface AutoReplyActivation {
  readonly id: string;
  /** L'instant à partir duquel un message entrant peut déclencher une réponse. */
  readonly frontierAt: string;
  readonly activatedAt: string;
  readonly activatedBy: string;
  readonly reason: string;
  readonly policyVersion: string;
  readonly commercialPolicyVersion: string;
  /** Le budget de DÉPLOIEMENT. `null` : aucune borne de déploiement. */
  readonly maxEffects: number | null;
  readonly revokedAt: string | null;
  readonly revokedBy: string | null;
  readonly revokeReason: string | null;
}

const COLUMNS = `
  id,
  frontier_at               as "frontierAt",
  activated_at              as "activatedAt",
  activated_by              as "activatedBy",
  reason,
  policy_version            as "policyVersion",
  commercial_policy_version as "commercialPolicyVersion",
  max_effects               as "maxEffects",
  revoked_at                as "revokedAt",
  revoked_by                as "revokedBy",
  revoke_reason             as "revokeReason"`;

interface ActivationRow {
  readonly id: string;
  readonly frontierAt: string | Date;
  readonly activatedAt: string | Date;
  readonly activatedBy: string;
  readonly reason: string;
  readonly policyVersion: string;
  readonly commercialPolicyVersion: string;
  readonly maxEffects: number | string | null;
  readonly revokedAt: string | Date | null;
  readonly revokedBy: string | null;
  readonly revokeReason: string | null;
}

function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

function hydrate(row: ActivationRow): AutoReplyActivation {
  return Object.freeze({
    id: row.id,
    frontierAt: iso(row.frontierAt),
    activatedAt: iso(row.activatedAt),
    activatedBy: row.activatedBy,
    reason: row.reason,
    policyVersion: row.policyVersion,
    commercialPolicyVersion: row.commercialPolicyVersion,
    maxEffects: row.maxEffects === null ? null : Number(row.maxEffects),
    revokedAt: row.revokedAt === null ? null : iso(row.revokedAt),
    revokedBy: row.revokedBy,
    revokeReason: row.revokeReason,
  });
}

export class AutoReplyActivationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AutoReplyActivationError';
    this.code = code;
  }
}

/**
 * L'activation VIVANTE, ou `null`.
 *
 * `null` est le défaut du dépôt et le côté fermé : sans ligne vivante, le
 * runtime d'auto-réponse ne traite aucune conversation. Ce n'est pas une panne,
 * c'est l'état de repos.
 */
export async function loadActiveAutoReplyActivation(sql: Sql): Promise<AutoReplyActivation | null> {
  const rows = await sql.query<ActivationRow>(
    `select ${COLUMNS} from hermes_autoreply_activations where revoked_at is null limit 1`,
  );
  const row = rows[0];
  return row === undefined ? null : hydrate(row);
}

export async function listAutoReplyActivations(
  sql: Sql,
  limit = 10,
): Promise<readonly AutoReplyActivation[]> {
  const bounded = Math.min(100, Math.max(1, Math.trunc(limit)));
  const rows = await sql.query<ActivationRow>(
    `select ${COLUMNS} from hermes_autoreply_activations order by activated_at desc limit $1`,
    [bounded],
  );
  return Object.freeze(rows.map(hydrate));
}

export interface ActivateAutoReplyInput {
  readonly activatedBy: string;
  readonly reason: string;
  /** Le budget de déploiement. `null` doit être ÉCRIT : il n'est pas le défaut. */
  readonly maxEffects: number | null;
}

/**
 * Arme le rail d'auto-réponse, à partir de MAINTENANT.
 *
 * `frontier_at` et `activated_at` prennent tous deux `now()` — l'horloge de la
 * base, dans la même instruction, donc la même valeur. Aucune date ne traverse
 * cette fonction : il n'y a rien à antidater.
 *
 * Lève plutôt que d'écraser quand une activation vit déjà. Réactiver
 * demanderait de reculer une frontière sans le dire, et c'est précisément le
 * geste qu'on veut rendre visible : révoquer, puis activer.
 */
export async function activateAutoReply(
  sql: Sql,
  input: ActivateAutoReplyInput,
): Promise<AutoReplyActivation> {
  const activatedBy = input.activatedBy.trim();
  const reason = input.reason.trim();
  if (activatedBy.length === 0) {
    throw new AutoReplyActivationError('ACTIVATION_ACTOR_MISSING', 'une activation se fait au nom de quelqu’un');
  }
  if (reason.length === 0) {
    throw new AutoReplyActivationError('ACTIVATION_REASON_MISSING', 'une activation porte un motif écrit');
  }
  if (input.maxEffects !== null && (!Number.isInteger(input.maxEffects) || input.maxEffects < 0)) {
    throw new AutoReplyActivationError(
      'ACTIVATION_BUDGET_INVALID',
      'le budget de déploiement est un entier positif, ou explicitement absent',
    );
  }

  const existing = await loadActiveAutoReplyActivation(sql);
  if (existing !== null) {
    throw new AutoReplyActivationError(
      'ACTIVATION_ALREADY_LIVE',
      `une activation vit déjà (${existing.id}, frontière ${existing.frontierAt}, posée par ` +
        `${existing.activatedBy}) — la révoquer d'abord ; réactiver recule la frontière, et cela se dit`,
    );
  }

  const rows = await sql.query<ActivationRow>(
    `insert into hermes_autoreply_activations
       (frontier_at, activated_at, activated_by, reason,
        policy_version, commercial_policy_version, max_effects)
     values (now(), now(), $1, $2, $3, $4, $5)
     returning ${COLUMNS}`,
    [activatedBy, reason, CONVERSATION_POLICY_VERSION, COMMERCIAL_POLICY_VERSION, input.maxEffects],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new AutoReplyActivationError('ACTIVATION_NOT_WRITTEN', 'l’activation n’a pas été inscrite');
  }
  return hydrate(row);
}

export interface RevokeAutoReplyInput {
  readonly revokedBy: string;
  readonly reason: string;
}

/**
 * Referme le rail. Idempotent au sens utile : rendre `null` veut dire « il n'y
 * avait rien d'ouvert », jamais « la révocation a échoué ».
 */
export async function revokeAutoReplyActivation(
  sql: Sql,
  input: RevokeAutoReplyInput,
): Promise<AutoReplyActivation | null> {
  const revokedBy = input.revokedBy.trim();
  const reason = input.reason.trim();
  if (revokedBy.length === 0) {
    throw new AutoReplyActivationError('REVOCATION_ACTOR_MISSING', 'une révocation se fait au nom de quelqu’un');
  }
  if (reason.length === 0) {
    throw new AutoReplyActivationError('REVOCATION_REASON_MISSING', 'une révocation porte un motif écrit');
  }
  const rows = await sql.query<ActivationRow>(
    `update hermes_autoreply_activations
        set revoked_at = now(), revoked_by = $1, revoke_reason = $2
      where revoked_at is null
      returning ${COLUMNS}`,
    [revokedBy, reason],
  );
  const row = rows[0];
  return row === undefined ? null : hydrate(row);
}

/**
 * Combien de réponses autonomes cette activation a déjà produites.
 *
 * La mesure est un EFFET TENTÉ, pas un envoi prouvé : une tentative dont on
 * ignore l'issue (`AMBIGUOUS`) a touché le monde exactement autant qu'un
 * succès, donc elle consomme le budget. C'est la même grandeur que
 * `msSinceLastExternalEffect` mesure pour la cadence, et pour la même raison.
 *
 * Le lien à l'activation passe par la FRONTIÈRE : un effet compte s'il a été
 * tenté sur un message reçu au plus tôt à la frontière. Aucune clé étrangère
 * n'est ajoutée — la frontière est déjà l'identité de l'activation, et une
 * seconde façon de dire la même chose finirait par la contredire.
 */
export async function countActivationEffects(
  sql: Sql,
  activation: AutoReplyActivation,
): Promise<number> {
  const rows = await sql.query<{ n: string }>(
    `select count(*)::text as n
       from hermes_conversation_plans p
       join r6b_inbound_messages i on i.id = p.trigger_inbound_message_id
      where p.external_effect_attempted = true
        and p.kind = 'AUTO_REPLY'
        and i.received_at >= $1::timestamptz`,
    [activation.frontierAt],
  );
  return Number(rows[0]?.n ?? '0');
}

/** Le verdict du budget de déploiement, dans un vocabulaire fermé. */
export type RolloutBudgetVerdict =
  | { readonly open: true; readonly remaining: number | null; readonly detail: string }
  | { readonly open: false; readonly remaining: 0; readonly detail: string };

/**
 * Le budget de déploiement, lu et rien de plus.
 *
 * Pure et fail-closed : un budget négatif ou illisible referme. Elle ne lit ni
 * plafond Instagram, ni fenêtre, ni cadence — ceux-là vivent dans
 * `evaluateSafety` et `evaluateSchedule`, ils restent intégralement devant, et
 * un budget ouvert ne dit rien de leur état.
 */
export function assessRolloutBudget(
  activation: AutoReplyActivation,
  effectsSoFar: number,
): RolloutBudgetVerdict {
  const max = activation.maxEffects;
  if (max === null) {
    return Object.freeze({
      open: true as const,
      remaining: null,
      detail: 'aucune borne de déploiement — seuls les plafonds Instagram bornent le volume',
    });
  }
  if (!Number.isInteger(effectsSoFar) || effectsSoFar < 0) {
    return Object.freeze({
      open: false as const,
      remaining: 0 as const,
      detail: 'le nombre d’effets déjà produits est illisible — le côté sûr est de refermer',
    });
  }
  const remaining = max - effectsSoFar;
  if (remaining <= 0) {
    return Object.freeze({
      open: false as const,
      remaining: 0 as const,
      detail:
        `budget de déploiement épuisé : ${String(effectsSoFar)} réponse(s) autonome(s) sur ${String(max)} ` +
        'depuis la frontière — révoquer puis réactiver pour en ouvrir d’autres',
    });
  }
  return Object.freeze({
    open: true as const,
    remaining,
    detail: `${String(remaining)} réponse(s) restante(s) sur ${String(max)} pour cette activation`,
  });
}
