import { describe, expect, it } from 'vitest';
import {
  FIRST_TOUCH_MAX_CHARS,
  FIRST_TOUCH_MAX_WORDS,
  FIRST_TOUCH_TARGET_WORDS,
  checkFirstTouch,
  observationClaims,
  type FirstTouchCode,
} from '@/lib/pipeline/firstTouchStyle';
import { checkGeneratedMessages, type RawMessageAnswer } from '@/lib/pipeline/message';
import type { FirstTouchPersonalization } from '@/lib/pipeline/firstTouchPersonalization';
import {
  CLAUSES_EXTRACTED_BEFORE,
  FIRST_TOUCH_CLAIM_CORPUS,
} from './fixtures/firstTouchClaimCorpus';

/**
 * FIRST-TOUCH-NATURALNESS-TUNE-R1 — le premier message doit obtenir une
 * RÉPONSE, pas une qualification.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce fichier ajoute à `firstTouchStyle.test.ts`
 * ---------------------------------------------------------------------------
 * L'autre fichier vérifie ce qu'un premier message n'a pas le droit d'être — un
 * audit, un pitch, un appel. Celui-ci vérifie ce qu'il doit pouvoir ÊTRE :
 * une observation, une réaction personnelle, une question légère. Les deux
 * séries répondent à des questions différentes, et les mélanger ferait perdre
 * de vue que la seconde est un ACQUIS mesuré, pas une préférence de style.
 *
 * Aucun de ces tests ne touche la base, le réseau ou un modèle.
 */

const FACTS: readonly string[] = [
  'Prestations affichées : reportage en intérieur, retouche des portraits, tirage sur papier fibre',
  'Intervention à domicile sur l’agglomération',
  'Portrait en lumière naturelle proposé',
];

function blocking(body: string, facts: readonly string[] = FACTS): FirstTouchCode[] {
  return checkFirstTouch({ body, groundedFacts: facts })
    .findings.filter((finding) => finding.severity === 'BLOCKING')
    .map((finding) => finding.code);
}

/**
 * Le corpus de VOIX — trois messages écrits à la main, dans la structure que
 * ce round enseigne : observation → réaction personnelle → question légère.
 *
 * Ils sont SYNTHÉTIQUES, et c'est délibéré. Un message d'exemple porte le
 * marché, le registre et les tournures de celui qui l'a écrit ; cette édition
 * n'en livre aucun, et un opérateur fournit les siens dans
 * `config/operator.json`. Ce que ces trois-là servent à mesurer n'est pas la
 * qualité d'une voix — c'est que la STRUCTURE tienne dans le budget, ce qui
 * est une propriété du code et pas du goût de quelqu'un.
 *
 * Chacun porte ses PROPRES faits : les juger contre une fixture générique
 * mesurerait la fixture, pas la règle.
 */
const VOICE_CORPUS: readonly { key: string; body: string; facts: readonly string[] }[] = [
  {
    key: 'lumiere-naturelle',
    body:
      'Bonjour, j’ai vu que vous travaillez surtout en lumière naturelle, je connaissais mal ' +
      'cette approche. Vous intervenez sur quel secteur ?',
    facts: ['Prestations affichées : portrait en lumière naturelle'],
  },
  {
    key: 'reportage-interieur',
    body:
      'Bonjour, j’ai vu que vous faites du reportage en intérieur, je trouve le rendu plutôt ' +
      'chaleureux. C’est vous qui vous déplacez ou les gens viennent au studio ?',
    facts: ['Prestations affichées : reportage en intérieur'],
  },
  {
    key: 'tirage-papier-fibre',
    body:
      'Bonjour, j’ai vu que vous proposez le tirage sur papier fibre, j’en vois moins souvent ' +
      'qu’avant. Vous travaillez surtout avec des particuliers ?',
    facts: ['Prestations affichées : tirage sur papier fibre'],
  },
];

