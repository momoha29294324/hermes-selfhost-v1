import { stripTags } from '@/lib/enrichment/websiteExtract';
import { normalizeRegistryId, stripAccents } from '@/lib/identity/normalize';

/**
 * Lecture des mentions légales d'un site français.
 *
 * C'est le meilleur pont gratuit entre un domaine et une identité légale : la
 * loi pour la confiance dans l'économie numérique impose à un site
 * professionnel d'afficher qui l'édite, et beaucoup de sites y publient leur
 * SIREN ou leur SIRET. Un numéro de registre lu sur le site d'une entreprise
 * est une **preuve d'appartenance**, pas une ressemblance de nom : c'est la
 * différence entre « ce domaine ressemble au nom » et « ce domaine dit
 * appartenir à cette société ».
 *
 * Deux règles gouvernent le fichier :
 *
 *   1. **Rien n'est deviné.** Chaque champ renvoyé a été lu, avec l'étiquette
 *      qui l'a produit conservée dans `matchedLabels`. Ce qui n'est pas lu
 *      reste `null`.
 *   2. **Un numéro non valide n'est pas un numéro.** Un SIREN porte une clé de
 *      Luhn ; neuf chiffres trouvés dans une page ne sont un SIREN que s'ils la
 *      vérifient. Sans ce filtre, un numéro de téléphone concaténé, une
 *      référence produit ou un identifiant de suivi deviendraient une identité
 *      légale, et une identité légale fausse contamine tout ce qui suit.
 */

export interface LegalMentions {
  siren: string | null;
  siret: string | null;
  /** TVA intracommunautaire française : FR + clé (2) + SIREN (9). */
  vatNumber: string | null;
  legalName: string | null;
  addressLine: string | null;
  postalCode: string | null;
  city: string | null;
  publicationDirector: string | null;
  /** Ville du greffe mentionnée par « RCS <ville> ». */
  rcsCity: string | null;
  sourceUrl: string;
  /** Les étiquettes qui ont effectivement produit une valeur. Traçabilité. */
  matchedLabels: string[];
}

/**
 * Clé de Luhn.
 *
 * Un SIREN et un SIRET la portent. L'exception connue est La Poste
 * (SIREN 356000000), dont les SIRET suivent une autre règle ; elle est traitée
 * explicitement plus bas plutôt que par un assouplissement général du contrôle.
 */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    const char = digits[digits.length - 1 - i];
    if (char === undefined) return false;
    let value = char.charCodeAt(0) - 48;
    if (i % 2 === 1) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
  }
  return sum % 10 === 0;
}

const LA_POSTE_SIREN = '356000000';

export function isValidSiren(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length !== 9) return false;
  if (digits === LA_POSTE_SIREN) return true;
  return luhnValid(digits);
}

export function isValidSiret(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length !== 14) return false;
  // La Poste : la somme des chiffres est un multiple de 5, la clé de Luhn ne
  // s'applique pas. Documenté par l'INSEE, et suffisamment courant pour mériter
  // sa ligne plutôt qu'un faux négatif silencieux.
  if (digits.startsWith(LA_POSTE_SIREN)) {
    const sum = [...digits].reduce((acc, char) => acc + (char.charCodeAt(0) - 48), 0);
    return sum % 5 === 0;
  }
  return luhnValid(digits);
}

/**
 * Clé de contrôle d'un numéro de TVA intracommunautaire français.
 * `clé = (12 + 3 × (SIREN mod 97)) mod 97`.
 */
export function isValidFrenchVat(value: string): boolean {
  const cleaned = value.replace(/\s/g, '').toUpperCase();
  const match = cleaned.match(/^FR(\d{2})(\d{9})$/);
  if (!match) return false;
  const key = Number.parseInt(match[1] ?? '', 10);
  const siren = match[2] ?? '';
  if (!isValidSiren(siren)) return false;
  const expected = (12 + 3 * (Number.parseInt(siren, 10) % 97)) % 97;
  return key === expected;
}

