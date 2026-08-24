/**
 * HERMES-SEMANTIC-GROUNDING-R1 — le faux modèle du TOUR UNIFIÉ.
 *
 * Jusqu'à ce round, un tour coûtait deux appels et les tests scriptaient deux
 * réponses : `classify` pour la tâche `reply`, `draft` pour la tâche `message`.
 * Il n'y a plus qu'un appel, et il rend les deux dans le même objet.
 *
 * Ce module fusionne les deux scripts existants plutôt que de les réécrire :
 * les attentes des tests portent sur les mêmes valeurs, et un test qui aurait
 * dû réécrire sa classification aurait pu, sans qu'on s'en aperçoive, se mettre
 * à prouver autre chose.
 */

export interface ClassifyScript {
  readonly category?: unknown;
  readonly confidence?: unknown;
  readonly reasoning_summary?: unknown;
  readonly evidence_excerpts?: unknown;
}

export interface DraftScript {
  readonly body?: unknown;
  readonly rationale?: unknown;
  readonly used_facts?: unknown;
}

/**
 * Compose la réponse d'un tour depuis les deux scripts d'avant.
 *
 * `current_request` vaut `NONE` par défaut : c'est la valeur qui n'ouvre AUCUNE
 * escalade supplémentaire, donc celle qui laisse les tests éprouver ce qu'ils
 * éprouvaient — le lexique déterministe, et lui seul.
 */
export function turnAnswer(
  rawClassify: unknown,
  rawDraft: unknown,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const classify = rawClassify as ClassifyScript | undefined;
  const draft = rawDraft as DraftScript | undefined;
  return {
    category: classify?.category ?? 'QUESTION',
    confidence: classify?.confidence ?? 0.9,
    reasoning_summary: classify?.reasoning_summary ?? 'lecture de test',
    evidence_excerpts: classify?.evidence_excerpts ?? [],
    current_request: 'NONE',
    reported_content: [],
    reply: draft?.body ?? '',
    reply_rationale: draft?.rationale ?? 'brouillon de test',
    used_facts: draft?.used_facts ?? [],
    // `body` et `rationale` sont là pour le chemin de RELECTURE
    // (`buildConversationReply`), qui est appelé quand une lecture déjà rendue
    // est réutilisée et qu'aucun texte n'existe sous la consigne du jour. Le
    // même faux modèle sert donc les deux chemins, ce qui évite deux scripts
    // pour la même conversation.
    body: draft?.body ?? '',
    rationale: draft?.rationale ?? 'brouillon de test',
    ...overrides,
  };
}
