import type { Sql } from '@/lib/db/sql';
import type { ResearchObservation, ResearchResult } from '@/lib/pipeline/research';

/**
 * Logique testable de la génération du batch R6B-A (`src/cli/r6b-generate.ts`
 * reste un wrapper fin qui appelle ce module + les fonctions de production
 * `buildAngle`/`generateMessages`, exactement comme les autres CLI de ce
 * dépôt séparent logique testée et script d'exécution).
 */

/**
 * Le batch R6B-A d'origine. Ce n'est plus « LE » batch : c'est le batch PAR
 * DÉFAUT, celui qu'une commande sans argument reproduit à l'identique, et celui
 * que `/pilot/r6b` affiche quand aucun `?batch=` n'est demandé. Les anciens
 * liens continuent donc de pointer là où ils pointaient.
 */
export const BATCH_SLUG = 'r6b-assisted-pilot-001';
export const CAMPAIGN_SLUG = 'example-campaign';

/**
 * Les cinq prospects dont le gold set R6A officiel (`src/lib/pipeline/goldSet.ts`)
 * cite déjà le message mot pour mot. Exclus explicitement de R6B-A : leur
 * texte est déjà celui que un opérateur a écrit/approuvé pour construire la voix
 * de production elle-même, et deux d'entre eux portent
 * même un vote humain enregistré (`r6a3_review_items`/`r6a4_review_items`).
 * Les réutiliser comme « premier vrai batch » serait circulaire.
 */
export const GOLD_SET_PROSPECT_IDS: readonly string[] = [
  'a906a564-a705-4ff2-af3d-a5acae937934', // SARL RPA
  'd25f9037-713b-4ffa-a1e9-5f87b93dca1d', // KAPITALCAR'E
  '1e572e04-2871-4c70-a441-f40f9036174e', // DEMOJULIET
  '8ead2db9-3901-469b-9346-2a983566fa9c', // RAISE ATELIER CAR
  'cb240888-f269-49be-a5dd-e929468ce353', // Car Protect Annecy
];

export interface R6bSelectionEntry {
  id: string;
  reason: string;
}

/** §5–§6 de la mission : sélection à la main, raison courte par prospect. */
export const SELECTED: readonly R6bSelectionEntry[] = [
  {
    id: 'd5cddd2d-fdcb-4808-b378-51dd6e7cf7c1', // DEMO PROSPECT A — Aubagne
    reason:
      'prestation standard écologique sans eau + intervention à domicile, identité en manual_review mais SIREN/adresse publiés, score 74/A, tarifs précis affichés — cœur de cible prestation standard/atelier',
  },
  {
    id: 'a990d98c-2503-4297-b3d8-6da9a6204ca9', // VTC LYONNAIS 69800 (site "Prestation Auto Lyon") — Bron
    reason:
      'prestation/vente de produits/rénovation d’optiques, identité confirmée (SIREN publié), aucune dominante REVENTE/revente — diversifie le batch',
  },
  {
    id: 'fb36152e-bf78-4e87-ad19-3a693eafbcac', // Cleanyourcar69
    reason:
      'prestation standard intérieur à domicile pur, deux formules à prix affichés (50€/80€), aucune mention REVENTE/revente',
  },
  {
    id: 'fda45003-b959-4677-aa8a-c8798c3325d5', // DEMO FOXTROT — Vaugneray
    reason:
      'atelier haut de gamme (vente de produits multi-étapes, boutique en ligne), identité confirmée, tarifs précis jusqu’à 1800€ — un seul prospect à dominante premium/REVENTE dans le lot',
  },
  {
    id: 'dbf3c25d-5b6d-4b36-9eb4-50623630f203', // EXAMPLE SERVICES — Chalamont
    reason:
      'centre de atelier (prestation standard intérieur, vente de produits, boutique en ligne, REVENTE en options), identité en manual_review, zone Lyon/Bourg-en-Bresse/Annecy — complète le lot sans le faire basculer côté REVENTE/revente',
  },
];