/** Pages où une identité légale a une chance d'être publiée. */
const LEGAL_PATH = /(mentions?[-_]?l[ée]gales?|mentions|legal|cgv|cgu|conditions[-_]?g[ée]n[ée]rales|politique[-_]?de[-_]?confidentialit|privacy|impressum|qui[-_]?sommes[-_]?nous)/i;

/**
 * Liens internes menant plausiblement aux mentions légales.
 *
 * Séparé de `extractInternalLinks` (qui vise les pages commerciales) parce que
 * les deux cherchent des choses différentes : l'une le funnel, l'autre
 * l'identité. Les mélanger ferait dépenser le budget de pages du crawl sur des
 * CGV au lieu d'une page tarifs.
 */
export function findLegalPages(html: string, pageUrl: string): string[] {
  let origin: string;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return [];
  }
  const links = new Set<string>();
  for (const match of html.matchAll(/<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]{0,160}?)<\/a>/gi)) {
    const href = match[1];
    if (!href) continue;
    let absolute: URL;
    try {
      absolute = new URL(href, pageUrl);
    } catch {
      continue;
    }
    if (absolute.origin !== origin) continue;
    if (/\.(pdf|jpg|jpeg|png|webp|svg|zip|mp4)$/i.test(absolute.pathname)) continue;
    // Le chemin OU le texte du lien : beaucoup de sites servent leurs mentions
    // depuis une URL opaque (`/page-12`) avec un libellé explicite.
    const label = stripTags(match[2] ?? '');
    if (!LEGAL_PATH.test(absolute.pathname) && !LEGAL_PATH.test(label)) continue;
    absolute.hash = '';
    links.add(absolute.toString());
  }
  return [...links].slice(0, 4);
}

/** Chemins tentés quand aucun lien n'a été trouvé dans la page. */
export const LEGAL_PATH_GUESSES = [
  '/mentions-legales',
  '/mentions-legales/',
  '/mentions_legales',
  '/legal',
  '/cgv',
] as const;

function cleanValue(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/^[\s:–—-]+/, '')
    .replace(/[\s.,;|·–—-]+$/, '')
    .trim();
}

/**
 * Coupe la valeur avant l'étiquette suivante.
 *
 * Les mentions légales sont mises en page avec des balises et lues ici sans
 * elles : `stripTags` ramène toute la page sur une seule ligne, donc
 * « Raison sociale : NORTHSTAR STUDIO SARL » est immédiatement suivi de
 * « Siège social : 12 rue… » sans rien pour les séparer. Une capture qui
 * s'arrête au saut de ligne ne s'arrête donc jamais, et la raison sociale
 * avale la moitié de la page.
 *
 * La frontière fiable est l'étiquette suivante : un mot ou deux suivis de deux
 * points. Ce n'est pas parfait — une raison sociale contenant elle-même deux
 * points serait tronquée — mais tronquer est le bon sens de l'erreur : un nom
 * court et juste vaut mieux qu'un paragraphe présenté comme une raison sociale.
 */
const LABEL_HEAD_WORDS = new Set([
  'siege', 'adresse', 'siret', 'siren', 'tva', 'rcs', 'capital', 'telephone', 'tel',
  'email', 'mail', 'courriel', 'directeur', 'directrice', 'responsable', 'hebergeur',
  'editeur', 'proprietaire', 'raison', 'denomination', 'forme', 'societe', 'numero',
  'contact', 'ape', 'naf', 'site', 'web', 'url', 'immatriculation', 'greffe', 'fax',
  // Ajoutés après le pilote R5 : « VTC LYONNAIS 69800 Activité : … » laissait
  // « Activité » collé au nom.
  'activite', 'activites', 'statut', 'publication', 'conception', 'realisation',
]);

/**
 * Mots qui relient une étiquette à sa suite : « Numéro **de** SIRET »,
 * « Adresse **du** siège ».
 *
 * Ils existent parce qu'une étiquette n'est pas toujours un seul mot, et que
 * s'arrêter au premier mot d'étiquette rencontré depuis la droite laissait la
 * moitié de l'étiquette collée au nom. Le pilote R5 en a produit le cas :
 * « Car Protect Annecy Numéro de SIRET : … » rendait la raison sociale
 * « Car Protect Annecy Numéro de » — un nom qui part ensuite dans un message.
 */
