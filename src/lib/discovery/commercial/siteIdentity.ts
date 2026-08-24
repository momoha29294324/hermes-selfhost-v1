import {
  collectRegistryIds,
  dropTrailingLabelWords,
  extractLegalMentions,
  hasUsableMentions,
} from '@/lib/discovery/openweb/legalMentions';
import { extractPageFacts, matchVocabulary, stripTags } from '@/lib/enrichment/websiteExtract';
import { siteDeclaredName } from '@/lib/discovery/places/identify';
import { nameIsDistinctive } from '@/lib/discovery/openweb/identityVerify';
import {
  normalizeCity,
  normalizeEmail,
  normalizeFacebookUrl,
  normalizeInstagramHandle,
  normalizePhone,
  normalizeRegistryId,
  stripAccents,
} from '@/lib/identity/normalize';
import { departmentFromPostcode } from '@/lib/geo/geo';
import type { PageFacts } from '@/lib/enrichment/websiteExtract';
import type { DomainProbe } from '@/lib/discovery/openweb/domainVerify';
import type { NicheConfig } from '@/lib/config/schema';

/**
 * « Qui est cette entreprise ? » — et la différence avec la question de R3.
 *
 * Le vérificateur d'identité de R3 répond à « ce site appartient-il à ce
 * prospect ? ». Il compare deux choses connues. R5 n'a rien à comparer : il
 * arrive sur un domaine qu'un index a proposé pour « atelier automobile
 * Lyon », et personne n'a encore dit à qui il est.
 *
 * La tentation serait de réutiliser le vérificateur en lui donnant, comme
 * « prospect », un nom fabriqué à partir du domaine. Ce serait un raisonnement
 * circulaire — exactement celui que `domainOrigin: 'generated'` existe pour
 * empêcher : comparer `demo-66-exemple.fr` à « Xatelier » rend un accord parfait
 * pour n'importe quel site répondant à cette adresse, fût-ce une pizzeria.
 *
 * Ce module fait donc autre chose, et de nature honnête : il **recueille ce
 * que le site déclare de lui-même**, et mesure à quel point il en déclare.
 *
 *   — une identité légale publiée (SIREN, SIRET, TVA) est une déclaration
 *     vérifiable auprès d'un tiers : c'est le seul `confirmed` ;
 *   — un nom et une adresse en mentions légales sont une déclaration engageante,
 *     mais que personne ne contresigne ;
 *   — un titre de page et rien d'autre n'est presque rien.
 *
 * Le verdict porté ici ne dit jamais « ce domaine appartient à X ». Il dit
 * « voici ce que ce site affirme être, et voici combien il en dit ». C'est
 * suffisant pour prospecter, et c'est tout ce qui est vrai.
 *
 * Le vérificateur R3 garde son rôle entier, sans qu'aucun seuil ne bouge (§7) :
 * il tranche quand cette identité rencontre un prospect déjà en base — le cas
 * où deux choses connues doivent être comparées. Voir `railCommercial.ts`.
 */

export type IdentityReviewLevel = 'confirmed' | 'manual_review' | 'uncertain';

export interface BusinessIdentity {
  /** Le nom sous lequel l'entreprise se présente, tel que lu. */
  name: string | null;
  legalName: string | null;
  addressLine: string | null;
  postalCode: string | null;
  city: string | null;
  department: string | null;
  registryId: string | null;
  phone: string | null;
  email: string | null;
  instagramHandle: string | null;
  facebookUrl: string | null;

  /** Termes du métier réellement lus sur les pages. */
  nicheTermsFound: string[];
  /** Les déclarations qui ont produit ce verdict, une par ligne. */
  declarations: string[];
  review: IdentityReviewLevel;
  /** 0..1 — combien le site dit de lui-même. Pas une probabilité. */
  confidence: number;
  /** Les faits lus, pour l'analyse de parcours. */
  facts: PageFacts[];
  pageText: string;
}

export function emptyIdentity(): BusinessIdentity {
  return {
    name: null,
    legalName: null,
    addressLine: null,
    postalCode: null,
    city: null,
    department: null,
    registryId: null,
    phone: null,
    email: null,
    instagramHandle: null,
    facebookUrl: null,
    nicheTermsFound: [],
    declarations: [],
    review: 'uncertain',
    confidence: 0,
    facts: [],
    pageText: '',
  };
}

