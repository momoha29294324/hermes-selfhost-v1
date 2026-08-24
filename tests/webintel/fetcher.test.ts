import { describe, expect, it } from 'vitest';
import type { LookupAddress, LookupAllOptions } from 'node:dns';
import {
  createGuardedLookup,
  nextRedirectUrl,
  readCapped,
  FetchFailure,
  type ByteStream,
} from '../../services/webintel/src/fetcher';
import { SsrfError } from '../../services/webintel/src/ssrf';

/** A byte stream that yields the given chunks, and records whether it was cancelled. */
function streamOf(chunks: Uint8Array[]): ByteStream & { cancelled: boolean; pulled: number } {
  const state = { cancelled: false, pulled: 0 };
  return {
    ...state,
    get cancelled() {
      return state.cancelled;
    },
    get pulled() {
      return state.pulled;
    },
    getReader() {
      let index = 0;
      return {
        async read() {
          if (index >= chunks.length) return { done: true };
          state.pulled += 1;
          const value = chunks[index];
          index += 1;
          return { done: false, value };
        },
        async cancel() {
          state.cancelled = true;
        },
      };
    },
  };
}

const encode = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf8'));

describe('readCapped', () => {
  it('lit tout le corps quand il tient sous le plafond', async () => {
    const result = await readCapped(streamOf([encode('<html>'), encode('bonjour</html>')]), 1_000);
    expect(result.text).toBe('<html>bonjour</html>');
    expect(result.truncated).toBe(false);
    expect(result.bytes).toBe(20);
  });

  it('tronque au plafond et cesse de tirer sur la socket', async () => {
    const stream = streamOf([encode('a'.repeat(50)), encode('b'.repeat(50)), encode('c'.repeat(50))]);
    const result = await readCapped(stream, 60);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(60);
    // Third chunk never requested: the cap is a real ceiling, not a post-filter.
    expect(stream.pulled).toBe(2);
    expect(stream.cancelled).toBe(true);
  });

  it('gère un corps absent', async () => {
    expect(await readCapped(null, 1_000)).toEqual({ text: '', bytes: 0, truncated: false });
  });

  it('gère un corps vide', async () => {
    expect(await readCapped(streamOf([]), 1_000)).toEqual({ text: '', bytes: 0, truncated: false });
  });
});

describe('nextRedirectUrl', () => {
  const current = new URL('https://exemple.fr/depart');

  it('résout une Location relative', () => {
    expect(nextRedirectUrl('/arrivee', current).toString()).toBe('https://exemple.fr/arrivee');
  });

  it('accepte une redirection vers un autre domaine public', () => {
    expect(nextRedirectUrl('https://autre.fr/x', current).toString()).toBe('https://autre.fr/x');
  });

  it('refuse une redirection vers la loopback — le cœur du contrôle', () => {
    // This is what `redirect: "follow"` would have done silently.
    expect(() => nextRedirectUrl('http://127.0.0.1:8088/', current)).toThrow(SsrfError);
    expect(() => nextRedirectUrl('http://localhost/', current)).toThrow(SsrfError);
  });

  it('refuse une redirection vers un réseau privé ou le metadata cloud', () => {
    expect(() => nextRedirectUrl('http://192.168.1.187:8095/', current)).toThrow(SsrfError);
    expect(() => nextRedirectUrl('http://169.254.169.254/', current)).toThrow(SsrfError);
    expect(() => nextRedirectUrl('http://100.122.158.89:8099/', current)).toThrow(SsrfError);
  });

  it('refuse un changement de schéma', () => {
    expect(() => nextRedirectUrl('file:///etc/passwd', current)).toThrow(SsrfError);
  });

  it('refuse une redirection sans Location', () => {
    expect(() => nextRedirectUrl(null, current)).toThrow(FetchFailure);
    expect(() => nextRedirectUrl('', current)).toThrow(/sans Location/);
  });

  it('refuse une Location illisible', () => {
    expect(() => nextRedirectUrl('http://[', current)).toThrow(FetchFailure);
  });
});

describe('createGuardedLookup', () => {
  function fakeDns(addresses: LookupAddress[] | Error) {
    return (
      _hostname: string,
      _options: LookupAllOptions,
      callback: (error: NodeJS.ErrnoException | null, result: LookupAddress[]) => void,
    ): void => {
      if (addresses instanceof Error) callback(addresses as NodeJS.ErrnoException, []);
      else callback(null, addresses);
    };
  }

  it('laisse passer une adresse publique', async () => {
    const lookup = createGuardedLookup(undefined, fakeDns([{ address: '93.184.216.34', family: 4 }]));
    const result = await new Promise<{ error: unknown; address: unknown }>((resolve) => {
      lookup('exemple.fr', {}, (error, address) => resolve({ error, address }));
    });
    expect(result.error).toBeNull();
    expect(result.address).toBe('93.184.216.34');
  });

  it('refuse une résolution vers la loopback — la défense anti-rebinding DNS', () => {
    // A public hostname whose authoritative server answers 127.0.0.1. Checking
    // up front and then handing the *name* to the socket would miss this.
    const blocked: { hostname: string; address: string; reason: string }[] = [];
    const lookup = createGuardedLookup(
      (hostname, address, reason) => blocked.push({ hostname, address, reason }),
      fakeDns([{ address: '127.0.0.1', family: 4 }]),
    );
    return new Promise<void>((resolve) => {
      lookup('localtest.me', {}, (error) => {
        expect(error).toBeInstanceOf(SsrfError);
        expect((error as SsrfError).reason).toBe('loopback');
        expect(blocked).toEqual([{ hostname: 'localtest.me', address: '127.0.0.1', reason: 'loopback' }]);
        resolve();
      });
    });
  });

  it('refuse dès qu’UNE des adresses renvoyées est privée', () => {
    // A resolver that returns a public A record and a private one must not be
    // able to smuggle the private one past us by ordering.
    const lookup = createGuardedLookup(
      undefined,
      fakeDns([
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ]),
    );
    return new Promise<void>((resolve) => {
      lookup('piege.fr', {}, (error) => {
        expect(error).toBeInstanceOf(SsrfError);
        expect((error as SsrfError).reason).toBe('private_rfc1918');
        resolve();
      });
    });
  });

  it('refuse une adresse IPv6 interne', () => {
    const lookup = createGuardedLookup(undefined, fakeDns([{ address: '::1', family: 6 }]));
    return new Promise<void>((resolve) => {
      lookup('interne.fr', {}, (error) => {
        expect(error).toBeInstanceOf(SsrfError);
        resolve();
      });
    });
  });

  it('refuse une résolution vide', () => {
    const lookup = createGuardedLookup(undefined, fakeDns([]));
    return new Promise<void>((resolve) => {
      lookup('nulle-part.fr', {}, (error) => {
        expect(error).toBeInstanceOf(SsrfError);
        expect((error as SsrfError).reason).toBe('no_address');
        resolve();
      });
    });
  });

  it('propage une erreur DNS telle quelle', () => {
    const lookup = createGuardedLookup(undefined, fakeDns(new Error('ENOTFOUND')));
    return new Promise<void>((resolve) => {
      lookup('inconnu.fr', {}, (error) => {
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(SsrfError);
        resolve();
      });
    });
  });

  it('rend la liste complète quand l’appelant demande all', () => {
    const addresses = [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700::1', family: 6 },
    ];
    const lookup = createGuardedLookup(undefined, fakeDns(addresses));
    return new Promise<void>((resolve) => {
      lookup('exemple.fr', { all: true }, (error, result) => {
        expect(error).toBeNull();
        expect(result).toEqual(addresses);
        resolve();
      });
    });
  });
});
