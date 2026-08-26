import { markerState, type CommercialFacts, type EmailShape, type ObservedContact } from '@/lib/pipeline/commercialSignals';
import type { CommercialDecision } from '@/lib/pipeline/commercialIntelligence';
import type { CommercialIntelligenceProfile } from '@/lib/config/schema';

/**
 * R7.1 — trois questions que le dépôt confondait en une.
 *
 * ---------------------------------------------------------------------------
 * CHANNEL AVAILABLE ≠ CHANNEL FIT ≠ CHANNEL SELECTED
 * ---------------------------------------------------------------------------
 * Aujourd'hui, `bestChannel()` (`src/lib/crm/view.ts`) répond aux trois d'un
 * coup, et sa réponse est déterminée par l'ordre d'un tableau :
 *
 *     if (email)     channels.push('email');        // ← poussé en premier
 *     if (instagram) channels.push('instagram_dm');
 *     ...
 *     return observedChannels(input)[0] ?? null;    // ← le premier gagne
 *
 * Il n'existe donc aucune règle « préférer l'email » à débattre : l'email gagne
 * parce qu'il est écrit à la première ligne. Sur le corpus réel, 25 des 28
 * prospects qui ont un Instagram observé ont AUSSI un email — et les 25
 * reçoivent « email » pour cette seule raison.
 *
 * Ce module sépare les trois :
 *
 *   AVAILABLE  un identifiant a été observé. Un fait, rien de plus.
 *   FIT        ce canal est-il adapté À CETTE ENTREPRISE, vu ce qu'on a lu ?
 *              Un score et une confiance, par canal, indépendants les uns des
 *              autres — un canal ne « gagne » pas parce qu'un autre est faible.
 *   SELECTED   le canal retenu, avec ses raisons — et seulement si le prospect
 *              mérite d'être contacté.
 *
 * ---------------------------------------------------------------------------
 * La règle qui compte le plus (§20 de la mission)
 * ---------------------------------------------------------------------------
 * La sélection de canal ne ressuscite JAMAIS un prospect faible. Un compte
 * Instagram parfait sur une entreprise dont l'acquisition est déjà mature donne
 * un `instagramFit` élevé ET un `selectedChannel` nul : « ne pas contacter »
 * prime sur « Instagram serait le bon canal ». `selectChannel` reçoit la
 * décision commerciale pour cette raison, et ne peut pas être appelée sans.
 *
 * Déterministe, sans réseau, sans modèle.
 */

export type ChannelKey = 'instagram' | 'email' | 'phone';

/** Le transport correspondant dans la taxonomie R6B, pour comparer à l'existant. */
export const CHANNEL_TO_TRANSPORT: Readonly<Record<ChannelKey, string>> = Object.freeze({
  instagram: 'instagram_dm',
  email: 'email',
  phone: 'phone_call',
});

/**
 * R7.2 §1 — les canaux pour lesquels un rail d'envoi EXISTE dans ce dépôt.
 *
 * Ce n'est pas une préférence, et ce n'est pas réglable : c'est un fait sur le
 * code. `phone_call` n'a ici aucun transport, aucune politique opératoire
 * validée, aucun workflow d'appel — rien n'appelle personne. Recommander
 * « téléphone » produirait donc une décision que personne ne peut exécuter, et
 * la ferait porter par un humain qui n'a jamais accepté de passer l'appel.
 *
 * Le téléphone reste OBSERVÉ et son fit reste CALCULÉ et publié : R7.1 a montré
 * qu'un site sans formulaire qui ne convertit que par appel est un fait
 * analytique utile. Ce qu'il ne peut pas devenir, c'est le canal retenu.
 *
 * Deux verrous plutôt qu'un, et l'ordre compte :
 *
 *   - `channels.selectable` (config) porte la DÉCISION PRODUIT d'un opérateur —
 *     « pour l'outbound automatique actuel, instagram ou email » ;
 *   - cette constante porte la CAPACITÉ du dépôt, et elle est en code parce
 *     qu'un fichier de configuration ne doit pas pouvoir déclarer sélectionnable
 *     un canal qu'aucun rail ne sait joindre. La sélection prend l'intersection
 *     des deux : élargir la config n'ouvre rien tant que le rail n'existe pas.
 */
