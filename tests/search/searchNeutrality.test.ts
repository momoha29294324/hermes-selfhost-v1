import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { createLogger } from '@/lib/logging/logger';
import { ProspectRepository } from '@/lib/repo/prospects';
import { loadNiche, loadScoringProfile } from '@/lib/config/load';
import { HttpClient } from '@/lib/http/client';
import { ProviderScheduler } from '@/lib/http/scheduler';
import { SearchBudget } from '@/lib/discovery/search/budget';
import { resolveProspectViaSearch } from '@/lib/discovery/search/railSearch';
import { scoreProspect, type EvidenceLike } from '@/lib/pipeline/score';
import { sourceClass } from '@/lib/pipeline/classify';
import type { DnsResolver } from '@/lib/discovery/openweb/domainVerify';
import type { WebSearchProvider } from '@/lib/enrichment/webSearch';
import type { ProspectRow } from '@/lib/repo/types';
import type { Sql } from '@/lib/db/sql';

/**
 * R4 achète une source. Il n'achète aucun point, et aucune phrase.
 *
 * Deux propriétés distinctes, souvent confondues :
 *
 *   1. **Le score ignore la provenance.** Un prospect trouvé par un index payant
 *      vaut exactement autant qu'un prospect trouvé dans le registre. Sans cela,
 *      « ce prospect est bon » finirait par vouloir dire « nous avons payé pour
 *      le trouver », ce qui n'est pas une qualité de l'entreprise.
 *
 *   2. **Aucun texte du moteur n'atteint un message.** La chaîne réelle est
 *      evidence → research → message : c'est donc l'evidence qu'il faut garder
 *      propre. Un titre de résultat recopié là deviendrait un « fait observé »,
 *      et le message affirmerait avoir lu ce que Brave a résumé.
 *
 * La seconde propriété est aussi une clause contractuelle — les conditions Brave
 * interdisent d'utiliser les résultats pour alimenter un modèle — mais elle
 * serait de toute façon nécessaire : une preuve doit être quelque chose que nous
 * avons vu, pas quelque chose qu'on nous a résumé.
 */

const logger = createLogger({ test: 'search-neutrality' });
const niche = loadNiche('example-services');
const profile = loadScoringProfile('example-v1');
const NOW = new Date('2026-08-10T00:00:00Z');

let sql: Sql;
let dir: string;
let repo: ProspectRepository;
let campaignId: string;

/** Le texte que Brave a renvoyé. Aucun de ces fragments ne doit finir en base. */
const BRAVE_TITLE = 'Éclat Auto — LE MEILLEUR atelier de Lyon, noté 5 étoiles';
const BRAVE_SNIPPET = 'Éclat Auto est le leader du atelier à Lyon depuis 2015 … devis en 24h.';

const SITE_HTML = `<html><head><title>Éclat Auto</title></head><body>
  <h1>Éclat Auto</h1>
  <p>Vente de produits, lustrage et protection boutique en ligne à Lyon.</p>
  <footer>Éclat Auto — SIREN 944555201 — 12 rue des Lilas, 69003 Lyon</footer>
</body></html>`;

function resolver(hosts: Record<string, string[]>): DnsResolver {
  return {
    resolve4: async (hostname: string) => {
      const addresses = hosts[hostname];
      if (!addresses) throw new Error('ENOTFOUND');
      return addresses;
    },
    resolve6: async () => {
      throw new Error('ENOTFOUND');
    },
  };
}

