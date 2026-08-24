import { describe, expect, it } from 'vitest';
import {
  classifyThreadIdentity,
  decideThreadIdentity,
  displayNameForHandle,
  findPanelCandidates,
  handleFromRelativeHref,
  looksLikeHeader,
  parseProfileTitle,
  selectThreadPanel,
  textMentionsHandle,
  THREAD_IDENTITY_LIMITS,
  UNREADABLE_THREAD_READ,
  type AncestorMeasure,
  type RawThreadIdentityRead,
  type ReadRect,
  type ThreadIdentityObservation,
} from '@/lib/instagram/threadIdentity';

/**
 * IG2.2 — « à qui suis-je en train d'écrire ? », éprouvé sans navigateur.
 *
 * La géométrie de ce fichier n'est pas inventée : elle reprend celle du panneau
 * réellement observé sur `operator_second_account` le 14 août 2026, mesurée sur la capture.
 * Panneau flottant en bas à droite, barre de titre « Moha » sur son bord
 * supérieur, liste des messages en dessous — dont un reel partagé de
 * `kulturlesite` — et composeur en pied.
 *
 * L'invariant vérifié partout : ce qui décide est l'EN-TÊTE. Les handles du
 * corps sont lus, journalisés, et n'entrent dans aucun verdict — ni pour
 * accepter, ni pour refuser.
 */

const EXPECTED = 'operator_second_account';

function rect(top: number, bottom: number, left = 898, right = 1258): ReadRect {
  return { top, bottom, left, right, width: right - left, height: bottom - top };
}

// --- La géométrie réelle, mesurée sur la capture ---------------------------
const VIEWPORT = { width: 1280, height: 900 };
/** Le panneau : y 371 → 891, x 898 → 1258. */
const PANEL = rect(371, 891);
/** Sa barre de titre : y 371 → 411. Frère de la liste des messages. */
const HEADER = rect(371, 411);
/** La liste des messages : y 411 → 810. Frère de l'en-tête. */
const MESSAGE_LIST = rect(411, 810);
/** Le composeur, en pied de panneau. */
const COMPOSER = rect(820, 860, 914, 1242);
/** Le reel partagé, assis sur le bord haut de la liste. */
const SHARED_REEL = rect(415, 540, 1062, 1242);

function ancestor(overrides: Partial<AncestorMeasure> & { depth: number; rect: ReadRect }): AncestorMeasure {
  return {
    tag: 'div',
    role: null,
    ariaLabel: null,
    isDocumentRoot: false,
    childRects: [],
    ...overrides,
  };
}

/**
 * Le DOM observé : le composeur est un DESCENDANT du panneau (douze div
 * intermédiaires dans la vraie page, deux suffisent ici), et l'en-tête est un
 * FRÈRE de la liste des messages, tous deux enfants directs du panneau.
 */