// ---------------------------------------------------------------------------
// §1 — la structure que le gold set enseigne réellement
// ---------------------------------------------------------------------------

describe('observation → réaction personnelle → question légère', () => {
  /**
   * Le beat du milieu parle de l'EXPÉDITEUR (« je connaissais mal »), jamais du
   * prospect. C'est ce qui le distingue d'une seconde observation : il n'affirme
   * rien de nouveau sur l'entreprise, donc il n'a rien à sourcer.
   */
  const TROIS_TEMPS =
    'Bonjour, j’ai vu que vous faites du portrait en lumière naturelle, je connaissais mal le principe ' +
    'mais je trouve ça plutôt malin. Vous intervenez surtout sur quel secteur ?';

  it('la structure en trois temps passe, et tient dans le budget', () => {
    const report = checkFirstTouch({ body: TROIS_TEMPS, groundedFacts: FACTS });
    expect(report.findings.filter((f) => f.severity === 'BLOCKING')).toEqual([]);
    expect(report.metrics.words).toBeLessThanOrEqual(FIRST_TOUCH_TARGET_WORDS.max);
    expect(report.metrics.chars).toBeLessThanOrEqual(FIRST_TOUCH_MAX_CHARS);
  });

  it('la réaction personnelle n’est PAS comptée comme une seconde observation', () => {
    // Elle parle de celui qui écrit. Une observation de plus déclencherait
    // OVER_PERSONALIZED ; celle-ci ne doit pas.
    const claims = observationClaims(TROIS_TEMPS, FACTS);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.grounded).toBe(true);
  });

  /**
   * Les questions que §2 rend disponibles au premier tour. Aucune ne qualifie
   * l'acquisition : elles se répondent d'un mot, ce qui est tout leur intérêt.
   */
  const QUESTIONS_LÉGÈRES: readonly string[] = [
    'Bonjour, j’ai vu que vous faites du portrait en lumière naturelle, je connaissais mal le principe. Vous intervenez sur quel secteur ?',
    'Bonjour, j’ai vu que vous faites du reportage en intérieur, je trouve le concept plutôt pratique. C’est vous qui vous déplacez ou les gens viennent à vous ?',
    'Bonjour, j’ai vu que vous proposez du tirage sur papier fibre, je vois ça moins souvent qu’avant. Vous travaillez surtout avec des particuliers ?',
  ];

  it('une question simple sur la zone, le fonctionnement ou la clientèle passe', () => {
    for (const body of QUESTIONS_LÉGÈRES) {
      const report = checkFirstTouch({ body, groundedFacts: FACTS });
      expect(report.findings.filter((f) => f.severity === 'BLOCKING'), body).toEqual([]);
    }
  });

  it('les trois ouvertures restent distinctes — la structure n’est pas un gabarit', () => {
    const middles = new Set(QUESTIONS_LÉGÈRES.map((b) => b.split('.')[1]?.trim() ?? ''));
    expect(middles.size).toBe(QUESTIONS_LÉGÈRES.length);
  });
});

// ---------------------------------------------------------------------------
// §2 — la qualification acquisition n'est plus le but du tour 1
// ---------------------------------------------------------------------------

describe('la qualification acquisition appartient au tour 2', () => {
  /**
   * Ce message est celui que la production écrivait réellement le 25 août. Il
   * n'est pas BLOQUÉ — rien dedans n'est faux, et le bloquer ferait de ce round
   * une garde de sécurité qu'il n'est pas. Ce qui a changé est ce que le PROMPT
   * demande : la stratégie, pas la règle.
   *
   * Le test existe pour que la distinction soit écrite quelque part plutôt que
   * supposée : si un jour quelqu'un décide de l'interdire pour de bon, ce test
   * tombera, et ce sera le bon moment pour en discuter.
   */
  const ACQUISITION_TOUR_1 =
    'Bonjour, petite question : aujourd’hui, vos nouveaux clients viennent surtout des ' +
    'recommandations et des réseaux, ou vous avez déjà autre chose qui fonctionne régulièrement ?';

  it('elle reste licite — ce round change la stratégie, pas une garde', () => {
    expect(blocking(ACQUISITION_TOUR_1)).toEqual([]);
  });

  it('le prompt ne la PRESCRIT plus comme la question à poser', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile('src/lib/pipeline/message.ts', 'utf-8'),
    );
    // La ligne qui imposait l'acquisition au premier message.
    expect(source).not.toMatch(/une question posée simplement, sur le fait d’avoir plus de demandes/);
    expect(source).not.toMatch(/une question posée simplement, sur le fait d'avoir plus de demandes/);
  });
});

