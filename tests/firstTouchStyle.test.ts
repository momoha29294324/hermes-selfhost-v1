import { UNCONFIGURED_OPERATOR_PROFILE } from '@/lib/config/operatorProfile';
import { describe, expect, it } from 'vitest';
import {
  FIRST_TOUCH_MAX_CHARS,
  FIRST_TOUCH_TARGET_WORDS,
  checkFirstTouch,
  observationClaims,
  type FirstTouchCode,
} from '@/lib/pipeline/firstTouchStyle';

/**
 * HERMES-TARGETING-R1, partie C — « le premier message ouvre une conversation,
 * il ne rend pas un audit ».
 *
 * Les deux premiers tests portent sur des textes RÉELLEMENT envoyés en
 * production. Ils sont recopiés mot pour mot, parce que c'est ce qui donne sa
 * valeur au contrôle : une règle qui n'attraperait pas ce qui est déjà parti
 * n'aurait rien corrigé.
 *
 * Aucune entreprise n'est nommée : les messages ne portaient pas de nom, et les
 * fixtures inventées ci-dessous ne s'en donnent pas.
 *
 * Le module est pur — aucune base, aucun modèle, aucun réseau.
 */

const FACTS: readonly string[] = [
  'Prestations affichées : prestation standard intérieur, shampoing sièges, prestation à la main',
  'Intervention à domicile sur l’agglomération',
  'Devis en ligne avec sélection des prestations',
];

function codes(body: string, facts: readonly string[] = FACTS): FirstTouchCode[] {
  return checkFirstTouch({ body, groundedFacts: facts })
    .findings.filter((finding) => finding.severity === 'BLOCKING')
    .map((finding) => finding.code);
}

// ---------------------------------------------------------------------------
// Ce qui partait réellement
// ---------------------------------------------------------------------------

describe('les messages réellement envoyés, refusés par la nouvelle règle', () => {
  const SENT_A =
    'Bonjour, j’ai vu que vous mettez en avant la boutique en ligne, le film REVENTE et XPEL, avec la possibilité ' +
    'de réserver, d’appeler ou de vous écrire. Une piste serait de distinguer les demandes liées à chaque ' +
    'prestation et à chaque parcours de contact. Cela aiderait à voir lesquels attirent les projets les ' +
    'plus pertinents localement. Est-ce un sujet que vous cherchez déjà à mieux comprendre ?';

  const SENT_B =
    'Bonjour, j’ai vu que vous proposez plusieurs façons de vous contacter — réservation, devis, téléphone ' +
    'et formulaire — pour vos prestations de vente de produits, boutique en ligne et REVENTE. Une piste serait de tester une ' +
    'page dédiée à une seule prestation, puis de suivre quels contacts débouchent sur les demandes les ' +
    'plus pertinentes. Sur quelle prestation aimeriez-vous attirer davantage de demandes aujourd’hui ?';

  it('26. le premier est refusé : trop long, et c’est un mini-audit', () => {
    const found = codes(SENT_A);
    expect(found).toContain('TOO_LONG');
    expect(found).toContain('UNSOLICITED_ADVICE');
    expect(checkFirstTouch({ body: SENT_A, groundedFacts: FACTS }).verdict).toBe('OFF_TONE');
  });

  it('27. le second est refusé, et la page dédiée est nommée comme telle', () => {
    const found = codes(SENT_B);
    expect(found).toContain('LANDING_PAGE_ADVICE');
    expect(found).toContain('UNSOLICITED_ADVICE');
    expect(found).toContain('TOO_LONG');
  });

  it('28. le jargon d’attribution est refusé pour lui-même', () => {
    expect(codes('Salut, votre tunnel de conversion capte-t-il bien vos demandes ?')).toContain(
      'ATTRIBUTION_JARGON',
    );
    expect(codes('Bonjour, combien de leads vous arrivent par mois en ce moment ?')).toContain(
      'ATTRIBUTION_JARGON',
    );
    expect(
      codes('Bonjour, quel est aujourd’hui votre taux de conversion sur les demandes reçues ?'),
    ).toContain('ATTRIBUTION_JARGON');
  });
});

// ---------------------------------------------------------------------------
// §27, 24-26 et 36 — la forme
// ---------------------------------------------------------------------------

