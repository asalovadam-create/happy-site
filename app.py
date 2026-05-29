"""
Happy Toys — Wholesale Catalog
FastAPI backend · JWT auth · user registration · image upload · in-memory DB
Two-level catalog: Category → Subcategory → Products
"""

from fastapi import FastAPI, HTTPException, Depends, Request, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime, timedelta
import jwt, hashlib, random, string, time, os, base64, uuid

app = FastAPI(title="Happy Toys API", version="3.0.0", docs_url="/api/docs")
app.add_middleware(GZipMiddleware, minimum_size=500)

from starlette.middleware.base import BaseHTTPMiddleware
class CacheHeaders(BaseHTTPMiddleware):
    async def dispatch(self, req, call_next):
        resp = await call_next(req)
        p = req.url.path
        if p.startswith('/static/') and (p.endswith('.js') or p.endswith('.css')):
            resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
            resp.headers['Pragma'] = 'no-cache'
            resp.headers['Expires'] = '0'
        elif p.startswith('/static/'):
            resp.headers['Cache-Control'] = 'public, max-age=86400'
        elif p.startswith('/api/'):
            resp.headers['Cache-Control'] = 'no-cache, must-revalidate'
        return resp
app.add_middleware(CacheHeaders)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

JWT_SECRET = os.getenv("JWT_SECRET", "happytoys-secret-2025")
ADMIN_USER = os.getenv("ADMIN_USER", "admin")
ADMIN_PASS = os.getenv("ADMIN_PASS", "admin123")
security   = HTTPBearer(auto_error=False)

# ── Two-level catalog structure ───────────────────────────────────────────────
# Format: { category_name: { subcategory_name: [] } }
_catalog: dict = {
    "Машинки": {
        "Легковые автомобили": [],
        "Грузовики и спецтехника": [],
        "Гоночные машины": [],
        "Радиоуправляемые": [],
        "Треки и наборы": [],
    },
    "Куклы": {
        "Модные куклы": [],
        "Пупсы и малыши": [],
        "Принцессы": [],
        "Аксессуары для кукол": [],
    },
    "Конструкторы": {
        "Классические конструкторы": [],
        "LEGO серии": [],
        "Магнитные конструкторы": [],
        "Деревянные конструкторы": [],
        "Мягкие конструкторы": [],
    },
    "Мягкие игрушки": {
        "Медведи и мишки": [],
        "Единороги": [],
        "Животные": [],
        "Персонажи мультфильмов": [],
        "Подушки-игрушки": [],
    },
    "Настольные игры": {
        "Классические игры": [],
        "Стратегии": [],
        "Карточные игры": [],
        "Игры для детей": [],
    },
    "Развивающие": {
        "Сортеры и пазлы": [],
        "Обучающие наборы": [],
        "Музыкальные игрушки": [],
        "Для малышей 0-3 года": [],
    },
    "Пазлы": {
        "Детские пазлы": [],
        "Пазлы 100-500 деталей": [],
        "Пазлы 500-1000 деталей": [],
        "3D пазлы": [],
    },
    "Творчество": {
        "Наборы для рисования": [],
        "Лепка и пластилин": [],
        "Бисер и украшения": [],
        "Наборы для шитья": [],
        "Слаймы": [],
    },
    "Канцелярия": {
        "Ручки и карандаши": [],
        "Тетради и блокноты": [],
        "Пеналы и сумки": [],
        "Фломастеры и маркеры": [],
        "Точилки и ластики": [],
    },
    "Спорт и активность": {
        "Мячи": [],
        "Велосипеды и самокаты": [],
        "Скакалки и обручи": [],
        "Батуты": [],
    },
    "Для малышей": {
        "Погремушки": [],
        "Прорезыватели": [],
        "Мобили и ночники": [],
        "Развивающие коврики": [],
    },
}

