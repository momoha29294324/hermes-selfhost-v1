/**
 * HERMES-SALES-KNOWLEDGE-R1 §10, §11, §12 — la FORME d'un savoir commercial
 * emprunté, et ce qui l'empêche de se faire passer pour une politique.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi une bibliothèque, et pas un prompt plus long
 * ---------------------------------------------------------------------------
 * Une transcription de cinquante minutes tient dans un contexte de modèle. La
 * coller dans le prompt aurait donc « marché », au sens où quelque chose serait
 * sorti. Ce qui n'aurait pas marché : dire d'où vient une phrase. Un modèle à
 * qui l'on donne une vidéo entière rend un mélange — sa propre connaissance, la
 * vidéo, et ce qu'il croit que la vidéo dit — et rien, ensuite, ne permet de
 * remonter d'une consigne appliquée à la minute qui l'a produite.
 *
 * Ce module impose donc la forme inverse : des PRINCIPES atomiques, chacun
 * borné par un intervalle de la source, chacun classé, chacun opposable. Le
 * runtime ne lit jamais la transcription — il lit ces principes-là.
 *
 * ---------------------------------------------------------------------------
 * §16 — une vidéo n'écrase jamais une politique
 * ---------------------------------------------------------------------------
 * C'est la propriété structurante, et elle est portée par le TYPE plutôt que
 * par la discipline de qui écrit les données. Un principe n'a aucun champ qui
 * puisse lever une garde : pas de booléen d'autorisation, pas de seuil, pas de
 * plafond, pas de version de politique. Le seul champ qui atteint un prompt est
 * `promptDirective`, une phrase de conseil de rédaction — et il est refusé aux
 * principes que la revue a écartés.
 *
 * Autrement dit : le pire qu'un mauvais principe puisse faire est de donner un
 * mauvais conseil de style à un brouillon qui sera ensuite mesuré par les mêmes
 * contrôles déterministes qu'avant. Il ne peut pas ouvrir une porte, parce
 * qu'il n'existe aucun champ à travers lequel une porte s'ouvrirait.
 */

import { z } from 'zod';

/**
 * L'identifiant de CETTE bibliothèque.
 *
 * Distinct des trois versions de politique déjà portées par le dépôt
 * (`CONVERSATION_POLICY_VERSION`, `COMMERCIAL_POLICY_VERSION`,
 * `AUTONOMOUS_POLICY_VERSION`), et volontairement : celles-là gouvernent des
 * décisions et referment des approbations quand elles changent. Celle-ci ne
 * gouverne rien. Elle date un corpus, ce qui permet de dire « ce brouillon a
 * été écrit en voyant ces principes-là » sans laisser croire qu'il a été
 * AUTORISÉ par eux.
 */
export const SALES_KNOWLEDGE_VERSION = 'hermes-sales-knowledge-r1';

/**
 * L'étape de vente à laquelle un principe se rapporte.
 *
 * Ce vocabulaire est celui de la SOURCE, pas celui du dépôt. `OfferStage` et
 * `ConversationGoal` décrivent ce que Hermes décide ; ces valeurs-ci décrivent
 * de quoi un expert extérieur parlait. Les confondre reviendrait à laisser une
 * vidéo renommer les états de notre propre machine — et un jour, à laisser une
 * étiquette empruntée décider d'un branchement.
 *
 * La traduction entre les deux vocabulaires vit dans `retrieval.ts`, en un seul
 * endroit, explicite et testé.
 */
export const principleStageSchema = z.enum([
  /** Trouver à qui parler. */
  'SOURCING',
  /** Ce qui se passe avant l'envoi du premier message. */
  'PRE_TOUCH',
  /** Le premier message. */
  'FIRST_TOUCH',
  /** Découvrir ce dont la personne a besoin. */
  'QUALIFICATION',
  /** Tenir l'échange une fois engagé. */
  'CONVERSATION',
  /** Traiter un frein. */
  'OBJECTION',
  /** Ce qui est proposé, et à quelles conditions. */
  'OFFER',
  /** Obtenir l'échange de vive voix. */
  'APPOINTMENT',
  /** Reprendre un fil interrompu. */
  'FOLLOW_UP',
  /** Ce qui se passe pendant et après l'appel. Hors périmètre de Hermes. */
  'CLOSING',
  /** Volume, outillage, organisation. */
  'OPERATIONS',
]);
export type PrincipleStage = z.infer<typeof principleStageSchema>;

