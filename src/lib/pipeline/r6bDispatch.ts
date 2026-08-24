import { randomUUID } from 'node:crypto';
import type { Sql } from '@/lib/db/sql';
import { loadLatestVotes } from '@/lib/pipeline/r6bBatch';
import { normalizePhone } from '@/lib/identity/normalize';
import {
  EMPTY_TRANSPORT_PAYLOAD,
  hashTransportPayload,
  readTransportPayload,
  type TransportPayload,
} from '@/lib/pipeline/r6bTransportPayload';
import { sha256Hex } from '@/lib/util/hash';
import { loadCommercialIntelligenceProfile, loadConfiguredIcpProfile } from '@/lib/config/load';
import { assessAudienceScaleForProspect } from '@/lib/pipeline/audienceObservation';
import { loadIcpInputs, recordIcpAssessment } from '@/lib/pipeline/icpAssessment';
import { evaluateIcpEligibility, icpLockRefusal } from '@/lib/pipeline/icpEligibility';
import {
  contactsOnChannel,
  describeLink,
  loadBusinessContactHistory,
} from '@/lib/pipeline/businessContactGuard';

/**
 * R6B-B / R6B-B.1 — manifeste de dispatch (missions « Hermes
 * R6B-B » et « R6B-B.1 — Transport Normalization »).
 *
 * Ce module ne décide jamais un transport ni un destinataire à la place de
 * un opérateur (§4/§5/§9 de R6B-B.1 : « Ne jamais inférer un transport » /
 * « Ne choisis PAS à la place de un opérateur »). Il fait deux choses :
 *
 *   1. Répondre honnêtement à « qu'est-ce qui est réellement observable et
 *      vérifiable pour ce prospect ? » (`resolveTransportOptions`,
 *      `resolveIdentityAudit`) — jamais une supposition présentée comme un
 *      fait (CLAUDE.md, interdit n°2). Un numéro de téléphone observé ne
 *      prouve par construction qu'un appel (`phone_call`) ; un SMS ou un
 *      WhatsApp exigent chacun une preuve distincte de la simple présence du
 *      numéro (R6B-B.1 §4 — jamais « numéro observé → donc SMS/WhatsApp »).
 *   2. Figer, une fois que un opérateur a choisi, exactement ce qu'un futur envoi
 *      devra reproduire (`lockManifestForItem`) — jamais un envoi lui-même.
 *      Aucune fonction ici n'ouvre de connexion réseau, n'appelle un
 *      provider d'envoi, ni n'écrit dans `outreach_events`.
 */

/** R6B-B.1 §2 : taxonomie cible — un transport représente une action d'envoi concrète. */
export type Transport = 'email' | 'instagram_dm' | 'facebook_dm' | 'web_form' | 'sms' | 'whatsapp' | 'phone_call';

export const ALL_TRANSPORTS: readonly Transport[] = [
  'email',
  'instagram_dm',
  'facebook_dm',
  'web_form',
  'sms',
  'whatsapp',
  'phone_call',
];

export interface DispatchProspect {
  id: string;
  displayName: string;
  legalName: string | null;
  city: string | null;
  email: string | null;
  phone: string | null;
  websiteUrl: string | null;
  instagramHandle: string | null;
  facebookUrl: string | null;
  identityReview: 'confirmed' | 'manual_review' | 'uncertain' | null;
}

export interface DispatchEvidenceRow {
  id: string;
  field: string;
  valueText: string | null;
  provider: string;
  method: string;
  sourceUrl: string | null;
  confidence: number;
  observedAt: string;
}

export interface RecipientProvenance {
  field: string;
  provider: string;
  method: string;
  sourceUrl: string | null;
  confidence: number;
  observedAt: string;
}

export interface TransportOption {
  transport: Transport;
  recipient: string | null;
  recipientEvidenceIds: string[];
  provenance: RecipientProvenance | null;
  /** `verified` seul autorise un lock (§4/§5/§6 : jamais deviner, jamais inférer). */
  status: 'verified' | 'unresolved';
  reason: string;
}

/**
 * Un canal observé au moment de la génération du batch (email/phone/
 * website/instagram/facebook, gelé dans `r6b_batch_items.contact_channels`)
 * borne quels transports peuvent même être proposés : un transport dont le
 * canal de base n'a pas été observé n'apparaît pas du tout (jamais un canal
 * que la fiche prospect porterait aujourd'hui mais qui n'était pas là quand
 * le texte a été approuvé). Ceci ne prouve rien à lui seul — chaque
 * transport a ensuite besoin de sa propre preuve concrète, voir les
 * résolveurs ci-dessous.
 */
const TRANSPORT_BASE_CHANNEL: Record<Transport, string> = {
  email: 'email',
  instagram_dm: 'instagram',
  facebook_dm: 'facebook',
  web_form: 'website',
  sms: 'phone',
  whatsapp: 'phone',
  phone_call: 'phone',
};

/**
 * Champ `prospect_evidence` qui corrobore un transport lié directement à un
 * champ de la fiche prospect (email, réseau social, numéro appelé). §4 :
 * `phone_call` est le seul transport que le champ `phone` prouve par
 * construction — dialer un numéro observé est ce que « téléphone » veut dire
 * par défaut. `sms` et `whatsapp` n'ont pas d'entrée ici : ce sont des
 * capacités distinctes du numéro, jamais prouvées par sa seule présence
 * (voir `resolveWhatsappOption`/`resolveSmsOption`).
 */
const FIELD_BACKED_TRANSPORT: Partial<Record<Transport, { field: string; currentValue: (p: DispatchProspect) => string | null }>> = {
  email: { field: 'email', currentValue: (p) => p.email },
  instagram_dm: { field: 'instagram_handle', currentValue: (p) => p.instagramHandle },
  facebook_dm: { field: 'facebook_url', currentValue: (p) => p.facebookUrl },
  phone_call: { field: 'phone', currentValue: (p) => p.phone },
};

