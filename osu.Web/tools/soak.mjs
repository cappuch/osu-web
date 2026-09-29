// Lean long-soak memory sampler (direct display). No measureUserAgentSpecificMemory,
// so it samples on a tight schedule. usage: node soak.mjs <url> <seconds>
import { chromium } from 'playwright-core';
import os from 'node:os';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const [url, secs = '420'] = process.argv.slice(2);
const cache = `${os.homedir()}/Library/Caches/ms-playwright`;
const dir = fs.readdirSync(cache).find(d => d.startsWith('chromium-'));
const exe = `${cache}/${dir}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--ignore-certificate-errors', '--enable-precise-memory-info'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true });
page.on('crash', () => console.log('[crash]'));
page.on('pageerror', e => console.log(`[pageerror] ${e}`));

await page.goto(url);
const start = Date.now();
let lastFrames = 0, lastT = start;
while (Date.now() - start < Number(secs) * 1000) {
  await page.waitForTimeout(10000);
  const s = await Promise.race([
    page.evaluate(() => {
      const web = globalThis.osuweb?.getPerformanceSnapshot?.();
      return { frames: web?.gameFrames ?? 0, wasm: globalThis.getDotnetRuntime?.(0)?.localHeapViewU8?.().buffer.byteLength ?? 0, js: performance.memory?.usedJSHeapSize ?? 0 };
    }),
    new Promise(r => setTimeout(() => r(null), 8000)),
  ]).catch(() => null);
  if (!s) { console.log(`t=${((Date.now() - start) / 1000).toFixed(0)}s <PAGE MAIN THREAD BLOCKED>`); continue; }
  const now = Date.now();
  const fps = ((s.frames - lastFrames) / ((now - lastT) / 1000)).toFixed(1);
  lastFrames = s.frames; lastT = now;
  const procs = execSync(`ps -axo rss,command | grep "Chrome for Testing" | grep -v grep | awk '{t="browser"; if ($0 ~ /type=gpu/) t="gpu"; else if ($0 ~ /type=renderer/) t="renderer"; else if ($0 ~ /type=/) t="other"; s[t]+=$1} END {for (k in s) printf "%s=%dMB ", k, s[k]/1024}'`).toString();
  console.log(`${procs}`);
  console.log(`t=${((now - start) / 1000).toFixed(0)}s fps=${fps} wasm=${(s.wasm / 1048576).toFixed(0)}MB jsHeap=${(s.js / 1048576).toFixed(0)}MB workers=${page.workers().length}`);
}
await browser.close();
