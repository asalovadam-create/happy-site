"""
Страница владельца /boss — отдельно от админ-панели сотрудников.

Что внутри:
  • приём событий с сайта (/api/t/collect): устройства, переходы, нажатия, скачивания, корзины;
  • защищённый вход владельца (BOSS_USER / BOSS_PASS из переменных окружения);
  • API: «сейчас на сайте», посетители, пользователи, корзины (смотреть/удалять), статистика, выгрузки.

Включается только если в Render задан BOSS_PASS (пароля по умолчанию нет намеренно).
"""
import csv
import hashlib
import hmac
import io
import json
import os
import re
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import List, Optional

import jwt
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

import devices

router = APIRouter()
_bearer = HTTPBearer(auto_error=False)

BOSS_USER = os.getenv("BOSS_USER", "boss")
BOSS_PASS = os.getenv("BOSS_PASS", "")
TRACK_DAYS = int(os.getenv("TRACK_DAYS", "90"))          # сколько дней хранить события
_VID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")

_ctx = {}  # db_fetch, db_fetchrow, db_execute, get_pool, jwt_secret


def register(app, templates, db_fetch, db_fetchrow, db_execute, get_pool, jwt_secret):
    _ctx.update(fetch=db_fetch, fetchrow=db_fetchrow, execute=db_execute, pool=get_pool, secret=jwt_secret)
    app.include_router(router)

    @app.get("/boss", include_in_schema=False)
    async def boss_page(request: Request):
        base = os.path.dirname(os.path.abspath(__file__))

        def ver(rel):
            try:
                return int(os.path.getmtime(os.path.join(base, rel)))
            except OSError:
                return 1

        resp = templates.TemplateResponse("boss.html", {
            "request": request, "v_js": ver("static/boss.js"), "v_css": ver("static/boss.css"),
            "enabled": bool(BOSS_PASS)})
        resp.headers["Cache-Control"] = "no-store"
        resp.headers["X-Robots-Tag"] = "noindex, nofollow"
        return resp


# ── Таблицы ──────────────────────────────────────────────────────────────────
async def create_tables():
    ex = _ctx["execute"]
    await ex("""
    CREATE TABLE IF NOT EXISTS t_visitors (
        vid TEXT PRIMARY KEY,
        first_seen TIMESTAMPTZ DEFAULT NOW(), last_seen TIMESTAMPTZ DEFAULT NOW(),
        visits INTEGER DEFAULT 1, ip TEXT DEFAULT '', ua TEXT DEFAULT '',
        device_name TEXT DEFAULT '', brand TEXT DEFAULT '', model_raw TEXT DEFAULT '', device_type TEXT DEFAULT '',
        os TEXT DEFAULT '', os_version TEXT DEFAULT '', browser TEXT DEFAULT '', browser_version TEXT DEFAULT '',
        confidence TEXT DEFAULT '', hint TEXT DEFAULT '', info JSONB DEFAULT '{}',
        customer_id TEXT DEFAULT '', cart JSONB DEFAULT '[]', cart_total NUMERIC(12,2) DEFAULT 0,
        cart_updated TIMESTAMPTZ, pending_cmd TEXT DEFAULT ''
    )""")
    await ex("""
    CREATE TABLE IF NOT EXISTS t_sessions (
        sid TEXT PRIMARY KEY, vid TEXT NOT NULL,
        started_at TIMESTAMPTZ DEFAULT NOW(), last_seen TIMESTAMPTZ DEFAULT NOW(),
        page TEXT DEFAULT '', last_action TEXT DEFAULT '', events INTEGER DEFAULT 0,
        ip TEXT DEFAULT '', customer_id TEXT DEFAULT ''
    )""")
    await ex("""
    CREATE TABLE IF NOT EXISTS t_events (
        id BIGSERIAL PRIMARY KEY, ts TIMESTAMPTZ DEFAULT NOW(),
        vid TEXT NOT NULL, sid TEXT DEFAULT '', customer_id TEXT DEFAULT '',
        type TEXT NOT NULL, name TEXT DEFAULT '', page TEXT DEFAULT '', meta JSONB DEFAULT '{}'
    )""")
    for q in (
        "CREATE INDEX IF NOT EXISTS t_events_ts ON t_events (ts DESC)",
        "CREATE INDEX IF NOT EXISTS t_events_vid_ts ON t_events (vid, ts DESC)",
        "CREATE INDEX IF NOT EXISTS t_events_type_ts ON t_events (type, ts DESC)",
        "CREATE INDEX IF NOT EXISTS t_sessions_seen ON t_sessions (last_seen DESC)",
        "CREATE INDEX IF NOT EXISTS t_visitors_seen ON t_visitors (last_seen DESC)",
        "CREATE INDEX IF NOT EXISTS t_visitors_cust ON t_visitors (customer_id)",
    ):
        await ex(q)
    await cleanup()
    print("~ boss/tracking tables ready" + ("" if BOSS_PASS else " (BOSS_PASS не задан — /boss отключена)"))


