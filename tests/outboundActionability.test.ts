import { describe, expect, it } from 'vitest';
import { loadCommercialIntelligenceProfile } from '@/lib/config/load';
import {
  assessChannelFits,
  selectChannel,
  type ChannelFit,
  type ChannelSelection,
} from '@/lib/pipeline/channelFit';
import { emailShape, readCommercialFacts, type ObservedContact } from '@/lib/pipeline/commercialSignals';
import {
  assessOutboundActionability,
  modelWouldAct,
  OUTBOUND_ACTIONABILITY_VALUES,
  type OutboundActionability,
  type OutboundActionabilityInput,
} from '@/lib/pipeline/outboundActionability';
import type { CommercialDecision } from '@/lib/pipeline/commercialIntelligence';
import type { EvidenceLike } from '@/lib/pipeline/score';

/**
 * R7.3B §3–§6 — « intéressant » et « joignable » sont deux questions.
 *
 * Le cas qui gouverne ce fichier est `ESTHETIC CAR ATELIER` : 83 de priorité
 * commerciale, aucun canal joignable. R7.3 le comptait comme une erreur de
 * jugement ; il n'y avait aucune erreur de jugement. Les deux propriétés
 * centrales testées ici en découlent :
 *
 *   1. l'actionabilité ne touche JAMAIS la priorité — elle ne reçoit même pas de
 *      quoi la modifier, et le test le vérifie sur l'objet rendu ;
 *   2. « aucun canal retenu » ne peut jamais rendre `ACTIONABLE`, et la raison
 *      publiée doit distinguer « nous ne voulons pas » de « nous ne savons pas ».
 */

const profile = loadCommercialIntelligenceProfile();

let seq = 0;
function evidence(field: string, valueText: string | null, valueJson: unknown = null): EvidenceLike & { id: string } {
  seq += 1;
  return { id: `e${seq}`, field, value_text: valueText, value_json: valueJson, provider: 'website', source_url: null };
}

function crawl(observed: readonly string[], notObserved: readonly string[]): (EvidenceLike & { id: string })[] {
  return [
    evidence('funnel_observed', observed.map((key) => `${key}: vu`).join(' | ')),
    evidence('funnel_not_observed', 'cherchés et non observés', {
      notObserved: [...notObserved],
      pagesAnalysed: ['https://x.fr/'],
      meaning: 'not_observed_on_crawled_pages',
    }),
  ];
}

function contact(overrides: Partial<ObservedContact> = {}): ObservedContact {
  return {
    email: null,
    phone: null,
    instagramHandle: null,
    facebookUrl: null,
    websiteUrl: 'https://x.fr',
    domain: 'x.fr',
    ...overrides,
  };
}

function fits(
  contactInput: ObservedContact,
  rows: readonly (EvidenceLike & { id: string })[],
  identityCorroborated: boolean | null = true,
): ChannelFit[] {
  return assessChannelFits({
    contact: contactInput,
    facts: readCommercialFacts(rows),
    email: emailShape(contactInput.email, contactInput.domain),
    profile,
    identityCorroborated,
  });
}

