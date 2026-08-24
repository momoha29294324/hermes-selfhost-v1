/**
 * HERMES-ACTIVE-ANALYSIS-VERSION-CONFLICT-R1 §PROTECTION — un processus long
 * n'est pas une autorité sur ce qui est canonique aujourd'hui.
 *
 * ---------------------------------------------------------------------------
 * Le défaut, énoncé sans le grossir
 * ---------------------------------------------------------------------------
 * Node charge le code une fois. Un `ig:inbound:run --loop` démarré à 07:00
 * continue de classifier à 08:43 avec les constantes de 07:00 —
 * `REPLY_CLASSIFIER_PROMPT_VERSION` comprise. Un `git commit` local qui
 * incrémente cette version ne l'atteint pas : le worker écrit des analyses sous
 * une version que plus aucun code ne produit, et fait passer en `SUPERSEDED`
 * les conclusions canoniques rendues par un processus à jour.
 *
 * C'est arrivé le 23 août 2026 sur le message
 * f56eab97-3306-4018-90b8-773c00d85f16.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce module fait, et surtout ce qu'il NE fait PAS
 * ---------------------------------------------------------------------------
 * Il lit une chaîne : la révision du dépôt, depuis `.git`. Rien d'autre.
 *
 * Ce n'est PAS un rechargement à chaud. Rien n'est réimporté, rien n'est
 * réévalué, aucun module n'est invalidé — la seule conséquence possible est un
 * ARRÊT, laissé à l'appelant, qui demande à un humain de relancer. Un rechargement
 * à chaud aurait fait tourner un processus avec la moitié de son code d'hier,
 * ce qui est pire que le défaut qu'on répare.
 *
 * Ce n'est PAS une comparaison de versions de politique. Comparer
 * `REPLY_CLASSIFIER_PROMPT_VERSION` à lui-même ne peut rien apprendre : dans un
 * processus périmé, les deux côtés de l'égalité sont la valeur périmée. Seul un
 * fait EXTÉRIEUR au processus peut trancher, et la révision du dépôt en est un.
 *
 * Il ne lance AUCUN sous-processus : `git rev-parse` sur un worker qui tourne
 * depuis des heures paierait un fork par tour. Deux lectures de fichier
 * suffisent, et elles sont déterministes.
 *
 * Il est FAIL-OPEN sur l'absence, et c'est délibéré : hors d'un dépôt Git — une
 * image, un test, une installation — il rend `null`, et l'appelant ne conclut
 * rien. Une révision illisible n'est pas la preuve d'une dérive ; en faire un
 * arrêt rendrait le rail entrant indémarrable là où il n'y a rien à protéger.
 */

import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SHA = /^[0-9a-f]{40}$/;

/**
 * Le répertoire Git qui gouverne `root`.
 *
 * HERMES-END-TO-END-CERTIFICATION-R1 — la sentinelle était SILENCIEUSEMENT
 * désarmée dans tout worktree, et ce dépôt en compte sept.
 *
 * Dans un worktree, `.git` n'est pas un répertoire : c'est un FICHIER d'une
 * ligne, `gitdir: /chemin/vers/le/dépôt/.git/worktrees/<nom>`. L'ancien code
 * lisait `join(root, '.git', 'HEAD')`, ce qui lève `ENOTDIR` — attrapé par le
 * `catch` du bas, rendu `null`, donc `startedAt === null`, donc `hasDrifted()`
 * FAUX pour toujours. La seule protection contre l'incident du 23 août — un
 * `--loop` qui continue de classifier avec le code d'il y a deux heures — ne
 * s'appliquait qu'au dépôt principal.
 *
 * La documentation de ce module autorise le fail-open « hors d'un dépôt Git ».
 * Un worktree EST dans le dépôt : la précondition n'était pas remplie, et le
 * silence était donc un défaut, pas une décision.
 *
 * Rend `null` — donc fail-open, comme avant — quand rien de lisible ne
 * ressemble à un répertoire Git. Ce cas-là reste celui que la documentation
 * décrit : un dossier qui n'est pas un dépôt.
 */
