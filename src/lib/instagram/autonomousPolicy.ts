import type { AudienceScaleBand } from '@/lib/pipeline/scalableOpportunity';
import type { CoreServiceFitVerdict } from '@/lib/pipeline/coreServiceFit';
import type { ServiceScopeVerdict } from '@/lib/pipeline/serviceScope';
import type { MarketScopeVerdict } from '@/lib/pipeline/marketScope';
import type { InstagramSkipReason } from '@/lib/instagram/types';

/**
 * HERMES-AUTONOMOUS-R1 — « plus de review humaine prospect par prospect ».
 *
 * ---------------------------------------------------------------------------
 * Ce que cette décision change, et ce qu'elle NE change pas
 * ---------------------------------------------------------------------------
 * Jusqu'ici, un prospect dont un fait manquait tombait en `REVIEW_REQUIRED` et
 * attendait un humain. Le produit a tranché le 21 août 2026 : plus personne ne
 * relit les prospects un par un. Ce module est l'endroit où cette décision
 * devient du code.
 *
 * La tentation évidente — et le seul vrai danger — serait de lire « plus de
 * review » comme « laisse passer ce dont on n'est pas sûr ». C'est l'exact
 * contraire de ce qui est écrit ici. Supprimer la review ne supprime pas le
 * doute : elle supprime seulement l'humain qui l'arbitrait. Le doute doit donc
 * se résoudre dans l'autre sens, et sans exception —
 *
 *     ce dont on n'est pas certain n'est pas envoyé.
 *
 * `AUTO_SKIP` remplace `REVIEW_REQUIRED` partout. Aucun prospect incertain
 * n'est envoyé pour éviter une review ; il est écarté, et il pourra revenir
 * tout seul quand une preuve nouvelle lèvera le doute.
 *
 * ---------------------------------------------------------------------------
 * Plus conservateur que le gate historique, sur un point précis
 * ---------------------------------------------------------------------------
 * R7.6-GATE a tranché, et il avait raison, que `UNKNOWN` n'est pas
 * `OUT_OF_SCOPE` : refuser sur une absence d'observation exclurait tout
 * prospect dont personne n'a ouvert le profil. Cette règle reste vraie et n'est
 * pas touchée — `classifyAudienceScale` et `audienceIsOutOfScope` sont
 * inchangés, le seuil de 10 000 est inchangé, et une audience inconnue ne
 * devient JAMAIS `TOO_LARGE` ni `SMALL` ici.
 *
 * Mais « ne ferme pas la porte » et « autorise un envoi automatique » sont deux
 * phrases différentes, et la seconde est plus exigeante. Tant qu'un humain
 * relisait, une audience non mesurée arrivait devant quelqu'un qui pouvait
 * regarder le profil. Sans lui, une absence de mesure deviendrait un
 * laissez-passer silencieux — c'est-à-dire exactement le mécanisme qui a laissé
 * @demo_account_09 (20 179 abonnés) entrer dans un batch.
 *
 * Une audience `UNKNOWN` rend donc `AUTO_SKIP_TEMPORARY` : le prospect n'est ni
 * refusé ni jugé, il attend une mesure. La distinction est portée par
 * `reconsiderable`, et elle est le cœur du module : un skip temporaire est une
 * question ouverte, un skip définitif est une réponse.
 */

/**
 * Le vocabulaire de sortie, et le seul.
 *
 * Aucun nouveau score, aucune nouvelle bande, aucune nouvelle file : ce sont
 * quatre ÉTIQUETTES D'ACTION posées sur des faits que d'autres modules ont déjà
 * établis. Les MOTIFS restent ceux d'`InstagramSkipReason`, partagés avec la
 * file et les rapports — deux vocabulaires de refus finiraient par diverger.
 */
/**
 * HERMES-AUTONOMOUS-R2 — l'identifiant de CETTE politique, inscrit dans chaque
 * approbation machine (`r6b_batch_votes.policy_version`, 0047).
 *
 * Il est ici, à côté des règles, et pas dans un fichier de configuration : une
 * version qui se règle sans toucher aux règles finirait par décrire autre chose
 * que ce qui a réellement décidé. Toute modification des portes ci-dessous
 * demande de l'incrémenter — c'est ce qui rend une décision passée rejouable.
 */
export const AUTONOMOUS_POLICY_VERSION = 'hermes-targeting-cleaning-only-r1';

