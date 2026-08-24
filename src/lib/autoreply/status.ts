/**
 * HERMES-AUTO-REPLY-PRODUCTION-R1 §5/§8/§9 — ce qu'un opérateur doit pouvoir
 * lire sans ouvrir la base.
 *
 * ---------------------------------------------------------------------------
 * Les quatre états qu'il fallait cesser de confondre
 * ---------------------------------------------------------------------------
 * « Le rail répond-il tout seul ? » n'a jamais été UNE question. C'en est
 * quatre, et les confondre produit les deux erreurs de diagnostic les plus
 * coûteuses :
 *
 *   CONFIGURÉ   une activation vit-elle ?             → hermes_autoreply_activations
 *   VIVANT      un processus bat-il ?                 → hermes_autoreply_heartbeats
 *   PERMIS      l'envoi est-il autorisé maintenant ?  → arrêt global + plafonds + fenêtre
 *   EN ATTENTE  un plan attend-il son heure ?         → hermes_conversation_plans
 *
 * Un plafond atteint n'est PAS un runtime cassé. Un processus qui tourne n'est
 * PAS un envoi autorisé. Ce module rend les quatre séparément, et ne les
 * agrège jamais en un seul feu vert.
 *
 * ---------------------------------------------------------------------------
 * Rien n'est écrit, rien n'est ouvert
 * ---------------------------------------------------------------------------
 * Que des `select`, plus une lecture de fichier pour le bail du profil.
 * Aucun navigateur, aucun provider, aucune primitive d'envoi n'entre dans la
 * clôture d'imports, et `setKillSwitch` n'y est pas.
 *
 * Le verdict de sûreté rendu ici est celui que la BOUCLE prendrait au même
 * instant : ce sont les mêmes fonctions pures, sur le même état lu. Une seconde
 * lecture des plafonds aurait fini par diverger, et c'est le tableau de bord
 * qui aurait menti.
 */

import {
  loadActiveAutoReplyActivation,
  countActivationEffects,
  assessRolloutBudget,
  type AutoReplyActivation,
  type RolloutBudgetVerdict,
} from '@/lib/autoreply/activation';
import { loadAutoReplyHeartbeats, type AutoReplyHeartbeat } from '@/lib/autoreply/heartbeat';
import { readCodeRevision } from '@/lib/inbound/codeRevision';
import { loadInboundRuntimeState } from '@/lib/inbound/instagramRuntime';
import {
  inspectInstagramBrowserLease,
  type InstagramBrowserLeaseState,
} from '@/lib/instagram/browserProfileLease';
import { evaluateSafety, loadSafetySnapshot, type SafetyVerdict } from '@/lib/instagram/safety';
import { evaluateSchedule, loadScheduleSnapshot } from '@/lib/instagram/scheduler';
import type { InstagramRailConfig } from '@/lib/config/schema';
import type { Sql } from '@/lib/db/sql';

export interface InboundPollHealth {
  readonly lastSuccessfulAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly lastStatus: string | null;
  readonly lastReadability: string | null;
  readonly consecutiveFailures: number;
  readonly runningSince: string | null;
  readonly runningBy: string | null;
  readonly runningLeaseExpiresAt: string | null;
}

export interface LatestPlanDecision {
  readonly planId: string;
  readonly prospectId: string;
  readonly displayName: string;
  readonly decision: string;
  readonly decisionReason: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly externalEffectAttempted: boolean;
}

export interface LatestEffect {
  readonly planId: string;
  readonly prospectId: string;
  readonly displayName: string;
  readonly status: string;
  readonly reasonCode: string;
  readonly targetHandle: string;
  readonly createdAt: string;
  readonly deliveryConfirmed: boolean;
}

/**
 * §8 — une escalade, telle qu'un opérateur doit la voir.
 *
 * Aucune table nouvelle : une escalade EST un plan `HUMAN_ESCALATION` inscrit
 * `BLOCKED`, avec son motif, sa porte, son déclencheur et l'analyse qui l'a
 * produite. Ce qui manquait n'était pas la donnée, c'était la LECTURE qui les
 * met côte à côte. En inventer une seconde aurait créé deux vérités.
 */
export interface EscalationRow {
  readonly planId: string;
  readonly prospectId: string;
  readonly displayName: string;
  readonly handle: string | null;
  readonly threadId: string | null;
  readonly inboundMessageId: string | null;
  readonly inboundText: string;
  readonly receivedAt: string | null;
  readonly classification: string | null;
  readonly confidence: number | null;
  readonly reason: string | null;
  readonly gate: string;
  readonly detail: string | null;
  readonly draftBody: string | null;
  readonly draftStatus: string | null;
  readonly createdAt: string;
  /** Un tour PLUS RÉCENT existe-t-il ? Une escalade dépassée n'attend plus rien. */
  readonly supersededByNewerTurn: boolean;
}

