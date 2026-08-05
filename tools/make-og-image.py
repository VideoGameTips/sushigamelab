#!/usr/bin/env python3
"""Draw og-cover.png — the 1200x630 card that shows up when the site is shared.

Why a PNG and not the SVG we already have: Facebook, X, Slack, Discord and
WhatsApp all refuse SVG for og:image. Pointing og:image at logo.svg looks fine
in a browser and then silently produces a blank card everywhere it matters.

Re-run after changing the logo or the wording:  python3 tools/make-og-image.py
"""
from PIL import Image, ImageDraw, ImageFont
import pathlib

W, H = 1200, 630
BG      = (18, 16, 14)
GLOW    = (36, 29, 24)
FG      = (242, 236, 226)
DIM     = (162, 154, 140)
SALMON  = (255, 122, 89)
RICE    = (250, 245, 235)
NORI    = (34, 29, 25)

OUT = pathlib.Path(__file__).resolve().parent.parent / "og-cover.png"

# macOS system fonts. The Chinese line needs Arial Unicode — PingFang is not
# readable from this path, and Helvetica silently renders CJK as empty boxes
# rather than failing, so a missing font here looks like a working render.
def font(path, size, index=0):
    f = ImageFont.truetype(path, size, index=index)
    return f

F_TITLE = font("/System/Library/Fonts/Helvetica.ttc", 96, 1)   # bold face
F_ZH    = font("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", 34)
F_TAG   = font("/System/Library/Fonts/Helvetica.ttc", 32)
F_URL   = font("/System/Library/Fonts/Helvetica.ttc", 28, 1)

img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

# soft glow behind the mark, drawn as a few nested ellipses so there is no
# hard edge — a real radial gradient would need numpy for one decoration
for i in range(26, 0, -1):
    t = i / 26
    r = int(430 * t)
    c = tuple(int(BG[k] + (GLOW[k] - BG[k]) * (1 - t) ** 2) for k in range(3))
    d.ellipse([W // 2 - r, 150 - int(r * 0.75), W // 2 + r, 150 + int(r * 0.75)], fill=c)

# ── logo ────────────────────────────────────────────────────────────────────
cx, cy, S = W // 2, 158, 1.55          # S scales the 120-unit viewBox
def sx(v): return cx + (v - 60) * S
def sy(v): return cy + (v - 62) * S

# rice first, wide enough to read as the base the fish sits on
d.rounded_rectangle([sx(20), sy(55), sx(100), sy(96)], radius=int(19 * S), fill=RICE)
# salmon, overhanging the rice on both sides
d.rounded_rectangle([sx(14), sy(29), sx(106), sy(61)], radius=int(15 * S), fill=SALMON)
# the drape: circles along the lower edge so the slab reads as a soft fillet
for fx in (24, 44, 60, 76, 96):
    r = 7 * S
    d.ellipse([sx(fx) - r, sy(61) - r, sx(fx) + r, sy(61) + r], fill=SALMON)
d.line([sx(28), sy(39), sx(92), sy(39)], fill=(255, 201, 179), width=int(3.4 * S))
d.line([sx(32), sy(49), sx(88), sy(49)], fill=(255, 201, 179), width=int(2.6 * S))
d.rounded_rectangle([sx(52), sy(41), sx(69), sy(96)], radius=int(3.5 * S), fill=NORI)
d.polygon([(sx(57.5), sy(62)), (sx(67.5), sy(68.5)), (sx(57.5), sy(75))], fill=RICE)

# ── wordmark: "Sushi Game Lab" with Game in salmon ──────────────────────────
parts = [("Sushi ", FG), ("Game", SALMON), (" Lab", FG)]
total = sum(d.textlength(t, font=F_TITLE) for t, _ in parts)
x = (W - total) / 2
y = 300
for text, colour in parts:
    d.text((x, y), text, font=F_TITLE, fill=colour)
    x += d.textlength(text, font=F_TITLE)

def centred(text, fnt, y, fill):
    d.text(((W - d.textlength(text, font=fnt)) / 2, y), text, font=fnt, fill=fill)

centred("寿 司 游 戏 实 验 室", F_ZH, 420, DIM)
centred("9 free browser games, made by a kid", F_TAG, 486, FG)
centred("sushigamelab.com", F_URL, 548, SALMON)

img.save(OUT, "PNG", optimize=True)
print(f"{OUT}  {OUT.stat().st_size // 1024} KB  {img.size[0]}x{img.size[1]}")
