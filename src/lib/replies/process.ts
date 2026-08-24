/**
 * R6B-D2 — le traitement d'une réponse, une fois, puis on sort.
 *
 * Pas de démon, pas de boucle de fond : une primitive déterministe se relance,
 * s'observe et se raisonne. Même choix qu'en R6B-D1 pour le poll entrant, et
 * pour la même raison.
 *
 * ---------------------------------------------------------------------------
 * L'ordre des étapes, et pourquoi il est celui-là
 * ---------------------------------------------------------------------------
 *
 *   contexte → classification → analyse persistée → suppression → état
 *   → brouillon → projection CRM → alerte
 *
 * Deux écarts assumés par rapport à l'énoncé de la mission :
 *
 *   * la SUPPRESSION précède la transition d'état. Si le processus meurt entre
 *     les deux, le monde reste dans l'état sûr : l'adresse est exclue, l'état
 *     rattrapera au prochain passage. L'ordre inverse laisserait une fenêtre où
 *     le prospect est marqué supprimé sans que la liste d'exclusion le sache —
 *     c'est-à-dire un état qui affirme une protection qui n'existe pas ;
 *
 *   * le BROUILLON précède l'ALERTE. Une alerte speed-to-lead porte l'état de
 *     la réponse proposée (§9) ; la lever avant d'avoir tenté la rédaction
 *     obligerait soit à mentir sur cet état, soit à réécrire l'alerte après
 *     coup, alors qu'une alerte déjà vue par un humain ne doit pas changer sous
 *     ses yeux.
 *
 * Chaque étape est idempotente en base. Rejouer ce traitement sur les mêmes
 * messages ne produit ni seconde analyse, ni second brouillon, ni seconde
 * transition, ni seconde alerte, ni second contact CRM.
 */

import {
  conversationShadowEnabled,
  observeConversationShadow,
  type ShadowObservation,
} from '@/lib/conversation/shadow';
import { burstContaining, closesBurst } from '@/lib/conversation/burst';
import { loadConversationThread, precedingTurnsDigest } from '@/lib/conversation/thread';
import { logger } from '@/lib/logging/logger';
import type { ModelRouter } from '@/lib/models/router';
import type { Sql } from '@/lib/db/sql';
import { AbsorbedIntoBurst, recordBurstAbsorption } from '@/lib/replies/burstAbsorption';
import { loadActiveAnalysis, persistAnalysis, type StoredAnalysis } from '@/lib/replies/analyses';
import { markNoAlertProvider, raiseAlert, shouldAlert, type AlertBody } from '@/lib/replies/alerts';
import { ClassificationFailure, REPLY_CLASSIFIER_PROMPT_VERSION } from '@/lib/replies/classifier';
import { runConversationTurn, type ConversationTurnResult } from '@/lib/conversation/turn';
import { hashReplyContext, loadReplyContext } from '@/lib/replies/context';
import { resolveCrmDestination } from '@/lib/crm/resolve';
import type { CrmResolution } from '@/lib/crm/types';
import { projectToCrm, type CrmProjectionStatus } from '@/lib/replies/crm';
import {
  DraftFailure,
  isDraftEligible,
  loadDraftForAnalysisVersion,
  persistDraft,
} from '@/lib/replies/draft';
import {
  buildConversationReply,
  conversationPromptVersionFor,
} from '@/lib/conversation/brain';
import { draftChannelOf } from '@/lib/replies/draft';
import {
  acknowledgeReply,
  applyTransition,
  ensureContacted,
  noteReplyConsidered,
  suppressOutbound,
} from '@/lib/replies/state';
import {
  CATEGORY_POLICY,
  allowsExternalWrite,
  intentTransitionTarget,
  type OutreachState,
  type ReplyCategory,
} from '@/lib/replies/taxonomy';

export interface ProcessDeps {
  /**
   * Résolution CRM, injectée. Jamais construite silencieusement dans une boucle
   * de traitement : un test qui oublierait de la fournir prendrait la vraie
   * résolution — qui, aujourd'hui, ne mène nulle part, mais qui pourrait mener
   * quelque part demain.
   */
  readonly crm?: CrmResolution;
  /** Un canal de livraison d'alerte. Aucun n'existe : `false` est la vérité du jour. */
  readonly alertProviderConfigured?: boolean;
  /**
   * CONVERSATION-R1.1 — le cerveau conversationnel tourne-t-il en ombre ?
   *
   * Injecté plutôt que lu ici, pour la même raison que `crm` : un test qui
   * l'oublierait prendrait la valeur réelle du drapeau d'environnement, qui est
   * `false`. Non fourni, la valeur vient de `OUTBOUND_CONVERSATION_SHADOW_ENABLED`
   * — absent, donc désactivé. À `false`, le module d'ombre n'est pas appelé du
   * tout : le comportement n'est pas « équivalent » à celui d'avant, il est
   * identique, parce qu'aucune ligne supplémentaire ne s'exécute.
   */
  readonly conversationShadow?: boolean;
}

