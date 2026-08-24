import type { Sql } from '@/lib/db/sql';
import type { DiscoveredBusiness } from '@/lib/discovery/types';
import {
  canonicalKey,
  compareFuzzy,
  DECISIVE_KINDS,
  identityKeys,
  locationContradicts,
  type FuzzyCandidate,
  type IdentityInput,
  type IdentityKind,
} from '@/lib/identity/resolve';
import {
  isPlatformDomain,
  nameSimilarity,
  normalizeDomain,
  normalizeEmail,
  normalizeFacebookUrl,
  normalizeInstagramHandle,
  normalizePhone,
  normalizeRegistryId,
  normalizeUrl,
} from '@/lib/identity/normalize';
import { assertNoPlacesContent } from '@/lib/discovery/places/retention';
import type { DiscoveryRail, EvidenceInput, ProspectRow } from '@/lib/repo/types';
import type { Logger } from '@/lib/logging/logger';

export interface UpsertResult {
  prospectId: string;
  created: boolean;
  matchedBy: string | null;
  reviewCandidates: number;
}

/**
 * Options de rapprochement — R5.
 *
 * `blockFuzzyMerge` existe pour un cas précis, apparu quand la découverte est
 * partie du web plutôt que du registre : le rail R5 lit le site AVANT
 * d'enregistrer l'entreprise, et peut donc soumettre le domaine au vérificateur
 * d'identité de R3 — le test le plus strict dont ce dépôt dispose. Quand ce
 * vérificateur refuse d'associer un domaine à un prospect existant, laisser une
 * ressemblance de nom fusionner les deux ensuite reviendrait à faire trancher
 * la question par le mécanisme le plus faible après que le plus fort ait dit
 * non.
 *
 * Le drapeau ne désarme que les rapprochements par indice — clé faible et
 * comparaison floue. Une clé décisive (SIREN, domaine, identifiant de lieu,
 * Instagram) fusionne toujours : deux enregistrements qui partagent un SIREN
 * sont la même société, et aucun verdict sur un site web ne change cela.
 */
export interface UpsertOptions {
  blockFuzzyMerge?: boolean;
}

/** Fields a later source may fill in, but never silently overwrite. */
const FILLABLE_FIELDS = [
  'legal_name',
  'brand_name',
  'registry_id',
  'address_line',
  'postal_code',
  'city',
  'department',
  'region',
  'latitude',
  'longitude',
  'domain',
  'website_url',
  'instagram_handle',
  'facebook_url',
  'email',
  'phone',
  'google_place_id',
  'google_rating',
  'google_review_count',
] as const;

function businessToIdentityInput(business: DiscoveredBusiness): IdentityInput {
  return {
    name: business.name,
    brandName: business.brandName ?? null,
    legalName: business.legalName ?? null,
    registryId: business.registryId ?? null,
    websiteUrl: business.websiteUrl ?? null,
    email: business.email ?? null,
    phone: business.phone ?? null,
    instagramHandle: business.instagramHandle ?? null,
    facebookUrl: business.facebookUrl ?? null,
    googlePlaceId: business.googlePlaceId ?? null,
    city: business.city ?? null,
    postalCode: business.postalCode ?? null,
    latitude: business.latitude ?? null,
    longitude: business.longitude ?? null,
  };
}

function normalizedColumns(business: DiscoveredBusiness): Record<string, unknown> {
  const website = normalizeUrl(business.websiteUrl ?? null);
  const domain = normalizeDomain(website);
  return {
    legal_name: business.legalName ?? null,
    brand_name: business.brandName ?? null,
    registry_id: normalizeRegistryId(business.registryId ?? null),
    address_line: business.addressLine ?? null,
    postal_code: business.postalCode ?? null,
    city: business.city ?? null,
    department: business.department ?? null,
    region: business.region ?? null,
    latitude: business.latitude ?? null,
    longitude: business.longitude ?? null,
    domain: domain && !isPlatformDomain(domain) ? domain : null,
    website_url: website,
    instagram_handle: normalizeInstagramHandle(business.instagramHandle ?? null),
    facebook_url: normalizeFacebookUrl(business.facebookUrl ?? null),
    email: normalizeEmail(business.email ?? null),
    phone: normalizePhone(business.phone ?? null),
    google_place_id: business.googlePlaceId ?? null,
    google_rating: business.googleRating ?? null,
    google_review_count: business.googleReviewCount ?? null,
  };
}

