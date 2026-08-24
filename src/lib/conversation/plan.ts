/**
 * HERMES-CONVERSATION-R2 §25/§26 — le REGISTRE des intentions
 * conversationnelles : provenance, fraîcheur, idempotence.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce module garantit, et par quel moyen
 * ---------------------------------------------------------------------------
 *
 *   * **une réponse entrante ne produit qu'un effet** — index unique sur la clé
 *     d'idempotence, dérivée du déclencheur sans horloge ni hasard. Ce n'est pas
 *     un `select` préalable que deux workers liraient en même temps : c'est
 *     Postgres qui départage ;
 *
 *   * **un message plus récent annule le précédent** — index unique PARTIEL sur
 *     `(prospect_id, kind)` limité aux statuts vivants. Deux intentions en vol
 *     pour le même prospect ne sont pas rattrapables après coup ; la base les
 *     rend impossibles, et `recordConversationPlan` supersède dans la MÊME
 *     transaction que l'insertion ;
 *
 *   * **un redémarrage ne double pas** — `external_effect_attempted` est posé
 *     AVANT le geste, jamais après, et la reprise de bail en tire la seule
 *     conclusion possible : `AMBIGUOUS`, terminal, jamais rejoué ;
 *
 *   * **les plafonds sont ceux du rail** — `reserveConversationEffectSlot`
 *     prend le MÊME verrou consultatif et compte les MÊMES sources que
 *     `reserveExternalEffectSlot`. Un premier message, un test contrôlé, une
 *     réponse et une relance se disputent le même quota, parce qu'ils partent du
 *     même compte (§20).
 *
 * ---------------------------------------------------------------------------
 * Ce que ce module N'EST PAS
 * ---------------------------------------------------------------------------
 * Ce n'est pas un ordonnanceur : il ne sait pas si l'heure est ouverte, et il
 * n'a aucune fenêtre. Ce n'est pas un worker : rien ici n'ouvre de navigateur,
 * et aucune primitive d'envoi n'est importée, ni directement ni transitivement.
 * `not_before` est une BORNE de réclamation, pas une promesse d'exécution.
 */

import { createHash } from 'node:crypto';
import type { ConversationPolicyConfig, InstagramRailConfig } from '@/lib/config/schema';
import type { GroundingGap } from '@/lib/conversation/grounding';
import type { NaturalnessVerdict } from '@/lib/conversation/naturalness';
import type { CallReadiness } from '@/lib/conversation/signals';
import type { Sql } from '@/lib/db/sql';
import { stableHash32 } from '@/lib/instagram/scheduler';
import type { OfferReadiness } from '@/lib/learning/offer';

// ---------------------------------------------------------------------------
// Le vocabulaire
// ---------------------------------------------------------------------------

export type ConversationPlanKind = 'AUTO_REPLY' | 'FOLLOW_UP_1' | 'FOLLOW_UP_2';

export type ConversationPlanStatus =
  | 'PLANNED'
  | 'CLAIMED'
  | 'SKIPPED'
  | 'SUPERSEDED'
  | 'CANCELLED'
  | 'BLOCKED'
  | 'FAILED'
  | 'SENT'
  | 'AMBIGUOUS';

/**
 * Les statuts VIVANTS — ceux que l'index partiel unique protège.
 *
 * `CLAIMED` en fait partie : un plan sous bail n'est pas terminé, et autoriser
 * un second plan pendant qu'un worker tient le premier serait exactement la
 * fenêtre qu'on cherche à fermer.
 */
export const LIVE_PLAN_STATUSES: readonly ConversationPlanStatus[] = Object.freeze([
  'PLANNED',
  'CLAIMED',
  'SKIPPED',
]);

/** Les statuts depuis lesquels un plan peut être PRIS. `CLAIMED` en est absent. */
export const CLAIMABLE_PLAN_STATUSES: readonly ConversationPlanStatus[] = Object.freeze([
  'PLANNED',
  'SKIPPED',
]);

/** Les statuts absorbants. Un plan qui les atteint ne repart jamais. */
export const TERMINAL_PLAN_STATUSES: readonly ConversationPlanStatus[] = Object.freeze([
  'SUPERSEDED',
  'CANCELLED',
  'BLOCKED',
  'FAILED',
  'SENT',
  'AMBIGUOUS',
]);

export function isLivePlanStatus(status: ConversationPlanStatus): boolean {
  return LIVE_PLAN_STATUSES.includes(status);
}

/** Les décisions qu'un plan peut porter, réponses et relances confondues. */
export type ConversationPlanDecision =
  | 'AUTO_REPLY_ELIGIBLE'
  | 'AUTO_REPLY_SKIP'
  | 'HUMAN_ESCALATION'
  | 'TERMINAL_STOP'
  | 'FOLLOW_UP_DUE'
  | 'FOLLOW_UP_SCHEDULED'
  | 'FOLLOW_UP_SKIP'
  | 'FOLLOW_UP_STOP';

/** Les décisions qui autorisent un effet — à condition que le runtime suive. */
export const ACTIONABLE_PLAN_DECISIONS: readonly ConversationPlanDecision[] = Object.freeze([
  'AUTO_REPLY_ELIGIBLE',
  'FOLLOW_UP_DUE',
]);

