import { CHAIN_POSTAL_THRESHOLD, NAME_AGREEMENT_FLOOR, type IdentityVerdict } from '@/lib/discovery/openweb/identityVerify';
import { isDirectoryDomain, isPlatformDomain, isVendorHandle, normalizeDomain, normalizeEmail, normalizeInstagramHandle } from '@/lib/identity/normalize';

/**
 * R7.2B.1 — « ce domaine *probable* peut-il devenir le site de ce prospect ? »
 *
 * ---------------------------------------------------------------------------
 * Pourquoi une couche de plus, et pourquoi si mince
 * ---------------------------------------------------------------------------
 * Le vérificateur d'identité de R3 (`identityVerify.ts`) répond déjà à la
 * question « ce site appartient-il à ce prospect ? », de façon déterministe,
 * par règles énumérées, et il est testé. Le réécrire serait fabriquer un second
 * juge qui dirait presque la même chose presque toujours — la pire des
 * situations, parce que le jour où les deux divergent personne ne sait lequel a
 * raison.
 *
 * Ce module ne le remplace pas et **ne touche aucun de ses seuils**. Il fait
 * trois choses que R3 ne fait pas, et rien d'autre :
 *
 *   1. il traduit le verdict R3 dans le vocabulaire fermé de cette mission —
 *      `CONFIRMED` / `REJECTED` / `REVIEW_REQUIRED` — sans jamais promouvoir :
 *      seul un `confirmed` de R3, ou une preuve nommée que R3 ne calcule pas,
 *      produit un `CONFIRMED` ;
 *   2. il ajoute les deux preuves que R3 ne connaît pas parce que son rail ne
 *      les avait pas : le domaine de l'e-mail du prospect, et le lien croisé
 *      avec un compte Instagram déjà rattaché ;
 *   3. il refuse une chose que R3 laisse passer et qui est le vrai piège des 34
 *      candidats de R7.2 : **une fiche d'annuaire**. `societe.politologue.com`
 *      publie le SIREN de « CENTRE DE SERVICES DEMO ». R3 y verrait un
 *      `registry_id` concordant, donc un `confirmed`. Et il aurait raison sur
 *      les faits : cette page parle bien de cette entreprise. Elle ne lui
 *      appartient simplement pas. Une fiche qui cite votre SIREN prouve que la
 *      fiche parle de vous, jamais que le domaine est le vôtre.
 *
 * ---------------------------------------------------------------------------
 * Pas de score magique
 * ---------------------------------------------------------------------------
 * Aucune règle de ce fichier ne compare une confiance à un seuil. `confidence`
 * est rapportée parce qu'elle aide à trier une file de revue, jamais parce
 * qu'elle décide : la décision est toujours une combinaison de preuves portant
 * chacune un nom, et le rapport peut donc dire *laquelle* a emporté le verdict.
 *
 * Fonction pure, sans réseau, sans base : les mêmes preuves rejouées rendent le
 * même verdict, et chaque cas — annuaire, homonyme, SIREN contradictoire — se
 * reproduit dans un test.
 */

// ---------------------------------------------------------------------------
// Vocabulaire fermé
// ---------------------------------------------------------------------------
export type ProbableDomainDecision = 'CONFIRMED' | 'REJECTED' | 'REVIEW_REQUIRED';

/** Ce qui a été observé *pour* l'appartenance. Jamais une supposition. */
export type ProbableDomainProof =
  | 'LEGAL_ID_MATCH'
  | 'DOMAIN_REGISTRANT_MATCH'
  | 'PHONE_MATCH'
  | 'EMAIL_DOMAIN_MATCH'
  | 'SOCIAL_CROSS_LINK'
  | 'NAME_CITY_MATCH'
  | 'DISTINCTIVE_NAME_MATCH'
  | 'NICHE_VOCABULARY_PRESENT'
  | 'CROSS_CAMPAIGN_CORROBORATION';

/** Ce qui a été observé *contre*, ou l'absence qui empêche de conclure. */
export type ProbableDomainConflict =
  | 'NOT_A_BUSINESS_SITE'
  | 'SHARED_ACROSS_PROSPECTS'
  | 'LEGAL_ID_CONFLICT'
  | 'NAME_CONFLICT'
  | 'LOCATION_CONFLICT'
  | 'PHONE_CONFLICT'
  | 'SOCIAL_CONFLICT'
  | 'MULTI_ESTABLISHMENT_SITE'
  | 'AMBIGUOUS_IDENTITY'
  | 'SITE_UNREADABLE'
  | 'INSUFFICIENT_EVIDENCE';

