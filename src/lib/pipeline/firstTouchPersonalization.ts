/**
 * HERMES-END-TO-END-CERTIFICATION-R1 §FIRST-TOUCH — de quoi parler à quelqu'un
 * qu'on n'a jamais contacté, et à quelle condition.
 *
 * ---------------------------------------------------------------------------
 * Le défaut, mesuré
 * ---------------------------------------------------------------------------
 * Le premier message réellement parti pendant le canari était :
 *
 *   « Bonjour, petite question : aujourd'hui, vous faites comment pour avoir
 *     régulièrement de nouvelles demandes, plutôt grâce au bouche-à-oreille et
 *     aux réseaux ou avec autre chose déjà en place ? »
 *
 * Un gabarit. Il a pourtant été écrit par un modèle à qui l'on avait montré des
 * exemples validés et interdit d'inventer — il a fait exactement ce qu'on lui
 * demandait, parce que la seule chose qu'on lui avait donnée était :
 *
 *   FAITS VÉRIFIÉS UTILISABLES (aucun autre)
 *   - aucun fait vérifié : reste générique et honnête
 *
 * La cause n'était pas le prompt. `buildMessageRequest` ne lit la
 * personnalisation que de `prospect_angles`, produit par une étape LLM qui elle
 * -même ne lit que `prospect_research`, produit par une autre. Sur ce corpus,
 * **315 prospects sur 466 portent des preuves et AUCUNE de ces deux lignes** —
 * plus de deux sur trois. Pour eux, le premier message était condamné au
 * gabarit par construction, quelle qu'ait été la richesse de ce qu'on avait
 * observé.
 *
 * Northstar Studio en est l'exemple : aucune recherche, aucun angle, et
 * vingt-quatre champs de preuve dont les prestations affichées, la synthèse de
 * funnel (« réservation en ligne (simplybook), tarifs affichés, CTA
 * "Réserver" »), la ville et l'audience visée.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce module fait, et ce qu'il ne fait pas
 * ---------------------------------------------------------------------------
 * Il lit les PREUVES — `prospect_evidence`, la table que la découverte
 * remplit — et rend AU PLUS UNE accroche, avec sa provenance. C'est du code
 * déterministe, pas un prompt : CLAUDE.md pose que la logique décidable reste
 * du code testé, et « cette observation est-elle assez solide pour être dite à
 * un inconnu » est décidable.
 *
 * Il n'INVENTE rien et n'INTERPRÈTE rien. Le texte d'une accroche est composé à
 * partir de la valeur observée, jamais d'une déduction sur l'entreprise. Il ne
 * dit jamais qu'une chose est ABSENTE : l'absence d'observation n'est pas une
 * observation d'absence, et c'est l'interdit n°2 du dépôt.
 *
 * Il ne remplace pas l'angle commercial quand il existe : il le PRÉCÈDE dans
 * l'ordre de préférence uniquement lorsque l'angle est vide, ce qui est le cas
 * des deux tiers du corpus. Un angle grounded reste meilleur — il a vu la
 * recherche entière.
 *
 * ---------------------------------------------------------------------------
 * Fail-closed
 * ---------------------------------------------------------------------------
 * Aucune accroche assez solide rend `GENERIC_OPENING`, et le message repart sur
 * l'ouverture honnête d'avant. C'est le comportement que la mission demande
 * explicitement : « fail-closed vers une ouverture moins spécifique plutôt
 * qu'inventer ».
 */

/** D'où vient une accroche. Nommé, parce qu'un rapport doit pouvoir le relire. */
export type PersonalizationAngle =
  /** Les prestations réellement mises en avant. */
  | 'SERVICE_MIX'
  /** L'audience visée, quand le site la nomme (particuliers, pros, flottes). */
  | 'AUDIENCE'
  /** Une réservation en ligne OBSERVÉE. Jamais son absence. */
  | 'BOOKING_PRESENT'
  /** Des tarifs affichés, OBSERVÉS. Jamais leur montant. */
  | 'PRICING_DISPLAYED'
  /** La zone d'intervention, quand elle est écrite. */
  | 'AREA'
  /** Une prestation haut de gamme mise en avant. */
  | 'PREMIUM_SERVICE'
  /**
   * L'intervention À DOMICILE, quand le site l'annonce.
   *
   * Séparée de `SERVICE_MIX` parce que ce n'est pas une prestation, c'est une
   * MODALITÉ — et le corpus le prouve : `services` porte « domicile », « a
   * domicile » et « à domicile » comme s'il s'agissait de trois métiers. Les
   * lire comme des prestations produisait « ils mettent en avant : domicile et
   * a domicile », une phrase qu'aucun humain n'écrirait.
   */
  | 'MOBILE_SERVICE';

