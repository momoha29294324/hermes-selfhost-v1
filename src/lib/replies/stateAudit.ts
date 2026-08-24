/**
 * HERMES-TARGETING-R1 §8 — regarder d'abord, réparer ensuite, et seulement ce
 * qui est prouvé.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi un module séparé plutôt qu'un `update` bien senti
 * ---------------------------------------------------------------------------
 * L'anomalie observée en production — « une réponse est là, le prospect reste
 * `CONTACTED` » — a plusieurs causes possibles, et elles n'appellent PAS le
 * même geste :
 *
 *   * le pipeline n'a jamais tourné sur ce message (aucune analyse vivante).
 *     Rien à réparer dans l'état : il faut faire tourner
 *     `r6b:replies:process`, qui classera puis progressera tout seul. Écrire
 *     `REPLIED` à la main ici inventerait une conclusion que personne n'a
 *     rendue — interdit n°2 ;
 *   * le pipeline a tourné, l'analyse existe, et elle établit qu'un humain a
 *     écrit — mais elle date d'avant l'accusé de réponse, donc l'état est resté
 *     en arrière. C'est le SEUL cas réparable, et sa réparation ne décide rien :
 *     elle rejoue les transitions canoniques à partir d'une décision DÉJÀ
 *     enregistrée ;
 *   * l'analyse dit `AUTO_REPLY` ou `BOUNCE`. Alors l'état a raison et le
 *     rapport a tort : personne n'a répondu.
 *
 * Un audit qui ne distinguerait pas ces trois-là finirait par écrire `REPLIED`
 * sur des accusés d'absence.
 *
 * ---------------------------------------------------------------------------
 * Ce que la réparation ne fait pas
 * ---------------------------------------------------------------------------
 * Elle n'appelle aucun modèle, n'écrit aucune analyse, ne classe rien, ne
 * touche ni aux suppressions ni au CRM ni aux alertes. Elle appelle exactement
 * les deux fonctions que `processReply` appelle — `acknowledgeReply` puis
 * `applyTransition` — avec pour cause le message entrant et pour justification
 * l'analyse existante. Toutes deux sont idempotentes par index unique : une
 * réparation rejouée n'écrit rien une seconde fois.
 */

import type { Sql } from '@/lib/db/sql';
import { acknowledgeReply, applyTransition, noteReplyConsidered } from '@/lib/replies/state';
import {
  CATEGORY_POLICY,
  REPLY_ACKNOWLEDGED_STATE,
  intentTransitionTarget,
  shouldAcknowledgeReply,
  type OutreachState,
  type ReplyCategory,
} from '@/lib/replies/taxonomy';

export type ReplyStateFinding =
  /** L'état reflète déjà la réponse. Rien à faire. */
  | 'PROGRESSED'
  /** Corrélé, mais aucune analyse vivante : le pipeline n'a jamais conclu. */
  | 'NO_ANALYSIS'
  /** L'analyse dit qu'un humain a écrit, et l'état est resté en arrière. */
  | 'MISSING_PROGRESSION'
  /** L'analyse dit qu'aucun humain n'a écrit (absence, non-remise). */
  | 'NOT_A_HUMAN_REPLY'
  /** Le prospect est protégé : rien ne l'en fait sortir automatiquement. */
  | 'PROTECTED';

export interface ReplyStateCase {
  readonly inboundMessageId: string;
  readonly receivedAt: string;
  readonly prospectId: string;
  readonly displayName: string;
  readonly correlationStatus: string;
  readonly currentState: OutreachState | null;
  readonly analysisId: string | null;
  readonly classification: ReplyCategory | null;
  readonly targetState: OutreachState | null;
  readonly finding: ReplyStateFinding;
  readonly detail: string;
}

interface AuditRow {
  inboundMessageId: string;
  receivedAt: string | Date;
  prospectId: string;
  displayName: string;
  correlationStatus: string;
  currentState: OutreachState | null;
  analysisId: string | null;
  classification: ReplyCategory | null;
  reasoningSummary: string | null;
}

