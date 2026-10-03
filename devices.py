"""
Распознавание устройства посетителя: «iPhone 15 Pro / 15 / 14 Pro», «Samsung Galaxy S23 Ultra»,
«Windows 11 · Яндекс.Браузер 24».

Важно знать (это ограничения самих браузеров, а не кода):
  • Android (Chrome и др. на Chromium) — модель приходит точно через Client Hints.
  • iPhone / iPad — Apple НЕ сообщает модель. Мы определяем её по размеру экрана и
    версии iOS, поэтому результат — группа вероятных моделей (confidence = "group"/"likely").
  • Mac — браузер отдаёт только «Mac», без модели.
"""
import re

# ── iPhone: (ширина, высота, DPR) -> [(модель, минимальная iOS)] от новых к старым ──
_IPHONES = {
    (320, 568, 2): [("iPhone SE (1-го пок.)", 9), ("iPhone 5s", 7), ("iPhone 5", 6)],
    (375, 667, 2): [("iPhone SE (2/3-го пок.)", 13), ("iPhone 8", 11), ("iPhone 7", 10), ("iPhone 6s", 9), ("iPhone 6", 8)],
    (414, 736, 3): [("iPhone 8 Plus", 11), ("iPhone 7 Plus", 10), ("iPhone 6s Plus", 9), ("iPhone 6 Plus", 8)],
    (375, 812, 3): [("iPhone 13 mini", 15), ("iPhone 12 mini", 14), ("iPhone 11 Pro", 13), ("iPhone XS", 12), ("iPhone X", 11)],
    (414, 896, 3): [("iPhone 11 Pro Max", 13), ("iPhone XS Max", 12)],
    (414, 896, 2): [("iPhone 11", 13), ("iPhone XR", 12)],
    (390, 844, 3): [("iPhone 16e", 18), ("iPhone 14", 16), ("iPhone 13", 15), ("iPhone 13 Pro", 15), ("iPhone 12", 14), ("iPhone 12 Pro", 14)],
    (428, 926, 3): [("iPhone 14 Plus", 16), ("iPhone 13 Pro Max", 15), ("iPhone 12 Pro Max", 14)],
    (393, 852, 3): [("iPhone 16", 18), ("iPhone 15 Pro", 17), ("iPhone 15", 17), ("iPhone 14 Pro", 16)],
    (430, 932, 3): [("iPhone 16 Plus", 18), ("iPhone 15 Pro Max", 17), ("iPhone 15 Plus", 17), ("iPhone 14 Pro Max", 16)],
    (402, 874, 3): [("iPhone 17 Pro", 18), ("iPhone 17", 18), ("iPhone 16 Pro", 18)],
    (440, 956, 3): [("iPhone 17 Pro Max", 18), ("iPhone 16 Pro Max", 18)],
    (420, 912, 3): [("iPhone Air", 18)],
}

# ── iPad: (ширина, высота, DPR) -> описание группы ──
_IPADS = {
    (768, 1024, 2): "iPad / iPad mini (старые) / Air 1-2 / Pro 9.7″",
    (810, 1080, 2): "iPad 7–9 (10.2″)",
    (820, 1180, 2): "iPad Air 4–5 / iPad 10 (10.9″)",
    (834, 1112, 2): "iPad Pro 10.5″ / Air 3",
    (834, 1194, 2): "iPad Pro 11″",
    (744, 1133, 2): "iPad mini 6–7 (8.3″)",
    (1024, 1366, 2): "iPad Pro 12.9″",
    (820, 1180, 3): "iPad Air 11″ (M2/M3)",
    (834, 1210, 2): "iPad Pro 11″ (M4)",
    (1032, 1376, 2): "iPad Pro 13″ (M4)",
}

