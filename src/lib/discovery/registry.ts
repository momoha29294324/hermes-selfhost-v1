import { SireneDiscoverySource } from '@/lib/discovery/sources/sirene';
import { OverpassDiscoverySource } from '@/lib/discovery/sources/overpass';
import { SeedDiscoverySource } from '@/lib/discovery/sources/seed';
import type { DiscoverySource } from '@/lib/discovery/types';

/**
 * Adding a source is: implement DiscoverySource, register it here, enable it in a
 * campaign YAML. No other file changes.
 *
 * `google_places` is deliberately absent. A Places candidate has no storable
 * name, so it cannot be returned as a `DiscoveredBusiness`, and the adapter that
 * used to do so wrote six fields Google's terms do not allow us to keep. The
 * commercial rail lives in `lib/discovery/places/railA.ts` and is dispatched by
 * `runCampaign` before this registry is consulted.
 */
const SOURCES: Record<string, () => DiscoverySource> = {
  sirene: () => new SireneDiscoverySource(),
  overpass: () => new OverpassDiscoverySource(),
  seed: () => new SeedDiscoverySource(),
};

export function createDiscoverySource(provider: string): DiscoverySource {
  const factory = SOURCES[provider];
  if (!factory) {
    throw new Error(`Unknown discovery provider "${provider}". Known: ${Object.keys(SOURCES).join(', ')}`);
  }
  return factory();
}

export function knownDiscoveryProviders(): string[] {
  return Object.keys(SOURCES);
}
