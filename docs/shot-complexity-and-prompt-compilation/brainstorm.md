# Brainstorm — shot complexity and provider-specific prompt compilation

**Phase 1, Interrogate.** The proposal is challenged here, not planned. Where it
is already built, that is said; where it rests on something this codebase has
deliberately refused before, that is said too.

---

## What is being proposed

Two things, which the proposal presents as one:

1. **A compiler architecture.** `Director intent → structured shot
   representation → provider-specific prompt compiler → generation`, instead of
   one generic prompt sent to every model. Film Engine holds starting state,
   subject action, camera, environment action, timing, ending state, continuity
   locks and references; each adapter compiles that into the sentence shape its
   own provider documents.

2. **Generation decomposition, driven by an AI Shot Complexity Score.** Before
   generating, warn: *"4 independent character actions, 2 environmental
   interactions, complex camera motion — estimated low adherence. Recommended
   split: 3 shots."* The proposal calls this "probably the most important
   accuracy technique of all."

Plus a ranked list of prompting techniques and a rule: **reduce generative
entropy before increasing prompt detail.**

---

## The finding that changes the shape of the work

**The compiler already exists. It is one adapter's private function.**

`buildVideoPayload` already returns a structured representation — not a string:

```
{ prompt, negative_prompt, camera_control, motion: { subject, environment, camera } }
```

`lib/providers/runway.js:299` then compiles it:

```js
function buildRunwayMotionPrompt(payload) {
    const parts = ['Continuous seamless shot.'];
    if (motion.subject)     parts.push(...);   // subject action
    if (motion.environment) parts.push(...);   // environmental motion
    if (camera) parts.push(`Over N seconds, the camera performs ${camera}.`);
```

That is the proposal's architecture, working, today, for exactly one provider.

**And the others do not use it.** `lib/providers/seedance.js:174` takes
`String(p.prompt || p.motion_prompt || '')` — the flat string. It reads
`p.motion` and `p.camera_control` essentially not at all. So the structured
representation is built, travels on the payload, and is discarded by every
adapter but one.

So this is **generalisation of something proven, not invention.** The plan
should be costed and argued that way. The interesting question is no longer
"should we have a compiler" — we have one — but "what is the contract every
adapter implements, and what happens to an adapter that implements nothing?"

The obvious answer, and the one consistent with `maxKeyframes`,
`maxReferenceImages`, `promptLimit` and `referenceMode`: **a compiler is a
declared property of an adapter, with a documented fallback.** An adapter that
declares none gets today's flat prompt, visibly, rather than silently.

### The ceilings alone justify it

| provider | prompt ceiling |
|---|---|
| Runway | 1,000 (mirrored from its image limit; the video limit is undocumented) |
| Seedance | 16,000 |

A single compiled prompt cannot be right for both. Sixteen times the budget is
not a rounding difference — it is the difference between "cut the atmosphere
note" and "say the whole thing." This is the strongest *technical* argument for
the compiler and it is better than the accuracy argument, because it is
measurable today.

---

## Five techniques in the ranked list are already built

Worth stating plainly, because a plan that proposes to build them again would
be spending on solved problems.

| # | Technique | Status in Film Engine |
|---|---|---|
| 1 | Excellent starting image | **Built.** Plates, shot anchor, locked consistency profiles, `gatherShotReferences`, keyframe as `init_image`. The anchor exists precisely so a shot is re-photographed rather than reinvented. |
| 3 | Explicit camera behaviour, independent of subject | **Built.** `motion.camera` / `camera_control` are separate fields; `analyzePath` turns a previs path into honest compound prose where **"while"** means concurrent axes and **"then"** means ordered legs. |
| 5 | Clear spatial relationships | **Built.** `lib/shot-staging.js` describes staged objects *from the camera about to shoot them* — "DRAGON in the near foreground at frame left, with its back to camera" — and deliberately says nothing about unnamed objects. |
| 6 | Direction and speed | **Built.** Eighteen movements with declared units and default amounts; `legTimings` reports pace in the movement's own unit (m/s for a dolly, deg/s for a pan). |
| 4 | Concrete motion, not interpretation | **Partly.** `lib/prompt-lint.js` catches language a model cannot honour (*off frame*, *we never see*), which is the negative half. Nothing pushes "terrified" → "shoulders tense, eyes fixed". |

**Genuinely missing:** the interpretation→concrete rewrite (4), end-state
constraints as an internal field (8), and temporal progression (7) — on which
the proposal's own caution is correct and should be kept: do not micromanage
seconds unless a given model demonstrably rewards it.

---

## Where the proposal collides with this codebase

### 1. "Complexity score" is already taken, and means something else

`lib/screenplay-timing.js` exports `scoreComplexity` and nine
`COMPLEXITY_FACTORS`: night exterior, stunt, effect, vehicle, crowd, animal,
child, water, height — with a low/medium/high verdict.

Those are **live-action shooting hazards**. A crowd is hard to *film* and
trivial to *generate*; a slow push-in on one subject is easy to film and, over
ten seconds, is exactly where a generative model drifts. **Zero of the nine
overlap with generative adherence.**

Two things called complexity, scored differently, on the same shot, is how they
come to disagree in front of a director. Either name is fine; using the same
one twice is not. *Adherence risk* is the honest name for the new axis.

The **pattern** is worth stealing wholesale, though: each factor declares a
`probe` — a line of text that must trigger it — and the suite runs every probe
through the real estimator, because "a factor no text can ever fire looks like
coverage and provides none."

