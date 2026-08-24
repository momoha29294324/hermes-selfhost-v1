import { describe, expect, it } from 'vitest';
import { runProcess, parseTokenUsage, parseUsage } from '@/lib/models/providers/codexCli';

/**
 * Regression tests for the failure that hung a whole campaign run: the model CLI
 * is a launcher that spawns a native binary, so killing the launcher left an
 * orphan holding the stdio pipes — and Node's `close` event never fired.
 */
describe('runProcess', () => {
  it('returns stdout for a normal command', async () => {
    const result = await runProcess('/bin/sh', ['-c', 'printf hello'], '', 10_000);
    expect(result.stdout).toBe('hello');
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
  });

  it('feeds stdin to the child', async () => {
    const result = await runProcess('/bin/cat', [], 'depuis stdin', 10_000);
    expect(result.stdout).toBe('depuis stdin');
  });

  it('honours the deadline even when a grandchild keeps the pipes open', async () => {
    const started = Date.now();
    // The parent exits after being killed, but the backgrounded grandchild would
    // hold stdout open for 60s if we waited for `close`.
    const result = await runProcess('/bin/sh', ['-c', 'sleep 60 & sleep 60'], '', 1_500);
    const elapsed = Date.now() - started;

    expect(result.timedOut).toBe(true);
    // Must not wait for the grandchild: well under the 60s it would otherwise take.
    expect(elapsed).toBeLessThan(12_000);
  }, 30_000);

  it('rejects when the binary does not exist', async () => {
    await expect(runProcess('/nonexistent/binary-xyz', [], '', 5_000)).rejects.toThrow(
      /failed to spawn/,
    );
  });
});

describe('parseTokenUsage', () => {
  it('reads the token footer when present', () => {
    expect(parseTokenUsage('codex\nok\ntokens used\n6 441\n')).toEqual({ tokensOutput: 6441 });
  });

  it('returns nothing when the footer is absent', () => {
    expect(parseTokenUsage('no footer here')).toEqual({});
  });
});

/**
 * The R5 corpus carries 221 model_runs rows and not one token count, because the
 * provider read a human footer the non-interactive mode does not always print.
 * These tests pin the structured source that replaced it.
 */
describe('parseUsage', () => {
  const turn = (usage: Record<string, number>): string =>
    JSON.stringify({ type: 'turn.completed', usage });

  it('reads the full breakdown from turn.completed', () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 'x' }),
      turn({
        input_tokens: 11681,
        cached_input_tokens: 8960,
        cache_write_input_tokens: 0,
        output_tokens: 512,
        reasoning_output_tokens: 448,
      }),
    ].join('\n');

    expect(parseUsage(stdout)).toEqual({
      tokensInput: 11681,
      tokensCachedInput: 8960,
      tokensCacheWrite: 0,
      tokensOutput: 512,
      tokensReasoning: 448,
    });
  });

  it('sums every turn, because a multi-turn call really paid for all of them', () => {
    const stdout = [
      turn({ input_tokens: 100, output_tokens: 10, reasoning_output_tokens: 5 }),
      turn({ input_tokens: 250, output_tokens: 20, reasoning_output_tokens: 15 }),
    ].join('\n');

    const usage = parseUsage(stdout);
    expect(usage.tokensInput).toBe(350);
    expect(usage.tokensOutput).toBe(30);
    expect(usage.tokensReasoning).toBe(20);
  });

  it('reports null rather than zero when nothing was published', () => {
    // "not reported" and "cost nothing" are different facts. Zeros here would
    // flatter whichever model failed to report its usage.
    expect(parseUsage('')).toEqual({
      tokensInput: null,
      tokensCachedInput: null,
      tokensCacheWrite: null,
      tokensOutput: null,
      tokensReasoning: null,
    });
  });

  it('ignores malformed lines instead of throwing', () => {
    const stdout = ['{ not json at all', 'plain text', turn({ input_tokens: 42 })].join('\n');
    expect(parseUsage(stdout).tokensInput).toBe(42);
  });

  it('falls back to the human footer when no event stream is present', () => {
    const usage = parseUsage('codex\nok\ntokens used\n6 441\n');
    expect(usage.tokensOutput).toBe(6441);
    expect(usage.tokensInput).toBeNull();
  });
});
