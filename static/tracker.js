/* Happy Toys — трекер для страницы владельца (/boss).
 * Собирает: устройство, переходы по разделам, нажатия кнопок, поиск, просмотры товаров,
 * корзину, скачивания и «поделиться». НЕ читает содержимое полей ввода и пароли.
 * Любая ошибка здесь не должна ломать сайт — всё обёрнуто в try/catch.
 */
(function () {
  'use strict';
  if (window.__htTracker) return;
  window.__htTracker = true;

  var EP = '/api/t/collect';
  var HB_MS = 25000;            // «пульс» — по нему видно, что человек сейчас на сайте
  var IDLE_MS = 10 * 60 * 1000; // без действий дольше — пульс не шлём
  var SESSION_MS = 30 * 60 * 1000;

  // ── идентификаторы ────────────────────────────────────────────────────────
  function rnd() {
    try {
      if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
      var a = new Uint8Array(16); crypto.getRandomValues(a);
      return Array.from(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    } catch (e) { return (Date.now().toString(36) + Math.random().toString(36).slice(2)).padEnd(24, '0'); }
  }
  var mem = {};
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return mem[k] || null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { mem[k] = v; } }
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return mem['s' + k] || null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { mem['s' + k] = v; } }

  var vid = lsGet('ht_vid');
  if (!vid) { vid = rnd(); lsSet('ht_vid', vid); }
  var sid = ssGet('ht_sid'), lastAct = +ssGet('ht_sid_t') || 0, freshSession = false;
  if (!sid || Date.now() - lastAct > SESSION_MS) { sid = rnd(); ssSet('ht_sid', sid); freshSession = true; }
  function touch() { lastAct = Date.now(); ssSet('ht_sid_t', String(lastAct)); }
  touch();

  function S() { try { return typeof State !== 'undefined' ? State : null; } catch (e) { return null; } }
  function curPage() { var s = S(); return (s && s.page) || 'home'; }

  // ── очередь событий ───────────────────────────────────────────────────────
  var queue = [], timer = null, cartDirty = true, remoteClearing = false, lastCartCount = null;
  var jsErrors = 0, lastClick = { k: '', t: 0 }, lastView = { k: '', t: 0 };
  function view(name) {
    var now = Date.now();
    if (lastView.k === name && now - lastView.t < 2500) return;
    lastView = { k: name, t: now }; ev('view', name);
  }

  function ev(type, name, meta) {
    try {
      queue.push({ t: type, n: String(name == null ? '' : name).slice(0, 200), m: meta || {}, p: curPage(), at: Date.now() });
      touch();
      if (queue.length >= 15) flush(); else if (!timer) timer = setTimeout(flush, 4000);
    } catch (e) {}
  }

  function cartItems() {
    var s = S(), out = [];
    try {
      Object.keys((s && s.cart) || {}).forEach(function (k) {
        var it = s.cart[k]; if (!it || !it.product) return;
        out.push({ id: it.product.id, name: it.product.name, sku: it.product.sku, price: it.product.price, qty: it.qty });
      });
    } catch (e) {}
    return out;
  }

  var deviceInfoPromise = null, deviceSent = false;

  async function collectDevice() {
    var i = {
      screen_w: screen.width, screen_h: screen.height, dpr: window.devicePixelRatio || 1,
      vw: innerWidth, vh: innerHeight, touch: navigator.maxTouchPoints || 0,
      lang: navigator.language, langs: (navigator.languages || []).slice(0, 4),
      tz: (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return ''; } })(),
      tz_off: new Date().getTimezoneOffset(), cores: navigator.hardwareConcurrency || 0,
      mem: navigator.deviceMemory || 0, platform: navigator.platform || '',
      standalone: (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true,
      dark: !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches),
      ref: (document.referrer || '').slice(0, 200), url: (location.pathname + location.search).slice(0, 160)
    };
    try {
      var c = navigator.connection;
      if (c) { i.conn = c.effectiveType; i.downlink = c.downlink; i.save = !!c.saveData; }
    } catch (e) {}
    try {
      var cv = document.createElement('canvas'), gl = cv.getContext('webgl') || cv.getContext('experimental-webgl');
      var ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) i.gpu = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '').slice(0, 120);
    } catch (e) {}
    try {
      var uad = navigator.userAgentData;
      if (uad && uad.getHighEntropyValues) {
        var h = await uad.getHighEntropyValues(['model', 'platformVersion', 'architecture', 'bitness']);
        i.model = h.model || ''; i.platform_ver = h.platformVersion || ''; i.arch = h.architecture || '';
      }
    } catch (e) {}
    try {
      var q = new URLSearchParams(location.search), utm = {};
      ['utm_source', 'utm_medium', 'utm_campaign'].forEach(function (k) { if (q.get(k)) utm[k] = q.get(k).slice(0, 60); });
      if (Object.keys(utm).length) i.utm = utm;
    } catch (e) {}
    var s = S(); if (s && s.user && s.user.role === 'admin') i.staff = true;
    return i;
  }

  function authHeader() {
    var s = S(); return s && s.user && s.user.token ? { Authorization: 'Bearer ' + s.user.token } : {};
  }

  async function flush(force) {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!queue.length && !cartDirty && !force && deviceSent) return;
    var now = Date.now(), evs = queue.splice(0, 40).map(function (e) { return { t: e.t, n: e.n, m: e.m, p: e.p, dt: now - e.at }; });
    var body = { vid: vid, sid: sid, ev: evs };
    try {
      if (!deviceSent) {
        deviceInfoPromise = deviceInfoPromise || collectDevice();
        body.info = await deviceInfoPromise; deviceSent = true;
      }
      if (cartDirty) { body.cart = cartItems(); cartDirty = false; }
      var r = await fetch(EP, { method: 'POST', keepalive: true,
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeader()), body: JSON.stringify(body) });
      var j = await r.json().catch(function () { return {}; });
      if (j && j.cmd === 'clear_cart') runClearCart();
    } catch (e) { /* сеть недоступна — события потеряем, это не страшно */ }
    if (queue.length) timer = setTimeout(flush, 1500);
  }

  function beacon() {
    try {
      var now = Date.now(), evs = queue.splice(0, 40).map(function (e) { return { t: e.t, n: e.n, m: e.m, p: e.p, dt: now - e.at }; });
      var body = { vid: vid, sid: sid, ev: evs };
      if (cartDirty) { body.cart = cartItems(); cartDirty = false; }
      if (!evs.length && !body.cart) return;
      navigator.sendBeacon(EP, new Blob([JSON.stringify(body)], { type: 'application/json' }));
    } catch (e) {}
  }

  function runClearCart() {
    try {
      var s = S(); if (!s) return;
      remoteClearing = true;
      s.cart = {};
      if (typeof saveCart === 'function') saveCart();
      if (typeof renderCart === 'function') renderCart();
      if (typeof updateCartBadge === 'function') updateCartBadge();
      if (typeof toast === 'function') toast('Корзина очищена администратором');
      cartDirty = true; lastCartCount = 0;
      setTimeout(function () { remoteClearing = false; flush(true); }, 300);
    } catch (e) {}
  }

  // ── обёртки над функциями сайта ───────────────────────────────────────────
  function wrap(name, before, after) {
    var orig = window[name];
    if (typeof orig !== 'function' || orig.__ht) return;
    var w = function () {
      var args = arguments, ctx = null;
      try { if (before) ctx = before.apply(this, args); } catch (e) {}
      var res = orig.apply(this, args);
      try {
        if (after) {
          if (res && typeof res.then === 'function') res.then(function () { try { after.call(null, ctx, args); } catch (e) {} }, function () {});
          else after.call(null, ctx, args);
        }
      } catch (e) {}
      return res;
    };
    w.__ht = true;
    window[name] = w;
  }

  function cartEntry(id) { var s = S(); return s && s.cart && s.cart[id]; }
  function pinfo(p) { return { id: p.id, sku: p.sku, price: p.price }; }

  function afterCartChange() {
    cartDirty = true;
    var items = cartItems(), n = items.reduce(function (a, i) { return a + i.qty; }, 0);
    if (lastCartCount > 0 && n === 0 && !remoteClearing) ev('cart_clear', '', { was: lastCartCount });
    lastCartCount = n;
    if (!timer) timer = setTimeout(flush, 2500);
  }

  function installHooks() {
    wrap('navigate', null, function (c, a) { view(a[0]); });

    wrap('openProduct', null, function (c, a) {
      var s = S(), p = s && ((s.products || []).find(function (x) { return x.id === a[0]; }) || s._lastProduct);
      ev('product', p ? p.name : ('#' + a[0]), p ? pinfo(p) : { id: a[0] });
    });

    wrap('addToCart', function (id) { var e = cartEntry(id); return e ? e.qty : 0; },
      function (before, a) {
        var e = cartEntry(a[0]);
        if (e && e.qty !== before) ev('cart_add', e.product.name, { id: e.product.id, sku: e.product.sku, price: e.product.price, qty: e.qty });
        afterCartChange();
      });
    wrap('removeFromCart', function (id) { var e = cartEntry(id); return e ? { name: e.product.name, id: e.product.id, qty: e.qty } : null; },
      function (b) { if (b) ev('cart_remove', b.name, { id: b.id, qty: b.qty }); afterCartChange(); });
    wrap('adjustQty', null, function (c, a) {
      var e = cartEntry(a[0]); if (e) ev('cart_qty', e.product.name, { id: e.product.id, delta: a[1], qty: e.qty });
      afterCartChange();
    });
    wrap('saveCart', null, function () { cartDirty = true; });
    wrap('toggleCart', null, function () {
      var s = S(); if (s && s.cartOpen) { var it = cartItems(); ev('cart_open', '', { items: it.length, total: it.reduce(function (a, i) { return a + i.price * i.qty; }, 0) }); }
    });

    wrap('downloadCartPDF', function () { return cartItems(); }, function (items) {
      if (!items || !items.length) return;
      ev('download_cart_pdf', 'PDF корзины', { items: items.length, qty: items.reduce(function (a, i) { return a + i.qty; }, 0),
        total: items.reduce(function (a, i) { return a + i.price * i.qty; }, 0) });
      flush(true);
    });
    wrap('openShareModal', null, function () { ev('share_open', 'Окно «Поделиться корзиной»'); });
    wrap('copyShareLink', null, function () { ev('share_copy', 'Скопировал ссылку на корзину'); });
    wrap('shareWhatsApp', null, function () { ev('share_whatsapp', 'Отправил корзину в WhatsApp'); });
    wrap('downloadRepPdf', null, function () { ev('download_catalog_pdf', 'PDF-каталог для представителей'); });

    wrap('setCategory', null, function (c, a) { ev('category', a[0] || 'Все'); });
    wrap('selectCatalogCategory', null, function (c, a) { ev('category', a[0]); });
    wrap('setSort', null, function (c, a) { ev('filter', 'сортировка: ' + a[0]); });
    wrap('setStock', null, function (c, a) { ev('filter', 'наличие: ' + (a[0] || 'все')); });
    wrap('submitSearch', null, function () { var s = S(); if (s && s.search) ev('search', s.search); });

    wrap('doLogin', null, function () { var s = S(); ev(s && s.user && s.user.token ? 'login' : 'login_fail', ''); flush(true); });
    wrap('doRegister', null, function () { var s = S(); ev(s && s.user && s.user.token ? 'register' : 'register_fail', ''); flush(true); });
    ['logout', 'doLogout', 'logoutUser', 'signOut'].forEach(function (n) { wrap(n, null, function () { ev('logout', ''); }); });
  }

  // ── клики по кнопкам ─────────────────────────────────────────────────────
  function labelOf(el) {
    var t = el.getAttribute('data-track') || el.getAttribute('aria-label') || el.title ||
      (el.tagName === 'INPUT' ? (el.id || el.name || el.type) : el.innerText) || el.id || el.className || el.tagName;
    return String(t).replace(/\s+/g, ' ').trim().slice(0, 60);
  }
  document.addEventListener('click', function (e) {
    try {
      var el = e.target && e.target.closest && e.target.closest(
        'button, a, [onclick], [data-track], .bn-btn, .cat-card, .product-card, summary, label, input[type=checkbox], input[type=radio], select');
      if (!el) return;
      if (el.matches('input[type=password], input[type=text], input[type=email], input[type=tel], textarea')) return;
      var label = labelOf(el); if (!label) return;
      var key = label + '|' + (el.id || ''), now = Date.now();
      if (key === lastClick.k && now - lastClick.t < 400) return;
      lastClick = { k: key, t: now };
      var fn = ((el.getAttribute('onclick') || '').match(/^\s*([A-Za-z_$][\w$]*)/) || [])[1];
      ev('click', label, { fn: fn || undefined, id: el.id || undefined, tag: el.tagName.toLowerCase() });
    } catch (err) {}
  }, true);

  window.addEventListener('error', function (e) {
    if (jsErrors++ < 5) ev('js_error', (e.message || 'error').slice(0, 150), { src: String(e.filename || '').split('/').pop(), line: e.lineno });
  });

  // ── пульс и завершение ───────────────────────────────────────────────────
  setInterval(function () {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastAct > IDLE_MS) return;
    flush(true);
  }, HB_MS);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') beacon(); else { touch(); flush(true); }
  });
  window.addEventListener('pagehide', beacon);
  ['scroll', 'keydown', 'touchstart', 'mousemove'].forEach(function (n) {
    window.addEventListener(n, function () { lastAct = Date.now(); }, { passive: true });
  });

  window.htTrack = function (type, name, meta) { ev(type, name, meta); };   // для reels.js и др.

  // ── старт ────────────────────────────────────────────────────────────────
  function start() {
    try {
      installHooks();
      var s = S(); lastCartCount = cartItems().reduce(function (a, i) { return a + i.qty; }, 0);
      ev('open', freshSession ? 'Новая сессия' : 'Возврат на сайт', { ref: (document.referrer || '').slice(0, 120) });
      view(curPage());
      flush(true);
    } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
