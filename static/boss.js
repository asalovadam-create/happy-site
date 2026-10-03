/* Happy Toys · Штаб владельца */
(() => {
'use strict';
const API = '/api/boss';
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const num = n => Number(n || 0).toLocaleString('ru-RU');
const money = n => num(Math.round(Number(n || 0))) + ' ₽';
const dt = iso => iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const tm = iso => iso ? new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
const ago = iso => {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 10) return 'только что';
  if (s < 60) return Math.round(s) + ' с назад';
  if (s < 3600) return Math.round(s / 60) + ' мин назад';
  if (s < 86400) return Math.round(s / 3600) + ' ч назад';
  return Math.round(s / 86400) + ' дн назад';
};
const span = (a, b) => {
  const m = Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000));
  return m < 1 ? '< 1 мин' : m < 60 ? m + ' мин' : Math.floor(m / 60) + ' ч ' + (m % 60) + ' мин';
};

// ── состояние ────────────────────────────────────────────────────────────────
let token = localStorage.getItem('boss_tk') || '';
let timers = [];
let current = '';
const clearTimers = () => { timers.forEach(clearInterval); timers = []; };
const every = (fn, ms) => { timers.push(setInterval(() => { if (!document.hidden) fn(); }, ms)); };

async function api(path, opts = {}) {
  const r = await fetch(API + path, {
    method: opts.method || 'GET',
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if ((r.status === 401 || r.status === 403) && path !== '/login') { logout(); throw new Error('Сессия истекла'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof j.detail === 'string' ? j.detail : 'Ошибка ' + r.status);
  return j;
}

function toast(msg, err) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

function confirmBox({ title, text, ok = 'Удалить', danger = true, word = '' }) {
  return new Promise(res => {
    const m = $('#modal');
    m.innerHTML = `<div class="modal"><h3>${esc(title)}</h3><p>${text}</p>
      ${word ? `<input class="inp" id="cfWord" style="width:100%" placeholder="Введите: ${esc(word)}">` : ''}
      <div class="row"><button class="btn" id="cfNo">Отмена</button><button class="btn ${danger ? 'danger' : 'primary'}" id="cfYes" ${word ? 'disabled' : ''}>${esc(ok)}</button></div></div>`;
    m.hidden = false;
    const done = v => { m.hidden = true; m.innerHTML = ''; res(v); };
    $('#cfNo').onclick = () => done(false);
    m.onclick = e => { if (e.target === m) done(false); };
    if (word) $('#cfWord').oninput = e => { $('#cfYes').disabled = e.target.value.trim().toUpperCase() !== word.toUpperCase(); };
    $('#cfYes').onclick = () => done(true);
  });
}

// ── словари ──────────────────────────────────────────────────────────────────
const PAGES = { home: 'Главная', catalog: 'Каталог', profile: 'Профиль', admin: 'Админ-панель', cart: 'Корзина', favorites: 'Избранное' };
const DEV_ICON = { mobile: '📱', tablet: '📲', desktop: '💻' };
const CONF = { exact: ['точно', 'g'], likely: ['вероятно', 'y'], group: ['группа моделей', 'y'], unknown: ['не определено', 'r'] };

function describeEvent(e) {
  const m = e.meta || {}, n = e.name || '';
  switch (e.type) {
    case 'open': return ['🚪', 'Зашёл на сайт', n === 'Новая сессия' ? 'новая сессия' : 'вернулся' + (m.ref ? ' · из ' + m.ref : '')];
    case 'view': return ['📄', `Открыл раздел «${PAGES[n] || n}»`, ''];
    case 'click': return ['👆', `Нажал «${n}»`, m.fn ? 'функция: ' + m.fn : ''];
    case 'product': return ['🧸', `Смотрит товар «${n}»`, m.sku ? 'арт. ' + m.sku + (m.price ? ' · ' + money(m.price) : '') : ''];
    case 'category': return ['🗂️', `Открыл категорию «${n}»`, ''];
    case 'search': return ['🔎', `Искал «${n}»`, ''];
    case 'filter': return ['🎚️', 'Фильтр: ' + n, ''];
    case 'cart_add': return ['🛒', `В корзину: «${n}»`, `×${m.qty || 1} · ${money(m.price)}`];
    case 'cart_remove': return ['🗑️', `Убрал из корзины «${n}»`, ''];
    case 'cart_qty': return ['➕', `Изменил количество «${n}»`, 'теперь ' + (m.qty ?? '')];
    case 'cart_open': return ['🧺', 'Открыл корзину', `${m.items || 0} поз. · ${money(m.total)}`];
    case 'cart_clear': return ['🧹', 'Очистил корзину', ''];
    case 'download_cart_pdf': return ['⬇️', 'Скачал PDF корзины', `${m.items || 0} поз. · ${money(m.total)}`];
    case 'download_catalog_pdf': return ['⬇️', 'Скачал PDF-каталог', 'сотрудник'];
    case 'share_open': return ['📤', 'Открыл «Поделиться корзиной»', ''];
    case 'share_copy': return ['🔗', 'Скопировал ссылку на корзину', ''];
    case 'share_whatsapp': return ['💬', 'Отправил корзину в WhatsApp', ''];
    case 'login': return ['🔑', 'Вошёл в аккаунт', ''];
    case 'login_fail': return ['⛔', 'Неудачная попытка входа', ''];
    case 'register': return ['🎉', 'Зарегистрировался', ''];
    case 'register_fail': return ['⛔', 'Неудачная регистрация', ''];
    case 'logout': return ['🚪', 'Вышел из аккаунта', ''];
    case 'js_error': return ['⚠️', 'Ошибка на сайте: ' + n, (m.src || '') + (m.line ? ':' + m.line : '')];
    default: return ['•', e.type + (n ? ': ' + n : ''), ''];
  }
}
const personName = r => {
  const n = `${r.first_name || ''} ${r.last_name || ''}`.trim();
  return n || (r.email ? r.email : '');
};
const who = r => personName(r) || 'Гость ' + (r.vid || '').slice(0, 4);
const confTag = r => {
  const c = CONF[r.confidence] || CONF.unknown;
  return `<span class="tag ${c[1]}" title="${esc(r.hint || '')}">${c[0]}</span>`;
};
const devLine = r => [r.os && (r.os + (r.os_version ? ' ' + r.os_version : '')), r.browser && (r.browser + (r.browser_version ? ' ' + r.browser_version : ''))].filter(Boolean).join(' · ');

// ── вход / выход ─────────────────────────────────────────────────────────────
function showLogin(msg) {
  $('#app').hidden = true; $('#login').hidden = false;
  $('#loginOff').hidden = document.body.dataset.enabled === '1';
  $('#lgErr').textContent = msg || '';
}
function logout() {
  token = ''; localStorage.removeItem('boss_tk'); clearTimers(); showLogin('');
}
$('#loginForm').onsubmit = async e => {
  e.preventDefault();
  const btn = $('#lgBtn'); btn.disabled = true; $('#lgErr').textContent = '';
  try {
    const j = await api('/login', { method: 'POST', body: { username: $('#lgUser').value.trim(), password: $('#lgPass').value } });
    token = j.token; localStorage.setItem('boss_tk', token); $('#lgPass').value = ''; boot();
  } catch (err) { $('#lgErr').textContent = err.message; }
  btn.disabled = false;
};
$('#logoutBtn').onclick = logout;

// ── навигация ────────────────────────────────────────────────────────────────
const NAV = [
  ['live', '🟢', 'Сейчас', 'Сейчас на сайте'], ['overview', '📊', 'Обзор', 'Обзор'],
  ['visitors', '👥', 'Посетители', 'Посетители и устройства'], ['customers', '🪪', 'Пользователи', 'База пользователей'],
  ['carts', '🛒', 'Корзины', 'Корзины'], ['actions', '🖱️', 'Действия', 'Что делают на сайте'],
  ['downloads', '⬇️', 'Скачивания', 'Скачивания и «поделиться»'], ['exports', '📦', 'Выгрузки', 'Выгрузка данных'],
];
function buildNav() {
  $('#nav').innerHTML = NAV.map(([id, ic, name]) =>
    `<button class="nav-i" data-v="${id}"><span class="ic">${ic}</span><span>${name}</span></button>`).join('');
  $('#nav').onclick = e => { const b = e.target.closest('.nav-i'); if (b) go(b.dataset.v); };
}
const VIEWS = {};
function go(name) {
  if (!VIEWS[name]) name = 'live';
  clearTimers(); current = name; location.hash = '#' + name;
  document.querySelectorAll('.nav-i').forEach(b => b.classList.toggle('on', b.dataset.v === name));
  $('#title').textContent = NAV.find(n => n[0] === name)[3];
  const v = $('#view'); v.innerHTML = '<div class="empty">Загрузка…</div>';
  v.style.animation = 'none'; void v.offsetWidth; v.style.animation = '';
  Promise.resolve(VIEWS[name](v)).catch(err => { if (err.message !== 'Сессия истекла') v.innerHTML = `<div class="empty">Не удалось загрузить: ${esc(err.message)}</div>`; });
  window.scrollTo(0, 0);
}
function tickClock() { $('#clock').textContent = new Date().toLocaleString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }); }

// ── общие блоки ──────────────────────────────────────────────────────────────
const kpi = (label, val, sub, color) => `<div class="card kpi" style="--k:${color || 'var(--orange)'}"><small>${label}</small><b>${val}</b><em>${sub || '&nbsp;'}</em></div>`;
function hbars(rows, color) {
  if (!rows || !rows.length) return '<div class="empty" style="padding:18px">Пока нет данных</div>';
  const max = Math.max(...rows.map(r => r.n), 1);
  return `<div class="hbar">${rows.map(r => `<div class="hb"><span class="hb-n" title="${esc(r.name)}">${esc(r.name)}</span>
    <span class="hb-t"><i style="width:${Math.max(4, r.n / max * 100)}%;${color ? 'background:' + color : ''}"></i></span><span class="hb-v">${num(r.n)}</span></div>`).join('')}</div>`;
}
function barChart(vals, labels, titleFn) {
  const max = Math.max(...vals, 1);
  return `<div class="bars">${vals.map((v, i) => `<div class="bar" style="height:${Math.max(3, v / max * 100)}%" data-t="${esc(titleFn(i, v))}"></div>`).join('')}</div>
    <div class="bar-x"><span>${labels[0]}</span><span>${labels[1]}</span><span>${labels[2]}</span></div>`;
}
function pager(total, offset, limit, id) {
  const from = total ? offset + 1 : 0, to = Math.min(total, offset + limit);
  return `<div class="pager"><span>${from}–${to} из ${num(total)}</span><div style="display:flex;gap:8px">
    <button class="btn sm" data-pg="${id}" data-d="-1" ${offset <= 0 ? 'disabled' : ''}>← Назад</button>
    <button class="btn sm" data-pg="${id}" data-d="1" ${offset + limit >= total ? 'disabled' : ''}>Дальше →</button></div></div>`;
}
const debounce = (fn, ms = 350) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ── 1. Сейчас ────────────────────────────────────────────────────────────────
VIEWS.live = async v => {
  v.innerHTML = `<div class="grid g-kpi" id="kpis"></div>
    <div class="grid g-2">
      <div class="card"><h3>Сейчас на сайте <span class="tag g" id="onN">0</span></h3><div class="online" id="online"></div></div>
      <div class="card"><h3>Что делают <span class="tag c">в реальном времени</span></h3><div class="feed" id="feed"></div></div>
    </div>`;
  let lastId = 0, items = [];
  const kp = async () => {
    const o = (await api('/overview')).totals;
    $('#kpis').innerHTML =
      kpi('Онлайн сейчас', num(o.online), 'активны последние 90 сек', 'var(--green)') +
      kpi('Посетителей за 24 ч', num(o.visitors_24h), `новых: ${num(o.new_24h)}`, 'var(--cyan)') +
      kpi('Действий за 24 ч', num(o.events_24h), 'клики, поиск, просмотры', 'var(--purple)') +
      kpi('Корзины на сайте', num(o.live_carts), money(o.live_carts_sum), 'var(--orange)') +
      kpi('Скачиваний за 7 дн', num(o.downloads_7d), 'PDF и «поделиться»', 'var(--pink)');
  };
  const tick = async () => {
    const [live, feed] = await Promise.all([api('/live'), api('/feed?since=' + lastId + '&limit=80')]);
    const on = live.online;
    $('#onN').textContent = on.length;
    $('#livePill').querySelector('span').textContent = 'онлайн: ' + on.length;
    $('#online').innerHTML = on.length ? on.map(s => {
      const [pt, pa] = (s.last_action || '|').split('|');
      const act = pt ? describeEvent({ type: pt, name: pa, meta: {} }) : null;
      return `<div class="sess" data-vid="${esc(s.vid)}">
        <div class="av">${DEV_ICON[s.device_type] || '🌐'}</div>
        <div><div class="sess-n">${esc(who(s))} ${s.first_name || s.email ? '<span class="tag g">аккаунт</span>' : '<span class="tag">гость</span>'}</div>
          <div class="sess-d">${esc(s.device_name || 'Устройство не определено')} ${confTag(s)}</div>
          <div class="sess-d">${esc(devLine(s))} · ${esc(s.ip)}</div>
          <div class="sess-now">📍 ${esc(PAGES[s.page] || s.page || '—')}${act ? ' · ' + esc(act[1]) : ''}</div></div>
        <div class="sess-r"><span>на сайте ${span(s.started_at, s.last_seen)}</span>${s.cart_items > 0 ? `<span class="tag o">🛒 ${s.cart_items} · ${money(s.cart_total)}</span>` : ''}</div></div>`;
    }).join('') : '<div class="empty">Сейчас на сайте никого нет</div>';
    if (feed.events.length) {
      const fresh = feed.events.filter(e => e.id > lastId);
      if (fresh.length) {
        const firstLoad = lastId === 0;
        lastId = Math.max(lastId, ...fresh.map(e => e.id));
        items = fresh.map(e => ({ ...e, _new: !firstLoad })).concat(items).slice(0, 150);
        renderFeed($('#feed'), items);
      }
    } else if (!items.length) $('#feed').innerHTML = '<div class="empty">Событий пока нет</div>';
    $('#feed').querySelectorAll('.fe.new').forEach(el => setTimeout(() => el.classList.remove('new'), 1700));
    items.forEach(i => { i._new = false; });
  };
  v.onclick = e => { const s = e.target.closest('[data-vid]'); if (s) openVisitor(s.dataset.vid); };
  await Promise.all([kp(), tick()]);
  every(tick, 4000); every(kp, 20000);
};
function renderFeed(el, items) {
  el.innerHTML = items.map(e => {
    const [ic, t, sub] = describeEvent(e);
    const w = personName(e) || ('Гость ' + (e.vid || '').slice(0, 4));
    return `<div class="fe ${e._new ? 'new' : ''}" data-vid="${esc(e.vid)}"><div class="fe-i">${ic}</div>
      <div class="fe-t">${esc(t)}<small>${esc(w)} · ${esc(e.device_name || '')}${sub ? ' · ' + esc(sub) : ''}</small></div>
      <div class="fe-time">${tm(e.ts)}</div></div>`;
  }).join('');
}

// ── 2. Обзор ─────────────────────────────────────────────────────────────────
VIEWS.overview = async v => {
  const [ov, st] = await Promise.all([api('/overview'), api('/stats?days=30')]);
  const o = ov.totals;
  const now = new Date(); now.setMinutes(0, 0, 0);
  const hmap = {}; ov.hours.forEach(r => { hmap[new Date(r.h).getTime()] = r.n; });
  const hv = [], hl = [];
  for (let i = 23; i >= 0; i--) { const t = now.getTime() - i * 3600000; hv.push(hmap[t] || 0); hl.push(new Date(t).getHours() + ':00'); }
  const d0 = new Date(); d0.setHours(0, 0, 0, 0);
  const dmap = {}; ov.days.forEach(r => { const d = new Date(r.d); d.setHours(0, 0, 0, 0); dmap[d.getTime()] = r.n; });
  const dv = [], dl = [];
  for (let i = 13; i >= 0; i--) { const t = d0.getTime() - i * 86400000; dv.push(dmap[t] || 0); dl.push(new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })); }
  v.innerHTML = `<div class="grid g-kpi">
      ${kpi('Всего посетителей', num(o.visitors_total), `за сутки: ${num(o.visitors_24h)}`, 'var(--cyan)')}
      ${kpi('Пользователей', num(o.customers_total), `за 7 дней: +${num(o.customers_7d)}`, 'var(--green)')}
      ${kpi('Отправленных корзин', num(o.orders_total), money(o.orders_sum), 'var(--orange)')}
      ${kpi('Корзины на сайте', num(o.live_carts), money(o.live_carts_sum), 'var(--pink)')}</div>
    <div class="grid g-eq" style="margin-bottom:16px">
      <div class="card"><h3>Посетители по часам <span class="tag">24 часа</span></h3>${barChart(hv, [hl[0], hl[12], hl[23]], (i, n) => `${hl[i]} — ${n}`)}</div>
      <div class="card"><h3>Посетители по дням <span class="tag">14 дней</span></h3>${barChart(dv, [dl[0], dl[7], dl[13]], (i, n) => `${dl[i]} — ${n}`)}</div></div>
    <div class="grid g-eq">
      <div class="card"><h3>Устройства <span class="tag">30 дней</span></h3>${hbars(st.devices)}</div>
      <div class="card"><h3>Браузеры</h3>${hbars(st.browsers, 'linear-gradient(90deg,var(--orange),var(--yellow))')}</div>
      <div class="card"><h3>Системы</h3>${hbars(st.os, 'linear-gradient(90deg,var(--green),var(--cyan))')}</div>
      <div class="card"><h3>Тип устройства</h3>${hbars(st.types.map(t => ({ ...t, name: { mobile: 'Телефон', tablet: 'Планшет', desktop: 'Компьютер' }[t.name] || t.name })), 'linear-gradient(90deg,var(--pink),var(--purple))')}</div></div>`;
};

