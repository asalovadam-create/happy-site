"""
Happy Toys — PDF-каталог для представителей.

Генерирует «нарисованный» каталог: обложка, содержание, разделы по категориям,
карточки товаров (фото, артикул, название, цена). Товары без фото не попадают.

Работает в фоновом потоке (job), чтобы не блокировать сервер и показывать прогресс.
Зависимости: reportlab, Pillow (шрифты лежат в папке fonts/).
"""
import base64
import io
import math
import os
import random
import re
import threading
import time
import traceback
import urllib.error
import urllib.request
import uuid
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from functools import lru_cache

from PIL import Image, ImageOps
from reportlab import rl_config
from reportlab.lib.colors import HexColor, white
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

Image.MAX_IMAGE_PIXELS = 40_000_000
rl_config.useA85 = 0  # без ASCII85: быстрее и файл меньше

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FONT_DIR = os.path.join(BASE_DIR, "fonts")
STATIC_DIR = os.path.join(BASE_DIR, "static")

W, H = 210 * mm, 297 * mm

# ── Палитра (взята с логотипа сайта) ─────────────────────────────────────────
NAVY = HexColor("#0B1250")
CREAM = HexColor("#FFF9EC")
DOT = HexColor("#F5E8CC")
YELLOW = HexColor("#FFD22E")
SKY_TOP, SKY_BOT = (0x7F, 0xD0, 0xF7), (0xE3, 0xF5, 0xFE)

THEMES = [  # main, dark (плашка цены), light (фон карточки), цвет текста на плашке
    ("#F86800", "#D9560A", "#FFEBDB", "#FFFFFF"),   # оранжевый
    ("#00A8F0", "#0B78C4", "#DDF3FD", "#FFFFFF"),   # голубой
    ("#7CC21B", "#3F9A2A", "#E9F7D2", "#FFFFFF"),   # зелёный
    ("#FF5C7A", "#D62F53", "#FFE1E8", "#FFFFFF"),   # розовый
    ("#9B6BFF", "#6C40D6", "#EEE5FF", "#FFFFFF"),   # фиолетовый
    ("#F8C800", "#F0B400", "#FFF4BF", "#0B1250"),   # жёлтый
    ("#19C3B0", "#0E8F86", "#D7F7F2", "#FFFFFF"),   # бирюзовый
]
LETTER_COLORS = ["#FF3B57", "#F86800", "#F8C800", "#7CC21B", "#00A8F0", "#9B6BFF"]

# ── Шрифты ───────────────────────────────────────────────────────────────────
F_REG, F_BOLD, F_COND, F_CONDB = "HT-Reg", "HT-Bold", "HT-Cond", "HT-CondBold"
_fonts_ready = False


def _register_fonts():
    global _fonts_ready
    if _fonts_ready:
        return
    sys_dirs = ["/usr/share/fonts/truetype/dejavu", "/usr/share/fonts/dejavu"]

    def find(name):
        for d in [FONT_DIR] + sys_dirs:
            p = os.path.join(d, name)
            if os.path.exists(p):
                return p
        raise FileNotFoundError(f"Шрифт {name} не найден (положите его в папку fonts/)")

    pdfmetrics.registerFont(TTFont(F_REG, find("DejaVuSansCondensed.ttf")))
    pdfmetrics.registerFont(TTFont(F_COND, find("DejaVuSansCondensed.ttf")))
    pdfmetrics.registerFont(TTFont(F_BOLD, find("DejaVuSans-Bold.ttf")))
    pdfmetrics.registerFont(TTFont(F_CONDB, find("DejaVuSansCondensed-Bold.ttf")))
    _fonts_ready = True


# ── Текст ────────────────────────────────────────────────────────────────────
def _clean(text, font=F_CONDB):
    """Убираем символы, которых нет в шрифте (эмодзи и т.п.), схлопываем пробелы."""
    cmap = pdfmetrics.getFont(font).face.charToGlyph
    out = "".join(ch if (ord(ch) in cmap or ch.isspace()) else "" for ch in str(text or ""))
    return " ".join(out.split())


def _sw(s, font, size):
    return pdfmetrics.stringWidth(s, font, size)


def wrap_text(text, font, size, max_w, max_lines):
    """Перенос по словам (длинные слова режем), с «…» если не влезло."""
    words = text.split(" ")
    lines, cur = [], ""
    for w in words:
        while _sw(w, font, size) > max_w:  # слишком длинное слово
            k = len(w)
            while k > 1 and _sw(w[:k], font, size) > max_w:
                k -= 1
            if cur:
                lines.append(cur)
                cur = ""
            lines.append(w[:k])
            w = w[k:]
        trial = (cur + " " + w).strip()
        if _sw(trial, font, size) <= max_w:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        last = lines[-1]
        while last and _sw(last + "…", font, size) > max_w:
            last = last[:-1]
        lines[-1] = last.rstrip() + "…"
    return lines


def fit_size(text, font, max_size, max_w, min_size=5):
    s = max_size
    while s > min_size and _sw(text, font, s) > max_w:
        s -= 0.25
    return s


def fmt_price(v):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return "по запросу"
    if v <= 0:
        return "по запросу"
    if abs(v - round(v)) < 0.005:
        s = f"{int(round(v)):,}".replace(",", "\u00a0")
    else:
        s = f"{v:,.2f}".replace(",", "\u00a0").replace(".", ",")
    return s + "\u00a0₽"


def plural(n, one, few, many):
    n = abs(int(n))
    if 11 <= n % 100 <= 14:
        return many
    return one if n % 10 == 1 else few if 2 <= n % 10 <= 4 else many


# ── «Рисованная» графика ─────────────────────────────────────────────────────
def _rr_points(x, y, w, h, r, step):
    """Точки по периметру скруглённого прямоугольника."""
    pts = []
    r = min(r, w / 2, h / 2)

    def edge(x0, y0, x1, y1):
        n = max(1, int(math.hypot(x1 - x0, y1 - y0) / step))
        for i in range(n):
            t = i / n
            pts.append((x0 + (x1 - x0) * t, y0 + (y1 - y0) * t))

    def arc(cx, cy, a0):
        for k in range(3):
            a = math.radians(a0 + 30 * k + 15)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))

    edge(x + r, y, x + w - r, y)
    arc(x + w - r, y + r, -90)
    edge(x + w, y + r, x + w, y + h - r)
    arc(x + w - r, y + h - r, 0)
    edge(x + w - r, y + h, x + r, y + h)
    arc(x + r, y + h - r, 90)
    edge(x, y + h - r, x, y + r)
    arc(x + r, y + r, 180)
    return pts