/**
 * The one place a Google-attributed business could become permanent, closed.
 *
 * `recordEvidenceFromBusiness` stamps every fact it writes with
 * `business.provider`. So a `DiscoveredBusiness` carrying `provider:
 * 'google_places'` would not merely persist Google Maps Content — it would
 * persist it *labelled as* a Google observation, which is both the caching
 * breach and the provenance lie in one row.
 *
 * The Places rail never constructs such an object: it returns what the registry
 * or the company's own website said, and attaches the place ID as a join key.
 * This guard is what makes that a property of the system rather than a property
 * of the current implementation of one rail. Places provenance belongs in
 * `prospect_discovery_origins` ("where did we hear about this"), never in
 * `prospects` or `prospect_evidence` ("what do we know").
 */
function assertNotGoogleSourced(business: DiscoveredBusiness): void {
  if (business.provider === 'google_places' || business.provider === 'google') {
    throw new Error(
      `Refusing to persist a business attributed to "${business.provider}". Google Maps Content may not be ` +
        'stored or presented as an observation; resolve the candidate through an independent source and ' +
        'persist that instead. See la documentation d’installation §4.',
    );
  }
}

export class ProspectRepository {
  constructor(
    private readonly sql: Sql,
    private readonly logger: Logger,
  ) {}

