// Like profile.mjs, but forces the ImageBitmap presentation fallback by making
// canvas.transferControlToOffscreen() throw, so the bitmap path the original
// "memory hog / tab crash" report points at is actually exercised.
// usage: node profile-fallback.mjs <url> <seconds>
import { chromium } from 'playwright-core';
import os from 'node:os';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const [url, secs = '150'] = process.argv.slice(2);
const cache = `${os.homedir()}/Library/Caches/ms-playwright`;
const dir = fs.readdirSync(cache).find(d => d.startsWith('chromium-'));
const exe = `${cache}/${dir}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--ignore-certificate-errors', '--enable-precise-memory-info'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true });
page.on('console', m => { const t = m.text(); if (/error|leak|fail|crash|oom/i.test(t)) console.log(`[${m.type()}] ${t.slice(0, 250)}`); });
page.on('pageerror', e => console.log(`[pageerror] ${e}`));
page.on('crash', () => console.log('[crash]'));

await page.addInitScript(() => {
  HTMLCanvasElement.prototype.transferControlToOffscreen = function () { throw new Error('forced bitmap fallback'); };
});

await page.goto(url);
const start = Date.now();
let lastFrames = 0, lastT = start;
while (Date.now() - start < Number(secs) * 1000) {
  await page.waitForTimeout(5000);
  const s = await page.evaluate(() => {
    const web = globalThis.osuweb?.getPerformanceSnapshot?.();
    return {
      frames: web?.gameFrames ?? 0,
      direct: web?.directDisplay ?? false,
      wasm: globalThis.getDotnetRuntime?.(0)?.localHeapViewU8?.().buffer.byteLength ?? 0,
      js: performance.memory?.usedJSHeapSize ?? 0,
    };
  }).catch(() => null);
  if (!s) continue;
  const now = Date.now();
  const fps = ((s.frames - lastFrames) / ((now - lastT) / 1000)).toFixed(1);
  lastFrames = s.frames; lastT = now;
  const procs = execSync(`ps -axo rss,command | grep "Chrome for Testing" | grep -v grep | awk '{t="browser"; if ($0 ~ /type=gpu/) t="gpu"; else if ($0 ~ /type=renderer/) t="renderer"; else if ($0 ~ /type=/) t="other"; s[t]+=$1} END {for (k in s) printf "%s=%dMB ", k, s[k]/1024}'`).toString();
  const rss = Number(execSync(`ps -axo rss,command | grep "Chrome for Testing" | grep -v grep | awk '{s+=$1} END {print s}'`).toString()) / 1024;
  console.log(`${procs}`);
  console.log(`t=${((now - start) / 1000).toFixed(0)}s fps=${fps} display=${s.direct ? 'direct' : 'bitmap'} wasm=${(s.wasm / 1048576).toFixed(0)}MB jsHeap=${(s.js / 1048576).toFixed(0)}MB workers=${page.workers().length} chromeRss=${rss.toFixed(0)}MB`);
}
await browser.close();
