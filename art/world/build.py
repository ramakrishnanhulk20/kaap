"""Renders one picture of the Kaap toy set. Run with Blender in background mode:

    blender -b --python-exit-code 1 -P build.py -- --out out/still.png --width 3000 --height 1500 --samples 160

With no --frame it renders the end of the story: the key showing in the letter and the thread
tied round the treasury. Any frame of the film can be asked for instead.
"""
import argparse
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import bpy  # noqa: E402

import layout  # noqa: E402
import scene  # noqa: E402
import textures  # noqa: E402
import timeline  # noqa: E402


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out", required=True)
    p.add_argument("--width", type=int, default=1500)
    p.add_argument("--height", type=int, default=750)
    p.add_argument("--samples", type=int, default=96)
    p.add_argument("--frame", type=int, default=timeline.END_POSE_FRAME)
    p.add_argument("--shot", choices=sorted(layout.SHOTS), help="a closer view of part of the set")
    return p.parse_args(argv)


def main():
    started = time.time()
    args = parse_args()
    out_dir = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(out_dir, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    layout.set_aspect(args.width, args.height)
    if args.shot:
        layout.use_shot(args.shot)

    pose = timeline.pose(args.frame)
    built = scene.build_scene(pose, textures.paint_letters(out_dir))
    print("SCENE_READY %.1fs objects=%d" % (time.time() - started, len(bpy.data.objects)))
    scene.report_positions(pose)
    scene.setup_render(built, args.out, args.width, args.height, args.samples)

    t = time.time()
    bpy.ops.render.render(write_still=True)
    print("RENDER_SECONDS %.1f" % (time.time() - t))
    scene.report_backdrop(built.render.filepath)
    print("WROTE %s" % built.render.filepath)


if __name__ == "__main__":
    main()
