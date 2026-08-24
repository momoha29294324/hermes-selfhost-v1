/**
 * CRM1 — les lectures du CRM Hermes.
 *
 * ---------------------------------------------------------------------------
 * Une interface, pas un second modèle de données
 * ---------------------------------------------------------------------------
 *
 * Rien ici ne crée d'entité. Chaque fonction lit les tables canoniques déjà
 * présentes — `prospects`, `prospect_research`, `prospect_scores`,
 * `prospect_evidence`, `r6b_dispatch_manifests`, `outreach_events`,
 * `r6b_live_send_attempts`, `r6b_inbound_messages`, `r6b_reply_analyses`,
 * `r6b_reply_drafts`, `r6b_prospect_outreach_states`,
 * `r6b_prospect_state_transitions`, `prospect_milestones`, `r6b_alerts`,
 * `do_not_contact` — et les assemble pour l'affichage.
 *
 * Aucune vue SQL de confort n'est créée par-dessus : ces tables portent des
 * garanties différentes (`outreach_events` est le compteur de sûreté du gate
 * produit, `r6b_live_send_attempts` porte l'idempotence d'envoi,
 * `r6b_inbound_messages` porte la corrélation) et les fusionner en base
 * effacerait ce qui les distingue. La fusion est en TypeScript, testée.
 *
 * ---------------------------------------------------------------------------
 * Lecture seule, littéralement
 * ---------------------------------------------------------------------------
 *
 * Ce module n'expose aucune fonction d'écriture, et `tests/crm.test.ts` relit
 * son code source pour vérifier qu'aucun `insert` / `update` / `delete` n'y est
 * atteignable. Le CRM regarde le dossier commercial ; il ne le modifie pas, et
 * surtout il n'envoie rien.
 */

import 'server-only';

import { getSql } from '@/lib/db';
import type { Sql } from '@/lib/db/sql';
import {
  bestChannel,
  channelFromTransport,
  observedChannels,
  resolveCommercialState,
  sortTimeline,
  type CrmChannel,
  type CrmCommercialState,
  type CrmLane,
  type CrmTimelineEntry,
} from '@/lib/crm/view';
import type { OutreachState } from '@/lib/replies/taxonomy';
import type { PipelineStage } from '@/lib/repo/types';

// ---------------------------------------------------------------------------
// Prospects
// ---------------------------------------------------------------------------

export interface CrmProspectRow {
  readonly id: string;
  readonly displayName: string;
  readonly legalName: string | null;
  readonly city: string | null;
  readonly postalCode: string | null;
  readonly department: string | null;
  readonly score: number | null;
  readonly scoreBand: string | null;
  readonly stage: PipelineStage;
  readonly nicheVerdict: string | null;
  readonly websiteUrl: string | null;
  readonly domain: string | null;
  readonly instagramHandle: string | null;
  readonly facebookUrl: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly outreachState: OutreachState | null;
  readonly sentCount: number;
  readonly lockedTransport: string | null;
  readonly lastOutreachAt: string | null;
  readonly lastOutreachTransport: string | null;
  readonly lastReplyAt: string | null;
  readonly lastReplyClassification: string | null;
  readonly recommendedNextAction: string | null;
  readonly isClient: boolean;
  readonly doNotContact: boolean;
  readonly dedupeStatus: string;
  readonly campaignSlug: string;
}

/** Un prospect enrichi des dérivations de `view.ts`. */
export interface CrmProspect extends CrmProspectRow {
  readonly lane: CrmLane | null;
  readonly bestChannel: CrmChannel | null;
  readonly channels: readonly CrmChannel[];
  /**
   * L'état commercial AFFICHÉ, unique et cohérent avec `lane` par construction.
   * Décoré ici plutôt que calculé dans chaque page : trois écrans qui
   * dériveraient la même phrase séparément finiraient par se contredire.
   */
  readonly commercial: CrmCommercialState;
}

export interface CrmProspectFilters {
  /** Recherche libre : nom, nom légal, ville, domaine, handle Instagram. */
  readonly q?: string | null;
  readonly lane?: CrmLane | null;
  readonly channel?: CrmChannel | null;
  readonly band?: string | null;
  readonly sort?: CrmProspectSort | null;
}

export type CrmProspectSort = 'score' | 'name' | 'city' | 'outreach' | 'reply';

export const CRM_PROSPECT_SORTS: readonly CrmProspectSort[] = [
  'score',
  'name',
  'city',
  'outreach',
  'reply',
];

export function parseSort(value: string | null | undefined): CrmProspectSort {
  const found = CRM_PROSPECT_SORTS.find((sort) => sort === value);
  return found ?? 'score';
}

/**
 * La requête de base du CRM.
 *
 * Écrite une seule fois et réutilisée par la table, le pipeline et le
 * workspace : trois écrans qui divergeraient sur « qu'est-ce qu'un prospect
 * contacté » finiraient par se contredire à l'écran.
 *
 * `dedupe_status = 'merged'` est exclu partout : une fiche fusionnée n'est plus
 * une entreprise, c'est un doublon absorbé.
 */
