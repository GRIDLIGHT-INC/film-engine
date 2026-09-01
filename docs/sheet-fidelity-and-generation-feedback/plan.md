# Implementation plan — sheet fidelity and generation feedback

Canonical plan. Merges the CEO scope review, the engineering design review and
the CE plan research into one document.

Companion to [`brainstorm.md`](brainstorm.md). Slices 1 and 2 and the character
half of slice 3 are already shipped (`e00031f`); **this plan covers the
outstanding work only.**

---

## Overview

The prop sheet renders its two columns inverted against
`design-ref-prop.png`: the 1936-character object description — the text every
plate is generated from — sits in a scrolling 400px rail while a single
reference thumbnail owns the 1152px wide column. `.ps-grid` is already
`minmax(0, 1fr) 400px`, identical to the value `Prop Card.dc.html` declares, so
**the CSS is correct and the section placement is not**. The fix is five
`ssSection(...)` calls moved between the two `.ss-col` blocks in
`renderPropSheet` — a markup-order change with no data, route, schema or CSS
change — proven by a set-based test over all 9 `ps-*` regions keyed on
`data-region`, plus one browser measurement that the description's column is
1152px, plus a before/after measurement of the location sheet showing the change
stayed contained.

---

## Scope

*From the CEO review — mode: REDUCTION.*

**In**

- The five section moves in `renderPropSheet` (`src/index.html:25349`).
- A set-based test over all 9 `ps-*` regions asserting each resolves to its
  expected column.
- One browser-measured assertion that the object description renders in the
  `1152px` column, not the `400px` one.
- A before/after measurement of the location sheet proving containment.
- The `ios/FilmEngine/Web/index.html` copy.

**Out**

- **The location sheet.** Measured correct: 560/992 columns, 1158+300 bottom
  rail, Lighting / Atmosphere / Sound already sharing `y=1192`. Changing it is
  work with no defect behind it. An earlier research pass reported that trio as
  missing; that was a faulty probe, not the render. **Do not "fix" them.**
- **`.ps-grid` CSS.** Already `minmax(0, 1fr) 400px`, matching the design file.
  Touching it breaks a correct rule.
- The character seed bar and wardrobe token chips — additive elements, not
  misplacements.
- The reference-strip filter pills — a feature, not a fidelity gap.

**Why the line is here.** The acceptance criterion is *screenplay → final
movie*. Preflight reports **0 blocked of 15 stages**, yet across 5 projects and
70 shots the database holds 134 storyboard frames, 93 audio assets, **5 video
clips and zero masters** on $32.53 of lifetime spend. The pipeline is not
blocked, it is unused past the board. Target quality for this work is **7/10**:
correct, tested, contained, and finished within the hour.

---

## Architecture

### Data flow

```
VIEW PATH
  click prop card
        │
        ▼
  openSubjectSheet('prop', id) ──► showModal('subjectSheetModal')
        │                              └─► MODAL_STACK.push → restackModals()
        │                                   z = 1000 + index   [shipped]
        ▼
  api('/props/:id')  ─── GET ───►  routes/locations.js (props share the router)
        │                                │
        │                                ▼
        │                          SELECT film_props / film_assets
        ▼                                │
  SS = { kind, id, data, views,  ◄───────┘
         propViews, collapsed }
        │
        ▼
  renderSubjectSheet() ──► renderPropSheet()
        │                     ├─ .ps-turntable   full width, above    [unchanged]
        │                     ├─ .ss-col  ◄── WIDE 1152px   ★ 4 sections land here
        │                     └─ .ss-col  ◄── RAIL  400px   ★ 4 sections land here
        ▼
  body.innerHTML = html ──► DOM ──► .ps-grid: minmax(0,1fr) 400px  [unchanged]

EDIT PATH
  Edit ─► toggleSheetMode() ─► SHEET_MODE 'view' ⇄ 'edit' ─► re-render
        │                          └─ ssField() reads sheetEditable()
        │                             → readonly (textarea/input) | disabled (select)
        │                             same element, no reflow          [shipped]
        ▼
  onchange ─► saveSheetField() ─► PUT /props/:id ─► propFields() ─► UPDATE (MERGED)
                                                          └─► SS.data[field] = v

GENERATE PATH  (available in BOTH modes)
  Generate ─► confirmPaidImage ─► showModal('confirmGenModal')  [paints above sheet]
        ▼
  confirmGenResolve(true) ─► api(POST …/plate/generate)
        │                        └─ spendsOnThisCall() → beginGenerationBusy()
        │                             marks GENERATION_ORIGIN (the sheet's button)
        ▼
  provider ─► asset row ─► renderSubjectSheet() ─► release busy in `finally`
```

