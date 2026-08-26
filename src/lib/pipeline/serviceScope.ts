import { stripAccents } from '@/lib/identity/normalize';
import type { NicheConfig, OutOfScopeServiceFamily } from '@/lib/config/schema';

/**
 * HERMES-SERVICE-SCOPE-TARGETING-R1 §3-§7 — « cette entreprise vend-elle UNIQUEMENT
 * du prestation standard ? »
 *
 * ---------------------------------------------------------------------------
 * Ce que cette question a de nouveau
 * ---------------------------------------------------------------------------
 * `coreServiceFit` (HERMES-TARGETING-R1) mesurait une DOMINANCE : le prestation standard
 * pèse-t-il plus lourd que la protection dans la vitrine ? La règle qu'il
 * appliquait était juste sous l'ICP d'alors — §9 de cette mission-là disait
 * explicitement qu'« un prestataire a le droit de proposer de la boutique en ligne ».
 *
 * Le 22 août 2026, le produit a tranché autrement, et il l'a fait sur des
 * preuves : quatre prospects ont atteint `AUTO_SEND_ELIGIBLE` en portant du
 * REVENTE, de la boutique en ligne et du vente de produits. Deux d'entre eux — `@demo_account_05`
 * et `@demo_account_04` — ont été ouverts à l'œil par Operator Example, qui a
 * vu sur leurs pages ce que la dominance avait laissé passer.
 *
 * La règle voulue n'est donc plus « qui domine » mais « qu'est-ce qui est
 * VENDU » :
 *
 *     une prestation non-prestation standard réellement commercialisée
 *     ⇒ hors cible autonome, même secondaire, même minoritaire.
 *
 * Ce module remplace la dominance par une PRÉSENCE. Il ne remplace pas
 * `coreServiceFit`, qui garde son sens et ses verdicts historiques : les
 * décisions rendues sous `hermes-targeting-r1` doivent rester relisibles sous
 * la règle qui les a rendues (§5).
 *
 * ---------------------------------------------------------------------------
 * Pourquoi la liste de prestations est lue ICI, alors qu'elle était écartée là
 * ---------------------------------------------------------------------------
 * `coreServiceFit` et `coreActivity` refusent tous deux `services` et
 * `premium_services` comme preuve, et ils ont raison POUR LEUR QUESTION : ces
 * champs sont des extractions par mot-clé, donc « ce vocabulaire est apparu »,
 * jamais « ceci est mon métier ». Les lire pour mesurer une dominance ferait
 * d'un prestataire qui propose la boutique en ligne un spécialiste de la boutique en ligne.
 *
 * La question a changé, et la valeur probante de ces champs avec elle. « Le mot
 * REVENTE est apparu sur les pages de ce commerce » ne dit rien sur ce qui domine —
 * mais c'est exactement l'observation qui doit faire DOUTER qu'il ne vende que
 * du prestation standard. Un doute écarte (§6), il n'accuse pas.
 *
 * `site_identity_declarations` reste écarté, pour la raison que `coreActivity`
 * a établie : ce champ contient une phrase produite par NOTRE crawler
 * (« vocabulaire du métier présent (atelier, vente de produits, …) »). La lire ferait
 * raisonner le moteur sur sa propre conclusion.
 *
 * ---------------------------------------------------------------------------
 * « atelier » n'est ni une preuve ni un grief (§4)
 * ---------------------------------------------------------------------------
 * Le mot ne décide de rien seul, et le corpus le montre dans les deux sens :
 * `@demo_account_2331_toulouse` s'appelle « Atelier & Prestation standard Auto à domicile »
 * et vend du vente de produits ; `@demo_account_05` s'appelle « FF ATELIER
 * CENTER » et met le REVENTE dans son titre. Un troisième vocabulaire existe donc
 * ici — `ambiguousTerms` — qui ne prouve rien et n'exclut rien. Il est compté
 * et publié, pour qu'un `UNKNOWN` se relise « on n'a vu que des mots
 * ambigus » plutôt que « on n'a rien vu ».
 *
 * ---------------------------------------------------------------------------
 * Aucun nom propre, nulle part
 * ---------------------------------------------------------------------------
 * Ce module ne reçoit ni le nom du prospect, ni son handle, ni son domaine : il
 * ne pourrait donc pas coder un cas particulier même par accident. Les deux
 * adjudications de la mission (§8) sont honorées par la RÈGLE — leurs preuves
 * portent REVENTE, boutique en ligne et vente de produits — et par aucune exception nominative.
 */

export type ServiceScopeVerdict =
  /** Du prestation standard prouvé, et aucune prestation non-prestation standard observée. Le seul verdict envoyant. */
  | 'IN_SCOPE_ONLY'
  /** Du prestation standard prouvé ET au moins une prestation non-prestation standard commercialisée. */
  | 'MIXED_WITH_OUT_OF_SCOPE'
  /** Au moins une prestation non-prestation standard, et aucune preuve de prestation standard. */
  | 'OUT_OF_SCOPE_SPECIALIST'
  /** Rien de concluant : surface non lue, muette, ou seulement du vocabulaire ambigu. */
  | 'UNKNOWN';

