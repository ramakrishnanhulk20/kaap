"""Builds the Kaap hero still and renders it. Run with Blender in background mode:

    blender -b --python-exit-code 1 -P build.py -- --out out/still.png --width 1500 --height 750 --samples 96

The scene: members bring sealed letters to the treasury door. The watchman holds one up to his
lantern, the light shows a key hidden inside, and the yellow thread is already tied round the tower.
"""
import argparse
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402

import dolls  # noqa: E402
import layout  # noqa: E402
import materials  # noqa: E402
import palette  # noqa: E402
import props  # noqa: E402
import shapes  # noqa: E402
import textures  # noqa: E402
import treasury  # noqa: E402

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
LETTER_CENTRE = np.array([-0.35, -0.6, 1.22 + FLOOR])
LETTER_SIZE = (1.2, 0.86)
LETTER_ROLL_DEG = 6.0
STAFF_FOOT = np.array([0.5, 0.02, 0.04 + FLOOR])
STAFF_TIP = np.array([-0.42, 0.12, 2.5 + FLOOR])
STAFF_GRIP_HEIGHT = 1.0 + FLOOR

TREASURY_AT = (2.75, 0.75)
TREASURY_FACES = (-0.62, -0.78)
THREAD_BALL_AT = np.array([1.45, -1.3, 0.19 + FLOOR])
KOLAM_AT = (0.2, -2.85, FLOOR)
PALM_AT = (-2.6, 2.9, FLOOR)
POTS_AT = (-3.7, 1.35, FLOOR)

# name, where, facing, body, base band, skin, head, top, size
MEMBERS = [
    ("member_a", (-1.42, -0.5), (0.92, -0.39), palette.LEAF, palette.VERMILION, palette.SKIN, "bun", None, 1.0),
    ("member_b", (-2.42, -0.2), (0.85, -0.53), palette.WHITE, palette.LEAF, palette.SKIN_DEEP, "cap", palette.ORANGE, 1.08),
    ("member_c", (-3.35, 0.2), (0.8, -0.6), palette.PINK, palette.TEAL, palette.SKIN, "bun", None, 0.94),
]


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out", required=True)
    p.add_argument("--width", type=int, default=1500)
    p.add_argument("--height", type=int, default=750)
    p.add_argument("--samples", type=int, default=96)
    return p.parse_args(argv)


def add_sun(scene):
    data = bpy.data.lights.new("sun", "SUN")
    data.energy = SUN_STRENGTH
    data.angle = math.radians(SUN_SOFTNESS_DEG)
    data.color = (1.0, 0.97, 0.92)
    obj = bpy.data.objects.new("sun", data)
    scene.collection.objects.link(obj)
    obj.rotation_euler = Vector(SUN_TRAVEL).normalized().to_track_quat("-Z", "Y").to_euler()
    return obj


def setup_render(scene, args):
    scene.render.engine = "CYCLES"
    scene.render.resolution_x = args.width
    scene.render.resolution_y = args.height
    scene.render.resolution_percentage = 100

    cy = scene.cycles
    cy.device = "GPU"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "OPTIX"
    prefs.refresh_devices()
    for dev in prefs.devices:
        dev.use = dev.type == "OPTIX" and "NVIDIA" in dev.name
    cy.samples = args.samples
    cy.use_adaptive_sampling = False
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
    scene.render.filepath = os.path.abspath(args.out)


def on_floor(xy, height=0.0):
    return (xy[0], xy[1], FLOOR + height)


def build_letter_scene(paths):
    """The big letter held up to the lantern, with its seal, and the lantern on the watchman's staff."""
    roll = math.radians(LETTER_ROLL_DEG)
    face = materials.letter_face(paths["lit"], paths["glow"], LETTER_SIZE[0], LETTER_SIZE[1], 0.4, "letter_lit")
    letter = props.build_letter("letter_held", LETTER_SIZE[0], LETTER_SIZE[1], face)
    letter.location = LETTER_CENTRE
    letter.rotation_euler = (0.0, -roll, 0.0)
    seal = props.build_seal("letter_held_seal", (0.0, -0.014, -0.29), 0.075)
    seal.parent = letter

    props.build_staff(STAFF_FOOT, STAFF_TIP)
    shapes.group("lantern", props.build_lantern(), STAFF_TIP + np.array([0.0, 0.0, -0.045]))

    along = np.array([math.cos(roll), 0.0, math.sin(roll)])
    up = np.array([-math.sin(roll), 0.0, math.cos(roll)])
    half_w, half_h = LETTER_SIZE[0] / 2.0, LETTER_SIZE[1] / 2.0
    grip = (STAFF_GRIP_HEIGHT - STAFF_FOOT[2]) / (STAFF_TIP[2] - STAFF_FOOT[2])
    return {
        "right_edge": LETTER_CENTRE + along * (half_w - 0.015),
        "left_edge": LETTER_CENTRE - along * (half_w - 0.01) - up * 0.2,
        "bottom_edge": LETTER_CENTRE - along * (half_w - 0.22) - up * (half_h - 0.01),
        "staff_grip": STAFF_FOOT + (STAFF_TIP - STAFF_FOOT) * grip,
    }


