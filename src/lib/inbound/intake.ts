/**
 * R6B-D1 — l'ingestion : lire une boîte, dédupliquer, corréler, persister.
 *
 * Ce module n'importe aucun client réseau. Il exige un `InboundMailboxProvider`
 * fourni par l'appelant et n'en construit jamais — la même règle que le
 * dispatcher sortant, et pour la même raison : un test qui oublierait de
 * brancher un faux fournisseur ne compilerait pas, plutôt que de toucher une
 * vraie boîte par accident.
 *
 * ---------------------------------------------------------------------------
 * Les deux propriétés que ce fichier doit tenir
 * ---------------------------------------------------------------------------
 *
 *   1. **Idempotence.** Ingérer le même message Gmail une fois, dix fois ou
 *      cent fois donne exactement une ligne. La garantie ne vient pas d'un
 *      `select` préalable — deux pollers simultanés y liraient tous deux
 *      « inconnu » — mais de l'index unique
 *      `r6b_inbound_messages_provider_message_idx` : le second `insert` est
 *      refusé par Postgres quelle que soit la course.
 *
 *   2. **Aucune perte silencieuse.** Le curseur n'avance que si le tour s'est
 *      terminé sans échec ET sans troncature. Un message qui n'a pas pu être
 *      lu laisse donc le curseur en arrière, et le tour suivant le relira —
 *      ce que l'idempotence rend sans effet de bord. L'inverse (avancer et
 *      espérer) ferait disparaître une réponse pour toujours.
 */

import type { Sql } from '@/lib/db/sql';
import {
  correlateInbound,
  type CorrelationResult,
  type CorrelationStatus,
  type OutboundSend,
  type ReplyTokenBinding,
} from '@/lib/inbound/correlation';
import type { InboundMailboxProvider, MailboxScope } from '@/lib/inbound/mailbox';
import {
  InboundNormalizationError,
  normalizeInboundMessage,
  normalizeSubject,
  parsePlusAddress,
  type NormalizedInboundMessage,
} from '@/lib/inbound/parse';

/** Plafond dur d'un tour. Une boîte de prospection ne reçoit pas 500 réponses par heure. */
export const DEFAULT_MAX_MESSAGES = 100;

/**
 * Fenêtre de la toute première synchronisation, quand aucun envoi n'est encore
 * connu. Volontairement courte : la mission (§13) interdit de balayer des
 * années de courrier personnel, et un poller qui n'a aucun envoi à corréler
 * n'a de toute façon rien à trouver.
 */
export const INITIAL_WINDOW_DAYS = 14;

/**
 * Marge appliquée sous la borne basse d'une requête.
 *
 * L'opérateur `after:` de Gmail a une granularité de JOUR, pas de milliseconde.
 * Reprendre exactement au dernier `internalDate` connu ferait donc perdre les
 * messages du même jour. Un jour de recouvrement les reprend tous ; les
 * doublons que cela produit sont absorbés par l'index unique — c'est
 * exactement le compromis que l'idempotence est là pour rendre gratuit.
 */
export const QUERY_OVERLAP_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Lectures
// ---------------------------------------------------------------------------

interface SendRow {
  outreachEventId: string;
  manifestId: string;
  prospectId: string;
  sentAt: string | Date;
  recipient: string;
  subject: string | null;
  rfcMessageId: string | null;
}

/**
 * Les envois email réellement partis.
 *
 * La source est `outreach_events` et pas `r6b_live_send_attempts` : une
 * tentative n'est pas un contact. Seul un événement `sent` affirme qu'un
 * humain a reçu quelque chose, et c'est à cela qu'une réponse répond.
 */
export async function loadOutboundSends(sql: Sql): Promise<OutboundSend[]> {
  const rows = await sql.query<SendRow>(
    `select e.id             as "outreachEventId",
            e.manifest_id    as "manifestId",
            e.prospect_id    as "prospectId",
            e.occurred_at    as "sentAt",
            m.recipient      as "recipient",
            m.transport_payload->>'subject' as "subject",
            (select s.provider_rfc_message_id
               from r6b_live_send_attempts s
              where s.manifest_id = e.manifest_id and s.status = 'SENT'
              order by s.claimed_at desc
              limit 1)       as "rfcMessageId"
       from outreach_events e
       join r6b_dispatch_manifests m on m.id = e.manifest_id
      where e.kind = 'sent'
        and e.manifest_id is not null
        and m.transport = 'email'
      order by e.occurred_at asc`,
  );

  return rows.map((row) =>
    Object.freeze({
      manifestId: row.manifestId,
      outreachEventId: row.outreachEventId,
      prospectId: row.prospectId,
      recipient: row.recipient.trim().toLowerCase(),
      sentAt: new Date(row.sentAt),
      rfcMessageId: row.rfcMessageId,
      normalizedSubject: normalizeSubject(row.subject),
    }),
  );
}

