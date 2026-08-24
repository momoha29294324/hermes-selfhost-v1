import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { createLogger } from '@/lib/logging/logger';
import { ModelRouter } from '@/lib/models/router';
import type { LlmProvider } from '@/lib/models/types';
import type { Sql } from '@/lib/db/sql';
import type { CrmResolution } from '@/lib/crm/types';
import { AnalysisHistoryConflict, loadActiveAnalysis } from '@/lib/replies/analyses';
import { retireStaleAnalysis } from '@/lib/replies/analysisRetirement';
import { REPLY_CLASSIFIER_PROMPT_VERSION } from '@/lib/replies/classifier';
import { processReply } from '@/lib/replies/process';
import { createCodeRevisionSentinel, readCodeRevision } from '@/lib/inbound/codeRevision';
import { makeReplyFixtures } from './support/replyFixture';
import { turnAnswer } from './support/turnAnswer';

/**
 * HERMES-ACTIVE-ANALYSIS-VERSION-CONFLICT-R1 — une analyse rendue par un
 * runtime périmé, et le geste nommé qui l'écarte.
 *
 * ---------------------------------------------------------------------------
 * Le défaut réel, et ce qu'il n'était PAS
 * ---------------------------------------------------------------------------
 * Le 23 août 2026, un `ig:inbound:run --loop` démarré à 07:00:42Z — avant le
 * commit 6d1bf8a de 07:30:51Z — a écrit à 08:43 une analyse portant
 * `r6b-d2-classify-1`, une version qu'aucun code du HEAD ne produit, et a fait
 * passer en `SUPERSEDED` la conclusion canonique rendue à 08:36 sous
 * `r6b-d2-classify-2`.
 *
 * Ce n'était PAS un défaut de la base ni de `persistAnalysis` : les deux ont
 * fait exactement ce qu'on leur demandait. Ce qui manquait était un geste
 * d'opérateur — et une raison de refuser de continuer.
 *
 * Ces tests couvrent le geste, et surtout ce qu'il ne doit PAS avoir ouvert :
 * aucune résolution automatique, aucune analyse courante écartée, aucune
 * cause d'effet extérieur réécrite, aucun effacement.
 *
 * Aucun réseau : le modèle est un faux transport dans le VRAI `ModelRouter`.
 * Aucune donnée réelle d'entreprise n'entre ici.
 */

const logger = createLogger({ level: 'error' });
const MAILBOX = 'hermes__';
const STALE_VERSION = 'r6b-d2-classify-1';
const OPERATOR = 'Operator Example';
const REASON =
  'analyse rendue par un processus long-lived exécutant une classifier_version non canonique au HEAD courant';

const NO_CRM: CrmResolution = {
  configured: false,
  kind: 'NOT_CONFIGURED',
  reason: 'aucune destination CRM configurée',
  missing: ['OUTBOUND_CRM_PROVIDER'],
};

let sql: Sql;
let dir: string;
let campaignId: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-analysis-conflict-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);
  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
    ['analysis-version-conflict-test', 'Test', 'example-services', '{}'],
  );
  campaignId = rows[0]!.id;
});

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const table of [
    'hermes_conversation_plans',
    'r6b_alerts',
    'r6b_crm_projections',
    'r6b_reply_drafts',
    'r6b_reply_analysis_retirements',
    'r6b_prospect_state_transitions',
    'r6b_prospect_outreach_states',
    'r6b_reply_analyses',
    'r6b_inbound_messages',
    'do_not_contact',
    'r6b_dispatch_attempts',
    'r6b_live_send_attempts',
    'outreach_events',
    'r6b_dispatch_manifests',
    'r6b_batch_votes',
    'r6b_batch_items',
    'r6b_batches',
    'prospect_angles',
    'prospect_research',
    'prospect_evidence',
    'prospects',
  ]) {
    await sql.query(`delete from ${table}`);
  }
});

// ---------------------------------------------------------------------------
// Outillage
// ---------------------------------------------------------------------------

function router(): ModelRouter {
  const provider: LlmProvider = {
    name: 'codex',
    availability: () => ({ ok: true }),
    generate: async () => ({
      // HERMES-SEMANTIC-GROUNDING-R1 — un tour, un appel : la lecture et le
      // texte sortent du même objet.
      text: JSON.stringify(
        turnAnswer(
          {
            category: 'QUESTION',
            confidence: 0.99,
            reasoning_summary: 'classé QUESTION par le faux routeur.',
            evidence_excerpts: [],
          },
          {
            body: 'Compris. Et aujourd’hui, tu reçois combien de demandes par semaine ?',
            rationale: 'Court, une seule question, aucun chiffre.',
            used_facts: [],
          },
        ),
      ),
    }),
  };
  return new ModelRouter({ sql, logger, providers: { codex: provider } });
}