_last_cleanup = 0.0


async def cleanup():
    """Удаляем старые события (по умолчанию старше 90 дней), чтобы база не пухла."""
    global _last_cleanup
    _last_cleanup = time.time()
    ex = _ctx["execute"]
    await ex("DELETE FROM t_events WHERE ts < NOW() - ($1::int * INTERVAL '1 day')", TRACK_DAYS)
    await ex("DELETE FROM t_sessions WHERE last_seen < NOW() - ($1::int * INTERVAL '1 day')", TRACK_DAYS)


# ── Помощники ────────────────────────────────────────────────────────────────
def _client_ip(request: Request):
    return (request.headers.get("x-forwarded-for", "") or (request.client.host if request.client else "")) \
        .split(",")[0].strip()[:64]


def _j(v, default=None):
    """JSONB из asyncpg приходит строкой."""
    if v is None:
        return default
    if isinstance(v, (list, dict)):
        return v
    try:
        return json.loads(v)
    except Exception:
        return default


def _val(v):
    if isinstance(v, datetime):
        return v.astimezone(timezone.utc).isoformat().replace("+00:00", "Z") if v.tzinfo else v.isoformat() + "Z"
    if isinstance(v, Decimal):
        return float(v)
    return v


def _rec(r, json_cols=()):
    d = {k: _val(v) for k, v in dict(r).items()}
    for c in json_cols:
        if c in d:
            d[c] = _j(d[c], [] if c in ("cart", "items") else {})
    return d


def _like(q):
    return "%" + re.sub(r"[%_\\]", lambda m: "\\" + m.group(0), q.strip()) + "%"


_rate = {}


def _rate_ok(key, limit, window):
    now = time.time()
    start, cnt = _rate.get(key, (now, 0))
    if now - start > window:
        start, cnt = now, 0
    cnt += 1
    _rate[key] = (start, cnt)
    if len(_rate) > 5000:
        for k in [k for k, (s, _) in _rate.items() if now - s > window]:
            _rate.pop(k, None)
    return cnt <= limit


async def _audit(action, entity, entity_id, detail):
    try:
        await _ctx["execute"]("INSERT INTO admin_log(action,entity,entity_id,detail) VALUES($1,$2,$3,$4)",
                              action, entity, str(entity_id), "[boss] " + detail)
    except Exception:
        pass


# ── Приём событий с сайта (публичный, без авторизации) ───────────────────────
class CollectIn(BaseModel):
    vid: str
    sid: str = ""
    info: Optional[dict] = None
    cart: Optional[list] = None
    ev: list = []


