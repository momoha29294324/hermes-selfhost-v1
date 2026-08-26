/**
 * HERMES-SALES-KNOWLEDGE-R1 §19, §20, §31, §36 — l'INJECTION dans le cerveau
 * conversationnel, et tout ce qui l'empêche de devenir une porte.
 *
 * ---------------------------------------------------------------------------
 * §36 — un rail à part, qui ne réveille pas l'autre
 * ---------------------------------------------------------------------------
 * `OUTBOUND_LEARNING_INJECTION_ENABLED` gouverne la boucle d'APPRENTISSAGE —
 * ce que les corrections d'un opérateur ont montré. Il reste à `0`, ce round ne le
 * lit pas, ne l'écrit pas, et ne le mentionne que pour dire qu'il n'y touche
 * pas. Les deux injections répondent à deux questions différentes : « qu'a-t-on
 * observé sur nos propres corrections ? » et « qu'a-t-on appris d'une source
 * extérieure ? ». Les mêler dans un drapeau ferait qu'allumer l'une allumerait
 * l'autre.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi ce rail-ci est allumé par défaut, alors que l'autre ne l'est pas
 * ---------------------------------------------------------------------------
 * La question mérite d'être tranchée à voix haute plutôt que subie.
 *
 * L'injection d'apprentissage est éteinte parce qu'elle apprend d'un effectif
 * minuscule : trois brouillons relus, dont la moitié n'ont jamais été corrigés.
 * L'allumer ferait apprendre au modèle sa propre voix.
 *
 * Celle-ci est différente. Elle n'apprend de rien : elle transmet des principes
 * qu'un humain a lus, classés un par un, et opposés aux règles du dépôt. Ce
 * qu'elle peut faire de pire est de donner un conseil de rédaction médiocre à
 * un brouillon qui sera ensuite mesuré par EXACTEMENT les mêmes contrôles
 * qu'avant — naturalité, garde-fous, politique commerciale, autonomie. Aucun de
 * ces contrôles ne la lit, et aucune de ses sorties ne peut les atteindre.
 *
 * S'ajoute un fait de contexte qui rend le risque nul aujourd'hui : le rail de
 * réponse n'a jamais été exercé en direct, aucune conversation n'est
 * `AUTO_REPLY_ELIGIBLE`, et l'arrêt global reste armé. Un brouillon influencé
 * par cette bibliothèque va dans une revue, pas dans un fil.
 *
 * `OUTBOUND_SALES_KNOWLEDGE_ENABLED=0` l'éteint, et l'éteindre rend le prompt
 * d'avant au caractère près — pas « équivalent », identique : le bloc n'est pas
 * rendu vide, il n'est pas rendu du tout.
 *
 * ---------------------------------------------------------------------------
 * §31 — la naturalité n'est jamais contournée
 * ---------------------------------------------------------------------------
 * Rien ici ne peut lever un contrôle. Les directives sont des phrases de
 * conseil, elles entrent dans le prompt comme les autres blocs, et le brouillon
 * qui en sort passe la même relecture. Un test le vérifie autrement que sur
 * parole : il exerce le contrôle de naturalité sur des textes que ces
 * directives encourageraient, et exige qu'il bloque toujours.
 */

import { envBool } from '@/lib/env';
import {
  MAX_INJECTED_PRINCIPLES,
  retrieveSalesPrinciples,
  type RetrievalContext,
} from '@/lib/sales/retrieval';
import { loadSalesKnowledge, type SalesLibrary } from '@/lib/sales/library';
import { EXPERT_PRINCIPLE_TIER, principleSupport } from '@/lib/sales/truth';
import type { PrincipleStage, SalesPrinciple } from '@/lib/sales/schema';

export const SALES_KNOWLEDGE_ENV = 'OUTBOUND_SALES_KNOWLEDGE_ENABLED';

/**
 * Le rail est-il allumé ?
 *
 * Défaut `true`, contrairement à l'injection d'apprentissage — la raison est
 * écrite en tête de fichier. Une variable absente laisse donc le rail actif ;
 * seule une valeur explicitement fausse l'éteint.
 */
export function salesKnowledgeEnabled(override?: boolean): boolean {
  return override ?? envBool(SALES_KNOWLEDGE_ENV, true);
}

/**
 * La provenance d'un principe injecté.
 *
 * §12 : « d'où vient cette règle ? » doit avoir une réponse. Elle ne va PAS
 * dans le prompt — un modèle ne fait rien d'utile de « 38:14-38:32 » — mais
 * elle voyage dans l'objet, donc dans les rapports et dans l'ombre. C'est le
 * même partage que les exemplars de la boucle d'apprentissage : la référence
 * circule, le contenu reste à sa place.
 */