export interface RawResearchRow {
  id: string;
  summary: string;
  observations: unknown;
  opportunities: unknown;
  unknowns: unknown;
  confidence: number;
}

/**
 * Reconstruit un `ResearchResult` depuis la ligne `prospect_research` la plus
 * récente. Les lignes du corpus `example-campaign` (2026-08-10)
 * précèdent la pluralisation `evidenceIds` de R5.1 et portent encore
 * `evidenceId` au singulier — normalisé ici plutôt que relancé (§8 : « ne
 * refais pas du research déjà frais et exploitable sans raison »).
 */
export function toResearchResult(row: RawResearchRow): ResearchResult {
  const rawObservations = Array.isArray(row.observations) ? row.observations : [];
  const observations: ResearchObservation[] = rawObservations.map((entry) => {
    const obs = entry as {
      text?: unknown;
      evidenceIds?: unknown;
      evidenceId?: unknown;
      sourceUrl?: unknown;
      provider?: unknown;
    };
    const evidenceIds = Array.isArray(obs.evidenceIds)
      ? obs.evidenceIds.map(String)
      : typeof obs.evidenceId === 'string'
        ? [obs.evidenceId]
        : [];
    return {
      text: String(obs.text ?? ''),
      evidenceIds,
      sourceUrl: typeof obs.sourceUrl === 'string' ? obs.sourceUrl : null,
      provider: typeof obs.provider === 'string' ? obs.provider : '',
    };
  });

  return {
    summary: row.summary,
    observations,
    opportunities: Array.isArray(row.opportunities) ? row.opportunities.map(String) : [],
    unknowns: Array.isArray(row.unknowns) ? row.unknowns.map(String) : [],
    confidence: row.confidence,
    droppedObservations: [],
    modelRunId: null,
  };
}

/**
 * §6 : jamais d'affirmation "not_contacted" par supposition. `not_contacted`
 * n'est retourné que lorsque le compte d'`outreach_events` pour ce prospect
 * est structurellement nul ; sinon `unknown`, jamais supposé.
 */
export function contactHistoryFromCount(outreachEventCount: number): 'not_contacted' | 'unknown' {
  return outreachEventCount === 0 ? 'not_contacted' : 'unknown';
}

// ---------------------------------------------------------------------------
// R7-PILOT §2 — un batch se DEMANDE, il ne se code plus en dur
// ---------------------------------------------------------------------------

/**
 * Pourquoi cette section existe.
 *
 * `SELECTED` ci-dessus est une liste de cinq UUID écrite à la main en août 2026
 * pour le premier batch. C'était le bon geste ce jour-là — cinq prospects
 * choisis un par un, avec leur raison — et c'est devenu le mur suivant : faire
 * relire deux nouveaux prospects par un humain demandait d'éditer un fichier
 * TypeScript, de recompiler, et de committer. Un rail de review dont l'entrée
 * est un littéral source n'est pas un rail, c'est un cas particulier.
 *
 * Ce qui suit rend l'entrée paramétrable SANS toucher à ce qui la suit : la
 * review humaine, le vote, le manifeste, le lock, l'enfilement et le canari
 * sont inchangés, et le restent. Un candidat entre dans un batch ; il n'en sort
 * approuvé que par un humain.
 *
 * Ce que ce module ne fait toujours pas, et ne fera pas : voter, approuver,
 * verrouiller, envoyer.
 */

/** Comment le brouillon d'un item est obtenu. */
export type MessageSource =
  /** Angle + message regénérés par le pipeline de production (comportement R6B-A). */
  | 'generate'
  /**
   * Le message DÉJÀ préparé est repris tel quel depuis `outreach_messages`
   * (variante primaire). Regénérer un texte que la campagne vient d'écrire
   * produirait une variation sans raison, et ferait perdre le lien avec l'angle
   * et les preuves qui l'ont justifié.
   */
  | 'reuse';

