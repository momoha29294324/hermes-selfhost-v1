import { describe, expect, it } from 'vitest';
import {
  adjudicateDelivery,
  chooseThreadScope,
  findApprovedTextBubbles,
  findFailureMarkers,
  isReddish,
  normalizeMessageText,
  readThreadHandle,
} from '@/lib/instagram/deliveryProof';
import { HARVEST_THREAD_IN_PAGE } from '@/lib/instagram/threadHarvest';
import {
  classifyInbox,
  SCAN_INBOX_IN_PAGE,
  type InboxRowMeasure,
  type InboxWitness,
} from '@/lib/instagram/inboxScan';
import { judgeSendOutcome } from '@/lib/instagram/liveWorker';
import type { InstagramSendObservation } from '@/lib/instagram/rail';
import type {
  AncestorLevel,
  ObservedNode,
  ObservedRect,
} from '@/lib/instagram/threadObservation';

/**
 * IG2.1 §8 — la preuve de livraison, éprouvée sur la structure RÉELLEMENT
 * observée le 14 août.
 *
 * Aucun test de ce fichier n'ouvre Instagram, et c'est tout l'intérêt : les
 * décisions qui ont échoué ce jour-là vivaient dans `page.evaluate`, où aucune
 * valeur ne pouvait leur être donnée. Elles vivent maintenant dans des
 * fonctions pures, et chacune des quatre causes plausibles du « 0 → 0 » a ici
 * son cas.
 *
 * Les mesures utilisées viennent de l'observation réelle, pas d'une invention :
 *
 *   * le conteneur du composeur portait DEUX contrôles, tous deux des icônes
 *     (`svg[aria-label="Choisir un emoji"]`, `div[role=button][aria-label="Envoyer"]`),
 *     donc ZÉRO élément porteur de texte hors du champ de saisie ;
 *   * la bulle du message était affichée dans le panneau, alignée à droite, avec
 *     un marqueur rouge accolé à son bord droit ;
 *   * le texte du manifeste porte des apostrophes typographiques.
 */

const APPROVED =
  'Bonjour, je regardais vos prestations et j’ai vu que vous proposez aussi d’intervenir à domicile, ' +
  'c’est pratique comme fonctionnement.';

const HANDLE = 'demo_prospect_a';

function rect(left: number, right: number, top = 100, bottom = 140): ObservedRect {
  return { left, right, top, bottom };
}

function node(over: Partial<ObservedNode> & { id: number }): ObservedNode {
  return {
    parentId: null,
    level: 0,
    tag: 'div',
    role: null,
    ariaLabel: null,
    title: null,
    text: '',
    rect: rect(0, 10),
    visible: true,
    color: null,
    fill: null,
    ...over,
  };
}

function level(over: Partial<AncestorLevel> & { index: number }): AncestorLevel {
  return {
    tag: 'div',
    role: null,
    ariaLabel: null,
    rect: rect(900, 1260, 360, 880),
    textBearingOutsideComposer: 0,
    heightRatio: 1,
    isDocumentRoot: false,
    ...over,
  };
}

/**
 * La chaîne d'ancêtres telle qu'elle se présentait : le conteneur du composeur
 * d'abord (deux icônes, aucun texte, à peine plus haut que le champ), puis le
 * panneau de discussion (l'en-tête, l'horodatage, la bulle).
 */
const REAL_CHAIN: readonly AncestorLevel[] = [
  level({
    index: 0,
    ariaLabel: 'Message',
    rect: rect(914, 1242, 820, 860),
    textBearingOutsideComposer: 0,
    heightRatio: 1.1,
  }),
  level({
    index: 1,
    rect: rect(900, 1260, 810, 870),
    textBearingOutsideComposer: 0,
    heightRatio: 1.5,
  }),
  level({
    index: 2,
    role: 'dialog',
    rect: rect(898, 1260, 360, 880),
    textBearingOutsideComposer: 9,
    heightRatio: 13,
  }),
  level({ index: 3, tag: 'main', rect: rect(0, 1280, 0, 900), textBearingOutsideComposer: 240, heightRatio: 22.5, isDocumentRoot: true }),
];

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

