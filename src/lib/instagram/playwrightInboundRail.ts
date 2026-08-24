import type { BrowserContext, Locator, Page, Response } from 'playwright';
import { COMPOSER_SELECTORS } from '@/lib/instagram/domSelectors';
import { extractThreadMessages } from '@/lib/instagram/inboundThread';
import type {
  InstagramInboundRail,
  InstagramInboundSweep,
  InstagramInboundSweepInput,
  ObservedInboundThread,
} from '@/lib/instagram/inboundRail';
import {
  INBOX_READ_LIMITS,
  SCAN_INBOX_IN_PAGE,
  UNREADABLE_INBOX_READ,
  readRowAgeMs,
  type InboxReadability,
  type RawInboxRead,
} from '@/lib/instagram/inboxScan';
import {
  MAX_INBOX_RESPONSE_BYTES,
  extractInboxThreads,
  isInboxThreadListResponse,
  mergeNetworkInboxReads,
  resolveThreadIds,
  UNREADABLE_NETWORK_INBOX,
  type NetworkInboxRead,
  type ThreadIdSource,
  type ThreadResolution,
} from '@/lib/instagram/inboxNetwork';
import {
  MAX_THREAD_DETAIL_BYTES,
  classifyAuthor,
  extractThreadDetail,
  isThreadDetailResponse,
  mergeThreadDetailReads,
  soleCounterpartyOf,
  UNREADABLE_THREAD_DETAIL,
  type ThreadDetailRead,
} from '@/lib/instagram/threadDetailNetwork';
import { sha256Hex, type ObservedThreadMessage } from '@/lib/instagram/inboundThread';
import { normalizeMessageText } from '@/lib/instagram/deliveryProof';
import { normalizeHandle } from '@/lib/instagram/identity';
import { PlaywrightInstagramRail } from '@/lib/instagram/playwrightRail';
import { InstagramRailError } from '@/lib/instagram/rail';
import {
  classifyAdjudicationRequest,
  isAllowedAdjudicationNavigation,
  readFriendlyName,
  type GuardDecision,
} from '@/lib/instagram/readOnlyGuard';
import { harvestThread } from '@/lib/instagram/threadHarvest';
import { isUsableSessionState } from '@/lib/instagram/types';