export interface BatchRequest {
  readonly batchSlug: string;
  readonly campaignSlug: string;
  readonly messageSource: MessageSource;
  /** Sélection explicite, prospect par prospect. Prioritaire sur `stage`. */
  readonly prospectIds: readonly string[];
  /** Sélection par état du pipeline, dans la campagne demandée. */
  readonly stage: string | null;
  readonly limit: number | null;
}

export const DEFAULT_BATCH_REQUEST: BatchRequest = Object.freeze({
  batchSlug: BATCH_SLUG,
  campaignSlug: CAMPAIGN_SLUG,
  messageSource: 'generate',
  prospectIds: Object.freeze(GOLD_SET_PROSPECT_IDS.slice(0, 0)),
  stage: null,
  limit: null,
});

export class BatchRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BatchRequestError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Les arguments de `npm run r6b:generate`, en une fonction pure et testable.
 *
 * Sans argument, elle rend exactement la demande R6B-A : même slug, même
 * campagne, même mode de génération. Un dépôt qui relance la commande
 * historique obtient l'historique, pas une surprise.
 */
export function parseBatchRequest(argv: readonly string[]): BatchRequest {
  let batchSlug: string | null = null;
  let campaignSlug: string | null = null;
  let messageSource: MessageSource | null = null;
  let stage: string | null = null;
  let limit: number | null = null;
  const prospectIds: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case '--batch':
        batchSlug = (argv[++i] ?? '').trim();
        break;
      case '--campaign':
        campaignSlug = (argv[++i] ?? '').trim();
        break;
      case '--prospect': {
        const value = (argv[++i] ?? '').trim();
        if (!UUID_RE.test(value)) throw new BatchRequestError(`--prospect attend un UUID, reçu « ${value} »`);
        if (!prospectIds.includes(value)) prospectIds.push(value);
        break;
      }
      case '--stage':
        stage = (argv[++i] ?? '').trim();
        break;
      case '--limit': {
        const value = Number.parseInt(argv[++i] ?? '', 10);
        if (!Number.isFinite(value) || value < 1) throw new BatchRequestError('--limit attend un entier ≥ 1');
        limit = value;
        break;
      }
      case '--reuse-messages':
        messageSource = 'reuse';
        break;
      case '--generate-messages':
        messageSource = 'generate';
        break;
      default:
        throw new BatchRequestError(
          `option inconnue : « ${String(token)} » — cette commande n'a ni --send, ni --approve, ni --lock`,
        );
    }
  }

  if (batchSlug === null && campaignSlug === null && prospectIds.length === 0 && stage === null) {
    return DEFAULT_BATCH_REQUEST;
  }
  if (batchSlug === null || batchSlug.length === 0) {
    throw new BatchRequestError('--batch <slug> est obligatoire dès qu’un autre argument est donné');
  }
  if (campaignSlug === null || campaignSlug.length === 0) {
    throw new BatchRequestError('--campaign <slug> est obligatoire : un batch appartient à une campagne');
  }
  if (prospectIds.length === 0 && stage === null) {
    throw new BatchRequestError(
      'aucune sélection : donner au moins un --prospect <uuid>, ou --stage <état> pour prendre la campagne',
    );
  }
  if (batchSlug === BATCH_SLUG) {
    // Le batch R6B-A porte cinq items votés et deux canaris déjà partis. Le
    // réalimenter depuis une autre sélection mélangerait deux lots dans un même
    // écran de review, et donnerait à des votes anciens l'air de porter sur de
    // nouveaux textes.
    throw new BatchRequestError(
      `« ${BATCH_SLUG} » est le batch historique R6B-A — choisir un autre slug plutôt que de le réalimenter`,
    );
  }

  return Object.freeze({
    batchSlug,
    campaignSlug,
    messageSource: messageSource ?? 'generate',
    prospectIds: Object.freeze([...prospectIds]),
    stage,
    limit,
  });
}

