import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  campaignSchema,
  nicheSchema,
  scoringProfileSchema,
  modelRoutingSchema,
  instagramRailSchema,
  instagramObserverSchema,
  conversationPolicySchema,
  bookingPolicySchema,
  socialMaturitySchema,
  icpProfileSchema,
  commercialIntelligenceProfileSchema,
  type CampaignConfig,
  type NicheConfig,
  type ScoringProfile,
  type ModelRoutingConfig,
  type InstagramRailConfig,
  type InstagramObserverConfig,
  type ConversationPolicyConfig,
  type BookingPolicyConfig,
  type SocialMaturityProfile,
  type IcpProfile,
  type CommercialIntelligenceProfile,
} from '@/lib/config/schema';
import { assertVerticalAllowed } from '@/lib/config/verticalPolicy';
import {
  operatorProfileSchema,
  UNCONFIGURED_OPERATOR_PROFILE,
  type OperatorProfile,
} from '@/lib/config/operatorProfile';

const CONFIG_ROOT = resolve(process.cwd(), 'config');

/**
 * Il n'existe AUCUN profil ICP par défaut dans cette édition.
 *
 * C'est la différence entre « un profil vide » et « pas de profil » : un défaut
 * vide se charge, traverse les gates et finit par décider de quelque chose. Une
 * absence, elle, force l'appelant à nommer le profil qu'il veut — et sur une
 * instance fraîche, il n'y en a aucun à nommer.
 */
export const DEFAULT_ICP_PROFILE_KEY: string | null = null;

/**
 * Le profil ICP RETENU par cette instance, nommé par l'opérateur.
 *
 * Une variable d'environnement plutôt qu'une constante : le choix d'un ICP est
 * une décision d'exploitation, il change quand le marché change, et le graver
 * dans le code obligerait à un diff pour l'ajuster. Absente, il n'y en a pas —
 * et « pas d'ICP » est un état parfaitement valide pour une instance fraîche.
 */
export function resolveIcpProfileKey(): string | null {
  const raw = process.env['OUTBOUND_ICP_PROFILE'];
  if (raw === undefined) return DEFAULT_ICP_PROFILE_KEY;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_ICP_PROFILE_KEY;
}

/** L'état ICP d'une instance, lu depuis le disque et jamais deviné. */
export function icpProfileStatus(key: string | null = resolveIcpProfileKey()): 'CONFIGURED' | 'UNCONFIGURED' {
  if (key === null || key.trim().length === 0) return 'UNCONFIGURED';
  const found = ['json', 'yaml'].some((ext) => existsSync(resolve(CONFIG_ROOT, 'icp', `${key}.${ext}`)));
  return found ? 'CONFIGURED' : 'UNCONFIGURED';
}

/** Levée quand un chemin qui a besoin d'un ICP est atteint sans ICP. */
export class IcpProfileUnconfiguredError extends Error {
  constructor() {
    super(
      "Aucun profil ICP n'est configuré. Renseigner OUTBOUND_ICP_PROFILE avec la clé d'un fichier de config/icp/ " +
        '(voir config/icp/example-icp.json, et CLAUDE_SETUP.md, étape ICP).',
    );
    this.name = 'IcpProfileUnconfiguredError';
  }
}

/**
 * Le profil ICP de cette instance, ou une ERREUR. Jamais un profil vide :
 * un ICP vide laisserait passer tout le monde, ce qui est exactement le
 * contraire de ce qu'un ICP sert à faire.
 */
export function loadConfiguredIcpProfile(): IcpProfile {
  const key = resolveIcpProfileKey();
  if (key === null) throw new IcpProfileUnconfiguredError();
  return loadIcpProfile(key);
}

/**
 * L'identité commerciale de l'opérateur.
 *
 * Fichier ABSENT sur une instance fraîche, et son absence n'est pas une erreur :
 * elle est le statut `UNCONFIGURED`, que les chemins qui parlent à un inconnu
 * relisent avant d'écrire quoi que ce soit. Ce qui EST une erreur, c'est un
 * fichier présent mais invalide — on ne devine pas ce qu'un opérateur a voulu
 * dire.
 */
export function loadOperatorProfile(): OperatorProfile {
  const path = ['json', 'yaml', 'yml']
    .map((ext) => resolve(CONFIG_ROOT, `operator.${ext}`))
    .find((candidate) => existsSync(candidate));
  if (path === undefined) return UNCONFIGURED_OPERATOR_PROFILE;

  const parsed = operatorProfileSchema.parse(readStructured(path));
  assertVerticalAllowed(parsed.vertical, parsed.audienceDescription, parsed.senderDescription);
  return Object.freeze({
    status: 'CONFIGURED' as const,
    operatorName: parsed.operatorName,
    senderDescription: parsed.senderDescription,
    audienceDescription: parsed.audienceDescription,
    vertical: parsed.vertical,
    voiceExamples: Object.freeze([...parsed.voiceExamples]),
  });
}

