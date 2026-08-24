/**
 * Le bail du PROFIL NAVIGATEUR Instagram — un seul Chromium à la fois dessus.
 *
 * Ce qui a rendu ce module nécessaire
 * -----------------------------------
 * Deux runtimes Hermes tournent en permanence sur cette machine : la relève
 * entrante (`ig:inbound:run --loop`, un tour toutes les cinq minutes) et le
 * worker autonome sortant (`ig:autonomous:worker --loop`, un tour par minute).
 * Les deux lisent `config/instagram.json → session.profileDir`, donc les deux
 * ouvrent LE MÊME répertoire de profil Chromium — celui qui porte la session
 * @hermesagency_. Rien, jusqu'ici, ne les empêchait de l'ouvrir en même temps.
 *
 * Un profil Chromium n'est pas conçu pour deux processus. Le second qui
 * l'ouvre ne reçoit pas d'erreur claire : selon le moment, il repart d'un
 * profil vide, écrase le journal des cookies du premier, ou fait perdre la
 * session aux deux. La panne qui en découle ne ressemble pas à une panne de
 * verrou — elle ressemble à « Instagram nous a déconnectés », et coûte une
 * reconnexion manuelle, la seule opération de ce dépôt qu'aucun code ne peut
 * faire à notre place.
 *
 * Pourquoi un verrou de FICHIER, et pas un verrou en base
 * ------------------------------------------------------
 * La ressource protégée est locale : un répertoire, sur ce disque. La base,
 * elle, est un Postgres distant (Supabase). Un `pg_advisory_lock` ferait donc
 * dépendre l'ouverture d'un navigateur local de la disponibilité d'un service
 * distant — un rail entrant en lecture seule s'arrêterait parce qu'un réseau
 * a hoqueté, alors que rien ne l'empêchait de travailler. Et il mentirait dans
 * l'autre sens : une session perdue côté serveur libérerait le verrou pendant
 * que Chromium, lui, tient toujours les fichiers.
 *
 * Le verrou vit donc à côté de ce qu'il protège. `@/lib/fs/exclusiveFileLock`
 * en porte la mécanique — la même que celle du datadir PGlite, pas une seconde.
 *
 * Le chemin RÉEL, jamais celui qui a été écrit
 * --------------------------------------------
 * La clé du bail est le `realpath` du profil, et c'est ce qui le rend correct
 * ici et maintenant : `var/instagram/profile` a longtemps été un lien
 * symbolique vers le worktree R7, si bien que deux processus lançant deux
 * chemins différents ouvraient un seul et même profil. Un verrou nommé d'après
 * le chemin ÉCRIT les aurait laissés passer tous les deux, en affichant deux
 * verrous distincts — la pire forme de sécurité, celle qui rassure. Résolu par
 * `realpath`, un alias ne peut plus produire un second bail.
 *
 * Réentrance
 * ----------
 * Dans un même processus, plusieurs couches demandent le bail : le tour
 * entrant le prend AVANT d'ouvrir sa ligne de relève (pour qu'un profil occupé
 * ne laisse aucune trace de panne en base), et le rail le redemande au moment
 * d'ouvrir Chromium (pour qu'aucun chemin ne puisse contourner le bail). Ces
 * deux demandes sont la même : un compteur les additionne, le fichier n'est
 * écrit qu'à la première et retiré qu'à la dernière.
 */
import { mkdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  acquireExclusiveFileLock,
  ExclusiveFileLockHeldError,
  ExclusiveFileLockUnreadableError,
  readLockHolder,
  sameHostHolderLiveness,
  type ExclusiveFileLock,
  type ExclusiveLockHolder,
} from '@/lib/fs/exclusiveFileLock';
import { logger } from '@/lib/logging/logger';

/** Le suffixe du fichier de bail. Voisin du profil, jamais dedans : tout ce qui vit
 *  à l'intérieur d'un `user-data-dir` appartient à Chromium, qui le réécrit. */
