# Redoing the video between two frames — research

Date: 2026-09-05
Question: take two shots already generated, pick a frame in each, and regenerate
the video between them. Or pick two frames inside ONE shot and redo just that
part. To fix a fault without re-rolling the whole clip.

---

## The short answer

**Both cases are the same operation** — generate between two stills — and Film
Engine already does it for storyboard keyframes. What is missing is not the
generation. It is:

1. taking the two stills **out of existing footage** at chosen timestamps,
2. putting the result **back into the middle** of a clip, and
3. a surface to **mark in and out** while watching.

## Web findings

### Which providers take a start AND an end frame

| provider | how | note |
|---|---|---|
| **Seedance 2.5 (MuAPI)** — ours | `seedance-2.5-first-last-frame`, `images_list` ordered `[start, end]` | verified live, below |
| Kling | `image` + `image_tail` | start/end named separately |
| Luma Ray3.2 | `keyframes` `frame0`/`frame1`, up to **16** keyframes | most frame-level control found |
| Runway | `promptImage: [{uri, position: "first"\|"last"}]` | positions must be unique, and first/last is **mutually exclusive with image references** |

- Kling/Luma/Runway comparison — https://www.atlascloud.ai/blog/guides/kling-ai-vs-runway-vs-luma
- Chaining clips by first/last frame, practitioner account — https://medium.com/@shrutisaagar13/first-frame-last-frame-how-i-chain-ai-clips-into-one-continuous-shot-e6649434e689
- Runway API positions — https://docs.dev.runwayml.com/api-details/versions/2024-11-06/

### Interpolation is NOT the same tool, and this is the trade that matters

Frame interpolation (RIFE, FILM, AMT, LDMVFI, VIDIM) synthesises intermediate
frames between two real ones. It is cheap, local and deterministic — and it can
only **smooth**. It cannot change what happens, so it cannot fix a shot where
the wrong thing happened, which is the stated use case.

Worth knowing if we ever do use it: **RIFE has the best FID and the WORST FVD
and temporal consistency** of the compared methods — i.e. individual frames look
right while the motion reads wrong. Judging an interpolator on stills is
therefore actively misleading.

- Video Interpolation with Diffusion Models — https://arxiv.org/html/2404.01203v1
- RIFE (ECCV 2022) — https://www.ecva.net/papers/eccv_2022/papers_ECCV/papers/136740608.pdf
- Spatiotemporal consistency survey — https://arxiv.org/pdf/2502.17863
- Frame interpolation primer — https://morphic.com/ai-glossary/frame-interpolation

### Splicing a regenerated piece back in

The practitioner consensus is that the splice is where this fails, not the
generation:

- **Both pieces must share model, resolution, length and codec parameters** or
  the join is visible.
- Lossless trim with `-frames:v N -c copy`, then a concat list.
- Replacing a middle section on a variable-frame-rate source needs timestamp
  capture and an `overlay` with `-itsoffset`; constant frame rate is far easier.

- Seamless AI video loops — https://ffmpeg.party/guides/ai-video-loop/
- Replacing frames with ffmpeg — https://www.research-lab.ca/2022/05/using-ffmpeg-to-replace-video-frames/
- Slice and splice programmatically — https://osric.com/chris/accidental-developer/2012/04/using-ffmpeg-to-programmatically-slice-and-splice-video/
- The editorial term for this is a **substitution splice** — https://en.wikipedia.org/wiki/Substitution_splice

### Seedance 2.5's own editing workflows

MuAPI's page lists six workflows: text-to-video, image-to-video,
**first-last-frame**, omni-reference, **video-edit (V2V)**, **video-extend (V2V)**.

**Video-edit and video-extend document no time range, no segment selection and
no trim parameter** — "a source clip plus a text instruction". So there is no
provider-side "redo seconds 3 to 6"; the in/out logic is ours.

- https://muapi.ai/seedance-2.5
- https://picsart.com/api-platform/models/seedance-2.5-video-edit

### Verified live against MuAPI (validation refuses before billing, so free)

Probed with an empty body to read the required set, and with wrong types to read
the accepted set:

