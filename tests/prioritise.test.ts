import { describe, expect, it } from 'vitest';
import { prioritise } from '@/lib/pipeline/runCampaign';
import { loadNiche } from '@/lib/config/load';
import type { ProspectRow } from '@/lib/repo/types';

const niche = loadNiche('example-services');

function prospect(overrides: Partial<ProspectRow>): ProspectRow {
  return {
    id: overrides.display_name ?? 'x',
    campaign_id: 'c',
    canonical_key: 'k',
    display_name: 'X',
    legal_name: null,
    brand_name: null,
    registry_id: null,
    registry_source: null,
    country: 'FR',
    address_line: null,
    postal_code: null,
    city: null,
    department: null,
    region: null,
    latitude: null,
    longitude: null,
    domain: null,
    website_url: null,
    instagram_handle: null,
    facebook_url: null,
    email: null,
    phone: null,
    google_place_id: null,
    google_rating: null,
    google_review_count: null,
    discovery_rail: null,
    discovery_provider: null,
    commercial_visibility: null,
    contactable: null,
    contact_channels: [],
    funnel_observable: null,
    funnel_signal_count: 0,
    funnel_summary: null,
    funnel_opportunity_count: 0,
    outreach_recommendation: null,
    outreach_recommendation_reason: null,
    identity_review: null,
    stage: 'discovered',
    niche_verdict: null,
    niche_confidence: null,
    score: null,
    score_band: null,
    dedupe_status: 'unique',
    merged_into_id: null,
    first_seen_at: '',
    last_enriched_at: null,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

describe('prioritise', () => {
  it('puts a prospect with a website ahead of keyword-rich registry hits', () => {
    const withSite = prospect({ display_name: 'Demo Bravo', website_url: 'https://demo-prospect-c.com' });
    const keywordRich = prospect({
      display_name: 'ATELIER DEMO SERVICES PRESTATION STANDARD SUR SITE',
    });
    const ordered = prioritise([keywordRich, withSite], niche);
    expect(ordered[0]?.display_name).toBe('Demo Bravo');
  });

  it('ranks a known Instagram above contact details alone', () => {
    const social = prospect({ display_name: 'A', instagram_handle: 'a_atelier' });
    const phoneOnly = prospect({ display_name: 'B Atelier', phone: '+33601020304' });
    expect(prioritise([phoneOnly, social], niche)[0]?.display_name).toBe('A');
  });

  it('falls back to niche keywords when nothing else is known', () => {
    const onNiche = prospect({ display_name: 'MARTIN ATELIER' });
    const offNiche = prospect({ display_name: 'MARTIN SARL' });
    expect(prioritise([offNiche, onNiche], niche)[0]?.display_name).toBe('MARTIN ATELIER');
  });

  it('does not let keyword stuffing outweigh a real digital footprint', () => {
    const stuffed = prospect({
      display_name: 'ATELIER PRESTATION STANDARD AUTO PRESTATION AUTOMOBILE VENTE DE PRODUITS LUSTRAGE CAR ATELIER',
    });
    const real = prospect({ display_name: 'Northstar Studio', website_url: 'https://example.net' });
    const ordered = prioritise([stuffed, real], niche);
    expect(ordered[0]?.display_name).toBe('Northstar Studio');
  });
});
