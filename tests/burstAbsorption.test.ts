import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { createLogger } from '@/lib/logging/logger';
import { ModelRouter } from '@/lib/models/router';
import { LlmError, type LlmProvider } from '@/lib/models/types';
import type { CrmResolution } from '@/lib/crm/types';
import type { Sql } from '@/lib/db/sql';
import { AbsorbedIntoBurst } from '@/lib/replies/burstAbsorption';
import {
  loadUnprocessedCorrelatedInbound,
  processNewReplies,
  processReply,
} from '@/lib/replies/process';
import { makeReplyFixtures, type ReplyFixtures } from './support/replyFixture';
import { turnAnswer } from './support/turnAnswer';

/**
 * HERMES-MULTI-TURN-BURSTS-R1 — le BUDGET D'APPELS d'une prise de parole.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce fichier mesure
 * ---------------------------------------------------------------------------
 * Un humain écrit « ouais », « j'avais essayé », « mais ça marchait pas », « et
 * ils disparaissaient au prix ». Quatre lignes en base, une seule phrase.
 *
 * Chaque bulle recevait son propre appel de modèle et sa propre analyse —
 * quatre lectures d'une phrase qui n'en formait qu'une, dont trois périmées
 * avant d'être écrites, et chacune ne décrivant qu'un fragment. Le contrat du
 * dépôt est « un tour, un appel » : il portait sur le MESSAGE, alors que le
 * tour est la PRISE DE PAROLE.
 *
 * Le découpage est déterministe et sans modèle — silence, notre propre message
 * exposé, nombre de bulles, nombre de caractères. Aucun appel n'est dépensé
 * pour décider si deux bulles appartiennent à la même phrase.
 *
 * Aucun test de ce fichier n'ouvre de connexion réseau : le modèle est un faux
 * provider injecté dans le VRAI `ModelRouter`.
 */

const logger = createLogger({ test: 'burst-absorption' });
const MAILBOX = 'reponse@example.com';
const FIRST_TOUCH = 'Bonjour, comment vos clients vous trouvent aujourd’hui ?';

let sql: Sql;
let dir: string;
let campaignId: string;
let contactedProspect: ReplyFixtures['contactedProspect'];
let inbound: ReplyFixtures['inbound'];

/** Compte les appels réellement partis vers le provider. */
let calls = 0;

const NO_CRM: CrmResolution = {
  configured: false,
  kind: 'NOT_CONFIGURED',
  reason: 'aucune destination CRM configurée pour Hermes',
  missing: ['OUTBOUND_CRM_PROVIDER'],
};

function router(): ModelRouter {
  const provider: LlmProvider = {
    name: 'codex',
    availability: () => ({ ok: true }),
    generate: async (request) => {
      if (request.task !== 'message') throw new LlmError(`tâche inattendue ${request.task}`, 'provider_error');
      calls += 1;
      return {
        text: JSON.stringify(
          turnAnswer(
            {
              category: 'INFORMATION_SHARED',
              confidence: 0.99,
              reasoning_summary: 'le prospect raconte son expérience passée.',
              evidence_excerpts: [],
            },
            {
              body: 'Tu les relançais comment, après ?',
              rationale: 'Une question courte, sans chiffre.',
              used_facts: [],
            },
          ),
        ),
      };
    },
  };
  return new ModelRouter({ sql, logger, providers: { codex: provider } });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-burst-absorption-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);
  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
    ['example-burst-test', 'Test', 'example-services', '{}'],
  );
  campaignId = rows[0]!.id;
  ({ contactedProspect, inbound } = makeReplyFixtures(sql, {
    campaignId,
    mailbox: MAILBOX,
    firstTouch: FIRST_TOUCH,
  }));
});

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  calls = 0;
  await sql.query('delete from r6b_inbound_burst_absorptions');
  await sql.query('delete from r6b_alerts');
  await sql.query('delete from r6b_reply_drafts');
  await sql.query('delete from r6b_crm_projections');
  await sql.query('delete from r6b_prospect_state_transitions');
  await sql.query('delete from r6b_prospect_outreach_states');
  await sql.query('delete from r6b_reply_analyses');
  await sql.query('delete from r6b_inbound_messages');
  await sql.query('delete from do_not_contact');
  await sql.query('delete from r6b_dispatch_attempts');
  await sql.query('delete from r6b_live_send_attempts');
  await sql.query('delete from outreach_events');
  await sql.query('delete from r6b_dispatch_manifests');
  await sql.query('delete from r6b_batch_votes');
  await sql.query('delete from r6b_batch_items');
  await sql.query('delete from r6b_batches');
  await sql.query('delete from prospect_angles');
  await sql.query('delete from prospect_research');
  await sql.query('delete from prospect_evidence');
  await sql.query('delete from prospects');
});

