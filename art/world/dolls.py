"""The people: a watchman, and the members who bring sealed letters to the treasury door.

Each doll is turned from one silhouette and painted in bands, like a lac-turned wooden toy. A doll is
built facing its own -y axis, so `shapes.group` can stand it anywhere and turn it to face any way.
"""
import math

import numpy as np

import materials
import palette
import shapes


def facing(dx, dy):
    """The yaw that turns a doll's front (its own -y) to point along (dx, dy) on the floor."""
    return math.atan2(dx, -dy)


def to_local(point, root, yaw):
    """A world point in the frame of a doll standing at `root` and turned by `yaw`."""
    p = np.asarray(point, dtype=float) - np.asarray(root, dtype=float)
    c, s = math.cos(-yaw), math.sin(-yaw)
    return np.array([c * p[0] - s * p[1], s * p[0] + c * p[1], p[2]])


def _on_head(centre, radius, azimuth_deg, elevation_deg, lift=0.0):
    """A point on the head, `azimuth` round from the face's middle and `elevation` up from the equator."""
    a, e = math.radians(azimuth_deg), math.radians(elevation_deg)
    r = radius + lift
    return np.array([centre[0] + r * math.sin(a) * math.cos(e),
                     centre[1] - r * math.cos(a) * math.cos(e),
                     centre[2] + r * math.sin(e)])


def _head(name, centre, radius, skin_hex):
    v, f = shapes.sphere(radius, (1.0, 1.0, 0.96))
    return shapes.make_object(name + "_head", v + np.asarray(centre), f, materials.lacquer(skin_hex, lines=0.0))


def _eyes(name, centre, radius, spread=21.0, height=6.0, size=0.036):
    black = materials.lacquer(palette.BLACK, rough=0.15, lines=0.0)
    objs = []
    for side in (-1, 1):
        v, f = shapes.sphere(size, segments=20, rings=10)
        at = _on_head(centre, radius, side * spread, height, -size * 0.45)
        objs.append(shapes.make_object("%s_eye%d" % (name, side), v + at, f, black))
    return objs


def _line_on_head(name, centre, radius, points, widths, lift=0.004):
    """A painted line raised a little off the head, through (azimuth, elevation) points."""
    path = shapes.catmull([_on_head(centre, radius, a, e, lift) for a, e in points], 0.008)
    width = np.interp(np.linspace(0.0, 1.0, len(path)), np.linspace(0.0, 1.0, len(widths)), widths)
    v, f = shapes.tube(path, width, 10, up=(0.0, -1.0, 0.0))
    return shapes.make_object(name, v, f, materials.lacquer(palette.BLACK, rough=0.2, lines=0.0))


def _arm(name, shoulder, hand, sleeve, skin_hex, radius=0.062, droop=0.06):
    """A sleeve from shoulder to hand with a slight bend at the elbow, and a round hand."""
    shoulder, hand = np.asarray(shoulder, dtype=float), np.asarray(hand, dtype=float)
    elbow = 0.5 * (shoulder + hand) + np.array([0.0, 0.0, -droop])
    path = shapes.catmull([shoulder, elbow, hand], 0.02)
    v, f = shapes.tube(path, radius, 12)
    arm = shapes.make_object(name + "_sleeve", v, f, sleeve)
    hv, hf = shapes.sphere(radius * 1.2, segments=20, rings=10)
    return [arm, shapes.make_object(name + "_hand", hv + hand, hf, materials.lacquer(skin_hex, lines=0.0))]


WATCHMAN_SHAPE = [(0.38, 0.0), (0.385, 0.06), (0.36, 0.2), (0.315, 0.48), (0.285, 0.68), (0.30, 0.8),
                  (0.315, 0.95), (0.27, 1.08), (0.16, 1.15), (0.12, 1.2)]
WATCHMAN_HEAD = (0.0, 0.0, 1.41)
WATCHMAN_HEAD_RADIUS = 0.26
WATCHMAN_SHOULDER_Z = 1.02
WATCHMAN_SHOULDER_OUT = 0.25


