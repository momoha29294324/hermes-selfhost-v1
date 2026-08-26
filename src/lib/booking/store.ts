/**
 * HERMES-NATIVE-BOOKING-R1 §4/§5/§13/§14/§15 — la lecture et l'écriture des
 * trois tables de 0061, et rien d'autre.
 *
 * ---------------------------------------------------------------------------
 * Ce module ne décide RIEN
 * ---------------------------------------------------------------------------
 * Il ne sait pas si un créneau est « raisonnable », si la conversation est mûre,
 * ni si le prospect a le droit d'être joint. Ces questions vivent dans
 * `availability.ts`, `intent.ts` et le crochet pré-effet. Ici, on écrit ce qui a
 * été décidé — et on laisse la BASE refuser ce qu'elle seule peut refuser.
 *
 * Aucun import de provider, de navigateur ni de primitive d'envoi. Une ligne de
 * `hermes_appointments` ne porte ni texte, ni destinataire : il n'existe pas de
 * chemin d'ici vers un message.
 *
 * ---------------------------------------------------------------------------
 * La réservation est ATOMIQUE, et c'est la base qui le tient
 * ---------------------------------------------------------------------------
 * `reserveAppointment` ne fait PAS « je lis, je vérifie, j'écris ». Elle écrit,
 * et traduit le refus de PostgreSQL. Les trois refus possibles sont trois
 * contraintes distinctes de 0061, et les distinguer compte :
 *
 *   * `hermes_appointments_no_overlap` (exclusion, SQLSTATE 23P01) — quelqu'un
 *     d'autre a pris ce créneau. C'est la course de §5, et le perdant doit
 *     PERDRE, pas réessayer ;
 *   * `hermes_appointments_idempotency_idx` (23505) — c'est le MÊME
 *     rendez-vous, rejoué. Le perdant a en fait gagné : on lui rend la ligne
 *     existante (§13) ;
 *   * `hermes_appointments_one_live_per_prospect_idx` (23505) — ce prospect a
 *     déjà un rendez-vous vivant. Ce n'est pas une course, c'est un report qui
 *     s'ignore, et il passe par `rescheduleAppointment`.
 *
 * Confondre les trois produirait la pire des réparations : réessayer une course
 * perdue jusqu'à voler le créneau de quelqu'un.
 */

import type { Interval } from '@/lib/booking/availability';
import type { Sql } from '@/lib/db/sql';

/** La version des règles de réservation. Bougée, elle referme ce qui précède. */
export const NATIVE_BOOKING_POLICY_VERSION = 'hermes-native-booking-r1';

export type AppointmentStatus = 'CONFIRMED' | 'CANCELLED';
export type AppointmentSource = 'instagram_hermes' | 'operator';
export type ConfirmationState = 'PENDING' | 'DELIVERED' | 'DELIVERY_UNCONFIRMED';

export interface Appointment {
  readonly id: string;
  readonly prospectId: string;
  readonly calendarKey: string;
  readonly conversationKey: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timezone: string;
  readonly status: AppointmentStatus;
  readonly source: AppointmentSource;
  readonly triggerInboundMessageId: string | null;
  readonly idempotencyKey: string;
  readonly policyVersion: string;
  readonly supersedesId: string | null;
  readonly confirmationState: ConfirmationState;
  readonly confirmedAt: string | null;
  readonly cancelledAt: string | null;
  readonly cancelledReason: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
}

/** Un refus d'écriture, avec un code plutôt qu'une phrase libre. */
export class BookingStoreRefusal extends Error {
  readonly code: BookingStoreRefusalCode;
  constructor(code: BookingStoreRefusalCode, message: string) {
    super(message);
    this.name = 'BookingStoreRefusal';
    this.code = code;
  }
}

export type BookingStoreRefusalCode =
  /** Le créneau est occupé. La contrainte d'exclusion a tranché. */
  | 'SLOT_TAKEN'
  /** Ce prospect porte déjà un rendez-vous vivant. Passer par un report. */
  | 'PROSPECT_ALREADY_BOOKED'
  /** Le rendez-vous à reporter ou annuler n'existe pas, ou n'est plus vivant. */
  | 'APPOINTMENT_NOT_LIVE'
  /** L'intervalle est mal formé. La base l'a refusé. */
  | 'INTERVAL_INVALID';