export const CHANNELS_WITH_OUTBOUND_RAIL: readonly ChannelKey[] = Object.freeze(['instagram', 'email']);

export interface ChannelContribution {
  readonly key: string;
  readonly ratio: number | null;
  readonly weight: number;
  readonly detail: string;
}

export interface ChannelFit {
  readonly channel: ChannelKey;
  /** Un identifiant a-t-il été observé ? Sans lui, le canal n'est pas actionnable. */
  readonly available: boolean;
  /** 0..100, ou `null` si rien n'a pu être évalué. */
  readonly fit: number | null;
  readonly confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
  readonly contributions: readonly ChannelContribution[];
  readonly reasons: readonly string[];
  readonly missing: readonly string[];
}

/** Pourquoi un canal disponible n'a pas concouru. Publié, jamais tu. */
export interface ChannelExclusion {
  readonly channel: ChannelKey;
  readonly reason: 'no_outbound_rail' | 'not_selectable_by_policy' | 'below_minimum_fit' | 'not_available';
  readonly detail: string;
}

export interface ChannelSelection {
  readonly channels: readonly ChannelFit[];
  /** `null` quand aucun canal ne dépasse le seuil, ou quand le prospect ne doit pas être contacté. */
  readonly selected: ChannelKey | null;
  readonly selectedTransport: string | null;
  readonly reasons: readonly string[];
  readonly confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
  /** Les canaux écartés et la raison exacte — un fit élevé non retenu doit s'expliquer. */
  readonly excluded: readonly ChannelExclusion[];
  /**
   * R7.3B — les canaux qui passent la porte TECHNIQUE, décision commerciale mise
   * de côté : autorisés par la politique, dotés d'un rail, avec un identifiant
   * observé, et au-dessus du seuil de fit.
   *
   * Publié parce que `selected = null` recouvre aujourd'hui deux refus opposés :
   * « nous avons décidé de ne pas travailler ce prospect » et « nous n'avons
   * aucun moyen propre de l'atteindre ». Le premier ne demande rien, le second
   * demande une collecte. Sans cette liste, l'actionabilité devrait recalculer
   * l'éligibilité de son côté — et deux implémentations de « ce canal est-il
   * utilisable » finiraient par se contredire.
   */
  readonly eligible: readonly ChannelKey[];
  /** Celui que la sélection retiendrait si la décision commerciale le permettait. */
  readonly bestEligible: ChannelKey | null;
}

export interface ChannelFitInput {
  readonly contact: ObservedContact;
  readonly facts: CommercialFacts;
  readonly email: EmailShape;
  readonly profile: CommercialIntelligenceProfile;
  /**
   * Le handle est-il corroboré par l'identité de l'entreprise ? Fourni par
   * l'appelant (`icpEligibility` sait déjà comparer handle, domaine et
   * raison sociale) — ce module ne refait pas ce travail.
   */
  readonly identityCorroborated: boolean | null;
}

function score(
  channel: ChannelKey,
  available: boolean,
  contributions: readonly ChannelContribution[],
  confidenceThresholds: CommercialIntelligenceProfile['confidence'],
): ChannelFit {
  let earned = 0;
  let applicable = 0;
  let total = 0;
  const reasons: string[] = [];
  const missing: string[] = [];

  for (const contribution of contributions) {
    total += contribution.weight;
    if (contribution.ratio === null) {
      missing.push(contribution.key);
      continue;
    }
    applicable += contribution.weight;
    earned += contribution.ratio * contribution.weight;
    if (contribution.ratio > 0) reasons.push(contribution.detail);
  }

  const coverage = total > 0 ? applicable / total : 0;
  return {
    channel,
    available,
    fit: applicable > 0 ? Math.round((earned / applicable) * 100) : null,
    confidence:
      coverage <= 0
        ? 'NONE'
        : coverage >= confidenceThresholds.high
          ? 'HIGH'
          : coverage >= confidenceThresholds.medium
            ? 'MEDIUM'
            : 'LOW',
    contributions,
    reasons,
    missing,
  };
}

function weightOf(map: Readonly<Record<string, number>>, key: string, channel: ChannelKey): number {
  const weight = map[key];
  if (weight === undefined) {
    throw new Error(
      `profil commercial-intelligence : aucun poids déclaré pour « ${key} » (canal ${channel}). ` +
        'Ajouter un contributeur de canal demande de décider de son poids dans config/commercial-intelligence/.',
    );
  }
  return weight;
}

