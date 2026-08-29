# Handoff: Character Card (character detail modal)

## Overview
A dark, "glassy black" character detail card for a pre-production app where a writer/art
director fleshes out a character and locks the **4 official views** (front, back, left, right)
that are later used as the canonical reference for AI image generation.

The card holds four things in one view:
1. Pipeline status of the character (views locked, concept review state, role).
2. The 4 canonical view plates, top-left, plus generation metadata (seed, output size).
3. All written description fields, with the Appearance field explicitly marked as the prompt source.
4. A full-width concept art & reference library band at the bottom, with type filters and
   a "starred = attached to prompt" convention.

## About the Design Files
The file in this bundle (`Character Card.dc.html`) is a **design reference created in HTML** —
a prototype showing intended look, structure and behavior. It is not production code to copy.
Recreate it in the target codebase using that codebase's existing framework, component library
and conventions (React, Vue, SwiftUI, etc.). If no environment exists yet, pick the most
appropriate framework and implement there.

The HTML uses a small in-house streaming-component wrapper (`<x-dc>`, `{{ }}` holes,
`renderVals()`). Ignore that machinery; read the markup and inline styles as the spec.

## Fidelity
**High-fidelity.** Colors, typography, spacing, radii and states below are final intent.
Recreate pixel-close, but substitute the codebase's own primitives (Button, Chip/Badge, Card)
where they exist. Image regions are deliberately **striped placeholders** — real plates and
references come from the app's data.

## Screens / Views

### Character Card (modal / detail page)
**Purpose:** review and edit one character; confirm the 4 canonical views are locked before
generation; browse and star concept references.

**Page shell**
- Full-height page, padding `48px 40px 72px`.
- Background: `#050506` with two soft radial washes:
  - `radial-gradient(1100px 600px at 22% -10%, rgba(120,160,190,0.10), transparent 60%)`
  - `radial-gradient(900px 500px at 90% 110%, rgba(190,120,110,0.07), transparent 60%)`

**Card container**
- `max-width: 1560px`, centered, `border-radius: 22px`, `overflow: hidden`.
- Border `1px solid rgba(255,255,255,0.09)`.
- Fill: `linear-gradient(160deg, rgba(255,255,255,0.055), rgba(255,255,255,0.018) 40%, rgba(255,255,255,0.01))`.
- `backdrop-filter: blur(34px)`.
- Shadow: `0 40px 120px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.06)`.

#### 1. Header
- Padding `26px 32px 22px`, bottom border `1px solid rgba(255,255,255,0.07)`.
- Flex row, `justify-content: space-between`, `gap: 32px`.
- Left block: `flex: 1 1 auto; min-width: 0`, column, `gap: 10px`.
  - Title `THE MAN` — 30px / 600 / `letter-spacing: 0.14em` / uppercase, `#e8e8ea`.
  - Beside it, mono meta: `CHR-0142 · Prologue 1812` — 11px, `letter-spacing: 0.16em`,
    uppercase, `rgba(232,232,234,0.42)`.
  - Status chip row: mono 10.5px, `letter-spacing: 0.12em`, uppercase, `gap: 8px`,
    each chip `padding: 5px 10px`, `radius: 6px`, **`white-space: nowrap; flex: none`**
    (required — labels must never wrap mid-phrase):
    - `Views locked 4/4` — border `oklch(0.76 0.11 200 / 0.35)`, bg `oklch(0.76 0.11 200 / 0.10)`, text `oklch(0.86 0.08 200)`.
    - `Concept in review` — border `oklch(0.76 0.11 75 / 0.30)`, bg `oklch(0.76 0.11 75 / 0.09)`, text `oklch(0.86 0.08 75)`.
    - `Lead · Kristy bloodline` — border `rgba(255,255,255,0.12)`, bg `rgba(255,255,255,0.04)`, text `rgba(232,232,234,0.55)`.
- Right block: `flex: none`, row, `gap: 10px`.
  - `Export sheet` — secondary: `padding 9px 14px`, radius 8, border `rgba(255,255,255,0.12)`,
    bg `rgba(255,255,255,0.04)`, mono 11px uppercase `0.1em`; hover bg `rgba(255,255,255,0.09)`.
  - `Generate` — primary: border `oklch(0.76 0.11 200 / 0.4)`, bg `oklch(0.76 0.11 200 / 0.14)`,
    text `oklch(0.9 0.07 200)`; hover bg `oklch(0.76 0.11 200 / 0.22)`.
  - Close `✕` — 34×34, radius 8, transparent, border `rgba(255,255,255,0.10)`,
    icon `rgba(232,232,234,0.6)`; hover `#fff` on `rgba(255,255,255,0.06)`.

