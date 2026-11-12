"""When things happen in the film. It runs at 24 frames a second: a story that plays once, then a
loop that repeats for as long as the page is open.

The story: a member lifts her sealed letter, the watchman takes hold of it and swings his lantern
behind it, the light shows a key hidden inside, and the thread leaps from its ball, winds three
times round the treasury and ties itself in a bow across the door.
"""
import math

FPS = 24
STORY_FRAMES = 216
LOOP_FRAMES = 96
LAST_FRAME = STORY_FRAMES + LOOP_FRAMES


def _ease(t, start, end):
    """0 before `start`, 1 after `end`, and a smooth slide between."""
    x = min(1.0, max(0.0, (t - start) / (end - start)))
    return x * x * (3.0 - 2.0 * x)


def _spring(t, start, end):
    """Like `_ease`, but it runs a little past 1 and comes back, the way a pulled knot settles."""
    x = min(1.0, max(0.0, (t - start) / (end - start)))
    k = 1.9
    return 1.0 + (k + 1.0) * (x - 1.0) ** 3 + k * (x - 1.0) ** 2


def _bump(t, start, end):
    """0 outside the span, rising to 1 in its middle."""
    if t <= start or t >= end:
        return 0.0
    return math.sin(math.pi * (t - start) / (end - start))


def pose(frame):
    """Where every moving thing is on a frame, each as a number from 0 (story start) to 1 (story end).

    `cycle` is the angle of the slow sway everything shares. It turns once per loop, so the last
    frame of the loop leads back into its first.
    """
    t = (frame - 1) / FPS
    swing = _ease(t, 1.9, 3.1)
    return {
        "cycle": 2.0 * math.pi * (frame - 1) / LOOP_FRAMES,
        "lift": _ease(t, 0.5, 1.7),
        "grip": _ease(t, 1.3, 2.0),
        "swing": swing,
        # The lantern hangs back while the staff moves and catches up as it stops.
        "lantern_lag": math.sin(math.pi * swing) + 0.35 * _bump(t, 3.1, 3.7) * math.sin(14.0 * (t - 3.1)),
        "glow": _ease(t, 2.7, 3.4),
        "alarm": _bump(t, 3.5, 4.1),
        "ball_hop": _bump(t, 4.15, 4.5),
        "thread": _ease(t, 4.4, 7.0),
        "bow": _spring(t, 6.95, 7.75) if t > 6.95 else 0.0,
    }


END_POSE_FRAME = STORY_FRAMES
