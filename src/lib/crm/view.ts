/**
 * CRM1 — les dérivations déterministes du CRM Hermes.
 *
 * Aucune base, aucun réseau, aucun modèle : uniquement des fonctions pures qui
 * transforment ce qui est en base en ce que l'opérateur voit. Elles vivent ici
 * plutôt que dans les composants pour une raison simple — « dans quelle
 * colonne du pipeline tombe ce prospect » et « dans quel ordre se lisent ces
 * événements » sont des règles métier, donc du code testé (AGENTS.md), jamais
 * du JSX.
 *
 * ---------------------------------------------------------------------------
 * Deux axes, jamais fusionnés
 * ---------------------------------------------------------------------------
 *
 * `prospects.stage` décrit la FABRICATION d'un message (`discovered` → …
 * → `approved`). `r6b_prospect_outreach_states.state` décrit la RELATION
 * commerciale après le premier contact (`CONTACTED` → … → `SUPPRESSED`). Les
 * deux n'avancent pas sur le même axe et la migration 0026 le dit en toutes
 * lettres. Le pipeline les lit tous les deux et les projette sur une seule
 * suite de colonnes ; il ne les confond pas.
 */

import type { OutreachState } from '@/lib/replies/taxonomy';
import type { PipelineStage } from '@/lib/repo/types';

// ---------------------------------------------------------------------------
// Canaux
// ---------------------------------------------------------------------------

/**
 * Les canaux que l'interface sait représenter.
 *
 * La liste est celle des transports que `r6b_dispatch_manifests` accepte déjà
 * (migration 0020), à un détail près : `phone_call` s'affiche `phone`. Elle est
 * posée en entier dès maintenant, alors que seul `email` a produit un
 * événement réel, parce qu'ajouter Instagram ne doit rien casser — c'est la
 * seule façon de ne pas écrire une timeline « d'emails » qu'il faudrait
 * réécrire au premier DM.
 */
export type CrmChannel =
  | 'email'
  | 'instagram_dm'
  | 'facebook_dm'
  | 'whatsapp'
  | 'sms'
  | 'phone'
  | 'web_form';

export const CRM_CHANNELS: readonly CrmChannel[] = [
  'email',
  'instagram_dm',
  'facebook_dm',
  'whatsapp',
  'sms',
  'phone',
  'web_form',
];

export const CHANNEL_LABELS: Readonly<Record<CrmChannel, string>> = Object.freeze({
  email: 'Email',
  instagram_dm: 'Instagram',
  facebook_dm: 'Facebook',
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  phone: 'Téléphone',
  web_form: 'Formulaire',
});

/** Forme courte, pour une cellule de tableau qui doit rester dense. */
export const CHANNEL_SHORT: Readonly<Record<CrmChannel, string>> = Object.freeze({
  email: 'email',
  instagram_dm: 'IG',
  facebook_dm: 'FB',
  whatsapp: 'WA',
  sms: 'SMS',
  phone: 'tél',
  web_form: 'form',
});

// ---------------------------------------------------------------------------
// Teintes — une couleur, une fonction
// ---------------------------------------------------------------------------

/**
 * Les six teintes fonctionnelles de CRM2, plus l'ardoise neutre.
 *
 * Elles vivent ici et non dans une feuille de style parce qu'elles ne sont pas
 * une décoration : « vert = positif » et « rouge = bloqué » sont des règles de
 * lecture, dérivées des mêmes faits que la colonne du pipeline. Une seule
 * table les décide, et le rendu ne fait que la lire — sinon deux écrans
 * finiraient par colorer le même prospect différemment.
 *
 * Le nom est une union fermée : la feuille de style déclare exactement ces
 * valeurs en `data-tone`, et une teinte inventée ne compile pas.
 */
/**
 * Les teintes du CRM, et leur SEUL sens.
 *
 * Une couleur qui veut dire deux choses ne veut rien dire. Jusqu'à CRM-UX-R1
 * le violet disait à la fois « Hermes » (la marque, le rail, la sélection) et
 * « relation en cours » : sur la liste, l'entrée active du rail et la colonne
 * CONTACTED portaient donc la même couleur sans avoir le moindre rapport.
 *
 *   violet — l'identité Hermes : marque, navigation, sélection. JAMAIS un
 *            état commercial. C'est la seule teinte qui ne parle pas du
 *            prospect mais de l'application ;
 *   vert   — un fait positif établi (qualifié, intéressé, client, bande A) ;
 *   orange — une DÉCISION HUMAINE attendue. C'est la seule teinte qui demande
 *            quelque chose à quelqu'un, et c'est pour cela qu'elle est rare ;
 *   rouge  — une porte fermée : refus, suppression, échec d'envoi ;
 *   bleu   — une action DISPONIBLE, prête à être menée ;
 *   cyan   — en cours ou produit par la machine : envoi parti, analyse,
 *            brouillon, plan. Informatif, rien à faire ;
 *   rose   — Instagram, et rien d'autre. Une couleur de marque tierce ;
 *   ardoise— métadonnée, ou « pas encore jugé ». Jamais un verdict.
 *
 * La teinte porte le SENS ; le palier (`CrmTier`) porte le POIDS. Les deux sont
 * indépendants, ce qui permet de dire « positif mais secondaire » sans inventer
 * un vert pâle de plus.
 */
