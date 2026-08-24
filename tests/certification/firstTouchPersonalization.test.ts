/**
 * HERMES-END-TO-END-CERTIFICATION-R1 §FIRST-TOUCH — ce qu'on a le droit de dire
 * à quelqu'un qu'on n'a jamais contacté.
 *
 * Les formes de données sont celles du corpus réel — champs, fournisseurs,
 * méthodes, et jusqu'aux doublons accentués que la découverte produit
 * réellement (« prestation standard interieur » ET « prestation standard intérieur », « domicile »
 * ET « a domicile » ET « à domicile »). Les entreprises sont fictives.
 *
 * Aucun envoi n'est possible depuis ce fichier : il n'importe ni provider, ni
 * rail, ni base.
 */

import { describe, expect, it } from 'vitest';
import {
  buildFirstTouchPersonalization,
  renderPersonalizationBlock,
  type PersonalizationEvidence,
} from '@/lib/pipeline/firstTouchPersonalization';

let sequence = 0;
function evidence(
  field: string,
  valueText: string | null,
  overrides: Partial<PersonalizationEvidence> = {},
): PersonalizationEvidence {
  sequence += 1;
  return Object.freeze({
    id: `ev-${String(sequence)}`,
    field,
    valueText,
    provider: 'website',
    method: 'crawl',
    confidence: 1,
    sourceUrl: 'https://example.com',
    ...overrides,
  });
}

const BASE = { displayName: 'Atelier Fictif', city: 'Chenôve' as string | null };

describe('A · une accroche naît d’une preuve, ou ne naît pas', () => {
  it('aucune preuve ne produit AUCUNE accroche — l’ouverture reste générique', () => {
    const result = buildFirstTouchPersonalization({ ...BASE, evidence: [] });
    expect(result.opening).toBe('GENERIC');
    expect(result.hook).toBeNull();
    expect(result.businessContext).toEqual([]);
  });

  it('une preuve DÉRIVÉE hors synthèse ne porte pas une phrase adressée à un inconnu', () => {
    const result = buildFirstTouchPersonalization({
      ...BASE,
      evidence: [evidence('services', 'prestation à la main', { method: 'derived' })],
    });
    expect(result.opening).toBe('GENERIC');
    expect(result.rejected).toContainEqual({ angle: 'SERVICE_MIX', reason: 'NOT_OBSERVED' });
  });

  it('une preuve sous le seuil de confiance ne compte pas', () => {
    const result = buildFirstTouchPersonalization({
      ...BASE,
      evidence: [evidence('services', 'prestation à la main', { confidence: 0.4 })],
    });
    expect(result.opening).toBe('GENERIC');
  });

  it('le bloc rendu SANS accroche interdit de prétendre avoir regardé', () => {
    const block = renderPersonalizationBlock(
      buildFirstTouchPersonalization({ ...BASE, evidence: [] }),
    );
    expect(block).toContain('n’affirme RIEN');
    expect(block).toContain('sans prétendre avoir regardé leur travail');
  });
});

describe('B · ce qui ne distingue rien n’est pas une personnalisation', () => {
  it('« atelier » et « prestation standard » décrivent toute la cible', () => {
    const result = buildFirstTouchPersonalization({
      ...BASE,
      evidence: [evidence('services', 'prestation, prestation, prestation')],
    });
    expect(result.hook).toBeNull();
    expect(result.rejected).toContainEqual({ angle: 'SERVICE_MIX', reason: 'NOT_DISTINCTIVE' });
  });

  it('les variantes accentuées de la même prestation ne comptent qu’une fois', () => {
    const result = buildFirstTouchPersonalization({
      ...BASE,
      evidence: [evidence('services', 'prestation standard interieur, prestation standard intérieur, prestation a la main')],
    });
    // Sans clé commune, la phrase serait « prestation standard interieur et prestation standard
    // intérieur » — le doublon que le corpus produit réellement.
    expect(result.hook?.observation).toBe('ils mettent en avant : prestation standard interieur et prestation a la main');
  });

  it('« domicile » n’est pas une prestation : c’est une modalité, et elle a son angle', () => {
    const result = buildFirstTouchPersonalization({
      ...BASE,
      evidence: [evidence('services', 'domicile, a domicile, à domicile')],
    });
    expect(result.hook?.angle).toBe('MOBILE_SERVICE');
    expect(result.hook?.observation).toBe('ils annoncent intervenir à domicile');
    // Et surtout : jamais « ils mettent en avant : domicile et a domicile ».
    expect(result.alsoAvailable.map((hook) => hook.angle)).not.toContain('SERVICE_MIX');
  });
});

