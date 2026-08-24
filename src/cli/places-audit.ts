#!/usr/bin/env tsx
/**
 * Google contamination audit of the permanent store.
 *
 *   npm run places:audit
 *
 * Point 19 of the R2.1 gate asks for proof rather than for a claim. "No Google
 * content was stored" is not something a developer can assert from memory: the
 * rail has four stages, the repository has two write paths, and the corpus
 * predates both. So the audit interrogates the database directly and reports
 * what it finds, including when what it finds is nothing.
 *
 * Every check is written so that PASSING requires an empty result. A check that
 * passes because its query was wrong would be indistinguishable from a check
 * that passes because the database is clean, so each one also reports the size
 * of the population it searched — a check that scanned zero rows is reported as
 * VIDE, never as OK.
 *
 * Read-only by construction: no statement here writes.
 */
import { getSql } from '@/lib/db';
import { countExpiredLocations } from '@/lib/discovery/places/retention';
import type { Sql } from '@/lib/db/sql';

interface Check {
  id: string;
  question: string;
  /** Rows that would prove contamination. Empty = clean. */
  offenders: () => Promise<Record<string, unknown>[]>;
  /** How many rows the check actually looked at. */
  population: () => Promise<number>;
}

async function count(sql: Sql, statement: string, params: unknown[] = []): Promise<number> {
  const rows = await sql.query<{ count: string }>(statement, params);
  return Number.parseInt(rows[0]?.count ?? '0', 10) || 0;
}

function buildChecks(sql: Sql): Check[] {
  return [
    {
      id: 'evidence_provider',
      question: 'Une evidence permanente est-elle attribuée à Google ?',
      offenders: () =>
        sql.query(
          `select id, prospect_id, field, provider, left(coalesce(value_text,''), 60) as value
             from prospect_evidence
            where provider in ('google_places','google','google_maps')
            limit 20`,
        ),
      population: () => count(sql, 'select count(*)::text as count from prospect_evidence'),
    },
    {
      id: 'sources_provider',
      question: 'Un payload brut Google est-il conservé dans prospect_sources ?',
      offenders: () =>
        sql.query(
          `select id, prospect_id, provider from prospect_sources
            where provider in ('google_places','google','google_maps')
            limit 20`,
        ),
      population: () => count(sql, 'select count(*)::text as count from prospect_sources'),
    },
    {
      id: 'ratings',
      question: 'Une note ou un nombre d’avis Google est-il persisté sur un prospect ?',
      offenders: () =>
        sql.query(
          `select id, display_name, google_rating, google_review_count from prospects
            where google_rating is not null or google_review_count is not null
            limit 20`,
        ),
      population: () => count(sql, 'select count(*)::text as count from prospects'),
    },
    {
      id: 'rating_evidence',
      question: 'Une note Google traîne-t-elle dans prospect_evidence, quel que soit le provider ?',
      offenders: () =>
        sql.query(
          `select id, prospect_id, field, provider, value_text from prospect_evidence
            where field in ('google_rating','google_review_count')
            limit 20`,
        ),
      population: () => count(sql, 'select count(*)::text as count from prospect_evidence'),
    },
    {
      id: 'orphan_place_id',
      question:
        'Un prospect porte-t-il un place_id sans qu’une source indépendante l’ait identifié ?',
      offenders: () =>
        sql.query(
          // A place ID on a prospect is legitimate — it is the join key. What is
          // NOT legitimate is a prospect that exists ONLY because Places said so:
          // that would be a Google-sourced business wearing our schema.
          `select p.id, p.display_name, p.google_place_id
             from prospects p
            where p.google_place_id is not null
              and not exists (
                select 1 from prospect_sources s
                 where s.prospect_id = p.id
                   and s.provider not in ('google_places','google','google_maps')
              )
            limit 20`,
        ),
      population: () =>
        count(sql, 'select count(*)::text as count from prospects where google_place_id is not null'),
    },
    {
      id: 'unresolved_candidate_became_prospect',
      question: 'Un candidat non résolu a-t-il quand même produit un prospect ?',
      offenders: () =>
        sql.query(
          `select place_id, status, resolution, prospect_id from google_place_candidates
            where prospect_id is not null
              and (resolution is null or resolution not in ('confirmed','probable'))
            limit 20`,
        ),
      population: () => count(sql, 'select count(*)::text as count from google_place_candidates'),
    },
    {
      id: 'expired_coordinates',
      question: 'Des coordonnées Places ont-elles dépassé leur bail de 30 jours ?',
      offenders: async () =>
        sql.query(
          `select place_id, location_expires_at from google_place_candidates
            where location_expires_at is not null and location_expires_at <= now()
            limit 20`,
        ),
      population: () =>
        count(
          sql,
          'select count(*)::text as count from google_place_candidates where latitude is not null',
        ),
    },
    {
      id: 'message_google_mentions',
      question: 'Un message évoque-t-il Google, Maps ou une note d’avis ?',
      offenders: () =>
        sql.query(
          // Substring search rather than provider search: a message is generated
          // text, so contamination would arrive as words, not as a foreign key.
          `select id, prospect_id, state, left(body, 120) as extract from outreach_messages
            where body ~* '(google|google maps|avis google|note google|[0-9][.,][0-9]\\s*/\\s*5|étoiles?)'
            limit 20`,
        ),
      population: () => count(sql, 'select count(*)::text as count from outreach_messages'),
    },
    {
      id: 'message_used_google_fact',
      question: 'Un message déclare-t-il s’appuyer sur un fait d’origine Google ?',
      offenders: () =>
        sql.query(
          `select m.id, m.prospect_id, m.used_facts::text as used_facts from outreach_messages m
            where m.used_facts::text ~* '(google|place_id|google_rating|google_review)'
            limit 20`,
        ),
      population: () => count(sql, 'select count(*)::text as count from outreach_messages'),
    },
    {
      id: 'research_google_provenance',
      question: 'Un fait de research se présente-t-il comme une observation Google ?',
      offenders: () =>
        sql.query(
          `select id, prospect_id, left(summary, 100) as extract from prospect_research
            where summary ~* '(google maps|fiche google|avis google)'
               or observations::text ~* '(google maps|fiche google|avis google|google_places)'
               or opportunities::text ~* '(google maps|fiche google|avis google|google_places)'
            limit 20`,
        ),
      population: () => count(sql, 'select count(*)::text as count from prospect_research'),
    },
    {
      id: 'outreach_sent',
      question: 'Un message a-t-il été envoyé ?',
      offenders: () => sql.query('select id, prospect_id, channel, kind from outreach_events limit 20'),
      population: () => count(sql, 'select count(*)::text as count from outreach_messages'),
    },
  ];
}

