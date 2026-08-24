import type { Sql } from '@/lib/db/sql';
import {
  extractEmailAddress,
  type EmailProvider,
  type ProviderEmailRecord,
  type SenderIdentity,
} from '@/lib/pipeline/r6bLiveEmail';

/**
 * R6B-D1.1 — inscrire l'identité RFC d'un envoi déjà parti, et rien d'autre.
 *
 * Le premier email réel de Hermes est parti le 2026-08-12, avant que le dépôt
 * sache lire le champ `message_id` de Resend. Sa ligne porte donc un
 * `provider_message_id` (l'identifiant interne Resend) mais pas son
 * `provider_rfc_message_id` (l'en-tête `Message-ID` RFC 5322). Or c'est le
 * second, et lui seul, qu'une réponse cite dans `In-Reply-To` / `References` :
 * sans lui, la corrélation entrante ne peut atteindre `EXACT` et retombe sur le
 * repli plafonné à `HIGH_CONFIDENCE` (`src/lib/inbound/correlation.ts`).
 *
 * ---------------------------------------------------------------------------
 * Ce que ce module fait, et la frontière qu'il ne franchit pas
 * ---------------------------------------------------------------------------
 *
 * Il fait UNE lecture (`GET /emails/{id}`) et, si tout concorde, UNE écriture
 * d'une seule colonne. Il n'envoie rien et ne peut rien envoyer : `send` n'est
 * jamais appelé, aucun payload n'est construit, aucune clé d'idempotence n'est
 * dérivée. Il ne touche ni le statut, ni `provider_message_id`, ni le
 * manifeste, ni `outreach_events`, ni aucun horodatage de l'envoi d'origine —
 * l'écriture nomme sa colonne, et une seule.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi une identité ASSERTÉE par l'appelant
 * ---------------------------------------------------------------------------
 *
 * L'appelant doit fournir manifeste, identifiant provider, destinataire et
 * objet attendus. Ils sont confrontés à la base AVANT le réseau, puis à ce que
 * le provider relit. Lire ces valeurs depuis la base pour les comparer à
 * elles-mêmes ne vérifierait rien ; les exiger d'un humain fait de chaque
 * exécution une affirmation vérifiable — et un écart, un refus qui n'écrit
 * rien.
 *
 * Fail-closed de bout en bout : tout écart bloque, y compris « le provider ne
 * donne pas de `message_id` ». Une identité manquante reste `NULL` — « non
 * observé » est une valeur honnête, une valeur devinée n'en est pas une
 * (CLAUDE.md, interdit n°2).
 */

/**
 * Forme d'un `msg-id` RFC 5322, chevrons compris. Volontairement identique à la
 * contrainte `check` de la colonne (migration 0025) : ce qui est refusé ici
 * serait refusé par la base, et le dire avant l'écriture donne un motif lisible
 * au lieu d'une violation de contrainte.
 */
export const RFC_MESSAGE_ID_SHAPE = /^<[^<>\s]+@[^<>\s]+>$/;

export type RfcBackfillBlockCode =
  /** Aucun envoi confirmé pour ce manifeste — il n'y a pas d'identité à inscrire. */
  | 'NO_SENT_ATTEMPT'
  /** Plusieurs envois confirmés : la base l'interdit, mais on ne devine pas lequel. */
  | 'MULTIPLE_SENT_ATTEMPTS'
  | 'PROVIDER_MISMATCH'
  | 'PROVIDER_MESSAGE_ID_MISMATCH'
  | 'RECIPIENT_MISMATCH'
  | 'SUBJECT_MISMATCH'
  /** Le provider ne connaît pas cet identifiant. Ne prouve rien sur l'envoi, mais interdit d'écrire. */
  | 'PROVIDER_RECORD_NOT_FOUND'
  | 'PROVIDER_ID_MISMATCH'
  | 'PROVIDER_RECIPIENT_MISMATCH'
  | 'PROVIDER_SUBJECT_MISMATCH'
  | 'PROVIDER_SENDER_MISMATCH'
  | 'RFC_MESSAGE_ID_ABSENT'
  | 'RFC_MESSAGE_ID_MALFORMED'
  /** Une autre identité RFC est déjà inscrite. Écraser effacerait une observation. */
  | 'RFC_MESSAGE_ID_CONFLICT';

