/**
 * R6B-D2.1 — l'adapter GoHighLevel / LeadConnector (API v2).
 *
 * Deux couches, comme `gmailProvider.ts` (R6B-D1) et pour la même raison :
 *
 *   * `GhlApi` — le transport. La SEULE surface qui touche le réseau ;
 *   * `GhlCrmProvider` — la stratégie : quelle identité chercher, dans quel
 *     ordre, quand créer et quand mettre à jour. Pure vis-à-vis du réseau, elle
 *     reçoit un `GhlApi` et n'en construit jamais.
 *
 * Les tests injectent un faux `GhlApi` et exercent donc le VRAI code d'identité,
 * d'idempotence et de refus de fusion — pas une maquette de celui-ci.
 *
 * ===========================================================================
 * Ce que cet adapter ne peut pas faire
 * ===========================================================================
 *
 * GoHighLevel expose une API de messagerie complète — `/conversations/messages`
 * envoie un email, un SMS ou un DM en un appel, avec les mêmes identifiants que
 * ceux d'ici. Ce fichier n'en contient AUCUN chemin : pas de constante, pas de
 * méthode, pas de branche. `tests/r6bCrm.test.ts` relit ce fichier et échoue si
 * un jour l'un d'eux y apparaît. CLAUDE.md §1 interdit tout envoi, et « il
 * suffit de ne pas appeler la méthode » n'est pas une garantie — une méthode
 * qui existe finit par être appelée.
 *
 * ===========================================================================
 * Ce qui n'a PAS été vérifié en conditions réelles
 * ===========================================================================
 *
 * Aucun appel de ce fichier n'a été exécuté contre un compte GoHighLevel :
 * aucun sous-compte Hermes n'est confirmé et aucun jeton n'existe sur cette
 * machine (voir le rapport R6B-D2.1). Les chemins, en-têtes et formes de
 * réponse suivent la documentation publique de l'API v2 ; la première exécution
 * réelle sera `npm run r6b:crm:verify`, qui n'écrit rien. Tant qu'elle n'a pas
 * eu lieu, considérer cette intégration comme « écrite, non éprouvée ».
 */

import { env } from '@/lib/env';
import { HttpClient, HttpError, type HttpOptions } from '@/lib/http/client';
import { logger } from '@/lib/logging/logger';
import { normalizeCrmEmail, normalizeCrmPhone, type CrmPayload } from '@/lib/crm/payload';
import {
  CrmPermanentError,
  type CrmIdentityMatch,
  type CrmMappableField,
  type CrmProbe,
  type CrmProvider,
  type CrmStage,
  type CrmUpsertOutcome,
  type CrmUpsertRequest,
} from '@/lib/crm/types';
import type { OutreachState } from '@/lib/replies/taxonomy';

export const GHL_PROVIDER_NAME = 'gohighlevel';

/**
 * Variables de configuration. Aucune n'est renseignée aujourd'hui.
 *
 * `OUTBOUND_CRM_LOCATION_ID` n'autorise rien à elle seule : la projection exige
 * en plus une ligne `r6b_crm_destinations` CONFIRMED portant ce même
 * identifiant. Une variable mal copiée ne peut donc pas écrire dans le
 * sous-compte d'un autre projet — elle ne fait que produire un
 * `BLOCKED_CONFIG`.
 */
export const CRM_ENV_KEYS = Object.freeze({
  provider: 'OUTBOUND_CRM_PROVIDER',
  locationId: 'OUTBOUND_CRM_LOCATION_ID',
  apiKey: 'OUTBOUND_CRM_API_KEY',
});

/** Base et version documentées de l'API v2. */
export const GHL_API_BASE = 'https://services.leadconnectorhq.com';
export const GHL_API_VERSION = '2021-07-28';

export interface GhlCredentials {
  readonly apiKey: string;
}

export type GhlCredentialsResult =
  | { readonly ok: true; readonly credentials: GhlCredentials }
  | { readonly ok: false; readonly missing: readonly string[] };

