import { describe, expect, it } from 'vitest';
import {
  AUTONOMOUS_BORDERLINE_AT_OR_ABOVE,
  AUTONOMOUS_POLICY_VERSION,
  decideAutonomousOutcome,
  formatAutonomousDecision,
  isAutoSendEligible,
  type AutonomousFacts,
} from '@/lib/instagram/autonomousPolicy';

/**
 * HERMES-AUTONOMOUS-R1 — la politique autonome, éprouvée sur des états que les
 * données réelles ne produiront pas de sitôt.
 *
 * Ces tests tiennent la garantie dans les DEUX sens, et c'est le seul point qui
 * compte pour un mode sans relecture humaine :
 *
 *   * ce qui PART — un prospect dont chaque fait est certain, et lui seul ;
 *   * ce qui NE PART PAS — chaque forme de doute, prise une par une, chacune
 *     devant écarter à elle seule.
 *
 * Le second groupe est écrit en partant d'un prospect PARFAIT et en abîmant un
 * seul fait à la fois. Un test qui partirait d'un prospect vide prouverait
 * seulement qu'un vide est refusé — pas que CE fait-là est celui qui refuse.
 *
 * Aucun test n'ouvre Instagram, n'écrit en base, ni ne lève un arrêt.
 */

/** Le prospect dont TOUT est certain. La base de comparaison de tout le fichier. */
const CERTAIN: AutonomousFacts = Object.freeze({
  icpVerdict: 'GOOD_ICP',
  audienceBand: 'GROWING',
  audienceOutOfScope: false,
  audienceFollowers: 1749,
  audienceAttributed: true,
  coreServiceFit: 'CORE_FIT',
  serviceScope: 'IN_SCOPE_ONLY',
  marketScope: 'IN_MARKET',
  prospectStage: 'message_ready',
  instagramHandle: 'demo_account_01',
  instagramChannelObserved: true,
  instagramHandleIsOwnDomain: false,
  identityReview: 'confirmed',
  humanChannelIdentity: null,
  approvedTextLength: 316,
  hookEvidenceCount: 3,
  guardrailFlagCount: 0,
  humanVote: null,
  alreadyContactedOnInstagram: false,
  suppressed: false,
  concurrentIntent: false,
  duplicateBusinessRows: 0,
  isBusinessRepresentative: true,
});

function withFacts(patch: Partial<AutonomousFacts>): AutonomousFacts {
  return { ...CERTAIN, ...patch };
}

// ---------------------------------------------------------------------------
// Ce qui PART
// ---------------------------------------------------------------------------

describe('un prospect certain', () => {
  it('est AUTO_SEND_ELIGIBLE, sans qu’aucun humain n’ait voté', () => {
    const decision = decideAutonomousOutcome(CERTAIN);
    expect(decision.outcome).toBe('AUTO_SEND_ELIGIBLE');
    expect(decision.reason).toBeNull();
    expect(isAutoSendEligible(decision)).toBe(true);
    expect(formatAutonomousDecision(decision)).toBe('AUTO_SEND_ELIGIBLE');
  });

  it('l’absence de vote humain n’est PAS une condition de refus', () => {
    // Le cœur de la décision produit : ne plus attendre personne.
    expect(CERTAIN.humanVote).toBeNull();
    expect(isAutoSendEligible(decideAutonomousOutcome(CERTAIN))).toBe(true);
  });

  it('un vote humain SEND ou EDIT déjà présent ne l’empêche pas non plus', () => {
    for (const vote of ['SEND', 'EDIT'] as const) {
      expect(isAutoSendEligible(decideAutonomousOutcome(withFacts({ humanVote: vote })))).toBe(true);
    }
  });

  it('une identité confirmée par un humain vaut la provenance automatique', () => {
    const decision = decideAutonomousOutcome(
      withFacts({ identityReview: 'manual_review', humanChannelIdentity: 'CONFIRMED' }),
    );
    expect(decision.outcome).toBe('AUTO_SEND_ELIGIBLE');
  });
});

// ---------------------------------------------------------------------------
// Ce qui NE PART PAS — un fait abîmé à la fois
// ---------------------------------------------------------------------------

