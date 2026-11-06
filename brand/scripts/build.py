"""Build the Highwire brand assets: SVG masters, PNG exports and favicon.ico.

Text is converted to outlines, so the SVGs render the same without the fonts installed.

    python build.py --fonts DIR [--chrome PATH]

DIR must hold SpaceGrotesk-VF.ttf and JetBrainsMono-VF.ttf (the variable fonts from
github.com/google/fonts, OFL). PNGs are rendered with headless Chrome. Needs Python with
fonttools, uharfbuzz and pillow.
"""
from __future__ import annotations

import argparse
import io
import subprocess
import tempfile
from functools import lru_cache
from pathlib import Path

import uharfbuzz as hb
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from PIL import Image

BRAND = Path(__file__).resolve().parent.parent
SVG = BRAND / "svg"
PNG = BRAND / "png"

# Colours. Keep in sync with tokens.json.
PAPER = "#F6F4EE"
INK = "#0E1116"
MUTED = "#4A4F57"
SIGNAL = "#93E2FB"
WIRE_STOPS = [(0, "#F7C84C"), (0.35, "#F6A9C4"), (0.7, "#93E2FB"), (1, "#A6EFCB")]
DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

FONTS: dict[str, Path] = {}


# ---------- text to outlines ----------

@lru_cache(maxsize=None)
def static_font(family: str, wght: int) -> tuple[TTFont, bytes]:
    vf = TTFont(FONTS[family])
    font = instantiateVariableFont(vf, {"wght": wght})
    buf = io.BytesIO()
    font.save(buf)
    data = buf.getvalue()
    return TTFont(io.BytesIO(data)), data


def text_outline(text: str, family: str, wght: int, size: float, tracking_em: float = 0.0):
    """Return (path d, advance width, (xmin, ymin, xmax, ymax)) with the baseline at y=0."""
    font, data = static_font(family, wght)
    upem = font["head"].unitsPerEm
    scale = size / upem
    hbfont = hb.Font(hb.Face(data))
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(hbfont, buf, {"kern": True, "liga": True})
    glyphset = font.getGlyphSet()
    order = font.getGlyphOrder()
    d_parts: list[str] = []
    x = 0.0
    xmin = ymin = float("inf")
    xmax = ymax = float("-inf")
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        name = order[info.codepoint]
        ox = x + pos.x_offset * scale
        oy = -pos.y_offset * scale
        pen = SVGPathPen(glyphset)
        glyphset[name].draw(TransformPen(pen, (scale, 0, 0, -scale, ox, oy)))
        d_parts.append(pen.getCommands())
        bp = BoundsPen(glyphset)
        glyphset[name].draw(bp)
        if bp.bounds:
            gx0, gy0, gx1, gy1 = bp.bounds
            xmin = min(xmin, ox + gx0 * scale)
            xmax = max(xmax, ox + gx1 * scale)
            ymin = min(ymin, oy - gy1 * scale)
            ymax = max(ymax, oy - gy0 * scale)
        x += pos.x_advance * scale + tracking_em * size
    x -= tracking_em * size
    return " ".join(p for p in d_parts if p), x, (xmin, ymin, xmax, ymax)


def text_el(text, family, wght, size, x, y, fill, tracking_em=0.0):
    d, _, _ = text_outline(text, family, wght, size, tracking_em)
    return f'<path transform="translate({x:.2f} {y:.2f})" fill="{fill}" d="{d}"/>'


# ---------- the mark ----------

def wire_gradient(gid: str, x1: float, x2: float) -> str:
    stops = "".join(f'<stop offset="{o}" stop-color="{c}"/>' for o, c in WIRE_STOPS)
    return f'<linearGradient id="{gid}" gradientUnits="userSpaceOnUse" x1="{x1}" y1="0" x2="{x2}" y2="0">{stops}</linearGradient>'


