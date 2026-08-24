import { describe, expect, it } from 'vitest';
import { HttpClient, isPathAllowed } from '@/lib/http/client';
import { withRetry, withTimeout, TimeoutError } from '@/lib/util/retry';

describe('isPathAllowed', () => {
  const robots = `
User-agent: *
Disallow: /private
Allow: /private/public
Disallow: /*.pdf$

User-agent: HermesOutboundBot
Disallow: /nope
`;

  it('applies the rules written for our own agent first', () => {
    expect(isPathAllowed(robots, '/nope')).toBe(false);
    // Our group has no /private rule, so the wildcard group does not apply to us.
    expect(isPathAllowed(robots, '/private')).toBe(true);
  });

  it('applies wildcard rules to other agents', () => {
    expect(isPathAllowed(robots, '/private', 'someoneelse')).toBe(false);
    expect(isPathAllowed(robots, '/private/public', 'someoneelse')).toBe(true);
    expect(isPathAllowed(robots, '/doc.pdf', 'someoneelse')).toBe(false);
  });

  it('allows everything when robots.txt has no matching group', () => {
    expect(isPathAllowed('User-agent: Googlebot\nDisallow: /', '/anything')).toBe(true);
  });

  it('treats DuckDuckGo-style rules correctly (why we ship no scraper)', () => {
    const ddg = 'User-agent: *\nDisallow: /lite\nDisallow: /html\nDisallow: /*?';
    expect(isPathAllowed(ddg, '/html/')).toBe(false);
  });
});

describe('withRetry', () => {
  it('retries transient failures with bounded attempts', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('boom');
        return 'ok';
      },
      { attempts: 3, baseDelayMs: 1, sleep: async () => undefined, random: () => 0.5 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('stops immediately when the error is not retryable', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error('fatal');
        },
        { attempts: 5, retryable: () => false, sleep: async () => undefined },
      ),
    ).rejects.toThrow('fatal');
    expect(calls).toBe(1);
  });

  it('gives up after the configured number of attempts', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error('always');
        },
        { attempts: 2, baseDelayMs: 1, sleep: async () => undefined },
      ),
    ).rejects.toThrow('always');
    expect(calls).toBe(2);
  });
});

describe('withTimeout', () => {
  it('aborts the signal past the deadline', async () => {
    await expect(
      withTimeout(
        10,
        'test',
        (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason as Error));
          }),
      ),
    ).rejects.toBeInstanceOf(TimeoutError);
  });
});

describe('la politique de redirection', () => {
  function recordingClient() {
    const seen: (string | undefined)[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      seen.push(init?.redirect);
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    return { seen, http: new HttpClient({ sql: null, minHostIntervalMs: 0, fetchImpl }) };
  }

  it('suit toujours les redirections par défaut — un site qui a déménagé reste cette entreprise', async () => {
    const { seen, http } = recordingClient();
    await http.get('https://example.com/', { noCache: true, attempts: 1 });
    expect(seen).toEqual(['follow']);
  });

  it('laisse un pair épinglé les refuser, ce dont une API interne a besoin', async () => {
    const { seen, http } = recordingClient();
    await http.get('https://example.com/', { noCache: true, attempts: 1, redirect: 'manual' });
    expect(seen).toEqual(['manual']);
  });

  it('n’altère aucun autre appelant : POST par défaut suit lui aussi', async () => {
    const { seen, http } = recordingClient();
    await http.request('https://example.com/', { method: 'POST', body: '{}', noCache: true, attempts: 1 });
    expect(seen).toEqual(['follow']);
  });
});