### 2. A score that predicts adherence is a router, and this codebase already refused to build one on no data

This is the strongest objection, and it has direct precedent.

`lib/video-attempt.js` and `film_video_attempts` were built to record every
generation's shape alongside its outcome. The router that would use them was
**deliberately not built**, and CLAUDE.md says why:

> The router is deliberately **not** built: one tuned on no acceptance data is
> a guess with extra steps. Recording the shot's shape alongside the outcome is
> what makes the next ten shots of the actual film into the benchmark.

An AI Shot Complexity Score that says *"estimated low adherence"* is that
router wearing a different hat. Where does the estimate come from? Today: no
labelled failures, no per-model acceptance rates, five clips ever generated
through the engine.

This does not kill the idea. It sets its **order**:

- **Now:** count what is countable and say only that. "This shot names 4
  character actions, 2 environmental interactions and a compound camera move"
  is a *description*, defensible from the scene card alone, with no prediction
  in it.
- **Later:** once `film_video_attempts` holds real accepted/rejected outcomes,
  turn counts into a prediction — and only then use the word "adherence".

A warning that predicts on no evidence is the kind of warning directors learn to
dismiss, and this codebase has been burned by exactly that: *"a warning you
cannot act on is one you learn to ignore"* was written after a staleness banner
sat permanently on a healthy board.

### 3. Auto-splitting fights the shot-code convention

"Recommended split: 3 shots" must stay a **recommendation**. Inserting shots is
already solved and deliberately additive — `2AA`, never a renumber — because
shot codes are filenames in thirteen places, rows in the render ledger, and the
word a director has used all day. An automatic split that manufactures 2B-1,
2B-2, 2B-3 would either collide with that convention or silently invent a
fourth naming scheme.

The right shape: the engine *proposes* the split and the director accepts it
through the existing insert path, so codes, ordering and files stay consistent
with everything else.

### 4. "More detail is not more accurate" contradicts the direction of travel

The proposal's correction is right and this codebase has the receipts. A real
anchored shot once sent **3,990 characters against a 4,000 ceiling, 2,517 of
them re-describing a cul-de-sac plainly visible in the attached frame.** The fix
was to *stop saying* what the picture already showed.

But note the counterweight, also learned expensively: an allowance is a rule for
deciding what to cut **when something must be cut**, not a target to shrink every
field to. A motion prompt was capped at 500 against a 1,000 limit for no reason.

So "start simple, add one control at a time" cannot be implemented as a smaller
cap. It has to be implemented as **ordering** — which is exactly what the
compiler is for, and what `fitAdditions` and the motion trim already do: when it
does not fit, the atmosphere note goes first and the subject goes last.

### 5. Decomposition already exists — of the wrong axis

Two mechanisms already split work:

- **`lib/video-sequence.js`** — N shots become N−1 segments between approved
  frames.
- **In-between strips** — one shot becomes a strip of stations, each refined
  from the one before, because "seconds two, three and four are the model's
  opinion, and the model's opinion is what drifts."

Both decompose **a move through time**. The proposal decomposes **a shot into
separate actions**, which is a different axis and is genuinely not built.

And there is a counter-example worth confronting: Runway's `generate-native`
multi-shot recipe produces 3–5 real editorial cuts in one generation, and this
codebase labels it *"clearly labelled less deterministic than per-shot
rendering."* That is the same judgement the proposal reaches from the other
direction — which is mild evidence the proposal is right.

---

## Open questions the plan must answer

1. **What is the compiler's contract?** A declared adapter property with a
   fallback, or a shared builder each adapter parameterises? The first matches
   `promptLimit` / `referenceMode` / `maxKeyframes`; the second risks one
   builder that is subtly wrong everywhere.
2. **Where does the structured representation live?** It exists on the payload
   today. Does it become a stored shot field (a schema change, staleness
   implications, a fingerprint change that marks every existing frame behind),
   or stay derived? *Derived is cheaper and does not disturb 76 existing
   keyframes.*
3. **Does the score gate, or only inform?** Everything else that refuses in this
   engine — budget, board lock, stale inputs, previs approval — refuses with a
   named code and an explicit override. A score with no override becomes the
   thing people switch off.
4. **What is the denominator for the test?** The other adapters' compilers, or
   the risk factors, or both. A per-provider compiler tested on Runway alone is
   the exact partial-coverage failure this project keeps paying for.
5. **Is `end state` sayable at all without previs?** The proposal wants
   start/movement/end held internally. Previs already solves camera end-state;
   *subject* end-state has no home in the scene card today.

---

## Recommendation for Phase 2

**Split the feature.** They are not one thing and their evidence is not equally
good:

- **A. Generalise the compiler.** Justified today on ceilings alone (1,000 vs
  16,000), proven by an existing implementation, no new prediction required.
  This is the safe, high-value half.
- **B. Adherence risk as description, not prediction.** Count the countable —
  independent actions, environmental interactions, compound camera moves,
  duration — and *say what is in the shot* without forecasting a failure rate.
  Recommend a split; never perform one.
- **C. Adherence as prediction — defer**, explicitly, until
  `film_video_attempts` holds real outcomes. Name it in the plan as deferred
  rather than dropping it, so it is work rather than an idea nobody finds again.

The proposal's own rule — *reduce generative entropy before increasing prompt
detail* — argues for exactly this order.