/** Une salve de bulles, espacées de trente secondes. */
async function burst(
  fixture: Awaited<ReturnType<ReplyFixtures['contactedProspect']>>,
  bodies: readonly string[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const [index, body] of bodies.entries()) {
    ids.push(
      await inbound({
        ...fixture,
        body,
        receivedAt: new Date(Date.parse('2026-08-23T13:00:00Z') + index * 30_000).toISOString(),
      }),
    );
  }
  return ids;
}

describe('§1 — quatre bulles, UN appel de modèle', () => {
  it('une salve de quatre messages ne coûte qu’un seul appel', async () => {
    const fixture = await contactedProspect('burst-a@example.com');
    await burst(fixture, [
      'ouais',
      'j’avais essayé',
      'mais ça marchait pas',
      'et ils disparaissaient au prix',
    ]);

    const report = await processNewReplies(sql, router(), { crm: NO_CRM }, { limit: 50 });

    // UN appel, pas quatre.
    expect(calls).toBe(1);
    expect(report.processed).toHaveLength(1);
    expect(report.absorbed).toHaveLength(3);

    // Et une seule analyse : les trois autres bulles n'en portent aucune.
    const analyses = await sql.query('select id from r6b_reply_analyses');
    expect(analyses).toHaveLength(1);
  });

  it('la bulle raisonnée est la DERNIÈRE — c’est elle qui clôt la prise de parole', async () => {
    const fixture = await contactedProspect('burst-b@example.com');
    const ids = await burst(fixture, ['ouais', 'j’avais essayé', 'mais ça marchait pas']);

    const report = await processNewReplies(sql, router(), { crm: NO_CRM }, { limit: 50 });
    expect(report.processed[0]?.inboundMessageId).toBe(ids[2]);
    expect(report.absorbed.map((entry) => entry.inboundMessageId).sort()).toEqual(
      [ids[0]!, ids[1]!].sort(),
    );
    for (const entry of report.absorbed) {
      expect(entry.burstClosingMessageId).toBe(ids[2]);
      expect(entry.burstMessageCount).toBe(3);
    }
  });

  it('un message SEUL coûte toujours un appel, et n’est jamais absorbé', async () => {
    const fixture = await contactedProspect('burst-c@example.com');
    await burst(fixture, ['j’avais des leads mais surtout des curieux']);

    const report = await processNewReplies(sql, router(), { crm: NO_CRM }, { limit: 50 });
    expect(calls).toBe(1);
    expect(report.processed).toHaveLength(1);
    expect(report.absorbed).toHaveLength(0);
  });
});

