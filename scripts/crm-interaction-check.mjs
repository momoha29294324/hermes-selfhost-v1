/**
 * CRM-UX-R1 — les quatre gestes, vérifiés dans un vrai navigateur.
 *
 * Ce que ce script établit ne peut PAS l'être en JSDOM ni par lecture de
 * source : chacun de ces quatre points a échoué au moins une fois pendant le
 * round, et deux d'entre eux avaient l'air corrects dans le code.
 *
 *   1. LE RETOUR EST IMMÉDIAT. L'entrée cliquée devient active et son fil de
 *      progression s'allume PENDANT que l'écran affiche encore l'ancien titre.
 *      C'est la preuve que le rail ne dépend pas de la réponse du serveur — et
 *      aussi qu'il ne ment pas : il dit « c'est parti », pas « c'est arrivé ».
 *      La route est délibérément ralentie de 900 ms pour rendre l'instant
 *      observable.
 *
 *   2. LA LIGNE ENTIÈRE OUVRE LA FICHE. Le réflexe — étendre le lien par un
 *      calque absolu sur un `<tr>` en `position: relative` — NE MARCHE PAS :
 *      une ligne de tableau n'est pas un bloc conteneur fiable, et le calque ne
 *      recevait aucun clic. Seule une mesure au navigateur le montre.
 *
 *   3. LE CLAVIER PASSE PAR LE ROUTEUR. `j`/`k` surlignent, `Entrée` ouvre —
 *      sans rechargement de document.
 *
 *   4. `g i` MÈNE À L'INBOX, par le routeur lui aussi.
 *
 * Usage : BASE=http://localhost:3231 node scripts/crm-interaction-check.mjs
 * Sort en code 1 au premier geste qui ne se produit pas.
 */

import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://localhost:3231';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1512, height: 850 } });
let failures = 0;

function report(ok, line) {
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : 'ÉCHEC '} ${line}`);
}

// ---------------------------------------------------------------- 1. le rail
await page.goto(`${BASE}/crm/prospects`, { waitUntil: 'load', timeout: 120000 });
await page.waitForSelector('.crm-table', { timeout: 60000 });

await page.route('**/crm/inbox*', async (route) => {
  await new Promise((resolve) => setTimeout(resolve, 900));
  await route.continue();
});
await page.click('.crm-rail a[href="/crm/inbox"]');
await page.waitForTimeout(120);
const mid = await page.evaluate(() => ({
  cible: document.querySelector('.crm-rail a[href="/crm/inbox"]')?.classList.contains('active'),
  ancienne: document.querySelector('.crm-rail a[href="/crm/prospects"]')?.classList.contains('active'),
  barre: Number(
    getComputedStyle(document.querySelector('.crm-rail a[href="/crm/inbox"] .crm-rail-pending')).opacity,
  ),
  titre: document.querySelector('.crm-head h1')?.textContent?.trim(),
}));
report(
  mid.cible === true && mid.ancienne === false && mid.barre > 0 && mid.titre === 'Prospects',
  `retour immédiat : cible active=${mid.cible} · ancienne=${mid.ancienne} · barre=${mid.barre.toFixed(2)} · titre encore « ${mid.titre} »`,
);
await page.waitForFunction(
  () => document.querySelector('.crm-head h1')?.textContent?.trim() === 'Inbox',
  null,
  { timeout: 60000 },
);
await page.unroute('**/crm/inbox*');

// ------------------------------------------------------- 2. la ligne entière
await page.goto(`${BASE}/crm/prospects`, { waitUntil: 'load' });
await page.waitForSelector('.crm-table tbody tr');
const box = await page.locator('.crm-table tbody tr').first().boundingBox();
// 45 % : au milieu d'une cellule sans lien. Les colonnes « Liens » portent des
// ancres `target="_blank"` que le gestionnaire doit justement laisser passer.
await page.mouse.click(box.x + box.width * 0.45, box.y + box.height / 2);
let reached = true;
await page
  .waitForFunction(() => location.pathname.startsWith('/crm/prospects/'), null, { timeout: 30000 })
  .catch(() => {
    reached = false;
  });
report(reached, `clic au milieu de la ligne → ${new URL(page.url()).pathname}`);

// ------------------------------------------------------------- 3. le clavier
await page.goto(`${BASE}/crm/prospects`, { waitUntil: 'load' });
await page.waitForSelector('.crm-table tbody tr');
await page.keyboard.press('j');
await page.keyboard.press('j');
const highlighted = await page.evaluate(() => document.querySelectorAll('tr.is-active').length);
await page.keyboard.press('Enter');
let opened = true;
await page
  .waitForFunction(() => location.pathname.startsWith('/crm/prospects/'), null, { timeout: 30000 })
  .catch(() => {
    opened = false;
  });
report(highlighted === 1 && opened, `clavier : j j surligne ${highlighted} ligne, Entrée ouvre la fiche`);

// ----------------------------------------------------------- 4. le raccourci
await page.keyboard.press('g');
await page.keyboard.press('i');
let jumped = true;
await page
  .waitForFunction(() => location.pathname === '/crm/inbox', null, { timeout: 30000 })
  .catch(() => {
    jumped = false;
  });
report(jumped, 'raccourci « g i » → /crm/inbox');

console.log(`\n4 gestes, ${failures} échec(s)`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