const LABEL_CONNECTOR_WORDS = new Set([
  'de', 'du', 'des', 'd', 'la', 'le', 'les', 'l', 'au', 'aux', 'a', 'en', 'sur',
  'social', 'sociale', 'postal', 'postale', 'intracommunautaire', 'complet', 'complete',
]);

function labelWord(word: string): string {
  return stripAccents(word).toLowerCase().replace(/[^a-z]/g, '');
}

export function cutAtNextLabel(value: string): string {
  const colon = value.indexOf(':');
  if (colon < 0) return value.trim();

  const head = value.slice(0, colon).trimEnd();
  const words = head.split(/\s+/).filter((word) => word.length > 0);

  /**
   * On remonte depuis les deux points jusqu'au mot qui ouvre l'étiquette.
   *
   * Compter les mots ne marche pas : « Siège social : » en fait deux,
   * « Tél : » un seul, et découper au plus court ampute la forme juridique
   * (« NORTHSTAR STUDIO SARL » devient « NORTHSTAR STUDIO »). Le vocabulaire des
   * étiquettes, lui, est court, stable et propre aux mentions légales.
   */
  for (let index = words.length - 1; index >= 0 && words.length - index <= 4; index -= 1) {
    if (!LABEL_HEAD_WORDS.has(labelWord(words[index] ?? ''))) continue;

    /**
     * L'étiquette trouvée peut en cacher une plus longue à sa gauche. On
     * continue tant que les mots précédents appartiennent au vocabulaire des
     * étiquettes ou à celui qui les relie — et on s'arrête au premier mot qui
     * appartient au nom de l'entreprise.
     */
    let cut = index;
    while (cut > 0) {
      const previous = labelWord(words[cut - 1] ?? '');
      if (!LABEL_HEAD_WORDS.has(previous) && !LABEL_CONNECTOR_WORDS.has(previous)) break;
      cut -= 1;
    }
    return words.slice(0, cut).join(' ').trim();
  }
  return head.trim();
}

/**
 * Retire les mots d'étiquette collés en fin de valeur.
 *
 * Même cause que `cutAtNextLabel`, autre symptôme : « 69002 Lyon SIRET : … »
 * sur une seule ligne fait capturer « Lyon SIRET » comme commune. Ici il n'y a
 * pas de deux points dans la capture, donc c'est la queue qu'il faut élaguer.
 */
export function dropTrailingLabelWords(value: string): string {
  const words = value.split(/\s+/).filter((word) => word.length > 0);
  while (words.length > 1) {
    const last = stripAccents(words[words.length - 1] ?? '')
      .toLowerCase()
      .replace(/[^a-z]/g, '');
    if (!LABEL_HEAD_WORDS.has(last)) break;
    words.pop();
  }
  return words.join(' ');
}

const NAME_LABELS: [string, RegExp][] = [
  ['raison_sociale', /raison\s+sociale\s*[:–—-]?\s*([^|·\n]{2,90})/i],
  ['denomination', /d[ée]nomination(?:\s+sociale)?\s*[:–—-]?\s*([^|·\n]{2,90})/i],
  ['editeur', /[ée]diteur(?:\s+du\s+site)?\s*[:–—-]\s*([^|·\n]{2,90})/i],
  ['proprietaire', /propri[ée]taire(?:\s+du\s+site)?\s*[:–—-]\s*([^|·\n]{2,90})/i],
  ['societe', /(?:^|\s)soci[ée]t[ée]\s*[:–—-]\s*([^|·\n]{2,90})/i],
];

const LEGAL_FORM_TAIL = /\b(SARL|SASU?|EURL|SCI|SNC|SA|EI|EIRL|SCOP|SELARL)\b/i;

