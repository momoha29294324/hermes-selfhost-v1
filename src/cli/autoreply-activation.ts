#!/usr/bin/env tsx
/**
 * HERMES-AUTO-REPLY-PRODUCTION-R1 §6 — la FRONTIÈRE d'activation, armée et
 * révoquée par un geste nommé.
 *
 *   npm run autoreply:activation                                  # lire, sans rien changer
 *   npm run autoreply:activation -- --activate --as "Prénom Nom" \
 *       --reason "<motif>" --max-effects 3
 *   npm run autoreply:activation -- --activate --as "…" --reason "…" --unbounded
 *   npm run autoreply:activation -- --revoke   --as "…" --reason "…"
 *
 * ---------------------------------------------------------------------------
 * Ce que cette commande ne sait PAS faire
 * ---------------------------------------------------------------------------
 *
 * 1. **Envoyer.** Elle n'importe aucun provider, aucun rail, aucune primitive
 *    d'envoi. Un test lit ses importations pour le vérifier.
 *
 * 2. **Lever l'arrêt global.** `setKillSwitch` n'est pas importé, et il n'y a
 *    aucune option pour cela. Armer le rail d'auto-réponse et lever l'arrêt
 *    d'urgence Instagram sont DEUX décisions, et elles se prennent séparément
 *    (`npm run ig:kill-switch -- --release --as "<nom>"`). Une commande qui
 *    ferait les deux d'un coup rendrait impossible d'en défaire une seule.
 *
 * 3. **Antidater la frontière.** Il n'existe ni `--frontier`, ni `--since`, ni
 *    variable d'environnement. La frontière est `now()`, écrite par la base,
 *    et la contrainte `hermes_autoreply_activation_frontier_not_backdated`
 *    refuserait toute valeur antérieure. C'est CE point qui garantit qu'allumer
 *    le rail ne répond jamais au retard historique.
 *
 * 4. **Réactiver par-dessus.** Une activation vivante fait échouer `--activate`.
 *    Réarmer demande de révoquer d'abord — donc de dire, dans un journal
 *    nominatif, qu'on recule la frontière.
 *
 * ---------------------------------------------------------------------------
 * Ce qu'une activation NE fait pas
 * ---------------------------------------------------------------------------
 * Elle n'autorise aucun envoi par elle-même : elle retire UNE raison de
 * refuser. L'arrêt global, les plafonds (10/j, 3/h), l'espacement de quinze
 * minutes, la fenêtre du lundi au vendredi de 9 h à 20 h, le verrou d'effet,
 * l'identité, l'exclusion, l'état commercial, la fraîcheur et les trois
 * versions restent tous devant, inchangés.
 */
import { getSql } from '@/lib/db';
import {
  activateAutoReply,
  assessRolloutBudget,
  countActivationEffects,
  listAutoReplyActivations,
  loadActiveAutoReplyActivation,
  revokeAutoReplyActivation,
  AutoReplyActivationError,
  type AutoReplyActivation,
} from '@/lib/autoreply/activation';
import type { Sql } from '@/lib/db/sql';

class ArgError extends Error {}

interface Args {
  readonly action: 'show' | 'activate' | 'revoke';
  readonly actor: string | null;
  readonly reason: string | null;
  readonly maxEffects: number | null;
  readonly unbounded: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let action: Args['action'] = 'show';
  let actor: string | null = null;
  let reason: string | null = null;
  let maxEffects: number | null = null;
  let unbounded = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const next = argv[i + 1];
    switch (arg) {
      case '--status':
      case '--show':
        action = 'show';
        break;
      case '--activate':
        action = 'activate';
        break;
      case '--revoke':
        action = 'revoke';
        break;
      case '--as':
        if (next === undefined || next.startsWith('--')) throw new ArgError('--as attend un nom d’opérateur');
        actor = next.trim();
        i += 1;
        break;
      case '--reason':
        if (next === undefined || next.startsWith('--')) throw new ArgError('--reason attend un motif écrit');
        reason = next.trim();
        i += 1;
        break;
      case '--max-effects': {
        const parsed = Number.parseInt(next ?? '', 10);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
          throw new ArgError('--max-effects attend un entier entre 1 et 100');
        }
        maxEffects = parsed;
        i += 1;
        break;
      }
      case '--unbounded':
        unbounded = true;
        break;
      default:
        throw new ArgError(
          `option inconnue : « ${arg} » — cette commande n'a ni --frontier, ni --since, ` +
            'et ne sait pas lever l’arrêt global',
        );
    }
  }

  if (action === 'activate') {
    if (maxEffects !== null && unbounded) {
      throw new ArgError('--max-effects et --unbounded sont exclusifs');
    }
    if (maxEffects === null && !unbounded) {
      // Aucun défaut. Un déploiement sans borne doit être ÉCRIT : c'est la
      // différence entre « je l'ai voulu » et « je ne savais pas qu'il y en
      // avait une ».
      throw new ArgError(
        'choisir explicitement une borne de déploiement : --max-effects <n> (recommandé pour un ' +
          'premier armement) ou --unbounded',
      );
    }
  }
  return { action, actor, reason, maxEffects, unbounded };
}

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const field = (label: string, value: string): void => {
  out(`  ${label.padEnd(28)} ${value}`);
};