/**
 * Instagram.
 *
 * Ce que le fit récompense n'est PAS « le handle existe » — c'est la preuve que
 * ce compte appartient bien à cette entreprise et qu'elle s'en sert :
 *
 *   - le lien vers Instagram a été lu SUR LE SITE de l'entreprise
 *     (`cta_instagram`). C'est la provenance la plus forte que nous ayons :
 *     l'entreprise elle-même déclare ce compte ;
 *   - l'identité est corroborée (handle ↔ domaine ↔ raison sociale) ;
 *   - le site montre un chemin de conversion par DM.
 *
 * Ce que le fit NE PEUT PAS voir aujourd'hui : abonnés, nombre de
 * publications, date de dernière publication, cadence. Rien de tout cela n'est
 * collecté (aucune colonne, aucun champ d'evidence — l'adaptateur
 * `businessDiscovery` qui saurait les lire n'est appelé par aucun rail). La
 * confiance est donc bornée par la couverture, et le rapport R7.1 nomme ce
 * manque au lieu de le combler par une supposition.
 */
function instagramFit(input: ChannelFitInput): ChannelFit {
  const { contact, facts, profile } = input;
  const weights = profile.channels.instagram;
  const available = contact.instagramHandle !== null;
  const contributions: ChannelContribution[] = [];

  const push = (key: string, ratio: number | null, detail: string): void => {
    contributions.push({ key, ratio, weight: weightOf(weights, key, 'instagram'), detail });
  };

  push(
    'handleObserved',
    available ? 1 : 0,
    available ? `compte @${contact.instagramHandle} observé` : 'aucun compte Instagram observé',
  );

  push(
    'linkedFromOwnSite',
    facts.siteRead ? (facts.instagramLinkedFromSite ? 1 : 0) : null,
    !facts.siteRead
      ? 'site non lu : impossible de savoir si l’entreprise déclare ce compte'
      : facts.instagramLinkedFromSite
        ? 'l’entreprise lie elle-même ce compte depuis son site'
        : 'aucun lien Instagram trouvé sur les pages lues',
  );

  push(
    'identityCorroborated',
    input.identityCorroborated === null ? null : input.identityCorroborated ? 1 : 0,
    input.identityCorroborated === null
      ? 'corroboration d’identité non évaluée'
      : input.identityCorroborated
        ? 'handle cohérent avec l’identité de l’entreprise'
        : 'handle non corroboré par l’identité de l’entreprise',
  );

  push(
    'nicheChannelAffinity',
    profile.nicheChannelAffinity.instagram,
    `affinité de la niche pour le DM (${profile.nicheChannelAffinity.instagram})`,
  );

  const dmPath = markerState(facts, 'cta_instagram');
  push(
    'businessUsesDmPath',
    dmPath === 'not_checked' ? null : dmPath === 'observed' ? 1 : 0,
    dmPath === 'not_checked'
      ? 'usage du DM non observé'
      : dmPath === 'observed'
        ? 'le site pousse vers Instagram'
        : 'le site ne pousse pas vers Instagram',
  );

  return score('instagram', available, contributions, profile.confidence);
}

/**
 * Email.
 *
 * L'email ne gagne plus « parce qu'il existe ». Il gagne quand il est
 * PROFESSIONNEL et PUBLIÉ : une boîte sur le domaine de l'entreprise, citée sur
 * son propre site, sur une entreprise dont le parcours est déjà écrit plutôt
 * que social.
 *
 * `writtenPathPreferred` est le seul contributeur relatif du module, et il est
 * assumé : quand une entreprise a un devis ou une réservation en ligne, elle
 * traite déjà des demandes écrites, et un email tombe dans un flux existant.
 */
