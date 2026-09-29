'use strict';
// Time helpers. The shop lives in one time zone (America/New_York by default); every
// "today", "open hours" and reminder is computed in that zone on the server, so a
// customer's phone clock or time zone can never change what is bookable.

function makeClock(tz) {
  let fixed = null;
  const clock = {
    tz,
    nowMs() { return fixed !== null ? fixed : Date.now(); },
    setFixed(ms) { fixed = ms; },
    clearFixed() { fixed = null; },
    parts(ms = clock.nowMs()) {
      const f = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      });
      const o = {};
      for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
      return { date: `${o.year}-${o.month}-${o.day}`, hour: +o.hour, minute: +o.minute, minutes: +o.hour * 60 + +o.minute };
    },
    todayISO() { return clock.parts().date; },
    // shop-local date + HH:MM -> UTC milliseconds
    toUtcMs(dateIso, hhmm) {
      const [y, m, d] = dateIso.split('-').map(Number);
      const [hh, mm] = hhmm.split(':').map(Number);
      let guess = Date.UTC(y, m - 1, d, hh, mm);
      for (let i = 0; i < 3; i++) {
        const p = clock.parts(guess);
        const asIfUtc = Date.UTC(+p.date.slice(0, 4), +p.date.slice(5, 7) - 1, +p.date.slice(8, 10), p.hour, p.minute);
        guess += Date.UTC(y, m - 1, d, hh, mm) - asIfUtc;
      }
      return guess;
    },
  };
  return clock;
}

function dowOf(dateIso) { return new Date(dateIso + 'T00:00:00Z').getUTCDay(); }
function addDays(dateIso, n) {
  const d = new Date(dateIso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const pad = (n) => (n < 10 ? '0' + n : '' + n);
const toHHMM = (mins) => pad(Math.floor(mins / 60)) + ':' + pad(mins % 60);
const toMins = (hhmm) => { const [h, m] = hhmm.split(':'); return +h * 60 + +m; };
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z'));
const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

module.exports = { makeClock, dowOf, addDays, toHHMM, toMins, isDate, isTime, pad };
