import { describe, expect, it } from 'vitest';
import {
  assertSafeUrl,
  classifyAddress,
  classifyHostname,
  isSafeUrl,
  parseIpv4,
  parseIpv6,
  SsrfError,
} from '../../services/webintel/src/ssrf';

/**
 * The worker fetches URLs chosen by a search engine, on a host that also runs
 * DNS resolvers, internal dashboards and a mesh-VPN interface. These tests are the contract
 * that "fetch this URL" can never become "reach that neighbour".
 */
describe('classifyAddress — IPv4', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'loopback'],
    ['10.0.0.1', 'private_rfc1918'],
    ['172.16.5.9', 'private_rfc1918'],
    ['172.31.255.255', 'private_rfc1918'],
    ['192.168.1.187', 'private_rfc1918'],
    ['169.254.169.254', 'cloud_metadata'],
    ['169.254.1.1', 'link_local'],
    ['0.0.0.0', 'this_network'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'reserved'],
    ['198.18.0.1', 'benchmarking'],
    ['192.0.2.5', 'documentation'],
  ])('refuse %s (%s)', (address, reason) => {
    expect(classifyAddress(address)).toEqual({ blocked: true, reason });
  });

  it("refuse l'espace CGNAT, où vivent les adresses de VPN maillé", () => {
    // 100.122.158.89 is this very host. Allowing 100.64/10 would turn the
    // crawler into a way of reaching every other service on the tailnet.
    expect(classifyAddress('100.122.158.89')).toEqual({ blocked: true, reason: 'cgnat_tailscale' });
    expect(classifyAddress('100.64.0.0')).toEqual({ blocked: true, reason: 'cgnat_tailscale' });
    expect(classifyAddress('100.127.255.255')).toEqual({ blocked: true, reason: 'cgnat_tailscale' });
  });

  it('autorise les adresses publiques, y compris aux bords du CGNAT', () => {
    expect(classifyAddress('93.184.216.34').blocked).toBe(false);
    expect(classifyAddress('100.63.255.255').blocked).toBe(false);
    expect(classifyAddress('100.128.0.1').blocked).toBe(false);
    expect(classifyAddress('172.32.0.1').blocked).toBe(false);
    expect(classifyAddress('11.0.0.1').blocked).toBe(false);
  });

  it('refuse ce qui ne se lit pas comme une adresse', () => {
    expect(classifyAddress('pas-une-adresse')).toEqual({ blocked: true, reason: 'unparseable_address' });
    expect(classifyAddress('999.1.1.1')).toEqual({ blocked: true, reason: 'unparseable_address' });
    expect(classifyAddress('')).toEqual({ blocked: true, reason: 'unparseable_address' });
  });
});

describe('parseIpv4', () => {
  it('accepte la forme pointée stricte', () => {
    expect(parseIpv4('1.2.3.4')).toEqual([1, 2, 3, 4]);
  });
  it('refuse les octets hors bornes et les formes courtes', () => {
    expect(parseIpv4('1.2.3')).toBeNull();
    expect(parseIpv4('256.0.0.1')).toBeNull();
    expect(parseIpv4('01.02.03.04')).toEqual([1, 2, 3, 4]);
  });
});

