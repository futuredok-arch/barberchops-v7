'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, TODAY, TOMORROW, paidEvent } = require('./helpers');

const goodBooking = (over = {}) => ({ serviceId: 's1', barberId: 'b1', date: TOMORROW, time: '11:00', name: 'Dana Whitfield', phone: '(516) 555-8888', email: 'dana@example.com', notes: 'skin fade', optIn: true, ...over });
const lastBooking = (app) => app.db.raw.prepare('SELECT * FROM bookings ORDER BY created_at DESC, rowid DESC').get();

test('public data exposes nothing private', async () => {
  const app = await startApp();
  try {
    const c = app.client();
    const r = await c.get('/api/public');
    assert.equal(r.status, 200);
    assert.equal(r.json.barbers.length, 8);
    assert.deepEqual(r.json.services.map((x) => x.name), ['Haircut', 'Kids Cut', 'Beard Only', 'Haircut & Beard']);
    assert.ok(r.json.services.every((x) => x.duration === 30));
    const s = JSON.stringify(r.json);
    for (const bad of ['pin', 'email', 'hash', 'token', 'password', 'phone_norm']) assert.ok(!s.toLowerCase().includes(bad.toLowerCase()) || bad === 'phone', `public json contains "${bad}"`);
    assert.ok(!('ownerEmail' in r.json.shop));
    assert.equal(r.json.today, TODAY);
    // security headers
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-powered-by'), null);
  } finally { await app.stop(); }
});

test('availability is computed on the server in shop time', async () => {
  const app = await startApp();
  try {
    const c = app.client();
    const r = await c.get('/api/availability?service=s1&barber=b1&days=3');
    assert.equal(r.status, 200);
    assert.equal(r.json.days[0].date, TODAY);
    const todaySlots = r.json.days[0].slots.map((s) => s.time);
    assert.ok(!todaySlots.includes('10:00'), 'a slot at the current time should not be bookable');
    assert.ok(!todaySlots.includes('10:30'), 'lead time of 30 minutes');
    assert.ok(todaySlots.includes('11:00'));
    assert.ok(r.json.days[1].slots.map((s) => s.time).includes('09:00'));
    const any = await c.get('/api/availability?service=s1&barber=any&days=1');
    assert.ok(any.json.days[0].slots.every((s) => typeof s.barberId === 'string'));
    assert.equal((await c.get('/api/availability?service=nope&barber=any')).status, 400);
    assert.equal((await c.get("/api/availability?service=s1';DROP TABLE bookings;--")).status, 400);
  } finally { await app.stop(); }
});

test('first-time owner setup is protected by the setup key, then closes', async () => {
  const app = await startApp();
  try {
    const c = app.client();
    assert.equal((await c.get('/api/setup/status')).json.needsSetup, true);
    assert.equal((await c.post('/api/setup', { setupKey: 'wrong', email: 'a@b.co', password: 'longenoughpassword' })).status, 403);
    assert.equal((await c.post('/api/setup', { setupKey: app.env.SETUP_KEY, email: 'a@b.co', password: 'short' })).status, 400);
    assert.equal((await c.post('/api/setup', { setupKey: app.env.SETUP_KEY, email: 'owner@example.com', password: 'correct horse battery staple' })).status, 200);
    assert.equal((await c.get('/api/owner/session')).json.authed, true);
    assert.equal((await c.get('/api/setup/status')).json.needsSetup, false);
    const c2 = app.client();
    assert.equal((await c2.post('/api/setup', { setupKey: app.env.SETUP_KEY, email: 'evil@example.com', password: 'another long password' })).status, 403, 'setup must not be re-runnable');
    // and no owner endpoint works without a session
    for (const p of ['/api/owner/state', '/api/owner/customers.csv', '/api/owner/export.json']) assert.equal((await c2.get(p)).status, 401, p);
    assert.equal((await c2.post('/api/owner/bookings', {})).status, 401);
  } finally { await app.stop(); }
});