def build_people(holds, paths):
    yaw = dolls.facing(*WATCHMAN_FACES)
    root = on_floor(WATCHMAN_AT)
    watchman = dolls.build_watchman(dolls.to_local(holds["staff_grip"], root, yaw),
                                    dolls.to_local(holds["right_edge"], root, yaw))
    shapes.group("watchman", watchman, root, yaw)

    plain = materials.letter_face(paths["plain"], None, 0.46, 0.33, 0.0, "letter_plain")
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


def build_thread_to_ball(tower_yaw):
    """The loose end of the thread: from the ball on the floor, across to the tower and up to the wraps."""
    tower = np.array(on_floor(TREASURY_AT))
    turns = -28.0 / 360.0
    anchor = shapes.moved(treasury.wrap_point(turns, 0.87)[None, :], tower, tower_yaw)[0]
    out = (anchor - tower) * np.array([1.0, 1.0, 0.0])
    out /= np.linalg.norm(out)
    lie = FLOOR + 0.05
    ball = THREAD_BALL_AT
    points = [
        ball + np.array([0.06, 0.1, 0.14]),
        np.array([ball[0] + 0.2, ball[1] + 0.28, lie]),
        np.array([ball[0] - 0.05, ball[1] + 0.62, lie]),
        tower + out * 1.95 + np.array([0.12, 0.0, lie - FLOOR]),
        tower + out * 1.64 + np.array([0.0, 0.0, lie - FLOOR]),
        tower + out * 1.56 + np.array([0.0, 0.0, treasury.STEP + 0.06]),
        tower + out * (treasury.RADIUS + 0.07) + np.array([0.0, 0.0, 0.5]),
        anchor,
    ]
    props.build_thread_ball(ball)
    props.build_strand(points)


def report_positions():
    """Print where the main things land in the frame, to check the composition before a long render."""
    tower = np.array(on_floor(TREASURY_AT))
    stage = np.array([STAGE_AT[0], STAGE_AT[1], 0.0])
    rows = [
        ("tower top", tower + [0.0, 0.0, treasury.HEIGHT]),
        ("tower base", tower),
        ("watchman head", np.array(on_floor(WATCHMAN_AT, dolls.WATCHMAN_HEAD[2]))),
        ("letter centre", LETTER_CENTRE),
        ("lantern glass", STAFF_TIP + [0.0, 0.0, -0.57]),
        ("member c", np.array(on_floor(MEMBERS[2][1]))),
        ("kolam", np.array(KOLAM_AT)),
        ("stage front", stage + [0.0, -props.STAGE_RADIUS, 0.0]),
        ("stage rim top", stage + [0.0, -props.STAGE_RADIUS, FLOOR]),
        ("stage back", stage + [0.0, props.STAGE_RADIUS, FLOOR]),
        ("stage left", stage + [-props.STAGE_RADIUS, 0.0, FLOOR]),
        ("stage right", stage + [props.STAGE_RADIUS, 0.0, FLOOR]),
        ("palm top", np.array(PALM_AT) + [0.3, 0.0, 2.7]),
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


def main():
    started = time.time()
    args = parse_args()
    out_dir = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(out_dir, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    layout.set_aspect(args.width, args.height)

    paths = textures.paint_letters(out_dir)
    props.build_backdrop()
    shapes.group("stage", props.build_stage(), (STAGE_AT[0], STAGE_AT[1], 0.0))
    holds = build_letter_scene(paths)
    build_people(holds, paths)

    tower_yaw = dolls.facing(*TREASURY_FACES)
    shapes.group("treasury", treasury.build_treasury(), on_floor(TREASURY_AT), tower_yaw)
    build_thread_to_ball(tower_yaw)
    props.build_kolam(KOLAM_AT)
    shapes.group("palm", props.build_palm(), PALM_AT)
    shapes.group("pots", props.build_pots(), POTS_AT)
    print("SCENE_READY %.1fs objects=%d" % (time.time() - started, len(bpy.data.objects)))

    layout.make_camera(on_floor(WATCHMAN_AT, 1.0))
    report_positions()
    materials.build_world(scene, WORLD_STRENGTH)
    add_sun(scene)
    setup_render(scene, args)

    t = time.time()
    bpy.ops.render.render(write_still=True)
    print("RENDER_SECONDS %.1f" % (time.time() - t))
    report_backdrop(scene.render.filepath)
    print("WROTE %s" % scene.render.filepath)


if __name__ == "__main__":
    main()
