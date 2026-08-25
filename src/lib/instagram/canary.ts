import type { Sql } from '@/lib/db/sql';
import type { DispatchEnvelope } from '@/lib/pipeline/r6bTransportAdapters';
import type { InstagramAction, InstagramBlockCode } from '@/lib/instagram/types';

/**
 * IG2 §3 — l'autorisation canari : le droit de produire UN effet Instagram, sur
 * UNE cible exacte, pendant UNE fenêtre courte.
 *
 * Ce que ce module existe pour empêcher, en une phrase : que lever l'arrêt
 * global suffise à envoyer.
 *
 * L'arrêt global (`ig_kill_switch`) répond à « le rail a-t-il le droit de
 * travailler ? ». C'est une question de disponibilité, et sa réponse est un
 * booléen partagé par tout le dépôt. Elle ne dit rien de « à QUI », « quel
 * TEXTE », « combien de FOIS » — donc un rail dont c'est la seule garde
 * enverrait, dès qu'il est ouvert, tout ce que la file contient. L'autorisation
 * ci-dessous répond à l'autre question, et elle y répond une fois : elle nomme
 * le manifeste, l'action, le handle, les deux empreintes, son auteur, son
 * échéance, et se consomme atomiquement au moment du clic.
 *
 * Trois propriétés valent d'être dites à voix haute :
 *
 *   1. **Aucun caractère générique.** Il n'existe pas de valeur signifiant
 *      « tous les manifestes » ni « toutes les actions » — la comparaison est
 *      une égalité sur chaque champ, et `max_external_attempts` ne peut valoir
 *      que 1 (contrainte de base, pas convention).
 *   2. **Un redémarrage ne recrée rien.** L'autorisation n'est jamais produite
 *      par le worker, ni par une valeur par défaut, ni par un `insert … on
 *      conflict do nothing` qu'une boucle rejouerait : elle naît d'une commande
 *      humaine nominative, et une fois consommée, elle le reste.
 *   3. **La réservation départage, la consommation dépense.** Depuis IG2.1,
 *      `reserveCanaryAuthorization` est un `update … where state = 'ARMED'` :
 *      deux workers qui l'appellent à la microseconde près obtiennent l'un une
 *      ligne, l'autre rien. Ce n'est pas un verrou posé autour d'une lecture,
 *      c'est la primitive elle-même. `consumeCanaryReservation` vient ensuite,
 *      à l'instant exact où un effet va être tenté — et c'est elle, et elle
 *      seule, qui incrémente le compteur de tentatives.
 *
 *      La distinction n'est pas cosmétique : le 14 août, quatre autorisations
 *      ont été dépensées pour UN effet réel, trois d'entre elles sur des arrêts
 *      survenus avant le moindre octet. Voir 0034 pour le raisonnement complet.
 */

// ---------------------------------------------------------------------------
// Bornes
// ---------------------------------------------------------------------------

/**
 * Durée de vie maximale d'un armement : deux heures.
 *
 * « Courte » ne veut rien dire tant qu'un nombre ne le dit pas. Deux heures
 * laissent le temps d'un aperçu, d'une relecture et d'un envoi surveillé ; au
 * delà, l'humain qui a armé n'est plus forcément devant l'écran, et une
 * autorisation qui traîne est une autorisation que personne ne surveille.
 */
export const MAX_CANARY_TTL_MS = 2 * 60 * 60 * 1000;

/** Défaut proposé par le CLI quand personne ne précise. */
export const DEFAULT_CANARY_TTL_MS = 30 * 60 * 1000;

export type CanaryState = 'ARMED' | 'RESERVED' | 'CONSUMED' | 'EXPIRED' | 'REVOKED';

