import { checkMessage, personalizationLevel, type GuardrailFlag } from '@/lib/pipeline/guardrails';
import {
  FIRST_TOUCH_MAX_CHARS,
  FIRST_TOUCH_TARGET_WORDS,
  checkFirstTouch,
  renderFirstTouchCorrections,
  type FirstTouchReport,
} from '@/lib/pipeline/firstTouchStyle';
import {
  renderPersonalizationBlock,
  type FirstTouchPersonalization,
} from '@/lib/pipeline/firstTouchPersonalization';
import type { ModelRouter } from '@/lib/models/router';
import type { ProspectRow } from '@/lib/repo/types';
import type { ResearchResult } from '@/lib/pipeline/research';
import type { AngleResult, CaseStudy } from '@/lib/pipeline/angle';
import type { CampaignConfig } from '@/lib/config/schema';
import { requireOperatorProfile, type OperatorProfile } from '@/lib/config/operatorProfile';

export interface GeneratedMessage {
  variant: 'A' | 'B';
  body: string;
  rationale: string;
  usedFacts: string[];
  personalizationLevel: 'none' | 'low' | 'medium' | 'high';
  guardrailFlags: GuardrailFlag[];
  blocked: boolean;
  /**
   * HERMES-TARGETING-R1 §14-§20 — la relecture de FORME, publiée à côté des
   * garde-fous et jamais fondue dedans.
   *
   * Les deux répondent à des questions différentes : `guardrailFlags` dit « ce
   * message affirme-t-il quelque chose de faux ou de dangereux », celui-ci dit
   * « ressemble-t-il à ce qu'une personne enverrait ». Un lecteur qui les
   * verrait mélangés apprendrait à ignorer « bloquant », parce que « bloquant »
   * voudrait souvent dire « trop long » — c'est la mise en garde de
   * `conversation/naturalness.ts`, et elle vaut ici.
   *
   * Un constat BLOQUANT produit tout de même un drapeau `first_touch_style`
   * dans `guardrailFlags`, parce que c'est ce drapeau que la file et la
   * politique autonome savent lire. Le code le nomme, donc rien n'est confondu.
   */
  firstTouch: FirstTouchReport;
}

export interface MessageResult {
  messages: GeneratedMessage[];
  chosenVariant: 'A' | 'B';
  chosenReason: string;
  modelRunId: string | null;
}

/**
 * Structured-output schemas are validated in strict mode by the provider:
 * every property must appear in `required`, and anything optional is expressed
 * as a nullable type. `tests/schemas.test.ts` enforces this repo-wide.
 */
export const MESSAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['variant_a', 'variant_b', 'chosen_variant', 'choice_reason'],
  properties: {
    variant_a: {
      type: 'object',
      additionalProperties: false,
      required: ['body', 'rationale', 'used_evidence_ids'],
      properties: {
        body: { type: 'string', maxLength: 1200 },
        rationale: { type: 'string', maxLength: 300 },
        used_evidence_ids: { type: 'array', maxItems: 4, items: { type: 'string' } },
      },
    },
    variant_b: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['body', 'rationale', 'used_evidence_ids'],
      properties: {
        body: { type: 'string', maxLength: 1200 },
        rationale: { type: 'string', maxLength: 300 },
        used_evidence_ids: { type: 'array', maxItems: 4, items: { type: 'string' } },
      },
    },
    chosen_variant: { type: 'string', enum: ['A', 'B'] },
    choice_reason: { type: 'string', maxLength: 300 },
  },
} as const;

