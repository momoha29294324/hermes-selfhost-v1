import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertReadOnlyStatement, NotReadOnlyError } from '@/lib/db/safety';
import { MEASUREMENT_STATEMENTS, TARGET_CORPUS_SQL } from '@/lib/discovery/search/measure';

/**
 * Le benchmark mesure un corpus qu'on a mis des semaines à constituer.
 *
 * Le §17 du gate est catégorique : pas de DELETE, pas de TRUNCATE, pas de reset,
 * aucune suppression d'un prospect historique. Les seules écritures autorisées
 * sont celles que le pipeline produit normalement — evidences et résolutions.
 *
 * Ce fichier vérifie deux choses différentes :
 *
 *   - que les requêtes de MESURE du benchmark passent le garde-fou syntaxique.
 *     Elles sont extraites du fichier réel, pas recopiées : une copie
 *     divergerait du code au premier ajout de colonne, et le test cesserait
 *     silencieusement de protéger quoi que ce soit ;
 *   - que le fichier ne contient aucune instruction destructrice, même dans une
 *     branche jamais empruntée. Une commande de mesure qui pourrait détruire
 *     n'est pas une commande de mesure.
 */

const source = readFileSync(
  fileURLToPath(new URL('../../src/cli/search-benchmark.ts', import.meta.url)),
  'utf8',
);

describe('le benchmark R4 ne peut pas abîmer le corpus', () => {
  it('n’écrit aucune instruction destructrice, dans aucune branche', () => {
    for (const forbidden of [/\bdelete\s+from\b/i, /\btruncate\b/i, /\bdrop\s+table\b/i, /--reset\b/]) {
      expect(forbidden.test(source), `le benchmark contient ${String(forbidden)}`).toBe(false);
    }
  });

  /**
   * La mesure encadrante doit passer par `readOnlyQuery`, pas par `sql.query`.
   * La différence est exactement celle entre « on a relu le code » et « le code
   * refuse ».
   */
  it('mesure à travers readOnlyQuery, jamais par un sql.query nu', () => {
    expect(source).toContain('readOnlyQuery');
    // Aucune lecture directe : toutes les requêtes du CLI passent par le garde-fou.
    expect(source.match(/\bsql\.query\(/g), 'un sql.query nu est apparu dans le benchmark').toBe(null);
  });

  /**
   * Les requêtes viennent du module que le CLI importe réellement, pas d'une
   * copie. C'est tout l'intérêt de les avoir extraites : le test et le benchmark
   * lisent la même chaîne, donc le garde-fou ne peut pas dériver du code.
   */
  it('chaque requête de mesure passe le garde-fou', () => {
    expect(MEASUREMENT_STATEMENTS).toHaveLength(3);
    for (const statement of MEASUREMENT_STATEMENTS) {
      expect(() => assertReadOnlyStatement(statement.sql, statement.label)).not.toThrow();
    }
  });

  it('le corpus ciblé est la définition du §10 : in_niche sans le KPI combiné', () => {
    expect(TARGET_CORPUS_SQL).toContain("niche_verdict = 'in_niche'");
    expect(TARGET_CORPUS_SQL).toContain("dedupe_status <> 'merged'");
    expect(TARGET_CORPUS_SQL).toContain('not (coalesce(contactable, false) and coalesce(funnel_observable, false))');
  });

  /**
   * `contactable` est nullable, et `not (null and null)` vaut `null` : sans
   * `coalesce`, la cible EXCLURAIT les prospects dont la joignabilité n'a jamais
   * été évaluée — précisément ceux qui ont le plus besoin de ce rail. Le test
   * fige le raisonnement plutôt que le texte.
   */
  it('un prospect jamais évalué fait partie de la cible', async () => {
    const { createPgliteSql } = await import('@/lib/db/pglite');
    const { migrate } = await import('@/lib/db/migrate');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const dir = mkdtempSync(join(tmpdir(), 'search-target-'));
    const sql = await createPgliteSql(join(dir, 'pgdata'));
    try {
      await migrate(sql);
      const campaign = await sql.query<{ id: string }>(
        `insert into campaigns (slug, name, niche_key, config) values ('t','T','example-services','{}'::jsonb) returning id`,
      );
      const campaignId = campaign[0]!.id;

      // Trois prospects : jamais évalué, joignable mais illisible, complet.
      await sql.query(
        `insert into prospects (campaign_id, canonical_key, display_name, country, niche_verdict, stage, contactable, funnel_observable)
         values ($1,'a','Jamais évalué','FR','in_niche','discovered', null, null),
                ($1,'b','Partiel','FR','in_niche','discovered', true, false),
                ($1,'c','Complet','FR','in_niche','discovered', true, true)`,
        [campaignId],
      );

      const targeted = await sql.query<{ display_name: string }>(TARGET_CORPUS_SQL, [100]);
      const names = targeted.map((row) => row.display_name).sort();
      expect(names).toEqual(['Jamais évalué', 'Partiel']);
    } finally {
      await sql.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  /** Le garde-fou lui-même, sur les formes qui trompent une relecture humaine. */
  it('le garde-fou refuse ce qui ressemble à une lecture', () => {
    expect(() => assertReadOnlyStatement('select 1 from prospects')).not.toThrow();
    expect(() => assertReadOnlyStatement('select 1; delete from prospects')).toThrow(NotReadOnlyError);
    expect(() =>
      assertReadOnlyStatement('with gone as (delete from prospects returning *) select * from gone'),
    ).toThrow(NotReadOnlyError);
  });
});

describe('le rail écrit, et seulement ce que le pipeline écrit normalement', () => {
  const rail = readFileSync(
    fileURLToPath(new URL('../../src/lib/discovery/search/railSearch.ts', import.meta.url)),
    'utf8',
  );

  it('n’efface jamais rien', () => {
    for (const forbidden of [/\bdelete\s+from\b/i, /\btruncate\b/i, /\bdrop\b/i]) {
      expect(forbidden.test(rail), `le rail contient ${String(forbidden)}`).toBe(false);
    }
  });

  /**
   * `fillMissingColumns` ne remplit que ce qui est nul : un fait déjà observé
   * n'est pas remplacé par un fait venu d'un moteur. C'est ce qui garantit qu'un
   * rail payant ne peut pas dégrader une donnée acquise gratuitement.
   */
  it('remplit les colonnes manquantes plutôt que d’écraser', () => {
    expect(rail).toContain('fillMissingColumns');
    expect(rail.match(/\bupdate\s+prospects\b/i), 'le rail met à jour prospects directement').toBe(null);
  });

  it('n’insère que dans la table de candidats de R3', () => {
    const inserts = [...rail.matchAll(/insert\s+into\s+([a-z_]+)/gi)].map((match) => match[1]);
    expect(inserts).toEqual(['discovery_domain_candidates']);
  });
});
