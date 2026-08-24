/**
 * LEARNING-R1 §18 — le rapport, en LECTURE SEULE et sans modèle.
 *
 * Ce fichier est la seule porte entre la base et la boucle d'apprentissage. Il
 * lit, il dérive, il rend un objet. Il n'écrit rien, et ce n'est pas une
 * discipline : il n'importe aucune primitive d'écriture, aucune table de la
 * boucle n'existe (rien à écrire), et le CLI l'appelle derrière un `Sql`
 * enveloppé qui refuse toute instruction non-SELECT au niveau de la syntaxe.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi AUCUNE table n'est créée par cette mission
 * ---------------------------------------------------------------------------
 *
 * §4 le demande en une phrase — « ne crée pas une seconde vérité » — et le
 * dépôt a déjà tranché ce genre de question deux fois : l'état conversationnel
 * de CONVERSATION-R1 est dérivé, le fil aussi. Tout ce que la boucle produit se
 * recalcule à partir de lignes canoniques : messages entrants, votes humains,
 * brouillons, états commerciaux, scores horodatés. Persister le résultat
 * créerait une copie qui se désynchroniserait à la première reclassification —
 * et il faudrait alors décider laquelle croire, question sans bonne réponse.
 *
 * Le coût assumé : la boucle ne sait pas encore dire « cette proposition a déjà
 * été vue et écartée ». C'est le premier chantier de R2, pas une lacune de R1 —
 * une table de propositions n'a de sens que le jour où une proposition atteint
 * un statut au-dessus de `INSUFFICIENT_DATA`.
 */

import { buildStyleProfile, EMPTY_STYLE_PROFILE, type StyleProfile } from '@/lib/conversation/style';
import { topicsCoveredByText, type CoveredTopic } from '@/lib/conversation/state';
import { openingFamily, containsPitch, containsCorporateJargon, proposesCall } from '@/lib/conversation/naturalness';
import type { Sql } from '@/lib/db/sql';
import {
  buildTurnFeedback,
  recordOverrides,
  type HumanTextSource,
  type InboundTurnInput,
  type OverridePair,
  type TurnFeedback,
} from '@/lib/learning/feedback';
import { buildExemplarBank, type Exemplar, type ExemplarCandidate } from '@/lib/learning/exemplars';
import { summarizeFunnel, segmentBy, type FunnelSummary, type OutcomeRow, type SegmentMetrics } from '@/lib/learning/metrics';
import type { OfferReadiness, OfferTimingObservation } from '@/lib/learning/offer';
import {
  deriveOutcome,
  unobservableStages,
  type FunnelStage,
  type ProspectOutcome,
} from '@/lib/learning/outcome';
import { compareOverride, OVERRIDE_DELTAS, type OverrideDelta } from '@/lib/learning/override';
import { buildProposal, type LearningProposal } from '@/lib/learning/proposal';
import { rate, type Rate } from '@/lib/learning/sufficiency';
import {
  buildPreSendFeatures,
  messageFamilyOf,
  SEGMENT_KEYS,
  type MessageFamily,
  type SegmentKey,
  type TimestampedValue,
} from '@/lib/learning/targeting';
import { buildOperatorStyleProfile, type OperatorConversationStyle } from '@/lib/learning/voiceProfile';
import type { OutreachState, ReplyCategory } from '@/lib/replies/taxonomy';

// ---------------------------------------------------------------------------
// Les lignes lues
// ---------------------------------------------------------------------------

interface SentRow {
  prospectId: string;
  firstSentAt: string | Date;
  channel: string;
  manifestId: string | null;
  approvedText: string | null;
  identityReview: string | null;
  zone: string | null;
  niche: string | null;
}

interface InboundRow {
  id: string;
  prospectId: string;
  receivedAt: string | Date;
  bodyText: string;
  provider: string;
  classification: ReplyCategory | null;
  confidence: string | number | null;
  draftId: string | null;
  draftBody: string | null;
  humanText: string | null;
  draftStatus: string | null;
}

interface VoteRow {
  referenceId: string;
  prospectId: string;
  at: string | Date;
  draftBody: string;
  sentBody: string;
}

interface StateRow {
  prospectId: string;
  state: OutreachState;
}

interface CrmRow {
  prospectId: string;
  externalStage: string | null;
}

