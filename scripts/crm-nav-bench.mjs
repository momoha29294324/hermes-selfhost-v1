/**
 * CRM-UX-R1 — mesure de la navigation du CRM.
 *
 * ---------------------------------------------------------------------------
 * Ce que cet outil mesure, et pourquoi il en mesure DEUX
 * ---------------------------------------------------------------------------
 *
 * Une seule question compte pour un opérateur : « combien de temps entre mon
 * clic et le moment où je vois la donnée ? ». Elle se décompose en deux
 * chiffres qu'il ne faut jamais confondre :
 *
 *   soft — la navigation CLIENTE, celle que produit un `Link`. Seul le segment
 *          sous la coquille change ; le rail n'est pas remonté.
 *   hard — le chargement de DOCUMENT, celui que produisait une ancre nue :
 *          le navigateur jette la page et la reconstruit entièrement.
 *
 * Le mode `hard` n'est pas là pour la nostalgie : c'est la seule façon de
 * chiffrer honnêtement ce que la bascule vers `Link` a rapporté, en gardant la
 * même page, la même base et la même machine.
 *
 * ---------------------------------------------------------------------------
 * Deux précautions de mesure, apprises en se trompant
 * ---------------------------------------------------------------------------
 *
 *   1. On attend le CONTENU, jamais le titre. Le squelette de `loading.tsx`
 *      porte déjà le vrai titre de la page — s'arrêter là mesurerait la
 *      vitesse d'affichage du squelette, c'est-à-dire presque rien.
 *   2. On ne clique jamais pendant qu'une route est encore en vol. Une mesure
 *      prise ainsi attribue à la route suivante le temps de la précédente, ce
 *      qui produit des chiffres bimodaux impossibles à interpréter.
 *
 * Usage :
 *   node scripts/crm-nav-bench.mjs                    # soft, sur le dev
 *   BASE=http://localhost:3230 MODE=hard node scripts/crm-nav-bench.mjs
 *   MODE=profile node scripts/crm-nav-bench.mjs       # squelette vs contenu
 */

import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://localhost:3231';
const MODE = process.env.MODE ?? 'soft';
const LABEL = process.env.LABEL ?? MODE;
const ROUNDS = Number(process.env.ROUNDS ?? 4);

/** Chaque route, et le sélecteur qui prouve que sa DONNÉE est là. */
const TARGETS = [
  ['/crm/prospects', 'Prospects', '.crm-table, .crm-empty'],
  ['/crm/pipeline', 'Pipeline', '.crm-board .crm-pcard, .crm-empty'],
  ['/crm/inbox', 'Inbox', '.crm-table, .crm-empty'],
  ['/crm/alerts', 'Alertes', '.crm-table, .crm-empty'],
];

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? null : s[Math.floor(s.length / 2)];
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1512, height: 850 } });

/** Le squelette est parti ET la donnée est là. */
function settled([title, selector]) {
  return (
    document.querySelector('.crm-head h1')?.textContent?.trim() === title &&
    document.querySelector('p.crm-sr[role="status"]') === null &&
    document.querySelector(selector) !== null
  );
}

