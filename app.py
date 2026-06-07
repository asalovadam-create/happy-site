"""
Happy Toys — Wholesale Catalog v4
FastAPI + Neon PostgreSQL + Cloudinary
All secrets via environment variables only — never hardcoded!
"""

from fastapi import FastAPI, HTTPException, Depends, Request, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse, Response, FileResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime, timedelta
from starlette.middleware.base import BaseHTTPMiddleware
import jwt, hashlib, random, string, time, os, base64, uuid, json, asyncio

app = FastAPI(title="Happy Toys API", version="4.0.0", docs_url="/api/docs")
app.add_middleware(GZipMiddleware, minimum_size=500)

# ── Environment variables (set in Render Dashboard → Environment) ─────────────
# NEVER put real values here — only os.getenv() calls!
DATABASE_URL    = os.getenv("DATABASE_URL")          # Neon PostgreSQL URL
CLOUDINARY_URL  = os.getenv("CLOUDINARY_URL")        # cloudinary://key:secret@cloud
JWT_SECRET      = os.getenv("JWT_SECRET", "change-me-in-render-env")
ADMIN_USER      = os.getenv("ADMIN_USER", "admin")
ADMIN_PASS      = os.getenv("ADMIN_PASS", "admin123")

# ── Cloudinary setup (only if env var is set) ─────────────────────────────────
_cloudinary_ok = False
if CLOUDINARY_URL:
    try:
        import cloudinary
        import cloudinary.uploader
        cloudinary.config(cloudinary_url=CLOUDINARY_URL)
        _cloudinary_ok = True
        print("✅ Cloudinary connected")
    except ImportError:
        print("⚠️  cloudinary package not installed")
else:
    print("⚠️  CLOUDINARY_URL not set — image upload will use base64 fallback")

# ── Neon PostgreSQL setup ─────────────────────────────────────────────────────
_db_pool = None

async def get_db():
    """Get database connection from pool."""
    global _db_pool
    if _db_pool is None:
        raise HTTPException(503, "Database not connected")
    return _db_pool

async def db_fetch(query: str, *args):
    pool = await get_db()
    async with pool.acquire(timeout=10) as conn:
        return await conn.fetch(query, *args)

async def db_fetchrow(query: str, *args):
    pool = await get_db()
    async with pool.acquire(timeout=10) as conn:
        return await conn.fetchrow(query, *args)

async def db_execute(query: str, *args):
    pool = await get_db()
    async with pool.acquire(timeout=10) as conn:
        return await conn.execute(query, *args)

# ── Middleware ─────────────────────────────────────────────────────────────────
class CacheHeaders(BaseHTTPMiddleware):
    async def dispatch(self, req, call_next):
        resp = await call_next(req)
        p = req.url.path
        if p in ('/sw.js', '/static/sw.js'):
            resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
            resp.headers['Service-Worker-Allowed'] = '/'
        elif p in ('/manifest.json', '/static/manifest.json'):
            resp.headers['Cache-Control'] = 'no-cache'
        elif p.startswith('/static/') and (p.endswith('.js') or p.endswith('.css')):
            resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
            resp.headers['Pragma'] = 'no-cache'
            resp.headers['Expires'] = '0'
        elif p.startswith('/static/'):
            resp.headers['Cache-Control'] = 'public, max-age=86400'
        elif p.startswith('/api/'):
            resp.headers['Cache-Control'] = 'no-cache, must-revalidate'
        return resp

class VisitorTracker(BaseHTTPMiddleware):
    async def dispatch(self, req, call_next):
        resp = await call_next(req)
        if req.method == "GET" and not req.url.path.startswith(("/api/", "/static/", "/docs")):
            ua = req.headers.get("user-agent", "")
            ip = req.headers.get("x-forwarded-for", "unknown")
            ip = ip.split(",")[0].strip()
            device = "📱 Mobile" if ("iPhone" in ua or ("Android" in ua and "Mobile" in ua)) \
                else "📲 Tablet" if ("iPad" in ua) \
                else "💻 Desktop" if ("Mac" in ua or "Windows" in ua or "Linux" in ua) \
                else "❓ Unknown"
            browser = "Chrome" if ("Chrome" in ua and "Safari" in ua and "Edg" not in ua) \
                else "Safari" if ("Safari" in ua and "Chrome" not in ua) \
                else "Firefox" if "Firefox" in ua \
                else "Edge" if "Edg" in ua else "Other"
            # Store in DB asynchronously (non-blocking)
            try:
                asyncio.create_task(_save_visitor(ip, device, browser, ua[:120]))
            except RuntimeError:
                pass  # No event loop context — skip visitor tracking
        return resp

async def _save_visitor(ip, device, browser, ua):
    try:
        await db_execute(
            "INSERT INTO visitors(ip, device, browser, ua, created_at) VALUES($1,$2,$3,$4,$5)",
            ip, device, browser, ua, datetime.utcnow()
        )
    except Exception:
        pass  # Non-critical

app.add_middleware(CacheHeaders)
app.add_middleware(VisitorTracker)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

security = HTTPBearer(auto_error=False)

