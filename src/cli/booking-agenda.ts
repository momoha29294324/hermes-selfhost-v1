#!/usr/bin/env tsx
/**
 * HERMES-NATIVE-BOOKING-R1 §21 — l'AGENDA, pour un opérateur.
 *
 *   npm run booking:agenda                        # les rendez-vous à venir
 *   npm run booking:agenda -- --json              # sortie machine
 *   npm run booking:agenda -- --prospect <uuid>   # une fiche : rendez-vous + journal
 *   npm run booking:agenda -- --days 30
 *
 * ---------------------------------------------------------------------------
 * Ce qu'elle répond, et ce qu'elle ne répond pas
 * ---------------------------------------------------------------------------
 * Elle répond à « quels créneaux sont pris, et pourquoi ce prospect n'a-t-il
 * pas de rendez-vous ? ». Elle ne répond PAS à « faut-il envoyer maintenant »,
 * qui reste la question du crochet pré-effet, ni à « le rail est-il armé »,
 * qui est celle de `autoreply:status`.
 *
 * ---------------------------------------------------------------------------
 * Elle n'écrit rien, et ne peut rien envoyer
 * ---------------------------------------------------------------------------
 * Aucun `insert`, aucun `update`. Aucun import de provider, de navigateur, de
 * rail ni de `setKillSwitch`. Elle ne sait ni prendre, ni déplacer, ni annuler
 * un rendez-vous : ces trois gestes appartiennent au rail conversationnel, qui
 * les fait sous les gardes de §5 et §12. Une commande capable de les faire à la
 * main serait un second chemin d'écriture vers l'agenda, c'est-à-dire une
 * seconde manière de créer un double-booking.
 */
import { getSql } from '@/lib/db';
import { loadBookingPolicy } from '@/lib/config/load';
import { formatSlot, presentedDurationLabel } from '@/lib/booking/statement';
import { listAppointments, listBookingEvents } from '@/lib/booking/store';
import type { Sql } from '@/lib/db/sql';

class ArgError extends Error {}

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

interface Args {
  readonly json: boolean;
  readonly prospectId: string | null;
  readonly days: number;
}

function parseArgs(argv: readonly string[]): Args {
  let json = false;
  let prospectId: string | null = null;
  let days = 14;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') json = true;
    else if (arg === '--prospect') {
      const value = argv[i + 1];
      if (value === undefined) throw new ArgError('--prospect attend un identifiant');
      prospectId = value;
      i += 1;
    } else if (arg === '--days') {
      const value = argv[i + 1];
      if (value === undefined) throw new ArgError('--days attend un nombre');
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 365) {
        throw new ArgError('--days doit être compris entre 1 et 365');
      }
      days = parsed;
      i += 1;
    } else throw new ArgError(`option inconnue : ${String(arg)}`);
  }

  return { json, prospectId, days };
}

interface AgendaRow {
  readonly id: string;
  readonly prospectId: string;
  readonly displayName: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timezone: string;
  readonly confirmationState: string;
  readonly source: string;
}

async function loadAgenda(sql: Sql, days: number): Promise<readonly AgendaRow[]> {
  return sql.query<AgendaRow>(
    `select a.id, a.prospect_id as "prospectId", p.display_name as "displayName",
            a.starts_at as "startsAt", a.ends_at as "endsAt", a.timezone,
            a.confirmation_state as "confirmationState", a.source
       from hermes_appointments a
       join prospects p on p.id = a.prospect_id
      where a.status = 'CONFIRMED'
        and a.ends_at > now()
        and a.starts_at < now() + ($1 || ' days')::interval
      order by a.starts_at asc, a.id asc`,
    [String(days)],
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const policy = loadBookingPolicy();
  const sql = await getSql();

  try {
    if (args.prospectId !== null) {
      const appointments = await listAppointments(sql, args.prospectId);
      const events = await listBookingEvents(sql, args.prospectId);

      if (args.json) {
        out(JSON.stringify({ policy, appointments, events }, null, 2));
        return;
      }

      out('');
      out(`RENDEZ-VOUS — prospect ${args.prospectId}`);
      if (appointments.length === 0) out('  aucun rendez-vous, ni passé ni à venir');
      for (const entry of appointments) {
        const when = formatSlot(
          { startsAt: new Date(entry.startsAt), endsAt: new Date(entry.endsAt) },
          entry.timezone,
        );
        out(
          `  ${entry.status.padEnd(10)} ${when} — confirmation ${entry.confirmationState}` +
            `${entry.cancelledReason === null ? '' : ` — ${entry.cancelledReason}`}`,
        );
      }

      out('');
      out('JOURNAL DES DÉCISIONS (§21) — la plus récente d’abord');
      if (events.length === 0) out('  aucune décision d’agenda pour ce prospect');
      for (const entry of events) {
        const detail = [
          entry.resolvedStartsAt === null ? null : `créneau ${entry.resolvedStartsAt}`,
          entry.availabilityVerdict === null ? null : `dispo ${entry.availabilityVerdict}`,
          entry.ambiguityReason === null ? null : `ambiguïté ${entry.ambiguityReason}`,
          entry.errorCode === null ? null : `refus ${entry.errorCode}`,
          entry.requestedExcerpt === null ? null : `« ${entry.requestedExcerpt} »`,
        ]
          .filter((part): part is string => part !== null)
          .join(' · ');
        out(`  ${entry.observedAt}  ${entry.intent.padEnd(17)} → ${entry.outcome.padEnd(24)} ${detail}`);
      }
      out('');
      return;
    }

    const agenda = await loadAgenda(sql, args.days);
    if (args.json) {
      out(JSON.stringify({ policy, agenda }, null, 2));
      return;
    }

    out('');
    out(`AGENDA — ${policy.calendarKey} (${policy.timezone}), ${String(args.days)} prochains jours`);
    out(
      `  annoncé ${presentedDurationLabel(policy)} · bloc réservé ` +
        `${String(policy.appointmentDurationMinutes)} min · ` +
        `préavis ${String(policy.minNoticeMinutes)} min · horizon ${String(policy.maxHorizonDays)} j`,
    );
    out('');
    if (agenda.length === 0) {
      out('  aucun rendez-vous confirmé sur cette période');
    }
    for (const entry of agenda) {
      const when = formatSlot(
        { startsAt: new Date(entry.startsAt), endsAt: new Date(entry.endsAt) },
        entry.timezone,
      );
      out(`  ${when}  ${entry.displayName}`);
      out(`      prospect ${entry.prospectId} · source ${entry.source} · confirmation ${entry.confirmationState}`);
    }
    out('');
  } finally {
    await sql.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ArgError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