### Interfaces

No new types. Three existing contracts are load-bearing and **must not change**:

```js
ssSection(anchorId, title, what, inner, reach)
  → `<section class="ss-region" data-region="${anchorId}"> … </section>`
  // data-region is IDENTITY and is emitted by the one shared helper.
  // No test uses it today — every sheet test matches class names, which are
  // styling. This is the correct denominator for the column assertion.

ssField(field, value, opts) → string
  // Already mode-aware. A moved section inherits view/edit for free.

SS = { kind, id, data, views, sections, propViews, times, collapsed, parse, list }
  // Module-level. renderPropSheet() takes no arguments and reads SS.
```

**Section order is expressed *only* by markup order** inside each `.ss-col`.
There is no registry, enum or ordering array — which is why this is a markup
edit, and why the test must read the rendered DOM rather than a list.

---

## Affected Files

| File | Change type | Why |
|---|---|---|
| `src/index.html` — `renderPropSheet` (:25349) | **Modify** (markup order only) | Five `ssSection(...)` calls move between the two `.ss-col` blocks. The entire functional change. |
| `backend/tests/sheet-layout-fidelity.test.js` | **Extend** | Set-based prop-column assertions over all 9 `ps-*` regions, keyed on `data-region`. |
| `ios/FilmEngine/Web/index.html` | **Copy** | `ios-app.test.js` fails if it differs from `src/index.html` by one byte. |
| `src/index.html` — CSS `.ps-grid` | **No change** — stated explicitly | Already matches `Prop Card.dc.html`; changing it breaks a correct rule. |
| `src/index.html` — `renderLocationSheet` | **No change** — stated explicitly | Measured correct against its reference. |

---

## Implementation Steps

1. **Capture the baseline.** Open a prop sheet (SEDAN,
   `4036849d-4d33-4013-8381-b9b7c04bd1c4`) and a location sheet (SUBURBAN
   STREET, `fd63e031-510f-4965-9b7f-efdfcfc22afd`) in the browser and record
   each column's width and the `data-region` values it contains. The location
   numbers are the containment guard for step 7.

2. **Write the failing test first.** Extend
   `backend/tests/sheet-layout-fidelity.test.js` with a set-based assertion over
   **all 9** `ps-*` regions: each `data-region` must resolve to its expected
   column index. Assert the *contract*, not one way of achieving it — the
   precedent is `subject-sheet-fidelity`'s rejected `grid-template-columns`
   check, which refused a correct flex implementation.

3. **Watch it fail**, and confirm the failure names the misplaced regions rather
   than erroring. A test that fails for the wrong reason proves nothing.

4. **Move the four sections into the wide column**, by **cut-and-paste of whole
   `ssSection(...)` calls**. Never retype: a dropped `esc()` turns a prop
   description into stored XSS. Target order —
   `ps-description`, `ps-materials`, `ps-states`, `ps-references`.

5. **Move the four sections into the rail**, same discipline. Target order —
   `ps-scale`, `ps-spec`, `ps-appears`, `ps-constraints`.
   `ps-plates` stays in `.ps-turntable`, untouched.

6. **Re-run the test and confirm all 9 regions resolve.** Then measure in the
   browser that the element containing the object description sits in the
   `1152px` column.

7. **Re-measure the location sheet** and confirm it is identical to step 1. This
   is the proof the change stayed scoped to prop.

