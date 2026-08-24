import type { Sql } from '@/lib/db/sql';
import { DispatchBlockedError, resolveDispatchTarget } from '@/lib/pipeline/r6bDispatcher';
import type { DispatchEnvelope } from '@/lib/pipeline/r6bTransportAdapters';
import { getLiveReadiness } from '@/lib/pipeline/r6bTransportPayload';
import { loadLatestIcpAssessment } from '@/lib/pipeline/icpAssessment';
import { assessAudienceScaleForProspect } from '@/lib/pipeline/audienceObservation';
import { loadCommercialIntelligenceProfile } from '@/lib/config/load';
import { loadEffectiveChannelIdentityDecision } from '@/lib/pipeline/channelIdentity';
import { TERMINAL_JOB_STATUSES, type GateRecord, type InstagramAction, type InstagramSkipReason } from '@/lib/instagram/types';
import {
  contactsOnChannel,
  contactsOnOtherChannels,
  describeGroup,
  describeLink,
  loadBusinessContactHistory,
} from '@/lib/pipeline/businessContactGuard';

/**
 * IG3 §2 — la porte d'entrée de la file, et la seule.
 *
 * Ce module répond à une question qui n'avait, jusqu'ici, aucun endroit où être
 * posée : « ce prospect a-t-il quelque chose à faire dans une file Instagram
 * commerciale ? ». `enqueueInstagramJob` demandait seulement à R6B si le
 * manifeste était intègre — LOCKED, courant, empreintes exactes, destinataire
 * non supprimé. Toutes bonnes questions, aucune ne portant sur le PROSPECT.
 *
 * C'est exactement l'angle mort du 12 août : `demo_prospect_a` a été verrouillé,
 * enfilé et exécuté alors que son propre site annonçait « Devenez franchisé
 * DetailCar » depuis le premier crawl. La preuve était en base, personne ne la
 * lisait sur ce chemin. Ici, elle est lue — et la mission le demande en toutes
 * lettres : « Aucun mécanisme ne doit pouvoir le remettre dans une queue
 * commerciale ».
 *
 * Trois verdicts, et la différence entre les deux derniers est le cœur du
 * module :
 *
 *   ELIGIBLE                    — les dix portes passent.
 *   INELIGIBLE:<reason>         — un fait connu s'y oppose, et aucun nouvel
 *                                 essai ne le changera. Rien n'est enfilé.
 *   REVIEW_REQUIRED:<reason>    — nous ne SAVONS PAS. Rien n'est enfilé non
 *                                 plus, et c'est délibéré : « pas d'information »
 *                                 n'est pas « pas de problème » (CLAUDE.md §2).
 *
 * Aucun de ces verdicts n'est un LLM. Ce sont des lectures de lignes existantes
 * — `prospect_icp_assessments`, `outreach_events`, `ig_dispatch_jobs`,
 * `do_not_contact`, `channel_identity_decisions` — comparées par du code testé,
 * comme l'exigent les conventions du dépôt pour toute logique déterministe.
 */

export type EligibilityVerdict = 'ELIGIBLE' | 'INELIGIBLE' | 'REVIEW_REQUIRED';

export interface EligibilityDecision {
  readonly verdict: EligibilityVerdict;
  /** Le motif machine, dans le vocabulaire fermé partagé avec les reports. */
  readonly reason: InstagramSkipReason | null;
  /** Le code relayé quand c'est R6B qui a refusé — jamais réécrit en un équivalent local. */
  readonly reasonCode: string;
  readonly detail: string;
  readonly gates: readonly GateRecord[];
  /** L'enveloppe résolue, présente seulement quand le manifeste a pu être lu. */
  readonly envelope: DispatchEnvelope | null;
  readonly prospectId: string | null;
  readonly manifestId: string | null;
  readonly expectedHandle: string | null;
}

/** La forme lisible demandée par la mission : `ELIGIBLE`, `INELIGIBLE:<reason>`, … */
export function formatEligibility(decision: EligibilityDecision): string {
  return decision.verdict === 'ELIGIBLE' ? 'ELIGIBLE' : `${decision.verdict}:${decision.reason ?? decision.reasonCode}`;
}

