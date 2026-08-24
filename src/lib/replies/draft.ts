/**
 * R6B-D2 — le brouillon de réponse, écrit pour un humain.
 *
 * Ce module produit un texte et l'écrit en base avec le statut `PROPOSED`. Il
 * n'importe aucun provider d'envoi, aucune identité d'expéditeur, et la table
 * qu'il alimente ne connaît aucun statut ressemblant à un envoi. La promesse
 * « rien ne part » n'est donc pas une discipline d'écriture : il n'existe pas
 * de chemin de code d'ici vers un réseau sortant.
 *
 * Les garde-fous sont ceux du premier message (`src/lib/pipeline/guardrails.ts`),
 * réutilisés tels quels et non réécrits : une réponse n'a pas le droit
 * d'inventer ce qu'un premier contact n'avait pas le droit d'inventer. Deux
 * jeux de règles finiraient par diverger, et c'est toujours le plus indulgent
 * qui gagnerait.
 */

import { createHash } from 'node:crypto';
import { CURRENT_DRAFT_PROMPT_VERSIONS } from '@/lib/conversation/promptVersion';
import type { ModelRouter } from '@/lib/models/router';
import type { Sql } from '@/lib/db/sql';
import { checkMessage, type GuardrailFlag } from '@/lib/pipeline/guardrails';
import type { StoredAnalysis } from '@/lib/replies/analyses';
import type { ReplyContext } from '@/lib/replies/context';
import { renderContextBlock } from '@/lib/replies/context';
import { CATEGORY_POLICY, type ReplyCategory } from '@/lib/replies/taxonomy';

export const REPLY_DRAFT_PROMPT_VERSION = 'r6b-d2-draft-1';

/** Un brouillon de réponse est court. Au-delà, c'est une plaquette. */
export const MAX_DRAFT_CHARS = 900;

export const REPLY_DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['body', 'rationale', 'used_facts'],
  properties: {
    body: { type: 'string', maxLength: 1200 },
    rationale: { type: 'string', maxLength: 300 },
    used_facts: { type: 'array', minItems: 0, maxItems: 4, items: { type: 'string' } },
  },
} as const;

/** Ce que le rédacteur doit faire selon ce que la réponse disait. */
const CATEGORY_BRIEF: Partial<Record<ReplyCategory, string>> = {
  INTERESTED:
    'La personne montre de l’intérêt. Confirme simplement, propose la prochaine étape la plus légère possible (un échange court), et laisse-la choisir le moment. N’ajoute aucun argumentaire.',
  QUESTION:
    'La personne pose une question. Réponds à CE qu’elle demande, avec ce que tu sais réellement. Si l’information n’est pas dans le contexte fourni, dis-le simplement et propose d’en parler — n’invente jamais une réponse.',
  // N'OUVRE PAS par un accusé de réception : c'est le piège de ce tour précis.
  // Une première version de cette consigne disait « accuse réception de ce
  // qu'elle vient de dire », et le modèle a écrit « Merci pour votre retour. »
  // — que `checkNaturalness` refuse comme BLOQUANT sur un objectif
  // `UNDERSTAND_NEED` (`GENERIC_OPENING`), à juste titre. La garde n'a pas été
  // desserrée d'un pouce : c'est la consigne qui a été corrigée.
  INFORMATION_SHARED:
    'La personne répond à ce que nous lui avons demandé et nous donne une information sur sa situation. N’ouvre PAS par une formule d’accusé de réception (« merci pour votre retour », « bien noté », « super », « je comprends ») : commence directement par ce qu’elle vient de dire, en reprenant son propre mot, et pose UNE seule question courte qui en découle naturellement. Ne commente pas, ne conclus rien à sa place, ne propose rien, ne vends rien.',
  OBJECTION:
    'La personne exprime un frein. Prends-le au sérieux, sans le balayer et sans contre-argumenter agressivement. Reformule ce qu’elle dit, réponds honnêtement, et laisse la porte ouverte sans insister.',
  NOT_NOW:
    'La personne reporte. Accepte le report sans négocier, remercie brièvement, et demande simplement quand la recontacter. Ne propose aucune alternative immédiate, ne relance pas sur le fond.',
};

