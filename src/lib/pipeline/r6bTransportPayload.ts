import { sha256Hex } from '@/lib/util/hash';
// Import de type uniquement : `r6bDispatch` importe ce module au runtime pour
// figer un payload, donc l'arête inverse doit rester purement typographique —
// une dépendance circulaire réelle rendrait l'ordre d'initialisation des
// constantes de ce fichier dépendant de qui est chargé en premier.
import type { Transport } from '@/lib/pipeline/r6bDispatch';

/**
 * R6B-C.2A — payload transport-spécifique, empreinte canonique et LIVE
 * readiness (mission « Hermes R6B-C.2A — Transport Payload
 * Completion »).
 *
 * Le manifeste R6B-B fige déjà ce qu'un humain a décidé : à qui, par quel
 * transport, avec quel texte. Il ne dit rien des propriétés que le transport
 * lui-même exige et que le corps du message ne porte pas — l'objet d'un
 * email, le mapping des champs d'un formulaire, la présence d'un humain pour
 * passer un appel. Sans elles, un futur sender n'a que deux issues : refuser
 * d'envoyer, ou inventer la valeur manquante. Ce module rend la première
 * issue explicite et la seconde impossible.
 *
 * Trois choses, et rien d'autre :
 *
 *   1. une représentation canonique et hachable du payload (`canonicalJson`,
 *      `hashTransportPayload`) — deux payloads logiquement identiques ont la
 *      même empreinte, quel que soit l'ordre des clés ou le formatage JSON ;
 *   2. la liste, par transport, de ce qu'un envoi réel exigerait
 *      (`TRANSPORT_LIVE_REQUIREMENTS`) — centralisée, jamais dispersée dans
 *      les adapters ni dans l'UI ;
 *   3. une lecture déterministe de cette liste face à un manifeste donné
 *      (`getLiveReadiness`) — sans réseau, sans crawl, sans LLM, sans
 *      recalcul commercial.
 *
 * Ce module n'écrit rien, n'ouvre aucune connexion et ne complète jamais un
 * payload de lui-même : il sait dire ce qui manque, jamais le combler.
 */

// ---------------------------------------------------------------------------
// Sérialisation canonique
// ---------------------------------------------------------------------------

/**
 * Le sous-ensemble de JSON qu'un payload transport peut porter.
 *
 * `null` en est volontairement absent : il existerait alors deux façons
 * d'écrire « cette propriété n'a pas de valeur » (absente, ou présente à
 * `null`), qui produiraient deux empreintes différentes pour le même fait.
 * Une propriété sans valeur est une propriété absente.
 */
export type PayloadJson = string | number | boolean | readonly PayloadJson[] | PayloadJsonObject;

export interface PayloadJsonObject {
  readonly [key: string]: PayloadJson;
}

/** Payload transport figé sur un manifeste. Toujours un objet, éventuellement vide. */
export type TransportPayload = PayloadJsonObject;

export const EMPTY_TRANSPORT_PAYLOAD: TransportPayload = Object.freeze({});

export class TransportPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportPayloadError';
  }
}

/**
 * Sérialisation canonique déterministe — la définition qui donne son sens à
 * `transport_payload_sha256`.
 *
 * Règles, toutes nécessaires pour que « même payload logique → même
 * empreinte » :
 *
 *   - clés d'objet triées par unités de code UTF-16 (`Array.sort()` par
 *     défaut, indépendant de la locale) : l'ordre d'écriture ne change rien ;
 *   - aucune espace, aucun retour à la ligne : le formatage du JSON qui a
 *     transporté la valeur ne change rien ;
 *   - propriétés à `undefined` omises, comme le ferait `JSON.stringify` —
 *     « absente » et « présente à undefined » sont le même fait ;
 *   - chaînes échappées par `JSON.stringify`, donc en UTF-8 après
 *     `Buffer.from(…, 'utf8')` au moment du hash ;
 *   - nombres non finis et valeurs non-JSON refusées plutôt que coercées :
 *     une empreinte calculée sur une valeur silencieusement transformée ne
 *     prouve rien.
 *
 * Volontairement pas de normalisation Unicode (NFC/NFD) : normaliser
 * changerait la chaîne qu'un opérateur a réellement approuvée. Deux écritures
 * Unicode distinctes du même glyphe sont deux valeurs distinctes, et
 * l'empreinte le dit.
 */
