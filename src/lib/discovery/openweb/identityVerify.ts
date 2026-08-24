import {
  isPlatformDomain,
  nameSimilarity,
  normalizeCity,
  normalizeName,
  normalizePhone,
  normalizeRegistryId,
  stripAccents,
} from '@/lib/identity/normalize';
import type { LegalMentions } from '@/lib/discovery/openweb/legalMentions';

/**
 * « Ce site appartient-il vraiment à ce prospect ? »
 *
 * Le reste de R3 fabrique des hypothèses ; ce fichier est celui qui a le droit
 * de dire non. Il est écrit autour d'une asymétrie assumée : rattacher un
 * mauvais domaine coûte bien plus cher que de n'en rattacher aucun. Un domaine
 * erroné se propage dans la recherche, dans l'angle, puis dans un message qui
 * prétend avoir regardé le site de quelqu'un d'autre — et il ne ressemble plus
 * à une hypothèse dès la deuxième lecture. Ne rien rattacher, à l'inverse,
 * laisse simplement le prospect dans l'état où il était.
 *
 * Quatre verdicts, et un seul rattache sans condition :
 *
 *   confirmed  — une preuve d'appartenance : un identifiant de registre qui
 *                correspond, ou un téléphone qui correspond avec un nom qui
 *                s'accorde.
 *   probable   — plusieurs concordances faibles, aucune preuve. Rattachable
 *                **seulement** si le risque d'homonymie est nul.
 *   uncertain  — quelque chose concorde, pas assez. On garde la trace.
 *   rejected   — une contradiction. On garde aussi la trace : « testé et
 *                écarté » et « jamais testé » ne sont pas la même mesure.
 *
 * Tout est déterministe et sans réseau : aucun prompt n'a le droit de décider
 * à qui appartient un domaine.
 */

export type IdentityVerdictLevel = 'confirmed' | 'probable' | 'uncertain' | 'rejected';

export interface IdentitySignal {
  key: string;
  matched: boolean;
  /** Contribution au score quand le signal est vérifié. Négatif = contradiction. */
  weight: number;
  detail: string;
}

export interface IdentityVerdict {
  verdict: IdentityVerdictLevel;
  /** 0..1. Une lecture de la force du faisceau, pas une probabilité calibrée. */
  confidence: number;
  /**
   * Vrai quand une autre entreprise pourrait légitimement porter ce nom sur ce
   * domaine : enseigne peu distinctive, site multi-établissements, ville qui ne
   * s'accorde pas. Bloque le rattachement d'un `probable`.
   */
  homonymRisk: boolean;
  signals: IdentitySignal[];
  reasons: string[];
  rejectReason: string | null;
}

export interface IdentityVerificationInput {
  prospect: {
    displayName: string;
    brandName?: string | null;
    legalName?: string | null;
    registryId?: string | null;
    city?: string | null;
    postalCode?: string | null;
    phone?: string | null;
  };
  candidateDomain: string;
  /**
   * D'où vient le domaine testé.
   *
   * Détail décisif : un domaine `generated` a été **fabriqué à partir du nom du
   * prospect**. Comparer ce nom au domaine reviendrait alors à comparer le nom
   * à lui-même — un raisonnement circulaire qui accorde un nom parfait à
   * n'importe quel site répondant à l'adresse, fût-ce une pizzeria. Le cœur du
   * domaine ne compte comme indice que lorsqu'il a été **observé** ailleurs
   * (lien sur un compte social, proposition d'un moteur, mention sur une autre
   * page). Par défaut on suppose le cas prudent.
   */
  domainOrigin?: 'generated' | 'observed';
  /** Domaine réellement atteint après redirections, s'il diffère. */
  finalDomain?: string | null;
  httpStatus?: number | null;
  /** Le nom que le site se donne (titre, en-tête). */
  siteName?: string | null;
  /** Texte débalisé des pages lues, concaténé. */
  pageText: string;
  mentions?: LegalMentions | null;
  /** Tous les identifiants de registre valides trouvés sur le site. */
  registryIdsOnSite?: { sirens: string[]; sirets: string[] };
  observed?: {
    phones?: string[];
    emails?: string[];
    instagram?: string[];
    facebook?: string[];
  };
  /** Termes du vocabulaire de la niche effectivement lus sur les pages. */
  nicheTermsFound?: string[];
  /**
   * Titulaire du domaine tel que publié par le registre (RDAP).
   *
   * Le seul signal du faisceau qui vienne d'un registre plutôt que d'une page
   * que n'importe qui peut écrire. Absent pour une personne physique, qui est
   * anonymisée de droit — auquel cas il ne dit rien, ni pour ni contre.
   */
  rdapRegistrant?: { organizationName: string | null; anonymised: boolean } | null;
}

