"""
Happy Toys — Wholesale Catalog
FastAPI backend · JWT auth · user registration · image upload · in-memory DB
"""

from fastapi import FastAPI, HTTPException, Depends, Request, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, Field
from typing import Optional, List
from datetime import datetime, timedelta
import jwt, hashlib, random, string, time, os, base64, uuid

app = FastAPI(title="Happy Toys API", version="2.0.0", docs_url="/api/docs")
app.add_middleware(GZipMiddleware, minimum_size=500)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

# ── Config ───────────────────────────────────────────────────────────────────
JWT_SECRET  = os.getenv("JWT_SECRET",  "happytoys-secret-2025")
ADMIN_USER  = os.getenv("ADMIN_USER",  "admin")
ADMIN_PASS  = os.getenv("ADMIN_PASS",  "admin123")
security    = HTTPBearer(auto_error=False)

# ── Seed data ────────────────────────────────────────────────────────────────
CATEGORIES = ["Куклы","Конструкторы","Машинки","Настольные игры","Мягкие игрушки","Развивающие","Пазлы","Творчество"]
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
    for i in range(1, 201):
        sv = random.random()
        stock = "ok" if sv > 0.6 else ("low" if sv > 0.25 else "out")
        db[i] = {
            "id": i, "is_active": True,
            "name": NAMES[(i-1) % len(NAMES)] + (f" #{i}" if i > len(NAMES) else ""),
            "sku": f"HT-{i:04d}",
            "price": round(random.uniform(3.5, 149.99), 2),
            "brand": BRANDS[(i-1) % len(BRANDS)],
            "category": CATEGORIES[(i-1) % len(CATEGORIES)],
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
_customers   = {}   # uid -> customer dict
_cache: dict = {}
_cache_exp: dict = {}

def c_get(k):
    return _cache[k] if k in _cache and time.time() < _cache_exp.get(k, 0) else None

def c_set(k, v, ttl=30):
    _cache[k] = v; _cache_exp[k] = time.time() + ttl

# ── Auth ──────────────────────────────────────────────────────────────────────
def make_token(sub, role="customer"):
    return jwt.encode({"sub": sub, "role": role, "exp": datetime.utcnow() + timedelta(hours=24)}, JWT_SECRET, algorithm="HS256")

def require_admin(creds: HTTPAuthorizationCredentials = Depends(security)):
    if not creds:
        raise HTTPException(401, "Token required")
    try:
        payload = jwt.decode(creds.credentials, JWT_SECRET, algorithms=["HS256"])
        if payload.get("role") != "admin":
            raise HTTPException(403, "Admin only")
        return payload
    except jwt.PyJWTError:
        raise HTTPException(401, "Invalid token")

def get_current_user(creds: HTTPAuthorizationCredentials = Depends(security)):
    if not creds:
        return None
    try:
        return jwt.decode(creds.credentials, JWT_SECRET, algorithms=["HS256"])
    except:
        return None

# ── Schemas ───────────────────────────────────────────────────────────────────
class LoginIn(BaseModel):
    username: str; password: str

class RegisterIn(BaseModel):
    first_name: str
    last_name: str
    email: str
    phone: str
    password: str
    address: Optional[str] = ""

class CustomerUpdate(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None

class ProductIn(BaseModel):
    name: str; sku: str; price: float; brand: str; category: str
    image: str = ""; stock: str = "ok"; stock_qty: int = 0
    description: str = ""; min_order: int = 1; age_min: int = 3

class ProductPatch(BaseModel):
    name: Optional[str]=None; price: Optional[float]=None
    stock: Optional[str]=None; stock_qty: Optional[int]=None
    description: Optional[str]=None; is_active: Optional[bool]=None
    image: Optional[str]=None

class ShareIn(BaseModel):
    items: List[dict]
    comment: str = ""; store_name: str = ""; contact: str = ""
    customer_id: Optional[str] = None

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
    # Check customers by email
    for uid, c in _customers.items():
        if c["email"] == b.username and c["password_hash"] == h:
            return {"token": make_token(uid, "customer"), "customer": _safe_customer(c), "role": "customer"}
    raise HTTPException(401, "Invalid credentials")

@app.post("/api/auth/register", status_code=201)
async def register(b: RegisterIn):
    # Check email unique
    for c in _customers.values():
        if c["email"] == b.email:
            raise HTTPException(400, "Email already registered")
    uid = str(uuid.uuid4())
    _customers[uid] = {
        "id": uid,
        "first_name": b.first_name,
        "last_name": b.last_name,
        "email": b.email,
        "phone": b.phone,
        "address": b.address,
        "password_hash": hashlib.sha256(b.password.encode()).hexdigest(),
        "created_at": datetime.utcnow().isoformat(),
        "orders": [],
    }
    token = make_token(uid, "customer")
    return {"token": token, "customer": _safe_customer(_customers[uid]), "role": "customer"}

def _safe_customer(c):
    return {k: v for k, v in c.items() if k != "password_hash"}

@app.get("/api/auth/me")
async def me(payload=Depends(get_current_user)):
    if not payload:
        raise HTTPException(401)
    if payload.get("role") == "admin":
        return {"role": "admin", "username": payload["sub"]}
    uid = payload["sub"]
    if uid not in _customers:
        raise HTTPException(404)
    return {"role": "customer", "customer": _safe_customer(_customers[uid])}

# ── Products ──────────────────────────────────────────────────────────────────
@app.get("/api/products")
async def products(
    page: int = 1, per_page: int = 40,
    category: Optional[str] = None, brand: Optional[str] = None,
    search: Optional[str] = None, stock: Optional[str] = None,
    sort: str = "default",
):
    ck = f"p:{page}:{per_page}:{category}:{brand}:{search}:{stock}:{sort}"
    cached = c_get(ck)
    if cached: return cached

    items = [p for p in _products.values() if p["is_active"]]
    if category: items = [p for p in items if p["category"] == category]
    if brand:    items = [p for p in items if p["brand"] == brand]
    if stock:    items = [p for p in items if p["stock"] == stock]
    if search:
        q = search.lower()
        items = [p for p in items if q in p["name"].lower() or q in p["sku"].lower()
                 or q in p["brand"].lower() or q in p["category"].lower()]
    if sort == "price-asc":  items.sort(key=lambda x: x["price"])
    if sort == "price-desc": items.sort(key=lambda x: x["price"], reverse=True)
    if sort == "name":       items.sort(key=lambda x: x["name"])

    total = len(items)
    s = (page-1)*per_page
    result = {"items": items[s:s+per_page], "total": total, "page": page,
              "per_page": per_page, "pages": (total+per_page-1)//per_page}
    c_set(ck, result)
    return result

@app.get("/api/products/search")
async def search_products(q: str, limit: int = 6):
    if len(q) < 2: return {"items": []}
    ql = q.lower()
    results = []
    for p in _products.values():
        if not p["is_active"]: continue
        score = (10 if ql in p["name"].lower() else 0) + (8 if ql in p["sku"].lower() else 0) + (4 if ql in p["brand"].lower() else 0)
        if score: results.append((score, p))
    results.sort(key=lambda x: x[0], reverse=True)
    return {"items": [r[1] for r in results[:limit]]}

@app.get("/api/products/{pid}")
async def get_product(pid: int):
    p = _products.get(pid)
    if not p: raise HTTPException(404, "Not found")
    similar = [x for x in _products.values() if x["category"]==p["category"] and x["id"]!=pid and x["is_active"]][:4]
    return {**p, "similar": similar}

@app.post("/api/products", status_code=201)
async def create_product(b: ProductIn, _=Depends(require_admin)):
    nid = max(_products)+1
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
    if pid not in _products: raise HTTPException(404, "Not found")
    _products[pid]["is_active"] = False; _cache.clear()

# ── Image upload ──────────────────────────────────────────────────────────────
@app.post("/api/upload-image")
async def upload_image(file: UploadFile = File(...), _=Depends(require_admin)):
    """Upload image and return base64 data URL (stored in memory)"""
    content = await file.read()
    if len(content) > 10 * 1024 * 1024:  # 10MB limit
        raise HTTPException(400, "File too large (max 10MB)")
    
    media_type = file.content_type or "image/jpeg"
    b64 = base64.b64encode(content).decode()
    data_url = f"data:{media_type};base64,{b64}"
    return {"url": data_url, "filename": file.filename}

# ── Categories / Brands ───────────────────────────────────────────────────────
@app.get("/api/categories")
async def categories():
    return [{"name": c, "count": sum(1 for p in _products.values() if p["category"]==c and p["is_active"])} for c in CATEGORIES]

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
    # Link order to customer
    if b.customer_id and b.customer_id in _customers:
        _customers[b.customer_id]["orders"].append({
            "code": code, "total": round(total,2),
            "items_count": len(b.items),
            "date": datetime.utcnow().isoformat(),
        })
    return cart_data

@app.get("/api/cart/{code}")
async def get_cart(code: str):
    if code not in _carts: raise HTTPException(404, "Cart not found")
    return _carts[code]

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
    # attach cart details
    c["cart_details"] = [_carts[o["code"]] for o in c.get("orders",[]) if o["code"] in _carts]
    return c

@app.get("/api/health")
async def health():
    return {"status": "ok", "products": len(_products), "ts": datetime.utcnow().isoformat()}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