# ── Samsung: префикс модели -> маркетинговое название ──
_SAMSUNG = {
    "S938": "Galaxy S25 Ultra", "S936": "Galaxy S25+", "S931": "Galaxy S25",
    "S928": "Galaxy S24 Ultra", "S926": "Galaxy S24+", "S921": "Galaxy S24", "S721": "Galaxy S24 FE",
    "S918": "Galaxy S23 Ultra", "S916": "Galaxy S23+", "S911": "Galaxy S23", "S711": "Galaxy S23 FE",
    "S908": "Galaxy S22 Ultra", "S906": "Galaxy S22+", "S901": "Galaxy S22",
    "G998": "Galaxy S21 Ultra", "G996": "Galaxy S21+", "G991": "Galaxy S21", "G990": "Galaxy S21 FE",
    "G988": "Galaxy S20 Ultra", "G985": "Galaxy S20+", "G981": "Galaxy S20", "G781": "Galaxy S20 FE",
    "A566": "Galaxy A56", "A556": "Galaxy A55", "A546": "Galaxy A54", "A536": "Galaxy A53", "A526": "Galaxy A52 5G", "A525": "Galaxy A52",
    "A366": "Galaxy A36", "A356": "Galaxy A35", "A346": "Galaxy A34", "A336": "Galaxy A33", "A326": "Galaxy A32 5G", "A325": "Galaxy A32",
    "A256": "Galaxy A25", "A236": "Galaxy A23", "A226": "Galaxy A22 5G", "A225": "Galaxy A22",
    "A166": "Galaxy A16", "A165": "Galaxy A16", "A156": "Galaxy A15 5G", "A155": "Galaxy A15", "A146": "Galaxy A14 5G", "A145": "Galaxy A14",
    "A137": "Galaxy A13", "A135": "Galaxy A13", "A127": "Galaxy A12", "A125": "Galaxy A12",
    "A057": "Galaxy A05s", "A055": "Galaxy A05", "A047": "Galaxy A04s", "A045": "Galaxy A04",
    "A725": "Galaxy A72", "A715": "Galaxy A71", "A515": "Galaxy A51", "A217": "Galaxy A21s",
    "F956": "Galaxy Z Fold6", "F946": "Galaxy Z Fold5", "F936": "Galaxy Z Fold4",
    "F741": "Galaxy Z Flip6", "F731": "Galaxy Z Flip5", "F721": "Galaxy Z Flip4",
    "M546": "Galaxy M54", "M536": "Galaxy M53", "M346": "Galaxy M34", "M236": "Galaxy M23",
}

_BRAND_TOKENS = [
    ("Redmi", "Xiaomi"), ("POCO", "Xiaomi"), ("Xiaomi", "Xiaomi"), ("Mi ", "Xiaomi"),
    ("HUAWEI", "Huawei"), ("HONOR", "Honor"), ("OPPO", "OPPO"), ("vivo", "vivo"), ("realme", "realme"),
    ("OnePlus", "OnePlus"), ("Nokia", "Nokia"), ("Infinix", "Infinix"), ("TECNO", "TECNO"),
    ("moto", "Motorola"), ("Pixel", "Google"), ("ASUS", "ASUS"), ("Sony", "Sony"), ("itel", "itel"),
]


def _ios_major(ua):
    m = re.search(r"OS (\d+)[_.](\d+)", ua or "")
    return int(m.group(1)) if m else None


def _samsung_name(code):
    m = re.match(r"SM-([A-Z]\d{3})", code or "", re.I)
    if not m:
        return None
    return _SAMSUNG.get(m.group(1).upper())


def _browser(ua):
    """Название и версия браузера (с учётом российских: Яндекс, Atom, VK)."""
    rules = [
        (r"YaBrowser/([\d.]+)", "Яндекс.Браузер"), (r"Edg(?:e|A|iOS)?/([\d.]+)", "Edge"),
        (r"OPR/([\d.]+)", "Opera"), (r"SamsungBrowser/([\d.]+)", "Samsung Internet"),
        (r"MiuiBrowser/([\d.]+)", "Mi Browser"), (r"UCBrowser/([\d.]+)", "UC Browser"),
        (r"Firefox/([\d.]+)", "Firefox"), (r"FxiOS/([\d.]+)", "Firefox"),
        (r"CriOS/([\d.]+)", "Chrome"), (r"Chrome/([\d.]+)", "Chrome"),
    ]
    in_app = ""
    if re.search(r"Instagram", ua or ""):
        in_app = " (внутри Instagram)"
    elif re.search(r"FBAN|FBAV", ua or ""):
        in_app = " (внутри Facebook)"
    elif re.search(r"Telegram", ua or ""):
        in_app = " (внутри Telegram)"
    elif re.search(r"VKAndroidApp|VKClient|vkAndroid", ua or ""):
        in_app = " (внутри VK)"
    for rx, name in rules:
        m = re.search(rx, ua or "")
        if m:
            return name + in_app, m.group(1).split(".")[0]
    m = re.search(r"Version/([\d.]+).*Safari", ua or "")
    if m:
        return "Safari" + in_app, m.group(1).split(".")[0]
    if "Safari" in (ua or ""):
        return "Safari" + in_app, ""
    return ("Другой" + in_app), ""


