#!/usr/bin/env tsx
/**
 * HERMES-REAL-THREAD-PREVIEW-R1 §2/§14/§17 — inspecter un VRAI fil Instagram,
 * en lecture seule, sans qu'aucun plan ne soit éligible.
 *
 *   npm run conversation:inspect -- --as "<nom>" --inbound  <uuid>
 *   npm run conversation:inspect -- --as "<nom>" --prospect <uuid>
 *   npm run conversation:inspect -- --as "<nom>" --thread   <id>
 *
 * ---------------------------------------------------------------------------
 * Ce que cette commande NE PEUT PAS faire, et par quoi
 * ---------------------------------------------------------------------------
 *   * **envoyer** — elle n'instancie que `PlaywrightInstagramThreadInspectionRail`,
 *     qui ne porte pas `sendThreadReply` et dont le fichier ne contient ni
 *     `click`, ni `fill`, ni `type`, ni `press`. Il n'existe aucune option, ni
 *     aucune variable d'environnement, qui la fasse écrire dans une page ;
 *   * **écrire en base** — la connexion est enveloppée par `readOnlySql` :
 *     `exec` et `transaction` lèvent, et toute requête passe par
 *     `assertReadOnlyStatement`. Aucun plan, aucun effet, aucune réservation ;
 *   * **rendre une conversation éligible** — elle ne lit aucune décision, ne
 *     touche ni `hermes_conversation_plans` ni `hermes_conversation_effects`,
 *     et un fil terminalement clos s'inspecte comme un autre. C'est même le cas
 *     nominal : au 22 août 2026, les deux seules conversations réelles du
 *     corpus sont closes, et ce sont elles qu'il faut ouvrir pour éprouver le
 *     ciblage AVANT qu'un canari soit concevable.
 *
 * ---------------------------------------------------------------------------
 * §14 — l'arrêt global n'est pas relâché, et n'a pas à l'être
 * ---------------------------------------------------------------------------
 * Il est LU et affiché, jamais exigé dans un sens ou dans l'autre : cette
 * commande ne produit aucun effet, donc rien ne dépend de lui. Elle n'importe
 * pas `setKillSwitch` — elle ne sait pas le lever, et un test le vérifie sur le
 * source. C'est exactement la séparation que la mission demande : un aperçu
 * read-only ne doit pas avoir besoin qu'on désarme quoi que ce soit.
 *
 * ---------------------------------------------------------------------------
 * §3/§15 — le profil, et l'autre runtime
 * ---------------------------------------------------------------------------
 * Aucun second verrou : le rail prend le bail de profil existant
 * (`browserProfileLease`) dans `open()`, et le rend dans `close()`. Si un
 * worker le tient, la commande sort en `IG_BROWSER_PROFILE_BUSY` sans ouvrir
 * de navigateur et sans rien tuer.
 */
import { resolve } from 'node:path';
import { loadInstagramRail } from '@/lib/config/load';
import { canonicalAccountIdentity, knownAccountHandles } from '@/lib/instagram/accountIdentity';
import {
  resolveInspectionTarget,
  type InspectionSelector,
} from '@/lib/conversation/inspectionTarget';
import { getSql } from '@/lib/db';
import { readOnlySql } from '@/lib/db/readOnlySql';
import { InstagramBrowserProfileBusyError } from '@/lib/instagram/browserProfileLease';
import { PlaywrightInstagramThreadInspectionRail } from '@/lib/instagram/playwrightThreadInspectionRail';
import { loadKillSwitch } from '@/lib/instagram/safety';
import type { ThreadInspection } from '@/lib/instagram/threadInspectionRail';

/** Les captures vivent sous `var/`, hors Git : une capture d'une session authentifiée
 *  montre un compte connecté et n'a rien à faire dans un dépôt. */
const SCREENSHOT_DIR = 'var/instagram/screenshots';

class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgError';
  }
}

