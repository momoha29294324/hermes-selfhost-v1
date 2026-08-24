import type { Sql } from '@/lib/db/sql';
import { sha256Hex } from '@/lib/util/hash';
import { normalizeHandle } from '@/lib/instagram/identity';
import type { InstagramRelationshipObservation } from '@/lib/instagram/relationship';
import type {
  GateRecord,
  InstagramBlockCode,
  InstagramFailureCode,
  InstagramIdentitySignal,
  InstagramIdentityVerdict,
  InstagramSessionState,
} from '@/lib/instagram/types';

/**
 * IG2.2 — l'intention de test contrôlé, séparée de tout outreach commercial.
 *
 * Ce module est au test technique ce que `canary.ts` est au canari commercial :
 * le droit de produire UN effet Instagram, sur UNE cible exacte, pendant UNE
 * fenêtre courte. Il en reprend la mécanique mot pour mot — réserver départage,
 * consommer dépense, relâcher rend la main avant tout effet — parce que cette
 * mécanique a été corrigée au prix de trois autorisations dépensées pour rien le
 * 14 août, et qu'un second rail qui la réinventerait la réinventerait mal.
 *
 * Ce qu'il ne partage PAS avec le canari commercial, et pourquoi :
 *
 *   1. **Aucun manifeste, aucun prospect.** Il n'y a pas de champ pour en
 *      nommer un. Un test ne peut donc pas se rattacher à une intention
 *      commerciale, et aucun KPI ne peut le compter — non par filtrage, par
 *      absence de colonne (voir 0035).
 *   2. **Aucun paramètre de texte.** `armControlledTest` ne prend pas de
 *      message : il n'existe qu'un texte, gelé ici, dont l'empreinte est
 *      contrainte en base. Un appelant ne peut pas faire porter un message
 *      commercial à ce rail, parce qu'il n'a rien où l'écrire.
 *   3. **Une fenêtre plus courte.** Quinze minutes au maximum, contre deux
 *      heures pour le canari. Un test se décide et se fait dans la foulée ;
 *      une autorisation de test qui traîne une heure est une autorisation que
 *      personne ne surveille.
 */

// ---------------------------------------------------------------------------
// Le texte, et le fait qu'il n'est pas un réglage
// ---------------------------------------------------------------------------

/**
 * Le seul message que ce rail sait porter.
 *
 * Trois propriétés le rendent utilisable sans mentir à personne : il se
 * présente comme un test, il n'attend rien du destinataire, et il ne contient
 * aucune affirmation commerciale — donc aucune preuve chiffrée, aucun chiffre,
 * aucun lien, aucune offre (CLAUDE.md, interdits n°2 et n°3).
 *
 * Il ne comporte pas de saut de ligne, et ce n'est pas un hasard : dans le
 * composeur d'Instagram, « Entrée » envoie. La primitive refuse d'ailleurs tout
 * texte qui en contiendrait un, avant la moindre saisie.
 */
export const CONTROLLED_TEST_PAYLOAD = 'Test technique Hermes — aucun suivi nécessaire.';

/**
 * L'empreinte du texte ci-dessus, calculée au chargement du module.
 *
 * La même valeur est écrite en dur dans la contrainte `payload_sha256` de 0035.
 * La redondance est le sujet : si quelqu'un modifie la constante ci-dessus sans
 * migrer, la base refuse l'armement au lieu de laisser partir un autre message.
 * Un test l'exerce explicitement.
 */
export const CONTROLLED_TEST_PAYLOAD_SHA256 = sha256Hex(CONTROLLED_TEST_PAYLOAD);

export const CONTROLLED_TEST_ACTION = 'controlled_test_dm';
export const CONTROLLED_TEST_TRANSPORT = 'instagram_dm';

/** Quinze minutes. Voir l'en-tête : un test se surveille, il ne s'oublie pas. */
export const MAX_CONTROLLED_TEST_TTL_MS = 15 * 60 * 1000;
/** Défaut proposé par le CLI quand personne ne précise. */
export const DEFAULT_CONTROLLED_TEST_TTL_MS = 10 * 60 * 1000;

/**
 * La clé d'idempotence d'un test : déterministe, sans horodatage ni aléa.
 *
 * Elle nomme le rail, l'action, la cible et le texte. C'est elle que porte
 * l'index unique partiel de 0035 (`… where external_effect_attempted = true`),
 * qui rend impossible, pour toujours, un second effet sur la même intention —
 * y compris après un redémarrage, une reprise, ou un second armement consécutif
 * à un refus.
 */