describe('l’identité', () => {
  it('« manual_review » sans confirmation humaine rend AUTO_SKIP_IDENTITY_UNCERTAIN', () => {
    const decision = decideAutonomousOutcome(withFacts({ identityReview: 'manual_review' }));
    expect(decision.outcome).toBe('AUTO_SKIP_IDENTITY_UNCERTAIN');
    expect(decision.gate).toBe('identity_provenance');
    expect(isAutoSendEligible(decision)).toBe(false);
  });

  it('« uncertain » aussi — le standard ne baisse pas pour faire du volume', () => {
    const decision = decideAutonomousOutcome(withFacts({ identityReview: 'uncertain' }));
    expect(decision.outcome).toBe('AUTO_SKIP_IDENTITY_UNCERTAIN');
  });

  it('reste reconsidérable : une preuve nouvelle peut lever le doute', () => {
    expect(decideAutonomousOutcome(withFacts({ identityReview: 'uncertain' })).reconsiderable).toBe(true);
  });

  it('un REFUS humain de canal est définitif, et n’est pas « incertain »', () => {
    const decision = decideAutonomousOutcome(withFacts({ humanChannelIdentity: 'REJECTED' }));
    expect(decision.outcome).toBe('AUTO_SKIP_TERMINAL');
    expect(decision.reason).toBe('identity_failure');
    expect(decision.reconsiderable).toBe(false);
  });
});

describe('l’audience', () => {
  it('inconnue rend AUTO_SKIP_TEMPORARY — jamais un laissez-passer', () => {
    const decision = decideAutonomousOutcome(
      withFacts({ audienceBand: 'UNKNOWN', audienceOutOfScope: false }),
    );
    expect(decision.outcome).toBe('AUTO_SKIP_TEMPORARY');
    expect(decision.gate).toBe('audience_scale');
    expect(decision.reconsiderable).toBe(true);
  });

  it('inconnue ne devient NI trop grande NI petite', () => {
    // R7.6 / CLAUDE.md §2 : ne pas savoir n'est pas savoir le contraire.
    const decision = decideAutonomousOutcome(
      withFacts({ audienceBand: 'UNKNOWN', audienceOutOfScope: false }),
    );
    expect(decision.reason).not.toBe('audience_out_of_scope');
    expect(decision.outcome).not.toBe('AUTO_SKIP_TERMINAL');
  });

  it('au-delà du seuil rend INELIGIBLE définitif', () => {
    const decision = decideAutonomousOutcome(
      withFacts({ audienceBand: 'OUT_OF_SWEET_SPOT', audienceOutOfScope: true }),
    );
    expect(decision.outcome).toBe('AUTO_SKIP_TERMINAL');
    expect(decision.reason).toBe('audience_out_of_scope');
    expect(decision.reconsiderable).toBe(false);
  });
});

describe('l’ICP', () => {
  it('NOT_TARGET est définitif', () => {
    const decision = decideAutonomousOutcome(withFacts({ icpVerdict: 'NOT_TARGET' }));
    expect(decision.outcome).toBe('AUTO_SKIP_TERMINAL');
    expect(decision.reason).toBe('icp_not_target');
  });

  it('REVIEW_REQUIRED devient un AUTO_SKIP, jamais une attente humaine', () => {
    const decision = decideAutonomousOutcome(withFacts({ icpVerdict: 'REVIEW_REQUIRED' }));
    expect(decision.outcome).toBe('AUTO_SKIP_TEMPORARY');
    expect(isAutoSendEligible(decision)).toBe(false);
  });

  it('jamais évalué n’est pas éligible', () => {
    const decision = decideAutonomousOutcome(withFacts({ icpVerdict: null }));
    expect(decision.outcome).toBe('AUTO_SKIP_TEMPORARY');
  });
});

describe('le contact déjà établi', () => {
  it('un commerce déjà joint sur Instagram ne repart pas', () => {
    const decision = decideAutonomousOutcome(withFacts({ alreadyContactedOnInstagram: true }));
    expect(decision.outcome).toBe('AUTO_SKIP_TERMINAL');
    expect(decision.reason).toBe('already_contacted');
  });

  it('une exclusion do_not_contact écarte définitivement', () => {
    const decision = decideAutonomousOutcome(withFacts({ suppressed: true }));
    expect(decision.outcome).toBe('AUTO_SKIP_TERMINAL');
    expect(decision.reason).toBe('opt_out');
  });

  it('une intention concurrente écarte, temporairement', () => {
    const decision = decideAutonomousOutcome(withFacts({ concurrentIntent: true }));
    expect(decision.outcome).toBe('AUTO_SKIP_TEMPORARY');
    expect(decision.reason).toBe('duplicate');
  });
});

