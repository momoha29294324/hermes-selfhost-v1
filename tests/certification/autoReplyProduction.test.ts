/**
 * HERMES-AUTO-REPLY-PRODUCTION-R1 — les INVARIANTS du runtime de production.
 *
 * Chaque bloc correspond à une CLASSE de défaut que ce dépôt a réellement
 * rencontrée — un vocabulaire partiel qui laisse passer un cas inconnu, une
 * exception nominative qui s'installe dans un chemin de production, un
 * long-vivant qui tourne sous du code périmé, une commande qui sait ouvrir sa
 * propre porte.
 *
 * Ils lisent des SOURCES quand la propriété porte sur le code lui-même : c'est
 * la seule façon de vérifier « personne n'a écrit ceci ailleurs ».
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  outcomeForDecision,
  outcomeForEligibilityRefusal,
  outcomeForExecution,
  outcomeForRefusalCode,
} from '@/lib/autoreply/outcome';
import { assessAutoReplyEligibility } from '@/lib/autoreply/eligibility';
import { REPLY_CLASSIFIER_PROMPT_VERSION } from '@/lib/replies/classifier';

const ROOT = resolve(__dirname, '..', '..');

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

/** Le fichier SANS ses commentaires — voir `autoreplyEligibility.test.ts`. */
function executablePart(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

/** Les IMPORTATIONS seules — ce qui donne un pouvoir, pas ce qui le cite. */
function importsOf(path: string): string {
  return (read(path).match(/^import[\s\S]*?from\s+'[^']+';$/gmu) ?? []).join('\n');
}

const PRODUCTION_MODULES = [
  'src/lib/autoreply/activation.ts',
  'src/lib/autoreply/eligibility.ts',
  'src/lib/autoreply/outcome.ts',
  'src/lib/autoreply/runtime.ts',
  'src/lib/autoreply/heartbeat.ts',
  'src/lib/autoreply/status.ts',
] as const;

const PRODUCTION_CLIS = [
  'src/cli/autoreply-worker.ts',
  'src/cli/autoreply-activation.ts',
  'src/cli/autoreply-status.ts',
] as const;

// ---------------------------------------------------------------------------
// A — aucune exception nominative dans un chemin de production
// ---------------------------------------------------------------------------

describe('A · le rail de production ne connaît ni coquille, ni compte nommé', () => {
  it('aucun module ni aucune commande ne cite la coquille du test contrôlé', () => {
    for (const path of [...PRODUCTION_MODULES, ...PRODUCTION_CLIS]) {
      const code = executablePart(path);
      expect(code, path).not.toContain('controlledSelfTest');
      expect(code, path).not.toContain('ControlledSelfTest');
      expect(code, path).not.toContain('operator_second_account');
      expect(code, path).not.toContain('hermes_controlled_self_tests');
    }
  });

  it('aucun ne résout de jeton de CADENCE — l’espacement de production s’applique à tous', () => {
    // Le jeton `ControlledSelfTestCadence` est la seule chose du dépôt capable
    // de mettre l'espacement minimal à zéro. Ne pas savoir le résoudre est
    // exactement ce qui garantit que la cadence de production vaut pour TOUTE
    // conversation, y compris celle d'une coquille inscrite ailleurs.
    for (const path of [...PRODUCTION_MODULES, ...PRODUCTION_CLIS]) {
      const code = executablePart(path);
      expect(code, path).not.toContain('resolveControlledSelfTestCadence');
      // Le champ lui-même : c'est en le PASSANT qu'on desserrerait l'espacement.
      // Le mot « cadence » reste libre en français (le worker affiche « cadence
      // de sondage »), et une garde qui refuserait un mot d'affichage
      // apprendrait à ignorer le mot « échec ».
      expect(code, path).not.toMatch(/\bcadence\s*[:,]/);
      expect(code, path).not.toContain('cadence:');
    }
  });
});

// ---------------------------------------------------------------------------
// B — aucune commande ne sait ouvrir sa propre porte
// ---------------------------------------------------------------------------

describe('B · les portes ne s’ouvrent pas depuis le chemin qu’elles gardent', () => {
  it('aucun module ni aucune commande n’importe `setKillSwitch`', () => {
    for (const path of [...PRODUCTION_MODULES, ...PRODUCTION_CLIS]) {
      expect(importsOf(path), path).not.toContain('setKillSwitch');
    }
  });

  it('le WORKER ne sait pas s’activer lui-même', () => {
    // Armer la frontière et faire tourner le rail sont deux décisions. Une
    // commande qui ferait les deux rendrait impossible d'en défaire une seule,
    // et un LaunchAgent chargé au démarrage armerait le rail sans qu'aucun
    // humain n'ait rien dit.
    const imports = importsOf('src/cli/autoreply-worker.ts');
    expect(imports).not.toContain('activateAutoReply');
    expect(executablePart('src/cli/autoreply-worker.ts')).not.toContain('activateAutoReply');
  });

  it('la commande d’ACTIVATION ne sait ni envoyer, ni ouvrir un navigateur', () => {
    const imports = importsOf('src/cli/autoreply-activation.ts');
    for (const forbidden of [
      'executeConversationReply',
      'sendThreadReply',
      'sendFirstTouchDm',
      'PlaywrightInstagram',
      'runAutoReplyCycle',
      'runAutoReplyRuntime',
    ]) {
      expect(imports, forbidden).not.toContain(forbidden);
    }
  });

  it('la commande de STATUT ne sait rien écrire ni rien ouvrir', () => {
    const imports = importsOf('src/cli/autoreply-status.ts');
    for (const forbidden of [
      'executeConversationReply',
      'sendThreadReply',
      'PlaywrightInstagram',
      'activateAutoReply',
      'revokeAutoReplyActivation',
      'runAutoReplyCycle',
    ]) {
      expect(imports, forbidden).not.toContain(forbidden);
    }
  });

  it('la FRONTIÈRE ne s’antidate pas — aucune option de date nulle part', () => {
    const activation = executablePart('src/lib/autoreply/activation.ts');
    // La seule valeur écrite dans `frontier_at` est `now()`, celle de la base.
    expect(activation).toContain('values (now(), now(), $1, $2, $3, $4, $5)');
    // Le PARSEUR, pas le texte : la commande NOMME ces options dans son message
    // d'erreur pour dire qu'elles n'existent pas, et chercher le mot ferait
    // échouer le test sur sa propre explication.
    const cli = executablePart('src/cli/autoreply-activation.ts');
    for (const option of ['--frontier', '--since', '--backdate', '--at']) {
      expect(cli, option).not.toContain(`case '${option}':`);
    }
    // Et le parseur refuse par DÉFAUT tout ce qu'il ne connaît pas.
    expect(cli).toContain('option inconnue');
  });
});

// ---------------------------------------------------------------------------
// C — le vocabulaire d'observation est une TRADUCTION, jamais une décision
// ---------------------------------------------------------------------------

describe('C · aucun verdict ne tombe dans le vide', () => {
  it('les refus du crochet pré-effet sont TOUS traduits, et fail-closed', () => {
    // La table est un `Record` complet : le compilateur s'arrête si un refus
    // naît. Ce test couvre l'autre moitié — un code INCONNU tombe du côté
    // fermé, jamais sur une attente.
    expect(outcomeForRefusalCode('BLOCKED_KILL_SWITCH')).toBe('HARD_BLOCKED_SAFETY');
    expect(outcomeForRefusalCode('BLOCKED_DAILY_CAP')).toBe('TEMPORARILY_BLOCKED_CAP');
    expect(outcomeForRefusalCode('UN_CODE_QUI_NEXISTE_PAS')).toBe('HARD_BLOCKED_SAFETY');
    expect(outcomeForRefusalCode('')).toBe('HARD_BLOCKED_SAFETY');
  });

  it('un statut d’exécution inconnu de son code reste du côté fermé', () => {
    expect(outcomeForExecution('BLOCKED', 'IG_REPLY_CONTROL_AMBIGUOUS')).toBe('HARD_BLOCKED_SAFETY');
    expect(outcomeForExecution('FAILED', 'REPLY_RAIL_ERROR')).toBe('HARD_BLOCKED_SAFETY');
    expect(outcomeForExecution('SENT', 'REPLY_SENT')).toBe('AUTO_REPLIED');
    expect(outcomeForExecution('AMBIGUOUS', 'X')).toBe('DELIVERY_AMBIGUOUS');
  });

  it('les quatre décisions de contenu ont chacune leur issue, et une seule', () => {
    const mapped = (
      ['AUTO_REPLY_ELIGIBLE', 'AUTO_REPLY_SKIP', 'HUMAN_ESCALATION', 'TERMINAL_STOP'] as const
    ).map(outcomeForDecision);
    expect(new Set(mapped).size).toBe(4);
    expect(outcomeForDecision('HUMAN_ESCALATION')).toBe('HUMAN_ESCALATION');
    expect(outcomeForDecision('TERMINAL_STOP')).toBe('CONVERSATION_STOPPED');
  });

  it('un refus de périmètre qui NOMME une sécurité est rangé du côté sécurité', () => {
    // Le classement n'est pas cosmétique : un opérateur qui lit
    // `TEMPORAIREMENT bloqué` attend que ça passe tout seul. Une exclusion, une
    // identité non établie ou une conversation close ne passent jamais toutes
    // seules.
    for (const refusal of [
      'PROSPECT_SUPPRESSED',
      'CONVERSATION_CLOSED',
      'IDENTITY_UNCONFIRMED',
      'IDENTITY_AMBIGUOUS',
      'EFFECT_ALREADY_ATTEMPTED',
    ] as const) {
      expect(outcomeForEligibilityRefusal(refusal), refusal).toBe('HARD_BLOCKED_SAFETY');
    }
  });
});

// ---------------------------------------------------------------------------
// D — la sentinelle de révision est câblée sur les TROIS runtimes
// ---------------------------------------------------------------------------

describe('D · aucun long-vivant ne tourne sous du code périmé', () => {
  const RUNTIMES = [
    ['src/cli/ig-inbound-run.ts', 'relève entrante'],
    ['src/cli/ig-autonomous-worker.ts', 'worker sortant'],
    ['src/cli/autoreply-worker.ts', 'runtime d’auto-réponse'],
  ] as const;

  it('les trois commandes durables construisent une sentinelle de révision', () => {
    for (const [path, label] of RUNTIMES) {
      expect(executablePart(path), label).toContain('createCodeRevisionSentinel');
    }
  });

  it('la boucle d’auto-réponse la relit AVANT le cycle, jamais après', () => {
    const runtime = executablePart('src/lib/autoreply/runtime.ts');
    const sentinel = runtime.indexOf('codeRevision?.hasDrifted()');
    const cycle = runtime.indexOf('await runAutoReplyCycle(input, deps)');
    expect(sentinel).toBeGreaterThan(-1);
    expect(cycle).toBeGreaterThan(-1);
    expect(sentinel).toBeLessThan(cycle);
  });

  it('sa seule conséquence possible est un ARRÊT — aucun rechargement à chaud', () => {
    const runtime = executablePart('src/lib/autoreply/runtime.ts');
    expect(runtime).not.toContain('import(');
    expect(runtime).toContain("stoppedBy = 'CODE_REVISION_CHANGED'");
  });

  it('les DEUX autres boucles la relisent aussi AVANT d’agir', () => {
    // Le worker sortant a reçu cette sentinelle au round précédent ; la
    // relève entrante l'a depuis HERMES-ACTIVE-ANALYSIS-VERSION-CONFLICT-R1.
    // Ce qui compte n'est pas qu'elles l'aient, c'est qu'elles la lisent avant
    // le geste — après, un DM de plus serait déjà parti.
    const outbound = executablePart('src/lib/instagram/autonomousLiveWorker.ts');
    const outboundSentinel = outbound.indexOf('codeRevision?.hasDrifted()');
    const outboundCycle = outbound.indexOf('await runAutonomousLiveWorker(input, deps)');
    expect(outboundSentinel).toBeGreaterThan(-1);
    expect(outboundCycle).toBeGreaterThan(-1);
    expect(outboundSentinel).toBeLessThan(outboundCycle);
    expect(outbound).toContain("stoppedBy = 'CODE_REVISION_CHANGED'");

    const inbound = executablePart('src/lib/inbound/instagramRuntime.ts');
    expect(inbound).toContain('codeRevision?.hasDrifted()');
    expect(inbound).toContain("stoppedBy = 'CODE_REVISION_CHANGED'");
  });

  it('les trois runtimes rendent le MÊME code de sortie sur une dérive : 5', () => {
    // Un superviseur n'a qu'une règle à connaître : « 5 = relance-moi, je
    // tourne sous du code périmé ». Trois valeurs différentes en feraient trois.
    for (const path of [
      'src/cli/ig-inbound-run.ts',
      'src/cli/ig-autonomous-worker.ts',
      'src/cli/autoreply-worker.ts',
    ]) {
      const code = executablePart(path);
      expect(code, path).toMatch(/CODE_REVISION_CHANGED[\s\S]{0,900}?(?:return|exitCode\s*=)\s*5\b/);
    }
  });
});

// ---------------------------------------------------------------------------
// E — le navigateur n'est jamais tenu pendant une attente
// ---------------------------------------------------------------------------

describe('E · le bail du profil est rendu entre deux tours', () => {
  it('le rail est refermé dans un `finally`, après CHAQUE tour', () => {
    const runtime = read('src/lib/autoreply/runtime.ts');
    // Le `finally` qui suit l'exécution, et l'appel de fermeture qu'il contient.
    expect(runtime).toMatch(/\}\s*finally\s*\{[\s\S]{0,600}rail\.close\(\)/);
  });

  it('la boucle n’attend jamais avec un navigateur ouvert : elle dort APRÈS la fermeture', () => {
    // La fermeture vit dans le tour (`runTurn`), donc strictement avant le
    // `sleep` de la boucle. Écrit comme une contrainte d'ordre pour qu'un
    // refactor qui déplacerait la fermeture après l'attente casse ici.
    const runtime = executablePart('src/lib/autoreply/runtime.ts');
    expect(runtime.indexOf('rail.close()')).toBeLessThan(runtime.indexOf('await sleep(idlePollMs'));
  });
});

// ---------------------------------------------------------------------------
// F — l'éligibilité reste fail-closed
// ---------------------------------------------------------------------------

describe('F · sans preuve positive, pas de réponse autonome', () => {
  it('un dossier VIDE est refusé, et refusé sur la première preuve manquante', () => {
    const verdict = assessAutoReplyEligibility({
      inboundMessageId: 'x',
      receivedAt: null,
      frontierAt: null,
      correlationStatus: null,
      firstTouchManifestId: null,
      firstTouchOutreachEventId: null,
      firstTouchTransport: null,
      suppressed: true,
      outreachState: null,
      identityConfirmed: false,
      latestInboundId: null,
      latestInboundTies: 0,
      absorbedIntoBurst: false,
      analysisStatus: null,
      analysisPromptVersion: null,
      effectAttemptedOnTrigger: false,
    });
    expect(verdict.eligible).toBe(false);
    expect(verdict.eligible === false && verdict.refusal).toBe('RUNTIME_NOT_ACTIVATED');
  });

  it('la version de lecture exigée est celle que le dépôt PRODUIT aujourd’hui', () => {
    // Recopier la chaîne ici la ferait diverger au prochain bump. On vérifie
    // que la source lit la constante, pas un littéral.
    const eligibility = executablePart('src/lib/autoreply/eligibility.ts');
    expect(eligibility).toContain('REPLY_CLASSIFIER_PROMPT_VERSION');
    expect(eligibility).not.toContain(`'${REPLY_CLASSIFIER_PROMPT_VERSION}'`);
  });
});