/**
 * R6B-B.1 §5 (correction post-revue) : un destinataire `phone_call` doit être
 * l'adresse E.164 exacte qu'un futur sender composerait, jamais la valeur
 * brute stockée (qui peut porter un format source ambigu, ex. `+33 0773...`
 * saisi par le prospect lui-même). `currentValue`/l'evidence gardent leur
 * forme brute inchangée — seul le `recipient` retourné ici est canonicalisé.
 * Générique par champ, jamais un cas particulier d'un prospect donné.
 */
const RECIPIENT_CANONICALIZER: Partial<Record<Transport, (value: string) => string | null>> = {
  phone_call: (value) => normalizePhone(value),
};

function resolveFieldBackedOption(
  transport: Transport,
  field: string,
  currentValue: string | null,
  evidence: readonly DispatchEvidenceRow[],
): TransportOption {
  if (!currentValue) {
    return {
      transport,
      recipient: null,
      recipientEvidenceIds: [],
      provenance: null,
      status: 'unresolved',
      reason: 'canal observé à la génération du batch, mais plus aucune valeur sur la fiche prospect',
    };
  }

  const match = evidence
    .filter((row) => row.field === field && row.valueText === currentValue)
    .sort((a, b) => (a.observedAt < b.observedAt ? 1 : -1))[0];

  if (!match) {
    return {
      transport,
      recipient: currentValue,
      recipientEvidenceIds: [],
      provenance: null,
      status: 'unresolved',
      reason: 'aucune ligne prospect_evidence ne corrobore exactement cette valeur — jamais devinée',
    };
  }

  const canonicalize = RECIPIENT_CANONICALIZER[transport];
  const recipient = canonicalize ? canonicalize(currentValue) : currentValue;
  if (!recipient) {
    return {
      transport,
      recipient: null,
      recipientEvidenceIds: [match.id],
      provenance: null,
      status: 'unresolved',
      reason: 'valeur corroborée par une preuve, mais non normalisable en destinataire fiable — jamais devinée',
    };
  }

  return {
    transport,
    recipient,
    recipientEvidenceIds: [match.id],
    provenance: {
      field: match.field,
      provider: match.provider,
      method: match.method,
      sourceUrl: match.sourceUrl,
      confidence: match.confidence,
      observedAt: match.observedAt,
    },
    status: 'verified',
    reason: 'valeur corroborée par une preuve observée',
  };
}

interface FunnelToken {
  key: string;
  value: string;
  evidenceId: string;
  sourceUrl: string | null;
  observedAt: string;
  provider: string;
  method: string;
  confidence: number;
}

/**
 * `prospect_evidence.field = 'funnel_observed'` porte une ligne de jetons
 * `clé: valeur` séparés par « | » (voir `webintel` funnel crawler) — la
 * seule source qui prouve qu'un élément concret (formulaire, lien
 * WhatsApp...) a été réellement lu sur une page, pas seulement supposé
 * parce qu'un site existe. Analyse déterministe, jamais un prompt.
 */
function parseFunnelTokens(evidence: readonly DispatchEvidenceRow[]): FunnelToken[] {
  const tokens: FunnelToken[] = [];
  for (const row of evidence) {
    if (row.field !== 'funnel_observed' || !row.valueText) continue;
    for (const segment of row.valueText.split('|')) {
      const trimmed = segment.trim();
      const sep = trimmed.indexOf(':');
      if (sep === -1) continue;
      tokens.push({
        key: trimmed.slice(0, sep).trim(),
        value: trimmed.slice(sep + 1).trim(),
        evidenceId: row.id,
        sourceUrl: row.sourceUrl,
        observedAt: row.observedAt,
        provider: row.provider,
        method: row.method,
        confidence: row.confidence,
      });
    }
  }
  return tokens;
}

/**
 * §3 : `site` ne donne `web_form` que si un formulaire réellement utilisable
 * a été observé — un CTA « contactez-nous » seul ne le prouve pas. Le
 * jeton `form_contact` n'existe que quand le crawler a lu un `<form>` réel
 * sur la page (voir `funnel_not_observed` qui liste `form_contact` comme
 * cherché-et-absent quand ce n'est pas le cas). Le destinataire retenu est
 * l'URL exacte de la page qui porte ce formulaire — la seule URL qu'on peut
 * affirmer sans inventer une action de formulaire relative non résolue.
 */
function resolveWebFormOption(tokens: readonly FunnelToken[]): TransportOption {
  const formTokens = tokens.filter((t) => t.key === 'form_contact');
  if (formTokens.length === 0) {
    return {
      transport: 'web_form',
      recipient: null,
      recipientEvidenceIds: [],
      provenance: null,
      status: 'unresolved',
      reason:
        'aucun formulaire de contact réellement observé sur le site — un CTA « contactez-nous » seul ne suffit pas (§3)',
    };
  }
  const chosen = formTokens[0]!;
  if (!chosen.sourceUrl) {
    return {
      transport: 'web_form',
      recipient: null,
      recipientEvidenceIds: formTokens.map((t) => t.evidenceId),
      provenance: null,
      status: 'unresolved',
      reason: 'formulaire observé mais sans URL de page source exploitable',
    };
  }
  return {
    transport: 'web_form',
    recipient: chosen.sourceUrl,
    recipientEvidenceIds: formTokens.map((t) => t.evidenceId),
    provenance: {
      field: 'funnel_observed:form_contact',
      provider: chosen.provider,
      method: chosen.method,
      sourceUrl: chosen.sourceUrl,
      confidence: chosen.confidence,
      observedAt: chosen.observedAt,
    },
    status: 'verified',
    reason: `formulaire de contact observé (${chosen.value})`,
  };
}