  /**
   * Inserts a discovered business, or attaches it to the prospect it already is.
   *
   * Resolution order:
   *   1. a decisive shared identity key (SIREN, domain, place id, Instagram, email)
   *   2. a weaker shared key (phone, facebook, name+city)
   *   3. fuzzy name/location comparison — merges only above a strict threshold,
   *      otherwise records a review candidate and keeps the rows separate
   */
  async upsertDiscovered(
    campaignId: string,
    business: DiscoveredBusiness,
    options: UpsertOptions = {},
  ): Promise<UpsertResult> {
    assertNotGoogleSourced(business);
    const blockFuzzyMerge = options.blockFuzzyMerge === true;
    const identity = businessToIdentityInput(business);
    const keys = identityKeys(identity);
    const columns = normalizedColumns(business);
    assertNoPlacesContent(columns, `upsertDiscovered(${business.provider})`);

    const matches = await this.findByIdentityKeys(campaignId, keys);
    let target: { id: string; matchedBy: string } | null = null;

    const pendingReviews: { otherId: string; similarity: number; signals: Record<string, unknown> }[] = [];

    const decisive = matches.find((m) => DECISIVE_KINDS.has(m.kind as IdentityKind));
    if (decisive) {
      target = { id: decisive.prospectId, matchedBy: `${decisive.kind}:${decisive.value}` };
    } else if (matches.length > 0) {
      /**
       * A non-decisive key — phone, Facebook, name+city — used to merge on its
       * own. `name_city` in particular is a trap once discovery gets dense: two
       * independent businesses trading under the same name in the same city is
       * ordinary, and the merge that follows silently destroys one of them.
       *
       * So a weak key now only proposes. The proposal is accepted when the two
       * records carry no contradicting location, and parked for review when they
       * do — the same asymmetry the fuzzy path already applies, for the same
       * reason: a review item costs a click, a wrong merge costs a prospect.
       */
      for (const match of matches) {
        const candidate = await this.loadFuzzyCandidate(match.prospectId);
        if (!candidate) continue;
        if (!blockFuzzyMerge && !locationContradicts(identity, candidate)) {
          target = { id: match.prospectId, matchedBy: `${match.kind}:${match.value}` };
          break;
        }
        pendingReviews.push({
          otherId: match.prospectId,
          similarity: nameSimilarity(
            identity.brandName ?? identity.name ?? '',
            candidate.brandName ?? candidate.displayName,
          ),
          signals: {
            matchedKind: match.kind,
            matchedValue: match.value,
            locationConflict: !blockFuzzyMerge,
            ...(blockFuzzyMerge ? { blockedBy: 'identity_verifier' } : {}),
          },
        });
      }
    }

    if (!target) {
      const fuzzy = await this.findFuzzyCandidates(campaignId, identity);
      for (const candidate of fuzzy) {
        const verdict = compareFuzzy(identity, candidate);
        if (verdict.decision === 'same' && !blockFuzzyMerge) {
          target = { id: candidate.id, matchedBy: `fuzzy:${verdict.similarity.toFixed(2)}` };
          pendingReviews.length = 0;
          break;
        }
        /**
         * Une fusion empêchée par le vérificateur doit rester visible. Sans
         * cette branche, `blockFuzzyMerge` transformerait un « ces deux lignes
         * se ressemblent beaucoup » en silence complet — et deux prospects
         * quasi identiques apparaîtraient dans le tableau de revue sans que
         * rien n'explique pourquoi ils y sont tous les deux.
         */
        if (verdict.decision === 'review' || (verdict.decision === 'same' && blockFuzzyMerge)) {
          pendingReviews.push({
            otherId: candidate.id,
            similarity: verdict.similarity,
            signals:
              verdict.decision === 'same'
                ? { ...verdict.signals, blockedBy: 'identity_verifier' }
                : verdict.signals,
          });
        }
      }
    }
    const reviewCandidates = pendingReviews.length;

    if (target) {
      await this.fillMissingColumns(target.id, columns);
      await this.recordIdentityKeys(campaignId, target.id, keys);
      await this.recordSource(target.id, business);
      await this.recordEvidenceFromBusiness(target.id, business);
      return { prospectId: target.id, created: false, matchedBy: target.matchedBy, reviewCandidates };
    }

    const prospectId = await this.insertProspect(campaignId, business, keys, columns);
    await this.recordIdentityKeys(campaignId, prospectId, keys);
    await this.recordSource(prospectId, business);
    await this.recordEvidenceFromBusiness(prospectId, business);

    for (const review of pendingReviews) {
      if (review.otherId === prospectId) continue;
      // `recordMergeCandidate` bascule les deux prospects en `needs_review`.
      await this.recordMergeCandidate(campaignId, prospectId, review.otherId, review.similarity, review.signals);
      this.logger.info('dedupe.review_candidate', {
        prospectId,
        otherId: review.otherId,
        similarity: Number(review.similarity.toFixed(3)),
      });
    }

    return { prospectId, created: true, matchedBy: null, reviewCandidates };
  }