@router.post("/api/t/collect")
async def t_collect(b: CollectIn, request: Request):
    ip = _client_ip(request)
    if not _rate_ok("c:" + ip, 180, 60):
        return {"ok": True}
    if not _VID_RE.match(b.vid or ""):
        raise HTTPException(400, "bad vid")
    sid = (b.sid or "")[:64]
    ua = request.headers.get("user-agent", "")[:400]

    customer_id = ""
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        try:
            p = jwt.decode(auth[7:], _ctx["secret"], algorithms=["HS256"])
            if p.get("role") == "customer":
                customer_id = str(p.get("sub") or "")
        except Exception:
            pass

    info = b.info if isinstance(b.info, dict) else None
    if info is not None and len(json.dumps(info)) > 4000:
        info = None
    dev = devices.describe(ua, info or {})

    events = []
    for e in (b.ev or [])[:40]:
        if not isinstance(e, dict):
            continue
        t = str(e.get("t") or "")[:24]
        if not re.match(r"^[a-z_]{1,24}$", t) or t == "hb":
            continue
        meta = e.get("m") if isinstance(e.get("m"), dict) else {}
        mj = json.dumps(meta, ensure_ascii=False)
        if len(mj) > 1500:
            mj = "{}"
        try:
            dt = max(0, min(int(e.get("dt") or 0), 600000))
        except (TypeError, ValueError):
            dt = 0
        events.append((dt, b.vid, sid, customer_id, t, str(e.get("n") or "")[:200], str(e.get("p") or "")[:40], mj))

    pool = await _ctx["pool"]()
    async with pool.acquire(timeout=10) as conn:
        new_sess = False
        if sid:
            st = await conn.execute(
                "INSERT INTO t_sessions(sid,vid,ip,customer_id) VALUES($1,$2,$3,$4) ON CONFLICT (sid) DO NOTHING",
                sid, b.vid, ip, customer_id)
            new_sess = st.endswith(" 1")
        await conn.execute("""
            INSERT INTO t_visitors(vid, ip, ua, device_name, brand, model_raw, device_type, os, os_version,
                                   browser, browser_version, confidence, hint, info, customer_id)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)
            ON CONFLICT (vid) DO UPDATE SET
                last_seen = NOW(), ip = EXCLUDED.ip, ua = EXCLUDED.ua,
                visits = t_visitors.visits + $16::int,
                device_name = CASE WHEN $17::boolean THEN EXCLUDED.device_name ELSE t_visitors.device_name END,
                brand = CASE WHEN $17::boolean THEN EXCLUDED.brand ELSE t_visitors.brand END,
                model_raw = CASE WHEN $17::boolean THEN EXCLUDED.model_raw ELSE t_visitors.model_raw END,
                device_type = CASE WHEN $17::boolean THEN EXCLUDED.device_type ELSE t_visitors.device_type END,
                os = CASE WHEN $17::boolean THEN EXCLUDED.os ELSE t_visitors.os END,
                os_version = CASE WHEN $17::boolean THEN EXCLUDED.os_version ELSE t_visitors.os_version END,
                browser = CASE WHEN $17::boolean THEN EXCLUDED.browser ELSE t_visitors.browser END,
                browser_version = CASE WHEN $17::boolean THEN EXCLUDED.browser_version ELSE t_visitors.browser_version END,
                confidence = CASE WHEN $17::boolean THEN EXCLUDED.confidence ELSE t_visitors.confidence END,
                hint = CASE WHEN $17::boolean THEN EXCLUDED.hint ELSE t_visitors.hint END,
                info = CASE WHEN $17::boolean THEN EXCLUDED.info ELSE t_visitors.info END,
                customer_id = CASE WHEN EXCLUDED.customer_id <> '' THEN EXCLUDED.customer_id ELSE t_visitors.customer_id END
        """, b.vid, ip, ua, dev["device_name"], dev["brand"], dev["model_raw"], dev["device_type"], dev["os"],
            dev["os_version"], dev["browser"], dev["browser_version"], dev["confidence"], dev["hint"],
            json.dumps(info or {}, ensure_ascii=False), customer_id, 1 if new_sess else 0, info is not None)

        if b.cart is not None:
            items, total = [], 0.0
            for it in b.cart[:200]:
                if not isinstance(it, dict):
                    continue
                try:
                    price, qty = float(it.get("price") or 0), int(it.get("qty") or 0)
                except (TypeError, ValueError):
                    continue
                if qty <= 0:
                    continue
                total += price * qty
                items.append({"id": it.get("id"), "name": str(it.get("name") or "")[:120],
                              "sku": str(it.get("sku") or "")[:40], "price": price, "qty": qty})
            await conn.execute(
                "UPDATE t_visitors SET cart=$2::jsonb, cart_total=$3, cart_updated=NOW() WHERE vid=$1",
                b.vid, json.dumps(items, ensure_ascii=False), round(total, 2))

        if events:
            await conn.executemany(
                "INSERT INTO t_events(ts,vid,sid,customer_id,type,name,page,meta) "
                "VALUES(NOW() - ($1::int * INTERVAL '1 millisecond'),$2,$3,$4,$5,$6,$7,$8::jsonb)", events)

        if sid:
            last = next(((e[4], e[5]) for e in reversed(events) if e[4] != "hb"), None)
            page = next((e[5] for e in reversed(events) if e[4] == "view"), None)
            await conn.execute("""
                UPDATE t_sessions SET last_seen=NOW(), events = events + $2::int,
                    last_action = COALESCE($3::text, last_action), page = COALESCE($4::text, page),
                    customer_id = CASE WHEN $5::text <> '' THEN $5::text ELSE customer_id END
                WHERE sid=$1""", sid, len(events), (f"{last[0]}|{last[1]}" if last else None), page, customer_id)

        cmd_row = await conn.fetchrow("SELECT pending_cmd FROM t_visitors WHERE vid=$1", b.vid)
        cmd = (cmd_row["pending_cmd"] if cmd_row else "") or ""
        if cmd:
            await conn.execute("UPDATE t_visitors SET pending_cmd='' WHERE vid=$1", b.vid)

    if time.time() - _last_cleanup > 86400:
        try:
            await cleanup()
        except Exception:
            pass
    return {"ok": True, "cmd": cmd}


# ── Вход владельца ───────────────────────────────────────────────────────────
class BossLogin(BaseModel):
    username: str
    password: str


def _pw_fingerprint():
    return hashlib.sha256(("boss:" + BOSS_PASS).encode()).hexdigest()[:12]