describe('la forme d’un premier message', () => {
  const GOOD_SHORT =
    'Salut, petite question : vous cherchez encore à avoir plus de demandes pour vos prestations en ce moment ?';

  const GOOD_OBSERVED =
    'Bonjour, j’ai vu que vous faisiez surtout du prestation standard intérieur. Ça tourne déjà bien niveau ' +
    'demandes ou vous cherchez encore à développer ?';

  it('24. un message court passe', () => {
    const report = checkFirstTouch({ body: GOOD_SHORT, groundedFacts: FACTS });
    expect(report.verdict).toBe('CONVERSATIONAL');
    expect(report.metrics.words).toBeLessThanOrEqual(FIRST_TOUCH_TARGET_WORDS.max);
    expect(report.metrics.chars).toBeLessThanOrEqual(FIRST_TOUCH_MAX_CHARS);
  });

  it('25. une seule question — deux sont refusées, zéro aussi', () => {
    expect(codes(GOOD_SHORT)).not.toContain('MULTIPLE_QUESTIONS');
    expect(
      codes('Salut, vous cherchez plus de demandes en ce moment ? Vous faites de la publicité ?'),
    ).toContain('MULTIPLE_QUESTIONS');
    expect(
      codes('Bonjour, j’ai vu que vous faisiez du prestation standard intérieur, le rendu est propre et net.'),
    ).toContain('NO_QUESTION');
  });

  it('26 bis. un paragraphe de quatre phrases est refusé même sans conseil', () => {
    const found = codes(
      'Bonjour, j’ai vu votre prestation standard intérieur. Le rendu est propre. Le prestation à la main se voit tout ' +
        'de suite. Vous cherchez encore à avoir plus de demandes en ce moment ?',
    );
    expect(found).toContain('TOO_MANY_SENTENCES');
  });

  it('36. proposer un appel dès le premier message est refusé', () => {
    expect(
      codes('Bonjour, on peut s’appeler quinze minutes cette semaine pour en parler ?'),
    ).toContain('IMMEDIATE_CALL_CTA');
    expect(codes(GOOD_OBSERVED)).not.toContain('IMMEDIATE_CALL_CTA');
  });

  it('un message réduit à rien est refusé aussi', () => {
    expect(codes('Salut, ça va ?')).toContain('TOO_SHORT');
  });
});

// ---------------------------------------------------------------------------
// §27, 29 — l'offre
// ---------------------------------------------------------------------------

describe('l’offre n’a pas sa place au premier message', () => {
  it('29. le paiement à la performance est refusé', () => {
    expect(
      codes('Salut, on travaille uniquement au résultat, ça vous intéresse d’en discuter ?'),
    ).toContain('PERFORMANCE_OFFER');
    expect(
      codes('Bonjour, on commence gratuitement et vous ne payez rien avant résultat, ça vous parle ?'),
    ).toContain('PERFORMANCE_OFFER');
  });

  it('le pitch complet de l’agence est refusé', () => {
    expect(
      codes('Bonjour, nous accompagnons les artisans pour plus de demandes, ça vous intéresse ?'),
    ).toContain('FULL_PITCH');
  });
});

// ---------------------------------------------------------------------------
// §27, 30-31 — la personnalisation
// ---------------------------------------------------------------------------

describe('la personnalisation reste légère et vraie', () => {
  it('30. une observation concrète issue d’un fait vérifié est admise', () => {
    const report = checkFirstTouch({
      body: 'Bonjour, j’ai vu que vous faisiez surtout du prestation standard intérieur. Vous cherchez encore à en avoir plus ?',
      groundedFacts: FACTS,
    });
    expect(report.verdict).toBe('CONVERSATIONAL');
    const claims = observationClaims(
      'Bonjour, j’ai vu que vous faisiez surtout du prestation standard intérieur.',
      FACTS,
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]?.grounded).toBe(true);
  });

  it('31. une observation qu’aucun fait ne porte est refusée', () => {
    expect(
      codes(
        'Bonjour, j’ai vu que vous posiez du film REVENTE sur des Porsche. Vous cherchez encore plus de demandes ?',
        FACTS,
      ),
    ).toContain('UNGROUNDED_OBSERVATION');
  });

  it('une question générique sans observation reste admissible quand rien n’a été observé', () => {
    const report = checkFirstTouch({
      body: 'Salut, petite question : vous cherchez encore à avoir plus de clients en ce moment ?',
      groundedFacts: [],
    });
    expect(report.verdict).toBe('CONVERSATIONAL');
  });

  it('une observation vague n’est pas comptée comme fausse — elle n’affirme rien', () => {
    expect(
      codes('Bonjour, je suis tombé sur votre travail et j’ai regardé vos prestations. Ça tourne bien ?', []),
    ).not.toContain('UNGROUNDED_OBSERVATION');
  });
});

