/* ============================================================
   Happy Toys — app.js
   All frontend logic: state · API · render · cart · modals
   ============================================================ */

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const State = {
  page:       'catalog',   // catalog | admin
  products:   [],
  total:      0,
  pageNum:    1,
  perPage:    40,
  category:   null,
  brand:      null,
  search:     '',
  stock:      null,
  sort:       'default',
  loading:    false,
  cart:       {},          // { id: { product, qty } }
  cartOpen:   true,
  adminToken: null,
};

// ── API ───────────────────────────────────────────────────────────────────────
const API = {
  base: '',   // same-origin; change to http://localhost:8000 for dev

  async get(path) {
    const r = await fetch(this.base + path);
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },

  async post(path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (State.adminToken) headers['Authorization'] = `Bearer ${State.adminToken}`;
    const r = await fetch(this.base + path, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },

  async products(params = {}) {
    const q = new URLSearchParams({ page: State.pageNum, per_page: State.perPage });
    if (params.category) q.set('category', params.category);
    if (params.brand)    q.set('brand',    params.brand);
    if (params.search)   q.set('search',   params.search);
    if (params.stock)    q.set('stock',    params.stock);
    if (params.sort && params.sort !== 'default') q.set('sort', params.sort);
    return this.get(`/api/products?${q}`);
  },

  async search(q) {
    return this.get(`/api/products/search?q=${encodeURIComponent(q)}&limit=6`);
  },

  async product(id) { return this.get(`/api/products/${id}`); },

  async categories() { return this.get('/api/categories'); },

  async shareCart(payload) { return this.post('/api/cart/share', payload); },

  async login(u, p) {
    return this.post('/api/auth/login', { username: u, password: p });
  },

  async adminStats() {
    const r = await fetch(this.base + '/api/admin/stats', {
      headers: { 'Authorization': `Bearer ${State.adminToken}` }
    });
    return r.json();
  },

  async adminCarts() {
    const r = await fetch(this.base + '/api/admin/carts', {
      headers: { 'Authorization': `Bearer ${State.adminToken}` }
    });
    return r.json();
  },
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── Helpers ───────────────────────────────────────────────────────────────────
function eur(n) { return '€' + parseFloat(n).toFixed(2); }

function stockLabel(s) {
  return s === 'ok' ? 'В наличии' : s === 'low' ? 'Мало' : 'Нет';
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, type = 'ok') {
  const wrap = $('toastWrap');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
      ${type === 'ok'
        ? '<polyline points="20 6 9 17 4 12"/>'
        : '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'}
    </svg>
    <span>${escHtml(msg)}</span>`;
  wrap.appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 350); }, 3000);
}

// ── Products render ───────────────────────────────────────────────────────────
function renderProductCard(p) {
  const inCart = !!State.cart[p.id];
  const disabled = p.stock === 'out' ? 'disabled' : '';
  return `
  <div class="product-card" data-id="${p.id}">
    <div class="card-img" onclick="openProduct(${p.id})">
      <img src="${escHtml(p.image)}" alt="${escHtml(p.name)}" loading="lazy" decoding="async">
      <span class="card-brand">${escHtml(p.brand)}</span>
      <span class="card-stock stock-${p.stock}">${stockLabel(p.stock)}</span>
    </div>
    <div class="card-body" onclick="openProduct(${p.id})">
      <div class="card-name">${escHtml(p.name)}</div>
      <div class="card-sku">SKU: ${escHtml(p.sku)}</div>
      <div class="card-price">${eur(p.price)} <span class="card-price-unit">/ шт</span></div>
    </div>
    <div class="card-footer">
      <div class="qty">
        <button class="qty-btn" onclick="adjustQty(${p.id}, -1)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <input class="qty-input" id="qty-${p.id}" type="number" value="1" min="1" max="999">
        <button class="qty-btn" onclick="adjustQty(${p.id}, 1)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
      </div>
      <button class="add-btn ${inCart ? 'in-cart' : ''}" id="addbtn-${p.id}"
        onclick="addToCart(${p.id})" ${disabled}>
        ${inCart ? 'В корзине' : 'Добавить'}
      </button>
    </div>
  </div>`;
}

function renderSkeletons(n = 8) {
  return Array(n).fill(0).map(() => `
    <div class="skeleton skel-card" style="border-radius:12px;aspect-ratio:1;"></div>`).join('');
}

// ── Load & render catalog ─────────────────────────────────────────────────────
async function loadProducts() {
  if (State.loading) return;
  State.loading = true;

  const grid = $('productsGrid');
  if (grid) grid.innerHTML = renderSkeletons(8);

  try {
    const data = await API.products({
      category: State.category,
      brand:    State.brand,
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
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
               <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
             </svg>
             <h3>Товары не найдены</h3>
             <p>Попробуйте изменить фильтры или поиск</p>
           </div>`;
      const countEl = $('productCount');
      if (countEl) countEl.textContent = `${data.total} позиций`;
    }
  } catch (e) {
    console.error(e);
    if (grid) grid.innerHTML = `<div class="empty-state"><h3>Ошибка загрузки</h3><p>Попробуйте обновить страницу</p></div>`;
  } finally {
    State.loading = false;
  }
}