// ── 3. Посетители ────────────────────────────────────────────────────────────
const VS = { q: '', kind: '', offset: 0 };
VIEWS.visitors = async v => {
  const kinds = [['', 'Все'], ['registered', 'С аккаунтом'], ['guests', 'Гости'], ['mobile', 'Телефоны'], ['tablet', 'Планшеты'], ['desktop', 'Компьютеры']];
  v.innerHTML = `<div class="tools"><input class="inp" id="vq" placeholder="Поиск: устройство, IP, имя, телефон, email…" value="${esc(VS.q)}">
    <div class="chips" id="vk">${kinds.map(([k, n]) => `<button class="chip ${VS.kind === k ? 'on' : ''}" data-k="${k}">${n}</button>`).join('')}</div></div>
    <div id="vt"></div>`;
  const load = async () => {
    const j = await api(`/visitors?q=${encodeURIComponent(VS.q)}&kind=${VS.kind}&limit=50&offset=${VS.offset}`);
    $('#vt').innerHTML = j.items.length ? `<div class="tbl-wrap"><table><thead><tr><th>Устройство</th><th>Кто</th><th>IP</th><th>Визитов</th><th>Последний визит</th><th>Корзина</th></tr></thead><tbody>
      ${j.items.map(r => `<tr class="click" data-vid="${esc(r.vid)}">
        <td><b>${DEV_ICON[r.device_type] || '🌐'} ${esc(r.device_name || '—')}</b> ${confTag(r)}<div class="sub">${esc(devLine(r))}</div></td>
        <td>${personName(r) ? `<b>${esc(personName(r))}</b><div class="sub">${esc(r.phone || r.email || '')}</div>` : '<span class="tag">гость</span>'}</td>
        <td class="mono">${esc(r.ip)}</td><td>${num(r.visits)}</td>
        <td>${ago(r.last_seen)}<div class="sub">${dt(r.last_seen)}</div></td>
        <td>${r.cart_items > 0 ? `<span class="tag o">🛒 ${r.cart_items} · ${money(r.cart_total)}</span>` : '<span class="sub">—</span>'}</td></tr>`).join('')}
      </tbody></table></div>${pager(j.total, VS.offset, 50, 'v')}` : '<div class="empty">Никого не найдено</div>';
  };
  v.onclick = e => {
    const r = e.target.closest('tr[data-vid]'); if (r) return openVisitor(r.dataset.vid);
    const k = e.target.closest('[data-k]'); if (k) { VS.kind = k.dataset.k; VS.offset = 0; go('visitors'); return; }
    const p = e.target.closest('[data-pg="v"]'); if (p) { VS.offset = Math.max(0, VS.offset + 50 * +p.dataset.d); load(); }
  };
  $('#vq').oninput = debounce(e => { VS.q = e.target.value; VS.offset = 0; load(); });
  await load(); every(load, 15000);
};

