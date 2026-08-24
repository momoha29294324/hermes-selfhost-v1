/**
 * HERMES-CONVERSATION-R2 §30/§31 — l'ÉVALUATION complète d'un tour, sans
 * modèle et sans effet.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce module rassemble, et pourquoi il ne rédige pas
 * ---------------------------------------------------------------------------
 * La décision d'autonomie (`decideAutonomousReply`) est pure : elle prend des
 * faits et rend un verdict. Quelqu'un doit rassembler ces faits depuis la base,
 * et c'est ici. Le partage est celui de tout le dépôt — la lecture d'un côté,
 * la décision de l'autre — et il a la même conséquence utile : la politique
 * s'éprouve sur des états que les données réelles ne produiront pas de sitôt,
 * tandis que la lecture s'éprouve sur les données réelles.
 *
 * Ce module n'appelle AUCUN modèle. Il relit le brouillon DÉJÀ écrit quand il
 * existe, et lui applique les contrôles déterministes — naturalité, garde-fous
 * déjà posés, promesses commerciales. C'est ce qui rend `conversation:autonomy`
 * gratuit, reproductible, et exécutable sur une base en lecture seule.
 *
 * Quand aucun brouillon n'existe, la décision le DIT (`draft_missing`) plutôt
 * que d'en inventer un : §30 demande d'observer ce que le système ferait, pas
 * de fabriquer ce qu'il n'a pas fait.
 *
 * ---------------------------------------------------------------------------
 * Zéro effet, par construction
 * ---------------------------------------------------------------------------
 * Aucun import de provider, aucune primitive d'envoi, aucune écriture. Le
 * champ `externalEffects: false` est un littéral de type : il n'existe pas de
 * chemin d'ici vers un réseau sortant.
 */

import {
  CONVERSATION_POLICY_VERSION,
  decideAutonomousReply,
  terminalCategoryIn,
  type AutonomousDraftFacts,
  type AutonomousReplyDecision,
} from '@/lib/conversation/autonomy';
import { burstContaining, burstSettled, closesBurst, type InboundBurst } from '@/lib/conversation/burst';
import {
  COMMERCIAL_POLICY_VERSION,
  demandFromCurrentRequest,
  readCommercialDemands,
  signalCommercialDemand,
  type CommercialDemandFinding,
} from '@/lib/conversation/commercialPolicy';
import { conversationPromptVersionFor, understandConversation } from '@/lib/conversation/brain';
import {
  checkNaturalness,
  containsPitch,
  naturalnessSendGate,
  proposesCall,
  type NaturalnessReport,
} from '@/lib/conversation/naturalness';
import type { GroundingGap } from '@/lib/conversation/grounding';
import type { OfferProgression } from '@/lib/conversation/offerProgression';
import type { AppointmentAssessment } from '@/lib/sales/objective';
import { checkTrialStatement } from '@/lib/sales/offer';
import { parseRequestedResume, type FollowUpFacts } from '@/lib/conversation/followUp';
import { conversationReplyDelayMs, deriveConversationPlanKey } from '@/lib/conversation/plan';
import { loadConversationGuards, type ConversationGuards } from '@/lib/conversation/guards';
import type { ConversationPolicyConfig } from '@/lib/config/schema';
import type { Sql } from '@/lib/db/sql';
import { detectPerformanceClaims } from '@/lib/learning/offer';
import { loadActiveAnalysis } from '@/lib/replies/analyses';
import { loadReplyContext } from '@/lib/replies/context';
import { loadDraftForAnalysisVersion, sha256Hex, type StoredDraft } from '@/lib/replies/draft';
import type { ReplyCategory } from '@/lib/replies/taxonomy';

export interface AssessedDraft {
  readonly id: string;
  readonly status: StoredDraft['status'];
  /** Le texte RETENU : celui d'un humain s'il a réécrit, sinon celui du modèle. */
  readonly body: string;
  readonly bodySha256: string;
  readonly naturalness: NaturalnessReport;
  readonly facts: AutonomousDraftFacts;
}