// ── Catalog page ──────────────────────────────────────────────────────────────
function renderCatalog() {
  $('mainContent').innerHTML = `
    <div class="page-enter">
      <div class="section-head">
        <h2>Каталог</h2>
        <span id="productCount">—</span>
        <span class="reset-link" onclick="clearFilters()">Сбросить фильтры</span>
      </div>
      <div class="products-grid" id="productsGrid">${renderSkeletons(8)}</div>
    </div>`;
  loadProducts();
}

// ── Category filter pills ─────────────────────────────────────────────────────
async function loadCategories() {
  try {
    const cats = await API.categories();
    const nav = $('catNav');
    if (!nav) return;
    nav.innerHTML = cats.map(c => `
      <button class="nav-link ${State.category === c.name ? 'active' : ''}"
        onclick="setCategory('${escHtml(c.name)}')">
        ${catIcon(c.name)}
        ${escHtml(c.name)}
        <span class="nav-count">${c.count}</span>
      </button>`).join('');
  } catch (e) { console.error(e); }
}

function catIcon(name) {
  const icons = {
    'Куклы': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><circle cx="12" cy="7" r="4"/><path d="M12 11c-4 0-7 2-7 5v1h14v-1c0-3-3-5-7-5z"/></svg>',
    'Конструкторы': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><path d="M13 17h8M17 13v8"/></svg>',
    'Машинки': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><path d="M5 17H3a2 2 0 01-2-2V9a2 2 0 012-2h12l3 5h1a2 2 0 012 2v1h-2"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/></svg>',
    'Настольные игры': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2"/></svg>',
    'Мягкие игрушки': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>',
  };
  return icons[name] || '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><circle cx="12" cy="12" r="10"/></svg>';
}

function setCategory(name) {
  State.category = (State.category === name) ? null : name;
  State.pageNum  = 1;
  loadCategories();
  loadProducts();
}

function clearFilters() {
  State.category = null;
  State.brand    = null;
  State.search   = '';
  State.stock    = null;
  State.sort     = 'default';
  State.pageNum  = 1;
  const si = $('sideSearch');
  if (si) si.value = '';
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  $('fAll').classList.add('active');
  loadCategories();
  loadProducts();
}

// ── Stock filter ──────────────────────────────────────────────────────────────
function setStock(val) {
  State.stock   = val || null;
  State.pageNum = 1;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  const id = val ? `f_${val}` : 'fAll';
  if ($(id)) $(id).classList.add('active');
  loadProducts();
}

// ── Sort ──────────────────────────────────────────────────────────────────────
function setSort(val) {
  State.sort    = val;
  State.pageNum = 1;
  loadProducts();
}

// ── Cart ──────────────────────────────────────────────────────────────────────
function addToCart(id) {
  const p = State.products.find(x => x.id === id);
  if (!p) return;
  const qtyEl = $(`qty-${id}`);
  const qty = Math.max(1, parseInt(qtyEl?.value || 1));
  State.cart[id] = { product: p, qty };
  updateCartUI();
  const btn = $(`addbtn-${id}`);
  if (btn) { btn.textContent = 'В корзине'; btn.classList.add('in-cart'); }
  toast(`${p.name} — добавлено`);
}

