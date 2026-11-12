"""Mesh building blocks: turned shapes, tubes along a path, twisted cord and flat slabs.

Every toy in the scene is made the way a lathe-turned wooden toy is: a profile spun around an axis,
plus a few tubes and slabs. Builders return (vertices, faces); `make_object` turns them into an object.
"""
import math

import bmesh
import bpy
import numpy as np


def lathe(profile, segments=72):
    """Spin a list of (radius, z) points around the z axis. A radius of 0 closes the shape with a pole."""
    ang = np.linspace(0.0, 2 * np.pi, segments, endpoint=False)
    verts, rings = [], []
    for r, z in profile:
        if r < 1e-9:
            rings.append([len(verts)])
            verts.append((0.0, 0.0, float(z)))
        else:
            rings.append(list(range(len(verts), len(verts) + segments)))
            verts.extend((r * math.cos(a), r * math.sin(a), float(z)) for a in ang)
    faces = []
    for lower, upper in zip(rings[:-1], rings[1:]):
        if len(lower) == 1 and len(upper) == 1:
            continue
        for k in range(segments):
            k2 = (k + 1) % segments
            if len(lower) == 1:
                faces.append((lower[0], upper[k2], upper[k]))
            elif len(upper) == 1:
                faces.append((lower[k], lower[k2], upper[0]))
            else:
                faces.append((lower[k], lower[k2], upper[k2], upper[k]))
    return np.array(verts, dtype=float), faces


def sphere(radius, squash=(1.0, 1.0, 1.0), segments=40, rings=20):
    profile = [(radius * math.sin(math.pi * i / rings), -radius * math.cos(math.pi * i / rings)) for i in range(rings + 1)]
    profile[0] = (0.0, -radius)
    profile[-1] = (0.0, radius)
    verts, faces = lathe(profile, segments)
    return verts * np.asarray(squash, dtype=float)[None, :], faces


def catmull(points, ds=0.02):
    """A smooth curve through the points, resampled so neighbours are `ds` apart."""
    p = np.asarray(points, dtype=float)
    p = np.vstack([2 * p[0] - p[1], p, 2 * p[-1] - p[-2]])
    out = []
    for i in range(1, len(p) - 2):
        p0, p1, p2, p3 = p[i - 1], p[i], p[i + 1], p[i + 2]
        steps = max(4, int(np.linalg.norm(p2 - p1) / ds * 2))
        for t in np.linspace(0.0, 1.0, steps, endpoint=False):
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
                              + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
    out.append(p[-2])
    return resample(np.array(out), ds)


def arc_length(path):
    return np.concatenate([[0.0], np.cumsum(np.linalg.norm(np.diff(path, axis=0), axis=1))])


def resample(path, ds):
    s = arc_length(path)
    n = max(2, int(round(s[-1] / ds)) + 1)
    target = np.linspace(0.0, s[-1], n)
    return np.stack([np.interp(target, s, path[:, k]) for k in range(path.shape[1])], axis=1)


def frames(path, up=(0.0, 0.0, 1.0), closed=False):
    """Tangent, normal and binormal along a path. The normal is carried along so the tube never twists."""
    path = np.asarray(path, dtype=float)
    if closed:
        tangent = np.roll(path, -1, axis=0) - np.roll(path, 1, axis=0)
    else:
        tangent = np.gradient(path, axis=0)
    tangent /= np.linalg.norm(tangent, axis=1, keepdims=True)
    normal = np.zeros_like(path)
    ref = np.asarray(up, dtype=float)
    v = ref - tangent[0] * (tangent[0] @ ref)
    if np.linalg.norm(v) < 1e-6:
        ref = np.array([1.0, 0.0, 0.0])
        v = ref - tangent[0] * (tangent[0] @ ref)
    normal[0] = v / np.linalg.norm(v)
    for i in range(1, len(path)):
        v = normal[i - 1] - tangent[i] * (tangent[i] @ normal[i - 1])
        normal[i] = v / np.linalg.norm(v)
    return tangent, normal, np.cross(tangent, normal)


def tube(path, radius, around=10, up=(0.0, 0.0, 1.0), squash=1.0, closed=False):
    """A round tube along the path. `radius` may vary along it; `squash` flattens it along the normal."""
    path = np.asarray(path, dtype=float)
    radius = np.broadcast_to(np.asarray(radius, dtype=float), (len(path),))
    _, normal, binormal = frames(path, up, closed)
    ang = np.linspace(0.0, 2 * np.pi, around, endpoint=False)
    ring = (squash * np.cos(ang)[None, :, None] * normal[:, None, :] + np.sin(ang)[None, :, None] * binormal[:, None, :])
    verts = (path[:, None, :] + radius[:, None, None] * ring).reshape(-1, 3)
    faces = []
    spans = len(path) if closed else len(path) - 1
    for i in range(spans):
        a, c = i * around, ((i + 1) % len(path)) * around
        for k in range(around):
            k2 = (k + 1) % around
            faces.append((a + k, c + k, c + k2, a + k2))
    if not closed:
        verts = np.vstack([verts, path[0], path[-1]])
        first, last, tail = len(verts) - 2, len(verts) - 1, (len(path) - 1) * around
        for k in range(around):
            k2 = (k + 1) % around
            faces.append((first, k, k2))
            faces.append((last, tail + k2, tail + k))
    return verts, faces


