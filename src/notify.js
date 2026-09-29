'use strict';
const { fmtDateLong, fmtTime } = require('./format');

function makeNotify({ db, mailer, clock, config }) {
  const svc = (id) => db.raw.prepare('SELECT name FROM services WHERE id = ?').get(id);
  const barber = (id) => db.raw.prepare('SELECT name FROM barbers WHERE id = ?').get(id);
  const shop = () => db.settings();

  const money = (cents) => '$' + (cents / 100).toFixed(2);
  const first = (n) => String(n || '').trim().split(/\s+/)[0] || 'there';
  const lineFor = (b, i, many) => `${many ? (i + 1) + '. ' : ''}${b.customer_name} -- ${svc(b.service_id)?.name || ''} with ${barber(b.barber_id)?.name || ''}\n   ${fmtDateLong(b.date)} at ${fmtTime(b.time)}   (Confirmation #${b.id.slice(0, 8).toUpperCase()})`;
  const listFor = (bs) => bs.map((b, i) => lineFor(b, i, bs.length > 1)).join('\n');

  return {
    // One email to the owner and one to the customer for a whole order (1 or more appointments).
    // Each appointment carries its own booking fee.
    orderConfirmed(bs) {
      if (!bs.length) return;
      const s = shop();
      const b0 = bs[0];
      const contact = b0.contact_name || b0.customer_name;
      const paid = bs.filter((b) => b.fee_paid);
      const feeTotal = paid.reduce((n, b) => n + b.fee_cents, 0);
      const inStore = bs.reduce((n, b) => n + b.service_price, 0);
      const feeLine = paid.length
        ? `Booking fees paid: ${money(feeTotal)} (${paid.length} appointment${paid.length > 1 ? 's' : ''} x ${money(paid[0].fee_cents)})`
        : 'Booking fee paid: no';
      if (s.ownerEmail && b0.source === 'online') {
        mailer.queue(s.ownerEmail, `New booking: ${contact}, ${bs.length > 1 ? bs.length + ' appointments, ' : ''}${fmtDateLong(b0.date)} ${fmtTime(b0.time)}`,
          `New ${s.name} booking\n\nBooked by: ${contact}\nPhone: ${b0.phone}${b0.email ? '\nEmail: ' + b0.email : ''}\n\n${listFor(bs)}\n\n${b0.notes ? 'Notes: ' + b0.notes + '\n' : ''}${feeLine}\nService price due in store: $${inStore.toFixed(2)}`, 'owner-alert');
      }
      if (b0.email) {
        mailer.queue(b0.email, `You're booked at ${s.name} — ${bs.length > 1 ? bs.length + ' appointments' : fmtDateLong(b0.date) + ' at ' + fmtTime(b0.time)}`,
          `Hi ${first(contact)},\n\nYou're booked at ${s.name}.\n\n${listFor(bs)}\n\n${paid.length ? `PAID ONLINE (booking fees): ${money(feeTotal)}\n` : ''}DUE IN STORE (service price, paid at the shop): $${inStore.toFixed(2)}\nTOTAL FOR YOUR VISIT: $${(inStore + feeTotal / 100).toFixed(2)}\n\nWhere: ${s.address}\n\nPlease arrive about 10 minutes early. ` +
          `${paid.length ? `Each appointment has its own ${money(paid[0].fee_cents)} booking fee (${money(feeTotal)} total for ${paid.length} appointment${paid.length > 1 ? 's' : ''}). Each fee holds your spot in line and is non-refundable. It is a separate booking fee and is NOT deducted from your service. You still pay the full price of your service at the shop. ` : ''}To change or cancel, call ${s.phone} at least ${s.cancelWindowHours} hours before your appointment.\n\n— ${s.name}`, 'customer-confirmation');
      }
      db.raw.prepare(`UPDATE bookings SET alerted_at = ? WHERE id IN (${bs.map(() => '?').join(',')})`).run(clock.nowMs(), ...bs.map((b) => b.id));
    },
    bookingConfirmed(b) { return this.orderConfirmed([b]); },
    reminder(b) {
      const s = shop();
      mailer.queue(b.email, `Reminder: your ${s.name} appointment — ${fmtDateLong(b.date)} at ${fmtTime(b.time)}`,
        `Hi ${first(b.contact_name || b.customer_name)},\n\nA quick reminder of ${b.contact_name && b.contact_name !== b.customer_name ? first(b.customer_name) + "'s" : 'your'} appointment.\n\n${lineFor(b, 0, false)}\nWhere: ${s.address}\n\nNeed to change plans? Call ${s.phone} at least ${s.cancelWindowHours} hours ahead to keep your fee.\n\n— ${s.name}`, 'reminder');
    },
    refundNeeded(list) {
      const bs = Array.isArray(list) ? list : [list];
      const s = shop();
      const b0 = bs[0];
      if (s.ownerEmail) mailer.queue(s.ownerEmail, `ACTION NEEDED: refund ${bs.length} booking fee${bs.length > 1 ? 's' : ''} for ${b0.contact_name || b0.customer_name}`,
        `${b0.contact_name || b0.customer_name} (${b0.phone}) paid, but ${bs.length > 1 ? 'these time slots were' : 'this time slot was'} already taken:\n\n${listFor(bs)}\n\nPlease refund ${money(bs.reduce((n, b) => n + b.fee_cents, 0))} in your Stripe Dashboard (${money(bs[0].fee_cents)} per appointment) and contact them.\nStripe payment: ${b0.stripe_payment_intent || 'see Dashboard'}`, 'refund-needed');
    },
    test(to) { mailer.queue(to, 'Barberchops test email', 'If you can read this, booking alerts will reach this inbox.', 'test'); },
  };
}
module.exports = { makeNotify };