// ---------------------------------------------------------------------------
// §3 — le budget et le corpus validé ont enfin une intersection
// ---------------------------------------------------------------------------

describe('le budget de longueur', () => {
  it('la cible couvre la structure en trois temps, et pas seulement une question', () => {
    const lengths = VOICE_CORPUS.map((example) => example.body.trim().split(/\s+/u).length);
    expect(Math.max(...lengths)).toBeLessThanOrEqual(FIRST_TOUCH_TARGET_WORDS.max);
  });

  it('le plafond de caractères ne décide plus à la place du plafond de mots', () => {
    // Un DM français coûte ~6,2 caractères par mot. Si le plafond de caractères
    // était plus bas que ce que le plafond de mots autorise, il déciderait seul
    // — c'est exactement le défaut mesuré (260 caractères ≈ 42 mots, pour un
    // plafond annoncé à 48).
    expect(FIRST_TOUCH_MAX_CHARS).toBeGreaterThanOrEqual(Math.round(FIRST_TOUCH_MAX_WORDS * 6.2));
  });

  it('un pavé de 380 caractères qui recommande reste refusé', () => {
    // La forme qu'un premier message prend quand rien ne le borne : trois
    // affirmations, une recommandation non demandée, et une question fermée.
    const PAVE =
      'Bonjour, j’ai vu que vous mettez en avant le tirage grand format et la retouche avancée, avec la possibilité ' +
      'de réserver, d’appeler ou de vous écrire. Une piste serait de distinguer les demandes liées à chaque ' +
      'prestation et à chaque parcours de contact. Cela aiderait à voir lesquels attirent les projets les ' +
      'plus pertinents localement. Est-ce un sujet que vous cherchez déjà à mieux comprendre ?';
    expect(PAVE.length).toBeGreaterThan(FIRST_TOUCH_MAX_CHARS);
    expect(blocking(PAVE)).toContain('TOO_LONG');
  });

  it('le budget n’est pas devenu un permis d’écrire long', () => {
    expect(FIRST_TOUCH_MAX_WORDS).toBe(48);
    expect(FIRST_TOUCH_TARGET_WORDS.max).toBeLessThan(FIRST_TOUCH_MAX_WORDS);
  });
});

// ---------------------------------------------------------------------------
// §4 — une QUESTION n'est pas une prétention factuelle
// ---------------------------------------------------------------------------