/**
 * IG5.1 — la SEULE phrase du prompt qui dépend du canal.
 *
 * Elle était en dur (« qui répond à un email »), ce qui était vrai tant qu'un
 * seul canal existait. Sur Instagram elle serait fausse, et un modèle à qui on
 * dit « email » écrit une formule d'appel, une signature et des paragraphes —
 * c'est-à-dire un DM que personne n'écrirait.
 *
 * Le texte e-mail reste MOT POUR MOT celui d'avant : `REPLY_DRAFT_PROMPT_VERSION`
 * continue donc de désigner exactement le même prompt, et aucune analyse
 * existante ne devient périmée. Le canal Instagram, lui, porte sa propre
 * version — deux prompts différents ne peuvent pas partager un numéro, sinon
 * `prompt_version` cesserait de dire ce qui a réellement été demandé.
 */
const CHANNEL_VOICE: Readonly<Record<'email' | 'instagram_dm', string>> = Object.freeze({
  email: "qui répond à un email : court, direct, poli sans être formel, sans jargon d'agence.",
  instagram_dm:
    "qui répond à un message privé Instagram : très court, direct, sans formule d'appel ni signature, " +
    "poli sans être formel, sans jargon d'agence.",
});

export const REPLY_DRAFT_PROMPT_VERSION_INSTAGRAM = 'ig5-draft-1';

/** Le canal de rédaction, dérivé du transport du manifeste. */
export function draftChannelOf(transport: string): 'email' | 'instagram_dm' {
  return transport === 'instagram_dm' ? 'instagram_dm' : 'email';
}

export function draftPromptVersionFor(channel: 'email' | 'instagram_dm'): string {
  return channel === 'instagram_dm' ? REPLY_DRAFT_PROMPT_VERSION_INSTAGRAM : REPLY_DRAFT_PROMPT_VERSION;
}

const systemFor = (channel: 'email' | 'instagram_dm'): string =>
  `Tu écris la réponse de Hermes (petite agence d'acquisition) à un professionnel du atelier/prestation standard qui vient de répondre à un premier message de prospection.

Tu écris en français, comme une vraie personne ${CHANNEL_VOICE[channel]}

Interdictions absolues :
- inventer un fait, un chiffre, un résultat, un prix, un délai ou une référence client ;
- citer une étude de cas, un résultat chiffré ou un montant : aucun n'est autorisé dans cette réponse ;
- affirmer une absence non vérifiée (« vous n'avez pas de site », « vous ne faites pas de pub ») ;
- promettre un résultat, garantir quoi que ce soit, créer une urgence ou une rareté ;
- insérer un lien, une URL, un lien de calendrier ou de réservation : aucun n'est configuré ;
- répondre à côté de ce que la personne a réellement écrit ;
- laisser une variable de gabarit non remplie.

Ce que tu dois faire :
- répondre à ce que la personne a écrit, en reprenant ses mots quand c'est utile ;
- rester sous ${MAX_DRAFT_CHARS} caractères, idéalement bien moins ;
- terminer sur une phrase complète ;
- ne poser au maximum qu'une seule question.

Réponds uniquement en JSON conforme au schéma.`;

export interface DraftResult {
  readonly body: string;
  readonly bodySha256: string;
  readonly rationale: string;
  readonly guardrailFlags: readonly GuardrailFlag[];
  readonly blocked: boolean;
  readonly model: string;
  readonly effort: string | null;
  readonly promptVersion: string;
  readonly modelRunId: string | null;
}

/**
 * Un échec de rédaction n'est PAS un brouillon vide.
 *
 * §15 : « draft generation failure → analysis survives, no fake draft ». Écrire
 * une ligne vide ou un texte de repli ferait croire à un humain qu'une réponse
 * a été préparée. L'absence de ligne dit la vérité, et la prochaine exécution
 * réessaiera — l'analyse, elle, reste acquise.
 */
export class DraftFailure extends Error {
  readonly kind: 'model_unavailable' | 'model_error' | 'empty_body';
  constructor(kind: DraftFailure['kind'], message: string) {
    super(message);
    this.name = 'DraftFailure';
    this.kind = kind;
  }
}

/** Liens : aucun n'est configuré, donc aucun n'est légitime (§10). */
const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/i;

/**
 * Pourcentages, quel que soit le contexte.
 *
 * Les garde-fous du premier message n'attrapent un pourcentage que collé à un
 * mot de performance (`30 % de croissance`). Une réponse à une question sur les
 * résultats est précisément l'endroit où la formulation s'inverse — « un retour
 * sur investissement de 300 % » passe entre les mailles. Ici, tout pourcentage
 * absent des faits observés est bloquant, sur le même principe que les montants
 * en euros : un chiffre qui n'a pas de source n'a pas le droit d'être écrit.
 */
