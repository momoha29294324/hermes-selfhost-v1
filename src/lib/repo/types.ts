export type PipelineStage =
  | 'discovered'
  | 'enriched'
  | 'qualified'
  | 'researched'
  | 'message_ready'
  | 'approved'
  | 'rejected'
  | 'excluded';

export type NicheVerdict = 'in_niche' | 'adjacent' | 'out_of_niche' | 'uncertain';

/**
 * Which discovery strategy found a business. A strategy, never a quality:
 * a long-tail prospect is not a lesser prospect, and no scoring signal reads
 * this field.
 *
 * R3 adds two:
 *   `open_web` — the company's own domain, found by us (candidate generation,
 *                Common Crawl corroboration, SearXNG) and verified end to end;
 *   `social`   — enrichment from a social account whose handle was already
 *                known (Instagram Business Discovery never discovers one).
 */
/**
 * Par quelle stratégie une entreprise est entrée dans le corpus.
 *
 * `search` (R4) désigne un index web payant. Comme les autres, c'est une
 * stratégie et jamais une qualité : rien dans le scoring ne lit cette colonne,
 * et `tests/sourceNeutrality.test.ts` en fait une propriété testée.
 */
/**
 * `commercial_web_discovery` (R5) désigne le renversement de la question : au
 * lieu de partir d'une société du registre pour lui chercher un site, le rail
 * part du métier et de la zone pour trouver des entreprises qui vendent déjà.
 * C'est une stratégie, comme les autres, et rien dans le scoring ne la lit.
 */
export type DiscoveryRail =
  | 'commercial'
  | 'long_tail'
  | 'open_web'
  | 'social'
  | 'search'
  | 'commercial_web_discovery';

export interface ProspectRow {
  id: string;
  campaign_id: string;
  canonical_key: string;
  display_name: string;
  legal_name: string | null;
  brand_name: string | null;
  registry_id: string | null;
  registry_source: string | null;
  country: string;
  address_line: string | null;
  postal_code: string | null;
  city: string | null;
  department: string | null;
  region: string | null;
  latitude: number | null;
  longitude: number | null;
  domain: string | null;
  website_url: string | null;
  instagram_handle: string | null;
  facebook_url: string | null;
  email: string | null;
  phone: string | null;
  /** Google's identifier. The ONLY Places value we are allowed to keep. */
  google_place_id: string | null;
  /**
   * Public review data, when a source we may store it from published it.
   * Never populated from Google Places — that content carries no caching
   * permission..
   */
  google_rating: number | null;
  google_review_count: number | null;

  // --- R2: provenance and reach. None of these is read by the scorer. ---
  discovery_rail: DiscoveryRail | null;
  discovery_provider: string | null;
  /** How observable the business is from outside. NOT how good it is. */
  commercial_visibility: number | null;
  contactable: boolean | null;
  contact_channels: string[];
  funnel_observable: boolean | null;
  funnel_signal_count: number;

  // --- R5. Projections lisibles, dérivées de l'evidence, jamais saisies. ---
  /** Une phrase décrivant le parcours lu. Null = parcours non observé. */
  funnel_summary: string | null;
  /** Nombre de manques de parcours observés. Une mesure d'opportunité, pas un défaut. */
  funnel_opportunity_count: number;
  /** L'avis du système. Un avis — rien ne s'envoie dans ce dépôt. */
  outreach_recommendation: 'send' | 'edit' | 'reject' | null;
  outreach_recommendation_reason: string | null;
  /** Ce que nous savons de l'identité, indépendamment du métier. */
  identity_review: 'confirmed' | 'manual_review' | 'uncertain' | null;

  stage: PipelineStage;
  niche_verdict: NicheVerdict | null;
  niche_confidence: number | null;
  score: number | null;
  score_band: string | null;
  dedupe_status: 'unique' | 'merged' | 'needs_review';
  merged_into_id: string | null;
  first_seen_at: string;
  last_enriched_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EvidenceRow {
  id: string;
  prospect_id: string;
  field: string;
  value_text: string | null;
  value_json: unknown;
  provider: string;
  method: 'api' | 'crawl' | 'derived' | 'llm' | 'manual';
  source_url: string | null;
  confidence: number;
  observed_at: string;
}

export interface EvidenceInput {
  field: string;
  valueText?: string | null;
  valueJson?: unknown;
  provider: string;
  method: EvidenceRow['method'];
  sourceUrl?: string | null;
  confidence?: number;
  observedAt?: string;
}
