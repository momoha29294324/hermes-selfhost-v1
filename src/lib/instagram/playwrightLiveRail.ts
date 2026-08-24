import type { Locator, Page } from 'playwright';
import { normalizeHandle, profileUrl } from '@/lib/instagram/identity';
import {
  CONTACT_BUTTON_SELECTORS,
  CONTACT_MENU_MESSAGE_SELECTORS,
  COMPOSER_SELECTORS,
  MESSAGE_BUTTON_SELECTORS,
  SEND_CONTROL_SELECTORS,
} from '@/lib/instagram/domSelectors';
import { adjudicateDelivery, type DeliveryAdjudication } from '@/lib/instagram/deliveryProof';
import type { ObservedRect } from '@/lib/instagram/threadObservation';
import {
  classifyThreadIdentity,
  decideThreadIdentity,
  displayNameForHandle,
  READ_THREAD_IDENTITY_IN_PAGE,
  THREAD_IDENTITY_LIMITS,
  UNREADABLE_THREAD_READ,
  type ThreadIdentityObservation,
} from '@/lib/instagram/threadIdentity';
import { harvestThread, type ThreadHarvest } from '@/lib/instagram/threadHarvest';
import { PlaywrightInstagramRail } from '@/lib/instagram/playwrightRail';
import { classifyLiveDmRequest, isAllowedLiveNavigation, type GuardDecision } from '@/lib/instagram/readOnlyGuard';
import {
  RefusalTrace,
  type RefusalTraceSnapshot,
  type RefusedRequest,
} from '@/lib/instagram/refusalTrace';
import {
  InstagramRailError,
  type InstagramLiveRail,
  type InstagramSendInput,
  type InstagramSendResult,
} from '@/lib/instagram/rail';
import { isUsableSessionState, type InstagramSessionState } from '@/lib/instagram/types';

/**
 * IG2 §2 — la primitive d'envoi, et tout ce qu'elle refuse de savoir faire.
 *
 * Ce fichier est le seul du dépôt capable de produire un effet chez un
 * prospect. Il est délibérément petit, et ce qu'il ne contient pas compte
 * autant que ce qu'il contient.
 *
 * Un seul site de clic
 * --------------------
 * Un seul appel de clic existe dans ce fichier, dans `clickOnce`. Les deux
 * gestes du parcours — ouvrir le composeur, puis envoyer — passent par elle,
 * avec un `purpose` nommé. Compter les clics du canari ne demande donc pas de
 * lire le flot de contrôle : il y a un endroit, il journalise, il incrémente un
 * compteur, et un test vérifie qu'il reste unique.
 *
 * Les deux gestes ne sont pas de même nature, et le code ne les traite pas de
 * même : ouvrir un fil de discussion ne remet rien à personne (Instagram ne
 * notifie pas l'ouverture d'une conversation vide), tandis que le second est
 * l'effet. Seul le second est précédé du crochet de journalisation.
 *
 * Aucune génération de message
 * ----------------------------
 * `body` arrive du manifeste verrouillé et n'est ni reformulé, ni tronqué, ni
 * complété. Aucun appel LLM, aucun gabarit, aucune salutation ajoutée. La
 * saisie est vérifiée après coup : si ce qui est dans le composeur n'est pas
 * exactement ce qui a été approuvé, la primitive s'arrête avant le clic.
 *
 * Aucun rejeu
 * -----------
 * Il n'y a ni boucle, ni `retry`, ni second essai après un timeout. Une fois
 * `clickOnce` appelé pour l'envoi, la fonction ne fait plus qu'observer — et
 * elle rend ce qu'elle a vu, jamais un verdict.
 *
 * Aucune technique d'évitement
 * ----------------------------
 * Aucun délai aléatoire, aucune frappe simulée caractère par caractère pour
 * « ressembler à un humain », aucune empreinte falsifiée, aucun relais
 * d'anonymisation. Le navigateur est celui de `PlaywrightInstagramRail`, tel
 * quel — mêmes en-têtes, même locale, même fuseau.
 */

/** Bornes d'attente, courtes et nommées. Aucune n'est une boucle de retry. */
const COMPOSER_TIMEOUT_MS = 15_000;
const THREAD_TIMEOUT_MS = 20_000;
const CONTROL_TIMEOUT_MS = 10_000;
/** Fenêtre d'observation APRÈS le clic. Observer n'est pas réessayer. */
const OBSERVATION_TIMEOUT_MS = 20_000;
const OBSERVATION_POLL_MS = 500;

