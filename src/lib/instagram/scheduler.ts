import type { Sql } from '@/lib/db/sql';
import type { InstagramRailConfig } from '@/lib/config/schema';
import { evaluateEffectCaps, loadSafetySnapshot, type SafetySnapshot } from '@/lib/instagram/safety';
import type { GateRecord, InstagramSkipReason } from '@/lib/instagram/types';

/**
 * IG3 §4 — l'ordonnanceur : QUAND, et pourquoi pas maintenant.
 *
 * Ce module ne connaît ni navigateur, ni file, ni prospect. Il répond à une
 * seule question, sur un état déjà lu :
 *
 *     « à cet instant, un effet Instagram serait-il permis ? sinon, à partir
 *       de quand ? »
 *
 * Les deux moitiés comptent autant l'une que l'autre. Un ordonnanceur qui sait
 * seulement refuser oblige l'opérateur à re-lancer le worker au hasard jusqu'à
 * ce que ça passe ; celui-ci rend une DATE, qui devient `not_before` du job et
 * la colonne « next scheduled » du CLI. C'est ce que la mission demande par
 * « observer exactement ce que le worker aurait envoyé **et quand** ».
 *
 * Trois propriétés, toutes vérifiées par les tests :
 *
 *   1. **Aucune horloge implicite.** `now` est un paramètre, jamais un
 *      `Date.now()` caché. Une fenêtre horaire testée sur l'heure réelle serait
 *      un test qui échoue à 20 h 01.
 *   2. **Aucune géographie en dur.** Le fuseau est une chaîne IANA lue dans
 *      `config/instagram.json` et passée telle quelle à `Intl`. Il n'existe
 *      aucune branche « si France » dans ce fichier.
 *   3. **Aucun aléa.** Le seul étalement possible est un hachage de la clé
 *      d'idempotence, borné par la configuration et nul par défaut. Ce n'est
 *      pas une technique anti-détection — la mission les interdit — et ça n'en
 *      serait de toute façon pas une : la même cible reçoit toujours le même
 *      décalage.
 */

// ---------------------------------------------------------------------------
// Heure locale d'un fuseau, sans dépendance
// ---------------------------------------------------------------------------

export interface ZonedParts {
  readonly year: number;
  /** 1–12. */
  readonly month: number;
  readonly day: number;
  /** ISO : 1 = lundi … 7 = dimanche, comme `config.schedule.windows[].days`. */
  readonly isoWeekday: number;
  /** Minutes depuis minuit local. */
  readonly minuteOfDay: number;
}

const WEEKDAY_TO_ISO: Readonly<Record<string, number>> = Object.freeze({
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
});

