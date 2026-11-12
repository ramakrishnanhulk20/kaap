"""Puts the whole toy set together for one frame of the film, lights it and sets up the render.

Everything that moves takes its place from `timeline.pose`. The scene is built afresh for every
frame, which costs under a second and means there is no hidden state between frames.
"""
import math
import os

import bpy
import numpy as np
from mathutils import Vector

import dolls
import layout
import materials
import palette
import props
import shapes
import treasury

FLOOR = props.STAGE_HEIGHT
STAGE_AT = (0.2, 0.0)

# The sun stands high in front and a little to the left, so shadows fall back onto the stage and
# never reach the edge of the picture.
SUN_TRAVEL = (0.3, 0.62, -1.0)
SUN_STRENGTH = 2.0
SUN_SOFTNESS_DEG = 14.0
WORLD_STRENGTH = 0.48

WATCHMAN_AT = (0.62, -0.22)
WATCHMAN_FACES = (-0.62, -0.78)
# Where his free hand hangs before he takes hold of the letter, in his own frame.
WATCHMAN_HAND_AT_REST = (0.3, -0.27, 0.7)

LETTER_SIZE = (1.2, 0.86)
# The big letter starts low, in the hands of the member who brought it, and ends held up level
# with the lantern, tipped a little.
LETTER_CARRIED = np.array([-0.74, -0.6, 0.97 + FLOOR])
LETTER_HELD_UP = np.array([-0.35, -0.6, 1.22 + FLOOR])
LETTER_ROLL_DEG = 6.0

# The staff stands by the watchman's right side and pivots on its foot: upright at first, then
# leaning over so the lantern hangs behind the letter.
STAFF_FOOT = np.array([0.23, 0.09, 0.04 + FLOOR])
STAFF_TIP_UPRIGHT = np.array([0.3, 0.2, 2.6 + FLOOR])
STAFF_TIP_OVER_LETTER = np.array([-0.42, 0.12, 2.5 + FLOOR])
STAFF_GRIP_HEIGHT = 1.0 + FLOOR
LANTERN_LAG_DEG = 13.0

TREASURY_AT = (2.75, 0.75)
TREASURY_FACES = (-0.62, -0.78)
THREAD_BALL_AT = (1.45, -1.3)
THREAD_BALL_RADIUS = 0.2
KOLAM_AT = (0.2, -2.85, FLOOR)
PALM_AT = (-2.6, 2.9, FLOOR)
POTS_AT = (-3.7, 1.35, FLOOR)

# name, where, facing, body, base band, skin, head, top, size
MEMBERS = [
    ("member_a", (-1.42, -0.5), (0.92, -0.39), palette.LEAF, palette.VERMILION, palette.SKIN, "bun", None, 1.0),
    ("member_b", (-2.42, -0.2), (0.85, -0.53), palette.WHITE, palette.LEAF, palette.SKIN_DEEP, "cap", palette.ORANGE, 1.08),
    ("member_c", (-3.35, 0.2), (0.8, -0.6), palette.PINK, palette.TEAL, palette.SKIN, "bun", None, 0.94),
]


def on_floor(xy, height=0.0):
    return (xy[0], xy[1], FLOOR + height)


def staff_tip(pose):
    """The top of the staff. It swings on its foot, so its length never changes."""
    upright = STAFF_TIP_UPRIGHT - STAFF_FOOT
    over = STAFF_TIP_OVER_LETTER - STAFF_FOOT
    lean = upright / np.linalg.norm(upright) * (1.0 - pose["swing"]) + over / np.linalg.norm(over) * pose["swing"]
    return STAFF_FOOT + lean / np.linalg.norm(lean) * np.linalg.norm(over)


def build_letter_and_lantern(pose, paths):
    """The big letter, its seal, the staff and the lantern. Returns where each hand takes hold."""
    lift = pose["lift"]
    centre = LETTER_CARRIED + (LETTER_HELD_UP - LETTER_CARRIED) * lift
    roll = math.radians(LETTER_ROLL_DEG) * lift
    face = materials.letter_face(paths["plain"], paths["lit"], paths["glow"], LETTER_SIZE[0], LETTER_SIZE[1],
                                 pose["glow"], 0.4, "letter_held")
    letter = props.build_letter("letter_held", LETTER_SIZE[0], LETTER_SIZE[1], face)
    letter.location = centre
    letter.rotation_euler = (0.0, -roll, 0.0)
    seal = props.build_seal("letter_held_seal", (0.0, -0.014, -0.29), 0.075)
    seal.parent = letter

    tip = staff_tip(pose)
    props.build_staff(STAFF_FOOT, tip)
    flame = 1.0 + 0.1 * math.sin(3.0 * pose["cycle"]) + 0.05 * math.sin(7.0 * pose["cycle"] + 1.0)
    lantern = shapes.group("lantern", props.build_lantern(flame), tip + np.array([0.0, 0.0, -0.045]))
    lag = LANTERN_LAG_DEG * pose["lantern_lag"] + 2.0 * math.sin(2.0 * pose["cycle"])
    lantern.rotation_euler = (0.0, -math.radians(lag), 0.0)

    along = np.array([math.cos(roll), 0.0, math.sin(roll)])
    up = np.array([-math.sin(roll), 0.0, math.cos(roll)])
    half_w, half_h = LETTER_SIZE[0] / 2.0, LETTER_SIZE[1] / 2.0
    grip = (STAFF_GRIP_HEIGHT - STAFF_FOOT[2]) / (tip[2] - STAFF_FOOT[2])
    return {
        "right_edge": centre + along * (half_w - 0.015),
        "left_edge": centre - along * (half_w - 0.01) - up * 0.2,
        "bottom_edge": centre - along * (half_w - 0.22) - up * (half_h - 0.01),
        "staff_grip": STAFF_FOOT + (tip - STAFF_FOOT) * grip,
    }


