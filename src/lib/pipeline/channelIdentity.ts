import type { Sql } from '@/lib/db/sql';
import { sha256Hex } from '@/lib/util/hash';
import { INSTAGRAM_HANDLE } from '@/lib/pipeline/r6bTransportAdapters';
import type { Transport } from '@/lib/pipeline/r6bDispatch';

/**
 * IG4.2 — la décision HUMAINE de provenance de canal.
 *
 * Ce module répond à une question, une seule, et il est important de dire
 * laquelle parce qu'il en existe une voisine qu'il ne répond PAS :
 *
 *   ce module répond à     « avons-nous assez de provenance pour considérer que
 *                            ce compte appartient au prospect commercial visé ? »
 *   il ne répond pas à     « l'identité légale de cette entreprise (SIREN,
 *                            SIRET, adresse) a-t-elle été établie ? »
 *
 * La seconde est celle de `prospects.identity_review`, produite par le rail de
 * découverte commerciale (0009). Ce module ne l'écrit jamais, ne la promeut
 * jamais et ne la recalcule jamais : il en conserve seulement une COPIE datée
 * (`automaticIdentityReview`) au moment où l'humain tranche, pour qu'un audit
 * puisse lire les deux affirmations côte à côte sans qu'aucune n'ait effacé
 * l'autre.
 *
 * Append-only, comme `ig_enqueue_decisions` (0039) : aucune fonction d'ici ne
 * met à jour ni ne supprime une ligne. Un changement d'avis s'inscrit en
 * seconde ligne, et la plus récente fait foi.
 */

export type ChannelIdentityDecisionValue = 'CONFIRMED' | 'REJECTED';

export interface ChannelIdentityDecision {
  readonly id: string;
  readonly prospectId: string;
  readonly transport: Transport;
  /** Le destinataire EXACT sur lequel la décision porte, tel qu'il a été saisi. */
  readonly recipient: string;
  readonly decision: ChannelIdentityDecisionValue;
  readonly reason: string;
  readonly reasonSha256: string;
  readonly evidenceUrl: string | null;
  /** `prospects.identity_review` au moment de la décision. Jamais modifié par elle. */
  readonly automaticIdentityReview: string | null;
  readonly decidedBy: string;
  readonly decidedAt: string;
}

export class ChannelIdentityError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ChannelIdentityError';
    this.code = code;
  }
}

const SELECT_COLUMNS = `id, prospect_id as "prospectId", transport, recipient, decision,
                        reason, reason_sha256 as "reasonSha256", evidence_url as "evidenceUrl",
                        automatic_identity_review as "automaticIdentityReview",
                        decided_by as "decidedBy", decided_at as "decidedAt"`;

/**
 * L'ordre qui désigne la décision qui fait foi.
 *
 * `decided_at desc` d'abord — la plus récente gagne, c'est tout le principe
 * d'un journal append-only. Le second critère est le seul point qui mérite une
 * explication : à instant RIGOUREUSEMENT égal (deux commandes concurrentes
 * committées dans la même microseconde), c'est le REFUS qui l'emporte.
 *
 * Ce n'est pas une préférence esthétique. Un départage arbitraire — l'`id`, qui
 * est un uuid aléatoire — rendrait le verdict du gate dépendant d'un tirage,
 * et une chance sur deux d'ouvrir la porte n'est pas un comportement qu'on peut
 * défendre sur un premier contact commercial. `fail-closed` est la règle
 * partout ailleurs dans ce rail (arrêt global sans ligne = armé, ICP non
 * évalué = refusé) ; elle l'est aussi ici.
 */
const EFFECTIVE_ORDER = `order by decided_at desc,
                                  case when decision = 'REJECTED' then 1 else 0 end desc,
                                  id desc`;

export interface ChannelIdentityKey {
  readonly prospectId: string;
  readonly transport: Transport;
  readonly recipient: string;
}

/**
 * La décision qui fait foi pour ce triplet exact, ou `null` si personne n'a
 * jamais décidé.
 *
 * `lower(recipient)` : un handle Instagram est insensible à la casse, et
 * `@Demo_Account_A` désigne le même compte que `@demo_account_a`. C'est
 * déjà la comparaison que fait la porte `opt_out` sur `do_not_contact` — deux
 * graphies du même compte ne sont pas deux comptes. Un handle DIFFÉRENT reste,
 * lui, parfaitement différent : aucune normalisation ne les rapproche.
 */