# ── DB init / startup ─────────────────────────────────────────────────────────
@app.on_event("startup")
async def startup():
    global _db_pool
    if not DATABASE_URL:
        print("⚠️  DATABASE_URL not set — running in memory-only mode")
        return
    # Clean up URL — asyncpg doesn't support channel_binding parameter
    db_url = DATABASE_URL
    for param in ['channel_binding=require', 'channel_binding=disable']:
        db_url = db_url.replace('&' + param, '').replace('?' + param + '&', '?').replace('?' + param, '')
    print(f"🔌 Connecting to DB: {db_url[:50]}...")
    try:
        import asyncpg, ssl as _ssl
        # Neon requires SSL — create proper context
        ssl_ctx = _ssl.create_default_context()
        ssl_ctx.check_hostname = False
        ssl_ctx.verify_mode = _ssl.CERT_NONE

        _db_pool = await asyncpg.create_pool(
            db_url,
            min_size=2,
            max_size=20,
            command_timeout=30,
            ssl=ssl_ctx,
            statement_cache_size=0,  # Required for PgBouncer/Neon pooler
            max_inactive_connection_lifetime=300,
        )
        print("✅ Neon pool created, initializing tables...")
        await _create_tables()
        await _seed_if_empty()
        print("✅ Neon PostgreSQL connected and ready!")
    except Exception as e:
        print(f"❌ DB connection failed: {type(e).__name__}: {e}")
        _db_pool = None
        print("⚠️  Running in LIMITED mode — registration/DB features disabled")

@app.on_event("shutdown")
async def shutdown():
    global _db_pool
    if _db_pool:
        await _db_pool.close()

async def _create_tables():
    """Create all tables if they don't exist."""
    await db_execute("""
    CREATE TABLE IF NOT EXISTS products (
        id          SERIAL PRIMARY KEY,
        name        TEXT NOT NULL,
        sku         TEXT UNIQUE NOT NULL,
        price       NUMERIC(10,2) NOT NULL,
        price_old   NUMERIC(10,2) DEFAULT NULL,
        brand       TEXT DEFAULT '',
        category    TEXT DEFAULT '',
        subcategory TEXT DEFAULT '',
        image       TEXT DEFAULT '',
        images      TEXT[] DEFAULT '{}',
        stock       TEXT DEFAULT 'ok',
        stock_qty   INTEGER DEFAULT 0,
        description TEXT DEFAULT '',
        min_order   INTEGER DEFAULT 1,
        age_min     INTEGER DEFAULT 3,
        tags        TEXT[] DEFAULT '{}',
        is_active   BOOLEAN DEFAULT TRUE,
        created_at  TIMESTAMPTZ DEFAULT NOW()
    )""")
    # Migrate existing DB — add new columns if missing
    for col_sql in [
        "ALTER TABLE products ADD COLUMN IF NOT EXISTS price_old NUMERIC(10,2) DEFAULT NULL",
        "ALTER TABLE products ADD COLUMN IF NOT EXISTS images TEXT[] DEFAULT '{}'",
    ]:
        try:
            await db_execute(col_sql)
        except Exception:
            pass


    await db_execute("""
    CREATE TABLE IF NOT EXISTS customers (
        id            TEXT PRIMARY KEY,
        first_name    TEXT DEFAULT '',
        last_name     TEXT DEFAULT '',
        email         TEXT UNIQUE NOT NULL,
        phone         TEXT DEFAULT '',
        address       TEXT DEFAULT '',
        password_hash TEXT NOT NULL,
        created_at    TIMESTAMPTZ DEFAULT NOW()
    )""")

    await db_execute("""
    CREATE TABLE IF NOT EXISTS orders (
        id          SERIAL PRIMARY KEY,
        code        TEXT UNIQUE NOT NULL,
        customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
        items       JSONB NOT NULL DEFAULT '[]',
        total       NUMERIC(10,2) DEFAULT 0,
        comment     TEXT DEFAULT '',
        store_name  TEXT DEFAULT '',
        contact     TEXT DEFAULT '',
        created_at  TIMESTAMPTZ DEFAULT NOW()
    )""")

    await db_execute("""
    CREATE TABLE IF NOT EXISTS catalog (
        id          SERIAL PRIMARY KEY,
        category    TEXT NOT NULL,
        subcategory TEXT NOT NULL DEFAULT '',
        image_url   TEXT DEFAULT '',
        sort_order  INTEGER DEFAULT 0,
        UNIQUE(category, subcategory)
    )""")

    await db_execute("""
    CREATE TABLE IF NOT EXISTS brands (
        name       TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ DEFAULT NOW()
    )""")

    await db_execute("""
    CREATE TABLE IF NOT EXISTS visitors (
        id         SERIAL PRIMARY KEY,
        ip         TEXT,
        device     TEXT,
        browser    TEXT,
        ua         TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
    )""")

    await db_execute("""
    CREATE TABLE IF NOT EXISTS sessions (
        token      TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        role       TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
    )""")

    print("✅ Tables ready")

# ── Catalog structure (kept in memory for speed, persisted in DB) ──────────────
DEFAULT_CATALOG = {
    "Машинки":         ["Легковые автомобили","Грузовики и спецтехника","Гоночные машины","Радиоуправляемые","Треки и наборы"],
    "Куклы":           ["Модные куклы","Пупсы и малыши","Принцессы","Аксессуары для кукол"],
    "Конструкторы":    ["Классические конструкторы","LEGO серии","Магнитные конструкторы","Деревянные конструкторы","Мягкие конструкторы"],
    "Мягкие игрушки":  ["Медведи и мишки","Единороги","Животные","Персонажи мультфильмов","Подушки-игрушки"],
    "Настольные игры": ["Классические игры","Стратегии","Карточные игры","Игры для детей"],
    "Развивающие":     ["Сортеры и пазлы","Обучающие наборы","Музыкальные игрушки","Для малышей 0-3 года"],
    "Пазлы":           ["Детские пазлы","Пазлы 100-500 деталей","Пазлы 500-1000 деталей","3D пазлы"],
    "Творчество":      ["Наборы для рисования","Лепка и пластилин","Бисер и украшения","Наборы для шитья","Слаймы"],
    "Канцелярия":      ["Ручки и карандаши","Тетради и блокноты","Пеналы и сумки","Фломастеры и маркеры","Точилки и ластики"],
    "Спорт и активность": ["Мячи","Велосипеды и самокаты","Скакалки и обручи","Батуты"],
    "Для малышей":     ["Погремушки","Прорезыватели","Мобили и ночники","Развивающие коврики"],
}

