import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { castR6bVote } from '@/lib/pipeline/r6bBatch';
import { lockManifestForItem, type DispatchManifest, type Transport } from '@/lib/pipeline/r6bDispatch';
import {
  ChannelIdentityError,
  listChannelIdentityDecisions,
  loadEffectiveChannelIdentityDecision,
  normalizeInstagramRecipient,
  recordChannelIdentityDecision,
} from '@/lib/pipeline/channelIdentity';
import { evaluateInstagramEligibility, formatEligibility } from '@/lib/instagram/eligibility';
import { enqueueInstagramJob, InstagramEligibilityError } from '@/lib/instagram/queue';
import { recordIcpAssessment } from '@/lib/pipeline/icpAssessment';
import { evaluateIcpEligibility } from '@/lib/pipeline/icpEligibility';
import { loadIcpProfile } from '@/lib/config/load';
import type { Sql } from '@/lib/db/sql';
import type { GateRecord } from '@/lib/instagram/types';
import { giveProspectIndependentWebsiteContent, makeProspectFranchise } from './support/instagramEligibility';

/**
 * IG4.2 — la confirmation humaine d'identité de canal, sur une base réelle.
 *
 * Le prospect de tous ces tests est celui que la mission décrit : un site
 * crawlé, un ICP favorable, et `identity_review = 'manual_review'` — parce
 * qu'aucun registre légal n'a été rapproché. Avant IG4.2, il était bloqué pour
 * toujours sur la porte `identity_provenance`, et la seule façon de le
 * débloquer était de mentir sur ce que le rail automatique avait conclu.
 *
 * Ce que ce fichier vérifie tient en une phrase : la confirmation humaine
 * satisfait CETTE porte, pour CE destinataire, et rien d'autre — ni une autre
 * porte, ni un autre handle, ni un autre prospect, ni le champ automatique.
 *
 * Invariant vérifié partout : `outreach_events` ne bouge pas d'une ligne.
 */

const ROOT = resolve(__dirname, '..');
const TEXT = 'Bonjour, une question rapide sur vos prises de rendez-vous.';
const HANDLE = 'example_services_';
const OPERATOR = 'Operator Example';
const REASON =
  'Le site officiel publie lui-même un CTA vers le compte Instagram. Cette décision ne confirme ' +
  'pas une identité légale SIREN/SIRET.';

let sql: Sql;
let dir: string;
let campaignId: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-channel-identity-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);

  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
    ['example-commercial-ig4-test', 'Test', 'example-services', '{}'],
  );
  campaignId = rows[0]!.id;
});

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await sql.query('delete from ig_enqueue_decisions');
  await sql.query('delete from ig_dispatch_jobs');
  await sql.query('delete from outreach_events');
  await sql.query('delete from do_not_contact');
  await sql.query('delete from channel_identity_decisions');
  await sql.query('delete from prospect_icp_assessments');
  // `resolveDispatchTarget` journalise ses refus : la trace pointe le manifeste.
  await sql.query('delete from r6b_dispatch_attempts');
  await sql.query('delete from r6b_dispatch_manifests');
  await sql.query('delete from r6b_batch_votes');
  await sql.query('delete from r6b_batch_items');
  await sql.query('delete from r6b_batches');
  await sql.query('delete from prospect_evidence');
  await sql.query('delete from prospects');
});

/**
 * Un prospect verrouillé par le VRAI chemin humain (vote puis lock), avec du
 * contenu de site lu mais SANS identité confirmée : `identity_review` reste
 * `manual_review`, exactement comme en production.
 */
