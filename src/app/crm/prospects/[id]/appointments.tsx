/**
 * HERMES-NATIVE-BOOKING-R1 §16 — la carte « Rendez-vous » de la fiche prospect.
 *
 * Un fichier à part, et pas par goût du rangement : la fiche est découpée en
 * composants parce qu'un test l'exige (`crmProspectUi`), et cette règle existe
 * pour que « Vue d'ensemble » ne redevienne pas la page monolithique qu'elle a
 * été. Ajouter un bloc à `overview.tsx` sans l'extraire aurait consommé la
 * marge que ce test protège.
 */

import { Badge, Card, EmptyState } from '@/app/crm/ui';
import { presentedDurationLabel } from '@/lib/booking/statement';
import { loadBookingPolicy } from '@/lib/config/load';
import type { CrmAppointment } from '@/lib/crm/queries';

/**
 * HERMES-NATIVE-BOOKING-R1 §16 — « Prochain rendez-vous ».
 *
 * En LECTURE seule, et sans aucun bouton : le CRM ne prend, ne déplace ni
 * n'annule un rendez-vous. Le rail conversationnel écrit, la fiche relit —
 * la même discipline que pour les manifestes et les états commerciaux.
 *
 * Ce qu'elle montre au-delà du créneau, et pourquoi : l'état de la
 * CONFIRMATION. Un rendez-vous peut être pris dans l'agenda sans que le DM de
 * confirmation soit parti (§12) — c'est rare, c'est prévu, et c'est
 * exactement le cas où un humain doit intervenir. Le taire rendrait le
 * système muet là où il a le plus besoin d'être lu.
 */
export function AppointmentsCard({ appointments }: { appointments: readonly CrmAppointment[] }) {
  if (appointments.length === 0) return null;

  const live = appointments.find((entry) => entry.status === 'CONFIRMED') ?? null;
  const past = appointments.filter((entry) => entry.id !== live?.id);

  return (
    <Card
      icon="calendar"
      title="Rendez-vous"
      tone={live === null ? 'slate' : 'green'}
      end={live === null ? undefined : <Badge tone="green">Confirmé</Badge>}
    >
      {live === null ? (
        <EmptyState icon="calendar" title="Aucun rendez-vous en cours">
          Les rendez-vous passés et annulés restent listés ci-dessous.
        </EmptyState>
      ) : (
        <div className="crm-facts-grid">
          <div className="f" data-tone="green">
            <span className="k">Prochain rendez-vous</span>
            <span className="v">{formatAppointment(live)}</span>
            <span className="s">
              {live.timezone} · {presentedDuration()} annoncées · bloc de{' '}
              {durationMinutes(live)} min
            </span>
          </div>
          <div
            className="f"
            data-tone={live.confirmationState === 'DELIVERED' ? 'violet' : 'orange'}
          >
            <span className="k">Confirmation au prospect</span>
            <span className="v">{CONFIRMATION_LABEL[live.confirmationState] ?? live.confirmationState}</span>
            <span className="s">Source : {SOURCE_LABEL[live.source] ?? live.source}</span>
          </div>
        </div>
      )}

      {past.length === 0 ? null : (
        <div className="crm-timeline compact">
          {past.map((entry) => (
            <div key={entry.id} className="crm-day">
              {formatAppointment(entry)} —{' '}
              {entry.status === 'CANCELLED' ? 'annulé' : 'confirmé'}
              {entry.cancelledReason === null ? '' : ` (${entry.cancelledReason})`}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

const CONFIRMATION_LABEL: Readonly<Record<string, string>> = Object.freeze({
  PENDING: 'pas encore envoyée',
  DELIVERED: 'envoyée',
  DELIVERY_UNCONFIRMED: 'remise non confirmée — à vérifier',
});

const SOURCE_LABEL: Readonly<Record<string, string>> = Object.freeze({
  instagram_hermes: 'Instagram / Hermes',
  operator: 'saisie opérateur',
});

/** « mercredi 26 août · 15:00 », dans le fuseau où le créneau a été négocié. */
function formatAppointment(entry: CrmAppointment): string {
  const parts = new Intl.DateTimeFormat('fr-FR', {
    timeZone: entry.timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(entry.startsAt));
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${read('weekday')} ${read('day')} ${read('month')} · ${read('hour')}:${read('minute')}`;
}

function durationMinutes(entry: CrmAppointment): number {
  return Math.round((Date.parse(entry.endsAt) - Date.parse(entry.startsAt)) / 60_000);
}

/**
 * La durée ANNONCÉE, telle que le prospect l'a entendue.
 *
 * Affichée à côté du bloc réellement réservé, et pas à sa place : un opérateur
 * qui prépare son appel doit savoir les deux — ce qu'il a promis, et ce dont il
 * dispose. Les confondre ferait croire à une marge qui n'existe pas, ou à son
 * absence alors qu'elle existe.
 *
 * Fail-open sur la lecture : une configuration illisible n'empêche pas
 * d'afficher un rendez-vous. C'est un libellé, pas une garde.
 */
function presentedDuration(): string {
  try {
    return presentedDurationLabel(loadBookingPolicy());
  } catch {
    return 'durée non configurée';
  }
}