export interface CanaryAuthorization {
  readonly id: string;
  readonly manifestId: string;
  readonly prospectId: string;
  readonly action: InstagramAction;
  readonly transport: 'instagram_dm';
  readonly expectedHandle: string;
  readonly approvedTextSha256: string;
  readonly transportPayloadSha256: string;
  readonly armedBy: string;
  /**
   * 0047 — QUI a armé, dans un vocabulaire fermé. `armedBy` nomme un humain ou
   * un rail ; c'est ce champ, contraint par la base, qui dit si un humain a
   * relu CE message. Une chaîne peut imiter n'importe quoi ; une valeur
   * contrainte, non.
   */
  readonly armedByKind: 'HUMAN' | 'AUTONOMOUS_POLICY';
  /** La politique qui a tranché, quand c'en est une. `null` pour un humain. */
  readonly policyVersion: string | null;
  readonly reason: string;
  readonly state: CanaryState;
  readonly maxExternalAttempts: number;
  readonly externalAttemptsUsed: number;
  readonly expiresAt: string;
  readonly armedAt: string;
  /** IG2.1 §7 — qui tient la main, depuis quand, pour quel job. Aucune tentative comptée. */
  readonly reservedAt: string | null;
  readonly reservedBy: string | null;
  readonly reservedJobId: string | null;
  readonly consumedAt: string | null;
  readonly consumedBy: string | null;
  readonly consumedJobId: string | null;
  readonly closedAt: string | null;
  readonly closedBy: string | null;
  readonly closedReason: string | null;
}

const CANARY_COLUMNS = `id, manifest_id as "manifestId", prospect_id as "prospectId", action, transport,
        expected_handle as "expectedHandle", approved_text_sha256 as "approvedTextSha256",
        transport_payload_sha256 as "transportPayloadSha256", armed_by as "armedBy",
        armed_by_kind as "armedByKind", policy_version as "policyVersion", reason, state,
        max_external_attempts as "maxExternalAttempts", external_attempts_used as "externalAttemptsUsed",
        expires_at as "expiresAt", armed_at as "armedAt",
        reserved_at as "reservedAt", reserved_by as "reservedBy", reserved_job_id as "reservedJobId",
        consumed_at as "consumedAt",
        consumed_by as "consumedBy", consumed_job_id as "consumedJobId", closed_at as "closedAt",
        closed_by as "closedBy", closed_reason as "closedReason"`;

export class CanaryAuthorizationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CanaryAuthorizationError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

