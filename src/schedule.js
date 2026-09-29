'use strict';
// Who is free when. This is the single source of truth for availability; the browser never
// decides. Times are shop-local "HH:MM" strings.
const { dowOf, addDays, toHHMM, toMins } = require('./clock');

const LEAD_MINUTES = 30;     // can't book a slot that starts in less than 30 minutes
const MAX_DAYS_AHEAD = 60;

function rowToBarber(r) {
  return {
    id: r.id, name: r.name, title: r.title, lang: r.lang, email: r.email,
    daysOff: JSON.parse(r.days_off || '[]'), useCustomHours: !!r.use_custom_hours,
    hours: r.hours ? JSON.parse(r.hours) : null, active: !!r.active, sort: r.sort, hasPin: !!r.pin_hash,
  };
}
function loadBarbers(db, { activeOnly = true } = {}) {
  const rows = db.raw.prepare(`SELECT * FROM barbers ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY sort, created_at`).all();
  return rows.map(rowToBarber);
}
function getBarber(db, id) {
  const r = db.raw.prepare('SELECT * FROM barbers WHERE id = ?').get(id);
  return r ? rowToBarber(r) : null;
}
function timeoffFor(db, barberId, date) {
  return db.raw.prepare('SELECT * FROM timeoff WHERE barber_id = ? AND date = ?').all(barberId, date);
}
function hasDayOff(db, barberId, date) { return timeoffFor(db, barberId, date).some((t) => t.all_day); }
function blockedRanges(db, barberId, date) {
  return timeoffFor(db, barberId, date).filter((t) => !t.all_day && t.from_t && t.to_t)
    .map((t) => ({ start: toMins(t.from_t), end: toMins(t.to_t) }));
}
function shopHoursFor(shopHours, date) { return (shopHours || {})[dowOf(date)] || null; }
function hoursFor(barber, date, shopHours) {
  if (barber.useCustomHours && barber.hours && barber.hours[dowOf(date)]) return barber.hours[dowOf(date)];
  return shopHoursFor(shopHours, date);
}
function works(db, barber, date, shopHours) {
  return !!shopHoursFor(shopHours, date) && !barber.daysOff.includes(dowOf(date)) && !hasDayOff(db, barber.id, date);
}
function busyRanges(db, clock, barberId, date) {
  const rows = db.raw.prepare(
    `SELECT time, duration FROM bookings WHERE barber_id = ? AND date = ?
     AND (status IN ('upcoming','completed') OR (status = 'pending' AND hold_expires > ?))`
  ).all(barberId, date, clock.nowMs());
  return rows.map((r) => ({ start: toMins(r.time), end: toMins(r.time) + r.duration }));
}
function slotsFor(db, clock, shopHours, barber, date, duration) {
  if (!barber || !works(db, barber, date, shopHours)) return [];
  const hrs = hoursFor(barber, date, shopHours);
  if (!hrs) return [];
  const now = clock.parts();
  const isToday = date === now.date;
  if (date < now.date) return [];
  const busy = busyRanges(db, clock, barber.id, date).concat(blockedRanges(db, barber.id, date));
  const out = [];
  for (let m = hrs.open * 60; m + duration <= hrs.close * 60; m += 30) {
    if (isToday && m <= now.minutes + LEAD_MINUTES) continue;
    if (busy.some((b) => m < b.end && m + duration > b.start)) continue;
    out.push(toHHMM(m));
  }
  return out;
}
function isSlotFree(db, clock, shopHours, barber, date, time, duration) {
  return slotsFor(db, clock, shopHours, barber, date, duration).includes(time);
}
function bookingsCountOn(db, barberId, date) {
  return db.raw.prepare(`SELECT COUNT(*) c FROM bookings WHERE barber_id = ? AND date = ? AND status IN ('upcoming','completed')`).get(barberId, date).c;
}
// "no preference": give the slot to the free barber with the lightest day so far
function assignBarber(db, clock, shopHours, date, time, duration) {
  const free = loadBarbers(db).filter((b) => isSlotFree(db, clock, shopHours, b, date, time, duration));
  if (!free.length) return null;
  free.sort((a, b) => bookingsCountOn(db, a.id, date) - bookingsCountOn(db, b.id, date) || a.sort - b.sort);
  return free[0].id;
}
// next N days: for each date the list of bookable start times (with the barber who would get it)
function availability(db, clock, shopHours, { barberId, duration, days = 14 }) {
  const today = clock.todayISO();
  const barbers = barberId ? [getBarber(db, barberId)].filter((b) => b && b.active) : loadBarbers(db);
  const out = [];
  for (let i = 0; i < Math.min(days, MAX_DAYS_AHEAD); i++) {
    const date = addDays(today, i);
    const byTime = new Map();
    for (const b of barbers) {
      for (const t of slotsFor(db, clock, shopHours, b, date, duration)) {
        if (!byTime.has(t)) byTime.set(t, []);
        byTime.get(t).push(b);
      }
    }
    const slots = [...byTime.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([time, list]) => {
      if (barberId) return { time, barberId };
      list.sort((a, b) => bookingsCountOn(db, a.id, date) - bookingsCountOn(db, b.id, date) || a.sort - b.sort);
      return { time, barberId: list[0].id };
    });
    out.push({ date, slots });
  }
  return out;
}

module.exports = { loadBarbers, getBarber, slotsFor, isSlotFree, assignBarber, availability, hasDayOff, blockedRanges, hoursFor, works, shopHoursFor, timeoffFor, MAX_DAYS_AHEAD, LEAD_MINUTES };
