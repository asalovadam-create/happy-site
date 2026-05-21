/* ============================================================
   Happy Toys — app.js v2
   ============================================================ */
'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const State = {
  page:       'home',
  products:   [],
  total:      0,
  pageNum:    1,
  perPage:    40,
  category:   null,
  search:     '',
  stock:      null,
  sort:       'default',
  loading:    false,
  cart:       {},
  cartOpen:   false,
  user:       null,   // { role, token, customer? }
  adminToken: null,
};

// ── API ───────────────────────────────────────────────────────────────────────
const API = {
  base: '',

  async req(method, path, body, isForm = false) {
    const headers = {};
    if (!isForm) headers['Content-Type'] = 'application/json';
    const token = State.user?.token;
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const opts = { method, headers };
    if (body) opts.body = isForm ? body : JSON.stringify(body);

    const r = await fetch(this.base + path, opts);
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },

  get(path)         { return this.req('GET', path); },
  post(path, body)  { return this.req('POST', path, body); },

  products(params = {}) {
    const q = new URLSearchParams({ page: State.pageNum, per_page: State.perPage });
    if (params.category) q.set('category', params.category);
    if (params.search)   q.set('search',   params.search);
    if (params.stock)    q.set('stock',    params.stock);
    if (params.sort && params.sort !== 'default') q.set('sort', params.sort);
    return this.get(`/api/products?${q}`);
  },

  search(q)       { return this.get(`/api/products/search?q=${encodeURIComponent(q)}&limit=8`); },
  product(id)     { return this.get(`/api/products/${id}`); },
  categories()    { return this.get('/api/categories'); },
  shareCart(p)    { return this.post('/api/cart/share', p); },
  login(u, p)     { return this.post('/api/auth/login', { username: u, password: p }); },
  register(body)  { return this.post('/api/auth/register', body); },
  me()            { return this.get('/api/auth/me'); },
  adminStats()    { return this.get('/api/admin/stats'); },
  adminCarts()    { return this.get('/api/admin/carts'); },
  adminCustomers(){ return this.get('/api/admin/customers'); },

  async uploadImage(file) {
    const form = new FormData();
    form.append('file', file);
    return this.req('POST', '/api/upload-image', form, true);
  },
};

// ── DOM helpers ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function rub(n) { return '₽' + parseFloat(n).toFixed(2); }

function stockLabel(s) {
  return s === 'ok' ? 'В наличии' : s === 'low' ? 'Мало' : 'Нет';
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])
  );
}

function initials(c) {
  if (!c) return '?';
  return ((c.first_name||'')[0]||'') + ((c.last_name||'')[0]||'');
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, type = 'ok') {
  const wrap = $('toastWrap');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  wrap.appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 350); }, 3000);
}

// ── Cart ──────────────────────────────────────────────────────────────────────
function addToCart(id, qty = 1) {
  const p = State.products.find(x => x.id === id) || State._lastProduct;
  if (!p || p.stock === 'out') return;
  if (State.cart[id]) {
    State.cart[id].qty += qty;
  } else {
    State.cart[id] = { product: p, qty };
  }
  renderCart();
  toast(`${p.name.slice(0,30)} добавлен в корзину`);
  updateCartBadge();
}

function removeFromCart(id) {
  delete State.cart[id];
  renderCart();
  updateCartBadge();
}

function adjustQty(id, delta) {
  if (!State.cart[id]) return;
  State.cart[id].qty = Math.max(1, State.cart[id].qty + delta);
  renderCart();
}

function updateCartBadge() {
  const count = Object.values(State.cart).reduce((s, i) => s + i.qty, 0);
  const badge = $('cartBadge');
  if (badge) {
    badge.textContent = count;
    badge.style.display = count > 0 ? 'flex' : 'none';
  }
  const headCount = $('cartHeadCount');
  if (headCount) headCount.textContent = count;
}

function toggleCart() {
  State.cartOpen = !State.cartOpen;
  $('cartDrawer').classList.toggle('open', State.cartOpen);
  $('cartBackdrop').classList.toggle('show', State.cartOpen);
}

