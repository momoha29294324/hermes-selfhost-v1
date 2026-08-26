/**
 * HERMES-NATIVE-BOOKING-R1 §6/§19 — ce que le modèle voit de l'agenda.
 *
 * Un seul principe, et il tient tout le round : les créneaux qui entrent dans
 * ce bloc viennent de `nextAvailableSlots`, c'est-à-dire de l'agenda réel.
 * Le modèle FORMULE (« mercredi à 15h ou jeudi vers 11h, tu préfères
 * lequel ? ») ; il ne DÉCIDE pas que mercredi 15 h est libre.
 *
 * Le bloc n'entre pas dans le prompt quand la conversation n'appelle pas de
 * rendez-vous — §19. Ce n'est pas une économie de jetons : montrer des créneaux
 * à un modèle lui donne l'idée de les proposer, et un prospect qui pose encore
 * des questions doit recevoir des réponses, pas « mercredi 15 h ? ».
 */

import type { Interval } from '@/lib/booking/availability';
import { formatSlot } from '@/lib/booking/statement';
import type { Appointment } from '@/lib/booking/store';

export interface BookingPromptView {
  /**
   * Ce qu'on ANNONCE de la durée — « 20 à 25 minutes ».
   *
   * Distincte du bloc réservé, et c'est voulu : la marge appartient à
   * l'opérateur. Le modèle ne reçoit QUE la durée annoncée ; il n'a aucune
   * raison de connaître la longueur du bloc, et la lui donner l'exposerait à
   * l'écrire.
   */
  readonly presentedDuration: string;
  /** Le rendez-vous déjà pris pour ce prospect, s'il en a un. */
  readonly liveAppointment: Appointment | null;
  /** Les créneaux libres calculés, ou vide si on ne doit rien proposer. */
  readonly slots: readonly Interval[];
  readonly timezone: string;
  /** Le rendez-vous que CE tour vient d'écrire, pour la réécriture de §12. */
  readonly justBooked?: Appointment | null;
  /** Le créneau demandé et refusé, pour la réécriture d'un créneau perdu. */
  readonly lostSlot?: Interval | null;
}

/**
 * Le bloc, ou rien du tout.
 *
 * Rend `null` — et non une chaîne vide — quand il n'y a rien à dire. Un bloc
 * vide laisserait une ligne blanche dans le prompt, et le dépôt vérifie par
 * comparaison de chaînes que le prompt éteint est le prompt d'avant, au
 * caractère près.
 */
export function renderBookingBlock(view: BookingPromptView): string | null {
  const lines: string[] = [];

  if (view.justBooked != null) {
    // Après une écriture réussie : le fait est acquis, et le texte doit le dire.
    lines.push(
      'LE RENDEZ-VOUS EST RÉSERVÉ, pour de bon, dans l’agenda :',
      `- ${formatSlot(
        { startsAt: new Date(view.justBooked.startsAt), endsAt: new Date(view.justBooked.endsAt) },
        view.timezone,
      )}`,
      '',
      'Confirme-le simplement, en nommant ce créneau et lui seul. Pas de lien, pas de pièce',
      'jointe, pas de récapitulatif : une phrase courte suffit.',
    );
    return lines.join('\n');
  }

  if (view.lostSlot != null) {
    lines.push(
      'LE CRÉNEAU QUE LA PERSONNE VIENT D’ACCEPTER N’EST PLUS DISPONIBLE.',
      `- ${formatSlot(view.lostSlot, view.timezone)} — pris entre-temps`,
      '',
      'Dis-le brièvement, sans t’excuser longuement, et propose ce qui suit — et RIEN d’autre :',
    );
    if (view.slots.length === 0) {
      lines.push('- (aucun créneau libre à proposer : demande simplement ses disponibilités)');
    } else {
      for (const slot of view.slots) lines.push(`- ${formatSlot(slot, view.timezone)}`);
    }
    lines.push('', 'N’écris SURTOUT PAS que le rendez-vous est pris : il ne l’est pas.');
    return lines.join('\n');
  }

  if (view.liveAppointment !== null) {
    lines.push(
      'UN RENDEZ-VOUS EST DÉJÀ PRIS avec cette personne :',
      `- ${formatSlot(
        {
          startsAt: new Date(view.liveAppointment.startsAt),
          endsAt: new Date(view.liveAppointment.endsAt),
        },
        view.timezone,
      )}`,
      '',
      'Ne propose aucun autre créneau et ne redemande pas ses disponibilités. Si elle veut',
      'décaler ou annuler, dis simplement que tu t’en occupes — le système s’en charge.',
    );
    return lines.join('\n');
  }

  if (view.slots.length === 0) return null;

  lines.push(
    'CRÉNEAUX RÉELLEMENT LIBRES dans l’agenda (calculés, pas supposés) :',
  );
  for (const slot of view.slots) lines.push(`- ${formatSlot(slot, view.timezone)}`);
  lines.push(
    '',
    'Tu ne peux proposer AUCUN autre créneau que ceux-ci. N’invente ni date, ni heure, ni',
    '« je regarde et je reviens vers toi » : ces créneaux sont disponibles maintenant.',
    `Propose-les en une phrase, sans lien et sans formulaire. L'échange dure ${view.presentedDuration} :`,
    'tu peux le dire si c’est utile, mais n’annonce aucune autre durée.',
    '',
    'Si la personne accepte un créneau ou t’en propose un autre, écris ta réponse comme si',
    'c’était acquis : le système vérifie la disponibilité et réserve AVANT que ton message',
    'ne parte, et te fera réécrire si le créneau vient d’être pris. Tu n’affirmes jamais',
    'qu’un rendez-vous est pris de ta propre initiative.',
  );
  return lines.join('\n');
}