/**
 * Les liens WhatsApp encodent déjà l'indicatif pays dans les chiffres
 * (`wa.me/33773472833`) — jamais un `0` national. Passé tel quel par
 * `normalizePhone` pour bénéficier de la même correction/garde-fou qu'un
 * numéro `phone_call` (ex. un prospect qui a mal renseigné son lien avec le
 * `0` national conservé), plutôt qu'un simple préfixage `+` sans validation.
 */
function extractWhatsappRecipient(value: string): string | null {
  const match = value.match(/(?:phone=|wa\.me\/)(\d{6,15})/);
  if (!match) return null;
  return normalizePhone(`+${match[1]}`);
}

/**
 * §3/§4 : `téléphone` ne donne `whatsapp` que si un lien WhatsApp
 * (`wa.me`/`api.whatsapp.com`) a réellement été observé sur le site — jamais
 * parce qu'un numéro existe. Le jeton `cta_whatsapp` ne peut venir que d'un
 * tel lien effectivement lu par le crawler.
 */
function resolveWhatsappOption(tokens: readonly FunnelToken[]): TransportOption {
  const waTokens = tokens.filter((t) => t.key === 'cta_whatsapp');
  if (waTokens.length === 0) {
    return {
      transport: 'whatsapp',
      recipient: null,
      recipientEvidenceIds: [],
      provenance: null,
      status: 'unresolved',
      reason:
        'aucun lien WhatsApp (wa.me / api.whatsapp.com) observé sur le site — un numéro de téléphone seul ne suffit pas (§4)',
    };
  }
  const chosen = waTokens[0]!;
  const recipient = extractWhatsappRecipient(chosen.value);
  if (!recipient) {
    return {
      transport: 'whatsapp',
      recipient: null,
      recipientEvidenceIds: [chosen.evidenceId],
      provenance: null,
      status: 'unresolved',
      reason: 'lien WhatsApp observé mais numéro illisible dans l’URL',
    };
  }
  return {
    transport: 'whatsapp',
    recipient,
    recipientEvidenceIds: [chosen.evidenceId],
    provenance: {
      field: 'funnel_observed:cta_whatsapp',
      provider: chosen.provider,
      method: chosen.method,
      sourceUrl: chosen.sourceUrl,
      confidence: chosen.confidence,
      observedAt: chosen.observedAt,
    },
    status: 'verified',
    reason: `lien WhatsApp observé (${chosen.value})`,
  };
}

/**
 * §4 : aucune ligne `prospect_evidence` de ce dépôt ne distingue jamais un
 * numéro « SMS » d'un numéro « appel » — le crawler ne cherche même pas ce
 * signal (voir `funnel_not_observed`, qui n'énumère pas de jeton SMS).
 * `sms` reste donc systématiquement `unresolved` tant qu'aucune preuve
 * distincte n'existe dans le pipeline — jamais inféré depuis un numéro seul.
 */
function resolveSmsOption(): TransportOption {
  return {
    transport: 'sms',
    recipient: null,
    recipientEvidenceIds: [],
    provenance: null,
    status: 'unresolved',
    reason: 'aucune preuve SMS distincte du numéro de téléphone — jamais inférée depuis un numéro observé (§4)',
  };
}

/**
 * R6B-B.1 §2/§3/§4 : transports explicites plutôt que canaux génériques.
 * Chaque transport proposé a sa propre preuve concrète — jamais dérivé
 * automatiquement d'un autre transport qui partage le même champ prospect.
 */
export function resolveTransportOptions(
  observedChannels: readonly string[],
  prospect: DispatchProspect,
  evidence: readonly DispatchEvidenceRow[],
): TransportOption[] {
  const observed = new Set(observedChannels);
  const tokens = parseFunnelTokens(evidence);
  const options: TransportOption[] = [];

  for (const transport of ALL_TRANSPORTS) {
    if (!observed.has(TRANSPORT_BASE_CHANNEL[transport])) continue; // canal de base jamais observé — transport jamais proposé

    const fieldBacked = FIELD_BACKED_TRANSPORT[transport];
    if (fieldBacked) {
      options.push(resolveFieldBackedOption(transport, fieldBacked.field, fieldBacked.currentValue(prospect), evidence));
      continue;
    }
    if (transport === 'web_form') {
      options.push(resolveWebFormOption(tokens));
      continue;
    }
    if (transport === 'whatsapp') {
      options.push(resolveWhatsappOption(tokens));
      continue;
    }
    if (transport === 'sms') {
      options.push(resolveSmsOption());
    }
  }

  return options;
}

export interface IdentityAudit {
  displayName: string;
  legalName: string | null;
  /** Nom commercial tel qu'observé sur le site (titre de page récurrent). */
  observedTradingName: string | null;
  /** Nom à présenter à l'humain — le plus parlant des deux (§7). */
  businessNameForDisplay: string;
  identityReview: 'confirmed' | 'manual_review' | 'uncertain';
  /** Le nom interne et le nom observé sur le site ne partagent aucun mot significatif. */
  nameMismatch: boolean;
  /** §6 : mismatch non résolu par une identité légale confirmée → bloque le lock. */
  ambiguous: boolean;
  reasons: string[];
}

const STOPWORDS = new Set(['LE', 'LA', 'LES', 'DE', 'DU', 'DES', 'ET', 'A', 'AU', 'AUX']);

function significantTokens(name: string): Set<string> {
  const normalized = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
  return new Set(normalized.split(' ').filter((token) => token.length >= 3 && !STOPWORDS.has(token)));
}

/**
 * Segment de `<title>` qui revient dans au moins la moitié des pages lues —
 * la marque affichée au client plutôt que la tagline de chaque page (§6).
 * Purement descriptif : sert à l'affichage humain et à détecter un désaccord
 * avec le nom interne, jamais à décider seul qu'une identité est correcte.
 */
