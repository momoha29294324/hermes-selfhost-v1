import type { Sql } from '@/lib/db/sql';
import type { InstagramRailConfig } from '@/lib/config/schema';
import type { GateRecord, InstagramBlockCode } from '@/lib/instagram/types';

/**
 * IG-R1 §5 — l'arrêt global et les plafonds.
 *
 * Deux propriétés font toute la valeur de ce module, et aucune n'est un
 * réglage :
 *
 *   1. **Fermé par défaut.** Une base sans ligne `ig_kill_switch` vaut « armé ».
 *      Une erreur de lecture aussi. Un interrupteur dont l'absence signifierait
 *      « ouvert » ne protégerait que les machines où quelqu'un a pensé à le
 *      fermer.
 *   2. **Séparation lecture / décision.** `loadSafetySnapshot` interroge la
 *      base ; `evaluateSafety` décide, sans I/O, sans horloge implicite. La
 *      décision est donc testable sur n'importe quel état, y compris ceux
 *      qu'aucune donnée réelle ne produira avant longtemps — un plafond
 *      d'envois atteint, par exemple, alors que rien n'a jamais été envoyé.
 *
 * Ce que les plafonds bornent : les effets et la charge. Ce qu'ils ne font
 * pas : imiter un humain, échelonner pour passer inaperçu, ou compenser un
 * refus d'Instagram. Aucune valeur n'est randomisée, aucune ne dépend de
 * l'heure de la journée.
 */

// ---------------------------------------------------------------------------
// Interrupteur d'arrêt
// ---------------------------------------------------------------------------

export interface KillSwitchState {
  readonly engaged: boolean;
  readonly setBy: string | null;
  readonly reason: string | null;
  readonly updatedAt: string | null;
  /** `true` quand aucune ligne n'existe : l'arrêt vient du défaut, pas d'une décision. */
  readonly fromDefault: boolean;
}

/** L'état livré par la migration 0029 : armé, sans auteur, parce que personne n'a rien décidé. */
export const DEFAULT_KILL_SWITCH: KillSwitchState = Object.freeze({
  engaged: true,
  setBy: null,
  reason: null,
  updatedAt: null,
  fromDefault: true,
});

export async function loadKillSwitch(sql: Sql): Promise<KillSwitchState> {
  const rows = await sql.query<{ engaged: boolean; setBy: string; reason: string; updatedAt: string }>(
    `select engaged, set_by as "setBy", reason, updated_at as "updatedAt" from ig_kill_switch where id = true`,
  );
  const row = rows[0];
  if (!row) return DEFAULT_KILL_SWITCH;
  return Object.freeze({
    engaged: row.engaged,
    setBy: row.setBy,
    reason: row.reason,
    updatedAt: row.updatedAt,
    fromDefault: false,
  });
}

/**
 * Positionne l'interrupteur. `setBy` doit nommer un humain : une levée
 * d'arrêt sans auteur n'est pas une décision, c'est un accident qu'on ne peut
 * rattacher à personne (même exigence que `r6b_crm_destinations`, 0027).
 */
export async function setKillSwitch(
  sql: Sql,
  input: { engaged: boolean; setBy: string; reason: string },
): Promise<KillSwitchState> {
  const setBy = input.setBy.trim();
  const reason = input.reason.trim();
  if (setBy.length === 0) throw new Error('setKillSwitch : --as est obligatoire — un arrêt se lève au nom de quelqu’un');
  if (reason.length === 0) throw new Error('setKillSwitch : une raison est obligatoire');

  await sql.query(
    `insert into ig_kill_switch (id, engaged, set_by, reason, updated_at)
     values (true, $1, $2, $3, now())
     on conflict (id) do update
        set engaged = excluded.engaged, set_by = excluded.set_by,
            reason = excluded.reason, updated_at = now()`,
    [input.engaged, setBy, reason],
  );
  return loadKillSwitch(sql);
}

// ---------------------------------------------------------------------------
// Compteurs
// ---------------------------------------------------------------------------

