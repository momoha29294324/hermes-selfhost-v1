import type { Locator, Page, BrowserContext } from 'playwright';
import { normalizeHandle, profileUrl } from '@/lib/instagram/identity';
import { COMPOSER_SELECTORS } from '@/lib/instagram/domSelectors';
import { normalizeMessageText } from '@/lib/instagram/deliveryProof';
import { readRelationship } from '@/lib/instagram/relationship';
import { readThreadHistory, type ThreadHistory } from '@/lib/instagram/replyHistory';
import {
  classifyThreadIdentity,
  decideThreadIdentity,
  displayNameForHandle,
  DIRECT_THREAD_IDENTITY_LIMITS,
  READ_THREAD_IDENTITY_IN_PAGE,
  UNREADABLE_THREAD_READ,
  type ThreadIdentityObservation,
  type ThreadIdentityVerdict,
} from '@/lib/instagram/threadIdentity';
import { harvestThread, type ThreadHarvest } from '@/lib/instagram/threadHarvest';
import { PlaywrightInstagramRail } from '@/lib/instagram/playwrightRail';
import { classifyLiveDmRequest, isAllowedReplyNavigation, type GuardDecision } from '@/lib/instagram/readOnlyGuard';
import { RefusalTrace, type RefusalTraceSnapshot, type RefusedRequest } from '@/lib/instagram/refusalTrace';
import { InstagramRailError } from '@/lib/instagram/rail';
import { isThreadId, threadUrlOf } from '@/lib/instagram/replyRail';
import {
  classifyAccountIdentity,
  classifyThreadIdentityOutcome,
  describeThreadNavigation,
  firstTargetingRefusal,
  type AccountIdentityFinding,
  type ComposerFinding,
  type InstagramThreadInspectionRail,
  type LatestMessageFinding,
  type ThreadHistoryFinding,
  type ThreadIdentityFinding,
  type ThreadInspection,
  type ThreadInspectionInput,
  type ThreadInspectionTarget,
  type ThreadNavigationFinding,
} from '@/lib/instagram/threadInspectionRail';
import { isUsableSessionState, type InstagramSessionState } from '@/lib/instagram/types';

/**
 * HERMES-REAL-THREAD-PREVIEW-R1 §2/§4/§5/§6/§10 — le CIBLAGE d'un fil
 * Instagram, exercé en lecture seule, et la classe dont le rail d'envoi hérite.
 *
 * ---------------------------------------------------------------------------
 * Le sens de l'héritage, et pourquoi il va dans ce sens-là
 * ---------------------------------------------------------------------------
 * `PlaywrightInstagramReplyRail extends PlaywrightInstagramThreadInspectionRail`.
 * Pas l'inverse, et pas deux frères.
 *
 *   * **pas l'inverse** — un rail d'inspection qui hériterait du rail d'envoi
 *     porterait `sendThreadReply`. Toute la valeur du contrat d'inspection
 *     serait perdue au premier `instanceof` ;
 *   * **pas deux frères** — deux implémentations parallèles du même parcours
 *     dériveraient, et ce round validerait alors une COPIE du ciblage plutôt
 *     que le ciblage. La mission demande de lever un risque sur
 *     `sendThreadReply` : le seul moyen honnête est que les deux exécutent
 *     littéralement les mêmes lignes.
 *
 * Chaque étape du parcours est donc une méthode `protected` de CETTE classe, et
 * les deux appelants ne diffèrent que par leur composition :
 *
 *   * `inspectThread` les enchaîne toutes et RAPPORTE, y compris ce qui a
 *     échoué — c'est un diagnostic, et un diagnostic qui s'arrête au premier
 *     refus n'apprend qu'une chose sur cinq ;
 *   * `sendThreadReply` s'arrête au PREMIER refus, exactement comme avant.
 *
 * `firstTargetingRefusal` rejoue cet ordre en code pur, si bien qu'un
 * diagnostic nomme toujours la même porte que celle où la primitive se serait
 * arrêtée.
 *
 * ---------------------------------------------------------------------------
 * Ce que cette classe ne sait pas faire
 * ---------------------------------------------------------------------------
 * Aucun `click`, `fill`, `type`, `press`, `pressSequentially`, `tap`,
 * `selectOption`, `setInputFiles` — un test le vérifie par `grep` sur le
 * fichier, comme pour le rail de lecture. Elle n'importe pas non plus
 * `SEND_CONTROL_SELECTORS` : localiser le contrôle d'envoi n'est pas un effet,
 * mais c'est le seul groupe de sélecteurs dont un clic en produit un, et il n'a
 * rien à faire dans un module qui ne clique pas.
 *
 * Le seul geste posé sur une page reste `goto`, borné par
 * `isAllowedReplyNavigation` — la liste blanche la plus étroite du dépôt, qui
 * ne connaît ni `/direct/new/` ni la boîte de réception.
 */