interface AppointmentRow {
  readonly id: string;
  readonly prospectId: string;
  readonly calendarKey: string;
  readonly conversationKey: string;
  readonly startsAt: string | Date;
  readonly endsAt: string | Date;
  readonly timezone: string;
  readonly status: AppointmentStatus;
  readonly source: AppointmentSource;
  readonly triggerInboundMessageId: string | null;
  readonly idempotencyKey: string;
  readonly policyVersion: string;
  readonly supersedesId: string | null;
  readonly confirmationState: ConfirmationState;
  readonly confirmedAt: string | Date | null;
  readonly cancelledAt: string | Date | null;
  readonly cancelledReason: string | null;
  readonly createdBy: string;
  readonly createdAt: string | Date;
}

const APPOINTMENT_COLUMNS = `
  id, prospect_id as "prospectId", calendar_key as "calendarKey",
  conversation_key as "conversationKey", starts_at as "startsAt", ends_at as "endsAt",
  timezone, status, source, trigger_inbound_message_id as "triggerInboundMessageId",
  idempotency_key as "idempotencyKey", policy_version as "policyVersion",
  supersedes_id as "supersedesId", confirmation_state as "confirmationState",
  confirmed_at as "confirmedAt", cancelled_at as "cancelledAt",
  cancelled_reason as "cancelledReason", created_by as "createdBy", created_at as "createdAt"`;

function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

function isoOrNull(value: string | Date | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function toAppointment(row: AppointmentRow): Appointment {
  return Object.freeze({
    id: row.id,
    prospectId: row.prospectId,
    calendarKey: row.calendarKey,
    conversationKey: row.conversationKey,
    startsAt: iso(row.startsAt),
    endsAt: iso(row.endsAt),
    timezone: row.timezone,
    status: row.status,
    source: row.source,
    triggerInboundMessageId: row.triggerInboundMessageId,
    idempotencyKey: row.idempotencyKey,
    policyVersion: row.policyVersion,
    supersedesId: row.supersedesId,
    confirmationState: row.confirmationState,
    confirmedAt: isoOrNull(row.confirmedAt),
    cancelledAt: isoOrNull(row.cancelledAt),
    cancelledReason: row.cancelledReason,
    createdBy: row.createdBy,
    createdAt: iso(row.createdAt),
  });
}

/**
 * Le code SQLSTATE et le nom de contrainte d'une erreur PostgreSQL.
 *
 * Les deux pilotes du dépôt (PGlite et node-postgres) exposent `code` et
 * `constraint` ; quand `constraint` manque, le message porte le nom. On lit les
 * deux plutôt qu'un seul : se fier au message seul rendrait le refus dépendant
 * de la locale du serveur, et se fier au seul champ structuré perdrait le cas
 * PGlite où il n'est pas toujours rempli.
 */
function pgFailure(error: unknown): { readonly code: string; readonly constraint: string } {
  const record = error as { code?: unknown; constraint?: unknown; message?: unknown };
  const code = typeof record.code === 'string' ? record.code : '';
  const named = typeof record.constraint === 'string' ? record.constraint : '';
  const message = typeof record.message === 'string' ? record.message : '';
  if (named.length > 0) return { code, constraint: named };
  const match = message.match(/"([a-z0-9_]+)"/u);
  return { code, constraint: match?.[1] ?? '' };
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

/**
 * Les créneaux CONFIRMÉS qui touchent la fenêtre regardée.
 *
 * Bornée par la fenêtre plutôt que « tous les rendez-vous » : le moteur de
 * disponibilité ne raisonne que sur son horizon, et lui donner l'agenda entier
 * le ferait grossir sans rien changer à ses conclusions.
 */
export async function loadBusyIntervals(
  sql: Sql,
  window: { readonly from: Date; readonly to: Date },
): Promise<readonly Interval[]> {
  const rows = await sql.query<{ startsAt: string | Date; endsAt: string | Date }>(
    `select starts_at as "startsAt", ends_at as "endsAt"
       from hermes_appointments
      where status = 'CONFIRMED'
        and ends_at > $1
        and starts_at < $2
      order by starts_at`,
    [window.from.toISOString(), window.to.toISOString()],
  );
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({ startsAt: new Date(row.startsAt), endsAt: new Date(row.endsAt) }),
    ),
  );
}