export interface ProcessedReply {
  readonly inboundMessageId: string;
  readonly prospectId: string;
  readonly manifestId: string;
  readonly company: string;
  readonly correlationStatus: string;
  readonly classification: ReplyCategory;
  readonly confidence: number;
  readonly analysisId: string;
  readonly analysisCreated: boolean;
  readonly stateFrom: OutreachState | null;
  readonly stateTo: OutreachState | null;
  readonly stateApplied: boolean;
  /**
   * L'accusé de réponse a-t-il inscrit `CONTACTED → REPLIED` sur CE passage ?
   *
   * Faux au second passage sur le même message, et ce n'est pas une anomalie :
   * l'état est déjà au-delà, il n'y a plus rien à apprendre.
   */
  readonly replyAcknowledged: boolean;
  /**
   * HERMES-REPLY-ORDERING-R1 — cette réponse est-elle arrivée APRÈS COUP ?
   *
   * Vrai quand une réponse plus récente avait déjà décidé de l'état, et que
   * l'effet de celle-ci a donc été ignoré. Ce n'est pas un échec : l'analyse
   * est écrite, le message est conservé, le Learning Loop la voit. Seul son
   * pouvoir sur l'état COURANT lui est retiré.
   */
  readonly staleReplyIgnored: boolean;
  readonly suppressed: boolean;
  readonly draftId: string | null;
  readonly draftCreated: boolean;
  readonly draftFailure: string | null;
  readonly crmStatus: CrmProjectionStatus | null;
  readonly crmDetail: string | null;
  readonly alertId: string | null;
  readonly alertCreated: boolean;
  /**
   * L'observation du cerveau conversationnel, quand l'ombre est allumée.
   *
   * `null` est le défaut et ne signale aucune anomalie : c'est ce que rend un
   * traitement où l'ombre est éteinte. Rien dans cette valeur n'a d'effet sur
   * les champs précédents — elle est produite APRÈS eux et n'est lue par aucun
   * d'eux.
   */
  readonly conversationShadow: ShadowObservation | null;
}

export interface SkippedReply {
  readonly inboundMessageId: string;
  readonly reason: string;
}

export interface FailedReply {
  readonly inboundMessageId: string;
  readonly stage: 'context' | 'classification' | 'persistence';
  readonly reason: string;
}

/**
 * HERMES-MULTI-TURN-BURSTS-R1 — une bulle lue à l'intérieur d'un tour logique.
 *
 * Ni un échec, ni un refus : le texte de cette bulle EST entré dans le
 * raisonnement du tour qui la clôt. Elle est nommée à part pour qu'un
 * opérateur regardant défiler la relève puisse distinguer « rien n'est arrivé »
 * de « plusieurs bulles ont formé une seule phrase ».
 */
export interface AbsorbedReply {
  readonly inboundMessageId: string;
  readonly burstClosingMessageId: string;
  readonly burstMessageCount: number;
}

export interface ProcessReport {
  readonly candidates: number;
  readonly processed: readonly ProcessedReply[];
  readonly skipped: readonly SkippedReply[];
  readonly failures: readonly FailedReply[];
  /** Les bulles intermédiaires d'une prise de parole, lues dans le tour qui les clôt. */
  readonly absorbed: readonly AbsorbedReply[];
  readonly classified: number;
  readonly drafted: number;
  /** Combien de prospects sont passés de `CONTACTED` à `REPLIED` sur ce passage. */
  readonly repliesAcknowledged: number;
  /**
   * Combien de réponses ont été analysées puis écartées de l'état courant parce
   * qu'une réponse plus récente avait déjà tranché. Zéro est le cas normal d'un
   * flux traité dans l'ordre ; un chiffre non nul décrit un rattrapage de
   * backlog, pas une anomalie.
   */
  readonly staleRepliesIgnored: number;
  /** Écritures réellement parties vers un CRM EXTERNE. Zéro est le défaut. */
  readonly crmWrites: number;
  /**
   * Réponses dont le dossier commercial est tenu localement, sans copie
   * externe. C'est le régime normal (CRM1) — pas un compteur d'échecs.
   */
  readonly localCrmRecords: number;
  readonly alertsRaised: number;
  /**
   * Une destination CRM EXTERNE est-elle configurée ? Faux par défaut, et ce
   * n'est pas une anomalie : le CRM canonique est local (`/crm`).
   */
  readonly externalCrmConfigured: boolean;
  readonly crmDetail: string;
  readonly alertProviderConfigured: boolean;
  /** L'ombre conversationnelle tournait-elle ? Faux par défaut. */
  readonly conversationShadowEnabled: boolean;
  /** Combien de réponses ont produit une comparaison complète. */
  readonly conversationShadowObserved: number;
}

