/* Barberchops front end — vanilla JS, no framework, no inline handlers (strict CSP).
   Every piece of data comes from the server API; nothing about customers, bookings or PINs is kept in browser storage. */
(function () {
  'use strict';

  var $app = document.getElementById('app');

  /* =====================================================================
     helpers: escaping, formatting, dates (shop-local ISO strings, never the browser clock)
     ===================================================================== */
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  // uploaded photos are only ever served from /uploads/<file>
  function safeImg(u) { return (typeof u === 'string' && /^\/uploads\/[A-Za-z0-9._-]+$/.test(u)) ? u : ''; }
  function safeTel(p) { return String(p || '').replace(/[^\d+]/g, ''); }
  function safeCheckoutUrl(u) { return typeof u === 'string' && (/^\/(?!\/)[^\s]*$/.test(u) || /^https:\/\/[^\s/]+[^\s]*$/.test(u)); }
  function initials(name) { return String(name || '').trim().split(/\s+/).map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase(); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtMoney(n) { n = Number(n) || 0; return '$' + (n % 1 === 0 ? String(n) : n.toFixed(2)); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  var DOW_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var DOW_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  var MON_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var MON_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  var DOW3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function isoParts(iso) { var p = String(iso).split('-'); return { y: +p[0], m: +p[1], d: +p[2] }; }
  function dowOf(iso) { var p = isoParts(iso); return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay(); }
  function addDaysISO(iso, n) { var p = isoParts(iso); return new Date(Date.UTC(p.y, p.m - 1, p.d + n)).toISOString().slice(0, 10); }
  function fmtDateLong(iso, lang) {
    var p = isoParts(iso), dw = dowOf(iso);
    return lang === 'es' ? DOW_ES[dw] + ', ' + p.d + ' de ' + MON_ES[p.m - 1] : DOW_EN[dw] + ', ' + MON_EN[p.m - 1] + ' ' + p.d;
  }
  function fmtDateShort(iso, lang) {
    var p = isoParts(iso), dw = dowOf(iso);
    return lang === 'es' ? DOW_ES[dw].slice(0, 3) + ', ' + p.d + ' ' + MON_ES[p.m - 1].slice(0, 3) : DOW3[dw] + ', ' + MON_EN[p.m - 1].slice(0, 3) + ' ' + p.d;
  }
  function fmtTime(hhmm, lang) {
    var p = String(hhmm).split(':'), h = parseInt(p[0], 10), m = p[1], h12 = h % 12 || 12, pm = h >= 12;
    return lang === 'es' ? h12 + ':' + m + ' ' + (pm ? 'p. m.' : 'a. m.') : h12 + ':' + m + ' ' + (pm ? 'PM' : 'AM');
  }
  function minToHHMM(mins) { mins = Math.max(0, Math.min(1439, mins)); return pad(Math.floor(mins / 60)) + ':' + pad(mins % 60); }
  function hhmmToMin(t) { var p = String(t).split(':'); return parseInt(p[0], 10) * 60 + parseInt(p[1], 10); }
  function fmtHourLong(h) { h = +h; if (h === 24 || h === 0) return '12 AM'; if (h === 12) return '12 PM'; return h < 12 ? h + ' AM' : (h - 12) + ' PM'; }
  function fmtHourShort(h) { h = +h; if (h === 24 || h === 0) return '12am'; if (h === 12) return '12pm'; return h < 12 ? h + 'am' : (h - 12) + 'pm'; }
  // shop hours {0..6:{open,close}|null} -> "Mon–Sat 9am–7pm · Sun 9am–4pm" (lines)
  function hoursLines(hours) {
    var order = [1, 2, 3, 4, 5, 6, 0], out = [], cur = null;
    order.forEach(function (d) {
      var h = (hours || {})[d], key = h ? h.open + '-' + h.close : 'closed';
      if (cur && cur.key === key) { cur.to = d; } else { cur = { key: key, from: d, to: d, h: h }; out.push(cur); }
    });
    return out.map(function (g) {
      var label = g.from === g.to ? DOW_EN[g.from] : DOW3[g.from] + '–' + DOW3[g.to];
      return { label: label, text: g.h ? fmtHourShort(g.h.open) + '–' + fmtHourShort(g.h.close) : 'Closed' };
    });
  }
  function fmtStamp(ms) {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
    } catch (e) { return ''; }
  }

  /* =====================================================================
     server calls
     ===================================================================== */
  var NET_MSG = 'We couldn’t reach the shop’s server. Please check your connection and try again.';
  function errMsg(r, fallback) {
    if (r && r.data && r.data.error) return r.data.error;
    return fallback || 'Something went wrong. Please try again.';
  }
  // role: 'owner' | 'staff' | 'board' — a 401 on a signed-in call sends that role back to its sign-in screen
  function api(method, url, body, o) {
    o = o || {};
    var init = { method: method, credentials: 'same-origin', cache: 'no-store', headers: {} };
    if (o.raw !== undefined) { init.body = o.raw; init.headers['Content-Type'] = o.type || 'image/jpeg'; }
    else if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = null;
    if (ctl) { init.signal = ctl.signal; timer = setTimeout(function () { ctl.abort(); }, o.timeout || 25000); }
    return fetch(url, init).then(function (res) {
      return res.text().then(function (txt) {
        var data = {}; try { data = txt ? JSON.parse(txt) : {}; } catch (e) { data = {}; }
        var r = { ok: res.ok, status: res.status, data: data };
        if (res.status === 401 && o.role && !o.noAuth) onUnauthorized(o.role);
        return r;
      });
    }, function () {
      return { ok: false, status: 0, data: { error: NET_MSG, code: 'network' } };
    }).then(function (r) { if (timer) clearTimeout(timer); return r; });
  }

  /* =====================================================================
     state
     ===================================================================== */
  var F = {};                       // in-memory form drafts (never persisted)
  function fv(key, def) { return F[key] === undefined ? (def === undefined ? '' : def) : F[key]; }
  function fid(key) { return 'f_' + String(key).replace(/\W/g, '_'); }

  var S = {
    route: 'home', pub: null, pubErr: '', lightbox: null, scrollTop: false,
    wiz: freshWiz(), pay: null,
    staff: { phase: 'loading', me: null, token: '', info: null, pickId: null, lang: 'en', err: '', msg: '', offAllDay: true, offErr: '' },
    board: { phase: 'loading', data: null, fetchedAt: 0, err: '', stale: false, lockAsk: false, configured: true },
    owner: { phase: 'loading', st: null, tab: 'today', date: '', err: '', msg: '', fl: {}, ask: '', manage: '', invites: {}, setupInfo: null, na: { avail: null, key: '', loading: false }, custQuery: '' }
  };
  var timers = { poll: null, tick: null, own: null };
  function clearTimers() {
    if (timers.poll) { clearTimeout(timers.poll); clearInterval(timers.poll); timers.poll = null; }
    if (timers.tick) { clearInterval(timers.tick); timers.tick = null; }
    if (timers.own) { clearInterval(timers.own); timers.own = null; }
  }
  function freshWiz() {
    return { started: false, step: 'barber', barberId: null, serviceId: null, date: null, time: null, slotBarberId: null,
      avail: null, availKey: '', availLoading: false, availErr: '', availSeq: 0, err: '', errs: {}, busy: false, redirecting: false, done: null,
      cart: [], nextId: 1, draftId: null, draftAt: null, lastToken: '' };
  }

  /* =====================================================================
     render core
     ===================================================================== */
  function curLang() {
    if (S.route === 'staff') {
      if (S.staff.phase === 'schedule' && S.staff.me) return S.staff.me.barber.lang === 'es' ? 'es' : 'en';
      return S.staff.lang === 'es' ? 'es' : 'en';
    }
    return 'en';
  }
  function shopName() { return (S.pub && S.pub.shop && S.pub.shop.name) || 'Barberchops'; }

  function topbar() {
    var right = '';
    if (S.route === 'home') {
      right = S.wiz.started ? '' : '<button class="btn btn-primary btn-sm" data-action="start-booking">Book now</button>';
    } else {
      right = '<button class="btn-text" data-action="go-home">&larr; Back to site</button>';
    }
    return '<div class="topbar"><a class="brand" href="/" data-action="go-home" aria-label="' + esc(shopName()) + ' — home">' +
      '<svg class="brand-logo" viewBox="0 0 7201 1971" role="img" aria-label="' + esc(shopName()) + '"><use href="#brand-logo"></use></svg></a>' +
      '<div class="topbar-actions">' + right + '</div></div>';
  }

  function render() {
    var route = S.route;
    var ae = document.activeElement, focusId = null, selStart = null, selEnd = null;
    if (ae && ae.id && $app.contains(ae)) {
      focusId = ae.id;
      try { selStart = ae.selectionStart; selEnd = ae.selectionEnd; } catch (e) { selStart = null; }
    }
    var gate = route === 'board' && S.board.phase !== 'live';
    document.body.classList.toggle('board-mode', route === 'board');
    document.body.classList.toggle('board-gate', gate);
    document.body.classList.toggle('owner-mode', route === 'owner' && S.owner.phase === 'dash');
    var html;
    if (route === 'board' && S.board.phase === 'live') html = viewBoardLive();
    else {
      html = topbar();
      if (route === 'home') html += viewHome();
      else if (route === 'pay') html += viewPay();
      else if (route === 'manage') html += viewManage();
      else if (route === 'staff') html += viewStaff();
      else if (route === 'board') html += viewBoardGate();
      else if (route === 'owner') html += viewOwner();
    }
    $app.innerHTML = html + lightboxHtml();
    document.documentElement.lang = curLang();
    document.title = pageTitle();
    if (S.scrollTop) { S.scrollTop = false; try { window.scrollTo(0, 0); } catch (e) { /* ignore */ } }
    if (focusId) {
      var el = document.getElementById(focusId);
      if (el) {
        try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
        if (selStart != null) { try { el.setSelectionRange(selStart, selEnd); } catch (e) { /* not a text field */ } }
      }
    }
  }
  function pageTitle() {
    var n = shopName();
    if (S.route === 'manage') return 'Your appointments · ' + n;
    if (S.route === 'staff') return 'Team · ' + n;
    if (S.route === 'board') return 'Shop screen · ' + n;
    if (S.route === 'owner') return 'Owner · ' + n;
    return n + ' — Book online';
  }
  // re-render only if the user is not in the middle of typing
  function renderIfIdle() {
    var ae = document.activeElement;
    if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && $app.contains(ae)) return false;
    render(); return true;
  }

  /* ---------- shared bits of markup ---------- */
  function svgLock() { return '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="15.5" r="1.4" fill="currentColor"/></svg>'; }
  function svgCheck() { return '<svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12.5 9.5 18 20 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'; }
  function spinner(cls) { return '<span class="spinner ' + (cls || '') + '" aria-hidden="true"></span>'; }
  function notice(kind, html) { return '<div class="notice' + (kind ? ' notice-' + kind : '') + '" role="' + (kind === 'error' ? 'alert' : 'status') + '">' + html + '</div>'; }
  function avatarHtml(name, url, extraClass) {
    var p = safeImg(url);
    return '<div class="pick-avatar' + (p ? ' has-photo' : '') + (extraClass ? ' ' + extraClass : '') + '">' +
      (p ? '<img src="' + esc(p) + '" alt="' + esc(name) + '">' : esc(initials(name))) + '</div>';
  }
  // labelled text input backed by the in-memory draft store
  function inp(key, o) {
    o = o || {};
    var id = fid(key), type = o.type || 'text';
    var val = fv(key, o.def === undefined ? '' : o.def);
    return '<div class="field"' + (o.style ? ' style="' + esc(o.style) + '"' : '') + '><label for="' + id + '">' + esc(o.label) + '</label>' +
      (type === 'textarea'
        ? '<textarea id="' + id + '" data-f="' + esc(key) + '" rows="' + (o.rows || 2) + '" placeholder="' + esc(o.ph || '') + '" maxlength="' + (o.max || 300) + '"' + (o.attrs ? ' ' + o.attrs : '') + '>' + esc(val) + '</textarea>'
        : '<input id="' + id + '" type="' + type + '" data-f="' + esc(key) + '" value="' + esc(val) + '" placeholder="' + esc(o.ph || '') + '"' + (o.attrs ? ' ' + o.attrs : '') + '>') +
      (o.hint ? '<div class="hint">' + esc(o.hint) + '</div>' : '') +
      (o.err ? '<div class="field-error" role="alert">' + esc(o.err) + '</div>' : '') + '</div>';
  }
  function checkbox(key, html, def, extra) {
    return '<label class="check-row"><input type="checkbox" id="' + fid(key) + '" data-f="' + esc(key) + '"' + (fv(key, def) ? ' checked' : '') + (extra ? ' ' + extra : '') + '><span>' + html + '</span></label>';
  }
  function pinInp(key, label, o) {
    o = o || {};
    return '<div class="field"><label for="' + fid(key) + '">' + esc(label) + '</label><input class="pin-input" id="' + fid(key) + '" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="' + (o.ac || 'off') + '" data-f="' + esc(key) + '" data-digits="1" value="' + esc(fv(key)) + '" placeholder="••••••"' + (o.autofocus ? ' autofocus' : '') + '>' +
      (o.err ? '<div class="field-error" role="alert">' + esc(o.err) + '</div>' : '') + '</div>';
  }
  function selectHtml(key, options, def, extra) {
    var cur = String(fv(key, def));
    return '<select id="' + fid(key) + '" data-f="' + esc(key) + '"' + (extra ? ' ' + extra : '') + '>' +
      options.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === cur ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>';
  }

  /* =====================================================================
     events: one delegated listener per event type; handlers live in A (actions)
     ===================================================================== */
  var A = {};                        // data-action handlers
  var SUBMIT = {};                   // form data-submit handlers
  var locks = {};

  function runGuarded(key, els, fn) {
    if (locks[key]) return;
    var out; try { out = fn(); } catch (e) { console.error(e); return; }
    if (out && typeof out.then === 'function') {
      locks[key] = true;
      els.forEach(function (el) { el.disabled = true; el.setAttribute('aria-busy', 'true'); });
      var done = function () {
        delete locks[key];
        els.forEach(function (el) { if (el.isConnected) { el.disabled = false; el.removeAttribute('aria-busy'); } });
      };
      out.then(done, function (e) { console.error(e); done(); });
    }
  }
  $app.addEventListener('click', function (ev) {
    var el = ev.target.closest('[data-action]');
    if (!el || !$app.contains(el)) return;
    var name = el.getAttribute('data-action'), fn = A[name];
    if (!fn) return;
    if (el.tagName === 'A' && !el.hasAttribute('download')) ev.preventDefault();
    if (el.disabled) return;
    runGuarded(name + ':' + (el.getAttribute('data-id') || el.getAttribute('data-k') || ''), [el], function () { return fn(el, ev); });
  });
  $app.addEventListener('submit', function (ev) {
    var form = ev.target.closest('form[data-submit]');
    if (!form) return;
    ev.preventDefault();
    var name = form.getAttribute('data-submit'), fn = SUBMIT[name];
    if (!fn) return;
    var btns = Array.prototype.slice.call(form.querySelectorAll('button[type="submit"]'));
    runGuarded('submit:' + name + ':' + (form.getAttribute('data-id') || ''), btns, function () { return fn(form, ev); });
  });
  $app.addEventListener('input', function (ev) {
    var el = ev.target, f = el.getAttribute && el.getAttribute('data-f');
    if (!f) return;
    if (el.getAttribute('data-digits') && /\D/.test(el.value)) el.value = el.value.replace(/\D/g, '');
    F[f] = el.type === 'checkbox' ? el.checked : el.value;
    if (f.indexOf('w.') === 0 && S.wiz.errs[f.slice(2)]) {       // clear a field's error as soon as the customer edits it
      delete S.wiz.errs[f.slice(2)];
      var er = el.parentNode && el.parentNode.querySelector('.field-error'); if (er) er.remove();
    }
    if (el.getAttribute('data-live')) render();
  });
  $app.addEventListener('change', function (ev) {
    var el = ev.target, f = el.getAttribute && el.getAttribute('data-f');
    if (f) F[f] = el.type === 'checkbox' ? el.checked : el.value;
    var hook = el.getAttribute && el.getAttribute('data-change');
    if (hook && A[hook]) runGuarded('change:' + hook, [], function () { return A[hook](el); });
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && S.lightbox) { S.lightbox = null; render(); }
  });

  /* ---------- lightbox (showcase photos) ---------- */
  function lightboxHtml() {
    var lb = S.lightbox; if (!lb || !S.pub) return '';
    var b = S.pub.barbers.filter(function (x) { return x.id === lb.id; })[0]; if (!b) return '';
    var g = (b.gallery || []).map(safeImg).filter(Boolean); if (!g.length) return '';
    var i = ((lb.idx % g.length) + g.length) % g.length;
    return '<div class="lightbox" data-action="close-photo" role="dialog" aria-modal="true" aria-label="' + esc(b.name) + '’s work"><div class="lightbox-inner">' +
      '<img src="' + esc(g[i]) + '" alt="' + esc(b.name) + '’s work, photo ' + (i + 1) + ' of ' + g.length + '">' +
      '<div class="lightbox-bar"><span>' + esc(b.name) + ' &middot; ' + (i + 1) + ' / ' + g.length + '</span>' +
      (g.length > 1 ? '<span><button class="btn-text" data-action="photo-nav" data-k="-1">&larr; Prev</button> <button class="btn-text" data-action="photo-nav" data-k="1">Next &rarr;</button></span>' : '') +
      '<button class="btn-text" data-action="close-photo" id="lb-close">Close</button></div></div></div>';
  }
  A['open-photo'] = function (el) { S.lightbox = { id: el.getAttribute('data-id'), idx: parseInt(el.getAttribute('data-idx') || '0', 10) }; render(); var c = document.getElementById('lb-close'); if (c) c.focus(); };
  A['close-photo'] = function (el, ev) {
    if (ev && ev.target !== el && el.classList.contains('lightbox')) return;   // clicks on the image/bar don't close it
    S.lightbox = null; render();
  };
  A['photo-nav'] = function (el, ev) { if (ev) ev.stopPropagation(); if (S.lightbox) { S.lightbox.idx += parseInt(el.getAttribute('data-k'), 10); render(); } };

  /* ---------- 401 handling ---------- */
  function onUnauthorized(role) {
    if (role === 'owner') {
      S.owner.phase = 'login'; S.owner.st = null; S.owner.msg = 'Your session ended. Please sign in again.';
      if (timers.own) { clearInterval(timers.own); timers.own = null; }
      if (S.route === 'owner') render();
    } else if (role === 'staff') {
      S.staff.phase = 'login'; S.staff.me = null; S.staff.msg = 'Your session ended. Please sign in again.';
      if (S.route === 'staff') render();
    } else if (role === 'board') {
      S.board.phase = 'gate'; S.board.err = 'This screen was locked. Enter the PIN again.';
      if (timers.poll) { clearInterval(timers.poll); timers.poll = null; }
      if (timers.tick) { clearInterval(timers.tick); timers.tick = null; }
      if (S.route === 'board') render();
    }
  }

  /* =====================================================================
     CUSTOMER: landing page
     ===================================================================== */
  function loadPublic() {
    return api('GET', '/api/public').then(function (r) {
      if (r.ok && r.data && r.data.shop) { S.pub = r.data; S.pubErr = ''; }
      else S.pubErr = errMsg(r, NET_MSG);
      return r;
    });
  }
  A['retry-public'] = function () { S.pubErr = ''; render(); return loadPublic().then(function () { render(); }); };

  function feeOn() { return !!(S.pub && S.pub.shop.paymentsRequired); }

  function viewHome() {
    if (!S.pub) {
      if (S.pubErr) return '<div class="center-stage">' + notice('error', esc(S.pubErr)) + '<button class="btn btn-primary" data-action="retry-public">Try again</button></div>';
      return '<div class="center-stage">' + spinner('spinner-lg') + '<p class="step-hint">Loading…</p></div>';
    }
    return S.wiz.started ? viewWizard() : viewLanding();
  }

  function viewLanding() {
    var shop = S.pub.shop, fee = fmtMoney(shop.bookingFee), on = feeOn();
    var hl = hoursLines(shop.hours);
    var hoursText = hl.map(function (l) { return esc(l.label) + ' ' + esc(l.text); }).join(' &middot; ');
    var daysOpen = 0; for (var d = 0; d < 7; d++) if ((shop.hours || {})[d]) daysOpen++;
    var nB = S.pub.barbers.length;

    var hero = '<section class="hero"><div>' +
      '<div class="eyebrow">Now booking online</div>' +
      '<h1>Skip the wait.<br>Not the chair.</h1>' +
      '<p class="hero-sub">Your time matters to us. So we made it official: you can now book ahead and know exactly when you’ll sit down &mdash; no more crossed fingers in the waiting chair.</p>' +
      '<div class="hero-facts">' +
        '<div class="hero-fact"><b>Walk-ins</b> always welcome, no fee</div>' +
        (on ? '<div class="hero-fact"><b>Service</b> paid in full at the shop</div>' : '') +
        (on ? '<div class="hero-fact"><b>' + esc(fee) + '</b> booking fee per appointment holds your spot in line</div>' +
              '<div class="hero-fact"><b>' + esc(shop.cancelWindowHours) + 'h</b> free cancellation window</div>' : '<div class="hero-fact"><b>Free</b> to reserve your time</div>') +
      '</div>' +
      '<div class="hero-cta"><button class="btn btn-primary" data-action="start-booking">Book &amp; skip the wait</button></div>' +
      '</div>' +
      '<div class="ticket-card">' +
        '<h3>' + (on ? 'Why the fee?' : 'How it works') + '</h3>' +
        '<div class="ticket-row"><span>Walk-in</span><span class="amt">Free &mdash; first come, first served</span></div>' +
        (on ? '<div class="ticket-row"><span>Reserved time</span><span class="amt">' + esc(fee) + ' booking fee per appointment &mdash; holds your spot in line, non-refundable unless you cancel at least ' + esc(shop.cancelWindowHours) + ' hours ahead. Not deducted from your service.</span></div>' +
              '<div class="ticket-row"><span>At the shop</span><span class="amt">Full price of your service</span></div>' +
              '<div class="ticket-row"><span>Late cancel / no-show</span><span class="amt">' + esc(fee) + ' forfeited per appointment</span></div>'
            : '<div class="ticket-row"><span>Reserved time</span><span class="amt">Your chair, your time</span></div>') +
        '<div class="shop-meta">' + esc(shop.address) + ' &middot; <a href="tel:' + esc(safeTel(shop.phone)) + '">' + esc(shop.phone) + '</a><br>' + hoursText + '</div>' +
      '</div></section>';

    var trust = '<section class="landing-section"><div class="trust-strip">' +
      '<div class="trust-tile"><div class="trust-num num">' + nB + '</div><div class="trust-label">Barbers on the floor</div></div>' +
      '<div class="trust-tile"><div class="trust-num num">' + daysOpen + '</div><div class="trust-label">Days open a week</div></div>' +
      '<div class="trust-tile"><div class="trust-num tight">MOST VIRAL</div><div class="trust-label">Barbershop on the planet</div></div>' +
      (on ? '<div class="trust-tile"><div class="trust-num num">' + esc(fee) + '</div><div class="trust-label">To lock in each seat</div></div>'
          : '<div class="trust-tile"><div class="trust-num tight">WALK-INS</div><div class="trust-label">Always welcome</div></div>') +
      '</div></section>';

    var cards = S.pub.barbers.map(function (b) {
      var g = (b.gallery || []).map(safeImg).filter(Boolean);
      return '<div class="team-card">' +
        '<button type="button" class="team-main" data-action="quick-book" data-id="' + esc(b.id) + '" aria-label="Book with ' + esc(b.name) + '">' +
          avatarHtml(b.name, b.photo) +
          '<div class="pick-name">' + esc(b.name) + '</div>' +
          '<div class="pick-meta">' + esc(b.title) + '</div>' +
          '<span class="team-cta">Book with ' + esc(b.name) + ' &rarr;</span></button>' +
        (g.length ? '<button type="button" class="team-work" data-action="open-photo" data-id="' + esc(b.id) + '" data-idx="0">See their work (' + g.length + ')</button>' : '') +
      '</div>';
    }).join('');
    var team = '<section class="landing-section"><div class="section-head"><div><div class="section-eyebrow">Our team</div>' +
      '<h2 class="section-title">' + nB + ' chairs, one standard</h2></div></div><div class="team-grid">' + cards + '</div></section>';

    var cats = [];
    S.pub.services.forEach(function (s) { if (cats.indexOf(s.category) === -1) cats.push(s.category); });
    var catsHtml = cats.map(function (cat) {
      return '<div class="price-cat">' + (cats.length > 1 ? '<h4>' + esc(cat) + '</h4>' : '') + S.pub.services.filter(function (s) { return s.category === cat; }).map(function (s) {
        return '<div class="price-line"><span>' + esc(s.name) + (s.note ? '<span class="pl-note">' + esc(s.note) + '</span>' : '') + '</span>' + (feeOn() ? '<span class="pl-amt num">' + esc(fmtMoney(shop.bookingFee)) + '<span class="pl-note">booking fee</span></span>' : '') + '</div>';
      }).join('') + '</div>';
    }).join('');
    var prices = '<section class="landing-section"><div class="section-head"><div><div class="section-eyebrow">Full menu</div><h2 class="section-title">Services</h2></div>' +
      '<button type="button" class="section-link" data-action="start-booking">Book any of these &rarr;</button></div><div class="price-cats">' + catsHtml + '</div></section>';

    var foot = '<footer class="landing-section"><div class="footer-grid">' +
      '<div><h4>' + esc(shop.name) + '</h4><p>' + esc(shop.address) + '<br><a href="tel:' + esc(safeTel(shop.phone)) + '">' + esc(shop.phone) + '</a></p></div>' +
      '<div><h4>Hours</h4><p>' + hl.map(function (l) { return esc(l.label) + ' &nbsp; ' + esc(l.text); }).join('<br>') + '<br>Last walk-in 30 min before close</p></div>' +
      '<div><h4>Follow</h4><p><a href="https://www.instagram.com/barberchops/" target="_blank" rel="noopener noreferrer">Instagram</a><br><a href="https://www.facebook.com/barbershopsNY" target="_blank" rel="noopener noreferrer">Facebook</a></p></div>' +
      '</div><div class="footer-bottom"><span>&copy; ' + esc(shop.name) + ' &middot; Massapequa, NY</span>' +
      '<span class="footer-links"><button type="button" data-action="go-staff">Employees</button><button type="button" data-action="go-board">TV</button><button type="button" data-action="go-owner">Owner</button></span></div></footer>';

    return hero + trust + team + prices + foot;
  }

  A['go-home'] = function () { navigate('home'); };
  A['go-staff'] = function () { navigate('staff'); };
  A['go-board'] = function () { navigate('board'); };
  A['go-owner'] = function () { navigate('owner'); };

  /* =====================================================================
     CUSTOMER: booking wizard
     ===================================================================== */
  var STEPS = ['barber', 'service', 'time', 'info', 'pay', 'done'];
  var STEP_LABELS = { barber: 'Barber', service: 'Service', time: 'Time', info: 'Your info', pay: 'Pay', done: 'Confirmed' };
  function stepsShown() { return STEPS; }
  function stepLabel(k) { return k === 'pay' ? (feeOn() ? 'Pay' : 'Confirm') : STEP_LABELS[k]; }
  function getBarber(id) { return S.pub.barbers.filter(function (b) { return b.id === id; })[0] || null; }
  function getService(id) { return S.pub.services.filter(function (s) { return s.id === id; })[0] || null; }

  function wizGo(step) { S.wiz.step = step; S.scrollTop = true; if (step === 'time') fetchAvail(false); render(); }

  A['start-booking'] = function () { S.route = 'home'; S.wiz.started = true; S.wiz.step = 'barber'; S.scrollTop = true; render(); };
  A['quick-book'] = function (el) {
    var w = S.wiz, id = el.getAttribute('data-id');
    if (w.barberId !== id) resetAvail();
    w.started = true; w.barberId = id; w.step = 'service'; S.scrollTop = true; render();
  };
  function resetAvail() { var w = S.wiz; w.avail = null; w.availKey = ''; w.availSeq++; w.time = null; w.date = null; w.slotBarberId = null; w.err = ''; }
  A['pick-barber'] = function (el) {
    var id = el.getAttribute('data-id') || 'any';
    if (S.wiz.barberId !== id) resetAvail();
    S.wiz.barberId = id; render();
  };
  A['pick-service'] = function (el) {
    var id = el.getAttribute('data-id');
    if (S.wiz.serviceId !== id) resetAvail();
    S.wiz.serviceId = id; render();
  };
  A['pick-date'] = function (el) { S.wiz.date = el.getAttribute('data-date'); S.wiz.time = null; S.wiz.err = ''; render(); };
  A['pick-time'] = function (el) { S.wiz.time = el.getAttribute('data-time'); S.wiz.slotBarberId = el.getAttribute('data-barber'); S.wiz.err = ''; render(); };

  /* ---- the cart: every appointment is its own booking fee ----
     Invariant: while the customer is on the barber / service / time steps, the appointment they are choosing lives in
     w.barberId / w.serviceId / w.date / w.time (the "draft") and is NOT in w.cart. Leaving the time step moves it into
     the cart; going back from the info step moves the last cart item back into the draft. */
  var MAX_APPTS = 6;
  function svcDuration(id) { var sv = getService(id); return sv && Number(sv.duration) > 0 ? Number(sv.duration) : 30; }
  function contactFirst() { var n = fv('w.name').trim().split(/\s+/)[0]; return n || 'You'; }
  function whoFor(it) { return fv('w.for.' + it.id).trim() || contactFirst(); }
  function feeTotal(n) { return Math.round((Number(S.pub.shop.bookingFee) || 0) * 100 * n) / 100; }
  // in-store prices come from the server (services.price, whole dollars); all sums are done in integer cents
  function priceCents(serviceId) { var sv = getService(serviceId); return sv ? Math.round((Number(sv.price) || 0) * 100) : 0; }
  function storeTotal(cart) { return cart.reduce(function (t, it) { return t + priceCents(it.serviceId); }, 0) / 100; }
  function apptWord(n) { return n === 1 ? '1 appointment' : n + ' appointments'; }
  var TAG_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9l1.5-5h15L21 9"/><path d="M4 9v11h16V9"/><path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/></svg>';
  var CARD_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M2.5 10h19"/></svg>';
  // one totals line: label + big amount, then a small sublabel. Used for "Due in store", "Due now" and "Paid online".
  function totLine(cls, icon, label, amt, sub) {
    return '<div class="tot ' + cls + '"><div class="tot-head"><span class="tot-label">' + icon + '<span>' + esc(label) + '</span></span><span class="tot-amt num">' + esc(amt) + '</span></div><div class="tot-sub">' + sub + '</div></div>';
  }
  // the same chair can't be in two places: a concrete barber at overlapping times on one day. ("No preference" is
  // never blocked here: the shop assigns a different free barber, and the server re-checks everything.)
  function cartClash(cand) {
    if (!cand.barberId || cand.barberId === 'any') return null;
    var a0 = hhmmToMin(cand.time), a1 = a0 + svcDuration(cand.serviceId);
    return S.wiz.cart.filter(function (it) {
      if (it.barberId !== cand.barberId || it.date !== cand.date) return false;
      var b0 = hhmmToMin(it.time), b1 = b0 + svcDuration(it.serviceId);
      return a0 < b1 && b0 < a1;
    })[0] || null;
  }
  function restoreDraft(it, at) {
    var w = S.wiz;
    w.serviceId = it.serviceId; w.barberId = it.barberId; w.date = it.date; w.time = it.time; w.slotBarberId = it.slotBarberId || null;
    w.draftId = it.id; w.draftAt = at; w.err = '';
  }
  function commitDraft() {
    var w = S.wiz;
    if (!(w.serviceId && w.date && w.time)) return false;
    var cand = { serviceId: w.serviceId, barberId: w.barberId || 'any', date: w.date, time: w.time };
    if (cartClash(cand)) { w.err = 'That barber is already booked at that time in your list. Pick another time, or another barber.'; return false; }
    if (w.cart.length >= MAX_APPTS) { w.err = 'You can book up to ' + MAX_APPTS + ' appointments at once.'; return false; }
    var item = { id: w.draftId || w.nextId++, serviceId: cand.serviceId, barberId: cand.barberId, date: cand.date, time: cand.time, slotBarberId: w.slotBarberId };
    if (w.draftAt != null && w.draftAt <= w.cart.length) w.cart.splice(w.draftAt, 0, item); else w.cart.push(item);
    w.draftId = null; w.draftAt = null; w.err = '';
    return true;
  }
  A['wiz-next'] = function () {
    var w = S.wiz, order = STEPS, i = order.indexOf(w.step);
    if (w.step === 'time' && !commitDraft()) { render(); return; }
    wizGo(order[Math.min(order.length - 1, i + 1)]);
  };
  A['wiz-back'] = function () {
    var w = S.wiz, i = STEPS.indexOf(w.step);
    if (w.step === 'barber') {
      if (w.cart.length) { w.err = ''; wizGo('info'); return; }      // back to the appointments already chosen
      w.started = false; S.scrollTop = true; render(); return;
    }
    if (w.step === 'info') { var last = w.cart.pop(); if (last) restoreDraft(last, null); }
    w.err = ''; w.errs = {}; wizGo(STEPS[i - 1]);
  };
  A['add-another'] = function () {
    var w = S.wiz;
    if (w.cart.length >= MAX_APPTS) return;
    // everything typed so far (contact details, consent, each "who is this for") already lives in F; start a clean pick
    resetAvail();
    w.serviceId = null; w.barberId = null; w.draftId = null; w.draftAt = null; w.errs = {}; w.err = '';
    wizGo('barber');
  };
  A['cart-remove'] = function (el) {
    var w = S.wiz, id = parseInt(el.getAttribute('data-id'), 10);
    if (w.cart.length < 2) return;
    w.cart = w.cart.filter(function (it) { return it.id !== id; });
    delete F['w.for.' + id];
    render();
  };
  A['retry-avail'] = function () { return fetchAvail(true); };
  A['book-another'] = function () {
    Object.keys(F).forEach(function (k) { if (k.indexOf('w.') === 0 || k === 'website') delete F[k]; });
    S.wiz = freshWiz(); S.wiz.started = true; S.pay = null; S.route = 'home'; S.scrollTop = true; render();
  };
  // back from a cancelled/abandoned payment while the cart is still in memory
  A['pay-retry'] = function () {
    var w = S.wiz; S.pay = null; S.route = 'home'; w.started = true; w.busy = false; w.redirecting = false; w.err = '';
    w.step = w.cart.length ? 'info' : 'barber'; S.scrollTop = true; render();
  };
  // the browser's Back button from Stripe can restore this page frozen on "Taking you to secure payment…"
  window.addEventListener('pageshow', function (ev) {
    if (ev.persisted && S.wiz && (S.wiz.redirecting || S.wiz.busy)) { S.wiz.redirecting = false; S.wiz.busy = false; render(); }
  });

  function fetchAvail(force) {
    var w = S.wiz;
    if (!w.serviceId) return null;
    var barber = w.barberId || 'any', key = barber + '|' + w.serviceId;
    if (!force && w.availKey === key && (w.avail || w.availLoading)) return null;
    var seq = ++w.availSeq;
    w.availLoading = true; w.availErr = ''; w.availKey = key; w.avail = null; render();
    return api('GET', '/api/availability?service=' + encodeURIComponent(w.serviceId) + '&barber=' + encodeURIComponent(barber) + '&days=21').then(function (r) {
      if (seq !== w.availSeq) return;
      w.availLoading = false;
      if (!r.ok) { w.availErr = errMsg(r); w.availKey = ''; render(); return; }
      w.avail = r.data.days || [];
      var dayOf = function (d) { return w.avail.filter(function (x) { return x.date === d; })[0]; };
      var cur = w.date && dayOf(w.date);
      if (!cur || !cur.slots.length) {
        var first = w.avail.filter(function (x) { return x.slots.length; })[0];
        w.date = first ? first.date : null; w.time = null;
      } else if (w.time && !cur.slots.some(function (s) { return s.time === w.time; })) { w.time = null; }
      render();
    });
  }

  function railHtml() {
    var w = S.wiz, list = stepsShown(), idx = list.indexOf(w.step);
    var rail = '<nav class="rail" aria-label="Booking steps">' + list.map(function (k, i) {
      var cls = 'rail-step' + (i === idx ? ' active' : (i < idx ? ' done' : ''));
      return '<div class="' + cls + '"' + (i === idx ? ' aria-current="step"' : '') + '><span class="dot">' + (i < idx ? '&#10003;' : (i + 1)) + '</span><span>' + esc(stepLabel(k)) + '</span></div>';
    }).join('') + '</nav>';
    var m = '<div class="mprog"><div class="mprog-top"><span>Step ' + (idx + 1) + ' of ' + list.length + '</span><b>' + esc(stepLabel(w.step)) + '</b></div><div class="mprog-bar">' +
      list.map(function (k, i) { return '<span class="' + (i <= idx ? 'on' : '') + '"></span>'; }).join('') + '</div></div>';
    return rail + m;
  }

  function viewWizard() {
    var w = S.wiz, panel;
    if (w.step === 'barber') panel = stepBarber();
    else if (w.step === 'service') panel = stepService();
    else if (w.step === 'time') panel = stepTime();
    else if (w.step === 'info') panel = stepInfo();
    else if (w.step === 'pay') panel = stepPay();
    else return '<div class="wizard" style="grid-template-columns:1fr"><div class="panel">' + confirmationHtml(w.done) + '</div></div>';
    return '<div class="wizard">' + railHtml() + '<div class="panel">' + panel + '</div></div>';
  }

  function wizNav(canNext, nextLabel, o) {
    o = o || {};
    var back = '<button type="button" class="btn-text" data-action="wiz-back">&larr; ' + (o.backLabel || 'Back') + '</button>';
    var next = o.submit
      ? '<button type="submit" class="btn btn-primary"' + (canNext ? '' : ' disabled') + '>' + nextLabel + '</button>'
      : '<button type="button" class="btn btn-primary" data-action="' + (o.action || 'wiz-next') + '"' + (canNext ? '' : ' disabled') + '>' + nextLabel + '</button>';
    return '<div class="wiz-nav">' + back + next + '</div>';
  }

  function showcaseHtml(barberId) {
    var b = barberId && barberId !== 'any' ? getBarber(barberId) : null; if (!b) return '';
    var g = (b.gallery || []).map(safeImg).filter(Boolean); if (!g.length) return '';
    return '<div class="showcase"><div class="section-eyebrow">' + esc(b.name) + '’s work</div><div class="showcase-grid">' +
      g.map(function (src, i) {
        return '<button type="button" class="showcase-thumb" data-action="open-photo" data-id="' + esc(b.id) + '" data-idx="' + i + '" aria-label="View ' + esc(b.name) + '’s work, photo ' + (i + 1) + '"><img src="' + esc(src) + '" alt=""></button>';
      }).join('') + '</div></div>';
  }

  // "Appointment 2" banner (with what is already in the cart) while adding another person
  function apptEyebrow() {
    var w = S.wiz; if (!w.cart.length) return '';
    var n = (w.draftAt != null ? w.draftAt : w.cart.length) + 1;
    var lines = w.cart.map(function (it) {
      var sv = getService(it.serviceId), b = it.barberId !== 'any' ? getBarber(it.barberId) : null;
      return '<li>' + esc(whoFor(it)) + ' &middot; ' + esc(sv ? sv.name : '') + (b ? ' &middot; ' + esc(b.name) : '') + ' &middot; ' + esc(fmtDateShort(it.date)) + ' ' + esc(fmtTime(it.time)) + '</li>';
    }).join('');
    return '<div class="section-eyebrow appt-eyebrow">Appointment ' + n + ' of up to ' + MAX_APPTS + '</div>' +
      '<details class="cart-mini"><summary>Already in your booking (' + w.cart.length + ')</summary><ul>' + lines + '</ul></details>';
  }

  function stepBarber() {
    var w = S.wiz;
    var cards = S.pub.barbers.map(function (b) {
      return '<button type="button" class="pick-card" data-action="pick-barber" data-id="' + esc(b.id) + '" aria-pressed="' + (w.barberId === b.id) + '">' +
        avatarHtml(b.name, b.photo) + '<div class="pick-name">' + esc(b.name) + '</div><div class="pick-meta">' + esc(b.title) + '</div></button>';
    }).join('');
    cards += '<button type="button" class="pick-card" data-action="pick-barber" data-id="any" aria-pressed="' + (w.barberId === 'any') + '"><div class="pick-avatar">?</div><div class="pick-name">No preference</div><div class="pick-meta">First available barber</div></button>';
    return apptEyebrow() + '<h2 class="step-title">Choose your barber</h2><p class="step-hint">Pick a barber, or let us assign the first open chair.</p>' +
      '<div class="card-grid">' + cards + '</div>' + showcaseHtml(w.barberId) + wizNav(w.barberId !== null, 'Continue', { backLabel: w.cart.length ? 'Your appointments' : 'Home' });
  }

  function stepService() {
    var w = S.wiz, cats = [], html = '';
    S.pub.services.forEach(function (s) { if (cats.indexOf(s.category) === -1) cats.push(s.category); });
    cats.forEach(function (cat) {
      html += (cats.length > 1 ? '<div class="cat-heading">' + esc(cat) + '</div>' : '') + '<div class="card-grid">' + S.pub.services.filter(function (s) { return s.category === cat; }).map(function (s) {
        return '<button type="button" class="pick-card" data-action="pick-service" data-id="' + esc(s.id) + '" aria-pressed="' + (w.serviceId === s.id) + '">' +
          '<div class="pick-name">' + esc(s.name) + '</div>' + (s.note ? '<div class="pick-meta">' + esc(s.note) + '</div>' : '') +
          (feeOn() ? '<div class="pick-price"><span>booking fee</span><b class="num">' + esc(fmtMoney(S.pub.shop.bookingFee)) + '</b></div>' : '') + '</button>';
      }).join('') + '</div>';
    });
    return apptEyebrow() + '<h2 class="step-title">Choose a service</h2><p class="step-hint">' + (feeOn() ? 'Each appointment has a ' + esc(fmtMoney(S.pub.shop.bookingFee)) + ' booking fee that holds your spot in line. It is NOT deducted from your service: you still pay the full price of your service at the shop.' : 'You pay the full price of your service at the shop.') + '</p>' + showcaseHtml(w.barberId) + html + wizNav(!!w.serviceId, 'Continue');
  }

  function stepTime() {
    var w = S.wiz, svc = getService(w.serviceId), barber = w.barberId && w.barberId !== 'any' ? getBarber(w.barberId) : null;
    var hint = (svc ? esc(svc.name) : '') + (barber ? ' &middot; with ' + esc(barber.name) : ' &middot; first available barber');
    var body;
    if (w.availLoading || (!w.avail && !w.availErr)) {
      body = '<div class="loading-row">' + spinner() + '<span>Checking open times…</span></div>';
    } else if (w.availErr) {
      body = notice('error', esc(w.availErr) + ' <button type="button" class="btn-text" data-action="retry-avail">Try again</button>');
    } else {
      var days = w.avail, anySlots = days.some(function (d) { return d.slots.length; });
      if (!anySlots) {
        body = '<div class="empty-note">No open times in the next few weeks for this choice. Try another barber or service, or call the shop &mdash; walk-ins are always welcome.</div>';
      } else {
        var row = '<div class="day-row" role="group" aria-label="Choose a day">' + days.map(function (d) {
          var p = isoParts(d.date), on = w.date === d.date;
          return '<button type="button" class="day-btn" data-action="pick-date" data-date="' + esc(d.date) + '" aria-pressed="' + on + '" aria-label="' + esc(fmtDateLong(d.date)) + '"' + (d.slots.length ? '' : ' disabled') + '>' +
            '<span class="dow">' + DOW3[dowOf(d.date)] + '</span><span class="dom">' + p.d + '</span><span class="mon">' + MON_EN[p.m - 1].slice(0, 3) + '</span></button>';
        }).join('') + '</div>';
        var day = days.filter(function (d) { return d.date === w.date; })[0], clashes = 0;
        var slots = day && day.slots.length
          ? '<div class="slot-grid" role="group" aria-label="Choose a time">' + day.slots.map(function (s) {
            var clash = cartClash({ serviceId: w.serviceId, barberId: w.barberId || 'any', date: day.date, time: s.time });
            if (clash) clashes++;
            return '<button type="button" class="slot-btn num" data-action="pick-time" data-time="' + esc(s.time) + '" data-barber="' + esc(s.barberId) + '" aria-pressed="' + (w.time === s.time) + '"' +
              (clash ? ' disabled title="Already in your booking" aria-label="' + esc(fmtTime(s.time)) + ', already in your booking"' : '') + '>' + esc(fmtTime(s.time)) + '</button>';
          }).join('') + '</div>' + (clashes ? '<div class="hint slot-hint">Greyed-out times are already in your booking with this barber. Pick another barber to book at the same time.</div>' : '')
          : '<div class="empty-note">Pick a day above.</div>';
        body = row + (w.date ? '<div class="cat-heading" style="margin-top:4px">' + esc(fmtDateLong(w.date)) + '</div>' : '') + slots;
      }
    }
    return apptEyebrow() + '<h2 class="step-title">Pick a date &amp; time</h2><p class="step-hint">' + hint + '</p>' +
      (w.err ? notice('error', esc(w.err)) : '') + body + wizNav(!!(w.date && w.time), 'Continue');
  }

  function consentLetterHtml(shop) {
    var n = esc(shop.name), ph = esc(shop.phone);
    return '<p><b>Marketing consent &mdash; text messages and email</b></p>' +
      '<p>By ticking the box on the booking form, I agree that <b>' + n + '</b>, ' + esc(shop.address) + ' (phone ' + ph + '), may send me marketing messages, such as offers, events and news, by <b>text message</b> to the mobile number I entered and by <b>email</b> to the email address I entered, if I gave one.</p>' +
      '<p>I understand that:</p><ol>' +
      '<li>My consent is <b>not a condition</b> of booking an appointment or buying anything from ' + n + '.</li>' +
      '<li>How often I hear from the shop will vary. Message and data rates from my mobile carrier may apply to texts.</li>' +
      '<li>I can <b>withdraw my consent at any time</b> by replying STOP to any text message, by using the unsubscribe link in any email, or by calling ' + ph + '. Reply HELP to a text for help.</li>' +
      '<li>This consent is separate from appointment confirmations and reminders, which I may still receive about my bookings even if I withdraw it.</li>' +
      '<li>' + n + ' uses my contact details only to reach me about the shop and does not sell them.</li></ol>' +
      '<p>The date and time I tick the box are recorded as proof of my consent.</p>';
  }

  function cartCardHtml(it, i, n) {
    var sv = getService(it.serviceId), b = it.barberId !== 'any' ? getBarber(it.barberId) : null;
    return '<div class="cart-item" data-cart="' + esc(it.id) + '"><div class="cart-head"><span class="cart-num num">' + (i + 1) + '</span>' +
      '<div class="cart-main"><div class="cart-svc">' + esc(sv ? sv.name : '') + '</div>' +
      '<div class="cart-meta">' + esc(b ? b.name : 'First available barber') + '</div>' +
      '<div class="cart-meta num">' + esc(fmtDateLong(it.date)) + ' at ' + esc(fmtTime(it.time)) + '</div></div>' +
      (n > 1 ? '<button type="button" class="btn-text cart-remove" data-action="cart-remove" data-id="' + esc(it.id) + '" aria-label="Remove appointment ' + (i + 1) + '">Remove</button>' : '') + '</div>' +
      inp('w.for.' + it.id, { label: 'Who is this for? (optional)', ph: 'First name, e.g. Maya. Blank means you.', attrs: 'maxlength="40" autocomplete="off" autocapitalize="words"', style: 'margin:12px 0 0' }) + '</div>';
  }

  function stepInfo() {
    var w = S.wiz, e = w.errs, shop = S.pub.shop, n = w.cart.length, full = n >= MAX_APPTS;
    var cart = '<div class="cart">' + w.cart.map(function (it, i) { return cartCardHtml(it, i, n); }).join('') + '</div>' +
      '<div class="cart-add"><button type="button" class="btn btn-ghost" data-action="add-another"' + (full ? ' disabled' : '') + '>+ Add another appointment</button>' +
      '<div class="hint">' + (full ? 'That’s the maximum of ' + MAX_APPTS + ' appointments in one booking. For a bigger group, please call the shop' + (shop.phone ? ' at ' + esc(shop.phone) : '') + '.'
        : 'Booking for the family? Add up to ' + MAX_APPTS + ' appointments, one per person, and check out once' + (feeOn() ? ' (each has its own ' + esc(fmtMoney(shop.bookingFee)) + ' booking fee)' : '') + '.') + '</div></div>';
    return '<h2 class="step-title">' + (n === 1 ? 'Your appointment' : 'Your appointments') + '</h2>' +
      '<form data-submit="wiz-info" novalidate>' +
      cart +
      '<h3 class="sub-title">Your contact info</h3><p class="step-hint" style="margin-bottom:14px">We’ll email your confirmation if you add an address. You only enter this once.</p>' +
      (w.err ? notice('error', esc(w.err)) : '') +
      inp('w.name', { label: 'Full name', ph: 'Jordan Smith', attrs: 'autocomplete="name" maxlength="80" required', err: e.name }) +
      '<div class="field-row">' +
        inp('w.phone', { label: 'Phone number (required)', type: 'tel', ph: '(516) 555-0100', attrs: 'autocomplete="tel" inputmode="tel" maxlength="20" required aria-required="true"', hint: 'Required. The shop only uses it to reach you if you’re running late or something changes with your appointment.', err: e.phone }) +
        inp('w.email', { label: 'Email (optional)', type: 'email', ph: 'you@email.com', attrs: 'autocomplete="email" inputmode="email" maxlength="120"', err: e.email }) +
      '</div>' +
      inp('w.notes', { label: 'Notes for your barber (optional)', type: 'textarea', ph: 'e.g. skin fade, keep the top length', rows: 2, max: 300 }) +
      '<div class="hp" aria-hidden="true"><label>Website<input type="text" name="website" id="f_website" tabindex="-1" autocomplete="off" data-f="website" value="' + esc(fv('website')) + '"></label></div>' +
      checkbox('w.optIn', 'Yes, ' + esc(shop.name) + ' may send me promotional <b>texts and emails</b>. Consent is not required to book. Reply STOP to any text, or use the unsubscribe link in any email, to opt out. Msg &amp; data rates may apply.', !!shop.marketingPreTick) +
      '<details class="consent-letter"><summary>Read the full marketing consent notice</summary><div class="consent-body">' + consentLetterHtml(shop) + '</div></details>' +
      wizNav(true, 'Continue', { submit: true }) + '</form>';
  }

  SUBMIT['wiz-info'] = function () {
    var w = S.wiz, errs = {};
    var name = fv('w.name').trim(), phone = fv('w.phone').trim(), email = fv('w.email').trim();
    var digits = phone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    if (!w.cart.length) { w.err = 'Add an appointment first.'; render(); return; }
    if (name.length < 2) errs.name = 'Please enter your full name.';
    if (!phone) errs.phone = 'A phone number is required so the shop can reach you.';
    else if (digits.length !== 10) errs.phone = 'Enter a 10-digit US phone number.';
    if (email && !/^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/.test(email)) errs.email = 'That email address doesn’t look right.';
    w.errs = errs; w.err = '';
    if (Object.keys(errs).length) { render(); var first = document.querySelector('.field-error'); if (first && first.previousElementSibling) first.previousElementSibling.focus(); return; }
    wizGo('pay');
  };

  function stepPay() {
    var w = S.wiz, shop = S.pub.shop, on = feeOn(), fee = fmtMoney(shop.bookingFee), n = w.cart.length, busy = w.busy || w.redirecting;
    var rows = w.cart.map(function (it) {
      var sv = getService(it.serviceId), b = it.barberId !== 'any' ? getBarber(it.barberId) : null;
      return '<div class="pay-row"><div class="pay-what"><div class="pay-who">' + esc(whoFor(it)) + '</div>' +
        '<div class="pay-detail">' + esc(sv ? sv.name : '') + ' &middot; ' + esc(b ? b.name : 'First available barber') + '</div>' +
        '<div class="pay-detail num">' + esc(fmtDateLong(it.date)) + ' at ' + esc(fmtTime(it.time)) + '</div></div>' +
        '<div class="pay-amts"><span class="pa-store"><span class="num">' + esc(fmtMoney(priceCents(it.serviceId) / 100)) + '</span> in store</span>' +
        (on ? '<span class="pa-fee"><span class="num">' + esc(fee) + '</span> booking fee</span>' : '') + '</div></div>';
    }).join('');
    var store = totLine('tot-store', TAG_SVG, 'Due in store', fmtMoney(storeTotal(w.cart)), 'Service price for ' + apptWord(n) + '. Paid at the shop, not online.');
    var now = on
      ? totLine('tot-now', CARD_SVG, 'Due now', fmtMoney(feeTotal(n)), esc(fee) + ' booking fee &times; ' + apptWord(n) + '. This is the only online charge.')
      : totLine('tot-now tot-zero', CARD_SVG, 'Due now', '$0', 'Nothing to pay online.');
    var nowCents = on ? feeTotal(n) : 0;
    var visit = totLine('tot-total', '', 'Total', fmtMoney(storeTotal(w.cart) + nowCents), on
      ? esc(fmtMoney(storeTotal(w.cart))) + ' due in store + ' + esc(fmtMoney(nowCents)) + ' due now. Only the ' + esc(fmtMoney(nowCents)) + ' due now is charged online.'
      : 'Nothing is charged online. The full amount is paid at the shop.');
    var summary = '<div class="summary-box"><div class="summary-title">' + (n === 1 ? 'Your appointment' : 'Your ' + n + ' appointments') + '</div>' + rows +
      '<div class="totals" role="group" aria-label="Totals">' + store + now + visit + '</div></div>';
    var policy = on
      ? '<div class="policy-note"><b>' + esc(fee) + ' booking fee per appointment.</b> Each fee holds your spot in line and is non-refundable, except when you cancel at least ' + esc(shop.cancelWindowHours) + ' hours ahead. It is a separate booking fee and is NOT deducted from your service price. The full service price is paid at the shop. Your confirmation email has a link to cancel or reschedule any appointment yourself: cancelling at least ' + esc(shop.cancelWindowHours) + ' hours ahead refunds its fee, and rescheduling keeps it. Late cancellations and no-shows forfeit the fee. Walk-ins remain welcome any time at no charge.</div>'
      : '<div class="policy-note"><b>Nothing is charged online.</b> The full service price is paid at the shop. Please call at least ' + esc(shop.cancelWindowHours) + ' hours ahead if you need to change your time. Walk-ins are always welcome.</div>';
    var secure = on ? '<div class="secure-note">' + svgLock() + '<span>You’ll pay on Stripe’s own secure page &mdash; card, Apple Pay and Google Pay all work there. Your card details never touch this site.</span></div>' : '';
    var idle = on ? 'Pay ' + esc(fmtMoney(feeTotal(n))) + ' now &middot; reserve ' + apptWord(n) : (n > 1 ? 'Confirm ' + n + ' appointments' : 'Confirm booking');
    var label = w.redirecting ? spinner() + ' Taking you to secure payment…' : (w.busy ? spinner() + ' Reserving…' : idle);
    return '<h2 class="step-title">' + (on ? 'Reserve your chair' + (n > 1 ? 's' : '') : 'Confirm your booking') + '</h2>' + summary +
      (w.err ? notice('error', esc(w.err)) : '') + policy +
      '<div class="wiz-nav"><button type="button" class="btn-text" data-action="wiz-back"' + (busy ? ' disabled' : '') + '>&larr; Back</button>' +
      '<button type="button" class="btn btn-primary" data-action="book"' + (busy ? ' disabled' : '') + '>' + label + '</button></div>' + secure;
  }

  // The server's "slot taken" answer is generic. Re-check every appointment against fresh availability to find which one
  // lost its time, and send the customer back to re-pick just that one (everything else stays in the cart).
  function findTaken() {
    var w = S.wiz, uniq = {};
    w.cart.forEach(function (it) { uniq[it.barberId + '|' + it.serviceId] = it; });
    return Promise.all(Object.keys(uniq).map(function (k) {
      var it = uniq[k];
      return api('GET', '/api/availability?service=' + encodeURIComponent(it.serviceId) + '&barber=' + encodeURIComponent(it.barberId) + '&days=21').then(function (r) {
        return { key: k, days: r.ok && r.data ? r.data.days : null };
      });
    })).then(function (res) {
      var by = {}; res.forEach(function (x) { by[x.key] = x.days; });
      var idx = -1;
      w.cart.some(function (it, i) {
        var days = by[it.barberId + '|' + it.serviceId]; if (!days) return false;
        var day = days.filter(function (d) { return d.date === it.date; })[0]; if (!day) return false;
        if (!day.slots.some(function (sl) { return sl.time === it.time; })) { idx = i; return true; }
        return false;
      });
      return idx;
    });
  }
  function slotTaken() {
    var w = S.wiz;
    return findTaken().then(function (idx) {
      var known = idx >= 0;
      if (!known) idx = w.cart.length - 1;
      var it = w.cart.splice(idx, 1)[0];
      restoreDraft(it, idx);
      var sv = getService(it.serviceId), typed = fv('w.for.' + it.id).trim();
      var what = (typed ? typed + '’s ' : '') + (sv ? sv.name : 'appointment');
      w.time = null; w.slotBarberId = null; w.availKey = ''; w.avail = null; w.availSeq++;
      w.busy = false; w.step = 'time'; S.scrollTop = true;
      w.err = known ? 'Sorry — the time for ' + what + ' (' + fmtDateShort(it.date) + ' at ' + fmtTime(it.time) + ') was just taken. Pick a new time below. The rest of your booking and your details are saved.'
        : 'Sorry — one of your times was just taken. Pick a new time for ' + what + ' below. The rest of your booking and your details are saved.';
      render(); return fetchAvail(true);
    });
  }

  A['book'] = function () {
    var w = S.wiz, shop = S.pub.shop;
    if (w.busy || w.redirecting || !w.cart.length) return;
    w.busy = true; w.err = ''; render();
    // if a payment page was opened and abandoned from this same page, release its held times first so they don't block this try
    var release = w.lastToken ? api('POST', '/api/bookings/cancel-pending', { t: w.lastToken }) : Promise.resolve();
    w.lastToken = '';
    // named barbers first, "no preference" after, so a no-preference pick never takes a chair someone asked for by name
    var ordered = w.cart.slice().sort(function (a, b) { return (a.barberId === 'any' ? 1 : 0) - (b.barberId === 'any' ? 1 : 0); });
    var body = {
      name: fv('w.name').trim(), phone: fv('w.phone').trim(), email: fv('w.email').trim(), notes: fv('w.notes').trim(),
      optIn: !!fv('w.optIn', !!shop.marketingPreTick), website: fv('website', ''),
      appointments: ordered.map(function (it) { return { serviceId: it.serviceId, barberId: it.barberId || 'any', date: it.date, time: it.time, forName: fv('w.for.' + it.id).trim() }; })
    };
    return release.then(function () { return api('POST', '/api/bookings', body); }).then(function (r) {
      if (r.ok && r.data && r.data.status === 'confirmed') {
        return api('GET', '/api/bookings/status?t=' + encodeURIComponent(r.data.token)).then(function (s) {
          w.busy = false;
          if (s.ok) { w.done = s.data; w.step = 'done'; S.scrollTop = true; }
          else w.err = 'You’re booked! We just couldn’t load your confirmation — the shop will see ' + (w.cart.length > 1 ? 'your appointments' : 'your appointment') + '.';
          render();
        });
      }
      if (r.ok && r.data && r.data.status === 'pending' && safeCheckoutUrl(r.data.checkoutUrl)) {
        w.busy = false; w.redirecting = true; w.lastToken = r.data.token || ''; render();
        location.assign(r.data.checkoutUrl);
        return;
      }
      var code = r.data && r.data.code;
      if (r.ok) { w.busy = false; w.err = 'Something went wrong while starting your booking. Please try again.'; }
      else if (code === 'slot_taken') return slotTaken();
      else if (code === 'blocked') { w.busy = false; w.step = 'info'; w.errs = { phone: errMsg(r) }; w.err = ''; }
      else { w.busy = false; w.err = errMsg(r); }
      render();
    });
  };

  /* ---- confirmation: every appointment, the fees paid, and any that were lost ---- */
  function apptWhen(a) { return fmtDateLong(a.date) + ' at ' + fmtTime(a.time); }
  function lostHtml(d) {
    var lost = (d.appointments || []).filter(function (a) { return a.needsRefund; });
    if (!lost.length) return '';
    var each = (d.feeEachCents || 0) / 100, all = (d.appointments || []).length;
    var headline = lost.length === all ? (all === 1 ? 'Your appointment could not be held.' : 'None of your ' + all + ' appointments could be held.')
      : lost.length + ' of your ' + all + ' appointments could not be held.';
    return '<div><strong>' + esc(headline) + '</strong> ' +
      (lost.length === 1 ? 'Its time was' : 'Their times were') + ' taken by someone else just before your payment finished. The shop has been alerted, and the ' + esc(fmtMoney(each)) + ' booking fee for ' + (lost.length === 1 ? 'it' : 'each one') +
      (lost.length > 1 ? ' (' + esc(fmtMoney(each * lost.length)) + ' in all)' : '') + ' will be refunded to you. ' + (lost.length === 1 ? 'Its' : 'Their') + ' service price is not included in what is due in store.' +
      '<ul class="lost-list">' + lost.map(function (a) { return '<li>' + esc(a.firstName) + ' &middot; ' + esc(a.service) + ' &middot; ' + esc(apptWhen(a)) + '</li>'; }).join('') + '</ul></div>';
  }
  function confirmationHtml(d) {
    if (!d) return '';
    var shop = S.pub ? S.pub.shop : { cancelWindowHours: 12, phone: '' };
    var all = d.appointments || [];
    var kept = all.filter(function (a) { return a.status === 'upcoming' || a.status === 'completed' || a.status === 'no-show'; });
    var multi = kept.length > 1;
    var paid = kept.filter(function (a) { return a.feePaid && !a.needsRefund; });
    var each = (d.feeEachCents || 0) / 100;
    var cards = kept.map(function (a) {
      var showWho = multi || (a.firstName && a.firstName !== d.contactFirstName);
      return '<div class="confirm-appt">' + (showWho ? '<div class="pay-who">' + esc(a.firstName) + '</div>' : '') +
        '<div class="summary-row"><span>Service</span><span>' + esc(a.service) + '</span></div>' +
        '<div class="summary-row"><span>Barber</span><span>' + esc(a.barber) + '</span></div>' +
        '<div class="summary-row"><span>When</span><span>' + esc(fmtDateLong(a.date)) + ', ' + esc(fmtTime(a.time)) + '</span></div>' +
        '<div class="summary-row"><span>In store</span><span class="num">' + esc(fmtMoney(Number(a.servicePrice) || 0)) + '</span></div>' +
        (multi ? '<div class="appt-code">CONFIRMATION #<span class="code-text">' + esc(a.confirmation) + '</span></div>' : '') + '</div>';
    }).join('');
    var paidCents = d.feePaidCents || 0;
    var dueDollars = typeof d.dueInStore === 'number' ? d.dueInStore : kept.reduce(function (t, a) { return t + (Number(a.servicePrice) || 0); }, 0);
    var fees = kept.length ? '<div class="summary-box totals-box"><div class="totals" role="group" aria-label="Totals">' +
      totLine('tot-paid', CARD_SVG, 'Paid online (booking fees)', fmtMoney(paidCents / 100), paid.length ? esc(fmtMoney(each)) + ' booking fee &times; ' + apptWord(paid.length) + '. It holds your spot in line, is non-refundable, and is NOT deducted from your service price.' : 'No booking fee was charged online.') +
      totLine('tot-store', TAG_SVG, 'Due in store', fmtMoney(dueDollars), 'Service price for ' + apptWord(kept.length) + '. Paid at the shop, not online.') +
      totLine('tot-total', '', 'Total', fmtMoney(dueDollars + paidCents / 100), esc(fmtMoney(paidCents / 100)) + ' paid online + ' + esc(fmtMoney(dueDollars)) + ' due in store.') +
      '</div></div>' : '';
    var head = kept.length
      ? '<h2 class="step-title">You’re on the books' + (d.contactFirstName ? ', ' + esc(d.contactFirstName) : '') + '</h2>' +
        (multi ? '<div class="confirm-code">' + kept.length + ' APPOINTMENTS CONFIRMED</div>'
          : '<div class="confirm-code">CONFIRMATION #<span id="confirm-code">' + esc(kept[0].confirmation) + '</span></div>')
      : '<h2 class="step-title">We couldn’t hold your time</h2>';
    return '<div class="confirm-wrap"><div class="confirm-check">' + svgCheck() + '</div>' + head +
      (d.lost > 0 ? '<div style="margin-top:16px">' + notice('error', lostHtml(d)) + '</div>' : '') +
      (kept.length ? '<div class="confirm-list">' + cards + '</div>' : '') + fees +
      (d.emailed ? notice('ok', '<span>A confirmation email is on its way to you.</span>') : notice('', '<span>Keep your confirmation number' + (multi ? 's' : '') + ' handy. Add an email next time and we’ll send you a confirmation too.</span>')) +
      '<div class="policy-note"><b>At the shop:</b> you pay the service price shown as Due in store. The booking fee holds your spot in line and is not deducted from it.<br><br>Please arrive about 10 minutes early. Need to change plans? Give the shop ' + esc(shop.cancelWindowHours) + ' hours’ notice' + (shop.phone ? ' at <a href="tel:' + esc(safeTel(shop.phone)) + '">' + esc(shop.phone) + '</a>' : '') + '.</div>' +
      '<div style="margin-top:20px"><button type="button" class="btn btn-ghost" data-action="book-another">Book another appointment</button></div></div>';
  }

  /* =====================================================================
     CUSTOMER: coming back from Stripe (or the dev payment page)
     ===================================================================== */
  function viewPay() {
    var p = S.pay; if (!p) return '';
    if (p.phase === 'polling') {
      return '<div class="center-stage" role="status">' + spinner('spinner-lg') + '<h2 class="step-title">Finishing your payment…</h2>' +
        '<p class="step-hint">This usually takes just a few seconds. Please keep this page open.</p></div>';
    }
    if (p.phase === 'confirmed') return '<div class="wizard" style="grid-template-columns:1fr"><div class="panel">' + confirmationHtml(p.data) + '</div></div>';
    if (p.phase === 'slow') {
      return '<div class="center-stage"><h2 class="step-title">We’re finishing your payment</h2>' +
        notice('', '<span>Your payment is being confirmed. You’ll get an email as soon as it goes through, and your time stays held for you. If you don’t hear from us shortly, please call the shop' + (S.pub ? ' at <a href="tel:' + esc(safeTel(S.pub.shop.phone)) + '">' + esc(S.pub.shop.phone) + '</a>' : '') + '.</span>') +
        '<div class="row-actions"><button type="button" class="btn btn-primary" data-action="pay-recheck">Check again</button><button type="button" class="btn btn-ghost" data-action="go-home">Back to site</button></div></div>';
    }
    if (p.phase === 'released') {
      return '<div class="center-stage"><h2 class="step-title">Payment not completed</h2>' +
        notice('', '<span>No problem — nothing was charged, and any time we were holding for you has been released so someone else can book it.</span>') +
        '<div class="row-actions">' + (S.wiz.cart.length ? '<button type="button" class="btn btn-primary" data-action="pay-retry">Review &amp; try again</button>' : '<button type="button" class="btn btn-primary" data-action="book-another">Try again</button>') + '<button type="button" class="btn btn-ghost" data-action="go-home">Back to site</button></div></div>';
    }
    if (p.phase === 'cancelling') return '<div class="center-stage" role="status">' + spinner('spinner-lg') + '<p class="step-hint">Releasing your time…</p></div>';
    if (p.phase === 'failed') {
      return '<div class="center-stage"><h2 class="step-title">We couldn’t hold ' + (p.data && p.data.count > 1 ? 'those times' : 'that time') + '</h2>' +
        notice('error', p.data && p.data.lost > 0 ? lostHtml(p.data) : esc(p.msg || 'That time is no longer available.')) +
        '<div class="row-actions"><button type="button" class="btn btn-primary" data-action="book-another">Pick another time</button></div></div>';
    }
    return '<div class="center-stage"><h2 class="step-title">We couldn’t find that booking</h2>' + notice('error', esc(p.msg || 'The link may have expired.')) +
      '<div class="row-actions"><button type="button" class="btn btn-primary" data-action="book-another">Start a new booking</button></div></div>';
  }

  function startPayReturn(kind, token) {
    S.route = 'pay';
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ }
    if (kind === 'cancel') {
      S.pay = { phase: 'cancelling', token: token };
      render();
      api('POST', '/api/bookings/cancel-pending', { t: token }).then(function () {
        if (S.route !== 'pay') return;
        S.pay.phase = 'released'; render();
      });
      return;
    }
    S.pay = { phase: 'polling', token: token, startedAt: performance.now(), limit: 60000, data: null, msg: '' };
    render();
    pollPay();
  }
  function pollPay() {
    var p = S.pay;
    if (S.route !== 'pay' || !p || p.phase !== 'polling') return;
    api('GET', '/api/bookings/status?t=' + encodeURIComponent(p.token)).then(function (r) {
      if (S.route !== 'pay' || S.pay !== p || p.phase !== 'polling') return;
      if (r.ok) {
        var st = r.data.status;
        if (st === 'upcoming' || st === 'confirmed' || st === 'completed') { p.phase = 'confirmed'; p.data = r.data; S.scrollTop = true; render(); return; }
        if (st === 'cancelled' && (r.data.lost > 0 || r.data.feePaid)) { p.phase = 'failed'; p.data = r.data; render(); return; }
        if (st === 'cancelled' || st === 'expired') { p.phase = 'failed'; p.data = null; p.msg = (r.data.count > 1 ? 'Those times were' : 'That time was') + ' released before payment finished. Nothing was charged.'; render(); return; }
      } else if (r.status === 404) { p.phase = 'notfound'; p.msg = 'We couldn’t find that booking. The link may have expired.'; render(); return; }
      if (performance.now() - p.startedAt >= p.limit) { p.phase = 'slow'; render(); return; }
      timers.poll = setTimeout(pollPay, 2000);
    });
  }
  A['pay-recheck'] = function () {
    var p = S.pay; if (!p) return;
    p.phase = 'polling'; p.startedAt = performance.now(); p.limit = 20000; render(); pollPay();
  };


  /* =====================================================================
     MANAGE — the customer's own cancel / reschedule page (link in the confirmation email)
     ===================================================================== */
  function initManage(token) {
    S.route = 'manage';
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ }
    S.mg = { phase: 'loading', token: token, data: null, open: null, avail: null, availLoading: false, date: null, time: null, busy: false, flash: null, err: '' };
    render();
    return loadManage();
  }
  function loadManage() {
    var m = S.mg;
    return api('GET', '/api/manage?m=' + encodeURIComponent(m.token)).then(function (r) {
      if (S.route !== 'manage' || S.mg !== m) return;
      if (r.ok) { m.phase = 'ready'; m.data = r.data; } else m.phase = 'notfound';
      render();
    });
  }
  function mgFind(id) { var m = S.mg; return m && m.data ? m.data.appointments.filter(function (a) { return a.id === id; })[0] : null; }
  function viewManage() {
    var m = S.mg; if (!m) return '';
    if (m.phase === 'loading') return '<div class="center-stage" role="status">' + spinner('spinner-lg') + '<p class="step-hint">Loading your appointments…</p></div>';
    if (m.phase === 'notfound') {
      return '<div class="center-stage"><h2 class="step-title">We couldn’t find that booking</h2>' + notice('error', 'This link may be old or incomplete. Use the link in your latest confirmation email, or call the shop.') +
        '<div class="row-actions"><button type="button" class="btn btn-primary" data-action="go-home">Back to site</button></div></div>';
    }
    var d = m.data, shop = d.shop, win = esc(shop.cancelWindowHours), many = d.appointments.length > 1;
    var phoneLink = shop.phone ? '<a href="tel:' + esc(safeTel(shop.phone)) + '">' + esc(shop.phone) + '</a>' : 'the shop';
    var cards = d.appointments.map(function (a) { return mgCard(a, shop, many, phoneLink); }).join('');
    var anyUpcoming = d.appointments.some(function (a) { return a.canCancel; });
    return '<div class="wizard" style="grid-template-columns:1fr"><div class="panel">' +
      '<h2 class="step-title">Your ' + (many ? 'appointments' : 'appointment') + '</h2>' +
      '<p class="step-hint">Hi ' + esc(d.contactFirstName || 'there') + '. Move or cancel ' + (many ? 'each appointment' : 'your appointment') + ' below. For changes inside ' + win + ' hours, call ' + phoneLink + '.</p>' +
      (m.flash ? notice(m.flash.kind, esc(m.flash.text)) : '') +
      (cards || '<div class="empty-note">There are no appointments on this link.</div>') +
      (anyUpcoming ? '<div class="policy-note"><b>How changes work.</b> Rescheduling keeps the same barber and your booking fee &mdash; there is nothing more to pay online. Cancelling at least ' + win + ' hours ahead refunds the ' + esc(fmtMoney(shop.bookingFee)) + ' booking fee. Inside ' + win + ' hours you can still cancel to free the chair, but the booking fee is kept. The full service price is always paid at the shop.</div>' : '') +
      '<div class="row-actions"><button type="button" class="btn btn-ghost" data-action="go-home">Back to site</button></div></div></div>';
  }
  function mgCard(a, shop, many, phoneLink) {
    var m = S.mg, win = esc(shop.cancelWindowHours), open = m.open && m.open.id === a.id ? m.open : null;
    var head = '<div class="cart-head"><div class="cart-main"><div class="cart-svc">' + esc(a.service) + (many && a.firstName ? ' &middot; ' + esc(a.firstName) : '') + '</div>' +
      '<div class="cart-meta">with ' + esc(a.barber) + '</div>' +
      '<div class="cart-meta num">' + esc(fmtDateLong(a.date)) + ' at ' + esc(fmtTime(a.time)) + '</div></div>' +
      (a.status !== 'upcoming' ? '<span class="pill pill-' + esc(a.status) + '">' + esc(a.status.replace('-', ' ')) + '</span>' : '') + '</div>';
    var actions = '';
    if (a.canCancel && !open) {
      actions = '<div class="row-actions" style="margin-top:12px">' +
        (a.canReschedule ? '<button type="button" class="btn btn-primary btn-sm" data-action="mg-open" data-id="' + esc(a.id) + '" data-k="reschedule">Reschedule</button>' : '') +
        '<button type="button" class="btn btn-ghost btn-sm" data-action="mg-open" data-id="' + esc(a.id) + '" data-k="cancel">Cancel appointment</button></div>' +
        (a.canReschedule ? '' : '<div class="hint">This appointment is less than ' + win + ' hours away, so it can’t be moved online. Please call ' + phoneLink + '.</div>');
    } else if (!a.canCancel && a.status === 'upcoming') {
      actions = '<div class="hint">This appointment can’t be changed online anymore. Please call ' + phoneLink + '.</div>';
    }
    var panel = '';
    if (open && open.mode === 'cancel') {
      var fee = esc(fmtMoney(a.feeCents / 100));
      panel = '<div class="policy-note" style="margin-top:12px"><b>Cancel this appointment?</b> ' +
        (a.feePaid ? (a.canReschedule ? 'It is at least ' + win + ' hours away, so your ' + fee + ' booking fee will be refunded to the card you paid with.'
          : 'It is less than ' + win + ' hours away, so the ' + fee + ' booking fee is kept.') : 'No booking fee is charged for this appointment.') + '</div>' +
        (m.err ? notice('error', esc(m.err)) : '') +
        '<div class="row-actions"><button type="button" class="btn btn-primary btn-sm" data-action="mg-cancel" data-id="' + esc(a.id) + '"' + (m.busy ? ' disabled' : '') + '>' + (m.busy ? 'Cancelling…' : 'Yes, cancel appointment') + '</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-action="mg-close">Keep appointment</button></div>';
    } else if (open && open.mode === 'reschedule') {
      var body;
      if (m.availLoading || !m.avail) body = '<div class="loading-row">' + spinner() + '<span>Checking open times…</span></div>';
      else if (!m.avail.some(function (x) { return x.slots.length; })) body = '<div class="empty-note">No open times with ' + esc(a.barber) + ' in the next few weeks. Please call ' + phoneLink + '.</div>';
      else {
        var row = '<div class="day-row" role="group" aria-label="Choose a new day">' + m.avail.map(function (x) {
          var p = isoParts(x.date), on = m.date === x.date;
          return '<button type="button" class="day-btn" data-action="mg-date" data-date="' + esc(x.date) + '" aria-pressed="' + on + '" aria-label="' + esc(fmtDateLong(x.date)) + '"' + (x.slots.length ? '' : ' disabled') + '>' +
            '<span class="dow">' + DOW3[dowOf(x.date)] + '</span><span class="dom">' + p.d + '</span><span class="mon">' + MON_EN[p.m - 1].slice(0, 3) + '</span></button>';
        }).join('') + '</div>';
        var day = m.avail.filter(function (x) { return x.date === m.date; })[0];
        var slots = day && day.slots.length ? '<div class="slot-grid" role="group" aria-label="Choose a new time">' + day.slots.map(function (s) {
          return '<button type="button" class="slot-btn num" data-action="mg-time" data-time="' + esc(s.time) + '" aria-pressed="' + (m.time === s.time) + '">' + esc(fmtTime(s.time)) + '</button>';
        }).join('') + '</div>' : '<div class="empty-note">Pick a day above.</div>';
        body = row + (m.date ? '<div class="cat-heading" style="margin-top:4px">' + esc(fmtDateLong(m.date)) + '</div>' : '') + slots;
      }
      panel = '<div style="margin-top:12px"><div class="cat-heading">Pick a new time with ' + esc(a.barber) + '</div>' + body +
        (m.err ? notice('error', esc(m.err)) : '') +
        '<div class="row-actions"><button type="button" class="btn btn-primary btn-sm" data-action="mg-move" data-id="' + esc(a.id) + '"' + (m.date && m.time && !m.busy ? '' : ' disabled') + '>' + (m.busy ? 'Moving…' : 'Move my appointment') + '</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-action="mg-close">Never mind</button></div></div>';
    }
    return '<div class="cart-item" data-appt="' + esc(a.id) + '">' + head + actions + panel + '</div>';
  }
  A['mg-open'] = function (el) {
    var m = S.mg, id = el.getAttribute('data-id'), mode = el.getAttribute('data-k'), a = mgFind(id); if (!m || !a) return;
    m.open = { id: id, mode: mode }; m.date = null; m.time = null; m.avail = null; m.err = ''; m.flash = null; m.busy = false;
    if (mode === 'reschedule') {
      m.availLoading = true;
      api('GET', '/api/availability?service=' + encodeURIComponent(a.serviceId) + '&barber=' + encodeURIComponent(a.barberId) + '&days=21').then(function (r) {
        if (S.mg !== m || !m.open || m.open.id !== id) return;
        m.availLoading = false;
        if (r.ok) { m.avail = r.data.days; var first = m.avail.filter(function (x) { return x.slots.length; })[0]; if (first) m.date = first.date; }
        else { m.avail = []; m.err = errMsg(r); }
        render();
      });
    }
    render();
  };
  A['mg-close'] = function () { var m = S.mg; if (!m) return; m.open = null; m.err = ''; render(); };
  A['mg-date'] = function (el) { var m = S.mg; if (!m) return; m.date = el.getAttribute('data-date'); m.time = null; m.err = ''; render(); };
  A['mg-time'] = function (el) { var m = S.mg; if (!m) return; m.time = el.getAttribute('data-time'); m.err = ''; render(); };
  A['mg-cancel'] = function (el) {
    var m = S.mg, id = el.getAttribute('data-id'), a = mgFind(id); if (!m || !a || m.busy) return;
    m.busy = true; m.err = ''; render();
    return api('POST', '/api/manage/cancel', { m: m.token, id: id }).then(function (r) {
      if (S.mg !== m) return;
      m.busy = false;
      if (!r.ok) { m.err = errMsg(r); render(); return; }
      var fee = fmtMoney(a.feeCents / 100), win = m.data.shop.cancelWindowHours;
      m.flash = { kind: 'ok', text: r.data.refund ? 'Your appointment is cancelled. Your ' + fee + ' booking fee will be refunded to your card. Watch for an email.'
        : r.data.feeKept ? 'Your appointment is cancelled. The ' + fee + ' booking fee is kept because it was less than ' + win + ' hours before your appointment.' : 'Your appointment is cancelled.' };
      m.open = null; S.scrollTop = true;
      return loadManage();
    });
  };
  A['mg-move'] = function (el) {
    var m = S.mg, id = el.getAttribute('data-id'), a = mgFind(id); if (!m || !a || m.busy || !m.date || !m.time) return;
    m.busy = true; m.err = ''; render();
    return api('POST', '/api/manage/reschedule', { m: m.token, id: id, date: m.date, time: m.time }).then(function (r) {
      if (S.mg !== m) return;
      m.busy = false;
      if (!r.ok) {
        m.err = errMsg(r);
        if (r.data && r.data.code === 'slot_taken') {   // refresh the open times so the taken one disappears
          m.time = null; m.availLoading = true; render();
          return api('GET', '/api/availability?service=' + encodeURIComponent(a.serviceId) + '&barber=' + encodeURIComponent(a.barberId) + '&days=21').then(function (ar) {
            m.availLoading = false; if (ar.ok) m.avail = ar.data.days; render();
          });
        }
        render(); return;
      }
      m.flash = { kind: 'ok', text: 'Done. Your appointment moved to ' + fmtDateLong(m.date) + ' at ' + fmtTime(m.time) + '. Your booking fee stays with it. We emailed you the new time.' };
      m.open = null; S.scrollTop = true;
      return loadManage();
    });
  };

  /* =====================================================================
     TEAM (barber) view — bilingual, first names only
     ===================================================================== */
  var STRINGS = {
    en: {
      employeeSignIn: 'Team sign-in',
      employeeHint: 'Tap your name, then enter your 6-digit PIN. Got an invite link from the owner? Open it on your phone to create your PIN.',
      noLogins: 'No one has set up a login yet. Ask the owner for your personal invite link.',
      loginNotSetUp: 'Login not set up yet',
      notYou: '← Not {name}?',
      createLoginTitle: 'Create your login',
      createLoginHint: 'Choose a 6-digit PIN. You’ll use it every time you sign in.',
      newPin: 'New PIN (6 digits)', confirmPin: 'Confirm PIN',
      createLoginBtn: 'Create login & sign in',
      pinMismatch: 'PINs don’t match.',
      pinInvalid: 'PIN must be exactly 6 digits.',
      signInAs: 'Sign in as', pinLabel: 'PIN (6 digits)',
      wrongPin: 'That PIN is not right. Ask the owner to reset your login if you forgot it.',
      locked: 'Too many wrong tries. Try again in 15 minutes, or ask the owner to reset your login.',
      linkExpired: 'This link has expired. Ask the owner for a new one.',
      network: 'We couldn’t reach the server. Check your connection and try again.',
      signInBtn: 'Sign in', working: 'Working…',
      signedInAs: 'Signed in as', signOut: 'Sign out',
      today: 'Today', next7: 'Next 7 days',
      privacyHint: 'Time, first name and service only — no phone numbers or emails are shown here.',
      noAppointments: 'No upcoming appointments on the books.',
      done: 'Done', noShow: 'No-show',
      timeOffHeading: 'Time off & running late',
      timeOffHint: 'Taking a day off, or coming in late? Block it here and the booking calendar respects it right away — no need to call the owner.',
      nothingBlocked: 'Nothing blocked right now.',
      dateLabel: 'Date', wholeDayOff: 'Whole day off', runningLate: 'Running late / leaving early',
      blockFrom: 'Block from', blockUntil: 'Block until',
      blockDayBtn: 'Block this day', blockTimeBtn: 'Block this time',
      removeBtn: 'Remove', allDay: 'All day',
      pickDateFirst: 'Pick a date first.', setStartEnd: 'Set a start and end time.', endAfterStart: 'End time must be after the start time.',
      todayLabel: 'Today', language: 'Language', refresh: 'Refresh', backToSignIn: 'Go to sign-in', minutes: 'min', loading: 'Loading…'
    },
    es: {
      employeeSignIn: 'Inicio de sesión del equipo',
      employeeHint: 'Toca tu nombre y escribe tu PIN de 6 dígitos. ¿Tienes un enlace de invitación del dueño? Ábrelo en tu teléfono para crear tu PIN.',
      noLogins: 'Nadie ha creado su acceso todavía. Pide al dueño tu enlace de invitación personal.',
      loginNotSetUp: 'Acceso aún no configurado',
      notYou: '← ¿No eres {name}?',
      createLoginTitle: 'Crea tu acceso',
      createLoginHint: 'Elige un PIN de 6 dígitos. Lo usarás cada vez que inicies sesión.',
      newPin: 'PIN nuevo (6 dígitos)', confirmPin: 'Confirmar PIN',
      createLoginBtn: 'Crear acceso e iniciar sesión',
      pinMismatch: 'Los PIN no coinciden.',
      pinInvalid: 'El PIN debe tener exactamente 6 dígitos.',
      signInAs: 'Iniciar sesión como', pinLabel: 'PIN (6 dígitos)',
      wrongPin: 'PIN incorrecto. Pide al dueño que reinicie tu acceso si lo olvidaste.',
      locked: 'Demasiados intentos fallidos. Prueba de nuevo en 15 minutos, o pide al dueño que reinicie tu acceso.',
      linkExpired: 'Este enlace venció. Pide al dueño uno nuevo.',
      network: 'No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.',
      signInBtn: 'Iniciar sesión', working: 'Un momento…',
      signedInAs: 'Sesión iniciada como', signOut: 'Cerrar sesión',
      today: 'Hoy', next7: 'Próximos 7 días',
      privacyHint: 'Solo hora, nombre de pila y servicio — no se muestran teléfonos ni correos aquí.',
      noAppointments: 'No hay citas próximas agendadas.',
      done: 'Hecho', noShow: 'No se presentó',
      timeOffHeading: 'Tiempo libre y llegadas tarde',
      timeOffHint: '¿Vas a tomar el día libre o llegarás tarde? Bloquéalo aquí y el calendario de reservas lo respeta al instante — sin necesidad de llamar al dueño.',
      nothingBlocked: 'No hay nada bloqueado por ahora.',
      dateLabel: 'Fecha', wholeDayOff: 'Día libre completo', runningLate: 'Llegada tarde / salida temprana',
      blockFrom: 'Bloquear desde', blockUntil: 'Bloquear hasta',
      blockDayBtn: 'Bloquear este día', blockTimeBtn: 'Bloquear este horario',
      removeBtn: 'Quitar', allDay: 'Todo el día',
      pickDateFirst: 'Elige una fecha primero.', setStartEnd: 'Define una hora de inicio y fin.', endAfterStart: 'La hora final debe ser después de la inicial.',
      todayLabel: 'Hoy', language: 'Idioma', refresh: 'Actualizar', backToSignIn: 'Ir al inicio de sesión', minutes: 'min', loading: 'Cargando…'
    }
  };
  var SERVICE_NAME_ES = {
    'The Quality Cut': 'El Corte de Calidad', 'Kids Cut': 'Corte para Niños', 'Designs': 'Diseños',
    'Hot Lather Head Shave': 'Afeitado con Toalla Caliente', 'Traditional Shave': 'Afeitado Tradicional',
    'Shape Up': 'Perfilado', 'Beard Trim': 'Recorte de Barba', 'Beard Enhancement': 'Realce de Barba',
    'Shampoo': 'Shampoo', 'Nose & Ear Waxing': 'Depilación de Nariz y Oídos', 'Face Mask': 'Mascarilla Facial'
  };
  var TITLE_ES = {
    'Owner / Lead Barber': 'Dueño / Barbero Principal', 'Master Barber': 'Barbero Maestro',
    'Master Barber, Colorist & Hairstylist': 'Barbero Maestro, Colorista y Estilista'
  };
  function T(key, vars) {
    var lang = curLang();
    var s = (STRINGS[lang] && STRINGS[lang][key] != null) ? STRINGS[lang][key] : STRINGS.en[key];
    if (vars) Object.keys(vars).forEach(function (k) { s = s.replace('{' + k + '}', vars[k]); });
    return s;
  }
  function trService(n) { return curLang() === 'es' && SERVICE_NAME_ES[n] ? SERVICE_NAME_ES[n] : n; }
  function trTitle(t) { return curLang() === 'es' && TITLE_ES[t] ? TITLE_ES[t] : t; }
  function staffErr(r) {
    var c = r.data && r.data.code;
    if (c === 'bad_login') return T('wrongPin');
    if (c === 'locked') return T('locked');
    if (c === 'expired') return T('linkExpired');
    if (c === 'network' || r.status === 0) return T('network');
    return errMsg(r);
  }
  function langToggle(left) {
    var l = curLang();
    return '<div class="seg-row lang-toggle"' + (left ? ' style="justify-content:flex-start"' : '') + ' role="group" aria-label="' + esc(T('language')) + '">' +
      '<button type="button" class="seg-btn" data-action="staff-lang" data-k="en" aria-pressed="' + (l !== 'es') + '">English</button>' +
      '<button type="button" class="seg-btn" data-action="staff-lang" data-k="es" aria-pressed="' + (l === 'es') + '">Español</button></div>';
  }

  function initStaff() {
    var st = S.staff;
    st.err = ''; st.phase = 'loading'; render();
    var pubP = S.pub ? Promise.resolve() : loadPublic();
    if (st.token) {
      return api('GET', '/api/staff/setup-info?token=' + encodeURIComponent(st.token), undefined, { noAuth: true }).then(function (r) {
        if (S.route !== 'staff') return;
        if (r.ok) { st.info = r.data; st.lang = r.data.lang === 'es' ? 'es' : 'en'; st.phase = 'setup'; }
        else { st.phase = 'expired'; st.err = staffErr(r); }
        return pubP.then(render);
      });
    }
    return Promise.all([api('GET', '/api/staff/session'), pubP]).then(function (res) {
      if (S.route !== 'staff') return;
      if (res[0].ok && res[0].data.authed) return loadStaffMe();
      st.phase = 'login'; render();
    });
  }
  function loadStaffMe() {
    return api('GET', '/api/staff/me', undefined, { role: 'staff' }).then(function (r) {
      if (S.route !== 'staff') return r;
      if (r.ok) {
        S.staff.me = r.data; S.staff.phase = 'schedule';
        if (!timers.own) timers.own = setInterval(function () {
          if (S.route === 'staff' && S.staff.phase === 'schedule') api('GET', '/api/staff/me', undefined, { role: 'staff' }).then(function (x) { if (x.ok && S.route === 'staff') { S.staff.me = x.data; renderIfIdle(); } });
        }, 60000);
      } else if (r.status !== 401) { S.staff.phase = 'login'; S.staff.err = staffErr(r); }
      render(); return r;
    });
  }

  function viewStaff() {
    var st = S.staff;
    if (st.phase === 'loading') return '<div class="center-stage">' + spinner('spinner-lg') + '<p class="step-hint">' + esc(T('loading')) + '</p></div>';
    if (st.phase === 'expired') {
      return '<div class="gate-wrap"><h2 style="font-size:22px;margin-bottom:12px">' + esc(T('employeeSignIn')) + '</h2>' + notice('error', esc(st.err || T('linkExpired'))) +
        '<button type="button" class="btn btn-primary" data-action="staff-to-login">' + esc(T('backToSignIn')) + '</button></div>';
    }
    if (st.phase === 'setup') return staffSetupView();
    if (st.phase === 'login') return st.pickId ? staffPinView() : staffPickView();
    return staffScheduleView();
  }
  A['staff-to-login'] = function () {
    S.staff.token = ''; try { history.replaceState(null, '', location.pathname + '#staff'); } catch (e) { /* ignore */ }
    return initStaff();
  };
  A['staff-lang'] = function (el) {
    var lang = el.getAttribute('data-k') === 'es' ? 'es' : 'en', st = S.staff;
    if (st.phase === 'schedule' && st.me) {
      return api('POST', '/api/staff/lang', { lang: lang }, { role: 'staff' }).then(function (r) {
        if (r.ok) st.me.barber.lang = lang; else st.err = staffErr(r);
        render();
      });
    }
    st.lang = lang; render();
  };

  function staffPickView() {
    var st = S.staff, list = S.pub ? S.pub.barbers.filter(function (b) { return b.hasLogin; }) : [];
    var cards = list.map(function (b) {
      return '<button type="button" class="pick-card" data-action="staff-pick" data-id="' + esc(b.id) + '">' + avatarHtml(b.name, b.photo) +
        '<div class="pick-name">' + esc(b.name) + '</div><div class="pick-meta">' + esc(b.title) + '</div></button>';
    }).join('');
    return '<div class="gate-wrap gate-wide"><h2 style="font-size:22px;margin-bottom:6px">Team sign-in &middot; Inicio de sesión</h2>' +
      (st.msg ? notice('', esc(st.msg)) : '') + (st.err ? notice('error', esc(st.err)) : '') +
      '<p class="step-hint" style="margin-top:8px">Tap your name, then enter your 6-digit PIN.<br>Toca tu nombre y escribe tu PIN de 6 dígitos.</p>' +
      (list.length ? '<div class="card-grid" style="margin-top:10px;text-align:left">' + cards + '</div>' :
        '<div class="empty-note">' + esc(STRINGS.en.noLogins) + '<br>' + esc(STRINGS.es.noLogins) + '</div>') + '</div>';
  }
  A['staff-pick'] = function (el) {
    var b = S.pub.barbers.filter(function (x) { return x.id === el.getAttribute('data-id'); })[0]; if (!b) return;
    S.staff.pickId = b.id; S.staff.lang = b.lang === 'es' ? 'es' : 'en'; S.staff.err = ''; S.staff.msg = ''; delete F['st.pin']; render();
    var i = document.getElementById(fid('st.pin')); if (i) i.focus();
  };
  A['staff-switch'] = function () { S.staff.pickId = null; S.staff.err = ''; delete F['st.pin']; render(); };

  function staffPinView() {
    var st = S.staff, b = S.pub.barbers.filter(function (x) { return x.id === st.pickId; })[0];
    if (!b) { st.pickId = null; return staffPickView(); }
    return '<div class="gate-wrap"><div class="gate-back"><button type="button" class="btn-text" data-action="staff-switch">' + esc(T('notYou', { name: b.name })) + '</button></div>' +
      langToggle() + avatarHtml(b.name, b.photo, 'gate-avatar') +
      '<div class="staff-hello">' + esc(T('signInAs')) + '</div><h2 style="font-size:24px">' + esc(b.name) + '</h2>' +
      '<form data-submit="staff-login" style="margin-top:16px" novalidate>' + (st.err ? notice('error', esc(st.err)) : '') +
      pinInp('st.pin', T('pinLabel'), { autofocus: true }) +
      '<button type="submit" class="btn btn-primary btn-block">' + esc(T('signInBtn')) + '</button></form></div>';
  }
  SUBMIT['staff-login'] = function () {
    var st = S.staff, pin = fv('st.pin');
    if (!/^\d{6}$/.test(pin)) { st.err = T('pinInvalid'); render(); return; }
    return api('POST', '/api/staff/login', { barberId: st.pickId, pin: pin }, { noAuth: true }).then(function (r) {
      delete F['st.pin'];
      if (r.ok) { st.err = ''; st.msg = ''; return loadStaffMe(); }
      st.err = staffErr(r); render();
    });
  };

  function staffSetupView() {
    var st = S.staff, info = st.info;
    return '<div class="gate-wrap">' + langToggle() +
      '<div class="pick-avatar" style="margin:0 auto 12px;width:64px;height:64px;font-size:22px">' + esc(initials(info.name)) + '</div>' +
      '<div class="staff-hello">' + esc(T('createLoginTitle')) + '</div><h2 style="font-size:24px">' + esc(info.name) + '</h2>' +
      '<p class="step-hint" style="margin-top:8px">' + esc(T('createLoginHint')) + '</p>' +
      '<form data-submit="staff-setup" style="margin-top:12px" novalidate>' + (st.err ? notice('error', esc(st.err)) : '') +
      pinInp('st.newpin', T('newPin'), { autofocus: true, ac: 'new-password' }) + pinInp('st.newpin2', T('confirmPin'), { ac: 'new-password' }) +
      '<button type="submit" class="btn btn-primary btn-block">' + esc(T('createLoginBtn')) + '</button></form></div>';
  }
  SUBMIT['staff-setup'] = function () {
    var st = S.staff, a = fv('st.newpin'), b = fv('st.newpin2');
    if (!/^\d{6}$/.test(a)) { st.err = T('pinInvalid'); render(); return; }
    if (a !== b) { st.err = T('pinMismatch'); render(); return; }
    return api('POST', '/api/staff/setup', { token: st.token, pin: a }, { noAuth: true }).then(function (r) {
      delete F['st.newpin']; delete F['st.newpin2'];
      if (!r.ok) {
        if (r.data && r.data.code === 'expired') { st.phase = 'expired'; }
        st.err = staffErr(r); render(); return;
      }
      st.err = ''; st.token = '';
      try { history.replaceState(null, '', location.pathname + '#staff'); } catch (e) { /* ignore */ }
      var wantLang = st.lang, serverLang = st.info && st.info.lang;
      var p = wantLang !== serverLang ? api('POST', '/api/staff/lang', { lang: wantLang }, { role: 'staff' }) : Promise.resolve();
      return p.then(function () { return loadStaffMe(); });
    });
  };

  A['staff-logout'] = function () {
    return api('POST', '/api/staff/logout', {}).then(function () {
      var st = S.staff; st.me = null; st.phase = 'login'; st.pickId = null; st.err = ''; st.msg = ''; st.lang = 'en';
      if (timers.own) { clearInterval(timers.own); timers.own = null; }
      loadPublic().then(render); render();
    });
  };
  A['staff-refresh'] = function () { return loadStaffMe(); };
  A['staff-mark'] = function (el) {
    return api('POST', '/api/staff/appointments/' + encodeURIComponent(el.getAttribute('data-id')) + '/status', { status: el.getAttribute('data-k') }, { role: 'staff' }).then(function (r) {
      if (!r.ok) S.staff.err = staffErr(r); else S.staff.err = '';
      return loadStaffMe();
    });
  };
  A['staff-off-mode'] = function (el) { S.staff.offAllDay = el.getAttribute('data-k') === 'all'; S.staff.offErr = ''; render(); };
  A['staff-add-off'] = function () {
    var st = S.staff, date = fv('st.offDate'), from = fv('st.offFrom'), to = fv('st.offTo');
    if (!date) { st.offErr = T('pickDateFirst'); render(); return; }
    if (!st.offAllDay) {
      if (!from || !to) { st.offErr = T('setStartEnd'); render(); return; }
      if (from >= to) { st.offErr = T('endAfterStart'); render(); return; }
    }
    return api('POST', '/api/staff/timeoff', { date: date, allDay: st.offAllDay, from: st.offAllDay ? undefined : from, to: st.offAllDay ? undefined : to }, { role: 'staff' }).then(function (r) {
      if (!r.ok) { st.offErr = staffErr(r); render(); return; }
      st.offErr = ''; delete F['st.offDate']; delete F['st.offFrom']; delete F['st.offTo']; st.offAllDay = true;
      return loadStaffMe();
    });
  };
  A['staff-rm-off'] = function (el) {
    return api('DELETE', '/api/staff/timeoff/' + encodeURIComponent(el.getAttribute('data-id')), undefined, { role: 'staff' }).then(function () { return loadStaffMe(); });
  };

  function staffScheduleView() {
    var st = S.staff, me = st.me, lang = curLang(), today = me.today;
    var list = me.appointments || [];
    var todayCount = list.filter(function (a) { return a.date === today; }).length;
    var weekEnd = addDaysISO(today, 6);
    var weekCount = list.filter(function (a) { return a.date <= weekEnd; }).length;
    var groups = {}, order = [];
    list.forEach(function (a) { if (!groups[a.date]) { groups[a.date] = []; order.push(a.date); } groups[a.date].push(a); });
    var listHtml = order.length ? order.map(function (date) {
      var label = date === today ? T('todayLabel') + ' — ' + fmtDateShort(date, lang) : fmtDateShort(date, lang);
      return '<div class="day-group"><h4>' + esc(label) + '</h4><div class="staff-list">' + groups[date].map(function (a) {
        return '<div class="staff-appt-row"><div class="st-time num">' + esc(fmtTime(a.time, lang)) + '</div>' +
          '<div class="st-body"><div class="st-name">' + esc(a.firstName) + '</div><div class="st-svc">' + esc(trService(a.service)) + ' &middot; ' + esc(a.duration) + ' ' + esc(T('minutes')) + '</div></div>' +
          '<div class="appt-actions"><button type="button" class="icon-btn" data-action="staff-mark" data-id="' + esc(a.id) + '" data-k="completed">' + esc(T('done')) + '</button>' +
          '<button type="button" class="icon-btn" data-action="staff-mark" data-id="' + esc(a.id) + '" data-k="no-show">' + esc(T('noShow')) + '</button></div></div>';
      }).join('') + '</div></div>';
    }).join('') : '<div class="empty-note">' + esc(T('noAppointments')) + '</div>';

    var offs = me.timeOff || [];
    var offList = offs.length ? offs.map(function (o) {
      var when = o.date === today ? T('todayLabel') : fmtDateShort(o.date, lang);
      var label = o.allDay ? T('allDay') : fmtTime(o.from, lang) + '–' + fmtTime(o.to, lang);
      return '<div class="off-item"><span>' + esc(when) + ' &middot; ' + esc(label) + '</span><button type="button" class="btn-text" data-action="staff-rm-off" data-id="' + esc(o.id) + '">' + esc(T('removeBtn')) + '</button></div>';
    }).join('') : '<div class="empty-note" style="padding:6px 0">' + esc(T('nothingBlocked')) + '</div>';

    var timeOff = '<section class="staff-timeoff"><h4>' + esc(T('timeOffHeading')) + '</h4><p class="step-hint">' + esc(T('timeOffHint')) + '</p><div class="off-list">' + offList + '</div>' +
      inp('st.offDate', { label: T('dateLabel'), type: 'date', attrs: 'min="' + esc(today) + '"' }) +
      '<div class="seg-row"><button type="button" class="seg-btn" data-action="staff-off-mode" data-k="all" aria-pressed="' + st.offAllDay + '">' + esc(T('wholeDayOff')) + '</button>' +
      '<button type="button" class="seg-btn" data-action="staff-off-mode" data-k="part" aria-pressed="' + !st.offAllDay + '">' + esc(T('runningLate')) + '</button></div>' +
      (st.offAllDay ? '' : '<div class="field-row">' + inp('st.offFrom', { label: T('blockFrom'), type: 'time' }) + inp('st.offTo', { label: T('blockUntil'), type: 'time' }) + '</div>') +
      (st.offErr ? '<div class="field-error" role="alert" style="margin-bottom:10px">' + esc(st.offErr) + '</div>' : '') +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="staff-add-off">' + esc(st.offAllDay ? T('blockDayBtn') : T('blockTimeBtn')) + '</button></section>';

    return '<div class="staff-hello" style="margin-top:14px">' + esc(T('signedInAs')) + '</div>' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:10px"><div><h2 style="font-size:28px" id="staff-name">' + esc(me.barber.name) + '</h2>' +
      '<div class="pick-meta">' + esc(trTitle(me.barber.title)) + '</div></div>' +
      '<div class="row-actions" style="margin:0"><button type="button" class="btn btn-ghost btn-sm" data-action="staff-refresh">' + esc(T('refresh')) + '</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="staff-logout">' + esc(T('signOut')) + '</button></div></div>' +
      langToggle(true) +
      (st.err ? notice('error', esc(st.err)) : '') +
      '<div class="stat-row" style="margin-top:8px"><div class="stat-tile"><div class="stat-label">' + esc(T('today')) + '</div><div class="stat-value num">' + todayCount + '</div></div>' +
      '<div class="stat-tile"><div class="stat-label">' + esc(T('next7')) + '</div><div class="stat-value num">' + weekCount + '</div></div></div>' +
      '<p class="step-hint">' + esc(T('privacyHint')) + '</p>' + listHtml + timeOff;
  }

  /* =====================================================================
     SHOP SCREEN (TV board) — spreadsheet grid, polls every 20 seconds
     ===================================================================== */
  function initBoard() {
    var b = S.board;
    b.err = ''; b.phase = 'loading'; b.lockAsk = false; render();
    var pubP = S.pub ? Promise.resolve() : loadPublic();
    return Promise.all([api('GET', '/api/board/session'), pubP]).then(function (res) {
      if (S.route !== 'board') return;
      var r = res[0];
      b.configured = r.ok ? r.data.configured !== false : true;
      if (r.ok && r.data.authed) return startBoardLive();
      b.phase = 'gate';
      if (!r.ok) b.err = errMsg(r, NET_MSG);
      render();
    });
  }
  function startBoardLive() {
    var b = S.board;
    b.phase = 'live'; b.data = null; b.stale = false; b.err = '';
    if (timers.poll) clearInterval(timers.poll);
    if (timers.tick) clearInterval(timers.tick);
    render();
    var p = fetchBoard();
    timers.poll = setInterval(fetchBoard, 20000);
    timers.tick = setInterval(function () { if (S.route === 'board' && S.board.phase === 'live') render(); }, 15000);
    return p;
  }
  function fetchBoard() {
    return api('GET', '/api/board', undefined, { role: 'board', timeout: 15000 }).then(function (r) {
      var b = S.board;
      if (S.route !== 'board' || b.phase !== 'live') return;
      if (r.ok) { b.data = r.data; b.fetchedAt = performance.now(); b.stale = false; render(); }
      else if (r.status !== 401) { b.stale = true; render(); }
    });
  }

  function viewBoardGate() {
    var b = S.board;
    if (b.phase === 'loading') return '<div class="center-stage">' + spinner('spinner-lg') + '<p class="step-hint">Loading…</p></div>';
    if (!b.configured) {
      return '<div class="gate-wrap"><h2 style="font-size:22px">Shop screen</h2>' +
        notice('', '<span>This screen isn’t set up yet. The owner needs to choose a 6-digit screen PIN under <b>Settings</b> in the owner dashboard.</span>') + '</div>';
    }
    return '<div class="gate-wrap"><h2 style="font-size:22px">Shop screen</h2>' +
      '<p class="step-hint" style="margin-top:8px">For the TV at the shop. Enter the screen PIN once &mdash; this device stays signed in for 30 days.</p>' +
      '<form data-submit="board-login" style="margin-top:16px" novalidate>' + (b.err ? notice('error', esc(b.err)) : '') +
      pinInp('bd.pin', 'Screen PIN (6 digits)', { autofocus: true }) +
      '<button type="submit" class="btn btn-primary btn-block">Show today’s board</button></form></div>';
  }
  SUBMIT['board-login'] = function () {
    var b = S.board, pin = fv('bd.pin');
    if (!/^\d{6}$/.test(pin)) { b.err = 'The screen PIN is 6 digits.'; render(); return; }
    return api('POST', '/api/board/login', { pin: pin }, { noAuth: true }).then(function (r) {
      delete F['bd.pin'];
      if (r.ok) return startBoardLive();
      b.err = errMsg(r); render();
    });
  };
  A['board-lock'] = function () {
    var b = S.board;
    if (!b.lockAsk) {
      b.lockAsk = true; render();
      setTimeout(function () { if (S.board.lockAsk) { S.board.lockAsk = false; if (S.route === 'board' && S.board.phase === 'live') render(); } }, 5000);
      return;
    }
    return api('POST', '/api/board/logout', {}).then(function () {
      if (timers.poll) { clearInterval(timers.poll); timers.poll = null; }
      if (timers.tick) { clearInterval(timers.tick); timers.tick = null; }
      b.phase = 'gate'; b.data = null; b.lockAsk = false; b.err = ''; render();
    });
  };
  A['board-fs'] = function () {
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
    } catch (e) { /* not available */ }
  };

  function viewBoardLive() {
    var b = S.board, d = b.data;
    var foot = function () {
      return '<div class="bd-foot"><span class="fine">First name &amp; last initial only &mdash; no phone numbers shown here. Empty boxes are open chairs.' +
        (b.stale ? ' <span class="bd-stale">&middot; Reconnecting…</span>' : '') + '</span>' +
        '<span class="bd-actions"><button type="button" data-action="board-fs">Full screen</button><button type="button" data-action="board-lock">' + (b.lockAsk ? 'Tap again to lock this screen' : 'Lock') + '</button></span></div>';
    };
    if (!d) {
      return '<div class="bd-head"><div><div class="bd-title">Today’s chairs</div></div></div><div class="bd-closed" style="font-size:calc(var(--u)*3)" role="status">' + (b.stale ? 'Can’t reach the server — retrying…' : 'Loading today’s board…') + '</div>' + foot();
    }
    var nowMin = Math.min(1439, d.minutes + Math.floor((performance.now() - b.fetchedAt) / 60000));
    var head = '<div class="bd-head"><div><div class="bd-title">Today’s chairs</div><div class="bd-date">' + esc(fmtDateLong(d.date)) + '</div></div>' +
      '<div class="bd-clock num" id="bd-clock" aria-label="Current time">' + esc(fmtTime(minToHHMM(nowMin))) + '</div></div>';
    if (!d.shopOpen) return head + '<div class="bd-closed">The shop is closed today.</div>' + foot();

    var dayStart = d.shopOpen.open * 60, dayEnd = d.shopOpen.close * 60;
    d.barbers.forEach(function (bb) {
      if (bb.working && bb.hours) { dayStart = Math.min(dayStart, bb.hours.open * 60); dayEnd = Math.max(dayEnd, bb.hours.close * 60); }
    });
    var rows = Math.max(1, Math.ceil((dayEnd - dayStart) / 30)), nB = d.barbers.length, cells = '';
    cells += '<div class="bd-corner" style="grid-row:1;grid-column:1"></div>';
    d.barbers.forEach(function (bb, c) {
      cells += '<div class="bd-head-cell" style="grid-row:1;grid-column:' + (c + 2) + '"><span class="nm">' + esc(bb.name) + '</span>' + (!bb.working ? '<span class="bd-offtag">Off today</span>' : '') + '</div>';
    });
    for (var r = 0; r < rows; r++) {
      var rs = dayStart + r * 30, re = rs + 30, isNow = nowMin >= rs && nowMin < re, past = re <= nowMin;
      cells += '<div class="bd-time num' + (isNow ? ' is-now' : '') + (past ? ' bd-past' : '') + (rs % 60 === 0 ? ' is-hour' : '') + '" style="grid-row:' + (r + 2) + ';grid-column:1">' + esc(fmtTime(minToHHMM(rs))) + '</div>';
      d.barbers.forEach(function (bb, c) {
        var cls = 'bd-cell' + (past ? ' bd-past' : ''), note = '';
        if (!bb.working) cls += ' is-closed';
        else {
          var h = bb.hours, inHours = !!h && rs >= h.open * 60 && re <= h.close * 60;
          if (!inHours) cls += ' is-closed';
          else if ((bb.blocked || []).some(function (x) { return rs < x.end && re > x.start; })) { cls += ' is-break'; note = '<span class="bd-note">Break</span>'; }
        }
        cells += '<div class="' + cls + '" style="grid-row:' + (r + 2) + ';grid-column:' + (c + 2) + '">' + note + '</div>';
      });
    }
    var colOf = {}; d.barbers.forEach(function (bb, c) { colOf[bb.id] = c; });
    (d.bookings || []).forEach(function (bk) {
      var c = colOf[bk.barberId]; if (c === undefined) return;
      var s = hhmmToMin(bk.time), e = s + (bk.duration || 30);
      var r0 = Math.floor((s - dayStart) / 30); if (r0 < 0) r0 = 0; if (r0 >= rows) return;
      var r1 = Math.ceil((e - dayStart) / 30); if (r1 <= r0) r1 = r0 + 1; if (r1 > rows) r1 = rows;
      var cls = 'bd-chip' + (r1 - r0 >= 2 ? ' is-tall' : '');
      if (bk.status === 'completed') cls += ' is-done'; else if (bk.status === 'no-show') cls += ' is-noshow';
      else if (e <= nowMin) cls += ' is-past'; else if (s <= nowMin) cls += ' is-live';
      var tag = bk.status === 'no-show' ? '<em>no-show</em>' : (bk.status === 'completed' ? '<em>done</em>' : '');
      cells += '<div class="' + cls + '" style="grid-row:' + (r0 + 2) + '/' + (r1 + 2) + ';grid-column:' + (c + 2) + '"><div class="bd-name">' + esc(bk.label) + tag + '</div>' +
        (bk.service ? '<div class="bd-svc">' + esc(bk.service) + '</div>' : '') + '</div>';
    });
    if (nowMin >= dayStart && nowMin < dayEnd) {
      var nr = Math.floor((nowMin - dayStart) / 30), pct = Math.round(((nowMin - dayStart) % 30) / 30 * 100);
      cells += '<div class="bd-nowline" style="grid-row:' + (nr + 2) + ';--p:' + pct + '"></div>';
    }
    return head + '<div class="bd-wrap"><div class="bd-grid" style="--cols:' + nB + ';--rows:' + rows + '">' + cells + '</div></div>' + foot();
  }

  /* =====================================================================
     OWNER dashboard
     ===================================================================== */
  var O = S.owner;
  function normPhone(p) { return String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); }
  function clearKeys(prefix) { Object.keys(F).forEach(function (k) { if (k.indexOf(prefix) === 0) delete F[k]; }); }
  function setFlash(key, kind, text) { O.fl[key] = { kind: kind, text: text }; }
  function flashHtml(key) { var f = O.fl[key]; return f ? notice(f.kind === 'ok' ? 'ok' : 'error', esc(f.text)) : ''; }

  function initOwner() {
    O.err = ''; O.phase = 'loading'; render();
    var pubP = S.pub ? Promise.resolve() : loadPublic();
    return Promise.all([api('GET', '/api/setup/status'), pubP]).then(function (res) {
      if (S.route !== 'owner') return;
      var r = res[0];
      if (!r.ok) { O.phase = 'login'; O.err = errMsg(r, NET_MSG); render(); return; }
      O.setupInfo = r.data;
      if (r.data.needsSetup) { O.phase = 'setup'; render(); return; }
      return api('GET', '/api/owner/session').then(function (s) {
        if (S.route !== 'owner') return;
        if (s.ok && s.data.authed) return loadOwner(true);
        O.phase = 'login'; render();
      });
    });
  }
  function loadOwner(first) {
    return api('GET', '/api/owner/state', undefined, { role: 'owner' }).then(function (r) {
      if (S.route !== 'owner') return r;
      if (r.ok) {
        O.st = r.data; O.phase = 'dash';
        if (first || !O.date) O.date = r.data.today;
        if (first) { O.tab = 'today'; O.fl = {}; }
        if (!timers.own) timers.own = setInterval(refreshOwner, 60000);
      } else if (r.status !== 401) { O.phase = 'login'; O.err = errMsg(r); }
      render(); return r;
    });
  }
  function refreshOwner() {
    if (S.route !== 'owner' || O.phase !== 'dash') return null;
    return api('GET', '/api/owner/state', undefined, { role: 'owner' }).then(function (r) {
      if (!r.ok || S.route !== 'owner' || O.phase !== 'dash') return;
      if (JSON.stringify(r.data) !== JSON.stringify(O.st)) { O.st = r.data; renderIfIdle(); }
    });
  }
  function reloadOwner() {
    return api('GET', '/api/owner/state', undefined, { role: 'owner' }).then(function (r) { if (r.ok) O.st = r.data; render(); return r; });
  }
  // one owner call: show the result next to the form it came from, then refresh everything
  function oCall(fk, method, url, body, okText) {
    return api(method, url, body, { role: 'owner' }).then(function (r) {
      if (r.status === 401) return r;
      if (!r.ok) { setFlash(fk, 'error', errMsg(r)); render(); return r; }
      setFlash(fk, 'ok', okText || 'Saved.');
      return reloadOwner().then(function () { return r; });
    });
  }

  function viewOwner() {
    if (O.phase === 'loading') return '<div class="center-stage">' + spinner('spinner-lg') + '<p class="step-hint">Loading…</p></div>';
    if (O.phase === 'setup') return ownerSetupView();
    if (O.phase === 'login') return ownerLoginView();
    return ownerDash();
  }

  /* ---------- sign in / first-time setup ---------- */
  function ownerLoginView() {
    return '<div class="gate-wrap"><h2 style="font-size:22px">Owner sign-in</h2>' +
      '<form data-submit="owner-login" style="margin-top:14px" novalidate>' +
      (O.msg ? notice('', esc(O.msg)) : '') + (O.err ? notice('error', esc(O.err)) : '') +
      inp('ol.email', { label: 'Email', type: 'email', attrs: 'autocomplete="username" inputmode="email" required' }) +
      inp('ol.pw', { label: 'Password', type: 'password', attrs: 'autocomplete="current-password" required' }) +
      '<button type="submit" class="btn btn-primary btn-block">Sign in</button></form></div>';
  }
  SUBMIT['owner-login'] = function () {
    var email = fv('ol.email').trim(), pw = fv('ol.pw');
    if (!email || !pw) { O.err = 'Enter your email and password.'; render(); return; }
    return api('POST', '/api/owner/login', { email: email, password: pw }, { noAuth: true }).then(function (r) {
      delete F['ol.pw'];
      if (r.ok) { O.err = ''; O.msg = ''; return loadOwner(true); }
      O.err = errMsg(r); O.msg = ''; render();
    });
  };
  function ownerSetupView() {
    var info = O.setupInfo || {};
    return '<div class="gate-wrap"><h2 style="font-size:22px">Set up your owner account</h2>' +
      '<p class="step-hint" style="margin-top:8px">First-time setup. You’ll need the setup key from the server’s settings (the <span class="mono">SETUP_KEY</span> value).</p>' +
      (info.setupKeyConfigured === false ? notice('error', '<span>This server has no setup key configured, so the owner account can’t be created yet.</span>') : '') +
      '<form data-submit="owner-setup" novalidate>' + (O.err ? notice('error', esc(O.err)) : '') +
      inp('os.key', { label: 'Setup key', type: 'password', attrs: 'autocomplete="off" required' }) +
      inp('os.email', { label: 'Your email', type: 'email', attrs: 'autocomplete="username" inputmode="email" required' }) +
      inp('os.pw', { label: 'Password (10+ characters)', type: 'password', attrs: 'autocomplete="new-password" minlength="10" required' }) +
      inp('os.pw2', { label: 'Confirm password', type: 'password', attrs: 'autocomplete="new-password" required' }) +
      '<button type="submit" class="btn btn-primary btn-block">Create account</button></form></div>';
  }
  SUBMIT['owner-setup'] = function () {
    var key = fv('os.key'), email = fv('os.email').trim(), pw = fv('os.pw'), pw2 = fv('os.pw2');
    if (!key) { O.err = 'Enter the setup key.'; render(); return; }
    if (!email) { O.err = 'Enter your email address.'; render(); return; }
    if (pw.length < 10) { O.err = 'Choose a password of at least 10 characters.'; render(); return; }
    if (pw !== pw2) { O.err = 'The two passwords don’t match.'; render(); return; }
    return api('POST', '/api/setup', { setupKey: key, email: email, password: pw }, { noAuth: true }).then(function (r) {
      if (r.ok) { clearKeys('os.'); O.err = ''; return loadOwner(true); }
      O.err = errMsg(r); render();
    });
  };
  A['o-logout'] = function () {
    return api('POST', '/api/owner/logout', {}).then(function () {
      O.phase = 'login'; O.st = null; O.err = ''; O.msg = ''; O.invites = {}; clearKeys('');
      if (timers.own) { clearInterval(timers.own); timers.own = null; }
      render();
    });
  };
  A['o-refresh'] = function () { return reloadOwner(); };
  A['o-tab'] = function (el) { O.tab = el.getAttribute('data-k'); O.fl = {}; O.ask = ''; render(); };

  function ownerDash() {
    var st = O.st, tabs = [['today', 'Bookings'], ['team', 'Team'], ['customers', 'Customers'], ['settings', 'Settings']];
    var body = O.tab === 'team' ? tabTeam() : O.tab === 'customers' ? tabCustomers() : O.tab === 'settings' ? tabSettings() : tabToday();
    return '<div class="dash-head"><div><div class="staff-hello">Owner dashboard</div><h2>' + esc(st.shop.name) + '</h2></div>' +
      '<div class="row-actions" style="margin:0"><button type="button" class="btn btn-ghost btn-sm" data-action="o-refresh">Refresh</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="o-logout">Log out</button></div></div>' +
      '<div class="dash-tabs" role="tablist" aria-label="Dashboard sections">' + tabs.map(function (t) {
        return '<button type="button" role="tab" class="tab-btn" data-action="o-tab" data-k="' + t[0] + '" aria-selected="' + (O.tab === t[0]) + '">' + t[1] + '</button>';
      }).join('') + '</div><div role="tabpanel" style="margin-top:16px">' + body + '</div>';
  }

  /* ---------- Bookings tab ---------- */
  function tabToday() {
    var st = O.st, shop = st.shop, today = st.today, date = O.date || today;
    var barberName = {}; st.barbers.forEach(function (b) { barberName[b.id] = b.name; });
    var svcName = {}, svcById = {}; st.services.forEach(function (s) { svcName[s.id] = s.name; svcById[s.id] = s; });
    var blockedSet = {}; st.blocked.forEach(function (b) { blockedSet[b.norm] = true; });

    var conflicts = st.bookings.filter(function (b) { return b.conflict; }).map(function (b) {
      return notice('error', '<span><b>Needs a new time:</b> ' + esc(b.customerName) + (b.contactName && b.contactName !== b.customerName ? ' (booked by ' + esc(b.contactName) + ')' : '') + ' &middot; ' + esc(b.phone) + ' &mdash; ' + esc(barberName[b.barberId] || 'barber') + ' on ' + esc(fmtDateShort(b.date)) + ' at ' + esc(fmtTime(b.time)) + ': ' + esc(CONFLICT_TEXT[b.conflict] || 'the schedule changed') + '. Move them so they keep their spot' + (b.feePaid ? ' and their booking fee' : '') + '.</span>' +
        '<div class="appt-actions" style="margin-top:8px">' + contactLinks(b.phone, b.contactName || b.customerName, b.time, true) + '<button type="button" class="icon-btn" data-action="o-rs-open" data-id="' + esc(b.id) + '" data-k="banner">Reschedule</button></div>') + (O.rs && O.rs.id === b.id && O.rs.from === 'banner' ? '<div class="panel-card" style="margin:-6px 0 16px">' + rsPanel(b, 'banner') + '</div>' : '');
    }).join('');
    var refunds = st.bookings.filter(function (b) { return b.needsRefund && !b.refunded; }).map(function (b) {
      return notice('error', '<span><b>Refund needed:</b> ' + esc(b.customerName) + (b.contactName && b.contactName !== b.customerName ? ' (booked by ' + esc(b.contactName) + ')' : '') + ' &middot; ' + esc(b.phone) + ' &mdash; ' + esc(fmtMoney((b.feeCents || 0) / 100)) + ' booking fee for ' + esc(fmtDateShort(b.date)) + ' at ' + esc(fmtTime(b.time)) + '. That appointment is cancelled, so the fee is due back to them.</span>' +
        '<div class="appt-actions" style="margin-top:8px">' + contactLinks(b.phone, b.contactName || b.customerName, b.time, true) + refundControls(b) + '<button type="button" class="icon-btn" data-action="o-refund-done" data-id="' + esc(b.id) + '">Already refunded in Stripe</button></div>');
    }).join('');
    var mailWarn = st.system.email && st.system.email.failed > 0 ? notice('error', '<span><b>' + plural(st.system.email.failed, 'email', 'emails') + ' could not be sent.</b> See System status under Settings.</span>') : '';

    var from = addDaysISO(today, -6);
    var recent = st.bookings.filter(function (b) { return b.date >= from && b.date <= today; });
    var live = recent.filter(function (b) { return b.status !== 'cancelled'; });
    var todayCount = st.bookings.filter(function (b) { return b.date === today && b.status !== 'cancelled'; }).length;
    var paid = function (list) { return list.filter(function (b) { return b.feePaid && !b.needsRefund; }).length * shop.bookingFee; };
    var stats = '<div class="stat-row"><div class="stat-tile"><div class="stat-label">Today’s appointments</div><div class="stat-value num">' + todayCount + '</div></div>' +
      '<div class="stat-tile"><div class="stat-label">Fee revenue, 7 days</div><div class="stat-value num">' + esc(fmtMoney(paid(live))) + '</div></div>' +
      '<div class="stat-tile"><div class="stat-label">No-shows, 7 days</div><div class="stat-value num">' + recent.filter(function (b) { return b.status === 'no-show'; }).length + '</div></div>' +
      '<div class="stat-tile"><div class="stat-label">Bookings, 7 days</div><div class="stat-value num">' + live.length + '</div></div></div>';
    var brRows = st.barbers.map(function (b) {
      var mine = live.filter(function (x) { return x.barberId === b.id; });
      return '<tr><td>' + esc(b.name) + '</td><td class="num">' + mine.length + '</td><td class="num">' + mine.filter(function (x) { return x.status === 'completed'; }).length + '</td><td class="num">' + mine.filter(function (x) { return x.status === 'no-show'; }).length + '</td><td class="num">' + esc(fmtMoney(paid(mine))) + '</td></tr>';
    }).join('');
    var breakdown = '<h4 class="section-eyebrow" style="margin:8px 0">Per barber, last 7 days</h4><div class="tbl-wrap"><table class="breakdown-table"><thead><tr><th>Barber</th><th class="num">Appts</th><th class="num">Done</th><th class="num">No-show</th><th class="num">Fee rev.</th></tr></thead><tbody>' + brRows + '</tbody></table></div>';

    var counts = {}; st.bookings.forEach(function (b) { if (b.status !== 'cancelled') counts[b.date] = (counts[b.date] || 0) + 1; });
    var strip = '<div class="cal-strip" role="group" aria-label="Pick a day">';
    for (var i = 0; i < 21; i++) {
      var dd = addDaysISO(today, i), c = counts[dd] || 0;
      strip += '<button type="button" class="cal-day" data-action="o-date" data-k="' + dd + '" aria-pressed="' + (dd === date) + '" aria-label="' + esc(fmtDateLong(dd)) + ', ' + plural(c, 'appointment', 'appointments') + '">' +
        DOW3[dowOf(dd)] + '<span class="dom">' + isoParts(dd).d + '</span><span class="cnt">' + (c ? c + ' booked' : '') + '</span></button>';
    }
    strip += '</div>';

    var toolbar = '<div class="dash-toolbar"><div class="date-nav"><button type="button" class="btn btn-ghost btn-sm" data-action="o-date-step" data-k="-1" aria-label="Previous day">&larr;</button>' +
      '<b>' + esc(fmtDateLong(date)) + '</b><button type="button" class="btn btn-ghost btn-sm" data-action="o-date-step" data-k="1" aria-label="Next day">&rarr;</button>' +
      '<button type="button" class="btn-text" data-action="o-date" data-k="' + esc(today) + '">Today</button></div>' +
      '<button type="button" class="btn btn-primary btn-sm" data-action="o-na-toggle">' + (O.naOpen ? 'Close' : '+ New appointment') + '</button></div>';

    var day = st.bookings.filter(function (b) { return b.date === date; });
    var board = '<div class="day-board">' + st.barbers.map(function (b) {
      var appts = day.filter(function (x) { return x.barberId === b.id; }).sort(function (a, c) { return a.time.localeCompare(c.time); });
      var offAll = (b.timeOff || []).some(function (o) { return o.date === date && o.allDay; });
      var offPart = (b.timeOff || []).some(function (o) { return o.date === date && !o.allDay; });
      var tag = offAll ? ' <span class="pill pill-off">Off</span>' : (offPart ? ' <span class="pill pill-off">Blocked time</span>' : ((b.daysOff || []).indexOf(dowOf(date)) !== -1 ? ' <span class="pill pill-off">Day off</span>' : ''));
      return '<div class="board-col"><h4>' + esc(b.name) + tag + '</h4>' + (appts.length ? appts.map(function (a) {
        var norm = normPhone(a.phone);
        return '<div class="appt-card"><div class="appt-time num">' + esc(fmtTime(a.time)) + '</div><div class="appt-service">' + esc(svcName[a.serviceId] || '') + ' &middot; ' + esc(a.duration) + ' min</div>' +
          '<div class="appt-cust">' + esc(a.customerName) + '</div>' +
          (a.contactName && a.contactName !== a.customerName ? '<div class="pick-meta">Booked by ' + esc(a.contactName) + '</div>' : '') +
          (a.phone ? '<div class="pick-meta">Client phone: <a href="tel:' + esc(safeTel(a.phone)) + '">' + esc(a.phone) + '</a></div><div class="appt-actions">' + contactLinks(a.phone, a.customerName, a.time) + '</div>' : '') +
          (a.email ? '<div class="pick-meta">' + esc(a.email) + '</div>' : '') +
          (a.notes ? '<div class="pick-meta">“' + esc(a.notes) + '”</div>' : '') +
          (a.conflict ? '<div class="pick-meta" style="color:var(--error);font-weight:700">Needs a new time: ' + esc(CONFLICT_TEXT[a.conflict] || 'the schedule changed') + '</div>' : '') +
          '<div class="pick-meta">' + (a.source === 'owner' ? 'Added by you' : 'Booked online') + ' &middot; ' + (a.feePaid ? 'fee paid' : 'no fee') + '</div>' +
          '<span class="pill pill-' + esc(a.status) + '">' + esc(a.status.replace('-', ' ')) + '</span>' +
          (a.status === 'upcoming' ? '<div class="appt-actions">' +
            '<button type="button" class="icon-btn" data-action="o-status" data-id="' + esc(a.id) + '" data-k="completed">Complete</button>' +
            '<button type="button" class="icon-btn" data-action="o-status" data-id="' + esc(a.id) + '" data-k="no-show">No-show</button>' +
            (O.ask === 'cancel:' + a.id
              ? '<span class="pick-meta" style="align-self:center">Cancel this booking?</span><button type="button" class="icon-btn danger" data-action="o-status" data-id="' + esc(a.id) + '" data-k="cancelled">Yes, cancel</button><button type="button" class="icon-btn" data-action="o-ask" data-k="">Keep</button>'
              : '<button type="button" class="icon-btn" data-action="o-ask" data-k="cancel:' + esc(a.id) + '">Cancel</button>') + '</div>' : '') +
          ((a.status === 'upcoming' || a.status === 'no-show') ? '<div class="appt-actions"><button type="button" class="icon-btn" data-action="o-rs-open" data-id="' + esc(a.id) + '" data-k="card">Reschedule</button></div>' + rsPanel(a, 'card') : '') +
          (a.feePaid && a.feeCents > 0 ? '<div class="appt-actions">' + refundControls(a) + '</div>' : '') +
          (a.phone ? '<div class="appt-actions">' + (blockedSet[norm]
            ? '<span class="pick-meta" style="font-weight:700">Blocked from booking online</span>'
            : '<button type="button" class="icon-btn" data-action="o-block-phone" data-id="' + esc(a.phone) + '" data-k="' + esc(a.customerName) + '">Block this number</button>') + '</div>' : '') +
          '</div>';
      }).join('') : '<div class="empty-note" style="padding:4px 0">No appointments.</div>') + '</div>';
    }).join('') + '</div>';

    return conflicts + refunds + mailWarn + flashHtml('today') + stats + breakdown + toolbar + (O.naOpen ? newApptPanel() : '') + strip + board;
  }
  /* ---- owner: move a client to another time / barber (fee goes with them) ---- */
  var CONFLICT_TEXT = { day_off: 'the barber is off that day', time_off: 'the barber blocked that time', outside_hours: 'it is outside the barber’s hours', shop_closed: 'the shop is closed then', barber_removed: 'that barber is no longer on the team' };
  function findBooking(id) { return O.st.bookings.filter(function (b) { return b.id === id; })[0]; }
  function rsPanel(a, from) {
    var rs = O.rs; if (!rs || rs.id !== a.id || rs.from !== from) return '';
    var chips = '<div class="seg-row" role="group" aria-label="Barber">' +
      O.st.barbers.map(function (b) { return '<button type="button" class="seg-btn" data-action="o-rs-barber" data-k="' + esc(b.id) + '" aria-pressed="' + (rs.barberId === b.id) + '">' + (b.id === a.barberId ? esc(b.name) + ' (same)' : esc(b.name)) + '</button>'; }).join('') +
      '<button type="button" class="seg-btn" data-action="o-rs-barber" data-k="any" aria-pressed="' + (rs.barberId === 'any') + '">Any barber</button></div>';
    var body;
    if (rs.loading || !rs.avail) body = '<div class="loading-row">' + spinner() + '<span>Checking open times…</span></div>';
    else if (!rs.avail.some(function (x) { return x.slots.length; })) body = '<div class="empty-note">No open times in the next 3 weeks for this choice. Try another barber.</div>';
    else {
      var row = '<div class="day-row" role="group" aria-label="Choose a day">' + rs.avail.map(function (x) {
        var p = isoParts(x.date);
        return '<button type="button" class="day-btn" data-action="o-rs-date" data-date="' + esc(x.date) + '" aria-pressed="' + (rs.date === x.date) + '" aria-label="' + esc(fmtDateLong(x.date)) + '"' + (x.slots.length ? '' : ' disabled') + '>' +
          '<span class="dow">' + DOW3[dowOf(x.date)] + '</span><span class="dom">' + p.d + '</span><span class="mon">' + MON_EN[p.m - 1].slice(0, 3) + '</span></button>';
      }).join('') + '</div>';
      var day = rs.avail.filter(function (x) { return x.date === rs.date; })[0];
      var slots = day && day.slots.length ? '<div class="slot-grid" role="group" aria-label="Choose a time">' + day.slots.map(function (s) {
        return '<button type="button" class="slot-btn num" data-action="o-rs-time" data-time="' + esc(s.time) + '" data-barber="' + esc(s.barberId) + '" aria-pressed="' + (rs.time === s.time) + '">' + esc(fmtTime(s.time)) + '</button>';
      }).join('') + '</div>' : '<div class="empty-note">Pick a day above.</div>';
      body = row + (rs.date ? '<div class="cat-heading" style="margin-top:4px">' + esc(fmtDateLong(rs.date)) + '</div>' : '') + slots;
    }
    return '<div class="rs-panel" style="margin-top:10px;padding-top:10px;border-top:1px dashed var(--line-strong)"><div class="cat-heading">Move ' + esc(a.customerName) + ' to…</div>' + chips + body +
      (a.email ? checkbox('rs.email', 'Email ' + esc(a.customerName.split(' ')[0]) + ' the new time', true, 'data-change="o-rs-email"') : '<div class="hint">No email on file. Call or text them the new time.</div>') +
      '<div class="hint">' + (a.feePaid && a.feeCents > 0 ? 'Their ' + esc(fmtMoney(a.feeCents / 100)) + ' booking fee moves with them. They pay nothing more and lose nothing.' : 'No booking fee was charged for this appointment.') + '</div>' +
      (rs.err ? notice('error', esc(rs.err)) : '') +
      '<div class="appt-actions"><button type="button" class="btn btn-primary btn-sm" data-action="o-rs-move" data-id="' + esc(a.id) + '"' + (rs.date && rs.time && !rs.busy ? '' : ' disabled') + '>' + (rs.busy ? 'Moving…' : 'Move appointment') + '</button>' +
      '<button type="button" class="icon-btn" data-action="o-rs-close">Never mind</button></div></div>';
  }
  function rsLoad() {
    var rs = O.rs, a = rs && findBooking(rs.id); if (!a) return;
    rs.loading = true; rs.avail = null; rs.date = null; rs.time = null; rs.err = '';
    render();
    return api('GET', '/api/availability?service=' + encodeURIComponent(a.serviceId) + '&barber=' + encodeURIComponent(rs.barberId) + '&days=21', undefined, { role: 'owner' }).then(function (r) {
      if (O.rs !== rs) return;
      rs.loading = false;
      if (r.ok) { rs.avail = r.data.days; var f = rs.avail.filter(function (x) { return x.slots.length; })[0]; if (f) rs.date = f.date; } else { rs.avail = []; rs.err = errMsg(r); }
      render();
    });
  }
  A['o-rs-open'] = function (el) {
    var id = el.getAttribute('data-id'), a = findBooking(id); if (!a) return;
    O.ask = ''; delete F['rs.email'];
    O.rs = { id: id, from: el.getAttribute('data-k') || 'card', barberId: a.barberId, avail: null, loading: true, date: null, time: null, slotBarber: null, busy: false, err: '' };
    return rsLoad();
  };
  A['o-rs-close'] = function () { O.rs = null; render(); };
  A['o-rs-barber'] = function (el) { if (!O.rs) return; O.rs.barberId = el.getAttribute('data-k'); return rsLoad(); };
  A['o-rs-date'] = function (el) { if (!O.rs) return; O.rs.date = el.getAttribute('data-date'); O.rs.time = null; O.rs.err = ''; render(); };
  A['o-rs-time'] = function (el) { if (!O.rs) return; O.rs.time = el.getAttribute('data-time'); O.rs.slotBarber = el.getAttribute('data-barber'); O.rs.err = ''; render(); };
  A['o-rs-email'] = function () { /* value is kept in F['rs.email'] */ };
  A['o-rs-move'] = function (el) {
    var rs = O.rs, id = el.getAttribute('data-id'), a = findBooking(id); if (!rs || !a || rs.busy || !rs.date || !rs.time) return;
    rs.busy = true; rs.err = ''; render();
    var emailClient = !!a.email && fv('rs.email', true);
    return api('POST', '/api/owner/bookings/' + encodeURIComponent(id) + '/reschedule', { barberId: rs.barberId === 'any' ? (rs.slotBarber || 'any') : rs.barberId, date: rs.date, time: rs.time, emailClient: emailClient }, { role: 'owner' }).then(function (r) {
      if (O.rs !== rs) return;
      rs.busy = false;
      if (r.status === 401) return;
      if (!r.ok) { rs.err = errMsg(r); if (r.data && r.data.code === 'slot_taken') return rsLoad(); render(); return; }
      var name = a.customerName;
      O.rs = null; delete F['rs.email'];
      setFlash('today', 'ok', 'Moved ' + name + ' to ' + fmtDateLong(rs.date) + ' at ' + fmtTime(rs.time) + '. Their booking fee stays with them.' + (r.data.emailed ? ' We emailed them the new time.' : ' Remember to tell them the new time.'));
      return reloadOwner();
    });
  };
  // one tap to call or text a client (owner only; barbers and the TV never see phone numbers)
  function contactLinks(phone, name, time, plain) {
    var tel = safeTel(phone); if (!tel) return '';
    if (plain) return '<a class="icon-btn" href="tel:' + esc(tel) + '" aria-label="Call ' + esc(name) + '">Call</a><a class="icon-btn" href="sms:' + esc(tel) + '" aria-label="Text ' + esc(name) + '">Text</a>';
    var msg = 'Hi ' + String(name || '').trim().split(/\s+/)[0] + ', this is ' + shopName() + '. Your appointment was at ' + fmtTime(time) + '. Are you on your way?';
    return '<a class="icon-btn" href="tel:' + esc(tel) + '" aria-label="Call ' + esc(name) + '">Call</a>' +
      '<a class="icon-btn" href="sms:' + esc(tel) + '?&amp;body=' + esc(encodeURIComponent(msg)) + '" aria-label="Text ' + esc(name) + '">Text</a>';
  }
  function refundControls(b) {
    if (!b.feePaid || b.refunded || !(b.feeCents > 0)) return b.refunded ? '<span class="pill pill-completed">Fee refunded</span>' : '';
    var amt = fmtMoney(b.feeCents / 100);
    return O.ask === 'refund:' + b.id
      ? '<span class="pick-meta" style="align-self:center">Refund ' + esc(amt) + ' to their card now?</span><button type="button" class="icon-btn danger" data-action="o-refund" data-id="' + esc(b.id) + '">Yes, refund ' + esc(amt) + '</button><button type="button" class="icon-btn" data-action="o-ask" data-k="">Keep</button>'
      : '<button type="button" class="icon-btn" data-action="o-ask" data-k="refund:' + esc(b.id) + '">Refund ' + esc(amt) + '</button>';
  }
  A['o-refund'] = function (el) {
    var id = el.getAttribute('data-id'); O.ask = '';
    return oCall('today', 'POST', '/api/owner/bookings/' + encodeURIComponent(id) + '/refund', {}, 'Refunded through Stripe. The customer has been emailed.');
  };
  A['o-refund-done'] = function (el) { return oCall('today', 'POST', '/api/owner/bookings/' + encodeURIComponent(el.getAttribute('data-id')) + '/refund-done', {}, 'Marked as refunded.'); };
  A['o-date'] = function (el) { O.date = el.getAttribute('data-k'); render(); };
  A['o-date-step'] = function (el) { O.date = addDaysISO(O.date || O.st.today, parseInt(el.getAttribute('data-k'), 10)); render(); };
  A['o-ask'] = function (el) { O.ask = el.getAttribute('data-k'); render(); };
  A['o-status'] = function (el) {
    O.ask = '';
    return oCall('today', 'POST', '/api/owner/bookings/' + encodeURIComponent(el.getAttribute('data-id')) + '/status', { status: el.getAttribute('data-k') }, 'Appointment updated.');
  };
  A['o-block-phone'] = function (el) {
    return oCall('today', 'POST', '/api/owner/blocked', { phone: el.getAttribute('data-id'), name: el.getAttribute('data-k') }, 'That number can no longer book online.');
  };

  /* ---- manual appointment ---- */
  A['o-na-toggle'] = function () { O.naOpen = !O.naOpen; delete O.fl.na; render(); };
  function naKey() { return fv('na.barber') + '|' + fv('na.service'); }
  A['o-na-changed'] = function () {
    F['na.time'] = '';
    var barber = fv('na.barber'), svc = fv('na.service'), key = naKey(), na = O.na;
    if (!barber || !svc) { na.days = null; na.key = ''; render(); return; }
    if (na.key === key && na.days) { render(); return; }
    na.key = key; na.days = null; na.loading = true; render();
    return api('GET', '/api/availability?service=' + encodeURIComponent(svc) + '&barber=' + encodeURIComponent(barber) + '&days=30').then(function (r) {
      if (na.key !== key) return;
      na.loading = false; if (r.ok) na.days = r.data.days || []; else { na.days = null; na.key = ''; setFlash('na', 'error', errMsg(r)); }
      render();
    });
  };
  A['o-na-time'] = function (el) { F['na.time'] = el.getAttribute('data-k'); render(); };
  function newApptPanel() {
    var st = O.st, na = O.na;
    var barbers = [['', 'Choose…']].concat(st.barbers.map(function (b) { return [b.id, b.name]; }));
    var svcs = [['', 'Choose…']].concat(st.services.map(function (s) { return [s.id, s.name + ' (' + s.duration + ' min, ' + fmtMoney(s.price) + ')']; }));
    var date = fv('na.date', st.today), slotsHtml;
    if (!fv('na.barber') || !fv('na.service')) slotsHtml = '<div class="empty-note" style="padding:6px 0">Pick a barber and service to see open times.</div>';
    else if (na.loading || !na.days) slotsHtml = '<div class="loading-row">' + spinner() + '<span>Checking open times…</span></div>';
    else {
      var d = na.days.filter(function (x) { return x.date === date; })[0];
      if (!d) slotsHtml = '<div class="empty-note" style="padding:6px 0">Pick a date within the next 30 days.</div>';
      else if (!d.slots.length) slotsHtml = '<div class="empty-note" style="padding:6px 0">No open times for this barber on that day.</div>';
      else slotsHtml = '<div class="slot-grid" role="group" aria-label="Open times">' + d.slots.map(function (s) {
        return '<button type="button" class="slot-btn num" data-action="o-na-time" data-k="' + esc(s.time) + '" aria-pressed="' + (fv('na.time') === s.time) + '">' + esc(fmtTime(s.time)) + '</button>';
      }).join('') + '</div>';
    }
    return '<form class="new-appt-panel" data-submit="o-na-submit" novalidate><h3 style="font-size:19px;margin-bottom:12px">New appointment</h3>' + flashHtml('na') +
      '<div class="field-row"><div class="field"><label for="' + fid('na.barber') + '">Barber</label>' + selectHtml('na.barber', barbers, '', 'data-change="o-na-changed"') + '</div>' +
      '<div class="field"><label for="' + fid('na.service') + '">Service</label>' + selectHtml('na.service', svcs, '', 'data-change="o-na-changed"') + '</div></div>' +
      '<div class="field"><label for="' + fid('na.date') + '">Date</label><input id="' + fid('na.date') + '" type="date" data-f="na.date" data-change="o-na-changed" value="' + esc(date) + '" min="' + esc(st.today) + '"></div>' +
      slotsHtml + '<div style="height:14px"></div>' +
      '<div class="field-row">' + inp('na.name', { label: 'Customer name', ph: 'Jordan Smith', attrs: 'autocomplete="off" maxlength="80"' }) + inp('na.phone', { label: 'Phone', type: 'tel', ph: '(516) 555-0100', attrs: 'autocomplete="off" inputmode="tel"' }) + '</div>' +
      '<div class="field-row">' + inp('na.email', { label: 'Email (optional)', type: 'email', attrs: 'autocomplete="off"' }) + inp('na.notes', { label: 'Notes (optional)', attrs: 'maxlength="300"' }) + '</div>' +
      checkbox('na.fee', 'Booking fee of ' + esc(fmtMoney(st.shop.bookingFee)) + ' was collected', true) +
      checkbox('na.optin', 'Customer agreed to receive promotional texts', false) +
      '<div class="row-actions"><button type="submit" class="btn btn-primary btn-sm">Add appointment</button><button type="button" class="btn btn-ghost btn-sm" data-action="o-na-toggle">Cancel</button></div></form>';
  }
  SUBMIT['o-na-submit'] = function () {
    var st = O.st, date = fv('na.date', st.today);
    var body = { barberId: fv('na.barber'), serviceId: fv('na.service'), date: date, time: fv('na.time'), name: fv('na.name').trim(), phone: fv('na.phone').trim(), email: fv('na.email').trim(), notes: fv('na.notes').trim(), optIn: !!fv('na.optin', false), feeCharged: !!fv('na.fee', true) };
    if (!body.barberId || !body.serviceId) { setFlash('na', 'error', 'Choose a barber and a service.'); render(); return; }
    if (!body.time) { setFlash('na', 'error', 'Pick an open time.'); render(); return; }
    if (body.name.length < 2) { setFlash('na', 'error', 'Enter the customer’s name.'); render(); return; }
    return api('POST', '/api/owner/bookings', body, { role: 'owner' }).then(function (r) {
      if (r.status === 401) return;
      if (!r.ok) {
        setFlash('na', 'error', errMsg(r));
        if (r.data && r.data.code === 'slot_taken') { F['na.time'] = ''; O.na.key = ''; render(); return A['o-na-changed'](); }
        render(); return;
      }
      clearKeys('na.'); O.na.key = ''; O.na.days = null; O.naOpen = false; O.date = body.date;
      setFlash('today', 'ok', 'Appointment added.');
      return reloadOwner();
    });
  };

  /* ---------- Team tab ---------- */
  function statusPill(b) {
    if (b.hasPin) return '<span class="pill pill-completed" style="margin:0">Login active</span>';
    if (b.inviteActive) return '<span class="pill pill-upcoming" style="margin:0">Invite pending</span>';
    return '<span class="pill pill-off">No login yet</span>';
  }
  function tabTeam() {
    var st = O.st;
    var addForm = '<form class="panel-card" data-submit="o-add-barber" novalidate><h3>Add a team member</h3><p class="panel-sub">Add them here, then create their personal sign-in link below.</p>' + flashHtml('addbarber') +
      '<div class="field-row">' + inp('nb.name', { label: 'Name', ph: 'e.g. Sam', attrs: 'maxlength="40" autocomplete="off"' }) + inp('nb.title', { label: 'Title', ph: 'e.g. Master Barber', attrs: 'maxlength="80" autocomplete="off"' }) + '</div>' +
      '<div class="lbl" style="font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--ink-soft);margin-bottom:6px">Their language</div>' +
      '<div class="seg-row"><button type="button" class="seg-btn" data-action="o-nb-lang" data-k="en" aria-pressed="' + (fv('nb.lang', 'en') !== 'es') + '">English</button><button type="button" class="seg-btn" data-action="o-nb-lang" data-k="es" aria-pressed="' + (fv('nb.lang', 'en') === 'es') + '">Español</button></div>' +
      '<button type="submit" class="btn btn-primary btn-sm">+ Add team member</button></form>';
    var cards = st.barbers.map(teamCard).join('');
    return flashHtml('team') + addForm + cards;
  }
  A['o-nb-lang'] = function (el) { F['nb.lang'] = el.getAttribute('data-k'); render(); };
  SUBMIT['o-add-barber'] = function () {
    var name = fv('nb.name').trim();
    if (!name) { setFlash('addbarber', 'error', 'Enter a name for the new team member.'); render(); return; }
    return api('POST', '/api/owner/barbers', { name: name, title: fv('nb.title').trim(), lang: fv('nb.lang', 'en') }, { role: 'owner' }).then(function (r) {
      if (r.status === 401) return;
      if (!r.ok) { setFlash('addbarber', 'error', errMsg(r)); render(); return; }
      clearKeys('nb.'); setFlash('addbarber', 'ok', name + ' was added. Create their sign-in link below.');
      return reloadOwner();
    });
  };

  // Days Working toggles are a draft until "Save changes" is pressed (they save together with the custom hours)
  function curDaysOff(b) { return F['dw.' + b.id] !== undefined ? F['dw.' + b.id] : (b.daysOff || []); }
  function hasUnsaved(b) { return Object.keys(F).some(function (k) { return k === 'dw.' + b.id || k.indexOf('bh.' + b.id + '.') === 0; }); }
  function teamCard(b) {
    var open = O.manage === b.id, inv = O.invites[b.id], photo = b.photo ? b.photo.url : null;
    var days = DOW3.map(function (dn, i) {
      var off = curDaysOff(b).indexOf(i) !== -1;
      return '<button type="button" class="day-toggle" data-action="o-day" data-id="' + esc(b.id) + '" data-k="' + i + '" aria-pressed="' + (!off) + '" aria-label="' + DOW_EN[i] + (off ? ' (off)' : ' (working)') + '">' + dn.charAt(0) + '</button>';
    }).join('');
    var head = '<div class="tcard-head">' + avatarHtml(b.name, photo) + '<div class="tcard-id"><div class="pick-name">' + esc(b.name) + '</div><div class="pick-meta">' + esc(b.title) + '</div><div style="margin-top:6px">' + statusPill(b) + '</div></div>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="o-manage" data-id="' + esc(b.id) + '" aria-expanded="' + open + '">' + (open ? 'Close' : 'Manage') + '</button></div>';
    var schedule = '<div class="tcard-row"><div><span class="lbl">Days working</span><div class="day-toggle-row">' + days + '</div></div>' +
      '<div><span class="lbl">Language</span><div class="lang-mini-row"><button type="button" class="lang-mini" data-action="o-blang" data-id="' + esc(b.id) + '" data-k="en" aria-pressed="' + (b.lang !== 'es') + '">EN</button><button type="button" class="lang-mini" data-action="o-blang" data-id="' + esc(b.id) + '" data-k="es" aria-pressed="' + (b.lang === 'es') + '">ES</button></div></div></div>';
    schedule += '<div class="tcard-row save-row"><button type="button" class="btn btn-primary btn-sm" data-action="o-save-changes" data-id="' + esc(b.id) + '">Save changes</button>' +
      (hasUnsaved(b) ? '<span class="pick-meta">Unsaved changes</span>' : '') + '</div>' + flashHtml('sv:' + b.id);
    var login = '<div class="tcard-row"><form data-submit="o-barber-email" data-id="' + esc(b.id) + '" style="flex:1;min-width:220px" novalidate><span class="lbl">Sign-in link &amp; email</span>' +
      '<div class="invite-line"><input id="' + fid('be.' + b.id) + '" type="email" data-f="be.' + esc(b.id) + '" value="' + esc(fv('be.' + b.id, b.email || '')) + '" placeholder="' + esc(b.name) + '’s email (optional)" autocomplete="off" aria-label="' + esc(b.name) + '’s email"><button type="submit" class="btn btn-ghost btn-sm">Save email</button></div></form>' +
      '<div><span class="lbl">Login</span><div class="row-actions" style="margin:0">' +
      '<button type="button" class="btn btn-primary btn-sm" data-action="o-invite" data-id="' + esc(b.id) + '" data-k="link">' + (b.hasPin ? 'New invite link' : 'Get invite link') + '</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="o-invite" data-id="' + esc(b.id) + '" data-k="email"' + (b.email ? '' : ' disabled title="Save an email first"') + '>Email invite</button>' +
      (b.hasPin ? (O.ask === 'reset:' + b.id
        ? '<button type="button" class="btn btn-ghost btn-sm btn-danger" data-action="o-invite" data-id="' + esc(b.id) + '" data-k="reset">Yes, reset PIN</button><button type="button" class="btn-text" data-action="o-ask" data-k="">Keep</button>'
        : '<button type="button" class="btn btn-ghost btn-sm" data-action="o-ask" data-k="reset:' + esc(b.id) + '">Reset login</button>') : '') + '</div></div></div>';
    var invBox = inv ? '<div class="invite-box"><p><b>' + (inv.reset ? 'Login reset — ' : '') + 'One-time sign-in link for ' + esc(b.name) + '.</b> It works once and expires in ' + esc(inv.expiresInDays || 7) + ' days. They open it on their phone and choose a 6-digit PIN.' + (inv.emailed ? ' <b>Emailed to ' + esc(b.email) + '.</b>' : '') + '</p>' +
      '<div class="invite-line"><input id="invite-' + esc(b.id) + '" type="text" readonly value="' + esc(inv.url) + '" aria-label="Invite link for ' + esc(b.name) + '"><button type="button" class="btn btn-primary btn-sm" data-action="o-copy" data-id="' + esc(b.id) + '">' + (inv.copied ? 'Copied' : 'Copy') + '</button></div></div>' : '';
    return '<div class="tcard" data-barber="' + esc(b.id) + '">' + head + schedule + login + invBox + (open ? manageBlock(b) : '') + '</div>';
  }
  A['o-manage'] = function (el) { var id = el.getAttribute('data-id'); O.manage = O.manage === id ? '' : id; O.ask = ''; delete O.fl['m:' + id]; render(); };
  A['o-day'] = function (el) {
    var id = el.getAttribute('data-id'), dow = parseInt(el.getAttribute('data-k'), 10);
    var b = O.st.barbers.filter(function (x) { return x.id === id; })[0]; if (!b) return;
    var days = curDaysOff(b).slice(), i = days.indexOf(dow);
    if (i === -1) days.push(dow); else days.splice(i, 1);
    F['dw.' + id] = days; delete O.fl['sv:' + id];
    render();
  };
  A['o-blang'] = function (el) { return oCall('team', 'PATCH', '/api/owner/barbers/' + encodeURIComponent(el.getAttribute('data-id')), { lang: el.getAttribute('data-k') }, 'Language updated.'); };
  SUBMIT['o-barber-email'] = function (form) {
    var id = form.getAttribute('data-id');
    return oCall('team', 'PATCH', '/api/owner/barbers/' + encodeURIComponent(id), { email: fv('be.' + id).trim() }, 'Email saved.').then(function () { delete F['be.' + id]; });
  };
  A['o-invite'] = function (el) {
    var id = el.getAttribute('data-id'), kind = el.getAttribute('data-k'), reset = kind === 'reset';
    O.ask = '';
    return api('POST', '/api/owner/barbers/' + encodeURIComponent(id) + '/invite', { sendEmail: kind === 'email', reset: reset }, { role: 'owner' }).then(function (r) {
      if (r.status === 401) return;
      if (!r.ok) { setFlash('team', 'error', errMsg(r)); render(); return; }
      O.invites[id] = { url: r.data.url, emailed: !!r.data.emailed, expiresInDays: r.data.expiresInDays, reset: reset, copied: false };
      setFlash('team', 'ok', reset ? 'Login reset. Share the new one-time link below.' : (r.data.emailed ? 'Invite emailed. The link is also shown below.' : 'One-time sign-in link created below.'));
      return reloadOwner();
    });
  };
  A['o-copy'] = function (el) {
    var id = el.getAttribute('data-id'), inv = O.invites[id]; if (!inv) return;
    var done = function () { inv.copied = true; render(); setTimeout(function () { inv.copied = false; if (S.route === 'owner') render(); }, 2500); };
    var fallback = function () {
      var input = document.getElementById('invite-' + id);
      if (input) { input.focus(); input.select(); try { if (document.execCommand('copy')) { done(); return; } } catch (e) { /* ignore */ } }
      setFlash('team', 'error', 'Couldn’t copy automatically — the link is selected, press Ctrl/Cmd+C.'); render();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(inv.url).then(done, fallback);
    fallback();
  };

  function hourOpts(min, max, blank) {
    var o = blank ? [['', blank]] : [];
    for (var h = min; h <= max; h++) o.push([h, fmtHourLong(h)]);
    return o;
  }
  function manageBlock(b) {
    var today = O.st.today, fk = 'm:' + b.id, custom = !!b.useCustomHours, shopH = O.st.shop.hours;
    var offDays = curDaysOff(b);
    var offNames = offDays.slice().sort(function (x, y) { return x - y; }).map(function (i) { return DOW3[i]; });
    var hrsRows = custom ? (offNames.length ? '<p class="pick-meta" style="margin:0 0 8px">Days off (' + esc(offNames.join(', ')) + ') are hidden. Turn a day on under &ldquo;Days working&rdquo; to set its hours.</p>' : '') + '<div class="hours-grid-mini">' + DOW3.map(function (dn, i) {
      if (offDays.indexOf(i) !== -1) return '';
      var h = b.hours && b.hours[i] ? b.hours[i] : null;
      return '<div class="hours-row"><b>' + dn + '</b><span class="hrs">' +
        selectHtml('bh.' + b.id + '.' + i + '.o', hourOpts(0, 23, 'Shop hours'), h ? h.open : '', 'aria-label="' + DOW_EN[i] + ' opens"') + '<span>to</span>' +
        selectHtml('bh.' + b.id + '.' + i + '.c', hourOpts(1, 24, 'Shop hours'), h ? h.close : '', 'aria-label="' + DOW_EN[i] + ' closes"') + '</span><span class="pick-meta">' + (shopH && shopH[i] ? 'Shop: ' + fmtHourShort(shopH[i].open) + '–' + fmtHourShort(shopH[i].close) : 'Shop closed') + '</span></div>';
    }).join('') + '</div>' : '';
    var offs = (b.timeOff || []).map(function (o) {
      return '<div class="off-item"><span>' + esc(o.date === today ? 'Today' : fmtDateShort(o.date)) + ' &middot; ' + esc(o.allDay ? 'All day' : fmtTime(o.from) + '–' + fmtTime(o.to)) + '</span><button type="button" class="btn-text" data-action="o-rm-off" data-id="' + esc(o.id) + '" data-k="' + esc(b.id) + '">Remove</button></div>';
    }).join('') || '<div class="empty-note" style="padding:6px 0">Nothing blocked right now.</div>';
    var allDay = fv('mo.' + b.id + '.all', true);
    var gallery = (b.gallery || []).map(function (g) {
      return '<div class="manage-thumb"><img src="' + esc(safeImg(g.url)) + '" alt=""><button type="button" class="manage-thumb-x" data-action="o-rm-photo" data-id="' + esc(g.id) + '" aria-label="Remove photo">&times;</button></div>';
    }).join('') || '<div class="empty-note" style="padding:4px 0">No showcase photos yet.</div>';
    return '<div class="tcard-body">' + flashHtml(fk) +
      '<h4 class="section-eyebrow" style="margin:16px 0 8px">Working hours</h4>' +
      checkbox('mc.' + b.id, 'Use custom working hours instead of the shop’s hours', custom, 'data-change="o-toggle-custom" data-id="' + esc(b.id) + '"') + hrsRows +
      '<h4 class="section-eyebrow" style="margin:20px 0 8px">Profile photo &amp; work showcase</h4>' +
      '<p class="panel-sub">Customers see the profile photo on ' + esc(b.name) + '’s card and the showcase under their booking. Photos are resized automatically.</p>' +
      '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px">' + avatarHtml(b.name, b.photo ? b.photo.url : null, 'mgr-avatar') +
      '<label class="btn btn-ghost btn-sm upload-btn">' + (b.photo ? 'Change profile photo' : 'Upload profile photo') + '<input type="file" accept="image/*" data-change="o-photo" data-id="' + esc(b.id) + '" data-k="profile" aria-label="Upload profile photo for ' + esc(b.name) + '"></label>' +
      (b.photo ? '<button type="button" class="btn-text" data-action="o-rm-photo" data-id="' + esc(b.photo.id) + '">Remove</button>' : '') + '</div>' +
      '<div class="manage-gallery">' + gallery + '</div>' +
      '<div class="row-actions"><label class="btn btn-ghost btn-sm upload-btn">+ Add showcase photos (up to 8)<input type="file" accept="image/*" multiple data-change="o-photo" data-id="' + esc(b.id) + '" data-k="gallery" aria-label="Add showcase photos for ' + esc(b.name) + '"></label></div>' +
      '<h4 class="section-eyebrow" style="margin:20px 0 8px">Time off &amp; breaks</h4><div class="off-list">' + offs + '</div>' +
      inp('mo.' + b.id + '.date', { label: 'Date', type: 'date', attrs: 'min="' + esc(today) + '"' }) +
      '<div class="seg-row"><button type="button" class="seg-btn" data-action="o-off-mode" data-id="' + esc(b.id) + '" data-k="all" aria-pressed="' + !!allDay + '">Whole day off</button><button type="button" class="seg-btn" data-action="o-off-mode" data-id="' + esc(b.id) + '" data-k="part" aria-pressed="' + !allDay + '">Break / partial block</button></div>' +
      (allDay ? '' : '<div class="field-row">' + inp('mo.' + b.id + '.from', { label: 'Block from', type: 'time' }) + inp('mo.' + b.id + '.to', { label: 'Block until', type: 'time' }) + '</div>') +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="o-add-off" data-id="' + esc(b.id) + '">' + (allDay ? 'Block this day' : 'Block this time') + '</button>' +
      '<div style="margin-top:22px;padding-top:14px;border-top:1px solid var(--line)">' + (O.ask === 'rm:' + b.id
        ? '<div class="notice notice-error" role="alert"><span>Remove ' + esc(b.name) + ' for good? Their past appointments stay on record, but they disappear from booking, the team list and their own login.</span></div><div class="row-actions" style="margin:0"><button type="button" class="btn btn-danger btn-sm" data-action="o-rm-barber" data-id="' + esc(b.id) + '">Yes, remove ' + esc(b.name) + '</button><button type="button" class="btn btn-ghost btn-sm" data-action="o-ask" data-k="">Keep</button></div>'
        : '<button type="button" class="btn btn-ghost btn-sm" data-action="o-ask" data-k="rm:' + esc(b.id) + '">Remove ' + esc(b.name) + ' from the team</button>') + '</div></div>';
  }
  A['o-toggle-custom'] = function (el) {
    var id = el.getAttribute('data-id'), b = O.st.barbers.filter(function (x) { return x.id === id; })[0]; if (!b) return;
    var on = el.checked, body = { useCustomHours: on };
    if (on && !b.hours) {
      var h = {}; for (var d = 0; d < 7; d++) { var sh = O.st.shop.hours[d]; h[d] = sh ? { open: sh.open, close: sh.close } : null; }
      body.hours = h;
    }
    delete F['mc.' + id];
    return oCall('m:' + id, 'PATCH', '/api/owner/barbers/' + encodeURIComponent(id), body, on ? 'Custom hours on. Set the hours below, then press Save changes.' : 'Using the shop’s hours.');
  };
  A['o-save-changes'] = function (el) {
    var id = el.getAttribute('data-id'), b = O.st.barbers.filter(function (x) { return x.id === id; })[0]; if (!b) return;
    var off = curDaysOff(b), body = { daysOff: off }, bad = '';
    if (b.useCustomHours) {
      var hours = {};
      for (var d = 0; d < 7; d++) {
        var cur = b.hours && b.hours[d];
        if (off.indexOf(d) !== -1) { hours[d] = cur || null; continue; }   // day is off: its hours are hidden, keep what was stored
        var o = fv('bh.' + id + '.' + d + '.o', null), c = fv('bh.' + id + '.' + d + '.c', null);
        if (o === null) o = cur ? cur.open : ''; if (c === null) c = cur ? cur.close : '';
        if (o === '' && c === '') hours[d] = null;
        else if (o === '' || c === '') bad = DOW_EN[d] + ': choose both an opening and a closing time (or leave both on “Shop hours”).';
        else if (+c <= +o) bad = DOW_EN[d] + ': closing time must be after opening time.';
        else hours[d] = { open: +o, close: +c };
      }
      body.useCustomHours = true; body.hours = hours;
    }
    if (bad) { setFlash('sv:' + id, 'error', bad); render(); return; }
    return oCall('sv:' + id, 'PATCH', '/api/owner/barbers/' + encodeURIComponent(id), body, 'Saved. ' + b.name + '’s working days' + (b.useCustomHours ? ' and custom hours' : '') + ' are updated.').then(function (r) {
      if (r && r.ok) {
        delete F['dw.' + id]; clearKeys('bh.' + id + '.');
        var n = O.st.bookings.filter(function (x) { return x.barberId === id && x.conflict; }).length;
        if (n) setFlash('sv:' + id, 'error', 'Saved. Heads up: ' + plural(n, 'appointment', 'appointments') + ' with ' + b.name + ' no longer fit this schedule. Open the Bookings tab, see “Needs a new time”, and move them so they keep their spot.');
        render();
      }
    });
  };
  A['o-off-mode'] = function (el) { F['mo.' + el.getAttribute('data-id') + '.all'] = el.getAttribute('data-k') === 'all'; render(); };
  function conflictAfter(id) { return O.st.bookings.filter(function (x) { return x.barberId === id && x.conflict; }).length; }
  A['o-add-off'] = function (el) {
    var id = el.getAttribute('data-id'), all = fv('mo.' + id + '.all', true), date = fv('mo.' + id + '.date'), from = fv('mo.' + id + '.from'), to = fv('mo.' + id + '.to'), fk = 'm:' + id;
    if (!date) { setFlash(fk, 'error', 'Pick a date first.'); render(); return; }
    if (!all) {
      if (!from || !to) { setFlash(fk, 'error', 'Set a start and end time.'); render(); return; }
      if (from >= to) { setFlash(fk, 'error', 'End time must be after the start time.'); render(); return; }
    }
    clearKeys('mo.' + id + '.');
    return oCall(fk, 'POST', '/api/owner/barbers/' + encodeURIComponent(id) + '/timeoff', all ? { date: date, allDay: true } : { date: date, allDay: false, from: from, to: to }, 'Time blocked.').then(function (r) {
      var n = r && r.ok ? conflictAfter(id) : 0;
      if (n) { setFlash(fk, 'error', 'Time blocked. Heads up: ' + plural(n, 'appointment', 'appointments') + ' fall in the time you blocked. Open the Bookings tab, see “Needs a new time”, and move them.'); render(); }
    });
  };
  A['o-rm-off'] = function (el) { return oCall('m:' + el.getAttribute('data-k'), 'DELETE', '/api/owner/timeoff/' + encodeURIComponent(el.getAttribute('data-id')), undefined, 'Time off removed.'); };
  A['o-rm-barber'] = function (el) {
    var id = el.getAttribute('data-id'); O.ask = ''; O.manage = '';
    return api('DELETE', '/api/owner/barbers/' + encodeURIComponent(id), undefined, { role: 'owner' }).then(function (r) {
      if (r.status === 401) return;
      if (!r.ok) { setFlash('team', 'error', errMsg(r)); render(); return; }
      delete O.invites[id];
      setFlash('team', 'ok', 'Removed.' + (r.data.upcomingBookings ? ' Note: they still have ' + plural(r.data.upcomingBookings, 'upcoming appointment', 'upcoming appointments') + ' — reassign or cancel them from the Bookings tab.' : ''));
      return reloadOwner();
    });
  };
  A['o-rm-photo'] = function (el) { return oCall('m:' + O.manage, 'DELETE', '/api/owner/photos/' + encodeURIComponent(el.getAttribute('data-id')), undefined, 'Photo removed.'); };

  /* ---- photo upload: resize in the browser (max 1200px JPEG) then send the raw bytes ---- */
  function viaImage(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onerror = function () { reject(new Error('read')); };
      fr.onload = function () { var im = new Image(); im.onload = function () { resolve(im); }; im.onerror = function () { reject(new Error('decode')); }; im.src = fr.result; };
      fr.readAsDataURL(file);
    });
  }
  function loadBitmap(file) {
    if (typeof createImageBitmap === 'function') return createImageBitmap(file).catch(function () { return viaImage(file); });
    return viaImage(file);
  }
  function drawJpeg(src, maxDim, quality) {
    var w = src.width, h = src.height, sc = Math.min(1, maxDim / Math.max(w, h));
    var c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * sc)); c.height = Math.max(1, Math.round(h * sc));
    var ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(src, 0, 0, c.width, c.height);
    return new Promise(function (resolve) { c.toBlob(resolve, 'image/jpeg', quality); });
  }
  async function imageToJpeg(file) {
    var src = await loadBitmap(file);
    var tries = [[1200, 0.85], [1200, 0.72], [1000, 0.65], [800, 0.6], [640, 0.55]];
    for (var i = 0; i < tries.length; i++) {
      var blob = await drawJpeg(src, tries[i][0], tries[i][1]);
      if (blob && blob.size >= 600 && blob.size <= 590 * 1024) return blob;
    }
    throw new Error('toobig');
  }
  A['o-photo'] = async function (el) {
    var id = el.getAttribute('data-id'), kind = el.getAttribute('data-k'), files = Array.prototype.slice.call(el.files || []), fk = 'm:' + id;
    el.value = '';
    if (!files.length) return;
    var b = O.st.barbers.filter(function (x) { return x.id === id; })[0]; if (!b) return;
    var note = '';
    if (kind === 'gallery') {
      var room = 8 - (b.gallery || []).length;
      if (room <= 0) { setFlash(fk, 'error', 'The showcase holds up to 8 photos. Remove one to add another.'); render(); return; }
      if (files.length > room) { note = ' Only the first ' + room + ' fit (the showcase holds 8).'; files = files.slice(0, room); }
    } else files = files.slice(0, 1);
    setFlash(fk, 'ok', 'Uploading…'); render();
    var okCount = 0, lastErr = '';
    for (var i = 0; i < files.length; i++) {
      try {
        var blob = await imageToJpeg(files[i]);
        var r = await api('POST', '/api/owner/barbers/' + encodeURIComponent(id) + '/photos?kind=' + kind, undefined, { raw: blob, type: 'image/jpeg', role: 'owner' });
        if (r.status === 401) return;
        if (r.ok) okCount++; else lastErr = errMsg(r);
      } catch (e) { lastErr = 'One photo couldn’t be read. Try a JPG or PNG.'; }
    }
    if (okCount) setFlash(fk, lastErr ? 'error' : 'ok', (okCount === 1 ? 'Photo added.' : okCount + ' photos added.') + (lastErr ? ' ' + lastErr : '') + note);
    else setFlash(fk, 'error', lastErr || 'That photo couldn’t be added.');
    await reloadOwner();
  };

  /* ---------- Customers tab ---------- */
  function tabCustomers() {
    var st = O.st, q = fv('cq').trim().toLowerCase();
    var all = st.customers, optedIn = all.filter(function (c) { return c.optIn && !c.blocked; }).length;
    var list = q ? all.filter(function (c) { return (c.name + ' ' + c.phone + ' ' + (c.email || '')).toLowerCase().indexOf(q) !== -1; }) : all;
    var rows = list.map(function (c) {
      return '<tr' + (c.blocked ? ' style="opacity:.6"' : '') + '><td class="wrap">' + esc(c.name) + (c.blocked ? ' <span class="pick-meta">(blocked)</span>' : '') + '</td>' +
        '<td class="nw num"><a href="tel:' + esc(safeTel(c.phone)) + '">' + esc(c.phone) + '</a> <a class="btn-text" href="sms:' + esc(safeTel(c.phone)) + '">Text</a></td><td class="wrap">' + esc(c.email || '') + '</td><td class="num">' + esc(c.visits) + '</td><td class="nw">' + esc(c.last ? fmtDateShort(String(c.last).slice(0, 10)) : '') + '</td>' +
        '<td class="c"><label class="tbl-check"><input type="checkbox" data-change="o-optin" data-phone="' + esc(c.phone) + '"' + (c.optIn ? ' checked' : '') + ' aria-label="OK to text ' + esc(c.name) + '"></label></td>' +
        '<td class="nw">' + (c.blocked
          ? '<button type="button" class="btn-text" data-action="o-unblock" data-id="' + esc(c.norm) + '">Unblock</button>'
          : '<button type="button" class="btn-text" data-action="o-block-phone" data-id="' + esc(c.phone) + '" data-k="' + esc(c.name) + '">Block</button>') + '</td></tr>';
    }).join('') || '<tr><td colspan="7" class="empty-note">' + (q ? 'No one matches that search.' : 'No customers yet. They appear here as bookings come in.') + '</td></tr>';
    var blocked = st.blocked.map(function (b) {
      return '<div class="settings-item"><span>' + esc(b.phone) + (b.name ? ' <span class="pick-meta">(' + esc(b.name) + ')</span>' : '') + '</span><button type="button" class="btn-text" data-action="o-unblock" data-id="' + esc(b.norm) + '">Unblock</button></div>';
    }).join('') || '<div class="empty-note" style="padding:6px 0">No one is blocked.</div>';
    return flashHtml('cust') +
      '<div class="panel-card"><h3>Customers &amp; text list</h3><p class="panel-sub">Every phone number from a booking is saved here, one row per person. <b>' + all.length + '</b> customers, <b>' + optedIn + '</b> have agreed to promotional texts. Customers can agree with a checkbox when they book; you can also tick it yourself for people who told you yes in person.</p>' +
      '<div class="row-actions" style="margin:0 0 16px"><a class="btn btn-primary btn-sm" href="/api/owner/customers.csv" download id="dl-csv">Download text list (CSV)</a>' +
      '<a class="btn btn-ghost btn-sm" href="/api/owner/customers.csv?all=1" download id="dl-csv-all">All contacts (CSV)</a>' +
      '<a class="btn btn-ghost btn-sm" href="/api/owner/export.json" download id="dl-backup">Download full backup</a></div>' +
      '<p class="pick-meta" style="margin-bottom:14px">The text list only includes people who agreed and aren’t blocked; import it into Textedly by matching the columns. In the US, marketing texts should only go to people who agreed, and every message should let them reply STOP.</p>' +
      '<div class="field" style="max-width:340px"><label for="' + fid('cq') + '">Search</label><input id="' + fid('cq') + '" type="search" data-f="cq" data-live="1" value="' + esc(fv('cq')) + '" placeholder="Name, phone or email" autocomplete="off"></div>' +
      '<div class="tbl-wrap"><table class="breakdown-table"><thead><tr><th>Name</th><th>Phone</th><th>Email</th><th class="num">Visits</th><th>Last visit</th><th class="c">OK to text</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div></div>' +
      '<form class="panel-card" data-submit="o-block-add" novalidate><h3>Blocked numbers</h3><p class="panel-sub">These numbers can’t complete online booking — they’re asked to call the shop instead.</p>' + flashHtml('block') +
      '<div class="settings-list" style="margin-bottom:14px">' + blocked + '</div><div class="field-row">' + inp('blk.phone', { label: 'Phone to block', type: 'tel', ph: '(516) 555-0100', attrs: 'autocomplete="off" inputmode="tel"' }) + inp('blk.name', { label: 'Note (optional)', ph: 'e.g. repeat no-show', attrs: 'maxlength="80"' }) + '</div>' +
      '<button type="submit" class="btn btn-ghost btn-sm">Block this number</button></form>';
  }
  A['o-optin'] = function (el) {
    return oCall('cust', 'PUT', '/api/owner/optin', { phone: el.getAttribute('data-phone'), optIn: el.checked }, el.checked ? 'Marked OK to text.' : 'No longer on the text list.');
  };
  A['o-unblock'] = function (el) { return oCall('cust', 'DELETE', '/api/owner/blocked/' + encodeURIComponent(el.getAttribute('data-id')), undefined, 'Number unblocked.'); };
  SUBMIT['o-block-add'] = function () {
    var phone = fv('blk.phone').trim();
    if (!phone) { setFlash('block', 'error', 'Enter a phone number.'); render(); return; }
    return oCall('block', 'POST', '/api/owner/blocked', { phone: phone, name: fv('blk.name').trim() }, 'Number blocked.').then(function (r) { if (r && r.ok) clearKeys('blk.'); });
  };

  /* ---------- Settings tab ---------- */
  function tabSettings() {
    var st = O.st, shop = st.shop, sys = st.system || {};
    var info = '<form class="panel-card" data-submit="o-set-info" novalidate><h3>Shop info</h3>' + flashHtml('info') +
      inp('s.name', { label: 'Shop name', def: shop.name, attrs: 'maxlength="60"' }) + inp('s.tagline', { label: 'Tagline', def: shop.tagline, attrs: 'maxlength="80"' }) +
      inp('s.address', { label: 'Address', def: shop.address, attrs: 'maxlength="120"' }) + inp('s.phone', { label: 'Phone', def: shop.phone, type: 'tel', attrs: 'maxlength="30"' }) +
      '<button type="submit" class="btn btn-primary btn-sm">Save shop info</button></form>';
    var hoursRows = DOW_EN.map(function (dn, i) {
      var h = shop.hours[i], closed = fv('h.' + i + '.closed', !h);
      return '<div class="hours-row"><b>' + dn.slice(0, 3) + '</b><span class="hrs">' + selectHtml('h.' + i + '.o', hourOpts(0, 23), h ? h.open : 9, 'aria-label="' + dn + ' opens"' + (closed ? ' disabled' : '')) + '<span>to</span>' + selectHtml('h.' + i + '.c', hourOpts(1, 24), h ? h.close : 19, 'aria-label="' + dn + ' closes"' + (closed ? ' disabled' : '')) + '</span>' +
        '<label class="closed-toggle"><input type="checkbox" id="' + fid('h.' + i + '.closed') + '" data-f="h.' + i + '.closed" data-change="o-hours-render"' + (closed ? ' checked' : '') + '> Closed</label></div>';
    }).join('');
    var hours = '<form class="panel-card" data-submit="o-set-hours" novalidate><h3>Shop hours</h3><p class="panel-sub">Bookable times follow these hours (30-minute steps).</p>' + flashHtml('hours') + '<div class="settings-list">' + hoursRows + '</div><div class="row-actions"><button type="submit" class="btn btn-primary btn-sm">Save hours</button></div></form>';
    var policy = '<form class="panel-card" data-submit="o-set-policy" novalidate><h3>Booking policies</h3>' + flashHtml('policy') +
      '<div class="field-row">' + inp('s.fee', { label: 'Booking fee ($, whole dollars)', def: shop.bookingFee, type: 'text', attrs: 'inputmode="numeric" maxlength="3"', hint: '0 turns the fee off.' }) + inp('s.window', { label: 'Free cancel window (hours)', def: shop.cancelWindowHours, attrs: 'inputmode="numeric" maxlength="3"' }) + '</div>' +
      checkbox('s.pretick', 'Pre-tick the promotional texts/emails box on the booking form (customers can still untick it)', shop.marketingPreTick) +
      '<p class="pick-meta" style="margin:-2px 0 8px 34px">Many lawyers advise leaving this unticked so each customer opts in on their own. Each opt-in is saved with its date and time.</p>' +
      checkbox('s.reminders', 'Email customers a reminder the day before their appointment (when they gave an email)', shop.remindersEnabled) +
      '<button type="submit" class="btn btn-primary btn-sm">Save policies</button></form>';
    var email = '<form class="panel-card" data-submit="o-set-email" novalidate><h3>Booking alerts</h3><p class="panel-sub">Every new online booking is emailed to this address.</p>' + flashHtml('email') +
      inp('s.ownerEmail', { label: 'Your email', def: shop.ownerEmail, type: 'email', attrs: 'autocomplete="email" inputmode="email"' }) +
      '<div class="row-actions" style="margin-top:0"><button type="submit" class="btn btn-primary btn-sm">Save email</button><button type="button" class="btn btn-ghost btn-sm" data-action="o-test-email">Send test email</button></div></form>';
    var review = '<form class="panel-card" data-submit="o-set-review" novalidate><h3>Google review requests</h3><p class="panel-sub">About two hours after you mark an appointment Completed, the client gets one friendly email asking for a Google review (never more than one every 30 days, and only between 9 AM and 8 PM). Paste your Google review link below. Leave it blank to turn review requests off.</p>' + flashHtml('review') +
      inp('s.review', { label: 'Google review link', def: shop.googleReviewUrl || '', type: 'url', ph: 'https://g.page/r/…/review', attrs: 'inputmode="url" autocomplete="off" maxlength="300"', hint: 'In Google Business Profile, choose “Ask for reviews” and copy the link.' }) +
      '<div class="row-actions" style="margin-top:0"><button type="submit" class="btn btn-primary btn-sm">Save review link</button></div></form>';
    var svc = '<form class="panel-card" data-submit="o-set-services" novalidate><h3>Services &amp; in-store prices</h3><p class="panel-sub">Prices are paid at the shop, never online. Clients see them only at checkout, as &ldquo;Due in store&rdquo;. Online, each appointment is charged just the booking fee. The minutes set how long the chair is blocked.</p>' + flashHtml('svc') + '<div class="settings-list">' + st.services.map(function (s) {
      return '<div class="settings-item"><span>' + esc(s.name) + (s.note ? ' <span class="pick-meta">(' + esc(s.note) + ')</span>' : '') + '</span><span class="svc-fields">' +
        '<input type="text" inputmode="numeric" id="' + fid('sv.' + s.id + '.d') + '" data-f="sv.' + esc(s.id) + '.d" value="' + esc(fv('sv.' + s.id + '.d', s.duration)) + '" aria-label="' + esc(s.name) + ' minutes" maxlength="3"> min ' +
        '$<input type="text" inputmode="numeric" id="' + fid('sv.' + s.id + '.p') + '" data-f="sv.' + esc(s.id) + '.p" value="' + esc(fv('sv.' + s.id + '.p', s.price)) + '" aria-label="' + esc(s.name) + ' in-store price in dollars" maxlength="4"></span></div>';
    }).join('') + '</div><div class="row-actions"><button type="submit" class="btn btn-primary btn-sm">Save services</button></div></form>';
    var pw = '<form class="panel-card" data-submit="o-set-password" novalidate><h3>Change password</h3>' + flashHtml('pw') +
      '<input type="text" autocomplete="username" value="' + esc(shop.ownerEmail || '') + '" class="visually-hidden" tabindex="-1" aria-hidden="true" readonly>' +
      inp('pw.cur', { label: 'Current password', type: 'password', attrs: 'autocomplete="current-password"' }) + inp('pw.new', { label: 'New password (10+ characters)', type: 'password', attrs: 'autocomplete="new-password"' }) + inp('pw.new2', { label: 'Confirm new password', type: 'password', attrs: 'autocomplete="new-password"' }) +
      '<button type="submit" class="btn btn-primary btn-sm">Change password</button></form>';
    var board = '<form class="panel-card" data-submit="o-set-boardpin" novalidate><h3>Shop TV screen</h3><p class="panel-sub">The “Shop screen” page is a PIN-locked display for the TV. It shows each barber’s day with first name and last initial only. Open <span class="mono">/#board</span> on the TV and enter this PIN once — it stays signed in for 30 days. Changing the PIN signs every screen out.</p>' + flashHtml('board') +
      '<div class="sys-row"><span class="k">Screen PIN</span><span class="v"><span class="status-dot ' + (shop.hasBoardPin ? 'ok' : 'warn') + '"></span>' + (shop.hasBoardPin ? 'A PIN is set' : 'Not set — the screen is switched off') + '</span></div>' +
      pinInp('s.boardpin', shop.hasBoardPin ? 'New screen PIN (6 digits)' : 'Screen PIN (6 digits)', { ac: 'off' }) +
      '<div class="row-actions" style="margin-top:0"><button type="submit" class="btn btn-primary btn-sm">' + (shop.hasBoardPin ? 'Change PIN' : 'Set PIN') + '</button>' +
      (shop.hasBoardPin ? '<button type="button" class="btn btn-ghost btn-sm" data-action="o-clear-boardpin">Clear PIN</button>' : '') + '</div></form>';
    var em = sys.email || {}, sp = sys.stripe || {};
    var row = function (k, ok, v) { return '<div class="sys-row"><span class="k">' + esc(k) + '</span><span class="v"><span class="status-dot ' + (ok === null ? '' : (ok ? 'ok' : 'warn')) + '"></span>' + v + '</span></div>'; };
    var system = '<div class="panel-card"><h3>System status</h3>' +
      row('Email', !!em.configured && !em.failed, em.configured ? 'Connected' + (em.pending ? ' &middot; ' + plural(em.pending, 'message', 'messages') + ' waiting' : '') + (em.failed ? ' &middot; <b>' + plural(em.failed, 'message', 'messages') + ' failed</b>' : '') : 'Not set up &mdash; emails wait in the outbox until an email service key is added on the server' + (em.pending ? ' (' + em.pending + ' waiting)' : '')) +
      row('Stripe payments', !!sp.enabled, sp.enabled ? 'Connected' : (sys.requirePayment ? 'Not connected &mdash; online payments are off until a Stripe key is added' : 'Not connected (payments not required)')) +
      row('Stripe webhook', !!sp.webhook, sp.webhook ? 'Signature secret set' : (sp.enabled ? 'Missing &mdash; payments can’t be confirmed' : 'Not needed yet')) +
      row('Booking fee required', null, sys.requirePayment ? 'Yes' : 'No') + row('Site address', null, '<span class="mono">' + esc(sys.baseUrl || '') + '</span>') + '</div>';
    var audit = '<div class="panel-card"><h3>Recent security log</h3><p class="panel-sub">The last 30 sign-ins, changes and exports.</p><div class="tbl-wrap"><table class="breakdown-table"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Detail</th><th>From</th></tr></thead><tbody>' +
      (st.audit || []).map(function (a) { return '<tr><td class="nw">' + esc(fmtStamp(a.ts)) + '</td><td class="nw">' + esc(a.actor) + '</td><td class="nw">' + esc(String(a.action).replace(/_/g, ' ')) + '</td><td class="wrap">' + esc(a.detail) + '</td><td class="nw mono">' + esc(a.ip) + '</td></tr>'; }).join('') + '</tbody></table></div></div>';
    return '<div class="settings-grid"><div>' + info + hours + policy + email + review + '</div><div>' + svc + board + pw + system + '</div></div>' + audit;
  }
  A['o-hours-render'] = function () { render(); };
  SUBMIT['o-set-info'] = function () {
    var sh = O.st.shop;
    return oCall('info', 'PATCH', '/api/owner/settings', { name: fv('s.name', sh.name).trim(), tagline: fv('s.tagline', sh.tagline).trim(), address: fv('s.address', sh.address).trim(), phone: fv('s.phone', sh.phone).trim() }, 'Shop info saved.').then(function (r) { if (r && r.ok) { clearKeys('s.name'); clearKeys('s.tagline'); clearKeys('s.address'); clearKeys('s.phone'); loadPublic(); } });
  };
  SUBMIT['o-set-hours'] = function () {
    var sh = O.st.shop, hours = {};
    for (var i = 0; i < 7; i++) {
      var h = sh.hours[i], closed = fv('h.' + i + '.closed', !h);
      if (closed) { hours[i] = null; continue; }
      var o = +fv('h.' + i + '.o', h ? h.open : 9), c = +fv('h.' + i + '.c', h ? h.close : 19);
      if (c <= o) { setFlash('hours', 'error', DOW_EN[i] + ': closing time must be after opening time.'); render(); return; }
      hours[i] = { open: o, close: c };
    }
    return oCall('hours', 'PATCH', '/api/owner/settings', { hours: hours }, 'Hours saved.').then(function (r) { if (r && r.ok) { clearKeys('h.'); loadPublic(); } });
  };
  SUBMIT['o-set-policy'] = function () {
    var sh = O.st.shop, fee = String(fv('s.fee', sh.bookingFee)).trim(), win = String(fv('s.window', sh.cancelWindowHours)).trim();
    if (!/^\d{1,3}$/.test(fee) || +fee > 500) { setFlash('policy', 'error', 'The booking fee must be a whole number of dollars from 0 to 500.'); render(); return; }
    if (!/^\d{1,3}$/.test(win) || +win > 168) { setFlash('policy', 'error', 'The cancel window must be from 0 to 168 hours.'); render(); return; }
    return oCall('policy', 'PATCH', '/api/owner/settings', { bookingFee: +fee, cancelWindowHours: +win, marketingPreTick: !!fv('s.pretick', sh.marketingPreTick), remindersEnabled: !!fv('s.reminders', sh.remindersEnabled) }, 'Policies saved.').then(function (r) { if (r && r.ok) { ['s.fee', 's.window', 's.pretick', 's.reminders'].forEach(function (k) { delete F[k]; }); loadPublic(); } });
  };
  SUBMIT['o-set-review'] = function () {
    return oCall('review', 'PATCH', '/api/owner/settings', { googleReviewUrl: fv('s.review', O.st.shop.googleReviewUrl || '').trim() }, fv('s.review', O.st.shop.googleReviewUrl || '').trim() ? 'Review link saved. Clients will be asked for a review after each completed visit.' : 'Review requests are off.').then(function (r) { if (r && r.ok) delete F['s.review']; });
  };
  SUBMIT['o-set-email'] = function () {
    return oCall('email', 'PATCH', '/api/owner/settings', { ownerEmail: fv('s.ownerEmail', O.st.shop.ownerEmail).trim() }, 'Email saved.').then(function (r) { if (r && r.ok) delete F['s.ownerEmail']; });
  };
  A['o-test-email'] = async function () {
    var saved = O.st.shop.ownerEmail || '', typed = fv('s.ownerEmail', saved).trim();
    if (typed !== saved) {
      var p = await api('PATCH', '/api/owner/settings', { ownerEmail: typed }, { role: 'owner' });
      if (p.status === 401) return;
      if (!p.ok) { setFlash('email', 'error', errMsg(p)); render(); return; }
      delete F['s.ownerEmail'];
    }
    var r = await api('POST', '/api/owner/test-email', {}, { role: 'owner' });
    if (r.status === 401) return;
    if (!r.ok) setFlash('email', 'error', errMsg(r));
    else setFlash('email', 'ok', r.data.configured ? 'Test email sent — check your inbox in a minute.' : 'Test email queued, but the email service isn’t set up yet (see System status), so it is waiting in the outbox.');
    await reloadOwner();
  };
  SUBMIT['o-set-services'] = async function () {
    var changed = 0;
    for (var i = 0; i < O.st.services.length; i++) {
      var s = O.st.services[i], d = String(fv('sv.' + s.id + '.d', s.duration)).trim(), pr = String(fv('sv.' + s.id + '.p', s.price)).trim();
      if (!/^\d{1,3}$/.test(d) || +d < 5 || +d > 240) { setFlash('svc', 'error', s.name + ': minutes must be from 5 to 240.'); render(); return; }
      if (!/^\d{1,4}$/.test(pr) || +pr > 1000) { setFlash('svc', 'error', s.name + ': price must be whole dollars from 0 to 1000.'); render(); return; }
      if (+d === s.duration && +pr === Number(s.price)) continue;
      var r = await api('PATCH', '/api/owner/services/' + encodeURIComponent(s.id), { duration: +d, price: +pr }, { role: 'owner' });
      if (r.status === 401) return;
      if (!r.ok) { setFlash('svc', 'error', s.name + ': ' + errMsg(r)); await reloadOwner(); return; }
      changed++;
    }
    clearKeys('sv.');
    setFlash('svc', 'ok', changed ? 'Saved ' + plural(changed, 'service', 'services') + '.' : 'Nothing to change.');
    loadPublic();
    await reloadOwner();
  };
  SUBMIT['o-set-password'] = function () {
    var cur = fv('pw.cur'), nw = fv('pw.new'), nw2 = fv('pw.new2');
    if (!cur) { setFlash('pw', 'error', 'Enter your current password.'); render(); return; }
    if (nw.length < 10) { setFlash('pw', 'error', 'Choose a new password of at least 10 characters.'); render(); return; }
    if (nw !== nw2) { setFlash('pw', 'error', 'The new passwords don’t match.'); render(); return; }
    return api('POST', '/api/owner/password', { current: cur, next: nw }, { role: 'owner' }).then(function (r) {
      clearKeys('pw.');
      if (r.status === 401) return;
      setFlash('pw', r.ok ? 'ok' : 'error', r.ok ? 'Password changed. Other devices were signed out.' : errMsg(r)); render();
    });
  };
  SUBMIT['o-set-boardpin'] = function () {
    var pin = fv('s.boardpin');
    if (!/^\d{6}$/.test(pin)) { setFlash('board', 'error', 'The screen PIN must be exactly 6 digits.'); render(); return; }
    return oCall('board', 'POST', '/api/owner/board-pin', { pin: pin }, 'Screen PIN saved. Every screen must sign in again with it.').then(function (r) { if (r && r.ok) delete F['s.boardpin']; });
  };
  A['o-clear-boardpin'] = function () { return oCall('board', 'POST', '/api/owner/board-pin', { pin: '' }, 'Screen PIN cleared. The shop screen is switched off.'); };

  /* =====================================================================
     routing + boot
     ===================================================================== */
  var bootQuery = new URLSearchParams(location.search);
  function routeFromLocation(boot) {
    if (boot) {
      var pay = bootQuery.get('pay'), t = bootQuery.get('t');
      if ((pay === 'success' || pay === 'cancel') && t) return { route: 'pay', kind: pay, token: t };
      var tok = bootQuery.get('staff');
      if (tok) return { route: 'staff', token: tok };
      var mgTok = bootQuery.get('manage');
      if (mgTok) return { route: 'manage', token: mgTok };
    }
    var h = location.hash.replace(/^#/, '');
    if (h === 'staff' || h === 'board' || h === 'owner') return { route: h };
    return { route: 'home' };
  }
  function enter(r) {
    clearTimers();
    S.lightbox = null; S.route = r.route; S.scrollTop = true;
    if (r.route === 'home') {
      render();
      if (!S.pub) return loadPublic().then(function () { if (S.route === 'home') render(); });
    } else if (r.route === 'pay') {
      if (!S.pub) loadPublic().then(function () { if (S.route === 'pay') render(); });
      startPayReturn(r.kind, r.token);
    } else if (r.route === 'manage') {
      initManage(r.token);
    } else if (r.route === 'staff') {
      if (r.token) S.staff.token = r.token;
      initStaff();
    } else if (r.route === 'board') {
      initBoard();
    } else if (r.route === 'owner') {
      initOwner();
    }
  }
  function navigate(target) {
    if (target === 'home') {
      try { history.pushState(null, '', '/'); } catch (e) { /* ignore */ }
      enter({ route: 'home' }); return;
    }
    if (location.hash === '#' + target) enter({ route: target });
    else location.hash = '#' + target;              // the hashchange listener enters the route
  }
  window.addEventListener('hashchange', function () { enter(routeFromLocation(false)); });

  enter(routeFromLocation(true));
})();
