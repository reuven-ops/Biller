// Renders a local HTML file (e.g. a captured-pages preview bundle) at a phone
// viewport and screenshots two states, reporting console errors.
// Usage: npx tsx apps/web/e2e/check-preview.mts <file.html> [shots-dir]
import { chromium } from 'playwright-core';

const file = process.argv[2];
const shots = process.argv[3] ?? '.';
if (!file) {
  console.error('Usage: check-preview.mts <file.html> [shots-dir]');
  process.exit(1);
}

const browser = await chromium.launch({
  executablePath: process.env['E2E_CHROMIUM'] ?? '/opt/pw-browsers/chromium',
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('console', (m) => {
  if (m.type() === 'error') console.log('CONSOLE ERROR', m.text());
});
await page.goto(`file://${file}`);
await page.waitForTimeout(600);
await page.screenshot({ path: `${shots}/pv-1.png` });
const third = page.locator('nav button:nth-child(3)');
if (await third.count()) {
  await third.click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${shots}/pv-2.png` });
}
console.log('ok');
await browser.close();
