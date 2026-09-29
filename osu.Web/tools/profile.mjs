// Samples presented FPS, wasm heap size and JS heap over time in headless Chromium.
// usage: node profile.mjs <url> <seconds>
import { chromium } from 'playwright-core';
import os from 'node:os';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const [url, secs = '60'] = process.argv.slice(2);
const cache = `${os.homedir()}/Library/Caches/ms-playwright`;
const dir = fs.readdirSync(cache).find(d => d.startsWith('chromium-'));
const exe = `${cache}/${dir}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--ignore-certificate-errors', '--enable-precise-memory-info'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true });
page.on('console', m => { const t = m.text(); if (/error|leak|fail|warn/i.test(t)) console.log(`[${m.type()}] ${t.slice(0, 300)}`); });
page.on('pageerror', e => console.log(`[pageerror] ${e.stack || e}`));
page.on('crash', () => console.log('[crash]'));

await page.addInitScript(() => {
  globalThis.__frames = 0;
  const orig = ImageBitmapRenderingContext.prototype.transferFromImageBitmap;
  ImageBitmapRenderingContext.prototype.transferFromImageBitmap = function (b) { globalThis.__frames++; return orig.call(this, b); };
});

const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
await page.goto(url);

const start = Date.now();
let lastFrames = 0, lastT = start;
while (Date.now() - start < Number(secs) * 1000) {
  await page.waitForTimeout(5000);
  const s = await page.evaluate(() => {
    const web = globalThis.osuweb?.getPerformanceSnapshot?.();
    return {
      frames: web?.gameFrames ?? globalThis.__frames,
      direct: web?.directDisplay ?? false,
      refreshRate: web?.refreshRate ?? 0,
      wasm: globalThis.getDotnetRuntime?.(0)?.localHeapViewU8?.().buffer.byteLength ?? 0,
      js: performance.memory?.usedJSHeapSize ?? 0,
    };
  }).catch(() => null);
  if (!s) continue;
  const m = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(x => [x.name, x.value]));
  const now = Date.now();
  const fps = ((s.frames - lastFrames) / ((now - lastT) / 1000)).toFixed(1);
  lastFrames = s.frames; lastT = now;
  const rss = Number(execSync(`ps -axo rss,command | grep "Chrome for Testing" | grep -v grep | awk '{s+=$1} END {print s}'`).toString()) / 1024;
  const procs = execSync(`ps -axo rss,command | grep "Chrome for Testing" | grep -v grep | awk '{t="browser"; if ($0 ~ /type=gpu/) t="gpu"; else if ($0 ~ /type=renderer/) t="renderer"; else if ($0 ~ /type=/) t="other"; s[t]+=$1} END {for (k in s) printf "%s=%dMB ", k, s[k]/1024}'`).toString();
  const breakdown = await Promise.race([
    page.evaluate(async () => {
      const r = await performance.measureUserAgentSpecificMemory();
      const parts = r.breakdown.filter(b => b.bytes > 20 * 1048576)
        .map(b => `${(b.bytes / 1048576).toFixed(0)}MB:${b.types.join('+')}:${b.attribution.map(a => (a.scope || '') + '/' + (a.url || '').split('/').pop()).join(',')}`);
      return `total=${(r.bytes / 1048576).toFixed(0)}MB ` + parts.join(' | ');
    }),
    new Promise(r => setTimeout(() => r('measure timed out'), 4000)),
  ]).catch(e => `measure failed: ${e.message}`);
  console.log(`   ${procs}\n   ${breakdown}`);
  console.log(`t=${((now - start) / 1000).toFixed(0)}s fps=${fps} display=${s.direct ? 'direct' : 'bitmap'}@${s.refreshRate}Hz wasm=${(s.wasm / 1048576).toFixed(0)}MB jsHeap=${(s.js / 1048576).toFixed(0)}MB workers=${page.workers().length} chromeRss=${rss.toFixed(0)}MB`);
}
await browser.close();
