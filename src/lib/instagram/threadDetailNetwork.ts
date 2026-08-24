/**
 * IG5 R3 — les MESSAGES d'un fil, lus là où Instagram les met vraiment.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi cette source, et pas le DOM
 * ---------------------------------------------------------------------------
 *
 * R2 a ouvert huit fils en lecture et n'y a vu ZÉRO bulle. La cause a été
 * mesurée : `chooseThreadScope` retient le niveau 1 — la rangée de commandes du
 * composeur — là où la conversation vit au niveau 11. Ce n'est pas un seuil à
 * retoucher au passage : cette fonction est partagée avec l'adjudication de
 * remise (IG2) et le canari, et la corriger demande sa propre preuve de
 * non-régression. Elle n'est donc PAS touchée ici.
 *
 * Le fil, lui, se laisse lire ailleurs. Charger `/direct/t/<id>/` fait émettre
 * à la page, d'elle-même, une opération `IGDThreadDetailQuery` dont la réponse
 * porte la conversation. C'est la même technique qu'en R2 pour les identifiants
 * de fil : une OREILLE sur une réponse déjà revenue, pas un appel de plus.
 *
 * ---------------------------------------------------------------------------
 * Ce que le relevé du 20 août 2026 a mesuré, et qui commande tout ce fichier
 * ---------------------------------------------------------------------------
 *
 * Ouvrir UN fil fait revenir SEIZE réponses `IGDThreadDetailQuery`, dont
 * DEUX seulement nomment le fil demandé. Les quatorze autres sont les
 * conversations voisines, que l'interface précharge pour sa liste.
 *
 * C'est le fait le plus important de cette mission. Un lecteur qui prendrait
 * « les messages de la réponse » sans vérifier de QUEL fil elle parle
 * ingérerait quatorze conversations privées sans rapport, les attribuerait au
 * prospect qu'on croyait lire, et fabriquerait des réponses commerciales qui
 * n'existent pas. La vérification d'identité (§3) n'est donc pas une ceinture
 * de sécurité : c'est la fonction principale de ce module.
 *
 * Forme observée, à l'octet près :
 *
 *     data.get_slide_thread_nullable.as_ig_direct_thread
 *         .thread_key                    → le segment de /direct/t/<n>/
 *         .is_group / .users[].username
 *         .slide_messages.edges[].node
 *             .message_id      string, 34 caractères, préfixe « mid. »
 *             .timestamp_ms    string  (et non un nombre)
 *             .text_body       string  (null hors contenu texte)
 *             .content_type    « TEXT » sur les messages texte
 *             .sender.user_dict.username
 *
 * ---------------------------------------------------------------------------
 * Pourquoi le parcours est ANCRÉ, et non structurel
 * ---------------------------------------------------------------------------
 *
 * `inboxNetwork` cherche ses fils par la PRÉSENCE d'un `thread_key`, où qu'il
 * soit, et c'est le bon choix là-bas : Instagram sert la même forme sous deux
 * conteneurs différents. Ici, c'est exactement l'inverse.
 *
 * Un nœud de message contient `replied_to_message`, qui porte lui-même
 * `message_id`, `text_body`, `timestamp_ms` et `sender` — la citation d'un
 * message plus ancien. Un parcours structurel la compterait comme un message du
 * fil. Le relevé l'a vue : deux citations dans une conversation de vingt
 * messages. Ancrer le chemin est donc ce qui empêche une citation de devenir
 * une réponse, et le préchargement de devenir une conversation.
 *
 * ---------------------------------------------------------------------------
 * Ce module ne parle pas au réseau et ne garde rien
 * ---------------------------------------------------------------------------
 *
 * Il reçoit un corps déjà lu, en mémoire, et rend des données. Aucun `fetch`,
 * aucune `Page`, aucun disque — donc chaque branche s'exerce sur des fixtures
 * synthétiques. La réponse GraphQL complète n'est ni journalisée, ni rendue, ni
 * persistée : il n'en sort qu'un identifiant, un handle, un horodatage et le
 * texte du message.
 */

