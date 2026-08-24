import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/**
 * R7.3C §5 — « le profil de l'observer n'est pas celui du rail outbound », dit
 * par du code plutôt que par une consigne.
 *
 * ---------------------------------------------------------------------------
 * Ce qu'on protège exactement
 * ---------------------------------------------------------------------------
 * Le rail outbound possède une session Instagram authentifiée qui a servi à
 * remettre un premier message commercial. Cette session est la chose la plus
 * dangereuse du dépôt : celui qui l'ouvre peut écrire à un prospect. La mission
 * R7.3C n'a besoin que de LIRE des profils publics, et elle interdit
 * explicitement de copier cookies, `sessionid`, `localStorage` ou répertoire de
 * profil depuis le rail outbound.
 *
 * Une consigne ne suffit pas, parce que la façon dont on se retrouverait à
 * partager le profil n'est pas « quelqu'un décide de le faire » : c'est une
 * valeur par défaut mal placée, un `config/instagram.json` relu par erreur, un
 * `profileDir` recopié d'un fichier à l'autre. Toutes ces erreurs sont muettes,
 * et leur conséquence — un navigateur d'observation qui démarre CONNECTÉ au
 * compte d'envoi — ne se voit sur aucune sortie.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi la comparaison porte sur les chemins RÉSOLUS
 * ---------------------------------------------------------------------------
 * Le schéma exige déjà `var/r7/` pour l'observer, ce qui exclut par préfixe
 * `var/instagram/profile`. C'est nécessaire et insuffisant : un lien symbolique
 * `var/r7/instagram-profile-observer -> var/instagram/profile` satisfait le
 * préfixe et pointe pourtant sur la session d'envoi. Un préfixe de chaîne
 * décrit un NOM ; ce qu'on veut interdire est un RÉPERTOIRE.
 *
 * `realpathSync` est donc appliqué aux deux chemins, segment par segment
 * lorsqu'ils existent. Un chemin qui n'existe pas encore — le cas normal au
 * premier lancement — est comparé sur sa forme absolue après résolution du plus
 * long ancêtre existant : c'est ce qui attrape le lien symbolique posé sur un
 * répertoire PARENT, sans exiger que la cible existe déjà.
 *
 * ---------------------------------------------------------------------------
 * La règle
 * ---------------------------------------------------------------------------
 * Les deux répertoires doivent être DISJOINTS : ni égaux, ni l'un contenu dans
 * l'autre. Le confinement compte autant que l'égalité — un profil observer placé
 * SOUS le profil outbound partagerait son arborescence, et un profil outbound
 * placé sous l'observer serait effacé par un prestation standard d'artefacts.
 */

export class ObserverIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObserverIsolationError';
  }
}

/**
 * Le plus long ancêtre existant d'un chemin, résolu de ses liens symboliques,
 * puis recomposé avec le reste.
 *
 * Sans cela, `realpathSync` lève dès que le répertoire n'existe pas encore —
 * c'est-à-dire exactement au premier lancement, quand la vérification compte le
 * plus.
 */
function resolveThroughSymlinks(path: string): string {
  const absolute = resolve(path);
  const segments = absolute.split(sep);
  for (let depth = segments.length; depth > 0; depth -= 1) {
    const candidate = segments.slice(0, depth).join(sep) || sep;
    try {
      const real = realpathSync(candidate);
      const rest = segments.slice(depth);
      return rest.length === 0 ? real : resolve(real, ...rest);
    } catch {
      // Ce niveau n'existe pas encore : on remonte d'un cran.
    }
  }
  return absolute;
}

/** `child` est-il `parent` ou vit-il dedans ? Comparaison par SEGMENTS, jamais par préfixe de chaîne. */
function containsOrEquals(parent: string, child: string): boolean {
  if (parent === child) return true;
  return child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

export interface ObserverIsolationVerdict {
  readonly observerDir: string;
  readonly outboundDir: string;
  readonly isolated: boolean;
  readonly reason: string;
}

/**
 * Constate — sans lever — si les deux profils sont disjoints.
 *
 * Séparé de l'assertion parce que le rapport de run doit pouvoir PUBLIER les
 * deux chemins résolus et le verdict, y compris quand tout va bien. Une garantie
 * qu'on ne peut pas lire est une garantie qu'on finit par ne plus vérifier.
 */
export function checkObserverProfileIsolation(
  observerProfileDir: string,
  outboundProfileDir: string,
): ObserverIsolationVerdict {
  const observerDir = resolveThroughSymlinks(observerProfileDir);
  const outboundDir = resolveThroughSymlinks(outboundProfileDir);

  if (observerDir === outboundDir) {
    return {
      observerDir,
      outboundDir,
      isolated: false,
      reason: 'les deux chemins résolvent vers le MÊME répertoire — la session d’envoi serait ouverte en observation',
    };
  }
  if (containsOrEquals(outboundDir, observerDir)) {
    return {
      observerDir,
      outboundDir,
      isolated: false,
      reason: 'le profil observer vit SOUS le profil outbound — les deux partageraient la même arborescence',
    };
  }
  if (containsOrEquals(observerDir, outboundDir)) {
    return {
      observerDir,
      outboundDir,
      isolated: false,
      reason: 'le profil outbound vit SOUS le profil observer — un prestation standard d’artefacts effacerait la session d’envoi',
    };
  }
  return { observerDir, outboundDir, isolated: true, reason: 'répertoires disjoints' };
}

/**
 * La même chose, mais qui REFUSE DE DÉMARRER.
 *
 * Appelée avant `launchPersistentContext`, jamais après : un navigateur ouvert
 * sur le mauvais profil a déjà lu les cookies, et s'excuser ensuite ne les
 * referme pas.
 */
export function assertObserverProfileIsolated(observerProfileDir: string, outboundProfileDir: string): ObserverIsolationVerdict {
  const verdict = checkObserverProfileIsolation(observerProfileDir, outboundProfileDir);
  if (!verdict.isolated) {
    throw new ObserverIsolationError(
      `profil d’observation refusé : ${verdict.reason}. ` +
        `observer « ${verdict.observerDir} » vs outbound « ${verdict.outboundDir} ». ` +
        'R7.3C n’ouvre jamais la session qui sait envoyer.',
    );
  }
  return verdict;
}