export const CRM_TONES = Object.freeze([
  'violet',
  'green',
  'blue',
  'cyan',
  'orange',
  'red',
  'rose',
  'slate',
] as const);

/**
 * Le TYPE est dérivé de la liste, et non écrit à côté d'elle.
 *
 * Une union écrite à la main et une liste écrite à la main finissent toujours
 * par diverger — c'est déjà arrivé ici : ajouter `cyan` au type laissait le
 * test de couverture des teintes sur une liste de sept, donc muet sur la
 * huitième. Dérivé, un oubli ne compile plus.
 */
export type CrmTone = (typeof CRM_TONES)[number];

/**
 * Le POIDS visuel d'un élément — orthogonal à sa teinte.
 *
 * ---------------------------------------------------------------------------
 * Le défaut que ce palier corrige
 * ---------------------------------------------------------------------------
 *
 * CRM2 donnait à peu près le même poids à tout : sur une ligne d'Inbox, la
 * pastille verte « EXACT » — un détail de corrélation technique — dominait la
 * colonne « Action », qui est la seule chose qu'un opérateur ait à lire. La
 * hiérarchie n'était pas fausse, elle était ABSENTE.
 *
 *   1 — la décision : l'action à mener, ou le blocage qui l'interdit. Au plus
 *       UNE par région d'écran, sinon il n'y a plus de premier ;
 *   2 — l'état : où en est la relation, quel est le signal le plus fort ;
 *   3 — la preuve qui appuie l'état : canaux, score, dates ;
 *   4 — la métadonnée et la provenance : identifiants, versions, sources.
 *
 * Un palier ne change ni la teinte ni le texte : il change la surface, le
 * contraste et la taille. C'est ce qui permet de faire reculer une information
 * sans la retirer — et le CRM ne retire rien.
 */
export type CrmTier = 1 | 2 | 3 | 4;

/**
 * Colonne du pipeline → teinte.
 *
 * `CONTACTED` était violet, c'est-à-dire de la couleur du rail et de la
 * sélection. Il passe en cyan : un envoi parti dont on attend la réponse est un
 * fait EN COURS, pas une demande — il n'y a rien à faire, et la couleur ne doit
 * donc rien réclamer.
 *
 * `REPLIED` reste orange, et c'est la seule colonne du haut du funnel à
 * l'être : quelqu'un a répondu, quelqu'un doit lire.
 */
export const LANE_TONE: Readonly<Record<CrmLane, CrmTone>> = Object.freeze({
  QUALIFIED: 'green',
  READY_TO_CONTACT: 'blue',
  CONTACTED: 'cyan',
  REPLIED: 'orange',
  INTERESTED: 'green',
  NOT_NOW: 'orange',
  NOT_INTERESTED: 'red',
  CLIENT: 'green',
  REVIEW_REQUIRED: 'orange',
  PROTECTED: 'red',
});

/** Hors pipeline, aucune couleur ne s'impose : l'ardoise dit « pas encore ». */
export function laneTone(lane: CrmLane | null): CrmTone {
  return lane === null ? 'slate' : LANE_TONE[lane];
}

/**
 * Les étapes de FABRICATION, écrites pour un humain.
 *
 * `prospects.stage` est un identifiant de machine (`message_ready`), et c'est
 * bien ainsi qu'il doit rester en base et dans `commercial.short` — les tests
 * s'appuient dessus. Mais un CRM français n'a aucune raison d'afficher
 * `rejected` à un opérateur : la traduction se fait donc ici, au dernier
 * moment, sans qu'aucune valeur ne change.
 */
export const STAGE_LABELS: Readonly<Record<PipelineStage, string>> = Object.freeze({
  discovered: 'Découvert',
  enriched: 'Enrichi',
  qualified: 'Qualifié',
  researched: 'Étudié',
  message_ready: 'Message prêt',
  approved: 'Approuvé',
  rejected: 'Écarté',
  excluded: 'Exclu',
});

/**
 * Un prospect écarté ou exclu porte du rouge, même hors pipeline : c'est une
 * décision qui ferme une porte, et elle se lit comme telle. Tout le reste de
 * l'amont reste ardoise — « pas encore jugé » n'est pas un verdict.
 */
export function stageTone(stage: PipelineStage): CrmTone {
  return stage === 'rejected' || stage === 'excluded' ? 'red' : 'slate';
}

/** La teinte d'un prospect : sa colonne s'il en a une, son étape sinon. */
export function prospectTone(input: {
  readonly lane: CrmLane | null;
  readonly stage: PipelineStage;
}): CrmTone {
  return input.lane === null ? stageTone(input.stage) : LANE_TONE[input.lane];
}