/** Le parcours réel : des faits, une sélection de canal, puis un verdict d'exécution. */
function actionability(options: {
  readonly contact?: ObservedContact;
  readonly rows?: readonly (EvidenceLike & { id: string })[];
  readonly decision?: CommercialDecision;
  readonly priority?: number | null;
  readonly icpVerdict?: OutboundActionabilityInput['intelligence']['icpVerdict'];
  readonly identityCorroborated?: boolean | null;
  readonly icpLockRefusal?: OutboundActionabilityInput['identity']['icpLockRefusal'];
  readonly suppression?: OutboundActionabilityInput['suppression'];
}): { readonly result: ReturnType<typeof assessOutboundActionability>; readonly selection: ChannelSelection } {
  const contactInput = options.contact ?? contact();
  const rows = options.rows ?? crawl(['cta_email', 'form_contact'], ['cta_instagram', 'booking_online']);
  const decision = options.decision ?? 'PRIORITIZE';
  // `??` confondrait `null` — « la question n'a pas pu être tranchée » — avec
  // « non fourni », c'est-à-dire exactement la distinction que ces tests visent.
  const corroborated = options.identityCorroborated === undefined ? true : options.identityCorroborated;
  const list = fits(contactInput, rows, corroborated);
  const selection = selectChannel(list, decision, profile);
  return {
    selection,
    result: assessOutboundActionability({
      intelligence: {
        decision,
        commercialPriority: options.priority === undefined ? 70 : options.priority,
        icpVerdict: options.icpVerdict ?? 'GOOD_ICP',
      },
      selection,
      identity: {
        instagramCorroborated: corroborated,
        icpLockRefusal: options.icpLockRefusal ?? null,
      },
      suppression: options.suppression ?? null,
      profile,
    }),
  };
}

// ---------------------------------------------------------------------------
// §4 / §6 — le cas ESTHETIC CAR ATELIER
// ---------------------------------------------------------------------------

describe('un prospect intéressant qu’on ne sait pas joindre n’est pas un mauvais prospect', () => {
  it('priorité haute + aucun canal → priorité intacte, exécution bloquée, collecte HAUTE', () => {
    const { result } = actionability({ contact: contact(), rows: crawl([], ['cta_email', 'cta_instagram']), priority: 83 });

    expect(result.actionability).toBe('BLOCKED_NO_SELECTABLE_CHANNEL');
    expect(result.actionable).toBe(false);
    expect(result.channel).toBeNull();
    expect(result.enrichmentPriority).toBe('HIGH');
    expect(result.unblockableByCollection).toBe(true);
    expect(result.enrichmentTargets).toContain('email_identifier');
    expect(result.enrichmentTargets).toContain('instagram_identifier');
  });

  /**
   * La garantie la plus importante du round, et elle est STRUCTURELLE : le
   * résultat d'actionabilité ne porte aucun champ de priorité. Il ne peut donc
   * pas la baisser, même par erreur d'un futur refactor — il faudrait d'abord
   * inventer le champ.
   */
  it('le verdict d’exécution ne porte aucun champ capable de modifier la priorité', () => {
    const { result } = actionability({ priority: 83, rows: crawl([], ['cta_email', 'cta_instagram']) });
    expect(Object.keys(result)).not.toContain('commercialPriority');
    expect(Object.keys(result)).not.toContain('priority');
  });

  it('une priorité basse avec un canal parfait ne devient jamais une priorité haute', () => {
    const { result } = actionability({
      contact: contact({ email: 'contact@x.fr' }),
      rows: crawl(['cta_email', 'form_quote', 'form_contact'], ['cta_instagram']),
      decision: 'DEPRIORITIZE',
      priority: 12,
    });

    // L'exécution refuse, et pour la BONNE raison : le jugement, pas le canal.
    expect(result.actionability).toBe('BLOCKED_NOT_PRIORITIZED');
    expect(result.enrichmentPriority).toBe('LOW');
    // Et le canal reste lisible : « nous saurions, nous ne voulons pas ».
    expect(result.reachableChannels).toContain('email');
    expect(result.reason).toContain('serait pourtant joignable');
  });
});

// ---------------------------------------------------------------------------
// §4 — la règle structurelle
// ---------------------------------------------------------------------------

