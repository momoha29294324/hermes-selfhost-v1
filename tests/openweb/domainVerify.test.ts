import { describe, expect, it } from 'vitest';
import { HttpClient } from '@/lib/http/client';
import { createLogger } from '@/lib/logging/logger';
import {
  isPrivateAddress,
  probeDomain,
  resolveDomainAddresses,
  servedReadablePage,
  type DnsResolver,
} from '@/lib/discovery/openweb/domainVerify';

/**
 * La chaîne DNS → HTTP → HTML.
 *
 * Ce que ces tests protègent surtout, c'est l'ordre : le DNS ne coûte rien à
 * personne et élimine les domaines inventés, donc aucun candidat ne doit
 * pouvoir déclencher une requête chez un tiers avant d'avoir résolu.
 */

const logger = createLogger({ test: 'domain-verify' });

function resolver(map: Record<string, { v4?: string[]; v6?: string[] }>): DnsResolver {
  return {
    resolve4: async (hostname: string) => {
      const entry = map[hostname];
      if (!entry?.v4) throw new Error('ENOTFOUND');
      return entry.v4;
    },
    resolve6: async (hostname: string) => {
      const entry = map[hostname];
      if (!entry?.v6) throw new Error('ENOTFOUND');
      return entry.v6;
    },
  };
}

interface Stub {
  status?: number;
  body?: string;
  contentType?: string;
  finalUrl?: string;
  throws?: boolean;
}

function harness(routes: Record<string, Stub>): { urls: string[]; http: HttpClient } {
  const urls: string[] = [];
  const fetchImpl = async (input: unknown): Promise<Response> => {
    const url = String(input);
    urls.push(url);
    const stub = routes[url];
    if (!stub) {
      // Par défaut : pas de robots.txt (donc autorisé), 404 ailleurs.
      const is404 = { status: 404, body: 'not found' };
      return {
        ok: false,
        status: is404.status,
        url,
        headers: new Headers({ 'content-type': 'text/plain' }),
        body: null,
        text: async () => is404.body,
      } as unknown as Response;
    }
    if (stub.throws) throw new Error('ECONNREFUSED');
    const status = stub.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      url: stub.finalUrl ?? url,
      headers: new Headers({ 'content-type': stub.contentType ?? 'text/html; charset=utf-8' }),
      body: null,
      text: async () => stub.body ?? '',
    } as unknown as Response;
  };
  return { urls, http: new HttpClient({ sql: null, minHostIntervalMs: 0, fetchImpl }) };
}

describe('isPrivateAddress', () => {
  it('reconnaît les plages non routables', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '169.254.1.1', '100.64.0.1', '0.0.0.0']) {
      expect(isPrivateAddress(address)).toBe(true);
    }
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('fe80::1')).toBe(true);
    expect(isPrivateAddress('::ffff:10.0.0.1')).toBe(true);
  });

  it('laisse passer une adresse publique', () => {
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
    expect(isPrivateAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);
  });

  it('refuse par défaut ce qu’il ne sait pas lire', () => {
    expect(isPrivateAddress('')).toBe(true);
    expect(isPrivateAddress('pas-une-adresse')).toBe(true);
  });
});

describe('resolveDomainAddresses', () => {
  it('résout en IPv4 et IPv6', async () => {
    const dns = await resolveDomainAddresses('example.net', resolver({ 'example.net': { v4: ['93.184.216.34'] } }));
    expect(dns.resolved).toBe(true);
    expect(dns.privateAddress).toBe(false);
  });

  it('ne lève pas quand rien ne résout', async () => {
    const dns = await resolveDomainAddresses('inexistant.fr', resolver({}));
    expect(dns.resolved).toBe(false);
    expect(dns.error).toBeTruthy();
  });

  it('signale une adresse privée', async () => {
    const dns = await resolveDomainAddresses('interne.fr', resolver({ 'interne.fr': { v4: ['192.168.1.10'] } }));
    expect(dns.privateAddress).toBe(true);
  });

  it('ne laisse aucun rejet sans gestionnaire quand IPv6 échoue plus tard qu’IPv4', async () => {
    /**
     * Régression du premier run complet du benchmark, arrêté au 21ᵉ prospect
     * sur 60. Les deux résolutions partent ensemble ; si la seconde rejette
     * pendant que la première est encore en vol, Node voit un rejet non géré
     * et tue le processus. Ici IPv4 met du temps et réussit, IPv6 rejette
     * immédiatement — l'ordre exact qui plantait.
     */
    const rejections: unknown[] = [];
    const capture = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', capture);

    const slowThenFast: DnsResolver = {
      resolve4: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return ['93.184.216.34'];
      },
      resolve6: async () => {
        throw new Error('queryAaaa ENOTFOUND');
      },
    };

    const dns = await resolveDomainAddresses('example.net', slowThenFast);
    await new Promise((resolve) => setImmediate(resolve));
    process.off('unhandledRejection', capture);

    expect(dns.resolved).toBe(true);
    expect(dns.addresses).toEqual(['93.184.216.34']);
    expect(rejections).toEqual([]);
  });

  it('ne lève pas quand les deux familles échouent', async () => {
    const bothFail: DnsResolver = {
      resolve4: async () => {
        throw new Error('ENOTFOUND');
      },
      resolve6: async () => {
        throw new Error('queryAaaa ENOTFOUND');
      },
    };
    const dns = await resolveDomainAddresses('inexistant.fr', bothFail);
    expect(dns.resolved).toBe(false);
    expect(dns.error).toContain('ENOTFOUND');
  });
});