function emailFit(input: ChannelFitInput): ChannelFit {
  const { contact, facts, email, profile } = input;
  const weights = profile.channels.email;
  const available = contact.email !== null;
  const contributions: ChannelContribution[] = [];

  const push = (key: string, ratio: number | null, detail: string): void => {
    contributions.push({ key, ratio, weight: weightOf(weights, key, 'email'), detail });
  };

  push('addressObserved', available ? 1 : 0, available ? `adresse ${contact.email} observée` : 'aucune adresse observée');

  push(
    'ownDomain',
    email.kind === 'none'
      ? null
      : email.kind === 'own_domain_role' || email.kind === 'own_domain_personal'
        ? 1
        : email.kind === 'other_domain'
          ? 0.4
          : 0.2,
    email.detail,
  );

  push(
    'roleMailbox',
    email.kind === 'none' ? null : email.kind === 'own_domain_role' ? 1 : 0.3,
    email.kind === 'own_domain_role' ? 'boîte fonctionnelle : lue par l’entreprise, pas par une personne' : email.detail,
  );

  const published = markerState(facts, 'cta_email');
  push(
    'publishedOnSite',
    published === 'not_checked' ? null : published === 'observed' ? 1 : 0,
    published === 'not_checked'
      ? 'publication de l’email non vérifiée'
      : published === 'observed'
        ? 'adresse publiée sur le site de l’entreprise'
        : 'aucune adresse publiée sur les pages lues',
  );

  const writtenPath =
    markerState(facts, 'form_quote') === 'observed' ||
    markerState(facts, 'booking_online') === 'observed' ||
    markerState(facts, 'form_contact') === 'observed';
  push(
    'writtenPathPreferred',
    facts.siteRead ? (writtenPath ? 1 : 0.35) : null,
    !facts.siteRead
      ? 'parcours non observé'
      : writtenPath
        ? 'l’entreprise traite déjà des demandes écrites'
        : 'aucun parcours écrit observé — l’email arrive hors de ses habitudes',
  );

  push(
    'nicheChannelAffinity',
    profile.nicheChannelAffinity.email,
    `affinité de la niche pour l’email (${profile.nicheChannelAffinity.email})`,
  );

  return score('email', available, contributions, profile.confidence);
}

/**
 * Téléphone.
 *
 * Présent pour que le modèle soit honnête sur ce qu'il voit, pas pour ouvrir un
 * rail d'appel : rien dans ce dépôt n'appelle personne. Son fit monte quand
 * l'entreprise convertit manifestement par téléphone et qu'aucun chemin écrit
 * n'existe — c'est-à-dire quand elle est structurellement injoignable autrement.
 */
function phoneFit(input: ChannelFitInput): ChannelFit {
  const { contact, facts, profile } = input;
  const weights = profile.channels.phone;
  const available = contact.phone !== null;
  const contributions: ChannelContribution[] = [];

  const push = (key: string, ratio: number | null, detail: string): void => {
    contributions.push({ key, ratio, weight: weightOf(weights, key, 'phone'), detail });
  };

  push('numberObserved', available ? 1 : 0, available ? `numéro ${contact.phone} observé` : 'aucun numéro observé');

  const published = markerState(facts, 'cta_phone');
  push(
    'publishedOnSite',
    published === 'not_checked' ? null : published === 'observed' ? 1 : 0,
    published === 'not_checked'
      ? 'publication du numéro non vérifiée'
      : published === 'observed'
        ? 'numéro publié sur le site'
        : 'aucun numéro publié sur les pages lues',
  );

  const phoneOnly = markerState(facts, 'phone_only') === 'observed';
  push(
    'businessConvertsByPhone',
    facts.siteRead ? (phoneOnly || published === 'observed' ? 1 : 0) : null,
    !facts.siteRead
      ? 'parcours non observé'
      : phoneOnly
        ? 'conversion par téléphone seul observée'
        : published === 'observed'
          ? 'le téléphone est un chemin de conversion affiché'
          : 'le téléphone n’est pas un chemin de conversion affiché',
  );

  const noWritten =
    markerState(facts, 'form_quote') !== 'observed' &&
    markerState(facts, 'booking_online') !== 'observed' &&
    markerState(facts, 'form_contact') !== 'observed';
  push(
    'noWrittenPathAvailable',
    facts.siteRead ? (noWritten ? 1 : 0) : null,
    !facts.siteRead ? 'parcours non observé' : noWritten ? 'aucun chemin écrit disponible' : 'un chemin écrit existe',
  );

  /**
   * L'affinité de niche s'applique aux TROIS canaux, sans exception.
   *
   * Ne la poser que sur Instagram aurait produit exactement le défaut que R7
   * corrige, en miroir : un téléphone publié sur un site sans formulaire
   * atteignait 100 de fit et gagnait par construction, non parce qu'appeler un
   * artisan est le bon geste, mais parce que son canal était le seul à ne pas
   * porter le jugement de niche. Une préférence qui ne s'applique qu'à un camp
   * n'est pas une préférence, c'est un biais.
   */
  push(
    'nicheChannelAffinity',
    profile.nicheChannelAffinity.phone,
    `affinité de la niche pour l’appel (${profile.nicheChannelAffinity.phone})`,
  );

  return score('phone', available, contributions, profile.confidence);
}