DEFAULT_BRANDS = ["LEGO","Barbie","Hot Wheels","Hasbro","Mattel","Playmobil","Fisher-Price","Ravensburger","Schleich","Funko"]

# Placeholder images — accessible without VPN in Russia
# These are colored placeholders until admin uploads real product photos
def _toy_img(seed: int) -> str:
    """Generate a placeholder image URL that works in Russia.
    Uses placehold.co which runs on Cloudflare — accessible everywhere."""
    colors = [
        ("FF6B35", "ffffff"),  # orange
        ("1e88e5", "ffffff"),  # blue
        ("2ECC71", "ffffff"),  # green
        ("e53935", "ffffff"),  # red
        ("7c3aed", "ffffff"),  # purple
        ("FFB347", "1a1a2e"),  # yellow
        ("FF6B9D", "ffffff"),  # pink
        ("0891b2", "ffffff"),  # teal
    ]
    bg, fg = colors[seed % len(colors)]
    emojis = ["🧸","🚗","🪆","🧱","🎲","🎨","🧩","⚽","🤖","🎁","✈️","🎵"]
    emoji = emojis[seed % len(emojis)]
    return f"https://placehold.co/600x600/{bg}/{fg}?text={emoji}"

IMGS = [_toy_img(i) for i in range(12)]
NAMES = [
    "Кукла Барби Модница Делюкс","Конструктор City 500 дет.","Машинка Турбо X",
    "Монополия Classic","Мишка плюшевый 45см","Пазл Природа 1000 эл.",
    "Кукла LOL Surprise","LEGO Technic Суперкар","Hot Wheels трек Петля",
    "Playmobil Ферма","Набор для рисования Pro","Глобус интерактивный 3D",
]

async def _seed_if_empty():
    """Seed catalog structure and brands only. Never auto-fills demo products."""
    # Seed catalog categories/subcategories if empty
    cat_count = await db_fetchrow("SELECT COUNT(*) FROM catalog")
    if cat_count[0] == 0:
        for cat, subs in DEFAULT_CATALOG.items():
            await db_execute(
                "INSERT INTO catalog(category, subcategory) VALUES($1,'') ON CONFLICT DO NOTHING",
                cat
            )
            for sub in subs:
                await db_execute(
                    "INSERT INTO catalog(category, subcategory) VALUES($1,$2) ON CONFLICT DO NOTHING",
                    cat, sub
                )
        print("✅ Catalog structure seeded")

    # Seed brands if empty
    brand_count = await db_fetchrow("SELECT COUNT(*) FROM brands")
    if brand_count[0] == 0:
        for b in DEFAULT_BRANDS:
            await db_execute("INSERT INTO brands(name) VALUES($1) ON CONFLICT DO NOTHING", b)
        print("✅ Brands seeded")

    prod_count = await db_fetchrow("SELECT COUNT(*) FROM products")
    print(f"✅ DB ready — {prod_count[0]} products")

# ── Auth helpers ──────────────────────────────────────────────────────────────
def make_token(sub, role="customer"):
    return jwt.encode(
        {"sub": sub, "role": role, "exp": datetime.utcnow() + timedelta(days=30)},
        JWT_SECRET, algorithm="HS256"
    )

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

# ── Schemas ────────────────────────────────────────────────────────────────────
class LoginIn(BaseModel):
    username: str; password: str

class RegisterIn(BaseModel):
    first_name: str; last_name: str; email: str
    phone: str; password: str; address: Optional[str] = ""

class ProductIn(BaseModel):
    name: str; sku: str; price: float
    price_old: Optional[float] = None
    brand: Optional[str] = ""
    category: str; subcategory: Optional[str] = ""
    image: str = ""; images: Optional[List[str]] = []
    stock: str = "ok"; stock_qty: int = 0
    description: str = ""; min_order: int = 1; age_min: int = 3

class ProductPatch(BaseModel):
    name: Optional[str]=None; price: Optional[float]=None
    price_old: Optional[float]=None
    stock: Optional[str]=None; stock_qty: Optional[int]=None
    description: Optional[str]=None; is_active: Optional[bool]=None
    image: Optional[str]=None; images: Optional[List[str]]=None
    category: Optional[str]=None; subcategory: Optional[str]=None
    brand: Optional[str]=None

class ShareIn(BaseModel):
    items: List[dict]; comment: str = ""; store_name: str = ""
    contact: str = ""; customer_id: Optional[str] = None

class CatalogCategoryIn(BaseModel):
    name: str

class CatalogSubcategoryIn(BaseModel):
    category: str; name: str

class BrandIn(BaseModel):
    name: str

class SubcategoryImageIn(BaseModel):
    category: str; subcategory: str; image_url: str

# ── Routes ────────────────────────────────────────────────────────────────────
@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

