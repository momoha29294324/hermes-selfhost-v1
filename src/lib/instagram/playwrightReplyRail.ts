import type { Locator, Page } from 'playwright';
import { SEND_CONTROL_SELECTORS } from '@/lib/instagram/domSelectors';
import { adjudicateDelivery, type DeliveryAdjudication } from '@/lib/instagram/deliveryProof';
import type { ThreadHistory } from '@/lib/instagram/replyHistory';
import {
  decideSendControl,
  type SendControlCandidate,
  type SendControlDecision,
} from '@/lib/instagram/sendControl';
import type { ReadRect } from '@/lib/instagram/threadIdentity';
import type { ObservedRect } from '@/lib/instagram/threadObservation';
import { harvestThread, type ThreadHarvest } from '@/lib/instagram/threadHarvest';
import { PlaywrightInstagramThreadInspectionRail } from '@/lib/instagram/playwrightThreadInspectionRail';
import { InstagramRailError } from '@/lib/instagram/rail';
import {
  threadUrlOf,
  type InstagramReplyAbortCode,
  type InstagramReplyInput,
  type InstagramReplyRail,
  type InstagramReplyResult,
} from '@/lib/instagram/replyRail';
import { isUsableSessionState, type InstagramSessionState } from '@/lib/instagram/types';

/**
 * HERMES-REPLY-DELIVERY-R1 §2/§3/§4/§9 — la primitive de RÉPONSE, et tout ce
 * qu'elle refuse de savoir faire.
 *
 * ---------------------------------------------------------------------------
 * Le second fichier du dépôt capable de produire un effet chez un prospect
 * ---------------------------------------------------------------------------
 * Le premier est `playwrightLiveRail.ts`. Celui-ci ne le remplace pas et ne
 * l'étend pas : les deux gestes n'engagent pas la même chose, et un objet qui
 * saurait faire les deux rendrait la séparation invérifiable.
 *
 * Ce qu'il ne partage PAS avec le canari — la colle Playwright — tient en une
 * centaine de lignes, et c'est délibéré. Ce qu'il partage est tout ce qui
 * DÉCIDE, et rien n'en est recopié :
 *
 *   * les sélecteurs (`domSelectors.ts`) — le même composeur, le même contrôle
 *     d'envoi désigné par égalité stricte ;
 *   * l'identité du fil (`threadIdentity.ts`) — la même lecture d'en-tête, la
 *     même règle de corroboration par nom d'affichage ;
 *   * la récolte (`threadHarvest.ts`) et la preuve de remise
 *     (`deliveryProof.ts`) — le même code pur, les mêmes trois verdicts ;
 *   * la garde réseau (`classifyLiveDmRequest`) et la trace de refus.
 *
 * Un test vérifie cette liste module par module : deux rails de sécurité
 * divergents sont exactement ce que la mission interdit (§13), et la seule
 * façon de ne pas diverger est de ne pas avoir deux exemplaires du code qui
 * tranche.
 *
 * ---------------------------------------------------------------------------
 * Un seul site de clic, et c'est l'envoi
 * ---------------------------------------------------------------------------
 * Le canari en a deux gestes — ouvrir le composeur depuis un profil, puis
 * envoyer — parce qu'il doit CRÉER la conversation. Ici il n'y en a qu'un : le
 * fil existe, on y navigue en GET, le composeur y est déjà. `clickOnce` n'a
 * donc qu'un `purpose`, et un test compte les `.click(` du fichier : un.
 *
 * ---------------------------------------------------------------------------
 * Trois navigations, toutes en lecture, dans cet ordre
 * ---------------------------------------------------------------------------
 *   1. NOTRE profil — pour établir sous quel compte la session est ouverte.
 *      `readRelationship` y lit « Modifier le profil », qui ne s'affiche que
 *      chez soi. C'est la seule preuve d'identité de l'ÉMETTEUR que ce dépôt
 *      possède sans lire un cookie, et lire un cookie est interdit ;
 *   2. le profil du CORRESPONDANT — pour relire le nom d'affichage qu'il
 *      déclare, seule corroboration acceptée quand l'en-tête du fil affiche
 *      « Moha » plutôt que « operator_second_account ». Aucun clic n'y est fait : ce n'est
 *      pas le chemin du canari, on ne cherche pas de bouton « Message » ;
 *   3. le FIL, par son identifiant.
 *
 * Aucune de ces trois n'est un effet. La quatrième chose que fait ce fichier en
 * est un, et elle est précédée du crochet.
 *
 * ---------------------------------------------------------------------------
 * Aucune génération, aucun rejeu, aucune technique d'évitement
 * ---------------------------------------------------------------------------
 * `body` arrive du plan et n'est ni reformulé, ni tronqué, ni complété. Il n'y
 * a ni boucle de retry, ni second essai après un timeout : une fois le clic
 * passé, la fonction ne fait plus qu'observer. Aucun délai aléatoire, aucune
 * frappe simulée pour « ressembler à un humain », aucune empreinte falsifiée.
 */