#### 2. Body — two columns
`display: grid; grid-template-columns: 520px minmax(0, 1fr)`.

**Left column** — padding `28px 28px 32px 32px`, right border `1px solid rgba(255,255,255,0.06)`,
column stack `gap: 26px`.

*Official views block*
- Section label (mono 10.5px, `0.2em`, uppercase, `rgba(232,232,234,0.5)`): `OFFICIAL VIEWS`,
  right-aligned note `canonical · fed to generation` in `oklch(0.8 0.09 200)`.
- Grid: `repeat(2, minmax(0,1fr))` by default (tweakable to `repeat(4, …)`), `gap: 10px`.
- Each plate: `aspect-ratio: 3/4`, radius 12, `overflow: hidden`, placeholder fill
  `repeating-linear-gradient(135deg, rgba(255,255,255,0.045) 0 2px, transparent 2px 9px)` over `rgba(255,255,255,0.02)`.
  - Locked plates (Front, Back, Left): border `1px solid oklch(0.76 0.11 200 / 0.30)`,
    a 6px cyan dot top-right (`oklch(0.76 0.11 200)`).
  - Pending plate (Right): border `1px dashed oklch(0.76 0.11 75 / 0.45)`, footer link
    `regenerate →` in `oklch(0.82 0.09 75)`.
  - Labels: top-left mono 10px uppercase `0.14em` `rgba(232,232,234,0.75)`;
    bottom-left mono 9.5px `rgba(232,232,234,0.35)` caption (`front plate`, `left profile`, …).
- Metadata strip below: `padding 9px 12px`, radius 9, bg `rgba(255,255,255,0.025)`,
  border `rgba(255,255,255,0.06)`, mono 10px `rgba(232,232,234,0.45)`;
  left `seed 84120·b — turntable v4`, right `1024 × 1365 · png`.

*Physical spec block*
- Label `PHYSICAL SPEC`. 2×2 grid of cells, `gap: 1px` over a `rgba(255,255,255,0.06)`
  background (hairline effect), outer border `rgba(255,255,255,0.06)`, radius 10, clipped.
- Cell: `padding 12px 14px`, bg `rgba(10,10,12,0.55)`; key mono 9.5px `0.16em` uppercase
  `rgba(232,232,234,0.4)`; value 14px `#e8e8ea` with `margin-top: 5px`.
- Content: Age `45–50`; Height `1.80 m`; Build `Tall, thin, slight stoop`;
  Era / place `Regency 1812 · Manchester`.

*Palette lock block*
- Label `PALETTE LOCK`. Row of 4 equal swatches, `gap: 8px`.
- Swatch: 44px tall, radius 8, border `rgba(255,255,255,0.09)`; caption mono 9px
  `rgba(232,232,234,0.4)`.
- Swatches: `banyan #5C1620`, `linen #E9E3D6`, `breeches #23262B`, `skin #CFC9BD`.

**Right column** — padding `28px 32px 32px 30px`, column stack `gap: 26px`.

*Appearance (prompt source)*
- Header row: label `APPEARANCE`, char meta `676 chars · prompt source` (mono 10px,
  `rgba(232,232,234,0.32)`, hidden when the `showCharCounts` flag is off), a flexible 1px
  rule `rgba(255,255,255,0.07)`, then a `Copy` ghost button (mono 9.5px uppercase).
- Body copy: 15.5px / `line-height 1.62` / `rgba(232,232,234,0.92)` / `text-wrap: pretty` /
  `max-width: 74ch`. Exact text:

  > A gaunt English gentleman of about 45, Regency era 1812, Manchester. Long narrow face, hollow cheeks, pale sweat-sheened skin, wide pale-grey eyes set deep under dark brows, a long straight nose, thin mouth. Short dark hair worn disheveled and swept back off a high forehead, period side-whiskers down to the jawline, clean-shaven chin. Tall and thin, about 1.8m, narrow shoulders, slight stoop. Dressed for a Halloween night indoors: a long quilted banyan dressing gown of deep wine-red brocade worn open, over a loose white linen nightshirt, dark knee breeches and white stockings, no shoes. Hands empty. Strictly period-accurate 1812 Regency; absolutely no modern elements.

