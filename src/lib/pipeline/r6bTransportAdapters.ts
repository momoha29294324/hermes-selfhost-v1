import { ALL_TRANSPORTS, type Transport } from '@/lib/pipeline/r6bDispatch';
import {
  canonicalJson,
  getLiveReadiness,
  type PayloadJson,
  type TransportPayload,
} from '@/lib/pipeline/r6bTransportPayload';

/**
 * R6B-C.1 §5/§8 — l'enveloppe de dispatch et les adapters de transport.
 *
 * Ce module ne contient aucun client réseau et n'en importe aucun. Il ne sait
 * faire que deux choses, volontairement :
 *
 *   1. dire si un destinataire déjà figé a la forme qu'un futur adapter LIVE
 *      saurait adresser (`validateEnvelope`) — une vérification de forme, pas
 *      une re-sélection : le transport et le destinataire ont été choisis par
 *      un humain au moment du lock (R6B-B.1) et sont immuables ;
 *   2. montrer exactement ce qu'un futur adapter LIVE recevrait (`dryRun`).
 *
 * Ce que ce module ne fait pas, et ne doit jamais faire tant que R6B-C.2 n'a
 * pas été validée : envoyer, ouvrir une connexion, simuler une livraison,
 * fabriquer un identifiant de message ou un accusé de réception. Un DRY_RUN
 * qui inventerait un « delivered » serait un mensonge sur ce qui s'est passé.
 */

/**
 * §5 — dérivée exclusivement d'un manifeste LOCKED. Toutes les propriétés
 * sont `readonly` et l'objet est gelé à la construction : ni un appelant, ni
 * un adapter ne peut réécrire un destinataire ou un texte après coup.
 */
export interface DispatchEnvelope {
  readonly manifestId: string;
  readonly batchId: string;
  readonly batchItemId: string;
  readonly prospectId: string;

  readonly transport: Transport;
  readonly recipient: string;

  readonly approvedText: string;
  readonly approvedTextSha256: string;

  /**
   * R6B-C.2A — propriétés propres au transport, figées et vérifiées comme le
   * corps du message. Vide tant qu'aucune n'a été approuvée : un adapter n'y
   * trouvera jamais une valeur que personne n'a validée.
   */
  readonly transportPayload: TransportPayload;
  readonly transportPayloadSha256: string;

  readonly recipientEvidenceIds: readonly string[];
  readonly identityStatus: string;
}

/**
 * Ce qu'un DRY_RUN retourne : la forme du payload, jamais un résultat de
 * livraison. `networkAttempted` est typé `false` — le type lui-même interdit
 * à un adapter de cette mission de prétendre avoir touché le réseau.
 */
export interface DryRunPreview {
  readonly transport: Transport;
  readonly recipient: string;
  /**
   * Champs exacts qu'un futur adapter LIVE recevrait, dans son vocabulaire.
   * Les propriétés du payload transport y figurent sous leur nom d'adapter
   * (`subject` pour un email) et seulement si elles ont été approuvées — une
   * clé absente ici veut dire « jamais validée », jamais « valeur par défaut ».
   */
  readonly payloadFields: Readonly<Record<string, string>>;
  /**
   * Ce que le manifeste ne contient pas et qu'un envoi réel exigerait. Dit à
   * voix haute plutôt que comblé par un défaut inventé : un objet d'email ou
   * un mapping de champs de formulaire n'a jamais été approuvé par un opérateur,
   * donc personne ne peut le fabriquer ici (CLAUDE.md, interdit n°2).
   *
   * Lu depuis `TRANSPORT_LIVE_REQUIREMENTS` (R6B-C.2A), jamais recopié ici :
   * les exigences vivent à un seul endroit.
   */
  readonly missingForLive: readonly string[];
  /**
   * `missingForLive.length === 0`. Prêt ≠ autorisé : aucun adapter LIVE
   * n'existe dans ce dépôt, donc un manifeste prêt ne contacte personne.
   */
  readonly liveReady: boolean;
  readonly networkAttempted: false;
}