/**
 * HERMES-CLEANING-ONLY-ICP-R1 §5 — pourquoi la version change, et ce que cela
 * referme.
 *
 * TROIS portes ont été ajoutées, et une quatrième a durci sa règle :
 *
 *   * `service_scope` — la PRÉSENCE d'une prestation non-prestation standard écarte,
 *     là où `core_service_fit` mesurait une DOMINANCE. Ce n'est pas un
 *     resserrement de seuil, c'est une autre question ;
 *   * `market_scope` — une ancre observée du marché français est désormais
 *     exigée (§17) ;
 *   * `business_duplicate` — une seule ligne par commerce peut porter une
 *     intention autonome, toutes campagnes confondues (§15).
 *
 * Garder l'ancienne étiquette laisserait des approbations machine rendues sous
 * les règles d'hier couvrir un envoi soumis à celles d'aujourd'hui — c'est-à-dire
 * exactement ce que la traçabilité de `r6b_batch_votes.policy_version` existe
 * pour empêcher. Et le cas est ici concret, pas théorique : quatre jobs
 * approuvés le 22 août 2026 sous `hermes-targeting-r1` visaient des comptes
 * vendant REVENTE, boutique en ligne ou vente de produits.
 *
 * L'effet est immédiat et voulu : `assertAutonomousProvenance` refuse toute
 * approbation dont la `policy_version` diffère, donc TOUTE approbation
 * antérieure. Aucun job en file ne peut partir sur une décision d'avant, et il
 * n'y a rien à migrer — une approbation périmée n'est pas une donnée à
 * corriger, c'est une autorisation qui a expiré. `hermes-targeting-r1` garde en
 * revanche tout son sens pour RELIRE ce qui a été décidé sous elle (§5).
 */
export const AUTONOMOUS_POLICY_SUPERSEDED = 'hermes-targeting-r1';

/**
 * Toutes les étiquettes que cette politique a portées, la plus récente d'abord.
 *
 * Publiée pour les RAPPORTS, jamais pour l'autorisation : `assertAutonomousProvenance`
 * continue de n'accepter QUE `AUTONOMOUS_POLICY_VERSION`. Une liste
 * d'étiquettes acceptées serait exactement le mécanisme qui laisserait une
 * approbation d'hier couvrir un envoi soumis aux règles d'aujourd'hui.
 */
export const AUTONOMOUS_POLICY_LINEAGE: readonly string[] = [
  'hermes-targeting-cleaning-only-r1',
  'hermes-targeting-r1',
  'hermes-autonomous-r2',
];

/**
 * La marge de confiance propre à l'envoi AUTOMATIQUE.
 *
 * Ce seuil ne remplace pas le seuil canonique de l'ICP (10 000, porté par
 * `config/commercial-intelligence/example-shadow-v1.json` et appliqué par
 * `audienceIsOutOfScope`). Il ne le touche pas, ne le lit pas et ne peut pas le
 * déplacer : entre les deux valeurs, le prospect reste DANS le créneau — un
 * humain qui le relit a le droit de lui écrire.
 *
 * Ce qu'il dit est plus étroit : entre 8 000 et 10 000 abonnés attribués, la
 * machine ne s'engage pas seule. La raison n'est pas commerciale, elle est
 * métrologique. Un compteur d'abonnés est une mesure DATÉE, lue une fois, sur
 * un compte qui grandit ; à 300 abonnés du seuil, l'écart entre ce que nous
 * avons lu et ce qui est vrai aujourd'hui suffit à faire basculer le verdict.
 * Tant qu'un humain relisait, il ouvrait le profil et voyait le nombre du jour.
 * Sans lui, cette marge est ce qui tient lieu de second regard.
 */
export const AUTONOMOUS_BORDERLINE_AT_OR_ABOVE = 8000;

export type AutonomousOutcome =
  /** Toutes les portes déterministes sont vertes. Rien n'attend de décision humaine. */
  | 'AUTO_SEND_ELIGIBLE'
  /** Un fait manque. Une preuve nouvelle peut le fournir — le prospect reviendra seul. */
  | 'AUTO_SKIP_TEMPORARY'
  /** Le rapprochement entreprise ↔ compte n'est pas établi. Nommé à part : c'est le doute le plus coûteux. */
  | 'AUTO_SKIP_IDENTITY_UNCERTAIN'
  /** Un fait connu s'y oppose, et aucune nouvelle observation ne le renversera. */
  | 'AUTO_SKIP_TERMINAL';

export interface AutonomousDecision {
  readonly outcome: AutonomousOutcome;
  /** Le motif machine, dans le vocabulaire fermé partagé avec la file. `null` seulement si éligible. */
  readonly reason: InstagramSkipReason | null;
  /** La porte qui a tranché — pour qu'un refus se relise sans reconstituer l'ordre. */
  readonly gate: string;
  readonly detail: string;
  /**
   * Ce prospect peut-il redevenir éligible sans qu'un humain ne décide quoi que
   * ce soit ? `true` ⇒ une preuve nouvelle suffit ; `false` ⇒ la réponse est
   * connue et durable.
   *
   * Distinct de `skipClassOf` volontairement : celui-ci parle du sort d'un JOB
   * déjà en file, celui-là du sort d'un CANDIDAT jamais enfilé. Les deux axes
   * se ressemblent et ne coïncident pas — `review_required` est TERMINAL pour
   * un job (personne ne le repêchera) et reconsidérable pour un candidat (la
   * prochaine passe le réévaluera).
   */
  readonly reconsiderable: boolean;
}

