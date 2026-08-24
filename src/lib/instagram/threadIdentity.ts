/**
 * IG2.2 — « à qui suis-je en train d’écrire ? », décidé sur l’en-tête du fil.
 *
 * Trois refus successifs ont construit ce module, et chacun a corrigé une
 * erreur de PÉRIMÈTRE, jamais de sévérité.
 *
 *   1. Le handle attendu était confronté à TOUS les liens de profil du
 *      panneau. Un fil contenant des reels partagés porte les liens de leurs
 *      auteurs : `kulturlesite` et consorts comptaient comme des prétendants à
 *      l’identité du correspondant. Tout prospect ayant un historique aurait
 *      été refusé.
 *   2. La bande d’en-tête était calculée DANS la page, à partir d’une fraction
 *      de hauteur, et retenait tout élément qui y COMMENÇAIT — donc la première
 *      bulle, haute de cent pixels, qui déborde largement.
 *   3. La bande était ancrée sur le premier ancêtre portant un `aria-label`,
 *      pris pour le panneau. Il ne l’est pas : la barre de titre du
 *      correspondant est un FRÈRE de la liste des messages, et l’ancre tombait
 *      donc à côté de l’en-tête réel.
 *
 * Ce que ce module fait maintenant
 * ---------------------------------
 * Il cherche le CONTENEUR COMMUN qui englobe la barre de titre, la liste des
 * messages et le composeur — et il le cherche par des relations et des mesures
 * DOM, jamais par une classe Instagram (elles sont minifiées et changent à
 * chaque déploiement).
 *
 * La forme recherchée est celle d’un panneau de discussion, et elle se décrit
 * sans nommer personne : un conteneur qui contient le composeur, dont le
 * PREMIER ENFANT est une barre — large comme lui, haute de quelques dizaines de
 * pixels, posée sur son bord supérieur — et dont le composeur est situé sous
 * cette barre. C’est exactement « en-tête frère de la liste des messages ».
 *
 * Ce qui n’a pas bougé, et ne doit pas bouger
 * --------------------------------------------
 *   * les liens des bulles ne sont JAMAIS une identité — ils sont lus,
 *     journalisés, et n’entrent dans aucun verdict, ni pour accepter ni pour
 *     refuser ;
 *   * un handle exact dans l’en-tête reste le signal fort ;
 *   * un nom d’affichage ne vaut que CORROBORÉ par le titre de la page
 *     canonique du handle attendu, jamais seul ;
 *   * plusieurs panneaux plausibles qui ne disent pas la même chose ⇒ refus,
 *     jamais un choix arbitraire ;
 *   * en-tête absent ou illisible ⇒ refus.
 *
 * La page MESURE, le code pur DÉCIDE. C’est l’enseignement du deuxième refus :
 * une géométrie calculée dans le navigateur n’est éprouvable que sur un vrai
 * fil, et elle s’est trompée exactement là où un test l’aurait attrapée.
 */

// ---------------------------------------------------------------------------
// Ce que la page mesure
// ---------------------------------------------------------------------------

/** Un rectangle tel que la page l'a mesuré. Aucune interprétation. */
export interface ReadRect {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly width: number;
  readonly height: number;
}

/** Un ancêtre du composeur, mesuré, avec la forme de ses premiers enfants. */
export interface AncestorMeasure {
  /** 1 = parent direct du composeur. */
  readonly depth: number;
  readonly tag: string;
  readonly role: string | null;
  readonly ariaLabel: string | null;
  readonly rect: ReadRect;
  /** `main` ou `body` : la racine du document, jamais un panneau. */
  readonly isDocumentRoot: boolean;
  /** Les rectangles des premiers enfants directs, dans l'ordre du document. */
  readonly childRects: readonly ReadRect[];
}

export interface RawThreadIdentityRead {
  readonly composerRect: ReadRect | null;
  readonly viewport: { readonly width: number; readonly height: number } | null;
  /** Du plus proche au plus lointain. Bornée par `maxDepth`. */
  readonly ancestors: readonly AncestorMeasure[];
  readonly links: readonly { readonly handle: string; readonly rect: ReadRect }[];
  readonly texts: readonly { readonly text: string; readonly rect: ReadRect }[];
}