/** Pourquoi une piste a été écartée. Aucune n'est silencieuse. */
export type PersonalizationRejection =
  /** Aucune ligne de preuve pour ce champ. */
  | 'NOT_OBSERVED'
  /** Une ligne existe mais sa provenance ne suffit pas. */
  | 'WEAK_PROVENANCE'
  /** La valeur est vide, tronquée ou illisible. */
  | 'UNREADABLE'
  /** La valeur est trop générique pour dire quoi que ce soit de ce commerce. */
  | 'NOT_DISTINCTIVE';

/** Une ligne de preuve, réduite à ce dont ce module a besoin. */
export interface PersonalizationEvidence {
  readonly id: string;
  readonly field: string;
  readonly valueText: string | null;
  readonly provider: string | null;
  readonly method: string | null;
  readonly confidence: number | null;
  readonly sourceUrl: string | null;
}

export interface PersonalizationHook {
  readonly angle: PersonalizationAngle;
  /**
   * Ce qu'on a observé, en une phrase factuelle.
   *
   * Destiné au PROMPT, pas au prospect : le modèle en fait une phrase
   * naturelle. L'écrire tel quel serait le gabarit qu'on remplace.
   */
  readonly observation: string;
  /** Les lignes de preuve qui la portent. Jamais vide. */
  readonly evidenceIds: readonly string[];
  readonly provider: string;
  readonly sourceUrl: string | null;
}

export interface PersonalizationRejected {
  readonly angle: PersonalizationAngle;
  readonly reason: PersonalizationRejection;
}

export interface FirstTouchPersonalization {
  /** `PERSONALIZED` seulement si une accroche a survécu. */
  readonly opening: 'PERSONALIZED' | 'GENERIC';
  /** L'accroche RETENUE, au plus une. */
  readonly hook: PersonalizationHook | null;
  /**
   * Les autres accroches solides, NON retenues.
   *
   * Rendues pour le rapport et pour rien d'autre : elles n'entrent pas dans le
   * prompt. Mettre trois observations dans un premier DM pour prouver qu'on a
   * fait des recherches est précisément ce que la mission interdit.
   */
  readonly alsoAvailable: readonly PersonalizationHook[];
  readonly rejected: readonly PersonalizationRejected[];
  /** Le contexte métier OBSERVÉ, pour que le modèle sache à qui il écrit. */
  readonly businessContext: readonly string[];
}

/**
 * Les provenances qui suffisent à DIRE une chose à un inconnu.
 *
 * `crawl` et `api` sont des lectures directes. `derived` est accepté pour les
 * seuls champs de synthèse qui nomment leur source (`funnel_synthesis` dit « 3
 * page(s) lue(s) ») — pas comme règle générale : une dérivation est un
 * raisonnement, et un raisonnement n'est pas une observation.
 */
const DIRECT_METHODS: ReadonlySet<string> = new Set(['crawl', 'api']);

/** Les champs de synthèse dont la dérivation reste adossée à une lecture. */
const SYNTHESIS_FIELDS: ReadonlySet<string> = new Set(['funnel_synthesis']);

/** Sous ce seuil, une preuve ne porte pas une phrase adressée à un inconnu. */
const MIN_CONFIDENCE = 0.7;

/**
 * Les mots qui ne distinguent RIEN.
 *
 * « atelier » et « prestation standard » décrivent le métier de toute la
 * cible : les citer ne prouve pas qu'on a regardé, cela prouve qu'on a lu
 * l'annuaire. Une accroche bâtie dessus est un faux constat de personnalisation
 * — exactement le « j'adore ton site » que la mission interdit.
 */
const GENERIC_SERVICE_TERMS: ReadonlySet<string> = new Set([
  'example-services',
  'car atelier',
  'prestation standard',
  'prestation standard',
  'prestation standard',
  'prestation',
  'prestation standard',
  'prestation standard',
  'entretien',
  'entretien automobile',
  'voiture',
  'auto',
]);

