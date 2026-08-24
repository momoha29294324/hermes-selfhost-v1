/**
 * CRM-UX-R1 — ce que la refonte opérateur n'a pas le droit de perdre.
 *
 * ---------------------------------------------------------------------------
 * Ce qui se teste ici, et ce qui ne s'y teste pas
 * ---------------------------------------------------------------------------
 *
 * Deux familles, comme dans `crmProspectUi.test.ts` :
 *
 *   1. les fonctions PURES nées de ce round — pagination, vocabulaire — sont
 *      testées comme telles ;
 *   2. les invariants d'ARCHITECTURE qu'aucun type ne protège sont vérifiés sur
 *      le source et la feuille de style. Une refonte visuelle est exactement le
 *      moment où « la racine ouvre sur le CRM » ou « la vue d'ensemble ne
 *      défile pas » se perdent sans que rien ne casse.
 *
 * Ce qui ne s'y teste PAS : la hauteur réelle rendue. Elle dépend d'un
 * navigateur, d'une base et de la longueur des phrases du pipeline — elle est
 * mesurée par `npm run crm:overview-gate`, qui ouvre 24 fiches réelles à trois
 * largeurs. Réimplémenter cette mesure ici en JSDOM produirait un chiffre qui
 * n'aurait aucun rapport avec ce que voit un opérateur, et le pire des rapports
 * de test est celui qui rassure à tort.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';
import { CRM_PAGE_SIZE, paginate, parsePage } from '@/lib/crm/paginate';
import { CRM_HOME } from '@/lib/crm/routes';
import {
  alertStatusTerm,
  correlationTerm,
  draftStatusTerm,
  nextActionTerm,
  replyCategoryTerm,
  severityTerm,
} from '@/lib/crm/vocabulary';
import { CRM_TONES, LANE_TONE } from '@/lib/crm/view';
import { REPLY_CATEGORIES } from '@/lib/replies/taxonomy';

const CRM_DIR = resolve(process.cwd(), 'src/app/crm');
const CRM_CSS = resolve(process.cwd(), 'src/app/crm/crm.css');

/**
 * Le source SANS ses commentaires.
 *
 * Ces contrôles lisent du code pour vérifier ce qu'il fait. Un commentaire qui
 * EXPLIQUE une règle — « `router.push` et non `location.assign` », « pourquoi
 * `prefetch={false}` » — contient forcément les mots de cette règle, et les
 * compter revient à sanctionner le fait de l'avoir documentée. Les trois
 * premiers échecs de ce fichier étaient exactement cela.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function crmSources(dir: string = CRM_DIR): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...crmSources(full));
    else if (entry.name.endsWith('.tsx'))
      out.push({ file: full, text: code(readFileSync(full, 'utf8')) });
  }
  return out;
}

function css(): string {
  return readFileSync(CRM_CSS, 'utf8');
}

// ---------------------------------------------------------------------------
// §1 — la racine ouvre sur le CRM
// ---------------------------------------------------------------------------

describe('la porte d’entrée', () => {
  it('renvoie `/` vers le CRM, et non vers l’atelier de revue', async () => {
    const redirects = await nextConfig.redirects?.();
    expect(redirects).toBeDefined();
    const root = redirects?.find((entry) => entry.source === '/');
    expect(root, 'aucune redirection déclarée pour `/`').toBeDefined();
    expect(root?.destination).toBe(CRM_HOME);
  });

  /**
   * 307 et non 308 : un 308 est mis en cache par le navigateur SANS date de
   * péremption. Changer un jour la porte d'entrée du CRM resterait alors
   * impossible à défaire chez quiconque a ouvert la page une fois.
   */
  it('utilise une redirection TEMPORAIRE, jamais permanente', async () => {
    const redirects = (await nextConfig.redirects?.()) ?? [];
    for (const entry of redirects) {
      expect(entry.permanent, `${entry.source} ne doit pas être permanente`).toBe(false);
    }
  });


  it('ne laisse aucune page réclamer `/` en concurrence de la redirection', () => {
    // `src/app/page.tsx` et `src/app/(review)/page.tsx` rendraient tous deux
    // `/`. La redirection étant évaluée avant le système de fichiers, une telle
    // page serait du code mort — et le prochain lecteur croirait qu'elle sert.
    for (const candidate of ['src/app/page.tsx', 'src/app/(review)/page.tsx']) {
      let exists = true;
      try {
        readFileSync(resolve(process.cwd(), candidate), 'utf8');
      } catch {
        exists = false;
      }
      expect(exists, `${candidate} ne doit pas exister`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// §6 — la navigation est CLIENTE
// ---------------------------------------------------------------------------

describe('la navigation du CRM', () => {
  /**
   * Le défaut d'origine : pas une ligne du dépôt n'importait `next/link`, donc
   * chaque clic rechargeait le document entier — 2 443 ms mesurées sur la liste
   * des prospects, contre 76 ms en navigation cliente.
   */
  it('n’utilise plus une seule ancre nue vers une route interne', () => {
    for (const { file, text } of crmSources()) {
      const internal = text.match(/<a\s[^>]*href=(?:"\/|\{`\/)/g) ?? [];
      expect(internal, `${file} porte une ancre nue vers une route interne`).toHaveLength(0);
    }
  });

  it('ne renvoie jamais un clavier vers un rechargement de document', () => {
    for (const { file, text } of crmSources()) {
      expect(text, `${file} ne doit pas recharger la page`).not.toMatch(/location\.assign\s*\(/);
      expect(text, `${file} ne doit pas recharger la page`).not.toMatch(/location\.href\s*=/);
    }
  });

  /**
   * Le préchargement est le réflexe, et il est ici du gaspillage : les routes
   * du CRM sont `force-dynamic`, donc jamais mises en cache côté client. Mesuré
   * au navigateur : le rail déclenchait onze requêtes de préchargement par
   * chargement de page — `/revue` compris — et chaque clic refaisait malgré
   * tout la sienne.
   */
  it('coupe le préchargement sur les liens du rail', () => {
    const nav = code(readFileSync(join(CRM_DIR, 'nav.tsx'), 'utf8'));
    const links = nav.match(/<Link\b/g) ?? [];
    const disabled = nav.match(/prefetch=\{false\}/g) ?? [];
    expect(links.length).toBeGreaterThan(0);
    expect(disabled.length, 'chaque lien du rail doit couper le préchargement').toBe(links.length);
  });

  it('donne au rail un retour visuel qui ne dépend pas du serveur', () => {
    const nav = readFileSync(join(CRM_DIR, 'nav.tsx'), 'utf8');
    // `usePathname` ne bouge qu'APRÈS la réponse : s'y fier seul rendrait le
    // rail muet pendant tout le trajet.
    expect(nav).toContain('onNavigate');
    expect(nav).toContain('useLinkStatus');
    expect(css()).toContain('.crm-rail-pending');
  });

  /**
   * Le clic de ligne est du JAVASCRIPT, et c'est une correction, pas un choix.
   * Le réflexe — étendre le lien du nom par un calque absolu sur un `<tr>` en
   * `position: relative` — ne marche pas : une ligne de tableau n'est pas un
   * bloc conteneur fiable pour un descendant absolu, et le calque ne recevait
   * aucun clic. Mesuré au navigateur, pas déduit.
   */
  it('rend la ligne entière cliquable sans calque absolu', () => {
    const nav = code(readFileSync(join(CRM_DIR, 'row-nav.tsx'), 'utf8'));
    expect(nav).toContain("tr[data-href]");
    expect(nav).toContain('router.push');
    expect(css()).not.toMatch(/\.crm-ident \.name::after/);
  });

  /**
   * Un raccourci de confort ne doit rien confisquer : les gestes du navigateur
   * (nouvel onglet, nouvelle fenêtre), les éléments déjà interactifs et une
   * sélection de texte en cours gardent leur effet.
   */
  it('ne confisque ni les gestes du navigateur ni ce qui est déjà interactif', () => {
    const nav = code(readFileSync(join(CRM_DIR, 'row-nav.tsx'), 'utf8'));
    expect(nav).toMatch(/event\.button !== 0/);
    expect(nav).toMatch(/metaKey/);
    expect(nav).toMatch(/ctrlKey/);
    expect(nav).toMatch(/shiftKey/);
    expect(nav).toMatch(/closest\('a, button/);
    expect(nav).toMatch(/getSelection/);
  });

  it('respecte une demande de mouvement réduit', () => {
    expect(css()).toContain('prefers-reduced-motion');
  });
});

// ---------------------------------------------------------------------------
// §6 — la charge utile
// ---------------------------------------------------------------------------

describe('la pagination des listes', () => {
  const rows = Array.from({ length: 424 }, (_, index) => index);

  it('borne ce qui est rendu, sans toucher au lot', () => {
    const page = paginate(rows, 1);
    expect(page.rows).toHaveLength(CRM_PAGE_SIZE);
    expect(page.total).toBe(424);
    expect(page.pages).toBe(Math.ceil(424 / CRM_PAGE_SIZE));
    expect(page.from).toBe(1);
    expect(page.to).toBe(CRM_PAGE_SIZE);
  });

  it('rend un rang lisible plutôt qu’un simple numéro de page', () => {
    const page = paginate(rows, 3);
    expect(page.from).toBe(2 * CRM_PAGE_SIZE + 1);
    expect(page.to).toBe(3 * CRM_PAGE_SIZE);
    expect(page.rows[0]).toBe(2 * CRM_PAGE_SIZE);
  });

  /**
   * Retirer un filtre depuis la page 7 ne doit pas donner un écran blanc dont
   * on ne comprend pas la cause.
   */
  it('ramène une page au-delà de la fin sur la dernière, jamais sur du vide', () => {
    const page = paginate(rows, 9999);
    expect(page.page).toBe(page.pages);
    expect(page.rows.length).toBeGreaterThan(0);
  });

  it('survit à une liste vide sans prétendre à une page zéro', () => {
    const page = paginate([], 1);
    expect(page).toMatchObject({ page: 1, pages: 1, total: 0, from: 0, to: 0 });
    expect(page.rows).toHaveLength(0);
  });

  it('retombe sur la première page devant une valeur illisible', () => {
    for (const value of ['', 'abc', '0', '-3', '1.5.2', null, undefined]) {
      expect(parsePage(value)).toBe(1);
    }
    expect(parsePage('7')).toBe(7);
  });

  it('ne perd aucune ligne : les pages recouvrent exactement le lot', () => {
    const seen: number[] = [];
    const pages = paginate(rows, 1).pages;
    for (let page = 1; page <= pages; page += 1) seen.push(...paginate(rows, page).rows);
    expect(seen).toEqual(rows);
  });
});

// ---------------------------------------------------------------------------
// §3/§4 — les mots et les poids
// ---------------------------------------------------------------------------

describe('le vocabulaire opérateur', () => {
  it('traduit sans perdre l’identifiant de la base', () => {
    const term = nextActionTerm('HUMAN_REPLY_NOW');
    expect(term).not.toBeNull();
    expect(term?.label).toBe('Répondre — maintenant');
    expect(term?.raw).toBe('HUMAN_REPLY_NOW');
    expect(term?.known).toBe(true);
  });

  /**
   * Le jour où la taxonomie gagne une valeur, l'écran doit l'AFFICHER brute
   * plutôt que de la deviner ou de la faire disparaître.
   */
  it('rend un identifiant inconnu tel quel, en le disant', () => {
    const term = nextActionTerm('UNE_VALEUR_QUI_N_EXISTE_PAS');
    expect(term?.label).toBe('UNE_VALEUR_QUI_N_EXISTE_PAS');
    expect(term?.known).toBe(false);
    expect(term?.tone).toBe('slate');
    expect(term?.tier).toBe(4);
  });

  it('rend `null` pour une absence, jamais un libellé inventé', () => {
    for (const resolve of [
      nextActionTerm,
      replyCategoryTerm,
      correlationTerm,
      draftStatusTerm,
      severityTerm,
      alertStatusTerm,
    ]) {
      expect(resolve(null)).toBeNull();
      expect(resolve(undefined)).toBeNull();
      expect(resolve('')).toBeNull();
    }
  });

  it('couvre toute la taxonomie des réponses — aucune catégorie orpheline', () => {
    for (const category of REPLY_CATEGORIES) {
      expect(replyCategoryTerm(category)?.known, category).toBe(true);
    }
  });

  it('n’attribue que des teintes déclarées', () => {
    const terms = [
      ...REPLY_CATEGORIES.map((value) => replyCategoryTerm(value)),
      nextActionTerm('HUMAN_REPLY_NOW'),
      correlationTerm('EXACT'),
      draftStatusTerm('PROPOSED'),
      severityTerm('URGENT'),
      alertStatusTerm('NO_PROVIDER'),
    ];
    for (const term of terms) expect(CRM_TONES).toContain(term?.tone);
  });

  /**
   * Comprendre un message n'est pas une consigne : deux paliers 1 côte à côte
   * reviendraient à n'en avoir aucun. Seule l'ACTION qui en découle peut être
   * de palier 1 — et une seule catégorie l'est, celle qui ferme une porte.
   */
  it('réserve le palier 1 à ce qui ne peut pas attendre', () => {
    const urgent = REPLY_CATEGORIES.filter((value) => replyCategoryTerm(value)?.tier === 1);
    expect(urgent).toEqual(['UNSUBSCRIBE']);
    expect(nextActionTerm('HUMAN_REPLY_NOW')?.tier).toBe(1);
    expect(nextActionTerm('NO_ACTION')?.tier).toBe(4);
  });

  /**
   * La corrélation exacte est le cas NORMAL. En palier 2 vif, elle dominait la
   * colonne d'action sur chaque ligne d'Inbox — la couleur disait « tout va
   * bien » là où l'écran devait dire « quelqu'un attend ».
   */
  it('fait reculer la corrélation ordinaire et remonter l’écart', () => {
    expect(correlationTerm('EXACT')?.tier).toBe(4);
    expect(correlationTerm('EXACT')?.tone).toBe('slate');
    expect(correlationTerm('UNMATCHED')?.tier).toBeLessThan(4);
    expect(correlationTerm('AMBIGUOUS')?.tier).toBeLessThan(4);
  });

  /**
   * Le rouge de ce CRM dit une porte fermée. Une alerte speed-to-lead ne ferme
   * rien : elle dit que quelqu'un attend.
   */
  it('ne peint pas une alerte en rouge — elle n’interdit rien', () => {
    expect(severityTerm('URGENT')?.tone).toBe('orange');
  });
});

// ---------------------------------------------------------------------------
// §4 — le violet appartient à l'application, pas au prospect
// ---------------------------------------------------------------------------

describe('la sémantique des teintes', () => {
  it('n’attribue le violet à AUCUN état commercial', () => {
    for (const [lane, tone] of Object.entries(LANE_TONE)) {
      expect(tone, `${lane} ne doit pas porter la teinte de la marque`).not.toBe('violet');
    }
  });

  it('déclare le cyan une fois, comme toutes les autres teintes', () => {
    const sheet = css();
    for (const tone of CRM_TONES) {
      expect(sheet, `la teinte ${tone} n’est pas déclarée`).toContain(`[data-tone='${tone}']`);
    }
  });
});

// ---------------------------------------------------------------------------
// §2/§12 — l'architecture qui rend la vue d'ensemble bornée
// ---------------------------------------------------------------------------

describe('la vue d’ensemble ne peut pas grandir', () => {
  const OVERVIEW = resolve(CRM_DIR, 'prospects/[id]/overview.tsx');

  /**
   * Le PANNEAU de la vue d'ensemble, et non son seul fichier de composition.
   *
   * CRM-R3 a sorti les trois cartes de synthèse de la recherche dans
   * `research.tsx` — la fiche impose qu'aucun de ses fichiers ne dépasse 420
   * lignes, et `overview.tsx` les dépassait. Les contrôles ci-dessous portent
   * sur ce que le panneau REND, pas sur le fichier où la ligne est écrite :
   * les lire sur `overview.tsx` seul reviendrait à interdire de découper un
   * fichier, ce que ce dépôt exige par ailleurs.
   */
  const overviewPanel = (): string =>
    ['overview.tsx', 'research.tsx']
      .map((name) => readFileSync(resolve(CRM_DIR, 'prospects/[id]', name), 'utf8'))
      .join('\n');

  it('borne le panneau plutôt que de le laisser défiler', () => {
    const sheet = css();
    const rule = sheet.match(/\.crm-panel\[data-tab='overview'\] \{[^}]+\}/);
    expect(rule, 'le panneau de la vue d’ensemble doit être borné').not.toBeNull();
    expect(rule?.[0]).toMatch(/overflow:\s*hidden/);
  });

  /**
   * Deux déclarations rendent la borne possible, et aucune n'est facultative :
   * la ligne de grille est bornée, et `min-height: 0` autorise un enfant de
   * grille à descendre sous la taille de son contenu.
   */
  it('borne la GRILLE, sans quoi les colonnes repousseraient la page', () => {
    const rule = css().match(/\.crm-panes \{[^}]+\}/);
    expect(rule).not.toBeNull();
    expect(rule?.[0]).toMatch(/grid-template-rows:\s*minmax\(0, 1fr\)/);
    expect(rule?.[0]).toMatch(/min-height:\s*0/);
    expect(rule?.[0]).toMatch(/minmax\(0,/);
  });

  it('donne le défilement aux CARTES, pas à la page', () => {
    const sheet = css();
    const fill = sheet.match(/\.crm-card-fill \{[^}]+\}/);
    const scroll = sheet.match(/\.crm-card-scroll \{[^}]+\}/);
    expect(fill?.[0]).toMatch(/flex:\s*1 1 0/);
    expect(scroll?.[0]).toMatch(/overflow-y:\s*auto/);
    expect(readFileSync(OVERVIEW, 'utf8')).toContain('crm-card-scroll');
  });

  /**
   * Le panneau est en `overflow: hidden` : une carte qui dépasse sa colonne
   * n'est pas rendue défilante, elle est COUPÉE. Une colonne dont toutes les
   * cartes sont fermes déborderait donc en silence.
   */
  it('garde une carte extensible par colonne', () => {
    const text = readFileSync(OVERVIEW, 'utf8');
    expect(text).toContain('crm-card-fill');
    expect(text).toContain('crm-card-firm');
  });

  /**
   * Ce que la hauteur bornée n'autorise PAS : perdre une donnée. Tout ce qui
   * est écourté porte son compte et un renvoi vers l'onglet qui le détaille.
   */
  it('écourte avec un renvoi, jamais en silence', () => {
    const text = overviewPanel();
    expect(text).toContain('TabLink');
    expect(text).toMatch(/Voir toute l’activité/);
    expect(text).toMatch(/Voir les \{research\.unknowns\.length\}/);
    expect(text).toContain('Voir l’analyse complète');
  });

  it('conserve la distinction « non observé » ≠ « inexistant »', () => {
    expect(readFileSync(OVERVIEW, 'utf8')).toContain('n’est pas « inexistant »');
  });

  /**
   * L'en-tête porte l'action, l'état, le canal et le dernier échange. Les y
   * répéter dans un panneau est précisément ce qui poussait la vue à 1 033 px.
   */
  it('ne répète pas dans le panneau ce que l’en-tête a déjà dit', () => {
    const text = readFileSync(OVERVIEW, 'utf8');
    expect(text).not.toContain('NextActionCard');
    expect(text).not.toMatch(/Prochaine action/);
    expect(text).not.toMatch(/Dernier envoi/);
    expect(text).not.toMatch(/crm-state-line/);
  });

  it('garde une seule chose de palier 1 dans l’en-tête', () => {
    const header = readFileSync(resolve(CRM_DIR, 'prospects/[id]/header.tsx'), 'utf8');
    expect(header.match(/data-tier="1"/g) ?? []).toHaveLength(1);
    expect(header).toContain('crm-lead');
  });
});

// ---------------------------------------------------------------------------
// §14 — rien de tout cela n'ouvre un envoi
// ---------------------------------------------------------------------------

describe('le CRM reste en lecture seule', () => {
  /**
   * Le seul formulaire du CRM est celui de la RECHERCHE, et il est en `get` :
   * il construit une URL, il n'écrit rien. Un `post` ou une action serveur
   * seraient la première marche d'un chemin d'écriture — c'est cela que ce
   * contrôle interdit, pas la balise.
   */
  it('n’introduit aucune primitive d’envoi, nulle part dans le CRM', () => {
    for (const { file, text } of crmSources()) {
      expect(text, `${file}`).not.toContain("'use server'");
      expect(text, `${file}`).not.toMatch(/<textarea\b/);
      expect(text, `${file}`).not.toMatch(/\bsendMessage\b|\bsetKillSwitch\b|\bdispatch\(/);
      for (const form of text.match(/<form\b[^>]*>/g) ?? []) {
        expect(form, `${file} : un formulaire du CRM doit rester en lecture`).toMatch(
          /method="get"/,
        );
        expect(form, `${file} : un formulaire du CRM ne porte pas d'action serveur`).not.toMatch(
          /action=\{/,
        );
      }
    }
  });

  it('continue de dire à l’opérateur que rien ne part d’ici', () => {
    const nav = readFileSync(join(CRM_DIR, 'nav.tsx'), 'utf8');
    expect(nav).toContain('Lecture seule');
    expect(nav).toContain('Aucun envoi ne part d’ici.');
  });

  /**
   * Le vocabulaire TRADUIT, il ne décide pas. Aucune de ses tables ne doit
   * pouvoir servir de porte : une entrée qui parlerait d'envoi ou de politique
   * y ferait entrer une décision par la voie de l'affichage.
   */
  it('ne laisse pas le vocabulaire d’affichage toucher à une décision', () => {
    const text = readFileSync(resolve(process.cwd(), 'src/lib/crm/vocabulary.ts'), 'utf8');
    expect(text).not.toMatch(/import .* from '@\/lib\/(instagram|conversation|sales)\//);
    expect(text).not.toMatch(/allowSending|killSwitch|OUTBOUND_ALLOW_SENDING/);
  });
});