// ── 4. Пользователи ──────────────────────────────────────────────────────────
const CS = { q: '', offset: 0 };
VIEWS.customers = async v => {
  v.innerHTML = `<div class="tools"><input class="inp" id="cq" placeholder="Поиск: имя, email, телефон, адрес…" value="${esc(CS.q)}">
    <button class="btn primary" data-ex="csv">⬇ Вся база · Excel (CSV)</button><button class="btn" data-ex="json">JSON</button></div><div id="ct"></div>`;
  const load = async () => {
    const j = await api(`/customers?q=${encodeURIComponent(CS.q)}&limit=50&offset=${CS.offset}`);
    $('#ct').innerHTML = j.items.length ? `<div class="tbl-wrap"><table><thead><tr><th>Пользователь</th><th>Телефон / адрес</th><th>Регистрация</th><th>Устройства</th><th>Корзины</th><th>Был на сайте</th></tr></thead><tbody>
      ${j.items.map(r => `<tr class="click" data-cid="${esc(r.id)}">
        <td><b>${esc(personName({ first_name: r.first_name, last_name: r.last_name }) || '—')}</b><div class="sub">${esc(r.email)}</div></td>
        <td>${esc(r.phone || '—')}<div class="sub">${esc(r.address || '')}</div></td>
        <td>${dt(r.created_at)}</td>
        <td>${esc(r.device_names || '—')}<div class="sub">устройств: ${r.devices_count} · действий: ${num(r.events_count)}</div></td>
        <td>${num(r.orders_count)}<div class="sub">${money(r.orders_sum)}</div></td>
        <td>${r.last_seen ? ago(r.last_seen) : '<span class="sub">не было</span>'}</td></tr>`).join('')}
      </tbody></table></div>${pager(j.total, CS.offset, 50, 'c')}` : '<div class="empty">Никого не найдено</div>';
  };
  v.onclick = e => {
    const ex = e.target.closest('[data-ex]'); if (ex) return download('customers', ex.dataset.ex);
    const r = e.target.closest('tr[data-cid]'); if (r) return openCustomer(r.dataset.cid);
    const p = e.target.closest('[data-pg="c"]'); if (p) { CS.offset = Math.max(0, CS.offset + 50 * +p.dataset.d); load(); }
  };
  $('#cq').oninput = debounce(e => { CS.q = e.target.value; CS.offset = 0; load(); });
  await load();
};

