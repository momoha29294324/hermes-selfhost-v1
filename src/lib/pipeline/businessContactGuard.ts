import type { Sql } from '@/lib/db/sql';
import {
  normalizeDomainKey,
  normalizeEmailKey,
  normalizeHandleKey,
  normalizeRegistryKey,
} from '@/lib/pipeline/duplicateForensic';

/**
 * R7-PILOT §1 — « ce commerce a-t-il déjà été contacté ? », posée à l'IDENTITÉ
 * plutôt qu'à la ligne.
 *
 * ---------------------------------------------------------------------------
 * Le défaut que ce module ferme
 * ---------------------------------------------------------------------------
 * La déduplication de `ProspectRepository.upsertDiscovered` est scopée par
 * campagne : `findByIdentityKeys` filtre sur `campaign_id`, et
 * `prospect_identities` porte la campagne dans sa clé d'unicité. C'est un choix
 * défendable pour la FUSION — deux campagnes sont deux corpus, deux
 * provenances, deux dates, et fusionner à travers les deux effacerait de la
 * traçabilité que personne n'a demandé d'effacer.
 *
 * Ce choix devient dangereux dès qu'on lit le résultat comme une réponse à une
 * autre question. Le 19 août 2026, la campagne `example-campaign` a recréé
 * `DEMO PROSPECT A` / `example.org` / `@demo_prospect_a` sous un nouvel identifiant
 * (`8d9da856…`), alors que `example-campaign` portait déjà cette identité
 * (`d5cddd2d…`) — et que cette dernière avait reçu un DM Instagram le 13 août,
 * conclu `DELIVERY_FAILED` par une adjudication humaine. La nouvelle ligne
 * affichait `outreach_events = 0`, ce qui est vrai de la LIGNE et faux du
 * COMMERCE. Toutes les portes qui protègent contre un second contact
 * (`eligibility.ts` §4/§5/§6) interrogeaient `prospect_id = <la nouvelle ligne>`
 * et ne pouvaient donc rien voir.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce module fait, et ce qu'il ne fait pas
 * ---------------------------------------------------------------------------
 * Il regroupe, en LECTURE SEULE, les lignes `prospects` qui partagent une clé
 * d'identité DÉCISIVE, toutes campagnes confondues, puis lit l'historique de
 * contact de tout le groupe.
 *
 * Il ne fusionne rien, ne réécrit rien, ne supprime rien. Deux lignes peuvent
 * rester distinctes — provenance, campagne, date de découverte — tout en étant
 * reconnues comme le même commerce au moment de décider d'un envoi. C'est
 * exactement la séparation demandée : « la relation doit néanmoins empêcher le
 * double contact », sans fusion destructive silencieuse.
 *
 * ---------------------------------------------------------------------------
 * Quelles clés lient, et pourquoi celles-là
 * ---------------------------------------------------------------------------
 * Les mêmes que `DECISIVE_KINDS` de `src/lib/identity/resolve.ts`, c'est-à-dire
 * celles dont ce dépôt considère déjà qu'elles PROUVENT « même entreprise » :
 * SIREN, domaine, identifiant de lieu, compte Instagram, adresse e-mail.
 *
 * Deux exclusions volontaires :
 *
 *   * le TÉLÉPHONE — `identityKeys` lui donne un poids de 0,8 et le range hors
 *     des clés décisives, parce qu'un standard, un numéro de franchise ou un
 *     portable de gérant se partagent réellement entre entités distinctes ;
 *   * le NOM, même normalisé, même approché. « ATELIER CAR » est un nom de
 *     métier que plusieurs sociétés portent, dans des communes différentes,
 *     avec des SIREN différents (`duplicateForensic.ts` le documente sur le
 *     corpus réel). Un rapprochement flou de noms peut SIGNALER ; il ne peut
 *     pas BLOQUER, sans quoi la garde refuserait des prospects légitimes en
 *     silence.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi aucune notion de « recontact autorisé après N jours »
 * ---------------------------------------------------------------------------
 * Aucune décision produit n'a fixé de délai de recontact. En inventer un ici
 * ferait exister une politique que personne n'a prise, et le sens de ce module
 * est précisément l'inverse. Le verdict dit donc « déjà contacté », le détail
 * dit QUAND, et un humain qui veut recontacter le fait avec une nouvelle
 * décision nommée — jamais par l'écoulement du temps.
 */

