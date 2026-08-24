import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import {
  assertCorpusDestructionAllowed,
  assertReadOnlyStatement,
  corpusFootprint,
  corpusIsEmpty,
  CorpusProtectedError,
  DESTROY_CORPUS_FLAG,
  NotReadOnlyError,
  readOnlyQuery,
} from '@/lib/db/safety';
import type { Sql } from '@/lib/db/sql';

/**
 * §27 et §25 du gate R3 : la base ne doit pas pouvoir être vidée par accident,
 * un outil de mesure ne doit pas pouvoir écrire, et rien ne doit pouvoir être
 * envoyé.
 *
 * Ces trois propriétés ont en commun de ne jamais échouer pendant le
 * développement. Elles échouent une fois, en production, et le coût est
 * asymétrique — d'où des tests qui les traitent comme des invariants plutôt
 * que comme des intentions.
 */

let sql: Sql;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-safety-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);
});

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Lecture seule
// ---------------------------------------------------------------------------
describe('assertReadOnlyStatement', () => {
  it('accepte une lecture', () => {
    expect(() => assertReadOnlyStatement('select count(*) from prospects')).not.toThrow();
    expect(() => assertReadOnlyStatement('with x as (select 1) select * from x')).not.toThrow();
    expect(() => assertReadOnlyStatement('explain select 1')).not.toThrow();
    expect(() => assertReadOnlyStatement('  SELECT 1;  ')).not.toThrow();
  });

  it('refuse toute mutation, même déguisée', () => {
    const refused = [
      'delete from prospects',
      'truncate prospects',
      'update prospects set score = 100',
      'drop table prospects',
      // Le piège : commence par select, écrit quand même.
      'select 1; delete from prospects',
      // L'autre piège : une CTE qui supprime avant de lire.
      'with gone as (delete from prospects returning *) select * from gone',
    ];
    for (const statement of refused) {
      expect(() => assertReadOnlyStatement(statement), statement).toThrow(NotReadOnlyError);
    }
  });

  it('ne se laisse pas piéger par un mot-clé dans une chaîne littérale', () => {
    expect(() =>
      assertReadOnlyStatement("select * from prospect_evidence where value_text = 'delete this'"),
    ).not.toThrow();
  });

  it('readOnlyQuery exécute une lecture et refuse une écriture', async () => {
    const rows = await readOnlyQuery<{ n: string }>(sql, 'select count(*)::text as n from prospects');
    expect(rows[0]?.n).toBe('0');
    await expect(readOnlyQuery(sql, 'delete from prospects')).rejects.toBeInstanceOf(NotReadOnlyError);
  });
});

// ---------------------------------------------------------------------------
// Destruction du corpus
// ---------------------------------------------------------------------------
describe('protection du corpus', () => {
  it('laisse partir une base vide sans cérémonie', async () => {
    const footprint = await corpusFootprint(sql);
    expect(corpusIsEmpty(footprint)).toBe(true);
    expect(() => assertCorpusDestructionAllowed(footprint, [])).not.toThrow();
  });

  it('refuse de détruire un corpus non vide sans drapeau explicite', async () => {
    await sql.query(
      `insert into campaigns (slug, name, niche_key, config) values ('safety','Safety','example-services','{}'::jsonb)`,
    );
    const campaign = await sql.query<{ id: string }>(`select id from campaigns where slug = 'safety'`);
    await sql.query(
      `insert into prospects (campaign_id, canonical_key, display_name) values ($1, 'k1', 'Test Atelier')`,
      [campaign[0]?.id],
    );

    const footprint = await corpusFootprint(sql);
    expect(footprint.prospects).toBe(1);

    const failure = (() => {
      try {
        assertCorpusDestructionAllowed(footprint, ['--reset']);
        return null;
      } catch (error) {
        return error;
      }
    })();

    expect(failure).toBeInstanceOf(CorpusProtectedError);
    // Le refus doit dire ce qu'il protège, sinon il sera contourné à l'aveugle.
    expect((failure as Error).message).toContain('1 prospect(s)');
    expect((failure as Error).message).toContain(DESTROY_CORPUS_FLAG);
  });

  it('cède quand le drapeau est tapé en toutes lettres', async () => {
    const footprint = await corpusFootprint(sql);
    expect(() => assertCorpusDestructionAllowed(footprint, ['--reset', DESTROY_CORPUS_FLAG])).not.toThrow();
  });

  it('ne lève pas sur une base sans schéma', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'hermes-safety-empty-'));
    const fresh = await createPgliteSql(emptyDir);
    const footprint = await corpusFootprint(fresh);
    expect(corpusIsEmpty(footprint)).toBe(true);
    await fresh.close();
    rmSync(emptyDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Outreach : toujours impossible
// ---------------------------------------------------------------------------
describe('aucun envoi n’est possible', () => {
  const root = resolve(__dirname, '..');

  function sourceFiles(dirPath: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      const full = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', '.next', '.git', 'var'].includes(entry.name)) continue;
        out.push(...sourceFiles(full));
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  const files = [...sourceFiles(join(root, 'src')), ...sourceFiles(join(root, 'services'))];

  it('R3 n’a introduit aucun client d’envoi', () => {
    /**
     * R3 ajoute cinq rails et un client Graph. Le risque n'est pas théorique :
     * le même jeton Meta qui lit une Page peut publier ou envoyer un message.
     * Ce test lit le code source parce que c'est le seul endroit où « il
     * n'existe pas de code d'envoi » peut être vérifié.
     */
    const forbidden = [
      /graph\.facebook\.com\/[^'"`]*\/messages/i,
      /\/me\/messages/i,
      /nodemailer/i,
      /sendgrid/i,
      /twilio/i,
      /allmysms/i,
      /\bsendMessage\s*\(/,
      /\bsendDm\s*\(/,
      /\bsendEmail\s*\(/,
    ];

    for (const file of files) {
      const body = readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        expect(pattern.test(body), `${file} contient un motif d'envoi : ${pattern}`).toBe(false);
      }
    }
  });

  it('les adaptateurs Meta n’émettent que des GET', () => {
    for (const name of ['pagesSearch.ts', 'businessDiscovery.ts', 'access.ts']) {
      const body = readFileSync(join(root, 'src/lib/discovery/meta', name), 'utf8');
      expect(/method:\s*'POST'/.test(body), `${name} émet un POST`).toBe(false);
    }
  });

  it('la table des envois reste vide et le drapeau reste à zéro', async () => {
    const events = await readOnlyQuery<{ n: string }>(sql, 'select count(*)::text as n from outreach_events');
    expect(events[0]?.n).toBe('0');
    expect(process.env['OUTBOUND_ALLOW_SENDING'] ?? '0').toBe('0');
  });
});
