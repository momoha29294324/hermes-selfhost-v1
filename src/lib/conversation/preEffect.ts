/**
 * HERMES-CONVERSATION-R2 §18/§24/§26 — le crochet PRÉ-EFFET.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce module existe pour empêcher
 * ---------------------------------------------------------------------------
 * Entre le moment où une intention est décidée et celui où elle produirait un
 * effet, il s'écoule du temps : un délai humain de quelques minutes (§22), une
 * relance de trois jours (§15), l'ouverture d'un navigateur, une session, une
 * identification. Pendant ce temps, tout peut changer — le prospect répond, il
 * demande qu'on arrête, un humain réarme l'arrêt global, un plafond se remplit,
 * la fenêtre se referme.
 *
 * Une décision prise au début du cycle et opposée à la fin n'est donc pas une
 * garantie : c'est un souvenir. Ce module relit tout, à l'instant où il ne
 * reste plus rien derrière — exactement comme `beforeExternalEffect` le fait
 * déjà pour le rail sortant (HERMES-AUTONOMOUS-R3 §6).
 *
 * ---------------------------------------------------------------------------
 * Aucune seconde règle
 * ---------------------------------------------------------------------------
 * Ce module ne définit AUCUN seuil. L'arrêt global, les plafonds et la cadence
 * viennent d'`evaluateSafety` ; la fenêtre et les dates de reprise
 * d'`evaluateSchedule` ; l'exclusion, l'état et l'identité de
 * `loadConversationGuards`. Il ne fait que les appeler dans le bon ordre, au
 * bon moment, et traduire leur refus dans un vocabulaire fermé qu'un opérateur
 * peut lire.
 *
 * Lever ici ne dépense rien : le crochet précède la réservation du créneau
 * d'effet. La garde est donc gratuite tant qu'elle passe, et totale quand elle
 * refuse.
 */

import type { InstagramRailConfig } from '@/lib/config/schema';
import { CONVERSATION_POLICY_VERSION } from '@/lib/conversation/autonomy';
import { conversationPromptVersionFor } from '@/lib/conversation/brain';
import { COMMERCIAL_POLICY_VERSION } from '@/lib/conversation/commercialPolicy';
import { loadConversationGuards, type ConversationGuards } from '@/lib/conversation/guards';
import {
  ACTIONABLE_PLAN_DECISIONS,
  instant,
  isLivePlanStatus,
  type ConversationPlan,
} from '@/lib/conversation/plan';
import type { Sql } from '@/lib/db/sql';
import type { OutreachState } from '@/lib/replies/taxonomy';
import { InstagramBrowserProfileBusyError } from '@/lib/instagram/browserProfileLease';
import { InstagramRailError } from '@/lib/instagram/rail';
import { evaluateSafety, loadSafetySnapshot } from '@/lib/instagram/safety';
import { evaluateSchedule, loadScheduleSnapshot } from '@/lib/instagram/scheduler';

/**
 * Pourquoi l'effet n'a pas eu lieu, dans un vocabulaire fermé.
 *
 * `BLOCKED_KILL_SWITCH` existe séparément parce que c'est le seul refus qu'un
 * humain lève à la main : le confondre avec un plafond ferait attendre
 * l'écoulement du temps devant une porte que seule une décision ouvre.
 */
export type ConversationEffectRefusal =
  | 'BLOCKED_KILL_SWITCH'
  | 'BLOCKED_OUTSIDE_WINDOW'
  | 'BLOCKED_DAILY_CAP'
  | 'BLOCKED_HOURLY_CAP'
  | 'BLOCKED_COOLDOWN'
  | 'BLOCKED_SAFETY'
  | 'BROWSER_PROFILE_BUSY'
  | 'PLAN_NOT_LIVE'
  | 'PLAN_NOT_ACTIONABLE'
  | 'PLAN_STALE'
  | 'PLAN_POLICY_MISMATCH'
  | 'EFFECT_ALREADY_ATTEMPTED'
  | 'PROSPECT_SUPPRESSED'
  | 'PROSPECT_TERMINAL_STATE'
  | 'IDENTITY_UNCONFIRMED';