export class RfcBackfillBlockedError extends Error {
  readonly code: RfcBackfillBlockCode;

  constructor(code: RfcBackfillBlockCode, message: string) {
    super(message);
    this.name = 'RfcBackfillBlockedError';
    this.code = code;
  }
}

/**
 * L'identité que l'appelant affirme. Les quatre champs sont exigés : aucun
 * n'est déduit d'un autre, et aucun n'a de valeur par défaut.
 */
export interface RfcBackfillExpectation {
  readonly manifestId: string;
  readonly providerMessageId: string;
  readonly recipient: string;
  readonly subject: string;
}

export interface RfcBackfillDeps {
  /**
   * Exigé, jamais construit ici — comme partout ailleurs dans le domaine : un
   * test qui oublierait de brancher un faux provider ne compilerait pas.
   */
  readonly provider: EmailProvider;
  /**
   * L'identité d'expéditeur configurée, comparée au `from` relu quand le
   * provider l'expose. Une relecture qui viendrait d'un autre expéditeur ne
   * serait pas notre envoi.
   */
  readonly senderIdentity: SenderIdentity;
}

export type RfcBackfillStatus =
  /** `NULL` → valeur exacte relue chez le provider. Une ligne écrite. */
  | 'BACKFILLED'
  /** La même valeur était déjà inscrite. Aucune écriture. */
  | 'ALREADY_PRESENT';

export interface RfcBackfillResult {
  readonly status: RfcBackfillStatus;
  readonly manifestId: string;
  readonly liveAttemptId: string;
  readonly providerMessageId: string;
  readonly rfcMessageId: string;
  /** Vrai si le provider a exposé un `from` et qu'il a pu être confronté. */
  readonly senderChecked: boolean;
  /** Nombre de lignes réellement modifiées : 1 sur un backfill, 0 sur un no-op. */
  readonly rowsUpdated: number;
  readonly detail: string;
}

interface SentAttemptRow {
  id: string;
  provider: string;
  providerMessageId: string | null;
  providerRfcMessageId: string | null;
  transport: string;
  recipient: string;
  subject: string | null;
}

/** Adresse nue, comparable : deux formes d'écriture d'une même boîte doivent concorder. */
function comparableAddress(value: string | null): string | null {
  if (value === null) return null;
  const address = extractEmailAddress(value);
  return address === null ? null : address.toLowerCase();
}

async function loadSentAttempt(sql: Sql, manifestId: string): Promise<SentAttemptRow> {
  const rows = await sql.query<SentAttemptRow>(
    `select s.id,
            s.provider,
            s.provider_message_id      as "providerMessageId",
            s.provider_rfc_message_id  as "providerRfcMessageId",
            s.transport,
            s.recipient,
            m.transport_payload->>'subject' as "subject"
       from r6b_live_send_attempts s
       join r6b_dispatch_manifests m on m.id = s.manifest_id
      where s.manifest_id = $1 and s.status = 'SENT'
      order by s.claimed_at asc`,
    [manifestId],
  );

  const row = rows[0];
  if (row === undefined) {
    throw new RfcBackfillBlockedError(
      'NO_SENT_ATTEMPT',
      `aucun envoi confirmé pour le manifeste ${manifestId} — il n'existe aucune identité RFC à inscrire`,
    );
  }
  if (rows.length > 1) {
    throw new RfcBackfillBlockedError(
      'MULTIPLE_SENT_ATTEMPTS',
      `${rows.length} envois confirmés pour le manifeste ${manifestId} — lequel porte cette identité ne se devine pas`,
    );
  }
  return row;
}

/** Confronte la ligne de base à l'identité assertée. Aucun réseau n'a encore été touché. */
function assertStoredIdentity(row: SentAttemptRow, expectation: RfcBackfillExpectation, providerName: string): void {
  if (row.provider !== providerName) {
    throw new RfcBackfillBlockedError(
      'PROVIDER_MISMATCH',
      `l'envoi a été fait par « ${row.provider} », relu ici par « ${providerName} »`,
    );
  }
  if (row.providerMessageId !== expectation.providerMessageId) {
    throw new RfcBackfillBlockedError(
      'PROVIDER_MESSAGE_ID_MISMATCH',
      `l'identifiant provider enregistré (${row.providerMessageId ?? 'aucun'}) ` +
        `n'est pas celui affirmé (${expectation.providerMessageId})`,
    );
  }
  if (row.recipient !== expectation.recipient) {
    throw new RfcBackfillBlockedError(
      'RECIPIENT_MISMATCH',
      `le destinataire enregistré (${row.recipient}) n'est pas celui affirmé (${expectation.recipient})`,
    );
  }
  if (row.subject !== expectation.subject) {
    throw new RfcBackfillBlockedError(
      'SUBJECT_MISMATCH',
      `l'objet du manifeste (${row.subject ?? 'aucun'}) n'est pas celui affirmé (${expectation.subject})`,
    );
  }
}