/**
 * Les réponses corrélées, avec leur analyse vivante s'il y en a une et l'état
 * courant de leur prospect.
 *
 * `left join` sur l'analyse, volontairement : le cas le plus intéressant de
 * l'audit est justement celui où elle MANQUE, et une jointure interne le
 * rendrait invisible — l'anomalie disparaîtrait du rapport chargé de la voir.
 */
const AUDIT_QUERY = `
  select i.id                 as "inboundMessageId",
         i.received_at        as "receivedAt",
         i.correlated_prospect_id as "prospectId",
         p.display_name       as "displayName",
         i.correlation_status as "correlationStatus",
         s.state              as "currentState",
         a.id                 as "analysisId",
         a.classification     as "classification",
         a.reasoning_summary  as "reasoningSummary"
    from r6b_inbound_messages i
    join prospects p on p.id = i.correlated_prospect_id
    left join r6b_prospect_outreach_states s on s.prospect_id = i.correlated_prospect_id
    left join r6b_reply_analyses a
           on a.inbound_message_id = i.id and a.status = 'ACTIVE'
   where i.correlation_status in ('EXACT','HIGH_CONFIDENCE')
   order by i.received_at asc`;

function classify(row: AuditRow): { finding: ReplyStateFinding; detail: string } {
  if (row.currentState === 'SUPPRESSED' || row.currentState === 'BOUNCED') {
    return {
      finding: 'PROTECTED',
      detail: `état ${row.currentState} — terminal ou protecteur, aucune progression automatique`,
    };
  }
  if (row.classification === null) {
    return {
      finding: 'NO_ANALYSIS',
      detail:
        'réponse corrélée sans analyse vivante — le pipeline n’a jamais conclu sur ce message. ' +
        'Se répare en le faisant tourner (npm run r6b:replies:process -- --resume), pas en écrivant un état',
    };
  }
  if (!CATEGORY_POLICY[row.classification].evidencesHumanReply) {
    return {
      finding: 'NOT_A_HUMAN_REPLY',
      detail: `analyse ${row.classification} — un agenda ou un serveur, pas quelqu’un qui a écrit`,
    };
  }
  if (shouldAcknowledgeReply(row.classification, row.currentState)) {
    return {
      finding: 'MISSING_PROGRESSION',
      detail:
        `analyse ${row.classification} enregistrée, prospect encore ${row.currentState ?? 'sans état'} — ` +
        'la décision existe, l’état ne l’a pas suivie',
    };
  }
  return {
    finding: 'PROGRESSED',
    detail: `état ${row.currentState ?? 'sans état'} — au-delà de CONTACTED, la réponse a déjà été prise en compte`,
  };
}

export interface ReplyStateAudit {
  readonly cases: readonly ReplyStateCase[];
  readonly counts: Readonly<Record<ReplyStateFinding, number>>;
}

const EMPTY_COUNTS: Readonly<Record<ReplyStateFinding, number>> = Object.freeze({
  PROGRESSED: 0,
  NO_ANALYSIS: 0,
  MISSING_PROGRESSION: 0,
  NOT_A_HUMAN_REPLY: 0,
  PROTECTED: 0,
});

/** LECTURE SEULE. N'écrit rien, ne peut rien écrire — aucune requête d'écriture ici. */
export async function auditReplyStates(sql: Sql): Promise<ReplyStateAudit> {
  const rows = await sql.query<AuditRow>(AUDIT_QUERY);
  const counts: Record<ReplyStateFinding, number> = { ...EMPTY_COUNTS };
  const cases: ReplyStateCase[] = [];

  for (const row of rows) {
    const { finding, detail } = classify(row);
    counts[finding] += 1;
    cases.push(
      Object.freeze({
        inboundMessageId: row.inboundMessageId,
        receivedAt: new Date(row.receivedAt).toISOString(),
        prospectId: row.prospectId,
        displayName: row.displayName,
        correlationStatus: row.correlationStatus,
        currentState: row.currentState,
        analysisId: row.analysisId,
        classification: row.classification,
        targetState:
          row.classification === null
            ? null
            : intentTransitionTarget(row.classification, row.currentState),
        finding,
        detail,
      }),
    );
  }

  return Object.freeze({ cases: Object.freeze(cases), counts: Object.freeze(counts) });
}

