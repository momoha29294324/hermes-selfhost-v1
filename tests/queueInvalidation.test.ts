import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { runAutonomousDispatch, AUTONOMOUS_RAIL_ACTOR } from '@/lib/instagram/autonomousDispatch';
import { invalidateQueueUnderCurrentPolicy } from '@/lib/instagram/queueInvalidation';
import { claimNextInstagramJob } from '@/lib/instagram/queue';
import { assessProspect, recordIcpAssessment } from '@/lib/pipeline/icpAssessment';
import { loadIcpProfile } from '@/lib/config/load';
import { recordAudienceObservation } from '@/lib/pipeline/audienceObservation';
import { makeProspectInstagramEligible } from './support/instagramEligibility';
import type { Sql } from '@/lib/db/sql';

/**
 * HERMES-CLEANING-ONLY-ICP-R1 §10 et §29 — « un ancien PENDING devenu
 * non-cleaning ne doit jamais être consommable ».
 *
 * Le scénario reproduit exactement ce qui s'est passé le 22 août 2026 : un
 * prospect ENTRE légitimement dans la file sous les preuves qu'on a de lui, une
 * observation ultérieure révèle qu'il vend aussi du REVENTE, et la politique
 * cleaning-only doit alors le refermer — sans supprimer sa ligne, avec le motif
 * exact, et sans qu'aucun effet n'ait été tenté.
 *
 * Rien n'est fabriqué : le job entre par `runAutonomousDispatch`, c'est-à-dire
 * par le chemin de production. Un test qui aurait inséré un job à la main
 * n'aurait prouvé que sa propre insertion.
 *
 * Base PGlite temporaire. Aucun navigateur, aucun réseau, aucun envoi.
 */

const TEXT =
  'Bonjour, j’ai vu votre page et vos photos de prestation standard intérieur. Vous prenez encore des ' +
  'rendez-vous cette semaine ?';