const PROSPECT_SELECT = `
  select p.id,
         p.display_name       as "displayName",
         p.legal_name         as "legalName",
         p.city,
         p.postal_code        as "postalCode",
         p.department,
         p.score,
         p.score_band         as "scoreBand",
         p.stage,
         p.niche_verdict      as "nicheVerdict",
         p.website_url        as "websiteUrl",
         p.domain,
         p.instagram_handle   as "instagramHandle",
         p.facebook_url       as "facebookUrl",
         p.email,
         p.phone,
         p.dedupe_status      as "dedupeStatus",
         c.slug               as "campaignSlug",
         st.state             as "outreachState",
         (select count(*)::int from outreach_events oe
           where oe.prospect_id = p.id and oe.kind = 'sent')                       as "sentCount",
         (select m.transport from r6b_dispatch_manifests m
           where m.prospect_id = p.id and m.status = 'LOCKED'
           order by m.locked_at desc limit 1)                                      as "lockedTransport",
         (select oe.occurred_at from outreach_events oe
           where oe.prospect_id = p.id and oe.kind = 'sent'
           order by oe.occurred_at desc limit 1)                                   as "lastOutreachAt",
         (select coalesce(m.transport, oe.channel) from outreach_events oe
            left join r6b_dispatch_manifests m on m.id = oe.manifest_id
           where oe.prospect_id = p.id and oe.kind = 'sent'
           order by oe.occurred_at desc limit 1)                                   as "lastOutreachTransport",
         (select i.received_at from r6b_inbound_messages i
           where i.correlated_prospect_id = p.id
           order by i.received_at desc limit 1)                                    as "lastReplyAt",
         (select a.classification from r6b_reply_analyses a
           where a.prospect_id = p.id and a.status = 'ACTIVE'
           order by a.created_at desc limit 1)                                     as "lastReplyClassification",
         (select a.recommended_next_action from r6b_reply_analyses a
           where a.prospect_id = p.id and a.status = 'ACTIVE'
           order by a.created_at desc limit 1)                                     as "recommendedNextAction",
         exists (select 1 from prospect_milestones ms
                  where ms.prospect_id = p.id and ms.milestone = 'won')            as "isClient",
         exists (select 1 from do_not_contact d
                  where (d.match_kind = 'email'     and p.email is not null
                          and lower(d.value) = lower(p.email))
                     or (d.match_kind = 'phone'     and p.phone is not null
                          and d.value = p.phone)
                     or (d.match_kind = 'domain'    and p.domain is not null
                          and lower(d.value) = lower(p.domain))
                     or (d.match_kind = 'instagram' and p.instagram_handle is not null
                          and lower(d.value) = lower(p.instagram_handle)))         as "doNotContact"
    from prospects p
    join campaigns c on c.id = p.campaign_id
    left join r6b_prospect_outreach_states st on st.prospect_id = p.id
   where p.dedupe_status <> 'merged'
`;

function decorate(row: CrmProspectRow): CrmProspect {
  const channelInput = {
    email: row.email,
    instagramHandle: row.instagramHandle,
    facebookUrl: row.facebookUrl,
    phone: row.phone,
  };
  const commercial = resolveCommercialState({
    stage: row.stage,
    outreachState: row.outreachState,
    sentCount: row.sentCount,
    hasLockedManifest: row.lockedTransport !== null,
    isClient: row.isClient,
    doNotContact: row.doNotContact,
    lastReplyAt: row.lastReplyAt,
  });
  return Object.freeze({
    ...row,
    // `commercial.lane` EST le résultat de `resolveLane` : une seule source.
    lane: commercial.lane,
    commercial,
    bestChannel: bestChannel({ ...channelInput, lockedTransport: row.lockedTransport }),
    channels: Object.freeze(observedChannels(channelInput)),
  });
}

/**
 * Charge tous les prospects décorés, puis filtre en mémoire.
 *
 * Le filtrage par colonne (`lane`, `channel`) est délibérément hors SQL : ces
 * deux valeurs sont DÉRIVÉES par `view.ts`, et les réécrire en SQL créerait
 * deux définitions de « prêt à contacter » qui divergeraient au premier
 * changement de règle. À 286 lignes le coût est nul, et la règle reste testable
 * sans base.
 *
 * La recherche libre, elle, reste en SQL : c'est un `ilike` sur des colonnes
 * réelles, sans dérivation, et il n'a aucune raison de remonter 286 lignes pour
 * en garder trois.
 */
export async function listCrmProspects(
  filters: CrmProspectFilters = {},
  sql?: Sql,
): Promise<CrmProspect[]> {
  const db = sql ?? (await getSql());
  const query = (filters.q ?? '').trim();
  const params: unknown[] = [];
  let where = '';
  if (query.length > 0) {
    params.push(`%${query}%`);
    where = `
      and (p.display_name ilike $1
        or coalesce(p.legal_name, '') ilike $1
        or coalesce(p.city, '') ilike $1
        or coalesce(p.domain, '') ilike $1
        or coalesce(p.instagram_handle, '') ilike $1)`;
  }

  const rows = await db.query<CrmProspectRow>(`${PROSPECT_SELECT}${where}`, params);
  let decorated = rows.map(decorate);

  if (filters.lane != null) decorated = decorated.filter((row) => row.lane === filters.lane);
  if (filters.channel != null) {
    decorated = decorated.filter(
      (row) => row.bestChannel === filters.channel || row.channels.includes(filters.channel!),
    );
  }
  if (filters.band != null && filters.band.length > 0) {
    decorated = decorated.filter((row) => row.scoreBand === filters.band);
  }

  return sortProspects(decorated, filters.sort ?? 'score');
}

/**
 * Tri total et déterministe.
 *
 * Chaque critère se termine par le nom puis l'identifiant : sans ce
 * départage, deux prospects sans score (il y en a 197) s'échangeraient de
 * place d'un rendu à l'autre, et une liste qui bouge toute seule n'est plus
 * lisible.
 */