export async function loadCanaryAuthorization(sql: Sql, id: string): Promise<CanaryAuthorization | null> {
  const rows = await sql.query<CanaryAuthorization>(
    `select ${CANARY_COLUMNS} from ig_live_canary_authorizations where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * L'autorisation PERTINENTE d'un manifeste : celle qui est armée s'il y en a
 * une, sinon la plus récente.
 *
 * Un manifeste peut en porter plusieurs depuis 0032 — une par décision
 * d'armement, et l'historique se garde. L'ordre ci-dessous fait que la lecture
 * ne peut pas « rater » une autorisation valide en tombant sur une ancienne, et
 * qu'en l'absence d'armement le refus cite la dernière décision plutôt que la
 * première.
 */
export async function loadCanaryForManifest(sql: Sql, manifestId: string): Promise<CanaryAuthorization | null> {
  const rows = await sql.query<CanaryAuthorization>(
    `select ${CANARY_COLUMNS} from ig_live_canary_authorizations
      where manifest_id = $1
      order by (state in ('ARMED', 'RESERVED')) desc, armed_at desc
      limit 1`,
    [manifestId],
  );
  return rows[0] ?? null;
}

/** Toutes les décisions d'armement prises sur ce manifeste, la plus récente d'abord. */
export async function listCanaryHistory(sql: Sql, manifestId: string): Promise<CanaryAuthorization[]> {
  return sql.query<CanaryAuthorization>(
    `select ${CANARY_COLUMNS} from ig_live_canary_authorizations
      where manifest_id = $1 order by armed_at desc`,
    [manifestId],
  );
}

export async function listCanaryAuthorizations(sql: Sql, limit = 20): Promise<CanaryAuthorization[]> {
  return sql.query<CanaryAuthorization>(
    `select ${CANARY_COLUMNS} from ig_live_canary_authorizations order by armed_at desc limit $1`,
    [limit],
  );
}

/**
 * Bascule en `EXPIRED` toute autorisation armée dont l'échéance est passée.
 *
 * Appelée avant chaque lecture décisive plutôt que par un travail périodique :
 * une expiration qui dépendrait d'un cron laisserait, entre deux passages, des
 * lignes qui se disent `ARMED` alors qu'elles ne le sont plus. La garde qui
 * compte reste de toute façon dans la consommation (`expires_at > now()`), qui
 * ne fait confiance à aucun statut recopié.
 */
export async function expireStaleCanaryAuthorizations(sql: Sql): Promise<number> {
  const rows = await sql.query<{ id: string }>(
    `update ig_live_canary_authorizations
        set state = 'EXPIRED', closed_at = now(), closed_by = 'system/expiry',
            closed_reason = case
              when state = 'RESERVED'
                then 'échéance dépassée alors qu''un worker tenait la réservation — aucun effet tenté'
              else 'échéance dépassée sans consommation'
            end
      where state in ('ARMED', 'RESERVED') and expires_at <= now()
      returning id`,
  );
  return rows.length;
}

// ---------------------------------------------------------------------------
// Armement
// ---------------------------------------------------------------------------

export interface ArmCanaryInput {
  /** L'enveloppe RELUE du manifeste verrouillé. Aucune valeur ne vient de l'appelant. */
  readonly envelope: DispatchEnvelope;
  readonly action: InstagramAction;
  readonly armedBy: string;
  /**
   * 0047 — par défaut `HUMAN`, ce qui préserve mot pour mot le comportement de
   * `ig:canary` : un appelant qui ne dit rien arme une autorisation humaine,
   * exactement comme avant. Seul le rail autonome passe `AUTONOMOUS_POLICY`,
   * et il doit alors nommer sa politique — la base refuse l'un sans l'autre.
   */
  readonly armedByKind?: 'HUMAN' | 'AUTONOMOUS_POLICY';
  readonly policyVersion?: string | null;
  readonly reason: string;
  readonly ttlMs: number;
}

/**
 * Arme le canari, ou refuse.
 *
 * Toutes les valeurs d'identité proviennent de l'enveloppe — c'est-à-dire du
 * manifeste relu et revalidé par `resolveDispatchTarget`. Le CLI ne peut donc
 * pas armer un handle qu'il aurait tapé lui-même : ce qu'il fournit (`--handle`)
 * sert uniquement à CONFIRMER, et le désaccord refuse.
 */
export async function armCanaryAuthorization(sql: Sql, input: ArmCanaryInput): Promise<CanaryAuthorization> {
  const armedBy = input.armedBy.trim();
  const reason = input.reason.trim();
  if (armedBy.length === 0) {
    throw new CanaryAuthorizationError(
      'IG_CANARY_NO_OPERATOR',
      'armement refusé : --as est obligatoire — un envoi réel s’autorise au nom de quelqu’un',
    );
  }
  if (reason.length === 0) {
    throw new CanaryAuthorizationError('IG_CANARY_NO_REASON', 'armement refusé : une raison est obligatoire');
  }
  if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0 || input.ttlMs > MAX_CANARY_TTL_MS) {
    throw new CanaryAuthorizationError(
      'IG_CANARY_TTL_INVALID',
      `armement refusé : durée de vie ${input.ttlMs} ms hors bornes (0 < ttl ≤ ${MAX_CANARY_TTL_MS} ms)`,
    );
  }
  if (input.envelope.transport !== 'instagram_dm') {
    throw new CanaryAuthorizationError(
      'IG_TRANSPORT_NOT_INSTAGRAM',
      `armement refusé : le manifeste ${input.envelope.manifestId} porte le transport « ${input.envelope.transport} »`,
    );
  }

  await expireStaleCanaryAuthorizations(sql);

  // IG2 §4 / 0032 — la règle qui interdit vraiment de réarmer, et la seule :
  // un effet externe a-t-il déjà été tenté sur ce manifeste ?
  //
  // Elle porte sur le FAIT (le drapeau du job, posé avant le clic et jamais
  // retiré), pas sur l'existence d'une autorisation antérieure. Une
  // autorisation dépensée sans qu'un octet parte n'a rien produit ; celle qui a
  // précédé un clic, elle, ferme la porte définitivement — même si le clic n'a
  // rien prouvé, et surtout dans ce cas.
  const effect = await sql.query<{ id: string; startedAt: string | null }>(
    `select id, external_effect_started_at as "startedAt"
       from ig_dispatch_jobs
      where manifest_id = $1 and external_effect_attempted = true`,
    [input.envelope.manifestId],
  );
  const already = effect[0];
  if (already) {
    throw new CanaryAuthorizationError(
      'IG_CANARY_EFFECT_ALREADY_ATTEMPTED',
      `armement refusé : le job ${already.id} a déjà tenté un effet externe ` +
        `(${already.startedAt ?? 'date inconnue'}). Aucun rejeu, quelle qu'en ait été l'issue — ` +
        'un second armement serait un second message.',
    );
  }

  const armedByKind = input.armedByKind ?? 'HUMAN';
  const policyVersion = armedByKind === 'AUTONOMOUS_POLICY' ? (input.policyVersion ?? '').trim() : '';
  if (armedByKind === 'AUTONOMOUS_POLICY' && policyVersion.length === 0) {
    throw new CanaryAuthorizationError(
      'IG_CANARY_NO_POLICY_VERSION',
      'armement refusé : une autorisation machine doit nommer la politique qui l’a décidée — ' +
        'une décision qu’on ne peut pas rejouer n’est pas auditable',
    );
  }

  const rows = await sql.query<CanaryAuthorization>(
    `insert into ig_live_canary_authorizations
       (manifest_id, prospect_id, action, transport, expected_handle,
        approved_text_sha256, transport_payload_sha256, armed_by, armed_by_kind, policy_version,
        reason, state, expires_at)
     values ($1,$2,$3,'instagram_dm',$4,$5,$6,$7,$8,$9,$10,'ARMED',
             now() + ($11::bigint * interval '1 millisecond'))
     returning ${CANARY_COLUMNS}`,
    [
      input.envelope.manifestId,
      input.envelope.prospectId,
      input.action,
      input.envelope.recipient,
      input.envelope.approvedTextSha256,
      input.envelope.transportPayloadSha256,
      armedBy,
      armedByKind,
      policyVersion.length === 0 ? null : policyVersion,
      reason,
      String(Math.round(input.ttlMs)),
    ],
  ).catch((error: unknown) => {
    // L'index unique partiel (une seule ARMED) et l'unicité par manifeste sont
    // les deux refus attendus. Les distinguer par leur message serait fragile ;
    // les nommer ensemble dit la vérité utile : une autorisation existe déjà.
    if (isUniqueViolation(error)) {
      throw new CanaryAuthorizationError(
        'IG_CANARY_ALREADY_EXISTS',
        'armement refusé : une autorisation existe déjà (une seule peut être armée à la fois, ' +
          'et un manifeste n’en porte qu’une pour toute son histoire). ' +
          'La révoquer explicitement avant d’en ouvrir une autre.',
      );
    }
    throw error;
  });

  const created = rows[0];
  if (!created) throw new Error('ig_live_canary_authorizations insert did not return a row');
  return created;
}

function isUniqueViolation(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  if ((error as { code?: unknown }).code === '23505') return true;
  const message = error instanceof Error ? error.message : '';
  return /duplicate key value|unique constraint/i.test(message);
}

// ---------------------------------------------------------------------------
// Révocation
// ---------------------------------------------------------------------------

export async function revokeCanaryAuthorization(
  sql: Sql,
  input: { id: string; revokedBy: string; reason: string },
): Promise<CanaryAuthorization | null> {
  const revokedBy = input.revokedBy.trim();
  if (revokedBy.length === 0) {
    throw new CanaryAuthorizationError('IG_CANARY_NO_OPERATOR', 'révocation refusée : --as est obligatoire');
  }
  const rows = await sql.query<CanaryAuthorization>(
    `update ig_live_canary_authorizations
        set state = 'REVOKED', closed_at = now(), closed_by = $2, closed_reason = $3
      where id = $1 and state = 'ARMED'
      returning ${CANARY_COLUMNS}`,
    [input.id, revokedBy, input.reason.slice(0, 500)],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Vérification — pure, sans I/O
// ---------------------------------------------------------------------------

export interface CanaryCheckInput {
  readonly authorization: CanaryAuthorization | null;
  readonly manifestId: string;
  readonly action: InstagramAction;
  readonly expectedHandle: string;
  readonly approvedTextSha256: string;
  readonly transportPayloadSha256: string;
  readonly now: number;
}

export type CanaryVerdict =
  | { readonly ok: true; readonly authorization: CanaryAuthorization }
  | { readonly ok: false; readonly code: InstagramBlockCode; readonly reason: string };

/**
 * Confronte une autorisation à la cible réellement sur le point d'être touchée.
 *
 * Pure et sans horloge implicite (`now` est fourni) : chaque cas de refus est
 * donc exerçable par un test, y compris ceux qu'une base réelle mettrait deux
 * heures à produire.
 *
 * L'ordre des vérifications va du plus structurel au plus précis, et chaque
 * refus nomme ce qui ne va pas — « autorisation invalide » ne dirait pas si le
 * problème est une expiration (réarmer suffirait) ou une dérive de payload (le
 * message n'est plus celui qu'on a relu).
 */
/**
 * Cette autorisation morte peut-elle être REMPLACÉE par une neuve ?
 *
 * Le défaut qu'elle répare, mesuré le 25 août 2026 : le rail autonome n'armait
 * une autorisation que lorsqu'il n'en existait AUCUNE pour le manifeste
 * (`existing === null`), et il révoque la sienne à la fin de chaque processus
 * — « une autorisation d'effet ne survit pas au processus qui l'a armée ».
 * Toute exécution qui armait sans consommer laissait donc une ligne `REVOKED`
 * que rien ne remplaçait jamais, et le manifeste devenait définitivement
 * inenvoyable. `--preview` fait exactement cela par construction : il arme,
 * il ne clique pas, il révoque en sortant. Prévisualiser un manifeste le
 * détruisait.
 *
 * La ligne qui compte est la troisième, et elle est une SÛRETÉ, pas une
 * commodité : une autorisation CONSUMED n'est jamais remplaçable. Un effet a
 * eu lieu, et réarmer reviendrait à autoriser un second message vers un
 * prospect dont l'unique autorisation est déjà dépensée. `EXPIRED` et
 * `REVOKED` ne disent rien de tel — elles disent qu'une fenêtre s'est
 * refermée sans que personne ne soit joint.
 *
 * Fail-closed sur le compteur : le moindre essai déjà consommé, ou un compteur
 * illisible, referme. Ne pas savoir n'est pas une permission.
 */
export function isReplaceableCanaryAuthorization(auth: CanaryAuthorization): boolean {
  if (auth.state !== 'REVOKED' && auth.state !== 'EXPIRED') return false;
  if (auth.consumedAt !== null) return false;
  if (!Number.isInteger(auth.externalAttemptsUsed)) return false;
  return auth.externalAttemptsUsed === 0;
}

export function checkCanaryAuthorization(input: CanaryCheckInput): CanaryVerdict {
  const auth = input.authorization;
  if (auth === null) {
    return {
      ok: false,
      code: 'IG_CANARY_NOT_ARMED',
      reason:
        `aucune autorisation canari pour le manifeste ${input.manifestId} — ` +
        'lever l’arrêt global ne suffit pas à envoyer',
    };
  }

  if (auth.state === 'REVOKED') {
    return {
      ok: false,
      code: 'IG_CANARY_REVOKED',
      reason: `autorisation ${auth.id} révoquée par ${auth.closedBy ?? 'inconnu'} : ${auth.closedReason ?? 'sans motif'}`,
    };
  }
  if (auth.state === 'CONSUMED') {
    return {
      ok: false,
      code: 'IG_CANARY_CONSUMED',
      reason:
        `autorisation ${auth.id} déjà consommée le ${auth.consumedAt ?? 'à une date inconnue'} ` +
        `par ${auth.consumedBy ?? 'inconnu'} — une autorisation d’un seul effet ne se rejoue pas`,
    };
  }
  if (auth.state === 'EXPIRED') {
    return { ok: false, code: 'IG_CANARY_EXPIRED', reason: `autorisation ${auth.id} expirée le ${auth.expiresAt}` };
  }
  if (auth.state === 'RESERVED') {
    // IG2.1 §7 — quelqu'un tient déjà la main. Rien n'a encore été tenté, mais
    // ce n'est pas une raison d'entrer : deux workers sur la même autorisation,
    // c'est exactement la situation que la réservation existe pour interdire.
    return {
      ok: false,
      code: 'IG_CANARY_RESERVED_ELSEWHERE',
      reason:
        `autorisation ${auth.id} réservée depuis le ${auth.reservedAt ?? 'à une date inconnue'} ` +
        `par ${auth.reservedBy ?? 'inconnu'} — un seul worker à la fois, même avant tout effet`,
    };
  }
  if (auth.state !== 'ARMED') {
    return { ok: false, code: 'IG_CANARY_NOT_ARMED', reason: `autorisation ${auth.id} à l’état « ${auth.state} »` };
  }

  // Relu ici en plus du statut : une ligne peut se dire `ARMED` alors que son
  // échéance est passée, tant que personne n'a fait tourner l'expiration.
  const expiresAt = Date.parse(auth.expiresAt);
  if (!Number.isFinite(expiresAt) || input.now >= expiresAt) {
    return {
      ok: false,
      code: 'IG_CANARY_EXPIRED',
      reason: `autorisation ${auth.id} échue (${auth.expiresAt}) — une fenêtre courte n’est pas une fenêtre ouverte`,
    };
  }

  if (auth.externalAttemptsUsed >= auth.maxExternalAttempts) {
    return {
      ok: false,
      code: 'IG_CANARY_CONSUMED',
      reason: `autorisation ${auth.id} : ${auth.externalAttemptsUsed}/${auth.maxExternalAttempts} tentative(s) déjà comptée(s)`,
    };
  }

  if (auth.manifestId !== input.manifestId) {
    return {
      ok: false,
      code: 'IG_CANARY_MANIFEST_MISMATCH',
      reason: `autorisation ${auth.id} porte le manifeste ${auth.manifestId}, demandé ${input.manifestId}`,
    };
  }
  if (auth.action !== input.action) {
    return {
      ok: false,
      code: 'IG_CANARY_ACTION_MISMATCH',
      reason: `autorisation ${auth.id} porte l’action « ${auth.action} », demandée « ${input.action} »`,
    };
  }
  if (auth.expectedHandle.toLowerCase() !== input.expectedHandle.toLowerCase()) {
    return {
      ok: false,
      code: 'IG_CANARY_HANDLE_MISMATCH',
      reason: `autorisation ${auth.id} porte « ${auth.expectedHandle} », cible « ${input.expectedHandle} »`,
    };
  }
  if (auth.approvedTextSha256 !== input.approvedTextSha256) {
    return {
      ok: false,
      code: 'IG_CANARY_PAYLOAD_DRIFT',
      reason:
        `empreinte du texte approuvé changée depuis l’armement ` +
        `(${auth.approvedTextSha256.slice(0, 12)}… vs ${input.approvedTextSha256.slice(0, 12)}…) — ` +
        'le message autorisé n’est plus celui qui partirait',
    };
  }
  if (auth.transportPayloadSha256 !== input.transportPayloadSha256) {
    return {
      ok: false,
      code: 'IG_CANARY_PAYLOAD_DRIFT',
      reason:
        `empreinte du payload transport changée depuis l’armement ` +
        `(${auth.transportPayloadSha256.slice(0, 12)}… vs ${input.transportPayloadSha256.slice(0, 12)}…)`,
    };
  }

  return { ok: true, authorization: auth };
}

// ---------------------------------------------------------------------------
// IG2.1 §7 — réservation, consommation, relâchement
// ---------------------------------------------------------------------------
//
// Trois instructions, trois moments, et une frontière qui n'est pas une
// convention d'appelant mais le `where` de chacune :
//
//   * RÉSERVER dit « ce worker a la main ». Elle ne compte aucune tentative ;
//   * CONSOMMER dit « un effet va être tenté MAINTENANT ». C'est là, et
//     seulement là, que le compteur passe à 1 ;
//   * RELÂCHER rend la main, et ne peut le faire qu'AVANT toute consommation —
//     après, l'état n'est plus `RESERVED` et l'instruction ne trouve rien.
//
// Ce que cela corrige : le 14 août, quatre autorisations ont été dépensées pour
// un seul effet réel, trois d'entre elles sur des arrêts survenus avant le
// moindre octet. Le compteur d'effets externes comptait des renoncements.

export interface ReserveCanaryInput {
  readonly authorizationId: string;
  readonly jobId: string;
  readonly workerId: string;
  /** Rappelés dans le `where` : la ligne doit encore porter exactement cette cible. */
  readonly manifestId: string;
  readonly expectedHandle: string;
  readonly approvedTextSha256: string;
  readonly transportPayloadSha256: string;
}

/**
 * Prend la main sur l'autorisation, ou rend `null`.
 *
 * Tout ce que `checkCanaryAuthorization` a vérifié est REVÉRIFIÉ ici, dans le
 * `where` — non par méfiance envers la fonction pure, mais parce que la lecture
 * qui l'a nourrie appartient au passé. Entre elle et ce moment, un autre worker
 * a pu réserver, un humain a pu révoquer, l'échéance a pu tomber.
 *
 * `null` veut dire « quelqu'un d'autre a la main, ou plus personne ne l'a ».
 * L'appelant ne doit alors RIEN tenter — surtout pas réessayer.
 */
export async function reserveCanaryAuthorization(
  sql: Sql,
  input: ReserveCanaryInput,
): Promise<CanaryAuthorization | null> {
  const rows = await sql.query<CanaryAuthorization>(
    `update ig_live_canary_authorizations
        set state = 'RESERVED',
            reserved_at = now(),
            reserved_by = $3,
            reserved_job_id = $2
      where id = $1
        and state = 'ARMED'
        and expires_at > now()
        and external_attempts_used < max_external_attempts
        and manifest_id = $4
        and lower(expected_handle) = lower($5)
        and approved_text_sha256 = $6
        and transport_payload_sha256 = $7
      returning ${CANARY_COLUMNS}`,
    [
      input.authorizationId,
      input.jobId,
      input.workerId,
      input.manifestId,
      input.expectedHandle,
      input.approvedTextSha256,
      input.transportPayloadSha256,
    ],
  );
  return rows[0] ?? null;
}

/**
 * Consomme la réservation — l'instant irréversible.
 *
 * Appelée dans la MÊME séquence que `markExternalEffectAttempted`, et avant
 * elle : un processus tué entre les deux laisse une autorisation dépensée sur
 * un job qui n'a rien tenté, ce qui est prudent. L'inverse — un job marqué sous
 * une autorisation encore réservée — laisserait croire qu'il reste un droit à
 * dépenser.
 *
 * Le `where` exige la réservation de CE worker sur CE job : un worker dont la
 * réservation a été expirée puis reprise ne peut plus consommer, donc ne
 * clique pas.
 */
export async function consumeCanaryReservation(
  sql: Sql,
  input: { authorizationId: string; jobId: string; workerId: string },
): Promise<CanaryAuthorization | null> {
  const rows = await sql.query<CanaryAuthorization>(
    `update ig_live_canary_authorizations
        set state = 'CONSUMED',
            external_attempts_used = external_attempts_used + 1,
            consumed_at = now(),
            consumed_by = $3,
            consumed_job_id = $2
      where id = $1
        and state = 'RESERVED'
        and reserved_by = $3
        and reserved_job_id = $2
        and expires_at > now()
        and external_attempts_used < max_external_attempts
      returning ${CANARY_COLUMNS}`,
    [input.authorizationId, input.jobId, input.workerId],
  );
  return rows[0] ?? null;
}

/**
 * Rend la main, sans avoir rien tenté.
 *
 * Le `where state = 'RESERVED'` est ce qui rend l'opération sûre : une
 * autorisation déjà consommée porte `CONSUMED` et n'est donc pas trouvée. Il
 * n'existe aucun chemin, même écrit par erreur, où un relâchement rouvrirait le
 * droit d'envoyer après un clic.
 *
 * Ce que le relâchement ne fait PAS : rouvrir indéfiniment la porte. Trois
 * gardes le bornent, et aucune ne bouge — l'échéance courte de l'armement,
 * l'unicité de l'autorisation vivante, et la révocation systématique en fin de
 * commande (`ig:live`, bloc `finally`). Reprendre après un refus pré-effet
 * coûte donc toujours une décision d'humain ; ce qui change est que le refus ne
 * ment plus dans le compteur.
 */
export async function releaseCanaryReservation(
  sql: Sql,
  input: { authorizationId: string; jobId: string; workerId: string },
): Promise<CanaryAuthorization | null> {
  const rows = await sql.query<CanaryAuthorization>(
    `update ig_live_canary_authorizations
        set state = 'ARMED',
            reserved_at = null,
            reserved_by = null,
            reserved_job_id = null
      where id = $1
        and state = 'RESERVED'
        and reserved_by = $3
        and reserved_job_id = $2
      returning ${CANARY_COLUMNS}`,
    [input.authorizationId, input.jobId, input.workerId],
  );
  return rows[0] ?? null;
}
