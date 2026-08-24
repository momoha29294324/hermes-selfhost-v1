import type { Sql } from '@/lib/db/sql';
import { normalizeMessageText } from '@/lib/instagram/deliveryProof';
import type { DirectionBasis, MessageDirection } from '@/lib/instagram/inboundThread';
import type { InstagramOutboundSend, InstagramThreadBinding } from '@/lib/inbound/instagramCorrelation';
import type { InstagramCorrelationResult } from '@/lib/inbound/instagramCorrelation';

/**
 * IG5.1 §6/§14 — la persistance du rail entrant : durable, idempotente, et
 * incapable de fabriquer une vérité.
 *
 * ---------------------------------------------------------------------------
 * Trois écritures, trois rôles distincts
 * ---------------------------------------------------------------------------
 *
 *   1. `ig_inbound_polls`       — un TOUR de relève. Verrou de concurrence.
 *   2. `ig_inbound_*_observations` — ce qui a été VU, en ajout seul, y compris
 *      ce qui n'a pas été compris.
 *   3. `r6b_inbound_messages`   — ce qui est une RÉPONSE. Table partagée avec
 *      le rail e-mail, donc tout l'aval (classification, état, brouillon, CRM,
 *      alertes) s'applique sans une ligne de code de plus.
 *
 * La séparation entre 2 et 3 est le cœur de la mission (§4) : une bulle dont la
 * direction n'a pas pu être tranchée s'inscrit en 2 et n'entre jamais en 3.
 * Elle n'est ni perdue ni promue.
 *
 * ---------------------------------------------------------------------------
 * L'idempotence n'est pas un `select` préalable
 * ---------------------------------------------------------------------------
 *
 * Elle est portée par PostgreSQL, comme partout ailleurs dans ce dépôt :
 * l'index unique `(provider, mailbox, provider_message_id)` (0025) sur une
 * empreinte déterministe. Le même message relevé cinquante fois s'insère une
 * fois — sans verrou applicatif, sans fenêtre entre un `select` et un `insert`,
 * et donc sans dépendre du fait qu'un seul processus tourne.
 */

// ---------------------------------------------------------------------------
// Le tour de relève
// ---------------------------------------------------------------------------

export class InstagramInboundError extends Error {
  readonly code: 'IG_INBOUND_POLL_RUNNING' | 'IG_INBOUND_POLL_LOST' | 'IG_INBOUND_PERSIST_FAILED';

  constructor(code: InstagramInboundError['code'], message: string) {
    super(message);
    this.name = 'InstagramInboundError';
    this.code = code;
  }
}

export interface OpenPollInput {
  readonly accountHandle: string;
  readonly polledBy: string;
  readonly leaseMs: number;
}

/**
 * Ouvre un tour, ou refuse parce qu'un autre est en cours.
 *
 * Le refus vient de l'index partiel unique `ig_inbound_polls_single_running_idx`,
 * pas d'un `select` : deux processus qui démarrent dans la même milliseconde ne
 * peuvent pas tous deux insérer une ligne `RUNNING` pour le même compte.
 *
 * Les baux expirés sont d'abord fermés en `FAILED`. Ce n'est pas un rejeu : un
 * tour de relève ne produit aucun effet externe, et la seule chose qu'il aurait
 * pu écrire est protégée par un index unique. Reprendre est donc gratuit ;
 * rester bloqué à cause d'un processus tué ne le serait pas.
 */