/**
 * Les faits, tels que d'AUTRES modules les ont établis.
 *
 * Aucun champ n'est un jugement : ce sont des lectures. Le module ne sait pas
 * ouvrir un profil, ne lit aucune table et n'appelle aucun LLM — il est pur, et
 * c'est ce qui permet d'éprouver la politique sur des états que les données
 * réelles ne produiront pas de sitôt.
 */
export interface AutonomousFacts {
  // ---- Ce que nous savons du COMMERCE ------------------------------------
  /** Le dernier verdict `prospect_icp_assessments`. `null` = jamais évalué. */
  readonly icpVerdict: 'GOOD_ICP' | 'NOT_TARGET' | 'REVIEW_REQUIRED' | null;
  /** La bande R7.6, calculée par `classifyAudienceScale`. Jamais recalculée ici. */
  readonly audienceBand: AudienceScaleBand;
  /** Le prédicat R7.6 `audienceIsOutOfScope`, évalué par son propriétaire. */
  readonly audienceOutOfScope: boolean;
  /**
   * Le compteur d'abonnés RÉELLEMENT lu, tel quel. `null` = non lu.
   *
   * Jamais estimé, jamais complété, jamais arrondi (CLAUDE.md §2). Il est
   * transporté ici en plus de la bande parce que la marge de confiance R2 se
   * joue à quelques centaines d'abonnés, et qu'une bande ne sait pas dire si
   * l'on est à 8 100 ou à 3 000.
   */
  readonly audienceFollowers: number | null;
  /**
   * Le compteur appartient-il bien à CE commerce (identité corroborée au moment
   * de la lecture) ? `false` ⇒ il ne décrit personne d'identifiable et n'entre
   * dans aucune décision — ni pour ouvrir, ni pour fermer.
   */
  readonly audienceAttributed: boolean;
  /**
   * HERMES-TARGETING-R1 §10 — la prestation qui EST le métier, telle que
   * `assessCoreServiceFit` l'a lue dans le cadre du site.
   *
   * `'UNKNOWN'` couvre trois choses que ce module n'a pas à distinguer : cadre
   * non lu, cadre muet, niche sans vocabulaire déclaré. Toutes trois disent la
   * même chose ici — nous ne savons pas — et §13 en tire la même conséquence.
   */
  readonly coreServiceFit: CoreServiceFitVerdict;
  /**
   * HERMES-CLEANING-ONLY-ICP-R1 §3-§6 — l'offre commerciale, telle que
   * `assessServiceScope` l'a lue dans le cadre ET dans la liste de prestations.
   *
   * Porté À CÔTÉ de `coreServiceFit`, jamais à sa place : les deux répondent à
   * deux questions posées à deux dates, et les décisions rendues sous
   * `hermes-targeting-r1` doivent rester relisibles sous la règle qui les a
   * rendues (§5). Seul celui-ci décide en mode autonome.
   */
  readonly serviceScope: ServiceScopeVerdict;
  /**
   * §17 — ce commerce est-il seulement sur notre marché ?
   *
   * `IN_MARKET` demande une ancre POSITIVE observée (SIREN, code postal
   * français, TLD français). `UNKNOWN` n'est pas « hors marché » : c'est
   * l'aveu qu'aucune ancre n'a été lue, et il se rouvre.
   */
  readonly marketScope: MarketScopeVerdict;
  /** L'état pipeline du prospect (`prospects.stage`). */
  readonly prospectStage: string;

  // ---- Ce que nous savons du COMPTE --------------------------------------
  readonly instagramHandle: string | null;
  /** Le canal `instagram` a-t-il été OBSERVÉ à la génération du batch ? */
  readonly instagramChannelObserved: boolean;
  /**
   * §16 — le « handle » est-il en réalité le DOMAINE de ce commerce ?
   *
   * Le corpus en porte un cas : `SARL PURE ATELIER` a
   * `instagram_handle = 'demo-70-exemple.fr'` et `domain = 'demo-70-exemple.fr'`. Un extracteur a
   * pris l'un pour l'autre, et rien en aval ne pouvait s'en apercevoir — un
   * handle Instagram a le droit de contenir des points (`demo_account_05`
   * en est un vrai), donc aucune règle de forme ne l'aurait attrapé.
   *
   * La règle qui l'attrape est une ÉGALITÉ, pas une forme : ce handle est
   * exactement le domaine de ce commerce. Reconsidérable — une observation qui
   * lit le vrai compte répare la ligne.
   */
  readonly instagramHandleIsOwnDomain: boolean;
  /** L'identité figée : `confirmed` seul vaut provenance automatique. */
  readonly identityReview: 'confirmed' | 'manual_review' | 'uncertain';
  /** Une décision humaine DURABLE portant sur ce prospect, ce transport, ce destinataire. */
  readonly humanChannelIdentity: 'CONFIRMED' | 'REJECTED' | null;

