// Records a Chrome memory-infra dump after N seconds and prints the largest allocators per process.
// usage: node memdump.mjs <url> <seconds>
import { chromium } from 'playwright-core';
import os from 'node:os';
import fs from 'node:fs';

const [url, secs = '90'] = process.argv.slice(2);
const cache = `${os.homedir()}/Library/Caches/ms-playwright`;
const dir = fs.readdirSync(cache).find(d => d.startsWith('chromium-'));
const exe = `${cache}/${dir}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--ignore-certificate-errors'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true });
const cdp = await browser.newBrowserCDPSession();

const events = [];
cdp.on('Tracing.dataCollected', e => { for (const x of e.value) if (x.ph === 'v' || x.ph === 'M') events.push(x); });
const done = new Promise(r => cdp.once('Tracing.tracingComplete', r));
await cdp.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['disabled-by-default-memory-infra'], memoryDumpConfig: { triggers: [] } } });

await page.goto(url);
await page.waitForTimeout(Number(secs) * 1000);
await cdp.send('Tracing.requestMemoryDump', { deterministic: false, levelOfDetail: 'detailed' });
await cdp.send('Tracing.end');
await done;

fs.writeFileSync('/tmp/memdump.json', JSON.stringify(events.filter(x => x.ph === 'M' || x.args?.dumps?.allocators).map(x => x.ph === 'M' ? x : { ph: 'v', pid: x.pid, args: { dumps: { allocators: Object.fromEntries(Object.entries(x.args.dumps.allocators).filter(([k]) => k.split('/').length <= 4)) } } })));
const names = {};
for (const e of events) if (e.ph === 'M' && e.name === 'process_name') names[e.pid] = e.args.name;
for (const e of events) {
  if (e.ph !== 'v' || !e.args?.dumps?.allocators) continue;
  const rows = [];
  for (const [name, a] of Object.entries(e.args.dumps.allocators)) {
    const size = parseInt(a.attrs?.size?.value ?? '0', 16);
    if (size > 100 * 1048576 && name.split('/').length <= 3) rows.push([size, name]);
  }
  if (!rows.length) continue;
  rows.sort((a, b) => b[0] - a[0]);
  console.log(`== ${names[e.pid] ?? e.pid}`);
  for (const [size, name] of rows.slice(0, 25)) console.log(`  ${(size / 1048576).toFixed(0).padStart(6)}MB ${name}`);
}
await browser.close();
