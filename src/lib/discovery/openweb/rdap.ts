import { normalizeDomain } from '@/lib/identity/normalize';
import type { HttpClient } from '@/lib/http/client';
import type { Logger } from '@/lib/logging/logger';

/**
 * RDAP — qui a déposé ce domaine.
 *
 * Successeur standardisé du WHOIS (RFC 7483). Pour les extensions gérées par
 * l'AFNIC, `rdap.nic.fr` répond en JSON, gratuitement, sans clé et sans compte.
 * Pour une **personne morale**, il publie la raison sociale du titulaire.
 *
 * C'est la seule preuve d'appartenance officielle et gratuite dont dispose R3
 * pour un domaine français. Tout le reste du rail web ouvert raisonne sur des
 * ressemblances — un nom sur une page, un téléphone qui correspond. Ici, un
 * registre dit qui a déposé le nom. « NORTHSTAR STUDIO a déposé example.net »
 * n'est pas du même ordre que « le mot “Northstar Studio” apparaît sur la page ».
 *
 * Trois limites, et elles comptent autant que la capacité :
 *
 *   1. **Aucun SIREN.** Le registre ne publie pas d'identifiant d'entreprise.
 *      Il n'existe donc aucune clé de jointure avec le registre français : le
 *      rapprochement reste une similarité de nom, jamais une égalité. Le
 *      signal est fort, il n'est pas décisif.
 *   2. **Les personnes physiques sont anonymisées** (« Ano Nymous »), ce qui
 *      est le cas d'environ la moitié des dépôts. Une absence de titulaire
 *      lisible ne dit donc rien — surtout pas que le domaine n'est pas le bon.
 *      C'est un `unknown`, jamais un rejet.
 *   3. **Le contact du titulaire n'est pas collecté.** La réponse contient
 *      parfois un e-mail et un téléphone ; ils sont écartés au parsing et ne
 *      ressortent d'aucune fonction de ce fichier. Les conditions du service
 *      interdisent leur collecte, et ce dépôt n'a pas à les stocker pour
 *      décider si un domaine appartient à un prospect.
 *
 * Un appel par prospect retenu, mis en cache, cadencé par `ProviderScheduler`.
 * Les limites de débit ne sont pas documentées, ce qui est une raison d'être
 * plus prudent, pas moins.
 */

/** Extensions dont l'AFNIC est le registre et pour lesquelles rdap.nic.fr répond. */
export const AFNIC_TLDS = new Set(['fr', 're', 'pm', 'tf', 'wf', 'yt']);

export const AFNIC_RDAP_BASE = 'https://rdap.nic.fr';

export interface RdapRegistrant {
  domain: string;
  /** Raison sociale du titulaire, quand c'est une personne morale. */
  organizationName: string | null;
  /** Vrai quand le titulaire est une personne physique, donc anonymisé. */
  anonymised: boolean;
  registrarName: string | null;
  /** Date d'enregistrement du domaine, telle que publiée. */
  registeredAt: string | null;
  sourceUrl: string;
  /** Renseigné quand le registre n'a pas répondu. « Pas de titulaire » n'est pas une erreur. */
  error: string | null;
}

interface RdapVcardEntry {
  0?: unknown;
  1?: unknown;
  2?: unknown;
  3?: unknown;
}

interface RdapEntity {
  roles?: string[];
  vcardArray?: unknown;
  publicIds?: { type?: string; identifier?: string }[];
  remarks?: { title?: string; description?: string[] }[];
}

interface RdapResponse {
  entities?: RdapEntity[];
  events?: { eventAction?: string; eventDate?: string }[];
  errorCode?: number;
  title?: string;
}

/**
 * Lit une valeur du vCard jCard.
 *
 * Le format est un tableau de tableaux : `["fn", {}, "text", "CARREFOUR"]`.
 * Seuls `fn` et `org` sont lus — `email` et `tel` sont délibérément ignorés,
 * voir l'en-tête du fichier.
 */