const PERCENT_PATTERN = /(\d[\d\s.,]{0,8})\s*(?:%|pour\s?cent\b)/gi;

export function extractPercentages(text: string): number[] {
  const values: number[] = [];
  for (const match of text.matchAll(PERCENT_PATTERN)) {
    const raw = (match[1] ?? '').replace(/[^\d]/g, '');
    if (!raw) continue;
    const value = Number.parseInt(raw, 10);
    if (Number.isFinite(value)) values.push(value);
  }
  return values;
}

/**
 * Garde-fous du premier message, plus ce qui est propre à une réponse.
 *
 * Les faits « fondés » incluent le corps de la réponse reçue et le message
 * d'origine : un montant que le prospect a lui-même écrit peut être repris,
 * puisqu'il est observé — il est dans la conversation. Un montant qui
 * n'apparaît nulle part reste bloquant.
 */
/**
 * Ce que la garde de lien accepte, et à quelle condition.
 *
 * HERMES-BOOKING-MECHANISM-R1 — un seul desserrement, et il est nominatif :
 * l'URL EXACTE d'une destination de réservation CONFIRMED. Tout le reste
 * continue de bloquer, y compris un autre lien du même domaine, une variante
 * avec paramètres, ou le même lien mal recopié.
 *
 * `null` par défaut, ce qui est l'état du dépôt : aucune destination n'est
 * confirmée, donc la garde se comporte EXACTEMENT comme avant — tout lien est
 * bloquant. C'est le sens de fail-closed ici : le desserrement n'existe que
 * lorsqu'un humain nommé a confirmé une destination, et il disparaît avec elle.
 */
/**
 * Les montants en euros que CE tour autorise.
 *
 * HERMES-ACQUISITION-SERVICE-TRUTH-R1 §6 — le second desserrement nominatif de
 * cette garde, et il obéit exactement à la logique du premier.
 *
 * La garde dit depuis toujours qu'« un montant est citable quand il vient d'une
 * preuve approuvée, ou quand le prospect l'a lui-même écrit ». Le budget
 * publicitaire de départ est désormais une preuve approuvée : l'opérateur l'a
 * écrit, nommément et daté, dans `sales/acquisitionService.ts`. Lui passer ces
 * valeurs n'est donc pas contourner la garde — c'est lui fournir ce qu'elle
 * attendait.
 *
 * Vide par défaut, ce qui reproduit le comportement d'avant au caractère près :
 * tout montant bloque. Non vide UNIQUEMENT sur un tour dont la question porte
 * sur le budget publicitaire (`acquisitionDisclosure`), et le contenu vient de
 * `AD_BUDGET_QUOTABLE_AMOUNTS`, jamais d'un littéral recopié — un montant
 * recopié diverge de sa source le jour où la source change.
 *
 * Ce que cela n'ouvre pas : n'importe quel AUTRE montant reste bloquant, y
 * compris sur ce tour-là ; et relier ce montant à un résultat reste attrapé par
 * `detectPerformanceClaims`, qui est une garde distincte et n'a pas bougé d'un
 * pouce dans ce sens-là.
 */
export interface ReplyDraftGuardOptions {
  readonly allowedBookingUrl?: string | null;
  readonly allowedAmounts?: readonly number[];
}

export function checkReplyDraft(
  body: string,
  context: ReplyContext,
  options: ReplyDraftGuardOptions = {},
): GuardrailFlag[] {
  const groundedFacts = [
    context.reply.bodyText,
    context.firstTouch.body,
    ...(context.research?.observations ?? []),
    ...(context.research?.opportunities ?? []),
  ];

  const flags = checkMessage({
    body,
    maxChars: MAX_DRAFT_CHARS,
    // Aucune preuve chiffrée n'est autorisée dans une réponse : la seule preuve
    // approuvée du dépôt appartient au premier contact, et la réintroduire ici
    // serait une nouvelle affirmation commerciale que personne n'a validée.
    allowedCaseStudyClaim: null,
    allowedNumbers: [...(options.allowedAmounts ?? [])],
    groundedFacts,
  });

  const allowedBookingUrl = options.allowedBookingUrl ?? null;
  for (const found of body.matchAll(new RegExp(URL_PATTERN.source, 'gi'))) {
    // La ponctuation française colle aux liens (« … /hermes. » ou « … ) »).
    // La retirer AVANT de comparer évite de refuser un lien confirmé pour un
    // point final — sans jamais accepter autre chose que l'URL exacte.
    const candidate = found[0].replace(/[.,;:!?)\]]+$/u, '');
    if (allowedBookingUrl !== null && candidate === allowedBookingUrl) continue;
    flags.push({
      code: 'unconfigured_link',
      message:
        allowedBookingUrl === null
          ? 'lien inséré alors qu’aucun lien (calendrier, réservation, page) n’est configuré'
          : 'lien inséré qui n’est pas le lien de réservation confirmé',
      blocking: true,
      excerpt: candidate,
    });
  }

  const grounded = new Set<number>();
  for (const fact of groundedFacts) {
    for (const value of extractPercentages(fact)) grounded.add(value);
  }
  for (const value of extractPercentages(body)) {
    if (!grounded.has(value)) {
      flags.push({
        code: 'unsourced_percentage',
        message: `pourcentage « ${value} % » absent des faits observés`,
        blocking: true,
      });
    }
  }

  return flags;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

