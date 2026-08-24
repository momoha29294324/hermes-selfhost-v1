/**
 * HERMES-REPLY-DELIVERY-R1 §3 — À QUI et OÙ, résolu depuis la base, jamais
 * depuis une page.
 *
 * ---------------------------------------------------------------------------
 * La question que ce module refuse de poser au navigateur
 * ---------------------------------------------------------------------------
 * « Quel fil dois-je ouvrir ? » ne se répond pas en regardant une boîte de
 * réception. Une liste de conversations se réordonne à chaque message, affiche
 * des NOMS et non des handles, et son premier élément change entre le moment où
 * on la lit et celui où on clique. Un rail qui déciderait là répondrait un jour
 * à quelqu'un d'autre, et ce jour-là rien n'aurait planté.
 *
 * La réponse vit dans une ligne écrite par la relève entrante :
 * `r6b_inbound_messages.provider_thread_id` du message DÉCLENCHEUR. C'est
 * l'identifiant qu'Instagram a lui-même donné au fil où la personne a écrit,
 * observé au moment de la lecture, et immuable ensuite — le rail entrant ne met
 * jamais à jour une ligne déjà écrite (`instagramIntake.ts`).
 *
 * ---------------------------------------------------------------------------
 * Cinq concordances, et aucune n'est facultative
 * ---------------------------------------------------------------------------
 *   0. la boîte qui a LU le message est bien la nôtre — celle d'aujourd'hui, ou
 *      l'un des noms que ce même compte a portés
 *      (`accountIdentity.ts`, HERMES-IDENTITY-CANONICALIZATION-R1 §6). Ce qui
 *      part vers la page est le nom COURANT ; le nom observé est rendu à part et
 *      ne décide de rien ;
 *   1. le message déclencheur appartient bien à CE prospect, et sa corrélation
 *      est exploitable (`EXACT` / `HIGH_CONFIDENCE`) ;
 *   2. l'expéditeur du message est bien le handle Instagram enregistré sur le
 *      prospect. Une divergence signifie que la corrélation et la fiche ne
 *      parlent pas du même compte, et ce n'est pas à ce module de trancher ;
 *   3. le fil du message déclencheur est aussi celui du message le PLUS RÉCENT
 *      de ce prospect. Sinon la marque de fraîcheur et la cible ne parlent plus
 *      du même endroit, et répondre dans l'un pendant que l'autre bouge est
 *      exactement la faute que §5 cherche à empêcher ;
 *   4. aucun lien observé (`ig_inbound_thread_bindings`) ne rattache ce fil à un
 *      AUTRE prospect. Ce lien est la preuve la plus forte du dépôt — une bulle
 *      sortante portant le texte approuvé d'un manifeste verrouillé — et deux
 *      prospects sur un même fil est un état qu'on ne sait pas arbitrer.
 *
 * Toute ambiguïté REFUSE. Il n'existe aucun repli, aucun « le plus probable »,
 * aucun « le plus récent » qui trancherait à la place de personne.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce module ne fait pas
 * ---------------------------------------------------------------------------
 * Il ne lit aucune page, n'ouvre aucun navigateur, n'écrit rien. Il ne juge ni
 * l'exclusion, ni l'état commercial, ni l'identité — ceux-là vivent dans
 * `guards.ts` et sont relus par le crochet pré-effet. Il répond à une seule
 * question, et il y répond par des faits déjà en base.
 */

import type { Sql } from '@/lib/db/sql';
import { isThreadId } from '@/lib/instagram/replyRail';
import {
  isKnownAccountIdentity,
  knownAccountHandles,
  type CanonicalAccountIdentity,
} from '@/lib/instagram/accountIdentity';
import { normalizeHandle } from '@/lib/instagram/identity';