describe('observationClaims ne confond plus demander et affirmer', () => {
  it('« vous faites comment pour avoir de nouveaux clients ? » n’affirme rien', () => {
    const body = 'Bonjour, vous faites comment pour avoir de nouveaux clients en ce moment ?';
    expect(observationClaims(body, [])).toEqual([]);
    expect(blocking(body, [])).not.toContain('UNGROUNDED_OBSERVATION');
  });

  it('l’adverbe placé AVANT est traité pareil : « comment vous faites pour… »', () => {
    const body = 'Bonjour, aujourd’hui, comment vous faites pour obtenir de nouveaux clients ?';
    expect(observationClaims(body, [])).toEqual([]);
    expect(blocking(body, [])).not.toContain('UNGROUNDED_OBSERVATION');
  });

  it('« j’ai vu que vous faites du portrait en lumière naturelle » reste une observation à sourcer', () => {
    const body = 'Bonjour, j’ai vu que vous faites du portrait en lumière naturelle. Ça tourne bien pour vous ?';
    const claims = observationClaims(body, []);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.grounded).toBe(false);
    expect(blocking(body, [])).toContain('UNGROUNDED_OBSERVATION');
    // …et elle redevient ancrée dès qu'un fait la porte.
    expect(blocking(body, FACTS)).not.toContain('UNGROUNDED_OBSERVATION');
  });

  it('une phrase interrogative peut porter une observation FACTUELLE, qui reste jugée', () => {
    // Le « ? » de la phrase n'est pas une preuve : la garde regarde le mot
    // interrogatif ADJACENT, et rien d'autre.
    const body = 'Bonjour, j’ai vu que vous couvrez des mariages en montagne, ça tourne bien ?';
    expect(blocking(body, FACTS)).toContain('UNGROUNDED_OBSERVATION');
  });

  it('« ou » sans accent n’est pas « où » — une énumération n’est pas une question', () => {
    const body = 'Bonjour, j’ai vu que vous couvrez des mariages ou des concerts en montagne. Ça tourne bien ?';
    expect(blocking(body, FACTS)).toContain('UNGROUNDED_OBSERVATION');
  });
});

// ---------------------------------------------------------------------------
// §4 (suite) — la régression, sur le corpus réel gelé
// ---------------------------------------------------------------------------

describe('la régression sur les 210 formes réellement écrites', () => {
  const extractedNow = (): string[] => {
    const out: string[] = [];
    for (const sentence of FIRST_TOUCH_CLAIM_CORPUS) {
      for (const claim of observationClaims(sentence, [])) out.push(claim.clause);
    }
    return out;
  };

  /** Une clause qui S'OUVRE sur un mot interrogatif est un fragment de question. */
  const INTERROGATIVE_FRAGMENT = /^(?:comment|combien|pourquoi|quand|où|quoi|quel|quelles?|quels)\b/iu;

  it('le correctif matche MOINS, et jamais plus — vérifié clause par clause', () => {
    const before = new Set(CLAUSES_EXTRACTED_BEFORE);
    const gained = extractedNow().filter((clause) => !before.has(clause));
    expect(gained).toEqual([]);
  });

  it('les fragments de question ont disparu, et le corpus en portait bien', () => {
    expect(CLAUSES_EXTRACTED_BEFORE.filter((c) => INTERROGATIVE_FRAGMENT.test(c)).length).toBeGreaterThan(0);
    expect(extractedNow().filter((c) => INTERROGATIVE_FRAGMENT.test(c))).toEqual([]);
  });

  it('tout ce qui a été perdu était une question, jamais une observation', () => {
    const now = new Set(extractedNow());
    const lost = CLAUSES_EXTRACTED_BEFORE.filter((clause) => !now.has(clause));
    expect(lost.length).toBeGreaterThan(0);
    for (const clause of lost) {
      // Soit la clause s'ouvre sur le mot interrogatif (« comment pour avoir… »),
      // soit l'adverbe la précédait et a été consommé (« comment vous faites
      // pour obtenir… » → « pour obtenir… »). Dans les deux cas, la phrase
      // d'origine demandait.
      const fromCorpus = FIRST_TOUCH_CLAIM_CORPUS.some(
        (sentence) => sentence.includes(clause) || INTERROGATIVE_FRAGMENT.test(clause),
      );
      expect(fromCorpus, clause).toBe(true);
    }
  });

  it('l’immense majorité des observations réelles est conservée', () => {
    // La garde est une correction de PRÉCISION, pas une amputation : elle ne
    // doit retirer qu'une petite minorité de ce que l'extraction voyait.
    expect(extractedNow().length).toBeGreaterThan(CLAUSES_EXTRACTED_BEFORE.length * 0.9);
  });
});

