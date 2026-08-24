import { spawn, execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireInstagramBrowserLease,
  inspectInstagramBrowserLease,
  instagramBrowserLeasePath,
  InstagramBrowserProfileBusyError,
  resolveInstagramProfilePath,
} from '@/lib/instagram/browserProfileLease';
import { loadInstagramRail } from '@/lib/config/load';
import type { InstagramRailConfig } from '@/lib/config/schema';
import { PlaywrightInstagramRail } from '@/lib/instagram/playwrightRail';
import { InstagramRailError } from '@/lib/instagram/rail';

/**
 * Le bail du profil navigateur Instagram.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce fichier prouve, et pourquoi il fallait l'écrire
 * ---------------------------------------------------------------------------
 * Deux runtimes Hermes tournent en permanence sur la même machine et lisent le
 * même `session.profileDir` : la relève entrante et le worker sortant. Rien ne
 * les empêchait d'ouvrir le même profil Chromium en même temps — et la panne
 * qui en découle ne ressemble pas à une panne de verrou, elle ressemble à
 * « Instagram nous a déconnectés », dont le seul remède est une reconnexion
 * manuelle que ce dépôt ne sait pas faire à notre place.
 *
 * Aucun test de ce fichier n'ouvre de navigateur, ne joint Instagram, n'écrit
 * en base ni ne lit le vrai profil de production : chacun travaille dans un
 * répertoire temporaire qui lui appartient.
 */

const CHILD = resolve(process.cwd(), 'tests/support/browserLeaseChild.ts');

/**
 * Le processus enfant est lancé par `node` DIRECTEMENT, avec les crochets tsx,
 * et non par le script `node_modules/.bin/tsx`.
 *
 * Ce dernier n'exécute pas le code lui-même : il relance un second `node` et
 * lui passe la main. On se retrouve donc avec DEUX processus, et tuer le
 * premier — ce que fait le test du verrou orphelin — laisse le second vivant,
 * tenant toujours le bail, ses tubes ouverts, et le test suspendu à attendre
 * une fin qui n'arrive pas. C'est la forme exacte que prend le `node --require
 * …/preflight.cjs --import …/loader.mjs` des runtimes de ce dépôt.
 */
const CHILD_ARGV: readonly string[] = [
  '--require',
  resolve(process.cwd(), 'node_modules/tsx/dist/preflight.cjs'),
  '--import',
  `file://${resolve(process.cwd(), 'node_modules/tsx/dist/loader.mjs')}`,
];

/** Un PID vivant qui n'est PAS le nôtre. `launchd` (1) existe toujours sur macOS. */
const FOREIGN_LIVE_PID = 1;
/** Un PID qu'aucune machine n'attribue : le noyau répond `ESRCH`. */
const DEAD_PID = 999_999;

let dir: string;
let profile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-ig-lease-'));
  profile = join(dir, 'profile');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * La configuration RÉELLE du rail, avec le seul champ qui change : le profil.
 *
 * Reconstruire un objet de configuration à la main ferait passer ce test sur
 * une forme que la production n'a pas. Ici, tout vient de
 * `config/instagram.json` — timeouts, locale, plafonds — sauf le répertoire,
 * redirigé vers un temporaire pour que rien ne touche le profil de production.
 */
function railConfigOn(profileDir: string): InstagramRailConfig {
  const base = loadInstagramRail();
  return { ...base, session: { ...base.session, profileDir, headless: true } };
}

function writeForeignLock(profileDir: string, holder: Record<string, unknown>): string {
  const file = instagramBrowserLeasePath(profileDir);
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(file, JSON.stringify(holder));
  return file;
}

/** Lance le processus enfant et rend sa première ligne de sortie. */
function holdInChild(profileDir: string, holdMs: number): Promise<{ pid: number; kill: () => void; done: Promise<void> }> {
  const child = spawn(process.execPath, [...CHILD_ARGV, CHILD, 'hold', profileDir, String(holdMs)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const done = new Promise<void>((resolveDone) => child.on('close', () => resolveDone()));
  return new Promise((resolveReady, rejectReady) => {
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const match = /ACQUIRED (\d+)/.exec(buffer);
      if (match?.[1] !== undefined) {
        resolveReady({ pid: Number(match[1]), kill: () => child.kill('SIGKILL'), done });
      }
    });
    child.on('error', rejectReady);
    child.on('close', (code) => {
      if (buffer.includes('ACQUIRED')) return;
      rejectReady(new Error(`l'enfant est sorti (code ${String(code)}) sans prendre le bail : ${buffer}`));
    });
  });
}

