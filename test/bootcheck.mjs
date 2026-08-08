import { launch } from './browser.mjs';
const browser = await launch({ headless: true, protocolTimeout: 60000, args: ['--enable-unsafe-swiftshader', '--window-size=1280,800'], defaultViewport: { width: 1280, height: 800 } });
const page = await browser.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + String(e).slice(0, 300)));
// Compositor-independent input: DOM click via evaluate (headless input
// dispatch stalls whenever the compositor isn't producing frames).
const click = (sel) => page.evaluate((s) => document.querySelector(s).click(), sel);

await page.goto('http://localhost:8123/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu.show', { timeout: 60000 });
await page.waitForFunction('(window.__sim.frames || 0) > 3', { timeout: 90000, polling: 500 });

await click('[data-sel="aircraft"]');
await click('[data-sel="aircraft"]');
console.log('label after 2 cycles:', await page.evaluate(() => document.querySelector('#sel-aircraft').textContent));

await click('#btn-start');
await new Promise(r => setTimeout(r, 3500));
console.log(await page.evaluate(() => ({ state: window.__sim.game.state, aircraft: window.__sim.ac.p.id, ground: window.__sim.ac.onGround })));

await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
await new Promise(r => setTimeout(r, 400));
await click('#pause [data-act="menu"]');
await page.evaluate(() => window.__sim.game.select({ aircraft: 'c172', mode: 'free' }));
await click('#btn-start');
await new Promise(r => setTimeout(r, 2500));
console.log('back on c172:', await page.evaluate(() => ({ id: window.__sim.ac.p.id, state: window.__sim.game.state, ground: window.__sim.ac.onGround })));
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
process.exit(errors.length ? 1 : 0);