def build_people(pose, holds, paths):
    yaw = dolls.facing(*WATCHMAN_FACES)
    # He gives a small start when the key shows.
    root = np.array(on_floor(WATCHMAN_AT, 0.06 * pose["alarm"]))
    at_rest = np.array(WATCHMAN_HAND_AT_REST)
    on_letter = dolls.to_local(holds["right_edge"], root, yaw)
    watchman = dolls.build_watchman(dolls.to_local(holds["staff_grip"], root, yaw),
                                    at_rest + (on_letter - at_rest) * pose["grip"])
    shapes.group("watchman", watchman, root, yaw)

    plain = materials.letter_face(paths["plain"], None, None, 0.46, 0.33, 0.0, 0.0, "letter_plain")
    for index, (name, at, faces, body, base, skin, head, top, size) in enumerate(MEMBERS):
        yaw = dolls.facing(*faces)
        root = on_floor(at)
        extra = []
        if index == 0:
            hands = (dolls.to_local(holds["bottom_edge"], root, yaw) / size,
                     dolls.to_local(holds["left_edge"], root, yaw) / size)
        else:
            hands = ((-0.2, -0.3, 0.58), (0.2, -0.3, 0.58))
            letter = props.build_letter(name + "_letter", 0.46, 0.33, plain)
            letter.location = (0.0, -0.335, 0.6)
            seal = props.build_seal(name + "_seal", (0.0, -0.014, 0.0), 0.05)
            seal.parent = letter
            extra = [letter]
        member = dolls.build_member(name, body, base, skin, hands, head, top)
        group = shapes.group(name, member + extra, root, yaw)
        group.scale = (size, size, size)
        if index:
            # The two who wait rock a little on their round bases, and lean back at the alarm.
            sway = pose["cycle"] + 1.7 * index
            group.rotation_euler = (math.radians(1.3) * math.sin(sway) - math.radians(4.0) * pose["alarm"],
                                    math.radians(1.0) * math.cos(sway), yaw)


def thread_path(tower_yaw, ball_top):
    """The whole way the thread goes, as closely spaced points: up out of the ball, across the
    floor, up the treasury wall, three times round and into the knot."""
    tower = np.array(on_floor(TREASURY_AT))
    wraps = shapes.moved(treasury.wrap_path(), tower, tower_yaw)
    out = (wraps[0] - tower) * np.array([1.0, 1.0, 0.0])
    out /= np.linalg.norm(out)
    lie = FLOOR + 0.05
    ball = np.array(THREAD_BALL_AT)
    # The last two points lie on the wraps, so the loose end meets them without a kink.
    join = 12
    lead = [
        ball_top,
        np.array([ball[0] + 0.2, ball[1] + 0.28, lie]),
        np.array([ball[0] - 0.05, ball[1] + 0.62, lie]),
        tower + out * 1.95 + np.array([0.12, 0.0, lie - FLOOR]),
        tower + out * 1.64 + np.array([0.0, 0.0, lie - FLOOR]),
        tower + out * 1.56 + np.array([0.0, 0.0, treasury.STEP + 0.06]),
        tower + out * (treasury.RADIUS + 0.07) + np.array([0.0, 0.0, 0.5]),
        wraps[0],
        wraps[join],
    ]
    path = np.vstack([shapes.catmull(lead, 0.011), wraps[join + 1:]])
    return shapes.resample(path, 0.011)


def build_thread(pose, tower_yaw):
    """The ball of thread and as much of the thread as has left it so far."""
    drawn = pose["thread"]
    # The ball starts fuller and thins as the thread runs out.
    radius = THREAD_BALL_RADIUS * (1.0 + 0.22 * (1.0 - drawn))
    centre = np.array([THREAD_BALL_AT[0], THREAD_BALL_AT[1], FLOOR + radius * 0.94 + 0.09 * pose["ball_hop"]])
    props.build_thread_ball(centre, radius)
    path = thread_path(tower_yaw, np.array(on_floor(THREAD_BALL_AT, 2.0 * THREAD_BALL_RADIUS * 0.94 - 0.03)))
    count = int(round(drawn * len(path)))
    if count >= 4:
        props.build_thread(path[:count], treasury.CORD_PLY, treasury.CORD_HELIX, treasury.CORD_PERIOD)