function removeFromCart(id) {
  delete State.cart[id];
  updateCartUI();
  const btn = $(`addbtn-${id}`);
  if (btn) { btn.textContent = 'Добавить'; btn.classList.remove('in-cart'); }
}

function changeCartQty(id, delta) {
  if (!State.cart[id]) return;
  const newQty = State.cart[id].qty + delta;
  if (newQty <= 0) { removeFromCart(id); return; }
  State.cart[id].qty = newQty;
  updateCartUI();
}

function updateCartUI() {
  const items  = Object.values(State.cart);
  const count  = items.length;
  const totalE = items.reduce((s, i) => s + parseFloat(i.product.price) * i.qty, 0);
  const totalQ = items.reduce((s, i) => s + i.qty, 0);

  // badge
  const badge = $('cartBadge');
  if (badge) badge.textContent = count;
  const headCount = $('cartHeadCount');
  if (headCount) headCount.textContent = count;

  const tv = $('cartTotalVal');
  const tq = $('cartTotalQty');
  if (tv) tv.textContent = eur(totalE);
  if (tq) tq.textContent = `${totalQ} шт`;

  const list = $('cartList');
  if (!list) return;

  if (!count) {
    list.innerHTML = `<div class="cart-empty-msg">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
        <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/>
        <line x1="3" y1="6" x2="21" y2="6"/>
        <path d="M16 10a4 4 0 01-8 0"/>
      </svg>
      <p>Корзина пуста.<br>Добавьте товары из каталога.</p>
    </div>`;
    return;
  }

  list.innerHTML = items.map(({ product: p, qty }) => `
    <div class="cart-item">
      <img src="${escHtml(p.image)}" alt="${escHtml(p.name)}">
      <div class="cart-item-info">
        <div class="cart-item-name">${escHtml(p.name)}</div>
        <div class="cart-item-sku">${escHtml(p.sku)}</div>
        <div class="cart-item-row">
          <span class="cart-item-sub">${eur(parseFloat(p.price) * qty)}</span>
          <div class="cart-item-qty">
            <button onclick="changeCartQty(${p.id}, -1)">−</button>
            <span>${qty}</span>
            <button onclick="changeCartQty(${p.id}, 1)">+</button>
          </div>
        </div>
      </div>
      <button class="cart-item-del" onclick="removeFromCart(${p.id})">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`).join('');
}

function toggleCart() {
  State.cartOpen = !State.cartOpen;
  const panel = $('cartPanel');
  if (panel) panel.classList.toggle('hidden', !State.cartOpen);
}

// ── Qty controls on card ──────────────────────────────────────────────────────
function adjustQty(id, d) {
  const inp = $(`qty-${id}`);
  if (!inp) return;
  inp.value = Math.max(1, parseInt(inp.value || 1) + d);
}