/**
 * Ce que la base sait, au moment de décider. Toutes les valeurs sont des faits
 * comptés, jamais des estimations : `sentLastDay` compte des lignes en statut
 * `SENT` dans les TROIS journaux du rail — `ig_job_events` (0029),
 * `ig_controlled_test_events` (0035) et `hermes_conversation_plans` (0049) —
 * qui, par contrainte, ne peuvent porter ce statut qu'après un effet externe
 * réel.
 *
 * Les deux journaux restent séparés partout ailleurs : un test contrôlé ne doit
 * apparaître dans aucun KPI commercial. Ici il compte, parce qu'un plafond
 * d'envoi ne mesure pas une performance commerciale mais la charge imposée à
 * Instagram par un compte émetteur — et il n'y en a qu'un.
 */
export interface SafetySnapshot {
  readonly killSwitch: KillSwitchState;
  readonly sentLastDay: number;
  readonly sentLastHour: number;
  /**
   * IG2 §1 — millisecondes écoulées depuis la dernière TENTATIVE D'EFFET
   * EXTERNE, `null` si aucune n'a jamais eu lieu.
   *
   * « Effet externe », et non « envoi réussi » : la mesure lit
   * `external_effect_attempted = true`, drapeau que seule la primitive LIVE
   * pose, juste avant son unique clic. Un `SENT` le porte, un `AMBIGUOUS`
   * aussi — et c'est voulu : une tentative dont on ignore l'issue a chargé
   * Instagram exactement autant qu'un succès, donc elle consomme l'intervalle.
   *
   * Ce que cette valeur ne compte pas, et c'est tout le sujet du correctif : un
   * DRY_RUN, une ouverture de profil, une vérification de session ou
   * d'identité, un refus prononcé avant la primitive d'envoi. Aucun de ces
   * gestes n'envoie quoi que ce soit ; les facturer d'un intervalle de cadence
   * mesurerait des navigations sous un nom qui promet des envois.
   */
  readonly msSinceLastExternalEffect: number | null;
  /** Échecs consécutifs en queue de journal, tous jobs confondus. */
  readonly consecutiveFailures: number;
  /**
   * Sessions navigateur non saines CONSÉCUTIVES, dans la fenêtre configurée,
   * comptées depuis la plus récente. Une session `SESSION_READY` remet le
   * compteur à zéro : le plafond mesure un rail en panne maintenant, pas des
   * échecs qu'une reconnexion réussie a déjà réglés.
   */
  readonly sessionFailures: number;
}