export interface ServiceScopeEvidenceLike {
  readonly field: string;
  readonly value_text: string | null;
  readonly value_json: unknown;
}

export type ServiceScopeSurface = 'frame' | 'offer';

export interface ServiceScopeHit {
  /** `in_scope`, `ambiguous`, ou la clé de la famille non-prestation standard. */
  readonly key: string;
  readonly phrase: string;
  readonly field: string;
  readonly surface: ServiceScopeSurface;
}

export interface ServiceScopeAssessment {
  readonly verdict: ServiceScopeVerdict;
  readonly reason: string;
  /** Termes de prestation standard NON ambigus trouvés. */
  readonly inScopeTerms: readonly string[];
  /** Termes qui ne prouvent ni n'excluent rien (§4). */
  readonly ambiguousTerms: readonly string[];
  /** Familles non-prestation standard distinctes trouvées. Une seule suffit à écarter. */
  readonly outOfScopeFamilies: readonly string[];
  readonly hits: readonly ServiceScopeHit[];
  /** Une surface au moins a-t-elle été lue ? `false` ⇒ `UNKNOWN` sans discussion. */
  readonly surfaceRead: boolean;
}

/**
 * Le CADRE — ce qu'un dirigeant écrit pour dire ce qu'il EST.
 *
 * Même liste que `coreServiceFit` et `coreActivity`, volontairement : trois
 * modules qui liraient trois cadres différents finiraient par se contredire sur
 * le même prospect.
 */
const FRAME_FIELDS: readonly string[] = [
  'website_title',
  'website_description',
  'website_headings',
  'osm_category',
  'instagram_category',
];

/**
 * L'OFFRE — le vocabulaire de prestation réellement extrait des pages.
 *
 * Probant pour « qu'est-ce qui est vendu ? », muet sur « qu'est-ce qui
 * domine ? ». Voir l'en-tête.
 */
const OFFER_FIELDS: readonly string[] = ['services', 'premium_services'];

