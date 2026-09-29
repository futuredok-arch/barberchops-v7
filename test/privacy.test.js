'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, TODAY, TOMORROW } = require('./helpers');

// confirmed bookings made straight through the owner API (no payment step)
async function seed(app, owner) {
  const mk = async (body) => { const r = await owner.post('/api/owner/bookings', body); assert.equal(r.status, 200, r.text); return r.json.id; };
  const ids = {};
  ids.joe = await mk({ barberId: 'b1', serviceId: 's1', date: TODAY, time: '14:30', name: 'Mike Donnelly', phone: '(516) 555-0110', email: 'mike@example.com', notes: 'Prefers unscented lather', optIn: true });
  ids.freddy = await mk({ barberId: 'b3', serviceId: 's4', date: TODAY, time: '16:00', name: 'Chris Petrakis', phone: '(516) 555-0199', email: 'chris.p@example.com', notes: 'allergic to menthol' });
  ids.tomorrow = await mk({ barberId: 'b3', serviceId: 's2', date: TOMORROW, time: '10:00', name: 'Owen Marsh', phone: '(516) 555-0175' });
  return ids;
}
async function staffLogin(app, owner, barberId, pin = '123456') {
  const inv = await owner.post(`/api/owner/barbers/${barberId}/invite`, {});
  assert.equal(inv.status, 200);
  const token = new URL(inv.json.url).searchParams.get('staff');
  const c = app.client();
  const info = await c.get('/api/staff/setup-info?token=' + token);
  assert.equal(info.status, 200);
  const r = await c.post('/api/staff/setup', { token, pin });
  assert.equal(r.status, 200, r.text);
  return { c, token };
}

test('a barber sees only their own clients, first names only, nothing private', async () => {
  const app = await startApp();
  try {
    const owner = await app.ownerClient();
    const ids = await seed(app, owner);
    const { c } = await staffLogin(app, owner, 'b3');
    const me = await c.get('/api/staff/me');
    assert.equal(me.status, 200);
    const names = me.json.appointments.map((a) => a.firstName).sort();
    assert.deepEqual(names, ['Chris', 'Owen']);
    const raw = me.text;
    for (const secret of ['Petrakis', 'Marsh', '555-0199', '555-0175', 'chris.p@example.com', 'menthol', 'Mike', 'Donnelly', 'unscented']) assert.ok(!raw.includes(secret), `barber response leaked "${secret}"`);
    for (const a of me.json.appointments) assert.deepEqual(Object.keys(a).sort(), ['date', 'duration', 'firstName', 'id', 'service', 'status', 'time']);
    // cannot act on another barber's appointment
    const other = await c.post(`/api/staff/appointments/${ids.joe}/status`, { status: 'completed' });
    assert.equal(other.status, 404);
    // can act on their own
    assert.equal((await c.post(`/api/staff/appointments/${ids.freddy}/status`, { status: 'completed' })).status, 200);
    assert.equal((await c.post(`/api/staff/appointments/${ids.tomorrow}/status`, { status: 'cancelled' })).status, 400, 'barbers cannot cancel, only mark done/no-show');
    // a barber session is not an owner session
    for (const p of ['/api/owner/state', '/api/owner/customers.csv', '/api/owner/export.json']) assert.equal((await c.get(p)).status, 401, p);
    assert.equal((await c.get('/api/board')).status, 401);
  } finally { await app.stop(); }
});

