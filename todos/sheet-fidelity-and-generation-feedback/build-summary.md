# Build summary — sheet fidelity and generation feedback

Branch `feature/sheet-fidelity-and-generation-feedback` @ `2745dbd`. Pre-merge
verification. **No PR opened.**

```
STATUS: PASS — ready for Phase 4

Tests:      3098 passing / 0 failing
Type check: N/A — no TypeScript in this repo. Parse gate clean: 454/454 backend
            files via `node --check`, plus the SPA's 4 inline blocks
            (2,045,537 chars) parsed with 0 errors
Lint:       N/A — no linter configured. The repo's equivalent is its own
            derived-audit suite, which is green
Coverage:   76.45% lines / 69.44% branches / 79.46% functions (backend)
            No threshold is configured anywhere, so "below threshold" has no
            answer to give
```

## What the toolchain actually is

The three commands this step names do not exist here, and saying "clean" for
them would be a fabrication rather than a result.

| Asked for | Reality | What was run instead |
|---|---|---|
| `tsc --noEmit` | no `tsconfig.json`, **0** `.ts` files, `tsc` not installed | `node --check` over all 454 backend `.js` files; the SPA's inline script parsed with `new Function` |
| lint | no eslint/prettier/biome config, **0** devDependencies | the project's own derived audits (`docs-drift`, `page-handlers`, `manual-edit`, `every-generate-button`, …) — all green |
| coverage | no nyc/c8 config | `node --test --experimental-test-coverage` |

This follows [ADR-002](../../docs/adr/002-vanilla-http-no-framework.md): two
runtime dependencies, no framework, no bundler. Adding a toolchain to satisfy a
checklist would reverse a deliberate decision.

**Coverage is a backend measure and this change is frontend.** The work is
`src/index.html` markup order plus tests, so the percentages above are the
repo's standing numbers, not a movement caused by this branch.

## Review — five findings, ranked by impact

### 1. The character sheet has no column protection, and structurally cannot get any
`characterSheetHtml` makes **0** `ssSection(...)` calls — it builds its own
markup — where `renderLocationSheet` makes 10 and `renderPropSheet` makes 9.
`data-region` is emitted by `ssSection`, and that attribute is the identity the
new column tests key on.

So the sheet the complaint **started** with is the one sheet whose sections can
move between columns with nothing failing. Proven: moving `cs-palette` into the
other column leaves 74/74 tests passing. Character has order assertions
(`assertOrder` over hand-written marker lists) but no membership assertion, and
order alone cannot see a section that changed column while keeping its relative
position.

*Fix:* route `characterSheetHtml`'s regions through `ssSection`, then extend
`columnsOf(...)` to it. That closes the gap for all three sheets with one
mechanism instead of a third idiom.

### 2. A modal rule went vacuous when slice 1 improved the code it polices
`backend/tests/page-handlers.test.js:185` — *"every modal is shown with the class
its own CSS displays"* — scans for inline
`getElementById('x').classList.add('y')` and flags a wrong class. Measured now:
**35** overlays in the markup, **0** inline show-calls remaining, **49**
`showModal()` call sites. The rule iterates an empty set and passes.

This is the exact failure `shot-anchor` had and that this branch fixed: an
assertion coupled to a call *shape* rather than a contract. Here it does not
fail loudly — it silently stops protecting 35 modals.

*Fix:* follow `showModal()` — assert the helper adds the stylesheet's display
class, and that every overlay is opened either inline with that class or through
the helper. `shot-anchor.test.js` now does exactly this and is the template.

### 3. A location field bypasses the shared field helper
`src/index.html:25276` renders
`<textarea class="ss-input" rows="4" data-field="section_${sec.id}">` directly
instead of through `ssField`. It therefore ignores view mode — a set
description stays editable on a sheet that is supposed to be read-only — and
sits outside the one helper that carries the escaping and mode contract.

The prop sheet has **zero** such controls, and a test pins that. The location
sheet is explicitly out of scope in `plan.md` ("measured correct… do not fix
them"), which is why this was recorded rather than changed.

### 4. The phone reading order moved, and nothing tests it
`src/index.html:1500` collapses `.ps-grid` to `grid-template-columns:1fr` at
`max-width:900px`, so **markup order is the phone reading order**. This change
therefore also reordered the sheet on a phone — from
`references → states → appears → description → …` to
`description → materials → states → references → …`.

That is an improvement (the writing now leads instead of a thumbnail strip), but
it was a side effect rather than a decision, and `mobile-shell.test.js` contains
**0** references to any subject sheet. The desktop order is now pinned by six
tests; the phone order is pinned by none.

### 5. There is no coverage threshold to be below
76.45% lines / 69.44% branches / 79.46% functions, and no `.nycrc`, no c8
config, no CI gate. "Flag if below threshold" cannot be answered because no
threshold has ever been chosen. **Branch coverage is the weak axis** — nearly
one in three branches is unexercised, which is where refusal paths and error
handling live, and this codebase's expensive bugs have repeatedly been silent
wrong-branch behaviour rather than crashes.

## A false lead, recorded so it is not re-chased

`ssField` renders three shapes and the mode test's loop iterates two
(`['textarea','input']`), which reads like a two-of-three gap. It is not: the
`select` branch is asserted separately, because `readonly` does nothing on a
`<select>` and it needs `disabled`. Mutation-proven — making view mode leave
selects editable fails *"editing is off in view mode and on in edit mode"*. The
test's own comment already documents the trap.

## Verification run

```
node --test backend/tests/*.test.js
  ℹ tests 3098 · suites 195 · pass 3098 · fail 0 · cancelled 0 · skipped 0 · todo 0

node --check (454 backend .js files)        → 0 errors
SPA inline script (4 blocks, 2,045,537 ch)  → 0 parse errors
src/index.html == ios/FilmEngine/Web/index.html → identical
node --test --experimental-test-coverage    → 76.45 | 69.44 | 79.46
```

`main` is separately red (3129 tests, 14 failing) from another session's 20
uncommitted files; none of it is reachable from this branch's diff, which is 5
files and zero backend source.
