import { stripAccents } from '@/lib/identity/normalize';
import type { IcpProfile, IcpSeverity } from '@/lib/config/schema';

/**
 * ICP-R1 §2 — le gate d'éligibilité commerciale.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi ce module existe : la question que personne ne posait
 * ---------------------------------------------------------------------------
 * Le pipeline savait répondre à quatre questions avant d'écrire à quelqu'un :
 * quel métier (`classify`), joignable par quel canal (`resolveTransportOptions`),
 * qui est-ce exactement (`resolveIdentityAudit`), le message est-il sourcé
 * (`guardrails`). Aucune ne demandait **quel TYPE d'entreprise** — et c'est
 * exactement là que `DEMO PROSPECT A` est passé.
 *
 * Son site portait « Devenez franchisé DetailCar » en titre de section, et deux
 * autres pages parlaient de « la franchise DetailCar ». Le mot « franchise »
 * était même déjà dans `negativeTerms` de la niche atelier. Il n'a rien
 * bloqué, et le classificateur a eu raison de passer outre — sa réponse est
 * archivée mot pour mot :
 *
 *   « La mention d'une franchise décrit un mode de développement commercial et
 *     ne remet pas en cause la nature des services proposés. »
 *
 * C'est vrai. Une franchise de prestation standard fait bien du prestation standard. Le
 * défaut n'était pas le verdict, c'était la QUESTION : un disqualifiant de
 * modèle d'entreprise avait été rangé dans un vocabulaire de métier, où il ne
 * pouvait s'exprimer que sous une forme fausse.
 *
 * ---------------------------------------------------------------------------
 * Trois propriétés, chacune écrite contre une façon précise d'échouer
 * ---------------------------------------------------------------------------
 *
 * 1. **Le score n'entre pas ici.** `evaluateIcpEligibility` ne reçoit ni
 *    `score`, ni `band`, ni `niche_confidence` — pas « les ignore » : ne peut
 *    pas les lire. La mission demande qu'un signal de franchise ne soit jamais
 *    noyé par un score élevé ; la seule garantie qui tienne est qu'il n'y ait
 *    rien à noyer. C'est d'autant plus nécessaire que le score est ANTI-corrélé
 *    à l'éligibilité sur ce cas précis : une tête de réseau a un meilleur site,
 *    de meilleurs CTA et des tarifs plus lisibles qu'un artisan — elle marque
 *    donc plus haut sur les signaux mêmes qui devaient la recommander.
 *
 * 2. **La décision ne repose pas que sur des mots-clés.** Trois familles de
 *    preuves y concourent : lexicale (ce que la page dit), structurelle (ce que
 *    deux identités disent l'une de l'autre — un handle national face à une
 *    adresse locale, des zones de découverte face à une ville déclarée), et la
 *    DIVERSITÉ DE SOURCE (deux occurrences d'une même page ne valent pas deux
 *    preuves). Un `NOT_TARGET` exige soit un acte de parole non ambigu — une
 *    page qui recrute des franchisés — soit une corroboration par deux sources
 *    indépendantes.
 *
 * 3. **L'absence de preuve n'est pas une preuve.** Un prospect dont le site n'a
 *    jamais été lu ne devient pas « franchise » ; il devient `REVIEW_REQUIRED`
 *    avec une raison qui le dit — « rien n'a été lu » — et jamais `NOT_TARGET`.
 *    C'est la règle n°2 de CLAUDE.md appliquée à un gate : on ne conclut pas
 *    d'un silence.
 *
 * Ce module est pur : aucune I/O, aucune horloge, aucun LLM. Il reçoit ce qui a
 * été observé et rend un verdict que l'on peut contester ligne par ligne.
 */

// ---------------------------------------------------------------------------
// Vocabulaire
// ---------------------------------------------------------------------------

/**
 * Les trois verdicts. `REVIEW_REQUIRED` n'est pas un demi-refus : c'est le
 * verdict de l'incertitude honnête, et c'est le seul qui puisse être levé par
 * un humain qui regarde. Il vaut aussi bien pour « un signal fort isolé » que
 * pour « nous n'avons rien lu » — deux situations différentes, que `reason`
 * distingue en toutes lettres.
 */
export type IcpVerdict = 'GOOD_ICP' | 'REVIEW_REQUIRED' | 'NOT_TARGET';

/** Ce qui a pu être LU, et jusqu'où. Un `GOOD_ICP` sans lecture n'existe pas. */
export type IcpCoverage = 'none' | 'read';

