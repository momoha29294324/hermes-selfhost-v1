import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { castR6bVote, loadLatestVotes } from '@/lib/pipeline/r6bBatch';
import {
  AutonomousApprovalError,
  recordAutonomousApproval,
} from '@/lib/pipeline/autonomousApproval';
import { AUTONOMOUS_POLICY_VERSION } from '@/lib/instagram/autonomousPolicy';
import type { Sql } from '@/lib/db/sql';

/**
 * HERMES-AUTONOMOUS-R2 §2/§3 — une approbation machine ne se déguise jamais en
 * décision humaine, et n'en renverse jamais une.
 *
 * Ce fichier n'ouvre pas Instagram, ne verrouille aucun manifeste et n'enfile
 * rien : il éprouve la seule question de gouvernance que 0047 introduit — QUI a
 * approuvé ce message, et la base sait-elle le dire sans ambiguïté.
 *
 * La propriété centrale, testée dans les deux sens : lues au SQL, sans passer
 * par le code applicatif, les deux familles de votes doivent être séparables.
 * Un test qui interrogerait nos propres accesseurs prouverait seulement qu'ils
 * sont cohérents avec eux-mêmes.
 */

let sql: Sql;
let dir: string;
let campaignId: string;
let itemIds: string[];

const TEXT = 'Bonjour, une question rapide sur vos prises de rendez-vous.';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-autonomous-approval-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);

  const campaign = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
    ['example-autonomous-r2-test', 'Test', 'example-services', '{}'],
  );
  campaignId = campaign[0]!.id;
});

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  const batch = await sql.query<{ id: string }>(
    `insert into r6b_batches (slug, campaign_id) values ($1,$2) returning id`,
    [`autonomous-${String(Date.now())}-${String(Math.random())}`, campaignId],
  );
  const batchId = batch[0]!.id;

  itemIds = [];
  for (let i = 0; i < 3; i += 1) {
    const prospect = await sql.query<{ id: string }>(
      `insert into prospects (campaign_id, canonical_key, display_name)
       values ($1,$2,$3) returning id`,
      [campaignId, `prospect-${String(i)}-${String(Math.random())}`, `Prospect ${String(i)}`],
    );
    const item = await sql.query<{ id: string }>(
      `insert into r6b_batch_items (batch_id, prospect_id, item_index, original_draft, hook_evidence_ids)
       values ($1,$2,$3,$4,$5) returning id`,
      [batchId, prospect[0]!.id, i + 1, TEXT, JSON.stringify([`ev-${String(i)}`])],
    );
    itemIds.push(item[0]!.id);
  }
});

/** Lit la provenance AU SQL, sans passer par nos accesseurs. */
async function provenanceOf(itemId: string): Promise<{ actorKind: string; policyVersion: string | null }[]> {
  return sql.query<{ actorKind: string; policyVersion: string | null }>(
    `select actor_kind as "actorKind", policy_version as "policyVersion"
       from r6b_batch_votes where item_id = $1 order by created_at asc`,
    [itemId],
  );
}

// ---------------------------------------------------------------------------
// Ce que la migration dit des votes qui existaient déjà
// ---------------------------------------------------------------------------

