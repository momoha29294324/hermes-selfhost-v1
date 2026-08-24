/**
 * HERMES-AUTO-REPLY-PRODUCTION-R1 §2 — l'ENVELOPPE POSITIVE d'éligibilité.
 *
 * ---------------------------------------------------------------------------
 * Le principe, et la phrase qu'il remplace
 * ---------------------------------------------------------------------------
 * « Auto-réponse » ne veut PAS dire « répondre à tout DM visible dans le
 * compte ». Cette phrase-là n'a jamais été écrite dans ce dépôt, mais elle
 * était atteignable : le runner du test contrôlé regardait UNE coquille par
 * identifiant, et rien n'existait qui dise ce qu'un runtime généraliste aurait
 * le droit de regarder.
 *
 * Le principe retenu est l'inverse d'une liste noire :
 *
 *     pas de PREUVE POSITIVE d'éligibilité → pas de réponse autonome.
 *
 * Chaque fait ci-dessous est une preuve qui doit EXISTER. Un fait manquant,
 * illisible ou ambigu refuse — jamais « probablement bon ».
 *
 * ---------------------------------------------------------------------------
 * Ce que ce module N'EST PAS
 * ---------------------------------------------------------------------------
 * Il ne remplace ni `decideAutonomousReply` (les portes de CONTENU : sécurité,
 * escalade, naturalité, politique commerciale), ni
 * `evaluateConversationEffectGate` (les portes d'EFFET : arrêt global,
 * plafonds, fenêtre, cadence, fraîcheur, identité, versions). Les deux restent
 * intégralement DEVANT, et sont seules à décider qu'un message part.
 *
 * Il répond à la question qui les précède, et qu'aucune des deux ne posait :
 * « cette conversation appartient-elle au périmètre du rail autonome ? ».
 * C'est ce qui évite d'INSCRIRE une intention — donc d'ouvrir un navigateur,
 * donc de consommer un bail — sur un fil qui n'a rien à y faire.
 *
 * ---------------------------------------------------------------------------
 * Strictement plus stricte, jamais plus indulgente
 * ---------------------------------------------------------------------------
 * Là où cette lecture recouvre une garde existante — l'exclusion, l'état
 * commercial, l'identité, la fraîcheur —, elle est écrite pour refuser AU MOINS
 * autant. Un test le vérifie sur la fraîcheur, qui est le seul point où les
 * deux lectures pouvaient diverger : `replyStaleness` laisse passer deux
 * messages de même horodatage portant des identifiants différents, ici non.
 *
 * ---------------------------------------------------------------------------
 * Aucune exception nominative
 * ---------------------------------------------------------------------------
 * `assessAutoReplyEligibility` est PURE et ne reçoit ni prospect nommé, ni
 * compte, ni campagne, ni coquille : il n'existe aucune donnée depuis laquelle
 * une exception pourrait être écrite. Un test lit cette source pour le
 * confirmer.
 */

import { loadConversationGuards } from '@/lib/conversation/guards';
import { CONVERSATION_TERMINAL_OUTREACH_STATES } from '@/lib/conversation/preEffect';
import { REPLY_CLASSIFIER_PROMPT_VERSION } from '@/lib/replies/classifier';
import type { OutreachState } from '@/lib/replies/taxonomy';
import type { Sql } from '@/lib/db/sql';

/**
 * Pourquoi cette conversation n'entre pas dans le périmètre autonome, dans un
 * vocabulaire FERMÉ. Chaque valeur a dû être nommée dans un diff.
 */
export type AutoReplyEligibilityRefusal =
  /** Aucune activation vivante. Le défaut du dépôt, et l'état de repos. */
  | 'RUNTIME_NOT_ACTIVATED'
  /** Le message est antérieur à la frontière — c'est du retard historique. */
  | 'BEFORE_ACTIVATION_FRONTIER'
  /** Corrélation absente ou trop faible : rien ne rattache ce message à un envoi. */
  | 'NOT_CORRELATED'
  /** Aucun premier contact Hermes prouvé : ni manifeste verrouillé, ni envoi attesté. */
  | 'NO_HERMES_FIRST_TOUCH'
  /** Le canal n'est pas celui qu'un rail de réponse sait servir. */
  | 'CHANNEL_UNSUPPORTED'
  | 'PROSPECT_SUPPRESSED'
  | 'CONVERSATION_CLOSED'
  | 'IDENTITY_UNCONFIRMED'
  /** Plusieurs messages portent la même heure : « le dernier » y est un tirage. */
  | 'IDENTITY_AMBIGUOUS'
  /** Un tour plus récent existe : celui-ci n'est plus la question posée. */
  | 'SUPERSEDED_BY_NEWER_TURN'
  /** Cette bulle a été LUE dans le tour qui la clôt ; elle n'a pas de tour à elle. */
  | 'ABSORBED_INTO_BURST'
  /** Le rail entrant n'a pas encore compris ce tour. Il reviendra seul. */
  | 'NOT_UNDERSTOOD_YET'
  /** Il l'a compris sous une consigne que plus aucun code ne produit. */
  | 'ANALYSIS_VERSION_STALE'
  /** Un effet a déjà été tenté sur ce déclencheur. On ne rejoue pas. */
  | 'EFFECT_ALREADY_ATTEMPTED';

