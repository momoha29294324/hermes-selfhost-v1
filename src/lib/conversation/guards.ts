/**
 * HERMES-CONVERSATION-R2 — les faits DURABLES d'un prospect, lus une fois et
 * relus avant l'effet.
 *
 * Ce module ne décide rien. Il rassemble les quatre choses qu'il faut savoir
 * d'un prospect avant de lui écrire quoi que ce soit d'automatique — exclusion,
 * état commercial, identité, dernier message reçu — et il le fait au même
 * endroit pour tout le monde.
 *
 * Pourquoi un module commun plutôt que deux requêtes voisines : l'évaluation
 * (§30) et le crochet pré-effet (§18) posent EXACTEMENT les mêmes questions, à
 * deux instants différents. Deux requêtes auraient fini par diverger sur un
 * `lower()` ou un `match_kind`, et la garde qui compte — celle qui précède
 * l'effet — aurait été la plus indulgente des deux.
 *
 * La lecture d'exclusion reprend mot pour mot le prédicat du CRM
 * (`src/lib/crm/queries.ts`) : un opt-out appartient au COMMERCE, pas à la
 * colonne qui l'a reçu, donc les quatre graphies — e-mail, téléphone, domaine,
 * handle — sont interrogées ensemble.
 */

import type { Sql } from '@/lib/db/sql';
import type { OutreachState } from '@/lib/replies/taxonomy';

export interface ConversationGuards {
  readonly prospectId: string;
  /** Une ligne `do_not_contact` porte sur ce commerce, par n'importe quelle graphie. */
  readonly suppressed: boolean;
  readonly outreachState: OutreachState | null;
  /** La marque d'eau des réponses déjà prises en compte (0048). */
  readonly stateWatermark: string | null;
  /**
   * Le rapprochement entreprise ↔ compte est-il ÉTABLI ?
   *
   * Même barre que le premier contact (`autonomousPolicy`, porte 9) : la
   * provenance automatique figée (`identity_review = 'confirmed'`) ou une
   * décision humaine durable. L'autonomie n'est pas une raison de baisser la
   * barre parce que la personne a écrit la première — un fil peut être tenu par
   * quelqu'un d'autre que le commerce qu'on croit avoir joint.
   */
  readonly identityConfirmed: boolean;
  readonly identityReview: string | null;
  /** L'heure de réception du message entrant le plus récent. `null` si aucun. */
  readonly latestInboundAt: string | null;
  /**
   * L'IDENTIFIANT de ce message-là.
   *
   * HERMES-PLAN-STALE-TRIGGER-FIX-R1 — une heure ne dit pas DE QUI on parle. Un
   * plan écrit en réponse au message X doit pouvoir reconnaître X quand on le
   * lui remontre, sans dépendre de la précision d'un horodatage qui a fait un
   * aller-retour par une chaîne. `null` si aucun entrant corrélé.
   */
  readonly latestInboundId: string | null;
  /**
   * Combien de messages entrants corrélés portent CETTE heure-là.
   *
   * HERMES-END-TO-END-CERTIFICATION-R1 — `1` est le cas normal et le seul où
   * « le plus récent » désigne quelqu'un. Au-delà, l'ordre `received_at desc,
   * id desc` a tranché par un uuid aléatoire, et le rail entrant produit
   * réellement ces égalités : `instagramCollector` horodate à l'instant du
   * relevé tout message non daté par la page, si bien qu'une salve lue d'un
   * seul coup porte l'heure du relevé, la même pour tous.
   *
   * Sert à la fraîcheur, qui refuse plutôt que de jouer à pile ou face. `0`
   * quand aucun entrant corrélé n'existe.
   */
  readonly latestInboundTies: number;
  readonly inboundCount: number;
}

interface GuardRow {
  readonly suppressed: boolean;
  readonly outreachState: OutreachState | null;
  readonly stateWatermark: string | Date | null;
  readonly identityReview: string | null;
  readonly humanChannelDecision: string | null;
  readonly latestInboundAt: string | Date | null;
  readonly latestInboundId: string | null;
  readonly latestInboundTies: string;
  readonly inboundCount: string;
}

