/**
 * HERMES-MULTI-TURN-BURSTS-R1 — les bulles LUES à l'intérieur d'un tour
 * logique, et donc non raisonnées séparément.
 *
 * ---------------------------------------------------------------------------
 * Le fait que ce module écrit
 * ---------------------------------------------------------------------------
 * Un humain sur Instagram écrit « ouais », puis « j'avais essayé », puis
 * « mais ça marchait pas ». Trois lignes en base, une seule phrase. Le dépôt
 * savait les GROUPER pour décider QUAND répondre depuis
 * HERMES-CONVERSATION-R2 ; il ne savait pas les grouper pour décider SUR QUOI
 * raisonner, et chaque bulle recevait donc son propre appel de modèle.
 *
 * Une seule bulle par salve est désormais raisonnée : la DERNIÈRE, dont le
 * tour logique porte le texte de toutes celles qui la précèdent dans la même
 * prise de parole. Les autres sont ABSORBÉES.
 *
 * « Absorbée » veut dire : LUE, à l'intérieur du tour qui se termine par
 * `burstClosingMessageId`. Ce n'est ni « ignorée », ni « supprimée » — la ligne
 * `r6b_inbound_messages` reste intacte, et le tour logique reste
 * reconstructible bulle par bulle.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi c'est ÉCRIT, et pas seulement décidé à la volée
 * ---------------------------------------------------------------------------
 * `loadUnprocessedCorrelatedInbound` sélectionne les messages sans analyse
 * ACTIVE, `order by received_at asc limit 50`. Une bulle absorbée n'a pas
 * d'analyse : sans trace, elle reviendrait à chaque tour, et au bout de
 * cinquante absorptions les PLUS ANCIENNES rempliraient la fenêtre et
 * affameraient les messages neufs. Le rail cesserait de répondre, sans que
 * rien ne le dise.
 *
 * L'autre voie — écrire une analyse « déterministe » pour la bulle absorbée —
 * est refusée : une analyse porte une catégorie, une catégorie est une
 * affirmation sur ce que la personne a voulu dire, et l'affirmer d'un fragment
 * que personne n'a lu séparément serait inventer une donnée. Une absorption
 * n'affirme rien ; elle dit où la lecture a eu lieu.
 */
import { CONVERSATION_POLICY_VERSION } from '@/lib/conversation/autonomy';
import type { Sql } from '@/lib/db/sql';

/**
 * Un message qui n'est pas raisonné pour lui-même, parce qu'il est une bulle
 * intermédiaire d'une prise de parole que sa dernière bulle porte entière.
 *
 * Ce n'est PAS un échec, et le vocabulaire compte : rien n'a manqué, rien n'est
 * perdu, et le texte de cette bulle EST entré dans le raisonnement du tour qui
 * la clôt.
 */
export class AbsorbedIntoBurst extends Error {
  readonly code = 'ABSORBED_INTO_BURST' as const;
  readonly inboundMessageId: string;
  readonly burstClosingMessageId: string;
  readonly burstMessageCount: number;

  constructor(inboundMessageId: string, burstClosingMessageId: string, burstMessageCount: number) {
    super(
      `le message ${inboundMessageId} est une bulle intermédiaire d'une prise de parole de ` +
        `${String(burstMessageCount)} messages — son texte est lu dans le tour qui se termine par ` +
        `${burstClosingMessageId}, et c'est ce tour-là qui est raisonné`,
    );
    this.name = 'AbsorbedIntoBurst';
    this.inboundMessageId = inboundMessageId;
    this.burstClosingMessageId = burstClosingMessageId;
    this.burstMessageCount = burstMessageCount;
  }
}

export interface BurstAbsorptionInput {
  readonly inboundMessageId: string;
  readonly burstClosingMessageId: string;
  readonly prospectId: string;
  readonly burstMessageCount: number;
}

/**
 * Inscrit l'absorption. Idempotent : `on conflict do nothing` sur l'unicité de
 * la bulle, si bien qu'un rejeu retombe sur la ligne existante plutôt que d'en
 * écrire une seconde.
 *
 * Rend vrai quand la ligne vient d'être écrite — utile à un rapport, jamais à
 * une décision.
 */
export async function recordBurstAbsorption(
  sql: Sql,
  input: BurstAbsorptionInput,
): Promise<boolean> {
  const rows = await sql.query<{ id: string }>(
    `insert into r6b_inbound_burst_absorptions
       (inbound_message_id, burst_closing_message_id, prospect_id, burst_message_count, policy_version)
     values ($1, $2, $3, $4, $5)
     on conflict (inbound_message_id) do nothing
     returning id`,
    [
      input.inboundMessageId,
      input.burstClosingMessageId,
      input.prospectId,
      input.burstMessageCount,
      CONVERSATION_POLICY_VERSION,
    ],
  );
  return rows.length > 0;
}
