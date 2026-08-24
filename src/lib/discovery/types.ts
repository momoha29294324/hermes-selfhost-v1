import type { CampaignConfig, DiscoverySourceConfig, NicheConfig } from '@/lib/config/schema';
import type { HttpClient } from '@/lib/http/client';
import type { Logger } from '@/lib/logging/logger';

/**
 * A candidate business as returned by one source. Nothing here is trusted yet:
 * identity resolution and classification run afterwards. Every field is optional
 * except the name and the provenance, because absence is never invented.
 */
export interface DiscoveredBusiness {
  provider: string;
  externalId: string | null;
  sourceUrl: string | null;
  observedAt: string;

  name: string;
  legalName?: string | null;
  brandName?: string | null;

  registryId?: string | null;
  registryCode?: string | null;

  country?: string | null;
  addressLine?: string | null;
  postalCode?: string | null;
  city?: string | null;
  department?: string | null;
  region?: string | null;
  latitude?: number | null;
  longitude?: number | null;

  websiteUrl?: string | null;
  phone?: string | null;
  email?: string | null;
  instagramHandle?: string | null;
  facebookUrl?: string | null;
  googlePlaceId?: string | null;
  googleRating?: number | null;
  googleReviewCount?: number | null;

  /** Provider-specific structured attributes worth keeping as evidence. */
  attributes?: Record<string, unknown>;
  /**
   * Comment ces faits ont été obtenus — R5.
   *
   * `api` par défaut, parce que c'est ce qu'ont toujours fait les sources
   * historiques : elles interrogent un registre ou une carte et recopient la
   * réponse. Le rail de découverte commerciale, lui, **ouvre le site et le
   * lit** ; écrire `api` sur ces lignes serait une provenance fausse dans le
   * seul endroit qui doit rester exact. Une evidence dont on ne sait plus si
   * elle a été déclarée ou constatée ne vaut plus rien pour arbitrer un doute.
   */
  observationMethod?: 'api' | 'crawl' | 'derived';
  /** Raw provider record, stored verbatim in prospect_sources.payload. */
  raw: unknown;
}

export interface DiscoveryContext {
  campaign: CampaignConfig;
  niche: NicheConfig;
  source: DiscoverySourceConfig;
  http: HttpClient;
  logger: Logger;
  /** Cooperative cancellation / budget guard. */
  shouldStop: () => boolean;
}

export interface SourceAvailability {
  ok: boolean;
  reason?: string;
}

/** Every discovery provider implements exactly this. No business logic inside. */
export interface DiscoverySource {
  readonly provider: string;
  availability(): SourceAvailability;
  discover(ctx: DiscoveryContext): Promise<DiscoveredBusiness[]>;
}
