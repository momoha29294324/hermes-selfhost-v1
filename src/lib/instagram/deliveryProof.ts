import type { InboxWitness } from '@/lib/instagram/inboxScan';
import { wasThreadBumped } from '@/lib/instagram/inboxScan';
import type {
  AncestorLevel,
  ObservedHandleLink,
  ObservedNode,
  ObservedRect,
} from '@/lib/instagram/threadObservation';
import { normalizeHandle } from '@/lib/instagram/identity';

/**
 * IG2.1 §3/§4/§6 — la preuve d'envoi, entièrement pure.
 *
 * Pourquoi ce module existe
 * --------------------------
 * Le 14 août, un DM a été cliqué et le rail a rendu « 0 → 0 occurrence du texte
 * exact », alors que la capture d'écran prise trois secondes plus tard montrait
 * la bulle. Le verdict `AMBIGUOUS` était donc juste par accident : il disait
 * « je n'ai pas vu », ce qui était vrai, mais pour une raison que personne ne
 * pouvait tester — le périmètre de recherche était choisi à l'intérieur de
 * `page.evaluate`, par un `break` sur le premier ancêtre du composeur portant un
 * `aria-label`.
 *
 * Ce que ce module change, en une phrase : plus AUCUNE décision ne se prend
 * dans la page. La page mesure (`threadHarvest.ts`), ce fichier décide, et
 * chacune de ses décisions s'exerce sur une observation reconstituée à la main.
 *
 * Les quatre pièges qu'il traite nommément, parce qu'ils étaient tous plausibles
 * ---------------------------------------------------------------------------
 *   1. **Périmètre.** `chooseThreadScope` retient le premier ancêtre qui
 *      contient une CONVERSATION — mesurée, pas devinée : des éléments porteurs
 *      de texte hors du composeur, et une hauteur sans commune mesure avec
 *      celle d'un champ de saisie.
 *   2. **Texte réparti sur plusieurs nœuds.** La comparaison porte sur
 *      `textContent`, qui concatène tous les descendants — un message découpé
 *      en dix `<span>` se lit d'un seul tenant. Puis seul l'élément le plus
 *      PROFOND portant ce texte est retenu, pour ne pas compter un message
 *      autant de fois qu'il a d'ancêtres.
 *   3. **Apostrophes et Unicode.** `normalizeMessageText` ramène apostrophes
 *      typographiques, guillemets, tirets, espaces insécables et caractères de
 *      largeur nulle à une forme unique, après `NFC`. Le texte approuvé du
 *      manifeste porte des `’` ; un composeur, un collage ou un rendu peuvent
 *      porter des `'`.
 *   4. **Échec de livraison.** Un message qui n'est pas parti reste AFFICHÉ,
 *      aligné à droite comme un message envoyé, avec un marqueur d'erreur à
 *      côté. Les quatre preuves « positives » du premier canari décrivaient donc
 *      aussi, mot pour mot, un échec — et auraient conclu `SENT`.
 */

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Les classes ci-dessous sont écrites en séquences d'échappement, jamais avec
 * le caractère lui-même : une espace insécable et une espace ordinaire sont
 * indiscernables dans un éditeur, et une césure conditionnelle est carrément
 * invisible. Un motif qu'on ne peut pas RELIRE n'est pas une garde.
 */