/** Bornes d'attente, courtes et nommées. Aucune n'est une boucle de retry. */
const CONTROL_TIMEOUT_MS = 10_000;
/** Fenêtre d'observation APRÈS le clic. Observer n'est pas réessayer. */
const OBSERVATION_TIMEOUT_MS = 20_000;
const OBSERVATION_POLL_MS = 500;
/**
 * Combien de prétendants au plus par sélecteur. Une page qui en porterait cent
 * est une page qu'on ne comprend pas, et la mesurer entièrement ne la rendrait
 * pas plus claire — `decideSendControl` refuserait de toute façon.
 */
const MAX_CANDIDATES_PER_SELECTOR = 10;
/**
 * Le temps laissé au composeur pour qu'un brouillon restauré se manifeste, en
 * mode BROUILLON. Une pause d'observation, jamais une attente d'effet.
 */
const DRAFT_SETTLE_MS = 1_500;

/** Ce que la page mesure d'un prétendant. Aucune interprétation ici. */
interface RawControlMeasure {
  readonly rect: ReadRect | null;
  readonly tag: string;
  readonly role: string | null;
  readonly ariaLabel: string | null;
  readonly text: string;
  readonly ariaDisabled: string | null;
  readonly tabIndex: string | null;
}

/** Une mesure impossible. Elle ne peut satisfaire aucun critère de `decideSendControl`. */
const UNREADABLE_CONTROL_MEASURE: RawControlMeasure = Object.freeze({
  rect: null,
  tag: '—',
  role: null,
  ariaLabel: null,
  text: '',
  ariaDisabled: null,
  tabIndex: null,
});

/**
 * Exécutée DANS la page. Elle lit et n'agit sur rien : ni `click`, ni `focus`,
 * ni `dispatchEvent`. Le texte est borné, pour qu'aucun contenu de conversation
 * ne remonte dans un journal par ce chemin.
 */
const MEASURE_SEND_CONTROL_IN_PAGE = (element: Element): RawControlMeasure => {
  const box = element.getBoundingClientRect();
  return {
    rect: {
      top: Math.round(box.top),
      bottom: Math.round(box.bottom),
      left: Math.round(box.left),
      right: Math.round(box.right),
      width: Math.round(box.width),
      height: Math.round(box.height),
    },
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute('role'),
    ariaLabel: element.getAttribute('aria-label'),
    text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
    ariaDisabled: element.getAttribute('aria-disabled'),
    tabIndex: element.getAttribute('tabindex'),
  };
};

