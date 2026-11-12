"""Materials: glossy lacquer over turned wood, bare wood, paper, thread, brass and light."""
import bpy

import palette


def _new_material(name):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.node_tree.nodes.clear()
    return mat, mat.node_tree


def _node(nt, kind, **props):
    n = nt.nodes.new(kind)
    for key, value in props.items():
        setattr(n, key, value)
    return n


def _rgba(hex_color, k=1.0):
    r, g, b = palette.hex_to_linear(hex_color)
    return (min(r * k, 1.0), min(g * k, 1.0), min(b * k, 1.0), 1.0)


def _map_range(nt, src, lo, hi):
    n = _node(nt, "ShaderNodeMapRange", clamp=True)
    nt.links.new(src, n.inputs[0])
    n.inputs[1].default_value = lo
    n.inputs[2].default_value = hi
    return n.outputs["Result"]


def _mix_colour(nt, fac, a, b):
    """Colour mix. `fac` is a socket or a number; a and b are sockets or RGBA tuples."""
    n = _node(nt, "ShaderNodeMix", data_type="RGBA", blend_type="MIX")
    # Mix has float, vector and colour sockets with the same names, so pick by position:
    # inputs 0 = factor, 6 = colour A, 7 = colour B; output 2 = colour result.
    if isinstance(fac, (int, float)):
        n.inputs[0].default_value = fac
    else:
        nt.links.new(fac, n.inputs[0])
    for slot, val in ((6, a), (7, b)):
        if isinstance(val, tuple):
            n.inputs[slot].default_value = val
        else:
            nt.links.new(val, n.inputs[slot])
    return n.outputs[2]