export function deriveControlledTestIdempotencyKey(handle: string): string {
  return `ig-ct/${CONTROLLED_TEST_ACTION}/${handle}/${CONTROLLED_TEST_PAYLOAD_SHA256.slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// Vocabulaire des refus
// ---------------------------------------------------------------------------

/**
 * Ce que le rail de test sait refuser EN PROPRE.
 *
 * Les motifs de session, d'identité, de plafond et de renoncement de la
 * primitive ne sont pas redéclarés : le worker relaie tel quel le
 * `InstagramBlockCode` déjà défini pour le rail commercial. Deux tables de
 * codes seraient deux vocabulaires, et l'un des deux finirait par mentir.
 */
export type ControlledTestOwnCode =
  /** Le worker a reçu un mode qu'il ne sait pas exécuter. */
  | 'IG_CT_MODE_REQUIRED'
  /** Un envoi a été demandé avec un rail sans primitive : il n'y a rien à appeler. */
  | 'IG_CT_ADAPTER_MISSING'
  | 'IG_CT_NOT_ARMED'
  | 'IG_CT_EXPIRED'
  | 'IG_CT_CONSUMED'
  | 'IG_CT_REVOKED'
  | 'IG_CT_RESERVED_ELSEWHERE'
  | 'IG_CT_HANDLE_MISMATCH'
  | 'IG_CT_PAYLOAD_DRIFT'
  /** La réservation atomique a été perdue : un autre worker l'a prise d'abord. */
  | 'IG_CT_RESERVATION_LOST'
  /** La réservation n'a pas pu être consommée à l'instant du clic. Zéro effet. */
  | 'IG_CT_CONSUMPTION_LOST'
  /** Le test porte déjà une tentative d'effet : plus jamais de rejeu. */
  | 'IG_CT_EFFECT_ALREADY_ATTEMPTED'
  /**
   * La cible EST le compte émetteur. Refusé hors reconnaissance.
   *
   * Pas parce que ce serait dangereux — s'écrire à soi-même ne dérange
   * personne — mais parce que ce serait sans valeur probante : le test existe
   * pour établir si le rail sait REMETTRE un message à un tiers, et un fil avec
   * soi-même ne franchit ni les demandes de message, ni les règles qu'Instagram
   * applique entre deux comptes. Dépenser l'unique autorisation là-dessus
   * consommerait la réponse sans l'obtenir.
   */
  | 'IG_CT_TARGET_IS_SENDER'
  // --- Issues ---------------------------------------------------------------
  /** Reconnaissance menée jusqu'au bout, sans rien envoyer. */
  | 'IG_CT_PREFLIGHT_OK'
  /** Chemin parcouru jusqu'au dernier point observable, sans saisie ni clic. */
  | 'IG_CT_PREVIEWED'
  /** IG2.5 — brouillon saisi, constaté conforme et envoyable, puis retiré. Zéro clic. */
  | 'IG_CT_COMPOSER_READY'
  /** Un clic ET une preuve de remise suffisante. Jamais l'un sans l'autre. */
  | 'IG_CT_SENT'
  /** Un clic, et l'interface déclare le message non remis. */
  | 'IG_CT_DELIVERY_FAILED'
  /** Un clic, preuve insuffisante. Terminal, jamais rejoué. */
  | 'IG_CT_AMBIGUOUS';

export type ControlledTestReasonCode = ControlledTestOwnCode | InstagramBlockCode | InstagramFailureCode;

// ---------------------------------------------------------------------------
// La ligne
// ---------------------------------------------------------------------------

export type ControlledTestState = 'ARMED' | 'RESERVED' | 'CONSUMED' | 'EXPIRED' | 'REVOKED';
export type ControlledTestOutcome = 'SENT' | 'DELIVERY_FAILED' | 'AMBIGUOUS';

export interface ControlledTest {
  readonly id: string;
  readonly kind: 'CONTROLLED_TEST';
  readonly action: string;
  readonly transport: string;
  readonly targetHandle: string;
  readonly consentNote: string;
  readonly payloadText: string;
  readonly payloadSha256: string;
  readonly idempotencyKey: string;
  readonly armedBy: string;
  readonly reason: string;
  readonly state: ControlledTestState;
  readonly maxExternalAttempts: number;
  readonly externalAttemptsUsed: number;
  readonly externalEffectAttempted: boolean;
  readonly externalEffectStartedAt: string | null;
  readonly outcome: ControlledTestOutcome | null;
  readonly outcomeAt: string | null;
  readonly outcomeDetail: string | null;
  readonly expiresAt: string;
  readonly armedAt: string;
  readonly reservedAt: string | null;
  readonly reservedBy: string | null;
  readonly consumedAt: string | null;
  readonly consumedBy: string | null;
  readonly closedAt: string | null;
  readonly closedBy: string | null;
  readonly closedReason: string | null;
}

const COLUMNS = `id, kind, action, transport, target_handle as "targetHandle", consent_note as "consentNote",
        payload_text as "payloadText", payload_sha256 as "payloadSha256",
        idempotency_key as "idempotencyKey", armed_by as "armedBy", reason, state,
        max_external_attempts as "maxExternalAttempts", external_attempts_used as "externalAttemptsUsed",
        external_effect_attempted as "externalEffectAttempted",
        external_effect_started_at as "externalEffectStartedAt",
        outcome, outcome_at as "outcomeAt", outcome_detail as "outcomeDetail",
        expires_at as "expiresAt", armed_at as "armedAt",
        reserved_at as "reservedAt", reserved_by as "reservedBy",
        consumed_at as "consumedAt", consumed_by as "consumedBy",
        closed_at as "closedAt", closed_by as "closedBy", closed_reason as "closedReason"`;

export class ControlledTestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ControlledTestError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

export async function loadControlledTest(sql: Sql, id: string): Promise<ControlledTest | null> {
  const rows = await sql.query<ControlledTest>(`select ${COLUMNS} from ig_controlled_tests where id = $1`, [id]);
  return rows[0] ?? null;
}

/** L'unique test encore vivant (`ARMED` ou `RESERVED`), s'il y en a un. */
export async function loadLiveControlledTest(sql: Sql): Promise<ControlledTest | null> {
  const rows = await sql.query<ControlledTest>(
    `select ${COLUMNS} from ig_controlled_tests
      where state in ('ARMED', 'RESERVED') order by armed_at desc limit 1`,
  );
  return rows[0] ?? null;
}

export async function listControlledTests(sql: Sql, limit = 20): Promise<ControlledTest[]> {
  return sql.query<ControlledTest>(`select ${COLUMNS} from ig_controlled_tests order by armed_at desc limit $1`, [
    limit,
  ]);
}

/**
 * Bascule en `EXPIRED` tout test dont l'échéance est passée.
 *
 * Appelée avant chaque lecture décisive plutôt que par un travail périodique,
 * pour la même raison qu'en 0031 : une expiration qui dépendrait d'un cron
 * laisserait, entre deux passages, des lignes qui se disent `ARMED` alors
 * qu'elles ne le sont plus. La garde qui compte reste de toute façon dans la
 * réservation et la consommation (`expires_at > now()`), qui ne font confiance
 * à aucun statut recopié.
 */
export async function expireStaleControlledTests(sql: Sql): Promise<number> {
  const rows = await sql.query<{ id: string }>(
    `update ig_controlled_tests
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

export interface ArmControlledTestInput {
  /** Le handle du compte de test. Normalisé et revalidé ici, jamais pris tel quel. */
  readonly targetHandle: string;
  readonly armedBy: string;
  readonly reason: string;
  /** Qui atteste que ce compte est contrôlé et consentant, et comment. */
  readonly consentNote: string;
  readonly ttlMs: number;
}

/**
 * Arme un test contrôlé, ou refuse.
 *
 * Remarquez ce que la signature ne contient pas : aucun texte, aucun nombre de
 * tentatives, aucun manifeste, aucun prospect. Le message vient de la constante
 * gelée du module, le plafond de tentatives vaut 1 par contrainte de base, et
 * il n'existe aucun champ pour rattacher ce test à une intention commerciale.
 */
export async function armControlledTest(sql: Sql, input: ArmControlledTestInput): Promise<ControlledTest> {
  const armedBy = input.armedBy.trim();
  const reason = input.reason.trim();
  const consentNote = input.consentNote.trim();

  const handle = normalizeHandle(input.targetHandle);
  if (handle === null) {
    throw new ControlledTestError(
      'IG_CT_HANDLE_INVALID',
      `armement refusé : « ${input.targetHandle} » n'est pas un handle Instagram valide`,
    );
  }
  if (armedBy.length === 0) {
    throw new ControlledTestError(
      'IG_CT_NO_OPERATOR',
      'armement refusé : --as est obligatoire — un effet réel s’autorise au nom de quelqu’un',
    );
  }
  if (reason.length === 0) {
    throw new ControlledTestError('IG_CT_NO_REASON', 'armement refusé : une raison est obligatoire');
  }
  if (consentNote.length === 0) {
    throw new ControlledTestError(
      'IG_CT_NO_CONSENT',
      'armement refusé : --consent est obligatoire — « compte de test » doit être attesté par quelqu’un, ' +
        'pas supposé par le rail',
    );
  }
  if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0 || input.ttlMs > MAX_CONTROLLED_TEST_TTL_MS) {
    throw new ControlledTestError(
      'IG_CT_TTL_INVALID',
      `armement refusé : durée de vie ${input.ttlMs} ms hors bornes (0 < ttl ≤ ${MAX_CONTROLLED_TEST_TTL_MS} ms)`,
    );
  }

  await expireStaleControlledTests(sql);

  const idempotencyKey = deriveControlledTestIdempotencyKey(handle);

  // La règle qui interdit vraiment de réarmer, et la seule : un effet externe
  // a-t-il déjà été tenté sur CETTE intention ?
  //
  // Elle porte sur le FAIT — le drapeau posé avant le clic et jamais retiré —
  // pas sur l'existence d'un armement antérieur. Un armement dépensé sans
  // qu'un octet parte n'a rien produit ; celui qui a précédé un clic ferme la
  // porte définitivement, même si le clic n'a rien prouvé, et surtout dans ce
  // cas. L'index unique partiel de 0035 dit la même chose et l'appliquerait
  // même à un `INSERT` écrit à la main.
  const prior = await sql.query<{ id: string; startedAt: string | null; outcome: string | null }>(
    `select id, external_effect_started_at as "startedAt", outcome
       from ig_controlled_tests
      where idempotency_key = $1 and external_effect_attempted = true`,
    [idempotencyKey],
  );
  const already = prior[0];
  if (already) {
    throw new ControlledTestError(
      'IG_CT_EFFECT_ALREADY_ATTEMPTED',
      `armement refusé : le test ${already.id} a déjà tenté un effet externe sur « ${handle} » ` +
        `(${already.startedAt ?? 'date inconnue'}, issue ${already.outcome ?? 'inconnue'}). ` +
        'Aucun rejeu, quelle qu’en ait été l’issue — un second armement serait un second message.',
    );
  }

  const rows = await sql
    .query<ControlledTest>(
      `insert into ig_controlled_tests
         (action, transport, target_handle, consent_note, payload_text, payload_sha256,
          idempotency_key, armed_by, reason, state, expires_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ARMED', now() + ($10::bigint * interval '1 millisecond'))
       returning ${COLUMNS}`,
      [
        CONTROLLED_TEST_ACTION,
        CONTROLLED_TEST_TRANSPORT,
        handle,
        consentNote,
        CONTROLLED_TEST_PAYLOAD,
        CONTROLLED_TEST_PAYLOAD_SHA256,
        idempotencyKey,
        armedBy,
        reason,
        String(Math.round(input.ttlMs)),
      ],
    )
    .catch((error: unknown) => {
      if (isUniqueViolation(error)) {
        throw new ControlledTestError(
          'IG_CT_ALREADY_LIVE',
          'armement refusé : un test contrôlé est déjà vivant (un seul à la fois — il n’y a qu’un compte ' +
            'émetteur et qu’un navigateur). Le révoquer explicitement avant d’en ouvrir un autre.',
        );
      }
      throw error;
    });

  const created = rows[0];
  if (!created) throw new Error('ig_controlled_tests insert did not return a row');
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

export async function revokeControlledTest(
  sql: Sql,
  input: { id: string; revokedBy: string; reason: string },
): Promise<ControlledTest | null> {
  const revokedBy = input.revokedBy.trim();
  if (revokedBy.length === 0) {
    throw new ControlledTestError('IG_CT_NO_OPERATOR', 'révocation refusée : --as est obligatoire');
  }
  const rows = await sql.query<ControlledTest>(
    `update ig_controlled_tests
        set state = 'REVOKED', closed_at = now(), closed_by = $2, closed_reason = $3
      where id = $1 and state = 'ARMED'
      returning ${COLUMNS}`,
    [input.id, revokedBy, input.reason.slice(0, 500)],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Vérification — pure, sans I/O
// ---------------------------------------------------------------------------

export interface ControlledTestCheckInput {
  readonly test: ControlledTest | null;
  readonly targetHandle: string;
  readonly now: number;
}

export type ControlledTestVerdict =
  | { readonly ok: true; readonly test: ControlledTest }
  | { readonly ok: false; readonly code: ControlledTestOwnCode; readonly reason: string };

/**
 * Confronte une autorisation de test à la cible réellement sur le point d'être
 * touchée. Pure et sans horloge implicite : chaque refus est exerçable par un
 * test, y compris ceux qu'une base réelle mettrait un quart d'heure à produire.
 */
export function checkControlledTest(input: ControlledTestCheckInput): ControlledTestVerdict {
  const test = input.test;
  if (test === null) {
    return {
      ok: false,
      code: 'IG_CT_NOT_ARMED',
      reason: 'aucun test contrôlé armé — lever l’arrêt global ne suffit pas à envoyer',
    };
  }

  if (test.state === 'REVOKED') {
    return {
      ok: false,
      code: 'IG_CT_REVOKED',
      reason: `test ${test.id} révoqué par ${test.closedBy ?? 'inconnu'} : ${test.closedReason ?? 'sans motif'}`,
    };
  }
  if (test.state === 'CONSUMED') {
    return {
      ok: false,
      code: 'IG_CT_CONSUMED',
      reason:
        `test ${test.id} déjà consommé le ${test.consumedAt ?? 'à une date inconnue'} ` +
        `par ${test.consumedBy ?? 'inconnu'} — une autorisation d’un seul effet ne se rejoue pas`,
    };
  }
  if (test.state === 'EXPIRED') {
    return { ok: false, code: 'IG_CT_EXPIRED', reason: `test ${test.id} expiré le ${test.expiresAt}` };
  }
  if (test.state === 'RESERVED') {
    return {
      ok: false,
      code: 'IG_CT_RESERVED_ELSEWHERE',
      reason:
        `test ${test.id} réservé depuis le ${test.reservedAt ?? 'à une date inconnue'} ` +
        `par ${test.reservedBy ?? 'inconnu'} — un seul worker à la fois, même avant tout effet`,
    };
  }
  if (test.state !== 'ARMED') {
    return { ok: false, code: 'IG_CT_NOT_ARMED', reason: `test ${test.id} à l’état « ${test.state} »` };
  }

  // Relu ici en plus du statut : une ligne peut se dire `ARMED` alors que son
  // échéance est passée, tant que personne n'a fait tourner l'expiration.
  const expiresAt = Date.parse(test.expiresAt);
  if (!Number.isFinite(expiresAt) || input.now >= expiresAt) {
    return {
      ok: false,
      code: 'IG_CT_EXPIRED',
      reason: `test ${test.id} échu (${test.expiresAt}) — une fenêtre courte n’est pas une fenêtre ouverte`,
    };
  }

  if (test.externalEffectAttempted) {
    return {
      ok: false,
      code: 'IG_CT_EFFECT_ALREADY_ATTEMPTED',
      reason: `test ${test.id} porte déjà une tentative d’effet externe (${test.externalEffectStartedAt ?? 'date inconnue'})`,
    };
  }
  if (test.externalAttemptsUsed >= test.maxExternalAttempts) {
    return {
      ok: false,
      code: 'IG_CT_CONSUMED',
      reason: `test ${test.id} : ${test.externalAttemptsUsed}/${test.maxExternalAttempts} tentative(s) déjà comptée(s)`,
    };
  }

  if (test.targetHandle.toLowerCase() !== input.targetHandle.toLowerCase()) {
    return {
      ok: false,
      code: 'IG_CT_HANDLE_MISMATCH',
      reason: `test ${test.id} porte « ${test.targetHandle} », cible « ${input.targetHandle} »`,
    };
  }

  // L'empreinte est confrontée à la constante du module, pas à elle-même : ce
  // qui est vérifié est « le texte qui partirait est-il encore celui que ce
  // rail a le droit d'envoyer ? ». Une ligne écrite sous une ancienne version
  // de la constante est donc refusée plutôt que rejouée.
  if (test.payloadSha256 !== CONTROLLED_TEST_PAYLOAD_SHA256 || test.payloadText !== CONTROLLED_TEST_PAYLOAD) {
    return {
      ok: false,
      code: 'IG_CT_PAYLOAD_DRIFT',
      reason:
        `le texte du test ${test.id} n’est plus celui que ce rail porte ` +
        `(${test.payloadSha256.slice(0, 12)}… vs ${CONTROLLED_TEST_PAYLOAD_SHA256.slice(0, 12)}…)`,
    };
  }

  return { ok: true, test };
}

// ---------------------------------------------------------------------------
// Réservation, consommation, relâchement — la mécanique d'IG2.1 §7
// ---------------------------------------------------------------------------

/**
 * Prend la main, ou rend `null`. Ne compte aucune tentative.
 *
 * Tout ce que `checkControlledTest` a vérifié est REVÉRIFIÉ dans le `where` :
 * la lecture qui l'a nourri appartient au passé, et entre elle et cet instant
 * un autre worker a pu réserver, un humain a pu révoquer, l'échéance a pu
 * tomber.
 */
export async function reserveControlledTest(
  sql: Sql,
  input: { testId: string; workerId: string; targetHandle: string },
): Promise<ControlledTest | null> {
  const rows = await sql.query<ControlledTest>(
    `update ig_controlled_tests
        set state = 'RESERVED', reserved_at = now(), reserved_by = $2
      where id = $1
        and state = 'ARMED'
        and expires_at > now()
        and external_effect_attempted = false
        and external_attempts_used < max_external_attempts
        and lower(target_handle) = lower($3)
        and payload_sha256 = $4
      returning ${COLUMNS}`,
    [input.testId, input.workerId, input.targetHandle, CONTROLLED_TEST_PAYLOAD_SHA256],
  );
  return rows[0] ?? null;
}

/**
 * Consomme la réservation — l'instant irréversible, et le seul qui incrémente
 * le compteur de tentatives.
 *
 * Appelée dans la même séquence que `markControlledTestEffect`, et avant elle :
 * un processus tué entre les deux laisse une autorisation dépensée sur un test
 * qui n'a rien tenté, ce qui est le sens prudent de l'erreur. L'inverse
 * laisserait croire qu'il reste un droit à dépenser.
 */
export async function consumeControlledTestReservation(
  sql: Sql,
  input: { testId: string; workerId: string },
): Promise<ControlledTest | null> {
  const rows = await sql.query<ControlledTest>(
    `update ig_controlled_tests
        set state = 'CONSUMED',
            external_attempts_used = external_attempts_used + 1,
            consumed_at = now(),
            consumed_by = $2
      where id = $1
        and state = 'RESERVED'
        and reserved_by = $2
        and expires_at > now()
        and external_attempts_used < max_external_attempts
      returning ${COLUMNS}`,
    [input.testId, input.workerId],
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
 */
export async function releaseControlledTestReservation(
  sql: Sql,
  input: { testId: string; workerId: string },
): Promise<ControlledTest | null> {
  const rows = await sql.query<ControlledTest>(
    `update ig_controlled_tests
        set state = 'ARMED', reserved_at = null, reserved_by = null
      where id = $1 and state = 'RESERVED' and reserved_by = $2
      returning ${COLUMNS}`,
    [input.testId, input.workerId],
  );
  return rows[0] ?? null;
}

/**
 * Inscrit durablement « un effet va être tenté », juste avant le clic.
 *
 * Le `where external_effect_attempted = false` rend l'opération non répétable :
 * un second appel ne réécrit pas l'horodatage et lève. Une tentative ne peut
 * donc pas être « re-commencée ».
 */
export async function markControlledTestEffect(sql: Sql, testId: string): Promise<void> {
  const rows = await sql.query<{ id: string }>(
    `update ig_controlled_tests
        set external_effect_attempted = true, external_effect_started_at = now()
      where id = $1 and external_effect_attempted = false
      returning id`,
    [testId],
  );
  if (rows.length !== 1) {
    // Refuser bruyamment : l'appelant est sur le point de cliquer, et il ne
    // doit le faire que si la trace existe.
    throw new ControlledTestError(
      'IG_CT_EFFECT_ALREADY_ATTEMPTED',
      `le test ${testId} porte déjà une tentative d'effet externe — aucun second clic`,
    );
  }
}

/** Inscrit l'issue adjugée. Refusée par la base tant qu'aucun effet n'a eu lieu. */
export async function recordControlledTestOutcome(
  sql: Sql,
  input: { testId: string; outcome: ControlledTestOutcome; detail: string },
): Promise<void> {
  await sql.query(
    `update ig_controlled_tests
        set outcome = $2, outcome_at = now(), outcome_detail = $3
      where id = $1`,
    [input.testId, input.outcome, input.detail.slice(0, 2000)],
  );
}

/**
 * IG2.9 — une issue DÉFINITIVE, c'est-à-dire une lecture qui a conclu.
 *
 * `AMBIGUOUS` n'en est pas une, et c'est tout le sujet : il ne dit pas « le
 * message n'est pas parti », il dit « je n'ai pas pu établir s'il l'était ».
 * Confondre les deux est exactement ce qui a produit le faux `CONTRADICTS` du
 * 14 août.
 */
export function isDefinitiveOutcome(outcome: ControlledTestOutcome | null): boolean {
  return outcome === 'SENT' || outcome === 'DELIVERY_FAILED';
}

export type ControlledTestResolution =
  /** L'indécision a été levée : `AMBIGUOUS` devient une issue connue. */
  | { readonly kind: 'RESOLVED'; readonly from: ControlledTestOutcome | null; readonly to: ControlledTestOutcome }
  /** La relecture confirme ce qui était déjà inscrit. Aucune écriture. */
  | { readonly kind: 'UNCHANGED'; readonly outcome: ControlledTestOutcome }
  /**
   * IG2.9 — la relecture n'a rien pu établir, l'issue inscrite tient.
   *
   * Ce cas existait dans la réalité depuis toujours ; il n'existait pas dans le
   * type, et faute d'une place où le ranger il tombait dans `CONTRADICTS`.
   */
  | {
      readonly kind: 'INCONCLUSIVE';
      readonly recorded: ControlledTestOutcome;
      readonly observed: 'AMBIGUOUS';
      readonly reason: string;
    }
  /** Deux lectures DÉFINITIVES divergent. Refus — cela se tranche à la main. */
  | { readonly kind: 'CONTRADICTS'; readonly recorded: ControlledTestOutcome; readonly observed: ControlledTestOutcome };

/**
 * IG2.3 §3 — inscrit l'issue d'une RELECTURE, et refuse d'écraser une décision.
 *
 * Quatre cas, et un seul écrit :
 *
 *   * l'issue enregistrée est `AMBIGUOUS` (ou absente) et la relecture tranche :
 *     c'est une RÉSOLUTION, elle s'inscrit. Un « je ne sais pas » qui devient
 *     un « je sais » est exactement ce qu'une adjudication existe pour produire ;
 *   * la relecture dit la même chose : rien à écrire, une décision ne se
 *     recompte pas ;
 *   * la relecture n'a RIEN pu établir : l'issue inscrite tient, sans écriture ;
 *   * deux lectures DÉFINITIVES divergent : refus. Un `SENT` qui deviendrait
 *     `DELIVERY_FAILED` — ou l'inverse — met en cause la lecture elle-même, et
 *     cela se tranche par un humain, pas par écrasement (même règle que
 *     `commitCanaryAdjudication`).
 *
 * IG2.9 — l'invariant de terminalité, et le bug qu'il ferme
 * ---------------------------------------------------------
 * Le troisième cas manquait. Le 14 août, un `SENT` prouvé a été relu par une
 * adjudication qui n'a pas pu rouvrir le fil : ses quatre preuves internes sont
 * revenues ILLISIBLES, `adjudicateDelivery` a donc rendu `AMBIGUOUS` — ce qui
 * était honnête — et cette fonction a comparé `SENT` à `AMBIGUOUS` pour en
 * conclure `CONTRADICTS`. Or aucune preuve contraire n'existait : la lecture
 * n'avait simplement pas eu lieu.
 *
 * La règle est désormais explicite : une issue terminale ne peut être remise en
 * cause que par une AUTRE issue terminale. `AMBIGUOUS` observé ne renverse
 * jamais rien, parce qu'il ne prétend rien — il déclare l'absence de lecture,
 * pas la lecture d'une absence.
 *
 * Ce qu'aucun de ces cas n'écrit, jamais : un `outreach_event`. Un test
 * technique n'a joint personne au sens commercial, quelle que soit son issue —
 * et la fonction ne connaît pas cette table.
 */
export async function resolveControlledTestOutcome(
  sql: Sql,
  input: { testId: string; observed: ControlledTestOutcome; detail: string },
): Promise<ControlledTestResolution> {
  const test = await loadControlledTest(sql, input.testId);
  if (test === null) throw new ControlledTestError('IG_CT_NOT_FOUND', `test contrôlé ${input.testId} introuvable`);
  if (!test.externalEffectAttempted) {
    throw new ControlledTestError(
      'IG_CT_NO_EFFECT',
      `le test ${test.id} n'a jamais tenté d'effet externe — il n'y a rien à adjuger`,
    );
  }

  const recorded = test.outcome;
  if (recorded === input.observed) return { kind: 'UNCHANGED', outcome: input.observed };

  // IG2.9 — une relecture non concluante ne renverse pas une issue terminale.
  // Elle est rangée ici, AVANT la comparaison de divergence, parce que c'est
  // précisément la comparaison qui n'a pas de sens dans ce cas : il n'y a rien
  // à comparer.
  if (input.observed === 'AMBIGUOUS' && isDefinitiveOutcome(recorded) && recorded !== null) {
    return {
      kind: 'INCONCLUSIVE',
      recorded,
      observed: 'AMBIGUOUS',
      reason:
        `la relecture n'a rien pu établir ; l'issue ${recorded} reste celle de la tentative. ` +
        'Une absence de lecture n’est pas une preuve contraire.',
    };
  }

  if (isDefinitiveOutcome(recorded)) {
    return { kind: 'CONTRADICTS', recorded: recorded as ControlledTestOutcome, observed: input.observed };
  }

  await recordControlledTestOutcome(sql, {
    testId: test.id,
    outcome: input.observed,
    detail: input.detail,
  });
  return { kind: 'RESOLVED', from: recorded, to: input.observed };
}

// ---------------------------------------------------------------------------
// Le journal DISTINCT
// ---------------------------------------------------------------------------

export interface ControlledTestEventRecord {
  readonly testId: string | null;
  readonly sessionId: string | null;
  readonly workerId: string;
  readonly operator: string;
  /**
   * IG2.9 — `ADJUDICATION` DÉCRIT une tentative antérieure, il n'en déclare pas
   * une nouvelle. La base impose qu'il ne porte jamais d'effet : une relecture
   * ne peut pas, même par bug, se consigner comme un envoi.
   */
  readonly mode: 'PREFLIGHT' | 'PREVIEW' | 'COMPOSE_CHECK' | 'LIVE' | 'ADJUDICATION';
  readonly status:
    | 'PREFLIGHT_OK'
    | 'PREVIEWED'
    | 'COMPOSER_READY'
    | 'BLOCKED'
    | 'FAILED'
    | 'SENT'
    | 'DELIVERY_FAILED'
    | 'AMBIGUOUS';
  readonly reasonCode: ControlledTestReasonCode;
  readonly idempotencyKey: string;
  readonly targetHandle: string;
  readonly observedHandle: string | null;
  readonly observedUrl: string | null;
  readonly sessionState: InstagramSessionState | null;
  readonly identityVerdict: InstagramIdentityVerdict | null;
  readonly identitySignals: readonly InstagramIdentitySignal[];
  readonly relationship: InstagramRelationshipObservation;
  readonly gates: readonly GateRecord[];
  readonly externalEffectAttempted: boolean;
  readonly durationMs: number | null;
  readonly detail: string | null;
}

/**
 * Écrit une ligne du journal de test — et d'aucun autre.
 *
 * Cette fonction ne sait pas écrire dans `ig_job_events`, ni dans
 * `outreach_events`, ni dans `prospects`. Ce n'est pas une consigne, c'est la
 * seule instruction SQL du module : il n'y a pas d'autre table nommée ici.
 */
export async function recordControlledTestEvent(sql: Sql, record: ControlledTestEventRecord): Promise<string> {
  const identityPresent = record.identityVerdict !== null;
  const rows = await sql.query<{ id: string }>(
    `insert into ig_controlled_test_events
       (test_id, session_id, worker_id, operator, mode, status, reason_code, idempotency_key,
        target_handle, observed_handle, observed_url, session_state,
        identity_verdict, identity_provider, identity_method, identity_signals,
        follows_viewer, followed_by_viewer, relationship_labels,
        relationship_is_own_profile, relationship_ui_rendered,
        gates, external_effect_attempted, duration_ms, detail)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19::jsonb,
             $20,$21,$22::jsonb,$23,$24,$25)
     returning id`,
    [
      record.testId,
      record.sessionId,
      record.workerId,
      record.operator,
      record.mode,
      record.status,
      record.reasonCode,
      record.idempotencyKey,
      record.targetHandle,
      record.observedHandle,
      record.observedUrl,
      record.sessionState,
      record.identityVerdict,
      identityPresent ? 'instagram_web' : null,
      identityPresent ? 'browser_profile_page' : null,
      JSON.stringify(record.identitySignals),
      record.relationship.followsViewer,
      record.relationship.followedByViewer,
      JSON.stringify(record.relationship.labels),
      record.relationship.isOwnProfile,
      record.relationship.relationUiRendered,
      JSON.stringify(record.gates),
      record.externalEffectAttempted,
      record.durationMs,
      record.detail === null ? null : record.detail.slice(0, 2000),
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('ig_controlled_test_events insert did not return a row');
  return id;
}

export interface ControlledTestEventRow {
  readonly id: string;
  readonly testId: string | null;
  readonly mode: string;
  readonly status: string;
  readonly reasonCode: string;
  readonly targetHandle: string;
  readonly observedHandle: string | null;
  readonly sessionState: string | null;
  readonly identityVerdict: string | null;
  readonly followsViewer: boolean | null;
  readonly followedByViewer: boolean | null;
  readonly isOwnProfile: boolean | null;
  readonly externalEffectAttempted: boolean;
  readonly detail: string | null;
  readonly createdAt: string;
}

export async function listControlledTestEvents(sql: Sql, limit = 20): Promise<ControlledTestEventRow[]> {
  return sql.query<ControlledTestEventRow>(
    `select id, test_id as "testId", mode, status, reason_code as "reasonCode",
            target_handle as "targetHandle", observed_handle as "observedHandle",
            session_state as "sessionState", identity_verdict as "identityVerdict",
            follows_viewer as "followsViewer", followed_by_viewer as "followedByViewer",
            relationship_is_own_profile as "isOwnProfile",
            external_effect_attempted as "externalEffectAttempted", detail, created_at as "createdAt"
       from ig_controlled_test_events order by created_at desc limit $1`,
    [limit],
  );
}
