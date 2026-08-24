import { describe, expect, it } from 'vitest';
import {
  collectRegistryIds,
  extractLegalMentions,
  findLegalPages,
  hasUsableMentions,
  isValidFrenchVat,
  isValidSiren,
  isValidSiret,
  luhnValid,
} from '@/lib/discovery/openweb/legalMentions';

/**
 * Les mentions légales sont le meilleur pont gratuit entre un domaine et une
 * identité légale. Le risque n'est pas de rater un SIREN — c'est d'en inventer
 * un à partir de neuf chiffres quelconques, puis d'attacher un prospect à la
 * mauvaise société. La clé de Luhn est ce qui sépare les deux.
 */

// SIREN réels et valides au sens de la clé (entreprises publiques connues).
const VALID_SIREN = '552100554'; // Danone
const VALID_SIREN_2 = '542107651'; // Total
const VALID_SIRET = '55210055400013';

describe('luhnValid', () => {
  it('accepte une suite conforme et refuse un chiffre modifié', () => {
    expect(luhnValid(VALID_SIREN)).toBe(true);
    expect(luhnValid('552100555')).toBe(false);
  });

  it('refuse tout ce qui n’est pas une suite de chiffres', () => {
    expect(luhnValid('55210055a')).toBe(false);
    expect(luhnValid('')).toBe(false);
  });
});

describe('isValidSiren / isValidSiret', () => {
  it('valide un SIREN à 9 chiffres et un SIRET à 14', () => {
    expect(isValidSiren(VALID_SIREN)).toBe(true);
    expect(isValidSiren('552 100 554')).toBe(true);
    expect(isValidSiret(VALID_SIRET)).toBe(true);
  });

  it('refuse une longueur incorrecte', () => {
    expect(isValidSiren('55210055')).toBe(false);
    expect(isValidSiret(VALID_SIREN)).toBe(false);
  });

  it('refuse neuf chiffres arbitraires — c’est tout l’intérêt de la clé', () => {
    expect(isValidSiren('123456789')).toBe(false);
    expect(isValidSiren('000000001')).toBe(false);
  });

  it('traite l’exception La Poste plutôt que d’assouplir le contrôle', () => {
    expect(isValidSiren('356000000')).toBe(true);
    // Somme des chiffres multiple de 5 : la règle propre à La Poste.
    expect(isValidSiret('35600000000047')).toBe(true);
    expect(isValidSiret('35600000000048')).toBe(false);
  });
});

describe('isValidFrenchVat', () => {
  it('vérifie la clé du numéro de TVA', () => {
    // clé = (12 + 3 × (SIREN mod 97)) mod 97
    const key = (12 + 3 * (Number.parseInt(VALID_SIREN, 10) % 97)) % 97;
    const vat = `FR${String(key).padStart(2, '0')}${VALID_SIREN}`;
    expect(isValidFrenchVat(vat)).toBe(true);
    expect(isValidFrenchVat(`FR00${VALID_SIREN}`)).toBe(false);
  });

  it('refuse un format non français', () => {
    expect(isValidFrenchVat('BE0123456789')).toBe(false);
  });
});

describe('findLegalPages', () => {
  const base = 'https://example.net/';

  it('trouve un lien par son chemin', () => {
    const html = '<a href="/mentions-legales">Infos</a><a href="/tarifs">Tarifs</a>';
    expect(findLegalPages(html, base)).toEqual(['https://example.net/mentions-legales']);
  });

  it('trouve un lien par son libellé quand l’URL est opaque', () => {
    const html = '<a href="/page-12">Mentions légales</a>';
    expect(findLegalPages(html, base)).toEqual(['https://example.net/page-12']);
  });

  it('ignore les liens externes et les fichiers', () => {
    const html =
      '<a href="https://autre.fr/mentions-legales">ML</a><a href="/cgv.pdf">CGV</a>';
    expect(findLegalPages(html, base)).toEqual([]);
  });

  it('borne le nombre de pages proposées', () => {
    const html = Array.from({ length: 12 }, (_, i) => `<a href="/legal-${i}">Mentions légales</a>`).join('');
    expect(findLegalPages(html, base).length).toBeLessThanOrEqual(4);
  });
});