def h_glyph(gid: str, post: str = INK, node_fill: str = "#FFFFFF", node_stroke: str = INK,
            post_w: float = 11, wire_w: float = 6, node_r: float = 6.5, node_sw: float = 3) -> str:
    """The H in a 120-unit box: two posts with the wire sagging between them."""
    return (
        f"<defs>{wire_gradient(gid, 32, 88)}</defs>"
        f'<line x1="32" y1="24" x2="32" y2="96" stroke="{post}" stroke-width="{post_w}" stroke-linecap="round"/>'
        f'<line x1="88" y1="24" x2="88" y2="96" stroke="{post}" stroke-width="{post_w}" stroke-linecap="round"/>'
        f'<path d="M32 46 Q60 76 88 46" fill="none" stroke="url(#{gid})" stroke-width="{wire_w}" stroke-linecap="round"/>'
        f'<circle cx="60" cy="61" r="{node_r}" fill="{node_fill}" stroke="{node_stroke}" stroke-width="{node_sw}"/>'
    )


def avatar_glyph(gid: str, post: str, node_fill: str, node_stroke: str) -> str:
    """A slightly larger H for the circular profile-picture crop."""
    return (
        f"<defs>{wire_gradient(gid, 34, 86)}</defs>"
        f'<line x1="34" y1="28" x2="34" y2="92" stroke="{post}" stroke-width="12" stroke-linecap="round"/>'
        f'<line x1="86" y1="28" x2="86" y2="92" stroke="{post}" stroke-width="12" stroke-linecap="round"/>'
        f'<path d="M34 48 Q60 76 86 48" fill="none" stroke="url(#{gid})" stroke-width="7" stroke-linecap="round"/>'
        f'<circle cx="60" cy="62" r="7" fill="{node_fill}" stroke="{node_stroke}" stroke-width="3"/>'
    )


def favicon_glyph(post: str, wire: str, post_w=14, wire_w=10) -> str:
    """Small sizes: no gradient, no node, heavier strokes."""
    return (
        f'<line x1="34" y1="26" x2="34" y2="94" stroke="{post}" stroke-width="{post_w}" stroke-linecap="round"/>'
        f'<line x1="86" y1="26" x2="86" y2="94" stroke="{post}" stroke-width="{post_w}" stroke-linecap="round"/>'
        f'<path d="M34 48 Q60 78 86 48" fill="none" stroke="{wire}" stroke-width="{wire_w}" stroke-linecap="round"/>'
    )


def svg(w: float, h: float, body: str, label: str | None = None) -> str:
    a11y = f' role="img" aria-label="{label}"' if label else ' aria-hidden="true"'
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:g} {h:g}" width="{w:g}" height="{h:g}"{a11y}>{body}</svg>\n'


# ---------- assets ----------