export interface ConversationPlan {
  readonly id: string;
  readonly prospectId: string;
  readonly channel: 'instagram_dm' | 'email';
  readonly kind: ConversationPlanKind;
  readonly triggerInboundMessageId: string | null;
  readonly triggerManifestId: string | null;
  readonly idempotencyKey: string;
  readonly actorKind: 'AUTONOMOUS_POLICY';
  readonly policyVersion: string;
  /** HERMES-REPLY-DELIVERY-R1 §1 — la politique COMMERCIALE, distincte de la précédente. */
  readonly commercialPolicyVersion: string;
  readonly brainVersion: string;
  readonly decision: ConversationPlanDecision;
  readonly decisionGate: string;
  readonly decisionReason: string | null;
  readonly decisionDetail: string | null;
  readonly conversationWatermark: string | null;
  readonly body: string | null;
  readonly bodySha256: string | null;
  readonly naturalnessVerdict: NaturalnessVerdict | null;
  readonly groundingGaps: readonly GroundingGap[];
  readonly offerReadiness: OfferReadiness;
  readonly callReadiness: CallReadiness;
  readonly status: ConversationPlanStatus;
  readonly notBefore: string;
  readonly attempts: number;
  readonly claimedBy: string | null;
  readonly claimToken: string | null;
  readonly leaseExpiresAt: string | null;
  readonly externalEffectAttempted: boolean;
  readonly externalEffectStartedAt: string | null;
  readonly lastReasonCode: string | null;
  readonly lastDetail: string | null;
  readonly createdAt: string;
  readonly terminatedAt: string | null;
}

const PLAN_COLUMNS = `id, prospect_id as "prospectId", channel, kind,
        trigger_inbound_message_id as "triggerInboundMessageId",
        trigger_manifest_id as "triggerManifestId",
        idempotency_key as "idempotencyKey", actor_kind as "actorKind",
        policy_version as "policyVersion",
        commercial_policy_version as "commercialPolicyVersion",
        brain_version as "brainVersion",
        decision, decision_gate as "decisionGate", decision_reason as "decisionReason",
        decision_detail as "decisionDetail",
        conversation_watermark as "conversationWatermark",
        body, body_sha256 as "bodySha256", naturalness_verdict as "naturalnessVerdict",
        grounding_gaps as "groundingGaps", offer_readiness as "offerReadiness",
        call_readiness as "callReadiness", status, not_before as "notBefore", attempts,
        claimed_by as "claimedBy", claim_token as "claimToken",
        lease_expires_at as "leaseExpiresAt",
        external_effect_attempted as "externalEffectAttempted",
        external_effect_started_at as "externalEffectStartedAt",
        last_reason_code as "lastReasonCode", last_detail as "lastDetail",
        created_at as "createdAt", terminated_at as "terminatedAt"`;

// ---------------------------------------------------------------------------
// HERMES-CONVERSATION-SKIPPED-RECLAIM-R1 — la RÉCLAMATION, dite une seule fois
// ---------------------------------------------------------------------------

/**
 * Pourquoi un plan ne peut pas être repris. Aucun de ces codes n'autorise quoi
 * que ce soit : ils NOMMENT un refus.
 */
export type PlanReclaimRefusal =
  /** Un effet a été tenté. §8 : jamais rejoué, quoi que dise le statut. */
  | 'PLAN_EFFECT_ATTEMPTED'
  /** Le statut est absorbant — `SENT`, `AMBIGUOUS`, `BLOCKED`, `FAILED`… */
  | 'PLAN_TERMINAL'
  /** La décision n'autorise aucun effet, et ne le fera pas sur ce plan-ci. */
  | 'PLAN_DECISION_NOT_ACTIONABLE'
  /** Un worker tient le bail. Ce n'est pas à nous de le lui prendre. */
  | 'PLAN_LEASED'
  /** La borne de réclamation n'est pas atteinte — ou est illisible. */
  | 'PLAN_NOT_DUE';

/**
 * Les trois issues, et la seule qui ouvre quelque chose.
 *
 *   * `RECLAIMABLE` — le plan peut être PROPOSÉ à l'exécution maintenant. Ce
 *     n'est pas « il peut partir » : toutes les portes du crochet pré-effet
 *     restent devant, et elles sont relues deux fois ;
 *   * `PENDING` — il le deviendra tout seul (borne non atteinte, bail d'un
 *     autre worker). Attendre est la bonne conduite, forcer ne l'est pas ;
 *   * `TERMINAL` — jamais. Rien ne le fera changer d'avis.
 */
export type PlanReclaimClass = 'RECLAIMABLE' | 'PENDING' | 'TERMINAL';

export type PlanReclaimVerdict =
  | { readonly reclaimable: true; readonly class: 'RECLAIMABLE'; readonly detail: string }
  | {
      readonly reclaimable: false;
      readonly class: Exclude<PlanReclaimClass, 'RECLAIMABLE'>;
      readonly refusal: PlanReclaimRefusal;
      readonly detail: string;
    };

/**
 * Un plan déjà inscrit peut-il être REPROPOSÉ à l'exécution ?
 *
 * ---------------------------------------------------------------------------
 * Le défaut qu'elle répare
 * ---------------------------------------------------------------------------
 * `SKIPPED` est, depuis §26, le statut d'un report : aucun effet n'a eu lieu,
 * la cause peut cesser d'elle-même, et `claimConversationPlan` sait déjà le
 * reprendre une fois `not_before` atteint. Les APPELANTS, eux, ne le savaient
 * pas : le runner du test contrôlé exigeait `status === 'PLANNED'`, si bien
 * qu'un profil navigateur occupé — une contention normale, sans le moindre
 * effet — condamnait le tour pour toujours alors que la base le rendait
 * réclamable trois minutes plus tard.
 *
 * Cette fonction est cette lecture-là, écrite UNE fois. Elle est PURE : pas de
 * requête, pas d'horloge implicite, aucune décision métier. Elle ne relit ni
 * l'arrêt global, ni les plafonds, ni la fenêtre, ni la fraîcheur, ni
 * l'identité — ce sont les portes du crochet pré-effet, elles restent
 * intégralement devant, et un plan `RECLAIMABLE` peut parfaitement être refusé
 * une seconde plus tard.
 *
 * ---------------------------------------------------------------------------
 * L'ordre des refus, et pourquoi il est celui-là
 * ---------------------------------------------------------------------------
 * Le plus absorbant d'abord. `external_effect_attempted` précède le statut :
 * un plan qui a touché le monde ne se rejoue pas, même si un statut mal écrit
 * prétendait le contraire. Et la borne vient en DERNIER : « pas encore dû » est
 * un état d'attente, il ne doit jamais masquer un refus définitif.
 */
