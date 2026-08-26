import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import {
  castR6bVote,
  loadBatchBySlug,
  loadBatchItems,
  loadLatestVotes,
  summarizeR6b,
} from '@/lib/pipeline/r6bBatch';
import type { Sql } from '@/lib/db/sql';

/**
 * R6B-A — comportement du batch persistant (§14/§16/§18/§21 de la mission).
 *
 * Base PGlite temporaire, migrée avec 0018 comme le reste du dépôt (patron de
 * `tests/safety.test.ts` / `tests/r6a2cReview.test.ts`) — jamais la base de
 * production.
 */

let sql: Sql;
let dir: string;
let campaignId: string;
let prospectIds: string[];
let batchId: string;
let itemIds: string[];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-r6b-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);

  const campaignRows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
    ['example-campaign-test', 'Test', 'example-services', '{}'],
  );
  campaignId = campaignRows[0]!.id;

  prospectIds = [];
  for (let i = 0; i < 5; i += 1) {
    const rows = await sql.query<{ id: string }>(
      `insert into prospects (campaign_id, canonical_key, display_name)
       values ($1,$2,$3) returning id`,
      [campaignId, `prospect-${i}`, `Prospect ${i}`],
    );
    prospectIds.push(rows[0]!.id);
  }
});

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  // Un batch propre par test, pour que les votes d'un test ne polluent pas le suivant.
  await sql.query('delete from r6b_batches');
  const batchRows = await sql.query<{ id: string }>(
    `insert into r6b_batches (slug, campaign_id) values ($1,$2) returning id`,
    [`batch-${Date.now()}-${Math.random()}`, campaignId],
  );
  batchId = batchRows[0]!.id;

  itemIds = [];
  for (let i = 0; i < 5; i += 1) {
    const rows = await sql.query<{ id: string }>(
      `insert into r6b_batch_items
         (batch_id, prospect_id, item_index, original_draft, hook_evidence_ids)
       values ($1,$2,$3,$4,$5) returning id`,
      [batchId, prospectIds[i], i + 1, `brouillon original ${i}`, JSON.stringify([`ev-${i}`])],
    );
    itemIds.push(rows[0]!.id);
  }
});

describe('immutabilité du batch après génération (§14/§21)', () => {
  it('un même prospect ne peut pas apparaître deux fois dans le même batch', async () => {
    await expect(
      sql.query(
        `insert into r6b_batch_items (batch_id, prospect_id, item_index, original_draft)
         values ($1,$2,$3,$4)`,
        [batchId, prospectIds[0], 99, 'doublon'],
      ),
    ).rejects.toThrow();
  });

  it('deux items ne peuvent pas partager le même item_index dans un batch', async () => {
    const rows = await sql.query<{ id: string }>(
      `insert into prospects (campaign_id, canonical_key, display_name) values ($1,$2,$3) returning id`,
      [campaignId, 'prospect-extra', 'Prospect Extra'],
    );
    await expect(
      sql.query(
        `insert into r6b_batch_items (batch_id, prospect_id, item_index, original_draft)
         values ($1,$2,$3,$4)`,
        [batchId, rows[0]!.id, 1, 'index dupliqué'],
      ),
    ).rejects.toThrow();
  });

  it('le brouillon original ne bouge jamais quand un vote est déposé', async () => {
    await castR6bVote(sql, {
      itemId: itemIds[0]!,
      verdict: 'EDIT',
      approvedText: 'texte corrigé par un opérateur',
      note: null,
    });
    const items = await loadBatchItems(sql, batchId);
    expect(items[0]?.originalDraft).toBe('brouillon original 0');
  });
});