function renderCart() {
  const list = $('cartList');
  const foot = $('cartFoot');
  if (!list) return;

  const items = Object.values(State.cart);
  if (!items.length) {
    list.innerHTML = `<div class="cart-empty">
      <svg viewBox="0 0 64 64" fill="none"><path d="M8 16h48l-6 28H14L8 16z" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/><circle cx="22" cy="54" r="3" fill="currentColor"/><circle cx="42" cy="54" r="3" fill="currentColor"/><path d="M2 8h8l4 8" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>
      <p>Корзина пуста</p></div>`;
    if (foot) foot.style.display = 'none';
    return;
  }

  if (foot) foot.style.display = 'block';

  let html = '';
  let total = 0;
  let totalQty = 0;

  items.forEach(({ product: p, qty }) => {
    const sub = p.price * qty;
    total += sub;
    totalQty += qty;
    html += `
    <div class="cart-item">
      <img src="${escHtml(p.image)}" alt="${escHtml(p.name)}">
      <div class="cart-item-info">
        <div class="cart-item-name">${escHtml(p.name)}</div>
        <div class="cart-item-sku">SKU: ${escHtml(p.sku)}</div>
        <div class="qty-row" style="margin-top:6px">
          <button onclick="adjustQty(${p.id},-1)">−</button>
          <input type="number" value="${qty}" min="1"
            onchange="State.cart[${p.id}].qty=Math.max(1,parseInt(this.value)||1);renderCart();updateCartBadge()">
          <button onclick="adjustQty(${p.id},1)">+</button>
        </div>
        <div class="cart-item-price">${rub(sub)}</div>
      </div>
      <button class="cart-item-remove" onclick="removeFromCart(${p.id})">✕</button>
    </div>`;
  });

  list.innerHTML = html;

  const totalVal = $('cartTotalVal');
  const totalQtyEl = $('cartTotalQty');
  if (totalVal) totalVal.textContent = rub(total);
  if (totalQtyEl) totalQtyEl.textContent = `${totalQty} шт`;
}

// ── Product Card ──────────────────────────────────────────────────────────────
function renderProductCard(p) {
  const tagMap = { 'Новинка': 'new', 'Хит': 'hit', 'Акция': 'sale', 'Эксклюзив': 'excl' };
  const tagClass = { 'Новинка': 'tag-new', 'Хит': 'tag-hit', 'Акция': 'tag-sale', 'Эксклюзив': 'tag-excl' };

  const tags = (p.tags || []).map(t => `<span class="tag ${tagClass[t]||'tag-hit'}">${escHtml(t)}</span>`).join('');
  const disabled = p.stock === 'out' ? 'disabled' : '';
  const inCart = !!State.cart[p.id];

  return `
  <div class="product-card" onclick="openProduct(${p.id})">
    <div class="card-img-wrap">
      <img src="${escHtml(p.image)}" alt="${escHtml(p.name)}" loading="lazy" decoding="async">
      ${tags ? `<div class="card-tags">${tags}</div>` : ''}
      <span class="stock-badge stock-${p.stock}">${stockLabel(p.stock)}</span>
    </div>
    <div class="card-body">
      <div class="card-name">${escHtml(p.name)}</div>
      <div class="card-brand">${escHtml(p.brand)}</div>
    </div>
    <div class="card-price-row">
      <div class="card-price">${rub(p.price)}<small>/шт</small></div>
      <button class="card-add ${inCart ? 'in-cart' : ''}" ${disabled}
        onclick="event.stopPropagation();addToCart(${p.id})">
        ${inCart ? '✓' : '+'}
      </button>
    </div>
  </div>`;
}

function renderSkeletons(n = 8) {
  return Array(n).fill(0).map(() => `<div class="skeleton skel-card"></div>`).join('');
}