describe('le message', () => {
  it('un seul drapeau de garde-fou suffit à écarter', () => {
    const decision = decideAutonomousOutcome(withFacts({ guardrailFlagCount: 1 }));
    expect(decision.outcome).toBe('AUTO_SKIP_TERMINAL');
    expect(decision.gate).toBe('message_guardrail');
  });

  it('un texte vide n’est pas envoyable', () => {
    const decision = decideAutonomousOutcome(withFacts({ approvedTextLength: 0 }));
    expect(isAutoSendEligible(decision)).toBe(false);
    expect(decision.gate).toBe('message_ready');
  });

  it('une accroche sans preuve n’est pas ancrée', () => {
    const decision = decideAutonomousOutcome(withFacts({ hookEvidenceCount: 0 }));
    expect(isAutoSendEligible(decision)).toBe(false);
    expect(decision.gate).toBe('hook_grounded');
  });
});

describe('le canal', () => {
  it('sans handle, il n’y a pas de destinataire', () => {
    const decision = decideAutonomousOutcome(withFacts({ instagramHandle: null }));
    expect(isAutoSendEligible(decision)).toBe(false);
    expect(decision.gate).toBe('channel');
  });

  it('un handle non observé comme canal ne suffit pas', () => {
    const decision = decideAutonomousOutcome(withFacts({ instagramChannelObserved: false }));
    expect(isAutoSendEligible(decision)).toBe(false);
    expect(decision.gate).toBe('channel');
  });
});

describe('l’état du prospect', () => {
  it('un prospect « rejected » ne repart pas', () => {
    const decision = decideAutonomousOutcome(withFacts({ prospectStage: 'rejected' }));
    expect(decision.outcome).toBe('AUTO_SKIP_TERMINAL');
    expect(decision.reason).toBe('prospect_inactive');
  });
});

// ---------------------------------------------------------------------------
// La propriété qui résume tout
// ---------------------------------------------------------------------------