// ── 5. Корзины ───────────────────────────────────────────────────────────────
let cartTab = 'live';
VIEWS.carts = async v => {
  v.innerHTML = `<div class="tools"><div class="chips" id="ctabs">
      <button class="chip ${cartTab === 'live' ? 'on' : ''}" data-t="live">🛒 У людей на сайте сейчас</button>
      <button class="chip ${cartTab === 'orders' ? 'on' : ''}" data-t="orders">📨 Отправленные корзины</button></div></div><div id="cbody"></div>`;
  v.onclick = e => { const t = e.target.closest('[data-t]'); if (t) { cartTab = t.dataset.t; go('carts'); } };
  await (cartTab === 'live' ? cartsLive : cartsOrders)($('#cbody'));
};
const itemsHtml = items => `<div class="items">${(items || []).map(i => `<div class="it"><div>${esc(i.name)}<small>арт. ${esc(i.sku || '—')}</small></div><span>×${num(i.qty)}</span><b>${money((i.price || 0) * (i.qty || 1))}</b></div>`).join('')}</div>`;
async function cartsLive(box) {
  const load = async () => {
    const j = await api('/carts/live');
    box.innerHTML = (j.items.length ? `<div class="tools"><span class="sub" style="color:var(--muted);font-weight:700">Корзин: ${j.items.length} · на ${money(j.items.reduce((a, r) => a + r.cart_total, 0))}</span>
      <button class="btn danger sm" data-all="1" style="margin-left:auto">Очистить у всех</button></div>` : '') +
      `<div class="grid g-eq">${j.items.map(r => `<div class="card cart-card"><div class="cart-h"><div><b>${esc(who(r))}</b>
        <div class="sub" style="color:var(--muted);font-weight:600">${esc(r.device_name || '')} · обновлена ${ago(r.cart_updated)}</div></div>
        <div style="display:flex;gap:6px"><button class="btn sm" data-vid="${esc(r.vid)}">Профиль</button><button class="btn danger sm" data-clear="${esc(r.vid)}">Очистить</button></div></div>
        ${itemsHtml(r.cart)}<div style="text-align:right;font-weight:800">Итого: ${money(r.cart_total)}</div></div>`).join('')}</div>` +
      (j.items.length ? `<div class="note">Очистка работает «дистанционно»: у человека корзина пропадёт в течение ~30 секунд, пока он на сайте (или при следующем заходе), и появится уведомление.</div>` : '<div class="empty">Сейчас ни у кого нет товаров в корзине</div>');
  };
  box.onclick = async e => {
    const vid = e.target.closest('[data-vid]'); if (vid) return openVisitor(vid.dataset.vid);
    const c = e.target.closest('[data-clear]');
    if (c && await confirmBox({ title: 'Очистить корзину?', text: 'У этого посетителя корзина будет очищена.', ok: 'Очистить' })) {
      await api(`/carts/live/${c.dataset.clear}/clear`, { method: 'POST' }); toast('Корзина очищена'); load();
    }
    if (e.target.closest('[data-all]') && await confirmBox({ title: 'Очистить ВСЕ корзины?', text: 'Корзины будут очищены у всех посетителей сайта.', ok: 'Очистить все', word: 'ОЧИСТИТЬ' })) {
      const r = await api('/carts/live/clear-all', { method: 'POST' }); toast('Очищено корзин: ' + r.cleared); load();
    }
  };
  await load(); every(load, 15000);
}
const OS = { q: '', offset: 0, sel: new Set() };
async function cartsOrders(box) {
  box.innerHTML = `<div class="tools"><input class="inp" id="oq" placeholder="Поиск: код, магазин, контакт, имя…" value="${esc(OS.q)}">
    <button class="btn danger sm" id="oDelSel" disabled>Удалить выбранные</button>
    <select class="inp" id="oOld"><option value="">Удалить старые…</option><option value="30">старше 30 дней</option><option value="90">старше 90 дней</option><option value="180">старше 180 дней</option><option value="365">старше года</option></select></div><div id="ot"></div>`;
  const upd = () => { $('#oDelSel').disabled = !OS.sel.size; $('#oDelSel').textContent = OS.sel.size ? `Удалить выбранные (${OS.sel.size})` : 'Удалить выбранные'; };
  const load = async () => {
    const j = await api(`/orders?q=${encodeURIComponent(OS.q)}&limit=30&offset=${OS.offset}`);
    $('#ot').innerHTML = j.items.length ? `<div class="grid">${j.items.map(r => `<div class="card cart-card">
      <div class="cart-h"><label style="display:flex;gap:10px;align-items:center;cursor:pointer"><input type="checkbox" data-sel="${esc(r.code)}" ${OS.sel.has(r.code) ? 'checked' : ''}>
        <div><b>${esc(r.code)}</b> · ${esc(personName(r) || r.store_name || 'Гость')}<div class="sub" style="color:var(--muted);font-weight:600">${dt(r.created_at)}${r.contact ? ' · ' + esc(r.contact) : ''}${r.store_name ? ' · ' + esc(r.store_name) : ''}</div></div></label>
        <div style="display:flex;gap:8px;align-items:center"><b>${money(r.total)}</b><button class="btn danger sm" data-del="${esc(r.code)}">Удалить</button></div></div>
      ${r.comment ? `<div class="note" style="margin:0">💬 ${esc(r.comment)}</div>` : ''}${itemsHtml(r.items)}</div>`).join('')}</div>${pager(j.total, OS.offset, 30, 'o')}` : '<div class="empty">Отправленных корзин нет</div>';
    upd();
  };
  const del = async (body, text) => {
    if (!await confirmBox({ title: 'Удалить безвозвратно?', text })) return;
    const r = await api('/orders/delete', { method: 'POST', body }); toast('Удалено: ' + r.deleted); OS.sel.clear(); load();
  };
  box.onclick = e => {
    const d = e.target.closest('[data-del]'); if (d) return del({ codes: [d.dataset.del] }, `Корзина <b>${esc(d.dataset.del)}</b> будет удалена.`);
    const p = e.target.closest('[data-pg="o"]'); if (p) { OS.offset = Math.max(0, OS.offset + 30 * +p.dataset.d); load(); }
    if (e.target.id === 'oDelSel') del({ codes: [...OS.sel] }, `Будет удалено корзин: <b>${OS.sel.size}</b>.`);
  };
  box.onchange = e => {
    if (e.target.dataset.sel) { e.target.checked ? OS.sel.add(e.target.dataset.sel) : OS.sel.delete(e.target.dataset.sel); upd(); }
    if (e.target.id === 'oOld' && e.target.value) { const n = +e.target.value; e.target.value = ''; del({ older_than_days: n }, `Будут удалены все корзины старше <b>${n} дн.</b>`); }
  };
  $('#oq').oninput = debounce(e => { OS.q = e.target.value; OS.offset = 0; load(); });
  await load();
}