/**
 * Lit ce qu'un site déclare de lui-même.
 *
 * Pure : la sonde réseau a déjà eu lieu, tout ce qui suit se rejoue dans un
 * test à partir d'un HTML. C'est ce qui permet de couvrir les cas qui comptent
 * — un site muet, un site qui publie son SIREN, un site de chaîne — sans
 * dépendre d'un serveur distant qui aura changé demain.
 */
export function readSiteIdentity(probe: DomainProbe, niche: NicheConfig): BusinessIdentity {
  const identity = emptyIdentity();

  const homeHtml = probe.html ?? '';
  const legalHtml = probe.legalHtml ?? '';
  if (!homeHtml && !legalHtml) {
    identity.declarations.push('aucune page lisible : le site n’a rien déclaré');
    return identity;
  }

  const homeUrl = probe.finalUrl ?? `https://${probe.domain}/`;
  const facts: PageFacts[] = [];
  if (homeHtml) facts.push(extractPageFacts(homeHtml, homeUrl));
  if (legalHtml) facts.push(extractPageFacts(legalHtml, probe.legalPageUrl ?? homeUrl));
  identity.facts = facts;

  const pageText = stripTags(`${homeHtml}\n${legalHtml}`);
  identity.pageText = pageText;

  const mentions = legalHtml
    ? extractLegalMentions(legalHtml, probe.legalPageUrl ?? homeUrl)
    : extractLegalMentions(homeHtml, homeUrl);
  const usableMentions = hasUsableMentions(mentions) ? mentions : null;

  const registryIds = collectRegistryIds(`${homeHtml}\n${legalHtml}`);
  const siren = normalizeRegistryId(usableMentions?.siren ?? registryIds.sirens[0] ?? null);
  const siret = registryIds.sirets[0] ?? null;

  const declaredName = facts[0]
    ? siteDeclaredName([{ field: 'website_title', valueText: facts[0].title }], probe.domain)
    : null;

  identity.legalName = cleanBusinessName(usableMentions?.legalName ?? null);
  identity.name = identity.legalName ?? cleanBusinessName(declaredName);
  identity.addressLine = usableMentions?.addressLine ?? null;
  identity.postalCode = usableMentions?.postalCode ?? null;
  identity.city = plausibleCity(usableMentions?.city ?? usableMentions?.rcsCity ?? null);
  identity.department = departmentFromPostcode(identity.postalCode);
  identity.registryId = siren;

  identity.phone = firstOf(facts.flatMap((page) => page.phones), normalizePhone);
  identity.email = firstOf(facts.flatMap((page) => page.emails), normalizeEmail);
  identity.instagramHandle = firstOf(facts.flatMap((page) => page.instagram), normalizeInstagramHandle);
  identity.facebookUrl = firstOf(
    facts.flatMap((page) => page.facebook.map((slug) => `https://www.facebook.com/${slug}`)),
    normalizeFacebookUrl,
  );

  identity.nicheTermsFound = matchVocabulary(pageText, [
    ...niche.positiveTerms,
    ...niche.serviceTerms,
  ]);

  // --------------------------------------------------------------- verdict
  const declarations: string[] = [];
  let confidence = 0;

  if (siren) {
    confidence += 0.5;
    declarations.push(`identité légale publiée : SIREN ${siren}`);
  } else if (siret) {
    confidence += 0.5;
    declarations.push(`identité légale publiée : SIRET ${siret}`);
  }
  if (identity.legalName) {
    confidence += 0.2;
    declarations.push(`raison sociale déclarée en mentions légales : « ${identity.legalName} »`);
  } else if (declaredName) {
    confidence += 0.1;
    declarations.push(`nom déclaré par le site : « ${declaredName} »`);
  }
  if (identity.postalCode && identity.city) {
    confidence += 0.2;
    declarations.push(`adresse déclarée : ${identity.postalCode} ${identity.city}`);
  } else if (identity.city) {
    confidence += 0.1;
    declarations.push(`ville déclarée : ${identity.city}`);
  }
  if (identity.phone) {
    confidence += 0.1;
    declarations.push('téléphone publié');
  }
  if (identity.nicheTermsFound.length >= 2) {
    confidence += 0.1;
    declarations.push(`vocabulaire du métier présent (${identity.nicheTermsFound.slice(0, 3).join(', ')})`);
  }

  if (declarations.length === 0) {
    declarations.push('le site ne déclare ni nom, ni adresse, ni identité légale');
  }

  identity.declarations = declarations;
  identity.confidence = Math.max(0, Math.min(1, confidence));

  /**
   * Trois verdicts, et un seul se passe d'un humain.
   *
   * `confirmed` exige une identité légale publiée — la seule déclaration qu'un
   * tiers peut contredire. Un nom et une ville en mentions légales ne suffisent
   * pas : n'importe qui les écrit, et le §7 demande le conservatisme sur le
   * nom générique. Un nom peu distinctif (« Demo Papa ») retombe d'ailleurs en
   * revue manuelle même bien renseigné, parce que c'est exactement le cas où
   * deux entreprises réelles se confondent.
   */
  const distinctive = identity.name ? nameIsDistinctive(identity.name) : false;
  if (siren || siret) {
    identity.review = 'confirmed';
  } else if (identity.name && (identity.city || identity.phone) && distinctive) {
    identity.review = 'manual_review';
  } else {
    identity.review = 'uncertain';
  }

  return identity;
}