interface Scene {
  readonly inboundId: string;
  readonly prospectId: string;
  readonly manifestId: string;
}

async function scene(handle: string): Promise<Scene> {
  const fixtures = makeReplyFixtures(sql, {
    campaignId,
    mailbox: MAILBOX,
    firstTouch:
      'Bonjour, petite question : aujourd’hui, vous faites comment pour avoir régulièrement de ' +
      'nouvelles demandes ?',
  });
  const contacted = await fixtures.contactedProspect(handle, {
    transport: 'instagram_dm',
    displayName: handle.toUpperCase(),
  });
  await sql.query(`update prospects set identity_review = 'confirmed' where id = $1`, [
    contacted.prospectId,
  ]);
  const inboundId = await fixtures.instagramInbound({
    manifest: contacted.manifest,
    outreachEventId: contacted.outreachEventId,
    prospectId: contacted.prospectId,
    body: 'Ok mais concrètement tu fais quoi pour trouver des clients ?',
    threadId: '107403793987175',
    accountHandle: MAILBOX,
    receivedAt: '2026-08-23T08:35:00.000Z',
  });
  return { inboundId, prospectId: contacted.prospectId, manifestId: contacted.manifest.id };
}

/**
 * Rejoue l'incident, tel qu'il s'est produit : une analyse canonique existe,
 * puis un processus périmé en écrit une sous une version ancienne et la
 * supersède.
 *
 * L'écriture périmée passe par du SQL direct, et c'est le point : aucun code du
 * HEAD ne sait produire `r6b-d2-classify-1`. Prétendre l'obtenir par le chemin
 * normal ferait mentir le test sur ce qui s'est passé.
 */
async function replayIncident(handle: string): Promise<{
  readonly inboundId: string;
  readonly canonicalId: string;
  readonly staleId: string;
}> {
  const built = await scene(handle);
  await processReply(sql, router(), built.inboundId, { crm: NO_CRM });
  const canonical = await loadActiveAnalysis(sql, built.inboundId);
  if (canonical === null) throw new Error('l’analyse canonique n’a pas été écrite');

  // Le MÊME ordre que `persistAnalysis` : la sortie de l'ACTIVE précède
  // l'entrée de la suivante, parce que `..._one_active_idx` n'est pas
  // différable. La FK `superseded_by` l'est, elle, et désigne donc une ligne
  // qui n'existe pas encore — vérifiée au commit.
  const staleId = randomUUID();
  await sql.transaction(async (tx) => {
    await tx.query(
      `update r6b_reply_analyses set status = 'SUPERSEDED', superseded_at = now(), superseded_by = $2
        where id = $1`,
      [canonical.id, staleId],
    );
    await tx.query(
      `insert into r6b_reply_analyses
         (id, inbound_message_id, manifest_id, prospect_id, correlation_status, classification, confidence,
          reasoning_summary, requires_human_review, recommended_next_action, decided_deterministically,
          model, prompt_version, input_sha256, status)
       select $2, inbound_message_id, manifest_id, prospect_id, correlation_status, classification, confidence,
              reasoning_summary, requires_human_review, recommended_next_action, decided_deterministically,
              model, $3, repeat('a', 64), 'ACTIVE'
         from r6b_reply_analyses where id = $1`,
      [canonical.id, staleId, STALE_VERSION],
    );
  });

  return { inboundId: built.inboundId, canonicalId: canonical.id, staleId };
}

// ---------------------------------------------------------------------------
// A — le geste d'opérateur
// ---------------------------------------------------------------------------