/**
 * Les preuves qui suffisent, seules ou presque, à rattacher.
 *
 * Chacune relie le prospect au domaine par autre chose qu'une ressemblance de
 * nom. C'est la seule liste dont un `CONFIRMED` puisse sortir.
 */
export const DECISIVE_PROOFS: readonly ProbableDomainProof[] = [
  // L'ordre est celui de la force, et il sert : c'est la preuve la plus forte
  // qui est rapportée comme ayant emporté la décision, pas la première venue.
  'LEGAL_ID_MATCH',
  'DOMAIN_REGISTRANT_MATCH',
  'EMAIL_DOMAIN_MATCH',
  'PHONE_MATCH',
  'SOCIAL_CROSS_LINK',
  'CROSS_CAMPAIGN_CORROBORATION',
];

/** La preuve décisive la plus forte du faisceau, ou null s'il n'y en a aucune. */
export function strongestProof(proofs: readonly ProbableDomainProof[]): ProbableDomainProof | null {
  return DECISIVE_PROOFS.find((proof) => proofs.includes(proof)) ?? null;
}

/**
 * Contradictions devant lesquelles aucune preuve ne tient.
 *
 * Elles ne disent pas « le faisceau est faible », elles disent « la question
 * est mal posée » : ce domaine n'est pas le site d'une entreprise, ou il ne
 * peut pas être celui de *cette* entreprise-ci.
 */
export const DISQUALIFYING_CONFLICTS: ReadonlySet<ProbableDomainConflict> = new Set([
  'NOT_A_BUSINESS_SITE',
  'SHARED_ACROSS_PROSPECTS',
  'LEGAL_ID_CONFLICT',
]);

/**
 * Nombre d'identités légales distinctes publiées au-delà duquel une page cesse
 * d'être celle d'une entreprise.
 *
 * Deux se défend : une société peut publier la sienne et celle de son éditeur
 * ou de sa maison mère. Trois ne se défend plus — c'est un registre, et un
 * registre n'appartient à aucune des entreprises qu'il liste.
 */
export const LISTING_REGISTRY_ID_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Entrée
// ---------------------------------------------------------------------------
export interface ProbableDomainCase {
  prospectId: string;
  displayName: string;
  candidateDomain: string;
  /** Le verdict de R3, tel quel. Ses seuils ne sont ni relus ni rejoués ici. */
  verdict: IdentityVerdict;
  prospect: {
    email?: string | null;
    instagramHandle?: string | null;
  };
  /** Ce qui a été lu sur les pages du candidat. */
  observed: {
    emails?: string[];
    instagram?: string[];
    /** Toutes les identités légales valides publiées sur les pages lues. */
    registryIdsOnSite?: string[];
  };
  /** Faux quand aucune page n'a pu être lue : absence d'observation, pas preuve. */
  readable: boolean;
  /**
   * Combien d'AUTRES prospects du corpus se voient proposer ce même domaine.
   *
   * Le signal le plus honnête dont nous disposions, parce qu'il ne vient
   * d'aucune liste : si le même domaine est le meilleur candidat de quatre
   * entreprises différentes, il n'est le site d'aucune des quatre.
   */
  proposedForOtherProspects: number;
  /**
   * Corroboration inter-campagne, en LECTURE SEULE.
   *
   * Vrai lorsqu'un autre prospect portant le même identifiant de registre a
   * déjà ce domaine rattaché. C'est une preuve — la même entreprise, vue deux
   * fois. Ce n'est jamais une fusion : les deux lignes restent séparées, et
   * aucune contrainte de déduplication n'est touchée. Voir §5 de la mission.
   */
  crossCampaignSameRegistryId?: { prospectId: string; campaignSlug: string | null }[];
}