/**
 * Les motifs R6B qui, traduits, sont des refus DÉFINITIFS côté file.
 *
 * Le reste des `DispatchBlockCode` (empreinte qui ne correspond plus, manifeste
 * qui n'est plus le courant, payload hors taxonomie) décrit un manifeste
 * réparable : quelqu'un reverrouille, et le prospect redevient enfilable. Ceux-ci
 * décrivent une décision prise sur la PERSONNE, et un nouvel enfilement ne la
 * renverserait pas.
 */
const R6B_TERMINAL_REASON: Readonly<Record<string, InstagramSkipReason>> = Object.freeze({
  RECIPIENT_SUPPRESSED: 'opt_out',
  PROSPECT_STATE_BLOCKS_OUTBOUND: 'prospect_inactive',
});

export interface EligibilityInput {
  readonly manifestId: string;
  readonly action: InstagramAction;
}

/**
 * Évalue les dix portes de la mission §2, dans l'ordre où un refus coûte le
 * moins cher, et s'arrête au premier refus.
 *
 * L'ordre importe pour une raison de fond et non de performance : les portes
 * qui portent sur l'INTENTION (manifeste intègre, transport Instagram) passent
 * avant celles qui portent sur la PERSONNE (ICP, contact déjà établi), parce
 * qu'un refus fondé sur le prospect n'a de sens que si l'on sait de quel
 * prospect on parle. Un `MANIFEST_NOT_FOUND` ne doit pas se journaliser comme
 * « hors ICP ».
 */