/**
 * Confronte la relecture provider à la même identité, puis en extrait le
 * `Message-ID` RFC. Rien n'est déduit : un champ absent bloque au lieu d'être
 * reconstruit.
 */
function readRfcMessageId(
  record: ProviderEmailRecord | null,
  expectation: RfcBackfillExpectation,
  senderIdentity: SenderIdentity,
): { readonly rfcMessageId: string; readonly senderChecked: boolean } {
  if (record === null) {
    throw new RfcBackfillBlockedError(
      'PROVIDER_RECORD_NOT_FOUND',
      `le provider ne connaît pas l'identifiant ${expectation.providerMessageId} — ` +
        'ceci ne prouve pas qu’aucun email n’est parti, mais interdit d’en inscrire l’identité',
    );
  }
  if (record.id !== expectation.providerMessageId) {
    throw new RfcBackfillBlockedError(
      'PROVIDER_ID_MISMATCH',
      `la relecture porte l'identifiant ${record.id}, pas ${expectation.providerMessageId}`,
    );
  }

  // Un envoi du dépôt vise exactement un destinataire (`to: envelope.recipient`).
  // Une relecture qui en porterait un autre, ou un de plus, n'est pas celui-là.
  const recipients = record.to.map((address) => address.toLowerCase());
  const expectedRecipient = expectation.recipient.toLowerCase();
  if (recipients.length !== 1 || recipients[0] !== expectedRecipient) {
    throw new RfcBackfillBlockedError(
      'PROVIDER_RECIPIENT_MISMATCH',
      `la relecture vise [${record.to.join(', ')}], pas le seul ${expectation.recipient}`,
    );
  }
  if (record.subject !== expectation.subject) {
    throw new RfcBackfillBlockedError(
      'PROVIDER_SUBJECT_MISMATCH',
      `la relecture porte l'objet « ${record.subject ?? 'aucun'} », pas « ${expectation.subject} »`,
    );
  }

  // « Where available » : Resend n'expose pas toujours `from` sur une
  // relecture. Absent, il n'est pas vérifiable — et un contrôle non fait est
  // signalé (`senderChecked`), jamais présenté comme réussi.
  const observedSender = comparableAddress(record.from);
  const expectedSender = comparableAddress(senderIdentity.from);
  const senderChecked = observedSender !== null && expectedSender !== null;
  if (senderChecked && observedSender !== expectedSender) {
    throw new RfcBackfillBlockedError(
      'PROVIDER_SENDER_MISMATCH',
      `la relecture vient de « ${record.from ?? 'inconnu'} », pas de l'expéditeur configuré`,
    );
  }

  if (record.rfcMessageId === null) {
    throw new RfcBackfillBlockedError(
      'RFC_MESSAGE_ID_ABSENT',
      `la relecture de ${record.id} ne porte aucun « message_id » — ` +
        'la colonne reste NULL, qui est la seule valeur honnête pour une identité non observée',
    );
  }
  if (!RFC_MESSAGE_ID_SHAPE.test(record.rfcMessageId)) {
    throw new RfcBackfillBlockedError(
      'RFC_MESSAGE_ID_MALFORMED',
      `« ${record.rfcMessageId} » n'a pas la forme d'un Message-ID RFC 5322 (<local@domaine>)`,
    );
  }

  return { rfcMessageId: record.rfcMessageId, senderChecked };
}