describe('A. une analyse de version périmée peut être écartée par un opérateur', () => {
  it('l’incident se rejoue : la conclusion canonique est bien celle qui a été écartée', async () => {
    const incident = await replayIncident('washindustryone');
    const active = await loadActiveAnalysis(sql, incident.inboundId);
    expect(active?.id).toBe(incident.staleId);
    expect(active?.promptVersion).toBe(STALE_VERSION);
    expect(active?.promptVersion).not.toBe(REPLY_CLASSIFIER_PROMPT_VERSION);
  });

  it('le défaut de la commande est la SIMULATION : rien n’est écrit sans --apply', async () => {
    const incident = await replayIncident('washindustrytwo');
    const planned = await retireStaleAnalysis(sql, {
      inboundMessageId: incident.inboundId,
      operator: OPERATOR,
      reason: REASON,
    });

    expect(planned.outcome).toBe('PLANNED');
    if (planned.outcome === 'REFUSED') throw new Error('refus inattendu');
    expect(planned.retired.id).toBe(incident.staleId);
    expect(planned.reinstated?.id).toBe(incident.canonicalId);
    expect(planned.journalId).toBeNull();

    // Rien n'a bougé en base.
    const active = await loadActiveAnalysis(sql, incident.inboundId);
    expect(active?.id).toBe(incident.staleId);
    const journal = await sql.query(`select id from r6b_reply_analysis_retirements`);
    expect(journal).toHaveLength(0);
  });

  it('--apply écarte la périmée et réinstalle la canonique, en une transaction', async () => {
    const incident = await replayIncident('washindustrythree');
    const applied = await retireStaleAnalysis(sql, {
      inboundMessageId: incident.inboundId,
      operator: OPERATOR,
      reason: REASON,
      apply: true,
    });

    expect(applied.outcome).toBe('APPLIED');
    if (applied.outcome === 'REFUSED') throw new Error('refus inattendu');

    const rows = await sql.query<{ id: string; status: string; superseded_by: string | null }>(
      `select id, status, superseded_by from r6b_reply_analyses where inbound_message_id = $1`,
      [incident.inboundId],
    );
    const stale = rows.find((row) => row.id === incident.staleId)!;
    const canonical = rows.find((row) => row.id === incident.canonicalId)!;
    expect(stale.status).toBe('RETIRED');
    expect(stale.superseded_by).toBeNull();
    expect(canonical.status).toBe('ACTIVE');
    expect(canonical.superseded_by).toBeNull();

    const active = await loadActiveAnalysis(sql, incident.inboundId);
    expect(active?.id).toBe(incident.canonicalId);
    expect(active?.promptVersion).toBe(REPLY_CLASSIFIER_PROMPT_VERSION);
  });

  it('le geste exige un nom et un motif — ni l’un ni l’autre n’a de valeur par défaut', async () => {
    const incident = await replayIncident('washindustryfour');
    const noName = await retireStaleAnalysis(sql, {
      inboundMessageId: incident.inboundId,
      operator: '  ',
      reason: REASON,
      apply: true,
    });
    expect(noName.outcome).toBe('REFUSED');
    if (noName.outcome !== 'REFUSED') throw new Error('inatteignable');
    expect(noName.refusal).toBe('OPERATOR_MISSING');

    const noReason = await retireStaleAnalysis(sql, {
      inboundMessageId: incident.inboundId,
      operator: OPERATOR,
      reason: 'bof',
      apply: true,
    });
    expect(noReason.outcome).toBe('REFUSED');
    if (noReason.outcome !== 'REFUSED') throw new Error('inatteignable');
    expect(noReason.refusal).toBe('REASON_MISSING');

    expect((await loadActiveAnalysis(sql, incident.inboundId))?.id).toBe(incident.staleId);
  });
});

// ---------------------------------------------------------------------------
// B — l'historique reste présent
// ---------------------------------------------------------------------------

