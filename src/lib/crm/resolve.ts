/**
 * R6B-D2.1 — la résolution d'une destination CRM, et ses refus.
 *
 * ---------------------------------------------------------------------------
 * Aucune destination ne se déduit d'une seule source
 * ---------------------------------------------------------------------------
 *
 * Six conditions, toutes nécessaires, avant qu'un octet ne parte :
 *
 *   1. `OUTBOUND_CRM_PROVIDER` nomme un fournisseur ;
 *   2. ce dépôt possède un adapter pour ce nom ;
 *   3. les identifiants de l'adapter sont présents ;
 *   4. `OUTBOUND_CRM_LOCATION_ID` nomme un sous-compte ;
 *   5. une ligne `r6b_crm_destinations` CONFIRMED porte CE MÊME sous-compte,
 *      avec le nom de l'humain qui l'a confirmé ;
 *   6. cette destination porte un pipeline et au moins une étape cartographiée.
 *
 * La cinquième est celle qui compte vraiment. Le CRM présent sur cette machine
 * appartient à un autre projet ; une variable exportée par
 * erreur, un `.env` copié d'ailleurs, un secret partagé entre projets — aucun
 * de ces accidents ne peut écrire, parce qu'aucun ne produit une confirmation
 * en base pour ce `location_id` précis. Le résultat est un `BLOCKED_CONFIG`
 * visible, jamais une écriture chez un tiers.
 */

import { env } from '@/lib/env';
import type { Sql } from '@/lib/db/sql';
import { CRM_ENV_KEYS, GHL_PROVIDER_NAME, GhlApi, GhlCrmProvider, readGhlCredentials } from '@/lib/crm/ghl';
import { loadConfirmedDestination, loadStageMap } from '@/lib/crm/store';
import type { CrmProvider, CrmResolution } from '@/lib/crm/types';

export { CRM_ENV_KEYS };

/**
 * Construit un adapter, ou dit ce qui manque par NOM de variable.
 *
 * Ne rend jamais une valeur, un fragment ni une longueur (CLAUDE.md §6) : un
 * appelant qui affiche ce résultat ne peut pas divulguer un secret même en le
 * voulant.
 */
export type CrmAdapterFactory = () =>
  | { readonly ok: true; readonly provider: CrmProvider }
  | { readonly ok: false; readonly missing: readonly string[] };

/**
 * Les fournisseurs que ce dépôt sait joindre.
 *
 * Un nom absent de ce registre ne mène nulle part — il n'existe aucun chemin de
 * code d'une variable d'environnement inconnue vers un fournisseur par défaut.
 */
export const CRM_ADAPTERS: Readonly<Record<string, CrmAdapterFactory>> = Object.freeze({
  [GHL_PROVIDER_NAME]: (): ReturnType<CrmAdapterFactory> => {
    const credentials = readGhlCredentials();
    if (!credentials.ok) return { ok: false, missing: credentials.missing };
    return { ok: true, provider: new GhlCrmProvider(new GhlApi(credentials.credentials)) };
  },
});

export interface ResolveCrmDeps {
  readonly adapters?: Readonly<Record<string, CrmAdapterFactory>>;
}

function blocked(reason: string, missing: readonly string[] = []): CrmResolution {
  return Object.freeze({
    configured: false as const,
    kind: 'BLOCKED_CONFIG' as const,
    reason,
    missing: Object.freeze([...missing]),
  });
}

/**
 * Résout la destination CRM. Fail-closed à chaque étape.
 *
 * `NOT_CONFIGURED` n'est pas une erreur : c'est l'état par défaut du dépôt,
 * celui dans lequel il se trouve aujourd'hui, et il doit se distinguer d'une
 * configuration REFUSÉE — la correction n'est pas la même.
 */
export async function resolveCrmDestination(sql: Sql, deps: ResolveCrmDeps = {}): Promise<CrmResolution> {
  const adapters = deps.adapters ?? CRM_ADAPTERS;
  const name = (env(CRM_ENV_KEYS.provider) ?? '').trim();

  if (name.length === 0) {
    return Object.freeze({
      configured: false as const,
      kind: 'NOT_CONFIGURED' as const,
      reason:
        'aucune projection CRM externe demandée — le dossier commercial canonique est le CRM Hermes ' +
        'local (/crm). Une copie chez un tiers reste possible et optionnelle : renseigner ' +
        `${CRM_ENV_KEYS.provider}, ${CRM_ENV_KEYS.locationId} et ${CRM_ENV_KEYS.apiKey}, ` +
        'puis confirmer le sous-compte avec « npm run r6b:crm:verify -- --confirm »',
      // Rien ne « manque » : ces variables sont ce qu'il faudrait renseigner
      // POUR activer une copie externe, pas ce qui empêche de travailler.
      missing: Object.freeze([CRM_ENV_KEYS.provider, CRM_ENV_KEYS.locationId, CRM_ENV_KEYS.apiKey]),
    });
  }

  const factory = adapters[name];
  if (!factory) {
    return blocked(
      `${CRM_ENV_KEYS.provider} désigne « ${name} », pour lequel ce dépôt n'a aucun adapter ` +
        `(connus : ${Object.keys(adapters).join(', ') || 'aucun'})`,
    );
  }

  const locationId = (env(CRM_ENV_KEYS.locationId) ?? '').trim();
  if (locationId.length === 0) {
    return blocked(
      `${CRM_ENV_KEYS.locationId} n'est pas renseignée — aucun sous-compte n'est désigné`,
      [CRM_ENV_KEYS.locationId],
    );
  }

  const built = factory();
  if (!built.ok) {
    return blocked(
      `adapter « ${name} » : identifiants absents (${built.missing.join(', ')})`,
      built.missing,
    );
  }

  const availability = built.provider.availability();
  if (!availability.ok) {
    return blocked(availability.reason ?? `adapter « ${name} » indisponible`);
  }

  const destination = await loadConfirmedDestination(sql, name);
  if (destination === null) {
    return blocked(
      `aucun sous-compte « ${name} » confirmé en base — ` +
        'lancer « npm run r6b:crm:verify » (lecture seule) puis confirmer explicitement. ' +
        'Une variable d’environnement seule n’autorise aucune écriture.',
    );
  }

  // LA garde d'isolation. Si l'environnement pointe ailleurs que la
  // confirmation, on ne choisit pas : on refuse. Écrire dans le sous-compte
  // d'un autre projet ne se défait pas.
  if (destination.locationId !== locationId) {
    return blocked(
      `${CRM_ENV_KEYS.locationId} désigne « ${locationId} » alors que le sous-compte confirmé est ` +
        `« ${destination.locationId} »${destination.locationName === null ? '' : ` (${destination.locationName})`} — ` +
        'écriture refusée. Confirmer explicitement le bon sous-compte avant de réessayer.',
    );
  }

  if (destination.pipelineId === null) {
    return blocked(
      `le sous-compte confirmé « ${destination.locationId} » ne porte aucun pipeline — ` +
        'relancer « npm run r6b:crm:verify -- --pipeline <id> --confirm »',
    );
  }

  const stages = await loadStageMap(sql, destination.id);
  if (Object.keys(stages).length === 0) {
    return blocked(
      `aucune correspondance état → étape enregistrée pour « ${destination.locationId} » — ` +
        'relancer « npm run r6b:crm:verify » pour la construire',
    );
  }

  return Object.freeze({
    configured: true as const,
    provider: built.provider,
    target: Object.freeze({
      destination,
      pipelineId: destination.pipelineId,
      stages,
    }),
  });
}
