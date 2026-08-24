import type { ChannelKey, ChannelSelection } from '@/lib/pipeline/channelFit';
import type { CommercialDecision, CommercialIntelligenceResult } from '@/lib/pipeline/commercialIntelligence';
import type { IcpLockRefusal } from '@/lib/pipeline/icpEligibility';
import type { CommercialIntelligenceProfile } from '@/lib/config/schema';

/**
 * R7.3B §3 — deux questions que R7 posait en une seule.
 *
 * ---------------------------------------------------------------------------
 * Le cas qui l'a rendu nécessaire
 * ---------------------------------------------------------------------------
 * `ESTHETIC CAR ATELIER` sort de R7 à **83 de priorité commerciale, sans
 * aucun canal retenu** : ni email, ni compte Instagram, ni rien qu'un rail sache
 * emprunter. R7.3 l'a compté comme un « faux-haut », c'est-à-dire comme une
 * erreur de jugement commercial — et c'en était une lecture fausse. Le jugement
 * commercial était bon ; c'est l'EXÉCUTION qui était impossible.
 *
 * Faire baisser sa priorité pour cette raison aurait détruit l'information la
 * plus utile qu'on ait sur lui : *si nous savions comment le joindre, il serait
 * en tête de liste*. Un prospect injoignable et intéressant n'est pas un mauvais
 * prospect, c'est une CIBLE DE COLLECTE — et c'est une file de travail
 * différente, pas une poubelle.
 *
 * ---------------------------------------------------------------------------
 * Deux axes, et ce que chacun refuse de dire
 * ---------------------------------------------------------------------------
 *   COMMERCIAL PRIORITY    « si nous pouvions le joindre proprement, serait-il
 *                            intéressant ? »  → `commercialIntelligence.ts`,
 *                            inchangé par ce module, qui n'y écrit rien et ne
 *                            reçoit même pas de quoi la modifier.
 *   OUTBOUND ACTIONABILITY « peut-on réellement et proprement faire un
 *                            premier contact MAINTENANT ? »  → ici.
 *
 * Le second n'est pas une mesure de qualité, et le confondre avec la première
 * est précisément l'erreur corrigée. Il rend un verdict d'exécution, avec la
 * raison exacte du refus quand il refuse.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi l'actionabilité inclut quand même la décision commerciale
 * ---------------------------------------------------------------------------
 * Parce que la question porte sur un ACTE. « Pouvons-nous proprement écrire à
 * ce prospect maintenant » n'a pas la même réponse que « saurions-nous
 * techniquement lui écrire » : on ne fait pas un premier contact commercial
 * qu'on a décidé de ne pas faire. L'actionabilité est donc une PILE DE PORTES,
 * et son intérêt tient entièrement à ce qu'elle NOMME celle qui a bloqué :
 *
 *   BLOCKED_NOT_PRIORITIZED         « nous saurions, nous ne voulons pas »
 *   BLOCKED_NO_SELECTABLE_CHANNEL   « nous voulons, nous ne savons pas »
 *
 * Ces deux phrases étaient jusqu'ici le même `recommended_channel = null`, et
 * les compter ensemble rendait la mesure inutilisable : la première ne demande
 * rien, la seconde demande une collecte.
 *
 * Tout est déterministe et pur — aucune horloge, aucun réseau, aucune écriture.
 */

/**
 * Le vocabulaire fermé de l'exécution.
 *
 * `BLOCKED_NOT_PRIORITIZED` est un ajout au vocabulaire proposé par la mission,
 * et il mérite sa justification : sans lui, la décision commerciale négative
 * devrait se ranger sous `BLOCKED_POLICY`, où elle se mélangerait à « ce type
 * d'entreprise n'est pas notre client ». Or les deux ne se réparent pas de la
 * même façon — l'une par une collecte qui révèle un besoin, l'autre jamais.
 * Une taxonomie qui les confond fait mentir le compteur d'enrichissement.
 */
export type OutboundActionability =
  | 'ACTIONABLE'
  | 'BLOCKED_SUPPRESSION'
  | 'BLOCKED_POLICY'
  | 'BLOCKED_INSUFFICIENT_EVIDENCE'
  | 'BLOCKED_NOT_PRIORITIZED'
  | 'BLOCKED_IDENTITY'
  | 'BLOCKED_NO_SELECTABLE_CHANNEL';

