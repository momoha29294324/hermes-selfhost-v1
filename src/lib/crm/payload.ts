/**
 * R6B-D2.1 — la charge utile CRM.
 *
 * Déplacée telle quelle depuis `src/lib/replies/crm.ts` (R6B-D2), qui la
 * construisait déjà exactement ainsi. Elle vit maintenant sous `crm/` parce
 * qu'elle n'appartient plus au seul chemin « réponse » : une projection
 * relancée par `r6b:crm:sync` la reconstruit sans reclasser quoi que ce soit.
 *
 * Ce que ce fichier ne fait toujours pas : deviner. `contactName` reste `null`
 * parce que le pipeline n'a jamais observé de nom d'interlocuteur, et un CRM
 * fige durablement ce qu'on y écrit (CLAUDE.md, interdit n°2).
 */

import { createHash } from 'node:crypto';
import type { StoredAnalysis } from '@/lib/replies/analyses';
import type { ReplyContext } from '@/lib/replies/context';
import type { OutreachState } from '@/lib/replies/taxonomy';

/**
 * Libellés d'étape visés, par état commercial.
 *
 * Ce sont des LIBELLÉS, pas des identifiants : les identifiants réels sont ceux
 * du fournisseur, lus une fois à la vérification et conservés dans
 * `r6b_crm_pipeline_stages` / `r6b_crm_stage_map`. Cette table sert à proposer
 * une correspondance à un humain, et à écrire dans la charge utile ce que la
 * projection VOULAIT faire — pas à désigner une étape à l'exécution.
 *
 * `REVIEW_REQUIRED` vaut `null`, et c'est §6 de la mission R6B-D2.1 :
 * « REVIEW_REQUIRED → do not make an expansive CRM stage change
 * automatically ». Une conclusion que le système n'a pas tranchée ne déplace
 * rien chez un tiers. La table `r6b_crm_stage_map` refuse d'ailleurs cet état.
 */
export const CRM_STAGE_LABELS: Readonly<Record<OutreachState, string | null>> = Object.freeze({
  CONTACTED: 'Contacté',
  REPLIED: 'Réponse reçue',
  INTERESTED: 'Intéressé',
  NOT_NOW: 'Pas maintenant',
  NOT_INTERESTED: 'Non intéressé',
  BOUNCED: 'Perdu',
  SUPPRESSED: 'Perdu',
  REVIEW_REQUIRED: null,
});

/**
 * Les étapes qu'un pipeline Hermes doit porter, dans l'ordre.
 *
 * `Prospect qualifié`, `À relancer` et `Client` n'ont aucun état R6B
 * correspondant : la première précède le contact (elle vit dans
 * `prospects.stage`), la deuxième relève d'une séquence de nurture que ce dépôt
 * n'implémente pas, la troisième suit une signature qu'il n'observe pas. Elles
 * figurent quand même ici parce que le pipeline décrit doit être le pipeline
 * entier, pas seulement la portion que la machine sait remplir.
 */
export const CRM_PIPELINE_PLAN: readonly string[] = [
  'Prospect qualifié',
  'Contacté',
  'Réponse reçue',
  'Intéressé',
  'À relancer',
  'Pas maintenant',
  'Non intéressé',
  'Perdu',
  'Client',
];

export interface CrmPayload {
  readonly source: 'Hermes';
  readonly prospectId: string;
  readonly manifestId: string;
  readonly company: string;
  readonly legalName: string | null;
  /** Non observé à ce jour : le pipeline ne collecte pas de nom d'interlocuteur. */
  readonly contactName: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly website: string | null;
  readonly instagram: string | null;
  readonly city: string | null;
  readonly prospectScore: number | null;
  readonly prospectScoreBand: string | null;
  readonly researchSummary: string | null;
  readonly outreachState: OutreachState;
  readonly targetStage: string | null;
  readonly replyClassification: string;
  readonly replyConfidence: number;
  readonly replyReceivedAt: string;
  readonly replyExcerpt: string;
  readonly correlationStatus: string;
}

/** Longueur de l'extrait de réponse projeté. Le corps entier reste en base. */
export const CRM_EXCERPT_CHARS = 500;

export function buildCrmPayload(
  context: ReplyContext,
  analysis: StoredAnalysis,
  outreachState: OutreachState,
): CrmPayload {
  return Object.freeze({
    source: 'Hermes' as const,
    prospectId: context.prospect.id,
    manifestId: context.firstTouch.manifestId,
    company: context.firstTouch.businessName,
    legalName: context.prospect.legalName,
    // Jamais déduit d'une adresse email ni d'un nom de domaine : une
    // supposition présentée comme un fait est exactement ce que CLAUDE.md
    // (interdit n°2) refuse, et un CRM la figerait durablement.
    contactName: null,
    // IG5.1 — le repli sur le destinataire du manifeste ne vaut que si ce
    // destinataire EST une adresse. Sur un manifeste `instagram_dm`, il vaut un
    // handle, et le recopier ici aurait écrit « @atelieratelier_ » dans le
    // champ e-mail d'un CRM — une donnée fausse, figée durablement chez un
    // tiers. Le handle a déjà son champ, deux lignes plus bas.
    email:
      context.prospect.email ?? (context.firstTouch.transport === 'email' ? context.firstTouch.recipient : null),
    phone: context.prospect.phone,
    website: context.prospect.websiteUrl,
    instagram: context.prospect.instagramHandle,
    city: context.prospect.city,
    prospectScore: context.prospect.score,
    prospectScoreBand: context.prospect.scoreBand,
    researchSummary: context.research?.summary ?? null,
    outreachState,
    targetStage: CRM_STAGE_LABELS[outreachState],
    replyClassification: analysis.classification,
    replyConfidence: analysis.confidence,
    replyReceivedAt: context.reply.receivedAt,
    replyExcerpt: context.reply.bodyText.slice(0, CRM_EXCERPT_CHARS),
    correlationStatus: context.reply.correlationStatus,
  });
}

/** Empreinte stable de la charge utile — clés triées, donc indépendante de l'ordre. */
export function hashCrmPayload(payload: CrmPayload): string {
  const entries = Object.entries(payload as unknown as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

// ---------------------------------------------------------------------------
// Normalisation des identifiants d'identité (§4)
// ---------------------------------------------------------------------------

/**
 * Email normalisé pour une recherche d'identité, ou `null`.
 *
 * Minuscule et espaces retirés, rien de plus : ni suppression des points, ni
 * troncature d'un `+suffixe`. Ces normalisations « intelligentes » font
 * coïncider deux adresses qui appartiennent parfois à deux personnes, et une
 * fusion de dossiers ne se défait pas.
 */
export function normalizeCrmEmail(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0 || !trimmed.includes('@')) return null;
  return trimmed;
}

/**
 * Téléphone réduit à ses chiffres et à son éventuel `+`, ou `null`.
 *
 * Aucun préfixe pays n'est ajouté : supposer « +33 » parce que la campagne est
 * française transformerait un numéro étranger en un numéro français qui existe.
 * Un numéro trop court pour être un numéro (moins de 8 chiffres) est écarté
 * plutôt que recherché — une recherche sur un fragment peut rendre le contact
 * de quelqu'un d'autre.
 */
export function normalizeCrmPhone(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  const plus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 8) return null;
  return plus ? `+${digits}` : digits;
}
