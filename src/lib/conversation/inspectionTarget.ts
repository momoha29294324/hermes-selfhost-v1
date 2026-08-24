/**
 * HERMES-REAL-THREAD-PREVIEW-R1 §1/§2 — QUEL fil inspecter, résolu depuis la
 * base et par le MÊME résolveur que l'envoi.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce module refuse d'être
 * ---------------------------------------------------------------------------
 * Il aurait été plus court de laisser la commande d'inspection prendre un
 * identifiant de fil et l'ouvrir. Ce raccourci aurait validé une navigation, et
 * rien du CIBLAGE — c'est-à-dire précisément ce que la mission demande
 * d'éprouver. `resolveReplyTarget` porte quatre concordances
 * (corrélation exploitable, handle de la fiche, fil du message le plus récent,
 * absence de lien vers un autre prospect) et c'est LUI qui doit être exercé
 * contre des données réelles, pas une variante permissive écrite pour un
 * diagnostic.
 *
 * Ce module ne fait donc que traduire trois manières de DÉSIGNER une
 * conversation — un message entrant, un prospect, un fil — en le couple
 * `(prospect, message déclencheur)` que le résolveur de production attend. La
 * décision reste la sienne, refus compris.
 *
 * ---------------------------------------------------------------------------
 * Le message le plus RÉCENT, jamais un autre
 * ---------------------------------------------------------------------------
 * Quand la désignation ne nomme pas un message précis (`--prospect`,
 * `--thread`), le déclencheur retenu est le dernier message corrélé, choisi par
 * le même ordre que `resolveReplyTarget` utilise pour dire quel fil est le fil
 * courant (`received_at desc, id desc`). Deux ordres différents auraient produit
 * un `TARGET_THREAD_AMBIGUOUS` fabriqué par ce module, qui n'aurait rien appris
 * sur les données.
 *
 * ---------------------------------------------------------------------------
 * Lecture seule, et rien d'autre
 * ---------------------------------------------------------------------------
 * Trois `select`. Aucune écriture, aucun plan, aucune décision de politique :
 * ce module ne rend PAS une conversation éligible, et ne lit même pas si elle
 * l'est. Un fil terminalement clos s'inspecte exactement comme un autre — c'est
 * tout l'intérêt, puisque ce sont les seuls vrais fils dont ce dépôt dispose.
 */

import { resolveReplyTarget, type ReplyTarget, type ReplyTargetRefusal } from '@/lib/conversation/replyTarget';
import type { CanonicalAccountIdentity } from '@/lib/instagram/accountIdentity';
import type { Sql } from '@/lib/db/sql';
import { isThreadId } from '@/lib/instagram/replyRail';
import type { ThreadInspectionInput } from '@/lib/instagram/threadInspectionRail';

/** Les trois manières de désigner une conversation, et il n'y en a pas de quatrième. */
export type InspectionSelector =
  | { readonly kind: 'inbound'; readonly inboundMessageId: string }
  | { readonly kind: 'prospect'; readonly prospectId: string }
  | { readonly kind: 'thread'; readonly threadId: string };

export type InspectionTargetRefusal =
  | ReplyTargetRefusal
  /** La désignation ne correspond à aucun message entrant corrélé. */
  | 'INSPECT_NO_CORRELATED_MESSAGE'
  /** L'identifiant de fil donné n'a pas la forme d'un identifiant Instagram. */
  | 'INSPECT_THREAD_ID_MALFORMED';

export interface InspectionTarget {
  readonly selector: InspectionSelector;
  readonly prospectId: string;
  readonly replyTarget: ReplyTarget;
  /** Prêt à être passé au rail : la cible, et la marque de fraîcheur canonique. */
  readonly input: ThreadInspectionInput;
}

export type InspectionTargetResolution =
  | { readonly ok: true; readonly target: InspectionTarget }
  | { readonly ok: false; readonly refusal: InspectionTargetRefusal; readonly detail: string };

interface TriggerRow {
  readonly id: string;
  readonly prospectId: string | null;
}

interface LatestRow {
  readonly receivedAt: string | Date;
  readonly bodyText: string | null;
}

