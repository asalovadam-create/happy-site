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


// ── Session persistence ───────────────────────────────────────────────────────
const _SK = 'ht_sess_v1';
function saveSession() {
  try {
    State.user
      ? localStorage.setItem(_SK, JSON.stringify({ token: State.user.token, role: State.user.role, customer: State.user.customer || null }))
      : localStorage.removeItem(_SK);
  } catch(e) {}
}
async function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(_SK) || 'null');
    if (!s?.token) return;
    State.user = { token: s.token, role: s.role, customer: s.customer };
    if (s.role === 'admin') { State.adminToken = s.token; const b = $('bn-admin'); if (b) b.style.display = 'flex'; }
    updateAuthBtn();
    try {
      const me = await API.me();
      if (me.customer) { State.user.customer = me.customer; saveSession(); updateAuthBtn(); }
    } catch(e) { State.user = null; State.adminToken = null; localStorage.removeItem(_SK); updateAuthBtn(); }
  } catch(e) {}
}

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
  const btn = $('searchClearBtn');
  if (btn) btn.style.display = 'none';
  loadProducts();
}

// ── Confirm dialog ─────────────────────────────────────────────────────────────
function showConfirm(title, msg, onOk) {
  $('confirmTitle').textContent = title;
  $('confirmMsg').textContent = msg;
  $('confirmOkBtn').onclick = () => { closeConfirm(); onOk(); };
  $('confirmOverlay').classList.add('open');
}
function closeConfirm() {
  $('confirmOverlay').classList.remove('open');
}

function clearCartConfirm() {
  if (!Object.keys(State.cart).length) return;
  showConfirm('Очистить корзину?', 'Все добавленные товары будут удалены.', () => {
    State.cart = {};
    renderCart();
    updateCartBadge();
    toast('Корзина очищена');
  });
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
      <div class="home-hero-top">
        <svg class="home-hero-logo" viewBox="0 0 56 56" fill="none" xmlns="http://www.w3.org/2000/svg">
          <ellipse cx="28" cy="44" rx="22" ry="7" fill="rgba(255,255,255,0.7)"/>
          <ellipse cx="12" cy="42" rx="9" ry="5.5" fill="rgba(255,255,255,0.6)"/>
          <ellipse cx="44" cy="42" rx="9" ry="5.5" fill="rgba(255,255,255,0.6)"/>
          <rect x="14" y="26" width="28" height="20" rx="2" fill="rgba(255,255,255,0.9)"/>
          <rect x="22" y="34" width="12" height="12" rx="3" fill="#3B82F6"/>
          <rect x="14" y="20" width="5" height="7" rx="1" fill="rgba(255,255,255,0.85)"/>
          <rect x="21" y="20" width="4" height="7" rx="1" fill="rgba(255,255,255,0.85)"/>
          <rect x="31" y="20" width="4" height="7" rx="1" fill="rgba(255,255,255,0.85)"/>
          <rect x="37" y="20" width="5" height="7" rx="1" fill="rgba(255,255,255,0.85)"/>
          <rect x="21" y="15" width="14" height="15" rx="2" fill="rgba(255,255,255,0.95)"/>
          <polygon points="28,2 34,15 22,15" fill="#FFD54F"/>
          <polygon points="11,13 15,25 7,25" fill="rgba(255,255,255,0.8)"/>
          <polygon points="45,13 49,25 41,25" fill="rgba(255,255,255,0.8)"/>
          <rect x="25" y="19" width="6" height="7" rx="2" fill="#3B82F6"/>
          <rect x="8" y="42" width="40" height="3" rx="1.5" fill="rgba(255,255,255,0.5)"/>
        </svg>
        <div>
          <div class="wholesale-badge">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M20 7H4a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2z"/><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"/></svg>
            Только для оптовых покупателей
          </div>
          <h1>Happy Toys</h1>
        </div>
      </div>
      <p>Лучшие игрушки ведущих брендов для вашего магазина. Минимальный заказ — от 1 шт.</p>
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
        <div class="product-modal-sku">SKU: ${escHtml(p.sku)} · Возраст: ${p.age_min}+</div>
        <div class="product-modal-price">${rub(p.price)} <small>/ шт</small></div>
        <div class="product-modal-wholesale">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M20 7H4a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2z"/><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"/></svg>
          <div><strong>Оптовые условия:</strong> мин. заказ ${p.min_order} шт · цена за единицу · счёт по запросу</div>
        </div>
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
    saveSession(); closeAuth(); toast('Добро пожаловать!'); updateAuthBtn();
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
    saveSession(); closeAuth(); toast(`Добро пожаловать, ${first}!`); updateAuthBtn();
  } catch(e) {
    const msg = e.message.includes('already') ? 'Email уже зарегистрирован' : 'Ошибка регистрации';
    toast(msg, 'err');
  }
}