/**
 * IG5.1 §5 — le rail entrant : ouvrir la boîte, lire des fils, et rien d'autre.
 *
 * ---------------------------------------------------------------------------
 * Ce qu'il ne contient pas, vérifiable par `grep`
 * ---------------------------------------------------------------------------
 *
 * Aucun `fill`, aucun `type`, aucun `press`, aucun `pressSequentially`, aucun
 * `click`, aucune mention de `SEND_CONTROL_SELECTORS`, aucun import de
 * `playwrightLiveRail`. Il n'implémente pas `InstagramLiveRail` : il n'a pas de
 * `sendFirstTouchDm`, et un test le prouve à la fois par l'objet
 * (`forbiddenMethodsOn`) et par le source.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi il RÉUTILISE la garde d'adjudication au lieu d'en écrire une
 * ---------------------------------------------------------------------------
 *
 * `classifyAdjudicationRequest` (IG2.1) répond déjà exactement à la question
 * posée ici : « comment lire un fil déjà écrit sans pouvoir y écrire ? ». Elle
 * autorise les chemins de messagerie en `GET`/`HEAD`, refuse tout `POST` vers
 * eux, et refuse TOUTE mutation GraphQL — donc `IGDirectTextSendMutation`
 * comme `useIGDMarkThreadAsReadMutation` et sa validation, qui restent `DENY`
 * exactement comme la mission l'exige.
 *
 * Écrire une seconde garde « pour l'entrant » aurait produit deux listes
 * parallèles à tenir d'accord. Elles auraient dérivé, et le jour où l'une
 * s'assouplit, personne ne relit l'autre. Une garde partagée est une garde
 * qu'on corrige une fois.
 *
 * ---------------------------------------------------------------------------
 * Aucun clic, et la cible n'est jamais devinée
 * ---------------------------------------------------------------------------
 *
 * Un fil n'est pas ouvert en cliquant sa ligne — il est ATTEINT par une
 * navigation directe vers son identifiant, après que la ligne s'est nommée
 * elle-même. Une ligne sans identifiant n'est pas ouverte : on ne fabrique pas
 * d'URL, et l'observation le dit (`NOT_OPENED`) plutôt que de l'omettre.
 *
 * ---------------------------------------------------------------------------
 * IG5 R2 — pourquoi ce rail ÉCOUTE désormais une réponse réseau
 * ---------------------------------------------------------------------------
 *
 * Parce que « la ligne se nomme elle-même » a cessé d'être vrai. Le premier
 * relevé LIVE a mesuré neuf lignes comprises et zéro `a[href^="/direct/t/"]` :
 * l'interface actuelle ne met plus la destination du fil dans le DOM, elle la
 * garde côté JavaScript et ne la matérialise qu'au clic. Or ce rail ne clique
 * pas, et ne peut pas commencer — ouvrir une conversation par un clic est un
 * effet chez Instagram, pas une lecture.
 *
 * Ce qui a été ajouté n'est donc pas un nouvel appel : c'est une OREILLE. Le
 * simple affichage de `/direct/inbox/` fait émettre à la page, d'elle-même, une
 * opération `PolarisDirectInboxQuery` dont la réponse nomme les fils. Le rail
 * lit cette réponse-là, déjà revenue, en mémoire, et n'en garde que
 * l'identifiant et la contrepartie (voir `inboxNetwork.ts`).
 *
 * Ce que cela ne change PAS, et qui vaut d'être dit :
 *
 *   * aucune requête supplémentaire ne sort du processus ;
 *   * la garde reste `classifyAdjudicationRequest`, à l'octet près — la réponse
 *     écoutée était déjà autorisée sous `read_only_endpoint`, et les mutations
 *     voisines (`IGDirectTextSendMutation`, `useIGDMarkThreadAsReadMutation` et
 *     sa validation) restent refusées par la même fonction ;
 *   * aucun corps brut n'est journalisé, rendu ni persisté.
 */

const COMPOSER_TIMEOUT_MS = 12_000;
const POLL_MS = 500;
const INBOX_SETTLE_MS = 5_000;
const THREAD_SETTLE_MS = 4_000;

const INBOX_URL = 'https://www.instagram.com/direct/inbox/';

export class PlaywrightInstagramInboundRail extends PlaywrightInstagramRail implements InstagramInboundRail {
  private blockedWrites = 0;

  protected override requestClassifier(): (request: {
    url: string;
    method: string;
    postData: string | null;
  }) => GuardDecision {
    return (request) => {
      const decision = classifyAdjudicationRequest(request);
      if (!decision.allowed) this.blockedWrites += 1;
      return decision;
    };
  }

  protected override isNavigable(url: string): boolean {
    return isAllowedAdjudicationNavigation(url);
  }

