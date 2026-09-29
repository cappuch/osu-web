// Checks whether a backgrounded (hidden) tab leaks memory. Boots osu!web, optionally
// forces the bitmap fallback, then hides the page by creating and focusing a second page.
// usage: FORCE_BITMAP=1 node hidden.mjs <url> <seconds>
import { chromium } from 'playwright-core';
import os from 'node:os';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const url = process.argv[2] ?? 'https://localhost:8080/';
const secs = Number(process.argv[3] ?? '120');
const forceBitmap = process.env.FORCE_BITMAP === '1';
const cache = `${os.homedir()}/Library/Caches/ms-playwright`;
const dir = fs.readdirSync(cache).find(d => d.startsWith('chromium-'));
const exe = `${cache}/${dir}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--ignore-certificate-errors', '--enable-precise-memory-info'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true });
const page = await context.newPage();
if (forceBitmap) await page.addInitScript(() => { HTMLCanvasElement.prototype.transferControlToOffscreen = function () { throw new Error('forced bitmap fallback'); }; });
page.on('crash', () => console.log('[crash]'));
page.on('pageerror', e => console.log(`[pageerror] ${e}`));
await page.goto(url);
await page.waitForTimeout(20000);

const s0 = await page.evaluate(() => ({ hidden: document.hidden, vis: document.visibilityState, wasm: globalThis.getDotnetRuntime?.(0)?.localHeapViewU8?.().buffer.byteLength ?? 0 }));
console.log(`mode=${forceBitmap ? 'bitmap' : 'direct'} before-hide hidden=${s0.hidden} vis=${s0.vis} wasm=${(s0.wasm / 1048576).toFixed(0)}MB`);

// hide the game page behind a new focused page
const other = await context.newPage();
await other.setContent('<title>other</title><h1>other tab</h1>');
await other.bringToFront();

const t0 = Date.now();
while (Date.now() - t0 < secs * 1000) {
  await page.waitForTimeout(10000);
  const s = await Promise.race([
    page.evaluate(() => ({ hidden: document.hidden, vis: document.visibilityState, wasm: globalThis.getDotnetRuntime?.(0)?.localHeapViewU8?.().buffer.byteLength ?? 0, js: performance.memory?.usedJSHeapSize ?? 0, frames: globalThis.osuweb?.getPerformanceSnapshot?.().gameFrames ?? 0 })),
    new Promise(r => setTimeout(() => r(null), 8000)),
  ]).catch(() => null);
  const procs = execSync(`ps -axo rss,command | grep "Chrome for Testing" | grep -v grep | awk '{t="browser"; if ($0 ~ /type=gpu/) t="gpu"; else if ($0 ~ /type=renderer/) t="renderer"; else if ($0 ~ /type=/) t="other"; s[t]+=$1} END {for (k in s) printf "%s=%dMB ", k, s[k]/1024}'`).toString();
  if (!s) { console.log(`t=${((Date.now() - t0) / 1000).toFixed(0)}s <BLOCKED> ${procs}`); continue; }
  console.log(`t=${((Date.now() - t0) / 1000).toFixed(0)}s hidden=${s.hidden} vis=${s.vis} frames=${s.frames} wasm=${(s.wasm / 1048576).toFixed(0)}MB jsHeap=${(s.js / 1048576).toFixed(0)}MB ${procs}`);
}
await browser.close();
