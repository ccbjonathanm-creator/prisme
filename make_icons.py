# -*- coding: utf-8 -*-
"""Génère les icônes de Prisme (prisme dégradé sur fond sombre)."""
from PIL import Image, ImageDraw
import math, os

OUT = os.path.join(os.path.dirname(__file__), "icons")
os.makedirs(OUT, exist_ok=True)

# Dégradé teal -> indigo -> rose (comme le logo SVG)
STOPS = [(0.0, (94, 234, 212)), (0.55, (129, 140, 248)), (1.0, (244, 114, 182))]

def grad(t):
    for i in range(len(STOPS) - 1):
        t0, c0 = STOPS[i]; t1, c1 = STOPS[i + 1]
        if t0 <= t <= t1:
            f = (t - t0) / (t1 - t0)
            return tuple(int(c0[k] + (c1[k] - c0[k]) * f) for k in range(3))
    return STOPS[-1][1]

def make(size, maskable=False):
    S = size * 4  # supersampling
    img = Image.new("RGBA", (S, S), (5, 9, 20, 255))
    d = ImageDraw.Draw(img)
    # léger halo
    for r in range(S, 0, -8):
        a = int(30 * (r / S))
        d.ellipse([S/2 - r/2, S/2 - r/2, S/2 + r/2, S/2 + r/2],
                  fill=(30, 40, 80, max(0, 40 - a)))
    inset = S * (0.22 if maskable else 0.16)
    top = (S/2, inset)
    left = (inset, S - inset)
    right = (S - inset, S - inset)
    # triangle dégradé, tracé ligne à ligne
    lw = int(S * 0.028)
    steps = 240
    def seg(p0, p1):
        for i in range(steps):
            t = i / (steps - 1)
            x = p0[0] + (p1[0] - p0[0]) * t
            y = p0[1] + (p1[1] - p0[1]) * t
            # position sur le pourtour pour le dégradé
            d.ellipse([x - lw/2, y - lw/2, x + lw/2, y + lw/2], fill=grad(t))
    seg(left, top); seg(top, right); seg(right, left)
    # rayon interne (la lumière qui se décompose)
    d.line([top, (S/2, S - inset)], fill=(255, 255, 255, 90), width=int(lw*0.5))
    img = img.resize((size, size), Image.LANCZOS)
    return img

make(192).save(os.path.join(OUT, "icon-192.png"))
make(512).save(os.path.join(OUT, "icon-512.png"))
make(512, maskable=True).save(os.path.join(OUT, "icon-maskable-512.png"))
make(64).save(os.path.join(OUT, "favicon-64.png"))
print("Icônes générées dans", OUT)
