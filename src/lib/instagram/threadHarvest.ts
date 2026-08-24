import type { Locator } from 'playwright';
import type { AncestorLevel, ObservedHandleLink, ObservedNode, ObservedRect } from '@/lib/instagram/threadObservation';

/**
 * IG2.1 §3/§6 — le code qui s'exécute DANS la page, et la règle qui le rend
 * exécutable.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AUCUNE FONCTION NOMMÉE DANS UN CORPS ÉVALUÉ. C'est la cause du « 0 → 0 ».
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Le 14 août, la primitive d'envoi a compté « 0 occurrence du texte exact avant
 * le clic, 0 après », alors que la capture prise trois secondes plus tard
 * montrait la bulle. La fonction qui comptait n'avait pas mal compté : elle
 * n'avait jamais tourné.
 *
 * `tsx` transpile avec esbuild, option `keepNames` active. Toute fonction
 * NOMMÉE — y compris une flèche affectée à un `const` — est réécrite en
 * `var norm = __name((v) => …, "norm")`, où `__name` est une aide injectée en
 * haut du MODULE Node. Or Playwright ne transmet pas le module : il sérialise la
 * fonction (`Function.prototype.toString`) et l'évalue dans la page, où
 * `__name` n'existe pas. Le corps lève donc `ReferenceError: __name is not
 * defined` dès sa première ligne.
 *
 * Ce qui a rendu la panne invisible est le `.catch()` qui l'entourait : il
 * rendait `UNREADABLE_SCAN`, dont le commentaire promettait « jamais confondu
 * avec zéro occurrence » — mais l'appelant n'en lisait que `matches.length`,
 * c'est-à-dire `0`. « Je n'ai pas pu lire » est devenu « il n'y a rien », et le
 * canari a conclu à l'ambiguïté pour une raison entièrement fausse.
 *
 * Deux règles en découlent, tenues par des tests :
 *
 *   1. les corps évalués n'ont AUCUN `const helper = …`, aucune fonction
 *      nommée, aucune classe. Tout est en ligne, même au prix d'une répétition.
 *      Un test lit le source sérialisé de chaque fonction exportée ci-dessous et
 *      refuse la moindre occurrence de `__name` ;
 *   2. une récolte qui échoue le DIT (`readable: false`), et le code pur refuse
 *      alors de conclure — au lieu de rendre des zéros qui ressemblent à une
 *      observation.
 */

/** Bornes de la récolte. Une observation bornée est INCOMPLÈTE, jamais fausse. */
export const HARVEST_MAX_NODES = 900;
export const HARVEST_MAX_TEXT = 2_000;
export const HARVEST_MAX_DEPTH = 15;

export interface ThreadHarvest {
  readonly ancestorChain: readonly AncestorLevel[];
  readonly nodes: readonly ObservedNode[];
  readonly handleLinks: readonly ObservedHandleLink[];
  readonly composerRect: ObservedRect | null;
  readonly composerText: string;
  /** La récolte a atteint sa borne : le code pur refusera de conclure à un envoi. */
  readonly truncated: boolean;
  /** La récolte n'a pas pu s'exécuter. Jamais confondu avec « rien trouvé ». */
  readonly readable: boolean;
}

export const UNREADABLE_HARVEST: ThreadHarvest = Object.freeze({
  ancestorChain: Object.freeze([]),
  nodes: Object.freeze([]),
  handleLinks: Object.freeze([]),
  composerRect: null,
  composerText: '',
  truncated: false,
  readable: false,
});

export interface HarvestLimits {
  readonly maxNodes: number;
  readonly maxText: number;
  readonly maxDepth: number;
}

/**
 * Le corps évalué dans la page, exporté pour être inspectable par un test.
 *
 * Trois choses en sortent :
 *
 *   1. la CHAÎNE D'ANCÊTRES du composeur, chaque niveau mesuré — combien
 *      d'éléments porteurs de texte visibles il contient HORS du composeur, et
 *      son rapport de hauteur. C'est la mesure qui manquait : le premier canari
 *      s'arrêtait au premier ancêtre portant un `aria-label`, c'est-à-dire au
 *      conteneur du champ de saisie ;
 *   2. les ÉLÉMENTS porteurs de texte ou d'attributs accessibles sous la racine
 *      bornée, avec leur niveau, leur rectangle et leur couleur ;
 *   3. les LIENS de profil, pour l'identité du fil.
 *
 * Ce qui n'en sort jamais : `href` de requête, `src`, `class`, le HTML, un
 * cookie, un jeton. Les classes d'Instagram sont minifiées et changent à chaque
 * déploiement ; s'y fier donnerait un rail qui marche aujourd'hui et ment
 * demain.
 */