/**
 * Lit le jeton. Ne rend QUE des noms de variables manquantes — jamais une
 * valeur, jamais un fragment, jamais une longueur (CLAUDE.md §6).
 */
export function readGhlCredentials(): GhlCredentialsResult {
  const apiKey = env(CRM_ENV_KEYS.apiKey);
  if (apiKey === undefined || apiKey.trim().length === 0) {
    return { ok: false, missing: Object.freeze([CRM_ENV_KEYS.apiKey]) };
  }
  return { ok: true, credentials: Object.freeze({ apiKey: apiKey.trim() }) };
}

// ---------------------------------------------------------------------------
// Le transport
// ---------------------------------------------------------------------------

interface GhlLocationResponse {
  location?: { id?: string; name?: string };
}
interface GhlPipelinesResponse {
  pipelines?: { id?: string; name?: string; stages?: { id?: string; name?: string; position?: number }[] }[];
}
interface GhlCustomFieldsResponse {
  customFields?: { id?: string; name?: string; fieldKey?: string }[];
}
interface GhlContactResponse {
  contact?: { id?: string } | null;
}
interface GhlOpportunitySearchResponse {
  opportunities?: { id?: string; pipelineId?: string; pipelineStageId?: string; status?: string }[];
}
interface GhlOpportunityResponse {
  opportunity?: { id?: string };
}
interface GhlNoteResponse {
  note?: { id?: string };
}

export interface GhlContactWrite {
  readonly locationId?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly companyName?: string;
  readonly website?: string;
  readonly city?: string;
  readonly source?: string;
  readonly tags?: readonly string[];
  readonly dnd?: boolean;
  readonly customFields?: readonly { readonly id: string; readonly value: string }[];
}

export interface GhlOpportunityWrite {
  readonly locationId?: string;
  readonly pipelineId: string;
  readonly pipelineStageId: string;
  readonly name: string;
  readonly status: GhlOpportunityStatus;
  readonly contactId?: string;
}

export type GhlOpportunityStatus = 'open' | 'won' | 'lost' | 'abandoned';

/**
 * Le transport. Rien d'autre : aucune décision d'identité, aucune idempotence.
 *
 * Toutes les requêtes passent par `HttpClient` (timeout, retries bornés,
 * espacement par hôte), avec `noCache` partout — un cache sur une lecture de
 * CRM rendrait un identifiant de contact périmé, c'est-à-dire une écriture dans
 * le mauvais dossier.
 */
export class GhlApi {
  private readonly http: HttpClient;
  private readonly apiKey: string;
  private readonly base: string;

  constructor(credentials: GhlCredentials, deps: { readonly http?: HttpClient; readonly base?: string } = {}) {
    // `sql: null` : pas de cache HTTP du tout, dans les deux sens.
    this.http = deps.http ?? new HttpClient({ sql: null, minHostIntervalMs: 250 });
    this.apiKey = credentials.apiKey;
    this.base = deps.base ?? GHL_API_BASE;
  }

  // -- lectures -------------------------------------------------------------

