import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://localhost:4051/';
const out = process.argv[3] ?? 'snap.png';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await page.screenshot({ path: out, fullPage: false });
await browser.close();
console.log('saved', out);
