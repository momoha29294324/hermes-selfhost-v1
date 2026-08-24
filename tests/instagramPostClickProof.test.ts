import { describe, expect, it } from 'vitest';
import {
  adjudicateDelivery,
  chooseThreadScope,
  findApprovedTextBubbles,
  findFailureMarkers,
  findUnreadableAdjacentGlyphs,
  hasReadableStyle,
  isGlyphSized,
  MAX_GLYPH_SIZE_PX,
} from '@/lib/instagram/deliveryProof';
import type { AncestorLevel, ObservedNode, ObservedRect } from '@/lib/instagram/threadObservation';

/**
 * IG2.3 — la lecture d'APRÈS le clic, éprouvée sur les mesures réelles.
 *
 * Le 14 août 2026 à 11:29, le controlled test vers `operator_second_account` a produit un
 * clic, la bulle s'est affichée, et l'adjudication a rendu `AMBIGUOUS` avec
 * « 0 → 0 occurrence » et « handle du fil illisible ». La capture montrait
 * pourtant le message, en bulle sortante bleue, avec une pastille rouge ⊗
 * collée à son coin inférieur droit.
 *
 * Deux défauts, tous deux dans la lecture d'après-clic, tous deux figés ici :
 *
 *   1. le périmètre était REDÉCOUVERT après le clic et retombait au
 *      « niveau 1 (div) » — un conteneur de 96 px collé au composeur, alors que
 *      le message vit douze niveaux plus haut ;
 *   2. le marqueur d'échec n'était cherché que dans des MOTS, et cette
 *      pastille n'en porte aucun.
 *
 * La géométrie ci-dessous reprend celle de la capture : panneau flottant
 * y357..878, barre de titre y357..414, bulle sortante y742..792 à droite,
 * pastille rouge de 12 px à y783..795 x1246..1258.
 */

// --- Les mesures réelles ----------------------------------------------------
const PANEL: ObservedRect = { top: 357, bottom: 878, left: 898, right: 1258 };
const COMPOSER: ObservedRect = { top: 820, bottom: 860, left: 914, right: 1242 };
/** Le conteneur qui a piégé la première lecture : 96 px, collé au composeur. */
const LEVEL1: ObservedRect = { top: 812, bottom: 908, left: 906, right: 1250 };
const BUBBLE: ObservedRect = { top: 742, bottom: 792, left: 1010, right: 1242 };
const RED_GLYPH: ObservedRect = { top: 783, bottom: 795, left: 1246, right: 1258 };

const TEXT = 'Test technique Hermes — aucun suivi nécessaire.';
const HANDLE = 'operator_second_account';

function level(index: number, rect: ObservedRect, overrides: Partial<AncestorLevel> = {}): AncestorLevel {
  const height = rect.bottom - rect.top;
  return {
    index,
    tag: 'div',
    role: null,
    ariaLabel: null,
    rect,
    textBearingOutsideComposer: 18,
    heightRatio: height / (COMPOSER.bottom - COMPOSER.top),
    isDocumentRoot: false,
    ...overrides,
  };
}

/** La chaîne observée : niveau 1 minuscule, panneau au niveau 12, `main` au 13. */
const CHAIN: readonly AncestorLevel[] = [
  level(0, { top: 818, bottom: 862, left: 910, right: 1246 }, { textBearingOutsideComposer: 1, heightRatio: 1.1 }),
  level(1, LEVEL1),
  level(2, { top: 800, bottom: 878, left: 902, right: 1254 }),
  level(12, PANEL),
  level(13, { top: 0, bottom: 900, left: 0, right: 1280 }, { tag: 'main', isDocumentRoot: true }),
];

let nextId = 0;
function node(overrides: Partial<ObservedNode> & { level: number; rect: ObservedRect }): ObservedNode {
  nextId += 1;
  return {
    id: nextId,
    parentId: null,
    tag: 'div',
    role: null,
    ariaLabel: null,
    title: null,
    text: '',
    visible: true,
    color: 'rgb(0, 0, 0)',
    fill: null,
    ...overrides,
  };
}

