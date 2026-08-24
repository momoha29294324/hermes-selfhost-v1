/**
 * SSRF guard.
 *
 * This worker fetches URLs that came out of a search engine — that is, URLs
 * chosen by a third party. It runs on le serveur, next to AdGuard, n8n, un projet isole
 * and a Tailscale interface, so "fetch this URL" must never become "reach that
 * neighbour". Everything in this file is pure so the rules can be tested
 * exhaustively without a network.
 *
 * Two layers, because either alone is insufficient:
 *   1. `assertSafeUrl` rejects the scheme/shape problems (file:, gopher:,
 *      credentials in the URL, a literal private address).
 *   2. `classifyAddress` is applied again at *connect* time, on the address the
 *      resolver actually returned (see fetcher.ts). Checking DNS up front and
 *      then handing the hostname to the socket leaves a window where a
 *      second lookup returns 127.0.0.1 — the classic DNS-rebinding SSRF.
 *
 * Note that 100.64.0.0/10 is blocked: that is CGNAT space, and it is where this
 * host's own Tailscale address lives. Blocking it is the difference between a
 * crawler and a lateral-movement tool.
 */

export class SsrfError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'SsrfError';
  }
}

export interface AddressVerdict {
  blocked: boolean;
  /** Machine-readable cause, used in logs and tests. */
  reason: string;
}

const ALLOWED = { blocked: false, reason: 'public' } as const;

// ---------------------------------------------------------------------------
// IPv4
// ---------------------------------------------------------------------------
export function parseIpv4(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number.parseInt(part, 10);
    if (n < 0 || n > 255) return null;
    octets.push(n);
  }
  return octets;
}

function classifyIpv4(octets: number[]): AddressVerdict {
  const a = octets[0] ?? 0;
  const b = octets[1] ?? 0;
  const c = octets[2] ?? 0;
  const d = octets[3] ?? 0;

  if (a === 0) return { blocked: true, reason: 'this_network' }; // 0.0.0.0/8
  if (a === 10) return { blocked: true, reason: 'private_rfc1918' };
  if (a === 127) return { blocked: true, reason: 'loopback' };
  if (a === 100 && b >= 64 && b <= 127) return { blocked: true, reason: 'cgnat_tailscale' };
  if (a === 169 && b === 254) {
    // 169.254.169.254 is the cloud metadata endpoint; the whole /16 is link-local.
    return { blocked: true, reason: b === 254 && c === 169 && d === 254 ? 'cloud_metadata' : 'link_local' };
  }
  if (a === 172 && b >= 16 && b <= 31) return { blocked: true, reason: 'private_rfc1918' };
  if (a === 192 && b === 0 && c === 0) return { blocked: true, reason: 'ietf_protocol_assignments' };
  if (a === 192 && b === 0 && c === 2) return { blocked: true, reason: 'documentation' };
  if (a === 192 && b === 88 && c === 99) return { blocked: true, reason: '6to4_relay_anycast' };
  if (a === 192 && b === 168) return { blocked: true, reason: 'private_rfc1918' };
  if (a === 198 && (b === 18 || b === 19)) return { blocked: true, reason: 'benchmarking' };
  if (a === 198 && b === 51 && c === 100) return { blocked: true, reason: 'documentation' };
  if (a === 203 && b === 0 && c === 113) return { blocked: true, reason: 'documentation' };
  if (a >= 224 && a <= 239) return { blocked: true, reason: 'multicast' };
  if (a >= 240) return { blocked: true, reason: 'reserved' }; // includes 255.255.255.255

  return ALLOWED;
}

// ---------------------------------------------------------------------------
// IPv6
// ---------------------------------------------------------------------------
/** Expands an IPv6 literal into eight 16-bit groups, or null when malformed. */
export function parseIpv6(value: string): number[] | null {
  let text = value.trim();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  // Drop a zone index (fe80::1%eth0).
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  if (!text.includes(':')) return null;

  // A trailing dotted quad (::ffff:127.0.0.1) becomes two groups.
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  const maybeV4 = text.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    const octets = parseIpv4(maybeV4);
    if (!octets) return null;
    tail = [((octets[0] ?? 0) << 8) | (octets[1] ?? 0), ((octets[2] ?? 0) << 8) | (octets[3] ?? 0)];
    text = text.slice(0, lastColon + 1) + '0:0';
  }

  const doubleColon = text.indexOf('::');
  let head: string[];
  let rest: string[];
  if (doubleColon >= 0) {
    if (text.indexOf('::', doubleColon + 1) >= 0) return null; // only one :: allowed
    head = text.slice(0, doubleColon).split(':').filter((p) => p !== '');
    rest = text.slice(doubleColon + 2).split(':').filter((p) => p !== '');
  } else {
    head = text.split(':');
    rest = [];
  }

  const parseGroup = (group: string): number | null => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    return Number.parseInt(group, 16);
  };

  const headNums: number[] = [];
  for (const group of head) {
    const n = parseGroup(group);
    if (n === null) return null;
    headNums.push(n);
  }
  const restNums: number[] = [];
  for (const group of rest) {
    const n = parseGroup(group);
    if (n === null) return null;
    restNums.push(n);
  }

  if (doubleColon >= 0) {
    const missing = 8 - (headNums.length + restNums.length);
    if (missing < 0) return null;
    const groups = [...headNums, ...new Array<number>(missing).fill(0), ...restNums];
    return applyTail(groups, tail);
  }
  if (headNums.length !== 8) return null;
  return applyTail(headNums, tail);
}