export const UNREADABLE_THREAD_READ: RawThreadIdentityRead = Object.freeze({
  composerRect: null,
  viewport: null,
  ancestors: Object.freeze([]),
  links: Object.freeze([]),
  texts: Object.freeze([]),
});

// ---------------------------------------------------------------------------
// Ce que le code pur en tire
// ---------------------------------------------------------------------------

export interface ThreadIdentityObservation {
  /** Un panneau — barre de titre + liste + composeur — a été identifié. */
  readonly panelFound: boolean;
  /** Plusieurs panneaux plausibles se contredisent. Refus, jamais un arbitrage. */
  readonly panelAmbiguous: boolean;
  /** L'en-tête du panneau portait quelque chose de lisible. */
  readonly headerFound: boolean;
  /** Handles lus DANS L'EN-TÊTE. Ce sont les seuls qui décident. */
  readonly headerHandles: readonly string[];
  /** Textes courts de l’en-tête — dont, en général, le nom d’affichage. */
  readonly headerTexts: readonly string[];
  /** Le libellé accessible du panneau retenu. */
  readonly panelLabel: string | null;
  /**
   * IG2.3 §1 — le rectangle du panneau retenu.
   *
   * Il ne sert pas à décider ici : il sert APRÈS, comme ancre du périmètre de
   * lecture post-clic. Le fil qu'on vient de confirmer est celui dans lequel il
   * faut regarder ce qui s'y est passé — redécouvrir une portée après l'effet
   * est ce qui a produit le mauvais verdict du 14 août.
   */
  readonly panelRect: ReadRect | null;
  /**
   * Handles lus AILLEURS que dans l’en-tête : mentions, reels partagés,
   * réponses à une story. Journalisés pour qu’un refus soit diagnosticable —
   * jamais consultés pour décider.
   */
  readonly bodyHandles: readonly string[];
  /** Les ancêtres traversés, pour qu’un refus se comprenne sans deviner. */
  readonly ancestorChain: readonly string[];
  /**
   * Les mesures brutes, rendues lisibles. Écrites dans le journal d'un refus :
   * sans elles, « aucun en-tête lisible » n'apprend rien à qui doit corriger.
   */
  readonly diagnostics: readonly string[];
}

export const UNREADABLE_THREAD_IDENTITY: ThreadIdentityObservation = Object.freeze({
  panelFound: false,
  panelAmbiguous: false,
  headerFound: false,
  headerHandles: Object.freeze([]),
  headerTexts: Object.freeze([]),
  panelLabel: null,
  panelRect: null,
  bodyHandles: Object.freeze([]),
  ancestorChain: Object.freeze([]),
  diagnostics: Object.freeze([]),
});

/**
 * Par quoi l’identité a été établie. Écrit dans le journal, parce que « le fil
 * est confirmé » ne dit pas la même chose selon la preuve qui l'a confirmé.
 */
export type ThreadIdentityVia =
  /** Le handle lui-même, lu dans l’en-tête. La preuve forte. */
  | 'header_handle'
  /** Le nom d’affichage, corroboré par le titre de la page de profil. Plus faible. */
  | 'header_display_name';

export type ThreadIdentityVerdict =
  | { readonly ok: true; readonly handle: string; readonly via: ThreadIdentityVia; readonly detail: string }
  | { readonly ok: false; readonly detail: string };

// ---------------------------------------------------------------------------
// Bornes
// ---------------------------------------------------------------------------

export interface ThreadIdentityLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxChildren: number;
  readonly maxTexts: number;
  readonly maxTextLength: number;
  /** Hauteur plausible d'une barre de titre de discussion. */
  readonly headerMinPx: number;
  readonly headerMaxPx: number;
  /** L'en-tête est posé sur le bord supérieur du panneau, à cette tolérance près. */
  readonly headerTopTolerancePx: number;
  /** Un en-tête occupe l'essentiel de la largeur de son panneau. */
  readonly headerMinWidthRatio: number;
  /** Un panneau n'est pas la page : il en occupe au plus cette fraction. */
  readonly panelMaxHeightRatio: number;
  readonly panelMaxWidthRatio: number;
}

