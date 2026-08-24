/**
 * Un verrou exclusif entre PROCESSUS, bâti sur `O_CREAT | O_EXCL` et sur rien
 * d'autre.
 *
 * Ce module n'a pas été écrit pour ce round : il est l'EXTRACTION de ce que
 * `@/lib/db/pgliteDatadirLock` faisait déjà depuis la récupération de
 * la documentation d’installation, et que le profil navigateur Instagram
 * réclamait à son tour. Deux implémentations du même verrou auraient été le
 * pire résultat possible : deux comportements sur le cas stale, deux façons de
 * mentir, et aucune des deux relue quand l'autre change.
 *
 * Pourquoi `O_EXCL` et pas un « lire, puis écrire si libre »
 * ---------------------------------------------------------
 * `openSync(file, 'wx')` est atomique au niveau du noyau : deux processus qui
 * l'appellent en même temps ne peuvent pas réussir tous les deux. Un
 * `existsSync()` suivi d'un `writeFileSync()` laisse au contraire une fenêtre
 * entre la question et la réponse — exactement la fenêtre où les deux rails
 * Instagram ouvriraient le même profil Chromium.
 *
 * Ce que ce verrou ne fait PAS
 * ----------------------------
 * Il ne rend pas l'accès concurrent sûr, il le rend impossible. Il n'attend
 * pas, ne fait pas la queue, ne réessaie pas : un appelant qui trouve le
 * verrou pris l'apprend immédiatement et décide lui-même quoi en faire. Et il
 * ne supprime JAMAIS un verrou qu'il ne peut pas prouver mort — un fichier
 * ancien n'est pas une preuve, seul un PID que le système déclare inexistant
 * en est une.
 */
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname } from 'node:os';

/** Combien de fois on accepte de reprendre un verrou mort avant d'abandonner. */
const DEFAULT_MAX_RECLAIM_ATTEMPTS = 3;

/**
 * Qui tient le verrou. Quatre faits, tous vérifiables par quelqu'un d'autre :
 * le PID se teste, l'hôte se compare, la date se lit, la commande se
 * reconnaît. Aucun n'est un secret — ce fichier est lisible par tout le monde.
 */
export interface ExclusiveLockHolder {
  readonly pid: number;
  readonly hostname: string;
  readonly startedAt: string;
  readonly cmd: string;
}

export interface ExclusiveFileLock {
  /** Le chemin du fichier de verrou lui-même. */
  readonly file: string;
  /** Ce qui a été écrit dedans à l'acquisition. */
  readonly holder: ExclusiveLockHolder;
  /** Idempotent : appeler deux fois ne retire pas le verrou de quelqu'un d'autre. */
  release(): void;
}

/** Le verrou est tenu par un processus qu'on ne peut pas déclarer mort. */
export class ExclusiveFileLockHeldError extends Error {
  readonly file: string;
  readonly holder: ExclusiveLockHolder;

  constructor(file: string, holder: ExclusiveLockHolder) {
    super(
      `verrou ${file} déjà tenu (pid ${String(holder.pid)} sur ${holder.hostname}, ` +
        `depuis ${holder.startedAt}, cmd: ${holder.cmd})`,
    );
    this.name = 'ExclusiveFileLockHeldError';
    this.file = file;
    this.holder = holder;
  }
}

/**
 * Le fichier existe mais ne se lit pas comme un verrou.
 *
 * Fermé par défaut, et c'est le point : un contenu illisible ne prouve pas que
 * personne ne tient la ressource. Le supprimer « parce qu'il est cassé » est
 * précisément la décision qui casse ce que le verrou protégeait.
 */
export class ExclusiveFileLockUnreadableError extends Error {
  readonly file: string;

  constructor(file: string) {
    super(
      `le fichier de verrou ${file} existe mais ne se lit pas comme un verrou valide ; ` +
        `refus d'acquérir. Ne le supprimer à la main qu'après avoir constaté qu'aucun processus ne le tient.`,
    );
    this.name = 'ExclusiveFileLockUnreadableError';
    this.file = file;
  }
}

/** Le détenteur qu'on écrirait maintenant. */
export function describeCurrentHolder(): ExclusiveLockHolder {
  return {
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
    cmd: process.argv.slice(1).join(' '),
  };
}

/** Lit le détenteur, ou `null` si le fichier est absent, illisible ou incomplet. */
export function readLockHolder(file: string): ExclusiveLockHolder | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return null;
    const candidate = parsed as Partial<ExclusiveLockHolder>;
    if (
      typeof candidate.pid !== 'number' ||
      typeof candidate.hostname !== 'string' ||
      typeof candidate.startedAt !== 'string'
    ) {
      return null;
    }
    return {
      pid: candidate.pid,
      hostname: candidate.hostname,
      startedAt: candidate.startedAt,
      cmd: typeof candidate.cmd === 'string' ? candidate.cmd : '',
    };
  } catch {
    return null;
  }
}

