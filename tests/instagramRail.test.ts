import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { instagramRailSchema } from '@/lib/config/schema';
import { loadInstagramRail } from '@/lib/config/load';
import { decideIdentity, handleFromProfileUrl, normalizeHandle, profileUrl } from '@/lib/instagram/identity';
import {
  classifyBootstrapRequest,
  classifyInstagramRequest,
  isAllowedNavigation,
} from '@/lib/instagram/readOnlyGuard';
import { classifyPageState } from '@/lib/instagram/playwrightRail';
import { deriveInstagramIdempotencyKey } from '@/lib/instagram/queue';
import { evaluateSafety, DEFAULT_KILL_SWITCH, type SafetySnapshot } from '@/lib/instagram/safety';
import {
  HARD_STOP_SESSION_STATES,
  isHardStopSessionState,
  isUsableSessionState,
  INSTAGRAM_SESSION_STATES,
  TERMINAL_JOB_STATUSES,
  CLAIMABLE_JOB_STATUSES,
  SKIP_REASON_CLASS,
  skipClassOf,
} from '@/lib/instagram/types';
import { hasLiveAdapter, LIVE_CAPABLE_TRANSPORTS, liveCapableTransports } from '@/lib/pipeline/r6bTransportAdapters';
import { hasSendPrimitive, type InstagramReadOnlyRail } from '@/lib/instagram/rail';

/**
 * IG-R1 §9 — la partie du rail qui se prouve sans base ni navigateur.
 *
 * Aucun test de ce fichier n'ouvre Instagram, et plusieurs vérifient qu'il n'y
 * a rien à ouvrir : ni adapter d'envoi, ni méthode d'action sur le rail, ni
 * requête d'effet capable de sortir du processus.
 */

const ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe('configuration du rail', () => {
  it('charge config/instagram.json et le valide', () => {
    const config = loadInstagramRail();
    expect(config.session.profileDir).toBe('var/instagram/profile');
    expect(config.caps.dailySentCap).toBeGreaterThan(0);
    expect(config.queue.leaseMs).toBeGreaterThanOrEqual(30_000);
  });

  it('refuse un profil navigateur hors de var/ — un profil commité serait un secret publié', () => {
    const parsed = instagramRailSchema.safeParse({
      session: { profileDir: 'src/instagram-profile' },
      caps: {},
      queue: {},
    });
    expect(parsed.success).toBe(false);
  });

  it('exige les trois sections — un rail sans plafonds ne démarre pas sur des valeurs implicites', () => {
    expect(instagramRailSchema.safeParse({}).success).toBe(false);
    expect(instagramRailSchema.safeParse({ session: {}, caps: {}, queue: {} }).success).toBe(true);
  });

  it('le répertoire de profil configuré est bien ignoré par Git', () => {
    const gitignore = readFileSync(resolve(ROOT, '.gitignore'), 'utf8');
    const config = loadInstagramRail();
    expect(config.session.profileDir.startsWith('var/')).toBe(true);
    expect(gitignore).toMatch(/^var\/$/m);
  });
});

// ---------------------------------------------------------------------------
// Incapacité structurelle d'envoyer
// ---------------------------------------------------------------------------

