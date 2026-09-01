# Sheet fidelity and generation feedback

Canonical brainstorm. Merges the Interrogate (prior-work), Office Hours (approach
selection) and CE Brainstorm (repo research) steps into one document.

**Status: slices 1 and 2 are shipped** (`e00031f`, pushed to `github/main`).
Slice 3 is partly shipped — the character sheet is corrected and verified; the
prop sheet's column inversion is the outstanding work.

---

## Problem Statement

Two complaints, filed separately, that turned out to share a shape: **the code
was right and the page was wrong, and every test agreed with the code.**

**1. The pre-spend confirmation could not be seen.** Asked four times — *"I
probably asked 4 times to check every place on the app where we click generate
… and I still don't get the modal with the prompt that will be sent"* — and each
time the answer was that it was already built and tested. It was. All 35
`.modal-overlay` elements carried the same `z-index: 1000`, so paint order fell
to DOM order, and `confirmGenModal` is declared at DOM index 3 with **31
overlays after it**, both subject sheets among them. The dialog opened correctly
every time, with the prompt, the provider, the model, the quality and the size —
underneath whatever sheet had launched it.

Five test files passed throughout (`every-generate-button`, `paid-preview`,
`generation-controls`, `prompt-visibility`, `loading-never-sticks`). All of them
check the confirmation is *invoked* and that its markup is right. None could see
it was invisible. **A gate nobody can read is a gate that is not there**, and the
generation went ahead regardless — which is precisely the spend the mechanism
exists to prevent, and why footage was being bought on Runway's own website
instead.

**2. No sign that anything was happening.** *"As it generates I still don't see a
spinner until we get the content back."* `every-generate-button` already
required every generating function to show it was working — and its predicate
accepted `setStatus(msg, true)`, the **bottom status bar**. Of the 29 functions
it discovers, **6** marked the control that was clicked, **19** wrote only to the
status bar, **4** said nothing at all. The codebase had already recorded the
right standard for storyboard frames — *"feedback belongs on the thing you
touched"* — and never generalised it.

**3. The three subject sheets did not match their design.** *"The biggest issues
are at the bottom where the images are too big, sections aren't organized
properly on all three."* Seventy tests passed against a checked-in `.dc.html`
handoff while the render disagreed, because those tests assert **presence** —
*every element the design labels is on the sheet* — and the complaint was about
**order, column and size**, which nothing measured.

---

## Recommended Approach

**A — Stack, Signal, Then Fidelity:** fix modal stacking at the one `showModal`
helper, add on-the-control busy state at the one `api()` choke point, then
correct the sheets against the reference screenshots — three independently
shippable slices in dependency order, highest value and lowest risk first.

---

## Approaches Considered

| Name | Effort | Key assumption | Biggest risk |
|---|---|---|---|
| **A — Stack, Signal, Then Fidelity** *(chosen)* | S + M + L | The confirmation's contents are already correct; only its paint order is wrong | Slice 3 is large and could stall — mitigated because slices 1–2 ship value alone |
| B — Rebuild the sheets from the `.dc.html` handoff | L | The checked-in handoff still matches the screenshots | High and unnecessary: discards wiring 70 tests hold, and handoff-vs-image agreement was never verified |
| C — Targeted CSS patch (move `confirmGenModal` to the end of the DOM) | S | The confirmation is the only modal opened on top of another | False — 31 overlays paint above it, including the plate viewer and gallery, both opened *from* the sheets. Fixes the instance, leaves the class of bug |

---

## Scoped Definition

**In scope**

- Modal stacking: a modal opened on top of another paints above it, for all 35
  overlays and all 15 sites that toggle the `open` class.
- Generation feedback: the control that started a paid generation shows it is
  working, for all 29 generating functions, via one mechanism.
- Sheet fidelity: the character and prop sheets restructured to match
  `design-ref-character.png` and `design-ref-prop.png`.
- View/edit mode: sheets open read-only with an EDIT button; upload and generate
  work in both modes; leaving edit mode causes no layout shift.

**Out of scope**

- The **location sheet's structure.** Measured against its reference and found
  essentially correct — see Constraints. Changing it would be work with no
  defect behind it.
- Additive detail visible in `design-ref-character.png` but not a misplacement:
  the seed bar under the official views (`seed 84120·b — turntable v4 | 1024 ×
  1365 · png`) and the wardrobe token chips under APPEARANCE. Follow-up.