/**
 * L'instant d'une valeur temporelle, sans perte.
 *
 * `Date.parse` reçoit une chaîne : une `Date` y arrive donc par `toString()`,
 * qui écrit « Sun Aug 23 2026 09:36:19 GMT+0200 » — sans millisecondes. Les
 * colonnes `timestamptz` remontent en `Date` depuis le pilote, et rien ne
 * garantit qu'un appelant les a normalisées.
 *
 * HERMES-END-TO-END-CERTIFICATION-R1 — il vit ICI plutôt que dans
 * `preEffect.ts`, et il est exporté. `preEffect` importe déjà de ce module ;
 * l'inverse ferait un cycle. Deux copies de cette fonction seraient exactement
 * le défaut qu'elle existe pour réparer — et la seconde copie serait, comme
 * toujours, celle qu'on oublierait de corriger.
 */
export function instant(value: string | Date): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

export function assessPlanReclaim(
  plan: Pick<
    ConversationPlan,
    'status' | 'decision' | 'externalEffectAttempted' | 'notBefore' | 'lastReasonCode'
  >,
  now: Date,
): PlanReclaimVerdict {
  if (plan.externalEffectAttempted) {
    return {
      reclaimable: false,
      class: 'TERMINAL',
      refusal: 'PLAN_EFFECT_ATTEMPTED',
      detail: 'un effet a été tenté sur ce plan — §8 : il n’est jamais rejoué',
    };
  }
  if (TERMINAL_PLAN_STATUSES.includes(plan.status)) {
    return {
      reclaimable: false,
      class: 'TERMINAL',
      refusal: 'PLAN_TERMINAL',
      detail: `le plan est ${plan.status} — un statut absorbant ne repart pas`,
    };
  }
  if (!ACTIONABLE_PLAN_DECISIONS.includes(plan.decision)) {
    return {
      reclaimable: false,
      class: 'TERMINAL',
      refusal: 'PLAN_DECISION_NOT_ACTIONABLE',
      detail: `la décision ${plan.decision} n’autorise aucun effet`,
    };
  }
  if (!CLAIMABLE_PLAN_STATUSES.includes(plan.status)) {
    return {
      reclaimable: false,
      class: 'PENDING',
      refusal: 'PLAN_LEASED',
      detail: `le plan est ${plan.status} — un worker le tient, la reprise de bail en décidera`,
    };
  }
  // HERMES-END-TO-END-CERTIFICATION-R1 — la milliseconde, encore elle.
  //
  // `notBefore` est DÉCLARÉ `string` (§`ConversationPlan`) et arrive `Date` :
  // `PLAN_COLUMNS` sélectionne `not_before` sans transformation, et le pilote
  // Postgres ne convertit que les OID 1700 et 20 (`db/postgres.ts`) — un
  // `timestamptz` reste un objet `Date`. `Date.parse` d'une `Date` passe par
  // `toString()`, qui n'a pas de millisecondes : `…19.900` devient `…19.000`.
  //
  // C'est mot pour mot le défaut de HERMES-PLAN-STALE-TRIGGER-FIX-R1, réapparu
  // dans la fonction écrite au round suivant. `preEffect.ts` porte déjà
  // `instant()` pour cette raison exacte ; il est partagé plutôt que recopié,
  // parce que deux lectures voisines de la même question finissent toujours par
  // diverger.
  //
  // La troncature arrondit vers le BAS : un plan se déclarait réclamable
  // jusqu'à 999 ms trop tôt, et `claimConversationPlan` — dont le SQL compare à
  // pleine précision — ne rendait alors aucune ligne. Le runner annonçait un
  // plan dû et n'obtenait rien. Aucun envoi n'était ouvert ; c'est le
  // diagnostic qui mentait, et une borne affichée sans ses millisecondes avec.
  const notBefore = instant(plan.notBefore);
  if (!Number.isFinite(notBefore)) {
    // Fail-closed : une borne illisible n'est pas une borne atteinte.
    return {
      reclaimable: false,
      class: 'PENDING',
      refusal: 'PLAN_NOT_DUE',
      detail: `borne de réclamation illisible (${plan.notBefore})`,
    };
  }
  if (now.getTime() < notBefore) {
    return {
      reclaimable: false,
      class: 'PENDING',
      refusal: 'PLAN_NOT_DUE',
      detail: `pas avant ${new Date(notBefore).toISOString()}`,
    };
  }
  return {
    reclaimable: true,
    class: 'RECLAIMABLE',
    detail:
      plan.status === 'SKIPPED'
        ? `report ${plan.lastReasonCode ?? 'sans motif'} échu — aucun effet n’a été tenté, ` +
          'toutes les portes restent devant'
        : 'plan neuf et dû — toutes les portes restent devant',
  };
}

export class ConversationPlanError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ConversationPlanError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Idempotence
// ---------------------------------------------------------------------------