export const OUTBOUND_ACTIONABILITY_VALUES: readonly OutboundActionability[] = Object.freeze([
  'ACTIONABLE',
  'BLOCKED_SUPPRESSION',
  'BLOCKED_POLICY',
  'BLOCKED_INSUFFICIENT_EVIDENCE',
  'BLOCKED_NOT_PRIORITIZED',
  'BLOCKED_IDENTITY',
  'BLOCKED_NO_SELECTABLE_CHANNEL',
]);

/**
 * Ce que vaudrait une collecte sur ce prospect.
 *
 * `NONE` n'est pas « faible » : c'est « aucune donnée supplémentaire ne changera
 * la réponse ». Un prospect supprimé ou hors cible reste hors cible même
 * parfaitement documenté.
 */
export type EnrichmentPriority = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

export const ENRICHMENT_PRIORITY_VALUES: readonly EnrichmentPriority[] = Object.freeze([
  'HIGH',
  'MEDIUM',
  'LOW',
  'NONE',
]);

/** Une entrée de `do_not_contact` qui vise ce prospect. */
export interface OutboundSuppression {
  readonly matchKind: string;
  readonly value: string;
  readonly reason: string;
}

/**
 * Ce que l'on sait de « écririons-nous bien à la bonne entité ».
 *
 * Deux affirmations distinctes, et le module ne les fusionne pas :
 *   - `instagramCorroborated` : ce handle appartient-il à cette entreprise ?
 *     `null` = la question n'a pas pu être tranchée, ce qui n'est pas « oui ».
 *   - `icpLockRefusal` : le gate ICP interdirait-il de verrouiller un manifeste
 *     pour ce prospect ? C'est la porte réelle du rail R6B, réutilisée ici
 *     plutôt que réinventée.
 */
export interface OutboundIdentityState {
  readonly instagramCorroborated: boolean | null;
  readonly icpLockRefusal: IcpLockRefusal | null;
}

export interface OutboundActionabilityInput {
  readonly intelligence: Pick<CommercialIntelligenceResult, 'decision' | 'commercialPriority' | 'icpVerdict'>;
  readonly selection: ChannelSelection;
  readonly identity: OutboundIdentityState;
  /** `null` quand aucune entrée de suppression ne vise ce prospect. */
  readonly suppression: OutboundSuppression | null;
  readonly profile: CommercialIntelligenceProfile;
}

export interface OutboundActionabilityResult {
  readonly actionability: OutboundActionability;
  /** Raccourci lisible. `false` pour tous les `BLOCKED_*`, sans exception. */
  readonly actionable: boolean;
  /** La porte qui a bloqué, en français, avec de quoi la contester. */
  readonly reason: string;
  /** Le canal du premier contact. `null` dès que le verdict n'est pas `ACTIONABLE`. */
  readonly channel: ChannelKey | null;
  /** Les canaux techniquement utilisables, décision commerciale mise de côté. */
  readonly reachableChannels: readonly ChannelKey[];
  /** Une collecte peut-elle lever ce blocage ? */
  readonly unblockableByCollection: boolean;
  readonly enrichmentPriority: EnrichmentPriority;
  /** Ce qu'il faudrait aller chercher. Vide quand rien ne débloquerait. */
  readonly enrichmentTargets: readonly string[];
}

/** Les décisions commerciales sous lesquelles un premier contact se conçoit. */
const POSITIVE_DECISIONS: ReadonlySet<CommercialDecision> = new Set<CommercialDecision>(['PRIORITIZE', 'CONSIDER']);

/**
 * Les blocages qu'une collecte peut lever.
 *
 * `BLOCKED_NOT_PRIORITIZED` y figure, et c'est délibéré : un prospect
 * déprioritisé l'est faute de manque observé, et lire trois pages de plus peut
 * révéler ce manque. `BLOCKED_SUPPRESSION` et `BLOCKED_POLICY` n'y figurent
 * pas : quelqu'un a demandé à ne plus être contacté, ou ce type d'entreprise
 * n'est pas notre client. Aucune donnée ne change ces deux réponses.
 */
const UNBLOCKABLE_BY_COLLECTION: ReadonlySet<OutboundActionability> = new Set<OutboundActionability>([
  'BLOCKED_INSUFFICIENT_EVIDENCE',
  'BLOCKED_NOT_PRIORITIZED',
  'BLOCKED_IDENTITY',
  'BLOCKED_NO_SELECTABLE_CHANNEL',
]);