/**
 * Résout les jetons lus dans les adresses de destination.
 *
 * Interrogée avec les jetons EXACTEMENT tels qu'ils ont été lus : un jeton
 * absent de la table est inconnu, et le rester est le comportement voulu.
 * Aucune tolérance, aucun rapprochement approximatif — un jeton se résout ou
 * il ne se résout pas.
 */
export async function resolveReplyTokens(
  sql: Sql,
  tokens: readonly string[],
): Promise<Map<string, ReplyTokenBinding>> {
  const map = new Map<string, ReplyTokenBinding>();
  if (tokens.length === 0) return map;

  const rows = await sql.query<{ token: string; manifestId: string; revokedAt: string | null }>(
    `select token, manifest_id as "manifestId", revoked_at as "revokedAt"
       from r6b_reply_tokens where token = any($1::text[])`,
    [[...new Set(tokens)]],
  );
  for (const row of rows) {
    map.set(row.token, { token: row.token, manifestId: row.manifestId, revoked: row.revokedAt !== null });
  }
  return map;
}

/** Les jetons candidats d'un message, avant toute résolution. */
export function candidateTokens(message: NormalizedInboundMessage): string[] {
  const out: string[] = [];
  for (const address of [...message.toAddresses, ...message.deliveredToAddresses]) {
    const parsed = parsePlusAddress(address);
    if (parsed.ok) out.push(parsed.token);
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// Écriture
// ---------------------------------------------------------------------------

export interface PersistResult {
  readonly id: string;
  /** Faux si la base connaissait déjà ce message — le cas normal d'un re-poll. */
  readonly inserted: boolean;
}

/**
 * Écrit un message entrant, une seule fois.
 *
 * `on conflict do nothing` puis relecture : si l'`insert` ne rend aucune
 * ligne, c'est que l'index unique a refusé — soit parce qu'un tour précédent
 * avait déjà écrit, soit parce qu'un autre processus vient de le faire à la
 * milliseconde près. Les deux cas se traitent pareil : on relit la ligne
 * existante et on ne touche à rien. Une ligne déjà écrite n'est jamais mise à
 * jour ; ce qui a été observé à l'ingestion reste ce qui a été observé.
 */
export async function persistInboundMessage(
  sql: Sql,
  mailbox: string,
  message: NormalizedInboundMessage,
  correlation: CorrelationResult,
): Promise<PersistResult> {
  const params = [
    mailbox,
    message.providerMessageId,
    message.providerThreadId,
    message.providerHistoryId,
    message.receivedAt.toISOString(),
    message.fromAddress,
    message.fromDisplay,
    JSON.stringify(message.toAddresses),
    JSON.stringify(message.ccAddresses),
    JSON.stringify(message.replyToAddresses),
    JSON.stringify(message.deliveredToAddresses),
    message.subject,
    message.normalizedSubject,
    message.rfcMessageId,
    JSON.stringify(message.inReplyTo),
    JSON.stringify(message.referenceIds),
    message.bodyText,
    message.bodySha256,
    message.bodySource,
    message.bodyTruncated,
    JSON.stringify(message.rawHeaders),
    JSON.stringify(message.automationSignals),
    correlation.status,
    correlation.method,
    JSON.stringify(correlation.evidence),
    correlation.manifestId,
    correlation.outreachEventId,
    correlation.prospectId,
  ];

  const inserted = await sql.query<{ id: string }>(
    `insert into r6b_inbound_messages
       (provider, mailbox, provider_message_id, provider_thread_id, provider_history_id,
        received_at, from_address, from_display, to_addresses, cc_addresses,
        reply_to_addresses, delivered_to_addresses, subject, normalized_subject,
        rfc_message_id, in_reply_to, reference_ids, body_text, body_sha256,
        body_source, body_truncated, raw_headers, automation_signals,
        correlation_status, correlation_method, correlation_evidence,
        correlated_manifest_id, correlated_outreach_event_id, correlated_prospect_id)
     values ('gmail',$1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14,
             $15::jsonb,$16::jsonb,$17,$18,$19,$20,$21::jsonb,$22::jsonb,$23,$24,$25::jsonb,$26,$27,$28)
     on conflict (provider, mailbox, provider_message_id) do nothing
     returning id`,
    params,
  );

  const row = inserted[0];
  if (row) return { id: row.id, inserted: true };

  const existing = await sql.query<{ id: string }>(
    `select id from r6b_inbound_messages
      where provider = 'gmail' and mailbox = $1 and provider_message_id = $2`,
    [mailbox, message.providerMessageId],
  );
  const found = existing[0];
  if (!found) {
    // Ni inséré, ni retrouvé : la contrainte a refusé pour une autre raison que
    // l'unicité. Remonter plutôt qu'avaler — ce serait précisément une perte
    // silencieuse.
    throw new Error(
      `message ${message.providerMessageId} ni inséré ni retrouvé — contrainte violée sans conflit d'unicité`,
    );
  }
  return { id: found.id, inserted: false };
}

// ---------------------------------------------------------------------------
// Curseur
// ---------------------------------------------------------------------------

export interface MailboxCheckpoint {
  readonly historyId: string | null;
  readonly lastInternalDateMs: number | null;
  readonly lastMessageId: string | null;
  readonly invalidationCount: number;
}

export async function loadCheckpoint(sql: Sql, mailbox: string): Promise<MailboxCheckpoint | null> {
  const rows = await sql.query<{
    historyId: string | null;
    lastInternalDateMs: string | number | null;
    lastMessageId: string | null;
    invalidationCount: number;
  }>(
    `select history_id as "historyId", last_internal_date_ms as "lastInternalDateMs",
            last_message_id as "lastMessageId", invalidation_count as "invalidationCount"
       from r6b_inbound_checkpoints where provider = 'gmail' and mailbox = $1`,
    [mailbox],
  );
  const row = rows[0];
  if (!row) return null;
  const ms = row.lastInternalDateMs === null ? null : Number(row.lastInternalDateMs);
  return {
    historyId: row.historyId,
    lastInternalDateMs: ms !== null && Number.isFinite(ms) ? ms : null,
    lastMessageId: row.lastMessageId,
    invalidationCount: Number(row.invalidationCount),
  };
}

/**
 * Note qu'un curseur incrémental a été refusé par Gmail (HTTP 404 sur un
 * `startHistoryId` hors fenêtre).
 *
 * Le curseur est mis à `null` — donc le prochain tour repartira d'une requête
 * bornée — mais `last_internal_date_ms` est CONSERVÉ : c'est lui qui borne la
 * resynchronisation. L'effacer ferait relire la boîte depuis le début, ce que
 * §13 interdit ; le garder sans effacer `history_id` ferait au contraire
 * réessayer un curseur qu'on sait mort.
 */
export async function recordCheckpointInvalidation(sql: Sql, mailbox: string): Promise<void> {
  await sql.query(
    `insert into r6b_inbound_checkpoints (provider, mailbox, history_id, invalidation_count, last_invalidated_at, updated_at)
     values ('gmail',$1,null,1,now(),now())
     on conflict (provider, mailbox) do update
        set history_id = null,
            invalidation_count = r6b_inbound_checkpoints.invalidation_count + 1,
            last_invalidated_at = now(),
            updated_at = now()`,
    [mailbox],
  );
}

export interface CheckpointAdvance {
  readonly historyId: string | null;
  readonly lastInternalDateMs: number | null;
  readonly lastMessageId: string | null;
}

/**
 * Avance le curseur. Appelée UNIQUEMENT quand le tour n'a ni échec ni
 * troncature — la condition est vérifiée par l'appelant (`pollInboundReplies`)
 * et jamais ici, pour qu'elle reste lisible à l'endroit où elle est décidée.
 *
 * `greatest(...)` en SQL plutôt qu'en TypeScript : deux pollers concurrents
 * pourraient sinon se réécrire l'un l'autre et faire RECULER le curseur, ce
 * qui n'est pas dangereux (l'ingestion est idempotente) mais rendrait le
 * bornage inutile.
 */
export async function advanceCheckpoint(sql: Sql, mailbox: string, advance: CheckpointAdvance): Promise<void> {
  await sql.query(
    `insert into r6b_inbound_checkpoints
       (provider, mailbox, history_id, last_internal_date_ms, last_message_id, last_polled_at, updated_at)
     values ('gmail',$1,$2,$3,$4,now(),now())
     on conflict (provider, mailbox) do update
        set history_id = coalesce(excluded.history_id, r6b_inbound_checkpoints.history_id),
            last_internal_date_ms = greatest(
              coalesce(excluded.last_internal_date_ms, r6b_inbound_checkpoints.last_internal_date_ms),
              coalesce(r6b_inbound_checkpoints.last_internal_date_ms, excluded.last_internal_date_ms)
            ),
            last_message_id = coalesce(excluded.last_message_id, r6b_inbound_checkpoints.last_message_id),
            last_polled_at = now(),
            updated_at = now()`,
    [mailbox, advance.historyId, advance.lastInternalDateMs, advance.lastMessageId],
  );
}

/** Enregistre qu'un tour a eu lieu, sans rien avancer. */
export async function touchCheckpoint(sql: Sql, mailbox: string): Promise<void> {
  await sql.query(
    `insert into r6b_inbound_checkpoints (provider, mailbox, last_polled_at, updated_at)
     values ('gmail',$1,now(),now())
     on conflict (provider, mailbox) do update set last_polled_at = now(), updated_at = now()`,
    [mailbox],
  );
}

// ---------------------------------------------------------------------------
// Le tour de poll
// ---------------------------------------------------------------------------

export interface PollOptions {
  readonly mailbox: string;
  readonly maxMessages?: number;
  /** Injectable pour les tests. Jamais `Date.now()` en dur dans la logique. */
  readonly now?: () => Date;
}

export interface PollFailure {
  readonly providerMessageId: string;
  readonly reason: string;
}

export interface PollReport {
  readonly mailbox: string;
  readonly provider: string;
  readonly strategy: 'query' | 'unchanged' | 'no_counterparties';
  readonly since: string | null;
  /** Adresses réellement interrogées — la frontière effective de ce tour. */
  readonly counterparties: readonly string[];
  /** Vrai si Gmail a refusé le curseur incrémental. Jamais tu. */
  readonly checkpointInvalidated: boolean;
  readonly listedMessages: number;
  readonly fetchedMessages: number;
  readonly alreadyKnown: number;
  readonly persisted: number;
  readonly failures: readonly PollFailure[];
  /** Vrai si le plafond a coupé la liste — le curseur n'avance alors pas. */
  readonly truncated: boolean;
  readonly checkpointAdvanced: boolean;
  readonly counts: Readonly<Record<CorrelationStatus, number>>;
  readonly persistedIds: readonly string[];
}

interface Fetched {
  readonly normalized: NormalizedInboundMessage;
}

/**
 * Un tour, une fois, puis on sort. Pas de boucle, pas de démon.
 *
 * L'ordre des étapes est le sujet du fichier : lister → lire → trier par date
 * → corréler → écrire → n'avancer le curseur qu'en cas de tour intègre.
 */
export async function pollInboundReplies(
  sql: Sql,
  provider: InboundMailboxProvider,
  options: PollOptions,
): Promise<PollReport> {
  const mailbox = options.mailbox.trim().toLowerCase();
  const now = options.now?.() ?? new Date();
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;

  const checkpoint = await loadCheckpoint(sql, mailbox);
  const sends = await loadOutboundSends(sql);
  const since = resolveSince(checkpoint, sends, now);

  // La frontière du poll : uniquement les adresses ayant réellement reçu un
  // envoi. Dérivée de l'état SENT, jamais d'une liste maintenue à la main —
  // un futur second manifeste, une fois SENT, agrandit cette liste sans
  // toucher ce fichier (R6B-D1.3, « FUTURE MULTI-PROSPECT DESIGN »).
  const counterparties = [...new Set(sends.map((send) => send.recipient))];

  const scope: MailboxScope = { since, maxMessages, counterparties };

  const listing = await provider.listNewMessages({ scope, startHistoryId: checkpoint?.historyId ?? null });

  if (listing.historyCursorInvalid) {
    // Visible, compté, et suivi d'une resynchronisation bornée — jamais d'un
    // saut par-dessus la fenêtre perdue.
    await recordCheckpointInvalidation(sql, mailbox);
  }

  const ids = [...new Set(listing.messageIds)];

  const failures: PollFailure[] = [];
  const fetched: Fetched[] = [];

  for (const id of ids) {
    try {
      const raw = await provider.getMessage(id);
      if (raw === null) {
        // Disparu entre la liste et la lecture : ce n'est pas une panne, mais
        // ce n'est pas non plus « rien ». Compté comme échec pour que le
        // curseur n'avance pas par-dessus.
        failures.push({ providerMessageId: id, reason: 'message introuvable à la lecture' });
        continue;
      }
      fetched.push({ normalized: normalizeInboundMessage(raw) });
    } catch (error) {
      failures.push({
        providerMessageId: id,
        reason:
          error instanceof InboundNormalizationError
            ? `${error.code} — ${error.message}`
            : error instanceof Error
              ? error.message
              : String(error),
      });
    }
  }

  // Gmail ne garantit aucun ordre entre `list` et `history`. Trier par date de
  // réception rend l'ingestion déterministe et fait que le curseur temporel
  // final est bien le plus récent réellement traité.
  fetched.sort((a, b) => a.normalized.receivedAt.getTime() - b.normalized.receivedAt.getTime());

  const tokens = await resolveReplyTokens(sql, fetched.flatMap((entry) => candidateTokens(entry.normalized)));

  const counts: Record<CorrelationStatus, number> = {
    EXACT: 0,
    HIGH_CONFIDENCE: 0,
    REVIEW_REQUIRED: 0,
    UNMATCHED: 0,
  };
  const persistedIds: string[] = [];
  let alreadyKnown = 0;
  let latestMs: number | null = checkpoint?.lastInternalDateMs ?? null;
  let latestId: string | null = checkpoint?.lastMessageId ?? null;

  for (const entry of fetched) {
    const correlation = correlateInbound(entry.normalized, sends, tokens);
    try {
      const result = await persistInboundMessage(sql, mailbox, entry.normalized, correlation);
      if (result.inserted) {
        persistedIds.push(result.id);
        counts[correlation.status] += 1;
      } else {
        alreadyKnown += 1;
      }
      const ms = entry.normalized.receivedAt.getTime();
      if (latestMs === null || ms >= latestMs) {
        latestMs = ms;
        latestId = entry.normalized.providerMessageId;
      }
    } catch (error) {
      failures.push({
        providerMessageId: entry.normalized.providerMessageId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // La condition d'avancement, écrite en un seul endroit : rien n'a échoué et
  // rien n'a été coupé. Toute autre combinaison laisse le curseur où il est, et
  // le tour suivant relira — ce que l'idempotence rend gratuit.
  const intact = failures.length === 0 && !listing.truncated;
  if (intact) {
    await advanceCheckpoint(sql, mailbox, {
      historyId: listing.latestHistoryId,
      lastInternalDateMs: latestMs,
      lastMessageId: latestId,
    });
  } else {
    await touchCheckpoint(sql, mailbox);
  }

  return Object.freeze({
    mailbox,
    provider: provider.name,
    strategy: listing.strategy,
    since: since?.toISOString() ?? null,
    counterparties: Object.freeze(counterparties),
    checkpointInvalidated: listing.historyCursorInvalid,
    listedMessages: ids.length,
    fetchedMessages: fetched.length,
    alreadyKnown,
    persisted: persistedIds.length,
    failures: Object.freeze(failures),
    truncated: listing.truncated,
    checkpointAdvanced: intact,
    counts: Object.freeze(counts),
    persistedIds: Object.freeze(persistedIds),
  });
}

/**
 * Borne basse d'un tour.
 *
 * Trois cas, du plus précis au plus prudent :
 *
 *   1. un curseur temporel existe → on repart de là, moins le recouvrement
 *      d'un jour qu'impose la granularité de l'opérateur `after:` ;
 *   2. sinon, des envois existent → on repart du plus ancien, moins la même
 *      marge. Rien d'antérieur au premier envoi ne peut être une réponse ;
 *   3. sinon → une fenêtre courte et fixe. Sans envoi connu, il n'y a rien à
 *      corréler, donc aucune raison de remonter loin dans la boîte d'un opérateur.
 */
export function resolveSince(
  checkpoint: MailboxCheckpoint | null,
  sends: readonly OutboundSend[],
  now: Date,
): Date | null {
  if (checkpoint?.lastInternalDateMs != null) {
    return new Date(checkpoint.lastInternalDateMs - QUERY_OVERLAP_MS);
  }
  const earliest = sends.reduce<number | null>(
    (acc, send) => (acc === null ? send.sentAt.getTime() : Math.min(acc, send.sentAt.getTime())),
    null,
  );
  if (earliest !== null) return new Date(earliest - QUERY_OVERLAP_MS);
  return new Date(now.getTime() - INITIAL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}