describe('§2 — rien n’est perdu, rien n’est réécrit', () => {
  it('les lignes brutes restent SÉPARÉES, avec leur texte et leur horodatage', async () => {
    const fixture = await contactedProspect('burst-d@example.com');
    const ids = await burst(fixture, ['ouais', 'j’avais essayé', 'mais ça marchait pas']);
    await processNewReplies(sql, router(), { crm: NO_CRM }, { limit: 50 });

    const rows = await sql.query<{ id: string; bodyText: string; receivedAt: string | Date }>(
      `select id, body_text as "bodyText", received_at as "receivedAt"
         from r6b_inbound_messages order by received_at asc`,
    );
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.id)).toEqual(ids);
    expect(rows.map((row) => row.bodyText)).toEqual(['ouais', 'j’avais essayé', 'mais ça marchait pas']);
    // Trois horodatages distincts : aucune fusion.
    expect(new Set(rows.map((row) => new Date(row.receivedAt).toISOString())).size).toBe(3);
  });

  it('l’absorption est AUDITABLE : elle nomme la bulle et le tour qui la porte', async () => {
    const fixture = await contactedProspect('burst-e@example.com');
    const ids = await burst(fixture, ['ouais', 'j’avais essayé']);
    await processNewReplies(sql, router(), { crm: NO_CRM }, { limit: 50 });

    const rows = await sql.query<{
      inboundMessageId: string;
      closing: string;
      count: number;
      policyVersion: string;
    }>(
      `select inbound_message_id as "inboundMessageId",
              burst_closing_message_id as "closing",
              burst_message_count as "count",
              policy_version as "policyVersion"
         from r6b_inbound_burst_absorptions`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.inboundMessageId).toBe(ids[0]);
    expect(rows[0]?.closing).toBe(ids[1]);
    expect(rows[0]?.count).toBe(2);
    expect(rows[0]?.policyVersion).toContain('hermes-conversation-');
  });
});

describe('§3 — la FAMINE que l’absorption évite', () => {
  it('une bulle absorbée SORT de la fenêtre des messages à traiter', async () => {
    const fixture = await contactedProspect('burst-f@example.com');
    await burst(fixture, ['ouais', 'j’avais essayé', 'mais ça marchait pas']);

    expect(await loadUnprocessedCorrelatedInbound(sql, 50)).toHaveLength(3);
    await processNewReplies(sql, router(), { crm: NO_CRM }, { limit: 50 });

    // Sans cette exclusion, les deux bulles absorbées reviendraient à CHAQUE
    // tour, pour toujours — et au bout de cinquante, les plus anciennes
    // rempliraient la fenêtre (`order by received_at asc limit`) et
    // affameraient les messages neufs. Le rail cesserait de répondre en
    // silence.
    expect(await loadUnprocessedCorrelatedInbound(sql, 50)).toHaveLength(0);
  });

  it('un second passage ne rappelle PAS le modèle', async () => {
    const fixture = await contactedProspect('burst-g@example.com');
    await burst(fixture, ['ouais', 'j’avais essayé']);
    await processNewReplies(sql, router(), { crm: NO_CRM }, { limit: 50 });
    const afterFirst = calls;

    await processNewReplies(sql, router(), { crm: NO_CRM }, { limit: 50 });
    expect(calls).toBe(afterFirst);
  });

  it('l’absorption est IDEMPOTENTE : rejouer n’écrit pas une seconde ligne', async () => {
    const fixture = await contactedProspect('burst-h@example.com');
    const ids = await burst(fixture, ['ouais', 'j’avais essayé']);

    // Deux tentatives directes sur la bulle intermédiaire.
    await expect(processReply(sql, router(), ids[0]!, { crm: NO_CRM })).rejects.toBeInstanceOf(
      AbsorbedIntoBurst,
    );
    await expect(processReply(sql, router(), ids[0]!, { crm: NO_CRM })).rejects.toBeInstanceOf(
      AbsorbedIntoBurst,
    );

    const rows = await sql.query('select id from r6b_inbound_burst_absorptions');
    expect(rows).toHaveLength(1);
    // Et aucun appel de modèle n'a été dépensé sur une bulle intermédiaire.
    expect(calls).toBe(0);
  });
});

describe('§4 — la frontière de notre propre réponse', () => {
  it('un message arrivé APRÈS une salve déjà traitée est un tour NEUF, pas une absorption', async () => {
    const fixture = await contactedProspect('burst-i@example.com');
    await burst(fixture, ['ouais', 'j’avais essayé']);
    await processNewReplies(sql, router(), { crm: NO_CRM }, { limit: 50 });
    expect(calls).toBe(1);

    // Une heure plus tard : la personne est revenue.
    await inbound({
      ...fixture,
      body: 'finalement je veux bien en parler',
      receivedAt: '2026-08-23T14:00:00Z',
    });
    const second = await processNewReplies(sql, router(), { crm: NO_CRM }, { limit: 50 });

    expect(second.processed).toHaveLength(1);
    expect(second.absorbed).toHaveLength(0);
    expect(calls).toBe(2);
  });
});
