import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BrowserContext, Page, Route } from 'playwright';
import type { InstagramRailConfig } from '@/lib/config/schema';
import { logger } from '@/lib/logging/logger';
import { handleFromProfileUrl, normalizeHandle, profileUrl } from '@/lib/instagram/identity';
import { readRelationship } from '@/lib/instagram/relationship';
import {
  classifyBootstrapRequest,
  classifyInstagramRequest,
  isAllowedNavigation,
  type GuardDecision,
} from '@/lib/instagram/readOnlyGuard';
import {
  InstagramRailError,
  type InstagramProfileObservation,
  type InstagramReadOnlyRail,
  type InstagramSessionStatus,
} from '@/lib/instagram/rail';
import {
  acquireInstagramBrowserLease,
  InstagramBrowserProfileBusyError,
  type InstagramBrowserLease,
} from '@/lib/instagram/browserProfileLease';
import type { InstagramIdentitySignal, InstagramSessionState } from '@/lib/instagram/types';

/**
 * IG-R1 §1 — l'implémentation Playwright du rail, et rien d'autre.
 *
 * Une session, un navigateur
 * --------------------------
 * `launchPersistentContext` ouvre UN contexte persistant, réutilisé pour tous
 * les jobs d'une exécution. Pas un navigateur par prospect : la file est
 * séquentielle et le worker passe les jobs l'un après l'autre dans le même
 * contexte. Ouvrir un navigateur par cible multiplierait la charge sans rien
 * apporter, et rendrait la session incohérente.
 *
 * Ce que cette classe ne fait pas, et pourquoi c'est vérifiable
 * -------------------------------------------------------------
 * Aucun `click`, aucun `fill`, aucun `type`, aucun `press` n'apparaît dans ce
 * fichier — un `grep` le confirme, et un test l'affirme. Le seul geste posé sur
 * une page est `goto`, et seulement vers une URL que `isAllowedNavigation`
 * accepte. Toute requête sortante passe d'abord par `classifyInstagramRequest`.
 *
 * Ce qu'elle ne fait pas non plus : falsifier une empreinte, masquer
 * l'automatisation, passer par un proxy, ralentir aléatoirement pour ressembler
 * à un humain. Chromium est lancé tel quel ; `locale` et `timezoneId` sont
 * déclarés parce qu'ils décrivent la machine, pas pour la déguiser.
 *
 * Secrets
 * -------
 * Le profil persistant contient des cookies de session. Il vit sous `var/`
 * (ignoré par Git, vérifié par le schéma de configuration), n'est jamais lu par
 * la base, et rien ici ne journalise une valeur de cookie : seule leur PRÉSENCE
 * est constatée, sous forme de booléen.
 */

/** Cookies dont la seule PRÉSENCE indique une session authentifiée. Leur valeur n'est jamais lue. */
const SESSION_COOKIE_NAMES: readonly string[] = ['sessionid', 'ds_user_id'];

const INSTAGRAM_ROOT = 'https://www.instagram.com/';

/**
 * Marqueurs de page, en français et en anglais.
 *
 * Recherchés dans le texte VISIBLE (`document.body.innerText`), jamais dans le
 * HTML ni dans `textContent`. La distinction n'est pas cosmétique, et elle a
 * été trouvée par le premier smoke réel : `textContent('body')` inclut le
 * contenu des balises `<script>`, et le bootstrap d'Instagram y liste des noms
 * de services tiers — dont `arkose_captcha` et `google_recaptcha`. Une page
 * d'accueil parfaitement ordinaire se classait donc en `CAPTCHA`, c'est-à-dire
 * en arrêt dur, sur la foi d'un mot trouvé dans du JavaScript minifié.
 *
 * `innerText` ne rend que ce qu'un humain lit à l'écran. Tous les marqueurs
 * ci-dessous en dépendent, pas seulement ceux du CAPTCHA : un « votre compte a
 * été bloqué » caché dans un blob JS aurait produit le même faux positif.
 */
const MISSING_PROFILE_MARKERS: readonly RegExp[] = [
  /sorry,?\s*this page\s*isn'?t available/i,
  /cette page n'?est pas disponible/i,
  /the link you followed may be broken/i,
  /le lien que vous avez suivi est peut-être rompu/i,
];

const CHALLENGE_MARKERS: readonly RegExp[] = [
  /confirm(er)? (your|votre) (identity|identité)/i,
  /we detected an unusual login/i,
  /connexion inhabituelle/i,
  /help us confirm/i,
  /suspicious login attempt/i,
];

/**
 * Un CAPTCHA se reconnaît à ce qu'il DEMANDE, pas au mot « captcha ». Les
 * motifs nus `/captcha/i` et `/recaptcha/i` ont été retirés : ils décrivaient
 * un vocabulaire, pas une situation. Le signal fort est le WIDGET
 * (`countCaptchaWidgets`), ces marqueurs n'en sont que le complément visible.
 */
const CAPTCHA_MARKERS: readonly RegExp[] = [
  /i'?m not a robot/i,
  /je ne suis pas un robot/i,
  /(complete|solve|compl[ée]t(er|ez)|r[ée]sou(dre|dez))[^.\n]{0,40}captcha/i,
  /captcha[^.\n]{0,40}(to continue|pour continuer)/i,
];

/**
 * Sélecteurs d'un vrai widget de vérification. Un CAPTCHA est une `<iframe>`
 * servie par un fournisseur identifiable — c'est ce qu'on cherche, plutôt
 * qu'un mot dans du texte.
 */
const CAPTCHA_WIDGET_SELECTOR = [
  'iframe[src*="recaptcha" i]',
  'iframe[src*="arkoselabs" i]',
  'iframe[src*="funcaptcha" i]',
  'iframe[src*="hcaptcha" i]',
  'iframe[title*="captcha" i]',
].join(', ');