def _smooth_closed(c, pts):
    p = c.beginPath()
    n = len(pts)
    p.moveTo(*pts[0])
    for i in range(n):
        p0, p1, p2, p3 = pts[(i - 1) % n], pts[i], pts[(i + 1) % n], pts[(i + 2) % n]
        p.curveTo(
            p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
            p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
            p2[0], p2[1],
        )
    p.close()
    return p


@lru_cache(maxsize=512)
def _rr_rel(w, h, r, step):
    return tuple(_rr_points(0, 0, w, h, r, step))


def blob(c, x, y, w, h, r, fill=None, stroke=NAVY, lw=1.3, seed=0, jit=0.2 * mm, dash=None,
         shadow=0, shadow_color=NAVY):
    """Скруглённый прямоугольник с «дрожащей» рукой (+ жёсткая тень). Возвращает path."""
    rng = random.Random(seed)
    base = _rr_rel(round(w, 1), round(h, 1), round(r, 1), 6 * mm)
    pts = [(x + px + rng.uniform(-jit, jit), y + py + rng.uniform(-jit, jit)) for px, py in base]
    path = _smooth_closed(c, pts)
    c.saveState()
    c.setLineJoin(1)
    c.setLineCap(1)
    if shadow:
        c.saveState()
        c.translate(shadow, -shadow)
        c.setFillColor(shadow_color)
        c.setStrokeColor(shadow_color)
        c.setLineWidth(lw)
        c.drawPath(path, fill=1, stroke=1)
        c.restoreState()
    if dash:
        c.setDash(*dash)
    if fill is not None:
        c.setFillColor(fill)
    if stroke is not None:
        c.setStrokeColor(stroke)
        c.setLineWidth(lw)
    c.drawPath(path, fill=1 if fill is not None else 0, stroke=1 if stroke is not None else 0)
    c.restoreState()
    return path


def sticker(c, x, y, w, h, r, fill, seed=0, lw=1.3, shadow=1.4 * mm, shadow_color=NAVY, dash=None):
    return blob(c, x, y, w, h, r, fill=fill, stroke=NAVY, lw=lw, seed=seed, dash=dash,
                shadow=shadow, shadow_color=shadow_color)


def chip(c, x, y, w, h, fill, shadow=0.6 * mm, lw=1.0):
    """Маленькая дешёвая плашка (для артикула и т.п.)."""
    r = h / 2
    c.saveState()
    c.setLineJoin(1)
    c.setFillColor(NAVY)
    c.roundRect(x + shadow, y - shadow, w, h, r, stroke=0, fill=1)
    c.setFillColor(fill)
    c.setStrokeColor(NAVY)
    c.setLineWidth(lw)
    c.roundRect(x, y, w, h, r, stroke=1, fill=1)
    c.restoreState()


def circle_o(c, cx, cy, r, fill, lw=1.3):
    c.saveState()
    c.setFillColor(fill)
    c.setStrokeColor(NAVY)
    c.setLineWidth(lw)
    c.circle(cx, cy, r, stroke=1, fill=1)
    c.restoreState()


def star(c, cx, cy, r, fill=YELLOW, rot=0, lw=1.2, points=5, inner=0.48):
    c.saveState()
    c.translate(cx, cy)
    c.rotate(rot)
    c.setFillColor(fill)
    c.setStrokeColor(NAVY)
    c.setLineWidth(lw)
    c.setLineJoin(1)
    p = c.beginPath()
    for i in range(points * 2):
        a = math.pi / 2 + i * math.pi / points
        rr = r if i % 2 == 0 else r * inner
        (p.moveTo if i == 0 else p.lineTo)(rr * math.cos(a), rr * math.sin(a))
    p.close()
    c.drawPath(p, fill=1, stroke=1)
    c.restoreState()


def sparkle(c, cx, cy, r, fill=white, lw=1.0):
    c.saveState()
    c.translate(cx, cy)
    c.setFillColor(fill)
    c.setStrokeColor(NAVY)
    c.setLineWidth(lw)
    c.setLineJoin(1)
    p = c.beginPath()
    p.moveTo(0, r)
    p.curveTo(r * .12, r * .12, r * .12, r * .12, r, 0)
    p.curveTo(r * .12, -r * .12, r * .12, -r * .12, 0, -r)
    p.curveTo(-r * .12, -r * .12, -r * .12, -r * .12, -r, 0)
    p.curveTo(-r * .12, r * .12, -r * .12, r * .12, 0, r)
    p.close()
    c.drawPath(p, fill=1, stroke=1)
    c.restoreState()


def squiggle(c, x, y, length, amp, waves, color=NAVY, lw=1.6):
    c.saveState()
    c.setStrokeColor(color)
    c.setLineWidth(lw)
    c.setLineCap(1)
    c.setLineJoin(1)
    p = c.beginPath()
    n = int(waves * 12)
    for i in range(n + 1):
        t = i / n
        px, py = x + length * t, y + amp * math.sin(t * waves * 2 * math.pi)
        (p.moveTo if i == 0 else p.lineTo)(px, py)
    c.drawPath(p, stroke=1, fill=0)
    c.restoreState()


def cloud(c, cx, cy, s, fill=white, lw=1.6):
    circles = [(-1.25, 0.0, .62), (-.55, .42, .85), (.45, .5, .95), (1.25, .05, .68), (0, 0, .7)]
    c.saveState()
    for grow, col in ((lw, NAVY), (0, fill)):
        c.setFillColor(col)
        for ox, oy, r in circles:
            c.circle(cx + ox * s, cy + oy * s, r * s + grow, stroke=0, fill=1)
        c.roundRect(cx - 1.85 * s - grow, cy - .68 * s - grow, 3.7 * s + 2 * grow, .9 * s + grow, .4 * s, stroke=0, fill=1)
    c.restoreState()


def confetti(c, rng, x0, y0, x1, y1, n, avoid=None):
    cols = [HexColor(h) for h in LETTER_COLORS]
    for _ in range(n):
        x, y = rng.uniform(x0, x1), rng.uniform(y0, y1)
        if avoid and avoid[0] < x < avoid[2] and avoid[1] < y < avoid[3]:
            continue
        col = rng.choice(cols)
        kind = rng.random()
        c.saveState()
        c.translate(x, y)
        c.rotate(rng.uniform(0, 360))
        c.setFillColor(col)
        c.setStrokeColor(NAVY)
        c.setLineWidth(0.7)
        if kind < .45:
            c.roundRect(-1.1 * mm, -.55 * mm, 2.2 * mm, 1.1 * mm, .3 * mm, stroke=1, fill=1)
        elif kind < .8:
            c.circle(0, 0, .8 * mm, stroke=1, fill=1)
        else:
            c.setLineCap(1)
            c.setStrokeColor(col)
            c.setLineWidth(1.4)
            c.line(-1.4 * mm, 0, 1.4 * mm, 0)
        c.restoreState()


def dotted_bg(c):
    c.doForm("bg")