/** Pourquoi la cible n'a pas pu être établie, dans un vocabulaire fermé. */
export type ReplyTargetRefusal =
  /** Le plan ne porte pas de message déclencheur — c'est une relance, pas une réponse. */
  | 'TARGET_NO_TRIGGER'
  /** Le message déclencheur est introuvable. */
  | 'TARGET_TRIGGER_MISSING'
  /** Le message ne vient pas d'Instagram : ce rail ne sait remettre que des DM. */
  | 'TARGET_NOT_INSTAGRAM'
  /** Le message n'est pas corrélé à ce prospect, ou pas de façon exploitable. */
  | 'TARGET_CORRELATION_MISMATCH'
  /** Le message ne porte aucun identifiant de fil — on ne devine pas une URL. */
  | 'TARGET_NO_THREAD_ID'
  /** La fiche prospect ne porte pas de handle Instagram. */
  | 'TARGET_HANDLE_UNKNOWN'
  /** L'expéditeur du message et le handle de la fiche ne concordent pas. */
  | 'TARGET_HANDLE_MISMATCH'
  /** Le message le plus récent de ce prospect vit dans un AUTRE fil. */
  | 'TARGET_THREAD_AMBIGUOUS'
  /** Un lien observé rattache ce fil à un autre prospect. */
  | 'TARGET_THREAD_BOUND_ELSEWHERE'
  /** Le compte émetteur enregistré sur le message est illisible. */
  | 'TARGET_ACCOUNT_UNKNOWN'
  /** Le message a été reçu dans une boîte qui n'est pas la nôtre — ni aujourd'hui, ni avant. */
  | 'TARGET_ACCOUNT_NOT_OURS';

export interface ReplyTarget {
  readonly inboundMessageId: string;
  /** L'identifiant du fil, tel qu'Instagram l'a donné. */
  readonly threadId: string;
  /** Le correspondant, en minuscules. */
  readonly counterpartyHandle: string;
  /**
   * NOTRE compte, tel qu'il s'appelle AUJOURD'HUI — c'est-à-dire ce qui sera
   * confronté à la page. Il vient de la configuration canonique, jamais de la
   * ligne historique : voir `observedAccountHandle`.
   */
  readonly accountHandle: string;
  /**
   * Le nom que NOTRE boîte portait quand ce message a été LU
   * (`r6b_inbound_messages.mailbox`). Un fait d'observation daté, rendu tel
   * quel : il est égal à `accountHandle` tant que personne n'a renommé le
   * compte, et il en diffère après. Il ne décide de rien — il trace.
   */
  readonly observedAccountHandle: string;
  /** L'heure de RÉCEPTION du message déclencheur. */
  readonly receivedAt: string;
  /** L'heure de réception du message le plus récent de ce prospect. */
  readonly latestInboundAt: string;
}

export type ReplyTargetResolution =
  | { readonly ok: true; readonly target: ReplyTarget }
  | { readonly ok: false; readonly refusal: ReplyTargetRefusal; readonly detail: string };

interface TargetRow {
  readonly provider: string;
  readonly mailbox: string;
  readonly threadId: string | null;
  readonly fromAddress: string;
  readonly receivedAt: string | Date;
  readonly correlationStatus: string;
  readonly correlatedProspectId: string | null;
  readonly prospectHandle: string | null;
  readonly latestInboundAt: string | Date | null;
  readonly latestThreadId: string | null;
  readonly foreignBindings: string;
}

function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

function refuse(refusal: ReplyTargetRefusal, detail: string): ReplyTargetResolution {
  return Object.freeze({ ok: false as const, refusal, detail });
}

/**
 * Résout la cible d'une réponse, ou dit pourquoi elle ne l'est pas.
 *
 * UNE requête et non cinq, pour la raison de `loadConversationGuards` : entre
 * deux requêtes, un message peut arriver. Lire le fil du déclencheur et le fil
 * du dernier message séparément autoriserait un instant où l'un décrit l'état
 * d'avant et l'autre celui d'après — c'est-à-dire précisément la concordance
 * qu'on cherche à établir.
 */