/**
 * Les réponses corrélées qu'aucune analyse vivante ne couvre encore.
 *
 * `REVIEW_REQUIRED` et `UNMATCHED` en sont exclus par la clause `where` :
 * §14 interdit toute action commerciale sur une corrélation faible, et la façon
 * la plus sûre de tenir cette interdiction est de ne jamais les charger.
 */
export async function loadUnprocessedCorrelatedInbound(sql: Sql, limit = 50): Promise<string[]> {
  const bounded = Math.min(500, Math.max(1, Math.trunc(limit)));
  const rows = await sql.query<{ id: string }>(
    `select i.id
       from r6b_inbound_messages i
      where i.correlation_status in ('EXACT','HIGH_CONFIDENCE')
        and not exists (
          select 1 from r6b_reply_analyses a
           where a.inbound_message_id = i.id and a.status = 'ACTIVE')
        -- HERMES-MULTI-TURN-BURSTS-R1 — une bulle absorbée n'a pas d'analyse et
        -- n'en aura jamais : son texte a été lu dans le tour qui la clôt. Sans
        -- cette exclusion elle reviendrait à chaque passage, et au bout de
        -- cinquante les plus ANCIENNES rempliraient la fenêtre (order by
        -- received_at asc limit) et affameraient les messages neufs.
        and not exists (
          select 1 from r6b_inbound_burst_absorptions b
           where b.inbound_message_id = i.id)
      order by i.received_at asc
      limit $1`,
    [bounded],
  );
  return rows.map((row) => row.id);
}

/** Les réponses corrélées dont l'analyse existe déjà — pour reprendre un aval incomplet. */
export async function loadAnalyzedCorrelatedInbound(sql: Sql, limit = 50): Promise<string[]> {
  const bounded = Math.min(500, Math.max(1, Math.trunc(limit)));
  const rows = await sql.query<{ id: string }>(
    `select i.id
       from r6b_inbound_messages i
       join r6b_reply_analyses a on a.inbound_message_id = i.id and a.status = 'ACTIVE'
      where i.correlation_status in ('EXACT','HIGH_CONFIDENCE')
      order by i.received_at asc
      limit $1`,
    [bounded],
  );
  return rows.map((row) => row.id);
}

/**
 * Traite une réponse.
 *
 * Ne classe PAS une seconde fois quand l'analyse vivante répond déjà à la même
 * question (même prompt, même modèle, même contexte) : l'aval est simplement
 * repris là où il s'était arrêté. C'est ce qui rend une reprise après un échec
 * de CRM ou de rédaction gratuite, sans reclasser ni dupliquer.
 */
