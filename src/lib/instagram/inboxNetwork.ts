/**
 * IG5 R2 — les identifiants de fil, lus là où Instagram les met VRAIMENT.
 *
 * ---------------------------------------------------------------------------
 * Ce que le DOM ne dit plus
 * ---------------------------------------------------------------------------
 *
 * `SCAN_INBOX_IN_PAGE` cherche encore `a[href^="/direct/t/"]` sur chaque ligne,
 * et il a raison de le faire : le jour où Instagram remet ces liens, ils
 * redeviennent la meilleure source qui soit — l'interface elle-même nomme le
 * fil, sans intermédiaire.
 *
 * Seulement, l'interface d'aujourd'hui ne les met plus. Le relevé LIVE du
 * 20 août l'a mesuré plutôt que supposé : neuf lignes comprises, ZÉRO
 * identifiant dans le DOM. Les lignes sont rendues par JavaScript et la
 * destination du fil n'existe qu'au clic — or ce rail s'interdit de cliquer,
 * parce qu'un clic sur une conversation est un effet observable chez Instagram
 * (fil ouvert, accusé de lecture) et non une lecture.
 *
 * ---------------------------------------------------------------------------
 * Où ils sont, et pourquoi cette source-là
 * ---------------------------------------------------------------------------
 *
 * Le même relevé a écouté ce que la page émet POUR SE CONSTRUIRE. Charger
 * `/direct/inbox/` déclenche, sans que personne le demande, une opération
 * GraphQL nommée `PolarisDirectInboxQuery`, dont la réponse contient la liste
 * des conversations avec, pour chacune :
 *
 *     …threads_by_folder.edges[].node.as_ig_direct_thread.thread_key
 *     …                                                  .is_group
 *     …                                                  .thread_title
 *     …                                                  .last_activity_timestamp_ms
 *     …                                                  .users[].username
 *
 * `thread_key` est exactement le segment que porte l'URL d'un fil : la même
 * réponse réseau (`/ajax/bulk-route-definitions/`) associe, dans le même
 * chargement, `/direct/t/<n>/` à un `thread_key` égal à `<n>`. L'identifiant
 * n'est donc pas déduit ni fabriqué — il est LU, puis réutilisé tel quel.
 *
 * Trois raisons de préférer cette source à toute autre :
 *
 *   1. **Elle est déjà émise.** Aucun appel n'est ajouté. Le rail se contente
 *      d'écouter une réponse que le simple affichage de la boîte a produite —
 *      ce que ferait un humain ouvrant sa messagerie.
 *   2. **Elle est en lecture.** La garde d'adjudication la laisse passer sous
 *      la règle `read_only_endpoint`, c'est-à-dire parce que son corps ne porte
 *      AUCUN marqueur de mutation. Rien n'a été élargi pour elle : elle passait
 *      déjà, et les mutations voisines — `IGDirectTextSendMutation`,
 *      `useIGDMarkThreadAsReadMutation` et sa validation — restent refusées par
 *      la même fonction, inchangée.
 *   3. **Elle nomme les participants.** Un identifiant sans contrepartie ne
 *      vaut rien ici : rattacher une réponse au mauvais prospect est pire que
 *      ne pas la rattacher du tout.
 *
 * ---------------------------------------------------------------------------
 * Ce module ne parle pas au réseau
 * ---------------------------------------------------------------------------
 *
 * Il reçoit un CORPS DE RÉPONSE déjà lu, en mémoire, et rend des données. Aucun
 * `fetch`, aucune `Page`, aucun accès disque. C'est ce qui permet d'exercer
 * chaque branche — réponse malformée, fil de groupe, homonymes — sur des
 * fixtures synthétiques, sans navigateur et sans compte réel.
 *
 * Et il ne conserve rien : les corps bruts ne sont ni journalisés, ni écrits,
 * ni rendus. Seuls sortent d'ici un identifiant, un handle, un titre et un
 * horodatage — c'est-à-dire ce qu'IG5 prévoyait déjà d'observer.
 */

import type { InboxRowMeasure } from '@/lib/instagram/inboxScan';
import { normalizeHandle } from '@/lib/instagram/identity';

// ---------------------------------------------------------------------------
// Ce qu'on accepte d'écouter
// ---------------------------------------------------------------------------

