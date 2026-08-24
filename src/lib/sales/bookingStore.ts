/**
 * HERMES-BOOKING-MECHANISM-R1 — la lecture et l'écriture des deux tables de
 * 0053, et rien d'autre.
 *
 * Ce module est le SEUL endroit qui sait écrire `APPOINTMENT_BOOKED`. Il n'a
 * volontairement aucun import de conversation, de brouillon, de manifeste ni de
 * primitive d'effet : il ne peut donc pas déduire un rendez-vous d'un message
 * parti, faute de savoir qu'un message existe. C'est la même discipline que
 * `booking.ts`, tenue par les imports plutôt que par la consigne.
 *
 * Il ne crée pas non plus de seconde file, de second CRM ni de second
 * ordonnanceur : ces tables ne portent ni destinataire, ni texte, ni horaire
 * d'envoi, et rien ici ne peut faire partir quoi que ce soit.
 */

import {
  BOOKING_MECHANISM_DEFAULT,
  BOOKING_POLICY_VERSION,
  checkBookingProof,
  type BookingEvidenceKind,
  type BookingIntentFacts,
  type BookingMechanism,
  type BookingProof,
  type PersistedBookingState,
} from '@/lib/sales/booking';
import type { Sql } from '@/lib/db/sql';

/** Un refus d'écriture, avec un code plutôt qu'une phrase libre. */
export class BookingRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'BookingRefusal';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// La destination
// ---------------------------------------------------------------------------

export type BookingDestinationStatus = 'UNCONFIRMED' | 'CONFIRMED' | 'REVOKED';

export interface BookingDestination {
  readonly id: string;
  readonly provider: string;
  readonly bookingUrl: string;
  readonly calendarRef: string | null;
  readonly status: BookingDestinationStatus;
  readonly confirmedBy: string | null;
  readonly confirmedAt: string | null;
  readonly reachableStatus: number | null;
  readonly reachableAt: string | null;
  readonly note: string | null;
}

interface DestinationRow {
  readonly id: string;
  readonly provider: string;
  readonly bookingUrl: string;
  readonly calendarRef: string | null;
  readonly status: BookingDestinationStatus;
  readonly confirmedBy: string | null;
  readonly confirmedAt: string | Date | null;
  readonly reachableStatus: number | string | null;
  readonly reachableAt: string | Date | null;
  readonly note: string | null;
}