import { normalizeHandle } from '@/lib/instagram/identity';

// ---------------------------------------------------------------------------
// Ce qu'on accepte d'écouter
// ---------------------------------------------------------------------------

/**
 * L'opération dont la réponse porte les messages d'un fil.
 *
 * Une ÉGALITÉ, comme `INBOX_THREAD_LIST_OPERATIONS` et pour la même raison :
 * une regex du genre `/ThreadDetail/` écouterait aussi ce que personne n'a
 * observé.
 *
 * Ce n'est PAS une autorisation réseau. Cette liste ne décide pas de ce qui sort
 * du processus — `classifyAdjudicationRequest` en décide, et elle n'a pas
 * changé. Le relevé LIVE l'a confirmé plutôt que supposé : les seize réponses
 * sont passées sous la règle générale `read_only_endpoint`, c'est-à-dire parce
 * que leur corps ne porte aucun marqueur de mutation.
 */
export const THREAD_DETAIL_OPERATIONS: readonly string[] = ['IGDThreadDetailQuery'];

/** Le chemin sur lequel cette opération a été observée. */
export const THREAD_DETAIL_PATH = '/api/graphql';

/** Une réponse trop grosse n'est pas lue : la mémoire est bornée, comme le reste. */
export const MAX_THREAD_DETAIL_BYTES = 8 * 1024 * 1024;

/** Bornes de lecture — un corps hostile ne doit pas coûter une boucle infinie. */
export const MAX_THREAD_DETAIL_MESSAGES = 500;

/**
 * L'identifiant natif d'un message, tel qu'Instagram l'émet.
 *
 * Volontairement LARGE, et l'histoire de ce motif dit pourquoi. La première
 * version énumérait l'alphabet cru observé (`[A-Za-z0-9._:=+/-]`) ; le premier
 * relevé LIVE a alors rendu « fil lu, identité vérifiée, ZÉRO message » sur les
 * huit fils, en rejetant chaque nœud. La cause, mesurée et non supposée : les
 * identifiants ont la forme `mid.$…`, et le `$` manquait à la liste.
 *
 * La leçon n'est pas « ajouter `$` ». C'est que la forme interne d'un
 * identifiant TIERS n'est pas un contrat qu'on peut resserrer : Instagram peut
 * en changer demain sans prévenir, et un motif trop étroit ne refuse pas une
 * donnée douteuse — il fait disparaître des messages réels en silence, ce qui
 * est exactement le genre de « zéro » trompeur que ce rail existe pour éviter.
 *
 * Ce qui est donc vérifié est ce qui compte réellement pour l'usage qu'on en
 * fait — une clé de déduplication : une chaîne opaque, imprimable, sans espace
 * ni caractère de contrôle, et bornée. Un identifiant exotique mais STABLE
 * déduplique correctement ; un identifiant rejeté ne déduplique rien du tout.
 */
const PROVIDER_MESSAGE_ID = /^[\x21-\x7E]{8,200}$/;

/** Un identifiant de fil : des chiffres, et une longueur bornée. Même règle qu'en R2. */
const THREAD_KEY_PATTERN = /^\d{5,40}$/;

/**
 * Bornes d'un horodatage acceptable, en millisecondes.
 *
 * 2010 est antérieur à Instagram Direct ; 2100 est absurde. Un horodatage hors
 * de ces bornes n'est pas « corrigé » — il rend le message inutilisable, parce
 * qu'un message mal daté serait comparé à tort à la date de notre envoi (§7).
 */
export const MIN_TIMESTAMP_MS = Date.UTC(2010, 0, 1);
export const MAX_TIMESTAMP_MS = Date.UTC(2100, 0, 1);