# ── Auth ──────────────────────────────────────────────────────────────────────
@app.post("/api/auth/login")
async def login(b: LoginIn):
    h = hashlib.sha256(b.password.encode()).hexdigest()
    # Check admin
    admin_hash = hashlib.sha256(ADMIN_PASS.encode()).hexdigest()
    if b.username == ADMIN_USER and h == admin_hash:
        return {"token": make_token(b.username, "admin"), "username": b.username, "role": "admin"}
    # Check customer in DB
    if _db_pool:
        row = await db_fetchrow(
            "SELECT * FROM customers WHERE (email=$1 OR email=$1) AND password_hash=$2",
            b.username, h
        )
        if row:
            c = dict(row)
            c.pop("password_hash", None)
            return {"token": make_token(str(c["id"]), "customer"), "customer": c, "role": "customer"}
    raise HTTPException(401, "Invalid credentials")

@app.post("/api/auth/register", status_code=201)
async def register(b: RegisterIn):
    if not _db_pool:
        raise HTTPException(503, "База данных недоступна. Попробуйте позже или обратитесь к администратору.")
    existing = await db_fetchrow("SELECT id FROM customers WHERE email=$1", b.email)
    if existing:
        raise HTTPException(400, "Email already registered")
    uid = str(uuid.uuid4())
    h = hashlib.sha256(b.password.encode()).hexdigest()
    await db_execute(
        """INSERT INTO customers(id,first_name,last_name,email,phone,address,password_hash)
           VALUES($1,$2,$3,$4,$5,$6,$7)""",
        uid, b.first_name, b.last_name, b.email, b.phone, b.address or "", h
    )
    row = await db_fetchrow("SELECT * FROM customers WHERE id=$1", uid)
    c = dict(row); c.pop("password_hash", None)
    return {"token": make_token(uid, "customer"), "customer": c, "role": "customer"}

@app.get("/api/auth/me")
async def me(payload=Depends(get_current_user)):
    if not payload: raise HTTPException(401)
    if payload.get("role") == "admin":
        return {"role": "admin", "username": payload["sub"]}
    uid = payload["sub"]
    if not _db_pool: raise HTTPException(503)
    row = await db_fetchrow("SELECT * FROM customers WHERE id=$1", uid)
    if not row: raise HTTPException(404)
    c = dict(row); c.pop("password_hash", None)
    # Get order count
    cnt = await db_fetchrow("SELECT COUNT(*) FROM orders WHERE customer_id=$1", uid)
    c["orders_count"] = cnt[0]
    return {"role": "customer", "customer": c}

# ── Products ──────────────────────────────────────────────────────────────────
@app.get("/api/products")
async def products(
    page: int = 1, per_page: int = 40,
    category: Optional[str] = None, subcategory: Optional[str] = None,
    brand: Optional[str] = None, search: Optional[str] = None,
    stock: Optional[str] = None, sort: str = "default",
):
    if not _db_pool:
        return {"items": [], "total": 0, "page": page, "per_page": per_page, "pages": 0}

    conditions = ["is_active = TRUE"]
    args = []
    idx = 1

    if category:
        conditions.append(f"category = ${idx}"); args.append(category); idx+=1
    if subcategory:
        conditions.append(f"subcategory = ${idx}"); args.append(subcategory); idx+=1
    if brand:
        conditions.append(f"brand = ${idx}"); args.append(brand); idx+=1
    if stock:
        conditions.append(f"stock = ${idx}"); args.append(stock); idx+=1
    if search:
        conditions.append(f"(name ILIKE ${idx} OR sku ILIKE ${idx} OR brand ILIKE ${idx})")
        args.append(f"%{search}%"); idx+=1

    where = " AND ".join(conditions)
    order = {"price-asc":"price ASC","price-desc":"price DESC","name":"name ASC"}.get(sort,"id ASC")

    total_row = await db_fetchrow(f"SELECT COUNT(*) FROM products WHERE {where}", *args)
    total = total_row[0]
    offset = (page-1)*per_page

    rows = await db_fetch(
        f"SELECT * FROM products WHERE {where} ORDER BY {order} LIMIT ${ idx} OFFSET ${idx+1}",
        *args, per_page, offset
    )
    items = [dict(r) for r in rows]
    return {
        "items": items, "total": total, "page": page,
        "per_page": per_page, "pages": max(1, (total+per_page-1)//per_page)
    }

@app.get("/api/products/search")
async def search_products(q: str, limit: int = 8):
    if len(q) < 2 or not _db_pool: return {"items": []}
    rows = await db_fetch(
        """SELECT * FROM products WHERE is_active=TRUE AND
           (name ILIKE $1 OR sku ILIKE $1 OR brand ILIKE $1)
           ORDER BY (CASE WHEN name ILIKE $1 THEN 0 ELSE 1 END) LIMIT $2""",
        f"%{q}%", limit
    )
    return {"items": [dict(r) for r in rows]}

@app.get("/api/products/{pid}")
async def get_product(pid: int):
    if not _db_pool: raise HTTPException(503)
    row = await db_fetchrow("SELECT * FROM products WHERE id=$1 AND is_active=TRUE", pid)
    if not row: raise HTTPException(404)
    p = dict(row)
    similar_rows = await db_fetch(
        "SELECT * FROM products WHERE category=$1 AND id!=$2 AND is_active=TRUE LIMIT 4",
        p["category"], pid
    )
    p["similar"] = [dict(r) for r in similar_rows]
    return p

@app.post("/api/products", status_code=201)
async def create_product(b: ProductIn, _=Depends(require_admin)):
    if not _db_pool: raise HTTPException(503)
    row = await db_fetchrow("""
        INSERT INTO products(name,sku,price,price_old,brand,category,subcategory,
                             image,images,stock,stock_qty,description,min_order,age_min,tags)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        RETURNING *""",
        b.name, b.sku, b.price, b.price_old,
        b.brand or "", b.category, b.subcategory or "",
        b.image, b.images or [], b.stock, b.stock_qty,
        b.description, b.min_order, b.age_min, []
    )
    return dict(row)

@app.patch("/api/products/{pid}")
async def update_product(pid: int, b: ProductPatch, _=Depends(require_admin)):
    if not _db_pool: raise HTTPException(503)
    fields = {k:v for k,v in b.dict().items() if v is not None}
    if not fields: raise HTTPException(400, "No fields to update")
    sets = ", ".join(f"{k}=${i+2}" for i,k in enumerate(fields.keys()))
    vals = list(fields.values())
    row = await db_fetchrow(
        f"UPDATE products SET {sets} WHERE id=$1 RETURNING *",
        pid, *vals
    )
    if not row: raise HTTPException(404)
    return dict(row)

@app.delete("/api/products/{pid}", status_code=204)
async def delete_product(pid: int, _=Depends(require_admin)):
    if not _db_pool: raise HTTPException(503)
    await db_execute("UPDATE products SET is_active=FALSE WHERE id=$1", pid)

# ── Image upload (Cloudinary) ─────────────────────────────────────────────────
@app.post("/api/upload-image")
async def upload_image(file: UploadFile = File(...), _=Depends(require_admin)):
    content = await file.read()
    if len(content) > 15*1024*1024:
        raise HTTPException(400, "File too large (max 15MB)")

    if _cloudinary_ok:
        import cloudinary.uploader
        import functools
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None,
            functools.partial(
                cloudinary.uploader.upload,
                content,
                folder="happy-toys/products",
                resource_type="image",
                transformation=[
                    {"width": 800, "height": 800, "crop": "limit", "quality": "auto:good"},
                ]
            )
        )
        return {"url": result["secure_url"], "public_id": result["public_id"]}
    else:
        # Fallback: base64 (works without Cloudinary)
        media_type = file.content_type or "image/jpeg"
        b64 = base64.b64encode(content).decode()
        return {"url": f"data:{media_type};base64,{b64}", "filename": file.filename}