  async getLocation(locationId: string): Promise<{ id: string; name: string | null }> {
    const res = await this.json<GhlLocationResponse>('GET', `/locations/${encodeURIComponent(locationId)}`);
    const id = res.location?.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new CrmPermanentError(`sous-compte ${locationId} : réponse sans identifiant de location`);
    }
    return { id, name: typeof res.location?.name === 'string' ? res.location.name : null };
  }

  async listPipelines(
    locationId: string,
  ): Promise<{ pipelineId: string; pipelineName: string; stages: CrmStage[] }[]> {
    const res = await this.json<GhlPipelinesResponse>(
      'GET',
      `/opportunities/pipelines?locationId=${encodeURIComponent(locationId)}`,
    );
    return (res.pipelines ?? [])
      .filter((pipeline): pipeline is { id: string; name: string; stages?: NonNullable<GhlPipelinesResponse['pipelines']>[number]['stages'] } =>
        typeof pipeline.id === 'string' && typeof pipeline.name === 'string')
      .map((pipeline) => ({
        pipelineId: pipeline.id,
        pipelineName: pipeline.name,
        stages: (pipeline.stages ?? [])
          .filter((stage): stage is { id: string; name: string; position?: number } =>
            typeof stage.id === 'string' && typeof stage.name === 'string')
          .map((stage) => ({
            stageId: stage.id,
            stageName: stage.name,
            position: typeof stage.position === 'number' ? stage.position : null,
          })),
      }));
  }

  async listCustomFields(locationId: string): Promise<{ id: string; key: string; name: string }[]> {
    const res = await this.json<GhlCustomFieldsResponse>(
      'GET',
      `/locations/${encodeURIComponent(locationId)}/customFields`,
    );
    return (res.customFields ?? [])
      .filter((field): field is { id: string; name: string; fieldKey?: string } =>
        typeof field.id === 'string' && typeof field.name === 'string')
      .map((field) => ({
        id: field.id,
        key: typeof field.fieldKey === 'string' ? field.fieldKey : field.id,
        name: field.name,
      }));
  }

  /**
   * Recherche de doublon par identifiant fort.
   *
   * `email` et `number` sont les deux seuls critères employés, et jamais un
   * nom : c'est cette contrainte-là qui empêche deux entreprises homonymes de
   * se retrouver dans le même dossier.
   */
  async findDuplicate(
    locationId: string,
    by: { readonly email?: string; readonly phone?: string },
  ): Promise<string | null> {
    const params = new URLSearchParams({ locationId });
    if (by.email !== undefined) params.set('email', by.email);
    else if (by.phone !== undefined) params.set('number', by.phone);
    else return null;

    const res = await this.json<GhlContactResponse>(
      'GET',
      `/contacts/search/duplicate?${params.toString()}`,
      undefined,
      { allowNotFound: true },
    );
    const id = res.contact?.id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  }

  /**
   * Les opportunités déjà ouvertes pour ce contact.
   *
   * Cet endpoint attend ses paramètres en `snake_case` là où le reste de l'API
   * v2 est en `camelCase` — incohérence documentée du fournisseur, reproduite
   * ici telle quelle plutôt que « corrigée ».
   */
  async searchOpportunities(
    locationId: string,
    contactId: string,
  ): Promise<{ id: string; pipelineId: string | null; pipelineStageId: string | null }[]> {
    const params = new URLSearchParams({ location_id: locationId, contact_id: contactId });
    const res = await this.json<GhlOpportunitySearchResponse>(
      'GET',
      `/opportunities/search?${params.toString()}`,
      undefined,
      { allowNotFound: true },
    );
    return (res.opportunities ?? [])
      .filter((opportunity): opportunity is { id: string } & typeof opportunity => typeof opportunity.id === 'string')
      .map((opportunity) => ({
        id: opportunity.id,
        pipelineId: typeof opportunity.pipelineId === 'string' ? opportunity.pipelineId : null,
        pipelineStageId: typeof opportunity.pipelineStageId === 'string' ? opportunity.pipelineStageId : null,
      }));
  }

  // -- écritures ------------------------------------------------------------

  async createContact(body: GhlContactWrite): Promise<string> {
    const res = await this.json<GhlContactResponse>('POST', '/contacts/', body);
    const id = res.contact?.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new CrmPermanentError('création de contact : réponse sans identifiant');
    }
    return id;
  }

  async updateContact(contactId: string, body: GhlContactWrite): Promise<void> {
    await this.json<GhlContactResponse>('PUT', `/contacts/${encodeURIComponent(contactId)}`, body);
  }

  async createOpportunity(body: GhlOpportunityWrite): Promise<string> {
    const res = await this.json<GhlOpportunityResponse>('POST', '/opportunities/', body);
    const id = res.opportunity?.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new CrmPermanentError('création d’opportunité : réponse sans identifiant');
    }
    return id;
  }

  async updateOpportunity(opportunityId: string, body: GhlOpportunityWrite): Promise<void> {
    await this.json<GhlOpportunityResponse>('PUT', `/opportunities/${encodeURIComponent(opportunityId)}`, body);
  }

  async createNote(contactId: string, body: string): Promise<string | null> {
    const res = await this.json<GhlNoteResponse>(
      'POST',
      `/contacts/${encodeURIComponent(contactId)}/notes`,
      { body },
    );
    const id = res.note?.id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  }

  // -- plomberie ------------------------------------------------------------

  /**
   * Un appel, et la classification de son échec.
   *
   * La distinction retentable / définitif se prend ICI, au plus près du code de
   * statut, et pas plus haut où il faudrait la deviner d'un message : 401, 403,
   * 404, 400 et 422 ne changeront pas si on rejoue, 429 et 5xx si.
   */
  private async json<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    options: { readonly allowNotFound?: boolean } = {},
  ): Promise<T> {
    const url = `${this.base}${path}`;
    const httpOptions: HttpOptions = {
      method,
      noCache: true,
      attempts: 3,
      timeoutMs: 15_000,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        version: GHL_API_VERSION,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };

    let response;
    try {
      response = await this.http.request(url, httpOptions);
    } catch (error) {
      // `HttpClient` ne lève que sur 429/5xx (après ses propres retries) ou sur
      // un incident réseau : tous retentables.
      const detail = error instanceof HttpError ? `HTTP ${error.status ?? '?'}` : String(error);
      throw new Error(`${method} ${path} — ${detail}`);
    }

    if (response.status === 404 && options.allowNotFound === true) return {} as T;

    if (!response.ok) {
      const message = `${method} ${path} — HTTP ${response.status}`;
      if ([400, 401, 403, 404, 405, 409, 422].includes(response.status)) {
        logger.warn('crm.ghl.permanent_error', { path, status: response.status });
        throw new CrmPermanentError(`${message} (refus définitif du fournisseur)`);
      }
      throw new Error(message);
    }

    if (response.body.trim().length === 0) return {} as T;
    try {
      return JSON.parse(response.body) as T;
    } catch {
      throw new CrmPermanentError(`${method} ${path} — réponse illisible (JSON invalide)`);
    }
  }
}

