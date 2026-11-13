"""
Builds the launcher's artwork from the games' own assets.

Everything this script writes goes to ../assets. Sources live in the game
folders one level up (sibling of the launcher folder).

  python tools/build_assets.py
"""
import os
import sys

import lettering

from PIL import Image, ImageFilter, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)              # CollapseLauncher/
BASE = os.path.dirname(ROOT)              # folder holding the games
ASSETS = os.path.join(ROOT, "assets")
SOURCE = os.path.join(ASSETS, "source")     # artwork lifted out of the games

BOX_W, BOX_H = 440, 430


def p(*parts):
    return os.path.join(BASE, *parts)


def art(name):
    return os.path.join(SOURCE, name)


def load(path):
    return Image.open(path).convert("RGBA")


def trim(im, pad=0):
    bbox = im.split()[-1].getbbox()
    if not bbox:
        return im
    x0, y0, x1, y1 = bbox
    x0, y0 = max(0, x0 - pad), max(0, y0 - pad)
    x1, y1 = min(im.width, x1 + pad), min(im.height, y1 + pad)
    return im.crop((x0, y0, x1, y1))


def fit(im, max_w, max_h):
    r = min(max_w / im.width, max_h / im.height)
    return im.resize((max(1, int(im.width * r)), max(1, int(im.height * r))), Image.LANCZOS)


def rounded_mask(size, radius, inner=None):
    m = Image.new("L", size, 0)
    box = inner or (0, 0, size[0] - 1, size[1] - 1)
    ImageDraw.Draw(m).rounded_rectangle(box, radius, fill=255)
    return m


def cover(im, size):
    r = max(size[0] / im.width, size[1] / im.height)
    im = im.resize((int(im.width * r + 0.5), int(im.height * r + 0.5)), Image.LANCZOS)
    left = (im.width - size[0]) // 2
    top = (im.height - size[1]) // 2
    return im.crop((left, top, left + size[0], top + size[1]))


def drop_shadow(art, box, radius=14, blur=10, alpha=100):
    shadow = Image.new("RGBA", art.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(box, radius, fill=(0, 0, 0, alpha))
    art.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(blur)))


# --------------------------------------------------------------------------
# block sprites
# --------------------------------------------------------------------------
PALETTES = ("base", "jungle", "garden", "ocean", "desert", "city", "snow", "alien")
CUBE_FRAMES = 7          # the first frames of every palette strip are plain cubes
_cache = {}


def blocks(palette):
    if palette in _cache:
        return _cache[palette]
    strip = load(p("collapse!", "images", "scenegamebase", f"game_blocks_palette_{palette}.png"))
    tiles, step = [], 45
    for y in range(0, min(strip.height, CUBE_FRAMES * step), step):
        for x in range(0, strip.width - step + 1, step):
            tile = strip.crop((x, y, x + step, y + step))
            if tile.split()[-1].getextrema()[1] > 200:
                tiles.append(tile)
    _cache[palette] = tiles
    return tiles


def mosaic(palette, size, seed=0, zoom=1.9):
    """A wall of the game's own cube sprites, tilted, shaded towards the bottom."""
    tw = int(45 * zoom)
    canvas = Image.new("RGBA", (size[0] + tw * 3, size[1] + tw * 3), (18, 24, 44, 255))
    tiles = blocks(palette)
    cols = canvas.width // tw + 2
    rows = canvas.height // tw + 2
    n = len(tiles)
    for r in range(rows):
        for cc in range(cols):
            i = (seed * 13 + r * 7 + cc * 5 + r * cc) % n
            canvas.alpha_composite(tiles[i].resize((tw, tw), Image.LANCZOS), (cc * tw, r * tw))
    canvas = canvas.rotate(-8, resample=Image.BICUBIC, expand=False)
    left = (canvas.width - size[0]) // 2
    top = (canvas.height - size[1]) // 2
    canvas = canvas.crop((left, top, left + size[0], top + size[1])).convert("RGB")

    shade = Image.new("L", size, 0)
    d = ImageDraw.Draw(shade)
    for y in range(size[1]):
        t = y / size[1]
        d.line([(0, y), (size[0], y)], fill=int(215 * max(0.0, (t - 0.30) / 0.70) ** 1.5))
    dark = Image.new("RGB", size, (10, 14, 32))
    return Image.composite(dark, canvas, shade).convert("RGBA")