export interface IcpEvidenceLike {
  readonly id: string;
  readonly field: string;
  readonly valueText: string | null;
  readonly valueJson?: unknown;
  readonly provider: string;
  readonly sourceUrl: string | null;
}

/** L'entité telle que la base la connaît. Volontairement sans score ni bande. */
export interface IcpSubject {
  readonly displayName: string;
  readonly brandName?: string | null;
  readonly legalName?: string | null;
  readonly city?: string | null;
  /** Département déclaré (FR). Sert à comparer une adresse à une zone de découverte. */
  readonly department?: string | null;
  /**
   * Domaine du site. C'est une IDENTITÉ à part entière, et l'oublier coûte
   * cher : `SARL RPA` exploite `demo-10.example.com` et le compte
   * `sublime_auto_mobile`. Comparer le handle à la seule raison sociale
   * concluait à une usurpation là où il n'y a qu'une enseigne commerciale
   * différente du nom juridique — cas le plus banal du registre français.
   */
  readonly domain?: string | null;
  readonly instagramHandle?: string | null;
}

/**
 * Un signal retenu, avec de quoi le contester : ce qui a été trouvé, où, dans
 * quel champ, sous quel identifiant de preuve. Un verdict dont on ne peut pas
 * remonter à la ligne d'evidence n'est pas auditable.
 */
export interface IcpSignal {
  readonly groupKey: string;
  readonly severity: IcpSeverity;
  readonly label: string;
  /** `lexical` : la page le dit. `structural` : deux identités se contredisent. */
  readonly kind: 'lexical' | 'structural';
  /** La phrase trouvée, ou le fait structurel constaté. */
  readonly matched: string;
  /** Extrait borné, tel qu'un humain le relirait. */
  readonly excerpt: string;
  readonly field: string;
  /** `null` pour un signal structurel dérivé des colonnes du prospect. */
  readonly evidenceId: string | null;
  readonly provider: string;
  readonly sourceUrl: string | null;
}

export interface IcpAssessment {
  readonly verdict: IcpVerdict;
  /** Une phrase, celle qu'un opérateur lit dans le tableau de revue. */
  readonly reason: string;
  /** Tous les motifs retenus, pour que le verdict soit contestable point par point. */
  readonly reasons: readonly string[];
  readonly signals: readonly IcpSignal[];
  /** Identifiants `prospect_evidence` cités, dédupliqués — la provenance du verdict. */
  readonly evidenceIds: readonly string[];
  readonly coverage: IcpCoverage;
  /** Nombre de sources distinctes portant un signal fort. */
  readonly strongSourceCount: number;
  readonly profileKey: string;
  readonly profileVersion: number;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Réduit un texte à une suite de mots séparés par une espace, encadrée
 * d'espaces.
 *
 * L'encadrement n'est pas cosmétique : il donne la sémantique de frontière de
 * mot à un simple `includes`, sans expression régulière construite à la volée.
 * « franchise » ne peut donc pas être trouvé dans « affranchissement », et
 * « reseau » ne peut pas l'être dans « reseaux ». C'est exactement le défaut du
 * `text.includes(term)` de `classify.ts`, qui compare en sous-chaîne.
 */
function normalizeForMatch(raw: string): string {
  const flattened = stripAccents(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return flattened.length === 0 ? '' : ` ${flattened} `;
}

/** Rend le texte lisible d'une valeur d'evidence, quelle que soit sa forme de stockage. */
function readableValue(evidence: IcpEvidenceLike): string {
  if (evidence.valueText !== null && evidence.valueText.length > 0) return evidence.valueText;
  return jsonToText(evidence.valueJson);
}

/**
 * Aplatit une valeur JSON en texte lisible.
 *
 * Ce détour existe pour une raison précise : `website_headings` — le champ qui
 * portait « Devenez franchisé DetailCar » — est stocké UNIQUEMENT en
 * `value_json`. Un gate qui ne lirait que `value_text` reproduirait à
 * l'identique l'angle mort qui a laissé passer le cas.
 */
function jsonToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(jsonToText).join(' · ');
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `${key}: ${jsonToText(entry)}`)
      .join(' · ');
  }
  return '';
}

