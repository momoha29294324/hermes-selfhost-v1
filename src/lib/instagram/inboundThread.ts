import { createHash } from 'node:crypto';
import {
  OUTGOING_LABELS,
  chooseThreadScope,
  normalizeLabel,
  normalizeMessageText,
  type ScopeChoice,
} from '@/lib/instagram/deliveryProof';
import type { ThreadHarvest } from '@/lib/instagram/threadHarvest';
import type { ObservedNode, ObservedRect } from '@/lib/instagram/threadObservation';

/**
 * IG5.1 §4/§5 — lire une conversation Instagram comme une SUITE DE MESSAGES,
 * sans jamais confondre le nôtre avec celui du prospect.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi ce module est pur, et où s'arrête sa responsabilité
 * ---------------------------------------------------------------------------
 *
 * Il ne connaît ni navigateur, ni base, ni prospect. Il reçoit une récolte
 * (`ThreadHarvest`, produite par le code qui s'exécute DANS la page) et rend
 * des messages observés. C'est le même partage que `threadHarvest → deliveryProof`
 * et que `inboxScan` : la page MESURE, le code pur DÉCIDE — donc chaque cas,
 * y compris ceux qu'une vraie boîte mettrait des mois à produire, est exerçable
 * sans Instagram.
 *
 * Ce qu'il ne fait jamais : décider qu'un message est une RÉPONSE COMMERCIALE.
 * Il dit « cette bulle vient d'en face », et s'arrête là. Le rattachement à un
 * prospect vit dans `instagramCorrelation`, et il peut refuser.
 *
 * ---------------------------------------------------------------------------
 * Les trois pièges, et comment chacun est traité
 * ---------------------------------------------------------------------------
 *
 *   1. **Notre propre message ressemble à une réponse.** C'est le pire des
 *      trois : un rail qui se trompe transformerait le premier contact en
 *      « le prospect a répondu », déclencherait une alerte, un brouillon, et
 *      arrêterait des séquences pour rien. La direction est donc établie par
 *      DEUX signaux indépendants, et l'indécision est une issue nommée
 *      (`UNKNOWN`), jamais un pari.
 *
 *   2. **Le mobilier de l'interface ressemble à un message.** Un séparateur de
 *      date, un « Vu », un titre de conversation portent du texte visible. Ils
 *      sont écartés par leur RÔLE accessible (bouton, lien, titre) et par leur
 *      position (bande d'en-tête), jamais par une classe CSS — les classes
 *      d'Instagram sont minifiées et changent à chaque déploiement.
 *
 *   3. **Le même texte, deux fois.** Quelqu'un qui écrit « ok » puis « ok »
 *      a envoyé deux messages. Une empreinte fondée sur le seul texte n'en
 *      verrait qu'un. Le rang d'occurrence entre donc dans l'empreinte —
 *      voir `MESSAGE_FINGERPRINT_VERSION`.
 */

// ---------------------------------------------------------------------------
// Le vocabulaire
// ---------------------------------------------------------------------------

export type MessageDirection = 'INCOMING' | 'OUTGOING' | 'UNKNOWN';

/**
 * Sur quoi la direction a été établie. `none` implique `UNKNOWN` — mais depuis
 * IG5 R3, l'inverse n'est plus vrai : un expéditeur NOMMÉ qui n'est ni nous ni
 * la contrepartie attendue rend `UNKNOWN` sur la base `sender_identity`.
 *
 * IG5 R3 ajoute `sender_identity` : la réponse de détail du fil NOMME
 * l'expéditeur de chaque message. C'est la base la plus forte des quatre, et de
 * loin — les trois autres déduisent qui parle d'un indice de mise en page ou
 * d'un libellé d'interface, celle-ci le LIT. Elle est ajoutée plutôt que
 * substituée : le chemin DOM garde exactement les siennes.
 */
export type DirectionBasis = 'geometry' | 'accessible' | 'both' | 'none' | 'sender_identity';