export async function openInboundPoll(sql: Sql, input: OpenPollInput): Promise<string> {
  await sql.query(
    `update ig_inbound_polls
        set status = 'FAILED',
            finished_at = now(),
            detail = coalesce(detail, '') || '[bail expiré — tour clos par un collecteur ultérieur]'
      where status = 'RUNNING' and account_handle = $1 and lease_expires_at <= now()`,
    [input.accountHandle],
  );

  const leaseMs = Math.max(30_000, Math.trunc(input.leaseMs));
  try {
    const rows = await sql.query<{ id: string }>(
      `insert into ig_inbound_polls (account_handle, status, lease_expires_at, polled_by)
       values ($1, 'RUNNING', now() + ($2 || ' milliseconds')::interval, $3)
       returning id`,
      [input.accountHandle, String(leaseMs), input.polledBy],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new InstagramInboundError('IG_INBOUND_PERSIST_FAILED', 'ouverture du tour sans identifiant');
    return id;
  } catch (error) {
    if (error instanceof InstagramInboundError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    if (/unique|duplicate/i.test(detail)) {
      throw new InstagramInboundError(
        'IG_INBOUND_POLL_RUNNING',
        `un tour de relève est déjà en cours pour @${input.accountHandle} — ` +
          'un seul collecteur à la fois, refus par index unique',
      );
    }
    throw error;
  }
}

export interface PollCounters {
  readonly sessionState: string | null;
  readonly inboxReadability: 'INBOX_READABLE' | 'INBOX_UNREADABLE' | null;
  readonly threadsSeen: number;
  readonly threadsRead: number;
  readonly messagesObserved: number;
  readonly messagesIngested: number;
  readonly messagesAlreadyKnown: number;
  readonly blockedWriteRequests: number;
  readonly detail: string;
}

export async function closeInboundPoll(
  sql: Sql,
  pollId: string,
  status: 'COMPLETED' | 'FAILED',
  counters: PollCounters,
): Promise<void> {
  const rows = await sql.query<{ id: string }>(
    `update ig_inbound_polls
        set status = $2,
            finished_at = now(),
            session_state = $3,
            inbox_readability = $4,
            threads_seen = $5,
            threads_read = $6,
            messages_observed = $7,
            messages_ingested = $8,
            messages_already_known = $9,
            blocked_write_requests = $10,
            detail = $11
      where id = $1 and status = 'RUNNING'
      returning id`,
    [
      pollId,
      status,
      counters.sessionState,
      counters.inboxReadability,
      counters.threadsSeen,
      counters.threadsRead,
      counters.messagesObserved,
      counters.messagesIngested,
      counters.messagesAlreadyKnown,
      counters.blockedWriteRequests,
      counters.detail.slice(0, 2_000),
    ],
  );
  if (rows.length === 0) {
    // Le tour a été clos par quelqu'un d'autre (bail expiré, repris ailleurs).
    // On ne le rouvre pas et on ne réécrit pas ses compteurs : la ligne
    // existante dit ce qui s'est passé, celle-ci dirait ce qu'on croyait.
    throw new InstagramInboundError(
      'IG_INBOUND_POLL_LOST',
      `le tour ${pollId} n'était plus RUNNING — ses compteurs ne sont pas réécrits`,
    );
  }
}

// ---------------------------------------------------------------------------
// Les journaux d'observation
// ---------------------------------------------------------------------------

/**
 * IG5 R3 §8 — ce que la lecture d'un fil permet de DIRE de l'absence de réponse.
 *
 * Quatre valeurs, parce qu'il y a quatre faits, et qu'aucun ne se déduit d'un
 * autre. La plus importante est celle qui manque partout ailleurs :
 * `NO_REPLY_OBSERVED` n'est prononçable qu'APRÈS avoir lu les messages du fil.
 * Un fil qu'on n'a pas su lire ne rend pas « pas de réponse » — il rend
 * `THREAD_UNREADABLE`, et c'est toute la différence entre une observation et
 * une supposition.
 */
export type ThreadReplyStatus = 'REPLY_OBSERVED' | 'NO_REPLY_OBSERVED' | 'THREAD_UNREADABLE' | 'UNKNOWN';

/** D'où venaient les messages de ce fil, lors de ce tour. */
export type ThreadMessageSourceTag = 'dom_bubble' | 'thread_detail_network';

export interface ThreadObservationRecord {
  readonly pollId: string;
  readonly rowIndex: number;
  readonly threadId: string | null;
  readonly rowText: string;
  readonly ageMs: number | null;
  readonly counterpartyHandle: string | null;
  readonly outcome: 'READ' | 'NOT_OPENED' | 'UNREADABLE' | 'SKIPPED_LIMIT';
  readonly messageSource: ThreadMessageSourceTag | null;
  readonly replyStatus: ThreadReplyStatus;
  readonly detail: string;
}

export async function recordThreadObservation(sql: Sql, record: ThreadObservationRecord): Promise<void> {
  await sql.query(
    `insert into ig_inbound_thread_observations
       (poll_id, row_index, thread_id, row_text, age_ms, counterparty_handle, outcome,
        message_source, reply_status, detail)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (poll_id, row_index) do nothing`,
    [
      record.pollId,
      record.rowIndex,
      record.threadId,
      record.rowText.slice(0, 400),
      record.ageMs,
      record.counterpartyHandle,
      record.outcome,
      record.messageSource,
      record.replyStatus,
      record.detail.slice(0, 1_000) || '—',
    ],
  );
}

export type MessageObservationOutcome =
  | 'INGESTED'
  | 'ALREADY_KNOWN'
  | 'SKIPPED_OUTGOING'
  | 'SKIPPED_UNKNOWN_DIRECTION'
  | 'SKIPPED_UNIDENTIFIED_SENDER'
  /**
   * IG5 R3 §7 — un message de la contrepartie ANTÉRIEUR à notre DM.
   *
   * Le fil d'un prospect peut porter une conversation vieille de deux ans. La
   * ranger parmi les réponses au message envoyé la semaine dernière serait une
   * invention, et elle coûterait cher : alerte levée, brouillon rédigé,
   * séquence arrêtée, pour un échange sans rapport. Consigné, jamais ingéré.
   */
  | 'SKIPPED_PRE_OUTREACH'
  /**
   * IG5 R3 — une photo, une note vocale, un partage. Le message EXISTE — donc
   * le fil n'est pas « sans réponse » — mais il n'a pas de corps à écrire, et
   * un corps vide fabriqué serait pire que de le compter pour ce qu'il est.
   */
  | 'SKIPPED_NON_TEXT'
  /**
   * IG5 R3 §7 — AUCUN envoi connu vers ce compte.
   *
   * Distinct de `SKIPPED_PRE_OUTREACH`, parce que les deux disent deux choses
   * différentes : « ce message précède notre DM » suppose un DM, celui-ci
   * constate qu'il n'y en a aucun. Les confondre reviendrait à inventer un
   * envoi pour pouvoir dater le message par rapport à lui.
   *
   * Le message reste OBSERVÉ — expéditeur, horodatage, identifiant natif,
   * empreinte du texte — mais son CONTENU n'est pas recopié : une conversation
   * privée sans lien commercial n'a rien à faire dans la base d'une campagne.
   */
  | 'SKIPPED_NO_OUTREACH';

export interface MessageObservationRecord {
  readonly pollId: string;
  readonly threadId: string;
  readonly accountHandle: string;
  readonly senderHandle: string | null;
  readonly direction: MessageDirection;
  readonly directionBasis: DirectionBasis;
  readonly occurrenceIndex: number;
  readonly textSha256: string;
  readonly fingerprint: string;
  readonly outcome: MessageObservationOutcome;
  readonly inboundMessageId: string | null;
  /** IG5 R3 — d'où le message a été lu. */
  readonly source: ThreadMessageSourceTag;
  /**
   * IG5 R3 — l'identifiant qu'Instagram a RÉELLEMENT émis, quand la source en
   * donne un. Le journal d'observation est le seul endroit du schéma où il
   * peut vivre : ailleurs, il se ferait passer pour notre clé de déduplication.
   */
  readonly providerMessageId: string | null;
  /** L'instant réel du message chez Instagram. Distinct de `observed_at`, qui est le nôtre. */
  readonly messageSentAt: Date | null;
}

export async function recordMessageObservation(sql: Sql, record: MessageObservationRecord): Promise<void> {
  await sql.query(
    `insert into ig_inbound_message_observations
       (poll_id, thread_id, account_handle, sender_handle, direction, direction_basis,
        occurrence_index, text_sha256, fingerprint, outcome, inbound_message_id,
        source, provider_message_id, message_sent_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     on conflict (poll_id, fingerprint) do nothing`,
    [
      record.pollId,
      record.threadId,
      record.accountHandle,
      record.senderHandle,
      record.direction,
      record.directionBasis,
      record.occurrenceIndex,
      record.textSha256,
      record.fingerprint,
      record.outcome,
      record.inboundMessageId,
      record.source,
      record.providerMessageId,
      record.messageSentAt === null ? null : record.messageSentAt.toISOString(),
    ],
  );
}

// ---------------------------------------------------------------------------
// Les envois Instagram réellement partis
// ---------------------------------------------------------------------------

export interface InstagramSendWithText extends InstagramOutboundSend {
  /** Le texte approuvé du manifeste — la preuve qui permet de LIER un fil. */
  readonly approvedText: string;
}

/**
 * Les envois Instagram, lus depuis `outreach_events`.
 *
 * `outreach_events` est LA table canonique du « un humain a été joint » — c'est
 * elle que le gate Instagram consulte (`eligibility.ts`), et c'est donc elle
 * qui doit dire à quoi une réponse peut répondre. Le filtre porte sur le
 * TRANSPORT du manifeste, exactement comme le rail e-mail filtre
 * `m.transport = 'email'` : c'est le manifeste qui décide du canal, pas le
 * libellé de l'événement.
 */
export async function loadInstagramOutboundSends(sql: Sql): Promise<InstagramSendWithText[]> {
  const rows = await sql.query<{
    manifestId: string;
    outreachEventId: string;
    prospectId: string;
    recipientHandle: string;
    sentAt: string | Date;
    approvedText: string;
  }>(
    `select m.id            as "manifestId",
            e.id            as "outreachEventId",
            m.prospect_id   as "prospectId",
            lower(m.recipient) as "recipientHandle",
            e.occurred_at   as "sentAt",
            m.approved_text as "approvedText"
       from outreach_events e
       join r6b_dispatch_manifests m on m.id = e.manifest_id
      where e.kind = 'sent'
        and m.transport = 'instagram_dm'
      order by e.occurred_at asc`,
  );
  return rows.map((row) =>
    Object.freeze({
      manifestId: row.manifestId,
      outreachEventId: row.outreachEventId,
      prospectId: row.prospectId,
      recipientHandle: row.recipientHandle,
      sentAt: row.sentAt instanceof Date ? row.sentAt : new Date(row.sentAt),
      approvedText: row.approvedText,
    }),
  );
}

// ---------------------------------------------------------------------------
// Les liens de fil
// ---------------------------------------------------------------------------

export async function loadThreadBindings(sql: Sql, threadId: string): Promise<InstagramThreadBinding[]> {
  const rows = await sql.query<InstagramThreadBinding>(
    `select thread_id           as "threadId",
            manifest_id         as "manifestId",
            outreach_event_id   as "outreachEventId",
            prospect_id         as "prospectId",
            counterparty_handle as "counterpartyHandle"
       from ig_inbound_thread_bindings
      where thread_id = $1`,
    [threadId],
  );
  return rows.map((row) => Object.freeze(row));
}

export interface BindThreadInput {
  readonly pollId: string;
  readonly threadId: string;
  /** Les textes des bulles SORTANTES observées dans ce fil, normalisés. */
  readonly outgoingTexts: readonly string[];
  readonly sends: readonly InstagramSendWithText[];
}

export interface BoundThread {
  readonly manifestId: string;
  readonly created: boolean;
}

/**
 * Lie le fil au manifeste dont le texte approuvé s'y trouve, du côté SORTANT.
 *
 * C'est l'équivalent Instagram d'un `In-Reply-To`, et il est OBSERVÉ plutôt que
 * transmis : le texte approuvé est figé, long, et personne d'autre ne l'a
 * écrit. Le retrouver dans une bulle sortante prouve que c'est nous qui l'y
 * avons mis, pour ce manifeste-là.
 *
 * L'égalité est celle de `deliveryProof` — `normalizeMessageText`, qui rapproche
 * les espaces, apostrophes et tirets typographiques SANS mettre en minuscules ni
 * tronquer. Deux textes « assez proches » restent deux textes différents ; un
 * lien fondé sur une ressemblance serait précisément le genre de raccourci qui
 * rattacherait une réponse au mauvais prospect.
 */
export async function bindThreadFromObservation(sql: Sql, input: BindThreadInput): Promise<BoundThread[]> {
  const observed = new Set(input.outgoingTexts.map((text) => normalizeMessageText(text)));
  const bound: BoundThread[] = [];

  for (const send of input.sends) {
    const approved = normalizeMessageText(send.approvedText);
    if (approved.length === 0 || !observed.has(approved)) continue;

    const rows = await sql.query<{ id: string }>(
      `insert into ig_inbound_thread_bindings
         (thread_id, manifest_id, prospect_id, outreach_event_id, counterparty_handle,
          basis, evidence, first_observed_poll_id)
       values ($1,$2,$3,$4,$5,'observed_outgoing_approved_text',$6,$7)
       on conflict (thread_id, manifest_id) do nothing
       returning id`,
      [
        input.threadId,
        send.manifestId,
        send.prospectId,
        send.outreachEventId,
        send.recipientHandle,
        JSON.stringify({
          approvedTextSha256Basis: 'normalized_equality',
          approvedTextChars: approved.length,
          outgoingBubblesObserved: input.outgoingTexts.length,
        }),
        input.pollId,
      ],
    );
    bound.push(Object.freeze({ manifestId: send.manifestId, created: rows.length > 0 }));
  }

  return bound;
}

// ---------------------------------------------------------------------------
// La réponse elle-même
// ---------------------------------------------------------------------------

export interface PersistInstagramInboundInput {
  readonly accountHandle: string;
  readonly threadId: string;
  readonly senderHandle: string;
  readonly fingerprint: string;
  readonly receivedAt: Date;
  readonly bodyText: string;
  readonly bodySha256: string;
  readonly correlation: InstagramCorrelationResult;
  /**
   * HERMES-IDENTITY-CANONICALIZATION-R1 §6 — les clés que CE MÊME message
   * porterait s'il avait été relevé sous un nom PRÉCÉDENT du compte.
   *
   * Elles existent parce que l'identité de la ligne dépend du nom du jour : la
   * clé d'unicité est `(provider, mailbox, provider_message_id)`, `mailbox` est
   * le handle du moment, et l'empreinte elle-même est calculée à partir de lui.
   * Renommer le compte change donc les deux — et le 22 août 2026, la première
   * relève sous `hermes__` a réingéré les huit messages déjà lus sous
   * `hermesagency_`, avec leurs analyses et leurs brouillons en double.
   *
   * Ce n'était pas un défaut d'unicité : la base a fait exactement ce qu'on lui
   * demandait. C'était une question mal posée — « ai-je déjà vu ce message sous
   * CE nom ? » au lieu de « l'ai-je déjà vu ? ».
   *
   * Vide par défaut : un compte qui n'a jamais changé de nom n'a aucune clé
   * antérieure, et ce chemin ne coûte alors rien. Une liste non vide ne fusionne
   * QUE des identités déclarées en configuration — rien n'est deviné, rien n'est
   * rapproché par ressemblance.
   */
  readonly priorKeys?: readonly { readonly mailbox: string; readonly fingerprint: string }[];
}

export interface PersistedInbound {
  readonly id: string;
  /** Faux quand le message était déjà connu — le cas normal d'un rejeu. */
  readonly created: boolean;
}

/**
 * Écrit la réponse dans la table PARTAGÉE des messages entrants.
 *
 * Une ligne déjà écrite n'est jamais mise à jour — même règle que le rail
 * e-mail (`intake.ts`), et pour la même raison : la corrélation d'un message
 * est un fait daté. La recalculer au tour suivant, avec des envois entre-temps,
 * changerait l'histoire plutôt que de l'enrichir. Un humain qui veut la revoir
 * a la preuve complète dans `correlation_evidence`.
 *
 * Ce qui est écrit et qui n'a pas d'équivalent e-mail :
 *   * `counterparty_kind = 'instagram_handle'` — `from_address` porte un handle ;
 *   * `message_identity_kind = 'observed_fingerprint'` — Instagram ne nous a
 *     donné aucun identifiant, celui-ci est calculé par nous ;
 *   * `body_source = 'instagram_dm_text'` — il n'y a pas de partie MIME ;
 *   * `subject = null`, `normalized_subject = ''` — un DM n'a pas d'objet.
 *
 * Les quatre sont contraints en base (0042) : la ligne serait refusée si l'un
 * d'eux prétendait autre chose.
 */
export async function persistInstagramInboundMessage(
  sql: Sql,
  input: PersistInstagramInboundInput,
): Promise<PersistedInbound> {
  const correlation = input.correlation;
  const params = [
    input.accountHandle.toLowerCase(),
    input.fingerprint,
    input.threadId,
    input.receivedAt.toISOString(),
    input.senderHandle.toLowerCase(),
    input.bodyText,
    input.bodySha256,
    correlation.status,
    correlation.method,
    JSON.stringify(correlation.evidence),
    correlation.manifestId,
    correlation.outreachEventId,
    correlation.prospectId,
  ];

  // §6 — « l'ai-je déjà vu ? » AVANT « puis-je l'insérer ? ».
  //
  // Ce tour de boucle ne fait rien tant qu'aucun ancien nom n'est déclaré. Quand
  // il y en a un, il retrouve la ligne écrite sous ce nom-là et rend
  // `created: false` : le message est connu, l'aval ne le retraite pas, et la
  // ligne HISTORIQUE reste seule et intacte. Aucune mise à jour, aucun
  // rattachement, aucune réécriture de `mailbox` — la ligne dit sous quel nom
  // elle a été lue, et elle continue de le dire.
  for (const prior of input.priorKeys ?? []) {
    const known = await sql.query<{ id: string }>(
      `select id from r6b_inbound_messages
        where provider = 'instagram' and mailbox = $1 and provider_message_id = $2`,
      [prior.mailbox.toLowerCase(), prior.fingerprint],
    );
    const knownId = known[0]?.id;
    if (knownId !== undefined) return Object.freeze({ id: knownId, created: false });
  }

  const inserted = await sql.query<{ id: string }>(
    `insert into r6b_inbound_messages (
       provider, mailbox, provider_message_id, provider_thread_id,
       received_at, from_address, from_display,
       subject, normalized_subject,
       body_text, body_sha256, body_source, body_truncated,
       correlation_status, correlation_method, correlation_evidence,
       correlated_manifest_id, correlated_outreach_event_id, correlated_prospect_id,
       counterparty_kind, message_identity_kind
     ) values (
       'instagram', $1, $2, $3,
       $4, $5, null,
       null, '',
       $6, $7, 'instagram_dm_text', false,
       $8, $9, $10,
       $11, $12, $13,
       'instagram_handle', 'observed_fingerprint'
     )
     on conflict (provider, mailbox, provider_message_id) do nothing
     returning id`,
    params,
  );

  const created = inserted[0]?.id;
  if (created !== undefined) return Object.freeze({ id: created, created: true });

  const existing = await sql.query<{ id: string }>(
    `select id from r6b_inbound_messages
      where provider = 'instagram' and mailbox = $1 and provider_message_id = $2`,
    [input.accountHandle.toLowerCase(), input.fingerprint],
  );
  const id = existing[0]?.id;
  if (id === undefined) {
    // Ni inséré, ni retrouvé : quelque chose a refusé la ligne sans le dire.
    // On lève plutôt que de rendre un identifiant inventé — c'est ce qui
    // empêche un compteur de relève d'annoncer une réponse qui n'existe pas.
    throw new InstagramInboundError(
      'IG_INBOUND_PERSIST_FAILED',
      `message Instagram ni inséré ni retrouvé (empreinte ${input.fingerprint.slice(0, 12)}…)`,
    );
  }
  return Object.freeze({ id, created: false });
}

/**
 * L'ARRÊT des séquences concurrentes n'a volontairement pas de fonction ici.
 *
 * La mission (§8) demande de réutiliser les mécanismes existants s'ils
 * existent. Ils existent, et ils sont déjà sur le chemin d'envoi Instagram :
 *
 *   * `applyTransition` (D2) écrit l'état commercial du prospect, et
 *     `resolveDispatchTarget` — appelé par `instagram/worker.ts`,
 *     `instagram/liveWorker.ts` et `instagram/eligibility.ts` avant tout
 *     envoi — refuse un prospect `SUPPRESSED`, `BOUNCED` ou `NOT_INTERESTED`
 *     (`loadBlockingProspectState`) ;
 *   * `suppressOutbound` (D2, rendu channel-aware par IG5.1) écrit
 *     `do_not_contact (match_kind = 'instagram', value = handle)`, que le gate
 *     Instagram interroge déjà à sa porte `opt_out`.
 *
 * Écrire ici une troisième voie d'arrêt aurait créé une troisième vérité sur
 * « a-t-on le droit de réécrire à ce prospect ». Les deux existantes sont lues
 * par le rail sortant ; une nouvelle ne l'aurait été par personne.
 */
export const STOP_MECHANISMS_ARE_REUSED = true;