/**
 * Extrait ce que la page dit de l'entreprise qui l'édite.
 *
 * Travaille sur le texte débalisé : les mentions légales sont de la prose, pas
 * des données structurées, et un parseur DOM n'y gagnerait rien.
 */
export function extractLegalMentions(html: string, sourceUrl: string): LegalMentions {
  const text = stripTags(html);
  const matchedLabels: string[] = [];

  // --- SIRET d'abord : il contient le SIREN, donc le trouver répond aux deux.
  let siret: string | null = null;
  let siren: string | null = null;

  for (const match of text.matchAll(/\b(\d{3}[\s.]?\d{3}[\s.]?\d{3}[\s.]?\d{5})\b/g)) {
    const candidate = (match[1] ?? '').replace(/\D/g, '');
    if (candidate.length === 14 && isValidSiret(candidate)) {
      siret = candidate;
      siren = candidate.slice(0, 9);
      matchedLabels.push('siret');
      break;
    }
  }

  if (!siren) {
    for (const match of text.matchAll(/\b(\d{3}[\s.]?\d{3}[\s.]?\d{3})\b/g)) {
      const candidate = (match[1] ?? '').replace(/\D/g, '');
      if (candidate.length === 9 && isValidSiren(candidate)) {
        siren = candidate;
        matchedLabels.push('siren');
        break;
      }
    }
  }

  // --- TVA : porte le SIREN et se valide indépendamment.
  let vatNumber: string | null = null;
  for (const match of text.matchAll(/\bFR\s?(\d{2})\s?(\d{3}\s?\d{3}\s?\d{3})\b/gi)) {
    const cleaned = `FR${(match[1] ?? '').trim()}${(match[2] ?? '').replace(/\s/g, '')}`;
    if (isValidFrenchVat(cleaned)) {
      vatNumber = cleaned;
      matchedLabels.push('tva');
      if (!siren) {
        siren = cleaned.slice(4);
        matchedLabels.push('siren_via_tva');
      }
      break;
    }
  }

  // --- Raison sociale
  let legalName: string | null = null;
  for (const [label, pattern] of NAME_LABELS) {
    const value = cleanValue(cutAtNextLabel(text.match(pattern)?.[1] ?? ''));
    // Une raison sociale qui porte encore un « : » n'a pas été isolée
    // correctement : mieux vaut ne rien renvoyer que renvoyer un paragraphe.
    if (value.length >= 2 && value.length <= 90 && !value.includes(':')) {
      legalName = value;
      matchedLabels.push(label);
      break;
    }
  }
  if (!legalName) {
    // Dernier recours : une forme juridique explicite juste avant ou après un
    // nom. « SARL NORTHSTAR STUDIO » est une raison sociale ; « nos SARL clientes »
    // ne l'est pas, d'où l'exigence de majuscules autour.
    const match = text.match(/\b(?:SARL|SASU|SAS|EURL|SCI|SNC|SA|EI|EIRL)\s+([A-ZÀ-Ÿ0-9][A-ZÀ-Ÿ0-9'’\s.&-]{2,60})/);
    const value = cleanValue(match?.[0] ?? '');
    if (value && LEGAL_FORM_TAIL.test(value)) {
      legalName = value;
      matchedLabels.push('forme_juridique');
    }
  }

  // --- Adresse
  const addressMatch = text.match(
    /\b(\d{1,4}(?:\s?(?:bis|ter|quater))?[,\s]+(?:rue|avenue|av\.|boulevard|bd|chemin|impasse|route|place|all[ée]e|quai|cours|voie|z\.?a\.?c?\.?|z\.?i\.?)[^,;|\n]{2,70})/i,
  );
  const addressLine = addressMatch ? cleanValue(addressMatch[1] ?? '') : null;
  if (addressLine) matchedLabels.push('adresse');

  // Code postal suivi d'une commune : le duo est bien plus fiable que le code
  // postal seul, qui se confond avec un prix ou une référence.
  const localityMatch = text.match(/\b(\d{5})\s+([A-ZÀ-Ÿ][A-Za-zÀ-ÿ'’\-]{1,25}(?:[\s-][A-Za-zÀ-ÿ'’\-]{1,25}){0,3})/);
  const postalCode = localityMatch?.[1] ?? null;
  const cityValue = localityMatch ? dropTrailingLabelWords(cleanValue(cutAtNextLabel(localityMatch[2] ?? ''))) : '';
  const city = cityValue.length >= 2 ? cityValue : null;
  if (postalCode) matchedLabels.push('code_postal');

  // --- Directeur de la publication
  const directorMatch = text.match(
    /(?:directeur|directrice|responsable)\s+(?:de\s+la\s+)?publication\s*[:–—-]?\s*([A-ZÀ-Ÿ][^|·\n]{2,60})/i,
  );
  const directorValue = directorMatch ? cleanValue(cutAtNextLabel(directorMatch[1] ?? '')) : '';
  const publicationDirector = directorValue.length >= 2 && !directorValue.includes(':') ? directorValue : null;
  if (publicationDirector) matchedLabels.push('directeur_publication');

  // --- Greffe
  const rcsMatch = text.match(/\bRCS\s+(?:de\s+)?([A-ZÀ-Ÿ][A-Za-zÀ-ÿ'’\-]{2,25}(?:[\s-][A-Za-zÀ-ÿ'’\-]{2,25})?)/);
  const rcsValue = rcsMatch ? dropTrailingLabelWords(cleanValue(cutAtNextLabel(rcsMatch[1] ?? ''))) : '';
  const rcsCity = rcsValue.length >= 2 ? rcsValue : null;
  if (rcsCity) matchedLabels.push('rcs');

  return {
    siren: siren ? normalizeRegistryId(siren) : null,
    siret: siret ? normalizeRegistryId(siret) : null,
    vatNumber,
    legalName,
    addressLine,
    postalCode,
    city,
    publicationDirector,
    rcsCity,
    sourceUrl,
    matchedLabels: [...new Set(matchedLabels)],
  };
}

/**
 * Tous les identifiants de registre valides présents dans une page.
 *
 * `extractLegalMentions` s'arrête au premier, ce qui suffit pour identifier.
 * Détecter une **contradiction** demande l'inverse : un site qui publie le
 * SIREN de son agence web à côté du sien en porte deux, et ne retenir que le
 * premier ferait rejeter le bon site. La vérification d'identité a donc besoin
 * de l'ensemble, pas d'un représentant.
 */
export function collectRegistryIds(html: string): { sirens: string[]; sirets: string[] } {
  const text = stripTags(html);
  const sirens = new Set<string>();
  const sirets = new Set<string>();

  for (const match of text.matchAll(/\b(\d{3}[\s.]?\d{3}[\s.]?\d{3}[\s.]?\d{5})\b/g)) {
    const candidate = (match[1] ?? '').replace(/\D/g, '');
    if (candidate.length === 14 && isValidSiret(candidate)) {
      sirets.add(candidate);
      sirens.add(candidate.slice(0, 9));
    }
  }
  for (const match of text.matchAll(/\b(\d{3}[\s.]?\d{3}[\s.]?\d{3})\b/g)) {
    const candidate = (match[1] ?? '').replace(/\D/g, '');
    if (candidate.length === 9 && isValidSiren(candidate)) sirens.add(candidate);
  }
  for (const match of text.matchAll(/\bFR\s?(\d{2})\s?(\d{3}\s?\d{3}\s?\d{3})\b/gi)) {
    const cleaned = `FR${(match[1] ?? '').trim()}${(match[2] ?? '').replace(/\s/g, '')}`;
    if (isValidFrenchVat(cleaned)) sirens.add(cleaned.slice(4));
  }

  return { sirens: [...sirens], sirets: [...sirets] };
}

/** Vrai quand la lecture a produit au moins un fait exploitable. */
export function hasUsableMentions(mentions: LegalMentions): boolean {
  return Boolean(
    mentions.siren ||
      mentions.siret ||
      mentions.vatNumber ||
      mentions.legalName ||
      (mentions.postalCode && mentions.city),
  );
}