// ---------------------------------------------------------------------------
// Les clés qui lient
// ---------------------------------------------------------------------------

export type BindingKind = 'registry_id' | 'domain' | 'google_place_id' | 'instagram' | 'email';

export const BINDING_KINDS: readonly BindingKind[] = [
  'registry_id',
  'domain',
  'google_place_id',
  'instagram',
  'email',
];

export interface IdentityLink {
  readonly kind: BindingKind;
  readonly value: string;
}

/** La fiche prospect réduite à ce qui peut lier deux lignes. */
export interface BindingSource {
  readonly registryId?: string | null;
  readonly domain?: string | null;
  readonly websiteUrl?: string | null;
  readonly googlePlaceId?: string | null;
  readonly instagramHandle?: string | null;
  readonly email?: string | null;
}

/**
 * Les clés décisives d'une fiche, normalisées.
 *
 * Fonction pure : c'est elle que les tests éprouvent, et c'est elle qui garantit
 * que `@AJ_Atelier_33`, `demo_account_18` et `https://instagram.com/…` — non,
 * pas cette dernière : `normalizeHandleKey` ne fait que retirer l'arobase et la
 * casse, exactement comme `prospects.instagram_handle` est déjà stocké. Une
 * URL complète n'est pas un handle et n'est pas convertie en douce ici ; c'est
 * le rail de découverte qui extrait le handle, avec sa preuve.
 */
export function bindingKeysOf(source: BindingSource): IdentityLink[] {
  const keys: IdentityLink[] = [];
  const push = (kind: BindingKind, value: string | null): void => {
    if (value === null || value.length === 0) return;
    if (keys.some((key) => key.kind === kind && key.value === value)) return;
    keys.push({ kind, value });
  };

  push('registry_id', normalizeRegistryKey(source.registryId ?? null));
  push('domain', normalizeDomainKey(source.domain ?? source.websiteUrl ?? null));
  push('google_place_id', (source.googlePlaceId ?? null)?.trim().toLowerCase() || null);
  push('instagram', normalizeHandleKey(source.instagramHandle ?? null));
  push('email', normalizeEmailKey(source.email ?? null));

  return keys;
}

// ---------------------------------------------------------------------------
// Le groupe
// ---------------------------------------------------------------------------

export interface IdentityGroupMember {
  readonly prospectId: string;
  readonly displayName: string;
  readonly campaignId: string | null;
  readonly campaignSlug: string | null;
  /** `true` pour le prospect interrogé lui-même. */
  readonly isSelf: boolean;
  /** Pourquoi cette ligne est dans le groupe. Vide pour le prospect lui-même. */
  readonly linkedBy: readonly IdentityLink[];
}

export interface BusinessIdentityGroup {
  readonly prospectId: string;
  readonly keys: readonly IdentityLink[];
  readonly members: readonly IdentityGroupMember[];
  /** Les autres lignes du groupe — celles que l'ancien contrôle ne voyait pas. */
  readonly siblings: readonly IdentityGroupMember[];
  readonly prospectIds: readonly string[];
  /** Le groupe s'étend-il au-delà de la campagne du prospect interrogé ? */
  readonly crossCampaign: boolean;
}

/**
 * L'index d'identité, unifié.
 *
 * Deux sources, réunies par `union` : les colonnes de `prospects` (l'état
 * courant de la fiche) et `prospect_identities` (le journal des clés observées,
 * qui garde une valeur même après qu'une source ultérieure ait rempli
 * autrement la colonne). Interroger l'une sans l'autre laisserait passer un
 * doublon : la colonne seule rate une clé historique, le journal seul rate une
 * clé posée par un backfill direct.
 *
 * `campaign_id` n'apparaît nulle part dans ce SQL, et c'est tout le propos.
 */
