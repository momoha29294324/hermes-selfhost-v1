import { mkdtemp, rm, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiskCache } from '../../services/webintel/src/cache';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'webintel-cache-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function cacheWithClock(start = 1_000_000) {
  let now = start;
  const cache = new DiskCache({ dir, maxEntryBytes: 1_000_000, now: () => now });
  return { cache, advance: (ms: number) => (now += ms) };
}

describe('DiskCache', () => {
  it('rend ce qui a été écrit', async () => {
    const { cache } = cacheWithClock();
    const key = DiskCache.key('search', 'northstar studio', 'fr', 10);
    await cache.set(key, 'search', { results: ['a', 'b'] }, 60_000);
    expect(await cache.get<{ results: string[] }>(key)).toEqual({ results: ['a', 'b'] });
    expect(cache.getStats().hits).toBe(1);
    expect(cache.getStats().writes).toBe(1);
  });

  it('rate proprement une clé absente', async () => {
    const { cache } = cacheWithClock();
    expect(await cache.get('search:inconnue')).toBeNull();
    expect(cache.getStats().misses).toBe(1);
    expect(cache.getStats().errors).toBe(0);
  });

  it('expire une entrée passé son TTL', async () => {
    const { cache, advance } = cacheWithClock();
    const key = DiskCache.key('page', 'https://example.com');
    await cache.set(key, 'page', { html: '<html>' }, 10_000);

    advance(9_999);
    expect(await cache.get(key)).not.toBeNull();

    advance(2);
    expect(await cache.get(key)).toBeNull();
  });

  it('applique des TTL distincts par usage', async () => {
    const { cache, advance } = cacheWithClock();
    const search = DiskCache.key('search', 'q');
    const resolve = DiskCache.key('resolve', 'q');
    await cache.set(search, 'search', { a: 1 }, 12 * 60 * 60 * 1000);
    await cache.set(resolve, 'resolve', { a: 2 }, 14 * 24 * 60 * 60 * 1000);

    advance(24 * 60 * 60 * 1000);
    expect(await cache.get(search)).toBeNull();
    expect(await cache.get(resolve)).toEqual({ a: 2 });
  });

  it('distingue deux clés qui ne diffèrent que par un paramètre', async () => {
    const { cache } = cacheWithClock();
    const a = DiskCache.key('search', 'example-services', 'fr', 10);
    const b = DiskCache.key('search', 'example-services', 'fr', 20);
    expect(a).not.toBe(b);
    await cache.set(a, 'search', { limit: 10 }, 60_000);
    expect(await cache.get(b)).toBeNull();
  });

  it('permet une invalidation ciblée', async () => {
    const { cache } = cacheWithClock();
    const key = DiskCache.key('resolve', 'Kapital');
    await cache.set(key, 'resolve', { status: 'confirmed' }, 60_000);
    await cache.delete(key);
    expect(await cache.get(key)).toBeNull();
  });

  it('purge les entrées expirées et les compte', async () => {
    const { cache, advance } = cacheWithClock();
    await cache.set(DiskCache.key('page', 'a'), 'page', { a: 1 }, 1_000);
    await cache.set(DiskCache.key('page', 'b'), 'page', { b: 2 }, 1_000);
    await cache.set(DiskCache.key('page', 'c'), 'page', { c: 3 }, 3_600_000);

    advance(2_000);
    expect(await cache.purgeExpired()).toBe(2);
    expect((await cache.usage()).entries).toBe(1);
  });

  it('traite une entrée corrompue comme un raté, pas comme une erreur fatale', async () => {
    const { cache } = cacheWithClock();
    const key = DiskCache.key('page', 'corrompue');
    await cache.set(key, 'page', { ok: true }, 60_000);

    // Overwrite the stored file with garbage.
    const shards = await readdir(dir);
    const shard = shards[0] as string;
    const files = await readdir(join(dir, shard));
    await writeFile(join(dir, shard, files[0] as string), '{ ceci n est pas du json', 'utf8');

    expect(await cache.get(key)).toBeNull();
    expect(await cache.purgeExpired()).toBe(1);
  });

  it('refuse silencieusement une entrée trop grosse plutôt que de remplir le disque', async () => {
    const cache = new DiskCache({ dir, maxEntryBytes: 200 });
    const key = DiskCache.key('page', 'énorme');
    await cache.set(key, 'page', { html: 'x'.repeat(5_000) }, 60_000);
    expect(await cache.get(key)).toBeNull();
    expect(cache.getStats().writes).toBe(0);
  });

  it('ignore un TTL nul ou négatif', async () => {
    const { cache } = cacheWithClock();
    const key = DiskCache.key('page', 'sans-ttl');
    await cache.set(key, 'page', { a: 1 }, 0);
    expect(await cache.get(key)).toBeNull();
  });

  it('rapporte son occupation disque', async () => {
    const { cache } = cacheWithClock();
    await cache.set(DiskCache.key('page', '1'), 'page', { html: 'abc' }, 60_000);
    await cache.set(DiskCache.key('page', '2'), 'page', { html: 'def' }, 60_000);
    const usage = await cache.usage();
    expect(usage.entries).toBe(2);
    expect(usage.bytes).toBeGreaterThan(0);
  });

  it('survit à un répertoire absent au démarrage', async () => {
    const nested = join(dir, 'niveau1', 'niveau2');
    const cache = new DiskCache({ dir: nested, maxEntryBytes: 1_000_000 });
    const key = DiskCache.key('robots', 'https://example.com');
    await cache.set(key, 'robots', { body: 'User-agent: *' }, 60_000);
    expect(await cache.get(key)).toEqual({ body: 'User-agent: *' });
    await mkdir(nested, { recursive: true });
  });
});