export interface AutoReplyStatus {
  // --- CONFIGURÉ -----------------------------------------------------------
  readonly activation: AutoReplyActivation | null;
  readonly rollout: RolloutBudgetVerdict | null;
  readonly effectsSinceFrontier: number;
  // --- VIVANT --------------------------------------------------------------
  readonly heartbeats: readonly AutoReplyHeartbeat[];
  readonly inbound: InboundPollHealth;
  readonly codeRevision: string | null;
  readonly browserLease: InstagramBrowserLeaseState;
  // --- PERMIS --------------------------------------------------------------
  readonly killSwitchEngaged: boolean;
  readonly killSwitchSetBy: string | null;
  readonly safety: SafetyVerdict;
  readonly sentLastDay: number;
  readonly sentLastHour: number;
  readonly dailyCap: number;
  readonly hourlyCap: number;
  readonly windowOpen: boolean;
  readonly scheduleDetail: string;
  /** Quand un envoi redeviendra possible, si c'est DÉTERMINABLE. `null` sinon. */
  readonly nextEligibleAt: string | null;
  // --- EN ATTENTE ----------------------------------------------------------
  readonly livePlans: number;
  readonly claimedPlans: number;
  readonly latestDecision: LatestPlanDecision | null;
  readonly latestEffect: LatestEffect | null;
  readonly escalations: readonly EscalationRow[];
  readonly openEscalations: number;
}

async function count(sql: Sql, text: string, params: readonly unknown[] = []): Promise<number> {
  const rows = await sql.query<{ n: string }>(text, params);
  return Number(rows[0]?.n ?? '0');
}