export function isThreadDetailResponse(input: {
  readonly path: string;
  readonly friendlyName: string | null;
  readonly status: number;
}): boolean {
  if (input.status !== 200) return false;
  if (input.path !== THREAD_DETAIL_PATH) return false;
  if (input.friendlyName === null) return false;
  return THREAD_DETAIL_OPERATIONS.includes(input.friendlyName);
}

// ---------------------------------------------------------------------------
// Ce qu'on en extrait
// ---------------------------------------------------------------------------

/** Le contenu d'un message : du texte, ou autre chose qui n'en a pas. */
export type ThreadMessageContentKind = 'TEXT' | 'NON_TEXT';

export interface NetworkThreadMessage {
  /** L'identifiant émis par Instagram. Jamais fabriqué : sans lui, pas de message. */
  readonly providerMessageId: string;
  /** L'expéditeur, nommé par la réponse. Sans lui, le message n'est pas attribuable. */
  readonly senderUsername: string;
  /** L'instant réel du message, en millisecondes. Jamais déduit d'un âge affiché. */
  readonly timestampMs: number;
  /** `null` quand le message n'est pas du texte — un vide n'est pas un texte. */
  readonly text: string | null;
  readonly contentKind: ThreadMessageContentKind;
}

export interface NetworkThreadParticipantRef {
  readonly username: string;
}

/**
 * Pourquoi une réponse a été acceptée, ou pas, comme parlant du fil demandé.
 *
 * Trois valeurs, parce que ce sont trois faits différents et qu'aucun ne se
 * déduit des autres : « c'est bien ce fil », « c'est un autre fil », « je n'ai
 * pas su lire ». Confondre les deux dernières est la faute d'IG2.4.
 */
export type ThreadIdentityVerdict = 'MATCH' | 'THREAD_IDENTITY_MISMATCH' | 'UNREADABLE';

export interface ThreadDetailRead {
  /** La réponse a-t-elle été COMPRISE ? Un corps illisible n'est jamais un fil vide. */
  readonly readable: boolean;
  readonly identity: ThreadIdentityVerdict;
  /** Le fil dont cette réponse parle réellement. `null` quand elle ne le dit pas. */
  readonly threadKey: string | null;
  /** `null` quand la réponse ne le dit pas — un fil n'est jamais SUPPOSÉ 1:1. */
  readonly isGroup: boolean | null;
  readonly participants: readonly NetworkThreadParticipantRef[];
  /**
   * Les messages du fil, du plus ancien au plus récent. Vide ET `readable` veut
   * dire « ce fil ne contient rien » ; vide et non `readable` veut dire « je
   * n'ai pas su ». Les deux ne se confondent jamais.
   */
  readonly messages: readonly NetworkThreadMessage[];
  /**
   * Nœuds écartés faute d'identité, d'horodatage ou d'expéditeur exploitables.
   * Non nul veut dire que la lecture est INCOMPLÈTE — on ne l'invente pas.
   */
  readonly rejected: number;
  readonly detail: string;
}

export const UNREADABLE_THREAD_DETAIL: ThreadDetailRead = Object.freeze({
  readable: false,
  identity: 'UNREADABLE' as const,
  threadKey: null,
  isGroup: null,
  participants: Object.freeze([]),
  messages: Object.freeze([]),
  rejected: 0,
  detail: 'aucune réponse de détail de fil lue',
});

function unreadable(detail: string): ThreadDetailRead {
  return Object.freeze({ ...UNREADABLE_THREAD_DETAIL, detail });
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * L'horodatage d'un message, en millisecondes.
 *
 * Le relevé LIVE l'a vu servi comme une CHAÎNE de chiffres, pas comme un
 * nombre — les deux sont acceptés parce que la forme d'un champ n'est pas un
 * contrat, mais rien d'autre ne l'est : un horodatage absent, non numérique ou
 * hors bornes rend `null`, et un `null` retire le message plutôt que de le
 * dater au hasard.
 */
function readTimestampMs(value: unknown): number | null {
  let millis: number | null = null;
  if (typeof value === 'number' && Number.isFinite(value)) millis = value;
  else if (typeof value === 'string' && /^\d{1,20}$/.test(value)) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) millis = parsed;
  }
  if (millis === null) return null;
  const rounded = Math.trunc(millis);
  if (rounded < MIN_TIMESTAMP_MS || rounded > MAX_TIMESTAMP_MS) return null;
  return rounded;
}