export async function loadEffectiveChannelIdentityDecision(
  sql: Sql,
  key: ChannelIdentityKey,
): Promise<ChannelIdentityDecision | null> {
  const rows = await sql.query<ChannelIdentityDecision>(
    `select ${SELECT_COLUMNS}
       from channel_identity_decisions
      where prospect_id = $1 and transport = $2 and lower(recipient) = lower($3)
      ${EFFECTIVE_ORDER}
      limit 1`,
    [key.prospectId, key.transport, key.recipient],
  );
  return rows[0] ?? null;
}

/** L'historique complet d'un prospect, tous canaux et tous destinataires — pour l'audit. */
export async function listChannelIdentityDecisions(
  sql: Sql,
  prospectId: string,
): Promise<ChannelIdentityDecision[]> {
  return sql.query<ChannelIdentityDecision>(
    `select ${SELECT_COLUMNS}
       from channel_identity_decisions
      where prospect_id = $1
      order by decided_at desc, id desc`,
    [prospectId],
  );
}

/**
 * Normalise un destinataire Instagram saisi par un humain.
 *
 * Accepte `atelierdemo_`, `@atelierdemo_`, et rien d'autre — ni URL,
 * ni espace, ni casse imposée. La forme retenue est celle que le lock fige
 * (`INSTAGRAM_HANDLE`, partagée avec l'adapter transport), pour qu'une
 * confirmation et un manifeste parlent littéralement du même objet.
 *
 * La casse est CONSERVÉE telle que saisie : c'est la comparaison qui est
 * insensible, pas le stockage. Une décision doit se relire mot pour mot.
 */
export function normalizeInstagramRecipient(raw: string): string {
  const trimmed = raw.trim().replace(/^@/, '');
  if (!INSTAGRAM_HANDLE.test(trimmed)) {
    throw new ChannelIdentityError(
      'RECIPIENT_SHAPE_INVALID',
      `« ${raw} » n'a pas la forme d'un handle Instagram (lettres, chiffres, « . » et « _ », 30 au plus). ` +
        'Attendu : le handle tel qu\'il s\'affiche, sans URL — par exemple « atelierdemo_ ».',
    );
  }
  return trimmed;
}

/** Violation de l'index de rejeu, quel que soit le driver (PGlite et node-postgres parlent tous deux SQLSTATE). */
function isReplayViolation(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  const message = error instanceof Error ? error.message : String(error);
  return (code === '23505' || message.includes('duplicate key')) && message.includes('channel_identity_decisions_replay');
}

export interface RecordChannelIdentityInput {
  readonly prospectId: string;
  readonly transport: Transport;
  readonly recipient: string;
  readonly decision: ChannelIdentityDecisionValue;
  readonly reason: string;
  readonly evidenceUrl?: string | null;
  readonly decidedBy: string;
}

export interface RecordChannelIdentityResult {
  /** La décision qui fait foi APRÈS l'appel — nouvelle ligne, ou celle qui existait déjà. */
  readonly decision: ChannelIdentityDecision;
  /** `false` quand rien n'a été écrit : la décision effective disait déjà la même chose. */
  readonly created: boolean;
  /** Ce que disait la décision effective AVANT l'appel, `null` si personne n'avait décidé. */
  readonly previous: ChannelIdentityDecision | null;
}

/**
 * Inscrit une décision humaine, ou constate qu'elle est déjà inscrite.
 *
 * L'idempotence porte sur l'ÉTAT EFFECTIF, pas sur la ligne : si la décision
 * qui fait foi dit déjà `CONFIRMED` pour ce triplet, une nouvelle demande de
 * `CONFIRMED` ne crée rien et rend `created: false`. C'est ce qui rend la
 * commande opérateur rejouable sans produire un second fait — et l'index
 * unique `channel_identity_decisions_replay_idx` le garantit une seconde fois,
 * au niveau du schéma, pour les chemins que ce module ne verrait pas.
 *
 * Un changement d'avis (CONFIRMED → REJECTED, ou l'inverse) écrit bien une
 * nouvelle ligne : c'est un fait nouveau, daté et signé, et l'ancien reste
 * lisible.
 *
 * Ce que cette fonction ne fait JAMAIS : écrire ailleurs que dans
 * `channel_identity_decisions`. Ni la fiche prospect, ni le manifeste, ni les
 * preuves, ni le journal des contacts, ni la file, ni une autorisation canari,
 * ni l'arrêt global. Elle n'ouvre aucun navigateur et ne touche aucun réseau —
 * et `tests/channelIdentity.test.ts` vérifie qu'aucune de ces tables n'est
 * seulement NOMMÉE dans ce fichier.
 */