/** La bulle sortante, au niveau du panneau. */
function bubbleNode(text = TEXT): ObservedNode {
  return node({ level: 12, rect: BUBBLE, text, color: 'rgb(255, 255, 255)' });
}

/** La pastille rouge, muette, collée au coin de la bulle. */
function redGlyph(): ObservedNode {
  return node({ level: 12, rect: RED_GLYPH, tag: 'svg', text: '', color: 'rgb(237, 73, 86)' });
}

function observationOf(nodes: readonly ObservedNode[]) {
  return {
    ancestorChain: CHAIN,
    nodes,
    handleLinks: [{ handle: HANDLE, level: 12 }],
    composerText: '',
    truncated: false,
    inbox: null,
  };
}

// ---------------------------------------------------------------------------
// 1. Le périmètre
// ---------------------------------------------------------------------------

describe('IG2.3 — le périmètre d’après-clic', () => {
  it('réutilise le panneau validé avant l’effet', () => {
    const scope = chooseThreadScope(CHAIN, { anchor: PANEL });
    expect(scope.kind).toBe('thread');
    expect(scope.level).toBe(12);
    expect(scope.detail).toContain('panneau validé');
  });

  it('rejette le faux scope niveau 1 qui avait piégé la première lecture', () => {
    // Sans ancre, l'ancienne heuristique retenait le niveau 1 : 18 éléments
    // porteurs de texte, hauteur ×2.4, les deux seuils franchis.
    const naive = chooseThreadScope(CHAIN);
    expect(naive.level).toBe(1);

    // Avec l'ancre, il n'est même plus candidat.
    const anchored = chooseThreadScope(CHAIN, { anchor: PANEL });
    expect(anchored.level).toBe(12);
  });

  it('tolère une enveloppe insérée entre la validation et la lecture', () => {
    // Nettement plus grand que la tolérance de 6 px : ce n'est pas le même
    // cadre, c'est une enveloppe qui le contient.
    const wrapper: ObservedRect = { top: 340, bottom: 890, left: 880, right: 1270 };
    const scope = chooseThreadScope([level(0, LEVEL1), level(9, wrapper)], { anchor: PANEL });
    expect(scope.level).toBe(9);
    expect(scope.detail).toContain('englobant');
  });

  it('refuse plutôt que de se rabattre quand le panneau a disparu', () => {
    const scope = chooseThreadScope([level(0, LEVEL1), level(1, COMPOSER)], { anchor: PANEL });
    expect(scope.kind).toBe('none');
    expect(scope.detail).toContain('n’a pas été retrouvé');
  });

  it('sans ancre, exige un périmètre qui contient au moins le texte cherché', () => {
    const scope = chooseThreadScope(CHAIN, { minLevel: 12 });
    expect(scope.level).toBe(12);
    expect(scope.rejected.join(' ')).toContain('trop petit pour contenir le texte');
  });
});

// ---------------------------------------------------------------------------
// 2. La bulle sortante
// ---------------------------------------------------------------------------

