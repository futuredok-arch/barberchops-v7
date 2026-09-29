'use strict';
const express = require('express');
const V = require('../validate');
const sched = require('../schedule');
const { hashSecret, verifySecret, burnTime, sha256, randomId } = require('../security');
const { firstName } = require('../format');
const { isDate, isTime, toMins } = require('../clock');

const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60e3;

// A barber can only ever get: their own schedule, with clients' FIRST NAMES only.
// Phone numbers, emails, last names and notes are never sent by these routes.
module.exports = function staffRoutes(ctx) {
  const { db, auth, clock, limits } = ctx;
  const r = express.Router();
  const pinOk = (pin) => typeof pin === 'string' && /^\d{6}$/.test(pin);

  r.get('/staff/setup-info', limits.login, (req, res) => {
    const token = String(req.query.token || '');
    const b = token.length >= 20 && token.length <= 100 && db.raw.prepare('SELECT name, lang FROM barbers WHERE setup_token_hash = ? AND setup_expires > ? AND active = 1').get(sha256(token), clock.nowMs());
    if (!b) return res.status(404).json({ error: 'This link has expired. Ask the owner for a new one.' });
    res.json({ name: b.name, lang: b.lang });
  });

  r.post('/staff/setup', limits.login, async (req, res, next) => {
    try {
      const { token, pin } = req.body || {};
      if (!pinOk(pin)) throw V.bad('Your PIN must be exactly 6 digits.');
      const t = typeof token === 'string' ? token : '';
      const b = t.length >= 20 && t.length <= 100 && db.raw.prepare('SELECT id FROM barbers WHERE setup_token_hash = ? AND setup_expires > ? AND active = 1').get(sha256(t), clock.nowMs());
      if (!b) throw new V.HttpError(404, 'This link has expired. Ask the owner for a new one.', 'expired');
      const hash = await hashSecret(pin);
      db.raw.prepare('UPDATE barbers SET pin_hash = ?, setup_token_hash = NULL, setup_expires = 0, failed_logins = 0, locked_until = 0 WHERE id = ?').run(hash, b.id);
      auth.destroyAll('barber', b.id);
      auth.createSession(res, 'barber', b.id);
      db.audit(`barber:${b.id}`, 'pin_created', '', req.ip);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.post('/staff/login', limits.login, async (req, res, next) => {
    try {
      const { barberId, pin } = req.body || {};
      const id = typeof barberId === 'string' ? barberId.slice(0, 64) : '';
      const row = db.raw.prepare('SELECT * FROM barbers WHERE id = ? AND active = 1').get(id);
      const fail = () => new V.HttpError(401, 'That PIN is not right.', 'bad_login');
      if (!row || !row.pin_hash || typeof pin !== 'string') { await burnTime(pin); throw fail(); }
      if (row.locked_until > clock.nowMs()) throw new V.HttpError(429, 'Too many wrong tries. Try again in 15 minutes, or ask the owner to reset your login.', 'locked');
      if (!(await verifySecret(pin, row.pin_hash))) {
        const n = row.failed_logins + 1;
        db.raw.prepare('UPDATE barbers SET failed_logins = ?, locked_until = ? WHERE id = ?').run(n >= LOCK_AFTER ? 0 : n, n >= LOCK_AFTER ? clock.nowMs() + LOCK_MS : 0, row.id);
        db.audit(`barber:${row.id}`, 'login_failed', `attempt ${n}`, req.ip);
        throw fail();
      }
      db.raw.prepare('UPDATE barbers SET failed_logins = 0, locked_until = 0 WHERE id = ?').run(row.id);
      auth.createSession(res, 'barber', row.id);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // lets the page ask "am I signed in?" without provoking a 401
  r.get('/staff/session', (req, res) => {
    const s = auth.readSession(req, 'barber');
    res.json({ authed: !!(s && db.raw.prepare('SELECT 1 FROM barbers WHERE id = ? AND active = 1').get(s.subject)) });
  });

  r.post('/staff/logout', (req, res) => { auth.destroySession(req, res, 'barber'); res.json({ ok: true }); });

  r.get('/staff/me', auth.requireBarber, (req, res) => {
    const b = sched.getBarber(db, req.barberId);
    const today = clock.todayISO();
    const appts = db.raw.prepare(`SELECT id,date,time,customer_name,service_id,duration,status FROM bookings WHERE barber_id = ? AND status = 'upcoming' AND date >= ? ORDER BY date,time`).all(b.id, today)
      .map((a) => {
        const svc = db.raw.prepare('SELECT name FROM services WHERE id = ?').get(a.service_id);
        return { id: a.id, date: a.date, time: a.time, firstName: firstName(a.customer_name), service: svc ? svc.name : '', duration: a.duration, status: a.status };
      });
    const timeOff = db.raw.prepare('SELECT id,date,all_day,from_t,to_t FROM timeoff WHERE barber_id = ? AND date >= ? ORDER BY date,from_t').all(b.id, today)
      .map((t) => ({ id: t.id, date: t.date, allDay: !!t.all_day, from: t.from_t, to: t.to_t }));
    res.json({ barber: { id: b.id, name: b.name, title: b.title, lang: b.lang }, today, appointments: appts, timeOff });
  });

  r.post('/staff/appointments/:id/status', auth.requireBarber, (req, res, next) => {
    try {
      const status = V.oneOf((req.body || {}).status, ['completed', 'no-show'], 'status');
      const id = V.cleanId(req.params.id);
      const row = db.raw.prepare('SELECT id FROM bookings WHERE id = ? AND barber_id = ? AND status = ?').get(id, req.barberId, 'upcoming');
      if (!row) throw new V.HttpError(404, 'Appointment not found', 'not_found');
      db.raw.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(status, id);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.post('/staff/timeoff', auth.requireBarber, (req, res, next) => {
    try {
      const b = req.body || {};
      if (!isDate(b.date) || b.date < clock.todayISO()) throw V.bad('Pick a date from today on.');
      const allDay = b.allDay === true;
      let from = null, to = null;
      if (!allDay) {
        if (!isTime(b.from) || !isTime(b.to)) throw V.bad('Enter a start and end time.');
        if (toMins(b.to) <= toMins(b.from)) throw V.bad('The end time must be after the start time.');
        from = b.from; to = b.to;
      }
      const count = db.raw.prepare('SELECT COUNT(*) c FROM timeoff WHERE barber_id = ?').get(req.barberId).c;
      if (count >= 200) throw V.bad('Too many time-off entries. Remove old ones first.');
      const id = randomId(6);
      db.raw.prepare('INSERT INTO timeoff (id,barber_id,date,all_day,from_t,to_t) VALUES (?,?,?,?,?,?)').run(id, req.barberId, b.date, allDay ? 1 : 0, from, to);
      res.json({ ok: true, id });
    } catch (e) { next(e); }
  });
  r.delete('/staff/timeoff/:id', auth.requireBarber, (req, res, next) => {
    try {
      db.raw.prepare('DELETE FROM timeoff WHERE id = ? AND barber_id = ?').run(V.cleanId(req.params.id), req.barberId);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
  r.post('/staff/lang', auth.requireBarber, (req, res, next) => {
    try {
      const lang = V.oneOf((req.body || {}).lang, ['en', 'es'], 'language');
      db.raw.prepare('UPDATE barbers SET lang = ? WHERE id = ?').run(lang, req.barberId);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  return r;
};