export interface BatchCandidate {
  readonly prospectId: string;
  readonly displayName: string;
  readonly reason: string;
}

/**
 * Les candidats d'une demande, lus en base.
 *
 * Deux règles de refus, toutes deux préférant l'arrêt à l'approximation :
 *
 *   * un `--prospect` qui n'appartient pas à la campagne demandée est une
 *     erreur, pas un rattachement implicite. Un batch dont les items viennent
 *     de campagnes différentes rendrait `r6b_batches.campaign_id` faux ;
 *   * un `--stage` qui ne rend rien est une erreur, pas un batch vide. Un batch
 *     vide s'affiche comme « rien à relire », ce qui ressemble beaucoup trop à
 *     « tout est relu ».
 */
export async function resolveBatchCandidates(
  sql: Sql,
  request: BatchRequest,
  campaignId: string,
): Promise<BatchCandidate[]> {
  if (request.prospectIds.length > 0) {
    const rows = await sql.query<{ id: string; displayName: string; campaignId: string; stage: string | null }>(
      `select id, display_name as "displayName", campaign_id as "campaignId", stage
         from prospects where id = any($1::uuid[])`,
      [[...request.prospectIds]],
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    return request.prospectIds.map((prospectId) => {
      const row = byId.get(prospectId);
      if (!row) throw new BatchRequestError(`prospect ${prospectId} introuvable`);
      if (row.campaignId !== campaignId) {
        throw new BatchRequestError(
          `prospect ${prospectId} (${row.displayName}) n'appartient pas à la campagne « ${request.campaignSlug} »`,
        );
      }
      return {
        prospectId,
        displayName: row.displayName,
        reason: `sélection explicite (--prospect), état « ${row.stage ?? 'inconnu'} »`,
      };
    });
  }

  const rows = await sql.query<{ id: string; displayName: string; score: number | null }>(
    `select id, display_name as "displayName", score
       from prospects
      where campaign_id = $1 and stage = $2 and dedupe_status <> 'merged'
      order by score desc nulls last, created_at asc
      limit $3`,
    [campaignId, request.stage, request.limit ?? 50],
  );
  if (rows.length === 0) {
    throw new BatchRequestError(
      `aucun prospect en état « ${request.stage ?? '—'} » dans « ${request.campaignSlug} » — rien à relire`,
    );
  }
  return rows.map((row) => ({
    prospectId: row.id,
    displayName: row.displayName,
    reason: `état « ${request.stage ?? '—'} » dans ${request.campaignSlug}, score ${row.score ?? '—'}`,
  }));
}

/**
 * Le message déjà préparé d'un prospect, repris tel quel.
 *
 * La variante PRIMAIRE, la plus récente, sur le canal demandé — et rien d'autre.
 * Un message bloqué par un garde-fou n'est pas repris : le garde-fou avait
 * raison au moment où il l'a dit, et un batch de review n'est pas l'endroit où
 * on le contourne.
 */
export interface PreparedMessage {
  readonly messageId: string;
  readonly angleId: string | null;
  readonly body: string;
  readonly modelRunId: string | null;
  readonly guardrailFlags: unknown;
}

export async function loadPreparedMessage(
  sql: Sql,
  prospectId: string,
  channel: string,
): Promise<PreparedMessage | null> {
  const rows = await sql.query<PreparedMessage & { blocked: boolean }>(
    `select id as "messageId", angle_id as "angleId", body, model_run_id as "modelRunId",
            guardrail_flags as "guardrailFlags",
            (jsonb_array_length(coalesce(guardrail_flags, '[]'::jsonb)) > 0) as blocked
       from outreach_messages
      where prospect_id = $1 and channel = $2 and is_primary = true
      order by created_at desc
      limit 1`,
    [prospectId, channel],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.blocked) return null;
  return {
    messageId: row.messageId,
    angleId: row.angleId,
    body: row.body,
    modelRunId: row.modelRunId,
    guardrailFlags: row.guardrailFlags,
  };
}