interface Args {
  readonly selector: InspectionSelector;
  readonly operator: string;
  readonly headless: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const selectors: InspectionSelector[] = [];
  let operator: string | null = null;
  let headless = true;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const next = argv[i + 1];
    const value = (label: string): string => {
      if (next === undefined || next.startsWith('--')) throw new ArgError(`${label} attend une valeur`);
      i += 1;
      return next.trim();
    };
    if (arg === '--inbound') {
      selectors.push({ kind: 'inbound', inboundMessageId: value('--inbound') });
      continue;
    }
    if (arg === '--prospect') {
      selectors.push({ kind: 'prospect', prospectId: value('--prospect') });
      continue;
    }
    if (arg === '--thread') {
      selectors.push({ kind: 'thread', threadId: value('--thread') });
      continue;
    }
    if (arg === '--as') {
      operator = value('--as');
      continue;
    }
    if (arg === '--headed') {
      headless = false;
      continue;
    }
    throw new ArgError(`option inconnue : ${arg}`);
  }

  const selector = selectors[0];
  if (selector === undefined || selectors.length > 1) {
    throw new ArgError('une désignation et une seule : --inbound <uuid>, --prospect <uuid> ou --thread <id>');
  }
  if (operator === null || operator.length === 0) {
    throw new ArgError('ouvrir un navigateur sur la session Instagram demande un opérateur nommé : --as "<nom>"');
  }
  return { selector, operator, headless };
}

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

