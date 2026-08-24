#!/usr/bin/env tsx
/**
 * Zero-cost confidence check for the Google Places rail.
 *
 *   npm run places:probe
 *   npm run places:probe -- --campaign example-campaign
 *   npm run places:probe -- --query "atelier automobile"
 *
 * What it does, and nothing else: ONE Text Search restricted to place IDs, on
 * one tile of the campaign's geography. That mask is billed at the Text Search
 * "IDs Only" SKU — no charge, no monthly ceiling — so the check that tells
 * un opérateur his key works cannot itself cost anything.
 *
 * What it never does:
 *   - it writes no prospect and no place candidate. The only row it can create
 *     is the `google_places_usage` ledger line for its own call, which is the
 *     point of having a ledger: an unrecorded call is an uncountable call.
 *   - it never prints the API key, and never logs a Places response body.
 *     A Places payload is Google Maps Content, and a log file is storage.
 *
 * See la documentation d’installation — section 8 is the activation procedure this
 * command closes.
 */
import { getSql } from '@/lib/db';
import { migrate } from '@/lib/db/migrate';
import { loadCampaign, loadNiche } from '@/lib/config/load';
import { createLogger } from '@/lib/logging/logger';
import { envBool } from '@/lib/env';
import { HttpClient, HttpError } from '@/lib/http/client';
import { PLACES_MASKS } from '@/lib/discovery/places/fieldMask';
import { PlacesBudget, PlacesBudgetExceededError } from '@/lib/discovery/places/budget';
import { PlacesClient, placesAvailability } from '@/lib/discovery/places/client';
import { searchAreasFor } from '@/lib/discovery/places/railA';
import type { Sql } from '@/lib/db/sql';

function arg(name: string, fallback: string | null = null): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  return process.argv[index + 1] ?? fallback;
}

interface LedgerLine {
  sku_tier: string;
  field_mask: string;
  billable: boolean;
  results_count: number;
  http_status: number | null;
  error: string | null;
}

async function ledgerCount(sql: Sql): Promise<number> {
  const rows = await sql.query<{ count: string }>('select count(*)::text as count from google_places_usage');
  return Number.parseInt(rows[0]?.count ?? '0', 10) || 0;
}

/** The last line written, read back rather than assumed — the ledger is the truth. */
async function lastLedgerLine(sql: Sql): Promise<LedgerLine | null> {
  const rows = await sql.query<LedgerLine>(
    `select sku_tier, field_mask, billable, results_count, http_status, error
       from google_places_usage order by occurred_at desc, id desc limit 1`,
  );
  return rows[0] ?? null;
}

function fail(lines: string[]): void {
  for (const line of lines) process.stdout.write(`${line}\n`);
  process.stdout.write('\nRÉSULTAT : ÉCHEC\n');
  process.exitCode = 1;
}

