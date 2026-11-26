"""Draws synthetic wine-list images with known text for the on-device OCR check.

Each fixture is written as NAME.jpg (or .png) plus NAME.txt, the clean text in
reading order. The check parses NAME.txt with the server parser to get the
reference wines, so no hand labels are needed. Wine names are real producers,
but the lists themselves are invented. Run from the repo root:

    python3 ios/Tests/OCRFixtures/generate_synthetic_lists.py
"""
import math
import os
import random

from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = os.path.dirname(os.path.abspath(__file__))
FONTS = [
    "/usr/share/fonts/truetype/dejavu/",
    "/usr/share/fonts/truetype/liberation/",
    "/System/Library/Fonts/Supplemental/",
    "/Library/Fonts/",
]


def font(names, size):
    for directory in FONTS:
        for name in names:
            path = os.path.join(directory, name)
            if os.path.exists(path):
                return ImageFont.truetype(path, size)
    raise SystemExit(f"none of {names} found")


SANS = ["DejaVuSans.ttf", "LiberationSans-Regular.ttf", "Arial.ttf"]
SANS_BOLD = ["DejaVuSans-Bold.ttf", "LiberationSans-Bold.ttf", "Arial Bold.ttf"]
SERIF = ["LiberationSerif-Regular.ttf", "DejaVuSerif.ttf", "Times New Roman.ttf"]
SERIF_ITALIC = ["LiberationSerif-Italic.ttf", "DejaVuSerif-Italic.ttf", "Times New Roman Italic.ttf"]
SERIF_BOLD = ["LiberationSerif-Bold.ttf", "DejaVuSerif-Bold.ttf", "Times New Roman Bold.ttf"]