def _make_bg_form(c):
    c.beginForm("bg")
    c.setFillColor(CREAM)
    c.rect(0, 0, W, H, stroke=0, fill=1)
    c.setFillColor(DOT)
    step = 9 * mm
    row = 0
    y = 4 * mm
    while y < H:
        x = 4 * mm + (step / 2 if row % 2 else 0)
        while x < W:
            c.circle(x, y, .55 * mm, stroke=0, fill=1)
            x += step
        y += step * .75
        row += 1
    c.endForm()


def outlined_text(c, x, y, s, font, size, fill, lw=2.4, stroke=NAVY, rot=0):
    c.saveState()
    c.translate(x, y)
    c.rotate(rot)
    c.setLineJoin(1)
    t = c.beginText(0, 0)
    t.setFont(font, size)
    t.setTextRenderMode(2)
    c.setFillColor(fill)
    c.setStrokeColor(stroke)
    c.setLineWidth(lw)
    t.textOut(s)
    c.drawText(t)
    c.restoreState()


def ribbon(c, cx, cy, w, h, fill, tail):
    x0, y0 = cx - w / 2, cy - h / 2
    tl = 11 * mm
    c.saveState()
    c.setLineJoin(1)
    c.setFillColor(tail)
    c.setStrokeColor(NAVY)
    c.setLineWidth(1.6)
    for side in (-1, 1):
        xe = x0 if side < 0 else x0 + w
        p = c.beginPath()
        p.moveTo(xe + side * -6 * mm, y0 - 3 * mm)
        p.lineTo(xe + side * tl, y0 - 3 * mm)
        p.lineTo(xe + side * (tl - 4.5 * mm), cy - 3 * mm)
        p.lineTo(xe + side * tl, y0 + h - 3 * mm)
        p.lineTo(xe + side * -6 * mm, y0 + h - 3 * mm)
        p.close()
        c.drawPath(p, fill=1, stroke=1)
    c.setFillColor(fill)
    c.rect(x0, y0, w, h, stroke=1, fill=1)
    c.restoreState()


# ── Картинки ─────────────────────────────────────────────────────────────────
def _is_placeholder(url):
    u = url.lower()
    return "placehold.co" in u or "placeholder" in u or "via.placeholder" in u


def photo_candidates(p):
    out, seen = [], set()
    for u in [p.get("image")] + list(p.get("images") or []):
        u = (u or "").strip()
        if u and u not in seen and not _is_placeholder(u):
            seen.add(u)
            out.append(u)
    return out[:3]


def _photo_url(url):
    """Если в ссылке Cloudinary нет преобразований (сырой оригинал) — просим ≤900px.
    Ссылки с готовым преобразованием (c_limit,w_800…) не трогаем: они уже лёгкие."""
    m = "/image/upload/"
    if "res.cloudinary.com" in url and m in url:
        head, rest = url.split(m, 1)
        if re.fullmatch(r"v\d+", rest.split("/", 1)[0]):
            return f"{head}{m}c_limit,w_900,h_900,q_auto:good/{rest}"
    return url