describe('fail-closed', () => {
  it('AUCUN doute pris isolément ne produit un envoi', () => {
    const doubts: Partial<AutonomousFacts>[] = [
      { icpVerdict: null },
      { icpVerdict: 'REVIEW_REQUIRED' },
      { icpVerdict: 'NOT_TARGET' },
      { audienceBand: 'UNKNOWN' },
      { audienceBand: 'OUT_OF_SWEET_SPOT', audienceOutOfScope: true },
      { identityReview: 'manual_review' },
      { identityReview: 'uncertain' },
      { humanChannelIdentity: 'REJECTED' },
      { instagramHandle: null },
      { instagramChannelObserved: false },
      { approvedTextLength: 0 },
      { hookEvidenceCount: 0 },
      { guardrailFlagCount: 1 },
      { alreadyContactedOnInstagram: true },
      { suppressed: true },
      { concurrentIntent: true },
      { prospectStage: 'rejected' },
    ];
    for (const doubt of doubts) {
      const decision = decideAutonomousOutcome(withFacts(doubt));
      expect(isAutoSendEligible(decision), JSON.stringify(doubt)).toBe(false);
      expect(decision.reason, JSON.stringify(doubt)).not.toBeNull();
    }
  });

  it('un prospect n’est envoyé que si TOUS les faits sont certains', () => {
    expect(isAutoSendEligible(decideAutonomousOutcome(CERTAIN))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HERMES-AUTONOMOUS-R2 — la marge de confiance propre à l'envoi automatique
// ---------------------------------------------------------------------------
//
// Ces tests éprouvent la SEULE règle que R2 ajoute à la politique, et ils
// éprouvent d'abord ce qu'elle ne change pas : le seuil canonique de l'ICP.
// Une marge qui déplacerait le seuil serait un changement d'ICP déguisé, et
// c'est précisément ce que la mission interdit.

describe('la marge d’audience de l’envoi automatique (R2)', () => {
  it('le seuil canonique de l’ICP reste 10 000 et n’est PAS déplacé', () => {
    // La règle ICP est portée par `audienceOutOfScope`, calculé ailleurs. Ici
    // on vérifie seulement que la marge R2 vit STRICTEMENT en dessous : elle
    // ajoute une prudence, elle n'élargit ni ne rétrécit le créneau.
    expect(AUTONOMOUS_BORDERLINE_AT_OR_ABOVE).toBe(8000);
    expect(AUTONOMOUS_BORDERLINE_AT_OR_ABOVE).toBeLessThan(10_000);
  });

  it('8975 abonnés attribués → AUTO_SKIP_TEMPORARY:audience_borderline', () => {
    // @latelier.du.atelier37, le cas nommé par la mission : identité
    // confirmée, message prêt, et pourtant trop près du bord pour qu'une
    // machine s'engage seule.
    const decision = decideAutonomousOutcome(
      withFacts({ audienceFollowers: 8975, audienceAttributed: true, audienceBand: 'GROWING' }),
    );
    expect(decision.outcome).toBe('AUTO_SKIP_TEMPORARY');
    expect(decision.reason).toBe('audience_borderline');
    expect(decision.gate).toBe('audience_scale');
    // TEMPORARY veut dire « question ouverte » : une mesure plus récente rouvre.
    expect(decision.reconsiderable).toBe(true);
  });

  it('7999 abonnés poursuivent les autres portes et restent éligibles', () => {
    const decision = decideAutonomousOutcome(
      withFacts({ audienceFollowers: 7999, audienceAttributed: true, audienceBand: 'GROWING' }),
    );
    expect(decision.outcome).toBe('AUTO_SEND_ELIGIBLE');
    expect(isAutoSendEligible(decision)).toBe(true);
  });

  it('exactement 8000 bascule — la borne est INCLUSIVE', () => {
    const decision = decideAutonomousOutcome(
      withFacts({ audienceFollowers: 8000, audienceAttributed: true, audienceBand: 'GROWING' }),
    );
    expect(decision.reason).toBe('audience_borderline');
  });

  it('10000 abonnés hors créneau → TERMINAL audience_out_of_scope, pas borderline', () => {
    // Le refus DURABLE l'emporte sur le refus réparable, et il se nomme
    // autrement : six mois plus tard, « hors créneau » et « trop près du
    // bord » ne se relisent pas de la même façon.
    const decision = decideAutonomousOutcome(
      withFacts({
        audienceFollowers: 10_000,
        audienceAttributed: true,
        audienceBand: 'OUT_OF_SWEET_SPOT',
        audienceOutOfScope: true,
      }),
    );
    expect(decision.outcome).toBe('AUTO_SKIP_TERMINAL');
    expect(decision.reason).toBe('audience_out_of_scope');
    expect(decision.reconsiderable).toBe(false);
  });

  it('une audience inconnue reste TEMPORARY, et ne devient pas borderline', () => {
    const decision = decideAutonomousOutcome(
      withFacts({ audienceBand: 'UNKNOWN', audienceFollowers: null, audienceAttributed: false }),
    );
    expect(decision.outcome).toBe('AUTO_SKIP_TEMPORARY');
    expect(decision.reason).toBe('review_required');
    expect(decision.gate).toBe('audience_scale');
    expect(decision.reconsiderable).toBe(true);
  });

  it('un gros compteur NON ATTRIBUÉ ne ferme aucune porte par lui-même', () => {
    // CLAUDE.md §2 : un compteur qui n'est pas celui de ce commerce ne décrit
    // personne. Il ne doit ni ouvrir ni fermer — c'est la bande `UNKNOWN` qui
    // tranche, et elle dit « on ne sait pas », pas « c'est gros ».
    const decision = decideAutonomousOutcome(
      withFacts({ audienceFollowers: 308_000, audienceAttributed: false, audienceBand: 'UNKNOWN' }),
    );
    expect(decision.reason).toBe('review_required');
    expect(decision.gate).toBe('audience_scale');
  });
});

describe('la version de politique (R2)', () => {
  it('est nommée, non vide, et tient dans la colonne policy_version', () => {
    // 0047 contraint `policy_version` à 1..80 caractères. Une politique dont
    // le nom ne tiendrait pas ferait échouer l'écriture au pire moment.
    expect(AUTONOMOUS_POLICY_VERSION.trim().length).toBeGreaterThan(0);
    expect(AUTONOMOUS_POLICY_VERSION.length).toBeLessThanOrEqual(80);
  });
});

describe('une décision humaine ne se renverse jamais (R2)', () => {
  it('un REJECT humain reste TERMINAL même si TOUT le reste est parfait', () => {
    const decision = decideAutonomousOutcome(withFacts({ humanVote: 'REJECT' }));
    expect(decision.outcome).toBe('AUTO_SKIP_TERMINAL');
    expect(decision.gate).toBe('human_reject');
    expect(decision.reconsiderable).toBe(false);
  });

  it('il l’emporte sur toutes les autres portes — il est évalué en PREMIER', () => {
    // Le motif importe : un prospect refusé par un humain ET par une autre
    // porte doit se relire « un humain a dit non », parce que c'est la réponse
    // qui gouverne.
    const decision = decideAutonomousOutcome(
      withFacts({ humanVote: 'REJECT', suppressed: true, icpVerdict: 'NOT_TARGET', audienceOutOfScope: true }),
    );
    expect(decision.gate).toBe('human_reject');
  });
});
