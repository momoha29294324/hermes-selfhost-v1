#!/usr/bin/env tsx
/**
 * R6B-D2.1 §11 — l'état de la configuration CRM.
 *
 *   npm run r6b:crm:status
 *
 * Lecture seule, sans réseau : aucune requête n'est envoyée au fournisseur, et
 * aucun modèle n'est construit. La commande répond donc la même chose que le
 * CRM soit joignable ou non — c'est précisément quand il ne l'est pas qu'on a
 * besoin de savoir ce qui est configuré.
 *
 * Aucune valeur secrète n'est affichée. La clé d'API n'apparaît que sous forme
 * de « présente / ABSENTE ». Le `location_id`, lui, est affiché en clair, et
 * c'est voulu : c'est la seule ligne qui permette à un humain de vérifier d'un
 * coup d'œil qu'on ne s'apprête pas à écrire dans le sous-compte d'un autre
 * projet.
 */
import { getSql } from '@/lib/db';
import { CRM_ENV_KEYS } from '@/lib/crm/ghl';
import { resolveCrmDestination } from '@/lib/crm/resolve';
import { loadCrmStatus, type CrmStatus } from '@/lib/crm/status';
import { CRM_PIPELINE_PLAN } from '@/lib/crm/payload';
import { CRM_FIELD_KEYS } from '@/lib/crm/verify';
import { CRM_MAPPABLE_FIELDS, type CrmMappableField } from '@/lib/crm/types';
import { OUTREACH_STATES } from '@/lib/replies/taxonomy';

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(28)} ${value}\n`);
}

function printSetupPlan(): void {
  process.stdout.write('\n  CE QU’IL MANQUE POUR PROJETER\n');
  process.stdout.write(`    1. créer (ou désigner) un sous-compte ${'GoHighLevel'} qui appartient à Hermes\n`);
  process.stdout.write('    2. y créer un pipeline portant ces étapes, dans cet ordre :\n');
  for (const stage of CRM_PIPELINE_PLAN) process.stdout.write(`         - ${stage}\n`);
  process.stdout.write('    3. renseigner localement (jamais dans Git) :\n');
  for (const [role, key] of Object.entries(CRM_ENV_KEYS)) {
    process.stdout.write(`         ${key.padEnd(28)} ${role}\n`);
  }
  process.stdout.write('    4. npm run r6b:crm:verify            (lecture seule, n’écrit rien chez le fournisseur)\n');
  process.stdout.write('    5. npm run r6b:crm:verify -- --confirm --as "<votre nom>"\n');
  process.stdout.write('    6. npm run r6b:crm:sync              (plan) puis -- --apply\n');
  process.stdout.write('\n    Champs personnalisés facultatifs (leur absence n’empêche rien : les valeurs\n');
  process.stdout.write('    voyagent alors dans la note) :\n');
  for (const field of CRM_MAPPABLE_FIELDS) {
    process.stdout.write(`         ${CRM_FIELD_KEYS[field].padEnd(30)} ${field}\n`);
  }
}

function printStatus(status: CrmStatus): void {
  process.stdout.write('\nR6B-D2.1 — CONFIGURATION CRM (lecture seule, aucun envoi)\n');
  line('fournisseur', status.providerName ?? '— (aucun)');
  line('sous-compte (env)', status.envLocationId ?? '— (aucun)');
  line('clé d’API', status.apiKeyPresent ? 'présente' : 'ABSENTE');
  line('projection possible', status.resolution.configured ? 'OUI' : 'NON');
  if (!status.resolution.configured) {
    line('raison', status.resolution.kind);
    process.stdout.write(`\n  ${status.resolution.reason}\n`);
  } else {
    const target = status.resolution.target;
    line('destination', `${target.destination.locationName ?? '?'} (${target.destination.locationId})`);
    line('pipeline', `${target.destination.pipelineName ?? '?'} (${target.pipelineId})`);
  }

  process.stdout.write(`\n  DESTINATIONS CONNUES : ${status.destinations.length}\n`);
  for (const view of status.destinations) {
    const destination = view.destination;
    process.stdout.write(
      `\n  ── ${destination.locationName ?? '(nom inconnu)'} — ${destination.status}` +
        `${view.matchesEnvironment ? ' — désignée par l’environnement' : ''}\n`,
    );
    line('    fournisseur', destination.provider);
    line('    location_id', destination.locationId);
    line(
      '    pipeline',
      destination.pipelineId === null ? '—' : `${destination.pipelineName ?? '?'} (${destination.pipelineId})`,
    );
    line(
      '    confirmée par',
      destination.confirmedBy === null ? '—' : `${destination.confirmedBy} le ${destination.confirmedAt}`,
    );
    line('    contacts liés', String(view.linkedContacts));
    line('    étapes observées', view.stages.length === 0 ? '—' : String(view.stages.length));

    process.stdout.write('    correspondance état → étape :\n');
    for (const state of OUTREACH_STATES) {
      if (state === 'REVIEW_REQUIRED') {
        process.stdout.write(`      ${state.padEnd(16)} → (aucune, par conception — §6)\n`);
        continue;
      }
      const stage = view.stageMap[state];
      process.stdout.write(
        `      ${state.padEnd(16)} → ${stage === undefined ? 'NON CARTOGRAPHIÉ' : `${stage.stageName} [${stage.stageId}]`}\n`,
      );
    }

    const mapped = Object.keys(destination.fieldMap) as CrmMappableField[];
    line(
      '    champs personnalisés',
      mapped.length === 0 ? 'aucun (les valeurs voyagent dans la note)' : mapped.join(', '),
    );
  }

  process.stdout.write('\n  PROJECTIONS\n');
  for (const [status_, count] of Object.entries(status.projections)) {
    line(`    ${status_}`, String(count));
  }
  line('  notes déposées', String(status.notes));
  line('  alertes ouvertes', String(status.alertsPending));

  if (!status.resolution.configured) printSetupPlan();

  process.stdout.write(
    '\n  Cette commande n’écrit rien, n’envoie rien et n’appelle aucun fournisseur.\n' +
      '  Avant toute confirmation : vérifier que le location_id ci-dessus appartient bien à\n' +
      '  Hermes. la documentation d’installation interdit d’écrire dans le CRM d’un autre projet.\n\n',
  );
}

async function main(): Promise<void> {
  if (process.argv.length > 2) {
    process.stderr.write('\nr6b:crm:status n’attend aucune option.\n\n');
    process.exitCode = 1;
    return;
  }

  const sql = await getSql();
  try {
    const resolution = await resolveCrmDestination(sql);
    printStatus(await loadCrmStatus(sql, resolution));
  } finally {
    await sql.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