describe('normalisation du texte', () => {
  it('rapproche apostrophe typographique et apostrophe droite', () => {
    expect(normalizeMessageText('j’ai vu')).toBe(normalizeMessageText("j'ai vu"));
  });

  it('rapproche espace insécable, espace fine et espace ordinaire', () => {
    expect(normalizeMessageText('question : aujourd’hui')).toBe(
      normalizeMessageText("question : aujourd'hui"),
    );
    expect(normalizeMessageText('a b')).toBe('a b');
  });

  it('supprime les caractères invisibles — césure conditionnelle et largeur nulle', () => {
    expect(normalizeMessageText('bouche-­à-oreille')).toBe('bouche-à-oreille');
    expect(normalizeMessageText('bou​che')).toBe('bouche');
  });

  it('unifie les tirets, les guillemets et les points de suspension', () => {
    expect(normalizeMessageText('a – b')).toBe('a - b');
    expect(normalizeMessageText('“x”')).toBe('"x"');
    expect(normalizeMessageText('fin…')).toBe('fin...');
  });

  it('applique NFC : deux encodages du même « à » se valent', () => {
    expect(normalizeMessageText('à domicile')).toBe(normalizeMessageText('à domicile'));
  });

  it('ne rapproche PAS deux textes réellement différents', () => {
    expect(normalizeMessageText('Bonjour')).not.toBe(normalizeMessageText('bonjour'));
    expect(normalizeMessageText('a b c')).not.toBe(normalizeMessageText('a b'));
  });
});

// ---------------------------------------------------------------------------
// §3 — le périmètre, cause exacte du « 0 → 0 »
// ---------------------------------------------------------------------------

describe('périmètre du fil', () => {
  it('écarte le conteneur du composeur — la cause exacte du 14 août', () => {
    const scope = chooseThreadScope(REAL_CHAIN);
    // Le niveau 0 portait un `aria-label` : l'ancien code s'y arrêtait, et y
    // cherchait des bulles de message. Il n'en contient aucune, par
    // construction : ses deux seuls contrôles sont des icônes.
    expect(scope.level).toBe(2);
    expect(scope.kind).toBe('thread');
    expect(scope.rejected.join(' ')).toContain('niveau 0');
    expect(scope.rejected.join(' ')).toContain('niveau 1');
  });

  it('nomme la racine du document comme telle, et refuse d’en tirer un envoi', () => {
    const scope = chooseThreadScope([REAL_CHAIN[0]!, REAL_CHAIN[3]!]);
    expect(scope.kind).toBe('document_root');
  });

  it('sans chaîne lisible, aucun périmètre — et le refus le dit', () => {
    const scope = chooseThreadScope([]);
    expect(scope.kind).toBe('none');
    expect(scope.level).toBe(-1);
    expect(scope.detail).toContain('aucune chaîne');
  });
});

// ---------------------------------------------------------------------------
// §3 — texte réparti sur plusieurs nœuds
// ---------------------------------------------------------------------------