/** Caractères invisibles : césure conditionnelle, largeurs nulles, marque d'ordre. */
const INVISIBLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;
/** Apostrophes et primes, typographiques ou modificatives. */
const APOSTROPHES = /[\u2018\u2019\u201A\u201B\u2032\u02BC\u02B9\u0060\u00B4]/g;
/** Guillemets doubles typographiques. */
const QUOTES = /[\u201C\u201D\u201E\u201F\u2033]/g;
/** Tirets : demi-cadratin, cadratin, moins, et leurs voisins. */
const DASHES = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g;
/** Points de suspension composés. */
const ELLIPSIS = /\u2026/g;
/** Toute forme d'espace, y compris insécable, fine et idéographique. */
const SPACES = /[\s\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+/g;

/**
 * La forme sous laquelle deux textes sont « le même texte pour un humain ».
 *
 * Ce qu'elle NE fait pas : mettre en minuscules, retirer la ponctuation,
 * tronquer, ni rapprocher deux textes « assez proches ». Une casse différente
 * ou un mot en moins font un AUTRE message, et un rail qui les confondrait
 * prouverait l'envoi d'un texte que personne n'a approuvé.
 */
export function normalizeMessageText(value: string): string {
  return value
    .normalize('NFC')
    .replace(INVISIBLE, '')
    .replace(APOSTROPHES, "'")
    .replace(QUOTES, '"')
    .replace(DASHES, '-')
    .replace(ELLIPSIS, '...')
    .replace(SPACES, ' ')
    .trim();
}

/** Idem pour un libellé accessible : minuscules incluses, car on y cherche des motifs. */
export function normalizeLabel(value: string | null): string {
  return value === null ? '' : normalizeMessageText(value).toLowerCase();
}

// ---------------------------------------------------------------------------
// Périmètre du fil
// ---------------------------------------------------------------------------

/**
 * Un niveau qui contient une conversation porte du texte AILLEURS que dans le
 * composeur. Trois éléments : de quoi distinguer un fil (horodatage, bulle,
 * en-tête) d'une barre de saisie, qui n'en porte aucun — ses deux boutons sont
 * des icônes, donc `textContent` vide.
 */
export const MIN_TEXT_BEARING_OUTSIDE_COMPOSER = 3;

/**
 * Et il est plus haut qu'un champ de saisie. Le facteur 2 est délibérément bas :
 * il ne sert pas à reconnaître un fil, il sert à écarter le conteneur immédiat
 * du composeur — celui qui a fait échouer le premier canari.
 */
export const MIN_SCOPE_HEIGHT_RATIO = 2;

export type ScopeKind = 'thread' | 'document_root' | 'none';

export interface ScopeChoice {
  readonly kind: ScopeKind;
  /** Index dans `ancestorChain`. `-1` quand aucun périmètre n'a pu être retenu. */
  readonly level: number;
  readonly rect: ObservedRect | null;
  readonly detail: string;
  /** Pourquoi chaque niveau plus petit a été écarté. Un refus doit être lisible. */
  readonly rejected: readonly string[];
}

/** Tolérance, en pixels, pour reconnaître un niveau comme étant le panneau ancré. */
export const ANCHOR_MATCH_TOLERANCE_PX = 6;

export interface ScopeOptions {
  /**
   * IG2.3 §1 — le panneau de conversation VALIDÉ avant l'effet.
   *
   * Quand il existe, il commande, et le reste de l'heuristique ne sert plus
   * qu'à décrire. C'est la correction du 14 août : après le clic, le périmètre
   * était redécouvert de zéro et retombait au « niveau 1 (div) », un conteneur
   * de quelques dizaines de pixels collé au composeur. Le message vivait dix
   * niveaux plus haut, donc la recherche de bulles ne trouvait rien, le handle
   * du fil devenait illisible, et un envoi réel ressortait en `AMBIGUOUS`.
   *
   * Redécouvrir une portée après le clic n'a jamais eu de sens : on venait de
   * confirmer l'identité du fil DANS un panneau précis, et c'est dans ce
   * panneau-là, pas dans un autre, qu'il faut regarder ce qui s'y est passé.
   */
  readonly anchor?: ObservedRect | null;
  /**
   * Le niveau minimal acceptable — celui qui contient déjà le texte approuvé.
   *
   * Utilisé quand aucun panneau n'a été validé en amont (chemin d'adjudication,
   * qui rouvre une page neuve). Un périmètre trop petit pour contenir le
   * message qu'on cherche ne peut rien prouver à son sujet ; l'exiger empêche
   * la même retombée sans inventer de seuil de hauteur arbitraire.
   */
  readonly minLevel?: number | null;
}

/**
 * Choisit le périmètre du fil.
 *
 * Deux régimes, et le premier l'emporte :
 *
 *   1. ANCRÉ — un panneau a été validé avant l'effet. Le périmètre est le
 *      niveau qui lui correspond, et aucun autre. S'il a disparu du DOM entre
 *      la validation et la lecture, on refuse : c'est fail-closed, parce qu'un
 *      repli sur « le plus petit qui ressemble à une conversation » est
 *      exactement ce qui a produit le mauvais verdict.
 *   2. HEURISTIQUE — aucun ancrage disponible. Le plus PETIT ancêtre qui
 *      contient une conversation, et qui contient au moins le texte cherché
 *      quand on sait où il est.
 *
 * « Le plus petit » compte autant que « qui contient une conversation ».
 * Prendre la page entière ferait passer une légende de publication ou un
 * commentaire pour une bulle de message — sur un profil professionnel, le
 * panneau de discussion s'ouvre DANS la page, au milieu de la grille de
 * publications.
 *
 * `main` et `body` sont acceptés en dernier recours et NOMMÉS comme tels
 * (`document_root`) : c'est un périmètre qui ne prouve pas grand-chose, et
 * `adjudicateDelivery` refuse d'en tirer un `SENT`.
 */
export function chooseThreadScope(chain: readonly AncestorLevel[], options: ScopeOptions = {}): ScopeChoice {
  const anchor = options.anchor ?? null;
  if (anchor !== null) return chooseAnchoredScope(chain, anchor);

  const minLevel = options.minLevel ?? null;
  const rejected: string[] = [];
  for (const level of chain) {
    if (minLevel !== null && level.index < minLevel) {
      rejected.push(
        `niveau ${level.index} (${level.tag}) : trop petit pour contenir le texte cherché, ` +
          `qui vit au niveau ${minLevel}`,
      );
      continue;
    }
    const hasText = level.textBearingOutsideComposer >= MIN_TEXT_BEARING_OUTSIDE_COMPOSER;
    const tallEnough = level.heightRatio >= MIN_SCOPE_HEIGHT_RATIO;
    const label = `niveau ${level.index} (${level.tag}${level.role === null ? '' : `[role=${level.role}]`}` +
      `${level.ariaLabel === null ? '' : `[label=${level.ariaLabel.slice(0, 30)}]`})`;

    if (!hasText || !tallEnough) {
      rejected.push(
        `${label} : ${level.textBearingOutsideComposer} élément(s) porteur(s) de texte hors composeur ` +
          `(seuil ${MIN_TEXT_BEARING_OUTSIDE_COMPOSER}), hauteur ×${level.heightRatio.toFixed(1)} ` +
          `(seuil ×${MIN_SCOPE_HEIGHT_RATIO})`,
      );
      continue;
    }

    return {
      kind: level.isDocumentRoot ? 'document_root' : 'thread',
      level: level.index,
      rect: level.rect,
      detail: level.isDocumentRoot
        ? `${label} — racine du document : périmètre trop large pour prouver un envoi`
        : `${label} — ${level.textBearingOutsideComposer} élément(s) porteur(s) de texte hors composeur, ` +
          `hauteur ×${level.heightRatio.toFixed(1)}`,
      rejected: Object.freeze(rejected),
    };
  }

  return {
    kind: 'none',
    level: -1,
    rect: null,
    detail:
      chain.length === 0
        ? 'aucune chaîne d’ancêtres lisible autour du composeur'
        : 'aucun ancêtre du composeur ne contient de conversation — le fil n’a pas été identifié',
    rejected: Object.freeze(rejected),
  };
}

/** Deux rectangles décrivent-ils le même conteneur, aux arrondis près ? */
function sameRect(a: ObservedRect, b: ObservedRect, tolerance: number): boolean {
  return (
    Math.abs(a.top - b.top) <= tolerance &&
    Math.abs(a.bottom - b.bottom) <= tolerance &&
    Math.abs(a.left - b.left) <= tolerance &&
    Math.abs(a.right - b.right) <= tolerance
  );
}

function enclosesRect(outer: ObservedRect, inner: ObservedRect, tolerance: number): boolean {
  return (
    outer.top <= inner.top + tolerance &&
    outer.bottom >= inner.bottom - tolerance &&
    outer.left <= inner.left + tolerance &&
    outer.right >= inner.right - tolerance
  );
}

/**
 * Le niveau qui correspond au panneau validé, ou aucun.
 *
 * L'égalité de rectangle est tentée d'abord — c'est le même conteneur, il a le
 * même cadre. À défaut, le plus petit niveau qui l'ENGLOBE : entre la
 * validation et la lecture, Instagram peut avoir inséré une enveloppe, et le
 * panneau se retrouve alors un cran plus bas dans la chaîne.
 *
 * Rien d'autre n'est accepté. Un niveau plus PETIT que le panneau validé ne
 * peut pas être le fil qu'on vient de confirmer — c'est précisément l'erreur
 * qu'on corrige.
 */
function chooseAnchoredScope(chain: readonly AncestorLevel[], anchor: ObservedRect): ScopeChoice {
  const rejected: string[] = [];

  for (const level of chain) {
    if (sameRect(level.rect, anchor, ANCHOR_MATCH_TOLERANCE_PX)) {
      return {
        kind: level.isDocumentRoot ? 'document_root' : 'thread',
        level: level.index,
        rect: level.rect,
        detail:
          `niveau ${level.index} (${level.tag}) — panneau validé avant l’effet, retrouvé à l’identique ` +
          `(${describeRect(anchor)})`,
        rejected: Object.freeze(rejected),
      };
    }
    rejected.push(`niveau ${level.index} (${level.tag}) : ${describeRect(level.rect)} ≠ panneau validé`);
  }

  for (const level of chain) {
    if (enclosesRect(level.rect, anchor, ANCHOR_MATCH_TOLERANCE_PX)) {
      return {
        kind: level.isDocumentRoot ? 'document_root' : 'thread',
        level: level.index,
        rect: level.rect,
        detail:
          `niveau ${level.index} (${level.tag}) — plus petit niveau englobant le panneau validé ` +
          `(${describeRect(anchor)} ⊂ ${describeRect(level.rect)})`,
        rejected: Object.freeze(rejected),
      };
    }
  }

  return {
    kind: 'none',
    level: -1,
    rect: null,
    detail:
      `le panneau validé avant l’effet (${describeRect(anchor)}) n’a pas été retrouvé dans la chaîne ` +
      'd’ancêtres après le clic — aucun repli sur un autre périmètre, la lecture s’arrête',
    rejected: Object.freeze(rejected),
  };
}

function describeRect(rect: ObservedRect): string {
  return `y${Math.round(rect.top)}..${Math.round(rect.bottom)} x${Math.round(rect.left)}..${Math.round(rect.right)}`;
}

// ---------------------------------------------------------------------------
// Occurrences du texte approuvé
// ---------------------------------------------------------------------------

export interface MatchedBubble {
  readonly nodeId: number;
  readonly level: number;
  readonly rect: ObservedRect;
  readonly outgoing: boolean;
  readonly outgoingBasis: 'geometry' | 'accessible' | 'both' | 'none';
  /** Position du centre de la bulle dans la largeur du fil, de 0 (gauche) à 1 (droite). */
  readonly centerRatio: number;
  readonly ariaLabel: string | null;
}

/**
 * Ce que l'UI dit d'un message SORTANT en toutes lettres, quand elle le dit.
 *
 * Préféré à la géométrie quand il est présent : un libellé accessible survit à
 * un changement de mise en page, une position non.
 */
export const OUTGOING_LABELS: readonly RegExp[] = [
  /vous avez envoy[ée]/i,
  /envoy[ée] par vous/i,
  /\byou sent\b/i,
  /\bsent by you\b/i,
];

function parentChain(node: ObservedNode, byId: ReadonlyMap<number, ObservedNode>): ObservedNode[] {
  const chain: ObservedNode[] = [];
  let current: ObservedNode | undefined = node;
  for (let guard = 0; guard < 40 && current !== undefined; guard += 1) {
    chain.push(current);
    const parentId: number | null = current.parentId;
    current = parentId === null ? undefined : byId.get(parentId);
  }
  return chain;
}

/**
 * Retrouve les occurrences VISIBLES du texte approuvé dans le périmètre du fil.
 *
 * Trois règles, toutes nées d'un piège réel :
 *
 *   * `textContent` normalisé, jamais les nœuds texte pris un par un : un
 *     message découpé en plusieurs `<span>` reste un message ;
 *   * seul l'élément le plus PROFOND portant le texte est retenu — sinon un
 *     message compterait autant de fois qu'il a d'ancêtres ;
 *   * le sous-arbre du COMPOSEUR (`level < 0`) est exclu : un brouillon
 *     ressemble au message, et n'est pas un envoi.
 */
export function findApprovedTextBubbles(
  nodes: readonly ObservedNode[],
  scope: ScopeChoice,
  approvedText: string,
): MatchedBubble[] {
  const scopeRect = scope.rect;
  if (scope.kind === 'none' || scopeRect === null) return [];
  const target = normalizeMessageText(approvedText);
  if (target.length === 0) return [];

  const inScope = nodes.filter((node) => node.level >= 0 && node.level <= scope.level);
  const byId = new Map(inScope.map((node) => [node.id, node]));
  const matched = inScope.filter((node) => node.visible && normalizeMessageText(node.text) === target);

  // Le plus profond seulement : un nœud dont un descendant porte le même texte
  // n'est pas la bulle, c'est un conteneur.
  const matchedIds = new Set(matched.map((node) => node.id));
  const containers = new Set<number>();
  for (const node of matched) {
    for (const ancestor of parentChain(node, byId).slice(1)) {
      if (matchedIds.has(ancestor.id)) containers.add(ancestor.id);
    }
  }

  const width = scopeRect.right - scopeRect.left;
  const middle = scopeRect.left + width / 2;

  return matched
    .filter((node) => !containers.has(node.id))
    .map((node) => {
      const center = (node.rect.left + node.rect.right) / 2;
      const geometry = width > 0 && center > middle;
      const accessible = parentChain(node, byId).some((ancestor) =>
        OUTGOING_LABELS.some((pattern) => pattern.test(normalizeLabel(ancestor.ariaLabel))),
      );
      const basis: MatchedBubble['outgoingBasis'] =
        geometry && accessible ? 'both' : geometry ? 'geometry' : accessible ? 'accessible' : 'none';
      return Object.freeze({
        nodeId: node.id,
        level: node.level,
        rect: node.rect,
        outgoing: geometry || accessible,
        outgoingBasis: basis,
        centerRatio: width > 0 ? (center - scopeRect.left) / width : 0,
        ariaLabel: node.ariaLabel,
      });
    });
}

// ---------------------------------------------------------------------------
// Marqueur d'échec de livraison
// ---------------------------------------------------------------------------

/**
 * Ce qu'Instagram écrit quand un message n'est PAS parti — dans un libellé
 * accessible, un `title`, ou le texte visible.
 *
 * Ces motifs sont classés en deux forces, et la distinction décide du verdict :
 *
 *   * EXPLICITE — la phrase dit l'échec (« non envoyé », « not delivered »,
 *     « échec de l'envoi »). Un seul suffit à conclure `DELIVERY_FAILED` ;
 *   * REPRISE — la phrase propose de recommencer (« réessayer », « retry »).
 *     C'est un indice fort mais pas une affirmation : certaines interfaces
 *     offrent « renvoyer » sur un message parfaitement délivré. Il ne conclut
 *     qu'accompagné d'une corroboration visuelle (marqueur rouge accolé).
 */
const EXPLICIT_FAILURE_LABELS: readonly RegExp[] = [
  /non\s+(envoy[ée]|remis|distribu[ée]|d[ée]livr[ée])/i,
  /message\s+non\s+envoy[ée]/i,
  /n['’ ]a\s+pas\s+(pu\s+)?[ée]t[ée]\s+envoy[ée]/i,
  /[ée]chec\s+(de\s+l['’ ]envoi|d['’ ]envoi|de\s+la\s+remise)/i,
  /\bnot\s+(sent|delivered)\b/i,
  /\bfailed\s+to\s+send\b/i,
  /\bcould\s?n['’]?t\s+be\s+sent\b/i,
  /\bmessage\s+failed\b/i,
  /\bunable\s+to\s+send\b/i,
];

const RETRY_LABELS: readonly RegExp[] = [
  /r[ée]essayer/i,
  /\bretry\b/i,
  /\btry\s+again\b/i,
  /renvoyer\s+le\s+message/i,
  /\bresend\b/i,
];

export type FailureStrength = 'explicit' | 'retry' | 'visual';

export interface FailureMarker {
  readonly nodeId: number;
  readonly strength: FailureStrength;
  readonly source: 'aria-label' | 'title' | 'text' | 'glyph';
  readonly label: string;
  readonly reddish: boolean;
  readonly rect: ObservedRect;
  readonly bubbleNodeId: number;
  /** IG2.3 — le marqueur touche-t-il une bulle SORTANTE ? Exigé pour le signal visuel. */
  readonly adjacentToOutgoing: boolean;
}

/** Distance verticale et horizontale tolérée entre une bulle et son marqueur textuel. */
const MARKER_VERTICAL_SLACK = 16;
const MARKER_HORIZONTAL_SLACK = 140;

/**
 * IG2.3 — bornes du marqueur VISUEL, plus serrées que celles d'un libellé.
 *
 * Le ⊗ rouge d'Instagram est une pastille collée au coin de la bulle. Un
 * libellé « réessayer » peut vivre à cent pixels ; une icône d'échec, non — et
 * accepter la même tolérance pour elle ferait passer n'importe quelle pastille
 * rouge de la page (badge de notification, point d'activité) pour un échec de
 * livraison.
 */
const GLYPH_VERTICAL_SLACK = 24;
const GLYPH_HORIZONTAL_SLACK = 32;
/** Une icône, pas un bloc : au-delà, c'est autre chose qui se trouve être rouge. */
export const MAX_GLYPH_SIZE_PX = 32;

function isAdjacent(marker: ObservedRect, bubble: ObservedRect, vertical: number, horizontal: number): boolean {
  const verticallyNear = marker.bottom >= bubble.top - vertical && marker.top <= bubble.bottom + vertical;
  const horizontallyNear = marker.left <= bubble.right + horizontal && marker.right >= bubble.left - horizontal;
  return verticallyNear && horizontallyNear;
}

/** Un élément de la taille d'une icône, et de cette taille seulement. */
export function isGlyphSized(rect: ObservedRect): boolean {
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;
  return width > 0 && height > 0 && width <= MAX_GLYPH_SIZE_PX && height <= MAX_GLYPH_SIZE_PX;
}

/**
 * Le style de cet élément a-t-il pu être LU ?
 *
 * `color` et `fill` tous deux absents veut dire que `getComputedStyle` n'a rien
 * rendu — pas que l'élément est neutre. La différence décide : une pastille
 * dont on ne peut pas lire la couleur n'est pas « pas rouge », elle est
 * « illisible », et une observation illisible ne doit jamais autoriser un
 * `SENT`. Même règle que `harvestReadable` et `decideIdentity`.
 */
export function hasReadableStyle(node: ObservedNode): boolean {
  return node.color !== null || node.fill !== null;
}

/**
 * Une couleur « rouge », lue sur `color` ou `fill`.
 *
 * Corroboration seulement. Une couleur nomme un style, jamais un état — et une
 * charte peut changer. Elle ne conclut donc rien seule ; elle appuie un marqueur
 * de reprise qui, sans elle, resterait une offre banale.
 */
export function isReddish(value: string | null): boolean {
  if (value === null) return false;
  const match = /rgba?\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})/i.exec(value);
  if (match === null) return false;
  const red = Number(match[1]);
  const green = Number(match[2]);
  const blue = Number(match[3]);
  if (!Number.isFinite(red) || !Number.isFinite(green) || !Number.isFinite(blue)) return false;
  return red >= 140 && red >= green * 1.6 && red >= blue * 1.6;
}

/**
 * Cherche, autour de chaque bulle retenue, ce qu'Instagram affiche quand un
 * message n'est pas parti.
 *
 * La proximité est exigée : un « Réessayer » trouvé à l'autre bout du panneau
 * ne parle pas de CE message. C'est la même règle que pour le contrôle d'envoi
 * du canari — un libellé isolé ne désigne rien tant qu'on ne sait pas à quoi il
 * est accolé.
 */
export function findFailureMarkers(
  nodes: readonly ObservedNode[],
  scope: ScopeChoice,
  bubbles: readonly MatchedBubble[],
): FailureMarker[] {
  if (scope.kind === 'none' || scope.rect === null || bubbles.length === 0) return [];
  const inScope = nodes.filter((node) => node.level >= 0 && node.level <= scope.level && node.visible);
  const bubbleIds = new Set(bubbles.map((bubble) => bubble.nodeId));
  const markers: FailureMarker[] = [];

  for (const bubble of bubbles) {
    for (const node of inScope) {
      if (bubbleIds.has(node.id)) continue;

      const text = normalizeMessageText(node.text);
      const reddish = isReddish(node.color) || isReddish(node.fill);

      // ---- Le libellé, quand l'interface écrit son échec ------------------
      if (isAdjacent(node.rect, bubble.rect, MARKER_VERTICAL_SLACK, MARKER_HORIZONTAL_SLACK)) {
        const candidates: { source: FailureMarker['source']; label: string }[] = [
          { source: 'aria-label', label: normalizeLabel(node.ariaLabel) },
          { source: 'title', label: normalizeLabel(node.title) },
          // Le texte visible d'un élément accolé — borné, pour ne pas relire la
          // bulle elle-même à travers un ancêtre.
          { source: 'text', label: text.slice(0, 120).toLowerCase() },
        ];

        let labelled = false;
        for (const candidate of candidates) {
          if (candidate.label.length === 0) continue;
          const explicit = EXPLICIT_FAILURE_LABELS.some((pattern) => pattern.test(candidate.label));
          const retry = !explicit && RETRY_LABELS.some((pattern) => pattern.test(candidate.label));
          if (!explicit && !retry) continue;
          markers.push(
            Object.freeze({
              nodeId: node.id,
              strength: explicit ? ('explicit' as const) : ('retry' as const),
              source: candidate.source,
              label: candidate.label.slice(0, 120),
              reddish,
              rect: node.rect,
              bubbleNodeId: bubble.nodeId,
              adjacentToOutgoing: bubble.outgoing,
            }),
          );
          labelled = true;
          break;
        }
        if (labelled) continue;
      }

      // ---- IG2.3 — la pastille rouge, quand l'interface ne dit rien -------
      //
      // Le LIVE du 14 août l'a affichée et l'adjudication ne l'a pas vue : elle
      // ne cherchait que des mots, et cette pastille n'en porte aucun. Quatre
      // conditions, toutes nécessaires, et volontairement étroites — une
      // couleur nomme un style, pas un état, donc elle ne conclut que très
      // encadrée : collée à la bulle, de la taille d'une icône, rouge, et
      // muette (un bloc rouge qui PARLE relèverait des règles ci-dessus).
      if (!reddish) continue;
      if (!isGlyphSized(node.rect)) continue;
      if (text.length > 0) continue;
      if (!isAdjacent(node.rect, bubble.rect, GLYPH_VERTICAL_SLACK, GLYPH_HORIZONTAL_SLACK)) continue;

      markers.push(
        Object.freeze({
          nodeId: node.id,
          strength: 'visual' as const,
          source: 'glyph' as const,
          label: `pastille rouge ${Math.round(node.rect.right - node.rect.left)}×${Math.round(
            node.rect.bottom - node.rect.top,
          )} px accolée à la bulle`,
          reddish: true,
          rect: node.rect,
          bubbleNodeId: bubble.nodeId,
          adjacentToOutgoing: bubble.outgoing,
        }),
      );
    }
  }

  return markers;
}

/**
 * Les pastilles accolées à une bulle SORTANTE dont le style n'a pas pu être lu.
 *
 * Elles ne prouvent rien — c'est le sujet. Une icône de la bonne taille, au bon
 * endroit, dont on ignore la couleur, est exactement l'endroit où un échec
 * pourrait se cacher. Tant qu'il en reste une, `SENT` est refusé : « je n'ai
 * pas pu lire » n'est pas « c'est bon ».
 */
export function findUnreadableAdjacentGlyphs(
  nodes: readonly ObservedNode[],
  scope: ScopeChoice,
  bubbles: readonly MatchedBubble[],
): readonly ObservedNode[] {
  if (scope.kind === 'none' || scope.rect === null) return [];
  const outgoing = bubbles.filter((bubble) => bubble.outgoing);
  if (outgoing.length === 0) return [];
  const bubbleIds = new Set(bubbles.map((bubble) => bubble.nodeId));

  return nodes.filter((node) => {
    if (node.level < 0 || node.level > scope.level || !node.visible) return false;
    if (bubbleIds.has(node.id)) return false;
    if (hasReadableStyle(node)) return false;
    if (!isGlyphSized(node.rect)) return false;
    if (normalizeMessageText(node.text).length > 0) return false;
    return outgoing.some((bubble) =>
      isAdjacent(node.rect, bubble.rect, GLYPH_VERTICAL_SLACK, GLYPH_HORIZONTAL_SLACK),
    );
  });
}

// ---------------------------------------------------------------------------
// Identité du fil
// ---------------------------------------------------------------------------

/**
 * Le handle porté par le FIL, relu dans le périmètre retenu.
 *
 * Un seul handle divergent suffit à refuser, même si les autres concordent :
 * deux sources qui ne disent pas la même chose sur une identité, c'est la
 * définition d'un doute (même règle que `decideIdentity`).
 */
export function readThreadHandle(
  links: readonly ObservedHandleLink[],
  nodes: readonly ObservedNode[],
  scope: ScopeChoice,
  expectedHandle: string,
): string | null {
  const expected = normalizeHandle(expectedHandle);
  if (expected === null || scope.kind === 'none') return null;

  const observed: string[] = [];
  for (const link of links) {
    if (link.level < 0 || link.level > scope.level) continue;
    observed.push(link.handle);
  }

  if (observed.length === 0) {
    // Aucun lien : le handle écrit en toutes lettres dans le périmètre, isolé
    // par des séparateurs — jamais un `includes`, qui ferait passer
    // « demo_prospect_a2 » pour « demo_prospect_a ».
    const token = new RegExp(`(^|[^A-Za-z0-9._])${expected}([^A-Za-z0-9._]|$)`, 'i');
    const found = nodes.some(
      (node) => node.level >= 0 && node.level <= scope.level && node.visible && token.test(node.text),
    );
    return found ? expected : null;
  }

  const normalized = observed.map((handle) => normalizeHandle(handle));
  if (normalized.some((handle) => handle === null || handle !== expected)) return null;
  return expected;
}

// ---------------------------------------------------------------------------
// Le verdict
// ---------------------------------------------------------------------------

/**
 * IG2.1 §4 — les trois issues possibles, et leur hiérarchie.
 *
 * `DELIVERY_FAILED` PASSE AVANT `SENT`, et ce n'est pas un détail d'ordre.
 * Un message qu'Instagram n'a pas remis reste affiché, aligné du côté sortant,
 * avec le texte exact — il satisfait donc toutes les preuves « positives » que
 * le canari du 14 août exigeait. Si le marqueur d'échec ne l'emportait pas,
 * l'issue la plus dangereuse (« envoyé » alors que rien n'est parti) serait
 * précisément celle qu'on écrirait.
 */
export type DeliveryVerdict = 'SENT' | 'DELIVERY_FAILED' | 'AMBIGUOUS';

/**
 * IG2.9 — la boîte de réception de l'EXPÉDITEUR atteste-t-elle la remise ?
 *
 * Preuve indépendante du fil, exigée en bloc. Le point important est ce qu'elle
 * refuse de conclure :
 *
 *   * boîte illisible → `false`. On ne déduit jamais rien d'une absence qu'on
 *     n'a pas pu observer ; c'est la règle « non observé ≠ absent » ;
 *   * fil absent ou inconnu → `false` ;
 *   * aperçu qui ne porte pas le texte approuvé → `false`. Un aperçu ancien,
 *     resté d'un message précédent, n'est pas une preuve de la tentative ;
 *   * fil non remonté, ou âge illisible → `false`. Un fil remis remonte ;
 *     `operator_second_account` a échoué avec exactement la signature inverse.
 *
 * L'identité, elle, n'est pas rejugée ici : `MatchedInboxRow.basis` garantit
 * déjà qu'une ligne n'est retenue que sur un handle, un `alt` d'image, ou un
 * nom d'affichage CORROBORÉ par la page canonique du handle attendu. Un nom
 * d'affichage seul ne produit jamais de ligne.
 */
/**
 * IG2.9 — un libellé d'échec explicite VU quelque part, sans être rattaché à
 * une bulle.
 *
 * `findFailureMarkers` apparie un marqueur à une bulle voisine, et rend donc
 * une liste vide dès que le fil est illisible : sans bulle, aucun appariement.
 * C'est correct pour ce qu'elle fait, mais cela rend son compteur VIDE PAR
 * VACUITÉ exactement là où la preuve d'inbox prend le relais — et un « zéro
 * marqueur » qui signifie « rien n'a été cherché » ne doit jamais servir de
 * feu vert.
 *
 * Cette lecture-ci est délibérément grossière et sans appariement : elle ne
 * conclut jamais à l'échec, elle se contente d'interdire de conclure à la
 * remise. Un mot d'échec visible à l'écran suffit à faire taire le témoin
 * d'inbox.
 */
export function hasUnboundExplicitFailureSignal(nodes: readonly ObservedNode[]): boolean {
  for (const node of nodes) {
    if (!node.visible) continue;
    const candidates = [normalizeLabel(node.ariaLabel), normalizeLabel(node.title), node.text.slice(0, 120)];
    for (const candidate of candidates) {
      if (candidate.length === 0) continue;
      if (EXPLICIT_FAILURE_LABELS.some((pattern) => pattern.test(candidate))) return true;
    }
  }
  return false;
}

export function inboxConfirmsDelivery(
  inbox: InboxWitness | null,
  /** `null`/`undefined` = âge de l'effet inconnu, donc « remonté » indémontrable. */
  effectAgeMs: number | null | undefined,
): boolean {
  if (inbox === null) return false;
  if (effectAgeMs === null || effectAgeMs === undefined) return false;
  if (inbox.readability !== 'INBOX_READABLE') return false;
  if (inbox.presence !== 'THREAD_PRESENT') return false;
  const row = inbox.row;
  if (row === null) return false;
  if (!row.previewMatchesApproved) return false;
  return wasThreadBumped(row, effectAgeMs) === true;
}

export interface ProofRecord {
  readonly proof: string;
  readonly verdict: 'PASS' | 'BLOCK';
  readonly detail: string;
}

/**
 * La boîte de réception a-t-elle réellement rendu sa liste ?
 *
 * La distinction est tout le sujet de la règle qui suit. « La conversation n'y
 * est pas » ne vaut que si la liste, elle, y est : sans ce seuil, une page qui
 * n'a pas fini de charger prouverait un échec de livraison.
 *
 * Trois vignettes de profil et un texte visible substantiel : une boîte qui a
 * rendu au moins trois conversations a rendu sa liste. Une boîte réellement
 * vide échoue ce test — et c'est voulu, car d'une boîte vide on ne peut RIEN
 * conclure : ni que le message y serait, ni qu'il n'y est pas.
 */
/**
 * IG2.4 — l'ancien seuil, retiré.
 *
 * `MIN_INBOX_AVATARS` / `MIN_INBOX_TEXT_LENGTH` déclaraient la liste « rendue »
 * à partir de vignettes et d'un volume de texte — deux mesures qui restaient
 * vraies alors qu'aucune ligne n'avait été comprise. Le témoin de lisibilité
 * porte désormais sur des LIGNES effectivement lues, et il vit dans
 * `classifyInbox` (`inboxScan.ts`), avec le reste de la classification.
 */

export interface DeliveryAdjudicationInput {
  readonly observation: {
    readonly ancestorChain: readonly AncestorLevel[];
    readonly nodes: readonly ObservedNode[];
    readonly handleLinks: readonly ObservedHandleLink[];
    readonly composerText: string;
    readonly truncated: boolean;
    /**
     * Ce que la boîte de l'EXPÉDITEUR montre. `null` sur le chemin LIVE, où
     * l'observation se fait dans le fil au moment du clic.
     */
    readonly inbox?: InboxWitness | null;
  };
  readonly approvedText: string;
  readonly expectedHandle: string;
  /**
   * Le composeur s'est vidé après le clic. Preuve du chemin LIVE seulement :
   * une adjudication postérieure rouvre une page neuve, où le composeur est
   * vide de toute façon — il n'y prouve donc rien et vaut `null`.
   */
  readonly composerCleared?: boolean | null;
  /** Occurrences du texte AVANT le clic, sur le chemin LIVE. `null` en adjudication. */
  readonly bubblesBefore?: number | null;
  /**
   * IG2.3 — le panneau de conversation validé AVANT l'effet.
   *
   * Fourni par le chemin LIVE, où l'identité du fil vient d'être confirmée dans
   * un conteneur précis. `null` en adjudication, qui rouvre une page neuve et
   * n'a donc rien à réutiliser.
   */
  readonly anchorRect?: ObservedRect | null;
  /**
   * IG2.4 — depuis combien de temps la tentative a eu lieu, en ms.
   *
   * Sert au seul témoin qui vienne des serveurs : un fil remonté par l'envoi
   * porte un horodatage aussi récent que la tentative. Sans cette valeur, la
   * fraîcheur n'est pas confrontée et le témoin se tait plutôt que de deviner.
   */
  readonly effectAgeMs?: number | null;
}

export interface DeliveryAdjudication {
  readonly verdict: DeliveryVerdict;
  readonly detail: string;
  readonly scope: ScopeChoice;
  readonly bubbles: readonly MatchedBubble[];
  readonly outgoingBubbles: readonly MatchedBubble[];
  readonly failureMarkers: readonly FailureMarker[];
  readonly threadHandle: string | null;
  readonly proofs: readonly ProofRecord[];
}

/**
 * Confronte une observation au texte approuvé, et rend l'une des trois issues.
 *
 * Fail-closed partout : un périmètre non résolu, une récolte tronquée, une
 * observation illisible ne valent jamais `SENT`. « Je n'ai pas pu lire » n'est
 * pas « c'est bon » — c'est la règle de `decideIdentity`, tenue ici aussi.
 */
export function adjudicateDelivery(input: DeliveryAdjudicationInput): DeliveryAdjudication {
  const { observation, approvedText, expectedHandle } = input;
  const proofs: ProofRecord[] = [];
  const inbox = observation.inbox ?? null;

  // ---- 0. Le témoin du côté SERVEUR, quand il a VRAIMENT parlé ------------
  //
  // Un message remis remonte sa conversation en tête de la liste de
  // l'expéditeur et en devient l'aperçu. La liste vient des serveurs ; la bulle
  // affichée dans un panneau est un état CLIENT, qu'un message en échec produit
  // exactement comme un message remis. Ce témoin l'emporte donc — mais
  // seulement quand il a su lire.
  //
  // IG2.4 : la version précédente concluait `DELIVERY_FAILED` sur « aucune
  // conversation trouvée » alors que le scanner n'avait compris aucune ligne et
  // cherchait un handle là où la ligne affiche un nom. Trois états distincts
  // maintenant, et l'illisible ne conclut plus rien.
  if (inbox !== null) {
    if (inbox.readability === 'INBOX_UNREADABLE') {
      proofs.push({ proof: 'inbox_readable', verdict: 'BLOCK', detail: inbox.detail });
    } else {
      proofs.push({ proof: 'inbox_readable', verdict: 'PASS', detail: `${inbox.rowsSeen} ligne(s) lues` });

      if (inbox.presence === 'THREAD_NOT_FOUND') {
        proofs.push({ proof: 'inbox_presence', verdict: 'BLOCK', detail: inbox.detail });
        return Object.freeze({
          verdict: 'DELIVERY_FAILED' as const,
          detail:
            `la boîte de l’expéditeur a rendu sa liste (${inbox.rowsSeen} conversations lues) et aucune ne ` +
            `porte « ${expectedHandle} ». Un message remis y créerait une conversation en tête de liste. ` +
            'Rien n’est parti : aucun SENT, aucun outreach_event, aucun rejeu.',
          scope: chooseThreadScope(observation.ancestorChain),
          bubbles: Object.freeze([]),
          outgoingBubbles: Object.freeze([]),
          failureMarkers: Object.freeze([]),
          threadHandle: null,
          proofs: Object.freeze(proofs),
        });
      }

      proofs.push({ proof: 'inbox_presence', verdict: 'PASS', detail: inbox.detail });

      // Le fil EXISTE. La question devient : a-t-il bougé depuis la tentative ?
      const bumped =
        input.effectAgeMs === undefined || input.effectAgeMs === null
          ? null
          : wasThreadBumped(inbox.row, input.effectAgeMs);
      if (bumped === false && inbox.row !== null && !inbox.row.previewMatchesApproved) {
        proofs.push({
          proof: 'inbox_bumped',
          verdict: 'BLOCK',
          detail:
            `le fil affiche un âge de ${Math.round((inbox.row.ageMs ?? 0) / 60_000)} min alors que la ` +
            `tentative date de ${Math.round((input.effectAgeMs ?? 0) / 60_000)} min`,
        });
        return Object.freeze({
          verdict: 'DELIVERY_FAILED' as const,
          detail:
            `la conversation avec « ${expectedHandle} » existe bien dans la boîte de l’expéditeur, mais elle ` +
            'n’a PAS été remontée par la tentative : son dernier message reste antérieur et son aperçu ne ' +
            'porte pas le texte approuvé. Un message remis devient le dernier message de son fil. ' +
            'Rien n’est parti : aucun SENT, aucun outreach_event, aucun rejeu.',
          scope: chooseThreadScope(observation.ancestorChain),
          bubbles: Object.freeze([]),
          outgoingBubbles: Object.freeze([]),
          failureMarkers: Object.freeze([]),
          threadHandle: null,
          proofs: Object.freeze(proofs),
        });
      }
      if (bumped !== null) {
        proofs.push({
          proof: 'inbox_bumped',
          verdict: bumped ? 'PASS' : 'BLOCK',
          detail: bumped ? 'le fil a été remonté par la tentative' : 'fil non remonté, mais l’aperçu porte le texte approuvé',
        });
      }
    }
  }

  // Où vit le texte cherché, indépendamment de tout périmètre : c'est le
  // plancher que le périmètre doit atteindre pour pouvoir prouver quoi que ce
  // soit à son sujet. Sans ce plancher, la sélection retombait au niveau 1 et
  // ne voyait aucune bulle — le « 0 → 0 » du 14 août.
  const target = normalizeMessageText(approvedText);
  const bearingLevels = observation.nodes
    .filter((node) => node.level >= 0 && node.visible && normalizeMessageText(node.text) === target)
    .map((node) => node.level);
  const minLevel = bearingLevels.length === 0 ? null : Math.min(...bearingLevels);

  const scope = chooseThreadScope(observation.ancestorChain, {
    anchor: input.anchorRect ?? null,
    minLevel,
  });
  proofs.push({
    proof: 'thread_scope',
    verdict: scope.kind === 'thread' ? 'PASS' : 'BLOCK',
    detail: scope.detail,
  });

  const bubbles = findApprovedTextBubbles(observation.nodes, scope, approvedText);
  const outgoing = bubbles.filter((bubble) => bubble.outgoing);
  const failureMarkers = findFailureMarkers(observation.nodes, scope, bubbles);
  const unreadableGlyphs = findUnreadableAdjacentGlyphs(observation.nodes, scope, bubbles);
  const threadHandle = readThreadHandle(observation.handleLinks, observation.nodes, scope, expectedHandle);

  proofs.push({
    proof: 'approved_text_present',
    verdict: bubbles.length > 0 ? 'PASS' : 'BLOCK',
    detail:
      bubbles.length === 0
        ? 'aucune occurrence du texte approuvé dans le périmètre du fil'
        : `${bubbles.length} occurrence(s) du texte approuvé`,
  });
  proofs.push({
    proof: 'outgoing_side',
    verdict: outgoing.length > 0 ? 'PASS' : 'BLOCK',
    detail:
      outgoing.length === 0
        ? 'aucune occurrence du côté sortant'
        : outgoing
            .map((bubble) => `bulle ${bubble.nodeId} à ${(bubble.centerRatio * 100).toFixed(0)} % (${bubble.outgoingBasis})`)
            .join(' ; '),
  });
  proofs.push({
    proof: 'thread_identity',
    verdict: threadHandle !== null ? 'PASS' : 'BLOCK',
    detail: threadHandle ?? `handle du fil illisible ou divergent, attendu « ${expectedHandle} »`,
  });
  proofs.push({
    proof: 'harvest_complete',
    verdict: observation.truncated ? 'BLOCK' : 'PASS',
    detail: observation.truncated ? 'récolte tronquée — observation incomplète' : 'récolte complète',
  });

  const explicit = failureMarkers.filter((marker) => marker.strength === 'explicit');
  const corroboratedRetry = failureMarkers.filter((marker) => marker.strength === 'retry' && marker.reddish);
  // IG2.3 — la pastille rouge ne conclut QUE collée à une bulle sortante.
  // Ailleurs, un point rouge est un point rouge : un badge, une notification,
  // une pastille d'activité. C'est la corroboration exigée par la mission.
  const visual = failureMarkers.filter((marker) => marker.strength === 'visual' && marker.adjacentToOutgoing);
  const decisiveFailure = [...explicit, ...corroboratedRetry, ...visual];
  proofs.push({
    proof: 'delivery_failure_marker',
    verdict: decisiveFailure.length > 0 ? 'BLOCK' : 'PASS',
    detail:
      failureMarkers.length === 0
        ? 'aucun marqueur d’échec accolé à une occurrence'
        : failureMarkers
            .map((marker) => `${marker.strength}/${marker.source} « ${marker.label} »${marker.reddish ? ' (rouge)' : ''}`)
            .join(' ; '),
  });

  // ---- 1. L'échec explicite l'emporte sur tout le reste --------------------
  if (bubbles.length > 0 && decisiveFailure.length > 0) {
    return Object.freeze({
      verdict: 'DELIVERY_FAILED' as const,
      detail:
        `le texte approuvé est affiché dans le fil, mais Instagram le marque comme non remis ` +
        `(${decisiveFailure.map((marker) => `« ${marker.label} »`).join(', ')}). ` +
        'Aucun message n’est parti : aucun SENT, aucun outreach_event, aucun rejeu.',
      scope,
      bubbles: Object.freeze(bubbles),
      outgoingBubbles: Object.freeze(outgoing),
      failureMarkers: Object.freeze(failureMarkers),
      threadHandle,
      proofs: Object.freeze(proofs),
    });
  }

  // ---- 2. La preuve positive, entière ou rien ------------------------------
  const composerOk = input.composerCleared === null || input.composerCleared === undefined || input.composerCleared;
  if (input.composerCleared === false) {
    proofs.push({ proof: 'composer_cleared', verdict: 'BLOCK', detail: 'composeur non vidé après le clic' });
  }
  const beforeOk = input.bubblesBefore === null || input.bubblesBefore === undefined || input.bubblesBefore === 0;
  if (!beforeOk) {
    proofs.push({
      proof: 'text_absent_before',
      verdict: 'BLOCK',
      detail: `le texte était déjà présent ${String(input.bubblesBefore)} fois avant le clic`,
    });
  }

  // IG2.3 — fail-closed sur le signal illisible.
  //
  // Une pastille de la bonne taille, au bon endroit, dont la couleur n'a pas pu
  // être lue, est exactement l'endroit où un échec se cacherait. Tant qu'il en
  // reste une, on ne conclut pas à l'envoi.
  if (unreadableGlyphs.length > 0) {
    proofs.push({
      proof: 'failure_signal_readable',
      verdict: 'BLOCK',
      detail:
        `${unreadableGlyphs.length} pastille(s) accolée(s) à une bulle sortante dont le style n’a pas pu ` +
        'être lu — impossible de dire si l’une d’elles marque un échec',
    });
  }

  const sent =
    scope.kind === 'thread' &&
    !observation.truncated &&
    bubbles.length > 0 &&
    outgoing.length > 0 &&
    threadHandle !== null &&
    failureMarkers.length === 0 &&
    unreadableGlyphs.length === 0 &&
    composerOk &&
    beforeOk;

  // ---- 2 bis. IG2.9 — la preuve d'INBOX, quand le fil ne se rouvre plus ----
  //
  // Une conversation peut être remise et redevenir illisible : la ligne d'inbox
  // ne porte pas toujours d'identifiant navigable, et le fil ne se rouvre alors
  // pas du tout. Avant IG2.9 cela rendait `AMBIGUOUS` — honnêtement, puisque
  // rien n'était lu à l'intérieur — mais faisait perdre une preuve INDÉPENDANTE
  // et forte qui, elle, avait été lue.
  //
  // Les quatre conditions sont exigées ENSEMBLE, et chacune ferme une porte :
  // la boîte est lisible (sinon on ne déduit rien d'une absence) ; le fil y est
  // présent ; son aperçu porte le texte approuvé ; et il a été remonté par la
  // tentative. Ce dernier point est le discriminant décisif — sur `operator_second_account`,
  // l'échec s'est justement signalé par un fil NON remonté, aperçu périmé.
  //
  // Ce chemin ne s'ouvre que lorsque le fil est inexploitable : il ne peut donc
  // pas affaiblir la preuve interne, qui reste la voie normale.
  //
  // `failureMarkers.length === 0` ne suffit PAS ici et ne doit pas rassurer :
  // sans bulle à apparier, cette liste est vide par vacuité. D'où la seconde
  // lecture, non appariée, qui interdit de conclure dès qu'un mot d'échec est
  // visible quelque part.
  if (
    !sent &&
    scope.kind !== 'thread' &&
    failureMarkers.length === 0 &&
    unreadableGlyphs.length === 0 &&
    !hasUnboundExplicitFailureSignal(observation.nodes)
  ) {
    if (inboxConfirmsDelivery(inbox, input.effectAgeMs)) {
      proofs.push({
        proof: 'inbox_delivery_witness',
        verdict: 'PASS',
        detail:
          'fil présent dans la boîte de l’expéditeur, remonté par la tentative, aperçu portant le texte ' +
          'approuvé, aucun marqueur d’échec — remise établie depuis la boîte, le fil n’étant pas rouvrable',
      });
      return Object.freeze({
        verdict: 'SENT' as const,
        detail:
          `fil de « ${expectedHandle} » remonté dans la boîte de l’expéditeur avec l’aperçu du texte ` +
          'approuvé — le fil lui-même n’a pas pu être rouvert, la remise est établie par la boîte',
        scope,
        bubbles: Object.freeze(bubbles),
        outgoingBubbles: Object.freeze(outgoing),
        failureMarkers: Object.freeze(failureMarkers),
        threadHandle,
        proofs: Object.freeze(proofs),
      });
    }
  }

  if (sent) {
    return Object.freeze({
      verdict: 'SENT' as const,
      detail:
        `bulle sortante portant le texte approuvé dans le fil de « ${threadHandle ?? expectedHandle} », ` +
        'aucun marqueur d’échec accolé',
      scope,
      bubbles: Object.freeze(bubbles),
      outgoingBubbles: Object.freeze(outgoing),
      failureMarkers: Object.freeze(failureMarkers),
      threadHandle,
      proofs: Object.freeze(proofs),
    });
  }

  // ---- 3. Tout le reste est un « je ne sais pas », et le dit ---------------
  const missing = proofs.filter((record) => record.verdict === 'BLOCK').map((record) => `${record.proof} (${record.detail})`);
  return Object.freeze({
    verdict: 'AMBIGUOUS' as const,
    detail: `preuve insuffisante — manque : ${missing.join(' ; ') || 'aucune preuve exploitable'}`,
    scope,
    bubbles: Object.freeze(bubbles),
    outgoingBubbles: Object.freeze(outgoing),
    failureMarkers: Object.freeze(failureMarkers),
    threadHandle,
    proofs: Object.freeze(proofs),
  });
}

/** Rendu lisible d'une adjudication, pour un humain devant un terminal. */
export function describeAdjudication(adjudication: DeliveryAdjudication): string[] {
  const lines = [`verdict                      ${adjudication.verdict}`, `détail                       ${adjudication.detail}`];
  lines.push(`périmètre                    ${adjudication.scope.kind} — ${adjudication.scope.detail}`);
  for (const rejected of adjudication.scope.rejected) lines.push(`  écarté                     ${rejected}`);
  for (const proof of adjudication.proofs) {
    lines.push(`  ${proof.verdict === 'PASS' ? '✓' : '✗'} ${proof.proof.padEnd(24)} ${proof.detail}`);
  }
  return lines;
}
