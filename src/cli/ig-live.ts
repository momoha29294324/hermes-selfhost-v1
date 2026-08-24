#!/usr/bin/env tsx
/**
 * IG2 §6/§7/§9 — l'aperçu, puis le canari, puis le réarmement.
 *
 *   npm run ig:live -- --manifest-id <uuid> --preview
 *   npm run ig:live -- --manifest-id <uuid> --live --as "Prénom Nom"
 *
 * Trois propriétés de cette commande, toutes voulues :
 *
 * 1. **`--manifest-id` est obligatoire, toujours.** Il n'existe ni `--all`, ni
 *    `--batch`, ni `--prospect`, ni « traiter la file ». Le parseur refuse tout
 *    ce qu'il ne connaît pas, donc une option d'envoi en masse ne peut pas être
 *    ajoutée par inadvertance à l'usage : il faudrait l'écrire ici, dans un
 *    diff relu.
 *
 * 2. **`--live` ne suffit pas.** Il dit l'intention ; l'autorisation vit en base
 *    (`ig:canary --arm`), l'arrêt global doit être levé, et les gardes du §5
 *    sont revalidées dans le worker. Cette commande ne peut pas s'auto-armer.
 *
 * 3. **Le `finally` réarme.** Quelle que soit l'issue — envoyé, ambigu, refusé,
 *    planté — l'arrêt global est réengagé et l'autorisation encore armée est
 *    révoquée avant la sortie. Une session qui se termine laisse le rail fermé,
 *    jamais ouvert « parce que ça s'est bien passé ».
 */
import { resolve } from 'node:path';
import { hostname } from 'node:os';
import { getSql } from '@/lib/db';
import { loadInstagramRail } from '@/lib/config/load';
import { PlaywrightInstagramLiveRail } from '@/lib/instagram/playwrightLiveRail';
import { runInstagramLiveCanary, type LiveCanaryResult } from '@/lib/instagram/liveWorker';
import { listCanaryAuthorizations, revokeCanaryAuthorization } from '@/lib/instagram/canary';
import { loadKillSwitch, setKillSwitch } from '@/lib/instagram/safety';
import { reportRefusalTrace } from '@/lib/instagram/refusalTrace';

const SCREENSHOT_DIR = 'var/instagram/screenshots';
const REFUSAL_TRACE_DIR = 'var/instagram/refusal-traces';