def _principled(nt):
    out = _node(nt, "ShaderNodeOutputMaterial")
    bsdf = _node(nt, "ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return bsdf


def _lathe_lines(nt, coord, bsdf, strength):
    """Fine rings left by the turning tool, running around the object's own z axis."""
    # Wave bands repeat every 0.314 / Scale, so this is one ring every 9 mm of toy.
    wave = _node(nt, "ShaderNodeTexWave", wave_type="BANDS", bands_direction="Z")
    wave.inputs["Scale"].default_value = 35.0
    wave.inputs["Distortion"].default_value = 0.6
    wave.inputs["Detail"].default_value = 1.0
    nt.links.new(coord.outputs["Object"], wave.inputs["Vector"])
    bump = _node(nt, "ShaderNodeBump")
    bump.inputs["Strength"].default_value = strength
    bump.inputs["Distance"].default_value = 0.004
    nt.links.new(wave.outputs["Factor"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])


def _gloss(bsdf, rough, coat):
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Coat Weight"].default_value = coat
    bsdf.inputs["Coat Roughness"].default_value = 0.07
    bsdf.inputs["Specular IOR Level"].default_value = 0.5


def lacquer(hex_color, rough=0.3, coat=0.9, lines=0.12, name=None, vary=0.1):
    """Lac-turned colour: an even coat with a wet shine and the faint rings of the lathe under it."""
    name = name or "lacquer_%s_%d" % (hex_color.lstrip("#"), int(lines * 100))
    existing = bpy.data.materials.get(name)
    if existing is not None:
        return existing
    mat, nt = _new_material(name)
    bsdf = _principled(nt)
    coord = _node(nt, "ShaderNodeTexCoord")
    mottle = _node(nt, "ShaderNodeTexNoise")
    mottle.inputs["Scale"].default_value = 2.4
    mottle.inputs["Detail"].default_value = 2.0
    nt.links.new(coord.outputs["Object"], mottle.inputs["Vector"])
    fac = _map_range(nt, mottle.outputs["Factor"], 0.35, 0.65)
    nt.links.new(_mix_colour(nt, fac, _rgba(hex_color), _rgba(hex_color, 1.0 - vary)), bsdf.inputs["Base Color"])
    if lines:
        _lathe_lines(nt, coord, bsdf, lines)
    _gloss(bsdf, rough, coat)
    return mat


def wood(hex_color=palette.WOOD, name=None):
    """Bare turned wood: pale, with long grain streaks along the turning axis and a light polish."""
    name = name or "wood_%s" % hex_color.lstrip("#")
    existing = bpy.data.materials.get(name)
    if existing is not None:
        return existing
    mat, nt = _new_material(name)
    bsdf = _principled(nt)
    coord = _node(nt, "ShaderNodeTexCoord")
    stretch = _node(nt, "ShaderNodeMapping")
    stretch.inputs["Scale"].default_value = (9.0, 9.0, 0.7)
    nt.links.new(coord.outputs["Object"], stretch.inputs["Vector"])
    grain = _node(nt, "ShaderNodeTexNoise")
    grain.inputs["Scale"].default_value = 2.5
    grain.inputs["Detail"].default_value = 4.0
    nt.links.new(stretch.outputs["Vector"], grain.inputs["Vector"])
    fac = _map_range(nt, grain.outputs["Factor"], 0.3, 0.7)
    nt.links.new(_mix_colour(nt, fac, _rgba(hex_color), _rgba(hex_color, 0.8)), bsdf.inputs["Base Color"])
    _lathe_lines(nt, coord, bsdf, 0.1)
    _gloss(bsdf, 0.38, 0.45)
    return mat


def stripes(hex_a, hex_b, count, name=None):
    """Upright painted stripes around the object's z axis, `count` of each colour, under lacquer."""
    name = name or "stripes_%s_%s_%d" % (hex_a.lstrip("#"), hex_b.lstrip("#"), count)
    existing = bpy.data.materials.get(name)
    if existing is not None:
        return existing
    mat, nt = _new_material(name)
    bsdf = _principled(nt)
    coord = _node(nt, "ShaderNodeTexCoord")
    sep = _node(nt, "ShaderNodeSeparateXYZ")
    nt.links.new(coord.outputs["Object"], sep.inputs["Vector"])
    angle = _node(nt, "ShaderNodeMath", operation="ARCTAN2")
    nt.links.new(sep.outputs["Y"], angle.inputs[0])
    nt.links.new(sep.outputs["X"], angle.inputs[1])
    turns = _node(nt, "ShaderNodeMath", operation="MULTIPLY")
    nt.links.new(angle.outputs["Value"], turns.inputs[0])
    turns.inputs[1].default_value = count / 6.283185307
    part = _node(nt, "ShaderNodeMath", operation="FRACT")
    nt.links.new(turns.outputs["Value"], part.inputs[0])
    # A soft step two hundredths of a stripe wide, so the painted edge is crisp but not jagged.
    edge = _map_range(nt, part.outputs["Value"], 0.49, 0.51)
    nt.links.new(_mix_colour(nt, edge, _rgba(hex_a), _rgba(hex_b)), bsdf.inputs["Base Color"])
    _gloss(bsdf, 0.32, 0.8)
    return mat


def paper(hex_color, name=None):
    """Matte paper with a slight tooth. Also the backdrop the whole set stands on."""
    name = name or "paper_%s" % hex_color.lstrip("#")
    existing = bpy.data.materials.get(name)
    if existing is not None:
        return existing
    mat, nt = _new_material(name)
    bsdf = _principled(nt)
    bsdf.inputs["Base Color"].default_value = _rgba(hex_color)
    bsdf.inputs["Roughness"].default_value = 0.9
    bsdf.inputs["Specular IOR Level"].default_value = 0.1
    return mat


def letter_face(plain_path, lit_path, glow_path, width, height, lit, glow_strength, name):
    """The front of a letter, painted from pictures. `lit` runs from 0, the sealed sheet as it is,
    to 1, with lamplight coming through it and showing what is inside."""
    mat, nt = _new_material(name)
    bsdf = _principled(nt)
    coord = _node(nt, "ShaderNodeTexCoord")
    sep = _node(nt, "ShaderNodeSeparateXYZ")
    nt.links.new(coord.outputs["Object"], sep.inputs["Vector"])
    # The sheet stands in the object's x-z plane, centred, so x and z become the picture's u and v.
    uv = _node(nt, "ShaderNodeCombineXYZ")
    for src, slot, size in ((sep.outputs["X"], "X", width), (sep.outputs["Z"], "Y", height)):
        scale = _node(nt, "ShaderNodeMath", operation="MULTIPLY_ADD")
        nt.links.new(src, scale.inputs[0])
        scale.inputs[1].default_value = 1.0 / size
        scale.inputs[2].default_value = 0.5
        nt.links.new(scale.outputs["Value"], uv.inputs[slot])

    def picture(path, colour_space):
        img = _node(nt, "ShaderNodeTexImage", interpolation="Cubic", extension="EXTEND")
        img.image = bpy.data.images.load(path, check_existing=True)
        img.image.colorspace_settings.name = colour_space
        nt.links.new(uv.outputs["Vector"], img.inputs["Vector"])
        return img.outputs["Color"]

    plain = picture(plain_path, "sRGB")
    bsdf.inputs["Roughness"].default_value = 0.8
    bsdf.inputs["Specular IOR Level"].default_value = 0.15
    if lit <= 0.0 or not lit_path:
        nt.links.new(plain, bsdf.inputs["Base Color"])
        return mat
    nt.links.new(_mix_colour(nt, float(lit), plain, picture(lit_path, "sRGB")), bsdf.inputs["Base Color"])
    power = _node(nt, "ShaderNodeMath", operation="MULTIPLY")
    nt.links.new(picture(glow_path, "Non-Color"), power.inputs[0])
    power.inputs[1].default_value = glow_strength * lit
    bsdf.inputs["Emission Color"].default_value = _rgba(palette.GLOW)
    nt.links.new(power.outputs["Value"], bsdf.inputs["Emission Strength"])
    return mat


def thread(hex_color, name=None):
    """Cotton thread: dull, a little fuzzy, with fine fibres."""
    name = name or "thread_%s" % hex_color.lstrip("#")
    existing = bpy.data.materials.get(name)
    if existing is not None:
        return existing
    mat, nt = _new_material(name)
    bsdf = _principled(nt)
    coord = _node(nt, "ShaderNodeTexCoord")
    drift = _node(nt, "ShaderNodeTexNoise")
    drift.inputs["Scale"].default_value = 7.0
    nt.links.new(coord.outputs["Object"], drift.inputs["Vector"])
    fac = _map_range(nt, drift.outputs["Factor"], 0.3, 0.7)
    nt.links.new(_mix_colour(nt, fac, _rgba(hex_color), _rgba(hex_color, 0.86)), bsdf.inputs["Base Color"])
    fibre = _node(nt, "ShaderNodeTexNoise")
    fibre.inputs["Scale"].default_value = 140.0
    fibre.inputs["Detail"].default_value = 5.0
    nt.links.new(coord.outputs["Object"], fibre.inputs["Vector"])
    bump = _node(nt, "ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.6
    bump.inputs["Distance"].default_value = 0.008
    nt.links.new(fibre.outputs["Factor"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    bsdf.inputs["Roughness"].default_value = 0.8
    bsdf.inputs["Sheen Weight"].default_value = 0.7
    bsdf.inputs["Sheen Roughness"].default_value = 0.4
    bsdf.inputs["Specular IOR Level"].default_value = 0.25
    return mat


def brass(name="brass"):
    existing = bpy.data.materials.get(name)
    if existing is not None:
        return existing
    mat, nt = _new_material(name)
    bsdf = _principled(nt)
    bsdf.inputs["Base Color"].default_value = _rgba(palette.BRASS)
    bsdf.inputs["Metallic"].default_value = 1.0
    bsdf.inputs["Roughness"].default_value = 0.28
    return mat


def light(hex_color, strength, name):
    """Something that shines by itself: a flame, a lamp glass, gold seen through a window."""
    existing = bpy.data.materials.get(name)
    if existing is not None:
        return existing
    mat, nt = _new_material(name)
    out = _node(nt, "ShaderNodeOutputMaterial")
    emit = _node(nt, "ShaderNodeEmission")
    emit.inputs["Color"].default_value = _rgba(hex_color)
    emit.inputs["Strength"].default_value = strength
    nt.links.new(emit.outputs["Emission"], out.inputs["Surface"])
    return mat


def build_world(scene, strength):
    """Even, slightly warm light from every side, so shadows stay soft and nothing goes grey."""
    world = bpy.data.worlds.new("kaap_world")
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = _node(nt, "ShaderNodeOutputWorld")
    bg = _node(nt, "ShaderNodeBackground")
    bg.inputs["Color"].default_value = (1.0, 0.98, 0.95, 1.0)
    bg.inputs["Strength"].default_value = strength
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
    scene.world = world
    return world
