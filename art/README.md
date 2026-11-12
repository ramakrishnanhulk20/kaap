# The art behind Kaap

The hero film on the landing page is a set of painted wooden toys: members bring sealed letters to a striped round treasury, a watchman holds one up to his lantern, the light shows a key hidden inside, and a yellow thread winds round the treasury and ties itself across the door. Kaap is named after that thread: kaappu, a thread tied for protection.

Nothing is stock art and nothing is modelled by hand. Every toy is built in code by the Python scripts in `world/`, run inside Blender 5.2, and a run writes its pictures to `world/out/`. Install Blender 5.2 from blender.org, put it on your PATH, and run these from `art/world`:

```bash
blender -b --python-exit-code 1 -P build.py -- --out out/still.png --width 3000 --height 1500 --samples 160
blender -b --python-exit-code 1 -P animate.py -- --out-dir out/film --width 2000 --height 1000 --samples 100
bash encode.sh
```

The first command renders one picture, by default the end of the story; `--frame N` picks any frame of the film. The second renders the film's 312 frames at 24 a second: 216 of story, then a 96-frame loop. It skips frames that are already on disk, so a run that was stopped picks up where it left off, and `--step 12` gives a quick look at the motion first. The third needs ffmpeg and turns the frames into the files the site plays, in `packages/web/public/world/film`.

## What each script holds

| Script | What is in it |
|---|---|
| `palette.py` | Every colour, as the hex value you see on screen |
| `shapes.py` | Turned shapes, tubes, twisted thread and flat slabs: the few forms every toy is made from |
| `materials.py` | Lacquer, bare wood, paper, thread, brass and light |
| `textures.py` | The letters: an airmail border, and the key the lamplight shows |
| `dolls.py` | The watchman and the members |
| `treasury.py` | The treasury, its door, and the thread's path round it |
| `props.py` | The round stage, lantern, letters, kolam, ball of thread, palm and pots |
| `timeline.py` | When each thing happens in the film |
| `scene.py` | Puts one frame together, lights it and sets up the render |
| `layout.py` | The camera |

The paper the set stands on is the page's own background colour, so the picture has no frame on the site. If you change the light or the paper in `scene.py` or `palette.py`, read the `BACKDROP` lines that `build.py` prints and set the same colour as the page background in `packages/web/app/globals.css`.