/** Accord de nom minimal pour qu'un faisceau vaille quoi que ce soit. */
export const NAME_AGREEMENT_FLOOR = 0.55;
/** Accord de nom au-delà duquel le nom devient un argument fort. */
export const NAME_AGREEMENT_STRONG = 0.8;
/**
 * Nombre de codes postaux distincts au-delà duquel un site cesse d'être celui
 * d'un établissement pour devenir celui d'un réseau. Le domaine d'une chaîne
 * n'est le site propre d'aucun de ses franchisés.
 */
export const CHAIN_POSTAL_THRESHOLD = 4;

function domainCore(domain: string): string {
  const core = domain.split('.')[0] ?? domain;
  return core.replace(/[-_]+/g, ' ').trim();
}

export function prospectNamesOf(input: IdentityVerificationInput): string[] {
  return [input.prospect.brandName, input.prospect.displayName, input.prospect.legalName]
    .map((value) => (value ?? '').trim())
    .filter((value) => value.length > 0);
}

/** Le meilleur accord entre les noms connus du prospect et ceux lus sur le site. */
export function bestNameAgreement(input: IdentityVerificationInput): { score: number; against: string } {
  const prospectNames = prospectNamesOf(input);

  const siteNames = [input.siteName ?? '', input.mentions?.legalName ?? ''];
  // Voir `domainOrigin` : le cœur d'un domaine fabriqué n'est pas une preuve.
  if (input.domainOrigin === 'observed') siteNames.push(domainCore(input.candidateDomain));

  let best = 0;
  let against = '';
  for (const left of prospectNames) {
    for (const right of siteNames.filter((value) => value.trim().length > 0)) {
      const score = nameSimilarity(left, right);
      if (score > best) {
        best = score;
        against = right;
      }
    }
  }
  return { score: best, against };
}

/**
 * Le nom du prospect est-il écrit, tel quel, sur les pages lues ?
 *
 * C'est un indice indépendant du titre : beaucoup de petits sites titrent
 * « Accueil » et écrivent leur nom dans le corps de la page. Exiger un nom
 * distinctif évite qu'« Auto » trouvé dans un texte quelconque ne compte.
 */
export function nameAppearsOnPage(input: IdentityVerificationInput): string | null {
  const haystack = stripAccents(input.pageText)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
  for (const name of prospectNamesOf(input)) {
    const normalized = normalizeName(name);
    if (normalized.replace(/\s/g, '').length < 5) continue;
    if (haystack.includes(normalized)) return name;
  }
  return null;
}