async function lockManifest(
  options: { transport?: Transport; handle?: string; confirmIdentity?: boolean } = {},
): Promise<DispatchManifest> {
  const transport = options.transport ?? 'instagram_dm';
  const handle = options.handle ?? HANDLE;
  const isInstagram = transport === 'instagram_dm';

  const prospect = await sql.query<{ id: string }>(
    `insert into prospects (campaign_id, canonical_key, display_name, email, instagram_handle)
     values ($1,$2,'EXAMPLE SERVICES',$3,$4) returning id`,
    [
      campaignId,
      `prospect-${Math.random()}`,
      isInstagram ? null : 'contact@example.com',
      isInstagram ? handle : null,
    ],
  );
  const prospectId = prospect[0]!.id;

  await sql.query(
    `insert into prospect_evidence (prospect_id, field, value_text, provider, method, source_url, confidence)
     values ($1,$2,$3,'website','crawl','https://www.example.com',1.0)`,
    [
      prospectId,
      isInstagram ? 'instagram_handle' : 'email',
      isInstagram ? handle : 'contact@example.com',
    ],
  );

  const batch = await sql.query<{ id: string }>(
    `insert into r6b_batches (slug, campaign_id) values ($1,$2) returning id`,
    [`batch-${Math.random()}`, campaignId],
  );
  const item = await sql.query<{ id: string }>(
    `insert into r6b_batch_items (batch_id, prospect_id, item_index, original_draft, contact_channels)
     values ($1,$2,1,'brouillon',$3) returning id`,
    [batch[0]!.id, prospectId, JSON.stringify([isInstagram ? 'instagram' : 'email'])],
  );
  await castR6bVote(sql, { itemId: item[0]!.id, verdict: 'SEND', approvedText: TEXT, note: null });
  await giveProspectIndependentWebsiteContent(sql, prospectId);
  // L'état réel du prospect de la mission : le rail de découverte a conclu
  // « à relire par un humain », faute de rapprochement légal.
  await sql.query(`update prospects set identity_review = $2 where id = $1`, [
    prospectId,
    options.confirmIdentity === true ? 'confirmed' : 'manual_review',
  ]);
  return lockManifestForItem(sql, { itemId: item[0]!.id, transport });
}

/** Un second prospect, sans manifeste : il n'existe que pour porter une décision qui ne vaut pas ici. */
async function otherProspect(): Promise<string> {
  const rows = await sql.query<{ id: string }>(
    `insert into prospects (campaign_id, canonical_key, display_name, instagram_handle, identity_review)
     values ($1,$2,'PRESTATION VOISIN',$3,'manual_review') returning id`,
    [campaignId, `prospect-${Math.random()}`, 'prestationvoisin'],
  );
  return rows[0]!.id;
}

async function confirm(
  prospectId: string,
  recipient: string,
  overrides: { reason?: string; decidedBy?: string } = {},
): Promise<void> {
  await recordChannelIdentityDecision(sql, {
    prospectId,
    transport: 'instagram_dm',
    recipient,
    decision: 'CONFIRMED',
    reason: overrides.reason ?? REASON,
    evidenceUrl: 'https://www.instagram.com/example_services_/',
    decidedBy: overrides.decidedBy ?? OPERATOR,
  });
}

async function evaluate(manifestId: string) {
  return evaluateInstagramEligibility(sql, { manifestId, action: 'first_touch_dm' });
}

function gateOf(gates: readonly GateRecord[], name: string): GateRecord | null {
  return gates.find((gate) => gate.gate === name) ?? null;
}

