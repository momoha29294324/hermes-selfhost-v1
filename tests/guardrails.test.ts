import { describe, expect, it } from 'vitest';
import { checkMessage, extractNumbers, personalizationLevel } from '@/lib/pipeline/guardrails';

const CLAIM = 'Nous avons déjà généré environ 3 500 € pour un client que nous accompagnons.';

const base = {
  maxChars: 650,
  allowedCaseStudyClaim: null,
  allowedNumbers: [] as number[],
  groundedFacts: [] as string[],
};

describe('checkMessage', () => {
  it('accepts a grounded, sober message', () => {
    const flags = checkMessage({
      ...base,
      body: "Bonjour, j'ai vu vos avant/après en protection boutique en ligne sur votre site. Est-ce que la prise de rendez-vous se fait surtout par téléphone aujourd'hui ?",
    });
    expect(flags).toEqual([]);
  });

  it('blocks the exact failure mode from the brief', () => {
    const flags = checkMessage({
      ...base,
      body: "Bonjour, j'ai vu que vous ne faites aucune publicité en ce moment.",
    });
    expect(flags.some((flag) => flag.code === 'unverified_absence' && flag.blocking)).toBe(true);
  });

  it('blocks other unverified absences', () => {
    const flags = checkMessage({ ...base, body: "Vous n'avez pas de tunnel de conversion." });
    expect(flags.some((flag) => flag.code === 'unverified_absence')).toBe(true);
  });

  it('blocks invented metrics', () => {
    const flags = checkMessage({ ...base, body: 'On vous garantit un ROAS de 4 dès le premier mois.' });
    const codes = flags.map((flag) => flag.code);
    expect(codes).toContain('overpromise');
  });

  it('blocks a euro amount that is not part of an approved proof', () => {
    const flags = checkMessage({ ...base, body: 'On a généré 12 000 € pour un client.' });
    expect(flags.some((flag) => flag.code === 'unapproved_metric')).toBe(true);
  });

  it("allows quoting a price the prospect itself published", () => {
    const flags = checkMessage({
      ...base,
      groundedFacts: ['Forfait complet affiché à partir de 250 € sur le site'],
      body: 'Votre formule à 250 € est très bien positionnée, une question rapide dessus.',
    });
    expect(flags).toEqual([]);
  });

  it('allows the approved amount when the approved claim is quoted verbatim', () => {
    const flags = checkMessage({
      ...base,
      allowedCaseStudyClaim: CLAIM,
      allowedNumbers: [3500],
      body: `Bonjour, une idée simple pour vos réservations. ${CLAIM}`,
    });
    expect(flags).toEqual([]);
  });

  it('blocks a paraphrase of the approved proof', () => {
    const flags = checkMessage({
      ...base,
      allowedCaseStudyClaim: CLAIM,
      allowedNumbers: [3500],
      body: 'On a fait 3 500 € de CA en 2 semaines avec un client, avec un ROAS de 5.',
    });
    expect(flags.some((flag) => flag.code === 'case_study_paraphrased' || flag.code === 'overpromise')).toBe(true);
  });

  it('blocks a message that drifted into another script', () => {
    const flags = checkMessage({
      ...base,
      body: 'Bonjour, une piste pour vos réservations, la 預约 en ligne.',
    });
    expect(flags.some((flag) => flag.code === 'foreign_script' && flag.blocking)).toBe(true);
  });

  it('blocks a message cut off mid-sentence', () => {
    const flags = checkMessage({
      ...base,
      body: 'Bonjour, une piste serait de structurer vos demandes de devis autour des prestations',
    });
    expect(flags.some((flag) => flag.code === 'truncated' && flag.blocking)).toBe(true);
  });

  it('accepts the usual French sentence endings', () => {
    for (const body of [
      'Une question rapide sur vos réservations.',
      'Quelles prestations souhaitez-vous développer ?',
      'On peut en parler cette semaine !',
    ]) {
      expect(checkMessage({ ...base, body })).toEqual([]);
    }
  });

  it('blocks fake urgency and unfilled placeholders', () => {
    expect(
      checkMessage({ ...base, body: 'Il ne reste que 2 places ce mois-ci.' }).some(
        (flag) => flag.code === 'fake_urgency',
      ),
    ).toBe(true);
    expect(
      checkMessage({ ...base, body: 'Bonjour [prénom], une question rapide.' }).some(
        (flag) => flag.code === 'placeholder',
      ),
    ).toBe(true);
  });

  it('flags over-long messages without blocking them', () => {
    const flags = checkMessage({ ...base, maxChars: 20, body: 'a'.repeat(50) });
    expect(flags[0]?.code).toBe('too_long');
    expect(flags[0]?.blocking).toBe(false);
  });
});

describe('extractNumbers', () => {
  it('reads amounts written in French', () => {
    expect(extractNumbers('environ 3 500 € générés')).toEqual([3500]);
    expect(extractNumbers('12000 EUR')).toEqual([12000]);
    expect(extractNumbers('aucun montant')).toEqual([]);
  });
});

describe('personalizationLevel', () => {
  const facts = [
    'Le site met en avant les interventions sur site, les contrats annuels et les clients institutionnels',
    'Le titre du site mentionne un atelier indépendant à Ville-Exemple',
  ];

  it('is none without grounded facts', () => {
    expect(personalizationLevel('Bonjour', [])).toBe('none');
  });

  it('stays low when the message says nothing specific', () => {
    expect(
      personalizationLevel('Bonjour, une question rapide sur votre activité.', facts),
    ).toBe('low');
  });

  it('credits a message that rephrases the observation instead of quoting it', () => {
    const body =
      'Bonjour, votre positionnement autour des interventions sur site et des contrats annuels est très clair.';
    expect(personalizationLevel(body, facts)).toBe('medium');
  });

  it('reaches high when several observed specifics are used', () => {
    const body =
      'Votre positionnement à Ville-Exemple sur les interventions sur site, les contrats annuels et les clients institutionnels en atelier est très lisible.';
    expect(personalizationLevel(body, facts)).toBe('high');
  });
});