- Keyword chips (extracted from the appearance text): pill `padding 4px 9px`, radius 20,
  border `rgba(255,255,255,0.1)`, bg `rgba(255,255,255,0.03)`, mono 9.5px `0.08em`,
  text `rgba(232,232,234,0.55)`:
  `wine-red brocade banyan`, `white linen nightshirt`, `knee breeches`,
  `white stockings, barefoot`, `side-whiskers`.
  Constraint chip `no modern elements` uses the amber accent
  (border `oklch(0.76 0.11 75 / 0.3)`, bg `/0.08`, text `oklch(0.84 0.09 75)`).

*Description + Personality* — `grid-template-columns: 1.35fr 1fr; gap: 26px`.
- Same label + rule treatment. Body 14.5px / `1.6` / `rgba(232,232,234,0.78)`.
- Description text:
  > The unnamed Manchester gentleman of the 1812 prologue. A scholar-collector who unearthed and pried open the ancient artifact, and so opened the mist that takes his wife and, finally, him. Kristy's distant ancestor - the origin of the bloodline.
- Personality text: `Obsessive, scholarly, unravelling. Detected from screenplay — 1 mention.`
  followed by outline chips `stooped gait`, `sweat sheen`, `hands empty`.

*Wardrobe & props (continuity checklist)*
- Label row with trailing note `continuity checklist`.
- Grid `repeat(auto-fit, minmax(220px, 1fr))`, `gap: 10px`, `align-items: start`
  (required — a fixed 3-column grid clipped card text at narrow widths).
- Card: `display: flex; gap: 10px; align-items: flex-start; padding 11px 12px`, radius 10,
  border `rgba(255,255,255,0.07)`, bg `rgba(255,255,255,0.022)`.
  - Thumb 38×46, radius 6, striped placeholder, border `rgba(255,255,255,0.08)`.
  - Title 13px `#e8e8ea`; caption mono 9.5px `rgba(232,232,234,0.4)`.
- Items: `Quilted banyan / worn open · floor length`,
  `Linen nightshirt / loose collar, untied`, `Stockings, no shoes / white, knee height`.

#### 3. Concept art & references (full-width band)
- Padding `28px 32px 34px`, top border `1px solid rgba(255,255,255,0.07)`,
  bg `rgba(0,0,0,0.25)` (darker shelf under the card body).
- Header row: label `CONCEPT ART & REFERENCES`; type filter pills (mono 9.5px uppercase,
  `padding 4px 9px`, radius 6) — active `All 14` on `rgba(255,255,255,0.07)` with `#e8e8ea`,
  inactive `Sketch 5`, `Costume 4`, `Face 3`, `Mood 2` in `rgba(232,232,234,0.42)`;
  flexible rule; trailing note `starred refs are attached to the prompt`.
- Tile grid: `repeat(6, minmax(0,1fr))` (dense tweak: 8), `gap: 12px`.
- Tile: `aspect-ratio: 4/3`, radius 11, striped placeholder.
  - Starred / attached tiles: border `oklch(0.76 0.11 200 / 0.32)`, label prefixed `★`
    (`★ Face study`, `★ Banyan ref`), caption at bottom-left.
  - Normal tiles: border `rgba(255,255,255,0.08)`, label `rgba(232,232,234,0.6)`.
    (`Rough sketch / silhouette pass 01`, `Costume pass / layering, open front`,
    `Lighting mood / candle, single source`.)
  - Drop slot: `1px dashed rgba(255,255,255,0.16)`, bg `rgba(255,255,255,0.015)`,
    centered `+` (18px, `rgba(232,232,234,0.4)`) over `DROP REFERENCE`;
    hover border `oklch(0.76 0.11 200 / 0.5)`, bg `rgba(255,255,255,0.03)`.

## Interactions & Behavior
- **Close `✕`** dismisses the card/modal.
- **Generate** submits the character to image generation using the Appearance text as the
  prompt plus the starred references as image conditioning; the 4 locked view plates are the
  canonical identity input.
- **Regenerate →** on a pending view plate re-runs only that view. A view is either
  *locked* (solid cyan border + dot) or *pending* (dashed amber border) — the header chip
  `Views locked n/4` counts locked plates and should turn amber while `n < 4`.
- **Copy** on Appearance copies the raw prompt text; show a brief "Copied" state.
- **Reference tiles**: click to open a lightbox; star toggles "attached to prompt" (drives
  the cyan border and the `★` prefix). Type pills filter the grid; counts recompute.
