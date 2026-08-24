import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUTONOMOUS_COMMERCIAL_LIMITS,
  AUTONOMOUS_COMMERCIAL_SCOPE,
  COMMERCIAL_POLICY_VERSION,
  DEMAND_ESCALATION,
  firstCommercialDemand,
  forbiddenCommercialClaims,
  GAP_ESCALATION,
  readCommercialDemands,
  renderCommercialPolicyBlock,
  signalCommercialDemand,
  type CommercialDemand,
} from '@/lib/conversation/commercialPolicy';
import { CONVERSATION_POLICY_VERSION } from '@/lib/conversation/autonomy';
import {
  ambiguousAfterEffect,
  judgeReplyOutcome,
  type ReplyEffectStatus,
} from '@/lib/conversation/replyEffect';
import { readSignals } from '@/lib/conversation/signals';
import type { ConversationThread, ConversationTurn } from '@/lib/conversation/thread';
import {
  MIN_HISTORY_TEXT_NODES,
  readThreadHistory,
} from '@/lib/instagram/replyHistory';
import {
  FORBIDDEN_REPLY_METHODS,
  hasReplyPrimitive,
  isTemporaryReplyAbort,
  isThreadId,
  REPLY_SEND_PRIMITIVE,
  threadUrlOf,
  type InstagramReplyAbortCode,
  type InstagramReplyObservation,
  type InstagramReplyResult,
} from '@/lib/instagram/replyRail';
import { isAllowedLiveNavigation, isAllowedReplyNavigation } from '@/lib/instagram/readOnlyGuard';
import { PlaywrightInstagramReplyRail } from '@/lib/instagram/playwrightReplyRail';
import { loadInstagramRail } from '@/lib/config/load';
import type { ThreadHarvest } from '@/lib/instagram/threadHarvest';
import type { ObservedNode } from '@/lib/instagram/threadObservation';

/**
 * HERMES-REPLY-DELIVERY-R1 §1/§2/§3/§8/§9/§16 — les portes de la remise de
 * réponse, exercées SANS base et SANS navigateur.
 *
 * Tout ce fichier est pur. C'est délibéré : la politique commerciale, la
 * preuve d'historique, le jugement d'issue et la liste blanche de navigation
 * sont exactement ce qui doit pouvoir être pris en défaut sans qu'Instagram ni
 * un prospect soient au bout. Ce qui demande une base vit dans
 * `replyExecution.test.ts` ; ce qui demande deux connexions concurrentes vit
 * dans `replyExecutionPostgres.test.ts`.
 *
 * Aucun test n'envoie quoi que ce soit : aucun rail n'est OUVERT ici — une
 * instance est construite pour interroger sa FORME, ce qui ne lance aucun
 * navigateur (`open()` n'est appelé que par `sendThreadReply`).
 */

const ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// §1 — la politique commerciale
// ---------------------------------------------------------------------------