def cord(path, ply_radius, helix_radius, period, plies=2, around=8, up=(0.0, 0.0, 1.0), closed=False):
    """Twisted thread: `plies` strands wound around the path, one full turn every `period`."""
    path = np.asarray(path, dtype=float)
    _, normal, binormal = frames(path, up, closed)
    s = arc_length(path)
    parts = []
    for k in range(plies):
        phi = 2 * np.pi * s / period + 2 * np.pi * k / plies
        centre = path + helix_radius * (np.cos(phi)[:, None] * normal + np.sin(phi)[:, None] * binormal)
        parts.append(tube(centre, ply_radius, around, up, closed=closed))
    return merge(parts)


def merge(parts):
    verts, faces, offset = [], [], 0
    for v, f in parts:
        verts.append(np.asarray(v, dtype=float))
        faces.extend(tuple(i + offset for i in face) for face in f)
        offset += len(v)
    return np.vstack(verts), faces


def rounded_rect(width, height, radius, steps=5):
    """Outline of a rounded rectangle centred on the origin, counter-clockwise."""
    hw, hh = width / 2.0, height / 2.0
    points = []
    for cx, cz, start in ((hw - radius, hh - radius, 0.0), (-hw + radius, hh - radius, 90.0),
                          (-hw + radius, -hh + radius, 180.0), (hw - radius, -hh + radius, 270.0)):
        for i in range(steps + 1):
            a = math.radians(start + 90.0 * i / steps)
            points.append((cx + radius * math.cos(a), cz + radius * math.sin(a)))
    return points


def arch(width, height, steps=18):
    """Outline of a doorway: a rectangle standing on z = 0 with a half-round top, counter-clockwise."""
    hw = width / 2.0
    points = [(hw, 0.0)]
    for i in range(steps + 1):
        a = math.pi * i / steps
        points.append((hw * math.cos(a), height - hw + hw * math.sin(a)))
    points.append((-hw, 0.0))
    return points


def slab(outline, thickness):
    """Extrude an (x, z) outline along y, centred on y = 0."""
    n = len(outline)
    half = thickness / 2.0
    verts = [(x, -half, z) for x, z in outline] + [(x, half, z) for x, z in outline]
    faces = [tuple(range(n)), tuple(range(2 * n - 1, n - 1, -1))]
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, i + n, j + n, j))
    return np.array(verts, dtype=float), faces


def box(size, centre=(0.0, 0.0, 0.0)):
    sx, sy, sz = (v / 2.0 for v in size)
    cx, cy, cz = centre
    verts = [(cx + a * sx, cy + b * sy, cz + c * sz) for c in (-1, 1) for b in (-1, 1) for a in (-1, 1)]
    faces = [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (1, 3, 7, 5), (3, 2, 6, 7), (2, 0, 4, 6)]
    return np.array(verts, dtype=float), faces


def ring(major, minor, around=10, segments=40, plane="xz"):
    """A closed ring of radius `major` made of tube `minor` thick, standing in the given plane."""
    a = np.linspace(0.0, 2 * np.pi, segments, endpoint=False)
    zero = np.zeros_like(a)
    if plane == "xz":
        path = np.stack([major * np.cos(a), zero, major * np.sin(a)], axis=1)
        up = (0.0, 1.0, 0.0)
    else:
        path = np.stack([major * np.cos(a), major * np.sin(a), zero], axis=1)
        up = (0.0, 0.0, 1.0)
    return tube(path, minor, around, up, closed=True)


def moved(verts, offset=(0.0, 0.0, 0.0), yaw=0.0):
    """The vertices turned about z by `yaw`, then shifted."""
    c, s = math.cos(yaw), math.sin(yaw)
    v = np.asarray(verts, dtype=float)
    out = np.stack([c * v[:, 0] - s * v[:, 1], s * v[:, 0] + c * v[:, 1], v[:, 2]], axis=1)
    return out + np.asarray(offset, dtype=float)[None, :]


def make_object(name, verts, faces, material, bevel=0.0, sharp_deg=38.0):
    """Turn (vertices, faces) into a smooth-shaded object. `bevel` rounds every hard edge by that width."""
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([tuple(map(float, v)) for v in verts], [], [tuple(f) for f in faces])
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()
    mesh.polygons.foreach_set("use_smooth", [True] * len(mesh.polygons))
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    mesh.materials.append(material)
    if bevel > 0.0:
        mod = obj.modifiers.new("bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 3
        mod.limit_method = "ANGLE"
        mod.angle_limit = math.radians(sharp_deg)
        obj.modifiers.new("normals", "WEIGHTED_NORMAL")
    else:
        mesh.set_sharp_from_angle(angle=math.radians(sharp_deg))
    return obj


def turned(name, control, bands, bevel=0.012):
    """A solid turned from one (radius, z) silhouette and painted in bands of (z0, z1, material)."""
    ctrl = np.asarray(control, dtype=float)
    dense = catmull(np.c_[ctrl, np.zeros(len(ctrl))], 0.01)
    order = np.argsort(dense[:, 1])
    objs = []
    for i, (z0, z1, mat) in enumerate(bands):
        zs = np.linspace(z0, z1, max(4, int((z1 - z0) / 0.03) + 2))
        rs = np.interp(zs, dense[order, 1], dense[order, 0])
        v, f = lathe([(0.0, z0)] + list(zip(rs, zs)) + [(0.0, z1)], 64)
        objs.append(make_object("%s_band%d" % (name, i), v, f, mat, bevel))
    return objs


def group(name, objects, location=(0.0, 0.0, 0.0), yaw=0.0):
    """Parent the objects to one empty, then stand it at `location` turned by `yaw`."""
    root = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(root)
    for obj in objects:
        obj.parent = root
    root.location = location
    root.rotation_euler = (0.0, 0.0, yaw)
    return root