/**
 * R6A — clôture. Le prompt n'impose plus de structure de
 * rédaction ; il montre la voix validée par un opérateur (gold set, GOOD 5/5) et
 * laisse le modèle l'imiter sur le fait vérifié du prospect. Les
 * contraintes structurelles de R6A.2c/3/4 (bridge obligatoire, gabarit
 * 2-3 phrases, une seule structure de question, diversité lexicale forcée)
 * sont retirées de la rédaction — elles restent mesurables en debug
 * (`src/lib/bench/r6a4Lot.ts`) mais ne dictent plus la prose.
 *
 * HERMES-TARGETING-R1 §14-§20 ajoute UNE contrainte, et une seule : la
 * LONGUEUR, avec ce qu'elle implique — une question, pas deux, et aucune
 * recommandation. Ce n'est pas un retour aux gabarits de R6A.2c : rien n'est
 * imposé de la STRUCTURE de la phrase, seulement de son ampleur. La raison est
 * dans les faits — la production sortait des messages de 384 et 397 caractères
 * qui proposaient de « distinguer les demandes liées à chaque prestation » ou
 * de « tester une page dédiée », c'est-à-dire un audit non demandé là où une
 * question suffisait.
 *
 * Le prompt le dit ; `firstTouchStyle.ts` le vérifie. Les deux, parce que le
 * prompt disait DÉJÀ « pas d'audit, pas de vocabulaire d'acquisition » quand
 * ces messages sont partis.
 */

/**
 * Le ton à tenir, avec ou sans exemples.
 *
 * Cette édition n'embarque AUCUN exemple : un message d'exemple porte le
 * marché, le registre et les tournures de celui qui l'a écrit, et il ne se
 * transporte pas d'une instance à une autre. Sans exemple, on décrit la voix
 * plutôt que de la montrer — c'est moins efficace, c'est honnête, et un
 * opérateur qui veut mieux fournit les siens dans `config/operator.json`.
 */
function renderVoiceGuidance(examples: readonly { body: string; note: string }[]): string {
  const base = [
    "- écris comme une vraie personne qui envoie un message rapidement : simple, direct sans être brutal, un peu conversationnel ;",
    "- pas de formule d'agence, pas de structure en paragraphes, pas de signature.",
  ].join('\n');
  if (examples.length === 0) return base;
  const rendered = examples
    .map((example, index) => `Exemple ${String(index + 1)} :\n${example.body}${example.note.length > 0 ? `\n(${example.note})` : ''}`)
    .join('\n\n');
  return `${base}\n\nReprends le TON des exemples ci-dessous — jamais leurs phrases, et jamais leur longueur :\n\n${rendered}`;
}

function buildSystem(
  campaign: CampaignConfig,
  operator: OperatorProfile,
  caseStudy: CaseStudy | null,
  allowCaseStudy: boolean,
): string {
  const channelLabel =
    campaign.outreach.channel === 'instagram_dm'
      ? 'message privé Instagram'
      : campaign.outreach.channel === 'email'
        ? 'email'
        : campaign.outreach.channel;

  const maxChars = Math.min(campaign.outreach.maxChars, FIRST_TOUCH_MAX_CHARS);

  // L'identité est LUE, jamais câblée. Sans elle, on ne sait pas au nom de qui
  // on écrit ni à qui — et un premier message écrit sans le savoir serait une
  // invention. `requireOperatorProfile` lève plutôt que de deviner.
  const identity = requireOperatorProfile(operator, 'Générer un premier message');

  return `Tu écris le PREMIER message de prospection de : ${identity.senderDescription}
Tu écris à : ${identity.audienceDescription}
Canal : ${channelLabel}. Langue : français.

CE QUE TU ÉCRIS EXACTEMENT
Un premier message n'est PAS un mini-audit : c'est une ouverture de conversation. Son seul objectif est qu'on ait envie de répondre.
- une à deux phrases, ${FIRST_TOUCH_TARGET_WORDS.min} à ${FIRST_TOUCH_TARGET_WORDS.max} mots, ${maxChars} caractères au maximum ;
- UNE seule question, jamais deux ;
- au plus une observation courte, et seulement si un fait vérifié la porte ;
- si rien n'a été observé, une question simple et honnête suffit — c'est mieux qu'une observation floue.

LE TON À TENIR
${renderVoiceGuidance(identity.voiceExamples)}
- un seul détail concret en ouverture, s'il y en a un — pas un audit, pas une liste ;
- une question posée simplement ;
- aucune liste à puces, aucun bloc de texte, aucun jargon d'agence ("synergie", "scaler", "disruptif", "levier d'acquisition").

Vouvoie ou tutoie, mais pas les deux dans le même message. Aucune abréviation de SMS, aucun argot forcé, au plus un emoji.

À NE PAS FAIRE dans ce premier message — chacune de ces lignes a réellement été produite et refusée :
- recommander quoi que ce soit ("une piste serait de…", "vous pourriez tester…", "il faudrait…") ;
- proposer une page dédiée, une landing page ou une refonte ;
- parler d'attribution, de tunnel, de funnel, de parcours de contact, de taux de conversion, de leads ou de KPI ;
- proposer un appel, un créneau, une visio ou un rendez-vous ;
- présenter l'agence, sa méthode ou ce qu'elle met en place ;
- annoncer un travail gratuit, un paiement aux résultats, une absence d'engagement ou de risque ;
- poser deux questions.

Interdictions absolues :
- inventer un fait, un chiffre, un résultat, une métrique ou un concurrent ;
- affirmer une absence non vérifiée (publicité, site, réservation, budget) ;
- promettre un résultat, garantir quoi que ce soit, créer une fausse urgence ;
- utiliser un superlatif invérifiable ;
- laisser une variable de gabarit non remplie ;
- prétendre avoir observé quelque chose sur Google ou Instagram si ce n'est pas dans les faits vérifiés fournis ;
- parler d'audit de site, de tunnel de conversion ou de vocabulaire d'acquisition envers le prospect.
${
  allowCaseStudy && caseStudy
    ? `\nPreuve sociale autorisée, à citer mot pour mot si tu l'utilises : "${caseStudy.claim}"\nAucune autre métrique n'existe. Son usage est optionnel.`
    : `\nAucune preuve chiffrée n'est autorisée dans ce message.`
}