test('barber sign-in: one-time link, 6-digit PIN, lockout, reset', async () => {
  const app = await startApp();
  try {
    const owner = await app.ownerClient();
    const { token } = await staffLogin(app, owner, 'b2', '246810');
    // link is single-use
    assert.equal((await app.client().post('/api/staff/setup', { token, pin: '111111' })).status, 404);
    assert.equal((await app.client().get('/api/staff/setup-info?token=' + token)).status, 404);
    // weak PINs refused
    const inv = await owner.post('/api/owner/barbers/b4/invite', {});
    const t2 = new URL(inv.json.url).searchParams.get('staff');
    assert.equal((await app.client().post('/api/staff/setup', { token: t2, pin: '1234' })).status, 400);
    assert.equal((await app.client().post('/api/staff/setup', { token: t2, pin: 'abcdef' })).status, 400);
    // an unset account cannot be logged into or claimed by guessing
    assert.equal((await app.client().post('/api/staff/login', { barberId: 'b5', pin: '000000' })).status, 401);
    assert.equal((await app.client().post('/api/staff/setup', { token: 'a'.repeat(43), pin: '123456' })).status, 404);
    // wrong PIN x5 locks
    const c = app.client();
    for (let i = 0; i < 5; i++) assert.equal((await c.post('/api/staff/login', { barberId: 'b2', pin: '999999' })).status, 401);
    assert.equal((await c.post('/api/staff/login', { barberId: 'b2', pin: '246810' })).status, 429);
    // owner reset issues a fresh link, clears PIN and sessions
    const reset = await owner.post('/api/owner/barbers/b2/invite', { reset: true });
    assert.equal(reset.status, 200);
    assert.equal((await c.post('/api/staff/login', { barberId: 'b2', pin: '246810' })).status, 401);
    // links expire after 7 days
    const t3 = new URL(reset.json.url).searchParams.get('staff');
    app.clock.setFixed(app.clock.nowMs() + 8 * 86400e3);
    assert.equal((await app.client().post('/api/staff/setup', { token: t3, pin: '135790' })).status, 404);
  } finally { await app.stop(); }
});

test('removed barbers lose access immediately', async () => {
  const app = await startApp();
  try {
    const owner = await app.ownerClient();
    const { c } = await staffLogin(app, owner, 'b6');
    assert.equal((await c.get('/api/staff/me')).status, 200);
    assert.deepEqual((await c.get('/api/staff/session')).json, { authed: true });
    assert.deepEqual((await app.client().get('/api/staff/session')).json, { authed: false });
    assert.equal((await owner.del('/api/owner/barbers/b6')).status, 200);
    assert.equal((await c.get('/api/staff/me')).status, 401);
    assert.deepEqual((await c.get('/api/staff/session')).json, { authed: false });
    assert.ok(!(await app.client().get('/api/public')).json.barbers.some((b) => b.id === 'b6'));
  } finally { await app.stop(); }
});

test('TV board: needs its PIN, shows first name + last initial only', async () => {
  const app = await startApp();
  try {
    const owner = await app.ownerClient();
    await seed(app, owner);
    const tv = app.client();
    assert.equal((await tv.get('/api/board')).status, 401);
    assert.equal((await tv.get('/api/board/session')).json.configured, false);
    // owner sets a 6-digit PIN (hashed, never returned)
    assert.equal((await owner.post('/api/owner/board-pin', { pin: '12' })).status, 400);
    assert.equal((await owner.post('/api/owner/board-pin', { pin: '482915' })).status, 200);
    assert.equal((await owner.get('/api/owner/state')).json.shop.hasBoardPin, true);
    assert.ok(!(await owner.get('/api/owner/state')).text.includes('482915'));
    assert.equal((await tv.post('/api/board/login', { pin: '000000' })).status, 401);
    assert.equal((await tv.post('/api/board/login', { pin: '482915' })).status, 200);
    const b = await tv.get('/api/board');
    assert.equal(b.status, 200);
    const labels = b.json.bookings.map((x) => x.label).sort();
    assert.deepEqual(labels, ['Chris P.', 'Mike D.']);
    for (const secret of ['Donnelly', 'Petrakis', '555-0110', '@example.com', 'menthol', 'unscented', 'Owen']) assert.ok(!b.text.includes(secret), `board leaked "${secret}"`);
    assert.equal((await tv.get('/api/owner/state')).status, 401);
    // changing the PIN signs every TV out
    await owner.post('/api/owner/board-pin', { pin: '777888' });
    assert.equal((await tv.get('/api/board')).status, 401);
  } finally { await app.stop(); }
});