function applyTail(groups: number[], tail: number[]): number[] | null {
  if (tail.length === 0) return groups.length === 8 ? groups : null;
  if (groups.length !== 8) return null;
  const out = [...groups];
  out[6] = tail[0] ?? 0;
  out[7] = tail[1] ?? 0;
  return out;
}

function classifyIpv6(groups: number[]): AddressVerdict {
  const g0 = groups[0] ?? 0;

  const allZero = groups.every((g) => g === 0);
  if (allZero) return { blocked: true, reason: 'unspecified' };
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) {
    return { blocked: true, reason: 'loopback' };
  }

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible: judge the embedded IPv4.
  const isV4Mapped =
    groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  const isV4Compatible = groups.slice(0, 6).every((g) => g === 0);
  if (isV4Mapped || isV4Compatible) {
    return classifyIpv4(embeddedIpv4(groups));
  }
  // NAT64 well-known prefix 64:ff9b::/96 also embeds an IPv4 destination.
  if (g0 === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    return classifyIpv4(embeddedIpv4(groups));
  }
  // 6to4 (2002::/16) embeds the IPv4 address in the next two groups.
  if (g0 === 0x2002) {
    const a = ((groups[1] ?? 0) >> 8) & 0xff;
    const b = (groups[1] ?? 0) & 0xff;
    const c = ((groups[2] ?? 0) >> 8) & 0xff;
    const d = (groups[2] ?? 0) & 0xff;
    const verdict = classifyIpv4([a, b, c, d]);
    if (verdict.blocked) return { blocked: true, reason: `6to4_${verdict.reason}` };
  }

  if ((g0 & 0xfe00) === 0xfc00) return { blocked: true, reason: 'unique_local' }; // fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return { blocked: true, reason: 'link_local' }; // fe80::/10
  if ((g0 & 0xff00) === 0xff00) return { blocked: true, reason: 'multicast' }; // ff00::/8
  if (g0 === 0x2001 && ((groups[1] ?? 0) & 0xfff0) === 0x0db0) {
    return { blocked: true, reason: 'documentation' }; // 2001:db8::/32
  }

  return ALLOWED;
}

function embeddedIpv4(groups: number[]): number[] {
  const g6 = groups[6] ?? 0;
  const g7 = groups[7] ?? 0;
  return [(g6 >> 8) & 0xff, g6 & 0xff, (g7 >> 8) & 0xff, g7 & 0xff];
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------
/** Verdict for a resolved IP literal. Unparseable input is refused, not allowed. */
export function classifyAddress(address: string): AddressVerdict {
  const v4 = parseIpv4(address);
  if (v4) return classifyIpv4(v4);
  const v6 = parseIpv6(address);
  if (v6) return classifyIpv6(v6);
  return { blocked: true, reason: 'unparseable_address' };
}

/**
 * Hostnames that resolve inside an infrastructure even when DNS looks public.
 * The IP checks catch these too; naming them makes the refusal legible in logs.
 */
const BLOCKED_HOST_SUFFIXES = [
  'localhost',
  '.localhost',
  '.local',
  '.internal',
  '.intranet',
  '.lan',
  '.home.arpa',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  '.ts.net', // this host's own Tailscale funnel domain
];

export function classifyHostname(hostname: string): AddressVerdict {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host.length === 0) return { blocked: true, reason: 'empty_host' };

  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (suffix.startsWith('.') ? host.endsWith(suffix) : host === suffix || host.endsWith(`.${suffix}`)) {
      return { blocked: true, reason: 'internal_hostname' };
    }
  }
  // A literal address in the host position is judged directly.
  if (parseIpv4(host) || host.startsWith('[') || parseIpv6(host)) {
    return classifyAddress(host);
  }
  // A public name must at least look like one.
  if (!host.includes('.')) return { blocked: true, reason: 'not_a_fqdn' };
  return ALLOWED;
}

export interface UrlCheckOptions {
  /** Ports the fetcher may connect to. Empty means "any". */
  allowedPorts?: number[];
}

/**
 * Validates the static shape of a URL. Throws `SsrfError` rather than returning
 * a boolean so a missed call site fails loudly instead of fetching silently.
 */
export function assertSafeUrl(raw: string, options: UrlCheckOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError(`URL illisible: ${raw.slice(0, 120)}`, raw, 'unparseable_url');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError(`schéma refusé: ${url.protocol}`, raw, 'scheme_not_http');
  }
  if (url.username !== '' || url.password !== '') {
    throw new SsrfError('URL avec identifiants intégrés refusée', raw, 'embedded_credentials');
  }

  const verdict = classifyHostname(url.hostname);
  if (verdict.blocked) {
    throw new SsrfError(`hôte refusé (${verdict.reason})`, raw, verdict.reason);
  }

  const allowedPorts = options.allowedPorts ?? [];
  if (allowedPorts.length > 0) {
    const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number.parseInt(url.port, 10);
    if (!allowedPorts.includes(port)) {
      throw new SsrfError(`port refusé: ${port}`, raw, 'port_not_allowed');
    }
  }

  return url;
}

/** Non-throwing form, for callers that want to filter a list of candidates. */
export function isSafeUrl(raw: string, options: UrlCheckOptions = {}): boolean {
  try {
    assertSafeUrl(raw, options);
    return true;
  } catch {
    return false;
  }
}
