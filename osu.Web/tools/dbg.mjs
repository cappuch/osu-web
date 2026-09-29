import { chromium } from 'playwright-core';
const exe = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const b = await chromium.launch({ executablePath: exe });
const p = await b.newPage();
p.on('response', r => { if (r.status() >= 400) console.log(r.status(), r.url()); });
p.on('console', m => console.log(m.text()));
await p.goto(process.argv[2]); await p.waitForTimeout(5000); await b.close();