function usable(row: PersonalizationEvidence): boolean {
  if (row.valueText === null) return false;
  if (row.valueText.trim().length === 0) return false;
  const method = row.method ?? '';
  const direct = DIRECT_METHODS.has(method);
  const synthesis = method === 'derived' && SYNTHESIS_FIELDS.has(row.field);
  if (!direct && !synthesis) return false;
  return (row.confidence ?? 0) >= MIN_CONFIDENCE;
}

/** Les valeurs d'un champ, dédupliquées, dans l'ordre où on les a lues. */
function valuesOf(
  rows: readonly PersonalizationEvidence[],
  field: string,
): { values: readonly string[]; rows: readonly PersonalizationEvidence[] } {
  const kept: PersonalizationEvidence[] = [];
  const seen = new Set<string>();
  const values: string[] = [];
  for (const row of rows) {
    if (row.field !== field) continue;
    if (!usable(row)) continue;
    const text = (row.valueText ?? '').trim();
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(text);
    kept.push(row);
  }
  return { values, rows: kept };
}

/**
 * La clé de comparaison d'un terme : minuscules, sans accents, espaces
 * normalisés.
 *
 * La découverte écrit « prestation standard interieur » ET « prestation standard intérieur » pour
 * la même chose, et « domicile », « a domicile », « à domicile » pour la même
 * modalité. Sans clé commune, les trois survivaient à la déduplication et se
 * retrouvaient côte à côte dans la même phrase.
 */
function termKey(term: string): string {
  return term
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Les clés qui désignent l'intervention à domicile, et rien d'autre. */
const MOBILE_KEYS: ReadonlySet<string> = new Set(['domicile', 'a domicile', 'sur place', 'a votre domicile']);

/** Découpe une liste de prestations, en retirant ce qui ne distingue rien. */
function distinctiveServices(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const value of values) {
    for (const raw of value.split(/[,;|]/)) {
      const term = raw.trim();
      const key = termKey(term);
      if (key.length < 4) continue;
      if (GENERIC_SERVICE_TERMS.has(key)) continue;
      // La modalité « à domicile » a son propre angle : la laisser ici la
      // ferait passer pour une prestation.
      if (MOBILE_KEYS.has(key)) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(term);
    }
  }
  return kept;
}

/** Le site annonce-t-il une intervention à domicile ? */
function mentionsMobile(values: readonly string[]): boolean {
  for (const value of values) {
    for (const raw of value.split(/[,;|]/)) {
      if (MOBILE_KEYS.has(termKey(raw))) return true;
    }
  }
  return false;
}

/**
 * Une ville LISIBLE, ou `null`.
 *
 * La valeur observée n'est pas toujours une ville : le corpus porte
 * « Saint-André-de-Cubzac E-MAIL Contactez-nous SUIVEZ-NOUS », c'est-à-dire un
 * pied de page avalé par le crawl. La citer produirait une phrase absurde
 * adressée à un inconnu — le contraire exact de ce qu'une personnalisation doit
 * faire. Fail-closed : au moindre doute, aucune zone.
 */
function readableCity(city: string | null): string | null {
  if (city === null) return null;
  const trimmed = city.trim();
  if (trimmed.length === 0 || trimmed.length > 40) return null;
  if (/[@0-9]/.test(trimmed)) return null;
  // Un nom de ville français tient en trois mots (« Saint-André-de-Cubzac »
  // n'en fait qu'un, les tirets ne séparent pas). Au-delà, c'est du texte de
  // page, pas une ville.
  if (trimmed.split(/\s+/).length > 3) return null;
  // Un fragment de phrase avalé par le crawl finit souvent sur une préposition
  // (« TRAPPES à »). La recopier ferait écrire « à TRAPPES à ».
  const cleaned = trimmed.replace(/\s+(?:[àa]|de|du|des|en|sur|et)$/i, '').trim();
  return cleaned.length === 0 ? null : cleaned;
}

/**
 * L'audience À QUI le site s'adresse, quand il le dit EXPLICITEMENT.
 *
 * La première version cherchait le simple MOT « professionnels » n'importe où
 * dans la description. C'est un faux constat en puissance, et sur ce corpus il
 * se déclenchait presque partout : « nous sommes des professionnels du
 * prestation standard » parle de l'entreprise, pas de sa clientèle, et en tirer « votre
 * site s'adresse aux professionnels » est exactement le faux constat que la
 * mission interdit — dit à un inconnu, il se retourne immédiatement.
 *
 * Une ADRESSE demande une préposition : « pour les particuliers », « aux
 * professionnels », « destiné aux entreprises ». Sans elle, on ne conclut rien.
 */