export function sortProspects(rows: readonly CrmProspect[], sort: CrmProspectSort): CrmProspect[] {
  const byName = (a: CrmProspect, b: CrmProspect): number =>
    a.displayName.localeCompare(b.displayName, 'fr') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  const copy = [...rows];
  switch (sort) {
    case 'name':
      return copy.sort(byName);
    case 'city':
      return copy.sort(
        (a, b) => (a.city ?? '￿').localeCompare(b.city ?? '￿', 'fr') || byName(a, b),
      );
    case 'outreach':
      return copy.sort((a, b) => compareDatesDesc(a.lastOutreachAt, b.lastOutreachAt) || byName(a, b));
    case 'reply':
      return copy.sort((a, b) => compareDatesDesc(a.lastReplyAt, b.lastReplyAt) || byName(a, b));
    case 'score':
    default:
      return copy.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || byName(a, b));
  }
}

/** Le plus récent d'abord ; l'absence de date passe toujours après une date. */
function compareDatesDesc(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return Date.parse(b) - Date.parse(a);
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export interface CrmPipeline {
  readonly lanes: Readonly<Record<CrmLane, readonly CrmProspect[]>>;
  /** Prospects encore en amont de la qualification — comptés, jamais affichés en colonnes. */
  readonly upstream: number;
  readonly total: number;
}

const EMPTY_LANES: readonly CrmLane[] = [
  'QUALIFIED',
  'READY_TO_CONTACT',
  'CONTACTED',
  'REPLIED',
  'INTERESTED',
  'NOT_NOW',
  'NOT_INTERESTED',
  'CLIENT',
  'REVIEW_REQUIRED',
  'PROTECTED',
];

export async function loadCrmPipeline(sql?: Sql): Promise<CrmPipeline> {
  const prospects = await listCrmProspects({}, sql);
  const lanes = Object.fromEntries(EMPTY_LANES.map((lane) => [lane, [] as CrmProspect[]])) as Record<
    CrmLane,
    CrmProspect[]
  >;
  let upstream = 0;
  for (const prospect of prospects) {
    if (prospect.lane === null) {
      upstream += 1;
      continue;
    }
    lanes[prospect.lane].push(prospect);
  }
  return Object.freeze({
    lanes: Object.freeze(lanes),
    upstream,
    total: prospects.length,
  });
}

// ---------------------------------------------------------------------------
// Workspace d'un prospect
// ---------------------------------------------------------------------------

export interface CrmEvidence {
  readonly field: string;
  readonly value: string | null;
  readonly provider: string;
  readonly method: string;
  readonly sourceUrl: string | null;
  readonly confidence: number;
  readonly observedAt: string;
}

export interface CrmResearch {
  readonly summary: string;
  readonly observations: readonly string[];
  readonly opportunities: readonly string[];
  readonly unknowns: readonly string[];
  readonly confidence: number;
  readonly createdAt: string;
}

export interface CrmScoreSignal {
  readonly key: string;
  readonly label: string;
  readonly points: number;
  readonly max: number;
  readonly detail: string | null;
  /** Faux quand le signal n'a PAS été observé — distinct d'un signal à zéro. */
  readonly observed: boolean;
}

export interface CrmScore {
  readonly total: number;
  readonly band: string;
  readonly profileKey: string;
  readonly profileVersion: string;
  readonly signals: readonly CrmScoreSignal[];
  readonly missing: readonly string[];
  readonly createdAt: string;
}

export interface CrmManifest {
  readonly id: string;
  readonly status: string;
  readonly transport: string | null;
  readonly recipient: string;
  readonly businessName: string;
  readonly approvedText: string;
  readonly lockedAt: string;
  readonly identityReview: string;
  readonly supersededReason: string | null;
}

export interface CrmStateEntry {
  readonly fromState: OutreachState | null;
  readonly toState: OutreachState;
  readonly causeKind: string;
  readonly reason: string;
  readonly createdAt: string;
}

export interface CrmProtection {
  readonly matchKind: string;
  readonly value: string;
  readonly reason: string;
  readonly createdAt: string;
}

export interface CrmWorkspace {
  readonly prospect: CrmProspect;
  readonly evidence: readonly CrmEvidence[];
  readonly research: CrmResearch | null;
  readonly score: CrmScore | null;
  readonly manifests: readonly CrmManifest[];
  readonly timeline: readonly CrmTimelineEntry[];
  readonly stateHistory: readonly CrmStateEntry[];
  readonly protections: readonly CrmProtection[];
  /** État de la copie CRM externe, quand une ligne existe. Optionnelle par construction. */
  readonly externalProjection: { readonly status: string; readonly provider: string } | null;
}

export async function loadCrmWorkspace(prospectId: string, sql?: Sql): Promise<CrmWorkspace | null> {
  const db = sql ?? (await getSql());

  const rows = await db.query<CrmProspectRow>(`${PROSPECT_SELECT} and p.id = $1`, [prospectId]);
  const row = rows[0];
  if (row === undefined) return null;
  const prospect = decorate(row);

  const [evidence, research, score, manifests, stateHistory, protections, projection, timeline] =
    await Promise.all([
      loadEvidence(db, prospectId),
      loadResearch(db, prospectId),
      loadScore(db, prospectId),
      loadManifests(db, prospectId),
      loadStateHistory(db, prospectId),
      loadProtections(db, prospect),
      loadExternalProjection(db, prospectId),
      loadTimeline(db, prospectId),
    ]);

  return Object.freeze({
    prospect,
    evidence,
    research,
    score,
    manifests,
    timeline,
    stateHistory,
    protections,
    externalProjection: projection,
  });
}

/**
 * Le plafond de lignes de preuve chargées pour une fiche.
 *
 * Exporté, et pas seulement écrit dans le SQL : un prospect peut porter plus de
 * 300 lignes, et l'affichage doit pouvoir dire « 60+ » plutôt que « 60 ». Un
 * compteur tronqué présenté comme un total serait un chiffre faux — exactement
 * ce qu'AGENTS.md §2 interdit.
 */
export const CRM_EVIDENCE_LIMIT = 60;

async function loadEvidence(sql: Sql, prospectId: string): Promise<readonly CrmEvidence[]> {
  const rows = await sql.query<CrmEvidence>(
    `select field,
            value_text as value,
            provider,
            method,
            source_url as "sourceUrl",
            confidence,
            observed_at as "observedAt"
       from prospect_evidence
      where prospect_id = $1
      order by observed_at desc, field asc
      limit $2`,
    [prospectId, CRM_EVIDENCE_LIMIT],
  );
  return Object.freeze(rows.map((entry) => Object.freeze(entry)));
}

async function loadResearch(sql: Sql, prospectId: string): Promise<CrmResearch | null> {
  const rows = await sql.query<{
    summary: string;
    observations: unknown;
    opportunities: unknown;
    unknowns: unknown;
    confidence: number;
    createdAt: string;
  }>(
    `select summary, observations, opportunities, unknowns, confidence, created_at as "createdAt"
       from prospect_research
      where prospect_id = $1
      order by created_at desc
      limit 1`,
    [prospectId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return Object.freeze({
    summary: row.summary,
    observations: Object.freeze(textList(row.observations)),
    opportunities: Object.freeze(textList(row.opportunities)),
    unknowns: Object.freeze(textList(row.unknowns)),
    confidence: row.confidence,
    createdAt: row.createdAt,
  });
}

/**
 * Un tableau JSONB hétérogène → une liste de phrases lisibles.
 *
 * `prospect_research.observations` porte tantôt des chaînes, tantôt des objets
 * `{text, source_url, …}` selon la version du pipeline qui l'a écrit. Cette
 * fonction lit les deux formes et IGNORE ce qu'elle ne sait pas lire, plutôt
 * que d'afficher `[object Object]` — un rendu illisible est un mensonge de
 * moins seulement s'il ne prétend rien.
 */
export function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim().length > 0) {
      out.push(entry.trim());
      continue;
    }
    if (entry !== null && typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      const text = record['text'] ?? record['label'] ?? record['summary'];
      if (typeof text === 'string' && text.trim().length > 0) out.push(text.trim());
    }
  }
  return out;
}