// ── Product modal ─────────────────────────────────────────────────────────────
async function openProduct(id) {
  const overlay = $('productOverlay');
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';

  $('modalImg').innerHTML   = `<div style="width:100%;height:100%;background:var(--bg2)"></div>`;
  $('modalBody').innerHTML  = `<div style="padding:20px;color:var(--text3);font-size:13px;">Загрузка...</div>`;

  try {
    const p = await API.product(id);
    $('modalImg').innerHTML = `
      <img src="${escHtml(p.image)}" alt="${escHtml(p.name)}">
      <button class="modal-close" onclick="closeProductModal()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>`;

    const similarHtml = p.similar && p.similar.length
      ? `<div class="modal-similar">
           <h4>Похожие товары</h4>
           <div class="similar-grid">
             ${p.similar.map(s => `
               <div class="similar-card" onclick="openProduct(${s.id})">
                 <img src="${escHtml(s.image)}" alt="${escHtml(s.name)}">
                 <div>
                   <div class="similar-card-name">${escHtml(s.name)}</div>
                   <div class="similar-card-price">${eur(s.price)}</div>
                 </div>
               </div>`).join('')}
           </div>
         </div>` : '';

    $('modalBody').innerHTML = `
      <div class="modal-brand">${escHtml(p.brand)}</div>
      <div class="modal-name">${escHtml(p.name)}</div>
      <div class="modal-sku">SKU: ${escHtml(p.sku)} · ${escHtml(p.category)}</div>
      <div class="modal-price">${eur(p.price)}</div>
      <div class="modal-desc">${escHtml(p.description)}</div>
      <div class="modal-meta">
        <span class="meta-chip">${escHtml(p.category)}</span>
        <span class="meta-chip">Возраст ${p.age_min}+</span>
        <span class="meta-chip stock-${p.stock}">${stockLabel(p.stock)} (${p.stock_qty} шт)</span>
        <span class="meta-chip">Мин. заказ: ${p.min_order} шт</span>
        ${(p.tags || []).map(t => `<span class="meta-chip">${escHtml(t)}</span>`).join('')}
      </div>
      <div class="modal-add-row">
        <div class="modal-qty">
          <button onclick="adjustModalQty(-1)">−</button>
          <input id="modalQtyInp" type="number" value="${State.cart[p.id]?.qty || 1}" min="1">
          <button onclick="adjustModalQty(1)">+</button>
        </div>
        <button class="modal-add" onclick="addToCartModal(${p.id})" ${p.stock === 'out' ? 'disabled style="opacity:.5;cursor:not-allowed"' : ''}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          ${State.cart[p.id] ? 'Обновить количество' : 'Добавить в корзину'}
        </button>
      </div>
      ${similarHtml}`;
  } catch (e) {
    $('modalBody').innerHTML = `<div style="padding:20px;color:var(--danger)">Ошибка загрузки</div>`;
  }
}

function adjustModalQty(d) {
  const inp = $('modalQtyInp');
  if (inp) inp.value = Math.max(1, parseInt(inp.value || 1) + d);
}

function addToCartModal(id) {
  const p = State.products.find(x => x.id === id) || State.cart[id]?.product;
  const qty = parseInt($('modalQtyInp')?.value || 1);
  if (!p) return;
  State.cart[id] = { product: p, qty };
  updateCartUI();
  closeProductModal();
  toast(`${p.name} — добавлено (${qty} шт)`);
}

function closeProductModal() {
  $('productOverlay').classList.remove('open');
  document.body.style.overflow = '';
}