export async function loadSafetySnapshot(sql: Sql, config: InstagramRailConfig): Promise<SafetySnapshot> {
  const killSwitch = await loadKillSwitch(sql);

  // Deux lectures, parce que deux questions différentes. Les plafonds
  // journalier et horaire comptent des ENVOIS (`status = 'SENT'`) — ils portent
  // ce nom et le commit 3011f48 l'a déjà mis au clair. L'intervalle minimal,
  // lui, mesure la dernière fois qu'Instagram a été TOUCHÉ par la primitive
  // d'envoi, succès ou non : `external_effect_attempted = true`. Les fondre en
  // une seule requête forcerait l'un des deux à mentir.
  //
  // IG2.2 — les deux journaux sont additionnés, et c'est délibéré.
  //
  // `ig_controlled_test_events` est SÉPARÉ de `ig_job_events` pour que les KPI
  // commerciaux ne comptent jamais un test technique (mission §7). Les plafonds
  // ne sont pas des KPI : ils bornent la charge imposée à Instagram par LE
  // compte émetteur, et un DM de test part du même compte, par le même
  // navigateur, avec la même session. L'exclure ici laisserait ouverte la seule
  // façon de dépasser le plafond sans le voir — alterner un envoi commercial et
  // un test.
  //
  // HERMES-CONVERSATION-R2 §20 — un TROISIÈME journal s'y ajoute, pour la même
  // raison exactement : une réponse automatique et une relance partent du même
  // compte, par le même navigateur, avec la même session. « Ne crée pas un
  // quota parallèle » se tient ici, dans la requête qui compte, et nulle part
  // ailleurs.
  const sent = await sql.query<{ lastDay: string; lastHour: string }>(
    `select
       (select count(*) from ig_job_events
         where status = 'SENT' and created_at > now() - interval '24 hours')
       + (select count(*) from ig_controlled_test_events
           where status = 'SENT' and created_at > now() - interval '24 hours')
       + (select count(*) from hermes_conversation_plans
           where status = 'SENT' and external_effect_started_at > now() - interval '24 hours') as "lastDay",
       (select count(*) from ig_job_events
         where status = 'SENT' and created_at > now() - interval '1 hour')
       + (select count(*) from ig_controlled_test_events
           where status = 'SENT' and created_at > now() - interval '1 hour')
       + (select count(*) from hermes_conversation_plans
           where status = 'SENT' and external_effect_started_at > now() - interval '1 hour')   as "lastHour"`,
  );

  // IG2.1 — lu sur les JOBS, plus sur les événements.
  //
  // `ig_dispatch_jobs.external_effect_started_at` date le geste lui-même : posé
  // une fois, juste avant l'unique clic, jamais retouché. Les événements, eux,
  // se multiplient sans qu'un octet parte — une adjudication postérieure en
  // écrit un second qui DÉCRIT la même tentative, avec la date d'aujourd'hui.
  // Mesurer l'intervalle dessus reviendrait à repousser la cadence chaque fois
  // qu'on RELIT une conversation.
  //
  // IG2.2 — la plus RÉCENTE des deux dates, pour la même raison qu'au-dessus :
  // l'intervalle minimal mesure « depuis combien de temps ce compte n'a pas
  // touché Instagram ». Un test contrôlé le touche. `greatest` ignore les
  // `null`, donc un dépôt sans aucun test se comporte exactement comme avant.
  const effect = await sql.query<{ msSince: string | null }>(
    `select (extract(epoch from (now() - greatest(
              (select max(external_effect_started_at) from ig_dispatch_jobs
                where external_effect_attempted = true),
              (select max(external_effect_started_at) from ig_controlled_tests
                where external_effect_attempted = true),
              (select max(external_effect_started_at) from hermes_conversation_plans
                where external_effect_attempted = true)
            ))) * 1000)::bigint as "msSince"`,
  );

  // La queue du journal, plus récent d'abord : la série d'échecs s'arrête au
  // premier événement qui n'en est pas un. Bornée à 200 lignes — au-delà, tout
  // plafond configurable (≤ 50) a déjà tranché.
  //
  // IG3 — restreinte aux ISSUES. Le journal porte désormais aussi des faits de
  // parcours (`ENQUEUED`, `CLAIMED`, `SKIPPED`, `DRY_RUN_STARTED`), et les
  // laisser entrer ici cassait le compteur de la façon la plus silencieuse qui
  // soit : un `CLAIMED` écrit juste avant le traitement devenait l'événement le
  // plus récent, la série d'échecs s'arrêtait sur lui, et le plafond mesurait
  // toujours zéro. Un rail qui échoue en boucle aurait continué indéfiniment.
  const recent = await sql.query<{ status: string }>(
    `select status from ig_job_events
      where status in ('DRY_RUN_OK', 'DRY_RUN_COMPLETED', 'BLOCKED', 'FAILED',
                       'SENT', 'AMBIGUOUS', 'DELIVERY_FAILED')
      order by created_at desc, id desc limit 200`,
  );
  let consecutiveFailures = 0;
  for (const row of recent) {
    if (row.status !== 'FAILED') break;
    consecutiveFailures += 1;
  }

  // Les sessions de la fenêtre, plus récente d'abord. Comme pour les échecs de
  // jobs, on compte la SÉRIE qui se termine maintenant : le compteur s'arrête à
  // la première session saine.
  //
  // Ce n'était pas le cas au départ — un `count(*)` sur toute la fenêtre — et
  // le premier dry-run authentifié l'a montré : trois sessions non saines
  // constatées AVANT que un opérateur se connecte bloquaient encore le rail alors
  // qu'une session `SESSION_READY` avait été observée depuis. Un plafond
  // d'échecs qui ignore le succès qui les a suivis ne mesure pas un rail en
  // panne, il mesure un passé révolu — et il obligerait à attendre la fin de la
  // fenêtre après chaque reconnexion réussie.
  //
  // La garde ne s'en trouve pas affaiblie : un rail qui échoue réellement en
  // boucle n'a pas de session saine à intercaler, donc sa série continue de
  // grossir jusqu'au plafond.
  const sessions = await sql.query<{ state: string }>(
    `select state from ig_browser_sessions
      where opened_at > now() - ($1::bigint * interval '1 millisecond')
      order by opened_at desc, id desc
      limit 200`,
    [String(config.session.failureWindowMs)],
  );
  let sessionFailures = 0;
  for (const row of sessions) {
    if (row.state === 'SESSION_READY') break;
    sessionFailures += 1;
  }

  const row = sent[0];
  const msSinceRaw = effect[0]?.msSince ?? null;
  return Object.freeze({
    killSwitch,
    sentLastDay: Number(row?.lastDay ?? 0),
    sentLastHour: Number(row?.lastHour ?? 0),
    msSinceLastExternalEffect: msSinceRaw === null ? null : Number(msSinceRaw),
    consecutiveFailures,
    sessionFailures,
  });
}

