# QA report — sheet fidelity and generation feedback

Branch `feature/sheet-fidelity-and-generation-feedback` @ `5b4dce7` · PR #4 (open).
6/6 flows walked in a real browser against an isolated checkout of the PR commit.
Suite 3101/3101/0 on a clean tree.

---

## Q1 — Hardest decision

**Giving the character sheet column protection when it makes zero `ssSection` calls.**

Measured: `characterSheetHtml` **0**, `renderLocationSheet` **10**, `renderPropSheet` **9**.
`ssSection` is what emits `data-region`, and `data-region` is the identity every
column test keys on. So the sheet the original complaint actually named was the
one sheet the mechanism could not reach.

Three ways in, and none of them clean:

| | Approach | Cost |
|---|---|---|
| A | Convert `characterSheetHtml` to `ssSection` — the review's own recommendation | Wraps every region in new `.ss-region` markup, changing the cascade on a layout measured against its reference image days earlier |
| B | Add `data-region` attributes to the existing blocks | A data attribute has no styling effect — but four sections have no wrapper div, so it means inserting wrappers into a flex column, which *does* move things |
| C | Key on the section **label** | Zero production change. But a label is user-facing copy, which is the weakest identity of the three |

**I chose C, and the reasoning is the epic's own premise inverted.** This whole
piece of work exists because the rendered sheet disagreed with the reference
image, and the rule was *where the HTML disagrees with the image, the image
wins*. Restructuring 9KB of just-approved design markup to close a **test** gap
puts the design at risk to protect the design. C is the only option that cannot
break the thing it exists to protect, and I took the weaker identity knowingly.

**The hardest *diagnosis* was separate, and worth distinguishing.** The
column-extent bug found in QA: `labelColumnsOf` assigned a section to the last
column that *opened* before it and never read the closing tag. My test and my
verification probe **shared that one wrong model**, so they agreed with each
other and both disagreed with the DOM. Two artefacts derived from the same
assumption cannot check each other — only the browser broke the tie, measuring
the concept band at **1496px** outside columns of 467 and 978.

---

## Q2 — Rejected alternatives, and where rejecting them could be wrong

**1. Converting the character sheet to `ssSection`.**
Could be wrong: labels are copy. `CHARACTER_LAYOUT` now encodes
`'Wardrobe &amp; props'` and `'Concept art &amp; references'`
(`sheet-layout-fidelity.test.js:523,530`) — including the HTML entity. Renaming
a heading, or changing how it is escaped, fails the test with a message about
**columns**, which points a reader at layout when the cause is a rename. This
codebase's own doctrine is that a check which cries wolf gets switched off, and
this is the most likely place that happens.

**2. Routing the location section field through `ssField`.**
Tried, then reverted — `subject-sheets` requires every `ssField()` call to name
a *literal, registry-declared* field, and a section's name is built at run time.
Could be wrong: the mode lock now lives in **two** places, which is exactly the
duplication this codebase keeps paying for. Nothing forces a *third* inline
control to carry it; only the pin test does, and only for `renderLocationSheet`.

**3. The `jsAttr` hardening (P2-4).**
Implemented, measured at exactly 12 sites, reverted because it broke a
legitimate "a control exists" assertion. Could be wrong: *"it deserves its own
PR"* is how hardening never ships. The helper exists **because this class of bug
already bit once**, and 12 sites is not a large change.

**4. Squashing nine commits into one.**
The TDD-first sequence — test written, watched fail, then fixed — now survives
only in the commit message and in this directory. A reviewer cannot see it in
the history.

---

## Q3 — Least confident: what could go wrong that I have not fully accounted for

**1. Label-as-identity is a false-positive generator.** Named first because it
is the most likely to fire, and firing wrongly is how a suite loses its
credibility. The `&amp;` entity is the sharp edge.

**2. My tests read SOURCE; the browser renders RUNTIME.** I verified every
section on all three sheets is **unconditional today**, so source position is
currently sound. That is a property of today's code, not a guarantee: the moment
a section is wrapped in a ternary, the test keeps asserting a column for
something that may not render at all. The extent bug already proved this class
is live rather than theoretical, and it was found by the browser, not by the
suite.

**3. The empty model picker is unfixed and is the user's actual complaint.**
`confirmGenModelBox` renders `display:block` with empty `innerHTML` on the plate
path, so the dialog names the provider and offers no way to change the model.
QA gave it a precise diagnosis and left it in place. Anyone opening that dialog
after this merges will hit exactly what they hit before.

**4. Another session is writing into this branch's working tree.**
`backend/mcp-server.js`, `backend/routes/characters.js` and a new
`backend/lib/plate-delivery.js`, uncommitted. Their presence makes the branch's
local suite show **3 failures** that are not this PR's — I proved that by running
the identical commit in a clean checkout (3101/3101/0), but the next person to
run tests in that worktree will see red and may misattribute it.

**5. Nothing tests these sheets at phone width.** `.ps-grid` collapses to a
single column at ≤900px, so markup order *is* the reading order there. This
change reordered it — for the better — as a side effect, and
`mobile-shell.test.js` contains zero references to any subject sheet.

**6. The honest one about scope.** Six review lenses, a QA pass and a build
summary all ran against a change that moves five `ssSection` calls. The
acceptance criterion is *screenplay → final movie*, and the database still holds
134 storyboard frames, 5 video clips and **zero assembled masters**. Nothing here
is wrong; it is simply not the thing that is missing.