describe('DRY-RUN structurellement incapable d’envoyer', () => {
  it('l’adapter LIVE instagram_dm existe depuis IG2, et seuls email + instagram_dm en ont un', () => {
    // Ce test disait l'inverse jusqu'à IG2, et le changement EST la revue : un
    // transport ne devient envoyable que par un diff sur cette ligne.
    expect(LIVE_CAPABLE_TRANSPORTS.instagram_dm).toBe(true);
    expect(hasLiveAdapter('instagram_dm')).toBe(true);
    expect([...liveCapableTransports()].sort()).toEqual(['email', 'instagram_dm']);
    for (const transport of ['facebook_dm', 'web_form', 'sms', 'whatsapp', 'phone_call'] as const) {
      expect(hasLiveAdapter(transport), transport).toBe(false);
    }
  });

  it('le contrat de LECTURE n’expose toujours aucune primitive d’action', () => {
    // Le type le garantit à la compilation ; ce test le garantit à la lecture,
    // pour qu'un ajout de méthode casse un test nommé plutôt qu'un type diffus.
    // IG2 a ajouté une primitive d'envoi — dans un contrat SÉPARÉ
    // (`InstagramLiveRail`), précisément pour que celui-ci reste vrai.
    const shape: Record<keyof InstagramReadOnlyRail, true> = {
      ensureSession: true,
      openProfile: true,
      close: true,
    };
    expect(Object.keys(shape).sort()).toEqual(['close', 'ensureSession', 'openProfile']);
    for (const forbidden of ['sendDm', 'sendMessage', 'sendFirstTouchDm', 'click', 'type', 'fill', 'follow', 'like']) {
      expect(Object.keys(shape)).not.toContain(forbidden);
    }
  });

  it('le rail de lecture ne contient aucun geste d’interaction', () => {
    const source = readFileSync(resolve(ROOT, 'src/lib/instagram/playwrightRail.ts'), 'utf8');
    // `goto` reste la seule action autorisée sur une page DANS CE FICHIER. Tout
    // geste capable d'agir vit dans `playwrightLiveRail.ts`, et nulle part
    // ailleurs.
    for (const forbidden of ['.click(', '.fill(', '.type(', '.press(', '.tap(', '.dblclick(', '.setInputFiles(']) {
      expect(source, `geste interdit trouvé : ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('le worker DRY-RUN refuse un rail capable d’agir', () => {
    // La garde a changé de forme en IG2 : elle interrogeait une constante
    // globale du dépôt, elle interroge maintenant l'objet reçu.
    const readOnly: InstagramReadOnlyRail = {
      ensureSession: async () => {
        throw new Error('non appelé');
      },
      openProfile: async () => {
        throw new Error('non appelé');
      },
      close: async () => undefined,
    };
    expect(hasSendPrimitive(readOnly)).toBe(false);
    expect(hasSendPrimitive({ ...readOnly, sendFirstTouchDm: async () => ({}) } as never)).toBe(true);
  });

  it('les modules DRY-RUN n’écrivent toujours pas dans outreach_events', () => {
    // `liveWorker.ts` en écrit un, et lui seul : c'est la contrepartie d'un
    // envoi prouvé. Aucun module du chemin de vérification n'y touche.
    const dir = resolve(ROOT, 'src/lib/instagram');
    for (const file of ['worker.ts', 'events.ts', 'queue.ts', 'safety.ts', 'playwrightRail.ts', 'identity.ts', 'canary.ts', 'playwrightLiveRail.ts']) {
      const source = readFileSync(resolve(dir, file), 'utf8');
      expect(source, `${file} mentionne outreach_events`).not.toMatch(/insert\s+into\s+outreach_events/i);
    }
    const live = readFileSync(resolve(dir, 'liveWorker.ts'), 'utf8');
    expect(live.match(/insert into outreach_events/gi)?.length ?? 0).toBe(1);
  });

  it('le CLI DRY-RUN n’offre aucune option --live', () => {
    const source = readFileSync(resolve(ROOT, 'src/cli/ig-dry-run.ts'), 'utf8');
    expect(source).not.toMatch(/case '--live'/);
  });
});

// ---------------------------------------------------------------------------
// Garde réseau
// ---------------------------------------------------------------------------

describe('garde réseau lecture seule', () => {
  const guard = (url: string, method = 'GET', postData: string | null = null) =>
    classifyInstagramRequest({ url, method, postData });

  it('laisse passer les lectures GET', () => {
    expect(guard('https://www.instagram.com/demo_prospect_a/').allowed).toBe(true);
    expect(guard('https://static.cdninstagram.com/asset.js').allowed).toBe(true);
  });

  it('refuse l’envoi d’un DM, quelle que soit la méthode', () => {
    for (const method of ['POST', 'GET', 'PUT', 'PATCH', 'DELETE']) {
      const decision = guard('https://www.instagram.com/api/v1/direct_v2/threads/broadcast/text/', method);
      expect(decision.allowed, `${method} devrait être refusé`).toBe(false);
      if (!decision.allowed) expect(decision.rule).toBe('effect_path');
    }
  });

  it('refuse follow, like, commentaire et modification de profil', () => {
    const effects = [
      'https://www.instagram.com/api/v1/friendships/create/123/',
      'https://www.instagram.com/api/v1/web/likes/123/like/',
      'https://www.instagram.com/api/v1/web/comments/123/add/',
      'https://www.instagram.com/api/v1/accounts/edit/',
      'https://www.instagram.com/direct/inbox/',
    ];
    for (const url of effects) {
      expect(guard(url, 'POST').allowed, url).toBe(false);
    }
  });

  it('refuse par défaut toute écriture non nommée', () => {
    const decision = guard('https://www.instagram.com/api/v1/something/new/', 'POST');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.rule).toBe('write_method');
  });

  it('laisse passer les lectures GraphQL, refuse les mutations', () => {
    expect(guard('https://www.instagram.com/api/graphql', 'POST', 'fb_api_req_friendly_name=PolarisProfilePageContentQuery').allowed).toBe(
      true,
    );
    const mutation = guard(
      'https://www.instagram.com/api/graphql',
      'POST',
      'fb_api_req_friendly_name=useDirectMessageSendMutation',
    );
    expect(mutation.allowed).toBe(false);
    if (!mutation.allowed) expect(mutation.rule).toBe('graphql_effect');
    expect(guard('https://www.instagram.com/api/graphql', 'POST', 'variables={"direct_v2":1}').allowed).toBe(false);
  });

  it('le bootstrap assouplit les écritures mais jamais les effets', () => {
    const login = { url: 'https://www.instagram.com/api/v1/web/accounts/login/ajax/', method: 'POST', postData: null };
    expect(classifyInstagramRequest(login).allowed).toBe(false);
    expect(classifyBootstrapRequest(login).allowed).toBe(true);

    const dm = {
      url: 'https://www.instagram.com/api/v1/direct_v2/threads/broadcast/text/',
      method: 'POST',
      postData: null,
    };
    expect(classifyBootstrapRequest(dm).allowed).toBe(false);
  });

  it('n’accepte de naviguer que vers la racine et une page de profil', () => {
    expect(isAllowedNavigation('https://www.instagram.com/')).toBe(true);
    expect(isAllowedNavigation('https://www.instagram.com/demo_prospect_a/')).toBe(true);
    expect(isAllowedNavigation('https://www.instagram.com/direct/inbox/')).toBe(false);
    expect(isAllowedNavigation('https://www.instagram.com/demo_prospect_a/?next=1')).toBe(false);
    expect(isAllowedNavigation('http://www.instagram.com/demo_prospect_a/')).toBe(false);
    expect(isAllowedNavigation('https://evil.example/demo_prospect_a/')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// État de session
// ---------------------------------------------------------------------------

describe('état de session', () => {
  const page = (over: Partial<Parameters<typeof classifyPageState>[0]> = {}) =>
    classifyPageState({
      finalUrl: 'https://www.instagram.com/',
      text: 'Accueil Recherche Explorer',
      captchaWidgets: 0,
      // Le défaut décrit une page RÉELLEMENT authentifiée : la barre de
      // navigation d'un compte connecté est là, le formulaire de connexion
      // n'y est pas. Un test qui veut l'inverse le dit explicitement.
      authenticatedMarkers: 1,
      loginControls: 0,
      hasSessionCookies: true,
      hadSessionCookies: true,
      ...over,
    });

  it('SESSION_READY quand la session tient', () => {
    expect(page().state).toBe('SESSION_READY');
  });

  it('LOGIN_REQUIRED sur un profil neuf, SESSION_EXPIRED sur un profil qui l’était', () => {
    const url = 'https://www.instagram.com/accounts/login/';
    expect(page({ finalUrl: url, hasSessionCookies: false, hadSessionCookies: false }).state).toBe('LOGIN_REQUIRED');
    expect(page({ finalUrl: url, hasSessionCookies: false, hadSessionCookies: true }).state).toBe('SESSION_EXPIRED');
  });

  it('CHALLENGE, CAPTCHA et BLOCKED sont reconnus et sont des arrêts durs', () => {
    expect(page({ finalUrl: 'https://www.instagram.com/challenge/AB/CD/' }).state).toBe('CHALLENGE');
    expect(page({ text: 'Please complete the reCAPTCHA to continue' }).state).toBe('CAPTCHA');
    expect(page({ text: 'Your account has been temporarily blocked' }).state).toBe('BLOCKED');
    expect(page({ text: 'Votre compte a été temporairement bloqué' }).state).toBe('BLOCKED');

    for (const state of HARD_STOP_SESSION_STATES) {
      expect(isHardStopSessionState(state)).toBe(true);
      expect(isUsableSessionState(state)).toBe(false);
    }
  });

  it('un widget de vérification suffit à déclarer CAPTCHA, même sans texte', () => {
    expect(page({ captchaWidgets: 1 }).state).toBe('CAPTCHA');
  });

  /**
   * Régression trouvée par le PREMIER smoke réel (IG-R1 §10).
   *
   * `page.textContent('body')` inclut le contenu des balises `<script>`. Le
   * bootstrap d'Instagram y énumère des noms de services tiers — dont
   * `arkose_captcha` et `google_recaptcha` — si bien qu'une page d'accueil
   * parfaitement ordinaire, sans le moindre widget, se classait en `CAPTCHA`,
   * c'est-à-dire en ARRÊT DUR.
   *
   * Le rail lit désormais `innerText` (texte visible seulement) et se fie au
   * widget. Le fragment ci-dessous est copié tel quel de la page réellement
   * servie le 13 août 2026.
   */
  it('ne confond pas une liste de services dans du JavaScript avec un CAPTCHA', () => {
    const scriptBlob =
      '"advertiser_hosted_pixel","affirm_prequal_iframe","airbus_sat","amazon_media",' +
      '"apple_music_sdk","arkose_captcha","aspnet_cdn","bing_maps","google_oauth_api",' +
      '"google_recaptcha","here_map_ext","ipification","jquery","klarna_prequal_iframe"';

    // Ce que `textContent` rendait : le blob. Aucun widget sur la page.
    const verdict = page({ text: scriptBlob, captchaWidgets: 0, hasSessionCookies: false, hadSessionCookies: false });
    expect(verdict.state).not.toBe('CAPTCHA');
    expect(verdict.state).toBe('LOGIN_REQUIRED');
  });

  it('un blocage prime sur un mur de connexion — la gravité l’emporte', () => {
    const state = page({
      finalUrl: 'https://www.instagram.com/accounts/login/',
      text: 'Log in to Instagram — your account has been temporarily blocked',
      hasSessionCookies: false,
      hadSessionCookies: false,
    }).state;
    expect(state).toBe('BLOCKED');
  });

  // -------------------------------------------------------------------------
  // Régression du 20 août 2026 — un cookie n'est pas une session
  // -------------------------------------------------------------------------
  //
  // Constaté sur le profil réel `var/instagram/profile` : le bootstrap
  // annonçait `SESSION_READY` alors que le navigateur affichait le mur de
  // connexion. Le cookie `sessionid` de la session précédente survivait dans le
  // profil persistant, et `classifyPageState` concluait à l'authentification
  // par ÉLIMINATION — cookie présent, aucun marqueur de connexion reconnu, du
  // texte à l'écran. Trois absences ne font pas une présence.
  //
  // Deux aggravations rendaient l'élimination systématique en usage réel :
  // le navigateur tourne en `fr-FR` et les marqueurs textuels étaient
  // anglophones ; et le libellé français du champ de connexion vit dans un
  // attribut `placeholder`, que `innerText` ne rend pas. Le mensonge ne se
  // payait qu'au moment d'envoyer, en `IG_SEND_COMPOSER_NOT_FOUND`.
  //
  // La correction est une PREUVE positive : une affordance qu'Instagram ne
  // rend qu'à un compte connecté. Sans elle, l'état reste indéterminé.
  describe('un cookie de session ne prouve pas une session', () => {
    /** Le mur de connexion français, tel qu'il se présente : sans un mot anglais. */
    const FRENCH_LOGIN_TEXT =
      'Se connecter avec Facebook\nMot de passe oublié ?\nVous n’avez pas de compte ? Inscrivez-vous';

    it('1. cookie présent + page de connexion ⇒ PAS SESSION_READY', () => {
      const verdict = page({
        finalUrl: 'https://www.instagram.com/accounts/login/',
        text: FRENCH_LOGIN_TEXT,
        authenticatedMarkers: 0,
        loginControls: 2,
        hasSessionCookies: true,
        hadSessionCookies: true,
      });
      expect(verdict.state).not.toBe('SESSION_READY');
      expect(verdict.state).toBe('SESSION_EXPIRED');
      expect(isUsableSessionState(verdict.state)).toBe(false);
    });

    it('1bis. le cas EXACT du bug : cookie périmé, URL encore à la racine, texte français', () => {
      // Ce que voyait le bootstrap : Instagram sert son mur de connexion à la
      // racine et ne réécrit l'URL que plus tard, côté client. L'URL dit « / »,
      // le texte ne déclenche aucun marqueur anglophone, le cookie est là.
      // C'est cette page qui se classait `SESSION_READY`.
      const verdict = page({
        finalUrl: 'https://www.instagram.com/',
        text: FRENCH_LOGIN_TEXT,
        authenticatedMarkers: 0,
        loginControls: 2,
        hasSessionCookies: true,
        hadSessionCookies: true,
      });
      expect(verdict.state).not.toBe('SESSION_READY');
      expect(verdict.state).toBe('SESSION_EXPIRED');
    });

    it('2. cookie absent + page de connexion ⇒ PAS SESSION_READY', () => {
      const verdict = page({
        finalUrl: 'https://www.instagram.com/accounts/login/',
        text: FRENCH_LOGIN_TEXT,
        authenticatedMarkers: 0,
        loginControls: 2,
        hasSessionCookies: false,
        hadSessionCookies: false,
      });
      expect(verdict.state).not.toBe('SESSION_READY');
      expect(verdict.state).toBe('LOGIN_REQUIRED');
    });

    it('3. cookie présent + preuve d’authentification à l’écran ⇒ SESSION_READY', () => {
      const verdict = page({
        finalUrl: 'https://www.instagram.com/',
        text: 'Accueil Recherche Explorer Messages Notifications',
        authenticatedMarkers: 3,
        loginControls: 0,
        hasSessionCookies: true,
        hadSessionCookies: true,
      });
      expect(verdict.state).toBe('SESSION_READY');
      expect(isUsableSessionState(verdict.state)).toBe(true);
    });

    it('4. challenge et checkpoint sont bloqués explicitement, malgré une session par ailleurs valide', () => {
      for (const url of [
        'https://www.instagram.com/challenge/AB/CD/',
        'https://www.instagram.com/checkpoint/dismiss/',
      ]) {
        // Tout le reste dit « connecté » : cookie, marqueurs, aucun formulaire.
        // La demande d'Instagram l'emporte quand même, et c'est un arrêt dur.
        const verdict = page({ finalUrl: url, authenticatedMarkers: 5, loginControls: 0 });
        expect(verdict.state).toBe('CHALLENGE');
        expect(isHardStopSessionState(verdict.state)).toBe(true);
        expect(isUsableSessionState(verdict.state)).toBe(false);
      }
      expect(page({ finalUrl: 'https://www.instagram.com/accounts/suspended/' }).state).toBe('BLOCKED');
    });

    it('5. état indéterminé ⇒ fail closed, jamais SESSION_READY', () => {
      // a) Lecture partielle ou expirée : la page a rendu quelque chose, mais
      //    rien qui prouve quoi que ce soit. C'est le repli de `countMatches`
      //    quand la lecture échoue — il refuse, il n'autorise pas.
      const opaque = page({ text: 'Instagram', authenticatedMarkers: 0, loginControls: 0 });
      expect(opaque.state).toBe('UNKNOWN');
      expect(isUsableSessionState(opaque.state)).toBe(false);

      // b) Page vide (chargement non abouti, timeout de navigation).
      expect(page({ text: '', authenticatedMarkers: 0 }).state).toBe('UNKNOWN');

      // c) Le cookie ne rachète rien : même avec les deux cookies de session,
      //    aucune preuve à l'écran reste indéterminé.
      expect(
        page({ text: 'Instagram', authenticatedMarkers: 0, hasSessionCookies: true, hadSessionCookies: true }).state,
      ).not.toBe('SESSION_READY');
    });

    it('un formulaire de connexion l’emporte sur des marqueurs résiduels — fail closed', () => {
      // Un rendu intermédiaire peut laisser cohabiter les deux. Le doute
      // n'ouvre pas la porte.
      expect(page({ authenticatedMarkers: 2, loginControls: 1 }).state).not.toBe('SESSION_READY');
    });
  });

  it('UNKNOWN n’est jamais utilisable', () => {
    expect(page({ text: '   ' }).state).toBe('UNKNOWN');
    expect(isUsableSessionState('UNKNOWN')).toBe(false);
    // Un seul état ouvre la porte, sur les sept.
    expect(INSTAGRAM_SESSION_STATES.filter(isUsableSessionState)).toEqual(['SESSION_READY']);
  });
});

// ---------------------------------------------------------------------------
// Identité
// ---------------------------------------------------------------------------

describe('vérification d’identité', () => {
  const signals = (over: Partial<Record<'canonical_url' | 'og_url' | 'profile_header', string | null>> = {}) =>
    [
      { name: 'canonical_url' as const, handle: over.canonical_url ?? 'demo_prospect_a', raw: 'url' },
      { name: 'og_url' as const, handle: over.og_url ?? 'demo_prospect_a', raw: 'og' },
      { name: 'profile_header' as const, handle: over.profile_header ?? 'demo_prospect_a', raw: 'header' },
    ];

  it('normalise la casse mais rien d’autre', () => {
    expect(normalizeHandle('Demo_Prospect_A')).toBe('demo_prospect_a');
    expect(normalizeHandle('@example_services_')).toBe('example_services_');
    expect(normalizeHandle('detail car')).toBeNull();
    expect(normalizeHandle('a'.repeat(31))).toBeNull();
    // Un point EST significatif : deux handles distincts restent distincts.
    expect(normalizeHandle('demo_account_29')).not.toBe(normalizeHandle('demo_account_31'));
  });

  it('extrait un handle d’une URL de profil et refuse tout le reste', () => {
    expect(handleFromProfileUrl('https://www.instagram.com/demo_prospect_a/')).toBe('demo_prospect_a');
    expect(handleFromProfileUrl('https://www.instagram.com/accounts/login/')).toBeNull();
    expect(handleFromProfileUrl('https://www.instagram.com/direct/inbox/')).toBeNull();
    expect(handleFromProfileUrl('https://www.instagram.com/p/ABC123/')).toBeNull();
    expect(handleFromProfileUrl('https://evil.example/demo_prospect_a/')).toBeNull();
    expect(profileUrl('Demo_Prospect_A')).toBe('https://www.instagram.com/demo_prospect_a/');
  });

  it('MATCH quand tous les indices concordent', () => {
    const decision = decideIdentity({
      expectedHandle: 'demo_prospect_a',
      signals: signals(),
      profileMissing: false,
      redirected: false,
    });
    expect(decision.verdict).toBe('MATCH');
    expect(decision.observedHandle).toBe('demo_prospect_a');
  });

  it('MISMATCH dès qu’un seul indice diverge, même si les autres concordent', () => {
    const decision = decideIdentity({
      expectedHandle: 'demo_prospect_a',
      signals: signals({ profile_header: 'demo_prospect_a_officiel' }),
      profileMissing: false,
      redirected: false,
    });
    expect(decision.verdict).toBe('MISMATCH');
  });

  it('NOT_FOUND quand le profil n’existe pas', () => {
    const decision = decideIdentity({
      expectedHandle: 'demo_prospect_a',
      signals: [],
      profileMissing: true,
      redirected: false,
    });
    expect(decision.verdict).toBe('NOT_FOUND');
  });

  it('UNAVAILABLE quand rien n’a pu être lu — jamais un MATCH par défaut', () => {
    const decision = decideIdentity({
      expectedHandle: 'demo_prospect_a',
      signals: [
        { name: 'canonical_url', handle: null, raw: null },
        { name: 'og_url', handle: null, raw: null },
        { name: 'profile_header', handle: null, raw: null },
      ],
      profileMissing: false,
      redirected: false,
    });
    expect(decision.verdict).toBe('UNAVAILABLE');
    expect(decision.observedHandle).toBeNull();
  });

  /**
   * Régression trouvée par le PREMIER smoke réel (IG-R1 §10).
   *
   * Sur `https://www.instagram.com/zzqqxx.nonexistent12345/` — un compte qui
   * n'existe pas — Instagram ne redirige pas : il sert une page à l'URL
   * demandée. `canonical_url` valait donc le handle attendu, `og_url` et
   * `profile_header` étaient nuls, et le verdict rendu était `MATCH`.
   *
   * L'URL canonique est un ÉCHO de la requête : sans redirection elle ne peut
   * pas diverger, donc elle ne corrobore rien. Un `MATCH` exige désormais au
   * moins un indice VENANT DE LA PAGE.
   */
  it('ne confirme jamais une identité sur la seule URL demandée (profil supprimé)', () => {
    const decision = decideIdentity({
      expectedHandle: 'zzqqxx.nonexistent12345',
      signals: [
        { name: 'canonical_url', handle: 'zzqqxx.nonexistent12345', raw: 'https://www.instagram.com/zzqqxx.nonexistent12345/' },
        { name: 'og_url', handle: null, raw: null },
        { name: 'profile_header', handle: null, raw: null },
      ],
      profileMissing: false,
      redirected: false,
    });
    expect(decision.verdict).toBe('AMBIGUOUS');
    expect(decision.observedHandle).toBeNull();
    expect(decision.detail).toMatch(/indice de contenu/);
  });

  it('AMBIGUOUS sur une redirection corroborée par un seul indice de contenu — un compte renommé n’est pas confirmé', () => {
    const decision = decideIdentity({
      expectedHandle: 'demo_prospect_a',
      signals: [
        { name: 'canonical_url', handle: 'demo_prospect_a', raw: 'url' },
        { name: 'og_url', handle: 'demo_prospect_a', raw: 'og' },
        { name: 'profile_header', handle: null, raw: null },
      ],
      profileMissing: false,
      redirected: true,
    });
    expect(decision.verdict).toBe('AMBIGUOUS');
  });

  it('une redirection reste acceptable si deux indices indépendants concordent', () => {
    const decision = decideIdentity({
      expectedHandle: 'Demo_Prospect_A',
      signals: signals(),
      profileMissing: false,
      redirected: true,
    });
    expect(decision.verdict).toBe('MATCH');
  });
});

// ---------------------------------------------------------------------------
// Idempotence
// ---------------------------------------------------------------------------

describe('clé d’idempotence', () => {
  it('est déterministe, sans horloge ni aléa', () => {
    const a = deriveInstagramIdempotencyKey('3b14fcc8-9268-44a5-b77d-4f13dc000826', 'first_touch_dm');
    const b = deriveInstagramIdempotencyKey('3b14fcc8-9268-44a5-b77d-4f13dc000826', 'first_touch_dm');
    expect(a).toBe(b);
    expect(a).toBe('ig-r1/first_touch_dm/3b14fcc8-9268-44a5-b77d-4f13dc000826');
  });

  it('sépare deux manifestes', () => {
    expect(deriveInstagramIdempotencyKey('a', 'first_touch_dm')).not.toBe(
      deriveInstagramIdempotencyKey('b', 'first_touch_dm'),
    );
  });
});

// ---------------------------------------------------------------------------
// Arrêt global et plafonds (décision pure)
// ---------------------------------------------------------------------------

describe('arrêt global et plafonds', () => {
  const config = loadInstagramRail();
  const open = { ...DEFAULT_KILL_SWITCH, engaged: false, setBy: 'un opérateur', reason: 'test', fromDefault: false };
  const snapshot = (over: Partial<SafetySnapshot> = {}): SafetySnapshot => ({
    killSwitch: open,
    sentLastDay: 0,
    sentLastHour: 0,
    msSinceLastExternalEffect: null,
    consecutiveFailures: 0,
    sessionFailures: 0,
    ...over,
  });

  it('l’absence de ligne vaut « armé » — fail-closed par défaut', () => {
    expect(DEFAULT_KILL_SWITCH.engaged).toBe(true);
    expect(DEFAULT_KILL_SWITCH.fromDefault).toBe(true);
    const verdict = evaluateSafety(snapshot({ killSwitch: DEFAULT_KILL_SWITCH }), config);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.code).toBe('IG_KILL_SWITCH_ENGAGED');
  });

  it('l’arrêt prime sur tout le reste et court-circuite les plafonds', () => {
    const verdict = evaluateSafety(snapshot({ killSwitch: DEFAULT_KILL_SWITCH, sentLastDay: 999 }), config);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.code).toBe('IG_KILL_SWITCH_ENGAGED');
    // Aucun plafond n'a été évalué : le premier refus arrête l'évaluation.
    expect(verdict.gates.map((g) => g.gate)).toEqual(['kill_switch']);
  });

  it('laisse passer quand tout est vert, et journalise chaque garde évaluée', () => {
    const verdict = evaluateSafety(snapshot(), config);
    expect(verdict.allowed).toBe(true);
    expect(verdict.gates.map((g) => g.gate)).toEqual([
      'kill_switch',
      'cap_daily_sent',
      'cap_hourly_sent',
      'cap_min_interval',
      'cap_consecutive_failures',
      'cap_session_failures',
    ]);
    expect(verdict.gates.every((g) => g.verdict === 'PASS')).toBe(true);
  });

  it('refuse au plafond journalier', () => {
    const verdict = evaluateSafety(snapshot({ sentLastDay: config.caps.dailySentCap }), config);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.code).toBe('IG_CAP_DAILY_SENT');
  });

  it('refuse au plafond horaire', () => {
    const verdict = evaluateSafety(snapshot({ sentLastHour: config.caps.hourlySentCap }), config);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.code).toBe('IG_CAP_HOURLY_SENT');
  });

  it('refuse sous l’intervalle minimal, mais jamais le tout premier envoi', () => {
    const tooSoon = evaluateSafety(snapshot({ msSinceLastExternalEffect: config.caps.minSendIntervalMs - 1 }), config);
    expect(tooSoon.allowed).toBe(false);
    if (!tooSoon.allowed) expect(tooSoon.code).toBe('IG_CAP_MIN_INTERVAL');
    // `null` = aucune tentative d'effet antérieure : ne doit pas être confondu
    // avec « il y a 0 ms ».
    expect(evaluateSafety(snapshot({ msSinceLastExternalEffect: null }), config).allowed).toBe(true);
  });

  it('l’intervalle se mesure sur un effet externe, pas sur une navigation', () => {
    // IG2 §1 — le champ nomme ce qu'il mesure. Un dry-run qui a ouvert un
    // profil il y a une seconde ne renseigne PAS ce compteur : il n'a produit
    // aucun effet, donc il laisse `null`, donc il ne repousse rien.
    const afterDryRun = evaluateSafety(snapshot({ msSinceLastExternalEffect: null }), config);
    expect(afterDryRun.allowed).toBe(true);
    const gate = afterDryRun.gates.find((g) => g.gate === 'cap_min_interval');
    expect(gate?.detail).toContain('effet externe');
  });

  it('refuse au plafond d’échecs consécutifs', () => {
    const verdict = evaluateSafety(snapshot({ consecutiveFailures: config.caps.maxConsecutiveFailures }), config);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.code).toBe('IG_CAP_CONSECUTIVE_FAILURES');
  });

  it('refuse au plafond d’échecs de session', () => {
    const verdict = evaluateSafety(snapshot({ sessionFailures: config.caps.maxSessionFailures }), config);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.code).toBe('IG_CAP_SESSION_FAILURES');
  });
});

