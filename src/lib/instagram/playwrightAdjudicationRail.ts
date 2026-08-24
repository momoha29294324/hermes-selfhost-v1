import type { Locator, Page } from 'playwright';
import { normalizeHandle, profileUrl } from '@/lib/instagram/identity';
import { displayNameForHandle } from '@/lib/instagram/threadIdentity';
import { PlaywrightInstagramRail } from '@/lib/instagram/playwrightRail';
import { COMPOSER_SELECTORS } from '@/lib/instagram/domSelectors';
import {
  classifyAdjudicationRequest,
  isAllowedAdjudicationNavigation,
  type GuardDecision,
} from '@/lib/instagram/readOnlyGuard';
import { InstagramRailError } from '@/lib/instagram/rail';
import { harvestThread } from '@/lib/instagram/threadHarvest';
import {
  classifyInbox,
  INBOX_READ_LIMITS,
  SCAN_INBOX_IN_PAGE,
  UNREADABLE_INBOX_READ,
  type InboxWitness,
} from '@/lib/instagram/inboxScan';
import type { ThreadObservation } from '@/lib/instagram/threadObservation';
import { isUsableSessionState, type InstagramSessionState } from '@/lib/instagram/types';

/**
 * IG2.1 §2 — le rail d'ADJUDICATION : relire une conversation, sans rien y
 * écrire et sans rien y ajouter.
 *
 * Ce qu'il ne contient pas, et qui n'est pas une promesse mais une absence
 * vérifiable par `grep` : aucun `fill`, aucun `type`, aucun `press`, aucun
 * `pressSequentially`, aucune mention de `SEND_CONTROL_SELECTORS`, et — depuis
 * le premier essai — aucun `click` du tout. Il n'implémente pas
 * `InstagramLiveRail` : il n'a pas de `sendFirstTouchDm`, et `hasSendPrimitive`
 * le dit `false`.
 *
 * Pourquoi la boîte de réception, et pas le panneau du profil
 * ------------------------------------------------------------
 * Le canari avait ouvert sa conversation depuis la page de profil, via
 * « Contacter ». Le premier essai d'adjudication a repris ce chemin, et la
 * garde a refusé la requête qui l'ouvre : un `POST …/create_group_thread/`.
 * Le refus était juste — c'est une écriture sur un chemin de messagerie — et il
 * a rendu visible quelque chose de plus important : ce panneau est un état
 * CLIENT. C'est lui qui affichait la bulle marquée en échec ; le rouvrir aurait
 * consisté à demander son avis au témoin dont on doute.
 *
 * La boîte de réception rend ce que les SERVEURS d'Instagram ont enregistré, et
 * elle le rend en GET. C'est le seul témoin qui puisse répondre à la question
 * posée : le message est-il parti ?
 *
 * Aucun clic, et la cible n'est jamais devinée
 * ---------------------------------------------
 * La conversation n'est pas ouverte en cliquant une ligne de la liste — elle est
 * ATTEINTE par une navigation directe vers son identifiant, après que la ligne
 * s'est nommée elle-même. Et une seule ligne doit correspondre : deux
 * candidates, ou zéro, arrêtent l'observation. Ouvrir « la plus probable » des
 * conversations de quelqu'un serait exactement le genre de geste que ce dépôt
 * refuse ailleurs.
 */

const COMPOSER_TIMEOUT_MS = 15_000;
const POLL_MS = 500;
/** Le fil se charge après la navigation. Attendre est une lecture, pas un rejeu. */
const THREAD_SETTLE_MS = 4_000;
const INBOX_SETTLE_MS = 5_000;

const INBOX_URL = 'https://www.instagram.com/direct/inbox/';