/**
 * Le PID répond-il encore ?
 *
 * Le signal 0 n'envoie rien : il demande seulement si le processus POURRAIT
 * être signalé. `ESRCH` — « aucun processus de ce numéro » — est la seule
 * réponse qui prouve une mort. Tout le reste, `EPERM` compris (il existe, mais
 * appartient à quelqu'un d'autre), se lit « vivant », parce qu'on ne peut pas
 * prouver le contraire.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Prédicat de vivacité par défaut : le PID, et rien d'autre.
 *
 * C'est le comportement historique de `pgliteDatadirLock`, conservé mot pour
 * mot pour que l'extraction ne change rien à ce qui tournait. Un appelant qui
 * veut une preuve plus exigeante — par exemple refuser de conclure sur un
 * verrou venu d'un AUTRE hôte, dont le PID ne veut rien dire ici — passe le
 * sien.
 */
export function defaultHolderLiveness(holder: ExclusiveLockHolder): boolean {
  return isPidAlive(holder.pid);
}

/**
 * Vivacité prudente entre hôtes : un verrou écrit par une autre machine est
 * tenu pour VIVANT, quel que soit son PID.
 *
 * Sur un système de fichiers partagé, « le pid 4711 n'existe pas ICI » ne dit
 * rien de la machine qui l'a écrit — où il tourne peut-être encore. Fermé par
 * défaut : on ne reprend que ce qu'on peut prouver mort chez soi.
 */
export function sameHostHolderLiveness(holder: ExclusiveLockHolder): boolean {
  if (holder.hostname !== hostname()) return true;
  return isPidAlive(holder.pid);
}

export interface AcquireExclusiveFileLockOptions {
  /** Comment décider qu'un détenteur est encore vivant. Défaut : le PID seul. */
  readonly isHolderAlive?: (holder: ExclusiveLockHolder) => boolean;
  /** Appelé AVANT de reprendre un verrou prouvé mort. Sert à le journaliser. */
  readonly onStaleReclaim?: (holder: ExclusiveLockHolder, attempt: number) => void;
  readonly maxReclaimAttempts?: number;
}

/**
 * Acquiert `file`, ou lève.
 *
 * - libre : acquis, et le détenteur est écrit dedans ;
 * - tenu par un vivant : `ExclusiveFileLockHeldError` — fermé, sans attente ;
 * - tenu par un mort prouvé : repris après notification, puis nouvelle
 *   tentative ATOMIQUE (et non une écriture directe : entre la suppression et
 *   la recréation, un troisième processus a le droit de gagner) ;
 * - illisible : `ExclusiveFileLockUnreadableError`, jamais une suppression.
 */
export function acquireExclusiveFileLock(
  file: string,
  options: AcquireExclusiveFileLockOptions = {},
): ExclusiveFileLock {
  const alive = options.isHolderAlive ?? defaultHolderLiveness;
  const maxAttempts = options.maxReclaimAttempts ?? DEFAULT_MAX_RECLAIM_ATTEMPTS;
  const holder = describeCurrentHolder();
  const payload = JSON.stringify(holder);

  mkdirSync(dirname(file), { recursive: true });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // 'wx' = O_CREAT | O_EXCL. Tout le verrou tient dans cet appel : il n'y
      // a pas de « vérifier puis agir » à laisser s'entrelacer.
      const fd = openSync(file, 'wx');
      try {
        writeSync(fd, payload);
      } finally {
        closeSync(fd);
      }
      return {
        file,
        holder,
        release: (): void => releaseExclusiveFileLock(file, holder.pid),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      const existing = readLockHolder(file);
      if (existing === null) throw new ExclusiveFileLockUnreadableError(file);
      if (alive(existing)) throw new ExclusiveFileLockHeldError(file, existing);

      options.onStaleReclaim?.(existing, attempt);
      try {
        unlinkSync(file);
      } catch {
        // Un autre processus l'a peut-être repris d'abord : reboucler sur la
        // création atomique, qui dira l'état réel.
      }
    }
  }

  throw new Error(`verrou ${file} non acquis après ${String(maxAttempts)} reprise(s) de verrou mort`);
}

/**
 * Retire le verrou, et seulement s'il est encore le NÔTRE.
 *
 * La relecture n'est pas une précaution décorative : après une reprise de
 * verrou mort, le fichier présent peut appartenir à un troisième processus.
 * Le supprimer parce qu'on a un jour tenu ce chemin libérerait la ressource
 * sous les pieds de son détenteur légitime.
 */
export function releaseExclusiveFileLock(file: string, ownedByPid: number): void {
  const existing = readLockHolder(file);
  if (existing !== null && existing.pid === ownedByPid) {
    try {
      unlinkSync(file);
    } catch {
      // Déjà parti — il n'y a rien à faire.
    }
  }
}
