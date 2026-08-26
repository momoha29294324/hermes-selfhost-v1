import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { linkBusinessEntities } from '@/lib/pipeline/businessEntityLink';
import { resolveBusinessIdentityGroup } from '@/lib/pipeline/businessContactGuard';
import type { Sql } from '@/lib/db/sql';

/**
 * HERMES-SERVICE-SCOPE-TARGETING-R1 §13-§14 — l'entité métier, éprouvée sur le
 * scénario DEMOJULIET.
 *
 * Le cas est réel : deux lignes portent `registry_id:484122452`, le même
 * domaine et le même compte Instagram, dans deux campagnes différentes, et
 * TOUTES DEUX portent `dedupe_status = 'unique'`. Ce fichier prouve trois
 * choses :
 *
 *   1. la passe les reconnaît comme UNE entreprise ;
 *   2. elle ne touche NI `dedupe_status`, NI `merged_into_id`, NI une seule
 *      ligne de campagne — §14 l'exige, et la provenance en dépend ;
 *   3. la clôture est TRANSITIVE : A–B par le SIREN, B–C par le domaine, et
 *      A–C sans rien en commun, forment quand même une seule entité. Sans cela
 *      « une entreprise, une intention » laisserait partir deux messages.
 *
 * Base PGlite temporaire, migrée comme le reste du dépôt. Aucun réseau, aucun
 * envoi, jamais la base de production.
 */