describe('aucun canal retenu ⇒ jamais ACTIONABLE', () => {
  it('quelle que soit la décision commerciale, un prospect sans canal n’est pas actionnable', () => {
    const decisions: CommercialDecision[] = [
      'PRIORITIZE',
      'CONSIDER',
      'DEPRIORITIZE',
      'DO_NOT_PRIORITIZE',
      'INSUFFICIENT_EVIDENCE',
    ];
    for (const decision of decisions) {
      const { result } = actionability({
        decision,
        rows: crawl([], ['cta_email', 'cta_instagram']),
        priority: decision === 'INSUFFICIENT_EVIDENCE' ? null : 83,
      });
      expect(result.actionability).not.toBe('ACTIONABLE');
      expect(result.actionable).toBe(false);
    }
  });

  it('un téléphone seul ne rend pas joignable — aucun rail d’appel n’existe', () => {
    const { result, selection } = actionability({
      contact: contact({ phone: '+33478000000' }),
      rows: crawl(['cta_phone'], ['cta_email', 'cta_instagram', 'form_quote', 'booking_online', 'form_contact']),
      priority: 60,
    });

    expect(selection.eligible).toEqual([]);
    expect(result.actionability).toBe('BLOCKED_NO_SELECTABLE_CHANNEL');
    // Et la collecte ne réclame pas un numéro : elle réclame ce qui serait utilisable.
    expect(result.enrichmentTargets).not.toContain('phone_identifier');
  });
});

describe('les canaux qui ont un rail deviennent, eux, actionnables', () => {
  it('un email professionnel publié rend le premier contact possible', () => {
    const { result } = actionability({
      contact: contact({ email: 'contact@x.fr' }),
      rows: crawl(['cta_email', 'form_quote', 'form_contact'], ['cta_instagram']),
      priority: 70,
    });
    expect(result.actionability).toBe('ACTIONABLE');
    expect(result.channel).toBe('email');
    expect(result.enrichmentPriority).toBe('NONE');
    expect(result.enrichmentTargets).toEqual([]);
  });

  it('un compte Instagram corroboré et lié depuis le site rend le premier contact possible', () => {
    const { result } = actionability({
      contact: contact({ instagramHandle: 'artisan_lyon' }),
      rows: crawl(['cta_instagram'], ['cta_email', 'form_quote', 'booking_online', 'form_contact']),
      priority: 70,
      identityCorroborated: true,
    });
    expect(result.actionability).toBe('ACTIONABLE');
    expect(result.channel).toBe('instagram');
  });
});

// ---------------------------------------------------------------------------
// §19 — l'identité inconnue échoue fermée
// ---------------------------------------------------------------------------

describe('ne pas savoir à qui l’on écrirait ferme la porte', () => {
  it('un Instagram retenu dont la corroboration est INCONNUE bloque sur l’identité', () => {
    const { result } = actionability({
      contact: contact({ instagramHandle: 'artisan_lyon' }),
      rows: crawl(['cta_instagram'], ['cta_email', 'form_quote', 'booking_online', 'form_contact']),
      priority: 70,
      identityCorroborated: null,
    });
    expect(result.actionability).toBe('BLOCKED_IDENTITY');
    expect(result.reason).toContain('ne pas savoir n’est pas savoir que oui');
    expect(result.enrichmentTargets).toContain('instagram_identity_corroboration');
  });

  it('un signal ICP fort isolé bloque l’exécution sans rien dire du jugement commercial', () => {
    const { result } = actionability({
      contact: contact({ email: 'contact@x.fr' }),
      rows: crawl(['cta_email', 'form_quote', 'form_contact'], ['cta_instagram']),
      priority: 70,
      icpLockRefusal: 'icp_review_required',
    });
    expect(result.actionability).toBe('BLOCKED_IDENTITY');
    expect(result.enrichmentTargets).toContain('business_type_evidence');
    // Le canal reste techniquement joignable : c'est l'identité qui refuse.
    expect(result.reachableChannels).toContain('email');
  });
});

// ---------------------------------------------------------------------------
// L'ordre des portes
// ---------------------------------------------------------------------------

