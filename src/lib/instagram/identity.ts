import type { InstagramIdentitySignal, InstagramIdentityVerdict } from '@/lib/instagram/types';

/**
 * IG-R1 §2 — « profil ressemblant » ne devient jamais « profil confirmé ».
 *
 * Ce module est pur : il ne connaît ni navigateur, ni base. Il reçoit des
 * indices déjà observés et rend un verdict. C'est ce qui permet de tester
 * l'exactitude du rapprochement — correspondance, divergence, absence,
 * ambiguïté — sans ouvrir Instagram une seule fois.
 *
 * La règle centrale : un `MATCH` exige au moins un indice lu ET l'accord de
 * TOUS les indices lisibles. Un seul indice divergent suffit à faire tomber le
 * verdict, même si les autres concordent — deux sources qui ne disent pas la
 * même chose sur une identité, c'est précisément la définition d'un doute.
 */

/**
 * Un handle Instagram : lettres, chiffres, point, tiret bas, 30 au plus.
 * Identique au motif que `r6bTransportAdapters` impose au destinataire figé —
 * la même définition partout, pas deux variantes qui divergeraient.
 */
const HANDLE = /^[A-Za-z0-9._]{1,30}$/;

/**
 * Instagram traite les handles sans distinction de casse : `DetailCarFrance`
 * et `demo_prospect_a` désignent le même compte, et l'URL canonique peut
 * renvoyer l'une ou l'autre forme. La comparaison est donc insensible à la
 * casse — mais rien d'autre n'est normalisé : ni accents, ni points retirés
 * (un point EST significatif chez Instagram), ni espaces avalés.
 */
export function normalizeHandle(raw: string): string | null {
  const trimmed = raw.trim().replace(/^@/, '');
  if (!HANDLE.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

/** L'URL canonique d'un profil. Le rail ne navigue nulle part ailleurs. */
export function profileUrl(handle: string): string {
  const normalized = normalizeHandle(handle);
  if (normalized === null) throw new Error(`handle Instagram invalide : « ${handle} »`);
  return `https://www.instagram.com/${normalized}/`;
}

/**
 * Extrait un handle d'une URL de profil Instagram.
 *
 * Rend `null` — jamais une supposition — dès que le chemin n'est pas
 * exactement `/<handle>/` : `/accounts/login/`, `/explore/`, `/p/<id>/`,
 * `/direct/inbox/` ne sont pas des profils, et une URL dont on ne sait pas
 * lire le handle ne doit pas produire un handle vraisemblable.
 */
export function handleFromProfileUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!/(^|\.)instagram\.com$/i.test(url.hostname)) return null;
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  if (segments.length !== 1) return null;
  const first = segments[0];
  if (first === undefined) return null;
  // Chemins réservés qui ont la FORME d'un handle mais n'en sont pas.
  if (RESERVED_PATHS.has(first.toLowerCase())) return null;
  return normalizeHandle(first);
}

const RESERVED_PATHS = new Set([
  'accounts',
  'explore',
  'direct',
  'reels',
  'stories',
  'p',
  'tv',
  'challenge',
  'privacy',
  'about',
  'developer',
  'legal',
  'emails',
  'session',
  'oauth',
  'ajax',
  'api',
]);

/**
 * Tous les indices ne prouvent pas la même chose, et c'est le premier smoke
 * réel qui l'a montré.
 *
 * `canonical_url` est un ÉCHO : quand Instagram ne redirige pas, l'URL finale
 * est mot pour mot celle qu'on a demandée. Elle ne peut donc jamais diverger du
 * handle attendu, et un `MATCH` qui reposerait sur elle seule ne reposerait sur
 * rien. Constaté en vrai : `https://www.instagram.com/zzqqxx.nonexistent12345/`
 * — un compte qui n'existe pas — rendait `canonical_url = zzqqxx.nonexistent12345`,
 * `og_url = null`, `profile_header = null`, et concluait `MATCH`.
 *
 * Elle garde toute sa valeur dans l'autre sens : si l'URL finale porte un AUTRE
 * handle, c'est une divergence, et une vraie.
 *
 * Les indices de CONTENU (`og_url`, `profile_header`) sont produits par la page
 * elle-même. Eux seuls peuvent corroborer une identité, et il en faut au moins
 * un pour qu'un `MATCH` veuille dire quelque chose.
 */
const CONTENT_SIGNALS: readonly InstagramIdentitySignal['name'][] = ['og_url', 'profile_header'];

function isContentSignal(name: InstagramIdentitySignal['name']): boolean {
  return CONTENT_SIGNALS.includes(name);
}

export interface IdentityDecision {
  readonly verdict: InstagramIdentityVerdict;
  readonly observedHandle: string | null;
  readonly detail: string;
}