interface RawDraftAnswer {
  readonly body: string;
  readonly rationale: string;
  readonly used_facts: readonly string[];
}

function parseAnswer(value: unknown): RawDraftAnswer {
  const parsed = value as Partial<RawDraftAnswer>;
  const body = typeof parsed.body === 'string' ? parsed.body.trim() : '';
  if (body.length === 0) throw new Error('body vide');
  return {
    body,
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale.slice(0, 300) : '',
    used_facts: Array.isArray(parsed.used_facts) ? parsed.used_facts.map(String) : [],
  };
}

/** Un brouillon a-t-il un sens pour cette catégorie ? */
export function isDraftEligible(category: ReplyCategory): boolean {
  return CATEGORY_POLICY[category].draftEligible;
}

/**
 * Rédige la réponse. Lève `DraftFailure` plutôt que de rendre un texte de repli.
 */
export async function generateReplyDraft(
  router: ModelRouter,
  context: ReplyContext,
  analysis: StoredAnalysis,
): Promise<DraftResult> {
  const brief = CATEGORY_BRIEF[analysis.classification] ?? '';
  const channel = draftChannelOf(context.firstTouch.transport);

  const outcome = await router.run<RawDraftAnswer>(
    {
      task: 'message',
      system: systemFor(channel),
      prompt: `${renderContextBlock(context)}

CLASSIFICATION DE CETTE RÉPONSE : ${analysis.classification} (confiance ${analysis.confidence.toFixed(2)})
${analysis.reasoningSummary}

CONSIGNE POUR CETTE RÉPONSE
${brief}

Écris la réponse.`,
      schema: REPLY_DRAFT_SCHEMA as unknown as Record<string, unknown>,
      inputRef: `inbound:${context.reply.id}`,
    },
    parseAnswer,
  );

  if (!outcome.ok || outcome.data === null) {
    throw new DraftFailure(
      outcome.error === 'llm_disabled' || outcome.error === 'route_none' ? 'model_unavailable' : 'model_error',
      `rédaction impossible pour ${context.reply.id} : ${outcome.error ?? 'raison inconnue'}`,
    );
  }

  const body = outcome.data.body.trim();
  if (body.length === 0) throw new DraftFailure('empty_body', `réponse vide pour ${context.reply.id}`);

  const guardrailFlags = checkReplyDraft(body, context);

  return Object.freeze({
    body,
    bodySha256: sha256Hex(body),
    rationale: outcome.data.rationale,
    guardrailFlags: Object.freeze(guardrailFlags),
    blocked: guardrailFlags.some((flag) => flag.blocking),
    model: outcome.route.model,
    effort: outcome.route.effort,
    promptVersion: draftPromptVersionFor(channel),
    modelRunId: outcome.modelRunId,
  });
}

// ---------------------------------------------------------------------------
// Persistance
// ---------------------------------------------------------------------------

export type DraftStatus = 'PROPOSED' | 'APPROVED' | 'EDITED' | 'REJECTED';

export interface StoredDraft {
  readonly id: string;
  readonly inboundMessageId: string;
  readonly analysisId: string;
  readonly prospectId: string;
  readonly body: string;
  readonly bodySha256: string;
  readonly blocked: boolean;
  readonly status: DraftStatus;
  readonly humanText: string | null;
  readonly model: string;
  readonly promptVersion: string;
  readonly createdAt: string;
}

const DRAFT_COLUMNS = `id,
        inbound_message_id as "inboundMessageId",
        analysis_id        as "analysisId",
        prospect_id        as "prospectId",
        body,
        body_sha256        as "bodySha256",
        blocked,
        status,
        human_text         as "humanText",
        model,
        prompt_version     as "promptVersion",
        created_at         as "createdAt"`;