export interface ProbableDomainAdjudication {
  prospectId: string;
  displayName: string;
  candidateDomain: string;
  decision: ProbableDomainDecision;
  proofs: ProbableDomainProof[];
  conflicts: ProbableDomainConflict[];
  /** La preuve nommée qui a emporté un `CONFIRMED`, ou null. */
  decidedBy: ProbableDomainProof | null;
  /** Lecture de la force du faisceau (R3). Aide au tri, ne décide de rien. */
  confidence: number;
  /** Une phrase par observation, dans la langue du rapport. */
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Lecture des signaux R3
// ---------------------------------------------------------------------------
function hasSignal(verdict: IdentityVerdict, key: string): boolean {
  return verdict.signals.some((signal) => signal.key === key && signal.matched);
}

function signalDetail(verdict: IdentityVerdict, key: string): string | null {
  return verdict.signals.find((signal) => signal.key === key && signal.matched)?.detail ?? null;
}

/** Le nom concorde-t-il assez pour qu'une autre preuve vaille quelque chose ? */
export function nameAgrees(verdict: IdentityVerdict): boolean {
  return hasSignal(verdict, 'name') || hasSignal(verdict, 'name_strong') || hasSignal(verdict, 'name_on_page');
}

/** Les identifiants de registre distincts et valides lus sur les pages. */
export function distinctRegistryIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.replace(/\D/g, '').slice(0, 9)).filter((id) => id.length === 9))];
}

/**
 * Ce domaine sert-il une fiche plutôt qu'une entreprise ?
 *
 * Trois lectures indépendantes, et une seule suffit. Aucune ne repose sur le
 * contenu de la page prise isolément : un annuaire bien fait ressemble
 * exactement au site de l'entreprise dont il parle.
 */
export function looksLikeListing(input: {
  candidateDomain: string;
  registryIdsOnSite?: readonly string[];
  proposedForOtherProspects: number;
}): { conflict: ProbableDomainConflict | null; reason: string | null } {
  const domain = normalizeDomain(input.candidateDomain) ?? input.candidateDomain;

  if (isPlatformDomain(domain)) {
    return { conflict: 'NOT_A_BUSINESS_SITE', reason: `${domain} est une plateforme, pas le site d'une entreprise` };
  }
  if (isDirectoryDomain(domain)) {
    return {
      conflict: 'NOT_A_BUSINESS_SITE',
      reason: `${domain} est un annuaire : la fiche parle de l'entreprise, elle ne lui appartient pas`,
    };
  }
  if (input.proposedForOtherProspects > 0) {
    return {
      conflict: 'SHARED_ACROSS_PROSPECTS',
      reason:
        `${domain} est la meilleure réponse du résolveur pour ${input.proposedForOtherProspects} autre(s) ` +
        'entreprise(s) du corpus : un domaine ne peut pas être le site propre de plusieurs entreprises',
    };
  }
  const ids = distinctRegistryIds(input.registryIdsOnSite ?? []);
  if (ids.length >= LISTING_REGISTRY_ID_THRESHOLD) {
    return {
      conflict: 'NOT_A_BUSINESS_SITE',
      reason: `${ids.length} identités légales distinctes publiées sur les pages lues : c'est un registre, pas une entreprise`,
    };
  }
  return { conflict: null, reason: null };
}

// ---------------------------------------------------------------------------
// Adjudication d'un candidat
// ---------------------------------------------------------------------------
/**
 * Tranche l'appartenance d'un domaine probable.
 *
 * L'ordre des règles est l'argument : les disqualifications d'abord, parce
 * qu'aucune preuve ne survit à « ce n'est pas le site d'une entreprise » ;
 * puis les preuves nommées ; et seulement à la fin, pour ce qui reste, le
 * report vers un humain.
 */