async function main(): Promise<void> {
  if (envBool('OUTBOUND_ALLOW_SENDING', false)) {
    throw new Error(
      'OUTBOUND_ALLOW_SENDING must stay 0 in V1: this build has no sending code and must not pretend to.',
    );
  }

  const slug = arg('campaign', 'example-campaign') as string;
  const campaign = loadCampaign(slug);
  const niche = loadNiche(campaign.niche);

  process.stdout.write('\nSonde Google Places — appel de contrôle au palier gratuit\n');
  process.stdout.write('═'.repeat(78) + '\n');
  process.stdout.write(`Campagne .......................... ${campaign.name} (${slug})\n`);
  process.stdout.write(`Niche ............................. ${campaign.niche}\n`);

  // ------------------------------------------------------------ disponibilité
  const availability = placesAvailability();
  process.stdout.write(`Rail Places activable ............. ${availability.ok ? 'oui' : 'non'}\n`);
  if (!availability.ok) {
    fail([
      '',
      `Raison : ${availability.reason ?? 'indisponible'}`,
      '',
      'Marche à suivre :',
      '  1. Trancher la question d’usage du §2 — c’est une décision, pas un réglage.',
      '     La facturation Hermes est française : la liste blanche EEE de neuf',
      '     usages permis s’applique, et le nôtre n’y figure pas de façon certaine.',
      '  2. Google Cloud → projet dédié, activer uniquement « Places API (New) ».',
      '  3. Créer une clé API serveur, restreinte à Places API (New).',
      '  4. Dans .env (ignoré par Git) :',
      '       OUTBOUND_GOOGLE_PLACES_KEY=...',
      '       GOOGLE_PLACES_ENABLED=1',
      '       GOOGLE_PLACES_EEA_PERMITTED_USE=<un des neuf usages, cf. §2>',
      '  5. Relancer : npm run places:probe',
      '',
      'Aucun appel n’a été émis, aucune ligne de registre écrite, rien en base.',
    ]);
    return;
  }

  // La clé existe : on le dit, on ne la montre jamais.
  process.stdout.write('Clé présente ...................... oui\n');

  // ------------------------------------------------------------------- cadrage
  const tileRadiusKm = campaign.discovery.places.tileRadiusKm;
  const areas = searchAreasFor(campaign, tileRadiusKm);
  const area = areas[0];
  if (!area) {
    fail([
      '',
      `Raison : la géographie « ${campaign.geography.mode} » n’est pas balayable par Places.`,
      'Le rail commercial ne s’applique qu’aux campagnes en mode radius ou cities ;',
      'les autres géographies passent par le rail registre (long tail).',
      '',
      'Aucun appel n’a été émis.',
    ]);
    return;
  }

  const query = arg('query', niche.searchQueries[0] ?? null);
  if (!query) {
    fail(['', `Raison : la niche « ${campaign.niche} » ne déclare aucune requête de recherche.`, '']);
    return;
  }

  const plan = PLACES_MASKS.discovery();
  const free = plan.envelope === 'free';
  process.stdout.write(`Requête ........................... « ${query} »\n`);
  process.stdout.write(`Zone (1 tuile sur ${String(areas.length).padStart(2)}) ............... ${area.label}\n`);
  process.stdout.write(`Field mask envoyé ................. ${plan.header}\n`);
  process.stdout.write(`Endpoint .......................... ${plan.endpoint}\n`);
  process.stdout.write(`Palier facturé .................... ${plan.tier} (SKU ${plan.sku})\n`);
  process.stdout.write(`Ce palier est-il gratuit ? ........ ${free ? 'oui — 0 $, sans plafond mensuel' : 'NON'}\n`);
  process.stdout.write('─'.repeat(78) + '\n');

  const sql = await getSql();
  // Le registre d'usage doit exister avant l'appel : une ligne non écrite est un
  // appel non comptable.
  await migrate(sql);

  const logger = createLogger({ cmd: 'places:probe', campaign: slug });
  const http = new HttpClient({ sql });
  const budget = new PlacesBudget({ sql, campaignSlug: slug, runId: null });
  const client = new PlacesClient({ http, budget, logger });

  const ledgerBefore = await ledgerCount(sql);

  let placeIds = 0;
  let hasNextPage = false;
  let failure: string | null = null;
  let httpStatus: number | null = null;

  try {
    const page = await client.searchText(query, area, {
      regionCode: campaign.geography.country ?? 'FR',
      languageCode: niche.language,
    });
    placeIds = page.hits.length;
    hasNextPage = page.nextPageToken !== null;
  } catch (error) {
    if (error instanceof PlacesBudgetExceededError) {
      failure = `budget applicatif épuisé (${error.scope}) : ${error.message}`;
    } else if (error instanceof HttpError) {
      httpStatus = error.status;
      failure = `réponse HTTP ${error.status ?? 'inconnue'} de l’API Places`;
    } else {
      failure = error instanceof Error ? error.message : String(error);
    }
  }

  const ledgerAfter = await ledgerCount(sql);
  const wrote = ledgerAfter > ledgerBefore;
  const line = wrote ? await lastLedgerLine(sql) : null;
  if (line?.http_status != null) httpStatus = line.http_status;

  const snapshot = await budget.snapshot();

  process.stdout.write(`Statut HTTP ....................... ${httpStatus ?? 'non émis'}\n`);
  process.stdout.write(`place_id obtenus .................. ${placeIds}\n`);
  process.stdout.write(`Page suivante disponible .......... ${hasNextPage ? 'oui' : 'non'}\n`);
  if (line) {
    process.stdout.write(`Ligne de registre écrite .......... ${line.sku_tier} · facturable : ${line.billable ? 'oui' : 'non'}\n`);
  } else {
    process.stdout.write('Ligne de registre écrite .......... aucune (appel refusé avant émission)\n');
  }

  process.stdout.write('\nBudget applicatif après l’appel :\n');
  process.stdout.write(`  appels facturables du run ....... ${snapshot.runBillable} / ${snapshot.limits.run}\n`);
  process.stdout.write(`  appels totaux du run ............ ${snapshot.runCalls} / ${snapshot.limits.runCalls}\n`);
  process.stdout.write(`  appels gratuits du run .......... ${snapshot.freeCalls}\n`);
  process.stdout.write(`  facturables aujourd’hui (UTC) ... ${snapshot.dailyBillable} / ${snapshot.limits.daily}\n`);
  process.stdout.write(`  découverte ce mois-ci ........... ${snapshot.monthlyDiscovery} / ${snapshot.limits.monthlyDiscovery}\n`);
  process.stdout.write(`  détails ce mois-ci .............. ${snapshot.monthlyDetails} / ${snapshot.limits.monthlyDetails}\n`);

  process.stdout.write(
    '\nÉcritures : aucune sur `prospects` ni sur `google_place_candidates`.\n' +
      `Seule écriture possible : la ligne de registre \`google_places_usage\` ci-dessus (${wrote ? 'écrite' : 'non écrite'}).\n`,
  );

  await sql.close();

  if (failure) {
    fail(['', `Raison : ${failure}`, '', 'Voir la documentation d’installation sections 5 et 8.']);
    return;
  }
  if (!free) {
    fail(['', 'Raison : le masque de découverte ne tombe plus dans le palier gratuit.', '']);
    return;
  }
  if (placeIds === 0) {
    fail([
      '',
      'Raison : l’appel a abouti mais n’a retourné aucun place_id.',
      'La clé répond ; c’est la requête ou la zone qui ne donne rien. Essayer',
      'une autre requête (--query) ou une autre campagne (--campaign).',
    ]);
    return;
  }

  process.stdout.write(
    `\nRÉSULTAT : SUCCÈS — ${placeIds} place_id obtenus au palier ${plan.tier}, sans frais.\n\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
