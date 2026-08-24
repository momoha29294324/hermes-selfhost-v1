import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assessAutoReplyEligibility,
  type AutoReplyEligibilityFacts,
  type AutoReplyEligibilityRefusal,
} from '@/lib/autoreply/eligibility';
import { assessRolloutBudget, type AutoReplyActivation } from '@/lib/autoreply/activation';
import { replyStaleness } from '@/lib/conversation/preEffect';
import { REPLY_CLASSIFIER_PROMPT_VERSION } from '@/lib/replies/classifier';

/**
 * HERMES-AUTO-REPLY-PRODUCTION-R1 §2 — l'ENVELOPPE POSITIVE, éprouvée sans base.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce fichier fige
 * ---------------------------------------------------------------------------
 * Que « auto-réponse » ne veut PAS dire « répondre à tout DM visible ». Chaque
 * cas ci-dessous retire UNE preuve d'un dossier par ailleurs parfait, et
 * vérifie que le verdict bascule. C'est la seule façon de montrer qu'aucune de
 * ces preuves n'est décorative.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi ces tests sont PURS
 * ---------------------------------------------------------------------------
 * Parce qu'une porte qui décide qu'un message part sans relecture humaine doit
 * pouvoir être éprouvée sur des états que les données réelles ne produiront pas
 * de sitôt — une corrélation faible, une identité retirée, deux messages à la
 * même milliseconde. La lecture, elle, s'éprouve sur des données réelles
 * (`autoreplyRuntime.test.ts`).
 */

const FRONTIER = '2026-08-24T09:00:00.000Z';
const MESSAGE_ID = '11111111-1111-4111-8111-111111111111';

/** Le dossier COMPLET : chaque preuve présente, chaque fait au vert. */
function facts(overrides: Partial<AutoReplyEligibilityFacts> = {}): AutoReplyEligibilityFacts {
  return {
    inboundMessageId: MESSAGE_ID,
    receivedAt: '2026-08-24T10:00:00.000Z',
    frontierAt: FRONTIER,
    correlationStatus: 'EXACT',
    firstTouchManifestId: '22222222-2222-4222-8222-222222222222',
    firstTouchOutreachEventId: '33333333-3333-4333-8333-333333333333',
    firstTouchTransport: 'instagram_dm',
    suppressed: false,
    outreachState: 'REPLIED',
    identityConfirmed: true,
    latestInboundId: MESSAGE_ID,
    latestInboundTies: 1,
    absorbedIntoBurst: false,
    analysisStatus: 'ACTIVE',
    analysisPromptVersion: REPLY_CLASSIFIER_PROMPT_VERSION,
    effectAttemptedOnTrigger: false,
    ...overrides,
  };
}

function refusalOf(overrides: Partial<AutoReplyEligibilityFacts>): AutoReplyEligibilityRefusal {
  const verdict = assessAutoReplyEligibility(facts(overrides));
  if (verdict.eligible) throw new Error('attendu : un refus');
  return verdict.refusal;
}