const LEASE_SUFFIX = '.browser-lease';

/**
 * Le profil est tenu par quelqu'un d'autre.
 *
 * Ce n'est PAS une panne de session Instagram, et le code qui l'attrape doit
 * le traiter comme tel : aucun navigateur n'a été ouvert, aucune page n'a été
 * chargée, aucune session n'a été jugée. Le rail réessaiera au tour suivant.
 */
export class InstagramBrowserProfileBusyError extends Error {
  readonly code = 'IG_BROWSER_PROFILE_BUSY' as const;
  readonly profilePath: string;
  readonly lockFile: string;
  readonly holder: ExclusiveLockHolder;

  constructor(profilePath: string, lockFile: string, holder: ExclusiveLockHolder) {
    super(
      `le profil navigateur ${profilePath} est déjà ouvert par un autre runtime Hermes ` +
        `(pid ${String(holder.pid)} sur ${holder.hostname}, depuis ${holder.startedAt}, cmd: ${holder.cmd}) — ` +
        `aucun navigateur n'a été ouvert, le tour sera repris plus tard`,
    );
    this.name = 'InstagramBrowserProfileBusyError';
    this.profilePath = profilePath;
    this.lockFile = lockFile;
    this.holder = holder;
  }
}

export interface InstagramBrowserLease {
  /** Le chemin RÉEL du profil, liens résolus. C'est la clé du bail. */
  readonly profilePath: string;
  readonly lockFile: string;
  /** Vrai si ce processus tenait DÉJÀ le bail : rien n'a été écrit sur le disque. */
  readonly reentrant: boolean;
  /** Idempotent. Ne retire le fichier qu'au dernier détenteur du processus. */
  release(): void;
}

interface ProcessEntry {
  readonly lock: ExclusiveFileLock;
  count: number;
}

/**
 * Les baux tenus PAR CE PROCESSUS, par chemin réel.
 *
 * Un module-level `Map` est exactement la bonne portée : un processus, une
 * table. Elle ne survit pas au processus — et elle n'a pas à le faire, puisque
 * c'est le fichier sur le disque qui porte la vérité entre processus.
 */
const held = new Map<string, ProcessEntry>();

/**
 * Le chemin réel du profil, sans jamais rien créer.
 *
 * `realpathSync` échoue si le chemin n'existe pas encore (profil neuf) : on
 * retombe alors sur la résolution absolue, qui est la bonne réponse — un
 * répertoire qui n'existe pas n'est l'alias de rien.
 */
