"""Camera and frame maths. The camera looks down on the stage from the front through a long lens,
the way a toy set is photographed on a table."""
import math

import numpy as np

TARGET = np.array([0.2, 0.0, 0.99])
DISTANCE = 27.1
PITCH_DEG = 13.5
LENS_MM = 85.0
SENSOR_MM = 36.0
FSTOP = 0.6
ASPECT = 2.0


def set_aspect(width, height):
    global ASPECT
    ASPECT = float(width) / float(height)


def location():
    pitch = math.radians(PITCH_DEG)
    return TARGET + DISTANCE * np.array([0.0, -math.cos(pitch), math.sin(pitch)])


def _basis():
    forward = TARGET - location()
    forward = forward / np.linalg.norm(forward)
    right = np.cross(forward, np.array([0.0, 0.0, 1.0]))
    right = right / np.linalg.norm(right)
    return forward, right, np.cross(right, forward)


def project(points):
    """Frame position (fx, fy), each 0 to 1 from the top left, and depth, for an (N, 3) array of points."""
    forward, right, up = _basis()
    p = np.asarray(points, dtype=float).reshape(-1, 3) - location()[None, :]
    depth = p @ forward
    half_w = (SENSOR_MM / 2.0) / LENS_MM
    half_h = half_w / ASPECT
    return 0.5 + 0.5 * (p @ right) / depth / half_w, 0.5 - 0.5 * (p @ up) / depth / half_h, depth


def make_camera(focus_point):
    import bpy
    from mathutils import Vector

    data = bpy.data.cameras.new("kaap_camera")
    data.lens = LENS_MM
    data.sensor_width = SENSOR_MM
    data.sensor_fit = "HORIZONTAL"
    data.clip_start = 0.1
    data.clip_end = 400.0
    data.dof.use_dof = True
    data.dof.focus_distance = float((np.asarray(focus_point, dtype=float) - location()) @ _basis()[0])
    data.dof.aperture_fstop = FSTOP
    cam = bpy.data.objects.new("kaap_camera", data)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = Vector(location().tolist())
    cam.rotation_euler = Vector((TARGET - location()).tolist()).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = cam
    return cam