/**
 * Le seul endroit du rail qui traduit un instant en heure locale.
 *
 * `Intl.DateTimeFormat` plutôt qu'un décalage stocké : un décalage fixe se
 * trompe deux fois par an, et se tromperait précisément le jour où une fenêtre
 * « 9 h – 20 h » compte le plus. `Intl` connaît la base tzdata du système et
 * gère l'heure d'été sans que ce fichier ait à savoir qu'elle existe.
 *
 * Le formateur est mémoïsé par fuseau : le construire coûte cher, et
 * l'ordonnanceur l'appelle en boucle quand il cherche la prochaine ouverture.
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timezone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
  formatterCache.set(timezone, created);
  return created;
}

export function zonedParts(instant: Date, timezone: string): ZonedParts {
  const parts = formatterFor(timezone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';

  const isoWeekday = WEEKDAY_TO_ISO[read('weekday')];
  if (isoWeekday === undefined) {
    // Un fuseau invalide fait lever `Intl` avant d'arriver ici ; ce refus couvre
    // le cas d'un environnement dont la locale rendrait un jour inconnu. Deviner
    // « lundi » ouvrirait une fenêtre que personne n'a décidée.
    throw new Error(`fuseau « ${timezone} » : jour de semaine illisible (« ${read('weekday')} »)`);
  }

  // `Intl` rend « 24 » pour minuit dans certaines locales en hour12:false.
  const hour = Number.parseInt(read('hour'), 10) % 24;

  return Object.freeze({
    year: Number.parseInt(read('year'), 10),
    month: Number.parseInt(read('month'), 10),
    day: Number.parseInt(read('day'), 10),
    isoWeekday,
    minuteOfDay: hour * 60 + Number.parseInt(read('minute'), 10),
  });
}

/**
 * L'opération inverse : l'instant UTC auquel l'horloge murale du fuseau
 * affiche cette date et cette minute.
 *
 * Il n'existe pas de primitive standard pour cela, d'où le point fixe : on
 * suppose d'abord que l'horloge murale EST de l'UTC, on mesure l'écart réel à
 * cet instant, on corrige, et on recommence. Deux itérations suffisent partout
 * (la seconde ne sert qu'aux instants situés juste au bord d'un changement
 * d'heure, où l'écart mesuré au premier essai est celui de l'ancien régime).
 *
 * Aux heures « sautées » d'un passage à l'heure d'été (02:30 le dernier
 * dimanche de mars en Europe), aucune réponse n'est exacte : le point fixe rend
 * alors l'instant immédiatement après le saut, c'est-à-dire la première
 * milliseconde où la fenêtre demandée existe réellement. C'est le
 * comportement souhaitable pour une OUVERTURE de fenêtre — on n'ouvre jamais
 * plus tôt que demandé.
 */