export const THREAD_IDENTITY_LIMITS: ThreadIdentityLimits = Object.freeze({
  maxDepth: 18,
  maxNodes: 800,
  maxChildren: 8,
  maxTexts: 12,
  maxTextLength: 60,
  headerMinPx: 24,
  headerMaxPx: 96,
  headerTopTolerancePx: 4,
  headerMinWidthRatio: 0.6,
  panelMaxHeightRatio: 0.95,
  panelMaxWidthRatio: 0.95,
});

/**
 * HERMES-REAL-THREAD-PREVIEW-R1 §6/§11 — les mêmes bornes, sur une page où le
 * fil EST la page.
 *
 * ---------------------------------------------------------------------------
 * Ce que le premier vrai fil a montré
 * ---------------------------------------------------------------------------
 * Le 22 août 2026, la première inspection d'un vrai `/direct/t/<id>/` a mesuré
 * ceci (fenêtre 1280×900, composeur à y852..870) :
 *
 *     d12  div  y77..900   x472..1280   enfants=[77..822  822..900]
 *     d13  div  y0..900    x472..1280   enfants=[0..77    77..900]
 *
 * `d13` est EXACTEMENT le panneau que ce module cherche : une barre de titre de
 * 77 px en premier enfant, posée sur son bord supérieur, aussi large que lui,
 * et un composeur situé dessous. Il a pourtant été rejeté, par une seule
 * condition : sa hauteur vaut 900, soit 100 % de la fenêtre, et
 * `panelMaxHeightRatio` en admettait 95 %.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi ce n'est PAS un desserrement du gate
 * ---------------------------------------------------------------------------
 * Le plafond de hauteur n'a jamais protégé contre « un panneau trop grand ». Il
 * protégeait contre UNE situation précise, décrite dans `findPanelCandidates` :
 * sur le chemin du canari, la discussion s'ouvre en surimpression du PROFIL du
 * correspondant. Là, un conteneur pleine page aurait pour « bande supérieure »
 * l'en-tête du profil affiché derrière — qui porte évidemment le bon handle, et
 * ne prouverait rien sur le fil. Le ratio était un substitut à « ce n'est pas
 * une page de profil qu'on est en train de lire ».
 *
 * Sur `/direct/t/<id>/`, cette situation ne peut pas exister : il n'y a aucune
 * page de profil derrière, parce qu'il n'y a pas de surimpression — la
 * conversation occupe la page. Le substitut n'a donc plus rien à substituer, et
 * le maintenir ne rejette pas un faux panneau : il rejette le vrai.
 *
 * Ce qui NE change pas, et qui est ce qui décide vraiment :
 *
 *   * la barre de titre reste exigée en PREMIER ENFANT, haute de 24 à 96 px,
 *     posée sur le bord supérieur, large d'au moins 60 % du panneau, avec le
 *     composeur en dessous ;
 *   * les liens des bulles ne sont toujours pas une identité ;
 *   * plusieurs panneaux contradictoires refusent toujours ;
 *   * `panelMaxWidthRatio` reste à 0,95 — sur le vrai fil, la colonne de
 *     conversation mesure 808 px de large sur 1280, soit 63 %, parce que la
 *     barre latérale de navigation et la liste des conversations occupent la
 *     gauche. Une largeur pleine page reste donc suspecte, et le reste.
 *
 * Sur les mesures ci-dessus, ce jeu de bornes retient EXACTEMENT un candidat —
 * `d13`. Les conteneurs plus extérieurs sont écartés par les conditions
 * inchangées : `d14`, `d15` et `d16` n'ont qu'un seul enfant ; `d17` et `d18`
 * ont un premier enfant haut de 900 px ; `d12` en a un de 745 px.
 *
 * ---------------------------------------------------------------------------
 * Qui a le droit de s'en servir
 * ---------------------------------------------------------------------------
 * Uniquement un rail dont la lecture d'identité a lieu sur une URL de fil
 * VÉRIFIÉE. `PlaywrightInstagramThreadInspectionRail` le contrôle à
 * l'exécution — il refuse de lire l'en-tête tant que l'identifiant relu dans
 * l'URL ne concorde pas — et sa liste blanche de navigation
 * (`isAllowedReplyNavigation`) ne connaît de toute façon que la racine, une
 * page de profil et `/direct/t/<chiffres>/`.
 *
 * Le canari, lui, garde `THREAD_IDENTITY_LIMITS` : c'est SA situation que le
 * plafond protège.
 */
