/**
 * R6B-D2 — la FORME d'une lecture de réponse, et ce qui la corrige sans modèle.
 *
 * HERMES-SEMANTIC-GROUNDING-R1 — ce fichier ne fait plus d'appel. Il portait
 * `classifyReply`, qui demandait une étiquette au modèle ; l'appel vit
 * désormais dans `conversation/turn.ts`, où la lecture et la rédaction sortent
 * du même raisonnement et ne peuvent donc plus se contredire.
 *
 * Ce qui reste ici est tout ce qui DÉCIDE sans modèle : la forme du résultat
 * que `persistAnalysis` attend, la version de prompt qui identifie une analyse,
 * la vérification des citations, et le type d'échec.
 *
 * L'HISTORIQUE, pour que la suite se relise :
 *
 * Deux chemins, dans cet ordre, et ce n'est pas un détail d'implémentation :
 *
 *   1. **déterministe** — une non-remise et une réponse automatique se lisent
 *      dans les en-têtes (`Content-Type: multipart/report`,
 *      `Auto-Submitted`, `X-Failed-Recipients`, expéditeur `mailer-daemon`).
 *      Ce sont des faits de protocole, pas des jugements. Les faire passer par
 *      un modèle coûterait un appel, ajouterait une latence, et donnerait une
 *      chance non nulle de se tromper sur quelque chose qui n'est pas
 *      discutable ;
 *
 *   2. **modèle** — pour ce qui reste, c'est-à-dire une phrase écrite par un
 *      humain. Le modèle ne rend qu'une étiquette et sa justification ; ce
 *      qu'il s'ensuit est décidé par `src/lib/replies/taxonomy.ts`, en code
 *      testé (CLAUDE.md : « toute logique déterministe reste du code testé,
 *      jamais un prompt »).
 *
 * Le routage n'est pas choisi ici : la tâche `reply` existe déjà dans
 * `config/models.json` depuis R1 et c'est elle qui décide du modèle et de
 * l'effort. Aucun nom de modèle n'apparaît dans ce fichier.
 */

import type { CurrentRequestTopic } from '@/lib/conversation/currentRequest';
import type { CategoryDecision, NextAction, ReplyCategory } from '@/lib/replies/taxonomy';

/**
 * Version du prompt de classification.
 *
 * Fait partie de l'identité d'une analyse en base
 * (`r6b_reply_analyses_identity_idx`) : la changer autorise une reclassification
 * des messages déjà traités, sans jamais écraser la précédente. Ne PAS la
 * changer quand le prompt change ferait cohabiter deux décisions produites par
 * deux textes différents sous la même étiquette de version.
 */
export const REPLY_CLASSIFIER_PROMPT_VERSION = 'hermes-turn-3';

