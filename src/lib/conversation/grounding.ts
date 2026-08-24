/**
 * CONVERSATION-R1 — ce que Hermes a le DROIT d'affirmer, et ce qui lui manque.
 *
 * Le fichier existe parce qu'une conversation multi-tour multiplie les
 * occasions d'inventer. Au premier message, le modèle n'a qu'un angle à
 * défendre ; au troisième tour, on lui demande un prix, une garantie, une
 * référence client — trois choses que ce dépôt ne possède pas. Sans une liste
 * explicite de MANQUES, un modèle comble : c'est ce qu'il fait de mieux.
 *
 * On rend donc deux choses, symétriques :
 *
 *   - `facts` : ce qui est observé, avec sa source. Rien d'autre n'entre.
 *   - `gaps`  : ce qui est demandé mais indisponible, nommé. Le prompt reprend
 *               chaque manque comme une interdiction, et la réponse attendue
 *               devient « je ne peux pas répondre ça ici », pas un chiffre.
 *
 * Une décision héritée mérite d'être écrite noir sur blanc : **aucune preuve
 * chiffrée n'est citable dans une réponse.** Ce n'est pas une règle ajoutée
 * ici, c'est celle de `checkReplyDraft` (R6B-D2), qui passe
 * `allowedCaseStudyClaim: null`. La phrase des « ≈ 3 500 € » reste canonique
 * dans `case_studies` et autorisée au PREMIER contact ; la réintroduire en
 * réponse serait une affirmation commerciale que personne n'a validée pour ce
 * contexte. R1 ne desserre pas une garde de sécurité existante — il s'y range.
 */

import { resolvePriceSubject } from '@/lib/sales/priceSubject';
import type { ConversationSignals } from '@/lib/conversation/signals';
import type { ReplyContext } from '@/lib/replies/context';

export type GroundingGap =
  /** Aucune politique tarifaire canonique n'existe dans le dépôt. */
  | 'PRICING_POLICY_MISSING'
  /** Une preuve chiffrée existe mais n'est pas citable dans une réponse. */
  | 'PROOF_NOT_QUOTABLE_IN_REPLY'
  /** Aucune garantie de résultat n'est offerte, et aucune ne peut l'être. */
  | 'NO_GUARANTEE_TO_OFFER'
  /** Aucune recherche n'a été observée sur ce prospect. */
  | 'NO_RESEARCH_OBSERVED'
  /** La question porte sur un sujet qu'aucune donnée fiable ne couvre. */
  | 'TOPIC_NOT_COVERED_BY_DATA';

export interface GroundedFact {
  readonly kind: 'prospect' | 'research' | 'angle' | 'thread';
  readonly text: string;
  /** D'où vient ce fait. Un fait sans source n'entre pas. */
  readonly source: string;
}

export interface Grounding {
  readonly facts: readonly GroundedFact[];
  readonly gaps: readonly GroundingGap[];
  /**
   * La phrase de preuve citable dans CETTE réponse.
   *
   * Toujours `null`, et le type le dit pour que personne n'ait à relire le
   * corps de la fonction. Le jour où une politique autoriserait une preuve en
   * réponse, ce sera une décision explicite avec sa propre revue.
   */
  readonly quotableProofClaim: null;
}

/**
 * Rassemble les faits observés et nomme les manques que CE message ouvre.
 *
 * Les manques dépendent des sous-signaux : demander « c'est combien ? » ouvre
 * `PRICING_POLICY_MISSING`, demander « vous garantissez ? » ouvre
 * `NO_GUARANTEE_TO_OFFER`. Un manque qui ne correspond à aucune demande n'est
 * pas listé — noyer le prompt sous des interdictions sans objet le rend moins
 * lisible, donc moins suivi.
 */