test('cross-site requests and odd content types are refused', async () => {
  const app = await startApp();
  try {
    const owner = await app.ownerClient();
    const evil = await owner.call('POST', '/api/owner/blocked', { body: { phone: '516-555-9999' }, origin: 'https://evil.example.com' });
    assert.equal(evil.status, 403);
    const form = await owner.call('POST', '/api/owner/blocked', { raw: 'phone=5165559999', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(form.status, 415);
    const text = await owner.call('POST', '/api/owner/blocked', { raw: '{"phone":"5165559999"}', headers: { 'Content-Type': 'text/plain' } });
    assert.equal(text.status, 415);
    const sf = await owner.call('POST', '/api/owner/blocked', { body: { phone: '516-555-9999' }, origin: null, headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(sf.status, 403);
    assert.equal(app.db.raw.prepare('SELECT COUNT(*) c FROM blocked').get().c, 0);
    // cookies are locked down
    const login = await app.client().call('POST', '/api/owner/login', { body: { email: 'owner@example.com', password: 'correct horse battery staple' } });
    const sc = login.headers.getSetCookie().join('\n');
    assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Lax/);
  } finally { await app.stop(); }
});

test('photos: JPEG only, size capped, replaceable, deletable, publicly viewable', async () => {
  const app = await startApp();
  try {
    const owner = await app.ownerClient();
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7), Buffer.from([0xff, 0xd9])]);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(2000, 1)]);
    const up = (kind, buf, type = 'image/jpeg') => owner.call('POST', `/api/owner/barbers/b1/photos?kind=${kind}`, { raw: buf, headers: { 'Content-Type': type } });
    assert.equal((await up('profile', png)).status, 400);
    assert.equal((await up('profile', jpeg, 'text/html')).status, 415);
    assert.equal((await up('profile', Buffer.alloc(700 * 1024, 1).fill(0xff, 0, 3))).status, 413);
    const p1 = await up('profile', jpeg); assert.equal(p1.status, 200);
    const img = await app.client().get(p1.json.url);
    assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/jpeg'); assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
    const p2 = await up('profile', jpeg);
    assert.equal((await app.client().get(p1.json.url)).status, 404, 'old profile photo removed when replaced');
    for (let i = 0; i < 8; i++) assert.equal((await up('gallery', jpeg)).status, 200);
    assert.equal((await up('gallery', jpeg)).status, 400, 'gallery capped at 8');
    const pub = (await app.client().get('/api/public')).json.barbers.find((b) => b.id === 'b1');
    assert.equal(pub.gallery.length, 8); assert.ok(pub.photo);
    assert.equal((await owner.del('/api/owner/photos/' + p2.json.id)).status, 200);
    assert.equal((await app.client().get('/api/public')).json.barbers.find((b) => b.id === 'b1').photo, null);
    // path traversal in static uploads
    assert.notEqual((await app.client().get('/uploads/..%2f..%2fbarberchops.db')).status, 200);
    // nobody but the owner can upload
    assert.equal((await app.client().call('POST', '/api/owner/barbers/b1/photos?kind=gallery', { raw: jpeg, headers: { 'Content-Type': 'image/jpeg' } })).status, 401);
  } finally { await app.stop(); }
});

