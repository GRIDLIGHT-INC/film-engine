# Research Brief: Redoing the video between two chosen frames

Date: 2026-09-05
Source research: `docs/plans/redo-between-frames-research.md`
Provider: Seedance 2.5 via MuAPI (Runway is not in use)

---

## Executive Summary

Taking two frames — one in each of two clips, or two inside a single clip — and
regenerating the video between them is **one operation, and Film Engine already
performs it**: `lib/video-sequence.js` generates between two approved stills and
`lib/inbetweens.js` densifies a shot into stations. What does not exist is
taking those stills out of *finished footage* at a chosen timestamp, putting the
result *back into the middle* of a clip, and a place to mark in and out while
watching.

The provider will not help with the range. Verified live: Seedance's `video-edit`
and `video-extend` take a whole clip plus a text instruction and document **no
time-range parameter**, so trim-and-splice is ours. The constraint that decides
the design is a **4-second minimum generation** — a two-second fault cannot be
regenerated at its own length, and nothing in the product says so today.

---

## Key Themes

- **One mechanism, two framings.** Across-clips and within-a-clip are both
  *generate between two stills*. Building them as two features is how one ends
  up with a fix the other lacks.
- **The generation is solved; the plumbing is not.** Four of six needed
  capabilities are shipped. The two missing are a trim helper and a marking
  surface — neither of which involves a model.
- **The seam is the risk, not the generation.** Practitioner accounts agree the
  failure mode is a visible join: mismatched model, resolution, frame rate or
  codec. Film Engine already records model and resolution per generation, so the
  re-roll can inherit them rather than ask.
- **Interpolation is a different tool.** RIFE/FILM smooth motion between two real
  frames; they cannot change what happens, so they cannot fix a shot where the
  wrong thing happened. Worth knowing: RIFE scores best on per-frame fidelity and
  *worst* on temporal consistency — judging an interpolator on stills misleads.
- **Cost is per second and steep** — $0.17/s at 480p, $0.34 at 720p, $0.85 at
  1080p, $1.70 at 4K. With the 4-second floor, the cheapest possible fix is
  **$0.68**, and the same fix at 1080p is **$3.40**. That makes the existing
  draft-then-finish doctrine apply directly rather than as an analogy: mark and
  re-roll at 480p until the motion is right, finish once.

---

## Top Ideas & Opportunities

1. **Extract-mark-regenerate-splice, as one path.**
   *What:* mark an in-point and an out-point (same clip or across two), pull
   those two frames with ffmpeg, send them as `images_list` to
   `seedance-2.5-first-last-frame`, and substitute the result back.
   *Why:* it reuses the generator, the adapter and the extraction that already
   exist; only the trim and the surface are new.
   *Apply:* one route and one planner, mirroring `lib/video-sequence.js`'s split
   of pure planning from paid execution.

2. **Surface the 4-second floor at the moment of marking.**
   *What:* the marking UI shows the floor and refuses a shorter range, naming
   both remedies — widen the marks, or generate 4s and trim back.
   *Why:* this is the single constraint most likely to waste money or read as a
   broken feature, and it is invisible until a request is refused.
   *Apply:* the same shape as the existing pre-spend confirmation.

3. **Inherit the source clip's model, resolution and frame rate.**
   *What:* the re-roll is generated with the parameters the original was.
   *Why:* the documented cause of a visible seam. It is also free — the values
   are already stored per generation.
   *Apply:* read them from the asset row rather than adding controls.

4. **Probe `video-edit`'s `images_list` before building the splice.**
   *What:* `video-edit` requires `prompt` + `video_url` and **also accepts
   `images_list`**, which our adapter never sends (`images: []`).
   *Why:* if those images acted as keyframes, the provider would do the
   substitution itself and a whole class of trim-and-splice work would disappear.
   *Apply:* **done — RBF-001, 2026-09-05. They are style references.** Both
   stills were composited into the scene at once, for the whole clip. The class
   of work does not disappear: **the splice is ours**. It remained the highest
   information-per-dollar experiment available even so, because it was the only
   thing that could have removed two of the three largest tasks in the plan.

5. **Promote frame extraction to one helper.**
   *What:* `-ss <t> -i clip -frames:v 1` exists in three places
   (`routes/characters.js`, `lib/review-proxy.js`, `lib/mcp-tools.js`).
   *Why:* three copies is how one acquires a fix the others do not — the pattern
   this codebase has paid for repeatedly.