/**
 * D'OÙ vient un message observé.
 *
 * Rendue plutôt que déduite, pour la même raison que `threadIdSource` (R2) :
 * les deux sources n'ont pas la même force de preuve, et une bascule
 * silencieuse de l'une vers l'autre doit se voir dans un rapport plutôt que
 * s'expliquer six semaines plus tard.
 */
export type ThreadMessageSource = 'DOM_BUBBLE' | 'THREAD_DETAIL_NETWORK';

/** Du texte, ou un contenu qui n'en a pas (photo, note vocale, partage). */
export type MessageContentKind = 'TEXT' | 'NON_TEXT';

export interface ObservedThreadMessage {
  readonly source: ThreadMessageSource;
  /** `null` hors du DOM : un message lu dans une réponse réseau n'a pas de nœud. */
  readonly nodeId: number | null;
  readonly direction: MessageDirection;
  readonly directionBasis: DirectionBasis;
  /** `textContent` normalisé de la bulle. Jamais du HTML, jamais un attribut. */
  readonly text: string;
  readonly textSha256: string;
  /** Rang parmi les bulles identiques du même côté dans CETTE récolte. */
  readonly occurrenceIndex: number;
  /** `null` hors du DOM : une réponse réseau n'a pas de géométrie. */
  readonly rect: ObservedRect | null;
  readonly ariaLabel: string | null;
  /**
   * IG5 R3 — l'identifiant que le FOURNISSEUR a émis pour ce message, quand la
   * source en donne un. `null` sur le chemin DOM, où Instagram n'en expose
   * aucun. Ce n'est pas la valeur écrite en base : voir
   * `instagramNetworkMessageFingerprint`.
   */
  readonly providerMessageId: string | null;
  /** L'expéditeur nommé par la source. `null` quand elle ne le nomme pas. */
  readonly senderHandle: string | null;
  /**
   * L'instant RÉEL du message, en millisecondes. `null` sur le chemin DOM, où
   * l'interface n'affiche qu'un âge relatif et arrondi.
   */
  readonly timestampMs: number | null;
  readonly contentKind: MessageContentKind;
}

export interface ThreadMessageRead {
  /** La récolte a-t-elle pu être exploitée ? `false` n'est jamais « aucun message ». */
  readonly readable: boolean;
  readonly scope: ScopeChoice;
  readonly messages: readonly ObservedThreadMessage[];
  /**
   * Les handles lus dans le périmètre du fil, dédupliqués, hors compte
   * relevant. Un fil 1:1 en montre exactement un.
   */
  readonly handles: readonly string[];
  /** Nœuds porteurs de texte écartés comme mobilier d'interface. Diagnostic. */
  readonly chromeFiltered: number;
  /** La récolte a atteint sa borne : l'observation est INCOMPLÈTE, jamais « vide ». */
  readonly truncated: boolean;
  readonly detail: string;
}

export const UNREADABLE_THREAD_MESSAGES: ThreadMessageRead = Object.freeze({
  readable: false,
  scope: Object.freeze({ kind: 'none' as const, level: -1, rect: null, detail: 'aucune récolte', rejected: Object.freeze([]) }),
  messages: Object.freeze([]),
  handles: Object.freeze([]),
  chromeFiltered: 0,
  truncated: false,
  detail: 'récolte illisible — aucune absence ne peut en être déduite',
});

// ---------------------------------------------------------------------------
// Les seuils, tous nommés et tous justifiés
// ---------------------------------------------------------------------------

/**
 * Part de la largeur du fil en deçà de laquelle deux bords sont « aussi
 * proches ». En dessous de cet écart, la géométrie ne tranche pas.
 *
 * 4 % : assez pour absorber le décalage d'une gouttière et l'arrondi du rendu,
 * assez peu pour qu'une bulle réellement collée à un bord reste reconnue.
 */
export const EDGE_TOLERANCE_RATIO = 0.04;

/**
 * Hauteur, en pixels, de la bande d'en-tête écartée en haut du fil.
 *
 * C'est là que vivent le nom de la conversation, l'avatar et les commandes.
 * Aucun message n'y est rendu — la liste des bulles commence sous elle.
 */