# ── Categories ────────────────────────────────────────────────────────────────
@app.get("/api/categories")
async def categories():
    if not _db_pool:
        return [{"name": cat, "count": 0, "subcategories": subs}
                for cat, subs in DEFAULT_CATALOG.items()]

    # Single query for all product counts per category
    cat_counts = await db_fetch("""
        SELECT category, COUNT(*) as cnt FROM products
        WHERE is_active=TRUE GROUP BY category
    """)
    cnt_map = {r["category"]: r["cnt"] for r in cat_counts}

    cats = await db_fetch("SELECT DISTINCT category FROM catalog WHERE subcategory='' ORDER BY category")
    result = []
    for row in cats:
        cat = row["category"]
        sub_rows = await db_fetch(
            "SELECT subcategory FROM catalog WHERE category=$1 AND subcategory!='' ORDER BY sort_order, subcategory",
            cat
        )
        result.append({
            "name": cat,
            "count": cnt_map.get(cat, 0),
            "subcategories": [r["subcategory"] for r in sub_rows]
        })
    return result

@app.get("/api/categories/{cat}/subcategories")
async def subcategories(cat: str):
    from urllib.parse import unquote
    cat = unquote(cat)
    if not _db_pool:
        subs = DEFAULT_CATALOG.get(cat, [])
        return [{"name": s, "count": 0, "image": ""} for s in subs]
    rows = await db_fetch(
        "SELECT subcategory, image_url FROM catalog WHERE category=$1 AND subcategory!='' ORDER BY sort_order, subcategory",
        cat
    )
    # Single query for all counts
    counts = await db_fetch(
        "SELECT subcategory, COUNT(*) as cnt FROM products WHERE category=$1 AND is_active=TRUE GROUP BY subcategory",
        cat
    )
    cnt_map = {r["subcategory"]: r["cnt"] for r in counts}
    return [{"name": r["subcategory"], "count": cnt_map.get(r["subcategory"], 0), "image": r["image_url"] or ""} for r in rows]

# ── Admin catalog management ──────────────────────────────────────────────────
@app.post("/api/admin/categories")
async def add_category(b: CatalogCategoryIn, _=Depends(require_admin)):
    if not _db_pool: raise HTTPException(503)
    try:
        await db_execute(
            "INSERT INTO catalog(category, subcategory) VALUES($1, '')",
            b.name
        )
    except Exception:
        raise HTTPException(400, "Category already exists")
    return {"name": b.name}

@app.delete("/api/admin/categories/{name}")
async def del_category(name: str, _=Depends(require_admin)):
    if not _db_pool: raise HTTPException(503)
    from urllib.parse import unquote
    name = unquote(name)
    await db_execute("DELETE FROM catalog WHERE category=$1", name)
    return {"deleted": name}

@app.post("/api/admin/subcategories")
async def add_subcategory(b: CatalogSubcategoryIn, _=Depends(require_admin)):
    if not _db_pool: raise HTTPException(503)
    try:
        await db_execute(
            "INSERT INTO catalog(category, subcategory) VALUES($1, $2)",
            b.category, b.name
        )
    except Exception:
        raise HTTPException(400, "Subcategory already exists")
    return {"category": b.category, "name": b.name}