export interface RepairOutcome {
  readonly inboundMessageId: string;
  readonly prospectId: string;
  readonly displayName: string;
  readonly acknowledged: boolean;
  readonly intentApplied: boolean;
  readonly finalState: OutreachState | null;
}

export interface RepairReport {
  readonly eligible: number;
  readonly repaired: readonly RepairOutcome[];
}

/**
 * Rejoue les transitions canoniques sur les seuls cas `MISSING_PROGRESSION`.
 *
 * Le filtre n'est pas un argument : il est calculé par le même `classify` que
 * l'audit, sur les mêmes lignes, relues à l'instant de la réparation. Passer la
 * liste des cas depuis l'appelant aurait laissé un rapport vieux de dix minutes
 * décider d'une écriture — et un prospect qui aurait demandé l'arrêt entre les
 * deux serait ramené dans la file par un fichier périmé.
 */
export async function repairMissingProgression(sql: Sql): Promise<RepairReport> {
  const rows = await sql.query<AuditRow>(AUDIT_QUERY);
  const repaired: RepairOutcome[] = [];
  let eligible = 0;

  for (const row of rows) {
    if (classify(row).finding !== 'MISSING_PROGRESSION') continue;
    if (row.classification === null || row.analysisId === null) continue;
    eligible += 1;

    const acknowledged = await acknowledgeReply(sql, {
      prospectId: row.prospectId,
      category: row.classification,
      inboundMessageId: row.inboundMessageId,
      analysisId: row.analysisId,
      detail: row.reasoningSummary ?? 'réparation HERMES-TARGETING-R1',
    });

    // La MÊME résolution que `processReply`, et pas `policy.nextState` brut :
    // une réparation qui court-circuiterait la garde de progression pourrait
    // faire redescendre un prospect que la voie normale protège.
    const nextState = intentTransitionTarget(row.classification, row.currentState);
    let intentApplied = false;
    let finalState: OutreachState | null = acknowledged?.toState ?? null;
    if (nextState !== null) {
      const transition = await applyTransition(sql, {
        prospectId: row.prospectId,
        toState: nextState,
        causeKind: 'inbound_reply',
        causeId: row.inboundMessageId,
        analysisId: row.analysisId,
        reason: `réparation: ${row.classification} — ${row.reasoningSummary ?? 'analyse existante rejouée'}`,
      });
      intentApplied = transition.applied;
      if (transition.applied) finalState = transition.toState;
    }

    repaired.push(
      Object.freeze({
        inboundMessageId: row.inboundMessageId,
        prospectId: row.prospectId,
        displayName: row.displayName,
        acknowledged: acknowledged?.applied === true,
        intentApplied,
        finalState,
      }),
    );
  }

  return Object.freeze({ eligible, repaired: Object.freeze(repaired) });
}

// ---------------------------------------------------------------------------
// HERMES-REPLY-ORDERING-R1 §8 — l'audit d'ORDRE, et sa réparation bornée
// ---------------------------------------------------------------------------
//
// L'audit ci-dessus répond à « une décision a-t-elle été prise sans que l'état
// la suive ? ». Celui-ci répond à une question différente et plus récente :
// « l'état courant est-il celui que produit l'ordre RÉEL des réponses ? ».
//
// Les deux ne se recouvrent pas. Un prospect peut avoir progressé sur chacun de
// ses messages — donc être `PROGRESSED` partout — et porter malgré tout l'état
// dicté par son avant-dernière phrase, simplement parce que le worker a fini
// par elle. C'est exactement ce qui s'est produit le 21 août 2026.
//
// La réparation ne rejoue PAS les messages : rejouer une cause déjà journalisée
// ne produirait rien, l'index unique la refuserait (`already_recorded`), et
// l'état ne bougerait pas d'un pouce. Elle fait la seule chose honnête : elle
// recalcule l'état canonique en repliant les réponses dans leur ordre de
// réception, le compare à l'état courant, et n'écrit que là où les deux
// diffèrent — par une transition `human`, parce que c'est un humain qui la
// demande, nommément, et que le journal doit le dire.