const CONFIDENCE_RANK: Readonly<Record<ChannelFit['confidence'], number>> = Object.freeze({
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
  NONE: 0,
});

/**
 * Les canaux réellement sélectionnables : décision produit ∩ capacité du dépôt.
 *
 * L'intersection est prise dans ce sens et jamais l'union. Une config qui
 * déclarerait `phone` sélectionnable ne l'ouvrirait pas — il n'y a pas de rail —
 * et une config qui retire `email` le retire vraiment.
 */
export function selectableChannels(profile: CommercialIntelligenceProfile): ChannelKey[] {
  return profile.channels.selectable.filter((channel) => CHANNELS_WITH_OUTBOUND_RAIL.includes(channel));
}

/**
 * Le canal retenu — et le refus de le retenir quand il ne faut pas écrire.
 *
 * L'ordre des refus EST la règle, et il va du commercial vers le technique :
 *
 *   1. la DÉCISION COMMERCIALE d'abord. `DO_NOT_PRIORITIZE`, `DEPRIORITIZE` et
 *      `INSUFFICIENT_EVIDENCE` ne sélectionnent RIEN, quel que soit le fit.
 *      C'est le §20 de R7.1, redit par le §10 de R7.2 : un excellent canal ne
 *      rattrape pas un prospect qu'on a décidé de ne pas travailler ;
 *   2. le canal doit être SÉLECTIONNABLE — un rail d'envoi existe et la
 *      politique l'autorise (§1 : le téléphone n'est ni l'un ni l'autre) ;
 *   3. le canal doit être DISPONIBLE — un fit élevé sur un canal dont aucun
 *      identifiant n'a été observé n'est pas actionnable ;
 *   4. le meilleur FIT gagne, à condition de dépasser `minimumFit` ;
 *   5. les départages, quand deux fits sont strictement égaux.
 *
 * ---------------------------------------------------------------------------
 * §10 — plus aucune position de tableau ne décide
 * ---------------------------------------------------------------------------
 * R7.1 avait déjà retiré à l'ordre d'observation le pouvoir de choisir le canal
 * (c'était le défaut de `bestChannel()` : l'email gagnait parce qu'il était
 * poussé en première ligne). Il en restait une trace : à égalité stricte de fit,
 * le vainqueur était `order.indexOf()`, c'est-à-dire encore une position dans un
 * tableau écrit en dur.
 *
 * Les départages sont donc désormais des FAITS, dans cet ordre :
 *
 *   a. la CONFIANCE du fit — à note égale, le canal dont la note repose sur
 *      davantage d'observations réelles gagne. C'est le seul départage qui
 *      apporte de l'information ;
 *   b. l'AFFINITÉ DE NICHE déclarée en configuration — un jugement de niche
 *      assumé et modifiable sans code, pas une ligne de source ;
 *   c. le nom du canal, par ordre alphabétique, uniquement pour que la sortie
 *      reste rejouable si a et b sont eux aussi à égalité. Ce dernier cran est
 *      un garant de déterminisme, jamais une préférence : il n'est atteint que
 *      lorsque deux canaux sont indiscernables sur tout ce qu'on sait d'eux.
 */
