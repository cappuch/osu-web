// Launches headless Chromium against a URL, streams console output, optionally saves a screenshot.
// usage: node run-headless.mjs <url> <seconds> [screenshot.png]
import { chromium } from 'playwright-core';
import os from 'node:os';
import fs from 'node:fs';

const [url, secs = '20', shot] = process.argv.slice(2);
const cache = `${os.homedir()}/Library/Caches/ms-playwright`;
const dir = fs.readdirSync(cache).find(d => d.startsWith('chromium-'));
const exe = `${cache}/${dir}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await chromium.launch({ executablePath: fs.existsSync(exe) ? exe : undefined, channel: fs.existsSync(exe) ? undefined : 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', m => console.log(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => console.log(`[pageerror] ${e.stack || e}`));
page.on('crash', () => console.log('[crash]'));
await page.goto(url);
const end = Date.now() + Number(secs) * 1000;
let i = 0;
while (Date.now() < end) {
    await page.waitForTimeout(Math.min(5000, end - Date.now()));
    if (shot) await page.screenshot({ path: shot }).catch(() => {});
}
await browser.close();