function iso(value: string | Date | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

/**
 * Une lecture, quatre faits.
 *
 * Une seule requête plutôt que quatre, et pas pour la performance : entre deux
 * requêtes, un opt-out peut s'écrire. Lire l'exclusion et l'état séparément
 * autoriserait un instant où l'un décrit la ligne d'avant et l'autre celle
 * d'après — le même raisonnement qui a produit `loadOutreachStateRow` (0048).
 */
export async function loadConversationGuards(
  sql: Sql,
  prospectId: string,
  channel: 'instagram_dm' | 'email',
): Promise<ConversationGuards> {
  const rows = await sql.query<GuardRow>(
    `select
       exists (select 1 from do_not_contact d
                where (d.match_kind = 'email'     and p.email is not null
                        and lower(d.value) = lower(p.email))
                   or (d.match_kind = 'phone'     and p.phone is not null
                        and d.value = p.phone)
                   or (d.match_kind = 'domain'    and p.domain is not null
                        and lower(d.value) = lower(p.domain))
                   or (d.match_kind = 'instagram' and p.instagram_handle is not null
                        and lower(d.value) = lower(p.instagram_handle)))   as "suppressed",
       s.state                                                            as "outreachState",
       s.last_reply_received_at                                           as "stateWatermark",
       p.identity_review                                                  as "identityReview",
       (select c.decision from channel_identity_decisions c
         where c.prospect_id = p.id
           and c.transport = $2
           and lower(c.recipient) = lower(case when $2 = 'instagram_dm'
                                               then p.instagram_handle else p.email end)
         order by c.decided_at desc limit 1)                              as "humanChannelDecision",
       -- Le message le plus récent, pris comme UNE ligne — heure ET identité
       -- ensemble. Deux sous-requêtes séparées auraient pu, sur une égalité
       -- d'horodatage, rendre l'heure d'un message et l'identité d'un autre.
       -- C'est ce que ce commentaire affirmait, et ce que le code ne faisait
       -- pas : deux sous-requêtes vivaient ici, tenues d'accord par la seule
       -- recopie de leur ORDER BY. Un lateral les remplace, et l'invariant est
       -- désormais porté par la construction plutôt que par la vigilance.
       -- L'ordre est déterministe jusqu'au bout : received_at d'abord (le
       -- temps métier, règle canonique), id ensuite pour trancher une égalité
       -- sans laisser l'ordre physique décider.
       latest.received_at                                                 as "latestInboundAt",
       latest.id                                                          as "latestInboundId",
       -- Combien de messages partagent cette heure-là. Un « 1 » dit que le plus
       -- récent l'est SANS ambiguïté ; au-delà, c'est l'id — un uuid aléatoire
       -- — qui a désigné le gagnant, et la fraîcheur ne peut plus s'y fier.
       coalesce(ties.n, 0)::text                                          as "latestInboundTies",
       (select count(*) from r6b_inbound_messages i
         where i.correlated_prospect_id = p.id
           and i.correlation_status in ('EXACT', 'HIGH_CONFIDENCE'))::text as "inboundCount"
     from prospects p
     left join r6b_prospect_outreach_states s on s.prospect_id = p.id
     left join lateral (
       select i.received_at, i.id
         from r6b_inbound_messages i
        where i.correlated_prospect_id = p.id
          and i.correlation_status in ('EXACT', 'HIGH_CONFIDENCE')
        order by i.received_at desc, i.id desc
        limit 1
     ) latest on true
     left join lateral (
       select count(*) as n
         from r6b_inbound_messages i
        where i.correlated_prospect_id = p.id
          and i.correlation_status in ('EXACT', 'HIGH_CONFIDENCE')
          and i.received_at = latest.received_at
     ) ties on true
    where p.id = $1`,
    [prospectId, channel],
  );

  const row = rows[0];
  if (row === undefined) {
    // Un prospect introuvable n'est pas « un prospect sans exclusion ». Le côté
    // sûr est de rendre un état qui refuse tout : supprimé, sans identité.
    return Object.freeze({
      prospectId,
      suppressed: true,
      outreachState: null,
      stateWatermark: null,
      identityConfirmed: false,
      identityReview: null,
      latestInboundAt: null,
      latestInboundId: null,
      latestInboundTies: 0,
      inboundCount: 0,
    });
  }

  return Object.freeze({
    prospectId,
    suppressed: row.suppressed,
    outreachState: row.outreachState,
    stateWatermark: iso(row.stateWatermark),
    // Un REFUS humain l'emporte sur tout, y compris sur une provenance
    // automatique « confirmed » : l'autonomie se passe d'une décision humaine
    // ABSENTE, elle n'en renverse jamais une qui a été prise.
    identityConfirmed:
      row.humanChannelDecision !== 'REJECTED' &&
      (row.identityReview === 'confirmed' || row.humanChannelDecision === 'CONFIRMED'),
    identityReview: row.identityReview,
    latestInboundAt: iso(row.latestInboundAt),
    latestInboundId: row.latestInboundId,
    latestInboundTies: Number(row.latestInboundTies),
    inboundCount: Number(row.inboundCount),
  });
}