export const HEADER_BAND_PX = 72;

/**
 * Part de la largeur du fil au-delà de laquelle un élément n'est plus une
 * bulle mais une rangée.
 *
 * Un séparateur de date, un bandeau « Vous avez envoyé… » ou une barre de
 * statut occupent toute la largeur. Une bulle, jamais : Instagram lui laisse
 * une gouttière du côté opposé, et c'est précisément cette gouttière qui rend
 * la direction lisible.
 */
export const MAX_BUBBLE_WIDTH_RATIO = 0.9;

/**
 * Rôles accessibles qui désignent une commande ou une structure, jamais un
 * message.
 *
 * Lus sur l'élément et sur ses ancêtres : le nom de la conversation est un
 * `<a>` vers le profil, donc un `link`, et c'est ce qui l'écarte.
 */
const CHROME_ROLES: readonly string[] = [
  'button',
  'link',
  'textbox',
  'heading',
  'banner',
  'navigation',
  'menu',
  'menuitem',
  'menubar',
  'tab',
  'tablist',
  'toolbar',
  'search',
  'img',
  'combobox',
  'listbox',
  'option',
  'dialog',
  'progressbar',
  'separator',
];

/** Longueur maximale du texte d'une bulle conservé. Le corps entier reste borné par la récolte. */
export const MAX_MESSAGE_CHARS = 2_000;

// ---------------------------------------------------------------------------
// L'empreinte
// ---------------------------------------------------------------------------

/**
 * La version de la recette d'empreinte, inscrite DANS l'empreinte.
 *
 * Sans elle, changer la recette un jour rendrait tous les messages déjà en base
 * invisibles à la déduplication — chaque ancienne réponse réapparaîtrait comme
 * neuve. Avec elle, un changement de recette est un changement de version, donc
 * une décision, donc une migration de données assumée.
 */
export const MESSAGE_FINGERPRINT_VERSION = 'ig-dm-v1';

export interface FingerprintInput {
  /** Le compte qui a RELEVÉ, c'est-à-dire le nôtre. */
  readonly accountHandle: string;
  readonly threadId: string;
  readonly senderHandle: string;
  readonly occurrenceIndex: number;
  /** Le texte de la bulle, tel qu'observé. Normalisé ici, pas par l'appelant. */
  readonly text: string;
}

/**
 * L'identité d'un message entrant Instagram, telle que NOUS la calculons.
 *
 * Instagram web n'expose aucun identifiant de message stable : les lignes de la
 * boîte ne portent plus systématiquement de lien, et le DOM d'une bulle ne
 * contient ni clé ni horodatage absolu. Prétendre le contraire — écrire une
 * valeur dans `provider_message_id` en laissant croire qu'Instagram l'a émise —
 * serait l'interdit n°2 appliqué à une clé primaire. La colonne
 * `message_identity_kind` (0041) dit donc que cette valeur est une empreinte
 * OBSERVÉE.
 *
 * Ce qui y entre, et pourquoi chaque terme est nécessaire :
 *
 *   * `accountHandle` — la même conversation relevée depuis deux comptes n'est
 *     pas la même relève ;
 *   * `threadId` — deux prospects peuvent écrire le même mot ;
 *   * `senderHandle` — dans un fil, les deux côtés peuvent écrire le même mot ;
 *   * `occurrenceIndex` — la même personne peut écrire deux fois le même mot ;
 *   * le texte NORMALISÉ — Instagram peut rendre les espaces et apostrophes
 *     différemment d'un chargement à l'autre ; sans normalisation, un même
 *     message deviendrait deux réponses au prochain tour.
 *
 * Ce qui n'y entre PAS, délibérément : l'horodatage. Instagram n'affiche qu'un
 * âge relatif (« 2 h »), qui change à chaque relève. L'inclure ferait renaître
 * le même message à chaque tour — c'est exactement le contraire du but.
 */
