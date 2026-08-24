import type { Sql } from '@/lib/db/sql';

/**
 * Accès aux données du batch pilote R6B-A (`/pilot/r6b`, migration 0018).
 *
 * Même patron que `r6a4Review.ts` : items immuables générés une fois, votes en
 * journal append-only. Différence de fond avec R6A : ce batch porte de vrais
 * prospects de production (`prospects.id`), pas un corpus de bench gelé — donc
 * pas de `corpus_hash`/`prospect_ref`, un `batch_id` et un `prospect_id`
 * directement.
 *
 * `OUTBOUND_ALLOW_SENDING` reste à 0 (CLAUDE.md) : rien n'est envoyé depuis ce
 * module. `SEND` n'écrit qu'une approbation — voir `CastR6bVoteInput`.
 */

export interface R6bBatchItem {
  id: string;
  itemIndex: number;
  prospectId: string;
  displayName: string;
  city: string | null;
  originalDraft: string;
  hookText: string | null;
  hookEvidenceIds: string[];
  contactChannels: string[];
  /** Le compte visé, tel que la fiche prospect le porte — jamais deviné ici. */
  instagramHandle: string | null;
  /**
   * R7-PILOT §1 / migration 0041 — `already_contacted` répond à l'échelle du
   * COMMERCE (toutes les lignes qui partagent une clé d'identité décisive),
   * pas de la ligne. `unknown` reste lisible pour les items écrits avant.
   */
  contactHistory: 'not_contacted' | 'unknown' | 'already_contacted';
}

export async function loadBatchBySlug(sql: Sql, slug: string): Promise<{ id: string; slug: string } | null> {
  const rows = await sql.query<{ id: string; slug: string }>(
    'select id, slug from r6b_batches where slug = $1',
    [slug],
  );
  return rows[0] ?? null;
}

export async function loadBatchItems(sql: Sql, batchId: string): Promise<R6bBatchItem[]> {
  return sql.query<R6bBatchItem>(
    `select bi.id, bi.item_index as "itemIndex", bi.prospect_id as "prospectId",
            p.display_name as "displayName", p.city,
            bi.original_draft as "originalDraft",
            a.personalization as "hookText",
            bi.hook_evidence_ids as "hookEvidenceIds",
            bi.contact_channels as "contactChannels",
            p.instagram_handle as "instagramHandle",
            bi.contact_history as "contactHistory"
       from r6b_batch_items bi
       join prospects p on p.id = bi.prospect_id
       left join prospect_angles a on a.id = bi.angle_id
      where bi.batch_id = $1
      order by bi.item_index asc`,
    [batchId],
  );
}

/**
 * R7-PILOT §2 — la liste des batchs, pour que `/pilot/r6b` cesse d'en connaître
 * un seul.
 *
 * L'écran affichait un slug écrit en dur. Un second lot ne pouvait donc pas
 * être relu sans modifier du TSX. Le défaut reste ce même slug — les liens
 * existants continuent de mener où ils menaient — mais `?batch=` ouvre les
 * autres, et cette liste les rend visibles au lieu de les laisser deviner.
 */
export interface R6bBatchSummary {
  readonly id: string;
  readonly slug: string;
  readonly campaignSlug: string | null;
  readonly itemCount: number;
  readonly votedCount: number;
  readonly createdAt: string;
}

export async function listBatches(sql: Sql): Promise<R6bBatchSummary[]> {
  const rows = await sql.query<{
    id: string;
    slug: string;
    campaignSlug: string | null;
    itemCount: string;
    votedCount: string;
    createdAt: string;
  }>(
    `select b.id, b.slug, c.slug as "campaignSlug", b.created_at as "createdAt",
            (select count(*) from r6b_batch_items i where i.batch_id = b.id)::text as "itemCount",
            (select count(distinct v.item_id) from r6b_batch_votes v
               join r6b_batch_items i on i.id = v.item_id
              where i.batch_id = b.id)::text as "votedCount"
       from r6b_batches b
       left join campaigns c on c.id = b.campaign_id
      order by b.created_at desc`,
  );
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    campaignSlug: row.campaignSlug,
    itemCount: Number.parseInt(row.itemCount, 10),
    votedCount: Number.parseInt(row.votedCount, 10),
    createdAt: String(row.createdAt),
  }));
}