export function readVcardField(vcardArray: unknown, field: 'fn' | 'org'): string | null {
  if (!Array.isArray(vcardArray) || vcardArray.length < 2) return null;
  const entries = vcardArray[1];
  if (!Array.isArray(entries)) return null;

  for (const entry of entries as RdapVcardEntry[]) {
    if (!Array.isArray(entry)) continue;
    const [name, , , value] = entry as unknown[];
    if (name !== field) continue;
    if (typeof value === 'string' && value.trim()) return value.trim();
    // `org` peut arriver sous forme de tableau structuré (organisation, unité).
    if (Array.isArray(value)) {
      const first = value.find((item): item is string => typeof item === 'string' && item.trim().length > 0);
      if (first) return first.trim();
    }
  }
  return null;
}

/** Le nom anonymisé que l'AFNIC publie pour une personne physique. */
const ANONYMISED_MARKERS = [/^ano\s*nymous$/i, /^not\s*disclosed$/i, /redacted/i];

export function isAnonymisedHolder(name: string | null): boolean {
  if (!name) return false;
  return ANONYMISED_MARKERS.some((pattern) => pattern.test(name.trim()));
}

export function parseRdapRegistrant(payload: unknown, domain: string, sourceUrl: string): RdapRegistrant {
  const base: RdapRegistrant = {
    domain,
    organizationName: null,
    anonymised: false,
    registrarName: null,
    registeredAt: null,
    sourceUrl,
    error: null,
  };
  if (!payload || typeof payload !== 'object') return { ...base, error: 'réponse RDAP illisible' };

  const response = payload as RdapResponse;
  if (response.errorCode) {
    return { ...base, error: `RDAP ${response.errorCode}${response.title ? ` — ${response.title}` : ''}` };
  }

  for (const entity of response.entities ?? []) {
    const roles = (entity.roles ?? []).map((role) => role.toLowerCase());
    if (roles.includes('registrar')) {
      base.registrarName = readVcardField(entity.vcardArray, 'fn') ?? base.registrarName;
      continue;
    }
    if (!roles.includes('registrant')) continue;

    const fn = readVcardField(entity.vcardArray, 'fn');
    const org = readVcardField(entity.vcardArray, 'org');
    if (isAnonymisedHolder(fn) || isAnonymisedHolder(org)) {
      base.anonymised = true;
      continue;
    }
    base.organizationName = org ?? fn;
  }

  const registration = (response.events ?? []).find(
    (event) => (event.eventAction ?? '').toLowerCase() === 'registration',
  );
  base.registeredAt = registration?.eventDate ?? null;

  return base;
}

export function rdapSupports(domain: string): boolean {
  const tld = domain.split('.').pop()?.toLowerCase() ?? '';
  return AFNIC_TLDS.has(tld);
}

export interface RdapDeps {
  http: HttpClient;
  logger: Logger;
  baseUrl?: string;
}

/**
 * Interroge le registre pour un domaine.
 *
 * Renvoie `null` quand l'extension n'est pas gérée par ce registre — ne pas
 * confondre avec un titulaire absent, qui revient sous la forme d'un
 * `RdapRegistrant` dont `organizationName` est nul.
 */
export async function lookupRdapRegistrant(
  deps: RdapDeps,
  domain: string,
): Promise<RdapRegistrant | null> {
  const normalized = normalizeDomain(domain);
  if (!normalized || !rdapSupports(normalized)) return null;

  const base = (deps.baseUrl ?? AFNIC_RDAP_BASE).replace(/\/$/, '');
  const url = `${base}/domain/${normalized}`;

  try {
    const response = await deps.http.get(url, {
      timeoutMs: 15_000,
      attempts: 2,
      headers: { accept: 'application/rdap+json, application/json' },
    });
    // 404 = domaine non enregistré chez ce registre. C'est une réponse.
    if (response.status === 404) {
      return { domain: normalized, organizationName: null, anonymised: false, registrarName: null, registeredAt: null, sourceUrl: url, error: null };
    }
    if (!response.ok) {
      return { domain: normalized, organizationName: null, anonymised: false, registrarName: null, registeredAt: null, sourceUrl: url, error: `RDAP HTTP ${response.status}` };
    }
    return parseRdapRegistrant(JSON.parse(response.body), normalized, url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.logger.warn('rdap.lookup_failed', { domain: normalized, error: message });
    return { domain: normalized, organizationName: null, anonymised: false, registrarName: null, registeredAt: null, sourceUrl: url, error: message };
  }
}