export function zonedWallClockToUtc(
  year: number,
  month: number,
  day: number,
  minuteOfDay: number,
  timezone: string,
): Date {
  const wall = Date.UTC(year, month - 1, day, 0, minuteOfDay, 0, 0);
  let guess = wall;
  for (let i = 0; i < 3; i += 1) {
    const seen = zonedParts(new Date(guess), timezone);
    const seenAsUtc = Date.UTC(seen.year, seen.month - 1, seen.day, 0, seen.minuteOfDay, 0, 0);
    const offset = seenAsUtc - guess;
    const next = wall - offset;
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

// ---------------------------------------------------------------------------
// Fenêtres
// ---------------------------------------------------------------------------

type ScheduleConfig = InstagramRailConfig['schedule'];

export function isInsideWindow(instant: Date, schedule: ScheduleConfig): boolean {
  const local = zonedParts(instant, schedule.timezone);
  return schedule.windows.some(
    (w) => w.days.includes(local.isoWeekday) && local.minuteOfDay >= w.startMinute && local.minuteOfDay < w.endMinute,
  );
}

/** Combien de jours au plus on cherche la prochaine ouverture avant d'abandonner. */
const WINDOW_SEARCH_DAYS = 14;

/**
 * Le prochain instant où une fenêtre est ouverte, ou `null` si aucune ne
 * s'ouvre dans les deux semaines qui viennent.
 *
 * `null` n'est pas « jamais » : c'est « pas dans un horizon raisonnable ». Une
 * politique qui n'ouvre qu'un 29 février est légale et l'appelant doit pouvoir
 * la distinguer d'un bug — il la verra comme un report sans échéance, reporté
 * du `defaultBackoffMs`, plutôt que comme une date fabriquée.
 *
 * La recherche est jour par jour, pas minute par minute : dans un jour donné,
 * la prochaine ouverture ne peut être que le début d'une des fenêtres de ce
 * jour, ou l'instant lui-même s'il est déjà dedans.
 */
export function nextWindowOpening(instant: Date, schedule: ScheduleConfig): Date | null {
  if (isInsideWindow(instant, schedule)) return instant;

  const start = zonedParts(instant, schedule.timezone);

  for (let dayOffset = 0; dayOffset <= WINDOW_SEARCH_DAYS; dayOffset += 1) {
    // Le calendrier avance en UTC (donc sans piège de changement d'heure) puis
    // est relu dans le fuseau : c'est la date LOCALE du jour visé qu'on veut.
    const probe = new Date(Date.UTC(start.year, start.month - 1, start.day + dayOffset, 12, 0, 0, 0));
    const local = zonedParts(probe, schedule.timezone);

    let best: Date | null = null;
    for (const window of schedule.windows) {
      if (!window.days.includes(local.isoWeekday)) continue;
      const opening = zonedWallClockToUtc(local.year, local.month, local.day, window.startMinute, schedule.timezone);
      if (opening.getTime() <= instant.getTime()) continue;
      if (best === null || opening.getTime() < best.getTime()) best = opening;
    }
    if (best !== null) return best;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Étalement fonctionnel
// ---------------------------------------------------------------------------

/**
 * Décalage déterministe et borné, dérivé de la clé d'idempotence.
 *
 * FNV-1a 32 bits : quelques lignes, aucune dépendance, et surtout un résultat
 * stable d'une machine à l'autre et d'une version de Node à l'autre. La valeur
 * de retour est toujours dans `[0, jitterMs)`, et vaut `0` quand la
 * configuration ne demande aucun étalement — le défaut.
 */
export function scheduleJitterMs(idempotencyKey: string, schedule: ScheduleConfig): number {
  if (schedule.jitterMs <= 0) return 0;
  return stableHash32(idempotencyKey) % schedule.jitterMs;
}

/**
 * Le hachage lui-même, exporté pour que d'autres étalements DÉTERMINISTES
 * puissent s'en servir sans en réécrire un second.
 *
 * HERMES-CONVERSATION-R2 §22 en a besoin : le délai humain avant une réponse
 * automatique est dérivé de la clé du plan, exactement comme l'étalement d'un
 * job l'est de sa clé d'idempotence. Deux implémentations de FNV-1a
 * finiraient par diverger sur un détail de décalage, et deux runtimes
 * calculeraient alors deux attentes différentes pour la même conversation.
 *
 * Ce n'est PAS une technique anti-détection, ici comme là-bas : la même clé
 * donne toujours le même résultat, et c'est justement ce qui l'en empêche.
 */
export function stableHash32(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// ---------------------------------------------------------------------------
// L'état lu, et la décision
// ---------------------------------------------------------------------------

export interface ScheduleSnapshot {
  readonly safety: SafetySnapshot;
  /**
   * L'instant où le plafond journalier libère une place, `null` s'il n'est pas
   * atteint. Calculé, pas approximé : c'est la date du plus ancien des
   * `dailySentCap` envois les plus récents, plus vingt-quatre heures — l'instant
   * exact où le compte glissant repasse sous le plafond.
   */
  readonly dailyCapFreesAt: string | null;
  readonly hourlyCapFreesAt: string | null;
  /** Dernière tentative d'effet externe, `null` si aucune n'a jamais eu lieu. */
  readonly lastExternalEffectAt: string | null;
}

/**
 * Lit tout ce dont la décision a besoin, en une fois.
 *
 * Réutilise `loadSafetySnapshot` mot pour mot plutôt que de recompter :
 * deux façons de compter les envois seraient deux vérités, et l'une des deux
 * serait la plus permissive.
 */
export async function loadScheduleSnapshot(sql: Sql, config: InstagramRailConfig): Promise<ScheduleSnapshot> {
  const safety = await loadSafetySnapshot(sql, config);

  // Les deux journaux additionnés, exactement comme `loadSafetySnapshot` le
  // fait pour ses compteurs : un test contrôlé part du même compte, par le même
  // navigateur, et occupe donc une place du plafond.
  const rows = await sql.query<{ dailyFreesAt: string | null; hourlyFreesAt: string | null; lastEffectAt: string | null }>(
    `with sent as (
       select created_at from ig_job_events where status = 'SENT'
       union all
       select created_at from ig_controlled_test_events where status = 'SENT'
       union all
       -- HERMES-CONVERSATION-R2 §20 — les réponses et relances remises comptent
       -- dans le même plafond : même compte, même navigateur, même session.
       select external_effect_started_at from hermes_conversation_plans where status = 'SENT'
     )
     select
       (select min(created_at) + interval '24 hours'
          from (select created_at from sent
                 where created_at > now() - interval '24 hours'
                 order by created_at desc limit $1) d)                       as "dailyFreesAt",
       (select min(created_at) + interval '1 hour'
          from (select created_at from sent
                 where created_at > now() - interval '1 hour'
                 order by created_at desc limit $2) h)                       as "hourlyFreesAt",
       greatest(
         (select max(external_effect_started_at) from ig_dispatch_jobs where external_effect_attempted = true),
         (select max(external_effect_started_at) from ig_controlled_tests where external_effect_attempted = true),
         (select max(external_effect_started_at) from hermes_conversation_plans where external_effect_attempted = true)
       )                                                                     as "lastEffectAt"`,
    [config.caps.dailySentCap, config.caps.hourlySentCap],
  );

  const row = rows[0];
  return Object.freeze({
    safety,
    // Une date de libération n'a de sens que si le plafond est effectivement
    // atteint : sinon la sous-requête rend la date du plus ancien envoi d'une
    // série incomplète, qui ne libère rien puisque rien n'est bloqué.
    dailyCapFreesAt: safety.sentLastDay >= config.caps.dailySentCap ? (row?.dailyFreesAt ?? null) : null,
    hourlyCapFreesAt: safety.sentLastHour >= config.caps.hourlySentCap ? (row?.hourlyFreesAt ?? null) : null,
    lastExternalEffectAt: row?.lastEffectAt ?? null,
  });
}

/**
 * La décision d'ordonnancement pour un instant donné.
 *
 * `allowed: true` ne veut pas dire « envoie » — il reste l'identité, la
 * session, la dérive de manifeste et, pour un envoi réel, une autorisation
 * canari nominative. Il veut dire « rien dans le TEMPS ne s'y oppose ».
 */
export type ScheduleDecision =
  | { readonly allowed: true; readonly gates: readonly GateRecord[] }
  | {
      readonly allowed: false;
      readonly reason: InstagramSkipReason;
      readonly detail: string;
      /** Quand la condition qui refuse aura cessé d'être vraie. `null` si indéterminable. */
      readonly nextEligibleAt: Date | null;
      readonly gates: readonly GateRecord[];
    };

/** Traduction d'un refus de plafond en motif de report. Exhaustive par construction. */
const CAP_GATE_SKIP_REASON: Readonly<Record<string, InstagramSkipReason>> = Object.freeze({
  kill_switch: 'kill_switch',
  cap_daily_sent: 'daily_cap',
  cap_hourly_sent: 'hourly_cap',
  cap_min_interval: 'cooldown',
});

/**
 * IG3 §4/§5/§8 — l'arrêt global, la fenêtre horaire, les plafonds et la
 * cadence, dans cet ordre, avec la date de reprise de chacun.
 *
 * L'ordre n'est pas cosmétique. L'arrêt global d'abord, parce qu'il est le seul
 * refus qu'aucun calcul ne doit pouvoir contourner. La fenêtre ensuite, parce
 * qu'elle a une date de reprise exacte et bon marché. Les plafonds enfin,
 * parce qu'ils lisent des compteurs.
 *
 * Ce que cette fonction ne fait pas : décider du mode. Elle rend le même verdict
 * en DRY-RUN et en LIVE ; c'est l'appelant qui choisit de l'IMPOSER (le worker
 * LIVE) ou de le PROJETER (le worker DRY-RUN), et cette asymétrie-là est écrite
 * dans les workers, où elle se relit.
 */
export function evaluateSchedule(input: {
  readonly now: Date;
  readonly snapshot: ScheduleSnapshot;
  readonly config: InstagramRailConfig;
  /**
   * IG3 §7 — que faire de l'arrêt global.
   *
   *   `'enforce'` — il refuse, et rien d'autre n'est évalué. C'est la posture du
   *                 chemin LIVE, et elle ne se négocie pas.
   *   `'project'` — il est ÉVALUÉ, JOURNALISÉ comme un refus, et l'évaluation
   *                 continue. C'est la posture du worker DRY-RUN, et elle n'est
   *                 défendable que parce que ce worker ne peut produire aucun
   *                 effet : son rail n'expose aucune primitive d'envoi, il
   *                 refuse de tourner si on lui en passe une, et la base
   *                 rejetterait une ligne d'audit DRY_RUN qui prétendrait le
   *                 contraire. Un arrêt global qui empêcherait aussi de VÉRIFIER
   *                 n'empêcherait rien de plus — il rendrait seulement le rail
   *                 inobservable exactement quand on veut l'observer.
   *
   * Défaut : `'enforce'`. Un appelant qui oublie ce paramètre obtient la
   * posture stricte.
   */
  readonly killSwitch?: 'enforce' | 'project';
}): ScheduleDecision {
  const { now, snapshot, config } = input;
  const killSwitchPolicy = input.killSwitch ?? 'enforce';
  const gates: GateRecord[] = [];

  const engaged = snapshot.safety.killSwitch.engaged;

  // En posture « project », les plafonds sont évalués sur un instantané dont
  // l'arrêt est neutralisé — sinon `evaluateEffectCaps` s'arrête à la première
  // porte et ne dit rien des suivantes, c'est-à-dire précisément ce que le
  // DRY-RUN cherche à savoir. L'instantané d'origine n'est pas modifié.
  const projected: ScheduleSnapshot =
    engaged && killSwitchPolicy === 'project'
      ? { ...snapshot, safety: { ...snapshot.safety, killSwitch: { ...snapshot.safety.killSwitch, engaged: false } } }
      : snapshot;

  const effect = evaluateEffectCaps(projected.safety, config);

  // L'arrêt global est le premier verdict d'`evaluateEffectCaps`. S'il refuse,
  // il refuse seul et rien d'autre n'a été évalué — on le relaie tel quel,
  // sans date de reprise : un arrêt se lève par une décision humaine nominative,
  // pas par l'écoulement du temps.
  if (!effect.allowed && effect.code === 'IG_KILL_SWITCH_ENGAGED') {
    return {
      allowed: false,
      reason: 'kill_switch',
      detail: effect.reason,
      nextEligibleAt: null,
      gates: Object.freeze([...effect.gates]),
    };
  }

  if (engaged) {
    // Journalisé comme un refus, parce que c'en est un — il n'est simplement
    // pas opposable à un travail sans effet.
    gates.push({
      gate: 'kill_switch',
      verdict: 'BLOCK',
      detail:
        `arrêt global armé (${snapshot.safety.killSwitch.setBy ?? 'défaut'}) — ` +
        'projeté et non opposé : ce chemin ne produit aucun effet',
    });
  } else {
    gates.push(...effect.gates.filter((gate) => gate.gate === 'kill_switch'));
  }

  // La fenêtre, avant les plafonds : sa date de reprise est exacte, et un job
  // reporté à 9 h du matin n'a pas besoin qu'on lui dise en plus qu'il reste
  // sept envois sur son quota journalier.
  if (!isInsideWindow(now, config.schedule)) {
    const opening = nextWindowOpening(now, config.schedule);
    const local = zonedParts(now, config.schedule.timezone);
    gates.push({ gate: 'schedule_window', verdict: 'BLOCK', detail: `hors fenêtre (${config.schedule.timezone})` });
    return {
      allowed: false,
      reason: 'outside_window',
      detail:
        `${String(local.isoWeekday)}/${String(Math.floor(local.minuteOfDay / 60)).padStart(2, '0')}:` +
        `${String(local.minuteOfDay % 60).padStart(2, '0')} (${config.schedule.timezone}) ` +
        `est hors des fenêtres configurées` +
        (opening === null ? ' — aucune ouverture trouvée sous quinze jours' : ` — prochaine ouverture ${opening.toISOString()}`),
      nextEligibleAt: opening,
      gates: Object.freeze([...gates]),
    };
  }
  gates.push({ gate: 'schedule_window', verdict: 'PASS', detail: `dans la fenêtre (${config.schedule.timezone})` });

  if (!effect.allowed) {
    const blocking = effect.gates.find((gate) => gate.verdict === 'BLOCK');
    const reason = CAP_GATE_SKIP_REASON[blocking?.gate ?? ''];
    if (reason === undefined) {
      // Inatteignable : `evaluateEffectCaps` n'a que quatre portes, toutes
      // traduites. Refuser bruyamment plutôt que reporter d'une durée inventée.
      throw new Error(`ordonnanceur : refus de plafond non traduit (« ${blocking?.gate ?? 'inconnu'} »)`);
    }
    gates.push(...effect.gates.filter((gate) => gate.gate !== 'kill_switch'));
    return {
      allowed: false,
      reason,
      detail: effect.reason,
      nextEligibleAt: capReleaseInstant(reason, now, snapshot, config),
      gates: Object.freeze([...gates]),
    };
  }

  gates.push(...effect.gates.filter((gate) => gate.gate !== 'kill_switch'));
  return { allowed: true, gates: Object.freeze([...gates]) };
}

/**
 * Quand la place se libère, pour chacun des trois plafonds qui en ont une.
 *
 * `null` reste possible et honnête : si le journal ne permet pas de dater la
 * libération, l'appelant reportera du `defaultBackoffMs` plutôt que d'annoncer
 * une heure qu'il ne connaît pas.
 */
function capReleaseInstant(
  reason: InstagramSkipReason,
  now: Date,
  snapshot: ScheduleSnapshot,
  config: InstagramRailConfig,
): Date | null {
  if (reason === 'daily_cap') return snapshot.dailyCapFreesAt === null ? null : new Date(snapshot.dailyCapFreesAt);
  if (reason === 'hourly_cap') return snapshot.hourlyCapFreesAt === null ? null : new Date(snapshot.hourlyCapFreesAt);
  if (reason === 'cooldown') {
    if (snapshot.lastExternalEffectAt === null) return null;
    return new Date(new Date(snapshot.lastExternalEffectAt).getTime() + config.caps.minSendIntervalMs);
  }
  return null;
}

/**
 * L'instant auquel un job reporté redevient réclamable.
 *
 * Trois règles, dans cet ordre :
 *
 *   1. la date rendue par la décision, quand elle en a une ;
 *   2. sinon `defaultBackoffMs` — un report sans échéance connue ne se
 *      transforme pas en « tout de suite » ;
 *   3. jamais avant `now`, quoi qu'il arrive. Une date de libération déjà
 *      passée (le temps de lire la base) ne doit pas produire un `not_before`
 *      dans le passé, qui ferait tourner le worker en boucle sur le même job.
 *
 * L'étalement est ajouté ensuite, et il est nul par défaut.
 */
export function nextAttemptAt(input: {
  readonly now: Date;
  readonly decision: Extract<ScheduleDecision, { allowed: false }>;
  readonly config: InstagramRailConfig;
  readonly idempotencyKey: string;
}): Date {
  const { now, decision, config, idempotencyKey } = input;
  const base =
    decision.nextEligibleAt === null
      ? now.getTime() + config.schedule.defaultBackoffMs
      : Math.max(decision.nextEligibleAt.getTime(), now.getTime() + 1_000);
  return new Date(base + scheduleJitterMs(idempotencyKey, config.schedule));
}