function normalize(raw: string): string {
  const flattened = stripAccents(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return flattened.length === 0 ? '' : ` ${flattened} `;
}

function readable(row: ServiceScopeEvidenceLike): string {
  const text = row.value_text ?? '';
  if (row.value_json === null || row.value_json === undefined) return text;
  if (Array.isArray(row.value_json)) {
    return [text, ...row.value_json.filter((item): item is string => typeof item === 'string')].join(' ');
  }
  if (typeof row.value_json === 'string') return `${text} ${row.value_json}`;
  return text;
}

function contains(haystack: string, phrase: string): boolean {
  const needle = normalize(phrase);
  return needle.length > 2 && haystack.includes(needle);
}

export interface ServiceScopeInput {
  readonly evidence: readonly ServiceScopeEvidenceLike[];
  readonly niche: NicheConfig;
}

/**
 * L'évaluation, en un seul passage sur les preuves déjà collectées.
 *
 * Aucune I/O, aucun LLM, aucun réseau : la règle est éprouvable sur des cadres
 * de site que les données réelles ne produiront pas de sitôt, et le sera par les
 * tests de régression que la mission §29 demande.
 */
export function assessServiceScope(input: ServiceScopeInput): ServiceScopeAssessment {
  const { evidence, niche } = input;
  const scope = niche.serviceScope;
  const families: readonly OutOfScopeServiceFamily[] = scope.outOfScopeFamilies;

  const empty = (verdict: ServiceScopeVerdict, reason: string, surfaceRead: boolean): ServiceScopeAssessment =>
    Object.freeze({
      verdict,
      reason,
      inScopeTerms: Object.freeze([]),
      ambiguousTerms: Object.freeze([]),
      outOfScopeFamilies: Object.freeze([]),
      hits: Object.freeze([]),
      surfaceRead,
    });

  // Une niche qui n'a pas déclaré ce vocabulaire ne rend pas `IN_SCOPE_ONLY`
  // par défaut : elle rend `UNKNOWN`, qui n'autorise aucun envoi. Un défaut
  // permissif ferait qu'ajouter une niche ouvrirait silencieusement l'envoi sur
  // elle — c'est la même défaillance sûre que `assessCoreServiceFit`.
  if (scope.inScopeTerms.length === 0 || families.length === 0) {
    return empty(
      'UNKNOWN',
      `la niche « ${niche.key} » ne déclare pas de vocabulaire serviceScope — rien n’est mesuré, donc rien n’est conclu`,
      false,
    );
  }

  const hits: ServiceScopeHit[] = [];
  const inScope = new Set<string>();
  const ambiguous = new Set<string>();
  const outOfScope = new Set<string>();
  let surfaceRead = false;

  for (const row of evidence) {
    const frame = FRAME_FIELDS.includes(row.field);
    const offer = OFFER_FIELDS.includes(row.field);
    if (!frame && !offer) continue;
    const raw = readable(row);
    if (raw.trim().length === 0) continue;
    const text = normalize(raw);
    if (text.trim().length === 0) continue;
    surfaceRead = true;
    const surface: ServiceScopeSurface = frame ? 'frame' : 'offer';

    // L'ordre du retrait n'est pas cosmétique : « protection boutique en ligne »
    // contient « boutique en ligne », « formation atelier » contient « atelier », et
    // laisser la phrase longue en place ferait compter deux fois la même
    // déclaration — ou pire, ferait passer « formation atelier » pour du
    // atelier. Les familles non-prestation standard sont donc cherchées PUIS retirées,
    // les termes ambigus ensuite, et le prestation standard sur ce qui reste.
    let residual = text;
    for (const family of families) {
      for (const phrase of family.phrases) {
        if (!contains(residual, phrase)) continue;
        outOfScope.add(family.key);
        hits.push({ key: family.key, phrase, field: row.field, surface });
        residual = residual.split(normalize(phrase).trim()).join(' ');
      }
    }

    for (const term of scope.ambiguousTerms) {
      if (!contains(residual, term)) continue;
      ambiguous.add(term);
      hits.push({ key: 'ambiguous', phrase: term, field: row.field, surface });
      residual = residual.split(normalize(term).trim()).join(' ');
    }

    for (const term of scope.inScopeTerms) {
      if (!contains(residual, term)) continue;
      inScope.add(term);
      hits.push({ key: 'in_scope', phrase: term, field: row.field, surface });
    }
  }

  const inScopeTerms = [...inScope].sort();
  const ambiguousTerms = [...ambiguous].sort();
  const outOfScopeFamilies = [...outOfScope].sort();

  const decided = (verdict: ServiceScopeVerdict, reason: string): ServiceScopeAssessment =>
    Object.freeze({
      verdict,
      reason,
      inScopeTerms: Object.freeze(inScopeTerms),
      ambiguousTerms: Object.freeze(ambiguousTerms),
      outOfScopeFamilies: Object.freeze(outOfScopeFamilies),
      hits: Object.freeze(hits),
      surfaceRead,
    });

  if (!surfaceRead) {
    return empty(
      'UNKNOWN',
      'aucune page de présentation ni liste de prestations lue — la nature de l’offre reste inconnue',
      false,
    );
  }

  // Une prestation non-prestation standard suffit, et c'est TOUTE la mission. On ne
  // cherche plus si elle domine : §3 dit « activité secondaire visible =
  // exclusion si elle est commercialisée comme vraie prestation ».
  if (outOfScopeFamilies.length > 0) {
    const listed = outOfScopeFamilies.join(', ');
    if (inScopeTerms.length > 0) {
      return decided(
        'MIXED_WITH_OUT_OF_SCOPE',
        `ce commerce déclare du prestation standard (${inScopeTerms.slice(0, 3).join(', ')}) ET des prestations ` +
          `non-prestation standard (${listed}) — l’offre mixte est hors de la cible autonome, même si le prestation standard y figure`,
      );
    }
    return decided(
      'OUT_OF_SCOPE_SPECIALIST',
      `ce commerce déclare des prestations non-prestation standard (${listed}) et aucun terme de prestation standard ` +
        'non ambigu — son métier n’est pas celui que nous savons servir',
    );
  }

  if (inScopeTerms.length > 0) {
    return decided(
      'IN_SCOPE_ONLY',
      `l’offre lue ne déclare que du prestation standard / entretien (${inScopeTerms.slice(0, 4).join(', ')}) ` +
        'et aucune prestation non-prestation standard',
    );
  }

  // Le cas explicitement nommé par §4 : « atelier sans détail suffisant ».
  // L'absence de preuve de REVENTE n'est pas une preuve de prestation standard exclusif (§6).
  return decided(
    'UNKNOWN',
    ambiguousTerms.length > 0
      ? `seul du vocabulaire ambigu a été lu (${ambiguousTerms.slice(0, 4).join(', ')}) — il ne désigne ` +
        'ni un prestataire ni un spécialiste, et une absence de preuve n’est pas une preuve d’absence'
      : 'surface lue, mais elle ne déclare aucune prestation reconnaissable — quelqu’un a regardé sans pouvoir conclure',
  );
}

/**
 * Le verdict autorise-t-il un envoi AUTOMATIQUE ?
 *
 * Égalité stricte à l'unique valeur positive, comme `serviceFitAllowsAutoSend`
 * et `isAutoSendEligible` : une cinquième valeur ajoutée un jour serait
 * non-envoyante par défaut. `UNKNOWN` n'est PAS `IN_SCOPE_ONLY` (§6).
 */
export function serviceScopeAllowsAutoSend(verdict: ServiceScopeVerdict): boolean {
  return verdict === 'IN_SCOPE_ONLY';
}

/** Le verdict est-il définitif, ou une observation nouvelle peut-elle le rouvrir ? */
export function serviceScopeIsTerminal(verdict: ServiceScopeVerdict): boolean {
  return verdict === 'MIXED_WITH_OUT_OF_SCOPE' || verdict === 'OUT_OF_SCOPE_SPECIALIST';
}
