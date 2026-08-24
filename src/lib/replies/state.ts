/**
 * R6B-D2 — l'état commercial d'un prospect, ses transitions, et la suppression
 * outbound.
 *
 * Trois propriétés que ce fichier doit tenir, et où elles vivent réellement :
 *
 *   1. **Aucune mutation d'état silencieuse.** Toute transition passe par
 *      `applyTransition`, qui écrit une ligne de journal AVANT de bouger l'état
 *      courant, avec sa cause nommée. Un état sans ligne de journal ne peut pas
 *      exister — c'est le journal qui produit l'état, jamais l'inverse.
 *
 *   2. **Idempotence.** La même cause ne peut pas produire deux fois la même
 *      transition. Garantie par l'index unique
 *      `r6b_prospect_state_transitions_cause_idx`, donc par Postgres, et non
 *      par un `select` préalable que deux processus liraient en même temps.
 *
 *   3. **`SUPPRESSED` est terminal pour la machine.** Ce n'est pas une
 *      convention appliquée par le code appelant : la clause `where` du
 *      `on conflict do update` refuse de faire sortir un prospect de cet état.
 *      Un traitement automatique ne peut donc pas ramener dans la file
 *      quelqu'un qui a demandé qu'on arrête, quelle que soit la suite des
 *      messages qu'il enverra.
 *
 *   4. **Une réponse ANCIENNE ne remplace jamais l'effet d'une réponse plus
 *      RÉCENTE** (HERMES-REPLY-ORDERING-R1). L'ordre qui compte est celui de la
 *      boîte de réception (`r6b_inbound_messages.received_at`), pas celui de la
 *      file de traitement. Tenu par la même clause `where` que le point 3, sur
 *      la marque d'eau `last_reply_received_at` — donc par Postgres, sur la
 *      version à jour de la ligne, et non par une lecture préalable que deux
 *      workers feraient en même temps.
 *
 * ---------------------------------------------------------------------------
 * La temporalité, et à quoi elle ne s'applique PAS
 * ---------------------------------------------------------------------------
 *
 * Seules les transitions dont la cause est un MESSAGE ENTRANT portent une heure
 * métier, et elles sont les seules soumises au point 4. Un premier contact
 * (`outreach_sent`) et une décision humaine (`human`) n'ont pas d'heure de
 * réception : ils traversent la garde sans la consulter et ne font pas bouger
 * la marque d'eau. Cette machine n'est donc pas devenue un « dernier
 * horodatage gagne » — elle ordonne les réponses entre elles, et rien d'autre.
 */

import type { Sql } from '@/lib/db/sql';
import type { OutreachState, ReplyCategory, SuppressionScope } from '@/lib/replies/taxonomy';
import { REPLY_ACKNOWLEDGED_STATE, shouldAcknowledgeReply } from '@/lib/replies/taxonomy';

export type TransitionCause = 'outreach_sent' | 'inbound_reply' | 'human';

export interface TransitionInput {
  readonly prospectId: string;
  readonly toState: OutreachState;
  readonly causeKind: TransitionCause;
  readonly causeId: string | null;
  readonly analysisId: string | null;
  readonly reason: string;
}

/**
 * Pourquoi rien n'a bougé, quand rien n'a bougé.
 *
 * `stale_reply` est le seul membre qui décrit un REFUS de principe plutôt
 * qu'une redite : la transition était légale, sa cause était réelle, mais elle
 * arrive après qu'une réponse plus récente a déjà décidé. Le nommer à part
 * plutôt que le confondre avec `already_recorded` est ce qui permet à un
 * rapport de dire « ignorée parce qu'obsolète » au lieu de « rien à faire ».
 */
export type TransitionSkipReason =
  | 'already_in_state'
  | 'terminal_state'
  | 'already_recorded'
  | 'stale_reply';

export interface TransitionResult {
  readonly applied: boolean;
  readonly fromState: OutreachState | null;
  readonly toState: OutreachState;
  readonly transitionId: string | null;
  readonly skipped: TransitionSkipReason | null;
}