/** Le rendez-vous VIVANT de ce prospect, s'il en a un. Au plus un, par index. */
export async function loadLiveAppointment(sql: Sql, prospectId: string): Promise<Appointment | null> {
  const rows = await sql.query<AppointmentRow>(
    `select ${APPOINTMENT_COLUMNS} from hermes_appointments
      where prospect_id = $1 and status = 'CONFIRMED'`,
    [prospectId],
  );
  const row = rows[0];
  return row === undefined ? null : toAppointment(row);
}

/**
 * Tout l'historique de ce prospect, du plus récent au plus ancien.
 *
 * L'ordre départage sur `id` à horodatage égal — la discipline que
 * HERMES-END-TO-END-CERTIFICATION-R1 a imposée aux cinq lectures « la plus
 * récente » du dépôt, après qu'un uuid aléatoire y eut décidé d'un verdict ICP.
 */
export async function listAppointments(
  sql: Sql,
  prospectId: string,
  limit = 20,
): Promise<readonly Appointment[]> {
  const rows = await sql.query<AppointmentRow>(
    `select ${APPOINTMENT_COLUMNS} from hermes_appointments
      where prospect_id = $1
      order by starts_at desc, id desc
      limit $2`,
    [prospectId, limit],
  );
  return Object.freeze(rows.map(toAppointment));
}

export async function loadAppointmentById(sql: Sql, id: string): Promise<Appointment | null> {
  const rows = await sql.query<AppointmentRow>(
    `select ${APPOINTMENT_COLUMNS} from hermes_appointments where id = $1`,
    [id],
  );
  const row = rows[0];
  return row === undefined ? null : toAppointment(row);
}

async function loadByIdempotencyKey(sql: Sql, key: string): Promise<Appointment | null> {
  const rows = await sql.query<AppointmentRow>(
    `select ${APPOINTMENT_COLUMNS} from hermes_appointments where idempotency_key = $1`,
    [key],
  );
  const row = rows[0];
  return row === undefined ? null : toAppointment(row);
}

// ---------------------------------------------------------------------------
// Écriture — la réservation
// ---------------------------------------------------------------------------

export interface ReserveInput {
  readonly prospectId: string;
  readonly calendarKey: string;
  readonly conversationKey: string;
  readonly interval: Interval;
  readonly timezone: string;
  readonly source: AppointmentSource;
  readonly triggerInboundMessageId: string | null;
  readonly idempotencyKey: string;
  readonly createdBy: string;
  /** Renseigné par un report seulement. Le rendez-vous que celui-ci remplace. */
  readonly supersedesId?: string | null;
}

export interface ReserveResult {
  readonly appointment: Appointment;
  /** `false` quand la clé existait déjà : le même tour n'en crée pas deux. */
  readonly created: boolean;
}

async function insertAppointment(sql: Sql, input: ReserveInput): Promise<Appointment> {
  const rows = await sql.query<AppointmentRow>(
    `insert into hermes_appointments (
       prospect_id, calendar_key, conversation_key, starts_at, ends_at, timezone,
       status, source, trigger_inbound_message_id, idempotency_key, policy_version,
       supersedes_id, created_by
     ) values ($1,$2,$3,$4,$5,$6,'CONFIRMED',$7,$8,$9,$10,$11,$12)
     returning ${APPOINTMENT_COLUMNS}`,
    [
      input.prospectId,
      input.calendarKey,
      input.conversationKey,
      input.interval.startsAt.toISOString(),
      input.interval.endsAt.toISOString(),
      input.timezone,
      input.source,
      input.triggerInboundMessageId,
      input.idempotencyKey,
      NATIVE_BOOKING_POLICY_VERSION,
      input.supersedesId ?? null,
      input.createdBy,
    ],
  );
  return toAppointment(rows[0] as AppointmentRow);
}