function iso(value: string | Date | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function toDestination(row: DestinationRow): BookingDestination {
  return Object.freeze({
    id: row.id,
    provider: row.provider,
    bookingUrl: row.bookingUrl,
    calendarRef: row.calendarRef,
    status: row.status,
    confirmedBy: row.confirmedBy,
    confirmedAt: iso(row.confirmedAt),
    reachableStatus: row.reachableStatus === null ? null : Number(row.reachableStatus),
    reachableAt: iso(row.reachableAt),
    note: row.note,
  });
}

const DESTINATION_COLUMNS = `
  id, provider, booking_url as "bookingUrl", calendar_ref as "calendarRef",
  status, confirmed_by as "confirmedBy", confirmed_at as "confirmedAt",
  reachable_status as "reachableStatus", reachable_at as "reachableAt", note`;

export interface ObserveDestinationInput {
  readonly provider: string;
  readonly bookingUrl: string;
  readonly calendarRef?: string | null;
  /** Le code HTTP RENDU par le lien, en lecture seule. Jamais deviné. */
  readonly reachableStatus: number;
  readonly observedAt: Date;
  readonly note?: string | null;
}

/**
 * Dépose un mécanisme OBSERVÉ, sans l'autoriser.
 *
 * L'accessibilité est un paramètre plutôt qu'un appel réseau fait ici : ce
 * module ne doit pas savoir sortir sur Internet, et l'appelant (la CLI) passe
 * par `HttpClient` comme le veut CLAUDE.md. La conséquence utile est qu'un test
 * peut exercer la garde de confirmation sans toucher au réseau.
 *
 * Idempotente sur (`provider`, `booking_url`) : redéposer le même lien
 * rafraîchit l'observation au lieu d'ouvrir une seconde ligne.
 */
export async function observeBookingDestination(
  sql: Sql,
  input: ObserveDestinationInput,
): Promise<BookingDestination> {
  const rows = await sql.query<DestinationRow>(
    `insert into booking_destinations
       (provider, booking_url, calendar_ref, reachable_status, reachable_at, note)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (provider, booking_url) do update
       set calendar_ref     = excluded.calendar_ref,
           reachable_status = excluded.reachable_status,
           reachable_at     = excluded.reachable_at,
           note             = coalesce(excluded.note, booking_destinations.note),
           updated_at       = now()
     returning ${DESTINATION_COLUMNS}`,
    [
      input.provider,
      input.bookingUrl,
      input.calendarRef ?? null,
      input.reachableStatus,
      input.observedAt.toISOString(),
      input.note ?? null,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new BookingRefusal('OBSERVE_FAILED', 'aucune ligne rendue');
  return toDestination(row);
}

/**
 * Confirme un mécanisme, nommément.
 *
 * La SEULE porte vers une proposition de rendez-vous. Elle exige un nom, et
 * elle refuse un lien que personne n'a vu répondre — les deux contrôles sont
 * doublés par 0053, et c'est voulu : la contrainte est ce qui tient si un
 * appelant futur oublie de passer par ici.
 */
export async function confirmBookingDestination(
  sql: Sql,
  destinationId: string,
  confirmedBy: string,
  note: string | null,
): Promise<BookingDestination> {
  const who = confirmedBy.trim();
  if (who.length === 0) {
    throw new BookingRefusal('CONFIRM_ANONYMOUS', 'une confirmation exige un nom d’opérateur');
  }
  const current = await loadBookingDestination(sql, destinationId);
  if (current === null) {
    throw new BookingRefusal('DESTINATION_UNKNOWN', `destination ${destinationId} introuvable`);
  }
  if (current.status === 'REVOKED') {
    throw new BookingRefusal(
      'DESTINATION_REVOKED',
      'une destination retirée ne redevient jamais confirmée — il en faut une nouvelle',
    );
  }
  if (
    current.reachableStatus === null ||
    current.reachableStatus < 200 ||
    current.reachableStatus > 299 ||
    current.reachableAt === null
  ) {
    throw new BookingRefusal(
      'DESTINATION_UNREACHABLE',
      'ce lien n’a jamais été vu répondre — confirmer ici reviendrait à confirmer une chaîne de caractères',
    );
  }

  const rows = await sql.query<DestinationRow>(
    `update booking_destinations
        set status = 'CONFIRMED', confirmed_by = $2, confirmed_at = now(),
            note = coalesce($3, note), updated_at = now()
      where id = $1
      returning ${DESTINATION_COLUMNS}`,
    [destinationId, who, note],
  );
  const row = rows[0];
  if (row === undefined) throw new BookingRefusal('CONFIRM_FAILED', 'aucune ligne rendue');
  return toDestination(row);
}

/** Retire un mécanisme. Le défaut redevient « aucune réservation possible ». */
export async function revokeBookingDestination(
  sql: Sql,
  destinationId: string,
  revokedBy: string,
  reason: string,
): Promise<BookingDestination> {
  const who = revokedBy.trim();
  if (who.length === 0) {
    throw new BookingRefusal('REVOKE_ANONYMOUS', 'un retrait exige un nom d’opérateur');
  }
  const rows = await sql.query<DestinationRow>(
    `update booking_destinations
        set status = 'REVOKED', note = $2, updated_at = now()
      where id = $1
      returning ${DESTINATION_COLUMNS}`,
    [destinationId, `retiré par ${who} : ${reason}`],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new BookingRefusal('DESTINATION_UNKNOWN', `destination ${destinationId} introuvable`);
  }
  return toDestination(row);
}

export async function loadBookingDestination(
  sql: Sql,
  destinationId: string,
): Promise<BookingDestination | null> {
  const rows = await sql.query<DestinationRow>(
    `select ${DESTINATION_COLUMNS} from booking_destinations where id = $1`,
    [destinationId],
  );
  const row = rows[0];
  return row === undefined ? null : toDestination(row);
}

export async function listBookingDestinations(sql: Sql): Promise<readonly BookingDestination[]> {
  const rows = await sql.query<DestinationRow>(
    `select ${DESTINATION_COLUMNS} from booking_destinations order by created_at asc`,
  );
  return Object.freeze(rows.map(toDestination));
}

/** La destination confirmée, s'il y en a une. Au plus une (index unique). */
export async function loadConfirmedBookingDestination(
  sql: Sql,
): Promise<BookingDestination | null> {
  const rows = await sql.query<DestinationRow>(
    `select ${DESTINATION_COLUMNS} from booking_destinations where status = 'CONFIRMED' limit 1`,
  );
  const row = rows[0];
  return row === undefined ? null : toDestination(row);
}

/**
 * L'état du mécanisme, tel que la machine doit le lire.
 *
 * Fail-closed sur toute la ligne : une base injoignable, une table absente, une
 * requête qui lève — tout rend `MISSING_BOOKING_MECHANISM`. Le mode dégradé
 * d'un système de rendez-vous doit être « pas de rendez-vous », jamais « on
 * suppose que l'agenda est là ».
 */
export async function resolveBookingMechanism(sql: Sql): Promise<BookingMechanism> {
  try {
    const confirmed = await loadConfirmedBookingDestination(sql);
    if (confirmed !== null) return 'BOOKING_MECHANISM_READY';
    const rows = await sql.query<{ readonly n: string }>(
      `select count(*)::text as n from booking_destinations where status = 'UNCONFIRMED'`,
    );
    return Number(rows[0]?.n ?? '0') > 0
      ? 'BOOKING_MECHANISM_UNCONFIRMED'
      : BOOKING_MECHANISM_DEFAULT;
  } catch {
    return BOOKING_MECHANISM_DEFAULT;
  }
}

// ---------------------------------------------------------------------------
// La piste de rendez-vous
// ---------------------------------------------------------------------------

export interface BookingIntent extends BookingIntentFacts {
  readonly id: string;
  readonly prospectId: string;
  readonly proof: BookingProof | null;
}

interface IntentRow {
  readonly id: string;
  readonly prospectId: string;
  readonly destinationId: string;
  readonly state: PersistedBookingState;
  readonly policyVersion: string;
  readonly externalBookingRef: string | null;
  readonly scheduledStartAt: string | Date | null;
  readonly evidenceKind: BookingEvidenceKind | null;
  readonly observedBy: string | null;
  readonly observedAt: string | Date | null;
}

const INTENT_COLUMNS = `
  id, prospect_id as "prospectId", destination_id as "destinationId", state,
  policy_version as "policyVersion", external_booking_ref as "externalBookingRef",
  scheduled_start_at as "scheduledStartAt", evidence_kind as "evidenceKind",
  observed_by as "observedBy", observed_at as "observedAt"`;

function toIntent(row: IntentRow): BookingIntent {
  const start = iso(row.scheduledStartAt);
  const observed = iso(row.observedAt);
  const proof: BookingProof | null =
    row.externalBookingRef !== null &&
    start !== null &&
    row.evidenceKind !== null &&
    row.observedBy !== null &&
    observed !== null
      ? Object.freeze({
          externalBookingRef: row.externalBookingRef,
          scheduledStartAt: start,
          evidenceKind: row.evidenceKind,
          observedBy: row.observedBy,
          observedAt: observed,
        })
      : null;

  return Object.freeze({
    id: row.id,
    prospectId: row.prospectId,
    destinationId: row.destinationId,
    state: row.state,
    policyVersion: row.policyVersion,
    // Dérivé de l'état plutôt que stocké : une seconde colonne qui dirait la
    // même chose finirait par la dire autrement.
    proposalDelivered: row.state === 'BOOKING_PENDING',
    proof,
  });
}

/**
 * La piste VIVANTE d'un prospect, s'il y en a une.
 *
 * Le prédicat est mot pour mot celui de l'index unique de 0053. Une piste
 * refusée n'est pas vivante et n'est donc pas rendue ici — c'est ce qui permet
 * à un prospect qui a dit non en mars d'être rappelé en septembre sans qu'un
 * doublon devienne possible entre les deux.
 */
export async function loadLiveBookingIntent(
  sql: Sql,
  prospectId: string,
): Promise<BookingIntent | null> {
  const rows = await sql.query<IntentRow>(
    `select ${INTENT_COLUMNS} from booking_intents
      where prospect_id = $1
        and state in ('BOOKING_PROPOSED', 'BOOKING_PENDING', 'APPOINTMENT_BOOKED')
      limit 1`,
    [prospectId],
  );
  const row = rows[0];
  return row === undefined ? null : toIntent(row);
}

/**
 * Ouvre une piste, ou rend celle qui existe déjà.
 *
 * IDEMPOTENTE, et c'est le point : `on conflict do nothing` sur l'index unique
 * partiel, puis relecture. Deux workers qui lisent la même conversation à la
 * même microseconde obtiennent la même piste, donc un seul rendez-vous
 * logique — la garde vit dans PostgreSQL, pas dans un `if` applicatif que la
 * concurrence traverse.
 */
export async function openBookingIntent(
  sql: Sql,
  input: { readonly prospectId: string; readonly destinationId: string },
): Promise<BookingIntent> {
  const destination = await loadBookingDestination(sql, input.destinationId);
  if (destination === null || destination.status !== 'CONFIRMED') {
    throw new BookingRefusal(
      'DESTINATION_NOT_CONFIRMED',
      'une piste ne s’ouvre que sur une destination CONFIRMED',
    );
  }

  await sql.query(
    `insert into booking_intents (prospect_id, destination_id, state, policy_version)
     values ($1, $2, 'BOOKING_PROPOSED', $3)
     on conflict do nothing`,
    [input.prospectId, input.destinationId, BOOKING_POLICY_VERSION],
  );

  const existing = await loadLiveBookingIntent(sql, input.prospectId);
  if (existing === null) {
    throw new BookingRefusal('INTENT_OPEN_FAILED', 'aucune piste vivante après ouverture');
  }
  return existing;
}

/**
 * La proposition est PARTIE.
 *
 * Ce que cette fonction fait : passer de `BOOKING_PROPOSED` à
 * `BOOKING_PENDING`. Ce qu'elle ne fait PAS, et qui est tout l'objet du round :
 * écrire `APPOINTMENT_BOOKED`. Un lien remis est un lien remis — la personne
 * n'a encore rien réservé, et l'état le dit.
 */
export async function markBookingProposalDelivered(
  sql: Sql,
  intentId: string,
): Promise<BookingIntent> {
  const rows = await sql.query<IntentRow>(
    `update booking_intents
        set state = 'BOOKING_PENDING', updated_at = now()
      where id = $1 and state = 'BOOKING_PROPOSED'
      returning ${INTENT_COLUMNS}`,
    [intentId],
  );
  const row = rows[0];
  if (row !== undefined) return toIntent(row);

  const current = await loadBookingIntentById(sql, intentId);
  if (current === null) {
    throw new BookingRefusal('INTENT_UNKNOWN', `piste ${intentId} introuvable`);
  }
  // Rejouer une remise déjà enregistrée n'est pas une faute : c'est le cas
  // normal d'un worker relancé. Il n'y a rien à écrire de plus.
  if (current.state === 'BOOKING_PENDING') return current;
  throw new BookingRefusal(
    'INTENT_NOT_PROPOSED',
    `piste en ${current.state} — une remise ne s’enregistre que sur BOOKING_PROPOSED`,
  );
}

export async function loadBookingIntentById(
  sql: Sql,
  intentId: string,
): Promise<BookingIntent | null> {
  const rows = await sql.query<IntentRow>(
    `select ${INTENT_COLUMNS} from booking_intents where id = $1`,
    [intentId],
  );
  const row = rows[0];
  return row === undefined ? null : toIntent(row);
}

export interface RecordProofInput {
  readonly intentId: string;
  readonly externalBookingRef: string;
  readonly scheduledStartAt: string;
  readonly evidenceKind: BookingEvidenceKind;
  readonly observedBy: string;
  readonly observedAt: string;
}

/**
 * Écrit `APPOINTMENT_BOOKED` — la seule fonction du dépôt qui le peut.
 *
 * Trois choses la rendent difficile à tromper :
 *
 *   1. elle ne reçoit AUCUN fait de conversation. Il n'y a ni identifiant de
 *      message, ni empreinte de brouillon dans `RecordProofInput` : un
 *      rendez-vous ne peut donc pas se déduire d'un envoi, faute de matière ;
 *   2. la preuve passe par `checkBookingProof`, qui refuse un identifiant vide,
 *      un créneau absent, illisible ou passé, un observateur anonyme ;
 *   3. le résultat est doublé par 0053 — `booking_intent_booked_has_proof` — si
 *      bien qu'un appelant futur qui contournerait ce module se ferait refuser
 *      par la base.
 *
 * Idempotente sur la référence du fournisseur : rejouer la MÊME preuve rend le
 * même rendez-vous. En rejouer une AUTRE sur une piste déjà réservée est un
 * refus, pas une mise à jour silencieuse — deux références sur une seule piste
 * veut dire que quelqu'un s'est trompé de fil.
 */
export async function recordAppointmentProof(
  sql: Sql,
  input: RecordProofInput,
  now: Date,
): Promise<BookingIntent> {
  const check = checkBookingProof(input, now);
  if (!check.ok) {
    throw new BookingRefusal(
      'BOOKING_PROOF_INSUFFICIENT',
      `preuve insuffisante : ${check.refusals.join(', ')}`,
    );
  }
  const proof = check.proof;

  const current = await loadBookingIntentById(sql, input.intentId);
  if (current === null) {
    throw new BookingRefusal('INTENT_UNKNOWN', `piste ${input.intentId} introuvable`);
  }
  if (current.state === 'APPOINTMENT_BOOKED') {
    if (current.proof?.externalBookingRef === proof.externalBookingRef) return current;
    throw new BookingRefusal(
      'BOOKING_ALREADY_PROVEN',
      'cette piste porte déjà un rendez-vous sous une autre référence',
    );
  }
  if (current.state === 'BOOKING_DECLINED') {
    throw new BookingRefusal(
      'INTENT_DECLINED',
      'cette piste porte un refus — une preuve ne le renverse pas en silence',
    );
  }

  const rows = await sql.query<IntentRow>(
    `update booking_intents
        set state = 'APPOINTMENT_BOOKED',
            external_booking_ref = $2, scheduled_start_at = $3,
            evidence_kind = $4, observed_by = $5, observed_at = $6,
            updated_at = now()
      where id = $1 and state in ('BOOKING_PROPOSED', 'BOOKING_PENDING')
      returning ${INTENT_COLUMNS}`,
    [
      input.intentId,
      proof.externalBookingRef,
      proof.scheduledStartAt,
      proof.evidenceKind,
      proof.observedBy,
      proof.observedAt,
    ],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new BookingRefusal('INTENT_RACE', 'la piste a changé d’état pendant l’écriture');
  }
  return toIntent(row);
}

/** La personne a refusé l'échange. La piste sort du vivant. */
export async function declineBookingIntent(
  sql: Sql,
  intentId: string,
): Promise<BookingIntent> {
  const rows = await sql.query<IntentRow>(
    `update booking_intents
        set state = 'BOOKING_DECLINED', declined_at = now(), updated_at = now()
      where id = $1 and state in ('BOOKING_PROPOSED', 'BOOKING_PENDING')
      returning ${INTENT_COLUMNS}`,
    [intentId],
  );
  const row = rows[0];
  if (row !== undefined) return toIntent(row);

  const current = await loadBookingIntentById(sql, intentId);
  if (current === null) {
    throw new BookingRefusal('INTENT_UNKNOWN', `piste ${intentId} introuvable`);
  }
  if (current.state === 'BOOKING_DECLINED') return current;
  throw new BookingRefusal(
    'INTENT_BOOKED',
    'un rendez-vous prouvé ne s’annule pas ici — c’est une décision humaine',
  );
}