def describe(ua, info=None):
    """
    ua   — строка User-Agent.
    info — данные из браузера: screen_w, screen_h, dpr, touch, model, platform, platform_ver, ...
    Возвращает словарь с понятным названием устройства.
    """
    ua = ua or ""
    info = info or {}
    out = {"device_name": "Неизвестное устройство", "brand": "", "model_raw": "", "device_type": "unknown",
           "os": "", "os_version": "", "confidence": "unknown", "hint": ""}
    out["browser"], out["browser_version"] = _browser(ua)

    sw, sh = int(info.get("screen_w") or 0), int(info.get("screen_h") or 0)
    dpr = round(float(info.get("dpr") or 0))
    w, h = (min(sw, sh), max(sw, sh)) if sw and sh else (0, 0)
    touch = int(info.get("touch") or 0)
    is_ipad_desktop = "Macintosh" in ua and touch > 1          # iPadOS в «режиме сайта для ПК»

    # ── iPhone ──
    if "iPhone" in ua or "iPod" in ua:
        major = _ios_major(ua)
        out.update(brand="Apple", device_type="mobile", os="iOS", os_version=str(major or ""))
        cands = _IPHONES.get((w, h, dpr), [])
        if major and major < 18:       # при iOS ≥ 18 версию в UA не считаем надёжной
            cands = [c for c in cands if c[1] <= major]
        names = [c[0] for c in cands]
        if len(names) == 1:
            out.update(device_name=names[0], confidence="likely", hint="Модель определена по размеру экрана")
        elif names:
            out.update(device_name=" / ".join(n.replace("iPhone ", "") for n in names[:4]),
                       confidence="group",
                       hint="Apple скрывает точную модель — это варианты с таким экраном")
            out["device_name"] = "iPhone " + out["device_name"]
        else:
            out.update(device_name="iPhone", confidence="group", hint="Модель по экрану определить не удалось")
        return out

    # ── iPad ──
    if "iPad" in ua or is_ipad_desktop:
        out.update(brand="Apple", device_type="tablet", os="iPadOS", os_version=str(_ios_major(ua) or ""))
        grp = _IPADS.get((w, h, dpr))
        out.update(device_name=("iPad · " + grp) if grp else "iPad", confidence="group" if grp else "unknown",
                   hint="Apple скрывает точную модель")
        return out

    # ── Android ──
    m = re.search(r"Android\s+([\d.]+)", ua)
    if m:
        out.update(os="Android", os_version=m.group(1).split(".")[0])
        raw = (info.get("model") or "").strip()
        if not raw:
            mm = re.search(r";\s*([^;)]+?)\s+Build/", ua) or re.search(r"Android\s+[\d.]+;\s*([^;)]+)\)", ua)
            raw = (mm.group(1).strip() if mm else "")
        if raw in ("K", "k"):          # Chrome «замораживает» модель в UA
            raw = ""
        out["model_raw"] = raw
        mobile = "Mobile" in ua
        out["device_type"] = "mobile" if mobile else "tablet"
        brand, name = "", ""
        if raw.upper().startswith("SM-"):
            brand = "Samsung"
            name = _samsung_name(raw) and ("Samsung " + _samsung_name(raw))
        if not brand:
            for tok, b in _BRAND_TOKENS:
                if tok.lower() in raw.lower() or tok.lower() in ua.lower().split("build/")[0][-60:]:
                    brand = b
                    break
        if raw:
            if name:
                out.update(device_name=name, confidence="exact")
            elif brand and raw.lower().startswith(brand.lower()):
                out.update(device_name=raw, confidence="exact")
            elif brand:
                out.update(device_name=f"{brand} {raw}", confidence="exact" if brand != "Samsung" else "likely")
            else:
                out.update(device_name=f"Android · {raw}", confidence="likely")
            if name is None or (not name and brand == "Samsung"):
                out["hint"] = "Код модели не в справочнике: " + raw
        else:
            out.update(device_name="Android-устройство", confidence="unknown",
                       hint="Браузер скрыл модель (нужен Chrome/Яндекс на HTTPS)")
        out["brand"] = brand
        return out

    # ── Компьютеры ──
    out["device_type"] = "desktop"
    if "Windows" in ua:
        ver = "10"
        pv = str(info.get("platform_ver") or "")
        try:
            if pv and int(pv.split(".")[0]) >= 13:
                ver = "11"
        except ValueError:
            pass
        out.update(os="Windows", os_version=ver, device_name=f"ПК · Windows {ver}", confidence="group")
    elif "Macintosh" in ua or "Mac OS X" in ua:
        out.update(os="macOS", device_name="Mac", brand="Apple", confidence="group",
                   hint="Браузер не сообщает модель Mac")
    elif "CrOS" in ua:
        out.update(os="ChromeOS", device_name="Chromebook", confidence="group")
    elif "Linux" in ua:
        out.update(os="Linux", device_name="ПК · Linux", confidence="group")
    if out["os"]:
        out["device_name"] += f" · {out['browser']}"
    return out
