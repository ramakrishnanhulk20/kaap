"""Everything that is not a person or the treasury: the round stage, the lantern on its staff, the
letters, the kolam on the floor, the ball of thread, a palm and a stack of pots."""
import math

import bpy
import numpy as np

import materials
import palette
import shapes

STAGE_RADIUS = 4.65
STAGE_HEIGHT = 0.3


def build_backdrop():
    """One huge sheet of paper under everything. The camera looks down, so it fills the whole frame."""
    v, f = shapes.box((400.0, 400.0, 0.2), (0.0, 0.0, -0.1))
    return shapes.make_object("backdrop", v, f, materials.paper(palette.PAPER))


def build_stage():
    """A round turned base, like the stand a set of wooden toys is sold on: striped rim, limewashed top."""
    r, h = STAGE_RADIUS, STAGE_HEIGHT
    objs = []
    v, f = shapes.lathe([(0.0, 0.0), (r, 0.0), (r + 0.02, 0.03), (r + 0.02, h - 0.05), (r, h - 0.02), (0.0, h - 0.02)], 160)
    objs.append(shapes.make_object("stage_rim", v, f, materials.stripes(palette.KAAVI, palette.WHITE, 60), 0.012))
    v, f = shapes.lathe([(0.0, h - 0.03), (r - 0.09, h - 0.03), (r - 0.09, h), (0.0, h)], 160)
    objs.append(shapes.make_object("stage_top", v, f, materials.lacquer(palette.LIME, rough=0.42, coat=0.35, lines=0.0, name="stage_top", vary=0.03), 0.008))
    a = np.linspace(0.0, 2 * np.pi, 240, endpoint=False)
    path = np.stack([(r - 0.34) * np.cos(a), (r - 0.34) * np.sin(a), np.full_like(a, h + 0.003)], axis=1)
    v, f = shapes.tube(path, 0.035, 8, squash=0.12, closed=True)
    objs.append(shapes.make_object("stage_line", v, f, _floor_paint()))
    return objs


def _floor_paint():
    return materials.lacquer(palette.KAAVI, rough=0.55, coat=0.15, lines=0.0, name="floor_paint")


def kolam_path(cols, rows, spacing, rounding=0.33):
    """A sikku kolam: one unbroken line woven round a grid of dots.

    The line is the path of a ball bouncing at 45 degrees inside the rectangle that holds the dots.
    It closes into a single loop when the two counts share no factor. Each bounce is rounded, so the
    line curls round the dot beside it. Returns the loop and the dots, centred on the origin.
    """
    wall_x, wall_y = 2 * cols - 1, 2 * rows - 1
    x, y, dx, dy = 1, 0, 1, 1
    bounces = []
    for _ in range(8 * cols * rows):
        x, y = x + dx, y + dy
        ndx = -dx if x in (-1, wall_x) else dx
        ndy = -dy if y in (-1, wall_y) else dy
        if (ndx, ndy) != (dx, dy):
            bounces.append((x, y, dx, dy, ndx, ndy))
            dx, dy = ndx, ndy
        if (x, y, dx, dy) == (1, 0, 1, 1):
            break
    reach = rounding / math.sqrt(2.0) * spacing
    centre = np.array([(cols - 1) / 2.0, (rows - 1) / 2.0]) * spacing
    points = []
    for bx, by, idx, idy, odx, ody in bounces:
        corner = np.array([bx, by]) / 2.0 * spacing - centre
        a = corner - reach * np.array([idx, idy])
        b = corner + reach * np.array([odx, ody])
        for t in np.linspace(0.0, 1.0, 9):
            points.append((1 - t) ** 2 * a + 2 * (1 - t) * t * corner + t * t * b)
    dots = [np.array([i, j]) * spacing - centre for j in range(rows) for i in range(cols)]
    return np.array(points), dots


def build_kolam(centre, cols=7, rows=4, spacing=0.46):
    """The kolam drawn on the floor before the door, as a thin raised line of paint and its dots."""
    loop, dots = kolam_path(cols, rows, spacing)
    closed = np.vstack([loop, loop[:1]])
    flat = shapes.resample(np.c_[closed, np.zeros(len(closed))], 0.012)[:-1]
    z = centre[2] + 0.003
    v, f = shapes.tube(flat + np.array([centre[0], centre[1], z]), 0.03, 8, squash=0.12, closed=True)
    objs = [shapes.make_object("kolam_line", v, f, _floor_paint())]
    for k, dot in enumerate(dots):
        v, f = shapes.sphere(0.045, (1.0, 1.0, 0.14), segments=16, rings=8)
        objs.append(shapes.make_object("kolam_dot%d" % k, v + np.array([centre[0] + dot[0], centre[1] + dot[1], z]), f, _floor_paint()))
    return objs