/**
 * Traduit un refus PostgreSQL, ou relance ce qu'on n'a pas su nommer.
 *
 * Fail-closed : une erreur inconnue REMONTE. L'avaler produirait un « rien ne
 * s'est passé » qui ressemble à un refus propre, et l'appelant écrirait alors
 * une confirmation sur un rendez-vous qui n'existe pas.
 */
function translate(error: unknown): BookingStoreRefusal | null {
  const { code, constraint } = pgFailure(error);
  if (code === '23P01' || constraint === 'hermes_appointments_no_overlap') {
    return new BookingStoreRefusal(
      'SLOT_TAKEN',
      'ce créneau chevauche un rendez-vous déjà confirmé — la base a refusé, personne ne le vole',
    );
  }
  if (code === '23505' && constraint === 'hermes_appointments_one_live_per_prospect_idx') {
    return new BookingStoreRefusal(
      'PROSPECT_ALREADY_BOOKED',
      'ce prospect porte déjà un rendez-vous vivant — un second passe par un report, jamais par un ajout',
    );
  }
  if (code === '23514' && constraint === 'hermes_appointment_interval_forward') {
    return new BookingStoreRefusal('INTERVAL_INVALID', 'la fin du créneau ne suit pas son début');
  }
  return null;
}

/**
 * Réserve, ou perd.
 *
 * §13 — l'idempotence est lue AVANT et APRÈS. Avant, pour ne pas tenter une
 * écriture qu'on sait inutile ; après, parce que « avant » ne prouve rien dans
 * une course : deux processus peuvent lire « absent » à la même microseconde, et
 * seul l'index tranche. Le perdant de CETTE course-là a écrit le même
 * rendez-vous que le gagnant, donc il rend la ligne du gagnant — c'est
 * exactement ce que « traiter deux fois le même message ne crée pas deux
 * rendez-vous » veut dire.
 */
