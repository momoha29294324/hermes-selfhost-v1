import type { Sql } from '@/lib/db/sql';
import { canonicalBusinessKey, electRepresentative } from '@/lib/pipeline/canonicalBusiness';
import { BINDING_KINDS, type BindingKind, type IdentityLink } from '@/lib/pipeline/businessContactGuard';

/**
 * HERMES-CLEANING-ONLY-ICP-R1 §13-§14 — la PASSE qui rattache les lignes de
 * campagne à leur entité métier.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi une passe, et pas la migration
 * ---------------------------------------------------------------------------
 * La migration 0052 crée la table vide et la colonne à `null`. Le rattachement
 * est ici, dans du code rejouable et testable, pour trois raisons :
 *
 *   * il RÉSOUT quelque chose — une clôture transitive sur un graphe de clés —
 *     et un résultat calculé doit pouvoir être recalculé, contesté, corrigé.
 *     Un `insert … select` figé dans une migration ne se rejoue jamais ;
 *   * il doit tourner à nouveau après chaque découverte, sans quoi la mémoire
 *     retarde d'une campagne sur la réalité ;
 *   * il ne doit RIEN pouvoir casser. Il n'écrit que
 *     `prospects.business_entity_id` et `business_entities` : aucune fusion,
 *     aucune suppression, aucun `dedupe_status` touché, aucun manifeste lu.
 *
 * ---------------------------------------------------------------------------
 * La clôture transitive, et pourquoi elle est nécessaire
 * ---------------------------------------------------------------------------
 * Trois lignes peuvent appartenir au même commerce sans qu'aucune paire ne
 * partage la MÊME clé : A et B partagent un SIREN, B et C partagent un domaine,
 * A et C ne partagent rien. Un regroupement par clé rendrait deux entités là où
 * il y en a une, et la garde « une entreprise, une intention » laisserait donc
 * partir deux messages.
 *
 * Union-find sur le graphe (ligne ↔ clé) résout cela une fois pour toutes, en
 * une passe, sans requête par prospect.
 */

export interface BusinessEntityLinkReport {
  /** Lignes examinées (les fusionnées sont exclues : elles ne représentent plus rien). */
  readonly prospectsScanned: number;
  /** Lignes rattachées à une entité. */
  readonly prospectsLinked: number;
  /** Lignes sans aucune clé décisive — ni SIREN, ni domaine, ni compte, ni e-mail. */
  readonly prospectsWithoutKey: number;
  readonly entitiesCreated: number;
  readonly entitiesReused: number;
  /** Entités portant plus d'une ligne : le défaut DEMOJULIET, compté. */
  readonly multiRowEntities: number;
  /** Entités dont les lignes s'étendent sur plusieurs campagnes. */
  readonly crossCampaignEntities: number;
  readonly groups: readonly BusinessEntityGroupReport[];
}

export interface BusinessEntityGroupReport {
  readonly canonicalKey: string;
  readonly entityId: string;
  readonly representativeProspectId: string | null;
  readonly members: readonly {
    readonly prospectId: string;
    readonly displayName: string;
    readonly campaignSlug: string | null;
    readonly stage: string | null;
    readonly dedupeStatus: string | null;
    readonly isRepresentative: boolean;
  }[];
  readonly campaignSlugs: readonly string[];
}

interface ProspectRow {
  id: string;
  displayName: string;
  campaignId: string | null;
  campaignSlug: string | null;
  stage: string | null;
  dedupeStatus: string | null;
  firstSeenAt: string | Date | null;
}

interface KeyRow {
  prospectId: string;
  kind: string;
  value: string;
}

/**
 * Le MÊME index d'identité que `businessContactGuard`, à une clause près : les
 * lignes fusionnées en sont retirées.
 *
 * Recopié plutôt qu'importé parce que la garde interroge UN prospect et que
 * cette passe les balaie TOUS — deux formes de la même vérité, et le jour où
 * l'une change, l'autre doit changer avec elle. Le test
 * `businessEntityLink.test.ts` compare les deux sur le même corpus, ce qui rend
 * la divergence visible plutôt que silencieuse.
 */