async function main(): Promise<void> {
  const sql = await getSql();
  const checks = buildChecks(sql);

  const results: {
    id: string;
    question: string;
    verdict: 'OK' | 'VIDE' | 'CONTAMINATION';
    population: number;
    offenders: Record<string, unknown>[];
  }[] = [];

  for (const check of checks) {
    const population = await check.population();
    const offenders = await check.offenders();
    const verdict = offenders.length > 0 ? 'CONTAMINATION' : population === 0 ? 'VIDE' : 'OK';
    results.push({ id: check.id, question: check.question, verdict, population, offenders });
  }

  // Places provenance is allowed in exactly one table, and reporting where it is
  // matters as much as reporting where it is not.
  const origins = await sql.query<{ provider: string; rail: string; n: string }>(
    `select provider, rail, count(*)::text as n from prospect_discovery_origins
      group by provider, rail order by provider`,
  );
  const apiCalls = await count(sql, 'select count(*)::text as count from google_places_usage');
  const candidates = await count(sql, 'select count(*)::text as count from google_place_candidates');
  const expiredNow = await countExpiredLocations(sql);

  const contaminated = results.filter((row) => row.verdict === 'CONTAMINATION');

  const lines: string[] = [];
  lines.push('# Audit de contamination Google — base permanente');
  lines.push('');
  lines.push(`Appels Places jamais émis : ${apiCalls === 0 ? 'oui (0 appel enregistré)' : `NON — ${apiCalls}`}`);
  lines.push(`Candidats Places en base : ${candidates}`);
  lines.push(`Baux de coordonnées expirés non purgés : ${expiredNow}`);
  lines.push('');
  lines.push('| Contrôle | Question | Population | Verdict |');
  lines.push('| --- | --- | ---: | --- |');
  for (const row of results) {
    lines.push(`| ${row.id} | ${row.question} | ${row.population} | ${row.verdict} |`);
  }
  lines.push('');
  lines.push('## Provenance Places (seule table où elle est légitime)');
  lines.push('');
  if (origins.length === 0) {
    lines.push('Aucune origine enregistrée.');
  } else {
    lines.push('| provider | rail | n |');
    lines.push('| --- | --- | ---: |');
    for (const row of origins) lines.push(`| ${row.provider} | ${row.rail} | ${row.n} |`);
  }

  if (contaminated.length > 0) {
    lines.push('');
    lines.push('## Contaminations');
    for (const row of contaminated) {
      lines.push('');
      lines.push(`### ${row.id} — ${row.question}`);
      lines.push('```json');
      lines.push(JSON.stringify(row.offenders, null, 2));
      lines.push('```');
    }
  }

  process.stdout.write(`${lines.join('\n')}\n`);
  await sql.close();

  // A contaminated database is a failed audit, and a failed audit is a non-zero
  // exit — so a CI step or a shell loop cannot mistake it for a clean report.
  if (contaminated.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