/*
 * IG2.1 §3 — ce qui a été RETIRÉ d'ici, et pourquoi il ne doit pas revenir.
 *
 * `BubbleScan` et `UNREADABLE_SCAN` comptaient les occurrences du texte exact.
 * Leur commentaire promettait « jamais confondu avec zéro occurrence » — et
 * c'est pourtant exactement ce qui est arrivé le 14 août : l'appelant ne lisait
 * de la mesure que `matches.length`, si bien qu'une lecture qui n'avait jamais
 * pu s'exécuter rendait `0`, indiscernable d'un fil réellement vide.
 *
 * Le remplacement (`threadHarvest` + `deliveryProof`) porte la distinction dans
 * son TYPE : la récolte dit `readable`, et le code pur refuse de conclure sans
 * lui. Une promesse tenue par un commentaire n'était pas une garde ; celle-ci
 * l'est.
 */

export class PlaywrightInstagramLiveRail extends PlaywrightInstagramRail implements InstagramLiveRail {
  /** Compté par le rail lui-même, pour que le worker n'ait pas à le croire sur parole. */
  private clicks = 0;

  /**
   * IG2.5/IG2.6 — ce que NOTRE garde a refusé pendant le parcours.
   *
   * Ce champ n'existait pas avant IG2.5, et son absence est la raison pour
   * laquelle le DELIVERY_FAILED du 14 août n'a pas pu être expliqué. Le rail
   * d'adjudication comptait ses refus depuis IG2.1 ; celui qui produit l'effet,
   * non. La seule exécution qui comptait n'a donc rien enregistré de ce qu'elle
   * empêchait de sortir.
   *
   * IG2.6 corrige sa rétention : garder « les 40 premiers » revenait à garder
   * la télémétrie du brouillon et à jeter la requête d'après-clic. La trace
   * range désormais par distance à l'effet (`RefusalTrace`).
   *
   * Ce n'est pas une garde de plus : c'est la trace de la garde existante.
   */
  private readonly trace = new RefusalTrace();

  get clickCount(): number {
    return this.clicks;
  }

  /** La trace conservée, à tout moment — y compris depuis un `finally` après une levée. */
  refusalSnapshot(): RefusalTraceSnapshot {
    return this.trace.snapshot();
  }

  get refusedRequests(): readonly RefusedRequest[] {
    return this.trace.snapshot().records;
  }

  protected override requestClassifier(): (request: {
    url: string;
    method: string;
    postData: string | null;
  }) => GuardDecision {
    return (request) => {
      const decision = classifyLiveDmRequest(request);
      // L'enregistrement est en aval de la décision et ne peut pas la changer :
      // `decision` est rendue telle quelle, quoi qu'il arrive ici.
      if (!decision.allowed) {
        this.trace.record({
          method: request.method,
          url: request.url,
          rule: decision.rule,
          reason: decision.reason,
          postData: request.postData,
        });
      }
      return decision;
    };
  }

  protected override isNavigable(url: string): boolean {
    return isAllowedLiveNavigation(url);
  }

  /**
   * L'unique site de clic du dépôt.
   *
   * Ni sélecteur libre ni URL : elle reçoit un `Locator` déjà résolu et un
   * motif nommé, journalise, incrémente le compteur, et clique une fois. Elle
   * ne réessaie jamais — un `click` qui échoue remonte son erreur.
   */
  private async clickOnce(
    locator: Locator,
    purpose: 'open_contact_menu' | 'open_composer' | 'send_message',
  ): Promise<void> {
    this.clicks += 1;
    // La frontière de la trace est posée AVANT le clic, pas après : une requête
    // partie pendant le clic doit compter comme `post_effect`. Poser la
    // frontière après reviendrait à classer la requête d'envoi du mauvais côté.
    if (purpose === 'send_message') this.trace.markEffect();
    this.log.info('instagram.live.click', { purpose, clickIndex: this.clicks });
    await locator.click({ timeout: CONTROL_TIMEOUT_MS });
  }

