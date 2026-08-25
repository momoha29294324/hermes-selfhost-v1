#!/usr/bin/env tsx
/**
 * HERMES-FIRST-TOUCH-BOUNDED-ACTIVATION-R1 — le budget DURABLE du rail de
 * premier contact, armé et révoqué par un geste nommé.
 *
 *   npm run ig:autonomous:activation                                  # lire, sans rien changer
 *   npm run ig:autonomous:activation -- --activate --as "Prénom Nom" \
 *       --reason "<motif>" --max-effects 3
 *   npm run ig:autonomous:activation -- --activate --as "…" --reason "…" --unbounded
 *   npm run ig:autonomous:activation -- --revoke   --as "…" --reason "…"
 *
 * ---------------------------------------------------------------------------
 * Ce que cette commande ne sait PAS faire
 * ---------------------------------------------------------------------------
 *
 * 1. **Envoyer.** Elle n'importe aucun provider, aucun rail, aucune primitive
 *    d'envoi, et n'ouvre aucun navigateur.
 *
 * 2. **Lever l'arrêt global.** `setKillSwitch` n'est pas importé et il n'y a
 *    aucune option pour cela. Armer le budget et lever l'arrêt d'urgence sont
 *    DEUX décisions.
 *
 * 3. **Antidater la frontière.** Il n'existe ni `--frontier`, ni `--since` :
 *    `frontier_at` vaut `now()`, écrit par la base, et la contrainte
 *    `frontier_not_backdated` refuserait la valeur qu'on lui passerait.
 *
 * 4. **Choisir « sans borne » à votre place.** `--max-effects` et
 *    `--unbounded` sont exclusifs, et l'un des deux est OBLIGATOIRE : un
 *    oubli d'option ne doit pas produire un rail illimité.
 *
 * Armer ne rend rien envoyable : cela retire UNE raison de refuser. Les
 * plafonds (10/jour, 3/heure), l'espacement de quinze minutes, la fenêtre,
 * l'arrêt global, l'éligibilité, l'idempotence et les contrôles de destination
 * restent tous devant, inchangés.
 */
import { getSql } from '@/lib/db';
import type { Sql } from '@/lib/db/sql';
import { AUTONOMOUS_POLICY_VERSION } from '@/lib/instagram/autonomousPolicy';
import {
  activateFirstTouch,
  assessFirstTouchBudget,
  countFirstTouchActivationEffects,
  listFirstTouchActivations,
  loadActiveFirstTouchActivation,
  revokeFirstTouchActivation,
  type FirstTouchActivation,
} from '@/lib/instagram/firstTouchActivation';

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
  if (action !== 'show') {
    if (actor === null) throw new ArgError('--as est obligatoire : une décision porte un nom');
    if (reason === null) throw new ArgError('--reason est obligatoire : une décision porte un motif');
  }
  return { action, actor, reason, maxEffects, unbounded };
}

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const field = (label: string, value: string): void => {
  out(`  ${label.padEnd(28)} ${value}`);
};

async function describe(sql: Sql, activation: FirstTouchActivation | null): Promise<void> {
  out('');
  out('HERMES-FIRST-TOUCH-BOUNDED-ACTIVATION-R1 — budget du premier contact');
  out('');
  if (activation === null) {
    field('FIRST_TOUCH_ACTIVATION', 'NONE');
    field('conséquence', 'le rail n’envoie aucun premier contact — c’est l’état de repos du dépôt');
    const history = await listFirstTouchActivations(sql, 3);
    if (history.length > 0) {
      out('');
      out('  Dernières activations révoquées :');
      for (const row of history) {
        out(`    ${row.activatedAt} · ${row.activatedBy} · révoquée ${row.revokedAt ?? '—'} (${row.revokeReason ?? '—'})`);
      }
    }
    out('');
    return;
  }

  const used = await countFirstTouchActivationEffects(sql, activation);
  const budget = assessFirstTouchBudget(activation, used);

  field('FIRST_TOUCH_ACTIVATION', 'YES');
  field('id', activation.id);
  field('frontière', activation.frontierAt);
  field('armée le', activation.activatedAt);
  field('armée par', activation.activatedBy);
  field('motif', activation.reason);
  field('politique', activation.policyVersion);
  field('budget de déploiement', activation.maxEffects === null ? 'SANS BORNE' : String(activation.maxEffects));
  field('effets depuis la frontière', String(used));
  field('budget', budget.open ? `OUVERT — ${budget.detail}` : `FERMÉ — ${budget.detail}`);
  out('');
  out('  Une activation n’autorise aucun envoi : elle retire UNE raison de refuser.');
  out('  L’arrêt global, les plafonds (10/j, 3/h), l’espacement de quinze minutes,');
  out('  la fenêtre, l’éligibilité, l’idempotence et les contrôles de destination');
  out('  restent tous devant, inchangés.');
  out('');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sql = await getSql();
  try {
    if (args.action === 'show') {
      await describe(sql, await loadActiveFirstTouchActivation(sql));
      return;
    }

    if (args.action === 'revoke') {
      const revoked = await revokeFirstTouchActivation(sql, {
        revokedBy: args.actor ?? '',
        reason: args.reason ?? '',
      });
      if (revoked === null) {
        out('\naucune activation vivante à révoquer — le rail était déjà au repos\n');
        process.exitCode = 1;
        return;
      }
      out(`\nactivation ${revoked.id} révoquée par ${revoked.revokedBy ?? '—'}\n`);
      await describe(sql, await loadActiveFirstTouchActivation(sql));
      return;
    }

    const existing = await loadActiveFirstTouchActivation(sql);
    if (existing !== null) {
      out('\nune activation vit déjà — la révoquer d’abord (--revoke) plutôt qu’en ouvrir une seconde\n');
      await describe(sql, existing);
      process.exitCode = 1;
      return;
    }

    const created = await activateFirstTouch(sql, {
      activatedBy: args.actor ?? '',
      reason: args.reason ?? '',
      policyVersion: AUTONOMOUS_POLICY_VERSION,
      maxEffects: args.unbounded ? null : args.maxEffects,
    });
    await describe(sql, created);
  } finally {
    await sql.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