describe('B. rien n’est effacé', () => {
  it('la ligne écartée reste lisible, avec son prompt, son modèle et son raisonnement', async () => {
    const incident = await replayIncident('washindustryfive');
    const before = await sql.query<Record<string, unknown>>(
      `select classification, confidence, reasoning_summary, model, prompt_version, input_sha256, created_at
         from r6b_reply_analyses where id = $1`,
      [incident.staleId],
    );
    await retireStaleAnalysis(sql, {
      inboundMessageId: incident.inboundId,
      operator: OPERATOR,
      reason: REASON,
      apply: true,
    });
    const after = await sql.query<Record<string, unknown>>(
      `select classification, confidence, reasoning_summary, model, prompt_version, input_sha256, created_at
         from r6b_reply_analyses where id = $1`,
      [incident.staleId],
    );
    expect(after).toHaveLength(1);
    expect(after[0]).toEqual(before[0]);
  });

  it('le lien de supersession dénoué est consigné avant de disparaître de la ligne', async () => {
    const incident = await replayIncident('washindustrysix');
    await retireStaleAnalysis(sql, {
      inboundMessageId: incident.inboundId,
      operator: OPERATOR,
      reason: REASON,
      apply: true,
    });
    const journal = await sql.query<Record<string, string | null>>(
      `select analysis_id, previous_status, retired_prompt_version, canonical_prompt_version,
              reinstated_analysis_id, unlinked_superseded_by, operator, reason
         from r6b_reply_analysis_retirements`,
    );
    expect(journal).toHaveLength(1);
    const row = journal[0]!;
    expect(row['analysis_id']).toBe(incident.staleId);
    expect(row['previous_status']).toBe('ACTIVE');
    expect(row['retired_prompt_version']).toBe(STALE_VERSION);
    expect(row['canonical_prompt_version']).toBe(REPLY_CLASSIFIER_PROMPT_VERSION);
    expect(row['reinstated_analysis_id']).toBe(incident.canonicalId);
    // LE fait qui aurait été perdu : c'est bien la périmée qui avait remplacé
    // la canonique, et le journal le dit après que la ligne ne le dit plus.
    expect(row['unlinked_superseded_by']).toBe(incident.staleId);
    expect(row['operator']).toBe(OPERATOR);
    expect(row['reason']).toBe(REASON);
  });

  it('le brouillon écrit sous l’analyse canonique survit au geste', async () => {
    const incident = await replayIncident('washindustryseven');
    const before = await sql.query<{ id: string }>(
      `select id from r6b_reply_drafts where analysis_id = $1`,
      [incident.canonicalId],
    );
    await retireStaleAnalysis(sql, {
      inboundMessageId: incident.inboundId,
      operator: OPERATOR,
      reason: REASON,
      apply: true,
    });
    const after = await sql.query<{ id: string }>(
      `select id from r6b_reply_drafts where analysis_id = $1`,
      [incident.canonicalId],
    );
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
  });
});

// ---------------------------------------------------------------------------
// C — une analyse ACTIVE valide n'est jamais écartée
// ---------------------------------------------------------------------------

describe('C. la version canonique est intouchable', () => {
  it('une analyse rendue sous la version courante est REFUSÉE, opérateur ou pas', async () => {
    const built = await scene('washindustryeight');
    await processReply(sql, router(), built.inboundId, { crm: NO_CRM });
    const active = await loadActiveAnalysis(sql, built.inboundId);
    expect(active?.promptVersion).toBe(REPLY_CLASSIFIER_PROMPT_VERSION);

    const result = await retireStaleAnalysis(sql, {
      inboundMessageId: built.inboundId,
      operator: OPERATOR,
      reason: REASON,
      apply: true,
    });
    expect(result.outcome).toBe('REFUSED');
    if (result.outcome !== 'REFUSED') throw new Error('inatteignable');
    expect(result.refusal).toBe('ANALYSIS_VERSION_IS_CANONICAL');
    expect((await loadActiveAnalysis(sql, built.inboundId))?.id).toBe(active!.id);
  });

  it('rien n’est écarté quand rien n’est vivant', async () => {
    const built = await scene('washindustrynine');
    const result = await retireStaleAnalysis(sql, {
      inboundMessageId: built.inboundId,
      operator: OPERATOR,
      reason: REASON,
      apply: true,
    });
    expect(result.outcome).toBe('REFUSED');
    if (result.outcome !== 'REFUSED') throw new Error('inatteignable');
    expect(result.refusal).toBe('NO_ACTIVE_ANALYSIS');
  });

  it('aucun chemin de production n’écrit RETIRED — la seule porte est la commande', async () => {
    const production = [
      'src/lib/replies/analyses.ts',
      'src/lib/replies/process.ts',
      'src/lib/inbound/instagramRuntime.ts',
      'src/lib/conversation/plan.ts',
      'src/lib/conversation/replyExecution.ts',
    ];
    for (const file of production) {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      expect(source).not.toContain('RETIRED');
      expect(source).not.toContain('retireStaleAnalysis');
    }
  });
});

// ---------------------------------------------------------------------------
// D — reclasser ensuite, avec la version courante
// ---------------------------------------------------------------------------