describe('C · une audience se DÉDUIT d’une adresse, jamais d’un mot', () => {
  it('« nous sommes des professionnels » ne dit rien de leur clientèle', () => {
    const result = buildFirstTouchPersonalization({
      ...BASE,
      evidence: [
        evidence('website_description', 'Nous sommes des professionnels du prestation standard depuis 2015.'),
      ],
    });
    expect(result.rejected).toContainEqual({ angle: 'AUDIENCE', reason: 'NOT_DISTINCTIVE' });
    expect(result.hook).toBeNull();
  });

  it('« pour les particuliers et les professionnels » est une adresse', () => {
    const result = buildFirstTouchPersonalization({
      ...BASE,
      evidence: [
        evidence(
          'website_description',
          'Prestation standard automobile pour les particuliers et les professionnels à Dijon.',
        ),
      ],
    });
    expect(result.hook?.angle).toBe('AUDIENCE');
    expect(result.hook?.observation).toBe("leur site s'adresse aux particuliers ET aux professionnels");
  });

  it('la phrase rendue est du français : jamais « s’adresse à aux professionnels »', () => {
    const result = buildFirstTouchPersonalization({
      ...BASE,
      evidence: [evidence('website_description', 'Une offre destinée aux professionnels.')],
    });
    expect(result.hook?.observation).toBe("leur site s'adresse aux professionnels");
    expect(result.hook?.observation).not.toContain('à aux');
  });
});

describe('D · une ville illisible n’est pas une ville', () => {
  it('un pied de page avalé par le crawl ne devient pas une zone', () => {
    const result = buildFirstTouchPersonalization({
      displayName: 'Atelier Fictif',
      // Valeur réellement présente dans le corpus, entreprise mise à part.
      city: 'Ville-Fictive E-MAIL Contactez-nous SUIVEZ-NOUS',
      evidence: [evidence('city', 'Ville-Fictive E-MAIL Contactez-nous SUIVEZ-NOUS')],
    });
    expect(result.rejected).toContainEqual({ angle: 'AREA', reason: 'UNREADABLE' });
    expect(result.businessContext.join(' ')).not.toContain('E-MAIL');
  });

  it('une préposition traînante est retirée — jamais « à TRAPPES à »', () => {
    const result = buildFirstTouchPersonalization({
      displayName: 'Atelier Fictif',
      city: 'VILLEFICTIVE à',
      evidence: [evidence('city', 'VILLEFICTIVE à')],
    });
    expect(result.hook?.observation).toBe('ils sont installés à VILLEFICTIVE');
  });
});

