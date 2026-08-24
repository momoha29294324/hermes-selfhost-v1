import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import {
  armControlledTest,
  consumeControlledTestReservation,
  CONTROLLED_TEST_PAYLOAD,
  isDefinitiveOutcome,
  loadControlledTest,
  listControlledTestEvents,
  markControlledTestEffect,
  recordControlledTestEvent,
  recordControlledTestOutcome,
  reserveControlledTest,
  resolveControlledTestOutcome,
  type ControlledTestOutcome,
} from '@/lib/instagram/controlledTest';
import { adjudicateDelivery, hasUnboundExplicitFailureSignal, inboxConfirmsDelivery } from '@/lib/instagram/deliveryProof';
import type { InboxWitness, MatchedInboxRow } from '@/lib/instagram/inboxScan';
import type { ObservedNode } from '@/lib/instagram/threadObservation';
import { UNREAD_RELATIONSHIP } from '@/lib/instagram/relationship';
import { setKillSwitch } from '@/lib/instagram/safety';

/**
 * IG2.9 — une lecture impossible n'est pas une lecture contraire.
 *
 * Le 14 août, un `SENT` prouvé a été relu par une adjudication qui n'a pas pu
 * rouvrir le fil. Ses quatre preuves internes sont revenues ILLISIBLES,
 * `adjudicateDelivery` a rendu `AMBIGUOUS` — honnêtement — et
 * `resolveControlledTestOutcome` a comparé `SENT` à `AMBIGUOUS` pour en tirer
 * `CONTRADICTS`. Aucune preuve contraire n'existait pourtant : la lecture
 * n'avait pas eu lieu.
 *
 * Ces tests fixent la frontière. Ils décrivent surtout ce qui NE doit PAS
 * arriver — une issue terminale renversée par un silence.
 */

const MINUTE = 60_000;

let dir = '';
let sql: Awaited<ReturnType<typeof createPgliteSql>>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ig29-'));
  sql = await createPgliteSql(join(dir, 'pg'));
  await migrate(sql);
});

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await setKillSwitch(sql, { engaged: false, setBy: 'test', reason: 'suite IG2.9' });
});

/**
 * Un test contrôlé mené jusqu'à une issue terminale, par la séquence RÉELLE du
 * rail : armer, réserver, consommer l'autorisation, marquer l'effet, inscrire
 * l'issue. Raccourcir cette séquence ferait tester autre chose que ce qui tourne.
 *
 * Chaque appel utilise un handle distinct : une seule autorisation peut être
 * vivante à la fois, et une clé d'idempotence ne porte qu'un effet pour
 * toujours — deux gardes qu'on ne contourne pas, même dans un test.
 */
let handleSeq = 0;
async function attemptWithOutcome(prefix: string, outcome: ControlledTestOutcome): Promise<string> {
  handleSeq += 1;
  const test = await armControlledTest(sql, {
    targetHandle: `${prefix}_${handleSeq}`,
    armedBy: 'Operator Example',
    reason: 'régression IG2.9',
    consentNote: 'compte de test contrôlé et consentant, attesté pour la suite de régression',
    ttlMs: 5 * MINUTE,
  });
  await reserveControlledTest(sql, { testId: test.id, workerId: 'w1', targetHandle: test.targetHandle });
  await consumeControlledTestReservation(sql, { testId: test.id, workerId: 'w1' });
  await markControlledTestEffect(sql, test.id);
  await recordControlledTestOutcome(sql, { testId: test.id, outcome, detail: `issue initiale ${outcome}` });
  return test.id;
}

// ---------------------------------------------------------------------------
// L'invariant de terminalité
// ---------------------------------------------------------------------------