describe('occurrences du texte approuvé', () => {
  const scope = chooseThreadScope(REAL_CHAIN);

  /** La bulle telle qu'Instagram la rend : un conteneur, des fragments dedans. */
  function splitBubble(text: string, id = 10): ObservedNode[] {
    const cut = Math.floor(text.length / 3);
    return [
      node({ id, level: 2, text, rect: rect(1010, 1242, 520, 790) }),
      node({ id: id + 1, parentId: id, level: 2, tag: 'span', text: text.slice(0, cut), rect: rect(1020, 1230, 520, 560) }),
      node({ id: id + 2, parentId: id, level: 2, tag: 'span', text: text.slice(cut), rect: rect(1020, 1230, 560, 790) }),
    ];
  }

  it('retrouve un texte réparti sur plusieurs nœuds, et ne le compte qu’une fois', () => {
    const bubbles = findApprovedTextBubbles(splitBubble(APPROVED), scope, APPROVED);
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]!.nodeId).toBe(10);
  });

  it('retrouve le texte malgré des apostrophes rendues différemment', () => {
    const rendered = APPROVED.replace(/’/g, "'").replace(/ /g, ' ');
    const bubbles = findApprovedTextBubbles(splitBubble(rendered), scope, APPROVED);
    expect(bubbles).toHaveLength(1);
  });

  it('ne compte pas le conteneur en plus de la bulle', () => {
    const nodes = [
      node({ id: 1, level: 2, text: APPROVED, rect: rect(1000, 1250, 500, 800) }),
      node({ id: 2, parentId: 1, level: 2, text: APPROVED, rect: rect(1010, 1242, 520, 790) }),
    ];
    const bubbles = findApprovedTextBubbles(nodes, scope, APPROVED);
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]!.nodeId).toBe(2);
  });

  it('ignore un brouillon resté dans le composeur — un brouillon n’est pas un envoi', () => {
    const nodes = [node({ id: 1, level: -1, text: APPROVED, rect: rect(920, 1230, 820, 860) })];
    expect(findApprovedTextBubbles(nodes, scope, APPROVED)).toHaveLength(0);
  });

  it('ignore une occurrence invisible', () => {
    const nodes = [node({ id: 1, level: 2, text: APPROVED, visible: false, rect: rect(0, 0, 0, 0) })];
    expect(findApprovedTextBubbles(nodes, scope, APPROVED)).toHaveLength(0);
  });

  it('distingue le côté sortant du côté entrant par la géométrie', () => {
    const outgoing = findApprovedTextBubbles(
      [node({ id: 1, level: 2, text: APPROVED, rect: rect(1010, 1242, 520, 790) })],
      scope,
      APPROVED,
    );
    expect(outgoing[0]!.outgoing).toBe(true);
    expect(outgoing[0]!.outgoingBasis).toBe('geometry');

    const incoming = findApprovedTextBubbles(
      [node({ id: 1, level: 2, text: APPROVED, rect: rect(910, 1050, 520, 790) })],
      scope,
      APPROVED,
    );
    expect(incoming[0]!.outgoing).toBe(false);
  });

  it('accepte un libellé accessible comme preuve du côté sortant, sans la géométrie', () => {
    const nodes = [
      node({ id: 1, level: 2, ariaLabel: 'Vous avez envoyé', rect: rect(905, 1055, 500, 800) }),
      node({ id: 2, parentId: 1, level: 2, text: APPROVED, rect: rect(910, 1050, 520, 790) }),
    ];
    const bubbles = findApprovedTextBubbles(nodes, scope, APPROVED);
    expect(bubbles[0]!.outgoing).toBe(true);
    expect(bubbles[0]!.outgoingBasis).toBe('accessible');
  });
});

// ---------------------------------------------------------------------------
// §4 — le marqueur d'échec
// ---------------------------------------------------------------------------