@app.delete("/api/admin/subcategories/{cat}/{sub}")
async def del_subcategory(cat: str, sub: str, _=Depends(require_admin)):
    if not _db_pool: raise HTTPException(503)
    from urllib.parse import unquote
    cat = unquote(cat); sub = unquote(sub)
    await db_execute("DELETE FROM catalog WHERE category=$1 AND subcategory=$2", cat, sub)
    return {"deleted": sub}

@app.post("/api/admin/subcategory-image")
async def set_subcat_image(b: SubcategoryImageIn, _=Depends(require_admin)):
    if not _db_pool: raise HTTPException(503)
    await db_execute(
        "UPDATE catalog SET image_url=$3 WHERE category=$1 AND subcategory=$2",
        b.category, b.subcategory, b.image_url
    )
    return {"ok": True}

# ── Brands ────────────────────────────────────────────────────────────────────
@app.get("/api/brands")
async def brands():
    if not _db_pool:
        return [{"name": b, "count": 0} for b in DEFAULT_BRANDS]
    rows = await db_fetch("""
        SELECT b.name, COUNT(p.id) as count
        FROM brands b
        LEFT JOIN products p ON p.brand=b.name AND p.is_active=TRUE
        GROUP BY b.name ORDER BY count DESC, b.name
    """)
    return [dict(r) for r in rows]

@app.post("/api/admin/brands")
async def add_brand(b: BrandIn, _=Depends(require_admin)):
    if not _db_pool: raise HTTPException(503)
    await db_execute("INSERT INTO brands(name) VALUES($1) ON CONFLICT DO NOTHING", b.name.strip())
    return {"name": b.name}

@app.delete("/api/admin/brands/{name}")
async def del_brand(name: str, _=Depends(require_admin)):
    if not _db_pool: raise HTTPException(503)
    await db_execute("DELETE FROM brands WHERE name=$1", name)
    return {"deleted": name}

# ── Cart / Orders ─────────────────────────────────────────────────────────────
@app.post("/api/cart/share")
async def share_cart(b: ShareIn):
    code = "".join(random.choices(string.ascii_uppercase+string.digits, k=8))
    total = sum(i.get("price",0)*i.get("quantity",0) for i in b.items)
    if _db_pool:
        await db_execute("""
            INSERT INTO orders(code,customer_id,items,total,comment,store_name,contact)
            VALUES($1,$2,$3,$4,$5,$6,$7)""",
            code, b.customer_id or None,
            json.dumps(b.items, ensure_ascii=False),
            round(total,2), b.comment, b.store_name, b.contact
        )
    return {"code": code, "total": round(total,2), "items": b.items}

@app.get("/api/cart/{code}")
async def get_cart(code: str, request: Request):
    if not _db_pool: raise HTTPException(503)
    row = await db_fetchrow("SELECT * FROM orders WHERE code=$1", code)
    if not row: raise HTTPException(404, "Cart not found")
    cart = dict(row)
    cart["items"] = json.loads(cart["items"]) if isinstance(cart["items"], str) else cart["items"]
    accept = request.headers.get("accept","")
    if "text/html" not in accept:
        return cart
    # Return HTML page (same as before)
    items = cart.get("items",[])
    total = float(cart.get("total",0))
    date  = (cart.get("created_at") or datetime.utcnow()).strftime("%d.%m.%Y") if cart.get("created_at") else ""
    site_url = str(request.base_url).rstrip("/")
    rows_html = ""
    for it in items:
        img = it.get("image","") or ""
        img_tag = f'<img src="{img}" onerror="this.style.display=\'none\'">' if img else "<div>🧸</div>"
        sub = float(it.get("price",0))*int(it.get("quantity",1))
        rows_html += f"""<div class="item-card">
          <div class="item-img">{img_tag}</div>
          <div class="item-info">
            <div class="item-name">{it.get('name','')}</div>
            <div class="item-sku">Арт: {it.get('sku','')}</div>
            <div class="item-price-row">
              <span>{it.get('quantity',1)} шт × ₽{float(it.get('price',0)):.2f}</span>
              <span class="item-sub">₽{sub:.2f}</span>
            </div>
          </div></div>"""
    html = f"""<!DOCTYPE html><html lang="ru"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Заказ {code} — Happy Toys</title>
<link href="https://fonts.googleapis.com/css2?family=Nunito:wght@700;900&display=swap" rel="stylesheet">
<style>*{{margin:0;padding:0;box-sizing:border-box}}body{{font-family:'Nunito',sans-serif;background:#f5f5f5;color:#1a1a2e;padding:20px;max-width:640px;margin:0 auto}}
.back-bar{{display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap}}.btn{{display:inline-flex;align-items:center;gap:8px;padding:11px 20px;border-radius:12px;font-size:14px;font-weight:800;cursor:pointer;text-decoration:none;border:none}}
.back-btn{{background:#FF6B35;color:#fff}}.print-btn{{background:#fff;color:#FF6B35;border:2px solid #FF6B35}}
.card{{background:#fff;border-radius:16px;padding:16px;margin-bottom:12px;box-shadow:0 2px 8px rgba(0,0,0,.06)}}
.item-card{{display:flex;gap:12px;margin-bottom:10px;background:#fff;border-radius:14px;padding:12px;box-shadow:0 1px 4px rgba(0,0,0,.05)}}
.item-img{{width:80px;height:80px;border-radius:10px;overflow:hidden;background:#f5f5f5;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:30px}}
.item-img img{{width:100%;height:100%;object-fit:contain}}.item-info{{flex:1}}.item-name{{font-weight:700;font-size:14px;margin-bottom:3px}}
.item-sku{{font-size:11px;color:#bbb;margin-bottom:6px}}.item-price-row{{display:flex;justify-content:space-between}}.item-sub{{font-weight:900;color:#FF6B35}}
.total-val{{font-size:24px;font-weight:900;color:#FF6B35}}.title{{font-size:20px;font-weight:900;margin-bottom:4px}}
@media print{{.back-bar{{display:none}}}}</style></head><body>
<div class="back-bar">
  <a class="btn back-btn" href="{site_url}">← Вернуться в каталог</a>
  <button class="btn print-btn" onclick="window.print()">🖨 Печать / PDF</button>
</div>
<div class="card"><div class="title">Заказ #{code}</div><div style="color:#aaa;font-size:13px">{date}</div></div>
{rows_html}
<div class="card" style="display:flex;justify-content:space-between;align-items:center">
  <span style="font-weight:700">Итого</span><span class="total-val">₽{total:.2f}</span>
</div>
</body></html>"""
    from fastapi.responses import HTMLResponse as _HR
    return _HR(content=html)

