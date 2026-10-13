#!/usr/bin/env python3
"""Draws the monochrome toolbar spark at every size Safari asks for (extension/images/toolbar-N.png).

Safari tints the alpha channel gray, so the glyph is black strokes on transparent. The twelve
hairline spokes of the app icon blur into a blob below 40 px, so sizes use optical weights:
8 spokes with a heavier stroke at 24 px and under (1x displays), 12 spokes with a near-solid
centre at 32 px and up (what Retina Macs actually render for a 16-20 pt button).

    python3 scripts/make-toolbar-icons.py        # needs ImageMagick 7 (`magick`)
"""
import math
import subprocess
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "extension" / "images"
SIZES = [16, 18, 19, 20, 24, 32, 36, 38, 40, 48, 64, 96, 128]


def spark(path, size, spokes, stroke, r_in, r_out, min_stroke=2.0):
    c = size / 2
    w = max(min_stroke, size * stroke)
    draws = []
    for k in range(spokes):
        a = math.radians(90 + k * 360 / spokes)
        x1, y1 = c + size * r_in * math.cos(a), c - size * r_in * math.sin(a)
        x2, y2 = c + size * r_out * math.cos(a), c - size * r_out * math.sin(a)
        draws += ["-draw", f"stroke-linecap round line {x1:.3f},{y1:.3f} {x2:.3f},{y2:.3f}"]
    subprocess.run(
        ["magick", "-size", f"{size}x{size}", "xc:none", "-antialias", "-stroke", "black",
         "-strokewidth", f"{w:.3f}", "-fill", "none", *draws, str(path)],
        check=True,
    )


for s in SIZES:
    if s <= 24:
        spark(OUT / f"toolbar-{s}.png", s, spokes=8, stroke=0.10, r_in=0.10, r_out=0.45)
    else:
        spark(OUT / f"toolbar-{s}.png", s, spokes=12, stroke=0.085, r_in=0.06, r_out=0.46)
    print(f"toolbar-{s}.png")