export const DIRECT_THREAD_IDENTITY_LIMITS: ThreadIdentityLimits = Object.freeze({
  ...THREAD_IDENTITY_LIMITS,
  panelMaxHeightRatio: 1,
});

// ---------------------------------------------------------------------------
// Géométrie — pure, donc vérifiable sur des nombres
// ---------------------------------------------------------------------------

export function contains(outer: ReadRect, inner: ReadRect, tolerance = 1): boolean {
  return (
    outer.top <= inner.top + tolerance &&
    outer.bottom >= inner.bottom - tolerance &&
    outer.left <= inner.left + tolerance &&
    outer.right >= inner.right - tolerance
  );
}

/** Entièrement dedans, jamais « commence dedans ». C'est le deuxième refus. */
export function fullyInside(rect: ReadRect, band: ReadRect, tolerance = 1): boolean {
  if (rect.width === 0 || rect.height === 0) return false;
  return rect.top >= band.top - tolerance && rect.bottom <= band.bottom + tolerance;
}

/**
 * Le premier enfant a-t-il la forme d'une barre de titre ?
 *
 * Quatre mesures, aucune classe : posée sur le bord supérieur, haute comme une
 * barre et pas comme une page, large comme son panneau, et au-dessus du
 * composeur. C'est la description géométrique de « en-tête frère de la liste
 * des messages ».
 */
export function looksLikeHeader(
  panel: ReadRect,
  child: ReadRect,
  composer: ReadRect,
  limits: ThreadIdentityLimits,
): boolean {
  if (child.width === 0 || child.height === 0) return false;
  if (child.top > panel.top + limits.headerTopTolerancePx) return false;
  if (child.height < limits.headerMinPx || child.height > limits.headerMaxPx) return false;
  if (panel.width > 0 && child.width < panel.width * limits.headerMinWidthRatio) return false;
  // Le composeur est SOUS l'en-tête. Sans cela, une barre d'outils flottant
  // au-dessus du champ de saisie ferait un en-tête très convaincant.
  return composer.top >= child.bottom;
}

export interface PanelCandidate {
  readonly ancestor: AncestorMeasure;
  readonly header: ReadRect;
}

export type PanelSelection =
  | { readonly kind: 'ok'; readonly candidate: PanelCandidate; readonly candidates: readonly PanelCandidate[] }
  | { readonly kind: 'none'; readonly detail: string }
  | { readonly kind: 'ambiguous'; readonly detail: string; readonly candidates: readonly PanelCandidate[] };

/**
 * Tous les ancêtres qui ont la forme d'un panneau de discussion.
 *
 * Un panneau contient le composeur, n'est pas la racine du document, ne prend
 * pas toute la page, et porte une barre de titre en premier enfant. Un
 * conteneur pleine page passerait les trois premières conditions et échouerait
 * la quatrième — et c'est heureux : sa « bande supérieure » serait l'en-tête du
 * profil affiché derrière, qui porte évidemment le bon handle et ne prouverait
 * rien sur le fil.
 */
export function findPanelCandidates(
  raw: RawThreadIdentityRead,
  limits: ThreadIdentityLimits,
): readonly PanelCandidate[] {
  const composer = raw.composerRect;
  const viewport = raw.viewport;
  if (composer === null || viewport === null) return [];

  const out: PanelCandidate[] = [];
  for (const ancestor of raw.ancestors) {
    if (ancestor.isDocumentRoot) break;
    const panel = ancestor.rect;
    if (panel.width === 0 || panel.height === 0) continue;
    if (viewport.height > 0 && panel.height > viewport.height * limits.panelMaxHeightRatio) continue;
    if (viewport.width > 0 && panel.width > viewport.width * limits.panelMaxWidthRatio) continue;
    if (!contains(panel, composer)) continue;
    // Un panneau a au moins deux régions : l'en-tête, et ce qu'il coiffe.
    if (ancestor.childRects.length < 2) continue;
    const first = ancestor.childRects[0];
    if (first === undefined) continue;
    if (!looksLikeHeader(panel, first, composer, limits)) continue;
    out.push({ ancestor, header: first });
  }
  return out;
}