# ── Admin ─────────────────────────────────────────────────────────────────────
@app.get("/api/admin/stats")
async def stats(_=Depends(require_admin)):
    if not _db_pool:
        return {"total_products":0,"low_stock":0,"out_of_stock":0,"total_carts":0,"total_customers":0,"total_categories":0,"total_visitors":0,"today_visits":0}
    p_stats = await db_fetchrow("""
        SELECT
          COUNT(*) FILTER(WHERE is_active) as total,
          COUNT(*) FILTER(WHERE stock='low' AND is_active) as low,
          COUNT(*) FILTER(WHERE stock='out' AND is_active) as out_of_stock
        FROM products""")
    carts     = await db_fetchrow("SELECT COUNT(*) FROM orders")
    customers = await db_fetchrow("SELECT COUNT(*) FROM customers")
    cats      = await db_fetchrow("SELECT COUNT(DISTINCT category) FROM catalog WHERE subcategory=''")
    vis_total = await db_fetchrow("SELECT COUNT(*) FROM visitors")
    vis_today = await db_fetchrow("SELECT COUNT(*) FROM visitors WHERE created_at::date=CURRENT_DATE")
    return {
        "total_products": p_stats[0], "low_stock": p_stats[1],
        "out_of_stock": p_stats[2], "total_carts": carts[0],
        "total_customers": customers[0], "total_categories": cats[0],
        "total_visitors": vis_total[0], "today_visits": vis_today[0],
    }

@app.get("/api/admin/carts")
async def admin_carts(_=Depends(require_admin)):
    if not _db_pool: return {"carts":[]}
    rows = await db_fetch("SELECT * FROM orders ORDER BY created_at DESC LIMIT 50")
    carts = []
    for r in rows:
        d = dict(r)
        d["items"] = json.loads(d["items"]) if isinstance(d["items"],str) else d["items"]
        carts.append(d)
    return {"carts": carts}

@app.get("/api/admin/customers")
async def admin_customers(_=Depends(require_admin)):
    if not _db_pool: return {"customers":[]}
    rows = await db_fetch("SELECT id,first_name,last_name,email,phone,address,created_at FROM customers ORDER BY created_at DESC")
    return {"customers": [dict(r) for r in rows]}

@app.get("/api/admin/visitors")
async def admin_visitors(_=Depends(require_admin)):
    if not _db_pool: return {"visitors":[]}
    rows = await db_fetch("SELECT ip,device,browser,created_at as time FROM visitors ORDER BY created_at DESC LIMIT 200")
    return {"visitors": [dict(r) for r in rows]}

@app.get("/api/admin/catalog")
async def admin_catalog(_=Depends(require_admin)):
    if not _db_pool: return []
    # Single query: all categories + subcategories with product counts
    cat_counts = await db_fetch("""
        SELECT category, COUNT(*) FILTER (WHERE is_active) as cnt
        FROM products GROUP BY category
    """)
    cat_cnt_map = {r["category"]: r["cnt"] for r in cat_counts}

    sub_counts = await db_fetch("""
        SELECT category, subcategory, COUNT(*) FILTER (WHERE is_active) as cnt
        FROM products WHERE subcategory != '' GROUP BY category, subcategory
    """)
    sub_cnt_map = {(r["category"], r["subcategory"]): r["cnt"] for r in sub_counts}

    cats = await db_fetch("SELECT DISTINCT category FROM catalog WHERE subcategory='' ORDER BY category")
    result = []
    for cat_row in cats:
        cat = cat_row["category"]
        subs = await db_fetch(
            "SELECT subcategory, image_url FROM catalog WHERE category=$1 AND subcategory!='' ORDER BY sort_order, subcategory", cat
        )
        sub_list = [{"name": s["subcategory"], "count": sub_cnt_map.get((cat, s["subcategory"]), 0)} for s in subs]
        result.append({"name": cat, "count": cat_cnt_map.get(cat, 0), "subcategories": sub_list})
    return result

# ── PWA files ─────────────────────────────────────────────────────────────────
MANIFEST_DATA = {
    "name":"Happy Toys — Оптовый каталог","short_name":"Happy Toys",
    "start_url":"/","scope":"/","display":"standalone",
    "background_color":"#ffffff","theme_color":"#FF6B35",
    "lang":"ru",
    "icons":[
        {"src":"/static/icon-192.png","sizes":"192x192","type":"image/png","purpose":"any maskable"},
        {"src":"/static/icon-512.png","sizes":"512x512","type":"image/png","purpose":"any maskable"},
    ]
}