export function instagramMessageFingerprint(input: FingerprintInput): string {
  const parts = [
    MESSAGE_FINGERPRINT_VERSION,
    input.accountHandle.toLowerCase(),
    input.threadId,
    input.senderHandle.toLowerCase(),
    String(input.occurrenceIndex),
    normalizeMessageText(input.text),
  ];
  // Séparateur qui ne peut pas apparaître dans les composants : les handles et
  // l'identifiant de fil sont contraints par une regex, la version est
  // littérale, et le texte normalisé ne contient plus de caractère de contrôle.
  return createHash('sha256').update(parts.join('\0'), 'utf8').digest('hex');
}

/**
 * IG5 R3 — la version d'empreinte des messages lus dans la réponse RÉSEAU.
 *
 * Distincte de `ig-dm-v1` parce que la recette l'est : celle-ci repose sur
 * l'identifiant que le fournisseur a émis, celle-là sur le rang d'occurrence
 * d'un texte. Deux recettes qui partageraient une version rendraient le même
 * message dédupliqué contre lui-même de deux façons incompatibles.
 */
export const NETWORK_MESSAGE_FINGERPRINT_VERSION = 'ig-dm-net-v1';

export interface NetworkFingerprintInput {
  /** Le compte qui a RELEVÉ, c'est-à-dire le nôtre. */
  readonly accountHandle: string;
  readonly threadId: string;
  /** L'identifiant natif du message, tel qu'Instagram l'a émis. */
  readonly providerMessageId: string;
}

/**
 * L'identité d'un message Instagram lu dans la réponse de détail du fil.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi une empreinte, alors qu'on tient enfin un identifiant natif
 * ---------------------------------------------------------------------------
 *
 * Parce que le schéma l'exige, et qu'il a raison. La migration 0042 contraint
 * les lignes Instagram à `message_identity_kind = 'observed_fingerprint'` avec
 * `provider_message_id ~ '^[0-9a-f]{64}$'` : elle a été écrite pour empêcher
 * une phrase précise d'être écrite en base — « Instagram nous a donné cet
 * identifiant » — à l'époque où c'était faux.
 *
 * Ce serait vrai aujourd'hui pour la valeur brute (`mid.…`, 34 caractères), et
 * la tentation était d'élargir la contrainte. Deux raisons de ne pas le faire :
 *
 *   1. Ce qu'on écrit reste une valeur CALCULÉE par nous à partir de ce que la
 *      page a laissé lire — l'appeler « émise par le fournisseur » resterait
 *      approximatif, et la colonne existe précisément pour ne pas l'être ;
 *   2. élargir la contrainte pour un canal l'aurait relâchée pour tous, alors
 *      que rien ne l'exigeait : l'objectif est « même message Instagram ⇒ même
 *      identité logique », et un condensé déterministe de l'identifiant natif
 *      l'atteint exactement.
 *
 * Ce qui y entre, et pourquoi chaque terme est nécessaire :
 *
 *   * `accountHandle` — la même conversation relevée depuis deux comptes n'est
 *     pas la même relève ;
 *   * `threadId` — il rend l'empreinte lisible comme « ce message, dans ce
 *     fil », et fait échouer bruyamment un identifiant recopié d'un fil à
 *     l'autre plutôt que de le laisser passer ;
 *   * `providerMessageId` — l'identité, la vraie. Elle ne dépend ni du texte,
 *     ni du rang d'occurrence, ni de l'ordre de lecture : un message édité,
 *     relu dans le désordre ou vu cinquante fois garde la même.
 *
 * C'est ce que `ig-dm-v1` ne pouvait pas offrir, faute d'identifiant : son rang
 * d'occurrence change dès qu'un message plus ancien disparaît du rendu.
 */