function realRead(overrides: Partial<RawThreadIdentityRead> = {}): RawThreadIdentityRead {
  return {
    composerRect: COMPOSER,
    viewport: VIEWPORT,
    ancestors: [
      ancestor({ depth: 1, rect: rect(815, 865, 906, 1250) }),
      ancestor({ depth: 2, rect: rect(810, 870, 902, 1254) }),
      ancestor({
        depth: 3,
        rect: PANEL,
        ariaLabel: 'Moha',
        childRects: [HEADER, MESSAGE_LIST, rect(810, 891)],
      }),
      ancestor({ depth: 4, rect: rect(0, 900, 0, 1280), tag: 'main', isDocumentRoot: true }),
    ],
    links: [
      // Le correspondant, dans la barre de titre.
      { handle: EXPECTED, rect: rect(379, 403, 940, 1060) },
      // L'auteur du reel partagé, dans l'historique.
      { handle: 'kulturlesite', rect: SHARED_REEL },
    ],
    texts: [{ text: 'Moha', rect: rect(376, 396, 986, 1046) }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Le panneau
// ---------------------------------------------------------------------------

describe('IG2.2 — le conteneur commun barre de titre + liste + composeur', () => {
  it('retient le panneau, pas le premier ancêtre portant un aria-label', () => {
    // C'est le troisième refus : `div[aria-label="Moha"]` avait été pris pour
    // le panneau alors que l'en-tête réel en est un frère. Le choix ne s'appuie
    // plus sur le libellé mais sur la forme du conteneur.
    const candidates = findPanelCandidates(realRead(), THREAD_IDENTITY_LIMITS);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.ancestor.depth).toBe(3);
    expect(candidates[0]?.header).toEqual(HEADER);
  });

  it('sépare l’en-tête (frère) de l’historique (frère lui aussi)', () => {
    const observed = classifyThreadIdentity(realRead(), THREAD_IDENTITY_LIMITS);
    expect(observed.panelFound).toBe(true);
    expect(observed.headerFound).toBe(true);
    expect(observed.headerHandles).toEqual([EXPECTED]);
    expect(observed.bodyHandles).toEqual(['kulturlesite']);
    expect(observed.headerTexts).toEqual(['Moha']);
  });

  it('confirme le fil par le handle de l’en-tête', () => {
    const verdict = decideThreadIdentity({
      observation: classifyThreadIdentity(realRead(), THREAD_IDENTITY_LIMITS),
      expectedHandle: EXPECTED,
      expectedDisplayName: null,
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.via).toBe('header_handle');
  });

  it('sans handle dans la barre, le nom d’affichage corroboré suffit — pas le reel', () => {
    const observed = classifyThreadIdentity(
      realRead({ links: [{ handle: 'kulturlesite', rect: SHARED_REEL }] }),
      THREAD_IDENTITY_LIMITS,
    );
    expect(observed.headerHandles).toEqual([]);
    expect(observed.bodyHandles).toEqual(['kulturlesite']);

    const verdict = decideThreadIdentity({
      observation: observed,
      expectedHandle: EXPECTED,
      expectedDisplayName: 'Moha',
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.via).toBe('header_display_name');
  });

  it('un conteneur pleine page n’est pas un panneau', () => {
    // Sa « bande supérieure » serait l'en-tête du profil affiché derrière, qui
    // porte évidemment le bon handle et ne prouverait rien sur le fil.
    const candidates = findPanelCandidates(
      realRead({
        ancestors: [
          ancestor({
            depth: 1,
            rect: rect(0, 890, 0, 1270),
            childRects: [rect(0, 60, 0, 1270), rect(60, 890, 0, 1270)],
          }),
        ],
      }),
      THREAD_IDENTITY_LIMITS,
    );
    expect(candidates).toHaveLength(0);
  });

  it('un conteneur sans barre de titre en premier enfant n’est pas un panneau', () => {
    const candidates = findPanelCandidates(
      realRead({
        ancestors: [ancestor({ depth: 1, rect: PANEL, childRects: [MESSAGE_LIST, rect(810, 891)] })],
      }),
      THREAD_IDENTITY_LIMITS,
    );
    expect(candidates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Le faux candidat au bord supérieur
// ---------------------------------------------------------------------------

describe('IG2.2 — le faux en-tête', () => {
  it('une bulle assise sur le bord supérieur n’est pas une barre de titre', () => {
    // Le reel partagé fait 125 px de haut : trop haut pour une barre. La forme
    // le rejette avant même que ses liens soient regardés.
    expect(looksLikeHeader(PANEL, rect(371, 496), COMPOSER, THREAD_IDENTITY_LIMITS)).toBe(false);
    expect(looksLikeHeader(PANEL, HEADER, COMPOSER, THREAD_IDENTITY_LIMITS)).toBe(true);
  });

  it('une barre étroite n’est pas une barre de titre', () => {
    expect(looksLikeHeader(PANEL, rect(371, 411, 898, 998), COMPOSER, THREAD_IDENTITY_LIMITS)).toBe(false);
  });

  it('une barre située SOUS le composeur n’est pas un en-tête', () => {
    expect(looksLikeHeader(PANEL, rect(861, 891), COMPOSER, THREAD_IDENTITY_LIMITS)).toBe(false);
  });

  it('un lien qui COMMENCE dans la barre mais la déborde reste dans l’historique', () => {
    // Le deuxième refus, en nombres : « commence dedans » laissait entrer la
    // première bulle. Seule l'inclusion ENTIÈRE compte.
    const observed = classifyThreadIdentity(
      realRead({ links: [{ handle: 'kulturlesite', rect: rect(405, 540, 1062, 1242) }] }),
      THREAD_IDENTITY_LIMITS,
    );
    expect(observed.headerHandles).toEqual([]);
    expect(observed.bodyHandles).toEqual(['kulturlesite']);
  });
});

// ---------------------------------------------------------------------------
// Plusieurs candidats
// ---------------------------------------------------------------------------

describe('IG2.2 — plusieurs panneaux plausibles', () => {
  /** Deux panneaux imbriqués dont les en-têtes nomment des gens différents. */
  const twoPanels = (): RawThreadIdentityRead =>
    realRead({
      ancestors: [
        ancestor({ depth: 1, rect: PANEL, ariaLabel: 'Moha', childRects: [HEADER, MESSAGE_LIST, rect(810, 891)] }),
        ancestor({
          depth: 2,
          rect: rect(300, 891, 890, 1266),
          childRects: [rect(300, 350, 890, 1266), rect(350, 891, 890, 1266)],
        }),
      ],
      links: [
        { handle: EXPECTED, rect: rect(379, 403, 940, 1060) },
        { handle: 'un_autre_compte', rect: rect(310, 340, 940, 1060) },
      ],
    });

  it('refuse plutôt que d’arbitrer quand les en-têtes se contredisent', () => {
    expect(selectThreadPanel(twoPanels(), THREAD_IDENTITY_LIMITS).kind).toBe('ambiguous');

    const observed = classifyThreadIdentity(twoPanels(), THREAD_IDENTITY_LIMITS);
    expect(observed.panelAmbiguous).toBe(true);
    expect(observed.headerFound).toBe(false);

    const verdict = decideThreadIdentity({
      observation: observed,
      expectedHandle: EXPECTED,
      expectedDisplayName: 'Moha',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain('plusieurs panneaux');
  });

  it('deux enveloppes qui disent la même chose ne sont pas une ambiguïté', () => {
    const wrapped = realRead({
      ancestors: [
        ancestor({ depth: 1, rect: PANEL, ariaLabel: 'Moha', childRects: [HEADER, MESSAGE_LIST, rect(810, 891)] }),
        ancestor({ depth: 2, rect: rect(370, 892, 897, 1259), childRects: [HEADER, MESSAGE_LIST, rect(810, 892)] }),
      ],
    });
    const selection = selectThreadPanel(wrapped, THREAD_IDENTITY_LIMITS);
    expect(selection.kind).toBe('ok');
    if (selection.kind === 'ok') expect(selection.candidate.ancestor.depth).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Le fail-closed
// ---------------------------------------------------------------------------

function observation(overrides: Partial<ThreadIdentityObservation> = {}): ThreadIdentityObservation {
  return {
    panelFound: true,
    panelAmbiguous: false,
    headerFound: true,
    headerHandles: [],
    headerTexts: [],
    panelLabel: null,
    panelRect: null,
    bodyHandles: [],
    ancestorChain: [],
    diagnostics: [],
    ...overrides,
  };
}

describe('IG2.2 — l’identité du fil refuse par défaut', () => {
  it('refuse un en-tête qui nomme quelqu’un d’autre', () => {
    const verdict = decideThreadIdentity({
      observation: observation({ headerHandles: ['un_autre_compte'] }),
      expectedHandle: EXPECTED,
      expectedDisplayName: 'Moha',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain('un_autre_compte');
  });

  it('refuse dès qu’un seul handle de l’en-tête diverge', () => {
    expect(
      decideThreadIdentity({
        observation: observation({ headerHandles: [EXPECTED, 'un_autre_compte'] }),
        expectedHandle: EXPECTED,
        expectedDisplayName: 'Moha',
      }).ok,
    ).toBe(false);
  });

  it('refuse quand aucun panneau n’est identifié', () => {
    const observed = classifyThreadIdentity(UNREADABLE_THREAD_READ, THREAD_IDENTITY_LIMITS);
    expect(observed).toMatchObject({ panelFound: false, headerFound: false });
    expect(
      decideThreadIdentity({ observation: observed, expectedHandle: EXPECTED, expectedDisplayName: 'Moha' }).ok,
    ).toBe(false);
  });

  it('refuse un en-tête vide, même avec un nom d’affichage connu', () => {
    const verdict = decideThreadIdentity({
      observation: observation({ headerFound: false }),
      expectedHandle: EXPECTED,
      expectedDisplayName: 'Moha',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain('rien laissé lire');
  });

  it('refuse un nom d’affichage SEUL, sans corroboration par la page de profil', () => {
    const verdict = decideThreadIdentity({
      observation: observation({ headerTexts: ['Moha'], panelLabel: 'Moha' }),
      expectedHandle: EXPECTED,
      expectedDisplayName: null,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain('pas pu être établi');
  });

  it('refuse un nom d’affichage qui ne correspond pas', () => {
    expect(
      decideThreadIdentity({
        observation: observation({ headerTexts: ['Quelqu’un d’autre'] }),
        expectedHandle: EXPECTED,
        expectedDisplayName: 'Moha',
      }).ok,
    ).toBe(false);
  });

  it('les handles de l’historique n’accréditent jamais un en-tête muet', () => {
    const verdict = decideThreadIdentity({
      observation: observation({ headerTexts: ['Quelqu’un d’autre'], bodyHandles: [EXPECTED] }),
      expectedHandle: EXPECTED,
      expectedDisplayName: 'Moha',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain('HISTORIQUE');
  });

  it('accepte le handle écrit en toutes lettres, mais pas un préfixe', () => {
    expect(
      decideThreadIdentity({
        observation: observation({ headerTexts: [`@${EXPECTED}`] }),
        expectedHandle: EXPECTED,
        expectedDisplayName: null,
      }).ok,
    ).toBe(true);
    expect(
      decideThreadIdentity({
        observation: observation({ headerTexts: ['@demo_prospect_a2'] }),
        expectedHandle: 'demo_prospect_a',
        expectedDisplayName: null,
      }).ok,
    ).toBe(false);
  });

  it('la comparaison de nom ignore la casse et les blancs, pas le contenu', () => {
    expect(
      decideThreadIdentity({
        observation: observation({ headerTexts: ['  moha  '] }),
        expectedHandle: EXPECTED,
        expectedDisplayName: 'Moha',
      }).ok,
    ).toBe(true);
    expect(
      decideThreadIdentity({
        observation: observation({ headerTexts: ['un opérateur'] }),
        expectedHandle: EXPECTED,
        expectedDisplayName: 'Moha',
      }).ok,
    ).toBe(false);
  });

  it('un refus emporte les mesures avec lui', () => {
    // Sans les rectangles observés, « aucun en-tête lisible » n'apprend rien à
    // qui doit corriger — les trois refus précédents ont coûté une exécution de
    // navigateur chacun pour découvrir ce que ce champ dit maintenant seul.
    const observed = classifyThreadIdentity(
      realRead({ ancestors: [ancestor({ depth: 1, rect: PANEL, childRects: [MESSAGE_LIST] })] }),
      THREAD_IDENTITY_LIMITS,
    );
    expect(observed.panelFound).toBe(false);
    expect(observed.diagnostics.join(' ')).toContain('composeur y820..860');
    expect(observed.diagnostics.join(' ')).toContain('viewport 1280x900');
  });
});

// ---------------------------------------------------------------------------
// Les lectures élémentaires
// ---------------------------------------------------------------------------

describe('IG2.2 — le nom d’affichage vient du titre, rattaché à son handle', () => {
  it('lit le couple nom / handle du titre Instagram', () => {
    expect(parseProfileTitle('Moha (@operator_second_account) • Photos et vidéos Instagram')).toEqual({
      displayName: 'Moha',
      handle: 'operator_second_account',
    });
  });

  it('refuse un titre dont le handle n’est pas celui attendu', () => {
    expect(displayNameForHandle('Autre (@autre_compte) • Instagram', EXPECTED)).toBeNull();
    expect(displayNameForHandle('Moha (@operator_second_account) • Instagram', EXPECTED)).toBe('Moha');
  });

  it('ne fabrique pas de nom approximatif', () => {
    expect(parseProfileTitle(null)).toBeNull();
    expect(parseProfileTitle('Instagram')).toBeNull();
    expect(parseProfileTitle('(@operator_second_account)')).toBeNull();
  });

  it('lit un handle d’URL relative, et rien d’autre', () => {
    expect(handleFromRelativeHref('/operator_second_account/')).toBe('operator_second_account');
    expect(handleFromRelativeHref('/operator_second_account')).toBe('operator_second_account');
    expect(handleFromRelativeHref('/operator_second_account/?hl=fr')).toBe('operator_second_account');
    expect(handleFromRelativeHref('/p/DKx9/')).toBeNull();
    expect(handleFromRelativeHref('/direct/t/123/')).toBeNull();
  });

  it('la mention d’un handle exige des séparateurs', () => {
    expect(textMentionsHandle('Discussion avec @operator_second_account', 'operator_second_account')).toBe(true);
    expect(textMentionsHandle('operator_second_accountx', 'operator_second_account')).toBe(false);
  });
});