/**
 * Ce qu'une collecte irait chercher pour lever le blocage.
 *
 * Construit depuis les EXCLUSIONS publiées par la sélection de canal plutôt que
 * depuis une liste écrite à la main : ainsi la liste de courses ne peut pas
 * réclamer un identifiant déjà observé, ni oublier un canal qu'une future
 * politique rendrait sélectionnable.
 */
function collectionTargets(input: OutboundActionabilityInput, actionability: OutboundActionability): string[] {
  if (actionability === 'BLOCKED_INSUFFICIENT_EVIDENCE') {
    // Le besoin n'a pas pu être observé : c'est le site qu'il faut lire, et
    // aucune autre collecte ne remplace celle-là.
    return ['website_read'];
  }
  if (actionability === 'BLOCKED_IDENTITY') {
    return input.identity.icpLockRefusal === null
      ? ['instagram_identity_corroboration']
      : ['business_type_evidence', 'instagram_identity_corroboration'];
  }
  if (actionability !== 'BLOCKED_NO_SELECTABLE_CHANNEL' && actionability !== 'BLOCKED_NOT_PRIORITIZED') return [];

  const targets: string[] = [];
  for (const exclusion of input.selection.excluded) {
    if (exclusion.reason === 'not_available') targets.push(`${exclusion.channel}_identifier`);
    else if (exclusion.reason === 'below_minimum_fit') targets.push(`${exclusion.channel}_fit_evidence`);
  }
  return [...new Set(targets)].sort();
}

/**
 * Ce que vaudrait la collecte, en une échelle de quatre crans.
 *
 * La règle tient en une phrase : **la valeur d'une collecte est la priorité
 * commerciale du prospect qu'elle débloquerait.** D'où les deux extrémités :
 *
 *   - une priorité inconnue ne peut pas donner `HIGH`. `INSUFFICIENT_EVIDENCE`
 *     couvre 232 prospects sur 286, et les déclarer tous « cibles prioritaires »
 *     serait affirmer une valeur que personne n'a mesurée — le fait inventé de
 *     la règle 2, sous forme de compteur. Ils valent `MEDIUM` : une demande de
 *     collecte réelle, dont le rendement reste inconnu ;
 *   - un blocage qu'aucune collecte ne lève vaut `NONE`, jamais `LOW`. Ce n'est
 *     pas une petite valeur, c'est l'absence de sujet.
 */
function enrichmentPriorityOf(
  actionability: OutboundActionability,
  priority: number | null,
  bands: CommercialIntelligenceProfile['priority']['bands'],
): EnrichmentPriority {
  if (!UNBLOCKABLE_BY_COLLECTION.has(actionability)) return 'NONE';
  if (priority === null) return 'MEDIUM';
  if (priority >= bands.prioritize) return 'HIGH';
  if (priority >= bands.consider) return 'MEDIUM';
  return 'LOW';
}

/**
 * L'ordre des portes EST le contrat, et il va du définitif vers le réparable.
 *
 *   1. SUPPRESSION — quelqu'un a demandé qu'on ne lui écrive plus. Rien ne
 *      passe avant, et surtout pas un score ;
 *   2. POLICY — le verdict ICP dit que ce TYPE d'entreprise n'est pas notre
 *      client. Aucun besoin, aussi criant soit-il, ne rend une tête de réseau
 *      contactable (R7.1, marche 1 de la priorité) ;
 *   3. INSUFFICIENT_EVIDENCE — le besoin n'a pas été observé. Ce n'est pas un
 *      refus, c'est une abstention, et les rapports la comptent comme telle ;
 *   4. NOT_PRIORITIZED — nous saurions écrire, nous avons décidé de ne pas le
 *      faire. AVANT la porte de canal, et l'ordre importe : `selectChannel` rend
 *      déjà `null` pour cette raison, donc juger le canal d'abord ferait dire
 *      « aucun canal » à des prospects parfaitement joignables. C'est ce qui
 *      garantit que `BLOCKED_NO_SELECTABLE_CHANNEL` signifie exactement une
 *      chose : « nous voulions y aller, et nous ne savons pas comment » ;
 *   5. IDENTITY — nous ne savons pas si nous écririons à la bonne entité.
 *      Fermé par défaut : `null` ne vaut pas « oui » (IG4.2, R7.2B.1) ;
 *   6. NO_SELECTABLE_CHANNEL — la règle structurelle validée par le §4 :
 *      aucun canal retenu ⇒ jamais `ACTIONABLE` ;
 *   7. ACTIONABLE.
 */
