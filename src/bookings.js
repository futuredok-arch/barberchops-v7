'use strict';
const { randomId, randomToken, sha256 } = require('./security');
const { HttpError, bad } = require('./validate');
const { addDays } = require('./clock');
const sched = require('./schedule');
const { rowsByManageToken } = require('./manage');

const MAX_ITEMS_PER_ORDER = 6;          // appointments in one checkout (e.g. a parent booking for several kids)
const MAX_PENDING_PER_PHONE = 8;
const MAX_BOOKINGS_PER_PHONE_PER_DAY = 12;
const HOLD_MINUTES = 35; // a bit longer than Stripe's minimum checkout lifetime

function makeBookings({ db, clock, payments, notify, config }) {
  const shopHours = () => db.getSetting('hours');
  const feeCents = () => Math.max(0, Math.round(Number(db.getSetting('bookingFee') || 0) * 100));

  function getService(id) { return db.raw.prepare('SELECT * FROM services WHERE id = ? AND active = 1').get(id); }
  function isBlocked(phoneNorm) { return !!db.raw.prepare('SELECT 1 FROM blocked WHERE phone_norm = ?').get(phoneNorm); }
  function dateOk(date) {
    const today = clock.todayISO();
    return date >= today && date <= addDays(today, sched.MAX_DAYS_AHEAD);
  }

  // reserve a slot right away (so two people can't take it), then send the customer to pay
  const reserve = db.raw.transaction((input, status, holdExpires, tokenHash) => {
    const service = getService(input.serviceId);
    if (!service) throw bad('That service is not available');
    if (!dateOk(input.date)) throw bad('That date is not available');
    if (isBlocked(input.phoneNorm)) throw new HttpError(403, 'We can’t complete online booking with this number. Please call the shop.', 'blocked');
    const now = clock.nowMs();
    const pend = db.raw.prepare(`SELECT COUNT(*) c FROM bookings WHERE phone_norm = ? AND status = 'pending' AND hold_expires > ?`).get(input.phoneNorm, now).c;
    if (pend >= MAX_PENDING_PER_PHONE) throw new HttpError(429, 'You already have appointments waiting for payment. Finish or cancel those first.', 'too_many');
    const dayCount = db.raw.prepare(`SELECT COUNT(*) c FROM bookings WHERE phone_norm = ? AND created_at > ? AND source = 'online' AND status IN ('pending','upcoming')`).get(input.phoneNorm, now - 86400e3).c;
    if (dayCount >= MAX_BOOKINGS_PER_PHONE_PER_DAY && input.source === 'online') throw new HttpError(429, 'Daily booking limit reached for this number. Please call the shop.', 'too_many');

    let barberId = input.barberId;
    if (barberId === 'any' || !barberId) barberId = sched.assignBarber(db, clock, shopHours(), input.date, input.time, service.duration);
    const barber = barberId ? sched.getBarber(db, barberId) : null;
    if (!barber || !barber.active) throw new HttpError(409, 'That time was just taken. Please pick another.', 'slot_taken');
    if (!sched.isSlotFree(db, clock, shopHours(), barber, input.date, input.time, service.duration)) throw new HttpError(409, 'That time was just taken. Please pick another.', 'slot_taken');

    const id = randomId(8);
    db.raw.prepare(`INSERT INTO bookings (id,barber_id,service_id,date,time,duration,customer_name,phone,phone_norm,email,notes,status,fee_cents,fee_paid,token_hash,hold_expires,source,created_at,confirmed_at,group_id,contact_name,service_price)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, barber.id, service.id, input.date, input.time, service.duration, input.name, input.phone, input.phoneNorm, input.email, input.notes,
      status, input.feeCents, 0, tokenHash, holdExpires, input.source || 'online', now, status === 'upcoming' ? now : null, input.groupId || id, input.contactName || input.name, service.price);
    if (input.optIn) db.raw.prepare('INSERT OR REPLACE INTO optins (phone_norm,opted_at,source) VALUES (?,?,?)').run(input.phoneNorm, new Date(now).toISOString(), input.source === 'online' ? 'booking form' : 'owner');
    return { id, barberId: barber.id };
  });

  function bookingRow(id) { return db.raw.prepare('SELECT * FROM bookings WHERE id = ?').get(id); }

  // One checkout can hold up to MAX_ITEMS_PER_ORDER appointments. Every appointment is its own booking
  // with its own booking fee, so the Stripe total is always (number of appointments) x (fee) -- never a flat rate.
  // All appointments are reserved together or not at all.
  // (the order's id is the id of its first appointment)
  const reserveOrder = db.raw.transaction((contact, items, status, hold, tokenHash, fee) => {
    let groupId;
    return items.map((it) => {
      const r = reserve({
        ...contact, serviceId: it.serviceId, barberId: it.barberId, date: it.date, time: it.time,
        name: it.forName || contact.name, contactName: contact.name, feeCents: fee, source: 'online', groupId,
      }, status, hold, tokenHash);
      if (!groupId) groupId = r.id;
      return r;
    });
  });

  async function createOnline(contact, items) {
    if (!Array.isArray(items) || items.length < 1) throw bad('Pick at least one appointment');
    if (items.length > MAX_ITEMS_PER_ORDER) throw bad(`You can book up to ${MAX_ITEMS_PER_ORDER} appointments at once. Please call the shop for larger groups.`);
    const token = randomToken(24);
    const fee = feeCents();
    const needsPay = config.requirePayment && fee > 0;
    if (needsPay && !payments.enabled && config.production) throw new HttpError(503, 'Online payments are not set up yet. Please call the shop to book.', 'payments_off');
    const hold = clock.nowMs() + HOLD_MINUTES * 60e3;
    const reserved = reserveOrder(contact, items, needsPay ? 'pending' : 'upcoming', needsPay ? hold : 0, sha256(token), needsPay ? fee : 0);
    const groupId = reserved[0].id;
    const rows = reserved.map((r) => bookingRow(r.id));
    const totalCents = needsPay ? fee * rows.length : 0;
    if (!needsPay) { notify.orderConfirmed(rows); return { token, status: 'confirmed', count: rows.length, feeTotalCents: 0 }; }
    if (!payments.enabled) return { token, status: 'pending', checkoutUrl: `/dev-pay?t=${encodeURIComponent(token)}`, dev: true, count: rows.length, feeTotalCents: totalCents };
    try {
      const session = await payments.createCheckout({ bookings: rows, feeCents: fee, groupId, token, shopName: db.getSetting('name'), cancelWindowHours: db.getSetting('cancelWindowHours') });
      db.raw.prepare('UPDATE bookings SET stripe_session_id = ? WHERE group_id = ?').run(session.id, groupId);
      return { token, status: 'pending', checkoutUrl: session.url, count: rows.length, feeTotalCents: totalCents };
    } catch (e) {
      db.raw.prepare(`UPDATE bookings SET status = 'expired', hold_expires = 0 WHERE group_id = ?`).run(groupId);
      throw new HttpError(502, 'Payment page could not be created. Please try again in a moment.', 'stripe_error');
    }
  }

  // owner-made booking: no payment step, no phone limits
  function createManual(input) {
    const r = reserve({ ...input, feeCents: input.feeCharged ? feeCents() : 0, source: 'owner' }, 'upcoming', 0, sha256(randomToken(16)));
    if (input.feeCharged) db.raw.prepare('UPDATE bookings SET fee_paid = 1 WHERE id = ?').run(r.id);
    return bookingRow(r.id);
  }

  // called when Stripe confirms payment (or by the dev-pay page in development only)
  const finalize = db.raw.transaction((bookingId, { sessionId, paymentIntent, amountCents } = {}) => {
    const b = bookingRow(bookingId);
    if (!b) return { ok: false, reason: 'unknown_booking' };
    if (b.status === 'upcoming' || b.status === 'completed') return { ok: true, already: true, booking: b };
    if (amountCents !== undefined && amountCents !== b.fee_cents) return { ok: false, reason: 'amount_mismatch' };
    const barber = sched.getBarber(db, b.barber_id);
    // slot must still be free once we ignore this booking itself
    db.raw.prepare(`UPDATE bookings SET status = 'cancelled' WHERE id = ?`).run(b.id);
    const free = barber && barber.active && sched.isSlotFree(db, clock, shopHours(), barber, b.date, b.time, b.duration);
    if (!free && b.date >= clock.todayISO()) {
      db.raw.prepare(`UPDATE bookings SET status = 'cancelled', needs_refund = 1, fee_paid = 1, stripe_payment_intent = ? WHERE id = ?`).run(paymentIntent || null, b.id);
      return { ok: false, reason: 'slot_lost', booking: bookingRow(b.id) };
    }
    db.raw.prepare(`UPDATE bookings SET status = 'upcoming', fee_paid = 1, confirmed_at = ?, stripe_payment_intent = COALESCE(?, stripe_payment_intent), stripe_session_id = COALESCE(?, stripe_session_id) WHERE id = ?`)
      .run(clock.nowMs(), paymentIntent || null, sessionId || null, b.id);
    return { ok: true, booking: bookingRow(b.id) };
  });

  // Stripe says the whole checkout was paid: confirm every appointment in it. The amount must equal
  // (sum of the booking fees), i.e. exactly one fee per appointment.
  const finalizeGroup = db.raw.transaction((groupId, { sessionId, paymentIntent, amountCents } = {}) => {
    const rows = db.raw.prepare('SELECT * FROM bookings WHERE group_id = ? ORDER BY date, time, id').all(groupId);
    if (!rows.length) return { ok: false, reason: 'unknown_booking', results: [] };
    const expected = rows.reduce((n, r) => n + r.fee_cents, 0);
    if (amountCents !== undefined && amountCents !== expected) return { ok: false, reason: 'amount_mismatch', results: [] };
    const results = rows.map((r) => finalize(r.id, { sessionId, paymentIntent }));
    return { ok: true, results };
  });

  function groupRows(groupId) { return db.raw.prepare('SELECT * FROM bookings WHERE group_id = ? ORDER BY date, time, id').all(groupId); }
  function groupByToken(token) {
    const b = byToken(token);
    return b ? groupRows(b.group_id || b.id) : [];
  }

  function expireHolds() {
    return db.raw.prepare(`UPDATE bookings SET status = 'expired' WHERE status = 'pending' AND hold_expires <= ?`).run(clock.nowMs()).changes;
  }
  function cancelPending(token) {
    const b = byToken(token);
    if (b) db.raw.prepare(`UPDATE bookings SET status = 'expired', hold_expires = 0 WHERE group_id = ? AND status = 'pending'`).run(b.group_id || b.id);
    return !!b;
  }
  function byToken(token) {
    if (typeof token !== 'string' || token.length < 10 || token.length > 100) return null;
    return db.raw.prepare('SELECT * FROM bookings WHERE token_hash = ?').get(sha256(token)) || null;
  }

  /* ---------- customer self-service: cancel or reschedule from the link in the email ---------- */
  const windowMs = () => Math.max(0, Number(db.getSetting('cancelWindowHours') || 0)) * 3600e3;
  function policyFor(b) {
    const start = clock.toUtcMs(b.date, b.time), now = clock.nowMs();
    const live = b.status === 'upcoming' && start > now;
    return { live, onTime: live && start - now >= windowMs() };
  }
  const notFound = () => new HttpError(404, 'We couldn’t find that appointment. The link may be old.', 'not_found');
  function manageView(token) {
    const rows = rowsByManageToken(db, token);
    if (!rows.length) return null;
    const svc = new Map(db.raw.prepare('SELECT id,name FROM services').all().map((s) => [s.id, s.name]));
    const bar = new Map(db.raw.prepare('SELECT id,name FROM barbers').all().map((x) => [x.id, x.name]));
    const first = (n) => String(n || '').trim().split(/\s+/)[0] || '';
    const s = db.settings();
    return {
      shop: { name: s.name, phone: s.phone, cancelWindowHours: s.cancelWindowHours, bookingFee: s.bookingFee },
      contactFirstName: first(rows[0].contact_name || rows[0].customer_name),
      appointments: rows.filter((b) => b.status !== 'pending' && b.status !== 'expired').map((b) => {
        const p = policyFor(b);
        return {
          id: b.id, serviceId: b.service_id, service: svc.get(b.service_id) || '', barberId: b.barber_id, barber: bar.get(b.barber_id) || '',
          date: b.date, time: b.time, firstName: first(b.customer_name), status: b.status,
          canCancel: p.live, canReschedule: p.onTime, feePaid: !!b.fee_paid && !b.needs_refund && !b.refunded_at && b.fee_cents > 0, feeCents: b.fee_cents,
        };
      }),
    };
  }
  function ownedAppt(token, id) {
    const rows = rowsByManageToken(db, token);
    const b = rows.find((r) => r.id === id);
    if (!b) throw notFound();
    return b;
  }
  // Cancel one appointment. At least the cancel window ahead: the slot is freed and, if a booking fee was paid, it is flagged
  // for the owner to refund. Inside the window: the slot is still freed but the fee is kept.
  function cancelByCustomer(token, id) {
    const done = db.raw.transaction(() => {
      const b = ownedAppt(token, id);
      const p = policyFor(b);
      if (!p.live) throw new HttpError(409, 'That appointment can’t be changed here anymore. Please call the shop.', 'not_manageable');
      const refund = p.onTime && !!b.fee_paid && b.fee_cents > 0;
      db.raw.prepare(`UPDATE bookings SET status = 'cancelled', needs_refund = ? WHERE id = ? AND status = 'upcoming'`).run(refund ? 1 : 0, b.id);
      return { row: bookingRow(b.id), refund, feeKept: !p.onTime && !!b.fee_paid && b.fee_cents > 0 };
    });
    const r = done();
    notify.appointmentCancelled(r.row, r);
    return { ok: true, refund: r.refund, feeKept: r.feeKept };
  }
  // Move one appointment to a new time with the same barber. Only outside the cancel window. The booking fee travels with it (no new charge).
  function rescheduleByCustomer(token, id, date, time) {
    const done = db.raw.transaction(() => {
      const b = ownedAppt(token, id);
      const p = policyFor(b);
      if (!p.live) throw new HttpError(409, 'That appointment can’t be changed here anymore. Please call the shop.', 'not_manageable');
      if (!p.onTime) throw new HttpError(409, `It’s less than ${db.getSetting('cancelWindowHours')} hours before this appointment. Please call the shop to change it.`, 'too_late');
      if (!dateOk(date)) throw bad('That date is not available');
      if (date === b.date && time === b.time) throw bad('Pick a different time than your current one.');
      const barber = sched.getBarber(db, b.barber_id);
      if (!barber || !barber.active) throw new HttpError(409, 'That barber isn’t available. Please call the shop.', 'slot_taken');
      db.raw.prepare(`UPDATE bookings SET status = 'cancelled' WHERE id = ?`).run(b.id);   // step out of our own way; rolled back if the new slot is taken
      if (!sched.isSlotFree(db, clock, shopHours(), barber, date, time, b.duration)) throw new HttpError(409, 'That time was just taken. Please pick another.', 'slot_taken');
      db.raw.prepare(`UPDATE bookings SET status = 'upcoming', date = ?, time = ?, reminded_at = NULL WHERE id = ?`).run(date, time, b.id);
      return { before: { date: b.date, time: b.time }, row: bookingRow(b.id) };
    });
    const r = done();
    notify.appointmentMoved(r.row, r.before);
    return { ok: true, date: date, time: time };
  }

  // Owner moves a client (barber was sick, no-show, schedule changed too late...). Works for upcoming and no-show appointments.
  // The same booking row moves, so its paid fee goes with it. The new time must be a genuinely free slot for the chosen barber.
  function ownerReschedule(id, { barberId, date, time, emailClient }) {
    const done = db.raw.transaction(() => {
      const b = bookingRow(id);
      if (!b) throw new HttpError(404, 'Appointment not found', 'not_found');
      if (!['upcoming', 'no-show'].includes(b.status)) throw new HttpError(409, 'Only upcoming or no-show appointments can be moved.', 'not_manageable');
      if (!dateOk(date)) throw bad('That date is not available');
      const service = getService(b.service_id) || { duration: b.duration };
      db.raw.prepare(`UPDATE bookings SET status = 'cancelled' WHERE id = ?`).run(b.id);   // step out of our own way; rolled back on any error
      let target = barberId === 'any' || !barberId ? sched.assignBarber(db, clock, shopHours(), date, time, b.duration) : barberId;
      const barber = target ? sched.getBarber(db, target) : null;
      if (!barber || !barber.active || !sched.isSlotFree(db, clock, shopHours(), barber, date, time, b.duration)) throw new HttpError(409, 'That time isn’t free for that barber. Pick another time or barber.', 'slot_taken');
      db.raw.prepare(`UPDATE bookings SET status = 'upcoming', barber_id = ?, date = ?, time = ?, reminded_at = NULL, completed_at = NULL, review_sent_at = NULL WHERE id = ?`).run(barber.id, date, time, b.id);
      return { before: { date: b.date, time: b.time, barberId: b.barber_id }, row: bookingRow(b.id) };
    });
    const r = done();
    if (emailClient) notify.movedByShop(r.row, r.before);
    return { ok: true, date: r.row.date, time: r.row.time, barberId: r.row.barber_id, emailed: !!(emailClient && r.row.email) };
  }

  // Owner presses "Refund" on a paid booking fee: refund exactly that one fee through Stripe.
  async function refundFee(id) {
    const b = bookingRow(id);
    if (!b) throw new HttpError(404, 'Appointment not found', 'not_found');
    if (!b.fee_paid || !(b.fee_cents > 0)) throw new HttpError(409, 'No booking fee was paid for this appointment.', 'nothing_to_refund');
    if (b.refunded_at) throw new HttpError(409, 'This booking fee was already refunded.', 'already_refunded');
    if (!payments.enabled) throw new HttpError(409, 'Stripe isn’t connected here. Refund it in your Stripe dashboard, then press “Already refunded”.', 'stripe_off');
    if (!b.stripe_payment_intent) throw new HttpError(409, 'This payment can’t be matched to Stripe automatically. Refund it in your Stripe dashboard, then press “Already refunded”.', 'no_payment_intent');
    let r;
    try { r = await payments.refund({ paymentIntent: b.stripe_payment_intent, amountCents: b.fee_cents, bookingId: b.id }); }
    catch (e) { throw new HttpError(502, 'Stripe couldn’t refund this: ' + String((e && e.message) || 'unknown error').slice(0, 160), 'stripe_error'); }
    db.raw.prepare('UPDATE bookings SET refunded_at = ?, refund_id = ?, needs_refund = 0 WHERE id = ?').run(clock.nowMs(), r.id, b.id);
    notify.feeRefunded(bookingRow(b.id));
    return { ok: true, refundId: r.id, amountCents: b.fee_cents };
  }

  return { manageView, cancelByCustomer, rescheduleByCustomer, ownerReschedule, refundFee, createOnline, createManual, finalize, finalizeGroup, groupRows, groupByToken, expireHolds, cancelPending, byToken, bookingRow, feeCents, getService };
}
module.exports = { makeBookings, HOLD_MINUTES, MAX_ITEMS_PER_ORDER };