describe('§1 — politique commerciale R1', () => {
  it('est versionnée, et sa version est DISTINCTE de celle de la conversation', () => {
    expect(COMMERCIAL_POLICY_VERSION).toBe('hermes-commercial-r7');
    // Deux questions, deux versions. Les confondre ferait couvrir « que peut-on
    // engager ? » par les décisions rendues sur « peut-on répondre seul ? ».
    expect(COMMERCIAL_POLICY_VERSION).not.toBe(CONVERSATION_POLICY_VERSION);
  });

  it('n’écrit AUCUNE grille tarifaire — ni montant, ni pourcentage, ni durée', () => {
    // La garde la plus importante de ce module : il existe pour dire ce qui ne
    // se dit pas, jamais pour inventer ce que personne n'a décidé. Un chiffre
    // qui apparaîtrait ici deviendrait une politique par le seul fait d'être
    // écrit.
    const source = readFileSync(resolve(ROOT, 'src/lib/conversation/commercialPolicy.ts'), 'utf8');
    // Les motifs de détection contiennent forcément des classes de chiffres
    // (`\\d{1,3}\\s*%`) : on cherche donc un MONTANT énoncé, pas un caractère.
    expect(source).not.toMatch(/\b\d+\s*(€|euros?|EUR)\b/i);
    expect(source).not.toMatch(/à partir de \d/i);
    expect(source).not.toMatch(/\b\d+\s*(mois|semaines?)\s+d['’]engagement/i);
  });

  describe('ce qui ESCALADE', () => {
    const cases: ReadonlyArray<readonly [string, string, CommercialDemand]> = [
      ['prix exact', 'Vous facturez combien pour ce genre de prestation ?', 'EXACT_PRICE'],
      ['tarif', 'C’est quoi vos tarifs ?', 'EXACT_PRICE'],
      ['fourchette', 'Vous pouvez me donner un ordre de grandeur ?', 'EXACT_PRICE'],
      ['pourcentage', 'Vous prenez combien de % sur les ventes ?', 'PERCENTAGE_OR_FEE'],
      ['commission', 'Il y a une commission là-dessus ?', 'PERCENTAGE_OR_FEE'],
      ['frais', 'Quels frais sont à prévoir de mon côté ?', 'PERCENTAGE_OR_FEE'],
      ['engagement contractuel', 'Il y a un engagement à signer ?', 'CONTRACT_COMMITMENT'],
      ['durée / résiliation', 'C’est quoi le préavis si je veux arrêter ?', 'CONTRACT_COMMITMENT'],
      ['garantie', 'Vous garantissez des résultats ?', 'GUARANTEE'],
      ['remboursement', 'Et si ça marche pas, je suis remboursé ?', 'GUARANTEE'],
      ['volume promis', 'Vous me ramenez combien de clients par mois ?', 'GUARANTEED_OUTCOME'],
      ['ROI', 'C’est quoi le ROI que je peux espérer ?', 'GUARANTEED_OUTCOME'],
      ['modèle à la performance', 'Vous travaillez à la performance ?', 'PERFORMANCE_MODEL'],
      ['preuve chiffrée', 'Vous avez des résultats concrets à montrer ?', 'PROOF_REQUEST'],
      ['références', 'Vous avez des références dans mon secteur ?', 'PROOF_REQUEST'],
    ];

    for (const [label, message, expected] of cases) {
      it(`${label} → escalade`, () => {
        const finding = firstCommercialDemand(message);
        expect(finding, `« ${message} » n’a rien déclenché`).not.toBeNull();
        expect(readCommercialDemands(message).map((f) => f.demand)).toContain(expected);
        expect(finding!.reason).toBe(DEMAND_ESCALATION[finding!.demand]);
      });
    }
  });

  it('une qualification GÉNÉRALE ne déclenche rien', () => {
    // Le pendant nécessaire : une politique qui escalade tout ne laisse aucune
    // autonomie utile, et ce round n'en serait pas un.
    for (const message of [
      'Oui je fais déjà de la pub mais ça marche moyen',
      'On est trois, surtout du bouche-à-oreille',
      'Comment ça marche concrètement ?',
      'Ah oui je vois, ça peut m’intéresser',
    ]) {
      expect(readCommercialDemands(message), message).toHaveLength(0);
    }
  });

  it('§1 — le trou que la lecture par SIGNAUX laissait : une demande d’appel écrase le prix', () => {
    // La raison d'être de la lecture lexicale. `readSignals` ne retient qu'UN
    // sujet, et `explicitCallRequest` écrase le précédent — donc ce message
    // sort de la lecture de signaux en `CALL_REQUEST`, sans manque de grounding
    // ouvert, et passait la porte comme un tour ordinaire.
    const body = 'Vous prenez combien de % ? On peut s’appeler ?';
    const signals = readSignals(body, 'QUESTION', emptyThread());
    expect(signals.questionTopic).toBe('CALL_REQUEST');
    expect(signalCommercialDemand(signals)).toBeNull();

    // La lecture lexicale, elle, la voit.
    const finding = firstCommercialDemand(body);
    expect(finding).not.toBeNull();
    expect(finding!.demand).toBe('PERCENTAGE_OR_FEE');
    expect(finding!.reason).toBe('pricing_policy_missing');
  });

  it('les deux lectures sont CUMULATIVES : un message peut porter plusieurs demandes', () => {
    const findings = readCommercialDemands('C’est combien, et vous garantissez des résultats ?');
    expect(findings.map((f) => f.demand)).toEqual(
      expect.arrayContaining(['EXACT_PRICE', 'GUARANTEE']),
    );
    // Une demande n'est jamais comptée deux fois, même formulée deux fois.
    const doubled = readCommercialDemands('C’est combien ? Quels sont vos tarifs ?');
    expect(doubled.filter((f) => f.demand === 'EXACT_PRICE')).toHaveLength(1);
  });

  it('§1 — les cinq formulations que la mission met sur la table sont TOUTES refusées', () => {
    // Vérifiées phrase par phrase plutôt que sur parole : le lexique est celui
    // de `learning/offer.ts`, et ce test est ce qui garantit qu'il couvre
    // encore ces cinq-là après un futur remaniement.
    for (const phrase of [
      'vous ne payez que si vous gagnez',
      'c’est gratuit jusqu’aux résultats',
      'il n’y a aucun risque pour vous',
      'des résultats garantis dès le premier mois',
      'on vous amène 10 clients garantis',
    ]) {
      expect(forbiddenCommercialClaims(phrase), phrase).not.toHaveLength(0);
    }
  });

  it('un texte honnête ne déclenche aucune promesse interdite', () => {
    expect(
      forbiddenCommercialClaims(
        'Ça dépend beaucoup de votre situation — on peut en parler et voir si c’est pertinent.',
      ),
    ).toHaveLength(0);
  });

  it('n’a QU’UN lexique de promesses : celui du dépôt, nommé et non recopié', () => {
    const source = readFileSync(resolve(ROOT, 'src/lib/conversation/commercialPolicy.ts'), 'utf8');
    expect(source).toContain("from '@/lib/learning/offer'");
    // Aucun second détecteur de promesses : deux lexiques finiraient par
    // répondre non d'un côté et oui de l'autre, et c'est le plus indulgent qui
    // gagnerait.
    expect(source).not.toContain('PERFORMANCE_CLAIM_PATTERNS');
  });

  it('la table des manques de grounding a survécu au déménagement, à l’identique', () => {
    // Le déplacement depuis `autonomy.ts` ne devait changer AUCUN verdict.
    expect(GAP_ESCALATION.PRICING_POLICY_MISSING).toBe('pricing_policy_missing');
    expect(GAP_ESCALATION.NO_GUARANTEE_TO_OFFER).toBe('guarantee_requested');
    expect(GAP_ESCALATION.PROOF_NOT_QUOTABLE_IN_REPLY).toBe('proof_requested');
    expect(GAP_ESCALATION.TOPIC_NOT_COVERED_BY_DATA).toBe('topic_not_covered');
    // `NO_RESEARCH_OBSERVED` n'escalade PAS : c'est un manque de données, pas
    // une condition commerciale, et le prompt s'en charge.
    expect(GAP_ESCALATION.NO_RESEARCH_OBSERVED).toBeUndefined();
  });

  it('le bloc de prompt vient de la MÊME source que les portes', () => {
    const block = renderCommercialPolicyBlock();
    expect(block).toContain(COMMERCIAL_POLICY_VERSION);
    for (const entry of AUTONOMOUS_COMMERCIAL_SCOPE) expect(block).toContain(entry);
    for (const entry of AUTONOMOUS_COMMERCIAL_LIMITS) expect(block).toContain(entry);
  });
});

// ---------------------------------------------------------------------------
// §2/§3 — le contrat de la primitive
// ---------------------------------------------------------------------------

describe('§2 — la primitive de réponse, et ce qu’elle refuse de savoir faire', () => {
  it('un fil se désigne par ses CHIFFRES, jamais par un nom ni par une URL reçue', () => {
    expect(isThreadId('107403793987175')).toBe(true);
    expect(isThreadId('')).toBe(false);
    expect(isThreadId('demo_account_17')).toBe(false);
    expect(isThreadId('123abc')).toBe(false);
    expect(isThreadId('https://www.instagram.com/direct/t/123/')).toBe(false);
    expect(() => threadUrlOf('demo_account_17')).toThrow(/invalide/);
    expect(threadUrlOf('107403793987175')).toBe('https://www.instagram.com/direct/t/107403793987175/');
  });

  it('le rail de réponse ne porte AUCUNE méthode capable de démarcher', () => {
    // Interrogé sur l'objet réel, pas seulement sur son type : un rail qui
    // hériterait un jour de `sendFirstTouchDm` saurait produire un premier
    // contact, et la séparation construite ici disparaîtrait sans qu'aucune
    // ligne ne l'annonce. Construire l'instance n'ouvre aucun navigateur.
    const rail = new PlaywrightInstagramReplyRail({
      config: loadInstagramRail(),
      workerId: 'test-forme',
    });
    for (const forbidden of FORBIDDEN_REPLY_METHODS) {
      expect(
        (rail as unknown as Record<string, unknown>)[forbidden],
        `le rail de réponse expose ${forbidden}`,
      ).toBeUndefined();
    }
    expect(hasReplyPrimitive(rail)).toBe(true);
    expect(typeof (rail as unknown as Record<string, unknown>)[REPLY_SEND_PRIMITIVE]).toBe('function');
  });

  it('un objet sans la primitive n’est pas pris pour un rail de réponse', () => {
    expect(hasReplyPrimitive({ close: async (): Promise<void> => undefined })).toBe(false);
  });

  it('§3 — le rail de réponse ne sait PAS atteindre « nouveau message »', () => {
    const thread = 'https://www.instagram.com/direct/t/107403793987175/';
    expect(isAllowedReplyNavigation(thread)).toBe(true);
    // La racine et une page de profil restent accessibles : elles servent aux
    // deux lectures d'identité, et aucune n'est un effet.
    expect(isAllowedReplyNavigation('https://www.instagram.com/')).toBe(true);
    expect(isAllowedReplyNavigation('https://www.instagram.com/demo_account_17/')).toBe(true);

    // La différence avec le canari, et le cœur de ce round : `/direct/new/` est
    // ce qu'il faut pour OUVRIR une conversation. Le rail de réponse ne l'a pas.
    expect(isAllowedLiveNavigation('https://www.instagram.com/direct/new/')).toBe(true);
    expect(isAllowedReplyNavigation('https://www.instagram.com/direct/new/')).toBe(false);

    // Ni la boîte de réception, ni une URL décorée, ni un autre hôte.
    expect(isAllowedReplyNavigation('https://www.instagram.com/direct/inbox/')).toBe(false);
    expect(isAllowedReplyNavigation('https://www.instagram.com/direct/t/123/?x=1')).toBe(false);
    expect(isAllowedReplyNavigation('https://www.instagram.com/direct/t/123/#a')).toBe(false);
    expect(isAllowedReplyNavigation('https://instagram.com/direct/t/123/')).toBe(false);
    expect(isAllowedReplyNavigation('http://www.instagram.com/direct/t/123/')).toBe(false);
    expect(isAllowedReplyNavigation('pas une url')).toBe(false);
  });

  it('la primitive n’a qu’UN site de clic, et c’est l’envoi', () => {
    const source = readFileSync(resolve(ROOT, 'src/lib/instagram/playwrightReplyRail.ts'), 'utf8');
    // Compté dans le CODE et non dans la prose : l'en-tête du fichier nomme
    // `.click(` pour dire qu'il n'y en a qu'un, et un test qui interdirait de
    // l'écrire interdirait de l'expliquer.
    const code = stripComments(source);
    expect(code.match(/\.click\(/g) ?? []).toHaveLength(1);
    expect(source).toMatch(/private async clickOnce\(/);
    expect(source).toMatch(/this\.clicks \+= 1/);
    // Le canari en a deux gestes parce qu'il doit CRÉER la conversation. Ici le
    // fil existe : il n'y a rien à ouvrir, donc rien d'autre à cliquer.
    expect(code).toContain("'send_reply'");
    expect(code).not.toContain("'open_composer'");
    for (const forbidden of ['.press(', '.tap(', '.dblclick(', '.setInputFiles(', '.selectOption(']) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it('le crochet d’effet précède le clic dans le CODE, pas seulement dans l’intention', () => {
    const source = readFileSync(resolve(ROOT, 'src/lib/instagram/playwrightReplyRail.ts'), 'utf8');
    const hook = source.indexOf('await input.onBeforeExternalEffect()');
    const click = source.indexOf('this.clickOnce(sendControl');
    expect(hook).toBeGreaterThan(0);
    expect(click).toBeGreaterThan(hook);

    // Et les deux arrêts sans effet sortent AVANT le crochet : un aperçu ou un
    // brouillon ne peuvent donc pas réserver, ni marquer une tentative.
    expect(source.indexOf("input.stopAfter === 'thread'")).toBeLessThan(hook);
    expect(source.indexOf("input.stopAfter === 'draft'")).toBeLessThan(hook);
  });

  it('la garde d’HISTORIQUE précède toute saisie', () => {
    const source = readFileSync(resolve(ROOT, 'src/lib/instagram/playwrightReplyRail.ts'), 'utf8');
    // HERMES-REAL-THREAD-PREVIEW-R1 — la récolte a été déplacée dans la classe
    // de base (`stageHistory`), partagée avec l'inspection read-only. Ce qui
    // est vérifié ici n'a pas changé : la question « ce fil a-t-il un passé ? »
    // est POSÉE avant que quoi que ce soit ne soit saisi.
    const history = source.indexOf('this.stageHistory(composer)');
    const typing = source.indexOf('composer.pressSequentially(');
    expect(history).toBeGreaterThan(0);
    expect(typing).toBeGreaterThan(history);
  });

  it('les deux rails partagent tout ce qui DÉCIDE, et rien n’en est recopié', () => {
    // §13 — « le système ne doit pas avoir deux rails de sécurité divergents ».
    // La colle Playwright est propre à chaque rail ; le code qui tranche est le
    // même module, importé des deux côtés.
    //
    // Depuis HERMES-REAL-THREAD-PREVIEW-R1, le rail de réponse atteint une
    // partie de ces modules par sa CLASSE DE BASE — le rail d'inspection
    // read-only, dont il hérite littéralement le ciblage. Les deux fichiers
    // sont donc lus ensemble : ce qu'on interdit est la RECOPIE, pas
    // l'héritage, et l'héritage est justement ce qui garantit qu'il n'y a
    // qu'un exemplaire du code qui tranche.
    const replyOwn = readFileSync(resolve(ROOT, 'src/lib/instagram/playwrightReplyRail.ts'), 'utf8');
    const inspection = readFileSync(
      resolve(ROOT, 'src/lib/instagram/playwrightThreadInspectionRail.ts'),
      'utf8',
    );
    const reply = `${replyOwn}\n${inspection}`;
    const live = readFileSync(resolve(ROOT, 'src/lib/instagram/playwrightLiveRail.ts'), 'utf8');
    for (const shared of [
      '@/lib/instagram/domSelectors',
      '@/lib/instagram/deliveryProof',
      '@/lib/instagram/threadIdentity',
      '@/lib/instagram/threadHarvest',
      '@/lib/instagram/readOnlyGuard',
    ]) {
      expect(reply, `le rail de réponse n’importe pas ${shared}`).toContain(shared);
      expect(live, `le rail canari n’importe pas ${shared}`).toContain(shared);
    }

    // Et l'héritage est bien celui-là, dans ce sens-là.
    expect(replyOwn).toMatch(/extends\s+PlaywrightInstagramThreadInspectionRail/);
    // Dans le CODE, pas dans la prose : l'en-tête du rail d'inspection EXPLIQUE
    // le sens de l'héritage, et un test qui interdirait de l'écrire
    // interdirait de l'expliquer.
    expect(stripComments(inspection)).not.toContain('PlaywrightInstagramReplyRail');
  });

  it('le rail de réponse ne contient aucune technique d’évitement, ni aucune génération', () => {
    const source = stripComments(readFileSync(resolve(ROOT, 'src/lib/instagram/playwrightReplyRail.ts'), 'utf8'));
    for (const forbidden of [
      'Math.random',
      'proxy:',
      'userAgent',
      'setExtraHTTPHeaders',
      'webdriver',
      'stealth',
      'addInitScript',
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
    expect(source).not.toMatch(/ModelRouter|callModel|generateText/i);
  });

  it('un refus TEMPORAIRE se distingue d’un refus définitif', () => {
    const temporary: readonly InstagramReplyAbortCode[] = [
      'IG_REPLY_SESSION_LOST',
      'IG_REPLY_THREAD_NOT_REACHED',
      'IG_REPLY_COMPOSER_NOT_FOUND',
      'IG_REPLY_CONTROL_NOT_FOUND',
    ];
    for (const code of temporary) expect(isTemporaryReplyAbort(code), code).toBe(true);

    // Ceux-là ne cessent pas d'être vrais en réessayant.
    const definitive: readonly InstagramReplyAbortCode[] = [
      'IG_REPLY_ACCOUNT_MISMATCH',
      'IG_REPLY_THREAD_IDENTITY_UNCONFIRMED',
      'IG_REPLY_EMPTY_THREAD',
      'IG_REPLY_PAYLOAD_NOT_ENTERED',
    ];
    for (const code of definitive) expect(isTemporaryReplyAbort(code), code).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §2 — la preuve d'HISTORIQUE
// ---------------------------------------------------------------------------

describe('§2 — un fil sans passé n’est pas une conversation', () => {
  it('une récolte ILLISIBLE ne conclut rien, dans aucun sens', () => {
    const history = readThreadHistory(harvest({ readable: false, nodes: [] }));
    expect(history.verdict).toBe('UNREADABLE');
    expect(history.textNodes).toBe(0);
    expect(history.detail).toContain('n’a pas pu s’exécuter');
  });

  it('un fil vide est reconnu comme vide, et refuse la réponse', () => {
    const history = readThreadHistory(harvest({ readable: true, nodes: [] }));
    expect(history.verdict).toBe('EMPTY');
    expect(history.detail).toContain('premier contact');
  });

  it('le texte du COMPOSEUR ne compte jamais comme un passé', () => {
    // La moitié de la garde : sans le filtre sur `level`, le texte qu'on vient
    // de saisir ferait à lui seul passer un fil vide pour un fil peuplé.
    const inComposer = [node(-1, 'Bonjour, comment vos clients vous trouvent ?'), node(-1, 'un autre bout')];
    expect(readThreadHistory(harvest({ readable: true, nodes: inComposer })).verdict).toBe('EMPTY');
  });

  it('un fil qui a servi est reconnu', () => {
    const nodes = [node(0, 'Bonjour, une question rapide'), node(0, 'oui'), node(1, '13:35')];
    const history = readThreadHistory(harvest({ readable: true, nodes }));
    expect(history.verdict).toBe('HAS_HISTORY');
    expect(history.textNodes).toBe(3);
  });

  it('le seuil est celui qui est écrit, et un fil INVISIBLE ne compte pas', () => {
    const justUnder = Array.from({ length: MIN_HISTORY_TEXT_NODES - 1 }, () => node(0, 'salut'));
    expect(readThreadHistory(harvest({ readable: true, nodes: justUnder })).verdict).toBe('EMPTY');

    const hidden = [node(0, 'salut', false), node(0, 'ok', false), node(0, 'oui', false)];
    expect(readThreadHistory(harvest({ readable: true, nodes: hidden })).verdict).toBe('EMPTY');
  });
});

// ---------------------------------------------------------------------------
// §8/§9 — l'issue, et le refus d'inventer un niveau de certitude
// ---------------------------------------------------------------------------

describe('§9 — effet tenté, effet observé, remise confirmée', () => {
  it('un refus avant tout geste ne déclare AUCUN effet', () => {
    const judgement = judgeReplyOutcome({
      kind: 'NOT_ATTEMPTED',
      code: 'IG_REPLY_EMPTY_THREAD',
      detail: 'fil sans passé',
      sessionState: 'SESSION_READY',
      screenshotPath: null,
    });
    expect(judgement.status).toBe('BLOCKED');
    expect(judgement.effectAttempted).toBe(false);
    expect(judgement.deliveryConfirmed).toBe(false);
    expect(judgement.retryable).toBe(false);
  });

  it('une PANNE avant tout geste est retentable ; un refus, non', () => {
    const panne = judgeReplyOutcome({
      kind: 'NOT_ATTEMPTED',
      code: 'IG_REPLY_SESSION_LOST',
      detail: 'session tombée',
      sessionState: 'SESSION_EXPIRED',
      screenshotPath: null,
    });
    expect(panne.status).toBe('FAILED');
    expect(panne.retryable).toBe(true);
    expect(panne.effectAttempted).toBe(false);
  });

  it('un aperçu et un brouillon ne déclarent aucun effet', () => {
    const previewed = judgeReplyOutcome({
      kind: 'PREVIEWED',
      detail: 'fil atteint',
      sessionState: 'SESSION_READY',
      threadUrl: 'https://www.instagram.com/direct/t/1/',
      threadHandle: 'demo_account_17',
      priorBubbles: 6,
      composerReady: true,
      screenshotPath: null,
    });
    expect(previewed.status).toBe('PREVIEWED');
    expect(previewed.effectAttempted).toBe(false);

    const drafted = judgeReplyOutcome({
      kind: 'DRAFT_READY',
      detail: 'brouillon constaté',
      sessionState: 'SESSION_READY',
      threadUrl: 'https://www.instagram.com/direct/t/1/',
      threadHandle: 'demo_account_17',
      priorBubbles: 6,
      composerText: 'texte',
      payloadExact: true,
      sendControl: {
        outcome: 'SEND_CONTROL_MATCH' as const,
        chosen: null,
        seen: 1,
        inScope: 1,
        detail: 'double de test — unique et actif dans le panneau confirmé',
      },
      sendControlPresent: true,
      sendControlEnabled: true,
      composerDescriptor: 'div[contenteditable=true] focus=true',
      composerCleared: true,
      screenshotPath: null,
    });
    expect(drafted.status).toBe('DRAFT_READY');
    expect(drafted.effectAttempted).toBe(false);
  });

  it('une remise CONFIRMÉE demande les trois niveaux, pas seulement le clic', () => {
    const sent = judgeReplyOutcome(attempted({ deliveryVerdict: 'SENT', harvestReadableAfter: true }));
    expect(sent.status).toBe('SENT');
    expect(sent.effectAttempted).toBe(true);
    expect(sent.effectObserved).toBe(true);
    expect(sent.deliveryConfirmed).toBe(true);
    expect(sent.retryable).toBe(false);
  });

  it('un échec AFFICHÉ par Instagram n’autorise pas un rejeu : le clic a eu lieu', () => {
    const failed = judgeReplyOutcome(attempted({ deliveryVerdict: 'DELIVERY_FAILED', harvestReadableAfter: true }));
    expect(failed.status).toBe('DELIVERY_FAILED');
    expect(failed.effectAttempted).toBe(true);
    expect(failed.deliveryConfirmed).toBe(false);
    expect(failed.retryable).toBe(false);
  });

  it('§8 — un verdict AMBIGU reste ambigu, et n’est JAMAIS rejoué', () => {
    const ambiguous = judgeReplyOutcome(
      // Le composeur s'est vidé, la bulle semble là : exactement le cas où l'on
      // serait tenté de conclure. `deliveryProof` a dit AMBIGUOUS, et ce module
      // ne repasse pas derrière lui.
      attempted({ deliveryVerdict: 'AMBIGUOUS', harvestReadableAfter: true, composerCleared: true }),
    );
    expect(ambiguous.status).toBe('AMBIGUOUS');
    expect(ambiguous.reasonCode).toBe('REPLY_AMBIGUOUS_POST_EFFECT');
    expect(ambiguous.effectAttempted).toBe(true);
    expect(ambiguous.deliveryConfirmed).toBe(false);
    expect(ambiguous.retryable).toBe(false);
  });

  it('§8 — un crash APRÈS la réservation devient AMBIGU, jamais « rien n’a été fait »', () => {
    const judgement = ambiguousAfterEffect(new Error('Target page, context or browser has been closed'));
    expect(judgement.status).toBe('AMBIGUOUS');
    expect(judgement.reasonCode).toBe('REPLY_AMBIGUOUS_POST_EFFECT');
    expect(judgement.effectAttempted).toBe(true);
    expect(judgement.effectObserved).toBe(false);
    expect(judgement.deliveryConfirmed).toBe(false);
    expect(judgement.retryable).toBe(false);
    expect(judgement.detail).toContain('APRÈS la réservation');
  });

  it('§8 — AUCUNE issue portant une tentative n’est retentable', () => {
    // La propriété écrite en une assertion plutôt qu'en prose : quelle que soit
    // la branche, `effectAttempted` implique `!retryable`.
    const all = [
      judgeReplyOutcome(attempted({ deliveryVerdict: 'SENT', harvestReadableAfter: true })),
      judgeReplyOutcome(attempted({ deliveryVerdict: 'DELIVERY_FAILED', harvestReadableAfter: true })),
      judgeReplyOutcome(attempted({ deliveryVerdict: 'AMBIGUOUS', harvestReadableAfter: false })),
      ambiguousAfterEffect(new Error('boum')),
    ];
    for (const judgement of all) {
      if (judgement.effectAttempted) expect(judgement.retryable, judgement.status).toBe(false);
    }
  });

  it('une observation ILLISIBLE ne peut pas produire une remise confirmée', () => {
    const judgement = judgeReplyOutcome(
      attempted({ deliveryVerdict: 'AMBIGUOUS', harvestReadableAfter: false }),
    );
    expect(judgement.effectObserved).toBe(false);
    expect(judgement.deliveryConfirmed).toBe(false);
    const statuses: readonly ReplyEffectStatus[] = ['SENT'];
    expect(statuses).not.toContain(judgement.status);
  });
});

// ---------------------------------------------------------------------------
// Helpers — aucune donnée réelle
// ---------------------------------------------------------------------------

/** Le CODE d'un fichier, sans sa prose. Les deux ne se comptent pas ensemble. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function emptyThread(): ConversationThread {
  const turns: readonly ConversationTurn[] = [];
  return Object.freeze({
    prospectId: 'p1',
    turns,
    inboundTurns: turns,
    outboundTurns: turns,
    exposedOutboundTurns: turns,
    currentInboundId: 'i1',
    priorInboundCount: 0,
    channel: 'instagram_dm' as const,
    truncated: false,
  });
}

function node(level: number, text: string, visible = true): ObservedNode {
  return Object.freeze({
    id: Math.abs(level) * 1000 + text.length,
    parentId: null,
    level,
    tag: 'div',
    role: null,
    ariaLabel: null,
    title: null,
    text,
    rect: { left: 0, right: 100, top: 0, bottom: 20 },
    visible,
    color: null,
    fill: null,
  });
}

function harvest(overrides: Partial<ThreadHarvest>): ThreadHarvest {
  return Object.freeze({
    ancestorChain: [],
    nodes: [],
    handleLinks: [],
    composerRect: null,
    composerText: '',
    truncated: false,
    readable: true,
    ...overrides,
  });
}

function attempted(overrides: Partial<InstagramReplyObservation>): InstagramReplyResult {
  return Object.freeze({
    kind: 'ATTEMPTED' as const,
    observation: Object.freeze({
      threadUrl: 'https://www.instagram.com/direct/t/107403793987175/',
      observedThreadId: '107403793987175',
      threadHandle: 'demo_account_17',
      priorBubbles: 6,
      matchingBubblesBefore: 0,
      matchingBubblesAfter: 1,
      harvestReadableBefore: true,
      harvestReadableAfter: true,
      composerCleared: true,
      outgoingBubbleConfirmed: true,
      deliveryFailureMarkers: [],
      deliveryVerdict: 'SENT' as const,
      scopeDetail: 'niveau 3 retenu',
      sessionState: 'SESSION_READY' as const,
      screenshotPath: null,
      durationMs: 4_200,
      detail: 'clic unique effectué',
      ...overrides,
    }),
  });
}