CATEGORIES = list(_catalog.keys())
BRANDS     = ["LEGO","Barbie","Hot Wheels","Hasbro","Mattel","Playmobil","Fisher-Price","Ravensburger","Schleich","Funko"]
NAMES = [
    "Кукла Барби Модница Делюкс","Конструктор City 500 дет.","Машинка Турбо X",
    "Монополия Classic","Мишка плюшевый 45см","Пазл Природа 1000 эл.",
    "Кукла LOL Surprise","LEGO Technic Суперкар","Hot Wheels трек Петля",
    "Playmobil Ферма","Набор для рисования Pro","Глобус интерактивный 3D",
    "Конструктор Duplo Старт","Monster High Frankie","Машина-трансформер XL",
    "Клуэдо Classic","Единорог плюшевый 60см","RC Вертолёт Cobra 2.4G",
    "Barbie Дом Мечты","LEGO Star Wars Set","Schleich Лошадь Арабская",
    "Ravensburger 3D Замок","Fisher-Price Ксилофон","Funko POP Batman",
    "Spin Master Hatchimals","Набор юного химика","Конструктор Magnetic",
    "Кукла Enchantimals","Трек Hot Wheels City","Пазл Space 500 эл.",
]
IMGS = [
    "https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=600&h=600&fit=crop&q=80",
    "https://images.unsplash.com/photo-1596461404969-9ae70f2830c1?w=600&h=600&fit=crop&q=80",
    "https://images.unsplash.com/photo-1515488042361-ee00e0ddd4e4?w=600&h=600&fit=crop&q=80",
    "https://images.unsplash.com/photo-1605457212628-cde2d61dab33?w=600&h=600&fit=crop&q=80",
    "https://images.unsplash.com/photo-1591988700625-3e71ae4a0e5d?w=600&h=600&fit=crop&q=80",
    "https://images.unsplash.com/photo-1587654780291-39c9404d746b?w=600&h=600&fit=crop&q=80",
    "https://images.unsplash.com/photo-1618842676088-c4d48a6a7571?w=600&h=600&fit=crop&q=80",
    "https://images.unsplash.com/photo-1567365672-15b7f0b9ce6e?w=600&h=600&fit=crop&q=80",
    "https://images.unsplash.com/photo-1611532736597-de2d4265fba3?w=600&h=600&fit=crop&q=80",
    "https://images.unsplash.com/photo-1553481187-be93c21490a9?w=600&h=600&fit=crop&q=80",
]
DESC = "Высококачественная игрушка. Соответствует стандартам CE и EN71. Безопасные материалы, яркие цвета. Идеально для оптовых закупок."

def _seed():
    db = {}
    all_subs = [(cat, sub) for cat, subs in _catalog.items() for sub in subs.keys()]
    for i in range(1, 201):
        sv = random.random()
        stock = "ok" if sv > 0.6 else ("low" if sv > 0.25 else "out")
        cat, sub = all_subs[(i-1) % len(all_subs)]
        db[i] = {
            "id": i, "is_active": True,
            "name": NAMES[(i-1) % len(NAMES)] + (f" #{i}" if i > len(NAMES) else ""),
            "sku": f"{10000 + i}",
            "price": round(random.uniform(3.5, 149.99), 2),
            "brand": BRANDS[(i-1) % len(BRANDS)],
            "category": cat,
            "subcategory": sub,
            "image": IMGS[(i-1) % len(IMGS)],
            "stock": stock,
            "stock_qty": random.randint(1, 500) if stock != "out" else 0,
            "description": DESC,
            "min_order": random.choice([1, 2, 6, 12]),
            "age_min": random.choice([1, 3, 5, 6, 8]),
            "tags": random.sample(["Новинка","Хит","Акция","Эксклюзив"], k=random.randint(0,2)),
        }
    return db

_products = _seed()
_carts    = {}
_users_admin = {ADMIN_USER: hashlib.sha256(ADMIN_PASS.encode()).hexdigest()}
_customers   = {}
_cache: dict = {}
_cache_exp: dict = {}

def c_get(k):
    return _cache[k] if k in _cache and time.time() < _cache_exp.get(k, 0) else None
def c_set(k, v, ttl=30):
    _cache[k] = v; _cache_exp[k] = time.time() + ttl