describe('§2 — le dossier complet passe, et lui seul', () => {
  it('un tour Hermes complet est éligible', () => {
    const verdict = assessAutoReplyEligibility(facts());
    expect(verdict.eligible).toBe(true);
  });

  it('chaque preuve retirée fait basculer le verdict — aucune n’est décorative', () => {
    // Une table plutôt que dix `it` : ce qui compte est que TOUTES basculent,
    // et une liste rend visible celle qu'on aurait oubliée.
    const cases: ReadonlyArray<[Partial<AutoReplyEligibilityFacts>, AutoReplyEligibilityRefusal]> = [
      [{ frontierAt: null }, 'RUNTIME_NOT_ACTIVATED'],
      [{ receivedAt: '2026-08-24T08:59:59.999Z' }, 'BEFORE_ACTIVATION_FRONTIER'],
      [{ correlationStatus: 'UNMATCHED' }, 'NOT_CORRELATED'],
      [{ correlationStatus: 'REVIEW_REQUIRED' }, 'NOT_CORRELATED'],
      [{ correlationStatus: null }, 'NOT_CORRELATED'],
      [{ firstTouchManifestId: null }, 'NO_HERMES_FIRST_TOUCH'],
      [{ firstTouchOutreachEventId: null }, 'NO_HERMES_FIRST_TOUCH'],
      [{ firstTouchTransport: 'email' }, 'CHANNEL_UNSUPPORTED'],
      [{ firstTouchTransport: null }, 'CHANNEL_UNSUPPORTED'],
      [{ suppressed: true }, 'PROSPECT_SUPPRESSED'],
      [{ outreachState: 'NOT_INTERESTED' }, 'CONVERSATION_CLOSED'],
      [{ outreachState: 'SUPPRESSED' }, 'CONVERSATION_CLOSED'],
      [{ identityConfirmed: false }, 'IDENTITY_UNCONFIRMED'],
      [{ absorbedIntoBurst: true }, 'ABSORBED_INTO_BURST'],
      [{ latestInboundId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, 'SUPERSEDED_BY_NEWER_TURN'],
      [{ latestInboundId: null }, 'SUPERSEDED_BY_NEWER_TURN'],
      [{ latestInboundTies: 2 }, 'IDENTITY_AMBIGUOUS'],
      [{ analysisStatus: null }, 'NOT_UNDERSTOOD_YET'],
      [{ analysisStatus: 'SUPERSEDED' }, 'NOT_UNDERSTOOD_YET'],
      [{ analysisPromptVersion: 'hermes-turn-2' }, 'ANALYSIS_VERSION_STALE'],
      [{ analysisPromptVersion: null }, 'ANALYSIS_VERSION_STALE'],
      [{ effectAttemptedOnTrigger: true }, 'EFFECT_ALREADY_ATTEMPTED'],
    ];
    for (const [overrides, expected] of cases) {
      expect(refusalOf(overrides), JSON.stringify(overrides)).toBe(expected);
    }
  });
});

describe('§2 — fail-closed : un fait illisible refuse', () => {
  it('une heure de réception illisible est traitée comme ANTÉRIEURE à la frontière', () => {
    expect(refusalOf({ receivedAt: 'pas une date' })).toBe('BEFORE_ACTIVATION_FRONTIER');
    expect(refusalOf({ receivedAt: null })).toBe('BEFORE_ACTIVATION_FRONTIER');
  });

  it('une frontière illisible ferme le rail — jamais l’inverse', () => {
    const verdict = assessAutoReplyEligibility(facts({ frontierAt: 'jamais' }));
    expect(verdict.eligible).toBe(false);
    expect(verdict.eligible === false && verdict.refusal).toBe('RUNTIME_NOT_ACTIVATED');
    expect(verdict.eligible === false && verdict.reconsiderable).toBe(false);
  });

  it('la frontière est stricte à la milliseconde — rien n’est arrondi', () => {
    expect(assessAutoReplyEligibility(facts({ receivedAt: FRONTIER })).eligible).toBe(true);
    expect(
      assessAutoReplyEligibility(facts({ receivedAt: '2026-08-24T08:59:59.999Z' })).eligible,
    ).toBe(false);
  });
});

describe('§2 — un DM d’inconnu ne peut pas recevoir de réponse commerciale', () => {
  it('un message sans corrélation, sans manifeste et sans envoi attesté est refusé trois fois', () => {
    // Le scénario réel : quelqu'un écrit au compte sans qu'on lui ait jamais
    // écrit. Aucune des trois preuves n'existe, et la PREMIÈRE suffit.
    const verdict = assessAutoReplyEligibility(
      facts({
        correlationStatus: 'UNMATCHED',
        firstTouchManifestId: null,
        firstTouchOutreachEventId: null,
        firstTouchTransport: null,
      }),
    );
    expect(verdict.eligible).toBe(false);
    expect(verdict.eligible === false && verdict.refusal).toBe('NOT_CORRELATED');
    expect(verdict.eligible === false && verdict.reconsiderable).toBe(false);
  });

  it('une corrélation forte NE SUFFIT PAS sans preuve d’envoi', () => {
    // La corrélation dit « ce message répond à quelque chose ». L'envoi attesté
    // dit « ce quelque chose est parti ». Les confondre laisserait répondre à
    // un fil qu'on n'a jamais ouvert.
    expect(refusalOf({ firstTouchOutreachEventId: null })).toBe('NO_HERMES_FIRST_TOUCH');
  });
});

describe('§2 — strictement plus stricte que la garde de fraîcheur, jamais l’inverse', () => {
  /**
   * L'invariant anti-divergence.
   *
   * `replyStaleness` est la garde qui refuse en DERNIER, dans le crochet
   * pré-effet. Celle-ci refuse en PREMIER, avant qu'un navigateur ne s'ouvre.
   * Deux lectures d'un même fait finissent toujours par diverger ; ce qui doit
   * être vrai, c'est que la divergence ne peut aller QUE dans le sens strict.
   */
  it('tout ce que l’éligibilité laisse passer, la fraîcheur le laisse passer aussi', () => {
    const eligible = facts();
    expect(assessAutoReplyEligibility(eligible).eligible).toBe(true);
    expect(
      replyStaleness(eligible.receivedAt, eligible.receivedAt, {
        triggerInboundMessageId: eligible.inboundMessageId,
        latestInboundId: eligible.latestInboundId,
        latestInboundTies: eligible.latestInboundTies,
      }),
    ).toBeNull();
  });

  it('le cas où `replyStaleness` est indulgente est refusé ICI', () => {
    // Deux messages au même horodatage, identifiants différents : le « plus
    // récent » y est désigné par un uuid. `replyStaleness` compare des heures
    // et ne voit rien ; l'enveloppe, elle, exige l'IDENTITÉ.
    const sameInstant = '2026-08-24T10:00:00.000Z';
    const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    expect(
      replyStaleness(sameInstant, sameInstant, {
        triggerInboundMessageId: MESSAGE_ID,
        latestInboundId: other,
        latestInboundTies: 2,
      }),
    ).toBeNull();
    expect(refusalOf({ latestInboundId: other, latestInboundTies: 2 })).toBe(
      'SUPERSEDED_BY_NEWER_TURN',
    );
  });
});

describe('§7 — le budget de déploiement', () => {
  function activation(maxEffects: number | null): AutoReplyActivation {
    return Object.freeze({
      id: 'aaaaaaaa-0000-4000-8000-000000000000',
      frontierAt: FRONTIER,
      activatedAt: FRONTIER,
      activatedBy: 'Test',
      reason: 'test',
      policyVersion: 'p',
      commercialPolicyVersion: 'c',
      maxEffects,
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
    });
  }

  it('borné : il se referme exactement au nombre écrit', () => {
    expect(assessRolloutBudget(activation(3), 0).open).toBe(true);
    expect(assessRolloutBudget(activation(3), 2).open).toBe(true);
    expect(assessRolloutBudget(activation(3), 3).open).toBe(false);
    expect(assessRolloutBudget(activation(3), 9).open).toBe(false);
  });

  it('un budget de zéro est fermé dès le premier regard', () => {
    expect(assessRolloutBudget(activation(0), 0).open).toBe(false);
  });

  it('non borné : il reste ouvert, et le dit — les plafonds Instagram restent devant', () => {
    const verdict = assessRolloutBudget(activation(null), 500);
    expect(verdict.open).toBe(true);
    expect(verdict.remaining).toBeNull();
    expect(verdict.detail).toContain('plafonds Instagram');
  });

  it('un compte d’effets illisible referme', () => {
    expect(assessRolloutBudget(activation(3), Number.NaN).open).toBe(false);
    expect(assessRolloutBudget(activation(3), -1).open).toBe(false);
  });
});

describe('§13 — aucune exception nominative', () => {
  const SOURCES = [
    'src/lib/autoreply/eligibility.ts',
    'src/lib/autoreply/activation.ts',
    'src/lib/autoreply/runtime.ts',
    'src/lib/autoreply/outcome.ts',
    'src/lib/autoreply/status.ts',
    'src/lib/autoreply/heartbeat.ts',
  ] as const;

  /**
   * Le fichier SANS ses commentaires.
   *
   * Ces modules documentent longuement ce qu'ils n'importent PAS —
   * « il n'importe pas `setKillSwitch` », « n'importe pas `controlledSelfTest` ».
   * Chercher ces mots dans le texte entier ferait échouer le test sur sa propre
   * explication, et la seule façon de le faire passer serait d'effacer
   * l'explication. C'est la leçon que `hermes-certify` a déjà tirée : une garde
   * qui se déclenche sur sa propre documentation apprend à ignorer le mot
   * « échec ».
   */
  function executablePart(path: string): string {
    return readFileSync(resolve(__dirname, '..', path), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
  }

  it('aucun module du rail de production ne connaît la coquille du test contrôlé', () => {
    for (const path of SOURCES) {
      const code = executablePart(path);
      expect(code, path).not.toContain('controlledSelfTest');
      expect(code, path).not.toContain('ControlledSelfTest');
      expect(code, path).not.toContain('operator_second_account');
      expect(code, path).not.toContain('hermes_controlled_self_tests');
    }
  });

  it('aucun ne sait lever l’arrêt global, ni envoyer par un autre chemin', () => {
    // Les IMPORTATIONS, pas le fichier : c'est la seule chose qui donne un
    // pouvoir. Un identifiant cité dans une phrase n'en donne aucun.
    for (const path of SOURCES) {
      const source = readFileSync(resolve(__dirname, '..', path), 'utf8');
      const imports = (source.match(/^import[\s\S]*?from\s+'[^']+';$/gmu) ?? []).join('\n');
      expect(imports, path).not.toContain('setKillSwitch');
      expect(imports, path).not.toContain('sendFirstTouchDm');
      expect(imports, path).not.toContain('r6bLiveDispatch');
      expect(imports, path).not.toContain('controlledSelfTest');
    }
  });

  it('`assessAutoReplyEligibility` ne reçoit aucun identifiant de compte ni de campagne', () => {
    // La preuve par le TYPE : il n'existe aucune donnée depuis laquelle une
    // exception nominative pourrait être écrite. Les seuls identifiants qui
    // entrent sont ceux du message et de son premier contact.
    const keys = Object.keys(facts()).sort();
    expect(keys).toEqual(
      [
        'absorbedIntoBurst',
        'analysisPromptVersion',
        'analysisStatus',
        'correlationStatus',
        'effectAttemptedOnTrigger',
        'firstTouchManifestId',
        'firstTouchOutreachEventId',
        'firstTouchTransport',
        'frontierAt',
        'identityConfirmed',
        'inboundMessageId',
        'latestInboundId',
        'latestInboundTies',
        'outreachState',
        'receivedAt',
        'suppressed',
      ].sort(),
    );
  });
});