export function deriveObservedTradingName(evidence: readonly DispatchEvidenceRow[]): string | null {
  const titles = evidence.filter((row) => row.field === 'website_title' && row.valueText);
  if (titles.length === 0) return null;

  const segmentCounts = new Map<string, number>();
  for (const row of titles) {
    const segments = new Set(
      (row.valueText ?? '')
        .split(/[|\-:]/)
        .map((segment) => segment.trim())
        .filter((segment) => segment.length >= 3),
    );
    for (const segment of segments) {
      segmentCounts.set(segment, (segmentCounts.get(segment) ?? 0) + 1);
    }
  }

  let best: string | null = null;
  let bestCount = 0;
  for (const [segment, count] of segmentCounts) {
    if (count > bestCount || (count === bestCount && best !== null && segment.length < best.length)) {
      best = segment;
      bestCount = count;
    }
  }
  if (best === null || bestCount < Math.ceil(titles.length / 2)) return null;
  return best;
}

export function resolveIdentityAudit(
  prospect: DispatchProspect,
  evidence: readonly DispatchEvidenceRow[],
): IdentityAudit {
  const observedTradingName = deriveObservedTradingName(evidence);
  const identityReview = prospect.identityReview ?? 'uncertain';
  const reasons: string[] = [];

  let nameMismatch = false;
  if (observedTradingName) {
    const internalTokens = significantTokens(prospect.legalName ?? prospect.displayName);
    const observedTokens = significantTokens(observedTradingName);
    const overlap = [...internalTokens].some((token) => observedTokens.has(token));
    nameMismatch = !overlap;
    if (nameMismatch) {
      reasons.push(
        `nom interne « ${prospect.displayName} » et nom commercial observé sur le site « ${observedTradingName} » ne partagent aucun mot significatif`,
      );
    }
  }

  const ambiguous = nameMismatch && identityReview !== 'confirmed';
  if (ambiguous) {
    reasons.push('désaccord de nom non résolu par une identité légale confirmée (SIREN/SIRET publié) — dispatch bloqué');
  } else if (nameMismatch) {
    reasons.push('désaccord de nom résolu : identité légale confirmée relie les deux noms — les deux sont affichés');
  }

  return {
    displayName: prospect.displayName,
    legalName: prospect.legalName,
    observedTradingName,
    businessNameForDisplay: observedTradingName ?? prospect.displayName,
    identityReview,
    nameMismatch,
    ambiguous,
    reasons,
  };
}

export { sha256Hex };

export interface DispatchManifest {
  id: string;
  batchId: string;
  batchItemId: string;
  prospectId: string;
  approvalVoteId: string;
  businessName: string;
  legalName: string | null;
  /** Nul sur tout manifeste créé après R6B-B.1 : voir `transport`. Préservé pour les lignes historiques (§7). */
  legacyChannel: string | null;
  transport: Transport | null;
  recipient: string;
  recipientProvenance: RecipientProvenance;
  recipientEvidenceIds: string[];
  identityReview: 'confirmed' | 'manual_review' | 'uncertain';
  approvedText: string;
  approvedTextSha256: string;
  /**
   * R6B-C.2A — propriétés propres au transport, figées comme le reste
   * (`{ subject }` pour un email). `null` signale un `jsonb` que
   * `readTransportPayload` refuse : le dispatcher bloque alors, il ne devine
   * pas. Vide sur tout manifeste verrouillé avant la complétion humaine.
   */
  transportPayload: TransportPayload | null;
  transportPayloadSha256: string;
  hookType: string | null;
  hookEvidenceIds: string[];
  status: 'LOCKED' | 'SUPERSEDED';
  supersededBy: string | null;
  supersededAt: string | null;
  supersededReason: string | null;
  lockedAt: string;
}

export interface DispatchContext {
  batchId: string;
  itemId: string;
  observedChannels: string[];
  hookEvidenceIds: string[];
  hookType: string | null;
  prospect: DispatchProspect;
  evidence: DispatchEvidenceRow[];
}

export async function loadDispatchContext(sql: Sql, itemId: string): Promise<DispatchContext | null> {
  const rows = await sql.query<{
    batchId: string;
    prospectId: string;
    contactChannels: unknown;
    hookEvidenceIds: unknown;
    hookType: string | null;
    displayName: string;
    legalName: string | null;
    city: string | null;
    email: string | null;
    phone: string | null;
    websiteUrl: string | null;
    instagramHandle: string | null;
    facebookUrl: string | null;
    identityReview: 'confirmed' | 'manual_review' | 'uncertain' | null;
  }>(
    `select bi.batch_id as "batchId", bi.prospect_id as "prospectId",
            bi.contact_channels as "contactChannels", bi.hook_evidence_ids as "hookEvidenceIds",
            a.approach as "hookType",
            p.display_name as "displayName", p.legal_name as "legalName", p.city,
            p.email, p.phone, p.website_url as "websiteUrl",
            p.instagram_handle as "instagramHandle", p.facebook_url as "facebookUrl",
            p.identity_review as "identityReview"
       from r6b_batch_items bi
       join prospects p on p.id = bi.prospect_id
       left join prospect_angles a on a.id = bi.angle_id
      where bi.id = $1`,
    [itemId],
  );
  const row = rows[0];
  if (!row) return null;

  const evidenceRows = await sql.query<{
    id: string;
    field: string;
    valueText: string | null;
    provider: string;
    method: string;
    sourceUrl: string | null;
    confidence: number;
    observedAt: string;
  }>(
    `select id, field, value_text as "valueText", provider, method, source_url as "sourceUrl",
            confidence, observed_at as "observedAt"
       from prospect_evidence where prospect_id = $1`,
    [row.prospectId],
  );

  return {
    batchId: row.batchId,
    itemId,
    observedChannels: Array.isArray(row.contactChannels) ? row.contactChannels.map(String) : [],
    hookEvidenceIds: Array.isArray(row.hookEvidenceIds) ? row.hookEvidenceIds.map(String) : [],
    hookType: row.hookType,
    prospect: {
      id: row.prospectId,
      displayName: row.displayName,
      legalName: row.legalName,
      city: row.city,
      email: row.email,
      phone: row.phone,
      websiteUrl: row.websiteUrl,
      instagramHandle: row.instagramHandle,
      facebookUrl: row.facebookUrl,
      identityReview: row.identityReview,
    },
    evidence: evidenceRows,
  };
}

