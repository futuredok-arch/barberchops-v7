'use strict';
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { loadConfig } = require('./config');
const { makeClock } = require('./clock');
const { openDb } = require('./db');
const { makeAuth } = require('./auth');
const { makeMailer } = require('./mailer');
const { makePayments } = require('./payments');
const { makeNotify } = require('./notify');
const { makeBookings } = require('./bookings');
const { HttpError } = require('./validate');
const { toMins } = require('./clock');

function createApp(envOverrides = {}) {
  const config = loadConfig({ ...process.env, ...envOverrides });
  const clock = makeClock(config.shopTz);
  const db = openDb(config.dataDir);
  const auth = makeAuth({ db, config, clock });
  const mailer = makeMailer({ db, config, clock });
  const payments = makePayments(config);
  const notify = makeNotify({ db, mailer, clock, config });
  const bookings = makeBookings({ db, clock, payments, notify, config });

  const mk = (windowMs, max, message) => rateLimit({
    windowMs, max, standardHeaders: true, legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: message || 'Too many requests. Please slow down.', code: 'rate_limited' }),
    // tests can turn limits off; production never does
    skip: () => envOverrides.RATE_LIMITS_OFF === '1' && !config.production,
  });
  const limits = {
    general: mk(15 * 60e3, 600),
    login: mk(15 * 60e3, 15, 'Too many sign-in attempts. Try again in a few minutes.'),
    booking: mk(60 * 60e3, 20, 'Too many booking attempts. Please try again later or call the shop.'),
  };

  const ctx = { config, clock, db, auth, mailer, payments, notify, bookings, limits };
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
        'img-src': ["'self'", 'data:'],
        'connect-src': ["'self'"],
        'frame-ancestors': ["'self'"],
        'form-action': ["'self'"],
        'base-uri': ["'self'"],
        'object-src': ["'none'"],
        ...(config.secureCookies ? { 'upgrade-insecure-requests': [] } : {}),
      },
    },
    hsts: config.secureCookies ? { maxAge: 31536000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  }));
  app.use((req, res, next) => { res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(self)'); next(); });

  app.get('/healthz', (req, res) => { res.set('Cache-Control', 'no-store'); res.type('text').send('ok'); });

  // Stripe's server talks to us here (needs the raw body for the signature check, so it comes before JSON parsing)
  app.use(require('./routes/stripe')(ctx));

  app.use(express.json({ limit: '30kb' }));

  // development-only fake payment page (never available in production or when real Stripe keys are set)
  if (!config.production) {
    app.get('/dev-pay', (req, res) => {
      if (payments.enabled) return res.status(404).end();
      const b = bookings.byToken(String(req.query.t || ''));
      if (!b) return res.status(404).send('unknown booking');
      const rows = bookings.groupRows(b.group_id || b.id);
      const out = bookings.finalizeGroup(b.group_id || b.id, { amountCents: rows.reduce((n, r) => n + r.fee_cents, 0) });
      if (out.ok) {
        const confirmed = out.results.filter((r) => r.ok && !r.already).map((r) => r.booking);
        const lost = out.results.filter((r) => !r.ok && r.reason === 'slot_lost').map((r) => r.booking);
        if (confirmed.length) notify.orderConfirmed(confirmed);
        if (lost.length) notify.refundNeeded(lost);
      }
      res.redirect(`/?pay=success&t=${encodeURIComponent(String(req.query.t))}`);
    });
  }

  const api = express.Router();
  api.use(limits.general);
  api.use(auth.sameOrigin);
  api.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  api.use(require('./routes/public')(ctx));
  api.use(require('./routes/staff')(ctx));
  api.use(require('./routes/board')(ctx));
  api.use(require('./routes/owner')(ctx));
  api.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use('/api', api);

  // uploaded barber photos are public by design; served with a fixed image type
  app.use('/uploads', express.static(path.join(config.dataDir, 'uploads'), {
    index: false, dotfiles: 'deny', maxAge: '1h',
    setHeaders: (res) => { res.set('X-Content-Type-Options', 'nosniff'); res.set('Content-Type', 'image/jpeg'); },
  }));
  app.use(express.static(path.join(__dirname, '..', 'public'), {
    index: 'index.html', dotfiles: 'deny',
    setHeaders: (res, file) => { res.set('Cache-Control', file.endsWith('.html') ? 'no-cache' : 'public, max-age=300'); },
  }));

  // any other page (e.g. /?staff=...) is the app itself
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That upload is too large.', code: 'too_large' });
    if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) return res.status(400).json({ error: 'Bad request.', code: 'bad_json' });
    console.error('Unhandled error:', err && err.stack || err);
    res.status(500).json({ error: 'Something went wrong on our side.', code: 'server_error' });
  });

  /* ---------- background jobs ---------- */
  function runReminders() {
    if (db.getSetting('remindersEnabled') === false) return 0;
    const now = clock.nowMs();
    const rows = db.raw.prepare(`SELECT * FROM bookings WHERE status = 'upcoming' AND email != '' AND reminded_at IS NULL AND date >= ? AND date <= ?`)
      .all(clock.parts(now).date, clock.parts(now + 36 * 3600e3).date);
    let n = 0;
    for (const b of rows) {
      const start = clock.toUtcMs(b.date, b.time);
      if (start - now <= 24 * 3600e3 && start - now >= 60 * 60e3) { notify.reminder(b); db.raw.prepare('UPDATE bookings SET reminded_at = ? WHERE id = ?').run(now, b.id); n++; }
    }
    return n;
  }
  // One review request per completed appointment: sent 2 to 72 hours after it was marked completed, only between
  // 9 AM and 8 PM shop time, only when a Google review link is set, and never more than one per customer email every 30 days.
  const REVIEW_DELAY_MS = 2 * 3600e3, REVIEW_MAX_AGE_MS = 72 * 3600e3, REVIEW_GAP_MS = 30 * 86400e3;
  function runReviewRequests() {
    const url = db.getSetting('googleReviewUrl');
    if (!url) return 0;
    const now = clock.nowMs();
    const hour = clock.parts(now).minutes / 60;
    if (hour < 9 || hour >= 20) return 0;
    const rows = db.raw.prepare(`SELECT * FROM bookings WHERE status = 'completed' AND email != '' AND review_sent_at IS NULL AND completed_at IS NOT NULL AND completed_at <= ? AND completed_at >= ? ORDER BY completed_at`)
      .all(now - REVIEW_DELAY_MS, now - REVIEW_MAX_AGE_MS);
    let n = 0;
    for (const b of rows) {
      const recent = db.raw.prepare('SELECT 1 FROM bookings WHERE lower(email) = lower(?) AND review_sent_at IS NOT NULL AND review_sent_at > ?').get(b.email, now - REVIEW_GAP_MS);
      if (!recent && notify.reviewRequest(b)) n++;
      db.raw.prepare('UPDATE bookings SET review_sent_at = ? WHERE id = ?').run(now, b.id);   // mark either way so we never retry or send late
    }
    return n;
  }
  function housekeeping() {
    bookings.expireHolds();
    db.raw.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(clock.nowMs());
    db.raw.prepare('DELETE FROM stripe_events WHERE created_at < ?').run(clock.nowMs() - 30 * 86400e3);
    db.raw.prepare('DELETE FROM audit WHERE ts < ?').run(clock.nowMs() - 365 * 86400e3);
    mailer.flush().catch(() => {});
  }
  const timers = [];
  if (!config.disableJobs) {
    timers.push(setInterval(() => { try { housekeeping(); } catch (e) { console.error('housekeeping', e.message); } }, 60e3));
    timers.push(setInterval(() => { try { runReminders(); } catch (e) { console.error('reminders', e.message); } }, 10 * 60e3));
    timers.push(setInterval(() => { try { runReviewRequests(); } catch (e) { console.error('review requests', e.message); } }, 10 * 60e3));
    timers.forEach((t) => t.unref());
  }

  return { app, ctx, config, db, clock, runReminders, runReviewRequests, housekeeping, close() { timers.forEach(clearInterval); db.close(); } };
}

module.exports = { createApp };