/**
 * Le verdict de la revue sur un principe.
 *
 *   * `ADOPT` — vrai pour Hermes tel quel, sans transposition ;
 *   * `ADAPT_TO_HERMES` — l'idée est retenue, le mécanisme est remplacé ;
 *   * `CONTEXT_ONLY` — utile à comprendre, jamais appliqué ;
 *   * `REJECT` — refusé, et la raison est écrite.
 *
 * Seuls les deux premiers peuvent atteindre un prompt (`injectablePrinciple`).
 */
export const principleClassificationSchema = z.enum([
  'ADOPT',
  'ADAPT_TO_HERMES',
  'CONTEXT_ONLY',
  'REJECT',
]);
export type PrincipleClassification = z.infer<typeof principleClassificationSchema>;

/**
 * De quelle façon un principe est refusé, quand il l'est.
 *
 * Trois refus qui ne se ressemblent pas, et que la mission distingue elle-même
 * (§15) :
 *
 *   * `AS_LITERAL` — la formulation est refusée, l'intention sous-jacente peut
 *     rester légitime. Une garantie chiffrée est refusée comme phrase ; vouloir
 *     rassurer ne l'est pas ;
 *   * `OPERATIONALLY` — l'idée se défend, sa mise en œuvre est impossible ici.
 *     Les volumes de la source n'ont rien de faux dans leur contexte ; ils ne
 *     remplacent simplement aucun plafond du nôtre ;
 *   * `ENTIRELY` — rien n'est récupérable, y compris l'intention. La création
 *     de comptes pour dépasser une limite de plateforme n'a pas de version
 *     acceptable.
 *
 * Le champ est autorisé hors de `REJECT` : un principe peut être retenu comme
 * contexte tout en portant des nombres qu'on refuse de reprendre au pied de la
 * lettre. La mission écrit elle-même « CONTEXT_ONLY / REJECT_OPERATIONALLY ».
 */
export const principleRejectionSchema = z.enum(['AS_LITERAL', 'OPERATIONALLY', 'ENTIRELY']);
export type PrincipleRejection = z.infer<typeof principleRejectionSchema>;

/**
 * La confiance dans la LECTURE du principe, pas dans sa vérité.
 *
 * La distinction est le sujet de §17 : `HIGH` signifie « la source dit
 * clairement cela », jamais « cela marche pour Hermes ». Aucune valeur de ce
 * champ ne rend un principe plus vrai, et aucune ne le rend applicable.
 */
export const principleConfidenceSchema = z.enum(['HIGH', 'MEDIUM', 'LOW']);
export type PrincipleConfidence = z.infer<typeof principleConfidenceSchema>;

/** Un désaccord entre un principe et quelque chose que le dépôt porte déjà. */
export const principleConflictSchema = z.object({
  /** Ce avec quoi le principe se heurte, nommé pour être retrouvé. */
  with: z.string().min(1),
  /**
   * Comment le désaccord est tranché.
   *
   * Une seule valeur existe, et c'est le point : §16 pose que la politique
   * gagne toujours. Une union à un membre rend impossible d'écrire un jour
   * `SOURCE_WINS` sans modifier ce fichier — donc sans revue.
   */
  resolution: z.literal('POLICY_WINS'),
});
export type PrincipleConflict = z.infer<typeof principleConflictSchema>;

const TIMESTAMP = /^\d{2}:\d{2}$/u;