def photo_degrade(image, rng, angle, blur, quality_path, perspective=0.0, shadow=0.35):
    """Paper photographed on a table: tilt, keystone, uneven light, blur, JPEG."""
    width, height = image.size
    canvas = Image.new("RGB", (int(width * 1.12), int(height * 1.08)), (58, 50, 44))
    canvas.paste(image, ((canvas.width - width) // 2, (canvas.height - height) // 2))
    canvas = canvas.rotate(angle, resample=Image.BICUBIC, fillcolor=(58, 50, 44))
    if perspective:
        w, h = canvas.size
        d = perspective * w
        # Map output corners to a slightly narrower top edge (camera below the page).
        src = [(d, 0), (w - d, 0), (w, h), (0, h)]
        dst = [(0, 0), (w, 0), (w, h), (0, h)]
        coeffs = _perspective_coeffs(dst, src)
        canvas = canvas.transform((w, h), Image.PERSPECTIVE, coeffs, Image.BICUBIC, fillcolor=(58, 50, 44))
    light = Image.new("L", canvas.size)
    pixels = light.load()
    for y in range(0, canvas.height, 4):
        for x in range(0, canvas.width, 4):
            value = int(255 * (1 - shadow * (x / canvas.width) * (0.6 + 0.4 * y / canvas.height)))
            for dy in range(4):
                for dx in range(4):
                    if x + dx < canvas.width and y + dy < canvas.height:
                        pixels[x + dx, y + dy] = value
    canvas = Image.composite(canvas, Image.new("RGB", canvas.size, (0, 0, 0)), light)
    canvas = canvas.filter(ImageFilter.GaussianBlur(blur))
    noise = Image.effect_noise(canvas.size, 18).convert("RGB")
    canvas = Image.blend(canvas, noise, 0.06)
    canvas.save(quality_path, quality=72)


def _perspective_coeffs(target, source):
    import numpy  # only needed for keystone

    matrix = []
    for (x, y), (u, v) in zip(target, source):
        matrix.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        matrix.append([0, 0, 0, x, y, 1, -v * x, -v * y])
    a = numpy.array(matrix, dtype=float)
    b = numpy.array(source, dtype=float).reshape(8)
    return numpy.linalg.solve(a, b).tolist()


def glass_and_bottle(rng):
    sections = [
        ("BY THE GLASS", None),
        ("Sparkling", [
            ("Raventós i Blanc 'Blanc de Blancs' Penedès, Spain 2021", "16 / 64"),
            ("Pierre Gimonnet 'Cuis 1er Cru' Champagne, France", "24 / 98"),
        ]),
        ("White", [
            ("Domaine Weinbach 'Clos des Capucins' Riesling, Alsace 2021", "17 / 68"),
            ("Ameztoi 'Rubentis' Txakolina, Spain 2023", "13 / 52"),
            ("Arnot-Roberts Chardonnay, Sonoma Coast 2022", "19 / 76"),
        ]),
        ("Orange", [
            ("Radikon 'Slatnik' Friuli, Italy 2020", "18 / 72"),
        ]),
        ("Red", [
            ("Domaine Dupeuble Beaujolais, France 2022", "14 / 56"),
            ("Cantina Terre Nere 'Etna Rosso' Sicily, Italy 2021", "16 / 64"),
            ("Bodegas Muga 'Reserva' Rioja, Spain 2019", "18 / 72"),
            ("Frank Cornelissen 'Susucaru' Sicily, Italy 2022", "17 / 68"),
        ]),
    ]
    image = Image.new("RGB", (1500, 1900), (244, 238, 224))
    draw = ImageDraw.Draw(image)
    title, heading, body = font(SANS_BOLD, 54), font(SANS_BOLD, 40), font(SANS, 33)
    y, lines = 90, []
    for name, wines in sections:
        if wines is None:
            draw.text((110, y), name, font=title, fill=(40, 34, 30))
            lines.append(name)
            y += 110
            continue
        draw.text((110, y), name, font=heading, fill=(120, 40, 36))
        lines.append(name)
        y += 64
        for wine, price in wines:
            draw.text((110, y), wine, font=body, fill=(36, 32, 30))
            draw.text((1390 - draw.textlength(price, font=body), y), price, font=body, fill=(36, 32, 30))
            lines.append(f"{wine} {price}")
            y += 54
        y += 40
    return image, lines


def dot_leaders(rng):
    sections = [
        ("WHITE", [
            ("Domaine Huet 'Le Haut-Lieu' Sec", "Vouvray, France 2020", "78"),
            ("Pieropan 'La Rocca' Soave Classico", "Veneto, Italy 2021", "66"),
            ("Hirsch 'Heiligenstein' Grüner Veltliner", "Kamptal, Austria 2021", "71"),
            ("Domaine Leflaive Mâcon-Verzé", "Burgundy, France 2022", "95"),
        ]),
        ("RED", [
            ("Ridge 'Lytton Springs' Zinfandel", "Sonoma, California 2019", "92"),
            ("Bernard Baudry 'Les Grézeaux' Chinon", "Loire Valley, France 2020", "64"),
            ("Vietti 'Castiglione' Barolo", "Piedmont, Italy 2019", "140"),
            ("Domaine Tempier Bandol Rouge", "Provence, France 2020", "98"),
            ("López de Heredia 'Viña Bosconia' Reserva", "Rioja, Spain 2012", "115"),
        ]),
    ]
    image = Image.new("RGB", (1400, 1950), (252, 250, 246))
    draw = ImageDraw.Draw(image)
    heading, body, note = font(SERIF_BOLD, 46), font(SERIF, 36), font(SERIF_ITALIC, 30)
    y, lines = 110, []
    for name, wines in sections:
        draw.text(((1400 - draw.textlength(name, font=heading)) / 2, y), name, font=heading, fill=(20, 20, 20))
        lines.append(name)
        y += 90
        for wine, origin, price in wines:
            left = 120
            end = draw.textlength(wine, font=body) + left
            price_x = 1280 - draw.textlength(price, font=body)
            draw.text((left, y), wine, font=body, fill=(20, 20, 20))
            dots = "." * int((price_x - end - 30) / draw.textlength(".", font=body))
            draw.text((end + 12, y), dots, font=body, fill=(90, 90, 90))
            draw.text((price_x, y), price, font=body, fill=(20, 20, 20))
            draw.text((left + 20, y + 46), origin, font=note, fill=(80, 80, 80))
            lines.append(f"{wine} {price}")
            lines.append(origin)
            y += 112
        y += 50
    return image, lines


def product_grid(rng):
    products = [
        ("Domaine de la Grange Tiphaine 'Clef de Sol' Montlouis", "$32.99"),
        ("Gramenon 'Poignée de Raisins' Côtes du Rhône", "$27.99"),
        ("Bichi 'Pet-Mex' Tecate Rosé", "$29.99"),
        ("Las Jaras 'Waves' Red Wine", "$26.99"),
        ("Envínate 'Táganan' Tinto Canary Islands", "$34.99"),
        ("Brand 'Pet Nat' Weiss", "$22.99"),
        ("Pax Mahle 'Buddha's Dharma' Chenin Blanc", "$44.99"),
        ("Christian Tschida 'Himmel auf Erden' Rosé", "$38.99"),
        ("Clos Cibonne 'Tibouren' Côtes de Provence", "$31.99"),
    ]
    image = Image.new("RGB", (1600, 1500), (255, 255, 255))
    draw = ImageDraw.Draw(image)
    toolbar, title, price_font = font(SANS, 26), font(SANS, 27), font(SANS, 32)
    draw.text((50, 22), "Filter:  Product type   Price   Country", font=toolbar, fill=(60, 60, 60))
    draw.text((1050, 22), "Sort by:  Best selling     243 products", font=toolbar, fill=(60, 60, 60))
    lines = []
    for index, (name, price) in enumerate(products):
        col, row = index % 3, index // 3
        x, y = 50 + col * 520, 90 + row * 470
        draw.rectangle((x, y, x + 470, y + 300), fill=(232, 233, 236))
        draw.rounded_rectangle((x + 15, y + 250, x + 140, y + 288), radius=18, fill=(40, 40, 50))
        draw.text((x + 30, y + 255), "Sold out", font=toolbar, fill=(255, 255, 255))
        words, row_lines, current = name.split(), [], ""
        for word in words:
            trial = f"{current} {word}".strip()
            if draw.textlength(trial, font=title) > 460:
                row_lines.append(current)
                current = word
            else:
                current = trial
        row_lines.append(current)
        ty = y + 320
        for text in row_lines:
            draw.text((x, ty), text, font=title, fill=(20, 20, 20))
            ty += 36
        draw.text((x, ty + 6), price, font=price_font, fill=(20, 20, 20))
        lines.append(f"{name} {price}")
    return image, lines


def dense_two_column(rng):
    left = [
        ("Sparkling", None),
        ("Bérêche 'Brut Réserve' Champagne", "110"),
        ("Cleto Chiarli Lambrusco di Sorbara", "48"),
        ("Domaine Mosse 'Moussamoussettes'", "62"),
        ("White", None),
        ("Domaine Ostertag 'Vignoble d'E' Sylvaner", "54"),
        ("Benanti 'Etna Bianco' Sicily", "58"),
        ("Do Ferreiro Albariño Rías Baixas", "61"),
        ("Matassa 'Cuvée Alexandria' Roussillon", "69"),
        ("Domaine Roulot Bourgogne Blanc", "125"),
        ("Rosé", None),
        ("Château Simone Palette Rosé", "96"),
    ]
    right = [
        ("Red", None),
        ("Jean Foillard 'Côte du Py' Morgon", "88"),
        ("Thierry Allemand 'Chaillot' Cornas", "240"),
        ("Occhipinti 'SP68' Rosso", "57"),
        ("Bodegas Tradición Palo Cortado", "84"),
        ("Clos Rougeard 'Le Bourg' Saumur", "380"),
        ("Arianna Occhipinti 'Il Frappato'", "79"),
        ("G.D. Vajra 'Albe' Barolo", "105"),
        ("Domaine Gramenon 'La Sagesse'", "92"),
        ("Sweet", None),
        ("Château Coutet Barsac 2015", "72"),
        ("Oremus 'Tokaji Aszú 5 Puttonyos'", "118"),
    ]
    image = Image.new("RGB", (1700, 1300), (247, 244, 236))
    draw = ImageDraw.Draw(image)
    heading, body = font(SANS_BOLD, 30), font(SANS, 26)
    lines = []
    for column, entries in ((0, left), (1, right)):
        x0, price_right = 70 + column * 830, 760 + column * 830
        y = 70
        for name, price in entries:
            if price is None:
                draw.text((x0, y), name, font=heading, fill=(110, 30, 30))
                lines.append(name)
                y += 56
                continue
            draw.text((x0, y), name, font=body, fill=(30, 30, 30))
            draw.text((price_right - draw.textlength(price, font=body), y), price, font=body, fill=(30, 30, 30))
            lines.append(f"{name} {price}")
            y += 46
    return image, lines


def main():
    rng = random.Random(20261126)
    fixtures = {
        "synthetic-glass-and-bottle-photo": (glass_and_bottle, dict(angle=2.2, blur=1.1, perspective=0.025)),
        "synthetic-dot-leaders-serif": (dot_leaders, None),
        "synthetic-product-grid": (product_grid, None),
        "synthetic-dense-two-column-photo": (dense_two_column, dict(angle=-1.4, blur=0.9, perspective=0.02, shadow=0.45)),
    }
    for name, (draw, photo) in fixtures.items():
        image, lines = draw(rng)
        if photo:
            photo_degrade(image, rng, quality_path=os.path.join(OUT, f"{name}.jpg"), **photo)
        else:
            image.save(os.path.join(OUT, f"{name}.png"))
        with open(os.path.join(OUT, f"{name}.txt"), "w", encoding="utf-8") as handle:
            handle.write("\n".join(lines) + "\n")
        print("wrote", name)


if __name__ == "__main__":
    main()
