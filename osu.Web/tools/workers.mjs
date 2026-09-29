// Enumerates the page's dedicated web workers and their heap sizes to see what the
// ~33 workers are and whether any of them is holding a large heap.
import { chromium } from 'playwright-core';
import os from 'node:os';
import fs from 'node:fs';

const cache = `${os.homedir()}/Library/Caches/ms-playwright`;
const dir = fs.readdirSync(cache).find(d => d.startsWith('chromium-'));
const exe = `${cache}/${dir}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true });
await page.goto(process.argv[2] ?? 'https://localhost:8080/');
await page.waitForTimeout(25000);

const workers = page.workers();
console.log(`workers=${workers.length}`);
const counts = {};
for (const w of workers) counts[w.url()] = (counts[w.url()] ?? 0) + 1;
for (const [url, n] of Object.entries(counts)) console.log(`  ${n}x ${url}`);

const client = await page.context().newCDPSession(page);
const { targetInfos } = await client.send('Target.getTargets');
for (const t of targetInfos.filter(t => t.type === 'worker')) console.log(`target worker ${t.targetId} ${t.url}`);
await browser.close();
