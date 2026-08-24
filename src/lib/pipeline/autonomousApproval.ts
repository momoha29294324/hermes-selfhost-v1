import type { Sql } from '@/lib/db/sql';

/**
 * HERMES-AUTONOMOUS-R2 — l'écriture d'une approbation MACHINE, et le seul
 * endroit du dépôt qui en produise une.
 *
 * ---------------------------------------------------------------------------
 * La règle que ce module existe pour tenir
 * ---------------------------------------------------------------------------
 * Une approbation machine ne doit jamais être enregistrée comme si elle était
 * humaine. Ce n'est pas une préférence de journalisation : `r6b_batch_votes`
 * est la table qu'on relira pour répondre à « qui a décidé que ce message
 * parte ? », et une réponse fausse à cette question-là est la seule qu'on ne
 * puisse pas rattraper après coup.
 *
 * La provenance vit donc dans `actor_kind` (0047), une colonne contrainte à
 * deux valeurs — jamais dans `note`. Une note se lit, se copie et s'imite ;
 * aucune contrainte ne la fait respecter, et un lecteur pressé la saute. Une
 * valeur contrainte, elle, ne peut pas mentir sans que la base refuse la ligne.
 *
 * Ce que ce module n'écrit JAMAIS :
 *   * un nom d'humain — `castR6bVote` reste le chemin des humains, intact ;
 *   * un `REJECT` ni un `EDIT` — la contrainte `r6b_vote_machine_only_sends`
 *     l'interdit en base, et le code ne le propose même pas. La politique
 *     autonome n'a que deux issues : approuver, ou écarter sans rien écrire ;
 *   * une ligne pour un prospect qu'un humain a refusé (voir ci-dessous).
 */

/**
 * Le refus d'écrire, nommé. Distinct d'une erreur technique : la base va bien,
 * c'est la DEMANDE qui n'a pas lieu d'être.
 */
export class AutonomousApprovalError extends Error {
  readonly code: 'human_reject_stands' | 'empty_text' | 'item_not_found';

  constructor(code: AutonomousApprovalError['code'], message: string) {
    super(message);
    this.name = 'AutonomousApprovalError';
    this.code = code;
  }
}

export interface AutonomousApprovalInput {
  readonly itemId: string;
  /** Le texte EXACT qui partirait. Jamais retouché ici, jamais reconstruit. */
  readonly approvedText: string;
  /** `AUTONOMOUS_POLICY_VERSION` — la politique qui a tranché, pour la rejouer. */
  readonly policyVersion: string;
}

export interface AutonomousApproval {
  readonly voteId: string;
  readonly itemId: string;
  readonly actorKind: 'AUTONOMOUS_POLICY';
  readonly policyVersion: string;
  readonly approvedText: string;
  /** `true` quand un vote précédent existait — l'insert est alors une correction journalisée. */
  readonly isCorrection: boolean;
  /** Le texte reprend-il mot pour mot celui qu'un humain avait déjà approuvé ? */
  readonly carriesHumanText: boolean;
}

interface LatestVoteRow {
  readonly id: string;
  readonly verdict: string;
  readonly actorKind: string;
  readonly approvedText: string | null;
}

const LATEST_VOTE = `
  select id, verdict, actor_kind as "actorKind", approved_text as "approvedText"
    from r6b_batch_votes
   where item_id = $1
   -- L'id départage une égalité d'horodatage, dans le MÊME sens que
   -- loadLatestVotes (r6bBatch.ts) : les deux lectures doivent désigner la
   -- même ligne, sans quoi l'une pourrait voir un REJECT humain que l'autre ne
   -- voit pas. Voir HERMES-END-TO-END-CERTIFICATION-R1.
   order by created_at desc, id desc
   limit 1`;

/**
 * Inscrit l'approbation de la politique autonome sur un item.
 *
 * Append-only, comme tous les votes depuis 0018 : la ligne précédente n'est ni
 * écrasée ni supprimée. Un vote humain passé reste lisible pour toujours — le
 * mode autonome se passe d'une décision humaine ABSENTE, il n'efface pas celles
 * qui ont été prises.
 *
 * Le seul cas où ce module REFUSE d'écrire est un `REJECT` humain courant. Il
 * est refusé ici EN PLUS de l'être par la politique (`firstRefusal`, porte 1),
 * et la redondance est délibérée : cette fonction est appelable depuis
 * n'importe où, et la garde qui compte est celle qui se trouve sur le chemin de
 * l'écriture, pas celle qui la précède de trois appels.
 */