async function loadScore(sql: Sql, prospectId: string): Promise<CrmScore | null> {
  const rows = await sql.query<{
    total: number;
    band: string;
    profileKey: string;
    profileVersion: string;
    deterministic: unknown;
    missing: unknown;
    createdAt: string;
  }>(
    `select total, band,
            profile_key      as "profileKey",
            profile_version  as "profileVersion",
            deterministic,
            missing_signals  as missing,
            created_at       as "createdAt"
       from prospect_scores
      where prospect_id = $1
      order by created_at desc
      limit 1`,
    [prospectId],
  );
  const row = rows[0];
  if (row === undefined) return null;

  return Object.freeze({
    total: row.total,
    band: row.band,
    profileKey: row.profileKey,
    profileVersion: row.profileVersion,
    signals: Object.freeze(parseScoreSignals(row.deterministic)),
    missing: Object.freeze(textList(row.missing)),
    createdAt: row.createdAt,
  });
}

/**
 * Lit `prospect_scores.deterministic`, de forme `{signals: [...], coverage}`.
 *
 * L'ordre rendu est celui du profil de scoring (`signals` est un tableau, pas
 * un objet) et n'est PAS retrié par points : le barème se lit A, B, C, D, E, et
 * réordonner ferait perdre la correspondance avec `config/`. Un signal non
 * observé reste à sa place plutôt que de tomber en bas — c'est justement
 * l'information qu'un opérateur doit voir.
 */