def build_watchman(right_hand, left_hand):
    """The watchman: white veshti, indigo coat, red turban with a brass badge, and a big moustache.

    The two hands are given in his own frame, because what he holds is placed in the scene first.
    """
    name = "watchman"
    c, r = WATCHMAN_HEAD, WATCHMAN_HEAD_RADIUS
    objs = shapes.turned(name, WATCHMAN_SHAPE, [
        (0.0, 0.09, materials.lacquer(palette.VERMILION)),
        (0.09, 0.68, materials.lacquer(palette.WHITE)),
        (0.68, 0.77, materials.lacquer(palette.VERMILION)),
        (0.77, 1.15, materials.lacquer(palette.INDIGO)),
        (1.15, 1.2, materials.lacquer(palette.SKIN_DEEP)),
    ])
    objs.append(_head(name, c, r, palette.SKIN_DEEP))
    objs += _eyes(name, c, r, spread=22.0, height=9.0, size=0.038)
    for side in (-1, 1):
        objs.append(_line_on_head("%s_brow%d" % (name, side), c, r,
                                  [(side * 10, 23), (side * 20, 25), (side * 31, 21)], [0.016, 0.018, 0.01]))
        objs.append(_line_on_head("%s_moustache%d" % (name, side), c, r,
                                  [(side * 2, -17), (side * 13, -22), (side * 27, -21), (side * 38, -12), (side * 41, -3)],
                                  [0.046, 0.05, 0.042, 0.026, 0.01], lift=0.012))
    nv, nf = shapes.sphere(0.045, (1.0, 1.0, 1.15), segments=20, rings=10)
    objs.append(shapes.make_object(name + "_nose", nv + _on_head(c, r, 0, -7, -0.008), nf,
                                   materials.lacquer(palette.SKIN_DEEP, lines=0.0)))

    top = c[2]
    tv, tf = shapes.lathe([(0.0, top + 0.02), (0.268, top + 0.07), (0.31, top + 0.11), (0.326, top + 0.18),
                           (0.3, top + 0.26), (0.22, top + 0.33), (0.13, top + 0.37), (0.0, top + 0.385)], 64)
    objs.append(shapes.make_object(name + "_turban", tv, tf, materials.lacquer(palette.VERMILION), 0.01))
    bv, bf = shapes.sphere(0.05, (1.0, 0.45, 1.0), segments=20, rings=10)
    objs.append(shapes.make_object(name + "_badge", bv + np.array([0.0, -0.318, top + 0.17]), bf, materials.brass()))
    for z in (0.86, 0.98):
        kv, kf = shapes.sphere(0.028, segments=16, rings=8)
        objs.append(shapes.make_object(name + "_button", kv + np.array([0.0, -0.31, z]), kf, materials.brass()))

    sleeve = materials.lacquer(palette.INDIGO, lines=0.0)
    # His right side is his own -x.
    objs += _arm(name + "_right", (-WATCHMAN_SHOULDER_OUT, 0.0, WATCHMAN_SHOULDER_Z), right_hand, sleeve, palette.SKIN_DEEP, 0.07)
    objs += _arm(name + "_left", (WATCHMAN_SHOULDER_OUT, 0.0, WATCHMAN_SHOULDER_Z), left_hand, sleeve, palette.SKIN_DEEP, 0.07)
    return objs


MEMBER_SHAPE = [(0.34, 0.0), (0.345, 0.05), (0.3, 0.25), (0.225, 0.55), (0.2, 0.68), (0.15, 0.77), (0.1, 0.81)]
MEMBER_HEAD = (0.0, 0.0, 0.99)
MEMBER_HEAD_RADIUS = 0.2
MEMBER_SHOULDER_Z = 0.68
MEMBER_SHOULDER_OUT = 0.16


def _hair(name, bun):
    """A cap of black hair set back off the forehead, with an optional bun."""
    c, r = MEMBER_HEAD, MEMBER_HEAD_RADIUS + 0.012
    profile = [(0.0, r * math.sin(math.radians(18)))]
    profile += [(r * math.cos(math.radians(e)), r * math.sin(math.radians(e))) for e in range(18, 90, 6)]
    profile.append((0.0, r))
    v, f = shapes.lathe(profile, 48)
    tilt = math.radians(-24.0)
    y = v[:, 1] * math.cos(tilt) - v[:, 2] * math.sin(tilt)
    z = v[:, 1] * math.sin(tilt) + v[:, 2] * math.cos(tilt)
    v = np.stack([v[:, 0], y, z], axis=1) + np.asarray(c)
    black = materials.lacquer(palette.BLACK, rough=0.25, lines=0.0)
    objs = [shapes.make_object(name + "_hair", v, f, black)]
    if bun:
        bv, bf = shapes.sphere(0.095, segments=24, rings=12)
        objs.append(shapes.make_object(name + "_bun", bv + np.array([0.0, 0.15, c[2] + 0.17]), bf, black))
    return objs


def _cap(name, hex_color):
    c, r = MEMBER_HEAD, MEMBER_HEAD_RADIUS
    v, f = shapes.lathe([(0.0, c[2] + 0.1), (r * 0.93, c[2] + 0.1), (r * 0.9, c[2] + 0.25), (0.0, c[2] + 0.27)], 48)
    return [shapes.make_object(name + "_cap", v, f, materials.lacquer(hex_color), 0.02)]


def build_member(name, body_hex, base_hex, skin_hex, hands, hair="bun", top_hex=None):
    """One member of the treasury: a bell-shaped body, a round head and a smile.

    `hands` is the (right, left) pair of points in the doll's own frame.
    """
    c, r = MEMBER_HEAD, MEMBER_HEAD_RADIUS
    objs = shapes.turned(name, MEMBER_SHAPE, [
        (0.0, 0.08, materials.lacquer(base_hex)),
        (0.08, 0.56, materials.lacquer(body_hex)),
        (0.56, 0.62, materials.lacquer(palette.WHITE)),
        (0.62, 0.81, materials.lacquer(top_hex or body_hex)),
    ], bevel=0.01)
    objs.append(_head(name, c, r, skin_hex))
    objs += _eyes(name, c, r, spread=20.0, height=5.0, size=0.03)
    objs.append(_line_on_head(name + "_smile", c, r, [(-15, -17), (-7, -23), (7, -23), (15, -17)], [0.008, 0.012, 0.012, 0.008]))
    if hair == "cap":
        objs += _cap(name, palette.WHITE)
    else:
        objs += _hair(name, bun=True)
    sleeve = materials.lacquer(skin_hex, lines=0.0)
    objs += _arm(name + "_right", (-MEMBER_SHOULDER_OUT, 0.0, MEMBER_SHOULDER_Z), hands[0], sleeve, skin_hex, 0.045, 0.03)
    objs += _arm(name + "_left", (MEMBER_SHOULDER_OUT, 0.0, MEMBER_SHOULDER_Z), hands[1], sleeve, skin_hex, 0.045, 0.03)
    return objs