@app.get("/manifest.json", include_in_schema=False)
@app.get("/static/manifest.json", include_in_schema=False)
async def manifest_json():
    path = "static/manifest.json"
    if os.path.exists(path):
        r = FileResponse(path, media_type="application/manifest+json")
    else:
        r = Response(json.dumps(MANIFEST_DATA), media_type="application/manifest+json")
    r.headers["Cache-Control"] = "no-cache"
    return r

SW_INLINE = (
    "self.addEventListener('install',e=>self.skipWaiting());"
    "self.addEventListener('activate',e=>self.clients.claim());"
    "self.addEventListener('fetch',e=>{"
    "if(e.request.method!=='GET')return;"
    "const u=e.request.url;"
    "if(u.includes('/api/')||u.includes('app.js')||u.includes('style.css')){e.respondWith(fetch(e.request));return;}"
    "e.respondWith(caches.open('ht-v4').then(c=>c.match(e.request).then(r=>r||fetch(e.request)"
    ".then(nr=>{if(nr.ok)c.put(e.request,nr.clone());return nr;}))).catch(()=>caches.match('/')));"
    "});"
)

def _sw_response():
    sw_path = "static/sw.js"
    content = open(sw_path).read() if os.path.exists(sw_path) else SW_INLINE
    r = Response(content=content, media_type="application/javascript")
    r.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    r.headers["Service-Worker-Allowed"] = "/"
    return r

@app.get("/sw.js", include_in_schema=False)
async def sw_root(): return _sw_response()

@app.get("/static/sw.js", include_in_schema=False)
async def sw_static(): return _sw_response()

@app.get("/api/admin/products")
async def admin_products_list(
    page: int = 1, per_page: int = 20,
    search: Optional[str] = None,
    category: Optional[str] = None,
    _=Depends(require_admin)
):
    if not _db_pool: return {"items": [], "total": 0}
    conds = ["TRUE"]; args = []; idx = 1
    if search:
        conds.append(f"(name ILIKE ${idx} OR sku ILIKE ${idx})")
        args.append(f"%{search}%"); idx += 1
    if category:
        conds.append(f"category = ${idx}"); args.append(category); idx += 1
    where = " AND ".join(conds)
    total = (await db_fetchrow(f"SELECT COUNT(*) FROM products WHERE {where}", *args))[0]
    rows = await db_fetch(
        f"SELECT * FROM products WHERE {where} ORDER BY id DESC LIMIT ${idx} OFFSET ${idx+1}",
        *args, per_page, (page-1)*per_page
    )
    return {"items": [dict(r) for r in rows], "total": total,
            "page": page, "pages": max(1,(total+per_page-1)//per_page)}

@app.delete("/api/admin/products/all")
async def delete_all_products(_=Depends(require_admin)):
    """Delete ALL products from the database. Irreversible!"""
    if not _db_pool:
        raise HTTPException(503, "DB not available")
    deleted = (await db_fetchrow("SELECT COUNT(*) FROM products"))[0]
    await db_execute("DELETE FROM products")
    # Reset the ID sequence so new products start from 1
    await db_execute("ALTER SEQUENCE products_id_seq RESTART WITH 1")
    return {"deleted": deleted, "message": f"Удалено {deleted} товаров"}

@app.post("/api/admin/migrate-images")
async def migrate_images(_=Depends(require_admin)):
    """One-time migration: replace unsplash URLs with placeholders."""
    if not _db_pool:
        raise HTTPException(503, "DB not available")
    updated = 0
    rows = await db_fetch("SELECT id, image FROM products WHERE image LIKE '%unsplash%'")
    for i, row in enumerate(rows):
        new_img = _toy_img(i % 12)
        await db_execute("UPDATE products SET image=$1, images='{}' WHERE id=$2",
                         new_img, row["id"])
        updated += 1
    return {"updated": updated, "message": f"Replaced {updated} unsplash images with placeholders"}

@app.get("/api/health")
async def health():
    db_ok = False
    db_error = None
    if _db_pool:
        try:
            await db_fetchrow("SELECT 1")
            db_ok = True
        except Exception as e:
            db_error = str(e)
    return {
        "status": "ok",
        "db_connected": db_ok,
        "db_pool": _db_pool is not None,
        "db_error": db_error,
        "cloudinary": _cloudinary_ok,
        "ts": datetime.utcnow().isoformat()
    }

@app.get("/api/debug/db")
async def debug_db():
    """Live DB connection test — shows exact error."""
    if not DATABASE_URL:
        return {"error": "DATABASE_URL env var not set"}

    # Clean URL same way as startup
    db_url = DATABASE_URL
    for param in ['channel_binding=require', 'channel_binding=disable']:
        db_url = db_url.replace('&' + param, '').replace('?' + param + '&', '?').replace('?' + param, '')

    masked = db_url[:45] + "..." if len(db_url) > 45 else db_url

    # Try connecting right now
    result = {"url_preview": masked, "pool_active": _db_pool is not None}
    try:
        import asyncpg, ssl as _ssl
        ssl_ctx = _ssl.create_default_context()
        ssl_ctx.check_hostname = False
        ssl_ctx.verify_mode = _ssl.CERT_NONE

        conn = await asyncpg.connect(db_url, ssl=ssl_ctx, timeout=15,
                                     statement_cache_size=0)
        ver = await conn.fetchval("SELECT version()")
        await conn.close()
        result["live_test"] = "✅ SUCCESS"
        result["pg_version"] = ver[:60]
    except Exception as e:
        result["live_test"] = "❌ FAILED"
        result["error_type"] = type(e).__name__
        result["error_msg"] = str(e)

    return result

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
