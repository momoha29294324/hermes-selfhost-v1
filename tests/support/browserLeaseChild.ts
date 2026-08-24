/**
 * Un VRAI second processus, pour prouver ce qu'un seul ne peut pas prouver.
 *
 * Le bail du profil navigateur tient sur deux mécanismes différents : un
 * compteur en mémoire (réentrance, à l'intérieur d'un processus) et un fichier
 * créé en `O_EXCL` (exclusion, entre processus). Un test mono-processus
 * n'exerce que le premier — et passerait tout aussi bien si le second
 * n'existait pas. D'où ce script : il est lancé par `execFile`, il vit dans son
 * propre espace mémoire, et il ne partage avec le test que le système de
 * fichiers, exactement comme les deux runtimes Hermes.
 *
 * Il n'ouvre aucun navigateur, ne joint aucun service, n'écrit dans aucune
 * base. Il prend un bail, le dit, et attend.
 *
 *   tsx tests/support/browserLeaseChild.ts hold <profileDir> <holdMs>
 *   tsx tests/support/browserLeaseChild.ts try  <profileDir>
 */
import {
  acquireInstagramBrowserLease,
  InstagramBrowserProfileBusyError,
} from '@/lib/instagram/browserProfileLease';

const [mode, profileDir, holdMsRaw] = process.argv.slice(2);

if (mode === undefined || profileDir === undefined) {
  process.stderr.write('usage: browserLeaseChild.ts <hold|try> <profileDir> [holdMs]\n');
  process.exit(64);
}

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  if (mode === 'try') {
    try {
      const lease = acquireInstagramBrowserLease(profileDir as string);
      say(`ACQUIRED ${String(process.pid)}`);
      lease.release();
      say('RELEASED');
      return;
    } catch (error) {
      if (error instanceof InstagramBrowserProfileBusyError) {
        // Le code de sortie 3 dit « occupé » sans qu'on ait à lire le texte —
        // même convention que le worker autonome devant l'arrêt global.
        say(`BUSY ${String(error.holder.pid)}`);
        process.exit(3);
      }
      throw error;
    }
  }

  if (mode === 'hold') {
    const holdMs = Number.parseInt(holdMsRaw ?? '5000', 10);
    const lease = acquireInstagramBrowserLease(profileDir as string);
    say(`ACQUIRED ${String(process.pid)}`);
    // Volontairement SANS `finally` : un `SIGKILL` reçu ici ne doit rien
    // libérer, c'est ainsi que le test fabrique un verrou orphelin.
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    lease.release();
    say('RELEASED');
    return;
  }

  process.stderr.write(`mode inconnu : ${String(mode)}\n`);
  process.exit(64);
}

void main();
