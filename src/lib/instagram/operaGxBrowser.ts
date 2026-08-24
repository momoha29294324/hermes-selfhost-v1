import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * R7 — le profil observer s'ouvre dans Opera GX, pas dans le Chromium livré
 * avec Playwright.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi détecter plutôt que supposer
 * ---------------------------------------------------------------------------
 * Le nom du bundle (« Opera GX.app ») n'est pas le nom du binaire qu'il
 * contient : sur une installation réelle, `Contents/MacOS/` porte un
 * exécutable nommé `Opera`, pas `Opera GX`. Un chemin deviné et jamais vérifié
 * romprait silencieusement — Playwright échouerait à démarrer, ou pire,
 * `launchPersistentContext` retomberait sur un autre Chromium sans le dire.
 * Cette fonction n'affirme donc un chemin qu'après l'avoir constaté sur disque.
 *
 * ---------------------------------------------------------------------------
 * Pas de repli silencieux
 * ---------------------------------------------------------------------------
 * Si aucun candidat n'existe, on lève — jamais un retour sur le Chromium de
 * Playwright. Un rail qui annonce « Opera GX » et ouvre autre chose sans le
 * dire serait plus trompeur qu'un échec net.
 */

export class OperaGxNotFoundError extends Error {
  readonly candidates: readonly string[];

  constructor(candidates: readonly string[]) {
    super(
      `OPERA_GX_NOT_FOUND — aucun binaire Opera GX trouvé. Chemins vérifiés :\n` +
        candidates.map((path) => `  - ${path}`).join('\n'),
    );
    this.name = 'OperaGxNotFoundError';
    this.candidates = candidates;
  }
}

const DEFAULT_ROOTS = ['/Applications', resolve(homedir(), 'Applications')];

/**
 * Les chemins plausibles, du plus courant au moins courant. Aucun n'est
 * supposé exister — c'est `resolveOperaGxExecutablePath` qui vérifie.
 *
 * Seul macOS est couvert : c'est la seule plateforme que cette mission
 * demande. Une autre plateforme retourne une liste vide, donc échoue toujours
 * avec `OPERA_GX_NOT_FOUND` plutôt que d'inventer un chemin qui n'a jamais été
 * observé — y compris si `roots` est fourni : la structure `Contents/MacOS/`
 * qu'on y assemble n'a de sens que sous macOS.
 *
 * Exportée pour être exercée par les tests sans toucher au disque réel.
 */
export function candidatePaths(platform: NodeJS.Platform, roots: readonly string[] = DEFAULT_ROOTS): readonly string[] {
  if (platform !== 'darwin') return [];

  const bundleName = 'Opera GX.app';
  // Le nom réel de l'exécutable est « Opera » ; « Opera GX » reste vérifié en
  // premier au cas où une autre version de l'installeur le nommerait ainsi.
  const executableNames = ['Opera GX', 'Opera'];

  const paths: string[] = [];
  for (const root of roots) {
    for (const executableName of executableNames) {
      paths.push(resolve(root, bundleName, 'Contents/MacOS', executableName));
    }
  }
  return paths;
}

export interface ResolveOperaGxOptions {
  /** Injecté par les tests. Par défaut, la plateforme réelle du process. */
  readonly platform?: NodeJS.Platform;
  /** Injecté par les tests pour éviter de dépendre d'une vraie installation. Par défaut, `/Applications` et `~/Applications`. */
  readonly roots?: readonly string[];
}

/**
 * Résout le binaire Opera GX RÉELLEMENT installé sur cette machine.
 *
 * Lève `OperaGxNotFoundError` (message préfixé `OPERA_GX_NOT_FOUND`) plutôt
 * que de se rabattre en silence sur un autre navigateur.
 */
export function resolveOperaGxExecutablePath(options: ResolveOperaGxOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const candidates = candidatePaths(platform, options.roots);
  const found = candidates.find((path) => existsSync(path));
  if (found === undefined) throw new OperaGxNotFoundError(candidates);
  return found;
}