/** Les refus qui attendent leur heure, par opposition à ceux qui referment. */
const TEMPORARY_REFUSALS: ReadonlySet<ConversationEffectRefusal> = new Set<ConversationEffectRefusal>([
  'BLOCKED_KILL_SWITCH',
  'BLOCKED_OUTSIDE_WINDOW',
  'BLOCKED_DAILY_CAP',
  'BLOCKED_HOURLY_CAP',
  'BLOCKED_COOLDOWN',
  'BLOCKED_SAFETY',
  'BROWSER_PROFILE_BUSY',
]);

export function isTemporaryRefusal(refusal: ConversationEffectRefusal): boolean {
  return TEMPORARY_REFUSALS.has(refusal);
}

/**
 * Les états commerciaux qui referment une conversation, définitivement.
 *
 * HERMES-AUTO-REPLY-PRODUCTION-R1 — extraits d'un `if` en ligne parce qu'une
 * SECONDE lecture est née (l'enveloppe d'éligibilité de production, qui refuse
 * avant même d'inscrire une intention). Deux littéraux voisins auraient fini
 * par diverger sur un membre, et c'est toujours le plus indulgent qui aurait
 * tenu la porte. La liste vit ici, chez celui qui refuse en dernier.
 *
 * `BOUNCED` et `REVIEW_REQUIRED` n'y sont PAS, et c'est l'état du dépôt qu'on
 * ne change pas au passage : ce round extrait une liste, il ne la réécrit pas.
 */
export const CONVERSATION_TERMINAL_OUTREACH_STATES: readonly OutreachState[] = Object.freeze([
  'SUPPRESSED',
  'NOT_INTERESTED',
]);

export function isConversationTerminalOutreachState(state: OutreachState | null): boolean {
  return state !== null && CONVERSATION_TERMINAL_OUTREACH_STATES.includes(state);
}

export type ConversationEffectVerdict =
  | { readonly allowed: true; readonly guards: ConversationGuards }
  | {
      readonly allowed: false;
      readonly refusal: ConversationEffectRefusal;
      readonly detail: string;
      /** Quand la condition qui refuse aura cessé d'être vraie. `null` si indéterminable. */
      readonly nextEligibleAt: Date | null;
      readonly temporary: boolean;
    };

export interface ConversationEffectInput {
  readonly config: InstagramRailConfig;
  readonly plan: ConversationPlan;
  readonly now: Date;
}

/**
 * Relit tout, et tranche.
 *
 * L'ordre n'est pas cosmétique. Il descend du plus GÉNÉRAL au plus particulier :
 *
 *   1. l'arrêt global et les plafonds — le seul refus qu'aucun calcul ne doit
 *      pouvoir contourner, et le seul qu'un humain arme entre deux instants ;
 *   2. la fenêtre — elle a une date de reprise exacte et bon marché ;
 *   3. l'intention elle-même — est-elle encore vivante, encore la plus récente,
 *      encore rendue sous les règles d'aujourd'hui ?
 *   4. le prospect — a-t-il changé d'avis, d'état ou d'identité ?
 *
 * Les portes 3 et 4 sont volontairement DERNIÈRES : elles coûtent des lectures,
 * et un arrêt global armé rend leur réponse sans objet.
 */