export async function reserveAppointment(sql: Sql, input: ReserveInput): Promise<ReserveResult> {
  const existing = await loadByIdempotencyKey(sql, input.idempotencyKey);
  if (existing !== null) return Object.freeze({ appointment: existing, created: false });

  try {
    const appointment = await insertAppointment(sql, input);
    return Object.freeze({ appointment, created: true });
  } catch (error) {
    // Quelle que soit la contrainte qui a refusé, la PREMIÈRE question est
    // « est-ce nous ? ».
    //
    // Ce n'est pas de la prudence décorative : deux processus qui rejouent le
    // MÊME tour insèrent la même clé ET le même intervalle, et PostgreSQL
    // vérifie l'index d'exclusion AVANT l'unicité de la clé. Le second sort
    // donc en `23P01`, jamais en `23505`. Traduire ce code sans avoir relu la
    // clé ferait dire « ce créneau est pris » d'un rendez-vous qu'on venait
    // soi-même d'inscrire — c'est-à-dire refuser une réservation réussie, et
    // faire écrire à Hermes « ce n'est plus libre » sur son propre créneau.
    //
    // Le test §13 « deux processus rejouant le MÊME tour » l'a établi, et il
    // échoue si l'on remonte cette relecture après `translate`.
    const replayed = await loadByIdempotencyKey(sql, input.idempotencyKey);
    if (replayed !== null) return Object.freeze({ appointment: replayed, created: false });

    const refusal = translate(error);
    if (refusal !== null) throw refusal;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Écriture — le report et l'annulation
// ---------------------------------------------------------------------------

export interface RescheduleInput extends ReserveInput {
  /** Le rendez-vous à remplacer. Doit être CONFIRMED au moment de l'échange. */
  readonly previousAppointmentId: string;
  readonly at: Date;
  readonly reason: string;
}

/**
 * §14 — déplace un rendez-vous, sans jamais en laisser deux vivants.
 *
 * Tout tient dans UNE transaction, et l'ordre y est le sujet : ANNULER d'abord,
 * INSÉRER ensuite. L'inverse buterait sur l'index partiel « un vivant par
 * prospect » et il faudrait alors écrire à la main ce que l'index tient déjà —
 * la même leçon que `recordConversationPlan` avait apprise sur les plans.
 *
 * L'annulation est CONDITIONNELLE (`where status = 'CONFIRMED'`) et son résultat
 * est vérifié : si la ligne n'était plus vivante — annulée entre-temps par
 * quelqu'un d'autre —, la transaction lève et rien ne bouge. Sans cette
 * vérification, un report concurrent produirait un nouveau rendez-vous sans
 * jamais retirer l'ancien.
 *
 * Le nouveau créneau reste soumis à la contrainte d'exclusion : reporter sur un
 * créneau occupé échoue exactement comme une première réservation, et la
 * transaction rend alors l'ancien rendez-vous intact.
 */
export async function rescheduleAppointment(
  sql: Sql,
  input: RescheduleInput,
): Promise<ReserveResult> {
  const existing = await loadByIdempotencyKey(sql, input.idempotencyKey);
  if (existing !== null) return Object.freeze({ appointment: existing, created: false });

  try {
    const appointment = await sql.transaction(async (tx) => {
      const cancelled = await tx.query<{ id: string }>(
        `update hermes_appointments
            set status = 'CANCELLED', cancelled_at = $2, cancelled_reason = $3, updated_at = $2
          where id = $1 and status = 'CONFIRMED'
          returning id`,
        [input.previousAppointmentId, input.at.toISOString(), input.reason.slice(0, 200)],
      );
      if (cancelled.length === 0) {
        throw new BookingStoreRefusal(
          'APPOINTMENT_NOT_LIVE',
          `le rendez-vous ${input.previousAppointmentId} n'était plus confirmé — rien n'a été déplacé`,
        );
      }
      return insertAppointment(tx, { ...input, supersedesId: input.previousAppointmentId });
    });
    return Object.freeze({ appointment, created: true });
  } catch (error) {
    if (error instanceof BookingStoreRefusal) throw error;
    // Même relecture, et pour la même raison exacte que `reserveAppointment` :
    // un report rejoué bute sur l'exclusion avant de buter sur la clé.
    const replayed = await loadByIdempotencyKey(sql, input.idempotencyKey);
    if (replayed !== null) return Object.freeze({ appointment: replayed, created: false });

    const refusal = translate(error);
    if (refusal !== null) throw refusal;
    throw error;
  }
}

/**
 * §15 — annule, et rend le créneau à l'agenda.
 *
 * Conditionnelle sur `CONFIRMED` : annuler deux fois ne réécrit pas la première
 * annulation, et rend simplement la ligne telle qu'elle est. Un rendez-vous
 * annulé sort de l'index d'exclusion et de l'index « un vivant par prospect »,
 * donc son créneau redevient réservable immédiatement — par ce prospect comme
 * par un autre.
 */
export async function cancelAppointment(
  sql: Sql,
  input: { readonly appointmentId: string; readonly at: Date; readonly reason: string },
): Promise<Appointment> {
  const rows = await sql.query<AppointmentRow>(
    `update hermes_appointments
        set status = 'CANCELLED', cancelled_at = $2, cancelled_reason = $3, updated_at = $2
      where id = $1 and status = 'CONFIRMED'
      returning ${APPOINTMENT_COLUMNS}`,
    [input.appointmentId, input.at.toISOString(), input.reason.slice(0, 200)],
  );
  const row = rows[0];
  if (row !== undefined) return toAppointment(row);

  const current = await loadAppointmentById(sql, input.appointmentId);
  if (current === null) {
    throw new BookingStoreRefusal(
      'APPOINTMENT_NOT_LIVE',
      `aucun rendez-vous ${input.appointmentId}`,
    );
  }
  return current;
}

/**
 * §12 — le sort du DM de confirmation, inscrit APRÈS coup.
 *
 * Il ne touche jamais `status` : un rendez-vous réservé reste réservé même si le
 * message n'est pas parti. C'est la propriété que la mission demande en toutes
 * lettres — « ne supprime pas aveuglément le rendez-vous » —, et elle est ici
 * portée par le fait que cette fonction ne SAIT pas écrire dans `status`.
 */
export async function recordConfirmationOutcome(
  sql: Sql,
  input: {
    readonly appointmentId: string;
    readonly state: Exclude<ConfirmationState, 'PENDING'>;
    readonly at: Date;
  },
): Promise<Appointment | null> {
  const rows = await sql.query<AppointmentRow>(
    `update hermes_appointments
        set confirmation_state = $2,
            confirmed_at = case when $2 = 'DELIVERED' then $3 else confirmed_at end,
            updated_at = $3
      where id = $1
      returning ${APPOINTMENT_COLUMNS}`,
    [input.appointmentId, input.state, input.at.toISOString()],
  );
  const row = rows[0];
  return row === undefined ? null : toAppointment(row);
}

// ---------------------------------------------------------------------------
// Les propositions — un enregistrement, jamais une réservation
// ---------------------------------------------------------------------------

export interface BookingProposal {
  readonly id: string;
  readonly prospectId: string;
  readonly conversationKey: string;
  readonly triggerInboundMessageId: string | null;
  readonly calendarKey: string;
  readonly timezone: string;
  readonly slots: readonly Interval[];
  readonly proposedAt: string;
}

interface ProposalRow {
  readonly id: string;
  readonly prospectId: string;
  readonly conversationKey: string;
  readonly triggerInboundMessageId: string | null;
  readonly calendarKey: string;
  readonly timezone: string;
  readonly slots: unknown;
  readonly proposedAt: string | Date;
}

function toProposal(row: ProposalRow): BookingProposal {
  const raw = Array.isArray(row.slots) ? row.slots : [];
  const slots: Interval[] = [];
  for (const entry of raw) {
    const record = entry as { startsAt?: unknown; endsAt?: unknown };
    if (typeof record.startsAt !== 'string' || typeof record.endsAt !== 'string') continue;
    const startsAt = new Date(record.startsAt);
    const endsAt = new Date(record.endsAt);
    if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime())) continue;
    slots.push(Object.freeze({ startsAt, endsAt }));
  }
  return Object.freeze({
    id: row.id,
    prospectId: row.prospectId,
    conversationKey: row.conversationKey,
    triggerInboundMessageId: row.triggerInboundMessageId,
    calendarKey: row.calendarKey,
    timezone: row.timezone,
    slots: Object.freeze(slots),
    proposedAt: iso(row.proposedAt),
  });
}