function namedAudience(text: string): string | null {
  const normalized = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
  // Une ADRESSE s'ouvre par une préposition, puis énumère : « pour les
  // particuliers ET les professionnels ». Le second membre n'a pas de
  // préposition à lui — on lit donc le SEGMENT qui suit l'ancre, borné, plutôt
  // que d'exiger la préposition devant chaque audience.
  const anchor = /(?:pour|aux?|destine[es]?\s+aux?|s'adresse\s+aux?|a\s+destination\s+d[eu]s?)\s/u;
  const match = anchor.exec(normalized);
  if (match === null) return null;
  const segment = normalized.slice(match.index, match.index + 90);

  const addressed = (who: string): boolean => new RegExp(who, 'u').test(segment);

  const pros = addressed('(?<![\\p{L}])(?:professionnels?|pros?|entreprises?|flottes?|concessions?|garages?)(?![\\p{L}])');
  const particuliers = addressed('(?<![\\p{L}])particuliers?(?![\\p{L}])');
  if (pros && particuliers) return 'aux particuliers ET aux professionnels';
  if (pros) return 'aux professionnels';
  if (particuliers) return 'aux particuliers';
  return null;
}

interface Candidate {
  readonly hook: PersonalizationHook;
}

/**
 * Choisit ce dont on va parler.
 *
 * L'ordre est celui de l'UTILITÉ À LA CONVERSATION, pas celui de la rareté.
 * Hermes ouvre en demandant comment l'entreprise obtient ses demandes : une
 * observation qui touche à la façon dont les clients arrivent (réservation en
 * ligne, audience visée) mène naturellement à cette question. Une observation
 * qui décrit la prestation (services, premium) est vraie mais plus loin du
 * sujet ; elle sert quand rien de mieux n'existe. La zone vient en dernier :
 * elle prouve qu'on a regardé, sans rien ouvrir.
 */
const ANGLE_PRIORITY: readonly PersonalizationAngle[] = Object.freeze([
  'BOOKING_PRESENT',
  'AUDIENCE',
  'MOBILE_SERVICE',
  'SERVICE_MIX',
  'PREMIUM_SERVICE',
  'PRICING_DISPLAYED',
  'AREA',
]);

export interface PersonalizationInput {
  readonly evidence: readonly PersonalizationEvidence[];
  /** Le nom d'affichage, pour le contexte métier. Jamais une accroche. */
  readonly displayName: string;
  readonly city: string | null;
  /**
   * L'accroche de l'angle commercial, si une existe et a survécu au grounding.
   *
   * Quand elle existe, elle GAGNE : elle a vu la recherche entière, là où ce
   * module ne voit que des champs. Ce paramètre est là pour que l'appelant
   * n'ait pas à écrire cette règle deux fois.
   */
  readonly angleHook?: string | null;
}

export function buildFirstTouchPersonalization(
  input: PersonalizationInput,
): FirstTouchPersonalization {
  const rows = input.evidence;
  const candidates = new Map<PersonalizationAngle, Candidate>();
  const rejected: PersonalizationRejected[] = [];

  const reject = (angle: PersonalizationAngle, reason: PersonalizationRejection): void => {
    rejected.push({ angle, reason });
  };

  const add = (
    angle: PersonalizationAngle,
    observation: string,
    source: readonly PersonalizationEvidence[],
  ): void => {
    const first = source[0];
    if (first === undefined) return;
    candidates.set(angle, {
      hook: Object.freeze({
        angle,
        observation,
        evidenceIds: Object.freeze(source.map((row) => row.id)),
        provider: first.provider ?? 'inconnu',
        sourceUrl: first.sourceUrl,
      }),
    });
  };

  // --- Réservation en ligne OBSERVÉE ---------------------------------------
  const booking = valuesOf(rows, 'booking_system');
  const funnel = valuesOf(rows, 'funnel_synthesis');
  const bookingSource = booking.rows.length > 0 ? booking : funnel;
  const bookingSaysOnline =
    booking.values.length > 0 ||
    funnel.values.some((value) => /r[ée]servation en ligne/i.test(value));
  if (bookingSaysOnline) {
    add(
      'BOOKING_PRESENT',
      'une réservation en ligne est en place sur leur site',
      bookingSource.rows,
    );
  } else if (booking.rows.length === 0 && funnel.rows.length === 0) {
    reject('BOOKING_PRESENT', 'NOT_OBSERVED');
  } else {
    // Une synthèse existe et ne mentionne pas de réservation. On n'en conclut
    // RIEN : l'absence d'observation n'est pas une observation d'absence.
    reject('BOOKING_PRESENT', 'NOT_OBSERVED');
  }

  // --- Audience nommée ------------------------------------------------------
  const descriptions = valuesOf(rows, 'website_description');
  const titles = valuesOf(rows, 'website_title');
  const audienceRow = [...descriptions.rows, ...titles.rows].find(
    (row) => namedAudience(row.valueText ?? '') !== null,
  );
  if (audienceRow !== undefined) {
    const audience = namedAudience(audienceRow.valueText ?? '');
    if (audience !== null) {
      add('AUDIENCE', `leur site s'adresse ${audience}`, [audienceRow]);
    }
  } else if (descriptions.rows.length === 0 && titles.rows.length === 0) {
    reject('AUDIENCE', 'NOT_OBSERVED');
  } else {
    reject('AUDIENCE', 'NOT_DISTINCTIVE');
  }

  // --- Prestations distinctives --------------------------------------------
  const services = valuesOf(rows, 'services');
  if (services.rows.length === 0) {
    reject('SERVICE_MIX', 'NOT_OBSERVED');
  } else {
    const distinctive = distinctiveServices(services.values);
    if (distinctive.length === 0) {
      reject('SERVICE_MIX', 'NOT_DISTINCTIVE');
    } else {
      // Au plus DEUX prestations : au-delà, on récite un catalogue.
      const shown = distinctive.slice(0, 2).join(' et ');
      add('SERVICE_MIX', `ils mettent en avant : ${shown}`, services.rows);
    }
  }

  // --- Intervention à domicile ----------------------------------------------
  if (services.rows.length === 0) {
    reject('MOBILE_SERVICE', 'NOT_OBSERVED');
  } else if (mentionsMobile(services.values)) {
    add('MOBILE_SERVICE', 'ils annoncent intervenir à domicile', services.rows);
  } else {
    reject('MOBILE_SERVICE', 'NOT_OBSERVED');
  }

  // --- Prestation haut de gamme --------------------------------------------
  const premium = valuesOf(rows, 'premium_services');
  if (premium.rows.length === 0) {
    reject('PREMIUM_SERVICE', 'NOT_OBSERVED');
  } else {
    const distinctive = distinctiveServices(premium.values);
    if (distinctive.length === 0) reject('PREMIUM_SERVICE', 'NOT_DISTINCTIVE');
    else add('PREMIUM_SERVICE', `ils proposent aussi ${distinctive[0]!}`, premium.rows);
  }

  // --- Tarifs affichés ------------------------------------------------------
  //
  // L'observation est « des tarifs sont affichés », JAMAIS lesquels : citer un
  // montant lu sur un site dans un premier message est une affirmation
  // chiffrée, et l'interdit n°3 ne s'ouvre pas pour ça.
  const pricesShown = funnel.values.some((value) => /tarifs? affich/i.test(value));
  if (pricesShown) add('PRICING_DISPLAYED', 'leurs tarifs sont affichés en ligne', funnel.rows);
  else reject('PRICING_DISPLAYED', funnel.rows.length === 0 ? 'NOT_OBSERVED' : 'NOT_DISTINCTIVE');

  // --- Zone -----------------------------------------------------------------
  const cityRows = valuesOf(rows, 'city');
  const city = readableCity(input.city);
  if (cityRows.rows.length > 0 && city !== null) {
    add('AREA', `ils sont installés à ${city}`, cityRows.rows);
  } else {
    reject('AREA', cityRows.rows.length === 0 ? 'NOT_OBSERVED' : 'UNREADABLE');
  }

  // --- Le contexte métier, observé -----------------------------------------
  //
  // Distinct de l'accroche : il dit à QUI on écrit, il ne se cite pas dans le
  // message. Sans lui, le modèle écrit à « une entreprise de prestation standard »,
  // c'est-à-dire à personne.
  const businessContext: string[] = [];
  const service = distinctiveServices(services.values);
  if (service.length > 0) businessContext.push(`prestations observées : ${service.slice(0, 4).join(', ')}`);
  if (mentionsMobile(services.values)) businessContext.push('intervention à domicile annoncée');
  // La ville n'entre QUE si une ligne de preuve la porte. `prospects.city` seul
  // dirait « observé » d'une valeur que ce module n'a pas vue — et le contexte
  // s'annonce comme observé.
  if (city !== null && cityRows.rows.length > 0) businessContext.push(`ville : ${city}`);
  for (const value of funnel.values.slice(0, 1)) businessContext.push(`funnel observé : ${value}`);

  const ordered = ANGLE_PRIORITY.map((angle) => candidates.get(angle)).filter(
    (entry): entry is Candidate => entry !== undefined,
  );

  // L'angle commercial est un REPLI, jamais un vainqueur.
  //
  // Il a vu la recherche entière, ce qui plaide pour lui ; mais il a été écrit
  // pour un autre usage, et le corpus le montre. Sur un prospect réel il vaut :
  // « J'ai vu que vous intervenez à domicile autour d'Annecy avec une gamme
  // allant du prestation standard intérieur et extérieur jusqu'aux offres premium de
  // boutique en ligne et de REVENTE. Cette diversité se prête bien à une acquisition locale
  // différenciée selon la valeur et l'intention de chaque prestation. » — deux
  // phrases, un diagnostic, et le vocabulaire d'agence que
  // HERMES-TARGETING-R1 §14-§20 a passé un round entier à faire sortir des
  // premiers messages.
  //
  // Le laisser gagner aurait donc réintroduit l'audit qu'on venait de retirer.
  // Une accroche déterministe est courte et factuelle PAR CONSTRUCTION : c'est
  // tout son intérêt. L'angle ne sert donc que là où rien n'a survécu — et
  // dans ce cas il vaut mieux que le silence, puisque c'est exactement ce que
  // le prompt recevait avant ce round.
  const chosen = ordered[0];
  if (
    chosen === undefined &&
    input.angleHook !== undefined &&
    input.angleHook !== null &&
    input.angleHook.trim().length > 0
  ) {
    return Object.freeze({
      opening: 'PERSONALIZED',
      hook: Object.freeze({
        angle: 'SERVICE_MIX' as const,
        observation: input.angleHook.trim(),
        evidenceIds: Object.freeze([]),
        provider: 'prospect_angles',
        sourceUrl: null,
      }),
      alsoAvailable: Object.freeze([]),
      rejected: Object.freeze(rejected),
      businessContext: Object.freeze(businessContext),
    });
  }

  return Object.freeze({
    opening: chosen === undefined ? 'GENERIC' : 'PERSONALIZED',
    hook: chosen?.hook ?? null,
    alsoAvailable: Object.freeze(ordered.slice(1).map((entry) => entry.hook)),
    rejected: Object.freeze(rejected),
    businessContext: Object.freeze(businessContext),
  });
}

/** Le bloc rendu au modèle. Vide de toute interprétation. */
export function renderPersonalizationBlock(result: FirstTouchPersonalization): string {
  const lines: string[] = [];

  lines.push('CE QU’ON A OBSERVÉ DE CETTE ENTREPRISE (rien d’autre n’est vrai)');
  if (result.businessContext.length === 0) {
    lines.push('- rien d’observé : n’affirme RIEN sur leur activité, ni présence ni absence.');
  } else {
    for (const line of result.businessContext) lines.push(`- ${line}`);
  }

  lines.push('', 'LE SEUL DÉTAIL QUE TU PEUX REPRENDRE');
  if (result.hook === null) {
    lines.push(
      '- aucun. Ouvre par une question simple et honnête, sans prétendre avoir regardé leur travail.',
    );
  } else {
    lines.push(`- ${result.hook.observation}  [${result.hook.provider}]`);
    lines.push(
      '- reprends-le en UNE incise courte et naturelle, puis enchaîne sur ta question. Ne le',
      '  commente pas, ne le complimente pas, ne l’analyse pas, et n’en ajoute aucun autre.',
    );
  }

  return lines.join('\n');
}
