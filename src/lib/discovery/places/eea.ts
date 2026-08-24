import { env, envBool } from '@/lib/env';

/**
 * The EEA regime for the Places API, expressed as code rather than as a comment.
 *
 * R2 built the Places rail against the STANDARD Google Maps Platform terms and
 * said so plainly: "Les conditions EEE n'ont **pas** été vérifiées — elles
 * peuvent différer, dans un sens comme dans l'autre." R2.1 verified them. They
 * differ, in both directions, and the difference is load-bearing.
 *
 * What changed in our favour: the EEA Terms of Service DELETE the clause R2
 * treated as its headline unresolved risk. Google's own FAQ states that the EEA
 * ToS "removes three provisions from the 'Restrictions Against Misusing the
 * Services' section", the first being "No Re-Creating Google Products or
 * Features" — the clause containing "listings or directory service or to create
 * or augment an advertising product". It is absent from the EEA ToS text, and
 * Google commits to removing clauses of the same effect from the Service
 * Specific Terms too. For an EEA billing account, that prohibition is not the
 * operative constraint.
 *
 * What changed against us, and much more sharply: the EEA regime replaces an
 * open licence bounded by prohibitions with a CLOSED ALLOWLIST.
 *
 *   EEA Service Specific Terms §15.2 — "Other than latitude, longitude, and
 *   place_id, Customer may only use the Google Maps Content from the Places API
 *   as permitted by the Places API EEA Permitted Uses."
 *
 * "May only use ... as permitted by" inverts the default. Under the standard
 * terms, a use was allowed unless prohibited. Under the EEA terms, a use of
 * Places content other than lat/lng/place_id is forbidden unless it appears in a
 * list of nine items. There is no residual "any other legitimate business
 * purpose" clause.
 *
 * That makes "which permitted use are we operating under" a question with a
 * required answer, not an implied one — and it is a question for un opérateur, not
 * for this module. So the rail refuses to issue any call that carries restricted
 * content until an operator has named the permitted use in the environment. An
 * unnamed assumption becomes a recorded decision.
 *
 * See la documentation d’installation for the sources and the full reasoning.
 */

/**
 * The nine Permitted Uses, transcribed verbatim from
 * cloud.google.com/terms/maps-platform/eea-places-api-permitted-uses
 * (last modified June 4, 2025; read 2026-08-10).
 *
 * Kept word for word because a paraphrase is where a compliance argument quietly
 * acquires the meaning its author wanted.
 */
export const EEA_PERMITTED_USES = {
  address_autocomplete: 'facilitate address lookup and autocompletion functionalities',
  own_locations: "display information about Customer's physical stores, offices, or official service points",
  sales_opportunities:
    "enable Customers to visualize and manage Places content related to a sales team's customers or opportunities",
  tasks_and_notes:
    'enable users to associate tasks, notes, or reminders with specific named places within a productivity, chat, personal organization, or note-taking functionality',
  real_estate_context:
    'show information about nearby points of interest (e.g., schools, parks, grocery stores) to provide context for a real estate listing or rental property being viewed by the user',
  financial_transaction: 'show information about a Place related to a financial transaction',
  games: 'integrate Places as points of interest or objectives within a game',
  social_tagging:
    'allow users to tag or share a specific Place in their posts, event creations, or shared experiences within a social platform',
  smart_home: 'allow users to set and monitor location context for their personal smart home routines or IoT device actions',
} as const;

export type EeaPermittedUse = keyof typeof EEA_PERMITTED_USES;

/**
 * Fields carved OUT of the §15.2 restriction.
 *
 * These three may be used for any purpose the rest of the Agreement allows, with
 * no reference to the Permitted Uses list. Everything else the Places API returns
 * is "restricted content" for our purposes.
 */
export const EEA_UNRESTRICTED_FIELDS = ['id', 'name', 'location', 'nextPageToken', 'attributions'] as const;

/**
 * True when a field mask carries only content exempt from §15.2.
 *
 * `id` is the place ID; `location` is latitude/longitude. `name` is the Places
 * resource name (`places/ChIJ…`), which is the place ID in resource form, not the
 * display name — `displayName` is a different, restricted field. Confusing the
 * two is the easiest way to believe a mask is exempt when it is not, so the two
 * names are kept apart deliberately here.
 */
export function maskIsUnrestrictedUnderEea(fields: readonly string[]): boolean {
  return fields.every((field) => {
    const bare = field.startsWith('places.') ? field.slice('places.'.length) : field;
    const root = bare.split('.')[0] ?? bare;
    return (EEA_UNRESTRICTED_FIELDS as readonly string[]).includes(root);
  });
}

export class EeaPermittedUseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EeaPermittedUseError';
  }
}

export interface EeaStance {
  /** Whether the billing account is governed by the EEA terms. */
  eeaBillingAddress: boolean;
  /** The permitted use the operator has declared, or null if none. */
  declaredUse: EeaPermittedUse | null;
  /** Whether restricted Places content may be requested at all. */
  restrictedContentAllowed: boolean;
  reason: string;
}

