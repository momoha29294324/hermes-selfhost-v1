import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadInstagramRail } from '@/lib/config/load';
import { resolveInspectionTarget } from '@/lib/conversation/inspectionTarget';
import { readOnlySql } from '@/lib/db/readOnlySql';
import type { Sql } from '@/lib/db/sql';
import { PlaywrightInstagramReplyRail } from '@/lib/instagram/playwrightReplyRail';
import { PlaywrightInstagramThreadInspectionRail } from '@/lib/instagram/playwrightThreadInspectionRail';
import { canonicalAccountIdentity, type CanonicalAccountIdentity } from '@/lib/instagram/accountIdentity';
import { readThreadHistory } from '@/lib/instagram/replyHistory';
import { FORBIDDEN_REPLY_METHODS, hasReplyPrimitive } from '@/lib/instagram/replyRail';
import {
  DIRECT_THREAD_IDENTITY_LIMITS,
  findPanelCandidates,
  selectThreadPanel,
  THREAD_IDENTITY_LIMITS,
  UNREADABLE_THREAD_IDENTITY,
  type AncestorMeasure,
  type RawThreadIdentityRead,
  type ReadRect,
  type ThreadIdentityObservation,
  type ThreadIdentityVerdict,
} from '@/lib/instagram/threadIdentity';
import {
  classifyAccountIdentity,
  classifyThreadIdentityOutcome,
  describeThreadNavigation,
  firstTargetingRefusal,
  FORBIDDEN_INSPECTION_METHODS,
  hasInspectionPrimitive,
  THREAD_INSPECTION_PRIMITIVE,
} from '@/lib/instagram/threadInspectionRail';
import type { ThreadHarvest } from '@/lib/instagram/threadHarvest';
import type { ObservedNode } from '@/lib/instagram/threadObservation';

/** Le compte de ce scénario : l'identité canonique que la CLI construit depuis la config. */
const TEST_ACCOUNT_IDENTITY: CanonicalAccountIdentity = (() => {
  const resolved = canonicalAccountIdentity({ accountHandle: 'compte_test_hermes', formerAccountHandles: [] });
  if (!resolved.ok) throw new Error(resolved.detail);
  return resolved.identity;
})();


/**
 * HERMES-REAL-THREAD-PREVIEW-R1 §16 — les portes de l'INSPECTION read-only,
 * exercées sans base et sans navigateur.
 *
 * Tout ce fichier est pur, à une exception près : deux rails sont CONSTRUITS
 * pour interroger leur forme, ce qui n'ouvre aucun navigateur (`open()` n'est
 * appelé que par `inspectThread` et `sendThreadReply`).
 *
 * La pièce centrale est `§11`, qui rejoue la géométrie RÉELLE relevée le
 * 22 août 2026 sur un vrai `/direct/t/…`. Ce sont ces nombres-là qui ont montré
 * que le rail ne savait pas reconnaître un fil plein écran, et ce sont eux qui
 * doivent rester dans le dépôt : une correction validée à la main sur une page
 * qui n'existe plus dans aucun test se re-casse au premier réglage suivant.
 */

const ROOT = resolve(__dirname, '..');

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const INSPECTION_SOURCE = readFileSync(
  resolve(ROOT, 'src/lib/instagram/playwrightThreadInspectionRail.ts'),
  'utf8',
);
const CLI_SOURCE = readFileSync(resolve(ROOT, 'src/cli/conversation-thread-inspect.ts'), 'utf8');

const config = loadInstagramRail();
const inspectionRail = new PlaywrightInstagramThreadInspectionRail({
  config,
  workerId: 'test-inspection',
  headless: true,
});

// ---------------------------------------------------------------------------
// §2 — l'aperçu est INCAPABLE d'envoyer, et pas seulement autorisé à ne pas le faire
// ---------------------------------------------------------------------------