test('owner login locks after 5 wrong passwords and never says which part was wrong', async () => {
  const app = await startApp();
  try {
    await app.ownerClient();
    const c = app.client();
    for (let i = 0; i < 5; i++) {
      const r = await c.post('/api/owner/login', { email: 'owner@example.com', password: 'wrong-password-' + i });
      assert.equal(r.status, 401);
      assert.equal(r.json.error, 'Email or password is not right.');
    }
    const locked = await c.post('/api/owner/login', { email: 'owner@example.com', password: 'correct horse battery staple' });
    assert.equal(locked.status, 429, 'correct password must be refused while locked');
    app.clock.setFixed(app.clock.nowMs() + 16 * 60e3);
    const ok = await c.post('/api/owner/login', { email: 'owner@example.com', password: 'correct horse battery staple' });
    assert.equal(ok.status, 200);
    const unk = await app.client().post('/api/owner/login', { email: 'nobody@example.com', password: 'x'.repeat(12) });
    assert.equal(unk.json.error, 'Email or password is not right.');
  } finally { await app.stop(); }
});

test('booking + Stripe: slot held, paid only when Stripe says so', async () => {
  const app = await startApp();
  try {
    const owner = await app.ownerClient();
    await owner.patch('/api/owner/settings', { ownerEmail: 'boss@example.com' });
    const c = app.client();
    const r = await c.post('/api/bookings', goodBooking());
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.status, 'pending');
    assert.match(r.json.checkoutUrl, /^https:\/\/checkout\.stripe\.test\/pay\/cs_test_1$/);
    // the session was created server-side with the right amount and metadata
    const sess = app.fakeStripe.sessions[0].params;
    assert.equal(sess['line_items[0][price_data][unit_amount]'], '500');
    assert.equal(sess['line_items[0][price_data][currency]'], 'usd');
    assert.equal(sess['line_items[0][quantity]'], '1');
    assert.equal(sess['line_items[1][price_data][unit_amount]'], undefined, 'only the booking fee is a line item, never the service');
    assert.match(sess['line_items[0][price_data][product_data][description]'], /Booking fee to hold your spot in line\. Non-refundable\. NOT deducted from your service: the full price of your service is still paid at the shop/);
    // the haircut is $40 and the fee is its own $5 item: the charge is 500 cents, never 3500 or 4500
    assert.equal(lastBooking(app).fee_cents, 500);
    const pub = (await c.get('/api/public')).json;
    assert.deepEqual(pub.services.map((s) => s.price), [35, 35, 32, 67], 'in-store prices are shown to the checkout page only as data, never sent to Stripe');
    assert.equal(pub.shop.bookingFee, 5);
    const b = lastBooking(app);
    assert.equal(sess['metadata[group_id]'], b.id, 'the order id is the first appointment id');
    assert.equal(b.status, 'pending');
    assert.equal(b.fee_paid, 0);
    // pending: the slot is held for others but no emails yet
    const slots = (await c.get('/api/availability?service=s1&barber=b1&days=2')).json.days[1].slots.map((s) => s.time);
    assert.ok(!slots.includes('11:00'), 'held slot must not be offered again');
    assert.equal(app.db.raw.prepare('SELECT COUNT(*) c FROM outbox').get().c, 0);
    // customer clicking "I paid" cannot confirm anything: only Stripe can
    const st = await c.get('/api/bookings/status?t=' + encodeURIComponent(r.json.token));
    assert.equal(st.json.status, 'pending');

    // forged / unsigned webhook does nothing
    const evt = paidEvent('evt_1', b.id, 'cs_test_1');
    const forged = await app.sendWebhook(c, evt, 't=1,v1=deadbeef');
    assert.equal(forged.status, 400);
    assert.equal(lastBooking(app).status, 'pending');

    // real, signed webhook confirms it
    const ok = await app.sendWebhook(c, evt);
    assert.equal(ok.status, 200);
    assert.equal(lastBooking(app).status, 'upcoming');
    assert.equal(lastBooking(app).fee_paid, 1);
    assert.equal((await c.get('/api/bookings/status?t=' + encodeURIComponent(r.json.token))).json.status, 'upcoming');

    // replay is ignored, and no duplicate emails
    const again = await app.sendWebhook(c, evt);
    assert.equal(again.json.duplicate, true);

    // emails: owner alert + customer confirmation
    await app.ctx.mailer.flush();
    const to = app.fakeMail.sent.map((m) => m.to[0]).sort();
    assert.deepEqual(to, ['boss@example.com', 'dana@example.com']);
    const ownerMail = app.fakeMail.sent.find((m) => m.to[0] === 'boss@example.com');
    assert.match(ownerMail.text, /Dana Whitfield/);
    assert.match(ownerMail.text, /516-555-8888/);
    assert.equal(app.fakeMail.sent[0].auth, 'Bearer mail_test_key');
  } finally { await app.stop(); }
});