const IDENTITY_INDEX_SQL = `
  select prospect_id, kind, value from prospect_identities
   where kind in ('registry_id','domain','google_place_id','instagram','email')
     and value is not null and length(value) > 0
  union
  select id, 'domain',          lower(domain)            from prospects where domain is not null
  union
  select id, 'domain',          lower(regexp_replace(regexp_replace(website_url, '^https?://', ''), '^www\\.', ''))
    from prospects where domain is null and website_url is not null
  union
  select id, 'instagram',       lower(instagram_handle)  from prospects where instagram_handle is not null
  union
  select id, 'email',           lower(email)             from prospects where email is not null
  union
  select id, 'registry_id',     registry_id              from prospects where registry_id is not null
  union
  select id, 'google_place_id', lower(google_place_id)   from prospects where google_place_id is not null
`;

interface MemberRow {
  prospectId: string;
  displayName: string;
  campaignId: string | null;
  campaignSlug: string | null;
  kind: string;
  value: string;
}

export async function resolveBusinessIdentityGroup(
  sql: Sql,
  prospectId: string,
): Promise<BusinessIdentityGroup> {
  const selfRows = await sql.query<{
    id: string;
    displayName: string;
    campaignId: string | null;
    campaignSlug: string | null;
    registryId: string | null;
    domain: string | null;
    websiteUrl: string | null;
    googlePlaceId: string | null;
    instagramHandle: string | null;
    email: string | null;
  }>(
    `select p.id, p.display_name as "displayName", p.campaign_id as "campaignId",
            c.slug as "campaignSlug", p.registry_id as "registryId", p.domain,
            p.website_url as "websiteUrl", p.google_place_id as "googlePlaceId",
            p.instagram_handle as "instagramHandle", p.email
       from prospects p left join campaigns c on c.id = p.campaign_id
      where p.id = $1`,
    [prospectId],
  );
  const self = selfRows[0];
  if (!self) {
    throw new Error(`businessContactGuard : prospect ${prospectId} introuvable`);
  }

  // Les clés de la fiche, plus celles que le journal d'identité lui connaît.
  const keys = bindingKeysOf(self);
  const journalled = await sql.query<{ kind: string; value: string }>(
    `select distinct kind, value from prospect_identities
      where prospect_id = $1 and kind = any($2::text[])`,
    [prospectId, [...BINDING_KINDS]],
  );
  for (const row of journalled) {
    const kind = row.kind as BindingKind;
    const value = row.value.trim().toLowerCase();
    if (value.length === 0) continue;
    if (!keys.some((key) => key.kind === kind && key.value === value)) keys.push({ kind, value });
  }

  const selfMember: IdentityGroupMember = Object.freeze({
    prospectId: self.id,
    displayName: self.displayName,
    campaignId: self.campaignId,
    campaignSlug: self.campaignSlug,
    isSelf: true,
    linkedBy: Object.freeze([]),
  });

  if (keys.length === 0) {
    return Object.freeze({
      prospectId,
      keys: Object.freeze([]),
      members: Object.freeze([selfMember]),
      siblings: Object.freeze([]),
      prospectIds: Object.freeze([prospectId]),
      crossCampaign: false,
    });
  }

  const rows = await sql.query<MemberRow>(
    `with wanted(kind, value) as (select * from unnest($2::text[], $3::text[])),
          idx as (${IDENTITY_INDEX_SQL})
     select idx.prospect_id as "prospectId", p.display_name as "displayName",
            p.campaign_id as "campaignId", c.slug as "campaignSlug",
            idx.kind, idx.value
       from idx
       join wanted w on w.kind = idx.kind and w.value = idx.value
       join prospects p on p.id = idx.prospect_id
       left join campaigns c on c.id = p.campaign_id
      where idx.prospect_id <> $1
      order by p.created_at asc`,
    [prospectId, keys.map((key) => key.kind), keys.map((key) => key.value)],
  );

  const byProspect = new Map<string, { row: MemberRow; links: IdentityLink[] }>();
  for (const row of rows) {
    const existing = byProspect.get(row.prospectId);
    const link: IdentityLink = { kind: row.kind as BindingKind, value: row.value };
    if (existing) {
      if (!existing.links.some((l) => l.kind === link.kind && l.value === link.value)) existing.links.push(link);
    } else {
      byProspect.set(row.prospectId, { row, links: [link] });
    }
  }

  const siblings: IdentityGroupMember[] = [...byProspect.values()].map((entry) =>
    Object.freeze({
      prospectId: entry.row.prospectId,
      displayName: entry.row.displayName,
      campaignId: entry.row.campaignId,
      campaignSlug: entry.row.campaignSlug,
      isSelf: false,
      linkedBy: Object.freeze([...entry.links]),
    }),
  );

  const members = [selfMember, ...siblings];
  return Object.freeze({
    prospectId,
    keys: Object.freeze([...keys]),
    members: Object.freeze(members),
    siblings: Object.freeze(siblings),
    prospectIds: Object.freeze(members.map((member) => member.prospectId)),
    crossCampaign: siblings.some((sibling) => sibling.campaignId !== self.campaignId),
  });
}

