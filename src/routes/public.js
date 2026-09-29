'use strict';
const express = require('express');
const V = require('../validate');
const sched = require('../schedule');
const { firstName } = require('../format');
const { MAX_ITEMS_PER_ORDER } = require('../bookings');

// Everything here is safe for anyone on the internet to see. No phone numbers, emails,
// last names, PINs or other customers' bookings ever come out of these routes.
module.exports = function publicRoutes(ctx) {
  const { db, clock, bookings, config, payments, limits } = ctx;
  const r = express.Router();

  function photosFor(barberId) {
    const rows = db.raw.prepare('SELECT * FROM photos WHERE barber_id = ? ORDER BY created_at').all(barberId);
    return {
      photo: (rows.find((p) => p.kind === 'profile') || {}).file ? '/uploads/' + rows.find((p) => p.kind === 'profile').file : null,
      gallery: rows.filter((p) => p.kind === 'gallery').map((p) => '/uploads/' + p.file),
    };
  }

  r.get('/public', (req, res) => {
    const s = db.settings();
    res.json({
      today: clock.todayISO(),
      shop: {
        name: s.name, tagline: s.tagline, address: s.address, phone: s.phone, bookingFee: s.bookingFee,
        cancelWindowHours: s.cancelWindowHours, hours: s.hours, marketingPreTick: !!s.marketingPreTick,
        paymentsRequired: config.requirePayment && s.bookingFee > 0,
      },
      services: db.raw.prepare('SELECT id,category,name,duration,price,note FROM services WHERE active = 1 ORDER BY sort').all(),
      barbers: sched.loadBarbers(db).map((b) => ({ id: b.id, name: b.name, title: b.title, lang: b.lang, hasLogin: b.hasPin, ...photosFor(b.id) })),
    });
  });

  r.get('/availability', (req, res, next) => {
    try {
      const service = bookings.getService(V.cleanId(String(req.query.service || ''), 'service'));
      if (!service) throw V.bad('Unknown service');
      const barberQ = String(req.query.barber || 'any');
      const barberId = barberQ === 'any' ? null : V.cleanId(barberQ, 'barber');
      const days = V.cleanInt(String(req.query.days || '14'), { min: 1, max: 30, field: 'days' });
      res.json({ days: sched.availability(db, clock, db.getSetting('hours'), { barberId, duration: service.duration, days }) });
    } catch (e) { next(e); }
  });

  // A checkout holds 1..6 appointments (e.g. a parent booking for several kids). Each appointment is charged
  // its own booking fee. Old single-appointment requests (serviceId/date/time at the top level) still work.
  r.post('/bookings', limits.booking, async (req, res, next) => {
    try {
      const b = req.body || {};
      if (typeof b.website === 'string' && b.website.length) return res.json({ token: 'x'.repeat(32), status: 'pending', checkoutUrl: '/', count: 1, feeTotalCents: 0 }); // bot trap: quietly do nothing
      const { isDate, isTime } = require('../clock');
      const phone = V.cleanPhone(b.phone);
      const contact = {
        name: V.cleanText(b.name, { min: 2, max: 80, field: 'Name' }),
        phone: phone.display, phoneNorm: phone.norm,
        email: V.cleanEmail(b.email),
        notes: V.optText(b.notes, { max: 300, field: 'Notes', allowNewlines: true }),
        optIn: b.optIn === true,
      };
      const raw = Array.isArray(b.appointments) ? b.appointments : [b];
      if (raw.length < 1 || raw.length > MAX_ITEMS_PER_ORDER) throw V.bad(`You can book 1 to ${MAX_ITEMS_PER_ORDER} appointments at once.`);
      const items = raw.map((a) => {
        if (!a || typeof a !== 'object') throw V.bad('That appointment is not valid');
        const it = {
          serviceId: V.cleanId(a.serviceId, 'service'),
          barberId: a.barberId ? V.cleanId(a.barberId, 'barber') : 'any',
          date: V.cleanText(a.date, { min: 10, max: 10, field: 'date' }),
          time: V.cleanText(a.time, { min: 5, max: 5, field: 'time' }),
          forName: V.optText(a.forName, { max: 80, field: 'Name for this appointment' }),
        };
        if (!isDate(it.date) || !isTime(it.time)) throw V.bad('That date or time is not valid');
        return it;
      });
      const out = await bookings.createOnline(contact, items);
      // the opt-in belongs to the contact's phone number, saved once
      if (contact.optIn) db.raw.prepare('INSERT OR REPLACE INTO optins (phone_norm,opted_at,source) VALUES (?,?,?)').run(contact.phoneNorm, new Date(clock.nowMs()).toISOString(), 'booking form');
      res.json(out);
    } catch (e) { next(e); }
  });

  // the customer's own order (found only by the long random token they were given)
  r.get('/bookings/status', (req, res) => {
    const rows = bookings.groupByToken(String(req.query.t || ''));
    if (!rows.length) return res.status(404).json({ error: 'Booking not found' });
    const svcName = new Map(db.raw.prepare('SELECT id,name FROM services').all().map((s) => [s.id, s.name]));
    const barberName = new Map(db.raw.prepare('SELECT id,name FROM barbers').all().map((x) => [x.id, x.name]));
    const appts = rows.map((b) => ({
      service: svcName.get(b.service_id) || '', barber: barberName.get(b.barber_id) || '', date: b.date, time: b.time,
      firstName: firstName(b.customer_name), servicePrice: b.service_price, status: b.status, feePaid: !!b.fee_paid, needsRefund: !!b.needs_refund,
      confirmation: b.id.slice(0, 8).toUpperCase(),
    }));
    const live = rows.filter((b) => ['upcoming', 'completed', 'no-show'].includes(b.status));
    const overall = live.length ? 'upcoming' : rows.every((b) => b.status === 'pending') ? 'pending' : rows.some((b) => b.needs_refund) ? 'cancelled' : rows.every((b) => b.status === 'expired') ? 'expired' : 'cancelled';
    const first = rows[0];
    res.json({
      status: overall, appointments: appts, count: rows.length,
      lost: rows.filter((b) => b.needs_refund).length,
      feeEachCents: first.fee_cents, feePaidCents: rows.filter((b) => b.fee_paid && !b.needs_refund).reduce((n, b) => n + b.fee_cents, 0),
      feeTotalCents: rows.reduce((n, b) => n + b.fee_cents, 0),
      dueInStore: rows.filter((b) => !b.needs_refund && ['pending', 'upcoming', 'completed', 'no-show'].includes(b.status)).reduce((n, b) => n + b.service_price, 0), // dollars, paid at the shop
      feePaid: rows.some((b) => b.fee_paid),
      contactFirstName: firstName(first.contact_name || first.customer_name), emailed: !!first.email,
      // legacy single-appointment fields (first appointment)
      service: appts[0].service, barber: appts[0].barber, date: first.date, time: first.time, firstName: appts[0].firstName,
      confirmation: appts[0].confirmation, feeCents: first.fee_cents,
    });
  });
  /* ---- customer self-service (link in the confirmation email) ---- */
  r.get('/manage', (req, res) => {
    const v = bookings.manageView(String(req.query.m || ''));
    if (!v) return res.status(404).json({ error: 'We couldn’t find that booking. The link may be old.', code: 'not_found' });
    res.json(v);
  });
  r.post('/manage/cancel', limits.booking, (req, res, next) => {
    try {
      const b = req.body || {};
      res.json(bookings.cancelByCustomer(String(b.m || ''), V.cleanId(b.id)));
    } catch (e) { next(e); }
  });
  r.post('/manage/reschedule', limits.booking, (req, res, next) => {
    try {
      const { isDate, isTime } = require('../clock');
      const b = req.body || {};
      if (!isDate(b.date) || !isTime(b.time)) throw V.bad('That date or time is not valid');
      res.json(bookings.rescheduleByCustomer(String(b.m || ''), V.cleanId(b.id), b.date, b.time));
    } catch (e) { next(e); }
  });
  r.post('/bookings/cancel-pending', (req, res) => {
    bookings.cancelPending(String((req.body || {}).t || ''));
    res.json({ ok: true });
  });

  return r;
};
