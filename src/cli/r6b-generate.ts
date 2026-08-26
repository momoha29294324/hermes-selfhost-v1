#!/usr/bin/env tsx
/**
 * R6B-A / R7-PILOT §2 — génère un batch de review humaine.
 *
 *   npm run r6b:generate                       # le batch R6B-A historique, à l'identique
 *
 *   npm run r6b:generate -- \
 *     --batch example-campaign-canary \
 *     --campaign example-campaign \
 *     --prospect <uuid> --prospect <uuid> \
 *     --reuse-messages
 *
 *   npm run r6b:generate -- \
 *     --batch <slug> --campaign <slug> --stage message_ready --limit 5
 *
 * ---------------------------------------------------------------------------
 * Ce que cette commande fait, et surtout ce qu'elle ne fait pas
 * ---------------------------------------------------------------------------
 * Elle remplit `r6b_batches` / `r6b_batch_items` — c'est-à-dire la file
 * d'attente d'un HUMAIN. Elle n'écrit aucun vote, aucun manifeste, aucun job,
 * et n'ouvre aucune connexion vers un provider d'envoi. Un item généré ici est
 * un texte à relire ; il ne devient envoyable que par un vote humain sur
 * `/pilot/r6b`, puis un lock sur `/pilot/r6b-dispatch`.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi la sélection n'est plus une constante TypeScript
 * ---------------------------------------------------------------------------
 * R6B-A choisissait cinq prospects à la main, dans `r6bSelection.SELECTED`.
 * C'était juste pour cinq ; c'est devenu un mur au sixième — faire relire deux
 * nouveaux prospects demandait d'éditer du code source. La sélection est
 * désormais un ARGUMENT (`--prospect`, ou `--stage` sur une campagne), et le
 * défaut sans argument reste mot pour mot le batch R6B-A.
 *
 * ---------------------------------------------------------------------------
 * Deux origines possibles pour le brouillon
 * ---------------------------------------------------------------------------
 *   `--generate-messages` (défaut) — angle et message regénérés par le pipeline
 *     de production, comme en R6B-A, dont les `outreach_messages` d'origine
 *     précédaient le changement de prompt de la clôture R6A.
 *
 *   `--reuse-messages` — le message déjà préparé par la campagne est repris
 *     MOT POUR MOT depuis `outreach_messages` (variante primaire). Regénérer un
 *     texte qu'on vient d'écrire ne produirait qu'une variation, et casserait le
 *     lien entre le texte, son angle et les preuves qui le fondent.
 *
 * Research réutilisée telle quelle dans les deux cas (§8 : « ne refais pas du
 * research déjà frais et exploitable sans raison »). Routing entièrement piloté
 * par `config/models.json` — aucun nom de modèle en dur ici.
 */
import { getSql } from '@/lib/db';
import { migrate } from '@/lib/db/migrate';
import { loadCampaign, loadOperatorProfile } from '@/lib/config/load';
import { createLogger } from '@/lib/logging/logger';
import { envBool } from '@/lib/env';
import { ModelRouter } from '@/lib/models/router';
import { ProspectRepository } from '@/lib/repo/prospects';
import { buildAngle, loadCaseStudy } from '@/lib/pipeline/angle';
import { generateMessages } from '@/lib/pipeline/message';
import { loadFirstTouchPersonalization } from '@/lib/pipeline/firstTouchPersonalizationStore';
import { contactChannels } from '@/lib/pipeline/reach';
import {
  BatchRequestError,
  SELECTED,
  loadPreparedMessage,
  parseBatchRequest,
  resolveBatchCandidates,
  toResearchResult,
  type BatchCandidate,
  type BatchRequest,
  type RawResearchRow,
} from '@/lib/pipeline/r6bSelection';
import { contactHistoryForProspect, describeGroup } from '@/lib/pipeline/businessContactGuard';
import type { Sql } from '@/lib/db/sql';

/** Le canal des messages repris par `--reuse-messages`. */
const REUSE_CHANNEL = 'instagram_dm';

async function latestResearch(sql: Sql, prospectId: string): Promise<RawResearchRow | null> {
  const rows = await sql.query<RawResearchRow>(
    `select id, summary, observations, opportunities, unknowns, confidence
       from prospect_research where prospect_id = $1 order by created_at desc limit 1`,
    [prospectId],
  );
  return rows[0] ?? null;
}

interface ReportEntry {
  name: string;
  blocked: boolean;
  hookGrounded: boolean;
  channels: string[];
  contactHistory: string;
  duplicates: string;
}