async function describe(sql: Sql, activation: AutoReplyActivation | null): Promise<void> {
  out('');
  if (activation === null) {
    out('  AUTO_REPLY_ACTIVATION = NONE');
    field('conséquence', 'le runtime ne traite AUCUNE conversation — c’est l’état de repos du dépôt');
    return;
  }
  const effects = await countActivationEffects(sql, activation);
  const budget = assessRolloutBudget(activation, effects);
  out('  AUTO_REPLY_ACTIVATION = LIVE');
  field('id', activation.id);
  field('frontière', activation.frontierAt);
  field('armée le', activation.activatedAt);
  field('armée par', activation.activatedBy);
  field('motif', activation.reason);
  field('politique', `${activation.policyVersion} / ${activation.commercialPolicyVersion}`);
  field('budget de déploiement', activation.maxEffects === null ? 'aucun (--unbounded)' : String(activation.maxEffects));
  field('effets depuis la frontière', String(effects));
  field('budget', budget.open ? `OUVERT — ${budget.detail}` : `ÉPUISÉ — ${budget.detail}`);
  out('');
  out('  Une activation n’autorise aucun envoi : elle retire UNE raison de refuser.');
  out('  L’arrêt global, les plafonds, l’espacement, la fenêtre et les gardes de');
  out('  contenu restent tous devant, inchangés.');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sql = await getSql();

  try {
    out('');
    out('HERMES-AUTO-REPLY-PRODUCTION-R1 — frontière d’activation');

    if (args.action === 'show') {
      await describe(sql, await loadActiveAutoReplyActivation(sql));
      const history = await listAutoReplyActivations(sql, 5);
      if (history.length > 0) {
        out('');
        out('  Historique');
        for (const entry of history) {
          out(
            `   ${entry.activatedAt}  ${entry.revokedAt === null ? 'VIVANTE ' : 'révoquée'}  ` +
              `frontière ${entry.frontierAt}  par ${entry.activatedBy}`,
          );
        }
      }
      out('');
      return;
    }

    if (args.actor === null || args.actor.length === 0) {
      throw new ArgError('ce geste s’exerce au nom de quelqu’un : --as "<nom>"');
    }
    if (args.reason === null || args.reason.length === 0) {
      throw new ArgError('ce geste porte un motif écrit : --reason "<motif>"');
    }

    if (args.action === 'activate') {
      const activation = await activateAutoReply(sql, {
        activatedBy: args.actor,
        reason: args.reason,
        maxEffects: args.unbounded ? null : args.maxEffects,
      });
      out('');
      out('  ARMÉ.');
      await describe(sql, activation);
      out('');
      out('  Ce qui reste à faire pour qu’un message parte :');
      out('   1. l’arrêt global doit être levé (npm run ig:kill-switch -- --status) ;');
      out('   2. la relève entrante doit tourner (ig:inbound:run --loop) ;');
      out('   3. le runtime d’auto-réponse doit tourner (autoreply:worker --loop) ;');
      out('   4. les plafonds, la fenêtre et la cadence doivent passer.');
      out('');
      return;
    }

    const revoked = await revokeAutoReplyActivation(sql, {
      revokedBy: args.actor,
      reason: args.reason,
    });
    out('');
    if (revoked === null) {
      out('  RIEN À RÉVOQUER — aucune activation ne vivait.');
    } else {
      out('  RÉVOQUÉ.');
      field('id', revoked.id);
      field('frontière (close)', revoked.frontierAt);
      field('révoquée par', revoked.revokedBy ?? '—');
      field('motif', revoked.revokeReason ?? '—');
      out('');
      out('  Le runtime d’auto-réponse ne traitera plus aucune conversation.');
      out('  Les plans déjà inscrits ne sont ni effacés ni exécutés : le crochet');
      out('  pré-effet reste seul juge, et il n’est pas touché.');
    }
    out('');
  } finally {
    await sql.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error instanceof ArgError || error instanceof AutoReplyActivationError ? 1 : 2;
});
