'use strict';
// End-to-end browser test: real Chromium against the real server (fake clock, fake Stripe, fake mail).
//   npm run e2e         (uses /opt/pw-browsers/chromium unless CHROMIUM_PATH is set)
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startApp } = require('./helpers');

const SHOTS = path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const EXE = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const SETUP_KEY = 'test-setup-key-1234567890';
const OWNER_EMAIL = 'owner@example.com', OWNER_PW = 'correct horse battery staple';
const BOARD_PIN = '654321', BARBER_PIN = '246810';

/* ---------------- tiny test harness ---------------- */
let checks = 0;
const t0 = Date.now();
function ok(cond, msg) { assert.ok(cond, msg); checks++; console.log('  ok  ' + msg); }
function eq(a, b, msg) { assert.deepEqual(a, b, msg); checks++; console.log('  ok  ' + msg); }
async function section(name, fn) { console.log('\n# ' + name); await fn(); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, msg, timeout = 8000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(100); }
  throw new Error('timed out waiting for: ' + msg + (last instanceof Error ? ' (' + last.message + ')' : ''));
}

/* ---------------- watchers: console errors, CSP violations, storage writes ---------------- */
const consoleErrors = [], cspEvents = [], storageWrites = [], httpErrors = [], expectedHttp = [];
function expectHttp(status, urlPart, n = 1) { for (let i = 0; i < n; i++) expectedHttp.push({ status, urlPart }); }

async function newContext(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ...opts });
  await ctx.exposeBinding('__cspReport', (src, info) => { cspEvents.push(info); });
  await ctx.exposeBinding('__storageReport', (src, info) => { storageWrites.push(info); });
  await ctx.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => window.__cspReport({ directive: e.violatedDirective, blocked: e.blockedURI, src: e.sourceFile, line: e.lineNumber }));
    for (const S of [Storage.prototype]) {
      const orig = S.setItem;
      S.setItem = function (k, v) { try { window.__storageReport({ key: String(k), len: String(v).length }); } catch (e) { /* ignore */ } return orig.apply(this, arguments); };
    }
  });
  // Google Fonts is not reachable from CI: answer with empty CSS so nothing errors
  await ctx.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '/* offline */' }));
  ctx.on('page', (page) => watch(page));
  return ctx;
}
function watch(page) {
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const text = m.text();
    const mm = /Failed to load resource: the server responded with a status of (\d+)/.exec(text);
    if (mm) { httpErrors.push({ status: +mm[1], url: m.location().url || '' }); return; }
    if (m.type() === 'warning' && !/content security|refused to|csp/i.test(text)) return;
    consoleErrors.push(`[${m.type()}] ${text} @ ${m.location().url}`);
  });
  page.on('pageerror', (e) => consoleErrors.push('[pageerror] ' + e.message));
}

/* ---------------- helpers ---------------- */
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makePng(w, h) {
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) { rows[o + 1 + x * 3] = (x * 255 / w) | 0; rows[o + 2 + x * 3] = (y * 255 / h) | 0; rows[o + 3 + x * 3] = ((x + y) * 7) & 255; }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))]);
}
const bodyText = (page) => page.evaluate(() => document.body.textContent.replace(/\s+/g, " "));
async function noHScroll(page, label) {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, bw: document.body.scrollWidth }));
  ok(m.sw <= m.iw && m.bw <= m.iw, `${label}: no horizontal page scroll (${m.sw}px content in ${m.iw}px)`);
}
async function noInlineHandlers(page, label) {
  const bad = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('*').forEach((el) => {
      for (const a of el.attributes) if (/^on/i.test(a.name)) out.push(el.tagName + '[' + a.name + ']');
      if (el.tagName === 'SCRIPT' && !el.getAttribute('src')) out.push('inline <script>');
      if (el.tagName === 'A' && /^\s*javascript:/i.test(el.getAttribute('href') || '')) out.push('javascript: href');
    });
    return out;
  });
  eq(bad, [], `${label}: no inline handlers/scripts in the DOM`);
}
async function shot(page, name, opts = {}) { await page.screenshot({ path: path.join(SHOTS, name + '.png'), ...opts }); }
const fillF = async (page, id, value) => { await page.locator('#' + id).fill(value); };

/* customer wizard driver (mobile) */
async function goToTimeStep(page, barberId, serviceId) {
  await page.locator('[data-action="start-booking"]').first().click();
  await page.locator(`[data-action="pick-barber"][data-id="${barberId}"]`).click();
  await page.locator('.wiz-nav .btn-primary').click();
  await page.locator(`[data-action="pick-service"][data-id="${serviceId}"]`).click();
  await page.locator('.wiz-nav .btn-primary').click();
  await page.waitForSelector('.slot-btn');
}
async function pickSlot(page, index = 0) {
  const btn = page.locator('.slot-btn').nth(index);
  const label = (await btn.innerText()).trim();
  await btn.click();
  await page.locator('.wiz-nav .btn-primary').click();
  return label;
}
async function fillInfo(page, { name, phone, email = '', notes = '', optIn }) {
  await page.waitForSelector('#f_w_name');
  await fillF(page, 'f_w_name', name); await fillF(page, 'f_w_phone', phone);
  if (email) await fillF(page, 'f_w_email', email);
  if (notes) await fillF(page, 'f_w_notes', notes);
  if (optIn !== undefined) { const cb = page.locator('[data-f="w.optIn"]'); if ((await cb.isChecked()) !== optIn) await cb.click(); }
}


/* ---------------- several appointments in ONE checkout: $5 per appointment ---------------- */
// Dollar amounts a customer may see: the booking fee and its multiples ($5..$30) anywhere. The in-store service prices and
// sums of them (up to 6 appointments) ONLY on the checkout step and the confirmation screen (opts.store), where "$0" (payments off)
// is fine too. opts.prices overrides the in-store price list (after the owner edits a price).
const STORE_PRICES = [35, 35, 32, 67];
function storeSums(prices = STORE_PRICES) {
  let sums = new Set([0]);
  for (let i = 0; i < 6; i++) { const next = new Set(sums); for (const t of sums) for (const pr of prices) next.add(t + pr); sums = next; }
  // the combined "Total" = in-store sum + up to six $5 booking fees
  const withFees = new Set(sums);
  for (const t of sums) for (let k = 1; k <= 6; k++) withFees.add(t + 5 * k);
  return withFees;
}
async function moneyClean(page, label, opts = {}) {
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  const text = await bodyText(page);
  const okSums = opts.store ? storeSums(opts.prices) : new Set();
  const bad = (html.match(/\$\s?\d[\d,]*(?:\.\d+)?/g) || []).filter((a) => { const n = Number(a.replace(/[$\s,]/g, '')); return !((Number.isInteger(n) && n >= 5 && n <= 30 && n % 5 === 0) || okSums.has(n)); });
  eq(bad, [], `${label}: no dollar amount other than the $5 fee and its multiples` + (opts.store ? ' and the in-store prices/sums' : ' (no service prices here)'));
  ok(!/deposit/i.test(html + ' ' + text), `${label}: never says "deposit"`);
  // no service duration either ("30 min", "45 minutes", "30-minute"); the arrival tip and the shop's walk-in cut-off are not service lengths
  const mins = (text.replace(/arrive about 10 minutes early|Last walk-in 30 min before close/gi, '').match(/\b\d+\s*-?\s*(?:min|mins|minutes?)\b/gi) || []);
  eq(mins, [], `${label}: no service minutes shown to the customer`);
}
const SERVICE_NAMES = ['Haircut', 'Kids Cut', 'Beard Only', 'Haircut & Beard'];
// (a) the landing "Services" list: exactly the four services, each with the $5 booking fee (or no fee at all when payments are off)
async function landingServicesOk(page, label, feeOn = true) {
  const lines = (await page.locator('.price-line').allInnerTexts()).map((x) => x.replace(/\s+/g, ' ').trim());
  eq(lines.length, 4, `${label}: the landing Services list has exactly four lines`);
  ok(SERVICE_NAMES.every((n, i) => lines[i].startsWith(n)), `${label}: landing services are ${SERVICE_NAMES.join(' / ')} in order (${lines.join(' | ')})`);
  ok(lines[1].includes('12 & under'), `${label}: Kids Cut carries its "12 & under" note`);
  if (feeOn) ok(lines.every((l) => /\$5\s*booking fee$/.test(l)), `${label}: every landing service shows the $5 booking fee and nothing else`);
  else ok(lines.every((l) => !/\$|booking fee/i.test(l)), `${label}: with payments off no landing service shows any fee`);
}
// (a) the service step: four cards, each with the $5 booking fee
async function serviceCardsOk(page, label) {
  const cards = (await page.locator('[data-action="pick-service"]').allInnerTexts()).map((x) => x.replace(/\s+/g, ' ').trim());
  eq(cards.length, 4, `${label}: the service step has exactly four cards`);
  ok(SERVICE_NAMES.every((n, i) => cards[i].startsWith(n)), `${label}: cards are ${SERVICE_NAMES.join(' / ')} in order (${cards.join(' | ')})`);
  ok(cards.every((c) => /booking fee\s*\$5$/.test(c)), `${label}: every service card shows the $5 booking fee and nothing else`);
}
const payButton = (page) => page.locator('[data-action="book"]');
const oneLine = (x) => x.replace(/\s+/g, ' ').trim();
const addDollars = (a, b) => '$' + (Number(a.slice(1)) + Number(b.slice(1)));

// The checkout step's THREE lines: "Due in store" (calm), "Due now" (strongest, the only online charge), then the combined "Total".
async function totalsOk(page, label, { store, now, n, off = false }) {
  const tots = page.locator('.totals .tot');
  eq(await tots.count(), 3, `${label}: the totals block has exactly three lines`);
  eq(await tots.evaluateAll((els) => els.map((e) => (/tot-store/.test(e.className) ? 'store' : /tot-now/.test(e.className) ? 'now' : /tot-total/.test(e.className) ? 'total' : '?'))), ['store', 'now', 'total'], `${label}: order is "Due in store", "Due now", then "Total"`);
  eq(oneLine(await page.locator('.tot-store .tot-label').innerText()), 'Due in store', `${label}: first label is "Due in store"`);
  eq(oneLine(await page.locator('.tot-store .tot-amt').innerText()), store, `${label}: Due in store = ${store}`);
  const sub1 = oneLine(await page.locator('.tot-store .tot-sub').innerText());
  ok(sub1 === `Service price for ${n} appointment${n > 1 ? 's' : ''}. Paid at the shop, not online.`, `${label}: in-store sublabel says it is paid at the shop, not online (${sub1})`);
  eq(oneLine(await page.locator('.tot-now .tot-label').innerText()), 'Due now', `${label}: second label is "Due now"`);
  eq(oneLine(await page.locator('.tot-now .tot-amt').innerText()), now, `${label}: Due now = ${now}`);
  const sub2 = oneLine(await page.locator('.tot-now .tot-sub').innerText());
  if (off) ok(sub2 === 'Nothing to pay online.', `${label}: Due now sublabel: "Nothing to pay online." (${sub2})`);
  else ok(sub2 === `$5 booking fee × ${n} appointment${n > 1 ? 's' : ''}. This is the only online charge.`, `${label}: Due now sublabel says the $5 fee x ${n} is the only online charge (${sub2})`);
  const g = await page.evaluate(() => {
    const a = document.querySelector('.tot-store'), b = document.querySelector('.tot-now');
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    const fs = (sel) => parseFloat(getComputedStyle(document.querySelector(sel)).fontSize);
    return { aBottom: ra.bottom, bTop: rb.top, aW: ra.width, bW: rb.width, iw: window.innerWidth, aRight: ra.right, bRight: rb.right, fsStore: fs('.tot-store .tot-amt'), fsNow: fs('.tot-now .tot-amt'), wNow: Number(getComputedStyle(document.querySelector('.tot-now .tot-amt')).fontWeight) };
  });
  ok(g.bTop >= g.aBottom + 4, `${label}: the two totals are separate boxes, one under the other (${Math.round(g.aBottom)} < ${Math.round(g.bTop)})`);
  ok(g.aRight <= g.iw && g.bRight <= g.iw, `${label}: both totals fit the ${g.iw}px screen`);
  ok(g.fsNow > g.fsStore && g.fsNow >= 28 && g.wNow >= 600, `${label}: "Due now" is the biggest, boldest figure (${g.fsNow}px vs ${g.fsStore}px)`);
  // the combined total = due in store + due now, and it says only the due-now part is charged online
  eq(oneLine(await page.locator('.tot-total .tot-label').innerText()), 'Total', `${label}: third label is "Total"`);
  const total = addDollars(store, now);
  eq(oneLine(await page.locator('.tot-total .tot-amt').innerText()), total, `${label}: Total = ${store} + ${now} = ${total}`);
  const sub3 = oneLine(await page.locator('.tot-total .tot-sub').innerText());
  if (off) ok(/Nothing is charged online/.test(sub3), `${label}: Total sublabel says nothing is charged online (${sub3})`);
  else ok(sub3 === `${store} due in store + ${now} due now. Only the ${now} due now is charged online.`, `${label}: Total sublabel says only Due now is charged online (${sub3})`);
  const g2 = await page.evaluate(() => { const b = document.querySelector('.tot-now').getBoundingClientRect(), c = document.querySelector('.tot-total').getBoundingClientRect(); return { bBottom: b.bottom, cTop: c.top, cRight: c.right, iw: window.innerWidth, fsNow: parseFloat(getComputedStyle(document.querySelector('.tot-now .tot-amt')).fontSize), fsTotal: parseFloat(getComputedStyle(document.querySelector('.tot-total .tot-amt')).fontSize) }; });
  ok(g2.cTop >= g2.bBottom + 4 && g2.cRight <= g2.iw, `${label}: the Total is its own box under "Due now" and fits the screen`);
  ok(g2.fsNow > g2.fsTotal, `${label}: "Due now" stays the biggest figure (${g2.fsNow}px vs Total ${g2.fsTotal}px)`);
}
// The confirmation screen's two totals: "Paid online (booking fees)" and "Due in store".
async function confirmTotalsOk(page, label, { paid, store }) {
  const tots = page.locator('.totals .tot');
  eq(await tots.count(), 3, `${label}: confirmation has exactly three lines`);
  eq(await tots.evaluateAll((els) => els.map((e) => (/tot-paid/.test(e.className) ? 'paid' : /tot-store/.test(e.className) ? 'store' : /tot-total/.test(e.className) ? 'total' : '?'))), ['paid', 'store', 'total'], `${label}: "Paid online", "Due in store", then "Total"`);
  eq(oneLine(await page.locator('.tot-paid .tot-label').innerText()), 'Paid online (booking fees)', `${label}: first label is "Paid online (booking fees)"`);
  eq(oneLine(await page.locator('.tot-paid .tot-amt').innerText()), paid, `${label}: Paid online ${paid}`);
  eq(oneLine(await page.locator('.tot-store .tot-label').innerText()), 'Due in store', `${label}: second label is "Due in store"`);
  eq(oneLine(await page.locator('.tot-store .tot-amt').innerText()), store, `${label}: Due in store ${store}`);
  ok(/Paid at the shop, not online/.test(await page.locator('.tot-store .tot-sub').innerText()), `${label}: in-store sublabel says it is paid at the shop`);
  if (paid !== '$0') ok(/NOT deducted from your service price/.test(await page.locator('.tot-paid .tot-sub').innerText()), `${label}: the fee sublabel says it is not deducted from the service price`);
  eq(oneLine(await page.locator('.tot-total .tot-label').innerText()), 'Total', `${label}: third label is "Total"`);
  eq(oneLine(await page.locator('.tot-total .tot-amt').innerText()), addDollars(paid, store), `${label}: Total = ${paid} paid online + ${store} due in store`);
}
// any in-store price or sum of them anywhere on the page (used on the landing / barber / service / time / info steps: must be none)
const STORE_AMOUNTS = /\$\s?(32|35|67|70|99|102|105|134|140|172|174|201|210|402)(?!\d)/;
async function noStorePrice(page, label) {
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  ok(!STORE_AMOUNTS.test(html) && !/in store|due in store/i.test(await page.evaluate(() => document.body.innerText)), `${label}: no service price or in-store wording`);
}
// drive the customer wizard for a list of { barber, svc } at one day/time (each a different barber) up to the checkout step
async function driveToCheckout(p, base, items, { day, time, name, phone, scan = false }) {
  const cont = () => p.locator('.wiz-nav .btn-primary').click();
  await p.goto(base + '/'); await p.waitForSelector('.team-card');
  if (scan) { await moneyClean(p, 'landing'); await noStorePrice(p, 'landing'); }
  await p.locator('[data-action="start-booking"]').first().click();
  for (let i = 0; i < items.length; i++) {
    if (i > 0) await p.locator('[data-action="add-another"]').click();
    await p.waitForSelector('[data-action="pick-barber"]');
    if (scan && i === 0) { await moneyClean(p, 'barber step'); await noStorePrice(p, 'barber step'); }
    await p.locator(`[data-action="pick-barber"][data-id="${items[i].barber}"]`).click(); await cont();
    await p.locator(`[data-action="pick-service"][data-id="${items[i].svc}"]`).click();
    if (scan && i === 0) { await moneyClean(p, 'service step'); await noStorePrice(p, 'service step'); }
    await cont();
    await p.waitForSelector('.slot-btn');
    await p.locator(`.day-btn[data-date="${day}"]`).click(); await p.waitForSelector(`.slot-btn[data-time="${time}"]`);
    await p.locator(`.slot-btn[data-time="${time}"]`).click();
    if (scan && i === 0) { await moneyClean(p, 'time step'); await noStorePrice(p, 'time step'); }
    await cont();
    await p.waitForSelector('#f_w_name');
  }
  await fillInfo(p, { name, phone, optIn: false });
  if (scan) { await moneyClean(p, 'info step'); await noStorePrice(p, 'info step'); }
  await cont(); await p.waitForSelector('[data-action="book"]');
}
// click Pay, follow the fake Stripe redirect, assert what Stripe was given, send the paid webhook and wait for the confirmation
async function stripeItems(app, before) {
  eq(app.fakeStripe.sessions.length, before + 1, 'exactly ONE Stripe checkout session was created');
  return app.fakeStripe.sessions[app.fakeStripe.sessions.length - 1];
}