8. **Mutation-prove the test**: move one section back to its old column and
   confirm the test fails. Every layout assertion written on this feature needed
   at least one tightening pass before it bound.

9. **Sync the iOS bundle** (`cp src/index.html ios/FilmEngine/Web/index.html`)
   and run the full suite, confirming no failures beyond the 9 already
   attributable to another session's uncommitted work.

10. **Update `CLAUDE.md`** with the finding and commit.

---

## Test Plan

| Test | Type | What it verifies |
|---|---|---|
| All 9 `ps-*` regions resolve to their expected column | unit — set-based over `data-region` | The complete move. A section left behind fails rather than being spotted by eye. |
| Object description renders in the `1152px` column | integration — browser measurement | The user-visible defect, by geometry rather than markup position. |
| Turntable strip stays full width above the two-column body | unit | `subject-sheet-fidelity`'s existing pin still holds. |
| Location sheet geometry identical before/after | integration — browser measurement | Containment. The regression guard for the out-of-scope sheet. |
| `ssField` still locks all three shapes in view mode on a prop | unit | View/edit survives the move. |
| Picture controls not gated on `sheetEditable()` | unit — source | Upload and generate work in both modes. |
| Move one section back | mutation | The test is not vacuous. |
| Full suite | regression | No new failures beyond the 9 pre-existing. |

---

## Security Checklist

- [ ] **Output encoding preserved.** Every moved block is cut-and-pasted whole;
      no `ssSection`/`ssField` call is retyped. A dropped `esc()` on
      `description` or `materials` is stored XSS. *This is the only real
      security surface in the change.*
- [ ] **No new input paths.** `saveSheetField` → `PUT /props/:id` →
      `propFields(body)` unchanged; still merged, never replaced; still
      validated per field.
- [ ] **No authorization change.** The app is unauthenticated by design and
      binds loopback unless `FILM_ENGINE_HOST` says otherwise. Untouched.
- [ ] **No data exposure change.** Same fields, same viewer, different column.
- [ ] **No new dependency.** ADR-002 holds: two backend dependencies, no
      bundler, no framework.

---

## Rollback Plan

**Blast radius is one function's markup.** No migration, no route, no schema, no
provider call, no stored data touched — so rollback is a revert with no cleanup.

1. `git revert <sha>` — restores `renderPropSheet`, the test and the iOS copy in
   one commit.
2. Re-sync the iOS bundle if the revert leaves it divergent
   (`ios-app.test.js` will say so immediately — loud and cheap).
3. No data repair: nothing was written, migrated or generated.

**Detection.** The failure mode is *silent* — a section in the wrong column
renders perfectly and nothing throws. Detection is the set-based test and the
browser measurement, not a runtime signal. If the test is green and the
screenshot still looks wrong, suspect the test before the code: that is exactly
how 70 passing tests coexisted with a wrong render.

---

## Open Decisions

1. **Does the `.dc.html` handoff still agree with the screenshots generally?**
   Verified only for `minmax(0, 1fr) 400px`, not across all three files. If they
   have diverged elsewhere, the images win and the handoff should be refreshed
   rather than silently outranked. *Not blocking this change.*
2. **Should the reference-strip filter pills be wired?** All three references
   show `ALL 14 / SKETCH 5 / …`. They render; whether they filter is unchecked.
   Currently **out of scope** as a feature. *Not blocking.*
3. **Who owns the 9 standing suite failures?** Another session's uncommitted
   work — 18 modified backend files plus `board-raster.js`, `image-raster.js`,
   `sequence-delivery.js`, `muapi-upload.js`, `generation-recovery.test.js`.
   Until it is finished or reverted, "no new failures" is the weakest possible
   acceptance signal and a real regression can hide in the noise.
   **This is the one that should be decided soon.**
4. **Should `every-generate-button`'s busy predicate be tightened** now that the
   `api()` mechanism exists? It still accepts a status-bar-only signal, which is
   weaker than the codebase's own standard. *Not blocking.*
5. **Where does the next hour go after this?** The CEO review's answer is the 65
   shots with no clip and the zero films ever assembled — not more sheet work.