def build_svgs() -> dict[str, str]:
    out: dict[str, str] = {}
    label = "Highwire"

    out["mark.svg"] = svg(120, 120, f'<rect x="1" y="1" width="118" height="118" rx="28" fill="{PAPER}" stroke="#D9D6CE" stroke-width="2"/>' + h_glyph("w"), label)
    out["mark-dark.svg"] = svg(120, 120, f'<rect width="120" height="120" rx="28" fill="{INK}"/>' + h_glyph("w", post="#FFFFFF", node_fill=INK, node_stroke="#FFFFFF"), label)
    out["mark-glyph.svg"] = svg(120, 120, h_glyph("w"), label)
    out["mark-glyph-white.svg"] = svg(120, 120, h_glyph("w", post="#FFFFFF", node_fill=INK, node_stroke="#FFFFFF"), label)
    out["favicon.svg"] = svg(120, 120, f'<rect width="120" height="120" rx="28" fill="{INK}"/>' + favicon_glyph("#FFFFFF", SIGNAL), label)

    out["x-avatar.svg"] = svg(400, 400, f'<rect width="400" height="400" fill="{PAPER}"/><g transform="scale({400/120})">{avatar_glyph("w", INK, "#FFFFFF", INK)}</g>', label)
    out["x-avatar-dark.svg"] = svg(400, 400, f'<rect width="400" height="400" fill="{INK}"/><g transform="scale({400/120})">{avatar_glyph("w", "#FFFFFF", INK, "#FFFFFF")}</g>', label)

    # Wordmark: Space Grotesk Bold, tracked -0.05em, trimmed to its ink bounds.
    size = 100
    d, _, (x0, y0, x1, y1) = text_outline("highwire", "grotesk", 700, size, -0.05)
    pad = 2
    ww, wh = x1 - x0 + 2 * pad, y1 - y0 + 2 * pad
    for name, fill in (("wordmark.svg", INK), ("wordmark-white.svg", "#FFFFFF")):
        out[name] = svg(round(ww, 2), round(wh, 2), f'<path transform="translate({pad - x0:.2f} {pad - y0:.2f})" fill="{fill}" d="{d}"/>', label)

    # Lockup: the glyph's posts run from the ascender top to the baseline, with heavier
    # strokes so the H matches the bold letters beside it.
    lock = {"post_w": 17, "wire_w": 9, "node_r": 8, "node_sw": 3.5}
    cap = lock["post_w"] / 2
    asc_top = -y0  # height of 'h' above the baseline
    post_len = 72 + lock["post_w"]  # glyph post length plus the round caps, in glyph units
    gscale = asc_top / post_len
    glyph_left = -(32 - cap) * gscale
    glyph_top = -(24 - cap) * gscale
    gap = 0.34 * asc_top
    text_x = (56 + lock["post_w"]) * gscale + gap
    lw = text_x + (x1 - x0) + 2 * pad
    lh = y1 - y0 + 2 * pad
    for name, post, nf, ns, fill in (
        ("lockup.svg", INK, "#FFFFFF", INK, INK),
        ("lockup-white.svg", "#FFFFFF", INK, "#FFFFFF", "#FFFFFF"),
    ):
        body = (
            f'<g transform="translate({glyph_left + pad:.2f} {glyph_top + pad:.2f}) scale({gscale:.4f})">{h_glyph("w", post, nf, ns, **lock)}</g>'
            f'<path transform="translate({text_x - x0 + pad:.2f} {asc_top + pad:.2f})" fill="{fill}" d="{d}"/>'
        )
        out[name] = svg(round(lw, 2), round(lh, 2), body, label)

    # X banner 1500x500. The profile picture covers the bottom-left (about x 40-390, y 330-500 on
    # phones) and some views trim the top and bottom edges, so the text sits high and the H's posts
    # stop short of the edges. Nothing here should change as the tool list grows.
    banner = (
        f'<defs>{wire_gradient("bw", 980, 1360)}</defs>'
        f'<rect width="1500" height="500" fill="{PAPER}"/>'
        f'<path d="M660 70 Q830 185 980 160" fill="none" stroke="{INK}" stroke-opacity=".18" stroke-width="2"/>'
        f'<path d="M1360 160 Q1440 176 1520 168" fill="none" stroke="{INK}" stroke-opacity=".18" stroke-width="2"/>'
        f'<line x1="980" y1="72" x2="980" y2="428" stroke="{INK}" stroke-width="26" stroke-linecap="round"/>'
        f'<line x1="1360" y1="72" x2="1360" y2="428" stroke="{INK}" stroke-width="26" stroke-linecap="round"/>'
        f'<path d="M980 160 Q1170 340 1360 160" fill="none" stroke="url(#bw)" stroke-width="11" stroke-linecap="round"/>'
        f'<circle cx="1170" cy="250" r="17" fill="#FFFFFF" stroke="{INK}" stroke-width="5"/>'
        + text_el("highwire", "grotesk", 700, 132, 104, 192, INK, -0.05)
        + text_el("The agent wire for higher.fun", "grotesk", 500, 34, 110, 254, MUTED)
        + text_el("highwire.fun", "mono", 500, 22, 111, 300, MUTED)
    )
    out["x-banner.svg"] = svg(1500, 500, banner, "Highwire, the agent wire for higher.fun")

    # Social preview 1200x630, on ink so it stands out in a timeline (light or dark). It says what Highwire does in
    # one line, at a size that still reads when X shows the card small. X lays the domain over the bottom-left, so
    # nothing sits below y 520 there.
    og = (
        f'<defs>{wire_gradient("ow", 860, 1100)}'
        f'<radialGradient id="og-glow"><stop offset="0" stop-color="#F7C84C" stop-opacity=".75"/>'
        f'<stop offset=".45" stop-color="#F6A9C4" stop-opacity=".35"/><stop offset="1" stop-color="{SIGNAL}" stop-opacity="0"/></radialGradient></defs>'
        f'<rect width="1200" height="630" fill="{INK}"/>'
        f'<line x1="860" y1="120" x2="860" y2="510" stroke="{PAPER}" stroke-width="26" stroke-linecap="round"/>'
        f'<line x1="1100" y1="120" x2="1100" y2="510" stroke="{PAPER}" stroke-width="26" stroke-linecap="round"/>'
        f'<path d="M860 220 Q980 400 1100 220" fill="none" stroke="url(#ow)" stroke-width="14" stroke-linecap="round"/>'
        f'<circle cx="980" cy="310" r="78" fill="url(#og-glow)"/>'
        f'<circle cx="980" cy="310" r="19" fill="#FFFFFF" stroke="{INK}" stroke-width="5"/>'
        + text_el("highwire", "grotesk", 700, 104, 78, 196, PAPER, -0.05)
        + text_el("Your agent can now trade,", "grotesk", 700, 50, 82, 296, PAPER, -0.02)
        + text_el("launch and claim", "grotesk", 700, 50, 82, 356, PAPER, -0.02)
        + text_el("on higher.fun.", "grotesk", 700, 50, 82, 416, PAPER, -0.02)
        + text_el("MCP server \u00b7 on npm and the MCP Registry", "mono", 500, 22, 84, 486, "#A7ACB4")
    )
    out["og.svg"] = svg(1200, 630, og, "Highwire, the agent wire for higher.fun")

    # The fees page's preview: one fee riding the node splits four ways, in the recipient colours the page uses
    # (apps/web/lib/fees.ts). The strands are all one weight, so it shows who gets paid, not how much.
    recipients = [("Creators", "#F6A9C4"), ("higher.fun", "#F7C84C"), ("Raydium", "#93E2FB"), ("The pool", "#A6EFCB")]
    src_x, src_y, end_x = 790, 330, 912
    strands = "".join(
        f'<path d="M{src_x} {src_y} C{src_x + 70} {src_y} {end_x - 70} {y} {end_x} {y}" fill="none" stroke="{c}" stroke-width="8" stroke-linecap="round"/>'
        f'<circle cx="{end_x}" cy="{y}" r="11" fill="{c}"/>'
        for (_, c), y in zip(recipients, (180, 280, 380, 480))
    )
    labels = "".join(
        text_el(name, "grotesk", 500, 34, end_x + 34, y + 12, PAPER, -0.01)
        for (name, _), y in zip(recipients, (180, 280, 380, 480))
    )
    fees = (
        f'<defs><radialGradient id="fg-glow"><stop offset="0" stop-color="#F7C84C" stop-opacity=".75"/>'
        f'<stop offset=".45" stop-color="#F6A9C4" stop-opacity=".35"/><stop offset="1" stop-color="{SIGNAL}" stop-opacity="0"/></radialGradient></defs>'
        f'<rect width="1200" height="630" fill="{INK}"/>'
        f'<line x1="{src_x}" y1="120" x2="{src_x}" y2="540" stroke="{PAPER}" stroke-width="26" stroke-linecap="round"/>'
        + strands
        + f'<circle cx="{src_x}" cy="{src_y}" r="78" fill="url(#fg-glow)"/>'
        f'<circle cx="{src_x}" cy="{src_y}" r="19" fill="#FFFFFF" stroke="{INK}" stroke-width="5"/>'
        + labels
        + text_el("highwire", "grotesk", 700, 56, 80, 132, PAPER, -0.05)
        + text_el("ECOSYSTEM FEES", "mono", 500, 22, 84, 200, SIGNAL, 0.08)
        + text_el("Every fee on", "grotesk", 700, 62, 80, 284, PAPER, -0.02)
        + text_el("higher.fun, and", "grotesk", 700, 62, 80, 356, PAPER, -0.02)
        + text_el("who got it.", "grotesk", 700, 62, 80, 428, PAPER, -0.02)
        + text_el("Read from Solana · every coin, every fee", "mono", 500, 22, 84, 494, "#A7ACB4")
    )
    out["og-fees.svg"] = svg(1200, 630, fees, "Highwire: every fee on higher.fun, and who got it")
    return out