def build_scene(pose, paths):
    props.build_backdrop()
    shapes.group("stage", props.build_stage(), (STAGE_AT[0], STAGE_AT[1], 0.0))
    holds = build_letter_and_lantern(pose, paths)
    build_people(pose, holds, paths)

    tower_yaw = dolls.facing(*TREASURY_FACES)
    gold = 1.0 + 0.14 * math.sin(2.0 * pose["cycle"] + 0.5)
    parts = treasury.build_treasury(gold) + treasury.build_bow(pose["bow"], pose["cycle"])
    shapes.group("treasury", parts, on_floor(TREASURY_AT), tower_yaw)
    build_thread(pose, tower_yaw)
    props.build_kolam(KOLAM_AT)
    shapes.group("palm", props.build_palm(sway=pose["cycle"]), PALM_AT)
    shapes.group("pots", props.build_pots(), POTS_AT)

    layout.make_camera(on_floor(WATCHMAN_AT, 1.0) if layout.FOCUS is None else layout.FOCUS)
    scene = bpy.context.scene
    materials.build_world(scene, WORLD_STRENGTH)
    add_sun(scene)
    return scene


def add_sun(scene):
    data = bpy.data.lights.new("sun", "SUN")
    data.energy = SUN_STRENGTH
    data.angle = math.radians(SUN_SOFTNESS_DEG)
    data.color = (1.0, 0.97, 0.92)
    obj = bpy.data.objects.new("sun", data)
    scene.collection.objects.link(obj)
    obj.rotation_euler = Vector(SUN_TRAVEL).normalized().to_track_quat("-Z", "Y").to_euler()
    return obj


def setup_render(scene, out_path, width, height, samples):
    scene.render.engine = "CYCLES"
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100

    cy = scene.cycles
    cy.device = "GPU"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "OPTIX"
    prefs.refresh_devices()
    for dev in prefs.devices:
        dev.use = dev.type == "OPTIX" and "NVIDIA" in dev.name
    cy.samples = samples
    cy.use_adaptive_sampling = False
    # One seed for every frame: what does not move is sampled the same way each time, so it
    # comes out identical and does not shimmer.
    cy.seed = palette.SEED
    cy.use_animated_seed = False
    cy.use_denoising = True
    cy.denoiser = "OPENIMAGEDENOISE"
    cy.denoising_use_gpu = True
    cy.denoising_input_passes = "RGB_ALBEDO_NORMAL"
    cy.denoising_prefilter = "ACCURATE"
    cy.max_bounces = 8
    cy.diffuse_bounces = 4
    cy.glossy_bounces = 4
    cy.transmission_bounces = 2
    cy.sample_clamp_indirect = 8.0
    cy.caustics_reflective = False
    cy.caustics_refractive = False
    scene.render.filter_size = 1.5

    # Standard, not a film look: a colour in the palette comes out as that colour on the page.
    vs = scene.view_settings
    vs.view_transform = "Standard"
    vs.look = "None"
    vs.exposure = 0.0
    vs.gamma = 1.0
    scene.display_settings.display_device = "sRGB"

    img = scene.render.image_settings
    img.file_format = "PNG"
    img.color_mode = "RGB"
    img.color_depth = "8"
    img.compression = 15
    scene.render.filepath = os.path.abspath(out_path)


def report_positions(pose):
    """Print where the main things land in the frame, to check the composition before a long render."""
    tower = np.array(on_floor(TREASURY_AT))
    stage = np.array([STAGE_AT[0], STAGE_AT[1], 0.0])
    rows = [
        ("tower top", tower + [0.0, 0.0, treasury.HEIGHT]),
        ("watchman head", np.array(on_floor(WATCHMAN_AT, dolls.WATCHMAN_HEAD[2]))),
        ("letter held up", LETTER_HELD_UP),
        ("lantern glass", staff_tip(pose) + [0.0, 0.0, -0.57]),
        ("kolam", np.array(KOLAM_AT)),
        ("stage front", stage + [0.0, -props.STAGE_RADIUS, 0.0]),
        ("stage left", stage + [-props.STAGE_RADIUS, 0.0, FLOOR]),
        ("stage right", stage + [props.STAGE_RADIUS, 0.0, FLOOR]),
    ]
    print("FRAME POSITIONS:")
    for label, point in rows:
        fx, fy, depth = layout.project(np.array([point]))
        print("  POS %-14s frame (%.3f, %.3f) depth %.1f" % (label, fx[0], fy[0], depth[0]))


def report_backdrop(path):
    """Print the colour of the paper in each corner, which the page's own background has to match."""
    img = bpy.data.images.load(path)
    w, h = img.size
    px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)
    for label, block in (("top left", px[-24:, :24]), ("top right", px[-24:, -24:]),
                         ("bottom left", px[:24, :24]), ("bottom right", px[:24, -24:])):
        r, g, b = (block[:, :, :3].reshape(-1, 3).mean(axis=0) * 255.0).round().astype(int)
        print("BACKDROP %-12s #%02X%02X%02X" % (label, r, g, b))
