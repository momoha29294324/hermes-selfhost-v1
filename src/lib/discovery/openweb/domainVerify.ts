import { resolve4, resolve6 } from 'node:dns/promises';
import { normalizeDomain } from '@/lib/identity/normalize';
import { findLegalPages, LEGAL_PATH_GUESSES } from '@/lib/discovery/openweb/legalMentions';
import type { HttpClient } from '@/lib/http/client';
import type { Logger } from '@/lib/logging/logger';

/**
 * La chaîne de vérification d'un domaine candidat.
 *
 *   candidat → DNS → HTTP(S) → redirection finale → HTML → (mentions légales)
 *
 * Chaque étage a le droit d'arrêter la chaîne, et **aucun étage ne conclut à
 * l'appartenance**. C'est la règle qui compte ici : répondre en HTTP 200 ne
 * prouve rien du tout. Des millions de domaines parqués répondent 200, avec un
 * titre plausible et des liens sponsorisés. Ce fichier collecte des faits ; le
 * jugement appartient à `identityVerify.ts`, qui ne fait pas de réseau.
 *
 * L'ordre n'est pas cosmétique, il est économique et poli : le DNS ne coûte
 * rien à personne et élimine la majorité des domaines inventés, donc il passe
 * en premier. On ne dérange le serveur d'un tiers qu'après, et seulement après
 * avoir lu son `robots.txt`.
 */

export interface DomainProbe {
  domain: string;
  dnsResolved: boolean;
  dnsError: string | null;
  addresses: string[];
  /** Vrai quand le domaine pointe vers une adresse non routable publiquement. */
  privateAddress: boolean;
  httpStatus: number | null;
  httpError: string | null;
  finalUrl: string | null;
  /** Domaine réellement atteint. Diffère du candidat en cas de redirection. */
  finalDomain: string | null;
  robotsDisallowed: boolean;
  /** HTML de la page d'accueil, quand elle a été lue. */
  html: string | null;
  legalPageUrl: string | null;
  legalHtml: string | null;
  pagesRead: string[];
  durationMs: number;
}

export interface DomainProbeOptions {
  /** Lire aussi une page de mentions légales quand un lien plausible existe. */
  readLegalPage?: boolean;
  /**
   * Essayer `/mentions-legales` & co. quand la page d'accueil n'expose aucun
   * lien. Une requête de plus, mais c'est le chemin le plus court vers un SIREN.
   */
  guessLegalPaths?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
}

/** Résolveur DNS injectable : les tests ne doivent pas dépendre du réseau. */
export interface DnsResolver {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
}

export const nodeDnsResolver: DnsResolver = { resolve4, resolve6 };

/**
 * Adresses non routables publiquement.
 *
 * Un domaine candidat est une chaîne fabriquée par nous : rien n'empêche qu'il
 * résolve vers un réseau interne. Le crawler ne doit pas devenir un moyen
 * d'atteindre ce que la machine peut joindre et qu'Internet ne peut pas.
 */
export function isPrivateAddress(address: string): boolean {
  const value = address.trim().toLowerCase();
  if (!value) return true;

  if (value.includes(':')) {
    if (value === '::' || value === '::1') return true;
    if (value.startsWith('fe80') || value.startsWith('fc') || value.startsWith('fd')) return true;
    // IPv4 mappée (::ffff:10.0.0.1)
    const mapped = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return false;
  }

  const parts = value.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a = 0, b = 0] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + réservé
  return false;
}

export interface DnsOutcome {
  resolved: boolean;
  addresses: string[];
  privateAddress: boolean;
  error: string | null;
}

/**
 * Résout un domaine en A/AAAA. Ne lève jamais.
 *
 * `allSettled` n'est pas un raffinement de style : les deux résolutions
 * partent en même temps, et un domaine inventé les fait échouer toutes les
 * deux. Les attendre l'une après l'autre dans un `try` laissait la seconde
 * rejetée sans gestionnaire pendant que la première était encore en vol — un
 * *unhandled rejection*, que Node traite en tuant le processus. Le premier run
 * complet du benchmark s'est arrêté ainsi au 21ᵉ prospect sur 60.
 */
export async function resolveDomainAddresses(domain: string, resolver: DnsResolver = nodeDnsResolver): Promise<DnsOutcome> {
  const addresses: string[] = [];
  let lastError: string | null = null;

  const settled = await Promise.allSettled([resolver.resolve4(domain), resolver.resolve6(domain)]);
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      addresses.push(...result.value);
    } else {
      const reason: unknown = result.reason;
      lastError = reason instanceof Error ? reason.message : String(reason);
    }
  }

  if (addresses.length === 0) {
    return { resolved: false, addresses: [], privateAddress: false, error: lastError ?? 'aucune adresse' };
  }
  return {
    resolved: true,
    addresses,
    // Une seule adresse privée suffit à refuser : on ne va pas parier sur
    // laquelle `fetch` choisira.
    privateAddress: addresses.some((address) => isPrivateAddress(address)),
    error: null,
  };
}

