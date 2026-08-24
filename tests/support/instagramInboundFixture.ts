import { createHash } from 'node:crypto';
import type {
  InstagramInboundRail,
  InstagramInboundSweep,
  InstagramInboundSweepInput,
  ObservedInboundThread,
} from '@/lib/instagram/inboundRail';
import type { MessageDirection, ObservedThreadMessage } from '@/lib/instagram/inboundThread';
import type { ThreadHarvest } from '@/lib/instagram/threadHarvest';
import type { AncestorLevel, ObservedHandleLink, ObservedNode, ObservedRect } from '@/lib/instagram/threadObservation';

/**
 * Fixtures du rail entrant Instagram, partagées par les tests IG5.1.
 *
 * Un fil de discussion Instagram est reconstitué comme la page le MESURE :
 * une chaîne d'ancêtres et des rectangles. C'est ce qui permet d'exercer
 * l'extraction, la direction et l'ambiguïté sans navigateur — et donc d'écrire
 * les cas qu'une vraie conversation mettrait des semaines à produire.
 *
 * Aucune entreprise, aucun compte et aucun texte réel n'apparaît ici.
 */

/** Le panneau de conversation reconstitué. Les valeurs sont celles d'un rendu 1280×900. */
export const THREAD_SCOPE: ObservedRect = Object.freeze({ left: 100, right: 900, top: 100, bottom: 840 });
export const COMPOSER_RECT: ObservedRect = Object.freeze({ left: 100, right: 900, top: 800, bottom: 840 });

/** Une bulle collée au bord GAUCHE : l'interface place là ce qui vient d'en face. */
export function incomingRect(top: number): ObservedRect {
  return Object.freeze({ left: 110, right: 400, top, bottom: top + 40 });
}

/** Une bulle collée au bord DROIT : nos propres messages. */
export function outgoingRect(top: number): ObservedRect {
  return Object.freeze({ left: 600, right: 890, top, bottom: top + 40 });
}

/** Un élément CENTRÉ : séparateur de date, mention « Vu ». Aucun bord franc. */
export function centeredRect(top: number): ObservedRect {
  return Object.freeze({ left: 400, right: 600, top, bottom: top + 20 });
}

export interface BubbleSpec {
  readonly text: string;
  readonly rect: ObservedRect;
  readonly ariaLabel?: string | null;
  readonly role?: string | null;
  readonly tag?: string;
  readonly visible?: boolean;
}

export interface HarvestSpec {
  readonly bubbles: readonly BubbleSpec[];
  readonly handles?: readonly string[];
  readonly truncated?: boolean;
  readonly readable?: boolean;
  /** Rend la chaîne d'ancêtres inexploitable : aucun périmètre ne sera retenu. */
  readonly noThreadScope?: boolean;
}

/**
 * Construit une récolte de fil.
 *
 * La chaîne d'ancêtres a deux niveaux, et c'est délibéré : le niveau 0 est le
 * conteneur immédiat du composeur — celui qui a fait échouer le premier canari
 * (IG2.3) — et il doit être ÉCARTÉ au profit du niveau 1, qui porte la
 * conversation. Le test exerce donc `chooseThreadScope` pour de vrai, pas une
 * portée fabriquée.
 */