function handlesInBand(
  raw: RawThreadIdentityRead,
  band: ReadRect,
): { readonly header: string[]; readonly body: string[] } {
  const header: string[] = [];
  const body: string[] = [];
  for (const link of raw.links) {
    if (link.rect.width === 0 || link.rect.height === 0) continue;
    const target = fullyInside(link.rect, band) ? header : body;
    if (!target.includes(link.handle)) target.push(link.handle);
  }
  return { header, body };
}

/**
 * Choisit le panneau, ou refuse.
 *
 * Le plus PROCHE du composeur gagne, parce qu'un panneau imbriqué dans un autre
 * décrit plus finement la même conversation. Mais si deux candidats ne
 * s'accordent pas sur l'identité qu'ils portent, aucun n'est retenu : la
 * mission l'exige en toutes lettres, et arbitrer serait exactement ce qu'un
 * rail d'envoi ne doit jamais faire.
 */
export function selectThreadPanel(raw: RawThreadIdentityRead, limits: ThreadIdentityLimits): PanelSelection {
  const candidates = findPanelCandidates(raw, limits);
  if (candidates.length === 0) {
    return {
      kind: 'none',
      detail:
        'aucun conteneur n’a la forme d’un panneau de discussion (composeur contenu, barre de titre en ' +
        'premier enfant, posée sur le bord supérieur, plus large que la moitié du panneau)',
    };
  }

  const sets = candidates.map((candidate) => handlesInBand(raw, candidate.header).header.map((h) => h.toLowerCase()));
  const nonEmpty = sets.filter((set) => set.length > 0);
  const conflicting = nonEmpty.some((set) => {
    const first = nonEmpty[0] ?? [];
    return set.length !== first.length || set.some((handle) => !first.includes(handle));
  });
  if (conflicting) {
    return {
      kind: 'ambiguous',
      candidates,
      detail:
        'plusieurs panneaux plausibles nomment des correspondants différents ' +
        `(${sets.map((set, i) => `#${i}:[${set.join(',') || '—'}]`).join(' ')}) — aucun n’est retenu`,
    };
  }

  const closest = candidates[0];
  if (closest === undefined) return { kind: 'none', detail: 'aucun candidat' };
  return { kind: 'ok', candidate: closest, candidates };
}

function describeRect(rect: ReadRect): string {
  return `y${Math.round(rect.top)}..${Math.round(rect.bottom)} x${Math.round(rect.left)}..${Math.round(rect.right)}`;
}

function describeAncestor(ancestor: AncestorMeasure): string {
  const name = `${ancestor.tag}${ancestor.role ? `[role=${ancestor.role}]` : ''}${
    ancestor.ariaLabel ? `[label=${ancestor.ariaLabel.slice(0, 24)}]` : ''
  }`;
  const children = ancestor.childRects.map((rect) => `${Math.round(rect.top)}..${Math.round(rect.bottom)}`).join(' ');
  return `d${ancestor.depth} ${name} ${describeRect(ancestor.rect)} enfants=[${children}]`;
}

/**
 * Range ce que la page a mesuré en « en-tête » et « corps ». Pure.
 */