function doLogout() {
  State.user = null; State.adminToken = null; saveSession();
  $('bn-admin').style.display = 'none';
  updateAuthBtn();
  navigate('home');
  toast('Вы вышли из аккаунта');
}

function updateAuthBtn() {
  const btn = $('authBtn');
  if (!btn) return;
  if (State.user) {
    const c = State.user.customer;
    const lbl = State.user.role === 'admin'
      ? '⚡'
      : c ? (((c.first_name||'')[0]||'') + ((c.last_name||'')[0]||'')).toUpperCase() || '✓' : '✓';
    btn.style.cssText = 'background:var(--accent);border-radius:50%;color:#fff;font-size:12px;font-weight:900;font-family:Nunito,sans-serif;';
    btn.innerHTML = `<span style="color:#fff;font-size:12px;font-weight:900">${lbl}</span>`;
    btn.title = c ? (c.first_name + ' ' + c.last_name).trim() : 'Admin';
    btn.onclick = () => navigate(State.user.role === 'admin' ? 'admin' : 'profile');
  } else {
    btn.style.cssText = '';
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
    btn.title = '';
    btn.onclick = openAuth;
  }
}

// ── Profile page ──────────────────────────────────────────────────────────────
function renderProfile() {
  const mc = $('mainContent');
  if (!mc) return;

  if (!State.user) {
    mc.innerHTML = `
      <div class="empty-auth-page">
        <div class="empty-auth-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        </div>
        <h2>Войдите в аккаунт</h2>
        <p>Просматривайте историю заказов,<br>управляйте профилем и данными</p>
        <button class="btn-primary" onclick="openAuth()">Войти / Регистрация</button>
      </div>`;
    return;
  }

  // Admin видит профиль + ссылку на панель
  const isAdmin = State.user.role === 'admin';
  const c = State.user.customer;
  const orders = c?.orders || [];

  const avatarLetter = isAdmin ? '⚡' : (initials(c) || '?');
  const displayName  = isAdmin ? 'Администратор' : `${escHtml(c?.first_name||'')} ${escHtml(c?.last_name||'')}`.trim();
  const displayEmail = isAdmin ? 'admin' : escHtml(c?.email || '');

  const adminBanner = isAdmin ? `
    <div class="profile-admin-banner" onclick="navigate('admin')">
      <div class="pab-left">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        <div>
          <div class="pab-title">Панель администратора</div>
          <div class="pab-sub">Товары, клиенты, корзины</div>
        </div>
      </div>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
    </div>` : '';

  const contactCard = !isAdmin ? `
    <div class="profile-card">
      <h3>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        Контактные данные
      </h3>
      <div class="info-row"><span>Телефон</span><span>${escHtml(c?.phone||'—')}</span></div>
      <div class="info-row"><span>Email</span><span>${escHtml(c?.email||'—')}</span></div>
      <div class="info-row"><span>Адрес доставки</span><span>${escHtml(c?.address||'—')}</span></div>
      <div class="info-row"><span>Зарегистрирован</span><span>${c?.created_at?.slice(0,10)||'—'}</span></div>
    </div>` : '';

  const ordersCard = !isAdmin ? `
    <div class="profile-card">
      <h3>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>
        История заказов ${orders.length ? `<span class="orders-count-badge">${orders.length}</span>` : ''}
      </h3>
      ${orders.length
        ? orders.map(o => `
          <div class="order-row" onclick="window.open('/api/cart/${o.code}','_blank')">
            <div>
              <div class="order-code">#${o.code}</div>
              <div class="order-meta">${(o.date||'').slice(0,10)} · ${o.items_count} позиций</div>
            </div>
            <div class="order-right">
              <div class="order-total">${rub(o.total)}</div>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ccc" stroke-width="2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
            </div>
          </div>`).join('')
        : `<div class="orders-empty">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#ddd" stroke-width="1.5" stroke-linecap="round"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>
            <p>Заказов пока нет</p>
            <button class="btn-primary" onclick="navigate('catalog')" style="margin-top:12px;font-size:13px;padding:10px 20px">Перейти в каталог</button>
          </div>`
      }
    </div>` : '';

  mc.innerHTML = `
    <div class="profile-page">
      <div class="profile-hero">
        <div class="profile-avatar-lg ${isAdmin ? 'admin-avatar' : ''}">${avatarLetter}</div>
        <div class="profile-hero-info">
          <div class="profile-name">${displayName}</div>
          <div class="profile-email">${displayEmail}</div>
          ${isAdmin ? '<div class="profile-role-badge">Администратор</div>' : ''}
        </div>
      </div>

      ${adminBanner}
      ${contactCard}
      ${ordersCard}

      <button class="btn-logout" onclick="doLogout()">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        Выйти из аккаунта
      </button>
    </div>`;
}