test('webhook rejects wrong amounts and unknown bookings', async () => {
  const app = await startApp();
  try {
    const c = app.client();
    const r = await c.post('/api/bookings', goodBooking());
    const b = lastBooking(app);
    await app.sendWebhook(c, paidEvent('evt_amt', b.id, 'cs_test_1', 100)); // customer somehow paid $1
    assert.equal(lastBooking(app).status, 'pending');
    const unknown = await app.sendWebhook(c, paidEvent('evt_unk', 'doesnotexist', 'cs_x'));
    assert.equal(unknown.status, 200);
    assert.equal(app.db.raw.prepare(`SELECT COUNT(*) c FROM bookings WHERE status='upcoming'`).get().c, 0);
    assert.ok(r.json.token);
  } finally { await app.stop(); }
});

test('two people racing for the same slot: exactly one wins', async () => {
  const app = await startApp();
  try {
    const results = await Promise.all([
      app.client().post('/api/bookings', goodBooking({ phone: '(516) 555-1001', name: 'Racer One' })),
      app.client().post('/api/bookings', goodBooking({ phone: '(516) 555-1002', name: 'Racer Two' })),
      app.client().post('/api/bookings', goodBooking({ phone: '(516) 555-1003', name: 'Racer Three' })),
    ]);
    const codes = results.map((r) => r.status).sort();
    assert.deepEqual(codes, [200, 409, 409]);
    assert.equal(app.db.raw.prepare(`SELECT COUNT(*) c FROM bookings WHERE barber_id='b1' AND date=? AND time='11:00'`).get(TOMORROW).c, 1);
  } finally { await app.stop(); }
});

test('holds expire and free the slot; cancelling a pending payment frees it right away', async () => {
  const app = await startApp();
  try {
    const c = app.client();
    const r = await c.post('/api/bookings', goodBooking());
    app.clock.setFixed(app.clock.nowMs() + 40 * 60e3);
    app.housekeeping();
    assert.equal(lastBooking(app).status, 'expired');
    const r2 = await c.post('/api/bookings', goodBooking({ phone: '(516) 555-2002' }));
    assert.equal(r2.status, 200);
    await c.post('/api/bookings/cancel-pending', { t: r2.json.token });
    assert.equal(lastBooking(app).status, 'expired');
    assert.ok(r.json.token);
  } finally { await app.stop(); }
});

test('late payment for an expired hold whose slot was taken flags a refund instead of double booking', async () => {
  const app = await startApp();
  try {
    const c = app.client();
    await (await app.ownerClient()).patch('/api/owner/settings', { ownerEmail: 'boss@example.com' });
    await c.post('/api/bookings', goodBooking({ name: 'Slow Payer', phone: '(516) 555-3003' }));
    const slow = lastBooking(app);
    app.clock.setFixed(app.clock.nowMs() + 40 * 60e3); app.housekeeping();
    await c.post('/api/bookings', goodBooking({ name: 'Quick Payer', phone: '(516) 555-3004' }));
    const quick = lastBooking(app);
    await app.sendWebhook(c, paidEvent('evt_q', quick.id, quick.stripe_session_id));
    await app.sendWebhook(c, paidEvent('evt_s', slow.id, slow.stripe_session_id));
    const rows = app.db.raw.prepare(`SELECT id,status,needs_refund FROM bookings WHERE id IN (?,?)`).all(slow.id, quick.id);
    assert.equal(rows.find((r) => r.id === quick.id).status, 'upcoming');
    const s = rows.find((r) => r.id === slow.id);
    assert.equal(s.status, 'cancelled'); assert.equal(s.needs_refund, 1);
    await app.ctx.mailer.flush();
    assert.ok(app.fakeMail.sent.some((m) => /refund/i.test(m.subject)));
  } finally { await app.stop(); }
});

