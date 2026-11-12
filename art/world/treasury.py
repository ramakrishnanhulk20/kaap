"""The treasury: a round striped tower with a studded door, and the yellow thread tied around it.

Built with its door facing its own -y axis and its base on z = 0.
"""
import math

import numpy as np

import materials
import palette
import shapes

RADIUS = 1.3
STEP = 0.16
WALL_TOP = 1.72
HEIGHT = 3.2
DOOR_WIDTH = 1.0
DOOR_HEIGHT = 1.36
FRAME_FRONT = RADIUS + 0.15
LEAF_FRONT = FRAME_FRONT + 0.02
WINDOW_TURN_DEG = 54.0

CORD_PLY = 0.03
CORD_HELIX = 0.027
CORD_PERIOD = 0.17
CORD_REACH = CORD_PLY + CORD_HELIX
KNOT_HEIGHT = 0.99
WRAPS = 3


def _at_door(verts, x=0.0, out=0.0, z=0.0):
    """Shift vertices built around the origin to a spot on the door front, `out` proud of the leaf."""
    return np.asarray(verts, dtype=float) + np.array([x, -(LEAF_FRONT + out), STEP + z])


def _tower():
    kaavi = materials.lacquer(palette.KAAVI)
    objs = []
    v, f = shapes.lathe([(0.0, 0.0), (1.55, 0.0), (1.55, 0.11), (1.5, STEP), (0.0, STEP)], 96)
    objs.append(shapes.make_object("treasury_step", v, f, kaavi, 0.02))
    v, f = shapes.lathe([(0.0, STEP), (RADIUS, STEP), (RADIUS, WALL_TOP), (0.0, WALL_TOP)], 96)
    objs.append(shapes.make_object("treasury_wall", v, f, materials.stripes(palette.WHITE, palette.KAAVI, 11)))
    v, f = shapes.lathe([(0.0, WALL_TOP), (1.4, WALL_TOP), (1.43, WALL_TOP + 0.06), (1.4, WALL_TOP + 0.12), (0.0, WALL_TOP + 0.12)], 96)
    objs.append(shapes.make_object("treasury_cornice", v, f, materials.lacquer(palette.LEAF), 0.015))
    roof = [(1.5, 1.84), (1.53, 1.9), (1.36, 2.08), (1.08, 2.3), (0.76, 2.5), (0.44, 2.65), (0.2, 2.74), (0.13, 2.78)]
    objs += shapes.turned("treasury_roof", roof, [
        (1.84, 1.9, materials.lacquer(palette.LEAF)),
        (1.9, 2.3, materials.lacquer(palette.VERMILION)),
        (2.3, 2.37, materials.lacquer(palette.WHITE)),
        (2.37, 2.78, materials.lacquer(palette.VERMILION)),
    ], bevel=0.015)
    v, f = shapes.lathe([(0.0, 2.76), (0.13, 2.78), (0.21, 2.85), (0.23, 2.93), (0.14, 3.01), (0.07, 3.05),
                         (0.1, 3.09), (0.04, 3.17), (0.0, HEIGHT)], 48)
    objs.append(shapes.make_object("treasury_finial", v, f, materials.brass()))
    return objs


def _door():
    objs = []
    v, f = shapes.slab(shapes.arch(DOOR_WIDTH, DOOR_HEIGHT), 0.3)
    objs.append(shapes.make_object("door_frame", v + np.array([0.0, -RADIUS, STEP]), f,
                                   materials.lacquer(palette.VERMILION, lines=0.0), 0.02))
    v, f = shapes.slab(shapes.arch(DOOR_WIDTH - 0.2, DOOR_HEIGHT - 0.1), 0.08)
    objs.append(shapes.make_object("door_leaf", v + np.array([0.0, -(LEAF_FRONT - 0.04), STEP]), f,
                                   materials.lacquer(palette.LEAF, lines=0.0), 0.012))
    v, f = shapes.box((0.014, 0.02, DOOR_HEIGHT - 0.14))
    objs.append(shapes.make_object("door_seam", _at_door(v, z=(DOOR_HEIGHT - 0.14) / 2.0), f,
                                   materials.lacquer(palette.BLACK, lines=0.0)))
    brass = materials.brass()
    for x in (-0.3, -0.15, 0.15, 0.3):
        for z in (0.2, 0.46, 1.0):
            v, f = shapes.sphere(0.03, (1.0, 0.6, 1.0), segments=16, rings=8)
            objs.append(shapes.make_object("door_stud", _at_door(v, x, 0.0, z), f, brass))
    for x in (-0.11, 0.11):
        v, f = shapes.ring(0.075, 0.016)
        objs.append(shapes.make_object("door_ring", _at_door(v, x, 0.03, 0.7), f, brass))
        v, f = shapes.sphere(0.03, segments=16, rings=8)
        objs.append(shapes.make_object("door_knob", _at_door(v, x, 0.01, 0.78), f, brass))
    return objs