function refuse(refusal: InspectionTargetRefusal, detail: string): InspectionTargetResolution {
  return Object.freeze({ ok: false as const, refusal, detail });
}

/** Le dernier message corrélé — même ordre que celui du résolveur de production. */
const LATEST_TRIGGER = `
  select i.id                     as "id",
         i.correlated_prospect_id as "prospectId"
    from r6b_inbound_messages i
   where i.correlation_status in ('EXACT', 'HIGH_CONFIDENCE')
     and i.correlated_prospect_id is not null`;

export async function resolveInspectionTarget(
  sql: Sql,
  selector: InspectionSelector,
  account: CanonicalAccountIdentity,
): Promise<InspectionTargetResolution> {
  let trigger: TriggerRow | undefined;

  if (selector.kind === 'inbound') {
    const rows = await sql.query<TriggerRow>(
      `select i.id as "id", i.correlated_prospect_id as "prospectId"
         from r6b_inbound_messages i
        where i.id = $1`,
      [selector.inboundMessageId],
    );
    trigger = rows[0];
  } else if (selector.kind === 'prospect') {
    const rows = await sql.query<TriggerRow>(
      `${LATEST_TRIGGER}
     and i.correlated_prospect_id = $1
   order by i.received_at desc, i.id desc
   limit 1`,
      [selector.prospectId],
    );
    trigger = rows[0];
  } else {
    if (!isThreadId(selector.threadId)) {
      return refuse(
        'INSPECT_THREAD_ID_MALFORMED',
        `« ${selector.threadId} » n’a pas la forme d’un identifiant de fil Instagram — un fil se désigne ` +
          'par les chiffres qu’Instagram lui a donnés',
      );
    }
    const rows = await sql.query<TriggerRow>(
      `${LATEST_TRIGGER}
     and i.provider_thread_id = $1
   order by i.received_at desc, i.id desc
   limit 1`,
      [selector.threadId],
    );
    trigger = rows[0];
  }

  if (trigger === undefined) {
    return refuse(
      'INSPECT_NO_CORRELATED_MESSAGE',
      'aucun message entrant corrélé ne correspond à cette désignation — il n’y a pas de fil à inspecter',
    );
  }
  const prospectId = trigger.prospectId;
  if (prospectId === null) {
    return refuse(
      'INSPECT_NO_CORRELATED_MESSAGE',
      `le message ${trigger.id} n’est corrélé à aucun prospect — sans fiche, il n’y a rien à confronter ` +
        'à l’en-tête du fil',
    );
  }

  // La MÊME résolution que celle de l'envoi, refus compris. C'est le point.
  const resolution = await resolveReplyTarget(sql, {
    prospectId,
    triggerInboundMessageId: trigger.id,
    account,
  });
  if (!resolution.ok) return refuse(resolution.refusal, resolution.detail);
  const replyTarget = resolution.target;

  // §9 — la marque de fraîcheur CANONIQUE, et le texte qu'elle porte. Lus ici
  // pour être confrontés à la page, jamais pour être remplacés par elle.
  const latest = await sql.query<LatestRow>(
    `select i.received_at as "receivedAt",
            i.body_text   as "bodyText"
       from r6b_inbound_messages i
      where i.correlated_prospect_id = $1
        and i.correlation_status in ('EXACT', 'HIGH_CONFIDENCE')
      order by i.received_at desc, i.id desc
      limit 1`,
    [prospectId],
  );
  const latestRow = latest[0];

  return Object.freeze({
    ok: true as const,
    target: Object.freeze({
      selector,
      prospectId,
      replyTarget,
      input: Object.freeze({
        target: Object.freeze({
          expectedThreadId: replyTarget.threadId,
          expectedHandle: replyTarget.counterpartyHandle,
          expectedAccountHandle: replyTarget.accountHandle,
        }),
        latestInbound:
          latestRow === undefined
            ? null
            : Object.freeze({
                receivedAt: new Date(latestRow.receivedAt).toISOString(),
                bodyText: latestRow.bodyText,
              }),
      }),
    }),
  });
}