// ── Load products ─────────────────────────────────────────────────────────────
async function loadProducts() {
  if (State.loading) return;
  State.loading = true;
  const grid = $('productsGrid');
  if (grid) grid.innerHTML = renderSkeletons(8);

  try {
    const data = await API.products({
      category: State.category,
      search:   State.search,
      stock:    State.stock,
      sort:     State.sort,
    });
    State.products = data.items;
    State.total    = data.total;

    if (grid) {
      grid.innerHTML = State.products.length
        ? State.products.map(renderProductCard).join('')
        : `<div class="empty-state">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
             <h3>Ничего не найдено</h3><p>Попробуйте изменить фильтры</p></div>`;
    }

    const countEl = $('productCount');
    if (countEl) countEl.textContent = `${data.total} позиций`;

    renderPagination(data.page, data.pages);
  } catch (e) {
    console.error(e);
    if (grid) grid.innerHTML = `<div class="empty-state"><h3>Ошибка загрузки</h3></div>`;
  } finally {
    State.loading = false;
  }
}

function renderPagination(page, pages) {
  const el = $('pagination');
  if (!el || pages <= 1) { if (el) el.innerHTML = ''; return; }

  let html = '';
  for (let i = 1; i <= Math.min(pages, 10); i++) {
    html += `<button class="page-btn ${i === page ? 'active' : ''}" onclick="goPage(${i})">${i}</button>`;
  }
  el.innerHTML = html;
}

function goPage(n) {
  State.pageNum = n;
  loadProducts();
  $('mainContent').scrollIntoView({ behavior: 'smooth' });
}

// ── Filters ───────────────────────────────────────────────────────────────────
function setCategory(cat) {
  State.category = cat;
  State.pageNum  = 1;
  document.querySelectorAll('.cat-pill').forEach(b => b.classList.toggle('active', b.dataset.cat === (cat || '')));
  loadProducts();
}

function setStock(s) {
  State.stock = s;
  State.pageNum = 1;
  document.querySelectorAll('.filter-chip').forEach(b => b.classList.toggle('active', b.dataset.stock === (s || '')));
  loadProducts();
}

function setSort(v) {
  State.sort = v;
  State.pageNum = 1;
  loadProducts();
}

function clearFilters() {
  State.category = null;
  State.stock    = null;
  State.sort     = 'default';
  State.search   = '';
  State.pageNum  = 1;
  const si = $('topSearch');
  if (si) si.value = '';
  loadProducts();
}

// ── Home page ─────────────────────────────────────────────────────────────────
async function renderHome() {
  let cats = [];
  try { cats = await API.categories(); } catch(e){}

  const catPills = cats.map(c =>
    `<button class="cat-pill" data-cat="${escHtml(c.name)}" onclick="navigate('catalog');setCategory('${escHtml(c.name)}')">${escHtml(c.name)} <small>${c.count}</small></button>`
  ).join('');

  $('mainContent').innerHTML = `
    <div class="home-hero">
      <h1>Happy Toys<br>Оптовый каталог</h1>
      <p>Лучшие игрушки для вашего магазина</p>
      <div class="hero-stats">
        <div class="hero-stat"><strong>200+</strong><span>Товаров</span></div>
        <div class="hero-stat"><strong>10</strong><span>Брендов</span></div>
        <div class="hero-stat"><strong>8</strong><span>Категорий</span></div>
      </div>
    </div>

    <div class="cat-scroll">
      <button class="cat-pill active" data-cat="" onclick="navigate('catalog');setCategory(null)">Все товары</button>
      ${catPills}
    </div>

    <div class="section-title">
      Популярные товары
      <a onclick="navigate('catalog')">Все →</a>
    </div>

    <div class="filters-row">
      <button class="filter-chip active" data-stock="" onclick="setStock(null)">Все</button>
      <button class="filter-chip" data-stock="ok" onclick="setStock('ok')">В наличии</button>
      <button class="filter-chip" data-stock="low" onclick="setStock('low')">Заканчиваются</button>
      <select class="sort-chip" onchange="setSort(this.value)">
        <option value="default">Сортировка</option>
        <option value="price-asc">Цена ↑</option>
        <option value="price-desc">Цена ↓</option>
        <option value="name">По названию</option>
      </select>
    </div>

    <div class="results-info">
      <span id="productCount">Загрузка...</span>
      <span class="reset-link" onclick="clearFilters()">Сбросить</span>
    </div>

    <div class="products-grid" id="productsGrid">${renderSkeletons(8)}</div>
    <div id="pagination" class="pagination"></div>
  `;

  loadProducts();
}

