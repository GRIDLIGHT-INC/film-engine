# Office hours — shot complexity and provider-specific prompt compilation

Six forcing questions, answered from the install rather than from the proposal.
Every number below was read out of the working library or the code; where a
figure could not be trusted it is named as untrusted rather than quoted.

---

## Q1 — DEMAND REALITY: who specifically wants this, and how do we know?

**The director of this engine, and the evidence is behaviour rather than a
request.**

The ask arrived as a written proposal, which is the weakest form of demand. The
strong evidence is in the library:

| | |
|---|---|
| storyboard frames stored | **134** |
| shots | **70** |
| frames per shot | **1.9 average** |
| worst single shot (2B) | **28 frames** |
| image calls metered | **174** |
| video calls through the engine, ever | **3** |

A director who re-rolls one shot twenty-eight times is not asking for a feature;
they are already paying the cost the feature claims to remove.

**But the demand splits, and the two halves are not equally evidenced.**
Demand for *fewer wasted generations* is proven. Demand for a *predictor* is
inferred — nobody asked for a score, they asked for shots that work. A score is
one hypothesis about how to get there.

The compiler half has separate and better evidence, which does not depend on
anyone's opinion: Runway's prompt ceiling is **1,000** characters and Seedance's
is **16,000**. One prompt shape cannot serve a sixteen-fold difference in budget.
That is demand from the providers, not from a person.

---

## Q2 — STATUS QUO: what are people doing right now, and why is it not enough?

Today the loop is: compose a scene card → read `GET /shots/:id/prompt`, which is
free and shows the assembled prompt, the ceiling, the headroom and every
contributor → generate → look → re-roll.

That free preview is genuinely good and is why this is not a greenfield problem.
It answers **"what will be sent?"** completely.

It does not answer **"will this work?"** — and it cannot, because it shows a
string, not the shape of the shot. Nothing anywhere counts how many independent
actions a card asks for. A card naming a dragon flying, a house exploding, a
character reacting and a camera circling produces a perfectly well-formed
prompt, inside its ceiling, with full headroom, and reads as healthy.

Twenty-eight frames on 2B is what "not enough" looks like in practice.

**On video specifically the status quo is barely a status quo at all.** Three
video calls have ever been metered through this engine, and of the five clips in
the library two were made by hand on Runway's website and three came through the
sequence path. There is no established video workflow to improve — which cuts
both ways, and Q5 takes it up.

---

## Q3 — DESPERATE SPECIFICITY: the one person most desperate for this

**The director, on Wingfall shot 2B, on the afternoon it cost twenty-eight
frames.**

The exact situation, reconstructed from the library and the engineering record:

- The card names the **DRAGON**, **MAYA**, a **sedan**, a **grocery bag** and a
  **suburban street** — five subjects competing for three reference slots on
  Runway, so two plates were silently dropped before the request was built.
- The action includes a **struck house described in detail and then declared
  "just off frame"** — language a diffusion model cannot honour, because it
  draws what you name.
- The card also says **"We never see its face"**, and an attempt drew the face.
- With an anchor attached, the assembled prompt reached **3,990 characters
  against a 4,000 ceiling**, of which **2,517 re-described a cul-de-sac plainly
  visible in the attached frame**.

Every one of those causes was **visible before a credit was spent**. None of
them is a prompt-wording problem and none would be caught by a
"detail improves accuracy" instinct. Two are *too much* rather than too little.

That is the person. Not someone who needs better adjectives — someone who needs
to be told *this shot is asking for four things at once and two of your plates
are not going.*

---

## Q4 — NARROWEST WEDGE: the smallest version that still delivers real value

**Not the score. The wedge is a readout and a wire.**

Three things, none of which predicts anything:

1. **Generalise the compiler as an adapter property.** `buildRunwayMotionPrompt`
   already compiles subject → environment → camera for one provider. Make that a
   declared adapter capability with a visible fallback, matching how
   `promptLimit`, `referenceMode`, `maxKeyframes` and `maxReferenceImages`
   already work. Value on day one: Seedance stops being handed a prompt shaped
   for a 1,000-character ceiling when it has 16,000.

2. **Say the shape of the shot in the existing free preview.** Count what is
   countable from the scene card — independent subject actions, environmental
   interactions, named subjects versus available reference slots, whether the
   camera move is compound, requested duration. Report it as *description*:
   *"4 actions · 2 environment · 5 subjects for 3 slots · compound camera ·
   10s."* No forecast, no percentage, no recommendation to split.

3. **Wire the three video paths that record nothing.** `recordVideoAttempt` is
   called by `routes/video-gen.js` and by nothing else — `sequences.js`,
   `pipeline.js` and the flows `generate.js` node handler each record zero. That
   is why `film_video_attempts` holds **0 rows** after five clips.

Item 3 is the smallest of the three and the most consequential, because it is
the precondition for ever doing the interesting half honestly.

**Why the readout alone is worth shipping:** on 2B it would have said *5
subjects for 3 slots* before the first generation. That single line addresses
the specific cause of the specific disaster in Q3.