- **Drop slot** accepts drag-and-drop image files (and paste); show an upload progress state
  and require a type assignment (sketch / costume / face / mood) on ingest.
- **Hover states**: buttons and the drop slot lighten as noted above; tiles may raise border
  opacity by ~0.08. Transitions ~120–160ms ease-out on background/border/color only.
- **Loading**: view plates and reference tiles render as the striped placeholder while the
  image loads; keep the label and caption visible.
- **Empty**: with no references, show only the drop slot at full tile width plus the note.
- **Responsive**: below ~1180px collapse the 520px / 1fr body grid to a single column
  (views block first). Header chips never wrap mid-label; the chip row wraps as whole chips.
  Reference grid should step 6 → 4 → 3 → 2 columns as width shrinks.

## State Management
- `character`: `{ id, name, sceneTag, role, age, height, build, era }`
- `fields`: `{ appearance, description, personality }` + derived char counts;
  `appearance` is the generation prompt.
- `views`: array of 4 `{ view: 'front'|'back'|'left'|'right', imageUrl, status: 'locked'|'pending'|'generating' }`
- `generation`: `{ seed, turntableVersion, outputWidth, outputHeight, format }`
- `palette`: array of `{ name, hex }` (locked palette).
- `wardrobe`: array of `{ title, note, thumbUrl }`
- `references`: array of `{ id, type, title, caption, imageUrl, starred }`;
  `activeRefFilter` for the pill row; counts derived from `references`.
- UI flags: `showCharCounts`, `viewLayout` (`grid` | `row`), `referenceDensity`
  (`comfortable` | `dense`), `copied`, `lightboxRefId`.
- Data needs: fetch character + views + references on open; POST on generate/regenerate
  (poll or subscribe for plate status); PATCH on field edits and star toggles; upload endpoint
  for dropped references.

## Design Tokens
**Colors**
- Page `#050506`; shelf overlay `rgba(0,0,0,0.25)`; spec cell `rgba(10,10,12,0.55)`.
- Text: primary `#e8e8ea`, body `rgba(232,232,234,0.92)`, secondary `rgba(232,232,234,0.78)`,
  label `rgba(232,232,234,0.5)`, muted `rgba(232,232,234,0.4)`, faint `rgba(232,232,234,0.32)`.
- Surfaces: `rgba(255,255,255,0.015 / 0.022 / 0.025 / 0.03 / 0.04 / 0.07)`.
- Borders: `rgba(255,255,255,0.06 / 0.07 / 0.08 / 0.09 / 0.10 / 0.12 / 0.16)`.
- Accent A (locked / canonical / primary action) `oklch(0.76 0.11 200)`; text variants
  `oklch(0.8–0.9 0.07–0.09 200)`.
- Accent B (pending / constraint) `oklch(0.76 0.11 75)`; text variants `oklch(0.82–0.86 0.08–0.09 75)`.
- Character palette (content, not UI): `#5C1620`, `#E9E3D6`, `#23262B`, `#CFC9BD`.

**Typography**
- UI / body: Instrument Sans (Google) — 30/600 title, 15.5/400 prompt body, 14.5 body,
  14 spec value, 13 card title.
- Labels / meta / chips: JetBrains Mono (Google) — 11, 10.5, 10, 9.5, 9;
  uppercase with `letter-spacing` 0.08–0.2em.
- Fallbacks: Helvetica, Arial, sans-serif.

**Spacing** — 5, 6, 8, 9, 10, 12, 14, 16, 22, 26, 28, 32, 34, 40, 48, 72 px.
**Radii** — 6, 8, 9, 10, 11, 12, 20 (pill), 22 (card).
**Shadows** — card `0 40px 120px rgba(0,0,0,0.7)`, inner hairline `inset 0 1px 0 rgba(255,255,255,0.06)`.
**Effects** — `backdrop-filter: blur(34px)` on the card only.
**Placeholder stripe** — `repeating-linear-gradient(135deg, rgba(255,255,255,0.045) 0 2px, transparent 2px 9px)`.

## Assets
No image assets ship with this handoff. Every image region (4 view plates, wardrobe thumbs,
reference tiles) is a striped CSS placeholder standing in for app data. Fonts are Instrument
Sans and JetBrains Mono from Google Fonts — swap for the codebase's equivalents if it already
has a sans + mono pairing. If your app has a brand/design system, map the two oklch accents
onto its existing semantic "locked/success" and "pending/warning" tokens.

## Files
- `Character Card.dc.html` — the full design (single file, opens in a browser).