// ── Catalog page ──────────────────────────────────────────────────────────────
async function renderCatalog() {
  let cats = [];
  try { cats = await API.categories(); } catch(e){}

  const catPills = [
    `<button class="cat-pill ${!State.category ? 'active' : ''}" data-cat="" onclick="setCategory(null)">Все</button>`,
    ...cats.map(c =>
      `<button class="cat-pill ${State.category===c.name ? 'active' : ''}" data-cat="${escHtml(c.name)}" onclick="setCategory('${escHtml(c.name)}')">${escHtml(c.name)}</button>`
    )
  ].join('');

  $('mainContent').innerHTML = `
    <div class="cat-scroll" style="padding-top:14px">${catPills}</div>

    <div class="filters-row">
      <button class="filter-chip active" data-stock="" onclick="setStock(null)">Все</button>
      <button class="filter-chip" data-stock="ok" onclick="setStock('ok')">В наличии</button>
      <button class="filter-chip" data-stock="low" onclick="setStock('low')">Мало</button>
      <select class="sort-chip" onchange="setSort(this.value)">
        <option value="default">Сортировка</option>
        <option value="price-asc">Цена ↑</option>
        <option value="price-desc">Цена ↓</option>
        <option value="name">А-Я</option>
      </select>
    </div>

    <div class="results-info">
      <span id="productCount">Загрузка...</span>
      <span class="reset-link" onclick="clearFilters()">Сбросить фильтры</span>
    </div>

    <div class="products-grid" id="productsGrid">${renderSkeletons(8)}</div>
    <div id="pagination" class="pagination"></div>
  `;

  loadProducts();
}

// ── Product modal ─────────────────────────────────────────────────────────────
async function openProduct(id) {
  const overlay = $('productOverlay');
  overlay.classList.add('open');
  $('modalInner').innerHTML = `<div style="padding:40px;text-align:center"><div class="skeleton" style="width:100%;aspect-ratio:1;border-radius:20px 20px 0 0;margin-bottom:16px"></div></div>`;

  try {
    const p = await API.product(id);
    State._lastProduct = p;

    const inCart = !!State.cart[id];
    const disabled = p.stock === 'out' ? 'disabled' : '';

    const similar = (p.similar || []).map(s => `
      <div class="similar-card" onclick="openProduct(${s.id})">
        <img src="${escHtml(s.image)}" alt="${escHtml(s.name)}">
        <div class="similar-card-info">
          <div class="similar-card-name">${escHtml(s.name)}</div>
          <div class="similar-card-price">${rub(s.price)}</div>
        </div>
      </div>`).join('');

    $('modalInner').innerHTML = `
      <img class="product-modal-img" src="${escHtml(p.image)}" alt="${escHtml(p.name)}">
      <div class="product-modal-body">
        <div class="product-modal-brand">${escHtml(p.brand)} · ${escHtml(p.category)}</div>
        <div class="product-modal-name">${escHtml(p.name)}</div>
        <div class="product-modal-sku">SKU: ${escHtml(p.sku)} · Мин. заказ: ${p.min_order} шт · Возраст: ${p.age_min}+</div>
        <div class="product-modal-price">${rub(p.price)} <small>/ шт</small></div>
        <div class="product-modal-desc">${escHtml(p.description)}</div>

        <div class="product-modal-add">
          <div class="qty-row">
            <button onclick="adjustModalQty(-1)">−</button>
            <input id="modalQty" type="number" value="1" min="1" max="999">
            <button onclick="adjustModalQty(1)">+</button>
          </div>
          <button class="btn-primary" style="flex:1" ${disabled}
            onclick="addToCart(${p.id}, parseInt($('modalQty').value)||1);closeProductModal()">
            ${inCart ? '✓ В корзине' : 'В корзину'}
          </button>
        </div>

        ${similar ? `<div class="similar-title">Похожие товары</div><div class="similar-scroll">${similar}</div>` : ''}
      </div>
    `;
  } catch(e) {
    $('modalInner').innerHTML = `<div style="padding:40px;text-align:center;color:#999">Ошибка загрузки</div>`;
  }
}

function adjustModalQty(d) {
  const el = $('modalQty');
  if (el) el.value = Math.max(1, (parseInt(el.value)||1) + d);
}

