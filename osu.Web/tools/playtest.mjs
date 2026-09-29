// Boots osu!web, imports a beatmap via a synthetic drop, navigates into gameplay
// and samples wasm heap / JS heap / renderer RSS over time so the "playing a beatmap
// leaks RAM" report can be reproduced (or not).
// usage: node playtest.mjs <url> <seconds-in-gameplay>
import { chromium } from 'playwright-core';
import os from 'node:os';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const [url, gameplaySecs = '120'] = process.argv.slice(2);
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
page.on('console', m => { const t = m.text(); if (/error|leak|fail|crash|oom|out of memory/i.test(t)) console.log(`[${m.type()}] ${t.slice(0, 300)}`); });
page.on('pageerror', e => console.log(`[pageerror] ${e.stack || e}`));
page.on('crash', () => console.log('[crash]'));

const t0 = Date.now();
const T = () => (((Date.now() - t0) / 1000).toFixed(1)).padStart(6);

function rss() {
  try {
    return Number(execSync(`ps -axo rss,command | grep "Chrome for Testing" | grep -v grep | awk '{s+=$1} END {print s}'`).toString()) / 1024;
  } catch { return 0; }
}

async function sample(label) {
  const s = await page.evaluate(() => {
    const web = globalThis.osuweb?.getPerformanceSnapshot?.();
    return {
      present: web?.gameFrames ?? 0,
      wasm: globalThis.getDotnetRuntime?.(0)?.localHeapViewU8?.().buffer.byteLength ?? 0,
      js: performance.memory?.usedJSHeapSize ?? 0,
      overlay: !document.getElementById('overlay').classList.contains('hidden'),
    };
  }).catch(() => null);
  if (!s) { console.log(`${T()} ${label} <evaluate failed/worker blocked>`); return; }
  console.log(`${T()} ${label} present=${s.present} wasm=${(s.wasm / 1048576).toFixed(0)}MB jsHeap=${(s.js / 1048576).toFixed(0)}MB workers=${page.workers().length} chromeRss=${rss().toFixed(0)}MB overlay=${s.overlay}`);
}

await page.goto(url);

// wait for first frame (overlay hidden) — up to 90s, polling via evaluate (raf polling
// does not run when headless throttles animation frames).
let ready = false;
for (let attempt = 0; attempt < 90; attempt++) {
  await page.waitForTimeout(1000);
  const state = await page.evaluate(() => ({
    hidden: document.getElementById('overlay').classList.contains('hidden'),
    status: document.getElementById('status')?.textContent ?? '',
    visibility: document.visibilityState,
  })).catch(() => null);
  if (!state) continue;
  if (attempt % 10 === 9) console.log(`${T()} waiting overlay hidden=${state.hidden} status="${state.status}" visibility=${state.visibility}`);
  if (state.hidden) { ready = true; break; }
}
console.log(`${T()} game ready=${ready}`);
await sample('ready');

// user gesture for audio + focus
const start = page.locator('#start');
if (await start.isVisible().catch(() => false)) await start.click().catch(() => {});
await page.locator('#game').click({ position: { x: 640, y: 360 } }).catch(() => {});

// synthetic file drop of the served test beatmap
const dropped = await page.evaluate(async () => {
  try {
    const blob = await (await fetch('/_testmap.osz')).blob();
    const file = new File([blob], 'testmap.osz');
    const dt = new DataTransfer();
    dt.items.add(file);
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return `dropped ${file.size}`;
  } catch (e) { return `drop failed: ${e.message}`; }
});
console.log(`${T()} ${dropped}`);

await page.waitForTimeout(12000);
await sample('after-import');
await page.screenshot({ path: '/tmp/playtest-1-menu.png' }).catch(() => {});

// navigate: P -> song select, Enter -> select/play, Space -> skip intro
await page.keyboard.press('KeyP');
await page.waitForTimeout(4000);
await sample('songselect');
await page.screenshot({ path: '/tmp/playtest-2-songselect.png' }).catch(() => {});

await page.keyboard.press('Enter');
await page.waitForTimeout(8000);
await sample('loading');
await page.screenshot({ path: '/tmp/playtest-3-loading.png' }).catch(() => {});

await page.keyboard.press('Space');
await page.waitForTimeout(2000);
await sample('gameplay-start');
await page.screenshot({ path: '/tmp/playtest-4-gameplay.png' }).catch(() => {});

const end = Date.now() + Number(gameplaySecs) * 1000;
let i = 0;
while (Date.now() < end) {
  await page.waitForTimeout(5000);
  await sample(`gameplay+${(i++) * 5}s`);
  if (i % 6 === 0) await page.screenshot({ path: `/tmp/playtest-g${i}.png` }).catch(() => {});
}

await browser.close();