interface StampedRow {
  prospectId: string;
  at: string | Date;
}

interface ScoreRow extends StampedRow {
  total: string | number | null;
  band: string | null;
}
interface AudienceRow extends StampedRow {
  followers: number | null;
}
interface VerdictRow extends StampedRow {
  verdict: string;
}
interface EvidenceRow extends StampedRow {
  field: string;
}
interface AngleRow extends StampedRow {
  id: string;
}

function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

function numeric(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function groupBy<T extends { prospectId: string }>(rows: readonly T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = map.get(row.prospectId);
    if (bucket === undefined) map.set(row.prospectId, [row]);
    else bucket.push(row);
  }
  return map;
}

function stamped<T, R extends StampedRow>(rows: readonly R[], project: (row: R) => T): TimestampedValue<T>[] {
  return rows.map((row) => ({ at: iso(row.at), value: project(row) }));
}

// ---------------------------------------------------------------------------
// Le rapport
// ---------------------------------------------------------------------------

/** Ce que la boucle n'arrive pas à voir, nommé plutôt que compté comme zéro. */
export interface ObservabilityGaps {
  /** Les barreaux du funnel qu'aucune source ne porte. */
  readonly unobservableStages: readonly FunnelStage[];
  /** Combien de tours entrants n'ont AUCUN texte humain observable en face. */
  readonly turnsWithoutObservableHumanText: number;
  /** Combien de messages entrants n'ont reçu aucune analyse ACTIVE. */
  readonly inboundWithoutAnalysis: number;
  /** Combien de prospects contactés n'ont pas de ligne d'état commercial. */
  readonly prospectsWithoutOutreachState: number;
}

export interface OverrideSummary {
  readonly pairs: number;
  readonly cosmeticOnly: number;
  /** Un taux par transformation : numérateur = occurrences, dénominateur = couples. */
  readonly byDelta: ReadonlyArray<{ readonly delta: OverrideDelta; readonly rate: Rate }>;
}

export interface OfferSummary {
  readonly readinessCounts: Readonly<Record<OfferReadiness, number>>;
  readonly observations: readonly OfferTimingObservation[];
}

export interface LearningReport {
  readonly generatedAt: string;
  readonly corpus: {
    readonly prospectsContacted: number;
    readonly inboundMessages: number;
    readonly prospectsWhoReplied: number;
    readonly analyses: number;
    readonly hermesDrafts: number;
    readonly overridePairs: number;
    readonly range: { readonly from: string | null; readonly to: string | null };
  };
  readonly funnel: FunnelSummary;
  readonly segments: ReadonlyArray<{ readonly key: SegmentKey; readonly rows: readonly SegmentMetrics[] }>;
  readonly overrides: OverrideSummary;
  readonly style: OperatorConversationStyle;
  readonly exemplars: readonly Exemplar[];
  readonly offer: OfferSummary;
  readonly observability: ObservabilityGaps;
  readonly proposals: readonly LearningProposal[];
  /** Les tours, dans l'ordre. Utile en `--json` ; jamais imprimé en clair. */
  readonly turns: readonly TurnFeedback[];
}

// ---------------------------------------------------------------------------
// La lecture
// ---------------------------------------------------------------------------

/**
 * Charge tout, dérive tout, ne persiste rien.
 *
 * `now` est un paramètre plutôt qu'un `new Date()` interne : un rapport doit
 * être reproductible dans un test, et une horloge cachée rend une assertion
 * impossible à écrire.
 */
/**
 * HERMES-CONTROLLED-LIVE-CONVERSATION-CANARY-R1 §9 — ce que ce rapport ne doit
 * PAS apprendre.
 *
 * Un test conversationnel contrôlé produit de vrais envois, de vraies réponses
 * et de vrais brouillons — mais sur une COQUILLE, dont le correspondant est un
 * opérateur qui joue un rôle. Les compter serait apprendre d'une mise en scène :
 * un taux de réponse de 100 %, une objection écrite exprès, un rendez-vous
 * accepté par complaisance. Le profil de voix, les exemplaires et les
 * propositions de ciblage en sortiraient faussés, et rien ne le signalerait.
 *
 * L'exclusion porte sur `shell_prospect_id` et sur les TROIS lectures qui
 * ancrent le rapport — les envois, les réponses, les votes humains. Les autres
 * requêtes sont bornées par `prospect_id in (select … from outreach_events
 * where kind = 'sent')`, donc la première exclusion les vide déjà : un prospect
 * absent de la liste des envois n'a ni score, ni audience, ni verdict à
 * apporter ici.
 *
 * Elle ne regarde pas `revoked_at` : une conversation de test reste une
 * conversation de test après la révocation, et l'apprendre six mois plus tard
 * serait le même défaut, plus tard.
 *
 * Le PERSONA n'a besoin d'aucune exclusion — il n'apparaît dans aucune de ces
 * tables. C'est la propriété que la coquille existe pour tenir.
 */
