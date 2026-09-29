'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Stripe = require('stripe');
const { createApp } = require('../src/app');

// "10:00 AM Wednesday Sept 30 2026" in New York
const FIXED_NOW = Date.parse('2026-09-30T14:00:00Z');
const TODAY = '2026-09-30';
const TOMORROW = '2026-10-01';

function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))); }

async function startFakeStripe() {
  const sessions = [];
  const refunds = [];
  let refundFail = false;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/v1/checkout/sessions') {
        const params = new URLSearchParams(body);
        const id = 'cs_test_' + (sessions.length + 1);
        sessions.push({ id, params: Object.fromEntries(params.entries()) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id, object: 'checkout.session', url: `https://checkout.stripe.test/pay/${id}` }));
      }
      if (req.method === 'POST' && req.url === '/v1/refunds') {
        const params = Object.fromEntries(new URLSearchParams(body).entries());
        if (refundFail) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Charge has already been refunded.', type: 'invalid_request_error' } })); }
        const id = 're_test_' + (refunds.length + 1);
        refunds.push({ id, idempotencyKey: req.headers['idempotency-key'], ...params });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id, object: 'refund', status: 'succeeded', amount: +params.amount }));
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  });
  const port = await listen(server);
  return { port, sessions, refunds, setRefundFail(v) { refundFail = v; }, close: () => new Promise((r) => server.close(r)) };
}

async function startFakeMail() {
  const sent = [];
  let fail = false;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (fail) { res.writeHead(500); return res.end('{}'); }
      sent.push({ auth: req.headers.authorization, ...JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"id":"1"}');
    });
  });
  const port = await listen(server);
  return { port, sent, setFail(v) { fail = v; }, close: () => new Promise((r) => server.close(r)) };
}

async function startApp(extraEnv = {}, { stripe = true, mail = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-test-'));
  const fs_ = stripe ? await startFakeStripe() : null;
  const fm = mail ? await startFakeMail() : null;
  const env = {
    NODE_ENV: 'test', DATA_DIR: dir, DISABLE_JOBS: '1', SETUP_KEY: 'test-setup-key-1234567890', RATE_LIMITS_OFF: '1',
    ...(stripe ? { STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_testsecret', STRIPE_API_HOST: '127.0.0.1', STRIPE_API_PORT: String(fs_.port), STRIPE_API_PROTOCOL: 'http' } : {}),
    ...(mail ? { MAIL_API_KEY: 'mail_test_key', MAIL_FROM: 'Barberchops <book@example.com>', MAIL_API_URL: `http://127.0.0.1:${fm.port}/emails` } : {}),
    ...extraEnv,
  };
  const built = createApp(env);
  built.clock.setFixed(FIXED_NOW);
  const server = http.createServer(built.app);
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  built.config.baseUrl = base;
  const stripeLib = new Stripe('sk_test_fake');

  function client() {
    const jar = {};
    async function call(method, url, { body, headers = {}, raw, origin = base } = {}) {
      const h = { ...headers };
      if (origin) h.Origin = origin;
      const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookie) h.Cookie = cookie;
      let payload;
      if (raw !== undefined) payload = raw; else if (body !== undefined) { h['Content-Type'] = h['Content-Type'] || 'application/json'; payload = JSON.stringify(body); }
      const res = await fetch(base + url, { method, headers: h, body: payload, redirect: 'manual' });
      for (const sc of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
        const [pair] = sc.split(';'); const i = pair.indexOf('=');
        const name = pair.slice(0, i), val = decodeURIComponent(pair.slice(i + 1));
        if (/Max-Age=0/i.test(sc) || val === '') delete jar[name]; else jar[name] = val;
      }
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, json, text, headers: res.headers };
    }
    return { jar, get: (u, o) => call('GET', u, o), post: (u, body, o) => call('POST', u, { body, ...o }), patch: (u, body, o) => call('PATCH', u, { body, ...o }), put: (u, body, o) => call('PUT', u, { body, ...o }), del: (u, o) => call('DELETE', u, o), call };
  }

  async function ownerClient() {
    const c = client();
    await c.post('/api/setup', { setupKey: env.SETUP_KEY, email: 'owner@example.com', password: 'correct horse battery staple' });
    return c;
  }

  function signedWebhook(event) {
    const payload = JSON.stringify(event);
    const header = stripeLib.webhooks.generateTestHeaderString({ payload, secret: env.STRIPE_WEBHOOK_SECRET });
    return { payload, header };
  }
  async function sendWebhook(c, event, headerOverride) {
    const { payload, header } = signedWebhook(event);
    return c.call('POST', '/webhooks/stripe', { raw: payload, headers: { 'Content-Type': 'application/json', 'Stripe-Signature': headerOverride || header }, origin: null });
  }

  const stop = async () => { await new Promise((r) => server.close(r)); built.close(); if (fs_) await fs_.close(); if (fm) await fm.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { ...built, base, client, ownerClient, sendWebhook, fakeStripe: fs_, fakeMail: fm, stop, env };
}

const paidEvent = (id, bookingId, sessionId, amount = 500) => ({
  id, type: 'checkout.session.completed',
  data: { object: { id: sessionId, object: 'checkout.session', payment_status: 'paid', currency: 'usd', amount_total: amount, payment_intent: 'pi_test_' + id, metadata: { booking_id: bookingId } } },
});

module.exports = { startApp, FIXED_NOW, TODAY, TOMORROW, paidEvent };