export function canonicalJson(value: PayloadJson): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TransportPayloadError(`nombre non fini dans un payload transport : ${String(value)}`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry as PayloadJson)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, PayloadJson | undefined>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const entry = record[key];
      if (entry === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalJson(entry)}`);
    }
    return `{${parts.join(',')}}`;
  }
  throw new TransportPayloadError(`valeur non sérialisable dans un payload transport : ${typeof value}`);
}

/** Empreinte du payload transport. Calculée sur la forme canonique, jamais sur un JSON quelconque. */
export function hashTransportPayload(payload: TransportPayload): string {
  return sha256Hex(canonicalJson(payload));
}

/**
 * Relit un `jsonb` venu de la base comme un payload transport, ou retourne
 * `null` s'il n'en est pas un.
 *
 * Retourne `null` plutôt que de lever : la page de dispatch lit des
 * manifestes historiques et ne doit pas tomber devant une ligne douteuse —
 * c'est le dispatcher qui refuse d'agir (`TRANSPORT_PAYLOAD_INVALID`). Les
 * contraintes de 0022 rendent ce cas presque impossible en base ; le code ne
 * s'appuie pas sur « presque ».
 */
export function readTransportPayload(raw: unknown): TransportPayload | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  try {
    // Aller-retour par la forme canonique : ce qui ne se sérialise pas
    // canoniquement n'est pas un payload valide, quelle qu'en soit la raison.
    // `null` imbriqué inclus — `canonicalJson` le refuse, puisque « absent »
    // est la seule façon de dire « pas de valeur ».
    canonicalJson(raw as PayloadJson);
  } catch {
    return null;
  }
  return raw as TransportPayload;
}

// ---------------------------------------------------------------------------
// Ce qu'un envoi réel exigerait, par transport
// ---------------------------------------------------------------------------

/**
 * Comment une exigence peut être satisfaite — jamais « comment la deviner ».
 *
 *   - `human_input` : une valeur que seul un humain peut fournir, saisie
 *     explicitement puis figée dans le payload (objet d'email).
 *   - `structured`  : une structure qu'il faut établir et approuver avant
 *     tout envoi (mapping des champs d'un formulaire). Aucun écran de C.2A ne
 *     la produit : la voir dans `missing` est le résultat attendu.
 *   - `non_automatable` : une exigence qu'aucune donnée ne peut satisfaire,
 *     parce que l'action elle-même n'est pas automatisable (un appel
 *     téléphonique est passé par une personne). Elle n'a pas de clé de
 *     payload correspondante et reste manquante par construction.
 */
export type LiveRequirementKind = 'human_input' | 'structured' | 'non_automatable';

export interface LiveRequirement {
  /** Nom exact rapporté dans `missingForLive` — stable, c'est une valeur d'audit. */
  readonly key: string;
  readonly kind: LiveRequirementKind;
  /** Pourquoi un envoi réel l'exige. Affiché à l'humain, jamais utilisé pour décider. */
  readonly why: string;
  /** Lu uniquement dans le payload figé. Aucune valeur par défaut, aucun repli. */
  isSatisfied(payload: TransportPayload): boolean;
}

/** Longueurs retenues pour un objet d'email — assez pour une phrase, trop court pour un message. */
export const EMAIL_SUBJECT_MIN_LENGTH = 3;
export const EMAIL_SUBJECT_MAX_LENGTH = 120;

export type EmailSubjectRejection = 'not_a_string' | 'control_characters' | 'empty' | 'too_short' | 'too_long';

export type EmailSubjectResult =
  | { readonly ok: true; readonly subject: string }
  | { readonly ok: false; readonly code: EmailSubjectRejection; readonly reason: string };

/**
 * C0 (dont CR, LF, TAB, NUL), DEL et C1 : tout ce qu'un en-tête d'email
 * pourrait interpréter comme une fin de champ ou une nouvelle ligne d'en-tête.
 */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * Valide un objet d'email saisi par un humain. Ne le corrige pas, ne le
 * complète pas, n'en propose pas.
 *
 * L'ordre des contrôles compte : les caractères de contrôle sont refusés
 * **avant** tout `trim`. Un `trim` appliqué d'abord effacerait un `\r\n`
 * final — c'est-à-dire accepterait silencieusement une tentative d'injection
 * d'en-tête en la faisant disparaître. Refuser dit ce qui s'est passé ;
 * nettoyer le dissimule.
 */
export function validateEmailSubject(raw: unknown): EmailSubjectResult {
  if (typeof raw !== 'string') {
    return { ok: false, code: 'not_a_string', reason: 'objet absent' };
  }
  // C0, DEL et C1 : couvre CR, LF, TAB, NUL et les séparateurs de ligne
  // exotiques qu'un en-tête MIME interpréterait.
  if (hasControlCharacter(raw)) {
    return {
      ok: false,
      code: 'control_characters',
      reason: 'un objet d’email ne peut contenir ni retour à la ligne ni caractère de contrôle (injection d’en-tête)',
    };
  }
  const subject = raw.trim();
  if (subject.length === 0) {
    return { ok: false, code: 'empty', reason: 'objet vide' };
  }
  if (subject.length < EMAIL_SUBJECT_MIN_LENGTH) {
    return { ok: false, code: 'too_short', reason: `objet trop court (minimum ${EMAIL_SUBJECT_MIN_LENGTH} caractères)` };
  }
  if (subject.length > EMAIL_SUBJECT_MAX_LENGTH) {
    return { ok: false, code: 'too_long', reason: `objet trop long (maximum ${EMAIL_SUBJECT_MAX_LENGTH} caractères)` };
  }
  return { ok: true, subject };
}

/**
 * Un objet déjà figé dans un payload est valide s'il l'aurait été à la
 * saisie **et** s'il est déjà sous sa forme canonique (rognée). Une valeur
 * stockée avec des espaces de bord serait envoyée telle quelle par un futur
 * sender : elle n'est donc pas « presque valide », elle est autre.
 */
function isStoredEmailSubjectValid(value: PayloadJson | undefined): boolean {
  if (typeof value !== 'string') return false;
  const result = validateEmailSubject(value);
  return result.ok && result.subject === value;
}

function isNonEmptyStringMap(value: PayloadJson | undefined): boolean {
  if (value === undefined || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, PayloadJson>);
  return entries.length > 0 && entries.every(([key, entry]) => key.length > 0 && typeof entry === 'string');
}

/**
 * §3 de la mission — les prérequis LIVE, centralisés ici et nulle part
 * ailleurs. Un transport absent de cette table ne compilerait pas
 * (`Record<Transport, …>` exhaustif) : ajouter un transport à la taxonomie
 * oblige à dire ce qu'un envoi réel exigerait de lui.
 *
 * L'état de chaque transport reflète ce qui est réellement établi aujourd'hui,
 * pas ce qu'on suppose de son avenir. En particulier `whatsapp` n'exige rien
 * ici : présumer un template ou une contrainte d'API WhatsApp reviendrait à
 * inscrire dans le code une règle que personne n'a vérifiée.
 */
export const TRANSPORT_LIVE_REQUIREMENTS: Readonly<Record<Transport, readonly LiveRequirement[]>> = Object.freeze({
  email: Object.freeze([
    Object.freeze({
      key: 'subject',
      kind: 'human_input',
      why: 'un email a un objet ; il n’est pas dans le corps approuvé et personne ne peut l’inventer à la place de l’humain',
      isSatisfied: (payload: TransportPayload) => isStoredEmailSubjectValid(payload.subject),
    }),
  ]),
  // Le corps approuvé suffit : un DM n'a ni objet, ni en-tête, ni champ
  // supplémentaire observé à ce jour.
  instagram_dm: Object.freeze([]),
  facebook_dm: Object.freeze([]),
  whatsapp: Object.freeze([]),
  // Aucun SMS n'est verrouillé à ce jour et aucune preuve SMS distincte d'un
  // numéro n'existe dans le pipeline (voir `resolveSmsOption`). Rien à exiger
  // tant que la question ne se pose pas réellement.
  sms: Object.freeze([]),
  web_form: Object.freeze([
    Object.freeze({
      key: 'form_field_mapping',
      kind: 'structured',
      why: 'avoir vu un <form> ne dit pas quel champ reçoit quoi ; soumettre sans ce mapping serait deviner',
      isSatisfied: (payload: TransportPayload) => isNonEmptyStringMap(payload.form_field_mapping),
    }),
  ]),
  phone_call: Object.freeze([
    Object.freeze({
      key: 'human_caller',
      kind: 'non_automatable',
      why: 'un appel est passé par une personne ; le texte approuvé est un script, pas un message qu’une machine délivre',
      // Jamais satisfaite, et sans clé de payload correspondante : il n'existe
      // donc aucune donnée à écrire qui rendrait un appel automatique
      // « prêt ». C'est l'intention, pas un oubli.
      isSatisfied: () => false,
    }),
  ]),
});

/**
 * Clés de payload qu'un transport accepte — dérivées des exigences, jamais
 * listées deux fois. Une exigence `non_automatable` n'en produit aucune :
 * rien ne peut la satisfaire, donc rien ne doit pouvoir prétendre le faire.
 */
function allowedPayloadKeys(transport: Transport): readonly string[] {
  return TRANSPORT_LIVE_REQUIREMENTS[transport]
    .filter((requirement) => requirement.kind !== 'non_automatable')
    .map((requirement) => requirement.key);
}

/**
 * Clés présentes dans le payload qu'un futur adapter de ce transport ne
 * saurait pas interpréter. Non vide = le payload transporte autre chose que
 * ce que le transport exige, ce qu'un dispatch doit refuser plutôt que
 * d'ignorer en silence.
 */
export function unsupportedPayloadKeys(transport: Transport, payload: TransportPayload): string[] {
  const allowed = new Set(allowedPayloadKeys(transport));
  return Object.keys(payload).filter((key) => !allowed.has(key));
}

// ---------------------------------------------------------------------------
// LIVE readiness
// ---------------------------------------------------------------------------

export interface LiveReadiness {
  readonly ready: boolean;
  /** Clés d'exigences non satisfaites, dans l'ordre de la table — stable, donc comparable d'un run à l'autre. */
  readonly missing: readonly string[];
}

/** Ce que `getLiveReadiness` a besoin de connaître : la structure figée, rien du prospect. */
export interface LiveReadinessSubject {
  readonly transport: Transport | null;
  readonly transportPayload: TransportPayload | null;
}

/**
 * §4 — lecture déterministe et purement locale d'un manifeste verrouillé.
 *
 * Ne lit ni la fiche prospect, ni `prospect_evidence`, ni le réseau, et
 * n'appelle aucun modèle : deux appels sur le même manifeste donnent le même
 * résultat, aujourd'hui et dans six mois.
 *
 * `ready = true` ne veut pas dire « envoyable ». Il n'existe aucun adapter
 * LIVE dans ce dépôt (`LIVE_ADAPTERS`, vide par construction) : un manifeste
 * prêt reste, en R6B-C.2A, exactement aussi incapable de contacter quelqu'un
 * qu'un manifeste incomplet. Cette fonction décrit un manifeste, elle
 * n'autorise rien.
 */
export function getLiveReadiness(subject: LiveReadinessSubject): LiveReadiness {
  const missing: string[] = [];

  if (subject.transport === null) {
    // Manifeste historique pré-0020 : aucun transport résolu, donc aucune
    // exigence à évaluer — et rien à envoyer.
    return { ready: false, missing: ['transport'] };
  }
  const payload = subject.transportPayload;
  if (payload === null) {
    return { ready: false, missing: ['transport_payload'] };
  }

  for (const requirement of TRANSPORT_LIVE_REQUIREMENTS[subject.transport]) {
    if (!requirement.isSatisfied(payload)) missing.push(requirement.key);
  }
  return { ready: missing.length === 0, missing };
}

/** Les exigences qu'un humain peut satisfaire par une saisie, pour ce transport. */
export function humanCompletableRequirements(transport: Transport): readonly LiveRequirement[] {
  return TRANSPORT_LIVE_REQUIREMENTS[transport].filter((requirement) => requirement.kind === 'human_input');
}

