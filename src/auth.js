'use strict';
const { randomToken, sha256 } = require('./security');
const { HttpError } = require('./validate');

// Three separate login cookies (owner, barber, TV board) so one can never be used as another.
const ROLES = {
  owner: { cookie: 'bc_owner', absoluteMs: 12 * 3600e3, idleMs: 2 * 3600e3 },
  barber: { cookie: 'bc_staff', absoluteMs: 7 * 86400e3, idleMs: 12 * 3600e3 },
  board: { cookie: 'bc_board', absoluteMs: 30 * 86400e3, idleMs: 30 * 86400e3 },
};

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) { try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore bad cookie */ } }
  }
  return out;
}

function makeAuth({ db, config, clock }) {
  const prefix = config.secureCookies ? '__Host-' : '';
  const cookieName = (role) => prefix + ROLES[role].cookie;

  function setCookie(res, name, value, maxAgeMs) {
    const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
    if (config.secureCookies) parts.push('Secure');
    res.append('Set-Cookie', parts.join('; '));
  }
  function clearCookie(res, name) {
    const parts = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    if (config.secureCookies) parts.push('Secure');
    res.append('Set-Cookie', parts.join('; '));
  }

  function createSession(res, role, subject) {
    const token = randomToken(32);
    const now = clock.nowMs();
    db.raw.prepare('INSERT INTO sessions (id_hash,role,subject,created_at,last_seen,expires_at) VALUES (?,?,?,?,?,?)')
      .run(sha256(token), role, subject || null, now, now, now + ROLES[role].absoluteMs);
    setCookie(res, cookieName(role), token, ROLES[role].absoluteMs);
    return token;
  }

  function readSession(req, role) {
    const token = parseCookies(req.headers.cookie)[cookieName(role)];
    if (!token || token.length > 200) return null;
    const row = db.raw.prepare('SELECT * FROM sessions WHERE id_hash = ? AND role = ?').get(sha256(token), role);
    if (!row) return null;
    const now = clock.nowMs();
    if (row.expires_at <= now || now - row.last_seen > ROLES[role].idleMs) {
      db.raw.prepare('DELETE FROM sessions WHERE id_hash = ?').run(row.id_hash);
      return null;
    }
    if (now - row.last_seen > 60e3) db.raw.prepare('UPDATE sessions SET last_seen = ? WHERE id_hash = ?').run(now, row.id_hash);
    return { subject: row.subject, idHash: row.id_hash };
  }

  function destroySession(req, res, role) {
    const token = parseCookies(req.headers.cookie)[cookieName(role)];
    if (token) db.raw.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256(token));
    clearCookie(res, cookieName(role));
  }
  function destroyAll(role, subject, exceptIdHash) {
    db.raw.prepare('DELETE FROM sessions WHERE role = ? AND (? IS NULL OR subject = ?) AND id_hash != ?').run(role, subject ?? null, subject ?? null, exceptIdHash || '');
  }

  const requireOwner = (req, res, next) => {
    const s = readSession(req, 'owner');
    if (!s) return next(new HttpError(401, 'Please sign in.', 'unauthorized'));
    req.owner = s; next();
  };
  const requireBarber = (req, res, next) => {
    const s = readSession(req, 'barber');
    if (!s) return next(new HttpError(401, 'Please sign in.', 'unauthorized'));
    const b = db.raw.prepare('SELECT id FROM barbers WHERE id = ? AND active = 1').get(s.subject);
    if (!b) return next(new HttpError(401, 'Please sign in.', 'unauthorized'));
    req.barberId = b.id; req.session = s; next();
  };
  const requireBoard = (req, res, next) => {
    const s = readSession(req, 'board');
    if (!s) return next(new HttpError(401, 'Enter the screen PIN.', 'unauthorized'));
    next();
  };

  // Block cross-site form/fetch tricks: browsers always send Origin on cross-site writes.
  const sameOrigin = (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin) {
      const allowed = new Set([config.baseUrl, `${req.protocol}://${req.get('host')}`]);
      if (!allowed.has(origin)) return next(new HttpError(403, 'Blocked: request came from another site.', 'bad_origin'));
    } else {
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none') return next(new HttpError(403, 'Blocked: request came from another site.', 'bad_origin'));
    }
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    const hasBody = (req.headers['content-length'] && req.headers['content-length'] !== '0') || req.headers['transfer-encoding'];
    if (hasBody && !ct.startsWith('application/json') && !ct.startsWith('image/jpeg')) return next(new HttpError(415, 'Send JSON.', 'bad_content_type'));
    next();
  };

  return { createSession, readSession, destroySession, destroyAll, requireOwner, requireBarber, requireBoard, sameOrigin, clearCookie, cookieName, parseCookies };
}

module.exports = { makeAuth, parseCookies, ROLES };