describe('extractLegalMentions', () => {
  const url = 'https://example.net/mentions-legales';

  it('lit SIRET, raison sociale, adresse, ville et directeur de publication', () => {
    const html = `
      <h1>Mentions légales</h1>
      <p>Raison sociale : NORTHSTAR STUDIO SARL</p>
      <p>Siège social : 12 rue de la République, 69002 Lyon</p>
      <p>SIRET : ${VALID_SIRET}</p>
      <p>RCS Lyon</p>
      <p>Directeur de la publication : Jean Dupont</p>
    `;
    const mentions = extractLegalMentions(html, url);

    expect(mentions.siret).toBe(VALID_SIRET);
    expect(mentions.siren).toBe(VALID_SIREN);
    expect(mentions.legalName).toBe('NORTHSTAR STUDIO SARL');
    expect(mentions.addressLine).toContain('rue de la République');
    expect(mentions.postalCode).toBe('69002');
    expect(mentions.city).toBe('Lyon');
    expect(mentions.publicationDirector).toBe('Jean Dupont');
    expect(mentions.rcsCity).toBe('Lyon');
    expect(mentions.matchedLabels).toContain('siret');
  });

  it('accepte un SIREN espacé et un numéro de TVA', () => {
    const key = (12 + 3 * (Number.parseInt(VALID_SIREN, 10) % 97)) % 97;
    const html = `<p>SIREN : 552 100 554</p><p>TVA : FR${String(key).padStart(2, '0')} 552 100 554</p>`;
    const mentions = extractLegalMentions(html, url);
    expect(mentions.siren).toBe(VALID_SIREN);
    expect(mentions.vatNumber).toContain('FR');
  });

  it('retrouve le SIREN via la TVA quand il n’est pas écrit seul', () => {
    const key = (12 + 3 * (Number.parseInt(VALID_SIREN_2, 10) % 97)) % 97;
    const html = `<p>TVA intracommunautaire : FR${String(key).padStart(2, '0')}${VALID_SIREN_2}</p>`;
    const mentions = extractLegalMentions(html, url);
    expect(mentions.siren).toBe(VALID_SIREN_2);
    expect(mentions.matchedLabels).toContain('siren_via_tva');
  });

  it('n’invente pas un SIREN à partir d’un numéro quelconque', () => {
    const html = '<p>Référence produit 123456789 — commande 987654321</p>';
    const mentions = extractLegalMentions(html, url);
    expect(mentions.siren).toBeNull();
    expect(hasUsableMentions(mentions)).toBe(false);
  });

  it('renvoie des champs nuls sur une page sans mentions', () => {
    const mentions = extractLegalMentions('<p>Bienvenue sur notre site</p>', url);
    expect(mentions.siren).toBeNull();
    expect(mentions.legalName).toBeNull();
    expect(mentions.matchedLabels).toEqual([]);
  });

  it('reconnaît une raison sociale portée par sa forme juridique seule', () => {
    const mentions = extractLegalMentions('<p>SARL NORTHSTAR STUDIO au capital de 5000 €</p>', url);
    expect(mentions.legalName).toContain('NORTHSTAR STUDIO');
  });
});

describe('collectRegistryIds', () => {
  it('remonte tous les identifiants valides, pas seulement le premier', () => {
    // Cas réel : le site publie son SIREN et celui de son agence web.
    const html = `<p>SIREN : ${VALID_SIREN}</p><footer>Site réalisé par une agence — SIREN ${VALID_SIREN_2}</footer>`;
    const ids = collectRegistryIds(html);
    expect(ids.sirens).toContain(VALID_SIREN);
    expect(ids.sirens).toContain(VALID_SIREN_2);
  });

  it('déduit le SIREN d’un SIRET', () => {
    const ids = collectRegistryIds(`<p>SIRET ${VALID_SIRET}</p>`);
    expect(ids.sirets).toContain(VALID_SIRET);
    expect(ids.sirens).toContain(VALID_SIREN);
  });

  it('ne remonte rien quand aucun numéro n’est valide', () => {
    expect(collectRegistryIds('<p>111111111 222222222</p>').sirens).toEqual([]);
  });
});