export function makeHarvest(spec: HarvestSpec): ThreadHarvest {
  const composerHeight = COMPOSER_RECT.bottom - COMPOSER_RECT.top;
  const chain: AncestorLevel[] = spec.noThreadScope
    ? [
        {
          index: 0,
          tag: 'div',
          role: null,
          ariaLabel: null,
          rect: { left: 100, right: 900, top: 790, bottom: 850 },
          textBearingOutsideComposer: 0,
          heightRatio: 60 / composerHeight,
          isDocumentRoot: false,
        },
      ]
    : [
        {
          index: 0,
          tag: 'div',
          role: null,
          ariaLabel: null,
          rect: { left: 100, right: 900, top: 790, bottom: 850 },
          textBearingOutsideComposer: 0,
          heightRatio: 60 / composerHeight,
          isDocumentRoot: false,
        },
        {
          index: 1,
          tag: 'div',
          role: null,
          ariaLabel: null,
          rect: THREAD_SCOPE,
          textBearingOutsideComposer: 12,
          heightRatio: (THREAD_SCOPE.bottom - THREAD_SCOPE.top) / composerHeight,
          isDocumentRoot: false,
        },
      ];

  const nodes: ObservedNode[] = spec.bubbles.map((bubble, index) => ({
    id: index,
    parentId: null,
    level: 1,
    tag: bubble.tag ?? 'div',
    role: bubble.role ?? null,
    ariaLabel: bubble.ariaLabel ?? null,
    title: null,
    text: bubble.text,
    rect: bubble.rect,
    visible: bubble.visible ?? true,
    color: null,
    fill: null,
  }));

  const handleLinks: ObservedHandleLink[] = (spec.handles ?? []).map((handle) => ({ handle, level: 1 }));

  return Object.freeze({
    ancestorChain: Object.freeze(chain),
    nodes: Object.freeze(nodes),
    handleLinks: Object.freeze(handleLinks),
    composerRect: COMPOSER_RECT,
    composerText: '',
    truncated: spec.truncated ?? false,
    readable: spec.readable ?? true,
  });
}

// ---------------------------------------------------------------------------
// Le rail simulé
// ---------------------------------------------------------------------------

export interface FakeSweepSpec {
  readonly accountHandle: string;
  readonly threads: readonly ObservedInboundThread[];
  readonly sessionState?: InstagramInboundSweep['sessionState'];
  readonly readability?: InstagramInboundSweep['readability'];
  readonly stopReason?: string | null;
  readonly blockedWriteRequests?: number;
  readonly threadListReadable?: boolean;
  readonly threadListSize?: number;
}

/**
 * Un rail entrant simulé.
 *
 * Il implémente EXACTEMENT le contrat, et rien de plus : pas de
 * `sendFirstTouchDm`, pas de `markThreadAsRead`. Un test vérifie que
 * `forbiddenMethodsOn` le trouve vide — sinon le collecteur refuserait de
 * tourner, ce qui est précisément la garde qu'on veut exercer.
 */
export class FakeInstagramInboundRail implements InstagramInboundRail {
  readonly calls: InstagramInboundSweepInput[] = [];
  private readonly sweeps: FakeSweepSpec[];
  closed = false;

  constructor(sweeps: readonly FakeSweepSpec[]) {
    this.sweeps = [...sweeps];
  }

  async ensureSession(): Promise<{ state: InstagramInboundSweep['sessionState']; detail: string }> {
    return { state: 'SESSION_READY', detail: 'session simulée' };
  }