let dir: string;
let sql: Sql;
let campaignId: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'queue-invalidation-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);
});

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await sql.query('delete from ig_job_events');
  await sql.query('delete from ig_enqueue_decisions');
  await sql.query('delete from ig_dispatch_jobs');
  await sql.query('delete from r6b_dispatch_manifests');
  await sql.query('delete from r6b_batch_votes');
  await sql.query('delete from r6b_batch_items');
  await sql.query('delete from r6b_batches');
  await sql.query('delete from prospect_evidence');
  await sql.query('delete from prospect_audience_observations');
  await sql.query('delete from prospect_icp_assessments');
  await sql.query('delete from prospects');
  await sql.query('delete from campaigns');
  await sql.query(
    `insert into ig_kill_switch (id, engaged, set_by, reason)
     values (true, true, 'suite de tests', 'arrêt par défaut')
     on conflict (id) do update set engaged = true`,
  );
  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config)
     values ('inval-camp','Invalidation','example-services','{}'::jsonb) returning id`,
  );
  campaignId = rows[0]!.id;
});

/** Un prospect cleaning-only qui franchit réellement toutes les portes. */
async function queuedCleaningProspect(handle: string): Promise<{ jobId: string; prospectId: string }> {
  const prospect = await sql.query<{ id: string }>(
    `insert into prospects (campaign_id, canonical_key, display_name, instagram_handle, stage)
     values ($1,$2,'ATELIER PRESTATION STANDARD',$3,'message_ready') returning id`,
    [campaignId, `inval-${String(Math.random())}`, handle],
  );
  const prospectId = prospect[0]!.id;

  await sql.query(
    `insert into prospect_evidence (prospect_id, field, value_text, provider, method, source_url, confidence)
     values ($1,'instagram_handle',$2,'website','crawl','https://example.com',1.0),
            ($1,'website_title','Prestation standard auto intérieur et extérieur à domicile','website','crawl','https://example.com',1.0),
            ($1,'services','prestation standard interieur, prestation standard exterieur, shampoing sieges','website','crawl','https://example.com',1.0)`,
    [prospectId, handle],
  );
  await makeProspectInstagramEligible(sql, prospectId);

  const assessment = await assessProspect(sql, prospectId, loadIcpProfile('example-icp'));
  await recordIcpAssessment(sql, {
    prospectId,
    assessment: assessment!,
    decidedBy: 'deterministic',
    assessedBy: 'suite de tests HERMES-CLEANING-ONLY-ICP-R1',
  });
  await recordAudienceObservation(sql, {
    prospectId,
    platform: 'instagram',
    handle,
    followersCount: 1_120,
    attributed: true,
    observedAt: '2026-08-21T09:00:00.000Z',
    source: 'blob JSON embarqué dans le document du profil',
    observationRunId: null,
    importedBy: 'suite de tests HERMES-CLEANING-ONLY-ICP-R1',
  });

  const batchSlug = `inval-${String(Math.random())}`;
  const batch = await sql.query<{ id: string }>(
    `insert into r6b_batches (slug, campaign_id) values ($1,$2) returning id`,
    [batchSlug, campaignId],
  );
  await sql.query(
    `insert into r6b_batch_items
       (batch_id, prospect_id, item_index, original_draft, contact_channels, hook_evidence_ids)
     values ($1,$2,1,$3,$4,$5)`,
    [batch[0]!.id, prospectId, TEXT, JSON.stringify(['instagram']), JSON.stringify(['evidence-hook'])],
  );

  const report = await runAutonomousDispatch(sql, {
    batchSlug,
    apply: true,
    enqueuedBy: AUTONOMOUS_RAIL_ACTOR,
  });
  const outcome = report.outcomes[0];
  expect(outcome?.status, outcome?.reason ?? 'aucun résultat').toBe('QUEUED');
  return { jobId: outcome!.jobId!, prospectId };
}

describe('§10 — un job devenu non conforme est refermé, pas supprimé', () => {
  it('un PENDING dont le site révèle du REVENTE devient INELIGIBLE, avec son motif', async () => {
    const { jobId, prospectId } = await queuedCleaningProspect('atelier_demo_a');

    // L'observation nouvelle : le site vend aussi du film de protection.
    await sql.query(
      `insert into prospect_evidence (prospect_id, field, value_text, provider, method, source_url, confidence)
       values ($1,'premium_services','vente de produits, boutique en ligne','website','crawl','https://example.com',1.0)`,
      [prospectId],
    );

    const dryRun = await invalidateQueueUnderCurrentPolicy(sql, { operator: 'Operator Example' });
    expect(dryRun.closed).toBe(1);
    // Lecture seule : la file n'a pas bougé.
    const untouched = await sql.query<{ status: string }>(`select status from ig_dispatch_jobs where id = $1`, [jobId]);
    expect(untouched[0]!.status).toBe('PENDING');

    const applied = await invalidateQueueUnderCurrentPolicy(sql, { operator: 'Operator Example', apply: true });
    expect(applied.closed).toBe(1);
    expect(applied.jobs[0]!.skipReason).toBe('service_scope_not_in_scope_only');

    const rows = await sql.query<{
      status: string;
      reason: string | null;
      klass: string | null;
      terminated: boolean;
      effect: boolean;
    }>(
      `select status, last_skip_reason as reason, last_skip_class as klass,
              terminated_at is not null as terminated, external_effect_attempted as effect
         from ig_dispatch_jobs where id = $1`,
      [jobId],
    );
    const row = rows[0]!;
    expect(row.status).toBe('INELIGIBLE');
    expect(row.reason).toBe('service_scope_not_in_scope_only');
    expect(row.klass).toBe('TERMINAL');
    expect(row.terminated).toBe(true);
    // Le seul statut absorbant qui affirme que RIEN n'a été tenté.
    expect(row.effect).toBe(false);
  });

  it('le job refermé n’est plus réclamable — jamais consommable', async () => {
    const { jobId, prospectId } = await queuedCleaningProspect('atelier_demo_b');
    await sql.query(
      `insert into prospect_evidence (prospect_id, field, value_text, provider, method, source_url, confidence)
       values ($1,'services','vente de produits, lustrage','website','crawl','https://example.com',1.0)`,
      [prospectId],
    );
    await invalidateQueueUnderCurrentPolicy(sql, { operator: 'Operator Example', apply: true });

    const claimed = await claimNextInstagramJob(sql, { workerId: 'un-worker', leaseMs: 30_000, jobId });
    expect(claimed).toBeNull();
  });

  it('la ligne SURVIT : l’histoire du job reste lisible', async () => {
    const { jobId, prospectId } = await queuedCleaningProspect('atelier_demo_c');
    await sql.query(
      `insert into prospect_evidence (prospect_id, field, value_text, provider, method, source_url, confidence)
       values ($1,'services','boutique en ligne, protection boutique en ligne','website','crawl','https://example.com',1.0)`,
      [prospectId],
    );
    await invalidateQueueUnderCurrentPolicy(sql, { operator: 'Operator Example', apply: true });

    const still = await sql.query<{ n: number }>(
      `select count(*)::int as n from ig_dispatch_jobs where id = $1`,
      [jobId],
    );
    expect(still[0]!.n).toBe(1);

    // « job existed → targeting policy changed → became ineligible → exact reason »
    const events = await sql.query<{ status: string; skipReason: string | null; detail: string | null }>(
      `select status, skip_reason as "skipReason", detail from ig_job_events
        where job_id = $1 order by seq asc`,
      [jobId],
    );
    expect(events.some((event) => event.status === 'ENQUEUED')).toBe(true);
    const refusal = events.find((event) => event.skipReason === 'service_scope_not_in_scope_only');
    expect(refusal).toBeDefined();
    expect(refusal?.detail).toContain('Operator Example');
  });

  it('un refus RECONSIDÉRABLE laisse le job ouvert — on ne condamne pas sur une absence', async () => {
    const { jobId, prospectId } = await queuedCleaningProspect('atelier_demo_d');
    // L'audience disparaît : c'est un « on ne sait plus », pas un « non ».
    await sql.query(`delete from prospect_audience_observations where prospect_id = $1`, [prospectId]);

    const report = await invalidateQueueUnderCurrentPolicy(sql, { operator: 'Operator Example', apply: true });
    expect(report.closed).toBe(0);
    expect(report.leftOpen).toBe(1);
    expect(report.jobs[0]!.outcome).toBe('LEFT_OPEN_RECONSIDERABLE');

    const rows = await sql.query<{ status: string }>(`select status from ig_dispatch_jobs where id = $1`, [jobId]);
    expect(rows[0]!.status).toBe('PENDING');
  });

  it('un job encore conforme n’est pas touché', async () => {
    const { jobId } = await queuedCleaningProspect('atelier_demo_e');
    const report = await invalidateQueueUnderCurrentPolicy(sql, { operator: 'Operator Example', apply: true });
    expect(report.closed).toBe(0);
    expect(report.stillEligible).toBe(1);
    const rows = await sql.query<{ status: string }>(`select status from ig_dispatch_jobs where id = $1`, [jobId]);
    expect(rows[0]!.status).toBe('PENDING');
  });

  it('aucun effet externe n’a été tenté par cette commande, sur aucun job', async () => {
    await queuedCleaningProspect('atelier_demo_f');
    await invalidateQueueUnderCurrentPolicy(sql, { operator: 'Operator Example', apply: true });
    const effects = await sql.query<{ n: number }>(
      `select count(*)::int as n from ig_dispatch_jobs where external_effect_attempted = true`,
    );
    expect(effects[0]!.n).toBe(0);
    const events = await sql.query<{ n: number }>(
      `select count(*)::int as n from ig_job_events where external_effect_attempted = true`,
    );
    expect(events[0]!.n).toBe(0);
  });
});
