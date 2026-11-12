"""Paints the letters: an airmail border, fold lines and, on the letter held to the lantern, the key
that the lamplight shows through the paper. Pictures are written as PNG files and loaded by path."""
import math
import os

import bpy
import numpy as np

import palette

LETTER_ASPECT = 1.2 / 0.86
PIXELS_HIGH = 736
# Where the lamplight falls on the sheet, in sheet heights from its centre, and how far it spreads.
GLOW_CENTRE = (0.0, 0.08)
GLOW_SPREAD = 0.3
KEY_TILT_DEG = 24.0


def _save(pixels, path):
    """Write an (h, w, 3) array of display values in 0..1, top row first."""
    h, w, _ = pixels.shape
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=False)
    rgba = np.concatenate([np.clip(pixels[::-1], 0.0, 1.0), np.ones((h, w, 1))], axis=2)
    img.pixels.foreach_set(rgba.astype(np.float32).ravel())
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)


def _grid():
    h = PIXELS_HIGH
    w = int(round(h * LETTER_ASPECT))
    u = (np.arange(w) + 0.5) / w
    v = (np.arange(h) + 0.5) / h
    x = (u[None, :] - 0.5) * LETTER_ASPECT + np.zeros((h, 1))
    y = (0.5 - v[:, None]) + np.zeros((1, w))
    return x, y


def _cover(distance, soft):
    """1 inside a shape and 0 outside, from its signed distance, with a soft edge."""
    return np.clip(0.5 - distance / soft, 0.0, 1.0)


def _box_distance(x, y, cx, cy, hx, hy):
    return np.maximum(np.abs(x - cx) - hx, np.abs(y - cy) - hy)


def _sheet(x, y):
    """Plain sealed sheet: cream paper, two faint folds, and a slanted red and blue border."""
    paper = np.array(palette.hex_to_rgb("#F6EFDC"))
    red = np.array(palette.hex_to_rgb(palette.VERMILION))
    blue = np.array(palette.hex_to_rgb(palette.INDIGO))
    img = np.ones(x.shape + (3,)) * paper[None, None, :]
    for fold in (-0.15, 0.17):
        line = _cover(np.abs(y - fold) - 0.003, 0.004)
        img *= (1.0 - 0.07 * line)[:, :, None]
    edge = np.minimum(LETTER_ASPECT / 2.0 - np.abs(x), 0.5 - np.abs(y))
    band = _cover(edge - 0.07, 0.004)
    stripe = np.floor((x + y) / 0.075).astype(int) % 4
    for index, colour in ((0, red), (2, blue)):
        mask = (band * (stripe == index))[:, :, None]
        img = img * (1.0 - mask) + colour[None, None, :] * mask
    return img


def _key(x, y):
    """Cover of a key shape, tilted, centred where the lamplight falls."""
    t = math.radians(KEY_TILT_DEG)
    dx, dy = x - GLOW_CENTRE[0], y - GLOW_CENTRE[1]
    kx = dx * math.cos(t) + dy * math.sin(t) + 0.03
    ky = -dx * math.sin(t) + dy * math.cos(t)
    r = np.hypot(kx + 0.17, ky)
    bow = np.maximum(r - 0.125, 0.058 - r)
    shaft = _box_distance(kx, ky, 0.105, 0.0, 0.165, 0.026)
    tooth_a = _box_distance(kx, ky, 0.1875, -0.06, 0.0175, 0.06)
    tooth_b = _box_distance(kx, ky, 0.2525, -0.05, 0.0175, 0.05)
    return _cover(np.minimum(np.minimum(bow, shaft), np.minimum(tooth_a, tooth_b)), 0.014)


def paint_letters(out_dir):
    """Write the three pictures and return their paths: plain sheet, lit sheet, and its glow."""
    os.makedirs(out_dir, exist_ok=True)
    x, y = _grid()
    plain = _sheet(x, y)
    glow = np.exp(-(np.hypot(x - GLOW_CENTRE[0], y - GLOW_CENTRE[1]) / GLOW_SPREAD) ** 2)
    # The key is only seen where light comes through, so it fades out with the glow.
    key = _key(x, y) * np.clip(glow * 1.8, 0.0, 1.0)
    warm = np.array(palette.hex_to_rgb("#FFD886"))
    ink = np.array(palette.hex_to_rgb(palette.INK))
    lit = plain * (1.0 - 0.85 * glow[:, :, None]) + warm[None, None, :] * (0.85 * glow[:, :, None])
    lit = lit * (1.0 - key[:, :, None]) + ink[None, None, :] * key[:, :, None]
    shine = glow * (1.0 - 0.96 * key)
    paths = {name: os.path.join(out_dir, "letter_%s.png" % name) for name in ("plain", "lit", "glow")}
    _save(plain, paths["plain"])
    _save(lit, paths["lit"])
    _save(np.repeat(shine[:, :, None], 3, axis=2), paths["glow"])
    return paths