async function countOutreachEvents(): Promise<number> {
  const rows = await sql.query<{ n: string }>('select count(*) as n from outreach_events');
  return Number(rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// 1. La porte, avant et après
// ---------------------------------------------------------------------------

describe('IG4.2 — la porte identity_provenance', () => {
  it('sans confirmation humaine, refuse exactement comme avant', async () => {
    const manifest = await lockManifest();

    const decision = await evaluate(manifest.id);

    expect(decision.verdict).toBe('REVIEW_REQUIRED');
    expect(decision.reason).toBe('identity_provenance_missing');
    expect(decision.reasonCode).toBe('IG_IDENTITY_REVIEW_PENDING');
    expect(formatEligibility(decision)).toBe('REVIEW_REQUIRED:identity_provenance_missing');
    expect(gateOf(decision.gates, 'identity_provenance')?.verdict).toBe('BLOCK');
    expect(await countOutreachEvents()).toBe(0);
  });

  it('avec la confirmation humaine du MÊME prospect, du MÊME transport et du MÊME destinataire, passe', async () => {
    const manifest = await lockManifest();
    await confirm(manifest.prospectId, HANDLE);

    const decision = await evaluate(manifest.id);

    expect(gateOf(decision.gates, 'identity_provenance')?.verdict).toBe('PASS');
    expect(gateOf(decision.gates, 'identity_provenance')?.detail).toContain(OPERATOR);
    // La porte passe, et le verdict global va jusqu'au bout : ce prospect n'a
    // rien d'autre qui s'y oppose.
    expect(decision.verdict).toBe('ELIGIBLE');
    expect(await countOutreachEvents()).toBe(0);
  });

  it('accepte une graphie de casse différente du même compte, jamais un autre compte', async () => {
    const manifest = await lockManifest();
    // Instagram ne distingue pas la casse : @Example_Services_ EST le compte
    // confirmé. C'est déjà la comparaison que fait la porte opt_out.
    await confirm(manifest.prospectId, 'Example_Services_');

    const decision = await evaluate(manifest.id);
    expect(gateOf(decision.gates, 'identity_provenance')?.verdict).toBe('PASS');
  });
});

// ---------------------------------------------------------------------------
// 2. Ce que la confirmation ne couvre PAS
// ---------------------------------------------------------------------------

describe('IG4.2 — la portée exacte d’une confirmation', () => {
  it('la confirmation d’un AUTRE handle ne débloque pas celui du manifeste', async () => {
    const manifest = await lockManifest();
    await confirm(manifest.prospectId, 'example_services_officiel');

    const decision = await evaluate(manifest.id);

    expect(decision.verdict).toBe('REVIEW_REQUIRED');
    expect(decision.reasonCode).toBe('IG_IDENTITY_REVIEW_PENDING');
    expect(gateOf(decision.gates, 'identity_provenance')?.verdict).toBe('BLOCK');
  });

  it('la confirmation d’un AUTRE prospect, sur le même handle, ne débloque rien', async () => {
    const manifest = await lockManifest();
    // Le même handle, confirmé pour quelqu'un d'autre.
    await confirm(await otherProspect(), HANDLE);

    const decision = await evaluate(manifest.id);

    expect(decision.verdict).toBe('REVIEW_REQUIRED');
    expect(gateOf(decision.gates, 'identity_provenance')?.verdict).toBe('BLOCK');
  });

  it('une confirmation sur un AUTRE transport ne vaut pas pour Instagram', async () => {
    const manifest = await lockManifest();
    await recordChannelIdentityDecision(sql, {
      prospectId: manifest.prospectId,
      transport: 'facebook_dm',
      recipient: HANDLE,
      decision: 'CONFIRMED',
      reason: 'confirmation sur un autre canal',
      decidedBy: OPERATOR,
    });

    const decision = await evaluate(manifest.id);
    expect(decision.verdict).toBe('REVIEW_REQUIRED');
    expect(gateOf(decision.gates, 'identity_provenance')?.verdict).toBe('BLOCK');
  });

  it('si le destinataire du manifeste change, la décision existante cesse de satisfaire la porte', async () => {
    const manifest = await lockManifest();
    await confirm(manifest.prospectId, HANDLE);
    expect((await evaluate(manifest.id)).verdict).toBe('ELIGIBLE');

    // Le compte visé n'est plus celui qui a été confirmé.
    await sql.query(`update r6b_dispatch_manifests set recipient = $1 where id = $2`, [
      'example_services2',
      manifest.id,
    ]);

    const after = await evaluate(manifest.id);
    expect(after.verdict).toBe('REVIEW_REQUIRED');
    expect(gateOf(after.gates, 'identity_provenance')?.verdict).toBe('BLOCK');
  });
});

// ---------------------------------------------------------------------------
// 3. Le refus humain
// ---------------------------------------------------------------------------

describe('IG4.2 — REJECTED', () => {
  it('un refus humain ne satisfait pas la porte, et la ferme définitivement', async () => {
    const manifest = await lockManifest();
    await recordChannelIdentityDecision(sql, {
      prospectId: manifest.prospectId,
      transport: 'instagram_dm',
      recipient: HANDLE,
      decision: 'REJECTED',
      reason: 'ce compte appartient à un revendeur, pas à l’entreprise visée',
      decidedBy: OPERATOR,
    });

    const decision = await evaluate(manifest.id);

    expect(decision.verdict).toBe('INELIGIBLE');
    expect(decision.reasonCode).toBe('IG_CHANNEL_IDENTITY_REJECTED');
    expect(decision.detail).toContain(OPERATOR);
    expect(gateOf(decision.gates, 'identity_provenance')?.verdict).toBe('BLOCK');
  });

  it('un refus humain prime sur une identité automatique « confirmed »', async () => {
    // Fail-closed : un humain qui a REGARDÉ le compte en sait plus que le
    // rapprochement automatique qui avait conclu « confirmed ».
    const manifest = await lockManifest({ confirmIdentity: true });
    expect((await evaluate(manifest.id)).verdict).toBe('ELIGIBLE');

    await recordChannelIdentityDecision(sql, {
      prospectId: manifest.prospectId,
      transport: 'instagram_dm',
      recipient: HANDLE,
      decision: 'REJECTED',
      reason: 'le compte a été vérifié à la main : ce n’est pas celui de cette entreprise',
      decidedBy: OPERATOR,
    });

    const after = await evaluate(manifest.id);
    expect(after.verdict).toBe('INELIGIBLE');
    expect(after.reasonCode).toBe('IG_CHANNEL_IDENTITY_REJECTED');
  });

  it('le dernier mot revient à la décision la plus récente, dans les deux sens', async () => {
    const manifest = await lockManifest();
    await confirm(manifest.prospectId, HANDLE);
    expect((await evaluate(manifest.id)).verdict).toBe('ELIGIBLE');

    await recordChannelIdentityDecision(sql, {
      prospectId: manifest.prospectId,
      transport: 'instagram_dm',
      recipient: HANDLE,
      decision: 'REJECTED',
      reason: 'revirement : le CTA du site pointait vers un compte de franchise',
      decidedBy: OPERATOR,
    });
    expect((await evaluate(manifest.id)).verdict).toBe('INELIGIBLE');

    await confirm(manifest.prospectId, HANDLE, {
      reason: 'le site a été relu : le CTA pointe bien vers le compte de l’établissement',
    });
    expect((await evaluate(manifest.id)).verdict).toBe('ELIGIBLE');

    // Les trois décisions restent lisibles : rien n'a été écrasé.
    const history = await listChannelIdentityDecisions(sql, manifest.prospectId);
    expect(history.map((row) => row.decision)).toEqual(['CONFIRMED', 'REJECTED', 'CONFIRMED']);
  });
});

// ---------------------------------------------------------------------------
// 4. La vérité automatique reste intacte
// ---------------------------------------------------------------------------

describe('IG4.2 — les deux vérités coexistent', () => {
  it('une confirmation humaine ne touche pas prospects.identity_review', async () => {
    const manifest = await lockManifest();
    const before = await sql.query<{ identityReview: string }>(
      `select identity_review as "identityReview" from prospects where id = $1`,
      [manifest.prospectId],
    );
    expect(before[0]!.identityReview).toBe('manual_review');

    await confirm(manifest.prospectId, HANDLE);

    const after = await sql.query<{ identityReview: string }>(
      `select identity_review as "identityReview" from prospects where id = $1`,
      [manifest.prospectId],
    );
    expect(after[0]!.identityReview).toBe('manual_review');
  });

  it('ne touche pas non plus l’identité figée sur le manifeste', async () => {
    const manifest = await lockManifest();
    await confirm(manifest.prospectId, HANDLE);

    const rows = await sql.query<{ identityReview: string }>(
      `select identity_review as "identityReview" from r6b_dispatch_manifests where id = $1`,
      [manifest.id],
    );
    expect(rows[0]!.identityReview).toBe('manual_review');

    // Et le gate le dit à voix haute plutôt que de le masquer.
    const decision = await evaluate(manifest.id);
    expect(gateOf(decision.gates, 'identity_provenance')?.detail).toContain('manual_review');
  });

  it('conserve ce que le rail automatique disait au moment de la décision', async () => {
    const manifest = await lockManifest();
    await confirm(manifest.prospectId, HANDLE);

    const effective = await loadEffectiveChannelIdentityDecision(sql, {
      prospectId: manifest.prospectId,
      transport: 'instagram_dm',
      recipient: HANDLE,
    });
    expect(effective?.automaticIdentityReview).toBe('manual_review');
  });
});

// ---------------------------------------------------------------------------
// 5. Aucune autre porte n'est contournée
// ---------------------------------------------------------------------------

describe('IG4.2 — la confirmation ne dispense d’aucune autre porte', () => {
  it('l’opt-out du handle continue de refuser', async () => {
    const manifest = await lockManifest();
    await confirm(manifest.prospectId, HANDLE);
    await sql.query(`insert into do_not_contact (match_kind, value, reason) values ('instagram',$1,$2)`, [
      HANDLE,
      'demande explicite',
    ]);

    const decision = await evaluate(manifest.id);
    expect(decision.verdict).toBe('INELIGIBLE');
    expect(decision.reason).toBe('opt_out');
  });

  it('un verdict ICP défavorable continue de refuser', async () => {
    const manifest = await lockManifest();
    await confirm(manifest.prospectId, HANDLE);
    await makeProspectFranchise(sql, manifest.prospectId);
    await recordIcpAssessment(sql, {
      prospectId: manifest.prospectId,
      assessment: evaluateIcpEligibility({
        subject: { displayName: 'EXAMPLE SERVICES', instagramHandle: HANDLE },
        evidence: [
          {
            id: 'evidence-franchise-ig4',
            field: 'website_headings',
            valueText: 'Devenez franchisé et rejoignez notre réseau national',
            provider: 'website',
            sourceUrl: 'https://exemple-reseau.fr',
          },
          {
            // Une SECONDE source : le seuil `strongSourcesForNotTarget` compte
            // des sources distinctes, pas des occurrences. Une seule page qui
            // recrute ne condamne pas — c'est la garde, pas un accident.
            id: 'evidence-franchise-ig4-b',
            field: 'website_text',
            valueText: 'Rejoignez notre réseau national : franchise clés en main',
            provider: 'website',
            sourceUrl: 'https://exemple-reseau.fr/franchise',
          },
        ],
        profile: loadIcpProfile('example-icp'),
      }),
      decidedBy: 'deterministic',
      assessedBy: 'test',
    });

    const decision = await evaluate(manifest.id);
    expect(decision.verdict).toBe('INELIGIBLE');
    expect(decision.reason).toBe('icp_not_target');
  });

  it('un contact Instagram déjà établi continue de refuser', async () => {
    const manifest = await lockManifest();
    await confirm(manifest.prospectId, HANDLE);
    await sql.query(
      `insert into outreach_events (prospect_id, kind, channel, payload, manifest_id)
       values ($1,'sent','instagram_dm','{}'::jsonb,$2)`,
      [manifest.prospectId, manifest.id],
    );

    const decision = await evaluate(manifest.id);
    expect(decision.verdict).toBe('INELIGIBLE');
    expect(decision.reason).toBe('already_contacted');
  });

  it('un manifeste superseded continue de refuser, confirmation ou non', async () => {
    const manifest = await lockManifest();
    await confirm(manifest.prospectId, HANDLE);
    await sql.query(
      `update r6b_dispatch_manifests
          set status = 'SUPERSEDED', superseded_at = now(), superseded_reason = 'test'
        where id = $1`,
      [manifest.id],
    );

    const decision = await evaluate(manifest.id);
    expect(decision.verdict).toBe('REVIEW_REQUIRED');
    expect(decision.reasonCode).toBe('MANIFEST_SUPERSEDED');
  });

  it('un transport non-Instagram reste hors de cette file, confirmation ou non', async () => {
    const manifest = await lockManifest({ transport: 'email' });
    await recordChannelIdentityDecision(sql, {
      prospectId: manifest.prospectId,
      transport: 'email',
      recipient: 'contact@example.com',
      decision: 'CONFIRMED',
      reason: 'adresse publiée sur le site',
      decidedBy: OPERATOR,
    });

    const decision = await evaluate(manifest.id);
    expect(decision.verdict).toBe('INELIGIBLE');
    expect(decision.reasonCode).toBe('IG_TRANSPORT_NOT_INSTAGRAM');
  });

  it('l’enfilement passe par le même gate — un refus humain empêche tout job', async () => {
    const manifest = await lockManifest();
    await recordChannelIdentityDecision(sql, {
      prospectId: manifest.prospectId,
      transport: 'instagram_dm',
      recipient: HANDLE,
      decision: 'REJECTED',
      reason: 'ce n’est pas le compte de cette entreprise',
      decidedBy: OPERATOR,
    });

    const error = await enqueueInstagramJob(sql, {
      manifestId: manifest.id,
      action: 'first_touch_dm',
      enqueuedBy: 'Test',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InstagramEligibilityError);
    expect((error as InstagramEligibilityError).decision.reasonCode).toBe('IG_CHANNEL_IDENTITY_REJECTED');
    const jobs = await sql.query<{ n: string }>('select count(*) as n from ig_dispatch_jobs');
    expect(Number(jobs[0]!.n)).toBe(0);
    expect(await countOutreachEvents()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Enregistrement : idempotence, rejeu, audit
// ---------------------------------------------------------------------------

describe('IG4.2 — enregistrement d’une décision', () => {
  it('rejouer la même décision n’écrit pas une seconde ligne', async () => {
    const manifest = await lockManifest();

    const first = await recordChannelIdentityDecision(sql, {
      prospectId: manifest.prospectId,
      transport: 'instagram_dm',
      recipient: HANDLE,
      decision: 'CONFIRMED',
      reason: REASON,
      decidedBy: OPERATOR,
    });
    expect(first.created).toBe(true);
    expect(first.previous).toBeNull();

    const replay = await recordChannelIdentityDecision(sql, {
      prospectId: manifest.prospectId,
      transport: 'instagram_dm',
      recipient: HANDLE,
      decision: 'CONFIRMED',
      reason: 'un motif différent, mais la même décision',
      decidedBy: 'Quelqu’un d’autre',
    });
    expect(replay.created).toBe(false);
    expect(replay.decision.id).toBe(first.decision.id);

    const history = await listChannelIdentityDecisions(sql, manifest.prospectId);
    expect(history).toHaveLength(1);
  });

  it('refuse proprement de réinscrire une décision passée, mot pour mot', async () => {
    const manifest = await lockManifest();
    await confirm(manifest.prospectId, HANDLE);
    await recordChannelIdentityDecision(sql, {
      prospectId: manifest.prospectId,
      transport: 'instagram_dm',
      recipient: HANDLE,
      decision: 'REJECTED',
      reason: 'revirement',
      decidedBy: OPERATOR,
    });

    // Reconfirmer avec EXACTEMENT le motif d'origine ne dit rien de ce qui a
    // changé depuis le refus : refusé, avec un code lisible.
    const error = await confirm(manifest.prospectId, HANDLE).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChannelIdentityError);
    expect((error as ChannelIdentityError).code).toBe('DECISION_REPLAY');

    const history = await listChannelIdentityDecisions(sql, manifest.prospectId);
    expect(history).toHaveLength(2);
    // Le refus fait toujours foi : la transaction refusée n'a rien laissé.
    const effective = await loadEffectiveChannelIdentityDecision(sql, {
      prospectId: manifest.prospectId,
      transport: 'instagram_dm',
      recipient: HANDLE,
    });
    expect(effective?.decision).toBe('REJECTED');
  });

  it('exige un motif, un auteur, et un prospect qui existe', async () => {
    const manifest = await lockManifest();
    const base = {
      prospectId: manifest.prospectId,
      transport: 'instagram_dm' as const,
      recipient: HANDLE,
      decision: 'CONFIRMED' as const,
      reason: REASON,
      decidedBy: OPERATOR,
    };

    await expect(recordChannelIdentityDecision(sql, { ...base, reason: '   ' })).rejects.toMatchObject({
      code: 'REASON_REQUIRED',
    });
    await expect(recordChannelIdentityDecision(sql, { ...base, decidedBy: '' })).rejects.toMatchObject({
      code: 'AUTHOR_REQUIRED',
    });
    await expect(
      recordChannelIdentityDecision(sql, { ...base, prospectId: '00000000-0000-0000-0000-000000000000' }),
    ).rejects.toMatchObject({ code: 'PROSPECT_NOT_FOUND' });
    await expect(
      recordChannelIdentityDecision(sql, { ...base, evidenceUrl: 'pas-une-url' }),
    ).rejects.toMatchObject({ code: 'EVIDENCE_URL_INVALID' });

    expect(await listChannelIdentityDecisions(sql, manifest.prospectId)).toHaveLength(0);
  });

  it('conserve l’audit complet : décision, motif, preuve, auteur, date', async () => {
    const manifest = await lockManifest();
    await confirm(manifest.prospectId, HANDLE);

    const rows = await listChannelIdentityDecisions(sql, manifest.prospectId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.decision).toBe('CONFIRMED');
    expect(row.transport).toBe('instagram_dm');
    expect(row.recipient).toBe(HANDLE);
    expect(row.reason).toBe(REASON);
    expect(row.reasonSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.evidenceUrl).toBe('https://www.instagram.com/example_services_/');
    expect(row.decidedBy).toBe(OPERATOR);
    expect(row.automaticIdentityReview).toBe('manual_review');
    expect(row.decidedAt).toBeTruthy();
  });

  it('n’écrit rien d’autre : ni outreach_event, ni job, ni autorisation canari', async () => {
    const manifest = await lockManifest();
    await confirm(manifest.prospectId, HANDLE);

    const counts = await sql.query<Record<string, unknown>>(
      `select (select count(*) from outreach_events)                as outreach,
              (select count(*) from ig_dispatch_jobs)               as jobs,
              (select count(*) from ig_live_canary_authorizations)  as canaries,
              (select count(*) from ig_kill_switch)                 as kill`,
    );
    expect(Object.values(counts[0]!).map(Number)).toEqual([0, 0, 0, 0]);
  });

  it('le chemin opérateur ne peut structurellement produire aucun effet', () => {
    // La même garde que `tests/instagramRail.test.ts` applique au worker
    // DRY-RUN : ce que ces deux fichiers ne NOMMENT pas, ils ne peuvent pas
    // l'appeler. Une confirmation d'identité est une écriture d'audit, et
    // l'inventaire de ce qu'elle n'écrit pas fait partie de la garantie.
    for (const file of ['src/cli/ig-identity.ts', 'src/lib/pipeline/channelIdentity.ts']) {
      const source = readFileSync(resolve(ROOT, file), 'utf8');
      expect(source, `${file} écrit dans outreach_events`).not.toMatch(/insert\s+into\s+outreach_events/i);
      expect(source, `${file} touche l’arrêt global`).not.toMatch(/ig_kill_switch|setKillSwitch/);
      expect(source, `${file} touche un canari`).not.toMatch(/canary_authorizations|armCanary/i);
      expect(source, `${file} enfile un job`).not.toMatch(/ig_dispatch_jobs|enqueueInstagramJob/);
      expect(source, `${file} ouvre un rail Instagram`).not.toMatch(/playwright|instagram\.com|OUTBOUND_ALLOW_SENDING/i);
      // Et il n'écrit pas non plus la vérité automatique qu'il ne doit pas promouvoir.
      expect(source, `${file} écrit prospects.identity_review`).not.toMatch(/update\s+prospects/i);
      expect(source, `${file} écrit un manifeste`).not.toMatch(/update\s+r6b_dispatch_manifests/i);
    }
  });

  it('normalise un handle saisi avec un « @ », et refuse une URL', () => {
    expect(normalizeInstagramRecipient('@example_services_')).toBe('example_services_');
    expect(normalizeInstagramRecipient('  example_services_  ')).toBe('example_services_');
    expect(() => normalizeInstagramRecipient('https://www.instagram.com/example_services_/')).toThrow(
      ChannelIdentityError,
    );
    expect(() => normalizeInstagramRecipient('')).toThrow(ChannelIdentityError);
  });
});