describe('IG2.9 — un SENT terminal ne se renverse pas par un silence', () => {
  it('SENT + relecture illisible → INCONCLUSIVE, l’issue reste SENT', async () => {
    const testId = await attemptWithOutcome('realg_972', 'SENT');
    const resolution = await resolveControlledTestOutcome(sql, {
      testId,
      observed: 'AMBIGUOUS',
      detail: 'fil non ouvrable — aucune preuve interne lisible',
    });

    expect(resolution.kind).toBe('INCONCLUSIVE');
    const after = await loadControlledTest(sql, testId);
    expect(after?.outcome).toBe('SENT');
  });

  it('DELIVERY_FAILED + relecture illisible → INCONCLUSIVE, l’issue reste FAILED', async () => {
    const testId = await attemptWithOutcome('operator_second_account', 'DELIVERY_FAILED');
    const resolution = await resolveControlledTestOutcome(sql, {
      testId,
      observed: 'AMBIGUOUS',
      detail: 'fil non ouvrable',
    });

    expect(resolution.kind).toBe('INCONCLUSIVE');
    expect((await loadControlledTest(sql, testId))?.outcome).toBe('DELIVERY_FAILED');
  });

  it('UNREADABLE ne devient jamais CONTRADICTS, quelle que soit l’issue inscrite', async () => {
    for (const outcome of ['SENT', 'DELIVERY_FAILED'] as const) {
      const testId = await attemptWithOutcome('cible_test', outcome);
      const resolution = await resolveControlledTestOutcome(sql, {
        testId,
        observed: 'AMBIGUOUS',
        detail: 'illisible',
      });
      expect(resolution.kind).not.toBe('CONTRADICTS');
    }
  });

  it('une preuve DÉFINITIVE contraire, elle, reste détectée — et n’écrase rien', async () => {
    const testId = await attemptWithOutcome('cible_test', 'SENT');
    const resolution = await resolveControlledTestOutcome(sql, {
      testId,
      observed: 'DELIVERY_FAILED',
      detail: 'marqueur explicite « failed to send » relu dans un fil lisible',
    });

    expect(resolution.kind).toBe('CONTRADICTS');
    // Le refus ne réécrit pas : la divergence se tranche à la main.
    expect((await loadControlledTest(sql, testId))?.outcome).toBe('SENT');
  });

  it('une relecture qui confirme ne recompte pas la décision', async () => {
    const testId = await attemptWithOutcome('cible_test', 'SENT');
    const resolution = await resolveControlledTestOutcome(sql, { testId, observed: 'SENT', detail: 'confirmé' });
    expect(resolution.kind).toBe('UNCHANGED');
  });

  it('un AMBIGUOUS inscrit reste résolvable — c’est la raison d’être de l’adjudication', async () => {
    const testId = await attemptWithOutcome('cible_test', 'AMBIGUOUS');
    const resolution = await resolveControlledTestOutcome(sql, {
      testId,
      observed: 'DELIVERY_FAILED',
      detail: 'marqueur explicite relu',
    });
    expect(resolution.kind).toBe('RESOLVED');
    expect((await loadControlledTest(sql, testId))?.outcome).toBe('DELIVERY_FAILED');
  });

  it('AMBIGUOUS inscrit + relecture toujours non concluante → reste non conclusif', async () => {
    const testId = await attemptWithOutcome('cible_test', 'AMBIGUOUS');
    const resolution = await resolveControlledTestOutcome(sql, {
      testId,
      observed: 'AMBIGUOUS',
      detail: 'toujours illisible',
    });
    expect(resolution.kind).toBe('UNCHANGED');
    expect((await loadControlledTest(sql, testId))?.outcome).toBe('AMBIGUOUS');
  });

  it('la taxonomie nomme ce qui est définitif, et AMBIGUOUS n’en est pas', () => {
    expect(isDefinitiveOutcome('SENT')).toBe(true);
    expect(isDefinitiveOutcome('DELIVERY_FAILED')).toBe(true);
    expect(isDefinitiveOutcome('AMBIGUOUS')).toBe(false);
    expect(isDefinitiveOutcome(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Une tentative, un état canonique
// ---------------------------------------------------------------------------

describe('IG2.9 — la relecture est une observation, pas une seconde tentative', () => {
  it('un événement ADJUDICATION s’inscrit sans effet et sans consommer de tentative', async () => {
    const testId = await attemptWithOutcome('realg_972', 'SENT');
    const before = await loadControlledTest(sql, testId);

    await recordControlledTestEvent(sql, {
      testId,
      sessionId: null,
      workerId: 'w1',
      operator: 'Operator Example',
      mode: 'ADJUDICATION',
      status: 'AMBIGUOUS',
      reasonCode: 'IG_CT_AMBIGUOUS',
      idempotencyKey: before?.idempotencyKey ?? 'k',
      targetHandle: 'realg_972',
      observedHandle: null,
      observedUrl: null,
      sessionState: 'SESSION_READY',
      identityVerdict: null,
      identitySignals: [],
      relationship: UNREAD_RELATIONSHIP,
      gates: [],
      externalEffectAttempted: false,
      durationMs: 10,
      detail: 'observation',
    });

    const after = await loadControlledTest(sql, testId);
    expect(after?.externalAttemptsUsed).toBe(before?.externalAttemptsUsed);
    expect(after?.outcome).toBe('SENT');

    const events = await listControlledTestEvents(sql, 10);
    const observation = events.find((event) => event.mode === 'ADJUDICATION');
    expect(observation).toBeDefined();
    expect(observation?.externalEffectAttempted).toBe(false);
  });

  it('la base REFUSE une adjudication qui prétendrait avoir produit un effet', async () => {
    const testId = await attemptWithOutcome('realg_972', 'SENT');
    const test = await loadControlledTest(sql, testId);
    await expect(
      recordControlledTestEvent(sql, {
        testId,
        sessionId: null,
        workerId: 'w1',
        operator: 'Operator Example',
        mode: 'ADJUDICATION',
        status: 'SENT',
        reasonCode: 'IG_CT_SENT',
        idempotencyKey: test?.idempotencyKey ?? 'k',
        targetHandle: 'realg_972',
        observedHandle: null,
        observedUrl: null,
        sessionState: 'SESSION_READY',
        identityVerdict: null,
        identitySignals: [],
        relationship: UNREAD_RELATIONSHIP,
        gates: [],
        // Le mensonge que la contrainte doit intercepter.
        externalEffectAttempted: true,
        durationMs: 10,
        detail: 'adjudication qui déclare un effet',
      }),
    ).rejects.toThrow();
  });

  it('une relecture ne peut pas rouvrir une tentative consommée', async () => {
    const testId = await attemptWithOutcome('realg_972', 'SENT');
    await resolveControlledTestOutcome(sql, { testId, observed: 'AMBIGUOUS', detail: 'illisible' });
    // La seconde tentative reste impossible : l'effet est déjà marqué.
    await expect(markControlledTestEffect(sql, testId)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// La preuve d'Inbox
// ---------------------------------------------------------------------------

function inboxRow(overrides: Partial<MatchedInboxRow> = {}): MatchedInboxRow {
  return {
    index: 0,
    threadId: null,
    basis: 'handle_token',
    text: 'RealG_972 Vous: Test technique Hermes — aucun suivi nécessaire. · 1 min',
    ageMs: MINUTE,
    previewMatchesApproved: true,
    ...overrides,
  };
}

function witness(overrides: Partial<InboxWitness> = {}): InboxWitness {
  return {
    readability: 'INBOX_READABLE',
    presence: 'THREAD_PRESENT',
    rowsSeen: 9,
    avatarCount: 9,
    viewerLabel: 'hermesagency_',
    row: inboxRow(),
    detail: 'conversation trouvée',
    ...overrides,
  } as InboxWitness;
}

describe('IG2.9 — la boîte de réception comme preuve positive', () => {
  it('fil présent + remonté + aperçu du payload = preuve de remise', () => {
    expect(inboxConfirmsDelivery(witness(), 2 * MINUTE)).toBe(true);
  });

  it('une boîte ILLISIBLE ne prouve rien — ni dans un sens ni dans l’autre', () => {
    expect(inboxConfirmsDelivery(witness({ readability: 'INBOX_UNREADABLE' }), 2 * MINUTE)).toBe(false);
    expect(inboxConfirmsDelivery(null, 2 * MINUTE)).toBe(false);
  });

  it('un aperçu PÉRIMÉ n’est pas une preuve : le fil doit avoir été remonté', () => {
    // La signature exacte de l'échec de `operator_second_account` : ligne présente, mais
    // âge très supérieur à celui de la tentative.
    expect(inboxConfirmsDelivery(witness({ row: inboxRow({ ageMs: 3 * 24 * 60 * MINUTE }) }), 2 * MINUTE)).toBe(false);
  });

  it('un aperçu qui ne porte pas le texte approuvé n’est pas une preuve', () => {
    expect(inboxConfirmsDelivery(witness({ row: inboxRow({ previewMatchesApproved: false }) }), 2 * MINUTE)).toBe(false);
  });

  it('un fil absent ou inconnu n’est pas une preuve', () => {
    expect(inboxConfirmsDelivery(witness({ presence: 'THREAD_NOT_FOUND' }), 2 * MINUTE)).toBe(false);
    expect(inboxConfirmsDelivery(witness({ presence: 'THREAD_UNKNOWN' }), 2 * MINUTE)).toBe(false);
  });

  it('un âge illisible ou un effet d’âge inconnu ne prouvent rien', () => {
    expect(inboxConfirmsDelivery(witness({ row: inboxRow({ ageMs: null }) }), 2 * MINUTE)).toBe(false);
    expect(inboxConfirmsDelivery(witness(), null)).toBe(false);
    expect(inboxConfirmsDelivery(witness(), undefined)).toBe(false);
  });

  it('l’identité reste celle des règles existantes — jamais un nom d’affichage seul', () => {
    // Les trois bases possibles sont corroborées par construction dans
    // `inboxScan` ; aucune ne repose sur un nom d'affichage non recoupé.
    for (const basis of ['handle_token', 'image_alt_handle', 'corroborated_display_name'] as const) {
      expect(inboxConfirmsDelivery(witness({ row: inboxRow({ basis }) }), 2 * MINUTE)).toBe(true);
    }
  });

  it('le payload figé est bien celui que l’aperçu doit porter', () => {
    expect(inboxRow().text).toContain(CONTROLLED_TEST_PAYLOAD.slice(0, 20));
  });
});

// ---------------------------------------------------------------------------
// Les trois cas historiques, joués à travers l'adjudication réelle
// ---------------------------------------------------------------------------

/**
 * Ces trois scénarios ne sont pas des exemples : ce sont les trois tentatives
 * réellement produites par ce dépôt. Un changement d'adjudication qui les
 * relirait autrement réécrirait l'histoire du rail, et c'est exactement ce
 * qu'un correctif de confort finit par faire.
 */
function adjudicateWith(over: {
  nodes?: readonly ObservedNode[];
  inbox?: InboxWitness | null;
  effectAgeMs?: number | null;
}): ReturnType<typeof adjudicateDelivery> {
  return adjudicateDelivery({
    observation: {
      // Chaîne d'ancêtres VIDE : le fil n'a pas pu être rouvert. C'est
      // exactement l'état du 14 août sur `realg_972`.
      ancestorChain: [],
      nodes: over.nodes ?? [],
      handleLinks: [],
      composerText: '',
      truncated: false,
      inbox: over.inbox ?? null,
    },
    approvedText: CONTROLLED_TEST_PAYLOAD,
    expectedHandle: 'realg_972',
    composerCleared: null,
    bubblesBefore: null,
    anchorRect: null,
    // `??` serait un piège : il transformerait un `null` VOULU par le test en
    // valeur par défaut, et le test passerait sans rien éprouver.
    effectAgeMs: 'effectAgeMs' in over ? over.effectAgeMs : 2 * MINUTE,
  });
}

function failureMarkerNode(): ObservedNode {
  return {
    parentId: null,
    id: 99,
    level: 2,
    tag: 'div',
    role: 'button',
    ariaLabel: 'failed to send',
    title: null,
    text: 'failed to send',
    rect: { left: 1246, right: 1262, top: 776, bottom: 792 },
    visible: true,
    color: 'rgb(237, 73, 86)',
    fill: null,
  } as ObservedNode;
}

describe('IG2.9 — les trois cas réels du rail restent lus de la même façon', () => {
  it('realg_972 : fil non rouvrable + boîte positive → SENT', () => {
    const verdict = adjudicateWith({ inbox: witness() });
    expect(verdict.verdict).toBe('SENT');
    expect(verdict.proofs.some((proof) => proof.proof === 'inbox_delivery_witness')).toBe(true);
  });

  it('operator_second_account : fil non remonté et aperçu périmé → jamais SENT', () => {
    // La signature de l'échec du 14 août : la conversation existe, mais elle
    // n'a pas bougé et son aperçu ne porte pas le message tenté.
    const stale = witness({ row: inboxRow({ ageMs: 3 * 24 * 60 * MINUTE, previewMatchesApproved: false }) });
    expect(adjudicateWith({ inbox: stale }).verdict).not.toBe('SENT');
  });

  it('excluded_account_example : un mot d’échec visible fait taire le témoin d’inbox', () => {
    // Le cas réel avait un fil LISIBLE : bulle trouvée, marqueur accolé, donc
    // `DELIVERY_FAILED` par le chemin normal — inchangé par IG2.9 et couvert
    // par `instagramDeliveryProof.test.ts`.
    //
    // Ce test-ci couvre la combinaison que le nouveau chemin rend possible :
    // fil ILLISIBLE, mot d'échec visible, boîte pourtant positive. Le verdict
    // attendu n'est pas `DELIVERY_FAILED` — sans bulle à apparier, on ne peut
    // pas affirmer l'échec avec le standard du rail, et l'affirmer depuis un
    // simple mot serait exactement l'inférence non appariée qu'on refuse dans
    // l'autre sens. C'est `AMBIGUOUS` : on ne conclut rien, et surtout pas la
    // remise.
    const verdict = adjudicateWith({ nodes: [failureMarkerNode()], inbox: witness() });
    expect(verdict.verdict).toBe('AMBIGUOUS');
    expect(verdict.verdict).not.toBe('SENT');
    expect(hasUnboundExplicitFailureSignal([failureMarkerNode()])).toBe(true);
  });

  it('le vocabulaire d’échec est reconnu dans les deux langues, aria comme texte', () => {
    for (const label of ['Non envoyé', 'failed to send', 'Message non envoyé', 'unable to send', 'not delivered']) {
      expect(hasUnboundExplicitFailureSignal([{ ...failureMarkerNode(), ariaLabel: label, text: '' }])).toBe(true);
    }
    // Et un libellé ordinaire ne doit pas faire taire le témoin.
    expect(hasUnboundExplicitFailureSignal([{ ...failureMarkerNode(), ariaLabel: 'Envoyer', text: '' }])).toBe(false);
  });

  it('une boîte ILLISIBLE ne fabrique jamais un SENT', () => {
    expect(adjudicateWith({ inbox: witness({ readability: 'INBOX_UNREADABLE' }) }).verdict).not.toBe('SENT');
    expect(adjudicateWith({ inbox: null }).verdict).not.toBe('SENT');
  });

  it('sans âge d’effet, la fraîcheur ne se devine pas — donc pas de SENT', () => {
    expect(adjudicateWith({ inbox: witness(), effectAgeMs: null }).verdict).not.toBe('SENT');
  });
});