export function classifyThreadIdentity(
  raw: RawThreadIdentityRead,
  limits: ThreadIdentityLimits,
): ThreadIdentityObservation {
  const chain = raw.ancestors.map((ancestor) => describeAncestor(ancestor));
  const diagnostics: string[] = [
    `composeur ${raw.composerRect === null ? 'non mesuré' : describeRect(raw.composerRect)}`,
    `viewport ${raw.viewport === null ? 'inconnu' : `${raw.viewport.width}x${raw.viewport.height}`}`,
    `liens ${raw.links.length}, textes ${raw.texts.length}`,
    ...chain,
  ];

  const selection = selectThreadPanel(raw, limits);
  if (selection.kind === 'none') {
    return { ...UNREADABLE_THREAD_IDENTITY, ancestorChain: chain, diagnostics: [selection.detail, ...diagnostics] };
  }
  if (selection.kind === 'ambiguous') {
    return {
      ...UNREADABLE_THREAD_IDENTITY,
      panelFound: true,
      panelAmbiguous: true,
      ancestorChain: chain,
      diagnostics: [selection.detail, ...diagnostics],
    };
  }

  const { ancestor, header } = selection.candidate;
  const split = handlesInBand(raw, header);

  const headerTexts: string[] = [];
  for (const entry of raw.texts) {
    if (headerTexts.length >= limits.maxTexts) break;
    if (!fullyInside(entry.rect, header)) continue;
    const text = entry.text.replace(/\s+/g, ' ').trim();
    if (text.length === 0 || text.length > limits.maxTextLength) continue;
    if (!headerTexts.includes(text)) headerTexts.push(text);
  }

  return {
    panelFound: true,
    panelAmbiguous: false,
    headerFound: split.header.length > 0 || headerTexts.length > 0,
    headerHandles: split.header,
    headerTexts,
    panelLabel: ancestor.ariaLabel,
    panelRect: ancestor.rect,
    bodyHandles: split.body,
    ancestorChain: chain,
    diagnostics: [
      `panneau retenu : ${describeAncestor(ancestor)}`,
      `en-tête : ${describeRect(header)}`,
      `candidats : ${selection.candidates.length}`,
      ...diagnostics,
    ],
  };
}

// ---------------------------------------------------------------------------
// Le verdict
// ---------------------------------------------------------------------------