describe('E · une seule accroche, et c’est la plus utile à la conversation', () => {
  const RICHE: readonly PersonalizationEvidence[] = Object.freeze([
    evidence('services', 'prestation standard interieur, prestation a la main, domicile, à domicile'),
    evidence('booking_system', 'simplybook'),
    evidence(
      'funnel_synthesis',
      'réservation en ligne (simplybook), tarifs affichés, CTA « Réserver » — 3 page(s) lue(s)',
      { method: 'derived', confidence: 0.9 },
    ),
    evidence(
      'website_description',
      'Prestation standard automobile pour les particuliers et les professionnels à Dijon.',
    ),
  ]);

  it('la réservation en ligne gagne : elle touche à la façon dont les clients arrivent', () => {
    const result = buildFirstTouchPersonalization({ ...BASE, evidence: RICHE });
    expect(result.hook?.angle).toBe('BOOKING_PRESENT');
    expect(result.hook?.observation).toBe('une réservation en ligne est en place sur leur site');
  });

  it('les autres accroches existent mais N’ENTRENT PAS dans le prompt', () => {
    const result = buildFirstTouchPersonalization({ ...BASE, evidence: RICHE });
    expect(result.alsoAvailable.length).toBeGreaterThan(2);
    const block = renderPersonalizationBlock(result);
    // Une seule ligne d'accroche, et une seule.
    expect(block).toContain('LE SEUL DÉTAIL QUE TU PEUX REPRENDRE');
    expect(block).not.toContain("leur site s'adresse");
    expect(block).not.toContain('ils mettent en avant');
  });

  it('le contexte métier dit à QUI on écrit, sans se citer comme accroche', () => {
    const result = buildFirstTouchPersonalization({ ...BASE, evidence: RICHE });
    const context = result.businessContext.join(' | ');
    expect(context).toContain('prestation standard interieur');
    expect(context).toContain('intervention à domicile');
    expect(context).toContain('réservation en ligne');
    // La ville n'y est PAS : aucune ligne `city` ne la porte dans ce lot, et le
    // contexte s'annonce comme observé. `prospects.city` seul ne suffit pas.
    expect(context).not.toContain('Chenôve');
  });

  it('la ville entre au contexte dès qu’une preuve la porte', () => {
    const result = buildFirstTouchPersonalization({
      ...BASE,
      evidence: [...RICHE, evidence('city', 'Chenôve')],
    });
    expect(result.businessContext.join(' | ')).toContain('ville : Chenôve');
  });

  it('aucun MONTANT n’entre jamais, même lu sur leur site', () => {
    const result = buildFirstTouchPersonalization({
      ...BASE,
      evidence: [
        ...RICHE,
        evidence('price_mentions', '149 €'),
      ],
    });
    const block = renderPersonalizationBlock(result);
    expect(block).not.toMatch(/\d+\s*€/);
    expect(JSON.stringify(result)).not.toContain('149');
  });
});

describe('F · l’angle commercial est un REPLI, jamais un vainqueur', () => {
  const AUDIT_HOOK =
    'J’ai vu que vous intervenez à domicile avec une gamme allant du prestation standard intérieur ' +
    'jusqu’aux offres premium. Cette diversité se prête bien à une acquisition locale ' +
    'différenciée selon la valeur et l’intention de chaque prestation.';

  it('une accroche déterministe passe DEVANT une phrase d’angle', () => {
    const result = buildFirstTouchPersonalization({
      ...BASE,
      evidence: [evidence('booking_system', 'simplybook')],
      angleHook: AUDIT_HOOK,
    });
    expect(result.hook?.observation).toBe('une réservation en ligne est en place sur leur site');
    expect(result.hook?.provider).toBe('website');
  });

  it('sans accroche déterministe, l’angle sert plutôt que le silence', () => {
    const result = buildFirstTouchPersonalization({
      ...BASE,
      evidence: [],
      angleHook: AUDIT_HOOK,
    });
    expect(result.opening).toBe('PERSONALIZED');
    expect(result.hook?.provider).toBe('prospect_angles');
  });
});

describe('G · rien n’affirme une ABSENCE', () => {
  it('une synthèse sans réservation ne dit pas qu’il n’y en a pas', () => {
    const result = buildFirstTouchPersonalization({
      ...BASE,
      evidence: [
        evidence('funnel_synthesis', 'téléphone seul, tarifs non affichés — 4 page(s) lue(s)', {
          method: 'derived',
          confidence: 0.9,
        }),
      ],
    });
    expect(result.rejected).toContainEqual({ angle: 'BOOKING_PRESENT', reason: 'NOT_OBSERVED' });
    const rendered = JSON.stringify(result);
    expect(rendered).not.toContain('pas de réservation');
    expect(rendered).not.toContain("n'ont pas");
  });

  it('« tarifs non affichés » ne devient jamais une accroche', () => {
    const result = buildFirstTouchPersonalization({
      ...BASE,
      evidence: [
        evidence('funnel_synthesis', 'téléphone seul, tarifs non affichés — 4 page(s) lue(s)', {
          method: 'derived',
          confidence: 0.9,
        }),
      ],
    });
    expect(result.alsoAvailable.map((hook) => hook.angle)).not.toContain('PRICING_DISPLAYED');
    expect(result.hook?.angle).not.toBe('PRICING_DISPLAYED');
  });
});