export async function evaluateConversationEffectGate(
  sql: Sql,
  input: ConversationEffectInput,
): Promise<ConversationEffectVerdict> {
  const { plan, now } = input;

  // La politique de rail applicable à CE plan. Il n'en existe qu'une : les
  // plafonds, la fenêtre et l'espacement sont ceux de la configuration, pour
  // toute conversation, sans exemption ni cas particulier.
  const config = input.config;

  // ---- 1. L'arrêt global, les plafonds, la cadence -------------------------
  const safety = evaluateSafety(await loadSafetySnapshot(sql, config), config);
  if (!safety.allowed) {
    const refusal: ConversationEffectRefusal =
      safety.code === 'IG_KILL_SWITCH_ENGAGED'
        ? 'BLOCKED_KILL_SWITCH'
        : safety.code === 'IG_CAP_DAILY_SENT'
          ? 'BLOCKED_DAILY_CAP'
          : safety.code === 'IG_CAP_HOURLY_SENT'
            ? 'BLOCKED_HOURLY_CAP'
            : safety.code === 'IG_CAP_MIN_INTERVAL'
              ? 'BLOCKED_COOLDOWN'
              : 'BLOCKED_SAFETY';
    return refuse(refusal, `refus de dernière seconde [sûreté] : ${safety.reason} — aucun effet`, null);
  }

  // ---- 2. La fenêtre et les dates de reprise -------------------------------
  //
  // `killSwitch` reste à son défaut `'enforce'` : ce chemin peut produire un
  // effet, donc la posture stricte est la seule défendable.
  const schedule = evaluateSchedule({
    snapshot: await loadScheduleSnapshot(sql, config),
    config,
    now,
  });
  if (!schedule.allowed) {
    const refusal: ConversationEffectRefusal =
      schedule.reason === 'kill_switch'
        ? 'BLOCKED_KILL_SWITCH'
        : schedule.reason === 'outside_window'
          ? 'BLOCKED_OUTSIDE_WINDOW'
          : schedule.reason === 'daily_cap'
            ? 'BLOCKED_DAILY_CAP'
            : schedule.reason === 'hourly_cap'
              ? 'BLOCKED_HOURLY_CAP'
              : schedule.reason === 'cooldown'
                ? 'BLOCKED_COOLDOWN'
                : 'BLOCKED_SAFETY';
    return refuse(
      refusal,
      `refus de dernière seconde [ordonnanceur/${schedule.reason}] : ${schedule.detail} — aucun effet`,
      schedule.nextEligibleAt,
    );
  }

  // ---- 3. L'intention est-elle encore celle qu'on croit ? ------------------
  if (plan.externalEffectAttempted) {
    return refuse(
      'EFFECT_ALREADY_ATTEMPTED',
      `le plan ${plan.id} porte déjà une tentative d'effet — « on a essayé, on ne sait pas » ne se ` +
        'résout pas en réessayant',
      null,
    );
  }
  if (!isLivePlanStatus(plan.status)) {
    return refuse(
      'PLAN_NOT_LIVE',
      `le plan ${plan.id} est au statut ${plan.status} — il n'attend plus rien`,
      null,
    );
  }
  if (!ACTIONABLE_PLAN_DECISIONS.includes(plan.decision)) {
    return refuse(
      'PLAN_NOT_ACTIONABLE',
      `le plan ${plan.id} porte la décision ${plan.decision}, qui n'autorise aucun effet`,
      null,
    );
  }
  if (plan.policyVersion !== CONVERSATION_POLICY_VERSION) {
    return refuse(
      'PLAN_POLICY_MISMATCH',
      `le plan ${plan.id} a été rendu sous « ${plan.policyVersion} » et la politique courante est ` +
        `« ${CONVERSATION_POLICY_VERSION} » — une décision rendue sous d'autres règles ne les couvre pas`,
      null,
    );
  }
  // HERMES-REPLY-DELIVERY-R1 §1 — la politique COMMERCIALE, vérifiée à part.
  //
  // Deux versions et deux vérifications, parce que les deux peuvent bouger
  // séparément : élargir ce que Hermes a le droit d'engager n'est pas la même
  // décision qu'élargir les cas où il répond seul. Un plan rendu quand « on
  // peut parler d'engagement contractuel » signifiait autre chose ne couvre pas
  // ce qu'il signifie aujourd'hui.
  if (plan.commercialPolicyVersion !== COMMERCIAL_POLICY_VERSION) {
    return refuse(
      'PLAN_POLICY_MISMATCH',
      `le plan ${plan.id} a relevé les demandes commerciales sous ` +
        `« ${plan.commercialPolicyVersion} » et la politique courante est ` +
        `« ${COMMERCIAL_POLICY_VERSION} » — ce qu'on s'autorise à engager a changé depuis`,
      null,
    );
  }

  // HERMES-END-TO-END-CERTIFICATION-R1 — la version du RÉDACTEUR, vérifiée
  // comme les deux autres.
  //
  // `brain_version` était inscrite sur le plan (`planning.ts`) et recopiée sur
  // l'effet (`replyEffect.ts`), et comparée nulle part. Un plan porte pourtant
  // un CORPS — le texte exact qui partira — et ce corps a été écrit sous une
  // consigne précise. Corriger le rédacteur sans toucher à `autonomy.ts`
  // laissait donc partir, intact, le texte d'hier : les deux gardes existantes
  // ne parlent que de « peut-on répondre seul » et « que peut-on engager »,
  // aucune ne parle de « qu'a-t-on demandé au modèle ».
  //
  // Ce n'était pas théorique : les cinq versions de contenu du dépôt
  // (`HERMES_OFFER_VERSION`, `ACQUISITION_SERVICE_VERSION`,
  // `CONTACT_PURPOSE_VERSION`, `PRICE_SUBJECT_VERSION`,
  // `APPOINTMENT_POLICY_VERSION`) ne vivent que dans le prompt, et la seule
  // chose qui referme un texte écrit sous les anciennes est le numéro
  // `conv-r*`. Le lier à la politique par convention de main tenait tant que la
  // même personne bougeait les deux ; le code ne le tenait pas.
  //
  // Troisième version, troisième vérification, même raison que la deuxième :
  // les trois peuvent bouger séparément.
  if (plan.brainVersion !== conversationPromptVersionFor(plan.channel)) {
    return refuse(
      'PLAN_POLICY_MISMATCH',
      `le corps du plan ${plan.id} a été rédigé sous « ${plan.brainVersion} » et la consigne ` +
        `courante est « ${conversationPromptVersionFor(plan.channel)} » — un texte écrit sous ` +
        'une autre consigne ne dit pas ce qu’on dirait aujourd’hui',
      null,
    );
  }

  // ---- 4. Le prospect a-t-il changé depuis ? -------------------------------
  const guards = await loadConversationGuards(sql, plan.prospectId, plan.channel);

  if (guards.suppressed) {
    return refuse(
      'PROSPECT_SUPPRESSED',
      'ce commerce figure dans do_not_contact — aucun effet, quelle que soit l’intention planifiée',
      null,
    );
  }
  if (isConversationTerminalOutreachState(guards.outreachState)) {
    return refuse(
      'PROSPECT_TERMINAL_STATE',
      `l'état commercial est ${guards.outreachState} — la conversation est close depuis la planification`,
      null,
    );
  }
  if (!guards.identityConfirmed) {
    return refuse(
      'IDENTITY_UNCONFIRMED',
      `le rapprochement entreprise ↔ compte n'est plus établi (identity_review = ` +
        `${guards.identityReview ?? 'inconnu'}) — écrire engagerait un message vers quelqu'un qu'on n'identifie pas`,
      null,
    );
  }

  // ---- 5. La FRAÎCHEUR, en dernier et en toutes lettres --------------------
  //
  // §24 : un message arrivé depuis le calcul rend le brouillon périmé. La
  // comparaison porte sur l'heure de RÉCEPTION, jamais sur l'heure de
  // traitement — même grandeur que la marque d'eau de 0048, et pour la même
  // raison : l'ordre qui compte est celui de la boîte de réception.
  const staleness = replyStaleness(plan.conversationWatermark, guards.latestInboundAt, {
    triggerInboundMessageId: plan.triggerInboundMessageId,
    latestInboundId: guards.latestInboundId,
    latestInboundTies: guards.latestInboundTies,
  });
  if (staleness !== null) {
    return refuse('PLAN_STALE', staleness, null);
  }

  return { allowed: true, guards };
}