export interface ConversationAssessment {
  readonly inboundMessageId: string;
  readonly prospectId: string;
  readonly displayName: string;
  readonly channel: 'instagram_dm' | 'email';
  readonly receivedAt: string;

  readonly category: string;
  readonly confidence: number;
  /**
   * L'analyse D2 VIVANTE sur laquelle cette évaluation repose.
   *
   * Exposée parce qu'elle entre dans l'identité du plan : reclasser un message
   * produit une analyse neuve, donc une intention neuve, là où l'ancienne clé
   * rendait silencieusement le plan périmé.
   */
  readonly analysisId: string;
  readonly goal: string;
  readonly replyDecision: string;
  readonly callReadiness: 'LOW' | 'MEDIUM' | 'HIGH';
  readonly offer: OfferProgression;
  /** §3 à §5 — cette conversation vaut-elle un appel, et qui reprend ensuite ? */
  readonly appointment: AppointmentAssessment;
  readonly guards: ConversationGuards;

  /** La salve à laquelle ce message appartient. */
  readonly burstSize: number;
  readonly closesBurst: boolean;
  readonly burstSettled: boolean;
  readonly newerInboundExists: boolean;
  readonly terminalCategoryInThread: string | null;

  /**
   * Ce que ce tour DEMANDE et que le dépôt ne possède pas.
   *
   * Rendu ici parce qu'une intention inscrite doit porter ses manques : un plan
   * qu'on relit six mois plus tard sans eux ne dit pas contre quoi le modèle
   * écrivait. Ce sont les mêmes que ceux du prompt (`buildGrounding`), jamais
   * une seconde lecture — un second calcul finirait par diverger, et c'est
   * toujours le plus indulgent qui gagnerait.
   */
  readonly groundingGaps: readonly GroundingGap[];

  readonly draft: AssessedDraft | null;
  /** La décision qui vaut AUJOURD'HUI. La seule qui pourrait autoriser un effet. */
  readonly autonomous: AutonomousReplyDecision;
  /**
   * §31 — la même politique rejouée AU MOMENT de ce tour.
   *
   * Une MESURE, jamais une autorisation : elle répond à « la politique
   * aurait-elle su répondre seule à ce message ? », question sans laquelle un
   * rapport sur des conversations déjà refermées n'apprend rien.
   */
  readonly replay: AutonomousReplyDecision;

  /** La provenance qu'un plan porterait s'il était inscrit. */
  readonly policyVersion: string;
  readonly commercialPolicyVersion: string;
  /** Les demandes commerciales relevées sur ce tour, réunion des deux lectures. */
  readonly commercialDemands: readonly CommercialDemandFinding[];
  readonly brainVersion: string;
  readonly idempotencyKey: string;
  readonly conversationWatermark: string | null;
  /** L'instant où cette réponse pourrait agir, délai humain compris (§22). */
  readonly notBefore: string;

  /** Rien n'a été écrit, rien n'est parti. Littéral de type, pas un calcul. */
  readonly externalEffects: false;
}

export interface AssessInput {
  readonly config: ConversationPolicyConfig;
  readonly now: Date;
}

/**
 * Évalue UN message entrant, de bout en bout, sans rien écrire.
 *
 * Rend `null` quand le message n'existe pas, n'est pas corrélé de façon
 * exploitable, ou n'a pas d'analyse vivante : ce sont trois façons de dire « il
 * n'y a rien à décider », et aucune n'est une anomalie.
 */