export interface AutoReplyEligibilityFacts {
  readonly inboundMessageId: string;
  /** L'heure de réception. `null` ou illisible ⇒ traitée comme antérieure. */
  readonly receivedAt: string | null;
  /** La frontière d'activation. `null` ⇒ aucun runtime armé. */
  readonly frontierAt: string | null;
  readonly correlationStatus: string | null;
  /** L'identifiant du manifeste verrouillé qui a porté le premier contact. */
  readonly firstTouchManifestId: string | null;
  /** L'événement d'envoi qui atteste que ce premier contact est réellement parti. */
  readonly firstTouchOutreachEventId: string | null;
  /** Le transport de ce premier contact (`instagram`, `email`, …). */
  readonly firstTouchTransport: string | null;
  readonly suppressed: boolean;
  readonly outreachState: OutreachState | null;
  readonly identityConfirmed: boolean;
  readonly latestInboundId: string | null;
  readonly latestInboundTies: number;
  readonly absorbedIntoBurst: boolean;
  readonly analysisStatus: string | null;
  readonly analysisPromptVersion: string | null;
  readonly effectAttemptedOnTrigger: boolean;
}

export type AutoReplyEligibilityVerdict =
  | { readonly eligible: true; readonly detail: string }
  | {
      readonly eligible: false;
      readonly refusal: AutoReplyEligibilityRefusal;
      readonly detail: string;
      /**
       * Ce refus peut-il cesser sans qu'un humain ne décide quoi que ce soit ?
       * `true` ⇒ un fait nouveau suffit (un tour compris, une salve close) ;
       * `false` ⇒ la réponse est durable, ou elle appartient à un humain.
       */
      readonly reconsiderable: boolean;
    };

/** Les corrélations qu'une action commerciale peut suivre. Deux, jamais plus. */
const PROCESSABLE_CORRELATIONS: ReadonlySet<string> = new Set(['EXACT', 'HIGH_CONFIDENCE']);

/**
 * Le seul transport dont une réponse autonome existe dans ce dépôt.
 *
 * `instagram_dm`, le vocabulaire de `r6b_dispatch_manifests.transport` — le
 * même que celui du canal d'un plan. Un premier contact parti par e-mail, par
 * WhatsApp ou par Messenger n'a pas de rail de réponse : répondre « ailleurs »
 * serait un contact NEUF sur un canal que personne n'a autorisé.
 */
const SUPPORTED_FIRST_TOUCH_TRANSPORT = 'instagram_dm';

function refuse(
  refusal: AutoReplyEligibilityRefusal,
  detail: string,
  reconsiderable: boolean,
): AutoReplyEligibilityVerdict {
  return Object.freeze({ eligible: false as const, refusal, detail, reconsiderable });
}

function instant(value: string | null): number {
  if (value === null) return Number.NaN;
  return Date.parse(value);
}

/**
 * Cette conversation entre-t-elle dans le périmètre du rail autonome ?
 *
 * L'ordre descend du plus GÉNÉRAL au plus particulier, comme le crochet
 * pré-effet : ce qui ferme tout d'abord (l'activation, la frontière), ce qui
 * qualifie la relation ensuite (corrélation, premier contact, canal), ce qui
 * décrit le prospect après (exclusion, état, identité), et ce qui décrit CE
 * tour en dernier (fraîcheur, absorption, compréhension, effet déjà tenté).
 */
