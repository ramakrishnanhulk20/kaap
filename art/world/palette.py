"""Colours for the Kaap toy world, as display hex strings, with a hex to linear helper."""

SEED = 11

# The backdrop is the page's own background, so the toys seem to stand on the page.
PAPER = "#F5EEDD"
LIME = "#FBF5E6"
KAAVI = "#B5472B"
WHITE = "#FFF8EC"
TURMERIC = "#F2AE0A"
VERMILION = "#DC3A26"
LEAF = "#1E8753"
LEAF_DARK = "#17693F"
INDIGO = "#2B4DA0"
ORANGE = "#EF7D1B"
PINK = "#E5628B"
TEAL = "#1F9C9A"
WOOD = "#E4BF8B"
WOOD_DARK = "#B98753"
SKIN = "#C98958"
SKIN_DEEP = "#A56A41"
BLACK = "#1E1A14"
BRASS = "#C9942E"
GLOW = "#FFC25A"
GOLD_GLOW = "#FFB52E"
INK = "#3A2414"


def hex_to_rgb(hex_str):
    h = hex_str.lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))


def _to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_to_linear(hex_str):
    """Scene linear RGB for a display hex colour, which is what Blender colour sockets want."""
    r, g, b = hex_to_rgb(hex_str)
    return (_to_linear(r), _to_linear(g), _to_linear(b))