export function resolveInstagramProfilePath(profileDir: string): string {
  const absolute = resolve(process.cwd(), profileDir);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/** Le fichier de bail d'un profil, chemin réel résolu. */
export function instagramBrowserLeasePath(profileDir: string): string {
  const real = resolveInstagramProfilePath(profileDir);
  const trimmed = real.endsWith('/') ? real.slice(0, -1) : real;
  return `${trimmed}${LEASE_SUFFIX}`;
}

export interface InstagramBrowserLeaseState {
  readonly profilePath: string;
  readonly lockFile: string;
  readonly held: boolean;
  readonly heldByThisProcess: boolean;
  readonly holder: ExclusiveLockHolder | null;
}

/**
 * Constate qui tient le bail, sans rien prendre ni rien créer.
 *
 * Une observation, donc — pas une réservation. Elle sert à un opérateur
 * (`ig:status`) et aux tests ; personne ne doit s'en servir pour DÉCIDER
 * d'ouvrir un navigateur : entre la question et l'ouverture, la réponse peut
 * changer. Seul `acquireInstagramBrowserLease` tranche, parce que lui seul est
 * atomique.
 */
export function inspectInstagramBrowserLease(profileDir: string): InstagramBrowserLeaseState {
  const profilePath = resolveInstagramProfilePath(profileDir);
  const lockFile = instagramBrowserLeasePath(profileDir);
  const holder = readLockHolder(lockFile);
  return Object.freeze({
    profilePath,
    lockFile,
    held: holder !== null,
    heldByThisProcess: holder !== null && holder.pid === process.pid,
    holder,
  });
}

/**
 * Prend le bail du profil, ou lève `InstagramBrowserProfileBusyError`.
 *
 * N'attend jamais. Le rail qui trouve le profil occupé n'a rien à gagner à
 * bloquer : l'autre runtime tient le profil pour la durée d'une relève, et
 * les deux boucles reviendront d'elles-mêmes. Attendre transformerait une
 * contention normale en un processus figé dont personne ne sait pourquoi.
 */
export function acquireInstagramBrowserLease(profileDir: string): InstagramBrowserLease {
  // Créé si absent : un profil neuf doit pouvoir être verrouillé AVANT que
  // Chromium n'écrive quoi que ce soit dedans.
  const absolute = resolve(process.cwd(), profileDir);
  mkdirSync(absolute, { recursive: true });

  const profilePath = resolveInstagramProfilePath(profileDir);
  const lockFile = instagramBrowserLeasePath(profileDir);
  const log = logger.child({ rail: 'instagram', lease: 'browser-profile' });

  const existing = held.get(profilePath);
  if (existing !== undefined) {
    existing.count += 1;
    return Object.freeze({
      profilePath,
      lockFile,
      reentrant: true,
      release: makeReleaser(profilePath, existing),
    });
  }

  let lock: ExclusiveFileLock;
  try {
    lock = acquireExclusiveFileLock(lockFile, {
      // Un bail venu d'un autre hôte est tenu pour vivant : son PID ne veut
      // rien dire ici, et un profil ne se reprend pas sur une supposition.
      isHolderAlive: sameHostHolderLiveness,
      onStaleReclaim: (holder, attempt) => {
        log.warn('instagram.browser_lease.stale_reclaimed', {
          profilePath,
          deadPid: holder.pid,
          deadHost: holder.hostname,
          heldSince: holder.startedAt,
          attempt,
        });
      },
    });
  } catch (error) {
    if (error instanceof ExclusiveFileLockHeldError) {
      log.info('instagram.browser_lease.busy', {
        profilePath,
        holderPid: error.holder.pid,
        holderHost: error.holder.hostname,
        heldSince: error.holder.startedAt,
      });
      throw new InstagramBrowserProfileBusyError(profilePath, lockFile, error.holder);
    }
    if (error instanceof ExclusiveFileLockUnreadableError) {
      // Fermé par défaut, et dit avec les mots du rail : un fichier de bail
      // illisible ne prouve pas que le profil est libre.
      throw new InstagramBrowserProfileBusyError(profilePath, lockFile, {
        pid: -1,
        hostname: 'inconnu',
        startedAt: 'inconnu',
        cmd: `fichier de bail illisible en ${lockFile}`,
      });
    }
    throw error;
  }

  const entry: ProcessEntry = { lock, count: 1 };
  held.set(profilePath, entry);
  log.info('instagram.browser_lease.acquired', { profilePath, lockFile });

  return Object.freeze({
    profilePath,
    lockFile,
    reentrant: false,
    release: makeReleaser(profilePath, entry),
  });
}

/**
 * Un libérateur par PRISE, et non par entrée : appeler `release()` deux fois
 * sur le même bail ne doit pas décompter la prise d'une autre couche.
 */
function makeReleaser(profilePath: string, entry: ProcessEntry): () => void {
  let done = false;
  return (): void => {
    if (done) return;
    done = true;
    entry.count -= 1;
    if (entry.count > 0) return;
    held.delete(profilePath);
    entry.lock.release();
    logger
      .child({ rail: 'instagram', lease: 'browser-profile' })
      .info('instagram.browser_lease.released', { profilePath });
  };
}
