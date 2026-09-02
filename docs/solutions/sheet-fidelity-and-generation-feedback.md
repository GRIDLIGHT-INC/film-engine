---
title: A layout test that agreed with itself and disagreed with the browser
slug: sheet-fidelity-and-generation-feedback
date: 2026-09-02
category: testing
subcategory: ui-verification
severity: medium
status: resolved
tags:
  - source-vs-runtime
  - vacuous-test
  - mutation-testing
  - layout-fidelity
  - derived-denominator
  - test-blind-spot
  - shared-wrong-model
  - design-fidelity
  - no-jsdom
  - adr-002
surfaces:
  - src/index.html
  - backend/tests/sheet-layout-fidelity.test.js
  - backend/tests/page-handlers.test.js
  - backend/tests/shot-anchor.test.js
commits:
  - 69bd32c   # merge
  - 1c90b63   # the column move itself
  - 5b4dce7   # the column-extent bug
  - ccbb019   # the unconditional-rendering precondition
pr: https://github.com/GRIDLIGHT-INC/film-engine/pull/4
retrieval_hint: >
  Read this when a UI test passes while the page is visibly wrong, when writing
  a test that reads source to assert something about rendering, or when a
  refactor makes an existing audit stop matching anything.
---

# A layout test that agreed with itself and disagreed with the browser

## Problem

The prop sheet rendered its two columns **inverted** against its reference
image. The 1936-character object description — the text every prop plate is
generated *from* — sat in a scrolling **400px** rail, while a single reference
thumbnail owned the **1152px** column.

**The CSS was already correct.** `.ps-grid` was `minmax(0, 1fr) 400px`,
identical to what the design handoff declares. Five `ssSection(...)` calls were
simply in the wrong `.ss-col`.

The deeper problem is why nobody caught it. **Seventy tests passed against a
visibly wrong sheet**, because every existing check asserted *presence*:
`subject-sheet-design` asserts each element the design labels exists;
`subject-sheet-fidelity` asserts each layout declaration is declared and worn.
Every section here was present — in the wrong half of the page. Nothing had
ever measured **column membership**.

## Solution

Five `ssSection(...)` calls moved between the two `.ss-col` blocks. No CSS
change. Blocks were cut whole by balanced-brace extraction and pasted, never
retyped — a dropped `esc()` on `description` or `materials` is stored XSS, and
that was the only real security surface. Verified block-level: `esc()` count 10
before and 10 after.

Ten regression tests were added, set-based over the regions each renderer
actually emits, because **section order is expressed only by markup order** —
there is no registry, enum or ordering array to read.

## What Worked

**Binding an assertion to geometry rather than to an index.** The description
test asserts it lands in whichever track `.ps-grid` makes *flexible*, read from
the stylesheet. Swapping the tracks to `400px minmax(0, 1fr)` flips it from fail
to pass — which is what proves it reads geometry rather than always failing.

**Mutation-proving every assertion, including the ones that already passed.**
Three of the ten were regression *pins* — they pass by design. A pin that cannot
fail is worse than none, so each was shown to fail on the defect it guards. This
caught two of my own tests being too weak before they shipped.

**The browser as tiebreaker.** Two source-derived artefacts agreed with each
other and both disagreed with the DOM. Only a real measurement resolved it.

**Deriving the denominator from code.** Regions read out of each renderer's own
markup, not typed into a list. A later count check contradicted the report at 14
vs 10; the *grep* was wrong, not the report — `git diff main...HEAD` settled it.

## What Did Not Work

**Bounding a scan by a character window.** The first fix for a stale assertion
matched `function showModal[\s\S]{0,600}?classList.add(...)`. That function runs
**469 characters** to the call — **131 characters of slack**. One added guard
and the check silently stops matching and fails a working page. Replacing a
coupling to a call *shape* with a coupling to a character *count* is not an
improvement. Brace-bound instead.

**Assuming source position means runtime presence.** Short-circuiting one
section so it rendered nothing (`${'' && ssSection('ps-materials', …)}`) left
the file passing **20/20** while the browser showed **8 regions instead of 9**.