// ---------------------------------------------------------------------------
// La stratégie
// ---------------------------------------------------------------------------

/**
 * L'étiquette unique posée sur nos contacts.
 *
 * UNE seule, stable. Une étiquette par catégorie de réponse s'accumulerait :
 * un prospect « intéressé » en mars et « pas intéressé » en juin porterait les
 * deux, et le CRM affirmerait deux choses contradictoires à la fois. La
 * catégorie courante vit dans l'étape du pipeline et dans le champ
 * personnalisé, qui, eux, se remplacent.
 */
export const GHL_TAG = 'hermes';

/**
 * Statut d'opportunité par état commercial.
 *
 *   * `open` tant qu'une conversation est vivante — y compris `NOT_NOW`, qui
 *     est un report et non un refus ;
 *   * `lost` pour un refus commercial explicite ;
 *   * `abandoned` pour ce qui n'est PAS un refus : une adresse qui ne délivre
 *     pas, une demande d'arrêt des sollicitations. Les compter comme « perdus »
 *     salirait le taux de perte commerciale avec des faits techniques ou
 *     juridiques.
 */
export const GHL_OPPORTUNITY_STATUS: Readonly<Record<OutreachState, GhlOpportunityStatus | null>> =
  Object.freeze({
    CONTACTED: 'open',
    REPLIED: 'open',
    INTERESTED: 'open',
    NOT_NOW: 'open',
    NOT_INTERESTED: 'lost',
    BOUNCED: 'abandoned',
    SUPPRESSED: 'abandoned',
    // §6 : une conclusion non tranchée ne déplace rien chez un tiers.
    REVIEW_REQUIRED: null,
  });