export function adjudicateProbableDomain(input: ProbableDomainCase): ProbableDomainAdjudication {
  const proofs: ProbableDomainProof[] = [];
  const conflicts: ProbableDomainConflict[] = [];
  const reasons: string[] = [];
  const domain = normalizeDomain(input.candidateDomain) ?? input.candidateDomain;

  const base = {
    prospectId: input.prospectId,
    displayName: input.displayName,
    candidateDomain: domain,
    confidence: input.verdict.confidence,
  };

  // -------------------------------------------------------- disqualifications
  const listing = looksLikeListing({
    candidateDomain: domain,
    ...(input.observed.registryIdsOnSite ? { registryIdsOnSite: input.observed.registryIdsOnSite } : {}),
    proposedForOtherProspects: input.proposedForOtherProspects,
  });
  if (listing.conflict) {
    conflicts.push(listing.conflict);
    reasons.push(listing.reason ?? 'annuaire');
    return { ...base, decision: 'REJECTED', proofs, conflicts, decidedBy: null, reasons };
  }

  /**
   * R3 rejette sec quand le site publie une identité légale et qu'aucune n'est
   * celle du prospect. Le nom du conflit est repris tel quel plutôt que
   * redérivé : c'est le même fait, il ne doit pas pouvoir être compté deux fois
   * avec deux libellés différents.
   */
  const rejectReason = input.verdict.rejectReason;
  if (rejectReason?.includes('identité légale différente')) {
    conflicts.push('LEGAL_ID_CONFLICT');
    reasons.push(rejectReason);
    return { ...base, decision: 'REJECTED', proofs, conflicts, decidedBy: null, reasons };
  }

  // ---------------------------------------------------------------- conflits
  /**
   * Une localisation contradictoire l'est seulement si la nôtre est absente.
   *
   * Observé sur les 34 : sur trois « conflits de ville », deux n'étaient pas
   * des villes — les mentions légales avaient rendu « TVA intracommunautaire »
   * et « Le Châtelet-en-Brie Adresse du », deux artefacts d'extraction — et
   * dans les deux cas la vraie ville du prospect figurait par ailleurs sur la
   * page. Une adresse lue de travers ne doit pas valoir contradiction.
   *
   * La règle est donc « présente et différente », pas « différente » : quand
   * le site porte AUSSI la localisation du prospect, il énonce deux adresses,
   * ce qui est le cas ordinaire d'un siège et d'un atelier — pas un démenti.
   */
  const locationAlsoAgrees = hasSignal(input.verdict, 'city') || hasSignal(input.verdict, 'postal_code');
  if (hasSignal(input.verdict, 'city_conflict') && !locationAlsoAgrees) {
    conflicts.push('LOCATION_CONFLICT');
    reasons.push(signalDetail(input.verdict, 'city_conflict') ?? 'la localisation déclarée diffère');
  }
  if (hasSignal(input.verdict, 'phone_conflict')) {
    conflicts.push('PHONE_CONFLICT');
    reasons.push(signalDetail(input.verdict, 'phone_conflict') ?? 'le téléphone publié diffère');
  }
  if (hasSignal(input.verdict, 'multi_site')) {
    conflicts.push('MULTI_ESTABLISHMENT_SITE');
    reasons.push(signalDetail(input.verdict, 'multi_site') ?? 'plusieurs implantations sur le site');
  }

  const prospectHandle = normalizeInstagramHandle(input.prospect.instagramHandle ?? null);
  const siteHandles = [...new Set((input.observed.instagram ?? [])
    .map((value) => normalizeInstagramHandle(value))
    .filter((value): value is string => value !== null && !isVendorHandle(value)))];
  const socialCrossLink = Boolean(prospectHandle && siteHandles.includes(prospectHandle));
  if (socialCrossLink) {
    proofs.push('SOCIAL_CROSS_LINK');
    reasons.push(`le site lie lui-même le compte @${prospectHandle} déjà rattaché au prospect`);
  } else if (prospectHandle && siteHandles.length > 0) {
    /**
     * Le site affiche des comptes, et le compte connu du prospect n'en fait pas
     * partie. Ce n'est pas éliminatoire — un artisan peut tenir deux comptes —
     * mais cela interdit de conclure seul, et c'est exactement ce qu'un humain
     * sait trancher en trente secondes.
     */
    conflicts.push('SOCIAL_CONFLICT');
    reasons.push(`le site lie @${siteHandles.join(', @')}, pas le compte @${prospectHandle} du prospect`);
  }

  // ----------------------------------------------------------------- preuves
  if (hasSignal(input.verdict, 'registry_id')) {
    proofs.push('LEGAL_ID_MATCH');
    reasons.push(signalDetail(input.verdict, 'registry_id') ?? 'le site publie le SIREN du prospect');
  }
  if (hasSignal(input.verdict, 'rdap_registrant')) {
    proofs.push('DOMAIN_REGISTRANT_MATCH');
    reasons.push(signalDetail(input.verdict, 'rdap_registrant') ?? 'le registre attribue le domaine au prospect');
  }
  if (hasSignal(input.verdict, 'phone')) {
    proofs.push('PHONE_MATCH');
    reasons.push(signalDetail(input.verdict, 'phone') ?? 'le téléphone du prospect figure sur le site');
  }

  /**
   * L'e-mail du prospect est hébergé par le domaine testé.
   *
   * Preuve forte et bon marché, que R3 ne calcule pas : son rail découvrait le
   * domaine *avant* de connaître un e-mail. Ici l'ordre est inverse — l'e-mail
   * est déjà en base, observé ailleurs, et il désigne un domaine.
   */
  const prospectEmail = normalizeEmail(input.prospect.email ?? null);
  const emailHost = prospectEmail ? (prospectEmail.split('@')[1] ?? '').toLowerCase() : null;
  if (emailHost && (emailHost === domain || emailHost.endsWith(`.${domain}`))) {
    proofs.push('EMAIL_DOMAIN_MATCH');
    reasons.push(`l'e-mail connu du prospect (${prospectEmail}) est hébergé par ${domain}`);
  }

  const crossCampaign = input.crossCampaignSameRegistryId ?? [];
  if (crossCampaign.length > 0) {
    proofs.push('CROSS_CAMPAIGN_CORROBORATION');
    reasons.push(
      `même identifiant de registre qu'un prospect portant déjà ce domaine ` +
        `(${crossCampaign.map((row) => row.campaignSlug ?? row.prospectId).join(', ')}) — corroboration, pas fusion`,
    );
  }

  if (hasSignal(input.verdict, 'name_strong')) {
    proofs.push('DISTINCTIVE_NAME_MATCH');
    reasons.push(signalDetail(input.verdict, 'name_strong') ?? 'le nom concorde fortement');
  } else if (hasSignal(input.verdict, 'name')) {
    reasons.push(signalDetail(input.verdict, 'name') ?? 'le nom concorde');
  } else {
    conflicts.push('NAME_CONFLICT');
    reasons.push(input.verdict.signals.find((s) => s.key === 'name')?.detail ?? 'accord de nom insuffisant');
  }

  if (hasSignal(input.verdict, 'city') || hasSignal(input.verdict, 'postal_code')) {
    proofs.push('NAME_CITY_MATCH');
    reasons.push(signalDetail(input.verdict, 'city') ?? signalDetail(input.verdict, 'postal_code') ?? 'localisation concordante');
  }
  if (hasSignal(input.verdict, 'niche_vocabulary')) {
    proofs.push('NICHE_VOCABULARY_PRESENT');
    reasons.push(signalDetail(input.verdict, 'niche_vocabulary') ?? 'vocabulaire du métier présent');
  }

  if (!input.readable) {
    conflicts.push('SITE_UNREADABLE');
    reasons.push('aucune page lisible : rien n’a pu être vérifié — absence d’observation, pas absence constatée');
  }

  // ---------------------------------------------------------------- décision
  /**
   * Les règles, énumérées. Un `CONFIRMED` ne sort jamais d'un total : il sort
   * d'une preuve nommée qui relie le prospect au domaine autrement que par une
   * ressemblance de nom, ou — dernier cas — d'un faisceau que R3 a lui-même
   * jugé concluant, ce qui suppose déjà une telle preuve chez lui.
   */
  const has = (conflict: ProbableDomainConflict): boolean => conflicts.includes(conflict);
  const decisive = strongestProof(proofs);

  /**
   * Un identifiant de registre n'est pas une ressemblance.
   *
   * Quand le site publie le SIREN du prospect, une adresse divergente en
   * mentions légales décrit une autre adresse de la MÊME personne morale —
   * un siège déclaré chez le gérant, un atelier ailleurs, un déménagement non
   * répercuté. Elle ne peut pas en faire une autre entreprise. Les preuves qui
   * reposent sur une ressemblance, elles, restent bloquées par le doute sur le
   * lieu : c'est exactement là qu'un homonyme se cache.
   */
  const blocked =
    has('SOCIAL_CONFLICT') ||
    has('SITE_UNREADABLE') ||
    /**
     * Le site d'un réseau n'est le site propre d'aucun de ses établissements,
     * même quand il publie le SIREN de l'un d'eux. Observé sur les 34 :
     * `demo-30-exemple.fr` publie le SIREN d'un prospect sans porter son nom.
     */
    has('MULTI_ESTABLISHMENT_SITE') ||
    (has('LOCATION_CONFLICT') && !proofs.includes('LEGAL_ID_MATCH'));

  if (!blocked && decisive && nameAgrees(input.verdict)) {
    return { ...base, decision: 'CONFIRMED', proofs, conflicts, decidedBy: decisive, reasons };
  }

  /**
   * La seule combinaison sans preuve décisive qui confirme : un nom distinctif
   * qui concorde fortement, la localisation du prospect sur la page, et le
   * vocabulaire du métier. Les trois ensemble, jamais deux.
   *
   * C'est la règle de R3, ses seuils inchangés — mais énoncée ici par les
   * preuves qui la composent plutôt qu'empruntée à son verdict global. La
   * différence n'est pas cosmétique : `verdict === 'confirmed'` recouvre aussi
   * la concordance de SIREN, et s'y adosser réadmettait en douce des cas que la
   * règle ci-dessus venait d'écarter — un site publiant le SIREN du prospect
   * sans porter son nom passait `CONFIRMED` en étant rapporté, à tort, comme
   * confirmé par son nom.
   */
  const nameLocationNiche =
    proofs.includes('DISTINCTIVE_NAME_MATCH') &&
    proofs.includes('NAME_CITY_MATCH') &&
    proofs.includes('NICHE_VOCABULARY_PRESENT');
  if (!blocked && nameLocationNiche) {
    return { ...base, decision: 'CONFIRMED', proofs, conflicts, decidedBy: 'DISTINCTIVE_NAME_MATCH', reasons };
  }

  if (input.verdict.verdict === 'rejected') {
    if (conflicts.length === 0) conflicts.push('INSUFFICIENT_EVIDENCE');
    if (rejectReason) reasons.push(rejectReason);
    return { ...base, decision: 'REJECTED', proofs, conflicts, decidedBy: null, reasons };
  }

  if (proofs.length === 0 && conflicts.length === 0) conflicts.push('INSUFFICIENT_EVIDENCE');
  return { ...base, decision: 'REVIEW_REQUIRED', proofs, conflicts, decidedBy: null, reasons };
}