export async function recordChannelIdentityDecision(
  sql: Sql,
  input: RecordChannelIdentityInput,
): Promise<RecordChannelIdentityResult> {
  const reason = input.reason.trim();
  if (reason.length === 0) {
    throw new ChannelIdentityError(
      'REASON_REQUIRED',
      'une décision d’identité de canal sans motif est une décision qu’on ne peut pas relire',
    );
  }
  const decidedBy = input.decidedBy.trim();
  if (decidedBy.length === 0) {
    throw new ChannelIdentityError(
      'AUTHOR_REQUIRED',
      'une décision humaine que personne ne signe n’est pas une décision humaine',
    );
  }
  const evidenceUrl = input.evidenceUrl?.trim() ?? null;
  if (evidenceUrl !== null && !/^https?:\/\/\S+$/.test(evidenceUrl)) {
    throw new ChannelIdentityError('EVIDENCE_URL_INVALID', `« ${evidenceUrl} » n'est pas une URL http(s)`);
  }

  return sql.transaction(async (tx) => {
    // Le prospect d'abord : la clé étrangère refuserait de toute façon, mais
    // avec un message que personne ne peut lire. Et c'est ici qu'on relève ce
    // que le rail AUTOMATIQUE disait — sans y toucher.
    const prospects = await tx.query<{ identityReview: string | null }>(
      `select identity_review as "identityReview" from prospects where id = $1`,
      [input.prospectId],
    );
    const prospect = prospects[0];
    if (prospect === undefined) {
      throw new ChannelIdentityError('PROSPECT_NOT_FOUND', `aucun prospect ${input.prospectId}`);
    }

    const previous = await loadEffectiveChannelIdentityDecision(tx, {
      prospectId: input.prospectId,
      transport: input.transport,
      recipient: input.recipient,
    });
    if (previous !== null && previous.decision === input.decision) {
      return { decision: previous, created: false, previous };
    }

    const rows = await tx
      .query<ChannelIdentityDecision>(
        `insert into channel_identity_decisions
         (prospect_id, transport, recipient, decision, reason, reason_sha256, evidence_url,
          automatic_identity_review, decided_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       returning ${SELECT_COLUMNS}`,
        [
          input.prospectId,
          input.transport,
          input.recipient,
          input.decision,
          reason,
          sha256Hex(reason),
          evidenceUrl,
          prospect.identityReview,
          decidedBy,
        ],
      )
      .catch((error: unknown) => {
        // `channel_identity_decisions_replay_idx` — cette décision-là, avec ce
        // motif-là, est déjà inscrite ; l'état effectif dit pourtant autre chose,
        // donc quelqu'un est revenu sur son avis entre-temps. Rejouer la
        // formulation d'avant ne dit rien de neuf sur ce qui a changé : la
        // commande refuse plutôt que d'inscrire une troisième ligne muette.
        if (isReplayViolation(error)) {
          throw new ChannelIdentityError(
            'DECISION_REPLAY',
            `cette décision « ${input.decision} » a déjà été inscrite pour @${input.recipient} avec ce motif exact, ` +
              `et la décision qui fait foi dit aujourd'hui « ${previous?.decision ?? '—'} ». ` +
              'Revenir sur un avis demande un motif qui explique le revirement.',
          );
        }
        throw error;
      });
    const inserted = rows[0];
    if (inserted === undefined) {
      throw new ChannelIdentityError('INSERT_FAILED', 'channel_identity_decisions insert did not return a row');
    }
    return { decision: inserted, created: true, previous };
  });
}