export function assessAutoReplyEligibility(
  facts: AutoReplyEligibilityFacts,
): AutoReplyEligibilityVerdict {
  // ---- 1. Le rail est-il armé ? -------------------------------------------
  if (facts.frontierAt === null) {
    return refuse(
      'RUNTIME_NOT_ACTIVATED',
      'aucune activation vivante — le rail d’auto-réponse est au repos, ce qui est son défaut',
      true,
    );
  }
  const frontier = instant(facts.frontierAt);
  if (!Number.isFinite(frontier)) {
    return refuse(
      'RUNTIME_NOT_ACTIVATED',
      'la frontière d’activation est illisible — le côté sûr est de considérer le rail fermé',
      false,
    );
  }

  // ---- 2. La FRONTIÈRE ----------------------------------------------------
  const received = instant(facts.receivedAt);
  if (!Number.isFinite(received)) {
    return refuse(
      'BEFORE_ACTIVATION_FRONTIER',
      'l’heure de réception de ce message est illisible — impossible d’établir qu’il est postérieur ' +
        'à l’activation, donc il est traité comme antérieur',
      false,
    );
  }
  if (received < frontier) {
    return refuse(
      'BEFORE_ACTIVATION_FRONTIER',
      `reçu le ${String(facts.receivedAt)}, antérieur à la frontière d’activation ` +
        `(${facts.frontierAt}) — allumer un runtime ne répond pas au retard historique`,
      false,
    );
  }

  // ---- 3. La RELATION : Hermes a-t-il écrit le premier, ici ? -------------
  if (facts.correlationStatus === null || !PROCESSABLE_CORRELATIONS.has(facts.correlationStatus)) {
    return refuse(
      'NOT_CORRELATED',
      `corrélation « ${facts.correlationStatus ?? 'aucune'} » — rien ne rattache ce message à un ` +
        'envoi Hermes ; un DM d’inconnu n’est pas une conversation commerciale',
      false,
    );
  }
  if (facts.firstTouchManifestId === null || facts.firstTouchOutreachEventId === null) {
    return refuse(
      'NO_HERMES_FIRST_TOUCH',
      'aucun premier contact Hermes prouvé — il faut un manifeste verrouillé ET un envoi attesté, ' +
        'pas seulement un fil qui existe',
      false,
    );
  }
  if (facts.firstTouchTransport !== SUPPORTED_FIRST_TOUCH_TRANSPORT) {
    return refuse(
      'CHANNEL_UNSUPPORTED',
      `le premier contact est parti par « ${facts.firstTouchTransport ?? 'inconnu'} » — ce rail ne ` +
        'sait remettre que des DM Instagram, et répondre sur un autre canal serait un contact neuf',
      false,
    );
  }

  // ---- 4. Le PROSPECT ------------------------------------------------------
  if (facts.suppressed) {
    return refuse(
      'PROSPECT_SUPPRESSED',
      'ce commerce figure dans do_not_contact — aucune intention n’est même inscrite',
      false,
    );
  }
  if (facts.outreachState !== null && CONVERSATION_TERMINAL_OUTREACH_STATES.includes(facts.outreachState)) {
    return refuse(
      'CONVERSATION_CLOSED',
      `l'état commercial est ${facts.outreachState} — la conversation est close`,
      false,
    );
  }
  if (!facts.identityConfirmed) {
    return refuse(
      'IDENTITY_UNCONFIRMED',
      'le rapprochement entreprise ↔ compte n’est pas établi — un fil peut être tenu par quelqu’un ' +
        'd’autre que le commerce qu’on croit avoir joint',
      true,
    );
  }

  // ---- 5. CE tour ----------------------------------------------------------
  if (facts.absorbedIntoBurst) {
    return refuse(
      'ABSORBED_INTO_BURST',
      'cette bulle a été lue à l’intérieur du tour qui la clôt — elle n’a pas de tour à elle',
      false,
    );
  }
  if (facts.latestInboundId === null || facts.latestInboundId !== facts.inboundMessageId) {
    return refuse(
      'SUPERSEDED_BY_NEWER_TURN',
      `un message plus récent existe dans cette conversation (${facts.latestInboundId ?? 'indéterminé'}) — ` +
        'on répond à la dernière phrase, jamais à une phrase dépassée',
      true,
    );
  }
  if (facts.latestInboundTies > 1) {
    return refuse(
      'IDENTITY_AMBIGUOUS',
      `${String(facts.latestInboundTies)} messages portent la même heure de réception — « le plus ` +
        'récent » y est désigné par un identifiant aléatoire, pas par le temps',
      true,
    );
  }
  if (facts.analysisStatus !== 'ACTIVE') {
    return refuse(
      'NOT_UNDERSTOOD_YET',
      'aucune lecture vivante de ce tour — le rail entrant ne l’a pas encore compris, il reviendra seul',
      true,
    );
  }
  if (facts.analysisPromptVersion !== REPLY_CLASSIFIER_PROMPT_VERSION) {
    return refuse(
      'ANALYSIS_VERSION_STALE',
      `ce tour a été lu sous « ${facts.analysisPromptVersion ?? 'inconnue'} » et la lecture courante ` +
        `est « ${REPLY_CLASSIFIER_PROMPT_VERSION} » — une compréhension rendue sous d'autres règles ` +
        'ne les couvre pas',
      true,
    );
  }
  if (facts.effectAttemptedOnTrigger) {
    return refuse(
      'EFFECT_ALREADY_ATTEMPTED',
      'un effet a déjà été tenté sur ce déclencheur — « on a essayé, on ne sait pas » ne se résout ' +
        'pas en réessayant',
      false,
    );
  }

  return Object.freeze({
    eligible: true as const,
    detail:
      'premier contact Hermes prouvé sur Instagram, identité établie, conversation ouverte, ' +
      'tour compris sous la lecture courante, postérieur à la frontière d’activation',
  });
}