/*
 * Pourquoi `-3` — le fil montré s'arrête au message traité.
 *
 * Le rejeu des tours réels a rendu des lectures FAUSSES, et il l'a fait de
 * façon très lisible : « Pourquoi tu me demande ça » sortait en
 * `INFORMATION_SHARED` et « Sa fais 11 ans que j'exerce » en `NOT_INTERESTED`,
 * alors que les deux avaient été correctement lues sous `r6b-d2-classify-2`.
 *
 * La cause était dans le prompt. `renderThreadBlock` montrait le fil ENTIER,
 * messages arrivés APRÈS celui qu'on juge compris ; le modèle classait le
 * dernier. L'ancien prompt de classification ne pouvait pas commettre cette
 * faute — il portait `renderPrecedingTurnsBlock`, qui ne montre que ce qui
 * PRÉCÈDE — et il le disait même en toutes lettres : « n'utilise JAMAIS ce qui
 * précède pour classer un ancien message ».
 *
 * En production, la borne ne change RIEN : le message traité est le dernier du
 * fil. Elle ne vaut que pour un retraitement — et c'est précisément là qu'elle
 * manquait.
 *
 * Pourquoi `-2` — et pourquoi il a fallu trois numéros dans le même round.
 *
 * `hermes-turn-1` a été LU par un `ig:inbound:run --loop` en cours d'exécution,
 * le 23 août 2026 entre 21:10 et 21:15 (heure locale), alors que le prompt
 * unifié était encore en train d'être écrit. `tsx` compile depuis le disque :
 * un worker démarré à un instant T lit le fichier tel qu'il est, commité ou
 * non. Dix-huit analyses ont été rendues sous une consigne qui a changé dans
 * l'heure qui a suivi — le bloc de contexte du classifieur y était encore
 * recopié en double, et la ligne de clôture n'était pas la même.
 *
 * La sentinelle de révision (`inbound/codeRevision.ts`) ne pouvait rien voir :
 * elle compare des révisions Git, et ces changements-là n'étaient pas encore
 * commités. C'est sa limite, et elle est nommée ici plutôt que découverte deux
 * fois.
 *
 * La réponse du dépôt à « une conclusion a été rendue sous une consigne qui
 * n'existe plus » est la même depuis
 * HERMES-ACTIVE-ANALYSIS-VERSION-CONFLICT-R1 : on n'efface pas, on VERSIONNE.
 * L'incrément rend ces dix-huit lignes non canoniques, `processReply` relit
 * chaque message avec le code courant, `persistAnalysis` supersède au lieu
 * d'écraser, et la conclusion d'hier reste lisible avec le prompt qui l'a
 * produite. Aucun geste d'opérateur n'est nécessaire, et aucune ligne n'est
 * perdue.
 *
 * Pourquoi `hermes-turn-*` — HERMES-SEMANTIC-GROUNDING-R1.
 *
 * Cette constante ne nomme plus « le prompt du classifieur » : elle nomme LE
 * PROMPT QUI A PRODUIT L'ANALYSE, ce qui est ce qu'une colonne `prompt_version`
 * a toujours voulu dire. Depuis ce round, ce prompt lit ET écrit dans le même
 * raisonnement (`conversation/turn.ts`) : il n'y a plus deux consignes, donc
 * plus deux façons de comprendre le même message.
 *
 * L'incrément autorise — sans jamais l'imposer — une relecture des messages
 * déjà traités : `processReply` rejoue quand la version diffère,
 * `persistAnalysis` supersède au lieu d'écraser, et la conclusion d'hier reste
 * lisible avec le prompt qui l'a produite.
 *
 * Le nom de la constante n'a PAS changé, et c'est délibéré : la machinerie de
 * retrait (`analysisRetirement.ts`), la sentinelle de révision et la
 * certification la lisent comme « la version canonique d'une analyse ». La
 * renommer aurait été un diff de confort au milieu d'un round qui touche
 * l'envoi.
 *
 * L'HISTORIQUE — pourquoi `-2` avant lui — HERMES-CONTEXTUAL-REPLY-CLASSIFICATION-R1.
 *
 * Deux changements, et chacun suffirait :
 *
 *   1. le prompt porte désormais les TOURS QUI PRÉCÈDENT (au plus trois), là
 *      où il ne portait que le premier message du manifeste. La différence est
 *      invisible au deuxième message d'une conversation, où les deux
 *      coïncident, et décisive à partir du troisième ;
 *
 *   2. la taxonomie a gagné `INFORMATION_SHARED`. Une analyse rendue sous `-1`
 *      n'a jamais pu choisir cette étiquette : la relire comme si elle avait pu
 *      ferait dire à l'archive qu'un modèle a écarté une option qu'on ne lui
 *      avait pas proposée.
 *
 * L'incrément est ce qui autorise — sans jamais l'imposer — une
 * reclassification des messages déjà traités : `processReply` reclasse quand la
 * version diffère, `persistAnalysis` supersède au lieu d'écraser, et la
 * conclusion d'hier reste lisible avec le prompt qui l'a produite.
 */

export interface EvidenceExcerpt {
  readonly quote: string;
  readonly why: string;
}