// ---------------------------------------------------------------------------
// Taxonomie de la file
// ---------------------------------------------------------------------------

describe('taxonomie des statuts', () => {
  it('les statuts absorbants ne sont jamais réclamables', () => {
    for (const terminal of TERMINAL_JOB_STATUSES) {
      expect(CLAIMABLE_JOB_STATUSES).not.toContain(terminal);
    }
    // IG2.1 — `DELIVERY_FAILED` rejoint les deux autres : un message qu'Instagram
    // n'a pas remis est une issue CONNUE, et un rail qui le retenterait tout seul
    // enverrait un second message que personne n'a redécidé.
    //
    // IG3 — `INELIGIBLE` est le quatrième, et le seul qui n'a jamais rien
    // tenté : un refus métier (hors ICP, opt-out, déjà contacté) ne change pas
    // d'avis tout seul.
    expect(TERMINAL_JOB_STATUSES).toEqual(['SENT', 'REVIEW_REQUIRED', 'DELIVERY_FAILED', 'INELIGIBLE']);
  });

  it('CLAIMED n’est pas réclamable — un bail en cours n’est pas une place libre', () => {
    expect(CLAIMABLE_JOB_STATUSES).not.toContain('CLAIMED');
  });

  it('SKIPPED est réclamable — un report attend son heure, il ne sort pas de la file', () => {
    expect(CLAIMABLE_JOB_STATUSES).toContain('SKIPPED');
    expect(TERMINAL_JOB_STATUSES).not.toContain('SKIPPED');
  });

  it('chaque motif de report a une classe, et une seule', () => {
    // L'exhaustivité est portée par le type (`Record<InstagramSkipReason, …>`) ;
    // ce test vérifie qu'aucune valeur n'y est autre chose qu'une des deux
    // classes — donc qu'un motif ne peut pas être « un peu terminal ».
    for (const [reason, klass] of Object.entries(SKIP_REASON_CLASS)) {
      expect(['TEMPORARY', 'TERMINAL'], `motif ${reason}`).toContain(klass);
    }
    // Les quatre refus qui portent sur la PERSONNE ne se rejouent jamais.
    expect(skipClassOf('opt_out')).toBe('TERMINAL');
    expect(skipClassOf('icp_not_target')).toBe('TERMINAL');
    expect(skipClassOf('already_contacted')).toBe('TERMINAL');
    expect(skipClassOf('duplicate')).toBe('TERMINAL');
    // Les reports d'ordonnancement, eux, attendent leur heure.
    expect(skipClassOf('daily_cap')).toBe('TEMPORARY');
    expect(skipClassOf('outside_window')).toBe('TEMPORARY');
    expect(skipClassOf('kill_switch')).toBe('TEMPORARY');
  });
});
