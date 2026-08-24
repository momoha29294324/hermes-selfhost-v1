import { redirect } from 'next/navigation';

/**
 * `/crm` n'a pas d'écran d'accueil, et n'en aura pas.
 *
 * Un tableau de bord de premier niveau est le réflexe de tous les CRM audités,
 * et c'est celui qui coûte le plus cher : il occupe l'écran le plus visité pour
 * des chiffres qu'on ne relit jamais. L'opérateur arrive sur la liste des
 * prospects, c'est-à-dire sur son travail.
 */
export default function CrmIndexPage() {
  redirect('/crm/prospects');
}