/** Ce qu'on écrit sur le badge d'état : la colonne, ou l'étape traduite. */
export function commercialShortLabel(input: {
  readonly lane: CrmLane | null;
  readonly stage: PipelineStage;
  readonly short: string;
}): string {
  return input.lane === null ? STAGE_LABELS[input.stage] : input.short;
}

/**
 * Canal → teinte. Instagram est rose, Facebook bleu, WhatsApp vert : ce sont
 * les couleurs que l'opérateur associe déjà à ces surfaces, et les détourner
 * coûterait une seconde de lecture à chaque ligne.
 */
export const CHANNEL_TONE: Readonly<Record<CrmChannel, CrmTone>> = Object.freeze({
  email: 'blue',
  instagram_dm: 'rose',
  facebook_dm: 'blue',
  whatsapp: 'green',
  // Ni SMS ni téléphone n'ont de couleur de marque. Les peindre en violet les
  // faisait ressembler à une sélection ; ils redeviennent des métadonnées.
  sms: 'slate',
  phone: 'slate',
  web_form: 'slate',
});

/**
 * Bande de score → teinte.
 *
 * L'échelle descend, la couleur avec elle. Une bande absente reste ardoise :
 * un prospect non scoré n'est pas un mauvais prospect, c'est un prospect dont
 * on ne sait rien.
 */
export function bandTone(band: string | null): CrmTone {
  switch (band) {
    case 'A':
      return 'green';
    case 'B':
      return 'blue';
    case 'C':
      return 'orange';
    case 'D':
      return 'red';
    default:
      return 'slate';
  }
}

/**
 * Transport de manifeste → canal d'affichage.
 *
 * Rend `null` sur une valeur inconnue plutôt que de deviner : un transport que
 * cette version ne connaît pas doit produire un canal vide et visible, pas un
 * canal plausible.
 */
export function channelFromTransport(transport: string | null | undefined): CrmChannel | null {
  switch (transport) {
    case 'email':
      return 'email';
    case 'instagram_dm':
      return 'instagram_dm';
    case 'facebook_dm':
      return 'facebook_dm';
    case 'whatsapp':
      return 'whatsapp';
    case 'sms':
      return 'sms';
    case 'phone_call':
    case 'phone':
      return 'phone';
    case 'web_form':
      return 'web_form';
    default:
      return null;
  }
}

/**
 * Les canaux OBSERVÉS d'un prospect, dans l'ordre où on tenterait de l'atteindre.
 *
 * « Observé » et pas « possible » : un numéro de téléphone prouve un appel, pas
 * un SMS ni un WhatsApp (migration 0020, §3/§4). Un site prouve un site, pas un
 * formulaire de contact. Cette fonction ne fabrique donc que ce que la colonne
 * correspondante affirme réellement.
 */
export interface ObservedChannelsInput {
  readonly email: string | null;
  readonly instagramHandle: string | null;
  readonly facebookUrl: string | null;
  readonly phone: string | null;
}

export function observedChannels(input: ObservedChannelsInput): CrmChannel[] {
  const channels: CrmChannel[] = [];
  if (nonEmpty(input.email)) channels.push('email');
  if (nonEmpty(input.instagramHandle)) channels.push('instagram_dm');
  if (nonEmpty(input.facebookUrl)) channels.push('facebook_dm');
  if (nonEmpty(input.phone)) channels.push('phone');
  return channels;
}

/**
 * Le meilleur canal : celui qu'un manifeste VERROUILLÉ a déjà choisi, sinon le
 * premier canal observé.
 *
 * Un manifeste verrouillé n'est pas une préférence, c'est une décision humaine
 * figée avec sa preuve de destinataire — elle prime sur tout classement.
 */
export function bestChannel(
  input: ObservedChannelsInput & { readonly lockedTransport: string | null },
): CrmChannel | null {
  const locked = channelFromTransport(input.lockedTransport);
  if (locked !== null) return locked;
  return observedChannels(input)[0] ?? null;
}