/** Extrait borné autour de la phrase trouvée, pour que l'humain voie le contexte. */
function excerptAround(raw: string, phrase: string): string {
  const haystack = stripAccents(raw).toLowerCase();
  const needle = stripAccents(phrase).toLowerCase().replace(/\s+/g, ' ');
  // La recherche se fait sur le texte brut « aplati » ; si la phrase normalisée
  // ne s'y retrouve pas telle quelle (ponctuation intercalée), on rend le début
  // du texte plutôt qu'un extrait faux.
  const at = haystack.indexOf(needle.split(' ')[0] ?? needle);
  const start = at < 0 ? 0 : Math.max(0, at - 60);
  return `${start > 0 ? '…' : ''}${raw.slice(start, start + 200).replace(/\s+/g, ' ').trim()}${
    raw.length > start + 200 ? '…' : ''
  }`;
}

// ---------------------------------------------------------------------------
// Signaux lexicaux
// ---------------------------------------------------------------------------

/**
 * Champs dont le contenu décrit ce que l'entreprise DIT d'elle-même.
 *
 * `website_headings` y figure en premier, et c'est le correctif central de
 * cette mission : le titre de section est l'endroit où une tête de réseau
 * annonce son recrutement, et c'était le seul champ que ni `classify.ts` (liste
 * blanche de champs) ni `loadDispatchContext` (colonne `value_json` non
 * sélectionnée) ne regardaient.
 */
const NARRATIVE_FIELDS: readonly string[] = [
  'website_headings',
  'website_title',
  'website_description',
  'website_text',
  'site_identity_declarations',
  'services',
  'cta',
  'funnel_synthesis',
  'osm_category',
];

function isNarrative(field: string): boolean {
  return NARRATIVE_FIELDS.includes(field);
}