describe('§2 — sûreté du mode aperçu', () => {
  it('le rail d’inspection ne porte PAS la primitive de réponse', () => {
    expect(hasInspectionPrimitive(inspectionRail)).toBe(true);
    // La question qui compte : m'a-t-on donné plus que ce que je demande ?
    expect(hasReplyPrimitive(inspectionRail)).toBe(false);
    for (const forbidden of FORBIDDEN_INSPECTION_METHODS) {
      expect(
        (inspectionRail as unknown as Record<string, unknown>)[forbidden],
        `le rail d’inspection porte « ${forbidden} »`,
      ).toBeUndefined();
    }
  });

  it('le rail de RÉPONSE hérite de l’inspection, et pas l’inverse', () => {
    const replyRail = new PlaywrightInstagramReplyRail({ config, workerId: 'test-reply', headless: true });
    // Le sens de l'héritage est ce qui garantit que les deux exercent le MÊME
    // ciblage : un rail de réponse est un rail d'inspection qui sait en plus
    // cliquer une fois.
    expect(replyRail).toBeInstanceOf(PlaywrightInstagramThreadInspectionRail);
    expect(inspectionRail).not.toBeInstanceOf(PlaywrightInstagramReplyRail);
    expect(hasInspectionPrimitive(replyRail)).toBe(true);
    // Et le rail de réponse ne gagne aucune capacité interdite au passage.
    for (const forbidden of FORBIDDEN_REPLY_METHODS) {
      expect(
        (replyRail as unknown as Record<string, unknown>)[forbidden],
        `le rail de réponse porte « ${forbidden} »`,
      ).toBeUndefined();
    }
  });

  it('le fichier du rail d’inspection ne contient AUCUN geste de mutation', () => {
    const code = stripComments(INSPECTION_SOURCE);
    for (const forbidden of [
      '.click(',
      '.fill(',
      '.type(',
      '.press(',
      'pressSequentially',
      '.tap(',
      '.dblclick(',
      '.selectOption(',
      '.setInputFiles(',
      '.focus(',
      '.check(',
      '.hover(',
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
    // Le seul geste posé sur une page reste `goto`, via `navigate` de la base.
    expect(code).not.toContain('page.goto(');
  });

  it('le rail d’inspection ne sait pas désigner ce qui cliquerait', () => {
    // `SEND_CONTROL_SELECTORS` est le seul groupe de sélecteurs dont un clic
    // produit un effet. Un module qui ne clique pas n'a aucune raison de le
    // connaître, et l'import est une frontière vérifiable par `grep`.
    // Dans le CODE : l'en-tête du fichier EXPLIQUE pourquoi ce groupe n'y est
    // pas, et un test qui interdirait de l'écrire interdirait de l'expliquer.
    expect(stripComments(INSPECTION_SOURCE)).not.toContain('SEND_CONTROL_SELECTORS');
    expect(readFileSync(resolve(ROOT, 'src/lib/instagram/playwrightReplyRail.ts'), 'utf8')).toContain(
      'SEND_CONTROL_SELECTORS',
    );
  });

  it('le rail d’inspection ne connaît ni plan, ni effet, ni réservation', () => {
    for (const forbidden of [
      '@/lib/conversation/plan',
      '@/lib/conversation/replyEffect',
      '@/lib/conversation/preEffect',
      'reserveConversationEffectSlot',
      'external_effect_attempted',
      'onBeforeExternalEffect',
      'setKillSwitch',
    ]) {
      expect(INSPECTION_SOURCE, forbidden).not.toContain(forbidden);
    }
  });

  it('la commande d’inspection ne sait ni envoyer, ni lever l’arrêt global', () => {
    // §14 — elle LIT l'arrêt global et l'affiche ; elle n'en dépend pas et ne
    // l'écrit pas. `loadKillSwitch` est une lecture ; `setKillSwitch` n'est même
    // pas importé.
    const cli = stripComments(CLI_SOURCE);
    expect(cli).toContain('loadKillSwitch');
    expect(cli).not.toContain('setKillSwitch');
    expect(cli).not.toContain('OUTBOUND_ALLOW_SENDING');
    expect(cli).not.toContain('playwrightReplyRail');
    expect(cli).not.toContain('playwrightLiveRail');
    expect(cli).not.toContain('executeConversationReply');
    // La base lui parvient enveloppée : `exec` et `transaction` y lèvent.
    expect(cli).toContain('readOnlySql(live');
  });

  it('la primitive d’inspection porte le nom que les gardes interrogent', () => {
    expect(THREAD_INSPECTION_PRIMITIVE).toBe('inspectThread');
    expect(typeof inspectionRail.inspectThread).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// §3 — le bail du profil : aucun second verrou
// ---------------------------------------------------------------------------

describe('§3 — bail navigateur', () => {
  it('l’inspection n’ouvre pas son propre navigateur et ne prend pas son propre verrou', () => {
    // Elle passe par `open()` de la classe de base, qui prend le bail AVANT le
    // lancement et le rend dans `close()`. Un second chemin d'ouverture serait
    // un second verrou, c'est-à-dire aucun.
    const code = stripComments(INSPECTION_SOURCE);
    expect(code).not.toContain('launchPersistentContext');
    expect(code).not.toContain('acquireInstagramBrowserLease');
    expect(code).toContain('await this.open()');
  });

  it('la commande traite « profil occupé » comme une attente, jamais comme une panne à réparer', () => {
    expect(CLI_SOURCE).toContain('InstagramBrowserProfileBusyError');
    // Et surtout : elle ne tue rien.
    for (const forbidden of ['process.kill', 'execSync', 'spawn(', 'pkill', 'SIGKILL']) {
      expect(CLI_SOURCE, forbidden).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// §4 — l'identité du compte émetteur
// ---------------------------------------------------------------------------

describe('§4 — identité du compte', () => {
  it('« Modifier le profil » ⇒ MATCH ; un témoin de relation ⇒ MISMATCH ; rien ⇒ UNKNOWN', () => {
    expect(classifyAccountIdentity(true)).toBe('MATCH');
    expect(classifyAccountIdentity(false)).toBe('MISMATCH');
    expect(classifyAccountIdentity(null)).toBe('UNKNOWN');
  });

  it('UNKNOWN reste fail-closed — il refuse comme un MISMATCH', () => {
    const base = {
      sessionUsable: true,
      navigationMatch: true,
      composerFound: true,
      threadIdentity: 'MATCH' as const,
      history: 'HAS_HISTORY' as const,
    };
    expect(firstTargetingRefusal({ ...base, account: 'MATCH' })).toBeNull();
    expect(firstTargetingRefusal({ ...base, account: 'MISMATCH' })).toBe('IG_REPLY_ACCOUNT_MISMATCH');
    expect(firstTargetingRefusal({ ...base, account: 'UNKNOWN' })).toBe('IG_REPLY_SESSION_LOST');
  });

  it('un profil ABSENT est un refus définitif, pas une panne qui passera', () => {
    // Relevé réel du 22 août 2026 : le handle inscrit sur les messages rendait
    // « Cette page n’est malheureusement pas disponible ». Sans cette
    // distinction, l'en-tête muet donnait `UNKNOWN` ⇒ `IG_REPLY_SESSION_LOST`,
    // c'est-à-dire un plan qui repart toutes les cinq minutes pour toujours.
    const code = stripComments(INSPECTION_SOURCE);
    expect(code).toContain('await this.isProfileMissing(page)');
    const missing = code.indexOf('await this.isProfileMissing(page)');
    const relationship = code.indexOf('await readRelationship(page)');
    expect(missing).toBeGreaterThan(0);
    expect(relationship).toBeGreaterThan(missing);
  });
});

// ---------------------------------------------------------------------------
// §5 — l'URL atteinte
// ---------------------------------------------------------------------------

describe('§5 — navigation vers le fil exact', () => {
  const requestedUrl = 'https://www.instagram.com/direct/t/107403793987175/';

  it('URL exacte ⇒ concordance, sans réécriture', () => {
    const finding = describeThreadNavigation({
      requestedThreadId: '107403793987175',
      requestedUrl,
      landedUrl: requestedUrl,
      threadIdFromUrl: '107403793987175',
    });
    expect(finding.match).toBe(true);
    expect(finding.rewritten).toBe(false);
  });

  it('URL réécrite mais MÊME identifiant ⇒ concordance, et le fait est dit', () => {
    // La concordance porte sur l'IDENTIFIANT, jamais sur la chaîne. Une
    // réécriture est documentée (§5), pas absorbée en silence.
    const finding = describeThreadNavigation({
      requestedThreadId: '107403793987175',
      requestedUrl,
      landedUrl: 'https://www.instagram.com/direct/t/107403793987175',
      threadIdFromUrl: '107403793987175',
    });
    expect(finding.match).toBe(true);
    expect(finding.rewritten).toBe(true);
    expect(finding.detail).toContain('réécrit');
  });

  it('identifiant DIFFÉRENT ⇒ refus, jamais un fil de repli', () => {
    const finding = describeThreadNavigation({
      requestedThreadId: '107403793987175',
      requestedUrl,
      landedUrl: 'https://www.instagram.com/direct/t/999/',
      threadIdFromUrl: '999',
    });
    expect(finding.match).toBe(false);
    expect(finding.rewritten).toBe(false);
  });

  it('redirection vers une page SANS identifiant de fil ⇒ refus', () => {
    for (const landed of ['https://www.instagram.com/direct/inbox/', null]) {
      const finding = describeThreadNavigation({
        requestedThreadId: '107403793987175',
        requestedUrl,
        landedUrl: landed,
        threadIdFromUrl: null,
      });
      expect(finding.match).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// §7 — l'identité du fil, et la différence entre « pas lui » et « pas lu »
// ---------------------------------------------------------------------------

function observation(patch: Partial<ThreadIdentityObservation>): ThreadIdentityObservation {
  return { ...UNREADABLE_THREAD_IDENTITY, ...patch };
}

const OK: ThreadIdentityVerdict = { ok: true, handle: 'demo_account_17', via: 'header_handle', detail: '' };
const KO: ThreadIdentityVerdict = { ok: false, detail: '' };

describe('§7 — identité du fil', () => {
  it('verdict favorable ⇒ MATCH', () => {
    expect(classifyThreadIdentityOutcome(observation({}), OK, 'demo_account_17')).toBe('MATCH');
  });

  it('un AUTRE handle lu dans l’en-tête ⇒ MISMATCH — la page affirme quelque chose', () => {
    const o = observation({ panelFound: true, headerFound: true, headerHandles: ['quelquun_dautre'] });
    expect(classifyThreadIdentityOutcome(o, KO, 'demo_account_17')).toBe('MISMATCH');
  });

  it('en-tête muet, panneau absent ou contradictoire ⇒ UNKNOWN — c’est notre LECTURE qui manque', () => {
    expect(classifyThreadIdentityOutcome(observation({}), KO, 'demo_account_17')).toBe('UNKNOWN');
    expect(
      classifyThreadIdentityOutcome(observation({ panelFound: true, panelAmbiguous: true }), KO, 'demo_account_17'),
    ).toBe('UNKNOWN');
    expect(
      classifyThreadIdentityOutcome(
        observation({ panelFound: true, headerFound: true, headerTexts: ['Un Nom'] }),
        KO,
        'demo_account_17',
      ),
    ).toBe('UNKNOWN');
    // Des handles dans l'HISTORIQUE ne sont jamais une identité, ni pour
    // accepter ni pour refuser.
    expect(
      classifyThreadIdentityOutcome(
        observation({ panelFound: true, headerFound: true, bodyHandles: ['kulturlesite'] }),
        KO,
        'demo_account_17',
      ),
    ).toBe('UNKNOWN');
  });

  it('la casse ne fabrique pas un MISMATCH', () => {
    const o = observation({ panelFound: true, headerFound: true, headerHandles: ['Demo_Account_17'] });
    expect(classifyThreadIdentityOutcome(o, KO, 'demo_account_17')).toBe('UNKNOWN');
  });

  it('MISMATCH et UNKNOWN refusent tous les deux', () => {
    const base = {
      sessionUsable: true,
      account: 'MATCH' as const,
      navigationMatch: true,
      composerFound: true,
      history: 'HAS_HISTORY' as const,
    };
    expect(firstTargetingRefusal({ ...base, threadIdentity: 'MISMATCH' })).toBe(
      'IG_REPLY_THREAD_IDENTITY_UNCONFIRMED',
    );
    expect(firstTargetingRefusal({ ...base, threadIdentity: 'UNKNOWN' })).toBe(
      'IG_REPLY_THREAD_IDENTITY_UNCONFIRMED',
    );
  });
});

// ---------------------------------------------------------------------------
// §8/§10 — historique et composeur
// ---------------------------------------------------------------------------

function node(patch: Partial<ObservedNode>): ObservedNode {
  return {
    id: 1,
    parentId: null,
    level: 0,
    tag: 'div',
    role: null,
    ariaLabel: null,
    title: null,
    text: 'bonjour',
    rect: { top: 0, bottom: 10, left: 0, right: 10 },
    visible: true,
    color: null,
    fill: null,
    ...patch,
  };
}

function harvest(patch: Partial<ThreadHarvest>): ThreadHarvest {
  return {
    ancestorChain: [],
    nodes: [],
    handleLinks: [],
    composerRect: null,
    composerText: '',
    truncated: false,
    readable: true,
    ...patch,
  };
}

describe('§8/§10 — historique et composeur', () => {
  it('un fil peuplé est reconnu ; un fil vide et une récolte illisible refusent tous les deux', () => {
    const populated = readThreadHistory(
      harvest({ nodes: [node({ id: 1 }), node({ id: 2, text: 'oui d’accord' })] }),
    );
    expect(populated.verdict).toBe('HAS_HISTORY');

    expect(readThreadHistory(harvest({ nodes: [] })).verdict).toBe('EMPTY');
    expect(readThreadHistory(harvest({ readable: false })).verdict).toBe('UNREADABLE');

    // Ce qui vit DANS le composeur (`level < 0`) ne compte jamais comme un passé.
    expect(readThreadHistory(harvest({ nodes: [node({ level: -1 }), node({ id: 2, level: -1 })] })).verdict).toBe(
      'EMPTY',
    );
  });

  it('EMPTY et UNREADABLE mènent au même refus', () => {
    const base = {
      sessionUsable: true,
      account: 'MATCH' as const,
      navigationMatch: true,
      composerFound: true,
      threadIdentity: 'MATCH' as const,
    };
    expect(firstTargetingRefusal({ ...base, history: 'EMPTY' })).toBe('IG_REPLY_EMPTY_THREAD');
    expect(firstTargetingRefusal({ ...base, history: 'UNREADABLE' })).toBe('IG_REPLY_EMPTY_THREAD');
    expect(firstTargetingRefusal({ ...base, history: 'HAS_HISTORY' })).toBeNull();
  });

  it('un composeur absent est un diagnostic, et il précède l’identité comme dans la primitive', () => {
    // L'ordre compte autant que les valeurs : la primitive s'arrête au PREMIER
    // refus, donc un diagnostic qui nommerait le dernier ferait chercher au
    // mauvais endroit.
    expect(
      firstTargetingRefusal({
        sessionUsable: true,
        account: 'MATCH',
        navigationMatch: true,
        composerFound: false,
        threadIdentity: 'UNKNOWN',
        history: 'EMPTY',
      }),
    ).toBe('IG_REPLY_COMPOSER_NOT_FOUND');
  });

  it('l’ordre complet des portes est celui de la primitive', () => {
    const worst = {
      sessionUsable: false,
      account: 'MISMATCH' as const,
      navigationMatch: false,
      composerFound: false,
      threadIdentity: 'MISMATCH' as const,
      history: 'EMPTY' as const,
    };
    expect(firstTargetingRefusal(worst)).toBe('IG_REPLY_SESSION_LOST');
    expect(firstTargetingRefusal({ ...worst, sessionUsable: true })).toBe('IG_REPLY_ACCOUNT_MISMATCH');
    expect(firstTargetingRefusal({ ...worst, sessionUsable: true, account: 'MATCH' })).toBe(
      'IG_REPLY_THREAD_NOT_REACHED',
    );
  });
});

// ---------------------------------------------------------------------------
// §11 — la géométrie RÉELLE d'un `/direct/t/…`, relevée le 22 août 2026
// ---------------------------------------------------------------------------

function rect(top: number, bottom: number, left: number, right: number): ReadRect {
  return { top, bottom, left, right, width: right - left, height: bottom - top };
}

/**
 * Les mesures telles que la page les a rendues, fenêtre 1280×900, sur le fil
 * `107403793987175` (@demo_account_17). Recopiées sans arrondi ni retouche.
 *
 *   * `d13` est le panneau : barre de titre de 77 px en premier enfant, liste
 *     des messages en second, composeur (y852..870) dessous ;
 *   * `d12` est la colonne de conversation SANS la barre de titre ;
 *   * `d17` porte en plus la liste des conversations (400 px à gauche).
 */
const REAL_ANCESTORS: readonly AncestorMeasure[] = [
  { depth: 1, tag: 'div', role: null, ariaLabel: null, isDocumentRoot: false,
    rect: rect(852, 870, 538, 1132),
    childRects: [rect(852, 870, 538, 1132), rect(870, 870, 538, 1132)] },
  { depth: 2, tag: 'div', role: null, ariaLabel: null, isDocumentRoot: false,
    rect: rect(839, 883, 500, 1252),
    childRects: [rect(843, 883, 500, 532), rect(852, 870, 538, 1132), rect(841, 881, 1138, 1256)] },
  { depth: 3, tag: 'div', role: null, ariaLabel: null, isDocumentRoot: false,
    rect: rect(839, 883, 489, 1263), childRects: [rect(839, 883, 500, 1252)] },
  { depth: 4, tag: 'div', role: null, ariaLabel: null, isDocumentRoot: false,
    rect: rect(839, 883, 489, 1263), childRects: [rect(839, 883, 489, 1263)] },
  { depth: 5, tag: 'div', role: null, ariaLabel: null, isDocumentRoot: false,
    rect: rect(838, 884, 488, 1264), childRects: [rect(839, 883, 489, 1263)] },
  { depth: 6, tag: 'div', role: null, ariaLabel: null, isDocumentRoot: false,
    rect: rect(822, 900, 472, 1280), childRects: [rect(838, 884, 488, 1264)] },
  ...[7, 8, 9, 10, 11].map((depth) => ({
    depth, tag: 'div', role: null, ariaLabel: null, isDocumentRoot: false,
    rect: rect(822, 900, 472, 1280), childRects: [rect(822, 900, 472, 1280)],
  })),
  { depth: 12, tag: 'div', role: null, ariaLabel: null, isDocumentRoot: false,
    rect: rect(77, 900, 472, 1280),
    childRects: [rect(77, 822, 472, 1280), rect(822, 900, 472, 1280)] },
  { depth: 13, tag: 'div', role: null, ariaLabel: null, isDocumentRoot: false,
    rect: rect(0, 900, 472, 1280),
    childRects: [rect(0, 77, 472, 1280), rect(77, 900, 472, 1280)] },
  ...[14, 15, 16].map((depth) => ({
    depth, tag: 'div', role: null, ariaLabel: null, isDocumentRoot: false,
    rect: rect(0, 900, 472, 1280), childRects: [rect(0, 900, 472, 1280)],
  })),
  { depth: 17, tag: 'div', role: null, ariaLabel: null, isDocumentRoot: false,
    rect: rect(0, 900, 72, 1280),
    childRects: [rect(0, 900, 72, 472), rect(0, 900, 472, 1280)] },
  { depth: 18, tag: 'div', role: null, ariaLabel: null, isDocumentRoot: false,
    rect: rect(0, 900, 72, 1280),
    childRects: [rect(0, 900, 72, 1280), rect(900, 900, 72, 1280)] },
];

const REAL_READ: RawThreadIdentityRead = {
  composerRect: rect(852, 870, 538, 1132),
  viewport: { width: 1280, height: 900 },
  ancestors: REAL_ANCESTORS,
  links: [{ handle: 'demo_account_17', rect: rect(24, 52, 500, 640) }],
  texts: [{ text: 'demo_account_17', rect: rect(24, 52, 500, 640) }],
};

describe('§11 — un vrai fil plein écran, tel qu’il a été mesuré', () => {
  it('les bornes par défaut le rejetaient — c’est le bogue que ce round a trouvé', () => {
    // Un panneau haut de 900 sur une fenêtre de 900 dépasse les 95 % admis. Le
    // vrai panneau était donc écarté, et `decideThreadIdentity` rendait
    // « aucun panneau de discussion identifiable ».
    expect(findPanelCandidates(REAL_READ, THREAD_IDENTITY_LIMITS)).toHaveLength(0);
  });

  it('les bornes du fil DIRECT en retiennent exactement un, et c’est le bon', () => {
    const candidates = findPanelCandidates(REAL_READ, DIRECT_THREAD_IDENTITY_LIMITS);
    expect(candidates).toHaveLength(1);
    const only = candidates[0];
    expect(only?.ancestor.depth).toBe(13);
    // Sa barre de titre, celle qui porte le nom du correspondant.
    expect(only?.header).toEqual(rect(0, 77, 472, 1280));

    const selection = selectThreadPanel(REAL_READ, DIRECT_THREAD_IDENTITY_LIMITS);
    expect(selection.kind).toBe('ok');
  });

  it('ce qui écarte les conteneurs plus extérieurs n’a PAS changé', () => {
    // La correction ne porte que sur la hauteur du panneau. Ce sont les
    // conditions inchangées — un premier enfant en forme de barre de titre —
    // qui écartent tout le reste, et il faut que ça reste vrai.
    const depths = findPanelCandidates(REAL_READ, DIRECT_THREAD_IDENTITY_LIMITS).map((c) => c.ancestor.depth);
    for (const rejected of [12, 14, 15, 16, 17, 18]) {
      expect(depths, `d${String(rejected)} ne doit pas être un panneau`).not.toContain(rejected);
    }
  });

  it('les deux jeux de bornes ne diffèrent que par UN champ', () => {
    const changed = (Object.keys(THREAD_IDENTITY_LIMITS) as (keyof typeof THREAD_IDENTITY_LIMITS)[]).filter(
      (key) => THREAD_IDENTITY_LIMITS[key] !== DIRECT_THREAD_IDENTITY_LIMITS[key],
    );
    expect(changed).toEqual(['panelMaxHeightRatio']);
    expect(THREAD_IDENTITY_LIMITS.panelMaxHeightRatio).toBe(0.95);
    expect(DIRECT_THREAD_IDENTITY_LIMITS.panelMaxHeightRatio).toBe(1);
    // La largeur reste bornée : sur le vrai fil la colonne fait 808 px sur
    // 1280, soit 63 %. Une largeur pleine page reste suspecte.
    expect(DIRECT_THREAD_IDENTITY_LIMITS.panelMaxWidthRatio).toBe(0.95);
  });

  it('un panneau pleine page SANS barre de titre reste refusé, même avec les bornes DIRECT', () => {
    // La garde qui compte vraiment. Si la barre supérieure n'a pas la forme
    // d'un en-tête de discussion, aucun panneau n'est retenu — c'est ce qui
    // empêche de lire l'en-tête d'une page de profil comme s'il nommait un fil.
    const flat: RawThreadIdentityRead = {
      ...REAL_READ,
      ancestors: [
        {
          depth: 1, tag: 'div', role: null, ariaLabel: null, isDocumentRoot: false,
          rect: rect(0, 900, 0, 1280),
          childRects: [rect(0, 400, 0, 1280), rect(400, 900, 0, 1280)],
        },
      ],
    };
    expect(findPanelCandidates(flat, DIRECT_THREAD_IDENTITY_LIMITS)).toHaveLength(0);
  });

  it('le rail d’inspection emploie les bornes DIRECT, et seulement après un fil vérifié', () => {
    const code = stripComments(INSPECTION_SOURCE);
    expect(code).toContain('DIRECT_THREAD_IDENTITY_LIMITS');
    expect(code).not.toMatch(/,\s*THREAD_IDENTITY_LIMITS\)/);
    // La condition est relue à l'exécution, pas confiée à l'ordre des appels.
    const guard = code.indexOf('if (!navigation.match)');
    const read = code.indexOf('await this.readThreadIdentity(composer)');
    expect(guard).toBeGreaterThan(0);
    expect(read).toBeGreaterThan(guard);
  });

  it('le canari garde les bornes par défaut — c’est SA situation qu’elles protègent', () => {
    const live = readFileSync(resolve(ROOT, 'src/lib/instagram/playwrightLiveRail.ts'), 'utf8');
    expect(live).toContain('THREAD_IDENTITY_LIMITS');
    expect(live).not.toContain('DIRECT_THREAD_IDENTITY_LIMITS');
  });
});

// ---------------------------------------------------------------------------
// §13 — la base, privée du droit d'écrire
// ---------------------------------------------------------------------------

describe('§13 — lecture seule', () => {
  const fake = (): Sql => ({
    driver: 'postgres',
    async query<T>(): Promise<T[]> {
      return [] as T[];
    },
    async exec(): Promise<void> {
      throw new Error('la vraie base a été appelée');
    },
    async transaction<T>(): Promise<T> {
      throw new Error('la vraie base a été appelée');
    },
    async close(): Promise<void> {
      /* rien */
    },
  });

  it('exec et transaction lèvent, sans condition', async () => {
    const sql = readOnlySql(fake(), 'test');
    await expect(sql.exec('select 1')).rejects.toThrow(/lecture seule/);
    await expect(sql.transaction(async () => 1)).rejects.toThrow(/lecture seule/);
  });

  it('toute requête non-SELECT est refusée au niveau de la SYNTAXE', async () => {
    const sql = readOnlySql(fake(), 'test');
    for (const statement of [
      'insert into hermes_conversation_effects (id) values (1)',
      'update prospects set do_not_contact = false',
      'delete from r6b_inbound_messages',
      'select 1; delete from prospects',
    ]) {
      await expect(sql.query(statement), statement).rejects.toThrow();
    }
    await expect(sql.query('select 1')).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §1 — la désignation d'un fil, et le résolveur qu'elle NE contourne PAS
// ---------------------------------------------------------------------------

describe('§1 — désignation d’une conversation réelle', () => {
  const empty = (): Sql => ({
    driver: 'postgres',
    async query<T>(): Promise<T[]> {
      return [] as T[];
    },
    async exec(): Promise<void> {
      /* jamais appelé */
    },
    async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
      return fn(empty());
    },
    async close(): Promise<void> {
      /* rien */
    },
  });

  it('un identifiant de fil malformé est refusé avant toute requête', async () => {
    const resolution = await resolveInspectionTarget(empty(), { kind: 'thread', threadId: 'demo_account_17' }, TEST_ACCOUNT_IDENTITY);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.refusal).toBe('INSPECT_THREAD_ID_MALFORMED');
  });

  it('une désignation qui ne correspond à rien refuse, sans repli', async () => {
    for (const selector of [
      { kind: 'inbound' as const, inboundMessageId: '00000000-0000-0000-0000-000000000000' },
      { kind: 'prospect' as const, prospectId: '00000000-0000-0000-0000-000000000000' },
      { kind: 'thread' as const, threadId: '999999999' },
    ]) {
      const resolution = await resolveInspectionTarget(empty(), selector, TEST_ACCOUNT_IDENTITY);
      expect(resolution.ok, JSON.stringify(selector)).toBe(false);
      if (!resolution.ok) expect(resolution.refusal).toBe('INSPECT_NO_CORRELATED_MESSAGE');
    }
  });

  it('la cible passe par le résolveur de PRODUCTION, jamais par une variante permissive', () => {
    // C'est tout l'intérêt de ce round : les concordances de
    // `resolveReplyTarget` (boîte qui est la nôtre, corrélation exploitable,
    // handle de la fiche, fil du message le plus récent, absence de lien vers
    // un autre prospect) doivent
    // être exercées contre des données réelles. Un résolveur écrit pour le
    // diagnostic n'aurait rien éprouvé.
    const source = stripComments(readFileSync(resolve(ROOT, 'src/lib/conversation/inspectionTarget.ts'), 'utf8'));
    expect(source).toContain("from '@/lib/conversation/replyTarget'");
    expect(source).toContain('await resolveReplyTarget(sql');
    // Et il n'écrit rien, ni ne lit de décision : il ne rend aucune
    // conversation éligible.
    for (const forbidden of ['insert ', 'update ', 'delete ', 'hermes_conversation_plans', 'assessInboundMessage']) {
      expect(source.toLowerCase(), forbidden).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// §6 — ce que la vraie page a montré du PÉRIMÈTRE du contrôle d'envoi
// ---------------------------------------------------------------------------

describe('§6 — le périmètre du contrôle d’envoi, mesuré puis CORRIGÉ', () => {
  it('l’ancre d’attribut a disparu : le périmètre est le panneau confirmé', () => {
    // Ce que ce round avait mesuré et rapporté sans corriger : l'ancre
    // `ancestor::*[@role="dialog" or @aria-label][1]` rend ZÉRO élément sur un
    // vrai `/direct/t/…`, parce qu'elle décrit le panneau du CANARI (une
    // discussion en surimpression d'un profil, qui est bien un `dialog`) et pas
    // un fil plein écran. Le contrôle n'était donc pas jugé absent : il n'était
    // pas cherché.
    //
    // HERMES-SEND-CONTROL-PROBE-R1 l'a corrigé après avoir SAISI dans un fil
    // contrôlé — la seule observation qui pouvait l'établir. Le périmètre est
    // désormais `panelRect`, le rectangle du panneau sur lequel l'identité du
    // correspondant vient d'être établie : une preuve strictement plus forte
    // qu'une propriété de forme. Voir `tests/sendControlProbe.test.ts`, qui
    // rejoue la géométrie réelle.
    const source = readFileSync(resolve(ROOT, 'src/lib/instagram/playwrightReplyRail.ts'), 'utf8');
    const code = stripComments(source);
    expect(code).not.toContain('role="dialog" or @aria-label');
    expect(code).toContain('decideSendControl(');
    expect(code).toContain('panelRect');
    // Et le refus reste sans clic : un seul site de clic dans tout le fichier.
    expect(code.match(/IG_REPLY_CONTROL_NOT_FOUND/g) ?? []).toHaveLength(1);
    expect(code.match(/\.click\(/g) ?? []).toHaveLength(1);
  });
});