/** Le handle de l'expéditeur, lu à `sender.user_dict.username`. */
function readSender(node: Record<string, unknown>): string | null {
  const sender = node['sender'];
  if (sender === null || typeof sender !== 'object') return null;
  const userDict = (sender as Record<string, unknown>)['user_dict'];
  if (userDict === null || typeof userDict !== 'object') return null;
  const username = (userDict as Record<string, unknown>)['username'];
  return typeof username === 'string' ? normalizeHandle(username) : null;
}

/**
 * Un nœud de message, ou `null`.
 *
 * Trois refus, et aucun n'est réparé : sans identifiant natif, le message ne
 * peut pas être dédupliqué ; sans expéditeur, il n'est pas attribuable ; sans
 * horodatage exploitable, il ne peut pas être situé par rapport à notre envoi.
 * Chacun de ces trous ferait inventer une donnée pour combler le manque — c'est
 * l'interdit n°2, et la réponse est de laisser tomber le message en le
 * COMPTANT, jamais de le compléter.
 */
function readMessage(node: Record<string, unknown>): NetworkThreadMessage | null {
  const providerMessageId = asNonEmptyString(node['message_id']);
  if (providerMessageId === null || !PROVIDER_MESSAGE_ID.test(providerMessageId)) return null;

  const senderUsername = readSender(node);
  if (senderUsername === null) return null;

  const timestampMs = readTimestampMs(node['timestamp_ms']);
  if (timestampMs === null) return null;

  // Le contenu. `text_body` porte le texte des messages texte et vaut `null`
  // ailleurs (photo, note vocale, partage). Un message sans texte reste un
  // MESSAGE — le retirer ferait conclure « pas de réponse » à un prospect qui a
  // répondu par une image.
  const rawText = node['text_body'];
  const text = typeof rawText === 'string' && rawText.length > 0 ? rawText : null;
  const contentType = asNonEmptyString(node['content_type']);
  const contentKind: ThreadMessageContentKind =
    text !== null && (contentType === null || contentType.toUpperCase() === 'TEXT') ? 'TEXT' : 'NON_TEXT';

  return Object.freeze({
    providerMessageId,
    senderUsername,
    timestampMs,
    text: contentKind === 'TEXT' ? text : null,
    contentKind,
  });
}

/**
 * Découpe un corps qui peut être un JSON unique ou un flux ligne par ligne.
 * Même règle qu'en R2 : les deux formes ont été observées selon l'opération.
 */