  /** Le premier sélecteur qui rend un élément visible. `null` si aucun. */
  private async firstVisible(page: Page, selectors: readonly string[], timeoutMs: number): Promise<Locator | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (const selector of selectors) {
        const locator = page.locator(selector).first();
        const visible = await locator.isVisible().catch(() => false);
        if (visible) return locator;
      }
      if (Date.now() >= deadline) return null;
      await page.waitForTimeout(POLL_MS);
    }
  }

  /**
   * Lit les lignes de la boîte.
   *
   * Le même corps évalué que l'adjudication (`SCAN_INBOX_IN_PAGE`) : deux
   * scanners auraient fini par voir deux boîtes différentes. Une lecture qui
   * échoue rend `UNREADABLE_INBOX_READ`, jamais une liste vide — c'est la
   * confusion qui a produit le faux « aucune conversation » du 14 août.
   */
  private async readInbox(page: Page): Promise<RawInboxRead> {
    return page.evaluate(SCAN_INBOX_IN_PAGE, INBOX_READ_LIMITS).catch((error: unknown) => {
      this.log.warn('instagram.inbound.inbox_unreadable', {
        detail: error instanceof Error ? error.message : String(error),
      });
      return UNREADABLE_INBOX_READ;
    });
  }

  /**
   * Écoute, le temps d'un chargement, les réponses qui nomment les fils.
   *
   * L'écoute est INSTALLÉE AVANT la navigation et retirée juste après : un
   * écouteur qui survivrait au tour continuerait de lire des corps de réponse
   * dont personne n'a besoin. Les corps sont lus en mémoire, transformés en
   * quelques champs, puis abandonnés — rien n'est journalisé, rien n'est écrit.
   *
   * Une réponse qu'on ne sait pas lire ne devient jamais une boîte vide :
   * `mergeNetworkInboxReads` rend `readable: false`, et l'appelant en tire
   * « je n'ai pas su », pas « il n'y a rien ».
   */
  private async captureThreadList(context: BrowserContext, load: () => Promise<void>): Promise<NetworkInboxRead> {
    const reads: NetworkInboxRead[] = [];
    const pending: Promise<void>[] = [];

    const onResponse = (response: Response): void => {
      let path: string;
      try {
        path = new URL(response.url()).pathname;
      } catch {
        return;
      }
      const friendlyName = readFriendlyName(response.request().postData());
      if (!isInboxThreadListResponse({ path, friendlyName, status: response.status() })) return;
      pending.push(
        (async () => {
          try {
            const body = await response.text();
            if (body.length > MAX_INBOX_RESPONSE_BYTES) return;
            reads.push(extractInboxThreads(body));
          } catch (error) {
            // Le corps a pu être consommé ou la page fermée. C'est une lecture
            // manquée, pas une boîte vide — elle compte comme illisible.
            reads.push({
              readable: false,
              threads: [],
              detail: error instanceof Error ? error.message : String(error),
            });
          }
        })(),
      );
    };

    context.on('response', onResponse);
    try {
      await load();
    } finally {
      context.off('response', onResponse);
    }
    await Promise.allSettled(pending);

    const merged = reads.length === 0 ? UNREADABLE_NETWORK_INBOX : mergeNetworkInboxReads(reads);
    this.log.info('instagram.inbound.thread_list', {
      responses: reads.length,
      readable: merged.readable,
      threads: merged.threads.length,
    });
    return merged;
  }

  async observeInbox(input: InstagramInboundSweepInput): Promise<InstagramInboundSweep> {
    const started = Date.now();
    const account = normalizeHandle(input.accountHandle);
    if (account === null) {
      throw new InstagramRailError('IG_RAIL_ERROR', `handle de compte invalide : « ${input.accountHandle} »`);
    }
    const maxThreads = Math.max(0, Math.trunc(input.maxThreads));

    const { context, page } = await this.open();
    const network = await this.captureThreadList(context, async () => {
      await this.navigate(page, INBOX_URL);
      await page.waitForTimeout(INBOX_SETTLE_MS);
    });

    const inboxState = await this.classifyCurrentPage(context, page);
    if (!isUsableSessionState(inboxState.state)) {
      return this.stopped(
        account,
        inboxState.state,
        'INBOX_UNREADABLE',
        `la boîte de réception rend un état ${inboxState.state} — ${inboxState.detail}`,
        await this.capture(page, `${account}-inbound-inbox`),
        started,
        network,
      );
    }

    const read = await this.readInbox(page);
    const screenshotPath = await this.capture(page, `${account}-inbound-inbox`);

    // La lisibilité porte sur des LIGNES COMPRISES, pas sur des vignettes ni un
    // nombre de caractères : les deux restent vrais quand on n'a rien su lire
    // de la liste. Aucune absence n'est déduite d'une lecture ratée.
    const readability: InboxReadability = read.listFound ? 'INBOX_READABLE' : 'INBOX_UNREADABLE';
    if (readability === 'INBOX_UNREADABLE') {
      return this.stopped(
        account,
        inboxState.state,
        readability,
        `aucune ligne de conversation comprise (${read.avatarCount} vignette(s), ` +
          `${read.visibleTextLength} caractère(s)) — aucune absence ne peut en être déduite`,
        screenshotPath,
        started,
        network,
      );
    }

    // IG5 R2 — l'identifiant de chaque ligne : le sien s'il en a un, sinon celui
    // que la liste de fils lui reconnaît, sinon aucun. Le rattachement est pur
    // et se prouve sans navigateur (`resolveThreadIds`).
    const resolutions = new Map<number, ThreadResolution>();
    for (const resolution of resolveThreadIds({ rows: read.rows, network, viewerHandle: account })) {
      resolutions.set(resolution.rowIndex, resolution);
    }

    const threads: ObservedInboundThread[] = [];
    let opened = 0;
    for (const row of read.rows) {
      const resolution = resolutions.get(row.index) ?? null;
      const threadId = resolution?.threadId ?? null;
      const source: ThreadIdSource | null = resolution?.source ?? null;
      const base = {
        rowIndex: row.index,
        threadId,
        threadIdSource: source,
        rowCounterpartyHandle: resolution?.counterpartyHandle ?? null,
        rowText: row.text.slice(0, 400),
        ageMs: readRowAgeMs(row),
      };

      if (threadId === null) {
        threads.push(
          Object.freeze({
            ...base,
            counterpartyHandle: null,
            handles: Object.freeze([]),
            outcome: 'NOT_OPENED' as const,
            messages: Object.freeze([]),
            messageSource: null,
            threadIdentity: null,
            truncated: false,
            detail:
              `aucun identifiant de fil retenu pour cette ligne — aucune URL n’est fabriquée` +
              (resolution === null ? '' : ` (${resolution.outcome} : ${resolution.detail})`),
          }),
        );
        continue;
      }

      if (opened >= maxThreads) {
        threads.push(
          Object.freeze({
            ...base,
            counterpartyHandle: null,
            handles: Object.freeze([]),
            outcome: 'SKIPPED_LIMIT' as const,
            messages: Object.freeze([]),
            messageSource: null,
            threadIdentity: null,
            truncated: false,
            detail: `borne de ${maxThreads} fil(s) par tour atteinte — ce fil sera relu au tour suivant`,
          }),
        );
        continue;
      }

      opened += 1;
      threads.push(await this.observeThread(page, context, account, base));
    }

    return Object.freeze({
      accountHandle: account,
      sessionState: inboxState.state,
      readability,
      stopReason: null,
      threads: Object.freeze(threads),
      rowsSeen: read.rows.length,
      threadListReadable: network.readable,
      threadListSize: network.threads.length,
      blockedWriteRequests: this.blockedWrites,
      screenshotPath,
      durationMs: Date.now() - started,
    });
  }

  /**
   * Écoute, le temps d'un chargement de fil, les réponses qui portent SES
   * messages.
   *
   * Même geste qu'en R2 pour la liste d'inbox, et pour les mêmes raisons :
   * l'écoute est installée AVANT la navigation, retirée juste après, les corps
   * sont lus en mémoire puis abandonnés, et rien n'est journalisé ni persisté.
   * Aucune requête n'est ajoutée — `IGDThreadDetailQuery` est émise par la page
   * pour se construire elle-même, et elle passe la garde d'adjudication
   * inchangée, sous la règle générale `read_only_endpoint`.
   *
   * L'identifiant attendu est passé au parseur plutôt que vérifié après coup :
   * ouvrir un fil fait revenir les détails de TOUTE la liste (seize réponses
   * mesurées, deux nommant le fil ouvert), et une réponse qui parle d'une autre
   * conversation ne doit jamais avoir l'occasion de devenir des messages.
   */
  private async captureThreadDetail(
    context: BrowserContext,
    expectedThreadKey: string,
    load: () => Promise<void>,
  ): Promise<ThreadDetailRead> {
    const reads: ThreadDetailRead[] = [];
    const pending: Promise<void>[] = [];

    const onResponse = (response: Response): void => {
      let path: string;
      try {
        path = new URL(response.url()).pathname;
      } catch {
        return;
      }
      const friendlyName = readFriendlyName(response.request().postData());
      if (!isThreadDetailResponse({ path, friendlyName, status: response.status() })) return;
      pending.push(
        (async () => {
          try {
            const body = await response.text();
            if (body.length > MAX_THREAD_DETAIL_BYTES) return;
            reads.push(extractThreadDetail({ body, expectedThreadKey }));
          } catch (error) {
            // Corps consommé, ou page fermée. C'est une lecture MANQUÉE, pas un
            // fil vide — elle compte comme illisible et rien n'en est déduit.
            reads.push({
              ...UNREADABLE_THREAD_DETAIL,
              detail: error instanceof Error ? error.message : String(error),
            });
          }
        })(),
      );
    };

    context.on('response', onResponse);
    try {
      await load();
    } finally {
      context.off('response', onResponse);
    }
    await Promise.allSettled(pending);

    const merged = reads.length === 0 ? UNREADABLE_THREAD_DETAIL : mergeThreadDetailReads(reads);
    this.log.info('instagram.inbound.thread_detail', {
      responses: reads.length,
      readable: merged.readable,
      identity: merged.identity,
      messages: merged.messages.length,
      rejected: merged.rejected,
    });
    return merged;
  }

  /**
   * Range une lecture réseau en messages observés.
   *
   * La direction vient de l'IDENTITÉ de l'expéditeur, jamais d'un ordre ni
   * d'une position : la réponse nomme qui a écrit chaque message. Un expéditeur
   * qui n'est ni nous ni la contrepartie attendue sort en `UNKNOWN` — un fil de
   * groupe, un compte renommé ou une contrepartie non établie y tombent, et
   * aucun des trois ne doit voir ses mots attribués à un prospect.
   */
  private toObservedMessages(
    read: ThreadDetailRead,
    account: string,
    counterparty: string | null,
  ): ObservedThreadMessage[] {
    const occurrences = new Map<string, number>();
    const messages: ObservedThreadMessage[] = [];

    for (const message of read.messages) {
      const author = classifyAuthor({
        senderUsername: message.senderUsername,
        accountHandle: account,
        counterpartyHandle: counterparty,
      });
      const direction = author === 'SELF' ? 'OUTGOING' : author === 'COUNTERPARTY' ? 'INCOMING' : 'UNKNOWN';

      // `normalizeMessageText` — la MÊME normalisation que le chemin DOM et que
      // `deliveryProof`. C'est elle qui permet au texte approuvé d'un manifeste
      // d'être reconnu dans une bulle sortante, donc au fil d'être lié.
      const text = message.text === null ? '' : normalizeMessageText(message.text);

      // Le rang d'occurrence n'entre PLUS dans l'identité — l'identifiant natif
      // s'en charge — mais il reste consigné : le journal d'observation le
      // porte, et il dit quelque chose de vrai sur le fil.
      const key = `${direction} ${text}`;
      const occurrenceIndex = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrenceIndex + 1);

      messages.push(
        Object.freeze({
          source: 'THREAD_DETAIL_NETWORK' as const,
          nodeId: null,
          direction,
          // `sender_identity` dans les trois cas, y compris `UNKNOWN` : la
          // direction A ÉTÉ établie sur une identité lue — c'est cette identité
          // qui dit qu'elle n'est ni la nôtre ni celle attendue. Écrire `none`
          // ici prétendrait qu'on n'avait aucun indice, alors qu'on en avait un
          // et qu'il était décisif.
          directionBasis: 'sender_identity' as const,
          text,
          textSha256: sha256Hex(text),
          occurrenceIndex,
          rect: null,
          ariaLabel: null,
          providerMessageId: message.providerMessageId,
          senderHandle: message.senderUsername,
          timestampMs: message.timestampMs,
          contentKind: message.contentKind,
        }),
      );
    }
    return messages;
  }

  /**
   * Ouvre UN fil et lit ce qu'il contient.
   *
   * Navigation directe en `GET` vers l'identifiant lu sur la ligne. Aucune
   * saisie, aucun clic, aucun accusé de lecture.
   *
   * ---------------------------------------------------------------------------
   * IG5 R3 — pourquoi la réponse réseau passe AVANT le DOM
   * ---------------------------------------------------------------------------
   *
   * R2 a ouvert huit fils et n'y a vu zéro bulle. La cause a été mesurée :
   * `chooseThreadScope` retient la rangée de commandes du composeur là où la
   * conversation vit onze niveaux plus haut. Cette fonction est partagée avec
   * l'adjudication de remise (IG2) et le canari — la corriger est une mission à
   * part entière, avec sa propre non-régression, et elle n'est PAS touchée ici.
   *
   * La réponse de détail, elle, porte la conversation entière, et elle porte
   * mieux que des bulles : l'identifiant natif de chaque message, son
   * horodatage réel, et le nom de son expéditeur. Trois choses que le DOM
   * n'expose pas, et dont dépendent l'idempotence (§5), la relation à notre
   * envoi (§7) et la direction (§4).
   *
   * Le chemin DOM n'est pas retiré pour autant : il reste le REPLI, exercé
   * quand aucune réponse ne nomme le fil demandé. C'est la même discipline que
   * la branche `dom_link` de `resolveThreadIds` — la source la plus faible
   * survit, au cas où la plus forte disparaisse.
   *
   * Les deux ne sont jamais mêlées dans un même fil : leurs identités de
   * message sont calculées par deux recettes différentes, et alterner
   * produirait deux lignes pour un seul message.
   */
  private async observeThread(
    page: Page,
    context: BrowserContext,
    account: string,
    base: {
      rowIndex: number;
      threadId: string | null;
      threadIdSource: ThreadIdSource | null;
      rowCounterpartyHandle: string | null;
      rowText: string;
      ageMs: number | null;
    },
  ): Promise<ObservedInboundThread> {
    const threadId = base.threadId;
    if (threadId === null) throw new Error('état incohérent : fil sans identifiant');

    const unreadable = (detail: string, detailRead: ThreadDetailRead | null): ObservedInboundThread =>
      Object.freeze({
        ...base,
        counterpartyHandle: null,
        handles: Object.freeze([]),
        outcome: 'UNREADABLE' as const,
        messages: Object.freeze([]),
        messageSource: null,
        threadIdentity: detailRead?.identity ?? null,
        truncated: false,
        detail,
      });

    let detailRead: ThreadDetailRead = UNREADABLE_THREAD_DETAIL;
    try {
      detailRead = await this.captureThreadDetail(context, threadId, async () => {
        await this.navigate(page, `https://www.instagram.com/direct/t/${threadId}/`);
        await page.waitForTimeout(THREAD_SETTLE_MS);
      });
    } catch (error) {
      return unreadable(
        `navigation refusée ou échouée : ${error instanceof Error ? error.message : String(error)}`,
        null,
      );
    }

    const state = await this.classifyCurrentPage(context, page);
    if (!isUsableSessionState(state.state)) {
      return unreadable(`le fil rend un état ${state.state} — ${state.detail}`, detailRead);
    }

    // ---- 1. La réponse réseau, quand elle nomme CE fil ---------------------
    if (detailRead.identity === 'MATCH' && detailRead.readable) {
      // La contrepartie vient de la réponse elle-même : un fil 1:1 prouvé
      // (`is_group === false` — `null` ne vaut pas « non ») qui nomme
      // exactement un participant hors de nous. À défaut, celle que la ligne
      // d'inbox désignait — jamais un nom d'affichage.
      const counterparty = soleCounterpartyOf(detailRead, account) ?? base.rowCounterpartyHandle;
      const messages = this.toObservedMessages(detailRead, account, counterparty);
      const handles = counterparty === null ? [] : [counterparty];

      const incoming = messages.filter((message) => message.direction === 'INCOMING').length;
      const outgoing = messages.filter((message) => message.direction === 'OUTGOING').length;
      const unknown = messages.length - incoming - outgoing;

      return Object.freeze({
        ...base,
        counterpartyHandle: counterparty,
        handles: Object.freeze(handles),
        outcome: 'READ' as const,
        messages: Object.freeze(messages),
        messageSource: 'THREAD_DETAIL_NETWORK' as const,
        threadIdentity: 'MATCH' as const,
        // Une lecture réseau n'est pas tronquée par une borne de récolte DOM ;
        // elle l'est si des nœuds ont été écartés, ce que `rejected` compte.
        truncated: detailRead.rejected > 0,
        detail:
          `${detailRead.detail} — ${incoming} entrant(s), ${outgoing} sortant(s), ${unknown} non attribuable(s) ; ` +
          (counterparty === null
            ? 'contrepartie non identifiée'
            : `contrepartie @${counterparty}`),
      });
    }

    // ---- 2. Le repli DOM, inchangé ----------------------------------------
    //
    // Le composeur sert d'ANCRE, jamais de champ de saisie : la récolte remonte
    // de lui vers le panneau de conversation. Il n'est ni cliqué, ni rempli, ni
    // focalisé — `harvestThread` ne fait que mesurer autour de lui.
    const composer = await this.firstVisible(page, COMPOSER_SELECTORS, COMPOSER_TIMEOUT_MS);
    if (composer === null) {
      return unreadable(
        `aucune ancre de conversation visible dans le fil, et ${detailRead.detail} — ` +
          'impossible de situer les messages',
        detailRead,
      );
    }

    const harvest = await harvestThread(composer);
    const extracted = extractThreadMessages(harvest, { accountHandle: account });
    if (!extracted.readable) return unreadable(`${extracted.detail} ; ${detailRead.detail}`, detailRead);

    // Un fil 1:1 nomme exactement une contrepartie. Zéro (le fil ne nomme
    // personne) et plusieurs (fil de groupe, ou rendu ambigu) sont deux refus
    // distincts, et aucun des deux ne se devine.
    const counterparty = extracted.handles.length === 1 ? (extracted.handles[0] ?? null) : null;

    return Object.freeze({
      ...base,
      counterpartyHandle: counterparty,
      handles: extracted.handles,
      outcome: 'READ' as const,
      messages: extracted.messages,
      messageSource: 'DOM_BUBBLE' as const,
      threadIdentity: detailRead.identity,
      truncated: extracted.truncated,
      detail:
        `${extracted.detail} ; ` +
        (counterparty === null
          ? `contrepartie non identifiée (${extracted.handles.length} handle(s) dans le périmètre)`
          : `contrepartie @${counterparty}`),
    });
  }

  private stopped(
    accountHandle: string,
    sessionState: InstagramInboundSweep['sessionState'],
    readability: InboxReadability,
    stopReason: string,
    screenshotPath: string | null,
    started: number,
    network: NetworkInboxRead,
  ): InstagramInboundSweep {
    return Object.freeze({
      accountHandle,
      sessionState,
      readability,
      stopReason,
      threads: Object.freeze([]),
      rowsSeen: 0,
      threadListReadable: network.readable,
      threadListSize: network.threads.length,
      blockedWriteRequests: this.blockedWrites,
      screenshotPath,
      durationMs: Date.now() - started,
    });
  }
}