const BLOCKED_MARKERS: readonly RegExp[] = [
  /your account has been temporarily (blocked|locked)/i,
  /votre compte a été temporairement (bloqué|verrouillé)/i,
  /we restrict certain activity/i,
  /nous limitons certaines activités/i,
  /please wait a few minutes before you try again/i,
  /veuillez patienter quelques minutes/i,
  /action blocked/i,
  /action bloquée/i,
];

const LOGIN_MARKERS: readonly RegExp[] = [
  /log in to instagram/i,
  /connectez-vous à instagram/i,
  /phone number, username, or email/i,
];

/**
 * Le formulaire de connexion, reconnu par sa STRUCTURE et non par sa langue.
 *
 * Les marqueurs textuels ci-dessus sont anglophones à une exception près, et le
 * navigateur du rail tourne en `fr-FR` : le mur de connexion français ne dit
 * jamais « Log in to Instagram », et le libellé « Numéro de téléphone, nom
 * d’utilisateur ou adresse e-mail » vit dans un attribut `placeholder`, que
 * `innerText` ne rend PAS. Un mur de connexion pouvait donc traverser les
 * marqueurs sans en déclencher un seul.
 *
 * Un `input[name="password"]` n’a pas de traduction.
 */
const LOGIN_CONTROL_SELECTOR = [
  'input[name="username"]',
  'input[name="password"]',
  'form#loginForm',
  'a[href^="/accounts/login"]',
  'a[href^="/accounts/signup"]',
  'a[href^="/accounts/emailsignup"]',
].join(', ');

/**
 * La PREUVE d’une session authentifiée — des destinations qu’Instagram ne rend
 * qu’à un compte connecté.
 *
 * C’est le cœur du correctif. L’ancienne conclusion « SESSION_READY » était
 * négative : un cookie dans le profil, aucun marqueur de connexion reconnu, du
 * texte à l’écran, donc authentifié. Trois absences ne font pas une présence.
 * Un cookie `sessionid` périmé reste dans le profil persistant longtemps après
 * qu’Instagram a cessé de l’accepter, et le rail annonçait alors une session
 * prête devant un mur de connexion — jusqu’à buter sur un
 * `IG_SEND_COMPOSER_NOT_FOUND` bien plus tard, là où le diagnostic ne se lit
 * plus.
 *
 * Ces sélecteurs sont volontairement EXACTS. Le pied de page d’une page
 * anonyme propose `/explore/locations/` et `/explore/tags/` : `a[href^="/explore/"]`
 * aurait donc été vrai déconnecté, et la preuve n’en aurait plus été une.
 *
 * Aucun de ces sélecteurs n’est cliqué, ni navigué : ils sont COMPTÉS. Compter
 * un lien vers `/direct/inbox/` n’ouvre pas la messagerie — la liste blanche de
 * navigation et la garde réseau restent les seules à décider de ce qui sort.
 */
const AUTHENTICATED_MARKER_SELECTOR = [
  'a[href="/direct/inbox/"]',
  'a[href="/accounts/activity/"]',
  'a[href="/explore/"]',
  'a[href="/accounts/edit/"]',
  'a[href^="/accounts/logout"]',
  // Un composeur de message direct n’est jamais servi à un visiteur anonyme.
  'div[role="textbox"][contenteditable="true"]',
].join(', ');

/** Intervalle de RELECTURE tant qu’un état reste indéterminé. Jamais une attente inconditionnelle. */
const SETTLE_POLL_MS = 500;

/** Borne de cette relecture. Passé ce délai, l’indétermination EST la réponse, et elle refuse. */
const SETTLE_TIMEOUT_MS = 15_000;