/**
 * L'opération GraphQL dont la réponse porte la liste des fils, nommément.
 *
 * Une ÉGALITÉ, comme pour `LIVE_DM_ALLOWED_GRAPHQL_OPERATIONS` et pour la même
 * raison : une regex du genre `/Inbox.*Query/` écouterait aussi ce que personne
 * n'a observé. Ce qui a été mesuré, et rien de plus.
 *
 * Ce n'est PAS une autorisation réseau : cette liste ne décide pas de ce qui
 * sort du processus — `classifyAdjudicationRequest` en décide, et elle n'a pas
 * changé. Elle décide seulement de ce qu'on prend la peine de LIRE parmi les
 * réponses déjà revenues.
 */
export const INBOX_THREAD_LIST_OPERATIONS: readonly string[] = ['PolarisDirectInboxQuery'];

/** Le chemin sur lequel cette opération a été observée. */
export const INBOX_THREAD_LIST_PATH = '/api/graphql';

/** Une réponse trop grosse n'est pas lue : la mémoire est bornée, comme le reste. */
export const MAX_INBOX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Cette réponse est-elle celle qu'on écoute ? Comparaison exacte du nom
 * d'opération et du chemin ; un statut non-200 n'est pas une liste de fils.
 */
export function isInboxThreadListResponse(input: {
  readonly path: string;
  readonly friendlyName: string | null;
  readonly status: number;
}): boolean {
  if (input.status !== 200) return false;
  if (input.path !== INBOX_THREAD_LIST_PATH) return false;
  if (input.friendlyName === null) return false;
  return INBOX_THREAD_LIST_OPERATIONS.includes(input.friendlyName);
}

// ---------------------------------------------------------------------------
// Ce qu'on en extrait
// ---------------------------------------------------------------------------

export interface NetworkThreadParticipant {
  readonly username: string;
  readonly fullName: string | null;
}

export interface NetworkInboxThread {
  /** Le segment d'URL d'un fil : `/direct/t/<threadKey>/`. Chiffres uniquement. */
  readonly threadKey: string;
  /** `null` quand la réponse ne le dit pas — un fil de groupe n'est jamais SUPPOSÉ 1:1. */
  readonly isGroup: boolean | null;
  readonly title: string | null;
  readonly lastActivityMs: number | null;
  readonly participants: readonly NetworkThreadParticipant[];
}

export interface NetworkInboxRead {
  /** La réponse a-t-elle été COMPRISE ? Un corps illisible n'est jamais une boîte vide. */
  readonly readable: boolean;
  readonly threads: readonly NetworkInboxThread[];
  readonly detail: string;
}

export const UNREADABLE_NETWORK_INBOX: NetworkInboxRead = Object.freeze({
  readable: false,
  threads: Object.freeze([]),
  detail: 'aucune réponse de liste de fils lue',
});

/** Un identifiant de fil plausible : des chiffres, et une longueur bornée. */
const THREAD_KEY_PATTERN = /^\d{5,40}$/;

