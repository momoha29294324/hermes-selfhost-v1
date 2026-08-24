/**
 * Field masks for the Places API, and the SKU each one lands in.
 *
 * Google bills a Places call at the HIGHEST tier present in its field mask, not
 * per field: "if you select fields in both the Essentials and the Pro SKUs, you
 * are billed based on the Pro SKU". A single stray `websiteUri` in an otherwise
 * free mask turns a $0 call into a $20/1000 one.
 *
 * That makes a hand-written mask string a cost bug waiting to happen, so masks
 * are never written by hand in this codebase. A caller names a tier; this module
 * produces the mask and the SKU, and `classifyMask` can prove after the fact
 * which tier any given mask actually falls into.
 *
 * Field-to-tier tables are transcribed from the pricing documentation of
 * 2026-08-10 — see la documentation d’installation for the sources.
 */

/** Ordered from cheapest to most expensive. The order is the billing rule. */
export const PLACES_TIERS = [
  'ids_only',
  'essentials',
  'pro',
  'enterprise',
  'enterprise_atmosphere',
] as const;

export type PlacesTier = (typeof PLACES_TIERS)[number];

export type PlacesEndpoint = 'searchText' | 'placeDetails';

/**
 * Which of the two budget envelopes a tier consumes.
 *
 * `ids_only` is free and unlimited, so it consumes neither — but it is still
 * written to the usage ledger, because "how many free calls did we make" is how
 * we prove the tiering works.
 */
export type BudgetEnvelope = 'free' | 'discovery' | 'details';

export const TIER_ENVELOPE: Record<PlacesTier, BudgetEnvelope> = {
  ids_only: 'free',
  essentials: 'discovery',
  pro: 'discovery',
  enterprise: 'details',
  enterprise_atmosphere: 'details',
};

/**
 * Bare field names per tier, as they appear in a Place Details mask.
 *
 * Search endpoints need every entry prefixed with `places.` because `places` is
 * the top-level response array; Place Details needs them bare. Copying a mask
 * between the two silently fails, so the prefix is applied here, once.
 */
const DETAILS_FIELDS: Record<PlacesTier, readonly string[]> = {
  ids_only: ['id', 'name', 'photos', 'attributions'],
  essentials: [
    'addressComponents',
    'adrFormatAddress',
    'formattedAddress',
    'shortFormattedAddress',
    'location',
    'plusCode',
    'types',
    'viewport',
  ],
  pro: [
    'accessibilityOptions',
    'businessStatus',
    'containingPlaces',
    'displayName',
    'entrances',
    'googleMapsUri',
    'iconMaskBaseUri',
    'primaryType',
    'primaryTypeDisplayName',
    'utcOffsetMinutes',
  ],
  enterprise: [
    'nationalPhoneNumber',
    'internationalPhoneNumber',
    'websiteUri',
    'rating',
    'userRatingCount',
    'regularOpeningHours',
    'currentOpeningHours',
    'currentSecondaryOpeningHours',
    'priceLevel',
  ],
  enterprise_atmosphere: [
    'reviews',
    'reviewSummary',
    'editorialSummary',
    'allowsDogs',
    'curbsidePickup',
    'delivery',
    'dineIn',
  ],
};

/**
 * Text Search collapses Details' Essentials and Pro into a single Pro tier: the
 * same `location` that costs $5/1000 through Place Details costs $32/1000 when
 * asked for in a search. Only `id`, `name` and `attributions` stay free.
 */
const SEARCH_TIER_OF_DETAILS_TIER: Record<PlacesTier, PlacesTier> = {
  ids_only: 'ids_only',
  essentials: 'pro',
  pro: 'pro',
  enterprise: 'enterprise',
  enterprise_atmosphere: 'enterprise_atmosphere',
};

/** SKU identifiers, recorded verbatim so a pricing change stays a data question. */
export const PLACES_SKU: Record<PlacesEndpoint, Record<PlacesTier, string>> = {
  searchText: {
    ids_only: '635D-A9DD-C520',
    essentials: '4FDA-34B1-A910',
    pro: '4FDA-34B1-A910',
    enterprise: 'E967-44BC-B44D',
    enterprise_atmosphere: '120C-BEC3-B48F',
  },
  placeDetails: {
    ids_only: '5C36-E272-E88F',
    essentials: '6E05-E1C3-8D85',
    pro: '4ED6-464A-2AFC',
    enterprise: '2D9A-3DE0-3766',
    enterprise_atmosphere: 'EB23-5ECC-F753',
  },
};