test('input validation, blocked numbers, honeypot, per-phone limits', async () => {
  const app = await startApp();
  try {
    const owner = await app.ownerClient();
    const c = app.client();
    for (const bad of [{ phone: '123' }, { name: 'A' }, { email: 'not-an-email' }, { date: '2020-01-01' }, { date: 'tomorrow' }, { time: '25:00' }, { serviceId: '../x' }, { time: '03:00' }, { name: 'x'.repeat(200) }, { notes: 'n'.repeat(500) }]) {
      const r = await c.post('/api/bookings', goodBooking(bad));
      assert.ok(r.status === 400 || r.status === 409, `${JSON.stringify(bad)} -> ${r.status}`);
    }
    const inj = await c.post('/api/bookings', goodBooking({ name: '<script>alert(1)</script>Bob Smith', notes: '<img src=x onerror=alert(1)>hi', phone: '(516) 555-4004' }));
    assert.equal(inj.status, 200);
    const stored = lastBooking(app);
    assert.ok(!/[<>]/.test(stored.customer_name + stored.notes), 'markup characters must be stripped');
    // honeypot
    const before = app.db.raw.prepare('SELECT COUNT(*) c FROM bookings').get().c;
    await c.post('/api/bookings', { ...goodBooking({ phone: '(516) 555-4005', time: '12:00' }), website: 'http://spam' });
    assert.equal(app.db.raw.prepare('SELECT COUNT(*) c FROM bookings').get().c, before);
    // blocked
    await owner.post('/api/owner/blocked', { phone: '(516) 555-6666', name: 'No Show Ned' });
    const bl = await c.post('/api/bookings', goodBooking({ phone: '516-555-6666', time: '13:00' }));
    assert.equal(bl.status, 403);
    // too many pending for one phone
    let last;
    for (let i = 0; i < 9; i++) last = await c.post('/api/bookings', goodBooking({ phone: '(516) 555-7007', barberId: ['b1', 'b2', 'b3'][i % 3], time: ['14:00', '14:30', '15:00'][Math.floor(i / 3)] }));
    assert.equal(last.status, 429);
  } finally { await app.stop(); }
});

test('payments not configured in production refuses bookings instead of taking free ones', async () => {
  const app = await startApp({ NODE_ENV: 'production', BASE_URL: 'https://book.example.com' }, { stripe: false });
  try {
    const r = await app.client().post('/api/bookings', goodBooking());
    assert.equal(r.status, 503);
    assert.equal(app.db.raw.prepare('SELECT COUNT(*) c FROM bookings').get().c, 0);
  } finally { await app.stop(); }
});

test('REQUIRE_PAYMENT=false confirms immediately (launch before Stripe is ready)', async () => {
  const app = await startApp({ REQUIRE_PAYMENT: 'false' }, { stripe: false });
  try {
    const r = await app.client().post('/api/bookings', goodBooking());
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'confirmed');
    assert.equal(lastBooking(app).status, 'upcoming');
  } finally { await app.stop(); }
});


/* ---------- one checkout, several appointments: every appointment pays its own booking fee ---------- */
const kids = (over = []) => ['Ava', 'Ben', 'Cal', 'Dee'].map((n, i) => ({ serviceId: 's2', barberId: ['b1', 'b2', 'b3', 'b4'][i], date: TOMORROW, time: '11:00', forName: n, ...(over[i] || {}) }));
const parent = { name: 'Sarah Miller', phone: '(516) 555-9090', email: 'sarah@example.com', optIn: true };
const orderRows = (app, id) => app.db.raw.prepare('SELECT * FROM bookings WHERE group_id = ? ORDER BY rowid').all(id);

