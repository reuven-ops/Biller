// Phase 3 acceptance: drive the app in a real browser (login, ask, answer,
// citations) and save screenshots. Run with the web server up:
//   E2E_BASE=http://localhost:3100 E2E_EMAIL=... E2E_PASSWORD=... \
//   npx tsx apps/web/e2e/ui-drive.mts [screenshot-dir]
import { chromium } from 'playwright-core';

const BASE = process.env['E2E_BASE'] ?? 'http://localhost:3100';
const EMAIL = process.env['E2E_EMAIL'] ?? '';
const PASSWORD = process.env['E2E_PASSWORD'] ?? '';
const SHOTS = process.argv[2] ?? '.';
const QUESTION =
  process.env['E2E_QUESTION'] ??
  'Can 97140 be billed with 98940 on the same date of service for Medicare, and what modifier applies?';

if (!EMAIL || !PASSWORD) {
  console.error('Set E2E_EMAIL and E2E_PASSWORD.');
  process.exit(1);
}

const executablePath = process.env['E2E_CHROMIUM'] ?? '/opt/pw-browsers/chromium';
const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

await page.goto(`${BASE}/login`);
await page.screenshot({ path: `${SHOTS}/ui-1-login.png`, fullPage: true });

await page.fill('#email', EMAIL);
await page.fill('#password', PASSWORD);
await page.click('button[type=submit]');
await page.waitForURL(`${BASE}/`);
await page.screenshot({ path: `${SHOTS}/ui-2-ask.png`, fullPage: true });

await page.fill('#question', QUESTION);
await page.selectOption('#provider', 'DC');
await page.click('form[action="/ask"] button[type=submit]');
await page.waitForURL(/\/q\//);
await page.screenshot({ path: `${SHOTS}/ui-3-working.png`, fullPage: true });
console.log('pending page at', page.url());

// The pending page meta-refreshes itself; poll the title and tolerate the
// navigation races that reload/title calls can hit mid-refresh.
const deadline = Date.now() + 10 * 60 * 1000;
for (;;) {
  try {
    const title = await page.title();
    if (title.startsWith('Answer') || title.startsWith('Failed') || title.startsWith('Refused'))
      break;
  } catch {
    // navigation in flight; check again next tick
  }
  if (Date.now() > deadline) {
    console.error('Timed out waiting for the answer.');
    break;
  }
  await page.waitForTimeout(4000);
}
console.log('final title:', await page.title(), 'url:', page.url());
await page.screenshot({ path: `${SHOTS}/ui-4-answer.png`, fullPage: true });

const summaries = page.locator('details.cite summary');
const n = Math.min(await summaries.count(), 3);
for (let i = 0; i < n; i += 1) await summaries.nth(i).click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${SHOTS}/ui-5-citations.png`, fullPage: true });

await browser.close();
console.log('done');