# --------------------------------------------------------------------------
# background
# --------------------------------------------------------------------------
def build_background(size=(1680, 1050)):
    W, H = size
    sel = lambda name: p("collapse!", "images", "sceneselection", name)

    bg = Image.new("RGB", size, (0, 0, 0))
    d = ImageDraw.Draw(bg)
    top, bottom = (96, 202, 236), (203, 241, 245)
    horizon = int(H * 0.74)
    for y in range(H):
        t = min(1.0, y / horizon)
        d.line([(0, y), (W, y)], fill=tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))

    mid = load(sel("MidGroundPlane.png"))
    mid = mid.resize((W, int(mid.height * W / mid.width)), Image.LANCZOS)
    bg.paste(mid, (0, H - mid.height), mid)

    # palms framing the sides, kept dark so the middle stays readable
    for name, scale, pos in (("Tree6.png", 1.7, (-90, H - 620)), ("Tree8.png", 1.5, (W - 300, H - 560))):
        t = load(sel(name))
        t = t.resize((int(t.width * scale), int(t.height * scale)), Image.LANCZOS)
        t = t.filter(ImageFilter.GaussianBlur(2.5))
        bg.paste(t, pos, t)

    bg = bg.filter(ImageFilter.GaussianBlur(1.0))

    rays = load(sel("LightRays.png"))
    rays = rays.resize((W, int(rays.height * W / rays.width)), Image.LANCZOS)
    mask = Image.new("L", size, 0)
    mask.paste(rays.split()[-1], (0, H - rays.height))
    bg = Image.composite(Image.new("RGB", size, (255, 248, 205)), bg,
                         mask.point(lambda v: int(v * 0.45)))

    vig = Image.new("L", size, 0)
    ImageDraw.Draw(vig).ellipse((-W * 0.3, -H * 0.4, W * 1.3, H * 1.3), fill=255)
    vig = vig.filter(ImageFilter.GaussianBlur(170))
    vig = vig.point(lambda v: 255 - int((255 - v) * 0.55))
    bg = Image.composite(bg, Image.new("RGB", size, (20, 54, 62)), vig)

    out = os.path.join(ASSETS, "background.jpg")
    bg.save(out, quality=88)
    return out


# --------------------------------------------------------------------------
# boxes
# --------------------------------------------------------------------------
def finish(art):
    bevel = Image.new("RGBA", art.size, (0, 0, 0, 0))
    bd = ImageDraw.Draw(bevel)
    bd.rounded_rectangle((2, 2, BOX_W - 3, BOX_H - 3), 12, outline=(255, 255, 255, 80), width=3)
    bd.rounded_rectangle((1, 1, BOX_W - 2, BOX_H - 2), 12, outline=(0, 0, 0, 110), width=1)
    art.alpha_composite(bevel)
    art.putalpha(rounded_mask((BOX_W, BOX_H), 12))
    return art