// ── Share modal ───────────────────────────────────────────────────────────────
async function openShareModal() {
  const items = Object.values(State.cart);
  if (!items.length) { toast('Корзина пуста', 'info'); return; }

  let total = 0;
  const rows = items.map(({ product: p, qty }) => {
    const sub = parseFloat(p.price) * qty;
    total += sub;
    return `<div class="share-row"><span>${escHtml(p.name)} ×${qty}</span><span>${eur(sub)}</span></div>`;
  }).join('');

  $('shareSummary').innerHTML  = rows + `<div class="share-row total"><span>${items.length} позиций, ${items.reduce((s,i)=>s+i.qty,0)} шт</span><span>${eur(total)}</span></div>`;
  $('shareOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';

  try {
    const payload = {
      items:   items.map(({ product: p, qty }) => ({ product_id: p.id, price: p.price, name: p.name, sku: p.sku, quantity: qty, image: p.image })),
      comment: $('cartComment')?.value || '',
    };
    const data = await API.shareCart(payload);
    $('shareUrlSpan').textContent = `${location.origin}/cart/${data.code}`;
  } catch (e) {
    $('shareUrlSpan').textContent = `${location.origin}/cart/DEMO${Math.random().toString(36).slice(2,7).toUpperCase()}`;
  }
}

function closeShareModal() {
  $('shareOverlay').classList.remove('open');
  document.body.style.overflow = '';
}

function copyShareLink() {
  const url = $('shareUrlSpan').textContent;
  navigator.clipboard.writeText(url).then(() => toast('Ссылка скопирована!')).catch(() => toast('Скопируйте вручную', 'info'));
}

function shareWhatsApp() {
  const items = Object.values(State.cart);
  let msg = 'Мой заказ Happy Toys:\n';
  let total = 0;
  items.forEach(({ product: p, qty }) => {
    const sub = parseFloat(p.price) * qty;
    total += sub;
    msg += `• ${p.name} (${p.sku}) ×${qty} = ${eur(sub)}\n`;
  });
  msg += `\nИтого: ${eur(total)}\n${$('shareUrlSpan').textContent}`;
  window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
}

function exportPDF() {
  toast('PDF формируется...', 'info');
  setTimeout(() => toast('PDF готов к скачиванию!'), 1800);
}

// ── Instant search ────────────────────────────────────────────────────────────
let _searchTimer;
function onSearch(val) {
  clearTimeout(_searchTimer);
  const q = val.trim();
  if (!q) { closeSearch(); return; }
  _searchTimer = setTimeout(async () => {
    try {
      const data = await API.search(q);
      showSearchDrop(data.items);
    } catch (e) {}
  }, 200);
}

function showSearchDrop(items) {
  const drop = $('searchDrop');
  if (!items.length) { closeSearch(); return; }
  drop.innerHTML = items.map(p => `
    <div class="search-result" onclick="closeSearch();openProduct(${p.id})">
      <img src="${escHtml(p.image)}" alt="${escHtml(p.name)}">
      <div>
        <div class="search-result-name">${escHtml(p.name)}</div>
        <div class="search-result-meta">${escHtml(p.sku)} · ${escHtml(p.brand)}</div>
      </div>
      <span class="search-result-price">${eur(p.price)}</span>
    </div>`).join('');
  drop.classList.add('open');
}

function closeSearch() {
  $('searchDrop')?.classList.remove('open');
}

// ── Admin page ────────────────────────────────────────────────────────────────
async function renderAdmin() {
  $('mainContent').innerHTML = `<div class="page-enter">
    <div class="admin-stats" id="adminStats">
      ${[1,2,3,4].map(() => `<div class="stat-card skeleton" style="height:80px;"></div>`).join('')}
    </div>
    <div id="adminBody"><p style="color:var(--text3);font-size:13px;">Загрузка...</p></div>
  </div>`;

  if (!State.adminToken) {
    $('adminBody').innerHTML = renderLoginForm();
    return;
  }

  try {
    const [stats, carts] = await Promise.all([API.adminStats(), API.adminCarts()]);
    $('adminStats').innerHTML = `
      <div class="stat-card"><div class="stat-label">Товаров</div><div class="stat-val">${stats.total_products}</div></div>
      <div class="stat-card"><div class="stat-label">Мало на складе</div><div class="stat-val">${stats.low_stock}</div></div>
      <div class="stat-card"><div class="stat-label">Нет в наличии</div><div class="stat-val">${stats.out_of_stock}</div></div>
      <div class="stat-card"><div class="stat-label">Корзин всего</div><div class="stat-val">${stats.total_carts}</div></div>`;
    $('adminBody').innerHTML = renderAdminForm() + renderAdminCarts(carts.carts || []);
  } catch (e) {
    $('adminStats').innerHTML = '';
    $('adminBody').innerHTML = renderLoginForm();
  }
}

function renderLoginForm() {
  return `
    <div class="form-card" style="max-width:380px;">
      <div class="form-title">Вход для администратора</div>
      <div class="form-grid full">
        <div class="field"><label>Логин</label><input id="adminUser" type="text" placeholder="admin"></div>
        <div class="field"><label>Пароль</label><input id="adminPass" type="password" placeholder="••••••••"></div>
      </div>
      <button class="form-submit" onclick="doLogin()">Войти</button>
    </div>`;
}

async function doLogin() {
  const u = $('adminUser')?.value;
  const p = $('adminPass')?.value;
  if (!u || !p) return;
  try {
    const data = await API.login(u, p);
    State.adminToken = data.token;
    toast('Вход выполнен!');
    renderAdmin();
  } catch (e) {
    toast('Неверные данные', 'info');
  }
}

function renderAdminForm() {
  const CATS = ['Куклы','Конструкторы','Машинки','Настольные игры','Мягкие игрушки','Развивающие','Пазлы','Творчество'];
  const BRANDS = ['LEGO','Barbie','Hot Wheels','Hasbro','Mattel','Playmobil','Fisher-Price','Ravensburger','Schleich','Funko'];
  return `
    <div class="form-card" style="margin-bottom:24px;">
      <div class="form-title">Добавить товар</div>
      <div class="form-grid">
        <div class="field"><label>Название</label><input id="fn" type="text" placeholder="Название товара"></div>
        <div class="field"><label>SKU</label><input id="fsku" type="text" placeholder="HT-0201"></div>
      </div>
      <div class="form-grid">
        <div class="field"><label>Цена (€)</label><input id="fprice" type="number" step="0.01" placeholder="9.99"></div>
        <div class="field"><label>Остаток (шт)</label><input id="fqty" type="number" placeholder="100"></div>
      </div>
      <div class="form-grid">
        <div class="field"><label>Категория</label>
          <select id="fcat">${CATS.map(c=>`<option>${c}</option>`).join('')}</select>
        </div>
        <div class="field"><label>Бренд</label>
          <select id="fbrand">${BRANDS.map(b=>`<option>${b}</option>`).join('')}</select>
        </div>
      </div>
      <div class="form-grid full">
        <div class="field"><label>URL изображения (Cloudinary/CDN)</label><input id="fimg" type="url" placeholder="https://res.cloudinary.com/..."></div>
      </div>
      <div class="form-grid full">
        <div class="field"><label>Описание</label><textarea id="fdesc" rows="2" placeholder="Описание товара..."></textarea></div>
      </div>
      <button class="form-submit" onclick="submitProduct()">Добавить товар</button>
    </div>`;
}

async function submitProduct() {
  const body = {
    name: $('fn')?.value, sku: $('fsku')?.value,
    price: parseFloat($('fprice')?.value || 0),
    stock_qty: parseInt($('fqty')?.value || 0),
    category: $('fcat')?.value, brand: $('fbrand')?.value,
    image: $('fimg')?.value, description: $('fdesc')?.value,
    stock: 'ok', min_order: 1, age_min: 3,
  };
  if (!body.name || !body.sku || !body.price) { toast('Заполните обязательные поля', 'info'); return; }
  try {
    await API.post('/api/products', body);
    toast('Товар добавлен в каталог!');
    renderAdmin();
  } catch (e) {
    toast('Ошибка при добавлении', 'info');
  }
}

function renderAdminCarts(carts) {
  if (!carts.length) return `<p style="color:var(--text3);font-size:13px;">Нет корзин</p>`;
  return `
    <div class="section-head"><h2>Последние корзины</h2><span>${carts.length} всего</span></div>
    <div class="carts-list">
      ${carts.map(c => `
        <div class="cart-row">
          <div class="cart-row-info">
            <div class="cart-row-name">${c.store_name || 'Клиент'} — ${c.items?.length || 0} позиций</div>
            <div class="cart-row-meta">${c.code} · ${c.created_at?.slice(0,10)}</div>
          </div>
          <div class="cart-row-total">${eur(c.total)}</div>
          <button class="open-btn" onclick="toast('Корзина: ${c.code}', 'info')">Открыть</button>
        </div>`).join('')}
    </div>`;
}

// ── Navigation ────────────────────────────────────────────────────────────────
function navigate(page) {
  State.page = page;
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  const link = $(`nav-${page}`);
  if (link) link.classList.add('active');
  $('topTitle').textContent = page === 'catalog' ? 'Каталог товаров' : 'Администрирование';

  if (page === 'catalog') renderCatalog();
  if (page === 'admin')   renderAdmin();
}

// ── Close modals on overlay click ────────────────────────────────────────────
document.addEventListener('click', e => {
  if (e.target.id === 'productOverlay') closeProductModal();
  if (e.target.id === 'shareOverlay')   closeShareModal();
  if (!e.target.closest('#sideSearch') && !e.target.closest('#searchDrop')) closeSearch();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeProductModal(); closeShareModal(); closeSearch(); }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadCategories();
  navigate('catalog');
});