/** Tente le bail dans un second processus. Rend le code de sortie et la sortie. */
function tryInChild(profileDir: string): { status: number; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, [...CHILD_ARGV, CHILD, 'try', profileDir], { encoding: 'utf8' });
    return { status: 0, stdout };
  } catch (error) {
    const err = error as { status?: number; stdout?: string };
    return { status: err.status ?? -1, stdout: err.stdout ?? '' };
  }
}

// ---------------------------------------------------------------------------
// 1. L'exclusion, dans un processus
// ---------------------------------------------------------------------------

describe('acquisition et libération', () => {
  it('un premier détenteur obtient le bail, et le fichier le nomme', () => {
    const lease = acquireInstagramBrowserLease(profile);
    try {
      expect(lease.reentrant).toBe(false);
      expect(existsSync(lease.lockFile)).toBe(true);
      const holder: unknown = JSON.parse(readFileSync(lease.lockFile, 'utf8'));
      expect(holder).toMatchObject({ pid: process.pid, hostname: hostname() });
    } finally {
      lease.release();
    }
  });

  it('libéré, le bail redevient disponible et le fichier disparaît', () => {
    const first = acquireInstagramBrowserLease(profile);
    const file = first.lockFile;
    first.release();
    expect(existsSync(file)).toBe(false);

    const second = acquireInstagramBrowserLease(profile);
    expect(second.reentrant).toBe(false);
    second.release();
  });

  it('un `release()` appelé deux fois ne libère pas le bail d’autrui', () => {
    const first = acquireInstagramBrowserLease(profile);
    first.release();
    // Quelqu'un d'autre prend le profil...
    const second = acquireInstagramBrowserLease(profile);
    // ... et le premier détenteur, mal écrit, rappelle `release()`.
    first.release();
    // Le bail du second est intact : c'est lui qui tient encore le fichier.
    expect(existsSync(second.lockFile)).toBe(true);
    const holder = inspectInstagramBrowserLease(profile);
    expect(holder.heldByThisProcess).toBe(true);
    second.release();
  });

  it('réentrant DANS un processus : deux prises, un seul fichier, libéré à la dernière', () => {
    // C'est le cas réel du rail entrant : le tour prend le bail avant d'ouvrir
    // sa ligne de relève, puis le rail le redemande en ouvrant Chromium.
    const outer = acquireInstagramBrowserLease(profile);
    const inner = acquireInstagramBrowserLease(profile);

    expect(outer.reentrant).toBe(false);
    expect(inner.reentrant).toBe(true);
    expect(inner.lockFile).toBe(outer.lockFile);

    inner.release();
    // Encore tenu : le navigateur s'est refermé, mais le tour n'a pas fini.
    expect(existsSync(outer.lockFile)).toBe(true);

    outer.release();
    expect(existsSync(outer.lockFile)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. L'exclusion, ENTRE processus — le seul mécanisme qui compte vraiment
// ---------------------------------------------------------------------------

describe('exclusion entre processus', () => {
  it('un détenteur vivant refuse le second : BUSY, et son bail est intact', () => {
    const file = writeForeignLock(profile, {
      pid: FOREIGN_LIVE_PID,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
      cmd: 'un autre runtime Hermes',
    });
    const before = readFileSync(file, 'utf8');

    expect(() => acquireInstagramBrowserLease(profile)).toThrow(InstagramBrowserProfileBusyError);

    // Jamais volé : le fichier est exactement celui qu'on a trouvé.
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('l’erreur nomme le détenteur, pour qu’un opérateur sache qui attendre', () => {
    writeForeignLock(profile, {
      pid: FOREIGN_LIVE_PID,
      hostname: hostname(),
      startedAt: '2026-08-21T19:00:00.000Z',
      cmd: 'ig:inbound:run --loop',
    });
    try {
      acquireInstagramBrowserLease(profile);
      expect.unreachable('le bail aurait dû être refusé');
    } catch (error) {
      expect(error).toBeInstanceOf(InstagramBrowserProfileBusyError);
      const busy = error as InstagramBrowserProfileBusyError;
      expect(busy.code).toBe('IG_BROWSER_PROFILE_BUSY');
      expect(busy.holder.pid).toBe(FOREIGN_LIVE_PID);
      expect(busy.message).toContain('ig:inbound:run --loop');
    }
  });

  it('un VRAI second processus est refusé, puis passe une fois le premier sorti', async () => {
    const holder = await holdInChild(profile, 1_500);
    try {
      const refused = tryInChild(profile);
      expect(refused.status).toBe(3);
      expect(refused.stdout).toContain(`BUSY ${String(holder.pid)}`);
    } finally {
      await holder.done;
    }

    const granted = tryInChild(profile);
    expect(granted.status).toBe(0);
    expect(granted.stdout).toContain('ACQUIRED');
  }, 30_000);

  it('le processus de test lui-même est refusé pendant qu’un autre tient le profil', async () => {
    const holder = await holdInChild(profile, 1_200);
    try {
      expect(() => acquireInstagramBrowserLease(profile)).toThrow(InstagramBrowserProfileBusyError);
    } finally {
      await holder.done;
    }
    const after = acquireInstagramBrowserLease(profile);
    expect(after.reentrant).toBe(false);
    after.release();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 3. Le cas crash — reprendre un mort, jamais un vivant
// ---------------------------------------------------------------------------

describe('verrou orphelin', () => {
  it('un détenteur PROUVÉ mort est repris, et le fichier change de main', () => {
    const file = writeForeignLock(profile, {
      pid: DEAD_PID,
      hostname: hostname(),
      startedAt: new Date(0).toISOString(),
      cmd: 'un runtime tué sans finally',
    });

    const lease = acquireInstagramBrowserLease(profile);
    try {
      const holder: unknown = JSON.parse(readFileSync(file, 'utf8'));
      expect(holder).toMatchObject({ pid: process.pid });
    } finally {
      lease.release();
    }
  });

  it('un détenteur tué par SIGKILL laisse un verrou que le suivant reprend', async () => {
    const holder = await holdInChild(profile, 60_000);
    holder.kill();
    await holder.done;

    // Le fichier est encore là — l'enfant n'a rien libéré, c'est le point.
    expect(existsSync(instagramBrowserLeasePath(profile))).toBe(true);

    const lease = acquireInstagramBrowserLease(profile);
    expect(lease.reentrant).toBe(false);
    lease.release();
  }, 30_000);

  it('un verrou VENU D’UN AUTRE HÔTE n’est jamais repris, même avec un pid mort', () => {
    // Le pid d'une autre machine ne veut rien dire ici : « il n'existe pas
    // chez moi » ne prouve pas qu'il n'existe pas là-bas. Fermé par défaut.
    writeForeignLock(profile, {
      pid: DEAD_PID,
      hostname: 'une-autre-machine',
      startedAt: new Date(0).toISOString(),
      cmd: 'runtime distant',
    });
    expect(() => acquireInstagramBrowserLease(profile)).toThrow(InstagramBrowserProfileBusyError);
  });

  it('un fichier de bail ILLISIBLE ferme la porte au lieu de l’ouvrir', () => {
    const file = instagramBrowserLeasePath(profile);
    mkdirSync(profile, { recursive: true });
    writeFileSync(file, 'ceci n’est pas un verrou');

    expect(() => acquireInstagramBrowserLease(profile)).toThrow(InstagramBrowserProfileBusyError);
    // Et surtout : il n'a pas été supprimé « parce qu'il était cassé ».
    expect(readFileSync(file, 'utf8')).toBe('ceci n’est pas un verrou');
  });
});

// ---------------------------------------------------------------------------
// 4. Le chemin RÉEL — ce qui rend un alias inoffensif
// ---------------------------------------------------------------------------

describe('résolution du chemin du profil', () => {
  it('un lien symbolique et sa cible partagent UN SEUL bail', () => {
    // C'est exactement la situation d'avant la migration :
    // `hermes/var/instagram/profile` était un lien vers le profil
    // physique du worktree R7. Deux chemins, un seul répertoire — et donc, si
    // le bail était nommé d'après le chemin écrit, deux verrous distincts pour
    // une seule ressource. La pire forme de sécurité : celle qui rassure.
    mkdirSync(profile, { recursive: true });
    const alias = join(dir, 'alias-profile');
    symlinkSync(profile, alias);

    expect(resolveInstagramProfilePath(alias)).toBe(resolveInstagramProfilePath(profile));
    expect(instagramBrowserLeasePath(alias)).toBe(instagramBrowserLeasePath(profile));

    const viaReal = acquireInstagramBrowserLease(profile);
    try {
      // Pris par le chemin réel : la demande par l'alias est refusée, dans un
      // processus comme dans un autre.
      expect(tryInChild(alias).status).toBe(3);
    } finally {
      viaReal.release();
    }
    expect(tryInChild(alias).status).toBe(0);
  }, 30_000);

  it('le fichier de bail est un VOISIN du profil, jamais un fichier dedans', () => {
    // Tout ce qui vit dans un `user-data-dir` appartient à Chromium, qui le
    // réécrit — et un profil se déplace, se sauvegarde, se recopie.
    const lease = acquireInstagramBrowserLease(profile);
    try {
      expect(lease.lockFile.startsWith(`${profile}/`)).toBe(false);
      expect(readdirSync(profile)).toHaveLength(0);
    } finally {
      lease.release();
    }
  });

  it('un profil encore inexistant se résout sans rien créer', () => {
    const absent = join(dir, 'jamais-cree');
    expect(resolveInstagramProfilePath(absent)).toBe(resolve(process.cwd(), absent));
    expect(existsSync(absent)).toBe(false);
    // `inspect` observe, il ne réserve pas : il ne doit rien créer non plus.
    expect(inspectInstagramBrowserLease(absent).held).toBe(false);
    expect(existsSync(absent)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Le rail — aucun chemin vers Chromium qui ne passe par le bail
// ---------------------------------------------------------------------------

describe('couverture du rail', () => {
  it('le rail refuse d’ouvrir un profil occupé, et le dit avec IG_BROWSER_PROFILE_BUSY', async () => {
    writeForeignLock(profile, {
      pid: FOREIGN_LIVE_PID,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
      cmd: 'ig:autonomous:worker --loop',
    });

    const rail = new PlaywrightInstagramRail({ config: railConfigOn(profile), screenshotDir: null, workerId: 'test' });

    // `ensureSession()` est le seul chemin vers `open()`, donc vers Chromium.
    // Il lève AVANT d'avoir chargé Playwright : aucun navigateur n'a démarré.
    await expect(rail.ensureSession()).rejects.toMatchObject({
      name: 'InstagramRailError',
      code: 'IG_BROWSER_PROFILE_BUSY',
    });
    await rail.close();
  });

  it('une contention n’est PAS une panne de navigateur', async () => {
    // La distinction porte tout le reste : `IG_BROWSER_LAUNCH_FAILED` compte
    // comme un échec de rail (et ferme le rail au bout de trois), tandis qu'un
    // profil occupé est un refus dont le worker se remet tout seul.
    writeForeignLock(profile, {
      pid: FOREIGN_LIVE_PID,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
      cmd: 'ig:inbound:run --loop',
    });
    const rail = new PlaywrightInstagramRail({ config: railConfigOn(profile), screenshotDir: null, workerId: 'test' });

    const error = await rail.ensureSession().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(InstagramRailError);
    expect((error as InstagramRailError).code).not.toBe('IG_BROWSER_LAUNCH_FAILED');
    await rail.close();
  });

  it('AUCUN lancement de Chromium dans src/ ne se passe du bail', () => {
    // Une garde qui dépend de la discipline de l'appelant n'en est pas une.
    // Ce test relit les SOURCES : tout fichier qui appelle
    // `launchPersistentContext` doit aussi acquérir un bail, dans le même
    // fichier. Un nouveau chemin d'ouverture écrit demain sans bail fait
    // échouer ce test, et non un incident de production six semaines plus tard.
    const launchers: string[] = [];
    const walk = (path: string): void => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) {
          walk(child);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const source = readFileSync(child, 'utf8');
        if (source.includes('launchPersistentContext(')) launchers.push(child);
      }
    };
    walk(resolve(process.cwd(), 'src'));

    // Le rail partagé et le rail d'observation. Le seuil est un PLANCHER : ce
    // qui compte n'est pas combien de fichiers ouvrent un profil, c'est
    // qu'aucun ne le fasse sans bail — la boucle ci-dessous. Le plancher
    // existe seulement pour qu'un test qui ne trouverait plus AUCUN lanceur
    // (chemin renommé, marche cassée) ne passe pas au vert en ne vérifiant rien.
    expect(launchers.length).toBeGreaterThanOrEqual(2);
    for (const file of launchers) {
      const source = readFileSync(file, 'utf8');
      const leased =
        source.includes('acquireInstagramBrowserLease') || source.includes('leaseProfileOrThrow(');
      expect(leased, `${file} ouvre un profil Chromium sans prendre de bail`).toBe(true);
    }
  });
});
