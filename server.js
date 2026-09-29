'use strict';
const { createApp } = require('./src/app');

const built = createApp();
const { app, config } = built;

if (config.production) {
  const problems = [];
  if (!config.baseUrl.startsWith('https://')) problems.push('BASE_URL must start with https:// in production');
  if (!config.setupKey || config.setupKey.length < 16) problems.push('SETUP_KEY must be set to a long random value (16+ characters)');
  if (problems.length) { console.error('Refusing to start:\n - ' + problems.join('\n - ')); process.exit(1); }
  if (config.requirePayment && !config.stripe.secretKey) console.warn('WARNING: STRIPE_SECRET_KEY is not set, so online booking will be refused until it is.');
  if (config.stripe.secretKey && !config.stripe.webhookSecret) console.warn('WARNING: STRIPE_WEBHOOK_SECRET is not set: payments cannot be confirmed.');
  if (!config.mail.apiKey) console.warn('WARNING: MAIL_API_KEY is not set: booking emails will wait in the outbox.');
}

const server = app.listen(config.port, () => console.log(`Barberchops booking listening on :${config.port} (${config.nodeEnv})`));
const shutdown = () => { server.close(() => { built.close(); process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