describe('marqueur d’échec de livraison', () => {
  const scope = chooseThreadScope(REAL_CHAIN);
  const bubble = node({ id: 1, level: 2, text: APPROVED, rect: rect(1010, 1242, 520, 790) });

  it('reconnaît un libellé accessible explicite accolé à la bulle', () => {
    const marker = node({ id: 2, level: 2, role: 'button', ariaLabel: 'Non envoyé', rect: rect(1246, 1262, 776, 792) });
    const bubbles = findApprovedTextBubbles([bubble], scope, APPROVED);
    const markers = findFailureMarkers([bubble, marker], scope, bubbles);
    expect(markers).toHaveLength(1);
    expect(markers[0]!.strength).toBe('explicit');
    expect(markers[0]!.source).toBe('aria-label');
  });

  it('reconnaît « not delivered » et « failed to send » aussi', () => {
    const bubbles = findApprovedTextBubbles([bubble], scope, APPROVED);
    for (const label of ['Not delivered', 'Failed to send', 'Message non envoyé', 'Échec de l’envoi']) {
      const marker = node({ id: 2, level: 2, ariaLabel: label, rect: rect(1246, 1262, 776, 792) });
      expect(findFailureMarkers([bubble, marker], scope, bubbles)[0]?.strength, label).toBe('explicit');
    }
  });

  it('classe « réessayer » comme un indice, pas comme une affirmation', () => {
    const bubbles = findApprovedTextBubbles([bubble], scope, APPROVED);
    const marker = node({ id: 2, level: 2, ariaLabel: 'Réessayer', rect: rect(1246, 1262, 776, 792) });
    expect(findFailureMarkers([bubble, marker], scope, bubbles)[0]!.strength).toBe('retry');
  });

  it('ignore un marqueur qui n’est accolé à aucune bulle', () => {
    const bubbles = findApprovedTextBubbles([bubble], scope, APPROVED);
    const distant = node({ id: 2, level: 2, ariaLabel: 'Non envoyé', rect: rect(905, 930, 380, 400) });
    expect(findFailureMarkers([bubble, distant], scope, bubbles)).toHaveLength(0);
  });

  it('lit une couleur rouge, et refuse de prendre le bleu pour du rouge', () => {
    expect(isReddish('rgb(237, 73, 86)')).toBe(true);
    expect(isReddish('rgba(255, 48, 64, 0.9)')).toBe(true);
    expect(isReddish('rgb(0, 149, 246)')).toBe(false);
    expect(isReddish('rgb(38, 38, 38)')).toBe(false);
    expect(isReddish(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Identité du fil
// ---------------------------------------------------------------------------

describe('identité du fil', () => {
  const scope = chooseThreadScope(REAL_CHAIN);

  it('accepte un lien de profil dans le périmètre', () => {
    expect(readThreadHandle([{ handle: HANDLE, level: 2 }], [], scope, HANDLE)).toBe(HANDLE);
  });

  it('refuse dès qu’un seul lien diverge', () => {
    const links = [
      { handle: HANDLE, level: 2 },
      { handle: 'unautrecompte', level: 2 },
    ];
    expect(readThreadHandle(links, [], scope, HANDLE)).toBeNull();
  });

  it('à défaut de lien, accepte le handle écrit en toutes lettres — jamais un préfixe', () => {
    const nodes = [node({ id: 1, level: 2, text: `${HANDLE} · Instagram` })];
    expect(readThreadHandle([], nodes, scope, HANDLE)).toBe(HANDLE);

    const lookalike = [node({ id: 1, level: 2, text: 'demo_prospect_a2 · Instagram' })];
    expect(readThreadHandle([], lookalike, scope, HANDLE)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §4 — le verdict, et sa hiérarchie
// ---------------------------------------------------------------------------

describe('verdict de livraison', () => {
  const sentNodes: readonly ObservedNode[] = [
    node({ id: 1, level: 2, text: APPROVED, rect: rect(1010, 1242, 520, 790) }),
    node({ id: 2, level: 2, text: '08:43', rect: rect(1070, 1100, 486, 502) }),
  ];

  function adjudicate(over: Partial<Parameters<typeof adjudicateDelivery>[0]['observation']> = {}) {
    return adjudicateDelivery({
      observation: {
        ancestorChain: REAL_CHAIN,
        nodes: sentNodes,
        handleLinks: [{ handle: HANDLE, level: 2 }],
        composerText: '',
        truncated: false,
        inbox: null,
        ...over,
      },
      approvedText: APPROVED,
      expectedHandle: HANDLE,
    });
  }

  it('conclut SENT quand tout concorde et qu’aucun marqueur d’échec n’est accolé', () => {
    const verdict = adjudicate();
    expect(verdict.verdict).toBe('SENT');
    expect(verdict.outgoingBubbles).toHaveLength(1);
  });

  it('l’échec explicite l’emporte sur toutes les preuves positives', () => {
    // Le cœur d'IG2.1 : un message non remis reste AFFICHÉ, aligné à droite,
    // portant le texte exact. Il satisfait chacune des preuves ci-dessus.
    const failed = adjudicate({
      nodes: [
        ...sentNodes,
        node({ id: 3, level: 2, role: 'button', ariaLabel: 'Non envoyé', rect: rect(1246, 1262, 776, 792) }),
      ],
    });
    expect(failed.verdict).toBe('DELIVERY_FAILED');
    expect(failed.failureMarkers).toHaveLength(1);
  });

  it('un « réessayer » rouge suffit ; un « réessayer » sans corroboration ne conclut pas', () => {
    const red = adjudicate({
      nodes: [
        ...sentNodes,
        node({
          id: 3,
          level: 2,
          role: 'button',
          ariaLabel: 'Réessayer',
          color: 'rgb(237, 73, 86)',
          rect: rect(1246, 1262, 776, 792),
        }),
      ],
    });
    expect(red.verdict).toBe('DELIVERY_FAILED');

    const grey = adjudicate({
      nodes: [
        ...sentNodes,
        node({
          id: 3,
          level: 2,
          role: 'button',
          ariaLabel: 'Réessayer',
          color: 'rgb(38, 38, 38)',
          rect: rect(1246, 1262, 776, 792),
        }),
      ],
    });
    // Ni envoyé (un marqueur traîne), ni échec prouvé : le doute reste le doute.
    expect(grey.verdict).toBe('AMBIGUOUS');
  });

  it('une récolte tronquée ne prouve jamais un envoi', () => {
    expect(adjudicate({ truncated: true }).verdict).toBe('AMBIGUOUS');
  });

  it('un périmètre non résolu ne prouve jamais un envoi', () => {
    expect(adjudicate({ ancestorChain: [] }).verdict).toBe('AMBIGUOUS');
  });

  it('un fil dont l’identité ne se lit pas ne prouve jamais un envoi', () => {
    expect(adjudicate({ handleLinks: [{ handle: 'autre', level: 2 }] }).verdict).toBe('AMBIGUOUS');
  });
});

/**
 * Une ligne de boîte, telle que la page la mesure.
 *
 * `timeLabel` est DÉRIVÉ du segment qui suit le dernier « · », parce que c'est
 * exactement ce que porte le nœud d'horodatage de l'interface : la date, sans
 * l'aperçu. Depuis IG5 R2, l'âge se lit là et seulement là.
 */
function row(index: number, text: string): InboxRowMeasure {
  return {
    index,
    threadId: null,
    text,
    timeLabel: timeLabelOf(text),
    imageAlts: [],
    ariaLabels: [],
    rect: { left: 96, right: 456, top: 300 + index * 72, bottom: 372 + index * 72 },
  };
}

/** Le dernier segment d'une ligne — ce que le nœud de date affiche. */
function timeLabelOf(text: string): string | null {
  const parts = text.split('·');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const trimmed = last === undefined ? '' : last.trim();
  return trimmed.length === 0 ? null : trimmed;
}

// ---------------------------------------------------------------------------
// §2 — le témoin du côté serveur : la boîte de réception
// ---------------------------------------------------------------------------
//
// IG2.4 — ce bloc a été RÉÉCRIT parce que ce qu'il affirmait était faux.
//
// Il figeait le comportement du 14 août : « treize vignettes, 866 caractères,
// aucune trace de la cible ⇒ non-remise prouvée ». La capture montre pourtant
// la conversation, en tête de liste. Le scanner n'avait compris AUCUNE ligne
// (il cherchait des `a[href^="/direct/t/"]`, que l'UI n'utilise plus) et
// cherchait un handle là où la ligne affiche un nom d'affichage.
//
// Un test qui grave une conclusion fausse est pire qu'une absence de test : il
// la défend.

describe('boîte de réception de l’expéditeur', () => {
  function adjudicateWith(inbox: InboxWitness, effectAgeMs: number | null = null) {
    return adjudicateDelivery({
      observation: {
        ancestorChain: [],
        nodes: [],
        handleLinks: [],
        composerText: '',
        truncated: false,
        inbox,
      },
      approvedText: APPROVED,
      expectedHandle: HANDLE,
      effectAgeMs,
    });
  }

  it('une boîte dont aucune ligne n’a été comprise ne prouve RIEN', () => {
    // Exactement le cas du 14 août : des vignettes, du texte, zéro ligne lue.
    const witness = classifyInbox({
      read: { listFound: false, rows: [], avatarCount: 13, visibleTextLength: 866, viewerLabel: 'hermesagency_' },
      expectedHandle: HANDLE,
      expectedDisplayName: 'Moha',
      approvedPrefix: APPROVED.slice(0, 40),
    });
    expect(witness.readability).toBe('INBOX_UNREADABLE');
    expect(witness.presence).toBe('THREAD_UNKNOWN');
    expect(adjudicateWith(witness).verdict).not.toBe('DELIVERY_FAILED');
  });

  it('une liste réellement lue, sans la conversation, prouve la non-remise', () => {
    const witness = classifyInbox({
      read: {
        listFound: true,
        rows: [row(0, 'Kilo Moralex Tu ne lui répond pas ? · 49 sem.'), row(1, 'Maxence Crl Cool · 50 sem.'), row(2, 'Elo Vous: Parfait · 50 sem.')],
        avatarCount: 13,
        visibleTextLength: 866,
        viewerLabel: 'hermesagency_',
      },
      expectedHandle: HANDLE,
      expectedDisplayName: 'Moha',
      approvedPrefix: APPROVED.slice(0, 40),
    });
    expect(witness.readability).toBe('INBOX_READABLE');
    expect(witness.presence).toBe('THREAD_NOT_FOUND');
    expect(adjudicateWith(witness).verdict).toBe('DELIVERY_FAILED');
  });

  it('un fil présent mais non remonté prouve la non-remise, et le dit correctement', () => {
    const witness = classifyInbox({
      read: {
        listFound: true,
        rows: [
          row(0, 'Moha https://id-preview--f8c00bcf-1639-… · 11 sem.'),
          row(1, 'Utilisateur Instagram Je t’ai appelé plusieurs fois · 22 sem.'),
          row(2, 'Petit loup Bonsoir, plutôt · 49 sem.'),
        ],
        avatarCount: 13,
        visibleTextLength: 866,
        viewerLabel: 'hermesagency_',
      },
      expectedHandle: HANDLE,
      expectedDisplayName: 'Moha',
      approvedPrefix: APPROVED.slice(0, 40),
    });
    expect(witness.presence).toBe('THREAD_PRESENT');
    expect(witness.row?.basis).toBe('corroborated_display_name');

    // Tentative il y a 15 minutes, fil vieux de 11 semaines : non remonté.
    const verdict = adjudicateWith(witness, 15 * 60_000);
    expect(verdict.verdict).toBe('DELIVERY_FAILED');
    expect(verdict.detail).toContain('n’a PAS été remontée');
  });

  it('un fil remonté et portant l’aperçu approuvé ne conclut pas à l’échec', () => {
    const witness = classifyInbox({
      read: {
        listFound: true,
        rows: [
          row(0, `Moha Vous: ${APPROVED} · Maintenant`),
          row(1, 'Petit loup Bonsoir · 49 sem.'),
          row(2, 'Elo Vous: Parfait · 50 sem.'),
        ],
        avatarCount: 13,
        visibleTextLength: 866,
        viewerLabel: 'hermesagency_',
      },
      expectedHandle: HANDLE,
      expectedDisplayName: 'Moha',
      approvedPrefix: APPROVED.slice(0, 40),
    });
    expect(witness.row?.previewMatchesApproved).toBe(true);
    expect(witness.row?.ageMs).toBe(0);
    expect(adjudicateWith(witness, 15 * 60_000).verdict).not.toBe('DELIVERY_FAILED');
  });
});

// ---------------------------------------------------------------------------
// §3 — la panne qui a produit le « 0 → 0 », rendue impossible
// ---------------------------------------------------------------------------

describe('code exécuté dans la page', () => {
  /**
   * La régression la plus importante de cette mission.
   *
   * `tsx` transpile avec esbuild, `keepNames` actif : toute fonction NOMMÉE —
   * y compris une flèche affectée à un `const` — devient
   * `__name((v) => …, "nom")`. Playwright ne transmet pas le module, seulement
   * la source de la fonction ; `__name` n'existe donc pas dans la page, et le
   * corps lève `ReferenceError` dès sa première ligne. C'est exactement ce qui
   * s'est passé le 14 août : la fonction qui comptait les bulles n'a jamais
   * tourné, et le `catch` qui l'entourait a rendu « 0 occurrence ».
   *
   * Le test lit la source telle que Playwright la sérialisera.
   */
  it('ne référence jamais l’aide `__name` d’esbuild', () => {
    for (const fn of [HARVEST_THREAD_IN_PAGE, SCAN_INBOX_IN_PAGE]) {
      expect(fn.toString()).not.toContain('__name');
    }
  });

  it('ne déclare aucune fonction nommée dans son corps', () => {
    // La règle qui garantit la propriété ci-dessus pour tout futur diff :
    // aucune affectation de fonction à un identifiant, aucune déclaration.
    for (const fn of [HARVEST_THREAD_IN_PAGE, SCAN_INBOX_IN_PAGE]) {
      const body = fn.toString();
      expect(body).not.toMatch(/\b(const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/);
      expect(body.replace(/^function[^(]*/, '')).not.toMatch(/\bfunction\s+[A-Za-z_$]/);
    }
  });
});

// ---------------------------------------------------------------------------
// §8 — aucune mutation SENT sur un échec de livraison
// ---------------------------------------------------------------------------

describe('jugement du canari LIVE', () => {
  const base: InstagramSendObservation = Object.freeze({
    threadUrl: 'https://www.instagram.com/demo_prospect_a/',
    threadHandle: HANDLE,
    matchingBubblesBefore: 0,
    matchingBubblesAfter: 1,
    harvestReadableBefore: true,
    harvestReadableAfter: true,
    composerCleared: true,
    outgoingBubbleConfirmed: true,
    deliveryFailureMarkers: Object.freeze([]),
    deliveryVerdict: 'SENT',
    scopeDetail: 'niveau 2 (div[role=dialog])',
    sessionState: 'SESSION_READY',
    screenshotPath: null,
    durationMs: 42,
    detail: '',
  });

  it('un échec de livraison ne devient JAMAIS un envoi, même avec toutes les autres preuves', () => {
    const judgement = judgeSendOutcome(
      {
        ...base,
        deliveryVerdict: 'DELIVERY_FAILED',
        deliveryFailureMarkers: Object.freeze(['explicit/aria-label « non envoyé »']),
      },
      HANDLE,
    );
    expect(judgement.outcome).toBe('DELIVERY_FAILED');
    expect(judgement.detail).toContain('NON REMIS');
  });

  it('une récolte illisible n’est pas une récolte vide — et ne prouve rien', () => {
    // Le défaut exact du 14 août, dans le vocabulaire du worker : les compteurs
    // valaient 0 parce que la mesure n'avait pas eu lieu, et rien ne le disait.
    expect(judgeSendOutcome({ ...base, harvestReadableAfter: false }, HANDLE).outcome).toBe('AMBIGUOUS');
    expect(judgeSendOutcome({ ...base, harvestReadableBefore: false }, HANDLE).missing.join(' ')).toContain(
      'n’a pas pu s’exécuter',
    );
  });

  it('un marqueur d’échec traînant empêche le SENT sans le transformer en échec prouvé', () => {
    const judgement = judgeSendOutcome(
      { ...base, deliveryVerdict: 'AMBIGUOUS', deliveryFailureMarkers: Object.freeze(['retry/text « réessayer »']) },
      HANDLE,
    );
    expect(judgement.outcome).toBe('AMBIGUOUS');
  });

  it('toutes les preuves réunies concluent SENT', () => {
    expect(judgeSendOutcome(base, HANDLE).outcome).toBe('SENT');
  });
});