function closeProductModal() {
  $('productOverlay').classList.remove('open');
}

// ── Auth ──────────────────────────────────────────────────────────────────────
function openAuth()  { $('authOverlay').classList.add('open'); }
function closeAuth() { $('authOverlay').classList.remove('open'); }

function switchTab(tab) {
  $('formLogin').style.display    = tab === 'login'    ? 'block' : 'none';
  $('formRegister').style.display = tab === 'register' ? 'block' : 'none';
  $('tabLogin').classList.toggle('active',    tab === 'login');
  $('tabRegister').classList.toggle('active', tab === 'register');
}

async function doLogin() {
  const u = $('loginEmail')?.value.trim();
  const p = $('loginPass')?.value;
  if (!u || !p) return toast('Заполните все поля', 'err');
  try {
    const data = await API.login(u, p);
    State.user = { token: data.token, role: data.role, customer: data.customer };
    if (data.role === 'admin') State.adminToken = data.token;
    closeAuth();
    toast('Добро пожаловать!');
    updateAuthBtn();
    if (data.role === 'admin') $('bn-admin').style.display = 'flex';
  } catch(e) {
    toast('Неверные данные', 'err');
  }
}

async function doRegister() {
  const first = $('regFirst')?.value.trim();
  const last  = $('regLast')?.value.trim();
  const email = $('regEmail')?.value.trim();
  const phone = $('regPhone')?.value.trim();
  const addr  = $('regAddr')?.value.trim();
  const pass  = $('regPass')?.value;
  if (!first||!last||!email||!phone||!pass) return toast('Заполните все поля', 'err');
  if (pass.length < 6) return toast('Пароль минимум 6 символов', 'err');
  try {
    const data = await API.register({ first_name: first, last_name: last, email, phone, address: addr, password: pass });
    State.user = { token: data.token, role: 'customer', customer: data.customer };
    closeAuth();
    toast(`Добро пожаловать, ${first}!`);
    updateAuthBtn();
  } catch(e) {
    const msg = e.message.includes('already') ? 'Email уже зарегистрирован' : 'Ошибка регистрации';
    toast(msg, 'err');
  }
}

function doLogout() {
  State.user       = null;
  State.adminToken = null;
  $('bn-admin').style.display = 'none';
  updateAuthBtn();
  navigate('home');
  toast('Вы вышли из аккаунта');
}

function updateAuthBtn() {
  const btn = $('authBtn');
  if (!btn) return;
  if (State.user) {
    btn.style.background = 'var(--accent)';
    btn.querySelector('svg').style.color = '#fff';
  } else {
    btn.style.background = '';
    btn.querySelector('svg').style.color = '';
  }
}

// ── Profile page ──────────────────────────────────────────────────────────────
function renderProfile() {
  const mc = $('mainContent');

  if (!State.user) {
    mc.innerHTML = `
      <div style="padding:40px 20px;text-align:center">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#ccc" stroke-width="1.5" stroke-linecap="round" style="margin-bottom:16px"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        <h3 style="font-family:'Nunito',sans-serif;font-weight:900;margin-bottom:8px">Войдите в аккаунт</h3>
        <p style="color:#999;margin-bottom:20px;font-size:14px">Чтобы видеть историю заказов и управлять профилем</p>
        <button class="btn-primary" onclick="openAuth()" style="display:inline-flex">Войти / Регистрация</button>
      </div>`;
    return;
  }

  if (State.user.role === 'admin') {
    navigate('admin');
    return;
  }

  const c = State.user.customer;
  const orders = c?.orders || [];

  const ordersHtml = orders.length
    ? orders.map(o => `
        <div class="order-row">
          <div>
            <div class="order-code">#${o.code}</div>
            <div class="order-meta">${o.date?.slice(0,10)} · ${o.items_count} позиций</div>
          </div>
          <div class="order-total">${rub(o.total)}</div>
        </div>`).join('')
    : `<p style="color:#999;font-size:14px">Заказов пока нет</p>`;

  mc.innerHTML = `
    <div class="profile-page">
      <div class="profile-header">
        <div class="profile-avatar">${initials(c)}</div>
        <div>
          <div class="profile-name">${escHtml(c?.first_name||'')} ${escHtml(c?.last_name||'')}</div>
          <div class="profile-email">${escHtml(c?.email||'')}</div>
        </div>
      </div>

      <div class="profile-card">
        <h3>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          Контактные данные
        </h3>
        <div class="info-row"><span>Телефон</span><span>${escHtml(c?.phone||'—')}</span></div>
        <div class="info-row"><span>Email</span><span>${escHtml(c?.email||'—')}</span></div>
        <div class="info-row"><span>Адрес доставки</span><span>${escHtml(c?.address||'—')}</span></div>
        <div class="info-row"><span>Дата регистрации</span><span>${c?.created_at?.slice(0,10)||'—'}</span></div>
      </div>

      <div class="profile-card">
        <h3>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>
          История заказов (${orders.length})
        </h3>
        ${ordersHtml}
      </div>

      <button class="btn-danger" onclick="doLogout()">Выйти из аккаунта</button>
    </div>`;
}

