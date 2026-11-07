# Highwire brand

**The H monogram:** two posts with a wire sagging between them, and one node riding it. It reads as an H for
Highwire, and as a tightrope an agent walks for you. The wire carries a gradient that nods to higher.fun's colours.
Everything else stays paper and ink.

Tagline: **The agent wire for higher.fun.**

## Files

| Use | File |
|---|---|
| Logo on light backgrounds | `svg/lockup.svg`, `png/lockup-1600.png` |
| Logo on dark backgrounds | `svg/lockup-white.svg` |
| Mark on its own | `svg/mark.svg` (paper tile), `svg/mark-dark.svg` (ink tile), `svg/mark-glyph.svg` / `svg/mark-glyph-white.svg` (no tile), `png/mark-1024.png`, `png/mark-dark-1024.png` |
| Wordmark only | `svg/wordmark.svg`, `svg/wordmark-white.svg` |
| X profile picture | `png/x-avatar-400.png` (paper), `png/x-avatar-dark-400.png` (ink) |
| X banner | `png/x-banner-1500x500.png` (on ink: the wire edge to edge, with a station for each thing an agent can do) |
| Link previews (Open Graph) | `png/og-1200x630.png` |
| The fees page's link preview | `png/og-fees-1200x630.png` |
| Site icons | `favicon.ico` (16/32/48), `svg/favicon.svg`, `png/icon-192.png`, `png/icon-512.png`, `png/apple-touch-icon-180.png` |
| Colour and type tokens | `tokens.json`, `tokens.css` |

All SVG text is converted to outlines, so the files look the same on machines without the fonts.

The site uses copies of the favicon, icons and link-preview images in `apps/web/app/` (the fees one in
`apps/web/app/fees/`). Copy them again after a rebuild. The ideas' cards are drawn by the site itself, in the fees
card's style, from each idea.json (`apps/web/lib/idea-card.tsx`, with static cuts of the two fonts in
`apps/web/assets/fonts/`).

## Colour

| Token | Hex | Use |
|---|---|---|
| Paper | `#F6F4EE` | Default background |
| Ink | `#0E1116` | Text, the posts, dark backgrounds |
| Muted | `#4A4F57` | Secondary text (7.5:1 on paper) |
| Line | `#D9D6CE` | Borders and dividers on paper |
| Surface dark | `#1A1D23` | Cards on ink |
| Signal | `#93E2FB` | The wire at small sizes, and accents on ink |
| Wire blue | `#3D8CDB` | The wire at small sizes on paper (3.2:1 on paper, so graphics only, never text) |
| Wire gradient | `#F7C84C → #F6A9C4 → #93E2FB → #A6EFCB` | The wire, and nothing else |

The gradient belongs to the wire. Don't use it for backgrounds, buttons or text.

## Type

- **Space Grotesk.** Bold for the wordmark and headings, tracked −0.05em at display sizes. Medium for subheads.
- **JetBrains Mono.** Medium, for tool names, commands and code.

Both fonts are on Google Fonts under the SIL Open Font License.

## Using the mark

- **Clear space:** keep at least the width of one post's gap clear on every side. That's half the mark's width.
- **Smallest sizes:** 24px for the full mark. Below that, use `favicon.svg`, which drops the gradient and the node.
- **Don't:**
  - recolour the posts
  - straighten the wire
  - add more nodes
  - put the mark on a busy photo
  - use higher.fun's bandage logo or pill art with it

## Regenerating

`scripts/build.py` writes every file above. It needs:
- Python with `fonttools`, `uharfbuzz` and `pillow`
- Google Chrome, for rendering the PNGs
- the two variable fonts (`SpaceGrotesk[wght].ttf` and `JetBrainsMono[wght].ttf`) from
  [google/fonts](https://github.com/google/fonts), saved as `SpaceGrotesk-VF.ttf` and `JetBrainsMono-VF.ttf`

```bash
python brand/scripts/build.py --fonts /path/to/fonts
```
