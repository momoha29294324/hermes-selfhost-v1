import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BrowserContext, Page, Response, Route } from 'playwright';
import { logger } from '@/lib/logging/logger';
import { normalizeHandle, profileUrl } from '@/lib/instagram/identity';
import { classifyObserverRequest, isAllowedObserverNavigation } from '@/lib/instagram/observerGuard';
import { assertObserverProfileIsolated, type ObserverIsolationVerdict } from '@/lib/instagram/observerProfile';
import {
  acquireInstagramBrowserLease,
  InstagramBrowserProfileBusyError,
  type InstagramBrowserLease,
} from '@/lib/instagram/browserProfileLease';
import { resolveOperaGxExecutablePath } from '@/lib/instagram/operaGxBrowser';
import { checkIdentity, classifyObservationState, type PageSignals } from '@/lib/instagram/observerState';
import { readOgDescriptionCounts, readPosts, readProfileFacts } from '@/lib/instagram/profilePayload';
import {
  assertNoActionPrimitives,
  type InstagramProfileObserver,
  type ObserveTarget,
} from '@/lib/instagram/profileObserver';
import type { InstagramObserverConfig } from '@/lib/config/schema';
import type {
  ObservedPost,
  ProfileFacts,
  ProfileObservation,
  ScreenshotRef,
} from '@/lib/pipeline/instagramObservation';

/**
 * R7.3C §4–§8 — l'observateur Playwright : il ouvre, il regarde, il ferme.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce fichier ne contient pas, et qu'un `grep` confirme
 * ---------------------------------------------------------------------------
 * Aucun `click`, aucun `fill`, aucun `type`, aucun `press`, aucun `hover`,
 * aucun `scroll`. Le seul geste posé sur une page est `goto`, vers une URL que
 * `isAllowedObserverNavigation` accepte — c'est-à-dire une page de profil, et
 * rien d'autre.
 *
 * L'absence de défilement n'est pas un oubli : faire défiler une grille charge
 * des publications supplémentaires, donc produit des impressions que personne
 * n'a demandées. On lit ce que la page a chargé d'elle-même. Si cela ne suffit
 * pas à estimer une cadence, la réponse est `UNKNOWN` — pas un défilement.
 *
 * ---------------------------------------------------------------------------
 * La collecte est PASSIVE
 * ---------------------------------------------------------------------------
 * Le rail n'appelle aucun point d'entrée d'Instagram. Il écoute les réponses que
 * la page émet pendant son propre chargement (`page.on('response')`) et tente d'y
 * lire un objet profil. C'est la différence entre observer un navigateur et
 * écrire un client d'API : le second demanderait des données, le premier regarde
 * celles qui passent.
 *
 * ---------------------------------------------------------------------------
 * Trois refus au démarrage
 * ---------------------------------------------------------------------------
 *   1. profil navigateur confondu avec celui du rail outbound → refus ;
 *   2. primitive d'action présente sur cette classe → refus ;
 *   3. requête d'effet, quelle qu'elle soit → abandonnée par la garde réseau.
 *
 * Les deux premiers lèvent avant qu'un navigateur ne s'ouvre. Le troisième
 * s'applique à du code que personne dans ce dépôt n'a écrit.
 */

const SESSION_COOKIE_NAMES: readonly string[] = ['sessionid', 'ds_user_id'];

const CAPTCHA_WIDGET_SELECTOR = [
  'iframe[src*="recaptcha" i]',
  'iframe[src*="arkoselabs" i]',
  'iframe[src*="funcaptcha" i]',
  'iframe[src*="hcaptcha" i]',
  'iframe[title*="captcha" i]',
].join(', ');

/** Les réponses susceptibles de porter un objet profil. Écoutées, jamais demandées. */
/**
 * Le nom d'utilisateur porté par une URL de profil, ou `null`.
 *
 * `null` sur tout ce qui n'est pas une page de profil — une page de connexion,
 * un challenge, une racine. L'appelant retombe alors sur le handle demandé, ce
 * qui ne fabrique aucune donnée : sans profil rendu, il n'y a rien à attribuer.
 */
export function usernameFromProfileUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const match = /^\/([A-Za-z0-9._]{1,30})\/?$/.exec(url.pathname);
  const candidate = match?.[1];
  if (candidate === undefined) return null;
  const reserved = ['accounts', 'explore', 'direct', 'stories', 'reels', 'p', 'challenge'];
  return reserved.includes(candidate.toLowerCase()) ? null : candidate;
}

function looksLikeProfilePayload(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.includes('/api/v1/users/web_profile_info') ||
    lower.includes('/api/graphql') ||
    lower.includes('/graphql/query')
  );
}

interface PlaywrightModule {
  chromium: {
    launchPersistentContext(userDataDir: string, options: Record<string, unknown>): Promise<BrowserContext>;
  };
}

/**
 * Nombre de profils CONSÉCUTIFS à navigation interrompue à partir duquel on
 * conclut à un ralentissement imposé plutôt qu'à une panne.
 */
export const ABORT_MEANS_THROTTLED_AFTER = 2;

/** Notre navigation a été interrompue, après une reprise. */
class NavigationAbortedError extends Error {
  constructor(url: string) {
    super(`navigation interrompue deux fois vers « ${url} »`);
    this.name = 'NavigationAbortedError';
  }
}