Réponds uniquement en JSON conforme au schéma.`;
}

export interface RawMessageAnswer {
  variant_a: { body: string; rationale: string; used_evidence_ids: string[] };
  variant_b?: { body: string; rationale: string; used_evidence_ids: string[] } | null;
  chosen_variant: 'A' | 'B';
  choice_reason: string;
}

/** The message request as a value — see `buildResearchRequest` for the reason. */
export function buildMessageRequest(
  campaign: CampaignConfig,
  operator: OperatorProfile,
  prospect: ProspectRow,
  research: ResearchResult,
  angle: AngleResult,
  caseStudy: CaseStudy | null,
  /**
   * HERMES-END-TO-END-CERTIFICATION-R1 — la personnalisation LUE DES PREUVES.
   *
   * Optionnelle, et absente reproduit le prompt d'avant ce round au caractère
   * près : sans elle, le bloc n'est pas rendu vide, il n'est pas rendu du tout.
   * C'est ce qui rend la comparaison vérifiable par chaîne plutôt que sur
   * parole.
   *
   * Elle existe parce que la personnalisation ne dépendait que de
   * `prospect_angles`, une ligne produite par une étape LLM qui manque à 315
   * des 466 prospects portant des preuves. Pour eux, le premier message était
   * condamné au gabarit par construction — pas par manque d'observation, mais
   * parce que rien ne lisait les observations.
   */
  personalization?: FirstTouchPersonalization | null,
): { system: string; prompt: string; schema: Record<string, unknown> } {
  const facts = research.observations.map(
    (observation) => `[${observation.evidenceIds.join(', ')}] ${observation.text}`,
  );

  // Le first-touch ignore volontairement le détail commercial de l'angle
  // (§9 — problème probable / opportunité / approche) : l'injecter surchargeait
  // le message d'un raisonnement d'agence que le gold set ne montre jamais.
  // Seul le hook de personnalisation déjà grounded (evidence vérifiée) passe.
  // Le bloc de personnalisation REMPLACE les deux lignes historiques quand il
  // existe : il répond aux mêmes deux questions — que sait-on d'eux, et que
  // peut-on reprendre — depuis une source qui, elle, est renseignée.
  const personalizationBlock =
    personalization === undefined || personalization === null
      ? `FAITS VÉRIFIÉS UTILISABLES (aucun autre)
${facts.join('\n') || '- aucun fait vérifié : reste générique et honnête, ne prétends pas avoir regardé leur travail'}

