// Prints V8 heap usage for every worker target at intervals (workers blocked in Atomics.wait show as "no reply").
import { chromium } from 'playwright-core';
import os from 'node:os'; import fs from 'node:fs'; import { execSync } from 'node:child_process';
const cache = `${os.homedir()}/Library/Caches/ms-playwright`;
const dir = fs.readdirSync(cache).find(d => d.startsWith('chromium-'));
const exe = `${cache}/${dir}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const b = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist','--autoplay-policy=no-user-gesture-required','--ignore-certificate-errors'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true });
await p.goto(process.argv[2]);
const t0 = Date.now();
const sessions = new Map();
while (Date.now() - t0 < Number(process.argv[3]) * 1000) {
  await p.waitForTimeout(8000);
  for (const w of p.workers()) if (!sessions.has(w)) sessions.set(w, await p.context().newCDPSession(w).catch(() => null));
  const rows = await Promise.all([...sessions].map(async ([w, s], i) => {
    if (!s) return null;
    const r = await Promise.race([s.send('Runtime.getHeapUsage'), new Promise(res => setTimeout(() => res(null), 1500))]).catch(() => null);
    return r ? [i, r.usedSize + (r.embedderHeapUsedSize ?? 0) + (r.backingStorageSize ?? 0), r] : null;
  }));
  const rss = Number(execSync(`ps -axo rss,command | grep "Chrome for Testing" | grep "type=renderer" | grep -v grep | awk '{s+=$1} END {print s}'`).toString())/1024;
  const big = rows.filter(Boolean).sort((a, c) => c[1] - a[1]).slice(0, 4).map(([i, n, r]) => `w${i}:${(n/1048576).toFixed(0)}MB(used ${(r.usedSize/1048576).toFixed(0)} backing ${((r.backingStorageSize??0)/1048576).toFixed(0)})`);
  console.log(`t=${((Date.now()-t0)/1000).toFixed(0)}s renderer=${rss.toFixed(0)}MB replies=${rows.filter(Boolean).length}/${sessions.size} ${big.join(' ')}`);
}
await b.close();