def _fetch_bytes(url, timeout=10, limit=8 * 1024 * 1024):
    if url.startswith("data:"):
        head, _, b64 = url.partition(",")
        if "base64" not in head:
            return None
        return base64.b64decode(b64)
    if url.startswith("/"):  # локальный файл из static/
        path = os.path.normpath(os.path.join(BASE_DIR, url.lstrip("/").split("?")[0]))
        if not path.startswith(STATIC_DIR) or not os.path.isfile(path):
            return None
        with open(path, "rb") as f:
            return f.read(limit)
    if not url.startswith(("http://", "https://")):
        return None
    req = urllib.request.Request(url, headers={"User-Agent": "HappyToysCatalog/1.0", "Accept": "image/*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read(limit + 1)
    return data if len(data) <= limit else None


PASS_MAX_BYTES = 70 * 1024   # маленький JPEG кладём в PDF как есть, без перекодировки


def _make_thumb(data, px):
    im = Image.open(io.BytesIO(data))          # читает только заголовок
    w, h = im.size
    if min(w, h) < 40:
        return None
    try:
        orient = im.getexif().get(0x0112, 1)
    except Exception:
        orient = 1
    if (im.format == "JPEG" and im.mode in ("RGB", "L") and orient == 1
            and max(w, h) <= int(px * 1.5) and len(data) <= PASS_MAX_BYTES):
        return data, (w, h)
    try:
        im.draft("RGB", (px * 2, px * 2))
    except Exception:
        pass
    im.load()
    im = ImageOps.exif_transpose(im)
    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        im = im.convert("RGBA")
        bg = Image.new("RGB", im.size, (255, 255, 255))
        bg.paste(im, mask=im.split()[3])
        im = bg
    else:
        im = im.convert("RGB")
    im.thumbnail((px, px))
    out = io.BytesIO()
    im.save(out, "JPEG", quality=76)
    return out.getvalue(), im.size


_photo_cache = OrderedDict()   # (url, px) -> (bytes, size); живёт между выгрузками
_photo_cache_bytes = 0
_photo_lock = threading.Lock()
PHOTO_CACHE_LIMIT = 120 * 1024 * 1024


def _cache_get(key):
    with _photo_lock:
        v = _photo_cache.get(key)
        if v:
            _photo_cache.move_to_end(key)
        return v


def _cache_put(key, val):
    global _photo_cache_bytes
    with _photo_lock:
        if key in _photo_cache:
            return
        _photo_cache[key] = val
        _photo_cache_bytes += len(val[0])
        while _photo_cache_bytes > PHOTO_CACHE_LIMIT and _photo_cache:
            _, old = _photo_cache.popitem(last=False)
            _photo_cache_bytes -= len(old[0])


def load_photo(p, px):
    """Первое рабочее фото товара -> (jpeg_bytes, (w, h)) или None."""
    for url in photo_candidates(p):
        hit = _cache_get((url, px))
        if hit:
            return hit
        attempts = [_photo_url(url)]
        if attempts[0] != url:
            attempts.append(url)
        for u in attempts:
            for _try in range(2):
                try:
                    data = _fetch_bytes(u)
                    if data:
                        res = _make_thumb(data, px)
                        if res:
                            _cache_put((url, px), res)
                            return res
                    break
                except urllib.error.HTTPError as e:
                    if 400 <= e.code < 500:
                        break            # ссылка мёртвая — повторять бессмысленно
                    time.sleep(0.3)
                except Exception:
                    time.sleep(0.3)
    return None


# ── Страницы ─────────────────────────────────────────────────────────────────
MARGIN_X = 12 * mm
HEADER_H = 25 * mm
GRID_TOP = H - HEADER_H - 7 * mm
GRID_BOTTOM = 19 * mm


class Layout:
    """big — крупные карточки 2x2 (по умолчанию), compact — мелкие 3x3."""

    def __init__(self, name="big"):
        self.name = "compact" if name == "compact" else "big"
        if self.name == "compact":
            self.cols, self.rows, self.gap_x, self.gap_y, self.thumb_px = 3, 3, 6 * mm, 6 * mm, 400
        else:
            self.cols, self.rows, self.gap_x, self.gap_y, self.thumb_px = 2, 2, 8 * mm, 8 * mm, 560
        self.card_w = (W - 2 * MARGIN_X - (self.cols - 1) * self.gap_x) / self.cols
        self.card_h = (GRID_TOP - GRID_BOTTOM - (self.rows - 1) * self.gap_y) / self.rows
        self.s = self.card_w / (58 * mm)          # масштаб относительно «компактной» карточки
        self.per_page = self.cols * self.rows


class Assets:
    def __init__(self):
        self.logo = self._png("logo.png", 700)
        self.car = self._png("car.png", 700)

    @staticmethod
    def _png(name, width):
        path = os.path.join(STATIC_DIR, name)
        if not os.path.exists(path):
            return None
        im = Image.open(path).convert("RGBA")
        if im.width > width:
            im = im.resize((width, int(im.height * width / im.width)), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "PNG", optimize=True)
        buf.seek(0)
        return ImageReader(buf), im.size


def draw_image_fit(c, reader, size, x, y, w, h):
    iw, ih = size
    k = min(w / iw, h / ih)
    dw, dh = iw * k, ih * k
    c.drawImage(reader, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh, mask="auto")


def hills(c, base1, base2):
    for base, col, amp, ph in [(base1, "#B5E36B", 9 * mm, 0), (base2, "#7CC21B", 8 * mm, 2.2)]:
        c.saveState()
        c.setFillColor(HexColor(col)); c.setStrokeColor(NAVY); c.setLineWidth(2); c.setLineJoin(1)
        p = c.beginPath(); p.moveTo(-5, -5); p.lineTo(-5, base)
        steps = 60
        for i in range(steps + 1):
            x = -5 + (W + 10) * i / steps
            p.lineTo(x, base + amp * math.sin(i / steps * 2.2 * math.pi + ph))
        p.lineTo(W + 5, -5); p.close()
        c.drawPath(p, fill=1, stroke=1); c.restoreState()


def draw_cover(c, assets, date_str, n_products, n_cats):
    # небо-градиент
    bands = 40
    for i in range(bands):
        t = i / (bands - 1)
        col = tuple((SKY_TOP[k] + (SKY_BOT[k] - SKY_TOP[k]) * t) / 255 for k in range(3))
        c.setFillColorRGB(*col)
        c.rect(0, H - (i + 1) * H / bands - 1, W, H / bands + 2, stroke=0, fill=1)
    rng = random.Random(11)

    # солнце
    sx, sy = W - 34 * mm, H - 34 * mm
    c.saveState()
    c.setLineCap(1)
    for i in range(12):
        a = math.radians(i * 30 + 8)
        x0, y0 = sx + 17 * mm * math.cos(a), sy + 17 * mm * math.sin(a)
        x1, y1 = sx + 25 * mm * math.cos(a), sy + 25 * mm * math.sin(a)
        c.setStrokeColor(NAVY); c.setLineWidth(6.5); c.line(x0, y0, x1, y1)
        c.setStrokeColor(YELLOW); c.setLineWidth(3.3); c.line(x0, y0, x1, y1)
    c.restoreState()
    circle_o(c, sx, sy, 14 * mm, YELLOW, lw=2)
    c.saveState(); c.setStrokeColor(NAVY); c.setLineWidth(1.6); c.setLineCap(1)
    c.circle(sx - 4.5 * mm, sy + 2 * mm, .9 * mm, stroke=0, fill=0)
    c.setFillColor(NAVY); c.circle(sx - 4.5 * mm, sy + 2.5 * mm, 1.1 * mm, stroke=0, fill=1)
    c.circle(sx + 4.5 * mm, sy + 2.5 * mm, 1.1 * mm, stroke=0, fill=1)
    p = c.beginPath(); p.moveTo(sx - 5 * mm, sy - 3 * mm); p.curveTo(sx - 2 * mm, sy - 7.5 * mm, sx + 2 * mm, sy - 7.5 * mm, sx + 5 * mm, sy - 3 * mm)
    c.drawPath(p, stroke=1, fill=0); c.restoreState()

    # облака
    for cx, cy, s in [(30 * mm, H - 40 * mm, 9 * mm), (118 * mm, H - 22 * mm, 6.5 * mm),
                      (22 * mm, H - 112 * mm, 6 * mm)]:
        cloud(c, cx, cy, s)

    confetti(c, rng, 8 * mm, 100 * mm, W - 8 * mm, H - 8 * mm, 70, avoid=(20 * mm, 118 * mm, W - 20 * mm, H - 60 * mm))
    for x, y, r, col in [(14 * mm, H - 70 * mm, 6 * mm, YELLOW), (W - 18 * mm, H - 86 * mm, 4.5 * mm, HexColor("#FF5C7A")),
                         (60 * mm, H - 16 * mm, 3.5 * mm, HexColor("#9B6BFF"))]:
        star(c, x, y, r, col, rot=rng.uniform(-20, 20))
    for x, y, r in [(52 * mm, H - 58 * mm, 3.5 * mm), (W - 40 * mm, H - 66 * mm, 3 * mm), (16 * mm, H - 142 * mm, 3 * mm)]:
        sparkle(c, x, y, r)

    hills(c, 70 * mm, 52 * mm)

    # логотип-замок
    if assets.logo:
        rd, (lw_, lh_) = assets.logo
        lw = 98 * mm
        lh = lw * lh_ / lw_
        c.saveState(); c.translate(W / 2, H - 106 * mm); c.rotate(-2)
        c.drawImage(rd, -lw / 2, -lh / 2, lw, lh, mask="auto"); c.restoreState()

    # название «Happy Toys» разноцветными буквами
    text, size = "Happy Toys", 62
    total = sum(_sw(ch, F_BOLD, size) for ch in text)
    x = (W - total) / 2
    y = H - 178 * mm
    for i, ch in enumerate(text):
        col = HexColor(LETTER_COLORS[i % len(LETTER_COLORS)])
        wch = _sw(ch, F_BOLD, size)
        if ch != " ":
            off = 2.2 * mm
            outlined_text(c, x + off * .7, y - off, ch, F_BOLD, size, NAVY, lw=5, rot=(i % 3 - 1) * 3)
            outlined_text(c, x, y, ch, F_BOLD, size, col, lw=4.2, rot=(i % 3 - 1) * 3)
        x += wch

    # лента
    rc_y = H - 202 * mm
    ribbon(c, W / 2, rc_y, 128 * mm, 17 * mm, white, HexColor("#FF5C7A"))
    t = "Оптовый каталог"
    sz = 23
    c.setFillColor(NAVY); c.setFont(F_BOLD, sz)
    c.drawCentredString(W / 2, rc_y - 3 * mm, t)

    # стикер-звезда со статистикой
    c.saveState(); c.translate(W - 30 * mm, H - 124 * mm); c.rotate(10)
    star(c, 0, 0, 21 * mm, HexColor("#FF5C7A"), lw=2, points=14, inner=.82)
    c.setFillColor(white); c.setFont(F_BOLD, 21)
    c.drawCentredString(0, 1.5 * mm, f"{n_products}")
    c.setFont(F_CONDB, 9.5)
    c.drawCentredString(0, -4.5 * mm, plural(n_products, "товар", "товара", "товаров"))
    c.setFont(F_COND, 8)
    c.drawCentredString(0, -9 * mm, f"{n_cats} {plural(n_cats, 'раздел', 'раздела', 'разделов')}")
    c.restoreState()

    # машинки
    if assets.car:
        rd, (cw_, ch_) = assets.car
        cw = 88 * mm
        chh = cw * ch_ / cw_
        c.saveState(); c.translate(52 * mm, 33 * mm); c.rotate(3)
        c.drawImage(rd, -cw / 2, -chh / 2 + 6 * mm, cw, chh, mask="auto"); c.restoreState()

    # дата
    sticker(c, W / 2 - 34 * mm, 8 * mm, 68 * mm, 10 * mm, 4.5 * mm, white, seed=9, shadow=1 * mm)
    c.setFillColor(NAVY); c.setFont(F_CONDB, 10)
    c.drawCentredString(W / 2, 11.4 * mm, f"Актуально на {date_str}")


def _make_header_forms(c, assets):
    """Цветная волнистая шапка + логотип — по одной форме на цвет темы."""
    n = 48
    y0 = H - HEADER_H
    for ti, theme in enumerate(THEMES):
        c.beginForm(f"hdr{ti}")
        c.setFillColor(HexColor(theme[0]))
        p = c.beginPath()
        p.moveTo(0, H); p.lineTo(W, H); p.lineTo(W, y0)
        for i in range(n + 1):
            p.lineTo(W - W * i / n, y0 + 1.6 * mm * math.sin(i / n * 9 * math.pi))
        p.close()
        c.drawPath(p, fill=1, stroke=0)
        c.setStrokeColor(NAVY); c.setLineWidth(1.6); c.setLineJoin(1)
        q = c.beginPath()
        for i in range(n + 1):
            (q.moveTo if i == 0 else q.lineTo)(W * i / n, y0 + 1.6 * mm * math.sin((n - i) / n * 9 * math.pi))
        c.drawPath(q, fill=0, stroke=1)
        cx, cy = MARGIN_X + 10 * mm, H - 12.2 * mm
        circle_o(c, cx, cy, 9.6 * mm, white, lw=1.6)
        if assets.logo:
            rd, sz = assets.logo
            draw_image_fit(c, rd, sz, cx - 7.6 * mm, cy - 7.6 * mm, 15.2 * mm, 15.2 * mm)
        c.endForm()


def draw_header(c, assets, title, theme, count_text, page_kind_seed):
    c.doForm(f"hdr{THEMES.index(theme)}")

    # плашка с названием
    text = _clean(title, F_BOLD) or "Каталог"
    max_w = W - 2 * MARGIN_X - 26 * mm - 34 * mm - 8 * mm
    size = fit_size(text, F_BOLD, 17, max_w - 10 * mm, 9)
    tw = _sw(text, F_BOLD, size)
    if tw > max_w - 10 * mm:
        while text and _sw(text + "…", F_BOLD, size) > max_w - 10 * mm:
            text = text[:-1]
        text = text.rstrip() + "…"
        tw = _sw(text, F_BOLD, size)
    px = MARGIN_X + 22 * mm
    sticker(c, px, H - 18.2 * mm, tw + 10 * mm, 12 * mm, 4.5 * mm, white, seed=page_kind_seed, shadow=1.1 * mm)
    c.setFillColor(NAVY); c.setFont(F_BOLD, size)
    c.drawString(px + 5 * mm, H - 14.4 * mm - (size - 12) * .12, text)

    if count_text:
        cw = _sw(count_text, F_CONDB, 9) + 8 * mm
        sticker(c, W - MARGIN_X - cw, H - 16.8 * mm, cw, 8 * mm, 3.4 * mm, YELLOW, seed=page_kind_seed + 3, shadow=1 * mm)
        c.setFillColor(NAVY); c.setFont(F_CONDB, 9)
        c.drawCentredString(W - MARGIN_X - cw / 2, H - 14.3 * mm, count_text)

    sparkle(c, W - MARGIN_X - 40 * mm, H - 8 * mm, 2.3 * mm)
    sparkle(c, MARGIN_X + 22 * mm + 1 * mm, H - 5 * mm, 1.7 * mm)


def draw_footer(c, page_no, date_str):
    c.saveState()
    c.setStrokeColor(NAVY); c.setLineWidth(0.9); c.setLineCap(1); c.setDash(0.1, 4.2)
    c.line(MARGIN_X, 13.5 * mm, W - MARGIN_X, 13.5 * mm)
    c.restoreState()
    c.setFillColor(NAVY)
    c.setFont(F_CONDB, 8)
    c.drawString(MARGIN_X, 7.4 * mm, "Happy Toys · оптовый каталог")
    c.setFont(F_COND, 7.5)
    c.drawCentredString(W / 2, 7.4 * mm, f"Цены в рублях, актуальны на {date_str}")
    circle_o(c, W - MARGIN_X - 4.6 * mm, 8.2 * mm, 4.6 * mm, YELLOW, lw=1.2)
    c.setFillColor(NAVY); c.setFont(F_BOLD, 8.5)
    c.drawCentredString(W - MARGIN_X - 4.6 * mm, 6.9 * mm, str(page_no))


CARD_VARIANTS = 4


def _card_geom(L):
    s = L.s
    pad, band_h, name_zone = 3 * mm * s, 10.5 * mm * s, 15.5 * mm * s
    well_h = L.card_h - 2 * pad - band_h - name_zone
    return s, pad, band_h, name_zone, well_h


def _make_card_forms(c, L):
    """Рамка карточки (тень, фон, окно фото, плашка цены) — рисуем один раз на тему/вариант."""
    s, pad, band_h, _, well_h = _card_geom(L)
    ls = min(s, 1.25)
    cw, ch = L.card_w, L.card_h
    for ti, theme in enumerate(THEMES):
        main, dark, light = HexColor(theme[0]), HexColor(theme[1]), HexColor(theme[2])
        for v in range(CARD_VARIANTS):
            seed = ti * 17 + v * 31
            c.beginForm(f"card_{L.name}_{ti}_{v}", -4 * mm, -4 * mm, cw + 6 * mm, ch + 6 * mm)
            blob(c, 0, 0, cw, ch, 4.5 * mm * s, fill=light, stroke=NAVY, lw=1.4 * ls, seed=seed,
                 jit=.2 * mm * s, shadow=1.5 * mm * s)
            blob(c, pad, ch - pad - well_h, cw - 2 * pad, well_h, 3 * mm * s, fill=white, stroke=main,
                 lw=1.1 * ls, seed=seed + 1, jit=.2 * mm * s, dash=(3 * ls, 2 * ls))
            blob(c, pad, pad, cw - 2 * pad, band_h, 3.4 * mm * s, fill=dark, stroke=NAVY, lw=1.2 * ls,
                 seed=seed + 4, jit=.2 * mm * s)
            c.endForm()


def draw_card(c, x, y, item, theme_idx, seed, L):
    """x, y — левый нижний угол карточки."""
    theme = THEMES[theme_idx]
    s, pad, band_h, _, well_h = _card_geom(L)
    ls = min(s, 1.25)
    cw, ch = L.card_w, L.card_h
    on_dark = HexColor(theme[3])

    c.saveState()
    c.translate(x, y)
    c.doForm(f"card_{L.name}_{theme_idx}_{seed % CARD_VARIANTS}")
    c.restoreState()

    # фото
    wx, ww = x + pad, cw - 2 * pad
    wy = y + ch - pad - well_h
    m = 1.5 * mm * s
    rd = ImageReader(io.BytesIO(item["thumb"]))
    draw_image_fit(c, rd, item["thumb_size"], wx + m, wy + m, ww - 2 * m, well_h - 2 * m)

    # артикул
    sku = "арт. " + _clean(item["sku"], F_CONDB)
    max_w = ww - 6 * mm * s
    fs = fit_size(sku, F_CONDB, 7.2 * s, max_w - 4 * mm * s, 4.5)
    chip_w = min(max_w, _sw(sku, F_CONDB, fs) + 4.4 * mm * s)
    chip_h = 5.2 * mm * s
    cx0, cy0 = wx + 1.8 * mm * s, wy + well_h - 3.4 * mm * s
    chip(c, cx0, cy0, chip_w, chip_h, YELLOW, shadow=.6 * mm * s, lw=1.0 * ls)
    c.setFillColor(NAVY); c.setFont(F_CONDB, fs)
    c.drawString(cx0 + 2.2 * mm * s, cy0 + chip_h / 2 - fs * .35, sku)

    if item.get("out"):
        t = "нет в наличии"
        fso = 6.5 * s
        tw = _sw(t, F_CONDB, fso) + 4 * mm * s
        oh = 4.8 * mm * s
        chip(c, wx + 1.8 * mm * s, wy + 1.6 * mm * s, tw, oh, HexColor("#E53935"), shadow=.5 * mm * s, lw=1.0 * ls)
        c.setFillColor(white); c.setFont(F_CONDB, fso)
        c.drawString(wx + 3.8 * mm * s, wy + 1.6 * mm * s + oh / 2 - fso * .35, t)

    # название (до 3 строк)
    name = _clean(item["name"], F_CONDB) or "Без названия"
    fs = 9 * s
    lines = wrap_text(name, F_CONDB, fs, ww - 1 * mm * s, 3)
    ny = wy - 4.2 * mm * s
    c.setFillColor(NAVY); c.setFont(F_CONDB, fs)
    for ln in lines:
        c.drawCentredString(x + cw / 2, ny, ln)
        ny -= 3.75 * mm * s

    # цена
    bx, bw, by = x + pad, cw - 2 * pad, y + pad
    price = fmt_price(item["price"])
    mo = int(item.get("min_order") or 1)
    avail = bw - 4 * mm * s - (15.5 * mm * s if mo > 1 else 0)
    fs = fit_size(price, F_BOLD, 13.5 * s, avail, 7)
    ty = by + band_h / 2 - fs * .35
    c.setFillColor(on_dark); c.setFont(F_BOLD, fs)
    if mo > 1:
        c.drawString(bx + 3 * mm * s, ty, price)
        t = f"от {mo} шт"
        fsm = 6.6 * s
        tw = _sw(t, F_CONDB, fsm) + 3 * mm * s
        mh = 5.3 * mm * s
        chip(c, bx + bw - tw - 1.8 * mm * s, by + (band_h - mh) / 2, tw, mh, white, shadow=0, lw=.8 * ls)
        c.setFillColor(NAVY); c.setFont(F_CONDB, fsm)
        c.drawCentredString(bx + bw - tw / 2 - 1.8 * mm * s, by + band_h / 2 - fsm * .35, t)
    else:
        c.drawCentredString(bx + bw / 2, ty, price)


def draw_ground_decor(c, assets):
    """Холмы и машинки внизу страницы (не трогает середину)."""
    hills(c, 44 * mm, 30 * mm)
    rng = random.Random(3)
    confetti(c, rng, 12 * mm, 50 * mm, W - 12 * mm, 90 * mm, 14)
    cloud(c, 45 * mm, 78 * mm, 6 * mm)
    star(c, 168 * mm, 72 * mm, 5 * mm, YELLOW, rot=10)
    if assets.car:
        rd, (cw_, ch_) = assets.car
        cw = 70 * mm
        c.saveState(); c.translate(W - 62 * mm, 28 * mm); c.rotate(-3)
        c.drawImage(rd, -cw / 2, -cw * ch_ / cw_ / 2 + 5 * mm, cw, cw * ch_ / cw_, mask="auto"); c.restoreState()


def draw_sparse_decor(c, assets, n_items, L):
    """Заполняем пустое место, если на странице мало товаров."""
    free_rows = L.rows - math.ceil(n_items / L.cols)
    free_h = free_rows * (L.card_h + L.gap_y)
    if free_h >= 150 * mm:
        hills(c, 44 * mm, 30 * mm)
        cloud(c, 150 * mm, 150 * mm, 8 * mm)
        cloud(c, 60 * mm, 110 * mm, 6 * mm)
        rng = random.Random(n_items)
        confetti(c, rng, 12 * mm, 40 * mm, W - 12 * mm, 170 * mm, 45)
        star(c, 178 * mm, 110 * mm, 6 * mm, YELLOW, rot=12)
        sparkle(c, 110 * mm, 130 * mm, 3.4 * mm)
        if assets.car:
            rd, (cw_, ch_) = assets.car
            cw = 70 * mm
            c.saveState(); c.translate(W - 62 * mm, 28 * mm); c.rotate(-3)
            c.drawImage(rd, -cw / 2, -cw * ch_ / cw_ / 2 + 5 * mm, cw, cw * ch_ / cw_, mask="auto"); c.restoreState()
    elif free_h >= 110 * mm:
        draw_ground_decor(c, assets)
    elif free_rows >= 1:
        cloud(c, 45 * mm, 42 * mm, 6.5 * mm)
        cloud(c, W - 50 * mm, 50 * mm, 7.5 * mm)
        rng = random.Random(n_items + 5)
        confetti(c, rng, 12 * mm, 24 * mm, W - 12 * mm, 84 * mm, 30)
        star(c, W / 2, 55 * mm, 6 * mm, YELLOW, rot=-10)
        sparkle(c, W / 2 - 30 * mm, 42 * mm, 3 * mm)
        sparkle(c, W / 2 + 32 * mm, 66 * mm, 3.4 * mm)


def draw_toc(c, assets, entries, page_idx, n_toc, date_str, total_products):
    dotted_bg(c)
    theme = THEMES[1]
    draw_header(c, assets, "Содержание" + (f" ({page_idx + 1}/{n_toc})" if n_toc > 1 else ""),
                theme, f"{total_products} {plural(total_products, 'товар', 'товара', 'товаров')}", 21)
    row_h, gap = 13 * mm, 3.6 * mm
    y = GRID_TOP - row_h
    for e in entries:
        t = THEMES[e["theme"] % len(THEMES)]
        sticker(c, MARGIN_X, y, W - 2 * MARGIN_X, row_h, 4.5 * mm, white, seed=e["idx"] * 3 + 1, shadow=1.1 * mm)
        circle_o(c, MARGIN_X + 7 * mm, y + row_h / 2, 4.6 * mm, HexColor(t[0]), lw=1.3)
        c.setFillColor(white if t[3] == "#FFFFFF" else NAVY)
        c.setFont(F_BOLD, 10)
        c.drawCentredString(MARGIN_X + 7 * mm, y + row_h / 2 - 1.3 * mm, str(e["idx"] + 1))
        name = _clean(e["title"], F_BOLD)
        fs = fit_size(name, F_BOLD, 12, 100 * mm, 8)
        c.setFillColor(NAVY); c.setFont(F_BOLD, fs)
        c.drawString(MARGIN_X + 15 * mm, y + row_h / 2 - 1.5 * mm, name)
        nw = _sw(name, F_BOLD, fs)
        cnt = f"{e['count']} {plural(e['count'], 'товар', 'товара', 'товаров')}"
        c.setFont(F_COND, 8.5); c.setFillColor(HexColor("#5B6088"))
        cw = _sw(cnt, F_COND, 8.5)
        pg = str(e["page"])
        pill_w = 12 * mm
        right = W - MARGIN_X - 4 * mm
        # точечный пунктир до номера страницы
        c.saveState(); c.setStrokeColor(NAVY); c.setLineWidth(1); c.setLineCap(1); c.setDash(0.1, 3.4)
        x_from = MARGIN_X + 15 * mm + nw + 4 * mm
        x_to = right - pill_w - cw - 8 * mm
        if x_to > x_from:
            c.line(x_from, y + row_h / 2 - .4 * mm, x_to, y + row_h / 2 - .4 * mm)
        c.restoreState()
        c.setFont(F_COND, 8.5); c.setFillColor(HexColor("#5B6088"))
        c.drawRightString(right - pill_w - 3 * mm, y + row_h / 2 - 1.3 * mm, cnt)
        blob(c, right - pill_w, y + 3 * mm, pill_w, row_h - 6 * mm, 3 * mm, fill=HexColor(t[0]), stroke=NAVY, lw=1, seed=e["idx"] + 40, jit=.1 * mm)
        c.setFillColor(HexColor(t[3])); c.setFont(F_BOLD, 10)
        c.drawCentredString(right - pill_w / 2, y + row_h / 2 - 1.3 * mm, pg)
        c.linkRect("", e["bookmark"], (MARGIN_X, y, W - MARGIN_X, y + row_h), relative=0, thickness=0)
        y -= row_h + gap
    # памятка внизу
    bottom = y
    if y > 38 * mm:
        note_h = 24 * mm
        ny = max(y - 4 * mm - note_h + row_h, 20 * mm)
        ny = 20 * mm if y - 4 * mm - note_h < 20 * mm else ny
        sticker(c, MARGIN_X, ny, W - 2 * MARGIN_X, note_h, 5 * mm, HexColor("#FFF4BF"), seed=77, shadow=1.2 * mm, dash=(4, 3))
        star(c, MARGIN_X + 10 * mm, ny + note_h / 2, 5 * mm, YELLOW, rot=8)
        c.setFillColor(NAVY); c.setFont(F_CONDB, 9.5)
        c.drawString(MARGIN_X + 20 * mm, ny + note_h - 8.5 * mm, "Как пользоваться каталогом")
        c.setFont(F_COND, 8.5)
        c.drawString(MARGIN_X + 20 * mm, ny + note_h - 13.5 * mm, "Нажмите на раздел в содержании — откроется нужная страница. Все цены указаны в рублях.")
        c.drawString(MARGIN_X + 20 * mm, ny + note_h - 18 * mm, f"Цены и наличие актуальны на {date_str} — перед заказом уточняйте у менеджера.")
        bottom = ny
    if bottom > 100 * mm:
        draw_ground_decor(c, assets)
    draw_footer(c, page_idx + 2, date_str)


# ── Выбор товаров для файла ──────────────────────────────────────────────────
MAX_PER_FILE = 500


def _sort_key(p):
    cat = _clean(p.get("category"), F_BOLD)
    return (cat == "", cat.lower(), str(p.get("subcategory") or "").lower(),
            str(p.get("name") or "").lower(), p.get("id") or 0)


def eligible(products, hide_out=False):
    """Товары, которые могут попасть в каталог (есть фото), в порядке каталога."""
    _register_fonts()
    cand = [p for p in products if photo_candidates(p) and not (hide_out and p.get("stock") == "out")]
    cand.sort(key=_sort_key)
    return cand


def catalog_index(products):
    """Лёгкий индекс для админки: [[категория, нет_в_наличии], ...] в порядке каталога."""
    return [[_clean(p.get("category"), F_BOLD) or "Без категории", 1 if p.get("stock") == "out" else 0]
            for p in eligible(products)]


def select_products(products, hide_out=False, limit=0, part=1):
    """Возвращает (товары_части, всего_подходящих, всего_частей, размер_части)."""
    cand = eligible(products, hide_out)
    size = min(int(limit or MAX_PER_FILE), MAX_PER_FILE)
    part = max(1, int(part or 1))
    total = len(cand)
    parts = max(1, math.ceil(total / size))
    return cand[(part - 1) * size: part * size], total, parts, size


# ── Сборка PDF ───────────────────────────────────────────────────────────────
def build_pdf(items, progress=None, date_str=None, layout="big"):
    """items: [{name, sku, price, category, subcategory, min_order, out, thumb, thumb_size}]"""
    _register_fonts()
    L = Layout(layout)
    date_str = date_str or datetime.now().strftime("%d.%m.%Y")
    assets = Assets()

    # группировка по категориям
    groups = {}
    for it in items:
        groups.setdefault(_clean(it.get("category"), F_BOLD) or "Без категории", []).append(it)
    order = sorted(groups, key=lambda k: (k == "Без категории", k.lower()))
    for k in order:
        groups[k].sort(key=lambda i: (str(i.get("subcategory") or "").lower(), str(i["name"]).lower()))

    per_toc = 14
    n_toc = max(1, math.ceil(len(order) / per_toc))
    page_no = 1 + n_toc + 1  # обложка + содержание, дальше — первая страница товаров
    plan, toc_entries = [], []
    for idx, cat in enumerate(order):
        chunks = [groups[cat][i:i + L.per_page] for i in range(0, len(groups[cat]), L.per_page)]
        toc_entries.append({"idx": idx, "title": cat, "count": len(groups[cat]), "page": page_no,
                            "theme": idx, "bookmark": f"cat{idx}"})
        for ci, chunk in enumerate(chunks):
            plan.append((idx, cat, ci, len(chunks), chunk, page_no))
            page_no += 1
    total_pages = page_no - 1

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(W, H), pageCompression=1)
    c.setTitle("Happy Toys — оптовый каталог")
    c.setAuthor("Happy Toys")
    c.setSubject(f"Оптовый каталог, {date_str}")
    c.setCreator("Happy Toys catalog generator")

    # общие элементы рисуем один раз и дальше только вставляем (быстро и файл меньше)
    _make_bg_form(c)
    _make_header_forms(c, assets)
    _make_card_forms(c, L)

    draw_cover(c, assets, date_str, len(items), len(order))
    c.showPage()

    for t in range(n_toc):
        part = toc_entries[t * per_toc:(t + 1) * per_toc]
        draw_toc(c, assets, part, t, n_toc, date_str, len(items))
        c.showPage()

    for n, (idx, cat, ci, nch, chunk, pno) in enumerate(plan):
        ti = idx % len(THEMES)
        dotted_bg(c)
        if ci == 0:
            c.bookmarkPage(f"cat{idx}")
            c.addOutlineEntry(f"{cat} ({len(groups[cat])})", f"cat{idx}", level=0)
        cnt = f"{len(groups[cat])} {plural(len(groups[cat]), 'товар', 'товара', 'товаров')}"
        if nch > 1:
            cnt += f" · {ci + 1}/{nch}"
        draw_header(c, assets, cat, THEMES[ti], cnt, idx * 5 + ci)
        draw_sparse_decor(c, assets, len(chunk), L)
        for k, it in enumerate(chunk):
            r, col = divmod(k, L.cols)
            x = MARGIN_X + col * (L.card_w + L.gap_x)
            y = GRID_TOP - (r + 1) * L.card_h - r * L.gap_y
            draw_card(c, x, y, it, ti, (it.get("id") or 0) * 13 + k, L)
        draw_footer(c, pno, date_str)
        c.showPage()
        if progress:
            progress(n + 1, len(plan))
    c.save()
    return buf.getvalue(), {"pages": total_pages, "categories": len(order)}


# ── Фоновые задачи ───────────────────────────────────────────────────────────
class Job:
    def __init__(self):
        self.id = uuid.uuid4().hex[:16]
        self.state = "running"      # running | done | error
        self.stage = "photos"       # photos | render
        self.done = 0
        self.total = 0
        self.error = ""
        self.pdf = None
        self.stats = {}
        self.created = time.time()

    def public(self):
        return {"job_id": self.id, "state": self.state, "stage": self.stage, "done": self.done,
                "total": self.total, "error": self.error, "stats": self.stats}


_jobs = {}
_lock = threading.Lock()
JOB_TTL = 15 * 60


def _purge():
    now = time.time()
    for k in [k for k, j in _jobs.items() if now - j.created > JOB_TTL]:
        _jobs.pop(k, None)


def get_job(job_id):
    with _lock:
        _purge()
        return _jobs.get(job_id)


def start_job(products, hide_out=False, layout="big", limit=0, part=1):
    """products — список dict из БД. Возвращает Job (или уже идущий)."""
    with _lock:
        _purge()
        for j in _jobs.values():
            if j.state == "running":
                return j
        job = Job()
        _jobs[job.id] = job
    threading.Thread(target=_run, args=(job, products, hide_out, layout, limit, part), daemon=True).start()
    return job


def _run(job, products, hide_out, layout, limit=0, part=1):
    try:
        L = Layout(layout)
        t0 = time.time()
        _register_fonts()
        no_photo = [p for p in products if not photo_candidates(p)]
        skipped_out = sum(1 for p in products if hide_out and p.get("stock") == "out" and photo_candidates(p))
        with_url, total_ok, parts, size = select_products(products, hide_out, limit, part)
        if not with_url:
            raise ValueError("В выбранной части нет товаров — выберите другую часть.")
        job.total = len(with_url)

        lock = threading.Lock()

        def work(p):
            res = load_photo(p, L.thumb_px)
            with lock:
                job.done += 1
            return res

        with ThreadPoolExecutor(max_workers=16) as ex:
            results = list(ex.map(work, with_url))
        t_photos = time.time() - t0

        items, broken = [], 0
        for p, res in zip(with_url, results):
            if not res:
                broken += 1
                continue
            items.append({**p, "thumb": res[0], "thumb_size": res[1], "out": p.get("stock") == "out"})
        del results

        if not items:
            raise ValueError("Нет ни одного товара с рабочим фото — PDF получился бы пустым.")

        job.stage, job.done, job.total = "render", 0, 1

        def prog(n, t):
            job.done, job.total = n, t

        t1 = time.time()
        pdf, st = build_pdf(items, progress=prog, layout=layout)
        t_render = time.time() - t1
        job.pdf = pdf
        job.stats = {**st, "products": len(items), "no_photo": len(no_photo), "broken_photo": broken,
                     "hidden_out": skipped_out, "size_mb": round(len(pdf) / 1048576, 1),
                     "sec_photos": round(t_photos, 1), "sec_render": round(t_render, 1),
                     "part": max(1, int(part or 1)), "parts": parts, "part_size": size, "total_available": total_ok}
        print(f"[catalog-pdf] часть {job.stats['part']}/{parts}: {len(items)} товаров, {st['pages']} стр., "
              f"{job.stats['size_mb']} МБ, фото {t_photos:.1f}с, сборка {t_render:.1f}с")
        job.state = "done"
    except Exception as e:  # noqa
        traceback.print_exc()
        job.state, job.error = "error", str(e) or e.__class__.__name__