export async function evaluateInstagramEligibility(
  sql: Sql,
  input: EligibilityInput,
): Promise<EligibilityDecision> {
  const gates: GateRecord[] = [];

  const refuse = (
    verdict: 'INELIGIBLE' | 'REVIEW_REQUIRED',
    gate: string,
    reason: InstagramSkipReason,
    reasonCode: string,
    detail: string,
    context: Pick<EligibilityDecision, 'envelope' | 'prospectId' | 'manifestId' | 'expectedHandle'>,
  ): EligibilityDecision => {
    gates.push({ gate, verdict: 'BLOCK', detail });
    return { verdict, reason, reasonCode, detail, gates: Object.freeze([...gates]), ...context };
  };
  const pass = (gate: string, detail: string): void => {
    gates.push({ gate, verdict: 'PASS', detail });
  };

  const empty = { envelope: null, prospectId: null, manifestId: null, expectedHandle: null } as const;

  // ---- 1/7/9/10. L'intention approuvée, revalidée par R6B ------------------
  //
  // Appelé tel quel, avec toutes ses gardes : manifeste LOCKED, unique
  // manifeste actif de son item, empreinte du texte recalculée, empreinte du
  // payload recalculée, forme du destinataire, preuve de destinataire non vide
  // (donc provenance de l'identité), adresse non supprimée, prospect qui n'a
  // pas déjà répondu. Réécrire une version « allégée » pour Instagram créerait
  // une seconde vérité, plus indulgente — celle qu'on finirait par utiliser.
  let envelope: DispatchEnvelope;
  try {
    ({ envelope } = await resolveDispatchTarget(sql, input.manifestId, 'DRY_RUN'));
  } catch (error) {
    if (error instanceof DispatchBlockedError) {
      const terminal = R6B_TERMINAL_REASON[error.code];
      return refuse(
        terminal === undefined ? 'REVIEW_REQUIRED' : 'INELIGIBLE',
        'manifest',
        terminal ?? 'review_required',
        error.code,
        error.message,
        empty,
      );
    }
    throw error;
  }
  const context = {
    envelope,
    prospectId: envelope.prospectId,
    manifestId: envelope.manifestId,
    expectedHandle: envelope.recipient,
  } as const;
  pass('manifest', `manifeste ${envelope.manifestId} LOCKED, courant, empreintes exactes`);
  pass('recipient_provenance', `${envelope.recipientEvidenceIds.length} preuve(s) de destinataire`);

  // ---- 3. Le canal Instagram est-il celui de ce manifeste ? ----------------
  if (envelope.transport !== 'instagram_dm') {
    return refuse(
      'INELIGIBLE',
      'transport',
      'payload_unavailable',
      'IG_TRANSPORT_NOT_INSTAGRAM',
      `manifeste ${envelope.manifestId} : transport « ${envelope.transport} » — cette file n'accepte que instagram_dm`,
      context,
    );
  }
  pass('transport', 'instagram_dm');

  // ---- 2 bis. De quel COMMERCE parle-t-on, au juste ? ----------------------
  //
  // R7-PILOT §1 — toutes les portes « ce prospect a-t-il déjà été joint ? » qui
  // suivent interrogeaient `prospect_id`, c'est-à-dire une LIGNE. Le 19 août
  // 2026, une nouvelle campagne a recréé `DEMO PROSPECT A` sous un nouvel
  // identifiant : la ligne affichait `outreach_events = 0`, ce qui était vrai
  // d'elle et faux du commerce, dont le compte `@demo_prospect_a` avait reçu un
  // DM six jours plus tôt. Aucune de ces portes ne pouvait le voir.
  //
  // L'historique est donc lu UNE FOIS, ici, pour tout le groupe d'identité —
  // les lignes qui partagent une clé décisive (SIREN, domaine, identifiant de
  // lieu, compte Instagram, e-mail), toutes campagnes confondues. Rien n'est
  // fusionné : les lignes restent distinctes, seule la QUESTION devient
  // globale.
  const history = await loadBusinessContactHistory(sql, envelope.prospectId);
  if (history.duplicateIdentity) {
    // Journalisé même quand rien ne bloque : un doublon silencieux est
    // exactement ce qui a permis au défaut d'exister.
    gates.push({
      gate: 'identity_group',
      verdict: 'PASS',
      detail:
        `${String(history.group.siblings.length)} autre(s) ligne(s) portent cette identité — ` +
        describeGroup(history.group),
    });
  } else {
    pass('identity_group', 'aucune autre ligne du corpus ne porte cette identité');
  }

  // ---- 7 bis. L'opt-out enregistré comme HANDLE -------------------------
  //
  // `resolveDispatchTarget` a déjà consulté `do_not_contact`, et il l'a fait
  // correctement — pour une adresse e-mail. Sa requête est
  // `match_kind = 'email'` en dur (`loadRecipientSuppression`), parce qu'elle a
  // été écrite pour le transport e-mail et qu'un handle comparé à une colonne
  // d'adresses ne trouve jamais rien.
  //
  // La table connaît pourtant `match_kind = 'instagram'` depuis 0001. Le rail
  // Instagram passait donc à côté de toutes les exclusions enregistrées sous ce
  // type : quelqu'un qui aurait écrit « ne me recontactez pas » sur Instagram et
  // dont on aurait consigné le handle serait resté enfilable. Le gate est ici,
  // sur le chemin Instagram, à côté de celui qui le complète — plutôt que dans
  // `loadRecipientSuppression`, dont la sémantique e-mail est juste et n'a pas
  // à devenir polymorphe.
  const handleSuppression = await sql.query<{ reason: string }>(
    `select reason from do_not_contact
      where match_kind = 'instagram' and lower(value) = lower($1) limit 1`,
    [envelope.recipient],
  );
  const suppressed = handleSuppression[0];
  if (suppressed) {
    return refuse(
      'INELIGIBLE',
      'opt_out',
      'opt_out',
      'IG_HANDLE_SUPPRESSED',
      `@${envelope.recipient} figure dans do_not_contact (${suppressed.reason}) — ` +
        'aucun envoi vers un compte exclu, quel que soit le mode',
      context,
    );
  }
  // La même question, posée au GROUPE : une exclusion enregistrée sur l'ancienne
  // ligne du même commerce (son e-mail, son domaine, son SIREN, ou le handle tel
  // qu'il y était orthographié) vaut pour cette ligne-ci. Un opt-out appartient
  // au commerce, pas à la fiche qui l'a reçu.
  const groupSuppression = history.suppressions.find((suppression) => !suppression.isSelf);
  if (groupSuppression) {
    const member = history.group.members.find((m) => m.prospectId === groupSuppression.prospectId);
    return refuse(
      'INELIGIBLE',
      'opt_out',
      'opt_out',
      'IG_IDENTITY_HANDLE_SUPPRESSED',
      `« ${groupSuppression.value} » (${groupSuppression.matchKind}) figure dans do_not_contact ` +
        `(${groupSuppression.reason}) pour ${member?.displayName ?? 'une autre ligne'} ` +
        `(${groupSuppression.prospectId}, campagne ${member?.campaignSlug ?? '—'}), qui est le MÊME commerce ` +
        `que ce prospect — aucun envoi vers un commerce exclu, quelle que soit la ligne qui le porte`,
      context,
    );
  }
  pass('opt_out', 'ni l’adresse ni le handle ne figurent dans do_not_contact, pour aucune ligne de cette identité');

  // ---- 8. Le prospect est-il dans la cible ? ------------------------------
  //
  // La ligne la plus récente de `prospect_icp_assessments`, jamais une colonne
  // mutable : c'est ce journal qui permet de répondre à « que savions-nous le
  // jour où nous avons verrouillé ce manifeste ? ».
  //
  // L'ABSENCE de verdict est un refus, pas un laissez-passer. C'est le point
  // exact où la règle « ne jamais affirmer une absence non vérifiée » se paie :
  // un prospect jamais évalué n'est pas « probablement bon », il est inconnu.
  const icp = await loadLatestIcpAssessment(sql, envelope.prospectId);
  if (icp === null) {
    return refuse(
      'REVIEW_REQUIRED',
      'icp',
      'review_required',
      'IG_ICP_NOT_ASSESSED',
      `le prospect ${envelope.prospectId} n'a aucun verdict ICP — ` +
        'lancer « npm run icp:audit » avant de l\'enfiler ; non évalué n\'est pas éligible',
      context,
    );
  }
  if (icp.verdict === 'NOT_TARGET') {
    return refuse(
      'INELIGIBLE',
      'icp',
      'icp_not_target',
      'IG_ICP_NOT_TARGET',
      `verdict ICP « NOT_TARGET » du ${icp.createdAt} : ${icp.reason}`,
      context,
    );
  }
  if (icp.verdict !== 'GOOD_ICP') {
    return refuse(
      'REVIEW_REQUIRED',
      'icp',
      'review_required',
      'IG_ICP_REVIEW_REQUIRED',
      `verdict ICP « ${icp.verdict} » du ${icp.createdAt} : ${icp.reason}`,
      context,
    );
  }
  pass('icp', `GOOD_ICP (${icp.profileKey} v${String(icp.profileVersion)}, ${icp.createdAt})`);

  // ---- 8 bis. Le prospect est-il à notre TAILLE ? --------------------------
  //
  // R7.6-GATE — la porte que l'audit du 21 août 2026 a trouvée manquante.
  //
  // L'ICP répond « quel TYPE d'entreprise » : franchise, réseau, multi-sites,
  // portée nationale. Il ne répond pas « quelle TAILLE », et il n'a jamais
  // prétendu le faire — `socialAcquisitionGap.ts` écrit noir sur blanc que
  // `followers_count` n'entre nulle part dans cette lecture-là, et il a raison :
  // un compteur d'abonnés n'est pas une preuve de besoin d'acquisition.
  //
  // C'est en revanche une TAILLE, et la taille est une question d'éligibilité.
  // R7.6 l'a écrite comme telle (`classifyAudienceScale` /
  // `assessTargetEligibility`), avec son seuil en configuration. Le 21 août
  // 2026, @demo_account_09 — 20 179 abonnés, identité MATCH — a pourtant
  // atteint un batch de review : la règle existait, la donnée existait, et
  // aucune porte d'envoi ne les lisait ensemble. Celle-ci les lit.
  //
  // Une audience NON OBSERVÉE ou NON ATTRIBUÉE passe, et c'est délibéré : la
  // bande est `UNKNOWN`, et `UNKNOWN` n'est pas `OUT_OF_SCOPE`. Refuser sur une
  // absence exclurait tout prospect dont personne n'a ouvert le profil, ce que
  // le §20 de R7.6 interdit nommément — l'absence de canal n'est pas une
  // absence d'opportunité.
  const commercialProfile = loadCommercialIntelligenceProfile();
  const audience = await assessAudienceScaleForProspect(
    sql,
    envelope.prospectId,
    commercialProfile.opportunity,
  );
  if (audience.excluded) {
    const observed = audience.observed;
    return refuse(
      'INELIGIBLE',
      'audience_scale',
      'audience_out_of_scope',
      'IG_AUDIENCE_OUT_OF_SCOPE',
      `${audience.scale.detail}` +
        (observed === null
          ? ''
          : ` (compte @${observed.handle}, lu le ${observed.observedAt}, source « ${observed.source} »)`) +
        ` — seuil ${String(commercialProfile.opportunity.audience.outOfSweetSpotAtOrAbove)} abonnés, ` +
        `config/commercial-intelligence/${commercialProfile.key}.json`,
      context,
    );
  }
  pass('audience_scale', audience.scale.detail);

  // ---- 2. Le handle est-il une identité, ou une ressemblance ? -------------
  //
  // APRÈS l'ICP, et l'ordre a été choisi en regardant ce que la commande
  // `--check` répondait sur `demo_prospect_a` : « identité en manual_review ».
  // Vrai, et sans intérêt — cette réponse décrit l'état de NOTRE travail
  // (personne n'a encore relu), pas celui du prospect. Un opérateur qui la
  // lisait pouvait croire qu'il suffisait de confirmer l'identité pour ouvrir
  // la porte ; il aurait alors buté sur le mur suivant, qui est définitif.
  //
  // Un fait terminal sur le PROSPECT passe donc avant une tâche en cours chez
  // nous. Le refus dit maintenant « hors ICP », qui est la vérité durable.
  //
  // `identityStatus` porte le verdict figé au verrouillage. `manual_review` dit
  // qu'un humain devait regarder — donc que personne ne l'a encore fait — et
  // `uncertain` dit que le rapprochement entreprise/compte n'a pas été établi.
  // Enfiler l'un ou l'autre serait envoyer un premier message commercial à un
  // compte qu'on croit reconnaître.
  //
  // IG4.2 — mais `identity_review` répond à une question plus étroite que celle
  // que cette porte pose. Produit par le rail de découverte (0009), il dit si
  // l'identité LÉGALE de l'entreprise a été rapprochée automatiquement : SIREN,
  // SIRET, adresse. La porte, elle, demande seulement « ce compte Instagram
  // appartient-il au prospect commercial visé ? » — une question de provenance
  // de CANAL, à laquelle un site officiel qui publie lui-même un lien vers son
  // compte répond parfaitement, sans rien dire d'un registre légal.
  //
  // Deux chemins la satisfont donc, et un seul suffit :
  //
  //   * la provenance automatique — `identity_review = confirmed`, figé au lock ;
  //   * une décision humaine durable portant sur CE prospect, CE transport et
  //     CE destinataire exact (`channel_identity_decisions`, IG4.2).
  //
  // Ce que le second chemin ne fait pas : promouvoir `identity_review`. La
  // vérité automatique reste `manual_review` dans `prospects`, dans le
  // manifeste et dans `envelope.identityStatus` — le refus ci-dessous continue
  // d'ailleurs à la citer telle quelle. Deux faits coexistent ; aucun n'a
  // réécrit l'autre.
  //
  // Et il ne dispense de RIEN d'autre : la porte suivante (payload) et les
  // précédentes (manifeste, transport, opt-out, ICP) sont évaluées exactement
  // comme avant, tout comme l'ordonnanceur, les plafonds, le cooldown, le
  // canari et l'arrêt global, qui vivent en aval de ce module.
  const humanChannelIdentity = await loadEffectiveChannelIdentityDecision(sql, {
    prospectId: envelope.prospectId,
    transport: envelope.transport,
    recipient: envelope.recipient,
  });

  // Un REFUS humain prime sur la provenance automatique, et l'ordre de ces deux
  // tests est le seul endroit où cela se décide. Un humain qui a regardé le
  // compte et écrit « ce n'est pas leur compte » en sait plus que le
  // rapprochement qui avait conclu `confirmed` : laisser l'automatique passer
  // par-dessus serait ouvrir la porte que ce rail existe pour tenir fermée.
  // INELIGIBLE et non REVIEW_REQUIRED — la question a été posée à un humain, et
  // il a répondu ; il n'y a plus rien à examiner.
  if (humanChannelIdentity?.decision === 'REJECTED') {
    return refuse(
      'INELIGIBLE',
      'identity_provenance',
      'identity_provenance_missing',
      'IG_CHANNEL_IDENTITY_REJECTED',
      `${humanChannelIdentity.decidedBy} a explicitement refusé le rapprochement entre ce prospect et ` +
        `@${envelope.recipient} le ${humanChannelIdentity.decidedAt} : ${humanChannelIdentity.reason}`,
      context,
    );
  }

  if (envelope.identityStatus !== 'confirmed' && humanChannelIdentity === null) {
    return refuse(
      'REVIEW_REQUIRED',
      'identity_provenance',
      'identity_provenance_missing',
      'IG_IDENTITY_REVIEW_PENDING',
      `l'identité du compte @${envelope.recipient} est au statut « ${envelope.identityStatus} » et aucune ` +
        'confirmation humaine de canal ne porte sur ce destinataire — un premier contact commercial demande ' +
        'une identité confirmée, pas ressemblante. Un humain qui a établi la provenance du compte l\'inscrit ' +
        'avec « npm run ig:identity -- --confirm »',
      context,
    );
  }
  pass(
    'identity_provenance',
    humanChannelIdentity === null
      ? 'identité confirmée au verrouillage'
      : `canal confirmé humainement par ${humanChannelIdentity.decidedBy} le ${humanChannelIdentity.decidedAt} ` +
        `(identité automatique : « ${envelope.identityStatus} », inchangée)`,
  );

  // ---- 9. Le payload est-il complet et figé ? ------------------------------
  const readiness = getLiveReadiness(envelope);
  if (!readiness.ready) {
    return refuse(
      'REVIEW_REQUIRED',
      'payload',
      'payload_unavailable',
      'IG_PAYLOAD_NOT_READY',
      `le payload transport est incomplet (manque : ${readiness.missing.join(', ')})`,
      context,
    );
  }
  pass('payload', 'payload complet et empreinte vérifiée');


  // ---- 4/5. Ce prospect a-t-il déjà été joint sur Instagram ? --------------
  //
  // `outreach_events` est LA table canonique du « un humain a été joint »
  // (0023). Un DRY-RUN n'y écrit jamais, donc cette lecture ne peut pas être
  // polluée par une simple vérification — c'est ce qui la rend utilisable comme
  // garde et non comme indice.
  const contacted = await sql.query<{ occurredAt: string; manifestId: string | null }>(
    `select occurred_at as "occurredAt", manifest_id as "manifestId"
       from outreach_events
      where prospect_id = $1 and channel = 'instagram_dm'
      order by occurred_at desc limit 1`,
    [envelope.prospectId],
  );
  const already = contacted[0];
  if (already) {
    return refuse(
      'INELIGIBLE',
      'already_contacted',
      'already_contacted',
      'IG_ALREADY_CONTACTED',
      `ce prospect a déjà été joint sur Instagram le ${already.occurredAt}` +
        (already.manifestId === null ? '' : ` (manifeste ${already.manifestId})`),
      context,
    );
  }

  // La même question, posée au GROUPE. `already` ci-dessus ne voit que la ligne
  // interrogée ; ici on regarde toutes les preuves d'un effet RÉEL sur ce
  // commerce, quelle que soit la ligne et quelle que soit la campagne :
  // `outreach_events`, mais aussi un job Instagram `SENT` ou `DELIVERY_FAILED`
  // — ce dernier compte, parce qu'une adjudication humaine a constaté qu'une
  // tentative réelle avait eu lieu, et qu'une tentative réelle a pu laisser une
  // trace côté prospect. C'est précisément le cas `@demo_prospect_a`.
  const sameChannel = contactsOnChannel(history, 'instagram_dm').filter((contact) => !contact.isSelf);
  const previous = sameChannel[sameChannel.length - 1];
  if (previous) {
    const member = history.group.members.find((m) => m.prospectId === previous.prospectId);
    const link = member?.linkedBy.map(describeLink).join(' + ') ?? 'identité partagée';
    return refuse(
      'INELIGIBLE',
      'already_contacted',
      'already_contacted',
      'IG_IDENTITY_ALREADY_CONTACTED',
      `ce commerce a déjà été joint sur Instagram le ${previous.occurredAt} ` +
        `(${previous.source} ${previous.reference}, statut « ${previous.status} ») sous une AUTRE ligne : ` +
        `${member?.displayName ?? previous.prospectId} (${previous.prospectId}, campagne ` +
        `${member?.campaignSlug ?? '—'}), reliée par ${link}. La ligne courante affiche zéro contact, ` +
        `ce qui est vrai d'elle et faux du commerce — un second DM demande une nouvelle décision humaine`,
      context,
    );
  }

  // Les autres canaux ne bloquent pas : un e-mail envoyé à ce commerce n'ouvre
  // ni ne ferme la conversation Instagram. Ils sont NOMMÉS dans le journal des
  // portes, pour qu'un opérateur ne découvre pas leur existence après coup.
  const otherChannels = contactsOnOtherChannels(history, 'instagram_dm');
  pass(
    'already_contacted',
    otherChannels.length === 0
      ? `aucun contact Instagram sur les ${String(history.group.members.length)} ligne(s) de cette identité`
      : `aucun contact Instagram sur les ${String(history.group.members.length)} ligne(s) de cette identité ; ` +
        `${String(otherChannels.length)} contact(s) sur un AUTRE canal : ` +
        otherChannels.map((c) => `${c.channel} le ${c.occurredAt}`).join(', '),
  );

  // ---- 6. Une autre intention est-elle déjà en cours pour ce prospect ? ----
  //
  // Le manifeste lui-même est protégé par `ig_dispatch_jobs_one_per_intent`
  // (0029) : deux jobs pour le même manifeste sont impossibles. Ce que cette
  // porte ajoute, c'est la protection du PROSPECT — deux manifestes distincts,
  // sur deux items distincts, viseraient le même compte Instagram. La contrainte
  // d'unicité ne les verrait pas ; un opérateur non plus, tant qu'il ne
  // comparerait pas les handles.
  //
  // Un job terminal ne compte pas comme « en cours », à une exception près :
  // `SENT` et `DELIVERY_FAILED` prouvent qu'un effet a déjà eu lieu sur ce
  // prospect, et ceux-là interdisent tout nouvel enfilement.
  const siblings = await sql.query<{ id: string; status: string; manifestId: string }>(
    `select id, status, manifest_id as "manifestId"
       from ig_dispatch_jobs
      where prospect_id = $1 and manifest_id <> $2
      order by created_at desc`,
    [envelope.prospectId, envelope.manifestId],
  );
  const effectful = siblings.find((job) => job.status === 'SENT' || job.status === 'DELIVERY_FAILED');
  if (effectful) {
    return refuse(
      'INELIGIBLE',
      'concurrent_intent',
      'already_contacted',
      'IG_PROSPECT_ALREADY_ATTEMPTED',
      `le job ${effectful.id} (manifeste ${effectful.manifestId}) porte déjà l'état « ${effectful.status} » ` +
        'pour ce prospect — un second message ne part pas sans une nouvelle décision humaine',
      context,
    );
  }
  const active = siblings.find((job) => !TERMINAL_JOB_STATUSES.includes(job.status as never));
  if (active) {
    return refuse(
      'INELIGIBLE',
      'concurrent_intent',
      'duplicate',
      'IG_CONCURRENT_INTENT',
      `le job ${active.id} (manifeste ${active.manifestId}, statut « ${active.status} ») est déjà actif ` +
        'pour ce prospect — une intention à la fois',
      context,
    );
  }

  // Et la même, une dernière fois, pour le groupe : deux lignes du même commerce
  // dans deux campagnes, chacune avec son manifeste, chacune avec son job. Ni
  // `ig_dispatch_jobs_one_per_intent` (qui protège le manifeste) ni la porte
  // ci-dessus (qui protège la ligne) ne les verraient.
  const groupIntent = history.activeIntents.find(
    (intent) => !intent.isSelf && intent.manifestId !== envelope.manifestId,
  );
  if (groupIntent) {
    const member = history.group.members.find((m) => m.prospectId === groupIntent.prospectId);
    return refuse(
      'INELIGIBLE',
      'concurrent_intent',
      'duplicate',
      'IG_IDENTITY_CONCURRENT_INTENT',
      `le job ${groupIntent.jobId} (manifeste ${groupIntent.manifestId}, statut « ${groupIntent.status} ») est ` +
        `déjà actif pour ${member?.displayName ?? groupIntent.prospectId} (${groupIntent.prospectId}, campagne ` +
        `${member?.campaignSlug ?? '—'}), qui est le MÊME commerce — une intention à la fois par commerce, ` +
        `pas par ligne`,
      context,
    );
  }
  pass(
    'concurrent_intent',
    `${String(siblings.length)} job(s) frère(s) sur cette ligne et ` +
      `${String(history.activeIntents.filter((i) => !i.isSelf).length)} sur les autres lignes de cette identité, ` +
      'aucun actif ni abouti',
  );

  return {
    verdict: 'ELIGIBLE',
    reason: null,
    reasonCode: 'IG_ELIGIBLE',
    detail: `@${envelope.recipient} — dix portes franchies, aucune ne refuse`,
    gates: Object.freeze([...gates]),
    ...context,
  };
}
