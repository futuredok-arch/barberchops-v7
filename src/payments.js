'use strict';
const Stripe = require('stripe');
const { fmtDateLong, fmtTime } = require('./format');

// Card and Apple Pay details never touch this server: the customer pays on Stripe's own page.
// This code only asks Stripe to create that page and then listens (with a signature check) for
// Stripe's message that the payment really happened.
function makePayments(config) {
  const enabled = !!config.stripe.secretKey;
  const opts = { maxNetworkRetries: 1, timeout: 20000 };
  if (config.stripe.host) { opts.host = config.stripe.host; opts.port = config.stripe.port; opts.protocol = config.stripe.protocol || 'https'; }
  const stripe = enabled ? new Stripe(config.stripe.secretKey, opts) : null;

  return {
    enabled,
    webhookConfigured: !!config.stripe.webhookSecret,
    // One line item PER appointment, each exactly one booking fee (the service price is never sent to Stripe).
    async createCheckout({ bookings, feeCents, groupId, token, shopName, cancelWindowHours = 12 }) {
      const first = bookings[0];
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: bookings.map((b) => ({
          quantity: 1,
          price_data: {
            currency: 'usd', unit_amount: feeCents,
            product_data: {
              name: `Booking fee — ${fmtDateLong(b.date)} at ${fmtTime(b.time)}${bookings.length > 1 ? ` (${b.customer_name.trim().split(/\s+/)[0]})` : ''}`,
              description: `Booking fee to hold your spot in line. Non-refundable, except when you cancel at least ${cancelWindowHours} hours ahead. NOT deducted from your service: the full price of your service is still paid at the shop.`,
            },
          },
        })),
        metadata: { group_id: groupId },
        client_reference_id: groupId,
        ...(first.email ? { customer_email: first.email } : {}),
        payment_intent_data: { description: `${shopName} booking fee${bookings.length > 1 ? 's' : ''} (${bookings.length} appointment${bookings.length > 1 ? 's' : ''})`, metadata: { group_id: groupId } },
        success_url: `${config.baseUrl}/?pay=success&t=${encodeURIComponent(token)}`,
        cancel_url: `${config.baseUrl}/?pay=cancel&t=${encodeURIComponent(token)}`,
        expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
      });
      return { id: session.id, url: session.url };
    },
    // Refund (part of) a payment. One booking fee at a time; the idempotency key means pressing the button twice can never refund twice.
    async refund({ paymentIntent, amountCents, bookingId }) {
      const r = await stripe.refunds.create(
        { payment_intent: paymentIntent, amount: amountCents, reason: 'requested_by_customer', metadata: { booking_id: bookingId } },
        { idempotencyKey: `refund-${bookingId}` });
      return { id: r.id, status: r.status };
    },
    constructEvent(rawBody, signature) {
      return stripe.webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
    },
  };
}
module.exports = { makePayments };