export function instagramNetworkMessageFingerprint(input: NetworkFingerprintInput): string {
  const parts = [
    NETWORK_MESSAGE_FINGERPRINT_VERSION,
    input.accountHandle.toLowerCase(),
    input.threadId,
    input.providerMessageId,
  ];
  return createHash('sha256').update(parts.join(' '), 'utf8').digest('hex');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// L'extraction
// ---------------------------------------------------------------------------

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

function isChrome(node: ObservedNode, chain: readonly ObservedNode[]): boolean {
  for (const ancestor of chain) {
    const role = ancestor.role === null ? '' : ancestor.role.toLowerCase();
    if (role.length > 0 && CHROME_ROLES.includes(role)) return true;
  }
  return node.tag === 'a' || node.tag === 'button' || node.tag === 'svg' || node.tag === 'img';
}

/**
 * De quel côté du fil cette bulle est-elle posée ?
 *
 * Par les BORDS, pas par le centre. Le centre suffit pour un message court,
 * et se trompe pour un long : une bulle entrante qui occupe 80 % de la largeur
 * a son centre presque au milieu, et un test « centre à droite du milieu »
 * la déclarerait indécidable — voire sortante si l'arrondi joue contre elle.
 * Les bords, eux, restent francs : une bulle entrante touche le bord gauche et
 * laisse une gouttière à droite, quelle que soit sa longueur.
 */
export function sideFromGeometry(bubble: ObservedRect, scope: ObservedRect): 'left' | 'right' | null {
  const width = scope.right - scope.left;
  if (!(width > 0)) return null;
  const tolerance = width * EDGE_TOLERANCE_RATIO;
  const distanceLeft = bubble.left - scope.left;
  const distanceRight = scope.right - bubble.right;
  if (distanceLeft + tolerance < distanceRight) return 'left';
  if (distanceRight + tolerance < distanceLeft) return 'right';
  return null;
}

export interface ExtractOptions {
  /** Le compte qui relève. Retiré de la liste des handles du fil. */
  readonly accountHandle: string;
}

/**
 * Range une récolte de fil en messages.
 *
 * Une récolte illisible rend `readable: false` et zéro message — jamais zéro
 * message présenté comme une conversation vide. C'est la règle qui a coûté un
 * faux verdict au canari du 14 août, et elle est appliquée ici dès la première
 * ligne.
 */
export function extractThreadMessages(harvest: ThreadHarvest, options: ExtractOptions): ThreadMessageRead {
  if (!harvest.readable) return UNREADABLE_THREAD_MESSAGES;

  const scope = chooseThreadScope(harvest.ancestorChain);
  const scopeRect = scope.rect;
  if (scope.kind === 'none' || scopeRect === null) {
    return Object.freeze({
      ...UNREADABLE_THREAD_MESSAGES,
      readable: false,
      scope,
      detail: `périmètre du fil non retenu : ${scope.detail}`,
    });
  }

  const inScope = harvest.nodes.filter((node) => node.level >= 0 && node.level <= scope.level);
  const byId = new Map(inScope.map((node) => [node.id, node]));

  // Les porteurs de texte visibles. Le sous-arbre du composeur (`level < 0`)
  // est déjà exclu : un brouillon n'est pas un message.
  const bearing = inScope.filter((node) => node.visible && normalizeMessageText(node.text).length > 0);

  // Le plus PROFOND seulement. Un conteneur porte le `textContent` de tous ses
  // descendants ; le garder compterait chaque message autant de fois qu'il a
  // d'ancêtres.
  const bearingIds = new Set(bearing.map((node) => node.id));
  const containers = new Set<number>();
  for (const node of bearing) {
    for (const ancestor of parentChain(node, byId).slice(1)) {
      if (bearingIds.has(ancestor.id)) containers.add(ancestor.id);
    }
  }

  const scopeWidth = scopeRect.right - scopeRect.left;
  const headerFloor = scopeRect.top + HEADER_BAND_PX;

  let chromeFiltered = 0;
  const leaves: { node: ObservedNode; chain: ObservedNode[] }[] = [];
  for (const node of bearing) {
    if (containers.has(node.id)) continue;
    const chain = parentChain(node, byId);

    if (isChrome(node, chain)) {
      chromeFiltered += 1;
      continue;
    }
    // La bande d'en-tête : le nom du fil et ses commandes vivent au-dessus des
    // messages. Comparaison sur le BAS de l'élément — un élément qui déborde
    // sous la bande est déjà un message.
    if (node.rect.bottom <= headerFloor) {
      chromeFiltered += 1;
      continue;
    }
    const width = node.rect.right - node.rect.left;
    if (!(width > 0) || (scopeWidth > 0 && width > scopeWidth * MAX_BUBBLE_WIDTH_RATIO)) {
      chromeFiltered += 1;
      continue;
    }
    leaves.push({ node, chain });
  }

  // Ordre de lecture : de haut en bas, puis de gauche à droite. C'est l'ordre
  // du fil, donc celui dans lequel les rangs d'occurrence se comptent.
  leaves.sort((a, b) => a.node.rect.top - b.node.rect.top || a.node.rect.left - b.node.rect.left);

  const occurrences = new Map<string, number>();
  const messages: ObservedThreadMessage[] = [];
  for (const { node, chain } of leaves) {
    const accessible = chain.some((ancestor) =>
      OUTGOING_LABELS.some((pattern) => pattern.test(normalizeLabel(ancestor.ariaLabel))),
    );
    const side = sideFromGeometry(node.rect, scopeRect);

    let direction: MessageDirection;
    let basis: DirectionBasis;
    if (accessible) {
      direction = 'OUTGOING';
      basis = side === 'right' ? 'both' : 'accessible';
    } else if (side === 'right') {
      direction = 'OUTGOING';
      basis = 'geometry';
    } else if (side === 'left') {
      direction = 'INCOMING';
      basis = 'geometry';
    } else {
      // Ni libellé, ni bord franc. Un pari ici transformerait notre message en
      // réponse de prospect ; l'indécision est donc une issue, pas une erreur.
      direction = 'UNKNOWN';
      basis = 'none';
    }

    const text = normalizeMessageText(node.text).slice(0, MAX_MESSAGE_CHARS);
    const key = `${direction}\0${text}`;
    const occurrenceIndex = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrenceIndex + 1);

    messages.push(
      Object.freeze({
        source: 'DOM_BUBBLE' as const,
        nodeId: node.id,
        direction,
        directionBasis: basis,
        text,
        textSha256: sha256Hex(text),
        occurrenceIndex,
        rect: node.rect,
        ariaLabel: node.ariaLabel,
        // Le DOM d'une bulle ne porte ni identifiant de message, ni handle
        // d'expéditeur, ni horodatage absolu. Les trois sont `null` parce
        // qu'ils sont ABSENTS, pas parce qu'on ne les a pas cherchés.
        providerMessageId: null,
        senderHandle: null,
        timestampMs: null,
        contentKind: 'TEXT' as const,
      }),
    );
  }

  // Les handles du fil, hors le nôtre. Un fil 1:1 en montre exactement un ;
  // zéro ou plusieurs sont deux refus différents, tranchés par l'appelant.
  const account = options.accountHandle.toLowerCase();
  const handles: string[] = [];
  for (const link of harvest.handleLinks) {
    if (link.level < 0 || link.level > scope.level) continue;
    const handle = link.handle.toLowerCase();
    if (handle === account) continue;
    if (!handles.includes(handle)) handles.push(handle);
  }

  const incoming = messages.filter((message) => message.direction === 'INCOMING').length;
  const outgoing = messages.filter((message) => message.direction === 'OUTGOING').length;
  const unknown = messages.length - incoming - outgoing;

  return Object.freeze({
    readable: true,
    scope,
    messages: Object.freeze(messages),
    handles: Object.freeze(handles),
    chromeFiltered,
    truncated: harvest.truncated,
    detail:
      `${messages.length} bulle(s) retenue(s) — ${incoming} entrante(s), ${outgoing} sortante(s), ` +
      `${unknown} indécidable(s) ; ${chromeFiltered} élément(s) d'interface écarté(s)` +
      (harvest.truncated ? ' ; récolte TRONQUÉE, observation incomplète' : ''),
  });
}