/**
 * La clé d'idempotence d'une intention conversationnelle.
 *
 * Déterministe et SANS HORLOGE : le même déclencheur donne la même clé dans dix
 * ans, sur une autre machine, après n'importe quel redémarrage. C'est ce qui
 * permet à l'index unique de vouloir dire quelque chose — une clé qui
 * contiendrait un horodatage ou un UUID rendrait l'unicité vraie et inutile.
 *
 * Le déclencheur est l'identifiant du message entrant pour une réponse, et
 * celui du manifeste pour une relance.
 *
 * ---------------------------------------------------------------------------
 * `understandingRef` — HERMES-CONTEXTUAL-REPLY-CLASSIFICATION-R1
 * ---------------------------------------------------------------------------
 * Ce fichier disait « une réponse à un message donné ne peut exister qu'une
 * fois ». C'est une phrase de trop, et elle a coûté quelque chose de réel : le
 * 22 août 2026, un tour a été escaladé en `HUMAN_ESCALATION:unclassifiable`
 * parce que la taxonomie n'avait pas d'étiquette pour ce que le prospect
 * disait. La taxonomie a été corrigée, le message reclassé — et le plan est
 * resté `BLOCKED`, sans aucun moyen d'en écrire un neuf : `on conflict do
 * nothing` rendait silencieusement l'intention périmée.
 *
 * Une intention n'est pas fonction du message seul, elle est fonction du
 * message ET de ce que le système en a compris. L'identifiant de l'analyse D2
 * ACTIVE est donc joint à la clé. Déterministe et SANS HORLOGE, comme le reste :
 * la même analyse rend la même clé dans dix ans. Tant qu'une compréhension ne
 * change pas, rejouer le calcul retombe exactement sur le plan existant.
 *
 * Ce que cela n'ouvre PAS — et c'est la partie qui compte : une reclassification
 * ne peut pas produire un SECOND envoi. `recordConversationPlan` refuse
 * d'inscrire quoi que ce soit sur un déclencheur qui porte déjà un effet tenté,
 * et rend le plan existant tel quel. C'est une garde de code, explicite et
 * testée, là où la collision de clé était une garde de hasard qui ne disait
 * rien à personne.
 *
 * ---------------------------------------------------------------------------
 * `policyRef` — HERMES-CONTACT-PURPOSE-R1
 * ---------------------------------------------------------------------------
 * Le même raisonnement, poussé d'un cran. Une intention n'est pas fonction du
 * message seul (d'où `understandingRef`) ; elle n'est pas non plus fonction du
 * message et de sa compréhension seuls. Elle est fonction des RÈGLES sous
 * lesquelles elle a été rendue.
 *
 * Le 23 août 2026, un tour a été refusé en `HUMAN_ESCALATION:topic_not_covered`
 * sous `hermes-conversation-r5`. Le refus était exact à cette date. La politique
 * a changé ensuite — le motif de contact est devenu une vérité du dépôt — et
 * sans ce composant, la seule façon de rejuger ce tour aurait été de reclasser
 * un message que personne n'a mal compris, c'est-à-dire de fabriquer une
 * analyse pour contourner une clé.
 *
 * Ce que cela n'ouvre PAS, et c'est encore la partie qui compte : un changement
 * de politique ne peut pas produire un SECOND envoi. La garde de
 * `recordConversationPlan` refuse d'inscrire quoi que ce soit sur un déclencheur
 * qui porte déjà un effet TENTÉ — `AMBIGUOUS` compris — quelle que soit la clé.
 * Une version neuve rouvre le droit de DÉCIDER, jamais celui d'agir deux fois.
 *
 * Le plan d'hier n'est ni réécrit ni effacé : il garde son texte, son motif et
 * sa version, et c'est ce qui rend l'historique relisible.
 */
export function deriveConversationPlanKey(
  kind: ConversationPlanKind,
  prospectId: string,
  triggerRef: string,
  understandingRef: string | null = null,
  policyRef: string | null = null,
): string {
  const base = `hermes-conv-r2/${kind}/${prospectId}/${triggerRef}`;
  const understood = understandingRef === null ? base : `${base}#${understandingRef}`;
  return policyRef === null ? understood : `${understood}@${policyRef}`;
}

/**
 * §22 — le délai humain avant une réponse automatique.
 *
 * Déterministe : dérivé de la clé du plan par le MÊME hachage que l'étalement
 * de l'ordonnanceur (`stableHash32`). La même conversation obtient toujours la
 * même attente, ce qui rend le délai OBSERVABLE — un opérateur peut recalculer
 * ce que le worker fera — et compatible avec l'idempotence : reprendre un plan
 * après un redémarrage ne le décale pas.
 *
 * Ce n'est pas une imitation d'humain ni une dissimulation. C'est le refus d'un
 * comportement que rien ne justifie : répondre en deux cents millisecondes à
 * quelqu'un qui vient d'écrire ne rend service à personne, et le seul message
 * que cela transmet est « une machine vous répond ».
 */