export async function buildLearningReport(sql: Sql, now: Date = new Date()): Promise<LearningReport> {
  const sent = await sql.query<SentRow>(
    `select distinct on (e.prospect_id)
            e.prospect_id      as "prospectId",
            e.occurred_at      as "firstSentAt",
            e.channel          as "channel",
            e.manifest_id      as "manifestId",
            m.approved_text    as "approvedText",
            p.identity_review  as "identityReview",
            p.department       as "zone",
            c.niche_key        as "niche"
       from outreach_events e
       join prospects p on p.id = e.prospect_id
       left join r6b_dispatch_manifests m on m.id = e.manifest_id
       left join campaigns c on c.id = p.campaign_id
      where e.kind = 'sent'
      order by e.prospect_id, e.occurred_at asc`,
  );

  const inbound = await sql.query<InboundRow>(
    `select i.id                        as "id",
            i.correlated_prospect_id    as "prospectId",
            i.received_at               as "receivedAt",
            i.body_text                 as "bodyText",
            i.provider                  as "provider",
            a.classification            as "classification",
            a.confidence                as "confidence",
            d.id                        as "draftId",
            d.body                      as "draftBody",
            d.human_text                as "humanText",
            d.status                    as "draftStatus"
       from r6b_inbound_messages i
       left join r6b_reply_analyses a on a.inbound_message_id = i.id and a.status = 'ACTIVE'
       left join r6b_reply_drafts d on d.analysis_id = a.id
      where i.correlated_prospect_id is not null
        and i.correlation_status in ('EXACT', 'HIGH_CONFIDENCE')
      order by i.correlated_prospect_id, i.received_at asc, i.id asc`,
  );

  // Les votes HUMAINS sur le premier message. Un vote `AUTONOMOUS_POLICY` est
  // une machine qui approuve une machine : l'apprendre comme une préférence
  // ferait entrer un écho dans le profil.
  const votes = await sql.query<VoteRow>(
    `select v.id                                  as "referenceId",
            bi.prospect_id                        as "prospectId",
            coalesce(v.approved_at, v.created_at) as "at",
            bi.original_draft                     as "draftBody",
            v.approved_text                       as "sentBody"
       from r6b_batch_votes v
       join r6b_batch_items bi on bi.id = v.item_id
      where v.actor_kind = 'HUMAN'
        and v.approved_text is not null
        and bi.original_draft is not null
      order by coalesce(v.approved_at, v.created_at) asc`,
  );

  const states = await sql.query<StateRow>(
    `select prospect_id as "prospectId", state from r6b_prospect_outreach_states`,
  );

  const crm = await sql.query<CrmRow>(
    `select prospect_id as "prospectId", external_stage as "externalStage"
       from r6b_crm_projections
      where status = 'APPLIED'`,
  );

  const scores = await sql.query<ScoreRow>(
    `select prospect_id as "prospectId", created_at as "at", total, band
       from prospect_scores
      where prospect_id in (select prospect_id from outreach_events where kind = 'sent')`,
  );

  const audience = await sql.query<AudienceRow>(
    `select prospect_id as "prospectId", observed_at as "at", followers_count as "followers"
       from prospect_audience_observations
      where prospect_id in (select prospect_id from outreach_events where kind = 'sent')`,
  );

  const icp = await sql.query<VerdictRow>(
    `select prospect_id as "prospectId", created_at as "at", verdict
       from prospect_icp_assessments
      where prospect_id in (select prospect_id from outreach_events where kind = 'sent')`,
  );

  const classifications = await sql.query<VerdictRow>(
    `select prospect_id as "prospectId", created_at as "at", verdict
       from prospect_classifications
      where prospect_id in (select prospect_id from outreach_events where kind = 'sent')`,
  );

  const angles = await sql.query<AngleRow>(
    `select id, prospect_id as "prospectId", created_at as "at"
       from prospect_angles
      where prospect_id in (select prospect_id from outreach_events where kind = 'sent')`,
  );

  const evidence = await sql.query<EvidenceRow>(
    `select prospect_id as "prospectId", coalesce(observed_at, created_at) as "at", field
       from prospect_evidence
      where prospect_id in (select prospect_id from outreach_events where kind = 'sent')`,
  );

  return assembleLearningReport({
    now,
    sent,
    inbound,
    votes,
    states,
    crm,
    scores,
    audience,
    icp,
    classifications,
    angles,
    evidence,
  });
}