describe('D. le même message se relit ensuite avec le code courant', () => {
  it('avant le geste, le retraitement refuse — l’index d’identité est sur TOUTE l’histoire', async () => {
    const incident = await replayIncident('washindustryten');
    await expect(processReply(sql, router(), incident.inboundId, { crm: NO_CRM })).rejects.toBeInstanceOf(
      AnalysisHistoryConflict,
    );
  });

  it('après le geste, le retraitement passe et rend la conclusion canonique', async () => {
    const incident = await replayIncident('washindustryeleven');
    await retireStaleAnalysis(sql, {
      inboundMessageId: incident.inboundId,
      operator: OPERATOR,
      reason: REASON,
      apply: true,
    });
    const processed = await processReply(sql, router(), incident.inboundId, { crm: NO_CRM });
    expect(processed.analysisId).toBe(incident.canonicalId);
    expect(processed.classification).toBe('QUESTION');
    // Aucune reclassification n'a été payée : la conclusion canonique
    // répondait déjà à la question posée par le code courant.
    expect(processed.analysisCreated).toBe(false);
  });

  it('sans conclusion canonique en réserve, le retraitement en écrit une neuve', async () => {
    const built = await scene('washindustrytwelve');
    // Un runtime périmé seul, sans canonique avant lui : le cas d'un message
    // qu'un seul processus a jamais vu.
    await sql.query(
      `insert into r6b_reply_analyses
         (inbound_message_id, manifest_id, prospect_id, correlation_status, classification, confidence,
          reasoning_summary, requires_human_review, recommended_next_action, decided_deterministically,
          model, prompt_version, input_sha256, status)
       values ($1, $2, $3, 'EXACT', 'OTHER', 0.70,
               'rendue par un runtime périmé', true, 'HUMAN_REVIEW', false,
               'gpt-5.6-sol', $4, repeat('b', 64), 'ACTIVE')`,
      [built.inboundId, built.manifestId, built.prospectId, STALE_VERSION],
    );
    const active = await loadActiveAnalysis(sql, built.inboundId);
    expect(active?.promptVersion).toBe(STALE_VERSION);

    const applied = await retireStaleAnalysis(sql, {
      inboundMessageId: built.inboundId,
      operator: OPERATOR,
      reason: REASON,
      apply: true,
    });
    expect(applied.outcome).toBe('APPLIED');
    if (applied.outcome === 'REFUSED') throw new Error('refus inattendu');
    expect(applied.reinstated).toBeNull();
    expect(await loadActiveAnalysis(sql, built.inboundId)).toBeNull();

    const processed = await processReply(sql, router(), built.inboundId, { crm: NO_CRM });
    expect(processed.analysisCreated).toBe(true);
    const now = await loadActiveAnalysis(sql, built.inboundId);
    expect(now?.promptVersion).toBe(REPLY_CLASSIFIER_PROMPT_VERSION);
  });
});

// ---------------------------------------------------------------------------
// E — un effet tenté n'est jamais rejoué, et sa cause jamais réécrite
// ---------------------------------------------------------------------------

describe('E. un effet extérieur tenté ferme le geste', () => {
  it('un plan qui porte external_effect_attempted refuse le retrait, définitivement', async () => {
    const incident = await replayIncident('washindustrythirteen');
    await sql.query(
      `insert into hermes_conversation_plans
         (prospect_id, channel, kind, trigger_inbound_message_id, idempotency_key,
          actor_kind, policy_version, commercial_policy_version, brain_version, decision, decision_gate,
          body, body_sha256, offer_readiness, call_readiness, status,
          external_effect_attempted, external_effect_started_at, terminated_at)
       select a.prospect_id, 'instagram_dm', 'AUTO_REPLY', a.inbound_message_id,
              'test/effet-tente/' || a.inbound_message_id, 'AUTONOMOUS_POLICY', 'test-policy',
              'test-commercial', 'test-brain', 'AUTO_REPLY_ELIGIBLE', 'autonomous_reply',
              'un texte de test', repeat('f', 64), 'LOW', 'LOW', 'AMBIGUOUS', true, now(), now()
         from r6b_reply_analyses a where a.id = $1`,
      [incident.staleId],
    );

    const result = await retireStaleAnalysis(sql, {
      inboundMessageId: incident.inboundId,
      operator: OPERATOR,
      reason: REASON,
      apply: true,
    });
    expect(result.outcome).toBe('REFUSED');
    if (result.outcome !== 'REFUSED') throw new Error('inatteignable');
    expect(result.refusal).toBe('EXTERNAL_EFFECT_ATTEMPTED');
    // La périmée reste vivante : mieux vaut une analyse périmée qu'une cause
    // d'envoi réécrite.
    expect((await loadActiveAnalysis(sql, incident.inboundId))?.id).toBe(incident.staleId);
  });
});

