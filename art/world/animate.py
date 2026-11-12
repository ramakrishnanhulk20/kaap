"""Renders the frames of the Kaap film. Run with Blender in background mode:

    blender -b --python-exit-code 1 -P animate.py -- --out-dir out/film --width 2400 --height 1200 --samples 128

Frames 1 to 216 are the story and 217 to 312 the loop. A frame that is already on disk is
skipped, so a run that was stopped picks up where it left off. --step renders every nth frame,
for a quick look at the motion before the long run.
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
    p.add_argument("--out-dir", required=True)
    p.add_argument("--width", type=int, default=2400)
    p.add_argument("--height", type=int, default=1200)
    p.add_argument("--samples", type=int, default=128)
    p.add_argument("--start", type=int, default=1)
    p.add_argument("--end", type=int, default=timeline.LAST_FRAME)
    p.add_argument("--step", type=int, default=1)
    return p.parse_args(argv)


def main():
    args = parse_args()
    out_dir = os.path.abspath(args.out_dir)
    os.makedirs(out_dir, exist_ok=True)
    layout.set_aspect(args.width, args.height)
    paths = textures.paint_letters(out_dir)
    started = time.time()
    rendered = 0
    for frame in range(args.start, args.end + 1, args.step):
        out_path = os.path.join(out_dir, "frame_%04d.png" % frame)
        if os.path.exists(out_path):
            continue
        bpy.ops.wm.read_factory_settings(use_empty=True)
        built = scene.build_scene(timeline.pose(frame), paths)
        # Written under another name first, so a run stopped mid-frame leaves no half picture
        # that the next run would take for a finished one.
        partial = os.path.join(out_dir, "partial_%04d.png" % frame)
        scene.setup_render(built, partial, args.width, args.height, args.samples)
        bpy.ops.render.render(write_still=True)
        os.replace(partial, out_path)
        rendered += 1
        print("FRAME %d done, %d rendered in %.0fs" % (frame, rendered, time.time() - started), flush=True)
    print("FILM_FRAMES_DONE rendered=%d seconds=%.0f" % (rendered, time.time() - started))


if __name__ == "__main__":
    main()