function emptyProbe(domain: string, overrides: Partial<DomainProbe> = {}): DomainProbe {
  return {
    domain,
    dnsResolved: false,
    dnsError: null,
    addresses: [],
    privateAddress: false,
    httpStatus: null,
    httpError: null,
    finalUrl: null,
    finalDomain: null,
    robotsDisallowed: false,
    html: null,
    legalPageUrl: null,
    legalHtml: null,
    pagesRead: [],
    durationMs: 0,
    ...overrides,
  };
}

export interface DomainProbeDeps {
  http: HttpClient;
  logger: Logger;
  resolver?: DnsResolver;
  now?: () => number;
}

/**
 * Parcourt la chaîne pour un domaine candidat.
 *
 * Ne lève jamais : tout échec est un champ renseigné. Un rail qui interroge
 * huit candidats ne doit pas s'arrêter parce que le troisième a un certificat
 * expiré.
 */
export async function probeDomain(
  deps: DomainProbeDeps,
  candidate: string,
  options: DomainProbeOptions = {},
): Promise<DomainProbe> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const domain = normalizeDomain(candidate);
  if (!domain) return emptyProbe(candidate, { dnsError: 'domaine illisible', durationMs: now() - startedAt });

  // ------------------------------------------------------------------- DNS
  const dns = await resolveDomainAddresses(domain, deps.resolver ?? nodeDnsResolver);
  if (!dns.resolved) {
    return emptyProbe(domain, { dnsError: dns.error, durationMs: now() - startedAt });
  }
  if (dns.privateAddress) {
    deps.logger.warn('openweb.private_address', { domain });
    return emptyProbe(domain, {
      dnsResolved: true,
      addresses: dns.addresses,
      privateAddress: true,
      dnsError: 'le domaine résout vers une adresse non publique',
      durationMs: now() - startedAt,
    });
  }

  const probe = emptyProbe(domain, {
    dnsResolved: true,
    addresses: dns.addresses,
  });

  // ------------------------------------------------------------------ HTTP
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? 900_000;

  // HTTPS d'abord. Le repli HTTP existe parce qu'une part réelle des petits
  // sites français reste servie en clair ou avec un certificat mal configuré,
  // et refuser de les lire biaiserait la mesure vers les entreprises les mieux
  // équipées — exactement le contraire de ce que R3 cherche.
  for (const scheme of ['https', 'http'] as const) {
    const url = `${scheme}://${domain}/`;

    let allowed = true;
    try {
      allowed = await deps.http.isAllowedByRobots(url);
    } catch {
      allowed = true;
    }
    if (!allowed) {
      probe.robotsDisallowed = true;
      probe.httpError = 'robots.txt interdit la lecture de la page d’accueil';
      deps.logger.info('openweb.robots_disallow', { domain, url });
      break;
    }

    try {
      const response = await deps.http.get(url, { timeoutMs, attempts: 1, maxBytes });
      probe.httpStatus = response.status;
      probe.finalUrl = response.url;
      probe.finalDomain = normalizeDomain(response.url);
      probe.httpError = null;
      if (response.ok && (response.contentType ?? '').includes('html')) {
        probe.html = response.body;
        probe.pagesRead.push(response.url);
      } else if (response.ok) {
        probe.httpError = `réponse non HTML (${response.contentType ?? 'type inconnu'})`;
      }
      break;
    } catch (error) {
      probe.httpError = error instanceof Error ? error.message : String(error);
      // Un échec HTTPS mérite l'essai en clair ; un échec en clair termine.
      if (scheme === 'http') break;
    }
  }

  // -------------------------------------------------------- mentions légales
  if (probe.html && options.readLegalPage !== false) {
    const baseUrl = probe.finalUrl ?? `https://${domain}/`;
    const links = findLegalPages(probe.html, baseUrl);
    const guesses =
      links.length === 0 && options.guessLegalPaths !== false
        ? LEGAL_PATH_GUESSES.map((path) => new URL(path, baseUrl).toString()).slice(0, 1)
        : [];

    for (const url of [...links.slice(0, 1), ...guesses]) {
      try {
        if (!(await deps.http.isAllowedByRobots(url))) continue;
        const response = await deps.http.get(url, { timeoutMs, attempts: 1, maxBytes });
        if (!response.ok || !(response.contentType ?? '').includes('html')) continue;
        probe.legalPageUrl = response.url;
        probe.legalHtml = response.body;
        probe.pagesRead.push(response.url);
        break;
      } catch (error) {
        deps.logger.debug('openweb.legal_page_failed', {
          domain,
          url,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  probe.durationMs = now() - startedAt;
  return probe;
}

/**
 * Le domaine a-t-il servi une page lisible ?
 *
 * Volontairement séparé du verdict d'identité : « le domaine existe et parle »
 * et « le domaine est celui de cette entreprise » sont deux questions, et les
 * confondre est précisément l'erreur que le §11 du gate interdit.
 */
export function servedReadablePage(probe: DomainProbe): boolean {
  return probe.dnsResolved && !probe.privateAddress && probe.html !== null;
}