export interface TransportDryRunAdapter {
  readonly transport: Transport;
  /**
   * `null` si l'enveloppe est adressable en l'état, sinon la raison du refus.
   * Ne corrige jamais la valeur : un destinataire figé qui n'a pas la forme
   * attendue est un problème à remonter à un humain, pas à normaliser en
   * silence au moment de l'envoi.
   */
  validateEnvelope(envelope: DispatchEnvelope): string | null;
  /** Déterministe et purement local : aucun accès réseau, aucune horloge. */
  dryRun(envelope: DispatchEnvelope): DryRunPreview;
}

/** E.164 canonique — la seule forme qu'un futur composeur/messager accepterait sans deviner. */
const E164 = /^\+[1-9]\d{6,14}$/;
/** Handle Instagram tel qu'affiché, sans `@` ni URL : c'est ce que le lock a figé. */
export const INSTAGRAM_HANDLE = /^[A-Za-z0-9._]{1,30}$/;
const FACEBOOK_URL = /^https:\/\/(www\.|m\.)?facebook\.com\/[^\s]+$/;
const HTTP_URL = /^https?:\/\/[^\s]+$/;
/** Volontairement permissif sur la partie locale, strict sur l'absence d'espace et la présence d'un TLD. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Une propriété de payload rendue telle qu'un adapter la recevrait. Les
 * valeurs non textuelles (un mapping de champs de formulaire, par exemple)
 * sont rendues sous leur forme canonique — la même que celle qui a servi à
 * calculer `transport_payload_sha256` — pour qu'un DRY_RUN affiche
 * exactement ce qui a été haché, et pas une mise en forme approchante.
 */
function renderPayloadValue(value: PayloadJson): string {
  return typeof value === 'string' ? value : canonicalJson(value);
}

function shapeAdapter(
  transport: Transport,
  pattern: RegExp,
  expectation: string,
  recipientField: string,
  bodyField: string,
  /** Clé de payload → nom du champ dans le vocabulaire de l'adapter. */
  payloadFieldNames: Readonly<Record<string, string>>,
): TransportDryRunAdapter {
  return {
    transport,
    validateEnvelope(envelope) {
      if (envelope.transport !== transport) {
        return `adapter « ${transport} » appelé avec une enveloppe « ${envelope.transport} »`;
      }
      if (!pattern.test(envelope.recipient)) {
        return `destinataire figé « ${envelope.recipient} » non adressable en ${transport} — attendu : ${expectation}`;
      }
      if (envelope.approvedText.trim().length === 0) {
        return 'texte approuvé vide — rien à présenter à un adapter LIVE';
      }
      return null;
    },
    dryRun(envelope) {
      const fields: Record<string, string> = { [recipientField]: envelope.recipient };
      for (const [payloadKey, fieldName] of Object.entries(payloadFieldNames)) {
        const value = envelope.transportPayload[payloadKey];
        // Une propriété non approuvée reste absente du payload présenté.
        // La combler ici — même par une chaîne vide — inventerait une donnée.
        if (value !== undefined) fields[fieldName] = renderPayloadValue(value);
      }
      fields[bodyField] = envelope.approvedText;

      const readiness = getLiveReadiness(envelope);
      return {
        transport,
        recipient: envelope.recipient,
        payloadFields: Object.freeze(fields),
        missingForLive: readiness.missing,
        liveReady: readiness.ready,
        networkAttempted: false,
      };
    },
  };
}

/**
 * Taxonomie complète de R6B-B.1 (§8 de R6B-C.1). `Record<Transport, …>`
 * plutôt qu'un `Partial` : ajouter un transport à la taxonomie casse la
 * compilation tant qu'aucun adapter ne le couvre, plutôt que de le laisser
 * échouer à l'exécution devant un manifeste déjà verrouillé.
 *
 * Ce que chaque adapter déclare ici est seulement la traduction d'une clé de
 * payload en nom de champ. Ce qu'un envoi réel *exige*, lui, vit dans
 * `TRANSPORT_LIVE_REQUIREMENTS` (R6B-C.2A) : deux listes divergentes seraient
 * deux vérités, et un futur `missingForLive` faux.
 */