def place_logo(art, layers, center=0.40, max_w=0.88, max_h=0.44, gap=4):
    """Draw one or more logo images stacked on the box, with a soft shadow."""
    imgs = [fit(trim(load(path)), int(BOX_W * max_w), int(BOX_H * max_h * 0.62)) for path in layers]
    group_w = max(i.width for i in imgs)
    group_h = sum(i.height for i in imgs) + gap * (len(imgs) - 1)
    x = (BOX_W - group_w) // 2
    y = int(BOX_H * center) - group_h // 2
    drop_shadow(art, (x - 14, y - 10, x + group_w + 14, y + group_h + 12), 16, 12, 110)
    cy = y
    for im in imgs:
        art.alpha_composite(im, ((BOX_W - im.width) // 2, cy))
        cy += im.height + gap
    return y + group_h


def place_digit(art, path, right_of_w, center_y, max_w=0.24, max_h=0.24):
    digit = fit(trim(load(path)), int(BOX_W * max_w), int(BOX_H * max_h))
    x = right_of_w + 10
    y = center_y - digit.height // 2
    drop_shadow(art, (x - 6, y - 4, x + digit.width + 6, y + digit.height + 6), 12, 8, 110)
    art.alpha_composite(digit, (x, y))


def place_badge(art, badge, center=0.42, max_w=0.92, max_h=0.52):
    """A rounded sticker lifted from a game's own screen art."""
    img = fit(badge, int(BOX_W * max_w), int(BOX_H * max_h))
    x = (BOX_W - img.width) // 2
    y = int(BOX_H * center) - img.height // 2
    drop_shadow(art, (x - 8, y - 6, x + img.width + 8, y + img.height + 8), 16, 11, 120)
    art.alpha_composite(img, (x, y))


def title_badge(crop_path, box, radius=20, border=True, punch=1.0):
    im = load(crop_path).crop(box)
    if punch != 1.0:
        from PIL import ImageEnhance
        rgb = ImageEnhance.Color(ImageEnhance.Contrast(im.convert("RGB")).enhance(1.12)).enhance(punch)
        im = Image.merge("RGBA", (*rgb.split(), im.split()[-1]))
    mask = rounded_mask(im.size, radius)
    if border:
        edge = Image.new("RGBA", im.size, (0, 0, 0, 0))
        ImageDraw.Draw(edge).rounded_rectangle((0, 0, im.size[0] - 1, im.size[1] - 1), radius,
                                               outline=(255, 255, 255, 210), width=4)
        im.alpha_composite(edge)
    im.putalpha(mask)
    return im


def build_box(name, palette, seed, logos=None, digit=None, badge=None, center=0.40, cover_face=None):
    art = cover_face.convert("RGBA") if cover_face is not None else mosaic(palette, (BOX_W, BOX_H), seed=seed)
    if badge is not None:
        place_badge(art, badge, center=center)
    if logos:
        bottom = place_logo(art, logos, center=center)
        if digit:
            place_digit(art, digit, (BOX_W + max(
                fit(trim(load(x)), int(BOX_W * 0.88), int(BOX_H * 0.44 * 0.62)).width
                for x in logos)) // 2, (bottom + int(BOX_H * center)) // 2 - int(BOX_H * 0.16))
    out = os.path.join(ASSETS, "boxes", name + ".png")
    finish(art).save(out)
    return out


def padded_cover(path, size=None, pad_color=None, inset=6):
    """A full-bleed cover: keeps the whole artwork, filling the leftover
    height with the artwork's own frame colour."""
    size = size or (BOX_W, BOX_H)
    im = load(path)
    if inset:
        im = im.crop((inset, inset, im.width - inset, im.height - inset))
    if pad_color is None:
        pad_color = im.convert("RGB").getpixel((im.width // 2, 1))
    r = size[0] / im.width
    im = im.resize((size[0], int(im.height * r)), Image.LANCZOS)
    canvas = Image.new("RGBA", size, (*pad_color, 255))
    canvas.alpha_composite(im, (0, (size[1] - im.height) // 2))
    return canvas


def build_app_icon():
    logo = trim(load(p("collapse!", "images", "sceneselection", "Logo.png")))
    logo = cover(logo, (256, 256))
    logo.save(os.path.join(ASSETS, "icon.png"))
    logo.save(os.path.join(ASSETS, "icon.ico"), sizes=[(16, 16), (32, 32), (48, 48), (256, 256)])
    return os.path.join(ASSETS, "icon.ico")


def main():
    os.makedirs(os.path.join(ASSETS, "boxes"), exist_ok=True)
    print(build_background())
    for path in lettering.build(ASSETS):
        print(path)
    print(build_app_icon())
    print(build_box("default", "base", 11))

    print(build_box("collapse", "jungle", 3, center=0.44,
                    logos=[p("collapse!", "images", "sceneselection", "Logo.png")]))

    sc2 = title_badge(art("sc2-title.png"), (128, 82, 540, 344))
    print(build_box("sc2", "base", 1, badge=sc2, center=0.40))

    sc3 = title_badge(art("sc3-title.png"), (52, 62, 772, 214), radius=20, punch=1.35)
    print(build_box("sc3", "ocean", 5, badge=sc3, center=0.40))

    sc1 = title_badge(art("sc1-title.png"), (140, 45, 580, 265), radius=20)
    print(build_box("sc1", "desert", 9, badge=sc1, center=0.40))

    crunch = title_badge(art("crunch-title.png"), (133, 6, 467, 219), radius=18)
    print(build_box("crunch", "alien", 10, badge=crunch, center=0.40))

    print(build_box("spongebob", "ocean", 12,
                    cover_face=padded_cover(art("spongebob-cover.png"))))

    print(build_box("puzzle-gallery", "garden", 2,
                    logos=[art("pg1-super-collapse.png"), art("pg1-puzzle-gallery.png")]))
    print(build_box("puzzle-gallery-2", "city", 6, logos=[art("pg2-logo.png")]))
    print(build_box("puzzle-gallery-3", "desert", 4,
                    logos=[art("pg3-logo.png")], digit=art("pg3-digit.png")))
    print(build_box("puzzle-gallery-4", "jungle", 7,
                    logos=[art("pg4-logo.png")], digit=art("pg4-digit.png")))
    print(build_box("puzzle-gallery-5", "snow", 8,
                    logos=[art("pg5-logo.png")], digit=art("pg5-digit.png")))


if __name__ == "__main__":
    sys.exit(main())