/** Bornes d'attente, courtes et nommées. Aucune n'est une boucle de retry. */
export const INSPECTION_COMPOSER_TIMEOUT_MS = 15_000;
/** Le temps laissé au fil pour peindre son historique après la navigation. */
export const INSPECTION_THREAD_SETTLE_MS = 2_500;
const POLL_MS = 500;

/** Ce qu'une étape de navigation a établi, avant tout jugement. */
export interface ReachedThreadStage {
  readonly navigation: ThreadNavigationFinding;
  readonly sessionState: InstagramSessionState;
  readonly sessionDetail: string;
}

export class PlaywrightInstagramThreadInspectionRail
  extends PlaywrightInstagramRail
  implements InstagramThreadInspectionRail
{
  /** Ce que NOTRE garde réseau a refusé pendant le parcours, rangé par distance à l'effet. */
  protected readonly trace = new RefusalTrace();

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

  /**
   * La liste blanche de navigation, partagée avec le rail de réponse.
   *
   * Plus étroite que celle du canari : `/direct/new/` n'y est pas. Un rail qui
   * inspecte n'a aucune raison de savoir atteindre « nouveau message », et un
   * rail qui répond non plus.
   */
  protected override isNavigable(url: string): boolean {
    return isAllowedReplyNavigation(url);
  }

  // -------------------------------------------------------------------------
  // Lectures élémentaires, partagées avec le rail de réponse
  // -------------------------------------------------------------------------

  /** Le premier sélecteur qui rend un élément visible. `null` si aucun — jamais un repli. */
  protected async firstVisible(page: Page, selectors: readonly string[], timeoutMs: number): Promise<Locator | null> {
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
   * Ce que l'en-tête du fil laisse lire. La page MESURE, le code pur DÉCIDE.
   *
   * `DIRECT_THREAD_IDENTITY_LIMITS` et non `THREAD_IDENTITY_LIMITS` : sur
   * `/direct/t/<id>/`, le panneau de discussion occupe TOUTE la hauteur de la
   * fenêtre, et le plafond de 95 % du jeu par défaut rejetait le vrai panneau.
   * Voir l'en-tête de ces bornes pour la mesure qui l'a établi, et pour
   * pourquoi ce n'est pas un desserrement.
   *
   * Le droit de s'en servir est CONDITIONNÉ, et la condition est vérifiée par
   * `stageThreadIdentity` juste avant l'appel.
   */
  protected async readThreadIdentity(composer: Locator): Promise<ThreadIdentityObservation> {
    const raw = await composer
      .evaluate(READ_THREAD_IDENTITY_IN_PAGE, DIRECT_THREAD_IDENTITY_LIMITS)
      .catch(() => UNREADABLE_THREAD_READ);
    return classifyThreadIdentity(raw, DIRECT_THREAD_IDENTITY_LIMITS);
  }

  /** Le contenu réel du composeur, pour vérifier une saisie plutôt que l'espérer. */
  protected async readComposer(composer: Locator): Promise<string> {
    const text = await composer
      .evaluate((node: Element) => {
        if (node instanceof HTMLTextAreaElement) return node.value;
        return (node as HTMLElement).innerText ?? '';
      })
      .catch(() => '');
    return text.replace(/\s+/g, ' ').trim();
  }

  /** Ce que le composeur déclare de lui-même : sa nature et son focus. */
  protected async describeComposer(composer: Locator): Promise<string> {
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

  /**
   * Le composeur accepte-t-il une saisie, sans lui en envoyer une ?
   *
   * Quatre attributs relus, aucun geste : `contenteditable`, `disabled`,
   * `readonly`, `aria-disabled`. §10 l'exige en toutes lettres — un focus ou
   * une frappe « juste pour voir » sont exactement ce qu'un aperçu ne fait pas,
   * puisque dans ce composeur « Entrée » envoie.
   *
   * Une lecture impossible rend `false` : « je n'ai pas pu lire » n'est pas
   * « c'est actif ».
   */
  protected async isComposerEnabled(composer: Locator): Promise<boolean> {
    return composer
      .evaluate((node: Element) => {
        const el = node as HTMLElement;
        if (el.getAttribute('aria-disabled') === 'true') return false;
        if (el.hasAttribute('readonly')) return false;
        if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly;
        return el.getAttribute('contenteditable') === 'true';
      })
      .catch(() => false);
  }

  /** Le nom d'affichage du handle attendu, relu sur SA page de profil. */
  protected async readExpectedDisplayName(page: Page, expected: string): Promise<string | null> {
    const ogTitle = await page
      .getAttribute('meta[property="og:title"]', 'content', { timeout: 3_000 })
      .catch(() => null);
    const fromOg = displayNameForHandle(ogTitle, expected);
    if (fromOg !== null) return fromOg;
    const title = await page.title().catch(() => null);
    return displayNameForHandle(title, expected);
  }

  /**
   * L'identifiant de fil réellement atteint, relu dans l'URL de la page.
   *
   * `null` quand l'URL n'est pas celle d'un fil : une redirection vers la boîte
   * de réception, une page d'erreur, un fil supprimé. `null` n'est jamais
   * traité comme « c'est le bon ».
   */
  protected static observedThreadId(rawUrl: string): string | null {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return null;
    }
    const match = /^\/direct\/t\/(\d{1,40})\/?$/.exec(url.pathname);
    return match?.[1] ?? null;
  }

  // -------------------------------------------------------------------------
  // Les étapes du parcours — chacune une lecture, toutes partagées
  // -------------------------------------------------------------------------

  /**
   * §4 — sous quel compte cette session est-elle ouverte ?
   *
   * La question n'a l'air de rien et elle est le socle du reste : un fil
   * `/direct/t/<id>/` n'a de sens que pour le compte qui le possède. Si la
   * session avait basculé, l'identifiant désignerait autre chose — ou rien.
   *
   * « Modifier le profil » ne s'affiche que chez soi (`relationship.ts`), et
   * c'est la seule preuve accessible sans lire un cookie — lire un cookie est
   * interdit, et un avatar ou un nom affiché ne prouvent rien.
   */
  protected async stageAccountIdentity(
    context: BrowserContext,
    page: Page,
    account: string,
  ): Promise<{ readonly finding: AccountIdentityFinding; readonly state: InstagramSessionState }> {
    await this.navigate(page, profileUrl(account));
    const classified = await this.classifyCurrentPage(context, page);
    if (!isUsableSessionState(classified.state)) {
      return {
        state: classified.state,
        finding: Object.freeze({
          outcome: 'UNKNOWN' as const,
          expectedAccountHandle: account,
          labels: Object.freeze([]),
          detail: `la page du compte émetteur rend un état ${classified.state} — ${classified.detail}`,
        }),
      };
    }
    // Avant de conclure quoi que ce soit d'un en-tête muet : la page dit-elle
    // que ce profil n'existe pas ?
    //
    // Découvert le 22 août 2026 sur la première inspection réelle. Le handle
    // enregistré sur les messages (`r6b_inbound_messages.mailbox`) rendait
    // « Cette page n’est malheureusement pas disponible » : aucun `<header>`,
    // donc aucun libellé, donc `isOwnProfile === null`, donc `UNKNOWN`, donc
    // — via `firstTargetingRefusal` — un `IG_REPLY_SESSION_LOST` TEMPORAIRE.
    // C'est-à-dire un plan qui repart toutes les cinq minutes pour toujours,
    // sur un diagnostic qui accuse la session alors qu'elle est parfaitement
    // valide et qu'un compte a simplement changé de nom.
    //
    // Un profil absent est un fait permanent qui demande un humain, pas une
    // panne qui passera : il rend `MISMATCH`, donc un refus définitif.
    if (await this.isProfileMissing(page)) {
      return {
        state: classified.state,
        finding: Object.freeze({
          outcome: 'MISMATCH' as const,
          expectedAccountHandle: account,
          labels: Object.freeze([]),
          detail:
            `la page de « ${account} » annonce qu’elle n’est pas disponible — ce handle ne désigne aucun ` +
            'profil, donc la session ne peut pas être ouverte sous lui. Un compte renommé, ou une valeur ' +
            'périmée : cela se corrige à la main, pas en réessayant',
        }),
      };
    }

    const own = await readRelationship(page);
    const outcome = classifyAccountIdentity(own.isOwnProfile);
    const detail =
      outcome === 'MATCH'
        ? `« Modifier le profil » lu sur la page de « ${account} » — la session est bien ouverte sous ce compte`
        : outcome === 'MISMATCH'
          ? `la page de « ${account} » propose des actions de relation (${own.labels.slice(0, 4).join(', ')}) — ` +
            'ce navigateur n’est donc PAS connecté sous ce compte, et le fil visé ne lui appartient pas'
          : `l’en-tête de « ${account} » n’a rien laissé conclure (${own.detail}) — sans savoir sous quel ` +
            'compte la session est ouverte, l’identifiant du fil ne désigne rien de sûr';
    return {
      state: classified.state,
      finding: Object.freeze({
        outcome,
        expectedAccountHandle: account,
        labels: Object.freeze([...own.labels]),
        detail,
      }),
    };
  }

  /**
   * Le nom d'affichage du correspondant, relu CHEZ LUI.
   *
   * Une LECTURE, et rien d'autre : pas de bouton cherché, pas de composeur
   * ouvert, aucun clic. Elle existe parce que `decideThreadIdentity` n'accepte
   * la preuve faible — un en-tête qui affiche un nom sans handle — que
   * CORROBORÉE par ce que le compte déclare lui-même.
   */
  protected async stageCounterpartyDisplayName(
    context: BrowserContext,
    page: Page,
    counterparty: string,
  ): Promise<{ readonly displayName: string | null; readonly state: InstagramSessionState }> {
    await this.navigate(page, profileUrl(counterparty));
    const classified = await this.classifyCurrentPage(context, page);
    if (!isUsableSessionState(classified.state)) {
      return { displayName: null, state: classified.state };
    }
    return { displayName: await this.readExpectedDisplayName(page, counterparty), state: classified.state };
  }

  /**
   * §5 — le fil, par son IDENTIFIANT, et la concordance relue dans l'URL
   * atteinte.
   *
   * Aucun repli : ni « le premier fil visible », ni un nom approchant, ni une
   * recherche textuelle, ni l'ordre d'affichage. L'appelant ne passe pas
   * d'URL — le rail la construit à partir de l'identifiant.
   */
  protected async stageReachThread(
    context: BrowserContext,
    page: Page,
    threadId: string,
  ): Promise<ReachedThreadStage> {
    const requestedUrl = threadUrlOf(threadId);
    await this.navigate(page, requestedUrl);
    await page.waitForTimeout(INSPECTION_THREAD_SETTLE_MS);
    const classified = await this.classifyCurrentPage(context, page);
    if (!isUsableSessionState(classified.state)) {
      return {
        sessionState: classified.state,
        sessionDetail: classified.detail,
        navigation: describeThreadNavigation({
          requestedThreadId: threadId,
          requestedUrl,
          landedUrl: null,
          threadIdFromUrl: null,
        }),
      };
    }
    const landedUrl = page.url();
    return {
      sessionState: classified.state,
      sessionDetail: classified.detail,
      navigation: describeThreadNavigation({
        requestedThreadId: threadId,
        requestedUrl,
        landedUrl,
        threadIdFromUrl: PlaywrightInstagramThreadInspectionRail.observedThreadId(landedUrl),
      }),
    };
  }

  /** Le composeur du fil — point d'ancrage de l'en-tête et de la récolte. */
  protected async stageComposer(page: Page): Promise<Locator | null> {
    return this.firstVisible(page, COMPOSER_SELECTORS, INSPECTION_COMPOSER_TIMEOUT_MS);
  }

  /**
   * §7/§11 — l'identité du fil, décidée par `decideThreadIdentity` sur ce que
   * la page a mesuré.
   *
   * Le verdict d'autorisation est celui de la fonction pure existante, sans
   * aménagement. Ce qui est ajouté ici est le CLASSEMENT du refus
   * (`MISMATCH` / `UNKNOWN`), qui n'autorise rien et sert à savoir quoi
   * corriger — un sélecteur, ou une cible.
   */
  protected async stageThreadIdentity(
    composer: Locator,
    counterparty: string,
    expectedDisplayName: string | null,
    navigation: ThreadNavigationFinding,
  ): Promise<{
    readonly finding: ThreadIdentityFinding;
    readonly observation: ThreadIdentityObservation;
    readonly verdict: ThreadIdentityVerdict;
  }> {
    // La condition qui autorise `DIRECT_THREAD_IDENTITY_LIMITS`, relue à
    // l'exécution plutôt que confiée à l'ordre des appels : ces bornes admettent
    // un panneau pleine hauteur, ce qui n'est correct QUE sur une page de fil.
    // Un appelant qui les emploierait sur une page de profil lirait l'en-tête du
    // profil affiché et le prendrait pour celui d'une conversation.
    if (!navigation.match) {
      throw new InstagramRailError(
        'IG_RAIL_ERROR',
        'lecture d’identité demandée sans fil vérifié — l’en-tête ne se lit que sur une URL ' +
          '/direct/t/<id>/ dont l’identifiant a été relu et concorde',
      );
    }
    const observation = await this.readThreadIdentity(composer);
    const verdict = decideThreadIdentity({ observation, expectedHandle: counterparty, expectedDisplayName });
    const outcome = classifyThreadIdentityOutcome(observation, verdict, counterparty);
    return {
      observation,
      verdict,
      finding: Object.freeze({
        outcome,
        via: verdict.ok ? verdict.via : null,
        expectedHandle: counterparty,
        expectedDisplayNameResolved: expectedDisplayName !== null,
        panelFound: observation.panelFound,
        panelAmbiguous: observation.panelAmbiguous,
        headerFound: observation.headerFound,
        headerHandleCount: observation.headerHandles.length,
        headerTextCount: observation.headerTexts.length,
        panelLabelPresent: observation.panelLabel !== null,
        bodyHandleCount: observation.bodyHandles.length,
        ancestorChain: observation.ancestorChain,
        detail: verdict.detail,
      }),
    };
  }

  /**
   * §8 — le fil a-t-il un PASSÉ ?
   *
   * La garde qui empêche la primitive de réponse d'être un premier contact.
   * Elle s'appuie sur `readThreadHistory`, code pur, sur une récolte prise
   * AVANT toute saisie — ici il n'y en aura aucune, ce qui rend la mesure
   * d'autant plus lisible : ce qui est compté ne peut venir que du fil.
   */
  protected async stageHistory(composer: Locator): Promise<{
    readonly finding: ThreadHistoryFinding;
    readonly harvest: ThreadHarvest;
    readonly history: ThreadHistory;
  }> {
    // `harvestThread` rend déjà `UNREADABLE_HARVEST` sur échec : « je n'ai pas pu
    // lire » y est une valeur, jamais une exception.
    const harvest = await harvestThread(composer);
    const history = readThreadHistory(harvest);
    return {
      harvest,
      history,
      finding: Object.freeze({
        verdict: history.verdict,
        textNodes: history.textNodes,
        harvestReadable: harvest.readable,
        harvestTruncated: harvest.truncated,
        detail: history.detail,
      }),
    };
  }

  /**
   * §9 — la page corrobore-t-elle le dernier message que la base connaît ?
   *
   * Code pur volontairement pauvre : une égalité de textes normalisés sur un
   * élément porteur de texte hors composeur. Ce qu'il répond est « la page
   * porte bien ce que la base a enregistré », et rien de plus.
   *
   * Ce qu'il ne fait PAS, et ne fera pas : lire un horodatage d'interface pour
   * en déduire une fraîcheur. Instagram écrit « 20 min », localisé et arrondi ;
   * la marque métier reste `r6b_inbound_messages.received_at`, et une preuve
   * plus faible ne remplace pas une preuve plus forte.
   */
  protected static latestMessageFinding(
    harvest: ThreadHarvest,
    latestInbound: ThreadInspectionInput['latestInbound'],
  ): LatestMessageFinding {
    if (latestInbound === null) {
      return Object.freeze({
        watermark: null,
        matched: null,
        detail: 'aucune marque de fraîcheur fournie — rien à confronter',
      });
    }
    const expected = latestInbound.bodyText === null ? '' : normalizeMessageText(latestInbound.bodyText);
    if (!harvest.readable) {
      return Object.freeze({
        watermark: latestInbound.receivedAt,
        matched: null,
        detail: 'la récolte du fil n’a pas pu s’exécuter — la page ne corrobore ni n’infirme la base',
      });
    }
    if (expected.length === 0) {
      return Object.freeze({
        watermark: latestInbound.receivedAt,
        matched: null,
        detail: 'la base ne porte aucun texte pour le dernier message reçu — rien à confronter',
      });
    }
    let matches = 0;
    for (const node of harvest.nodes) {
      if (node.level < 0) continue;
      if (!node.visible) continue;
      if (normalizeMessageText(node.text) === expected) matches += 1;
    }
    return Object.freeze({
      watermark: latestInbound.receivedAt,
      matched: matches > 0,
      detail:
        matches > 0
          ? `${String(matches)} élément(s) du fil portent exactement le dernier message enregistré ` +
            `(reçu ${latestInbound.receivedAt}) — la page corrobore la base`
          : `aucun élément du fil ne porte exactement le dernier message enregistré (reçu ` +
            `${latestInbound.receivedAt}) — récolte ${harvest.truncated ? 'TRONQUÉE' : 'complète'}, ` +
            'la page ne corrobore pas la base',
    });
  }

  // -------------------------------------------------------------------------
  // L'entrée publique — lecture seule, du premier `goto` au dernier constat
  // -------------------------------------------------------------------------

  /**
   * Ouvre un fil existant, confronte tout ce que `sendThreadReply` confronte,
   * et rend un diagnostic. Aucune saisie, aucun clic, aucune écriture.
   *
   * Contrairement à la primitive de réponse, elle n'abandonne pas au premier
   * refus : elle poursuit tant qu'une étape reste LISIBLE, parce que le but est
   * d'apprendre ce que la vraie interface expose. Ce qui aurait arrêté la
   * primitive est rendu à part (`blockedBy`), calculé par la fonction pure qui
   * rejoue son ordre.
   */
  async inspectThread(input: ThreadInspectionInput): Promise<ThreadInspection> {
    const started = Date.now();
    const target = PlaywrightInstagramThreadInspectionRail.validateTarget(input.target);
    const { account, counterparty } = target;

    this.log.info('instagram.thread_inspect.begin', {
      threadId: target.expectedThreadId,
      account,
    });

    const { context, page } = await this.open();
    const diagnostics: string[] = [];

    // ---- 1. Sous quel compte cette session est-elle ouverte ? --------------
    const accountStage = await this.stageAccountIdentity(context, page, account);
    diagnostics.push(`compte : ${accountStage.finding.outcome} — ${accountStage.finding.detail}`);

    // ---- 2. Le nom d'affichage du correspondant, relu chez lui -------------
    const displayStage = isUsableSessionState(accountStage.state)
      ? await this.stageCounterpartyDisplayName(context, page, counterparty)
      : { displayName: null, state: accountStage.state };
    diagnostics.push(
      `nom d’affichage de « ${counterparty} » : ` +
        (displayStage.displayName === null ? 'non établi' : 'établi sur sa page de profil'),
    );

    // ---- 3. Le fil, par son identifiant ------------------------------------
    const reached = isUsableSessionState(displayStage.state)
      ? await this.stageReachThread(context, page, target.expectedThreadId)
      : {
          sessionState: displayStage.state,
          sessionDetail: 'session inutilisable avant la navigation vers le fil',
          navigation: describeThreadNavigation({
            requestedThreadId: target.expectedThreadId,
            requestedUrl: threadUrlOf(target.expectedThreadId),
            landedUrl: null,
            threadIdFromUrl: null,
          }),
        };
    diagnostics.push(`navigation : ${reached.navigation.detail}`);

    // ---- 4/5/6. Composeur, identité du fil, historique ---------------------
    //
    // Les trois s'ancrent sur le composeur, et aucun n'est lu si l'URL atteinte
    // n'est pas celle du fil demandé : mesurer une page qu'on n'a pas demandée
    // ne dit rien du fil qu'on visait, et le décrire comme s'il s'agissait de
    // lui serait la pire des sorties.
    let composerFinding: ComposerFinding = Object.freeze({
      found: false,
      enabled: false,
      descriptor: null,
      detail: 'composeur non cherché — le fil demandé n’a pas été atteint',
    });
    let identityFinding: ThreadIdentityFinding = Object.freeze({
      outcome: 'UNKNOWN' as const,
      via: null,
      expectedHandle: counterparty,
      expectedDisplayNameResolved: displayStage.displayName !== null,
      panelFound: false,
      panelAmbiguous: false,
      headerFound: false,
      headerHandleCount: 0,
      headerTextCount: 0,
      panelLabelPresent: false,
      bodyHandleCount: 0,
      ancestorChain: Object.freeze([]),
      detail: 'en-tête non lu — le fil demandé n’a pas été atteint, ou il n’a pas de composeur',
    });
    let historyFinding: ThreadHistoryFinding = Object.freeze({
      verdict: 'UNREADABLE' as const,
      textNodes: 0,
      harvestReadable: false,
      harvestTruncated: false,
      detail: 'historique non récolté — le fil demandé n’a pas été atteint, ou il n’a pas de composeur',
    });
    let latestFinding: LatestMessageFinding = Object.freeze({
      watermark: input.latestInbound?.receivedAt ?? null,
      matched: null,
      detail: 'fil non récolté — rien à confronter',
    });

    if (reached.navigation.match) {
      const composer = await this.stageComposer(page);
      if (composer === null) {
        composerFinding = Object.freeze({
          found: false,
          enabled: false,
          descriptor: null,
          detail: 'aucun champ de saisie visible dans le fil — `sendThreadReply` s’arrêterait ici',
        });
      } else {
        const enabled = await this.isComposerEnabled(composer);
        const descriptor = await this.describeComposer(composer);
        composerFinding = Object.freeze({
          found: true,
          enabled,
          descriptor,
          detail: `composeur ${enabled ? 'éditable' : 'présent mais NON éditable'} — ${descriptor}. ` +
            'Aucune saisie, aucun focus provoqué.',
        });

        const identity = await this.stageThreadIdentity(
          composer,
          counterparty,
          displayStage.displayName,
          reached.navigation,
        );
        identityFinding = identity.finding;
        diagnostics.push(...identity.observation.diagnostics.slice(0, 12));

        const history = await this.stageHistory(composer);
        historyFinding = history.finding;
        latestFinding = PlaywrightInstagramThreadInspectionRail.latestMessageFinding(
          history.harvest,
          input.latestInbound,
        );
      }
    }

    diagnostics.push(`composeur : ${composerFinding.detail}`);
    diagnostics.push(`identité du fil : ${identityFinding.outcome} — ${identityFinding.detail}`);
    diagnostics.push(`historique : ${historyFinding.verdict} — ${historyFinding.detail}`);
    diagnostics.push(`dernier message : ${latestFinding.detail}`);

    const sessionUsable = isUsableSessionState(reached.sessionState);
    const blockedBy = firstTargetingRefusal({
      sessionUsable,
      account: accountStage.finding.outcome,
      navigationMatch: reached.navigation.match,
      composerFound: composerFinding.found,
      threadIdentity: identityFinding.outcome,
      history: historyFinding.verdict,
    });

    const screenshotPath = await this.capture(page, `${counterparty}-thread-inspect`);

    this.log.info('instagram.thread_inspect.done', {
      threadId: target.expectedThreadId,
      account: accountStage.finding.outcome,
      navigation: reached.navigation.match,
      threadIdentity: identityFinding.outcome,
      history: historyFinding.verdict,
      composerFound: composerFinding.found,
      blockedBy,
    });

    return Object.freeze({
      target: input.target,
      sessionState: reached.sessionState,
      account: accountStage.finding,
      navigation: reached.navigation,
      threadIdentity: identityFinding,
      history: historyFinding,
      composer: composerFinding,
      latestMessage: latestFinding,
      targetingCompatible: blockedBy === null,
      blockedBy,
      externalEffect: false as const,
      diagnostics: Object.freeze(diagnostics),
      screenshotPath,
      durationMs: Date.now() - started,
    });
  }

  /**
   * Ce que l'appelant a demandé est-il seulement formulable ?
   *
   * Les mêmes quatre refus que `sendThreadReply`, au même endroit du parcours —
   * avant d'ouvrir quoi que ce soit. Partagés pour que l'inspection ne puisse
   * pas accepter une cible que l'envoi rejetterait : ce serait valider un
   * ciblage que la primitive n'accepte pas.
   */
  protected static validateTarget(target: ThreadInspectionTarget): {
    readonly account: string;
    readonly counterparty: string;
    readonly expectedThreadId: string;
  } {
    const counterparty = normalizeHandle(target.expectedHandle);
    if (counterparty === null) {
      throw new InstagramRailError('IG_RAIL_ERROR', `handle Instagram invalide : « ${target.expectedHandle} »`);
    }
    const account = normalizeHandle(target.expectedAccountHandle);
    if (account === null) {
      throw new InstagramRailError(
        'IG_RAIL_ERROR',
        `handle de compte émetteur invalide : « ${target.expectedAccountHandle} »`,
      );
    }
    if (!isThreadId(target.expectedThreadId)) {
      throw new InstagramRailError(
        'IG_RAIL_ERROR',
        `identifiant de fil invalide : « ${target.expectedThreadId} » — un fil se désigne par les chiffres ` +
          'qu’Instagram lui a donnés, jamais par un nom ni par une URL reçue',
      );
    }
    if (account === counterparty) {
      throw new InstagramRailError(
        'IG_RAIL_ERROR',
        'le compte émetteur et le correspondant sont le même handle — un fil avec soi-même ne prouve rien',
      );
    }
    return { account, counterparty, expectedThreadId: target.expectedThreadId };
  }
}
