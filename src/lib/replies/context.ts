/**
 * R6B-D2 — le contexte EXACT qu'un modèle reçoit, et rien d'autre.
 *
 * Ce fichier existe pour une raison de sécurité autant que de qualité : §4 de
 * la mission interdit d'envoyer du contenu de boîte mail sans rapport à un
 * modèle. La façon la plus sûre de tenir cette promesse n'est pas de filtrer
 * après coup, c'est de n'avoir qu'un seul constructeur de contexte, qui part
 * d'un `r6b_inbound_messages.id` DÉJÀ corrélé et ne lit que ce que la
 * corrélation a désigné : ce message, son manifeste, son prospect, sa
 * recherche, son angle. Rien n'y entre par une autre porte — il n'y a pas
 * d'autre porte.
 *
 * Le contexte est aussi ce qui est HACHÉ (`hashReplyContext`). Deux traitements
 * qui posent la même question au même modèle avec le même prompt produisent la
 * même empreinte, donc la même ligne d'analyse : c'est de là que vient
 * l'idempotence, pas d'un `select` préalable.
 */

import { createHash } from 'node:crypto';
import type { Sql } from '@/lib/db/sql';
import type { CorrelationStatus } from '@/lib/inbound/correlation';
import type { OutreachState, ProcessableCorrelation } from '@/lib/replies/taxonomy';
import { isProcessableCorrelation } from '@/lib/replies/taxonomy';

/** Le premier message parti, tel que le manifeste verrouillé le porte. */
export interface FirstTouch {
  readonly manifestId: string;
  readonly transport: string;
  readonly recipient: string;
  readonly subject: string | null;
  readonly body: string;
  readonly sentAt: string | null;
  readonly businessName: string;
  readonly legalName: string | null;
}

/** Ce que la recherche a réellement observé sur ce prospect. */
export interface GroundedResearch {
  readonly summary: string;
  readonly observations: readonly string[];
  readonly opportunities: readonly string[];
  /** Ce qui est explicitement NON observé. Un modèle qui l'ignore invente. */
  readonly unknowns: readonly string[];
  readonly confidence: number;
}

export interface GroundedAngle {
  readonly painPoint: string;
  readonly opportunity: string;
  readonly approach: string;
  readonly personalization: string;
}

export interface ProspectFacts {
  readonly id: string;
  readonly displayName: string;
  readonly legalName: string | null;
  readonly brandName: string | null;
  readonly city: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly websiteUrl: string | null;
  readonly instagramHandle: string | null;
  readonly score: number | null;
  readonly scoreBand: string | null;
}

export interface InboundReplyFacts {
  readonly id: string;
  readonly receivedAt: string;
  readonly fromAddress: string;
  readonly fromDisplay: string | null;
  readonly subject: string | null;
  readonly bodyText: string;
  readonly bodySha256: string;
  readonly automationSignals: readonly string[];
  readonly correlationStatus: ProcessableCorrelation;
  readonly correlationMethod: string | null;
}

export interface ReplyContext {
  readonly reply: InboundReplyFacts;
  readonly prospect: ProspectFacts;
  readonly firstTouch: FirstTouch;
  readonly research: GroundedResearch | null;
  readonly angle: GroundedAngle | null;
  /** L'état commercial courant, `null` si le prospect n'en a pas encore. */
  readonly currentState: OutreachState | null;
  readonly outreachEventId: string;
}

/**
 * Bornes du corps transmis au modèle.
 *
 * Une réponse de prospect fait quelques lignes ; au-delà, ce sont des citations
 * du fil, une signature d'entreprise ou un disclaimer juridique. Tronquer haut
 * (8 000 caractères) garde tout ce qui compte sans transformer un prompt en
 * transcription de conversation. Le corps entier reste en base, intact.
 */
export const MAX_REPLY_BODY_CHARS = 8_000;
export const MAX_FIRST_TOUCH_CHARS = 4_000;