export class DispatchLockError extends Error {
  readonly code:
    | 'not_approved'
    | 'transport_not_available'
    | 'recipient_unresolved'
    | 'identity_ambiguity'
    | 'item_not_found'
    /** ICP-R1 — l'entreprise n'est pas du type que Hermes adresse (réseau, franchise, multi-sites). */
    | 'icp_not_target'
    /** ICP-R1 — un signal d'éligibilité demande une décision humaine nommée avant tout verrouillage. */
    | 'icp_review_required'
    /** R7-PILOT §1 — une AUTRE ligne du même commerce a déjà reçu un message sur ce transport. */
    | 'identity_already_contacted'
    /** R7-PILOT §1 — une AUTRE ligne du même commerce figure dans `do_not_contact`. */
    | 'identity_suppressed'
    /**
     * R7.6-GATE — l'audience sociale ATTRIBUÉE dépasse le créneau que nous
     * savons servir. Distinct d'`icp_not_target` : une entreprise trop grande
     * n'est pas une franchise, et confondre les deux rendrait les deux refus
     * illisibles.
     */
    | 'audience_out_of_scope';
  constructor(code: DispatchLockError['code'], message: string) {
    super(message);
    this.name = 'DispatchLockError';
    this.code = code;
  }
}

export interface LockManifestInput {
  itemId: string;
  transport: Transport;
}

/**
 * Verrouille un manifeste (§7/§8 de R6B-B.1 « LOCK FOR FUTURE SEND »). Ne
 * contacte personne : une transaction SQL, jamais un appel réseau. Le
 * destinataire n'est jamais pris depuis un formulaire — toujours redérivé
 * côté serveur depuis la fiche prospect + `prospect_evidence`, exactement
 * comme `resolveTransportOptions` l'aurait calculé pour l'affichage (§5 :
 * jamais deviner, jamais faire confiance à une valeur venue du client).
 */
/**
 * ICP-R1 — évalue l'éligibilité commerciale, l'archive, et refuse si besoin.
 *
 * Trois choses se passent ici, dans cet ordre, et l'ordre est le sujet :
 *
 *   1. le verdict est **calculé** sur les preuves courantes — jamais lu dans une
 *      table, pour qu'il n'existe aucun chemin où le gate n'est pas évalué ;
 *   2. il est **journalisé**, refus comme accord. Un `GOOD_ICP` archivé est ce
 *      qui permettra plus tard de dire ce que nous savions au moment du lock ;
 *   3. il **refuse**, sauf si une décision humaine plus récente dit le
 *      contraire.
 *
 * Le point 3 mérite d'être défendu : autoriser une levée humaine, n'est-ce pas
 * rouvrir exactement la porte par laquelle DEMO PROSPECT A est passé ? Non, et la
 * différence est entièrement dans la trace. Ce jour-là, le doute a été levé
 * dans une phrase de justification en constante TypeScript, invisible en base,
 * non datée, non signée, et qui n'a jamais eu à nommer ce qu'elle écartait.
 * Ici, une levée est une ligne de `prospect_icp_assessments` portant un nom
 * d'humain (la base refuse « system », « agent », « claude »), une date, et le
 * verdict automatique qu'elle contredit reste juste à côté, intact.
 */
async function enforceIcpEligibility(sql: Sql, context: DispatchContext): Promise<void> {
  const profile = loadConfiguredIcpProfile();
  const inputs = await loadIcpInputs(sql, [context.prospect.id]);
  const input = inputs[0];
  if (!input) {
    // Le prospect a disparu entre le chargement du contexte et ici. Refuser
    // bruyamment plutôt que verrouiller sur une entité qu'on ne peut plus lire.
    throw new DispatchLockError('item_not_found', `prospect ${context.prospect.id} introuvable à l'évaluation ICP`);
  }

  const assessment = evaluateIcpEligibility({ subject: input.subject, evidence: input.evidence, profile });
  await recordIcpAssessment(sql, {
    prospectId: context.prospect.id,
    assessment,
    decidedBy: 'deterministic',
    assessedBy: 'r6b_manifest_lock',
  });

  const refusal = icpLockRefusal(assessment);
  if (refusal === null) return;

  // Une levée humaine, si elle existe et si elle est postérieure au dernier
  // verdict automatique, l'emporte — parce qu'elle est plus récente, pas parce
  // qu'un humain aurait le droit d'effacer une machine. La ligne que nous
  // venons d'écrire étant la plus récente, on cherche la dernière décision
  // HUMAINE explicitement.
  const override = await loadLatestHumanIcpDecision(sql, context.prospect.id);
  if (override?.verdict === 'GOOD_ICP') return;

  throw new DispatchLockError(
    refusal,
    `${assessment.reason} — verrouillage refusé. ` +
      `Lever ce refus demande une décision humaine nommée (npm run icp:audit -- --decide <prospect> --verdict GOOD_ICP --as "<nom>").`,
  );
}

