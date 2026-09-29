'use strict';
// Small, strict input checks. Everything a visitor sends is treated as hostile:
// wrong types are rejected, lengths are capped, and free text has markup characters removed.

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code || 'bad_request'; }
}
const bad = (msg, code) => new HttpError(400, msg, code);

function cleanText(v, { min = 0, max = 200, field = 'value', allowNewlines = false } = {}) {
  if (typeof v !== 'string') throw bad(`${field} must be text`);
  let s = v.normalize('NFC').replace(allowNewlines ? /[\u0000-\u0009\u000B-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g, ' ');
  s = s.replace(/[<>]/g, '').replace(/[ \t]+/g, ' ').trim();
  if (s.length < min) throw bad(`${field} is required`);
  if (s.length > max) throw bad(`${field} is too long`);
  return s;
}
function optText(v, opts) { if (v === undefined || v === null || v === '') return ''; return cleanText(v, opts); }

function normPhone(p) { return String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); }
function cleanPhone(v) {
  if (typeof v !== 'string') throw bad('Phone number is required');
  const digits = normPhone(v);
  if (digits.length !== 10) throw bad('Enter a 10-digit US phone number');
  return { display: `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`, norm: digits };
}
function cleanEmail(v, required = false) {
  if (v === undefined || v === null || v === '') { if (required) throw bad('Email is required'); return ''; }
  if (typeof v !== 'string') throw bad('Email must be text');
  const s = v.trim().toLowerCase();
  if (s.length > 254 || !/^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/.test(s)) throw bad('That email address does not look right');
  return s;
}
function cleanInt(v, { min, max, field = 'value' }) {
  const n = typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? parseInt(v, 10) : v;
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${field} must be a whole number from ${min} to ${max}`);
  return n;
}
function oneOf(v, list, field = 'value') { if (!list.includes(v)) throw bad(`${field} is not valid`); return v; }
function cleanId(v, field = 'id') { if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) throw bad(`${field} is not valid`); return v; }
// names shown in headings/cards (barbers, services): letters, digits, common punctuation only
function cleanLabel(v, { max = 60, field = 'name' } = {}) {
  const s = cleanText(v, { min: 1, max, field });
  if (/[`\\{}$]/.test(s)) throw bad(`${field} contains characters that are not allowed`);
  return s;
}
function csvSafe(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// A Google review link: blank (feature off) or an https:// web address
function cleanReviewUrl(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (s.length > 300 || /\s/.test(s)) throw bad('That review link is not valid.');
  let u; try { u = new URL(s); } catch { throw bad('That review link is not valid. Paste the full address starting with https://'); }
  if (u.protocol !== 'https:' || !u.hostname.includes('.') || u.username || u.password) throw bad('The review link must be a secure address starting with https://');
  return u.toString();
}
module.exports = { HttpError, bad, cleanReviewUrl, cleanText, optText, normPhone, cleanPhone, cleanEmail, cleanInt, oneOf, cleanId, cleanLabel, csvSafe };