export async function assessInboundMessage(
  sql: Sql,
  inboundMessageId: string,
  input: AssessInput,
): Promise<ConversationAssessment | null> {
  const context = await loadReplyContext(sql, inboundMessageId);
  if (context === null) return null;

  const analysis = await loadActiveAnalysis(sql, inboundMessageId);
  if (analysis === null) return null;

  const understanding = await understandConversation(sql, context, analysis);
  const thread = understanding.thread;
  // Les faits durables, le palier commercial, la catégorie terminale et la
  // qualification pour un rendez-vous sont désormais calculés UNE fois, dans
  // `understandConversation`, et relus ici. Ils l'étaient en double jusqu'à ce
  // round — deux lectures voisines de la même question, qui auraient fini par
  // diverger sur une borne, et c'est toujours la plus indulgente qui gagne.
  const guards = understanding.guards;

  // La salve à laquelle appartient CE message. Absente si le fil ne le porte pas
  // — un message tronqué hors de la fenêtre de contexte, par exemple ; le côté
  // sûr est alors de le traiter comme une salve d'un seul message non close.
  const burst: InboundBurst | null = burstContaining(thread.turns, inboundMessageId);
  const settled =
    burst === null ? false : burstSettled(burst, input.now, input.config.reply.burstQuietMs);
  const closes = burst === null ? false : closesBurst(burst, inboundMessageId);

  // §24 — « plus récent » se lit sur l'heure de RÉCEPTION, pas sur l'ordre de
  // traitement. `latestInboundAt` vient de la même lecture que la marque d'eau
  // de 0048, donc les deux ne peuvent pas se contredire.
  const receivedAt = context.reply.receivedAt;
  const newerInboundExists =
    guards.latestInboundAt !== null && Date.parse(guards.latestInboundAt) > Date.parse(receivedAt);

  const offer = understanding.offer;

  // La catégorie terminale se lit sur les tours JUSQU'À CELUI-CI, courant
  // compris — jamais sur ceux qui l'ont suivi.
  //
  // Le défaut que cette ligne corrige était visible dans le premier rapport
  // réel : un message de 13:13 se voyait refusé parce que « ce fil porte déjà
  // un NOT_INTERESTED », alors que le refus n'est arrivé qu'à 13:35. La
  // conclusion — ne pas répondre aujourd'hui — restait juste, tenue par l'état
  // commercial et par la fraîcheur ; le MOTIF, lui, était un anachronisme, et
  // un motif faux se relit de travers six mois plus tard.
  const currentIndex = thread.inboundTurns.findIndex((turn) => turn.sourceId === inboundMessageId);
  const beforeCurrent = currentIndex < 0 ? [] : thread.inboundTurns.slice(0, currentIndex);
  const terminalCategory = understanding.terminalCategoryInThread;
  const terminalBefore = terminalCategoryIn(beforeCurrent.map((turn) => turn.classification));

  // §3 à §5 — la qualification pour un rendez-vous.
  //
  // Calculée APRÈS la catégorie terminale, parce qu'elle la lit : un fil déjà
  // refermé ne vaut pas un appel, quel que soit l'enthousiasme du dernier
  // message. Elle n'autorise rien à elle seule ; `decideAutonomousReply` reste
  // le seul juge de ce qui part.
  const appointment = understanding.appointment;

  // HERMES-END-TO-END-CERTIFICATION-R1 — le brouillon de CE TOUR, pas le
  // dernier écrit.
  //
  // Cette ligne lisait `loadDraftForAnalysis`, c'est-à-dire « le texte qui fait
  // foi pour un humain » : d'abord celui qu'un humain a relu, puis le plus
  // récent, et à égalité d'horloge le plus grand `id` — un uuid aléatoire.
  // Depuis la migration 0056, une analyse peut porter PLUSIEURS brouillons, un
  // par version de prompt, et c'est précisément ce que ce round-là voulait :
  // « un prompt corrigé écrit À CÔTÉ, sans jamais écraser un texte qu'un humain
  // a approuvé ».
  //
  // Les deux décisions ensemble produisaient un défaut que rien ne rattrapait :
  // le rail autonome jugeait — et enverrait — un texte écrit sous une consigne
  // périmée. Un brouillon `APPROVED` sous `conv-r4` passait devant le
  // `PROPOSED` sous `conv-r5`, inconditionnellement ; et entre deux `PROPOSED`
  // d'horodatage égal, l'issue tenait au tirage d'un uuid. Le plan portait
  // pourtant `brain_version = conv-r5-*` : la ligne inscrite affirmait une
  // version que le corps ne respectait pas.
  //
  // `loadDraftForAnalysisVersion` répond à la seule question qui vaille ici —
  // « un texte existe-t-il sous la consigne d'AUJOURD'HUI ? ». C'est déjà la
  // question que `processReply` pose pour ÉCRIRE (`replies/process.ts`) ; les
  // deux lisent désormais la même. Elle est déterministe par construction :
  // l'index unique `(analysis_id, prompt_version)` de 0056 en fait au plus une
  // ligne, donc aucun ordre n'a besoin d'être choisi.
  //
  // Fail-closed : aucun texte sous la version courante rend `null`, donc
  // `draft_missing` — un `AUTO_REPLY_SKIP` reconsidérable, que le prochain
  // passage de `processReply` lève en écrivant le brouillon manquant. Aucun
  // envoi n'est ouvert ; un envoi sous des règles périmées est fermé.
  const stored = await loadDraftForAnalysisVersion(
    sql,
    analysis.id,
    conversationPromptVersionFor(thread.channel),
  );
  const draft =
    stored === null ? null : assessDraft(stored, understanding.utterance.text, understanding);

  // §1 — les demandes commerciales, relevées DEUX fois et réunies.
  //
  // Le lexique lit le texte brut ; les signaux ont été lus en connaissant la
  // conclusion D2. Les deux se trompent différemment — l'un rate une tournure
  // qu'il n'a pas prévue, l'autre perd un sujet quand deux se disputent la
  // place — donc les deux sont appelées, et la réunion l'emporte. Fail-closed :
  // une demande vue par un seul des deux suffit à écarter l'autonomie.
  // HERMES-SEMANTIC-GROUNDING-R1 — TROIS lectures, et la troisième ne sait
  // qu'ajouter.
  //
  // Le lexique lit le texte brut, cadre d'énonciation compris. Les signaux ont
  // été lus en connaissant la conclusion D2. La troisième est celle du MODÈLE,
  // relue depuis l'analyse persistée : elle rattrape ce qu'un lexique ne peut
  // pas voir — un mot qu'il n'a pas appris — et elle est bornée aux sujets
  // qu'aucune vérité de ce dépôt ne couvre.
  //
  // Fail-closed : une demande vue par UNE seule des trois suffit à écarter
  // l'autonomie, et `analysis.currentRequest === null` — le cas de toute
  // analyse écrite avant ce round — n'ouvre rien.
  const commercialDemands = mergeCommercialDemands(
    mergeCommercialDemands(
      readCommercialDemands(understanding.utterance.text),
      // HERMES-TRIAL-COST-VS-POST-TRIAL-PRICING-R1 §2 — le texte accompagne les
      // signaux, sans quoi la lecture par signaux resterait aveugle au sujet du
      // prix et réintroduirait à elle seule le faux refus du 23 août.
      signalCommercialDemand(understanding.signals, understanding.utterance.text),
    ),
    demandFromCurrentRequest(analysis.currentRequest),
  );

  const shared = {
    policyVersion: CONVERSATION_POLICY_VERSION,
    commercialPolicyVersion: COMMERCIAL_POLICY_VERSION,
    commercialDemands,
    correlation: context.reply.correlationStatus,
    identityConfirmed: guards.identityConfirmed,
    suppressed: guards.suppressed,
    category: analysis.classification,
    confidence: analysis.confidence,
    signals: understanding.signals,
    state: understanding.state,
    decision: understanding.decision,
    groundingGaps: understanding.grounding.gaps,
    offer,
    appointmentQualification: appointment.qualification,
    draft: draft?.facts ?? null,
    minConfidence: input.config.reply.minConfidence,
  } as const;

  const autonomous = decideAutonomousReply({
    ...shared,
    outreachState: guards.outreachState,
    terminalCategoryInThread: terminalCategory,
    newerInboundExists,
    burstSettled: settled,
  });

  // §31 — la MÊME politique, rejouée comme si l'on était à ce tour-là.
  //
  // Trois faits d'AUJOURD'HUI sont retirés, et eux seuls : l'état commercial
  // courant, les messages arrivés depuis, et la clôture du fil postérieure à ce
  // message. Tout le reste — identité, exclusion, catégorie, grounding, palier
  // commercial, brouillon — est celui du tour.
  //
  // Elle n'autorise RIEN : c'est une mesure. Sans elle, un rapport sur des
  // conversations toutes refermées ne dirait qu'une chose — qu'elles sont
  // refermées — et n'apprendrait rien sur la politique.
  const replay = decideAutonomousReply({
    ...shared,
    outreachState: null,
    terminalCategoryInThread: terminalBefore,
    newerInboundExists: false,
    burstSettled: true,
  });

  // HERMES-CONTEXTUAL-REPLY-CLASSIFICATION-R1 — la clé porte l'analyse.
  //
  // Une intention est fonction du message ET de ce qu'on en a compris. Tant que
  // la compréhension ne bouge pas, la clé ne bouge pas : rejouer cette
  // évaluation retombe exactement sur le plan déjà inscrit.
  //
  // HERMES-CONTACT-PURPOSE-R1 — et elle porte aussi la POLITIQUE.
  //
  // Même raisonnement, un cran plus loin : un tour refusé sous des règles
  // d'hier doit pouvoir être rejugé quand les règles changent, sans qu'il faille
  // reclasser un message que personne n'a mal compris. La garde anti-double-effet
  // de `recordConversationPlan` reste seule maîtresse de ce qui peut AGIR.
  const idempotencyKey = deriveConversationPlanKey(
    'AUTO_REPLY',
    context.prospect.id,
    inboundMessageId,
    analysis.id,
    CONVERSATION_POLICY_VERSION,
  );
  const delayMs = conversationReplyDelayMs(idempotencyKey, input.config);
  const anchor = burst === null ? Date.parse(receivedAt) : Date.parse(burst.endedAt);
  const notBefore = new Date((Number.isFinite(anchor) ? anchor : input.now.getTime()) + delayMs);

  return Object.freeze({
    inboundMessageId,
    prospectId: context.prospect.id,
    displayName: context.firstTouch.businessName,
    channel: thread.channel,
    receivedAt,
    category: analysis.classification,
    confidence: analysis.confidence,
    analysisId: analysis.id,
    goal: understanding.state.goal,
    replyDecision: understanding.decision.decision,
    callReadiness: understanding.signals.callReadiness,
    offer,
    appointment,
    guards,
    burstSize: burst?.turns.length ?? 0,
    closesBurst: closes,
    burstSettled: settled,
    newerInboundExists,
    terminalCategoryInThread: terminalCategory,
    groundingGaps: understanding.grounding.gaps,
    draft,
    autonomous,
    replay,
    policyVersion: CONVERSATION_POLICY_VERSION,
    commercialPolicyVersion: COMMERCIAL_POLICY_VERSION,
    commercialDemands,
    brainVersion: conversationPromptVersionFor(thread.channel),
    idempotencyKey,
    conversationWatermark: guards.latestInboundAt,
    notBefore: notBefore.toISOString(),
    externalEffects: false as const,
  });
}