// ── Share modal ───────────────────────────────────────────────────────────────
async function openShareModal() {
  const items = Object.values(State.cart);
  if (!items.length) { toast('Корзина пуста', 'err'); return; }

  $('shareOverlay').classList.add('open');

  const rows = items.map(({product:p, qty}) => `
    <div class="share-summary-row">
      <span>${escHtml(p.name.slice(0,35))} ×${qty}</span>
      <span>${rub(p.price * qty)}</span>
    </div>`).join('');

  const total = items.reduce((s,{product:p,qty}) => s + p.price*qty, 0);
  $('shareSummary').innerHTML = rows + `<div class="share-summary-row" style="font-weight:900;border-top:1px solid #eee;padding-top:8px;margin-top:4px"><span>Итого</span><span>${rub(total)}</span></div>`;
  $('shareUrlSpan').textContent = 'Генерация...';

  try {
    const payload = {
      items: items.map(({product:p,qty}) => ({ id:p.id, name:p.name, sku:p.sku, price:p.price, quantity:qty })),
      comment: $('cartComment')?.value || '',
      customer_id: State.user?.customer?.id || null,
    };
    const data = await API.shareCart(payload);
    $('shareUrlSpan').textContent = `${location.origin}/api/cart/${data.code}`;
  } catch(e) {
    $('shareUrlSpan').textContent = 'Ошибка генерации';
  }
}

function closeShareModal() { $('shareOverlay').classList.remove('open'); }

function copyShareLink() {
  const url = $('shareUrlSpan').textContent;
  navigator.clipboard.writeText(url)
    .then(() => toast('Ссылка скопирована!'))
    .catch(() => toast('Скопируйте вручную', 'info'));
}

function shareWhatsApp() {
  const items = Object.values(State.cart);
  let msg = 'Мой заказ Happy Toys:\n';
  let total = 0;
  items.forEach(({product:p,qty}) => {
    const sub = p.price * qty;
    total += sub;
    msg += `• ${p.name} (${p.sku}) ×${qty} = ${rub(sub)}\n`;
  });
  msg += `\nИтого: ${rub(total)}\n${$('shareUrlSpan').textContent}`;
  window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
}

// ── Admin page ────────────────────────────────────────────────────────────────
async function renderAdmin() {
  const mc = $('mainContent');

  if (!State.user || State.user.role !== 'admin') {
    mc.innerHTML = `
      <div style="padding:40px 20px;text-align:center">
        <p style="margin-bottom:16px;color:#999">Только для администратора</p>
        <button class="btn-primary" onclick="openAuth()" style="display:inline-flex">Войти</button>
      </div>`;
    return;
  }

  mc.innerHTML = `<div class="admin-page">
    <div class="admin-stats" id="adminStats">${[1,2,3,4,5].map(() => `<div class="stat-card skeleton" style="height:80px"></div>`).join('')}</div>
    <div id="adminBody"></div>
  </div>`;

  try {
    const [stats, carts, customers] = await Promise.all([API.adminStats(), API.adminCarts(), API.adminCustomers()]);
    $('adminStats').innerHTML = `
      <div class="stat-card"><div class="stat-label">Товаров</div><div class="stat-val">${stats.total_products}</div></div>
      <div class="stat-card"><div class="stat-label">Мало</div><div class="stat-val" style="color:var(--yellow)">${stats.low_stock}</div></div>
      <div class="stat-card"><div class="stat-label">Нет</div><div class="stat-val" style="color:var(--red)">${stats.out_of_stock}</div></div>
      <div class="stat-card"><div class="stat-label">Корзин</div><div class="stat-val">${stats.total_carts}</div></div>
      <div class="stat-card"><div class="stat-label">Клиентов</div><div class="stat-val">${stats.total_customers}</div></div>`;

    $('adminBody').innerHTML = renderAddProductForm() + renderCustomersTable(customers.customers || []) + renderAdminCarts(carts.carts || []);
  } catch(e) {
    $('adminBody').innerHTML = `<p style="color:#999">Ошибка загрузки</p>`;
  }
}

