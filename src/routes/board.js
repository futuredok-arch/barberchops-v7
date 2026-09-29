'use strict';
const express = require('express');
const V = require('../validate');
const sched = require('../schedule');
const { verifySecret, burnTime } = require('../security');
const { publicLabel } = require('../format');

// The shop-TV board. Only ever shows: barber name, time, service, and the customer as
// first name + last initial. No phone, email, notes or full names leave the server here.
module.exports = function boardRoutes(ctx) {
  const { db, auth, clock, limits } = ctx;
  const r = express.Router();
  let globalFails = []; // recent failed PIN tries from anyone; stops many-computer guessing

  r.post('/board/login', limits.login, async (req, res, next) => {
    try {
      const now = clock.nowMs();
      globalFails = globalFails.filter((t) => now - t < 3600e3);
      if (globalFails.length >= 30) throw new V.HttpError(429, 'Too many wrong tries. Try again later.', 'locked');
      const pin = (req.body || {}).pin;
      const hash = db.getSetting('boardPinHash');
      if (!hash || typeof pin !== 'string' || pin.length > 20) { await burnTime(pin); globalFails.push(now); throw new V.HttpError(401, 'That PIN is not right.', 'bad_login'); }
      if (!(await verifySecret(pin, hash))) { globalFails.push(now); db.audit('board', 'pin_failed', '', req.ip); throw new V.HttpError(401, 'That PIN is not right.', 'bad_login'); }
      auth.createSession(res, 'board', null);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
  r.post('/board/logout', (req, res) => { auth.destroySession(req, res, 'board'); res.json({ ok: true }); });
  r.get('/board/session', (req, res) => res.json({ authed: !!auth.readSession(req, 'board'), configured: !!db.getSetting('boardPinHash') }));

  r.get('/board', auth.requireBoard, (req, res) => {
    const now = clock.parts();
    const today = now.date;
    const shopHours = db.getSetting('hours');
    const shopH = sched.shopHoursFor(shopHours, today);
    const barbers = sched.loadBarbers(db).map((b) => {
      const works = sched.works(db, b, today, shopHours);
      const h = works ? sched.hoursFor(b, today, shopHours) : null;
      return {
        id: b.id, name: b.name, offToday: sched.hasDayOff(db, b.id, today), working: works,
        hours: h ? { open: h.open, close: h.close } : null,
        blocked: sched.blockedRanges(db, b.id, today).map((x) => ({ start: x.start, end: x.end })),
      };
    });
    const rows = db.raw.prepare(`SELECT barber_id,time,duration,customer_name,service_id,status FROM bookings WHERE date = ? AND status IN ('upcoming','completed','no-show') ORDER BY time`).all(today);
    const svcName = new Map(db.raw.prepare('SELECT id,name FROM services').all().map((s) => [s.id, s.name]));
    res.json({
      date: today, minutes: now.minutes, shopOpen: shopH ? { open: shopH.open, close: shopH.close } : null, barbers,
      bookings: rows.map((b) => ({ barberId: b.barber_id, time: b.time, duration: b.duration, label: publicLabel(b.customer_name), service: svcName.get(b.service_id) || '', status: b.status })),
    });
  });
  return r;
};
