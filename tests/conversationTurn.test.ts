/**
 * HERMES-SEMANTIC-GROUNDING-R1 — UN tour, UN appel.
 *
 * Ce fichier éprouve trois choses que rien d'autre ne mesure :
 *
 *   1. le COÛT réel d'un tour, en appels de modèle. C'est une exigence de
 *      conception, pas une préférence : deux appels pour la même question
 *      pouvaient se contredire, et l'ont fait ;
 *   2. la direction de la lecture du modèle. Elle ne sait qu'AJOUTER une
 *      escalade ; un test le prouve dans les deux sens ;
 *   3. le court-circuit déterministe, qui ne coûte toujours rien.
 *
 * Le modèle est un faux provider injecté dans le VRAI `ModelRouter` : le
 * routage, la validation de forme et l'instrumentation `model_runs` sont
 * réellement exercés. Rien ici ne peut envoyer — le module sous test n'importe
 * aucun provider d'envoi.
 *
 * Entreprises, adresses et textes sont fictifs.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  UNCOVERED_CURRENT_REQUESTS,
  type CurrentRequestTopic,
} from '@/lib/conversation/currentRequest';
import { demandFromCurrentRequest, firstEscalatingDemand } from '@/lib/conversation/commercialPolicy';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { createLogger } from '@/lib/logging/logger';
import { ModelRouter } from '@/lib/models/router';
import { LlmError, type LlmProvider } from '@/lib/models/types';
import { loadActiveAnalysis } from '@/lib/replies/analyses';
import { processReply } from '@/lib/replies/process';
import type { CrmResolution } from '@/lib/crm/types';
import { makeReplyFixtures, type ReplyFixtures } from './support/replyFixture';
import { turnAnswer } from './support/turnAnswer';
import type { Sql } from '@/lib/db/sql';

const logger = createLogger({ test: 'conversation-turn' });
const MAILBOX = 'reponse@example.com';
const FIRST_TOUCH =
  'Bonjour, j’ai vu que vous faisiez du prestation standard à domicile. Comment vos clients vous trouvent aujourd’hui ?';
const NO_CRM: CrmResolution = {
  configured: false,
  kind: 'NOT_CONFIGURED',
  reason: 'aucune destination CRM configurée pour ce test',
  missing: ['OUTBOUND_CRM_PROVIDER'],
};

let sql: Sql;
let dir: string;
let campaignId: string;
let fixtures: ReplyFixtures;
let calls: { prompt: string; schemaHasCategory: boolean }[] = [];

interface TurnScript {
  readonly category?: string;
  readonly confidence?: number;
  readonly reply?: string;
  readonly currentRequest?: CurrentRequestTopic;
  /** Un texte de réécriture, quand le premier jet doit être corrigé. */
  readonly repair?: string;
  readonly fail?: boolean;
}

function makeRouter(script: TurnScript): ModelRouter {
  const provider: LlmProvider = {
    name: 'codex',
    availability: () => ({ ok: true }),
    generate: async (request) => {
      const properties = (request.schema as { properties?: Record<string, unknown> } | undefined)
        ?.properties;
      const schemaHasCategory = properties !== undefined && 'category' in properties;
      calls.push({ prompt: request.prompt, schemaHasCategory });
      if (script.fail === true) throw new LlmError('modèle indisponible', 'timeout');
      if (!schemaHasCategory) {
        // La RÉÉCRITURE : un texte, et rien d'autre.
        return {
          text: JSON.stringify({
            reply: script.repair ?? script.reply ?? 'Compris, merci.',
            reply_rationale: 'réécriture de test',
            used_facts: [],
          }),
        };
      }
      return {
        text: JSON.stringify(
          turnAnswer(
            {
              category: script.category ?? 'INFORMATION_SHARED',
              confidence: script.confidence ?? 0.95,
              reasoning_summary: 'lecture de test',
              evidence_excerpts: [],
            },
            { body: script.reply ?? 'Compris. Et ça marchait comment pour vous ?', rationale: 'test', used_facts: [] },
            script.currentRequest === undefined ? {} : { current_request: script.currentRequest },
          ),
        ),
      };
    },
  };
  return new ModelRouter({ sql, logger, providers: { codex: provider } });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-turn-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);
  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
    ['example-turn-test', 'Test', 'example-services', '{}'],
  );
  campaignId = rows[0]!.id;
  fixtures = makeReplyFixtures(sql, { campaignId, mailbox: MAILBOX, firstTouch: FIRST_TOUCH });
});

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  calls = [];
});

let seq = 0;
async function scene(body: string, automationSignals?: readonly string[]): Promise<string> {
  seq += 1;
  const prospect = await fixtures.contactedProspect(`turn-${String(seq)}@example.com`);
  return fixtures.inbound({
    manifest: prospect.manifest,
    outreachEventId: prospect.outreachEventId,
    prospectId: prospect.prospectId,
    body,
    ...(automationSignals === undefined ? {} : { automationSignals }),
  });
}

// ---------------------------------------------------------------------------