describe('sémantique SEND/EDIT/REJECT (§16)', () => {
  it('SEND approuve un texte pour un futur envoi — jamais un envoi réel', async () => {
    await castR6bVote(sql, {
      itemId: itemIds[0]!,
      verdict: 'SEND',
      approvedText: 'brouillon original 0',
      note: null,
    });
    const votes = await loadLatestVotes(sql, [itemIds[0]!]);
    const vote = votes.get(itemIds[0]!);
    expect(vote?.approved).toBe(true);
    expect(vote?.approvedText).toBe('brouillon original 0');
    expect(vote?.approvedAt).not.toBeNull();

    // §17/§18 : approbation != envoi. Aucun événement d'envoi n'est créé par un vote.
    const events = await sql.query<{ n: string }>('select count(*)::text as n from outreach_events');
    expect(events[0]?.n).toBe('0');
  });

  it('EDIT persiste le texte édité sans jamais perdre le brouillon original', async () => {
    await castR6bVote(sql, {
      itemId: itemIds[1]!,
      verdict: 'EDIT',
      approvedText: 'texte qu’un opérateur a réécrit',
      note: 'reformulé la question',
    });
    const votes = await loadLatestVotes(sql, [itemIds[1]!]);
    const vote = votes.get(itemIds[1]!);
    expect(vote?.verdict).toBe('EDIT');
    expect(vote?.approved).toBe(true);
    expect(vote?.approvedText).toBe('texte qu’un opérateur a réécrit');

    const items = await loadBatchItems(sql, batchId);
    const item = items.find((entry) => entry.id === itemIds[1]);
    expect(item?.originalDraft).toBe('brouillon original 1');
  });

  it('REJECT n’approuve rien, même si un texte est fourni', async () => {
    await castR6bVote(sql, {
      itemId: itemIds[2]!,
      verdict: 'REJECT',
      approvedText: 'un texte quelconque',
      note: 'pas pertinent',
    });
    const votes = await loadLatestVotes(sql, [itemIds[2]!]);
    const vote = votes.get(itemIds[2]!);
    expect(vote?.verdict).toBe('REJECT');
    expect(vote?.approved).toBe(false);
    expect(vote?.approvedText).toBeNull();
    expect(vote?.approvedAt).toBeNull();
  });

  it('un rejet ne devient jamais implicitement une approbation', async () => {
    await castR6bVote(sql, { itemId: itemIds[3]!, verdict: 'REJECT', approvedText: null, note: null });
    let votes = await loadLatestVotes(sql, [itemIds[3]!]);
    expect(votes.get(itemIds[3]!)?.approved).toBe(false);

    // Sans nouveau vote explicite, le statut reste REJECT indéfiniment.
    votes = await loadLatestVotes(sql, [itemIds[3]!]);
    expect(votes.get(itemIds[3]!)?.verdict).toBe('REJECT');

    // Un changement d'avis est une correction explicite et journalisée, pas un écrasement.
    await castR6bVote(sql, {
      itemId: itemIds[3]!,
      verdict: 'SEND',
      approvedText: 'finalement approuvé après relecture',
      note: 'correction : je change d’avis',
    });
    votes = await loadLatestVotes(sql, [itemIds[3]!]);
    const latest = votes.get(itemIds[3]!);
    expect(latest?.verdict).toBe('SEND');
    expect(latest?.isCorrection).toBe(true);

    const history = await sql.query<{ verdict: string }>(
      'select verdict from r6b_batch_votes where item_id = $1 order by created_at asc',
      [itemIds[3]],
    );
    expect(history.map((row) => row.verdict)).toEqual(['REJECT', 'SEND']);
  });
});

describe('résumé du batch', () => {
  it('compte correctement send/edit/reject/non jugés', async () => {
    await castR6bVote(sql, { itemId: itemIds[0]!, verdict: 'SEND', approvedText: 'a', note: null });
    await castR6bVote(sql, { itemId: itemIds[1]!, verdict: 'EDIT', approvedText: 'b', note: null });
    await castR6bVote(sql, { itemId: itemIds[2]!, verdict: 'REJECT', approvedText: null, note: null });

    const items = await loadBatchItems(sql, batchId);
    const votes = await loadLatestVotes(sql, items.map((item) => item.id));
    const summary = summarizeR6b(items, votes);

    expect(summary.total).toBe(5);
    expect(summary.send).toBe(1);
    expect(summary.edit).toBe(1);
    expect(summary.reject).toBe(1);
    expect(summary.voted).toBe(3);
  });

  it('loadBatchBySlug retrouve le batch par son identifiant', async () => {
    const rows = await sql.query<{ slug: string }>('select slug from r6b_batches where id = $1', [batchId]);
    const found = await loadBatchBySlug(sql, rows[0]!.slug);
    expect(found?.id).toBe(batchId);
  });
});

describe('§20 — invariants globaux', () => {
  it('aucun outreach_event n’existe, quel que soit l’état des votes', async () => {
    const events = await sql.query<{ n: string }>('select count(*)::text as n from outreach_events');
    expect(events[0]?.n).toBe('0');
  });

  it('OUTBOUND_ALLOW_SENDING reste à 0 dans l’environnement de test', () => {
    expect(process.env['OUTBOUND_ALLOW_SENDING'] ?? '0').toBe('0');
  });
});
