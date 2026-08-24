/**
 * Les cinq onglets de la fiche prospect.
 *
 * Déclarés comme une DONNÉE, pas comme cinq blocs de JSX : c'est ce qui permet
 * de vérifier par un test qu'ils existent tous, qu'ils sont uniques, et que
 * l'onglet par défaut est bien « Vue d'ensemble » — sans avoir à rendre la
 * page.
 *
 * L'ordre est celui de la lecture : ce qu'on regarde en ouvrant la fiche
 * d'abord, ce qu'on consulte en creusant ensuite, ce qu'on va chercher
 * rarement à la fin.
 *
 * Aucun onglet décoratif : chacun a un panneau réel, alimenté par les données
 * déjà chargées. Un onglet qui n'aurait rien à montrer affiche un état vide
 * explicite — il ne disparaît pas, parce que savoir qu'il n'y a aucune preuve
 * est une information de travail.
 */

export type CrmProspectTabId =
  | 'overview'
  | 'conversation'
  | 'evidence'
  | 'analysis'
  | 'history';

export interface CrmProspectTabDefinition {
  readonly id: CrmProspectTabId;
  readonly label: string;
  /** Libellé court, pour les écrans où la barre défile horizontalement. */
  readonly short: string;
}

export const CRM_PROSPECT_TABS: readonly CrmProspectTabDefinition[] = Object.freeze([
  Object.freeze({ id: 'overview' as const, label: 'Vue d’ensemble', short: 'Vue d’ensemble' }),
  Object.freeze({ id: 'conversation' as const, label: 'Activité & conversation', short: 'Activité' }),
  Object.freeze({ id: 'evidence' as const, label: 'Preuves & sources', short: 'Preuves' }),
  Object.freeze({ id: 'analysis' as const, label: 'Analyse & opportunités', short: 'Analyse' }),
  Object.freeze({ id: 'history' as const, label: 'Dossier & historique', short: 'Dossier' }),
]);

/** La fiche s'ouvre sur la vue d'ensemble, jamais sur un onglet de détail. */
export const CRM_PROSPECT_DEFAULT_TAB: CrmProspectTabId = 'overview';

/**
 * L'onglet demandé, ou le défaut.
 *
 * Une valeur inconnue ne provoque pas d'erreur et n'ouvre pas un panneau vide :
 * elle retombe sur la vue d'ensemble. Un lien périmé doit rester un lien qui
 * marche.
 */
export function resolveProspectTab(value: string | null | undefined): CrmProspectTabId {
  if (value === null || value === undefined) return CRM_PROSPECT_DEFAULT_TAB;
  const found = CRM_PROSPECT_TABS.find((tab) => tab.id === value);
  return found === undefined ? CRM_PROSPECT_DEFAULT_TAB : found.id;
}