export function parseScoreSignals(deterministic: unknown): CrmScoreSignal[] {
  if (deterministic === null || typeof deterministic !== 'object') return [];
  const raw = (deterministic as Record<string, unknown>)['signals'];
  if (!Array.isArray(raw)) return [];

  const signals: CrmScoreSignal[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const key = typeof record['key'] === 'string' ? record['key'] : null;
    if (key === null) continue;
    signals.push(
      Object.freeze({
        key,
        label: typeof record['label'] === 'string' ? record['label'] : key,
        points: numberOr(record['points'], 0),
        max: numberOr(record['max'], 0),
        detail: typeof record['detail'] === 'string' ? record['detail'] : null,
        observed: record['observed'] !== false,
      }),
    );
  }
  return signals;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Coupe sur un mot entier, et le dit avec une ellipse. */
export function excerpt(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

async function loadManifests(sql: Sql, prospectId: string): Promise<readonly CrmManifest[]> {
  const rows = await sql.query<CrmManifest>(
    `select id, status, transport, recipient,
            business_name      as "businessName",
            approved_text      as "approvedText",
            locked_at          as "lockedAt",
            identity_review    as "identityReview",
            superseded_reason  as "supersededReason"
       from r6b_dispatch_manifests
      where prospect_id = $1
      order by locked_at desc`,
    [prospectId],
  );
  return Object.freeze(rows.map((entry) => Object.freeze(entry)));
}

async function loadStateHistory(sql: Sql, prospectId: string): Promise<readonly CrmStateEntry[]> {
  const rows = await sql.query<CrmStateEntry>(
    `select from_state as "fromState",
            to_state   as "toState",
            cause_kind as "causeKind",
            reason,
            created_at as "createdAt"
       from r6b_prospect_state_transitions
      where prospect_id = $1
      order by created_at desc`,
    [prospectId],
  );
  return Object.freeze(rows.map((entry) => Object.freeze(entry)));
}

/**
 * Les entrées d'exclusion qui protègent CE prospect.
 *
 * Interrogées par valeur de canal, pas par identifiant : `do_not_contact` ne
 * référence aucun prospect (0001) et c'est délibéré — une exclusion survit à la
 * suppression d'une fiche.
 */
async function loadProtections(sql: Sql, prospect: CrmProspect): Promise<readonly CrmProtection[]> {
  const rows = await sql.query<CrmProtection>(
    `select match_kind as "matchKind", value, reason, created_at as "createdAt"
       from do_not_contact
      where (match_kind = 'email'     and $1::text is not null and lower(value) = lower($1))
         or (match_kind = 'phone'     and $2::text is not null and value = $2)
         or (match_kind = 'domain'    and $3::text is not null and lower(value) = lower($3))
         or (match_kind = 'instagram' and $4::text is not null and lower(value) = lower($4))
      order by created_at desc`,
    [prospect.email, prospect.phone, prospect.domain, prospect.instagramHandle],
  );
  return Object.freeze(rows.map((entry) => Object.freeze(entry)));
}

async function loadExternalProjection(
  sql: Sql,
  prospectId: string,
): Promise<{ readonly status: string; readonly provider: string } | null> {
  const rows = await sql.query<{ status: string; provider: string }>(
    'select status, provider from r6b_crm_projections where prospect_id = $1 limit 1',
    [prospectId],
  );
  const row = rows[0];
  return row === undefined ? null : Object.freeze(row);
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

/**
 * Fusionne les sept sources d'événements d'un prospect.
 *
 * Chaque requête est bornée à CE prospect. C'est ce qui garantit qu'aucun
 * contenu de boîte mail sans rapport n'apparaît : `r6b_inbound_messages` n'est
 * lue que sur `correlated_prospect_id`, jamais sur la boîte ni sur le fil.
 */
export async function loadTimeline(sql: Sql, prospectId: string): Promise<readonly CrmTimelineEntry[]> {
  const entries: CrmTimelineEntry[] = [];

  const manifests = await sql.query<{
    id: string;
    status: string;
    transport: string | null;
    recipient: string;
    lockedAt: string;
    identityReview: string;
    approvedText: string;
    supersededReason: string | null;
  }>(
    `select id, status, transport, recipient,
            locked_at as "lockedAt", identity_review as "identityReview",
            approved_text as "approvedText", superseded_reason as "supersededReason"
       from r6b_dispatch_manifests
      where prospect_id = $1`,
    [prospectId],
  );
  for (const manifest of manifests) {
    entries.push(
      Object.freeze({
        id: `manifest:${manifest.id}`,
        kind: 'manifest_locked' as const,
        direction: 'system' as const,
        occurredAt: manifest.lockedAt,
        channel: channelFromTransport(manifest.transport),
        title:
          manifest.status === 'LOCKED'
            ? 'Manifeste verrouillé — prêt à partir'
            : 'Manifeste remplacé',
        // Un manifeste remplacé porte, la plupart du temps, le même texte que
        // son remplaçant : l'afficher en entier ferait lire trois fois le même
        // paragraphe. L'extrait suffit à vérifier que c'est bien le même, et
        // le texte complet reste consultable dans la colonne « Manifestes ».
        body:
          manifest.status === 'LOCKED'
            ? manifest.approvedText
            : excerpt(manifest.approvedText, 150),
        facts: Object.freeze(
          [
            `destinataire ${manifest.recipient}`,
            `identité ${manifest.identityReview}`,
            manifest.supersededReason === null ? null : `motif ${manifest.supersededReason}`,
          ].filter((fact): fact is string => fact !== null),
        ),
      }),
    );
  }

  const outreach = await sql.query<{
    id: string;
    kind: string;
    channel: string;
    occurredAt: string;
    transport: string | null;
    recipient: string | null;
    approvedText: string | null;
    providerMessageId: string | null;
  }>(
    `select oe.id, oe.kind, oe.channel, oe.occurred_at as "occurredAt",
            m.transport, m.recipient, m.approved_text as "approvedText",
            (select a.provider_message_id from r6b_live_send_attempts a
              where a.manifest_id = oe.manifest_id and a.status = 'SENT'
              order by a.claimed_at desc limit 1) as "providerMessageId"
       from outreach_events oe
       left join r6b_dispatch_manifests m on m.id = oe.manifest_id
      where oe.prospect_id = $1`,
    [prospectId],
  );
  for (const event of outreach) {
    const sent = event.kind === 'sent';
    entries.push(
      Object.freeze({
        id: `outreach:${event.id}`,
        kind: sent ? ('outbound_sent' as const) : ('outbound_event' as const),
        direction: 'outbound' as const,
        occurredAt: event.occurredAt,
        channel: channelFromTransport(event.transport ?? event.channel),
        title: sent ? 'Message envoyé' : `Événement outbound — ${event.kind}`,
        body: sent ? event.approvedText : null,
        facts: Object.freeze(
          [
            event.recipient === null ? null : `vers ${event.recipient}`,
            event.providerMessageId === null ? null : `accusé provider ${event.providerMessageId}`,
          ].filter((fact): fact is string => fact !== null),
        ),
      }),
    );
  }

  // Les tentatives qui n'ont PAS abouti. Une tentative réussie est déjà
  // racontée par son `outreach_event` ; la répéter doublerait chaque envoi.
  const failures = await sql.query<{
    id: string;
    status: string;
    transport: string;
    recipient: string;
    failureCode: string | null;
    detail: string | null;
    at: string;
  }>(
    `select a.id, a.status, a.transport, a.recipient,
            a.failure_code as "failureCode", a.detail,
            coalesce(a.completed_at, a.claimed_at) as "at"
       from r6b_live_send_attempts a
       join r6b_dispatch_manifests m on m.id = a.manifest_id
      where m.prospect_id = $1 and a.status <> 'SENT'`,
    [prospectId],
  );
  for (const attempt of failures) {
    entries.push(
      Object.freeze({
        id: `attempt:${attempt.id}`,
        kind: 'send_failure' as const,
        direction: 'outbound' as const,
        occurredAt: attempt.at,
        channel: channelFromTransport(attempt.transport),
        title: `Tentative d'envoi — ${attempt.status}`,
        body: attempt.detail,
        facts: Object.freeze(
          [
            `vers ${attempt.recipient}`,
            attempt.failureCode === null ? null : `code ${attempt.failureCode}`,
          ].filter((fact): fact is string => fact !== null),
        ),
      }),
    );
  }

  const inbound = await sql.query<{
    id: string;
    receivedAt: string;
    fromAddress: string;
    subject: string | null;
    bodyText: string;
    correlationStatus: string;
    correlationMethod: string | null;
    provider: string;
    counterpartyKind: string;
  }>(
    `select id, received_at as "receivedAt", from_address as "fromAddress", subject,
            body_text as "bodyText", correlation_status as "correlationStatus",
            correlation_method as "correlationMethod", provider, counterparty_kind as "counterpartyKind"
       from r6b_inbound_messages
      where correlated_prospect_id = $1`,
    [prospectId],
  );
  for (const message of inbound) {
    // IG5.1 — le canal vient de la LIGNE, plus d'une constante. Il était en dur
    // à `'email'` tant que Gmail était le seul rail entrant ; l'y laisser
    // aurait affiché une réponse Instagram sous une pastille « Email », donc
    // affirmé un fait faux dans l'écran qui sert à décider.
    const channel = message.provider === 'instagram' ? ('instagram_dm' as const) : ('email' as const);
    entries.push(
      Object.freeze({
        id: `inbound:${message.id}`,
        kind: 'inbound_reply' as const,
        direction: 'inbound' as const,
        occurredAt: message.receivedAt,
        channel,
        title: message.subject ?? 'Réponse reçue',
        body: message.bodyText,
        facts: Object.freeze(
          [
            message.counterpartyKind === 'instagram_handle'
              ? `de @${message.fromAddress}`
              : `de ${message.fromAddress}`,
            `corrélation ${message.correlationStatus}`,
            message.correlationMethod === null ? null : `méthode ${message.correlationMethod}`,
          ].filter((fact): fact is string => fact !== null),
        ),
      }),
    );
  }

  const analyses = await sql.query<{
    id: string;
    classification: string;
    confidence: number;
    reasoningSummary: string;
    recommendedNextAction: string;
    requiresHumanReview: boolean;
    decidedDeterministically: boolean;
    createdAt: string;
  }>(
    `select id, classification, confidence,
            reasoning_summary        as "reasoningSummary",
            recommended_next_action  as "recommendedNextAction",
            requires_human_review    as "requiresHumanReview",
            decided_deterministically as "decidedDeterministically",
            created_at               as "createdAt"
       from r6b_reply_analyses
      where prospect_id = $1 and status = 'ACTIVE'`,
    [prospectId],
  );
  for (const analysis of analyses) {
    entries.push(
      Object.freeze({
        id: `analysis:${analysis.id}`,
        kind: 'reply_analysis' as const,
        direction: 'system' as const,
        occurredAt: analysis.createdAt,
        channel: null,
        title: `Classification — ${analysis.classification}`,
        body: analysis.reasoningSummary,
        facts: Object.freeze([
          `confiance ${analysis.confidence.toFixed(2)}`,
          `action ${analysis.recommendedNextAction}`,
          analysis.decidedDeterministically ? 'décidé sans modèle' : 'décidé par modèle',
          ...(analysis.requiresHumanReview ? ['revue humaine requise'] : []),
        ]),
      }),
    );
  }

  const drafts = await sql.query<{
    id: string;
    body: string;
    status: string;
    blocked: boolean;
    createdAt: string;
  }>(
    `select id, body, status, blocked, created_at as "createdAt"
       from r6b_reply_drafts
      where prospect_id = $1`,
    [prospectId],
  );
  for (const draft of drafts) {
    entries.push(
      Object.freeze({
        id: `draft:${draft.id}`,
        kind: 'reply_draft' as const,
        direction: 'system' as const,
        occurredAt: draft.createdAt,
        channel: null,
        title: 'Réponse proposée — jamais envoyée',
        body: draft.body,
        facts: Object.freeze([
          `statut ${draft.status}`,
          ...(draft.blocked ? ['bloquée par un garde-fou'] : []),
        ]),
      }),
    );
  }

  // HERMES-CONVERSATION-R2 §29 — les intentions conversationnelles autonomes.
  //
  // Elles entrent dans la timeline comme ce qu'elles sont : un texte DÉCIDÉ par
  // une politique, avec sa version et sa décision en toutes lettres. Les seules
  // écartées sont celles qui n'ont produit aucun texte — un arrêt ou une
  // escalade ne met pas sous les yeux d'un humain pressé un message prêt à être
  // copié-collé.
  const plans = await sql.query<{
    id: string;
    kind: string;
    body: string;
    decision: string;
    decisionReason: string | null;
    status: string;
    policyVersion: string;
    createdAt: string;
    channel: string;
  }>(
    `select id, kind, body, decision, decision_reason as "decisionReason", status,
            policy_version as "policyVersion", created_at as "createdAt", channel
       from hermes_conversation_plans
      where prospect_id = $1 and body is not null`,
    [prospectId],
  );
  for (const plan of plans) {
    entries.push(
      Object.freeze({
        id: `plan:${plan.id}`,
        kind: 'conversation_plan' as const,
        direction: 'outbound' as const,
        occurredAt: plan.createdAt,
        channel: plan.channel === 'instagram_dm' ? ('instagram_dm' as const) : ('email' as const),
        title:
          plan.kind === 'AUTO_REPLY'
            ? 'Réponse préparée par Hermes (auto)'
            : 'Relance préparée par Hermes (auto)',
        body: plan.body,
        facts: Object.freeze([
          `décision ${plan.decision}${plan.decisionReason === null ? '' : ` (${plan.decisionReason})`}`,
          `statut ${plan.status}`,
          `politique ${plan.policyVersion}`,
        ]),
      }),
    );
  }

  const transitions = await sql.query<{
    id: string;
    fromState: string | null;
    toState: string;
    causeKind: string;
    reason: string;
    createdAt: string;
  }>(
    `select id, from_state as "fromState", to_state as "toState",
            cause_kind as "causeKind", reason, created_at as "createdAt"
       from r6b_prospect_state_transitions
      where prospect_id = $1`,
    [prospectId],
  );
  for (const transition of transitions) {
    entries.push(
      Object.freeze({
        id: `state:${transition.id}`,
        kind: 'state_transition' as const,
        direction: 'system' as const,
        occurredAt: transition.createdAt,
        channel: null,
        title: `${transition.fromState ?? '∅'} → ${transition.toState}`,
        body: transition.reason,
        facts: Object.freeze([`cause ${transition.causeKind}`]),
      }),
    );
  }

  const milestones = await sql.query<{
    id: string;
    milestone: string;
    occurredAt: string;
    note: string | null;
  }>(
    `select id, milestone, occurred_at as "occurredAt", note
       from prospect_milestones
      where prospect_id = $1`,
    [prospectId],
  );
  for (const milestone of milestones) {
    entries.push(
      Object.freeze({
        id: `milestone:${milestone.id}`,
        kind: 'milestone' as const,
        direction: 'system' as const,
        occurredAt: milestone.occurredAt,
        channel: null,
        title: `Jalon — ${milestone.milestone}`,
        body: milestone.note,
        facts: Object.freeze([]),
      }),
    );
  }

  const alerts = await sql.query<{
    id: string;
    kind: string;
    severity: string;
    title: string;
    status: string;
    createdAt: string;
  }>(
    `select id, kind, severity, title, status, created_at as "createdAt"
       from r6b_alerts
      where prospect_id = $1`,
    [prospectId],
  );
  for (const alert of alerts) {
    entries.push(
      Object.freeze({
        id: `alert:${alert.id}`,
        kind: 'alert' as const,
        direction: 'system' as const,
        occurredAt: alert.createdAt,
        channel: null,
        title: `Alerte ${alert.kind} — ${alert.title}`,
        body: null,
        facts: Object.freeze([`sévérité ${alert.severity}`, `statut ${alert.status}`]),
      }),
    );
  }

  return Object.freeze(sortTimeline(entries));
}

// ---------------------------------------------------------------------------
// Inbox et alertes
// ---------------------------------------------------------------------------

export interface CrmInboxRow {
  readonly id: string;
  readonly prospectId: string | null;
  readonly company: string | null;
  readonly receivedAt: string;
  readonly fromAddress: string;
  readonly subject: string | null;
  readonly excerpt: string;
  readonly correlationStatus: string;
  readonly classification: string | null;
  readonly confidence: number | null;
  readonly nextAction: string | null;
  readonly draftStatus: string | null;
  /** `gmail` | `instagram` — le canal réel de la ligne (IG5.1). */
  readonly provider: string;
  /** `email_address` | `instagram_handle` — ce que `fromAddress` contient vraiment. */
  readonly counterpartyKind: string;
}

/**
 * Les réponses entrantes, corrélées ou non.
 *
 * Un message non corrélé apparaît AVEC son statut plutôt que d'être masqué :
 * c'est précisément la ligne qu'un humain doit arbitrer. Rien d'autre de la
 * boîte n'est lu — la table ne contient que ce que le poller a jugé lié à un
 * envoi sortant (R6B-D1).
 */
export async function loadCrmInbox(limit = 50, sql?: Sql): Promise<CrmInboxRow[]> {
  const db = sql ?? (await getSql());
  const bounded = Math.min(200, Math.max(1, Math.trunc(limit)));
  const rows = await db.query<CrmInboxRow>(
    `select i.id,
            i.correlated_prospect_id as "prospectId",
            p.display_name           as company,
            i.received_at            as "receivedAt",
            i.from_address           as "fromAddress",
            i.subject,
            left(i.body_text, 240)   as excerpt,
            i.correlation_status     as "correlationStatus",
            a.classification,
            a.confidence,
            a.recommended_next_action as "nextAction",
            d.status                  as "draftStatus",
            i.provider,
            i.counterparty_kind       as "counterpartyKind"
       from r6b_inbound_messages i
       left join prospects p on p.id = i.correlated_prospect_id
       left join r6b_reply_analyses a on a.inbound_message_id = i.id and a.status = 'ACTIVE'
       left join r6b_reply_drafts d on d.analysis_id = a.id
      order by i.received_at desc
      limit $1`,
    [bounded],
  );
  return rows.map((row) => Object.freeze(row));
}

/**
 * De quoi écrire un état vide HONNÊTE.
 *
 * Une boîte sans réponse peut vouloir dire deux choses opposées — « relevée,
 * rien n'est arrivé » ou « jamais relevée » — et l'opérateur ne doit pas avoir
 * à deviner laquelle. Tout ici est une ligne réelle : `last_polled_at` n'existe
 * qu'après un tour de poll intégralement persisté (migration 0025), et le
 * nombre de prospects contactés vient de `outreach_events`, le compteur de
 * sûreté du gate. Rien n'est projeté : ce dépôt ne contient aucun ordonnanceur,
 * donc aucune « prochaine relève » n'est affichée.
 */
export interface CrmInboxStatus {
  /** Boîte réellement relevée, ou `null` si aucun tour de poll n'a abouti. */
  readonly mailbox: string | null;
  readonly lastPolledAt: string | null;
  /** Nombre de fois où Gmail a refusé le curseur incrémental. */
  readonly invalidationCount: number;
  /** Prospects ayant reçu au moins un envoi réel. */
  readonly contactedProspects: number;
  readonly replies: number;
  /**
   * IG5.1 — le second rail entrant, affiché SÉPARÉMENT.
   *
   * Deux canaux relevés par deux mécanismes différents, à des moments
   * différents : les fondre dans un seul « dernier relevé » ferait croire
   * qu'Instagram a été relevé quand seul Gmail l'a été. Un `null` ici veut dire
   * « aucun tour Instagram n'a abouti », jamais « aucune réponse ».
   */
  readonly instagramAccount: string | null;
  readonly instagramLastPolledAt: string | null;
  readonly instagramReplies: number;
}

export async function loadCrmInboxStatus(sql?: Sql): Promise<CrmInboxStatus> {
  const db = sql ?? (await getSql());
  const [row] = await db.query<{
    mailbox: string | null;
    lastPolledAt: string | null;
    invalidationCount: number | null;
    contactedProspects: number;
    replies: number;
    instagramAccount: string | null;
    instagramLastPolledAt: string | null;
    instagramReplies: number;
  }>(
    `select (select mailbox from r6b_inbound_checkpoints
              where provider = 'gmail' and last_polled_at is not null
              order by last_polled_at desc limit 1)                            as mailbox,
            (select last_polled_at from r6b_inbound_checkpoints
              where provider = 'gmail' and last_polled_at is not null
              order by last_polled_at desc limit 1)                            as "lastPolledAt",
            (select invalidation_count from r6b_inbound_checkpoints
              where provider = 'gmail' and last_polled_at is not null
              order by last_polled_at desc limit 1)                            as "invalidationCount",
            (select count(distinct prospect_id)::int from outreach_events
              where kind = 'sent')                                             as "contactedProspects",
            (select count(*)::int from r6b_inbound_messages)                   as replies,
            -- Un tour Instagram ne compte que s'il est allé au bout : une
            -- relève interrompue ne prouve rien sur la boîte, et l'afficher
            -- comme « dernier relevé » ferait croire à une lecture réussie.
            (select account_handle from ig_inbound_polls
              where status = 'COMPLETED'
              order by finished_at desc limit 1)                               as "instagramAccount",
            (select finished_at from ig_inbound_polls
              where status = 'COMPLETED'
              order by finished_at desc limit 1)                               as "instagramLastPolledAt",
            (select count(*)::int from r6b_inbound_messages
              where provider = 'instagram')                                    as "instagramReplies"`,
  );
  return Object.freeze({
    mailbox: row?.mailbox ?? null,
    lastPolledAt: row?.lastPolledAt ?? null,
    invalidationCount: row?.invalidationCount ?? 0,
    contactedProspects: row?.contactedProspects ?? 0,
    replies: row?.replies ?? 0,
    instagramAccount: row?.instagramAccount ?? null,
    instagramLastPolledAt: row?.instagramLastPolledAt ?? null,
    instagramReplies: row?.instagramReplies ?? 0,
  });
}

export interface CrmAlertRow {
  readonly id: string;
  readonly kind: string;
  readonly severity: string;
  readonly title: string;
  readonly status: string;
  readonly prospectId: string;
  readonly company: string;
  readonly createdAt: string;
  readonly lastError: string | null;
}

export async function loadCrmAlerts(limit = 50, sql?: Sql): Promise<CrmAlertRow[]> {
  const db = sql ?? (await getSql());
  const bounded = Math.min(200, Math.max(1, Math.trunc(limit)));
  const rows = await db.query<CrmAlertRow>(
    `select al.id, al.kind, al.severity, al.title, al.status,
            al.prospect_id as "prospectId",
            p.display_name as company,
            al.created_at  as "createdAt",
            al.last_error  as "lastError"
       from r6b_alerts al
       join prospects p on p.id = al.prospect_id
      order by al.created_at desc
      limit $1`,
    [bounded],
  );
  return rows.map((row) => Object.freeze(row));
}

// ---------------------------------------------------------------------------
// En-tête
// ---------------------------------------------------------------------------

export interface CrmOverview {
  readonly prospects: number;
  readonly inPipeline: number;
  readonly contacted: number;
  readonly replies: number;
  readonly alertsOpen: number;
  /** Une copie CRM externe est-elle configurée ? Non par défaut, et sans conséquence. */
  readonly externalCrm: boolean;
}

export async function loadCrmOverview(sql?: Sql): Promise<CrmOverview> {
  const db = sql ?? (await getSql());
  const pipeline = await loadCrmPipeline(db);
  const [counts] = await db.query<{ replies: string; alerts: string; external: string }>(
    `select (select count(*) from r6b_inbound_messages)::text as replies,
            (select count(*) from r6b_alerts
              where status in ('PENDING','NO_PROVIDER','FAILED'))::text as alerts,
            (select count(*) from r6b_crm_destinations where status = 'CONFIRMED')::text as external`,
  );
  const contacted =
    pipeline.lanes.CONTACTED.length +
    pipeline.lanes.REPLIED.length +
    pipeline.lanes.INTERESTED.length +
    pipeline.lanes.NOT_NOW.length +
    pipeline.lanes.NOT_INTERESTED.length +
    pipeline.lanes.CLIENT.length;

  return Object.freeze({
    prospects: pipeline.total,
    inPipeline: pipeline.total - pipeline.upstream,
    contacted,
    replies: Number(counts?.replies ?? '0'),
    alertsOpen: Number(counts?.alerts ?? '0'),
    externalCrm: Number(counts?.external ?? '0') > 0,
  });
}