export function selectChannel(
  fits: readonly ChannelFit[],
  decision: CommercialDecision,
  profile: CommercialIntelligenceProfile,
): ChannelSelection {
  const selectable = selectableChannels(profile);
  const excluded: ChannelExclusion[] = [];

  for (const fit of fits) {
    if (!CHANNELS_WITH_OUTBOUND_RAIL.includes(fit.channel)) {
      excluded.push({
        channel: fit.channel,
        reason: 'no_outbound_rail',
        detail:
          `aucun rail d’envoi « ${fit.channel} » n’existe dans ce dépôt — ` +
          'le fit reste calculé et publié, mais le canal ne peut pas être retenu',
      });
    } else if (!selectable.includes(fit.channel)) {
      excluded.push({
        channel: fit.channel,
        reason: 'not_selectable_by_policy',
        detail: `canal « ${fit.channel} » exclu par la politique de sélection déclarée en configuration`,
      });
    } else if (!fit.available) {
      excluded.push({ channel: fit.channel, reason: 'not_available', detail: 'aucun identifiant observé' });
    } else if (fit.fit === null || fit.fit < profile.channels.minimumFit) {
      excluded.push({
        channel: fit.channel,
        reason: 'below_minimum_fit',
        detail: `fit ${fit.fit ?? '—'} sous le seuil de ${profile.channels.minimumFit}`,
      });
    }
  }

  /**
   * L'éligibilité TECHNIQUE est calculée avant la porte commerciale, et c'est
   * un changement d'ordre, pas de règle : la liste est publiée dans tous les
   * cas, y compris quand la décision interdit de retenir quoi que ce soit.
   * `selected` obéit exactement à la même règle qu'avant.
   */
  const affinity = profile.nicheChannelAffinity;
  const eligibleFits = [...fits]
    .filter(
      (fit) =>
        selectable.includes(fit.channel) &&
        fit.available &&
        fit.fit !== null &&
        fit.fit >= profile.channels.minimumFit,
    )
    .sort((a, b) => {
      const byFit = (b.fit ?? 0) - (a.fit ?? 0);
      if (byFit !== 0) return byFit;
      const byConfidence = CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence];
      if (byConfidence !== 0) return byConfidence;
      const byAffinity = affinity[b.channel] - affinity[a.channel];
      if (byAffinity !== 0) return byAffinity;
      return a.channel.localeCompare(b.channel);
    });
  const eligible = eligibleFits.map((fit) => fit.channel);
  const winner = eligibleFits[0];
  const bestEligible = winner?.channel ?? null;

  const actionable = decision === 'PRIORITIZE' || decision === 'CONSIDER';
  if (!actionable) {
    return {
      channels: fits,
      selected: null,
      selectedTransport: null,
      confidence: 'NONE',
      excluded,
      eligible,
      bestEligible,
      reasons: [
        `aucun canal retenu : la décision commerciale est « ${decision} ». ` +
          'Le choix du canal ne ressuscite pas un prospect qu’on a décidé de ne pas travailler.' +
          (bestEligible === null ? '' : ` (${bestEligible} serait joignable si la décision changeait)`),
      ],
    };
  }

  if (winner === undefined) {
    const best = fits
      .filter((fit) => selectable.includes(fit.channel) && fit.available)
      .sort((a, b) => (b.fit ?? 0) - (a.fit ?? 0))[0];
    return {
      channels: fits,
      selected: null,
      selectedTransport: null,
      confidence: 'NONE',
      excluded,
      eligible,
      bestEligible,
      reasons: [
        best === undefined
          ? `aucun canal sélectionnable observé (sélectionnables : ${selectable.join(', ') || 'aucun'})`
          : `aucun canal n’atteint le seuil de ${profile.channels.minimumFit} (meilleur : ${best.channel} à ${best.fit ?? 0})`,
      ],
    };
  }

  const runnerUp = eligibleFits[1];
  const reasons = [
    `${winner.channel} retenu (fit ${winner.fit ?? 0}/100)`,
    ...winner.reasons.slice(0, 3),
    ...(runnerUp === undefined ? [] : [`devant ${runnerUp.channel} (fit ${runnerUp.fit ?? 0}/100)`]),
  ];

  return {
    channels: fits,
    selected: winner.channel,
    selectedTransport: CHANNEL_TO_TRANSPORT[winner.channel],
    confidence: winner.confidence,
    excluded,
    eligible,
    bestEligible,
    reasons,
  };
}

/** Les trois fits, calculés indépendamment les uns des autres. */
export function assessChannelFits(input: ChannelFitInput): ChannelFit[] {
  return [instagramFit(input), emailFit(input), phoneFit(input)];
}