function parseDocuments(body: string): unknown[] {
  const trimmed = body.trim();
  if (trimmed.length === 0) return [];
  try {
    return [JSON.parse(trimmed)];
  } catch {
    // Un flux, peut-être.
  }
  const documents: unknown[] = [];
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

/** Le conteneur de fil, au chemin exact où le relevé l'a vu. */
function readThreadContainer(document: unknown): Record<string, unknown> | null {
  if (document === null || typeof document !== 'object') return null;
  const data = (document as Record<string, unknown>)['data'];
  if (data === null || typeof data !== 'object') return null;
  const nullable = (data as Record<string, unknown>)['get_slide_thread_nullable'];
  if (nullable === null || typeof nullable !== 'object') return null;
  const thread = (nullable as Record<string, unknown>)['as_ig_direct_thread'];
  if (thread === null || typeof thread !== 'object') return null;
  return thread as Record<string, unknown>;
}

export interface ExtractThreadDetailInput {
  readonly body: string;
  /** Le fil qu'on a DEMANDÉ. Toute réponse qui en nomme un autre est écartée. */
  readonly expectedThreadKey: string;
}

/**
 * Lit une réponse de détail de fil. Pure, et fermée en cas de doute.
 *
 * Quatre issues, distinctes parce qu'aucune ne se déduit d'une autre :
 *
 *   * corps illisible ou sans conteneur de fil → `UNREADABLE` (on ne sait pas)
 *   * conteneur nommant un AUTRE fil           → `THREAD_IDENTITY_MISMATCH`
 *   * bon fil, sans conteneur de messages      → `UNREADABLE` (cette réponse-là
 *     ne portait pas la conversation — ce n'est pas « la conversation est vide »)
 *   * bon fil, messages lus                    → `MATCH`
 *
 * La troisième mérite d'être dite : sur les deux réponses qui nomment le fil
 * demandé, le relevé en a vu porter `slide_messages` et le module doit pouvoir
 * rencontrer l'autre cas sans conclure au vide.
 */
export function extractThreadDetail(input: ExtractThreadDetailInput): ThreadDetailRead {
  if (input.body.length > MAX_THREAD_DETAIL_BYTES) {
    return unreadable(`réponse de ${input.body.length} octets — au-delà de la borne de lecture, non lue`);
  }
  if (!THREAD_KEY_PATTERN.test(input.expectedThreadKey)) {
    return unreadable(`identifiant de fil attendu invalide : « ${input.expectedThreadKey} »`);
  }

  const documents = parseDocuments(input.body);
  if (documents.length === 0) {
    return unreadable('corps de réponse non analysable — aucune conclusion n’en est tirée');
  }

  let container: Record<string, unknown> | null = null;
  for (const document of documents) {
    const candidate = readThreadContainer(document);
    if (candidate !== null) {
      container = candidate;
      break;
    }
  }
  if (container === null) {
    return unreadable('réponse sans conteneur de fil — ce n’est pas un détail de conversation');
  }

  const threadKey = asNonEmptyString(container['thread_key']);
  if (threadKey === null || !THREAD_KEY_PATTERN.test(threadKey)) {
    return unreadable('conteneur de fil sans identifiant lisible — aucun message n’en est tiré');
  }
  if (threadKey !== input.expectedThreadKey) {
    // Le cas NORMAL, et de loin le plus fréquent : quatorze réponses sur seize
    // parlent d'une autre conversation. Refuser ici n'est pas une anomalie,
    // c'est ce qui empêche d'attribuer la conversation d'un inconnu au prospect
    // qu'on croyait lire.
    return Object.freeze({
      readable: true,
      identity: 'THREAD_IDENTITY_MISMATCH' as const,
      threadKey,
      isGroup: null,
      participants: Object.freeze([]),
      messages: Object.freeze([]),
      rejected: 0,
      detail: `réponse portant le fil ${threadKey}, or ${input.expectedThreadKey} était demandé — écartée`,
    });
  }

  const rawGroup = container['is_group'];
  const isGroup = typeof rawGroup === 'boolean' ? rawGroup : null;

  const participants: NetworkThreadParticipantRef[] = [];
  const rawUsers = container['users'];
  if (Array.isArray(rawUsers)) {
    for (const entry of rawUsers) {
      if (entry === null || typeof entry !== 'object') continue;
      const username = normalizeHandle(asNonEmptyString((entry as Record<string, unknown>)['username']) ?? '');
      if (username === null) continue;
      if (!participants.some((participant) => participant.username === username)) {
        participants.push(Object.freeze({ username }));
      }
    }
  }

  const slideMessages = container['slide_messages'];
  if (slideMessages === null || typeof slideMessages !== 'object') {
    return Object.freeze({
      readable: false,
      identity: 'UNREADABLE' as const,
      threadKey,
      isGroup,
      participants: Object.freeze(participants),
      messages: Object.freeze([]),
      rejected: 0,
      detail:
        `la réponse nomme bien le fil ${threadKey} mais ne porte aucun conteneur de messages — ` +
        'aucune absence de message n’en est déduite',
    });
  }

  const edges = (slideMessages as Record<string, unknown>)['edges'];
  if (!Array.isArray(edges)) {
    return Object.freeze({
      readable: false,
      identity: 'UNREADABLE' as const,
      threadKey,
      isGroup,
      participants: Object.freeze(participants),
      messages: Object.freeze([]),
      rejected: 0,
      detail: `conteneur de messages du fil ${threadKey} sans liste d’arêtes — lecture abandonnée`,
    });
  }

  const messages: NetworkThreadMessage[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  for (const edge of edges.slice(0, MAX_THREAD_DETAIL_MESSAGES)) {
    if (edge === null || typeof edge !== 'object') {
      rejected += 1;
      continue;
    }
    const node = (edge as Record<string, unknown>)['node'];
    if (node === null || typeof node !== 'object') {
      rejected += 1;
      continue;
    }
    // Seul le nœud de l'arête est lu. On ne descend PAS dans
    // `replied_to_message` : la citation d'un message plus ancien n'est pas un
    // message du fil, et l'y confondre en fabriquerait un.
    const message = readMessage(node as Record<string, unknown>);
    if (message === null) {
      rejected += 1;
      continue;
    }
    if (seen.has(message.providerMessageId)) continue;
    seen.add(message.providerMessageId);
    messages.push(message);
  }

  // Du plus ancien au plus récent, par l'horodatage RÉEL — pas par l'ordre de
  // la réponse, qu'Instagram n'a jamais promis. L'identifiant natif départage
  // deux messages de la même milliseconde, pour que l'ordre soit total et
  // reproductible.
  messages.sort(
    (a, b) =>
      a.timestampMs - b.timestampMs || (a.providerMessageId < b.providerMessageId ? -1 : a.providerMessageId > b.providerMessageId ? 1 : 0),
  );

  return Object.freeze({
    readable: true,
    identity: 'MATCH' as const,
    threadKey,
    isGroup,
    participants: Object.freeze(participants),
    messages: Object.freeze(messages),
    rejected,
    detail:
      `${messages.length} message(s) lu(s) dans le fil ${threadKey}` +
      (rejected > 0 ? ` ; ${rejected} nœud(s) écarté(s) faute d’identité, d’expéditeur ou d’horodatage` : ''),
  });
}

/**
 * Réunit les réponses d'un même chargement de fil.
 *
 * Le relevé LIVE a mesuré seize réponses pour une ouverture, dont deux nommant
 * le fil demandé et portant la même conversation. L'union se fait par
 * identifiant natif de message — la seule clé qu'Instagram émette lui-même —,
 * ce qui rend le résultat indépendant du nombre de réponses et de leur ordre
 * d'arrivée.
 *
 * `readable` devient vrai dès qu'UNE réponse a été comprise. Zéro réponse
 * comprise reste `readable: false`, donc « je n'ai pas su lire ce fil », jamais
 * « ce fil est vide ».
 */
export function mergeThreadDetailReads(reads: readonly ThreadDetailRead[]): ThreadDetailRead {
  if (reads.length === 0) return UNREADABLE_THREAD_DETAIL;

  const matching = reads.filter((read) => read.identity === 'MATCH');
  const mismatched = reads.filter((read) => read.identity === 'THREAD_IDENTITY_MISMATCH').length;

  if (matching.length === 0) {
    const identity: ThreadIdentityVerdict = mismatched === reads.length ? 'THREAD_IDENTITY_MISMATCH' : 'UNREADABLE';
    return Object.freeze({
      ...UNREADABLE_THREAD_DETAIL,
      identity,
      detail:
        `${reads.length} réponse(s) de détail reçue(s), aucune ne porte les messages du fil demandé` +
        (mismatched > 0 ? ` (${mismatched} concernaient un autre fil)` : ''),
    });
  }

  const byId = new Map<string, NetworkThreadMessage>();
  const participants: NetworkThreadParticipantRef[] = [];
  let isGroup: boolean | null = null;
  let rejected = 0;
  let threadKey: string | null = null;

  for (const read of matching) {
    threadKey ??= read.threadKey;
    if (read.isGroup !== null) isGroup = read.isGroup;
    rejected += read.rejected;
    for (const message of read.messages) if (!byId.has(message.providerMessageId)) byId.set(message.providerMessageId, message);
    for (const participant of read.participants) {
      if (!participants.some((known) => known.username === participant.username)) participants.push(participant);
    }
  }

  const messages = [...byId.values()].sort(
    (a, b) =>
      a.timestampMs - b.timestampMs || (a.providerMessageId < b.providerMessageId ? -1 : a.providerMessageId > b.providerMessageId ? 1 : 0),
  );

  return Object.freeze({
    readable: true,
    identity: 'MATCH' as const,
    threadKey,
    isGroup,
    participants: Object.freeze(participants),
    messages: Object.freeze(messages),
    rejected,
    detail:
      `${messages.length} message(s) sur ${matching.length} réponse(s) portant le fil demandé ` +
      `(${reads.length} reçue(s), ${mismatched} concernant un autre fil)` +
      (rejected > 0 ? ` ; ${rejected} nœud(s) écarté(s)` : ''),
  });
}

// ---------------------------------------------------------------------------
// La direction, par l'IDENTITÉ de l'expéditeur
// ---------------------------------------------------------------------------

/**
 * De qui vient ce message ?
 *
 * `SELF` — l'expéditeur est le compte qui relève. C'est notre DM.
 * `COUNTERPARTY` — l'expéditeur est la contrepartie attendue du fil.
 * `AMBIGUOUS` — quelqu'un d'autre, ou une contrepartie non établie.
 *
 * Le troisième cas n'est pas une curiosité théorique : un fil de groupe, un
 * compte renommé ou une contrepartie qu'on n'a pas su nommer y tombent. Le
 * traiter comme entrant attribuerait à un prospect les mots de quelqu'un
 * d'autre — donc il ne descend pas dans D2.
 *
 * Ce qui n'entre PAS dans cette décision, et c'est le point de §4 : l'ordre
 * d'affichage, la position de la bulle, et « le dernier message n'est pas de
 * nous ». Aucun des trois n'est une identité.
 */
export type MessageAuthor = 'SELF' | 'COUNTERPARTY' | 'AMBIGUOUS';

export function classifyAuthor(input: {
  readonly senderUsername: string;
  readonly accountHandle: string;
  readonly counterpartyHandle: string | null;
}): MessageAuthor {
  const sender = normalizeHandle(input.senderUsername);
  const account = normalizeHandle(input.accountHandle);
  if (sender === null || account === null) return 'AMBIGUOUS';
  if (sender === account) return 'SELF';
  const counterparty = input.counterpartyHandle === null ? null : normalizeHandle(input.counterpartyHandle);
  if (counterparty !== null && sender === counterparty) return 'COUNTERPARTY';
  return 'AMBIGUOUS';
}

/**
 * La contrepartie d'un fil 1:1, telle que la réponse de détail la nomme.
 *
 * Trois refus, comme pour la liste d'inbox (R2) : un fil de groupe, un fil dont
 * l'appartenance n'est pas dite (`null`, donc inconnue — et une inconnue ne
 * devient pas un « non »), et un fil qui nomme zéro ou plusieurs participants
 * hors de nous.
 */
export function soleCounterpartyOf(read: ThreadDetailRead, accountHandle: string): string | null {
  if (read.identity !== 'MATCH' || read.isGroup !== false) return null;
  const account = normalizeHandle(accountHandle);
  if (account === null) return null;
  const others = read.participants.filter((participant) => participant.username !== account);
  if (others.length !== 1) return null;
  return others[0]?.username ?? null;
}
