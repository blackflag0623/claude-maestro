// Drives the maestro portal through a regression flow and snaps each state.
// Usage: node scripts/flow.mjs [baseUrl] [outDir]
//   defaults: http://localhost:4051/  scripts/snaps/
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const base = process.argv[2] ?? 'http://localhost:4051/';
const outDir = process.argv[3] ?? 'scripts/snaps';
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.error('[console error]', m.text());
});

const shots = [];
async function snap(name) {
  const p = join(outDir, `${String(shots.length).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: p });
  shots.push(p);
  console.log('snap', p);
}

await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
await snap('initial');

// Attach the first available node (skip server header rows).
const firstNode = page.locator('.node').first();
const count = await firstNode.count();
if (count === 0) {
  console.error('no nodes in sidebar — cannot exercise files flow');
  await browser.close();
  process.exit(1);
}
await firstNode.click();
await page.waitForSelector('.pane[data-state="ready"], .pane[data-state="connecting"]', { timeout: 5000 });
await page.waitForTimeout(800);
// Move cursor off the sidebar so server-popup doesn't cover the topbar/pane in snaps.
await page.mouse.move(900, 500);
await page.waitForTimeout(200);
await snap('node-attached-single');

// Click pane FILES.
await page.locator('.pane__files').first().click();
await page.waitForTimeout(500);
await snap('files-open-single');

// Close files.
await page.locator('.pane__files').first().click();
await page.waitForTimeout(300);

// Switch to split-2.
await page.locator('#layout-switch button[data-mode="split-2"]').click();
await page.waitForTimeout(400);
await snap('split-2-no-files');

// Click pane FILES in split-2 — should flip back to single.
await page.locator('.pane__files').first().click();
await page.waitForTimeout(500);
const layoutAfter = await page.locator('#stage').getAttribute('data-layout');
console.log('layout after files in split-2:', layoutAfter);
await snap('files-from-split2-forces-single');

// Switch back to split-2 — should close explorer per requirement.
await page.locator('#layout-switch button[data-mode="split-2"]').click();
await page.waitForTimeout(400);
const explorerVisible = await page.locator('.pane__explorer').count();
console.log('explorers visible after switching to split-2:', explorerVisible);
await snap('back-to-split2-explorer-closed');

// Try grid-4.
await page.locator('#layout-switch button[data-mode="grid-4"]').click();
await page.waitForTimeout(400);
await snap('grid-4');

await page.locator('.pane__files').first().click();
await page.waitForTimeout(500);
await snap('files-from-grid4-forces-single');

// Drill into the file tree and open a TypeScript file to verify highlighting.
async function openFolder(name) {
  const row = page.locator(`.fx__row[data-kind="dir"][data-name="${name}"]`);
  if (await row.count() === 0) {
    console.log('folder not found:', name);
    return false;
  }
  await row.first().click();
  await page.waitForTimeout(300);
  return true;
}
async function openFile(name) {
  const row = page.locator(`.fx__row[data-kind="file"][data-name="${name}"]`);
  if (await row.count() === 0) {
    console.log('file not found:', name);
    return false;
  }
  await row.first().click();
  await page.waitForTimeout(400);
  return true;
}

// Drill into the file tree and pick a file to verify the viewer + highlighting.
await page.waitForSelector('.fx__row', { timeout: 5000 });
// Pick the first file (any kind) in the current dir to exercise the viewer.
const firstFile = page.locator('.fx__row[data-kind="file"]').first();
if (await firstFile.count() > 0) {
  const name = await firstFile.getAttribute('data-name');
  console.log('opening file:', name);
  await firstFile.click();
  await page.waitForTimeout(600);
  await snap('viewer-file-open');
  const hljsClass = await page.locator('.fx__viewer-body code').getAttribute('class').catch(() => null);
  console.log('viewer code class:', hljsClass);
} else {
  console.log('no files in cwd root to preview');
}

// Drag the resizer to widen the explorer column.
const resizer = page.locator('.pane__resizer').first();
if (await resizer.count() > 0) {
  const box = await resizer.boundingBox();
  if (box) {
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 300, startY, { steps: 20 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    await snap('explorer-widened');
    const w = await page.locator('.pane__explorer').first().evaluate((el) => el.getBoundingClientRect().width);
    console.log('explorer width after drag:', Math.round(w));
  }
}

// Drag vertical splitter inside the explorer to grow the viewer.
const vsplit = page.locator('.fx__vsplit').first();
if (await vsplit.count() > 0 && await vsplit.isVisible()) {
  const vh0 = await page.locator('.fx__viewer').first().evaluate((el) => el.getBoundingClientRect().height);
  const box = await vsplit.boundingBox();
  if (box) {
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - 250, { steps: 20 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const vh1 = await page.locator('.fx__viewer').first().evaluate((el) => el.getBoundingClientRect().height);
    console.log('viewer height before/after:', Math.round(vh0), '→', Math.round(vh1));
    await snap('viewer-tall');
  }
}

await browser.close();
console.log('\nflow complete:', shots.length, 'snaps in', outDir);