---

## Q5 — OBSERVATION: have we watched someone try this? What happened?

**Yes for images, and the record is unambiguous. Almost not at all for video,
and that is the finding.**

*Images.* 2B: twenty-eight frames. 2A: eleven. 2AA: nine. 174 metered image
calls against 134 stored frames. The re-roll behaviour this feature exists to
reduce is observed, repeatedly, on a real production.

*Video.* Three metered video calls, ever. Five clips, two of them made outside
the engine entirely, and **all five carry an empty
`provider` and `provider_model` — stored as `""`, not NULL** — so even the
footage that exists cannot say which model produced it. (Empty rather than
NULL matters only to a query; to a director it is the same blank.)

The honest consequence: **any adherence model for video would be fitted to an
observation set of approximately zero.** Not a small set — a set that has never
been collected, on paths that were never wired to collect it.

That is not an argument against the idea. It is an argument about order, and it
is the same conclusion the codebase already reached once when it built
`film_video_attempts` and deliberately did *not* build the router on top of it.

---

## Q6 — FUTURE FIT: in two years, more or less relevant?

**The three halves diverge, and this is the strongest reason to split them.**

**Prompt compilation → more relevant.** The provider set is growing and its
formats are diverging, not converging. The ceiling spread is already 16×; MuAPI
routes several models behind one endpoint with per-workflow field names; Runway
takes two keyframes and Seedance thirty. Every new provider makes a
per-provider compiler more valuable and a generic prompt worse. This is a safe
two-year bet.

**Adherence prediction → less relevant.** It is a bet *against* model progress.
Every capability increase in long, multi-action generation erodes the model
that predicts failure, and a stale predictor is worse than none because it warns
about shots that now work. If built, it must be fitted to recorded outcomes and
refitted — never hand-tuned constants that quietly rot.

**Decomposition as craft → unchanged.** "One clear primary action per shot" is
not a workaround for a model limitation; it is how films are cut. That stays
true whatever the models do, which is exactly why it should be offered as a
*suggestion a director accepts* rather than an automatic behaviour the engine
performs.

---

## Implementation approaches

### A. Compile and Count
**One sentence.** Make the prompt compiler a declared adapter property, add a
descriptive shot-shape line to the existing free preview, and wire the three
video paths that currently record no attempts.
**Effort: M.**
**Key assumption.** Describing a shot's shape changes a director's behaviour
before they spend, without any prediction attached — the same way the free
prompt preview already does.
**Biggest risk.** The readout is ignored because it sits in a preview people
skip; it must appear where the money is spent, on the pre-spend confirmation,
not only in the prompt panel.

### B. Adherence Oracle
**One sentence.** Score every shot for predicted adherence and recommend
concrete splits before generation.
**Effort: L.**
**Key assumption.** Adherence is predictable from a scene card without outcome
data — or that enough outcome data can be gathered quickly.
**Biggest risk.** It predicts on nothing. `film_video_attempts` has 0 rows,
three of four video paths record nothing, and no clip in the library records
which model made it. A confident wrong warning trains directors to dismiss the
whole class of warning, which this codebase has already paid for once.

### C. Provider Contract Only
**One sentence.** Generalise the compiler and stop there.
**Effort: S.**
**Key assumption.** Better-shaped, provider-appropriate prompts are enough to
move the re-roll rate.
**Biggest risk.** It leaves the observed pain untouched. Not one of the four
causes behind 2B's twenty-eight frames is a prompt-shape problem — they were
dropped plates, unhonourable language, and a prompt spending 2,517 characters
re-describing an attached picture. C would have changed none of them.

---

## Recommended Approach

**A — Compile and Count**: it is the only option that both ships something
provider-evidenced on day one (the 16× ceiling gap) and addresses the actual
observed failure (5 subjects for 3 slots on 2B), while making B *possible* later
by wiring the recording that B would need. C is too narrow to touch the
reported pain; B cannot be built honestly on 0 rows.

The ordering matters as much as the choice, and it is the proposal's own rule
applied to itself — *reduce generative entropy before increasing prompt detail*:
count the shot before compiling the prompt, and record the outcome before
predicting one.

## Key Assumptions

- A description with no prediction still changes behaviour — supported by the
  existing free prompt preview, which is used and carries no forecast.
- Counting actions and subjects from a scene card is reliable enough to be worth
  showing; it is arithmetic over declared fields, not interpretation.
- The compiler contract can be added the way every other provider contract was
  (`promptLimit`, `referenceMode`, `maxKeyframes`) without a schema change.
- The structured motion representation stays **derived**, not stored — storing
  it would change fingerprints and mark existing keyframes stale for a change
  no prompt reads.
- Recording attempts on the three unwired paths is small and independent, and
  its value does not depend on B ever being built.
- Any split stays a **recommendation** routed through the existing additive
  insert path (`2AA`), because shot codes are filenames in thirteen places.

## Estimated Effort: M
