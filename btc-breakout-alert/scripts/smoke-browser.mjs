/**
 * Headless-browser smoke test: loads the dev server in system Chrome,
 * waits for live Binance data, switches timeframe, screenshots both states.
 *
 * Usage: node scripts/smoke-browser.mjs [url]   (default http://localhost:5173)
 * Screenshots land in scripts/.smoke/
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const url = process.argv[2] ?? 'http://localhost:5173';
const outDir = new URL('./.smoke/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1480, height: 920 } });
const page = await context.newPage();

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

console.log(`loading ${url} …`);
await page.goto(url, { waitUntil: 'domcontentloaded' });

// "Live" pill appears once REST history is loaded AND the WebSocket is open.
await page.locator('.conn-pill', { hasText: 'Live' }).waitFor({ timeout: 45_000 });
await page.waitForTimeout(2000); // let the chart paint a few ticks
await page.screenshot({ path: `${outDir}smoke-15m.png` });
console.log('15m: Live ✓  screenshot saved');

// Switch timeframe → app must tear down, refetch, reconnect.
await page.selectOption('select', '5m');
await page.locator('.symbol-badge em', { hasText: '5m' }).waitFor({ timeout: 10_000 });
await page.locator('.conn-pill', { hasText: 'Live' }).waitFor({ timeout: 45_000 });
await page.waitForTimeout(2000);
await page.screenshot({ path: `${outDir}smoke-5m.png` });
console.log('5m after switch: Live ✓  screenshot saved');

const price = await page.locator('.price').textContent();
const chips = await page.locator('.level-chip').allTextContents();
console.log(`price: ${price}`);
console.log(`levels: ${chips.join(' | ')}`);

if (errors.length) {
  console.log(`\nconsole errors (${errors.length}):`);
  for (const e of errors) console.log('  ' + e);
} else {
  console.log('\nno console errors ✓');
}

await browser.close();
process.exit(errors.length ? 1 : 0);