function scanLexical(evidence: readonly IcpEvidenceLike[], profile: IcpProfile): IcpSignal[] {
  const exclusions = profile.exclusions.map(normalizeForMatch).filter((value) => value.length > 0);
  const signals: IcpSignal[] = [];

  for (const row of evidence) {
    if (!isNarrative(row.field)) continue;
    const raw = readableValue(row);
    if (raw.trim().length === 0) continue;

    let text = normalizeForMatch(raw);
    if (text.length === 0) continue;

    // Les contextes neutralisants sont RETIRÉS avant toute recherche : « réseaux
    // sociaux » ne doit pas faire exister un « réseau », et le retrait local
    // n'empêche pas de trouver un vrai signal ailleurs dans la même page.
    for (const exclusion of exclusions) {
      if (exclusion.length > 2) text = text.split(exclusion.trim()).join(' ');
    }

    for (const group of profile.signalGroups) {
      for (const phrase of group.phrases) {
        const needle = normalizeForMatch(phrase);
        if (needle.length === 0 || !text.includes(needle)) continue;
        signals.push({
          groupKey: group.key,
          severity: group.severity,
          label: group.label,
          kind: 'lexical',
          matched: phrase,
          excerpt: excerptAround(raw, phrase),
          field: row.field,
          evidenceId: row.id,
          provider: row.provider,
          sourceUrl: row.sourceUrl,
        });
        // Une phrase par groupe et par ligne d'evidence suffit : compter dix
        // fois « franchise » sur la même page ne fabrique pas dix preuves.
        break;
      }
    }
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Signaux structurels
// ---------------------------------------------------------------------------

export function tokensOf(value: string | null | undefined): string[] {
  if (!value) return [];
  return normalizeForMatch(value)
    .trim()
    .split(' ')
    .filter((token) => token.length >= 4);
}

/**
 * L'identité sociale revendique-t-elle une portée que l'entité découverte n'a
 * pas ?
 *
 * `demo_prospect_a` face à une entreprise déclarée à Aubagne : le handle parle
 * au nom d'une marque nationale, la fiche décrit un établissement local. Ce
 * n'est pas un mot-clé sur une page — c'est une contradiction entre deux
 * identités, et c'est précisément le « identité sociale incompatible avec
 * l'entreprise locale découverte » que la mission demande de traiter.
 */
function scanHandleScope(subject: IcpSubject, profile: IcpProfile): IcpSignal[] {
  const handle = subject.instagramHandle;
  if (!handle || handle.trim().length === 0) return [];
  const normalizedHandle = normalizeForMatch(handle);
  const signals: IcpSignal[] = [];

  const marker = profile.nationalScopeHandleMarkers.find((candidate) => {
    const needle = stripAccents(candidate).toLowerCase();
    // Le handle est un mot collé : ici la sous-chaîne est le bon test, parce
    // qu'« demo_prospect_a » ne sépare pas ses composants.
    return needle.length >= 4 && normalizedHandle.includes(needle);
  });
  if (marker !== undefined && subject.city && subject.city.trim().length > 0) {
    signals.push({
      groupKey: 'social_identity_scope',
      severity: 'STRONG',
      label: 'identité sociale de portée nationale face à une entité locale',
      kind: 'structural',
      matched: marker,
      excerpt: `handle « ${handle} » porte le marqueur « ${marker} » alors que la fiche déclare une adresse locale (${subject.city}) — le compte parle au nom d'une marque, pas d'un établissement`,
      field: 'instagram_handle',
      evidenceId: null,
      provider: 'derived',
      sourceUrl: null,
    });
  }

  // Un handle qui ne partage aucun mot avec AUCUNE des identités connues peut
  // appartenir à quelqu'un d'autre : homonymie, compte de réseau, ou simple
  // erreur d'association. Jamais tranché ici — signalé pour revue.
  //
  // Le domaine compte comme une identité, au même titre que le nom. Sans lui,
  // toute entreprise dont l'enseigne diffère de la raison sociale — le cas le
  // plus ordinaire du registre français — serait signalée à tort.
  const nameTokens = new Set([
    ...tokensOf(subject.displayName),
    ...tokensOf(subject.brandName),
    ...tokensOf(subject.legalName),
    ...tokensOf(subject.domain?.replace(/\.[a-z]{2,}$/i, '') ?? null),
  ]);
  if (nameTokens.size > 0) {
    const shares = [...nameTokens].some((token) => normalizedHandle.includes(token));
    if (!shares) {
      signals.push({
        groupKey: 'social_identity_mismatch',
        severity: 'STRONG',
        label: 'handle sans rapport lexical avec le nom de l’entreprise',
        kind: 'structural',
        matched: handle,
        excerpt: `handle « ${handle} » ne partage aucun mot avec « ${subject.displayName} » — association à confirmer par un humain avant tout contact`,
        field: 'instagram_handle',
        evidenceId: null,
        provider: 'derived',
        sourceUrl: null,
      });
    }
  }

  return signals;
}

/**
 * Les segments d'un nom de domaine, extension retirée.
 *
 * `null` dès qu'il n'y en a qu'un : `example.com` est un mot collé, et
 * personne ne peut dire depuis le code s'il porte une marque, deux, ou aucune.
 * Refuser de trancher là est ce qui rend le signal suivant utilisable — un
 * découpage par « morceaux qui ressemblent à des mots » inventerait des marques
 * dans la moitié du corpus.
 */
function domainSegments(domain: string): string[] | null {
  const host = domain
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');
  const labels = host.split('.').filter((label) => label.length > 0);
  if (labels.length < 2) return null;
  const registrable = labels[labels.length - 2];
  if (registrable === undefined) return null;
  const segments = registrable.split(/[-_]+/).filter((segment) => segment.length > 0);
  return segments.length >= 2 ? segments : null;
}

/** En dessous, un segment de domaine ne porte pas assez de sens pour être jugé. */
const MINIMUM_DOMAIN_SEGMENT = 4;
/**
 * En dessous, un segment INEXPLIQUÉ reste muet.
 *
 * Le seuil est plus haut que le précédent, et volontairement : un segment court
 * est le plus souvent un prénom, une abréviation ou un mot de liaison. Se taire
 * sur `jean` et parler sur `totalenergies` est la seule asymétrie que ce signal
 * s'autorise.
 */
const MINIMUM_UNEXPLAINED_SEGMENT = 5;

/**
 * R7.3B §9 — le domaine nomme-t-il une marque que rien n'explique ?
 *
 * ---------------------------------------------------------------------------
 * Le cas, et ce qu'il apprend
 * ---------------------------------------------------------------------------
 * `wash-totalenergies.fr` déclarait s'appeler « Wash », et c'était vrai : la
 * moitié du domaine correspond exactement à l'identité observée. L'autre moitié
 * ne correspondait à RIEN — ni au nom déclaré, ni à la raison sociale, ni à la
 * ville, ni au métier. Un domaine qui accole le nom de l'entreprise à un second
 * nom que personne ne peut rattacher à elle affirme une RELATION : filiale,
 * enseigne, membre d'un réseau, marque exploitée sous licence. Laquelle des
 * quatre, ce module ne le dit pas — et c'est pour cela que le signal demande une
 * revue au lieu de rejeter seul.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi ce n'est pas une règle de marque déguisée
 * ---------------------------------------------------------------------------
 * Aucune marque n'est nommée nulle part, ni ici ni en configuration. La
 * condition est structurelle et tient en une phrase : au moins un segment
 * s'explique par l'identité de l'entreprise, au moins un autre ne s'explique
 * par rien. Un domaine mono-segment ne peut pas la remplir, un domaine
 * entièrement expliqué non plus, et un domaine dont AUCUN segment ne correspond
 * à l'identité non plus — ce dernier cas est le plus courant du registre
 * français (une enseigne différente de la raison sociale) et il est déjà traité,
 * ailleurs et autrement, par `scanHandleScope`.
 *
 * Les mots de métier et de lieu vivent dans `genericDomainTokens` : `prestation`,
 * `auto` ou `lyon` n'ont jamais désigné une marque, et sans cette liste tout
 * domaine composé deviendrait suspect.
 */
function scanDomainBrandRelationship(subject: IcpSubject, profile: IcpProfile): IcpSignal[] {
  const domain = subject.domain?.trim();
  if (!domain || domain.length === 0) return [];
  const segments = domainSegments(domain);
  if (segments === null) return [];

  const identityTokens = [
    ...new Set([
      ...tokensOf(subject.displayName),
      ...tokensOf(subject.brandName),
      ...tokensOf(subject.legalName),
      ...tokensOf(subject.city),
    ]),
  ];
  const generic = new Set(profile.genericDomainTokens.map((token) => stripAccents(token).toLowerCase().trim()));

  const explained: string[] = [];
  const unexplained: string[] = [];
  for (const segment of segments) {
    if (segment.length < MINIMUM_DOMAIN_SEGMENT) continue;
    // L'identité passe AVANT le vocabulaire générique : une entreprise qui
    // s'appelle « Wash » possède le mot `wash` de son domaine, même si le mot
    // est par ailleurs banal dans le métier.
    if (identityTokens.some((token) => token === segment || token.includes(segment) || segment.includes(token))) {
      explained.push(segment);
      continue;
    }
    if (generic.has(segment)) continue;
    if (segment.length >= MINIMUM_UNEXPLAINED_SEGMENT) unexplained.push(segment);
  }

  if (explained.length === 0 || unexplained.length === 0) return [];

  return [
    {
      groupKey: 'domain_brand_relationship',
      severity: 'STRONG',
      label: 'le domaine accole une marque que l’identité de l’entreprise n’explique pas',
      kind: 'structural',
      matched: unexplained.join(', '),
      excerpt:
        `le domaine « ${domain} » associe « ${explained.join(', ')} » — que l'identité observée explique — ` +
        `à « ${unexplained.join(', ')} », qui ne correspond ni au nom déclaré, ni à la raison sociale, ni à la ` +
        'ville, ni au vocabulaire du métier : un second nom dans un domaine affirme une relation de marque ' +
        '(filiale, enseigne, réseau, licence) qu’un humain doit trancher avant tout contact',
      field: 'domain',
      evidenceId: null,
      provider: 'derived',
      sourceUrl: null,
    },
  ];
}

/**
 * L'entreprise a-t-elle été trouvée là où elle n'est pas ?
 *
 * La découverte commerciale interroge « qui fait ce métier à Lyon ? ». Une
 * entreprise établie à Aubagne (13) qui sort en premier sur Lyon ET Dijon ne
 * répond pas à la question posée : elle est bien classée partout, ce qui est la
 * signature d'une marque nationale, pas d'un exploitant de quartier.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi la comparaison porte sur le DÉPARTEMENT, et non sur le nom de ville
 * ---------------------------------------------------------------------------
 * La première version comparait les chaînes, et le premier passage sur le
 * corpus réel l'a réfutée en six exemples : Corbas et Bron pour Lyon, Chenôve
 * pour Dijon, Meythet et Cran-Gevrier pour Annecy, Brindas pour Lyon. Toutes
 * étaient signalées « hors zone » alors qu'elles sont dans l'agglomération
 * interrogée — une comparaison de noms ne distingue pas une banlieue d'une
 * autre région.
 *
 * Le département tranche ce que le nom ne peut pas : Corbas est dans le 69
 * comme Lyon, Aubagne est dans le 13 quand on interrogeait le 69 et le 21.
 *
 * Et quand le département de la zone n'est pas connu, le signal ne disparaît
 * pas — il **s'affaiblit**. Dire « je ne sais pas si c'est une banlieue » n'est
 * pas dire « tout va bien » ; c'est exactement la raison d'être du niveau WEAK,
 * qui ne rejette jamais seul.
 *
 * ---------------------------------------------------------------------------
 * R7.3B — deux questions, et la première ne demande aucune adresse
 * ---------------------------------------------------------------------------
 * La v1 commençait par `if (city.length === 0) return []`, et c'est par là que
 * `wash-totalenergies.fr` est passé : trouvé **premier** en interrogeant Lyon,
 * Dijon ET Annecy, sans aucune adresse résolue, donc parfaitement muet.
 *
 * Or il y avait quelque chose à dire, et cela ne portait pas sur son adresse :
 * la DOMINATION du classement sur trois bassins séparés de centaines de
 * kilomètres est une propriété du site lui-même. Ce module distingue donc :
 *
 *   A — la PORTÉE. Combien de bassins distincts ce site domine-t-il ? Lisible
 *       sans aucune adresse, donc jamais réduite au silence par une identité non
 *       résolue. FAIBLE : un bon référencement régional existe aussi.
 *   B — la COHÉRENCE. La zone interrogée correspond-elle à l'adresse déclarée ?
 *       Exige une adresse, et reste la question de la v1, mot pour mot.
 *
 * B se contente désormais du DÉPARTEMENT quand la ville manque : c'est la seule
 * des deux colonnes qui décide, et exiger les deux privait le signal de la
 * moitié du corpus commercial (`city` y est souvent nul).
 */
function scanDiscoveryGeography(
  subject: IcpSubject,
  evidence: readonly IcpEvidenceLike[],
  profile: IcpProfile,
): IcpSignal[] {
  const city = normalizeForMatch(subject.city ?? '').trim();
  const department = (subject.department ?? '').trim();

  for (const row of evidence) {
    if (row.field !== 'provider_attributes') continue;
    const attributes = row.valueJson;
    if (attributes === null || typeof attributes !== 'object') continue;
    const commercial = (attributes as Record<string, unknown>)['commercialDiscovery'];
    if (commercial === null || typeof commercial !== 'object') continue;
    const zones = (commercial as Record<string, unknown>)['zones'];
    if (!Array.isArray(zones) || zones.length === 0) continue;

    const zoneNames = [
      ...new Set(zones.map((zone) => normalizeForMatch(String(zone)).trim()).filter((zone) => zone.length > 0)),
    ];
    if (zoneNames.length === 0) continue;

    const signals: IcpSignal[] = [];

    // — A — la portée, qui se lit sans adresse.
    if (zoneNames.length >= profile.thresholds.zonesForNationalReach) {
      signals.push({
        groupKey: 'discovery_multi_zone_reach',
        severity: 'WEAK',
        label: 'bien classée sur plusieurs bassins distincts',
        kind: 'structural',
        matched: zoneNames.join(', '),
        excerpt: `trouvée en interrogeant ${zoneNames.length} bassins distincts (${zoneNames.join(', ')}) — un exploitant local sort chez lui et éventuellement dans la commune voisine ; être trouvé sur autant de bassins décrit une marque référencée nationalement, indépendamment de toute adresse`,
        field: 'provider_attributes',
        evidenceId: row.id,
        provider: row.provider,
        sourceUrl: row.sourceUrl,
      });
    }

    // — B — la cohérence, qui en exige une.
    if (city.length === 0 && department.length === 0) return signals;

    // La ville déclarée EST une des zones interrogées : cohérent, rien à dire.
    if (city.length > 0 && zoneNames.some((zone) => zone === city || zone.includes(city) || city.includes(zone))) {
      return signals;
    }

    // Départements des zones, quand la configuration les connaît.
    const zoneDepartments = zoneNames
      .map((zone) => profile.zoneDepartments[zone])
      .filter((code): code is string => typeof code === 'string' && code.length > 0);

    const declared = city.length > 0 ? `${subject.city} (${department || 'département non résolu'})` : `département ${department}`;

    if (zoneDepartments.length === zoneNames.length && department.length > 0) {
      // Tout est connu des deux côtés : la comparaison est décisive.
      if (zoneDepartments.includes(department)) return signals;
      signals.push({
        groupKey: 'discovery_geo_incoherence',
        severity: 'STRONG',
        label: 'découverte hors du département déclaré',
        kind: 'structural',
        matched: `${zoneNames.join(', ')} (${zoneDepartments.join(', ')}) ≠ ${department}`,
        excerpt: `trouvée en interrogeant ${zoneNames.join(', ')} — département ${zoneDepartments.join(', ')} — alors que l'adresse déclarée est ${declared} : une entreprise bien classée hors de son département est une marque, pas un exploitant local`,
        field: 'provider_attributes',
        evidenceId: row.id,
        provider: row.provider,
        sourceUrl: row.sourceUrl,
      });
      return signals;
    }

    // La ville manque et les départements des zones ne sont pas tous connus :
    // il reste une incohérence possible, pas une incohérence constatée.
    if (city.length === 0) return signals;

    signals.push({
      groupKey: 'discovery_geo_incoherence',
      severity: 'WEAK',
      label: 'découverte hors de la zone déclarée, département non résolu',
      kind: 'structural',
      matched: zoneNames.join(', '),
      excerpt: `trouvée en interrogeant ${zoneNames.join(', ')} alors que l'adresse déclarée est ${subject.city} — impossible de dire ici s'il s'agit d'une commune de l'agglomération ou d'une autre région`,
      field: 'provider_attributes',
      evidenceId: row.id,
      provider: row.provider,
      sourceUrl: row.sourceUrl,
    });
    return signals;
  }

  return [];
}

// ---------------------------------------------------------------------------
// Décision
// ---------------------------------------------------------------------------

/**
 * Ce qui compte comme une SOURCE distincte : l'URL lue, ou à défaut le champ.
 *
 * Le choix du champ plutôt que du groupe de signaux est délibéré. Deux
 * observations tirées du même handle Instagram — « il revendique une portée
 * nationale » et « il ne ressemble pas au nom de l'entreprise » — parlent de la
 * même chose vue deux fois ; les compter comme deux corroborations
 * transformerait une seule question d'identité en rejet automatique, alors que
 * la mission demande précisément qu'une identité douteuse produise une REVUE.
 *
 * Deux pages différentes du même site, en revanche, sont deux sources : c'est
 * ce qui distingue « le mot apparaît quelque part » de « l'entreprise le dit
 * partout ».
 */
function sourceKeyOf(signal: IcpSignal): string {
  return signal.sourceUrl ?? signal.field;
}

export interface IcpEvaluationInput {
  readonly subject: IcpSubject;
  readonly evidence: readonly IcpEvidenceLike[];
  readonly profile: IcpProfile;
}

/**
 * Rend le verdict d'éligibilité.
 *
 * L'ordre des tests EST la règle, et chaque marche est écrite contre un mode
 * d'échec nommé :
 *
 *   1. un acte de recrutement de franchisés → `NOT_TARGET`. Ce n'est pas un
 *      mot, c'est une page qui dit ce qu'elle fait ;
 *   2. des signaux forts corroborés par plusieurs sources → `NOT_TARGET` ;
 *   3. un signal fort isolé → `REVIEW_REQUIRED`. La mission l'exige nommément :
 *      « au minimum REVIEW_REQUIRED » ;
 *   4. une accumulation de signaux faibles → `REVIEW_REQUIRED` ;
 *   5. rien de lu → `REVIEW_REQUIRED`, en disant que rien n'a été lu ;
 *   6. lu, et rien trouvé → `GOOD_ICP`.
 *
 * Aucune marche ne consulte le score. Il n'est pas dans la signature.
 */
export function evaluateIcpEligibility(input: IcpEvaluationInput): IcpAssessment {
  const { subject, evidence, profile } = input;

  const signals = [
    ...scanLexical(evidence, profile),
    ...scanHandleScope(subject, profile),
    ...scanDomainBrandRelationship(subject, profile),
    ...scanDiscoveryGeography(subject, evidence, profile),
  ];

  const evidenceIds = [...new Set(signals.map((signal) => signal.evidenceId).filter((id): id is string => id !== null))];
  const coverage: IcpCoverage = evidence.some((row) => isNarrative(row.field) && readableValue(row).trim().length > 0)
    ? 'read'
    : 'none';

  const disqualifying = signals.filter((signal) => signal.severity === 'DISQUALIFYING');
  const strong = signals.filter((signal) => signal.severity === 'STRONG');
  const weak = signals.filter((signal) => signal.severity === 'WEAK');
  const strongSources = new Set(strong.map(sourceKeyOf));
  const weakGroups = new Set(weak.map((signal) => signal.groupKey + '|' + sourceKeyOf(signal)));

  const describe = (signal: IcpSignal): string =>
    `${signal.label} — « ${signal.matched} » (${signal.field}${signal.sourceUrl ? `, ${signal.sourceUrl}` : ''})`;

  const frozen = (verdict: IcpVerdict, reasons: string[]): IcpAssessment =>
    Object.freeze({
      verdict,
      reason: reasons[0] ?? 'aucun motif',
      reasons: Object.freeze([...reasons]),
      signals: Object.freeze([...signals]),
      evidenceIds: Object.freeze([...evidenceIds]),
      coverage,
      strongSourceCount: strongSources.size,
      profileKey: profile.key,
      profileVersion: profile.version,
    });

  if (disqualifying.length > 0) {
    return frozen('NOT_TARGET', [
      `recrutement de franchisés constaté : ${describe(disqualifying[0]!)}`,
      ...disqualifying.slice(1).map(describe),
      ...strong.map(describe),
    ]);
  }

  if (strongSources.size >= profile.thresholds.strongSourcesForNotTarget) {
    return frozen('NOT_TARGET', [
      `${strong.length} signal(s) fort(s) corroboré(s) par ${strongSources.size} sources distinctes`,
      ...strong.map(describe),
    ]);
  }

  if (strong.length > 0) {
    return frozen('REVIEW_REQUIRED', [
      `signal fort isolé, à trancher par un humain : ${describe(strong[0]!)}`,
      ...strong.slice(1).map(describe),
      ...weak.map(describe),
    ]);
  }

  if (weakGroups.size >= profile.thresholds.weakSignalsForReview) {
    return frozen('REVIEW_REQUIRED', [
      `${weakGroups.size} marqueurs d'une organisation commerciale déjà structurée`,
      ...weak.map(describe),
    ]);
  }

  if (coverage === 'none') {
    return frozen('REVIEW_REQUIRED', [
      'aucun contenu d’entreprise n’a été lu — ni franchise ni indépendance constatée, ' +
        'et une absence de preuve n’est pas une preuve d’absence',
    ]);
  }

  return frozen('GOOD_ICP', [
    'contenu lu, aucun marqueur de franchise, de réseau, de multi-sites ni de portée nationale',
    ...weak.map(describe),
  ]);
}

/** Le refus opposé au verrouillage d'un manifeste, ou `null` si la voie est libre. */
export type IcpLockRefusal = 'icp_not_target' | 'icp_review_required';

/**
 * Ce verdict interdit-il de VERROUILLER un manifeste ?
 *
 * La réponse n'est pas « tout ce qui n'est pas GOOD_ICP », et la nuance porte
 * tout le raisonnement de cette mission :
 *
 *   * `NOT_TARGET` → refus. Évident.
 *   * `REVIEW_REQUIRED` **portant au moins un signal** → refus. C'est la leçon
 *     directe du cas : `identity_review = manual_review` existait sur DEMO PROSPECT A
 *     et n'a produit qu'une recommandation « edit », qu'un humain a écartée
 *     d'une phrase (« identité en manual_review MAIS score 74/A »). Un doute
 *     qui n'empêche rien est un doute qui sera contourné ; celui-ci bloque, et
 *     se lève par une décision humaine NOMMÉE et archivée.
 *   * `REVIEW_REQUIRED` **sans aucun signal** — c'est-à-dire « aucun contenu
 *     d'entreprise n'a été lu » → PAS de refus ici. Ce gate a un objet précis :
 *     distinguer un exploitant local d'une tête de réseau. Un prospect dont le
 *     site n'a jamais été ouvert ne peut porter aucun signal de franchise, donc
 *     le bloquer ici n'attraperait rien — et refuser sur un silence serait
 *     conclure d'une absence, ce que l'interdit n°2 de CLAUDE.md proscrit. Son
 *     verdict est tout de même journalisé et remonte dans l'audit ; les gardes
 *     qui traitent réellement ce cas (destinataire vérifié, parcours observé,
 *     identité) sont ailleurs et restent en vigueur.
 */
export function icpLockRefusal(assessment: IcpAssessment): IcpLockRefusal | null {
  if (assessment.verdict === 'NOT_TARGET') return 'icp_not_target';
  if (assessment.verdict === 'REVIEW_REQUIRED' && assessment.signals.length > 0) return 'icp_review_required';
  return null;
}

/** Les verdicts qui demandent un regard humain avant tout contact. */
export function needsHumanReview(verdict: IcpVerdict): boolean {
  return verdict !== 'GOOD_ICP';
}