  // ---- Ce que nous savons du MESSAGE -------------------------------------
  /** Longueur du texte qui serait envoyé (vote approuvé, sinon brouillon). */
  readonly approvedTextLength: number;
  /** Nombre de preuves derrière l'accroche. Zéro ⇒ accroche non ancrée. */
  readonly hookEvidenceCount: number;
  /** Drapeaux de garde-fou posés à la génération. Un seul suffit à écarter. */
  readonly guardrailFlagCount: number;

  // ---- Ce qu'un HUMAIN a déjà décidé -------------------------------------
  /**
   * Le dernier vote humain sur cet item, s'il existe.
   *
   * L'ABSENCE de vote n'est PAS une condition de refus — c'est précisément ce
   * que le mode autonome supprime. Mais un `REJECT` est autre chose qu'une
   * absence : c'est un humain qui a regardé ce prospect et a répondu non.
   * L'autonomie consiste à se passer d'une décision humaine, jamais à en
   * renverser une.
   */
  readonly humanVote: 'SEND' | 'EDIT' | 'REJECT' | null;

  // ---- Ce que nous savons du CONTACT DÉJÀ ÉTABLI --------------------------
  /** Un `outreach_event` ou un job abouti, sur CE commerce, toutes lignes confondues. */
  readonly alreadyContactedOnInstagram: boolean;
  /** Une exclusion `do_not_contact`, sur n'importe quelle ligne de cette identité. */
  readonly suppressed: boolean;
  /** Un job non terminal sur une autre ligne du même commerce, ou un autre manifeste. */
  readonly concurrentIntent: boolean;
  /**
   * §14-§15 — combien d'AUTRES lignes `prospects` représentent le même commerce,
   * toutes campagnes confondues.
   *
   * Zéro dans le cas normal. Deux lignes DEMOJULIET partagent
   * `registry_id:484122452` dans deux campagnes, et toutes deux portent
   * `dedupe_status = 'unique'` — ce qui est JUSTE au sens de cette colonne, qui
   * n'a jamais parlé qu'au sein d'une campagne.
   */
  readonly duplicateBusinessRows: number;
  /**
   * Cette ligne est-elle celle que son entité métier désigne pour porter une
   * intention ? Voir `electRepresentative` : stade le plus avancé, puis
   * antériorité, puis identifiant — une règle totale, donc jamais deux
   * gagnants.
   *
   * `true` quand la ligne est seule : un commerce sans doublon est son propre
   * représentant.
   */
  readonly isBusinessRepresentative: boolean;
}

interface Verdict {
  readonly outcome: AutonomousOutcome;
  readonly reason: InstagramSkipReason;
  readonly gate: string;
  readonly detail: string;
  readonly reconsiderable: boolean;
}

const ELIGIBLE_STAGES: readonly string[] = ['message_ready'];

/**
 * La politique autonome, en un seul passage, dans un ordre choisi.
 *
 * L'ordre n'est pas une optimisation : il détermine le MOTIF qu'un prospect
 * portera dans les rapports, et donc ce qu'un humain comprendra six mois plus
 * tard. Les faits DURABLES passent avant les faits RÉPARABLES — un prospect à
 * 20 179 abonnés dont l'identité est aussi incertaine doit se relire
 * « audience_out_of_scope », pas « identité à vérifier », parce que la première
 * réponse restera vraie quand la seconde aura été traitée.
 *
 * Le premier refus gagne, et il n'y a pas de seconde chance plus indulgente en
 * aval : ce module ne rend `AUTO_SEND_ELIGIBLE` que si AUCUNE porte ne refuse.
 */
export function decideAutonomousOutcome(facts: AutonomousFacts): AutonomousDecision {
  const verdict = firstRefusal(facts);
  if (verdict !== null) {
    return {
      outcome: verdict.outcome,
      reason: verdict.reason,
      gate: verdict.gate,
      detail: verdict.detail,
      reconsiderable: verdict.reconsiderable,
    };
  }
  return {
    outcome: 'AUTO_SEND_ELIGIBLE',
    reason: null,
    gate: 'autonomous',
    detail:
      `@${facts.instagramHandle ?? '—'} — toutes les portes déterministes sont vertes, ` +
      'aucune ne demande de décision humaine',
    reconsiderable: false,
  };
}