**Ignoring where a column closes.** The scan assigned each section to the last
column that *opened* before it. The character sheet's concept band renders full
width **below** both columns — measured at **1496px** against columns of 467 and
978 — and the test recorded it as column 1. Worse than a wrong label: the test
already held the wrong answer for that section, so moving the band *into* a
column would have passed silently.

**Fighting an intentional design.** Routing a location field through `ssField`
to fix its missing mode lock broke two `subject-sheets` assertions:
that file requires every `ssField()` call to name a **literal,
registry-declared** field, and a section's name is built at run time. Those
sections sit outside the registry deliberately. The inline lock was correct.

**A refactor silently disarming an audit.** `backend/tests/page-handlers.test.js:185` scans
for a modal opened at a *call site*. Once every overlay moved onto a shared
helper there were **zero call sites left** — it matched an empty set and passed
across 49 sites, protecting nothing.

## Prevention

1. **When a test reads source to assert something about rendering, assert the
   precondition too.** Source position equals runtime presence only while every
   section is emitted unconditionally. That precondition is now a test:
   a conditional section fails with *"their position in the source no longer
   proves where — or whether — they render"*. A DOM assertion is the direct fix
   and is unavailable here ([ADR-002](../adr/002-vanilla-http-no-framework.md):
   no bundler, zero devDependencies, no jsdom).

2. **Never bound a scan by a character count.** Use brace/paren depth from the
   declaration. A fixed window fails in the direction that lies — it stops
   matching and reports the *feature* as broken.

3. **Mutation-prove pins, not just failing tests.** If an assertion passes
   today, break the thing it guards and confirm it fails.

4. **When two checks agree, ask whether they share an assumption.** Artefacts
   derived from the same model cannot validate each other. Measure the real
   thing once.

5. **A refactor that removes a pattern can disarm the audit that scans for it.**
   After routing N call sites through one helper, check every rule that matched
   the old pattern still matches something.

6. **Presence is not placement.** Tests that assert elements exist will pass
   against any arrangement of them.

## Related Docs

`docs/solutions/` did not exist before this entry — **this is the first**. The
institutional knowledge for this class lives in `CLAUDE.md`, which carries 18
occurrences of the *vacuous / mutation-proven / cries wolf / switched off*
idioms this work leaned on directly. Prior art consulted:

- `CLAUDE.md` → *"The Three Sheets, Laid Out as the Reference Images Draw Them"* — the presence-vs-placement gap, named before it was closed
- `CLAUDE.md` → *"A Modal Opened On Top of Another Must Paint On Top of It"* — five test files passing while the gate was invisible
- `CLAUDE.md` → *"A Column Is Not a Style, It Is Where the Words Go"* — this work's own entry
- [ADR-002](../adr/002-vanilla-http-no-framework.md) — why no jsdom, and why the precondition is asserted instead of the DOM
- `docs/sheet-fidelity-and-generation-feedback/plan.md` — the plan
- `todos/sheet-fidelity-and-generation-feedback/escalations.md` — three items that outlived the change

## Key Code References

| Reference | What |
|---|---|
| `src/index.html:25350` | `renderPropSheet` — the five moved `ssSection` calls |
| `src/index.html:1485` | `.ss-grid.ps-grid { minmax(0, 1fr) 400px }` — correct throughout, never changed |
| `src/index.html:24945` | `ssField` — carries the view/edit lock; `readonly` for text, `disabled` for select |
| `backend/tests/sheet-layout-fidelity.test.js:303` | `columnsOf` — extent-aware column membership |
| `backend/tests/sheet-layout-fidelity.test.js:484` | `labelColumnsOf` — label-keyed, for the sheet with no `ssSection` |
| `backend/tests/sheet-layout-fidelity.test.js:604` | the unconditional-rendering precondition |
| `backend/tests/page-handlers.test.js:185` | the audit that a refactor disarmed |
| `src/index.html:36107` | `paintGenModels` — see escalation E1: the picker works, nothing feeds it |