/** Le préfixe qui rend une réparation d'ordre reconnaissable dans le journal. */
export const REPLY_ORDER_REPAIR_PREFIX = 'REPAIR_REPLY_ORDER';

export type ReplyOrderVerdict =
  /** L'état courant est déjà celui que l'ordre réel produit. */
  | 'CONSISTENT'
  /** Il ne l'est pas, et le recalcul est complet : réparable. */
  | 'DIVERGENT'
  /** Une réponse corrélée n'a pas d'analyse vivante — le repli serait incomplet. */
  | 'PENDING_ANALYSIS'
  /** Aucun état courant : c'est un défaut de progression, pas un défaut d'ordre. */
  | 'PENDING_PROGRESSION'
  /** Un humain a tranché ce dossier. La machine ne réécrit pas par-dessus. */
  | 'HUMAN_DECIDED'
  /** `SUPPRESSED` d'un côté ou de l'autre — jamais réécrit automatiquement. */
  | 'PROTECTED';

export interface ReplyOrderCase {
  readonly prospectId: string;
  readonly displayName: string;
  readonly currentState: OutreachState | null;
  readonly expectedState: OutreachState | null;
  /** La réponse la plus récente qui compte, celle qui devrait gouverner. */
  readonly latestReplyId: string | null;
  readonly latestReceivedAt: string | null;
  readonly latestClassification: ReplyCategory | null;
  readonly replies: number;
  readonly verdict: ReplyOrderVerdict;
  readonly detail: string;
}

export interface ReplyOrderAudit {
  readonly cases: readonly ReplyOrderCase[];
  readonly counts: Readonly<Record<ReplyOrderVerdict, number>>;
}

interface OrderRow {
  inboundMessageId: string;
  receivedAt: string | Date;
  prospectId: string;
  displayName: string;
  currentState: OutreachState | null;
  hasState: boolean;
  humanDecisions: number | string;
  analysisId: string | null;
  classification: ReplyCategory | null;
}

/**
 * Les réponses corrélées de chaque prospect, DANS L'ORDRE DE RÉCEPTION.
 *
 * `order by received_at, id` : le second terme n'est pas décoratif. Deux
 * messages reçus à la même milliseconde ne sont pas ordonnés par le temps —
 * rien ne peut les ordonner — mais un audit qui rendrait deux réponses
 * différentes selon l'humeur du planificateur serait inutilisable. L'identifiant
 * ne signifie rien ; il arbitre, et il arbitre toujours pareil.
 */
const ORDER_QUERY = `
  select i.id                     as "inboundMessageId",
         i.received_at            as "receivedAt",
         i.correlated_prospect_id as "prospectId",
         p.display_name           as "displayName",
         s.state                  as "currentState",
         (s.prospect_id is not null) as "hasState",
         coalesce((select count(*)
                     from r6b_prospect_state_transitions t
                    where t.prospect_id = i.correlated_prospect_id
                      and t.cause_kind = 'human'
                      and t.reason not like $1), 0) as "humanDecisions",
         a.id                     as "analysisId",
         a.classification         as "classification"
    from r6b_inbound_messages i
    join prospects p on p.id = i.correlated_prospect_id
    left join r6b_prospect_outreach_states s on s.prospect_id = i.correlated_prospect_id
    left join r6b_reply_analyses a
           on a.inbound_message_id = i.id and a.status = 'ACTIVE'
   where i.correlation_status in ('EXACT','HIGH_CONFIDENCE')
   order by i.correlated_prospect_id, i.received_at asc, i.id asc`;

