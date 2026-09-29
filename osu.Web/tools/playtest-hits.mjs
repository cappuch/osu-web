// Boots osu!web, imports a beatmap, enters gameplay and actually "plays" it by spamming
// hit keys, which triggers hit samples / audio channels. Watches memory to test whether
// the audio-channel path (or anything else) leaks while a beatmap is being played.
// usage: node playtest-hits.mjs <url> <seconds>
import { chromium } from 'playwright-core';
import os from 'node:os';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const [url, secs = '120'] = process.argv.slice(2);
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
  if (!s) { console.log(`${T()} ${label} <page unresponsive>`); return; }
  const rss = Number(execSync(`ps -axo rss,command | grep "Chrome for Testing" | grep -v grep | awk '{s+=$1} END {print s}'`).toString()) / 1024;
  console.log(`${T()} ${label} present=${s.present} wasm=${(s.wasm / 1048576).toFixed(0)}MB jsHeap=${(s.js / 1048576).toFixed(0)}MB chromeRss=${rss.toFixed(0)}MB`);
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
await sample('songselect');
await page.keyboard.press('Enter');
await page.waitForTimeout(8000);
await page.keyboard.press('Space');
await page.waitForTimeout(2000);
await sample('gameplay-start');

// spam hits: alternate Z and X, plus movement, to trigger hit samples / objects.
const end = Date.now() + Number(secs) * 1000;
let i = 0;
while (Date.now() < end) {
  for (let n = 0; n < 8; n++) {
    await page.keyboard.press('KeyZ');
    await page.keyboard.press('KeyX');
    await page.waitForTimeout(100);
  }
  await page.mouse.move(100 + (i % 20) * 50, 100 + (i % 14) * 30);
  i++;
  if (i % 5 === 0) await sample(`hits+${i * 8}`);
}
await browser.close();