// ---------------------------------------------------------------------------
// §5 — la personnalisation lue des preuves, branchée aux deux chemins
// ---------------------------------------------------------------------------

describe('firstTouchPersonalization est réellement câblée', () => {
  const read = async (file: string): Promise<string> =>
    import('node:fs/promises').then((fs) => fs.readFile(file, 'utf-8'));

  it('les deux chemins de production la chargent', async () => {
    for (const file of ['src/cli/r6b-generate.ts', 'src/lib/pipeline/runCampaign.ts']) {
      const source = await read(file);
      expect(source, file).toMatch(/loadFirstTouchPersonalization/);
      expect(source, file).toMatch(/personalization/);
    }
  });

  it('elle est lue depuis les preuves, jamais écrite', async () => {
    // Le CODE, pas la prose : l'en-tête du module promet « aucun insert, aucun
    // update, aucun delete », et le lire naïvement ferait échouer le test sur
    // la phrase qui énonce la règle.
    const store = (await read('src/lib/pipeline/firstTouchPersonalizationStore.ts'))
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');
    expect(store).not.toMatch(/\binsert\s+into\b|\bupdate\b|\bdelete\s+from\b/i);
    expect(store).toMatch(/\bselect\b/i);
  });

  it('les deux chemins lui passent l’angle en REPLI, avec la même signature', async () => {
    for (const file of ['src/cli/r6b-generate.ts', 'src/lib/pipeline/runCampaign.ts']) {
      const source = await read(file);
      expect(source, file).toMatch(/angleHook:\s*angle\.personalization/);
    }
  });
});

describe('la personnalisation apporte des faits, jamais une dispense', () => {
  const hook = (evidenceIds: readonly string[], observation: string) =>
    Object.freeze({
      angle: 'SERVICE_MIX' as const,
      observation,
      evidenceIds: Object.freeze([...evidenceIds]),
      provider: 'crawl',
      sourceUrl: null,
    });

  const personalization = (over: Partial<FirstTouchPersonalization>): FirstTouchPersonalization =>
    Object.freeze({
      opening: 'PERSONALIZED',
      hook: null,
      alsoAvailable: Object.freeze([]),
      rejected: Object.freeze([]),
      businessContext: Object.freeze([]),
      ...over,
    }) as FirstTouchPersonalization;

  const answer = (body: string): RawMessageAnswer => ({
    variant_a: { body, rationale: 'r', used_evidence_ids: [] },
    variant_b: null,
    chosen_variant: 'A',
    choice_reason: 'a',
  });

  const CAMPAIGN = { outreach: { channel: 'instagram_dm', maxChars: 650, generateVariantB: false } };
  const RESEARCH = { observations: [], unknowns: [], summary: '', opportunities: [], confidence: 1, modelRunId: null };
  const ANGLE = { personalization: '', useCaseStudy: false, caseStudyKey: null };

  const run = (body: string, p?: FirstTouchPersonalization | null) =>
    checkGeneratedMessages(
      answer(body),
      CAMPAIGN as never,
      RESEARCH as never,
      ANGLE as never,
      null,
      null,
      p,
    );

  const OBSERVED = 'Bonjour, j’ai vu que vous faites du portrait en lumière naturelle, je connaissais mal le principe. Vous couvrez quel secteur ?';

  it('sans preuve, rien n’est inventé — l’observation reste non ancrée', () => {
    const result = run(OBSERVED, null);
    const codes = result.messages[0]?.firstTouch.findings.map((f) => f.code) ?? [];
    expect(codes).toContain('UNGROUNDED_OBSERVATION');
  });

  it('une accroche portée par une ligne de preuve ancre l’observation', () => {
    const result = run(
      OBSERVED,
      personalization({ hook: hook(['ev-1'], 'ils mettent en avant : portrait en lumière naturelle') }),
    );
    const codes = result.messages[0]?.firstTouch.findings.map((f) => f.code) ?? [];
    expect(codes).not.toContain('UNGROUNDED_OBSERVATION');
  });

  it('une accroche SANS ligne de preuve n’ancre rien — l’angle n’est pas une observation', () => {
    // Le repli venu de `prospect_angles` porte `evidenceIds: []`. C'est un
    // raisonnement, pas une chose vue : il n'a jamais eu le droit d'ancrer, et
    // brancher la personnalisation ne le lui donne pas.
    const result = run(
      OBSERVED,
      personalization({ hook: hook([], 'ils mettent en avant : portrait en lumière naturelle') }),
    );
    const codes = result.messages[0]?.firstTouch.findings.map((f) => f.code) ?? [];
    expect(codes).toContain('UNGROUNDED_OBSERVATION');
  });

  it('ne rien passer reproduit le comportement d’avant, à l’identique', () => {
    const withNothing = run(OBSERVED);
    const withNull = run(OBSERVED, null);
    expect(withNothing.messages[0]?.firstTouch).toEqual(withNull.messages[0]?.firstTouch);
  });
});

