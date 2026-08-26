import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PUBLISHED_MIGRATION_CHECKSUMS } from './fixtures/publishedMigrations';

/**
 * « Une instance déjà installée doit pouvoir se mettre à jour. »
 *
 * C'est la seule propriété que ce fichier protège, et elle ne se voit pas dans
 * une revue de diff : un fichier de migration modifié se lit comme un
 * commentaire corrigé, et se comporte comme une mise à jour cassée chez tous
 * ceux qui tournent déjà.
 */
const DIR = 'db/migrations';

function checksum(file: string): string {
  return createHash('sha256').update(readFileSync(join(DIR, file), 'utf8')).digest('hex').slice(0, 32);
}

describe('les migrations publiées ne changent plus', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

  it('chaque migration livrée porte l’empreinte sous laquelle elle a été publiée', () => {
    for (const file of files) {
      const version = file.replace(/\.sql$/u, '');
      const published = PUBLISHED_MIGRATION_CHECKSUMS[version];
      // Une migration NOUVELLE n'a pas encore d'empreinte publiée : c'est le
      // seul cas légitime, et il se règle en l'ajoutant à la liste.
      expect(published, `${version} n’est pas dans PUBLISHED_MIGRATION_CHECKSUMS`).toBeDefined();
      expect(checksum(file), `${version} a été modifiée après publication`).toBe(published);
    }
  });

  it('aucune migration publiée n’a disparu', () => {
    const present = new Set(files.map((f) => f.replace(/\.sql$/u, '')));
    for (const version of Object.keys(PUBLISHED_MIGRATION_CHECKSUMS)) {
      expect(present.has(version), `${version} a été supprimée`).toBe(true);
    }
  });

  it('la numérotation se suit, sans trou', () => {
    files.forEach((file, index) => {
      expect(file.slice(0, 4)).toBe(String(index + 1).padStart(4, '0'));
    });
  });
});