// ---------------------------------------------------------------------------
// §27, 32-35 et 37 — le registre
// ---------------------------------------------------------------------------

describe('le registre', () => {
  it('33. tutoyer et vouvoyer dans le même message est refusé', () => {
    expect(
      codes('Salut, j’ai vu que tu faisais du prestation standard intérieur. Vous cherchez encore plus de demandes ?'),
    ).toContain('ADDRESS_MODE_MIXED');
    expect(
      codes('Salut, tu cherches encore à avoir plus de demandes pour ton activité en ce moment ?'),
    ).not.toContain('ADDRESS_MODE_MIXED');
  });

  it('34. l’argot forcé est refusé, et le français naturel ne l’est pas', () => {
    expect(
      codes('Wesh, askip vous cherchez encore à avoir plus de demandes en ce moment ?'),
    ).toContain('FORCED_SLANG');
    expect(codes('Salut, petite question : vous cherchez encore plus de demandes en ce moment ?')).toEqual([]);
  });

  it('32. les abréviations de SMS sont refusées', () => {
    expect(
      codes('Bjr, vous cherchez encore à avoir bcp plus de demandes en ce moment sur vos prestations ?'),
    ).toContain('TEXTISM');
  });

  it('35. plus d’un emoji est refusé', () => {
    expect(
      codes('Salut 👋 vous cherchez encore à avoir plus de demandes en ce moment ? 🚗✨'),
    ).toContain('EMOJI_INFLATION');
  });

  it('les formules de plaquette sont refusées', () => {
    expect(
      codes('Bonjour, seriez-vous disponible pour une prise de contact au sujet de vos demandes ?'),
    ).toContain('CORPORATE_JARGON');
  });
});

// ---------------------------------------------------------------------------
// §27, 37 — la diversité sans remplissage
// ---------------------------------------------------------------------------

describe('la diversité', () => {
  /**
   * Cinq ouvertures différentes, toutes admissibles. Le test dit deux choses à
   * la fois : qu'aucune ne se fait refuser, et qu'aucune n'a besoin d'un
   * remplissage pour tenir dans le budget — les cinq font entre 15 et 35 mots.
   */
  const VARIANTS: readonly string[] = [
    'Salut, petite question : vous cherchez encore à avoir plus de demandes pour vos prestations en ce moment ?',
    'Bonjour, j’ai vu que vous faisiez du prestation standard intérieur. Ça tourne déjà bien ou vous cherchez encore à développer ?',
    'Bonjour, vous intervenez à domicile si j’ai bien vu. Vous avez déjà de quoi remplir vos semaines ou pas encore ?',
    'Salut, question rapide : aujourd’hui les nouveaux clients arrivent surtout par le bouche-à-oreille chez vous ?',
    'Bonjour, j’ai vu votre devis en ligne, c’est bien pensé. Vous en tirez déjà pas mal de demandes ?',
  ];

  it('37. plusieurs ouvertures distinctes passent toutes, sans remplissage', () => {
    const openings = new Set<string>();
    for (const body of VARIANTS) {
      const report = checkFirstTouch({ body, groundedFacts: FACTS });
      expect(report.findings.filter((finding) => finding.severity === 'BLOCKING')).toEqual([]);
      expect(report.metrics.words).toBeGreaterThanOrEqual(FIRST_TOUCH_TARGET_WORDS.min);
      expect(report.metrics.words).toBeLessThanOrEqual(FIRST_TOUCH_TARGET_WORDS.max + 5);
      openings.add(body.split(' ').slice(0, 4).join(' ').toLowerCase());
    }
    expect(openings.size).toBe(VARIANTS.length);
  });

  it("aucun exemple de voix n'est embarqué par cette édition", () => {
    // Un message d'exemple porte le marché, le registre et les tournures de
    // celui qui l'a écrit. Il ne se transporte pas d'une instance à une autre,
    // et cette édition n'en livre donc aucun. Ce test le rend opposable : si
    // quelqu'un en ajoutait un « juste pour illustrer », il tomberait.
    const profile = UNCONFIGURED_OPERATOR_PROFILE;
    expect(profile.voiceExamples).toHaveLength(0);
    expect(profile.status).toBe('UNCONFIGURED');
  });

});
