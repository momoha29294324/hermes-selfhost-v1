import type { Sql } from '@/lib/db/sql';
import { loadCommercialIntelligenceProfile } from '@/lib/config/load';
import { loadLatestIcpAssessment } from '@/lib/pipeline/icpAssessment';
import { assessAudienceScaleForProspect } from '@/lib/pipeline/audienceObservation';
import { loadCoreServiceFit } from '@/lib/pipeline/serviceFitObservation';
import type { CoreServiceFitAssessment } from '@/lib/pipeline/coreServiceFit';
import { loadServiceScope } from '@/lib/pipeline/serviceScopeObservation';
import type { ServiceScopeAssessment } from '@/lib/pipeline/serviceScope';
import { assessMarketScope, type MarketScopeAssessment } from '@/lib/pipeline/marketScope';
import { electRepresentative } from '@/lib/pipeline/canonicalBusiness';
import { normalizeDomainKey, normalizeHandleKey } from '@/lib/pipeline/duplicateForensic';
import { loadEffectiveChannelIdentityDecision } from '@/lib/pipeline/channelIdentity';
import {
  contactsOnChannel,
  loadBusinessContactHistory,
} from '@/lib/pipeline/businessContactGuard';
import {
  decideAutonomousOutcome,
  type AutonomousDecision,
  type AutonomousFacts,
} from '@/lib/instagram/autonomousPolicy';

/**
 * HERMES-AUTONOMOUS-R1 — la couche base de la politique autonome.
 *
 * Ce module LIT ; il ne décide pas. La politique vit dans
 * `autonomousPolicy.ts`, pure et éprouvable sans base — la même séparation
 * qu'`icpAssessment` / `icpEligibility` et qu'`audienceObservation` /
 * `scalableOpportunity`, et elle sert la même chose : pouvoir tester la
 * décision sur des états que les données réelles ne produiront pas de sitôt.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi un écran AVANT le manifeste, alors que la file a déjà ses portes
 * ---------------------------------------------------------------------------
 * `evaluateInstagramEligibility` reste la porte finale, inchangée, et c'est
 * elle qui autorise réellement une entrée en file. Mais elle interroge un
 * MANIFESTE, et un manifeste n'existe qu'une fois verrouillé — c'est-à-dire
 * après le point où l'on a écrit une ligne, figé un texte et son empreinte.
 *
 * Tant qu'un humain relisait, cet ordre était sans conséquence : personne ne
 * verrouillait un manifeste sans avoir regardé le prospect. En mode autonome,
 * verrouiller d'abord pour se faire refuser ensuite écrirait des manifestes
 * pour des prospects qu'on n'avait aucune raison de préparer, et laisserait
 * derrière soi des lignes `LOCKED` que personne n'a décidées.
 *
 * L'écran ci-dessous répond donc à « faut-il seulement PRÉPARER un envoi ? »,
 * sur les mêmes faits et avec la même sévérité. Il ne remplace rien : un
 * candidat qu'il laisse passer devra encore franchir les dix portes de la file.
 * Deux passages, jamais deux vérités — le second est le plus strict des deux,
 * et c'est lui qui a le dernier mot.
 */

