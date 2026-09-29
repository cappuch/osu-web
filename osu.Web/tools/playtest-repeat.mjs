// Imports a beatmap once, then repeatedly loads/leaves it to check whether osu!web's
// wasm linear memory keeps growing across beatmap loads until the tab OOMs.
// usage: node playtest-repeat.mjs <url> <rounds>
import { chromium } from 'playwright-core';
import os from 'node:os';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const [url, rounds = '8'] = process.argv.slice(2);
const cache = `${os.homedir()}/Library/Caches/ms-playwright`;
const dir = fs.readdirSync(cache).find(d => d.startsWith('chromium-'));
const exe = `${cache}/${dir}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required', '--ignore-certificate-errors',
    '--enable-precise-memory-info'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true });
page.on('crash', () => console.log('[crash]'));
page.on('pageerror', e => console.log(`[pageerror] ${e}`));

const t0 = Date.now();
const T = () => (((Date.now() - t0) / 1000).toFixed(1)).padStart(6);

async function sample(label) {
  const s = await Promise.race([
    page.evaluate(() => {
      const web = globalThis.osuweb?.getPerformanceSnapshot?.();
      return { present: web?.gameFrames ?? 0, wasm: globalThis.getDotnetRuntime?.(0)?.localHeapViewU8?.().buffer.byteLength ?? 0, js: performance.memory?.usedJSHeapSize ?? 0 };
    }),
    new Promise(r => setTimeout(() => r(null), 8000)),
  ]).catch(() => null);
  if (!s) { console.log(`${T()} ${label} <page unresponsive>`); return null; }
  const rss = Number(execSync(`ps -axo rss,command | grep "Chrome for Testing" | grep -v grep | awk '{s+=$1} END {print s}'`).toString()) / 1024;
  console.log(`${T()} ${label} present=${s.present} wasm=${(s.wasm / 1048576).toFixed(0)}MB jsHeap=${(s.js / 1048576).toFixed(0)}MB chromeRss=${rss.toFixed(0)}MB`);
  return s;
}

await page.goto(url);
for (let attempt = 0; attempt < 90; attempt++) {
  await page.waitForTimeout(1000);
  const hidden = await page.evaluate(() => document.getElementById('overlay').classList.contains('hidden')).catch(() => false);
  if (hidden) break;
}
console.log(`${T()} ready`);
const start = page.locator('#start');
if (await start.isVisible().catch(() => false)) await start.click().catch(() => {});
await page.locator('#game').click({ position: { x: 640, y: 360 } }).catch(() => {});

await page.evaluate(async () => {
  const blob = await (await fetch('/_testmap.osz')).blob();
  const dt = new DataTransfer();
  dt.items.add(new File([blob], 'testmap.osz'));
  window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
});
await page.waitForTimeout(12000);
await sample('imported');

await page.keyboard.press('KeyP');
await page.waitForTimeout(4000);
await sample('songselect-0');

for (let r = 1; r <= Number(rounds); r++) {
  await page.keyboard.press('Enter');       // start map
  await page.waitForTimeout(12000);         // loading + gameplay
  await sample(`round-${r}-playing`);
  await page.keyboard.press('Escape');      // pause
  await page.waitForTimeout(1500);
  await page.keyboard.press('Escape');      // quit/back to song select
  await page.waitForTimeout(3000);
  await sample(`round-${r}-after`);
}

await browser.close();