function firstRefusal(facts: AutonomousFacts): Verdict | null {
  // ---- 1. Une décision humaine explicite CONTRE -----------------------------
  //
  // En tête, et c'est le point de gouvernance du module. Le mode autonome
  // affranchit d'ATTENDRE un humain ; il n'affranchit pas de le CONTREDIRE.
  // Un `REJECT` porte une raison qu'un humain a vue et que les portes
  // suivantes, toutes déterministes, ne savent pas voir.
  if (facts.humanVote === 'REJECT') {
    return {
      outcome: 'AUTO_SKIP_TERMINAL',
      reason: 'review_required',
      gate: 'human_reject',
      detail:
        'un humain a explicitement refusé ce prospect (vote REJECT) — l’autonomie remplace ' +
        'une décision humaine ABSENTE, elle n’en renverse jamais une qui a été prise',
      reconsiderable: false,
    };
  }

  // ---- 2. L'exclusion enregistrée -------------------------------------------
  if (facts.suppressed) {
    return {
      outcome: 'AUTO_SKIP_TERMINAL',
      reason: 'opt_out',
      gate: 'opt_out',
      detail: 'ce commerce figure dans do_not_contact — aucun envoi, quelle que soit la ligne qui le porte',
      reconsiderable: false,
    };
  }

  // ---- 3. Le contact déjà établi --------------------------------------------
  if (facts.alreadyContactedOnInstagram) {
    return {
      outcome: 'AUTO_SKIP_TERMINAL',
      reason: 'already_contacted',
      gate: 'already_contacted',
      detail:
        'ce commerce a déjà été joint sur Instagram — un second message demande une nouvelle ' +
        'décision humaine, que le mode autonome ne prend pas',
      reconsiderable: false,
    };
  }

  // ---- 3 bis. Une AUTRE ligne représente déjà ce commerce -------------------
  //
  // HERMES-CLEANING-ONLY-ICP-R1 §14-§15. Placée juste après le contact établi
  // parce qu'elle répond à la même famille de question — « connaît-on déjà ce
  // commerce ? » — et AVANT tout jugement commercial : évaluer deux fois la
  // même entreprise pour n'en garder qu'une à la fin ferait dépendre le
  // résultat de l'ORDRE d'évaluation.
  //
  // Ce que cette porte ne fait pas : elle ne fusionne rien, ne supprime rien,
  // et ne remplace pas `concurrent_intent` (porte 11) — celle-là parle d'un job
  // EN VOL, celle-ci d'une ligne qui existe. Les deux sont nécessaires : sans
  // la première, deux lignes s'enfileraient l'une après l'autre ; sans la
  // seconde, deux lignes jugées dans la même passe seraient éligibles
  // ensemble, et seule la course déciderait laquelle part.
  if (facts.duplicateBusinessRows > 0 && !facts.isBusinessRepresentative) {
    return {
      outcome: 'AUTO_SKIP_TERMINAL',
      reason: 'duplicate',
      gate: 'business_duplicate',
      detail:
        `${String(facts.duplicateBusinessRows)} autre(s) ligne(s) représentent ce même commerce ` +
        '(clé décisive partagée, toutes campagnes confondues), et ce n’est pas cette ligne-ci que ' +
        'l’entité désigne — une entreprise, une intention',
      reconsiderable: false,
    };
  }

  // ---- 4. L'ICP : quel TYPE d'entreprise ------------------------------------
  if (facts.icpVerdict === 'NOT_TARGET') {
    return {
      outcome: 'AUTO_SKIP_TERMINAL',
      reason: 'icp_not_target',
      gate: 'icp',
      detail: 'verdict ICP « NOT_TARGET » — hors cible commerciale',
      reconsiderable: false,
    };
  }
  if (facts.icpVerdict === null || facts.icpVerdict === 'REVIEW_REQUIRED') {
    // Reconsidérable : `icp:audit` peut trancher plus tard sans qu'un humain
    // n'arbitre quoi que ce soit. Non évalué n'est pas éligible, et ne l'a
    // jamais été (CLAUDE.md §2).
    return {
      outcome: 'AUTO_SKIP_TEMPORARY',
      reason: 'review_required',
      gate: 'icp',
      detail:
        facts.icpVerdict === null
          ? 'aucun verdict ICP n’a jamais été rendu sur ce prospect — non évalué n’est pas éligible'
          : 'verdict ICP « REVIEW_REQUIRED » — le doute n’est pas levé, donc rien ne part',
      reconsiderable: true,
    };
  }

  // ---- 4 bis. L'OFFRE : du prestation standard, et rien d'autre -----------------------
  //
  // HERMES-CLEANING-ONLY-ICP-R1 §3-§7. Placée juste après l'ICP parce qu'elle
  // répond à la même famille de question — « est-ce notre client ? » — et AVANT
  // l'audience parce qu'un atelier qui vend du REVENTE reste hors cible quel que
  // soit son nombre d'abonnés. L'ordre décide du motif qu'un prospect portera
  // dans les rapports, et « vend autre chose que du prestation standard » est une réponse
  // plus durable que « audience non mesurée ».
  //
  // CE QUI A CHANGÉ, ET C'EST TOUTE LA MISSION. `hermes-targeting-r1` mesurait
  // ici une DOMINANCE via `coreServiceFit`, et disait explicitement qu'« un
  // prestataire a le droit de proposer de la boutique en ligne ». Cette phrase est
  // désormais fausse : le produit a tranché le 22 août 2026 que la PRÉSENCE
  // d'une prestation non-prestation standard écarte, même secondaire, même minoritaire.
  //
  // `facts.coreServiceFit` reste transporté et publié — il fait partie du
  // dossier d'un prospect et rend relisibles les décisions d'hier (§5) — mais
  // il ne décide plus rien ici. Une seule règle décide, sans quoi deux règles
  // finiraient par se contredire sur le même prospect.
  //
  // Elle ne lit pas le nombre d'abonnés : « followers >= 1000 → reject » est
  // faux, et rien ici ne le réintroduit par la bande.
  if (facts.serviceScope === 'OUT_OF_SCOPE_SPECIALIST') {
    return {
      outcome: 'AUTO_SKIP_TERMINAL',
      reason: 'service_scope_not_in_scope_only',
      gate: 'service_scope',
      detail:
        'ce commerce déclare une ou plusieurs prestations non-prestation standard (film, boutique en ligne, revente, ' +
        'vitrage, vente de produits, carrosserie, mécanique, formation…) et aucun terme de prestation standard non ' +
        'ambigu — son métier n’est pas celui que nous savons servir',
      reconsiderable: false,
    };
  }
  if (facts.serviceScope === 'MIXED_WITH_OUT_OF_SCOPE') {
    // Le cœur de la décision du 22 août 2026, et le point où cette politique
    // est PLUS stricte que `hermes-targeting-r1`. Celle-là tolérait la
    // boutique en ligne « à côté » du prestation standard et ne refusait que la dominance ;
    // celle-ci refuse la PRÉSENCE. §3 est explicite : « activité secondaire
    // visible = exclusion si elle est commercialisée comme vraie prestation ».
    //
    // TERMINAL, et non temporaire : une entreprise qui vend du REVENTE n'arrête pas
    // d'en vendre parce qu'on repasse demain. Si son offre change réellement,
    // c'est une observation nouvelle qui le dira — et un job déjà refusé ne se
    // rejoue pas de lui-même, il faut une nouvelle intention.
    return {
      outcome: 'AUTO_SKIP_TERMINAL',
      reason: 'service_scope_not_in_scope_only',
      gate: 'service_scope',
      detail:
        'ce commerce fait bien du prestation standard, mais commercialise AUSSI au moins une prestation ' +
        'non-prestation standard — la cible autonome est le prestation standard seul, pas le prestation standard parmi d’autres',
      reconsiderable: false,
    };
  }
  if (facts.serviceScope !== 'IN_SCOPE_ONLY') {
    // `UNKNOWN`, et §6 le dit sans détour : `UNKNOWN != IN_SCOPE_ONLY`.
    // L'absence de preuve de REVENTE n'est pas une preuve que l'entreprise ne fait
    // que du prestation standard. C'est le cas nommé par §4 — « atelier sans détail
    // suffisant ». Reconsidérable : une page relue, et le prospect revient.
    return {
      outcome: 'AUTO_SKIP_TEMPORARY',
      reason: 'review_required',
      gate: 'service_scope',
      detail:
        'l’offre de ce commerce n’a pas été établie — surface non lue, muette, ou ne portant que du ' +
        'vocabulaire ambigu (« atelier », « prestation premium »). Ni un feu vert ni un refus, ' +
        'et une observation ultérieure rouvrira ce prospect',
      reconsiderable: true,
    };
  }

  // ---- 4 ter. Le MARCHÉ : sommes-nous seulement chez nous ? -----------------
  //
  // §17. Placée après l'offre parce qu'un spécialiste du REVENTE reste hors cible
  // où qu'il soit, et avant l'audience parce que le marché ne dépend d'aucune
  // mesure sociale. Elle ne lit PAS `prospects.country` : cette colonne vaut
  // « FR » pour tout le corpus parce qu'elle est écrite en dur à la découverte,
  // et la lire ferait passer une constante pour une preuve (CLAUDE.md §2).
  if (facts.marketScope !== 'IN_MARKET') {
    return {
      outcome: 'AUTO_SKIP_TEMPORARY',
      reason: 'market_scope_unknown',
      gate: 'market_scope',
      detail:
        'aucune ancre observée ne place ce commerce sur le marché français — ni identifiant de ' +
        'registre, ni code postal français, ni domaine sous TLD français. Un envoi automatique ne ' +
        's’engage pas sur une géographie supposée ; une mention légale lue plus tard rouvrira ce prospect',
      reconsiderable: true,
    };
  }

  // ---- 5. La TAILLE : au-delà du seuil, définitivement ----------------------
  //
  // Le prédicat vient de R7.6 (`audienceIsOutOfScope`), évalué par son
  // propriétaire et passé ici tel quel. Rien n'est recalculé, aucun seuil
  // n'est recopié.
  if (facts.audienceOutOfScope) {
    return {
      outcome: 'AUTO_SKIP_TERMINAL',
      reason: 'audience_out_of_scope',
      gate: 'audience_scale',
      detail: 'audience attribuée au-delà du seuil canonique — une entreprise ne redevient pas plus petite',
      reconsiderable: false,
    };
  }

  // ---- 5 bis. La TAILLE : sous le seuil, mais trop près du bord -------------
  //
  // La seule règle de ce module qui n'existe QUE pour le mode automatique, et
  // la seule qui n'ait pas d'équivalent dans le gate historique. Voir
  // `AUTONOMOUS_BORDERLINE_AT_OR_ABOVE` pour le pourquoi.
  //
  // Deux conditions, et les deux sont nécessaires. Le compteur doit être LU —
  // un `null` n'est pas un petit nombre, et il tombe à la porte suivante, qui
  // dit la bonne chose. Il doit être ATTRIBUÉ — un compteur qui n'est pas
  // celui de ce commerce ne ferme aucune porte (CLAUDE.md §2), pas plus qu'il
  // n'en ouvre.
  //
  // TEMPORARY, jamais TERMINAL : l'entreprise n'est pas hors créneau, la mesure
  // est seulement trop proche du bord pour qu'on s'y fie seul. Une observation
  // plus récente tranchera — vers l'éligibilité si le compte est plus petit
  // qu'on ne croyait, vers `audience_out_of_scope` s'il a franchi le seuil.
  if (
    facts.audienceAttributed &&
    facts.audienceFollowers !== null &&
    facts.audienceFollowers >= AUTONOMOUS_BORDERLINE_AT_OR_ABOVE
  ) {
    return {
      outcome: 'AUTO_SKIP_TEMPORARY',
      reason: 'audience_borderline',
      gate: 'audience_scale',
      detail:
        `${String(facts.audienceFollowers)} abonnés attribués — sous le seuil canonique, donc ce ` +
        `commerce reste dans le créneau, mais au-dessus de ${String(AUTONOMOUS_BORDERLINE_AT_OR_ABOVE)} ` +
        'un envoi AUTOMATIQUE ne s’engage pas sur une mesure datée. Une observation plus récente rouvrira ce prospect',
      reconsiderable: true,
    };
  }

  // ---- 6. La TAILLE : non mesurée, donc pas d'envoi automatique -------------
  //
  // Le point où le mode autonome est PLUS strict que le gate historique, et le
  // seul. `UNKNOWN` ne devient ni `TOO_LARGE` ni `SMALL` : il reste inconnu, et
  // un inconnu ne finance pas un envoi automatique. Voir l'en-tête du module.
  if (facts.audienceBand === 'UNKNOWN') {
    return {
      outcome: 'AUTO_SKIP_TEMPORARY',
      reason: 'review_required',
      gate: 'audience_scale',
      detail:
        'audience non mesurée ou compte non attribué — inconnu, ni petit ni grand. Un envoi ' +
        'automatique demande une mesure ; une observation ultérieure rouvrira ce prospect',
      reconsiderable: true,
    };
  }

  // ---- 7. L'état pipeline du prospect ---------------------------------------
  if (!ELIGIBLE_STAGES.includes(facts.prospectStage)) {
    return {
      outcome: 'AUTO_SKIP_TERMINAL',
      reason: 'prospect_inactive',
      gate: 'prospect_stage',
      detail: `le prospect est au stade « ${facts.prospectStage} » — seul « message_ready » alimente un envoi`,
      reconsiderable: false,
    };
  }

  // ---- 8. Le CANAL existe-t-il, et est-il exact ? ---------------------------
  const handle = facts.instagramHandle?.trim() ?? '';
  if (handle === '' || !facts.instagramChannelObserved) {
    return {
      outcome: 'AUTO_SKIP_TEMPORARY',
      reason: 'review_required',
      gate: 'channel',
      detail:
        handle === ''
          ? 'aucun handle Instagram connu pour ce commerce — il n’y a pas de destinataire'
          : 'le canal Instagram n’a pas été observé à la génération du batch — un handle deviné n’est pas un canal',
      reconsiderable: true,
    };
  }
  // §16 — le handle vaut exactement le domaine de ce commerce : ce n'est pas un
  // compte, c'est une confusion d'extracteur. Un handle a le droit de contenir
  // des points, donc seule l'ÉGALITÉ avec le domaine l'établit.
  if (facts.instagramHandleIsOwnDomain) {
    return {
      outcome: 'AUTO_SKIP_TEMPORARY',
      reason: 'review_required',
      gate: 'channel',
      detail:
        `« ${handle} » est exactement le domaine de ce commerce — un extracteur a pris l’un pour ` +
        'l’autre, et rien ne prouve qu’un compte de ce nom existe. Une observation qui lit le vrai ' +
        'compte rouvrira ce prospect',
      reconsiderable: true,
    };
  }

  // ---- 9. L'IDENTITÉ du compte, et le standard qui ne baisse pas ------------
  //
  // Ce qui a changé : ces prospects n'arrivent plus devant un humain à qui l'on
  // demanderait « npm run ig:identity -- --confirm ». Ce qui n'a PAS changé :
  // la barre elle-même. Un premier message commercial demande une identité
  // établie, pas ressemblante — et l'autonomie n'est pas une raison d'envoyer à
  // un compte qu'on croit reconnaître.
  //
  // Deux chemins la satisfont, exactement comme avant : la provenance
  // automatique figée (`confirmed`), ou une décision humaine durable déjà
  // enregistrée sur CE destinataire. Aucun troisième chemin n'a été ouvert pour
  // faire du volume.
  if (facts.humanChannelIdentity === 'REJECTED') {
    return {
      outcome: 'AUTO_SKIP_TERMINAL',
      reason: 'identity_failure',
      gate: 'identity_provenance',
      detail: 'un humain a explicitement refusé le rapprochement entre ce commerce et ce compte',
      reconsiderable: false,
    };
  }
  if (facts.identityReview !== 'confirmed' && facts.humanChannelIdentity !== 'CONFIRMED') {
    return {
      outcome: 'AUTO_SKIP_IDENTITY_UNCERTAIN',
      reason: 'review_required',
      gate: 'identity_provenance',
      detail:
        `l’identité du compte @${handle} est au statut « ${facts.identityReview} » et aucune confirmation ` +
        'humaine de canal ne porte sur ce destinataire — le mode autonome écarte plutôt que de demander',
      reconsiderable: true,
    };
  }

  // ---- 10. Le MESSAGE : prêt, ancré, sans drapeau ---------------------------
  if (facts.guardrailFlagCount > 0) {
    return {
      outcome: 'AUTO_SKIP_TERMINAL',
      reason: 'review_required',
      gate: 'message_guardrail',
      detail:
        `${String(facts.guardrailFlagCount)} drapeau(x) de garde-fou sur ce message — un envoi automatique ` +
        'exige zéro drapeau, et un drapeau se lève par une régénération, pas par une tolérance',
      reconsiderable: false,
    };
  }
  if (facts.approvedTextLength === 0) {
    return {
      outcome: 'AUTO_SKIP_TEMPORARY',
      reason: 'payload_unavailable',
      gate: 'message_ready',
      detail: 'aucun texte approuvé ni brouillon pour ce prospect — il n’y a rien à envoyer',
      reconsiderable: true,
    };
  }
  if (facts.hookEvidenceCount === 0) {
    return {
      outcome: 'AUTO_SKIP_TEMPORARY',
      reason: 'review_required',
      gate: 'hook_grounded',
      detail:
        'l’accroche ne cite aucune preuve — une affirmation sur un commerce doit correspondre à une ' +
        'ligne prospect_evidence (CLAUDE.md §2)',
      reconsiderable: true,
    };
  }

  // ---- 11. Une autre intention déjà en vol ----------------------------------
  if (facts.concurrentIntent) {
    return {
      outcome: 'AUTO_SKIP_TEMPORARY',
      reason: 'duplicate',
      gate: 'concurrent_intent',
      detail: 'une autre intention est déjà active pour ce commerce — une à la fois, par commerce',
      reconsiderable: true,
    };
  }

  return null;
}

/**
 * Le prospect part-il ? La seule question que les appelants ont le droit de
 * poser, et la seule qui autorise une écriture.
 *
 * Écrite comme une égalité stricte à l'unique valeur positive, plutôt que comme
 * une négation des valeurs de refus : ajouter un jour une cinquième issue la
 * rendrait non-envoyante par défaut, ce qui est le sens de fail-closed.
 */
export function isAutoSendEligible(decision: AutonomousDecision): boolean {
  return decision.outcome === 'AUTO_SEND_ELIGIBLE';
}

/** La forme lisible des rapports : `AUTO_SEND_ELIGIBLE`, `AUTO_SKIP_TEMPORARY:review_required`, … */
export function formatAutonomousDecision(decision: AutonomousDecision): string {
  return decision.reason === null ? decision.outcome : `${decision.outcome}:${decision.reason}`;
}