export function buildGrounding(
  context: ReplyContext,
  signals: ConversationSignals,
  /**
   * HERMES-MULTI-TURN-BURSTS-R1 — la prise de parole entière.
   *
   * Le sujet du prix se lit sur ce que la personne vient de DIRE, ce qui peut
   * tenir en plusieurs bulles : « mais toi après les 7 jours » puis « ça coûte
   * combien ? ». Lu sur la dernière bulle seule, le sujet sortait en
   * `UNRESOLVED` — le refus restait le bon, son motif était faux.
   *
   * Absent, on retombe sur le corps du message : aucun appelant existant ne
   * change de comportement, et le défaut reste celui d'avant.
   */
  utteranceText?: string,
): Grounding {
  const facts: GroundedFact[] = [];

  facts.push({
    kind: 'prospect',
    text: `Nom d'affichage observé : ${context.prospect.displayName}`,
    source: 'prospects.display_name',
  });
  if (context.prospect.city !== null) {
    facts.push({ kind: 'prospect', text: `Ville observée : ${context.prospect.city}`, source: 'prospects.city' });
  }

  if (context.research !== null) {
    for (const observation of context.research.observations) {
      facts.push({ kind: 'research', text: observation, source: 'prospect_research.observations' });
    }
    for (const opportunity of context.research.opportunities) {
      facts.push({ kind: 'research', text: opportunity, source: 'prospect_research.opportunities' });
    }
  }

  if (context.angle !== null) {
    facts.push({ kind: 'angle', text: context.angle.painPoint, source: 'prospect_angles.pain_point' });
    facts.push({ kind: 'angle', text: context.angle.opportunity, source: 'prospect_angles.opportunity' });
  }

  const gaps = new Set<GroundingGap>();

  if (context.research === null) gaps.add('NO_RESEARCH_OBSERVED');

  // HERMES-TRIAL-COST-VS-POST-TRIAL-PRICING-R1 §3 — un manque ne se nomme pas
  // quand une vérité le comble.
  //
  // Ce fichier ouvrait `PRICING_POLICY_MISSING` sur le seul fait que le sujet
  // lu valait `PRICE`. C'était la SECONDE cause du faux refus du 23 août : même
  // une fois la demande commerciale rendue répondable, ce manque-ci escaladait
  // le tour un cran plus loin (`autonomy.ts`, porte 15 bis).
  //
  // La lecture se fait sur le texte du message, jamais sur le sujet seul — un
  // sujet ne retient qu'une étiquette, et c'est exactement ce qui a manqué.
  // Fail-closed : `covered` est faux dès que le sujet est le prix d'APRÈS
  // l'essai, ou dès qu'aucun sujet ne se lit.
  const price = resolvePriceSubject(utteranceText ?? context.reply.bodyText);

  if (signals.questionTopic === 'PRICE' || signals.objectionTopic === 'NO_BUDGET') {
    // L'objection de budget n'est pas raffinée : « je n'ai pas le budget »
    // porte sur ce que NOUS coûtons, qui reste inconnu.
    if (signals.objectionTopic === 'NO_BUDGET' || !price.covered) {
      gaps.add('PRICING_POLICY_MISSING');
    }
  }
  if (signals.questionTopic === 'GUARANTEE') gaps.add('NO_GUARANTEE_TO_OFFER');
  if (signals.questionTopic === 'RESULTS_PROOF') gaps.add('PROOF_NOT_QUOTABLE_IN_REPLY');
  if (signals.questionTopic === 'OTHER_QUESTION') {
    // §3 — la TROISIÈME porte, et elle a été mesurée elle aussi. « Les 7 jours
    // sont gratuits ? » et « Je dois payer quelque chose pendant les 7 jours ? »
    // ne relèvent aucun sujet de `QUESTION_PATTERNS` et tombent donc ici, alors
    // que la vérité de l'essai les couvre entièrement. Un manque qui dit « aucune
    // donnée fiable ne couvre ce sujet » est faux dès qu'une vérité le couvre.
    if (!price.covered) gaps.add('TOPIC_NOT_COVERED_BY_DATA');
  }

  return Object.freeze({
    facts: Object.freeze(facts),
    gaps: Object.freeze([...gaps]),
    quotableProofClaim: null,
  });
}