describe('probeDomain', () => {
  const dns = resolver({ 'example.net': { v4: ['93.184.216.34'] } });

  it('s’arrête au DNS pour un domaine inventé, sans aucune requête HTTP', async () => {
    const { urls, http } = harness({});
    const probe = await probeDomain({ http, logger, resolver: resolver({}) }, 'demo-04-exemple.fr');

    expect(probe.dnsResolved).toBe(false);
    expect(probe.httpStatus).toBeNull();
    // Le point du test : personne n'a été dérangé.
    expect(urls).toEqual([]);
    expect(servedReadablePage(probe)).toBe(false);
  });

  it('refuse un domaine qui résout vers une adresse privée', async () => {
    const { urls, http } = harness({});
    const probe = await probeDomain(
      { http, logger, resolver: resolver({ 'interne.fr': { v4: ['10.0.0.5'] } }) },
      'interne.fr',
    );
    expect(probe.privateAddress).toBe(true);
    expect(urls).toEqual([]);
  });

  it('lit la page d’accueil et retient l’URL finale', async () => {
    const { http } = harness({
      'https://example.net/': {
        body: '<html><head><title>Northstar Studio</title></head><body>Atelier</body></html>',
        finalUrl: 'https://www.example.net/',
      },
    });
    const probe = await probeDomain({ http, logger, resolver: dns }, 'example.net', {
      readLegalPage: false,
    });

    expect(probe.httpStatus).toBe(200);
    expect(probe.finalUrl).toBe('https://www.example.net/');
    expect(probe.finalDomain).toBe('example.net');
    expect(probe.html).toContain('Northstar Studio');
    expect(servedReadablePage(probe)).toBe(true);
  });

  it('retient le domaine d’arrivée quand le site redirige ailleurs', async () => {
    const { http } = harness({
      'https://demo-39-exemple.fr/': { body: '<html></html>', finalUrl: 'https://example.net/' },
    });
    const probe = await probeDomain(
      { http, logger, resolver: resolver({ 'demo-39-exemple.fr': { v4: ['93.184.216.34'] } }) },
      'demo-39-exemple.fr',
      { readLegalPage: false },
    );
    expect(probe.finalDomain).toBe('example.net');
  });

  it('bascule en HTTP clair quand HTTPS échoue', async () => {
    const { urls, http } = harness({
      'https://example.net/': { throws: true },
      'http://example.net/': { body: '<html><title>Northstar Studio</title></html>' },
    });
    const probe = await probeDomain({ http, logger, resolver: dns }, 'example.net', { readLegalPage: false });

    expect(probe.html).toContain('Northstar Studio');
    expect(urls).toContain('http://example.net/');
  });

  it('respecte un robots.txt qui interdit la racine', async () => {
    const { http } = harness({
      'https://example.net/robots.txt': { body: 'User-agent: *\nDisallow: /', contentType: 'text/plain' },
    });
    const probe = await probeDomain({ http, logger, resolver: dns }, 'example.net');

    expect(probe.robotsDisallowed).toBe(true);
    expect(probe.html).toBeNull();
  });

  it('suit un lien de mentions légales et en garde le HTML', async () => {
    const { http } = harness({
      'https://example.net/': {
        body: '<html><title>Northstar Studio</title><a href="/mentions-legales">Mentions légales</a></html>',
      },
      'https://example.net/mentions-legales': { body: '<html><p>SIREN : 552 100 554</p></html>' },
    });
    const probe = await probeDomain({ http, logger, resolver: dns }, 'example.net');

    expect(probe.legalPageUrl).toBe('https://example.net/mentions-legales');
    expect(probe.legalHtml).toContain('552 100 554');
    expect(probe.pagesRead).toHaveLength(2);
  });

  it('tente un chemin conventionnel quand aucun lien n’existe', async () => {
    const { urls, http } = harness({
      'https://example.net/': { body: '<html><title>Northstar Studio</title></html>' },
      'https://example.net/mentions-legales': { body: '<html><p>SIREN : 552 100 554</p></html>' },
    });
    await probeDomain({ http, logger, resolver: dns }, 'example.net', { guessLegalPaths: true });
    expect(urls).toContain('https://example.net/mentions-legales');
  });

  it('ne garde pas une réponse non HTML', async () => {
    const { http } = harness({
      'https://example.net/': { body: '{"ok":true}', contentType: 'application/json' },
    });
    const probe = await probeDomain({ http, logger, resolver: dns }, 'example.net', { readLegalPage: false });
    expect(probe.html).toBeNull();
    expect(probe.httpError).toContain('non HTML');
  });

  it('renvoie un résultat lisible pour un domaine illisible', async () => {
    const { http } = harness({});
    const probe = await probeDomain({ http, logger, resolver: dns }, 'pas un domaine');
    expect(probe.dnsError).toBe('domaine illisible');
  });
});
