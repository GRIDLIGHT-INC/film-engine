# DRIVE-IN PICTURES — logo type specification

Everything below was measured off the generated reference art (per-glyph ink
widths, per-glyph advances, cap heights, rule position, colour ramps) and then
fitted with real font outlines. `drive-in-pictures.svg` is the result; it has
the outlines baked in, so it needs no fonts installed to open or render.

All measurements are expressed as multiples of **H**, the DRIVE-IN cap height.
At 1920x1080 the delivered lockup uses H = 343 px.

## Fonts

| Element  | Face                     | Source                      |
|----------|--------------------------|-----------------------------|
| DRIVE-IN | Bebas Neue Regular (400) | npm `@fontsource/bebas-neue` |
| PICTURES | Montserrat Light (300)   | npm `@fontsource/montserrat` |

Neither is an exact match — the reference was drawn, not typeset. Bebas is the
right skeleton but roughly 35% too wide and slightly too light for it; the
numbers below are the correction.

## DRIVE-IN

- Cap height: **H**
- Horizontal scale: **65%** of natural width
- Tracking: **+368** (units of 1/1000 em, applied before the compression)
- Per-glyph overrides — Bebas differs from the reference on two characters:
  - `E`  horizontal scale **55%**
  - `-`  horizontal scale **45%**, tracking **+180** on both sides
- Weight: add a centre-aligned stroke of **0.024 H** (8.4 px at H = 343) in
  `#E8F0FA` at 92% — the reference stems are heavier than compressed Bebas
- Fill: vertical gradient, top to baseline
  `#F4F8FC` 0% → `#EAEFF4` 18% → `#DDE7F1` 62% → `#D0DCEC` 100%
- Shadow: offset 0.010 H right, 0.014 H down, blur 0.007 H, `#050A14` at 55%
- Glow: two blurs (0.018 H and 0.075 H) in `#8FC4FF` at 13% total
- Resulting lockup width: **4.40 H**

## Rule

- Centre line: **0.110 H** below the DRIVE-IN baseline
- Thickness: **0.014 H**
- Width: full DRIVE-IN width, symmetric
- Gradient across: transparent → `#78B4FF` 35% at 12% → `#D2EBFF` at 42% →
  `#FFFFFF` at 50%, mirrored
- Centre bloom: ellipse rx = 16% of lockup width, ry = 0.055 H,
  white 85% → `#96CDFF` 45% → transparent

## PICTURES

- Cap height: **0.146 H**
- Baseline: **0.372 H** below the DRIVE-IN baseline
- Horizontal scale: 100% (natural Montserrat width)
- Tracking: **+1860** (units of 1/1000 em)
- Colour: `#5AA0F5`, with a 0.16-cap blur glow at 30%

## Rebuilding

```
python3 build_svg.py     # emits drive-in-pictures.svg from the font outlines
python3 build_anim.py    # wraps it in the seekable 6s build-on
```

`drive-in-ident-logo.html` is that build-on, driven by a single `render(t)`
function — click to pause, hover for a scrub bar, and `window.setTime(t)`
seeks it frame-accurately for exporting stills or a frame sequence.