export const HARVEST_THREAD_IN_PAGE = function (node: Element, limits: HarvestLimits): ThreadHarvest {
  const composerBox = node.getBoundingClientRect();
  const composerRect = {
    left: composerBox.left,
    right: composerBox.right,
    top: composerBox.top,
    bottom: composerBox.bottom,
  };
  const composerHeight = composerRect.bottom - composerRect.top;
  const composerText =
    node instanceof HTMLTextAreaElement
      ? node.value
      : ((node as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim();

  // ---- 1. La chaîne d'ancêtres, mesurée niveau par niveau ------------------
  const ancestors: Element[] = [];
  const chain: AncestorLevel[] = [];

  let current: Element | null = node.parentElement;
  for (let i = 0; i < limits.maxDepth && current !== null; i += 1) {
    const tag = current.tagName.toLowerCase();
    const isDocumentRoot = tag === 'main' || tag === 'body';

    let outside = 0;
    const descendants = Array.from(current.querySelectorAll('*'));
    for (const el of descendants) {
      if (el === node || node.contains(el)) continue;
      if ((el.textContent ?? '').replace(/\s+/g, ' ').trim().length === 0) continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      outside += 1;
      if (outside >= 500) break;
    }

    const levelBox = current.getBoundingClientRect();
    ancestors.push(current);
    chain.push({
      index: i,
      tag,
      role: current.getAttribute('role'),
      ariaLabel: current.getAttribute('aria-label'),
      rect: { left: levelBox.left, right: levelBox.right, top: levelBox.top, bottom: levelBox.bottom },
      textBearingOutsideComposer: outside,
      heightRatio: composerHeight > 0 ? (levelBox.bottom - levelBox.top) / composerHeight : 0,
      isDocumentRoot,
    });

    if (isDocumentRoot) break;
    current = current.parentElement;
  }

  const root = ancestors[ancestors.length - 1] ?? node;

  // ---- 2. Les éléments ----------------------------------------------------
  const nodes: ObservedNode[] = [];
  const idByElement = new Map<Element, number>();
  let truncated = false;

  for (const el of Array.from(root.querySelectorAll('*'))) {
    const role = el.getAttribute('role');
    const ariaLabel = el.getAttribute('aria-label');
    const title = el.getAttribute('title');
    const raw = el.textContent ?? '';
    const keep = raw.replace(/\s+/g, ' ').trim().length > 0 || role !== null || ariaLabel !== null || title !== null;
    if (!keep) continue;
    if (nodes.length >= limits.maxNodes) {
      truncated = true;
      break;
    }

    let parentId: number | null = null;
    for (let p = el.parentElement; p !== null; p = p.parentElement) {
      const known = idByElement.get(p);
      if (known !== undefined) {
        parentId = known;
        break;
      }
    }

    // Le niveau : index du plus petit ancêtre de la chaîne qui contient
    // l'élément, `-1` quand il est dans le composeur. En ligne, et non dans une
    // fonction nommée — voir l'en-tête de ce fichier.
    let level = ancestors.length;
    if (el === node || node.contains(el)) {
      level = -1;
    } else {
      for (let i = 0; i < ancestors.length; i += 1) {
        const ancestor = ancestors[i];
        if (ancestor !== undefined && (ancestor === el || ancestor.contains(el))) {
          level = i;
          break;
        }
      }
    }

    const box = el.getBoundingClientRect();
    let color: string | null = null;
    let fill: string | null = null;
    try {
      const style = window.getComputedStyle(el);
      color = style.color === '' ? null : style.color;
      fill = style.fill === '' ? null : style.fill;
    } catch {
      color = null;
    }

    const id = nodes.length;
    idByElement.set(el, id);
    nodes.push({
      id,
      parentId,
      level,
      tag: el.tagName.toLowerCase(),
      role,
      ariaLabel,
      title,
      text: raw.slice(0, limits.maxText),
      rect: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
      visible: box.right - box.left > 0 && box.bottom - box.top > 0,
      color,
      fill,
    });
  }

  // ---- 3. Les liens de profil ---------------------------------------------
  const handleLinks: ObservedHandleLink[] = [];
  for (const link of Array.from(root.querySelectorAll('a[href^="/"]'))) {
    const match = /^\/([A-Za-z0-9._]{1,30})\/$/.exec(link.getAttribute('href') ?? '');
    const handle = match === null ? undefined : match[1];
    if (handle === undefined) continue;

    let level = ancestors.length;
    if (link === node || node.contains(link)) {
      level = -1;
    } else {
      for (let i = 0; i < ancestors.length; i += 1) {
        const ancestor = ancestors[i];
        if (ancestor !== undefined && (ancestor === link || ancestor.contains(link))) {
          level = i;
          break;
        }
      }
    }

    handleLinks.push({ handle, level });
    if (handleLinks.length >= 60) break;
  }

  return { ancestorChain: chain, nodes, handleLinks, composerRect, composerText, truncated, readable: true };
};

/** Récolte le fil autour du composeur. Une panne rend `readable: false`. */
export async function harvestThread(composer: Locator): Promise<ThreadHarvest> {
  return composer
    .evaluate(HARVEST_THREAD_IN_PAGE, {
      maxNodes: HARVEST_MAX_NODES,
      maxText: HARVEST_MAX_TEXT,
      maxDepth: HARVEST_MAX_DEPTH,
    })
    .catch(() => UNREADABLE_HARVEST);
}
