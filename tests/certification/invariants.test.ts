/**
 * HERMES-END-TO-END-CERTIFICATION-R1 — les INVARIANTS, c'est-à-dire ce qui doit
 * rester vrai après le prochain changement.
 *
 * Chaque bloc correspond à une CLASSE de défaut réellement rencontrée sur ce
 * dépôt, jamais à une hypothèse : un lexique recopié qui diverge, un jeton
 * fabricable, deux tables qui doivent s'accorder, un motif qui matche au milieu
 * d'un mot, un fichier que `grep` saute en silence.
 *
 * Ils lisent des SOURCES quand la propriété porte sur le code lui-même. C'est
 * la seule façon de vérifier « personne n'a écrit ceci ailleurs » ; le dépôt le
 * fait déjà pour l'absence de coquille dans les modules de classification.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSignals, type QuestionTopic } from '@/lib/conversation/signals';
import { detectPerformanceClaims } from '@/lib/learning/offer';
import { readCommercialDemands } from '@/lib/conversation/commercialPolicy';
import { AUTO_REPLYABLE_CATEGORIES } from '@/lib/conversation/autonomy';
import { CATEGORY_POLICY, type ReplyCategory } from '@/lib/replies/taxonomy';
import { conversationPromptVersionFor, CURRENT_DRAFT_PROMPT_VERSIONS } from '@/lib/conversation/promptVersion';
import type { ConversationThread } from '@/lib/conversation/thread';

const SRC = resolve(__dirname, '..', '..', 'src');

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(path);
  }
  return out;
}

const ALL_SOURCES = sourceFiles(SRC);

const THREAD = { priorInboundCount: 1 } as unknown as ConversationThread;

// ---------------------------------------------------------------------------
// A — deux lexiques, une seule question
// ---------------------------------------------------------------------------

describe('A · les lexiques qui posent la même question doivent s’accorder', () => {
  /**
   * `signals.ts` retient UN sujet, `commercialPolicy.ts` relève TOUTES les
   * demandes. Les deux se trompent différemment, et le dépôt s'en sert
   * exprès — mais sur les trois sujets qui ENGAGENT quelque chose, un sujet
   * sans demande correspondante est une divergence, pas une nuance : c'est le
   * cas où le prompt reçoit une vérité que la politique n'a pas vue passer.
   */
  const CASES: ReadonlyArray<readonly [string, QuestionTopic, string]> = Object.freeze([
    ["c'est combien ?", 'PRICE', 'EXACT_PRICE'],
    ['quel est votre tarif ?', 'PRICE', 'EXACT_PRICE'],
    ['Quel budget faut-il pour commencer ?', 'AD_BUDGET', 'AD_SPEND_AMOUNT'],
    ['quel budget pub minimum ?', 'AD_BUDGET', 'AD_SPEND_AMOUNT'],
    ['Tu me garantis que les leads seront qualifiés ?', 'GUARANTEE', 'GUARANTEE'],
    ['Tu garantis quel ROI ?', 'GUARANTEE', 'GUARANTEE'],
    ['vous garantissez quoi ?', 'GUARANTEE', 'GUARANTEE'],
    ['tu es remboursé si ça marche pas ?', 'GUARANTEE', 'GUARANTEE'],
  ]);

  it.each(CASES)('« %s » → %s implique la demande %s', (text, topic, demand) => {
    expect(readSignals(text, 'QUESTION', THREAD).questionTopic).toBe(topic);
    expect(readCommercialDemands(text).map((finding) => finding.demand)).toContain(demand);
  });
});

// ---------------------------------------------------------------------------
// B — un motif ne commence pas au milieu d'un mot
// ---------------------------------------------------------------------------

