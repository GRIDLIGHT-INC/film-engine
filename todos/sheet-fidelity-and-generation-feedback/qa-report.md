# QA report — sheet fidelity and generation feedback

Branch `feature/sheet-fidelity-and-generation-feedback` @ `ccbb019` · PR #4 (open, not merged).
Suite **3102 passing / 0 failing** on a clean checkout.

**There is no staging environment**, and that was established rather than assumed:
no `.env` files exist, and `backend/dev-server.js` binds `127.0.0.1` (ADR-002,
unauthenticated local app). QA ran against an **isolated `git worktree --detach`
checkout of the exact PR commit**, served on its own port. That isolation was
load-bearing: another session is writing into the feature worktree — four files,
still uncommitted — so testing there would have measured their in-flight work as
this PR's.

---

## Flows Tested

Derived from `plan.md`'s own data-flow diagram (VIEW / EDIT / GENERATE), crossed
with the three sheet renderers the diff touches.

| # | Flow | Result |
|---|---|---|
| F1 | Prop sheet — VIEW path | ✅ 9 regions; description in the **1152px** column at 1090px, 1936 chars, `readOnly` |
| F2 | Prop sheet — EDIT path | ✅ 10 fields locked → unlocked → locked, and **zero regions shift** on toggle (the plan's stated acceptance bar) |
| F3 | Save — merge, not replace | ✅ `PUT` with only `visual_prompt` left `description`, `category`, `height_m` intact. Written as a no-op so **no user data changed** |
| F4 | Generate gate | ✅ `elementFromPoint` at the confirmation's centre returns `confirmGenModal` (z 1002 vs sheet 1001) **despite the sheet sitting later in the DOM**. Cancelled — nothing generated, nothing spent |
| F5 | Location sheet | ✅ geometry identical to baseline (560/992/1158/300); 6 section fields lock in both modes |
| F6 | Character sheet | 🐛 **BUG → FIXED** (see below) |

---

## Bugs Fixed

**1 · The column scan ignored where a column CLOSES** — `5b4dce7`
Found in the browser, in a test *this PR shipped*. `labelColumnsOf` assigned each
section to the last column that **opened** before it and never read the closing
tag. The character sheet's concept band renders full width **below** both
columns — measured at **1496px** against columns of 467 and 978 — and the test
recorded it as column 1.

Worse than a wrong label: the test claimed to catch a section moving between
columns, and for this one it already held the wrong answer, so moving the band
*into* a column would have passed silently — a blind spot exactly where it
advertised coverage.

**2 · Source position stopped meaning runtime presence** — `ccbb019`
Every column test reads the renderer's source. Short-circuiting one section so it
rendered nothing (`${'' && ssSection('ps-materials', …)}`) left the file passing
**20/20** while the browser showed **8 regions instead of 9**. The section was
gone from the DOM and nothing noticed.

A DOM assertion is the direct fix and is unavailable — ADR-002 means no bundler
and zero devDependencies, so there is no jsdom to render into. The
**precondition** is enforceable, so it is enforced instead.

---

## Regression Tests Added

Ten, in `backend/tests/sheet-layout-fidelity.test.js`. Every one is
mutation-proven — each was shown to fail on the defect it exists to catch.

| Test | Catches |
|---|---|
| PROP: every region renders in the column the reference draws it in | the original defect |
| PROP: each column runs in the order the reference stacks it | a section reordered within a column |
| PROP: the object description renders in the flexible column | bound to the **stylesheet's** track, not a column index |
| PROP: the turntable strip stays full width, above both columns | the turntable pulled into a column |
| PROP: every editable control goes through ssField, and the move drops none | a retyped field — the stored-XSS surface |
| LOCATION: the sheet measured correct is left exactly as it is | the prop change leaking into the location sheet |
| LOCATION: every editable control honours view mode | a control that ignores the mode lock |
| CHARACTER: every section renders in the column the reference draws it in | the sheet that previously had **no** column protection |
| CHARACTER: each column runs in the order the reference stacks it | character section reordering |
| every section these column tests place is rendered unconditionally | the precondition all of the above rest on |

---

## CE Three Questions

**Q1 — Hardest decision.** Giving the character sheet column protection when
`characterSheetHtml` makes **zero** `ssSection` calls (vs location 10, prop 9).
Converting it — the review's own recommendation — wraps every region in new
`.ss-region` markup and changes the cascade on a layout measured against its
reference image days earlier. The epic's premise is *the image wins*;
restructuring approved design markup to close a **test** gap puts the design at
risk to protect the design. I keyed on the section **label** instead: the weakest
identity of the three options, taken knowingly, because it is the only one that
cannot break what it protects.

The hardest **diagnosis** was separate: my test and my verification probe shared
one wrong model, so they agreed with each other and both disagreed with the DOM.
Two artefacts built on the same assumption cannot check each other — only the
browser broke the tie.

**Q2 — Rejected alternatives.** The `ssSection` conversion; routing the location
field through `ssField` (tried, reverted — `subject-sheets` requires literal
registry-declared field names); the `jsAttr` hardening (12 sites, reverted — it
broke a legitimate "a control exists" assertion); and keeping nine commits
unsquashed. The one most likely to prove wrong is the third: *"it deserves its
own PR"* is how hardening never ships.

**Q3 — Least confident.** Six items were listed and then **investigated**
(hypothesis → test → confirm), which changed two of the answers:

- *Label-as-identity fails with a misleading message* — **wrong.** A rename fails
  with *"the sections … are not the ones this test knows about"* and a label
  diff. The key-set guard fires first. No action.
- *Source-vs-runtime blindness* — **confirmed and fixed** (Bug 2).
- *The empty model picker* — **root-caused**, escalated as E1.
- *Cross-session contention* — **resolved**: their four files are disjoint from
  this PR's ten, so no merge conflict is possible.
- *Phone width* — **unresolved**, escalated as E2.
- *Scope vs the acceptance criterion* — escalated as E3.

Full text: [`escalations.md`](escalations.md).

---

## Escalations

Three, in [`escalations.md`](escalations.md). None blocks this PR; all three
outlive it.

**E1 · The plate confirmation can never show a model picker.** Not "the picker
is missing" — `paintGenModels` deliberately hides a picker offering fewer than
two models, but `generatePropPlateFor` passes **no `providers` at all**, so the
guard fires every time and the box renders empty. The picker works; nothing feeds
it. This is the user's own repeated request, and it now has a one-paragraph
diagnosis instead of a symptom.

**E2 · The sheets are unverified at phone width.** `.ps-grid` collapses to one
column at ≤900px, so markup order *becomes* reading order — and this PR changed
markup order. Three `resize_window` attempts reported success while the page kept
reporting `innerWidth 1920` and `matchMedia('(max-width:900px)') === false`.
Recorded as **unverified**, not verified-good. `mobile-shell.test.js` already
evaluates computed values at a chosen width without a browser, which sidesteps
the tooling limit.

**E3 · This is not what the goal is waiting on.** 0 of 15 pipeline stages
blocked; 134 storyboard frames; 5 video clips; **0 assembled masters**. Nothing
is in the way, and no film has been taken end to end.

---

## Status

```
QA STATUS: ESCALATIONS EXIST
```

The branch itself is complete and green — 6/6 flows, 3102/3102/0, two bugs found
and fixed *during* QA. The escalations are not defects in this change: E1 and E2
are pre-existing, and E3 is a decision about where the next hour goes.

**Do not advance automatically.** Merging also wants coordination: another
session has four uncommitted files in the same worktree, which make that tree's
suite show failures that are not this PR's.
