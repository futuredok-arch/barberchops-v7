'use strict';
const express = require('express');

// Stripe -> this server. The signature check proves the message really came from Stripe;
// without it (or with a wrong one) nothing happens.
module.exports = function stripeRoutes(ctx) {
  const { db, payments, bookings, notify, clock } = ctx;
  const r = express.Router();

  r.post('/webhooks/stripe', express.raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
    if (!payments.enabled || !payments.webhookConfigured) return res.status(503).send('webhook not configured');
    let event;
    try { event = payments.constructEvent(req.body, req.headers['stripe-signature']); }
    catch { return res.status(400).send('bad signature'); }

    const seen = db.raw.prepare('SELECT 1 FROM stripe_events WHERE id = ?').get(event.id);
    if (seen) return res.json({ received: true, duplicate: true });

    try {
      const obj = event.data && event.data.object;
      const groupId = obj && obj.metadata && (obj.metadata.group_id || obj.metadata.booking_id);
      if ((event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') && obj && obj.payment_status === 'paid') {
        const rows = groupId ? bookings.groupRows(String(groupId)) : [];
        // every appointment in the checkout must belong to THIS Stripe session, and the charge must be in dollars
        if (rows.length && rows.every((r) => !r.stripe_session_id || r.stripe_session_id === obj.id) && obj.currency === 'usd') {
          const out = bookings.finalizeGroup(String(groupId), { sessionId: obj.id, paymentIntent: typeof obj.payment_intent === 'string' ? obj.payment_intent : null, amountCents: obj.amount_total });
          if (!out.ok && out.reason === 'amount_mismatch') db.audit('stripe', 'amount_mismatch', `order ${groupId}`);
          if (out.ok) {
            const confirmed = out.results.filter((r) => r.ok && !r.already).map((r) => r.booking);
            const lost = out.results.filter((r) => !r.ok && r.reason === 'slot_lost').map((r) => r.booking);
            if (confirmed.length) notify.orderConfirmed(confirmed);
            if (lost.length) notify.refundNeeded(lost);
          }
        }
      } else if (event.type === 'checkout.session.expired' && groupId) {
        db.raw.prepare(`UPDATE bookings SET status = 'expired', hold_expires = 0 WHERE group_id = ? AND status = 'pending'`).run(String(groupId));
      }
      db.raw.prepare('INSERT OR IGNORE INTO stripe_events (id,created_at) VALUES (?,?)').run(event.id, clock.nowMs());
      res.json({ received: true });
    } catch (e) {
      // not recorded as seen, so Stripe will retry
      res.status(500).send('processing error');
    }
  });
  return r;
};