// ---------------------------------------------------------------------------
// La lecture — sélection POSITIVE, jamais un filtre a posteriori
// ---------------------------------------------------------------------------

export interface AutoReplyCandidate {
  readonly inboundMessageId: string;
  readonly prospectId: string;
  readonly receivedAt: string;
  readonly displayName: string;
  readonly handle: string | null;
  readonly classification: string;
  readonly bodyPreview: string;
}

/**
 * Les conversations qu'un runtime autonome a le droit de considérer.
 *
 * La requête est POSITIVE : chaque jointure est une preuve qui doit exister
 * (le manifeste verrouillé, l'envoi attesté, la fiche prospect, la lecture
 * vivante). Filtrer après coup aurait laissé un jour quelqu'un oublier un
 * filtre ; ici, il n'y a rien à oublier — il n'y a que ce que les jointures
 * ramènent.
 *
 * `assessAutoReplyEligibility` reste appelée sur chaque candidat, et c'est
 * elle qui fait autorité : cette requête est une PRÉSÉLECTION, elle ne prouve
 * rien à elle seule. Les deux doivent conclure la même chose, et un test le
 * vérifie sur une base réelle.
 */
export async function loadAutoReplyCandidates(
  sql: Sql,
  input: { readonly frontierAt: string; readonly limit?: number },
): Promise<readonly AutoReplyCandidate[]> {
  const bounded = Math.min(50, Math.max(1, Math.trunc(input.limit ?? 10)));
  const rows = await sql.query<{
    inboundMessageId: string;
    prospectId: string;
    receivedAt: string | Date;
    displayName: string;
    handle: string | null;
    classification: string;
    bodyPreview: string;
  }>(
    `select i.id                       as "inboundMessageId",
            p.id                       as "prospectId",
            i.received_at              as "receivedAt",
            p.display_name             as "displayName",
            p.instagram_handle         as "handle",
            a.classification           as "classification",
            left(i.body_text, 160)     as "bodyPreview"
       from r6b_inbound_messages i
       -- Le premier contact : un manifeste VERROUILLÉ, et un envoi ATTESTÉ.
       -- Deux jointures et non une : un manifeste dit ce qu'on a écrit, un
       -- événement dit que c'est parti.
       join r6b_dispatch_manifests m on m.id = i.correlated_manifest_id
       join outreach_events        e on e.id = i.correlated_outreach_event_id
       join prospects              p on p.id = i.correlated_prospect_id
       -- La lecture VIVANTE de ce tour, sous la consigne courante.
       join r6b_reply_analyses     a on a.inbound_message_id = i.id and a.status = 'ACTIVE'
      where i.provider = 'instagram'
        and i.correlation_status in ('EXACT', 'HIGH_CONFIDENCE')
        and m.transport = $1
        and a.prompt_version = $2
        -- La FRONTIÈRE. Le retard historique est lisible, il n'est pas du travail.
        and i.received_at >= $3::timestamptz
        -- Une bulle absorbée a été lue dans le tour qui la clôt.
        and not exists (
          select 1 from r6b_inbound_burst_absorptions b
           where b.inbound_message_id = i.id)
        -- Le DERNIER message de sa conversation, et lui seul.
        and not exists (
          select 1 from r6b_inbound_messages n
           where n.correlated_prospect_id = i.correlated_prospect_id
             and n.correlation_status in ('EXACT', 'HIGH_CONFIDENCE')
             and (n.received_at, n.id) > (i.received_at, i.id))
        -- Aucun effet déjà tenté sur ce déclencheur, quel qu'en soit le plan.
        and not exists (
          select 1 from hermes_conversation_plans c
           where c.trigger_inbound_message_id = i.id
             and c.external_effect_attempted = true)
      order by i.received_at asc, i.id asc
      limit $4`,
    [SUPPORTED_FIRST_TOUCH_TRANSPORT, REPLY_CLASSIFIER_PROMPT_VERSION, input.frontierAt, bounded],
  );
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        inboundMessageId: row.inboundMessageId,
        prospectId: row.prospectId,
        receivedAt: new Date(row.receivedAt).toISOString(),
        displayName: row.displayName,
        handle: row.handle,
        classification: row.classification,
        bodyPreview: row.bodyPreview,
      }),
    ),
  );
}