- The **9 standing suite failures**, which belong to another session's
  uncommitted work in this tree (18 modified backend files plus
  `board-raster.js`, `image-raster.js`, `sequence-delivery.js`,
  `muapi-upload.js`, `generation-recovery.test.js`). Not ours to document or
  repair; a similar uncommitted change was proven wrong against the live MuAPI
  API earlier in the same session.

---

## Files / Modules Affected

| File | Change | Status |
|---|---|---|
| `src/index.html` — `showModal` / `closeModal` / `restackModals` | Depth-based stacking; base `z-index: 1000` retained | **shipped** |
| `src/index.html` — 15 class-toggle sites | Routed through the helpers (9 open, 6 close) | **shipped** |
| `src/index.html` — `api()` + `GENERATION_ORIGIN` + `beginGenerationBusy` | Busy state at the one choke point every generating function reaches | **shipped** |
| `src/index.html` — `characterSheetHtml` | Spec and palette to the left column; description/personality paired | **shipped** |
| `src/index.html` — CSS `.cs-spec`, `.cs-two-up`, `.cs-tiles`, `.cs-tile`, `.cs-up` | 2×2 spec, two-up block, compact 168px thumbnails, upload no longer overprints the view label | **shipped** |
| `src/index.html` — `SHEET_MODE` / `sheetEditable` / `ssField` | View/edit mode, one rule, reaching all three sheets | **shipped** |
| `src/index.html` — `renderPropSheet` (:25349) | **Five section moves between columns** | **outstanding** |
| `ios/FilmEngine/Web/index.html` | Byte-identical copy of the SPA (enforced by `ios-app.test.js`) | keep in sync |
| `backend/tests/modal-stacking.test.js` · `generation-busy.test.js` · `sheet-layout-fidelity.test.js` | New, set-based | **shipped** |
| `docs/plans/mobile-feasibility.md` | Media-query count 12 → 13 (asserted) | **shipped** |

**Patterns to follow.** Section order is expressed *only* by markup order inside
each `<div class="ss-col">` — there is no registry. `ssSection(id, title, note,
inner, reach)` and `ssField(field, value, opts)` remain the composition
primitives; `ssField` is already mode-aware, so view/edit reaches any section
that moves. `SS` (`:24794`) is the shared state for location and prop.

---

## Constraints

- **The screenshots outrank the `.dc.html` handoff** where they disagree. Here
  they agree: `Prop Card.dc.html` declares `grid-template-columns: minmax(0,
  1fr) 400px`, identical to the code. The CSS was never wrong; the sections are
  in the wrong columns.
- **`subject-sheet-fidelity` pins two structural facts** that must stay true:
  *"PROP puts the turntable full width ABOVE the two-column body"* and
  *"LOCATION composes narrow-left / wide-right"*. Neither is affected.
- **No test pins which sections sit in which prop column**, so nothing blocks
  the move.
- **`RELOCATED_ACTIONS`** requires the Generate / Upload / Gallery row to remain
  reachable — the design does not draw it, but removing it is a capability loss.
- **The location sheet must not change.** Measured: narrow-left `560px`, wide-right
  `992px`, bottom `1158px` grid beside a `300px` rail, and Lighting / Atmosphere
  / Sound already sharing `y=1192` as the reference's three-up row. An earlier
  probe reported those three as missing; that was the probe (`children.length ===
  0` + `startsWith`), not the render. **Do not "fix" them.**
- **jsdom computes no layout**, so geometry cannot be asserted the usual way. The
  in-repo precedent is `mobile-shell.test.js`'s cascade evaluator; browser
  measurement is the alternative used here.
- `build.target: single-html` — no bundler ([ADR-002](../adr/002-vanilla-http-no-framework.md)).

---

## Top Edge Cases

1. **A prop with no description or materials.** Moving them to the wide column
   must not leave a large empty gap. The existing empty states (`"Nothing
   recorded."`, `"Add material"`) travel with their section, and `.ss-col` is
   `flex-direction: column` with `gap`, so the column collapses to its content
   rather than reserving grid tracks.

2. **A prop with many references and no states.** With references moved below
   materials and states, a reference-only prop now opens on two near-empty
   sections. That is correct — the reference orders by importance, not by what
   happens to be populated — but the empty states must read as intentional
   rather than broken.