# ── Auth helpers ──────────────────────────────────────────────────────────────
def make_token(sub, role="customer"):
    return jwt.encode({"sub": sub, "role": role, "exp": datetime.utcnow() + timedelta(days=30)}, JWT_SECRET, algorithm="HS256")

def require_admin(creds: HTTPAuthorizationCredentials = Depends(security)):
    if not creds: raise HTTPException(401, "Token required")
    try:
        payload = jwt.decode(creds.credentials, JWT_SECRET, algorithms=["HS256"])
        if payload.get("role") != "admin": raise HTTPException(403, "Admin only")
        return payload
    except jwt.PyJWTError: raise HTTPException(401, "Invalid token")

def get_current_user(creds: HTTPAuthorizationCredentials = Depends(security)):
    if not creds: return None
    try: return jwt.decode(creds.credentials, JWT_SECRET, algorithms=["HS256"])
    except: return None

# ── Schemas ───────────────────────────────────────────────────────────────────
class LoginIn(BaseModel):
    username: str; password: str

class RegisterIn(BaseModel):
    first_name: str; last_name: str; email: str
    phone: str; password: str; address: Optional[str] = ""

class CustomerUpdate(BaseModel):
    first_name: Optional[str]=None; last_name: Optional[str]=None
    phone: Optional[str]=None; address: Optional[str]=None

class ProductIn(BaseModel):
    name: str; sku: str; price: float; brand: str
    category: str; subcategory: Optional[str] = ""
    image: str = ""; stock: str = "ok"; stock_qty: int = 0
    description: str = ""; min_order: int = 1; age_min: int = 3

class ProductPatch(BaseModel):
    name: Optional[str]=None; price: Optional[float]=None
    stock: Optional[str]=None; stock_qty: Optional[int]=None
    description: Optional[str]=None; is_active: Optional[bool]=None
    image: Optional[str]=None; category: Optional[str]=None
    subcategory: Optional[str]=None

class ShareIn(BaseModel):
    items: List[dict]; comment: str = ""; store_name: str = ""
    contact: str = ""; customer_id: Optional[str] = None

class CatalogCategoryIn(BaseModel):
    name: str

class CatalogSubcategoryIn(BaseModel):
    category: str; name: str

# ── Routes ────────────────────────────────────────────────────────────────────
@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

# ── Auth ──────────────────────────────────────────────────────────────────────
@app.post("/api/auth/login")
async def login(b: LoginIn):
    h = hashlib.sha256(b.password.encode()).hexdigest()
    if _users_admin.get(b.username) == h:
        return {"token": make_token(b.username, "admin"), "username": b.username, "role": "admin"}
    for uid, c in _customers.items():
        if c["email"] == b.username and c["password_hash"] == h:
            return {"token": make_token(uid, "customer"), "customer": _safe_customer(c), "role": "customer"}
    raise HTTPException(401, "Invalid credentials")

@app.post("/api/auth/register", status_code=201)
async def register(b: RegisterIn):
    for c in _customers.values():
        if c["email"] == b.email: raise HTTPException(400, "Email already registered")
    uid = str(uuid.uuid4())
    _customers[uid] = {
        "id": uid, "first_name": b.first_name, "last_name": b.last_name,
        "email": b.email, "phone": b.phone, "address": b.address,
        "password_hash": hashlib.sha256(b.password.encode()).hexdigest(),
        "created_at": datetime.utcnow().isoformat(), "orders": [],
    }
    return {"token": make_token(uid, "customer"), "customer": _safe_customer(_customers[uid]), "role": "customer"}

def _safe_customer(c):
    return {k: v for k, v in c.items() if k != "password_hash"}

@app.get("/api/auth/me")
async def me(payload=Depends(get_current_user)):
    if not payload: raise HTTPException(401)
    if payload.get("role") == "admin": return {"role": "admin", "username": payload["sub"]}
    uid = payload["sub"]
    if uid not in _customers: raise HTTPException(404)
    return {"role": "customer", "customer": _safe_customer(_customers[uid])}