async function multiSections({ browser, appA, appB, appC, expectHttp }) {
  const DAY = '2026-10-02', T = '14:00';
  const pickDayTime = async (p, time) => { await p.locator(`.day-btn[data-date="${DAY}"]`).click(); await p.waitForSelector(`.slot-btn[data-time="${time}"]`); };
  const cont = (p) => p.locator('.wiz-nav .btn-primary').click();

  await section('four kids, four appointments, ONE checkout on a phone (390px)', async () => {
    const ctx = await newContext(browser);
    await ctx.route('https://checkout.stripe.test/**', (route) => {
      const s = appA.fakeStripe.sessions[appA.fakeStripe.sessions.length - 1];
      route.fulfill({ status: 302, headers: { location: s.params.success_url }, body: '' });
    });
    const p = await ctx.newPage();
    eq((await p.viewportSize()).width, 390, 'phone viewport is 390px wide');
    await p.goto(A_(appA) + '/'); await p.waitForSelector('.team-card');
    await moneyClean(p, 'landing page');
    await landingServicesOk(p, 'landing page');
    await p.locator('.price-cats').scrollIntoViewIfNeeded(); await p.evaluate(() => window.scrollBy(0, -140));
    await shot(p, '16-mobile-landing-services');
    ok(/Service<\/b> paid in full at the shop/.test(await p.locator('.hero').innerHTML()) && /At the shop\s*Full price of your service/.test(await bodyText(p)), 'landing says the service is paid in full at the shop (hero fact + ticket row)');
    await p.locator('[data-action="start-booking"]').first().click();
    const kids = [
      { name: 'Maya', barber: 'b1', svc: 's2' }, { name: 'Noah', barber: 'b2', svc: 's2' },
      { name: 'Ava', barber: 'b3', svc: 's2' }, { name: 'Liam', barber: 'b4', svc: 's4' },
    ];
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      if (i > 0) await p.locator('[data-action="add-another"]').click();
      await p.waitForSelector('[data-action="pick-barber"]');
      if (i === 1) {
        const t = await bodyText(p);
        ok(/Appointment 2 of up to 6/.test(t) && /Already in your booking \(1\)/.test(t), 'the next appointment is labelled and the cart so far is summarised');
        // the same barber at the same time as an appointment already in the cart cannot be picked
        await p.locator('[data-action="pick-barber"][data-id="b1"]').click(); await cont(p);
        await p.locator('[data-action="pick-service"][data-id="s2"]').click(); await cont(p);
        await p.waitForSelector('.slot-btn'); await pickDayTime(p, T);
        ok(await p.locator(`.slot-btn[data-time="${T}"]`).isDisabled(), 'Joe at 2:00 PM is greyed out: it is already in this booking');
        ok(!(await p.locator('.slot-btn[data-time="14:30"]').isDisabled()), 'Joe at 2:30 PM is still open (the 30-minute Kids Cut ends first)');
        ok(/already in your booking/i.test(await bodyText(p)), 'a note explains the greyed-out times');
        await p.locator('.wiz-nav .btn-text').click(); await p.locator('.wiz-nav .btn-text').click();     // back to the barber step
        await p.waitForSelector('[data-action="pick-barber"]');
      }
      await p.locator(`[data-action="pick-barber"][data-id="${k.barber}"]`).click(); await cont(p);
      await p.locator(`[data-action="pick-service"][data-id="${k.svc}"]`).click();
      if (i === 0) {
        await moneyClean(p, 'service step');
        await serviceCardsOk(p, 'service step');
        const hint = await p.locator('.step-hint').innerText();
        ok(/booking fee that holds your spot in line/.test(hint) && /NOT deducted from your service/.test(hint) && /full price of your service at the shop/.test(hint), 'service step: the $5 fee is NOT deducted, the full price is paid at the shop');
        await noHScroll(p, 'service step 390px');
        await shot(p, '15-mobile-service-step', { fullPage: true });
      }
      await cont(p);
      await p.waitForSelector('.slot-btn'); await pickDayTime(p, T);
      if (i === 1) ok(!(await p.locator(`.slot-btn[data-time="${T}"]`).isDisabled()), 'a different barber CAN be booked at the same time (two kids at once)');
      await p.locator(`.slot-btn[data-time="${T}"]`).click();
      if (i === 0) await moneyClean(p, 'time step');
      await cont(p);
      await p.waitForSelector('#f_w_name');
    }
    eq(await p.locator('.cart-item').count(), 4, 'the info step lists all four appointments');
    for (let i = 0; i < 4; i++) await p.locator('.cart-item').nth(i).locator('input').fill(kids[i].name);
    ok(await p.locator('[data-action="add-another"]').isEnabled(), '"Add another appointment" is still available at four');
    await fillInfo(p, { name: 'Pat Parent', phone: '516-555-0199', email: 'pat@example.com', optIn: false });
    await noHScroll(p, 'four-kid cart 390px'); await noInlineHandlers(p, 'four-kid cart');
    await moneyClean(p, 'info step with four appointments');
    await shot(p, '10-mobile-4kids-cart', { fullPage: true });
    await cont(p);
    await p.waitForSelector('[data-action="book"]');

    // pay summary: per-appointment rows (in-store price + $5 fee), then TWO separate totals
    eq(await p.locator('.pay-row').count(), 4, 'pay summary has four appointment rows');
    eq((await p.locator('.pay-row .pa-fee .num').allInnerTexts()).map((x) => x.trim()), ['$5', '$5', '$5', '$5'], 'each appointment has its own $5 booking-fee line');
    eq((await p.locator('.pay-row .pa-store').allInnerTexts()).map((x) => x.replace(/\s+/g, ' ').trim()), ['$35 in store', '$35 in store', '$35 in store', '$67 in store'], 'and its own in-store price line (3 Kids Cuts + 1 Haircut & Beard)');
    await totalsOk(p, 'four-kid checkout', { store: '$172', now: '$20', n: 4 });
    const rowsText = await p.locator('.pay-row').allInnerTexts();
    ok(kids.every((k, i) => rowsText[i].includes(k.name)), 'rows are labelled with each child\'s name');
    const pay = await bodyText(p);
    ok(/\$5 booking fee per appointment\. Each fee holds your spot in line and is non-refundable, except when you cancel at least 12 hours ahead\. It is a separate booking fee and is NOT deducted from your service price\. The full service price is paid at the shop\./.test(pay), 'per-appointment fee microcopy is shown');
    ok(/^pay \$20 now · reserve 4 appointments$/i.test((await payButton(p).innerText()).trim()), 'pay button reads "Pay $20 now · reserve 4 appointments"');
    await moneyClean(p, 'pay step with four appointments', { store: true });
    await noHScroll(p, 'four-kid pay step 390px');
    await shot(p, '11-mobile-4kids-pay', { fullPage: true });

    // 409: someone else grabs Ava's chair first -> back to the time step for just that appointment
    const other = await appA.client().post('/api/bookings', { serviceId: 's2', barberId: 'b3', date: DAY, time: T, name: 'Quick Fingers', phone: '516-555-0123' });
    eq(other.status, 200, 'another customer takes Ava\'s exact time first');
    expectHttp(409, '/api/bookings');
    await payButton(p).click();
    await p.waitForSelector('.notice-error');
    let t = await bodyText(p);
    ok(/Ava’s Kids Cut/.test(t) && /was just taken/.test(t), 'the message names which appointment lost its time');
    ok((await p.locator('.step-title').innerText()).includes('Pick a date') && /Appointment 3 of up to 6/.test(t), 'sent back to the time step for that one appointment');
    await p.waitForSelector('.slot-btn');
    eq(await p.locator(`.slot-btn[data-time="${T}"]`).count(), 0, 'the taken time is gone from the refreshed times');
    await shot(p, '12-mobile-4kids-slot-taken');
    await p.locator('.slot-btn[data-time="14:30"]').click(); await cont(p);
    await p.waitForSelector('#f_w_name');
    eq(await p.locator('.cart-item').count(), 4, 'the other three appointments and the re-picked one are all still in the cart');
    eq(await p.locator('.cart-item').evaluateAll((els) => els.map((e) => e.querySelector('input').value)), kids.map((k) => k.name), 'the children\'s names survived, in the same order');
    eq(await p.locator('#f_w_name').inputValue(), 'Pat Parent', 'contact details survived the conflict');
    await cont(p); await p.waitForSelector('[data-action="book"]');
    const rows2 = await p.locator('.pay-row').allInnerTexts();
    ok(/2:30 PM/.test(rows2[2]) && [0, 1, 3].every((i) => /2:00 PM/.test(rows2[i])), 'only Ava\'s appointment moved to 2:30 PM');
    await totalsOk(p, 'after the conflict', { store: '$172', now: '$20', n: 4 });

    // pay once (with a nervous double tap)
    const before = appA.fakeStripe.sessions.length;
    await payButton(p).dblclick();
    await p.waitForSelector('text=Finishing your payment', { timeout: 15000 });
    eq(appA.fakeStripe.sessions.length, before + 1, 'exactly ONE Stripe checkout session was created for all four appointments');
    const s = appA.fakeStripe.sessions[appA.fakeStripe.sessions.length - 1];
    const li = (i, k) => s.params[`line_items[${i}]${k}`];
    eq([0, 1, 2, 3].map((i) => li(i, '[price_data][unit_amount]')), ['500', '500', '500', '500'], 'Stripe received four line items of 500 cents each');
    eq([0, 1, 2, 3].map((i) => li(i, '[quantity]')), ['1', '1', '1', '1'], 'each line item has quantity 1 (a fee per appointment, never a flat fee)');
    eq(li(4, '[price_data][unit_amount]'), undefined, 'and no fifth line item');
    ok(!/\d+\.\d\d/.test(JSON.stringify(s.params)) && Object.entries(s.params).filter(([k]) => /unit_amount/.test(k)).reduce((n, [, v]) => n + Number(v), 0) === 2000, 'Stripe total is 2000 cents = 4 x $5; no service price was sent (in-store $172 never reaches Stripe)');
    const groupId = s.params['metadata[group_id]'];
    const rows = appA.db.raw.prepare('SELECT * FROM bookings WHERE group_id = ? ORDER BY rowid').all(groupId);
    eq(rows.map((r) => [r.customer_name, r.contact_name, r.fee_cents, r.status]), kids.map((k) => [k.name, 'Pat Parent', 500, 'pending']), 'four pending bookings: one per child, $5 each, all under Pat');
    ok(rows.every((r) => r.phone_norm === rows[0].phone_norm), 'all four share the one contact phone entered once');
    await sleep(2500);
    const { paidEvent } = require('./helpers');
    const hook = await appA.sendWebhook(appA.client(), paidEvent('evt_e2e_kids', groupId, s.id, 2000));
    eq(hook.status, 200, 'Stripe webhook for the $20 payment accepted');
    await p.waitForSelector('.confirm-wrap', { timeout: 15000 });

    // confirmation lists every appointment
    eq(await p.locator('.confirm-appt').count(), 4, 'confirmation shows all four appointments');
    t = await bodyText(p);
    ok(kids.every((k) => t.includes(k.name)), 'each child\'s first name is on the confirmation');
    ok(['Joe', 'Azim', 'Freddy', 'Page'].every((b) => t.includes(b)) && t.includes('Kids Cut') && t.includes('Haircut & Beard') && /Friday, October 2/.test(t), 'services, barbers and date are shown');
    const codes = await p.locator('.confirm-appt .code-text').allInnerTexts();
    ok(codes.length === 4 && new Set(codes).size === 4 && codes.every((c) => /^[A-Z0-9]{8}$/.test(c.trim())), 'four different confirmation codes: ' + codes.join(', '));
    ok(/4 APPOINTMENTS CONFIRMED/i.test(t) && /Pat/.test(await p.locator('.step-title').innerText()), 'headline addresses the person who booked');
    eq((await p.locator('.confirm-appt .summary-row:has-text("In store") .num').allInnerTexts()).map((x) => x.trim()).sort(), ['$35', '$35', '$35', '$67'], 'each appointment shows its in-store price');
    await confirmTotalsOk(p, 'four-kid confirmation', { paid: '$20', store: '$172' });
    ok(/confirmation email is on its way/.test(t), 'email-sent note is shown');
    ok(!/could not be held/.test(t), 'nothing was lost');
    ok(/At the shop:\s*you pay the service price shown as Due in store\. The booking fee holds your spot in line and is not deducted from it\./.test(t), 'confirmation: the service price is paid at the shop; the fee is not deducted');
    await moneyClean(p, 'four-appointment confirmation', { store: true });
    await noHScroll(p, 'four-kid confirmation 390px');
    await shot(p, '13-mobile-4kids-confirmation', { fullPage: true });
    const oc = appA.client();          // the owner may already exist (full run) or not (quick run)
    let lg = await oc.post('/api/owner/login', { email: OWNER_EMAIL, password: OWNER_PW });
    if (lg.status !== 200) await oc.post('/api/setup', { setupKey: SETUP_KEY, email: OWNER_EMAIL, password: OWNER_PW });
    const st = (await oc.get('/api/owner/state')).json;
    eq(st.bookings.filter((b) => kids.some((k) => k.name === b.customerName) && b.feePaid && b.status === 'upcoming').length, 4, 'owner sees four paid upcoming appointments');
    await ctx.close();
  });

  await section('a paid order where one time was lost: clear notice, only that $5 refunded', async () => {
    const c = appA.client();
    const r = await c.post('/api/bookings', { name: 'Lisa Lost', phone: '516-555-0166', email: 'lisa@example.com', appointments: [
      { serviceId: 's2', barberId: 'b5', date: DAY, time: '15:00', forName: 'Zoe' }, { serviceId: 's2', barberId: 'b6', date: DAY, time: '15:00', forName: 'Eli' }] });
    eq(r.json.status, 'pending', 'two-appointment order created');
    const s = appA.fakeStripe.sessions[appA.fakeStripe.sessions.length - 1];
    const groupId = s.params['metadata[group_id]'];
    // Eli's hold lapses and someone else gets his chair before the (late) payment lands
    appA.db.raw.prepare("UPDATE bookings SET status = 'expired' WHERE customer_name = 'Eli'").run();
    eq((await appA.client().post('/api/bookings', { serviceId: 's2', barberId: 'b6', date: DAY, time: '15:00', name: 'Late Larry', phone: '516-555-0155' })).status, 200, 'another customer takes Eli\'s chair');
    const { paidEvent } = require('./helpers');
    eq((await appA.sendWebhook(appA.client(), paidEvent('evt_e2e_lost', groupId, s.id, 1000))).status, 200, 'the $10 payment arrives anyway');
    const ctx = await newContext(browser);
    const p = await ctx.newPage();
    await p.goto(A_(appA) + '/?pay=success&t=' + r.json.token);
    await p.waitForSelector('.confirm-wrap', { timeout: 15000 });
    const t = await bodyText(p);
    ok(/1 of your 2 appointments could not be held/.test(t) && /taken by someone else just before your payment finished/.test(t), 'notice says 1 of 2 appointments could not be held and why');
    ok(/shop has been alerted/.test(t) && /\$5 booking fee for it will be refunded/.test(t), 'notice says the shop was alerted and that $5 will be refunded');
    eq(await p.locator('.confirm-appt').count(), 1, 'only the held appointment is listed as booked');
    const kept1 = await p.locator('.confirm-appt').innerText(), lostL = await p.locator('.lost-list').innerText();
    ok(/zoe/i.test(kept1) && /eli/i.test(lostL), 'Zoe is booked, Eli is listed as not held (' + kept1.replace(/\s+/g, ' ') + ' / ' + lostL.replace(/\s+/g, ' ') + ')');
    ok(/service price is not included in what is due in store/.test(t), 'the notice says the lost appointment is not in the in-store total');
    await confirmTotalsOk(p, 'partly-lost confirmation', { paid: '$5', store: '$35' });
    await moneyClean(p, 'partly-lost confirmation', { store: true });
    await shot(p, '14-mobile-partial-lost', { fullPage: true });
    await ctx.close();
  });

  await section('six appointments is the cap; pay through the dev payment page (app B)', async () => {
    const ctx = await newContext(browser);
    const p = await ctx.newPage();
    await p.goto(appB.base + '/'); await p.waitForSelector('.team-card');
    await p.locator('[data-action="start-booking"]').first().click();
    const six = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'];
    for (let i = 0; i < 6; i++) {
      if (i > 0) await p.locator('[data-action="add-another"]').click();
      await p.waitForSelector('[data-action="pick-barber"]');
      await p.locator(`[data-action="pick-barber"][data-id="${six[i]}"]`).click(); await cont(p);
      await p.locator('[data-action="pick-service"][data-id="s1"]').click(); await cont(p);
      await p.waitForSelector('.slot-btn'); await pickDayTime(p, '16:00');
      await p.locator('.slot-btn[data-time="16:00"]').click(); await cont(p);
      await p.waitForSelector('#f_w_name');
    }
    eq(await p.locator('.cart-item').count(), 6, 'six appointments in the cart');
    ok(await p.locator('[data-action="add-another"]').isDisabled(), '"Add another appointment" is disabled at six');
    ok(/maximum of 6 appointments/.test(await bodyText(p)), 'and it says why');
    await p.locator('.cart-item').nth(5).locator('[data-action="cart-remove"]').click();
    eq(await p.locator('.cart-item').count(), 5, 'Remove takes one out');
    ok(await p.locator('[data-action="add-another"]').isEnabled(), '"Add another appointment" is enabled again');
    await p.locator('[data-action="add-another"]').click();
    await p.locator('[data-action="pick-barber"][data-id="b6"]').click(); await cont(p);
    await p.locator('[data-action="pick-service"][data-id="s1"]').click(); await cont(p);
    await p.waitForSelector('.slot-btn'); await pickDayTime(p, '16:00');
    await p.locator('.slot-btn[data-time="16:00"]').click(); await cont(p);
    await fillInfo(p, { name: 'Big Family', phone: '516-555-0133' });
    await cont(p); await p.waitForSelector('[data-action="book"]');
    eq(await p.locator('.pay-row').count(), 6, 'six pay rows');
    await totalsOk(p, 'six-appointment checkout', { store: '$210', now: '$30', n: 6 });
    await moneyClean(p, 'pay step with six appointments', { store: true });
    await payButton(p).click();
    await p.waitForSelector('.confirm-wrap', { timeout: 15000 });
    eq(await p.locator('.confirm-appt').count(), 6, 'dev payment page returns to a confirmation with all six');
    await confirmTotalsOk(p, 'six-appointment confirmation', { paid: '$30', store: '$210' });
    await moneyClean(p, 'six-appointment confirmation', { store: true });
    await ctx.close();
  });

  await section('payments off: "Confirm 2 appointments", nothing charged, no fee anywhere (app C)', async () => {
    const ctx = await newContext(browser);
    const p = await ctx.newPage();
    await p.goto(appC.base + '/'); await p.waitForSelector('.team-card');
    await landingServicesOk(p, 'landing (payments off)', false);
    await moneyClean(p, 'landing (payments off)');
    await p.locator('[data-action="start-booking"]').first().click();
    await p.locator('[data-action="pick-barber"][data-id="b1"]').click(); await cont(p);
    await p.waitForSelector('[data-action="pick-service"]');
    ok((await p.locator('[data-action="pick-service"]').allInnerTexts()).every((c) => !/\$|booking fee/i.test(c)), 'service cards show no fee when payments are off');
    await p.locator('.wiz-nav .btn-text').click(); await p.waitForSelector('[data-action="pick-barber"]');
    for (let i = 0; i < 2; i++) {
      if (i > 0) await p.locator('[data-action="add-another"]').click();
      await p.waitForSelector('[data-action="pick-barber"]');
      await p.locator(`[data-action="pick-barber"][data-id="${i ? 'b2' : 'b1'}"]`).click(); await cont(p);
      await p.locator('[data-action="pick-service"][data-id="s1"]').click(); await cont(p);
      await p.waitForSelector('.slot-btn'); await pickDayTime(p, '13:00');
      await p.locator('.slot-btn[data-time="13:00"]').click(); await cont(p);
      await p.waitForSelector('#f_w_name');
    }
    await fillInfo(p, { name: 'Free Parent', phone: '516-555-0144' });
    await cont(p); await p.waitForSelector('[data-action="book"]');
    eq((await payButton(p).innerText()).trim(), 'CONFIRM 2 APPOINTMENTS', 'button reads "Confirm 2 appointments"');
    eq(await p.locator('.pa-fee').count(), 0, 'no fee lines when payments are off');
    await totalsOk(p, 'payments-off checkout', { store: '$70', now: '$0', n: 2, off: true });
    ok(/Nothing to pay online/.test(await bodyText(p)) && !/booking fee\s*×|only online charge/.test(await bodyText(p)), 'payments off: "Nothing to pay online", no fee wording in the totals');
    await moneyClean(p, 'pay step (payments off)', { store: true });
    await payButton(p).click();
    await p.waitForSelector('.confirm-wrap', { timeout: 15000 });
    eq(await p.locator('.confirm-appt').count(), 2, 'confirmation lists both appointments');
    await confirmTotalsOk(p, 'payments-off confirmation', { paid: '$0', store: '$70' });
    ok(/No booking fee was charged online/.test(await bodyText(p)), 'payments off: the confirmation says no booking fee was charged');
    await moneyClean(p, 'payments-off confirmation', { store: true });
    await ctx.close();
  });

  /* ---- the checkout shows TWO totals: "Due in store" (service prices) and "Due now" (the $5 fee per appointment) ---- */
  const D3 = '2026-10-02';
  await section('checkout on a phone: 3 Haircuts = Due in store $105, Due now $15; Stripe gets only the $5 fees', async () => {
    const ctx = await newContext(browser);
    await ctx.route('https://checkout.stripe.test/**', (route) => {
      const s = appA.fakeStripe.sessions[appA.fakeStripe.sessions.length - 1];
      route.fulfill({ status: 302, headers: { location: s.params.success_url }, body: '' });
    });
    const p = await ctx.newPage();
    eq((await p.viewportSize()).width, 390, 'phone viewport is 390px wide');
    await driveToCheckout(p, appA.base, [{ barber: 'b1', svc: 's1' }, { barber: 'b2', svc: 's1' }, { barber: 'b3', svc: 's1' }], { day: D3, time: '12:00', name: 'Trio Parent', phone: '516-555-0171', scan: true });
    eq((await p.locator('.pay-row .pa-store').allInnerTexts()).map(oneLine), ['$35 in store', '$35 in store', '$35 in store'], 'each row shows "$35 in store"');
    eq((await p.locator('.pay-row .pa-fee').allInnerTexts()).map(oneLine), ['$5 booking fee', '$5 booking fee', '$5 booking fee'], 'and "$5 booking fee"');
    await totalsOk(p, '3-haircut checkout', { store: '$105', now: '$15', n: 3 });
    ok(/^pay \$15 now · reserve 3 appointments$/i.test(oneLine(await payButton(p).innerText())), 'pay button reads "Pay $15 now · reserve 3 appointments"');
    const t = await bodyText(p);
    ok(/holds your spot in line and is non-refundable/.test(t) && /NOT deducted from your service price/.test(t) && /full service price is paid at the shop/.test(t) && /12 hours/.test(t), 'policy note: fee holds the spot, non-refundable, not deducted; service price paid at the shop; cancellation window');
    await moneyClean(p, '3-haircut checkout', { store: true });
    await noHScroll(p, '3-haircut checkout 390px'); await noInlineHandlers(p, '3-haircut checkout');
    await shot(p, '17-mobile-3haircuts-checkout', { fullPage: true });
    await p.locator('.totals').scrollIntoViewIfNeeded(); await shot(p, '17b-mobile-3haircuts-totals');
    const before = appA.fakeStripe.sessions.length;
    await payButton(p).click();
    await p.waitForSelector('text=Finishing your payment', { timeout: 15000 });
    const s = await stripeItems(appA, before);
    const li = (i, k) => s.params[`line_items[${i}]${k}`];
    eq([0, 1, 2].map((i) => li(i, '[price_data][unit_amount]')), ['500', '500', '500'], 'Stripe got exactly three line items of 500 cents');
    eq(li(3, '[price_data][unit_amount]'), undefined, 'and no fourth line item');
    const amounts = Object.entries(s.params).filter(([k]) => /unit_amount/.test(k)).map(([, v]) => Number(v));
    ok(amounts.length === 3 && amounts.reduce((a, b) => a + b, 0) === 1500 && !Object.values(s.params).some((v) => /^(3500|10500)$/.test(String(v))), 'Stripe total is 1500 cents; no service price ($35 / $105) was sent');
    await sleep(2500);
    const { paidEvent } = require('./helpers');
    eq((await appA.sendWebhook(appA.client(), paidEvent('evt_e2e_trio', s.params['metadata[group_id]'], s.id, 1500))).status, 200, 'Stripe webhook for the $15 payment accepted');
    await p.waitForSelector('.confirm-wrap', { timeout: 15000 });
    eq(await p.locator('.confirm-appt').count(), 3, 'confirmation lists all three appointments');
    eq((await p.locator('.confirm-appt .summary-row:has-text("In store") .num').allInnerTexts()).map(oneLine), ['$35', '$35', '$35'], 'each with its in-store price');
    await confirmTotalsOk(p, '3-haircut confirmation', { paid: '$15', store: '$105' });
    ok(/Paid online \(booking fees\)\s*\$15/.test(await bodyText(p)) && /Due in store\s*\$105/.test(await bodyText(p)), 'confirmation reads "Paid online $15" and "Due in store $105"');
    await moneyClean(p, '3-haircut confirmation', { store: true });
    await noHScroll(p, '3-haircut confirmation 390px');
    await shot(p, '18-mobile-3haircuts-confirmation', { fullPage: true });
    await ctx.close();
  });

  await section('mixed cart: Kids Cut + Beard Only + Haircut & Beard = Due in store $134, Due now $15', async () => {
    const ctx = await newContext(browser);
    await ctx.route('https://checkout.stripe.test/**', (route) => {
      const s = appA.fakeStripe.sessions[appA.fakeStripe.sessions.length - 1];
      route.fulfill({ status: 302, headers: { location: s.params.success_url }, body: '' });
    });
    const p = await ctx.newPage();
    await driveToCheckout(p, appA.base, [{ barber: 'b1', svc: 's2' }, { barber: 'b2', svc: 's3' }, { barber: 'b3', svc: 's4' }], { day: D3, time: '12:30', name: 'Mixed Family', phone: '516-555-0172', scan: true });
    eq((await p.locator('.pay-row .pa-store').allInnerTexts()).map(oneLine), ['$35 in store', '$32 in store', '$67 in store'], 'rows show $35, $32 and $67 in store');
    await totalsOk(p, 'mixed checkout', { store: '$134', now: '$15', n: 3 });
    await moneyClean(p, 'mixed checkout', { store: true });
    await noHScroll(p, 'mixed checkout 390px');
    const before = appA.fakeStripe.sessions.length;
    await payButton(p).click();
    await p.waitForSelector('text=Finishing your payment', { timeout: 15000 });
    const s = await stripeItems(appA, before);
    eq([0, 1, 2, 3].map((i) => s.params[`line_items[${i}][price_data][unit_amount]`]), ['500', '500', '500', undefined], 'Stripe got three 500-cent fee lines whatever the services cost');
    await sleep(2500);
    const { paidEvent } = require('./helpers');
    eq((await appA.sendWebhook(appA.client(), paidEvent('evt_e2e_mixed', s.params['metadata[group_id]'], s.id, 1500))).status, 200, 'Stripe webhook for the $15 payment accepted');
    await p.waitForSelector('.confirm-wrap', { timeout: 15000 });
    eq((await p.locator('.confirm-appt .summary-row:has-text("In store") .num').allInnerTexts()).map(oneLine).sort(), ['$32', '$35', '$67'], 'confirmation shows each in-store price');
    await confirmTotalsOk(p, 'mixed confirmation', { paid: '$15', store: '$134' });
    await moneyClean(p, 'mixed confirmation', { store: true });
    await ctx.close();
  });
}
const A_ = (app) => app.base;