// ---------------------------------------------------------------------------
// Décision
// ---------------------------------------------------------------------------

export type SafetyVerdict =
  | { readonly allowed: true; readonly gates: readonly GateRecord[] }
  | {
      readonly allowed: false;
      readonly code: InstagramBlockCode;
      readonly reason: string;
      readonly gates: readonly GateRecord[];
    };

/**
 * Évalue l'arrêt global puis chaque plafond, dans cet ordre, et s'arrête au
 * premier refus.
 *
 * Le premier refus l'emporte, mais toutes les gardes déjà évaluées sont
 * rendues dans `gates` — y compris celles qui ont passé. Savoir qu'une garde a
 * été ÉVALUÉE est aussi utile qu'apprendre qu'elle a refusé : c'est ce qui
 * distingue « le plafond horaire est bon » de « le plafond horaire n'a jamais
 * été regardé ».
 *
 * Les plafonds d'envoi lisent des compteurs qui valent 0 dans ce dépôt, et
 * c'est voulu : la garde doit être branchée AVANT qu'un envoi existe, pas
 * après. Les tests l'exercent en insérant des événements `SENT` fabriqués,
 * seule façon d'éprouver un plafond sans envoyer.
 */
export function evaluateSafety(snapshot: SafetySnapshot, config: InstagramRailConfig): SafetyVerdict {
  const effect = evaluateEffectCaps(snapshot, config);
  if (!effect.allowed) return effect;
  const workload = evaluateWorkloadCaps(snapshot, config);
  if (!workload.allowed) {
    return { ...workload, gates: Object.freeze([...effect.gates, ...workload.gates]) };
  }
  return { allowed: true, gates: Object.freeze([...effect.gates, ...workload.gates]) };
}

/**
 * IG3 §5/§7 — les gardes qui bornent un EFFET : arrêt global, plafonds d'envoi,
 * intervalle de cadence.
 *
 * Extraites de `evaluateSafety` sans en changer une ligne ni un ordre — le
 * chemin LIVE continue de voir exactement la même séquence de refus, parce que
 * `evaluateSafety` est maintenant l'appel de celle-ci suivi de l'autre.
 *
 * Pourquoi les séparer : ces quatre gardes répondent à « un message peut-il
 * partir maintenant ? », et un DRY-RUN ne fait pas partir de message. Les lui
 * appliquer comme des refus fermes rendait le worker de vérification
 * inutilisable dès que l'arrêt global était armé — c'est-à-dire tout le temps,
 * puisque c'est le défaut. L'ordonnanceur (`scheduler.ts`) les évalue donc et
 * les PROJETTE en DRY-RUN (« voici ce qui aurait bloqué, et jusqu'à quand »)
 * tout en les imposant en LIVE.
 */