interface AssembleInput {
  readonly now: Date;
  readonly sent: readonly SentRow[];
  readonly inbound: readonly InboundRow[];
  readonly votes: readonly VoteRow[];
  readonly states: readonly StateRow[];
  readonly crm: readonly CrmRow[];
  readonly scores: readonly ScoreRow[];
  readonly audience: readonly AudienceRow[];
  readonly icp: readonly VerdictRow[];
  readonly classifications: readonly VerdictRow[];
  readonly angles: readonly AngleRow[];
  readonly evidence: readonly EvidenceRow[];
}

/**
 * Assemble le rapport à partir de lignes déjà lues.
 *
 * Séparée de la lecture pour une raison de test : les scénarios de §25 portent
 * sur la DÉRIVATION, pas sur le SQL. Les exercer sur des lignes en mémoire les
 * rend rapides et déterministes ; le SQL, lui, est exercé une fois sur une
 * vraie base par le test d'intégration.
 */
export function assembleLearningReport(input: AssembleInput): LearningReport {
  const inboundByProspect = groupBy(input.inbound);
  const stateByProspect = new Map(input.states.map((row) => [row.prospectId, row.state]));
  const crmByProspect = new Map(input.crm.map((row) => [row.prospectId, row.externalStage]));
  const scoresByProspect = groupBy(input.scores);
  const audienceByProspect = groupBy(input.audience);
  const icpByProspect = groupBy(input.icp);
  const classificationsByProspect = groupBy(input.classifications);
  const anglesByProspect = groupBy(input.angles);
  const evidenceByProspect = groupBy(input.evidence);

  // --- les couples brouillon → texte retenu -------------------------------
  const pairs: OverridePair[] = [];

  for (const vote of input.votes) {
    pairs.push({
      source: 'FIRST_TOUCH_VOTE',
      prospectId: vote.prospectId,
      referenceId: vote.referenceId,
      at: iso(vote.at),
      draftBody: vote.draftBody,
      sentBody: vote.sentBody,
    });
  }

  for (const row of input.inbound) {
    if (row.draftId === null || row.draftBody === null) continue;
    // `EDITED` porte le texte humain ; `APPROVED` valide la proposition telle
    // quelle — c'est une correction nulle, et une correction nulle est une
    // observation (elle dit que le brouillon convenait).
    const retained = row.draftStatus === 'EDITED' ? row.humanText : row.draftStatus === 'APPROVED' ? row.draftBody : null;
    if (retained === null) continue;
    pairs.push({
      source: 'REPLY_DRAFT',
      prospectId: row.prospectId,
      referenceId: row.draftId,
      at: iso(row.receivedAt),
      draftBody: row.draftBody,
      sentBody: retained,
    });
  }

  const overrideRecords = recordOverrides(pairs);
  const overrideByReference = new Map(overrideRecords.map((record) => [record.referenceId, record]));

  // --- issue et features, prospect par prospect ---------------------------
  const outcomes: ProspectOutcome[] = [];
  const rows: OutcomeRow[] = [];
  const turns: TurnFeedback[] = [];
  const candidates: ExemplarCandidate[] = [];
  const offerObservations: OfferTimingObservation[] = [];
  const readinessCounts: Record<OfferReadiness, number> = { LOW: 0, MEDIUM: 0, HIGH: 0 };

  let inboundWithoutAnalysis = 0;
  let turnsWithoutObservableHumanText = 0;
  let prospectsWithoutOutreachState = 0;

  for (const row of input.sent) {
    const prospectId = row.prospectId;
    const sentAt = iso(row.firstSentAt);
    const messages = inboundByProspect.get(prospectId) ?? [];
    const state = stateByProspect.get(prospectId) ?? null;
    if (state === null) prospectsWithoutOutreachState += 1;

    const approvedText = row.approvedText;
    const family: MessageFamily | null = messageFamilyOf(approvedText);

    // Ce que NOTRE premier message — prouvé parti — a couvert. C'est la seule
    // chose que le dépôt sache lire de nos tours sortants sur Instagram ; les
    // suivants n'ont pas de texte observable, et le rapport le dit.
    const coveredTopics: readonly CoveredTopic[] =
      approvedText === null ? Object.freeze([]) : Object.freeze(topicsCoveredByText(approvedText));

    const classificationsSeen = messages
      .map((message) => message.classification)
      .filter((value): value is ReplyCategory => value !== null);

    const callProposedInValidatedReply = messages.some((message) => {
      const retained =
        message.draftStatus === 'EDITED'
          ? message.humanText
          : message.draftStatus === 'APPROVED'
            ? message.draftBody
            : null;
      return retained !== null && proposesCall(retained);
    });

    const outcome = deriveOutcome({
      prospectId,
      channel: row.channel,
      manifestId: row.manifestId,
      firstSentAt: sentAt,
      inboundAt: messages.map((message) => iso(message.receivedAt)),
      outreachState: state,
      classifications: classificationsSeen,
      callProposedInValidatedReply,
      crmStage: crmByProspect.get(prospectId) ?? null,
    });
    outcomes.push(outcome);

    const features = buildPreSendFeatures({
      prospectId,
      sentAt,
      channel: row.channel,
      approvedText,
      scores: stamped(scoresByProspect.get(prospectId) ?? [], (score) => ({
        total: numeric(score.total),
        band: score.band,
      })),
      audience: stamped(audienceByProspect.get(prospectId) ?? [], (item) => ({ followers: item.followers })),
      icp: stamped(icpByProspect.get(prospectId) ?? [], (item) => ({ verdict: item.verdict })),
      classifications: stamped(classificationsByProspect.get(prospectId) ?? [], (item) => ({
        verdict: item.verdict,
      })),
      angles: stamped(anglesByProspect.get(prospectId) ?? [], () => ({ present: true as const })),
      evidenceFields: stamped(evidenceByProspect.get(prospectId) ?? [], (item) => ({ field: item.field })),
      identityReview: row.identityReview,
      niche: row.niche,
      zone: row.zone,
    });
    rows.push({ features, outcome });

    if (messages.length === 0) continue;

    const turnInputs: InboundTurnInput[] = messages.map((message) => {
      if (message.classification === null) inboundWithoutAnalysis += 1;
      const record = message.draftId === null ? undefined : overrideByReference.get(message.draftId);
      const observability: HumanTextSource = record === undefined ? 'NOT_OBSERVABLE' : 'REPLY_DRAFT';
      if (observability === 'NOT_OBSERVABLE') turnsWithoutObservableHumanText += 1;
      return {
        id: message.id,
        receivedAt: iso(message.receivedAt),
        bodyText: message.bodyText,
        classification: message.classification,
        confidence: numeric(message.confidence),
        draftId: message.draftId,
        override: record?.comparison ?? null,
        humanTextObservability: observability,
      };
    });

    const channel: 'email' | 'instagram_dm' = row.channel === 'instagram' || row.channel === 'instagram_dm' ? 'instagram_dm' : 'email';

    const prospectTurns = buildTurnFeedback({
      prospectId,
      channel,
      turns: turnInputs,
      coveredTopics,
      stageReached: outcome.stage,
    });
    turns.push(...prospectTurns);
    for (const turn of prospectTurns) readinessCounts[turn.offerReadiness] += 1;

    // §15 — le calendrier de l'offre. Le premier message est le seul tour
    // sortant dont le texte soit observable ; s'il explique déjà l'offre, le
    // nombre de tours entrants avant l'offre vaut zéro. Sinon on ne SAIT PAS,
    // et le champ `gap` le dit plutôt qu'un `null` muet.
    const offerInFirstTouch = approvedText !== null && containsPitch(approvedText);
    const callInFirstTouch = approvedText !== null && proposesCall(approvedText);
    const directQuestionBefore = prospectTurns.some((turn) => turn.signals.questionTopic !== 'NONE');
    offerObservations.push(
      Object.freeze({
        prospectId,
        inboundTurnsBeforeOffer: offerInFirstTouch ? 0 : null,
        inboundTurnsBeforeCall: callInFirstTouch ? 0 : null,
        readinessAtOffer: offerInFirstTouch ? (prospectTurns[0]?.offerReadiness ?? null) : null,
        directQuestionBefore,
        reactionAfterOffer: offerInFirstTouch ? (prospectTurns[0]?.classification ?? null) : null,
        gap: offerInFirstTouch && callInFirstTouch ? null : ('OUTBOUND_TEXT_NOT_OBSERVABLE' as const),
      }),
    );

    const style: StyleProfile =
      messages.length === 0
        ? EMPTY_STYLE_PROFILE
        : buildStyleProfile(messages.map((message) => ({ text: message.bodyText, at: iso(message.receivedAt) })));

    candidates.push({ outcome, turns: prospectTurns, prospectStyle: style, messageFamily: family ?? 'PLAIN' });
  }

  // --- profil de voix ------------------------------------------------------
  const style = buildOperatorStyleProfile({
    overrides: pairs.map((pair) => {
      const comparison = compareOverride(pair.draftBody, pair.sentBody);
      return {
        deltas: comparison.deltas,
        sent: comparison.sent,
        draftHadGenericOpening: openingFamily(pair.draftBody) !== null,
        draftHadPitch: containsPitch(pair.draftBody),
        draftHadCall: proposesCall(pair.draftBody),
        draftHadJargon: containsCorporateJargon(pair.draftBody),
        sentHadGenericOpening: openingFamily(pair.sentBody) !== null,
        rewritten: pair.draftBody !== pair.sentBody,
      };
    }),
    humanTexts: [],
    // Le calendrier n'est renseigné que là où il est OBSERVABLE. Les `null`
    // n'entrent pas : compter « offre jamais expliquée » sur une conversation
    // dont les tours sortants sont illisibles serait une absence non vérifiée.
    turnsBeforePitch: offerObservations
      .map((observation) => observation.inboundTurnsBeforeOffer)
      .filter((value): value is number => value !== null),
    turnsBeforeCall: offerObservations
      .map((observation) => observation.inboundTurnsBeforeCall)
      .filter((value): value is number => value !== null),
  });

  // --- agrégats ------------------------------------------------------------
  const overrideSummary: OverrideSummary = Object.freeze({
    pairs: overrideRecords.length,
    cosmeticOnly: overrideRecords.filter((record) => record.comparison.cosmeticOnly).length,
    byDelta: Object.freeze(
      OVERRIDE_DELTAS.map((delta) =>
        Object.freeze({
          delta,
          rate: rate(
            overrideRecords.filter((record) => record.comparison.deltas.includes(delta)).length,
            overrideRecords.length,
          ),
        }),
      ),
    ),
  });

  const timestamps = [
    ...input.sent.map((row) => iso(row.firstSentAt)),
    ...input.inbound.map((row) => iso(row.receivedAt)),
  ].sort();

  const report: LearningReport = Object.freeze({
    generatedAt: input.now.toISOString(),
    corpus: Object.freeze({
      prospectsContacted: input.sent.length,
      inboundMessages: input.inbound.length,
      prospectsWhoReplied: inboundByProspect.size,
      analyses: input.inbound.filter((row) => row.classification !== null).length,
      hermesDrafts: input.inbound.filter((row) => row.draftId !== null).length,
      overridePairs: overrideRecords.length,
      range: Object.freeze({ from: timestamps[0] ?? null, to: timestamps[timestamps.length - 1] ?? null }),
    }),
    funnel: summarizeFunnel(outcomes),
    segments: Object.freeze(SEGMENT_KEYS.map((key) => Object.freeze({ key, rows: segmentBy(rows, key) }))),
    overrides: overrideSummary,
    style,
    exemplars: buildExemplarBank(candidates),
    offer: Object.freeze({ readinessCounts: Object.freeze(readinessCounts), observations: Object.freeze(offerObservations) }),
    observability: Object.freeze({
      unobservableStages: unobservableStages(),
      turnsWithoutObservableHumanText,
      inboundWithoutAnalysis,
      prospectsWithoutOutreachState,
    }),
    proposals: Object.freeze([]),
    turns: Object.freeze(turns),
  });

  return Object.freeze({ ...report, proposals: buildProposals(report) });
}