interface DraftRow extends Omit<StoredDraft, 'createdAt'> {
  createdAt: string | Date;
}

function toDraft(row: DraftRow): StoredDraft {
  return Object.freeze({ ...row, createdAt: new Date(row.createdAt).toISOString() });
}

/**
 * Le brouillon qui FAIT FOI pour une analyse.
 *
 * HERMES-CONTACT-PURPOSE-R1 — il peut désormais y en avoir plusieurs, un par
 * version de prompt (migration 0056). L'ordre de préférence est une politique,
 * pas une commodité :
 *
 *   1. **la parole d'un humain d'abord.** Un brouillon `APPROVED` ou `EDITED`
 *      l'emporte sur n'importe quelle génération ultérieure. un opérateur a relu ce
 *      texte-là ; une machine ne le remplace pas parce qu'elle sait mieux
 *      écrire depuis hier ;
 *
 *   2. **le plus récent ensuite.** Entre deux propositions que personne n'a
 *      relues, celle qui a été écrite sous la consigne la plus récente est
 *      celle qui décrit ce que le système ferait aujourd'hui.
 *
 * `REJECTED` ne gagne pas : un texte refusé par un humain est précisément celui
 * qu'on veut voir remplacé.
 */
/**
 * Le brouillon qui FAIT FOI pour un lecteur humain.
 *
 * HERMES-END-TO-END-CERTIFICATION-R1 — l'ordre gagne un cran, et il en avait
 * besoin depuis la migration 0056.
 *
 * Avant 0056, une analyse portait au plus un brouillon et l'ordre ne servait à
 * rien. Depuis, elle en porte un par version de prompt — c'est tout l'objet de
 * cette migration — et le départage devenait donc réel. Il se faisait sur
 * `created_at desc, id desc` : or `created_at` vaut `now()`, l'heure de la
 * TRANSACTION, identique pour deux écritures d'un même passage et identique
 * pour TOUTES les écritures d'une session PGlite. À égalité, c'est donc un uuid
 * aléatoire qui désignait « le texte le plus récent ». Le défaut était visible
 * — un test de `contactPurposeAddressMode` échouait une fois sur deux — et il
 * a été lu comme un aléa de test alors qu'il décrivait le code.
 *
 * Le cran ajouté n'est pas une horloge de plus, c'est un FAIT : un brouillon
 * écrit sous une consigne que le dépôt produit encore passe devant un
 * brouillon écrit sous une consigne abandonnée. Il n'y a que deux consignes
 * courantes — une par canal —, donc la question se pose sans connaître le canal
 * de l'analyse.
 *
 * L'ordre complet, du plus fort au plus faible : ce qu'un humain a relu, puis
 * ce qui a été écrit sous la consigne d'aujourd'hui, puis le plus récent, puis
 * l'`id`. Le dernier cran ne départage plus que deux brouillons machine, de
 * même vintage et de même horodatage — un cas où aucune règle ne pourrait
 * choisir.
 *
 * Le rail AUTONOME ne lit PAS cette fonction : il lit
 * `loadDraftForAnalysisVersion`, parce que « le texte qui fait foi pour un
 * humain » et « le texte qu'on enverrait seul » ne sont pas la même question.
 */
export async function loadDraftForAnalysis(sql: Sql, analysisId: string): Promise<StoredDraft | null> {
  const rows = await sql.query<DraftRow>(
    `select ${DRAFT_COLUMNS} from r6b_reply_drafts
      where analysis_id = $1
      order by case when status in ('APPROVED', 'EDITED') then 0 else 1 end,
               case when prompt_version = any($2::text[]) then 0 else 1 end,
               created_at desc,
               id desc
      limit 1`,
    [analysisId, [...CURRENT_DRAFT_PROMPT_VERSIONS]],
  );
  const row = rows[0];
  return row ? toDraft(row) : null;
}

/**
 * Le brouillon écrit sous UNE version de prompt précise, s'il existe.
 *
 * Sert à répondre à « faut-il rédiger ? » sans confondre deux questions : « un
 * texte existe-t-il ? » et « un texte existe-t-il sous la consigne
 * d'aujourd'hui ? ». Le traitement pose la seconde — sans quoi corriger le
 * rédacteur ne changerait jamais rien sur un tour déjà traité.
 */