export class UnknownPlacesFieldError extends Error {
  constructor(readonly field: string) {
    // An unrecognised field is refused rather than assumed cheap: a new Google
    // field of unknown tier could quietly reprice every call that carries it.
    super(
      `Unknown Places field "${field}". Add it to the tier table in ` +
        'src/lib/discovery/places/fieldMask.ts with its documented SKU tier before using it.',
    );
    this.name = 'UnknownPlacesFieldError';
  }
}

function tierRank(tier: PlacesTier): number {
  return PLACES_TIERS.indexOf(tier);
}

/** The tier a single bare field belongs to. Throws on anything undocumented. */
export function tierOfField(field: string): PlacesTier {
  const bare = field.startsWith('places.') ? field.slice('places.'.length) : field;
  // Top-level on a search response, and free: it carries no place content.
  if (bare === 'nextPageToken') return 'ids_only';
  const root = bare.split('.')[0] ?? bare;
  for (const tier of PLACES_TIERS) {
    if (DETAILS_FIELDS[tier].includes(root)) return tier;
  }
  throw new UnknownPlacesFieldError(field);
}

export interface MaskPlan {
  endpoint: PlacesEndpoint;
  /** The exact value of the X-Goog-FieldMask header. No spaces — a space is a parse error. */
  header: string;
  fields: string[];
  /** The tier the whole call is billed at: the maximum over its fields. */
  tier: PlacesTier;
  sku: string;
  envelope: BudgetEnvelope;
}

/**
 * Classifies an arbitrary mask. Used by the client before every call and by the
 * tests that pin each stage to its intended SKU, so a mask that drifts upward
 * fails the suite instead of the invoice.
 */
export function classifyMask(endpoint: PlacesEndpoint, fields: readonly string[]): MaskPlan {
  if (fields.length === 0) {
    // "There is no default list of returned fields. If you omit this list, the
    // methods return an error."
    throw new Error('A Places field mask may not be empty.');
  }
  if (fields.some((field) => field.includes('*'))) {
    throw new Error(
      'The wildcard Places field mask is refused: it bills at Enterprise + Atmosphere, the most expensive SKU.',
    );
  }

  let tier: PlacesTier = 'ids_only';
  for (const field of fields) {
    const fieldTier = tierOfField(field);
    const effective = endpoint === 'searchText' ? SEARCH_TIER_OF_DETAILS_TIER[fieldTier] : fieldTier;
    if (tierRank(effective) > tierRank(tier)) tier = effective;
  }

  return {
    endpoint,
    header: fields.join(','),
    fields: [...fields],
    tier,
    sku: PLACES_SKU[endpoint][tier],
    envelope: TIER_ENVELOPE[tier],
  };
}

/**
 * The four masks R2 actually issues, and nothing else.
 *
 * Every field here is justified by a stage that consumes it. `rating` and
 * `userRatingCount` are deliberately absent: the product does not use them,
 * they may not be stored, and they sit in the most expensive tier.
 */
export const PLACES_MASKS = {
  /** Stage 1 — harvest place IDs. Free, unlimited, and the only storable payload. */
  discovery: (): MaskPlan => classifyMask('searchText', ['places.id', 'nextPageToken']),

  /**
   * Stage 2 — is its category plausible?
   *
   * R2 also asked for `location` here and ran a containment test against the
   * campaign geography. R2.1 dropped the field: EEA ToS §3.3.2(c)(iv) names
   * point-in-polygon analysis on Places coordinates as prohibited content
   * creation, and the geography question is answered better anyway — Google
   * restricts the search server-side, and the precise check runs later on the
   * address an INDEPENDENT source gives us. Dropping the field also retires the
   * 30-day coordinate lease instead of merely honouring it. Still Essentials.
   */
  locate: (): MaskPlan => classifyMask('placeDetails', ['types']),

  /** Stage 3 — is it really in the niche, and is it still open? */
  qualify: (): MaskPlan => classifyMask('placeDetails', ['displayName', 'primaryType', 'businessStatus']),

  /** Stage 4 — pointers towards sources we are allowed to keep. */
  identify: (): MaskPlan => classifyMask('placeDetails', ['websiteUri', 'nationalPhoneNumber']),

  /** Free refresh of an ageing place ID (recommended past 12 months). */
  refresh: (): MaskPlan => classifyMask('placeDetails', ['id']),
} as const;

export type PlacesStage = keyof typeof PLACES_MASKS;
