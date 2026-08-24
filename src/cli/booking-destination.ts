#!/usr/bin/env tsx
/**
 * HERMES-BOOKING-MECHANISM-R1 — la SEULE porte vers un mécanisme de
 * réservation, et elle est manuelle.
 *
 *   npm run booking:status                                        # lit, n'écrit rien
 *   npm run booking:destination -- --observe --provider <nom> \
 *          --url "https://…" [--calendar-ref <id>] --as "<nom>"   # dépose, sans autoriser
 *   npm run booking:destination -- --confirm <id> --as "<nom>" [--note "<motif>"]
 *   npm run booking:destination -- --revoke  <id> --as "<nom>" --reason "<motif>"
 *
 * `--observe` fait UNE requête `GET` sur le lien, via `HttpClient`, et
 * enregistre le code rendu. Elle ne SOUMET aucune réservation : un `GET` charge
 * la page de prise de rendez-vous, il n'y prend pas de créneau. C'est la
 * différence entre vérifier qu'une porte s'ouvre et entrer.
 *
 * `--confirm` est la seule chose qui rend une proposition possible. Elle exige
 * un nom, et elle refuse un lien que personne n'a vu répondre. Après elle, le
 * mécanisme passe de `MISSING_BOOKING_MECHANISM` à `BOOKING_MECHANISM_READY`
 * — et rien d'autre ne change : aucun envoi n'est ouvert, l'arrêt global n'est
 * pas touché, et le rail de réponse reste ce qu'il était.
 *
 * Cette commande n'envoie aucun message, n'ouvre aucun navigateur, n'écrit dans
 * aucun agenda et ne crée aucun rendez-vous. Elle ne connaît ni prospect, ni
 * manifeste, ni file.
 */
import { getSql } from '@/lib/db';
import { HttpClient } from '@/lib/http/client';
import { logger } from '@/lib/logging/logger';
import { resolveBookingMechanism } from '@/lib/sales/bookingStore';
import {
  BookingRefusal,
  confirmBookingDestination,
  listBookingDestinations,
  observeBookingDestination,
  revokeBookingDestination,
} from '@/lib/sales/bookingStore';

class ArgError extends Error {}

interface Args {
  readonly mode: 'status' | 'observe' | 'confirm' | 'revoke';
  readonly provider: string | null;
  readonly url: string | null;
  readonly calendarRef: string | null;
  readonly destinationId: string | null;
  readonly actor: string | null;
  readonly note: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  let mode: Args['mode'] = 'status';
  let provider: string | null = null;
  let url: string | null = null;
  let calendarRef: string | null = null;
  let destinationId: string | null = null;
  let actor: string | null = null;
  let note: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const next = argv[i + 1];
    switch (arg) {
      case '--observe':
        mode = 'observe';
        break;
      case '--confirm':
      case '--revoke':
        if (!next) throw new ArgError(`${arg} attend un identifiant de destination`);
        mode = arg === '--confirm' ? 'confirm' : 'revoke';
        destinationId = next;
        i += 1;
        break;
      case '--provider':
        if (!next) throw new ArgError('--provider attend un nom');
        provider = next;
        i += 1;
        break;
      case '--url':
        if (!next) throw new ArgError('--url attend une URL https://');
        url = next;
        i += 1;
        break;
      case '--calendar-ref':
        if (!next) throw new ArgError('--calendar-ref attend un identifiant');
        calendarRef = next;
        i += 1;
        break;
      case '--as':
        if (!next) throw new ArgError('--as attend un nom');
        actor = next;
        i += 1;
        break;
      case '--note':
      case '--reason':
        if (!next) throw new ArgError(`${arg} attend un texte`);
        note = next;
        i += 1;
        break;
      default:
        throw new ArgError(`option inconnue : ${arg}`);
    }
  }

  return { mode, provider, url, calendarRef, destinationId, actor, note };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sql = await getSql();

  try {
    if (args.mode === 'observe') {
      if (args.provider === null) throw new ArgError('--observe exige --provider');
      if (args.url === null) throw new ArgError('--observe exige --url');
      if (args.actor === null || args.actor.trim().length === 0) {
        throw new ArgError('--observe exige --as "<nom>"');
      }
      if (!/^https:\/\/\S{5,500}$/.test(args.url)) {
        throw new ArgError('--url doit être une URL https:// — un lien en clair est refusé');
      }

      // Une lecture, une seule, sans cache et sans suivre de redirection en
      // silence : la destination EST la propriété qu'on vérifie.
      const http = new HttpClient({ sql: null, minHostIntervalMs: 500 });
      const res = await http.get(args.url, {
        noCache: true,
        attempts: 1,
        timeoutMs: 15_000,
        maxBytes: 8_192,
        redirect: 'manual',
      });

      const destination = await observeBookingDestination(sql, {
        provider: args.provider,
        bookingUrl: args.url,
        calendarRef: args.calendarRef,
        reachableStatus: res.status,
        observedAt: new Date(),
        note: args.note === null ? null : `déposé par ${args.actor} : ${args.note}`,
      });

      logger.info('booking.destination.observed', {
        id: destination.id,
        provider: destination.provider,
        status: destination.status,
        httpStatus: res.status,
        by: args.actor,
      });
    }

    if (args.mode === 'confirm') {
      if (args.actor === null) throw new ArgError('--confirm exige --as "<nom>"');
      const destination = await confirmBookingDestination(
        sql,
        args.destinationId as string,
        args.actor,
        args.note,
      );
      logger.info('booking.destination.confirmed', {
        id: destination.id,
        provider: destination.provider,
        by: destination.confirmedBy,
      });
    }

    if (args.mode === 'revoke') {
      if (args.actor === null) throw new ArgError('--revoke exige --as "<nom>"');
      if (args.note === null) throw new ArgError('--revoke exige --reason "<motif>"');
      const destination = await revokeBookingDestination(
        sql,
        args.destinationId as string,
        args.actor,
        args.note,
      );
      logger.info('booking.destination.revoked', { id: destination.id, by: args.actor });
    }

    const destinations = await listBookingDestinations(sql);
    const mechanism = await resolveBookingMechanism(sql);

    const lines: string[] = [
      '',
      'MÉCANISME DE RÉSERVATION',
      `  état          ${mechanism}`,
      `  destinations  ${String(destinations.length)}`,
      '',
    ];
    for (const destination of destinations) {
      lines.push(
        `  ${destination.id}  ${destination.status.padEnd(11)} ${destination.provider}`,
        `    url        ${destination.bookingUrl}`,
        `    accessible ${destination.reachableStatus === null ? 'jamais observé' : `HTTP ${String(destination.reachableStatus)} le ${destination.reachableAt ?? '?'}`}`,
        `    confirmée  ${destination.confirmedBy === null ? 'non' : `${destination.confirmedBy} le ${destination.confirmedAt ?? '?'}`}`,
        '',
      );
    }
    if (destinations.length === 0) {
      lines.push(
        '  Aucune destination. Hermes atteint QUALIFIED_FOR_CALL puis passe la main',
        '  à un humain (HUMAN_CLOSE_REQUIRED). Aucun lien n’est écrit, aucun n’est inventé.',
        '',
      );
    }
    process.stdout.write(`${lines.join('\n')}\n`);
  } finally {
    await sql.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ArgError || error instanceof BookingRefusal) {
    logger.error('booking.destination.refused', { message: error.message });
    process.exitCode = 2;
    return;
  }
  logger.error('booking.destination.failed', {
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