async function main(): Promise<void> {
  if (envBool('OUTBOUND_ALLOW_SENDING', false)) {
    throw new Error('OUTBOUND_ALLOW_SENDING must stay 0 in r6b:generate: this command prepares a human review, never a send.');
  }

  const request = parseBatchRequest(process.argv.slice(2));
  const logger = createLogger({ cmd: 'r6b:generate' });
  const campaign = loadCampaign(request.campaignSlug);
  const operatorProfile = loadOperatorProfile();

  const sql = await getSql();
  await migrate(sql);
  const repo = new ProspectRepository(sql, logger);
  const router = new ModelRouter({ sql, logger, maxCalls: 40 });
  const caseStudy = await loadCaseStudy(sql);

  const campaignRows = await sql.query<{ id: string }>('select id from campaigns where slug = $1', [
    request.campaignSlug,
  ]);
  const campaignId = campaignRows[0]?.id;
  if (!campaignId) throw new Error(`campagne « ${request.campaignSlug} » introuvable`);

  const candidates = await resolveCandidates(sql, request, campaignId);

  const batchRows = await sql.query<{ id: string }>(
    `insert into r6b_batches (slug, campaign_id) values ($1, $2)
     on conflict (slug) do update set slug = excluded.slug
     returning id`,
    [request.batchSlug, campaignId],
  );
  const batchId = batchRows[0]?.id;
  if (!batchId) throw new Error('failed to create r6b batch');

  const existing = await sql.query<{ prospect_id: string }>(
    'select prospect_id from r6b_batch_items where batch_id = $1',
    [batchId],
  );
  if (existing.length > 0) {
    process.stdout.write(
      `Le batch ${request.batchSlug} a déjà ${existing.length} item(s) — génération non rejouée (items immuables). ` +
        'Supprimer manuellement en base pour régénérer.\n',
    );
    await sql.close();
    return;
  }

  let itemIndex = 1;
  const report: ReportEntry[] = [];

  for (const candidate of candidates) {
    const prospect = await repo.get(candidate.prospectId);
    if (!prospect) throw new Error(`prospect ${candidate.prospectId} introuvable`);

    const researchRow = await latestResearch(sql, prospect.id);
    if (!researchRow) throw new Error(`aucune fiche research pour ${prospect.display_name}`);
    const research = toResearchResult(researchRow);
    if (research.observations.length === 0) {
      throw new Error(`fiche research de ${prospect.display_name} sans observation exploitable après relecture`);
    }

    let angleId: string | null;
    let draft: string;
    let modelRunId: string | null;
    let guardrailFlags: unknown;
    let hookEvidenceIds: unknown;
    let hookGrounded: boolean;
    let blocked = false;

    if (request.messageSource === 'reuse') {
      // R7-PILOT §6 — le texte n'est pas régénéré « pour varier ». Il est repris
      // tel quel, avec l'angle qui l'a produit, donc avec les preuves de cet
      // angle. Un message absent ou bloqué par un garde-fou ARRÊTE la commande :
      // en fabriquer un ici contournerait la raison pour laquelle il manque.
      const prepared = await loadPreparedMessage(sql, prospect.id, REUSE_CHANNEL);
      if (!prepared) {
        throw new Error(
          `aucun message primaire non bloqué en ${REUSE_CHANNEL} pour ${prospect.display_name} — ` +
            'lancer la campagne, ou générer avec --generate-messages',
        );
      }
      const angleRows = await sql.query<{ id: string; personalizationEvidence: unknown }>(
        `select id, personalization_evidence as "personalizationEvidence"
           from prospect_angles where id = $1`,
        [prepared.angleId],
      );
      const angleRow = angleRows[0];
      if (!angleRow) {
        throw new Error(`le message de ${prospect.display_name} ne référence aucun angle lisible`);
      }
      angleId = angleRow.id;
      draft = prepared.body;
      modelRunId = prepared.modelRunId;
      guardrailFlags = prepared.guardrailFlags;
      hookEvidenceIds = angleRow.personalizationEvidence;
      hookGrounded = Array.isArray(angleRow.personalizationEvidence) && angleRow.personalizationEvidence.length > 0;
    } else {
      const angle = await buildAngle(router, prospect, research, caseStudy);
      if (!angle) throw new Error(`angle indisponible pour ${prospect.display_name} — échec technique`);

      // FIRST-TOUCH-NATURALNESS-TUNE-R1 — les preuves déjà collectées, lues.
      //
      // Lecture SEULE, et fail-closed par construction : sans ligne assez
      // solide, `buildFirstTouchPersonalization` rend `GENERIC` et le prompt
      // repart sur l'ouverture honnête d'avant. Aucune donnée n'est créée ici,
      // aucune n'est inventée : ce sont les lignes `prospect_evidence` que la
      // découverte a écrites, et rien d'autre.
      //
      // `angleHook` est passé pour que l'accroche commerciale serve de REPLI
      // quand aucune preuve ne survit — c'est-à-dire exactement ce que le
      // prompt recevait jusqu'ici.
      const personalization = await loadFirstTouchPersonalization(sql, {
        prospectId: prospect.id,
        displayName: prospect.display_name,
        city: prospect.city,
        angleHook: angle.personalization,
      });
      logger.info('r6b.first_touch_personalization', {
        prospect: prospect.display_name,
        opening: personalization.opening,
        angle: personalization.hook?.angle ?? null,
        evidence: personalization.hook?.evidenceIds.length ?? 0,
      });

      let generated = await generateMessages(
        router, campaign, operatorProfile, prospect, research, angle, caseStudy, personalization,
      );
      if (!generated) throw new Error(`message indisponible pour ${prospect.display_name} — échec technique`);
      let chosen = generated.messages.find((m) => m.variant === generated!.chosenVariant);
      if (!chosen) throw new Error(`variante choisie introuvable pour ${prospect.display_name}`);

      // §12 : retry uniquement sur garde-fou bloquant, jamais pour "un plus beau texte".
      if (chosen.blocked) {
        logger.warn('r6b.guardrail_retry', { prospect: prospect.display_name, flags: chosen.guardrailFlags });
        generated = await generateMessages(
          router, campaign, operatorProfile, prospect, research, angle, caseStudy, personalization,
        );
        if (!generated) throw new Error(`message indisponible pour ${prospect.display_name} après retry`);
        chosen = generated.messages.find((m) => m.variant === generated!.chosenVariant);
        if (!chosen || chosen.blocked) {
          throw new Error(
            `garde-fou bloquant persistant pour ${prospect.display_name} après retry : ${JSON.stringify(chosen?.guardrailFlags)}`,
          );
        }
      }

      const angleRows = await sql.query<{ id: string }>(
        `insert into prospect_angles
           (prospect_id, research_id, pain_point, opportunity, approach, personalization,
            personalization_evidence, use_case_study, case_study_key, confidence, model_run_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
        [
          prospect.id,
          researchRow.id,
          angle.painPoint,
          angle.opportunity,
          angle.approach,
          angle.personalization,
          JSON.stringify(angle.personalizationEvidence),
          angle.useCaseStudy,
          angle.caseStudyKey,
          angle.confidence,
          angle.modelRunId,
        ],
      );
      const persisted = angleRows[0]?.id;
      if (!persisted) throw new Error('failed to persist angle');
      angleId = persisted;
      draft = chosen.body;
      modelRunId = generated.modelRunId;
      guardrailFlags = chosen.guardrailFlags;
      hookEvidenceIds = angle.personalizationEvidence;
      hookGrounded = angle.personalizationEvidence.length > 0;
      blocked = chosen.blocked;
    }

    const channels = contactChannels(prospect);

    // R7-PILOT §1 — l'historique de contact du COMMERCE, pas de la ligne.
    const { value: history, history: contactHistory } = await contactHistoryForProspect(sql, prospect.id);

    await sql.query(
      `insert into r6b_batch_items
         (batch_id, prospect_id, item_index, research_id, angle_id, model_run_id,
          original_draft, hook_evidence_ids, contact_channels, contact_history, guardrail_flags)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        batchId,
        prospect.id,
        itemIndex,
        researchRow.id,
        angleId,
        modelRunId,
        draft,
        JSON.stringify(hookEvidenceIds ?? []),
        JSON.stringify(channels),
        history,
        JSON.stringify(guardrailFlags ?? []),
      ],
    );

    report.push({
      name: prospect.display_name,
      blocked,
      hookGrounded,
      channels,
      contactHistory: history,
      duplicates: describeGroup(contactHistory.group),
    });
    itemIndex += 1;
  }

  process.stdout.write(`Batch ${request.batchSlug} (${batchId}) — ${report.length} item(s) générés.\n`);
  process.stdout.write(`  campagne                 ${request.campaignSlug}\n`);
  process.stdout.write(`  origine des messages     ${request.messageSource}\n`);
  for (const entry of report) {
    process.stdout.write(
      `  - ${entry.name} : hook grounded=${String(entry.hookGrounded)} blocked=${String(entry.blocked)} ` +
        `canaux=${entry.channels.join(',')} contact=${entry.contactHistory}\n`,
    );
    process.stdout.write(`      doublons : ${entry.duplicates}\n`);
  }
  process.stdout.write(`\nAppels LLM : ${String(router.callCount)}\n`);
  process.stdout.write('Aucun message envoyé, aucun vote écrit — la review humaine reste entière.\n');
  process.stdout.write(`Relire : /pilot/r6b?batch=${encodeURIComponent(request.batchSlug)}\n`);

  await sql.close();
}

/**
 * La sélection. Le chemin R6B-A garde sa liste écrite à la main et ses raisons ;
 * tout autre batch passe par la résolution générique.
 */
async function resolveCandidates(
  sql: Sql,
  request: BatchRequest,
  campaignId: string,
): Promise<BatchCandidate[]> {
  if (request.prospectIds.length === 0 && request.stage === null) {
    const rows = await sql.query<{ id: string; displayName: string }>(
      `select id, display_name as "displayName" from prospects where id = any($1::uuid[])`,
      [SELECTED.map((entry) => entry.id)],
    );
    const byId = new Map(rows.map((row) => [row.id, row.displayName]));
    return SELECTED.map((entry) => ({
      prospectId: entry.id,
      displayName: byId.get(entry.id) ?? entry.id,
      reason: entry.reason,
    }));
  }
  return resolveBatchCandidates(sql, request, campaignId);
}

main().catch((error: unknown) => {
  if (error instanceof BatchRequestError) {
    process.stderr.write(`REFUSÉ — ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
