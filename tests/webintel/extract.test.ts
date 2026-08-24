import { describe, expect, it } from 'vitest';
import {
  ALL_FUNNEL_SIGNALS,
  buildFunnelReport,
  extractContacts,
  extractDescription,
  extractFunnelFromPage,
  extractHeadings,
  extractInternalLinks,
  extractTitle,
  lastSegment,
  needsBrowserRender,
  stripTags,
} from '../../services/webintel/src/extract';

const SOURCE = 'https://www.demo-22-exemple.fr/';

function keys(html: string, source = SOURCE): string[] {
  return extractFunnelFromPage(html, source).map((observation) => observation.key);
}

describe('stripTags', () => {
  it('retire scripts, styles et commentaires', () => {
    const text = stripTags(
      '<html><head><style>.a{}</style><script>var x=1</script></head><body><!-- note --><p>Bonjour</p></body></html>',
    );
    expect(text).toBe('Bonjour');
  });

  it('décode les entités courantes', () => {
    expect(stripTags('<p>Tarifs&nbsp;: 90&nbsp;&euro;</p>')).toContain('Tarifs');
    expect(stripTags("<p>l&#39;atelier</p>")).toBe("l'atelier");
  });

  it('ne casse pas sur du HTML malformé', () => {
    expect(() => stripTags('<div><p>texte<div><span></body')).not.toThrow();
    expect(stripTags('<div><p>texte<div><span></body')).toBe('texte');
  });

  it('coupe une balise tronquée en fin de réponse', () => {
    // What a body capped at maxResponseBytes actually looks like: the last tag
    // is cut mid-attribute, and its contents must not become page text.
    expect(stripTags('<p>Nos prestations</p><a href="/tarifs')).toBe('Nos prestations');
  });
});

describe('extractContacts', () => {
  it('lit e-mails, téléphones et réseaux publics', () => {
    const html = `
      <a href="mailto:contact@exemple.fr">Écrire</a>
      <a href="tel:+33481659709">04 81 65 97 09</a>
      <a href="https://www.instagram.com/demo_account_11/">Instagram</a>
      <a href="https://www.facebook.com/ExempleAtelier">Facebook</a>
      <a href="https://www.tiktok.com/@exemple">TikTok</a>
      <a href="https://wa.me/33612345678">WhatsApp</a>`;
    const contacts = extractContacts(html);
    expect(contacts.emails).toContain('contact@exemple.fr');
    expect(contacts.phones).toContain('+33481659709');
    expect(contacts.instagram).toEqual(['demo_account_11']);
    expect(contacts.facebook).toEqual(['ExempleAtelier']);
    expect(contacts.tiktok).toEqual(['exemple']);
    expect(contacts.whatsapp).toEqual(['33612345678']);
  });

  it('écarte les faux e-mails issus de noms de fichiers', () => {
    expect(extractContacts('<img src="sprite@2x.png">').emails).not.toContain('sprite@2x.png');
  });

  it('rend des listes vides sur une page sans contact', () => {
    const contacts = extractContacts('<html><body><p>Rien ici</p></body></html>');
    expect(contacts.emails).toEqual([]);
    expect(contacts.instagram).toEqual([]);
  });
});

describe('extractTitle / description / headings', () => {
  it('lit le titre, la description et les intertitres', () => {
    const html = `<html><head><title>  Atelier à Lyon  </title>
      <meta name="description" content="Traitement boutique en ligne et REVENTE."></head>
      <body><h1>Nos prestations</h1><h2>Boutique en ligne</h2><h2>Boutique en ligne</h2></body></html>`;
    expect(extractTitle(html)).toBe('Atelier à Lyon');
    expect(extractDescription(html)).toBe('Traitement boutique en ligne et REVENTE.');
    expect(extractHeadings(html)).toEqual(['Nos prestations', 'Boutique en ligne']);
  });

  it('retombe sur og:description', () => {
    expect(
      extractDescription('<meta property="og:description" content="Depuis 2015 à Limonest">'),
    ).toBe('Depuis 2015 à Limonest');
  });

  it('rend null quand rien n’est déclaré', () => {
    expect(extractTitle('<html><body></body></html>')).toBeNull();
    expect(extractDescription('<html></html>')).toBeNull();
  });
});