function nonEmpty(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Colonnes du pipeline
// ---------------------------------------------------------------------------

export type CrmLane =
  | 'QUALIFIED'
  | 'READY_TO_CONTACT'
  | 'CONTACTED'
  | 'REPLIED'
  | 'INTERESTED'
  | 'NOT_NOW'
  | 'NOT_INTERESTED'
  | 'CLIENT'
  | 'REVIEW_REQUIRED'
  | 'PROTECTED';

export interface CrmLaneDefinition {
  readonly key: CrmLane;
  readonly label: string;
  /** Ce que la colonne affirme exactement. Affiché, pas seulement commenté. */
  readonly rule: string;
}

/**
 * L'ordre est celui du parcours commercial, avec les trois sorties à la fin.
 *
 * `CLIENT` s'appuie sur `prospect_milestones` (jalon `won`, migration 0019) et
 * non sur un état de la machine : gagner une affaire n'est pas une réponse à un
 * email, et la machine à états ne l'a jamais prétendu.
 */
export const CRM_LANES: readonly CrmLaneDefinition[] = Object.freeze([
  {
    key: 'QUALIFIED',
    label: 'Qualifiés',
    rule: 'scoré et retenu, aucun manifeste verrouillé, jamais contacté',
  },
  {
    key: 'READY_TO_CONTACT',
    label: 'Prêts à contacter',
    rule: 'un manifeste LOCKED existe — texte, transport et destinataire figés',
  },
  { key: 'CONTACTED', label: 'Contactés', rule: 'au moins un envoi réel, aucune réponse reçue' },
  { key: 'REPLIED', label: 'Ont répondu', rule: 'une réponse corrélée, intention non tranchée' },
  { key: 'INTERESTED', label: 'Intéressés', rule: 'réponse classée INTERESTED ou MEETING_INTENT' },
  { key: 'NOT_NOW', label: 'Pas maintenant', rule: 'report explicite, relance possible plus tard' },
  { key: 'NOT_INTERESTED', label: 'Pas intéressés', rule: 'refus explicite, plus de relance à froid' },
  { key: 'CLIENT', label: 'Clients', rule: 'jalon « won » enregistré' },
  {
    key: 'REVIEW_REQUIRED',
    label: 'À arbitrer',
    rule: 'le système ne tranche pas et le dit — décision humaine attendue',
  },
  {
    key: 'PROTECTED',
    label: 'Protégés',
    rule: 'demande d’arrêt, adresse non délivrable, ou entrée dans do_not_contact',
  },
]);

export const LANE_LABELS: Readonly<Record<CrmLane, string>> = Object.freeze(
  Object.fromEntries(CRM_LANES.map((lane) => [lane.key, lane.label])) as Record<CrmLane, string>,
);

/**
 * Le parcours actif, puis les sorties.
 *
 * Une seule machine à états, deux poids d'affichage. Les cinq premières
 * colonnes sont celles où un prospect BOUGE encore ; les cinq dernières sont
 * des issues, et une issue vide n'apprend rien qu'un compteur ne dise mieux.
 * La distinction est purement visuelle : `resolveLane` ne la connaît pas, et
 * aucune règle métier n'en dépend.
 */
export const CRM_PRIMARY_LANES: readonly CrmLane[] = Object.freeze([
  'QUALIFIED',
  'READY_TO_CONTACT',
  'CONTACTED',
  'REPLIED',
  'INTERESTED',
]);

export const CRM_TERMINAL_LANES: readonly CrmLane[] = Object.freeze([
  'NOT_NOW',
  'NOT_INTERESTED',
  'CLIENT',
  'REVIEW_REQUIRED',
  'PROTECTED',
]);

export interface BoardLayout {
  /** Toujours rendues en colonne, même vides : c'est le funnel. */
  readonly primary: readonly CrmLaneDefinition[];
  /** Sorties PEUPLÉES — une colonne pleine, comme n'importe quelle autre. */
  readonly terminal: readonly CrmLaneDefinition[];
  /** Sorties vides — repliées dans un seul bloc compact, compteurs visibles. */
  readonly collapsed: readonly CrmLaneDefinition[];
}

/**
 * Répartit les colonnes d'après leur remplissage RÉEL.
 *
 * Une seule règle : une sortie vide se replie, une sortie peuplée ne se replie
 * jamais. Rien ne disparaît — le bloc replié porte les mêmes libellés et les
 * mêmes compteurs, et chaque état reste atteignable par son filtre. C'est ce
 * qui distingue « compacter » de « masquer ».
 */
export function boardLayout(counts: Readonly<Record<CrmLane, number>>): BoardLayout {
  const byKey = new Map(CRM_LANES.map((lane) => [lane.key, lane] as const));
  const pick = (key: CrmLane): CrmLaneDefinition => byKey.get(key)!;
  const terminal = CRM_TERMINAL_LANES.map(pick);
  return Object.freeze({
    primary: Object.freeze(CRM_PRIMARY_LANES.map(pick)),
    terminal: Object.freeze(terminal.filter((lane) => counts[lane.key] > 0)),
    collapsed: Object.freeze(terminal.filter((lane) => counts[lane.key] === 0)),
  });
}

/** Les étapes de fabrication qui font entrer un prospect dans le pipeline. */
const PIPELINE_ELIGIBLE_STAGES: readonly PipelineStage[] = [
  'qualified',
  'researched',
  'message_ready',
  'approved',
];

export interface LaneInput {
  readonly stage: PipelineStage;
  /** État commercial courant, ou `null` si le prospect n'a jamais été contacté. */
  readonly outreachState: OutreachState | null;
  /** Nombre d'envois réels (`outreach_events.kind = 'sent'`). */
  readonly sentCount: number;
  /** Un manifeste `LOCKED` existe-t-il pour ce prospect ? */
  readonly hasLockedManifest: boolean;
  /** Un jalon `won` a-t-il été enregistré ? */
  readonly isClient: boolean;
  /** Le prospect est-il présent dans `do_not_contact` par l'un de ses canaux ? */
  readonly doNotContact: boolean;
}

/**
 * La colonne d'un prospect, ou `null` s'il n'est pas encore dans le pipeline.
 *
 * L'ordre des tests est l'ordre des priorités, et il commence par les sorties :
 * un prospect protégé le reste même si son dernier message ressemblait à de
 * l'intérêt. C'est la même asymétrie que `taxonomy.ts` — une conclusion qui
 * RÉDUIT le contact futur n'a pas besoin d'être confirmée, une conclusion qui
 * l'augmente si.
 *
 * `CONTACTED` se déduit d'un envoi réel quand aucune ligne d'état n'existe.
 * Ce n'est pas une supposition : l'unique envoi de ce dépôt (2026-08-12)
 * précède la table `r6b_prospect_outreach_states` (migration 0026), et
 * `outreach_events.kind = 'sent'` est un fait, pas une inférence. Aucune ligne
 * n'est écrite pour autant — l'interface lit, elle ne rattrape pas.
 */
export function resolveLane(input: LaneInput): CrmLane | null {
  if (input.doNotContact) return 'PROTECTED';
  if (input.outreachState === 'SUPPRESSED' || input.outreachState === 'BOUNCED') return 'PROTECTED';
  if (input.isClient) return 'CLIENT';
  if (input.outreachState !== null) return STATE_LANE[input.outreachState];

  // Aucune ligne d'état : le pipeline se déduit des faits d'envoi.
  if (input.sentCount > 0) return 'CONTACTED';
  if (input.hasLockedManifest) return 'READY_TO_CONTACT';
  if (PIPELINE_ELIGIBLE_STAGES.includes(input.stage)) return 'QUALIFIED';
  return null;
}

/**
 * L'état de la machine → sa colonne, quand c'est LUI qui décide.
 *
 * Deux états n'apparaissent pas comme tels dans le pipeline : `BOUNCED` et
 * `SUPPRESSED` tombent tous deux en `PROTECTED`, parce qu'une adresse morte et
 * un refus explicite appellent la même conduite — ne plus écrire.
 */
const STATE_LANE: Readonly<Record<OutreachState, CrmLane>> = Object.freeze({
  CONTACTED: 'CONTACTED',
  REPLIED: 'REPLIED',
  INTERESTED: 'INTERESTED',
  NOT_NOW: 'NOT_NOW',
  NOT_INTERESTED: 'NOT_INTERESTED',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  BOUNCED: 'PROTECTED',
  SUPPRESSED: 'PROTECTED',
});

// ---------------------------------------------------------------------------
// L'état commercial affiché — une seule phrase, dérivée des faits
// ---------------------------------------------------------------------------

/**
 * CRM1 affichait trois valeurs côte à côte pour un seul prospect : l'état de la
 * machine (`jamais contacté`), la colonne du pipeline (`Contactés`) et le
 * compteur d'envois (`1`). Les trois étaient exactes — et ensemble elles
 * disaient trois choses différentes. Pour un opérateur, c'est une contradiction.
 *
 * La cause n'est pas une donnée fausse, c'est un empilement de couches montré
 * à plat :
 *
 *   • `prospects.stage` — la FABRICATION du message (`discovered → approved`) ;
 *   • `outreach_events.kind = 'sent'` — le FAIT d'avoir envoyé ;
 *   • `r6b_prospect_outreach_states.state` — la RELATION commerciale, tenue par
 *     la machine à états de R6B-D2, qui n'écrit une ligne qu'à partir d'une
 *     réponse entrante.
 *
 * L'unique envoi de ce dépôt n'a produit aucune ligne d'état — sa cible n'a
 * jamais répondu, et la machine n'a donc jamais eu de quoi transiter. « Aucune
 * ligne » ne veut pas dire « jamais contacté » : ça veut dire « la relation n'a
 * pas encore d'histoire ». D'où cette dérivation, qui ne corrige aucune donnée
 * et n'en écrit aucune — elle choisit quoi DIRE des faits déjà présents.
 *
 * `resolveCommercialState` appelle `resolveLane` : la phrase affichée et la
 * colonne du pipeline ne peuvent pas diverger, elles sortent du même calcul.
 */
export type CommercialTone = 'neutral' | 'positive' | 'negative';

/** D'où vient la conclusion. Affiché, parce qu'un opérateur doit pouvoir la contester. */
export type CommercialSource = 'state_machine' | 'facts';

export interface CommercialStateInput extends LaneInput {
  /** Date de la dernière réponse corrélée, ou `null` si aucune. */
  readonly lastReplyAt: string | null;
}

export interface CrmCommercialState {
  /** La colonne du pipeline — identique par construction à `resolveLane`. */
  readonly lane: CrmLane | null;
  /** La phrase que lit l'opérateur. Singulier, sans jargon de table. */
  readonly label: string;
  /** Forme courte, pour une cellule de tableau dense. */
  readonly short: string;
  /** Les faits qui l'établissent, dans l'ordre où ils comptent. */
  readonly basis: readonly string[];
  readonly source: CommercialSource;
  readonly tone: CommercialTone;
}

interface StatePhrase {
  readonly label: string;
  readonly short: string;
  readonly tone: CommercialTone;
}

const LANE_PHRASE: Readonly<Record<CrmLane, StatePhrase>> = Object.freeze({
  QUALIFIED: { label: 'Qualifié — jamais contacté', short: 'Qualifié', tone: 'neutral' },
  READY_TO_CONTACT: {
    label: 'Prêt à contacter — manifeste verrouillé',
    short: 'Prêt à contacter',
    tone: 'neutral',
  },
  CONTACTED: {
    label: 'Contacté — en attente de réponse',
    short: 'Contacté',
    tone: 'neutral',
  },
  REPLIED: { label: 'A répondu — intention non tranchée', short: 'A répondu', tone: 'positive' },
  INTERESTED: { label: 'Intéressé', short: 'Intéressé', tone: 'positive' },
  NOT_NOW: {
    label: 'Pas maintenant — relance possible plus tard',
    short: 'Pas maintenant',
    tone: 'neutral',
  },
  NOT_INTERESTED: {
    label: 'Pas intéressé — plus de relance à froid',
    short: 'Pas intéressé',
    tone: 'negative',
  },
  CLIENT: { label: 'Client', short: 'Client', tone: 'positive' },
  REVIEW_REQUIRED: {
    label: 'À arbitrer — décision humaine attendue',
    short: 'À arbitrer',
    tone: 'neutral',
  },
  PROTECTED: { label: 'Protégé — ne pas contacter', short: 'Protégé', tone: 'negative' },
});

export function resolveCommercialState(input: CommercialStateInput): CrmCommercialState {
  const lane = resolveLane(input);

  if (lane === null) {
    return Object.freeze({
      lane,
      label: 'En amont du pipeline',
      short: input.stage,
      basis: Object.freeze([`étape de fabrication ${input.stage}`]),
      source: 'facts' as const,
      tone: 'neutral' as const,
    });
  }

  const phrase = LANE_PHRASE[lane];
  return Object.freeze({
    lane,
    label: phrase.label,
    short: phrase.short,
    basis: Object.freeze(commercialBasis(input, lane)),
    source: commercialSource(input, lane),
    tone: phrase.tone,
  });
}

/**
 * Qui a tranché : la machine à états, ou les faits bruts.
 *
 * L'ordre suit exactement celui de `resolveLane` — une exclusion l'emporte sur
 * un état, un jalon « won » l'emporte sur le reste. Ce qui a décidé est ce qui
 * est nommé, jamais ce qui aurait pu décider.
 */
function commercialSource(input: CommercialStateInput, lane: CrmLane): CommercialSource {
  if (lane === 'PROTECTED' && input.doNotContact) return 'facts';
  if (lane === 'CLIENT' && input.isClient) return 'facts';
  return input.outreachState === null ? 'facts' : 'state_machine';
}

function commercialBasis(input: CommercialStateInput, lane: CrmLane): string[] {
  const basis: string[] = [];
  if (input.doNotContact) basis.push('entrée dans do_not_contact');
  if (input.isClient && lane === 'CLIENT') basis.push('jalon « won » enregistré');
  if (input.sentCount > 0) {
    basis.push(input.sentCount === 1 ? '1 envoi réel' : `${input.sentCount} envois réels`);
  }
  if (input.lastReplyAt !== null) basis.push('réponse corrélée reçue');
  else if (input.sentCount > 0) basis.push('aucune réponse reçue');
  if (input.sentCount === 0 && input.hasLockedManifest) basis.push('manifeste LOCKED, rien d’envoyé');
  if (input.outreachState !== null) basis.push(`machine à états : ${input.outreachState}`);
  else if (input.sentCount > 0) basis.push('aucune transition d’état');
  return basis;
}

// ---------------------------------------------------------------------------
// Timeline multicanal
// ---------------------------------------------------------------------------

/**
 * Ce qu'un événement de timeline peut être.
 *
 * Un `kind` par TABLE d'origine, jamais un type fourre-tout : c'est ce qui
 * permet à l'affichage de faire un `switch` exhaustif et au compilateur de
 * refuser un ajout non traité. Le motif est emprunté à la timeline
 * d'atomic-crm (dispatch type → composant) ; la fusion, elle, reste en
 * TypeScript testé plutôt qu'en vue SQL, pour ne pas effacer les garanties
 * propres à chaque table.
 */
export type CrmTimelineKind =
  | 'manifest_locked'
  | 'outbound_sent'
  | 'outbound_event'
  | 'send_failure'
  | 'inbound_reply'
  | 'reply_analysis'
  | 'reply_draft'
  /**
   * HERMES-CONVERSATION-R2 — une intention conversationnelle AUTONOME, telle
   * que `hermes_conversation_plans` la porte : réponse automatique ou relance.
   *
   * Un genre à part de `reply_draft`, et c'est le point : une réponse proposée
   * par le rail assisté attend un humain, celle-ci a été DÉCIDÉE par une
   * politique. Les confondre ferait relire « quelqu'un a écrit ça » sur un
   * texte que personne n'a lu.
   */
  | 'conversation_plan'
  | 'state_transition'
  | 'milestone'
  | 'alert';

export type CrmTimelineDirection = 'outbound' | 'inbound' | 'system';

export interface CrmTimelineEntry {
  readonly id: string;
  readonly kind: CrmTimelineKind;
  readonly direction: CrmTimelineDirection;
  readonly occurredAt: string;
  readonly channel: CrmChannel | null;
  readonly title: string;
  /** Le texte intégral quand il y en a un (message envoyé, réponse reçue). */
  readonly body: string | null;
  /** Faits courts affichés sous le titre. Jamais une interprétation. */
  readonly facts: readonly string[];
}

/**
 * Rang de départage quand deux événements portent la même date.
 *
 * Le cas n'est pas théorique : un envoi, sa tentative provider et la
 * transition d'état qu'il provoque peuvent partager la même seconde. Sans
 * ordre stable, deux rendus du même prospect donneraient deux ordres — et une
 * timeline qui bouge sans que rien n'ait changé n'est plus une preuve.
 *
 * L'ordre choisi est causal : ce qui a déclenché apparaît avant ce qui en
 * découle (dans un tri décroissant, l'effet est donc au-dessus de sa cause).
 */
const KIND_RANK: Readonly<Record<CrmTimelineKind, number>> = Object.freeze({
  manifest_locked: 0,
  send_failure: 1,
  outbound_sent: 2,
  outbound_event: 3,
  inbound_reply: 4,
  reply_analysis: 5,
  state_transition: 6,
  reply_draft: 7,
  conversation_plan: 8,
  milestone: 9,
  alert: 10,
});

/**
 * Trie une timeline, du plus récent au plus ancien.
 *
 * Totalement déterministe : date, puis rang causal, puis identifiant. Deux
 * appels sur la même entrée rendent le même ordre, et le tri ne dépend jamais
 * de l'ordre d'arrivée des lignes SQL.
 */
export function sortTimeline(entries: readonly CrmTimelineEntry[]): CrmTimelineEntry[] {
  return [...entries].sort((a, b) => {
    const ta = Date.parse(a.occurredAt);
    const tb = Date.parse(b.occurredAt);
    if (ta !== tb) return tb - ta;
    const ra = KIND_RANK[a.kind];
    const rb = KIND_RANK[b.kind];
    if (ra !== rb) return rb - ra;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

/** Les canaux qui ont RÉELLEMENT produit un événement. Jamais une liste théorique. */
export function activeChannels(entries: readonly CrmTimelineEntry[]): CrmChannel[] {
  const seen = new Set<CrmChannel>();
  for (const entry of entries) if (entry.channel !== null) seen.add(entry.channel);
  return CRM_CHANNELS.filter((channel) => seen.has(channel));
}

/**
 * Genre d'événement → teinte.
 *
 * Le poids visuel suit l'irréversibilité : un envoi réel et une réponse reçue
 * sont les deux seuls faits que personne ne peut défaire, et ce sont les deux
 * seuls à porter une couleur pleine dans la colonne centrale. Ce que le
 * système a préparé, conclu ou journalisé reste ardoise.
 */
export const TIMELINE_TONE: Readonly<Record<CrmTimelineKind, CrmTone>> = Object.freeze({
  manifest_locked: 'blue',
  // Ce que la MACHINE a produit ou constaté est cyan : envoi parti, analyse,
  // brouillon, plan. Aucun de ces événements ne demande une décision, et aucun
  // n'appartient à la marque — le violet qu'ils portaient disait les deux.
  outbound_sent: 'cyan',
  outbound_event: 'slate',
  send_failure: 'red',
  inbound_reply: 'green',
  reply_analysis: 'cyan',
  reply_draft: 'cyan',
  conversation_plan: 'cyan',
  state_transition: 'slate',
  milestone: 'green',
  alert: 'orange',
});

/**
 * Regroupe une timeline par JOUR, dans l'ordre déjà trié.
 *
 * Un fil de trente événements sans repère de date se lit comme une liste ; avec
 * ses jours, il se lit comme une histoire. Le regroupement ne trie rien et ne
 * réordonne rien — il coupe la suite reçue à chaque changement de date, donc il
 * hérite du tri déterministe de `sortTimeline` sans en ajouter un second.
 */
export interface CrmTimelineDay {
  readonly key: string;
  readonly label: string;
  readonly entries: readonly CrmTimelineEntry[];
}

export function groupTimelineByDay(
  entries: readonly CrmTimelineEntry[],
  now: number,
): CrmTimelineDay[] {
  const days: CrmTimelineDay[] = [];
  let current: { key: string; label: string; entries: CrmTimelineEntry[] } | null = null;
  for (const entry of entries) {
    const key = dayKey(entry.occurredAt);
    if (current === null || current.key !== key) {
      current = { key, label: formatDayLabel(entry.occurredAt, now), entries: [] };
      days.push(current);
    }
    current.entries.push(entry);
  }
  return days;
}

/** `2026-08-12`, dans le fuseau du serveur — la même clé pour deux mêmes jours. */
export function dayKey(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'inconnu';
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  return `${parsed.getFullYear()}-${month}-${day}`;
}

/** « Aujourd'hui », « Hier », puis la date écrite en toutes lettres. */
export function formatDayLabel(value: string, now: number): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'date inconnue';
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  const key = dayKey(value);
  if (key === dayKey(today.toISOString())) return "Aujourd'hui";
  if (key === dayKey(yesterday.toISOString())) return 'Hier';
  return parsed.toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    ...(parsed.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}

// ---------------------------------------------------------------------------
// Formatage
// ---------------------------------------------------------------------------

/** Date courte, stable, sans dépendance de fuseau côté client. */
export function formatDate(value: string | null): string {
  if (value === null) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export function formatDateTime(value: string | null): string {
  if (value === null) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * `24/08 09:55` — la même date, sans l'année, pour une cellule de table.
 *
 * L'année n'est pas retirée par goût de la brièveté : `formatDateTime` produit
 * dix-sept caractères, et une colonne de table assez large pour les contenir
 * prend la place de ce qu'on est venu lire. L'horodatage COMPLET reste dans
 * l'infobulle, donc rien n'est perdu — c'est la définition d'une divulgation
 * progressive plutôt que d'une troncature.
 */
export function formatDateTimeShort(value: string | null): string {
  if (value === null) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** `14:32` — l'heure seule, quand le jour est déjà écrit au-dessus. */
export function formatTime(value: string | null): string {
  if (value === null) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

/** « il y a 3 j » — relatif, pour une colonne dense où la date exacte gêne. */
export function formatAge(value: string | null, now: number): string {
  if (value === null) return '—';
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return '—';
  const seconds = Math.max(0, Math.round((now - parsed) / 1000));
  if (seconds < 60) return "à l'instant";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} j`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} mois`;
  return `${Math.round(months / 12)} an(s)`;
}

/**
 * Découpe un texte produit par le pipeline autour de ses références de preuve.
 *
 * `prospect_research.summary` et `prospect_angles.personalization` citent les
 * `prospect_evidence.id` entre crochets — c'est ce qui rend une affirmation
 * vérifiable, et il n'est donc pas question de les supprimer. Mais laissées en
 * pleine ligne, six UUID de 36 signes rendent un paragraphe illisible.
 *
 * Le texte est donc découpé, jamais amputé : la prose d'un côté, les
 * références de l'autre, à charge de l'affichage de leur donner deux poids
 * visuels différents.
 */
export interface TextSegment {
  readonly text: string;
  readonly isRef: boolean;
}

/**
 * Volontairement plus permissif qu'un UUID strict : au moins une référence
 * réellement écrite en base est tronquée (`cd83dd66-4e7f-449f-a99e-dc7e`).
 * Exiger la forme canonique la laisserait en clair au milieu d'une phrase,
 * c'est-à-dire échouer exactement sur le cas qui gêne.
 */
const EVIDENCE_REF = /\[([0-9a-f]{8}(?:-[0-9a-f]{4,12})+)\]/gi;

/**
 * Une référence OUVERTE en fin de texte, jamais refermée.
 *
 * Le cas est réel et non théorique : au moins un `prospect_research` de ce
 * dépôt se termine par `[cd83dd66-4e7f-449f-a99e-dc7e`, sans crochet fermant.
 * Le motif ci-dessus l'ignore, et l'identifiant restait alors en clair au bout
 * d'une phrase — exactement le rendu que la mise en puce doit éviter.
 *
 * Elle est donc reconnue, mais uniquement en FIN de chaîne : au milieu d'un
 * texte, un crochet non refermé n'est pas une référence tronquée, c'est une
 * phrase qui contient un crochet.
 */
const EVIDENCE_REF_OPEN = /\[([0-9a-f]{8}(?:-[0-9a-f]{4,12})*)$/i;

export function splitEvidenceRefs(value: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const match of value.matchAll(EVIDENCE_REF)) {
    const start = match.index;
    if (start > cursor) segments.push({ text: value.slice(cursor, start), isRef: false });
    // Huit signes suffisent à retrouver la ligne et tiennent sur une puce.
    segments.push({ text: (match[1] ?? '').slice(0, 8), isRef: true });
    cursor = start + match[0].length;
  }

  const tail = value.slice(cursor);
  const open = EVIDENCE_REF_OPEN.exec(tail);
  if (open !== null) {
    const before = tail.slice(0, open.index);
    if (before.length > 0) segments.push({ text: before, isRef: false });
    segments.push({ text: (open[1] ?? '').slice(0, 8), isRef: true });
    return segments;
  }

  if (tail.length > 0) segments.push({ text: tail, isRef: false });
  return segments;
}

/** `https://exemple.fr/contact?x=1` → `exemple.fr/contact`. */
export function shortenUrl(url: string | null): string | null {
  if (url === null) return null;
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;
  const withoutScheme = trimmed.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  const withoutQuery = withoutScheme.split('?')[0] ?? withoutScheme;
  const withoutTrailingSlash = withoutQuery.replace(/\/+$/, '');
  return withoutTrailingSlash.length > 44
    ? `${withoutTrailingSlash.slice(0, 43)}…`
    : withoutTrailingSlash;
}