export class PlaywrightInstagramAdjudicationRail extends PlaywrightInstagramRail {
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
   * Lit les conversations de la boîte, et ce qu'elles disent d'elles-mêmes.
   *
   * Ce qui est lu : l'identifiant du fil (le seul fragment d'`href` retenu, et
   * il ne porte aucun jeton), le texte visible de la ligne, et les descriptions
   * accessibles de ses images — c'est là qu'Instagram écrit le nom d'utilisateur
   * quand la ligne n'affiche qu'un nom d'usage.
   *
   * Ce qui n'est jamais lu : le contenu des autres conversations au-delà de ce
   * que la ligne affiche déjà, et aucune n'est ouverte.
   */
  private async readInbox(
    page: Page,
    handle: string,
    displayName: string | null,
    approvedPrefix: string,
  ): Promise<InboxWitness> {
    const read = await page.evaluate(SCAN_INBOX_IN_PAGE, INBOX_READ_LIMITS).catch((error: unknown) => {
      // Une lecture qui échoue ne doit jamais ressembler à une boîte vide : le
      // témoin le dira `INBOX_UNREADABLE`, et aucune absence n'en sera déduite.
      // C'est exactement la confusion qui a produit le faux « aucune
      // conversation » du 14 août.
      this.log.warn('instagram.adjudication.inbox_unreadable', {
        detail: error instanceof Error ? error.message : String(error),
      });
      return UNREADABLE_INBOX_READ;
    });
    return classifyInbox({ read, expectedHandle: handle, expectedDisplayName: displayName, approvedPrefix });
  }

  /**
   * Le nom d'affichage du handle attendu, relu sur sa page canonique.
   *
   * Sans lui, une ligne qui affiche « Moha » n'est reconnaissable qu'au
   * jugé — et reconnaître un nom sans savoir à quel compte il appartient
   * reviendrait à ouvrir la conversation d'un homonyme. Le titre porte les deux
   * valeurs dans la même chaîne, ce qui rattache le nom à son handle.
   */
  private async readDisplayName(page: Page, handle: string): Promise<string | null> {
    await this.navigate(page, profileUrl(handle));
    const ogTitle = await page
      .getAttribute('meta[property="og:title"]', 'content', { timeout: 3_000 })
      .catch(() => null);
    const fromOg = displayNameForHandle(ogTitle, handle);
    if (fromOg !== null) return fromOg;
    return displayNameForHandle(await page.title().catch(() => null), handle);
  }

  /**
   * Ouvre la conversation du handle attendu et récolte ce qu'elle montre.
   *
   * L'ordre est : boîte → reconnaissance → navigation directe → récolte. Aucune
   * saisie, aucun clic, et la récolte est la MÊME que celle du canari
   * (`harvestThread`) — sinon l'un prouverait ce que l'autre ne voit pas.
   */
  async observeConversation(handle: string, approvedText: string): Promise<ThreadObservation> {
    const started = Date.now();
    const normalized = normalizeHandle(handle);
    if (normalized === null) {
      throw new InstagramRailError('IG_RAIL_ERROR', `handle Instagram invalide : « ${handle} »`);
    }
    // L'aperçu qu'Instagram affiche d'une conversation est TRONQUÉ. On ne
    // cherche donc que le début du message approuvé, assez long pour ne
    // ressembler à rien d'autre.
    const approvedPrefix = approvedText.slice(0, 40);

    const { context, page } = await this.open();

    // Le nom d'affichage d'abord, sur la page canonique du handle : c'est ce
    // qui permettra de reconnaître une ligne qui n'affiche pas le handle.
    const displayName = await this.readDisplayName(page, normalized).catch(() => null);

    await this.navigate(page, INBOX_URL);
    await page.waitForTimeout(INBOX_SETTLE_MS);

    const inboxState = await this.classifyCurrentPage(context, page);
    if (!isUsableSessionState(inboxState.state)) {
      return this.stopped(
        page.url(),
        inboxState.state,
        await this.capture(page, `${normalized}-adjudication-inbox`),
        started,
        null,
        `la boîte de réception rend un état ${inboxState.state}`,
      );
    }

    const inbox = await this.readInbox(page, normalized, displayName, approvedPrefix);
    const inboxShot = await this.capture(page, `${normalized}-adjudication-inbox`);
    const target = inbox.row;

    if (target === null || target.threadId === null) {
      return this.stopped(
        page.url(),
        inboxState.state,
        inboxShot,
        started,
        inbox,
        `fil non ouvrable : ${inbox.detail}` +
          (target !== null && target.threadId === null
            ? ' — la ligne a été reconnue mais ne porte aucun identifiant de fil navigable'
            : ''),
      );
    }

    // Navigation directe, en GET : la ligne n'est pas cliquée, son identifiant
    // est utilisé pour construire l'URL canonique du fil.
    await this.navigate(page, `https://www.instagram.com/direct/t/${target.threadId}/`);
    await page.waitForTimeout(THREAD_SETTLE_MS);

    const threadState = await this.classifyCurrentPage(context, page);
    if (!isUsableSessionState(threadState.state)) {
      return this.stopped(
        page.url(),
        threadState.state,
        await this.capture(page, `${normalized}-adjudication-thread`),
        started,
        inbox,
        `le fil rend un état ${threadState.state}`,
      );
    }

    const composer = await this.firstVisible(page, COMPOSER_SELECTORS, COMPOSER_TIMEOUT_MS);
    if (composer === null) {
      return this.stopped(
        page.url(),
        threadState.state,
        await this.capture(page, `${normalized}-adjudication-no-composer`),
        started,
        inbox,
        'aucun champ de saisie visible dans le fil — impossible de situer la conversation',
      );
    }

    const harvest = await harvestThread(composer);
    const screenshotPath = await this.capture(page, `${normalized}-adjudication`);

    return Object.freeze({
      threadUrl: page.url(),
      inbox,
      stopReason: harvest.readable ? null : 'récolte illisible — la page n’a pas répondu',
      sessionState: threadState.state,
      handleLinks: harvest.handleLinks,
      composerRect: harvest.composerRect,
      composerText: harvest.composerText,
      ancestorChain: harvest.ancestorChain,
      nodes: harvest.nodes,
      truncated: harvest.truncated,
      screenshotPath,
      blockedWriteRequests: this.blockedWrites,
      openClicks: 0,
      durationMs: Date.now() - started,
    });
  }

  /** Une observation qui s'arrête, et qui DIT où. Jamais confondue avec « rien vu ». */
  private stopped(
    threadUrl: string,
    sessionState: InstagramSessionState,
    screenshotPath: string | null,
    started: number,
    inbox: InboxWitness | null,
    stopReason: string,
  ): ThreadObservation {
    return Object.freeze({
      threadUrl,
      inbox,
      stopReason,
      sessionState,
      handleLinks: Object.freeze([]),
      composerRect: null,
      composerText: '',
      ancestorChain: Object.freeze([]),
      nodes: Object.freeze([]),
      truncated: false,
      screenshotPath,
      blockedWriteRequests: this.blockedWrites,
      openClicks: 0,
      durationMs: Date.now() - started,
    });
  }
}