/**
 * Les faits d'éligibilité d'UN message.
 *
 * Deux lectures, et le partage entre elles n'est pas arbitraire :
 *
 *   * ce qui décrit le MESSAGE — corrélation, premier contact, absorption,
 *     lecture vivante, effet déjà tenté — est lu ici, en une requête ;
 *   * ce qui décrit le PROSPECT — exclusion, état commercial, identité,
 *     dernier message reçu — est lu par `loadConversationGuards`, c'est-à-dire
 *     par la MÊME fonction que le crochet pré-effet.
 *
 * Recopier la seconde requête aurait été le défaut que ce dépôt referme à
 * chaque round : deux lectures voisines du même fait finissent par diverger sur
 * un `lower()` ou un `order by`, et c'est toujours la plus indulgente qui tient
 * la porte. Il n'y a donc qu'une seule lecture d'identité et d'exclusion dans
 * tout le rail de réponse, et cette fonction en est un appelant de plus.
 *
 * Rend `null` quand le message n'existe pas — « je n'ai pas trouvé » n'est pas
 * « rien ne s'y oppose », et l'appelant doit le traiter comme un refus.
 */
export async function loadAutoReplyEligibilityFacts(
  sql: Sql,
  inboundMessageId: string,
  frontierAt: string | null,
): Promise<AutoReplyEligibilityFacts | null> {
  const rows = await sql.query<{
    receivedAt: string | Date;
    correlationStatus: string | null;
    firstTouchManifestId: string | null;
    firstTouchOutreachEventId: string | null;
    firstTouchTransport: string | null;
    prospectId: string | null;
    absorbed: boolean;
    analysisStatus: string | null;
    analysisPromptVersion: string | null;
    effectAttempted: boolean;
  }>(
    `select
       i.received_at            as "receivedAt",
       i.correlation_status     as "correlationStatus",
       m.id                     as "firstTouchManifestId",
       e.id                     as "firstTouchOutreachEventId",
       m.transport              as "firstTouchTransport",
       i.correlated_prospect_id as "prospectId",
       exists (select 1 from r6b_inbound_burst_absorptions b
                where b.inbound_message_id = i.id)              as "absorbed",
       a.status                 as "analysisStatus",
       a.prompt_version         as "analysisPromptVersion",
       exists (select 1 from hermes_conversation_plans c
                where c.trigger_inbound_message_id = i.id
                  and c.external_effect_attempted = true)       as "effectAttempted"
     from r6b_inbound_messages i
     left join r6b_dispatch_manifests m on m.id = i.correlated_manifest_id
     left join outreach_events        e on e.id = i.correlated_outreach_event_id
     left join r6b_reply_analyses     a on a.inbound_message_id = i.id and a.status = 'ACTIVE'
    where i.id = $1`,
    [inboundMessageId],
  );

  const row = rows[0];
  if (row === undefined) return null;

  // Un message sans prospect corrélé n'a pas de gardes à lire, et n'en aura
  // pas : `NOT_CORRELATED` le refusera. On rend un état qui refuse tout plutôt
  // que d'interroger `loadConversationGuards` avec un identifiant absent.
  const guards =
    row.prospectId === null ? null : await loadConversationGuards(sql, row.prospectId, 'instagram_dm');

  return Object.freeze({
    inboundMessageId,
    receivedAt: new Date(row.receivedAt).toISOString(),
    frontierAt,
    correlationStatus: row.correlationStatus,
    firstTouchManifestId: row.firstTouchManifestId,
    firstTouchOutreachEventId: row.firstTouchOutreachEventId,
    firstTouchTransport: row.firstTouchTransport,
    suppressed: guards?.suppressed ?? true,
    outreachState: guards?.outreachState ?? null,
    identityConfirmed: guards?.identityConfirmed ?? false,
    latestInboundId: guards?.latestInboundId ?? null,
    latestInboundTies: guards?.latestInboundTies ?? 0,
    absorbedIntoBurst: row.absorbed,
    analysisStatus: row.analysisStatus,
    analysisPromptVersion: row.analysisPromptVersion,
    effectAttemptedOnTrigger: row.effectAttempted,
  });
}