describe('classifyAddress — IPv6', () => {
  it.each([
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fe80::1', 'link_local'],
    ['fc00::1', 'unique_local'],
    ['fd7a:115c:a1e0::c237:9e5b', 'unique_local'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
  ])('refuse %s (%s)', (address, reason) => {
    expect(classifyAddress(address)).toEqual({ blocked: true, reason });
  });

  it("juge l'IPv4 embarquée dans une adresse mappée", () => {
    expect(classifyAddress('::ffff:127.0.0.1')).toEqual({ blocked: true, reason: 'loopback' });
    expect(classifyAddress('::ffff:192.168.0.1')).toEqual({ blocked: true, reason: 'private_rfc1918' });
    expect(classifyAddress('::ffff:93.184.216.34').blocked).toBe(false);
  });

  it("juge l'IPv4 embarquée dans NAT64 et 6to4", () => {
    expect(classifyAddress('64:ff9b::127.0.0.1')).toEqual({ blocked: true, reason: 'loopback' });
    // 2002:c0a8:0001:: encodes 192.168.0.1
    expect(classifyAddress('2002:c0a8:1::1')).toEqual({ blocked: true, reason: '6to4_private_rfc1918' });
  });

  it('autorise une adresse IPv6 publique', () => {
    expect(classifyAddress('2606:4700:4700::1111').blocked).toBe(false);
  });

  it('ignore un index de zone', () => {
    expect(classifyAddress('fe80::1%eth0')).toEqual({ blocked: true, reason: 'link_local' });
  });
});

describe('parseIpv6', () => {
  it('développe la forme compressée', () => {
    expect(parseIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6('2001:db8::1')).toEqual([0x2001, 0x0db8, 0, 0, 0, 0, 0, 1]);
  });
  it('refuse deux compressions', () => {
    expect(parseIpv6('1::2::3')).toBeNull();
  });
  it('refuse une forme incomplète non compressée', () => {
    expect(parseIpv6('1:2:3:4:5:6:7')).toBeNull();
  });
});

describe('classifyHostname', () => {
  it('refuse les noms internes', () => {
    for (const host of [
      'localhost',
      'foo.localhost',
      'printer.local',
      'db.internal',
      'nas.lan',
      'metadata.google.internal',
      'selfhost.taila4a5c6.ts.net',
    ]) {
      expect(classifyHostname(host).blocked, host).toBe(true);
    }
  });
  it('refuse ce qui ne peut pas être un domaine public', () => {
    expect(classifyHostname('selfhost').blocked).toBe(true);
    expect(classifyHostname('').blocked).toBe(true);
  });
  it('autorise un domaine public', () => {
    expect(classifyHostname('example.net').blocked).toBe(false);
    expect(classifyHostname('www.example.com.').blocked).toBe(false);
  });
});

describe('assertSafeUrl', () => {
  it('refuse les schémas non HTTP', () => {
    for (const url of ['file:///etc/passwd', 'gopher://x.com/', 'ftp://x.com/', 'javascript:alert(1)']) {
      expect(() => assertSafeUrl(url), url).toThrow(SsrfError);
    }
    expect(() => assertSafeUrl('file:///etc/passwd')).toThrow(/schéma refusé/);
  });

  it('refuse des identifiants intégrés à l’URL', () => {
    expect(() => assertSafeUrl('https://user:pass@example.com/')).toThrow(/identifiants/);
  });

  it('refuse une adresse privée écrite littéralement, sous toutes ses formes', () => {
    expect(() => assertSafeUrl('http://127.0.0.1:8088/')).toThrow(SsrfError);
    expect(() => assertSafeUrl('http://[::1]/')).toThrow(SsrfError);
    // The WHATWG parser normalises the decimal form to 127.0.0.1.
    expect(() => assertSafeUrl('http://2130706433/')).toThrow(SsrfError);
  });

  it('expose une raison lisible', () => {
    try {
      assertSafeUrl('http://169.254.169.254/latest/meta-data/');
      expect.unreachable('aurait dû lever');
    } catch (error) {
      expect(error).toBeInstanceOf(SsrfError);
      expect((error as SsrfError).reason).toBe('cloud_metadata');
    }
  });

  it('accepte une URL publique et la normalise', () => {
    const url = assertSafeUrl('https://www.example.net/contact');
    expect(url.hostname).toBe('www.example.net');
  });

  it('applique une liste de ports quand elle est fournie', () => {
    expect(() => assertSafeUrl('https://example.com:9999/', { allowedPorts: [80, 443] })).toThrow(/port/);
    expect(assertSafeUrl('https://example.com/', { allowedPorts: [80, 443] }).hostname).toBe('example.com');
  });
});

describe('isSafeUrl', () => {
  it('ne lève pas et filtre', () => {
    const candidates = ['https://example.com/', 'http://127.0.0.1/', 'file:///etc/passwd'];
    expect(candidates.filter((url) => isSafeUrl(url))).toEqual(['https://example.com/']);
  });
});