/**
 * L'entreprise est-elle dans une des zones de la campagne ?
 *
 * Le test porte sur ce que le site écrit, pas sur ce qu'un moteur a supposé :
 * une requête « atelier Lyon » remonte régulièrement des entreprises de
 * Villeurbanne, de Saint-Étienne ou de Paris qui se référencent sur « Lyon ».
 * Les garder sans le dire ferait passer une couverture nationale pour un
 * pilote sur trois agglomérations.
 *
 * Rend `null` — et non `false` — quand le site ne déclare aucun lieu : nous ne
 * savons pas, et un `false` serait une affirmation d'absence.
 */
export function zoneMatch(identity: BusinessIdentity, zones: readonly string[]): boolean | null {
  const declaredCity = normalizeCity(identity.city);
  const haystack = stripAccents(identity.pageText).toLowerCase();

  if (!declaredCity && haystack.length === 0) return null;

  for (const zone of zones) {
    const normalizedZone = normalizeCity(zone);
    if (!normalizedZone) continue;
    if (declaredCity && declaredCity.includes(normalizedZone)) return true;
    // La ville peut n'apparaître que dans le corps de la page (« intervention
    // sur Lyon et sa région »), ce qui reste une déclaration du site.
    if (haystack.includes(normalizedZone)) return true;
  }

  return declaredCity ? false : null;
}

/**
 * Le dernier filtre avant qu'un nom ne devienne le nom d'un prospect.
 *
 * Il existe parce qu'un nom d'entreprise, dans ce projet, ne reste pas dans la
 * base : il est écrit tel quel dans un brouillon de message. Le premier pilote
 * R5 a produit, entre autres, « Nett auto &#8211; L'exigence du détail, »,
 * « \n \n Demo Lima 74 \n \n » et « La personne, physique ou morale, qui
 * édite le site… ». Les trois sont passés par l'extraction sans qu'aucune ne
 * soit fausse au sens strict — c'est bien ce que la page contenait.
 *
 * Ce module tranche donc autrement : **est-ce que cela ressemble au nom d'une
 * entreprise ?** Quand la réponse est non, on rend `null` et l'appelant retombe
 * sur la source suivante, jusqu'au nom provisoire tiré du domaine. Un nom
 * approximatif se corrige à la relecture ; une phrase entière présentée comme
 * une raison sociale décrédibilise le message qui la porte.
 */