export function clampBody(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[…tronqué à ${max} caractères pour le prompt ; corps intégral en base]`;
}

interface ContextRow {
  inboundId: string;
  receivedAt: string | Date;
  fromAddress: string;
  fromDisplay: string | null;
  subject: string | null;
  bodyText: string;
  bodySha256: string;
  automationSignals: unknown;
  correlationStatus: CorrelationStatus;
  correlationMethod: string | null;
  outreachEventId: string;
  sentAt: string | Date | null;
  manifestId: string;
  transport: string | null;
  recipient: string;
  transportPayload: unknown;
  approvedText: string;
  businessName: string;
  manifestLegalName: string | null;
  prospectId: string;
  displayName: string;
  legalName: string | null;
  brandName: string | null;
  city: string | null;
  email: string | null;
  phone: string | null;
  websiteUrl: string | null;
  instagramHandle: string | null;
  score: number | null;
  scoreBand: string | null;
  currentState: OutreachState | null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)).filter((entry) => entry.length > 0) : [];
}

/**
 * Charge le contexte d'une réponse corrélée.
 *
 * Rend `null` plutôt que de lever quand le message n'existe pas ou n'est pas
 * exploitable : « ce message n'est pas traitable » est une réponse normale du
 * pipeline (un `REVIEW_REQUIRED` en est un), pas une panne.
 */
export async function loadReplyContext(sql: Sql, inboundMessageId: string): Promise<ReplyContext | null> {
  const rows = await sql.query<ContextRow>(
    `select i.id                            as "inboundId",
            i.received_at                   as "receivedAt",
            i.from_address                  as "fromAddress",
            i.from_display                  as "fromDisplay",
            i.subject,
            i.body_text                     as "bodyText",
            i.body_sha256                   as "bodySha256",
            i.automation_signals            as "automationSignals",
            i.correlation_status            as "correlationStatus",
            i.correlation_method            as "correlationMethod",
            i.correlated_outreach_event_id  as "outreachEventId",
            e.occurred_at                   as "sentAt",
            m.id                            as "manifestId",
            m.transport,
            m.recipient,
            m.transport_payload             as "transportPayload",
            m.approved_text                 as "approvedText",
            m.business_name                 as "businessName",
            m.legal_name                    as "manifestLegalName",
            p.id                            as "prospectId",
            p.display_name                  as "displayName",
            p.legal_name                    as "legalName",
            p.brand_name                    as "brandName",
            p.city,
            p.email,
            p.phone,
            p.website_url                   as "websiteUrl",
            p.instagram_handle              as "instagramHandle",
            p.score,
            p.score_band                    as "scoreBand",
            s.state                         as "currentState"
       from r6b_inbound_messages i
       join r6b_dispatch_manifests m on m.id = i.correlated_manifest_id
       join prospects p on p.id = i.correlated_prospect_id
       join outreach_events e on e.id = i.correlated_outreach_event_id
       left join r6b_prospect_outreach_states s on s.prospect_id = p.id
      where i.id = $1`,
    [inboundMessageId],
  );

  const row = rows[0];
  if (!row) return null;
  // Défense en profondeur : la contrainte `r6b_inbound_correlated_is_complete`
  // rend déjà impossible qu'un non-corrélé arrive ici (les jointures
  // échoueraient), mais le contexte ne se construit qu'à partir d'un statut
  // explicitement traitable — jamais « tout ce qui a un manifeste ».
  if (!isProcessableCorrelation(row.correlationStatus)) return null;

  const payload = (row.transportPayload ?? {}) as Record<string, unknown>;
  const subject = typeof payload['subject'] === 'string' ? payload['subject'] : null;

  const research = await loadLatestResearch(sql, row.prospectId);
  const angle = await loadLatestAngle(sql, row.prospectId);

  return Object.freeze({
    reply: Object.freeze({
      id: row.inboundId,
      receivedAt: new Date(row.receivedAt).toISOString(),
      fromAddress: row.fromAddress,
      fromDisplay: row.fromDisplay,
      subject: row.subject,
      bodyText: row.bodyText,
      bodySha256: row.bodySha256,
      automationSignals: Object.freeze(stringArray(row.automationSignals)),
      correlationStatus: row.correlationStatus,
      correlationMethod: row.correlationMethod,
    }),
    prospect: Object.freeze({
      id: row.prospectId,
      displayName: row.displayName,
      legalName: row.legalName,
      brandName: row.brandName,
      city: row.city,
      email: row.email,
      phone: row.phone,
      websiteUrl: row.websiteUrl,
      instagramHandle: row.instagramHandle,
      score: row.score === null ? null : Number(row.score),
      scoreBand: row.scoreBand,
    }),
    firstTouch: Object.freeze({
      manifestId: row.manifestId,
      transport: row.transport ?? 'email',
      recipient: row.recipient,
      subject,
      body: row.approvedText,
      sentAt: row.sentAt === null ? null : new Date(row.sentAt).toISOString(),
      businessName: row.businessName,
      legalName: row.manifestLegalName,
    }),
    research,
    angle,
    currentState: row.currentState,
    outreachEventId: row.outreachEventId,
  });
}

async function loadLatestResearch(sql: Sql, prospectId: string): Promise<GroundedResearch | null> {
  const rows = await sql.query<{
    summary: string;
    observations: unknown;
    opportunities: unknown;
    unknowns: unknown;
    confidence: string | number;
  }>(
    `select summary, observations, opportunities, unknowns, confidence
       from prospect_research where prospect_id = $1 order by created_at desc limit 1`,
    [prospectId],
  );
  const row = rows[0];
  if (!row) return null;

  // Les observations sont des objets `{text, evidenceIds, sourceUrl, provider}` :
  // seul `text` entre dans un prompt. Les identifiants de preuve restent en base
  // — ils servent à auditer, pas à écrire.
  const rawObservations = Array.isArray(row.observations) ? row.observations : [];
  const observations = rawObservations
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      const text = (entry as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    })
    .filter((text) => text.length > 0);

  return Object.freeze({
    summary: row.summary,
    observations: Object.freeze(observations),
    opportunities: Object.freeze(stringArray(row.opportunities)),
    unknowns: Object.freeze(stringArray(row.unknowns)),
    confidence: Number(row.confidence),
  });
}

async function loadLatestAngle(sql: Sql, prospectId: string): Promise<GroundedAngle | null> {
  const rows = await sql.query<{
    painPoint: string;
    opportunity: string;
    approach: string;
    personalization: string;
  }>(
    `select pain_point as "painPoint", opportunity, approach, personalization
       from prospect_angles where prospect_id = $1 order by created_at desc limit 1`,
    [prospectId],
  );
  const row = rows[0];
  if (!row) return null;
  return Object.freeze({
    painPoint: row.painPoint,
    opportunity: row.opportunity,
    approach: row.approach,
    personalization: row.personalization,
  });
}

/**
 * L'empreinte d'une question posée à un modèle.
 *
 * Couvre tout ce qui peut changer la réponse pour une raison qui compte : le
 * corps de la réponse, le message d'origine, les faits vérifiés, l'angle, et la
 * force de corrélation (qui change la politique appliquée), et — depuis
 * HERMES-CONTEXTUAL-REPLY-CLASSIFICATION-R1 — les TOURS QUI PRÉCÈDENT, sous
 * la forme d'une empreinte fournie par l'appelant.
 *
 * Ce dernier point n'est pas décoratif : « oui » précédé de « c'est vous qui
 * gérez ? » et « oui » précédé de « on peut vous rappeler ? » sont deux
 * questions différentes posées au même modèle. Sans le contexte dans
 * l'empreinte, elles porteraient la même, et l'idempotence rendrait pour la
 * seconde la conclusion de la première.
 *
 * L'empreinte arrive en PARAMÈTRE plutôt que d'être calculée ici : le fil est
 * dérivé par `@/lib/conversation/thread`, qui importe déjà ce fichier. La
 * calculer ici fermerait le cycle.
 *
 * N'inclut PAS l'horodatage — sinon deux exécutions du même traitement, à deux minutes
 * d'intervalle, produiraient deux analyses de la même réponse, ce qui est
 * exactement ce que l'idempotence doit empêcher.
 */
export function hashReplyContext(
  context: ReplyContext,
  promptVersion: string,
  conversationDigest: string,
): string {
  const parts = [
    promptVersion,
    conversationDigest,
    context.reply.bodySha256,
    context.reply.correlationStatus,
    context.reply.automationSignals.join(','),
    context.firstTouch.manifestId,
    context.firstTouch.subject ?? '',
    context.firstTouch.body,
    context.prospect.id,
    context.research?.summary ?? '',
    context.research?.observations.join('|') ?? '',
    context.research?.unknowns.join('|') ?? '',
    context.angle?.approach ?? '',
    context.angle?.personalization ?? '',
  ];
  // Le séparateur est un octet NUL, écrit en ÉCHAPPEMENT et non en clair.
  //
  // HERMES-END-TO-END-CERTIFICATION-R1 — il était écrit littéralement, donc ce
  // fichier contenait un octet nul. `file(1)` le classait « data » et `grep`
  // le SAUTAIT en silence : toute relecture du dépôt par recherche textuelle
  // sous-déclarait le constructeur de contexte, c'est-à-dire le seul endroit
  // qui décide de ce qu'un modèle reçoit. L'empreinte produite est identique
  // au bit près ; seule la façon de l'écrire change.
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

/**
 * Le bloc de contexte partagé par le classifieur et le rédacteur.
 *
 * Un seul rendu pour les deux : deux constructions séparées finiraient par
 * diverger, et le brouillon serait écrit sur des faits que la classification
 * n'a pas vus.
 */
export function renderContextBlock(context: ReplyContext): string {
  const research = context.research;
  const angle = context.angle;

  return `ENTREPRISE CONTACTÉE
- nom commercial : ${context.firstTouch.businessName}
- raison sociale : ${context.prospect.legalName ?? 'inconnue'}
- ville : ${context.prospect.city ?? 'inconnue'}
- site : ${context.prospect.websiteUrl ?? 'inconnu'}

FAITS VÉRIFIÉS SUR CETTE ENTREPRISE (aucun autre fait n'existe)
${research === null ? '- aucune recherche enregistrée' : research.observations.map((text) => `- ${text}`).join('\n') || '- aucune observation enregistrée'}
${research && research.unknowns.length > 0 ? `\nEXPLICITEMENT NON OBSERVÉ (ne rien en déduire, ne jamais affirmer une absence)\n${research.unknowns.map((text) => `- ${text}`).join('\n')}` : ''}

ANGLE COMMERCIAL RETENU AVANT LE PREMIER MESSAGE
${
  angle === null
    ? '- aucun angle enregistré'
    : `- accroche : ${angle.personalization}\n- approche : ${angle.approach}\n- opportunité : ${angle.opportunity}`
}

MESSAGE QUE NOUS AVONS ENVOYÉ (premier contact, ${context.firstTouch.sentAt ?? 'date inconnue'})
${context.firstTouch.subject === null ? '' : `Objet : ${context.firstTouch.subject}\n`}${clampBody(context.firstTouch.body, MAX_FIRST_TOUCH_CHARS)}

RÉPONSE REÇUE (${context.reply.receivedAt}, de ${context.reply.fromAddress})
${context.reply.subject === null ? '' : `Objet : ${context.reply.subject}\n`}${clampBody(context.reply.bodyText, MAX_REPLY_BODY_CHARS)}

ÉTAT COMMERCIAL COURANT : ${context.currentState ?? 'aucun état enregistré (premier contact)'}`;
}
