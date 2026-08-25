/**
 * HERMES-FIRST-TOUCH-BOUNDED-ACTIVATION-R1 — le budget DURABLE du rail de
 * premier contact.
 *
 * Le jumeau de `src/lib/autoreply/activation.ts`, délibérément : les deux rails
 * répondent à la même question — « ce déploiement a-t-il encore le droit de
 * produire un effet ? » — et un lecteur qui connaît l'un doit reconnaître
 * l'autre sans relire.
 *
 * Ce qu'il remplace : `--max-effects`, qui bornait un CYCLE. En `--loop`, trois
 * effets étaient autorisés, puis trois de plus, indéfiniment. Le compteur
 * vivait en mémoire, donc repartait à zéro à chaque redémarrage — et redémarrer
 * est le cas normal d'un runtime (crash, sentinelle de révision, reboot). Ici
 * le compte est LU EN BASE à chaque tour, ce qui le rend insensible aux cycles
 * comme aux redémarrages.
 *
 * Ce que ce module n'est pas : un plafond de volume. 10/jour, 3/heure,
 * l'espacement de quinze minutes et la fenêtre vivent dans `evaluateSafety` et
 * `evaluateSchedule`, ils restent intégralement devant, et un budget ouvert ne
 * dit rien de leur état.
 */
import type { Sql } from '@/lib/db';

export interface FirstTouchActivation {
  readonly id: string;
  /** Écrite par la base. Un effet antérieur ne consomme pas ce budget. */
  readonly frontierAt: string;
  readonly activatedAt: string;
  readonly activatedBy: string;
  readonly reason: string;
  readonly policyVersion: string;
  /** `null` = sans borne. La COMMANDE exige `--unbounded` pour l'écrire. */
  readonly maxEffects: number | null;
  readonly revokedAt: string | null;
  readonly revokedBy: string | null;
  readonly revokeReason: string | null;
}

const COLUMNS = `
  id,
  frontier_at    as "frontierAt",
  activated_at   as "activatedAt",
  activated_by   as "activatedBy",
  reason,
  policy_version as "policyVersion",
  max_effects    as "maxEffects",
  revoked_at     as "revokedAt",
  revoked_by     as "revokedBy",
  revoke_reason  as "revokeReason"
`;

/** L'activation vivante, ou `null`. L'index unique en garantit au plus une. */
export async function loadActiveFirstTouchActivation(sql: Sql): Promise<FirstTouchActivation | null> {
  const rows = await sql.query<FirstTouchActivation>(
    `select ${COLUMNS} from hermes_firsttouch_activations where revoked_at is null limit 1`,
  );
  return rows[0] ?? null;
}

export async function listFirstTouchActivations(sql: Sql, limit = 10): Promise<FirstTouchActivation[]> {
  return sql.query<FirstTouchActivation>(
    `select ${COLUMNS} from hermes_firsttouch_activations order by activated_at desc limit $1`,
    [limit],
  );
}

export interface ActivateFirstTouchInput {
  readonly activatedBy: string;
  readonly reason: string;
  readonly policyVersion: string;
  /**
   * `null` n'est PAS un défaut : la commande refuse de l'écrire sans
   * `--unbounded` explicite. Un oubli d'option ne doit pas produire un rail
   * illimité.
   */
  readonly maxEffects: number | null;
}

export async function activateFirstTouch(
  sql: Sql,
  input: ActivateFirstTouchInput,
): Promise<FirstTouchActivation> {
  const activatedBy = input.activatedBy.trim();
  const reason = input.reason.trim();
  if (activatedBy.length === 0) throw new Error('activatedBy est obligatoire : une activation porte un nom');
  if (reason.length === 0) throw new Error('reason est obligatoire : une activation porte un motif');
  if (input.maxEffects !== null && (!Number.isInteger(input.maxEffects) || input.maxEffects < 0)) {
    throw new Error('maxEffects doit être un entier positif ou null');
  }

  // `frontier_at` n'est pas passée : c'est la base qui l'écrit (`default now()`),
  // et la contrainte `frontier_not_backdated` refuserait une valeur antidatée.
  const rows = await sql.query<FirstTouchActivation>(
    `insert into hermes_firsttouch_activations (activated_by, reason, policy_version, max_effects)
     values ($1, $2, $3, $4)
     returning ${COLUMNS}`,
    [activatedBy, reason, input.policyVersion, input.maxEffects],
  );
  const created = rows[0];
  if (created === undefined) throw new Error('activation non insérée');
  return created;
}

export interface RevokeFirstTouchInput {
  readonly revokedBy: string;
  readonly reason: string;
}

export async function revokeFirstTouchActivation(
  sql: Sql,
  input: RevokeFirstTouchInput,
): Promise<FirstTouchActivation | null> {
  const revokedBy = input.revokedBy.trim();
  const reason = input.reason.trim();
  if (revokedBy.length === 0) throw new Error('revokedBy est obligatoire');
  if (reason.length === 0) throw new Error('reason est obligatoire');

  const rows = await sql.query<FirstTouchActivation>(
    `update hermes_firsttouch_activations
        set revoked_at = now(), revoked_by = $1, revoke_reason = $2
      where revoked_at is null
      returning ${COLUMNS}`,
    [revokedBy, reason],
  );
  return rows[0] ?? null;
}

/**
 * Combien d'effets de premier contact ce déploiement a-t-il produits ?
 *
 * Lu en BASE, donc insensible aux cycles et aux redémarrages — c'est tout
 * l'objet de cette table. `external_effect_attempted` et non « envoyé » : un
 * effet TENTÉ compte, même si sa remise est restée ambiguë. Compter les seuls
 * envois prouvés laisserait un `AMBIGUOUS` libérer une place, c'est-à-dire
 * transformerait un doute en permission.
 *
 * Fail-closed sur l'horodatage : un effet dont on ne sait pas dire QUAND il a
 * eu lieu est compté CONTRE le budget. Il pourrait être postérieur à la
 * frontière, et l'écarter serait le supposer antérieur sans preuve.
 */
export async function countFirstTouchActivationEffects(
  sql: Sql,
  activation: FirstTouchActivation,
): Promise<number> {
  const rows = await sql.query<{ n: string }>(
    `select count(*)::text as n
       from ig_dispatch_jobs
      where external_effect_attempted = true
        and (external_effect_started_at is null
             or external_effect_started_at >= $1::timestamptz)`,
    [activation.frontierAt],
  );
  return Number(rows[0]?.n ?? '0');
}

/** Le verdict du budget, dans un vocabulaire fermé. */
export type FirstTouchBudgetVerdict =
  | { readonly open: true; readonly remaining: number | null; readonly detail: string }
  | { readonly open: false; readonly remaining: 0; readonly detail: string };

/**
 * Le budget, lu et rien de plus. Pure et fail-closed : un compte négatif ou
 * illisible referme. Elle ne lit ni plafond Instagram, ni fenêtre, ni cadence.
 */
export function assessFirstTouchBudget(
  activation: FirstTouchActivation,
  effectsSoFar: number,
): FirstTouchBudgetVerdict {
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
        `budget de déploiement épuisé : ${String(effectsSoFar)} premier(s) contact(s) sur ${String(max)} ` +
        'depuis la frontière — révoquer puis réactiver pour en ouvrir d’autres',
    });
  }
  return Object.freeze({
    open: true as const,
    remaining,
    detail: `${String(remaining)} premier(s) contact(s) restant(s) sur ${String(max)} pour cette activation`,
  });
}