describe('B · un mot du métier ne déclenche pas le lexique qu’il CONTIENT', () => {
  /**
   * « leads » contient « ads ». `AD_BUDGET` et `AD_SPEND_AMOUNT` portaient
   * `ads?` derrière un saut de mots non borné : la question du taux de
   * transformation ouvrait donc le BUDGET PUBLICITAIRE, seul sujet du dépôt qui
   * libère des montants citables.
   */
  const TRAPS: readonly string[] = Object.freeze([
    'En général combien de leads deviennent clients ?',
    'combien de leads par mois ?',
    'tu me ramènes combien de leads ?',
    'je reçois combien de leads qualifiés ?',
  ]);

  it.each(TRAPS)('« %s » ne parle pas du budget publicitaire', (text) => {
    expect(readSignals(text, 'QUESTION', THREAD).questionTopic).not.toBe('AD_BUDGET');
    expect(readCommercialDemands(text).map((finding) => finding.demand)).not.toContain(
      'AD_SPEND_AMOUNT',
    );
  });

  it('les vraies questions de budget, elles, restent reconnues', () => {
    for (const text of [
      'quel budget pour commencer ?',
      'je dois mettre combien en pub par jour ?',
      'combien de budget publicitaire ?',
    ]) {
      expect(readSignals(text, 'QUESTION', THREAD).questionTopic, text).toBe('AD_BUDGET');
    }
  });

  it('aucun saut de mots ne reste sans ancre dans les deux lexiques', () => {
    for (const file of ['conversation/signals.ts', 'conversation/commercialPolicy.ts']) {
      const source = readFileSync(join(SRC, 'lib', file), 'utf8');
      // Chaque `[^.!?]{0,N}` doit être immédiatement suivi du lookbehind de
      // frontière de mot. Un saut nu réintroduit la classe entière.
      const gaps = source.match(/\[\^\.!\?\]\{0,\d+\}(?!\(\?<!\[)/g) ?? [];
      expect(gaps, `${file} porte ${String(gaps.length)} saut(s) non ancré(s)`).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// C — deux tables qui doivent s'accorder
// ---------------------------------------------------------------------------

describe('C · l’auto-répondable se dérive de la taxonomie, il ne s’écrit pas deux fois', () => {
  it('l’auto-répondable est INCLUS dans le rédigeable — jamais au-delà', () => {
    const draftable = new Set(
      (Object.keys(CATEGORY_POLICY) as ReplyCategory[]).filter(
        (category) => CATEGORY_POLICY[category].draftEligible,
      ),
    );
    const beyond = [...AUTO_REPLYABLE_CATEGORIES].filter((category) => !draftable.has(category));
    // Une catégorie admise par le rail mais que le rédacteur ne traite pas
    // finirait en `draft_missing` — un refus sur la mauvaise porte.
    expect(beyond).toEqual([]);
  });

  it('ce qui sépare les deux tables est EXACTEMENT le report explicite', () => {
    const draftable = (Object.keys(CATEGORY_POLICY) as ReplyCategory[]).filter(
      (category) => CATEGORY_POLICY[category].draftEligible,
    );
    const excluded = draftable.filter((category) => !AUTO_REPLYABLE_CATEGORIES.has(category));
    // `NOT_NOW` est `draftEligible` chez D2 — un accusé de réception a du sens —
    // mais appartient au moteur de relance, pas au rail de réponse immédiate.
    // C'est la seule exclusion documentée ; une seconde serait une divergence.
    expect(excluded).toEqual(['NOT_NOW']);
  });
});

// ---------------------------------------------------------------------------
// D — un jeton d'exception ne se fabrique pas
// ---------------------------------------------------------------------------

describe('D · le jeton de cadence du test contrôlé ne se fabrique nulle part ailleurs', () => {
  it('aucun module de production ne transtype vers ControlledSelfTestCadence', () => {
    const offenders = ALL_SOURCES.filter((path) => {
      if (path.endsWith(join('conversation', 'controlledSelfTest.ts'))) return false;
      return /as\s+unknown\s+as\s+ControlledSelfTestCadence/.test(readFileSync(path, 'utf8'));
    });
    expect(offenders, 'un jeton fabriqué met minSendIntervalMs à zéro').toEqual([]);
  });

});

// ---------------------------------------------------------------------------
// E — la reprise d'un plan a UNE lecture
// ---------------------------------------------------------------------------

describe('E · « ce plan repart-il ? » ne se décide qu’à un endroit', () => {
  it('la requête de réclamation porte les deux refus de la lecture de référence', () => {
    const source = readFileSync(join(SRC, 'lib', 'conversation', 'plan.ts'), 'utf8');
    const claim = source.slice(source.indexOf('export async function claimConversationPlan'));
    expect(claim).toContain('c.external_effect_attempted = false');
    expect(claim).toContain('c.decision = any(');
    // La liste vient du module, jamais d'un littéral SQL recopié.
    expect(claim).toContain('[...ACTIONABLE_PLAN_DECISIONS]');
  });

  it('aucun appelant hors du module ne re-dérive la claimabilité par un statut nu', () => {
    const offenders = ALL_SOURCES.filter((path) => {
      if (path.endsWith(join('conversation', 'plan.ts'))) return false;
      const source = readFileSync(path, 'utf8');
      return /status\s*!==\s*'PLANNED'|status\s*===\s*'PLANNED'\s*\|\|\s*status\s*===\s*'SKIPPED'/.test(
        source,
      );
    });
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// F — les versions servent le même tour
// ---------------------------------------------------------------------------

describe('F · trois versions décident d’un envoi, et les trois sont comparées', () => {
  it('le crochet pré-effet compare la politique, la politique commerciale ET le rédacteur', () => {
    const source = readFileSync(join(SRC, 'lib', 'conversation', 'preEffect.ts'), 'utf8');
    expect(source).toContain('plan.policyVersion !== CONVERSATION_POLICY_VERSION');
    expect(source).toContain('plan.commercialPolicyVersion !== COMMERCIAL_POLICY_VERSION');
    expect(source).toContain('plan.brainVersion !== conversationPromptVersionFor(plan.channel)');
  });

  it('le rail autonome lit le brouillon écrit sous la consigne COURANTE', () => {
    const source = readFileSync(join(SRC, 'lib', 'conversation', 'assessment.ts'), 'utf8');
    expect(source).toContain('loadDraftForAnalysisVersion(');
    // L'ancienne lecture — « le dernier écrit » — ne doit plus servir ici.
    expect(source).not.toMatch(/loadDraftForAnalysis\(/);
  });

  it('les consignes courantes se dérivent de la fonction, elles ne se recopient pas', () => {
    expect([...CURRENT_DRAFT_PROMPT_VERSIONS].sort()).toEqual(
      [conversationPromptVersionFor('email'), conversationPromptVersionFor('instagram_dm')].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// G — le contrôle de naturalité est le MÊME des deux côtés
// ---------------------------------------------------------------------------

describe('G · le rédacteur et le rail jugent un texte avec le même barème', () => {
  it('les deux appels de checkNaturalness passent answerExpected', () => {
    for (const file of ['conversation/brain.ts', 'conversation/assessment.ts']) {
      const source = readFileSync(join(SRC, 'lib', file), 'utf8');
      const index = source.indexOf('checkNaturalness({');
      expect(index, `${file} n’appelle pas checkNaturalness`).toBeGreaterThan(-1);
      const call = source.slice(index, index + 2000);
      expect(call, `${file} juge sans answerExpected`).toContain('answerExpected');
    }
  });
});

// ---------------------------------------------------------------------------
// H — aucun fichier source n'est invisible à une relecture
// ---------------------------------------------------------------------------

describe('H · aucune source ne se rend illisible à grep', () => {
  it('aucun fichier de src/ ne contient d’octet de contrôle', () => {
    const offenders: string[] = [];
    for (const path of ALL_SOURCES) {
      const bytes = readFileSync(path);
      for (const byte of bytes) {
        if (byte < 9 || (byte >= 11 && byte <= 12) || (byte >= 14 && byte <= 31)) {
          offenders.push(path);
          break;
        }
      }
    }
    // Un octet nul écrit en clair fait classer le fichier « data » : `grep` le
    // saute SANS LE DIRE, et toute relecture textuelle du dépôt le sous-déclare.
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// I — l'idempotence entrante est au MESSAGE, jamais au fil
// ---------------------------------------------------------------------------

describe('I · un identifiant de message fournisseur = un événement, et rien d’autre', () => {
  it('la clé d’unicité porte le message, pas le fil', () => {
    const migrations = resolve(__dirname, '..', '..', 'db', 'migrations');
    const sources = readdirSync(migrations)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => readFileSync(join(migrations, name), 'utf8'))
      .join('\n');
    expect(sources).toContain(
      'create unique index r6b_inbound_messages_provider_message_idx\n  on r6b_inbound_messages (provider, mailbox, provider_message_id)',
    );
    // Une clé qui porterait le fil ferait de « ce fil a déjà été vu » une
    // raison de ne pas ingérer un message neuf. Aucun index unique de cette
    // table ne doit mentionner `provider_thread_id`.
    const threadScoped = /create unique index[^;]*r6b_inbound_messages[^;]*provider_thread_id/s.test(
      sources,
    );
    expect(threadScoped, 'un index unique scopé au fil dédupliquerait des messages distincts').toBe(
      false,
    );
  });

  it('« déjà connue » se compte sur une insertion refusée, jamais sur un fil revu', () => {
    const source = readFileSync(join(SRC, 'lib', 'inbound', 'instagramCollector.ts'), 'utf8');
    // Le compteur ne s'incrémente que dans la branche « la ligne existait
    // déjà » — l'inverse littéral de `persisted.created`.
    expect(source).toContain('else alreadyKnown += 1;');
    // Et jamais depuis une observation de FIL.
    const bad = /alreadyKnown\s*\+=\s*1[^;]*thread/i.test(source);
    expect(bad).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// J — ce qu'on refuse de LIRE, on refuse aussi de l'ÉCRIRE
// ---------------------------------------------------------------------------

describe('J · une métrique qui fait escalader une QUESTION ne s’écrit pas non plus', () => {
  /**
   * La divergence que ce dépôt a payée trois fois : un vocabulaire connu d'un
   * côté et pas de l'autre. `commercialPolicy` relève « cpl », « roas », « taux
   * de conversion » et « roi » sur ce qu'on nous DEMANDE ; rien ne les
   * regardait sur ce qu'on ÉCRIRAIT. Une question sur le ROI escaladait donc
   * correctement, et un brouillon qui promettait un ROI de sa propre
   * initiative traversait `checkReplyDraft`, `detectPerformanceClaims` et
   * `checkTrialStatement` sans un seul drapeau.
   *
   * Onze formes ont été mesurées. Celles qui portaient un montant en euros
   * étaient arrêtées par `unapproved_metric` — mais un ratio, un pourcentage ou
   * un compte n'a pas de devise.
   */
  const PROMISES: readonly string[] = Object.freeze([
    'Tu feras un ROI de 4 sur ton budget.',
    'On tourne à un ROI de 4,5 chez nos clients.',
    'Le CPL est autour de 5 €.',
    'Tu auras un coût par lead de 6 euros.',
    'Le taux de conversion tourne autour de 20 %.',
    'Tu auras 10 clients par mois.',
    'Compte une quinzaine de demandes par semaine.',
    'Les premiers résultats arrivent en 15 jours.',
    'En deux semaines tu verras les premières demandes.',
    'On génère en moyenne 30 leads par mois.',
    'Ton retour sur investissement sera de 5.',
  ]);

  it.each(PROMISES)('« %s » est refusé', (text) => {
    expect(detectPerformanceClaims(text).length).toBeGreaterThan(0);
  });

  /**
   * Et ce qui doit RESTER dicible le reste. Un lexique qui bloque tout ne
   * protège rien : il rend le rail muet, et un rail muet finit par être
   * desserré en bloc.
   */
  const SAYABLE: readonly string[] = Object.freeze([
    'Je fais tourner des pubs Meta et tu rappelles les demandes.',
    'Le test dure 7 jours : je ne facture aucun frais de service, tu payes ton budget pub, autour de 20 à 25 € par jour.',
    'Je te demande ça parce que j’aide des boîtes de prestation standard.',
    'Je ne travaille qu’avec une entreprise par zone concurrente.',
    'Il me faut un accès à ton Business Manager, jamais de mot de passe.',
    'Ça dépend de ce que tu as déjà en place.',
    'Tu veux qu’on en parle 15 minutes cette semaine ?',
    // Le NOM d'une métrique est du vocabulaire, sa VALEUR est la promesse : la
    // phrase honnête doit rester dicible, sans quoi le rail devient muet là où
    // il devrait justement parler.
    'Je ne peux pas te promettre de ROI.',
    'Je ne donne pas de taux de conversion, ça dépend de ton closing.',
    // Et le rapport d'apprentissage, qui n'écrit à personne, doit pouvoir
    // NOMMER ses propres mesures.
    'Le taux de réponse seul ne suffit pas à trancher.',
  ]);

  it.each(SAYABLE)('« %s » reste dicible', (text) => {
    expect(detectPerformanceClaims(text)).toEqual([]);
  });
});
