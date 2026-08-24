/**
 * HERMES-END-TO-END-CERTIFICATION-R1 — la CONSIGNE COURANTE, dans un module
 * feuille.
 *
 * Ces constantes vivaient dans `conversation/brain.ts`. C'était le bon endroit
 * tant qu'un seul appelant les lisait ; ce ne l'est plus depuis que trois
 * questions différentes en dépendent :
 *
 *   * `replies/process.ts` — sous quelle consigne ÉCRIRE ce tour ;
 *   * `conversation/assessment.ts` — quel texte le rail autonome a le droit de
 *     juger, donc d'envoyer ;
 *   * `replies/draft.ts` — lequel de plusieurs brouillons fait foi.
 *
 * Le troisième ne pouvait pas les lire : `brain.ts` importe `draft.ts`, donc
 * l'inverse ferait un cycle. Le choix était entre recopier deux chaînes — ce
 * que ce dépôt refuse partout ailleurs, et à raison — et poser une feuille.
 * C'est une feuille : elle n'importe rien, et `brain.ts` la réexporte pour que
 * les appelants existants ne bougent pas d'une ligne.
 */

/**
 * Les versions ont changé en R1.1, et elles DEVAIENT changer : le prompt n'est
 * plus le même. Le dépôt pose qu'un prompt différent ne partage pas un numéro
 * avec un autre, sans quoi `prompt_version` cesse de dire ce qui a réellement
 * été demandé — et une comparaison entre deux rédactions deviendrait un
 * mélange de deux consignes sous une seule étiquette.
 */
/**
 * HERMES-SALES-KNOWLEDGE-R1 — pourquoi ces versions changent encore.
 *
 * Le prompt n'est plus le même : il porte désormais l'OBJECTIF commercial de
 * Hermes (obtenir un rendez-vous qualifié, ne pas conclure), et, selon le tour,
 * l'offre réelle et quelques repères de conversation. La règle du dépôt ne
 * souffre pas d'exception sur ce point — un prompt différent ne partage pas un
 * numéro avec un autre, sans quoi `prompt_version` cesse de dire ce qui a
 * réellement été demandé au modèle.
 *
 * Les deux blocs conditionnels n'entrent que lorsqu'ils ont un objet ; le bloc
 * d'objectif, lui, est TOUJOURS présent, parce que le rôle de Hermes ne dépend
 * pas du tour.
 */
/**
 * HERMES-CONTACT-PURPOSE-R1 — pourquoi ces versions changent une fois de plus.
 *
 * Le prompt n'est plus le même, sur trois points qui se voient tous dans le
 * texte rendu au modèle : il porte le MOTIF DE CONTACT quand on le lui demande
 * (`sales/contactPurpose.ts`), sa consigne de registre nomme désormais les
 * pronoms au lieu de décrire un registre, et sa voix impose la première
 * personne — donc plus aucun tiers nommé, plus aucune promesse de transmettre.
 *
 * La règle du dépôt ne souffre pas d'exception : un prompt différent ne partage
 * pas un numéro avec un autre, sans quoi `prompt_version` cesse de dire ce qui
 * a réellement été demandé — et une comparaison entre deux rédactions
 * deviendrait un mélange de deux consignes sous une seule étiquette.
 */
/**
 * HERMES-ACQUISITION-SERVICE-TRUTH-R1 — pourquoi ces versions changent encore.
 *
 * Le prompt n'est plus le même sur deux points, tous deux visibles dans le
 * texte rendu au modèle : il porte la VÉRITÉ DE SERVICE quand on la demande
 * (`sales/acquisitionService.ts`, facette par facette et jamais en bloc), et il
 * porte le principe RÉPONDS D'ABORD quand une vérité canonique couvre la
 * question.
 *
 * La règle du dépôt ne souffre pas d'exception : un prompt différent ne partage
 * pas un numéro avec un autre, sans quoi `prompt_version` cesse de dire ce qui
 * a réellement été demandé — et une comparaison entre deux rédactions
 * deviendrait un mélange de deux consignes sous une seule étiquette.
 *
 * La migration 0056 fait porter l'unicité d'un brouillon sur (analyse, version
 * de prompt) : le texte écrit sous r4 s'inscrit donc À CÔTÉ de celui de r3,
 * sans écraser un brouillon qu'un humain aurait approuvé ou réécrit.
 */