// ---------------------------------------------------------------------------
// L'historique de contact du groupe
// ---------------------------------------------------------------------------

/**
 * D'où vient la preuve qu'un contact a eu lieu.
 *
 *   `outreach_event`   — la table canonique du « un humain a été joint » (0023).
 *   `ig_dispatch_job`  — un job Instagram `SENT` ou `DELIVERY_FAILED`. Les deux
 *                        comptent : `DELIVERY_FAILED` est le verdict d'une
 *                        adjudication humaine sur une tentative RÉELLE, et une
 *                        tentative réelle a pu laisser une trace côté prospect.
 *                        C'est le cas exact de `@demo_prospect_a` le 13 août.
 *   `live_send_attempt`— une tentative d'envoi R6B qui a touché le réseau.
 */
export type ContactSource = 'outreach_event' | 'ig_dispatch_job' | 'live_send_attempt';

export interface ContactRecord {
  readonly prospectId: string;
  readonly isSelf: boolean;
  readonly source: ContactSource;
  /** `instagram_dm`, `email`, … — le transport, dans le vocabulaire des manifestes. */
  readonly channel: string;
  readonly status: string;
  readonly occurredAt: string;
  readonly reference: string;
}

export interface SuppressionRecord {
  readonly prospectId: string;
  readonly isSelf: boolean;
  readonly matchKind: string;
  readonly value: string;
  readonly reason: string;
}

export interface ActiveIntent {
  readonly prospectId: string;
  readonly isSelf: boolean;
  readonly jobId: string;
  readonly manifestId: string;
  readonly status: string;
}

/**
 * Le verdict, dans le vocabulaire déjà employé par le rail Instagram
 * (`InstagramSkipReason` : `already_contacted`, `opt_out`, `duplicate`). Aucun
 * mot nouveau n'est inventé pour une notion qui en avait déjà un.
 */
export type ContactVerdict = 'CLEAR' | 'DO_NOT_CONTACT' | 'ALREADY_CONTACTED' | 'CONCURRENT_INTENT';

export interface BusinessContactHistory {
  readonly group: BusinessIdentityGroup;
  readonly contacts: readonly ContactRecord[];
  readonly suppressions: readonly SuppressionRecord[];
  readonly activeIntents: readonly ActiveIntent[];
  readonly verdict: ContactVerdict;
  /** Vrai dès qu'une autre ligne représente le même commerce, contactée ou non. */
  readonly duplicateIdentity: boolean;
}

/**
 * L'ordre des verdicts, du plus définitif au plus réparable.
 *
 * Une exclusion (`do_not_contact`) prime sur tout : elle vient du prospect
 * lui-même. Un contact abouti vient ensuite. Une intention concurrente est la
 * plus faible des trois — elle décrit notre propre file, pas le prospect.
 */
