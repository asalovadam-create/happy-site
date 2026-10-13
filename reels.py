"""
Happy TV — короткие вертикальные видео для оптовиков (как Reels / TikTok).

• Лента для покупателей: /api/reels/feed (порядок собирается алгоритмом ниже)
• Просмотры: 1 аккаунт = 1 просмотр (гости — по устройству); сотрудники не считаются
• Лайки и комментарии — только для вошедших пользователей
• Админка: загрузка на диск сервера (сжатие до 720×1280 H.264 через ffmpeg), статистика, модерация
"""
import asyncio
import functools
import hashlib
import json
import math
import random
import re
import os
import time
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Optional

from fastapi import Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

import media

FRESH_DAYS = 7                 # «новое» — загружено за последние 7 дней
FEED_LIMIT = 60
MAX_DURATION = 180             # секунд
MAX_BYTES = 100 * 1024 * 1024  # максимальный размер одного видео


_VID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


# ── Алгоритм ленты (чистая функция — легко проверять) ────────────────────────
def order_feed(rows, seen, now=None, rng=None):
    """
    rows — список dict с ключами id, created_at (datetime с tz).
    seen — множество id роликов, которые зритель уже смотрел.

    1) Первым идёт СЛУЧАЙНОЕ новое видео (≤ 7 дней), которое зритель ещё не видел.
       Если все новые уже просмотрены — первым идёт любое случайное из новых;
       если новых нет — любое случайное.
    2) Остальные — случайный порядок с «весами»: новые и ещё не просмотренные
       встречаются чаще, уже просмотренные — реже (но могут попасться).
    """
    rng = rng or random
    now = now or datetime.now(timezone.utc)
    if not rows:
        return []
    border = now - timedelta(days=FRESH_DAYS)

    def fresh(r):
        c = r["created_at"]
        if c.tzinfo is None:
            c = c.replace(tzinfo=timezone.utc)
        return c >= border

    fresh_unseen = [r for r in rows if fresh(r) and r["id"] not in seen]
    fresh_all = [r for r in rows if fresh(r)]
    unseen = [r for r in rows if r["id"] not in seen]
    if fresh_unseen:
        first = rng.choice(fresh_unseen)
    elif fresh_all:
        first = rng.choice(fresh_all)
    elif unseen:
        first = rng.choice(unseen)
    else:
        first = rng.choice(rows)

    def weight(r):
        w = 1.0
        if r["id"] not in seen:
            w *= 3.0
        if fresh(r):
            w *= 2.0
        return w

    rest = [r for r in rows if r["id"] != first["id"]]
    # взвешенное случайное перемешивание (Efraimidis–Spirakis)
    rest.sort(key=lambda r: rng.random() ** (1.0 / weight(r)), reverse=True)
    return [first] + rest


# ── Подключение к приложению ─────────────────────────────────────────────────
class ReelPatch(BaseModel):
    title: Optional[str] = None
    caption: Optional[str] = None
    is_published: Optional[bool] = None


class ViewIn(BaseModel):
    vid: str = ""


class CommentIn(BaseModel):
    body: str


def _val(v):
    if isinstance(v, datetime):
        return (v.astimezone(timezone.utc).isoformat().replace("+00:00", "Z") if v.tzinfo else v.isoformat() + "Z")
    if isinstance(v, Decimal):
        return float(v)
    return v


def _rec(r):
    return {k: _val(v) for k, v in dict(r).items()}


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