function httpFor(pages: Record<string, string>): HttpClient {
  const fetchImpl = async (input: unknown): Promise<Response> => {
    const url = String(input);
    const body = pages[url];
    const status = body === undefined ? 404 : 200;
    return {
      ok: status === 200,
      status,
      url,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      body: null,
      text: async () => body ?? '',
    } as unknown as Response;
  };
  return new HttpClient({ sql: null, minHostIntervalMs: 0, fetchImpl });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'search-neutrality-'));
  sql = await createPgliteSql(join(dir, 'pgdata'));
  await migrate(sql);
  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ('n','N','example-services','{}'::jsonb) returning id`,
  );
  campaignId = rows[0]!.id;
  repo = new ProspectRepository(sql, logger);
}, 120_000);

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await sql.query('delete from search_provider_usage');
  await sql.query('delete from discovery_domain_candidates');
  await sql.query('delete from prospect_evidence');
  await sql.query('delete from prospect_discovery_origins');
  await sql.query('delete from prospect_identities');
  await sql.query('delete from prospects');
});

async function runRailOnFreshProspect(): Promise<{ prospectId: string }> {
  const inserted = await sql.query<ProspectRow>(
    `insert into prospects
       (campaign_id, canonical_key, display_name, brand_name, registry_id, country,
        address_line, postal_code, city, niche_verdict, stage)
     values ($1,'k1','Éclat Auto','Éclat Auto','944555201','FR','12 rue des Lilas','69003','Lyon','in_niche','discovered')
     returning *`,
    [campaignId],
  );
  const prospect = inserted[0]!;

  const provider: WebSearchProvider = {
    name: 'brave',
    availability: () => ({ ok: true }),
    search: async () => [
      { url: 'https://demo-54-exemple.fr/', title: BRAVE_TITLE, snippet: BRAVE_SNIPPET },
      { url: 'https://www.instagram.com/demo_account_27/', title: BRAVE_TITLE, snippet: 'Atelier à Lyon' },
    ],
  };

  await resolveProspectViaSearch(
    {
      sql,
      repo,
      http: httpFor({ 'https://demo-54-exemple.fr/': SITE_HTML }),
      logger,
      niche,
      scheduler: new ProviderScheduler({ logger, limits: { web_search: { minIntervalMs: 0, jitterMs: 0 } } }),
      provider,
      budget: new SearchBudget({
        sql,
        provider: 'brave',
        campaignSlug: 'n',
        runId: null,
        limits: { run: 10, daily: 20, monthly: 50 },
      }),
      campaignId,
      runId: null,
      resolver: resolver({ 'demo-54-exemple.fr': ['93.184.216.34'] }),
    },
    prospect,
  );

  return { prospectId: prospect.id };
}

describe('aucun texte du moteur n’atteint la base', () => {
  it('l’evidence écrite ne contient ni le titre ni la description du résultat', async () => {
    const { prospectId } = await runRailOnFreshProspect();
    const evidence = await repo.evidenceFor(prospectId);
    expect(evidence.length).toBeGreaterThan(0);

    const serialised = JSON.stringify(evidence);
    expect(serialised).not.toContain('LE MEILLEUR');
    expect(serialised).not.toContain('leader du atelier');
    expect(serialised).not.toContain('noté 5 étoiles');
    expect(serialised).not.toContain('devis en 24h');
  });

  /**
   * Le corollaire, et c'est lui qui compte : l'evidence n'est pas vide pour
   * autant. Ce qu'elle contient vient de la page que nous avons lue.
   */
  it('elle contient en revanche ce que NOUS avons lu sur le site', async () => {
    const { prospectId } = await runRailOnFreshProspect();
    const evidence = await repo.evidenceFor(prospectId);
    const website = evidence.find((item) => item.field === 'website_url');
    expect(website?.value_text).toBe('https://demo-54-exemple.fr');
    expect(website?.source_url).toBe('https://demo-54-exemple.fr/');
    expect(website?.provider).toBe('open_web');
  });

  it('la table de candidats ne contient pas davantage le texte du moteur', async () => {
    const { prospectId } = await runRailOnFreshProspect();
    const rows = await sql.query<Record<string, unknown>>(
      'select * from discovery_domain_candidates where prospect_id = $1',
      [prospectId],
    );
    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain('LE MEILLEUR');
    expect(serialised).not.toContain('leader du atelier');
  });

  it('le registre de dépense ne contient que notre requête', async () => {
    await runRailOnFreshProspect();
    const rows = await sql.query<{ query: string }>('select query from search_provider_usage');
    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain('LE MEILLEUR');
    expect(rows[0]?.query).toContain('"Éclat Auto"');
  });

  /**
   * Assertion au niveau du source, légitime pour la même raison que le test
   * jumeau de `sourceNeutrality` : rien à l'exécution ne distingue une evidence
   * bien construite d'une evidence où quelqu'un aurait ajouté `hit.title`, sauf
   * à appeler un modèle. Lire le fichier est la façon économique d'empêcher le
   * retour de la régression.
   */
  it('le rail n’écrit jamais un champ du moteur, même par inadvertance', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../src/lib/discovery/search/railSearch.ts', import.meta.url)),
      'utf8',
    );
    // Aucune interpolation d'un titre ou d'un extrait vers une valeur persistée.
    expect(source).not.toMatch(/valueText:\s*[^\n]*\.title/);
    expect(source).not.toMatch(/valueText:\s*[^\n]*\.snippet/);
    expect(source).not.toMatch(/valueText:\s*[^\n]*socialContext/);
    // Le garde-fou est effectivement appelé sur les chemins d'écriture.
    expect(source).toContain('assertNoSearchResultContent');
  });
});

describe('le score ignore le rail de recherche', () => {
  function evidence(provider: string): EvidenceLike[] {
    return [
      { id: 'e1', field: 'website_title', value_text: 'Éclat Auto — atelier', value_json: null, provider, source_url: null },
      { id: 'e2', field: 'website_quality', value_text: null, value_json: { ratio: 0.8, reasons: [] }, provider, source_url: null },
    ];
  }

  function base(): ProspectRow {
    return {
      id: 'p1',
      campaign_id: 'c1',
      canonical_key: 'registry_id:1',
      display_name: 'Éclat Auto',
      legal_name: null,
      brand_name: null,
      registry_id: '944555201',
      registry_source: 'sirene',
      country: 'FR',
      address_line: null,
      postal_code: '69003',
      city: 'Lyon',
      department: '69',
      region: '84',
      latitude: null,
      longitude: null,
      domain: 'demo-54-exemple.fr',
      website_url: 'https://demo-54-exemple.fr',
      instagram_handle: 'demo_account_27',
      facebook_url: null,
      email: null,
      phone: '+33478123456',
      google_place_id: null,
      google_rating: null,
      google_review_count: null,
      discovery_rail: null,
      discovery_provider: null,
      commercial_visibility: null,
      contactable: null,
      contact_channels: [],
      funnel_observable: null,
      funnel_signal_count: 0,
      funnel_summary: null,
      funnel_opportunity_count: 0,
      outreach_recommendation: null,
      outreach_recommendation_reason: null,
      identity_review: null,
      stage: 'qualified',
      niche_verdict: 'in_niche',
      niche_confidence: 0.9,
      score: null,
      score_band: null,
      dedupe_status: 'unique',
      merged_into_id: null,
      first_seen_at: NOW.toISOString(),
      last_enriched_at: null,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    };
  }

  it('un prospect trouvé par un moteur payant score comme un prospect du registre', () => {
    const viaSearch = scoreProspect({
      now: NOW,
      profile,
      prospect: { ...base(), discovery_rail: 'search', discovery_provider: 'brave' },
      evidence: evidence('brave'),
    });
    const viaRegistry = scoreProspect({
      now: NOW,
      profile,
      prospect: { ...base(), discovery_rail: 'long_tail', discovery_provider: 'sirene' },
      evidence: evidence('sirene'),
    });
    expect(viaSearch).toEqual(viaRegistry);
  });

  it('le rail `search` ne se distingue d’aucun autre rail', () => {
    const rails: ProspectRow['discovery_rail'][] = ['search', 'open_web', 'commercial', 'long_tail', 'social'];
    const reference = scoreProspect({
      now: NOW,
      profile,
      prospect: { ...base(), discovery_rail: 'search' },
      evidence: evidence('brave'),
    });
    for (const rail of rails) {
      const result = scoreProspect({
        now: NOW,
        profile,
        prospect: { ...base(), discovery_rail: rail },
        evidence: evidence('brave'),
      });
      expect(result, `le rail "${rail}" change le score`).toEqual(reference);
    }
  });

  /** Le fournisseur devient une classe épistémique, jamais une marque. */
  it('« brave » n’atteint pas un prompt sous son nom de marque', () => {
    expect(sourceClass('brave')).not.toContain('brave');
    expect(sourceClass('search:brave')).toBe('moteur de recherche');
  });
});
