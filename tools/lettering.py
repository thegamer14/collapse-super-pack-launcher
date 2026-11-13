"""Lettering for the launcher, taken from the game's own chamfered typeface.

The Collapse! menus draw their words from a bitmap font (fonts/header_quickplay01_base.png).
This module lifts those glyph shapes out of the atlas, scales them up into clean
edges and rebuilds the game's look — white face, purple bevel, navy outline —
so the title, subtitle and button labels all share the real letterforms.
"""
import os

import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ATLAS = os.path.join(ROOT, "collapse!", "fonts", "header_quickplay01_base.png")

# atlas band (top, bottom) and the letters on it, left to right. The atlas
# carries each letter more than once; the first clean copy of a glyph wins.
_ROWS = [
    (268, 292, "WXBCDEHJMOPRSWY"),
    (346, 369, "NUVYZAFGIKLNQTU"),
    (307, 331, "Z\u00a9\u00ae\u00d0!0467AFGIKL"),
    (229, 253, "9?BCDEHJMOPQRST"),
]

SS = 8          # how far the 25px atlas glyphs are blown up before tracing edges
SPACE = 0.34    # word space, as a fraction of the cap height

_boxes = None


def _glyph_boxes():
    global _boxes
    if _boxes is not None:
        return _boxes
    alpha = np.asarray(Image.open(ATLAS).convert("RGBA"))[:, :, 3] > 8
    _boxes = {}
    for y0, y1, letters in _ROWS:
        columns = alpha[y0:y1 + 1].any(axis=0)
        spans, start = [], None
        for x, filled in enumerate(columns):
            if filled and start is None:
                start = x
            elif not filled and start is not None:
                spans.append((start, x))
                start = None
        if start is not None:
            spans.append((start, len(columns)))
        for (x0, x1), letter in zip(spans, letters):
            _boxes.setdefault(letter, (x0, y0, x1, y1 + 1))
    return _boxes


def _glyph(letter, height):
    x0, y0, x1, y1 = _glyph_boxes()[letter]
    cell = Image.open(ATLAS).convert("RGBA").crop((x0, y0, x1, y1)).getchannel("A")
    big = cell.resize((cell.width * SS, cell.height * SS), Image.LANCZOS)
    big = big.filter(ImageFilter.GaussianBlur(SS * 0.45))
    big = big.point(lambda v: 255 if v > 128 else 0)
    scale = height / big.height
    return big.resize((max(1, round(big.width * scale)), height), Image.LANCZOS)


def render(text, height, face=(255, 255, 255), light=(125, 92, 240),
           dark=(74, 40, 176), outline=(40, 14, 118), outline_px=0,
           bevel_px=0, shadow=None, shadow_off=(0, 0), shadow_blur=0,
           track=0, space=SPACE):
    """Builds one word as a transparent RGBA image in the game's typeface."""
    glyphs = []
    x = 0.0
    for letter in text:
        if letter == " ":
            x += height * space
            continue
        if letter not in _glyph_boxes():
            continue
        glyphs.append((_glyph(letter, height), x))
        x += glyphs[-1][0].width + track

    pad = outline_px + bevel_px + max(shadow_off) + shadow_blur + 3
    width = x + pad * 2
    canvas_size = (max(1, int(round(width))), max(g.height for g, _ in glyphs) + pad * 2)

    mask = Image.new("L", canvas_size, 0)
    for glyph, gx in glyphs:
        mask.paste(glyph, (int(pad + gx), pad))

    image = Image.new("RGBA", canvas_size, (0, 0, 0, 0))

    def ring(radius, colour, offset=(0, 0)):
        shape = mask.filter(ImageFilter.MaxFilter(radius * 2 + 1))
        layer = Image.new("RGBA", canvas_size, colour)
        layer.putalpha(shape)
        if offset != (0, 0):
            layer = layer.transform(canvas_size, Image.AFFINE,
                                    (1, 0, -offset[0], 0, 1, -offset[1]))
        return layer

    if shadow is not None:
        soft = mask.filter(ImageFilter.MaxFilter(shadow_blur * 2 + 1))
        soft = soft.filter(ImageFilter.GaussianBlur(shadow_blur * 1.1))
        layer = Image.new("RGBA", canvas_size, shadow)
        layer.putalpha(soft)
        image.alpha_composite(layer, shadow_off)
    if outline_px:
        image.alpha_composite(ring(outline_px, outline))
    if bevel_px:
        image.alpha_composite(ring(bevel_px + 2, dark, (2, 2)))
        image.alpha_composite(ring(bevel_px, light, (-2, -2)))

    face_layer = Image.new("RGBA", canvas_size, face)
    face_layer.putalpha(mask)
    image.alpha_composite(face_layer)
    return image.crop(image.getbbox())


TITLE = dict(outline=(43, 21, 142), light=(152, 140, 240), dark=(58, 20, 200),
             outline_px=10, bevel_px=8, track=12,
             shadow=(22, 8, 74, 165), shadow_off=(0, 9), shadow_blur=6)

SUBTITLE = dict(outline=(43, 21, 142), light=(152, 140, 240), dark=(58, 20, 200),
                outline_px=6, bevel_px=4, track=6,
                shadow=(22, 8, 74, 165), shadow_off=(0, 5), shadow_blur=3)

LABEL = dict(outline=(13, 62, 9), light=(230, 255, 190), dark=(46, 128, 22),
             outline_px=2, bevel_px=1, track=5,
             shadow=(6, 34, 3, 110), shadow_off=(0, 2), shadow_blur=1)


def build(assets):
    """Writes the title, subtitle and button label art into the assets folder."""
    def save(name, text, height, style):
        image = render(text, height, **style)
        path = os.path.join(assets, name)
        image.save(path)
        return path

    return [
        save("title-collapse.png", "COLLAPSE!", 180, TITLE),
        save("title-superpack.png", "SUPER PACK", 84, SUBTITLE),
        save("label-play.png", "PLAY", 74, LABEL),
        save("label-locate.png", "LOCATE", 74, LABEL),
    ]
