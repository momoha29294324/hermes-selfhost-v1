import { describe, expect, it } from 'vitest';
import {
  ctaQualityScore,
  extractInternalLinks,
  extractPageFacts,
  matchVocabulary,
  stripTags,
  websiteQualityScore,
} from '@/lib/enrichment/websiteExtract';

const HTML = `<!doctype html>
<html><head>
<title>Atelier automobile à Lyon — TEC</title>
<meta name="description" content="Prestation standard intérieur, vente de produits et protection boutique en ligne à Lyon.">
</head>
<body>
<h1>Atelier automobile à Lyon</h1>
<h2>Protection boutique en ligne et correction de peinture</h2>
<a href="tel:06 01 41 17 24">06 01 41 17 24</a>
<a href="mailto:demo-prospect-c@gmail.com">Écrivez-nous</a>
<a href="https://www.instagram.com/demo_account_22">Instagram</a>
<a href="https://www.facebook.com/DemobravoAuto">Facebook</a>
<a href="/tarifs">Nos tarifs</a>
<a href="/contact">Contact</a>
<a href="/mentions-legales">Mentions</a>
<a href="https://autre-site.fr/x">Externe</a>
<p>Formule complète à partir de 250 € — Prendre rendez-vous</p>
<form action="/send"><input type="email" name="email"><button>Envoyer</button></form>
<script>var a = "instagram.com/ignoreme";</script>
</body></html>`;

describe('extractPageFacts', () => {
  const facts = extractPageFacts(HTML, 'https://demo-prospect-c.com/');

  it('reads the title and description', () => {
    expect(facts.title).toContain('Atelier automobile');
    expect(facts.description).toContain('boutique en ligne');
  });

  it('collects contact channels actually present', () => {
    expect(facts.emails).toContain('demo-prospect-c@gmail.com');
    expect(facts.phones.length).toBeGreaterThan(0);
    expect(facts.instagram).toContain('demo_account_22');
    expect(facts.facebook).toContain('DemobravoAuto');
    expect(facts.hasTelLink).toBe(true);
    expect(facts.hasMailtoLink).toBe(true);
    expect(facts.hasContactForm).toBe(true);
  });

  it('detects CTA and price mentions', () => {
    expect(facts.ctaTexts.join(' ')).toMatch(/rendez-?vous/i);
    expect(facts.priceMentions).toContain('250 €');
  });

  it('does not invent a booking system', () => {
    expect(facts.bookingProviders).toEqual([]);
  });

  it('keeps only interesting internal links', () => {
    const links = extractInternalLinks(HTML, 'https://demo-prospect-c.com/');
    expect(links).toContain('https://demo-prospect-c.com/tarifs');
    expect(links).toContain('https://demo-prospect-c.com/contact');
    expect(links.some((link) => link.includes('autre-site.fr'))).toBe(false);
    expect(links.some((link) => link.includes('mentions-legales'))).toBe(false);
  });
});

describe('stripTags', () => {
  it('removes scripts and collapses whitespace', () => {
    const text = stripTags(HTML);
    expect(text).not.toContain('ignoreme');
    expect(text).toContain('Formule complète');
  });
});

describe('matchVocabulary', () => {
  it('matches accent-insensitively and never returns unseen terms', () => {
    const found = matchVocabulary(stripTags(HTML), ['boutique en ligne', 'vente de produits', 'revente']);
    expect(found).toContain('boutique en ligne');
    expect(found).not.toContain('revente');
  });
});

describe('quality scores', () => {
  const facts = [extractPageFacts(HTML, 'https://demo-prospect-c.com/')];

  it('rewards observable commercial structure', () => {
    const quality = websiteQualityScore(facts, ['boutique en ligne', 'vente de produits', 'prestation standard intérieur']);
    expect(quality.ratio).toBeGreaterThan(0);
    expect(quality.reasons.length).toBeGreaterThan(0);
  });

  it('rewards a reachable call to action', () => {
    const cta = ctaQualityScore(facts);
    expect(cta.ratio).toBeGreaterThan(0.5);
  });

  it('returns zero for an empty crawl rather than guessing', () => {
    expect(websiteQualityScore([], []).ratio).toBe(0);
    expect(ctaQualityScore([]).ratio).toBe(0);
  });
});