6. **Reuse the station model rather than inventing a range type.**
   *What:* `lib/inbetweens.js` already expresses a shot as ordered stations with
   instructions and approval.
   *Why:* a marked in/out is two stations. Reusing it inherits approval,
   staleness and the chain semantics instead of re-deriving them.

---

## Technical Approaches

**A · First/last frame, then substitution splice** *(recommended)*
```
extract  ffmpeg -ss <in>  -i clipA -frames:v 1  in.png
         ffmpeg -ss <out> -i clipB -frames:v 1  out.png
generate POST /seedance-2.5-first-last-frame  { prompt, images_list:[in,out], duration }
splice   head = clipA[0 .. in]   +   new   +   tail = clipB[out .. end]
```
Ordered `images_list` — `[0]` is the frame it starts on, `[1]` the frame it ends
on. Reversed, the move runs backwards and reads as a generation fault.

**B · `video-edit` with images** *(tested and rejected — RBF-001)*
`{ prompt, video_url, images_list, duration }`. The images are **style
references**, not keyframes: sent a solid red START card and a solid blue END
card, the output opened and closed on the source scene with **both cards
composited into it**. The provider does not substitute internally, so approach
A's splice is required. Three further findings came out of the same probe:
`images_list` refuses data URIs and needs fetchable http(s) URLs; the source
must be at least ≈854×480; and `duration` is ignored while billing follows the
**source** clip's length — a failed request billed too.

**C · Interpolation (RIFE/FILM)** *(rejected for this use case)*
Cheap and local, but only smooths. Cannot fix content. Useful later for frame
rate, not for this.

**Splice mechanics.** Trim losslessly with `-frames:v N -c copy` where possible,
build a concat list, and keep codec parameters identical across the three pieces.
Constant frame rate is materially easier than variable; a VFR source needs
timestamp capture and an `overlay` with `-itsoffset`.

---

## Open Questions

1. ~~**Does `video-edit`'s `images_list` act as keyframes or as style
   references?**~~ **Answered — RBF-001, 2026-09-05: style references.**
   Approach B does not remove the splice; **the splice is ours**. Evidence and
   spend: `docs/plans/rbf-001-video-edit-probe.md`.
2. **Is there an undocumented time-range parameter?** Cannot be proven either
   way by probing: FastAPI ignores unknown fields, so an unknown key is silently
   dropped rather than refused. The vendor page documents none, which is weaker
   evidence than a refusal.
3. **Under the 4-second floor — widen or trim?** A product decision. Widening
   changes what the director marked; trimming pays for discarded footage.
4. **Does a re-rolled middle need colour matching to its neighbours?** Unknown
   until measured on real footage. `post/color-match` already exists if so.
5. **Where does the marked range live?** A new table, or two stations on the
   existing sequence model. Affects approval and staleness for free, or not.

---

## Recommended Direction

**Run the `video-edit` probe first (idea 4), then build approach A.**

The probe costs one 480p generation — roughly $0.68 at the 4-second floor — and
it can eliminate the riskiest part of the work. The splice is where practitioners
report this failing, so an hour spent finding out whether we need to do it at all
is the best-value hour available.

Then build approach A regardless of the outcome, because it is the general case:
across two clips there is no single `video_url` for `video-edit` to operate on,
so the first/last-frame path is required for half the stated requirement even if
the probe succeeds.

Build order:
1. Probe `video-edit` + `images_list` (one generation, 480p).
2. Shared frame-extraction helper; `buildTrimArgs` and a substitution-splice
   helper beside `buildConcatArgs` in `lib/ffmpeg.js`.
3. A pure planner — marks in, plan and projected cost out, spending nothing —
   mirroring `lib/video-sequence.js`.
4. Playback marking, showing the floor and the cost before spending.
5. Inherit model/resolution/fps from the source asset.

**What would have changed this:** if the probe had shown `video-edit` accepting
and honouring keyframes, steps 2 and 3 would have shrunk to the cross-clip case
only. **It did not — RBF-001 returned `style-references`, so the direction below
stands unchanged and nothing shrinks.** In the epic's terms, **RBF-004 and
RBF-006 do not shrink**; both are needed in full for the within-a-clip case as
well. The probe also added work rather than removing it: frames must be exposed
at a URL the provider can fetch, which is now RBF-011.