export function cleanBusinessName(value: string | null): string | null {
  if (!value) return null;

  const decoded = stripTags(
    value
      /**
       * Les séquences d'échappement écrites en toutes lettres.
       *
       * Certains CMS rendent un JSON dans le HTML, si bien que la page contient
       * les deux caractères `\` et `n` et non un retour à la ligne. `stripTags`
       * n'y voit que du texte, et le pilote a produit « \n \n Demo Lima 74 \n \n »
       * comme raison sociale. Elles sont traitées avant tout le reste, sans quoi
       * l'élagage de la ponctuation de bord ne laisse qu'un « n » orphelin.
       */
      .replace(/\\[nrt]/g, ' '),
  )
    .replace(/^[\s\p{P}]+/u, '')
    .replace(/[\s,;:.–—-]+$/u, '')
    .trim();
  if (decoded.length < 2 || decoded.length > 70) return null;

  const withoutLabels = dropTrailingLetterFragments(dropTrailingLabelWords(decoded).trim());
  if (withoutLabels.length < 2) return null;

  const words = withoutLabels.split(/\s+/);
  // Au-delà de huit mots, ce n'est plus une enseigne : c'est une accroche ou
  // une phrase de mentions légales.
  if (words.length > 8) return null;

  // Une phrase se reconnaît à sa construction, pas à sa longueur : un pronom
  // relatif, un verbe conjugué, une adresse au lecteur. Une enseigne n'en a
  // aucun.
  if (/\b(qui|que|dont|lequel|laquelle)\b/i.test(withoutLabels)) return null;
  if (/\b(est|sont|edite|édite|publie|propose|vous|nous|votre|notre)\b/i.test(withoutLabels)) return null;
  /**
   * L'impératif commercial — « Soyez accompagné dans votre projet », que le
   * pilote a promu au rang de raison sociale. C'est une accroche de bandeau,
   * et aucune enseigne ne commence par un verbe à la deuxième personne.
   */
  if (
    /^(soyez|decouvrez|découvrez|contactez|profitez|faites|obtenez|demandez|reservez|réservez|beneficiez|bénéficiez|choisissez|confiez|offrez|laissez|venez|appelez|trouvez|essayez)\b/i.test(
      withoutLabels,
    )
  ) {
    return null;
  }
  // Une promesse tarifaire est un argument de vente, pas un nom.
  if (/(à partir de|a partir de|\bdès\b|\bdes\s+\d|€|\beuros?\b)/i.test(withoutLabels)) return null;

  // Un nom qui commence par un article ou une préposition est presque toujours
  // le début d'une phrase capturée trop tôt.
  if (/^(la|le|les|l'|un|une|des|du|de|au|aux|ce|cette|en|pour|par|sur)\b/i.test(withoutLabels)) {
    return null;
  }

  return withoutLabels;
}

/**
 * Retire les lettres isolées restées en fin de nom.
 *
 * « SARL RPA D », « SASU DEMONOVEMBER A » : une capture coupée juste avant l'étiquette
 * suivante emporte parfois son initiale (« … D. Adresse : », « … A pour objet »).
 * Aucune raison sociale française ne se termine par une lettre isolée après sa
 * forme juridique, et la garder rend le nom légèrement faux — donc suspect à la
 * lecture, ce qui est le pire état pour un nom qui va dans un message.
 *
 * Un nom d'un seul mot est laissé intact : « Wash » est peut-être maigre, mais
 * c'est ce que l'entreprise se donne.
 */
function dropTrailingLetterFragments(value: string): string {
  const words = value.split(/\s+/).filter((word) => word.length > 0);
  while (words.length > 2 && /^[a-zA-ZÀ-ÿ]$/.test(words[words.length - 1] ?? '')) words.pop();
  return words.join(' ');
}

/**
 * Mots qu'une extraction de mentions légales rend parfois comme une commune,
 * et qui n'en sont pas.
 *
 * Le pilote R5 a produit le cas et sa conséquence : une page annonçant
 * « Créateur du site : … » a fait lire « Créateur » comme ville, ce qui a
 * ensuite fait **rejeter l'entreprise comme hors zone**. Une extraction ratée
 * qui reste nulle coûte une information ; la même extraction ratée prise pour
 * une contradiction coûte un prospect.
 *
 * D'où l'asymétrie appliquée ici : un lieu non reconnaissable redevient
 * « inconnu », jamais « ailleurs ».
 */
const NON_CITY_WORDS = new Set([
  'createur', 'crateur', 'editeur', 'hebergeur', 'directeur', 'directrice',
  'responsable', 'proprietaire', 'societe', 'entreprise', 'adresse', 'siege',
  'mentions', 'legales', 'site', 'web', 'internet', 'contact', 'telephone',
  'numero', 'capital', 'france', 'sarl', 'sas', 'sasu', 'eurl',
]);

export function plausibleCity(value: string | null): string | null {
  const raw = (value ?? '').trim();
  if (raw.length < 3) return null;
  if (/\d/.test(raw)) return null;
  const normalized = stripAccents(raw).toLowerCase().replace(/[^a-z ]/g, '').trim();
  if (!normalized) return null;
  // Une commune peut être composée (« Saint-Étienne », « Aix en Provence ») ;
  // il suffit qu'aucun de ses mots ne soit un mot d'étiquette.
  const words = normalized.split(/\s+/);
  if (words.some((word) => NON_CITY_WORDS.has(word))) return null;
  return raw;
}

function firstOf<T>(values: readonly string[], normalize: (value: string) => T | null): T | null {
  for (const value of values) {
    const normalized = normalize(value);
    if (normalized) return normalized;
  }
  return null;
}