export async function resolveReplyTarget(
  sql: Sql,
  input: {
    prospectId: string;
    triggerInboundMessageId: string | null;
    /**
     * §6 — l'identité de NOTRE compte, passée par l'appelant plutôt que lue en
     * base. C'est ce qui sépare « sous quel nom ce message a été lu » (la ligne)
     * de « sous quel nom la session doit être ouverte » (la configuration
     * courante) : ce module ne peut plus confondre les deux, il reçoit les deux.
     */
    account: CanonicalAccountIdentity;
  },
): Promise<ReplyTargetResolution> {
  if (input.triggerInboundMessageId === null) {
    return refuse(
      'TARGET_NO_TRIGGER',
      'ce plan ne porte pas de message déclencheur — une relance n’a pas de fil à rejoindre par ce chemin',
    );
  }

  const rows = await sql.query<TargetRow>(
    `select i.provider                                                   as "provider",
            i.mailbox                                                    as "mailbox",
            i.provider_thread_id                                         as "threadId",
            i.from_address                                               as "fromAddress",
            i.received_at                                                as "receivedAt",
            i.correlation_status                                         as "correlationStatus",
            i.correlated_prospect_id                                     as "correlatedProspectId",
            p.instagram_handle                                           as "prospectHandle",
            latest.received_at                                           as "latestInboundAt",
            latest.provider_thread_id                                     as "latestThreadId",
            (select count(*) from ig_inbound_thread_bindings b
              where b.thread_id = i.provider_thread_id
                and b.prospect_id <> p.id)::text                          as "foreignBindings"
       from r6b_inbound_messages i
       join prospects p on p.id = $2
       -- HERMES-END-TO-END-CERTIFICATION-R1 — UNE ligne, heure ET fil ensemble.
       --
       -- C'etaient deux sous-requetes : un max() pour l'heure, un order by pour
       -- le fil. Sur une egalite de received_at -- que le rail entrant produit
       -- reellement, puisqu'il horodate a l'instant du releve tout message que
       -- la page n'a pas date -- l'identite du fil etait designee par id desc,
       -- c'est-a-dire par un uuid aleatoire. TARGET_THREAD_AMBIGUOUS se
       -- decidait donc a pile ou face : refuser une reponse legitime, ou en
       -- laisser passer une pendant qu'un fil voisin porte un message aussi
       -- recent. Meme correctif que loadConversationGuards.
       left join lateral (
         select x.received_at, x.provider_thread_id
           from r6b_inbound_messages x
          where x.correlated_prospect_id = p.id
            and x.correlation_status in ('EXACT', 'HIGH_CONFIDENCE')
          order by x.received_at desc, x.id desc
          limit 1
       ) latest on true
      where i.id = $1`,
    [input.triggerInboundMessageId, input.prospectId],
  );

  const row = rows[0];
  if (row === undefined) {
    return refuse(
      'TARGET_TRIGGER_MISSING',
      `le message déclencheur ${input.triggerInboundMessageId} est introuvable — il n’y a rien à rejoindre`,
    );
  }

  if (row.provider !== 'instagram') {
    return refuse(
      'TARGET_NOT_INSTAGRAM',
      `le message déclencheur vient de « ${row.provider} » — ce rail ne sait remettre que des DM Instagram`,
    );
  }

  if (row.correlatedProspectId !== input.prospectId) {
    return refuse(
      'TARGET_CORRELATION_MISMATCH',
      `le message déclencheur est corrélé à ${row.correlatedProspectId ?? 'aucun prospect'} et le plan ` +
        `porte ${input.prospectId} — deux lectures qui ne parlent pas du même commerce`,
    );
  }
  if (row.correlationStatus !== 'EXACT' && row.correlationStatus !== 'HIGH_CONFIDENCE') {
    return refuse(
      'TARGET_CORRELATION_MISMATCH',
      `la corrélation du message déclencheur est ${row.correlationStatus} — répondre engagerait un ` +
        'message vers quelqu’un qu’on n’a pas su rattacher',
    );
  }

  const threadId = row.threadId;
  if (threadId === null || !isThreadId(threadId)) {
    return refuse(
      'TARGET_NO_THREAD_ID',
      'le message déclencheur ne porte aucun identifiant de fil exploitable — une URL de conversation ' +
        'ne se devine pas, et « le premier fil de la boîte » n’est pas une cible',
    );
  }

  const observedAccount = normalizeHandle(row.mailbox);
  if (observedAccount === null) {
    return refuse(
      'TARGET_ACCOUNT_UNKNOWN',
      `le compte émetteur inscrit sur le message (« ${row.mailbox} ») n’est pas un handle lisible`,
    );
  }

  // §6 — la boîte qui a lu ce message est-elle la NÔTRE ?
  //
  // Ce n'est pas la même question que « porte-t-elle le nom d'aujourd'hui ? ».
  // Un compte renommé garde ses fils, et les lignes écrites sous l'ancien nom
  // décrivent la même boîte ; une boîte qui n'a jamais été nous est un fil
  // qu'on ne possède pas, et y répondre parlerait depuis un compte qui ne l'a
  // jamais lu. La première passe, la seconde refuse — définitivement, parce
  // qu'aucun réessai ne changera à qui ce message a été adressé.
  if (!isKnownAccountIdentity(input.account, observedAccount)) {
    return refuse(
      'TARGET_ACCOUNT_NOT_OURS',
      `le message a été reçu dans la boîte « ${observedAccount} », qui ne fait pas partie des identités ` +
        `connues de notre compte (${knownAccountHandles(input.account).join(', ')}) — répondre y ferait ` +
        'parler un compte qui n’a jamais lu ce message',
    );
  }

  const prospectHandle = row.prospectHandle === null ? null : normalizeHandle(row.prospectHandle);
  if (prospectHandle === null) {
    return refuse(
      'TARGET_HANDLE_UNKNOWN',
      'la fiche de ce prospect ne porte pas de handle Instagram — il n’y a rien à confronter à l’en-tête ' +
        'du fil, donc rien à confirmer sur place',
    );
  }

  const sender = normalizeHandle(row.fromAddress);
  if (sender === null || sender !== prospectHandle) {
    return refuse(
      'TARGET_HANDLE_MISMATCH',
      `le message vient de « ${row.fromAddress} » et la fiche porte « ${prospectHandle} » — la ` +
        'corrélation et la fiche ne parlent pas du même compte, et ce module n’arbitre pas',
    );
  }

  // §5 — la cible et la marque de fraîcheur doivent parler du même endroit.
  //
  // Un prospect qui écrit depuis deux fils (un DM ordinaire et une demande de
  // message, par exemple) produirait sinon une réponse déposée dans l'un
  // pendant que l'autre porte la dernière phrase. Le côté sûr est de refuser :
  // choisir « le plus récent » ferait répondre à un message dont ce plan n'a
  // jamais été le brouillon.
  if (row.latestThreadId !== threadId) {
    return refuse(
      'TARGET_THREAD_AMBIGUOUS',
      `le message déclencheur vit dans le fil ${threadId} et le message le plus récent de ce prospect ` +
        `dans ${row.latestThreadId ?? 'un fil inconnu'} — répondre dans l’un pendant que l’autre bouge ` +
        'reviendrait à répondre à côté',
    );
  }

  if (Number(row.foreignBindings) > 0) {
    return refuse(
      'TARGET_THREAD_BOUND_ELSEWHERE',
      `${row.foreignBindings} lien(s) observé(s) rattachent le fil ${threadId} à un AUTRE prospect — ` +
        'un fil que deux commerces revendiquent ne s’arbitre pas automatiquement',
    );
  }

  const latest = row.latestInboundAt;
  return Object.freeze({
    ok: true as const,
    target: Object.freeze({
      inboundMessageId: input.triggerInboundMessageId,
      threadId,
      counterpartyHandle: prospectHandle,
      accountHandle: input.account.currentHandle,
      observedAccountHandle: observedAccount,
      receivedAt: iso(row.receivedAt),
      latestInboundAt: latest === null ? iso(row.receivedAt) : iso(latest),
    }),
  });
}