/** Profondeur et budget de parcours — un corps hostile ne doit pas coûter une boucle infinie. */
const MAX_WALK_DEPTH = 16;
const MAX_WALK_NODES = 200_000;

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asMillis(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d{1,20}$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Découpe un corps qui peut être un JSON unique ou un flux ligne par ligne.
 *
 * Rien de deviné : les deux formes ont été observées chez Instagram selon
 * l'opération. Un corps dont AUCUNE forme ne parse ne rend aucun document, ce
 * qui fait échouer la lecture — et non conclure à une boîte vide.
 */
function parseDocuments(body: string): unknown[] {
  const trimmed = body.trim();
  if (trimmed.length === 0) return [];
  const documents: unknown[] = [];
  try {
    documents.push(JSON.parse(trimmed));
    return documents;
  } catch {
    // Un flux, peut-être.
  }
  for (const line of trimmed.split('\n')) {
    const candidate = line.trim();
    if (candidate.length === 0) continue;
    try {
      documents.push(JSON.parse(candidate));
    } catch {
      // Une ligne illisible ne condamne pas les autres, mais n'en invente aucune.
    }
  }
  return documents;
}

/**
 * Un nœud porte-t-il une conversation ? La question est posée sur la PRÉSENCE
 * d'un `thread_key` exploitable, pas sur le chemin qui y mène : Instagram sert
 * la même forme sous `threads_by_folder` et sous
 * `threads_by_system_folder_and_ig_inbox_folder`, et rien ne garantit qu'il
 * n'en ajoutera pas un troisième. Le parcours est structurel, donc il survit au
 * renommage d'un conteneur.
 */
function readThread(record: Record<string, unknown>): NetworkInboxThread | null {
  const key = record['thread_key'];
  if (typeof key !== 'string' || !THREAD_KEY_PATTERN.test(key)) return null;

  const rawUsers = record['users'];
  const participants: NetworkThreadParticipant[] = [];
  if (Array.isArray(rawUsers)) {
    for (const entry of rawUsers) {
      if (entry === null || typeof entry !== 'object') continue;
      const user = entry as Record<string, unknown>;
      const username = normalizeHandle(asString(user['username']) ?? '');
      if (username === null) continue;
      participants.push(Object.freeze({ username, fullName: asString(user['full_name']) }));
    }
  }

  const isGroup = record['is_group'];
  return Object.freeze({
    threadKey: key,
    isGroup: typeof isGroup === 'boolean' ? isGroup : null,
    title: asString(record['thread_title']),
    lastActivityMs: asMillis(record['last_activity_timestamp_ms']),
    participants: Object.freeze(participants),
  });
}

/**
 * Lit une réponse de liste de fils. Pure, et fermée en cas de doute.
 *
 * Trois issues, distinctes parce qu'elles ne se déduisent pas l'une de l'autre :
 *
 *   * corps illisible               → `readable: false` (on ne sait pas)
 *   * corps lisible, aucun fil      → `readable: true`, liste vide (on sait qu'on n'a rien vu)
 *   * corps lisible, des fils       → `readable: true`, la liste
 *
 * La première n'est JAMAIS rendue comme la deuxième. C'est la faute de IG2.4,
 * et elle ne se reproduit pas ici.
 */
export function extractInboxThreads(body: string): NetworkInboxRead {
  if (body.length > MAX_INBOX_RESPONSE_BYTES) {
    return Object.freeze({
      readable: false,
      threads: Object.freeze([]),
      detail: `réponse de ${body.length} octets — au-delà de la borne de lecture, non lue`,
    });
  }

  const documents = parseDocuments(body);
  if (documents.length === 0) {
    return Object.freeze({
      readable: false,
      threads: Object.freeze([]),
      detail: 'corps de réponse non analysable — aucune conclusion n’en est tirée',
    });
  }

  const byKey = new Map<string, NetworkInboxThread>();
  let sawEnvelope = false;
  const budget = { nodes: MAX_WALK_NODES };

  const walk = (node: unknown, depth: number): void => {
    if (depth > MAX_WALK_DEPTH || budget.nodes <= 0) return;
    budget.nodes -= 1;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    const thread = readThread(record);
    if (thread !== null && !byKey.has(thread.threadKey)) byKey.set(thread.threadKey, thread);
    for (const value of Object.values(record)) walk(value, depth + 1);
  };

  for (const document of documents) {
    if (document !== null && typeof document === 'object' && 'data' in (document as Record<string, unknown>)) {
      sawEnvelope = true;
    }
    walk(document, 0);
  }

  if (!sawEnvelope) {
    return Object.freeze({
      readable: false,
      threads: Object.freeze([]),
      detail: 'réponse sans enveloppe « data » — ce n’est pas une liste de fils, rien n’en est déduit',
    });
  }

  const threads = [...byKey.values()];
  return Object.freeze({
    readable: true,
    threads: Object.freeze(threads),
    detail: `${threads.length} conversation(s) nommée(s) par la réponse d’inbox`,
  });
}

/**
 * Réunit plusieurs réponses en une seule lecture.
 *
 * Un chargement de boîte peut en produire plusieurs (pagination, rafraîchissement
 * du dossier « général » puis « autres »). L'union se fait par `thread_key`, la
 * PREMIÈRE occurrence gagne, et la lisibilité est vraie dès qu'une réponse a été
 * comprise — mais une liste vide issue d'une seule réponse illisible reste
 * `readable: false`.
 */
export function mergeNetworkInboxReads(reads: readonly NetworkInboxRead[]): NetworkInboxRead {
  if (reads.length === 0) return UNREADABLE_NETWORK_INBOX;
  const byKey = new Map<string, NetworkInboxThread>();
  let readable = false;
  let unreadable = 0;
  for (const read of reads) {
    if (!read.readable) {
      unreadable += 1;
      continue;
    }
    readable = true;
    for (const thread of read.threads) if (!byKey.has(thread.threadKey)) byKey.set(thread.threadKey, thread);
  }
  const threads = [...byKey.values()];
  return Object.freeze({
    readable,
    threads: Object.freeze(threads),
    detail: readable
      ? `${threads.length} conversation(s) sur ${reads.length} réponse(s) lue(s)` +
        (unreadable > 0 ? `, ${unreadable} illisible(s)` : '')
      : `${reads.length} réponse(s) reçue(s), aucune comprise`,
  });
}

// ---------------------------------------------------------------------------
// Le rattachement ligne ↔ fil
// ---------------------------------------------------------------------------

export type ThreadIdSource = 'DOM' | 'NETWORK';

export type ThreadMatchBasis = 'dom_link' | 'network_handle_token' | 'network_display_name';

export type ThreadResolutionOutcome = 'RESOLVED' | 'NO_CANDIDATE' | 'AMBIGUOUS';

export interface ThreadResolution {
  readonly rowIndex: number;
  readonly threadId: string | null;
  readonly source: ThreadIdSource | null;
  readonly basis: ThreadMatchBasis | null;
  /** La contrepartie que le RÉSEAU nomme pour ce fil. `null` hors résolution réseau. */
  readonly counterpartyHandle: string | null;
  readonly outcome: ThreadResolutionOutcome;
  readonly detail: string;
}

function normalizeText(value: string): string {
  return value.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Le handle apparaît-il comme JETON ENTIER ? `atelier` ne doit pas matcher `atelieratelier_`. */
function mentionsHandleToken(haystack: string, handle: string): boolean {
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9._])${escaped}([^a-z0-9._]|$)`, 'i').test(haystack);
}

/**
 * Le texte de la ligne COMMENCE-t-il par ce nom, à la frontière d'un mot ?
 *
 * `innerText` d'une ligne rend « Nom », puis l'aperçu, puis l'heure — collés en
 * une phrase par la normalisation des blancs. Le nom est donc un PRÉFIXE, et
 * seulement un préfixe : le chercher n'importe où ferait correspondre un nom
 * cité dans le corps d'un message à la conversation de quelqu'un d'autre.
 *
 * La frontière est ce qui sépare « Julie » de « Julien Dupont ». Sans elle,
 * `startsWith` ferait de « Julie » une candidate pour la ligne de Julien, et
 * l'ambiguïté fabriquée ferait échouer les deux — ou pire, si Julien n'avait pas
 * de fil, attribuerait sa ligne à Julie.
 */
function startsWithName(text: string, name: string): boolean {
  if (name.length < 2) return false;
  if (text === name) return true;
  return text.startsWith(`${name} `);
}

/** Les noms sous lesquels un fil peut s'afficher : son titre, et le nom de sa contrepartie. */
function displayNamesOf(thread: NetworkInboxThread, counterparty: NetworkThreadParticipant): string[] {
  const names: string[] = [];
  for (const raw of [thread.title, counterparty.fullName]) {
    if (raw === null) continue;
    const normalized = normalizeText(raw);
    if (normalized.length >= 2 && !names.includes(normalized)) names.push(normalized);
  }
  return names;
}

/**
 * La contrepartie d'un fil 1:1, ou `null`.
 *
 * Trois refus, pas un seul : un fil de groupe (`is_group`), un fil dont
 * l'appartenance au groupe n'est pas dite (`null`, donc inconnue — et une
 * inconnue ne devient pas un « non »), et un fil qui nomme zéro ou plusieurs
 * participants hors de nous. Un fil dont on ne sait pas à qui il appartient ne
 * peut pas servir à attribuer une réponse à un prospect.
 */
function soleCounterparty(thread: NetworkInboxThread, viewerHandle: string): NetworkThreadParticipant | null {
  if (thread.isGroup !== false) return null;
  const others = thread.participants.filter((participant) => participant.username !== viewerHandle);
  if (others.length !== 1) return null;
  return others[0] ?? null;
}

/**
 * N'accepte un couple (ligne, fil) que s'il est MUTUELLEMENT unique : ce fil est
 * la seule candidate de cette ligne, ET cette ligne est la seule prétendante de
 * ce fil.
 *
 * La symétrie n'est pas un raffinement — c'est ce qui rend le résultat
 * indépendant de l'ordre de parcours. Une règle « premier arrivé, premier
 * servi » donnerait un fil différent selon que la boîte a été lue de haut en bas
 * ou l'inverse, et ce serait exactement le « choix arbitraire » que la mission
 * interdit. Ici, deux lignes qui se disputent un fil échouent TOUTES LES DEUX.
 */
function acceptMutuallyUnique(
  candidates: ReadonlyMap<number, ReadonlySet<string>>,
): Map<number, string> {
  const claimants = new Map<string, Set<number>>();
  for (const [rowIndex, keys] of candidates) {
    for (const key of keys) {
      const set = claimants.get(key) ?? new Set<number>();
      set.add(rowIndex);
      claimants.set(key, set);
    }
  }
  const accepted = new Map<number, string>();
  for (const [rowIndex, keys] of candidates) {
    if (keys.size !== 1) continue;
    const [key] = [...keys];
    if (key === undefined) continue;
    if (claimants.get(key)?.size !== 1) continue;
    accepted.set(rowIndex, key);
  }
  return accepted;
}

export interface ResolveThreadIdsInput {
  readonly rows: readonly InboxRowMeasure[];
  readonly network: NetworkInboxRead;
  /** Le compte qui relève. Il est exclu des contreparties — un fil n'est pas avec soi-même. */
  readonly viewerHandle: string;
}

/**
 * Rend, pour chaque ligne, l'identifiant de fil qu'on est en droit d'utiliser.
 *
 * L'ordre des sources est celui de la force de preuve :
 *
 *   1. **DOM** — la ligne porte elle-même un lien `/direct/t/<id>/`. Rien ne
 *      bat l'interface qui se nomme. Cette branche est morte aujourd'hui et
 *      reste écrite pour le jour où Instagram la ressuscite.
 *   2. **Réseau, par handle** — le handle exact de la contrepartie apparaît
 *      comme jeton entier dans la ligne (texte, `aria-label`, `alt`).
 *   3. **Réseau, par nom d'affichage** — le texte de la ligne commence par le
 *      titre du fil ou le nom de la contrepartie, à la frontière d'un mot.
 *
 * Le nom d'affichage vient en dernier parce qu'il est le signal le plus faible :
 * deux comptes peuvent s'appeler pareil, et un nom n'est pas une identité. Il
 * n'est retenu que MUTUELLEMENT UNIQUE, ce qui neutralise les homonymes au lieu
 * de trancher entre eux.
 *
 * Une ligne non résolue n'est pas une ligne sans réponse : elle sort en
 * `NO_CANDIDATE` ou `AMBIGUOUS`, et l'appelant la rend en `NOT_OPENED` — « je
 * n'ai pas pu ouvrir », jamais « il n'y avait rien ».
 */
export function resolveThreadIds(input: ResolveThreadIdsInput): readonly ThreadResolution[] {
  const viewer = normalizeHandle(input.viewerHandle) ?? '';
  const resolutions = new Map<number, ThreadResolution>();

  // ---- 1. Ce que le DOM dit de lui-même ----------------------------------
  const claimedByDom = new Set<string>();
  for (const row of input.rows) {
    if (row.threadId === null) continue;
    claimedByDom.add(row.threadId);
    resolutions.set(
      row.index,
      Object.freeze({
        rowIndex: row.index,
        threadId: row.threadId,
        source: 'DOM' as const,
        basis: 'dom_link' as const,
        counterpartyHandle: null,
        outcome: 'RESOLVED' as const,
        detail: 'la ligne porte elle-même un lien de fil',
      }),
    );
  }

  const pending = input.rows.filter((row) => !resolutions.has(row.index));
  if (pending.length === 0) return Object.freeze([...resolutions.values()]);

  if (!input.network.readable) {
    for (const row of pending) {
      resolutions.set(
        row.index,
        Object.freeze({
          rowIndex: row.index,
          threadId: null,
          source: null,
          basis: null,
          counterpartyHandle: null,
          outcome: 'NO_CANDIDATE' as const,
          detail:
            'aucun identifiant dans la ligne, et la liste réseau des fils n’a pas été comprise — ' +
            'aucune URL n’est fabriquée',
        }),
      );
    }
    return Object.freeze([...resolutions.values()].sort((a, b) => a.rowIndex - b.rowIndex));
  }

  // ---- Les fils exploitables : 1:1, contrepartie unique, non déjà pris ----
  const usable: { thread: NetworkInboxThread; counterparty: NetworkThreadParticipant }[] = [];
  let rejectedThreads = 0;
  for (const thread of input.network.threads) {
    if (claimedByDom.has(thread.threadKey)) continue;
    const counterparty = soleCounterparty(thread, viewer);
    if (counterparty === null) {
      rejectedThreads += 1;
      continue;
    }
    usable.push({ thread, counterparty });
  }

  const searchable = new Map<number, { text: string; wide: string }>();
  for (const row of pending) {
    const text = normalizeText(row.text);
    const wide = [text, ...row.ariaLabels.map(normalizeText), ...row.imageAlts.map(normalizeText)].join(' | ');
    searchable.set(row.index, { text, wide });
  }

  const matchedRows = new Set<number>();
  const matchedThreads = new Set<string>();
  /** Ce qu'une ligne aurait pu être, tous passages confondus — sert à dire POURQUOI ça a échoué. */
  const everSeen = new Map<number, Set<string>>();

  const runPass = (
    basis: ThreadMatchBasis,
    matches: (row: { text: string; wide: string }, entry: { thread: NetworkInboxThread; counterparty: NetworkThreadParticipant }) => boolean,
  ): void => {
    const candidates = new Map<number, Set<string>>();
    for (const row of pending) {
      if (matchedRows.has(row.index)) continue;
      const haystack = searchable.get(row.index);
      if (haystack === undefined) continue;
      const keys = new Set<string>();
      for (const entry of usable) {
        if (matchedThreads.has(entry.thread.threadKey)) continue;
        if (matches(haystack, entry)) keys.add(entry.thread.threadKey);
      }
      if (keys.size === 0) continue;
      candidates.set(row.index, keys);
      const seen = everSeen.get(row.index) ?? new Set<string>();
      for (const key of keys) seen.add(key);
      everSeen.set(row.index, seen);
    }

    for (const [rowIndex, threadKey] of acceptMutuallyUnique(candidates)) {
      const entry = usable.find((item) => item.thread.threadKey === threadKey);
      if (entry === undefined) continue;
      matchedRows.add(rowIndex);
      matchedThreads.add(threadKey);
      resolutions.set(
        rowIndex,
        Object.freeze({
          rowIndex,
          threadId: threadKey,
          source: 'NETWORK' as const,
          basis,
          counterpartyHandle: entry.counterparty.username,
          outcome: 'RESOLVED' as const,
          detail:
            basis === 'network_handle_token'
              ? `fil nommé par la liste d’inbox, reconnu par le handle @${entry.counterparty.username}`
              : `fil nommé par la liste d’inbox, reconnu par le nom d’affichage (contrepartie @${entry.counterparty.username})`,
        }),
      );
    }
  };

  runPass('network_handle_token', (row, entry) => mentionsHandleToken(row.wide, entry.counterparty.username));
  runPass('network_display_name', (row, entry) =>
    displayNamesOf(entry.thread, entry.counterparty).some((name) => startsWithName(row.text, name)),
  );

  for (const row of pending) {
    if (resolutions.has(row.index)) continue;
    const seen = everSeen.get(row.index);
    const ambiguous = seen !== undefined && seen.size > 0;
    resolutions.set(
      row.index,
      Object.freeze({
        rowIndex: row.index,
        threadId: null,
        source: null,
        basis: null,
        counterpartyHandle: null,
        outcome: ambiguous ? ('AMBIGUOUS' as const) : ('NO_CANDIDATE' as const),
        detail: ambiguous
          ? `${seen?.size ?? 0} fil(s) réseau correspondent à cette ligne sans qu’aucun ne lui soit propre — ` +
            'aucun n’est retenu, l’ambiguïté se tranche à la main'
          : `aucun fil réseau ne correspond à cette ligne (${usable.length} fil(s) exploitable(s), ` +
            `${rejectedThreads} écarté(s) faute de contrepartie unique)`,
      }),
    );
  }

  return Object.freeze([...resolutions.values()].sort((a, b) => a.rowIndex - b.rowIndex));
}