export function verdictOf(input: {
  readonly contacts: readonly ContactRecord[];
  readonly suppressions: readonly SuppressionRecord[];
  readonly activeIntents: readonly ActiveIntent[];
}): ContactVerdict {
  if (input.suppressions.length > 0) return 'DO_NOT_CONTACT';
  if (input.contacts.length > 0) return 'ALREADY_CONTACTED';
  if (input.activeIntents.length > 0) return 'CONCURRENT_INTENT';
  return 'CLEAR';
}

const NON_TERMINAL_JOB_STATUSES = ['PENDING', 'CLAIMED', 'DRY_RUN_VALIDATED', 'BLOCKED', 'SKIPPED'];

export async function loadBusinessContactHistory(
  sql: Sql,
  prospectId: string,
): Promise<BusinessContactHistory> {
  const group = await resolveBusinessIdentityGroup(sql, prospectId);
  const ids = [...group.prospectIds];
  const selfIds = new Set([prospectId]);

  const eventRows = await sql.query<{
    prospectId: string;
    channel: string;
    kind: string;
    occurredAt: string;
    manifestId: string | null;
    id: string;
  }>(
    `select prospect_id as "prospectId", channel, kind, occurred_at as "occurredAt",
            manifest_id as "manifestId", id
       from outreach_events
      where prospect_id = any($1::uuid[])
      order by occurred_at asc`,
    [ids],
  );

  const jobRows = await sql.query<{
    prospectId: string;
    id: string;
    manifestId: string;
    status: string;
    createdAt: string;
  }>(
    `select prospect_id as "prospectId", id, manifest_id as "manifestId", status,
            coalesce(terminated_at, created_at) as "createdAt"
       from ig_dispatch_jobs
      where prospect_id = any($1::uuid[])
      order by created_at asc`,
    [ids],
  );

  const attemptRows = await sql.query<{
    prospectId: string;
    id: string;
    manifestId: string;
    transport: string;
    status: string;
    occurredAt: string;
  }>(
    `select m.prospect_id as "prospectId", a.id, a.manifest_id as "manifestId",
            a.transport, a.status, coalesce(a.completed_at, a.network_started_at, a.claimed_at) as "occurredAt"
       from r6b_live_send_attempts a
       join r6b_dispatch_manifests m on m.id = a.manifest_id
      where m.prospect_id = any($1::uuid[]) and a.network_attempted = true
      order by a.claimed_at asc`,
    [ids],
  );

  const suppressionRows = await sql.query<{
    prospectId: string;
    matchKind: string;
    value: string;
    reason: string;
  }>(
    `select p.id as "prospectId", d.match_kind as "matchKind", d.value, d.reason
       from prospects p
       join do_not_contact d
         on (d.match_kind = 'instagram'   and lower(d.value) = lower(p.instagram_handle))
         or (d.match_kind = 'email'       and lower(d.value) = lower(p.email))
         or (d.match_kind = 'domain'      and lower(d.value) = lower(p.domain))
         or (d.match_kind = 'registry_id' and d.value = p.registry_id)
      where p.id = any($1::uuid[])`,
    [ids],
  );

  const contacts: ContactRecord[] = [
    ...eventRows.map((row) => ({
      prospectId: row.prospectId,
      isSelf: selfIds.has(row.prospectId),
      source: 'outreach_event' as const,
      channel: row.channel,
      status: row.kind,
      occurredAt: String(row.occurredAt),
      reference: row.manifestId ?? row.id,
    })),
    ...jobRows
      .filter((row) => row.status === 'SENT' || row.status === 'DELIVERY_FAILED')
      .map((row) => ({
        prospectId: row.prospectId,
        isSelf: selfIds.has(row.prospectId),
        source: 'ig_dispatch_job' as const,
        channel: 'instagram_dm',
        status: row.status,
        occurredAt: String(row.createdAt),
        reference: row.id,
      })),
    ...attemptRows.map((row) => ({
      prospectId: row.prospectId,
      isSelf: selfIds.has(row.prospectId),
      source: 'live_send_attempt' as const,
      channel: row.transport,
      status: row.status,
      occurredAt: String(row.occurredAt),
      reference: row.id,
    })),
  ].sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : 1));

  const activeIntents: ActiveIntent[] = jobRows
    .filter((row) => NON_TERMINAL_JOB_STATUSES.includes(row.status))
    .map((row) => ({
      prospectId: row.prospectId,
      isSelf: selfIds.has(row.prospectId),
      jobId: row.id,
      manifestId: row.manifestId,
      status: row.status,
    }));

  const suppressions: SuppressionRecord[] = suppressionRows.map((row) => ({
    prospectId: row.prospectId,
    isSelf: selfIds.has(row.prospectId),
    matchKind: row.matchKind,
    value: row.value,
    reason: row.reason,
  }));

  return Object.freeze({
    group,
    contacts: Object.freeze(contacts),
    suppressions: Object.freeze(suppressions),
    activeIntents: Object.freeze(activeIntents),
    verdict: verdictOf({ contacts, suppressions, activeIntents }),
    duplicateIdentity: group.siblings.length > 0,
  });
}