function readStructured(path: string): unknown {
  const text = readFileSync(path, 'utf8');
  if (path.endsWith('.yaml') || path.endsWith('.yml')) return parseYaml(text);
  return JSON.parse(text);
}

function firstExisting(candidates: string[]): string {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Config not found. Looked for:\n  ${candidates.join('\n  ')}`);
}

export function loadCampaign(slugOrPath: string): CampaignConfig {
  const path = firstExisting([
    resolve(process.cwd(), slugOrPath),
    resolve(CONFIG_ROOT, 'campaigns', `${slugOrPath}.yaml`),
    resolve(CONFIG_ROOT, 'campaigns', `${slugOrPath}.yml`),
    resolve(CONFIG_ROOT, 'campaigns', `${slugOrPath}.json`),
  ]);
  const campaign = campaignSchema.parse(readStructured(path));
  assertVerticalAllowed(campaign.slug, campaign.name, campaign.niche);
  return campaign;
}

export function loadNiche(key: string): NicheConfig {
  const path = firstExisting([
    resolve(CONFIG_ROOT, 'niches', `${key}.json`),
    resolve(CONFIG_ROOT, 'niches', `${key}.yaml`),
  ]);
  const niche = nicheSchema.parse(readStructured(path));
  // Toutes les surfaces qui NOMMENT le métier, jointes : une verticale répartie
  // entre le libellé et les requêtes décrit le même métier qu'une verticale
  // écrite sur une seule ligne.
  assertVerticalAllowed(
    niche.key,
    niche.label,
    niche.description,
    ...niche.positiveTerms,
    ...niche.coreActivityTerms,
    ...niche.serviceTerms,
    ...niche.premiumTerms,
    ...niche.searchQueries,
    ...niche.commercialQueries.core,
    ...niche.commercialQueries.secondary,
    ...niche.commercialQueries.serviceSpecific,
    ...niche.commercialQueries.inScope,
  );
  return niche;
}

/**
 * ICP-R1 — le profil de client idéal. Chargé à part de la niche, parce qu'il
 * répond à une autre question (« quel type d'entreprise ? » et non « quel
 * métier ? ») et que les confondre a déjà coûté un faux positif.
 */
export function loadIcpProfile(key: string): IcpProfile {
  const path = firstExisting([
    resolve(CONFIG_ROOT, 'icp', `${key}.json`),
    resolve(CONFIG_ROOT, 'icp', `${key}.yaml`),
  ]);
  const profile = icpProfileSchema.parse(readStructured(path));
  assertVerticalAllowed(profile.key, profile.label, profile.description);
  return profile;
}

export function loadScoringProfile(key: string): ScoringProfile {
  const path = firstExisting([
    resolve(CONFIG_ROOT, 'scoring', `${key}.json`),
    resolve(CONFIG_ROOT, 'scoring', `${key}.yaml`),
  ]);
  return scoringProfileSchema.parse(readStructured(path));
}

/**
 * Le profil de priorité commerciale par défaut.
 *
 * Celui livré est un profil d'EXEMPLE, aux poids PLATS et non calibrés : il
 * donne une forme valide à lire, il ne classe rien correctement, et il le dit
 * dans son propre champ `note`. Le calibrer est une étape d'installation, pas
 * un raffinement optionnel — voir CLAUDE_SETUP.md.
 *
 * `OUTBOUND_COMMERCIAL_PROFILE` permet d'en désigner un autre sans diff.
 */
export const DEFAULT_COMMERCIAL_INTELLIGENCE_KEY = 'example-shadow-v1';

function resolveCommercialIntelligenceKey(): string {
  const raw = process.env['OUTBOUND_COMMERCIAL_PROFILE'];
  if (raw === undefined) return DEFAULT_COMMERCIAL_INTELLIGENCE_KEY;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_COMMERCIAL_INTELLIGENCE_KEY;
}

/**
 * R7.1 — les poids de la priorité commerciale.
 *
 * Chargé séparément du profil de scoring, et c'est le sujet même de R7 : le
 * score historique répond à « est-ce un bon business », cette couche à « est-ce
 * un prospect que nous devrions contacter maintenant ». Les ranger dans le même
 * fichier reviendrait à admettre que c'est la même question.
 */
export function loadCommercialIntelligenceProfile(
  key = resolveCommercialIntelligenceKey(),
): CommercialIntelligenceProfile {
  const path = firstExisting([
    resolve(CONFIG_ROOT, 'commercial-intelligence', `${key}.json`),
    resolve(CONFIG_ROOT, 'commercial-intelligence', `${key}.yaml`),
  ]);
  return commercialIntelligenceProfileSchema.parse(readStructured(path));
}

/**
 * Le routage des modèles, avec un retour arrière qui tient en une variable.
 *
 * R5.1 change les modèles et les délais du chemin research/angle/message sur la
 * foi d'un benchmark. Le §22 exige que le profil R5 reste disponible — et
 * « disponible » ne peut pas vouloir dire « retrouvable dans l'historique Git » :
 * un retour arrière qu'il faut reconstituer sous pression n'est pas un retour
 * arrière.
 *
 *   OUTBOUND_MODELS_CONFIG=config/models.r5.json npm run campaign:run
 *
 * `config/models.r5.json` est le routage R5 figé, gardé au dépôt exactement pour
 * cela. Un chemin absent est une erreur, jamais un repli silencieux sur le
 * fichier courant : croire qu'on tourne en R5 alors qu'on tourne en R5.1 serait
 * pire que l'échec.
 */
export function loadModelRouting(): ModelRoutingConfig {
  const override = process.env['OUTBOUND_MODELS_CONFIG'];
  if (override && override.trim().length > 0) {
    const path = resolve(process.cwd(), override.trim());
    if (!existsSync(path)) {
      throw new Error(`OUTBOUND_MODELS_CONFIG pointe sur un fichier absent : ${path}`);
    }
    return modelRoutingSchema.parse(readStructured(path));
  }
  const path = firstExisting([resolve(CONFIG_ROOT, 'models.json'), resolve(CONFIG_ROOT, 'models.yaml')]);
  return modelRoutingSchema.parse(readStructured(path));
}

/**
 * Les bornes du rail Instagram (IG-R1). Fichier obligatoire : un rail sans
 * plafonds ne doit pas démarrer avec des valeurs implicites — l'absence de
 * configuration est une erreur, jamais un défaut permissif.
 */
export function loadInstagramRail(): InstagramRailConfig {
  const path = firstExisting([resolve(CONFIG_ROOT, 'instagram.json'), resolve(CONFIG_ROOT, 'instagram.yaml')]);
  return instagramRailSchema.parse(readStructured(path));
}

/**
 * R7.3C §5 — les bornes de l'OBSERVER, lues dans un fichier qui n'est pas celui
 * du rail outbound.
 *
 * Deux fichiers, deux chargeurs, aucune valeur partagée : c'est ce qui rend
 * impossible qu'une édition destinée à l'observation change quoi que ce soit au
 * rail qui, lui, sait envoyer.
 */
export function loadInstagramObserver(): InstagramObserverConfig {
  const path = firstExisting([
    resolve(CONFIG_ROOT, 'r7-instagram-observer.json'),
    resolve(CONFIG_ROOT, 'r7-instagram-observer.yaml'),
  ]);
  return instagramObserverSchema.parse(readStructured(path));
}

/**
 * R7.3C §23 — les poids de l'axe social.
 *
 * Un fichier distinct de celui de Model A, pour que la comparaison des deux
 * modèles porte sur un ajout lisible plutôt que sur un profil réécrit.
 */
export function loadSocialMaturityProfile(key = 'r7-social-maturity'): SocialMaturityProfile {
  const path = firstExisting([
    resolve(process.cwd(), key),
    resolve(CONFIG_ROOT, `${key}.json`),
    resolve(CONFIG_ROOT, `${key}.yaml`),
  ]);
  return socialMaturitySchema.parse(readStructured(path));
}

/**
 * HERMES-CONVERSATION-R2 — les bornes de la conversation autonome.
 *
 * Fichier OBLIGATOIRE, comme celui du rail Instagram et pour la même raison :
 * une conversation autonome sans délais ni plafond de relances ne doit pas
 * démarrer sur des valeurs implicites. L'absence de configuration est une
 * erreur, jamais un défaut permissif.
 *
 * Chargé SÉPARÉMENT de `loadInstagramRail` : les deux fichiers décrivent deux
 * choses — ce qui décide, et ce qui envoie — et aucune valeur n'est partagée.
 */
export function loadConversationPolicy(): ConversationPolicyConfig {
  const path = firstExisting([
    resolve(CONFIG_ROOT, 'conversation.json'),
    resolve(CONFIG_ROOT, 'conversation.yaml'),
  ]);
  return conversationPolicySchema.parse(readStructured(path));
}

/**
 * HERMES-NATIVE-BOOKING-R1 — les bornes du rendez-vous natif.
 *
 * Fichier OBLIGATOIRE, comme celui du rail Instagram et de la conversation, et
 * pour la même raison : un moteur de disponibilité qui démarrerait sur des
 * valeurs implicites déciderait à la place de l'opérateur quand il est
 * joignable. L'absence de configuration est une erreur, jamais un défaut
 * permissif — et `appointmentDurationMinutes` n'a même pas de défaut de schéma.
 */
export function loadBookingPolicy(): BookingPolicyConfig {
  const path = firstExisting([
    resolve(CONFIG_ROOT, 'booking.json'),
    resolve(CONFIG_ROOT, 'booking.yaml'),
  ]);
  return bookingPolicySchema.parse(readStructured(path));
}