export function evaluateEffectCaps(snapshot: SafetySnapshot, config: InstagramRailConfig): SafetyVerdict {
  const gates: GateRecord[] = [];

  const block = (gate: string, code: InstagramBlockCode, reason: string): SafetyVerdict => {
    gates.push({ gate, verdict: 'BLOCK', detail: reason });
    return { allowed: false, code, reason, gates: Object.freeze([...gates]) };
  };
  const pass = (gate: string, detail: string): void => {
    gates.push({ gate, verdict: 'PASS', detail });
  };

  if (snapshot.killSwitch.engaged) {
    return block(
      'kill_switch',
      'IG_KILL_SWITCH_ENGAGED',
      snapshot.killSwitch.fromDefault
        ? 'arrêt global Instagram armé par défaut — aucune ligne ig_kill_switch, donc aucun travail Instagram ' +
            'n’est autorisé tant qu’un humain ne l’a pas levé nominativement'
        : `arrêt global Instagram armé par ${snapshot.killSwitch.setBy ?? 'inconnu'} : ${snapshot.killSwitch.reason ?? 'sans motif'}`,
    );
  }
  pass('kill_switch', `levé par ${snapshot.killSwitch.setBy ?? 'inconnu'}`);

  const { caps } = config;

  if (snapshot.sentLastDay >= caps.dailySentCap) {
    return block(
      'cap_daily_sent',
      'IG_CAP_DAILY_SENT',
      `${snapshot.sentLastDay} envoi(s) sur 24 h, plafond ${caps.dailySentCap}`,
    );
  }
  pass('cap_daily_sent', `${snapshot.sentLastDay}/${caps.dailySentCap}`);

  if (snapshot.sentLastHour >= caps.hourlySentCap) {
    return block(
      'cap_hourly_sent',
      'IG_CAP_HOURLY_SENT',
      `${snapshot.sentLastHour} envoi(s) sur 1 h, plafond ${caps.hourlySentCap}`,
    );
  }
  pass('cap_hourly_sent', `${snapshot.sentLastHour}/${caps.hourlySentCap}`);

  // `null` veut dire « aucune tentative d'effet externe n'a jamais eu lieu » —
  // donc aucun intervalle à respecter. Le confondre avec 0 ms bloquerait le
  // tout premier envoi pour toujours.
  if (
    snapshot.msSinceLastExternalEffect !== null &&
    snapshot.msSinceLastExternalEffect < caps.minSendIntervalMs
  ) {
    return block(
      'cap_min_interval',
      'IG_CAP_MIN_INTERVAL',
      `dernière tentative d’effet externe il y a ${snapshot.msSinceLastExternalEffect} ms, ` +
        `intervalle minimal ${caps.minSendIntervalMs} ms`,
    );
  }
  pass(
    'cap_min_interval',
    snapshot.msSinceLastExternalEffect === null
      ? 'aucune tentative d’effet externe antérieure'
      : `${snapshot.msSinceLastExternalEffect} ms`,
  );

  return { allowed: true, gates: Object.freeze([...gates]) };
}

/**
 * IG3 §7 — les gardes qui bornent le TRAVAIL : échecs consécutifs, sessions
 * navigateur non saines.
 *
 * Celles-ci s'appliquent aux deux modes, et un DRY-RUN n'y échappe pas. La
 * raison est symétrique de la précédente : elles ne mesurent pas un droit
 * d'envoyer mais un rail en panne, et un rail en panne le reste qu'on
 * l'observe ou qu'on l'utilise. Un worker de vérification qui insisterait
 * devant trois sessions mortes chargerait Instagram pour rien.
 */
export function evaluateWorkloadCaps(snapshot: SafetySnapshot, config: InstagramRailConfig): SafetyVerdict {
  const gates: GateRecord[] = [];

  const block = (gate: string, code: InstagramBlockCode, reason: string): SafetyVerdict => {
    gates.push({ gate, verdict: 'BLOCK', detail: reason });
    return { allowed: false, code, reason, gates: Object.freeze([...gates]) };
  };
  const pass = (gate: string, detail: string): void => {
    gates.push({ gate, verdict: 'PASS', detail });
  };

  const { caps } = config;

  if (snapshot.consecutiveFailures >= caps.maxConsecutiveFailures) {
    return block(
      'cap_consecutive_failures',
      'IG_CAP_CONSECUTIVE_FAILURES',
      `${snapshot.consecutiveFailures} échec(s) consécutif(s), plafond ${caps.maxConsecutiveFailures} — ` +
        'un rail qui échoue en boucle s’arrête, il n’insiste pas',
    );
  }
  pass('cap_consecutive_failures', `${snapshot.consecutiveFailures}/${caps.maxConsecutiveFailures}`);

  if (snapshot.sessionFailures >= caps.maxSessionFailures) {
    return block(
      'cap_session_failures',
      'IG_CAP_SESSION_FAILURES',
      `${snapshot.sessionFailures} session(s) non saine(s) sur la fenêtre, plafond ${caps.maxSessionFailures}`,
    );
  }
  pass('cap_session_failures', `${snapshot.sessionFailures}/${caps.maxSessionFailures}`);

  return { allowed: true, gates: Object.freeze([...gates]) };
}