/**
 * Inscrit l'identité RFC d'un envoi déjà confirmé.
 *
 * Trois issues et trois seulement :
 *
 *   * `BACKFILLED`      — la colonne était `NULL`, elle porte maintenant la
 *                         valeur relue chez le provider ;
 *   * `ALREADY_PRESENT` — elle portait déjà exactement cette valeur : rien
 *                         n'est écrit, et relancer la commande est sans effet ;
 *   * une exception     — tout le reste. Rien n'est écrit.
 *
 * L'idempotence ne repose pas sur la lecture qui précède l'écriture : l'`update`
 * porte lui-même `provider_rfc_message_id is null` dans son `where`. Deux
 * exécutions simultanées ne peuvent donc pas écrire toutes les deux, et celle
 * qui perd la course relit la valeur gagnante et la compare au lieu de
 * l'écraser.
 */
export async function backfillRfcMessageId(
  sql: Sql,
  expectation: RfcBackfillExpectation,
  deps: RfcBackfillDeps,
): Promise<RfcBackfillResult> {
  const row = await loadSentAttempt(sql, expectation.manifestId);
  assertStoredIdentity(row, expectation, deps.provider.name);

  // L'unique appel réseau de ce module, et il est en lecture seule.
  const record = await deps.provider.retrieve(expectation.providerMessageId);
  const { rfcMessageId, senderChecked } = readRfcMessageId(record, expectation, deps.senderIdentity);

  if (row.providerRfcMessageId !== null) {
    if (row.providerRfcMessageId === rfcMessageId) {
      return Object.freeze({
        status: 'ALREADY_PRESENT' as const,
        manifestId: expectation.manifestId,
        liveAttemptId: row.id,
        providerMessageId: expectation.providerMessageId,
        rfcMessageId,
        senderChecked,
        rowsUpdated: 0,
        detail: 'la colonne portait déjà exactement cette identité — aucune écriture',
      });
    }
    throw new RfcBackfillBlockedError(
      'RFC_MESSAGE_ID_CONFLICT',
      `la tentative ${row.id} porte déjà « ${row.providerRfcMessageId} », et le provider relit ` +
        `« ${rfcMessageId} ». Écraser effacerait une observation : un humain doit trancher.`,
    );
  }

  const updated = await sql.query<{ id: string }>(
    // Une colonne, nommée. Le statut, l'identifiant provider, les empreintes et
    // les horodatages de l'envoi d'origine ne sont pas dans cet `update`, donc
    // ne peuvent pas bouger. Le `where` complet rejoue toutes les gardes en
    // base : c'est lui qui rend l'écriture sûre, pas la lecture qui précède.
    `update r6b_live_send_attempts
        set provider_rfc_message_id = $2
      where id = $1
        and status = 'SENT'
        and provider_message_id = $3
        and recipient = $4
        and provider_rfc_message_id is null
      returning id`,
    [row.id, rfcMessageId, expectation.providerMessageId, expectation.recipient],
  );

  if (updated.length === 1) {
    return Object.freeze({
      status: 'BACKFILLED' as const,
      manifestId: expectation.manifestId,
      liveAttemptId: row.id,
      providerMessageId: expectation.providerMessageId,
      rfcMessageId,
      senderChecked,
      rowsUpdated: 1,
      detail: `identité RFC inscrite depuis GET /emails/${expectation.providerMessageId}`,
    });
  }

  // Zéro ligne : quelqu'un d'autre a écrit entre la lecture et l'`update`. On
  // relit ce qui a gagné plutôt que de retenter — retenter écraserait.
  const current = await sql.query<{ providerRfcMessageId: string | null }>(
    `select provider_rfc_message_id as "providerRfcMessageId" from r6b_live_send_attempts where id = $1`,
    [row.id],
  );
  const winner = current[0]?.providerRfcMessageId ?? null;
  if (winner === rfcMessageId) {
    return Object.freeze({
      status: 'ALREADY_PRESENT' as const,
      manifestId: expectation.manifestId,
      liveAttemptId: row.id,
      providerMessageId: expectation.providerMessageId,
      rfcMessageId,
      senderChecked,
      rowsUpdated: 0,
      detail: 'une écriture concurrente a inscrit exactement cette identité — aucune écriture ici',
    });
  }
  throw new RfcBackfillBlockedError(
    'RFC_MESSAGE_ID_CONFLICT',
    `l'écriture n'a touché aucune ligne : la tentative ${row.id} porte désormais ` +
      `« ${winner ?? 'NULL'} » et non « ${rfcMessageId} » — rien n'a été modifié, un humain doit trancher.`,
  );
}