export async function processReply(
  sql: Sql,
  router: ModelRouter,
  inboundMessageId: string,
  deps: ProcessDeps = {},
): Promise<ProcessedReply> {
  const context = await loadReplyContext(sql, inboundMessageId);
  if (context === null) {
    throw new UnprocessableReply(inboundMessageId, 'message inexistant ou corrélation non exploitable');
  }

  const crm = deps.crm ?? (await resolveCrmDestination(sql));
  const alertProviderConfigured = deps.alertProviderConfigured ?? false;

  // 0. L'amorce : un prospect réellement contacté doit avoir un état, même si
  //    son envoi précède l'existence de cette table.
  const seeded = await ensureContacted(sql, context.prospect.id, context.outreachEventId);
  // L'état d'AVANT cette réponse, sans requête supplémentaire : ou bien l'amorce
  // vient de l'écrire (`CONTACTED`), ou bien c'est celui que le contexte a lu.
  // Il sert à une seule chose, et il faut le tenir : décider si l'intention a le
  // droit de faire REDESCENDRE le prospect vers `REPLIED`.
  const stateBeforeReply: OutreachState | null = seeded !== null ? 'CONTACTED' : context.currentState;

  // 1. Classification — réutilisée si elle répond déjà à la même question.
  const existing = await loadActiveAnalysis(sql, inboundMessageId);
  // HERMES-CONTEXTUAL-REPLY-CLASSIFICATION-R1 — le fil est chargé AVANT la
  // classification, et non plus seulement pour le rédacteur. Le classifieur
  // avait besoin de la même chose que lui : le tour que nous venons d'écrire.
  // Un seul chargement pour les deux, comme `renderContextBlock` est un seul
  // rendu pour les deux — deux lectures du même fil finiraient par diverger.
  const thread = await loadConversationThread(sql, context);

  // HERMES-MULTI-TURN-BURSTS-R1 — une prise de parole, UN raisonnement.
  //
  // Quand plusieurs bulles forment une seule phrase, seule la DERNIÈRE est
  // raisonnée : son tour logique porte le texte de toutes celles qui la
  // précèdent dans la même salve (`currentUtterance`). Les bulles
  // intermédiaires sont ABSORBÉES — lues à l'intérieur de ce tour, jamais
  // classées séparément.
  //
  // C'est ce qui tient le budget d'appels : quatre bulles reçues entre deux
  // relèves coûtaient QUATRE appels de modèle et quatre analyses, dont trois
  // périmées avant d'être écrites — chacune ne décrivant qu'un fragment de
  // phrase. Elles en coûtent une.
  //
  // Rien n'est perdu et rien n'est deviné : le texte absorbé entre dans le
  // raisonnement, la ligne `r6b_inbound_messages` est intacte, et l'absorption
  // est inscrite pour être relue. La demande d'ARRÊT en particulier ne peut pas
  // se perdre — `detectUnsubscribeDemand` reçoit le tour logique entier, donc
  // « laisse tomber » puis « me recontacte pas » est lu comme une seule
  // volonté, sur la bulle qui clôt.
  //
  // Le découpage est du CODE, déterministe : silence, notre propre message
  // exposé, nombre de bulles, nombre de caractères. Aucun modèle n'est appelé
  // pour décider si deux bulles appartiennent à la même phrase.
  const burst = burstContaining(thread.turns, inboundMessageId);
  if (burst !== null && !closesBurst(burst, inboundMessageId)) {
    await recordBurstAbsorption(sql, {
      inboundMessageId,
      burstClosingMessageId: burst.lastSourceId,
      prospectId: context.prospect.id,
      burstMessageCount: burst.messageIds.length,
    });
    throw new AbsorbedIntoBurst(inboundMessageId, burst.lastSourceId, burst.messageIds.length);
  }

  const contextHash = hashReplyContext(
    context,
    REPLY_CLASSIFIER_PROMPT_VERSION,
    precedingTurnsDigest(thread),
  );

  let analysis: StoredAnalysis;
  let analysisCreated = false;
  // HERMES-SEMANTIC-GROUNDING-R1 — UN tour, UN appel.
  //
  // La lecture et la rédaction sortent désormais du MÊME raisonnement
  // (`runConversationTurn`). Elles ne peuvent donc plus se contredire, ce qui
  // était la classe de défauts que ce round ferme : le 23 août 2026, le
  // rédacteur a écrit un texte juste sur un message que la couche d'à côté
  // jugeait « demande de prix ».
  //
  // Le texte produit est gardé ici et persisté à l'étape 4, à sa place — après
  // la suppression, l'accusé de réponse et l'état commercial, qui doivent
  // rester devant lui pour que l'interruption la plus défavorable laisse le
  // monde du côté sûr.
  let turn: ConversationTurnResult | null = null;

  if (
    existing !== null &&
    existing.promptVersion === REPLY_CLASSIFIER_PROMPT_VERSION &&
    existing.inputSha256 === contextHash
  ) {
    analysis = existing;
  } else {
    turn = await runConversationTurn(sql, router, context, thread);
    const persisted = await persistAnalysis(sql, context, turn.classification);
    analysis = persisted.analysis;
    analysisCreated = persisted.created;
  }

  const policy = CATEGORY_POLICY[analysis.classification];

  // 2. Suppression — avant l'état, pour que l'interruption la plus défavorable
  //    laisse le monde du côté sûr.
  let suppressed = false;
  if (policy.suppression !== 'none') {
    // IG5.1 — le TYPE de l'identifiant suit le transport du premier message.
    // Une demande d'arrêt reçue en DM porte sur un handle ; l'inscrire comme
    // adresse produirait une ligne fausse, que le gate Instagram ne
    // retrouverait jamais (il interroge `match_kind = 'instagram'`).
    const matchKind = context.firstTouch.transport === 'instagram_dm' ? ('instagram' as const) : ('email' as const);
    const result = await suppressOutbound(sql, {
      scope: policy.suppression,
      address: context.reply.fromAddress,
      inboundMessageId,
      detail: analysis.reasoningSummary.slice(0, 200),
      matchKind,
    });
    suppressed = result.suppressed;
    // Le destinataire du manifeste peut différer de l'expéditeur de la réponse
    // (une réponse envoyée depuis une autre boîte de la même entreprise). Les
    // deux sont exclus : la demande d'arrêt porte sur la relation, pas sur la
    // boîte qui l'a formulée.
    if (context.firstTouch.recipient.trim().toLowerCase() !== context.reply.fromAddress.trim().toLowerCase()) {
      await suppressOutbound(sql, {
        scope: policy.suppression,
        address: context.firstTouch.recipient,
        inboundMessageId,
        detail: `destinataire du manifeste ${context.firstTouch.manifestId}`,
        matchKind,
      });
    }
  }

  // 2 bis. L'ACCUSÉ DE RÉPONSE — HERMES-TARGETING-R1 §5.
  //
  // Avant l'intention, parce que c'est un fait antérieur à elle : quelqu'un a
  // écrit, et cela est vrai que la suite soit un oui, un non ou une phrase
  // qu'on n'arrive pas à classer. Le placer ici plutôt qu'après produit le
  // chemin `CONTACTED → REPLIED → <intention>`, chaque marche journalisée, au
  // lieu du saut direct qui rendait l'état `REPLIED` inatteignable et la
  // colonne « Ont répondu » vide alors que la boîte de réception ne l'était pas.
  //
  // Après la SUPPRESSION, en revanche, et pour la raison donnée en tête de
  // fichier : si le processus meurt entre les deux, l'exclusion est déjà écrite
  // et c'est l'état qui rattrapera, jamais l'inverse.
  const acknowledged = await acknowledgeReply(sql, {
    prospectId: context.prospect.id,
    category: analysis.classification,
    inboundMessageId,
    analysisId: analysis.id,
    detail: analysis.reasoningSummary,
  });

  // 3. État commercial.
  let stateFrom: OutreachState | null = acknowledged?.fromState ?? context.currentState;
  let stateTo: OutreachState | null = acknowledged?.applied === true ? acknowledged.toState : null;
  let stateApplied = acknowledged?.applied === true;
  let staleReplyIgnored = acknowledged?.skipped === 'stale_reply';
  const intentState = intentTransitionTarget(analysis.classification, stateBeforeReply);
  if (intentState !== null) {
    const transition = await applyTransition(sql, {
      prospectId: context.prospect.id,
      toState: intentState,
      causeKind: 'inbound_reply',
      causeId: inboundMessageId,
      analysisId: analysis.id,
      reason: `${analysis.classification} (${analysis.confidence.toFixed(2)}) — ${analysis.reasoningSummary}`,
    });
    // `stateFrom` garde le point de DÉPART du passage, pas celui de la seconde
    // marche : un rapport qui dirait « REPLIED → REPLIED » cacherait que le
    // prospect était `CONTACTED` en entrant. `stateApplied` reste vrai dès
    // qu'une des deux marches a bougé.
    stateFrom = acknowledged?.applied === true ? acknowledged.fromState : transition.fromState;
    stateTo = transition.toState;
    stateApplied = stateApplied || transition.applied;
    staleReplyIgnored = staleReplyIgnored || transition.skipped === 'stale_reply';
  }

  // 3 bis. LA MARQUE D'EAU — HERMES-REPLY-ORDERING-R1.
  //
  // `applyTransition` fait monter la marque quand il écrit, et quand il constate
  // que l'état visé est déjà là. Il reste un cas qu'il ne voit pas : une réponse
  // humaine RÉELLE dont l'intention ne vise aucune transition — le second
  // message ambigu d'un prospect déjà intéressé, par exemple, que
  // `intentTransitionTarget` renvoie à `null`. Sans cette ligne, cette réponse
  // ne compterait pas comme prise en compte, et une réponse ANTÉRIEURE traitée
  // plus tard pourrait encore décider à sa place.
  //
  // La condition est celle de la taxonomie, pas une seconde règle : seules les
  // catégories qui établissent qu'un humain a écrit ordonnent le fil. Une
  // réponse d'absence et une non-remise ne sont pas des réponses commerciales —
  // les laisser monter la marque bloquerait un vrai message plus ancien traité
  // après elles.
  //
  // Idempotente et monotone : appelée sur une réponse dépassée, elle ne fait
  // rien, puisque son heure est inférieure à la marque en place.
  if (CATEGORY_POLICY[analysis.classification].evidencesHumanReply) {
    await noteReplyConsidered(sql, context.prospect.id, inboundMessageId);
  }

  // 4. Brouillon — jamais pour une catégorie qui n'en justifie pas, jamais de
  //    texte de repli si la rédaction échoue.
  let draftId: string | null = null;
  let draftCreated = false;
  let draftFailure: string | null = null;
  let proposedResponseStatus: AlertBody['proposedResponseStatus'] = 'NONE';

  // Le texte canonique, gardé en mémoire pour que l'ombre ait quelque chose à
  // comparer. Il n'est ni relu en base ni modifié : c'est exactement l'objet
  // que l'étape ci-dessous vient de produire ou de retrouver.
  //
  // HERMES-CONTACT-PURPOSE-R1 — il vient désormais du cerveau, pas du rédacteur
  // R6B-D2. La comparaison de l'ombre est donc dégénérée sur ce chemin : elle
  // opposerait le cerveau à lui-même. Le drapeau reste à `0` par défaut et la
  // mécanique est laissée intacte plutôt que retirée à la volée — mais ce qui
  // en sortirait aujourd'hui n'apprend plus rien.
  let canonicalDraft: { body: string; sha256: string; blocked: boolean; codes: string[] } | null = null;

  if (isDraftEligible(analysis.classification)) {
    // HERMES-SEMANTIC-GROUNDING-R1 — le rédacteur est le MÊME raisonnement que
    // le lecteur, et il a déjà écrit.
    //
    // Deux chemins arrivent ici, et ils coûtent au plus UN appel chacun :
    //
    //   * le tour a été joué plus haut (`runConversationTurn`) et porte déjà
    //     son texte — zéro appel de plus ;
    //   * la lecture a été RÉUTILISÉE (même version de prompt, même empreinte
    //     de contexte) et aucun texte n'existe sous la consigne du jour —
    //     `buildConversationReply` en écrit un, avec le MÊME prompt et les
    //     MÊMES contrôles, sur la lecture déjà rendue.
    //
    // HERMES-CONTACT-PURPOSE-R1 — le rédacteur est le CERVEAU, et lui seul.
    //
    // Ce chemin appelait `generateReplyDraft` (R6B-D2), qui ne voit ni le fil,
    // ni le registre observé, ni le budget de longueur du tour, ni l'objectif
    // commercial, ni le motif de contact. C'était sans conséquence tant qu'un
    // humain relisait chaque texte. Ce n'en est plus une depuis que le rail
    // autonome LIT ce brouillon : `assessInboundMessage` juge exactement cette
    // ligne, et `executeConversationReply` enverrait exactement ce texte.
    //
    // Le 23 août 2026, la conséquence s'est vue en clair. Le prospect tutoyait,
    // le profil de style le disait, `checkNaturalness` a relevé
    // `ADDRESS_MODE_MISMATCH` — et le rédacteur n'avait jamais reçu
    // l'information. Le contrôle faisait son travail sur un texte que personne
    // n'avait mis en position de réussir.
    //
    // Deux rédacteurs pour la même question auraient fini par diverger, et
    // c'est toujours le plus indulgent qui gagne : `buildConversationReply`
    // rend le MÊME `DraftResult`, écrit par le même `persistDraft`, avec le
    // même statut `PROPOSED` et les mêmes garde-fous `checkReplyDraft`. Ce qui
    // change est ce que le modèle a sous les yeux.
    const channel = draftChannelOf(context.firstTouch.transport);
    const promptVersion = conversationPromptVersionFor(channel);

    // La question posée est « un texte existe-t-il sous la consigne
    // d'AUJOURD'HUI ? », et non « un texte existe-t-il ? ». Sans cette nuance,
    // corriger le rédacteur ne changerait jamais rien sur un tour déjà traité.
    const already = await loadDraftForAnalysisVersion(sql, analysis.id, promptVersion);
    if (already !== null) {
      draftId = already.id;
      proposedResponseStatus = 'PROPOSED';
      canonicalDraft = { body: already.body, sha256: already.bodySha256, blocked: already.blocked, codes: [] };
    } else if (turn !== null) {
      // Le texte du tour unifié. Il a été relu par `evaluateConversationDraft`,
      // c'est-à-dire par les mêmes garde-fous et le même contrôle de naturalité
      // que n'importe quel brouillon de ce dépôt.
      if (turn.draft === null) {
        proposedResponseStatus = 'NONE';
        draftFailure = turn.draftSkipped ?? 'aucun brouillon';
      } else {
        const persisted = await persistDraft(sql, context, analysis, turn.draft);
        draftId = persisted.draft.id;
        draftCreated = persisted.created;
        proposedResponseStatus = 'PROPOSED';
        canonicalDraft = {
          body: turn.draft.body,
          sha256: turn.draft.bodySha256,
          blocked: turn.draft.blocked,
          codes: turn.draft.guardrailFlags.map((flag) => flag.code),
        };
      }
    } else {
      try {
        const reply = await buildConversationReply(sql, router, context, analysis);
        if (reply.draft === null) {
          // Le cerveau a décidé de NE PAS écrire (arrêt demandé, contenu
          // sensible, escalade). Ce n'est pas un échec de rédaction : c'est la
          // bonne réponse, et fabriquer un texte ici mettrait sous les yeux
          // d'un humain pressé un message prêt à être copié-collé.
          proposedResponseStatus = 'NONE';
          draftFailure = `aucun brouillon : ${reply.decision.decision}${
            reply.decision.escalationReason === null ? '' : ` (${reply.decision.escalationReason})`
          }`;
        } else {
          const persisted = await persistDraft(sql, context, analysis, reply.draft);
          draftId = persisted.draft.id;
          draftCreated = persisted.created;
          proposedResponseStatus = 'PROPOSED';
          canonicalDraft = {
            body: reply.draft.body,
            sha256: reply.draft.bodySha256,
            blocked: reply.draft.blocked,
            codes: reply.draft.guardrailFlags.map((flag) => flag.code),
          };
        }
      } catch (error) {
        // L'analyse survit : une rédaction ratée n'invalide pas une
        // classification correcte, et la prochaine exécution réessaiera sans
        // reclasser.
        draftFailure = error instanceof Error ? error.message : String(error);
        proposedResponseStatus = 'FAILED';
        if (!(error instanceof DraftFailure)) throw error;
      }
    }
  }

  // 4 bis. L'OMBRE — CONVERSATION-R1.1 §3, §4.
  //
  // Elle se pose ICI et pas ailleurs : après que le chemin canonique a fini son
  // travail, donc sans rien lui prendre ni rien lui donner, et avant la
  // projection CRM, qui n'en sait rien et ne doit rien en savoir. Ce n'est pas
  // un second inbound : le contexte, la corrélation, la classification et
  // l'état sont ceux qu'on vient de calculer une seule fois, plus haut.
  //
  // Elle ne peut pas faire échouer un traitement : `observeConversationShadow`
  // ne lève pas, et le `catch` ci-dessous est une ceinture par-dessus les
  // bretelles. Une réponse réelle ne doit jamais rester non traitée à cause
  // d'une mesure facultative.
  let conversationShadow: ShadowObservation | null = null;
  if (conversationShadowEnabled(deps.conversationShadow)) {
    try {
      conversationShadow = await observeConversationShadow(sql, router, context, analysis, {
        legacyBody: canonicalDraft?.body ?? null,
        legacyBodySha256: canonicalDraft?.sha256,
        legacyBlocked: canonicalDraft?.blocked,
        legacyGuardrailCodes: canonicalDraft?.codes,
      });
      logger.info('conversation shadow', {
        inboundMessageId: conversationShadow.inboundMessageId,
        prospectId: conversationShadow.prospectId,
        status: conversationShadow.status,
        goal: conversationShadow.goal,
        decision: conversationShadow.decision,
        callReadiness: conversationShadow.callReadiness,
        legacyChars: conversationShadow.legacy?.chars ?? null,
        legacyNaturalness: conversationShadow.legacy?.naturalnessVerdict ?? null,
        conversationChars: conversationShadow.conversation?.chars ?? null,
        conversationNaturalness: conversationShadow.conversation?.naturalnessVerdict ?? null,
        attempts: conversationShadow.attempts,
      });
    } catch (error) {
      logger.warn('conversation shadow indisponible', {
        inboundMessageId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 5. Projection CRM.
  let crmStatus: CrmProjectionStatus | null = null;
  let crmDetail: string | null = null;
  if (policy.crmEligible && intentState !== null) {
    const projection = await projectToCrm(sql, {
      context,
      analysis,
      outreachState: intentState,
      externalWriteAllowed: allowsExternalWrite(context.reply.correlationStatus),
      resolution: crm,
      // L'historique déposé chez le fournisseur dit où en est la réponse
      // proposée — d'où l'ordre brouillon → projection : l'inverse obligerait
      // à mentir sur cet état ou à réécrire la note après coup.
      proposedResponseStatus,
    });
    crmStatus = projection.status;
    crmDetail = projection.detail;
  }

  // 6. Alerte.
  let alertId: string | null = null;
  let alertCreated = false;
  if (shouldAlert(analysis.classification)) {
    const raised = await raiseAlert(sql, context, analysis, proposedResponseStatus);
    alertId = raised.alert.id;
    alertCreated = raised.created;
    if (!alertProviderConfigured && raised.created) await markNoAlertProvider(sql, raised.alert.id);
  }

  return Object.freeze({
    inboundMessageId,
    prospectId: context.prospect.id,
    manifestId: context.firstTouch.manifestId,
    company: context.firstTouch.businessName,
    correlationStatus: context.reply.correlationStatus,
    classification: analysis.classification,
    confidence: analysis.confidence,
    analysisId: analysis.id,
    analysisCreated,
    stateFrom,
    stateTo,
    stateApplied,
    replyAcknowledged: acknowledged?.applied === true,
    staleReplyIgnored,
    suppressed,
    draftId,
    draftCreated,
    draftFailure,
    crmStatus,
    crmDetail,
    alertId,
    alertCreated,
    conversationShadow,
  });
}

/** Un message que le traitement ne peut pas prendre en charge — jamais une panne. */
export class UnprocessableReply extends Error {
  readonly inboundMessageId: string;
  constructor(inboundMessageId: string, reason: string) {
    super(`${inboundMessageId} : ${reason}`);
    this.name = 'UnprocessableReply';
    this.inboundMessageId = inboundMessageId;
  }
}

export interface ProcessOptions {
  readonly limit?: number;
  /**
   * Repasse aussi sur les réponses déjà analysées, pour reprendre un aval
   * incomplet (brouillon manquant, projection en échec, alerte à relever).
   * Aucune reclassification n'a lieu : l'analyse vivante est réutilisée telle
   * quelle tant que le contexte n'a pas changé.
   */
  readonly includeAnalyzed?: boolean;
  /**
   * Un SEUL message entrant, et rien d'autre.
   *
   * `limit` et `includeAnalyzed` sont ignorés quand il est fourni : le
   * traitement est déterministe et idempotent, donc restreindre le lot ne
   * change rien à ce qui sera conclu — seulement à ce qui sera touché. C'est
   * la porte à utiliser après un correctif de classification, quand une
   * conversation nommée doit être relue et aucune autre.
   */
  readonly only?: string | null;
}

/**
 * Le traitement complet : lire les réponses corrélées non traitées, les
 * traiter, sortir.
 *
 * Un échec sur un message n'arrête pas les autres et ne laisse aucune
 * transition à moitié écrite — chaque étape est idempotente, et un message en
 * échec reste simplement non traité jusqu'à la prochaine exécution.
 */
export async function processNewReplies(
  sql: Sql,
  router: ModelRouter,
  deps: ProcessDeps = {},
  options: ProcessOptions = {},
): Promise<ProcessReport> {
  const limit = options.limit ?? 50;
  const crm = deps.crm ?? (await resolveCrmDestination(sql));
  const alertProviderConfigured = deps.alertProviderConfigured ?? false;
  // Résolu UNE fois pour tout le lot : lire l'environnement par message ferait
  // qu'un même passage pourrait observer une moitié des réponses et pas l'autre.
  const conversationShadow = conversationShadowEnabled(deps.conversationShadow);

  // HERMES-CONTEXTUAL-REPLY-CLASSIFICATION-R1 — le chemin le plus ÉTROIT.
  //
  // `--resume` reprend TOUT ce qui est déjà analysé, ce qui est ce qu'il faut
  // après une panne d'aval et ce qu'il ne faut pas après un correctif de
  // classification : rejouer le lot entier reclasserait des conversations que
  // personne n'a demandé de rouvrir, et coûterait un appel de modèle par
  // message. `only` borne le passage à un seul identifiant.
  const only = options.only ?? null;
  const ids =
    only !== null
      ? [only]
      : await (async (): Promise<string[]> => {
          const pending = await loadUnprocessedCorrelatedInbound(sql, limit);
          if (options.includeAnalyzed === true) {
            const analyzed = await loadAnalyzedCorrelatedInbound(sql, limit);
            for (const id of analyzed) if (!pending.includes(id)) pending.push(id);
          }
          return pending;
        })();

  const processed: ProcessedReply[] = [];
  const skipped: SkippedReply[] = [];
  const failures: FailedReply[] = [];
  const absorbed: AbsorbedReply[] = [];

  for (const id of ids) {
    try {
      processed.push(await processReply(sql, router, id, { crm, alertProviderConfigured, conversationShadow }));
    } catch (error) {
      if (error instanceof AbsorbedIntoBurst) {
        // Pas un échec : cette bulle est un fragment de phrase, et le tour qui
        // la clôt porte son texte. L'absorption est déjà inscrite.
        absorbed.push({
          inboundMessageId: error.inboundMessageId,
          burstClosingMessageId: error.burstClosingMessageId,
          burstMessageCount: error.burstMessageCount,
        });
        continue;
      }
      if (error instanceof UnprocessableReply) {
        skipped.push({ inboundMessageId: id, reason: error.message });
        continue;
      }
      if (error instanceof ClassificationFailure) {
        // §15 — « classifier failure → no silent transition ». Aucune analyse
        // n'a été écrite, donc aucun état n'a bougé : le message reste
        // exactement là où il était.
        failures.push({ inboundMessageId: id, stage: 'classification', reason: error.message });
        continue;
      }
      failures.push({
        inboundMessageId: id,
        stage: 'persistence',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return Object.freeze({
    candidates: ids.length,
    processed: Object.freeze(processed),
    skipped: Object.freeze(skipped),
    failures: Object.freeze(failures),
    absorbed: Object.freeze(absorbed),
    classified: processed.filter((entry) => entry.analysisCreated).length,
    drafted: processed.filter((entry) => entry.draftCreated).length,
    repliesAcknowledged: processed.filter((entry) => entry.replyAcknowledged).length,
    staleRepliesIgnored: processed.filter((entry) => entry.staleReplyIgnored).length,
    crmWrites: processed.filter((entry) => entry.crmStatus === 'APPLIED').length,
    localCrmRecords: processed.filter((entry) => entry.crmStatus === 'LOCAL_ONLY').length,
    alertsRaised: processed.filter((entry) => entry.alertCreated).length,
    externalCrmConfigured: crm.configured,
    crmDetail: crm.configured ? `fournisseur externe « ${crm.provider.name} »` : crm.reason,
    alertProviderConfigured,
    conversationShadowEnabled: conversationShadow,
    conversationShadowObserved: processed.filter((entry) => entry.conversationShadow?.status === 'OBSERVED').length,
  });
}
