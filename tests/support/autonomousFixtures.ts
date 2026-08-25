/**
 * Le décor partagé des scénarios du rail autonome.
 *
 * Rien n'y est contourné, et c'est le point : le contenu d'entreprise est
 * écrit, l'identité confirmée, le verdict ICP rendu par l'évaluateur
 * déterministe sur CES preuves, l'audience observée et attribuée. Un test qui
 * fabriquerait un `AUTO_SEND_ELIGIBLE` à la main ne prouverait que sa propre
 * fabrication.
 */
import { expect } from 'vitest';
import type { Sql } from '@/lib/db/sql';
import { loadIcpProfile } from '@/lib/config/load';
import { assessProspect, recordIcpAssessment } from '@/lib/pipeline/icpAssessment';
import { recordAudienceObservation } from '@/lib/pipeline/audienceObservation';
import type {
  InstagramLiveRail,
  InstagramProfileObservation,
  InstagramSendInput,
  InstagramSendObservation,
  InstagramSendResult,
  InstagramSessionStatus,
} from '@/lib/instagram/rail';
import type { InstagramSessionState } from '@/lib/instagram/types';
import { UNREAD_RELATIONSHIP } from '@/lib/instagram/relationship';
import { makeProspectInstagramEligible } from './instagramEligibility';

export const FIXTURE_TEXT = 'Bonjour, une question rapide sur vos prises de rendez-vous.';

export interface SeedInput {
  readonly campaignId: string;
  readonly handle: string;
  /** Racine du dépôt, pour les chargeurs de configuration. */
  readonly root?: string;
}

/** Un prospect que la politique autonome accepte réellement, et son lot. */
export async function seedEligibleProspect(
  sql: Sql,
  input: SeedInput,
): Promise<{ prospectId: string; batchSlug: string; itemId: string }> {
  const prospect = await sql.query<{ id: string }>(
    `insert into prospects (campaign_id, canonical_key, display_name, instagram_handle, stage)
     values ($1,$2,'ATELIER DEMO',$3,'message_ready') returning id`,
    [input.campaignId, `prospect-${String(Math.random())}`, input.handle],
  );
  const prospectId = prospect[0]!.id;
  await sql.query(
    `insert into prospect_evidence (prospect_id, field, value_text, provider, method, source_url, confidence)
     values ($1,'instagram_handle',$2,'website','crawl','https://exemple-atelier.fr',1.0)`,
    [prospectId, input.handle],
  );
  await makeProspectInstagramEligible(sql, prospectId);

  const assessment = await assessProspect(sql, prospectId, loadIcpProfile('example-icp'));
  expect(assessment?.verdict).toBe('GOOD_ICP');
  await recordIcpAssessment(sql, {
    prospectId,
    assessment: assessment!,
    decidedBy: 'deterministic',
    assessedBy: 'décor partagé du rail autonome',
  });

  await recordAudienceObservation(sql, {
    prospectId,
    platform: 'instagram',
    handle: input.handle,
    followersCount: 1_240,
    attributed: true,
    observedAt: '2026-08-20T09:00:00.000Z',
    source: 'blob JSON embarqué dans le document du profil',
    observationRunId: null,
    importedBy: 'décor partagé du rail autonome',
  });

  const batchSlug = `autonomous-${String(Math.random())}`;
  const batch = await sql.query<{ id: string }>(
    `insert into r6b_batches (slug, campaign_id) values ($1,$2) returning id`,
    [batchSlug, input.campaignId],
  );
  const item = await sql.query<{ id: string }>(
    `insert into r6b_batch_items
       (batch_id, prospect_id, item_index, original_draft, contact_channels, hook_evidence_ids)
     values ($1,$2,1,$3,$4,$5) returning id`,
    [
      batch[0]!.id,
      prospectId,
      FIXTURE_TEXT,
      JSON.stringify(['instagram']),
      JSON.stringify(['evidence-hook-test']),
    ],
  );
  return { prospectId, batchSlug, itemId: item[0]!.id };
}

const GOOD_OBSERVATION: InstagramSendObservation = Object.freeze({
  threadUrl: 'https://www.instagram.com/direct/t/999/',
  threadHandle: 'placeholder',
  matchingBubblesBefore: 0,
  matchingBubblesAfter: 1,
  harvestReadableBefore: true,
  harvestReadableAfter: true,
  composerCleared: true,
  outgoingBubbleConfirmed: true,
  deliveryFailureMarkers: Object.freeze([]),
  deliveryVerdict: 'SENT',
  scopeDetail: 'niveau 3 (div[role=dialog])',
  sessionState: 'SESSION_READY',
  screenshotPath: null,
  durationMs: 10,
  detail: 'clic unique',
});

export interface FakeLiveOptions {
  readonly sessionState?: InstagramSessionState;
  readonly profileSessionState?: InstagramSessionState;
}

/** Un rail injecté. Le worker ne construit jamais son navigateur lui-même. */
export class FakeLiveRail implements InstagramLiveRail {
  readonly opened: string[] = [];
  readonly sendCalls: InstagramSendInput[] = [];
  /** Le nombre de fois où l'effet externe a réellement été autorisé à démarrer. */
  effectsStarted = 0;
  closed = false;

  constructor(private readonly options: FakeLiveOptions = {}) {}

  async ensureSession(): Promise<InstagramSessionStatus> {
    return {
      state: this.options.sessionState ?? 'SESSION_READY',
      detail: 'double de test',
      profileLabel: 'test',
      headless: true,
    };
  }

  async openProfile(handle: string): Promise<InstagramProfileObservation> {
    this.opened.push(handle);
    return {
      requestedUrl: `https://www.instagram.com/${handle}/`,
      finalUrl: `https://www.instagram.com/${handle}/`,
      redirected: false,
      profileMissing: false,
      sessionState: this.options.profileSessionState ?? 'SESSION_READY',
      relationship: UNREAD_RELATIONSHIP,
      signals: [
        { name: 'canonical_url', handle, raw: `https://www.instagram.com/${handle}/` },
        { name: 'og_url', handle, raw: null },
        { name: 'profile_header', handle, raw: null },
      ],
      screenshotPath: null,
      durationMs: 1,
    };
  }

  async sendFirstTouchDm(input: InstagramSendInput): Promise<InstagramSendResult> {
    this.sendCalls.push(input);

    // Un aperçu sort AVANT le crochet d'effet, comme le vrai rail : en mode
    // aperçu le crochet LÈVE, précisément pour qu'un double distrait ne puisse
    // pas journaliser un effet qui n'a pas eu lieu.
    if (input.stopAfter === 'thread' || input.stopAfter === 'draft') {
      return {
        kind: 'PREVIEWED',
        detail: `aperçu : fil « ${input.expectedHandle} » atteint, arrêt avant l'effet`,
        sessionState: 'SESSION_READY',
        threadUrl: `https://www.instagram.com/direct/t/999/`,
        threadHandle: input.expectedHandle,
        priorBubbles: 0,
        composerReady: true,
        screenshotPath: null,
      } as unknown as InstagramSendResult;
    }

    await input.onBeforeExternalEffect();
    this.effectsStarted += 1;
    return {
      kind: 'ATTEMPTED',
      observation: { ...GOOD_OBSERVATION, threadHandle: input.expectedHandle },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