function iso(value: string | Date | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export async function loadAutoReplyStatus(
  sql: Sql,
  config: InstagramRailConfig,
  options: { readonly root: string; readonly now?: Date; readonly escalationLimit?: number },
): Promise<AutoReplyStatus> {
  const now = options.now ?? new Date();

  const activation = await loadActiveAutoReplyActivation(sql);
  const effectsSinceFrontier = activation === null ? 0 : await countActivationEffects(sql, activation);
  const rollout = activation === null ? null : assessRolloutBudget(activation, effectsSinceFrontier);

  const safetySnapshot = await loadSafetySnapshot(sql, config);
  const safety = evaluateSafety(safetySnapshot, config);
  const schedule = evaluateSchedule({ snapshot: await loadScheduleSnapshot(sql, config), config, now });

  // L'état du rail ENTRANT, lu par la fonction qui en fait autorité. Recopier
  // ses trois requêtes aurait produit une seconde définition de « relève
  // réussie » — et `isSuccessfulPoll` rappelle que `COMPLETED` ne suffit pas :
  // une boîte illisible est un tour terminé qui n'a rien relevé.
  const inboundState =
    config.inbound.accountHandle === null
      ? null
      : await loadInboundRuntimeState(sql, config.inbound.accountHandle);

  const [livePlans, claimedPlans] = await Promise.all([
    count(
      sql,
      `select count(*)::text as n from hermes_conversation_plans
        where kind = 'AUTO_REPLY' and status in ('PLANNED','SKIPPED')`,
    ),
    count(
      sql,
      `select count(*)::text as n from hermes_conversation_plans
        where kind = 'AUTO_REPLY' and status = 'CLAIMED' and lease_expires_at > now()`,
    ),
  ]);

  const decisionRows = await sql.query<{
    planId: string;
    prospectId: string;
    displayName: string;
    decision: string;
    decisionReason: string | null;
    status: string;
    createdAt: string | Date;
    externalEffectAttempted: boolean;
  }>(
    `select c.id                        as "planId",
            c.prospect_id               as "prospectId",
            p.display_name              as "displayName",
            c.decision,
            c.decision_reason           as "decisionReason",
            c.status,
            c.created_at                as "createdAt",
            c.external_effect_attempted as "externalEffectAttempted"
       from hermes_conversation_plans c
       join prospects p on p.id = c.prospect_id
      where c.kind = 'AUTO_REPLY'
      order by c.created_at desc, c.id desc
      limit 1`,
  );

  const effectRows = await sql.query<{
    planId: string;
    prospectId: string;
    displayName: string;
    status: string;
    reasonCode: string;
    targetHandle: string;
    createdAt: string | Date;
    deliveryConfirmed: boolean;
  }>(
    `select e.plan_id            as "planId",
            e.prospect_id        as "prospectId",
            p.display_name       as "displayName",
            e.status,
            e.reason_code        as "reasonCode",
            e.target_handle      as "targetHandle",
            e.created_at         as "createdAt",
            e.delivery_confirmed as "deliveryConfirmed"
       from hermes_conversation_effects e
       join prospects p on p.id = e.prospect_id
      where e.effect_attempted = true
      order by e.created_at desc, e.id desc
      limit 1`,
  );

  const escalations = await loadOpenEscalations(sql, options.escalationLimit ?? 20);
  const kill = safetySnapshot.killSwitch;

  return Object.freeze({
    activation,
    rollout,
    effectsSinceFrontier,
    heartbeats: await loadAutoReplyHeartbeats(sql, 10),
    inbound: Object.freeze({
      lastSuccessfulAt: iso(inboundState?.lastSuccessful?.finishedAt ?? null),
      lastAttemptAt: iso(inboundState?.lastTerminal?.finishedAt ?? null),
      lastStatus: inboundState?.lastTerminal?.status ?? null,
      lastReadability: inboundState?.lastTerminal?.inboxReadability ?? null,
      consecutiveFailures: inboundState?.consecutiveFailures ?? 0,
      runningSince: iso(inboundState?.running?.startedAt ?? null),
      runningBy: inboundState?.running?.polledBy ?? null,
      runningLeaseExpiresAt: iso(inboundState?.running?.leaseExpiresAt ?? null),
    }),
    codeRevision: readCodeRevision(options.root),
    browserLease: inspectInstagramBrowserLease(config.session.profileDir),
    killSwitchEngaged: kill.engaged,
    killSwitchSetBy: kill.setBy,
    safety,
    sentLastDay: safetySnapshot.sentLastDay,
    sentLastHour: safetySnapshot.sentLastHour,
    dailyCap: config.caps.dailySentCap,
    hourlyCap: config.caps.hourlySentCap,
    windowOpen: schedule.allowed,
    scheduleDetail: schedule.allowed ? 'la fenêtre est ouverte' : `${schedule.reason} — ${schedule.detail}`,
    nextEligibleAt: schedule.allowed ? null : iso(schedule.nextEligibleAt),
    livePlans,
    claimedPlans,
    latestDecision:
      decisionRows[0] === undefined
        ? null
        : Object.freeze({ ...decisionRows[0], createdAt: new Date(decisionRows[0].createdAt).toISOString() }),
    latestEffect:
      effectRows[0] === undefined
        ? null
        : Object.freeze({ ...effectRows[0], createdAt: new Date(effectRows[0].createdAt).toISOString() }),
    escalations,
    openEscalations: escalations.filter((row) => !row.supersededByNewerTurn).length,
  });
}

/**
 * Les escalades, du plus récent au plus ancien.
 *
 * Une escalade ne DISPARAÎT jamais : son plan est `BLOCKED`, statut absorbant,
 * et rien ici ne l'efface. Ce que cette lecture ajoute est le seul fait qu'un
 * opérateur ne peut pas déduire du plan seul — un tour PLUS RÉCENT est-il
 * arrivé depuis ? Une escalade dépassée reste vraie, mais elle n'attend plus
 * personne, et la ranger au même niveau qu'une escalade vivante ferait
 * regarder au mauvais endroit.
 */
export async function loadOpenEscalations(sql: Sql, limit = 20): Promise<readonly EscalationRow[]> {
  const bounded = Math.min(100, Math.max(1, Math.trunc(limit)));
  const rows = await sql.query<{
    planId: string;
    prospectId: string;
    displayName: string;
    handle: string | null;
    threadId: string | null;
    inboundMessageId: string | null;
    inboundText: string | null;
    receivedAt: string | Date | null;
    classification: string | null;
    confidence: string | number | null;
    reason: string | null;
    gate: string;
    detail: string | null;
    draftBody: string | null;
    draftStatus: string | null;
    createdAt: string | Date;
    supersededByNewerTurn: boolean;
  }>(
    `select c.id                     as "planId",
            c.prospect_id            as "prospectId",
            p.display_name           as "displayName",
            p.instagram_handle       as "handle",
            i.provider_thread_id     as "threadId",
            i.id                     as "inboundMessageId",
            left(i.body_text, 400)   as "inboundText",
            i.received_at            as "receivedAt",
            a.classification,
            a.confidence,
            c.decision_reason        as "reason",
            c.decision_gate          as "gate",
            left(c.decision_detail, 400) as "detail",
            d.body                   as "draftBody",
            d.status                 as "draftStatus",
            c.created_at             as "createdAt",
            exists (
              select 1 from r6b_inbound_messages n
               where n.correlated_prospect_id = c.prospect_id
                 and n.correlation_status in ('EXACT','HIGH_CONFIDENCE')
                 and (n.received_at, n.id) > (i.received_at, i.id)
            )                        as "supersededByNewerTurn"
       from hermes_conversation_plans c
       join prospects p on p.id = c.prospect_id
       left join r6b_inbound_messages i on i.id = c.trigger_inbound_message_id
       left join r6b_reply_analyses a on a.inbound_message_id = i.id and a.status = 'ACTIVE'
       left join lateral (
         select r.body, r.status
           from r6b_reply_drafts r
          where r.analysis_id = a.id
          order by r.created_at desc, r.id desc
          limit 1
       ) d on true
      where c.decision = 'HUMAN_ESCALATION'
      order by c.created_at desc, c.id desc
      limit $1`,
    [bounded],
  );

  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        planId: row.planId,
        prospectId: row.prospectId,
        displayName: row.displayName,
        handle: row.handle,
        threadId: row.threadId,
        inboundMessageId: row.inboundMessageId,
        inboundText: row.inboundText ?? '',
        receivedAt: iso(row.receivedAt),
        classification: row.classification,
        confidence: row.confidence === null ? null : Number(row.confidence),
        reason: row.reason,
        gate: row.gate,
        detail: row.detail,
        draftBody: row.draftBody,
        draftStatus: row.draftStatus,
        createdAt: new Date(row.createdAt).toISOString(),
        supersededByNewerTurn: row.supersededByNewerTurn,
      }),
    ),
  );
}
