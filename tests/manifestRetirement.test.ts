import { mkdtempSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { runAutonomousDispatch, AUTONOMOUS_RAIL_ACTOR } from '@/lib/instagram/autonomousDispatch';
import {
  assessManifestRetirement,
  retireDispatchIntent,
  findLockedManifestsByHandle,
} from '@/lib/instagram/manifestRetirement';
import { claimNextInstagramJob, finalizeInstagramJob } from '@/lib/instagram/queue';
import { assessProspect, recordIcpAssessment } from '@/lib/pipeline/icpAssessment';
import { loadIcpProfile } from '@/lib/config/load';
import { recordAudienceObservation } from '@/lib/pipeline/audienceObservation';
import { makeProspectInstagramEligible } from './support/instagramEligibility';
import type { Sql } from '@/lib/db/sql';

/**
 * HERMES-MANIFEST-OPERATOR-RETIREMENT-R1 — « retirer une intention avant tout
 * effet, sans jamais supprimer une ligne ».
 *
 * Rien n'est fabriqué : chaque job entre par `runAutonomousDispatch`,
 * c'est-à-dire par le chemin de production — approbation machine, manifeste
 * verrouillé, dix portes d'éligibilité. Un test qui aurait inséré un job à la
 * main n'aurait prouvé que sa propre insertion.
 *
 * Base PGlite temporaire. Aucun navigateur, aucun réseau, aucun envoi.
 */

const OPERATOR = 'Operator Example';
const REASON = 'texte rédigé avant le correctif natural-first du premier message';
const TEXT =
  'Bonjour, j’ai vu votre page et vos photos de reportage en intérieur. Vous prenez encore des ' +
  'rendez-vous cette semaine ?';
const FRESH_TEXT =
  'Bonjour, vos photos de reportage en intérieur sont impressionnantes. J’ai rarement vu un ' +
  'rendu aussi net en lumière naturelle.';

let dir: string;
let sql: Sql;
let campaignId: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'manifest-retirement-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);
});

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await sql.query('delete from ig_manifest_retirements');
  await sql.query('delete from ig_job_events');
  await sql.query('delete from ig_enqueue_decisions');
  // L'autorisation canari et le job se référencent l'un l'autre : le lien doit
  // être dénoué avant que l'un des deux ne parte.
  await sql.query('update ig_live_canary_authorizations set consumed_job_id = null');
  await sql.query('delete from ig_dispatch_jobs');
  await sql.query('delete from ig_live_canary_authorizations');
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
     values ('retire-camp','Retrait','example-services','{}'::jsonb) returning id`,
  );
  campaignId = rows[0]!.id;
});

/** Un prospect en périmètre qui franchit réellement toutes les portes. */
async function eligibleProspect(handle: string): Promise<string> {
  const prospect = await sql.query<{ id: string }>(
    `insert into prospects (campaign_id, canonical_key, display_name, instagram_handle, stage)
     values ($1,$2,'ATELIER MERIDIEN',$3,'message_ready') returning id`,
    [campaignId, `retire-${handle}`, handle],
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
    assessedBy: 'suite de tests HERMES-MANIFEST-OPERATOR-RETIREMENT-R1',
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
    importedBy: 'suite de tests HERMES-MANIFEST-OPERATOR-RETIREMENT-R1',
  });
  return prospectId;
}

interface Queued {
  readonly jobId: string;
  readonly manifestId: string;
  readonly itemId: string;
}

/** Un batch neuf pour ce prospect, puis le chemin de production complet. */
async function queueIntent(
  prospectId: string,
  text: string,
  slug: string,
  generationRevision: string | null = null,
): Promise<Queued> {
  const batch = await sql.query<{ id: string }>(
    `insert into r6b_batches (slug, campaign_id) values ($1,$2) returning id`,
    [slug, campaignId],
  );
  const item = await sql.query<{ id: string }>(
    `insert into r6b_batch_items
       (batch_id, prospect_id, item_index, original_draft, contact_channels, hook_evidence_ids,
        generation_code_revision)
     values ($1,$2,1,$3,$4,$5,$6) returning id`,
    [
      batch[0]!.id,
      prospectId,
      text,
      JSON.stringify(['instagram']),
      JSON.stringify(['evidence-hook']),
      generationRevision,
    ],
  );

  const report = await runAutonomousDispatch(sql, {
    batchSlug: slug,
    apply: true,
    enqueuedBy: AUTONOMOUS_RAIL_ACTOR,
  });
  const outcome = report.outcomes[0];
  expect(outcome?.status, outcome?.reason ?? 'aucun résultat').toBe('QUEUED');
  return { jobId: outcome!.jobId!, manifestId: outcome!.manifestId!, itemId: item[0]!.id };
}

async function jobRow(jobId: string): Promise<{
  status: string;
  reason: string | null;
  klass: string | null;
  terminated: boolean;
  effect: boolean;
}> {
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
  return rows[0]!;
}

/**
 * L'état exact qu'un envoi RÉEL produit, écrit par le chemin que la base
 * impose : une autorisation nominative consommée, puis l'effet inscrit AVANT
 * le clic (`markExternalEffectAttempted`), puis le statut.
 *
 * Il n'existe aucun raccourci — `ig_job_effect_requires_canary` (0031) refuse
 * un clic orphelin, et c'est très bien : un test qui aurait contourné cette
 * contrainte aurait éprouvé un état que la production ne peut pas atteindre.
 */
async function simulateExternalEffect(
  jobId: string,
  manifestId: string,
  prospectId: string,
  handle: string,
  status: 'SENT' | 'REVIEW_REQUIRED',
): Promise<void> {
  const sha = 'f'.repeat(64);
  const auth = await sql.query<{ id: string }>(
    `insert into ig_live_canary_authorizations
       (manifest_id, prospect_id, action, transport, expected_handle,
        approved_text_sha256, transport_payload_sha256, armed_by, reason, state,
        external_attempts_used, expires_at, reserved_at, reserved_by,
        consumed_at, consumed_by, consumed_job_id)
     values ($1,$2,'first_touch_dm','instagram_dm',$3,$4,$4,'suite de tests',
             'reproduire un effet extérieur réel','CONSUMED',1, now() + interval '15 minutes',
             now(),'suite de tests', now(),'suite de tests',$5)
     returning id`,
    [manifestId, prospectId, handle, sha, jobId],
  );
  await sql.query(
    `update ig_dispatch_jobs
        set external_effect_attempted = true,
            external_effect_started_at = now(),
            canary_authorization_id = $2,
            status = $3,
            terminated_at = now()
      where id = $1`,
    [jobId, auth[0]!.id, status],
  );
}

// ---------------------------------------------------------------------------
// §6 — PENDING sans effet
// ---------------------------------------------------------------------------

describe('§6 — un PENDING sans effet se retire, et cesse d’être réclamable', () => {
  it('la simulation est le DÉFAUT : elle n’écrit rien', async () => {
    const prospectId = await eligibleProspect('atelier_retire_a');
    const { jobId, manifestId } = await queueIntent(prospectId, TEXT, 'retire-a');

    const planned = await retireDispatchIntent(sql, { manifestId, operator: OPERATOR, reason: REASON });
    expect(planned.outcome).toBe('PLANNED');

    expect((await jobRow(jobId)).status).toBe('PENDING');
    const manifest = await sql.query<{ status: string }>(
      `select status from r6b_dispatch_manifests where id = $1`,
      [manifestId],
    );
    expect(manifest[0]!.status).toBe('LOCKED');
    const journal = await sql.query<{ n: number }>(`select count(*)::int as n from ig_manifest_retirements`);
    expect(journal[0]!.n).toBe(0);
  });

  it('--apply referme le job, supersède le manifeste, et rend le tout non réclamable', async () => {
    const prospectId = await eligibleProspect('atelier_retire_b');
    const { jobId, manifestId } = await queueIntent(prospectId, TEXT, 'retire-b');

    const applied = await retireDispatchIntent(sql, {
      manifestId,
      operator: OPERATOR,
      reason: REASON,
      apply: true,
    });
    expect(applied.outcome).toBe('APPLIED');

    const job = await jobRow(jobId);
    expect(job.status).toBe('INELIGIBLE');
    expect(job.reason).toBe('operator_retired');
    expect(job.klass).toBe('TERMINAL');
    expect(job.terminated).toBe(true);
    // Le seul statut absorbant qui affirme que RIEN n'a été tenté.
    expect(job.effect).toBe(false);

    const manifest = await sql.query<{ status: string; reason: string | null; by: string | null }>(
      `select status, superseded_reason as reason, superseded_by as by
         from r6b_dispatch_manifests where id = $1`,
      [manifestId],
    );
    expect(manifest[0]!.status).toBe('SUPERSEDED');
    expect(manifest[0]!.reason).toBe('operator_retired');
    // Aucun successeur : ce manifeste n'a pas été REMPLACÉ, il a été RETIRÉ.
    expect(manifest[0]!.by).toBeNull();

    // Plus rien à prendre, ni par ce job ni par la file.
    expect(await claimNextInstagramJob(sql, { workerId: 'un-worker', leaseMs: 30_000, jobId })).toBeNull();
    expect(await claimNextInstagramJob(sql, { workerId: 'un-worker', leaseMs: 30_000 })).toBeNull();
  });

  it('l’HISTOIRE survit en entier — manifeste, vote, brouillon, job, et le message', async () => {
    const prospectId = await eligibleProspect('atelier_retire_c');
    const { jobId, manifestId, itemId } = await queueIntent(prospectId, TEXT, 'retire-c');

    await retireDispatchIntent(sql, { manifestId, operator: OPERATOR, reason: REASON, apply: true });

    const survivors = await sql.query<{ manifests: number; votes: number; items: number; jobs: number }>(
      `select (select count(*)::int from r6b_dispatch_manifests where id = $1)  as manifests,
              (select count(*)::int from r6b_batch_votes where item_id = $2)    as votes,
              (select count(*)::int from r6b_batch_items where id = $2)         as items,
              (select count(*)::int from ig_dispatch_jobs where id = $3)        as jobs`,
      [manifestId, itemId, jobId],
    );
    expect(survivors[0]).toEqual({ manifests: 1, votes: 1, items: 1, jobs: 1 });

    // Le texte n'a pas bougé d'un caractère sur le manifeste, ET il est
    // reconstructible depuis le journal seul.
    const kept = await sql.query<{ text: string }>(
      `select approved_text as text from r6b_dispatch_manifests where id = $1`,
      [manifestId],
    );
    expect(kept[0]!.text).toBe(TEXT);

    const journal = await sql.query<{
      text: string;
      operator: string;
      reason: string;
      prevJob: string;
      prevManifest: string;
      effect: boolean;
      created: string | Date;
    }>(
      `select retired_text as text, operator, reason,
              previous_job_status as "prevJob", previous_manifest_status as "prevManifest",
              previous_external_effect_attempted as effect, created_at as created
         from ig_manifest_retirements where manifest_id = $1`,
      [manifestId],
    );
    expect(journal).toHaveLength(1);
    expect(journal[0]!.text).toBe(TEXT);
    expect(journal[0]!.operator).toBe(OPERATOR);
    expect(journal[0]!.reason).toBe(REASON);
    expect(journal[0]!.prevManifest).toBe('LOCKED');
    expect(journal[0]!.prevJob).toBe('PENDING');
    expect(journal[0]!.effect).toBe(false);
    expect(journal[0]!.created).toBeTruthy();
  });

  it('§10 — la révision qui a RÉDIGÉ le brouillon est reportée au journal', async () => {
    const prospectId = await eligibleProspect('atelier_retire_rev');
    const revision = 'a'.repeat(40);
    const { manifestId } = await queueIntent(prospectId, TEXT, 'retire-rev', revision);

    const result = await retireDispatchIntent(sql, {
      manifestId,
      operator: OPERATOR,
      reason: REASON,
      apply: true,
      codeRevision: 'b'.repeat(40),
    });
    expect(result.outcome).toBe('APPLIED');
    if (result.outcome !== 'APPLIED') return;
    expect(result.intent.generationCodeRevision).toBe(revision);

    const journal = await sql.query<{ gen: string | null; at: string | null }>(
      `select generation_code_revision as gen, retirement_code_revision as at
         from ig_manifest_retirements where manifest_id = $1`,
      [manifestId],
    );
    expect(journal[0]!.gen).toBe(revision);
    expect(journal[0]!.at).toBe('b'.repeat(40));
  });
});

// ---------------------------------------------------------------------------
// §6 — BLOCKED sans effet
// ---------------------------------------------------------------------------

describe('§6 — un BLOCKED sans effet se retire exactement pareil', () => {
  it('un job BLOCKED, réclamable et sans effet, devient INELIGIBLE', async () => {
    const prospectId = await eligibleProspect('atelier_retire_d');
    const { jobId, manifestId } = await queueIntent(prospectId, TEXT, 'retire-d');

    // Le job passe par le chemin normal d'un refus de garde : bail pris, issue
    // écrite. Il reste réclamable, et aucun effet n'a eu lieu.
    const claimed = await claimNextInstagramJob(sql, { workerId: 'worker-test', leaseMs: 30_000, jobId });
    await finalizeInstagramJob(sql, {
      jobId,
      claimToken: claimed!.claimToken!,
      status: 'BLOCKED',
      reasonCode: 'IG_KILL_SWITCH_ENGAGED',
      detail: 'arrêt global armé',
    });
    expect((await jobRow(jobId)).status).toBe('BLOCKED');

    const applied = await retireDispatchIntent(sql, {
      manifestId,
      operator: OPERATOR,
      reason: REASON,
      apply: true,
    });
    expect(applied.outcome).toBe('APPLIED');

    const job = await jobRow(jobId);
    expect(job.status).toBe('INELIGIBLE');
    expect(job.reason).toBe('operator_retired');
    expect(job.effect).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §6 — SENT et AMBIGUOUS : refus HARD
// ---------------------------------------------------------------------------

describe('§6 — ce qui a pu toucher le monde ne se retire jamais', () => {
  it('un job SENT (effet inscrit) est REFUSÉ, et rien n’est écrit', async () => {
    const prospectId = await eligibleProspect('atelier_retire_e');
    const { jobId, manifestId } = await queueIntent(prospectId, TEXT, 'retire-e');

    await simulateExternalEffect(jobId, manifestId, prospectId, 'atelier_retire_e', 'SENT');

    const result = await retireDispatchIntent(sql, {
      manifestId,
      operator: OPERATOR,
      reason: REASON,
      apply: true,
    });
    expect(result.outcome).toBe('REFUSED');
    if (result.outcome !== 'REFUSED') return;
    expect(result.refusal).toBe('EXTERNAL_EFFECT_ATTEMPTED');

    const manifest = await sql.query<{ status: string }>(
      `select status from r6b_dispatch_manifests where id = $1`,
      [manifestId],
    );
    expect(manifest[0]!.status).toBe('LOCKED');
    expect((await jobRow(jobId)).status).toBe('SENT');
    const journal = await sql.query<{ n: number }>(`select count(*)::int as n from ig_manifest_retirements`);
    expect(journal[0]!.n).toBe(0);
  });

  it('un job AMBIGUOUS (REVIEW_REQUIRED, effet inscrit) est REFUSÉ à l’identique', async () => {
    const prospectId = await eligibleProspect('atelier_retire_f');
    const { jobId, manifestId } = await queueIntent(prospectId, TEXT, 'retire-f');

    await simulateExternalEffect(jobId, manifestId, prospectId, 'atelier_retire_f', 'REVIEW_REQUIRED');

    const result = await retireDispatchIntent(sql, {
      manifestId,
      operator: OPERATOR,
      reason: REASON,
      apply: true,
    });
    expect(result.outcome).toBe('REFUSED');
    if (result.outcome !== 'REFUSED') return;
    expect(result.refusal).toBe('EXTERNAL_EFFECT_ATTEMPTED');
    const journal = await sql.query<{ n: number }>(`select count(*)::int as n from ig_manifest_retirements`);
    expect(journal[0]!.n).toBe(0);
  });

  it('le STATUT seul suffit à refuser, même si le drapeau d’effet ment', () => {
    // La base ne peut pas produire cet état — mais un refus qui dépendrait
    // d'une seule colonne serait un refus qu'une écriture fautive désarme.
    const verdict = assessManifestRetirement({
      manifestStatus: 'LOCKED',
      alreadyRetired: false,
      job: {
        jobId: 'job-1',
        status: 'SENT',
        externalEffectAttempted: false,
        leaseExpiresAt: null,
      },
      now: new Date('2026-08-25T18:00:00.000Z'),
    });
    expect(verdict.verdict).toBe('REFUSED');
    if (verdict.verdict !== 'REFUSED') return;
    expect(verdict.refusal).toBe('JOB_BORE_EXTERNAL_EFFECT');
  });

  it('l’effet est lu AVANT le statut — un PENDING qui a touché le monde refuse', () => {
    const verdict = assessManifestRetirement({
      manifestStatus: 'LOCKED',
      alreadyRetired: false,
      job: {
        jobId: 'job-2',
        status: 'PENDING',
        externalEffectAttempted: true,
        leaseExpiresAt: null,
      },
      now: new Date('2026-08-25T18:00:00.000Z'),
    });
    expect(verdict.verdict).toBe('REFUSED');
    if (verdict.verdict !== 'REFUSED') return;
    expect(verdict.refusal).toBe('EXTERNAL_EFFECT_ATTEMPTED');
  });

  it('un bail vivant n’est jamais écrasé', () => {
    const verdict = assessManifestRetirement({
      manifestStatus: 'LOCKED',
      alreadyRetired: false,
      job: {
        jobId: 'job-3',
        status: 'CLAIMED',
        externalEffectAttempted: false,
        leaseExpiresAt: '2026-08-25T18:05:00.000Z',
      },
      now: new Date('2026-08-25T18:00:00.000Z'),
    });
    expect(verdict.verdict).toBe('REFUSED');
    if (verdict.verdict !== 'REFUSED') return;
    expect(verdict.refusal).toBe('JOB_LEASE_HELD');
  });
});

// ---------------------------------------------------------------------------
// §6 — rejeu opérateur
// ---------------------------------------------------------------------------

describe('§6 — rejouer le retrait ne mute rien une seconde fois', () => {
  it('deux --apply successifs : le second dit ALREADY_RETIRED', async () => {
    const prospectId = await eligibleProspect('atelier_retire_g');
    const { jobId, manifestId } = await queueIntent(prospectId, TEXT, 'retire-g');

    const first = await retireDispatchIntent(sql, {
      manifestId, operator: OPERATOR, reason: REASON, apply: true,
    });
    expect(first.outcome).toBe('APPLIED');
    const afterFirst = await sql.query<{ updated: string | Date; skips: number }>(
      `select updated_at as updated, skip_count as skips from ig_dispatch_jobs where id = $1`,
      [jobId],
    );

    const second = await retireDispatchIntent(sql, {
      manifestId, operator: OPERATOR, reason: REASON, apply: true,
    });
    expect(second.outcome).toBe('ALREADY_RETIRED');

    // Aucune seconde écriture : ni journal, ni compteur, ni horodatage.
    const journal = await sql.query<{ n: number }>(
      `select count(*)::int as n from ig_manifest_retirements where manifest_id = $1`,
      [manifestId],
    );
    expect(journal[0]!.n).toBe(1);
    const afterSecond = await sql.query<{ updated: string | Date; skips: number }>(
      `select updated_at as updated, skip_count as skips from ig_dispatch_jobs where id = $1`,
      [jobId],
    );
    expect(String(afterSecond[0]!.updated)).toBe(String(afterFirst[0]!.updated));
    expect(afterSecond[0]!.skips).toBe(afterFirst[0]!.skips);
  });

  it('la base elle-même refuse un second journal pour le même manifeste', async () => {
    const prospectId = await eligibleProspect('atelier_retire_h');
    const { manifestId } = await queueIntent(prospectId, TEXT, 'retire-h');
    await retireDispatchIntent(sql, { manifestId, operator: OPERATOR, reason: REASON, apply: true });

    const rows = await sql.query<{ prospect: string; item: string; vote: string; text: string; sha: string; rcpt: string }>(
      `select prospect_id as prospect, batch_item_id as item, approval_vote_id as vote,
              retired_text as text, retired_text_sha256 as sha, recipient as rcpt
         from ig_manifest_retirements where manifest_id = $1`,
      [manifestId],
    );
    const r = rows[0]!;
    await expect(
      sql.query(
        `insert into ig_manifest_retirements
           (manifest_id, prospect_id, batch_item_id, approval_vote_id, previous_manifest_status,
            retired_text, retired_text_sha256, recipient, operator, reason)
         values ($1,$2,$3,$4,'LOCKED',$5,$6,$7,'quelqu’un','un second retrait du même')`,
        [manifestId, r.prospect, r.item, r.vote, r.text, r.sha, r.rcpt],
      ),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// §5 / §6 — une intention NEUVE après le retrait
// ---------------------------------------------------------------------------

describe('§5 — après retrait, une intention fraîche devient le représentant actif', () => {
  it('sans retrait, la file REFUSE la seconde intention — une à la fois', async () => {
    const prospectId = await eligibleProspect('atelier_retire_i');
    await queueIntent(prospectId, TEXT, 'retire-i');

    const batch = await sql.query<{ id: string }>(
      `insert into r6b_batches (slug, campaign_id) values ('retire-i-2',$1) returning id`,
      [campaignId],
    );
    await sql.query(
      `insert into r6b_batch_items
         (batch_id, prospect_id, item_index, original_draft, contact_channels, hook_evidence_ids)
       values ($1,$2,1,$3,$4,$5)`,
      [batch[0]!.id, prospectId, FRESH_TEXT, JSON.stringify(['instagram']), JSON.stringify(['evidence-hook'])],
    );

    const report = await runAutonomousDispatch(sql, {
      batchSlug: 'retire-i-2',
      apply: true,
      enqueuedBy: AUTONOMOUS_RAIL_ACTOR,
    });
    // Et c'est la politique elle-même qui refuse, pas seulement la file :
    // one-intent-per-business est en amont, et ce round n'y touche pas.
    expect(report.outcomes[0]!.status).toBe('SKIPPED');
    expect(report.outcomes[0]!.reason).toContain('une autre intention est déjà active pour ce commerce');
  });

  it('après retrait : nouveau manifeste, nouveau job, ancien conservé, seul le neuf réclamable', async () => {
    const prospectId = await eligibleProspect('atelier_retire_j');
    const old = await queueIntent(prospectId, TEXT, 'retire-j');
    await retireDispatchIntent(sql, {
      manifestId: old.manifestId, operator: OPERATOR, reason: REASON, apply: true,
    });

    const fresh = await queueIntent(prospectId, FRESH_TEXT, 'retire-j-2', 'c'.repeat(40));

    expect(fresh.manifestId).not.toBe(old.manifestId);
    expect(fresh.jobId).not.toBe(old.jobId);

    const manifests = await sql.query<{ id: string; status: string; text: string }>(
      `select id, status, approved_text as text from r6b_dispatch_manifests
        where prospect_id = $1 order by locked_at asc`,
      [prospectId],
    );
    expect(manifests).toHaveLength(2);
    expect(manifests[0]!.status).toBe('SUPERSEDED');
    expect(manifests[0]!.text).toBe(TEXT);
    expect(manifests[1]!.status).toBe('LOCKED');
    expect(manifests[1]!.text).toBe(FRESH_TEXT);

    // Un seul manifeste LOCKED répond désormais pour ce compte.
    expect(await findLockedManifestsByHandle(sql, 'atelier_retire_j')).toEqual([fresh.manifestId]);

    // Et un seul job est réclamable : le neuf.
    const claimed = await claimNextInstagramJob(sql, { workerId: 'un-worker', leaseMs: 30_000 });
    expect(claimed?.id).toBe(fresh.jobId);
  });
});

// ---------------------------------------------------------------------------
// Les refus d'entrée, et l'absence d'exception
// ---------------------------------------------------------------------------

describe('les gardes d’entrée', () => {
  it('un geste sans opérateur ni motif est refusé avant toute lecture', async () => {
    const anonymous = await retireDispatchIntent(sql, {
      manifestId: '00000000-0000-0000-0000-000000000000',
      operator: ' ',
      reason: REASON,
      apply: true,
    });
    expect(anonymous.outcome).toBe('REFUSED');
    if (anonymous.outcome === 'REFUSED') expect(anonymous.refusal).toBe('OPERATOR_MISSING');

    const mute = await retireDispatchIntent(sql, {
      manifestId: '00000000-0000-0000-0000-000000000000',
      operator: OPERATOR,
      reason: 'court',
      apply: true,
    });
    expect(mute.outcome).toBe('REFUSED');
    if (mute.outcome === 'REFUSED') expect(mute.refusal).toBe('REASON_MISSING');
  });

  it('un manifeste inconnu est refusé, pas inventé', async () => {
    const result = await retireDispatchIntent(sql, {
      manifestId: '00000000-0000-0000-0000-000000000000',
      operator: OPERATOR,
      reason: REASON,
      apply: true,
    });
    expect(result.outcome).toBe('REFUSED');
    if (result.outcome === 'REFUSED') expect(result.refusal).toBe('MANIFEST_NOT_FOUND');
  });

  /**
   * HERMES-MANIFEST-OPERATOR-RETIREMENT-R1.1 — le défaut vécu le 25 août 2026.
   *
   * Les trois manifestes à retirer portaient des jobs `SKIPPED` reportés à
   * l'ouverture de la fenêtre suivante. `claimNextInstagramJob` porte
   * `not_before <= now()` — une borne d'ORDONNANCEMENT, juste pour un worker —
   * si bien que la prise ne rendait aucune ligne et que le retrait était
   * IMPOSSIBLE. Exactement dans l'état où il est le plus utile, puisque rien
   * n'est encore parti.
   *
   * Pire, le refus s'affichait « un autre worker l'a repris entre-temps »
   * alors que `claimed_by`, `claim_token` et `lease_expires_at` étaient tous
   * nuls : un diagnostic qui envoyait chercher un processus inexistant.
   */
  it('un job REPORTÉ à la fenêtre suivante reste retirable', async () => {
    const prospectId = await eligibleProspect('atelier_reporte');
    const { jobId, manifestId } = await queueIntent(prospectId, TEXT, 'retire-reporte');

    // L'état réel des trois du 25 août : reporté à demain, aucun bail, aucun
    // effet.
    await sql.query(
      `update ig_dispatch_jobs
          set status = 'SKIPPED', last_skip_reason = 'outside_window',
              not_before = now() + interval '12 hours',
              claimed_by = null, claim_token = null, claimed_at = null, lease_expires_at = null
        where id = $1`,
      [jobId],
    );

    const result = await retireDispatchIntent(sql, {
      manifestId,
      operator: OPERATOR,
      reason: REASON,
      apply: true,
    });
    expect(result.outcome).toBe('APPLIED');

    const job = await sql.query<{ status: string; reason: string | null; effect: boolean }>(
      `select status, last_skip_reason as reason, external_effect_attempted as effect
         from ig_dispatch_jobs where id = $1`,
      [jobId],
    );
    expect(job[0]!.status).toBe('INELIGIBLE');
    expect(job[0]!.reason).toBe('operator_retired');
    expect(job[0]!.effect).toBe(false);
  });

  /**
   * L'autre moitié, et c'est elle qui rend le correctif sûr : le chemin
   * d'ENVOI n'a pas bougé d'un caractère. Un job non dû reste INVISIBLE à un
   * worker, qui n'appelle jamais avec `ignoreSchedule`.
   */
  it('le chemin d’ENVOI respecte toujours not_before', async () => {
    const prospectId = await eligibleProspect('atelier_pas_du');
    const { jobId } = await queueIntent(prospectId, TEXT, 'retire-pas-du');
    await sql.query(`update ig_dispatch_jobs set not_before = now() + interval '12 hours' where id = $1`, [jobId]);

    // Ce qu'un worker fait : aucune option, donc la borne s'applique.
    expect(await claimNextInstagramJob(sql, { workerId: 'w', leaseMs: 30_000, jobId })).toBeNull();
    expect(await claimNextInstagramJob(sql, { workerId: 'w', leaseMs: 30_000 })).toBeNull();

    // Et le retrait, lui, passe — sur le MÊME job, au même instant.
    const claimed = await claimNextInstagramJob(sql, {
      workerId: 'retrait',
      leaseMs: 30_000,
      jobId,
      ignoreSchedule: true,
    });
    expect(claimed).not.toBeNull();
  });

  /**
   * Un bail RÉELLEMENT tenu est refusé avant la prise, et le refus le dit.
   * `ignoreSchedule` ne desserre pas cette garde-là.
   */
  it('un bail vivant refuse toujours, et ce n’est pas CLAIM_LOST', async () => {
    const prospectId = await eligibleProspect('atelier_bail_vivant');
    const { jobId, manifestId } = await queueIntent(prospectId, TEXT, 'retire-bail');
    const claimed = await claimNextInstagramJob(sql, { workerId: 'worker-vivant', leaseMs: 300_000, jobId });
    expect(claimed).not.toBeNull();

    const result = await retireDispatchIntent(sql, {
      manifestId,
      operator: OPERATOR,
      reason: REASON,
      apply: true,
    });
    expect(result.outcome).toBe('REFUSED');
    if (result.outcome === 'REFUSED') expect(result.refusal).toBe('JOB_LEASE_HELD');
  });

  it('le refus de prise n’accuse plus un worker qui n’existe pas', () => {
    const source = readFileSync('src/lib/instagram/manifestRetirement.ts', 'utf8');
    expect(source).not.toContain('un autre worker l’a repris');
  });

  it('AUCUNE exception nominative, et aucun pouvoir d’envoi dans la source', () => {
    const source = readFileSync('src/lib/instagram/manifestRetirement.ts', 'utf8');
    for (const forbidden of ['setKillSwitch', 'sendFirstTouchDm', 'playwright']) {
      expect(source).not.toContain(forbidden);
    }
    const cli = readFileSync('src/cli/ig-manifest-retire.ts', 'utf8');
    for (const forbidden of ['setKillSwitch', 'OUTBOUND_ALLOW_SENDING']) {
      expect(cli).not.toContain(forbidden);
    }
  });
});