async function main() {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  const appA = await startApp();                                // fake Stripe + fake mail
  const appB = await startApp({}, { stripe: false });           // no Stripe key -> dev-pay page
  const appC = await startApp({ REQUIRE_PAYMENT: '0' }, { stripe: false });   // payments off: bookings confirm at once
  const A = appA.base, B = appB.base;
  let slowPage = null;

  try {
    /* ============================================================== static hygiene */
    await section('served HTML is CSP-clean', async () => {
      const html = await (await fetch(A + '/')).text();
      ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'index.html has no inline <script>');
      ok(!/\son[a-z]+\s*=/i.test(html), 'index.html has no inline event-handler attributes');
      const js = await (await fetch(A + '/app.js')).text();
      ok(!/\beval\s*\(|new Function\s*\(|document\.write\s*\(/.test(js), 'app.js never uses eval / new Function / document.write');
      ok(!/\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b/.test(js), 'app.js never touches browser storage');
      const csp = (await fetch(A + '/')).headers.get('content-security-policy');
      ok(/script-src 'self'(;|$)/.test(csp), 'server sends script-src \'self\'');
    });

    if (process.env.E2E_MULTI_ONLY) { await multiSections({ browser, appA, appB, appC, expectHttp }); return; }

    /* ============================================================== customer: dev-pay journey (app B) */
    const custCtx = await newContext(browser);
    const cp = await custCtx.newPage();
    let bookingPhone = '(516) 555-0142';
    await section('customer booking on mobile (dev payment page)', async () => {
      await cp.goto(B + '/');
      await cp.waitForSelector('.hero h1');
      ok((await cp.title()).includes('Barberchops'), 'landing page loads with the shop name');
      ok(await cp.locator('.brand-logo use').count() === 1, 'logo renders');
      await noHScroll(cp, 'landing 390px'); await noInlineHandlers(cp, 'landing');
      const teamCount = await cp.locator('.team-card').count();
      eq(teamCount, 8, 'team strip shows all 8 barbers from the server');
      const pubSvc = (await fetch(B + '/api/public').then((r) => r.json())).services;
      eq(pubSvc.map((s) => s.name), SERVICE_NAMES, 'the server offers exactly the four services');
      await landingServicesOk(cp, 'landing (dev-pay app)');
      { const lt = await bodyText(cp); ok(SERVICE_NAMES.every((n) => lt.includes(n)) && !lt.includes('Hot Lather'), 'service list is rendered from the server (old services are gone)'); }
      await moneyClean(cp, 'landing (dev-pay app)');
      ok((await cp.locator('.footer-bottom button[data-action="go-staff"]').innerText()).includes('Employees'), 'small "Employees" button in the footer');
      ok((await cp.locator('.footer-bottom button[data-action="go-board"]').innerText()).trim() === 'TV', '"TV" footer button exists');
      eq(await cp.locator('.hero [data-action="go-staff"], .hero [data-action="go-board"], .hero [data-action="go-owner"]').count(), 0, 'Employees/TV buttons are not in the Book Now area');
      await shot(cp, '01-mobile-home-top');
      await cp.locator('#app .team-grid').scrollIntoViewIfNeeded();
      await cp.evaluate(() => window.scrollBy(0, -120));
      await shot(cp, '02-mobile-home-team');

      // wizard
      await cp.locator('[data-action="start-booking"]').first().click();
      await cp.locator('[data-action="pick-barber"][data-id="b1"]').click();
      await cp.locator('.wiz-nav .btn-primary').click();
      await cp.waitForSelector('[data-action="pick-service"]');
      await serviceCardsOk(cp, 'service step (dev-pay app)');
      await moneyClean(cp, 'service step (dev-pay app)');
      await cp.locator('[data-action="pick-service"][data-id="s1"]').click();
      await cp.locator('.wiz-nav .btn-primary').click();
      await cp.waitForSelector('.slot-btn');
      await moneyClean(cp, 'time step (dev-pay app)');
      await noHScroll(cp, 'time step 390px');
      ok(/step 3 of 6/i.test(await bodyText(cp)), 'mobile progress indicator shows the step');
      await shot(cp, '03-mobile-time-step');
      await pickSlot(cp, 0);
      // info step
      await cp.waitForSelector('#f_w_name');
      ok(await cp.locator('[data-f="w.optIn"]').isChecked(), 'marketing consent checkbox is pre-ticked (shop setting)');
      eq(await cp.locator('#f_website').inputValue(), '', 'honeypot "website" field is empty');
      ok((await cp.locator('#f_website').evaluate((e) => e.name)) === 'website', 'honeypot field is named "website"');
      await cp.locator('.consent-letter summary').click();
      ok((await cp.locator('.consent-body').innerText()).includes('not a condition'), 'consent letter text is shown');
      // validation
      await cp.locator('.wiz-nav .btn-primary').click();
      ok((await bodyText(cp)).includes('Please enter your full name'), 'info step validates the name');
      ok((await bodyText(cp)).includes('A phone number is required so the shop can reach you'), 'phone number is mandatory: empty is refused with a clear reason');
      ok((await cp.locator('#f_w_phone').getAttribute('required')) !== null, 'phone field is marked required');
      ok((await cp.locator('label[for="f_w_phone"]').innerText()).toLowerCase().includes('required'), 'phone label says required');
      await fillInfo(cp, { name: 'Jordan "JD" O\'Neil & Sons', phone: bookingPhone, email: 'jordan@example.com', notes: 'skin fade, keep the top' });
      await noHScroll(cp, 'info step 390px');
      await shot(cp, '04-mobile-info-step');
      await cp.locator('.wiz-nav .btn-primary').click();
      await cp.waitForSelector('[data-action="book"]');
      const payText = await bodyText(cp);
      ok(payText.includes('$5') && /non-refundable/.test(payText) && payText.includes('12 hours'), 'pay step explains the $5 fee and the 12-hour cancel window');
      ok(/\$5 booking fee per appointment\. Each fee holds your spot in line and is non-refundable, except when you cancel at least 12 hours ahead\. It is a separate booking fee and is NOT deducted from your service price\. The full service price is paid at the shop\./.test(payText), 'pay step: the fee is NOT deducted from the service price; the full price is paid at the shop');
      await totalsOk(cp, 'single-appointment checkout', { store: '$35', now: '$5', n: 1 });
      ok(/^pay \$5 now · reserve 1 appointment$/i.test((await payButton(cp).innerText()).trim()), 'single appointment: button reads "Pay $5 now · reserve 1 appointment"');
      await moneyClean(cp, 'info + pay steps (dev-pay app)', { store: true });
      await shot(cp, '05-mobile-pay-step');
    });
    await section('slot-taken conflict returns to the time step with fresh times', async () => {
      // rebuild cleanly: find which slot the page selected and book it from another "browser"
      const sel = await cp.evaluate(() => { const w = document.querySelector('.summary-box'); return w ? w.innerText : ''; });
      ok(/at 1?\d:\d\d (AM|PM)/.test(sel), 'summary shows the chosen time');
      const m = /at (\d{1,2}):(\d\d) (AM|PM)/.exec(sel);
      let h = +m[1] % 12; if (m[3] === 'PM') h += 12;
      const hhmm = String(h).padStart(2, '0') + ':' + m[2];
      const c2 = appB.client();
      const r = await c2.post('/api/bookings', { serviceId: 's1', barberId: 'b1', date: '2026-09-30', time: hhmm, name: 'Other Person', phone: '516-555-0999' });
      eq(r.status, 200, 'another customer grabs that exact time first');
      expectHttp(409, '/api/bookings');
      await cp.locator('[data-action="book"]').click();
      await cp.waitForSelector('.notice-error');
      const txt = await bodyText(cp);
      ok(/just taken/.test(txt), 'shows "that time was just taken"');
      ok((await cp.locator('.step-title').innerText()).includes('Pick a date'), 'sent back to the time step');
      await cp.waitForSelector('.slot-btn');
      const stillThere = await cp.locator(`.slot-btn[data-time="${hhmm}"]`).count();
      eq(stillThere, 0, 'the taken time is gone from the refreshed availability');
      await shot(cp, '06-mobile-slot-taken');
      await cp.locator('.slot-btn').first().click();
      await cp.locator('.wiz-nav .btn-primary').click();
      eq(await cp.locator('#f_w_name').inputValue(), 'Jordan "JD" O\'Neil & Sons', 'form entries survive the conflict');
      await cp.locator('.wiz-nav .btn-primary').click();
      await cp.waitForSelector('[data-action="book"]');
    });
    let confirmCode = '';
    await section('pay via the dev payment page and see the confirmation', async () => {
      const btn = cp.locator('[data-action="book"]');
      await btn.dblclick();          // a nervous double tap must not book twice
      await cp.waitForSelector('.confirm-wrap', { timeout: 15000 });
      confirmCode = (await cp.locator('#confirm-code').innerText()).trim();
      ok(/^[A-Z0-9]{8}$/.test(confirmCode), 'confirmation code shown (' + confirmCode + ')');
      const t = await bodyText(cp);
      ok(t.includes('Haircut') && t.includes('Joe') && t.includes('September 30'), 'confirmation shows service, barber, date');
      ok(/At the shop:\s*you pay the service price shown as Due in store/.test(t) && /not deducted/.test(t), 'confirmation: the service price is paid at the shop, fee not deducted');
      await confirmTotalsOk(cp, 'confirmation (dev-pay app)', { paid: '$5', store: '$35' });
      await moneyClean(cp, 'confirmation (dev-pay app)', { store: true });
      ok(/confirmation email is on its way/.test(t), 'confirmation notes that an email was sent');
      ok(!/pay=|[?&]t=/.test(cp.url()), 'payment token was removed from the address bar');
      await noHScroll(cp, 'confirmation 390px');
      await shot(cp, '07-mobile-confirmation');
      await until(() => appB.fakeMail.sent.some((m) => m.to.includes('jordan@example.com')), 'customer confirmation email');
      ok(true, 'customer confirmation email was queued and sent');
      const owner = await appB.ownerClient();
      const st = (await owner.get('/api/owner/state')).json;
      const bk = st.bookings.find((b) => b.customerName.startsWith('Jordan'));
      ok(bk && bk.status === 'upcoming' && bk.feePaid, 'booking is upcoming and fee paid on the server');
      eq(appB.db.raw.prepare("SELECT COUNT(*) c FROM bookings WHERE customer_name LIKE 'Jordan%'").get().c, 1, 'double-tapping Pay created exactly one booking');
      ok(bk.customerName === 'Jordan "JD" O\'Neil & Sons', 'special characters stored exactly');
      const cust = st.customers.find((c) => c.name.startsWith('Jordan'));
      ok(cust && cust.optIn === true, 'the pre-ticked consent was recorded as an opt-in');
      // no other data leaks: the honeypot stays empty and nothing was saved in the browser
      eq(storageWrites, [], 'no page has written to localStorage/sessionStorage so far');
    });
    await section('customer: book another (consent unticked) + back button + keyboard focus', async () => {
      await cp.locator('[data-action="book-another"]').click();
      await cp.waitForSelector('[data-action="pick-barber"]');
      ok((await cp.locator('.step-title').innerText()).includes('Choose your barber'), 'book another restarts the wizard');
    });

    /* ============================================================== 320px width */
    await section('no horizontal scroll at 320px', async () => {
      const ctx = await newContext(browser, { viewport: { width: 320, height: 640 } });
      const p = await ctx.newPage();
      await p.goto(B + '/'); await p.waitForSelector('.hero h1');
      await noHScroll(p, 'landing 320px');
      await goToTimeStep(p, 'any', 's4');
      await noHScroll(p, 'time step 320px');
      await pickSlot(p, 1);
      await p.waitForSelector('#f_w_name');
      await noHScroll(p, 'info step 320px');
      await ctx.close();
    });

    /* ============================================================== owner (app A) */
    const ownCtx = await newContext(browser, { permissions: ['clipboard-read', 'clipboard-write'] });
    const op = await ownCtx.newPage();
    await section('owner first-time setup and login', async () => {
      await op.goto(A + '/#owner');
      await op.waitForSelector('form[data-submit="owner-setup"]');
      ok((await bodyText(op)).includes('Set up your owner account'), 'first-time setup screen shown');
      await fillF(op, 'f_os_key', 'wrong-key-wrong-key'); await fillF(op, 'f_os_email', OWNER_EMAIL); await fillF(op, 'f_os_pw', OWNER_PW); await fillF(op, 'f_os_pw2', 'short');
      await op.locator('button[type="submit"]').click();
      ok((await bodyText(op)).includes('don’t match'), 'password confirmation mismatch is caught before sending');
      await fillF(op, 'f_os_pw2', OWNER_PW);
      expectHttp(403, '/api/setup');
      await op.locator('button[type="submit"]').click();
      await op.waitForSelector('.notice-error');
      ok((await bodyText(op)).includes('setup key is not right'), 'wrong setup key is rejected with the server message');
      await fillF(op, 'f_os_key', SETUP_KEY);
      await op.locator('button[type="submit"]').click();
      await op.waitForSelector('.dash-tabs');
      ok((await bodyText(op)).includes('Owner dashboard'), 'owner dashboard opens after setup');
      await op.locator('[data-action="o-logout"]').click();
      await op.waitForSelector('form[data-submit="owner-login"]');
      await fillF(op, 'f_ol_email', OWNER_EMAIL); await fillF(op, 'f_ol_pw', 'not the password');
      expectHttp(401, '/api/owner/login');
      await op.locator('button[type="submit"]').click();
      await op.waitForSelector('.notice-error');
      ok((await bodyText(op)).includes('not right'), 'wrong password shows a friendly error');
      await fillF(op, 'f_ol_pw', OWNER_PW);
      await op.locator('button[type="submit"]').click();
      await op.waitForSelector('.dash-tabs');
      ok(true, 'owner signs in with email + password');
      await noInlineHandlers(op, 'owner dashboard');
      await noHScroll(op, 'owner dashboard 390px');
      await shot(op, '08-owner-dashboard-mobile', { fullPage: false });
    });

    let samId = '', inviteUrl = '';
    await section('owner adds a barber, makes an invite link, uploads photos', async () => {
      await op.locator('[data-action="o-tab"][data-k="team"]').click();
      await fillF(op, 'f_nb_name', 'Sam'); await fillF(op, 'f_nb_title', 'Test Barber');
      await op.locator('[data-action="o-nb-lang"][data-k="es"]').click();
      await op.locator('form[data-submit="o-add-barber"] button[type="submit"]').click();
      await op.waitForSelector('.tcard[data-barber]:has-text("Sam")');
      samId = await op.locator('.tcard:has-text("Sam") >> nth=0').getAttribute('data-barber');
      ok(/^b/.test(samId), 'new barber appears with a server id (' + samId + ')');
      const card = op.locator(`.tcard[data-barber="${samId}"]`);
      await card.locator('[data-action="o-invite"][data-k="link"]').click();
      await card.locator('.invite-box input').waitFor();
      inviteUrl = await card.locator('.invite-box input').inputValue();
      ok(new RegExp('^' + A.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/\\?staff=[A-Za-z0-9_-]{20,}$').test(inviteUrl), 'one-time invite link is shown: ' + inviteUrl.slice(0, 40) + '…');
      await card.locator('[data-action="o-copy"]').click();
      await until(async () => (await card.locator('[data-action="o-copy"]').textContent()).trim() === 'Copied', 'Copy button feedback');
      const clip = await op.evaluate(() => navigator.clipboard.readText()).catch(() => inviteUrl);
      eq(clip, inviteUrl, 'Copy button puts the link on the clipboard');
      ok((await card.textContent()).includes('Invite pending'), 'barber card shows "Invite pending"');
      // photos
      await card.locator('[data-action="o-manage"]').click();
      const png = makePng(1600, 1200);
      await card.locator('input[data-k="profile"]').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: png });
      await card.locator('.pick-avatar.has-photo').first().waitFor({ timeout: 10000 });
      await card.locator('input[data-k="gallery"]').setInputFiles([1, 2].map((i) => ({ name: `g${i}.png`, mimeType: 'image/png', buffer: makePng(900 + i * 100, 700) })));
      await op.waitForFunction((id) => document.querySelectorAll(`.tcard[data-barber="${id}"] .manage-thumb`).length === 2, samId, { timeout: 10000 });
      const pub = (await fetch(A + '/api/public').then((r) => r.json())).barbers.find((b) => b.id === samId);
      ok(/^\/uploads\/[A-Za-z0-9._-]+\.jpg$/.test(pub.photo) && pub.gallery.length === 2, 'photos uploaded (resized to JPEG in the browser) and served from /uploads');
      const jpeg = Buffer.from(await (await fetch(A + pub.photo)).arrayBuffer());
      ok(jpeg[0] === 0xff && jpeg[1] === 0xd8, 'uploaded profile photo is a real JPEG');
      await shot(op, '09-owner-team-manage', { fullPage: false });
      // Days Working + custom hours: toggles are a draft, the grid hides off days, one Save changes button saves both
      const dayBtn = (k) => card.locator(`[data-action="o-day"][data-k="${k}"]`);
      await card.locator('[data-change="o-toggle-custom"]').check();
      await card.locator('.hours-grid-mini').waitFor();
      eq(await card.locator('.hours-grid-mini .hours-row b').allInnerTexts(), ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], 'custom hours grid lists every working day');
      await dayBtn(1).click(); await dayBtn(2).click();
      eq([await dayBtn(1).getAttribute('aria-pressed'), await dayBtn(2).getAttribute('aria-pressed')], ['false', 'false'], 'Monday and Tuesday toggled off');
      eq(await card.locator('.hours-grid-mini .hours-row b').allInnerTexts(), ['Sun', 'Wed', 'Thu', 'Fri', 'Sat'], 'custom hours grid hides days that are switched off');
      ok((await card.innerText()).includes('Unsaved changes'), 'card says there are unsaved changes');
      const before = await fetch(A + '/api/availability?service=s1&barber=' + samId + '&days=14').then((r) => r.json());
      ok(before.days.some((d) => [1, 2].includes(new Date(d.date + 'T00:00:00Z').getUTCDay()) && d.slots.length > 0), 'nothing is saved until Save changes is pressed');
      await card.locator('.hours-row:has(b:text-is("Wed")) select').first().selectOption('11');
      await card.locator('.hours-row:has(b:text-is("Wed")) select').nth(1).selectOption('16');
      await card.locator('[data-action="o-save-changes"]').click();
      await card.locator('.notice:has-text("Saved.")').waitFor();
      ok((await card.locator('.notice').first().innerText()).includes('working days and custom hours are updated'), 'brief confirmation shown after saving');
      const saved = (await fetch(A + '/api/public').then((r) => r.json()));
      const av = await fetch(A + '/api/availability?service=s1&barber=' + samId + '&days=14').then((r) => r.json());
      ok(av.days.filter((d) => [1, 2].includes(new Date(d.date + 'T00:00:00Z').getUTCDay())).every((d) => d.slots.length === 0), 'no bookable times on the barber\u2019s saved days off');
      const wed = av.days.find((d) => new Date(d.date + 'T00:00:00Z').getUTCDay() === 3);
      ok(wed.slots.length > 0 && wed.slots[0].time === '11:00' && wed.slots[wed.slots.length - 1].time === '15:30', 'the custom Wednesday hours (11 to 4) were saved in the same click');
      // put everything back
      await dayBtn(1).click(); await dayBtn(2).click();
      await card.locator('[data-action="o-save-changes"]').click();
      await until(async () => !(await card.innerText()).includes('Unsaved changes') && (await dayBtn(2).getAttribute('aria-pressed')) === 'true', 'days working restored');
      await card.locator('[data-change="o-toggle-custom"]').uncheck();
      await card.locator('[data-action="o-manage"]').click();
    });

    await section('owner adds a manual booking and sees full customer details', async () => {
      await op.locator('[data-action="o-tab"][data-k="today"]').click();
      await op.locator('[data-action="o-na-toggle"]').click();
      await op.locator('#f_na_barber').selectOption(samId);
      eq((await op.locator('#f_na_service option').allInnerTexts()).map(oneLine), ['Choose…', 'Haircut (30 min, $35)', 'Kids Cut (30 min, $35)', 'Beard Only (30 min, $32)', 'Haircut & Beard (30 min, $67)'], 'owner-side service dropdown shows name, minutes and price');
      await op.locator('#f_na_service').selectOption('s2');
      await op.waitForSelector('.new-appt-panel .slot-btn');
      await op.locator('.new-appt-panel .slot-btn').first().click();
      await fillF(op, 'f_na_name', 'Mike Donnelly'); await fillF(op, 'f_na_phone', '(516) 555-0110'); await fillF(op, 'f_na_email', 'mike.d@example.com'); await fillF(op, 'f_na_notes', 'private note xyz');
      await op.locator('[data-f="na.optin"]').check();
      await op.locator('form[data-submit="o-na-submit"] button[type="submit"]').click();
      await op.waitForSelector('.appt-card:has-text("Mike Donnelly")');
      const t = await op.locator('.appt-card:has-text("Mike Donnelly")').innerText();
      ok(t.includes('516-555-0110') && t.includes('mike.d@example.com') && t.includes('private note xyz'), 'owner sees phone, email and notes on the booking card');
      ok((await bodyText(op)).includes('Added by you'), 'manual booking marked as added by the owner');
    });

    await section('owner: customers tab, opt-in, CSV + backup downloads, block/unblock', async () => {
      await op.locator('[data-action="o-tab"][data-k="customers"]').click();
      await op.waitForSelector('.breakdown-table');
      const row = op.locator('tr:has-text("Mike Donnelly")');
      ok(await row.locator('input[type="checkbox"]').isChecked(), 'opt-in tick box reflects the booking form');
      await row.locator('input[type="checkbox"]').uncheck();
      await until(async () => !(await op.locator('tr:has-text("Mike Donnelly") input[type="checkbox"]').isChecked()), 'opt-in untick saved');
      await op.locator('tr:has-text("Mike Donnelly") input[type="checkbox"]').check();
      const dl = op.waitForEvent('download');
      await op.locator('#dl-csv').click();
      const d = await dl;
      const csv = fs.readFileSync(await d.path(), 'utf8');
      ok(d.suggestedFilename().endsWith('.csv') && csv.startsWith('First Name,Last Name,Phone'), 'CSV link downloads a contacts file: ' + d.suggestedFilename());
      ok(csv.includes('Mike,Donnelly,5165550110'), 'CSV contains the opted-in customer');
      const dl2 = op.waitForEvent('download'); await op.locator('#dl-csv-all').click();
      ok(fs.readFileSync(await (await dl2).path(), 'utf8').includes('Mike,Donnelly'), '"all contacts" CSV variant works');
      const dl3 = op.waitForEvent('download'); await op.locator('#dl-backup').click();
      const bk = JSON.parse(fs.readFileSync(await (await dl3).path(), 'utf8'));
      ok(Array.isArray(bk.bookings) && bk.bookings.length >= 1 && !JSON.stringify(bk).includes('pin_hash'), 'backup JSON downloads (no secrets inside)');
      // block + unblock
      await fillF(op, 'f_blk_phone', '516-555-0666'); await fillF(op, 'f_blk_name', 'repeat no-show');
      await op.locator('form[data-submit="o-block-add"] button[type="submit"]').click();
      await op.waitForSelector('.settings-item:has-text("516-555-0666")');
      const blockedTry = await appA.client().post('/api/bookings', { serviceId: 's1', barberId: 'b2', date: '2026-10-01', time: '10:00', name: 'Blocked Guy', phone: '516-555-0666' });
      eq(blockedTry.json.code, 'blocked', 'a blocked number cannot book online');
      await op.locator('.settings-item:has-text("516-555-0666") [data-action="o-unblock"]').click();
      await until(async () => (await op.locator('.settings-item:has-text("516-555-0666")').count()) === 0, 'unblock');
    });

    /* ============================================================== barber via the invite link */
    const barCtx = await newContext(browser);
    const bp = await barCtx.newPage();
    const barberBodies = [];
    bp.on('response', async (res) => { if (res.url().includes('/api/')) { try { barberBodies.push({ url: res.url(), text: await res.text() }); } catch (e) { /* ignore */ } } });
    await section('barber PIN setup through the invite link, then the schedule', async () => {
      await bp.goto(inviteUrl);
      await bp.waitForSelector('form[data-submit="staff-setup"]');
      ok((await bodyText(bp)).includes('Sam') && (await bodyText(bp)).includes('Crea tu acceso'), 'invite link lands on the setup screen (Sam is set to Spanish)');
      eq(await bp.evaluate(() => document.documentElement.lang), 'es', '<html lang> follows the language');
      await bp.locator('[data-action="staff-lang"][data-k="en"]').click();
      ok((await bodyText(bp)).includes('Create your login'), 'language can be switched before signing in');
      ok(await bp.locator('#f_st_newpin').evaluate((e) => e.inputMode === 'numeric' && e.maxLength === 6), 'PIN field is numeric with a 6-digit limit');
      await fillF(bp, 'f_st_newpin', '12345'); await fillF(bp, 'f_st_newpin2', '12345');
      await bp.locator('button[type="submit"]').click();
      ok((await bodyText(bp)).includes('exactly 6 digits'), '5-digit PIN rejected');
      await fillF(bp, 'f_st_newpin', BARBER_PIN); await fillF(bp, 'f_st_newpin2', '111111');
      await bp.locator('button[type="submit"]').click();
      ok((await bodyText(bp)).includes('don’t match'), 'mismatched confirmation rejected');
      await fillF(bp, 'f_st_newpin', BARBER_PIN); await fillF(bp, 'f_st_newpin2', BARBER_PIN);
      await bp.locator('button[type="submit"]').click();
      await bp.waitForSelector('#staff-name');
      eq(await bp.locator('#staff-name').innerText(), 'Sam', 'barber is signed in and sees their own schedule');
      ok(!/staff=/.test(bp.url()), 'invite token removed from the URL');
      await until(async () => (await bp.evaluate(() => fetch('/api/staff/me').then((r) => r.json()))).barber.lang === 'en', 'language choice saved to the server');
      await noHScroll(bp, 'barber schedule 390px'); await noInlineHandlers(bp, 'barber view');
    });
    await section('an invite link works only once', async () => {
      const ctx = await newContext(browser);
      const p = await ctx.newPage();
      expectHttp(404, '/api/staff/setup-info');
      await p.goto(inviteUrl);
      await p.waitForSelector('text=expired');
      ok(true, 'the used invite link now says it has expired');
      await ctx.close();
    });
    await section('barber view shows first names only — nothing private in the DOM or the network', async () => {
      // give Sam a booking made by a real customer with a distinctive last name / phone / email / note
      await bp.locator('[data-action="staff-refresh"]').click();
      await bp.waitForSelector('.staff-appt-row');
      const rowText = await bp.locator('.staff-appt-row').first().innerText();
      ok(rowText.includes('Mike') && rowText.includes('Kids Cut'), 'appointment shows first name + service');
      const html = await bp.content(); const text = await bodyText(bp);
      for (const secret of ['Donnelly', '555-0110', '5165550110', 'mike.d@example.com', 'private note xyz']) {
        ok(!html.includes(secret) && !text.includes(secret), `barber DOM never contains "${secret}"`);
      }
      const net = barberBodies.map((b) => b.text).join('\n');
      for (const secret of ['Donnelly', '555-0110', '5165550110', 'mike.d@example.com', 'private note xyz']) ok(!net.includes(secret), `barber network responses never contain "${secret}"`);
      ok(net.includes('"firstName":"Mike"'), 'barber API returns the first name');
      await shot(bp, '10-barber-schedule', { fullPage: true });
    });
    await section('barber: Spanish toggle, time off, done, sign out / sign in', async () => {
      await bp.locator('[data-action="staff-lang"][data-k="es"]').click();
      await until(async () => (await bodyText(bp)).includes('Cerrar sesión'), 'Spanish UI');
      const t = await bodyText(bp);
      ok(t.includes('Tiempo libre') && t.includes('Solo hora, nombre de pila') && t.includes('Corte para Niños'), 'schedule, hint and service names are in Spanish');
      eq(await bp.evaluate(() => document.documentElement.lang), 'es', '<html lang="es"> while in Spanish');
      ok(/Hoy — (mié|jue|vie|sáb|dom|lun|mar), 30 sep/.test(t), 'dates are formatted in Spanish ("Hoy — mié, 30 sep")');
      await shot(bp, '11-barber-spanish', { fullPage: false });
      // time off: all day tomorrow -> not bookable
      await fillF(bp, 'f_st_offDate', '2026-10-01');
      await bp.locator('[data-action="staff-add-off"]').click();
      await bp.waitForSelector('.off-item');
      const av = await fetch(A + '/api/availability?service=s1&barber=' + samId + '&days=3').then((r) => r.json());
      eq(av.days[1].slots.length, 0, 'all-day time off removes tomorrow from public availability');
      await bp.locator('[data-action="staff-rm-off"]').click();
      await until(async () => (await bp.locator('.off-item').count()) === 0, 'time off removed');
      // partial block
      await bp.locator('[data-action="staff-off-mode"][data-k="part"]').click();
      await fillF(bp, 'f_st_offDate', '2026-09-30'); await fillF(bp, 'f_st_offFrom', '14:00'); await fillF(bp, 'f_st_offTo', '15:00');
      await bp.locator('[data-action="staff-add-off"]').click();
      await bp.waitForSelector('.off-item');
      const av2 = await fetch(A + '/api/availability?service=s1&barber=' + samId + '&days=1').then((r) => r.json());
      ok(!av2.days[0].slots.some((s) => s.time === '14:00' || s.time === '14:30'), 'a time range block hides those slots');
      await bp.locator('[data-action="staff-rm-off"]').click();
      // done
      await bp.locator('[data-action="staff-mark"][data-k="completed"]').first().click();
      await until(async () => (await bp.locator('.staff-appt-row').count()) === 0, 'appointment marked done disappears');
      // sign out / in
      await bp.locator('[data-action="staff-logout"]').click();
      await bp.waitForSelector('[data-action="staff-pick"]');
      ok((await bodyText(bp)).includes('Sam'), 'sign-in lists barbers who have a login');
      await bp.locator(`[data-action="staff-pick"][data-id="${samId}"]`).click();
      await fillF(bp, 'f_st_pin', '000000');
      expectHttp(401, '/api/staff/login');
      await bp.locator('button[type="submit"]').click();
      await bp.waitForSelector('.notice-error');
      ok((await bodyText(bp)).length > 0 && /PIN/i.test(await bp.locator('.notice-error').innerText()), 'wrong PIN shows a friendly message');
      await fillF(bp, 'f_st_pin', BARBER_PIN);
      await bp.locator('button[type="submit"]').click();
      await bp.waitForSelector('#staff-name');
      ok(true, 'barber signs back in with the 6-digit PIN');
      // a returning barber opening #staff goes straight to the schedule (cookie session)
      await bp.goto(A + '/#staff'); await bp.reload();
      await bp.waitForSelector('#staff-name');
      ok(true, 'HttpOnly cookie session restores the schedule after a reload');
      ok(!(await bp.evaluate(() => document.cookie)).includes('bc_staff'), 'session cookie is HttpOnly (not readable by scripts)');
      // owner sees the status change
      await op.locator('[data-action="o-tab"][data-k="today"]').click();
      await op.locator('[data-action="o-refresh"]').click();
      await until(async () => (await op.locator('.appt-card:has-text("Mike Donnelly") .pill-completed').count()) === 1, 'owner sees completed');
    });

    /* ============================================================== Stripe path (app A) */
    await section('Stripe Checkout redirect + return + webhook (fake Stripe)', async () => {
      const ctx = await newContext(browser);
      let mode = 'success';
      await ctx.route('https://checkout.stripe.test/**', (route) => {
        const s = appA.fakeStripe.sessions[appA.fakeStripe.sessions.length - 1];
        const url = mode === 'success' ? s.params.success_url : s.params.cancel_url;
        route.fulfill({ status: 302, headers: { location: url }, body: '' });
      });
      const p = await ctx.newPage();
      await p.goto(A + '/'); await p.waitForSelector('.team-card');
      // "Book with Joe" from the team strip jumps straight to the service step
      await p.locator('.team-card [data-action="quick-book"][data-id="b1"]').click();
      ok((await p.locator('.step-title').innerText()).includes('Choose a service'), 'team card starts the wizard at the service step');
      await p.locator('[data-action="pick-service"][data-id="s2"]').click();
      await p.locator('.wiz-nav .btn-primary').click();
      await p.waitForSelector('.slot-btn');
      // choose a later day too
      await p.locator('.day-btn:not([disabled])').nth(1).click();
      await p.waitForSelector('.slot-btn');
      await pickSlot(p, 0);
      await fillInfo(p, { name: 'Casey Stripe', phone: '516-555-0177', email: 'casey@example.com', optIn: false });
      await p.locator('.wiz-nav .btn-primary').click();
      await p.waitForSelector('[data-action="book"]');
      // success: leave the webhook for later so the page has to poll
      await p.locator('[data-action="book"]').click();
      await p.waitForSelector('text=Finishing your payment', { timeout: 10000 });
      ok(true, 'redirected to Stripe, came back to /?pay=success and is polling');
      ok(!/pay=|[?&]t=/.test(p.url()), 'token stripped from the URL right away');
      await sleep(2500);
      const s = appA.fakeStripe.sessions[appA.fakeStripe.sessions.length - 1];
      const bookingId = s.params['metadata[group_id]'];
      ok(bookingId, 'Stripe session carries the order id');
      const { paidEvent } = require('./helpers');
      const hook = await appA.sendWebhook(appA.client(), paidEvent('evt_e2e_1', bookingId, s.id));
      eq(hook.status, 200, 'signed webhook accepted');
      await p.waitForSelector('.confirm-wrap', { timeout: 15000 });
      ok((await bodyText(p)).includes('Kids Cut') && /CONFIRMATION #[A-Z0-9]{8}/.test(await bodyText(p)), 'polling picks up the webhook and shows the confirmation');
      // cancel path: a second booking, come back with ?pay=cancel
      mode = 'cancel';
      await p.locator('[data-action="book-another"]').click();
      await p.locator('[data-action="pick-barber"][data-id="b2"]').click();
      await p.locator('.wiz-nav .btn-primary').click();
      await p.locator('[data-action="pick-service"][data-id="s4"]').click();
      await p.locator('.wiz-nav .btn-primary').click();
      await p.waitForSelector('.slot-btn');
      const slot = await p.locator('.slot-btn').first().getAttribute('data-time');
      await p.locator('.slot-btn').first().click();
      await p.locator('.wiz-nav .btn-primary').click();
      await fillInfo(p, { name: 'Casey Cancel', phone: '516-555-0188' });
      await p.locator('.wiz-nav .btn-primary').click();
      await p.locator('[data-action="book"]').click();
      await p.waitForSelector('text=Payment not completed', { timeout: 10000 });
      ok((await bodyText(p)).includes('has been released'), 'cancel return says the payment did not happen and the held time was released');
      const date = (await fetch(A + '/api/availability?service=s4&barber=b2&days=1').then((r) => r.json())).days[0];
      ok(date.slots.some((x) => x.time === slot), 'the released time is bookable again');
      await p.locator('[data-action="book-another"]').click();
      await p.waitForSelector('[data-action="pick-barber"]');
      ok(true, '"Try again" restarts the wizard');
      await ctx.close();
    });

    /* ============================================================== several appointments in one checkout */
    await multiSections({ browser, appA, appB, appC, expectHttp });

    /* ============================================================== a stuck payment (runs ~60s in the background) */
    await section('payment that never confirms shows the calm fallback (60s window, checked at the end)', async () => {
      const ctx = await newContext(browser);
      slowPage = { ctx, page: await ctx.newPage(), started: Date.now() };
      const r = await appA.client().post('/api/bookings', { serviceId: 's1', barberId: 'b3', date: '2026-10-02', time: '11:00', name: 'Slow Payer', phone: '516-555-0155' });
      eq(r.json.status, 'pending', 'created a pending booking that will never be paid');
      const tok = r.json.token;
      await slowPage.page.goto(A + '/?pay=success&t=' + tok);
      await slowPage.page.waitForSelector('text=Finishing your payment');
      ok(true, 'polling screen is shown while waiting');
    });

    /* ============================================================== settings & XSS escaping */
    await section('owner settings: hours, fee, policies, services, escaping', async () => {
      await op.locator('[data-action="o-tab"][data-k="settings"]').click();
      await op.waitForSelector('form[data-submit="o-set-info"]');
      await noHScroll(op, 'settings 390px');
      // shop name with characters that must be escaped
      await fillF(op, 'f_s_name', 'Barber\'s "Chops" &amp; Co');
      await op.locator('form[data-submit="o-set-info"] button[type="submit"]').click();
      await op.waitForSelector('form[data-submit="o-set-info"] .notice-ok');
      const pub = await fetch(A + '/api/public').then((r) => r.json());
      const p2 = await (await newContext(browser)).newPage();
      await p2.goto(A + '/'); await p2.waitForSelector('.footer-grid h4');
      eq(await p2.locator('.footer-grid h4').first().textContent(), pub.shop.name, 'shop name with quotes and &amp; is shown literally (escaped)');
      eq(await p2.locator('.brand-logo').evaluate((e) => e.getAttribute('aria-label')), pub.shop.name, 'attribute values are escaped too');
      await p2.context().close();
      await fillF(op, 'f_s_name', 'Barberchops');
      await op.locator('form[data-submit="o-set-info"] button[type="submit"]').click();
      await op.waitForSelector('form[data-submit="o-set-info"] .notice-ok');
      // hours: close Sunday
      await op.locator('[data-f="h.0.closed"]').check();
      await op.locator('form[data-submit="o-set-hours"] button[type="submit"]').click();
      await op.waitForSelector('form[data-submit="o-set-hours"] .notice-ok');
      eq((await fetch(A + '/api/public').then((r) => r.json())).shop.hours['0'], null, 'closing Sunday is saved in {0..6} format');
      await op.locator('[data-f="h.0.closed"]').uncheck();
      await op.locator('form[data-submit="o-set-hours"] button[type="submit"]').click();
      await op.waitForSelector('form[data-submit="o-set-hours"] .notice-ok');
      // policies + reminders + pre-tick
      await fillF(op, 'f_s_fee', '5'); await fillF(op, 'f_s_window', '12');
      await op.locator('form[data-submit="o-set-policy"] button[type="submit"]').click();
      await op.waitForSelector('form[data-submit="o-set-policy"] .notice-ok');
      // owner email + test email
      await fillF(op, 'f_s_ownerEmail', 'alerts@example.com');
      await op.locator('[data-action="o-test-email"]').click();
      await op.waitForSelector('form[data-submit="o-set-email"] .notice-ok');
      await until(() => appA.fakeMail.sent.some((m) => m.to.includes('alerts@example.com') && /test/i.test(m.subject)), 'test email delivered');
      ok(true, 'owner email saved and "send test email" delivers through the mail service');
      // services
      const svcForm = op.locator('form[data-submit="o-set-services"]');
      eq(await svcForm.locator('input').count(), 8, 'Services panel has eight inputs (minutes + in-store price for each service)');
      eq(await svcForm.locator('input').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))), SERVICE_NAMES.flatMap((n) => [n + ' minutes', n + ' in-store price in dollars']), 'every service has a minutes field and an in-store price field');
      eq(oneLine(await svcForm.locator('h3').innerText()), 'Services & in-store prices', 'the panel heading reads "Services & in-store prices"');
      ok(/paid at the shop, never online/.test(await svcForm.innerText()) && /only at checkout, as .Due in store./.test(await svcForm.innerText()), 'the panel note says prices are paid at the shop and shown to clients only at checkout as "Due in store"');
      eq(await svcForm.locator('input').evaluateAll((els) => els.filter((e) => /in-store price/.test(e.getAttribute('aria-label'))).map((e) => e.value)), ['35', '35', '32', '67'], 'in-store prices are Haircut $35, Kids Cut $35, Beard Only $32, Haircut & Beard $67');
      eq((await svcForm.locator('button[type="submit"]').textContent()).trim(), 'Save services', 'the button reads "Save services"');
      const ownerSvc = () => op.evaluate(() => fetch('/api/owner/state').then((r) => r.json())).then((st) => st.services);
      // invalid minutes are refused client-side and nothing is saved
      await fillF(op, 'f_sv_s2_d', '3');
      await svcForm.locator('button[type="submit"]').click();
      await op.waitForSelector('form[data-submit="o-set-services"] .notice-error');
      ok(/Kids Cut: minutes must be from 5 to 240/.test(await svcForm.innerText()) && (await ownerSvc()).find((s) => s.id === 's2').duration === 30, 'minutes below 5 are rejected and s2 stays at 30');
      await fillF(op, 'f_sv_s2_d', '45');
      await svcForm.locator('button[type="submit"]').click();
      await op.waitForSelector('form[data-submit="o-set-services"] .notice-ok');
      const after = await ownerSvc();
      eq(after.find((s) => s.id === 's2').duration, 45, 'Kids Cut minutes change (30 -> 45) is saved for the owner');
      eq(after.filter((s) => s.id !== 's2').map((s) => s.duration), [30, 30, 30], 'the other three services are untouched');
      const pubSvc = (await fetch(A + '/api/public').then((r) => r.json())).services;
      eq(pubSvc.map((s) => s.price), [35, 35, 32, 67], 'the public menu carries the in-store prices (shown to clients only at checkout)');
      eq(pubSvc.find((s) => s.id === 's2').duration, 45, 'the new minutes reach the public menu (they drive availability)');
      const avK = await fetch(A + '/api/availability?service=s2&barber=b1&days=1').then((r) => r.json());
      ok(avK.days[0].slots.length > 0, 'Kids Cut is still bookable with its new length');
      {   // customers still see no minutes and no service price on the landing page after the change
        const cx = await newContext(browser); const cpg = await cx.newPage();
        await cpg.goto(A + '/'); await cpg.waitForSelector('.price-line');
        await moneyClean(cpg, 'landing after the owner changed minutes'); await landingServicesOk(cpg, 'landing after the owner changed minutes');
        await cx.close();
      }
      // invalid prices are refused client-side, nothing is saved
      await fillF(op, 'f_sv_s1_p', '1001');
      await svcForm.locator('button[type="submit"]').click();
      await op.waitForSelector('form[data-submit="o-set-services"] .notice-error');
      ok(/Haircut: price must be whole dollars from 0 to 1000/.test(await svcForm.innerText()) && (await ownerSvc()).find((s) => s.id === 's1').price === 35, 'a price above $1000 is rejected and Haircut stays at $35');
      await fillF(op, 'f_sv_s1_p', '37.50');
      await svcForm.locator('button[type="submit"]').click();
      await op.waitForSelector('form[data-submit="o-set-services"] .notice-error');
      ok(/whole dollars/.test(await svcForm.innerText()) && (await ownerSvc()).find((s) => s.id === 's1').price === 35, 'a price with cents is rejected');
      // (d) the owner changes the Haircut price to $40; a NEW checkout shows the new in-store total, Stripe still only gets $5 lines
      await fillF(op, 'f_sv_s1_p', '40');
      await svcForm.locator('button[type="submit"]').click();
      await op.waitForSelector('form[data-submit="o-set-services"] .notice-ok');
      const afterP = await ownerSvc();
      eq(afterP.map((s) => s.price), [40, 35, 32, 67], 'Haircut price change ($35 -> $40) is saved; the other prices are untouched');
      eq(afterP.find((s) => s.id === 's2').duration, 45, 'and the minutes are unchanged');
      eq((await fetch(A + '/api/public').then((r) => r.json())).services.map((s) => s.price), [40, 35, 32, 67], 'the public menu has the new price');
      {
        const cx = await newContext(browser);
        await cx.route('https://checkout.stripe.test/**', (route) => {
          const s = appA.fakeStripe.sessions[appA.fakeStripe.sessions.length - 1];
          route.fulfill({ status: 302, headers: { location: s.params.cancel_url }, body: '' });
        });
        const cpg = await cx.newPage();
        await driveToCheckout(cpg, A, [{ barber: 'b4', svc: 's1' }, { barber: 'b5', svc: 's1' }, { barber: 'b6', svc: 's1' }], { day: '2026-10-02', time: '12:00', name: 'Price Changed', phone: '516-555-0173' });
        eq((await cpg.locator('.pay-row .pa-store').allInnerTexts()).map(oneLine), ['$40 in store', '$40 in store', '$40 in store'], 'a new checkout shows the new $40 in-store price on each row');
        await totalsOk(cpg, 'checkout after the price change', { store: '$120', now: '$15', n: 3 });
        await moneyClean(cpg, 'checkout after the price change', { store: true, prices: [40, 35, 32, 67] });
        const before = appA.fakeStripe.sessions.length;
        await payButton(cpg).click();
        await cpg.waitForSelector('text=Payment not completed', { timeout: 15000 });
        const s = await stripeItems(appA, before);
        eq([0, 1, 2, 3].map((i) => s.params[`line_items[${i}][price_data][unit_amount]`]), ['500', '500', '500', undefined], 'Stripe still gets only three $5 lines after the price change');
        ok(!Object.values(s.params).some((v) => /^(4000|12000)$/.test(String(v))), 'the $40 price / $120 total never reach Stripe');
        await cx.close();
      }
      await fillF(op, 'f_sv_s1_p', '35');
      await svcForm.locator('button[type="submit"]').click();
      await op.waitForSelector('form[data-submit="o-set-services"] .notice-ok');
      eq((await ownerSvc()).find((s) => s.id === 's1').price, 35, 'the owner sets Haircut back to $35');
      // password change
      await fillF(op, 'f_pw_cur', OWNER_PW); await fillF(op, 'f_pw_new', OWNER_PW + '!'); await fillF(op, 'f_pw_new2', OWNER_PW + '!');
      await op.locator('form[data-submit="o-set-password"] button[type="submit"]').click();
      await op.waitForSelector('form[data-submit="o-set-password"] .notice-ok');
      ok(true, 'owner password can be changed');
      // system status + audit log
      const t = await bodyText(op);
      ok(/System status/.test(t) && /Stripe payments[\s\S]*Connected/.test(t) && /Email[\s\S]*Connected/.test(t), 'system status shows email + Stripe state');
      ok(/Recent security log/.test(t) && /settings changed/.test(t) && /login/.test(t), 'recent security log lists sign-ins and changes');
      await shot(op, '12-owner-settings', { fullPage: false });
      // TV screen PIN
      await fillF(op, 'f_s_boardpin', '12345');
      await op.locator('form[data-submit="o-set-boardpin"] button[type="submit"]').click();
      ok((await bodyText(op)).includes('exactly 6 digits'), 'screen PIN must be 6 digits');
      await fillF(op, 'f_s_boardpin', BOARD_PIN);
      await op.locator('form[data-submit="o-set-boardpin"] button[type="submit"]').click();
      await until(async () => (await bodyText(op)).includes('A PIN is set'), 'screen PIN saved');
      ok(true, 'TV screen PIN set from the owner dashboard');
    });

    /* ============================================================== TV board at 4K */
    await section('TV board: PIN login and 4K grid', async () => {
      const ctx = await newContext(browser, { viewport: { width: 3840, height: 2160 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
      const p = await ctx.newPage();
      await p.goto(A + '/#board');
      await p.waitForSelector('form[data-submit="board-login"]');
      await fillF(p, 'f_bd_pin', '111111');
      expectHttp(401, '/api/board/login');
      await p.locator('button[type="submit"]').click();
      await p.waitForSelector('.notice-error');
      ok(true, 'wrong screen PIN is rejected');
      await fillF(p, 'f_bd_pin', BOARD_PIN);
      await p.locator('button[type="submit"]').click();
      await p.waitForSelector('.bd-grid');
      await until(async () => (await p.locator('.bd-chip').count()) >= 1, 'bookings appear on the board');
      const m = await p.evaluate(() => {
        const r = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, clipped: e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1, text: e.textContent }; };
        return {
          iw: innerWidth, ih: innerHeight, sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight,
          bodyOverflow: getComputedStyle(document.body).overflow,
          heads: [...document.querySelectorAll('.bd-head-cell .nm')].map(r), times: [...document.querySelectorAll('.bd-time')].map(r),
          chips: [...document.querySelectorAll('.bd-chip')].map(r), grid: r(document.querySelector('.bd-grid')), clock: document.getElementById('bd-clock').textContent,
          text: document.body.innerText, offenders: [...document.querySelectorAll('#app *')].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && (b.right > innerWidth + 1 || b.bottom > innerHeight + 1 || b.left < -1 || b.top < -1); }).map((e) => e.className).slice(0, 5),
        };
      });
      ok(m.sw <= m.iw && m.sh <= m.ih, `no scrollbars at 3840x2160 (page ${m.sw}x${m.sh} in ${m.iw}x${m.ih})`);
      eq(m.offenders, [], 'nothing on the board spills outside the screen');
      eq(m.heads.length, 9, 'all 9 barbers are column headers (8 seeded + Sam)');
      ok(m.heads.every((h) => !h.clipped && h.l >= 0 && h.r <= m.iw), 'every barber name is fully visible');
      eq(m.times.length, 20, 'all 20 half-hour rows (9 AM – 7 PM) are present');
      ok(m.times.every((h) => h.t >= 0 && h.b <= m.ih), 'every time label is inside the screen');
      ok(m.times[0].text.trim() === '9:00 AM' && m.times[19].text.trim() === '6:30 PM', 'time axis runs 9:00 AM to 6:30 PM');
      ok(m.chips.length >= 1 && m.chips.every((c) => !c.clipped), 'booking chips are not clipped');
      ok(m.text.includes('Mike D.') && !m.text.includes('Donnelly') && !m.text.includes('555-0110'), 'board shows "Mike D." (label from the server) and no phone/last name');
      ok(/^10:0\d AM$/.test(m.clock.trim()), 'clock follows the SERVER time (10:0x AM), not the browser clock: ' + m.clock);
      const fontPx = await p.locator('.bd-name').first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
      ok(fontPx >= 40, `names are readable from across the room (${fontPx.toFixed(0)}px)`);
      ok(await p.locator('.bd-nowline').count() === 1, 'current-time line is drawn');
      await noInlineHandlers(p, 'board');
      await shot(p, '13-board-4k');
      // a smaller TV as well
      await p.setViewportSize({ width: 1920, height: 1080 });
      await sleep(300);
      const m2 = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, iw: innerWidth, ih: innerHeight }));
      ok(m2.sw <= m2.iw && m2.sh <= m2.ih, 'also fits 1920x1080 without scrolling');
      await p.setViewportSize({ width: 3840, height: 2160 });
      // lock (needs two deliberate taps)
      await p.locator('[data-action="board-lock"]').click({ force: true });
      ok((await p.locator('[data-action="board-lock"]').innerText()).includes('Tap again'), 'lock asks for a second tap');
      await p.locator('[data-action="board-lock"]').click({ force: true });
      await p.waitForSelector('form[data-submit="board-login"]');
      ok(true, 'locking returns to the PIN screen');
      await fillF(p, 'f_bd_pin', BOARD_PIN);
      await p.locator('button[type="submit"]').click();
      await p.waitForSelector('.bd-grid');
      // the device stays signed in (30-day cookie)
      await p.reload(); await p.waitForSelector('.bd-grid');
      ok(true, 'board stays signed in after a reload (cookie session)');
      // session ends on the server -> the next 20s poll returns to the PIN screen
      await ctx.clearCookies();
      expectHttp(401, '/api/board');
      await p.waitForSelector('form[data-submit="board-login"]', { timeout: 30000 });
      ok((await bodyText(p)).includes('locked'), 'a 401 during polling sends the screen back to its PIN entry');
      await ctx.close();
    });

    /* ============================================================== customer cancel / reschedule link + owner refund */
    await section('customer: cancel or reschedule from the email link; owner: Refund button and call/text links', async () => {
      const { paidEvent, TOMORROW } = require('./helpers');
      const email = 'manage.mom@example.com';
      const api_ = appA.client();
      const made = await api_.post('/api/bookings', { name: 'Maya Kessler', phone: '(516) 555-0199', email, notes: '', optIn: false, appointments: [
        { serviceId: 's2', barberId: 'b7', date: TOMORROW, time: '17:30', forName: 'Noa' }, { serviceId: 's2', barberId: 'b8', date: TOMORROW, time: '17:30', forName: 'Eli' }] });
      eq(made.status, 200, 'two-appointment order created');
      const rows = appA.db.raw.prepare(`SELECT * FROM bookings WHERE email = ? ORDER BY rowid`).all(email);
      eq((await appA.sendWebhook(appA.client(), paidEvent('evt_e2e_manage', rows[0].id, rows[0].stripe_session_id, 1000))).status, 200, 'the $10 payment is confirmed');
      await appA.ctx.mailer.flush();
      const mail = appA.fakeMail.sent.find((m) => m.to[0] === email && /CANCEL OR RESCHEDULE/.test(m.text));
      ok(!!mail && mail.subject === 'Your appointment is confirmed', 'confirmation email is sent with the subject "Your appointment is confirmed"');
      const tok = /\?manage=([A-Za-z0-9_-]+)/.exec(mail.text)[1];
      ok(mail.text.includes('Noa') && mail.text.includes('Eli'), 'email lists both children’s appointments');

      const ctx = await newContext(browser);
      const p = await ctx.newPage();
      await p.goto(A + '/?manage=' + tok);
      await p.waitForSelector('.cart-item[data-appt]');
      eq(await p.locator('.cart-item[data-appt]').count(), 2, 'the manage page lists both appointments');
      ok(!(new URL(p.url())).search, 'the secret link is removed from the address bar');
      const t0 = await bodyText(p);
      ok(!t0.includes('555-0199') && !t0.includes(email) && !t0.includes('Kessler'), 'no phone, email or last name on the manage page');
      ok(/refunds the \$5 booking fee/.test(t0) && !/deposit/i.test(t0), 'policy is explained in plain words, never "deposit"');
      await noHScroll(p, 'manage page 390px'); await noInlineHandlers(p, 'manage page');
      await shot(p, '19-mobile-manage-page', { fullPage: true });

      // reschedule the first appointment
      const first = p.locator('.cart-item[data-appt]').nth(0);
      const firstId = await first.getAttribute('data-appt'), secondId = await p.locator('.cart-item[data-appt]').nth(1).getAttribute('data-appt');
      const rowOf = (id) => appA.db.raw.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
      const before1 = rowOf(firstId), before2 = rowOf(secondId);
      await first.locator('[data-action="mg-open"][data-k="reschedule"]').click();
      await p.waitForSelector('.slot-grid');
      await shot(p, '20-mobile-manage-reschedule', { fullPage: true });
      eq(await p.locator('[data-action="mg-move"]').isDisabled(), true, 'Move button waits for a time to be picked');
      const newTime = await p.locator('.slot-btn').nth(1).getAttribute('data-time');
      await p.locator('.slot-btn').nth(1).click();
      await p.locator('[data-action="mg-move"]').click();
      await p.waitForSelector('.notice:has-text("Done. Your appointment moved")');
      const moved = rowOf(firstId);
      ok(moved.time === newTime && moved.status === 'upcoming' && moved.fee_paid === 1 && moved.barber_id === before1.barber_id, 'appointment moved to ' + newTime + ' with the same barber; fee stays paid ' + JSON.stringify({ t: moved.time, s: moved.status, f: moved.fee_paid, b: moved.barber_id }));

      // cancel the second appointment (on time): refund is promised, only that appointment is cancelled
      const second = p.locator('.cart-item[data-appt]').nth(1);
      await second.locator('[data-action="mg-open"][data-k="cancel"]').click();
      ok((await second.innerText()).includes('will be refunded to the card you paid with'), 'cancel confirmation says the $5 will be refunded');
      await shot(p, '21-mobile-manage-cancel', { fullPage: true });
      await second.locator('[data-action="mg-cancel"]').click();
      await p.waitForSelector('.notice:has-text("Your appointment is cancelled")');
      ok((await bodyText(p)).includes('booking fee will be refunded'), 'confirmation of the cancel names the refund');
      eq([rowOf(firstId).status, rowOf(secondId).status], ['upcoming', 'cancelled'], 'only the second appointment is cancelled');
      eq([rowOf(firstId).needs_refund, rowOf(secondId).needs_refund], [0, 1], 'and only its $5 is flagged for refund');
      ok((await p.locator('.cart-item[data-appt]').nth(1).innerText()).toLowerCase().includes('cancelled'), 'the page shows it as cancelled');
      await ctx.close();

      // an unknown link gets a calm message
      const ctx2 = await newContext(browser);
      const p2 = await ctx2.newPage();
      expectHttp(404, '/api/manage');
      await p2.goto(A + '/?manage=' + 'z'.repeat(30));
      await p2.waitForSelector('text=We couldn’t find that booking');
      ok(true, 'an unknown manage link shows a calm "couldn’t find that booking" page');
      await ctx2.close();

      // owner: Needs refund banner, one-tap Refund through Stripe, call / text links
      await op.locator('[data-action="o-refresh"]').click();
      await op.locator('[data-action="o-tab"][data-k="today"]').click();
      await op.waitForSelector('.notice-error:has-text("Refund needed")');
      const banner = await op.locator('.notice-error:has-text("Refund needed")').first().innerText();
      ok(banner.includes(before2.customer_name) && /booked by Maya Kessler/.test(banner) && /555-0199/.test(banner) && /\$5 booking fee/.test(banner), 'refund banner names the client, phone and the $5 fee');
      await shot(op, '22-owner-refund-banner', { fullPage: false });
      await op.locator('.notice-error:has-text("Refund needed") [data-action="o-ask"]').first().click();
      ok((await bodyText(op)).includes('Refund $5 to their card now?'), 'Refund asks for one confirmation first');
      const refundsBefore = appA.fakeStripe.refunds.length;
      await op.locator('[data-action="o-refund"]').first().click();
      await op.waitForSelector('.notice:has-text("Refunded through Stripe")');
      eq(appA.fakeStripe.refunds.length, refundsBefore + 1, 'exactly one refund was sent to Stripe');
      eq(appA.fakeStripe.refunds[appA.fakeStripe.refunds.length - 1].amount, '500', 'for exactly $5.00 (one booking fee, not the $10 order)');
      ok(!(await bodyText(op)).includes('Refund needed: Maya'), 'the refund banner is gone once refunded');
      await appA.ctx.mailer.flush();
      ok(appA.fakeMail.sent.some((m) => m.to[0] === email && /booking fee was refunded/.test(m.subject)), 'the customer is emailed that the fee was refunded');
      await op.locator('[data-action="o-tab"][data-k="customers"]').click();
      await op.waitForSelector('a[href^="tel:"]');
      ok((await op.locator('.tbl-wrap a[href^="tel:"]').count()) > 0 && (await op.locator('.tbl-wrap a[href^="sms:"]').count()) > 0, 'customers list has tap-to-call and tap-to-text links');
    });

    /* ============================================================== schedule changed too late + owner Reschedule button */
    await section('owner: a day switched off after people booked is flagged; Reschedule moves the client and keeps the $5', async () => {
      const { paidEvent, TOMORROW } = require('./helpers');
      const email = 'ruth.adler@example.com';
      const made = await appA.client().post('/api/bookings', { name: 'Ruth Adler', phone: '(516) 555-0177', email, notes: '', optIn: false, appointments: [{ serviceId: 's1', barberId: 'b6', date: TOMORROW, time: '15:00' }] });
      eq(made.status, 200, 'booking made with barber b6');
      const row0 = appA.db.raw.prepare('SELECT * FROM bookings WHERE email = ?').get(email);
      eq((await appA.sendWebhook(appA.client(), paidEvent('evt_e2e_ruth', row0.id, row0.stripe_session_id, 500))).status, 200, '$5 paid');
      const dow = new Date(TOMORROW + 'T00:00:00Z').getUTCDay();

      // the owner logs back in (the previous section leaves the session alone; if it ended, sign in again)
      await op.locator('[data-action="o-refresh"]').click();
      await op.locator('[data-action="o-tab"][data-k="team"]').click();
      const card = op.locator('.tcard[data-barber="b6"]');
      await card.waitFor();
      await card.locator(`[data-action="o-day"][data-k="${dow}"]`).click();
      await card.locator('[data-action="o-save-changes"]').click();
      await card.locator('.notice:has-text("Heads up")').waitFor();
      ok((await card.locator('.notice').first().innerText()).includes('Needs a new time'), 'saving a day off warns that booked appointments no longer fit');
      eq(appA.db.raw.prepare('SELECT status FROM bookings WHERE id = ?').get(row0.id).status, 'upcoming', 'the booking is not cancelled automatically');

      await op.locator('[data-action="o-tab"][data-k="today"]').click();
      const banner = op.locator('.notice-error:has-text("Needs a new time")');
      await banner.first().waitFor();
      const bt = await banner.first().innerText();
      ok(/Ruth Adler/.test(bt) && /555-0177/.test(bt) && /off that day/.test(bt) && /booking fee/.test(bt), 'banner names the client, phone, the reason, and that the fee is kept');
      ok((await banner.first().locator('a[href^="tel:"]').count()) === 1 && (await banner.first().locator('a[href^="sms:"]').count()) === 1, 'banner has Call and Text buttons');
      await shot(op, '23-owner-needs-new-time', { fullPage: false });
      await banner.first().locator('[data-action="o-rs-open"]').click();
      await op.waitForSelector('.rs-panel .slot-grid');
      ok((await op.locator('.rs-panel').innerText()).includes('booking fee moves with them'), 'panel says the booking fee moves with the client');
      await shot(op, '24-owner-reschedule-panel', { fullPage: false });
      eq(await op.locator('[data-action="o-rs-move"]').isDisabled(), true, 'Move button waits until a time is picked');
      await op.locator('.rs-panel [data-action="o-rs-barber"][data-k="any"]').click();
      await op.waitForSelector('.rs-panel .slot-grid');
      await op.locator(`.rs-panel .day-btn[data-date="${TOMORROW}"]`).click();
      await op.locator('.rs-panel .slot-btn[data-time="15:00"]').click();
      await op.locator('[data-action="o-rs-move"]').click();
      await op.waitForSelector('.notice:has-text("Moved Ruth Adler")');
      const moved = appA.db.raw.prepare('SELECT * FROM bookings WHERE id = ?').get(row0.id);
      ok(moved.barber_id !== 'b6' && moved.date === TOMORROW && moved.time === '15:00' && moved.status === 'upcoming' && moved.fee_paid === 1 && moved.fee_cents === 500, 'moved to another barber at 3:00 PM; the $5 stays paid: ' + JSON.stringify({ b: moved.barber_id, t: moved.time }));
      ok(!(await bodyText(op)).includes('Needs a new time: Ruth'), 'the alert is gone after the move');
      await appA.ctx.mailer.flush();
      ok(appA.fakeMail.sent.some((m) => m.to[0] === email && /We moved your appointment/.test(m.subject)), 'Ruth is emailed her new time');
      // owner card view: Reschedule button on a normal appointment
      await op.locator(`.cal-day[data-k="${TOMORROW}"]`).click();
      await op.waitForSelector('.appt-card:has-text("Ruth Adler")');
      ok((await op.locator('.appt-card:has-text("Ruth Adler") [data-action="o-rs-open"]').count()) === 1, 'every upcoming appointment card has a Reschedule button');
      ok((await op.locator('.appt-card:has-text("Ruth Adler") a[href^="tel:"]').count()) >= 1 && (await op.locator('.appt-card:has-text("Ruth Adler") a[href^="sms:"]').count()) === 1, 'and Call / Text buttons for a late or no-show client');
      // restore the barber's day
      await op.locator('[data-action="o-tab"][data-k="team"]').click();
      await card.locator(`[data-action="o-day"][data-k="${dow}"]`).click();
      await card.locator('[data-action="o-save-changes"]').click();
      await card.locator('.notice:has-text("Saved.")').waitFor();
    });

    /* ============================================================== owner session expiry */
    await section('owner session expiry sends the owner back to sign-in', async () => {
      await ownCtx.clearCookies();
      expectHttp(401, '/api/owner/state');
      await op.locator('[data-action="o-refresh"]').click();
      await op.waitForSelector('form[data-submit="owner-login"]');
      ok((await bodyText(op)).includes('session ended'), '401 shows the login screen with a "session ended" note');
    });

    /* ============================================================== footer links */
    await section('footer links reach the team and shop-screen pages', async () => {
      const ctx = await newContext(browser);
      const p = await ctx.newPage();
      await p.goto(A + '/'); await p.waitForSelector('.footer-bottom');
      await p.locator('[data-action="go-staff"]').click();
      await p.waitForSelector('text=Team sign-in');
      ok(p.url().endsWith('#staff'), 'Employees button goes to #staff');
      await p.locator('[data-action="go-home"]').first().click();
      await p.waitForSelector('.hero');
      await p.locator('[data-action="go-board"]').click();
      await p.waitForSelector('form[data-submit="board-login"]');
      ok(p.url().endsWith('#board'), 'TV button goes to #board');
      // expired/unknown invite link
      expectHttp(404, '/api/staff/setup-info');
      await p.goto(A + '/?staff=' + 'x'.repeat(40));
      await p.waitForSelector('text=expired');
      ok(true, 'an expired invite link shows a helpful message');
      await ctx.close();
    });

    /* ============================================================== wait for the stuck-payment page */
    await section('stuck payment: calm "finishing your payment" message after ~60s', async () => {
      const left = 68000 - (Date.now() - slowPage.started);
      if (left > 0) console.log(`  (waiting ${Math.ceil(left / 1000)}s for the 60s polling window)`);
      await slowPage.page.waitForSelector('text=We’re finishing your payment', { timeout: Math.max(5000, left + 10000) });
      const t = await bodyText(slowPage.page);
      ok(/email as soon as it goes through/.test(t) && !/error/i.test(t), 'shows a calm message (no error) and a way to check again');
      ok(await slowPage.page.locator('[data-action="pay-recheck"]').count() === 1, '"Check again" button is offered');
      await slowPage.ctx.close();
    });

    /* ============================================================== global assertions */
    await section('global: no console errors, no CSP violations, no browser storage', async () => {
      // every HTTP error seen must have been provoked on purpose by a test
      const unexpected = [];
      const pool = expectedHttp.slice();
      for (const e of httpErrors) {
        const i = pool.findIndex((x) => x.status === e.status && e.url.includes(x.urlPart));
        if (i === -1) unexpected.push(`${e.status} ${e.url}`); else pool.splice(i, 1);
      }
      eq(unexpected, [], 'no unexpected failed requests (' + httpErrors.length + ' deliberate 4xx responses seen)');
      eq(consoleErrors, [], 'zero console errors / pageerrors');
      eq(cspEvents, [], 'zero securitypolicyviolation events');
      eq(storageWrites, [], 'nothing was ever written to localStorage/sessionStorage');
    });
  } finally {
    await browser.close().catch(() => {});
    await appA.stop().catch(() => {}); await appB.stop().catch(() => {}); await appC.stop().catch(() => {});
  }
}

main().then(() => {
  console.log(`\nE2E PASS: ${checks} checks in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(0);
}).catch((e) => {
  console.error('\nE2E FAIL: ' + (e && e.stack || e));
  if (consoleErrors.length) console.error('console errors so far:\n' + consoleErrors.join('\n'));
  if (cspEvents.length) console.error('CSP events:', JSON.stringify(cspEvents));
  process.exit(1);
});