/**
 * Réunit les deux lectures commerciales, sans doublon.
 *
 * L'ordre est celui du lexique, la lecture des signaux venant en dernier : elle
 * est la moins précise des deux (elle nomme un sujet, pas une formulation), et
 * ce qui est nommé en premier est ce qu'un rapport affichera.
 */
function mergeCommercialDemands(
  lexical: readonly CommercialDemandFinding[],
  extra: CommercialDemandFinding | null,
): readonly CommercialDemandFinding[] {
  if (extra === null) return lexical;
  // HERMES-SEMANTIC-GROUNDING-R1 — la déduplication porte sur (demande, cadre
  // engageant), pas sur la demande seule.
  //
  // Sans cette nuance, une demande déjà relevée mais RAPPORTÉE — « mes clients
  // demandaient le prix » — masquerait une demande COURANTE que la lecture
  // suivante aurait vue. La liste dirait « EXACT_PRICE » et personne
  // n'escaladerait, alors que quelqu'un demande vraiment un prix.
  const alreadyEngaging = lexical.some(
    (finding) => finding.demand === extra.demand && finding.frame === 'CURRENT',
  );
  if (alreadyEngaging) return lexical;
  if (extra.frame !== 'CURRENT' && lexical.some((finding) => finding.demand === extra.demand)) {
    return lexical;
  }
  return Object.freeze([...lexical, extra]);
}