export interface InjectedPrincipleRef {
  readonly id: string;
  readonly stage: PrincipleStage;
  readonly topic: string;
  readonly timestampStart: string;
  readonly timestampEnd: string;
  readonly classification: string;
  readonly confidence: string;
  /** `SUPPORTED_BY_EXPERT` — jamais `PROVEN_FOR_HERMES` (§17). */
  readonly support: string;
  /** Le rang dans la hiérarchie de vérité. Cinquième sur six. */
  readonly tier: string;
}

export interface SalesKnowledgeInjection {
  readonly version: string;
  /** Les phrases que le prompt lira. Au plus `MAX_INJECTED_PRINCIPLES`. */
  readonly directives: readonly string[];
  /** La provenance, pour les rapports. Jamais rendue au modèle. */
  readonly refs: readonly InjectedPrincipleRef[];
  readonly stage: PrincipleStage;
}

export interface SalesKnowledgeInput {
  readonly context: RetrievalContext;
  /** Force l'état du drapeau, pour les tests. */
  readonly enabled?: boolean;
  /** Force la bibliothèque, pour les tests. Sinon, celle du disque. */
  readonly library?: SalesLibrary;
  readonly max?: number;
}

function refOf(principle: SalesPrinciple): InjectedPrincipleRef {
  return Object.freeze({
    id: principle.id,
    stage: principle.stage,
    topic: principle.topic,
    timestampStart: principle.timestampStart,
    timestampEnd: principle.timestampEnd,
    classification: principle.classification,
    confidence: principle.confidence,
    support: principleSupport(),
    tier: EXPERT_PRINCIPLE_TIER,
  });
}

/**
 * Construit l'injection, ou rend `null`.
 *
 * `null` est le cas fail-closed de §20, et il couvre les quatre situations que
 * la mission nomme, sans qu'aucune ne demande de branche particulière :
 *
 *   * bibliothèque absente ⇒ `injectable` vide ⇒ rien à récupérer ⇒ `null` ;
 *   * bibliothèque qui ne rend rien pour ce tour ⇒ `null` ;
 *   * bibliothèque ne contenant que des principes écartés ⇒ `injectable` vide,
 *     parce que le schéma refuse une directive à un principe écarté ⇒ `null` ;
 *   * conflit ⇒ le principe porte sa résolution `POLICY_WINS`, et la politique
 *     s'applique de toute façon en aval — l'injection n'a aucun moyen de la
 *     contredire.
 *
 * Le cerveau n'ajoute alors aucune ligne à son prompt.
 */
export function buildSalesKnowledgeInjection(
  input: SalesKnowledgeInput,
): SalesKnowledgeInjection | null {
  if (!salesKnowledgeEnabled(input.enabled)) return null;

  const library = input.library ?? loadSalesKnowledge();
  const principles = retrieveSalesPrinciples(
    library,
    input.context,
    input.max ?? MAX_INJECTED_PRINCIPLES,
  );
  if (principles.length === 0) return null;

  const directives: string[] = [];
  const refs: InjectedPrincipleRef[] = [];
  for (const principle of principles) {
    // `injectablePrinciple` a déjà garanti que la directive existe ; la garde
    // reste pour que ce fichier n'ait pas à faire confiance à un invariant
    // établi ailleurs.
    if (principle.promptDirective === null) continue;
    directives.push(principle.promptDirective);
    refs.push(refOf(principle));
  }
  if (directives.length === 0) return null;

  const stage = principles[0]?.stage;
  if (stage === undefined) return null;

  return Object.freeze({
    version: library.version,
    directives: Object.freeze(directives),
    refs: Object.freeze(refs),
    stage,
  });
}

/**
 * Rend le bloc que le prompt lira.
 *
 * Le titre dit ce que ces lignes SONT — des repères, pas des règles — et la
 * dernière ligne dit ce qu'elles ne sont pas. Les deux comptent : un modèle qui
 * lit une liste sans en-tête la traite comme une consigne d'autorité égale au
 * reste du prompt, or ces phrases-là viennent d'une source extérieure et
 * perdent contre tout ce qui les entoure.
 */
export function renderSalesKnowledgeBlock(injection: SalesKnowledgeInjection): string {
  const lines: string[] = ['REPÈRES DE CONVERSATION COMMERCIALE (des repères, pas des règles)'];
  for (const directive of injection.directives) lines.push(`- ${directive}`);
  lines.push(
    'Ces repères ne lèvent aucune interdiction : en cas de doute, ce qui est écrit plus haut gagne.',
  );
  return lines.join('\n');
}
