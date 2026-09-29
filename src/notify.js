'use strict';
const { fmtDateLong, fmtTime } = require('./format');
const { ensureManageToken, manageUrl } = require('./manage');

function makeNotify({ db, mailer, clock, config }) {
  const svc = (id) => db.raw.prepare('SELECT name FROM services WHERE id = ?').get(id);
  const barber = (id) => db.raw.prepare('SELECT name FROM barbers WHERE id = ?').get(id);
  const shop = () => db.settings();

  const money = (cents) => '$' + (cents / 100).toFixed(2);
  const first = (n) => String(n || '').trim().split(/\s+/)[0] || 'there';
  const lineFor = (b, i, many) => `${many ? (i + 1) + '. ' : ''}${b.customer_name} -- ${svc(b.service_id)?.name || ''} with ${barber(b.barber_id)?.name || ''}\n   ${fmtDateLong(b.date)} at ${fmtTime(b.time)}   (Confirmation #${b.id.slice(0, 8).toUpperCase()})`;
  const linkFor = (b) => manageUrl(config, ensureManageToken(db, b));
  const changeText = (s, b, paid) => `CANCEL OR RESCHEDULE: ${linkFor(b)}\nUse this link to move or cancel any of your appointments yourself, up to ${s.cancelWindowHours} hours before it starts. Rescheduling keeps your booking fee with the new time. ` +
    (paid ? `If you cancel at least ${s.cancelWindowHours} hours ahead, your booking fee is refunded. ` : '') +
    `Inside ${s.cancelWindowHours} hours you can still cancel to free the chair, but the booking fee is kept. To change the time that close to your visit, call ${s.phone}.`;
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
        mailer.queue(b0.email, 'Your appointment is confirmed',
          `Hi ${first(contact)},\n\nYour appointment${bs.length > 1 ? 's are' : ' is'} confirmed at ${s.name}.\n\n${listFor(bs)}\n\n${paid.length ? `PAID ONLINE (booking fees): ${money(feeTotal)}\n` : ''}DUE IN STORE (service price, paid at the shop): $${inStore.toFixed(2)}\nTOTAL FOR YOUR VISIT: $${(inStore + feeTotal / 100).toFixed(2)}\n\nWhere: ${s.address}\n\nPlease arrive about 10 minutes early. ` +
          `${paid.length ? `Each appointment has its own ${money(paid[0].fee_cents)} booking fee (${money(feeTotal)} total for ${paid.length} appointment${paid.length > 1 ? 's' : ''}). Each fee holds your spot in line and is non-refundable, except when you cancel at least ${s.cancelWindowHours} hours ahead. It is a separate booking fee and is NOT deducted from your service. You still pay the full price of your service at the shop. ` : ''}\n\n${changeText(s, b0, paid.length > 0)}\n\n— ${s.name}`, 'customer-confirmation');
      }
      db.raw.prepare(`UPDATE bookings SET alerted_at = ? WHERE id IN (${bs.map(() => '?').join(',')})`).run(clock.nowMs(), ...bs.map((b) => b.id));
    },
    bookingConfirmed(b) { return this.orderConfirmed([b]); },
    reminder(b) {
      const s = shop();
      mailer.queue(b.email, `Reminder: your ${s.name} appointment — ${fmtDateLong(b.date)} at ${fmtTime(b.time)}`,
        `Hi ${first(b.contact_name || b.customer_name)},\n\nA quick reminder of ${b.contact_name && b.contact_name !== b.customer_name ? first(b.customer_name) + "'s" : 'your'} appointment.\n\n${lineFor(b, 0, false)}\nWhere: ${s.address}\n\nNeed to change plans?\n${changeText(s, b, !!b.fee_paid)}\n\n— ${s.name}`, 'reminder');
    },
    // Customer cancelled from their link: tell the customer what happens to the fee, and the owner (with a refund to-do when due)
    appointmentCancelled(b, { refund, feeKept }) {
      const s = shop();
      const when = `${fmtDateLong(b.date)} at ${fmtTime(b.time)}`;
      const who = b.contact_name && b.contact_name !== b.customer_name ? `${b.customer_name} (booked by ${b.contact_name})` : b.customer_name;
      if (b.email) {
        mailer.queue(b.email, 'Your appointment is cancelled',
          `Hi ${first(b.contact_name || b.customer_name)},\n\nYour appointment on ${when} at ${s.name} is cancelled.\n\n` +
          (refund ? `Because you cancelled at least ${s.cancelWindowHours} hours ahead, your ${money(b.fee_cents)} booking fee will be refunded to the card you paid with. Refunds usually show up within 5 to 10 business days.\n\n`
            : feeKept ? `Because this was less than ${s.cancelWindowHours} hours before your appointment, the ${money(b.fee_cents)} booking fee is kept.\n\n` : '') +
          `Want another time? Book again any time: ${config.baseUrl}\n\n— ${s.name}`, 'customer-cancelled');
      }
      if (s.ownerEmail) {
        mailer.queue(s.ownerEmail, refund ? `ACTION NEEDED: refund ${money(b.fee_cents)} booking fee — ${b.customer_name} cancelled` : `Cancelled by customer: ${b.customer_name}, ${when}`,
          `A customer cancelled from their link.\n\n${who}\nPhone: ${b.phone}${b.email ? '\nEmail: ' + b.email : ''}\n${when} with ${barber(b.barber_id)?.name || ''}\n\n` +
          (refund ? `They cancelled at least ${s.cancelWindowHours} hours ahead, so their ${money(b.fee_cents)} booking fee is due back. Open your owner dashboard and press Refund on this appointment (it is listed under "Needs refund").`
            : feeKept ? `They cancelled inside ${s.cancelWindowHours} hours, so the ${money(b.fee_cents)} booking fee is kept.` : 'No booking fee was charged for this appointment.'), refund ? 'owner-refund' : 'owner-alert');
      }
    },
    appointmentMoved(b, before) {
      const s = shop();
      const when = `${fmtDateLong(b.date)} at ${fmtTime(b.time)}`, was = `${fmtDateLong(before.date)} at ${fmtTime(before.time)}`;
      if (b.email) {
        mailer.queue(b.email, 'Your appointment is moved',
          `Hi ${first(b.contact_name || b.customer_name)},\n\nDone. Your appointment moved to:\n\n${lineFor(b, 0, false)}\n\n(It was ${was}.) Your booking fee stays with the new time, so there is nothing more to pay online.\n\nWhere: ${s.address}\n\n${changeText(s, b, !!b.fee_paid)}\n\n— ${s.name}`, 'customer-moved');
      }
      if (s.ownerEmail) {
        mailer.queue(s.ownerEmail, `Rescheduled: ${b.customer_name}, now ${when}`,
          `A customer moved an appointment from their link.\n\n${b.customer_name}\nPhone: ${b.phone}\nWas: ${was}\nNow: ${when} with ${barber(b.barber_id)?.name || ''}`, 'owner-alert');
      }
    },
    // The shop moved the client (barber sick, schedule change...). Keeps the tone apologetic and says the fee is safe.
    movedByShop(b, before) {
      const s = shop();
      if (!b.email) return;
      const was = `${fmtDateLong(before.date)} at ${fmtTime(before.time)}`;
      mailer.queue(b.email, `We moved your appointment at ${s.name}`,
        `Hi ${first(b.contact_name || b.customer_name)},\n\nSorry for the change. We had to move your appointment. Here is your new time:\n\n${lineFor(b, 0, false)}\n\n(It was ${was}.)\n\n` +
        `${b.fee_paid ? 'Your booking fee stays with your new time, so there is nothing more to pay online and you do not lose it. ' : ''}You still pay the service price at the shop.\n\nWhere: ${s.address}\n\nDoes the new time not work? ${changeText(s, b, !!b.fee_paid)}\n\nThank you for understanding.\n— ${s.name}`, 'moved-by-shop');
    },
    feeRefunded(b) {
      const s = shop();
      if (!b.email) return;
      mailer.queue(b.email, `Your ${money(b.fee_cents)} booking fee was refunded`,
        `Hi ${first(b.contact_name || b.customer_name)},\n\nWe refunded your ${money(b.fee_cents)} booking fee for the appointment on ${fmtDateLong(b.date)} at ${fmtTime(b.time)}. It usually shows up on your card within 5 to 10 business days.\n\n— ${s.name}`, 'fee-refunded');
    },
    // Sent once, a couple of hours after an appointment is marked completed (see runReviewRequests in app.js)
    reviewRequest(b) {
      const s = shop();
      const url = s.googleReviewUrl;
      if (!b.email || !url) return false;
      const bar = barber(b.barber_id);
      mailer.queue(b.email, `How was your visit at ${s.name}?`,
        `Hi ${first(b.customer_name)},\n\nThanks for coming in to ${s.name}${bar ? ' and sitting with ' + bar.name : ''}. We hope you love the cut!\n\nIf you have a minute, a quick Google review helps other people in Massapequa find us and helps our barbers a lot:\n\n${url}\n\nIf anything wasn't right, just reply to this email or call us at ${s.phone} and we will make it right.\n\nThank you,\n— ${s.name}`, 'review-request');
      return true;
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
