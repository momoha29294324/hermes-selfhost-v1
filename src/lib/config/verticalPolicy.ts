/**
 * La politique de VERTICALE de cette édition de Hermes.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce module décide
 * ---------------------------------------------------------------------------
 * Hermes est un moteur de prospection : il ne sait rien d'un métier tant qu'un
 * opérateur ne le lui a pas déclaré. Cette édition réserve une famille de
 * métiers, qui n'y est pas disponible. Une déclaration qui tombe dedans est
 * REFUSÉE à la configuration — donc avant qu'une campagne existe, avant qu'un
 * prospect soit découvert, et très avant qu'un message puisse partir.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi c'est du code, et pas une consigne
 * ---------------------------------------------------------------------------
 * Une consigne adressée à un agent est du contexte : elle est lue, pondérée,
 * parfois oubliée. Une porte qui décide qu'une campagne peut exister ne peut
 * pas dépendre de cela. `assessVertical` est donc une fonction PURE, sans
 * réseau, sans base, sans modèle — deux appels sur la même chaîne rendent le
 * même verdict, et un test rejoue le corpus à chaque `npm run validate`.
 *
 * ---------------------------------------------------------------------------
 * Le sens de « fail-closed » ici
 * ---------------------------------------------------------------------------
 * Le défaut est ALLOWED, et c'est délibéré : refuser tout ce qu'on ne comprend
 * pas rendrait Hermes inutilisable pour les métiers légitimes, qui sont
 * l'immense majorité. Ce qui est fail-closed, c'est le CHEMIN : la porte est
 * appelée par le chargeur de configuration lui-même, pas par chaque appelant.
 * Ajouter une commande qui charge une niche ne peut donc pas oublier de
 * demander l'autorisation — elle passe par le même chargeur ou par aucun.
 */

/** Le verdict rendu sur une déclaration de verticale. */
export type VerticalStatus = 'ALLOWED' | 'RESERVED';

export interface VerticalVerdict {
  readonly status: VerticalStatus;
  /**
   * Le motif interne, pour les tests et le journal d'un opérateur qui
   * diagnostique sa propre configuration. Il n'est jamais montré à un
   * prospect, et ne cite aucune donnée d'une autre instance.
   */
  readonly reason: string | null;
}

const ALLOWED: VerticalVerdict = Object.freeze({ status: 'ALLOWED', reason: null });

/**
 * Le message rendu à l'utilisateur. Générique et invariable : il dit ce qui
 * est vrai — cette verticale n'est pas disponible ici — sans commenter les
 * autres, ni prétendre qu'aucune réserve n'existe.
 */
export const RESERVED_VERTICAL_MESSAGE =
  "Cette verticale n'est pas disponible dans cette édition de Hermes.";

/**
 * Normalisation volontairement agressive, et symétrique pour toutes les
 * entrées : accents retirés, casse écrasée, tout ce qui n'est pas une lettre
 * ou un chiffre devient une frontière de mot. « Esthétique-Automobile »,
 * « ESTHETIQUE_AUTOMOBILE » et « esthétique automobile » se lisent donc
 * pareil, sans qu'aucune variante n'ait à être écrite à la main.
 */
export function normalizeVerticalText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
}

/**
 * Les termes qui, à eux seuls, nomment le métier réservé. Ils sont comparés
 * sur des MOTS entiers : « retailing » ne contient pas le mot « detailing »,
 * et « scar » ne contient pas le mot « car ».
 */
const STANDALONE_TERMS: readonly string[] = Object.freeze([
  'detailing',
  'detailer',
  'detailers',
  'carwash',
  'valeting',
  'valeter',
]);

/**
 * Les paires. Aucun de ces mots ne suffit seul — « nettoyage » désigne un
 * métier parfaitement disponible ici, et « voiture » aussi. C'est leur
 * RENCONTRE dans une même déclaration qui nomme la verticale réservée.
 */
const VEHICLE_TERMS: readonly string[] = Object.freeze([
  'auto',
  'autos',
  'automobile',
  'automobiles',
  'voiture',
  'voitures',
  'vehicule',
  'vehicules',
  'vehicle',
  'vehicles',
  'car',
  'cars',
  'moto',
  'motos',
  'motorcycle',
  'camion',
  'camions',
  'truck',
  'trucks',
  'van',
  'vans',
  'utilitaire',
  'utilitaires',
]);

const TREATMENT_TERMS: readonly string[] = Object.freeze([
  'nettoyage',
  'nettoyer',
  'nettoyeur',
  'lavage',
  'laver',
  'lave',
  'lavable',
  'wash',
  'washing',
  'washer',
  'cleaning',
  'cleaner',
  'clean',
  'esthetique',
  'esthetic',
  'esthetics',
  'detail',
  'details',
  'polissage',
  'polish',
  'polishing',
  'ceramique',
  'ceramic',
  'ppf',
  'covering',
  'preparation',
  'preparateur',
  'renovation',
  'pressing',
]);

function words(normalized: string): ReadonlySet<string> {
  return new Set(normalized.split(' ').filter((word) => word.length > 0));
}

/**
 * Rend le verdict pour un ensemble de déclarations. Toutes les chaînes sont
 * jointes AVANT l'analyse : une paire répartie entre le libellé (« nettoyage »)
 * et le mot-clé de recherche (« voiture ») décrit la même verticale que si
 * elle tenait sur une seule ligne, et la découper ne doit pas la rendre
 * invisible.
 */
export function assessVertical(...declarations: readonly (string | null | undefined)[]): VerticalVerdict {
  const normalized = normalizeVerticalText(
    declarations.filter((value): value is string => typeof value === 'string' && value.length > 0).join(' '),
  );
  if (normalized.length === 0) return ALLOWED;

  const present = words(normalized);

  for (const term of STANDALONE_TERMS) {
    if (present.has(term)) {
      return Object.freeze({ status: 'RESERVED' as const, reason: `standalone:${term}` });
    }
  }

  // « car wash » et « car washing » s'écrivent en deux mots : la règle de
  // co-occurrence ci-dessous les couvre déjà, mais on le vérifie séparément
  // pour que le motif rendu nomme la vraie raison.
  for (const vehicle of VEHICLE_TERMS) {
    if (!present.has(vehicle)) continue;
    for (const treatment of TREATMENT_TERMS) {
      if (present.has(treatment)) {
        return Object.freeze({ status: 'RESERVED' as const, reason: `pair:${vehicle}+${treatment}` });
      }
    }
  }

  return ALLOWED;
}

/** L'erreur levée par le chargeur de configuration. Son message est générique. */
export class ReservedVerticalError extends Error {
  constructor() {
    super(RESERVED_VERTICAL_MESSAGE);
    this.name = 'ReservedVerticalError';
  }
}

/**
 * La forme appelée par les chargeurs : elle LÈVE plutôt qu'elle ne rend un
 * booléen, pour qu'aucun appelant ne puisse ignorer le verdict par omission.
 */
export function assertVerticalAllowed(...declarations: readonly (string | null | undefined)[]): void {
  if (assessVertical(...declarations).status === 'RESERVED') throw new ReservedVerticalError();
}