let dir: string;
let sql: Sql;
let campaignA: string;
let campaignB: string;
let campaignC: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'business-entity-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);
});

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await sql.query('delete from prospects');
  await sql.query('delete from business_entities');
  await sql.query('delete from campaigns');
  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config)
     values ('camp-a','A','example-services','{}'::jsonb),
            ('camp-b','B','example-services','{}'::jsonb),
            ('camp-c','C','example-services','{}'::jsonb)
     returning id`,
  );
  campaignA = rows[0]!.id;
  campaignB = rows[1]!.id;
  campaignC = rows[2]!.id;
});

async function insertProspect(input: {
  campaignId: string;
  name: string;
  registryId?: string | null;
  domain?: string | null;
  handle?: string | null;
  stage?: string;
  firstSeenAt?: string;
}): Promise<string> {
  const rows = await sql.query<{ id: string }>(
    `insert into prospects (campaign_id, canonical_key, display_name, registry_id, domain,
                            instagram_handle, stage, first_seen_at)
     values ($1,$2,$3,$4,$5,$6,$7, coalesce($8::timestamptz, now())) returning id`,
    [
      input.campaignId,
      `key-${input.name}-${String(Math.random())}`,
      input.name,
      input.registryId ?? null,
      input.domain ?? null,
      input.handle ?? null,
      input.stage ?? 'qualified',
      input.firstSeenAt ?? null,
    ],
  );
  return rows[0]!.id;
}

describe('§14 — le défaut DEMOJULIET', () => {
  it('deux campagnes, un SIREN : une seule entreprise, deux lignes intactes', async () => {
    const first = await insertProspect({
      campaignId: campaignA,
      name: 'DEMOJULIET',
      registryId: '484122452',
      domain: 'demo-56-exemple.fr',
      handle: 'demojuliet_france',
      stage: 'message_ready',
      firstSeenAt: '2026-08-10T00:00:00.000Z',
    });
    const second = await insertProspect({
      campaignId: campaignB,
      name: 'DEMOJULIET',
      registryId: '484122452',
      domain: 'demo-56-exemple.fr',
      handle: 'demojuliet_france',
      stage: 'message_ready',
      firstSeenAt: '2026-08-19T00:00:00.000Z',
    });

    const report = await linkBusinessEntities(sql, { apply: true });
    expect(report.multiRowEntities).toBe(1);
    expect(report.crossCampaignEntities).toBe(1);

    const rows = await sql.query<{ id: string; entityId: string | null; dedupe: string }>(
      `select id, business_entity_id as "entityId", dedupe_status as dedupe from prospects order by first_seen_at`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.entityId).not.toBeNull();
    expect(rows[0]!.entityId).toBe(rows[1]!.entityId);

    // §14 — la provenance est intacte : rien n'a été fusionné ni réécrit.
    expect(rows.every((row) => row.dedupe === 'unique')).toBe(true);
    const merged = await sql.query(`select id from prospects where merged_into_id is not null`);
    expect(merged).toHaveLength(0);

    const group = report.groups.find((entry) => entry.members.length > 1);
    expect(group?.canonicalKey).toBe('registry_id:484122452');
    // La ligne la plus ancienne, à stade égal, représente l'entreprise.
    expect(group?.representativeProspectId).toBe(first);
    expect(group?.members.map((member) => member.prospectId).sort()).toEqual([first, second].sort());
  });

  it('la passe est idempotente : un second passage ne crée rien', async () => {
    await insertProspect({ campaignId: campaignA, name: 'X', registryId: '111111111' });
    await insertProspect({ campaignId: campaignB, name: 'X', registryId: '111111111' });

    const first = await linkBusinessEntities(sql, { apply: true });
    expect(first.entitiesCreated).toBe(1);
    const second = await linkBusinessEntities(sql, { apply: true });
    expect(second.entitiesCreated).toBe(0);
    expect(second.entitiesReused).toBe(1);

    const count = await sql.query<{ n: number }>(`select count(*)::int as n from business_entities`);
    expect(count[0]!.n).toBe(1);
  });

  it('le mode lecture seule n’écrit rien', async () => {
    await insertProspect({ campaignId: campaignA, name: 'Y', domain: 'y.fr' });
    const report = await linkBusinessEntities(sql);
    expect(report.prospectsLinked).toBe(1);

    const entities = await sql.query<{ n: number }>(`select count(*)::int as n from business_entities`);
    expect(entities[0]!.n).toBe(0);
    const linked = await sql.query<{ n: number }>(
      `select count(*)::int as n from prospects where business_entity_id is not null`,
    );
    expect(linked[0]!.n).toBe(0);
  });
});

describe('§13 — quelles clés lient, et lesquelles ne lient pas', () => {
  it('même domaine dans deux campagnes → une entité', async () => {
    await insertProspect({ campaignId: campaignA, name: 'A', domain: 'atelier.fr' });
    await insertProspect({ campaignId: campaignB, name: 'B', domain: 'atelier.fr' });
    const report = await linkBusinessEntities(sql, { apply: true });
    expect(report.multiRowEntities).toBe(1);
  });

  it('même compte Instagram dans deux campagnes → une entité', async () => {
    await insertProspect({ campaignId: campaignA, name: 'A', handle: 'monprestation' });
    await insertProspect({ campaignId: campaignB, name: 'B', handle: 'monprestation' });
    const report = await linkBusinessEntities(sql, { apply: true });
    expect(report.multiRowEntities).toBe(1);
    expect(report.groups.find((group) => group.members.length > 1)?.canonicalKey).toBe('instagram:monprestation');
  });

  it('un NOM identique seul ne fusionne RIEN — §13 l’interdit', async () => {
    // Deux sociétés distinctes portent le même nom de métier, dans deux villes.
    await insertProspect({ campaignId: campaignA, name: 'PRESTATION STANDARD AUTOMOBILE', registryId: '222222222' });
    await insertProspect({ campaignId: campaignB, name: 'PRESTATION STANDARD AUTOMOBILE', registryId: '333333333' });
    const report = await linkBusinessEntities(sql, { apply: true });
    expect(report.multiRowEntities).toBe(0);
    expect(report.entitiesCreated).toBe(2);
  });

  it('la clôture est TRANSITIVE : A–B par le SIREN, B–C par le domaine', async () => {
    const a = await insertProspect({ campaignId: campaignA, name: 'A', registryId: '444444444' });
    const b = await insertProspect({
      campaignId: campaignB,
      name: 'B',
      registryId: '444444444',
      domain: 'pont.fr',
    });
    const c = await insertProspect({ campaignId: campaignC, name: 'C', domain: 'pont.fr' });

    const report = await linkBusinessEntities(sql, { apply: true });
    expect(report.entitiesCreated).toBe(1);

    const rows = await sql.query<{ id: string; entityId: string | null }>(
      `select id, business_entity_id as "entityId" from prospects`,
    );
    const ids = new Set(rows.map((row) => row.entityId));
    expect(ids.size).toBe(1);
    expect(rows.map((row) => row.id).sort()).toEqual([a, b, c].sort());
  });

  it('une ligne FUSIONNÉE ne représente plus son entreprise', async () => {
    // `resolveBusinessIdentityGroup` garde volontairement les lignes fusionnées
    // dans le groupe — une fiche fusionnée qui a reçu un message l'a bien reçu.
    // Mais elle ne doit pas pouvoir être ÉLUE : l'élire bloquerait la ligne
    // vivante au profit d'une ligne dont le dépôt a décidé qu'elle n'existait
    // plus. La passe l'écarte en amont (`dedupe_status <> 'merged'`).
    const alive = await insertProspect({
      campaignId: campaignA,
      name: 'VIVANTE',
      registryId: '666666666',
      stage: 'message_ready',
      firstSeenAt: '2026-08-19T00:00:00.000Z',
    });
    const dead = await insertProspect({
      campaignId: campaignB,
      name: 'FUSIONNÉE',
      registryId: '666666666',
      stage: 'message_ready',
      firstSeenAt: '2026-08-01T00:00:00.000Z',
    });
    // La fusionnée est PLUS ANCIENNE : sans l'exclusion, elle gagnerait
    // l'élection à stade égal, et la ligne vivante serait écartée en doublon.
    await sql.query(
      `update prospects set dedupe_status = 'merged', merged_into_id = $2 where id = $1`,
      [dead, alive],
    );

    const report = await linkBusinessEntities(sql, { apply: true });
    const group = report.groups.find((entry) =>
      entry.members.some((member) => member.prospectId === alive),
    );
    expect(group?.members.map((member) => member.prospectId)).toEqual([alive]);
    expect(group?.representativeProspectId).toBe(alive);
  });

  it('une ligne sans aucune clé décisive n’est rattachée à rien', async () => {
    await insertProspect({ campaignId: campaignA, name: 'SANS CLÉ' });
    const report = await linkBusinessEntities(sql, { apply: true });
    expect(report.prospectsWithoutKey).toBe(1);
    expect(report.entitiesCreated).toBe(0);
    const linked = await sql.query<{ n: number }>(
      `select count(*)::int as n from prospects where business_entity_id is not null`,
    );
    expect(linked[0]!.n).toBe(0);
  });

  it('la passe et la garde de contact voient le MÊME groupe', async () => {
    // Deux formes de la même vérité : si elles divergeaient, la garde
    // refuserait un doublon que la mémoire déclarerait unique, ou l'inverse.
    const first = await insertProspect({ campaignId: campaignA, name: 'A', registryId: '555555555' });
    await insertProspect({ campaignId: campaignB, name: 'B', registryId: '555555555' });
    const report = await linkBusinessEntities(sql, { apply: true });
    const group = await resolveBusinessIdentityGroup(sql, first);

    const fromPass = report.groups.find((entry) => entry.members.some((m) => m.prospectId === first));
    expect(fromPass?.members).toHaveLength(group.prospectIds.length);
    expect(group.crossCampaign).toBe(true);
  });
});

describe('la contrainte de forme de la clé canonique', () => {
  it('la base refuse une clé canonique sans genre', async () => {
    await expect(
      sql.query(`insert into business_entities (canonical_key) values ('484122452')`),
    ).rejects.toThrow();
  });

  it('la base refuse deux entités portant la même clé', async () => {
    await sql.query(`insert into business_entities (canonical_key) values ('registry_id:999999999')`);
    await expect(
      sql.query(`insert into business_entities (canonical_key) values ('registry_id:999999999')`),
    ).rejects.toThrow();
  });
});
