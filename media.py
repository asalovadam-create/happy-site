"""
Хранение фото и видео на диске сервера (вместо Cloudinary).

Фото товара: из любого загруженного файла делаем три WebP-файла —
  <id>.webp      до 1200 px  (страница товара, PDF)
  <id>_800.webp  до 800 px   (крупное фото)
  <id>_400.webp  до 400 px   (карточки в каталоге — самое частое)
Файлы лежат в MEDIA_DIR/products и отдаются nginx по адресу /media/products/...
с кэшем на год (имя файла уникально, поэтому кэш никогда не устаревает).

Видео Happy TV: если на сервере есть ffmpeg — сжимаем до 720×1280 (H.264) и делаем
постер; если нет — кладём файл как есть.
"""
import io
import json
import os
import shutil
import subprocess
import uuid

from PIL import Image, ImageOps

MEDIA_DIR = os.getenv("MEDIA_DIR", "/var/lib/happytoys/media")
PRODUCTS_DIR = os.path.join(MEDIA_DIR, "products")
REELS_DIR = os.path.join(MEDIA_DIR, "reels")
MEDIA_URL = "/media"

for _d in (PRODUCTS_DIR, REELS_DIR):
    os.makedirs(_d, exist_ok=True)

Image.MAX_IMAGE_PIXELS = 60_000_000      # защита от «бомб» — гигантских картинок
_SIZES = ((1200, ""), (800, "_800"), (400, "_400"))


class MediaError(ValueError):
    pass


def save_product_image(content: bytes) -> str:
    """Сохраняет фото товара, возвращает ссылку вида /media/products/<id>.webp"""
    try:
        im = Image.open(io.BytesIO(content))
        im.load()
    except Exception:
        raise MediaError("Это не картинка или файл повреждён")
    im = ImageOps.exif_transpose(im)
    has_alpha = im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)
    im = im.convert("RGBA" if has_alpha else "RGB")

    name = uuid.uuid4().hex[:16]
    for px, suffix in _SIZES:
        copy = im.copy()
        copy.thumbnail((px, px), Image.LANCZOS)
        copy.save(os.path.join(PRODUCTS_DIR, f"{name}{suffix}.webp"),
                  "WEBP", quality=80, method=4)
    return f"{MEDIA_URL}/products/{name}.webp"


def delete_product_image(url: str) -> None:
    """Удаляет все размеры фото, если ссылка ведёт в нашу папку."""
    prefix = f"{MEDIA_URL}/products/"
    if not url or not url.startswith(prefix):
        return
    base = os.path.basename(url)
    if not base.endswith(".webp"):
        return
    stem = base[:-5]
    for suffix in ("", "_800", "_400"):
        try:
            os.remove(os.path.join(PRODUCTS_DIR, f"{stem}{suffix}.webp"))
        except OSError:
            pass


# ── Видео ─────────────────────────────────────────────────────────────────────
def have_ffmpeg() -> bool:
    return bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def probe_video(path: str):
    """(длительность в секундах, ширина, высота) или (0, 0, 0), если ffprobe нет."""
    if not have_ffmpeg():
        return 0.0, 0, 0
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height:format=duration",
             "-of", "json", path],
            capture_output=True, text=True, timeout=30, check=True).stdout
        j = json.loads(out)
        st = (j.get("streams") or [{}])[0]
        return float(j.get("format", {}).get("duration") or 0), int(st.get("width") or 0), int(st.get("height") or 0)
    except Exception:
        return 0.0, 0, 0


def process_video(src: str, dst_mp4: str, poster_jpg: str, width: int, height: int) -> bool:
    """Сжимает видео до 720×1280. Блокирующая функция — запускать в потоке."""
    ratio = (width / height) if width and height else 0
    if 0.52 <= ratio <= 0.62:                       # уже 9:16 — просто уменьшаем
        # ширина не больше 720, размеры чётные (иначе H.264 не кодируется); маленькое видео не растягиваем
        vf = "scale='trunc(min(720,iw)/2)*2':-2:flags=bicubic,fps=30,format=yuv420p"
        cmd_in = ["-vf", vf]
    else:                                           # другой формат — размытый фон по краям, как в TikTok
        fc = ("[0:v]split[a][b];"
              "[a]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=20:5[bg];"
              "[b]scale=720:1280:force_original_aspect_ratio=decrease[fg];"
              "[bg][fg]overlay=(W-w)/2:(H-h)/2,fps=30,format=yuv420p[v]")
        cmd_in = ["-filter_complex", fc, "-map", "[v]", "-map", "0:a?"]
    try:
        subprocess.run(
            ["nice", "-n", "10", "ffmpeg", "-y", "-v", "error", "-i", src, *cmd_in,
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-threads", "1",
             "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", dst_mp4],
            check=True, timeout=60 * 30)
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-ss", "0.5", "-i", dst_mp4, "-frames:v", "1",
             "-vf", "scale=540:-2", "-q:v", "5", poster_jpg],
            check=False, timeout=60)
        return os.path.isfile(dst_mp4) and os.path.getsize(dst_mp4) > 0
    except Exception as e:
        print(f"[media] ffmpeg не справился: {e.__class__.__name__}: {e}")
        return False


def delete_reel_files(video_id: str) -> None:
    for ext in ("mp4", "jpg", "src"):
        try:
            os.remove(os.path.join(REELS_DIR, f"{video_id}.{ext}"))
        except OSError:
            pass