/**
 * Le répertoire des références PARTAGÉES.
 *
 * Un worktree porte un fichier `commondir` — en pratique `../..` — qui désigne
 * le `.git` du dépôt principal, là où vivent `refs/` et `packed-refs`. Hors
 * worktree ce fichier n'existe pas, et le répertoire commun EST le répertoire
 * Git : la valeur rendue est alors strictement identique à l'entrée, ce qui
 * laisse le chemin ordinaire inchangé.
 */
function resolveCommonDir(gitDir: string): string {
  try {
    const pointer = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
    if (pointer.length === 0) return gitDir;
    return resolve(gitDir, pointer);
  } catch {
    return gitDir;
  }
}

function resolveGitDir(root: string): string | null {
  const dotGit = join(root, '.git');
  let stats;
  try {
    stats = statSync(dotGit);
  } catch {
    return null;
  }
  if (stats.isDirectory()) return dotGit;
  if (!stats.isFile()) return null;

  const pointer = readFileSync(dotGit, 'utf8').trim();
  const match = /^gitdir:\s*(.+)$/.exec(pointer);
  if (match === null) return null;
  const target = match[1]!.trim();
  if (target.length === 0) return null;
  // Le pointeur est absolu en pratique ; un chemin relatif se lit depuis le
  // worktree, ce que `resolve` fait sans changer le cas absolu.
  return resolve(root, target);
}


/**
 * La révision du dépôt qui contient `root`, ou `null` si elle n'est pas
 * lisible.
 *
 * Trois formes, dans cet ordre : un `.git/HEAD` détaché porte le SHA
 * directement ; sinon il nomme une référence, lue dans `.git/<ref>` ; sinon
 * elle est empaquetée dans `.git/packed-refs`.
 */
export function readCodeRevision(root: string): string | null {
  try {
    const gitDir = resolveGitDir(root);
    if (gitDir === null) return null;
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();

    if (SHA.test(head)) return head;

    const match = /^ref:\s*(\S+)$/.exec(head);
    if (match === null) return null;
    const ref = match[1]!;

    // Dans un worktree, `HEAD` est local mais les RÉFÉRENCES sont partagées :
    // elles vivent dans le répertoire que désigne `commondir`. Les deux
    // emplacements sont essayés, le local d'abord — c'est le seul dans un dépôt
    // ordinaire, où `commonDir` vaut `gitDir`.
    const commonDir = resolveCommonDir(gitDir);
    for (const base of commonDir === gitDir ? [gitDir] : [gitDir, commonDir]) {
      try {
        const direct = readFileSync(join(base, ref), 'utf8').trim();
        if (SHA.test(direct)) return direct;
      } catch {
        // Référence empaquetée — le cas normal après un `git gc`.
      }
    }

    for (const base of commonDir === gitDir ? [gitDir] : [gitDir, commonDir]) {
      let packed: string;
      try {
        packed = readFileSync(join(base, 'packed-refs'), 'utf8');
      } catch {
        continue;
      }
      for (const rawLine of packed.split('\n')) {
        const line = rawLine.trim();
        if (line.length === 0 || line.startsWith('#') || line.startsWith('^')) continue;
        const [sha, name] = line.split(/\s+/, 2);
        if (name === ref && sha !== undefined && SHA.test(sha)) return sha;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * La sentinelle : elle retient la révision d'un instant et sait dire si elle a
 * bougé depuis.
 *
 * `hasDrifted` est FAUX tant qu'un doute subsiste — révision de départ
 * illisible, révision courante illisible. Elle n'affirme une dérive que sur
 * deux lectures réussies et différentes.
 */
export interface CodeRevisionSentinel {
  /** La révision lue au démarrage, ou `null` si elle ne l'était pas. */
  readonly startedAt: string | null;
  /** La révision maintenant, relue à chaque appel. */
  current: () => string | null;
  /** Vrai UNIQUEMENT sur deux lectures réussies et différentes. */
  hasDrifted: () => boolean;
}

export function createCodeRevisionSentinel(
  root: string,
  read: (root: string) => string | null = readCodeRevision,
): CodeRevisionSentinel {
  const startedAt = read(root);
  const current = (): string | null => read(root);
  return Object.freeze({
    startedAt,
    current,
    hasDrifted: (): boolean => {
      if (startedAt === null) return false;
      const now = current();
      return now !== null && now !== startedAt;
    },
  });
}