/**
 * Replie les réponses d'un prospect dans leur ordre de réception et rend l'état
 * que cette histoire produit.
 *
 * PUR : aucune base, aucun modèle, aucune écriture. Il n'appelle que les deux
 * fonctions que `processReply` appelle pour décider — `shouldAcknowledgeReply`
 * et `intentTransitionTarget` — dans le même ordre et avec les mêmes arguments.
 * C'est ce qui rend le résultat opposable : ce n'est pas une seconde politique
 * qui donnerait un second avis, c'est la même, rejouée sur la bonne séquence.
 *
 * Le point de départ est `CONTACTED` et pas `null` : toute réponse corrélée
 * désigne un `outreach_event`, donc un message réellement parti, et c'est
 * exactement ce que `ensureContacted` inscrit avant la première classification.
 */
export function foldReplyOrder(
  replies: readonly { readonly classification: ReplyCategory }[],
): OutreachState {
  let state: OutreachState = 'CONTACTED';
  for (const reply of replies) {
    // `SUPPRESSED` est terminal pour la machine : une fois qu'on a demandé
    // l'arrêt, aucune phrase ultérieure ne fait rentrer dans la file. Le repli
    // doit tenir cette règle, sinon la « réparation » deviendrait le seul
    // chemin du dépôt capable de sortir quelqu'un de sa suppression.
    if (state === 'SUPPRESSED') break;
    const before = state;
    if (shouldAcknowledgeReply(reply.classification, before)) state = REPLY_ACKNOWLEDGED_STATE;
    const intent = intentTransitionTarget(reply.classification, before);
    if (intent !== null) state = intent;
  }
  return state;
}

interface ProspectReplies {
  readonly prospectId: string;
  readonly displayName: string;
  readonly currentState: OutreachState | null;
  readonly hasState: boolean;
  readonly humanDecisions: number;
  readonly rows: OrderRow[];
}

function groupByProspect(rows: readonly OrderRow[]): ProspectReplies[] {
  const byProspect = new Map<string, ProspectReplies & { rows: OrderRow[] }>();
  for (const row of rows) {
    const existing = byProspect.get(row.prospectId);
    if (existing === undefined) {
      byProspect.set(row.prospectId, {
        prospectId: row.prospectId,
        displayName: row.displayName,
        currentState: row.currentState,
        hasState: row.hasState,
        humanDecisions: Number(row.humanDecisions),
        rows: [row],
      });
      continue;
    }
    existing.rows.push(row);
  }
  return [...byProspect.values()];
}

