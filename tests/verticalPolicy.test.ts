import { describe, expect, it } from 'vitest';
import {
  assessVertical,
  assertVerticalAllowed,
  normalizeVerticalText,
  RESERVED_VERTICAL_MESSAGE,
  ReservedVerticalError,
} from '@/lib/config/verticalPolicy';
import { loadNiche, loadCampaign } from '@/lib/config/load';

/**
 * La politique de verticale de cette édition.
 *
 * Deux corpus, et ils ne se ressemblent pas : l'un vérifie qu'une verticale
 * réservée est bien reconnue sous ses formulations courantes, l'autre — le plus
 * important — vérifie qu'un métier ORDINAIRE n'est pas refusé par accident. Un
 * faux positif ici rendrait Hermes inutilisable pour quelqu'un qui n'a rien
 * demandé, et il ne se verrait qu'à l'installation d'un inconnu.
 */

const RESERVED = [
  'detailing automobile',
  'auto detailing',
  'car detailing',
  'vehicle detailing',
  'car wash detailing',
  'nettoyage automobile',
  'nettoyage auto',
  'lavage auto',
  'lavage automobile',
  'esthétique automobile',
  'Esthetique Automobile',
  'DETAILER',
  'Détailing',
  'car wash',
  'Car Washing',
  'carwash',
  'valeting',
  'préparation esthétique automobile',
  'lavage sans eau voiture',
  'nettoyage de véhicules',
  'nettoyage intérieur voiture',
  'truck wash',
  'moto nettoyage',
  'céramique automobile',
  'PPF voiture',
  'polissage automobile',
  'esthétique-automobile',
  'ESTHÉTIQUE_AUTOMOBILE',
];

const ALLOWED = [
  'plomberie',
  'wedding photography',
  'nettoyage de bureaux',
  'nettoyage industriel',
  'cleaning services for offices',
  'entreprise de propreté',
  'car rental',
  'location de voitures',
  'concession automobile',
  'garage mécanique',
  'carrosserie',
  'coiffure',
  'landscaping',
  'dental clinic',
  'retailing',
  'restaurant',
  'architecte',
  'pressing textile',
  'agence immobilière',
  'food truck',
  'auto-école',
  'transport de marchandises',
  'boulangerie',
  'salle de sport',
  'cabinet comptable',
  'développement logiciel',
];

describe('politique de verticale — ce qui est réservé', () => {
  for (const declaration of RESERVED) {
    it(`refuse « ${declaration} »`, () => {
      expect(assessVertical(declaration).status).toBe('RESERVED');
    });
  }

  it('une déclaration RÉPARTIE sur plusieurs champs est lue comme un tout', () => {
    // Découper la déclaration ne doit pas la rendre invisible : le libellé dit
    // « nettoyage », la requête dit « voiture », et ensemble ils nomment le
    // métier réservé aussi sûrement que sur une seule ligne.
    expect(assessVertical('nettoyage', null, undefined, 'voiture').status).toBe('RESERVED');
  });

  it('le motif rendu nomme la règle qui a tranché', () => {
    expect(assessVertical('auto detailing').reason).toBe('standalone:detailing');
    expect(assessVertical('lavage auto').reason).toBe('pair:auto+lavage');
  });
});

describe('politique de verticale — ce qui NE doit jamais être refusé', () => {
  for (const declaration of ALLOWED) {
    it(`laisse passer « ${declaration} »`, () => {
      const verdict = assessVertical(declaration);
      expect(verdict.status, verdict.reason ?? '').toBe('ALLOWED');
    });
  }

  it('une déclaration vide ne refuse rien — l’absence n’est pas un aveu', () => {
    expect(assessVertical().status).toBe('ALLOWED');
    expect(assessVertical('', null, undefined).status).toBe('ALLOWED');
  });

  it('un mot qui CONTIENT un terme réservé n’est pas ce terme', () => {
    // La comparaison porte sur des mots entiers : « retailing » n'est pas
    // « detailing », et « scar » n'est pas « car ».
    expect(assessVertical('retailing').status).toBe('ALLOWED');
    expect(assessVertical('scar treatment clinic').status).toBe('ALLOWED');
  });
});

describe('la normalisation', () => {
  it('écrase la casse, les accents et la ponctuation', () => {
    expect(normalizeVerticalText('Esthétique-Automobile')).toBe('esthetique automobile');
    expect(normalizeVerticalText('  CAR__WASH  ')).toBe('car wash');
  });

  it('est stable : deux appels rendent le même verdict', () => {
    expect(assessVertical('car detailing')).toEqual(assessVertical('car detailing'));
  });
});

describe('la porte est dans le CHARGEUR, pas chez l’appelant', () => {
  it('assertVerticalAllowed lève, plutôt que de rendre un booléen qu’on peut ignorer', () => {
    expect(() => assertVerticalAllowed('auto detailing')).toThrow(ReservedVerticalError);
    expect(() => assertVerticalAllowed('plomberie')).not.toThrow();
  });

  it('le message rendu est générique — il ne décrit ni un opérateur, ni une autre instance', () => {
    expect(RESERVED_VERTICAL_MESSAGE).toBe(
      "Cette verticale n'est pas disponible dans cette édition de Hermes.",
    );
    expect(RESERVED_VERTICAL_MESSAGE).not.toMatch(/hermes-selfhost|operator|prospect|@/iu);
  });

  it('la configuration d’exemple livrée passe la porte', () => {
    // Si l'exemple livré était lui-même refusé, la première commande d'un
    // nouvel utilisateur échouerait sans qu'il ait rien fait de mal.
    expect(() => loadNiche('example-services')).not.toThrow();
    expect(() => loadCampaign('example-campaign')).not.toThrow();
  });
});
