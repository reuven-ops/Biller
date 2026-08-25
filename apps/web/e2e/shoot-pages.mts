// Screenshot the main pages while signed in.
import { chromium } from 'playwright-core';
const BASE = process.env['E2E_BASE'] ?? 'http://localhost:3100';
const SHOTS = process.argv[2] ?? '.';
const browser = await chromium.launch({
  executablePath: process.env['E2E_CHROMIUM'] ?? '/opt/pw-browsers/chromium',
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(`${BASE}/login`);
await page.fill('#email', process.env['E2E_EMAIL'] ?? '');
await page.fill('#password', process.env['E2E_PASSWORD'] ?? '');
await page.click('button[type=submit]');
await page.waitForURL(`${BASE}/`);
for (const [path, name] of [
  ['/history', 'ui-6-history'],
  ['/sources', 'ui-7-sources'],
  ['/admin', 'ui-8-admin'],
  ['/help', 'ui-9-help'],
] as const) {
  await page.goto(`${BASE}${path}`);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}
await browser.close();
console.log('done');