test('four kids in one checkout = four separate $5 charges = $20, never a flat fee', async () => {
  const app = await startApp();
  try {
    const owner = await app.ownerClient();
    await owner.patch('/api/owner/settings', { ownerEmail: 'boss@example.com' });
    const c = app.client();
    const r = await c.post('/api/bookings', { ...parent, appointments: kids() });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.count, 4); assert.equal(r.json.feeTotalCents, 2000);
    // Stripe got FOUR line items, each exactly $5, and no fifth
    const p = app.fakeStripe.sessions[0].params;
    for (let i = 0; i < 4; i++) { assert.equal(p[`line_items[${i}][price_data][unit_amount]`], '500'); assert.equal(p[`line_items[${i}][quantity]`], '1'); assert.equal(p[`line_items[${i}][price_data][currency]`], 'usd'); }
    assert.equal(p['line_items[4][price_data][unit_amount]'], undefined);
    assert.match(p['line_items[0][price_data][product_data][name]'], /Booking fee/);
    // four separate bookings, each holding its own $5, none confirmed yet
    const first = app.db.raw.prepare('SELECT * FROM bookings ORDER BY rowid').get();
    const rows = orderRows(app, first.id);
    assert.equal(rows.length, 4);
    assert.ok(rows.every((b) => b.fee_cents === 500 && b.status === 'pending'));
    assert.deepEqual(rows.map((b) => b.customer_name), ['Ava', 'Ben', 'Cal', 'Dee']);
    assert.ok(rows.every((b) => b.contact_name === 'Sarah Miller'));
    assert.equal(p['metadata[group_id]'], first.id);
    // paying only ONE fee ($5) for the four appointments confirms nothing
    await app.sendWebhook(c, paidEvent('evt_flat', first.id, rows[0].stripe_session_id, 500));
    assert.ok(orderRows(app, first.id).every((b) => b.status === 'pending'), 'a flat $5 does not confirm four appointments');
    // the real total ($20) confirms all four
    const ok = await app.sendWebhook(c, paidEvent('evt_all', first.id, rows[0].stripe_session_id, 2000));
    assert.equal(ok.status, 200);
    const after = orderRows(app, first.id);
    assert.ok(after.every((b) => b.status === 'upcoming' && b.fee_paid === 1));
    // replays do nothing more
    await app.sendWebhook(c, paidEvent('evt_all', first.id, rows[0].stripe_session_id, 2000));
    // ONE owner email and ONE customer email for the whole order, both listing all four and the $20
    await app.ctx.mailer.flush();
    const owner_ = app.fakeMail.sent.filter((m) => m.to[0] === 'boss@example.com');
    const cust = app.fakeMail.sent.filter((m) => m.to[0] === 'sarah@example.com');
    assert.equal(owner_.length, 1); assert.equal(cust.length, 1);
    for (const m of [owner_[0], cust[0]]) { for (const n of ['Ava', 'Ben', 'Cal', 'Dee']) assert.ok(m.text.includes(n), 'lists ' + n); assert.ok(m.text.includes('$20.00')); }
    // the customer's status page lists all four, $20 total, and shows no service price
    const st = (await c.get('/api/bookings/status?t=' + encodeURIComponent(r.json.token))).json;
    assert.equal(st.status, 'upcoming'); assert.equal(st.appointments.length, 4); assert.equal(st.feeTotalCents, 2000); assert.equal(st.feePaidCents, 2000);
    assert.ok(!JSON.stringify(st).includes('price'));
    // the marketing list shows the parent, not a child
    const csv = (await owner.get('/api/owner/customers.csv')).text;
    assert.match(csv, /Sarah,Miller,5165559090/); assert.ok(!/Ava/.test(csv));
  } finally { await app.stop(); }
});