/**
 * `ERR_ABORTED` — notre navigation a été REMPLACÉE ou coupée, pas refusée.
 *
 * À distinguer de `ERR_BLOCKED_BY_CLIENT`, qui est notre PROPRE garde réseau :
 * confondre les deux ferait passer un refus que nous avons décidé pour un signal
 * de la plateforme.
 */
/**
 * Le contexte ou le navigateur a disparu — une panne du RAIL, jamais une
 * observation.
 */
export function isBrowserGone(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('Target page, context or browser has been closed') ||
    message.includes('Target closed') ||
    message.includes('Browser has been closed')
  );
}

export function isNavigationAborted(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('ERR_ABORTED');
}

export class ObserverRailError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ObserverRailError';
  }
}

async function loadPlaywright(): Promise<PlaywrightModule> {
  try {
    return (await import('playwright')) as unknown as PlaywrightModule;
  } catch (error) {
    throw new ObserverRailError(
      'Playwright est introuvable — installer les dépendances puis « npx playwright install chromium »',
      { cause: error },
    );
  }
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

/**
 * Étalement DÉTERMINISTE, dérivé du handle.
 *
 * Même handle, même décalage, sur n'importe quelle machine — donc testable à la
 * milliseconde. Ce n'est pas une randomisation anti-détection : la mission
 * l'interdit, et un jitter aléatoire serait par ailleurs intestable. Il existe
 * pour étaler la charge, et le défaut de configuration peut le mettre à zéro.
 */
export function deterministicJitterMs(handle: string, maximumMs: number): number {
  if (maximumMs <= 0) return 0;
  const digest = createHash('sha256').update(handle).digest();
  const first = digest[0] ?? 0;
  const second = digest[1] ?? 0;
  return ((first << 8) | second) % (maximumMs + 1);
}

export interface ObserverOptions {
  readonly config: InstagramObserverConfig;
  /** Le profil du rail outbound, LU pour être refusé — jamais ouvert. */
  readonly outboundProfileDir: string;
  readonly runId: string;
  readonly headless?: boolean;
}

interface BlockedRequest {
  readonly rule: string;
  readonly path: string;
  readonly method: string;
}

export class PlaywrightInstagramProfileObserver implements InstagramProfileObserver {
  private readonly options: ObserverOptions;
  private readonly log: ReturnType<typeof logger.child>;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private lease: InstagramBrowserLease | null = null;
  private refusals: BlockedRequest[] = [];
  /** Lectures transportées en POST autorisées. Publiées comme preuve, pas comme succès d'écriture. */
  private graphqlReadCount = 0;
  /**
   * Profils CONSÉCUTIFS dont la navigation a été interrompue par la plateforme.
   *
   * Voir `ABORT_MEANS_THROTTLED_AFTER` : c'est ce compteur qui transforme une
   * panne isolée en signal d'arrêt.
   */
  private consecutiveNavigationAborts = 0;
  private readonly isolation: ObserverIsolationVerdict;

  constructor(options: ObserverOptions) {
    this.options = options;
    // Refus n° 1 : le profil navigateur. AVANT toute ouverture.
    this.isolation = assertObserverProfileIsolated(options.config.session.profileDir, options.outboundProfileDir);
    // Refus n° 2 : la surface de cette classe.
    assertNoActionPrimitives(this, 'PlaywrightInstagramProfileObserver');
    this.log = logger.child({ rail: 'r7-instagram-observer', runId: options.runId });
  }

  get isolationVerdict(): ObserverIsolationVerdict {
    return this.isolation;
  }

  get graphqlReads(): number {
    return this.graphqlReadCount;
  }

  private get headless(): boolean {
    return this.options.headless ?? this.options.config.session.headless;
  }

  private async open(): Promise<{ context: BrowserContext; page: Page }> {
    if (this.context !== null && this.page !== null) return { context: this.context, page: this.page };

    const { chromium } = await loadPlaywright();
    const userDataDir = resolve(process.cwd(), this.options.config.session.profileDir);
    ensureDir(userDataDir);

    // Le bail du profil, ici aussi.
    //
    // L'observer a son PROPRE profil (`var/r7/…`, imposé par le schéma et
    // revérifié par `assertObserverProfileIsolated`), donc il ne dispute rien
    // au rail sortant : son bail porte un autre chemin. Il est pris quand même,
    // et pour deux raisons. Un second observer lancé à la main ouvrirait sinon
    // le même profil que celui qui tourne. Et surtout, le bail est nommé
    // d'après le chemin RÉEL : si le profil de l'observer devenait un jour un
    // lien vers celui du rail — l'erreur exacte que l'en-tête de
    // `observerProfile.ts` décrit comme indétectable par comparaison de
    // chaînes — les deux baux deviendraient le même, et le second serait
    // refusé au lieu d'écraser une session.
    const lease = this.leaseProfile();

    // Échoue net (OPERA_GX_NOT_FOUND) plutôt que de retomber en silence sur le
    // Chromium livré avec Playwright — voir src/lib/instagram/operaGxBrowser.ts.
    // Résolu HORS du bloc try/catch qui suit : ce n'est pas un échec de
    // démarrage du navigateur, c'est l'absence du binaire lui-même, et les deux
    // erreurs ne doivent pas se confondre sous le même message générique.
    const executablePath = resolveOperaGxExecutablePath();

    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(userDataDir, {
        headless: this.headless,
        executablePath,
        locale: this.options.config.session.locale,
        timezoneId: this.options.config.session.timezoneId,
        viewport: {
          width: this.options.config.session.viewport.width,
          height: this.options.config.session.viewport.height,
        },
      });
    } catch (error) {
      lease.release();
      throw new ObserverRailError('le navigateur d’observation n’a pas pu démarrer', { cause: error });
    }
    this.lease = lease;

    context.setDefaultNavigationTimeout(this.options.config.session.navigationTimeoutMs);
    context.setDefaultTimeout(this.options.config.session.navigationTimeoutMs);

    // Refus n° 3 : la garde réseau, sur TOUT — y compris ce qu'aucune ligne de
    // ce dépôt n'a demandé. C'est précisément le but.
    await context.route('**/*', async (route: Route) => {
      const request = route.request();
      const decision = classifyObserverRequest({
        url: request.url(),
        method: request.method(),
        postData: request.postData(),
      });
      const method = request.method().toUpperCase();
      const path = (() => {
        try {
          return new URL(request.url()).pathname;
        } catch {
          return '<illisible>';
        }
      })();

      if (decision.allowed) {
        if (method !== 'GET' && method !== 'HEAD') this.graphqlReadCount += 1;
        await route.continue();
        return;
      }
      // Journalisé sans le corps : un corps GraphQL Instagram porte des jetons.
      this.refusals.push({ rule: decision.rule, path, method });
      this.log.warn('r7.observer.guard.blocked', { method, path, rule: decision.rule, reason: decision.reason });
      await route.abort('blockedbyclient');
    });

    const page = context.pages()[0] ?? (await context.newPage());
    this.context = context;
    this.page = page;
    return { context, page };
  }

  /** La session du profil DÉDIÉ est-elle authentifiée ? Seuls les NOMS sont regardés. */
  async hasDedicatedSession(): Promise<boolean> {
    const { context } = await this.open();
    const cookies = await context.cookies('https://www.instagram.com/');
    return cookies.some((cookie) => SESSION_COOKIE_NAMES.includes(cookie.name));
  }

  async observe(target: ObserveTarget): Promise<ProfileObservation> {
    const started = Date.now();
    const handle = normalizeHandle(target.expectedHandle);
    const observedAt = new Date().toISOString();
    this.refusals = [];

    if (handle === null) {
      return this.unreadable(target, observedAt, Date.now() - started, `handle invalide : « ${target.expectedHandle} »`);
    }

    const url = profileUrl(handle);
    if (!isAllowedObserverNavigation(url)) {
      return this.unreadable(target, observedAt, Date.now() - started, `navigation refusée vers « ${url} »`);
    }

    const { page } = await this.open();

    /**
     * Les charges utiles sont collectées PENDANT le chargement, par un écouteur
     * posé juste avant `goto` et retiré juste après. Le rail ne demande rien :
     * il regarde ce que la page demande d'elle-même.
     */
    const payloads: unknown[] = [];
    const onResponse = (response: Response): void => {
      if (!looksLikeProfilePayload(response.url())) return;
      void response
        .json()
        .then((body: unknown) => payloads.push(body))
        .catch(() => undefined);
    };
    page.on('response', onResponse);

    let httpStatus: number | null = null;
    try {
      /**
       * `ERR_ABORTED` n'est pas un refus : c'est notre navigation REMPLACÉE.
       *
       * Constaté au premier lancement du profil observer sous session : en
       * ouvrant `www.instagram.com`, Instagram déclenche sa propre redirection
       * de synchronisation de session, qui supplante la navigation en cours.
       * Playwright rend alors `net::ERR_ABORTED` — un profil parfaitement
       * lisible sort `UNREADABLE`, et la reprise au niveau de l'observation
       * (§31) échoue de la même façon puisqu'elle recommence au même point.
       *
       * La reprise est donc faite ICI, une seule fois, et UNIQUEMENT sur un
       * abandon. Un 404, un challenge ou un mur de connexion ne passent pas par
       * là : ils reviennent avec une réponse, et ce sont des observations à
       * rendre telles quelles, pas des pannes à réessayer. Insister sur un
       * challenge est exactement ce que la mission interdit.
       */
      let response = await page.goto(url, { waitUntil: 'domcontentloaded' }).catch((error: unknown) => {
        if (!isNavigationAborted(error)) throw error;
        this.log.warn('r7.observer.navigation.superseded', { handle, detail: 'ERR_ABORTED — une seule reprise' });
        return null;
      });
      if (response === null) {
        await page.waitForTimeout(this.options.config.pace.settleMs);
        response = await page.goto(url, { waitUntil: 'domcontentloaded' }).catch((error: unknown) => {
          if (!isNavigationAborted(error)) throw error;
          throw new NavigationAbortedError(url);
        });
      }
      httpStatus = response?.status() ?? null;
      // Sans interaction : le temps que les requêtes que la page a lancées
      // d'elles-mêmes reviennent.
      await this.settle(page, payloads);
    } catch (error) {
      page.off('response', onResponse);

      /**
       * Un navigateur mort n'est pas un profil illisible.
       *
       * Constaté : Opera GX s'est fermé au milieu d'une exécution. Les cinq
       * profils suivants ont été « observés » en une milliseconde chacun et
       * écrits en `UNREADABLE` — cinq lignes affirmant que nous avions regardé
       * et rien vu, alors que rien n'avait été ouvert. C'est précisément
       * l'affirmation d'une absence non vérifiée que le §2 de CLAUDE.md
       * interdit, et elle est pire qu'une erreur : elle est PERSISTÉE, et une
       * relecture ultérieure ne peut plus la distinguer d'un vrai échec de
       * lecture.
       *
       * Le contrat de ce rail le dit déjà : une exception ne signale qu'une
       * panne du rail lui-même. Un contexte fermé en est une, donc elle se lève
       * — et l'appelant arrête, au lieu de dérouler une liste dans le vide.
       */
      if (isBrowserGone(error)) {
        throw new ObserverRailError('le navigateur d’observation s’est fermé pendant la collecte', { cause: error });
      }

      if (!(error instanceof NavigationAbortedError)) {
        return this.unreadable(
          target,
          observedAt,
          Date.now() - started,
          `navigation échouée : ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      /**
       * §8 — deux profils de suite dont la navigation est interrompue ne sont
       * pas deux pannes, c'est une réponse.
       *
       * Constaté : après vingt-huit profils rapprochés, Instagram a cessé de
       * servir le DOCUMENT lui-même. Les deux tentatives échouaient en quelques
       * centaines de millisecondes, sur les onze profils suivants, sans qu'une
       * seule page ne se rende — donc sans qu'aucun marqueur de page (429,
       * « réessayez plus tard », challenge) ne puisse être lu. Quatre-vingt-dix
       * secondes d'arrêt ont suffi à rétablir un chargement normal.
       *
       * Classé `UNREADABLE`, cela ne déclenchait RIEN : le rail poursuivait la
       * liste entière en insistant sur une plateforme qui venait de dire non.
       * C'est exactement ce que §8 interdit. `RATE_LIMITED` appartient aux
       * `GLOBAL_STOP_STATES`, donc ce verdict ARRÊTE l'exécution complète.
       *
       * Le seuil est de deux profils CONSÉCUTIFS, pas d'un seul : une navigation
       * supplantée isolée arrive au premier chargement d'un profil navigateur
       * neuf, et arrêter tout un lot là-dessus serait aussi faux que de ne
       * jamais s'arrêter.
       */
      this.consecutiveNavigationAborts += 1;
      const detail =
        `navigation interrompue par la plateforme sur ${this.consecutiveNavigationAborts} profil(s) consécutif(s) ` +
        '— aucune page rendue, donc aucun marqueur lisible ; c’est la signature d’un ralentissement imposé';
      if (this.consecutiveNavigationAborts >= ABORT_MEANS_THROTTLED_AFTER) {
        this.log.warn('r7.observer.navigation.throttled', { handle, consecutive: this.consecutiveNavigationAborts });
        return this.failed(target, observedAt, Date.now() - started, 'RATE_LIMITED', detail);
      }
      return this.unreadable(target, observedAt, Date.now() - started, detail);
    }
    // Une page rendue efface le soupçon : le compteur ne mesure que des ÉCHECS
    // qui se suivent.
    this.consecutiveNavigationAborts = 0;
    page.off('response', onResponse);

    /**
     * Instagram sert la majeure partie du profil dans des blobs JSON INLINE,
     * pas dans une réponse d'API.
     *
     * C'est ce que le premier profil réel a montré : douze lectures GraphQL
     * autorisées, aucune ne portant l'objet `user`, et pourtant la page affichait
     * tout. Les données arrivent avec le DOCUMENT, dans des
     * `<script type="application/json">`. Les lire n'émet aucune requête —
     * c'est du texte déjà présent dans la page.
     */
    const inline = await this.readInlineJsonPayloads(page);

    const [visibleText, captchaWidgets] = await Promise.all([
      this.readVisibleText(page),
      this.countCaptchaWidgets(page),
    ]);

    /**
     * Le compte sur lequel le navigateur a ATTERRI, lu dans l'URL finale.
     *
     * C'est lui, et pas le handle demandé, qui délimite ce que la page a le
     * droit de dire du prospect : une page authentifiée charge aussi des comptes
     * suggérés, un auteur du fil d'accueil et l'observer lui-même, et sans cette
     * borne le premier objet `user` arrivé emporte la bio et les abonnés.
     *
     * Prendre l'URL FINALE plutôt que le handle demandé garde la redirection
     * visible : si Instagram nous mène ailleurs, les faits seront ceux de cet
     * ailleurs, et `checkIdentity` le dira au lieu de le masquer.
     */
    const landedUsername = usernameFromProfileUrl(page.url()) ?? handle;

    const facts = await this.assembleFacts(page, payloads, inline, observedAt, landedUsername);

    /**
     * §14 — l'ordre de préférence, appliqué tel quel.
     *
     * 1. les réponses réseau que la page a chargées d'elle-même ;
     * 2. les données structurées déjà présentes dans le document ;
     * 3. les métadonnées de la GRILLE, lues dans le DOM.
     *
     * Le troisième niveau existe parce que les deux premiers ne rendent RIEN à
     * un visiteur anonyme : Instagram ne sert plus `taken_at_timestamp` hors
     * session. La grille donne alors des permaliens sans dates — c'est peu, et
     * c'est honnête : la cadence restera `UNKNOWN`, et l'on saura pourquoi.
     *
     * Le quatrième niveau que la mission autorise — ouvrir une publication —
     * n'est PAS implémenté : il produirait une impression par publication et par
     * prospect, pour obtenir ce qu'une session dédiée donne sans aucune vue
     * supplémentaire.
     */
    const publications = this.readPublications([...payloads, ...inline], facts.username?.value ?? landedUsername);
    const fromPayloads = publications.posts;
    const posts = fromPayloads.length > 0 ? fromPayloads : await this.readGridPermalinks(page);
    const identity = checkIdentity({
      expectedHandle: handle,
      observedUsername: facts.username?.value ?? null,
      corroboration: target.corroboration,
      observedProfileText: `${facts.displayName?.value ?? ''} ${facts.biography?.value ?? ''}`,
      prospectIdentities: target.prospectIdentities,
    });

    const pageSignals: PageSignals = { visibleText, finalUrl: page.url(), captchaWidgets, httpStatus };
    const classified = classifyObservationState({
      page: pageSignals,
      identity,
      facts,
      postsObserved: posts.filter((post) => post.takenAt !== null).length,
    });

    /**
     * §19 — la capture n'est prise que lorsqu'elle a un sens ET un destinataire
     * légitime. Pas sur une contradiction d'identité : ce serait archiver la
     * photo du compte de quelqu'un d'autre sous le nom d'un prospect.
     *
     * L'ORDRE compte : l'état ci-dessus a été classé sur la page INTACTE, avant
     * que `capture` ne masque localement la bannière de consentement. Sans cet
     * ordre, un mur de connexion ou un challenge rendu dans une boîte de dialogue
     * disparaîtrait de `innerText` et ne serait plus détecté — on aurait troqué
     * une jolie capture contre un arrêt de sécurité.
     */
    const screenshot =
      classified.state === 'OBSERVED' || classified.state === 'PARTIAL' || classified.state === 'PRIVATE'
        ? await this.capture(page, facts.username?.value ?? handle, observedAt)
        : null;

    return {
      schemaVersion: 1,
      runId: this.options.runId,
      prospectId: target.prospectId,
      prospectName: target.prospectName,
      expectedHandle: handle,
      state: classified.state,
      stateDetail: classified.detail,
      observedAt,
      identity,
      facts,
      posts,
      postsSource:
        posts.length === 0
          ? 'none'
          : fromPayloads.length > 0
            ? payloads.length > 0
              ? 'network_response'
              : 'structured_data'
            : 'dom_attribute',
      screenshot,
      blockedRequests: [...this.refusals],
      postsRejectedForeignOwner: publications.rejectedForeignOwner,
      durationMs: Date.now() - started,
    };
  }

  /**
   * Attendre ce que la page a DÉJÀ demandé, sans rien demander de plus.
   *
   * ---------------------------------------------------------------------------
   * Pourquoi une attente fixe ne suffisait pas
   * ---------------------------------------------------------------------------
   * La première collecte authentifiée du corpus entier a rendu onze profils sur
   * vingt-huit en `PARTIAL`, sans horodatage. Les échecs n'étaient ni groupés en
   * fin d'exécution ni corrélés à la taille du compte : ils étaient dispersés,
   * et toutes les durées butaient exactement sur le même plafond. Ce n'était donc
   * pas un blocage d'Instagram — c'était nous qui raccrochions au bout de 2,5 s
   * sur une réponse qui arrivait après.
   *
   * Rendre `UNKNOWN` par impatience serait le pire des deux mondes : la donnée
   * existe, elle a été demandée par la page, elle est en route, et on la déclare
   * non observée.
   *
   * ---------------------------------------------------------------------------
   * Ce que cette attente n'est pas
   * ---------------------------------------------------------------------------
   * Elle n'émet AUCUNE requête, ne fait défiler aucune grille, ne clique nulle
   * part et ne recharge rien. Elle écoute plus longtemps un échange déjà en
   * cours, et elle s'arrête dès que la réponse utile est là — donc elle coûte
   * moins souvent qu'un plafond relevé pour tout le monde. `maxSettleMs` la
   * borne dans tous les cas, y compris si la réponse ne vient jamais.
   */
  private async settle(page: Page, payloads: readonly unknown[]): Promise<void> {
    const { settleMs, maxSettleMs } = this.options.config.pace;
    await page.waitForTimeout(settleMs);

    const deadline = Date.now() + Math.max(0, maxSettleMs - settleMs);
    const POLL_MS = 250;
    while (Date.now() < deadline) {
      // Une seule publication horodatée suffit à prouver que le fil est arrivé ;
      // en attendre douze ferait patienter pour rien un compte qui n'en a que
      // trois.
      const dated = payloads.some((payload) => readPosts(payload).some((post) => post.takenAt !== null));
      if (dated) return;
      await page.waitForTimeout(POLL_MS);
    }
  }

  /**
   * Les blobs JSON déjà présents dans le document.
   *
   * Aucune requête n'est émise : `page.evaluate` lit le texte de balises que le
   * navigateur a déjà reçues. Le filtre `"username"` évite de désérialiser les
   * dizaines de blobs de configuration qu'Instagram embarque et qui ne
   * contiennent aucun profil — c'est une économie, pas une sélection de contenu.
   */
  private async readInlineJsonPayloads(page: Page): Promise<unknown[]> {
    let raw: string[] = [];
    try {
      raw = await page.evaluate(() =>
        [...document.querySelectorAll('script[type="application/json"]')]
          .map((node) => node.textContent ?? '')
          .filter((text) => text.includes('"username"'))
          .slice(0, 40),
      );
    } catch {
      return [];
    }

    const parsed: unknown[] = [];
    for (const text of raw) {
      try {
        parsed.push(JSON.parse(text));
      } catch {
        // Un blob illisible n'est pas une donnée. Il disparaît sans faire
        // échouer la lecture des autres.
      }
    }
    return parsed;
  }

  /**
   * §14 niveau 3 — les permaliens de la grille, lus dans le DOM.
   *
   * Ce que cela donne : l'existence et l'identité stable de N publications
   * récentes. Ce que cela ne donne PAS : leur date. Les entrées rendues portent
   * donc `takenAt: null`, et la cadence les écartera — c'est voulu. Un permalien
   * n'est pas un horodatage, et le §15 interdit d'en dériver un.
   *
   * `pinned` vaut `false` faute d'observation : le DOM anonyme ne distingue pas
   * une épingle. Sans date, la distinction ne change rien ici — mais elle est
   * notée pour que personne ne lise ce `false` comme un constat.
   */
  private async readGridPermalinks(page: Page): Promise<ObservedPost[]> {
    try {
      const hrefs = await page.evaluate(() =>
        [...document.querySelectorAll('a')]
          .map((anchor) => anchor.getAttribute('href') ?? '')
          .filter((href) => /\/(p|reel)\/[A-Za-z0-9_-]+\/?$/.test(href))
          .slice(0, 60),
      );

      const byShortcode = new Map<string, ObservedPost>();
      for (const href of hrefs) {
        const match = /\/(p|reel)\/([A-Za-z0-9_-]+)\/?$/.exec(href);
        const kind = match?.[1];
        const shortcode = match?.[2];
        if (kind === undefined || shortcode === undefined) continue;
        byShortcode.set(shortcode, {
          mediaId: null,
          permalink: `https://www.instagram.com/${kind}/${shortcode}/`,
          takenAt: null,
          mediaType: kind === 'reel' ? 'Reel' : 'Post',
          pinned: false,
          // Le DOM de la grille ne nomme pas l'auteur de chaque vignette. `null`
          // dit « non observé » ; sans date, ces entrées ne pèsent de toute
          // façon sur aucune cadence.
          owner: null,
        });
      }
      return [...byShortcode.values()];
    } catch {
      return [];
    }
  }

  /**
   * Les faits, réseau d'abord, DOM ensuite.
   *
   * L'ordre porte une décision : une réponse réseau est structurée et exacte, un
   * texte de méta est localisé et parfois abrégé. Le DOM ne COMPLÈTE donc que ce
   * que le réseau n'a pas donné — il ne corrige jamais une valeur déjà lue, sans
   * quoi un « 12,3 k » écraserait un `12 349` exact.
   */
  private async assembleFacts(
    page: Page,
    networkPayloads: readonly unknown[],
    inlinePayloads: readonly unknown[],
    observedAt: string,
    landedUsername: string,
  ): Promise<ProfileFacts> {
    let facts: ProfileFacts = {};

    /**
     * Deux origines, deux provenances DISTINCTES — et jamais l'une déguisée en
     * l'autre.
     *
     * Une réponse d'API et un blob embarqué dans le document ne se vérifient pas
     * de la même façon : la première est datée par la requête, le second a pu
     * être rendu depuis un cache serveur. Écrire `network_response` sur les deux
     * aurait donné à la seconde une garantie qu'elle n'a pas.
     */
    for (const payload of networkPayloads) {
      const read = readProfileFacts(
        payload,
        {
          observedAt,
          source: 'réponse réseau chargée par la page',
          method: 'network_response',
          confidence: 'HIGH',
        },
        landedUsername,
      );
      facts = { ...read, ...facts };
    }
    for (const payload of inlinePayloads) {
      const read = readProfileFacts(
        payload,
        {
          observedAt,
          source: 'blob JSON embarqué dans le document du profil',
          method: 'structured_data',
          confidence: 'HIGH',
        },
        landedUsername,
      );
      facts = { ...read, ...facts };
    }

    const ogDescription = await page
      .getAttribute('meta[property="og:description"]', 'content', { timeout: 2_000 })
      .catch(() => null);
    if (ogDescription !== null) {
      const counts = readOgDescriptionCounts(ogDescription);
      const meta = {
        observedAt,
        source: 'meta og:description',
        method: 'structured_data' as const,
        confidence: 'MEDIUM' as const,
      };
      if (facts.postCount === undefined && counts.posts !== null) {
        facts = { ...facts, postCount: { value: counts.posts, ...meta } };
      }
      if (facts.followersCount === undefined && counts.followers !== null) {
        facts = { ...facts, followersCount: { value: counts.followers, ...meta } };
      }
      if (facts.followingCount === undefined && counts.following !== null) {
        facts = { ...facts, followingCount: { value: counts.following, ...meta } };
      }
    }

    /**
     * §17 — le lien externe du profil, lu dans le DOM.
     *
     * Instagram ne sert plus `external_url` à un visiteur anonyme, et le lien
     * est pourtant AFFICHÉ : il passe par un redirecteur maison
     * (`l.instagram.com/?u=<url encodée>`). On décode le paramètre plutôt que de
     * garder l'URL du redirecteur, qui ne dirait rien de l'entreprise.
     *
     * Rien n'est suivi : on lit un attribut `href`, on ne navigue pas dessus.
     */
    if (facts.externalWebsite === undefined) {
      const external = await this.readExternalLink(page);
      if (external !== null) {
        facts = {
          ...facts,
          externalWebsite: {
            value: external,
            observedAt,
            source: 'lien externe affiché sur le profil',
            method: 'dom_attribute',
            confidence: 'MEDIUM',
          },
        };
      }
    }

    if (facts.username === undefined) {
      const canonical = await page.getAttribute('link[rel="canonical"]', 'href', { timeout: 2_000 }).catch(() => null);
      const fromCanonical = canonical === null ? null : normalizeHandle(canonical.replace(/^https?:\/\/[^/]+\//, ''));
      if (fromCanonical !== null) {
        facts = {
          ...facts,
          username: {
            value: fromCanonical,
            observedAt,
            source: 'link[rel=canonical]',
            method: 'dom_attribute',
            confidence: 'MEDIUM',
          },
        };
      }
    }

    /**
     * §18 — les « à la une », par leur PRÉSENCE seule.
     *
     * Lue sur les liens du profil, sans ouvrir quoi que ce soit : un `href` est
     * un attribut, pas une visite. La garde réseau refuse d'ailleurs toute
     * requête vers une surface de story, y compris en GET.
     *
     * Un compte dont le DOM ne porte aucun lien de ce type laisse la question
     * OUVERTE : Instagram ne rend pas toujours ce bandeau à un visiteur anonyme,
     * et écrire `false` reviendrait à affirmer une absence non vérifiée.
     */
    if (facts.highlightsPresent === undefined) {
      const highlightLinks = await page
        .locator('a[href*="/stories/highlights/"]')
        .count()
        .catch(() => -1);
      if (highlightLinks > 0) {
        facts = {
          ...facts,
          highlightsPresent: {
            value: true,
            observedAt,
            source: 'liens de stories à la une présents dans le DOM du profil',
            method: 'dom_attribute',
            confidence: 'MEDIUM',
          },
          highlightsCount: {
            value: highlightLinks,
            observedAt,
            source: 'liens de stories à la une présents dans le DOM du profil',
            method: 'dom_attribute',
            confidence: 'LOW',
          },
        };
      }
    }

    return facts;
  }

  /**
   * Les publications DU COMPTE OBSERVÉ, et le compte de celles qu'on a écartées.
   *
   * ---------------------------------------------------------------------------
   * Pourquoi un filtre par propriétaire, et pas seulement par enveloppe
   * ---------------------------------------------------------------------------
   * Une session authentifiée charge deux choses en ouvrant un profil : le fil de
   * CE profil, et le fil d'accueil de l'observer. Les deux arrivent dans des
   * réponses `graphql/query` de même forme. Pire, le fil du profil lui-même n'est
   * pas homogène : Instagram y injecte des publications de comptes suggérés.
   *
   * Sur le premier profil réellement observé sous session, l'entrée la plus
   * récente de la charge utile appartenait à une autre entreprise. La garder
   * aurait avancé `last_post_at` de trois jours sur une publication que ce
   * prospect n'a jamais faite — une donnée inventée au sens du §2, pas une
   * imprécision.
   *
   * Le filtre porte donc sur le propriétaire de CHAQUE publication. Une
   * publication dont la charge utile ne nomme pas l'auteur est CONSERVÉE : elle
   * vient d'une source déjà encadrée par le profil (la grille, l'objet user), et
   * l'écarter effacerait les observations anonymes de R7.3C.
   */
  private readPublications(
    payloads: readonly unknown[],
    observedUsername: string | null,
  ): { readonly posts: ObservedPost[]; readonly rejectedForeignOwner: number } {
    const expectedOwner = observedUsername === null ? null : normalizeHandle(observedUsername);
    const byKey = new Map<string, ObservedPost>();
    let rejectedForeignOwner = 0;

    for (const payload of payloads) {
      for (const post of readPosts(payload)) {
        if (expectedOwner !== null && post.owner !== null && normalizeHandle(post.owner) !== expectedOwner) {
          rejectedForeignOwner += 1;
          continue;
        }
        const key = post.mediaId ?? post.permalink ?? `${post.takenAt ?? ''}`;
        if (key.length === 0) continue;
        const existing = byKey.get(key);
        // Une charge utile plus riche remplace une plus pauvre ; jamais l'inverse.
        if (existing === undefined || (existing.takenAt === null && post.takenAt !== null)) byKey.set(key, post);
      }
    }
    return { posts: [...byKey.values()], rejectedForeignOwner };
  }

  /**
   * Le premier lien sortant du profil, décodé du redirecteur d'Instagram.
   *
   * `null` quand rien n'est affiché — et `null` veut dire « pas de lien VU »,
   * pas « pas de lien ». La distinction remonte telle quelle jusqu'à
   * `profile_completeness`, qui écarte alors le signal au lieu de compter zéro.
   */
  private async readExternalLink(page: Page): Promise<string | null> {
    try {
      const hrefs = await page.evaluate(() =>
        [...document.querySelectorAll('a')]
          .map((anchor) => anchor.getAttribute('href') ?? '')
          .filter((href) => href.startsWith('http'))
          .slice(0, 80),
      );
      for (const href of hrefs) {
        let url: URL;
        try {
          url = new URL(href);
        } catch {
          continue;
        }
        if (url.hostname === 'l.instagram.com') {
          const target = url.searchParams.get('u');
          if (target !== null && target.length > 0) return decodeURIComponent(target);
          continue;
        }
        // Un lien direct, à condition qu'il ne pointe pas vers Meta elle-même.
        if (!/(^|\.)(instagram|facebook|threads|meta)\.com$/i.test(url.hostname)) return url.toString();
      }
      return null;
    } catch {
      return null;
    }
  }

  private async readVisibleText(page: Page): Promise<string> {
    try {
      const body = await page.evaluate(() => document.body?.innerText ?? '');
      return body.slice(0, 20_000);
    } catch {
      return '';
    }
  }

  private async countCaptchaWidgets(page: Page): Promise<number> {
    try {
      return await page.locator(CAPTCHA_WIDGET_SELECTOR).count();
    } catch {
      return 0;
    }
  }

  /**
   * §19 — la capture du profil, sans interaction et sans défilement.
   *
   * `fullPage: false` : une capture pleine page ferait défiler le document, donc
   * chargerait des publications supplémentaires. Ce qu'on garde est ce qu'un
   * humain voit en ouvrant le profil — c'est exactement la question posée.
   *
   * ---------------------------------------------------------------------------
   * La bannière de consentement, et pourquoi la masquer n'est pas la refuser
   * ---------------------------------------------------------------------------
   * Le premier profil réel a rendu une capture inexploitable : une boîte de
   * dialogue de consentement aux cookies occupait la moitié de l'image, par
   * dessus le feed qu'on venait chercher. Trois réponses possibles, et deux sont
   * mauvaises :
   *
   *   - CLIQUER « autoriser » ou « refuser » — exclu. Le rail n'a aucune
   *     primitive d'interaction, c'est sa garantie centrale, et répondre à un
   *     consentement au nom de personne serait pire qu'une capture ratée ;
   *   - PRÉ-INJECTER un cookie de consentement — exclu aussi. Ce serait
   *     fabriquer une réponse qu'aucun humain n'a donnée ;
   *   - MASQUER localement la boîte, le temps de la photographie. C'est ce qui
   *     est fait ici.
   *
   * Ce masquage n'émet aucune requête, ne change rien chez Instagram, n'accorde
   * ni ne refuse aucun consentement, et ne donne accès à rien de plus : le
   * contenu sous la boîte était DÉJÀ chargé et déjà lisible dans le DOM. C'est
   * une feuille de style de lecteur, appliquée à une image locale.
   *
   * Il intervient APRÈS la classification d'état (voir `observe`), sans quoi un
   * mur de connexion rendu dans un dialogue disparaîtrait de `innerText` et
   * cesserait d'être détecté.
   */
  private async capture(page: Page, username: string, observedAt: string): Promise<ScreenshotRef | null> {
    if (!this.options.config.artifacts.screenshots) return null;
    try {
      const dir = resolve(process.cwd(), this.options.config.artifacts.root, 'screenshots');
      ensureDir(dir);
      const stamp = observedAt.replace(/[:.]/g, '-');
      const path = resolve(dir, `${username}-${stamp}.png`);

      const overlayHidden = await this.hideConsentOverlay(page);
      await page.screenshot({ path, fullPage: false });

      const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
      return {
        path,
        sha256,
        viewportWidth: this.options.config.session.viewport.width,
        viewportHeight: this.options.config.session.viewport.height,
        observedAt,
        username,
        overlayHidden,
      };
    } catch (error) {
      this.log.warn('r7.observer.screenshot.failed', {
        detail: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Masque, pour la seule capture, la boîte de consentement et son voile.
   *
   * Rend `true` quand une règle a été posée — l'information est écrite dans
   * l'artefact, parce qu'une revue visuelle doit savoir que l'image a été
   * cosmétiquement ajustée. Une garantie qu'on cache est une garantie qu'on perd.
   */
  private async hideConsentOverlay(page: Page): Promise<boolean> {
    try {
      await page.addStyleTag({
        content: `
          div[role="dialog"], div[role="presentation"] > div[role="dialog"] { display: none !important; }
          div[role="presentation"]:has(> div[role="dialog"]) { display: none !important; }
          body { overflow: visible !important; }
        `,
      });
      return true;
    } catch {
      return false;
    }
  }

  private unreadable(target: ObserveTarget, observedAt: string, durationMs: number, detail: string): ProfileObservation {
    return this.failed(target, observedAt, durationMs, 'UNREADABLE', detail);
  }

  private failed(
    target: ObserveTarget,
    observedAt: string,
    durationMs: number,
    state: ProfileObservation['state'],
    detail: string,
  ): ProfileObservation {
    const identity = checkIdentity({
      expectedHandle: target.expectedHandle,
      observedUsername: null,
      corroboration: target.corroboration,
    });
    return {
      schemaVersion: 1,
      runId: this.options.runId,
      prospectId: target.prospectId,
      prospectName: target.prospectName,
      expectedHandle: normalizeHandle(target.expectedHandle) ?? target.expectedHandle,
      state,
      stateDetail: detail,
      observedAt,
      identity,
      facts: {},
      posts: [],
      postsSource: 'none',
      screenshot: null,
      blockedRequests: [...this.refusals],
      postsRejectedForeignOwner: 0,
      durationMs,
    };
  }

  async close(): Promise<void> {
    const context = this.context;
    const lease = this.lease;
    this.context = null;
    this.page = null;
    this.lease = null;
    try {
      if (context !== null) await context.close().catch(() => undefined);
    } finally {
      lease?.release();
    }
  }

  /** Le bail, traduit dans les erreurs de CE rail. */
  private leaseProfile(): InstagramBrowserLease {
    try {
      return acquireInstagramBrowserLease(this.options.config.session.profileDir);
    } catch (error) {
      if (error instanceof InstagramBrowserProfileBusyError) {
        throw new ObserverRailError(error.message, { cause: error });
      }
      throw error;
    }
  }
}