def _window(gold):
    """A round barred window with gold shining out: this is where the money is."""
    turn = math.radians(-90.0 + WINDOW_TURN_DEG)
    spot = np.array([RADIUS * math.cos(turn), RADIUS * math.sin(turn), 1.16])
    yaw = turn + math.pi / 2.0
    objs = []
    v, f = shapes.ring(0.19, 0.03)
    objs.append(shapes.make_object("window_rim", shapes.moved(v, spot, yaw), f, materials.brass()))
    v, f = shapes.sphere(0.18, (1.0, 0.12, 1.0), segments=32, rings=16)
    objs.append(shapes.make_object("window_gold", shapes.moved(v, spot, yaw), f,
                                   materials.light(palette.GOLD_GLOW, 2.2 * gold, "window_gold")))
    for x in (-0.065, 0.065):
        path = np.array([[x, -0.03, -0.17], [x, -0.03, 0.17]])
        v, f = shapes.tube(shapes.resample(path, 0.02), 0.014, 8, up=(0.0, 1.0, 0.0))
        objs.append(shapes.make_object("window_bar", shapes.moved(v, spot, yaw), f,
                                       materials.lacquer(palette.BLACK, lines=0.0)))
    return objs


def _wrap_radius(turn_deg):
    """How far from the axis the thread runs: on the wall, but out over the flat door frame."""
    delta = abs((turn_deg + 90.0 + 180.0) % 360.0 - 180.0)
    on_wall = RADIUS + CORD_REACH
    plane = LEAF_FRONT + CORD_REACH + 0.01
    edge = math.degrees(math.atan((DOOR_WIDTH / 2.0) / plane))
    if delta <= edge:
        return plane / math.cos(math.radians(delta))
    blend = min(1.0, (delta - edge) / 17.0)
    blend = blend * blend * (3.0 - 2.0 * blend)
    return plane / math.cos(math.radians(edge)) * (1.0 - blend) + on_wall * blend


def wrap_point(turns, height):
    """A point on the thread's path `turns` round from the door, in the tower's own frame."""
    turn = -90.0 + 360.0 * turns
    r = _wrap_radius(turn)
    return np.array([r * math.cos(math.radians(turn)), r * math.sin(math.radians(turn)), height])


THREAD_START_TURNS = -28.0 / 360.0


def wrap_path():
    """The thread's way round the tower, in the tower's own frame: it arrives on the wall to one
    side of the door, climbs slowly through three turns and ends at the knot in front of the door."""
    points = []
    steps = 360 * WRAPS // 2 + 1
    for t in np.linspace(0.0, 1.0, steps):
        turns = THREAD_START_TURNS + t * (WRAPS - THREAD_START_TURNS)
        height = 0.87 + 0.24 * t + 0.012 * math.sin(11.0 * t)
        # The last few degrees bend to the knot, so the end disappears into it.
        near_end = max(0.0, 1.0 - (1.0 - t) * (WRAPS - THREAD_START_TURNS) * 360.0 / 14.0)
        points.append(wrap_point(turns, height + (KNOT_HEIGHT - height) * near_end))
    return np.array(points)


def build_bow(amount, sway=0.0):
    """The knot across the door with its two loops and two tasselled ends. `amount` grows it from
    nothing (0) to tied (1); `sway` is the angle of the slow swing of the hanging ends."""
    if amount <= 0.02:
        return []
    cotton = materials.thread(palette.TURMERIC)
    grown = min(1.0, amount)
    knot = np.array([0.0, -(LEAF_FRONT + CORD_REACH + 0.06), KNOT_HEIGHT])
    v, f = shapes.sphere(0.095 * min(1.0, 0.4 + 0.6 * amount), (1.0, 0.8, 0.88), segments=24, rings=12)
    objs = [shapes.make_object("thread_knot", v + knot, f, cotton)]
    for side in (-1, 1):
        reach = np.array([side * amount, amount, amount])
        loop = [knot, knot + reach * [0.2, -0.02, 0.17], knot + reach * [0.37, -0.03, 0.1],
                knot + reach * [0.3, -0.02, -0.03], knot + reach * [0.04, 0.0, -0.01]]
        v, f = shapes.cord(shapes.catmull(loop, 0.01), 0.026, 0.023, 0.15, up=(0.0, -1.0, 0.0))
        objs.append(shapes.make_object("thread_bow%d" % side, v, f, cotton))
        drop = (0.5 if side < 0 else 0.4) * grown
        swing = 0.018 * math.sin(2.0 * sway + side)
        tail = [knot, knot + [side * 0.07, -0.02, -0.32 * drop], knot + [side * 0.13 + 0.5 * swing, -0.03, -0.68 * drop],
                knot + [side * 0.11 + swing, -0.03, -drop]]
        v, f = shapes.cord(shapes.catmull(tail, 0.01), 0.026, 0.023, 0.15, up=(0.0, -1.0, 0.0))
        objs.append(shapes.make_object("thread_tail%d" % side, v, f, cotton))
        v, f = shapes.lathe([(0.0, 0.03), (0.045, 0.01), (0.055, -0.03), (0.035, -0.06), (0.062, -0.19), (0.0, -0.19)], 24)
        objs.append(shapes.make_object("thread_tassel%d" % side, v * grown + knot + [side * 0.11 + swing, -0.03, -drop], f, cotton))
    return objs


def build_treasury(gold=1.0):
    """The tower, its door and its window. `gold` scales how brightly the money inside shines."""
    return _tower() + _door() + _window(gold)