function firstMatch(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Classe l'état d'une page déjà chargée. Pure hors de la lecture du texte —
 * l'ordre est celui de la gravité décroissante : un blocage l'emporte sur un
 * challenge, qui l'emporte sur un mur de connexion.
 *
 * `hadSessionCookies` sépare deux situations que rien d'autre ne distingue :
 * un profil neuf qui n'a jamais été connecté (`LOGIN_REQUIRED`) et un profil
 * qui l'a été et ne l'est plus (`SESSION_EXPIRED`). La distinction change
 * l'action à demander à un opérateur, donc elle mérite deux états.
 */
export function classifyPageState(input: {
  finalUrl: string;
  /** Texte VISIBLE (`innerText`), jamais `textContent` ni le HTML. */
  text: string;
  /** Nombre de widgets de vérification détectés sur la page. */
  captchaWidgets: number;
  /**
   * Nombre d’affordances que seul un compte CONNECTÉ reçoit. Zéro interdit de
   * conclure à une session prête, quels que soient les cookies du profil.
   */
  authenticatedMarkers: number;
  /** Nombre d’éléments d’un formulaire de connexion, lus dans le DOM et non dans le texte. */
  loginControls: number;
  hasSessionCookies: boolean;
  hadSessionCookies: boolean;
  /**
   * Le handle du compte connecté, lu à l'écran. `null` = illisible, ce qui
   * n'est PAS « ce n'est pas nous ».
   */
  connectedHandle?: string | null;
  /**
   * Les handles qui sont nous. Une liste VIDE veut dire que personne n'a
   * déclaré de compte : il n'y a alors rien à comparer, et la vérification
   * n'a pas lieu — c'est le comportement d'avant ce correctif, conservé pour
   * les configurations qui laissent `inbound.accountHandle` à `null`.
   */
  expectedHandles?: readonly string[];
}): { state: InstagramSessionState; detail: string } {
  const path = (() => {
    try {
      return new URL(input.finalUrl).pathname.toLowerCase();
    } catch {
      return '';
    }
  })();

  // `/challenge` et `/checkpoint` sont deux noms du même mur, et `/accounts/suspended`
  // en est la forme définitive. Aucun des trois ne se franchit ici.
  if (path.startsWith('/challenge') || path.startsWith('/checkpoint')) {
    return { state: 'CHALLENGE', detail: `Instagram demande une vérification (${path})` };
  }
  if (path.startsWith('/accounts/suspended')) {
    return { state: 'BLOCKED', detail: 'Instagram annonce une suspension du compte (/accounts/suspended)' };
  }
  if (firstMatch(input.text, BLOCKED_MARKERS)) return { state: 'BLOCKED', detail: 'Instagram annonce une restriction sur ce compte' };
  if (input.captchaWidgets > 0) {
    return { state: 'CAPTCHA', detail: `${input.captchaWidgets} widget(s) de vérification affiché(s)` };
  }
  if (firstMatch(input.text, CAPTCHA_MARKERS)) return { state: 'CAPTCHA', detail: 'un CAPTCHA est demandé à l’écran' };
  if (firstMatch(input.text, CHALLENGE_MARKERS)) return { state: 'CHALLENGE', detail: 'Instagram demande une confirmation d’identité' };

  const atLogin = path.startsWith('/accounts/login') || path.startsWith('/accounts/signup');
  // L’URL ne suffit pas : Instagram sert son mur de connexion À LA RACINE avant
  // de réécrire l’URL côté client. C’est ce décalage qui a fait passer un mur de
  // connexion pour une session prête. Le formulaire, lui, est déjà dans le DOM.
  if (atLogin || input.loginControls > 0 || firstMatch(input.text, LOGIN_MARKERS)) {
    return input.hadSessionCookies
      ? { state: 'SESSION_EXPIRED', detail: 'session présente au démarrage mais Instagram redemande une connexion' }
      : { state: 'LOGIN_REQUIRED', detail: 'aucune session authentifiée dans le profil navigateur' };
  }

  if (!input.hasSessionCookies) {
    return { state: 'LOGIN_REQUIRED', detail: 'aucun cookie de session présent après chargement' };
  }
  if (input.text.trim().length === 0) {
    return { state: 'UNKNOWN', detail: 'page chargée mais vide — état indéterminable' };
  }

  /**
   * La dernière marche, et la seule qui ouvre la porte : une PREUVE.
   *
   * Tout ce qui précède a éliminé des situations connues. Éliminer des
   * situations connues ne démontre rien — une page inconnue les traverse toutes.
   * Il faut avoir VU quelque chose qu’Instagram ne montre qu’à un compte
   * connecté, sans quoi l’état reste indéterminé, donc refusé.
   */
  if (input.authenticatedMarkers <= 0) {
    return {
      state: 'UNKNOWN',
      detail:
        'cookie de session présent mais aucune preuve d’authentification à l’écran — ' +
        'un cookie périmé survit dans le profil, il ne prouve pas une session',
    };
  }

  /**
   * La porte d'IDENTITÉ, et la raison pour laquelle elle vient en DERNIER.
   *
   * Tout ce qui précède établit qu'une session est vivante. Rien n'établit
   * qu'elle est la NÔTRE. Le 24 août 2026 les deux ont été confondus : le
   * bootstrap a rendu `SESSION_READY` sur une session authentifiée comme
   * `bot72882552562736`, et le rail serait allé lire une boîte de réception
   * qui n'a jamais été la nôtre. « Connecté » n'est pas « connecté sous notre
   * nom », et seule cette porte fait la différence.
   */
  const expected = input.expectedHandles ?? [];
  if (expected.length > 0) {
    const connected = normalizeInstagramHandle(input.connectedHandle ?? null);
    if (connected === null) {
      // Fail-closed : ne pas avoir su lire le compte n'autorise rien. Le prix
      // d'un refus ici est une intervention humaine ; le prix d'un feu vert
      // serait d'agir au nom de quelqu'un d'autre.
      return {
        state: 'UNKNOWN',
        detail:
          'session authentifiée mais compte connecté illisible — ' +
          'une session dont on ignore le propriétaire ne vaut pas une session prête',
      };
    }
    if (!expected.includes(connected)) {
      return {
        state: 'SESSION_WRONG_ACCOUNT',
        detail:
          `session authentifiée sous « ${connected} », qui n'est pas le compte de ce dépôt ` +
          `(attendu : ${expected.map((handle) => `« ${handle} »`).join(' ou ')})`,
      };
    }
  }

  return {
    state: 'SESSION_READY',
    detail: `session authentifiée (${input.authenticatedMarkers} marqueur(s)), aucune demande de vérification`,
  };
}

export interface PlaywrightRailOptions {
  readonly config: InstagramRailConfig;
  readonly headless?: boolean;
  /** Répertoire des captures, sous `var/`. `null` désactive les captures. */
  readonly screenshotDir?: string | null;
  readonly workerId: string;
}

interface PlaywrightModule {
  chromium: {
    launchPersistentContext(userDataDir: string, options: Record<string, unknown>): Promise<BrowserContext>;
  };
}

/**
 * Playwright est importé DYNAMIQUEMENT, et seulement au moment d'ouvrir un
 * navigateur.
 *
 * Conséquence voulue : le domaine (file, gardes, identité, worker) se teste et
 * se compile sans que le paquet soit chargé, et une machine sans navigateur
 * installé peut encore lire la file, consulter l'arrêt global ou exécuter la
 * suite de tests.
 */
async function loadPlaywright(): Promise<PlaywrightModule> {
  try {
    return (await import('playwright')) as unknown as PlaywrightModule;
  } catch (error) {
    throw new InstagramRailError(
      'IG_BROWSER_LAUNCH_FAILED',
      'Playwright est introuvable — installer les dépendances puis « npx playwright install chromium »',
      { cause: error },
    );
  }
}

/**
 * Branche la garde réseau sur le contexte.
 *
 * `context.route('**\/*')` intercepte TOUT, y compris ce qu'aucune ligne de ce
 * dépôt n'a demandé — c'est précisément le but : la garde ne protège pas contre
 * le code qu'on a écrit, elle protège contre celui qu'on n'a pas écrit.
 */
async function installGuard(
  context: BrowserContext,
  classify: (request: { url: string; method: string; postData: string | null }) => GuardDecision,
  log: ReturnType<typeof logger.child>,
): Promise<void> {
  await context.route('**/*', async (route: Route) => {
    const request = route.request();
    const decision = classify({ url: request.url(), method: request.method(), postData: request.postData() });
    if (decision.allowed) {
      await route.continue();
      return;
    }
    // Journalisé sans le corps de la requête : un corps GraphQL Instagram
    // contient des jetons de session.
    log.warn('instagram.guard.blocked', {
      method: request.method(),
      // Chemin seul : une query string peut porter un jeton.
      path: (() => {
        try {
          return new URL(request.url()).pathname;
        } catch {
          return '<illisible>';
        }
      })(),
      rule: decision.rule,
      reason: decision.reason,
    });
    await route.abort('blockedbyclient');
  });
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

/**
 * Prend le bail du profil, ou rend l'erreur DU RAIL.
 *
 * Placé ici et appelé juste avant chaque `launchPersistentContext` : c'est la
 * seule position qui rende le bail incontournable. Le mettre chez les
 * appelants aurait laissé le bail dépendre de leur discipline, et ce fichier
 * est précisément celui qui ouvre Chromium — un chemin qui l'oublierait
 * n'ouvrirait pas de navigateur, il ne compilerait pas.
 */
function leaseProfileOrThrow(profileDir: string): InstagramBrowserLease {
  try {
    return acquireInstagramBrowserLease(profileDir);
  } catch (error) {
    if (error instanceof InstagramBrowserProfileBusyError) {
      throw new InstagramRailError('IG_BROWSER_PROFILE_BUSY', error.message, { cause: error });
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Observation d'une page — hors de la classe, pour n'exister qu'une fois
// ---------------------------------------------------------------------------

/**
 * Texte VISIBLE de la page, borné.
 *
 * `innerText` et non `textContent` : le second inclut le contenu des balises
 * `<script>`, donc le JavaScript d'Instagram — c'est ce qui a fait classer une
 * page d'accueil ordinaire en `CAPTCHA` au premier smoke réel. Jamais le HTML
 * non plus : il porte des jetons.
 */
async function readVisibleTextOf(page: Page): Promise<string> {
  try {
    const body = await page.evaluate(() => document.body?.innerText ?? '');
    return body.slice(0, 20_000);
  } catch {
    return '';
  }
}

/**
 * Compte les éléments d'un sélecteur. `0` en cas de panne de lecture.
 *
 * Ce repli est sûr dans les DEUX sens, et c'est pour cela qu'il est le même
 * partout : zéro widget de CAPTCHA n'accuse personne, et zéro marqueur
 * authentifié ne conclut à rien — il REFUSE. Une lecture ratée ne devient
 * jamais un feu vert.
 */
async function countMatches(page: Page, selector: string): Promise<number> {
  try {
    return await page.locator(selector).count();
  } catch {
    return 0;
  }
}

/**
 * Le handle du compte CONNECTÉ, lu dans le DOM de la page courante.
 *
 * Trois indices, du plus explicite au plus indirect, et le PREMIER qui répond
 * gagne. Aucun ne touche aux cookies : on ne lit pas `sessionid`, on ne le
 * déchiffre pas, on n'en journalise rien. Un handle est un nom public, affiché
 * à l'écran ; c'est la seule chose qu'on emporte d'ici.
 *
 * `null` veut dire « je n'ai pas su lire », jamais « ce n'est pas nous » — et
 * c'est `classifyPageState` qui décide ce qu'on fait d'une ignorance. La
 * distinction compte : confondre les deux transformerait une panne de lecture
 * en accusation, ou pire, en feu vert.
 */
export async function readConnectedHandle(page: Page): Promise<string | null> {
  try {
    /**
     * AUCUNE fonction déclarée à l'intérieur de ce `evaluate`, et c'est une
     * contrainte, pas un style.
     *
     * esbuild — que `tsx` utilise — enveloppe les fonctions nommées dans un
     * helper `__name()` pour préserver leur nom. Ce helper vit dans le module
     * compilé, pas dans la page : Playwright sérialise le corps, le navigateur
     * l'exécute, et la première fonction interne lève
     * `ReferenceError: __name is not defined`. C'est arrivé ici le 24 août
     * 2026, et le `catch` ci-dessous l'a transformé en « compte illisible » —
     * un refus correct rendu pour une raison fausse, donc invisible.
     */
    return await page.evaluate(() => {
      const HANDLE = /^[A-Za-z0-9._]{1,30}$/;
      let found: string | null = null;

      // 1. La page de compte NOMME le viewer dans un champ. Sans ambiguïté.
      const field = document.querySelector('input[name="username"]');
      if (field instanceof HTMLInputElement && field.type !== 'password') {
        const typed = field.value.trim();
        if (HANDLE.test(typed)) found = typed;
      }

      // 2. L'avatar de la barre de navigation : son texte alternatif nomme son
      //    propriétaire, en français comme en anglais. Instagram le rend AVANT
      //    les avatars du fil, si bien que l'ordre du document met le viewer en
      //    tête. Se tromper de sens ici REFUSE (le handle ne correspondrait
      //    pas), donc l'erreur ne peut pas devenir un feu vert.
      if (found === null) {
        const images = Array.from(document.querySelectorAll('img[alt]'));
        for (const image of images) {
          const alt = image.getAttribute('alt') ?? '';
          const fr = alt.match(/photo de profil de\s+([A-Za-z0-9._]{1,30})/i);
          const en = alt.match(/([A-Za-z0-9._]{1,30})'s profile picture/i);
          const candidate = (fr?.[1] ?? en?.[1] ?? '').trim();
          if (HANDLE.test(candidate)) {
            found = candidate;
            break;
          }
        }
      }

      // 3. Le lien de profil qui PORTE cet avatar. On ne prend jamais « un lien
      //    à un segment » au hasard : le fil en contient beaucoup, et ils
      //    appartiennent à d'autres comptes.
      if (found === null) {
        const images = Array.from(document.querySelectorAll('img[alt]'));
        for (const image of images) {
          const alt = image.getAttribute('alt') ?? '';
          if (!/profile picture|photo de profil/i.test(alt)) continue;
          const href = image.closest('a[href]')?.getAttribute('href') ?? '';
          const matched = href.match(/^\/([A-Za-z0-9._]{1,30})\/$/);
          const candidate = matched?.[1] ?? '';
          if (HANDLE.test(candidate)) {
            found = candidate;
            break;
          }
        }
      }

      return found;
    });
  } catch {
    return null;
  }
}

/** Comparaison de handles : insensible à la casse et au `@`, sinon stricte. */
export function normalizeInstagramHandle(handle: string | null | undefined): string | null {
  const cleaned = (handle ?? '').trim().toLowerCase().replace(/^@/, '').replace(/^\/+|\/+$/g, '');
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Les handles qui SONT nous.
 *
 * Les anciens noms en font partie, et ce n'est pas une indulgence : renommer un
 * compte Instagram ne le remplace pas. `hermesagency_` et `hermes__`
 * désignent la même boîte, et refuser la session parce qu'Instagram sert encore
 * l'ancien nom serait refuser notre propre compte. Ce qu'on écarte, c'est un
 * compte TIERS — pas notre histoire.
 */
export function expectedAccountHandles(inbound: {
  readonly accountHandle: string | null;
  readonly formerAccountHandles: readonly string[];
}): readonly string[] {
  const all = [inbound.accountHandle, ...inbound.formerAccountHandles]
    .map((handle) => normalizeInstagramHandle(handle))
    .filter((handle): handle is string => handle !== null);
  return Array.from(new Set(all));
}

/**
 * L'unique chemin entre un navigateur ouvert et un `InstagramSessionState`.
 *
 * Le bootstrap manuel et le rail passent tous les deux par ici. C'était
 * précisément le défaut corrigé : le bootstrap se contentait d'un cookie là où
 * le rail lisait la page, si bien que « connecté » n'avait pas le même sens des
 * deux côtés du même profil navigateur.
 */
async function observePageState(input: {
  context: BrowserContext;
  page: Page;
  hadSessionCookies: boolean;
  /** Les handles qui sont nous. Vide = aucune vérification d'identité. */
  expectedHandles?: readonly string[];
}): Promise<{ state: InstagramSessionState; detail: string }> {
  const { context, page } = input;
  const [text, cookieNames, captchaWidgets, authenticatedMarkers, loginControls, connectedHandle] = await Promise.all([
    readVisibleTextOf(page),
    context
      .cookies(INSTAGRAM_ROOT)
      .then((list) => list.map((cookie) => cookie.name))
      .catch(() => [] as string[]),
    countMatches(page, CAPTCHA_WIDGET_SELECTOR),
    countMatches(page, AUTHENTICATED_MARKER_SELECTOR),
    countMatches(page, LOGIN_CONTROL_SELECTOR),
    readConnectedHandle(page),
  ]);

  return classifyPageState({
    finalUrl: page.url(),
    text,
    captchaWidgets,
    authenticatedMarkers,
    loginControls,
    hasSessionCookies: cookieNames.some((name) => SESSION_COOKIE_NAMES.includes(name)),
    hadSessionCookies: input.hadSessionCookies,
    connectedHandle,
    expectedHandles: input.expectedHandles ?? [],
  });
}

/**
 * Relit la page tant que son état reste INDÉTERMINÉ, et pas une seconde de plus.
 *
 * Ce n'est pas une temporisation de confort : Instagram monte son interface
 * après `domcontentloaded`, si bien qu'une page à peine chargée n'expose encore
 * ni barre de navigation authentifiée, ni formulaire de connexion. Conclure à
 * cet instant revient à conclure sur du vide. La boucle s'arrête sur la
 * PREMIÈRE réponse concluante, dans un sens comme dans l'autre — une session
 * prête sort au premier tour, un mur de connexion aussi — et si rien ne se
 * décide avant la borne, `UNKNOWN` reste `UNKNOWN`, donc refuse.
 */
async function settlePageState(input: {
  context: BrowserContext;
  page: Page;
  hadSessionCookies: boolean;
  /**
   * Les handles qui sont nous, relayés tels quels à chaque relecture.
   *
   * La boucle ci-dessous reprend tant que l'état vaut `UNKNOWN`, et un compte
   * connecté illisible EST un `UNKNOWN` : l'avatar de la barre de navigation
   * arrive après `domcontentloaded`, comme le reste de l'interface. Une
   * identité qu'on n'a pas encore pu lire a donc le même sursis que le reste,
   * et pas une seconde de plus.
   */
  expectedHandles?: readonly string[];
}): Promise<{ state: InstagramSessionState; detail: string }> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let seen = await observePageState(input);
  while (seen.state === 'UNKNOWN' && Date.now() < deadline) {
    await input.page.waitForTimeout(SETTLE_POLL_MS);
    seen = await observePageState(input);
  }
  return seen;
}

/**
 * Le rail réel. Une instance = une session navigateur = une exécution du
 * worker.
 */
export class PlaywrightInstagramRail implements InstagramReadOnlyRail {
  protected readonly options: PlaywrightRailOptions;
  protected readonly log: ReturnType<typeof logger.child>;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  /**
   * Le bail du profil, tenu EXACTEMENT aussi longtemps que Chromium.
   *
   * Pris avant le lancement, rendu dans `close()` — et pas seulement autour de
   * `launchPersistentContext` : un navigateur ouvert continue d'écrire dans le
   * profil entre deux navigations, donc un bail rendu plus tôt serait un
   * mensonge parfaitement crédible.
   */
  private lease: InstagramBrowserLease | null = null;
  /** Constaté à l'ouverture, avant toute navigation : sert à distinguer expiré de jamais connecté. */
  protected hadSessionCookies = false;

  constructor(options: PlaywrightRailOptions) {
    this.options = options;
    this.log = logger.child({ rail: 'instagram', workerId: options.workerId });
  }

  protected get headless(): boolean {
    return this.options.headless ?? this.options.config.session.headless;
  }

  /**
   * IG2 — la garde réseau installée sur le contexte, et la liste blanche de
   * navigation, rendues surchargeables.
   *
   * Deux méthodes plutôt qu'une option de construction : une option se passe
   * (donc s'oublie, ou se passe de trop loin), une surcharge demande d'écrire
   * une sous-classe. Le rail LIVE en écrit une, et c'est le SEUL endroit du
   * dépôt où la garde des messages directs est assouplie — visible dans un
   * `extends`, pas dans un booléen.
   */
  protected requestClassifier(): (request: { url: string; method: string; postData: string | null }) => GuardDecision {
    return classifyInstagramRequest;
  }

  protected isNavigable(url: string): boolean {
    return isAllowedNavigation(url);
  }

  protected async open(): Promise<{ context: BrowserContext; page: Page }> {
    if (this.context && this.page) return { context: this.context, page: this.page };

    // Le bail AVANT tout le reste, y compris avant de charger Playwright : si
    // le profil est tenu par l'autre runtime, il n'y a aucune raison d'avoir
    // importé un module de navigateur, ni même d'exiger qu'il soit installé.
    const lease = leaseProfileOrThrow(this.options.config.session.profileDir);

    let chromium: PlaywrightModule['chromium'];
    try {
      ({ chromium } = await loadPlaywright());
    } catch (error) {
      lease.release();
      throw error;
    }
    const userDataDir = resolve(process.cwd(), this.options.config.session.profileDir);
    ensureDir(userDataDir);

    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(userDataDir, {
        headless: this.headless,
        locale: this.options.config.session.locale,
        timezoneId: this.options.config.session.timezoneId,
        viewport: { width: 1280, height: 900 },
      });
    } catch (error) {
      // Un lancement raté ne laisse pas un bail derrière lui : sinon la
      // première panne de navigateur fermerait le profil à l'autre rail
      // jusqu'à la fin du processus.
      lease.release();
      throw new InstagramRailError('IG_BROWSER_LAUNCH_FAILED', 'le navigateur n’a pas pu démarrer', { cause: error });
    }
    this.lease = lease;
    // HERMES-END-TO-END-CERTIFICATION-R1 — le contexte est ADOPTÉ dès qu'il
    // existe, pas à la fin de la mise en place.
    //
    // Il était affecté après `cookies()`, `installGuard()` et `newPage()`. Une
    // de ces trois qui lève laissait `this.context` à `null` et `this.lease`
    // rempli : `close()` relâchait alors le bail — il ne lit que ces deux
    // champs — sans fermer le Chromium, qui continuait d'écrire dans le profil
    // que le bail venait de déclarer libre. Le rail suivant pouvait
    // l'acquérir et ouvrir un SECOND navigateur sur le même `userDataDir`.
    //
    // Adopter tout de suite rend `close()` capable de fermer ce qu'il a ouvert,
    // quelle que soit l'étape qui a échoué. Rien d'autre ne change : `page`
    // reste affecté après, parce qu'il n'existe pas encore.
    this.context = context;

    context.setDefaultNavigationTimeout(this.options.config.session.navigationTimeoutMs);
    context.setDefaultTimeout(this.options.config.session.navigationTimeoutMs);

    // Constat AVANT toute navigation. Seuls les noms sont regardés ; aucune
    // valeur n'est lue, copiée ni journalisée.
    const cookies = await context.cookies(INSTAGRAM_ROOT);
    this.hadSessionCookies = cookies.some((cookie) => SESSION_COOKIE_NAMES.includes(cookie.name));

    await installGuard(context, this.requestClassifier(), this.log);

    const existing = context.pages()[0];
    const page = existing ?? (await context.newPage());

    this.page = page;
    return { context, page };
  }

  /**
   * Navigation, et le seul endroit du rail qui en fait une.
   *
   * La liste blanche est vérifiée AVANT l'appel, pas après : une URL refusée ne
   * doit pas être chargée puis regrettée. Un appelant qui tenterait
   * `/direct/inbox/` obtient une erreur de rail, et la garde réseau refuserait
   * la requête de toute façon.
   */
  protected async navigate(page: Page, url: string): Promise<void> {
    if (!this.isNavigable(url)) {
      throw new InstagramRailError(
        'IG_RAIL_ERROR',
        `navigation refusée vers « ${url} » — le rail ne connaît que la racine et une page de profil`,
      );
    }
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    } catch (error) {
      throw new InstagramRailError('IG_NAVIGATION_FAILED', `navigation échouée vers ${url}`, { cause: error });
    }
  }

  protected async hasSessionCookies(context: BrowserContext): Promise<boolean> {
    const cookies = await context.cookies(INSTAGRAM_ROOT);
    return cookies.some((cookie) => SESSION_COOKIE_NAMES.includes(cookie.name));
  }

  /** Texte VISIBLE de la page, borné. Voir `readVisibleTextOf`. */
  protected async readVisibleText(page: Page): Promise<string> {
    return readVisibleTextOf(page);
  }

  /** Compte les widgets de vérification réellement présents. 0 en cas de doute. */
  protected async countCaptchaWidgets(page: Page): Promise<number> {
    return countMatches(page, CAPTCHA_WIDGET_SELECTOR);
  }

  /**
   * La page courante annonce-t-elle qu'un profil n'existe pas ?
   *
   * Les MÊMES marqueurs que ceux d'`openProfile` — « ce profil est introuvable »
   * n'est pas un état de SESSION (`InstagramSessionState` n'en a pas, et c'est
   * juste : la session peut être parfaitement valide devant un handle qui n'a
   * jamais existé ou qui a été renommé). Exposée aux sous-classes parce que le
   * rail d'inspection en a besoin pour distinguer deux `UNKNOWN` que rien ne
   * distinguait : « je n'ai pas pu lire l'en-tête de notre profil » et « notre
   * profil n'est pas là ». Le premier attend, le second demande un humain.
   *
   * Une lecture impossible rend `false` : ne pas avoir vu le marqueur n'est pas
   * l'avoir vu.
   */
  protected async isProfileMissing(page: Page): Promise<boolean> {
    return firstMatch(await this.readVisibleText(page), MISSING_PROFILE_MARKERS);
  }

  /**
   * Relit l'état de la page COURANTE, quelle qu'elle soit.
   *
   * Factorisé pour que le rail LIVE relise la session au même endroit et avec
   * les mêmes marqueurs qu'une lecture de profil : un mur de connexion ou un
   * challenge qui n'apparaîtrait que dans un fil de discussion serait sinon lu
   * par un second classifieur, plus indulgent parce qu'écrit plus tard.
   */
  protected async classifyCurrentPage(
    context: BrowserContext,
    page: Page,
  ): Promise<{ state: InstagramSessionState; detail: string }> {
    return settlePageState({
      context,
      page,
      hadSessionCookies: this.hadSessionCookies,
      expectedHandles: expectedAccountHandles(this.options.config.inbound),
    });
  }

  async ensureSession(): Promise<InstagramSessionStatus> {
    const { context, page } = await this.open();
    await this.navigate(page, INSTAGRAM_ROOT);

    const classified = await this.classifyCurrentPage(context, page);

    this.log.info('instagram.session.state', {
      state: classified.state,
      profileLabel: this.options.config.session.profileLabel,
      headless: this.headless,
    });

    return {
      state: classified.state,
      detail: classified.detail,
      profileLabel: this.options.config.session.profileLabel,
      headless: this.headless,
    };
  }

  async openProfile(handle: string): Promise<InstagramProfileObservation> {
    const normalized = normalizeHandle(handle);
    if (normalized === null) {
      throw new InstagramRailError('IG_RAIL_ERROR', `handle Instagram invalide : « ${handle} »`);
    }
    const requestedUrl = profileUrl(normalized);
    const started = Date.now();

    const { context, page } = await this.open();
    await this.navigate(page, requestedUrl);

    // Le MÊME classifieur que `ensureSession`, sur la même page, et non une
    // seconde lecture écrite à part : une page de profil qui redemande une
    // connexion doit le dire avec les mots du rail, pas avec les siens.
    const sessionState = (await this.classifyCurrentPage(context, page)).state;
    const text = await this.readVisibleText(page);
    const finalUrl = page.url();

    const signals = await this.collectIdentitySignals(page, finalUrl);
    // IG2.2 §2 — lue sur la page déjà ouverte, donc sans navigation
    // supplémentaire. Une panne rend « non lu », jamais « ne suit pas ».
    const relationship = await readRelationship(page);
    const screenshotPath = await this.capture(page, normalized);

    return {
      requestedUrl,
      finalUrl,
      redirected: finalUrl.replace(/\/+$/, '') !== requestedUrl.replace(/\/+$/, ''),
      profileMissing: firstMatch(text, MISSING_PROFILE_MARKERS),
      sessionState,
      signals,
      relationship,
      screenshotPath,
      durationMs: Date.now() - started,
    };
  }

  /**
   * Collecte les trois indices d'identité, indépendamment les uns des autres.
   *
   * Chacun peut échouer sans faire échouer les autres : un indice absent vaut
   * `null` (« non lu »), jamais une valeur de repli. C'est `decideIdentity` qui
   * tranche ensuite, et lui seul — ce module observe, il ne conclut pas.
   */
  private async collectIdentitySignals(page: Page, finalUrl: string): Promise<InstagramIdentitySignal[]> {
    const signals: InstagramIdentitySignal[] = [
      { name: 'canonical_url', handle: handleFromProfileUrl(finalUrl), raw: finalUrl },
    ];

    const ogUrl = await page
      .getAttribute('meta[property="og:url"]', 'content', { timeout: 3_000 })
      .catch(() => null);
    signals.push({ name: 'og_url', handle: ogUrl === null ? null : handleFromProfileUrl(ogUrl), raw: ogUrl });

    // Plusieurs mises en page coexistent chez Instagram selon l'A/B en cours.
    // Le premier sélecteur qui rend un handle VALIDE gagne ; aucun ne fabrique
    // de valeur, et un texte qui n'a pas la forme d'un handle est ignoré.
    const headerSelectors = ['header h2', 'header h1', 'main header section h2', 'main header span'];
    let headerHandle: string | null = null;
    let headerRaw: string | null = null;
    for (const selector of headerSelectors) {
      const raw = await page.textContent(selector, { timeout: 2_000 }).catch(() => null);
      if (raw === null) continue;
      const candidate = normalizeHandle(raw);
      if (candidate !== null) {
        headerHandle = candidate;
        headerRaw = raw.slice(0, 120);
        break;
      }
      if (headerRaw === null) headerRaw = raw.slice(0, 120);
    }
    signals.push({ name: 'profile_header', handle: headerHandle, raw: headerRaw });

    return signals;
  }

  protected async capture(page: Page, handle: string): Promise<string | null> {
    const dir = this.options.screenshotDir;
    if (dir === null || dir === undefined) return null;
    try {
      ensureDir(dir);
      // Nom déterministe par handle et horodatage. Le fichier vit sous `var/`,
      // donc hors Git — une capture d'une session authentifiée montre un compte
      // connecté et n'a rien à faire dans un dépôt.
      const path = resolve(dir, `${handle}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
      await page.screenshot({ path, fullPage: false });
      return path;
    } catch (error) {
      this.log.warn('instagram.screenshot.failed', { detail: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  async close(): Promise<void> {
    const context = this.context;
    const lease = this.lease;
    this.context = null;
    this.page = null;
    this.lease = null;
    try {
      if (context) await context.close().catch(() => undefined);
    } finally {
      // Dans un `finally` : une fermeture qui lève laisserait sinon le profil
      // réputé occupé pour toujours, et l'autre rail attendrait un processus
      // qui, lui, a fini.
      lease?.release();
    }
  }
}

// ---------------------------------------------------------------------------
// Bootstrap manuel de session
// ---------------------------------------------------------------------------

export interface BootstrapResult {
  readonly state: InstagramSessionState;
  readonly detail: string;
  readonly profileDir: string;
}

/**
 * IG-R1 §1 — le bootstrap manuel : une fenêtre s'ouvre, un humain se connecte.
 *
 * Ce que cette fonction ne fait pas, et ne doit jamais faire : lire un
 * identifiant, saisir un mot de passe, résoudre un CAPTCHA, cliquer sur quoi
 * que ce soit. Elle ouvre le navigateur, attend, puis constate. Aucun
 * identifiant Instagram ne transite par ce dépôt — ni en variable
 * d'environnement, ni en configuration, ni en argument.
 *
 * La garde d'effets reste installée : même ici, un DM, un follow ou un like ne
 * peut pas sortir du processus.
 */
export async function bootstrapInstagramSession(options: {
  config: InstagramRailConfig;
  workerId: string;
  waitMs: number;
}): Promise<BootstrapResult> {
  const log = logger.child({ rail: 'instagram', phase: 'bootstrap', workerId: options.workerId });

  // Le bail vaut ICI aussi, et c'est le cas où il compte le plus : une
  // reconnexion manuelle pendant qu'un runtime tient le profil écrirait les
  // cookies neufs sous les pieds d'un Chromium déjà ouvert, et la session
  // qu'un humain vient de refaire serait perdue en refermant l'autre.
  const lease = leaseProfileOrThrow(options.config.session.profileDir);

  let chromium: PlaywrightModule['chromium'];
  try {
    ({ chromium } = await loadPlaywright());
  } catch (error) {
    lease.release();
    throw error;
  }
  const userDataDir = resolve(process.cwd(), options.config.session.profileDir);
  ensureDir(userDataDir);

  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      // Toujours visible : c'est un humain qui agit, pas le rail.
      headless: false,
      locale: options.config.session.locale,
      timezoneId: options.config.session.timezoneId,
      viewport: { width: 1280, height: 900 },
    });
  } catch (error) {
    lease.release();
    throw new InstagramRailError('IG_BROWSER_LAUNCH_FAILED', 'le navigateur n’a pas pu démarrer', { cause: error });
  }

  try {
    // Constat AVANT navigation : distingue un profil neuf d'un profil qui a
    // été connecté et ne l'est plus. Seuls les NOMS sont regardés.
    const cookiesAtLaunch = await context.cookies(INSTAGRAM_ROOT).catch(() => []);
    const hadSessionCookies = cookiesAtLaunch.some((cookie) => SESSION_COOKIE_NAMES.includes(cookie.name));

    await installGuard(context, classifyBootstrapRequest, log);
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(INSTAGRAM_ROOT, { waitUntil: 'domcontentloaded' });

    log.info('instagram.bootstrap.waiting', { waitMs: options.waitMs, hadSessionCookies });

    /**
     * Attente passive — de l'ÉTAT de la page, jamais d'un cookie seul.
     *
     * Ce qu'était ce code, et pourquoi il mentait : il sortait de la boucle dès
     * qu'un cookie de session apparaissait dans le profil. Or un cookie périmé
     * y est présent DÈS LA PREMIÈRE ITÉRATION, laissé par la session
     * précédente — la boucle rendait donc la main immédiatement, sans que
     * personne se soit connecté, et sans avoir laissé à Instagram le temps de
     * servir son mur de connexion. La page était encore à la racine, son texte
     * français ne déclenchait aucun marqueur anglophone, et le bootstrap
     * annonçait `SESSION_READY` sur un écran de login. Le prix de ce mensonge
     * se payait bien plus loin, en `IG_SEND_COMPOSER_NOT_FOUND`.
     *
     * Ce qu'il est devenu : la boucle attend une PREUVE au sens de
     * `classifyPageState`, et rien d'autre ne la fait sortir tôt qu'un blocage
     * annoncé par Instagram. Un CAPTCHA ou un challenge ne l'interrompent pas :
     * ce sont des étapes normales d'une connexion humaine, et c'est justement
     * cette fenêtre qui est ouverte pour qu'un humain les traverse. Rien ici
     * n'est cliqué, saisi ni résolu.
     */
    const deadline = Date.now() + options.waitMs;
    /**
     * `SESSION_WRONG_ACCOUNT` ne sort PAS de cette boucle, délibérément.
     *
     * La fenêtre est ouverte pour qu'un humain s'y connecte ; s'être connecté
     * sous le mauvais compte est une étape ordinaire de ce geste, pas une
     * issue. Laisser la boucle tourner permet de se déconnecter et de
     * recommencer dans la MÊME fenêtre, et la sortie se fait alors sur un
     * `SESSION_READY` authentique. Si personne ne corrige, la borne finit par
     * échoir et l'état rendu nomme le compte trouvé.
     */
    const expectedHandles = expectedAccountHandles(options.config.inbound);
    let classified = await observePageState({ context, page, hadSessionCookies, expectedHandles });
    while (
      Date.now() < deadline &&
      classified.state !== 'SESSION_READY' &&
      classified.state !== 'BLOCKED'
    ) {
      await new Promise((r) => setTimeout(r, 2_000));
      classified = await observePageState({ context, page, hadSessionCookies, expectedHandles });
    }

    return { state: classified.state, detail: classified.detail, profileDir: options.config.session.profileDir };
  } finally {
    try {
      await context.close().catch(() => undefined);
    } finally {
      lease.release();
    }
  }
}