export interface IdentityInput {
  readonly expectedHandle: string;
  readonly signals: readonly InstagramIdentitySignal[];
  /** Le rail a constaté que le profil n'existe pas (page « désolé, cette page n'est pas disponible »). */
  readonly profileMissing: boolean;
  /** L'URL finale diffère de l'URL demandée. */
  readonly redirected: boolean;
}

/**
 * Rapproche les indices observés du handle attendu.
 *
 * L'ordre des tests est celui de la certitude décroissante :
 *
 *   1. profil absent → `NOT_FOUND`. Une redirection ou une page d'erreur ne se
 *      rattrape pas avec les autres indices.
 *   2. handle attendu illisible → `UNAVAILABLE`. Le job est mal formé ; ce
 *      n'est pas au rail de deviner ce qu'on voulait viser.
 *   3. aucun indice lisible → `UNAVAILABLE`. « Je n'ai rien pu lire » n'est pas
 *      « ça correspond ».
 *   4. au moins un indice diverge → `MISMATCH`, même si d'autres concordent.
 *   5. aucun indice de CONTENU lisible → `AMBIGUOUS`. Il ne resterait que
 *      l'écho de l'URL demandée, qui ne prouve rien (voir `CONTENT_SIGNALS`).
 *      C'est ce cas qu'un profil supprimé produit.
 *   6. un seul indice de contenu ET une redirection → `AMBIGUOUS`. Un compte
 *      renommé redirige vers son nouveau handle : l'URL finale « correspond »
 *      alors parfaitement à un compte que personne n'a validé.
 *   7. sinon → `MATCH`.
 */
export function decideIdentity(input: IdentityInput): IdentityDecision {
  const expected = normalizeHandle(input.expectedHandle);

  if (input.profileMissing) {
    return {
      verdict: 'NOT_FOUND',
      observedHandle: null,
      detail: `aucun profil Instagram accessible pour « ${input.expectedHandle} »`,
    };
  }
  if (expected === null) {
    return {
      verdict: 'UNAVAILABLE',
      observedHandle: null,
      detail: `handle attendu « ${input.expectedHandle} » illisible — rien à rapprocher`,
    };
  }

  const readable = input.signals.filter((signal): signal is InstagramIdentitySignal & { handle: string } => {
    return signal.handle !== null;
  });
  if (readable.length === 0) {
    return {
      verdict: 'UNAVAILABLE',
      observedHandle: null,
      detail: `aucun indice d'identité lisible sur la page (${input.signals.map((s) => s.name).join(', ') || 'aucun indice collecté'})`,
    };
  }

  const normalized = readable.map((signal) => ({ name: signal.name, handle: normalizeHandle(signal.handle) }));

  const unreadable = normalized.filter((signal) => signal.handle === null);
  if (unreadable.length > 0) {
    return {
      verdict: 'AMBIGUOUS',
      observedHandle: null,
      detail: `indice(s) illisible(s) : ${unreadable.map((s) => s.name).join(', ')}`,
    };
  }

  const diverging = normalized.filter((signal) => signal.handle !== expected);
  if (diverging.length > 0) {
    const first = diverging[0];
    return {
      verdict: 'MISMATCH',
      observedHandle: first?.handle ?? null,
      detail:
        `attendu « ${expected} », observé ${diverging.map((s) => `${s.name}=« ${s.handle} »`).join(', ')} — ` +
        'un profil qui ne porte pas le handle figé n’est pas le bon profil',
    };
  }

  // La règle qui empêche un profil supprimé de passer pour confirmé : sans
  // aucun indice VENANT DE LA PAGE, il ne reste que l'écho de l'URL demandée.
  const content = normalized.filter((signal) => isContentSignal(signal.name));
  if (content.length === 0) {
    return {
      verdict: 'AMBIGUOUS',
      observedHandle: null,
      detail:
        'aucun indice de contenu lisible (og:url, en-tête du profil) — il ne reste que l’URL demandée, ' +
        'qui ne fait que se refléter elle-même : un profil supprimé produirait exactement cela',
    };
  }

  if (input.redirected && content.length < 2) {
    return {
      verdict: 'AMBIGUOUS',
      observedHandle: expected,
      detail:
        'redirection observée et un seul indice de contenu — impossible de distinguer le bon compte ' +
        'd’un compte renommé qui redirigerait vers ce handle',
    };
  }

  return {
    verdict: 'MATCH',
    observedHandle: expected,
    detail:
      `${normalized.length} indice(s) concordant(s) dont ${content.length} de contenu : ` +
      normalized.map((s) => s.name).join(', '),
  };
}