export function conversationReplyDelayMs(
  idempotencyKey: string,
  config: ConversationPolicyConfig,
): number {
  const { minDelayMs, maxDelayMs } = config.reply;
  const span = maxDelayMs - minDelayMs;
  if (span <= 0) return minDelayMs;
  return minDelayMs + (stableHash32(idempotencyKey) % span);
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Écriture
// ---------------------------------------------------------------------------

export interface RecordPlanInput {
  readonly prospectId: string;
  readonly channel: 'instagram_dm' | 'email';
  readonly kind: ConversationPlanKind;
  /** Exactement un des deux, selon le genre. */
  readonly triggerInboundMessageId?: string | null;
  readonly triggerManifestId?: string | null;
  /**
   * Ce que le système a COMPRIS du déclencheur — en pratique l'identifiant de
   * l'analyse D2 vivante. Absent = clé historique, à l'octet près.
   */
  readonly understandingRef?: string | null;
  /**
   * Les RÈGLES sous lesquelles la décision a été rendue — en pratique
   * `CONVERSATION_POLICY_VERSION`. Absent = clé historique, à l'octet près.
   *
   * Redondant avec `policyVersion` ci-dessous, et volontairement : la colonne
   * dit sous quoi le plan a été jugé, la clé décide s'il s'agit du MÊME plan.
   * Les confondre en un seul champ ferait dépendre l'unicité d'une valeur qu'on
   * pourrait vouloir corriger dans un rapport, et l'inverse — un appelant qui
   * ne passe rien garde exactement le comportement d'avant.
   */
  readonly policyRef?: string | null;
  readonly policyVersion: string;
  readonly commercialPolicyVersion: string;
  readonly brainVersion: string;
  readonly decision: ConversationPlanDecision;
  readonly decisionGate: string;
  readonly decisionReason: string | null;
  readonly decisionDetail: string | null;
  /** L'heure de réception du plus récent entrant connu au calcul. */
  readonly conversationWatermark: string | null;
  readonly body: string | null;
  readonly naturalnessVerdict: NaturalnessVerdict | null;
  readonly groundingGaps: readonly GroundingGap[];
  readonly offerReadiness: OfferReadiness;
  readonly callReadiness: CallReadiness;
  readonly notBefore: Date;
}

export interface RecordPlanResult {
  readonly plan: ConversationPlan;
  /** `false` quand le plan existait déjà : le même déclencheur n'en crée pas deux. */
  readonly created: boolean;
  /** Les plans vivants que celui-ci a remplacés. Vide au premier tour. */
  readonly superseded: readonly string[];
}

/**
 * Inscrit une intention — et referme celles qu'elle remplace, dans la même
 * transaction.
 *
 * L'ordre à l'intérieur de la transaction est le sujet : SUPERSEDER d'abord,
 * INSÉRER ensuite. L'inverse buterait sur l'index partiel unique, et il faudrait
 * alors décider quoi faire de l'échec — c'est-à-dire écrire à la main la logique
 * que l'index tient déjà.
 *
 * Un plan dont la décision n'autorise aucun effet (`HUMAN_ESCALATION`,
 * `TERMINAL_STOP`, `*_SKIP`, `*_STOP`) est inscrit CLOS : il documente une
 * décision, il n'attend rien. Seuls `AUTO_REPLY_ELIGIBLE`, `FOLLOW_UP_DUE` et
 * `FOLLOW_UP_SCHEDULED` restent vivants.
 */
export async function recordConversationPlan(
  sql: Sql,
  input: RecordPlanInput,
): Promise<RecordPlanResult> {
  const triggerRef = input.triggerInboundMessageId ?? input.triggerManifestId ?? null;
  if (triggerRef === null) {
    throw new ConversationPlanError(
      'PLAN_NO_TRIGGER',
      'une intention conversationnelle part d’un message reçu ou d’un manifeste — jamais de rien',
    );
  }

  const idempotencyKey = deriveConversationPlanKey(
    input.kind,
    input.prospectId,
    triggerRef,
    input.understandingRef ?? null,
    input.policyRef ?? null,
  );
  const live = planStaysLive(input.decision);
  const status: ConversationPlanStatus = live ? 'PLANNED' : closedStatusFor(input.decision);
  const body = input.body?.trim() ?? null;

  const triggerColumn =
    input.triggerInboundMessageId != null ? 'trigger_inbound_message_id' : 'trigger_manifest_id';

  return sql.transaction(async (tx) => {
    // ---- LA garde anti-double-effet, avant toute écriture -------------------
    //
    // Un déclencheur qui porte déjà un effet TENTÉ est clos, définitivement.
    // Aucune reclassification, aucune politique neuve, aucun changement de clé
    // ne peut produire un second message vers la même personne à propos du
    // même message reçu — `AMBIGUOUS` compris, parce qu'« on ne sait pas si
    // c'est arrivé » n'autorise pas à recommencer pour voir.
    //
    // Elle vit ICI plutôt que dans un appelant : la clé d'idempotence porte
    // désormais la compréhension du déclencheur (`understandingRef`), donc
    // elle ne peut plus, à elle seule, jouer ce rôle. Rendre le plan existant
    // plutôt que lever laisse les appelants inchangés — ils lisent déjà
    // `status`/`decision`, et un plan qui a agi n'est ni `PLANNED` ni
    // `AUTO_REPLY_ELIGIBLE`.
    const effected = await tx.query<ConversationPlan>(
      `select ${PLAN_COLUMNS} from hermes_conversation_plans
        where prospect_id = $1
          and kind = $2
          and ${triggerColumn} = $3
          and external_effect_attempted = true
        order by created_at desc
        limit 1`,
      [input.prospectId, input.kind, triggerRef],
    );
    const alreadyEffected = effected[0];
    if (alreadyEffected !== undefined) {
      return { plan: alreadyEffected, created: false, superseded: Object.freeze([]) };
    }

    // Les plans VIVANTS du même prospect et du même genre, sauf celui qu'on
    // s'apprête à écrire s'il existe déjà. C'est §24 : un nouveau message rend
    // le brouillon précédent périmé, et un brouillon périmé ne part pas.
    const supersededRows = await tx.query<{ id: string }>(
      `update hermes_conversation_plans
          set status = 'SUPERSEDED',
              last_reason_code = 'PLAN_SUPERSEDED',
              last_detail = $4,
              claim_token = null, claimed_by = null, claimed_at = null, lease_expires_at = null,
              terminated_at = now(), updated_at = now()
        where prospect_id = $1
          and kind = $2
          and idempotency_key <> $3
          and status = any($5::text[])
          and external_effect_attempted = false
        returning id`,
      [
        input.prospectId,
        input.kind,
        idempotencyKey,
        `remplacée par ${idempotencyKey}`,
        [...LIVE_PLAN_STATUSES],
      ],
    );

    const inserted = await tx.query<ConversationPlan>(
      `insert into hermes_conversation_plans
         (prospect_id, channel, kind, trigger_inbound_message_id, trigger_manifest_id,
          idempotency_key, policy_version, commercial_policy_version, brain_version,
          decision, decision_gate,
          decision_reason, decision_detail, conversation_watermark, body, body_sha256,
          naturalness_verdict, grounding_gaps, offer_readiness, call_readiness,
          status, not_before, terminated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$23,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
               -- Une intention CLOSE porte sa date de cloture des l'insertion :
               -- la contrainte hermes_plan_terminated_when_closed l'exige, et
               -- une decision qui n'attend rien est close a la seconde ou elle
               -- est ecrite.
               case when $20 = any($22::text[]) then null else now() end)
       on conflict (idempotency_key) do nothing
       returning ${PLAN_COLUMNS}`,
      [
        input.prospectId,
        input.channel,
        input.kind,
        input.triggerInboundMessageId ?? null,
        input.triggerManifestId ?? null,
        idempotencyKey,
        input.policyVersion,
        input.brainVersion,
        input.decision,
        input.decisionGate,
        input.decisionReason,
        input.decisionDetail,
        input.conversationWatermark,
        body,
        body === null ? null : sha256Hex(body),
        input.naturalnessVerdict,
        [...input.groundingGaps],
        input.offerReadiness,
        input.callReadiness,
        status,
        input.notBefore.toISOString(),
        [...LIVE_PLAN_STATUSES],
        input.commercialPolicyVersion,
      ],
    );

    const created = inserted[0];
    if (created !== undefined) {
      return {
        plan: created,
        created: true,
        superseded: Object.freeze(supersededRows.map((row) => row.id)),
      };
    }

    // `do nothing` a mordu : la même intention existait déjà. On la rend telle
    // quelle — sans la réécrire. Un second calcul ne DOIT pas écraser le
    // premier : si un effet a eu lieu entre-temps, l'écraser effacerait la
    // seule trace qui empêche de le rejouer.
    const existing = await tx.query<ConversationPlan>(
      `select ${PLAN_COLUMNS} from hermes_conversation_plans where idempotency_key = $1`,
      [idempotencyKey],
    );
    const plan = existing[0];
    if (plan === undefined) {
      throw new ConversationPlanError(
        'PLAN_INSERT_LOST',
        `la clé ${idempotencyKey} a été refusée sans qu'aucune ligne ne la porte — état incohérent`,
      );
    }
    return { plan, created: false, superseded: Object.freeze(supersededRows.map((row) => row.id)) };
  });
}

/** Une décision qui attend encore quelque chose reste vivante. */
function planStaysLive(decision: ConversationPlanDecision): boolean {
  return (
    decision === 'AUTO_REPLY_ELIGIBLE' ||
    decision === 'FOLLOW_UP_DUE' ||
    decision === 'FOLLOW_UP_SCHEDULED'
  );
}

/**
 * Le statut d'un plan inscrit CLOS.
 *
 * `CANCELLED` pour ce qui s'arrête définitivement, `BLOCKED` pour ce qu'un
 * humain doit reprendre, `SKIPPED`… non : un plan qui n'a jamais été vivant ne
 * peut pas être « reporté ». Les refus temporaires ne créent pas de plan
 * dormant qui repartirait tout seul — la prochaine évaluation en écrira un
 * neuf, sur des faits neufs. C'est ce qui empêche un plan écrit sous des faits
 * périmés d'agir plus tard.
 */
function closedStatusFor(decision: ConversationPlanDecision): ConversationPlanStatus {
  if (decision === 'HUMAN_ESCALATION') return 'BLOCKED';
  return 'CANCELLED';
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

export async function loadConversationPlan(sql: Sql, planId: string): Promise<ConversationPlan | null> {
  const rows = await sql.query<ConversationPlan>(
    `select ${PLAN_COLUMNS} from hermes_conversation_plans where id = $1`,
    [planId],
  );
  return rows[0] ?? null;
}

export async function loadConversationPlanByKey(
  sql: Sql,
  idempotencyKey: string,
): Promise<ConversationPlan | null> {
  const rows = await sql.query<ConversationPlan>(
    `select ${PLAN_COLUMNS} from hermes_conversation_plans where idempotency_key = $1`,
    [idempotencyKey],
  );
  return rows[0] ?? null;
}

export async function listConversationPlans(
  sql: Sql,
  input: { prospectId?: string; limit?: number } = {},
): Promise<ConversationPlan[]> {
  const limit = Math.min(500, Math.max(1, Math.trunc(input.limit ?? 50)));
  if (input.prospectId !== undefined) {
    return sql.query<ConversationPlan>(
      `select ${PLAN_COLUMNS} from hermes_conversation_plans
        where prospect_id = $1 order by created_at desc limit $2`,
      [input.prospectId, limit],
    );
  }
  return sql.query<ConversationPlan>(
    `select ${PLAN_COLUMNS} from hermes_conversation_plans order by created_at desc limit $1`,
    [limit],
  );
}

// ---------------------------------------------------------------------------
// Prise atomique
// ---------------------------------------------------------------------------

export interface ClaimPlanInput {
  readonly workerId: string;
  readonly leaseMs: number;
  /** Restreint la prise à ce plan précis. Absent : le prochain plan dû. */
  readonly planId?: string;
  /**
   * HERMES-REPLY-DELIVERY-R1 §13 — restreint la prise aux genres qu'un worker
   * sait exécuter. Absent : tous.
   *
   * Un filtre plutôt qu'un refus a posteriori, et la différence n'est pas
   * cosmétique : un worker qui prendrait puis reposerait un plan de relance
   * lui aurait fait consommer une tentative (`attempts + 1`), l'aurait sorti du
   * registre le temps d'un aller-retour, et — en boucle — l'aurait empêché
   * d'être pris par le worker dont c'est le travail.
   */
  readonly kinds?: readonly ConversationPlanKind[];
}

/**
 * Réserve UN plan pour UN worker, ou rien.
 *
 * `for update skip locked` évalué par Postgres DANS la même instruction que
 * l'écriture : deux workers qui interrogent le registre à la microseconde près
 * obtiennent deux plans différents, ou l'un d'eux repart les mains vides.
 * Aucune lecture applicative ne précède, donc aucune fenêtre entre « c'est
 * libre » et « je le prends ».
 *
 * Le `claim_token` est NEUF à chaque prise, et c'est lui — pas l'identité du
 * worker — qu'exige `finalizeConversationPlan` : un worker dont le bail a
 * expiré et dont le plan a été repris ne peut plus écrire le résultat d'un
 * travail qui ne lui appartient plus.
 */
/**
 * HERMES-END-TO-END-CERTIFICATION-R1 — les DEUX refus que `assessPlanReclaim`
 * place en tête, et que ce `where` n'avait pas.
 *
 * Le round de la reprise a écrit UNE lecture de « ce plan repart-il ? » et l'a
 * fait adopter par le runner. Elle n'a pas été adoptée ici : le SQL ne filtrait
 * que le statut et l'heure, donc il était strictement plus permissif que la
 * fonction censée faire autorité. Deux copies, et la plus indulgente tenait la
 * porte.
 *
 * Les deux cas sont atteignables. Un plan dont l'effet a été TENTÉ puis
 * finalisé `SKIPPED` par le rattrapage d'erreur de `replyExecution` redevenait
 * claimable ; et une décision non actionnable — `FOLLOW_UP_SCHEDULED`, que
 * `planStaysLive` garde `PLANNED` — l'était aussi. Le crochet pré-effet
 * refusait ensuite, donc rien ne partait ; le coût était un `attempts + 1` et
 * un bail pris pour rien, sur un plan que la lecture de référence déclarait
 * TERMINAL.
 *
 * `ACTIONABLE_PLAN_DECISIONS` est passé en PARAMÈTRE plutôt que recopié en
 * SQL : une seule liste, celle de ce module, et la recopier aurait reproduit
 * exactement le défaut qu'on referme.
 *
 * L'ordre gagne un troisième terme (`c.id asc`) : à `not_before` et
 * `created_at` égaux — le cas normal sous PGlite, où `now()` ne bouge pas d'une
 * requête à l'autre — la ligne prise était arbitraire.
 */
export async function claimConversationPlan(
  sql: Sql,
  input: ClaimPlanInput,
): Promise<ConversationPlan | null> {
  const rows = await sql.query<ConversationPlan>(
    `update hermes_conversation_plans p
        set status = 'CLAIMED',
            claimed_by = $1,
            claim_token = gen_random_uuid(),
            claimed_at = now(),
            lease_expires_at = now() + ($2::bigint * interval '1 millisecond'),
            attempts = p.attempts + 1,
            updated_at = now()
      where p.id = (
        select c.id from hermes_conversation_plans c
         where c.status = any($3::text[])
           and c.not_before <= now()
           -- Les DEUX refus que assessPlanReclaim place en tete, et que ce
           -- where n'avait pas. Voir le commentaire de claimConversationPlan.
           and c.external_effect_attempted = false
           and c.decision = any($6::text[])
           and ($4::uuid is null or c.id = $4::uuid)
           and ($5::text[] is null or c.kind = any($5::text[]))
         order by c.not_before asc, c.created_at asc, c.id asc
         for update skip locked
         limit 1
      )
      returning ${PLAN_COLUMNS}`,
    [
      input.workerId,
      String(input.leaseMs),
      [...CLAIMABLE_PLAN_STATUSES],
      input.planId ?? null,
      input.kinds === undefined ? null : [...input.kinds],
      [...ACTIONABLE_PLAN_DECISIONS],
    ],
  );
  return rows[0] ?? null;
}

export interface FinalizePlanInput {
  readonly planId: string;
  readonly claimToken: string;
  readonly status: Exclude<ConversationPlanStatus, 'PLANNED' | 'CLAIMED'>;
  readonly reasonCode: string;
  readonly detail: string | null;
  /** Report : la borne de reclamation. Ignorée si le statut est absorbant. */
  readonly notBefore?: Date;
}

/**
 * Clôt le bail et écrit l'issue — si et seulement si le bail est encore celui
 * du worker qui écrit.
 *
 * `false` en retour signifie « ce plan ne t'appartient plus » : bail expiré et
 * repris, ou déjà clos. Le worker ne doit alors RIEN faire d'autre, et surtout
 * pas réessayer.
 */
export async function finalizeConversationPlan(
  sql: Sql,
  input: FinalizePlanInput,
): Promise<boolean> {
  const rows = await sql.query<{ id: string }>(
    `update hermes_conversation_plans
        set status = $3,
            claim_token = null, claimed_by = null, claimed_at = null, lease_expires_at = null,
            last_reason_code = $4,
            last_detail = $5,
            not_before = coalesce($6::timestamptz, not_before),
            terminated_at = case when $3 = any($7::text[]) then now() else null end,
            updated_at = now()
      where id = $1 and claim_token = $2::uuid and status = 'CLAIMED'
      returning id`,
    [
      input.planId,
      input.claimToken,
      input.status,
      input.reasonCode,
      input.detail,
      input.notBefore?.toISOString() ?? null,
      [...TERMINAL_PLAN_STATUSES],
    ],
  );
  return rows.length === 1;
}

// ---------------------------------------------------------------------------
// Reprise et annulation
// ---------------------------------------------------------------------------

export interface RecoveredPlan {
  readonly id: string;
  readonly status: ConversationPlanStatus;
}

/**
 * §26 — reprend les baux abandonnés, et distingue les deux cas qui comptent.
 *
 * Un plan dont le bail a expiré SANS tentative d'effet retourne dans le
 * registre : rien n'a eu lieu, reprendre est gratuit. Un plan dont le bail a
 * expiré APRÈS une tentative devient `AMBIGUOUS`, terminal, et ne sera jamais
 * repris — parce que « on a essayé, on ne sait pas » ne se résout pas en
 * réessayant, mais en regardant.
 */
export async function recoverExpiredConversationLeases(sql: Sql): Promise<RecoveredPlan[]> {
  return sql.query<RecoveredPlan>(
    `update hermes_conversation_plans
        set status = case when external_effect_attempted then 'AMBIGUOUS' else 'PLANNED' end,
            claim_token = null, claimed_by = null, claimed_at = null, lease_expires_at = null,
            last_reason_code = case when external_effect_attempted
                                    then 'PLAN_LEASE_EXPIRED_AFTER_EFFECT'
                                    else 'PLAN_LEASE_EXPIRED' end,
            last_detail = case when external_effect_attempted
                               then 'bail expiré après une tentative d''effet — issue inconnue, jamais rejouée'
                               else 'bail expiré sans aucune tentative — le plan retourne dans le registre' end,
            terminated_at = case when external_effect_attempted then now() else null end,
            updated_at = now()
      where status = 'CLAIMED' and lease_expires_at < now()
      returning id, status`,
  );
}

/**
 * §18 — annule les intentions vivantes d'un prospect.
 *
 * Appelée quand un fait NOUVEAU rend toute intention caduque : une réponse
 * reçue, un opt-out, un changement d'identité, un état devenu terminal. Ne
 * touche jamais un plan qui a déjà tenté un effet — celui-là porte une vérité
 * qu'aucune annulation ne peut défaire.
 */
export async function cancelConversationPlans(
  sql: Sql,
  input: { prospectId: string; reasonCode: string; detail: string; kinds?: readonly ConversationPlanKind[] },
): Promise<string[]> {
  const kinds = input.kinds ?? (['AUTO_REPLY', 'FOLLOW_UP_1', 'FOLLOW_UP_2'] as const);
  const rows = await sql.query<{ id: string }>(
    `update hermes_conversation_plans
        set status = 'CANCELLED',
            claim_token = null, claimed_by = null, claimed_at = null, lease_expires_at = null,
            last_reason_code = $2, last_detail = $3,
            terminated_at = now(), updated_at = now()
      where prospect_id = $1
        and status = any($4::text[])
        and kind = any($5::text[])
        and external_effect_attempted = false
      returning id`,
    [input.prospectId, input.reasonCode, input.detail, [...LIVE_PLAN_STATUSES], [...kinds]],
  );
  return rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------
// §20/§26 — la réservation d'un créneau d'effet, sous le MÊME verrou
// ---------------------------------------------------------------------------

/**
 * La clé du verrou consultatif des effets Instagram.
 *
 * Identique, mot pour mot, à celle de `reserveExternalEffectSlot` : c'est ce
 * qui fait que le premier contact, le test contrôlé, la réponse automatique et
 * la relance se sérialisent entre eux. Deux clés différentes donneraient deux
 * mutex, donc deux workers qui cliquent en même temps sur le même compte.
 */
export const EXTERNAL_EFFECT_LOCK_KEY = 'ig_external_effect_slot';

/**
 * Réserve le créneau, compte les plafonds et inscrit la tentative — dans une
 * seule transaction, sous le verrou du compte émetteur.
 *
 * Le compteur porte sur les TENTATIVES d'effet, pas sur les envois réussis, et
 * il additionne les TROIS sources : jobs de premier contact, tests contrôlés,
 * plans conversationnels. C'est §20 pris au mot — « ne crée pas un quota
 * parallèle » — et c'est la seule façon d'empêcher qu'alterner un premier
 * message et une réponse automatique double le débit réel du compte.
 *
 * La réservation EST l'inscription : il n'y a pas de jeton à libérer, donc rien
 * à fuir. Soit la transaction commite et la tentative est comptée pour
 * toujours, soit elle échoue et rien n'a eu lieu.
 */
export async function reserveConversationEffectSlot(
  sql: Sql,
  config: InstagramRailConfig,
  input: { planId: string; claimToken: string },
): Promise<void> {
  await sql.transaction(async (tx) => {
    await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [EXTERNAL_EFFECT_LOCK_KEY]);

    const counts = await tx.query<{ lastDay: string; lastHour: string; msSince: string | null }>(
      `with attempts as (
         select external_effect_started_at as at from ig_dispatch_jobs where external_effect_attempted = true
         union all
         select external_effect_started_at as at from ig_controlled_tests where external_effect_attempted = true
         union all
         select external_effect_started_at as at from hermes_conversation_plans where external_effect_attempted = true
       )
       select
         (select count(*) from attempts where at > now() - interval '24 hours')::text as "lastDay",
         (select count(*) from attempts where at > now() - interval '1 hour')::text   as "lastHour",
         (select (extract(epoch from (now() - max(at))) * 1000)::bigint from attempts) as "msSince"`,
    );
    const row = counts[0];
    const lastDay = Number(row?.lastDay ?? 0);
    const lastHour = Number(row?.lastHour ?? 0);
    const msSince = row?.msSince === null || row?.msSince === undefined ? null : Number(row.msSince);

    if (lastDay >= config.caps.dailySentCap) {
      throw new ConversationPlanError(
        'IG_CAP_DAILY_SENT',
        `${String(lastDay)} tentative(s) d'effet externe sur 24 h, plafond ${String(config.caps.dailySentCap)} — réservation refusée`,
      );
    }
    if (lastHour >= config.caps.hourlySentCap) {
      throw new ConversationPlanError(
        'IG_CAP_HOURLY_SENT',
        `${String(lastHour)} tentative(s) d'effet externe sur 1 h, plafond ${String(config.caps.hourlySentCap)} — réservation refusée`,
      );
    }
    if (msSince !== null && msSince < config.caps.minSendIntervalMs) {
      throw new ConversationPlanError(
        'IG_CAP_MIN_INTERVAL',
        `dernière tentative d'effet externe il y a ${String(msSince)} ms, intervalle minimal ` +
          `${String(config.caps.minSendIntervalMs)} ms — réservation refusée`,
      );
    }

    const marked = await tx.query<{ id: string }>(
      `update hermes_conversation_plans
          set external_effect_attempted = true,
              external_effect_started_at = now(),
              updated_at = now()
        where id = $1 and claim_token = $2::uuid and status = 'CLAIMED'
          and external_effect_attempted = false
        returning id`,
      [input.planId, input.claimToken],
    );
    if (marked.length !== 1) {
      throw new ConversationPlanError(
        'PLAN_EFFECT_ALREADY_ATTEMPTED',
        `le plan ${input.planId} n'est pas réservable : bail perdu, plan clos, ou tentative déjà inscrite — ` +
          'aucun rejeu aveugle',
      );
    }
  });
}