export interface AutonomousCandidate {
  readonly batchSlug: string;
  readonly itemId: string;
  readonly itemIndex: number;
  readonly prospectId: string;
  readonly displayName: string;
  readonly instagramHandle: string | null;
  readonly followers: number | null;
  readonly attributed: boolean;
  readonly identityReview: 'confirmed' | 'manual_review' | 'uncertain';
  readonly humanVote: 'SEND' | 'EDIT' | 'REJECT' | null;
  /**
   * La lecture complète du cadre, publiée à côté du verdict.
   *
   * Le rapport en a besoin : « SPECIALIST_OUT_OF_SCOPE » seul n'apprend rien à
   * qui conteste le refus, alors que les familles trouvées et leur poids
   * permettent de discuter la RÈGLE plutôt que le prospect. `null` quand la
   * niche du prospect est inconnue.
   */
  readonly serviceFit: CoreServiceFitAssessment | null;
  /**
   * HERMES-CLEANING-ONLY-ICP-R1 — la lecture complète de l'offre, publiée à
   * côté du verdict pour la même raison que `serviceFit` : « MIXED » seul
   * n'apprend rien à qui conteste le refus, alors que les familles trouvées, le
   * champ où elles ont été lues et le vocabulaire ambigu permettent de discuter
   * la RÈGLE plutôt que le prospect. `null` quand la niche est inconnue.
   */
  readonly serviceScope: ServiceScopeAssessment | null;
  /** §17 — les ancres de marché observées, ou l'absence d'ancre, avec sa raison. */
  readonly marketScope: MarketScopeAssessment;
  /** §14 — les autres lignes qui représentent ce même commerce. */
  readonly duplicateBusinessRows: number;
  /** Le texte qui SERAIT envoyé : le vote approuvé s'il existe, sinon le brouillon. */
  readonly outboundText: string;
  /** D'où vient ce texte — un fait de gouvernance, pas un détail d'implémentation. */
  readonly textOrigin: 'human_vote' | 'generated_draft';
  readonly facts: AutonomousFacts;
  readonly decision: AutonomousDecision;
}

interface ItemRow {
  readonly itemId: string;
  readonly itemIndex: number;
  readonly batchSlug: string;
  readonly prospectId: string;
  readonly displayName: string;
  readonly instagramHandle: string | null;
  readonly stage: string;
  readonly identityReview: string | null;
  readonly originalDraft: string | null;
  readonly contactChannels: unknown;
  readonly guardrailFlags: unknown;
  readonly hookEvidenceIds: unknown;
  readonly voteVerdict: string | null;
  readonly voteApprovedText: string | null;
  /** §17 — les trois faits d'ancrage de marché, lus tels quels. */
  readonly registryId: string | null;
  readonly postalCode: string | null;
  readonly domain: string | null;
  readonly websiteUrl: string | null;
}

const ITEM_QUERY = `
  select i.id                as "itemId",
         i.item_index        as "itemIndex",
         b.slug              as "batchSlug",
         p.id                as "prospectId",
         p.display_name      as "displayName",
         p.instagram_handle  as "instagramHandle",
         p.stage             as "stage",
         p.identity_review   as "identityReview",
         i.original_draft    as "originalDraft",
         i.contact_channels  as "contactChannels",
         i.guardrail_flags   as "guardrailFlags",
         i.hook_evidence_ids as "hookEvidenceIds",
         v.verdict           as "voteVerdict",
         v.approved_text     as "voteApprovedText",
         p.registry_id       as "registryId",
         p.postal_code       as "postalCode",
         p.domain            as "domain",
         p.website_url       as "websiteUrl"
    from r6b_batches b
    join r6b_batch_items i on i.batch_id = b.id
    join prospects p       on p.id = i.prospect_id
    left join lateral (
      select verdict, approved_text
        from r6b_batch_votes
       where item_id = i.id
       order by created_at desc
       limit 1
    ) v on true
   where b.slug = $1
   order by i.item_index`;

/**
 * Le MÊME `select`, filtré sur un item plutôt que sur un batch.
 *
 * Écrit comme une substitution du seul `where`, et pas comme une seconde
 * requête : le worker autonome rejoue la politique juste avant l'effet, et il
 * doit la rejouer sur EXACTEMENT les mêmes faits que la passe d'enfilement. Une
 * requête rédigée séparément finirait par oublier une jointure, et la porte
 * qu'on croit fermer serait alors ouverte au dernier moment — le seul endroit
 * où cela coûte un message réel.
 */
const ITEM_BY_ID_QUERY = ITEM_QUERY.replace('where b.slug = $1', 'where i.id = $1');