  private async insertProspect(
    campaignId: string,
    business: DiscoveredBusiness,
    keys: ReturnType<typeof identityKeys>,
    columns: Record<string, unknown>,
  ): Promise<string> {
    const key = canonicalKey(keys, `${business.provider}:${business.externalId ?? business.name}`);
    const rows = await this.sql.query<{ id: string }>(
      `insert into prospects (
         campaign_id, canonical_key, display_name, legal_name, brand_name, registry_id, registry_source,
         country, address_line, postal_code, city, department, region, latitude, longitude,
         domain, website_url, instagram_handle, facebook_url, email, phone,
         google_place_id, google_rating, google_review_count
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
       on conflict (campaign_id, canonical_key) do update set updated_at = now()
       returning id`,
      [
        campaignId,
        key,
        business.name,
        columns['legal_name'],
        columns['brand_name'],
        columns['registry_id'],
        business.registryId ? business.provider : null,
        business.country ?? 'FR',
        columns['address_line'],
        columns['postal_code'],
        columns['city'],
        columns['department'],
        columns['region'],
        columns['latitude'],
        columns['longitude'],
        columns['domain'],
        columns['website_url'],
        columns['instagram_handle'],
        columns['facebook_url'],
        columns['email'],
        columns['phone'],
        columns['google_place_id'],
        columns['google_rating'],
        columns['google_review_count'],
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('insertProspect returned no row');
    return row.id;
  }

  /** Fills blank columns only; an existing observation is never overwritten. */
  async fillMissingColumns(prospectId: string, columns: Record<string, unknown>): Promise<void> {
    const assignments: string[] = [];
    const params: unknown[] = [prospectId];
    for (const field of FILLABLE_FIELDS) {
      const value = columns[field];
      if (value === null || value === undefined) continue;
      params.push(value);
      // coalesce keeps the first observation; later sources only fill blanks.
      assignments.push(`${field} = coalesce(${field}, $${params.length})`);
    }
    if (assignments.length === 0) return;
    await this.sql.query(
      `update prospects set ${assignments.join(', ')}, updated_at = now() where id = $1`,
      params,
    );
  }

  private async findByIdentityKeys(
    campaignId: string,
    keys: ReturnType<typeof identityKeys>,
  ): Promise<{ prospectId: string; kind: string; value: string }[]> {
    if (keys.length === 0) return [];
    const kinds = keys.map((k) => k.kind);
    const values = keys.map((k) => k.value);
    const rows = await this.sql.query<{ prospect_id: string; kind: string; value: string; weight: string }>(
      `select prospect_id, kind, value, weight
         from prospect_identities
        where campaign_id = $1
          and (kind, value) in (
            select * from unnest($2::text[], $3::text[])
          )
        order by weight desc`,
      [campaignId, kinds, values],
    );
    return rows.map((row) => ({ prospectId: row.prospect_id, kind: row.kind, value: row.value }));
  }

  private async findFuzzyCandidates(campaignId: string, identity: IdentityInput): Promise<FuzzyCandidate[]> {
    const rows = await this.sql.query<{
      id: string;
      display_name: string;
      brand_name: string | null;
      legal_name: string | null;
      city: string | null;
      postal_code: string | null;
      latitude: number | null;
      longitude: number | null;
    }>(
      `select id, display_name, brand_name, legal_name, city, postal_code, latitude, longitude
         from prospects
        where campaign_id = $1
          and dedupe_status <> 'merged'
          and (
            ($2::text is not null and lower(city) = lower($2))
            or ($3::text is not null and postal_code = $3)
            or ($4::float8 is not null and $5::float8 is not null
                and latitude is not null and longitude is not null
                and abs(latitude - $4) < 0.15 and abs(longitude - $5) < 0.20)
          )
        limit 200`,
      [
        campaignId,
        identity.city ?? null,
        identity.postalCode ?? null,
        identity.latitude ?? null,
        identity.longitude ?? null,
      ],
    );
    return rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      brandName: row.brand_name,
      legalName: row.legal_name,
      city: row.city,
      postalCode: row.postal_code,
      latitude: row.latitude,
      longitude: row.longitude,
    }));
  }

  /** One candidate by id, in the shape the fuzzy comparison expects. */
  private async loadFuzzyCandidate(prospectId: string): Promise<FuzzyCandidate | null> {
    const rows = await this.sql.query<{
      id: string;
      display_name: string;
      brand_name: string | null;
      legal_name: string | null;
      city: string | null;
      postal_code: string | null;
      latitude: number | null;
      longitude: number | null;
    }>(
      `select id, display_name, brand_name, legal_name, city, postal_code, latitude, longitude
         from prospects where id = $1`,
      [prospectId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      displayName: row.display_name,
      brandName: row.brand_name,
      legalName: row.legal_name,
      city: row.city,
      postalCode: row.postal_code,
      latitude: row.latitude,
      longitude: row.longitude,
    };
  }

  /**
   * Records that a rail found this business, without ranking the rails.
   *
   * A prospect can legitimately carry several origins — the registry and Google
   * Maps are two sightings of one company. The first one to arrive is kept on
   * the prospect row for ordering and reporting; the full set lives here. The
   * scorer reads neither.
   */
  async recordDiscoveryOrigin(
    campaignId: string,
    prospectId: string,
    origin: { provider: string; rail: DiscoveryRail; externalId?: string | null },
  ): Promise<void> {
    await this.sql.query(
      `insert into prospect_discovery_origins (prospect_id, campaign_id, provider, rail, external_id)
       values ($1,$2,$3,$4,$5)
       on conflict (prospect_id, provider) do nothing`,
      [prospectId, campaignId, origin.provider, origin.rail, origin.externalId ?? null],
    );
    await this.sql.query(
      `update prospects
          set discovery_rail = coalesce(discovery_rail, $2),
              discovery_provider = coalesce(discovery_provider, $3),
              updated_at = now()
        where id = $1`,
      [prospectId, origin.rail, origin.provider],
    );
  }

  /** Persists the R2 measurements. Derived, never asserted by a model. */
  async saveReach(
    prospectId: string,
    reach: {
      contactable: boolean;
      channels: string[];
      funnelObservable: boolean;
      funnelSignalCount: number;
      commercialVisibility: number;
    },
  ): Promise<void> {
    await this.sql.query(
      `update prospects
          set contactable = $2,
              contact_channels = $3::jsonb,
              funnel_observable = $4,
              funnel_signal_count = $5,
              commercial_visibility = $6,
              updated_at = now()
        where id = $1`,
      [
        prospectId,
        reach.contactable,
        JSON.stringify(reach.channels),
        reach.funnelObservable,
        reach.funnelSignalCount,
        reach.commercialVisibility,
      ],
    );
  }

  /**
   * Persiste la projection R5 du parcours commercial.
   *
   * Séparée de `saveReach` volontairement : `saveReach` répond « que pouvons-nous
   * faire de ce prospect » et tourne à chaque enrichissement, y compris pour des
   * prospects dont le site n'a jamais été ouvert. Celle-ci n'est appelée que
   * lorsqu'une synthèse existe réellement, donc un `funnel_summary` nul continue
   * de signifier « non observé » plutôt que « rien à dire ».
   */
  async saveFunnelSynthesis(
    prospectId: string,
    funnel: { summary: string; opportunityCount: number },
  ): Promise<void> {
    await this.sql.query(
      `update prospects
          set funnel_summary = $2,
              funnel_opportunity_count = $3,
              updated_at = now()
        where id = $1`,
      [prospectId, funnel.summary, funnel.opportunityCount],
    );
  }

  /**
   * Écrit l'avis du système sur ce prospect.
   *
   * Un avis, et le mot est à prendre au pied de la lettre : aucune valeur de
   * `recommendation` ne déclenche quoi que ce soit. `send` signifie « un humain
   * peut envoyer ce message tel quel s'il le décide », pas « envoyé ».
   */
  async saveRecommendation(
    prospectId: string,
    recommendation: 'send' | 'edit' | 'reject',
    reason: string,
  ): Promise<void> {
    await this.sql.query(
      `update prospects
          set outreach_recommendation = $2,
              outreach_recommendation_reason = $3,
              updated_at = now()
        where id = $1`,
      [prospectId, recommendation, reason],
    );
  }

  /** Ce que nous savons de l'identité de l'entreprise, métier mis à part. */
  async saveIdentityReview(
    prospectId: string,
    review: 'confirmed' | 'manual_review' | 'uncertain',
  ): Promise<void> {
    await this.sql.query(
      'update prospects set identity_review = $2, updated_at = now() where id = $1',
      [prospectId, review],
    );
  }

  /**
   * Enregistre des clés d'identité pour un prospect existant.
   *
   * Public depuis R3 : quand le rail web ouvert rattache un domaine vérifié à
   * un prospect déjà en base, ce domaine doit devenir une clé de dédup. Sans
   * cela, la source suivante qui rencontrerait la même entreprise par son site
   * créerait un doublon — un domaine rattaché mais non indexé est un domaine
   * que le système ne sait pas reconnaître.
   */
  async recordIdentityKeys(
    campaignId: string,
    prospectId: string,
    keys: ReturnType<typeof identityKeys>,
  ): Promise<void> {
    for (const key of keys) {
      await this.sql.query(
        `insert into prospect_identities (prospect_id, campaign_id, kind, value, weight)
         values ($1,$2,$3,$4,$5)
         on conflict (campaign_id, kind, value, prospect_id) do nothing`,
        [prospectId, campaignId, key.kind, key.value, key.weight],
      );
    }
  }

  /**
   * Met deux prospects en file de revue humaine, sans rien fusionner.
   *
   * Public depuis R3 pour la même raison qu'elle était privée avant : c'est la
   * seule réponse acceptable à une collision. Quand deux prospects distincts
   * résolvent vers le même domaine, l'un des deux est probablement de trop —
   * mais « probablement » ne suffit pas à en supprimer un.
   */
  async recordMergeCandidate(
    campaignId: string,
    leftId: string,
    rightId: string,
    similarity: number,
    signals: Record<string, unknown>,
  ): Promise<void> {
    const [a, b] = [leftId, rightId].sort();
    await this.sql.query(
      `insert into prospect_merge_candidates (campaign_id, left_id, right_id, similarity, signals)
       values ($1,$2,$3,$4,$5)
       on conflict (campaign_id, left_id, right_id) do nothing`,
      [campaignId, a, b, similarity, JSON.stringify(signals)],
    );
    await this.sql.query(
      `update prospects set dedupe_status = 'needs_review', updated_at = now()
        where id = any($1::uuid[]) and dedupe_status = 'unique'`,
      [[a, b]],
    );
  }

  /**
   * Les prospects existants qu'une nouvelle entreprise pourrait être — R5.
   *
   * Public parce que le rail de découverte commerciale doit les soumettre au
   * vérificateur d'identité **avant** d'écrire quoi que ce soit : il a lu le
   * site, il dispose donc de tout ce dont `verifyIdentity` a besoin, et c'est
   * le seul moment où la question « ce domaine appartient-il à ce prospect ? »
   * peut être posée sans coûter un appel réseau de plus.
   *
   * Le filtre géographique est le même que celui du rapprochement flou interne
   * (même ville, même code postal, ou moins de ~15 km) : chercher un homonyme à
   * l'autre bout du pays coûterait une lecture complète de la table pour un cas
   * que `locationContradicts` écarterait ensuite.
   */
  async findVerificationCandidates(
    campaignId: string,
    identity: Pick<IdentityInput, 'city' | 'postalCode' | 'latitude' | 'longitude'>,
  ): Promise<ProspectRow[]> {
    return this.sql.query<ProspectRow>(
      `select * from prospects
        where campaign_id = $1
          and dedupe_status <> 'merged'
          and (
            ($2::text is not null and lower(city) = lower($2))
            or ($3::text is not null and postal_code = $3)
            or ($4::float8 is not null and $5::float8 is not null
                and latitude is not null and longitude is not null
                and abs(latitude - $4) < 0.15 and abs(longitude - $5) < 0.20)
          )
        limit 50`,
      [
        campaignId,
        identity.city ?? null,
        identity.postalCode ?? null,
        identity.latitude ?? null,
        identity.longitude ?? null,
      ],
    );
  }

  /** Le prospect qui porte déjà cette clé d'identité, s'il existe. */
  async findByIdentityKey(campaignId: string, kind: IdentityKind, value: string): Promise<string | null> {
    const rows = await this.sql.query<{ prospect_id: string }>(
      `select p.id as prospect_id
         from prospect_identities i
         join prospects p on p.id = i.prospect_id
        where i.campaign_id = $1 and i.kind = $2 and i.value = $3 and p.dedupe_status <> 'merged'
        limit 1`,
      [campaignId, kind, value],
    );
    return rows[0]?.prospect_id ?? null;
  }

  async recordSource(prospectId: string, business: DiscoveredBusiness): Promise<void> {
    await this.sql.query(
      `insert into prospect_sources (prospect_id, role, provider, external_id, url, payload, collected_at)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (prospect_id, provider, external_id) do update
         set payload = excluded.payload, collected_at = excluded.collected_at`,
      [
        prospectId,
        'discovery',
        business.provider,
        business.externalId,
        business.sourceUrl,
        JSON.stringify(business.raw ?? null),
        business.observedAt,
      ],
    );
  }

  async addEvidence(prospectId: string, evidence: EvidenceInput): Promise<string> {
    const rows = await this.sql.query<{ id: string }>(
      `insert into prospect_evidence
         (prospect_id, field, value_text, value_json, provider, method, source_url, confidence, observed_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9::timestamptz, now()))
       returning id`,
      [
        prospectId,
        evidence.field,
        evidence.valueText ?? null,
        evidence.valueJson === undefined ? null : JSON.stringify(evidence.valueJson),
        evidence.provider,
        evidence.method,
        evidence.sourceUrl ?? null,
        evidence.confidence ?? 1,
        evidence.observedAt ?? null,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('addEvidence returned no row');
    return row.id;
  }

  /** Writes one evidence row per non-null observation carried by a discovery record. */
  private async recordEvidenceFromBusiness(prospectId: string, business: DiscoveredBusiness): Promise<void> {
    const facts: [string, string | null][] = [
      ['display_name', business.name],
      ['legal_name', business.legalName ?? null],
      ['brand_name', business.brandName ?? null],
      ['registry_id', business.registryId ?? null],
      ['registry_code', business.registryCode ?? null],
      ['address_line', business.addressLine ?? null],
      ['city', business.city ?? null],
      ['postal_code', business.postalCode ?? null],
      ['website_url', normalizeUrl(business.websiteUrl ?? null)],
      ['phone', normalizePhone(business.phone ?? null)],
      ['email', normalizeEmail(business.email ?? null)],
      ['instagram_handle', normalizeInstagramHandle(business.instagramHandle ?? null)],
      ['facebook_url', normalizeFacebookUrl(business.facebookUrl ?? null)],
      ['google_rating', business.googleRating != null ? String(business.googleRating) : null],
      ['google_review_count', business.googleReviewCount != null ? String(business.googleReviewCount) : null],
    ];

    // Voir `DiscoveredBusiness.observationMethod` : `api` reste le défaut des
    // sources qui recopient une réponse, `crawl` appartient aux rails qui ont
    // lu la page eux-mêmes.
    const method = business.observationMethod ?? 'api';

    for (const [field, value] of facts) {
      if (!value) continue;
      await this.addEvidence(prospectId, {
        field,
        valueText: value,
        provider: business.provider,
        method,
        sourceUrl: business.sourceUrl,
        confidence: 1,
        observedAt: business.observedAt,
      });
    }

    if (business.attributes && Object.keys(business.attributes).length > 0) {
      await this.addEvidence(prospectId, {
        field: 'provider_attributes',
        valueJson: business.attributes,
        provider: business.provider,
        method,
        sourceUrl: business.sourceUrl,
        confidence: 1,
        observedAt: business.observedAt,
      });
    }
  }

  async listByCampaign(campaignId: string, stages?: string[]): Promise<ProspectRow[]> {
    if (stages && stages.length > 0) {
      return this.sql.query<ProspectRow>(
        `select * from prospects
          where campaign_id = $1 and dedupe_status <> 'merged' and stage = any($2::text[])
          order by score desc nulls last, display_name asc`,
        [campaignId, stages],
      );
    }
    return this.sql.query<ProspectRow>(
      `select * from prospects
        where campaign_id = $1 and dedupe_status <> 'merged'
        order by score desc nulls last, display_name asc`,
      [campaignId],
    );
  }

  async get(prospectId: string): Promise<ProspectRow | null> {
    const rows = await this.sql.query<ProspectRow>('select * from prospects where id = $1', [prospectId]);
    return rows[0] ?? null;
  }

  async setStage(prospectId: string, stage: string): Promise<void> {
    await this.sql.query('update prospects set stage = $2, updated_at = now() where id = $1', [
      prospectId,
      stage,
    ]);
  }

  async evidenceFor(prospectId: string): Promise<
    { id: string; field: string; value_text: string | null; value_json: unknown; provider: string; source_url: string | null; confidence: number; observed_at: string; method: string }[]
  > {
    return this.sql.query(
      `select id, field, value_text, value_json, provider, method, source_url, confidence, observed_at
         from prospect_evidence where prospect_id = $1 order by observed_at asc`,
      [prospectId],
    );
  }
}
