import { describe, expect, it } from 'vitest';
import { ProviderScheduler, ProviderUnavailableError } from '@/lib/http/scheduler';

/**
 * La cadence est une logique déterministe, donc elle est testée comme telle :
 * horloge, sommeil et aléa sont injectés, et aucun test n'attend réellement.
 *
 * Ce qui est vérifié n'est pas « ça ralentit » mais « ça s'arrête » : le
 * benchmark R1 a échoué parce que des fournisseurs gratuits ont fermé la porte
 * sous la charge. Un ordonnanceur qui espace sans jamais renoncer aurait le
 * même résultat, plus lentement.
 */

function fakeClock(): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  advance: (ms: number) => void;
  slept: number[];
} {
  let current = 1_000_000;
  const slept: number[] = [];
  return {
    now: () => current,
    sleep: async (ms: number) => {
      slept.push(ms);
      current += ms;
    },
    advance: (ms: number) => {
      current += ms;
    },
    slept,
  };
}

function scheduler(clock: ReturnType<typeof fakeClock>, limits = {}): ProviderScheduler {
  return new ProviderScheduler({
    now: clock.now,
    sleep: clock.sleep,
    // Aléa figé : la gigue reste vérifiable.
    random: () => 0.5,
    defaults: { concurrency: 1, minIntervalMs: 1_000, jitterMs: 200, failureThreshold: 3, cooldownMs: 60_000, maxCalls: 0, ...limits },
  });
}

describe('ProviderScheduler — espacement', () => {
  it('n’attend pas pour le premier appel', async () => {
    const clock = fakeClock();
    await scheduler(clock).run('cc', async () => 'ok');
    expect(clock.slept).toEqual([]);
  });

  it('espace les appels suivants, gigue comprise', async () => {
    const clock = fakeClock();
    const s = scheduler(clock);
    await s.run('cc', async () => 'a');
    await s.run('cc', async () => 'b');
    // 1000 ms d'intervalle + 200 × 0,5 de gigue.
    expect(clock.slept).toEqual([1_100]);
  });

  it('n’attend pas si le temps a déjà passé', async () => {
    const clock = fakeClock();
    const s = scheduler(clock);
    await s.run('cc', async () => 'a');
    clock.advance(5_000);
    await s.run('cc', async () => 'b');
    expect(clock.slept).toEqual([]);
  });

  it('tient une file par fournisseur', async () => {
    const clock = fakeClock();
    const s = scheduler(clock);
    await s.run('cc', async () => 'a');
    // Un autre fournisseur ne paie pas l'attente du premier.
    await s.run('probe', async () => 'b');
    expect(clock.slept).toEqual([]);
  });
});

describe('ProviderScheduler — mise au repos', () => {
  it('met le fournisseur au repos après des échecs consécutifs', async () => {
    const clock = fakeClock();
    const s = scheduler(clock);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        s.run('cc', async () => {
          throw new Error('503 Slow Down');
        }),
      ).rejects.toThrow('503');
    }

    expect(s.available('cc').ok).toBe(false);
    await expect(s.run('cc', async () => 'ok')).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('n’appelle pas la fonction quand le fournisseur est au repos', async () => {
    const clock = fakeClock();
    const s = scheduler(clock);
    let called = 0;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await s.run('cc', async () => Promise.reject(new Error('boom'))).catch(() => undefined);
    }
    await s.run('cc', async () => {
      called += 1;
      return 'ok';
    }).catch(() => undefined);

    // Le point de l'exercice : un refus doit économiser l'appel, pas l'envoyer
    // pour voir.
    expect(called).toBe(0);
  });

  it('remet le compteur à zéro après un succès', async () => {
    const clock = fakeClock();
    const s = scheduler(clock);
    await s.run('cc', async () => Promise.reject(new Error('boom'))).catch(() => undefined);
    await s.run('cc', async () => Promise.reject(new Error('boom'))).catch(() => undefined);
    await s.run('cc', async () => 'ok');
    expect(s.state('cc').consecutiveFailures).toBe(0);
    expect(s.available('cc').ok).toBe(true);
  });

  it('rouvre une fois le repos écoulé', async () => {
    const clock = fakeClock();
    const s = scheduler(clock);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await s.run('cc', async () => Promise.reject(new Error('boom'))).catch(() => undefined);
    }
    expect(s.available('cc').ok).toBe(false);

    clock.advance(61_000);
    expect(s.available('cc').ok).toBe(true);
    await expect(s.run('cc', async () => 'ok')).resolves.toBe('ok');
  });
});

describe('ProviderScheduler — plafond d’appels', () => {
  it('refuse au-delà du plafond', async () => {
    const clock = fakeClock();
    const s = scheduler(clock, { maxCalls: 2 });
    await s.run('cc', async () => 'a');
    await s.run('cc', async () => 'b');

    const failure = await s.run('cc', async () => 'c').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderUnavailableError);
    expect((failure as ProviderUnavailableError).kind).toBe('max_calls');
  });
});

describe('ProviderScheduler — état', () => {
  it('rend compte des appels, échecs et attentes', async () => {
    const clock = fakeClock();
    const s = scheduler(clock);
    await s.run('cc', async () => 'a');
    await s.run('cc', async () => Promise.reject(new Error('boom'))).catch(() => undefined);

    const state = s.state('cc');
    expect(state.calls).toBe(2);
    expect(state.failures).toBe(1);
    expect(state.lastError).toBe('boom');
    expect(s.snapshot().map((entry) => entry.provider)).toEqual(['cc']);
  });

  it('accepte une configuration par fournisseur après coup', async () => {
    const clock = fakeClock();
    const s = scheduler(clock);
    s.configure('cc', { minIntervalMs: 5_000, jitterMs: 0 });
    await s.run('cc', async () => 'a');
    await s.run('cc', async () => 'b');
    expect(clock.slept).toEqual([5_000]);
  });
});