def register(app, db_fetch, db_fetchrow, db_execute, require_admin, get_current_user):

    def viewer_of(user, vid):
        """Ключ зрителя: аккаунт покупателя или (для гостей) устройство. Сотрудники — None (не считаем)."""
        if user and user.get("role") == "customer" and user.get("sub"):
            return "c:" + str(user["sub"])
        if user and user.get("role") == "admin":
            return None
        if vid and _VID_RE.match(vid):
            return "v:" + vid
        return None

    def customer_id(user):
        return str(user["sub"]) if user and user.get("role") == "customer" and user.get("sub") else None

    # ── таблицы ──
    async def create_tables():
        await db_execute("""
        CREATE TABLE IF NOT EXISTS reels (
            id SERIAL PRIMARY KEY, title TEXT DEFAULT '', caption TEXT DEFAULT '',
            public_id TEXT NOT NULL, video_url TEXT NOT NULL, poster_url TEXT DEFAULT '',
            duration NUMERIC(8,2) DEFAULT 0, width INTEGER DEFAULT 0, height INTEGER DEFAULT 0,
            bytes BIGINT DEFAULT 0, is_published BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW()
        )""")
        await db_execute("""
        CREATE TABLE IF NOT EXISTS reel_views (
            reel_id INTEGER NOT NULL REFERENCES reels(id) ON DELETE CASCADE, viewer TEXT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (reel_id, viewer)
        )""")
        await db_execute("""
        CREATE TABLE IF NOT EXISTS reel_likes (
            reel_id INTEGER NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
            customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (reel_id, customer_id)
        )""")
        await db_execute("""
        CREATE TABLE IF NOT EXISTS reel_comments (
            id SERIAL PRIMARY KEY, reel_id INTEGER NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
            customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
            author TEXT DEFAULT '', body TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW()
        )""")
        await db_execute("ALTER TABLE reels ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'ready'")
        await db_execute("ALTER TABLE reels ADD COLUMN IF NOT EXISTS trans TEXT DEFAULT ''")
        await db_execute("CREATE INDEX IF NOT EXISTS reels_created ON reels (created_at DESC)")
        await db_execute("CREATE INDEX IF NOT EXISTS reel_comments_reel ON reel_comments (reel_id, id DESC)")
        # Обработка идёт внутри этого процесса: если сервер перезапускали посреди сжатия, ролик «завис»
        await db_execute("UPDATE reels SET status='failed' WHERE status='processing'")
        print("~ reels (Happy TV) tables ready")

    app.state.reels_create_tables = create_tables

    # ── для покупателей ──────────────────────────────────────────────────────
    @app.get("/api/reels/feed")
    async def reels_feed(vid: str = "", user=Depends(get_current_user)):
        rows = await db_fetch("""
            SELECT r.id, r.title, r.caption, r.video_url, r.poster_url, r.duration, r.width, r.height, r.created_at,
              (SELECT COUNT(*) FROM reel_views v WHERE v.reel_id = r.id) AS views,
              (SELECT COUNT(*) FROM reel_likes l WHERE l.reel_id = r.id) AS likes,
              (SELECT COUNT(*) FROM reel_comments c WHERE c.reel_id = r.id) AS comments
            FROM reels r WHERE r.is_published AND r.status = 'ready' ORDER BY r.created_at DESC LIMIT 300""")
        items = [dict(r) for r in rows]
        viewer, cid = viewer_of(user, vid), customer_id(user)
        is_admin = bool(user and user.get("role") == "admin")
        seen, liked = set(), set()
        if viewer:
            sv = await db_fetch("SELECT reel_id FROM reel_views WHERE viewer = $1", viewer)
            seen = {r["reel_id"] for r in sv}
        if cid:
            lk = await db_fetch("SELECT reel_id FROM reel_likes WHERE customer_id = $1", cid)
            liked = {r["reel_id"] for r in lk}
        now = datetime.now(timezone.utc)
        border = now - timedelta(days=FRESH_DAYS)
        ordered = order_feed(items, seen, now)[:FEED_LIMIT]
        out = []
        for r in ordered:
            d = _rec(r)
            c = r["created_at"] if r["created_at"].tzinfo else r["created_at"].replace(tzinfo=timezone.utc)
            d["is_new"] = c >= border
            d["seen"] = r["id"] in seen
            d["liked"] = r["id"] in liked
            if not is_admin:
                d.pop("views", None)           # счётчик просмотров видит только администратор
            out.append(d)
        return {"items": out, "logged_in": bool(cid)}

    @app.post("/api/reels/{reel_id}/view")
    async def reel_view(reel_id: int, b: ViewIn, user=Depends(get_current_user)):
        if user and user.get("role") == "admin":          # просмотры сотрудников не считаем
            row = await db_fetchrow("SELECT COUNT(*) AS n FROM reel_views WHERE reel_id = $1", reel_id)
            return {"counted": False, "views": row["n"]}
        viewer = viewer_of(user, b.vid)
        if not viewer:
            return {"counted": False}
        st = await db_execute(
            "INSERT INTO reel_views(reel_id, viewer) SELECT $1::int, $2::text "
            "WHERE EXISTS (SELECT 1 FROM reels WHERE id = $1::int AND is_published) ON CONFLICT DO NOTHING", reel_id, viewer)
        return {"counted": st.endswith(" 1")}            # покупателям количество просмотров не показываем

    @app.post("/api/reels/{reel_id}/like")
    async def reel_like(reel_id: int, user=Depends(get_current_user)):
        cid = customer_id(user)
        if not cid:
            raise HTTPException(401, "Войдите в аккаунт, чтобы ставить лайки")
        if not await db_fetchrow("SELECT 1 FROM reels WHERE id=$1 AND is_published", reel_id):
            raise HTTPException(404, "Видео не найдено")
        st = await db_execute("DELETE FROM reel_likes WHERE reel_id=$1 AND customer_id=$2", reel_id, cid)
        liked = st.endswith(" 0")
        if liked:
            await db_execute("INSERT INTO reel_likes(reel_id, customer_id) VALUES($1,$2) ON CONFLICT DO NOTHING", reel_id, cid)
        row = await db_fetchrow("SELECT COUNT(*) AS n FROM reel_likes WHERE reel_id=$1", reel_id)
        return {"liked": liked, "likes": row["n"]}

    @app.get("/api/reels/{reel_id}/comments")
    async def reel_comments(reel_id: int, user=Depends(get_current_user)):
        cid = customer_id(user)
        rows = await db_fetch(
            "SELECT id, author, body, created_at, customer_id FROM reel_comments WHERE reel_id=$1 ORDER BY id DESC LIMIT 100",
            reel_id)
        return {"items": [{"id": r["id"], "author": r["author"] or "Покупатель", "body": r["body"],
                           "created_at": _val(r["created_at"]), "mine": bool(cid and r["customer_id"] == cid)} for r in rows]}

    @app.post("/api/reels/{reel_id}/comments")
    async def reel_comment_add(reel_id: int, b: CommentIn, user=Depends(get_current_user)):
        cid = customer_id(user)
        if not cid:
            raise HTTPException(401, "Войдите в аккаунт, чтобы комментировать")
        body = " ".join((b.body or "").split())[:300]
        if len(body) < 1:
            raise HTTPException(400, "Пустой комментарий")
        if not _rate_ok("cm:" + cid, 6, 60):
            raise HTTPException(429, "Слишком часто. Подождите минуту.")
        if not await db_fetchrow("SELECT 1 FROM reels WHERE id=$1 AND is_published", reel_id):
            raise HTTPException(404, "Видео не найдено")
        c = await db_fetchrow("SELECT first_name, last_name FROM customers WHERE id=$1", cid)
        name = (c["first_name"] or "").strip() if c else ""
        last = (c["last_name"] or "").strip() if c else ""
        author = (name + (" " + last[0] + "." if last else "")).strip() or "Покупатель"
        row = await db_fetchrow(
            "INSERT INTO reel_comments(reel_id, customer_id, author, body) VALUES($1,$2,$3,$4) RETURNING id, created_at",
            reel_id, cid, author, body)
        cnt = await db_fetchrow("SELECT COUNT(*) AS n FROM reel_comments WHERE reel_id=$1", reel_id)
        return {"item": {"id": row["id"], "author": author, "body": body, "created_at": _val(row["created_at"]), "mine": True},
                "comments": cnt["n"]}

    @app.delete("/api/reels/comments/{comment_id}")
    async def reel_comment_delete_own(comment_id: int, user=Depends(get_current_user)):
        cid = customer_id(user)
        if not cid:
            raise HTTPException(401, "Войдите в аккаунт")
        st = await db_execute("DELETE FROM reel_comments WHERE id=$1 AND customer_id=$2", comment_id, cid)
        if st.endswith(" 0"):
            raise HTTPException(404, "Комментарий не найден")
        return {"ok": True}

    # ── админка ──────────────────────────────────────────────────────────────
    _tasks = set()          # ссылки на фоновые задачи (чтобы их не убрал сборщик мусора)

    async def _process(reel_id, vid, src, width, height):
        """Фон: сжатие до 720×1280 и постер. Сайт при этом не тормозит."""
        loop = asyncio.get_event_loop()
        dst = os.path.join(media.REELS_DIR, f"{vid}.mp4")
        poster = os.path.join(media.REELS_DIR, f"{vid}.jpg")
        try:
            if media.have_ffmpeg():
                ok = await loop.run_in_executor(None, media.process_video, src, dst, poster, width, height)
            else:
                os.replace(src, dst)        # ffmpeg не установлен — кладём видео как есть
                ok = True
            if ok:
                poster_url = f"{media.MEDIA_URL}/reels/{vid}.jpg" if os.path.isfile(poster) else ""
                await db_execute("UPDATE reels SET status='ready', bytes=$2, poster_url=$3 WHERE id=$1",
                                 reel_id, os.path.getsize(dst), poster_url)
            else:
                await db_execute("UPDATE reels SET status='failed' WHERE id=$1", reel_id)
        except Exception as e:
            print(f"[reels] обработка не удалась: {e.__class__.__name__}: {e}")
            try:
                await db_execute("UPDATE reels SET status='failed' WHERE id=$1", reel_id)
            except Exception:
                pass
        finally:
            try:
                os.remove(src)
            except OSError:
                pass

    @app.post("/api/admin/reels/upload")
    async def reels_upload(file: UploadFile = File(...), title: str = Form(""), caption: str = Form(""),
                           _=Depends(require_admin)):
        vid = uuid.uuid4().hex[:16]
        src = os.path.join(media.REELS_DIR, f"{vid}.src")
        size = 0
        try:
            with open(src, "wb") as out:
                while True:
                    chunk = await file.read(1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > MAX_BYTES:
                        raise HTTPException(400, f"Файл больше {MAX_BYTES // 1048576} МБ")
                    out.write(chunk)
        except HTTPException:
            media.delete_reel_files(vid)
            raise
        except Exception:
            media.delete_reel_files(vid)
            raise HTTPException(500, "Не удалось сохранить файл")
        if size == 0:
            media.delete_reel_files(vid)
            raise HTTPException(400, "Пустой файл")
        loop = asyncio.get_event_loop()
        duration, width, height = await loop.run_in_executor(None, media.probe_video, src)
        if duration > MAX_DURATION + 2:
            media.delete_reel_files(vid)
            raise HTTPException(400, f"Видео длиннее {MAX_DURATION // 60} минут — сократите ролик")
        if media.have_ffmpeg() and not duration:
            media.delete_reel_files(vid)
            raise HTTPException(400, "Не удалось прочитать видео — проверьте файл")
        row = await db_fetchrow("""
            INSERT INTO reels(title, caption, public_id, video_url, poster_url, duration, width, height, bytes, status, trans)
            VALUES($1,$2,$3,$4,'',$5,$6,$7,$8,'processing','') RETURNING id""",
            title.strip()[:80], caption.strip()[:300], vid, f"{media.MEDIA_URL}/reels/{vid}.mp4",
            duration, width, height, size)
        task = asyncio.create_task(_process(row["id"], vid, src, width, height))
        _tasks.add(task)
        task.add_done_callback(_tasks.discard)
        return {"id": row["id"], "status": "processing"}

    @app.get("/api/admin/reels")
    async def reels_admin_list(_=Depends(require_admin)):
        rows = await db_fetch("""
            SELECT r.id, r.title, r.caption, r.video_url, r.poster_url, r.duration, r.width, r.height, r.bytes,
              r.is_published, r.status, r.created_at,
              (SELECT COUNT(*) FROM reel_views v WHERE v.reel_id = r.id) AS views,
              (SELECT COUNT(*) FROM reel_views v WHERE v.reel_id = r.id AND v.viewer LIKE 'c:%') AS views_accounts,
              (SELECT COUNT(*) FROM reel_views v WHERE v.reel_id = r.id AND v.viewer LIKE 'v:%') AS views_guests,
              (SELECT COUNT(*) FROM reel_likes l WHERE l.reel_id = r.id) AS likes,
              (SELECT COUNT(*) FROM reel_comments c WHERE c.reel_id = r.id) AS comments
            FROM reels r ORDER BY r.created_at DESC LIMIT 500""")
        return {"items": [_rec(r) for r in rows]}

    @app.patch("/api/admin/reels/{reel_id}")
    async def reels_patch(reel_id: int, b: ReelPatch, _=Depends(require_admin)):
        sets, args = [], []
        for col, val in (("title", b.title), ("caption", b.caption), ("is_published", b.is_published)):
            if val is not None:
                args.append(val.strip()[:300] if isinstance(val, str) else val)
                sets.append(f"{col} = ${len(args)}")
        if not sets:
            raise HTTPException(400, "Нечего менять")
        args.append(reel_id)
        st = await db_execute(f"UPDATE reels SET {', '.join(sets)} WHERE id = ${len(args)}", *args)
        if st.endswith(" 0"):
            raise HTTPException(404, "Видео не найдено")
        return {"ok": True}

    @app.delete("/api/admin/reels/{reel_id}")
    async def reels_delete(reel_id: int, _=Depends(require_admin)):
        row = await db_fetchrow("SELECT public_id FROM reels WHERE id=$1", reel_id)
        if not row:
            raise HTTPException(404, "Видео не найдено")
        await db_execute("DELETE FROM reels WHERE id=$1", reel_id)
        if _VID_RE.match(row["public_id"] or ""):
            media.delete_reel_files(row["public_id"])
        return {"ok": True}

    @app.get("/api/admin/reels/{reel_id}/comments")
    async def reels_admin_comments(reel_id: int, _=Depends(require_admin)):
        rows = await db_fetch("""
            SELECT c.id, c.author, c.body, c.created_at, c.customer_id, cu.email, cu.phone
            FROM reel_comments c LEFT JOIN customers cu ON cu.id = c.customer_id
            WHERE c.reel_id=$1 ORDER BY c.id DESC LIMIT 200""", reel_id)
        return {"items": [_rec(r) for r in rows]}

    @app.delete("/api/admin/reels/comments/{comment_id}")
    async def reels_admin_comment_delete(comment_id: int, _=Depends(require_admin)):
        await db_execute("DELETE FROM reel_comments WHERE id=$1", comment_id)
        return {"ok": True}