// ---------------------------------------------------------------------------
// Les propositions
// ---------------------------------------------------------------------------

/**
 * Traduit le rapport en propositions.
 *
 * Aucune n'est filtrée sur son statut : une proposition `INSUFFICIENT_DATA` est
 * produite et affichée. C'est délibéré — la taire ferait croire que la boucle
 * n'a rien vu, alors qu'elle a vu quelque chose et refuse de s'y fier.
 */
export function buildProposals(report: LearningReport): readonly LearningProposal[] {
  const proposals: LearningProposal[] = [];
  const range = report.corpus.range;

  // --- style ---------------------------------------------------------------
  const topDelta = [...report.overrides.byDelta]
    .filter((entry) => entry.rate.numerator > 0)
    .sort((left, right) => right.rate.numerator - left.rate.numerator)[0];

  proposals.push(
    buildProposal({
      type: 'CONVERSATION_STYLE',
      status: topDelta?.rate.status ?? 'INSUFFICIENT_DATA',
      sampleSize: report.overrides.pairs,
      proposal:
        topDelta === undefined
          ? "Aucune correction humaine exploitable : les textes retenus sont identiques aux brouillons, ou leur texte n'est pas observable."
          : `Correction humaine la plus fréquente : ${topDelta.delta}. À confirmer avant d'en faire une consigne de rédaction.`,
      evidence: Object.freeze({
        metric: topDelta === undefined ? 'override_pairs' : `override_delta:${topDelta.delta}`,
        rate: topDelta?.rate ?? rate(0, report.overrides.pairs),
        references: Object.freeze([]),
        range,
      }),
    }),
  );

  // --- ciblage -------------------------------------------------------------
  const familySegment = report.segments.find((segment) => segment.key === 'messageFamily');
  const best = familySegment?.rows[0];
  const repliedRate = best?.stages.find((stage) => stage.stage === 'REPLIED')?.rate ?? null;

  proposals.push(
    buildProposal({
      type: 'TARGETING',
      status: repliedRate?.status ?? 'INSUFFICIENT_DATA',
      sampleSize: best?.sent ?? 0,
      proposal:
        best === undefined
          ? 'Aucun segment mesurable : aucun prospect contacté ne porte de message lisible.'
          : `Famille de message la plus avancée sur le funnel : ${best.value} (progression moyenne ${best.meanProgression.toFixed(2)}). Le taux de réponse seul ne suffit pas à trancher.`,
      evidence: Object.freeze({
        metric: 'message_family_progression',
        rate: repliedRate,
        references: Object.freeze([]),
        range,
      }),
    }),
  );

  // --- offre ---------------------------------------------------------------
  const highReadiness = report.offer.readinessCounts.HIGH;
  const totalTurns = report.turns.length;
  proposals.push(
    buildProposal({
      type: 'OFFER_TIMING',
      status: rate(highReadiness, totalTurns).status,
      sampleSize: totalTurns,
      proposal:
        highReadiness === 0
          ? "Aucun tour observé n'atteint une maturité HIGH pour une explication de l'offre."
          : `${highReadiness} tour(s) sur ${totalTurns} atteignent une maturité HIGH. Observation seule : aucune règle d'exposition n'est proposée à ce stade.`,
      evidence: Object.freeze({
        metric: 'offer_readiness_high',
        rate: rate(highReadiness, totalTurns),
        references: Object.freeze([]),
        range,
      }),
    }),
  );

  // --- observabilité -------------------------------------------------------
  proposals.push(
    buildProposal({
      type: 'OBSERVABILITY',
      status: 'INSUFFICIENT_DATA',
      sampleSize: report.corpus.prospectsContacted,
      proposal:
        `Barreaux non observables : ${report.observability.unobservableStages.join(', ') || 'aucun'}. ` +
        `${report.observability.turnsWithoutObservableHumanText} tour(s) entrants sans texte humain observable en face, ` +
        `${report.observability.inboundWithoutAnalysis} message(s) entrant(s) sans analyse ACTIVE.`,
      evidence: Object.freeze({
        metric: 'observability_gaps',
        rate: null,
        references: Object.freeze([]),
        range,
      }),
    }),
  );

  return Object.freeze(proposals);
}
