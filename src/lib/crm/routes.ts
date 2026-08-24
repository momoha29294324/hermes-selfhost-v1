/**
 * Les routes du CRM, écrites UNE fois.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi une constante plutôt qu'une chaîne dans chaque lien
 * ---------------------------------------------------------------------------
 *
 * Deux surfaces cohabitent dans ce dépôt et n'ont pas le même statut :
 *
 *   — le CRM (`/crm/**`) est la surface d'exploitation quotidienne ;
 *   — la revue des brouillons (`/revue`) est l'atelier historique, conservé
 *     parce qu'il sert encore, mais qui n'est plus la porte d'entrée.
 *
 * Jusqu'à CRM-UX-R1, l'atelier occupait `/` : `npm run dev` ouvrait donc sur un
 * écran de campagne, et l'opérateur devait chercher son CRM à la main. La
 * racine mène désormais au travail (`CRM_HOME`), et l'atelier garde une adresse
 * explicite (`LEGACY_REVIEW_HOME`) plutôt que d'être supprimé — il n'a pas
 * cessé d'être utile, il a cessé d'être le défaut.
 *
 * Ces valeurs sont lues par le redirect de la racine, par le rail de
 * navigation et par les tests. Une redirection qui pointerait ailleurs que la
 * navigation cesserait donc de compiler avant d'être livrée.
 */

/** La surface d'exploitation par défaut : le travail, pas un tableau de bord. */
export const CRM_HOME = '/crm/prospects';

/** L'atelier de revue historique — atteignable, jamais imposé. */
export const LEGACY_REVIEW_HOME = '/revue';