describe('l’ordre des portes est le contrat', () => {
  it('une suppression passe avant tout, y compris avant une priorité maximale', () => {
    const { result } = actionability({
      contact: contact({ email: 'contact@x.fr' }),
      rows: crawl(['cta_email', 'form_quote', 'form_contact'], ['cta_instagram']),
      priority: 100,
      suppression: { matchKind: 'email', value: 'contact@x.fr', reason: 'demande explicite' },
    });
    expect(result.actionability).toBe('BLOCKED_SUPPRESSION');
    // Aucune collecte ne lève une demande de ne plus être contacté.
    expect(result.unblockableByCollection).toBe(false);
    expect(result.enrichmentPriority).toBe('NONE');
    expect(result.enrichmentTargets).toEqual([]);
  });

  it('un verdict ICP hors cible bloque par POLITIQUE, et aucune collecte ne le lève', () => {
    const { result } = actionability({
      contact: contact({ email: 'contact@x.fr' }),
      rows: crawl(['cta_email', 'form_contact'], ['cta_instagram']),
      decision: 'DO_NOT_PRIORITIZE',
      priority: 0,
      icpVerdict: 'NOT_TARGET',
    });
    expect(result.actionability).toBe('BLOCKED_POLICY');
    expect(result.unblockableByCollection).toBe(false);
    expect(result.enrichmentPriority).toBe('NONE');
  });

  /**
   * `selectChannel` rend déjà `null` quand la décision est négative. Juger le
   * canal AVANT la décision ferait donc dire « aucun canal » à un prospect
   * parfaitement joignable — et le compteur de cibles de collecte se remplirait
   * de prospects qui n'ont besoin d'aucune collecte.
   */
  it('la décision commerciale est jugée avant le canal, sinon le compteur de collecte mentirait', () => {
    const { result } = actionability({
      contact: contact({ email: 'contact@x.fr' }),
      rows: crawl(['cta_email', 'form_quote', 'form_contact'], ['cta_instagram']),
      decision: 'DEPRIORITIZE',
      priority: 12,
    });
    expect(result.actionability).toBe('BLOCKED_NOT_PRIORITIZED');
    expect(result.actionability).not.toBe('BLOCKED_NO_SELECTABLE_CHANNEL');
  });

  it('l’absence de preuve est une abstention, jamais un refus', () => {
    const { result } = actionability({
      decision: 'INSUFFICIENT_EVIDENCE',
      priority: null,
      rows: [],
    });
    expect(result.actionability).toBe('BLOCKED_INSUFFICIENT_EVIDENCE');
    expect(modelWouldAct(result.actionability)).toBeNull();
    expect(result.enrichmentTargets).toEqual(['website_read']);
    // Priorité inconnue : la collecte vaut MOYEN, jamais HAUT — on n'affirme pas
    // une valeur que personne n'a mesurée.
    expect(result.enrichmentPriority).toBe('MEDIUM');
  });
});

describe('« ne sait pas » n’est ni un oui ni un non', () => {
  it('modelWouldAct rend null sur la seule abstention, et un booléen partout ailleurs', () => {
    for (const value of OUTBOUND_ACTIONABILITY_VALUES) {
      const expected = value === 'BLOCKED_INSUFFICIENT_EVIDENCE' ? null : value === 'ACTIONABLE';
      expect(modelWouldAct(value)).toBe(expected);
    }
  });

  it('ACTIONABLE est le seul verdict qui autorise un premier contact', () => {
    const positives = OUTBOUND_ACTIONABILITY_VALUES.filter(
      (value: OutboundActionability) => modelWouldAct(value) === true,
    );
    expect(positives).toEqual(['ACTIONABLE']);
  });
});

describe('déterminisme', () => {
  it('mêmes entrées, même verdict — deux fois de suite', () => {
    const build = (): ReturnType<typeof assessOutboundActionability> =>
      actionability({
        contact: contact({ email: 'contact@x.fr', instagramHandle: 'artisan_lyon' }),
        rows: crawl(['cta_email', 'cta_instagram', 'form_quote'], ['booking_online']),
        priority: 61,
      }).result;
    expect(build()).toEqual(build());
  });
});