// ── 6. Действия ──────────────────────────────────────────────────────────────
let AF = { type: '', days: 7 };
VIEWS.actions = async v => {
  const types = [['', 'Всё'], ['click', 'Нажатия'], ['cart_', 'Корзина'], ['search', 'Поиск'], ['product', 'Товары'], ['view', 'Разделы'], ['category', 'Категории'], ['js_error', 'Ошибки']];
  v.innerHTML = `<div class="grid g-2"><div class="card"><h3>Лента действий</h3>
      <div class="chips" style="margin-bottom:12px" id="atypes">${types.map(([k, n]) => `<button class="chip ${AF.type === k ? 'on' : ''}" data-k="${k}">${n}</button>`).join('')}</div>
      <div class="feed" id="afeed" style="max-height:720px"></div></div>
    <div id="astats"></div></div>`;
  const loadFeed = async () => {
    const j = await api(`/feed?since=0&limit=150&type=${encodeURIComponent(AF.type)}`);
    $('#afeed').innerHTML = j.events.length ? '' : '<div class="empty">Нет событий</div>'; if (j.events.length) renderFeed($('#afeed'), j.events);
  };
  const loadStats = async () => {
    const s = await api('/stats?days=' + AF.days);
    $('#astats').innerHTML = `<div class="tools"><select class="inp" id="adays">${[1, 7, 30, 90].map(d => `<option value="${d}" ${AF.days === d ? 'selected' : ''}>за ${d === 1 ? 'сутки' : d + ' дн.'}</option>`).join('')}</select></div>
      <div class="grid"><div class="card"><h3>Какие кнопки жмут чаще всего</h3>${hbars(s.clicks)}</div>
      <div class="card"><h3>Какие товары смотрят</h3>${hbars(s.products, 'linear-gradient(90deg,var(--orange),var(--yellow))')}</div>
      <div class="card"><h3>Что добавляют в корзину</h3>${hbars(s.cart_add, 'linear-gradient(90deg,var(--green),var(--cyan))')}</div>
      <div class="card"><h3>Что ищут</h3>${hbars(s.searches, 'linear-gradient(90deg,var(--pink),var(--purple))')}</div>
      <div class="card"><h3>Категории</h3>${hbars(s.categories)}</div></div>`;
    $('#adays').onchange = e => { AF.days = +e.target.value; loadStats(); };
  };
  v.onclick = e => {
    const k = e.target.closest('#atypes [data-k]'); if (k) { AF.type = k.dataset.k; go('actions'); return; }
    const f = e.target.closest('[data-vid]'); if (f) openVisitor(f.dataset.vid);
  };
  await Promise.all([loadFeed(), loadStats()]); every(loadFeed, 8000);
};