export async function recordAutonomousApproval(
  sql: Sql,
  input: AutonomousApprovalInput,
): Promise<AutonomousApproval> {
  const text = input.approvedText.trim();
  if (text.length === 0) {
    throw new AutonomousApprovalError(
      'empty_text',
      `item ${input.itemId} : aucun texte à approuver — une approbation sans message n'approuve rien`,
    );
  }

  const items = await sql.query<{ id: string }>('select id from r6b_batch_items where id = $1', [input.itemId]);
  if (items.length !== 1) {
    throw new AutonomousApprovalError('item_not_found', `item ${input.itemId} introuvable`);
  }

  const previous = await sql.query<LatestVoteRow>(LATEST_VOTE, [input.itemId]);
  const latest = previous[0] ?? null;

  if (latest !== null && latest.verdict === 'REJECT' && latest.actorKind === 'HUMAN') {
    throw new AutonomousApprovalError(
      'human_reject_stands',
      `item ${input.itemId} : un humain a refusé ce prospect (vote ${latest.id}) — ` +
        'une politique automatique ne renverse pas une décision humaine',
    );
  }

  // Un vote machine ne peut pas non plus renverser un REJECT machine plus
  // ancien sans que la politique ait rejugé : mais elle vient précisément de le
  // faire, et elle n'écrit jamais de REJECT — ce cas n'existe donc pas.

  const carriesHumanText =
    latest !== null && latest.actorKind === 'HUMAN' && (latest.approvedText ?? '').trim() === text;

  const inserted = await sql.query<{ id: string }>(
    `insert into r6b_batch_votes
       (item_id, verdict, approved, approved_text, approved_at, note, is_correction, actor_kind, policy_version)
     values ($1, 'SEND', true, $2, now(), $3, $4, 'AUTONOMOUS_POLICY', $5)
     returning id`,
    [
      input.itemId,
      text,
      // La note est du CONTEXTE, jamais la provenance : `actor_kind` porte la
      // provenance et lui seul. Elle dit ici l'unique chose qu'une colonne ne
      // dit pas — que le texte vient d'une reformulation humaine antérieure,
      // reprise mot pour mot plutôt que régénérée.
      carriesHumanText
        ? 'politique autonome : texte repris mot pour mot d’une approbation humaine antérieure'
        : 'politique autonome : toutes les portes déterministes vertes',
      latest !== null,
      input.policyVersion,
    ],
  );

  const voteId = inserted[0]?.id;
  if (voteId === undefined) {
    throw new Error(`insertion du vote autonome sans identifiant rendu pour l'item ${input.itemId}`);
  }

  return {
    voteId,
    itemId: input.itemId,
    actorKind: 'AUTONOMOUS_POLICY',
    policyVersion: input.policyVersion,
    approvedText: text,
    isCorrection: latest !== null,
    carriesHumanText,
  };
}

export interface ApprovalProvenance {
  readonly voteId: string;
  readonly actorKind: 'HUMAN' | 'AUTONOMOUS_POLICY';
  readonly policyVersion: string | null;
  readonly verdict: string;
}

/**
 * De qui vient l'approbation qu'un manifeste porte ?
 *
 * Lue par le worker autonome, qui n'a le droit d'agir que sur SES propres
 * approbations (§7 : « un ancien manifeste humain ne devient pas
 * automatiquement candidat »). Ce qui n'est pas reconnu est rendu `HUMAN` :
 * l'inconnu se lit du côté qui ferme la porte au worker automatique.
 */
export async function loadManifestApprovalProvenance(
  sql: Sql,
  manifestId: string,
): Promise<ApprovalProvenance | null> {
  const rows = await sql.query<LatestVoteRow>(
    `select v.id, v.verdict, v.actor_kind as "actorKind", v.policy_version as "policyVersion",
            v.approved_text as "approvedText"
       from r6b_dispatch_manifests m
       join r6b_batch_votes v on v.id = m.approval_vote_id
      where m.id = $1`,
    [manifestId],
  );
  const row = rows[0] as (LatestVoteRow & { policyVersion: string | null }) | undefined;
  if (row === undefined) return null;

  const actorKind = row.actorKind === 'AUTONOMOUS_POLICY' ? 'AUTONOMOUS_POLICY' : 'HUMAN';
  return {
    voteId: row.id,
    actorKind,
    policyVersion: actorKind === 'AUTONOMOUS_POLICY' ? row.policyVersion : null,
    verdict: row.verdict,
  };
}