/**
 * HERMES-TRIAL-COST-VS-POST-TRIAL-PRICING-R1 — pourquoi ces versions changent
 * une fois de plus.
 *
 * Le prompt n'est plus le même sur deux points, tous deux visibles dans le
 * texte rendu au modèle. Il porte la facette du BUDGET PUBLICITAIRE — donc ses
 * montants, et le principe RÉPONDS D'ABORD — sur un tour qui demande ce que
 * coûte le test, là où `questionTopic` valait `PRICE` et n'ouvrait rien. Et sa
 * consigne de montants dans le bloc de l'offre n'est plus « aucun montant, pas
 * même zéro » : elle nomme les seuls montants vrais et redit que le prix de la
 * suite n'en fait pas partie.
 *
 * La règle du dépôt ne souffre pas d'exception : un prompt différent ne partage
 * pas un numéro avec un autre. La migration 0056 fait porter l'unicité d'un
 * brouillon sur (analyse, version de prompt) : le texte écrit sous r5 s'inscrit
 * donc À CÔTÉ de celui de r4, sans écraser un brouillon qu'un humain aurait
 * approuvé ou réécrit.
 */
/**
 * HERMES-TRIAL-IMPLEMENTATION-ROUTING-R1 — pourquoi ces versions changent une
 * fois de plus.
 *
 * Le prompt n'est plus le même sur les tours qui interrogent l'ESSAI. « Pendant
 * les 7 jours tu mets quoi en place ? » ne recevait ni l'offre, ni la vérité de
 * service, ni le principe RÉPONDS D'ABORD : il recevait un manque
 * (`TOPIC_NOT_COVERED_BY_DATA`) qui disait au modèle qu'aucune donnée fiable ne
 * couvrait le sujet, alors que deux vérités le couvrent. Le texte rendu au
 * modèle est donc littéralement différent, et la règle du dépôt ne souffre pas
 * d'exception : un prompt différent ne partage pas un numéro avec un autre.
 *
 * La migration 0056 fait porter l'unicité d'un brouillon sur (analyse, version
 * de prompt) : le texte écrit sous r6 s'inscrit donc À CÔTÉ de celui de r5,
 * sans écraser un brouillon qu'un humain aurait approuvé ou réécrit.
 */
/*
 * Pourquoi `r8` — le fil montré s'arrête au message traité.
 *
 * `renderThreadBlock` montrait les tours arrivés APRÈS celui qu'on traite. En
 * production cela ne change rien (le message traité est le dernier), et en
 * retraitement cela faisait écrire une réponse au mauvais message. Le texte
 * rendu au modèle est donc différent, et la règle ne souffre pas d'exception.
 *
 * Pourquoi `r7` — HERMES-SEMANTIC-GROUNDING-R1.
 *
 * Le texte rendu au modèle est littéralement différent, à trois endroits :
 *
 *   1. la ligne « LECTURE DE CE MESSAGE : <catégorie> (confiance <x>) » a
 *      disparu. Elle renvoyait au modèle une étiquette que, sur le chemin
 *      unifié, c'est LUI qui produit — un prompt qui affirme la réponse qu'il
 *      demande. Les sous-signaux restent : ils sont déterministes et lus du
 *      texte, pas de la catégorie ;
 *   2. les blocs de vérité sont choisis sur une lecture des SIGNAUX qui écarte
 *      désormais un sujet reconnu dans une portion rapportée, citée, niée ou
 *      hypothétique. Un tour qui raconte que ses clients demandaient le prix ne
 *      reçoit plus le bloc tarifaire ;
 *   3. l'historique montré ne compte plus un brouillon validé mais jamais remis
 *      comme un tour EXPOSÉ, ce qui change ce que l'état déclare couvert.
 *
 * La règle du dépôt ne souffre pas d'exception : un prompt différent ne partage
 * pas un numéro avec un autre. La migration 0056 fait porter l'unicité d'un
 * brouillon sur (analyse, version de prompt), donc le texte écrit sous r7
 * s'inscrit À CÔTÉ de celui de r6 sans jamais l'écraser.
 */
export const CONVERSATION_PROMPT_VERSION_EMAIL = 'conv-r8-draft-1';
export const CONVERSATION_PROMPT_VERSION_INSTAGRAM = 'conv-r8-ig-draft-1';

export function conversationPromptVersionFor(channel: 'email' | 'instagram_dm'): string {
  return channel === 'instagram_dm' ? CONVERSATION_PROMPT_VERSION_INSTAGRAM : CONVERSATION_PROMPT_VERSION_EMAIL;
}

/**
 * Toutes les consignes que le dépôt produit AUJOURD'HUI.
 *
 * Deux, une par canal, et dérivées de la fonction plutôt que réécrites — une
 * troisième copie serait exactement le défaut que ce module referme. Sert à
 * répondre, sans connaître le canal d'une analyse, à « ce brouillon a-t-il été
 * écrit sous une consigne encore en vigueur ? ».
 */
export const CURRENT_DRAFT_PROMPT_VERSIONS: readonly string[] = Object.freeze([
  conversationPromptVersionFor('email'),
  conversationPromptVersionFor('instagram_dm'),
]);
