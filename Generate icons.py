"""
Happy Toys — Icon Generator
───────────────────────────
Запусти ОДИН РАЗ после того как положишь icon.png в папку static/

Требования:
  pip install Pillow

Использование:
  cd your-project-folder
  python generate_icons.py

Это создаст все нужные размеры иконок в папке static/
"""

from PIL import Image
import os

SIZES = {
    'icon-16.png':   16,
    'icon-32.png':   32,
    'icon-120.png':  120,
    'icon-152.png':  152,
    'icon-167.png':  167,
    'icon-180.png':  180,
    'icon-192.png':  192,
    'icon-512.png':  512,
}

SPLASH_SIZES = {
    'splash-750x1334.png':   (750, 1334),    # iPhone SE
    'splash-1170x2532.png':  (1170, 2532),   # iPhone 14
    'splash-1290x2796.png':  (1290, 2796),   # iPhone 15 Pro Max
    'splash-1668x2388.png':  (1668, 2388),   # iPad Pro 11
    'splash-2048x2732.png':  (2048, 2732),   # iPad Pro 12.9
}

STATIC_DIR = os.path.join(os.path.dirname(__file__), 'static')
SOURCE     = os.path.join(STATIC_DIR, 'icon.png')

BG_COLOR  = (255, 255, 255, 255)   # белый фон для splash
ACC_COLOR = (255, 107, 53, 255)    # #FF6B35 — оранжевый Happy Toys

def generate_icons():
    if not os.path.exists(SOURCE):
        print(f"❌ Файл не найден: {SOURCE}")
        print("   Положи свою иконку в static/icon.png (рекомендуется 1024×1024 px)")
        return

    src = Image.open(SOURCE).convert("RGBA")
    print(f"✅ Источник: {src.size[0]}×{src.size[1]} px")

    os.makedirs(STATIC_DIR, exist_ok=True)

    # ── App icons ────────────────────────────────────────────────────────────
    for filename, size in SIZES.items():
        out_path = os.path.join(STATIC_DIR, filename)
        resized = src.resize((size, size), Image.LANCZOS)
        # Белый фон (для устройств без поддержки прозрачности)
        bg = Image.new("RGBA", (size, size), (255, 255, 255, 255))
        bg.paste(resized, (0, 0), resized)
        bg.convert("RGB").save(out_path, "PNG", optimize=True)
        print(f"   ✓ {filename} ({size}×{size})")

    # ── Splash screens ───────────────────────────────────────────────────────
    print("\n🖼  Splash screens:")
    # Make icon 40% of the smaller dimension
    for filename, (w, h) in SPLASH_SIZES.items():
        out_path = os.path.join(STATIC_DIR, filename)
        splash = Image.new("RGBA", (w, h), BG_COLOR)

        icon_size = int(min(w, h) * 0.28)
        icon_resized = src.resize((icon_size, icon_size), Image.LANCZOS)

        # Center icon
        x = (w - icon_size) // 2
        y = (h - icon_size) // 2 - int(h * 0.04)
        splash.paste(icon_resized, (x, y), icon_resized)

        # Add "Happy Toys" text below icon using basic drawing
        try:
            from PIL import ImageDraw, ImageFont
            draw = ImageDraw.Draw(splash)
            # Try to use a system font
            font_size = max(32, icon_size // 5)
            try:
                font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", font_size)
            except:
                try:
                    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", font_size)
                except:
                    font = ImageFont.load_default()

            text = "Happy Toys"
            bbox = draw.textbbox((0, 0), text, font=font)
            tw = bbox[2] - bbox[0]
            tx = (w - tw) // 2
            ty = y + icon_size + int(icon_size * 0.12)
            draw.text((tx, ty), text, fill=ACC_COLOR, font=font)

            sub_font_size = max(20, font_size // 2)
            try:
                sub_font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", sub_font_size)
            except:
                sub_font = font
            sub_text = "Оптовый каталог"
            sub_bbox = draw.textbbox((0, 0), sub_text, font=sub_font)
            sw2 = sub_bbox[2] - sub_bbox[0]
            sx = (w - sw2) // 2
            sy = ty + font_size + 8
            draw.text((sx, sy), sub_text, fill=(153, 153, 153, 255), font=sub_font)
        except Exception as e:
            print(f"     (текст не добавлен: {e})")

        splash.convert("RGB").save(out_path, "PNG", optimize=True)
        print(f"   ✓ {filename} ({w}×{h})")

    print(f"\n🎉 Готово! Все иконки созданы в: {STATIC_DIR}")
    print("\nСписок файлов:")
    for f in sorted(os.listdir(STATIC_DIR)):
        if f.endswith('.png'):
            size_kb = os.path.getsize(os.path.join(STATIC_DIR, f)) // 1024
            print(f"   {f:35s} {size_kb} KB")

if __name__ == "__main__":
    generate_icons()
