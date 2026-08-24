import { describe, expect, it } from 'vitest';
import { BreakerRegistry } from '../../services/webintel/src/breaker';

/** Clock under test control: breakers are all about elapsed time. */
function registry(options: { failureThreshold?: number; cooldownMs?: number } = {}) {
  let now = 1_000_000;
  const breakers = new BreakerRegistry({
    failureThreshold: options.failureThreshold ?? 3,
    cooldownMs: options.cooldownMs ?? 600_000,
    now: () => now,
  });
  return { breakers, advance: (ms: number) => (now += ms) };
}

describe('BreakerRegistry', () => {
  it('laisse passer tant que le seuil n’est pas atteint', () => {
    const { breakers } = registry();
    breakers.failure('engine:brave', 'too many requests');
    breakers.failure('engine:brave', 'too many requests');
    expect(breakers.state('engine:brave')).toBe('closed');
    expect(breakers.allows('engine:brave')).toBe(true);
  });

  it('ouvre après N échecs consécutifs et refuse ensuite', () => {
    const { breakers } = registry({ failureThreshold: 3 });
    for (let i = 0; i < 3; i += 1) breakers.failure('engine:qwant', 'CAPTCHA');
    expect(breakers.state('engine:qwant')).toBe('open');
    expect(breakers.allows('engine:qwant')).toBe(false);
    expect(breakers.snapshot()['engine:qwant']?.refused).toBe(1);
  });

  it('un succès remet le compteur à zéro', () => {
    const { breakers } = registry({ failureThreshold: 3 });
    breakers.failure('engine:bing', 'timeout');
    breakers.failure('engine:bing', 'timeout');
    breakers.success('engine:bing');
    breakers.failure('engine:bing', 'timeout');
    expect(breakers.state('engine:bing')).toBe('closed');
  });

  it('passe en half_open après le cooldown et laisse passer une sonde', () => {
    const { breakers, advance } = registry({ failureThreshold: 2, cooldownMs: 60_000 });
    breakers.failure('searxng', 'ECONNREFUSED');
    breakers.failure('searxng', 'ECONNREFUSED');
    expect(breakers.allows('searxng')).toBe(false);

    advance(59_999);
    expect(breakers.allows('searxng')).toBe(false);

    advance(2);
    expect(breakers.allows('searxng')).toBe(true);
    expect(breakers.state('searxng')).toBe('half_open');
  });

  it('referme sur une sonde réussie', () => {
    const { breakers, advance } = registry({ failureThreshold: 1, cooldownMs: 1_000 });
    breakers.failure('searxng', 'boom');
    advance(1_001);
    breakers.allows('searxng');
    breakers.success('searxng');
    expect(breakers.state('searxng')).toBe('closed');
    expect(breakers.snapshot()['searxng']?.failures).toBe(0);
  });

  it('rouvre immédiatement sur une sonde échouée, sans reprendre le comptage à zéro', () => {
    const { breakers, advance } = registry({ failureThreshold: 3, cooldownMs: 1_000 });
    for (let i = 0; i < 3; i += 1) breakers.failure('engine:startpage', 'CAPTCHA');
    advance(1_001);
    expect(breakers.allows('engine:startpage')).toBe(true); // half_open
    breakers.failure('engine:startpage', 'CAPTCHA');
    // Still unhealthy: a full cooldown again, not two more free attempts.
    expect(breakers.state('engine:startpage')).toBe('open');
    expect(breakers.allows('engine:startpage')).toBe(false);
  });

  it('isole les fournisseurs les uns des autres', () => {
    const { breakers } = registry({ failureThreshold: 1 });
    breakers.failure('engine:brave', 'suspended');
    expect(breakers.allows('engine:brave')).toBe(false);
    expect(breakers.allows('engine:bing')).toBe(true);
  });

  it('filterAllowed sépare ce qui reste interrogeable', () => {
    const { breakers } = registry({ failureThreshold: 1 });
    breakers.failure('engine:qwant', 'CAPTCHA');
    const result = breakers.filterAllowed(['engine:bing', 'engine:qwant', 'engine:yep']);
    expect(result.allowed).toEqual(['engine:bing', 'engine:yep']);
    expect(result.skipped).toEqual(['engine:qwant']);
  });

  it('anyOpen alimente le diagnostic /health', () => {
    const { breakers } = registry({ failureThreshold: 1 });
    expect(breakers.anyOpen()).toBe(false);
    breakers.failure('engine:mojeek', 'timeout');
    expect(breakers.anyOpen()).toBe(true);
  });

  it('reset rouvre la voie manuellement', () => {
    const { breakers } = registry({ failureThreshold: 1 });
    breakers.failure('engine:mojeek', 'timeout');
    breakers.reset('engine:mojeek');
    expect(breakers.allows('engine:mojeek')).toBe(true);
    breakers.failure('engine:yep', 'timeout');
    breakers.reset();
    expect(breakers.allows('engine:yep')).toBe(true);
  });

  it('conserve la dernière raison pour le diagnostic', () => {
    const { breakers } = registry({ failureThreshold: 1 });
    breakers.failure('engine:brave', 'Suspended: too many requests');
    expect(breakers.snapshot()['engine:brave']?.lastReason).toBe('Suspended: too many requests');
    expect(breakers.snapshot()['engine:brave']?.openedAt).not.toBeNull();
  });
});