  /** Le premier sélecteur qui rend un élément visible. `null` si aucun — jamais un repli. */
  private async firstVisible(page: Page, selectors: readonly string[], timeoutMs: number): Promise<Locator | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (const selector of selectors) {
        const locator = page.locator(selector).first();
        const visible = await locator.isVisible().catch(() => false);
        if (visible) return locator;
      }
      if (Date.now() >= deadline) return null;
      await page.waitForTimeout(OBSERVATION_POLL_MS);
    }
  }

  /**
   * Idem, mais borné au PANNEAU qui porte le composeur.
   *
   * Utilisé pour le contrôle d'envoi, et la raison est concrète : « Envoyer »
   * n'est pas un mot rare sur une page Instagram, et le contrôle d'envoi est le
   * seul élément de tout ce fichier dont un clic produit un effet. Le chercher
   * dans la page entière reviendrait à cliquer « le premier Envoyer visible »,
   * c'est-à-dire potentiellement autre chose que l'envoi de CE message.
   *
   * Le panneau est le même conteneur que celui où l'identité a été confirmée :
   * le premier ancêtre portant `role="dialog"` ou un `aria-label`.
   */
  private async firstVisibleInPanel(
    page: Page,
    composer: Locator,
    selectors: readonly string[],
    timeoutMs: number,
  ): Promise<Locator | null> {
    const panel = composer.locator('xpath=ancestor::*[@role="dialog" or @aria-label][1]');
    if (!(await panel.count().catch(() => 0))) return null;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (const selector of selectors) {
        const locator = panel.locator(selector).first();
        const visible = await locator.isVisible().catch(() => false);
        if (visible) return locator;
      }
      if (Date.now() >= deadline) return null;
      await page.waitForTimeout(OBSERVATION_POLL_MS);
    }
  }

  /**
   * Ce que le panneau de discussion laisse lire de SON EN-TÊTE.
   *
   * Distinct de l'identité du profil vérifiée en amont, et c'est tout le point :
   * entre « j'ai ouvert le bon profil » et « j'écris dans le bon fil », il y a
   * un clic. Le fil doit se nommer lui-même.
   *
   * Le premier aperçu réel a montré pourquoi la portée compte. Un compte
   * professionnel n'emmène pas vers `/direct/t/<id>/` : « Contacter » ouvre un
   * panneau de discussion DANS la page de profil. Chercher le handle « dans la
   * page » y lirait donc le profil lui-même — qui porte évidemment le bon
   * handle, et ne prouverait rien sur le panneau.
   *
   * Le SECOND aperçu réel a montré que le panneau non plus n'est pas la bonne
   * portée. Un fil qui contient des reels partagés porte les liens de leurs
   * auteurs, et les compter comme des prétendants à l'identité du
   * correspondant refusait une conversation pourtant correcte — pour le compte
   * de test comme pour n'importe quel prospect ayant un historique.
   *
   * La portée qui décide est donc l'EN-TÊTE : la barre qui nomme le
   * correspondant. Ce qui est écrit dans les bulles est du contenu, lu et
   * journalisé, jamais consulté pour conclure. Voir `threadIdentity.ts`.
   */
  private async readThreadIdentity(composer: Locator): Promise<ThreadIdentityObservation> {
    // La page MESURE, le code pur DÉCIDE. La bande d'en-tête ne se calcule pas
    // ici : elle se calcule dans `classifyThreadIdentity`, où un test peut la
    // prendre en défaut sans navigateur — ce qui a manqué au premier correctif.
    const raw = await composer
      .evaluate(READ_THREAD_IDENTITY_IN_PAGE, THREAD_IDENTITY_LIMITS)
      .catch(() => UNREADABLE_THREAD_READ);
    return classifyThreadIdentity(raw, THREAD_IDENTITY_LIMITS);
  }

  /**
   * Le nom d'affichage du handle attendu, relu sur la page de profil courante.
   *
   * Sert uniquement de corroboration quand l'en-tête du fil nomme le
   * correspondant sans écrire son handle — ce que fait Instagram en affichant
   * « Moha » plutôt que « operator_second_account ». Le titre porte les DEUX valeurs dans
   * la même chaîne, si bien que le nom en sort déjà rattaché à son handle ;
   * `displayNameForHandle` refuse d'ailleurs de rendre un nom si le handle du
   * titre n'est pas celui qu'on attend.
   */
  private async readExpectedDisplayName(page: Page, expected: string): Promise<string | null> {
    const ogTitle = await page
      .getAttribute('meta[property="og:title"]', 'content', { timeout: 3_000 })
      .catch(() => null);
    const fromOg = displayNameForHandle(ogTitle, expected);
    if (fromOg !== null) return fromOg;
    const title = await page.title().catch(() => null);
    return displayNameForHandle(title, expected);
  }

  /**
   * Regarde le fil et rend ce que `deliveryProof` en conclut.
   *
   * Remplace le comptage de bulles d'IG2, qui a produit le « 0 → 0 » du
   * 14 août. Trois choses ont changé, et chacune répond à un défaut nommé :
   *
   *   * la récolte est celle de `threadHarvest`, sans aucune fonction nommée
   *     dans le corps évalué — l'ancienne en déclarait une, et `__name` étant
   *     absent de la page, elle levait une `ReferenceError` avant sa première
   *     mesure ;
   *   * une panne se DIT (`readable: false`) au lieu de se déguiser en zéro ;
   *   * le périmètre, la comparaison des textes, le côté sortant et le marqueur
   *     d'échec sont décidés par du code PUR, donc exerçables par des tests sur
   *     la structure réellement observée.
   */
  private async observeThread(
    composer: Locator,
    body: string,
    expectedHandle: string,
    composerCleared: boolean | null,
    bubblesBefore: number | null,
    anchorRect: ObservedRect | null,
  ): Promise<{ harvest: ThreadHarvest; adjudication: DeliveryAdjudication }> {
    const harvest = await harvestThread(composer);
    const adjudication = adjudicateDelivery({
      observation: {
        ancestorChain: harvest.ancestorChain,
        nodes: harvest.nodes,
        handleLinks: harvest.handleLinks,
        composerText: harvest.composerText,
        // Une récolte illisible est traitée comme une observation incomplète :
        // le code pur refusera d'en tirer un `SENT`.
        truncated: harvest.truncated || !harvest.readable,
        inbox: null,
      },
      approvedText: body,
      expectedHandle,
      composerCleared,
      bubblesBefore,
      // IG2.3 §1 — on regarde DANS le panneau qu'on vient de valider, pas dans
      // un périmètre redécouvert après coup.
      anchorRect,
    });
    return { harvest, adjudication };
  }

  /**
   * Inventaire des contrôles VISIBLES du panneau, pour qu'un refus soit
   * diagnosticable sans deviner ni ouvrir un navigateur à la main.
   *
   * Ne clique rien, ne modifie rien : il lit des rôles, des libellés et des
   * textes courts. Aucun attribut susceptible de porter un jeton n'est lu — ni
   * `href`, ni `src`, ni `data-*`.
   */
  private async describePanelControls(composer: Locator): Promise<string[]> {
    const panel = composer.locator('xpath=ancestor::*[@role="dialog" or @aria-label][1]');
    return panel
      .evaluate((root: Element) => {
        const out: string[] = [];
        const nodes = root.querySelectorAll('button, [role="button"], svg[aria-label], [aria-label]');
        for (const node of Array.from(nodes).slice(0, 40)) {
          const rect = node.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          const tag = node.tagName.toLowerCase();
          const role = node.getAttribute('role') ?? '';
          const label = (node.getAttribute('aria-label') ?? '').slice(0, 40);
          const text = ((node as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
          out.push(`${tag}${role ? `[${role}]` : ''}${label ? `«${label}»` : ''}${text ? `:${text}` : ''}`);
        }
        return out;
      })
      .catch(() => [] as string[]);
  }

  /** Le contenu réel du composeur, pour vérifier la saisie plutôt que l'espérer. */
  private async readComposer(composer: Locator): Promise<string> {
    const text = await composer.evaluate((node: Element) => {
      if (node instanceof HTMLTextAreaElement) return node.value;
      return (node as HTMLElement).innerText ?? '';
    }).catch(() => '');
    return text.replace(/\s+/g, ' ').trim();
  }

  /**
   * Le contrôle d'envoi est-il ACTIF, et pas seulement présent ?
   *
   * Trois signaux, dans l'ordre de fiabilité : `aria-disabled`, que l'interface
   * pose explicitement ; `isEnabled()` de Playwright ; et `tabindex="-1"`, qui
   * retire un contrôle du parcours clavier. Une lecture impossible rend
   * `false` — « je n'ai pas pu lire » n'est pas « c'est actif ».
   */
  private async isSendControlEnabled(control: Locator): Promise<boolean> {
    const ariaDisabled = await control.getAttribute('aria-disabled').catch(() => 'unknown');
    if (ariaDisabled === 'unknown') return false;
    if (ariaDisabled === 'true') return false;
    const tabIndex = await control.getAttribute('tabindex').catch(() => null);
    if (tabIndex === '-1') return false;
    return control.isEnabled().catch(() => false);
  }

  /**
   * Ce que le composeur déclare de lui-même : sa nature et son focus.
   *
   * Sert le diagnostic d'IG2.5 — savoir si la saisie automatisée vise bien un
   * `contenteditable` focalisé, et non un champ inerte qui accepterait du texte
   * sans que l'application le voie.
   */
  private async describeComposer(composer: Locator): Promise<string> {
    return composer
      .evaluate((node: Element) => {
        const el = node as HTMLElement;
        const editable = el.getAttribute('contenteditable');
        const role = el.getAttribute('role');
        const label = (el.getAttribute('aria-label') ?? '').slice(0, 40);
        const focused = document.activeElement === el || el.contains(document.activeElement);
        return (
          `${el.tagName.toLowerCase()}` +
          `${role === null ? '' : `[role=${role}]`}` +
          `${editable === null ? '' : `[contenteditable=${editable}]`}` +
          `${label === '' ? '' : `[label=${label}]`}` +
          ` focus=${String(focused)}`
        );
      })
      .catch(() => 'composeur non descriptible');
  }

  async sendFirstTouchDm(input: InstagramSendInput): Promise<InstagramSendResult> {
    const started = Date.now();
    const normalized = normalizeHandle(input.expectedHandle);
    if (normalized === null) {
      throw new InstagramRailError('IG_RAIL_ERROR', `handle Instagram invalide : « ${input.expectedHandle} »`);
    }
    const body = input.body;
    if (body.trim().length === 0) {
      throw new InstagramRailError('IG_RAIL_ERROR', 'texte vide — le manifeste doit porter le message, le rail n’en écrit aucun');
    }

    const { context, page } = await this.open();

    const abort = async (
      code: Parameters<typeof buildAbort>[0],
      detail: string,
      sessionState: InstagramSessionState,
    ): Promise<InstagramSendResult> => {
      const screenshotPath = await this.capture(page, `${normalized}-abort`);
      return buildAbort(code, detail, sessionState, screenshotPath);
    };

    // ---- 1. Le profil exact, revisité par le rail lui-même ------------------
    // Le worker a déjà ouvert ce profil et confirmé l'identité ; on n'hérite pas
    // de cette page pour autant. Entre les deux, la session a pu tomber, et
    // c'est depuis CETTE page que le clic partira.
    await this.navigate(page, profileUrl(normalized));
    const onProfile = await this.classifyCurrentPage(context, page);
    if (!isUsableSessionState(onProfile.state)) {
      return abort('IG_SEND_SESSION_LOST', `la page de profil rend un état ${onProfile.state}`, onProfile.state);
    }

    // ---- 2. Ouvrir le composeur -------------------------------------------
    //
    // Deux mises en page, découvertes dans cet ordre par les aperçus réels :
    //
    //   * compte PERSONNEL — un bouton « Message » ;
    //   * compte PROFESSIONNEL — pas de « Message », mais « Contacter », qui
    //     ouvre DIRECTEMENT un panneau de discussion dans la page, composeur
    //     compris. Aucune navigation, aucun menu.
    //
    // La troisième forme (« Contacter » ouvrant un menu où choisir entre appel,
    // e-mail et message) reste traitée, parce qu'elle existe chez d'autres
    // comptes professionnels — mais elle n'est cherchée QUE si aucun composeur
    // n'est apparu. Chercher le menu d'abord ferait manquer le cas nominal.
    const messageButton = await this.firstVisible(page, MESSAGE_BUTTON_SELECTORS, COMPOSER_TIMEOUT_MS);
    if (messageButton !== null) {
      await this.clickOnce(messageButton, 'open_composer');
    } else {
      const contactButton = await this.firstVisible(page, CONTACT_BUTTON_SELECTORS, CONTROL_TIMEOUT_MS);
      if (contactButton === null) {
        return abort(
          'IG_SEND_COMPOSER_NOT_FOUND',
          'ni bouton « Message » ni bouton « Contacter » sur le profil — rien à ouvrir, donc rien à envoyer',
          onProfile.state,
        );
      }
      await this.clickOnce(contactButton, 'open_contact_menu');
    }

    // Ce qu'on attend n'est PAS une URL : un compte professionnel ouvre son
    // panneau sans quitter le profil. On attend ce dont on a réellement besoin.
    let composer = await this.firstVisible(page, COMPOSER_SELECTORS, THREAD_TIMEOUT_MS);
    if (composer === null) {
      // Pas de composeur : peut-être un menu. On n'y clique que l'entrée
      // « message », jamais « appeler » ni « envoyer un e-mail ».
      const menuMessage = await this.firstVisible(page, CONTACT_MENU_MESSAGE_SELECTORS, CONTROL_TIMEOUT_MS);
      if (menuMessage === null) {
        return abort(
          'IG_SEND_COMPOSER_NOT_FOUND',
          'aucun champ de saisie après ouverture, et aucune entrée « Envoyer un message » — ce compte ne ' +
            'propose peut-être que l’e-mail ou le téléphone, qui ne sont pas ce que ce canari autorise',
          onProfile.state,
        );
      }
      await this.clickOnce(menuMessage, 'open_composer');
      composer = await this.firstVisible(page, COMPOSER_SELECTORS, THREAD_TIMEOUT_MS);
      if (composer === null) {
        return abort('IG_SEND_COMPOSER_NOT_FOUND', 'aucun champ de saisie visible après ouverture', onProfile.state);
      }
    }

    const threadUrl = page.url();
    const inThread = await this.classifyCurrentPage(context, page);
    if (!isUsableSessionState(inThread.state)) {
      return abort('IG_SEND_SESSION_LOST', `le fil de discussion rend un état ${inThread.state}`, inThread.state);
    }

    // ---- 3. La destination, relue dans l'EN-TÊTE du fil --------------------
    const threadObservation = await this.readThreadIdentity(composer);
    const threadVerdict = decideThreadIdentity({
      observation: threadObservation,
      expectedHandle: normalized,
      expectedDisplayName: await this.readExpectedDisplayName(page, normalized),
    });
    if (!threadVerdict.ok) {
      // Le refus emporte les MESURES avec lui. « Aucun en-tête lisible » sans
      // les rectangles observés n'apprend rien à qui doit corriger — les trois
      // refus précédents ont coûté une exécution de navigateur chacun pour
      // découvrir ce que ce champ dit maintenant tout seul.
      this.log.warn('instagram.live.thread_identity_refused', {
        diagnostics: threadObservation.diagnostics.slice(0, 12),
        headerHandles: threadObservation.headerHandles,
        headerTexts: threadObservation.headerTexts,
        bodyHandles: threadObservation.bodyHandles,
        panelFound: threadObservation.panelFound,
        panelAmbiguous: threadObservation.panelAmbiguous,
      });
      return abort('IG_SEND_THREAD_IDENTITY_UNCONFIRMED', threadVerdict.detail, inThread.state);
    }
    const threadHandle = threadVerdict.handle;
    // Le panneau qui vient de confirmer l'identité devient l'ANCRE de toutes
    // les lectures d'après-clic. Sans lui, la sélection de périmètre repartait
    // de zéro et retombait sur un conteneur collé au composeur.
    const panelRect = threadObservation.panelRect;
    const anchorRect: ObservedRect | null =
      panelRect === null
        ? null
        : { top: panelRect.top, bottom: panelRect.bottom, left: panelRect.left, right: panelRect.right };
    this.log.info('instagram.live.thread_identity', {
      via: threadVerdict.via,
      bodyHandles: threadObservation.bodyHandles.length,
      anchor: anchorRect === null ? null : `y${Math.round(anchorRect.top)}..${Math.round(anchorRect.bottom)}`,
    });

    // ---- 4. §6 — l'aperçu s'arrête ici -------------------------------------
    // Avant la saisie, et non après : écrire le message dans un vrai composeur
    // Instagram laisserait un brouillon chez le prospect. Un aperçu ne doit rien
    // déposer nulle part.
    if (input.stopAfter === 'thread') {
      const screenshotPath = await this.capture(page, `${normalized}-preview`);
      return Object.freeze({
        kind: 'PREVIEWED' as const,
        detail:
          `fil ouvert sur « ${threadHandle} », composeur présent — arrêt avant toute saisie ` +
          `(un aperçu ne dépose pas de brouillon). Identité du fil : ${threadVerdict.detail}. ` +
          `Panneau : ${threadObservation.diagnostics.slice(0, 2).join(' | ') || 'aucun'}` +
          (threadObservation.bodyHandles.length > 0
            ? `. Handles de l'historique, ignorés pour l'identité : ${threadObservation.bodyHandles.join(', ')}`
            : ''),
        sessionState: inThread.state,
        threadUrl,
        threadHandle,
        composerReady: true,
        screenshotPath,
      });
    }

    // ---- 5. Le texte exact du manifeste ------------------------------------
    //
    // Un saut de ligne est refusé AVANT toute saisie, et ce n'est pas une
    // coquetterie : dans un composeur Instagram, « Entrée » ENVOIE. Saisir un
    // texte qui en contient un enverrait donc un message tronqué, au milieu de
    // la frappe, sans passer par le journal d'effet ni par le clic unique.
    if (/[\r\n]/.test(body)) {
      return abort(
        'IG_SEND_PAYLOAD_NOT_ENTERED',
        'le texte approuvé contient un saut de ligne — dans ce composeur, « Entrée » envoie : ' +
          'le saisir enverrait un message tronqué avant l’unique clic',
        inThread.state,
      );
    }

    // Le fil AVANT le clic : si le texte approuvé y figure déjà, ce n'est pas
    // notre message qui le prouvera.
    const beforeObservation = await this.observeThread(composer, body, normalized, null, null, anchorRect);
    const before = beforeObservation.adjudication;

    // `pressSequentially` et non `fill`, et c'est le premier canari réel qui l'a
    // montré : `fill` écrit dans le DOM sans produire les événements clavier que
    // l'application attend. Le texte se lisait donc bien à la relecture, mais
    // Instagram ne le « voyait » pas — et son bouton d'envoi n'apparaissait
    // jamais. Le rail s'est arrêté là, sans rien envoyer, ce qui est le bon
    // comportement ; mais la cause était une saisie qui n'en était pas une.
    //
    // Ce n'est pas une imitation d'humain (interdit §12) : `delay: 0`, aucun
    // aléa, aucune pause. C'est la seule façon de remplir un champ que
    // l'application contrôle.
    await composer.pressSequentially(body, { delay: 0 }).catch(() => undefined);
    const typed = await this.readComposer(composer);
    const expected = body.replace(/\s+/g, ' ').trim();
    if (typed !== expected) {
      // Le composeur est vidé : ne rien laisser derrière soi quand on renonce.
      await composer.fill('').catch(() => undefined);
      return abort(
        'IG_SEND_PAYLOAD_NOT_ENTERED',
        `le composeur porte ${typed.length} caractère(s) au lieu des ${expected.length} approuvés — rien n’a été envoyé`,
        inThread.state,
      );
    }

    const sendControl = await this.firstVisibleInPanel(page, composer, SEND_CONTROL_SELECTORS, CONTROL_TIMEOUT_MS);
    if (sendControl === null) {
      // Diagnostiquer AVANT de vider : ce qu'on cherche à comprendre n'existe
      // qu'avec le texte saisi. La capture et l'inventaire des contrôles
      // visibles du panneau sont pris ici, puis le composeur est vidé — on ne
      // laisse jamais un brouillon derrière soi, même pour enquêter.
      const evidence = await this.capture(page, `${normalized}-no-send-control`);
      const controls = await this.describePanelControls(composer);
      await composer.fill('').catch(() => undefined);
      return buildAbort(
        'IG_SEND_CONTROL_NOT_FOUND',
        'aucun contrôle d’envoi identifiable DANS le panneau vérifié — il n’y a rien à cliquer, ' +
          'et cliquer un « Envoyer » trouvé ailleurs sur la page serait cliquer autre chose. ' +
          `Contrôles visibles du panneau : ${controls.join(' | ') || 'aucun'}`,
        inThread.state,
        evidence,
      );
    }

    // ---- 5 bis. IG2.5 — le brouillon CONSTATÉ, sans clic -------------------
    //
    // Même code que l'envoi jusqu'ici : même ouverture, même identité, même
    // saisie, même recherche du contrôle. Ce qui suit ne clique pas, mesure
    // l'état réel du composeur et du bouton, puis efface le brouillon.
    if (input.stopAfter === 'draft') {
      const enabled = await this.isSendControlEnabled(sendControl);
      const descriptor = await this.describeComposer(composer);
      const screenshotPath = await this.capture(page, `${normalized}-draft`);
      await composer.fill('').catch(() => undefined);
      const cleared = (await this.readComposer(composer)).length === 0;
      return Object.freeze({
        kind: 'DRAFT_READY' as const,
        detail:
          `brouillon saisi et constaté sans clic : ${typed.length} caractère(s) exacts, ` +
          `contrôle d’envoi ${enabled ? 'ACTIF' : 'présent mais inactif'}, ` +
          `composeur ${cleared ? 'vidé' : 'NON vidé'}. ${descriptor}`,
        sessionState: inThread.state,
        threadUrl,
        threadHandle,
        composerText: typed,
        payloadExact: typed === expected,
        sendControlPresent: true,
        sendControlEnabled: enabled,
        composerDescriptor: descriptor,
        composerCleared: cleared,
        screenshotPath,
      });
    }

    // ---- 6. §4 — le journal, PUIS le clic ----------------------------------
    // Si cette écriture échoue, l'exception remonte et le clic n'a pas lieu :
    // l'ordre n'est pas une convention, c'est le flot de contrôle.
    await input.onBeforeExternalEffect();

    await this.clickOnce(sendControl, 'send_message');

    // ---- 7. Observer, sans jamais rejouer ----------------------------------
    //
    // La boucle attend une preuve, elle ne provoque rien : ni second clic, ni
    // seconde saisie, ni rechargement. Elle s'arrête dès que l'observation
    // devient concluante — dans un sens OU dans l'autre : un échec de livraison
    // affiché est une conclusion, et l'attendre plus longtemps ne l'améliore pas.
    const deadline = Date.now() + OBSERVATION_TIMEOUT_MS;
    let composerCleared = (await this.readComposer(composer)).length === 0;
    let after = await this.observeThread(composer, body, normalized, composerCleared, before.bubbles.length, anchorRect);
    while (Date.now() < deadline && after.adjudication.verdict === 'AMBIGUOUS') {
      await page.waitForTimeout(OBSERVATION_POLL_MS);
      composerCleared = (await this.readComposer(composer)).length === 0;
      after = await this.observeThread(composer, body, normalized, composerCleared, before.bubbles.length, anchorRect);
    }

    const finalState = await this.classifyCurrentPage(context, page);
    const screenshotPath = await this.capture(page, `${normalized}-sent`);
    const verdict = after.adjudication;

    return Object.freeze({
      kind: 'ATTEMPTED' as const,
      observation: Object.freeze({
        threadUrl: page.url(),
        threadHandle: verdict.threadHandle,
        matchingBubblesBefore: before.bubbles.length,
        matchingBubblesAfter: verdict.bubbles.length,
        harvestReadableBefore: beforeObservation.harvest.readable,
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
          `clic unique effectué dans le fil ${threadUrl} ; ` +
          `${before.bubbles.length} → ${verdict.bubbles.length} occurrence(s) du texte approuvé, ` +
          `composeur ${composerCleared ? 'vidé' : 'non vidé'}, ` +
          `récolte ${after.harvest.readable ? 'lisible' : 'ILLISIBLE'}, ` +
          `verdict ${verdict.verdict}, état final ${finalState.state}`,
      }),
    });
  }
}

function buildAbort(
  code:
    | 'IG_SEND_SESSION_LOST'
    | 'IG_SEND_THREAD_IDENTITY_UNCONFIRMED'
    | 'IG_SEND_COMPOSER_NOT_FOUND'
    | 'IG_SEND_PAYLOAD_NOT_ENTERED'
    | 'IG_SEND_CONTROL_NOT_FOUND',
  detail: string,
  sessionState: InstagramSessionState,
  screenshotPath: string | null,
): InstagramSendResult {
  return Object.freeze({ kind: 'NOT_ATTEMPTED' as const, code, detail, sessionState, screenshotPath });
}