interface Args {
  manifestId: string;
  live: boolean;
  preview: boolean;
  headed: boolean;
  as: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { manifestId: '', live: false, preview: false, headed: false, as: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case '--manifest-id':
        if (args.manifestId !== '') throw new Error('--manifest-id ne peut être donné qu’une fois — un canari, une cible');
        args.manifestId = argv[++i] ?? '';
        break;
      case '--live':
        args.live = true;
        break;
      case '--preview':
        args.preview = true;
        break;
      case '--headed':
        args.headed = true;
        break;
      case '--as':
        args.as = argv[++i] ?? '';
        break;
      default:
        throw new Error(
          `option inconnue : « ${String(token)} » — cette commande n'a ni --all, ni --batch, ni --prospect, ni --send-all`,
        );
    }
  }
  if (args.manifestId.trim() === '') throw new Error('--manifest-id est obligatoire');
  if (args.live === args.preview) throw new Error('choisir exactement un mode : --preview ou --live');
  if (args.live && (args.as ?? '').trim() === '') {
    throw new Error('--live exige --as « Prénom Nom » — un envoi réel se fait au nom de quelqu’un');
  }
  return args;
}

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(26)} ${value}\n`);
}

function report(result: LiveCanaryResult): void {
  process.stdout.write(`\nIG2 — ${result.status}\n`);
  line('reason_code', result.reasonCode);
  line('detail', result.detail);
  line('manifest_id', result.manifestId);
  line('job_id', result.jobId ?? '—');
  line('prospect_id', result.prospectId ?? '—');
  line('expected_handle', result.expectedHandle ?? '—');
  line('observed_handle', result.observedHandle ?? '—');
  line('identity_verdict', result.identityVerdict ?? '—');
  line('session_state', result.sessionState ?? '—');
  line('live_ready', result.liveReady === null ? '—' : String(result.liveReady));
  line('approved_text_sha256', result.approvedTextSha256 ?? '—');
  line('payload_sha256', result.transportPayloadSha256 ?? '—');
  if (result.approvedText !== null) line('message', JSON.stringify(result.approvedText));
  if (result.canary !== null) {
    line('canary_id', result.canary.id);
    line('canary_state', result.canary.state);
    line('canary_armed_by', result.canary.armedBy);
    line('canary_expires_at', result.canary.expiresAt);
    line('canary_attempts', `${result.canary.externalAttemptsUsed}/${result.canary.maxExternalAttempts}`);
  } else {
    line('canary', 'aucune autorisation');
  }
  line('external_attempts', String(result.externalAttempts));
  line('external_effect_attempted', String(result.externalEffectAttempted));
  if (result.observation !== null) {
    const o = result.observation;
    line('thread_url', o.threadUrl ?? '—');
    line('thread_handle', o.threadHandle ?? '—');
    line('bubbles_before→after', `${o.matchingBubblesBefore} → ${o.matchingBubblesAfter}`);
    line('composer_cleared', String(o.composerCleared));
    line('outgoing_confirmed', String(o.outgoingBubbleConfirmed));
  }
  line('outreach_event_id', result.outreachEventId ?? '—');
  line('outreach_state', result.outreachState ?? '—');
  line('event_id', result.eventId ?? '—');
  if (result.screenshotPath !== null) line('screenshot', result.screenshotPath);
  line('duration_ms', String(result.durationMs));
  process.stdout.write(`  gates                      ${result.gates.map((g) => `${g.gate}=${g.verdict}`).join(' ')}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadInstagramRail();
  const sql = await getSql();
  const workerId = `${hostname()}/pid-${process.pid}`;
  const operator = (args.as ?? 'ig:live').trim();

  try {
    const rail = new PlaywrightInstagramLiveRail({
      config,
      headless: args.headed ? false : config.session.headless,
      screenshotDir: resolve(process.cwd(), SCREENSHOT_DIR),
      workerId,
    });

    let result: LiveCanaryResult | null = null;
    let failure: unknown = null;
    try {
      result = await runInstagramLiveCanary(
        {
          sql,
          config,
          workerId,
          mode: 'LIVE',
          manifestId: args.manifestId,
          action: 'first_touch_dm',
          previewOnly: args.preview,
        },
        { rail },
      );
      report(result);
      process.stdout.write(`  clics_navigateur           ${rail.clickCount}\n`);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      // IG2.6 — la trace des refus de NOTRE garde, avant toute autre
      // finalisation et quelle que soit l'issue. Elle ne lève pas : ce qui suit
      // réengage l'arrêt global et ne doit dépendre d'aucun diagnostic.
      try {
        reportRefusalTrace(
          (chunk) => process.stdout.write(chunk),
          resolve(process.cwd(), REFUSAL_TRACE_DIR),
          {
            mode: args.preview ? 'preview' : 'live',
            subject: args.manifestId,
            workerId,
            outcome:
              failure !== null
                ? failure instanceof Error
                  ? `THROWN:${failure.name}`
                  : 'THROWN:unknown'
                : (result?.status ?? 'NO_RESULT'),
          },
          rail.refusalSnapshot(),
        );
      } catch {
        /* Une trace manquée ne doit pas empêcher le réarmement. */
      }

      // §9 — la finalisation obligatoire, dans un `finally` : elle a lieu même
      // si le worker a levé, même sur Ctrl-C pendant l'attente, même si le
      // rapport n'a jamais été affiché.
      //
      // La révocation ne concerne QUE le chemin `--live`. Un aperçu est une
      // vérification qui précède l'envoi (§6 avant §7) ; s'il révoquait,
      // vérifier rendrait l'envoi impossible — et impossible pour toujours,
      // puisqu'un manifeste ne porte qu'une autorisation dans son histoire.
      const revoked = args.live ? await revokeStillArmed(sql, operator) : 0;
      const engaged = await reengageKillSwitch(sql, operator, args.preview);
      process.stdout.write('\nIG2 — finalisation\n');
      line('canary_révoquées', args.live ? String(revoked) : '— (aperçu : rien à révoquer)');
      line('kill_switch_engaged', String(engaged));
      process.stdout.write('\n');
    }

    if (result.status === 'SENT') process.exitCode = 0;
    else if (result.status === 'PREVIEWED') process.exitCode = 0;
    else if (result.status === 'AMBIGUOUS') process.exitCode = 3;
    else process.exitCode = 2;
  } finally {
    await sql.close();
  }
}

/**
 * Referme l'autorisation encore armée, s'il en reste une.
 *
 * Un canari consommé n'a pas besoin de ceci (son état est déjà terminal) ; un
 * canari refusé par une garde, si — sinon il resterait ouvert après la sortie
 * du processus, et le prochain lancement partirait sans qu'un humain ait rien
 * redécidé.
 */
async function revokeStillArmed(sql: Awaited<ReturnType<typeof getSql>>, operator: string): Promise<number> {
  const all = await listCanaryAuthorizations(sql).catch(() => []);
  let count = 0;
  for (const auth of all) {
    if (auth.state !== 'ARMED') continue;
    const revoked = await revokeCanaryAuthorization(sql, {
      id: auth.id,
      revokedBy: operator,
      reason: 'fin de session canari — une autorisation ne survit pas à la commande qui l’a utilisée',
    }).catch(() => null);
    if (revoked !== null) count += 1;
  }
  return count;
}

/** Réengage l'arrêt global et RELIT la base pour le confirmer — jamais l'affirmer. */
async function reengageKillSwitch(
  sql: Awaited<ReturnType<typeof getSql>>,
  operator: string,
  preview: boolean,
): Promise<boolean> {
  await setKillSwitch(sql, {
    engaged: true,
    setBy: operator,
    reason: preview ? 'fin d’aperçu IG2 — retour au défaut « ne rien envoyer »' : 'fin du canari IG2 — retour au défaut « ne rien envoyer »',
  }).catch(() => undefined);
  const state = await loadKillSwitch(sql).catch(() => null);
  return state?.engaged ?? false;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