export class PlaywrightInstagramReplyRail
  extends PlaywrightInstagramThreadInspectionRail
  implements InstagramReplyRail
{
  /** Compté par le rail lui-même, pour que l'orchestrateur n'ait pas à le croire sur parole. */
  private clicks = 0;

  get clickCount(): number {
    return this.clicks;
  }

  /**
   * L'unique site de clic de ce fichier.
   *
   * Reçoit un `Locator` déjà résolu — ni sélecteur, ni URL — journalise,
   * incrémente le compteur, et clique une fois. Elle ne réessaie jamais.
   */
  private async clickOnce(locator: Locator, purpose: 'send_reply'): Promise<void> {
    this.clicks += 1;
    // La frontière de la trace est posée AVANT le clic : une requête partie
    // pendant le clic doit compter comme `post_effect`.
    this.trace.markEffect();
    this.log.info('instagram.reply.click', { purpose, clickIndex: this.clicks });
    await locator.click({ timeout: CONTROL_TIMEOUT_MS });
  }

  /**
   * Le contrôle d'envoi, cherché DANS le panneau qui porte le composeur.
   *
   * Même raison que dans le canari : « Envoyer » n'est pas un mot rare sur une
   * page Instagram, et le contrôle d'envoi est le seul élément de ce fichier
   * dont un clic produit un effet. Le chercher dans la page entière reviendrait
   * à cliquer « le premier Envoyer visible ».
   *
   * Cette méthode et `SEND_CONTROL_SELECTORS` vivent ICI et pas dans la classe
   * de base : la base ne clique pas, et un module qui ne clique pas n'a aucune
   * raison de savoir désigner ce qui cliquerait.
   */
  private async measureCandidate(locator: Locator, selectorIndex: number, nth: number): Promise<SendControlCandidate> {
    const raw = await locator.evaluate(MEASURE_SEND_CONTROL_IN_PAGE).catch(() => UNREADABLE_CONTROL_MEASURE);
    const visible = await locator.isVisible().catch(() => false);
    // « Actif » exige de POUVOIR lire : une lecture impossible rend `false`,
    // parce que « je n'ai pas pu lire » n'est pas « c'est actif ». Les trois
    // signaux sont ceux de l'ancienne `isSendControlEnabled`, mot pour mot.
    const enabled =
      raw.ariaDisabled !== 'true' && raw.tabIndex !== '-1' && (await locator.isEnabled().catch(() => false));
    return Object.freeze({ selectorIndex, nth, visible, enabled, ...raw });
  }

  /**
   * Tous les prétendants au contrôle d'envoi que la PAGE porte, mesurés.
   *
   * La recherche est faite sur la page entière et le tri est fait APRÈS, par du
   * code pur (`decideSendControl`), pour une raison précise : borner la
   * recherche dans le DOM cacherait les prétendants HORS périmètre, et c'est
   * justement leur existence qui rend `AMBIGUOUS` informatif. Mesurer large et
   * décider étroit n'affaiblit rien — aucun élément hors `panelRect` ne peut
   * être retenu.
   *
   * Bornée par sélecteur : une page qui porterait cent « Envoyer » est une page
   * qu'on ne comprend pas, et la mesurer entièrement ne la rendrait pas plus
   * claire.
   */
  protected async measureSendControlCandidates(page: Page): Promise<readonly SendControlCandidate[]> {
    const candidates: SendControlCandidate[] = [];
    for (const [selectorIndex, selector] of SEND_CONTROL_SELECTORS.entries()) {
      const all = page.locator(selector);
      const count = Math.min(await all.count().catch(() => 0), MAX_CANDIDATES_PER_SELECTOR);
      for (let nth = 0; nth < count; nth += 1) {
        candidates.push(await this.measureCandidate(all.nth(nth), selectorIndex, nth));
      }
    }
    return Object.freeze(candidates);
  }

  /**
   * Le contrôle d'envoi, cherché DANS le panneau du fil déjà confirmé.
   *
   * Ce qui a changé le 22 août 2026, et pourquoi — voir `sendControl.ts` :
   * l'ancre `ancestor::*[@role="dialog" or @aria-label][1]` rendait ZÉRO
   * élément sur un vrai fil plein écran, si bien que le contrôle n'était pas
   * jugé absent, il n'était pas cherché. Le périmètre est désormais
   * `panelRect` — le rectangle du panneau sur lequel l'identité du
   * correspondant vient d'être établie.
   *
   * La boucle ATTEND, elle ne provoque rien : Instagram ne rend son contrôle
   * qu'une fois le composeur non vide, et ce délai n'est pas un échec. Elle
   * s'arrête au premier verdict cliquable, ou à l'échéance sur le dernier
   * verdict lu — jamais sur un verdict inventé.
   */
  protected async locateSendControl(
    page: Page,
    panelRect: ReadRect | null,
    timeoutMs: number,
  ): Promise<{
    readonly decision: SendControlDecision;
    readonly control: Locator | null;
    readonly candidates: readonly SendControlCandidate[];
  }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const candidates = await this.measureSendControlCandidates(page);
      const decision = decideSendControl({ candidates, panelRect });
      if (decision.outcome === 'SEND_CONTROL_MATCH' || decision.outcome === 'SEND_CONTROL_SCOPE_UNKNOWN') {
        const chosen = decision.chosen;
        const control =
          chosen === null
            ? null
            : page.locator(SEND_CONTROL_SELECTORS[chosen.selectorIndex] as string).nth(chosen.nth);
        return { decision, control, candidates };
      }
      if (Date.now() >= deadline) return { decision, control: null, candidates };
      await page.waitForTimeout(OBSERVATION_POLL_MS);
    }
  }

  /**
   * Ce que `deliveryProof` conclut d'une récolte DÉJÀ prise.
   *
   * Séparé de la récolte pour que la garde d'historique et le compte des
   * occurrences d'avant-clic partagent la MÊME observation : deux récoltes
   * successives décrivent deux instants, et rien ne garantit que la seconde
   * voie ce que la première a vu.
   */
  private adjudicateHarvest(
    harvest: ThreadHarvest,
    body: string,
    expectedHandle: string,
    composerCleared: boolean | null,
    bubblesBefore: number | null,
    anchorRect: ObservedRect | null,
  ): DeliveryAdjudication {
    return adjudicateDelivery({
      observation: {
        ancestorChain: harvest.ancestorChain,
        nodes: harvest.nodes,
        handleLinks: harvest.handleLinks,
        composerText: harvest.composerText,
        truncated: harvest.truncated || !harvest.readable,
        inbox: null,
      },
      approvedText: body,
      expectedHandle,
      composerCleared,
      bubblesBefore,
      anchorRect,
    });
  }

  /** Récolte le fil, puis l'adjuge. Utilisé APRÈS le clic, où chaque tour veut un état frais. */
  private async observeThread(
    composer: Locator,
    body: string,
    expectedHandle: string,
    composerCleared: boolean | null,
    bubblesBefore: number | null,
    anchorRect: ObservedRect | null,
  ): Promise<{ harvest: ThreadHarvest; adjudication: DeliveryAdjudication }> {
    const harvest = await harvestThread(composer);
    return {
      harvest,
      adjudication: this.adjudicateHarvest(harvest, body, expectedHandle, composerCleared, bubblesBefore, anchorRect),
    };
  }

  async sendThreadReply(input: InstagramReplyInput): Promise<InstagramReplyResult> {
    const started = Date.now();
    const { target, provenance } = input;

    // ---- 0. Ce que l'appelant a demandé est-il seulement formulable ? ------
    //
    // Les quatre premiers refus sont ceux de la classe de base, partagés avec
    // l'inspection : une cible que l'inspection accepterait et que l'envoi
    // rejetterait (ou l'inverse) ferait valider un ciblage qui n'est pas
    // celui-ci.
    const { account, counterparty } = PlaywrightInstagramReplyRail.validateTarget(target);

    // Le cinquième n'appartient qu'à l'envoi : l'inspection ne porte pas de
    // texte, donc elle n'a rien à en dire.
    const body = input.body;
    if (body.trim().length === 0) {
      throw new InstagramRailError(
        'IG_RAIL_ERROR',
        'texte vide — le plan porte le message, le rail n’en écrit aucun',
      );
    }

    this.log.info('instagram.reply.begin', {
      source: provenance.source,
      planId: provenance.planId,
      threadId: target.expectedThreadId,
      stopAfter: input.stopAfter ?? 'send',
    });

    const { context, page } = await this.open();

    const abort = async (
      code: InstagramReplyAbortCode,
      detail: string,
      sessionState: InstagramSessionState,
    ): Promise<InstagramReplyResult> => {
      const screenshotPath = await this.capture(page, `${counterparty}-reply-abort`);
      return Object.freeze({ kind: 'NOT_ATTEMPTED' as const, code, detail, sessionState, screenshotPath });
    };

    // ---- 1. Sous quel compte cette session est-elle ouverte ? --------------
    //
    // La question n'a l'air de rien et elle est le socle du reste : un fil
    // `/direct/t/<id>/` n'a de sens que pour le compte qui le possède. Si la
    // session avait basculé, l'identifiant désignerait autre chose — ou rien.
    //
    // L'étape est celle de la classe de base — la MÊME que celle qu'un aperçu
    // read-only exerce contre un vrai fil. Ce qui diffère est ce qu'on en fait :
    // ici, un refus arrête tout ; là-bas, il est rapporté et le parcours
    // continue. Un en-tête illisible ne conclut RIEN : c'est un refus
    // temporaire, pas un verdict d'identité.
    const accountStage = await this.stageAccountIdentity(context, page, account);
    if (!isUsableSessionState(accountStage.state)) {
      return abort('IG_REPLY_SESSION_LOST', accountStage.finding.detail, accountStage.state);
    }
    if (accountStage.finding.outcome === 'MISMATCH') {
      return abort('IG_REPLY_ACCOUNT_MISMATCH', accountStage.finding.detail, accountStage.state);
    }
    if (accountStage.finding.outcome === 'UNKNOWN') {
      return abort('IG_REPLY_SESSION_LOST', accountStage.finding.detail, accountStage.state);
    }

    // ---- 2. Le nom d'affichage du correspondant, relu chez lui -------------
    //
    // Une LECTURE, et rien d'autre : pas de bouton cherché, pas de composeur
    // ouvert, aucun clic. Elle existe parce que `decideThreadIdentity` n'accepte
    // la preuve faible — un en-tête qui affiche un nom sans handle — que
    // CORROBORÉE par ce que le compte déclare lui-même.
    const displayStage = await this.stageCounterpartyDisplayName(context, page, counterparty);
    if (!isUsableSessionState(displayStage.state)) {
      return abort(
        'IG_REPLY_SESSION_LOST',
        `la page de « ${counterparty} » rend un état ${displayStage.state}`,
        displayStage.state,
      );
    }
    const expectedDisplayName = displayStage.displayName;

    // ---- 3. Le fil, par son identifiant ------------------------------------
    const reached = await this.stageReachThread(context, page, target.expectedThreadId);
    if (!isUsableSessionState(reached.sessionState)) {
      return abort('IG_REPLY_SESSION_LOST', `le fil rend un état ${reached.sessionState}`, reached.sessionState);
    }
    if (!reached.navigation.match) {
      return abort('IG_REPLY_THREAD_NOT_REACHED', reached.navigation.detail, reached.sessionState);
    }
    const reachedUrl = reached.navigation.landedUrl ?? threadUrlOf(target.expectedThreadId);
    const inThreadState = reached.sessionState;

    const composer = await this.stageComposer(page);
    if (composer === null) {
      return abort(
        'IG_REPLY_COMPOSER_NOT_FOUND',
        'aucun champ de saisie visible dans le fil — il n’y a rien où écrire, donc rien à envoyer',
        inThreadState,
      );
    }

    // ---- 4. L'identité du fil, relue dans son EN-TÊTE ----------------------
    const identityStage = await this.stageThreadIdentity(
      composer,
      counterparty,
      expectedDisplayName,
      reached.navigation,
    );
    const threadVerdict = identityStage.verdict;
    if (!threadVerdict.ok) {
      this.log.warn('instagram.reply.thread_identity_refused', {
        outcome: identityStage.finding.outcome,
        diagnostics: identityStage.observation.diagnostics.slice(0, 12),
        headerHandles: identityStage.observation.headerHandles,
        headerTexts: identityStage.observation.headerTexts,
        panelFound: identityStage.observation.panelFound,
        panelAmbiguous: identityStage.observation.panelAmbiguous,
      });
      return abort('IG_REPLY_THREAD_IDENTITY_UNCONFIRMED', threadVerdict.detail, inThreadState);
    }
    const threadHandle = threadVerdict.handle;
    const panelRect = identityStage.observation.panelRect;
    const anchorRect: ObservedRect | null =
      panelRect === null
        ? null
        : { top: panelRect.top, bottom: panelRect.bottom, left: panelRect.left, right: panelRect.right };

    // ---- 5. Le fil a-t-il un PASSÉ ? ---------------------------------------
    //
    // La garde qui empêche cette primitive d'être un premier contact. Elle est
    // évaluée AVANT toute saisie, et sur une récolte prise avant elle : le texte
    // qu'on s'apprête à écrire ne doit pas pouvoir servir de preuve d'historique.
    //
    // UNE seule récolte sert aux deux questions — « ce fil a-t-il un passé ? »
    // et « combien d'occurrences du texte approuvé porte-t-il déjà ? ». Deux
    // récoltes décriraient deux instants, et la seconde inclurait ce que la
    // première n'a pas vu.
    const historyStage = await this.stageHistory(composer);
    const history: ThreadHistory = historyStage.history;
    const before = this.adjudicateHarvest(historyStage.harvest, body, counterparty, null, null, anchorRect);
    if (history.verdict !== 'HAS_HISTORY') {
      return abort('IG_REPLY_EMPTY_THREAD', history.detail, inThreadState);
    }

    // ---- 6. L'aperçu s'arrête ici, avant la saisie -------------------------
    //
    // Avant, et non après : écrire dans un vrai composeur Instagram laisserait
    // un brouillon chez le prospect. Un aperçu ne dépose rien nulle part.
    if (input.stopAfter === 'thread') {
      const screenshotPath = await this.capture(page, `${counterparty}-reply-preview`);
      return Object.freeze({
        kind: 'PREVIEWED' as const,
        detail:
          `fil ${target.expectedThreadId} atteint et vérifié : compte émetteur « ${account} » confirmé, ` +
          `correspondant « ${threadHandle} » (${threadVerdict.via}), ${history.detail}. ` +
          'Arrêt avant toute saisie.',
        sessionState: inThreadState,
        threadUrl: reachedUrl,
        threadHandle,
        priorBubbles: history.textNodes,
        composerReady: true,
        screenshotPath,
      });
    }

    // ---- 7. Le texte exact du plan -----------------------------------------
    //
    // Un saut de ligne est refusé AVANT toute saisie : dans un composeur
    // Instagram, « Entrée » ENVOIE. Saisir un texte qui en contient un enverrait
    // un message tronqué, au milieu de la frappe, sans passer par le crochet
    // d'effet ni par le clic unique.
    if (/[\r\n]/.test(body)) {
      return abort(
        'IG_REPLY_PAYLOAD_NOT_ENTERED',
        'le texte du plan contient un saut de ligne — dans ce composeur, « Entrée » envoie : le saisir ' +
          'enverrait un message tronqué avant l’unique clic',
        inThreadState,
      );
    }

    // `pressSequentially` et non `fill` : `fill` écrit dans le DOM sans produire
    // les événements clavier que l'application attend, si bien qu'Instagram ne
    // « voit » pas le texte et ne fait jamais apparaître son bouton d'envoi.
    // `delay: 0`, aucun aléa, aucune pause : ce n'est pas une imitation d'humain,
    // c'est la seule façon de remplir un champ que l'application contrôle.
    await composer.pressSequentially(body, { delay: 0 }).catch(() => undefined);
    const typed = await this.readComposer(composer);
    const expected = body.replace(/\s+/g, ' ').trim();
    if (typed !== expected) {
      await composer.fill('').catch(() => undefined);
      return abort(
        'IG_REPLY_PAYLOAD_NOT_ENTERED',
        `le composeur porte ${String(typed.length)} caractère(s) au lieu des ${String(expected.length)} ` +
          'du plan — rien n’a été envoyé',
        inThreadState,
      );
    }

    // HERMES-SEND-CONTROL-PROBE-R1 §15/§17/§18 — le périmètre est le PANNEAU
    // confirmé, et la décision est du code pur.
    //
    // L'ancre d'attribut d'avant (`ancestor::*[@role="dialog" or
    // @aria-label][1]`) rendait zéro élément sur un vrai fil plein écran : le
    // contrôle n'était pas jugé absent, il n'était pas cherché. Ce qui décide
    // maintenant est `decideSendControl`, sur `panelRect` — le rectangle du
    // panneau sur lequel l'identité du correspondant vient d'être établie, à
    // l'instant, sur cette page.
    //
    // Quatre refus distincts, parce qu'ils font chercher à quatre endroits
    // différents, et aucun ne clique.
    const located = await this.locateSendControl(page, panelRect, CONTROL_TIMEOUT_MS);
    const sendControl = located.control;
    if (sendControl === null || located.decision.outcome !== 'SEND_CONTROL_MATCH') {
      const evidence = await this.capture(page, `${counterparty}-reply-no-send-control`);
      await composer.fill('').catch(() => undefined);
      this.log.warn('instagram.reply.send_control_refused', {
        outcome: located.decision.outcome,
        seen: located.decision.seen,
        inScope: located.decision.inScope,
      });
      return Object.freeze({
        kind: 'NOT_ATTEMPTED' as const,
        code:
          located.decision.outcome === 'SEND_CONTROL_AMBIGUOUS'
            ? ('IG_REPLY_CONTROL_AMBIGUOUS' as const)
            : ('IG_REPLY_CONTROL_NOT_FOUND' as const),
        detail: `[${located.decision.outcome}] ${located.decision.detail}`,
        sessionState: inThreadState,
        screenshotPath: evidence,
      });
    }

    // ---- 8. Le brouillon CONSTATÉ, sans clic -------------------------------
    //
    // Même code que l'envoi jusqu'ici : même navigation, mêmes identités, même
    // saisie, même recherche du contrôle. Ce qui suit ne clique pas, mesure, puis
    // efface le brouillon.
    if (input.stopAfter === 'draft') {
      const descriptor = await this.describeComposer(composer);
      const screenshotPath = await this.capture(page, `${counterparty}-reply-draft`);
      await composer.fill('').catch(() => undefined);
      // HERMES-SEND-CONTROL-PROBE-R1 §19 — vidé, puis RELU après une pause.
      //
      // Une seule lecture ne distingue pas « le composeur est vide » de « le
      // composeur est vide pour l'instant » : Instagram restaure ses brouillons,
      // et un texte qui revient une seconde plus tard est exactement ce qu'un
      // constat immédiat ne verrait pas. Les deux lectures doivent être vides ;
      // une seule qui ne l'est pas rend `false`.
      const clearedNow = (await this.readComposer(composer)).length === 0;
      await page.waitForTimeout(DRAFT_SETTLE_MS);
      const cleared = clearedNow && (await this.readComposer(composer)).length === 0;
      return Object.freeze({
        kind: 'DRAFT_READY' as const,
        detail:
          `brouillon saisi et constaté sans clic dans le fil ${target.expectedThreadId} : ` +
          `${String(typed.length)} caractère(s) exacts, contrôle d’envoi ` +
          `[${located.decision.outcome}] ${located.decision.detail}, ` +
          `composeur ${cleared ? 'vidé' : 'NON vidé'}. ${descriptor}`,
        sessionState: inThreadState,
        threadUrl: reachedUrl,
        threadHandle,
        priorBubbles: history.textNodes,
        composerText: typed,
        payloadExact: typed === expected,
        sendControlPresent: true,
        sendControlEnabled: located.decision.outcome === 'SEND_CONTROL_MATCH',
        sendControl: located.decision,
        composerDescriptor: descriptor,
        composerCleared: cleared,
        screenshotPath,
      });
    }

    // ---- 9. Le crochet, PUIS le clic ---------------------------------------
    //
    // Si le crochet lève — arrêt global réarmé, fenêtre refermée, message plus
    // récent arrivé, réservation refusée —, l'exception remonte et le clic n'a
    // pas lieu. L'ordre n'est pas une convention, c'est le flot de contrôle.
    await input.onBeforeExternalEffect();

    await this.clickOnce(sendControl, 'send_reply');

    // ---- 10. Observer, sans jamais rejouer ---------------------------------
    //
    // La boucle attend une preuve, elle ne provoque rien : ni second clic, ni
    // seconde saisie, ni rechargement. Elle s'arrête dès que l'observation
    // devient concluante — dans un sens OU dans l'autre.
    const deadline = Date.now() + OBSERVATION_TIMEOUT_MS;
    let composerCleared = (await this.readComposer(composer)).length === 0;
    let after = await this.observeThread(
      composer,
      body,
      counterparty,
      composerCleared,
      before.bubbles.length,
      anchorRect,
    );
    while (Date.now() < deadline && after.adjudication.verdict === 'AMBIGUOUS') {
      await page.waitForTimeout(OBSERVATION_POLL_MS);
      composerCleared = (await this.readComposer(composer)).length === 0;
      after = await this.observeThread(
        composer,
        body,
        counterparty,
        composerCleared,
        before.bubbles.length,
        anchorRect,
      );
    }

    const finalState = await this.classifyCurrentPage(context, page);
    const screenshotPath = await this.capture(page, `${counterparty}-reply-sent`);
    const verdict = after.adjudication;

    return Object.freeze({
      kind: 'ATTEMPTED' as const,
      observation: Object.freeze({
        threadUrl: page.url(),
        observedThreadId: PlaywrightInstagramReplyRail.observedThreadId(page.url()),
        threadHandle: verdict.threadHandle,
        priorBubbles: history.textNodes,
        matchingBubblesBefore: before.bubbles.length,
        matchingBubblesAfter: verdict.bubbles.length,
        harvestReadableBefore: historyStage.harvest.readable,
        harvestReadableAfter: after.harvest.readable,
        composerCleared,
        outgoingBubbleConfirmed: verdict.outgoingBubbles.length > 0,
        deliveryFailureMarkers: Object.freeze(
          verdict.failureMarkers.map((marker) => `${marker.strength}/${marker.source} « ${marker.label} »`),
        ),
        deliveryVerdict: verdict.verdict,
        scopeDetail: verdict.scope.detail,
        sessionState: finalState.state,
        screenshotPath,
        durationMs: Date.now() - started,
        detail:
          `clic unique effectué dans le fil ${target.expectedThreadId} ; ` +
          `${String(before.bubbles.length)} → ${String(verdict.bubbles.length)} occurrence(s) du texte du plan, ` +
          `composeur ${composerCleared ? 'vidé' : 'non vidé'}, ` +
          `récolte ${after.harvest.readable ? 'lisible' : 'ILLISIBLE'}, ` +
          `verdict ${verdict.verdict}, état final ${finalState.state}`,
      }),
    });
  }
}
