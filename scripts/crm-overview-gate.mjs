/**
 * CRM-UX-R1 — la porte « la vue d'ensemble ne défile pas ».
 *
 * ---------------------------------------------------------------------------
 * Pourquoi mesurer le DÉFILEMENT ne suffit pas
 * ---------------------------------------------------------------------------
 *
 * Le panneau de la vue d'ensemble est en `overflow: hidden` : c'est ce qui tient
 * la promesse de l'onglet. Mais cela veut dire qu'une carte qui dépasse sa
 * colonne n'est pas rendue défilante — elle est COUPÉE. `scrollHeight` vaut
 * alors exactement `clientHeight`, et un contrôle qui ne regarderait que lui
 * déclarerait la page conforme au moment précis où elle perd de l'information.
 *
 * Ce script mesure donc TROIS choses, et la deuxième est celle qui compte :
 *
 *   1. le panneau ne défile pas verticalement ;
 *   2. aucune carte ne dépasse le bas de sa colonne ;
 *   3. le document ne déborde pas horizontalement.
 *
 * Il tourne sur un échantillon de fiches réelles et à trois largeurs, parce que
 * la hauteur d'une carte dépend de la longueur des phrases écrites par le
 * pipeline — qui varie du simple au quadruple d'un prospect à l'autre.
 *
 * Usage :
 *   npm run db:psql -- "select id from prospects where dedupe_status <> 'merged' \
 *     order by md5(id::text) limit 24" | grep -o '"[0-9a-f-]\{36\}"' | tr -d '"' > var/sample-ids.txt
 *   BASE=http://localhost:3231 node scripts/crm-overview-gate.mjs var/sample-ids.txt
 *
 * Sort en code 1 dès le premier écart : c'est une PORTE, pas un rapport.
 */

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:3231';
const LIST = process.argv[2] ?? 'var/sample-ids.txt';

/**
 * Les trois fenêtres de référence.
 *
 * La plus BASSE décide : une vue qui tient dans 780 px tient partout ailleurs.
 * La plus ÉTROITE est là pour une raison différente — sous 1180 px la grille
 * repasse à deux colonnes et redevient défilante, ce qui est assumé ; 1280 px
 * vérifie qu'on est encore du bon côté de cette bascule.
 */
const VIEWPORTS = [
  [1512, 850, 'MacBook Pro 14'],
  [1440, 780, 'MacBook Air 13'],
  [1280, 800, 'bureau étroit'],
];

const ids = readFileSync(LIST, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0);

if (ids.length === 0) throw new Error(`Aucun identifiant dans ${LIST}`);

function audit() {
  const panel = document.querySelector('#crm-panel-overview');
  const clipped = [];
  document.querySelectorAll('#crm-panel-overview .crm-pane').forEach((pane, index) => {
    const bottom = pane.getBoundingClientRect().bottom;
    pane.querySelectorAll(':scope > .crm-card').forEach((card) => {
      const over = Math.round(card.getBoundingClientRect().bottom - bottom);
      if (over > 1) clipped.push(`col${index + 1}:${card.querySelector('h2')?.textContent ?? '?'}+${over}px`);
    });
  });
  const doc = document.scrollingElement;
  return {
    clipped,
    vertical: panel.scrollHeight - panel.clientHeight,
    horizontal: doc.scrollWidth - doc.clientWidth,
    name: document.querySelector('.crm-phead-id h1')?.textContent ?? '?',
  };
}

const browser = await chromium.launch();
let failures = 0;
let checked = 0;

for (const [width, height, label] of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width, height } });
  const bad = [];
  for (const id of ids) {
    await page.goto(`${BASE}/crm/prospects/${id}`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForSelector('.crm-panes', { timeout: 60000 });
    await page.waitForTimeout(140);
    const result = await page.evaluate(audit);
    checked += 1;
    if (result.clipped.length > 0 || result.vertical > 1 || result.horizontal > 0) {
      failures += 1;
      bad.push(
        `${result.name.slice(0, 30).padEnd(30)} défilement +${result.vertical} · horizontal +${result.horizontal} · ${result.clipped.join(', ')}`,
      );
    }
  }
  console.log(
    `${label.padEnd(16)} ${width}×${height} — ${ids.length} fiches : ${bad.length === 0 ? 'toutes conformes' : `${bad.length} ÉCHEC(S)`}`,
  );
  for (const line of bad) console.log(`   ${line}`);
  await page.close();
}

console.log(`\n${checked} contrôles, ${failures} échec(s)`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