export const DRY_RUN_ADAPTERS: Readonly<Record<Transport, TransportDryRunAdapter>> = Object.freeze({
  // L'objet, une fois approuvé, arrive à l'adapter sous le nom `subject`.
  // Tant qu'il ne l'est pas, `missingForLive` le dit et le champ reste absent.
  email: shapeAdapter('email', EMAIL, 'une adresse email', 'to', 'body', { subject: 'subject' }),
  instagram_dm: shapeAdapter(
    'instagram_dm',
    INSTAGRAM_HANDLE,
    'un handle Instagram sans « @ » ni URL',
    'to_handle',
    'body',
    {},
  ),
  facebook_dm: shapeAdapter('facebook_dm', FACEBOOK_URL, 'une URL de page facebook.com', 'to_page_url', 'body', {}),
  web_form: shapeAdapter(
    'web_form',
    HTTP_URL,
    'une URL de page portant le formulaire observé',
    'form_page_url',
    'body',
    // Quels champs du formulaire recevraient quoi n'a jamais été observé ni
    // approuvé : le crawler a seulement constaté qu'un `<form>` existe.
    { form_field_mapping: 'form_field_mapping' },
  ),
  sms: shapeAdapter('sms', E164, 'un numéro E.164', 'to_msisdn', 'body', {}),
  whatsapp: shapeAdapter('whatsapp', E164, 'un numéro E.164', 'to_msisdn', 'body', {}),
  // Un appel n'est pas un envoi automatisable : le texte approuvé est un
  // script pour un humain, pas un message qu'une machine délivre. Aucune clé
  // de payload ne peut donc le rendre « prêt » (`human_caller` n'en a pas).
  phone_call: shapeAdapter('phone_call', E164, 'un numéro E.164', 'to_msisdn', 'script', {}),
});

/**
 * R6B-C.2B / IG2 — quels transports possèdent un adapter LIVE réel.
 *
 * En R6B-C.1 ce registre était typé `Partial<Record<Transport, never>>` :
 * littéralement impossible à remplir, pour qu'autoriser un envoi soit un
 * changement de type visible en revue plutôt qu'une case cochée. R6B-C.2B l'a
 * ouvert pour `email`, IG2 l'ouvre pour `instagram_dm` — le premier DM du
 * canari mono-manifeste. Les cinq autres transports n'ont toujours aucun code
 * capable de contacter qui que ce soit : pas un adapter désactivé, pas une clé
 * absente — rien à appeler.
 *
 * Ce registre déclare une CAPACITÉ, jamais une permission, et les deux chemins
 * le montrent : `email` doit encore passer la triple garde de `r6bLiveDispatch`,
 * `instagram_dm` doit encore passer l'arrêt global, les plafonds et une
 * autorisation canari nominative consommée atomiquement. Un transport « capable »
 * dont personne n'a rien armé n'envoie rien.
 *
 * `Record<Transport, boolean>` exhaustif plutôt qu'un `Partial` : ajouter un
 * transport à la taxonomie ne compile pas tant que la question « celui-ci
 * peut-il envoyer ? » n'a pas reçu une réponse écrite.
 */
export const LIVE_CAPABLE_TRANSPORTS: Readonly<Record<Transport, boolean>> = Object.freeze({
  email: true,
  instagram_dm: true,
  facebook_dm: false,
  web_form: false,
  sms: false,
  whatsapp: false,
  phone_call: false,
});

export function hasLiveAdapter(transport: Transport): boolean {
  return LIVE_CAPABLE_TRANSPORTS[transport];
}

/** Les transports réellement envoyables aujourd'hui — vérifié par les tests, pas supposé. */
export function liveCapableTransports(): readonly Transport[] {
  return ALL_TRANSPORTS.filter((transport) => LIVE_CAPABLE_TRANSPORTS[transport]);
}