function refuse(
  refusal: ConversationEffectRefusal,
  detail: string,
  nextEligibleAt: Date | null,
): ConversationEffectVerdict {
  return Object.freeze({
    allowed: false as const,
    refusal,
    detail,
    nextEligibleAt,
    temporary: isTemporaryRefusal(refusal),
  });
}

/**
 * Le plan a-t-il été dépassé par un message plus récent ?
 *
 * Rend le motif en clair, ou `null` quand rien ne le dépasse. Extrait en
 * fonction PURE pour être testable sans base — c'est le scénario §34.9 (« un
 * nouvel entrant avant l'envoi annule le brouillon précédent »), et il ne doit
 * pas dépendre d'un fixture Postgres pour être vérifié.
 *
 * Un plan SANS marque d'eau (une relance sur un prospect qui n'a jamais
 * répondu) devient périmé dès qu'un message arrive : c'est exactement le cas
 * « le prospect a répondu avant la relance » de §35.22, et le côté sûr est de
 * refuser.
 *
 * ---------------------------------------------------------------------------
 * HERMES-PLAN-STALE-TRIGGER-FIX-R1 — l'IDENTITÉ du déclencheur
 * ---------------------------------------------------------------------------
 * Le 23 août 2026, le premier tour réellement `AUTO_REPLY_ELIGIBLE` a été
 * refusé ici alors que RIEN n'était arrivé après lui : le message le plus
 * récent de la conversation était son propre déclencheur. La comparaison ne
 * portait que sur des horodatages, et l'un des deux avait perdu ses
 * millisecondes en passant par une chaîne — `07:36:19.297` s'est retrouvé
 * « postérieur » à lui-même arrondi à `07:36:19.000`.
 *
 * Arrondir aurait été le mauvais correctif : il aurait rendu aveugle une garde
 * dont le métier est de voir arriver un message. Ce qui manquait n'est pas de
 * la tolérance, c'est un NOM. Un plan écrit en réponse au message X ne peut pas
 * être dépassé par X — cela ne dépend d'aucune horloge, et c'est vrai quelle
 * que soit la précision des colonnes.
 *
 * L'identité ne s'applique QUE lorsqu'elle existe des deux côtés et qu'elle
 * COÏNCIDE. Dès que le dernier message porte un autre identifiant, on retombe
 * mot pour mot sur la comparaison d'avant : un message réellement plus récent
 * bloque toujours le plan. La garde n'est donc pas desserrée, elle est rendue
 * capable de reconnaître le seul message dont elle n'avait pas à se méfier.
 *
 * La précision est corrigée en plus, pas à la place : la marque d'eau est lue
 * par `instant()`, qui accepte une `Date` telle quelle plutôt que de la faire
 * passer par `Date.parse(String(date))` — la conversion qui perdait les
 * millisecondes.
 */