export async function loadDraftForAnalysisVersion(
  sql: Sql,
  analysisId: string,
  promptVersion: string,
): Promise<StoredDraft | null> {
  const rows = await sql.query<DraftRow>(
    `select ${DRAFT_COLUMNS} from r6b_reply_drafts
      where analysis_id = $1 and prompt_version = $2`,
    [analysisId, promptVersion],
  );
  const row = rows[0];
  return row ? toDraft(row) : null;
}

export interface PersistDraftResult {
  readonly draft: StoredDraft;
  /** Faux quand un brouillon existait déjà pour cette analyse. */
  readonly created: boolean;
}

/**
 * Écrit le brouillon, une seule fois par analyse.
 *
 * Un brouillon déjà présent n'est JAMAIS réécrit : il a pu être approuvé,
 * réécrit ou rejeté par un humain entre-temps, et écraser son texte effacerait
 * ce travail. L'unicité est portée par `r6b_reply_drafts_analysis_prompt_idx`,
 * donc par la base.
 *
 * HERMES-CONTACT-PURPOSE-R1 — « une seule fois par analyse » est devenu « une
 * seule fois par analyse ET PAR PROMPT » (migration 0056). Le même rédacteur ne
 * peut toujours pas produire deux textes pour le même tour ; un rédacteur
 * corrigé — donc une version de prompt neuve, donc un diff relu — peut en
 * écrire un À CÔTÉ, sans toucher à l'ancien.
 */
export async function persistDraft(
  sql: Sql,
  context: ReplyContext,
  analysis: StoredAnalysis,
  result: DraftResult,
): Promise<PersistDraftResult> {
  const inserted = await sql.query<DraftRow>(
    `insert into r6b_reply_drafts
       (inbound_message_id, analysis_id, prospect_id, manifest_id, body, body_sha256,
        guardrail_flags, blocked, model, effort, prompt_version, model_run_id, status)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,'PROPOSED')
     on conflict (analysis_id, prompt_version) do nothing
     returning ${DRAFT_COLUMNS}`,
    [
      context.reply.id,
      analysis.id,
      context.prospect.id,
      context.firstTouch.manifestId,
      result.body,
      result.bodySha256,
      JSON.stringify(result.guardrailFlags),
      result.blocked,
      result.model,
      result.effort,
      result.promptVersion,
      result.modelRunId,
    ],
  );

  const row = inserted[0];
  if (row) return Object.freeze({ draft: toDraft(row), created: true });

  const existing = await loadDraftForAnalysisVersion(sql, analysis.id, result.promptVersion);
  if (!existing) {
    throw new Error(
      `brouillon pour l'analyse ${analysis.id} sous ${result.promptVersion} ni inséré ni retrouvé`,
    );
  }
  return Object.freeze({ draft: existing, created: false });
}

export type HumanDecision = 'APPROVE' | 'EDIT' | 'REJECT';

export interface ReviewDraftInput {
  readonly draftId: string;
  readonly decision: HumanDecision;
  readonly reviewedBy: string;
  readonly text?: string;
  readonly note?: string;
}

/**
 * Enregistre la décision d'un humain sur un brouillon.
 *
 * `APPROVE` ne déclenche RIEN. Il n'existe dans ce dépôt aucune fonction qui
 * lise un brouillon approuvé pour l'envoyer : l'email reste à envoyer à la
 * main. Le statut existe pour qu'une future mission puisse s'y accrocher
 * derrière des gardes explicites, pas pour qu'elle s'y accroche discrètement.
 */
export async function reviewDraft(sql: Sql, input: ReviewDraftInput): Promise<StoredDraft> {
  const status: DraftStatus =
    input.decision === 'APPROVE' ? 'APPROVED' : input.decision === 'EDIT' ? 'EDITED' : 'REJECTED';

  if (status === 'EDITED' && (input.text === undefined || input.text.trim().length === 0)) {
    throw new Error('EDIT exige un texte de remplacement');
  }

  const rows = await sql.query<DraftRow>(
    `update r6b_reply_drafts
        set status = $2,
            human_text = case when $2 = 'EDITED' then $3 else human_text end,
            reviewed_by = $4,
            reviewed_at = now(),
            review_note = $5,
            updated_at = now()
      where id = $1
      returning ${DRAFT_COLUMNS}`,
    [input.draftId, status, input.text ?? null, input.reviewedBy, input.note ?? null],
  );

  const row = rows[0];
  if (!row) throw new Error(`brouillon ${input.draftId} introuvable`);
  return toDraft(row);
}