test('customer list & CSV: opted-in only by default, blocked excluded, formula injection neutralised', async () => {
  const app = await startApp();
  try {
    const owner = await app.ownerClient();
    await owner.post('/api/owner/bookings', { barberId: 'b1', serviceId: 's1', date: TOMORROW, time: '09:00', name: 'Yes Person', phone: '(516) 555-1111', email: 'yes@example.com', optIn: true });
    await owner.post('/api/owner/bookings', { barberId: 'b1', serviceId: 's1', date: TOMORROW, time: '09:30', name: 'No Person', phone: '(516) 555-2222' });
    await owner.post('/api/owner/bookings', { barberId: 'b1', serviceId: 's1', date: TOMORROW, time: '10:00', name: '=HYPERLINK("http://x") Evil', phone: '(516) 555-3333', optIn: true });
    await owner.post('/api/owner/bookings', { barberId: 'b1', serviceId: 's1', date: TOMORROW, time: '10:30', name: 'Blocked Bob', phone: '(516) 555-4444', optIn: true });
    await owner.post('/api/owner/blocked', { phone: '(516) 555-4444' });
    const csv = (await owner.get('/api/owner/customers.csv')).text;
    assert.match(csv, /^First Name,Last Name,Phone,Email/);
    assert.match(csv, /Yes,Person,5165551111,yes@example\.com,Yes,\d{4}-/);
    assert.ok(!csv.includes('No Person')); assert.ok(!csv.includes('Blocked'));
    assert.ok(!/^=|,=/m.test(csv), 'formula injection must be neutralised');
    assert.match(csv, /'=HYPERLINK/);
    const all = (await owner.get('/api/owner/customers.csv?all=1')).text;
    assert.match(all, /No,Person,5165552222/);
    // owner can tick / untick
    assert.equal((await owner.put('/api/owner/optin', { phone: '516-555-2222', optIn: true })).status, 200);
    assert.match((await owner.get('/api/owner/customers.csv')).text, /No,Person/);
    assert.equal((await owner.put('/api/owner/optin', { phone: '516-555-2222', optIn: false })).status, 200);
    assert.ok(!(await owner.get('/api/owner/customers.csv')).text.includes('No,Person'));
    // exports are recorded
    const audit = (await owner.get('/api/owner/state')).json.audit.map((a) => a.action);
    assert.ok(audit.includes('customers_exported'));
    // backup export has no secrets
    const bk = (await owner.get('/api/owner/export.json')).text;
    assert.ok(!/pin_hash|pass_hash|token_hash|boardPinHash|sk_test/.test(bk));
  } finally { await app.stop(); }
});

test('owner tools: settings validation, staff, time off, hours, password change', async () => {
  const app = await startApp();
  try {
    const owner = await app.ownerClient();
    assert.equal((await owner.patch('/api/owner/settings', { bookingFee: -5 })).status, 400);
    assert.equal((await owner.patch('/api/owner/settings', { bookingFee: 5.5 })).status, 400);
    assert.equal((await owner.patch('/api/owner/settings', { ownerEmail: 'nope' })).status, 400);
    assert.equal((await owner.patch('/api/owner/settings', { hours: { 0: { open: 10, close: 9 } } })).status, 400);
    assert.equal((await owner.patch('/api/owner/settings', { name: 'Bad <b>' })).status, 200);
    assert.ok(!/[<>]/.test((await app.client().get('/api/public')).json.shop.name));
    // add / edit barber
    const add = await owner.post('/api/owner/barbers', { name: 'Sam', title: 'Barber', lang: 'en' });
    assert.equal(add.status, 200);
    assert.equal((await owner.patch('/api/owner/barbers/' + add.json.id, { daysOff: [0, 9] })).status, 400);
    assert.equal((await owner.patch('/api/owner/barbers/' + add.json.id, { daysOff: [0], useCustomHours: true, hours: { 0: null, 1: { open: 12, close: 18 }, 2: { open: 12, close: 18 }, 3: { open: 12, close: 18 }, 4: { open: 12, close: 18 }, 5: { open: 12, close: 18 }, 6: null } })).status, 200);
    assert.equal((await owner.patch('/api/owner/barbers/' + add.json.id, { hours: { 1: { open: 12, close: 18 } } })).status, 400, 'partial hours are refused');
    // custom hours honoured in availability (Sam works Wed 12-18)
    const av = (await app.client().get(`/api/availability?service=s1&barber=${add.json.id}&days=2`)).json.days;
    const wed = av[0].slots.map((s) => s.time);
    assert.ok(wed.includes('12:00') && !wed.includes('11:00'), 'custom hours 12-18 respected');
    // time off: whole day and a break
    assert.equal((await owner.post(`/api/owner/barbers/b1/timeoff`, { date: TOMORROW, allDay: true })).status, 200);
    assert.equal((await owner.post(`/api/owner/barbers/b2/timeoff`, { date: TOMORROW, allDay: false, from: '12:00', to: '13:00' })).status, 200);
    assert.equal((await owner.post(`/api/owner/barbers/b2/timeoff`, { date: TOMORROW, allDay: false, from: '13:00', to: '12:00' })).status, 400);
    const b1 = (await app.client().get('/api/availability?service=s1&barber=b1&days=2')).json.days[1].slots;
    assert.equal(b1.length, 0, 'whole day off');
    const b2 = (await app.client().get('/api/availability?service=s1&barber=b2&days=2')).json.days[1].slots.map((s) => s.time);
    assert.ok(!b2.includes('12:00') && !b2.includes('12:30') && b2.includes('11:30') && b2.includes('13:00'));
    // service edit
    assert.equal((await owner.patch('/api/owner/services/s1', { price: 40, duration: 45 })).status, 200);
    assert.equal((await owner.patch('/api/owner/services/s1', { price: -1 })).status, 400);
    // password change: needs current, kills other sessions
    const second = app.client();
    await second.post('/api/owner/login', { email: 'owner@example.com', password: 'correct horse battery staple' });
    assert.equal((await owner.post('/api/owner/password', { current: 'wrong', next: 'a brand new long password' })).status, 403);
    assert.equal((await owner.post('/api/owner/password', { current: 'correct horse battery staple', next: 'short' })).status, 400);
    assert.equal((await owner.post('/api/owner/password', { current: 'correct horse battery staple', next: 'a brand new long password' })).status, 200);
    assert.equal((await second.get('/api/owner/state')).status, 401, 'other sessions are signed out');
    assert.equal((await owner.get('/api/owner/state')).status, 200, 'this session stays');
    assert.equal((await app.client().post('/api/owner/login', { email: 'owner@example.com', password: 'a brand new long password' })).status, 200);
  } finally { await app.stop(); }
});

test('reminders go out once, about a day ahead, only when there is an email', async () => {
  const app = await startApp();
  try {
    const owner = await app.ownerClient();
    await owner.post('/api/owner/bookings', { barberId: 'b1', serviceId: 's1', date: TOMORROW, time: '09:30', name: 'Remind Me', phone: '(516) 555-5151', email: 'remind@example.com' });
    await owner.post('/api/owner/bookings', { barberId: 'b1', serviceId: 's1', date: TOMORROW, time: '12:00', name: 'No Email', phone: '(516) 555-5252' });
    await owner.post('/api/owner/bookings', { barberId: 'b1', serviceId: 's1', date: '2026-10-05', time: '12:00', name: 'Far Away', phone: '(516) 555-5353', email: 'far@example.com' });
    assert.equal(app.runReminders(), 1);
    assert.equal(app.runReminders(), 0, 'no repeats');
    await app.ctx.mailer.flush();
    const rem = app.fakeMail.sent.filter((m) => /Reminder/.test(m.subject));
    assert.equal(rem.length, 1); assert.equal(rem[0].to[0], 'remind@example.com');
  } finally { await app.stop(); }
});

test('email outbox retries when the mail service is down', async () => {
  const app = await startApp();
  try {
    const owner = await app.ownerClient();
    await owner.patch('/api/owner/settings', { ownerEmail: 'boss@example.com' });
    app.fakeMail.setFail(true);
    await owner.post('/api/owner/test-email', {});
    await app.ctx.mailer.flush();
    assert.equal(app.fakeMail.sent.length, 0);
    assert.equal(app.ctx.mailer.status().pending, 1);
    app.fakeMail.setFail(false);
    await app.ctx.mailer.flush();
    assert.equal(app.fakeMail.sent.length, 1);
    assert.equal(app.ctx.mailer.status().pending, 0);
  } finally { await app.stop(); }
});