// ---------------------------------------------------------------------------
// §6 — la voix voulue n'est plus structurellement inenvoyable
// ---------------------------------------------------------------------------

/**
 * Le contrôle de production et la voix qu'on veut écrire avaient une
 * intersection VIDE : un message en trois temps, sourcé, sans pitch et sans
 * appel, était refusé par la longueur avant d'être lu. Un budget qu'aucune
 * voix acceptable ne tient n'enseigne rien — il apprend seulement à écrire
 * plus court que ce qu'on juge bon.
 *
 * Ces tests mesurent donc l'INTERSECTION, sur le corpus de voix synthétique
 * déclaré en tête de fichier. Ils ne jugent pas la qualité des trois
 * messages : ils vérifient qu'un message de cette FORME peut exister.
 */
describe('la compatibilité de la voix voulue avec le contrôle de production', () => {
  it('aucun message du corpus n’est refusé pour une observation qu’il SOURCE', () => {
    for (const example of VOICE_CORPUS) {
      expect(blocking(example.body, example.facts), example.key).not.toContain('UNGROUNDED_OBSERVATION');
    }
  });

  it('la structure en trois temps est ENVOYABLE, pas seulement tolérée', () => {
    const sendable = VOICE_CORPUS.filter((example) => blocking(example.body, example.facts).length === 0);
    expect(sendable.length).toBe(VOICE_CORPUS.length);
  });

  /**
   * Le vrai acquis, et le seul que ce round garantit : la structure tient dans
   * le budget AVEC de la place pour la question. Mesurer le message entier ne
   * dirait rien — c'est le PRÉFIXE (observation + réaction) qui doit laisser
   * respirer le troisième temps.
   */
  it('l’observation et la réaction personnelle laissent la place à une question', () => {
    for (const example of VOICE_CORPUS) {
      const cut = example.body.lastIndexOf('. ');
      const prefix = cut < 0 ? example.body : example.body.slice(0, cut + 1);
      const words = prefix.trim().split(/\s+/u).length;

      // Une question légère de tour 1 fait une dizaine de mots. Exiger le
      // double laisse une marge réelle plutôt qu'une marge de justesse.
      expect(FIRST_TOUCH_TARGET_WORDS.max - words, example.key).toBeGreaterThanOrEqual(20);
      expect(FIRST_TOUCH_MAX_CHARS - prefix.length, example.key).toBeGreaterThanOrEqual(150);
    }
  });

  it('avant ce round, cette place n’existait pas', () => {
    // 35 mots de cible et 260 caractères : un préfixe de 20 mots / 117
    // caractères ne laissait que 15 mots et 143 caractères, alors qu'une
    // question naturelle en fait 24 à 32. Le constat est ici pour que la
    // raison du changement reste lisible quand les chiffres auront vieilli.
    const ANCIENNE_CIBLE = 35;
    const plusLong = VOICE_CORPUS.map((example) => {
      const cut = example.body.lastIndexOf('. ');
      return (cut < 0 ? example.body : example.body.slice(0, cut + 1)).trim().split(/\s+/u).length;
    }).reduce((a, b) => Math.max(a, b), 0);
    expect(ANCIENNE_CIBLE - plusLong).toBeLessThan(20);
  });
});