/**
 * Relit un brouillon déjà écrit et en tire des MESURES.
 *
 * Le contrôle de naturalité est celui du cerveau, appelé avec les mêmes
 * entrées : un second barème ferait gagner celui qu'on a choisi de noter avec
 * indulgence, et l'autonomie ne prouverait plus rien.
 *
 * Le texte retenu est `human_text` quand un humain a réécrit — c'est CE texte
 * qui compte, pas la proposition du modèle. Un brouillon que un opérateur a corrigé
 * puis approuvé décrit ce qui serait parti, et c'est ce qu'on doit juger.
 */
function assessDraft(
  stored: StoredDraft,
  lastInboundText: string,
  understanding: Awaited<ReturnType<typeof understandConversation>>,
): AssessedDraft {
  const body = stored.humanText ?? stored.body;
  const report = checkNaturalness({
    body,
    lastInboundText,
    style: understanding.style,
    state: understanding.state,
    signals: understanding.signals,
    channel: understanding.thread.channel,
    previousOutboundTexts: understanding.thread.exposedOutboundTurns.map((turn) => turn.text),
    // HERMES-END-TO-END-CERTIFICATION-R1 — la MÊME question que le rédacteur.
    //
    // Cette entrée manquait, et son absence vaut `false` (`naturalness.ts`).
    // `QUESTION_WITHOUT_ANSWER` — le pendant déterministe de RÉPONDS D'ABORD,
    // et le seul constat BLOQUANT qu'ait apporté
    // HERMES-ACQUISITION-SERVICE-TRUTH-R1 — ne pouvait donc JAMAIS se
    // déclencher ici. Le rédacteur (`brain.ts`) le subissait, le rail autonome
    // ne le voyait pas : deux barèmes pour le même texte, et le plus indulgent
    // était celui qui décide de l'envoi.
    //
    // Concrètement, un brouillon qui esquive « concrètement tu fais quoi ? »
    // par une question était réécrit une fois par le rédacteur, puis — si la
    // reprise échouait — jugé `NATURAL` par le rail et envoyé tel quel.
    //
    // La valeur est LUE de la compréhension déjà calculée, jamais recalculée :
    // le prompt, le rédacteur et ce contrôle lisent le même booléen.
    answerExpected: understanding.answerExpected,
  });

  // HERMES-SEMANTIC-GROUNDING-R1 — ce qui BLOQUE et ce qui se signale.
  //
  // Le partage est celui de `NATURALNESS_CLASS`, lu une seule fois ici. Un
  // constat de forme a déjà coûté au cerveau sa réécriture unique ; s'il
  // survit, il devient un avertissement plutôt qu'un silence. Les quatre
  // constats qui portent une règle écrite ailleurs — une seule question, pas
  // d'appel prématuré, réponds d'abord, pas de langue de plaquette — refusent
  // le tour comme avant.
  const sendGate = naturalnessSendGate(report);

  // HERMES-SEMANTIC-GROUNDING-R1 — l'empreinte est celle du texte RETENU.
  //
  // Elle valait `stored.bodySha256`, c'est-à-dire l'empreinte de la proposition
  // du MODÈLE, alors que `body` est déjà le texte retenu (`human_text` quand un
  // humain a réécrit). Les deux divergent exactement dans le cas où la
  // divergence compte, et le trou qui en résultait est celui-ci : un humain
  // réécrit un brouillon APRÈS qu'un plan a été inscrit, l'empreinte rendue ne
  // bouge pas, et `REPLY_DRAFT_CHANGED` — la garde qui existe pour cela — ne se
  // déclenche pas. Ce que le plan ferait partir n'aurait alors été jugé par
  // personne.
  //
  // Le défaut était masqué : le brouillon réécrit tombait sur un constat de
  // naturalité, donc le tour s'arrêtait quand même. Un motif faux qui produit
  // la bonne issue est un motif faux, et il cesse de produire la bonne issue
  // dès que le constat change de classe.
  //
  // Hors réécriture humaine, `sha256Hex(body)` EST `stored.bodySha256` : le
  // comportement est identique au caractère près sur tous les brouillons que ce
  // dépôt produit aujourd'hui.
  const retainedSha256 = stored.humanText === null ? stored.bodySha256 : sha256Hex(body);

  return Object.freeze({
    id: stored.id,
    status: stored.status,
    body,
    bodySha256: retainedSha256,
    naturalness: report,
    facts: Object.freeze({
      bodySha256: retainedSha256,
      guardrailBlocked: stored.blocked,
      naturalnessVerdict: report.verdict,
      naturalnessBlockingCodes: sendGate.blocking,
      naturalnessWarningCodes: sendGate.warnings,
      questions: report.metrics.questions,
      proposesCall: proposesCall(body),
      containsPitch: containsPitch(body),
      performanceClaims: detectPerformanceClaims(body),
      // §9 — le contrôle de l'essai est appliqué au texte RETENU, celui qui
      // partirait. Un brouillon corrigé à la main par un opérateur est jugé sur sa
      // version corrigée, comme tous les autres contrôles de cette fonction.
      trialStatementCodes: Object.freeze(
        checkTrialStatement(body).map((finding) => finding.code),
      ),
    }),
  });
}