```
seedance-2.5-video-edit        required: prompt, video_url
                               also accepts: images_list, duration
seedance-2.5-video-extend      required: prompt, video_url
seedance-2.5-first-last-frame  required: prompt, images_list
                               also accepts: duration
```

Two things follow. **`video-edit` accepts `images_list` and our adapter never
sends it** (`images: []` in `buildVideoEditRequest`) — an unexplored control.
And FastAPI ignores unknown fields, so a probe **cannot prove the absence** of a
time-range parameter; the vendor page not documenting one is the evidence, and
it is weaker than a refusal. Stated rather than glossed.

## Local findings

Everything needed exists except the trim and the surface.

| piece | where | state |
|---|---|---|
| Generate between two approved stills | `backend/lib/video-sequence.js` | **shipped** — N shots → N−1 segments, each pinned to a first and last frame |
| Densify one shot into stations | `backend/lib/inbetweens.js`, `inbetween-run.js` | **shipped** — a shot as a strip, each station refined from the one before |
| First/last frame at the provider | `backend/lib/providers/seedance.js` — `WORKFLOWS['first-last-frame'] = { images: 2 }`, `IMAGE_FIELD` → `images_list`, ordered | **shipped** |
| Extract a frame at a timestamp | `routes/characters.js:1236` (`-ss <t> -i clip -frames:v 1`), `lib/review-proxy.js:85`, `lib/mcp-tools.js:3627` (`shot_review`) | **shipped, three times** |
| Join whole clips | `lib/ffmpeg.js` `buildConcatArgs` / `stitchClips` | **shipped** |
| **Trim / cut a range out of a clip** | — | **MISSING**. `atrim` appears only to pad silent audio |
| Scrub a clip in playback | `src/index.html` `#pbScrub`, `pbSeekFromClick` | **shipped** — single playhead only |
| **Mark in / mark out, across two clips** | — | **MISSING** |

## Key ideas and themes

1. **One mechanism, two framings.** "Between two shots" and "inside one shot"
   are both *generate between two stills*. Treating them as one operation is
   what stops this becoming two half-built features.

2. **The provider will not help with the range.** Seedance edits a whole clip
   from a prompt. Trim, generate, splice is ours, and the splice is the risky
   part — not the generation.

3. **There is a HARD FLOOR of 4 seconds** (`MIN_DURATION = 4` in the adapter,
   `MAX_DURATION = 30`). A two-second fault **cannot be regenerated at its own
   length**. Either the marks widen to 4s, or 4s is generated and trimmed back —
   and the second option pays for footage it throws away. This is the single
   most consequential constraint found, and it is invisible until someone marks
   a short range and gets a refusal.

4. **Cost is per second and steep.** 480p $0.17/s, 1080p $0.85/s, 4K $1.70/s. A
   minimum fix is $0.68 at draft and $3.40 at 1080p. The existing draft-then-
   finish doctrine applies directly: mark and re-roll at 480p, finish once.

5. **The endpoints must match or the seam shows.** Same model, resolution and
   frame rate as the source clip. Film Engine already stores the model and
   resolution per generation, so the re-roll can inherit them rather than being
   asked for.

6. **Interpolation is a different tool.** It smooths; it cannot fix. And it is
   judged wrongly by looking at stills.

7. **The frames must come from the CUT, not the card.** Every existing path
   starts from a storyboard keyframe. This one starts from a timestamp in
   footage the director is watching — which is why it belongs in playback.

8. **`video-edit` taking `images_list` is unexplored** and may be a shorter road
   for "fix this part": a source clip plus reference stills. Worth one probe
   before building the trim-and-splice path.

## What a build would need

- `lib/ffmpeg.js`: a trim/segment builder beside `buildConcatArgs`, and a
  substitution-splice helper (`head + new + tail`) that re-encodes consistently.
- Frame extraction promoted from three call sites to one shared helper.
- A playback surface: mark in, mark out, across one clip or two, showing the
  4-second floor and the projected cost **before** spending.
- The re-roll inherits the source clip's model, resolution and fps.
- A refusal when the marked range is under the floor, naming both remedies.
