'use strict';
// Every email goes into an "outbox" table first, then is sent in the background. If the email
// service is down or not set up yet, messages wait in the outbox and are retried; nothing is lost.
function makeMailer({ db, config, clock, log = console }) {
  const configured = () => !!(config.mail.apiKey && config.mail.from);

  function queue(to, subject, body, kind = '') {
    if (!to) return null;
    const clean = (s) => String(s).replace(/[\r\n]+/g, ' ').slice(0, 300);
    const r = db.raw.prepare('INSERT INTO outbox (to_addr,subject,body,kind,created_at) VALUES (?,?,?,?,?)')
      .run(clean(to), clean(subject), String(body).slice(0, 20000), kind, clock.nowMs());
    setImmediate(() => flush().catch(() => {}));
    return r.lastInsertRowid;
  }

  let inflight = null;
  async function flush() {
    if (!configured()) return;
    if (inflight) { await inflight.catch(() => {}); }
    inflight = (async () => {
      const rows = db.raw.prepare('SELECT * FROM outbox WHERE sent_at IS NULL AND attempts < 5 ORDER BY id LIMIT 20').all();
      for (const m of rows) {
        try {
          const res = await fetch(config.mail.apiUrl, {
            method: 'POST',
            headers: { Authorization: `Bearer ${config.mail.apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: config.mail.from, to: [m.to_addr], subject: m.subject, text: m.body }),
            signal: AbortSignal.timeout(15000),
          });
          if (!res.ok) throw new Error(`mail service replied ${res.status}`);
          db.raw.prepare('UPDATE outbox SET sent_at = ?, attempts = attempts + 1, error = NULL WHERE id = ?').run(clock.nowMs(), m.id);
        } catch (e) {
          db.raw.prepare('UPDATE outbox SET attempts = attempts + 1, error = ? WHERE id = ?').run(String(e.message).slice(0, 200), m.id);
        }
      }
    })();
    try { await inflight; } finally { inflight = null; }
  }

  function status() {
    const pending = db.raw.prepare('SELECT COUNT(*) c FROM outbox WHERE sent_at IS NULL AND attempts < 5').get().c;
    const failed = db.raw.prepare('SELECT COUNT(*) c FROM outbox WHERE sent_at IS NULL AND attempts >= 5').get().c;
    return { configured: configured(), pending, failed };
  }
  return { queue, flush, status, configured };
}
module.exports = { makeMailer };