export interface ClassificationResult {
  readonly category: ReplyCategory;
  readonly confidence: number;
  readonly reasoningSummary: string;
  readonly evidenceExcerpts: readonly EvidenceExcerpt[];
  /**
   * HERMES-SEMANTIC-GROUNDING-R1 — ce que la personne nous demande MAINTENANT.
   *
   * `null` sur une lecture déterministe (une non-remise ne demande rien) et sur
   * toute analyse rendue avant ce round. Le code traite `null` comme une
   * ABSENCE D'OPINION, jamais comme une absence de demande — il ne s'en sert
   * que pour AJOUTER une escalade, donc `null` ne peut rien ouvrir.
   */
  readonly currentRequest: CurrentRequestTopic | null;
  /** Ce qu'elle RAPPORTE. Descriptif : aucune porte ne le lit. */
  readonly reportedContent: readonly string[];
  readonly requiresHumanReview: boolean;
  readonly recommendedNextAction: NextAction;
  readonly decision: CategoryDecision;
  readonly decidedDeterministically: boolean;
  readonly model: string;
  readonly effort: string | null;
  readonly promptVersion: string;
  readonly inputSha256: string;
  readonly modelRunId: string | null;
}

/**
 * Un échec de classification n'est PAS une catégorie.
 *
 * Il serait tentant de rendre `REVIEW_REQUIRED` quand le modèle ne répond pas :
 * le pipeline continuerait, la file de revue se remplirait, tout aurait l'air
 * de fonctionner. Ce serait un mensonge — « je ne sais pas quoi conclure » et
 * « je n'ai pas réussi à demander » sont deux états différents, et le second
 * doit laisser le message NON TRAITÉ pour que la prochaine exécution
 * réessaie. §15 de la mission : « classifier failure → no silent transition ».
 */
export class ClassificationFailure extends Error {
  readonly kind: 'model_unavailable' | 'model_error' | 'invalid_answer';
  constructor(kind: ClassificationFailure['kind'], message: string) {
    super(message);
    this.name = 'ClassificationFailure';
    this.kind = kind;
  }
}

/**
 * Ne garde que les extraits réellement présents dans la réponse reçue.
 *
 * Un modèle qui « cite » une phrase absente du corps a inventé une preuve, et
 * CLAUDE.md (interdit n°2) ne laisse pas passer cela même sous forme
 * décorative. La comparaison se fait sur les blancs normalisés : un modèle qui
 * recopie correctement en reformatant les retours à la ligne cite bien.
 */
export function keepGroundedExcerpts(
  excerpts: readonly EvidenceExcerpt[],
  body: string,
): { readonly kept: EvidenceExcerpt[]; readonly dropped: string[] } {
  const haystack = body.replace(/\s+/g, ' ').toLowerCase();
  const kept: EvidenceExcerpt[] = [];
  const dropped: string[] = [];
  for (const excerpt of excerpts) {
    const needle = excerpt.quote.replace(/\s+/g, ' ').trim().toLowerCase();
    if (needle.length > 0 && haystack.includes(needle)) kept.push(excerpt);
    else dropped.push(excerpt.quote);
  }
  return { kept, dropped };
}

/*
 * `classifyReply` a vécu ici jusqu'à HERMES-SEMANTIC-GROUNDING-R1.
 *
 * Elle faisait UN appel de modèle pour rendre une étiquette, puis
 * `buildConversationReply` en faisait un second pour écrire la réponse. Les
 * deux lisaient le même fil sous deux consignes différentes et pouvaient donc
 * ne pas être d'accord — ce qui est arrivé.
 *
 * Ce que ce fichier garde est tout ce qui DÉCIDE sans modèle : le filet
 * anti-désabonnement, le rabattement sous seuil (`decideCategory`), la
 * vérification des citations (`keepGroundedExcerpts`), et la forme du résultat
 * que `persistAnalysis` attend. L'appel, lui, vit dans
 * `conversation/turn.ts`.
 */