export interface ReplyTriggerIdentity {
  /** Le message auquel CE plan répond. `null` pour une relance. */
  readonly triggerInboundMessageId: string | null;
  /** Le message le plus récent de la conversation, tel que la garde le lit. */
  readonly latestInboundId: string | null;
  /**
   * Combien de messages partagent l'heure du plus récent.
   *
   * HERMES-END-TO-END-CERTIFICATION-R1 — l'échappatoire d'identité repose sur
   * « le déclencheur EST le dernier message ». Cette phrase suppose qu'il n'y
   * en ait qu'UN dernier. Le rail entrant produit régulièrement le contraire :
   * `instagramCollector` horodate à l'instant du relevé tout message que la
   * page n'a pas daté, si bien qu'une salve lue d'un seul coup porte la même
   * heure pour tous ses messages. « Le plus récent » est alors désigné par
   * `id desc`, c'est-à-dire par un uuid aléatoire.
   *
   * Une chance sur deux que le déclencheur du plan gagne ce tirage — et il
   * traverse alors la fraîcheur alors qu'un message aussi récent que lui reste
   * sans réponse. C'est exactement le scénario « deux messages rapprochés » :
   * Hermes répondrait au premier des deux et ignorerait le second.
   *
   * Optionnel, et absent vaut « je ne sais pas », donc AUCUN changement de
   * comportement pour un appelant qui ne le passe pas — ce qu'un test vérifie
   * plutôt que de le promettre. Fourni et supérieur à 1, l'échappatoire se
   * referme : le plan est déclaré dépassé, ce qui est le côté sûr. Il repartira
   * de lui-même au tour suivant, une fois la salve lue en entier.
   */
  readonly latestInboundTies?: number;
}