// ── PDF ───────────────────────────────────────────────────────────────────────
function downloadCartPDF() {
  const items = Object.values(State.cart);
  if (!items.length) { toast('Корзина пуста', 'err'); return; }
  const c = State.user?.customer;
  const name    = c ? `${c.first_name||''} ${c.last_name||''}`.trim() : 'Гость';
  const phone   = c?.phone   || '—';
  const address = c?.address || '—';
  const comment = $('cartComment')?.value?.trim() || '';
  const date    = new Date().toLocaleDateString('ru-RU');
  let total = 0, qty2 = 0;
  const rows = items.map(({product:p, qty}) => {
    const sub = p.price * qty; total += sub; qty2 += qty;
    return `<tr>
      <td class="ti"><img src="${p.image}" onerror="this.style.display='none'"></td>
      <td class="tn"><div class="pn">${escHtml(p.name)}</div><div class="ps">SKU: ${escHtml(p.sku)}</div></td>
      <td class="tr2">${rub(p.price)}</td>
      <td class="tr2">${qty} шт</td>
      <td class="tr2 bold">${rub(sub)}</td>
    </tr>`;
  }).join('');
  const html = `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>Заказ — Happy Toys</title>
<link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;700;900&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Nunito',Arial,sans-serif;color:#1a1a2e;background:#fff;padding:36px}
.hdr{display:flex;align-items:center;gap:16px;padding-bottom:20px;border-bottom:3px solid #FF6B35;margin-bottom:28px}
.logo{width:52px;height:52px;background:#FF6B35;border-radius:14px;display:flex;align-items:center;justify-content:center;font-size:28px}
.lt{font-size:22px;font-weight:900;color:#FF6B35}.ls{font-size:12px;color:#aaa}
.dtitle{margin-left:auto;text-align:right}.dtitle h1{font-size:18px;font-weight:900}.dt{font-size:12px;color:#aaa}
.ig{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:24px}
.ib{background:#f8f9ff;border-radius:12px;padding:14px 18px}
.ibt{font-size:11px;text-transform:uppercase;letter-spacing:.7px;color:#FF6B35;font-weight:700;margin-bottom:10px}
.ibr{display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px}
.ibr span:first-child{color:#888}.ibr span:last-child{font-weight:700}
table{width:100%;border-collapse:collapse;margin-bottom:24px}
thead tr{background:#FF6B35;color:#fff}thead th{padding:11px 13px;font-size:12px;text-transform:uppercase;font-weight:700;text-align:left}
thead th.tr2{text-align:right}tbody tr{border-bottom:1px solid #f0f0f0}tbody tr:nth-child(even){background:#fafafa}tbody td{vertical-align:middle}
.ti{width:120px;padding:10px}.ti img{width:100px;height:100px;object-fit:contain;border-radius:10px;background:#f5f5f5;display:block}
.tn{padding:12px 13px}.pn{font-weight:700;font-size:14px;margin-bottom:3px}.ps{font-size:11px;color:#aaa}
.tr2{text-align:right;padding:12px 13px;font-size:13px;white-space:nowrap}
.bold{font-weight:900;color:#FF6B35;font-size:15px}
.totbox{display:flex;justify-content:flex-end;margin-bottom:20px}
.tot{background:linear-gradient(135deg,#FF6B35,#ff8c5a);color:#fff;border-radius:16px;padding:18px 28px;min-width:240px}
.tr3{display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px;opacity:.9}
.tr3.big{font-size:20px;font-weight:900;opacity:1;border-top:1px solid rgba(255,255,255,.3);padding-top:10px;margin-top:6px}
.cmt{background:#fffbf0;border:1px solid #ffe0b2;border-radius:12px;padding:14px 18px;font-size:13px;color:#555;margin-bottom:20px}
.ftr{text-align:center;font-size:11px;color:#ccc;padding-top:16px;border-top:1px solid #eee}
@media print{body{padding:16px}}
</style></head><body>
<div class="hdr">
  <div class="logo">🧸</div>
  <div><div class="lt">Happy Toys</div><div class="ls">Оптовый каталог</div></div>
  <div class="dtitle"><h1>Заказ</h1><div class="dt">${date}</div></div>
</div>
<div class="ig">
  <div class="ib">
    <div class="ibt">👤 Клиент</div>
    <div class="ibr"><span>Имя</span><span>${escHtml(name)}</span></div>
    <div class="ibr"><span>Телефон</span><span>${escHtml(phone)}</span></div>
    <div class="ibr"><span>Адрес</span><span>${escHtml(address)}</span></div>
  </div>
  <div class="ib">
    <div class="ibt">📦 Сводка</div>
    <div class="ibr"><span>Позиций</span><span>${items.length}</span></div>
    <div class="ibr"><span>Штук</span><span>${qty2}</span></div>
    <div class="ibr"><span>Дата</span><span>${date}</span></div>
  </div>
</div>
<table><thead><tr><th style="width:120px"></th><th>Товар</th><th class="tr2">Цена</th><th class="tr2">Кол-во</th><th class="tr2">Сумма</th></tr></thead>
<tbody>${rows}</tbody></table>
<div class="totbox"><div class="tot">
  <div class="tr3"><span>Позиций</span><span>${items.length}</span></div>
  <div class="tr3"><span>Штук</span><span>${qty2}</span></div>
  <div class="tr3 big"><span>Итого</span><span>${rub(total)}</span></div>
</div></div>
${comment ? `<div class="cmt">💬 <strong>Комментарий:</strong> ${escHtml(comment)}</div>` : ''}
<div class="ftr">Happy Toys · ${date}</div>
<script>window.onload=()=>window.print()<\/script>
</body></html>`;
  const w = window.open('', '_blank');
  if (!w) { toast('Разрешите всплывающие окна в браузере', 'err'); return; }
  w.document.write(html); w.document.close();
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
  if (!items.length) return;
  const c = State.user?.customer;
  const name    = c ? `${c.first_name||''} ${c.last_name||''}`.trim() : 'Гость';
  const phone   = c?.phone   || '';
  const address = c?.address || '';
  const comment = $('cartComment')?.value?.trim() || '';
  let msg = `🧸 *Заказ Happy Toys*\n━━━━━━━━━━━━━━━━━\n👤 *Клиент:* ${name}\n`;
  if (phone)   msg += `📞 *Тел:* ${phone}\n`;
  if (address) msg += `📍 *Адрес:* ${address}\n`;
  msg += `━━━━━━━━━━━━━━━━━\n`;
  let total = 0, qty2 = 0;
  items.forEach(({ product: p, qty }) => {
    const sub = p.price * qty; total += sub; qty2 += qty;
    msg += `• ${p.name}\n  SKU: ${p.sku} | ${qty} шт × ${rub(p.price)} = *${rub(sub)}*\n`;
  });
  msg += `━━━━━━━━━━━━━━━━━\n💰 *Итого: ${rub(total)}* (${qty2} шт)\n`;
  if (comment) msg += `💬 ${comment}\n`;
  const url = $('shareUrlSpan')?.textContent || '';
  if (url && !url.includes('Генерац') && !url.includes('Ошибка')) msg += `\n🔗 ${url}`;
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
  const btn = $('searchClearBtn');
  if (btn) btn.style.display = val.length > 0 ? 'flex' : 'none';
  const q = val.trim();
  if (!q) { $('searchDrop')?.classList.remove('open'); return; }
  _searchTimer = setTimeout(async () => {
    try {
      const data = await API.search(q);
      const drop = $('searchDrop');
      if (!data.items.length) { drop.classList.remove('open'); return; }
      if (!data.items.length) {
        drop.innerHTML = '<div class="search-drop-empty">Ничего не найдено по запросу «' + escHtml(q) + '»</div>';
        drop.classList.add('open');
        return;
      }
      drop.innerHTML = data.items.map(p => `
        <div class="search-result" onclick="closeSearch();openProduct(${p.id})">
          <img src="${escHtml(p.image)}" alt="${escHtml(p.name)}">
          <div style="flex:1;min-width:0">
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

function clearSearch() {
  const si = $('topSearch');
  const btn = $('searchClearBtn');
  if (si) si.value = '';
  if (btn) btn.style.display = 'none';
  closeSearch();
  if (State.page === 'home' || State.page === 'catalog') {
    State.search = '';
    State.pageNum = 1;
    loadProducts();
  }
}

// ── Navigation ────────────────────────────────────────────────────────────────
function navigate(page) {
  State.page = page;
  State.pageNum = 1;

  document.querySelectorAll('.bn-btn').forEach(b => b.classList.remove('active'));
  const btn = $(`bn-${page}`);
  if (btn) btn.classList.add('active');

  if (!$('mainContent')) return;
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
  if (e.target.id === 'confirmOverlay') closeConfirm();
  if (!e.target.closest('#topSearch') && !e.target.closest('#searchDrop')) closeSearch();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeProductModal(); closeShareModal(); closeAuth(); closeSearch(); closeConfirm(); }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('touchstart',()=>{},{passive:true});
document.addEventListener('touchmove',()=>{},{passive:true});
document.addEventListener('DOMContentLoaded', () => {
  // Make sure cart drawer is closed on load
  const drawer = $('cartDrawer');
  const backdrop = $('cartBackdrop');
  if (drawer) drawer.classList.remove('open');
  if (backdrop) backdrop.classList.remove('show');
  State.cartOpen = false;

  updateCartBadge();
  loadSession().then(() => navigate(State.user?.role === 'admin' ? 'admin' : 'home'));
});
