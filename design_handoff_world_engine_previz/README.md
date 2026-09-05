# Handoff: World Engine — Previz / Shot Design Console

## Overview

A full redesign of the Previz screen in Film Engine. The old screen was an empty 3D stage with an XYZ control panel. The redesign turns it into a **shot design console for directors**: a persistent, reconstructed 3D world (Marble / Gaussian splat) that many shots are framed inside, with the camera frame as the hero of the screen and every control answering one question — *how does this change the shot I'm seeing?*

Core concepts introduced by this design:

- **World is separated from Shot.** Hierarchy is `Project → Sequence → World/Set → Shots`. One generated world (`Maple Street`, `WLD-031`, `v3`) serves six shots (2A–3B). The world reconstructs environment only — characters and props stay independent assets.
- **Worlds are versioned and pinned.** `v1…v4`; each shot pins a version. Worlds are never overwritten.
- **The camera view is the hero.** Everything else supports it.
- **Creative intention maps to cinematographic consequence.** Directors pick intentions ("More heroic"); the tool responds with camera changes (lens, height, tilt, subject occupancy), not a new image.
- **Coverage exploration.** Six intentional cameras generated from one world + one blocking setup, comparable side by side.
- **The rendered frame is a geometric plate**, deliberately ugly, that feeds a downstream image/video generator along with character references.

## About the Design Files

The files in this bundle are **design references created in HTML** — prototypes that show intended look and behavior. They are **not production code to copy directly**.

They are authored in a streaming component format (`.dc.html`: an HTML template plus a small logic class, driven by the bundled `support.js` runtime). Do not port that runtime. The task is to **recreate these designs in the target codebase's existing environment** (React, Vue, SwiftUI, etc.) using its established component library, styling approach, and state patterns. If no environment exists yet, choose the framework most appropriate for the project and implement there.

Open `World Engine Previz v2.dc.html` in a browser to interact with the prototype (click shots, lenses, coverage tiles, overlays, Compare, Match Reference, New World). `support.js` must sit beside it.

## Fidelity

**High-fidelity.** Colors, typography, spacing, borders, and interaction states are final and should be recreated closely. Two caveats:

