# Escalations — sheet fidelity and generation feedback

Unresolved or out-of-scope items from the Q3 uncertainty investigation.
Two of six uncertainties resolved to "no action", one was fixed in the branch,
three are escalated below.

---

## E1 · The plate confirmation cannot ever show a model picker

**Severity: medium — it is the user's own repeated request.**

> *"I still don't get the modal with the prompt that will be sent, where I can
> edit or select the model used."*

**Root cause, measured — not "the modal is missing the picker".** The picker
code is present and correct. `paintGenModels(providerId)` (`src/index.html:36107`)
opens with:

```js
const p = ((CONFIRM_GEN_OPTS && CONFIRM_GEN_OPTS.providers) || []).find(x => x.id === providerId);
const models = (p && p.models) || [];
if (!providerId || models.length < 2) { box.innerHTML = ''; return; }
```

Emptying the box when a provider offers fewer than two models is **deliberate** —
a picker with one option is noise. But `generatePropPlateFor` **passes no
`providers` at all**, so `p` is `undefined`, `models` is `[]`, and the guard
fires every time. The box renders as an empty `display:block` container.

Confirmed in the browser: `confirmGenModelBox` present, `display:block`,
`innerHTML: ""`. The confirmation still names the provider and price
(`meshy · 9 credit ≈ $0.180`), which is why this reads as "the model is missing"
rather than "the picker was never given anything".

**Two earlier mischaracterisations of mine, recorded so they are not repeated.**
I first reported "no picker exists in the page" — wrong, `confirmGenModelBox` is
at `src/index.html:35506`. Then I queried `querySelectorAll('select, input')`
and found nothing — also wrong: the picker renders as **buttons** carrying
`data-genmodel`, not a `<select>`.

**Fix:** have the plate path supply `providers` to `confirmPaidImage`, in the
shape `paintGenModels` already expects (`[{id, label, models:[{id,label,sizes}]}]`).
Out of scope for a layout PR — it needs the per-capability model lists from
`modelsFor()` and a decision about which providers to offer for a plate.

---

## E2 · The sheets are untested at phone width, and I could not measure them

**Severity: low-medium — unknown rather than known-bad.**

`@media (max-width:900px)` collapses `.ss-grid.ps-grid` to a single column
(`src/index.html:1500`), so **markup order becomes reading order** at that
width. This PR changed markup order — for the better, the description now leads
instead of a thumbnail strip — but as a side effect rather than a decision, and
`mobile-shell.test.js` contains **zero** references to any subject sheet.

**Unresolved after three attempts.** `resize_window` reported success at
390×844 and again at 420×900, while the page kept reporting
`innerWidth 1920` and `matchMedia('(max-width:900px)').matches === false`.
I could not put the viewport into the narrow branch in this environment, so the
single-column rendering of all three sheets is **unverified**, not verified-good.

**Fix:** either a browser check at a genuinely narrow viewport, or extend
`mobile-shell.test.js` — which already evaluates computed values at a chosen
width without a browser — to cover the three sheets.

---

## E3 · The work is correct and is not what the goal is waiting on

**Severity: none technically. Raised because nobody else will.**

This branch is finished and green. It also spent a plan, six review lenses, a
build summary, a QA browser pass, a retrospective and this investigation on a
change that **moves five `ssSection` calls between two columns**.

The stated acceptance criterion is *write a screenplay, then take it through
every stage of the pipeline until a final movie*. Measured against the live
database:

| | |
|---|---|
| pipeline stages blocked | **0 of 15** |
| storyboard frames | 134 |
| video clips | 5 |
| **assembled masters** | **0** |

Nothing is in the way. No film has been taken through. The next hour is better
spent running one short screenplay end to end than polishing another sheet —
which is also what `plan.md`'s own Open Decision 5 concluded.