function render(inspection: ThreadInspection): void {
  const t = inspection.target;
  out('');
  out(`  fil demandé            ${t.expectedThreadId}`);
  out(`  compte émetteur        ${t.expectedAccountHandle}`);
  out(`  correspondant attendu  ${t.expectedHandle}`);
  out(`  état de session        ${inspection.sessionState}`);
  out('');
  out(`  account_identity       ${inspection.account.outcome}`);
  out(`    libellés lus         ${inspection.account.labels.length === 0 ? 'aucun' : inspection.account.labels.join(' | ')}`);
  out(`    └─ ${inspection.account.detail}`);
  out('');
  out(`  requested_thread_id    ${inspection.navigation.requestedThreadId}`);
  out(`  landed_url             ${inspection.navigation.landedUrl ?? '—'}`);
  out(`  thread_id_from_url     ${inspection.navigation.threadIdFromUrl ?? '—'}`);
  out(`  match                  ${inspection.navigation.match ? 'YES' : 'NO'}`);
  out(`  url_rewritten          ${inspection.navigation.rewritten ? 'YES' : 'no'}`);
  out('');
  out(`  thread_identity        THREAD_IDENTITY_${inspection.threadIdentity.outcome}`);
  out(`    via                  ${inspection.threadIdentity.via ?? '—'}`);
  out(
    `    panneau              trouvé=${String(inspection.threadIdentity.panelFound)} ` +
      `ambigu=${String(inspection.threadIdentity.panelAmbiguous)} ` +
      `en-tête=${String(inspection.threadIdentity.headerFound)}`,
  );
  out(
    `    en-tête              handles=${String(inspection.threadIdentity.headerHandleCount)} ` +
      `textes=${String(inspection.threadIdentity.headerTextCount)} ` +
      `libellé=${String(inspection.threadIdentity.panelLabelPresent)} ` +
      `handles hors en-tête=${String(inspection.threadIdentity.bodyHandleCount)}`,
  );
  out(`    nom d’affichage      ${inspection.threadIdentity.expectedDisplayNameResolved ? 'établi' : 'non établi'}`);
  out(`    └─ ${inspection.threadIdentity.detail}`);
  if (inspection.threadIdentity.ancestorChain.length > 0) {
    // §6 — la structure RÉELLE de la page, telle qu'elle est. Aucun contenu de
    // conversation : des tags, des rôles, des libellés accessibles bornés et
    // des rectangles.
    out('    chaîne d’ancêtres du composeur :');
    for (const level of inspection.threadIdentity.ancestorChain) out(`      ${level}`);
  }
  out('');
  out(`  history_detected       ${inspection.history.verdict === 'HAS_HISTORY' ? 'YES' : 'NO'}`);
  out(
    `    verdict              ${inspection.history.verdict} · ` +
      `${String(inspection.history.textNodes)} élément(s) · ` +
      `récolte ${inspection.history.harvestReadable ? 'lisible' : 'ILLISIBLE'}` +
      `${inspection.history.harvestTruncated ? ' (TRONQUÉE)' : ''}`,
  );
  out('');
  out(`  composer_found         ${inspection.composer.found ? 'YES' : 'NO'}`);
  out(`  composer_enabled       ${inspection.composer.enabled ? 'YES' : 'NO'}`);
  out(`    └─ ${inspection.composer.detail}`);
  out('');
  out(`  watermark (base)       ${inspection.latestMessage.watermark ?? '—'}`);
  out(
    `  latest_msg_consistent  ${
      inspection.latestMessage.matched === null ? 'INDÉTERMINÉ' : inspection.latestMessage.matched ? 'YES' : 'NO'
    }`,
  );
  out(`    └─ ${inspection.latestMessage.detail}`);
  out('');
  out(`  targeting_compatible   ${inspection.targetingCompatible ? 'YES' : 'NO'}`);
  out(`  blocked_by             ${inspection.blockedBy ?? '—'}`);
  out(`  external_effect        ${inspection.externalEffect ? 'OUI' : 'NON'}`);
  out(`  capture                ${inspection.screenshotPath ?? '—'}`);
  out(`  durée                  ${String(inspection.durationMs)} ms`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadInstagramRail();
  const workerId = `conversation-inspect/${args.operator}`;

  // L'identité canonique de NOTRE compte, la même que celle de l'envoi. Une
  // configuration illisible arrête ici : inspecter sous un compte deviné
  // rapporterait un ciblage que personne n'exercerait.
  const identity = canonicalAccountIdentity({
    accountHandle: config.inbound.accountHandle ?? '',
    formerAccountHandles: config.inbound.formerAccountHandles,
  });
  if (!identity.ok) {
    process.stderr.write(`[${identity.refusal}] ${identity.detail}\n`);
    process.exitCode = 1;
    return;
  }

  const live = await getSql();
  const sql = readOnlySql(live, 'conversation:inspect');
  const rail = new PlaywrightInstagramThreadInspectionRail({
    config,
    workerId,
    headless: args.headless,
    screenshotDir: resolve(process.cwd(), SCREENSHOT_DIR),
  });

  try {
    const killSwitch = await loadKillSwitch(sql);
    out('');
    out('HERMES-REAL-THREAD-PREVIEW-R1 — INSPECTION read-only d’un fil réel');
    out(`  opérateur      ${args.operator}`);
    out(`  arrêt global   ${killSwitch.engaged ? 'ARMÉ' : 'désengagé'}  (sans effet ici : rien ne peut partir)`);
    out(`  base           LECTURE SEULE (exec et transaction refusés)`);
    out(`  rail           ${PlaywrightInstagramThreadInspectionRail.name} — aucune primitive d’envoi`);
    out(`  compte courant ${identity.identity.currentHandle}`);
    out(
      `  identités      ${knownAccountHandles(identity.identity).join(', ')}  ` +
        '(courante d’abord ; les autres sont des noms passés du MÊME compte)',
    );

    const resolution = await resolveInspectionTarget(sql, args.selector, identity.identity);
    if (!resolution.ok) {
      out('');
      out(`  cible          REFUSÉE [${resolution.refusal}]`);
      out(`  détail         ${resolution.detail}`);
      out('');
      process.exitCode = 1;
      return;
    }

    const inspection = await rail.inspectThread(resolution.target.input);
    render(inspection);

    const refused = rail.refusalSnapshot();
    out(`  requêtes refusées par notre garde réseau : ${String(refused.records.length)}`);
    out('');
  } catch (error) {
    if (error instanceof InstagramBrowserProfileBusyError) {
      out('');
      out(`  IG_BROWSER_PROFILE_BUSY — ${error.message}`);
      out('  aucun navigateur ouvert, aucun processus tué : réessayer plus tard.');
      out('');
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    await rail.close();
    await sql.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