export async function loadOutreachState(sql: Sql, prospectId: string): Promise<OutreachState | null> {
  const rows = await sql.query<{ state: OutreachState }>(
    'select state from r6b_prospect_outreach_states where prospect_id = $1',
    [prospectId],
  );
  return rows[0]?.state ?? null;
}

/**
 * L'état courant ET la marque d'eau des réponses, en une lecture.
 *
 * Les deux vont ensemble : « ce prospect est NOT_INTERESTED » et « il l'est
 * d'après une réponse de 13:35:31 » sont la même information, et les lire en
 * deux requêtes autoriserait un instant où l'une décrit la ligne d'avant et
 * l'autre celle d'après.
 */
export interface OutreachStateRow {
  readonly state: OutreachState;
  /** `null` tant qu'aucune réponse n'a été prise en compte. */
  readonly lastReplyReceivedAt: Date | null;
}

export async function loadOutreachStateRow(
  sql: Sql,
  prospectId: string,
): Promise<OutreachStateRow | null> {
  const rows = await sql.query<{ state: OutreachState; lastReplyReceivedAt: Date | string | null }>(
    `select state, last_reply_received_at as "lastReplyReceivedAt"
       from r6b_prospect_outreach_states where prospect_id = $1`,
    [prospectId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return Object.freeze({
    state: row.state,
    lastReplyReceivedAt: row.lastReplyReceivedAt === null ? null : new Date(row.lastReplyReceivedAt),
  });
}

/**
 * L'HEURE MÉTIER d'une transition : celle de la réception du message qui la
 * cause, ou `null` quand la cause n'est pas un message.
 *
 * Lue ICI plutôt que reçue en paramètre, et c'est le point important : un
 * appelant ne peut pas l'oublier, se tromper de champ, ni passer
 * `processed_at`, `created_at` ou `now()` à sa place. La seule source est
 * `r6b_inbound_messages.received_at` — l'heure à laquelle le fournisseur a
 * accepté le message, la seule qui décrive ce que le prospect a fait plutôt
 * que ce que notre file a fait.
 *
 * `r6b_inbound_messages` porte les DEUX canaux depuis 0042 (e-mail et DM
 * Instagram) : il n'existe donc pas un second entrant qui échapperait à cette
 * lecture.
 */
async function replyBusinessTime(sql: Sql, input: TransitionInput): Promise<Date | null> {
  if (input.causeKind !== 'inbound_reply') return null;
  if (input.causeId === null) {
    throw new Error('transition inbound_reply sans cause_id : aucune heure de réception opposable');
  }
  const rows = await sql.query<{ receivedAt: Date | string }>(
    'select received_at as "receivedAt" from r6b_inbound_messages where id = $1',
    [input.causeId],
  );
  const row = rows[0];
  if (row === undefined) {
    // Refuser bruyamment plutôt que d'appliquer une transition qu'on ne sait
    // pas situer dans le temps : une réponse sans heure ne peut être comparée
    // à aucune autre, donc ne peut pas prouver qu'elle est la plus récente.
    throw new Error(
      `transition inbound_reply dont la cause ${input.causeId} n'existe pas dans r6b_inbound_messages`,
    );
  }
  return new Date(row.receivedAt);
}

/**
 * Fait monter la marque d'eau sans rien décider d'autre.
 *
 * Sert au cas qu'aucune transition ne couvre : une réponse RÉELLE, analysée,
 * dont la conséquence était « ne rien changer » — un prospect déjà dans l'état
 * visé, ou une intention que la garde de progression refuse d'écrire. Sans
 * cette écriture, cette réponse-là ne compterait pas comme « prise en compte »,
 * et une réponse plus ancienne traitée après elle pourrait encore décider.
 *
 * Monotone et idempotente par construction : une seule instruction, un
 * `greatest`, et une clause `where` qui ne laisse pas la marque redescendre.
 * `updated_at` n'est délibérément PAS touché — rien n'a changé pour le CRM, et
 * remonter une fiche dans un tri « récemment modifié » pour un non-événement
 * serait un mensonge d'affichage.
 */
export async function noteReplyConsidered(
  sql: Sql,
  prospectId: string,
  inboundMessageId: string,
): Promise<boolean> {
  const rows = await sql.query<{ prospectId: string }>(
    `update r6b_prospect_outreach_states s
        set last_reply_received_at = greatest(s.last_reply_received_at, i.received_at)
       from r6b_inbound_messages i
      where s.prospect_id = $1
        and i.id = $2
        and (s.last_reply_received_at is null or s.last_reply_received_at < i.received_at)
      returning s.prospect_id as "prospectId"`,
    [prospectId, inboundMessageId],
  );
  return rows.length > 0;
}

/**
 * Applique une transition, une seule fois.
 *
 * Rend toujours un résultat — jamais d'exception pour un cas normal. « Ce
 * prospect est déjà dans cet état » et « ce prospect est supprimé » ne sont pas
 * des erreurs : ce sont les réponses attendues d'un système qu'on relance.
 */
export async function applyTransition(sql: Sql, input: TransitionInput): Promise<TransitionResult> {
  // L'heure métier d'abord : tout ce qui suit en dépend, et la lire ici plutôt
  // que dans la transaction évite de tenir un verrou pendant une lecture qui
  // n'écrit rien.
  const effectiveAt = await replyBusinessTime(sql, input);
  const effectiveIso = effectiveAt === null ? null : effectiveAt.toISOString();
  // Le message qui porte cette heure. Non nul exactement quand `effectiveAt`
  // l'est — `replyBusinessTime` refuse une cause entrante sans identifiant.
  const causeMessageId = effectiveAt === null ? null : input.causeId;

  const row = await loadOutreachStateRow(sql, input.prospectId);
  const current = row?.state ?? null;
  const watermark = row?.lastReplyReceivedAt ?? null;

  // La garde de TEMPORALITÉ, version lisible. Celle qui compte est en SQL,
  // plus bas — ici pour que le refus soit expliqué plutôt que constaté, et
  // pour sortir sans écrire la moindre ligne de journal quand la réponse est
  // manifestement dépassée.
  //
  // Strictement plus ancienne, pas « plus ancienne ou égale » : un même
  // message produit DEUX marches (`CONTACTED → REPLIED` puis
  // `REPLIED → <intention>`), toutes deux à sa propre heure de réception. Un
  // refus à égalité bloquerait la seconde marche du message qui vient
  // légitimement de poser la première.
  if (effectiveAt !== null && watermark !== null && effectiveAt.getTime() < watermark.getTime()) {
    return Object.freeze({
      applied: false,
      fromState: current,
      toState: input.toState,
      transitionId: null,
      skipped: 'stale_reply' as const,
    });
  }

  if (current === input.toState) {
    // Rien à écrire dans l'état — mais cette réponse-là a bien été PRISE EN
    // COMPTE, et la marque doit le dire. Sans cette ligne, deux messages
    // successifs concluant la même chose laisseraient la marque à l'heure du
    // premier, et un troisième message plus ancien pourrait encore décider.
    if (causeMessageId !== null) await noteReplyConsidered(sql, input.prospectId, causeMessageId);
    return Object.freeze({
      applied: false,
      fromState: current,
      toState: input.toState,
      transitionId: null,
      skipped: 'already_in_state' as const,
    });
  }

  // La garde lisible. La garde qui compte est en SQL, plus bas — celle-ci
  // existe pour que le refus soit expliqué plutôt que constaté.
  if (current === 'SUPPRESSED' && input.causeKind !== 'human') {
    return Object.freeze({
      applied: false,
      fromState: current,
      toState: input.toState,
      transitionId: null,
      skipped: 'terminal_state' as const,
    });
  }

  // Une seule transaction : le journal et l'état courant ne peuvent pas exister
  // l'un sans l'autre. Un journal qui affirme une transition que l'état n'a pas
  // prise serait pire qu'une absence de journal — il mentirait.
  //
  // `sql.transaction` est réentrant chez les deux pilotes (PGlite comme
  // node-postgres réutilisent la transaction en cours), donc appeler cette
  // fonction depuis un appelant déjà transactionnel reste correct.
  return sql.transaction(async (tx) => {
    const inserted = await tx.query<{ id: string }>(
      `insert into r6b_prospect_state_transitions
         (prospect_id, from_state, to_state, cause_kind, cause_id, analysis_id, reason)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict do nothing
       returning id`,
      [
        input.prospectId,
        current,
        input.toState,
        input.causeKind,
        input.causeId,
        input.analysisId,
        input.reason.slice(0, 500),
      ],
    );

    const transitionId = inserted[0]?.id ?? null;
    if (transitionId === null) {
      // L'index unique a refusé : cette cause a déjà produit cette transition.
      // L'état courant est donc déjà celui qu'on voulait écrire, ou a été
      // dépassé depuis. Ne rien faire est la seule action correcte.
      return Object.freeze({
        applied: false,
        fromState: current,
        toState: input.toState,
        transitionId: null,
        skipped: 'already_recorded' as const,
      });
    }

    // `where` sur le `do update` : la base elle-même refuse deux choses, et
    // c'est elle qui les refuse, pas la lecture faite plus haut.
    //
    //   * faire sortir un prospect de `SUPPRESSED` autrement que par une
    //     décision humaine ;
    //   * laisser une réponse strictement plus ancienne que la marque d'eau
    //     réécrire l'état — y compris quand un autre worker vient de poser
    //     cette marque entre notre lecture et notre écriture. Postgres
    //     réévalue cette clause sur la version À JOUR de la ligne après avoir
    //     attendu la transaction concurrente : c'est ce qui rend la garde
    //     vraie sous concurrence, là où un `select` préalable ne l'est pas.
    //
    // `greatest` ignore les `null` en SQL : une cause sans heure métier (un
    // premier contact, une décision humaine) laisse donc la marque exactement
    // où elle était au lieu de l'effacer.
    const updated = await tx.query<{ prospectId: string }>(
      `insert into r6b_prospect_outreach_states
         (prospect_id, state, entered_at, last_transition_id, updated_at, last_reply_received_at)
       values ($1,$2,now(),$3,now(),$5::timestamptz)
       on conflict (prospect_id) do update
          set state = excluded.state,
              entered_at = now(),
              last_transition_id = excluded.last_transition_id,
              updated_at = now(),
              last_reply_received_at = greatest(
                r6b_prospect_outreach_states.last_reply_received_at,
                excluded.last_reply_received_at)
        where (r6b_prospect_outreach_states.state <> 'SUPPRESSED' or $4::boolean)
          and ($5::timestamptz is null
               or r6b_prospect_outreach_states.last_reply_received_at is null
               or r6b_prospect_outreach_states.last_reply_received_at <= $5::timestamptz)
       returning prospect_id as "prospectId"`,
      [input.prospectId, input.toState, transitionId, input.causeKind === 'human', effectiveIso],
    );

    if (updated.length === 0) {
      // Une des deux gardes SQL a refusé alors que la lecture initiale ne
      // l'avait pas vue : un autre processus a supprimé ce prospect, ou a posé
      // une marque d'eau plus récente, entre-temps. La ligne de journal qu'on
      // vient d'écrire décrirait une transition qui n'a pas eu lieu — on la
      // retire plutôt que de laisser le journal mentir. Retirer une ligne
      // qu'on vient soi-même d'insérer et dont on tient l'identifiant reste
      // compatible avec le caractère append-only du journal : elle n'a jamais
      // rien décrit.
      await tx.query('delete from r6b_prospect_state_transitions where id = $1', [transitionId]);

      // LAQUELLE des deux gardes a refusé ? La question n'est pas cosmétique :
      // « ce prospect a demandé qu'on arrête » et « cette réponse est dépassée »
      // appellent des suites différentes, et un rapport qui les confondrait
      // enverrait chercher un problème là où il n'y en a pas. Relue dans la
      // transaction, donc sur l'état réel au moment du refus.
      const after = await tx.query<{ state: OutreachState; lastReplyReceivedAt: Date | string | null }>(
        `select state, last_reply_received_at as "lastReplyReceivedAt"
           from r6b_prospect_outreach_states where prospect_id = $1`,
        [input.prospectId],
      );
      const observed = after[0];
      const blockedBySuppression =
        observed?.state === 'SUPPRESSED' && input.causeKind !== 'human';
      return Object.freeze({
        applied: false,
        fromState: (observed?.state ?? current) as OutreachState | null,
        toState: input.toState,
        transitionId: null,
        skipped: (blockedBySuppression ? 'terminal_state' : 'stale_reply') as TransitionSkipReason,
      });
    }

    return Object.freeze({
      applied: true,
      fromState: current,
      toState: input.toState,
      transitionId,
      skipped: null,
    });
  });
}

/**
 * Inscrit l'état `CONTACTED` d'un prospect qui n'en avait pas encore.
 *
 * R6B-D2 hérite d'un envoi parti avant que cette table existe : sans cette
 * amorce, la première transition d'un prospect réellement contacté partirait de
 * `null`, et le journal ne dirait nulle part qu'un message est parti. La cause
 * est l'`outreach_event` lui-même — un fait daté, pas une supposition.
 */
export async function ensureContacted(
  sql: Sql,
  prospectId: string,
  outreachEventId: string,
): Promise<TransitionResult | null> {
  const current = await loadOutreachState(sql, prospectId);
  if (current !== null) return null;
  return applyTransition(sql, {
    prospectId,
    toState: 'CONTACTED',
    causeKind: 'outreach_sent',
    causeId: outreachEventId,
    analysisId: null,
    reason: `outreach_event ${outreachEventId} — premier contact parti`,
  });
}

export interface AcknowledgeReplyInput {
  readonly prospectId: string;
  readonly category: ReplyCategory;
  readonly inboundMessageId: string;
  readonly analysisId: string;
  /** Ce que le classifieur a compris, en une ligne, pour le journal. */
  readonly detail: string;
}

/**
 * HERMES-TARGETING-R1 §5 — inscrit le FAIT qu'un humain a répondu.
 *
 * Posée AVANT la transition d'intention et jamais à sa place : un prospect qui
 * écrit « ça m'intéresse » traverse `CONTACTED → REPLIED → INTERESTED`, deux
 * lignes de journal, deux causes portant le même message entrant. C'est ce que
 * demande une machine à états qui ne saute pas d'étape — et c'est aussi ce qui
 * rend l'historique lisible : on voit qu'il a répondu, puis ce qu'il a dit.
 *
 * Rend `null` quand l'accusé n'apprend rien (auto-réponse, non-remise, prospect
 * déjà au-delà de `CONTACTED`). `null` n'est pas un échec : c'est la réponse
 * normale d'un système qu'on relance, et c'est ce qui rend un second passage
 * gratuit.
 *
 * L'idempotence ne repose pas sur ce `null`. Elle repose sur l'index unique
 * `(prospect_id, cause_kind, cause_id, to_state)` : deux processus qui liraient
 * `CONTACTED` en même temps n'écriraient qu'une seule ligne, le second recevant
 * `already_recorded`.
 */
export async function acknowledgeReply(
  sql: Sql,
  input: AcknowledgeReplyInput,
): Promise<TransitionResult | null> {
  const current = await loadOutreachState(sql, input.prospectId);
  if (!shouldAcknowledgeReply(input.category, current)) return null;
  return applyTransition(sql, {
    prospectId: input.prospectId,
    toState: REPLY_ACKNOWLEDGED_STATE,
    causeKind: 'inbound_reply',
    causeId: input.inboundMessageId,
    analysisId: input.analysisId,
    reason: `réponse humaine reçue (${input.category}) — ${input.detail}`,
  });
}

// ---------------------------------------------------------------------------
// Suppression outbound
// ---------------------------------------------------------------------------

/**
 * `do_not_contact` (0001) est réutilisée telle quelle, et ce n'est pas de la
 * paresse : c'est la table que le pipeline de campagne consulte déjà
 * (`runCampaign.isDoNotContact`), elle est unique par (match_kind, value) donc
 * idempotente par construction, et un désabonnement porte sur une ADRESSE, pas
 * sur une ligne de CRM. Créer une seconde liste d'exclusion aurait produit deux
 * vérités sur « a-t-on le droit d'écrire à cette adresse ».
 */
/**
 * IG5.1 — le TYPE de l'identifiant supprimé.
 *
 * `do_not_contact` connaît `'instagram'` depuis 0001, et le gate Instagram
 * l'interroge déjà (`eligibility.ts`, porte `opt_out`). Ce qui manquait était
 * l'écriture : `suppressOutbound` posait `'email'` en dur, si bien qu'un
 * « ne me recontactez plus » reçu en DM aurait inscrit un HANDLE dans une ligne
 * décrite comme une adresse. La valeur aurait été fausse (interdit n°2) et,
 * comparée ensuite à des adresses, jamais retrouvée — une suppression écrite
 * que personne ne pouvait lire.
 *
 * Le défaut reste `'email'` : tous les appelants existants gardent exactement
 * le comportement qu'ils avaient.
 */
export type SuppressionMatchKind = 'email' | 'instagram';

export interface SuppressionInput {
  readonly scope: Exclude<SuppressionScope, 'none'>;
  readonly address: string;
  readonly inboundMessageId: string;
  readonly detail: string;
  /** Défaut `'email'` — le canal historique. */
  readonly matchKind?: SuppressionMatchKind;
}

export interface SuppressionResult {
  readonly suppressed: boolean;
  readonly address: string;
  readonly reason: string;
  /** Faux quand l'adresse était déjà supprimée — le cas normal d'un rejeu. */
  readonly inserted: boolean;
}

export function suppressionReason(input: SuppressionInput): string {
  const label =
    input.scope === 'permanent'
      ? 'r6b_reply_unsubscribe'
      : 'r6b_reply_bounce';
  return `${label}:${input.inboundMessageId} — ${input.detail}`.slice(0, 500);
}

/**
 * Écrit la suppression.
 *
 * `on conflict do nothing` : si l'adresse est déjà exclue, la raison d'origine
 * est CONSERVÉE. Une adresse déjà supprimée pour désabonnement ne doit pas voir
 * son motif réécrit par un rebond ultérieur — le premier motif est celui qui a
 * une valeur juridique.
 */
export async function suppressOutbound(sql: Sql, input: SuppressionInput): Promise<SuppressionResult> {
  const address = input.address.trim().toLowerCase();
  const reason = suppressionReason(input);
  if (address.length === 0) {
    return Object.freeze({ suppressed: false, address, reason, inserted: false });
  }

  const rows = await sql.query<{ id: string }>(
    `insert into do_not_contact (match_kind, value, reason, added_by)
     values ($3,$1,$2,'r6b-d2')
     on conflict (match_kind, value) do nothing
     returning id`,
    [address, reason, input.matchKind ?? 'email'],
  );

  return Object.freeze({
    suppressed: true,
    address,
    reason,
    inserted: rows.length > 0,
  });
}

export interface OutboundSuppression {
  readonly value: string;
  readonly matchKind: string;
  readonly reason: string;
}

/**
 * Les suppressions qui interdisent d'écrire à ce destinataire.
 *
 * Interrogée par le chemin de dispatch AVANT tout envoi
 * (`resolveDispatchTarget`), ce qui est le seul endroit où la question se pose
 * réellement : une suppression qu'on écrit sans que personne ne la lise n'est
 * pas une suppression.
 */
export async function loadRecipientSuppression(
  sql: Sql,
  recipient: string,
): Promise<OutboundSuppression | null> {
  const value = recipient.trim().toLowerCase();
  if (value.length === 0) return null;
  const rows = await sql.query<OutboundSuppression>(
    `select value, match_kind as "matchKind", reason
       from do_not_contact where match_kind = 'email' and lower(value) = $1 limit 1`,
    [value],
  );
  return rows[0] ?? null;
}

/**
 * Un prospect dont l'état commercial interdit un nouvel envoi automatique.
 *
 * Distinct de la liste d'exclusion : un prospect peut être `SUPPRESSED` sans
 * que l'adresse figée dans un manifeste soit celle qui a demandé l'arrêt (une
 * réponse peut venir d'une autre boîte de la même entreprise). Les deux
 * verrous sont donc lus, pas l'un ou l'autre.
 */
export async function loadBlockingProspectState(
  sql: Sql,
  prospectId: string,
): Promise<OutreachState | null> {
  const state = await loadOutreachState(sql, prospectId);
  if (state === 'SUPPRESSED' || state === 'BOUNCED' || state === 'NOT_INTERESTED') return state;
  return null;
}