/**
 * Les manques qui rendent une RÉPONSE FACTUELLE impossible sur ce tour.
 *
 * HERMES-ACQUISITION-SERVICE-TRUTH-R1 — l'exigence « réponds d'abord » ne peut
 * pas s'appliquer à un tour où le dépôt dit lui-même qu'il ne sait pas. Sur une
 * question de prix, « ça dépend de ce qu'il y a à mettre en place » EST la
 * bonne réponse, et c'est même celle que `PRICING_POLICY_MISSING` demande
 * textuellement au modèle d'écrire ; la refuser au motif qu'elle n'affirme rien
 * de chiffré ferait s'annuler deux règles du dépôt.
 *
 * `NO_RESEARCH_OBSERVED` n'est PAS de la liste, et la distinction porte tout :
 * il dit qu'on ne sait rien de l'ENTREPRISE d'en face, pas qu'on ne sait rien
 * de NOUS. Un prospect qui demande ce qu'on fait mérite une réponse même si
 * personne n'a jamais regardé son compte.
 */
const ANSWER_BLOCKING_GAPS: ReadonlySet<GroundingGap> = new Set<GroundingGap>([
  'PRICING_POLICY_MISSING',
  'NO_GUARANTEE_TO_OFFER',
  'PROOF_NOT_QUOTABLE_IN_REPLY',
  'TOPIC_NOT_COVERED_BY_DATA',
]);

/** Un de ces manques est-il ouvert ? Si oui, aucune réponse factuelle n'est due. */
export function answerBlockedByGaps(gaps: readonly GroundingGap[]): boolean {
  return gaps.some((gap) => ANSWER_BLOCKING_GAPS.has(gap));
}

/** Ce que chaque manque interdit, en toutes lettres, pour le prompt. */
const GAP_INSTRUCTION: Readonly<Record<GroundingGap, string>> = Object.freeze({
  PRICING_POLICY_MISSING:
    "AUCUN prix, fourchette, tarif de départ, ordre de grandeur ou « à partir de » n'existe et aucun ne doit être écrit. Reconnais la question, explique honnêtement que le montant dépend du besoin réel et de son périmètre, et propose d'en préciser deux ou trois points avant de chiffrer.",
  PROOF_NOT_QUOTABLE_IN_REPLY:
    "AUCUN résultat chiffré, montant, pourcentage ni nom de client ne peut être cité dans cette réponse. Reconnais la demande et propose d'en parler concrètement, sans avancer de chiffre.",
  NO_GUARANTEE_TO_OFFER:
    "AUCUNE garantie de résultat n'est offerte. Dis-le simplement et sans détour ; ne remplace pas la garantie par une promesse déguisée (« on obtient toujours », « ça marche à tous les coups »).",
  NO_RESEARCH_OBSERVED:
    "Aucune recherche n'a été observée sur cette entreprise. N'affirme rien sur son site, ses publicités, ses tarifs ou son organisation — ni leur présence, ni leur absence.",
  TOPIC_NOT_COVERED_BY_DATA:
    "La question porte sur un sujet qu'aucune donnée fiable ne couvre. Dis honnêtement que tu ne veux pas répondre de travers, et demande une précision ou propose d'en parler.",
});

export function renderGroundingBlock(grounding: Grounding): string {
  const lines: string[] = ['FAITS OBSERVÉS UTILISABLES (rien d’autre n’est vrai)'];
  if (grounding.facts.length === 0) {
    lines.push('- aucun fait observé : ne dis rien de factuel sur cette entreprise.');
  } else {
    for (const fact of grounding.facts) lines.push(`- ${fact.text}  [${fact.source}]`);
  }

  if (grounding.gaps.length > 0) {
    lines.push('', 'CE QUI MANQUE — ET QUI NE S’INVENTE PAS');
    for (const gap of grounding.gaps) lines.push(`- ${gap} : ${GAP_INSTRUCTION[gap]}`);
  }

  return lines.join('\n');
}