describe('les votes humains (0018), inchangés', () => {
  it('un vote déposé par le chemin humain porte la provenance HUMAN', async () => {
    const itemId = itemIds[0]!;
    await castR6bVote(sql, { itemId, verdict: 'SEND', approvedText: TEXT, note: null });

    const rows = await provenanceOf(itemId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorKind).toBe('HUMAN');
    // Un humain ne porte AUCUNE version de politique : ce n'est pas un
    // programme qui a tranché, et la contrainte le refuserait.
    expect(rows[0]!.policyVersion).toBeNull();
  });

  it('`castR6bVote` n’a pas eu besoin de changer — la sémantique existante est intacte', async () => {
    const itemId = itemIds[0]!;
    await castR6bVote(sql, { itemId, verdict: 'EDIT', approvedText: 'texte réécrit', note: 'reformulé' });
    const votes = await loadLatestVotes(sql, [itemId]);
    expect(votes.get(itemId)?.approvedText).toBe('texte réécrit');
    expect((await provenanceOf(itemId))[0]!.actorKind).toBe('HUMAN');
  });

  it('un vote humain ne peut pas porter une version de politique', async () => {
    const itemId = itemIds[0]!;
    await expect(
      sql.query(
        `insert into r6b_batch_votes
           (item_id, verdict, approved, approved_text, approved_at, actor_kind, policy_version)
         values ($1,'SEND',true,$2,now(),'HUMAN','hermes-autonomous-r2')`,
        [itemId, TEXT],
      ),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Ce que la machine écrit
// ---------------------------------------------------------------------------

describe('l’approbation machine', () => {
  it('porte la provenance AUTONOMOUS_POLICY et nomme sa politique', async () => {
    const itemId = itemIds[0]!;
    const approval = await recordAutonomousApproval(sql, {
      itemId,
      approvedText: TEXT,
      policyVersion: AUTONOMOUS_POLICY_VERSION,
    });

    expect(approval.actorKind).toBe('AUTONOMOUS_POLICY');
    expect(approval.policyVersion).toBe(AUTONOMOUS_POLICY_VERSION);

    const rows = await provenanceOf(itemId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorKind).toBe('AUTONOMOUS_POLICY');
    expect(rows[0]!.policyVersion).toBe(AUTONOMOUS_POLICY_VERSION);
  });

  it('est SÉPARABLE d’un vote humain par une requête, pas par une lecture de note', async () => {
    // La propriété qui compte pour l'audit : « lesquels de ces messages ont été
    // relus par quelqu'un ? » doit être une question SQL, pas une lecture de
    // texte libre.
    const human = itemIds[0]!;
    const machine = itemIds[1]!;
    await castR6bVote(sql, { itemId: human, verdict: 'SEND', approvedText: TEXT, note: null });
    await recordAutonomousApproval(sql, {
      itemId: machine,
      approvedText: TEXT,
      policyVersion: AUTONOMOUS_POLICY_VERSION,
    });

    // Bornée aux items de CE test : la table est append-only et partagée par
    // tout le fichier — une requête globale mesurerait l'histoire, pas la
    // propriété qu'on veut établir.
    const machineVotes = await sql.query<{ itemId: string }>(
      `select item_id as "itemId" from r6b_batch_votes
        where actor_kind = 'AUTONOMOUS_POLICY' and item_id = any($1::uuid[])`,
      [itemIds],
    );
    expect(machineVotes.map((r) => r.itemId)).toEqual([machine]);

    const humanVotes = await sql.query<{ itemId: string }>(
      `select item_id as "itemId" from r6b_batch_votes
        where actor_kind = 'HUMAN' and item_id = any($1::uuid[])`,
      [itemIds],
    );
    expect(humanVotes.map((r) => r.itemId)).toEqual([human]);
  });

  it('n’écrit jamais un REJECT, ni un EDIT — la base le refuse aussi', async () => {
    const itemId = itemIds[0]!;
    for (const verdict of ['REJECT', 'EDIT'] as const) {
      await expect(
        sql.query(
          `insert into r6b_batch_votes
             (item_id, verdict, approved, approved_text, approved_at, actor_kind, policy_version)
           values ($1,$2,$3,$4,$5,'AUTONOMOUS_POLICY','hermes-autonomous-r2')`,
          [
            itemId,
            verdict,
            verdict !== 'REJECT',
            verdict === 'REJECT' ? null : TEXT,
            verdict === 'REJECT' ? null : new Date().toISOString(),
          ],
        ),
      ).rejects.toThrow();
    }
  });

  it('une décision machine SANS politique nommée est refusée par la base', async () => {
    const itemId = itemIds[0]!;
    await expect(
      sql.query(
        `insert into r6b_batch_votes
           (item_id, verdict, approved, approved_text, approved_at, actor_kind)
         values ($1,'SEND',true,$2,now(),'AUTONOMOUS_POLICY')`,
        [itemId, TEXT],
      ),
    ).rejects.toThrow();
  });

  it('refuse d’approuver un texte vide', async () => {
    await expect(
      recordAutonomousApproval(sql, {
        itemId: itemIds[0]!,
        approvedText: '   ',
        policyVersion: AUTONOMOUS_POLICY_VERSION,
      }),
    ).rejects.toThrow(AutonomousApprovalError);
  });
});

// ---------------------------------------------------------------------------
// §3 — un REJECT humain n'est jamais renversé
// ---------------------------------------------------------------------------

describe('un REJECT humain', () => {
  it('empêche toute approbation machine sur cet item', async () => {
    const itemId = itemIds[0]!;
    await castR6bVote(sql, { itemId, verdict: 'REJECT', approvedText: null, note: 'pas notre cible' });

    await expect(
      recordAutonomousApproval(sql, { itemId, approvedText: TEXT, policyVersion: AUTONOMOUS_POLICY_VERSION }),
    ).rejects.toThrow(AutonomousApprovalError);

    // Et rien n'a été écrit : le refus est un refus, pas un avertissement.
    const rows = await provenanceOf(itemId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorKind).toBe('HUMAN');
  });

  it('reste lisible pour toujours — la machine n’efface aucun vote humain', async () => {
    const itemId = itemIds[0]!;
    await castR6bVote(sql, { itemId, verdict: 'SEND', approvedText: TEXT, note: 'relu le 12 août' });
    await recordAutonomousApproval(sql, { itemId, approvedText: TEXT, policyVersion: AUTONOMOUS_POLICY_VERSION });

    const rows = await provenanceOf(itemId);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.actorKind).toBe('HUMAN');
    expect(rows[1]!.actorKind).toBe('AUTONOMOUS_POLICY');
  });

  it('quand la machine reprend un texte humain, elle le DIT sans se prétendre humaine', async () => {
    const itemId = itemIds[0]!;
    await castR6bVote(sql, { itemId, verdict: 'EDIT', approvedText: TEXT, note: 'reformulé' });
    const approval = await recordAutonomousApproval(sql, {
      itemId,
      approvedText: TEXT,
      policyVersion: AUTONOMOUS_POLICY_VERSION,
    });

    expect(approval.carriesHumanText).toBe(true);
    expect(approval.isCorrection).toBe(true);
    // La provenance ne bouge pas d'un pouce pour autant.
    expect(approval.actorKind).toBe('AUTONOMOUS_POLICY');
  });
});