3. **Narrow viewports.** `.ps-grid` is a two-column grid with a hard `400px`
   rail; below roughly 900px the wide column starves. `mobile-shell.test.js`
   already asserts a modal fits the screen it opens on, and any new breakpoint
   must update the media-query count stated in
   `docs/plans/mobile-feasibility.md`, which is asserted.

---

## Definition of Done

Shipped and verified:

- [x] A modal opened on top of another paints above it — sheet `z=1001`,
      confirmation `z=1002`, `elementFromPoint` at the confirmation's centre
      returns `confirmGenModal` (was `characterSheetModal`).
- [x] All 15 class-toggle sites route through `showModal` / `closeModal`;
      closing releases the depth so it cannot climb without bound.
- [x] A generating POST marks the control that started it — `is-generating`,
      `disabled`, elapsed label — and releases on failure as well as success.
- [x] Free reads and non-generating POSTs mark nothing; batches are refcounted.
- [x] Character sheet: spec `2×2` in the left column, palette beneath it,
      description and personality side by side, reference strip compact
      (`168px` auto-fill, `118px` tall).
- [x] Sheets open in view mode; EDIT button on both sheet headers; `ssField`
      locks all three shapes; picture controls ungated by mode.
- [x] 19 mutations run across the three slices, all killed.

Outstanding:

- [ ] `renderPropSheet` emits `ps-description`, `ps-materials`, `ps-states`,
      `ps-references` into the wide column and `ps-scale`, `ps-spec`,
      `ps-appears`, `ps-constraints` into the `400px` rail — asserted **set-based
      over all 9 prop sections**, so a section left behind fails rather than
      being noticed by eye.
- [ ] Measured live: the element containing the object description sits in the
      `1152px` column, not the `400px` one.
- [ ] The turntable strip stays full width above the two-column body.
- [ ] The location sheet's measured geometry is identical before and after,
      proving the change stayed scoped to prop.
- [ ] View/edit mode and the picture controls behave on prop as on character.
- [ ] No new suite failures beyond the 9 already attributable to the other
      session's uncommitted work.
- [ ] Mutation-proven: moving any one section back to its old column fails.

---

## Open Questions

1. **Does the `.dc.html` handoff still agree with the screenshots in general?**
   Verified for the one value that mattered here (`minmax(0, 1fr) 400px`), not
   across all three files. If they have diverged elsewhere, the images win and
   the handoff should be refreshed rather than silently outranked.
2. **Should the reference strip's filter pills be wired?** All three references
   show `ALL 14 / SKETCH 5 / COSTUME 4 / FACE 3 / MOOD 2`. They render; whether
   they filter was not checked.
3. **Who owns the 9 standing failures?** The uncommitted backend work needs a
   decision — finish it or revert it — before the suite can be a clean gate again.
4. **Should `every-generate-button`'s busy predicate be tightened** now that the
   `api()` mechanism exists? It still accepts a status-bar-only signal, which is
   a weaker standard than the codebase's own.

---

## Prior Work References

- `CLAUDE.md` — *A Modal Opened On Top of Another Must Paint On Top of It*,
  *While a Generation Runs, the Thing You Clicked Says So*, *The Three Sheets,
  Laid Out as the Reference Images Draw Them* (all added by this work);
  *A Plate Is the Shape of Its Subject*, *The Card Got Complicated for No
  Reason*, *A Button Drawn Outside Its Own Card*, *The App Shell on a Phone*.
- `design-ref-character.png`, `design-ref-location.png`, `design-ref-prop.png` —
  the spec for the sheets.
- `design_handoff_character_card/` — `Character Card.dc.html`, `Location Card.dc.html`,
  `Prop Card.dc.html`, tracked, with 70 passing tests.
- `backend/tests/subject-sheet-design.test.js`, `subject-sheet-fidelity.test.js`,
  `every-generate-button.test.js`, `mobile-shell.test.js`.
- Commit `e00031f` — slices 1 and 2, plus the character half of slice 3.
- No `docs/solutions/` or `docs/brainstorms/` exist in this repo; `docs/plans/`
  holds 36 files, none covering the sheet templates or view/edit mode.

---

## Effort Estimate: **S**

For the outstanding work only. Five section moves at known line numbers in one
renderer, with the CSS already correct — plus the test that proves it and the
before/after location measurement that proves it stayed scoped. The **L** in the
original estimate has been spent: it covered the character sheet and view/edit
mode, both shipped, and the research that established the location sheet needs
nothing.