export interface R6bBatchVote {
  id: string;
  itemId: string;
  verdict: 'SEND' | 'EDIT' | 'REJECT';
  approved: boolean;
  approvedText: string | null;
  approvedAt: string | null;
  note: string | null;
  isCorrection: boolean;
  createdAt: string;
}

export async function loadLatestVotes(
  sql: Sql,
  itemIds: readonly string[],
): Promise<Map<string, R6bBatchVote>> {
  if (itemIds.length === 0) return new Map();
  const rows = await sql.query<R6bBatchVote>(
    `select id, item_id as "itemId", verdict, approved,
            approved_text as "approvedText", approved_at as "approvedAt",
            note, is_correction as "isCorrection", created_at as "createdAt"
       from r6b_batch_votes
      where item_id = any($1::uuid[])
      -- HERMES-END-TO-END-CERTIFICATION-R1 — l'id départage une égalité.
      -- created_at vaut now(), l'heure de la TRANSACTION : deux votes d'un
      -- même passage la partagent, et sous PGlite tous la partagent. Sans
      -- troisième terme, « le dernier vote » était désigné par l'ordre
      -- physique — et l'autre lecture du même fait
      -- (autonomousApproval.ts, order by created_at desc limit 1) pouvait
      -- désigner l'autre ligne. Deux lectures, deux gagnants, sur la question
      -- « un humain a-t-il refusé cet item ? ».
      order by created_at asc, id asc`,
    [itemIds],
  );
  const latest = new Map<string, R6bBatchVote>();
  for (const row of rows) latest.set(row.itemId, row); // ordre croissant : le dernier écrit gagne
  return latest;
}

export interface CastR6bVoteInput {
  itemId: string;
  verdict: 'SEND' | 'EDIT' | 'REJECT';
  /** Texte exact du textarea. Ignoré (jamais stocké) pour REJECT. */
  approvedText: string | null;
  note: string | null;
}

/**
 * Toujours un insert, jamais un update : une seconde soumission sur le même
 * item est une correction journalisée (`is_correction = true`). §16 de la
 * mission : SEND et EDIT approuvent tous les deux un texte pour un futur
 * envoi (pas un envoi maintenant) ; REJECT n'approuve rien.
 */
export async function castR6bVote(sql: Sql, input: CastR6bVoteInput): Promise<void> {
  const existing = await sql.query<{ id: string }>(
    'select id from r6b_batch_votes where item_id = $1 limit 1',
    [input.itemId],
  );
  const approved = input.verdict !== 'REJECT';
  const approvedText = approved ? input.approvedText : null;

  await sql.query(
    `insert into r6b_batch_votes (item_id, verdict, approved, approved_text, approved_at, note, is_correction)
     values ($1,$2,$3,$4, case when $3 then now() else null end, $5, $6)`,
    [input.itemId, input.verdict, approved, approvedText, input.note, existing.length > 0],
  );
}

export interface R6bSummary {
  total: number;
  voted: number;
  send: number;
  edit: number;
  reject: number;
}

export function summarizeR6b(
  items: readonly R6bBatchItem[],
  votesByItem: ReadonlyMap<string, R6bBatchVote>,
): R6bSummary {
  let send = 0;
  let edit = 0;
  let reject = 0;
  for (const item of items) {
    const vote = votesByItem.get(item.id);
    if (!vote) continue;
    if (vote.verdict === 'SEND') send += 1;
    else if (vote.verdict === 'EDIT') edit += 1;
    else reject += 1;
  }
  const voted = send + edit + reject;
  return { total: items.length, voted, send, edit, reject };
}
