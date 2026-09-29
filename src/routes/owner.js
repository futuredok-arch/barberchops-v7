'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const V = require('../validate');
const sched = require('../schedule');
const { hashSecret, verifySecret, burnTime, randomToken, sha256, randomId } = require('../security');
const { isDate, isTime, toMins } = require('../clock');

const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60e3;
const MAX_GALLERY = 8;
const MAX_PHOTO_BYTES = 600 * 1024;

module.exports = function ownerRoutes(ctx) {
  const { db, auth, clock, config, bookings, mailer, notify, payments, limits } = ctx;
  const r = express.Router();
  const audit = (req, action, detail) => db.audit('owner', action, detail, req.ip);
  const ownerRow = () => db.raw.prepare('SELECT * FROM owner_account WHERE id = 1').get();

  /* ---------- first-time setup / sign-in ---------- */
  const keyMatches = (given) => {
    const a = Buffer.from(sha256(String(given || '')), 'hex'), b = Buffer.from(sha256(config.setupKey), 'hex');
    return !!config.setupKey && crypto.timingSafeEqual(a, b);
  };
  r.get('/setup/status', (req, res) => res.json({ needsSetup: !ownerRow(), resetEnabled: config.allowOwnerReset && !!config.setupKey, setupKeyConfigured: !!config.setupKey }));

  r.post('/setup', limits.login, async (req, res, next) => {
    try {
      const b = req.body || {};
      const existing = ownerRow();
      if (existing && !(config.allowOwnerReset && config.setupKey)) throw new V.HttpError(403, 'Setup is already finished.', 'forbidden');
      if (!config.setupKey) throw new V.HttpError(503, 'Setup key is not configured on the server.', 'no_setup_key');
      if (!keyMatches(b.setupKey)) { db.audit('setup', 'bad_setup_key', '', req.ip); throw new V.HttpError(403, 'That setup key is not right.', 'forbidden'); }
      const email = V.cleanEmail(b.email, true);
      const password = typeof b.password === 'string' ? b.password : '';
      if (password.length < 10 || password.length > 200) throw V.bad('Choose a password of at least 10 characters.');
      const hash = await hashSecret(password);
      db.raw.prepare('INSERT INTO owner_account (id,email,pass_hash,created_at) VALUES (1,?,?,?) ON CONFLICT(id) DO UPDATE SET email = excluded.email, pass_hash = excluded.pass_hash, failed_logins = 0, locked_until = 0').run(email, hash, clock.nowMs());
      auth.destroyAll('owner', null);
      if (!db.getSetting('ownerEmail')) db.setSetting('ownerEmail', email);
      db.audit('owner', existing ? 'owner_reset' : 'owner_created', '', req.ip);
      auth.createSession(res, 'owner', 'owner');
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.post('/owner/login', limits.login, async (req, res, next) => {
    try {
      const { email, password } = req.body || {};
      const row = ownerRow();
      const fail = () => new V.HttpError(401, 'Email or password is not right.', 'bad_login');
      if (!row || typeof email !== 'string' || typeof password !== 'string' || password.length > 200) { await burnTime(password); throw fail(); }
      if (row.locked_until > clock.nowMs()) throw new V.HttpError(429, 'Too many wrong tries. Try again in 15 minutes.', 'locked');
      const okEmail = email.trim().toLowerCase() === row.email;
      const okPass = await verifySecret(password, row.pass_hash);
      if (!okEmail || !okPass) {
        const n = row.failed_logins + 1;
        db.raw.prepare('UPDATE owner_account SET failed_logins = ?, locked_until = ? WHERE id = 1').run(n >= LOCK_AFTER ? 0 : n, n >= LOCK_AFTER ? clock.nowMs() + LOCK_MS : 0);
        db.audit('owner', 'login_failed', `attempt ${n}`, req.ip);
        throw fail();
      }
      db.raw.prepare('UPDATE owner_account SET failed_logins = 0, locked_until = 0 WHERE id = 1').run();
      auth.createSession(res, 'owner', 'owner');
      db.audit('owner', 'login', '', req.ip);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
  r.post('/owner/logout', (req, res) => { auth.destroySession(req, res, 'owner'); res.json({ ok: true }); });
  r.get('/owner/session', (req, res) => res.json({ authed: !!auth.readSession(req, 'owner') }));

  // everything below needs the owner's session
  r.use('/owner', auth.requireOwner);

  /* ---------- full state for the dashboard ---------- */
  function customers() {
    const rows = db.raw.prepare(`SELECT phone_norm, COALESCE(NULLIF(contact_name,''), customer_name) AS customer_name, phone, email, date, time, status FROM bookings WHERE status IN ('upcoming','completed','no-show','cancelled') AND source != 'none' ORDER BY date, time`).all();
    const map = new Map();
    for (const b of rows) {
      const c = map.get(b.phone_norm) || { phone: b.phone, name: b.customer_name, email: '', visits: 0, last: '' };
      if (b.status !== 'cancelled') c.visits++; c.name = b.customer_name; c.phone = b.phone; if (b.email) c.email = b.email; c.last = b.date + ' ' + b.time;
      map.set(b.phone_norm, c);
    }
    const opt = new Map(db.raw.prepare('SELECT phone_norm, opted_at FROM optins').all().map((o) => [o.phone_norm, o.opted_at]));
    const blocked = new Set(db.raw.prepare('SELECT phone_norm FROM blocked').all().map((x) => x.phone_norm));
    return [...map.entries()].map(([norm, c]) => ({ ...c, norm, optIn: opt.has(norm), optedAt: opt.get(norm) || null, blocked: blocked.has(norm) })).sort((a, b) => b.last.localeCompare(a.last));
  }

  function barbersFull() {
    return sched.loadBarbers(db, { activeOnly: true }).map((b) => {
      const raw = db.raw.prepare('SELECT setup_expires FROM barbers WHERE id = ?').get(b.id);
      const photos = db.raw.prepare('SELECT * FROM photos WHERE barber_id = ? ORDER BY created_at').all(b.id);
      const prof = photos.find((p) => p.kind === 'profile');
      return {
        ...b, inviteActive: raw.setup_expires > clock.nowMs(),
        photo: prof ? { id: prof.id, url: '/uploads/' + prof.file } : null,
        gallery: photos.filter((p) => p.kind === 'gallery').map((p) => ({ id: p.id, url: '/uploads/' + p.file })),
        timeOff: db.raw.prepare('SELECT id,date,all_day,from_t,to_t FROM timeoff WHERE barber_id = ? AND date >= ? ORDER BY date,from_t').all(b.id, clock.todayISO())
          .map((t) => ({ id: t.id, date: t.date, allDay: !!t.all_day, from: t.from_t, to: t.to_t })),
      };
    });
  }

  r.get('/owner/state', (req, res) => {
    const s = db.settings();
    const today = clock.todayISO();
    const from = new Date(clock.nowMs() - 60 * 86400e3).toISOString().slice(0, 10);
    res.json({
      today,
      shop: {
        name: s.name, tagline: s.tagline, address: s.address, phone: s.phone, bookingFee: s.bookingFee, cancelWindowHours: s.cancelWindowHours,
        hours: s.hours, ownerEmail: s.ownerEmail, marketingPreTick: !!s.marketingPreTick, hasBoardPin: !!s.boardPinHash, remindersEnabled: s.remindersEnabled !== false, googleReviewUrl: s.googleReviewUrl || '',
      },
      barbers: barbersFull(),
      services: db.raw.prepare('SELECT id,category,name,duration,price,note FROM services WHERE active = 1 ORDER BY sort').all(),
      bookings: db.raw.prepare(`SELECT id,barber_id AS barberId,service_id AS serviceId,date,time,duration,customer_name AS customerName,contact_name AS contactName,phone,email,notes,status,fee_paid AS feePaid,fee_cents AS feeCents,refunded_at AS refundedAt,needs_refund AS needsRefund,source FROM bookings WHERE date >= ? AND status IN ('upcoming','completed','no-show','cancelled') ORDER BY date,time`).all(from)
        .map((b) => ({ ...b, feePaid: !!b.feePaid, needsRefund: !!b.needsRefund, refunded: !!b.refundedAt,
          // an upcoming appointment that no longer fits its barber's schedule (day turned off, time blocked, hours changed)
          conflict: b.status === 'upcoming' && b.date >= today ? sched.conflictReason(db, sched.getBarber(db, b.barberId), b.date, b.time, b.duration, db.getSetting('hours')) : null })),
      customers: customers(),
      blocked: db.raw.prepare('SELECT phone_norm AS norm, phone, name FROM blocked ORDER BY blocked_at DESC').all(),
      system: {
        baseUrl: config.baseUrl, email: mailer.status(), requirePayment: config.requirePayment,
        stripe: { enabled: payments.enabled, webhook: payments.webhookConfigured },
      },
      audit: db.raw.prepare('SELECT ts,actor,action,detail,ip FROM audit ORDER BY id DESC LIMIT 30').all(),
    });
  });

  /* ---------- settings ---------- */
  function cleanHours(h) {
    if (!h || typeof h !== 'object') throw V.bad('Hours are not valid');
    const out = {};
    for (let d = 0; d < 7; d++) {
      const v = h[d] ?? h[String(d)];
      if (v === null) { out[d] = null; continue; }
      if (!v || typeof v !== 'object') throw V.bad('Hours are not valid');
      const open = V.cleanInt(v.open, { min: 0, max: 23, field: 'Opening hour' });
      const close = V.cleanInt(v.close, { min: 1, max: 24, field: 'Closing hour' });
      if (close <= open) throw V.bad('Closing time must be after opening time');
      out[d] = { open, close };
    }
    return out;
  }
  r.patch('/owner/settings', (req, res, next) => {
    try {
      const b = req.body || {};
      const set = (k, v) => db.setSetting(k, v);
      if ('name' in b) set('name', V.cleanLabel(b.name, { max: 60, field: 'Shop name' }));
      if ('tagline' in b) set('tagline', V.cleanText(b.tagline, { max: 80, field: 'Tagline' }));
      if ('address' in b) set('address', V.cleanText(b.address, { max: 120, field: 'Address' }));
      if ('phone' in b) set('phone', V.cleanText(b.phone, { max: 30, field: 'Phone' }));
      if ('bookingFee' in b) set('bookingFee', V.cleanInt(b.bookingFee, { min: 0, max: 500, field: 'Booking fee' }));
      if ('cancelWindowHours' in b) set('cancelWindowHours', V.cleanInt(b.cancelWindowHours, { min: 0, max: 168, field: 'Cancel window' }));
      if ('hours' in b) set('hours', cleanHours(b.hours));
      if ('ownerEmail' in b) set('ownerEmail', V.cleanEmail(b.ownerEmail));
      if ('marketingPreTick' in b) set('marketingPreTick', b.marketingPreTick === true);
      if ('remindersEnabled' in b) set('remindersEnabled', b.remindersEnabled === true);
      if ('googleReviewUrl' in b) set('googleReviewUrl', V.cleanReviewUrl(b.googleReviewUrl));
      audit(req, 'settings_changed', Object.keys(b).join(','));
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.post('/owner/password', limits.login, async (req, res, next) => {
    try {
      const { current, next: np } = req.body || {};
      const row = ownerRow();
      if (typeof current !== 'string' || !(await verifySecret(current, row.pass_hash))) throw new V.HttpError(403, 'Your current password is not right.', 'forbidden');
      if (typeof np !== 'string' || np.length < 10 || np.length > 200) throw V.bad('Choose a new password of at least 10 characters.');
      db.raw.prepare('UPDATE owner_account SET pass_hash = ? WHERE id = 1').run(await hashSecret(np));
      auth.destroyAll('owner', null, req.owner.idHash);
      audit(req, 'password_changed');
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.post('/owner/board-pin', async (req, res, next) => {
    try {
      const pin = (req.body || {}).pin;
      if (pin === '' || pin === null) { db.setSetting('boardPinHash', null); auth.destroyAll('board', null); audit(req, 'board_pin_cleared'); return res.json({ ok: true }); }
      if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) throw V.bad('The screen PIN must be exactly 6 digits.');
      db.setSetting('boardPinHash', await hashSecret(pin));
      auth.destroyAll('board', null); // every TV has to sign in again with the new PIN
      audit(req, 'board_pin_changed');
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  /* ---------- barbers ---------- */
  r.post('/owner/barbers', (req, res, next) => {
    try {
      const b = req.body || {};
      const name = V.cleanLabel(b.name, { max: 40, field: 'Name' });
      const title = V.optText(b.title, { max: 80, field: 'Title' }) || 'Master Barber';
      const lang = V.oneOf(b.lang === 'es' ? 'es' : 'en', ['en', 'es']);
      const id = 'b' + randomId(4);
      const sort = (db.raw.prepare('SELECT COALESCE(MAX(sort),0)+1 n FROM barbers').get().n);
      db.raw.prepare('INSERT INTO barbers (id,name,title,lang,sort,created_at) VALUES (?,?,?,?,?,?)').run(id, name, title, lang, sort, clock.nowMs());
      audit(req, 'barber_added', name);
      res.json({ ok: true, id });
    } catch (e) { next(e); }
  });

  function requireBarber(id) {
    const b = db.raw.prepare('SELECT * FROM barbers WHERE id = ? AND active = 1').get(V.cleanId(id));
    if (!b) throw new V.HttpError(404, 'Barber not found', 'not_found');
    return b;
  }
  r.patch('/owner/barbers/:id', (req, res, next) => {
    try {
      const cur = requireBarber(req.params.id);
      const b = req.body || {};
      const u = {};
      if ('name' in b) u.name = V.cleanLabel(b.name, { max: 40, field: 'Name' });
      if ('title' in b) u.title = V.cleanText(b.title, { max: 80, field: 'Title' });
      if ('lang' in b) u.lang = V.oneOf(b.lang, ['en', 'es'], 'language');
      if ('email' in b) u.email = V.cleanEmail(b.email);
      if ('daysOff' in b) {
        if (!Array.isArray(b.daysOff) || b.daysOff.length > 7 || !b.daysOff.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) throw V.bad('Days off are not valid');
        u.days_off = JSON.stringify([...new Set(b.daysOff)]);
      }
      if ('useCustomHours' in b) u.use_custom_hours = b.useCustomHours === true ? 1 : 0;
      if ('hours' in b) u.hours = b.hours === null ? null : JSON.stringify(cleanHours(b.hours));
      const keys = Object.keys(u);
      if (keys.length) db.raw.prepare(`UPDATE barbers SET ${keys.map((k) => k + ' = ?').join(', ')} WHERE id = ?`).run(...keys.map((k) => u[k]), cur.id);
      audit(req, 'barber_changed', `${cur.name}: ${Object.keys(b).join(',')}`);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
  r.delete('/owner/barbers/:id', (req, res, next) => {
    try {
      const cur = requireBarber(req.params.id);
      const upcoming = db.raw.prepare(`SELECT COUNT(*) c FROM bookings WHERE barber_id = ? AND status = 'upcoming' AND date >= ?`).get(cur.id, clock.todayISO()).c;
      db.raw.prepare('UPDATE barbers SET active = 0, pin_hash = NULL, setup_token_hash = NULL, setup_expires = 0 WHERE id = ?').run(cur.id);
      auth.destroyAll('barber', cur.id);
      audit(req, 'barber_removed', cur.name);
      res.json({ ok: true, upcomingBookings: upcoming });
    } catch (e) { next(e); }
  });
  r.post('/owner/barbers/:id/invite', async (req, res, next) => {
    try {
      const cur = requireBarber(req.params.id);
      const token = randomToken(32);
      const reset = (req.body || {}).reset === true;
      db.raw.prepare('UPDATE barbers SET setup_token_hash = ?, setup_expires = ?, failed_logins = 0, locked_until = 0' + (reset ? ', pin_hash = NULL' : '') + ' WHERE id = ?')
        .run(sha256(token), clock.nowMs() + 7 * 86400e3, cur.id);
      if (reset) auth.destroyAll('barber', cur.id);
      const url = `${config.baseUrl}/?staff=${token}`;
      let emailed = false;
      if ((req.body || {}).sendEmail === true && cur.email) {
        mailer.queue(cur.email, 'Your Barberchops sign-in link',
          `Hi ${cur.name},\n\nHere is your personal link to set up your login and see your appointments:\n${url}\n\nIt works for 7 days and only once. You'll choose a 6-digit PIN the first time.\n\n— Barberchops`, 'staff-invite');
        emailed = true;
      }
      audit(req, reset ? 'barber_login_reset' : 'barber_invite', cur.name);
      res.json({ ok: true, url, emailed, expiresInDays: 7 });
    } catch (e) { next(e); }
  });

  /* ---------- time off ---------- */
  r.post('/owner/barbers/:id/timeoff', (req, res, next) => {
    try {
      const cur = requireBarber(req.params.id);
      const b = req.body || {};
      if (!isDate(b.date) || b.date < clock.todayISO()) throw V.bad('Pick a date from today on.');
      const allDay = b.allDay === true;
      let from = null, to = null;
      if (!allDay) {
        if (!isTime(b.from) || !isTime(b.to)) throw V.bad('Enter a start and end time.');
        if (toMins(b.to) <= toMins(b.from)) throw V.bad('The end time must be after the start time.');
        from = b.from; to = b.to;
      }
      const id = randomId(6);
      db.raw.prepare('INSERT INTO timeoff (id,barber_id,date,all_day,from_t,to_t) VALUES (?,?,?,?,?,?)').run(id, cur.id, b.date, allDay ? 1 : 0, from, to);
      res.json({ ok: true, id });
    } catch (e) { next(e); }
  });
  r.delete('/owner/timeoff/:id', (req, res, next) => {
    try { db.raw.prepare('DELETE FROM timeoff WHERE id = ?').run(V.cleanId(req.params.id)); res.json({ ok: true }); } catch (e) { next(e); }
  });

  /* ---------- services ---------- */
  r.patch('/owner/services/:id', (req, res, next) => {
    try {
      const id = V.cleanId(req.params.id);
      const cur = db.raw.prepare('SELECT * FROM services WHERE id = ? AND active = 1').get(id);
      if (!cur) throw new V.HttpError(404, 'Service not found', 'not_found');
      const b = req.body || {};
      const duration = 'duration' in b ? V.cleanInt(b.duration, { min: 5, max: 240, field: 'Minutes' }) : cur.duration;
      const price = 'price' in b ? V.cleanInt(b.price, { min: 0, max: 1000, field: 'Price' }) : cur.price;
      db.raw.prepare('UPDATE services SET duration = ?, price = ? WHERE id = ?').run(duration, price, id);
      audit(req, 'service_changed', cur.name);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  /* ---------- bookings ---------- */
  r.post('/owner/bookings', (req, res, next) => {
    try {
      const b = req.body || {};
      const phone = V.cleanPhone(b.phone);
      if (!isDate(b.date) || !isTime(b.time)) throw V.bad('Pick a date and time.');
      const booking = bookings.createManual({
        serviceId: V.cleanId(b.serviceId, 'service'), barberId: V.cleanId(b.barberId, 'barber'), date: b.date, time: b.time,
        name: V.cleanText(b.name, { min: 2, max: 80, field: 'Name' }), phone: phone.display, phoneNorm: phone.norm,
        email: V.cleanEmail(b.email), notes: V.optText(b.notes, { max: 300, field: 'Notes' }), optIn: b.optIn === true, feeCharged: b.feeCharged !== false,
      });
      res.json({ ok: true, id: booking.id });
    } catch (e) { next(e); }
  });
  r.post('/owner/bookings/:id/status', (req, res, next) => {
    try {
      const status = V.oneOf((req.body || {}).status, ['completed', 'no-show', 'cancelled'], 'status');
      const id = V.cleanId(req.params.id);
      const info = db.raw.prepare(`UPDATE bookings SET status = ?, completed_at = ? WHERE id = ? AND status IN ('upcoming')`).run(status, status === 'completed' ? clock.nowMs() : null, id);
      if (!info.changes) throw new V.HttpError(404, 'Appointment not found or already closed', 'not_found');
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
  r.post('/owner/bookings/:id/refund-done', (req, res, next) => {
    try {
      const id = V.cleanId(req.params.id);
      db.raw.prepare(`UPDATE bookings SET needs_refund = 0, refunded_at = COALESCE(refunded_at, ?), refund_id = COALESCE(refund_id, 'manual') WHERE id = ?`).run(clock.nowMs(), id);
      audit(req, 'refund_marked_done', id); res.json({ ok: true });
    } catch (e) { next(e); }
  });
  // Move a client to another time (and/or barber). The booking fee travels with the appointment: the client never pays again or loses it.
  r.post('/owner/bookings/:id/reschedule', (req, res, next) => {
    try {
      const b = req.body || {};
      if (!isDate(b.date) || !isTime(b.time)) throw V.bad('That date or time is not valid');
      const barberId = b.barberId && b.barberId !== 'any' ? V.cleanId(b.barberId, 'barber') : 'any';
      const out = bookings.ownerReschedule(V.cleanId(req.params.id), { barberId, date: b.date, time: b.time, emailClient: b.emailClient !== false });
      audit(req, 'appointment_moved', `${req.params.id} -> ${b.date} ${b.time} ${out.barberId}`);
      res.json(out);
    } catch (e) { next(e); }
  });
  // Refund one booking fee through Stripe (needs a Stripe key that is allowed to write Refunds)
  r.post('/owner/bookings/:id/refund', async (req, res, next) => {
    try {
      const id = V.cleanId(req.params.id);
      const out = await bookings.refundFee(id);
      audit(req, 'fee_refunded', `${id} $${(out.amountCents / 100).toFixed(2)} ${out.refundId}`);
      res.json(out);
    } catch (e) { next(e); }
  });

  /* ---------- blocked numbers + text opt-ins ---------- */
  r.post('/owner/blocked', (req, res, next) => {
    try {
      const phone = V.cleanPhone((req.body || {}).phone);
      db.raw.prepare('INSERT OR REPLACE INTO blocked (phone_norm,phone,name,blocked_at) VALUES (?,?,?,?)').run(phone.norm, phone.display, V.optText((req.body || {}).name, { max: 80, field: 'Name' }), clock.nowMs());
      audit(req, 'number_blocked', phone.display);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
  r.delete('/owner/blocked/:norm', (req, res, next) => {
    try { db.raw.prepare('DELETE FROM blocked WHERE phone_norm = ?').run(V.cleanText(req.params.norm, { min: 10, max: 10, field: 'phone' })); res.json({ ok: true }); } catch (e) { next(e); }
  });
  r.put('/owner/optin', (req, res, next) => {
    try {
      const b = req.body || {};
      const norm = V.normPhone(b.phone);
      if (norm.length !== 10) throw V.bad('Phone number is not valid');
      if (b.optIn === true) db.raw.prepare('INSERT OR REPLACE INTO optins (phone_norm,opted_at,source) VALUES (?,?,?)').run(norm, new Date(clock.nowMs()).toISOString(), 'owner ticked');
      else db.raw.prepare('DELETE FROM optins WHERE phone_norm = ?').run(norm);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  /* ---------- photos ---------- */
  r.post('/owner/barbers/:id/photos', express.raw({ type: 'image/jpeg', limit: MAX_PHOTO_BYTES }), (req, res, next) => {
    try {
      const cur = requireBarber(req.params.id);
      const kind = V.oneOf(String(req.query.kind || ''), ['profile', 'gallery'], 'kind');
      const buf = req.body;
      if (!Buffer.isBuffer(buf) || buf.length < 500) throw V.bad('No image received');
      if (!(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) throw V.bad('Photos must be JPEG images');
      if (kind === 'gallery' && db.raw.prepare(`SELECT COUNT(*) c FROM photos WHERE barber_id = ? AND kind = 'gallery'`).get(cur.id).c >= MAX_GALLERY) throw V.bad(`The showcase holds up to ${MAX_GALLERY} photos.`);
      const file = randomId(12) + '.jpg';
      fs.writeFileSync(path.join(config.dataDir, 'uploads', file), buf, { mode: 0o600 });
      const id = randomId(6);
      const tx = db.raw.transaction(() => {
        if (kind === 'profile') {
          for (const old of db.raw.prepare(`SELECT * FROM photos WHERE barber_id = ? AND kind = 'profile'`).all(cur.id)) {
            db.raw.prepare('DELETE FROM photos WHERE id = ?').run(old.id);
            fs.rmSync(path.join(config.dataDir, 'uploads', old.file), { force: true });
          }
        }
        db.raw.prepare('INSERT INTO photos (id,barber_id,kind,file,created_at) VALUES (?,?,?,?,?)').run(id, cur.id, kind, file, clock.nowMs());
      });
      tx();
      res.json({ ok: true, id, url: '/uploads/' + file });
    } catch (e) { next(e); }
  });
  r.delete('/owner/photos/:id', (req, res, next) => {
    try {
      const p = db.raw.prepare('SELECT * FROM photos WHERE id = ?').get(V.cleanId(req.params.id));
      if (p) { db.raw.prepare('DELETE FROM photos WHERE id = ?').run(p.id); fs.rmSync(path.join(config.dataDir, 'uploads', p.file), { force: true }); }
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  /* ---------- exports (audited) ---------- */
  r.get('/owner/customers.csv', (req, res) => {
    const includeAll = req.query.all === '1';
    const rows = customers().filter((c) => !c.blocked && (includeAll || c.optIn));
    const lines = [['First Name', 'Last Name', 'Phone', 'Email', 'Opted In (Texts & Email)', 'Opted In At', 'Visits'].join(',')];
    for (const c of rows) {
      const parts = c.name.trim().split(/\s+/);
      // phone is digits only (10-digit US) so Textedly imports it cleanly and it can never be read as a formula
      lines.push([V.csvSafe(parts[0]), V.csvSafe(parts.slice(1).join(' ')), c.norm, V.csvSafe(c.email), c.optIn ? 'Yes' : 'No', c.optedAt || '', c.visits].join(','));
    }
    audit(req, 'customers_exported', `${rows.length} contacts${includeAll ? ' (all)' : ''}`);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="barberchops-contacts.csv"', 'Cache-Control': 'no-store' });
    res.send(lines.join('\r\n'));
  });
  r.get('/owner/export.json', (req, res) => {
    audit(req, 'full_export');
    const tables = ['barbers', 'services', 'bookings', 'optins', 'blocked', 'timeoff'];
    const out = { exportedAt: new Date(clock.nowMs()).toISOString(), settings: { ...db.settings(), boardPinHash: undefined } };
    for (const t of tables) out[t] = db.raw.prepare(`SELECT * FROM ${t}`).all().map((row) => { const c = { ...row }; delete c.pin_hash; delete c.setup_token_hash; delete c.token_hash; return c; });
    res.set({ 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="barberchops-backup.json"', 'Cache-Control': 'no-store' });
    res.send(JSON.stringify(out, null, 2));
  });

  r.post('/owner/test-email', (req, res, next) => {
    try {
      const to = db.getSetting('ownerEmail');
      if (!to) throw V.bad('Add your email address first.');
      notify.test(to);
      res.json({ ok: true, configured: mailer.configured() });
    } catch (e) { next(e); }
  });

  return r;
};