// ---------------------------------------------------------------------------
// Lecture par canal
// ---------------------------------------------------------------------------

/**
 * Les contacts du groupe sur UN transport donné.
 *
 * Le cloisonnement par canal est délibéré, et c'est la seule décision de ce
 * module qui laisse passer quelque chose. Un e-mail envoyé en août à ce
 * commerce n'interdit pas un DM Instagram : ce sont deux conversations, et
 * décider d'en ouvrir une seconde appartient à un humain. Ce qui est interdit
 * sans nouvelle décision, c'est de rouvrir DEUX FOIS LA MÊME.
 *
 * Les contacts des autres canaux restent lus, rendus, et affichés à côté du
 * message dans la review — visibles, jamais silencieux.
 */
export function contactsOnChannel(
  history: BusinessContactHistory,
  channel: string,
): readonly ContactRecord[] {
  return history.contacts.filter((contact) => contact.channel === channel);
}

/** Les contacts d'un autre canal — informatifs, jamais bloquants. */
export function contactsOnOtherChannels(
  history: BusinessContactHistory,
  channel: string,
): readonly ContactRecord[] {
  return history.contacts.filter((contact) => contact.channel !== channel);
}

/** Une phrase courte pour un journal ou une carte de review. */
export function describeLink(link: IdentityLink): string {
  return `${link.kind}:${link.value}`;
}

export function describeGroup(group: BusinessIdentityGroup): string {
  if (group.siblings.length === 0) return 'aucune autre ligne ne porte cette identité';
  return group.siblings
    .map(
      (sibling) =>
        `${sibling.displayName} (${sibling.campaignSlug ?? 'campagne inconnue'}, ${sibling.prospectId}) ` +
        `lié par ${sibling.linkedBy.map(describeLink).join(' + ')}`,
    )
    .join(' ; ');
}

/**
 * R7-PILOT §1 — l'historique de contact d'un item, lu à l'échelle du COMMERCE.
 *
 * `contactHistoryFromCount` ci-dessus répondait sur la ligne, et disait donc
 * « jamais contacté » d'une ligne fraîche appartenant à un commerce déjà joint.
 * Cette fonction lit le groupe d'identité entier — toutes campagnes confondues
 * — et peut donc écrire la troisième valeur que la migration 0041 a ajoutée.
 *
 * `unknown` n'est plus rendu ici : quand le groupe est lu, on SAIT. La valeur
 * reste dans le type pour les lignes écrites avant cette mission.
 */
export function contactHistoryFromGroup(
  history: BusinessContactHistory,
): 'not_contacted' | 'already_contacted' {
  return history.contacts.length > 0 ? 'already_contacted' : 'not_contacted';
}

export async function contactHistoryForProspect(
  sql: Sql,
  prospectId: string,
): Promise<{ value: 'not_contacted' | 'already_contacted'; history: BusinessContactHistory }> {
  const history = await loadBusinessContactHistory(sql, prospectId);
  return { value: contactHistoryFromGroup(history), history };
}