/** La valeur textuelle d'un champ projetable, ou `null` si rien n'est observé. */
function fieldValue(payload: CrmPayload, field: CrmMappableField): string | null {
  switch (field) {
    case 'prospectId':
      return payload.prospectId;
    case 'manifestId':
      return payload.manifestId;
    case 'prospectScore':
      return payload.prospectScore === null ? null : String(payload.prospectScore);
    case 'prospectScoreBand':
      return payload.prospectScoreBand;
    case 'researchSummary':
      return payload.researchSummary;
    case 'replyClassification':
      return payload.replyClassification;
    case 'replyReceivedAt':
      return payload.replyReceivedAt;
    case 'instagram':
      return payload.instagram;
  }
}

export class GhlCrmProvider implements CrmProvider {
  readonly name = GHL_PROVIDER_NAME;

  constructor(private readonly api: GhlApi) {}

  availability(): { ok: boolean; reason?: string } {
    return { ok: true };
  }

  /** L'opération de lecture la plus étroite d'abord : le sous-compte lui-même. */
  async probe(locationId: string): Promise<CrmProbe> {
    const location = await this.api.getLocation(locationId);
    const pipelines = await this.api.listPipelines(locationId);

    // Les champs personnalisés sont un CONFORT (ils évitent que des faits
    // vérifiés ne vivent que dans une note). Leur endpoint exige une portée
    // supplémentaire : ne pas l'avoir doit dégrader la richesse de la
    // projection, jamais empêcher de vérifier la destination.
    let customFields: { id: string; key: string; name: string }[] = [];
    try {
      customFields = await this.api.listCustomFields(locationId);
    } catch (error) {
      logger.warn('crm.ghl.custom_fields_unavailable', {
        locationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return Object.freeze({
      locationId: location.id,
      locationName: location.name,
      pipelines: Object.freeze(pipelines.map((pipeline) => Object.freeze({ ...pipeline }))),
      customFields: Object.freeze(customFields.map((field) => Object.freeze({ ...field }))),
    });
  }

  /**
   * Cherche un contact par identité forte. N'écrit rien.
   *
   * Email d'abord, téléphone ensuite, et RIEN d'autre : un nom d'entreprise,
   * une ville ou un domaine de site ne sont pas des identités — « Demo Papa »
   * existe partout, et deux dossiers fusionnés ne se séparent plus.
   */
  async lookup(
    locationId: string,
    by: { readonly email: string | null; readonly phone: string | null },
  ): Promise<CrmIdentityMatch | null> {
    if (by.email !== null) {
      const found = await this.api.findDuplicate(locationId, { email: by.email });
      if (found !== null) {
        return Object.freeze({ externalContactId: found, matchKind: 'email' as const, matchValue: by.email });
      }
    }
    if (by.phone !== null) {
      const found = await this.api.findDuplicate(locationId, { phone: by.phone });
      if (found !== null) {
        return Object.freeze({ externalContactId: found, matchKind: 'phone' as const, matchValue: by.phone });
      }
    }
    return null;
  }

  /**
   * Projette un prospect : contact → opportunité → note.
   *
   * L'identité est déjà tranchée (`request.contact`) : cet adapter ne cherche
   * plus, il applique. L'ordre compte — le contact d'abord parce que tout le
   * reste s'y accroche, la note en dernier parce qu'elle est la seule étape
   * dont l'échec ne remet rien en cause.
   */
  async upsert(request: CrmUpsertRequest): Promise<CrmUpsertOutcome> {
    const { payload, target, stage } = request;
    const locationId = target.destination.locationId;

    const email = normalizeCrmEmail(payload.email);
    const phone = normalizeCrmPhone(payload.phone);
    if (email === null && phone === null) {
      throw new CrmPermanentError(
        `prospect ${payload.prospectId} : ni email ni téléphone observés — aucune identité forte à projeter`,
      );
    }

    const contactBody = this.contactBody(request, email, phone);
    let contactId: string;
    let contactCreated = false;
    if (request.contact === null) {
      contactId = await this.api.createContact({ locationId, ...contactBody });
      contactCreated = true;
    } else {
      contactId = request.contact.externalContactId;
      // L'identifiant de sous-compte n'est PAS renvoyé sur une mise à jour :
      // l'API v2 le refuse sur `PUT /contacts/{id}`, et le contact ne change
      // de toute façon jamais de sous-compte.
      await this.api.updateContact(contactId, contactBody);
    }

    const opportunity = await this.upsertOpportunity(request, contactId, locationId, stage);

    let externalNoteId: string | null = null;
    let noteCreated = false;
    if (request.note !== null) {
      externalNoteId = await this.api.createNote(contactId, request.note.body);
      noteCreated = true;
    }

    return Object.freeze({
      externalContactId: contactId,
      externalOpportunityId: opportunity.id,
      externalStage: stage?.stageId ?? null,
      matchKind: request.contact?.matchKind ?? 'created',
      matchValue: request.contact?.matchValue ?? null,
      contactCreated,
      opportunityCreated: opportunity.created,
      externalNoteId,
      noteCreated,
    });
  }

  private contactBody(
    request: CrmUpsertRequest,
    email: string | null,
    phone: string | null,
  ): GhlContactWrite {
    const { payload, target } = request;
    const customFields: { id: string; value: string }[] = [];
    for (const [field, binding] of Object.entries(target.destination.fieldMap)) {
      const value = fieldValue(payload, field as CrmMappableField);
      if (value !== null && value.length > 0) customFields.push({ id: binding.id, value });
    }

    return {
      ...(email === null ? {} : { email }),
      ...(phone === null ? {} : { phone }),
      companyName: payload.company,
      ...(payload.website === null ? {} : { website: payload.website }),
      ...(payload.city === null ? {} : { city: payload.city }),
      source: payload.source,
      tags: [GHL_TAG],
      // `dnd` n'est jamais remis à `false` par ce code : une suppression posée
      // ne se retire pas automatiquement, et un prospect marqué « ne pas
      // contacter » chez le fournisseur pour une autre raison que la nôtre ne
      // doit pas être « débloqué » par une projection Hermes.
      ...(request.doNotContact ? { dnd: true } : {}),
      ...(customFields.length === 0 ? {} : { customFields }),
    };
  }

  /**
   * Une opportunité, une seule, par prospect et par destination.
   *
   * Trois sources d'identité, dans l'ordre : celle déjà persistée localement,
   * puis celle que le fournisseur rattache déjà à ce contact sur CE pipeline,
   * puis la création. Le deuxième niveau est ce qui évite un doublon quand une
   * opportunité a été créée à la main dans l'interface.
   */
  private async upsertOpportunity(
    request: CrmUpsertRequest,
    contactId: string,
    locationId: string,
    stage: CrmStage | null,
  ): Promise<{ id: string | null; created: boolean }> {
    const status = GHL_OPPORTUNITY_STATUS[request.payload.outreachState];
    if (stage === null || status === null) return { id: null, created: false };

    const pipelineId = request.target.pipelineId;
    const body: GhlOpportunityWrite = {
      pipelineId,
      pipelineStageId: stage.stageId,
      name: `${request.payload.company} — Hermes`,
      status,
    };

    const known = request.contact?.externalOpportunityId ?? null;
    if (known !== null) {
      await this.api.updateOpportunity(known, body);
      return { id: known, created: false };
    }

    const existing = await this.api.searchOpportunities(locationId, contactId);
    const onPipeline = existing.find((opportunity) => opportunity.pipelineId === pipelineId);
    if (onPipeline !== undefined) {
      await this.api.updateOpportunity(onPipeline.id, body);
      return { id: onPipeline.id, created: false };
    }

    const created = await this.api.createOpportunity({ locationId, contactId, ...body });
    return { id: created, created: true };
  }
}