@router.post("/api/boss/login")
async def boss_login(b: BossLogin, request: Request):
    if not BOSS_PASS:
        raise HTTPException(503, "Страница владельца отключена: задайте переменную BOSS_PASS в Render")
    ip = _client_ip(request)
    if not _rate_ok("l:" + ip, 8, 900):
        raise HTTPException(429, "Слишком много попыток. Подождите 15 минут.")
    ok_user = hmac.compare_digest(hashlib.sha256(b.username.encode()).digest(), hashlib.sha256(BOSS_USER.encode()).digest())
    ok_pass = hmac.compare_digest(hashlib.sha256(b.password.encode()).digest(), hashlib.sha256(BOSS_PASS.encode()).digest())
    if not (ok_user and ok_pass):
        await _audit("boss_login_fail", "boss", ip, "неверный логин или пароль")
        raise HTTPException(401, "Неверный логин или пароль")
    token = jwt.encode({"sub": "boss", "role": "boss", "v": _pw_fingerprint(),
                        "exp": datetime.utcnow() + timedelta(hours=12)}, _ctx["secret"], algorithm="HS256")
    await _audit("boss_login", "boss", ip, "вход владельца")
    return {"token": token}


def require_boss(creds: HTTPAuthorizationCredentials = Depends(_bearer)):
    if not BOSS_PASS:
        raise HTTPException(503, "Страница владельца отключена")
    if not creds:
        raise HTTPException(401, "Нужен вход")
    try:
        p = jwt.decode(creds.credentials, _ctx["secret"], algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(401, "Сессия истекла")
    if p.get("role") != "boss" or p.get("v") != _pw_fingerprint():
        raise HTTPException(403, "Нет доступа")
    return p


# ── Обзор ────────────────────────────────────────────────────────────────────
@router.get("/api/boss/overview")
async def boss_overview(_=Depends(require_boss)):
    f, fr = _ctx["fetch"], _ctx["fetchrow"]
    r = await fr("""
        SELECT
         (SELECT COUNT(*) FROM t_sessions WHERE last_seen > NOW() - INTERVAL '90 seconds') AS online,
         (SELECT COUNT(*) FROM t_visitors WHERE last_seen > NOW() - INTERVAL '24 hours') AS visitors_24h,
         (SELECT COUNT(*) FROM t_visitors WHERE first_seen > NOW() - INTERVAL '24 hours') AS new_24h,
         (SELECT COUNT(*) FROM t_events WHERE ts > NOW() - INTERVAL '24 hours' AND type <> 'hb') AS events_24h,
         (SELECT COUNT(*) FROM t_visitors) AS visitors_total,
         (SELECT COUNT(*) FROM customers) AS customers_total,
         (SELECT COUNT(*) FROM customers WHERE created_at > NOW() - INTERVAL '7 days') AS customers_7d,
         (SELECT COUNT(*) FROM orders) AS orders_total,
         (SELECT COALESCE(SUM(total),0) FROM orders) AS orders_sum,
         (SELECT COUNT(*) FROM t_visitors WHERE jsonb_array_length(cart) > 0) AS live_carts,
         (SELECT COALESCE(SUM(cart_total),0) FROM t_visitors WHERE jsonb_array_length(cart) > 0) AS live_carts_sum,
         (SELECT COUNT(*) FROM t_events WHERE type LIKE 'download%' AND ts > NOW() - INTERVAL '7 days') AS downloads_7d
    """)
    hours = await f("""
        SELECT date_trunc('hour', ts) AS h, COUNT(DISTINCT vid) AS n
        FROM t_events WHERE ts > NOW() - INTERVAL '24 hours' GROUP BY 1 ORDER BY 1""")
    days = await f("""
        SELECT date_trunc('day', ts) AS d, COUNT(DISTINCT vid) AS n
        FROM t_events WHERE ts > NOW() - INTERVAL '14 days' GROUP BY 1 ORDER BY 1""")
    return {"totals": _rec(r), "hours": [_rec(x) for x in hours], "days": [_rec(x) for x in days]}


# ── Сейчас на сайте + лента ──────────────────────────────────────────────────
@router.get("/api/boss/live")
async def boss_live(_=Depends(require_boss)):
    rows = await _ctx["fetch"]("""
        SELECT s.sid, s.vid, s.page, s.last_action, s.last_seen, s.started_at, s.events,
               v.device_name, v.device_type, v.os, v.os_version, v.browser, v.browser_version, v.ip,
               v.confidence, v.hint, v.cart_total, jsonb_array_length(v.cart) AS cart_items,
               c.first_name, c.last_name, c.email, c.phone
        FROM t_sessions s
        JOIN t_visitors v ON v.vid = s.vid
        LEFT JOIN customers c ON c.id = NULLIF(s.customer_id, '')
        WHERE s.last_seen > NOW() - INTERVAL '90 seconds'
        ORDER BY s.last_seen DESC LIMIT 100""")
    return {"online": [_rec(r) for r in rows]}


@router.get("/api/boss/feed")
async def boss_feed(since: int = 0, type: str = "", limit: int = 80, _=Depends(require_boss)):
    limit = max(1, min(limit, 300))
    where, args = ["e.type <> 'hb'", "e.id > $1"], [since]
    if type:
        args.append(type + "%")
        where.append(f"e.type LIKE ${len(args)}")
    args.append(limit)
    rows = await _ctx["fetch"](f"""
        SELECT e.id, e.ts, e.vid, e.type, e.name, e.page, e.meta, v.device_name,
               c.first_name, c.last_name
        FROM t_events e
        LEFT JOIN t_visitors v ON v.vid = e.vid
        LEFT JOIN customers c ON c.id = NULLIF(e.customer_id, '')
        WHERE {' AND '.join(where)}
        ORDER BY e.id DESC LIMIT ${len(args)}""", *args)
    return {"events": [_rec(r, ("meta",)) for r in rows]}


# ── Посетители ───────────────────────────────────────────────────────────────
_VIS_COLS = """v.vid, v.first_seen, v.last_seen, v.visits, v.ip, v.device_name, v.brand, v.model_raw, v.device_type,
               v.os, v.os_version, v.browser, v.browser_version, v.confidence, v.hint, v.customer_id,
               v.cart_total, jsonb_array_length(v.cart) AS cart_items,
               c.first_name, c.last_name, c.email, c.phone"""


@router.get("/api/boss/visitors")
async def boss_visitors(q: str = "", kind: str = "", limit: int = 50, offset: int = 0, _=Depends(require_boss)):
    limit, offset = max(1, min(limit, 200)), max(0, offset)
    where, args = [], []
    if q.strip():
        args.append(_like(q))
        n = len(args)
        where.append(f"""(v.device_name ILIKE ${n} OR v.ip ILIKE ${n} OR v.vid ILIKE ${n} OR v.browser ILIKE ${n}
                         OR v.os ILIKE ${n} OR c.email ILIKE ${n} OR c.first_name ILIKE ${n}
                         OR c.last_name ILIKE ${n} OR c.phone ILIKE ${n})""")
    if kind == "registered":
        where.append("v.customer_id <> ''")
    elif kind == "guests":
        where.append("v.customer_id = ''")
    elif kind in ("mobile", "tablet", "desktop"):
        args.append(kind)
        where.append(f"v.device_type = ${len(args)}")
    w = ("WHERE " + " AND ".join(where)) if where else ""
    total = await _ctx["fetchrow"](
        f"SELECT COUNT(*) AS n FROM t_visitors v LEFT JOIN customers c ON c.id = NULLIF(v.customer_id,'') {w}", *args)
    args2 = args + [limit, offset]
    rows = await _ctx["fetch"](f"""
        SELECT {_VIS_COLS} FROM t_visitors v LEFT JOIN customers c ON c.id = NULLIF(v.customer_id,'')
        {w} ORDER BY v.last_seen DESC LIMIT ${len(args2) - 1} OFFSET ${len(args2)}""", *args2)
    return {"total": total["n"], "items": [_rec(r) for r in rows]}


@router.get("/api/boss/visitors/{vid}")
async def boss_visitor(vid: str, _=Depends(require_boss)):
    f, fr = _ctx["fetch"], _ctx["fetchrow"]
    v = await fr("SELECT * FROM t_visitors WHERE vid=$1", vid)
    if not v:
        raise HTTPException(404, "Посетитель не найден")
    vis = _rec(v, ("info", "cart"))
    customer = None
    if vis.get("customer_id"):
        c = await fr("""SELECT id, first_name, last_name, email, phone, address, created_at
                        FROM customers WHERE id=$1""", vis["customer_id"])
        customer = _rec(c) if c else None
    sessions = await f("SELECT * FROM t_sessions WHERE vid=$1 ORDER BY started_at DESC LIMIT 30", vid)
    events = await f("""SELECT id, ts, sid, type, name, page, meta FROM t_events
                        WHERE vid=$1 AND type <> 'hb' ORDER BY id DESC LIMIT 400""", vid)
    counts = await f("""SELECT type, COUNT(*) AS n FROM t_events WHERE vid=$1 AND type <> 'hb'
                        GROUP BY type ORDER BY n DESC""", vid)
    orders = []
    if vis.get("customer_id"):
        orders = await f("""SELECT code, items, total, comment, store_name, contact, created_at
                            FROM orders WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 50""", vis["customer_id"])
    return {"visitor": vis, "customer": customer, "sessions": [_rec(s) for s in sessions],
            "events": [_rec(e, ("meta",)) for e in events], "counts": [_rec(c) for c in counts],
            "orders": [_rec(o, ("items",)) for o in orders]}


# ── Статистика ───────────────────────────────────────────────────────────────
@router.get("/api/boss/stats")
async def boss_stats(days: int = 7, _=Depends(require_boss)):
    days = max(1, min(days, 90))
    f = _ctx["fetch"]

    async def top(typ, n=15):
        rows = await f("""SELECT name, COUNT(*) AS n, COUNT(DISTINCT vid) AS users FROM t_events
                          WHERE type=$1 AND name <> '' AND ts > NOW() - ($2::int * INTERVAL '1 day')
                          GROUP BY name ORDER BY n DESC LIMIT $3""", typ, days, n)
        return [_rec(r) for r in rows]

    async def dist(col):
        rows = await f(f"""SELECT {col} AS name, COUNT(*) AS n FROM t_visitors
                           WHERE last_seen > NOW() - ($1::int * INTERVAL '1 day') AND {col} <> ''
                           GROUP BY {col} ORDER BY n DESC LIMIT 15""", days)
        return [_rec(r) for r in rows]

    return {"days": days, "clicks": await top("click", 25), "products": await top("product"),
            "searches": await top("search"), "categories": await top("category"), "views": await top("view"),
            "cart_add": await top("cart_add"), "devices": await dist("device_name"), "browsers": await dist("browser"),
            "os": await dist("os"), "types": await dist("device_type")}


@router.get("/api/boss/downloads")
async def boss_downloads(limit: int = 100, _=Depends(require_boss)):
    rows = await _ctx["fetch"]("""
        SELECT e.id, e.ts, e.type, e.name, e.meta, e.vid, v.device_name, c.first_name, c.last_name, c.email
        FROM t_events e LEFT JOIN t_visitors v ON v.vid = e.vid
        LEFT JOIN customers c ON c.id = NULLIF(e.customer_id,'')
        WHERE e.type LIKE 'download%' OR e.type LIKE 'share%'
        ORDER BY e.id DESC LIMIT $1""", max(1, min(limit, 500)))
    staff = await _ctx["fetch"]("""SELECT created_at AS ts, detail FROM admin_log WHERE action='export_pdf'
                                   ORDER BY id DESC LIMIT 30""")
    return {"items": [_rec(r, ("meta",)) for r in rows], "staff_pdf": [_rec(r) for r in staff]}


# ── Корзины ──────────────────────────────────────────────────────────────────
@router.get("/api/boss/carts/live")
async def boss_carts_live(_=Depends(require_boss)):
    rows = await _ctx["fetch"]("""
        SELECT v.vid, v.device_name, v.cart, v.cart_total, v.cart_updated, v.last_seen, v.customer_id,
               c.first_name, c.last_name, c.email, c.phone
        FROM t_visitors v LEFT JOIN customers c ON c.id = NULLIF(v.customer_id,'')
        WHERE jsonb_array_length(v.cart) > 0
        ORDER BY v.cart_updated DESC NULLS LAST LIMIT 300""")
    return {"items": [_rec(r, ("cart",)) for r in rows]}


@router.post("/api/boss/carts/live/{vid}/clear")
async def boss_cart_clear(vid: str, _=Depends(require_boss)):
    """Очищаем корзину у человека: у него она исчезнет при следующей связи с сервером (до ~30 сек)."""
    st = await _ctx["execute"](
        "UPDATE t_visitors SET pending_cmd='clear_cart', cart='[]'::jsonb, cart_total=0 WHERE vid=$1", vid)
    if st.endswith(" 0"):
        raise HTTPException(404, "Посетитель не найден")
    await _audit("clear_live_cart", "visitor", vid, "очищена корзина посетителя")
    return {"ok": True}


@router.post("/api/boss/carts/live/clear-all")
async def boss_cart_clear_all(_=Depends(require_boss)):
    st = await _ctx["execute"](
        "UPDATE t_visitors SET pending_cmd='clear_cart', cart='[]'::jsonb, cart_total=0 WHERE jsonb_array_length(cart) > 0")
    n = int(st.split()[-1]) if st.split()[-1].isdigit() else 0
    await _audit("clear_live_cart", "visitor", "*", f"очищены корзины у всех ({n})")
    return {"ok": True, "cleared": n}


@router.get("/api/boss/orders")
async def boss_orders(q: str = "", limit: int = 50, offset: int = 0, _=Depends(require_boss)):
    limit, offset = max(1, min(limit, 200)), max(0, offset)
    where, args = "", []
    if q.strip():
        args.append(_like(q))
        where = """WHERE (o.code ILIKE $1 OR o.store_name ILIKE $1 OR o.contact ILIKE $1 OR o.comment ILIKE $1
                   OR c.email ILIKE $1 OR c.first_name ILIKE $1 OR c.last_name ILIKE $1 OR c.phone ILIKE $1)"""
    total = await _ctx["fetchrow"](
        f"SELECT COUNT(*) AS n FROM orders o LEFT JOIN customers c ON c.id=o.customer_id {where}", *args)
    args2 = args + [limit, offset]
    rows = await _ctx["fetch"](f"""
        SELECT o.code, o.items, o.total, o.comment, o.store_name, o.contact, o.created_at, o.customer_id,
               c.first_name, c.last_name, c.email, c.phone
        FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
        {where} ORDER BY o.created_at DESC LIMIT ${len(args2) - 1} OFFSET ${len(args2)}""", *args2)
    return {"total": total["n"], "items": [_rec(r, ("items",)) for r in rows]}


class OrdersDelete(BaseModel):
    codes: List[str] = []
    older_than_days: Optional[int] = None


@router.post("/api/boss/orders/delete")
async def boss_orders_delete(b: OrdersDelete, _=Depends(require_boss)):
    ex = _ctx["execute"]
    if b.codes:
        st = await ex("DELETE FROM orders WHERE code = ANY($1::text[])", b.codes[:500])
        detail = f"удалено корзин/заказов по коду: {len(b.codes)}"
    elif b.older_than_days is not None and b.older_than_days >= 0:
        st = await ex("DELETE FROM orders WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')", b.older_than_days)
        detail = f"удалены корзины старше {b.older_than_days} дн."
    else:
        raise HTTPException(400, "Укажите коды или возраст")
    n = int(st.split()[-1]) if st.split()[-1].isdigit() else 0
    await _audit("delete_orders", "order", "*", f"{detail} (итого {n})")
    return {"deleted": n}


# ── Пользователи (вся база) ──────────────────────────────────────────────────
_CUST_SQL = """
    SELECT c.id, c.first_name, c.last_name, c.email, c.phone, c.address, c.created_at,
      (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) AS orders_count,
      (SELECT COALESCE(SUM(o.total),0) FROM orders o WHERE o.customer_id = c.id) AS orders_sum,
      (SELECT MAX(v.last_seen) FROM t_visitors v WHERE v.customer_id = c.id) AS last_seen,
      (SELECT COUNT(*) FROM t_visitors v WHERE v.customer_id = c.id) AS devices_count,
      (SELECT string_agg(DISTINCT v.device_name, ', ') FROM t_visitors v WHERE v.customer_id = c.id) AS device_names,
      (SELECT COUNT(*) FROM t_events e WHERE e.customer_id = c.id AND e.type <> 'hb') AS events_count
    FROM customers c"""


@router.get("/api/boss/customers")
async def boss_customers(q: str = "", limit: int = 50, offset: int = 0, _=Depends(require_boss)):
    limit, offset = max(1, min(limit, 200)), max(0, offset)
    where, args = "", []
    if q.strip():
        args.append(_like(q))
        where = " WHERE (c.email ILIKE $1 OR c.first_name ILIKE $1 OR c.last_name ILIKE $1 OR c.phone ILIKE $1 OR c.address ILIKE $1)"
    total = await _ctx["fetchrow"](f"SELECT COUNT(*) AS n FROM customers c{where}", *args)
    args2 = args + [limit, offset]
    rows = await _ctx["fetch"](
        f"{_CUST_SQL}{where} ORDER BY c.created_at DESC LIMIT ${len(args2) - 1} OFFSET ${len(args2)}", *args2)
    return {"total": total["n"], "items": [_rec(r) for r in rows]}


@router.get("/api/boss/customers/{cid}")
async def boss_customer(cid: str, _=Depends(require_boss)):
    f, fr = _ctx["fetch"], _ctx["fetchrow"]
    c = await fr(f"{_CUST_SQL} WHERE c.id=$1", cid)
    if not c:
        raise HTTPException(404, "Пользователь не найден")
    vis = await f(f"SELECT {_VIS_COLS} FROM t_visitors v LEFT JOIN customers c ON c.id = NULLIF(v.customer_id,'') "
                  "WHERE v.customer_id=$1 ORDER BY v.last_seen DESC", cid)
    orders = await f("""SELECT code, items, total, comment, store_name, contact, created_at FROM orders
                        WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100""", cid)
    events = await f("""SELECT id, ts, type, name, page, meta FROM t_events
                        WHERE customer_id=$1 AND type <> 'hb' ORDER BY id DESC LIMIT 300""", cid)
    return {"customer": _rec(c), "devices": [_rec(v) for v in vis],
            "orders": [_rec(o, ("items",)) for o in orders], "events": [_rec(e, ("meta",)) for e in events]}


@router.delete("/api/boss/customers/{cid}")
async def boss_customer_delete(cid: str, _=Depends(require_boss)):
    row = await _ctx["fetchrow"]("SELECT email FROM customers WHERE id=$1", cid)
    if not row:
        raise HTTPException(404, "Пользователь не найден")
    await _ctx["execute"]("UPDATE t_visitors SET customer_id='' WHERE customer_id=$1", cid)
    await _ctx["execute"]("DELETE FROM customers WHERE id=$1", cid)
    await _audit("delete_customer", "customer", cid, f"удалён пользователь {row['email']}")
    return {"ok": True}


# ── Выгрузки ─────────────────────────────────────────────────────────────────
def _flat(v):
    if isinstance(v, (dict, list)):
        return json.dumps(v, ensure_ascii=False)
    return "" if v is None else v


def _file(rows, name, fmt):
    stamp = datetime.utcnow().strftime("%Y-%m-%d")
    if fmt == "json":
        body = json.dumps(rows, ensure_ascii=False, indent=1).encode("utf-8")
        return Response(body, media_type="application/json",
                        headers={"Content-Disposition": f'attachment; filename="{name}-{stamp}.json"'})
    buf = io.StringIO()
    cols = list(rows[0].keys()) if rows else []
    w = csv.writer(buf, delimiter=";")
    w.writerow(cols)
    for r in rows:
        w.writerow([_flat(r.get(c)) for c in cols])
    body = ("\ufeff" + buf.getvalue()).encode("utf-8")      # BOM, чтобы Excel не ломал кириллицу
    return Response(body, media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{name}-{stamp}.csv"'})


@router.get("/api/boss/export-link")
async def boss_export_link(kind: str, fmt: str = "csv", days: int = 30, _=Depends(require_boss)):
    """Короткоживущая ссылка на файл — скачивается обычным способом (надёжно на iPhone, без blob:)."""
    tok = jwt.encode({"sub": "boss-dl", "kind": kind, "v": _pw_fingerprint(),
                      "exp": datetime.utcnow() + timedelta(minutes=3)}, _ctx["secret"], algorithm="HS256")
    return {"url": f"/api/boss/export/{kind}?fmt={'json' if fmt == 'json' else 'csv'}&days={max(1, min(days, 365))}&t={tok}"}


@router.get("/api/boss/export/{kind}")
async def boss_export(kind: str, fmt: str = "csv", days: int = 30, t: str = "",
                      creds: HTTPAuthorizationCredentials = Depends(_bearer)):
    ok = False
    if t:
        try:
            pl = jwt.decode(t, _ctx["secret"], algorithms=["HS256"])
            ok = pl.get("sub") == "boss-dl" and pl.get("kind") == kind and pl.get("v") == _pw_fingerprint()
        except jwt.PyJWTError:
            ok = False
    if not ok:
        require_boss(creds)
    f = _ctx["fetch"]
    fmt = "json" if fmt == "json" else "csv"
    if kind == "customers":
        rows = await f(f"{_CUST_SQL} ORDER BY c.created_at DESC")            # без password_hash
    elif kind == "visitors":
        rows = await f("""SELECT v.vid, v.first_seen, v.last_seen, v.visits, v.ip, v.device_name, v.brand, v.model_raw,
                          v.device_type, v.os, v.os_version, v.browser, v.browser_version, v.confidence, v.hint,
                          v.customer_id, c.email, c.first_name, c.last_name, c.phone, v.cart_total, v.cart, v.info, v.ua
                          FROM t_visitors v LEFT JOIN customers c ON c.id = NULLIF(v.customer_id,'')
                          ORDER BY v.last_seen DESC LIMIT 100000""")
    elif kind == "events":
        rows = await f("""SELECT e.id, e.ts, e.vid, v.device_name, e.customer_id, c.email, e.type, e.name, e.page, e.meta
                          FROM t_events e LEFT JOIN t_visitors v ON v.vid = e.vid
                          LEFT JOIN customers c ON c.id = NULLIF(e.customer_id,'')
                          WHERE e.type <> 'hb' AND e.ts > NOW() - ($1::int * INTERVAL '1 day')
                          ORDER BY e.id DESC LIMIT 200000""", max(1, min(days, 365)))
    elif kind == "orders":
        rows = await f("""SELECT o.code, o.created_at, o.total, o.store_name, o.contact, o.comment, o.items,
                          o.customer_id, c.email, c.first_name, c.last_name, c.phone
                          FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
                          ORDER BY o.created_at DESC LIMIT 100000""")
    else:
        raise HTTPException(404, "Неизвестная выгрузка")
    data = [_rec(r, ("meta", "items", "cart", "info")) for r in rows]
    await _audit("export", kind, "*", f"выгрузка {kind} ({fmt}), строк: {len(data)}")
    return _file(data, f"happy-{kind}", fmt)