const PROPOSAL_COLUMNS = `
  id, prospect_id as "prospectId", conversation_key as "conversationKey",
  trigger_inbound_message_id as "triggerInboundMessageId", calendar_key as "calendarKey",
  timezone, slots, proposed_at as "proposedAt"`;

export async function recordProposal(
  sql: Sql,
  input: {
    readonly prospectId: string;
    readonly conversationKey: string;
    readonly triggerInboundMessageId: string | null;
    readonly calendarKey: string;
    readonly timezone: string;
    readonly slots: readonly Interval[];
  },
): Promise<BookingProposal> {
  const payload = JSON.stringify(
    input.slots.map((slot) => ({
      startsAt: slot.startsAt.toISOString(),
      endsAt: slot.endsAt.toISOString(),
    })),
  );
  const rows = await sql.query<ProposalRow>(
    `insert into hermes_booking_proposals
       (prospect_id, conversation_key, trigger_inbound_message_id, calendar_key, timezone, slots, policy_version)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7)
     on conflict (prospect_id, trigger_inbound_message_id)
       where trigger_inbound_message_id is not null
       do update set slots = excluded.slots, proposed_at = hermes_booking_proposals.proposed_at
     returning ${PROPOSAL_COLUMNS}`,
    [
      input.prospectId,
      input.conversationKey,
      input.triggerInboundMessageId,
      input.calendarKey,
      input.timezone,
      payload,
      NATIVE_BOOKING_POLICY_VERSION,
    ],
  );
  return toProposal(rows[0] as ProposalRow);
}

/**
 * La dernière proposition faite à ce prospect.
 *
 * `id` départage un horodatage identique, pour la raison qui vaut partout
 * ailleurs dans le dépôt : sans lui, un uuid aléatoire déciderait lequel des
 * deux créneaux la personne vient d'accepter.
 */
export async function loadLatestProposal(
  sql: Sql,
  prospectId: string,
): Promise<BookingProposal | null> {
  const rows = await sql.query<ProposalRow>(
    `select ${PROPOSAL_COLUMNS} from hermes_booking_proposals
      where prospect_id = $1
      order by proposed_at desc, id desc
      limit 1`,
    [prospectId],
  );
  const row = rows[0];
  return row === undefined ? null : toProposal(row);
}