function normalizeName(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Le handle porté par une URL de profil relative, ou `null`. */
export function handleFromRelativeHref(href: string): string | null {
  const match = /^\/([A-Za-z0-9._]{1,30})\/?$/.exec(href.split('?')[0] ?? '');
  return match?.[1] ?? null;
}

/**
 * Le handle écrit en toutes lettres dans un texte, isolé par des séparateurs.
 *
 * Jamais un simple `includes`, qui ferait passer « demo_prospect_a2 » pour
 * « demo_prospect_a » — le piège est exactement celui que la première version
 * évitait déjà, et il est conservé.
 */
export function textMentionsHandle(text: string, handle: string): boolean {
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9._])${escaped}([^A-Za-z0-9._]|$)`, 'i').test(text);
}

export interface ThreadIdentityInput {
  readonly observation: ThreadIdentityObservation;
  /** Le handle figé par l'intention. Le fil doit le porter, ou nommer son titulaire. */
  readonly expectedHandle: string;
  /**
   * Le nom d’affichage RELU sur la page de profil du handle attendu, via un
   * titre qui portait les deux (`Moha (@operator_second_account)`). `null` si on n’a pas pu
   * l'établir — auquel cas le nom d’affichage ne corrobore rien et ne sert pas.
   */
  readonly expectedDisplayName: string | null;
}

export function decideThreadIdentity(input: ThreadIdentityInput): ThreadIdentityVerdict {
  const { observation: o, expectedHandle } = input;
  const expected = expectedHandle.toLowerCase();
  const where = o.diagnostics.length > 0 ? ` [${o.diagnostics.slice(0, 6).join(' | ')}]` : '';

  if (o.panelAmbiguous) {
    return {
      ok: false,
      detail: `plusieurs panneaux plausibles et contradictoires — aucun arbitrage${where}`,
    };
  }
  if (!o.panelFound) {
    return { ok: false, detail: `aucun panneau de discussion identifiable autour du composeur${where}` };
  }
  if (!o.headerFound) {
    return {
      ok: false,
      detail:
        'l’en-tête du panneau n’a rien laissé lire — un fil qui ne se nomme pas ne peut pas être confirmé, ' +
        `et les liens de l’historique ne le nomment pas${where}`,
    };
  }

  // ---- 1. La preuve forte : le handle, dans l’en-tête ----------------------
  const headerHandles = o.headerHandles.map((handle) => handle.toLowerCase());
  const mentioned = o.headerTexts.some((text) => textMentionsHandle(text, expectedHandle));
  const labelMentions = o.panelLabel !== null && textMentionsHandle(o.panelLabel, expectedHandle);

  if (headerHandles.length > 0) {
    const foreign = headerHandles.filter((handle) => handle !== expected);
    if (foreign.length > 0) {
      return {
        ok: false,
        detail:
          `l’en-tête du panneau nomme « ${foreign.join(', ')} », attendu « ${expectedHandle} » — ` +
          'le fil ouvert n’est pas celui de la cible',
      };
    }
    return {
      ok: true,
      handle: expectedHandle,
      via: 'header_handle',
      detail: `handle « ${expectedHandle} » lu dans l’en-tête du panneau`,
    };
  }

  if (mentioned || labelMentions) {
    return {
      ok: true,
      handle: expectedHandle,
      via: 'header_handle',
      detail: `handle « ${expectedHandle} » écrit en toutes lettres dans l’en-tête du panneau`,
    };
  }

  // ---- 2. La preuve faible : le nom d’affichage, CORROBORÉ ------------------
  const expectedName = input.expectedDisplayName === null ? '' : normalizeName(input.expectedDisplayName);
  if (expectedName.length === 0) {
    return {
      ok: false,
      detail:
        `aucun handle dans l’en-tête, et le nom d’affichage de « ${expectedHandle} » n’a pas pu être établi ` +
        `sur sa page de profil — il n’y a rien à confronter, donc rien à confirmer. ` +
        `En-tête lu : ${o.headerTexts.join(' | ') || 'aucun texte'} ; libellé : ${o.panelLabel ?? 'aucun'}`,
    };
  }

  const candidates = [...o.headerTexts, ...(o.panelLabel === null ? [] : [o.panelLabel])].map(normalizeName);
  if (candidates.includes(expectedName)) {
    return {
      ok: true,
      handle: expectedHandle,
      via: 'header_display_name',
      detail:
        `l’en-tête ne porte pas le handle mais le nom d’affichage « ${input.expectedDisplayName ?? ''} », ` +
        `identique à celui déclaré par la page de profil de « ${expectedHandle} ». Preuve plus faible qu’un ` +
        'handle : un nom d’affichage n’est pas unique.',
    };
  }

  return {
    ok: false,
    detail:
      `l’en-tête du panneau ne porte ni le handle « ${expectedHandle} » ni son nom d’affichage ` +
      `« ${input.expectedDisplayName ?? ''} » — lu : ${o.headerTexts.join(' | ') || 'aucun texte'} ; ` +
      `libellé : ${o.panelLabel ?? 'aucun'}` +
      (o.bodyHandles.length > 0
        ? `. Handles vus dans l’HISTORIQUE (contenu, jamais destinataire) : ${o.bodyHandles.join(', ')}`
        : ''),
  };
}

// ---------------------------------------------------------------------------
// Le nom d’affichage du profil attendu
// ---------------------------------------------------------------------------

export interface ProfileTitleIdentity {
  readonly displayName: string;
  readonly handle: string;
}

/**
 * Extrait le couple « nom d’affichage, handle » du titre d'une page de profil.
 *
 * Instagram écrit les deux dans la même chaîne — « Moha (@operator_second_account) • Photos
 * et vidéos Instagram » — ce qui en fait une source où le nom est déjà rattaché
 * à son handle. C'est précisément ce dont la corroboration a besoin : un nom lu
 * quelque part ne vaudrait rien, un nom lu À CÔTÉ du handle attendu vaut
 * quelque chose.
 */
export function parseProfileTitle(raw: string | null): ProfileTitleIdentity | null {
  if (raw === null) return null;
  const match = /^(.+?)\s*\(@([A-Za-z0-9._]{1,30})\)/.exec(raw.replace(/\s+/g, ' ').trim());
  const displayName = match?.[1]?.trim();
  const handle = match?.[2];
  if (displayName === undefined || handle === undefined || displayName.length === 0) return null;
  return { displayName, handle };
}

/** Le nom d’affichage du handle attendu, ou `null` si le titre parle d'un autre. */
export function displayNameForHandle(rawTitle: string | null, expectedHandle: string): string | null {
  const parsed = parseProfileTitle(rawTitle);
  if (parsed === null) return null;
  if (parsed.handle.toLowerCase() !== expectedHandle.toLowerCase()) return null;
  return parsed.displayName;
}

// ---------------------------------------------------------------------------
// La lecture dans la page
// ---------------------------------------------------------------------------

/**
 * Le corps évalué dans la page, exporté pour être inspectable par un test.
 *
 * Il MESURE et ne décide rien : pas de bande, pas de panneau, pas de verdict.
 * Tout ce qui ressemble à un choix vit dans le code pur au-dessus, où un test
 * peut le prendre en défaut sans navigateur.
 *
 * Expression de fonction anonyme, sans aucune fonction nommée à l'intérieur :
 * une fonction nommée dans un corps évalué lève `ReferenceError: __name is not
 * defined`, et le 14 août cet échec s'est déguisé en mesure vide. Même
 * convention que `HARVEST_THREAD_IN_PAGE` et `READ_RELATIONSHIP_IN_PAGE`.
 */
export const READ_THREAD_IDENTITY_IN_PAGE = function (
  node: Element,
  limits: ThreadIdentityLimits,
): RawThreadIdentityRead {
  const box = node.getBoundingClientRect();
  const composerRect = {
    top: box.top,
    bottom: box.bottom,
    left: box.left,
    right: box.right,
    width: box.width,
    height: box.height,
  };

  const ancestors: AncestorMeasure[] = [];
  let element: Element | null = node.parentElement;
  let outermost: Element | null = null;

  for (let depth = 1; depth <= limits.maxDepth && element !== null; depth += 1) {
    const tag = element.tagName.toLowerCase();
    const isDocumentRoot = tag === 'main' || tag === 'body' || tag === 'html';
    const rect = element.getBoundingClientRect();

    const childRects: ReadRect[] = [];
    for (const child of Array.from(element.children).slice(0, limits.maxChildren)) {
      const childBox = child.getBoundingClientRect();
      childRects.push({
        top: childBox.top,
        bottom: childBox.bottom,
        left: childBox.left,
        right: childBox.right,
        width: childBox.width,
        height: childBox.height,
      });
    }

    ancestors.push({
      depth,
      tag,
      role: element.getAttribute('role'),
      ariaLabel: element.getAttribute('aria-label'),
      rect: {
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        width: rect.width,
        height: rect.height,
      },
      isDocumentRoot,
      childRects,
    });

    if (isDocumentRoot) break;
    outermost = element;
    element = element.parentElement;
  }

  // Les liens et textes sont récoltés depuis le plus grand ancêtre NON racine :
  // le panneau retenu en fait forcément partie, et la géométrie fera le tri.
  const root: Element = outermost ?? node;

  const links: { handle: string; rect: ReadRect }[] = [];
  for (const link of Array.from(root.querySelectorAll('a[href^="/"]')).slice(0, limits.maxNodes)) {
    const href = (link.getAttribute('href') ?? '').split('?')[0] ?? '';
    const match = /^\/([A-Za-z0-9._]{1,30})\/?$/.exec(href);
    const handle = match?.[1];
    if (handle === undefined) continue;
    const linkBox = link.getBoundingClientRect();
    if (linkBox.width === 0 || linkBox.height === 0) continue;
    links.push({
      handle,
      rect: {
        top: linkBox.top,
        bottom: linkBox.bottom,
        left: linkBox.left,
        right: linkBox.right,
        width: linkBox.width,
        height: linkBox.height,
      },
    });
  }

  const texts: { text: string; rect: ReadRect }[] = [];
  for (const candidate of Array.from(root.querySelectorAll('h1, h2, h3, span, div')).slice(0, limits.maxNodes)) {
    const textBox = candidate.getBoundingClientRect();
    if (textBox.width === 0 || textBox.height === 0) continue;
    const text = ((candidate as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim();
    if (text.length === 0 || text.length > limits.maxTextLength) continue;
    texts.push({
      text,
      rect: {
        top: textBox.top,
        bottom: textBox.bottom,
        left: textBox.left,
        right: textBox.right,
        width: textBox.width,
        height: textBox.height,
      },
    });
  }

  return {
    composerRect,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    ancestors,
    links,
    texts,
  };
};