export function assessOutboundActionability(input: OutboundActionabilityInput): OutboundActionabilityResult {
  const { intelligence, selection, identity, suppression, profile } = input;
  const reachableChannels = selection.eligible;

  const verdict = (actionability: OutboundActionability, reason: string): OutboundActionabilityResult => {
    const actionable = actionability === 'ACTIONABLE';
    return {
      actionability,
      actionable,
      reason,
      channel: actionable ? selection.selected : null,
      reachableChannels,
      unblockableByCollection: UNBLOCKABLE_BY_COLLECTION.has(actionability),
      enrichmentPriority: enrichmentPriorityOf(actionability, intelligence.commercialPriority, profile.priority.bands),
      enrichmentTargets: collectionTargets(input, actionability),
    };
  };

  if (suppression !== null) {
    return verdict(
      'BLOCKED_SUPPRESSION',
      `« ${suppression.value} » figure dans do_not_contact (${suppression.matchKind} — ${suppression.reason})`,
    );
  }

  if (intelligence.icpVerdict === 'NOT_TARGET') {
    return verdict('BLOCKED_POLICY', 'verdict ICP NOT_TARGET — ce type d’entreprise n’est pas un client Hermes');
  }

  if (intelligence.decision === 'INSUFFICIENT_EVIDENCE') {
    return verdict(
      'BLOCKED_INSUFFICIENT_EVIDENCE',
      'aucun manque commercial observé — le site n’a pas été lu. Abstention, pas refus.',
    );
  }

  if (!POSITIVE_DECISIONS.has(intelligence.decision)) {
    return verdict(
      'BLOCKED_NOT_PRIORITIZED',
      `décision commerciale « ${intelligence.decision} » (priorité ${intelligence.commercialPriority ?? '—'})` +
        (selection.bestEligible === null
          ? ''
          : ` — ${selection.bestEligible} serait pourtant joignable, c'est le jugement qui refuse, pas l'exécution`),
    );
  }

  if (identity.icpLockRefusal === 'icp_review_required') {
    return verdict(
      'BLOCKED_IDENTITY',
      'le gate ICP porte un signal fort isolé : de quel TYPE d’entreprise il s’agit reste à trancher par un humain',
    );
  }

  /**
   * Le canal Instagram exige une corroboration d'identité, et l'exige au sens
   * strict : `true`, pas « pas faux ». Écrire en DM à un compte dont rien ne
   * prouve qu'il appartient au prospect est la seule erreur de ce pipeline qui
   * atteigne un inconnu, et R7.2 la traite déjà ainsi partout ailleurs.
   */
  if (selection.bestEligible === 'instagram' && identity.instagramCorroborated !== true) {
    return verdict(
      'BLOCKED_IDENTITY',
      identity.instagramCorroborated === false
        ? 'le compte Instagram retenu n’est pas corroboré par l’identité de l’entreprise'
        : 'la corroboration du compte Instagram n’a pas pu être évaluée — ne pas savoir n’est pas savoir que oui',
    );
  }

  if (selection.selected === null) {
    return verdict(
      'BLOCKED_NO_SELECTABLE_CHANNEL',
      reachableChannels.length === 0
        ? 'aucun canal sélectionnable ne dépasse le seuil : rien ici ne permet un premier contact propre'
        : `aucun canal retenu malgré ${reachableChannels.join(', ')} éligible(s) — ${selection.reasons[0] ?? 'raison non publiée'}`,
    );
  }

  return verdict('ACTIONABLE', `${selection.selected} retenu — un premier contact propre est possible maintenant`);
}

/**
 * « Le moteur ferait-il un premier contact ? » — `null` quand il s'abstient.
 *
 * Même discipline que `modelWouldContact` sur la décision commerciale, et pour
 * la même raison : `BLOCKED_INSUFFICIENT_EVIDENCE` n'est pas un « non ». Le
 * modèle n'a pas répondu, il a dit qu'il ne savait pas, et le compter comme un
 * refus donnerait un taux d'accord flatteur ou catastrophique selon le sens du
 * vent. Les deux mesures abstiennent donc sur exactement les mêmes cas, ce qui
 * est la condition pour qu'on puisse les comparer.
 */
export function modelWouldAct(actionability: OutboundActionability): boolean | null {
  if (actionability === 'BLOCKED_INSUFFICIENT_EVIDENCE') return null;
  return actionability === 'ACTIONABLE';
}