/** Un tableau JSON venu de la base, compté sans jamais supposer sa forme. */
function countJsonArray(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function asJsonStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function normalizeIdentityReview(raw: string | null): 'confirmed' | 'manual_review' | 'uncertain' {
  // La même défaillance sûre que `resolveIdentityAudit` : ce qui n'est pas
  // reconnu vaut `uncertain`, jamais `confirmed`.
  return raw === 'confirmed' || raw === 'manual_review' ? raw : 'uncertain';
}

function normalizeVote(raw: string | null): 'SEND' | 'EDIT' | 'REJECT' | null {
  return raw === 'SEND' || raw === 'EDIT' || raw === 'REJECT' ? raw : null;
}

/**
 * Évalue tous les items d'un batch sous la politique autonome.
 *
 * Aucune écriture, aucun réseau, aucun navigateur : c'est une lecture. Elle est
 * donc rejouable autant de fois qu'on veut, et elle rend exactement ce que le
 * mode `--apply` agira — pas une approximation de ce qu'il ferait.
 */
export async function evaluateBatchAutonomously(
  sql: Sql,
  batchSlug: string,
): Promise<AutonomousCandidate[]> {
  const rows = await sql.query<ItemRow>(ITEM_QUERY, [batchSlug]);
  const opportunity = loadCommercialIntelligenceProfile().opportunity;
  const candidates: AutonomousCandidate[] = [];
  for (const row of rows) candidates.push(await evaluateRow(sql, row, opportunity, {}));
  return candidates;
}

/**
 * La politique, rejouée sur UN item désigné par son identifiant.
 *
 * C'est la forme dont le worker LIVE a besoin : au moment où il s'apprête à
 * cliquer, il ne connaît pas un batch, il connaît un job — donc un manifeste,
 * donc un item. Rendre `null` signifie « cet item n'existe plus », et le worker
 * doit lire ce `null` comme un refus, jamais comme une absence d'objection.
 */
export async function evaluateItemAutonomously(
  sql: Sql,
  itemId: string,
  options: EvaluateItemOptions = {},
): Promise<AutonomousCandidate | null> {
  const rows = await sql.query<ItemRow>(ITEM_BY_ID_QUERY, [itemId]);
  const row = rows[0];
  if (row === undefined) return null;
  return evaluateRow(sql, row, loadCommercialIntelligenceProfile().opportunity, options);
}

export interface EvaluateItemOptions {
  /**
   * HERMES-AUTONOMOUS-R3 — l'intention QU'ON EST EN TRAIN D'EXÉCUTER, à ne pas
   * compter comme une concurrente d'elle-même.
   *
   * Sans cela, la porte 11 (`concurrent_intent`) refuse tout job autonome dès
   * la seconde où il entre en file : `loadBusinessContactHistory` range les
   * jobs `PENDING`/`CLAIMED` dans `activeIntents`, et le worker qui rejoue la
   * politique juste avant de cliquer y trouve… le sien. La règle « une
   * intention à la fois, par commerce » reste entière ; ce qu'on retire du
   * comptage est l'intention courante, exactement comme
   * `evaluateInstagramEligibility` le fait déjà (`intent.manifestId !==
   * envelope.manifestId`).
   *
   * Absent, rien ne change : la passe d'ENFILEMENT ne le passe pas, et une
   * intention préexistante continue d'y refuser un second manifeste.
   */
  readonly ignoreManifestId?: string;
}

type OpportunityProfile = ReturnType<typeof loadCommercialIntelligenceProfile>['opportunity'];

async function evaluateRow(
  sql: Sql,
  row: ItemRow,
  opportunity: OpportunityProfile,
  options: EvaluateItemOptions,
): Promise<AutonomousCandidate> {
  {
    const icp = await loadLatestIcpAssessment(sql, row.prospectId);
    const audience = await assessAudienceScaleForProspect(sql, row.prospectId, opportunity);
    const serviceFit = await loadCoreServiceFit(sql, row.prospectId);
    const serviceScope = await loadServiceScope(sql, row.prospectId);
    const history = await loadBusinessContactHistory(sql, row.prospectId);
    const handle = row.instagramHandle?.trim() ?? '';

    // §17 — l'ancrage de marché, calculé sur les faits de la fiche.
    // `prospects.country` n'est délibérément PAS transmis : il vaut « FR » pour
    // tout le corpus parce qu'il est écrit en dur à la découverte.
    const marketScope = assessMarketScope({
      registryId: row.registryId,
      postalCode: row.postalCode,
      domain: row.domain,
      websiteUrl: row.websiteUrl,
    });

    // §16 — le handle est-il en réalité le domaine ? Une ÉGALITÉ, pas une
    // forme : `demo_account_05` est un vrai compte, et une règle de forme
    // le refuserait à tort.
    const normalizedHandle = normalizeHandleKey(handle.length === 0 ? null : handle);
    const ownDomain = normalizeDomainKey(row.domain ?? row.websiteUrl ?? null);
    const handleIsOwnDomain =
      normalizedHandle !== null && ownDomain !== null && normalizedHandle === ownDomain;

    // §14-§15 — l'entité métier, résolue EN DIRECT plutôt que lue dans
    // `prospects.business_entity_id`. La colonne est une mémoire, alimentée par
    // une passe ; s'y fier ici ferait qu'une passe non rejouée ouvrirait
    // silencieusement la porte. Une garde ne se fonde pas sur un cache.
    const representative = await electBusinessRepresentative(sql, row.prospectId, history.group.prospectIds);

    // La confirmation humaine de canal, s'il en existe une sur CE destinataire.
    // Lue même en mode autonome : elle ne se DEMANDE plus, mais une décision
    // déjà prise continue de valoir. Ne pas la lire reviendrait à écarter des
    // prospects qu'un humain a déjà tranchés.
    const humanChannelIdentity =
      handle === ''
        ? null
        : await loadEffectiveChannelIdentityDecision(sql, {
            prospectId: row.prospectId,
            transport: 'instagram_dm',
            recipient: handle,
          });

    const vote = normalizeVote(row.voteVerdict);
    // Le texte approuvé par un humain PRIME sur le brouillon : c'est le seul
    // endroit où un vote passé sert encore, et il sert à respecter une
    // reformulation, jamais à autoriser un envoi.
    const approvedText = (row.voteApprovedText ?? '').trim();
    const draft = (row.originalDraft ?? '').trim();
    const outboundText = approvedText.length > 0 ? approvedText : draft;
    const textOrigin = approvedText.length > 0 ? 'human_vote' : 'generated_draft';

    const instagramObserved = asJsonStringArray(row.contactChannels).includes('instagram');
    const contactedOnInstagram = contactsOnChannel(history, 'instagram_dm').length > 0;

    const facts: AutonomousFacts = {
      icpVerdict: icp === null ? null : normalizeIcpVerdict(icp.verdict),
      audienceBand: audience.scale.band,
      audienceOutOfScope: audience.excluded,
      // Le compteur brut et son attribution, transportés tels quels : la marge
      // de confiance R2 se joue sur le nombre, pas sur la bande.
      audienceFollowers: audience.observed?.followersCount ?? null,
      audienceAttributed: audience.observed?.attributed ?? false,
      // `null` (niche inconnue) se lit `UNKNOWN`, jamais `CORE_FIT` : c'est la
      // même défaillance sûre que `normalizeIdentityReview` juste au-dessus.
      coreServiceFit: serviceFit?.verdict ?? 'UNKNOWN',
      // Même défaillance sûre : `null` (niche inconnue) se lit `UNKNOWN`,
      // jamais `IN_SCOPE_ONLY`.
      serviceScope: serviceScope?.verdict ?? 'UNKNOWN',
      marketScope: marketScope.verdict,
      prospectStage: row.stage,
      instagramHandle: handle === '' ? null : handle,
      instagramChannelObserved: instagramObserved,
      instagramHandleIsOwnDomain: handleIsOwnDomain,
      identityReview: normalizeIdentityReview(row.identityReview),
      humanChannelIdentity: humanChannelIdentity?.decision ?? null,
      approvedTextLength: outboundText.length,
      hookEvidenceCount: countJsonArray(row.hookEvidenceIds),
      guardrailFlagCount: countJsonArray(row.guardrailFlags),
      humanVote: vote,
      alreadyContactedOnInstagram: contactedOnInstagram,
      suppressed: history.suppressions.length > 0,
      concurrentIntent: history.activeIntents.some(
        (intent) =>
          options.ignoreManifestId === undefined || intent.manifestId !== options.ignoreManifestId,
      ),
      duplicateBusinessRows: history.group.siblings.length,
      isBusinessRepresentative: representative === null || representative === row.prospectId,
    };

    return {
      batchSlug: row.batchSlug,
      itemId: row.itemId,
      itemIndex: row.itemIndex,
      prospectId: row.prospectId,
      displayName: row.displayName,
      instagramHandle: handle === '' ? null : handle,
      followers: audience.observed?.followersCount ?? null,
      attributed: audience.observed?.attributed ?? false,
      identityReview: facts.identityReview,
      humanVote: vote,
      serviceFit,
      serviceScope,
      marketScope,
      duplicateBusinessRows: history.group.siblings.length,
      outboundText,
      textOrigin,
      facts,
      decision: decideAutonomousOutcome(facts),
    };
  }
}

/**
 * Le représentant de l'entité métier de ce prospect, élu sur des faits lus
 * maintenant.
 *
 * Rend `null` quand la ligne est seule — un commerce sans doublon est son
 * propre représentant, et la politique lit ce `null` comme « rien ne s'y
 * oppose ». Ne rend JAMAIS `null` sur une erreur : la requête ne peut pas
 * échouer silencieusement, elle porte les identifiants qu'on vient de lire.
 */
async function electBusinessRepresentative(
  sql: Sql,
  prospectId: string,
  groupIds: readonly string[],
): Promise<string | null> {
  if (groupIds.length <= 1) return null;
  // Les lignes FUSIONNÉES sont exclues de l'élection, et seulement de
  // l'élection. `resolveBusinessIdentityGroup` a raison de les garder dans le
  // groupe — une fiche fusionnée qui a reçu un message l'a bien reçu, et son
  // historique de contact compte toujours. Mais elle ne représente plus rien :
  // l'élire reviendrait à bloquer la ligne vivante au profit d'une ligne dont
  // le dépôt a déjà décidé qu'elle n'existait plus.
  const rows = await sql.query<{ prospectId: string; stage: string | null; firstSeenAt: string | Date | null }>(
    `select id as "prospectId", stage, first_seen_at as "firstSeenAt"
       from prospects where id = any($1::uuid[]) and dedupe_status <> 'merged'`,
    [[...groupIds]],
  );
  if (rows.length <= 1) return null;
  return electRepresentative(
    rows.map((r) => ({
      prospectId: r.prospectId,
      stage: r.stage,
      firstSeenAt: r.firstSeenAt === null ? null : new Date(r.firstSeenAt).toISOString(),
    })),
  );
}

function normalizeIcpVerdict(raw: string): 'GOOD_ICP' | 'NOT_TARGET' | 'REVIEW_REQUIRED' | null {
  // Ce qui n'est pas reconnu n'est pas `GOOD_ICP` : un verdict inconnu se lit
  // comme un doute, pas comme un feu vert.
  if (raw === 'GOOD_ICP' || raw === 'NOT_TARGET' || raw === 'REVIEW_REQUIRED') return raw;
  return 'REVIEW_REQUIRED';
}