LANTERN_DROP = 0.78


def build_lantern():
    """A brass hand lantern with a glowing glass, hanging from its own top ring at the origin."""
    k = 1.55
    brass = materials.brass()
    objs = []
    v, f = shapes.ring(0.05 * k, 0.012 * k)
    objs.append(shapes.make_object("lantern_ring", v + np.array([0.0, 0.0, -0.05 * k]), f, brass))
    v, f = shapes.lathe([(0.0, -0.09), (0.035, -0.09), (0.11, -0.13), (0.13, -0.17), (0.1, -0.195), (0.0, -0.195)], 40)
    objs.append(shapes.make_object("lantern_cap", v * k, f, brass, 0.004))
    v, f = shapes.lathe([(0.0, -0.19), (0.09, -0.19), (0.15, -0.27), (0.16, -0.36), (0.125, -0.46), (0.1, -0.485), (0.0, -0.485)], 40)
    objs.append(shapes.make_object("lantern_glass", v * k, f, materials.light(palette.GLOW, 4.0, "lantern_glass")))
    v, f = shapes.lathe([(0.0, -0.48), (0.12, -0.48), (0.155, -0.5), (0.165, -0.56), (0.14, -0.6), (0.0, -0.6)], 40)
    objs.append(shapes.make_object("lantern_base", v * k, f, brass, 0.004))
    for i in range(4):
        a = math.pi / 4 + i * math.pi / 2
        path = np.array([[0.125 * math.cos(a), 0.125 * math.sin(a), -0.17],
                         [0.172 * math.cos(a), 0.172 * math.sin(a), -0.33],
                         [0.15 * math.cos(a), 0.15 * math.sin(a), -0.5]]) * k
        v, f = shapes.tube(shapes.catmull(path, 0.02), 0.009 * k, 6)
        objs.append(shapes.make_object("lantern_wire%d" % i, v, f, brass))
    data = bpy.data.lights.new("lantern_light", "POINT")
    data.energy = 9.0
    data.color = palette.hex_to_linear(palette.GLOW)
    data.shadow_soft_size = 0.12
    lamp = bpy.data.objects.new("lantern_light", data)
    bpy.context.scene.collection.objects.link(lamp)
    lamp.location = (0.0, 0.0, -0.34 * k)
    objs.append(lamp)
    return objs


def build_staff(foot, tip):
    """The watchman's staff, from the floor to the hook the lantern hangs on."""
    foot, tip = np.asarray(foot, dtype=float), np.asarray(tip, dtype=float)
    path = shapes.resample(np.array([foot, tip]), 0.05)
    v, f = shapes.tube(path, 0.034, 12, up=(0.0, 1.0, 0.0))
    objs = [shapes.make_object("staff", v, f, materials.lacquer(palette.WOOD_DARK, lines=0.0))]
    for at, size in ((tip, 0.055), (foot, 0.045)):
        v, f = shapes.sphere(size, segments=20, rings=10)
        objs.append(shapes.make_object("staff_cap", v + at, f, materials.brass()))
    return objs


def build_letter(name, width, height, face_material):
    """A sealed sheet standing in its own x-z plane, its painted side facing -y."""
    v, f = shapes.slab(shapes.rounded_rect(width, height, 0.02), 0.022)
    return shapes.make_object(name, v, f, face_material, 0.004)


def build_seal(name, at, radius=0.07):
    """A blob of red sealing wax on the front of a letter."""
    v, f = shapes.sphere(radius, (1.0, 0.3, 1.0), segments=24, rings=12)
    return shapes.make_object(name, v + np.asarray(at, dtype=float), f,
                              materials.lacquer(palette.VERMILION, rough=0.2, lines=0.0))


def build_thread_ball(centre, radius=0.2):
    """A ball of thread: a core, wound round one way and then crossed over the top the other way."""
    centre = np.asarray(centre, dtype=float)
    parts = [shapes.sphere(radius * 0.9)]
    a = np.linspace(0.0, 2 * np.pi, 36, endpoint=False)
    for tilt, count, span in ((0.0, 15, 0.93), (math.radians(64.0), 8, 0.5)):
        for i in range(count):
            x = radius * span * (2.0 * (i + 0.5) / count - 1.0)
            r = math.sqrt(radius * radius - x * x)
            loop = np.stack([np.full_like(a, x), r * np.cos(a), r * np.sin(a)], axis=1)
            turned = np.stack([loop[:, 0] * math.cos(tilt) + loop[:, 2] * math.sin(tilt), loop[:, 1],
                               -loop[:, 0] * math.sin(tilt) + loop[:, 2] * math.cos(tilt)], axis=1)
            parts.append(shapes.tube(turned, 0.021, 6, closed=True))
    v, f = shapes.merge(parts)
    return shapes.make_object("thread_ball", v + centre, f, materials.thread(palette.TURMERIC))