describe('extractFunnelFromPage', () => {
  it('relève les appels à l’action observables', () => {
    const html = `
      <a href="tel:+33481659709">Appelez-nous</a>
      <a href="https://wa.me/33612345678">WhatsApp</a>
      <a href="https://www.instagram.com/exemple/">Instagram</a>
      <a href="mailto:contact@exemple.fr">Mail</a>
      <p>Prenez rendez-vous dès aujourd'hui</p>`;
    const found = keys(html);
    expect(found).toContain('cta_primary');
    expect(found).toContain('cta_phone');
    expect(found).toContain('cta_whatsapp');
    expect(found).toContain('cta_instagram');
    expect(found).toContain('cta_email');
  });

  it('ne compte un formulaire que s’il porte un champ à remplir', () => {
    expect(keys('<form><button>Rechercher</button></form>')).not.toContain('form_contact');
    expect(keys('<form><input type="email" name="email"><textarea name="message"></textarea></form>')).toContain(
      'form_contact',
    );
  });

  it('reconnaît un formulaire de devis', () => {
    const found = keys(
      '<form><input name="nom"><textarea name="message">Votre demande de devis</textarea></form>',
    );
    expect(found).toContain('form_quote');
  });

  it('reconnaît un prestataire de réservation et son iframe', () => {
    const found = keys('<iframe src="https://calendly.com/exemple/30min"></iframe>');
    expect(found).toContain('booking_online');
    expect(found).toContain('calendar_embed');
  });

  it('relève les traceurs publiquement observables', () => {
    const html = `
      <script src="https://www.googletagmanager.com/gtag/js?id=G-ABC123"></script>
      <script>fbq('init', '123456789');</script>
      <script src="https://www.clarity.ms/tag/xyz"></script>`;
    const found = keys(html);
    expect(found).toContain('analytics_google');
    expect(found).toContain('pixel_meta');
    expect(found).toContain('session_recording');
  });

  it('relève les prix affichés', () => {
    const observations = extractFunnelFromPage('<p>Prestation complet : 90 € — Boutique en ligne 1200€</p>', SOURCE);
    const price = observations.find((observation) => observation.key === 'price_displayed');
    expect(price?.value).toContain('90 €');
  });

  it('ancre page_services sur le dernier segment, pas sur la chaîne entière', () => {
    // A share button whose query string contains "nos-services" must not be
    // read as a services page — this exact case appeared on a real crawl.
    const sharer =
      '<a href="https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fexemple.fr%2Fnos-services">Partager</a>';
    expect(keys(sharer)).not.toContain('page_services');

    expect(keys('<a href="/nos-prestations">Nos prestations</a>')).toContain('page_services');
    expect(keys('<a href="/tarifs">Tarifs</a>')).toContain('page_pricing');
  });

  it('ignore un libellé trop long pour être un élément de navigation', () => {
    const html =
      '<a href="/actualites/article-1">Nous proposons des prestations sur mesure pour votre véhicule de collection</a>';
    expect(keys(html)).not.toContain('page_services');
  });

  it('ne relève rien sur une page vide, sans lever', () => {
    expect(() => extractFunnelFromPage('', SOURCE)).not.toThrow();
    expect(extractFunnelFromPage('', SOURCE)).toEqual([]);
  });

  it('survit à du HTML malformé', () => {
    const html = '<a href="/contact">Contact<div><form><input type="email"</form><p>Devis gratuit';
    expect(() => extractFunnelFromPage(html, SOURCE)).not.toThrow();
    expect(keys(html)).toContain('cta_primary');
  });

  it('ne casse pas sur un href non résolvable', () => {
    expect(() => extractFunnelFromPage('<a href="::::">x</a>', SOURCE)).not.toThrow();
  });
});