describe('IG2.3 — la bulle sortante', () => {
  it('retrouve la bulle exacte dans le panneau ancré', () => {
    const scope = chooseThreadScope(CHAIN, { anchor: PANEL });
    const bubbles = findApprovedTextBubbles([bubbleNode()], scope, TEXT);
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]?.outgoing).toBe(true);
    expect(bubbles[0]?.outgoingBasis).toBe('geometry');
    // La bulle est à droite du milieu du panneau (x898..1258, milieu 1078).
    expect(bubbles[0]?.centerRatio ?? 0).toBeGreaterThan(0.5);
  });

  it('ne trouve rien dans le faux scope niveau 1 — le « 0 → 0 » du 14 août', () => {
    const scope = chooseThreadScope(CHAIN);
    expect(findApprovedTextBubbles([bubbleNode()], scope, TEXT)).toHaveLength(0);
  });

  it('recolle un texte éclaté en plusieurs nœuds et garde l’Unicode', () => {
    const scope = chooseThreadScope(CHAIN, { anchor: PANEL });
    // Le tiret cadratin et l'espace insécable survivent à la normalisation ;
    // le texte reste celui du manifeste, au caractère près.
    const split = node({ level: 12, rect: BUBBLE, text: '  Test technique Hermes —\n aucun suivi nécessaire.  ' });
    expect(findApprovedTextBubbles([split], scope, TEXT)).toHaveLength(1);

    const different = node({ level: 12, rect: BUBBLE, text: 'Test technique Hermes - aucun suivi necessaire.' });
    expect(findApprovedTextBubbles([different], scope, TEXT)).toHaveLength(0);
  });

  it('une bulle entrante n’est pas sortante', () => {
    const scope = chooseThreadScope(CHAIN, { anchor: PANEL });
    const incoming = node({ level: 12, rect: { top: 500, bottom: 550, left: 910, right: 1100 }, text: TEXT });
    const bubbles = findApprovedTextBubbles([incoming], scope, TEXT);
    expect(bubbles[0]?.outgoing).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Le marqueur rouge
// ---------------------------------------------------------------------------

describe('IG2.3 — la pastille rouge d’échec', () => {
  const scope = () => chooseThreadScope(CHAIN, { anchor: PANEL });

  it('détecte la pastille rouge muette accolée à la bulle sortante', () => {
    const nodes = [bubbleNode(), redGlyph()];
    const bubbles = findApprovedTextBubbles(nodes, scope(), TEXT);
    const markers = findFailureMarkers(nodes, scope(), bubbles);
    expect(markers).toHaveLength(1);
    expect(markers[0]?.strength).toBe('visual');
    expect(markers[0]?.source).toBe('glyph');
    expect(markers[0]?.adjacentToOutgoing).toBe(true);
  });

  it('aucun marqueur quand rien de rouge n’est accolé', () => {
    const nodes = [bubbleNode(), node({ level: 12, rect: RED_GLYPH, text: '', color: 'rgb(0, 149, 246)' })];
    const bubbles = findApprovedTextBubbles(nodes, scope(), TEXT);
    expect(findFailureMarkers(nodes, scope(), bubbles)).toHaveLength(0);
  });

  it('une pastille rouge LOIN de la bulle ne compte pas', () => {
    const far = node({ level: 12, rect: { top: 380, bottom: 392, left: 1200, right: 1212 }, color: 'rgb(237, 73, 86)' });
    const nodes = [bubbleNode(), far];
    const bubbles = findApprovedTextBubbles(nodes, scope(), TEXT);
    expect(findFailureMarkers(nodes, scope(), bubbles)).toHaveLength(0);
  });

  it('un BLOC rouge n’est pas une pastille', () => {
    const block = node({
      level: 12,
      rect: { top: 742, bottom: 792, left: 1246, right: 1300 },
      color: 'rgb(237, 73, 86)',
    });
    const nodes = [bubbleNode(), block];
    const bubbles = findApprovedTextBubbles(nodes, scope(), TEXT);
    expect(findFailureMarkers(nodes, scope(), bubbles)).toHaveLength(0);
    expect(isGlyphSized(block.rect)).toBe(false);
    expect(isGlyphSized(RED_GLYPH)).toBe(true);
    expect(MAX_GLYPH_SIZE_PX).toBe(32);
  });

  it('une pastille dont le style est illisible bloque le SENT sans le renverser', () => {
    const blind = node({ level: 12, rect: RED_GLYPH, text: '', color: null, fill: null });
    const nodes = [bubbleNode(), blind];
    const bubbles = findApprovedTextBubbles(nodes, scope(), TEXT);
    expect(hasReadableStyle(blind)).toBe(false);
    expect(findFailureMarkers(nodes, scope(), bubbles)).toHaveLength(0);
    expect(findUnreadableAdjacentGlyphs(nodes, scope(), bubbles)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Le verdict
// ---------------------------------------------------------------------------

describe('IG2.3 — le verdict d’après-clic', () => {
  it('DELIVERY_FAILED l’emporte sur toutes les preuves positives', () => {
    // Texte exact, côté sortant, handle du fil lisible, récolte complète,
    // composeur vidé : les cinq preuves de l'envoi sont réunies. La pastille
    // rouge doit quand même l'emporter — c'est l'issue la plus dangereuse à
    // manquer.
    const verdict = adjudicateDelivery({
      observation: observationOf([bubbleNode(), redGlyph()]),
      approvedText: TEXT,
      expectedHandle: HANDLE,
      composerCleared: true,
      bubblesBefore: 0,
      anchorRect: PANEL,
    });
    expect(verdict.verdict).toBe('DELIVERY_FAILED');
    expect(verdict.failureMarkers[0]?.strength).toBe('visual');
  });

  it('SENT quand tout concorde et que rien de rouge n’est accolé', () => {
    const verdict = adjudicateDelivery({
      observation: observationOf([bubbleNode()]),
      approvedText: TEXT,
      expectedHandle: HANDLE,
      composerCleared: true,
      bubblesBefore: 0,
      anchorRect: PANEL,
    });
    expect(verdict.verdict).toBe('SENT');
    expect(verdict.scope.level).toBe(12);
  });

  it('jamais SENT sur une récolte illisible', () => {
    const verdict = adjudicateDelivery({
      observation: { ...observationOf([bubbleNode()]), truncated: true },
      approvedText: TEXT,
      expectedHandle: HANDLE,
      composerCleared: true,
      bubblesBefore: 0,
      anchorRect: PANEL,
    });
    expect(verdict.verdict).toBe('AMBIGUOUS');
  });

  it('jamais SENT quand une pastille adjacente est illisible', () => {
    const blind = node({ level: 12, rect: RED_GLYPH, text: '', color: null, fill: null });
    const verdict = adjudicateDelivery({
      observation: observationOf([bubbleNode(), blind]),
      approvedText: TEXT,
      expectedHandle: HANDLE,
      composerCleared: true,
      bubblesBefore: 0,
      anchorRect: PANEL,
    });
    expect(verdict.verdict).toBe('AMBIGUOUS');
    expect(verdict.proofs.some((proof) => proof.proof === 'failure_signal_readable')).toBe(true);
  });

  it('jamais SENT quand le panneau ancré a disparu', () => {
    const verdict = adjudicateDelivery({
      observation: { ...observationOf([bubbleNode()]), ancestorChain: [level(0, LEVEL1)] },
      approvedText: TEXT,
      expectedHandle: HANDLE,
      composerCleared: true,
      bubblesBefore: 0,
      anchorRect: PANEL,
    });
    expect(verdict.verdict).toBe('AMBIGUOUS');
    expect(verdict.scope.kind).toBe('none');
  });

  it('reproduit le verdict manqué du 14 août — et le corrige', () => {
    const nodes = [bubbleNode(), redGlyph()];

    // Ce que l'ancienne lecture faisait : pas d'ancre, périmètre redécouvert.
    const before = adjudicateDelivery({
      observation: { ...observationOf(nodes), nodes: nodes.filter((n) => n.level <= 1) },
      approvedText: TEXT,
      expectedHandle: HANDLE,
      composerCleared: true,
      bubblesBefore: 0,
    });
    expect(before.verdict).toBe('AMBIGUOUS');

    // Ce que la lecture réparée en tire.
    const after = adjudicateDelivery({
      observation: observationOf(nodes),
      approvedText: TEXT,
      expectedHandle: HANDLE,
      composerCleared: true,
      bubblesBefore: 0,
      anchorRect: PANEL,
    });
    expect(after.verdict).toBe('DELIVERY_FAILED');
  });
});