  async observeInbox(input: InstagramInboundSweepInput): Promise<InstagramInboundSweep> {
    this.calls.push(input);
    // Le dernier relevé est REJOUÉ quand on en redemande : c'est le cas réel
    // d'une boîte qui n'a pas bougé entre deux tours, donc celui qui doit
    // prouver la déduplication.
    const spec = this.sweeps.length > 1 ? (this.sweeps.shift() as FakeSweepSpec) : (this.sweeps[0] as FakeSweepSpec);
    return Object.freeze({
      accountHandle: spec.accountHandle,
      sessionState: spec.sessionState ?? 'SESSION_READY',
      readability: spec.readability ?? 'INBOX_READABLE',
      stopReason: spec.stopReason ?? null,
      threads: spec.threads,
      rowsSeen: spec.threads.length,
      threadListReadable: spec.threadListReadable ?? true,
      threadListSize: spec.threadListSize ?? spec.threads.length,
      blockedWriteRequests: spec.blockedWriteRequests ?? 0,
      screenshotPath: null,
      durationMs: 42,
    });
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export interface ThreadSpec {
  readonly rowIndex?: number;
  readonly threadId: string | null;
  readonly counterpartyHandle: string | null;
  readonly handles?: readonly string[];
  readonly outcome?: ObservedInboundThread['outcome'];
  readonly messages: ObservedInboundThread['messages'];
  readonly ageMs?: number | null;
  readonly rowText?: string;
  readonly truncated?: boolean;
  readonly threadIdSource?: ObservedInboundThread['threadIdSource'];
  readonly rowCounterpartyHandle?: string | null;
  readonly messageSource?: ObservedInboundThread['messageSource'];
  readonly threadIdentity?: ObservedInboundThread['threadIdentity'];
}

/**
 * Une bulle telle que le chemin DOM la rend : ni identifiant, ni expéditeur, ni
 * horodatage — Instagram n'en expose aucun dans le DOM d'une conversation.
 */
export function domMessage(
  text: string,
  direction: MessageDirection,
  occurrenceIndex = 0,
): ObservedThreadMessage {
  return Object.freeze({
    source: 'DOM_BUBBLE' as const,
    nodeId: occurrenceIndex,
    direction,
    directionBasis: direction === 'UNKNOWN' ? ('none' as const) : ('geometry' as const),
    text,
    textSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    occurrenceIndex,
    rect: { left: 0, right: 100, top: occurrenceIndex * 50, bottom: occurrenceIndex * 50 + 40 },
    ariaLabel: null,
    providerMessageId: null,
    senderHandle: null,
    timestampMs: null,
    contentKind: 'TEXT' as const,
  });
}

export interface NetworkMessageSpec {
  readonly text: string;
  readonly direction: MessageDirection;
  /** L'identifiant natif. Synthétique — aucun identifiant réel n'apparaît ici. */
  readonly providerMessageId: string;
  readonly senderHandle: string;
  readonly sentAt: string | Date;
  readonly occurrenceIndex?: number;
  readonly contentKind?: ObservedThreadMessage['contentKind'];
}

/**
 * Un message tel que la réponse `IGDThreadDetailQuery` le rend : identifié,
 * daté, et signé par son expéditeur.
 */
export function networkMessage(spec: NetworkMessageSpec): ObservedThreadMessage {
  const text = spec.contentKind === 'NON_TEXT' ? '' : spec.text;
  return Object.freeze({
    source: 'THREAD_DETAIL_NETWORK' as const,
    nodeId: null,
    direction: spec.direction,
    directionBasis: 'sender_identity' as const,
    text,
    textSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    occurrenceIndex: spec.occurrenceIndex ?? 0,
    rect: null,
    ariaLabel: null,
    providerMessageId: spec.providerMessageId,
    senderHandle: spec.senderHandle,
    timestampMs: (spec.sentAt instanceof Date ? spec.sentAt : new Date(spec.sentAt)).getTime(),
    contentKind: spec.contentKind ?? ('TEXT' as const),
  });
}

export function makeThread(spec: ThreadSpec): ObservedInboundThread {
  return Object.freeze({
    rowIndex: spec.rowIndex ?? 0,
    threadId: spec.threadId,
    // Un fil simulé porte un identifiant : dire d'où il vient est le défaut
    // honnête. `null` reste possible pour exercer la ligne non résolue.
    threadIdSource: spec.threadIdSource ?? (spec.threadId === null ? null : 'NETWORK'),
    rowCounterpartyHandle: spec.rowCounterpartyHandle ?? spec.counterpartyHandle,
    rowText: spec.rowText ?? 'Contrepartie · aperçu · 2 h',
    ageMs: spec.ageMs === undefined ? 7_200_000 : spec.ageMs,
    counterpartyHandle: spec.counterpartyHandle,
    handles: Object.freeze(spec.handles ?? (spec.counterpartyHandle === null ? [] : [spec.counterpartyHandle])),
    outcome: spec.outcome ?? 'READ',
    messages: spec.messages,
    // La provenance suit celle des messages : un fil simulé ne prétend pas à
    // une source que ses messages n'ont pas.
    messageSource: spec.messageSource ?? (spec.messages[0]?.source ?? null),
    threadIdentity: spec.threadIdentity ?? (spec.messages[0]?.source === 'THREAD_DETAIL_NETWORK' ? 'MATCH' : null),
    truncated: spec.truncated ?? false,
    detail: 'fil simulé',
  });
}