describe('buildFunnelReport', () => {
  it('sépare ce qui a été vu de ce qui a été cherché sans être vu', () => {
    const report = buildFunnelReport([
      { sourceUrl: SOURCE, observations: extractFunnelFromPage('<a href="tel:+33100000000">Appeler</a>', SOURCE) },
    ]);
    expect(report.observed.map((observation) => observation.key)).toContain('cta_phone');
    expect(report.checkedButNotObserved).toContain('booking_online');
    expect(report.pagesAnalysed).toEqual([SOURCE]);
  });

  it('couvre exactement le catalogue : vu + non vu = tous les signaux', () => {
    const report = buildFunnelReport([
      { sourceUrl: SOURCE, observations: extractFunnelFromPage('<a href="tel:+33100000000">x</a>', SOURCE) },
    ]);
    const seen = new Set(report.observed.map((observation) => observation.key));
    for (const key of ALL_FUNNEL_SIGNALS) {
      expect(seen.has(key) || report.checkedButNotObserved.includes(key), key).toBe(true);
    }
  });

  it('ne dit jamais qu’un signal est absent — seulement non observé', () => {
    const report = buildFunnelReport([{ sourceUrl: SOURCE, observations: [] }]);
    // The type carries the meaning: there is no field that asserts absence.
    expect(report).not.toHaveProperty('absent');
    expect(report.checkedButNotObserved).toEqual(ALL_FUNNEL_SIGNALS);
    expect(report.observed).toEqual([]);
  });

  it('conserve la provenance page par page', () => {
    const report = buildFunnelReport([
      { sourceUrl: 'https://a.fr/', observations: extractFunnelFromPage('<a href="tel:+331">x</a>', 'https://a.fr/') },
      {
        sourceUrl: 'https://a.fr/tarifs',
        observations: extractFunnelFromPage('<p>90 €</p>', 'https://a.fr/tarifs'),
      },
    ]);
    const price = report.observed.find((observation) => observation.key === 'price_displayed');
    expect(price?.sourceUrl).toBe('https://a.fr/tarifs');
    expect(report.pagesAnalysed).toEqual(['https://a.fr/', 'https://a.fr/tarifs']);
  });
});

describe('extractInternalLinks', () => {
  it('classe les pages commerciales avant les articles', () => {
    const html = `
      <a href="/actualites/kapital-care-au-rallye-du-coeur-a-lyon-equipe-presente">Actu</a>
      <a href="/contact">Contact</a>
      <a href="/nos-prestations">Prestations</a>`;
    const links = extractInternalLinks(html, 'https://exemple.fr/', 'exemple.fr');
    expect(links[0]).toBe('https://exemple.fr/contact');
    expect(links[1]).toBe('https://exemple.fr/nos-prestations');
  });

  it('ne sort jamais du domaine autorisé', () => {
    const html = '<a href="https://autre.fr/contact">Ailleurs</a><a href="/contact">Ici</a>';
    expect(extractInternalLinks(html, 'https://exemple.fr/', 'exemple.fr')).toEqual([
      'https://exemple.fr/contact',
    ]);
  });

  it('traite www comme le même hôte', () => {
    const html = '<a href="https://www.exemple.fr/tarifs">Tarifs</a>';
    expect(extractInternalLinks(html, 'https://exemple.fr/', 'exemple.fr')).toEqual([
      'https://www.exemple.fr/tarifs',
    ]);
  });

  it('écarte les fichiers et les schémas non http', () => {
    const html = `<a href="/plaquette.pdf">PDF</a><a href="mailto:x@y.fr">Mail</a>
                  <a href="tel:+331">Tel</a><a href="/contact">Contact</a>`;
    expect(extractInternalLinks(html, 'https://exemple.fr/', 'exemple.fr')).toEqual([
      'https://exemple.fr/contact',
    ]);
  });

  it('ne retient rien sur une page sans lien pertinent', () => {
    expect(extractInternalLinks('<a href="/mentions-legales">ML</a>', 'https://exemple.fr/', 'exemple.fr')).toEqual(
      [],
    );
  });
});

describe('lastSegment', () => {
  it('rend le dernier segment sans extension', () => {
    expect(lastSegment('/nos-prestations/')).toBe('nos-prestations');
    expect(lastSegment('/a/b/contact.html')).toBe('contact');
    expect(lastSegment('/')).toBe('');
  });
});

describe('needsBrowserRender', () => {
  it('demande un rendu sur une coquille JavaScript', () => {
    const shell = '<html><body><div id="root"></div><script src="/static/js/main.abc.js"></script></body></html>';
    expect(needsBrowserRender(shell)).toEqual({ needed: true, reason: 'js_app_shell' });
  });

  it('demande un rendu sur un corps vide', () => {
    expect(needsBrowserRender('')).toEqual({ needed: true, reason: 'empty_body' });
  });

  it('ne demande pas de rendu sur une page déjà lisible', () => {
    const page = `<html><body><h1>Atelier</h1><p>${'Nous proposons du vente de produits. '.repeat(20)}</p></body></html>`;
    expect(needsBrowserRender(page)).toEqual({ needed: false, reason: null });
  });

  it('demande un rendu sur une page presque vide de texte', () => {
    expect(needsBrowserRender('<html><body><p>Chargement…</p></body></html>').needed).toBe(true);
  });
});