// ---------------------------------------------------------------------------
// F — l'historique des plans n'est pas ressuscité
// ---------------------------------------------------------------------------

describe('F. les plans d’avant restent où ils sont', () => {
  it('le geste ne touche à aucun plan — ni statut, ni décision, ni horodatage', async () => {
    const incident = await replayIncident('washindustryfourteen');
    await sql.query(
      `insert into hermes_conversation_plans
         (prospect_id, channel, kind, trigger_inbound_message_id, idempotency_key,
          actor_kind, policy_version, commercial_policy_version, brain_version, decision, decision_gate,
          decision_reason, offer_readiness, call_readiness, status, terminated_at)
       select a.prospect_id, 'instagram_dm', 'AUTO_REPLY', a.inbound_message_id,
              'test/bloque/' || a.inbound_message_id, 'AUTONOMOUS_POLICY', 'test-policy',
              'test-commercial', 'test-brain',
              'HUMAN_ESCALATION', 'grounding', 'topic_not_covered', 'LOW', 'LOW', 'BLOCKED', now()
         from r6b_reply_analyses a where a.id = $1`,
      [incident.canonicalId],
    );
    const before = await sql.query<Record<string, unknown>>(
      `select id, status, decision, decision_gate, decision_reason, external_effect_attempted, updated_at
         from hermes_conversation_plans`,
    );

    await retireStaleAnalysis(sql, {
      inboundMessageId: incident.inboundId,
      operator: OPERATOR,
      reason: REASON,
      apply: true,
    });

    const after = await sql.query<Record<string, unknown>>(
      `select id, status, decision, decision_gate, decision_reason, external_effect_attempted, updated_at
         from hermes_conversation_plans`,
    );
    expect(after).toEqual(before);
    expect(after[0]!['status']).toBe('BLOCKED');
  });
});

// ---------------------------------------------------------------------------
// G — la sentinelle de révision
// ---------------------------------------------------------------------------

describe('G. un processus long ne décide pas de ce qui est canonique', () => {
  it('la révision du dépôt se lit sans lancer de sous-processus', () => {
    const revision = readCodeRevision(process.cwd());
    expect(revision).toMatch(/^[0-9a-f]{40}$/);
  });

  it('hors dépôt, elle rend null et n’affirme AUCUNE dérive', () => {
    const empty = mkdtempSync(join(tmpdir(), 'hermes-no-git-'));
    try {
      expect(readCodeRevision(empty)).toBeNull();
      const sentinel = createCodeRevisionSentinel(empty);
      expect(sentinel.startedAt).toBeNull();
      expect(sentinel.hasDrifted()).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('une révision inchangée n’arrête rien ; une révision qui bouge est vue', () => {
    const repo = mkdtempSync(join(tmpdir(), 'hermes-fake-git-'));
    try {
      mkdirSync(join(repo, '.git', 'refs', 'heads'), { recursive: true });
      writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      writeFileSync(join(repo, '.git', 'refs', 'heads', 'main'), `${'a'.repeat(40)}\n`);

      const sentinel = createCodeRevisionSentinel(repo);
      expect(sentinel.startedAt).toBe('a'.repeat(40));
      expect(sentinel.hasDrifted()).toBe(false);

      writeFileSync(join(repo, '.git', 'refs', 'heads', 'main'), `${'b'.repeat(40)}\n`);
      expect(sentinel.hasDrifted()).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('une révision devenue ILLISIBLE ne vaut pas une dérive — le doute n’arrête rien', () => {
    let call = 0;
    const sentinel = createCodeRevisionSentinel('/peu-importe', () => {
      call += 1;
      return call === 1 ? 'c'.repeat(40) : null;
    });
    expect(sentinel.startedAt).toBe('c'.repeat(40));
    expect(sentinel.hasDrifted()).toBe(false);
  });

  it('la sentinelle ne peut produire qu’un ARRÊT : elle n’écrit rien et ne relance rien', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/inbound/codeRevision.ts'), 'utf8');
    for (const forbidden of ['child_process', 'execFileSync', 'spawn', 'writeFile', 'unlink']) {
      expect(source).not.toContain(forbidden);
    }
  });
});