async function softRun() {
  let hardLoads = 0;
  page.on('load', () => {
    hardLoads += 1;
  });

  async function click(href, title, selector) {
    const t0 = Date.now();
    await page.click(`.crm-rail a[href="${href}"]`);
    await page.waitForFunction(settled, [title, selector], { timeout: 90000, polling: 'raf' });
    return Date.now() - t0;
  }

  await page.goto(`${BASE}/crm/prospects`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForSelector('.crm-table, .crm-empty', { timeout: 180000 });
  // `window` est remis à zéro par un chargement de document, jamais par une
  // navigation cliente : c'est la preuve la plus directe qu'aucune n'a eu lieu.
  await page.evaluate(() => {
    window.__crmStamp = 'kept';
  });
  const booted = hardLoads;

  const cold = {};
  for (const [href, title, selector] of TARGETS.slice(1)) cold[href] = await click(href, title, selector);
  cold['/crm/prospects'] = await click(...TARGETS[0]);

  const warm = Object.fromEntries(TARGETS.map(([href]) => [href, []]));
  for (let round = 0; round < ROUNDS; round += 1) {
    for (const [href, title, selector] of TARGETS) {
      if (new URL(page.url()).pathname === href) continue;
      warm[href].push(await click(href, title, selector));
    }
  }

  console.log(`\n=== ${LABEL.toUpperCase()} — clic → CONTENU (navigation cliente, ms) ===`);
  for (const [href] of TARGETS) {
    console.log(
      `${href.padEnd(17)} cold ${String(cold[href]).padStart(5)}   warm med ${String(median(warm[href])).padStart(5)}   [${warm[href].join(', ')}]`,
    );
  }
  const kept = await page.evaluate(() => window.__crmStamp === 'kept');
  console.log(`coquille jamais remontée : ${kept} · rechargements de document : ${hardLoads - booted}`);
}

async function hardRun() {
  const out = Object.fromEntries(TARGETS.map(([href]) => [href, []]));
  for (let round = 0; round < ROUNDS; round += 1) {
    for (const [href, , selector] of TARGETS) {
      const t0 = Date.now();
      await page.goto(`${BASE}${href}`, { waitUntil: 'commit', timeout: 180000 });
      await page.waitForSelector(selector, { timeout: 180000 });
      out[href].push(Date.now() - t0);
    }
  }
  console.log(`\n=== ${LABEL.toUpperCase()} — chargement de DOCUMENT (ancien comportement, ms) ===`);
  for (const [href] of TARGETS) {
    console.log(`${href.padEnd(17)} med ${String(median(out[href])).padStart(5)}   [${out[href].join(', ')}]`);
  }
}

/**
 * Sépare « le clic a été pris » de « la donnée est là ».
 *
 * L'écart entre les deux n'est pas du travail : quand une route retombe sur son
 * squelette, React refuse de le retirer avant environ 300 ms pour éviter un
 * clignotement. Ce plancher disparaît dès que le routeur a déjà la charge utile
 * — c'est-à-dire en production, où le préchargement existe.
 */
async function profileRun() {
  await page.goto(`${BASE}/crm/prospects`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForSelector('.crm-table, .crm-empty', { timeout: 180000 });
  await page.evaluate(() => {
    new MutationObserver(() => {
      if (window.__t0 === undefined) return;
      const skeleton = document.querySelector('p.crm-sr[role="status"]') !== null;
      const content = document.querySelector('.crm-table, .crm-board .crm-pcard, .crm-empty') !== null;
      if (skeleton && window.__tSkeleton === undefined) window.__tSkeleton = performance.now() - window.__t0;
      if (!skeleton && content && window.__tContent === undefined) window.__tContent = performance.now() - window.__t0;
    }).observe(document.body, { childList: true, subtree: true });
  });

  console.log(`\n=== ${LABEL.toUpperCase()} — squelette vs contenu (ms) ===`);
  for (let round = 0; round < ROUNDS; round += 1) {
    for (const [href] of TARGETS) {
      if (new URL(page.url()).pathname === href) continue;
      await page.evaluate(() => {
        window.__t0 = performance.now();
        window.__tSkeleton = undefined;
        window.__tContent = undefined;
      });
      await page.click(`.crm-rail a[href="${href}"]`);
      await page.waitForFunction(() => window.__tContent !== undefined, null, { timeout: 90000, polling: 'raf' });
      const marks = await page.evaluate(() => ({ s: window.__tSkeleton, c: window.__tContent }));
      console.log(
        `${href.padEnd(17)} squelette ${marks.s === undefined ? '  aucun' : `${marks.s.toFixed(0)} ms`.padStart(7)}   contenu ${`${marks.c.toFixed(0)} ms`.padStart(8)}`,
      );
    }
  }
}

if (MODE === 'hard') await hardRun();
else if (MODE === 'profile') await profileRun();
else await softRun();

await browser.close();