function renderAddProductForm() {
  const CATS = ['Куклы','Конструкторы','Машинки','Настольные игры','Мягкие игрушки','Развивающие','Пазлы','Творчество'];
  const BRANDS = ['LEGO','Barbie','Hot Wheels','Hasbro','Mattel','Playmobil','Fisher-Price','Ravensburger','Schleich','Funko'];
  return `
  <div class="admin-section">
    <h3>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      Добавить товар
    </h3>

    <div class="img-upload-area" id="imgUploadArea" onclick="$('imgFile').click()">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
      <p>Нажмите чтобы загрузить фото<br><small>или вставьте URL ниже</small></p>
      <input type="file" id="imgFile" accept="image/*" onchange="previewUpload(this)">
    </div>

    <div class="form-grid full">
      <div class="field"><label>URL изображения (если есть)</label><input id="fimg" type="url" placeholder="https://..."></div>
    </div>

    <div class="form-grid">
      <div class="field"><label>Название *</label><input id="fn" type="text" placeholder="Кукла Барби..."></div>
      <div class="field"><label>SKU *</label><input id="fsku" type="text" placeholder="HT-0201"></div>
    </div>
    <div class="form-grid">
      <div class="field"><label>Цена (₽) *</label><input id="fprice" type="number" step="0.01" placeholder="999.99"></div>
      <div class="field"><label>Остаток (шт)</label><input id="fqty" type="number" placeholder="100"></div>
    </div>
    <div class="form-grid">
      <div class="field"><label>Категория</label><select id="fcat">${CATS.map(c=>`<option>${c}</option>`).join('')}</select></div>
      <div class="field"><label>Бренд</label><select id="fbrand">${BRANDS.map(b=>`<option>${b}</option>`).join('')}</select></div>
    </div>
    <div class="form-grid full">
      <div class="field"><label>Описание</label><textarea id="fdesc" rows="2" placeholder="Описание товара..."></textarea></div>
    </div>
    <button class="btn-primary" onclick="submitProduct()">Добавить товар</button>
  </div>`;
}

async function previewUpload(input) {
  const file = input.files[0];
  if (!file) return;

  const area = $('imgUploadArea');
  area.innerHTML = `<div class="skeleton" style="width:100%;height:160px"></div>`;

  try {
    const data = await API.uploadImage(file);
    $('fimg').value = data.url;
    area.classList.add('has-img');
    area.innerHTML = `<img src="${data.url}" alt="preview">`;
  } catch(e) {
    // Fallback: use local FileReader
    const reader = new FileReader();
    reader.onload = ev => {
      $('fimg').value = ev.target.result;
      area.classList.add('has-img');
      area.innerHTML = `<img src="${ev.target.result}" alt="preview">`;
    };
    reader.readAsDataURL(file);
  }
}

async function submitProduct() {
  const body = {
    name:      $('fn')?.value?.trim(),
    sku:       $('fsku')?.value?.trim(),
    price:     parseFloat($('fprice')?.value || 0),
    stock_qty: parseInt($('fqty')?.value || 0),
    category:  $('fcat')?.value,
    brand:     $('fbrand')?.value,
    image:     $('fimg')?.value || '',
    description: $('fdesc')?.value || '',
    stock: 'ok', min_order: 1, age_min: 3,
  };
  if (!body.name || !body.sku || !body.price) { toast('Заполните обязательные поля', 'err'); return; }
  try {
    await API.post('/api/products', body);
    toast('Товар добавлен!');
    renderAdmin();
  } catch(e) {
    toast('Ошибка при добавлении', 'err');
  }
}

