'use strict';
const { randomId, randomToken, sha256 } = require('./security');
const { HttpError, bad } = require('./validate');
const { addDays } = require('./clock');
const sched = require('./schedule');

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
      const session = await payments.createCheckout({ bookings: rows, feeCents: fee, groupId, token, shopName: db.getSetting('name') });
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

  return { createOnline, createManual, finalize, finalizeGroup, groupRows, groupByToken, expireHolds, cancelPending, byToken, bookingRow, feeCents, getService };
}
module.exports = { makeBookings, HOLD_MINUTES, MAX_ITEMS_PER_ORDER };