// ---------------------------------------------------------------------------
// Le journal — §21
// ---------------------------------------------------------------------------

export interface BookingEventInput {
  readonly prospectId: string;
  readonly conversationKey: string;
  readonly triggerInboundMessageId: string | null;
  readonly appointmentId?: string | null;
  readonly previousAppointmentId?: string | null;
  readonly intent: string;
  readonly outcome: string;
  readonly requestedExcerpt?: string | null;
  readonly requestedTimezone: string;
  readonly resolvedStartsAt?: Date | null;
  readonly resolvedEndsAt?: Date | null;
  readonly availabilityVerdict?: string | null;
  readonly ambiguityReason?: string | null;
  readonly errorCode?: string | null;
}

/**
 * Inscrit ce qui s'est passé, quoi qu'il se soit passé.
 *
 * Aucune décision ne LIT cette table. C'est délibéré : un journal qu'une porte
 * relit devient une donnée de production, et sa forme cesse alors de pouvoir
 * changer librement. Ici, on écrit pour un humain.
 */
export async function recordBookingEvent(sql: Sql, input: BookingEventInput): Promise<void> {
  await sql.query(
    `insert into hermes_booking_events (
       prospect_id, conversation_key, trigger_inbound_message_id, appointment_id,
       previous_appointment_id, intent, outcome, requested_excerpt, requested_timezone,
       resolved_starts_at, resolved_ends_at, availability_verdict, ambiguity_reason,
       error_code, policy_version
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      input.prospectId,
      input.conversationKey,
      input.triggerInboundMessageId,
      input.appointmentId ?? null,
      input.previousAppointmentId ?? null,
      input.intent,
      input.outcome,
      input.requestedExcerpt === null || input.requestedExcerpt === undefined
        ? null
        : input.requestedExcerpt.slice(0, 200),
      input.requestedTimezone,
      input.resolvedStartsAt?.toISOString() ?? null,
      input.resolvedEndsAt?.toISOString() ?? null,
      input.availabilityVerdict ?? null,
      input.ambiguityReason ?? null,
      input.errorCode ?? null,
      NATIVE_BOOKING_POLICY_VERSION,
    ],
  );
}

export interface BookingEventRow {
  readonly id: string;
  readonly intent: string;
  readonly outcome: string;
  readonly requestedExcerpt: string | null;
  readonly resolvedStartsAt: string | null;
  readonly availabilityVerdict: string | null;
  readonly ambiguityReason: string | null;
  readonly errorCode: string | null;
  readonly appointmentId: string | null;
  readonly previousAppointmentId: string | null;
  readonly observedAt: string;
}

export async function listBookingEvents(
  sql: Sql,
  prospectId: string,
  limit = 50,
): Promise<readonly BookingEventRow[]> {
  const rows = await sql.query<{
    id: string;
    intent: string;
    outcome: string;
    requestedExcerpt: string | null;
    resolvedStartsAt: string | Date | null;
    availabilityVerdict: string | null;
    ambiguityReason: string | null;
    errorCode: string | null;
    appointmentId: string | null;
    previousAppointmentId: string | null;
    observedAt: string | Date;
  }>(
    `select id, intent, outcome, requested_excerpt as "requestedExcerpt",
            resolved_starts_at as "resolvedStartsAt", availability_verdict as "availabilityVerdict",
            ambiguity_reason as "ambiguityReason", error_code as "errorCode",
            appointment_id as "appointmentId", previous_appointment_id as "previousAppointmentId",
            observed_at as "observedAt"
       from hermes_booking_events
      where prospect_id = $1
      order by observed_at desc, id desc
      limit $2`,
    [prospectId, limit],
  );
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        id: row.id,
        intent: row.intent,
        outcome: row.outcome,
        requestedExcerpt: row.requestedExcerpt,
        resolvedStartsAt: isoOrNull(row.resolvedStartsAt),
        availabilityVerdict: row.availabilityVerdict,
        ambiguityReason: row.ambiguityReason,
        errorCode: row.errorCode,
        appointmentId: row.appointmentId,
        previousAppointmentId: row.previousAppointmentId,
        observedAt: iso(row.observedAt),
      }),
    ),
  );
}