export const salesPrincipleSchema = z
  .object({
    id: z.string().min(1),
    /** L'intervalle exact de la source. Un principe sans borne n'existe pas. */
    timestampStart: z.string().regex(TIMESTAMP),
    timestampEnd: z.string().regex(TIMESTAMP),
    /** Les numéros de sous-titre, qui sont l'ancre réellement vérifiable. */
    cueStart: z.number().int().positive(),
    cueEnd: z.number().int().positive(),
    stage: principleStageSchema,
    /** Un code court, stable, lisible dans un rapport. */
    topic: z.string().min(1),
    /** Le principe, PARAPHRASÉ. Jamais une citation présentée comme exacte (§38). */
    principle: z.string().min(1),
    /** Pourquoi la source le dit — son raisonnement, pas le nôtre. */
    rationale: z.string().min(1),
    classification: principleClassificationSchema,
    rejection: principleRejectionSchema.nullable(),
    /** Ce que cela signifie pour Hermes. C'est ICI que vit la décision. */
    applicability: z.string().min(1),
    conflicts: z.array(principleConflictSchema),
    confidence: principleConfidenceSchema,
    /**
     * §38 — la transcription est-elle douteuse sur ce passage ?
     *
     * `true` n'invalide pas le principe : il interdit de s'appuyer sur les mots
     * exacts. Un nom propre instable ou un montant sans unité rendent l'anecdote
     * incitable, pas l'idée inaudible.
     */
    transcriptUncertain: z.boolean(),
    /**
     * La phrase qu'un prompt peut lire. `null` = ce principe n'entre jamais
     * dans une rédaction.
     *
     * Un conseil de RÉDACTION, jamais une permission : aucune directive ne peut
     * dire « tu peux annoncer », « tu peux garantir » ni « tu peux chiffrer ».
     * Ce que ces choses coûtent est décidé ailleurs, par du code.
     */
    promptDirective: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.cueEnd < value.cueStart) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value.id} : l'intervalle de sous-titres est inversé`,
      });
    }
    // §20 — « rejected principle never injected ». La règle est ici, dans le
    // schéma, et non dans la fonction de récupération : une donnée qui ne peut
    // pas exister n'a pas besoin d'être filtrée à chaque tour, et un futur
    // chemin de lecture qui oublierait le filtre ne pourrait pas la trouver.
    const injectable =
      value.classification === 'ADOPT' || value.classification === 'ADAPT_TO_HERMES';
    if (!injectable && value.promptDirective !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `${value.id} : un principe ${value.classification} ne peut pas porter de directive de ` +
          'prompt — ce qui a été écarté ne se retrouve pas dans une rédaction',
      });
    }
  });
export type SalesPrinciple = z.infer<typeof salesPrincipleSchema>;

export const salesPrincipleFileSchema = z
  .object({
    sourceId: z.string().min(1),
    extractedAt: z.string().min(1),
    extractedBy: z.string().min(1),
    principles: z.array(salesPrincipleSchema).min(1),
  })
  .strict();

export const salesSourceSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    creators: z.array(z.string().min(1)).min(1),
    creatorContext: z.string().min(1),
    sourceType: z.enum(['YOUTUBE_TRANSCRIPT', 'BOOK', 'ARTICLE', 'INTERNAL_PLAYBOOK']),
    language: z.string().min(2),
    /** Le chemin de l'artefact conservé. Aucun runtime ne le lit (§18). */
    transcriptFile: z.string().min(1),
    /** L'empreinte de l'artefact : c'est elle qui rend la provenance opposable. */
    transcriptSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    transcriptCues: z.number().int().positive(),
    durationLabel: z.string().min(1),
    transcriber: z.enum(['WHISPER', 'HUMAN', 'PLATFORM', 'UNKNOWN']),
    /**
     * Ce que cette source EST, dans la hiérarchie de vérité.
     *
     * Un littéral, pas une énumération ouverte : une source extérieure est une
     * heuristique d'expert. Lui donner un jour l'autorité d'une politique
     * Hermes demanderait de modifier ce fichier, donc de passer par une revue.
     */
    authority: z.literal('EXPERT_HEURISTIC_SOURCE'),
    ingestedAt: z.string().min(1),
    ingestedBy: z.string().min(1),
    /** Ce que la source NE couvre pas. Une absence nommée vaut mieux qu'un silence. */
    coverageGaps: z.array(z.string().min(1)),
    notes: z.string().min(1),
  })
  .strict();
export type SalesSource = z.infer<typeof salesSourceSchema>;

/** Un principe peut-il atteindre un prompt ? Une seule définition, ici. */
export function injectablePrinciple(principle: SalesPrinciple): boolean {
  return (
    principle.promptDirective !== null &&
    (principle.classification === 'ADOPT' || principle.classification === 'ADAPT_TO_HERMES')
  );
}
