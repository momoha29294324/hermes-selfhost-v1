import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeInstagramHandle, normalizePhone, normalizeUrl } from '@/lib/identity/normalize';
import type { DiscoveredBusiness, DiscoveryContext, DiscoverySource } from '@/lib/discovery/types';

/**
 * Manual seed list, for businesses un opérateur already knows about. Same pipeline,
 * same provenance rules — the source is simply "a human wrote this down".
 * Options: { file: "config/seeds/<name>.json" }
 */
interface SeedEntry {
  name: string;
  city?: string;
  postalCode?: string;
  website?: string;
  instagram?: string;
  phone?: string;
  registryId?: string;
  note?: string;
}

export class SeedDiscoverySource implements DiscoverySource {
  readonly provider = 'seed';

  availability() {
    return { ok: true };
  }

  async discover(ctx: DiscoveryContext): Promise<DiscoveredBusiness[]> {
    const file = ctx.source.options['file'];
    if (typeof file !== 'string') {
      ctx.logger.warn('seed.skipped', { reason: 'options.file not configured' });
      return [];
    }
    const path = resolve(process.cwd(), file);
    if (!existsSync(path)) {
      ctx.logger.warn('seed.skipped', { reason: 'file not found', path });
      return [];
    }
    const entries = JSON.parse(readFileSync(path, 'utf8')) as SeedEntry[];
    return entries
      .filter((entry) => entry.name?.trim())
      .slice(0, ctx.source.maxResults)
      .map((entry, index) => ({
        provider: this.provider,
        externalId: entry.registryId ?? `${file}#${index}`,
        sourceUrl: null,
        observedAt: new Date().toISOString(),
        name: entry.name.trim(),
        registryId: entry.registryId ?? null,
        city: entry.city ?? null,
        postalCode: entry.postalCode ?? null,
        country: ctx.campaign.geography.country ?? 'FR',
        websiteUrl: normalizeUrl(entry.website ?? null),
        instagramHandle: normalizeInstagramHandle(entry.instagram ?? null),
        phone: normalizePhone(entry.phone ?? null),
        attributes: { note: entry.note ?? null, seedFile: file },
        raw: entry,
      }));
  }
}