/**
 * R7.6-GATE — la taille de l'entreprise, juste après son type.
 *
 * ---------------------------------------------------------------------------
 * Ce que cette garde répare
 * ---------------------------------------------------------------------------
 * L'échelle d'audience est une règle métier écrite, publiée et testée depuis
 * R7.6 : au-delà du seuil de `config/commercial-intelligence/*.json`, un compte
 * ATTRIBUÉ décrit une entreprise déjà installée sur son canal, hors du créneau.
 * `assessTargetEligibility` la transforme en `OUT_OF_SCOPE` depuis ce jour-là.
 *
 * Elle n'atteignait pourtant aucune porte d'envoi : `assessScalableOpportunity`
 * n'est appelée que par le rail d'ANALYSE R7. Le 21 août 2026,
 * @demo_account_09 — 20 179 abonnés, identité MATCH, observation datée du 19 —
 * est entré dans un batch de review humaine. Ni la donnée ni la règle ne
 * manquaient : personne ne les mettait en présence l'une de l'autre.
 *
 * ---------------------------------------------------------------------------
 * Ici ET dans la file, pour la même raison qu'`enforceIdentityContactGuard`
 * ---------------------------------------------------------------------------
 * Un manifeste `LOCKED` se lit comme « prêt à partir ». Le laisser exister pour
 * une entreprise hors créneau, puis ne refuser qu'à l'enfilement, ferait vivre
 * un objet qui affirme le contraire de ce qui est vrai. Le refus est donc posé
 * ici ET dans `evaluateInstagramEligibility`, avec la MÊME lecture — le
 * prédicat `audienceIsOutOfScope`, écrit une fois.
 *
 * ---------------------------------------------------------------------------
 * Ce qu'elle refuse de faire
 * ---------------------------------------------------------------------------
 * Refuser sur une ABSENCE. Un prospect dont personne n'a ouvert le profil
 * social, ou dont le compte n'est pas attribué, passe cette porte : la bande
 * est `UNKNOWN`, et `UNKNOWN` n'a jamais voulu dire `OUT_OF_SCOPE` (R7.6, et
 * CLAUDE.md §2). Faire de l'absence d'observation un refus exclurait tout
 * prospect sans Instagram observé — ce que le §20 de R7.6 interdit nommément.
 */
async function enforceAudienceScale(sql: Sql, context: DispatchContext): Promise<void> {
  const profile = loadCommercialIntelligenceProfile();
  const verdict = await assessAudienceScaleForProspect(sql, context.prospect.id, profile.opportunity);
  if (!verdict.excluded) return;

  const observed = verdict.observed;
  throw new DispatchLockError(
    'audience_out_of_scope',
    `${verdict.scale.detail}` +
      (observed === null
        ? ''
        : ` (compte @${observed.handle}, lu le ${observed.observedAt}, source « ${observed.source} »)`) +
      ' — verrouillage refusé. Le seuil vit dans ' +
      `config/commercial-intelligence/${profile.key}.json ` +
      '(`opportunity.audience.outOfSweetSpotAtOrAbove`) et le déplacer est une décision humaine.',
  );
}

/** La dernière décision prise par un humain, indépendamment des verdicts automatiques qui l'entourent. */
async function loadLatestHumanIcpDecision(
  sql: Sql,
  prospectId: string,
): Promise<{ verdict: string; assessedBy: string; createdAt: string } | null> {
  const rows = await sql.query<{ verdict: string; assessedBy: string; createdAt: string }>(
    `select verdict, assessed_by as "assessedBy", created_at as "createdAt"
       from prospect_icp_assessments
      where prospect_id = $1 and decided_by = 'human'
      order by created_at desc, id desc
      limit 1`,
    [prospectId],
  );
  return rows[0] ?? null;
}

/**
 * R7-PILOT §1 — verrouiller pour un commerce qu'on a déjà contacté, sous un
 * autre identifiant.
 *
 * Le verrou est le bon endroit pour ce refus, et pas seulement la file. Un
 * manifeste `LOCKED` est ce qu'un opérateur lit comme « prêt à partir » : le
 * laisser exister pour un commerce déjà joint, puis ne refuser qu'à
 * l'enfilement, ferait vivre pendant des jours un objet qui affirme le
 * contraire de ce qui est vrai. Le refus est donc posé ici ET dans
 * `evaluateInstagramEligibility` — deux portes, la même lecture, aucune des
 * deux n'étant contournable par l'autre chemin.
 *
 * Le contrôle est borné au TRANSPORT demandé. Un e-mail déjà envoyé à ce
 * commerce n'interdit pas de verrouiller un DM Instagram : ce sont deux
 * conversations distinctes, et en ouvrir une seconde est une décision
 * légitime. Ce qui est interdit sans nouvelle décision humaine, c'est de
 * rouvrir deux fois la même.
 */
async function enforceIdentityContactGuard(
  sql: Sql,
  prospectId: string,
  transport: Transport,
): Promise<void> {
  const history = await loadBusinessContactHistory(sql, prospectId);

  const suppression = history.suppressions.find((entry) => !entry.isSelf);
  if (suppression) {
    const member = history.group.members.find((m) => m.prospectId === suppression.prospectId);
    throw new DispatchLockError(
      'identity_suppressed',
      `« ${suppression.value} » (${suppression.matchKind}) figure dans do_not_contact (${suppression.reason}) ` +
        `pour ${member?.displayName ?? suppression.prospectId} (${suppression.prospectId}, campagne ` +
        `${member?.campaignSlug ?? '—'}), qui est le MÊME commerce que ce prospect — verrouillage refusé.`,
    );
  }

  const sameChannel = contactsOnChannel(history, transport).filter((contact) => !contact.isSelf);
  const previous = sameChannel[sameChannel.length - 1];
  if (!previous) return;

  const member = history.group.members.find((m) => m.prospectId === previous.prospectId);
  const link = member?.linkedBy.map(describeLink).join(' + ') ?? 'identité partagée';
  throw new DispatchLockError(
    'identity_already_contacted',
    `ce commerce a déjà été joint en ${transport} le ${previous.occurredAt} ` +
      `(${previous.source} ${previous.reference}, statut « ${previous.status} ») sous une AUTRE ligne : ` +
      `${member?.displayName ?? previous.prospectId} (${previous.prospectId}, campagne ` +
      `${member?.campaignSlug ?? '—'}), reliée par ${link}. La ligne courante n'affiche aucun contact, ` +
      `ce qui est vrai d'elle et faux du commerce — verrouillage refusé.`,
  );
}