// ---------------------------------------------------------------------------
// §5 (suite) — la provenance survit au branchement
// ---------------------------------------------------------------------------

describe('brancher la personnalisation ne fait pas perdre la provenance', () => {
  it('le bloc rendu au modèle CITE les lignes de preuve de l’accroche', async () => {
    const { buildFirstTouchPersonalization, renderPersonalizationBlock } = await import(
      '@/lib/pipeline/firstTouchPersonalization'
    );
    const result = buildFirstTouchPersonalization({
      displayName: 'X',
      city: null,
      evidence: [
        {
          id: 'ev-42',
          field: 'services',
          valueText: 'portrait en lumière naturelle, reportage en intérieur',
          provider: 'website',
          method: 'crawl',
          confidence: 0.9,
          sourceUrl: null,
        },
      ],
    });
    const block = renderPersonalizationBlock(result);
    expect(result.hook?.evidenceIds).toContain('ev-42');
    expect(block).toContain('ev-42');
    // …et l'instruction de la citer, sans quoi le modèle n'a pas de raison de
    // le faire et `used_facts` repart vide.
    expect(block).toContain('used_evidence_ids');
  });

  it('un identifiant de preuve cité par le modèle est RETENU, pas filtré', () => {
    const answer: RawMessageAnswer = {
      variant_a: {
        body: 'Bonjour, j’ai vu que vous faites du portrait en lumière naturelle, je connaissais mal ça. Vous couvrez quel secteur ?',
        rationale: 'r',
        used_evidence_ids: ['ev-42'],
      },
      variant_b: null,
      chosen_variant: 'A',
      choice_reason: 'a',
    };
    const personalization = Object.freeze({
      opening: 'PERSONALIZED' as const,
      hook: Object.freeze({
        angle: 'SERVICE_MIX' as const,
        observation: 'ils mettent en avant : portrait en lumière naturelle',
        evidenceIds: Object.freeze(['ev-42']),
        provider: 'website',
        sourceUrl: null,
      }),
      alsoAvailable: Object.freeze([]),
      rejected: Object.freeze([]),
      businessContext: Object.freeze([]),
    }) as FirstTouchPersonalization;

    const result = checkGeneratedMessages(
      answer,
      { outreach: { channel: 'instagram_dm', maxChars: 650, generateVariantB: false } } as never,
      { observations: [], unknowns: [], summary: '', opportunities: [], confidence: 1, modelRunId: null } as never,
      { personalization: '', useCaseStudy: false, caseStudyKey: null } as never,
      null,
      null,
      personalization,
    );
    expect(result.messages[0]?.usedFacts).toEqual(['ev-42']);
  });

  it('un identifiant inventé reste filtré — la liste blanche n’est pas ouverte', () => {
    const answer: RawMessageAnswer = {
      variant_a: { body: 'Bonjour, vous couvrez quel secteur exactement autour de chez vous ?', rationale: 'r', used_evidence_ids: ['ev-inexistant'] },
      variant_b: null,
      chosen_variant: 'A',
      choice_reason: 'a',
    };
    const result = checkGeneratedMessages(
      answer,
      { outreach: { channel: 'instagram_dm', maxChars: 650, generateVariantB: false } } as never,
      { observations: [], unknowns: [], summary: '', opportunities: [], confidence: 1, modelRunId: null } as never,
      { personalization: '', useCaseStudy: false, caseStudyKey: null } as never,
      null,
      null,
      null,
    );
    expect(result.messages[0]?.usedFacts).toEqual([]);
  });
});