function renderCustomersTable(customers) {
  if (!customers.length) return `<div class="admin-section"><h3>Клиенты</h3><p style="color:#999;font-size:14px">Нет зарегистрированных клиентов</p></div>`;

  const rows = customers.map(c => `
    <tr>
      <td><div class="c-name">${escHtml(c.first_name)} ${escHtml(c.last_name)}</div><div class="c-email">${escHtml(c.email)}</div></td>
      <td>${escHtml(c.phone||'—')}</td>
      <td>${escHtml(c.address||'—')}</td>
      <td class="c-orders">${(c.orders||[]).length}</td>
      <td>${c.created_at?.slice(0,10)||'—'}</td>
    </tr>`).join('');

  return `
  <div class="admin-section">
    <h3>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
      Клиенты (${customers.length})
    </h3>
    <div style="overflow-x:auto">
      <table class="customers-table">
        <thead><tr><th>Имя</th><th>Телефон</th><th>Адрес</th><th>Заказов</th><th>Дата</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
}

function renderAdminCarts(carts) {
  if (!carts.length) return `<div class="admin-section"><h3>Корзины</h3><p style="color:#999;font-size:14px">Нет корзин</p></div>`;
  return `
  <div class="admin-section">
    <h3>Последние корзины (${carts.length})</h3>
    <div class="cart-rows">
      ${carts.map(c => `
        <div class="cart-row">
          <div class="cart-row-info">
            <div class="cart-row-name">${escHtml(c.store_name||'Клиент')} — ${c.items?.length||0} позиций</div>
            <div class="cart-row-meta">${c.code} · ${c.created_at?.slice(0,10)}</div>
          </div>
          <div class="cart-row-total">${rub(c.total)}</div>
        </div>`).join('')}
    </div>
  </div>`;
}

// ── Search ────────────────────────────────────────────────────────────────────
let _searchTimer;
function onSearch(val) {
  clearTimeout(_searchTimer);
  const q = val.trim();
  if (!q) { $('searchDrop')?.classList.remove('open'); return; }
  _searchTimer = setTimeout(async () => {
    try {
      const data = await API.search(q);
      const drop = $('searchDrop');
      if (!data.items.length) { drop.classList.remove('open'); return; }
      drop.innerHTML = data.items.map(p => `
        <div class="search-result" onclick="closeSearch();openProduct(${p.id})">
          <img src="${escHtml(p.image)}" alt="${escHtml(p.name)}">
          <div>
            <div class="search-result-name">${escHtml(p.name)}</div>
            <div class="search-result-meta">${escHtml(p.sku)} · ${escHtml(p.brand)}</div>
          </div>
          <span class="search-result-price">${rub(p.price)}</span>
        </div>`).join('');
      drop.classList.add('open');
    } catch(e){}
  }, 200);
}

function closeSearch() {
  $('searchDrop')?.classList.remove('open');
}

// ── Navigation ────────────────────────────────────────────────────────────────
function navigate(page) {
  State.page = page;
  State.pageNum = 1;

  document.querySelectorAll('.bn-btn').forEach(b => b.classList.remove('active'));
  const btn = $(`bn-${page}`);
  if (btn) btn.classList.add('active');

  if (page === 'home')    renderHome();
  if (page === 'catalog') renderCatalog();
  if (page === 'profile') renderProfile();
  if (page === 'admin')   renderAdmin();
}

// ── Events ────────────────────────────────────────────────────────────────────
document.addEventListener('click', e => {
  if (e.target.id === 'productOverlay') closeProductModal();
  if (e.target.id === 'shareOverlay')   closeShareModal();
  if (e.target.id === 'authOverlay')    closeAuth();
  if (!e.target.closest('#topSearch') && !e.target.closest('#searchDrop')) closeSearch();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeProductModal(); closeShareModal(); closeAuth(); closeSearch(); }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  renderCart();
  navigate('home');
});