test('one appointment is still exactly one $5 line; six is the limit', async () => {
  const app = await startApp();
  try {
    const c = app.client();
    const one = await c.post('/api/bookings', { ...parent, appointments: kids().slice(0, 1) });
    assert.equal(one.json.feeTotalCents, 500);
    const p = app.fakeStripe.sessions[0].params;
    assert.equal(p['line_items[0][price_data][unit_amount]'], '500'); assert.equal(p['line_items[1][price_data][unit_amount]'], undefined);
    const seven = Array.from({ length: 7 }, (_, i) => ({ serviceId: 's2', barberId: 'any', date: TOMORROW, time: ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00'][i], forName: 'K' + i }));
    assert.equal((await c.post('/api/bookings', { ...parent, phone: '(516) 555-9191', appointments: seven })).status, 400);
    assert.equal((await c.post('/api/bookings', { ...parent, phone: '(516) 555-9192', appointments: [] })).status, 400);
    const six = seven.slice(0, 6);
    const r6 = await c.post('/api/bookings', { ...parent, phone: '(516) 555-9193', appointments: six });
    assert.equal(r6.status, 200, r6.text); assert.equal(r6.json.feeTotalCents, 3000);
  } finally { await app.stop(); }
});

test('an order is all-or-nothing: one taken slot means nothing is held or charged', async () => {
  const app = await startApp();
  try {
    const c = app.client();
    await c.post('/api/bookings', { ...parent, phone: '(516) 555-9294', appointments: [{ serviceId: 's1', barberId: 'b3', date: TOMORROW, time: '11:00', forName: 'Taken' }] });
    const before = app.db.raw.prepare("SELECT COUNT(*) c FROM bookings WHERE status = 'pending'").get().c;
    const sessions = app.fakeStripe.sessions.length;
    const r = await c.post('/api/bookings', { ...parent, appointments: kids() }); // Cal wants b3 at 11:00, already held
    assert.equal(r.status, 409);
    assert.equal(app.db.raw.prepare("SELECT COUNT(*) c FROM bookings WHERE status = 'pending'").get().c, before, 'no partial holds left behind');
    assert.equal(app.fakeStripe.sessions.length, sessions, 'no Stripe session for a failed order');
  } finally { await app.stop(); }
});

test('if one appointment in a paid order lost its slot, only that $5 is flagged for refund', async () => {
  const app = await startApp();
  try {
    const c = app.client();
    await (await app.ownerClient()).patch('/api/owner/settings', { ownerEmail: 'boss@example.com' });
    const r = await c.post('/api/bookings', { ...parent, appointments: kids().slice(0, 2) });
    const first = app.db.raw.prepare('SELECT * FROM bookings ORDER BY rowid').get();
    const sess = first.stripe_session_id;
    app.clock.setFixed(app.clock.nowMs() + 40 * 60e3); app.housekeeping();          // holds expire before payment
    await c.post('/api/bookings', { name: 'Fast Fred', phone: '(516) 555-9797', appointments: [{ serviceId: 's2', barberId: 'b2', date: TOMORROW, time: '11:00' }] });
    const fred = app.db.raw.prepare("SELECT * FROM bookings WHERE customer_name = 'Fast Fred'").get();
    await app.sendWebhook(c, paidEvent('evt_f', fred.id, fred.stripe_session_id));
    await app.sendWebhook(c, paidEvent('evt_p', first.id, sess, 1000));            // Sarah pays $10 late
    const rows = orderRows(app, first.id);
    assert.equal(rows[0].status, 'upcoming'); assert.equal(rows[0].needs_refund, 0);
    assert.equal(rows[1].status, 'cancelled'); assert.equal(rows[1].needs_refund, 1);
    await app.ctx.mailer.flush();
    const refund = app.fakeMail.sent.find((m) => /refund/i.test(m.subject));
    assert.ok(refund && refund.text.includes('$5.00') && !refund.text.includes('$10.00'));
    const st = (await c.get('/api/bookings/status?t=' + encodeURIComponent(r.json.token))).json;
    assert.equal(st.lost, 1); assert.equal(st.feePaidCents, 500);
  } finally { await app.stop(); }
});

test('cancelling an unpaid order frees every appointment in it; free mode confirms them all with no fee', async () => {
  const app = await startApp();
  try {
    const c = app.client();
    const r = await c.post('/api/bookings', { ...parent, appointments: kids() });
    assert.equal((await c.post('/api/bookings/cancel-pending', { t: r.json.token })).status, 200);
    assert.equal(app.db.raw.prepare("SELECT COUNT(*) c FROM bookings WHERE status = 'pending'").get().c, 0);
  } finally { await app.stop(); }
  const free = await startApp({ REQUIRE_PAYMENT: 'false' });
  try {
    const c = free.client();
    const r = await c.post('/api/bookings', { ...parent, appointments: kids() });
    assert.equal(r.json.status, 'confirmed'); assert.equal(r.json.feeTotalCents, 0);
    assert.equal(free.db.raw.prepare("SELECT COUNT(*) c FROM bookings WHERE status = 'upcoming' AND fee_cents = 0").get().c, 4);
  } finally { await free.stop(); }
});

test('an existing database with the old 11-service menu is upgraded to the four simple choices', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { openDb } = require('../src/db');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-mig-'));
  let db = openDb(dir);
  // put the database back the way an older version left it
  db.raw.prepare("DELETE FROM settings WHERE key = 'servicesV2'").run();
  db.raw.prepare("UPDATE services SET name = 'The Quality Cut', price = 40 WHERE id = 's1'").run();
  for (let i = 5; i <= 11; i++) db.raw.prepare("INSERT INTO services (id,category,name,duration,price,note,sort) VALUES (?,?,?,?,?,?,?)").run('s' + i, 'Extras', 'Old ' + i, 10, 9, '', i);
  db.close();
  db = openDb(dir);
  const active = db.raw.prepare('SELECT id,name,duration,price FROM services WHERE active = 1 ORDER BY sort').all();
  assert.deepEqual(active.map((x) => x.name), ['Haircut', 'Kids Cut', 'Beard Only', 'Haircut & Beard']);
  assert.deepEqual(active.map((x) => x.price), [35, 35, 32, 67]);
  assert.ok(active.every((x) => x.duration === 30));
  assert.equal(db.raw.prepare('SELECT COUNT(*) c FROM services WHERE active = 0').get().c, 7);
  db.close();
  db = openDb(dir); // reopening changes nothing further
  assert.equal(db.raw.prepare('SELECT COUNT(*) c FROM services WHERE active = 1').get().c, 4);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('checkout totals: three haircuts = $105 due in store, $15 due now; Stripe is charged only the $15', async () => {
  const app = await startApp();
  try {
    const c = app.client();
    const three = ['A', 'B', 'C'].map((n, i) => ({ serviceId: 's1', barberId: ['b1', 'b2', 'b3'][i], date: TOMORROW, time: '11:00', forName: n }));
    const r = await c.post('/api/bookings', { ...parent, appointments: three });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.feeTotalCents, 1500);
    const p = app.fakeStripe.sessions[0].params;
    const cents = Object.entries(p).filter(([k]) => /unit_amount\]$/.test(k)).map(([, v]) => v);
    assert.deepEqual(cents, ['500', '500', '500'], 'Stripe sees only three $5 booking-fee lines');
    for (const v of Object.values(p)) assert.ok(!/(^|[^0-9])(3500|10500|10500)([^0-9]|$)/.test(String(v)), 'no service price is ever sent to Stripe');
    const st = (await c.get('/api/bookings/status?t=' + encodeURIComponent(r.json.token))).json;
    assert.equal(st.dueInStore, 105); assert.equal(st.feeTotalCents, 1500);
    assert.deepEqual(st.appointments.map((a) => a.servicePrice), [35, 35, 35]);
    // the price is remembered per booking: a later price change does not rewrite this order
    const owner = await app.ownerClient();
    await owner.patch('/api/owner/services/s1', { price: 50 });
    assert.equal((await c.get('/api/bookings/status?t=' + encodeURIComponent(r.json.token))).json.dueInStore, 105);
    // pay, then the emails show both numbers clearly
    await (await app.ownerClient()).patch('/api/owner/settings', { ownerEmail: 'boss@example.com' });
    const first = app.db.raw.prepare('SELECT * FROM bookings ORDER BY rowid').get();
    await app.sendWebhook(c, paidEvent('evt_3', first.id, first.stripe_session_id, 1500));
    await app.ctx.mailer.flush();
    const mail = app.fakeMail.sent.filter((m) => m.to[0] === 'sarah@example.com')[0];
    assert.ok(mail && mail.text.includes('$105.00') && mail.text.includes('$15.00'), 'customer email states $105.00 due in store and $15.00 paid online');
    assert.match(mail.text, /due in store/i);
  } finally { await app.stop(); }
});