function judgeOrder(group: ProspectReplies): ReplyOrderCase {
  const analysed = group.rows.filter(
    (row): row is OrderRow & { classification: ReplyCategory } => row.classification !== null,
  );
  const latest = analysed[analysed.length - 1] ?? null;
  const expectedState = analysed.length === 0 ? null : foldReplyOrder(analysed);

  const base = {
    prospectId: group.prospectId,
    displayName: group.displayName,
    currentState: group.currentState,
    expectedState,
    latestReplyId: latest?.inboundMessageId ?? null,
    latestReceivedAt: latest === null ? null : new Date(latest.receivedAt).toISOString(),
    latestClassification: latest?.classification ?? null,
    replies: group.rows.length,
  } as const;

  const frozen = (verdict: ReplyOrderVerdict, detail: string): ReplyOrderCase =>
    Object.freeze({ ...base, verdict, detail });

  // L'ordre de ces tests est celui de la prudence, pas celui de la lisibilité :
  // chaque refus court-circuite les suivants, et le seul verdict qui autorise
  // une écriture est le dernier.
  if (analysed.length < group.rows.length) {
    return frozen(
      'PENDING_ANALYSIS',
      `${String(group.rows.length - analysed.length)} réponse(s) corrélée(s) sans analyse vivante — ` +
        'le repli serait incomplet. Faire tourner npm run r6b:replies:process -- --resume d’abord',
    );
  }
  if (!group.hasState || group.currentState === null) {
    return frozen(
      'PENDING_PROGRESSION',
      'aucun état commercial courant — c’est un défaut de progression, que --repair traite, ' +
        'pas un défaut d’ordre',
    );
  }
  if (group.humanDecisions > 0) {
    return frozen(
      'HUMAN_DECIDED',
      `${String(group.humanDecisions)} transition(s) humaine(s) dans le journal — une décision prise ` +
        'par quelqu’un ne se fait pas réécrire par un recalcul',
    );
  }
  if (group.currentState === expectedState) {
    return frozen(
      'CONSISTENT',
      `état ${group.currentState} — c’est bien ce que produit l’ordre réel des ${String(analysed.length)} réponse(s)`,
    );
  }
  if (group.currentState === 'SUPPRESSED' || expectedState === 'SUPPRESSED') {
    return frozen(
      'PROTECTED',
      `${group.currentState} vs ${expectedState ?? '—'} — une suppression est en jeu, ` +
        'aucune réécriture automatique',
    );
  }
  return frozen(
    'DIVERGENT',
    `état ${group.currentState}, alors que la dernière réponse (${base.latestClassification ?? '—'}, ` +
      `${base.latestReceivedAt?.slice(11, 19) ?? '—'}) conduit à ${expectedState ?? '—'}`,
  );
}

const EMPTY_ORDER_COUNTS: Readonly<Record<ReplyOrderVerdict, number>> = Object.freeze({
  CONSISTENT: 0,
  DIVERGENT: 0,
  PENDING_ANALYSIS: 0,
  PENDING_PROGRESSION: 0,
  HUMAN_DECIDED: 0,
  PROTECTED: 0,
});

/** LECTURE SEULE. Aucune requête d'écriture n'existe dans ce chemin. */
export async function auditReplyOrdering(sql: Sql): Promise<ReplyOrderAudit> {
  const rows = await sql.query<OrderRow>(ORDER_QUERY, [`${REPLY_ORDER_REPAIR_PREFIX}%`]);
  const counts: Record<ReplyOrderVerdict, number> = { ...EMPTY_ORDER_COUNTS };
  const cases: ReplyOrderCase[] = [];
  for (const group of groupByProspect(rows)) {
    const verdict = judgeOrder(group);
    counts[verdict.verdict] += 1;
    cases.push(verdict);
  }
  return Object.freeze({ cases: Object.freeze(cases), counts: Object.freeze(counts) });
}

export interface ReplyOrderRepairOutcome {
  readonly prospectId: string;
  readonly displayName: string;
  readonly fromState: OutreachState | null;
  readonly toState: OutreachState | null;
  readonly latestReceivedAt: string | null;
  readonly latestClassification: ReplyCategory | null;
  readonly written: boolean;
  readonly detail: string;
}

export interface ReplyOrderRepairReport {
  /** Combien de prospects ont été REGARDÉS. */
  readonly audited: number;
  readonly divergent: number;
  /** Écritures réellement faites. Toujours 0 en dry-run. */
  readonly repaired: number;
  /** Prospects audités qu'aucune écriture n'a touchés. */
  readonly unchanged: number;
  readonly applied: boolean;
  readonly outcomes: readonly ReplyOrderRepairOutcome[];
}

export interface ReplyOrderRepairOptions {
  /** Défaut `false` : REGARDER est le comportement par défaut. */
  readonly apply?: boolean;
  /** Le nom de qui demande l'écriture. Obligatoire dès qu'on écrit. */
  readonly actor?: string;
}