describe('le COÛT d’un tour, en appels de modèle', () => {
  it('un tour nominal coûte UN appel — la lecture et le texte en sortent ensemble', async () => {
    const id = await scene('Surtout par le bouche à oreille pour l’instant');
    await processReply(sql, makeRouter({ reply: 'Ok. Et ça vous amène combien de demandes ?' }), id, {
      crm: NO_CRM,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.schemaHasCategory).toBe(true);

    // Les deux artefacts existent, et ils viennent du même appel.
    const analysis = await loadActiveAnalysis(sql, id);
    expect(analysis?.classification).toBe('INFORMATION_SHARED');
    const drafts = await sql.query<{ n: string }>(
      `select count(*)::text as n from r6b_reply_drafts where inbound_message_id = $1`,
      [id],
    );
    expect(drafts[0]!.n).toBe('1');
  });

  it('la RÉPARATION coûte au plus un appel de plus, et jamais deux', async () => {
    // Un premier jet volontairement trop long pour le budget du tour : le
    // contrôle de naturalité le refuse, le cerveau réécrit UNE fois.
    const tooLong = `Merci beaucoup pour votre retour. ${'Nous accompagnons les professionnels du prestation standard sur leur acquisition de clients depuis plusieurs années. '.repeat(4)}`;
    const id = await scene('ok');
    await processReply(
      sql,
      makeRouter({ reply: tooLong, repair: 'Ok. Vous en recevez combien par semaine ?' }),
      id,
      { crm: NO_CRM },
    );

    expect(calls.length).toBeLessThanOrEqual(2);
    if (calls.length === 2) {
      // Le second appel ne redemande PAS de lecture : il redemande un texte.
      expect(calls[1]!.schemaHasCategory).toBe(false);
      expect(calls[1]!.prompt).toContain('Ne change pas ta lecture du tour');
    }
  });

  it('la deuxième exécution du même message ne rappelle pas le modèle', async () => {
    const id = await scene('Surtout par le bouche à oreille pour l’instant');
    const router = makeRouter({ reply: 'Ok. Et ça vous amène combien de demandes ?' });
    await processReply(sql, router, id, { crm: NO_CRM });
    const afterFirst = calls.length;
    await processReply(sql, router, id, { crm: NO_CRM });
    expect(calls.length).toBe(afterFirst);
  });

  it('une non-remise se lit dans les en-têtes : ZÉRO appel', async () => {
    const id = await scene('Delivery Status Notification (Failure)', ['delivery_status_report']);
    await processReply(sql, makeRouter({}), id, { crm: NO_CRM });
    expect(calls).toHaveLength(0);
    expect((await loadActiveAnalysis(sql, id))?.classification).toBe('BOUNCE');
  });

  it('un tour raté n’écrit rien et laisse le message à retraiter', async () => {
    const id = await scene('Surtout par le bouche à oreille pour l’instant');
    await expect(processReply(sql, makeRouter({ fail: true }), id, { crm: NO_CRM })).rejects.toThrow();
    expect(await loadActiveAnalysis(sql, id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('la lecture du modèle ne sait qu’AJOUTER une escalade', () => {
  it('un sujet NON couvert que le lexique aurait manqué devient une demande', () => {
    const finding = demandFromCurrentRequest('POST_TRIAL_PRICE');
    expect(finding).not.toBeNull();
    expect(finding?.frame).toBe('CURRENT');
    expect(finding?.reason).toBe('pricing_policy_missing');
  });

  it('tous les sujets NON couverts produisent une demande qui escalade', () => {
    for (const topic of UNCOVERED_CURRENT_REQUESTS) {
      const finding = demandFromCurrentRequest(topic);
      expect(finding, topic).not.toBeNull();
      expect(firstEscalatingDemand([finding!]), topic).not.toBeNull();
    }
  });

  it('un sujet COUVERT n’en produit aucune — la réponse est écrite', () => {
    for (const topic of ['TRIAL_COST', 'AD_BUDGET', 'SERVICE_EXPLANATION', 'CONTACT_PURPOSE'] as const) {
      expect(demandFromCurrentRequest(topic), topic).toBeNull();
    }
  });

  it('NONE n’en produit aucune, et ne peut donc RETIRER aucune escalade', () => {
    expect(demandFromCurrentRequest('NONE')).toBeNull();
    expect(demandFromCurrentRequest(null)).toBeNull();
  });

  it('une analyse d’avant ce round (null) n’ouvre rien', () => {
    expect(demandFromCurrentRequest(null)).toBeNull();
  });

  it('la lecture du modèle est PERSISTÉE, pour être relue sans lui', async () => {
    const id = await scene('Et il faut compter combien une fois le test terminé ?');
    await processReply(
      sql,
      makeRouter({
        category: 'QUESTION',
        reply: 'Je préfère en parler de vive voix pour ne pas te répondre de travers.',
        currentRequest: 'POST_TRIAL_PRICE',
      }),
      id,
      { crm: NO_CRM },
    );
    const analysis = await loadActiveAnalysis(sql, id);
    expect(analysis?.currentRequest).toBe('POST_TRIAL_PRICE');
  });
});