/**
 * Reads the operator's declared position. Never guesses one.
 *
 * `GOOGLE_PLACES_EEA_BILLING` defaults to TRUE — a French billing address is the
 * expected case for this project, and the safe default is the stricter regime.
 * Assuming a non-EEA account would silently re-open the whole restricted-field
 * surface on nothing more than an unset variable.
 */
export function eeaStance(): EeaStance {
  const eea = envBool('GOOGLE_PLACES_EEA_BILLING', true);
  const raw = (env('GOOGLE_PLACES_EEA_PERMITTED_USE') ?? '').trim();

  if (!eea) {
    return {
      eeaBillingAddress: false,
      declaredUse: null,
      restrictedContentAllowed: true,
      reason:
        'GOOGLE_PLACES_EEA_BILLING=0 — the operator declares a non-EEA billing address, so the standard terms govern. ' +
        'Under those, §3.2.3(d)(iii) (listings/directory service, augmenting an advertising product) applies instead and is unresolved.',
    };
  }

  if (!raw || raw === 'none') {
    return {
      eeaBillingAddress: true,
      declaredUse: null,
      restrictedContentAllowed: false,
      reason:
        'GOOGLE_PLACES_EEA_PERMITTED_USE is not set. Under EEA Service Specific Terms §15.2 the use of any Places ' +
        'content other than latitude, longitude and place_id must fall within one of the nine Places API EEA ' +
        'Permitted Uses. Naming it is a decision for the operator — see la documentation d’installation §2.',
    };
  }

  if (!(raw in EEA_PERMITTED_USES)) {
    throw new EeaPermittedUseError(
      `GOOGLE_PLACES_EEA_PERMITTED_USE="${raw}" is not one of the nine documented Permitted Uses ` +
        `(${Object.keys(EEA_PERMITTED_USES).join(', ')}). A use that is not on the list is not permitted, ` +
        'and inventing a tenth is not an option the terms leave open.',
    );
  }

  const declaredUse = raw as EeaPermittedUse;
  return {
    eeaBillingAddress: true,
    declaredUse,
    restrictedContentAllowed: true,
    reason: `Operator declares EEA Permitted Use "${declaredUse}": ${EEA_PERMITTED_USES[declaredUse]}.`,
  };
}

/**
 * The gate every restricted-content call passes through.
 *
 * Called by the client BEFORE the budget is consulted and before any request is
 * built, because a compliance stop is not a spending decision: it must hold even
 * when the call would have been free. Stage 1 (`places.id`, `nextPageToken`) is
 * exempt and keeps working, which is what lets a key be smoke-tested at zero
 * cost and zero restricted-content exposure.
 */
export function assertEeaUseAllowed(fields: readonly string[], stance: EeaStance = eeaStance()): void {
  if (maskIsUnrestrictedUnderEea(fields)) return;
  if (stance.restrictedContentAllowed) return;
  throw new EeaPermittedUseError(
    `Refusing a Places call carrying restricted content (${fields.join(',')}). ${stance.reason}`,
  );
}

/**
 * Google Maps Content must not become an input to model training.
 *
 * EEA ToS §3.3.2(c)(v) — "Customer will not create content based on Google Maps
 * Content. For example, Customer will not: […] (v) use Google Maps Content to
 * improve machine learning and artificial intelligence models, including to
 * train, test, validate or fine-tune the models."
 *
 * Nothing in this repository trains a model, and classification runs on evidence
 * gathered from independent sources rather than on Places payloads. This guard
 * exists so that stays true by construction rather than by habit: any future
 * caller that tries to put a transient Places value into a prompt has to delete
 * this call to do it, and deleting it is visible in review.
 */
export function assertNotModelInput(value: unknown, context: string): void {
  if (value === null || value === undefined) return;
  throw new Error(
    `${context}: refusing to pass Google Maps Content to a model. EEA ToS §3.3.2(c)(v) forbids using it to ` +
      'train, test, validate or fine-tune models. Classify on independent evidence instead.',
  );
}

/**
 * Places latitude/longitude must not feed geometric containment analysis.
 *
 * EEA ToS §3.3.2(c)(iv) — "Customer will not create content based on Google Maps
 * Content. For example, Customer will not: […] (iv) use latitude/longitude
 * values from the Places API as an input for point-in-polygon analysis."
 *
 * R2's rail did exactly this: it fetched `location` and ran `matchesGeography`
 * to decide whether a candidate fell inside the campaign area. A radius campaign
 * makes that a point-in-DISC test rather than point-in-polygon, so it is arguably
 * outside the letter of the example — but it is the same operation the clause
 * exists to prevent, and there is a supported alternative that removes the
 * question entirely: let Google restrict the search server-side with
 * `locationRestriction`, and never evaluate the coordinates ourselves.
 *
 * R2.1 takes the alternative. This function is kept as the tripwire.
 */
export function assertNotGeometryInput(context: string): never {
  throw new Error(
    `${context}: refusing to use Places latitude/longitude as geometric input. EEA ToS §3.3.2(c)(iv) names ` +
      'point-in-polygon analysis on Places coordinates as prohibited content creation. Restrict the search ' +
      'server-side with locationRestriction instead — see la documentation d’installation §4.',
  );
}