# ---------- rendering ----------

def render_png(chrome: str, svg_path: Path, png_path: Path, w: int, h: int, transparent: bool = False) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        page = Path(tmp) / "page.html"
        page.write_text(
            f'<!doctype html><html><body style="margin:0;background:transparent">'
            f'<img src="{svg_path.as_uri()}" width="{w}" height="{h}" style="display:block"></body></html>'
        )
        args = [
            chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
            f"--user-data-dir={tmp}/profile", "--force-device-scale-factor=1",
            f"--window-size={w},{h}", f"--screenshot={png_path}", "--allow-file-access-from-files",
        ]
        if transparent:
            args.append("--default-background-color=00000000")
        subprocess.run(args + [page.as_uri()], check=True, capture_output=True, timeout=60)
    with Image.open(png_path) as im:
        if im.size != (w, h):
            im.crop((0, 0, w, h)).save(png_path)


def apple_icon_svg() -> str:
    # iOS masks the corners itself, so this one is full-bleed.
    return svg(180, 180, f'<rect width="180" height="180" fill="{INK}"/><g transform="translate(18 18) scale(1.2)">{favicon_glyph("#FFFFFF", SIGNAL)}</g>')


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fonts", required=True, type=Path)
    ap.add_argument("--chrome", default=DEFAULT_CHROME)
    a = ap.parse_args()
    FONTS["grotesk"] = a.fonts / "SpaceGrotesk-VF.ttf"
    FONTS["mono"] = a.fonts / "JetBrainsMono-VF.ttf"

    SVG.mkdir(parents=True, exist_ok=True)
    PNG.mkdir(parents=True, exist_ok=True)
    for name, text in build_svgs().items():
        (SVG / name).write_text(text)
    (SVG / "apple-touch-icon.svg").write_text(apple_icon_svg())

    jobs = [
        ("x-avatar.svg", "x-avatar-400.png", 400, 400, False),
        ("x-avatar-dark.svg", "x-avatar-dark-400.png", 400, 400, False),
        ("x-banner.svg", "x-banner-1500x500.png", 1500, 500, False),
        ("og.svg", "og-1200x630.png", 1200, 630, False),
        ("og-fees.svg", "og-fees-1200x630.png", 1200, 630, False),
        ("mark.svg", "mark-1024.png", 1024, 1024, True),
        ("mark-dark.svg", "mark-dark-1024.png", 1024, 1024, True),
        ("lockup.svg", "lockup-1600.png", 0, 0, True),
        ("favicon.svg", "icon-512.png", 512, 512, True),
        ("favicon.svg", "icon-192.png", 192, 192, True),
        ("apple-touch-icon.svg", "apple-touch-icon-180.png", 180, 180, False),
        ("favicon.svg", "favicon-48.png", 48, 48, True),
        ("favicon.svg", "favicon-32.png", 32, 32, True),
        ("favicon.svg", "favicon-16.png", 16, 16, True),
    ]
    for src, dst, w, h, transparent in jobs:
        if w == 0:  # lockup: keep its aspect ratio at 1600 wide
            vb = (SVG / src).read_text().split('viewBox="0 0 ')[1].split('"')[0].split()
            w, h = 1600, round(1600 * float(vb[1]) / float(vb[0]))
        render_png(a.chrome, SVG / src, PNG / dst, w, h, transparent)
        print(f"png/{dst} {w}x{h}")

    icons = [Image.open(PNG / f"favicon-{s}.png").convert("RGBA") for s in (16, 32, 48)]
    icons[2].save(BRAND / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)], append_images=icons[:2])
    print("favicon.ico 16/32/48")


if __name__ == "__main__":
    main()