const KEY_INDEX_SQL = `
  select prospect_id as "prospectId", kind as "kind", value as "value" from prospect_identities
   where kind = any($1::text[]) and value is not null and length(value) > 0
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

/** Union-find, sans compression sophistiquée : quelques centaines de lignes. */
class Sets {
  private readonly parent = new Map<string, string>();

  find(node: string): string {
    let current = this.parent.get(node);
    if (current === undefined) {
      this.parent.set(node, node);
      return node;
    }
    while (current !== node) {
      node = current;
      current = this.parent.get(node) ?? node;
    }
    return current;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;
    // Ordre stable : la plus petite chaîne devient la racine, pour que deux
    // exécutions sur les mêmes données produisent les mêmes composantes.
    if (rootA < rootB) this.parent.set(rootB, rootA);
    else this.parent.set(rootA, rootB);
  }
}

/**
 * Rattache toutes les lignes vivantes à leur entité métier.
 *
 * `apply = false` calcule et rend le rapport sans écrire une seule ligne :
 * c'est le mode par défaut, parce qu'un regroupement d'identités se relit avant
 * de s'appliquer.
 */
export async function linkBusinessEntities(
  sql: Sql,
  options: { apply?: boolean } = {},
): Promise<BusinessEntityLinkReport> {
  const apply = options.apply === true;

  const prospects = await sql.query<ProspectRow>(
    `select p.id, p.display_name as "displayName", p.campaign_id as "campaignId",
            c.slug as "campaignSlug", p.stage, p.dedupe_status as "dedupeStatus",
            p.first_seen_at as "firstSeenAt"
       from prospects p left join campaigns c on c.id = p.campaign_id
      where p.dedupe_status <> 'merged'
      order by p.first_seen_at asc, p.id asc`,
  );
  const byId = new Map(prospects.map((row) => [row.id, row]));

  const keyRows = await sql.query<KeyRow>(KEY_INDEX_SQL, [[...BINDING_KINDS]]);

  // Un nœud « clé » et un nœud « ligne » vivent dans le même ensemble : c'est
  // ce qui rend la transitivité gratuite. Les préfixes empêchent qu'un
  // identifiant de prospect entre en collision avec une valeur de clé.
  const sets = new Sets();
  const keysOf = new Map<string, IdentityLink[]>();
  for (const row of keyRows) {
    if (!byId.has(row.prospectId)) continue;
    const value = row.value.trim().toLowerCase();
    if (value.length === 0) continue;
    const kind = row.kind as BindingKind;
    sets.union(`p:${row.prospectId}`, `k:${kind}:${value}`);
    const list = keysOf.get(row.prospectId) ?? [];
    if (!list.some((key) => key.kind === kind && key.value === value)) list.push({ kind, value });
    keysOf.set(row.prospectId, list);
  }

  const components = new Map<string, string[]>();
  let withoutKey = 0;
  for (const row of prospects) {
    const keys = keysOf.get(row.id);
    if (keys === undefined || keys.length === 0) {
      withoutKey += 1;
      continue;
    }
    const root = sets.find(`p:${row.id}`);
    const members = components.get(root) ?? [];
    members.push(row.id);
    components.set(root, members);
  }

  const groups: BusinessEntityGroupReport[] = [];
  let created = 0;
  let reused = 0;
  let linked = 0;
  let multiRow = 0;
  let crossCampaign = 0;

  for (const members of components.values()) {
    const allKeys: IdentityLink[] = [];
    for (const id of members) {
      for (const key of keysOf.get(id) ?? []) {
        if (!allKeys.some((k) => k.kind === key.kind && k.value === key.value)) allKeys.push(key);
      }
    }
    const canonicalKey = canonicalBusinessKey(allKeys);
    if (canonicalKey === null) continue;

    const rows = members
      .map((id) => byId.get(id))
      .filter((row): row is ProspectRow => row !== undefined);

    const representative = electRepresentative(
      rows.map((row) => ({
        prospectId: row.id,
        stage: row.stage,
        firstSeenAt: row.firstSeenAt === null ? null : new Date(row.firstSeenAt).toISOString(),
      })),
    );

    const firstSeen = rows
      .map((row) => (row.firstSeenAt === null ? null : new Date(row.firstSeenAt).toISOString()))
      .filter((value): value is string => value !== null)
      .sort()[0];

    let entityId = '';
    if (apply) {
      // Idempotent par construction : la clé canonique est unique, et un second
      // passage retombe sur la même ligne plutôt que d'en créer une seconde.
      const upserted = await sql.query<{ id: string; inserted: boolean }>(
        `insert into business_entities (canonical_key, first_linked_at)
         values ($1, coalesce($2::timestamptz, now()))
         on conflict (canonical_key) do update
            set updated_at = now(),
                first_linked_at = least(business_entities.first_linked_at,
                                        coalesce($2::timestamptz, business_entities.first_linked_at))
         returning id, (xmax = 0) as inserted`,
        [canonicalKey, firstSeen ?? null],
      );
      const row = upserted[0];
      if (row === undefined) throw new Error(`business_entities : upsert sans retour pour ${canonicalKey}`);
      entityId = row.id;
      if (row.inserted) created += 1;
      else reused += 1;
      await sql.query(`update prospects set business_entity_id = $1 where id = any($2::uuid[])`, [
        entityId,
        members,
      ]);
      linked += members.length;
    } else {
      const existing = await sql.query<{ id: string }>(
        `select id from business_entities where canonical_key = $1`,
        [canonicalKey],
      );
      const found = existing[0];
      if (found === undefined) created += 1;
      else {
        reused += 1;
        entityId = found.id;
      }
      linked += members.length;
    }

    const slugs = [...new Set(rows.map((row) => row.campaignSlug ?? '—'))].sort();
    if (rows.length > 1) multiRow += 1;
    if (slugs.length > 1) crossCampaign += 1;

    groups.push(
      Object.freeze({
        canonicalKey,
        entityId,
        representativeProspectId: representative,
        members: Object.freeze(
          rows.map((row) =>
            Object.freeze({
              prospectId: row.id,
              displayName: row.displayName,
              campaignSlug: row.campaignSlug,
              stage: row.stage,
              dedupeStatus: row.dedupeStatus,
              isRepresentative: representative === row.id,
            }),
          ),
        ),
        campaignSlugs: Object.freeze(slugs),
      }),
    );
  }

  return Object.freeze({
    prospectsScanned: prospects.length,
    prospectsLinked: linked,
    prospectsWithoutKey: withoutKey,
    entitiesCreated: created,
    entitiesReused: reused,
    multiRowEntities: multiRow,
    crossCampaignEntities: crossCampaign,
    groups: Object.freeze(groups),
  });
}