/**
 * Recalcule, compare, et n'écrit que les divergences prouvées.
 *
 * `apply: false` par défaut, et le dry-run n'est pas un mode dégradé : c'est le
 * MÊME calcul, sur les MÊMES lignes, qui s'arrête juste avant d'écrire. Ce que
 * le rapport annonce est donc exactement ce que `--apply` fera.
 *
 * Les lignes sont RELUES à l'instant de l'écriture, jamais reçues de
 * l'appelant : un rapport vieux de dix minutes ne doit pas pouvoir décider
 * d'une mutation, et un prospect qui aurait demandé l'arrêt entre-temps doit
 * être vu comme supprimé, pas comme divergent.
 *
 * L'écriture est une transition `cause_kind = 'human'` — parce que c'est vrai :
 * personne d'autre qu'un humain nommé ne déclenche cette commande. Elle ne
 * réécrit ni n'efface aucune ligne du journal ; elle en ajoute une, qui dit
 * d'où l'on vient, où l'on va, et sur la foi de quelle réponse.
 */
export async function repairReplyOrdering(
  sql: Sql,
  options: ReplyOrderRepairOptions = {},
): Promise<ReplyOrderRepairReport> {
  const apply = options.apply === true;
  const actor = (options.actor ?? '').trim();
  if (apply && actor.length === 0) {
    throw new Error(
      'une réparation d’ordre s’écrit au nom de quelqu’un : fournir --as "<nom>" avant --apply',
    );
  }

  const rows = await sql.query<OrderRow>(ORDER_QUERY, [`${REPLY_ORDER_REPAIR_PREFIX}%`]);
  const groups = groupByProspect(rows);
  const outcomes: ReplyOrderRepairOutcome[] = [];
  let divergent = 0;
  let repaired = 0;

  for (const group of groups) {
    const verdict = judgeOrder(group);
    if (verdict.verdict !== 'DIVERGENT') continue;
    divergent += 1;
    const target = verdict.expectedState;
    if (target === null) continue;

    if (!apply) {
      outcomes.push(
        Object.freeze({
          prospectId: verdict.prospectId,
          displayName: verdict.displayName,
          fromState: verdict.currentState,
          toState: target,
          latestReceivedAt: verdict.latestReceivedAt,
          latestClassification: verdict.latestClassification,
          written: false,
          detail: verdict.detail,
        }),
      );
      continue;
    }

    const reason =
      `${REPLY_ORDER_REPAIR_PREFIX} par « ${actor} » — ordre de réception rétabli : ` +
      `${verdict.currentState ?? '—'} → ${target}, d’après la réponse ${verdict.latestReplyId ?? '—'} ` +
      `(${verdict.latestClassification ?? '—'}, reçue ${verdict.latestReceivedAt ?? '—'})`;

    const transition = await applyTransition(sql, {
      prospectId: verdict.prospectId,
      toState: target,
      causeKind: 'human',
      causeId: null,
      analysisId: null,
      reason,
    });

    // La marque d'eau suit l'état qu'elle protège : sans elle, la réponse
    // ancienne qui a causé la divergence pourrait la recréer au prochain
    // passage de `--resume`, et la réparation ne tiendrait qu'un cycle.
    if (transition.applied && verdict.latestReplyId !== null) {
      await noteReplyConsidered(sql, verdict.prospectId, verdict.latestReplyId);
    }
    if (transition.applied) repaired += 1;

    outcomes.push(
      Object.freeze({
        prospectId: verdict.prospectId,
        displayName: verdict.displayName,
        fromState: verdict.currentState,
        toState: transition.applied ? target : verdict.currentState,
        latestReceivedAt: verdict.latestReceivedAt,
        latestClassification: verdict.latestClassification,
        written: transition.applied,
        detail: transition.applied
          ? verdict.detail
          : `écriture refusée (${transition.skipped ?? 'inconnu'}) — l’état a changé entre l’audit et l’écriture`,
      }),
    );
  }

  return Object.freeze({
    audited: groups.length,
    divergent,
    repaired,
    unchanged: groups.length - repaired,
    applied: apply,
    outcomes: Object.freeze(outcomes),
  });
}
