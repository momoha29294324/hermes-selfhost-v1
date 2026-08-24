/**
 * IG4.3 — l'horloge des tests Instagram.
 *
 * L'ordonnanceur (`src/lib/instagram/scheduler.ts`) n'a jamais lu l'heure
 * lui-même : `evaluateSchedule` prend `now` en paramètre, et le worker expose
 * `RunInput.now`. Le seam existait donc déjà, complet. Ce qui manquait était
 * qu'on s'en serve : `tests/instagramQueue.test.ts` laissait le worker retomber
 * sur son défaut `() => new Date()`, et éprouvait donc la fenêtre
 * « lun–ven 09:00–20:00 Europe/Paris » de `config/instagram.json` contre
 * l'horloge murale de la machine. La suite passait le matin et échouait à
 * 20 h 01, un samedi, ou depuis un fuseau différent — vingt scénarios qui
 * attendaient `DRY_RUN_COMPLETED` obtenaient `SKIPPED` / `outside_window`.
 *
 * La correction est ici et dans les tests, jamais dans le runtime : la fenêtre
 * de production reste exactement celle que la configuration décrit, et
 * `outside_window` continue de refuser réellement hors fenêtre. Un test qui
 * veut observer un worker DANS la fenêtre le dit maintenant explicitement, en
 * nommant l'instant qu'il choisit ; un test qui veut observer un refus HORS
 * fenêtre nomme le sien.
 *
 * Les instants ci-dessous sont des dates réelles, choisies pour ce qu'elles
 * sont dans le calendrier — pas des nombres arbitraires. Le scénario « les deux
 * instants sont bien de part et d'autre de la fenêtre CONFIGURÉE », dans
 * `tests/instagramQueue.test.ts`, vérifie chacune contre `isInsideWindow` et la
 * vraie configuration, pour que ce fichier ne puisse pas mentir en silence si la
 * fenêtre change un jour.
 */

/**
 * Mercredi 15 juillet 2026, 10:00 Europe/Paris (08:00 UTC — CEST, UTC+2).
 *
 * Un jour ouvré, une heure de bureau : l'instant « normal » depuis lequel
 * observer tout ce qui n'a rien à voir avec le calendrier — la file, les baux,
 * l'identité, le journal, les plafonds. Un mercredi et non un lundi ou un
 * vendredi : aucun bord de semaine ne peut le rendre ambigu.
 */
export const IG_WEEKDAY_IN_WINDOW = new Date('2026-07-15T08:00:00.000Z');

/**
 * Le même mercredi, 21:30 Europe/Paris (19:30 UTC).
 *
 * Après la fermeture, et c'est le genre d'heure à laquelle la suite échouait
 * avant IG4.3 : le bug se rejoue donc à volonté, en nommant son instant, au
 * lieu d'attendre le soir.
 *
 * Cette constante valait 19:30 Paris tant que la fenêtre fermait à 18:00. Depuis
 * IG4.4C elle ferme à 20:00, et 19:30 est devenu une heure OUVRÉE — la garde de
 * `instagramQueue.test.ts` (« les deux instants sont bien de part et d'autre de
 * la fenêtre CONFIGURÉE ») l'a dit avant qu'un scénario ne se mette à mentir.
 * L'instant a donc été déplacé, jamais la fenêtre relâchée pour lui.
 */
export const IG_WEEKDAY_AFTER_HOURS = new Date('2026-07-15T19:30:00.000Z');

/**
 * Samedi 18 juillet 2026, 12:00 Europe/Paris (10:00 UTC).
 *
 * Hors fenêtre pour une raison différente de la précédente — le JOUR, pas
 * l'heure. Les deux refus se ressemblent (`outside_window`) mais ne reprennent
 * pas au même moment, et c'est ce que la date de reprise doit montrer.
 */
export const IG_WEEKEND = new Date('2026-07-18T10:00:00.000Z');

/**
 * Mercredi 14 janvier 2026, 10:00 Europe/Paris (09:00 UTC — CET, UTC+1).
 *
 * La même heure murale que `IG_WEEKDAY_IN_WINDOW`, à un décalage UTC près :
 * l'existence de ces deux constantes est ce qui interdit de « corriger » la
 * fenêtre en la décalant d'une heure fixe. Un décalage stocké se tromperait sur
 * l'une des deux.
 */
export const IG_WINTER_WEEKDAY_IN_WINDOW = new Date('2026-01-14T09:00:00.000Z');

/**
 * L'horloge à passer telle quelle à `RunInput.now` / `evaluateSchedule`.
 *
 * Gelée au sens strict : deux appels rendent le même instant. Un test qui
 * mesure un report en dérive donc une durée exacte, et non « à peu près, si la
 * machine n'a pas ralenti entre les deux lectures ».
 */
export function frozenClock(instant: Date): () => Date {
  return (): Date => new Date(instant.getTime());
}
