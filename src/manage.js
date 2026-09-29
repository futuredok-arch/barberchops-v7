'use strict';
// "Manage my appointment" links. Each order (one checkout, 1 to 6 appointments) gets one random secret the first time
// it is needed; it goes only into emails to that customer. Whoever holds the link can cancel or reschedule that order's
// appointments (nothing else: no phone numbers, no other customers).
const { randomToken } = require('./security');

function ensureManageToken(db, anyRow) {
  const gid = anyRow.group_id || anyRow.id;
  const have = db.raw.prepare('SELECT manage_token FROM bookings WHERE (group_id = ? OR id = ?) AND manage_token IS NOT NULL LIMIT 1').get(gid, gid);
  if (have && have.manage_token) return have.manage_token;
  const t = randomToken(24);
  db.raw.prepare('UPDATE bookings SET manage_token = ? WHERE group_id = ? OR id = ?').run(t, gid, gid);
  return t;
}
function rowsByManageToken(db, token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return [];
  const one = db.raw.prepare('SELECT * FROM bookings WHERE manage_token = ? LIMIT 1').get(token);
  if (!one) return [];
  const gid = one.group_id || one.id;
  return db.raw.prepare('SELECT * FROM bookings WHERE (group_id = ? OR id = ?) AND manage_token = ? ORDER BY date, time, id').all(gid, gid, token);
}
const manageUrl = (config, token) => `${config.baseUrl}/?manage=${encodeURIComponent(token)}`;
module.exports = { ensureManageToken, rowsByManageToken, manageUrl };
