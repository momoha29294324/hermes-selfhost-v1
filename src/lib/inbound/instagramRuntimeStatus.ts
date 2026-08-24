import type { Sql } from '@/lib/db/sql';
import {
  decideInboundTick,
  loadInboundRuntimeState,
  type InboundRuntimeConfig,
  type InboundRuntimeState,
  type InboundTickDecision,
} from '@/lib/inbound/instagramRuntime';

/**
 * IG5.2A §10 — l'état du runtime entrant, pour un opérateur.
 *
 * Une seule règle a guidé le choix des compteurs : chacun doit distinguer
 * « rien n'est arrivé » de « on ne sait pas ». C'est pour cela que
 * `lastSuccessfulPoll` est SÉPARÉ de `lastPoll` — un rail qui relève toutes
 * les cinq minutes en échouant toutes les cinq minutes a un « dernier tour »
 * très frais, et c'est exactement ce qui rendrait un statut rassurant et faux.
 *
 * Rien ici n'écrit, n'ouvre de navigateur, ni ne touche à Instagram. Le
 * `verdict` est celui que la BOUCLE prendrait au même instant : c'est la même
 * fonction pure, sur le même état lu.
 */

export interface InboundBacklog {
  /**
   * Réponses corrélées (EXACT / HIGH_CONFIDENCE) qu'aucune analyse vivante ne
   * couvre. C'est la définition EXACTE du retard, parce que c'est exactement la
   * requête que l'aval exécute pour choisir son travail
   * (`loadUnprocessedCorrelatedInbound`). Deux définitions différentes du
   * retard auraient fini par se contredire.
   */
  readonly unprocessed: number;
  /** Corrélation trop faible pour agir : un humain tranche. Jamais traité automatiquement. */
  readonly reviewRequired: number;
  /** Aucun envoi connu ne correspond. Ce n'est pas une panne — c'est un inconnu. */
  readonly unmatched: number;
  readonly classified: number;
  readonly drafted: number;
  readonly alerts: number;
}

export interface InboundObservationCounts {
  readonly threadsObserved: number;
  readonly messagesObserved: number;
  readonly inboundMessages: number;
  readonly correlated: number;
  readonly threadBindings: number;
}

export interface InboundRuntimeStatus {
  readonly accountHandle: string | null;
  readonly config: InboundRuntimeConfig;
  readonly state: InboundRuntimeState | null;
  readonly decision: InboundTickDecision;
  readonly observations: InboundObservationCounts;
  readonly backlog: InboundBacklog;
}

async function count(sql: Sql, text: string, params: readonly unknown[] = []): Promise<number> {
  const rows = await sql.query<{ n: string }>(text, params);
  return Number(rows[0]?.n ?? '0');
}

export async function loadInboundRuntimeStatus(
  sql: Sql,
  config: InboundRuntimeConfig,
  now: Date = new Date(),
): Promise<InboundRuntimeStatus> {
  const accountHandle = config.accountHandle;
  const state = accountHandle === null ? null : await loadInboundRuntimeState(sql, accountHandle);

  const decision = decideInboundTick({
    state:
      state ??
      Object.freeze({
        accountHandle: '',
        running: null,
        lastTerminal: null,
        lastSuccessful: null,
        consecutiveFailures: 0,
      }),
    config,
    now,
  });

  const [threadsObserved, messagesObserved, threadBindings] = await Promise.all([
    count(sql, `select count(*)::text as n from ig_inbound_thread_observations`),
    count(sql, `select count(*)::text as n from ig_inbound_message_observations`),
    count(sql, `select count(*)::text as n from ig_inbound_thread_bindings`),
  ]);

  const [inboundMessages, correlated, reviewRequired, unmatched] = await Promise.all([
    count(sql, `select count(*)::text as n from r6b_inbound_messages where provider = 'instagram'`),
    count(
      sql,
      `select count(*)::text as n from r6b_inbound_messages
        where provider = 'instagram' and correlation_status in ('EXACT','HIGH_CONFIDENCE')`,
    ),
    count(
      sql,
      `select count(*)::text as n from r6b_inbound_messages
        where provider = 'instagram' and correlation_status = 'REVIEW_REQUIRED'`,
    ),
    count(
      sql,
      `select count(*)::text as n from r6b_inbound_messages
        where provider = 'instagram' and correlation_status = 'UNMATCHED'`,
    ),
  ]);

  const [unprocessed, classified, drafted, alerts] = await Promise.all([
    count(
      sql,
      `select count(*)::text as n from r6b_inbound_messages i
        where i.provider = 'instagram'
          and i.correlation_status in ('EXACT','HIGH_CONFIDENCE')
          and not exists (select 1 from r6b_reply_analyses a
                           where a.inbound_message_id = i.id and a.status = 'ACTIVE')`,
    ),
    count(
      sql,
      `select count(*)::text as n from r6b_reply_analyses a
         join r6b_inbound_messages i on i.id = a.inbound_message_id
        where i.provider = 'instagram' and a.status = 'ACTIVE'`,
    ),
    count(
      sql,
      `select count(*)::text as n from r6b_reply_drafts d
         join r6b_inbound_messages i on i.id = d.inbound_message_id
        where i.provider = 'instagram'`,
    ),
    count(
      sql,
      `select count(*)::text as n from r6b_alerts al
         join r6b_reply_analyses a on a.id = al.analysis_id
         join r6b_inbound_messages i on i.id = a.inbound_message_id
        where i.provider = 'instagram'`,
    ),
  ]);

  return Object.freeze({
    accountHandle,
    config,
    state,
    decision,
    observations: Object.freeze({
      threadsObserved,
      messagesObserved,
      inboundMessages,
      correlated,
      threadBindings,
    }),
    backlog: Object.freeze({ unprocessed, reviewRequired, unmatched, classified, drafted, alerts }),
  });
}
