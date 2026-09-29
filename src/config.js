'use strict';
// All settings come from environment variables so that secrets (Stripe keys, email key,
// setup key) live only on the server and never in code or in the browser.
const path = require('path');

function bool(v, d) { if (v === undefined || v === '') return d; return /^(1|true|yes|on)$/i.test(String(v)); }

function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const production = nodeEnv === 'production';
  // On Render, RENDER_EXTERNAL_URL is the service's own https address, so the first deploy works before a custom domain is set
  const baseUrl = (env.BASE_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/+$/, '');
  return {
    nodeEnv,
    production,
    port: parseInt(env.PORT || '3000', 10),
    baseUrl,
    secureCookies: baseUrl.startsWith('https://'),
    dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data')),
    shopTz: env.SHOP_TZ || 'America/New_York',
    setupKey: env.SETUP_KEY || '',
    allowOwnerReset: bool(env.ALLOW_OWNER_RESET, false),
    trustProxy: env.TRUST_PROXY !== undefined ? parseInt(env.TRUST_PROXY, 10) : (production ? 1 : 0),
    requirePayment: bool(env.REQUIRE_PAYMENT, true),
    stripe: {
      secretKey: env.STRIPE_SECRET_KEY || '',
      webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
      // test hooks: point the Stripe SDK at a fake local server
      host: env.STRIPE_API_HOST || '',
      port: env.STRIPE_API_PORT ? parseInt(env.STRIPE_API_PORT, 10) : 0,
      protocol: env.STRIPE_API_PROTOCOL || '',
    },
    mail: {
      // RESEND_API_KEY is the Resend key; MAIL_API_KEY still works as an older name
      apiKey: env.RESEND_API_KEY || env.MAIL_API_KEY || '',
      // Resend's shared test sender works before your own domain is verified (it can only deliver to your own Resend account email)
      from: env.MAIL_FROM || 'Barberchops <onboarding@resend.dev>',
      apiUrl: env.MAIL_API_URL || 'https://api.resend.com/emails',
    },
    disableJobs: bool(env.DISABLE_JOBS, false),
  };
}

module.exports = { loadConfig };