export async function lockManifestForItem(sql: Sql, input: LockManifestInput): Promise<DispatchManifest> {
  const context = await loadDispatchContext(sql, input.itemId);
  if (!context) throw new DispatchLockError('item_not_found', `item ${input.itemId} introuvable`);

  const votes = await loadLatestVotes(sql, [input.itemId]);
  const vote = votes.get(input.itemId);
  if (!vote || !vote.approved || !vote.approvedText) {
    throw new DispatchLockError(
      'not_approved',
      `item ${input.itemId} n'a pas de vote SEND/EDIT approuvé — rien à verrouiller`,
    );
  }

  const options = resolveTransportOptions(context.observedChannels, context.prospect, context.evidence);
  const selected = options.find((option) => option.transport === input.transport);
  if (!selected) {
    throw new DispatchLockError(
      'transport_not_available',
      `transport « ${input.transport} » non proposé pour cet item (canal de base non observé à la génération du batch)`,
    );
  }
  if (selected.status !== 'verified' || !selected.recipient || !selected.provenance || selected.recipientEvidenceIds.length === 0) {
    throw new DispatchLockError('recipient_unresolved', selected.reason);
  }

  const identity = resolveIdentityAudit(context.prospect, context.evidence);
  if (identity.ambiguous) {
    throw new DispatchLockError('identity_ambiguity', identity.reasons.join(' ; '));
  }

  // ---- ICP-R1 — l'éligibilité commerciale, juste avant le point de non-retour
  //
  // Le verdict est CALCULÉ ici, pas cherché dans une table. La différence est
  // la seule qui compte : une garde qui lit un verdict pré-enregistré se
  // contourne en ne l'enregistrant jamais, tandis qu'un verdict recalculé sur
  // les preuves courantes ne peut pas être sauté — il n'y a pas de chemin où il
  // n'est pas évalué.
  //
  // Il est ensuite journalisé, quel qu'il soit. Un `GOOD_ICP` archivé vaut
  // autant qu'un refus : c'est lui qui permettra, plus tard, de répondre à
  // « qu'est-ce que nous savions le jour du lock ? » — la question exacte que ce
  // post-mortem a dû reconstituer à la main.
  await enforceIcpEligibility(sql, context);

  // ---- R7.6-GATE — la TAILLE, juste après le TYPE ------------------------
  //
  // Deux questions d'éligibilité distinctes, deux refus distincts. Voir
  // `enforceAudienceScale`.
  await enforceAudienceScale(sql, context);

  // ---- R7-PILOT §1 — le même commerce, sous une autre ligne ----------------
  //
  // Après l'ICP et juste avant l'écriture, parce que c'est le dernier moment où
  // refuser ne coûte encore rien. Voir `enforceIdentityContactGuard`.
  await enforceIdentityContactGuard(sql, context.prospect.id, input.transport);

  const approvedText = vote.approvedText;
  const approvedTextSha256 = sha256Hex(approvedText);
  const newId = randomUUID();

  // R6B-C.2A — un premier lock ne porte aucune propriété transport : le
  // transport et le destinataire viennent d'être choisis, l'objet d'un email
  // ou le mapping d'un formulaire ne l'ont pas été. Le payload vide est donc
  // la seule valeur honnête ici ; le compléter est un second geste humain
  // explicite (`completeEmailSubject`), jamais un effet de bord du lock.
  const transportPayload = EMPTY_TRANSPORT_PAYLOAD;
  const transportPayloadSha256 = hashTransportPayload(transportPayload);

  return sql.transaction(async (tx) => {
    const existing = await tx.query<{ id: string }>(
      `select id from r6b_dispatch_manifests where batch_item_id = $1 and status = 'LOCKED'`,
      [input.itemId],
    );
    const previous = existing[0];
    if (previous) {
      // L'UPDATE doit précéder l'INSERT : l'index partiel `..._one_locked_idx`
      // n'est pas différable, donc l'ancienne ligne doit quitter le statut
      // LOCKED avant que la nouvelle y entre. `superseded_by` référence une
      // ligne qui n'existe pas encore — c'est exactement ce que la FK
      // `deferrable initially deferred` (0019) autorise, vérifiée au commit.
      await tx.query(
        `update r6b_dispatch_manifests
            set status = 'SUPERSEDED', superseded_at = now(), superseded_by = $2
          where id = $1`,
        [previous.id, newId],
      );
    }

    await tx.query(
      `insert into r6b_dispatch_manifests
         (id, batch_id, batch_item_id, prospect_id, approval_vote_id, business_name, legal_name,
          transport, recipient, recipient_provenance, recipient_evidence_ids, identity_review,
          approved_text, approved_text_sha256, transport_payload, transport_payload_sha256,
          hook_type, hook_evidence_ids, status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'LOCKED')`,
      [
        newId,
        context.batchId,
        input.itemId,
        context.prospect.id,
        vote.id,
        identity.businessNameForDisplay,
        identity.legalName,
        selected.transport,
        selected.recipient,
        JSON.stringify(selected.provenance),
        JSON.stringify(selected.recipientEvidenceIds),
        identity.identityReview,
        approvedText,
        approvedTextSha256,
        JSON.stringify(transportPayload),
        transportPayloadSha256,
        context.hookType,
        JSON.stringify(context.hookEvidenceIds),
      ],
    );

    const rows = await tx.query<DbManifestRow>(
      `select * from r6b_dispatch_manifests where id = $1`,
      [newId],
    );
    const row = rows[0];
    if (!row) throw new Error('manifest insert did not return a row');
    return toManifest(row);
  });
}

