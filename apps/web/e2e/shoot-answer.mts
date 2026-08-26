// Screenshot an existing answer page: login, open /q/<id>, wait until rendered,
// expand citations. Usage:
//   E2E_EMAIL=... E2E_PASSWORD=... npx tsx apps/web/e2e/shoot-answer.mts <qa-or-pending-id> [dir]
import { chromium } from 'playwright-core';

const BASE = process.env['E2E_BASE'] ?? 'http://localhost:3100';
const EMAIL = process.env['E2E_EMAIL'] ?? '';
const PASSWORD = process.env['E2E_PASSWORD'] ?? '';
const ID = process.argv[2] ?? '';
const SHOTS = process.argv[3] ?? '.';
if (!EMAIL || !PASSWORD || !ID) {
  console.error('Usage: E2E_EMAIL=... E2E_PASSWORD=... shoot-answer.mts <id> [dir]');
  process.exit(1);
}

const browser = await chromium.launch({
  executablePath: process.env['E2E_CHROMIUM'] ?? '/opt/pw-browsers/chromium',
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(`${BASE}/login`);
await page.fill('#email', EMAIL);
await page.fill('#password', PASSWORD);
await page.click('button[type=submit]');
await page.waitForURL(`${BASE}/`);
await page.goto(`${BASE}/q/${ID}`);

const deadline = Date.now() + 10 * 60 * 1000;
for (;;) {
  try {
    const title = await page.title();
    if (title.startsWith('Answer') || title.startsWith('Failed') || title.startsWith('Refused'))
      break;
  } catch {
    // navigation in flight
  }
  if (Date.now() > deadline) {
    console.error('Timed out.');
    break;
  }
  await page.waitForTimeout(4000);
}
console.log('title:', await page.title(), 'url:', page.url());
await page.screenshot({ path: `${SHOTS}/ui-4-answer.png`, fullPage: true });
const summaries = page.locator('details.cite summary');
const n = Math.min(await summaries.count(), 3);
for (let i = 0; i < n; i += 1) await summaries.nth(i).click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${SHOTS}/ui-5-citations.png`, fullPage: true });
await browser.close();
console.log('done');