/** Codes postaux distincts lus sur le site — la signature d'un réseau. */
export function distinctPostalCodes(pageText: string): string[] {
  const found = new Set<string>();
  for (const match of pageText.matchAll(/\b(\d{5})\s+[A-ZÀ-Ÿ][A-Za-zÀ-ÿ'’-]{2,}/g)) {
    const code = match[1];
    if (code) found.add(code);
  }
  return [...found];
}

/**
 * Le nom porte-t-il assez de matière pour distinguer une entreprise d'une
 * autre ? Un nom d'une seule syllabe courte, ou entièrement numérique, ne le
 * fait pas — et c'est exactement le cas où l'homonymie se produit.
 */
export function nameIsDistinctive(name: string): boolean {
  const normalized = normalizeName(name);
  if (!normalized) return false;
  const compact = normalized.replace(/\s/g, '');
  if (compact.length < 5) return false;
  if (/^\d+$/.test(compact)) return false;
  return true;
}

function includesNormalized(haystack: string, needle: string): boolean {
  if (!needle) return false;
  return stripAccents(haystack).toLowerCase().includes(stripAccents(needle).toLowerCase());
}

/**
 * Vérifie l'appartenance d'un domaine à un prospect.
 *
 * Ne fait aucun appel réseau : tout ce qui a été observé arrive en entrée. Cela
 * rend chaque cas — homonyme, chaîne nationale, SIREN contradictoire —
 * reproductible dans un test.
 */
export function verifyIdentity(input: IdentityVerificationInput): IdentityVerdict {
  const signals: IdentitySignal[] = [];
  const reasons: string[] = [];
  const add = (key: string, matched: boolean, weight: number, detail: string): void => {
    signals.push({ key, matched, weight, detail });
    if (matched) reasons.push(detail);
  };

  // ---------------------------------------------------------------- rejets secs
  if (isPlatformDomain(input.candidateDomain)) {
    return rejected(signals, `${input.candidateDomain} est une plateforme, pas le site d'une entreprise`);
  }

  const finalDomain = input.finalDomain ?? input.candidateDomain;
  if (finalDomain !== input.candidateDomain) {
    if (isPlatformDomain(finalDomain)) {
      return rejected(signals, `redirection vers la plateforme ${finalDomain}`);
    }
    /**
     * Une redirection vers un autre domaine n'est pas fatale — beaucoup
     * d'entreprises redirigent un nom historique vers le nouveau — mais ce qui
     * est vérifié désormais est le domaine d'arrivée, pas celui qu'on avait
     * fabriqué. Le signal le dit pour que le rapport ne prétende pas avoir
     * confirmé `x.fr` alors qu'il a lu `y.fr`.
     */
    add('redirect_off_candidate', true, 0, `redirige vers ${finalDomain}`);
  }

  if (input.httpStatus !== null && input.httpStatus !== undefined && (input.httpStatus < 200 || input.httpStatus >= 400)) {
    return rejected(signals, `le domaine ne sert pas de page (HTTP ${input.httpStatus})`);
  }

  // ------------------------------------------------------ identifiants de registre
  const prospectRegistry = normalizeRegistryId(input.prospect.registryId ?? null);
  const sirensOnSite = (input.registryIdsOnSite?.sirens ?? []).map((value) => value.replace(/\D/g, ''));
  const siteSiren = input.mentions?.siren ? input.mentions.siren.replace(/\D/g, '') : null;
  const allSirens = [...new Set([...sirensOnSite, ...(siteSiren ? [siteSiren] : [])])];

  const prospectSiren = prospectRegistry ? prospectRegistry.slice(0, 9) : null;
  const registryMatch = prospectSiren !== null && allSirens.includes(prospectSiren);
  const registryConflict = prospectSiren !== null && !registryMatch && allSirens.length > 0;

  if (registryMatch) {
    add('registry_id', true, 1, `le site publie le SIREN ${prospectSiren} du prospect`);
  } else if (registryConflict) {
    /**
     * Le site publie une identité légale, et ce n'est pas la nôtre. Un site
     * qui affiche le SIREN de son agence en plus du sien porterait les deux, et
     * `registryMatch` aurait gagné : arriver ici veut dire qu'aucun des
     * identifiants publiés n'est celui du prospect.
     */
    return rejected(
      signals,
      `le site publie une identité légale différente (${allSirens.slice(0, 2).join(', ')}) de celle du prospect`,
    );
  } else if (allSirens.length > 0) {
    // Le prospect n'a pas de SIREN connu : celui du site est une piste vers le
    // registre (§13), pas une preuve d'appartenance.
    add('registry_id_on_site', true, 0.1, `identité légale publiée sur le site : ${allSirens[0]}`);
  }

  // ------------------------------------------------------------------ téléphone
  const prospectPhone = normalizePhone(input.prospect.phone ?? null);
  const sitePhones = (input.observed?.phones ?? [])
    .map((value) => normalizePhone(value))
    .filter((value): value is string => value !== null);
  const phoneMatch = Boolean(prospectPhone && sitePhones.includes(prospectPhone));
  if (phoneMatch) {
    add('phone', true, 0.55, 'le téléphone du prospect figure sur le site');
  } else if (prospectPhone && sitePhones.length > 0) {
    add('phone_conflict', true, -0.15, 'le site affiche un téléphone, différent de celui connu');
  }

  // ----------------------------------------------------------------------- nom
  const declared = bestNameAgreement(input);
  const onPage = nameAppearsOnPage(input);
  if (onPage) add('name_on_page', true, 0.3, `« ${onPage} » est écrit sur les pages lues`);

  /**
   * Deux façons pour un site de porter le nom : le déclarer (titre, mentions
   * légales) ou l'écrire dans son contenu. La seconde vaut la première quand
   * le nom est distinctif — un site titré « Accueil » n'est pas moins celui de
   * l'entreprise dont il répète le nom sur chaque page.
   */
  const agreement =
    onPage && declared.score < NAME_AGREEMENT_STRONG
      ? { score: NAME_AGREEMENT_STRONG, against: `${onPage} (dans le texte)` }
      : declared;

  if (agreement.score >= NAME_AGREEMENT_STRONG) {
    add('name_strong', true, 0.45, `le nom concorde fortement (${agreement.score.toFixed(2)} — « ${agreement.against} »)`);
  } else if (agreement.score >= NAME_AGREEMENT_FLOOR) {
    add('name', true, 0.25, `le nom concorde (${agreement.score.toFixed(2)} — « ${agreement.against} »)`);
  } else {
    add('name', false, 0, `accord de nom insuffisant (${agreement.score.toFixed(2)})`);
  }

  // ---------------------------------------------------------- titulaire du domaine
  const holder = input.rdapRegistrant?.organizationName ?? null;
  let holderMatch = false;
  if (holder) {
    const holderAgreement = Math.max(
      ...prospectNamesOf(input).map((name) => nameSimilarity(name, holder)),
      0,
    );
    if (holderAgreement >= NAME_AGREEMENT_STRONG) {
      holderMatch = true;
      add('rdap_registrant', true, 0.5, `le registre attribue le domaine à « ${holder} » (${holderAgreement.toFixed(2)})`);
    } else if (holderAgreement >= NAME_AGREEMENT_FLOOR) {
      add('rdap_registrant_partial', true, 0.2, `titulaire déclaré « ${holder} » (${holderAgreement.toFixed(2)})`);
    } else {
      /**
       * Le registre nomme une personne morale, et ce n'est pas la nôtre. Le
       * signal est négatif mais pas éliminatoire : une société peut déposer
       * ses domaines sous une holding, une filiale ou son agence. Il pèse
       * contre, il ne tranche pas seul.
       */
      add('rdap_registrant_conflict', true, -0.3, `le domaine est déposé par « ${holder} », sans rapport avec le nom du prospect`);
    }
  }

  // -------------------------------------------------------------------- endroit
  const prospectCity = normalizeCity(input.prospect.city);
  const mentionCity = normalizeCity(input.mentions?.city ?? null);
  const cityMatch = Boolean(
    prospectCity && (mentionCity === prospectCity || includesNormalized(input.pageText, input.prospect.city ?? '')),
  );
  if (cityMatch) add('city', true, 0.2, `la ville « ${input.prospect.city} » figure sur le site`);

  const postalMatch = Boolean(
    input.prospect.postalCode &&
      (input.mentions?.postalCode === input.prospect.postalCode ||
        input.pageText.includes(input.prospect.postalCode)),
  );
  if (postalMatch) add('postal_code', true, 0.25, `le code postal ${input.prospect.postalCode} figure sur le site`);

  const cityConflict = Boolean(prospectCity && mentionCity && mentionCity !== prospectCity);
  if (cityConflict) {
    add('city_conflict', true, -0.25, `les mentions légales situent l'entreprise à « ${input.mentions?.city} »`);
  }

  // ------------------------------------------------------------------- courriel
  const emailOnDomain = (input.observed?.emails ?? []).some((email) => {
    const host = email.split('@')[1]?.toLowerCase() ?? '';
    return host === input.candidateDomain || host === finalDomain || host.endsWith(`.${finalDomain}`);
  });
  if (emailOnDomain) add('email_on_domain', true, 0.15, 'une adresse e-mail du domaine est publiée');

  // ---------------------------------------------------------------------- métier
  const nicheTerms = input.nicheTermsFound ?? [];
  if (nicheTerms.length >= 2) {
    add('niche_vocabulary', true, 0.15, `vocabulaire du métier présent (${nicheTerms.slice(0, 3).join(', ')})`);
  } else if (nicheTerms.length === 0 && input.pageText.length > 400) {
    // Une page substantielle sans un mot du métier : soit ce n'est pas la même
    // entreprise, soit ce n'est pas la même activité. Dans les deux cas, un
    // homonyme est l'explication la plus probable.
    add('niche_absent', true, -0.15, 'aucun terme du métier sur les pages lues');
  }

  // -------------------------------------------------------------- risque d'homonymie
  const postals = distinctPostalCodes(input.pageText);
  const looksLikeChain = postals.length >= CHAIN_POSTAL_THRESHOLD;
  if (looksLikeChain) {
    add(
      'multi_site',
      true,
      -0.2,
      `${postals.length} adresses distinctes sur le site : réseau ou multi-établissements`,
    );
  }

  const distinctive = nameIsDistinctive(input.prospect.brandName ?? input.prospect.displayName);
  if (!distinctive) add('name_not_distinctive', true, -0.1, 'nom trop peu distinctif pour trancher seul');

  /**
   * Deux façons de prouver l'appartenance plutôt que de la supposer : le site
   * publie l'identité légale du prospect, ou le registre lui attribue le
   * domaine. L'une ou l'autre dissout le risque d'homonymie — sauf si les
   * mentions légales situent l'entreprise ailleurs, auquel cas c'est
   * précisément un homonyme qui détient le domaine.
   */
  const ownershipProven = registryMatch || (holderMatch && !cityConflict);
  const homonymRisk =
    !ownershipProven && (looksLikeChain || !distinctive || cityConflict || (!cityMatch && !postalMatch && !phoneMatch));

  // ------------------------------------------------------------------- synthèse
  const confidence = Math.max(
    0,
    Math.min(1, signals.filter((signal) => signal.matched).reduce((sum, signal) => sum + signal.weight, 0)),
  );

  /**
   * Les règles, dans l'ordre. Elles sont volontairement énumérées plutôt que
   * dérivées d'un seuil unique : un seuil cache quelle preuve a emporté la
   * décision, et c'est précisément ce que le rapport doit pouvoir dire.
   */
  let verdict: IdentityVerdictLevel;
  if (registryMatch) {
    verdict = 'confirmed';
  } else if (holderMatch && !cityConflict && !looksLikeChain && agreement.score >= NAME_AGREEMENT_FLOOR) {
    // Le registre dit qui a déposé le nom, et le site se présente sous ce nom.
    verdict = 'confirmed';
  } else if (phoneMatch && agreement.score >= NAME_AGREEMENT_FLOOR && !looksLikeChain) {
    verdict = 'confirmed';
  } else if (
    agreement.score >= NAME_AGREEMENT_STRONG &&
    (cityMatch || postalMatch) &&
    nicheTerms.length >= 1 &&
    !looksLikeChain &&
    !cityConflict
  ) {
    verdict = 'confirmed';
  } else if (confidence >= 0.45 && agreement.score >= NAME_AGREEMENT_FLOOR) {
    verdict = 'probable';
  } else if (confidence > 0 && agreement.score >= NAME_AGREEMENT_FLOOR) {
    verdict = 'uncertain';
  } else {
    verdict = 'rejected';
  }

  if (verdict === 'rejected') {
    return {
      verdict,
      confidence,
      homonymRisk,
      signals,
      reasons,
      rejectReason:
        agreement.score < NAME_AGREEMENT_FLOOR
          ? `le site ne se présente pas sous ce nom (accord ${agreement.score.toFixed(2)})`
          : 'aucun signal d’appartenance observé',
    };
  }

  return { verdict, confidence, homonymRisk, signals, reasons, rejectReason: null };
}

function rejected(signals: IdentitySignal[], reason: string): IdentityVerdict {
  return {
    verdict: 'rejected',
    confidence: 0,
    homonymRisk: false,
    signals: [...signals, { key: 'rejected', matched: true, weight: 0, detail: reason }],
    reasons: [],
    rejectReason: reason,
  };
}

/**
 * Le domaine peut-il être écrit sur le prospect ?
 *
 * `confirmed` oui. `probable` seulement en l'absence de risque d'homonymie —
 * c'est la phrase du §12 du gate, rendue exécutable. Le reste reste candidat :
 * consultable par un humain, invisible pour le générateur de message.
 */
export function isAttachable(verdict: IdentityVerdict): boolean {
  if (verdict.verdict === 'confirmed') return true;
  return verdict.verdict === 'probable' && !verdict.homonymRisk;
}