// ── 7. Скачивания ────────────────────────────────────────────────────────────
VIEWS.downloads = async v => {
  const j = await api('/downloads?limit=150');
  v.innerHTML = `<div class="grid g-2"><div class="card"><h3>Скачивания и «поделиться» <span class="tag o">${j.items.length}</span></h3>
      ${j.items.length ? `<div class="feed" id="dfeed" style="max-height:760px"></div>` : '<div class="empty">Пока никто ничего не скачивал</div>'}</div>
    <div class="card"><h3>PDF-каталог для представителей</h3>${j.staff_pdf.length ? j.staff_pdf.map(r => `<div class="fe" style="cursor:default"><div class="fe-i">📄</div>
      <div class="fe-t">${esc((r.detail || '').replace('[boss] ', ''))}</div><div class="fe-time">${dt(r.ts)}</div></div>`).join('') : '<div class="empty">Сотрудники ещё не скачивали</div>'}</div></div>`;
  if (j.items.length) renderFeed($('#dfeed'), j.items);
  v.onclick = e => { const f = e.target.closest('[data-vid]'); if (f) openVisitor(f.dataset.vid); };
};

// ── 8. Выгрузки ──────────────────────────────────────────────────────────────
VIEWS.exports = async v => {
  const cards = [
    ['customers', '🪪', 'Вся база пользователей', 'Имя, email, телефон, адрес, дата регистрации, заказы, устройства, последний визит. Пароли не выгружаются.'],
    ['visitors', '👥', 'Все посетители и устройства', 'Устройство, ОС, браузер, экран, язык, часовой пояс, IP, визиты, корзина.'],
    ['events', '🖱️', 'Все действия на сайте', 'Каждый клик, поиск, просмотр, скачивание — с временем и устройством.'],
    ['orders', '📨', 'Отправленные корзины', 'Все корзины с составом и суммой.'],
  ];
  v.innerHTML = `<div class="grid g-eq">${cards.map(([k, ic, t, d]) => `<div class="card"><h3>${ic} ${t}</h3><p style="color:var(--muted);font-weight:600;margin-bottom:14px">${d}</p>
    ${k === 'events' ? `<select class="inp" id="exDays" style="margin-bottom:12px"><option value="7">за 7 дней</option><option value="30" selected>за 30 дней</option><option value="90">за 90 дней</option><option value="365">за год</option></select>` : ''}
    <div style="display:flex;gap:8px"><button class="btn primary" data-ex="${k}" data-f="csv">Excel (CSV)</button><button class="btn" data-ex="${k}" data-f="json">JSON</button></div></div>`).join('')}</div>
    <div class="note" style="margin-top:16px">В выгрузках — данные, которые люди оставили сами (при регистрации и оформлении) и технические данные об устройстве. Храните файлы в безопасном месте и не пересылайте посторонним.</div>`;
  v.onclick = e => { const b = e.target.closest('[data-ex]'); if (b) download(b.dataset.ex, b.dataset.f, $('#exDays')?.value); };
};
async function download(kind, fmt, days) {
  try {
    toast('Готовлю файл…');
    const r = await fetch(`${API}/export/${kind}?fmt=${fmt}&days=${days || 30}`, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) throw new Error('Не удалось сформировать файл');
    const blob = await r.blob();
    const name = ((r.headers.get('content-disposition') || '').match(/filename="([^"]+)"/) || [])[1] || `${kind}.${fmt}`;
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    toast('Файл скачан: ' + name);
  } catch (e) { toast(e.message, true); }
}

