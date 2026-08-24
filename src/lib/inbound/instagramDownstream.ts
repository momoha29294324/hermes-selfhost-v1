import type { Sql } from '@/lib/db/sql';
import type { ModelRouter } from '@/lib/models/router';
import type { CrmResolution } from '@/lib/crm/types';
import { processNewReplies } from '@/lib/replies/process';
import type { DownstreamReport, DownstreamStep } from '@/lib/inbound/instagramRuntime';

/**
 * IG5.2A §8 — l'aval du runtime entrant, qui est l'aval DÉJÀ ÉCRIT.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi ce fichier ne contient presque rien
 * ---------------------------------------------------------------------------
 *
 * Parce que c'est la preuve. La mission demande d'ORCHESTRER le pipeline
 * D2 — classification, transitions, suppression de séquence, projection CRM,
 * brouillon `PROPOSED` — pas d'en écrire un second. S'il avait fallu plus de
 * vingt lignes ici, c'est qu'on aurait recommencé quelque chose.
 *
 * `processNewReplies` est exactement ce que lance `npm run r6b:replies:process`,
 * appelé avec les mêmes arguments. Il n'existe donc aucun chemin entrant
 * Instagram qui classe autrement que le chemin e-mail : `r6b_inbound_messages`
 * est partagée depuis 0042, et la requête de sélection de l'aval ne porte aucun
 * filtre de canal.
 *
 * ---------------------------------------------------------------------------
 * `includeAnalyzed: true`, toujours
 * ---------------------------------------------------------------------------
 *
 * C'est le mode `--resume` de la CLI, et le runtime le tient allumé en
 * permanence. La raison est §9 : un collecteur tué APRÈS avoir écrit l'analyse
 * mais AVANT le brouillon, la projection CRM ou l'alerte laisse un dossier à
 * moitié fait. Sans ce drapeau, ce message ne serait plus jamais candidat — il
 * a déjà une analyse vivante — et le trou serait permanent.
 *
 * Le repasser ne reclasse rien et n'appelle aucun modèle quand il n'y a rien à
 * finir : `processReply` réutilise l'analyse vivante tant que le contexte n'a
 * pas changé, et chaque étape aval est idempotente.
 */
export interface ReplyProcessingOptions {
  readonly limit: number;
  readonly crm?: CrmResolution;
  readonly alertProviderConfigured?: boolean;
}

export function createReplyProcessingStep(router: ModelRouter, options: ReplyProcessingOptions): DownstreamStep {
  return async (sql: Sql): Promise<DownstreamReport> => {
    const report = await processNewReplies(
      sql,
      router,
      { crm: options.crm, alertProviderConfigured: options.alertProviderConfigured ?? false },
      { limit: options.limit, includeAnalyzed: true },
    );
    return Object.freeze({
      candidates: report.candidates,
      classified: report.classified,
      drafted: report.drafted,
      absorbed: report.absorbed.length,
      failures: report.failures.length,
      detail:
        `${report.processed.length} traité(s), ${report.classified} classifié(s), ` +
        `${report.drafted} brouillon(s), ${report.absorbed.length} bulle(s) absorbée(s), ` +
        `${report.skipped.length} ignoré(s), ${report.failures.length} échec(s)`,
    });
  };
}
