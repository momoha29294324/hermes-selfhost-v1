#!/usr/bin/env tsx
/**
 * R7-PILOT §1 — « ce commerce a-t-il déjà été contacté ? », en lecture seule.
 *
 *   npm run r6b:contact-history -- --prospect <uuid>
 *   npm run r6b:contact-history -- --prospect <uuid> --transport instagram_dm
 *
 * La question paraît triviale et ne l'était pas : jusqu'à cette mission, la
 * seule façon de la poser était `select count(*) from outreach_events where
 * prospect_id = …`, qui répond sur une LIGNE. Une entreprise redécouverte par
 * une nouvelle campagne obtient une ligne neuve, donc un compte à zéro, donc la
 * réponse « jamais contactée » — même si son compte Instagram a reçu un DM la
 * semaine précédente sous l'ancienne ligne.
 *
 * Cette commande interroge le COMMERCE : toutes les lignes qui partagent une
 * clé d'identité décisive (SIREN, domaine, identifiant de lieu, compte
 * Instagram, e-mail), toutes campagnes confondues.
 *
 * Elle n'écrit rien, ne fusionne rien, ne contacte personne.
 */
import { getSql } from '@/lib/db';
import {
  contactsOnChannel,
  contactsOnOtherChannels,
  describeLink,
  loadBusinessContactHistory,
} from '@/lib/pipeline/businessContactGuard';

interface Args {
  readonly prospectId: string;
  readonly transport: string;
}

function parseArgs(argv: readonly string[]): Args {
  let prospectId = '';
  let transport = 'instagram_dm';
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--prospect') prospectId = (argv[++i] ?? '').trim();
    else if (token === '--transport') transport = (argv[++i] ?? '').trim();
    else throw new Error(`option inconnue : « ${String(token)} »`);
  }
  if (prospectId.length === 0) throw new Error('--prospect <uuid> est obligatoire');
  return { prospectId, transport };
}

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(24)} ${value}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sql = await getSql();
  try {
    const history = await loadBusinessContactHistory(sql, args.prospectId);
    const self = history.group.members.find((member) => member.isSelf)!;

    process.stdout.write(`\nR7-PILOT — historique de contact du COMMERCE\n`);
    line('prospect', `${self.displayName} (${self.prospectId})`);
    line('campagne', self.campaignSlug ?? '—');
    line('verdict', history.verdict);
    line('transport interrogé', args.transport);
    line('clés d’identité', history.group.keys.map(describeLink).join(', ') || 'aucune');
    line('lignes du groupe', String(history.group.members.length));
    line('inter-campagnes', String(history.group.crossCampaign));

    if (history.group.siblings.length > 0) {
      process.stdout.write('\n Autres lignes du même commerce\n');
      for (const sibling of history.group.siblings) {
        line(
          sibling.campaignSlug ?? '—',
          `${sibling.displayName} (${sibling.prospectId}) — lié par ${sibling.linkedBy.map(describeLink).join(' + ')}`,
        );
      }
    }

    const same = contactsOnChannel(history, args.transport);
    const other = contactsOnOtherChannels(history, args.transport);
    process.stdout.write(`\n Contacts sur ${args.transport} (bloquants)\n`);
    if (same.length === 0) line('—', 'aucun');
    for (const contact of same) {
      line(contact.status, `${contact.occurredAt} · ${contact.source} ${contact.reference} · self=${String(contact.isSelf)}`);
    }

    process.stdout.write('\n Contacts sur un autre canal (visibles, non bloquants)\n');
    if (other.length === 0) line('—', 'aucun');
    for (const contact of other) {
      line(`${contact.channel}/${contact.status}`, `${contact.occurredAt} · ${contact.source} · self=${String(contact.isSelf)}`);
    }

    if (history.suppressions.length > 0) {
      process.stdout.write('\n do_not_contact\n');
      for (const suppression of history.suppressions) {
        line(suppression.matchKind, `${suppression.value} — ${suppression.reason} · self=${String(suppression.isSelf)}`);
      }
    }

    if (history.activeIntents.length > 0) {
      process.stdout.write('\n Intentions encore actives\n');
      for (const intent of history.activeIntents) {
        line(intent.status, `job ${intent.jobId} · manifeste ${intent.manifestId} · self=${String(intent.isSelf)}`);
      }
    }

    process.stdout.write('\nLecture seule : rien n’a été écrit, fusionné ni envoyé.\n\n');
  } finally {
    await sql.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