// ── Панель: посетитель ───────────────────────────────────────────────────────
const drawer = $('#drawer'), dback = $('#drawerBack');
function openDrawer(html) { drawer.innerHTML = html; drawer.hidden = false; dback.hidden = false; drawer.scrollTop = 0; document.body.style.overflow = 'hidden'; }
function closeDrawer() { drawer.hidden = true; dback.hidden = true; drawer.innerHTML = ''; document.body.style.overflow = ''; }
dback.onclick = closeDrawer;
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
drawer.addEventListener('click', e => {
  if (e.target.closest('.x')) return closeDrawer();
  const vv = e.target.closest('[data-vid]'); if (vv) return openVisitor(vv.dataset.vid);
});
const kv = rows => `<dl class="kv">${rows.filter(r => r[1] !== '' && r[1] != null).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
const timeline = ev => ev.length ? `<div class="feed" style="max-height:none">${ev.map(e => {
  const [ic, t, sub] = describeEvent(e);
  return `<div class="fe" style="cursor:default"><div class="fe-i">${ic}</div><div class="fe-t">${esc(t)}${sub ? `<small>${esc(sub)}</small>` : ''}</div><div class="fe-time">${dt(e.ts)}</div></div>`;
}).join('')}</div>` : '<div class="empty" style="padding:16px">Нет действий</div>';

async function openVisitor(vid) {
  openDrawer('<div class="empty">Загрузка…</div>');
  try {
    const d = await api('/visitors/' + encodeURIComponent(vid));
    const v = d.visitor, i = v.info || {}, c = d.customer;
    const screenTxt = i.screen_w ? `${i.screen_w}×${i.screen_h} (плотность ×${i.dpr})` : '';
    openDrawer(`<div class="dr-h"><div><h2>${DEV_ICON[v.device_type] || '🌐'} ${esc(v.device_name || 'Устройство не определено')}</h2>
        <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">${confTag(v)}${i.staff ? '<span class="tag p">сотрудник</span>' : ''}${c ? '<span class="tag g">аккаунт</span>' : '<span class="tag">гость</span>'}${i.standalone ? '<span class="tag c">установлено как приложение</span>' : ''}</div></div>
        <button class="x">✕</button></div>
      ${v.hint ? `<div class="note" style="margin:0 0 18px">ℹ️ ${esc(v.hint)}</div>` : ''}
      ${c ? `<div class="sec"><h4>Пользователь</h4>${kv([['Имя', esc(personName(c))], ['Email', esc(c.email)], ['Телефон', esc(c.phone)], ['Адрес', esc(c.address)], ['Регистрация', dt(c.created_at)]])}
        <div style="margin-top:10px"><button class="btn sm" id="toCust" data-cid="${esc(c.id)}">Открыть карточку пользователя</button></div></div>` : ''}
      <div class="sec"><h4>Устройство</h4>${kv([
        ['Название', esc(v.device_name)], ['Бренд', esc(v.brand)], ['Код модели', v.model_raw ? `<span class="mono">${esc(v.model_raw)}</span>` : ''],
        ['Система', esc(`${v.os} ${v.os_version}`.trim())], ['Браузер', esc(`${v.browser} ${v.browser_version}`.trim())],
        ['Экран', esc(screenTxt)], ['Окно браузера', i.vw ? `${i.vw}×${i.vh}` : ''], ['Процессор', i.cores ? i.cores + ' ядер' : ''],
        ['Память', i.mem ? '≈ ' + i.mem + ' ГБ' : ''], ['Видеочип', esc(i.gpu)], ['Язык', esc(i.lang)], ['Часовой пояс', esc(i.tz)],
        ['Сеть', esc([i.conn, i.downlink ? i.downlink + ' Мбит/с' : '', i.save ? 'экономия трафика' : ''].filter(Boolean).join(' · '))],
        ['Тёмная тема', i.dark ? 'да' : (i.dark === false ? 'нет' : '')], ['Режим', i.standalone ? 'приложение (PWA)' : 'браузер'],
        ['Пришёл с', esc(i.ref || 'напрямую')], ['IP', `<span class="mono">${esc(v.ip)}</span>`],
        ['Первый визит', dt(v.first_seen)], ['Последний визит', dt(v.last_seen) + ' · ' + ago(v.last_seen)], ['Визитов', num(v.visits)],
        ['ID посетителя', `<span class="mono">${esc(v.vid)}</span>`]])}</div>
      <div class="sec"><h4>Корзина сейчас</h4>${v.cart && v.cart.length ? itemsHtml(v.cart) + `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px"><b>Итого: ${money(v.cart_total)}</b>
        <button class="btn danger sm" id="drClear">Очистить корзину</button></div>` : '<div class="sub" style="color:var(--muted)">Пусто</div>'}</div>
      ${d.orders.length ? `<div class="sec"><h4>Отправленные корзины (${d.orders.length})</h4>${d.orders.map(o => `<div class="card" style="margin-bottom:10px;padding:12px"><div class="cart-h"><b>${esc(o.code)} · ${money(o.total)}</b><span class="sub" style="color:var(--muted)">${dt(o.created_at)}</span></div>${itemsHtml(o.items)}</div>`).join('')}</div>` : ''}
      <div class="sec"><h4>Сводка действий</h4><div style="display:flex;gap:6px;flex-wrap:wrap">${d.counts.map(x => `<span class="tag c">${esc(describeEvent({ type: x.type, name: '', meta: {} })[1].replace(/«.*»/, '').replace(/:.*/, '').trim() || x.type)} · ${x.n}</span>`).join('') || '<span class="sub">нет</span>'}</div></div>
      <div class="sec"><h4>Сессии (${d.sessions.length})</h4>${d.sessions.slice(0, 12).map(s => `<div class="it" style="grid-template-columns:1fr auto"><div>${dt(s.started_at)}<small>на сайте ${span(s.started_at, s.last_seen)} · действий: ${s.events}</small></div><span class="tag">${esc(PAGES[s.page] || s.page || '—')}</span></div>`).join('')}</div>
      <div class="sec"><h4>Хронология (последние ${d.events.length})</h4>${timeline(d.events)}</div>`);
    const tc = $('#toCust'); if (tc) tc.onclick = () => openCustomer(tc.dataset.cid);
    const cl = $('#drClear');
    if (cl) cl.onclick = async () => {
      if (!await confirmBox({ title: 'Очистить корзину?', text: 'Корзина этого посетителя будет очищена.', ok: 'Очистить' })) return;
      await api(`/carts/live/${encodeURIComponent(vid)}/clear`, { method: 'POST' }); toast('Корзина очищена'); openVisitor(vid);
    };
  } catch (e) { openDrawer(`<div class="dr-h"><h2>Ошибка</h2><button class="x">✕</button></div><div class="empty">${esc(e.message)}</div>`); }
}

// ── Панель: пользователь ─────────────────────────────────────────────────────
async function openCustomer(cid) {
  openDrawer('<div class="empty">Загрузка…</div>');
  try {
    const d = await api('/customers/' + encodeURIComponent(cid)), c = d.customer;
    openDrawer(`<div class="dr-h"><div><h2>${esc(personName(c) || c.email)}</h2><div class="sub" style="color:var(--muted);margin-top:4px">${esc(c.email)}</div></div><button class="x">✕</button></div>
      <div class="sec"><h4>Данные пользователя</h4>${kv([['Имя', esc(c.first_name)], ['Фамилия', esc(c.last_name)], ['Email', esc(c.email)], ['Телефон', esc(c.phone)], ['Адрес', esc(c.address)],
        ['Регистрация', dt(c.created_at)], ['Заходил', c.last_seen ? ago(c.last_seen) : 'не было данных'], ['Действий', num(c.events_count)],
        ['Корзин отправлено', `${num(c.orders_count)} · ${money(c.orders_sum)}`], ['ID', `<span class="mono">${esc(c.id)}</span>`]])}</div>
      <div class="sec"><h4>Устройства (${d.devices.length})</h4>${d.devices.map(x => `<div class="sess" data-vid="${esc(x.vid)}" style="margin-bottom:8px"><div class="av">${DEV_ICON[x.device_type] || '🌐'}</div>
        <div><div class="sess-n">${esc(x.device_name || '—')} ${confTag(x)}</div><div class="sess-d">${esc(devLine(x))} · ${esc(x.ip)}</div></div><div class="sess-r"><span>${ago(x.last_seen)}</span><span>визитов: ${x.visits}</span></div></div>`).join('') || '<div class="sub" style="color:var(--muted)">Нет данных</div>'}</div>
      ${d.orders.length ? `<div class="sec"><h4>Отправленные корзины (${d.orders.length})</h4>${d.orders.map(o => `<div class="card" style="margin-bottom:10px;padding:12px"><div class="cart-h"><b>${esc(o.code)} · ${money(o.total)}</b><span class="sub" style="color:var(--muted)">${dt(o.created_at)}</span></div>${itemsHtml(o.items)}</div>`).join('')}</div>` : ''}
      <div class="sec"><h4>Что делал (последние ${d.events.length})</h4>${timeline(d.events)}</div>
      <div class="sec"><button class="btn danger" id="delCust">Удалить пользователя из базы</button></div>`);
    $('#delCust').onclick = async () => {
      if (!await confirmBox({ title: 'Удалить пользователя?', text: `Аккаунт <b>${esc(c.email)}</b> будет удалён безвозвратно. Его отправленные корзины останутся, но без привязки к аккаунту.`, ok: 'Удалить аккаунт', word: 'УДАЛИТЬ' })) return;
      await api('/customers/' + encodeURIComponent(cid), { method: 'DELETE' }); toast('Пользователь удалён'); closeDrawer(); if (current === 'customers') go('customers');
    };
  } catch (e) { openDrawer(`<div class="dr-h"><h2>Ошибка</h2><button class="x">✕</button></div><div class="empty">${esc(e.message)}</div>`); }
}

// ── запуск ───────────────────────────────────────────────────────────────────
async function boot() {
  if (!token) return showLogin('');
  try { await api('/overview'); } catch (e) { return showLogin(e.message === 'Сессия истекла' ? '' : e.message); }
  $('#login').hidden = true; $('#app').hidden = false;
  buildNav(); tickClock(); setInterval(tickClock, 30000);
  go((location.hash || '#live').slice(1));
}
window.addEventListener('hashchange', () => { const n = location.hash.slice(1); if (n && n !== current && !$('#app').hidden) go(n); });
boot();
})();