def build_strand(points):
    """A loose length of the same thread, lying where the points lead it."""
    path = shapes.catmull(points, 0.011)
    v, f = shapes.cord(path, 0.026, 0.023, 0.15)
    return shapes.make_object("thread_strand", v, f, materials.thread(palette.TURMERIC))


def build_palm(height=2.3):
    """A coconut palm: a trunk of turned rings leaning a little, a crown of fronds, three coconuts."""
    objs = []
    count = 8
    step = height / count
    for i in range(count):
        lean = 0.3 * (i / count) ** 1.6
        r = 0.125 - 0.035 * i / count
        v, f = shapes.lathe([(0.0, 0.0), (r * 0.82, 0.0), (r, 0.04), (r * 0.94, step * 0.86), (r * 0.72, step), (0.0, step)], 32)
        mat = materials.wood(palette.WOOD if i % 2 == 0 else palette.WOOD_DARK)
        objs.append(shapes.make_object("palm_ring%d" % i, v + np.array([lean, 0.0, i * step]), f, mat, 0.01))
    top = np.array([0.3, 0.0, height])
    for i in range(3):
        a = 2 * math.pi * i / 3 + 0.5
        v, f = shapes.sphere(0.12, segments=24, rings=12)
        objs.append(shapes.make_object("palm_nut%d" % i, v + top + [0.15 * math.cos(a), 0.15 * math.sin(a), -0.1], f,
                                       materials.lacquer(palette.WOOD_DARK, lines=0.0)))
    fronds = 9
    for i in range(fronds):
        a = 2 * math.pi * i / fronds + 0.2
        along = np.array([math.cos(a), math.sin(a), 0.0])
        across = np.array([-math.sin(a), math.cos(a), 0.0])
        length = 1.35 if i % 2 == 0 else 1.1
        verts, faces = [], []
        steps = 16
        for k in range(steps + 1):
            s = k / steps
            centre = top + along * (length * s) + np.array([0.0, 0.0, 0.5 * math.sin(math.pi * 0.75 * s) - 1.05 * s * s])
            half = 0.02 + 0.2 * math.sin(math.pi * min(1.0, s * 1.06)) ** 0.7
            verts += [centre - across * half, centre + across * half]
            if k:
                b = 2 * k
                faces.append((b - 2, b - 1, b + 1, b))
        leaf = shapes.make_object("palm_frond%d" % i, np.array(verts), faces,
                                  materials.lacquer(palette.LEAF if i % 2 == 0 else palette.LEAF_DARK, lines=0.0))
        solid = leaf.modifiers.new("solid", "SOLIDIFY")
        solid.thickness = 0.03
        objs.append(leaf)
    return objs


def build_pots():
    """Three painted pots stacked in a tower, the way they stand at a harvest festival."""
    shape = [(0.0, 0.0), (0.2, 0.0), (0.36, 0.14), (0.4, 0.3), (0.33, 0.46), (0.2, 0.54), (0.18, 0.58),
             (0.25, 0.62), (0.25, 0.66), (0.0, 0.66)]
    objs = []
    z = 0.0
    for i, (scale, colour) in enumerate(((1.0, palette.VERMILION), (0.78, palette.ORANGE), (0.6, palette.TEAL))):
        v, f = shapes.lathe([(r * scale, h * scale) for r, h in shape], 48)
        objs.append(shapes.make_object("pot%d" % i, v + np.array([0.0, 0.0, z]), f, materials.lacquer(colour), 0.012))
        for k in range(12):
            a = 2 * math.pi * k / 12
            dv, df = shapes.sphere(0.035 * scale, segments=12, rings=6)
            spot = np.array([0.4 * scale * math.cos(a), 0.4 * scale * math.sin(a), z + 0.3 * scale])
            objs.append(shapes.make_object("pot%d_dot%d" % (i, k), dv + spot, df, materials.lacquer(palette.WHITE, lines=0.0)))
        z += 0.64 * scale
    return objs