DÉTAIL DE PERSONNALISATION À UTILISER (maximum un, comme dans les exemples)
${angle.personalization || 'aucun élément vérifié — reste générique et honnête, ne prétends pas avoir regardé leur travail'}`
      : renderPersonalizationBlock(personalization);

  const prompt = `ENTREPRISE : ${prospect.display_name}${prospect.city ? ` (${prospect.city})` : ''}
${prospect.instagram_handle ? `Instagram : @${prospect.instagram_handle}` : ''}

${personalizationBlock}

PREUVE SOCIALE
${angle.useCaseStudy ? 'utile ici — voir la citation autorisée ci-dessus' : 'non utile ici — ne pas en inventer une'}

INCONNUES (ne rien affirmer)
${research.unknowns.map((item) => `- ${item}`).join('\n') || '- aucune'}

Écris le message A${campaign.outreach.generateVariantB ? ', puis une variante B avec un point de départ différent' : ''}, puis indique laquelle tu retiens et pourquoi.`;

  return {
    system: buildSystem(campaign, operator, caseStudy, angle.useCaseStudy),
    prompt,
    schema: MESSAGE_SCHEMA as unknown as Record<string, unknown>,
  };
}

export function parseMessageAnswer(value: unknown): RawMessageAnswer {
  const parsed = value as Record<string, unknown>;
  const a = parsed['variant_a'] as { body?: unknown } | undefined;
  if (!a || typeof a.body !== 'string') throw new Error('variant_a.body missing');
  return parsed as unknown as RawMessageAnswer;
}

/**
 * Runs the guardrails over a raw message answer and picks the recommended
 * variant. Kept out of the router call so the benchmark judges every model
 * through exactly the same guardrails production applies.
 */
export function checkGeneratedMessages(
  data: RawMessageAnswer,
  campaign: CampaignConfig,
  research: ResearchResult,
  angle: AngleResult,
  caseStudy: CaseStudy | null,
  modelRunId: string | null,
): MessageResult {
  const allowedIds = new Set(research.observations.flatMap((observation) => observation.evidenceIds));
  const groundedTexts = research.observations.map((observation) => observation.text);
  const allowedNumbers = caseStudy && angle.useCaseStudy ? extractApprovedNumbers(caseStudy.claim) : [];

  const build = (
    variant: 'A' | 'B',
    raw: { body: string; rationale: string; used_evidence_ids: string[] },
  ): GeneratedMessage => {
    const body = raw.body.trim();
    const flags = checkMessage({
      body,
      maxChars: campaign.outreach.maxChars,
      allowedCaseStudyClaim: angle.useCaseStudy && caseStudy ? caseStudy.claim : null,
      allowedNumbers,
      groundedFacts: groundedTexts,
    });
    const usedFacts = (raw.used_evidence_ids ?? []).filter((id) => allowedIds.has(id));
    const firstTouch = checkFirstTouch({ body, groundedFacts: groundedTexts });
    // Le report est produit d'abord, le drapeau en découle. L'inverse — écrire
    // un drapeau puis reconstituer le report — ferait exister deux versions du
    // même constat, dont une seule serait à jour.
    const combined = [...flags];
    if (firstTouch.verdict === 'OFF_TONE') {
      const blockingCodes = firstTouch.findings
        .filter((finding) => finding.severity === 'BLOCKING')
        .map((finding) => finding.code);
      combined.push({
        code: 'first_touch_style',
        message: `premier message hors ton : ${blockingCodes.join(', ')}`,
        blocking: true,
      });
    }
    return {
      variant,
      body,
      rationale: raw.rationale?.trim() ?? '',
      usedFacts,
      personalizationLevel: personalizationLevel(body, groundedTexts),
      guardrailFlags: combined,
      blocked: combined.some((flag) => flag.blocking),
      firstTouch,
    };
  };

  const messages: GeneratedMessage[] = [build('A', data.variant_a)];
  if (data.variant_b && typeof data.variant_b.body === 'string') {
    messages.push(build('B', data.variant_b));
  }

  // A blocked variant never becomes the recommended one.
  let chosen = data.chosen_variant === 'B' && messages.length > 1 ? 'B' : 'A';
  const chosenMessage = messages.find((message) => message.variant === chosen);
  let chosenReason = data.choice_reason ?? '';
  if (chosenMessage?.blocked) {
    const alternative = messages.find((message) => !message.blocked);
    if (alternative) {
      chosen = alternative.variant;
      chosenReason = `variante initiale bloquée par les garde-fous — repli sur ${alternative.variant}`;
    }
  }

  return {
    messages,
    chosenVariant: chosen as 'A' | 'B',
    chosenReason,
    modelRunId,
  };
}

export async function generateMessages(
  router: ModelRouter,
  campaign: CampaignConfig,
  operator: OperatorProfile,
  prospect: ProspectRow,
  research: ResearchResult,
  angle: AngleResult,
  caseStudy: CaseStudy | null,
): Promise<MessageResult | null> {
  const request = buildMessageRequest(campaign, operator, prospect, research, angle, caseStudy);

  const outcome = await router.run<RawMessageAnswer>(
    {
      task: 'message',
      system: request.system,
      prompt: request.prompt,
      schema: request.schema,
      inputRef: `prospect:${prospect.id}`,
    },
    parseMessageAnswer,
  );

  if (!outcome.ok || !outcome.data) return null;
  const first = checkGeneratedMessages(outcome.data, campaign, research, angle, caseStudy, outcome.modelRunId);

  const chosen = first.messages.find((message) => message.variant === first.chosenVariant);
  if (chosen === undefined || chosen.firstTouch.verdict !== 'OFF_TONE') return first;

  /**
   * HERMES-TARGETING-R1 §16 — UNE reprise, jamais deux.
   *
   * Un modèle à qui l'on montre ce qui n'allait pas corrige presque toujours du
   * premier coup ; en boucler davantage coûterait des appels pour gagner des
   * cas de plus en plus rares, et ferait dépendre le coût d'un lot de la
   * qualité du premier jet. Si la reprise échoue à son tour, le message n'est
   * pas jeté : il est rendu tel quel, marqué `blocked`, et c'est le drapeau qui
   * l'écarte de la file — un texte refusé reste lisible, et c'est ainsi qu'on
   * corrige un prompt plutôt que de deviner.
   *
   * `checkGeneratedMessages` est réappliqué sur la reprise : c'est le même
   * contrôle, sur le même chemin, pour que rien ne puisse sortir d'ici sans
   * avoir été relu.
   */
  const repaired = await router.run<RawMessageAnswer>(
    {
      task: 'message',
      system: request.system,
      prompt: `${request.prompt}\n\n${renderFirstTouchCorrections(chosen.firstTouch)}\n\nVOICI CE QUE TU AVAIS ÉCRIT\n"${chosen.body}"`,
      schema: request.schema,
      inputRef: `prospect:${prospect.id}:first-touch-repair`,
    },
    parseMessageAnswer,
  );

  if (!repaired.ok || !repaired.data) return first;
  const second = checkGeneratedMessages(repaired.data, campaign, research, angle, caseStudy, repaired.modelRunId);
  const secondChosen = second.messages.find((message) => message.variant === second.chosenVariant);
  // La reprise ne remplace le premier jet que si elle est MEILLEURE. Une
  // seconde version encore hors ton ne vaut pas mieux que la première, et
  // l'échanger ferait perdre la trace de ce que le modèle produit spontanément.
  return secondChosen !== undefined && secondChosen.firstTouch.verdict !== 'OFF_TONE' ? second : first;
}

/** Numbers that the approved claim itself contains, and therefore may appear. */
export function extractApprovedNumbers(claim: string): number[] {
  const numbers: number[] = [];
  for (const match of claim.matchAll(/(\d[\d\s  .,]{0,12})\s*(?:€|eur\b|euros\b)/gi)) {
    const raw = (match[1] ?? '').replace(/[^\d]/g, '');
    if (!raw) continue;
    const value = Number.parseInt(raw, 10);
    if (Number.isFinite(value)) numbers.push(value);
  }
  return numbers;
}