interface DbManifestRow {
  id: string;
  batch_id: string;
  batch_item_id: string;
  prospect_id: string;
  approval_vote_id: string;
  business_name: string;
  legal_name: string | null;
  channel: string | null;
  transport: string | null;
  recipient: string;
  recipient_provenance: unknown;
  recipient_evidence_ids: unknown;
  identity_review: 'confirmed' | 'manual_review' | 'uncertain';
  approved_text: string;
  approved_text_sha256: string;
  transport_payload: unknown;
  transport_payload_sha256: string;
  hook_type: string | null;
  hook_evidence_ids: unknown;
  status: 'LOCKED' | 'SUPERSEDED';
  superseded_by: string | null;
  superseded_at: string | null;
  superseded_reason: string | null;
  locked_at: string;
}

function toManifest(row: DbManifestRow): DispatchManifest {
  return {
    id: row.id,
    batchId: row.batch_id,
    batchItemId: row.batch_item_id,
    prospectId: row.prospect_id,
    approvalVoteId: row.approval_vote_id,
    businessName: row.business_name,
    legalName: row.legal_name,
    legacyChannel: row.channel,
    transport: row.transport as Transport | null,
    recipient: row.recipient,
    recipientProvenance: row.recipient_provenance as RecipientProvenance,
    recipientEvidenceIds: Array.isArray(row.recipient_evidence_ids) ? row.recipient_evidence_ids.map(String) : [],
    identityReview: row.identity_review,
    approvedText: row.approved_text,
    approvedTextSha256: row.approved_text_sha256,
    transportPayload: readTransportPayload(row.transport_payload),
    transportPayloadSha256: row.transport_payload_sha256,
    hookType: row.hook_type,
    hookEvidenceIds: Array.isArray(row.hook_evidence_ids) ? row.hook_evidence_ids.map(String) : [],
    status: row.status,
    supersededBy: row.superseded_by,
    supersededAt: row.superseded_at,
    supersededReason: row.superseded_reason,
    lockedAt: row.locked_at,
  };
}

export async function loadCurrentManifestsByBatch(
  sql: Sql,
  batchId: string,
): Promise<Map<string, DispatchManifest>> {
  const rows = await sql.query<DbManifestRow>(
    `select * from r6b_dispatch_manifests where batch_id = $1 and status = 'LOCKED'`,
    [batchId],
  );
  const map = new Map<string, DispatchManifest>();
  for (const row of rows) map.set(row.batch_item_id, toManifest(row));
  return map;
}

export async function loadManifestHistoryForItem(sql: Sql, itemId: string): Promise<DispatchManifest[]> {
  const rows = await sql.query<DbManifestRow>(
    `select * from r6b_dispatch_manifests where batch_item_id = $1 order by locked_at asc`,
    [itemId],
  );
  return rows.map(toManifest);
}

/**
 * R6B-C.1 §2 — charge un manifeste par son identifiant exact, quel que soit
 * son statut. Le dispatcher juge lui-même si ce manifeste est dispatchable
 * (§3) ; ce chargeur ne filtre pas, pour que « SUPERSEDED » puisse être
 * distingué d'« inexistant » dans le refus.
 *
 * `id::text = $1` plutôt que `id = $1` : l'identifiant vient d'une ligne de
 * commande, donc d'une chaîne arbitraire. Comparer après cast en texte fait
 * répondre « aucun manifeste » à une saisie qui n'est pas un UUID, là où le
 * cast implicite de Postgres lèverait une erreur de type illisible.
 */
export async function loadManifestById(sql: Sql, manifestId: string): Promise<DispatchManifest | null> {
  const rows = await sql.query<DbManifestRow>(
    `select * from r6b_dispatch_manifests where id::text = $1`,
    [manifestId],
  );
  const row = rows[0];
  return row ? toManifest(row) : null;
}

/**
 * R6B-C.2A — même lecture que `loadManifestById`, mais en verrouillant la
 * ligne pour la durée de la transaction (`for update`).
 *
 * Utilisée par le remplacement de manifeste : entre le moment où un opérateur voit
 * un manifeste à l'écran et celui où il confirme, la ligne peut avoir changé.
 * La relire sous verrou est ce qui rend la comparaison « ce que l'humain a vu
 * == ce qui est en base » concluante plutôt qu'indicative.
 */
export async function loadManifestByIdForUpdate(tx: Sql, manifestId: string): Promise<DispatchManifest | null> {
  const rows = await tx.query<DbManifestRow>(
    `select * from r6b_dispatch_manifests where id::text = $1 for update`,
    [manifestId],
  );
  const row = rows[0];
  return row ? toManifest(row) : null;
}

/**
 * R6B-C.1 §3 — les manifestes actuellement `LOCKED` d'un item. L'index
 * partiel `r6b_dispatch_manifests_one_locked_idx` (0019) garantit déjà qu'il
 * y en a au plus un ; le dispatcher le revérifie quand même avant d'agir
 * plutôt que de faire confiance à une invariante qu'il n'observe pas.
 */
export async function loadActiveLockedManifestIdsForItem(sql: Sql, itemId: string): Promise<string[]> {
  const rows = await sql.query<{ id: string }>(
    `select id from r6b_dispatch_manifests where batch_item_id = $1 and status = 'LOCKED'`,
    [itemId],
  );
  return rows.map((row) => row.id);
}