// ---------------------------------------------------------------------------
// §35 — les faits d'une RELANCE
// ---------------------------------------------------------------------------

interface FollowUpRow {
  readonly manifestId: string;
  readonly firstTouchSentAt: string | Date | null;
  readonly lastInboundAt: string | Date | null;
  readonly lastInboundText: string | null;
  readonly lastCategory: ReplyCategory | null;
  readonly followUpsSent: string;
  readonly lastFollowUpAt: string | Date | null;
  readonly concurrentIntents: string;
}

/**
 * Rassemble les faits d'une relance pour un prospect.
 *
 * Le « premier message prouvé parti » est un `outreach_event` de type `sent` —
 * la même preuve que partout ailleurs dans le dépôt. Un manifeste verrouillé ne
 * suffit pas : verrouillé n'est pas remis.
 *
 * Les relances déjà remises se comptent dans `hermes_conversation_plans` en
 * statut `SENT` : c'est le seul endroit qui puisse en porter, et le compter
 * ailleurs inventerait une seconde vérité.
 */
export async function loadFollowUpFacts(
  sql: Sql,
  prospectId: string,
  channel: 'instagram_dm' | 'email',
): Promise<FollowUpFacts | null> {
  const guards = await loadConversationGuards(sql, prospectId, channel);

  const rows = await sql.query<FollowUpRow>(
    `select
       (select m.id from r6b_dispatch_manifests m
         where m.prospect_id = p.id and m.status = 'LOCKED'
         order by m.created_at desc limit 1)                              as "manifestId",
       (select max(e.occurred_at) from outreach_events e
         where e.prospect_id = p.id and e.kind = 'sent')                  as "firstTouchSentAt",
       (select max(i.received_at) from r6b_inbound_messages i
         where i.correlated_prospect_id = p.id
           and i.correlation_status in ('EXACT','HIGH_CONFIDENCE'))       as "lastInboundAt",
       (select i.body_text from r6b_inbound_messages i
         where i.correlated_prospect_id = p.id
           and i.correlation_status in ('EXACT','HIGH_CONFIDENCE')
         order by i.received_at desc, i.id desc limit 1)                  as "lastInboundText",
       (select a.classification from r6b_inbound_messages i
          join r6b_reply_analyses a on a.inbound_message_id = i.id and a.status = 'ACTIVE'
         where i.correlated_prospect_id = p.id
           and i.correlation_status in ('EXACT','HIGH_CONFIDENCE')
         order by i.received_at desc, i.id desc limit 1)                  as "lastCategory",
       (select count(*) from hermes_conversation_plans c
         where c.prospect_id = p.id and c.kind in ('FOLLOW_UP_1','FOLLOW_UP_2')
           and c.status = 'SENT')::text                                   as "followUpsSent",
       (select max(c.external_effect_started_at) from hermes_conversation_plans c
         where c.prospect_id = p.id and c.kind in ('FOLLOW_UP_1','FOLLOW_UP_2')
           and c.status = 'SENT')                                         as "lastFollowUpAt",
       (select count(*) from ig_dispatch_jobs j
         where j.prospect_id = p.id
           and j.status not in ('SENT','REVIEW_REQUIRED','DELIVERY_FAILED','INELIGIBLE'))::text
                                                                          as "concurrentIntents"
     from prospects p
    where p.id = $1`,
    [prospectId],
  );

  const row = rows[0];
  if (row === undefined) return null;

  const lastInboundAt = row.lastInboundAt === null ? null : new Date(row.lastInboundAt).toISOString();
  const requested =
    row.lastCategory === 'NOT_NOW' && row.lastInboundText !== null && lastInboundAt !== null
      ? parseRequestedResume(row.lastInboundText, new Date(lastInboundAt))
      : null;

  // La catégorie terminale se lit sur TOUTES les analyses vivantes du fil, pas
  // seulement sur la dernière : un « merci, bonne continuation » suivi d'une
  // question anodine ne rouvre pas une séquence de relance.
  const categories = await sql.query<{ classification: ReplyCategory }>(
    `select a.classification
       from r6b_inbound_messages i
       join r6b_reply_analyses a on a.inbound_message_id = i.id and a.status = 'ACTIVE'
      where i.correlated_prospect_id = $1
        and i.correlation_status in ('EXACT','HIGH_CONFIDENCE')
      order by i.received_at asc`,
    [prospectId],
  );

  return Object.freeze({
    policyVersion: CONVERSATION_POLICY_VERSION,
    prospectId,
    manifestId: row.manifestId,
    firstTouchSentAt: row.firstTouchSentAt === null ? null : new Date(row.firstTouchSentAt).toISOString(),
    followUpsSent: Number(row.followUpsSent),
    lastFollowUpAt: row.lastFollowUpAt === null ? null : new Date(row.lastFollowUpAt).toISOString(),
    inboundCount: guards.inboundCount,
    lastInboundAt,
    lastCategory: row.lastCategory,
    terminalCategoryInThread: terminalCategoryIn(categories.map((entry) => entry.classification)),
    requestedResumeAt: requested?.at ?? null,
    outreachState: guards.outreachState,
    suppressed: guards.suppressed,
    identityConfirmed: guards.identityConfirmed,
    contactHistoryConflict: Number(row.concurrentIntents) > 0,
  });
}