# ── Products ──────────────────────────────────────────────────────────────────
@app.get("/api/products")
async def products(
    page: int = 1, per_page: int = 40,
    category: Optional[str] = None, subcategory: Optional[str] = None,
    brand: Optional[str] = None, search: Optional[str] = None,
    stock: Optional[str] = None, sort: str = "default",
):
    ck = f"p:{page}:{per_page}:{category}:{subcategory}:{brand}:{search}:{stock}:{sort}"
    cached = c_get(ck)
    if cached: return cached
    items = [p for p in _products.values() if p["is_active"]]
    if category:    items = [p for p in items if p["category"] == category]
    if subcategory: items = [p for p in items if p.get("subcategory") == subcategory]
    if brand:       items = [p for p in items if p["brand"] == brand]
    if stock:       items = [p for p in items if p["stock"] == stock]
    if search:
        q = search.lower()
        items = [p for p in items if q in p["name"].lower() or q in p["sku"].lower()
                 or q in p["brand"].lower() or q in p["category"].lower()
                 or q in p.get("subcategory","").lower()]
    if sort == "price-asc":  items.sort(key=lambda x: x["price"])
    if sort == "price-desc": items.sort(key=lambda x: x["price"], reverse=True)
    if sort == "name":       items.sort(key=lambda x: x["name"])
    total = len(items)
    s = (page-1)*per_page
    result = {"items": items[s:s+per_page], "total": total, "page": page,
              "per_page": per_page, "pages": (total+per_page-1)//per_page}
    c_set(ck, result, 30)
    return result

@app.get("/api/products/search")
async def search_products(q: str, limit: int = 8):
    if len(q) < 2: return {"items": []}
    ck = f"srch:{q.lower()}:{limit}"
    cached = c_get(ck)
    if cached: return cached
    ql = q.lower()
    results = []
    for p in _products.values():
        if not p["is_active"]: continue
        score = (10 if ql in p["name"].lower() else 0) + (8 if ql in p["sku"].lower() else 0) + (4 if ql in p["brand"].lower() else 0)
        if score: results.append((score, p))
    results.sort(key=lambda x: x[0], reverse=True)
    result = {"items": [r[1] for r in results[:limit]]}
    c_set(ck, result, 120)
    return result

@app.get("/api/products/{pid}")
async def get_product(pid: int):
    p = _products.get(pid)
    if not p: raise HTTPException(404, "Not found")
    similar = [x for x in _products.values() if x["category"]==p["category"] and x["id"]!=pid and x["is_active"]][:4]
    return {**p, "similar": similar}

@app.post("/api/products", status_code=201)
async def create_product(b: ProductIn, _=Depends(require_admin)):
    nid = max(_products)+1 if _products else 1
    _products[nid] = {"id": nid, "is_active": True, "tags": [], "age_min": b.age_min,
                       "created_at": datetime.utcnow().isoformat(), **b.dict()}
    _cache.clear(); return _products[nid]

@app.patch("/api/products/{pid}")
async def update_product(pid: int, b: ProductPatch, _=Depends(require_admin)):
    if pid not in _products: raise HTTPException(404, "Not found")
    _products[pid].update({k:v for k,v in b.dict().items() if v is not None})
    _cache.clear(); return _products[pid]

@app.delete("/api/products/{pid}", status_code=204)
async def delete_product(pid: int, _=Depends(require_admin)):
    if pid not in _products: raise HTTPException(404)
    _products[pid]["is_active"] = False; _cache.clear()

@app.post("/api/upload-image")
async def upload_image(file: UploadFile = File(...), _=Depends(require_admin)):
    content = await file.read()
    if len(content) > 10*1024*1024: raise HTTPException(400, "File too large (max 10MB)")
    media_type = file.content_type or "image/jpeg"
    b64 = base64.b64encode(content).decode()
    return {"url": f"data:{media_type};base64,{b64}", "filename": file.filename}

# ── Catalog structure API ─────────────────────────────────────────────────────
@app.get("/api/categories")
async def categories():
    cached = c_get("__cats__")
    if cached: return cached
    result = []
    for cat in CATEGORIES:
        subs = list(_catalog.get(cat, {}).keys())
        count = sum(1 for p in _products.values() if p["category"]==cat and p["is_active"])
        result.append({"name": cat, "count": count, "subcategories": subs})
    c_set("__cats__", result, 60)
    return result

@app.get("/api/categories/{cat}/subcategories")
async def subcategories(cat: str):
    if cat not in _catalog: raise HTTPException(404, "Category not found")
    result = []
    for sub in _catalog[cat].keys():
        count = sum(1 for p in _products.values()
                    if p["category"]==cat and p.get("subcategory")==sub and p["is_active"])
        result.append({"name": sub, "count": count})
    return result

# ── Admin: manage catalog structure ──────────────────────────────────────────
@app.post("/api/admin/categories")
async def add_category(b: CatalogCategoryIn, _=Depends(require_admin)):
    if b.name in _catalog: raise HTTPException(400, "Category already exists")
    _catalog[b.name] = {}
    CATEGORIES.append(b.name)
    _cache.clear()
    return {"name": b.name, "subcategories": []}

@app.delete("/api/admin/categories/{name}")
async def del_category(name: str, _=Depends(require_admin)):
    if name not in _catalog: raise HTTPException(404)
    del _catalog[name]
    if name in CATEGORIES: CATEGORIES.remove(name)
    _cache.clear()
    return {"deleted": name}

@app.post("/api/admin/subcategories")
async def add_subcategory(b: CatalogSubcategoryIn, _=Depends(require_admin)):
    if b.category not in _catalog: raise HTTPException(404, "Category not found")
    if b.name in _catalog[b.category]: raise HTTPException(400, "Subcategory already exists")
    _catalog[b.category][b.name] = []
    _cache.clear()
    return {"category": b.category, "name": b.name}

@app.delete("/api/admin/subcategories/{cat}/{sub}")
async def del_subcategory(cat: str, sub: str, _=Depends(require_admin)):
    if cat not in _catalog or sub not in _catalog[cat]: raise HTTPException(404)
    del _catalog[cat][sub]
    _cache.clear()
    return {"deleted": sub}

# ── Brands ────────────────────────────────────────────────────────────────────
@app.get("/api/brands")
async def brands():
    return [{"name": b, "count": sum(1 for p in _products.values() if p["brand"]==b and p["is_active"])} for b in BRANDS]

# ── Cart / Share ──────────────────────────────────────────────────────────────
@app.post("/api/cart/share")
async def share_cart(b: ShareIn):
    code = "".join(random.choices(string.ascii_uppercase+string.digits, k=8))
    total = sum(i.get("price",0)*i.get("quantity",0) for i in b.items)
    cart_data = {
        "code": code, "items": b.items, "total": round(total,2),
        "comment": b.comment, "store_name": b.store_name,
        "contact": b.contact, "created_at": datetime.utcnow().isoformat(),
        "customer_id": b.customer_id,
    }
    _carts[code] = cart_data
    if b.customer_id and b.customer_id in _customers:
        _customers[b.customer_id]["orders"].append({
            "code": code, "total": round(total,2),
            "items_count": len(b.items), "date": datetime.utcnow().isoformat(),
        })
    return cart_data

@app.get("/api/cart/{code}")
async def get_cart(code: str, request: Request):
    if code not in _carts: raise HTTPException(404, "Cart not found")
    cart = _carts[code]
    accept = request.headers.get("accept", "")
    if "text/html" not in accept: return cart
    items   = cart.get("items", [])
    total   = cart.get("total", 0)
    comment = cart.get("comment", "") or ""
    created = (cart.get("created_at") or "")[:10]
    code_val = cart.get("code", code)
    cid = cart.get("customer_id")
    cname = cphone = caddr = ""
    if cid and cid in _customers:
        cu = _customers[cid]
        cname = (cu.get("first_name","") + " " + cu.get("last_name","")).strip()
        cphone = cu.get("phone","") or ""
        caddr  = cu.get("address","") or ""
    if not cname: cname = cart.get("store_name","") or ""
    rows_html = ""
    for it in items:
        img = it.get("image","") or ""
        name = it.get("name",""); sku = it.get("sku","")
        price = float(it.get("price",0)); qty = int(it.get("quantity",1)); sub = price*qty
        img_tag = f'<img src="{img}" onerror="this.style.display=\'none\'">' if img else '<div class="no-img">&#129528;</div>'
        rows_html += f"""
        <div class="item-card">
          <div class="item-img">{img_tag}</div>
          <div class="item-info">
            <div class="item-name">{name}</div>
            <div class="item-sku">SKU: {sku}</div>
            <div class="item-price-row">
              <span class="item-qty">{qty} шт &times; &#8381;{price:.2f}</span>
              <span class="item-sub">&#8381;{sub:.2f}</span>
            </div>
          </div>
        </div>"""
    client_html = ""
    if cname:
        phone_line = f'<div class="client-detail">&#128222; {cphone}</div>' if cphone else ""
        addr_line  = f'<div class="client-detail">&#128205; {caddr}</div>' if caddr else ""
        client_html = f'<div class="client-block"><div class="client-name">&#128100; {cname}</div>{phone_line}{addr_line}</div>'
    comment_html = f'<div class="comment-block">&#128172; {comment}</div>' if comment else ""
    html = f"""<!DOCTYPE html><html lang="ru"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Заказ {code_val} — Happy Toys</title>
  <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;700;900&display=swap" rel="stylesheet">
  <style>
    *{{margin:0;padding:0;box-sizing:border-box}}
    body{{font-family:'Nunito',Arial,sans-serif;background:#f5f7ff;color:#1a1a2e;min-height:100vh}}
    .topbar{{background:#fff;padding:14px 20px;display:flex;align-items:center;gap:12px;box-shadow:0 2px 12px rgba(0,0,0,.08)}}
    .logo-text{{font-size:20px;font-weight:900;color:#FF6B35}}.logo-sub{{font-size:11px;color:#aaa}}
    .back-btn{{margin-left:auto;background:#fff;border:2px solid #FF6B35;color:#FF6B35;border-radius:10px;padding:8px 16px;font-weight:700;font-size:13px;cursor:pointer;text-decoration:none}}
    .container{{max-width:640px;margin:0 auto;padding:20px 16px 48px}}
    .order-header{{background:#fff;border-radius:18px;padding:20px;margin-bottom:16px;box-shadow:0 2px 12px rgba(0,0,0,.06)}}
    .order-code{{font-size:12px;color:#aaa;margin-bottom:4px;text-transform:uppercase}}.order-title{{font-size:22px;font-weight:900}}.order-date{{font-size:13px;color:#aaa}}
    .client-block{{background:linear-gradient(135deg,#FF6B35,#ff8c5a);color:#fff;border-radius:14px;padding:16px 20px;margin-bottom:16px}}
    .client-name{{font-size:16px;font-weight:900;margin-bottom:6px}}.client-detail{{font-size:13px;opacity:.9;margin-top:3px}}
    .section-title{{font-size:12px;font-weight:700;color:#aaa;text-transform:uppercase;letter-spacing:.6px;margin-bottom:12px;padding:0 4px}}
    .items-section{{margin-bottom:16px}}
    .item-card{{background:#fff;border-radius:14px;padding:14px;margin-bottom:10px;display:flex;gap:14px;align-items:center;box-shadow:0 2px 8px rgba(0,0,0,.05)}}
    .item-img{{width:80px;height:80px;flex-shrink:0;border-radius:10px;overflow:hidden;background:#f5f5f5;display:flex;align-items:center;justify-content:center}}
    .item-img img{{width:100%;height:100%;object-fit:contain}}.no-img{{font-size:28px}}
    .item-info{{flex:1;min-width:0}}.item-name{{font-size:14px;font-weight:700;margin-bottom:3px}}
    .item-sku{{font-size:11px;color:#bbb;margin-bottom:8px}}
    .item-price-row{{display:flex;justify-content:space-between}}.item-qty{{font-size:13px;color:#888}}.item-sub{{font-size:15px;font-weight:900;color:#FF6B35}}
    .total-card{{background:#fff;border-radius:18px;padding:20px;margin-bottom:16px;box-shadow:0 2px 12px rgba(0,0,0,.06)}}
    .total-row{{display:flex;justify-content:space-between;font-size:14px;padding:8px 0;border-bottom:1px solid #f5f5f5;color:#888}}
    .total-row.big{{border-bottom:none;font-size:20px;font-weight:900;color:#FF6B35;padding-top:14px}}
    .comment-block{{background:#fffbf0;border:1px solid #ffe0b2;border-radius:14px;padding:14px 16px;font-size:14px;color:#555;margin-bottom:16px}}
    .cta{{background:#FF6B35;color:#fff;border-radius:14px;padding:16px;text-align:center;text-decoration:none;display:block;font-weight:900;font-size:16px}}
  </style></head><body>
  <div class="topbar">
    <div><div class="logo-text">Happy Toys</div><div class="logo-sub">Оптовый каталог</div></div>
    <a class="back-btn" href="/">На сайт</a>
  </div>
  <div class="container">
    <div class="order-header">
      <div class="order-code">Заказ #{code_val}</div>
      <div class="order-title">Корзина покупателя</div>
      <div class="order-date">Создан {created}</div>
    </div>
    {client_html}
    <div class="section-title">Товары ({len(items)} позиций)</div>
    <div class="items-section">{rows_html}</div>
    <div class="total-card">
      <div class="total-row"><span>Позиций</span><span>{len(items)}</span></div>
      <div class="total-row big"><span>Итого</span><span>&#8381;{total:.2f}</span></div>
    </div>
    {comment_html}
    <a class="cta" href="/">Открыть каталог Happy Toys</a>
  </div></body></html>"""
    from fastapi.responses import HTMLResponse as _HR
    return _HR(content=html)

# ── Admin ─────────────────────────────────────────────────────────────────────
@app.get("/api/admin/stats")
async def stats(_=Depends(require_admin)):
    active = [p for p in _products.values() if p["is_active"]]
    return {
        "total_products": len(active),
        "low_stock": sum(1 for p in active if p["stock"]=="low"),
        "out_of_stock": sum(1 for p in active if p["stock"]=="out"),
        "total_carts": len(_carts),
        "total_customers": len(_customers),
        "total_categories": len(_catalog),
    }

@app.get("/api/admin/carts")
async def admin_carts(_=Depends(require_admin)):
    return {"carts": sorted(_carts.values(), key=lambda x: x["created_at"], reverse=True)[:50]}

@app.get("/api/admin/customers")
async def admin_customers(_=Depends(require_admin)):
    return {"customers": [_safe_customer(c) for c in sorted(_customers.values(), key=lambda x: x["created_at"], reverse=True)]}

@app.get("/api/admin/customers/{uid}")
async def admin_customer(uid: str, _=Depends(require_admin)):
    if uid not in _customers: raise HTTPException(404)
    c = _safe_customer(_customers[uid])
    c["cart_details"] = [_carts[o["code"]] for o in c.get("orders",[]) if o["code"] in _carts]
    return c

@app.get("/api/admin/catalog")
async def admin_catalog(_=Depends(require_admin)):
    result = []
    for cat, subs in _catalog.items():
        sub_list = []
        for sub in subs.keys():
            count = sum(1 for p in _products.values() if p["category"]==cat and p.get("subcategory")==sub and p["is_active"])
            sub_list.append({"name": sub, "count": count})
        cat_count = sum(1 for p in _products.values() if p["category"]==cat and p["is_active"])
        result.append({"name": cat, "count": cat_count, "subcategories": sub_list})
    return result

@app.get("/api/health")
async def health():
    return {"status": "ok", "products": len(_products), "ts": datetime.utcnow().isoformat()}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