1. **The 3D viewports are placeholders.** The camera view is a striped placeholder frame with composition overlays drawn over it; the Spatial World panel is a hand-built SVG diagram (grid, striped building blocks, camera frustum, proxy volumes). In the real product these are live renderers — the camera view renders the world through the virtual camera, and the spatial world is a Gaussian-splat viewport (World Labs' Spark / three.js is the intended path for a web app). Treat the placeholders as **layout, chrome, and overlay specs**, not as art to reproduce.
2. **All numeric data is demo data** (Maple Street, Maya, Dragon, Sedan, lens/height/tilt/occupancy values). Wire to real state.

---

## Screens / Views

There is one screen (`World Engine Previz v2.dc.html`) plus two modals. `World Engine Previz.dc.html` is an earlier iteration included only for reference — **build from v2**.

### Screen: Previz / Shot Design Console

**Purpose:** the director frames a shot inside a persistent 3D world, explores alternative cameras, records a camera move, and renders a geometric plate that seeds image/video generation.

**Canvas:** designed at **1920px wide**, `padding: 24px 26px 34px`. Background `#050505`. Total height ~1560px; the page scrolls. Below ~1600px the three columns should stack the right column beneath the center column (not designed — use judgment).

**Overall layout (top to bottom):**

1. Header bar (full width), `padding-bottom: 16px`, `border-bottom: 1px solid rgba(255,255,255,0.09)`
2. Main row — `display: flex; gap: 14px; align-items: flex-start`:
   - Left rail: `width: 206px` (fixed)
   - Center column: `flex: 1.62`
   - Right column: `width: 452px` (fixed)
3. Secondary strip (full width): three equal quiet panels, `gap: 12px`
4. Advanced strip (full width): collapsed disclosure chips

**Center column contents, in order** (`gap: 12px`): Camera View panel → Direct the Shot → Explore Shot → Camera Movement.

**Right column contents, in order** (`gap: 12px`): Spatial World → Lens → Camera Operate → Blocking.

---

### Header bar

Left group, `display: flex; align-items: baseline; gap: 18px`:
- `MAPLE STREET` — 30px, weight 300, `letter-spacing: 0.2em`, `#ecece9`, `line-height: 1`
- `WLD-031 · v3 · SEQ 02 / DRAGON ATTACK` — mono 11.5px, `letter-spacing: 0.14em`, `#8f8f8a`
- `WORLD LOCKED` chip — mono 10.5px, `letter-spacing: 0.14em`, `padding: 6px 11px`, `border: 1px solid rgba(95,211,196,0.45)`, `radius: 5px`, color `#5fd3c4`

Right group, `gap: 9px`: `NEW WORLD` and `EXPORT` buttons (mono 11px, `letter-spacing: 0.14em`, `padding: 10px 15px`, `border: 1px solid rgba(255,255,255,0.16)`, `radius: 5px`, `#c9c9c4`; hover → border `rgba(255,255,255,0.4)`, text `#fff`), then a 36×36 `×` close button, same border, `#9a9a95`.

`NEW WORLD` opens the **Create Spatial World** modal. `EXPORT` is not wired in the prototype; intended targets are Blender, Unreal, three.js, Gaussian splat, mesh, camera data.

---

### Left rail — Shots (206px)

Panel: `border: 1px solid rgba(255,255,255,0.08)`, `radius: 8px`, `background: #0a0a0a`, `padding: 14px 14px 16px`.

- Label `SHOTS · SEQ 02` — mono 10px, `letter-spacing: 0.2em`, `#8f8f8a`, `margin-bottom: 12px`
- Six rows, `gap: 4px`, each `display: flex; align-items: center; gap: 10px; padding: 9px 11px; radius: 5px`:
  - id (mono 12px, `letter-spacing: 0.1em`) + name (12px, `#8f8f8a`)
  - inactive: `border: 1px solid transparent; background: #0d0d0d; color: #c9c9c4`
  - active: `border: 1px solid rgba(95,211,196,0.5); background: rgba(95,211,196,0.09); color: #5fd3c4`
- Data: `2A Down street`, `2B Reverse` (active), `2C Maya CU`, `2D Dragon side`, `3A Wing beat`, `3B Car crush`
- Footer, above `border-top: 1px solid rgba(255,255,255,0.07)`, `margin-top: 14px; padding-top: 12px`: mono 10px, `letter-spacing: 0.1em`, `#7a7a74`, `line-height: 1.8` — `6 SHOTS · ONE WORLD` / `SPLAT 2.41M`

Clicking a shot sets the active shot (header of the camera view updates). In production it should also load that shot's saved camera, world pin, and move.

---

### Camera View (hero panel)

Panel: `border: 1px solid rgba(255,255,255,0.12)` (the brightest border on the page — deliberate), `radius: 8px`, `background: #070707`.

**Header row** — `padding: 14px 16px`, `border-bottom: 1px solid rgba(255,255,255,0.08)`:
- Left: `CAMERA VIEW` (mono 12px, `letter-spacing: 0.2em`, `#ecece9`) + `SHOT 2B · 18mm · HEROIC LOW` (mono 11.5px, `letter-spacing: 0.14em`, `#5fd3c4`) — the second string is live: shot id, current lens, current setup name.
- Right: `OVERLAYS · <count> ▾` button, then a REC indicator (6px dot `#e0ac52` + `REC` mono 10.5px `letter-spacing: 0.16em` `#e0ac52`).
  - Overlays button: mono 10.5px, `letter-spacing: 0.14em`, `padding: 8px 12px`, `radius: 5px`; closed `border: 1px solid rgba(255,255,255,0.18); color: #c9c9c4`; open `border: 1px solid #5fd3c4; color: #5fd3c4; background: rgba(95,211,196,0.12)`.

**Overlay menu** (popover, opens under the button): `position: absolute; right: 0; top: 36px; width: 238px; z-index: 20`, `border: 1px solid rgba(255,255,255,0.16)`, `radius: 7px`, `background: #0d0d0d`, `box-shadow: 0 18px 40px rgba(0,0,0,0.7)`, `padding: 10px`. Title `COMPOSITION OVERLAYS` mono 9.5px `letter-spacing: 0.18em` `#8f8f8a`. Eleven toggle rows (`padding: 7px 6px; gap: 10px; radius: 4px`), each a 14×14 checkbox (`radius: 3px`; off `border: 1px solid rgba(255,255,255,0.2)`; on `border: 1px solid #5fd3c4; color: #5fd3c4; background: rgba(95,211,196,0.12)`, `✓` at 10px) + 12px label. Label color `#c9c9c4` off, `#5fd3c4` on.

Overlays and how each draws inside the frame:

| Overlay | Default | Rendering |
|---|---|---|
| Thirds | **on** | 1px lines at 33.33%/66.66% both axes, `rgba(255,255,255,0.11)` |
| Center | off | 26px circle centered, `border: 1px solid rgba(255,255,255,0.28)` |
| Horizon | **on** | 1px line at `top: 46%`, `rgba(224,172,82,0.6)`, right-aligned label `HORIZON · TILT +17°` (mono 9.5px, `#e0ac52`) |
| Vanishing points | off | 9px ring at (38%, 46%) + three 1px rays at 21°, −14°, 174°, `rgba(224,172,82,0.18–0.24)` |
| Eyelines | off | dashed line at `top: 33%`, inset 6%, `rgba(95,211,196,0.4–0.5)`, label `EYELINE · MAYA / DRAGON` |
| 180° line | off | dashed line at `bottom: 12%`, inset 8%, `rgba(255,255,255,0.35)`, label `180° LINE · CAMERA LEFT SIDE` |
| Headroom | off | top band `height: 11%`, `background: rgba(255,255,255,0.04)`, bottom border `rgba(255,255,255,0.2)`, label `HEADROOM 11%` |
| Lead room | off | right band `width: 22%`, `background: rgba(255,255,255,0.035)`, left border `rgba(255,255,255,0.2)`, label `LEAD ROOM` |
| Silhouette | off | full-frame scrim `rgba(4,4,4,0.55)` (production: render subjects as flat black on white) |
| Grayscale / value | off | `linear-gradient(180deg, rgba(255,255,255,0.05), rgba(0,0,0,0.35))` with `mix-blend-mode: screen` (production: desaturate + posterize the render) |
| FG / MG / BG | off | three stacked bands from bottom — 34% `rgba(95,211,196,0.05)`, 26% `rgba(95,211,196,0.03)`, remainder untinted; top borders `rgba(95,211,196,0.3 / 0.18)`; labels `FG` `MG` `BG` mono 9.5px in descending teal tints |

**Preview sub-toolbar** — `padding: 11px 16px`, `background: #090909`, `border-bottom: 1px solid rgba(255,255,255,0.06)`:
- Left: label `PREVIEW` (mono 10.5px, `letter-spacing: 0.18em`, `#8f8f8a`) + four chips (`GEOMETRY`, `FLAT SHADED`, `REFERENCE PROJECTED`, `FINAL PREVIEW`) at mono 10.5px, `padding: 7px 10px`
- Right: `MATCH REFERENCE` button — mono 11.5px, `letter-spacing: 0.14em`, `padding: 9px 15px`, `border: 1px solid rgba(224,172,82,0.55)`, `radius: 5px`, `#e0ac52`; hover `background: rgba(224,172,82,0.13)`. Opens the Match Reference drawer.

**Frame** — inside `padding: 16px`:
`position: relative; width: 100%; aspect-ratio: 2.39` (configurable: 2.39:1 default, 1.85:1, 16:9, 4:3), `overflow: hidden`, `border: 1px solid rgba(255,255,255,0.14)`, `radius: 3px`, `background-color: #0c0c0c`, `background-image: repeating-linear-gradient(45deg, rgba(255,255,255,0.028) 0 6px, transparent 6px 12px)`. In production this is the live render; the stripe fill is the placeholder.

Always-on frame furniture:
- **Subject occupancy box** — `position: absolute; left: 8%; bottom: 14%`, `width: <occ>%`, `height: min(66, occ × 0.95)%`, `border: 1px solid rgba(95,211,196,0.65)`, `radius: 2px`; label above it at `top: -20px`: `DRAGON · <occ>% OF FRAME` (mono 10.5px, `letter-spacing: 0.12em`, `#5fd3c4`)
- **Maya marker** — `right: 13%; top: 26%; width: 24px; height: 82px`, `border: 1px solid rgba(224,172,82,0.6)`, `radius: 12px`; label to its left `MAYA · 25.7m` (mono 10.5px, `#e0ac52`)
- Bottom-left readout: `18mm · SUPER 35 · h 0.42m · TILT +17°` (mono 11px, `letter-spacing: 0.14em`, `#b5b5b0`) — live lens/height/tilt
- Bottom-right: `GEOMETRIC PLATE — NOT FINAL` (mono 10.5px, `#7a7a74`). **Keep this string.** It tells the user the frame is framing truth, not beauty.

**Action bar** — `padding: 0 16px 16px; gap: 10px`:
- `RENDER GENERATION PLATE` — `flex: 1`, mono 12.5px, `letter-spacing: 0.18em`, weight 500, `padding: 16px`, `background: #5fd3c4`, `color: #062a26`, `border: 1px solid #5fd3c4`, `radius: 6px`; hover `#7fdfd2`. **The only solid-filled button on the screen** — it is the terminal action of the screen.
- `SAVE CAMERA TO SHOT` and `APPROVE` — mono 11px, `letter-spacing: 0.14em`, `padding: 16px 20px`, `border: 1px solid rgba(255,255,255,0.18)`, `#c9c9c4`; hover border `rgba(255,255,255,0.45)`, text `#fff`

---

### Direct the Shot

Panel: `border: 1px solid rgba(255,255,255,0.08)`, `radius: 8px`, `background: #0a0a0a`, `padding: 15px 16px 17px`.

Header row: `DIRECT THE SHOT` (mono 11px, `letter-spacing: 0.2em`, `#ecece9`) and, right-aligned, `CHANGES THE CAMERA, NOT THE IMAGE` (mono 10px, `letter-spacing: 0.14em`, `#8f8f8a`).

Body: `display: flex; gap: 14px`.

**Left (`flex: 1.15`):**
- Intention preset chips, wrapping, `gap: 6px` — sans 12px, `letter-spacing: 0.04em`, `padding: 10px 13px`, `radius: 4px`; inactive `border: 1px solid rgba(255,255,255,0.13); color: #a5a5a0`; active `border: 1px solid #5fd3c4; color: #5fd3c4; background: rgba(95,211,196,0.12)`. Presets: `More heroic`, `More vulnerable`, `More oppressive`, `More intimate`, `More chaotic`, `More isolated`, `More cinematic depth`.
- Custom direction text input — full width, `background: #0e0e0e`, `border: 1px solid rgba(255,255,255,0.12)`, `radius: 6px`, `padding: 12px 13px`, 13px, `color: #ecece9`, no outline. Placeholder: `Custom direction — e.g. hold the dragon in the near foreground and let Maya read small`

**Right (`flex: 1`, `border-left: 1px solid rgba(255,255,255,0.08)`, `padding-left: 16px`):**
- Title `<INTENT> — PROPOSED CAMERA` (mono 10px, `letter-spacing: 0.18em`, `#5fd3c4`)
- Two-column grid of deltas, `gap: 8px 20px`, mono 11px: key `#8f8f8a`, value `#5fd3c4`
- Footer buttons: `APPLY CAMERA CHANGE` (`flex: 1`, mono 11.5px, `border: 1px solid rgba(95,211,196,0.55)`, `#5fd3c4`, hover `background: rgba(95,211,196,0.14)`) and `VARIANTS` (`border: 1px solid rgba(255,255,255,0.16)`, `#b5b5b0`)

Delta payload per intent (**demo data** — in production these come from the agent, computed against the world and the blocking):

| Intent | Applies | Shown deltas |
|---|---|---|
| More heroic | 21mm, h 0.42m, tilt +17° | LENS 35→21mm · HEIGHT 1.50→0.42m · TILT +17° · SUBJECT OCC 31→58% · MAYA upper third · RIG dolly, low mode |
| More vulnerable | 24mm, h 1.95m, tilt −14° | LENS 35→24mm · HEIGHT 1.50→1.95m · TILT −14° · SUBJECT OCC 31→19% · MAYA lower third · HEADROOM +9% |
| More oppressive | 14mm, h 0.30m, tilt +31° | LENS 35→14mm · HEIGHT 1.50→0.30m · TILT +31° · DISTORTION extreme · DRAGON OCC 31→71% · SKY occluded |
| More intimate | 85mm, h 1.62m, tilt −2° | LENS 35→85mm · HEIGHT 1.50→1.62m · DISTANCE +6.2m · FOCUS 4.1m · APERTURE f1.8 · BG compressed |
| More chaotic | 28mm, h 1.28m, tilt +9° | LENS 35→28mm · ROLL −12° · RIG handheld · MOVE whip 34°/s · HORIZON unstable · SHUTTER 1/48 |
| More isolated | 40mm, h 1.55m, tilt 0° | LENS 35→40mm · DISTANCE +14.0m · MAYA OCC 31→7% · FRAME POS far left · NEG SPACE 78% · MOVE static |
| More cinematic depth | 21mm, h 0.85m, tilt +6° | LENS 35→21mm · HEIGHT 1.50→0.85m · FG ELEMENT sedan hood · LAYERS 3→5 · FOCUS 11.4m · APERTURE f2.8 |

`APPLY CAMERA CHANGE` writes lens/height/tilt to the camera, sets the setup name to the intent (e.g. `HEROIC`), clears the coverage selection, and resets framing mode to Keep Position.

---

### Explore Shot

Panel: same shell as above.

Header: `EXPLORE SHOT — SIX CAMERAS, ONE WORLD` (mono 11px, `letter-spacing: 0.2em`, `#ecece9`); right side has `COMPARE` then `✦ EXPLORE AGAIN` (mono 11.5px, `padding: 9px 13px`, `border: 1px solid rgba(95,211,196,0.5)`, `#5fd3c4`, hover `background: rgba(95,211,196,0.14)`).

**Tiles:** `display: grid; grid-template-columns: repeat(6, 1fr); gap: 9px`. Each tile `radius: 7px`, `background: #0b0b0b`, `overflow: hidden`, `border: 1px solid rgba(255,255,255,0.08)`; selected `rgba(95,211,196,0.6)` + `box-shadow: 0 0 0 1px rgba(95,211,196,0.25)`.
- Thumb: `height: 92px`, striped placeholder (`#0d0d0d` + 45° stripes at `rgba(255,255,255,0.03)`), `border-bottom: 1px solid rgba(255,255,255,0.08)`. Letter badge top-left (mono 11px, `letter-spacing: 0.16em`, `#5fd3c4`). A **mini framing rectangle** (`border: 1px solid rgba(95,211,196,0.5)`, `radius: 2px`) positioned per option to hint the composition — in production this is a real thumbnail render.
- Body `padding: 10px 11px 12px`: name (13px), storytelling intent (12px, `#8f8f8a`), spec (mono 11px, `letter-spacing: 0.08em`, `#a5a5a0`)

| Key | Name | Intent line | Lens | Height | Tilt | Dragon occ | Maya dist | Mini-frame hint |
|---|---|---|---|---|---|---|---|---|
| A | Neutral Wide | Orientation / geography | 24mm | 1.55m | 0° | 34% | 25.7m | `left:14%; bottom:16%; w:30%; h:44%` |
| B | Heroic Low | Power / dominance | 18mm | 0.42m | +17° | 58% | 25.7m | `left:10%; bottom:12%; w:56%; h:62%` |
| C | Long Lens Compression | Claustrophobic / observational | 135mm | 1.60m | −2° | 82% | 41.2m | `left:22%; bottom:18%; w:62%; h:58%` |
| D | Extreme Foreground | Scale / threat | 21mm | 0.85m | +6° | 71% | 29.1m | `left:0; bottom:0; w:44%; h:80%` |
| E | Over the Shoulder | Alignment / complicity | 50mm | 1.72m | −5° | 46% | 2.1m | `left:44%; bottom:8%; w:46%; h:70%` |
| F | Dutch / Unstable | Disorientation / panic | 28mm | 1.28m | +9° | 52% | 18.4m | `left:18%; bottom:14%; w:48%; h:52%; rotate(-11deg)` |

**Normal mode:** clicking a tile loads that camera into the same world (lens, height, tilt, setup name) — the camera view header, frame readout, occupancy box, and Camera Operate sliders all update. It does **not** navigate away.

**Compare mode:** `COMPARE` toggles it (button turns amber: `border: 1px solid #e0ac52; color: #e0ac52; background: rgba(224,172,82,0.12)`; label becomes `COMPARING n/2`). Tile clicks then select rather than load, max two, FIFO past two. First pick gets a teal border (`rgba(95,211,196,0.75)`), second amber (`rgba(224,172,82,0.75)`). With fewer than two picked, show `Pick two cameras to compare.` (12.5px, `#8f8f8a`). With two picked, render a comparison grid above `border-top: 1px solid rgba(255,255,255,0.08)`:

`grid-template-columns: 1.4fr 1fr 1fr; gap: 9px 18px`. Column headers are the two camera names (mono 11.5px, `letter-spacing: 0.14em`) in teal and amber respectively. Rows: Lens, Camera height, Tilt, Dragon occupancy, Maya distance — labels 12.5px `#8f8f8a`, values mono 12px `#ecece9`.

---

### Camera Movement (timeline)

Panel: same shell, `padding: 15px 16px 18px`.

Header: `CAMERA MOVEMENT — 4.0s` + three buttons `▶ PLAY MOVE`, `+ KEY`, `+ LEG` (mono 10.5px, `padding: 8px 13px`, `border: 1px solid rgba(255,255,255,0.16)`, `#c9c9c4`).

Time ruler: `0.0s 1.0s 2.0s 3.0s 4.0s`, `justify-content: space-between`, `padding-left: 96px` (aligns with lane start), mono 10px, `#7a7a74`.

Two lanes, `gap: 8px`, each row `display: flex; gap: 12px`:
- Lane label — mono 10.5px, `letter-spacing: 0.12em`, `#b5b5b0`, `width: 84px`, `padding-top: 16px`
- Lane track — `flex: 1; height: 48px`, `border: 1px solid rgba(255,255,255,0.07)`, `radius: 5px`, `background: #0d0d0d`

**POSITION lane:** clip from 0 to 65% — `background: rgba(95,211,196,0.1)`, `border-right: 1px solid rgba(95,211,196,0.5)`, `padding: 9px 12px`; title `DOLLY BACK 2.4m` (mono 11px, `#5fd3c4`), sub `EASE OUT · 0.0 – 2.6s` (mono 10px, `#7a7a74`). Remainder labelled `HOLD` (mono 11px, `#8f8f8a`). Keyframe diamonds (9×9, `rotate(45deg)`, `#5fd3c4`, `top: -5px`) at 0% and 65%.

**ROTATION lane:** clip from 40% to end — `background: rgba(224,172,82,0.09)`, `border-left: 1px solid rgba(224,172,82,0.5)`; title `TILT +13° · ROLL −4°` (`#e0ac52`), sub `LINEAR · 1.6 – 4.0s`. Amber diamonds at 40% and 100%.

**Playhead:** 1px `#ecece9` vertical line at 38% spanning both lanes, with `1.52s` label (mono 10.5px, `#ecece9`) beneath.

**Ease row:** label `EASE` (mono 10.5px, `#8f8f8a`, `width: 84px`) + chips `LINEAR`, `EASE IN`, `EASE OUT` (default), `EASE BOTH`, `HANDHELD` (mono 10.5px, `padding: 7px 11px`). Deliberately five presets, not bezier handles.

---

### Spatial World (right column)

Panel: `border: 1px solid rgba(255,255,255,0.09)`, `radius: 8px`, `background: #080808`, `overflow: hidden`.

Header `padding: 13px 14px`, `border-bottom: 1px solid rgba(255,255,255,0.07)`: `SPATIAL WORLD` (mono 10.5px, `letter-spacing: 0.2em`, `#ecece9`) + view chips `PERSP` (active, teal border) / `TOP` / `SIDE` (mono 9.5px, `padding: 5px 8px`).

Viewport: `height: 284px`. In the prototype an SVG diagram (`viewBox 0 0 452 284`): sky `#080a0d` above `y=104`, ground `#070707` below, horizon line `rgba(255,255,255,0.16)`, perspective grid in `rgba(95,211,196,0.09–0.11)`, six striped building blocks (`border rgba(255,255,255,0.1)`, diagonal stripe patterns on `#0b0b0b`/`#0d0d0d`), amber dots for practicals, and labelled assets:
- `SEDAN` — striped rounded rect (card representation)
- `MAYA` — capsule + head circle, teal outline, labels `MAYA` / `25.7m`
- `DRAGON` — rounded rect body with two wing triangles, labels `DRAGON` / `4.1m · span 11.2m`
- `CAM 2B · h 0.42m` — teal dot + frustum triangle (`fill rgba(95,211,196,0.07)`, `stroke rgba(95,211,196,0.65)`)
- Amber dashed curve from the camera to a dot: the recorded move path

Footer hint, bottom-left: `DRAG ORBIT · SHIFT-DRAG AIM · SCROLL FLY` (mono 9.5px, `#75756e`).

**In production:** replace the SVG with the splat viewport. Keep the size (a supporting panel, not a competitor to the camera frame), the view chips, the asset labels with real distances, the frustum, and the move path.

---

### Lens (right column)

Header row: `LENS` (mono 11px, `letter-spacing: 0.2em`, `#ecece9`) + current value `18mm` (mono 11px, `#5fd3c4`).

Lens buttons, wrapping, `gap: 5px`: `12 14 18 21 24 28 35 40 50 65 85 135` mm. Each mono 12.5px, `letter-spacing: 0.12em`, `padding: 11px 8px`, `min-width: 58px`, `radius: 4px`, centered; inactive `border: 1px solid rgba(255,255,255,0.13); color: #a5a5a0`; active `border: 1px solid #5fd3c4; color: #5fd3c4; background: rgba(95,211,196,0.12)`.

**ON LENS CHANGE** section, above `border-top: 1px solid rgba(255,255,255,0.07)`:
- Two chips, `flex: 1` each: `KEEP POSITION` (default) and `MAINTAIN SIZE`
- Explanation line, 12px, `#8f8f8a`:
  - Keep position: `Camera holds. Subject size follows the lens — Dragon now <lensOcc>%.`
  - Maintain size: `Camera dollies automatically to hold Dragon at <pinnedOcc>% of frame.`

**Occupancy math (important — it was wrong in the first pass).** Subject occupancy is **proportional** to focal length: `occ = clamp(round(58 × lens / 18), 14, 88)` — 58% at the 18mm reference, larger as the lens gets longer. In **Keep position**, occupancy tracks the lens and the frame box resizes. In **Maintain size**, occupancy is **pinned** at the value in effect when the mode was engaged: the number and the on-frame box stop moving, and the camera dollies instead. Applying a reference match pins 68% to agree with the solve.

---

### Camera Operate (right column)

Header `CAMERA OPERATE` (mono 11px, `letter-spacing: 0.2em`, `#ecece9`), then two labelled groups (mono 10px, `letter-spacing: 0.18em`, `#8f8f8a`):

- **TRANSLATION** — Dolly `−2.4m`, Truck `+0.8m`, Pedestal `<height>m`, Crane `0°`
- **ROTATION** — Pan `+4°`, Tilt `<tilt>`, Roll `−4°`

Each control row: `display: flex; align-items: center; gap: 12px` — label (mono 11.5px, `#c9c9c4`, `width: 78px`), track (`flex: 1; height: 2px; background: rgba(255,255,255,0.13); radius: 1px`), value (mono 11.5px, `#a5a5a0`, `width: 54px`, right-aligned). Knob: 11px circle, `background: #5fd3c4`, `box-shadow: 0 0 0 4px rgba(95,211,196,0.13)`, `top: -5px`, positioned by percentage.

Knob positions in the prototype are static demo values (Dolly 32%, Truck 62%, Pedestal 21%, Crane 50%, Pan 55%, Tilt 68%, Roll 44%); in production they bind to real ranges. Raw X/Y/Z is intentionally **not** here — it lives in Advanced.

---

### Blocking (right column)

Header `BLOCKING` (mono 11px, `letter-spacing: 0.2em`).

Three rows, `gap: 8px`, each `border: 1px solid rgba(255,255,255,0.08)`, `radius: 6px`, `background: #0d0d0d`, `padding: 11px 12px`, `display: flex; align-items: center; gap: 12px`:
- Left: name (13px, `#ecece9`) over meta (mono 10px, `letter-spacing: 0.1em`, `#8f8f8a`)
- Right: three representation chips `CARD` / `PROXY` / `MESH` (mono 11px, `padding: 7px 9px`), single-select per asset

Data: `Maya — 25.7m · 1.68m` (Proxy), `Dragon — 4.1m · span 11.2m` (Proxy), `Sedan — 9.4m · static` (Card).

The three representations are the hybrid character approach: **Card** = the 2D character reference as a billboard, **Proxy** = correctly-proportioned generic volume for blocking and eyelines, **Mesh** = full 3D asset. Swapping must be transparent to the rest of the screen; the proxy only needs correct physical dimensions.

---

### Secondary strip (quiet, full width)

Three panels, `flex: 1` each, `gap: 12px`, `border: 1px solid rgba(255,255,255,0.055)`, `radius: 8px`, `background: #080808`, `padding: 13px 14px 15px`. Title mono 9.5px `letter-spacing: 0.2em` `#8f8f8a`; right-aligned aside mono 9.5px `#7a7a74`. Rows `gap: 7px`, `display: flex; justify-content: space-between` — key 12px `#8f8f8a`, value mono 11px `#c9c9c4`.

| Panel | Aside | Rows |
|---|---|---|
| LIGHTING | `NIGHT` | Key `MOONLIGHT ↙` · Practicals `LAMPS · CAR` · Fog `15%` · Smoke `5%` |
| CAMERA BODY & RIG | `SUPER 35` | Sensor `SUPER 35` · Body `ALEXA 35` · Rig `DOLLY` · Lens family `COOKE S4` |
| PLATE & OUTPUT | current preview mode | Preview `<mode>` · Plate size `2048 × 858` · Provider `SEEDANCE` · Camera transform `ATTACHED` |

Read-only summaries in the prototype; in production each opens its own editor. Lighting should stay minimal (time of day, key, practicals, atmosphere) — not an Unreal lighting panel.

---

### Advanced strip (collapsed, full width)

Panel `border: 1px solid rgba(255,255,255,0.055)`, `radius: 8px`, `background: #070707`, `padding: 12px 14px 13px`. Label `ADVANCED` (mono 9.5px, `letter-spacing: 0.2em`, `#8f8f8a`).

Five disclosure chips, `gap: 8px`, each mono 10.5px, `letter-spacing: 0.12em`, `padding: 9px 13px`, `radius: 5px`, with a `▸` / `▾` caret (`#7a7a74`); closed `border: 1px solid rgba(255,255,255,0.1); color: #a5a5a0`; open `border: 1px solid rgba(95,211,196,0.45); color: #5fd3c4; background: rgba(95,211,196,0.07)`. Only one open at a time; the open one reveals a 4-column grid (`gap: 9px 26px`) above `border-top: 1px solid rgba(255,255,255,0.06)`.

| Chip | Revealed rows |
|---|---|
| Exact X / Y / Z | X `3.12m` · Y `0.42m` · Z `−8.70m` · ROT `51.3 / 4.2 / −6.1` |
| Movement curves | LEG 01 `ease out 0.35` · LEG 02 `linear` · OVERSHOOT `none` · SETTLE `0.4s` |
| Focus & DOF | FOCUS `11.4m` · APERTURE `f2.8` · NEAR LIMIT `8.9m` · FAR LIMIT `15.8m` |
| Lens family & distortion | FAMILY `COOKE S4` · DISTORTION `−1.8%` · BREATHING `0.4%` · FLARE `off` |
| AI parameters | MODEL `dp-agent v4` · VARIANTS `6` · TEMP `0.65` · CONSTRAINTS `blocking locked` |

---

### Modal: Match Reference Composition

Overlay `position: fixed; inset: 0; background: rgba(3,3,3,0.92); z-index: 40`, centered, `padding: 60px`. Dialog `width: 760px`, `border: 1px solid rgba(255,255,255,0.13)`, `radius: 10px`, `background: #080808`, `padding: 26px 28px 28px`.

- Title `MATCH REFERENCE COMPOSITION` (22px, weight 300, `letter-spacing: 0.2em`), sub `SOLVED AGAINST MAPLE STREET v3` (mono 11.5px, `#8f8f8a`); 34×34 `×` top-right
- Body `display: flex; gap: 20px`:
  - Drop area `width: 300px; aspect-ratio: 1.5`, `border: 1px dashed rgba(255,255,255,0.22)`, `radius: 6px`, striped fill; overlaid solved horizon line (`rgba(224,172,82,0.6)` at `top: 52%`) and a 9px vanishing-point ring at 34%; hint text `drop reference frame / storyboard, still, photo` (mono 11px, `#8f8f8a`)
  - Solve panel: header `SOLVE` (mono 10.5px, `#8f8f8a`) + `CONFIDENCE 81%` (mono 11.5px, `#e0ac52`); 2-column grid `gap: 11px 24px`, 13px labels `#8f8f8a`, mono 12px values — Estimated lens `16–20mm`, Camera height `0.35m`, Horizon `52% OF FRAME`, Tilt `+57°`, Roll `−5°`, Vanishing points `2 SOLVED`, Subject occupancy `68%`, Perspective `EXTREME`
- Footer right-aligned: `CANCEL` (outline) and `APPLY TO CAMERA 2B` (mono 11.5px, `background: #e0ac52`, `color: #2a1e08`, `border: 1px solid #e0ac52`)

Apply sets lens 18mm, height 0.35m, tilt +57°, setup name `REFERENCE MATCH`, framing mode Maintain size with occupancy pinned at 68%, clears coverage selection, closes the modal.

### Modal: Create Spatial World

Same overlay. Dialog `width: 620px`.

- Title `CREATE SPATIAL WORLD`, sub `MAPLE STREET · NEXT VERSION v5`
- `SOURCE` — five radio rows (`padding: 11px 13px`, `radius: 6px`, 9px dot + 13px label): `Current storyboard` (default), `Location plate`, `Multiple reference images`, `Video`, `Existing world`. Selected: `border: 1px solid rgba(95,211,196,0.5)`, `background: rgba(95,211,196,0.07)`, teal text and filled dot.
- `RECONSTRUCTION QUALITY` — three cards, `flex: 1`, `padding: 13px`, `radius: 6px`: `DRAFT` / `150 CR`, `STANDARD` / `1,500 CR` (default), `HIGH` / `1,500 CR · slow`. Selected card gets a teal border and tint.
- Note box: `border: 1px solid rgba(224,172,82,0.32)`, `background: rgba(224,172,82,0.05)`, 12px `#8f8f8a` — "Iterate on drafts while you find the geometry. Spend a full generation once the environment is useful."
- Footer: `CANCEL` (outline) and `GENERATE · <cost> CR` (solid teal, `color: #062a26`), cost following the quality pick (150 for Draft, else 1,500)

---

## Interactions & Behavior

| Trigger | Effect |
|---|---|
| Click shot in left rail | Sets active shot; camera view header updates. Production: load that shot's saved camera, world pin, and move. |
| Click lens | Sets lens. In Keep Position the occupancy number and frame box change; in Maintain Size they hold and the camera dollies. |
| Toggle Keep Position / Maintain Size | Maintain Size captures the current occupancy as the pinned value; Keep Position clears the pin. |
| Overlays button | Toggles the popover. Each row toggles one overlay independently; the button shows the active count. Overlays are view-only. |
| Preview chips | Switch render mode (Geometry / Flat shaded / Reference projected / Final preview). Also reflected in the Plate & Output panel. |
| Match Reference | Opens the drawer. Apply writes the solved camera and pins occupancy. |
| Intent preset | Selects the intent and swaps the proposed-camera delta list. Nothing is applied until Apply Camera Change. |
| Apply Camera Change | Writes the intent's lens/height/tilt, renames the setup, clears coverage selection, resets framing mode. |
| Coverage tile (normal) | Loads that camera into the same world; tile gets the selected border. |
| Compare toggle | Enters/exits compare mode and clears the selection. |
| Coverage tile (compare) | Selects/deselects, max two, oldest dropped past two. Two picked → comparison table. |
| Explore Again | Regenerates the six cameras (prototype only clears the selection). |
| Ease chip | Sets the easing preset for the selected move leg. |
| Representation chip | Swaps that asset between card / proxy / mesh. |
| Advanced chip | Accordion — opens one section, closes any other. |
| New World | Opens Create Spatial World. |
| Render Generation Plate | Not wired. Should render the frame from the world and hand it to the image model with the character references. |

**Transitions:** none animated in the prototype beyond CSS hover color/border changes. Keep it snappy; if you add motion, keep it under 150ms — this is a working console.

**Not designed, will be needed:** loading state for world generation (long-running), error state for a failed solve or generation, empty state before any world exists, and responsive behavior below 1600px.

## State Management

```
shot: string                  // "2B"
lens: number                  // 18
height: string                // "0.42" (metres)
tilt: string                  // "+17°"
setup: string                 // "HEROIC LOW" — display name of the current camera
framing: "position" | "size"  // on-lens-change behavior
pinnedOcc: number | null      // occupancy pinned when framing === "size"
coverage: string | null       // selected coverage key, "A".."F"
compareMode: boolean
compareSel: string[]          // up to 2 coverage keys
intent: string                // active Direct-the-Shot preset
preview: string               // "Geometry" | "Flat shaded" | "Reference projected" | "Final preview"
ease: string                  // "Linear" | "Ease in" | "Ease out" | "Ease both" | "Handheld"
overlays: Record<string, bool> // 11 keys; thirds + horizon default true
reps: Record<string, "Card"|"Proxy"|"Mesh">  // per blocking asset
advOpen: string | null        // open Advanced section
matchOpen / generateOpen: boolean
source, quality: string       // Create Spatial World form
```

Derived: `lensOcc = clamp(round(58 × lens / 18), 14, 88)`; `occ = framing === "size" && pinnedOcc != null ? pinnedOcc : lensOcc`.

Data the real implementation needs to fetch: world record (id, name, version list, splat handle, sun/moon direction), shot list with pinned world versions and saved cameras, blocking assets with dimensions and representation availability, generated coverage cameras, reference-solve results, and generation credit balance/costs.

The shot's saved camera is the persistence unit — roughly:

```json
{ "world": "maple-street-v3",
  "camera": { "position": [3.12, 0.42, -8.7], "rotation": [51.3, 4.2, -6.1],
              "lens": 18, "sensor": "super35", "focusDistance": 11.4, "aperture": 2.8 } }
```

The user never sees the JSON — they see `18mm — Low Heroic Wide`.

## Design Tokens

**Colors**

| Token | Value | Use |
|---|---|---|
| bg | `#050505` | page |
| panel | `#0a0a0a` | standard panels |
| panel-quiet | `#080808` | secondary panels, spatial world, modals |
| panel-deep | `#070707` | camera view shell, advanced strip |
| inset | `#0d0d0d` | rows, tracks, tiles, popover |
| plate | `#0c0c0c` | placeholder frame fill |
| toolbar | `#090909` | preview sub-toolbar |
| border | `rgba(255,255,255,0.08)` | standard panel border |
| border-hero | `rgba(255,255,255,0.12–0.14)` | camera view panel and frame |
| border-quiet | `rgba(255,255,255,0.055)` | secondary + advanced strips |
| border-control | `rgba(255,255,255,0.13–0.18)` | buttons and chips |
| text | `#ecece9` | primary |
| text-2 | `#c9c9c4` | button labels |
| text-3 | `#b5b5b0` / `#a5a5a0` | values, inactive chips |
| text-dim | `#8f8f8a` | field labels, micro headers |
| text-dimmest | `#7a7a74` / `#75756e` | ids, world metadata only |
| accent | `#5fd3c4` | active state, camera, primary action |
| accent-ink | `#062a26` | text on filled teal |
| accent tints | `rgba(95,211,196, 0.07 / 0.09 / 0.12 / 0.13)` | active fills, knob glow |
| amber | `#e0ac52` | rec, horizon, move path, compare column B, match reference |
| amber-ink | `#2a1e08` | text on filled amber |
| amber tints | `rgba(224,172,82, 0.05 / 0.09 / 0.12–0.13 / 0.32–0.55)` | fills and borders |

**Typography**
- Display / body: `"Helvetica Neue", Helvetica, Arial, sans-serif`. Sizes 30 / 22 / 13 / 12.5 / 12px. Titles weight 300 with `letter-spacing: 0.2em`.
- Mono: `"JetBrains Mono", monospace` (weights 300/400/500). Sizes 12.5 / 11.5 / 11 / 10.5 / 10 / 9.5px, `letter-spacing: 0.08–0.2em`, uppercase.
- **Minimum sizes rule:** anything interactive or primary is ≥ 11.5px. Reserve 9.5–10px for ids, world metadata, and secondary technical readouts only. This screen is stared at for hours.

**Spacing** — 4 / 5 / 6 / 7 / 8 / 9 / 10 / 11 / 12 / 13 / 14 / 16 / 17 / 20 / 22 / 26px. Panel padding `13–16px`; column gap `14px`; panel gap `12px`.

**Radii** — 2px (frame overlays) · 3px (frame) · 4px (chips) · 5px (buttons, rows, lanes) · 6px (inputs, cards) · 7px (tiles, popover) · 8px (panels) · 10px (modals) · 50%/pill (knobs, dots, markers).

**Shadows** — used twice only: popover `0 18px 40px rgba(0,0,0,0.7)`; slider knob glow `0 0 0 4px rgba(95,211,196,0.13)`. Selected coverage tiles use a 1px `box-shadow` ring rather than a heavier border.

**Placeholder fill** (any not-yet-real imagery): `background-color: #0c0c0c` + `background-image: repeating-linear-gradient(45deg, rgba(255,255,255,0.028) 0 6px, transparent 6px 12px)`.

## Assets

No image assets. Two web fonts (JetBrains Mono from Google Fonts; Helvetica Neue from the system). All graphics are CSS or inline SVG built from primitives. Icon glyphs are HTML entities: `✕` `▾` `▸` `▶` `✦` `✓` `↙` `→` `⇄`-style arrows. If the codebase has an icon set, substitute it.

The 3D content (splat world, camera render, coverage thumbnails) is generated at runtime and is not part of this handoff.

## Files

| File | What it is |
|---|---|
| `World Engine Previz v2.dc.html` | **The design to build.** Current, reviewed version. |
| `World Engine Previz.dc.html` | First iteration. Reference only — superseded layout, lower contrast, coverage in a modal, and an inverted occupancy formula. Do not build from it. |
| `support.js` | Runtime that makes the two files above render in a browser. Prototype infrastructure — do not port. |
| `README.md` | This document. |

To view: open either `.dc.html` in a browser with `support.js` beside it.