// ---------------------------------------------------------------------------
// Adjudication d'un prospect (plusieurs candidats)
// ---------------------------------------------------------------------------
export interface ProspectDomainAdjudication {
  prospectId: string;
  displayName: string;
  /** Un verdict par candidat testé, dans l'ordre où ils ont été proposés. */
  candidates: ProbableDomainAdjudication[];
  /** Le domaine rattachable, ou null. Jamais renseigné si l'identité est ambiguë. */
  attachableDomain: string | null;
  decision: ProbableDomainDecision;
}

/**
 * Réunit les verdicts des candidats d'un même prospect.
 *
 * La règle qui compte est celle de l'ambiguïté : deux domaines confirmés pour
 * une même entreprise ne font pas deux sites, ils font une question. Aucun
 * n'est rattaché, et un humain tranche — c'est moins cher qu'un mauvais
 * domaine, qui, lui, ne se voit plus jamais.
 */
export function adjudicateProspect(
  prospectId: string,
  displayName: string,
  candidates: ProbableDomainAdjudication[],
): ProspectDomainAdjudication {
  const confirmed = candidates.filter((candidate) => candidate.decision === 'CONFIRMED');

  if (confirmed.length > 1) {
    const ambiguous = confirmed.map((candidate) => ({
      ...candidate,
      decision: 'REVIEW_REQUIRED' as const,
      conflicts: [...candidate.conflicts, 'AMBIGUOUS_IDENTITY' as const],
      decidedBy: null,
      reasons: [
        ...candidate.reasons,
        `${confirmed.length} domaines distincts réunissent une preuve d'appartenance (${confirmed
          .map((other) => other.candidateDomain)
          .join(', ')}) — une entreprise n'a qu'un site propre`,
      ],
    }));
    const rest = candidates.filter((candidate) => candidate.decision !== 'CONFIRMED');
    return {
      prospectId,
      displayName,
      candidates: [...ambiguous, ...rest],
      attachableDomain: null,
      decision: 'REVIEW_REQUIRED',
    };
  }

  const winner = confirmed[0];
  if (winner) {
    return { prospectId, displayName, candidates, attachableDomain: winner.candidateDomain, decision: 'CONFIRMED' };
  }
  const review = candidates.some((candidate) => candidate.decision === 'REVIEW_REQUIRED');
  return {
    prospectId,
    displayName,
    candidates,
    attachableDomain: null,
    decision: review ? 'REVIEW_REQUIRED' : 'REJECTED',
  };
}

/** Rappel : le seuil de réseau appartient à R3, il n'est pas redéfini ici. */
export const MULTI_ESTABLISHMENT_THRESHOLD = CHAIN_POSTAL_THRESHOLD;
/** Idem pour l'accord de nom minimal. */
export const MIN_NAME_AGREEMENT = NAME_AGREEMENT_FLOOR;