export function replyStaleness(
  planWatermark: string | Date | null,
  latestInboundAt: string | Date | null,
  identity?: ReplyTriggerIdentity,
): string | null {
  if (latestInboundAt === null) return null;

  // Le déclencheur EST le dernier message : rien ne l'a dépassé, et aucune
  // horloge n'a son mot à dire. Exige les deux identifiants — un `null` d'un
  // côté ne prouve pas une égalité, il prouve une ignorance.
  if (
    identity !== undefined &&
    identity.triggerInboundMessageId !== null &&
    identity.latestInboundId !== null &&
    identity.triggerInboundMessageId === identity.latestInboundId
  ) {
    // …à condition qu'il n'y ait bien qu'UN dernier message. Une égalité
    // d'horodatage fait désigner le « plus récent » par un uuid aléatoire ; le
    // déclencheur peut donc gagner ce tirage sans être seul. On refuse plutôt
    // que de jouer à pile ou face — le plan repartira quand la salve sera lue
    // en entier et qu'un vrai dernier message existera.
    if (identity.latestInboundTies !== undefined && identity.latestInboundTies > 1) {
      return (
        `${String(identity.latestInboundTies)} messages portent la même heure de réception que le ` +
        'déclencheur de ce plan — « le plus récent » y est désigné par un identifiant aléatoire, ' +
        'pas par le temps : on ne répond pas sur un tirage'
      );
    }
    return null;
  }

  const latest = instant(latestInboundAt);
  if (!Number.isFinite(latest)) {
    return 'l’heure du dernier message reçu est illisible — impossible d’établir que ce plan est encore le plus récent';
  }
  if (planWatermark === null) {
    return `un message a été reçu le ${String(latestInboundAt)} alors que ce plan n'en connaissait aucun — il est dépassé`;
  }
  const known = instant(planWatermark);
  if (!Number.isFinite(known)) {
    return 'la marque de fraîcheur du plan est illisible — impossible de la comparer';
  }
  if (latest > known) {
    return `un message reçu le ${String(latestInboundAt)} est postérieur à la marque du plan ` +
      `(${String(planWatermark)}) — ` +
      'ce brouillon répond à une phrase qui n’est plus la dernière';
  }
  return null;
}

/**
 * §19 — un profil navigateur occupé n'est pas une panne de session.
 *
 * Les deux runtimes Hermes partagent une seule session Instagram, donc l'un des
 * deux passe forcément après l'autre. Compter cette contention parmi les échecs
 * ferait grossir `sessionFailures` sur un événement parfaitement normal, et
 * finirait par fermer le rail alors que rien n'est cassé.
 *
 * Rend `null` pour tout ce qui n'est pas cette contention : l'appelant traitera
 * le reste comme ce que c'est.
 */
export function classifyProfileContention(error: unknown): ConversationEffectRefusal | null {
  if (error instanceof InstagramBrowserProfileBusyError) return 'BROWSER_PROFILE_BUSY';
  if (error instanceof InstagramRailError && error.code === 'IG_BROWSER_PROFILE_BUSY') {
    return 'BROWSER_PROFILE_BUSY';
  }
  return null;
}
