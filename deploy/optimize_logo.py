"""Один раз на сервере: уменьшает тяжёлый logo.png (≈870 КБ) до лёгкого файла.
Запуск:  /opt/happytoys/venv/bin/python /opt/happytoys/deploy/optimize_logo.py
"""
import os
from PIL import Image

path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "logo.png")
im = Image.open(path)
before = os.path.getsize(path)
im.thumbnail((640, 640), Image.LANCZOS)
im.save(path, "PNG", optimize=True)
print(f"logo.png: {before // 1024} КБ -> {os.path.getsize(path) // 1024} КБ, размер {im.size}")
