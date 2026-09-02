# Provider integration fixes

Five defects found while wiring MuAPI images and shooting the DRIVE-IN ident on
31 Aug 2026. Each one is stated with the evidence that produced it, because
three of the five present as something other than what they are.

Ordered by what costs the most when it goes wrong.

---

## 1. Async generations are abandoned by the host, not by the provider

**BLOCKING for the whole video stage.**

`lib/providers/seedance.js` polls for up to **fifteen minutes**:

```js
const POLL_TIMEOUT_MS = Number(process.env.SEEDANCE_POLL_TIMEOUT_MS || 900000);
```

A tool call through the MCP host is abandoned at **sixty seconds**. Any
generation still polling at that moment is not slow — it is LOST. The handler is
torn down mid-await, nothing is written to `film_assets`, and the caller is told:

```
Device 'mannys-mac-pro-local' did not respond within 60s.
```

Which reads like a connection fault. It is not. The provider very likely
finished the job and billed for it; the result had nowhere to be delivered.

Observed live: a MuAPI image generation with a 300s poll budget produced no
frame and no error after five minutes. The same shape applies to seedance video
at 480p and is far more expensive there — a 15s sequence clip is real money to
generate twice because the first result was thrown away.

**The fix is a job handle, not a longer timeout.** No poll budget can be both
longer than a 4K video render and shorter than the host's abort.

- POST the generation, persist `request_id` against the shot/scene with a
  `pending` asset row, and RETURN IMMEDIATELY.
- A second tool — `generation_collect` or similar — polls for a finished job and
  writes the asset when it lands.
- A generation whose handle is stored is never lost: the process can die, the
  host can abort, and the result is still collectable.

The `flow_run` / `flow_run_get` pair is the precedent already in this codebase
for a long job addressed by an id rather than held open on one call.

Until that exists, any adapter polling inline MUST keep its budget under the
host window. `muapi-image.js` is set to 48s for this reason and says so.

---

## 2. MuAPI rejects base64 reference images

`lib/providers/muapi-image.js` is written and works — the slug is right, the key
resolves, the body validates — except for reference images. MuAPI's validator:

```json
{"type":"url_too_long","loc":["body","images_list",0],
 "msg":"URL should have at most 2083 characters",
 "input":"data:image/jpeg;base64,/9j/4AAQ…"}
```

Two facts in one error: the field is **`images_list`**, not `image_urls`, and
the value must be a **fetchable URL** under 2083 characters.

This engine inlines every reference as a base64 data URI. Meshy accepts that;
MuAPI does not. References are not optional — they are the anchor system, which
is the whole mechanism keeping one shot continuous with the last.

**So MuAPI images need somewhere to host a reference**, and it cannot be
`localhost:3100`. Either MuAPI's own upload endpoint, or a short-lived signed
URL. Once that exists the adapter needs one rename and it works.

**Check seedance video for the same defect before queueing a sequence.** Its
dry run shows `init_image: "«image/png, 1360KB inline»"` — the same inlined
base64, to the same vendor that just rejected it. One cheap 480p clip answers
it. If it fails identically, reference hosting is a prerequisite for ALL video,
not a MuAPI-images nicety.

---

## 3. `prop_create` and `character_create` silently drop dimensions

`prop_create` accepted `height_m`, `width_m`, `length_m` and stored all three as
`null`. `prop_update` with the identical values persisted them correctly, so the
defect is in the create path only. `character_create` drops `height_m` the same
way.

Not cosmetic. The dimensions are what produce the scale clause in an image
prompt:

```
Scale: DRIVE-IN SPEAKER POST is roughly 1.7 times the size of a car tyre,
1.1m tall, 0.12m long, 0.55m wide
```

A subject created and never updated generates at whatever size the model
imagines, and nothing reports it. The tool description says these are "required
in practice" — which is true, and they were being thrown away.

---

## 4. A missing provider pin reroutes spend to another vendor in silence

`film_projects.provider_config` lost its `"image"` key mid-session. Nothing
failed and nothing was reported. Image generation fell through the resolution
order onto **Google**, billed against a personal Gemini key rather than the
Meshy account the project was configured for — discovered only when Google's
billing rejected it.

`resolveIdWithReason` already carries a `source` for exactly this
(`project` / `env` / `account_default` / `quality_tier` / preference walk). It
is computed and then discarded.

**Surface it.** When a generation resolves through anything other than an
explicit project pin, say so on the result and in the run plan: *"image →
google (account default; this project pins no image provider)."* The engine's
own comment predicted this failure and it happened anyway:

> the picker said every tier used Meshy while the project resolved to OpenAI,
> and both were telling the truth about different code.

`dry_run` reports the truth and costs nothing. Consider calling it as a
preflight on any batch that spends.

---

## 5. No runtime failover between configured providers

The ordered preference walk in `PREFERRED_WHEN_CONFIGURED` runs only when
nothing is pinned. Once an adapter is chosen it is chosen: a 429, a billing
rejection or a vendor outage fails the generation outright even when two other
credentialed adapters could serve it.

An afternoon was lost to one vendor's billing bug while two working image
providers sat in the registry.

For a studio billing clients per creative, a vendor outage should cost a
retry, not a job. Failover belongs in the same `resolve` path, on errors that
are clearly the provider's rather than the request's — 401, 402, 429, 5xx —
and never on a 400, which would just send a malformed request twice.

---

## Already fixed in the working tree, uncommitted

- `lib/providers/google-image.js` — `response_format.mime_type` was hard-coded
  `image/png`; Google now accepts only `image/jpeg`, so every image through that
  adapter 502'd. One word.
- `lib/providers/muapi-image.js` — new adapter, plus `muapi:image` in
  `lib/provider-pricing.js` and `muapi` in the image preference walk. Correct
  apart from item 2 above.

---

## Round 2 — the money left and the file was never filed

Found while generating the first leg of the DRIVE-IN ident. One clip was
rendered and billed at MuAPI and never reached the engine. Five separate
defects had to line up for that, and each one is repeatable.

### 6. The poll read `output` where MuAPI answers `outputs`

`lib/providers/seedance.js` → `awaitResult`

MuAPI documents its result as

```json
{ "id": "...", "status": "completed", "outputs": ["https://cdn.muapi.ai/....mp4"], "cost": {...} }
```

The poll read `data.output`, singular. It saw `status: "completed"`, found
nothing at a key that does not exist, and reported

```
seedance: completed with no video
```

on a clip that had rendered and been charged for. The worst shape of failure
available: the money leaves, the file exists, and the caller is told nothing
was made.

Fixed to accept `outputs` (array), `output` (legacy), and string or object
entries. A completed result with no URL anywhere now names the keys it *did*
receive, so the next mismatch points at itself instead of at the provider.

`awaitResult` is now exported — it was private, which is why a parser both the
live and the collect road depend on had no test.

### 7. A job this engine calls failed is not a job the provider failed

`lib/generation-jobs.js` → `collect`

`collect` refused any handle that was not `pending`. Defect 6 settled the job
as `failed`, so the rendered clip became permanently uncollectable — the only
remaining way to get it was to buy it again.

`failed` here means *this engine gave up*, including when it gave up because of
its own bug. The provider is the authority on its own job and asking is FREE.
Now only `completed` short-circuits; a failed handle is re-polled. If the
provider really did fail, the same failure comes back and nothing changes.

`generation_pending` also reports a `recoverable` list: failed jobs under a
week old that still carry a request id.

### 8. A URL is not bytes

`lib/capability-payloads.js` → `persistCapabilityResult`
`lib/generation-jobs.js` → `collect`
`routes/sequences.js` → the generate loop

Three places passed `result.data` to `persistProviderMedia`. Every MuAPI
adapter answers `{ ok, url }` with no buffer, so all three handed it
`undefined` — and `persistProviderMedia` already knew how to download from a
URL. The sequence route would therefore have thrown on a *successful*
generation too; defect 6 just got there first.

All three now pass the result itself. A buffer still takes the buffer path.

### 9. A recovered clip that nothing can find

`lib/providers/index.js`, `lib/sequence-delivery.js` (new), `routes/sequences.js`

A handle recorded only `{capability: 'video'}`. Collected, it was stored as
`collected_<job>.mp4` — a file on disk that the sequence which bought it cannot
see, because `sequence_plan` looks a leg up by `sequence_id` + `from` + `to` in
the asset metadata.

- `resolve()`'s job wrapper now merges a caller-supplied `opts.jobMeta`, so a
  generation stamps *what it is* on its handle before a byte comes back.
- `lib/sequence-delivery.js` holds the one definition of a leg's filename and
  its asset row. Two definitions is how a recovered leg becomes invisible.
- `generation_collect` takes an optional `belongs_to` for handles recorded
  before the stamp existed.

### 10. The one path that spends per second hardcoded its raster

`routes/sequences.js` → the generate loop

```js
width: 1280, height: 720,
```

A literal, on the only path in the engine billed per second. It bypassed the
draft floor completely — `draftFrameFor` and the `resolution` keyword it
returns live in the capability builder, and this route builds its payload by
hand. A project set to draft still bought **720p at $0.34/s instead of 480p at
$0.17/s. Double, silently, on every leg.** It also ignored the project's
aspect: a 9:16 sequence was generated landscape, which cropping cannot undo.

Now derived by `sequenceFrame(project, provider)` from the project's delivery
raster and the resolved adapter's `defaultModel`, the same two facts a single
shot uses.

### Also

`lib/providers/credentials.js` now requires the database lazily. Importing any
adapter previously imported the whole store, which is why the pure parts of an
adapter — its request builder, its result parser — could not be tested without
one. That is not an inconvenience; defect 6 lived in exactly that untestable
region. Two previously failing `draft-video` tests pass as a result.

`tests/generation-recovery.test.js` covers all of the above.

### 11. The resolution ask never reached the provider, and the plan never priced it

`routes/sequences.js` → `sequenceFrame`, the plan response
`lib/providers/seedance.js` → `resolutionDecision`

Two halves of the same question — *"if I ask for X, do I get X?"* — and before
this the answer was no on both.

**The ask didn't travel.** Seedance resolves its tier from `resolution`, then
`model`, then `target_resolution`. It reads `width`/`height` for **nothing**.
Fixing defect 10 alone would have left a hole: with drafting turned off,
`sequenceFrame` returned a frame and no tier keyword, so a 4K project would
*still* have reached the unsuffixed 720p endpoint by omission. Every road out
of `sequenceFrame` now carries `target_resolution`, and a test walks the
function's return statements to enforce it.

**An ask this provider can't serve was snapped in silence.** Seedance documents
480p, 720p, 1080p and 4K and nothing between. A 2K project (2560×1440) snaps to
1080p — correct, since never rounding up is what keeps a $1.70/s tier off a bill
nobody authorised — but it did so without a word. `resolutionDecision` now
reports the snap and `describeVideoRequest` names both the ask and what will
render.

**The plan quoted nothing.** `estimated_credits` comes from a Runway credit
policy; on a Seedance project `modelPolicy` is null, so it computed **zero** for
a road billed $0.17–$1.70 a second. `sequence_plan` now prices every leg through
the resolved adapter's own `describeVideoRequest`, built from the exact frame the
generate loop will send, and reports `resolution`, per-leg and total
`estimated_usd`, the draft note, and any snap. `sequence_generate` echoes back
the tier the adapter actually billed rather than the one the route asked for.

### 12. Every clip this engine ever bought came back scored

`lib/providers/seedance.js` → `buildVideoRequest`

Seedance 2.5 sets `generate_audio: true` unless told otherwise, and it is not a
subtle default — it synthesises **synced speech, sound effects and a mono music
bed** into the picture. The adapter never sent the field, so every generation
took that default.

Wrong for this engine specifically. Film Engine owns audio: music cues,
ambience, SFX and voice are separate capabilities with a mixer and a conform
stage that targets LUFS. A bed the picture arrives with is a second,
uncommissioned score at a level nobody set, on a track the delivery spec does
not account for. A studio ident with its own orchestral cue is the exact case.

The default is now **inverted** rather than inherited: `generate_audio: false`
is sent explicitly (omitting it is not the same thing), and `audio: true` asks
for the provider's bed back. `describeVideoRequest` reports which, and warns
when it is on.

### 13. `video_draft` had no switch

`routes/projects.js`, `lib/mcp-tools.js` → `project_update`

The column has existed since migration 100 and was writable from **nowhere** —
not the HTTP route, not the SPA, not a tool. It decides whether footage
generates at the model's cheapest tier or at the project's delivery raster:
$0.17/s against $1.70/s on Seedance. A setting that governs the largest
variable cost in the pipeline and cannot be changed is not a default, it is a
lock.

`video_draft` is now writable (boolean in, INTEGER out — the column is
`INTEGER NOT NULL DEFAULT 1` and every reader tests `!project.video_draft`, so
a stored `'false'` string would be truthy), and both it and `target_resolution`
are exposed on `project_update`. Without them the answer to "can I have 2K" was
no, from the agent surface, regardless of what the adapter supported.

### 14. Every video ever bought recorded $0

`lib/providers/index.js`, `lib/generation-jobs.js`

`spend_report` showed **no video spend at all** after two clips had been bought
and billed. Not a rounding problem — structurally zero.

The meter is installed on `resolve()` and fires on a successful **result**. A
generation that outruns the agent host's 60-second window never returns one:
the call comes back `pending`, and the clip is delivered later by
`generation_collect`, which holds the handle, calls the adapter directly, and
runs entirely outside the metering wrapper.

Video is the capability that *always* exceeds that window. So the report was
blind to the single most expensive thing the pipeline does — and for an agency
billing a client from that report, silently under-reporting is worse than not
reporting.

An adapter's `meter()` is a pure function of the payload for anything priced
per second or per call, so the price is knowable at handle time, while the
payload is still in scope. It is now stamped onto the job alongside its leg
identity, and `collect` posts it to the ledger.

No double-billing guard is needed and none was added: a job that succeeded live
is settled `completed` and short-circuits before the spend post. The test pins
that ordering rather than trusting it.

### 15. A swallowed ReferenceError printed a plan with no price

`routes/sequences.js` → `planRoute`

Item 11's pricing shipped inside `try { resolve('video', seqConfig(id, req)) }`
— but `planRoute` is called as `planRoute(res, id, query)` and has no `req`.
The ReferenceError was caught by the guard, `planProvider` came back null, and
the route answered **200 with no price at all**, looking exactly like a plan
that had nothing to quote.

Fixed, and the guard narrowed: a provider that cannot be resolved is a real
state the response already reports, but a `ReferenceError` or `TypeError` is a
bug and now rethrows rather than being disguised as one. A catch that turns a
programmer error into missing output is worse than no catch.

### 16. Asking for silence is not the same as getting it

`lib/provider-media.js` → `persistProviderMedia`, `lib/providers/seedance.js`

Item 12 sent `generate_audio: false`. The clip came back with a 32 kHz stereo
AAC track at −34.7 dB mean, −17.7 dB peak — model-generated speech, effects and
music. **MuAPI ignores the field.**

A flag whose effect cannot be verified is not a control. So the engine no longer
relies on the provider's cooperation: after download, a video is remuxed with
`-map 0:v -c copy -an`. Stream copy, so the picture is bit-identical and it
costs a fraction of a second.

Installed in `persistProviderMedia` — the one funnel every saved video passes
through: the live sequence road, `generation_collect`, and the per-shot
generators alike. Same reasoning the usage meter documents for living on
`resolve()`.

Silence is the default, never an override: `opts.keepAudio`, or an adapter
result carrying `audio: true`, keeps the track. Never throws and never blocks
the save — without ffmpeg the file stays as it arrived, because a clip with an
unwanted track is recoverable and one that failed to save is not.

### Observed on the delivered clip

`sequence_0b8f6c87_1A_1B.mp4` — **HEVC, 1926×1076, 24 fps, 5.04 s.**

Two things to know. The codec is HEVC, not H.264. And the raster is
1926×1076 — Seedance's "1080p" is not 1920×1080, it is six pixels wide and four
short. Not corrected here on purpose: rescaling changes the picture, and this
finishes in Premiere. It belongs in the conform/deliverable stage, against the
project's stated raster, not silently at save time.

---

## The raster inconsistency — traced

Three legs of one sequence came back in two different rasters:

| Leg | Keyframes in | Clip out |
|---|---|---|
| 1A→1B | 1376×768 + 1376×768 | 1926×1076 |
| 1B→1C | 1376×768 + 1920×1080 | 1926×1076 |
| 1C→1D | 1920×1080 + 1920×1080 | **1920×1080** |

Not random, and not a provider being flaky. Three things in a row, each
amplifying the last.

### 17. The engine's 16:9 was not 16:9

`lib/capability-payloads.js` → `dimensionsForAspect`, `imageBudget`

```js
const round8 = n => Math.max(256, Math.round(n / 8) * 8);
return { width: round8(Math.sqrt(targetPixels * ratio)),
         height: round8(Math.sqrt(targetPixels / ratio)) };
```

Each edge is derived from a pixel budget and rounded to a multiple of eight
**independently**. Two independent roundings do not preserve a ratio. A 16:9
project asked for **1368×768 — 1.781:1**. The function named for the aspect
ratio was the thing breaking it.

The same defect appeared a second time in the clamp path, where the comment read
*"scale down on the diagonal so the shape survives exactly"* above two more
`round8` calls. That one also rounded **up**: a 1-megapixel cap produced
1368×768 = 1,050,624 px. A clamp that exceeds its own ceiling.

An 8-pixel grid and an exact ratio are not in conflict — they only look it. 16:9
sits exactly on the grid at 1280×720, 1408×792, 1920×1080. The fix finds the
smallest on-grid frame of exactly the asked ratio and multiplies it up as far as
the budget allows. Every preset aspect now resolves exactly, with even edges,
and the clamp steps down in whole units:

```
16:9 → 1280x720   2.39:1 → 1912x800   9:16 → 720x1280
4:3  → 1152x864   1.85:1 → 1184x640   1:1  → 1024x1024
```

### 18. The image provider re-quantised, and nothing looked

Asked 1368×768. Got back **1376×768** — 1376 is 43×32, so Nano Banana snapped to
its own 32-pixel grid. That is the provider's prerogative; the defect is that
the engine never measured what it received. A generator's request is a hope; its
answer is evidence.

`lib/image-raster.js` reads real dimensions from the file header (PNG and JPEG,
dependency-free — a storyboard frame is megabytes and decoding one to learn two
integers is work nobody needs done).

### And the mechanism that carried it into the footage

**Seedance derives its output raster from the keyframe it is handed, not from
the `aspect_ratio` field sent beside it.** That is why the leg whose frames were
both true 1920×1080 — 1C and 1D, the two that were uploaded rather than
generated — came back at exactly 1920×1080, while the legs starting on a
1376×768 board came back 1926×1076 (1.790:1, the board's shape carried through).

So `aspect_ratio` is not a control on this provider when keyframes are present.
`sequence_plan` now measures every keyframe first and reports, free, before
anything is bought:

> 2 of 4 keyframe(s) are not 16:9: 1376x768 is 1.7917:1 against 1.7778:1. The
> video model takes its output raster from the keyframe, NOT from the
> aspect_ratio field — so the footage will come back in the frame's shape, not
> the project's.
>
> These keyframes are not all the same size (1376x768, 1920x1080). Legs
> generated from them will come back in different rasters, which will not stitch
> and cannot be conformed to one spec without a rescale.

Tolerance is half a percent — below that no editor sees it.

**Not fixed here, deliberately:** the four boards already on this project. They
are what the approved shots look like; regenerating them to correct eight pixels
would buy four new pictures and change the frames that were signed off. The
right move is a rescale at conform, or a board regeneration the director asks
for knowingly.

### 19. The fix: conform the board on the way in

`routes/storyboard.js` → `callImageGen`, `lib/board-raster.js`, `lib/image-raster.js`

Item 17 makes the engine ASK for an exact ratio. That is not sufficient on its
own, and assuming it was would have left the same bug one layer down: the
provider still answers on its own grid. 1920×1080 is a perfectly reasonable ask
that Nano Banana cannot serve exactly either — 1920 is 60×32, but 1080 is not a
multiple of 32.

So the frame is conformed on receipt, in `callImageGen`. Five places in
`routes/storyboard.js` write a generated board to disk and every one of them
takes its bytes from that function — instrumenting five call sites is how four
end up instrumented.

Three rules:

- **Centre crop, never stretch.** The error is a fraction of a percent; cropping
  loses a sliver of edge nobody framed for, while an anamorphic squeeze changes
  every face in the picture.
- **A frame smaller than the ask is left alone and reported.** Upscaling a board
  invents detail. A slightly small frame that is honestly labelled beats a soft
  one that claims to be sharp.
- **Conform the buffer, before the write.** The archive of previous attempts is
  written from the same bytes, so conforming the file afterwards would leave
  every archived version off-spec and `shot_frames` restore would put an
  off-ratio frame straight back on the board.

`callImageGen` now returns a `raster` field alongside the bytes — "the provider
gave me a different size and I cropped it" is a fact about that frame, not
something to do silently.

Never throws: a frame that cannot be conformed is stored exactly as it arrived.
The generation is paid for either way, and bytes on disk beat a clean raster
that failed to save.

### The delivered footage

The three legs already shot were conformed in post rather than reshot —
scale-to-fill and centre crop to 2560×1440, h264 CRF 15, 24 fps, silent, written
to `data/video/<project>/conform_2560x1440/`. Originals untouched beside them.

Reshooting was the alternative and was not worth it: correcting the boards means
generating new pictures, and the shots that were signed off would change. The
crop costs 0.7% of frame width on two of the three legs and nothing on the
third.

### 20. The ambient derivation argued with the brief, and blew the provider's limit

`lib/music-prompt.js` → `buildAmbientPrompt`

`music_brief`'s own description states the rule: *"a cue somebody wrote always
beats the derivation."* This function did the opposite. It appended the
location's generic ambience, the INT/EXT modifier and a time-of-day modifier on
top of whatever the director wrote, unconditionally.

A diegetic element — a 1950s radio playing out of a drive-in speaker — was
briefed as exactly that and sent as:

> ...boxy midrange, cone crackle, carrier hiss**., ambient sounds of DRIVE-IN
> THEATRE - LOT, outdoor, nighttime atmosphere, quieter, occasional distant
> sound**

So the generator was asked for a tinny radio *and* the open-air lot it is heard
in, simultaneously, while the cue's own negative prompt was busy excluding
crickets. The scene already has a separate "Lot Air" cue for the lot; this one
asked for it a second time and diluted the thing it was written for.

It also blew the provider's ceiling. ElevenLabs documents 450 characters; a
written brief plus this tail reached 461 and the call 400'd on length — for a
prompt the author never saw, since the assembled string is not what they wrote.

The derivation now fills a **gap** rather than decorating an answer: with a
written direction, only that direction is sent. With none, the location, INT/EXT
and time-of-day derivation works exactly as before. And the 450-character
ceiling is enforced at assembly, trimmed at a sentence or clause boundary, with
`prompt_trimmed` reported — a silently trimmed prompt is one the author cannot
debug.

### Also observed: `gen.ambient` has a `text` port that goes nowhere

`node_gen_ambient` declares a `text` input port and accepts `config.text`.
Neither reaches the payload: `CAPABILITY_BUILDERS.ambient` reads
`ctx.ambient.direction`, which is populated from the scene's ambient cue ROW.
A caller's words are silently discarded in favour of whichever cue the scene
holds.

Not fixed here — the correct authoring path exists and is documented
(`music_cue_create` then `music_cue_generate`, which is addressed by cue and
warns about exactly this). But a port that accepts input and drops it is worse
than no port, and it belongs on the list.

Related and still open: `loadShotContext` selects the scene's ambient cue with
`ORDER BY start_ms LIMIT 1`. This project now holds two ambient cues both at
`start_ms 0`, so any scene-derived ambient generation is a coin flip between the
lot bed and the radio. Same shape as the score/ambient collision in item 6 of
the original list.

### 21. The sequence prompt budget was a constant, and it was throwing away 90% of the room

`routes/sequences.js` → `shotPromptBudget`, `shotDirection`, `shotsOf`

`SHOT_PROMPT_MAX = 1200` was a number invented in this file. Seedance declares
`promptLimit: 16000`. So every leg was built against a ceiling more than ten
times below what the model accepts — and trimmed from the END, which is exactly
where a director's negative instructions live.

Caught by simulating the trim before spending rather than after. On this ident's
1D card:

```
direction raw: 1552 -> trimmed to 853
```

What fell off the end: the **third stage** of the title build ("PICTURES fades
up beneath the rule"), every anti-warping guard ("no morphing, no wobbling
letterforms, no invented characters"), and the closing instruction that the logo
must **not** come apart. The prompt about to be bought described two thirds of
an animation and none of the rules for it — at $4.25, and the only symptom would
have been a clip that was subtly wrong.

The trim itself is not the bug; item 6 of the original list got that right, and
reserving direction first (so a long description cannot eat it) is still
correct. The bug is a budget nobody chose.

Now derived from the resolved adapter: a segment carries a preamble plus two
shot blocks, so each shot gets a little under half of what remains after a
preamble reserve, capped at 4000 — a 16000-character limit is not an invitation
to write a 16000-character prompt, and past a point more words dilute rather
than direct. A provider declaring no limit keeps the old 1200/900 floor, and so
does an unresolvable one: a wiring fault must never look like a creative choice.

Result on this sequence — all three cards now travel whole:

| Card | direction | description | sent | before |
|---|---|---|---|---|
| 1B | 775 | 1023 | 1799 complete | 1200, tail cut |
| 1C | 737 | 932 | 1670 complete | 1200, tail cut |
| 1D | 1552 | 619 | 2172 complete | 1200, **stage 3 and all guards cut** |

A test pins that `seedance.promptLimit` still exceeds the cap: if a provider
stops declaring one, every sequence quietly reverts to 1200 and nobody is told.

### 21b. …and then the ceiling came off entirely

The first pass at item 21 capped a shot at 4000 characters. Better than 1200 and
still a number chosen here rather than by the model.

There is no reason for one. The look is carried by the KEYFRAMES, which are
pinned to the generation — what the text has to do is the part a still cannot
say: the camera move, the action, what the performers do, what must not happen.
That is exactly the material the cap was cutting.

The budget is now the provider's declared limit, less the preamble that actually
travels (**measured**, not reserved — reserving a guess is the same mistake one
size smaller: a short preamble wastes room, a long one overruns), less the fixed
connective, less a 200-character safety margin, split across the two shot
blocks. Every number is measured or declared; the only constant left is the
margin.

On this project: **6830 characters per shot** against 1200 before. Nothing in
any card comes close, which is the point — the trim is still there for a card
that runs away, and no card of a sane length will ever meet it.

An undeclared provider limit still keeps the 1200/900 floor. Guessing high on an
undeclared limit buys a rejection at full price.

---

## Getting to 2K, and what was stopping it

### 22. The 1MP ceiling is Meshy's, and it is real

`lib/providers/meshy.js` → `maxImagePixels: 1376 * 768`

Not a guess and not a bug. Meshy's own adapter documents it:

> …about one megapixel — for nano-banana-2 AND nano-banana-pro alike. There is
> no way to ask for more: the API documents no width, height, size or quality
> field, and the changelog through Aug 2026 shows every resolution change was an
> ASPECT RATIO addition, never a size control. So this is a ceiling of the
> service rather than of the models behind it.

Every board on this project is 1376×768 because the project is pinned to
`image: "meshy"`, and no project setting can lift that. `imageBudget` clamps the
ask to the adapter's ceiling — correctly, because over-asking is a rejection
that costs a generation and returns nothing.

**The same model is available through MuAPI with real size tiers.**
`muapi-image.js` declares `sizes: ['1k','2k','4k']` and
`maxImagePixels: 3840*2160`, and MuAPI validates the tier at the request rather
than silently returning the wrong size. It is also cheaper: nano-banana-pro is
**$0.12** a call on MuAPI against **$0.18** on Meshy.

So 2K is a provider choice, not a settings problem. Switching
`provider_config.image` to `muapi` is the whole fix.

### 23. …which immediately exposed a real bug in the board conform

`lib/board-raster.js`

Item 19 conformed a board by CENTRE CROP. That is right for the failure it was
written against — Meshy returning 1376×768 for a 1368×768 ask, a fraction of a
percent of ratio drift, where a crop loses a sliver of edge nobody framed for.

It is catastrophically wrong for the other failure. MuAPI serves a **tier**: ask
for 2560×1440 and the 4k tier returns **4096×2304** — the same shape, more
pixels. Cropping that to 2560×1440 throws away **60% of the frame** and returns
a punched-in shot nobody composed. The board would have looked plausible and
been wrong, on every frame, with the video model pinned to it.

The shape now decides the correction:

| Arrived | Asked | Filter |
|---|---|---|
| 1376×768 | 1368×768 | `crop=1368:768` — drift only |
| 4096×2304 | 2560×1440 | `scale=2560:1440:flags=lanczos` — size only |
| 4096×2304 | 2560×1600 | `crop=3686:2304,scale=...` — shape first, then size |
| 2048×1152 | 2560×1440 | *nothing* — never upscale |

Lanczos on the way down, deliberately: a board is the keyframe a video model is
pinned to, and softness here becomes softness in every frame of the clip.

`conformFilter` is pure and exported, so the decision is testable without
ffmpeg — the crop-versus-scale choice is the part that had to be right.

### 24. A global provider setting that nothing obeyed

`routes/projects.js`, `routes/app-settings.js`

The account-level setting exists — `default_image_provider` and
`default_video_provider` in `film_app_settings`, read by `accountDefaultFor()`
and placed in the resolution order ahead of the quality tier. Two defects made
it unreachable in practice.

**Every project was born overriding it.** Project creation stamped
`JSON.stringify(defaultProviderConfig())` — a full pin for every capability,
frozen at whatever happened to be configured the day the project was made. The
stated reason was display: *"a blank column shows the user nothing in Provider
Settings."* The cost is far larger. A per-project pin **outranks** the account
default, so every project silently overrode the one global setting that exists,
with a choice nobody made.

The symptom is someone setting their studio's image provider once and watching
every project keep using the vendor preferred months ago — which is exactly what
happened: boards kept going to Meshy, capped at 1MP with no size control, while
both the account setting and the preference order pointed elsewhere.

A new project now pins nothing. A pin means what the resolver already assumes it
means: somebody deliberately chose this provider **for this film**. Everything
else follows account default → quality tier → preference order, all live. The
display problem is solved properly by `resolutionOf`/`describeResolution`, which
report the resolved provider *and where it came from*.

**And changing the setting did nothing until restart.** The cache-clear block
was gated entirely on `gridlight_enabled` — with a comment inside it correctly
explaining why the account default must not need a restart, while sitting behind
a condition that could only be true when a *different* setting changed. Each
cache is now cleared by the key that invalidates it.

Existing projects still carry their auto-stamped pins; they were written to the
database and this fix cannot retroactively un-choose them. Clearing a capability
is `project_update` with `provider_config: { image: null }`.

---

## The protect frame

### Correction to an earlier claim

I said there was no crop overlay anywhere. **Wrong** — the storyboard has had one
since before this session. It is called **Protect**, which is why a search for
"safe area", "crop guide" and "reframe" missed it. It draws a centre-crop box
height-locked to the frame, dims everything outside, and labels it *"9:16 keeps
32% of the width"*. Default off. It is well built and the reasoning is already
in the source:

> A centre crop is assumed, and that is honest rather than lazy: it is the worst
> case and the default any reframing tool starts from.

Two things were genuinely missing, and those are what got built.

### 25. The guide is driven by the job, and it reaches playback

`src/index.html`

**One renderer, two surfaces.** `protectOverlayHTML` is now shared. A second
copy is how the board and the cut come to disagree about what a placement keeps.
It measures the PICTURE's ratio, never the container's — a board tile is
letterboxed in its cell and the playback stage is the project's shape while the
clip may be a hair off it (this project's legs are 1926×1076 against a 16:9
stage), so measuring the box would draw a guide that is right about the
container and wrong about the shot.

**The ratios come from the deliverable set.** A hardcoded 9:16/4:5/1:1 list asks
the director to remember which placements the campaign bought. The rows already
say — and they are the same rows `needs_native_shots` is computed from, so the
guide on the board and the warning on the deliverables page now answer from one
source. An **"all planned"** option draws every shipped ratio at once: the
narrowest carries the mask, because it is the one that decides whether the shot
survives, and the rest are outlines. Stacking a mask per ratio would layer four
translucent blacks and make the tightest crop the *brightest* region on screen,
which is exactly backwards. With nothing planned it falls back to the standard
three.

**Playback has it now.** This is the half the board cannot do. The board answers
*would this frame survive the crop*; only the cut answers *does the action stay
inside it while the camera moves* — a subject that starts centred and ends at
the edge boards fine and crops badly, and that is invisible in a still. Sized in
script against the video's own `videoWidth`/`videoHeight`, because `.pb-video`
is `object-fit: contain` and drawing on the element would put the guide over
black. Redrawn on clip change, on resize, and on the picker; listeners bound
once, so re-entering the page does not stack them.

Off by default on both surfaces.

Geometry verified against the numbers `lib/deliverables.js` documents:

```
9:16   keeps 32% width     4:5    keeps 45% width
1:1    keeps 56% width     16:9   keeps 100%
2.39:1 keeps 100% width, 74% height
```

---

## Can Film Engine ask Claude, instead of spending an API key?

### 26. The handshake already answers this, and the server was discarding it

`mcp-server.js` → `initialize`, `lib/agent-presence.js`

MCP runs one direction: a host calls this server, this server cannot call the
host. `sampling/createMessage` is the protocol's answer — the SERVER asks the
CLIENT's model to complete something, on the user's own subscription, spending
no API key. Whether it is available is a property of the host, and the host
declares it in `params.capabilities` at `initialize`.

This server read `clientInfo.name` from those params and threw the rest away.
So the one question the engine cannot otherwise answer about its own host —
*can the attached model be asked something?* — was arriving on every connection
and being dropped.

Now recorded. `agent_presence` reports the declared capability set verbatim
(stored as JSON rather than distilled to a boolean: the capability set grows
with the protocol, and a flag decided here would answer last year's question),
plus two named lines a reader can act on: `can_ask_the_host` (`sampling`) and
`can_elicit` (`elicitation`).

Written only at `initialize`, which is the only time capabilities are sent —
every other call passes nothing and must not erase what the handshake recorded.
A tool call is not evidence that a host stopped supporting sampling.

### What the documentation says, pending that measurement

- The spec defines sampling as a **client** capability, declared at initialize.
- The Claude Code feature request for it (anthropics/claude-code#1785, opened
  June 2025, labelled `area:mcp` / `area:cost`, assigned) is **open and
  unimplemented** in the content available — and its stated motivation is
  exactly this one: use the subscription instead of pay-as-you-go API cost.
- The Claude Desktop capability write-ups cover tools, resources, prompts and
  transports and **do not mention sampling at all**.

So: probably unavailable today, and the engine will now say so from the
connection in front of it rather than from a web page about somebody else's
build.

### The design that works without it

A queue, not a callback. The button writes a pending request row; a tool lets
the attached model pick it up, do the work through the MCP tools it already
has, and write the result back; the engine polls and lights up when it lands.

The honest limitation is that the model acts when the user prompts it, so it is
"press the button, switch to Claude, say *check Film Engine*" rather than a
button that completes on its own. That is a smaller gap than it sounds — the
context, the tools and the project are already there — and if sampling does
land, the same queue becomes the thing sampling drains, with no rework.

---

## The ledger: subscriptions, and charges nobody watched happen

### 27. What a Claude subscription costs, and why it is not a per-token rate

`lib/provider-pricing.js`, `routes/app-settings.js`, `routes/budget.js`

**Anthropic publishes plan prices and does not publish token allowances.** Max
20x is **$200/month**. Its limits are expressed as prompts in a rolling
five-hour window and weekly model-hours — the circulating figures (~200–900
prompts per 5h, 240–480 Sonnet hours and 24–40 Opus hours a week) come from
independent testing, not from Anthropic, and they are not token counts.

So *"how many tokens does the plan include"* has **no published answer**, and
inventing one to divide into would be the worst kind of number: precise,
confident and made up. This engine has been burned by that exact shape already —
a "2048×1152" plate that arrived 1376×768 because a ceiling was over-claimed.

What is true and worth reporting instead:

1. The subscription is a **fixed monthly cost**, spent whether this project uses
   it or not.
2. The **marginal cost of a token on a subscription is zero**.
3. What an agency needs is **attribution**, not price: this project used X% of
   the tokens metered this month, so it carries X% of the fee.

`subscriptionAttribution()` computes (3) from tokens actually metered, across
every project in the calendar month the fee covers — attributing against this
project's own tokens alone would hand it the whole $200 no matter how little of
the month it used. Reported as its own `subscription` block and **never summed
into `measured_usd`**: a sunk monthly fee is not a variable cost of a shot, and
adding it would make cost-per-shot wrong in both directions at once.

A period with no metered tokens returns a **null** share, not zero — 0/0
reported as $0.00 reads as "the subscription cost this project nothing" rather
than "there is not enough information yet".

Set with the new `llm_subscription_plan` setting: `none` (API pay-as-you-go),
`pro` $20, `max_5x` $100, `max_20x` $200, `team` $30/seat.

### 28. A charge the engine did not observe

`routes/budget.js` → `recordKnownSpend`, tool `spend_record`

Everything else in the ledger is measured at the moment of a call. That misses a
whole class of real money, and the class is not rare:

- **A generation that was rendered, billed, and then lost on this side.** One
  clip here cost **$1.70** and was reported as a failure, so the meter — which
  correctly declines to bill refusals — recorded nothing for a charge that had
  already happened.
- **Anything bought before the metering path covered it.** Collected
  generations were unmetered until item 14 made the handle carry its price.
- **A charge made outside the engine entirely** — a console retry, a plan
  change, a credit going the other way.

The alternative to a way in is a director doing arithmetic in a spreadsheet
beside the report, which is how the report stops being read at all.

Always flagged: it writes `estimated = 1` and a `manual:` source_ref, so a
hand-entered figure can never be mistaken for one the engine watched happen. An
explicit `usd` is taken as `provider_confirmed` — a provider's own invoice beats
our reconstruction of it, the same rule `native_charged` already follows.

### DRIVE-IN: what is missing from the ledger

Item 14 works — the two legs shot after it are recorded at $8.50. Four earlier
video charges predate it:

| Job | What | Charge |
|---|---|---|
| `66670953` | 720p leg, rendered and billed, never delivered | $1.70 |
| `18dcdabc` | leg 1A→1B, 1080p, collected before the meter fix | $4.25 |
| `4abefadc` | leg 1B→1C v1, collected before the meter fix | $4.25 |
| `fe740a45` | leg 1C→1D v1, collected before the meter fix | $4.25 |

**$14.45 unrecorded.** True video spend is $22.95 against the $8.50 shown.
`spend_backfill` cannot help — it reconstructs from untracked *assets*, and
these assets exist and were overwritten by the re-shoots. They go in through
`spend_record`, each carrying its job id as `reference` so it reconciles against
MuAPI's own invoice.

### 29. Two POST tools that posted nothing

`lib/mcp-tools.js`

`callRouteTool` builds a request body from `t.body(args)` or from `t.bodyKeys`.
A tool declaring **neither** sends `{}` — every argument silently dropped, while
the schema, the description and the call all look correct.

Caught the hard way on `spend_record`: its first live call returned *"provider
and capability are required"* with both plainly supplied. The schema being right
is not the same as the arguments arriving.

A test now derives every POST/PUT production tool from the source, and fails any
that declares body fields (anything not a path `*_id`) without a way to send
them. It immediately found a **second** instance: `generation_collect`'s
`belongs_to` — added in item 9 precisely so an older handle could be filed as
the sequence leg it was bought for — had never reached the route either. The one
parameter that existed to recover a lost clip could not have worked.

Both fixed; 34 tests green.

### Measured: this host cannot be asked

`agent_presence`, now that item 26 records what the handshake declares:

```
client:            local-agent-mode-film-engine
capabilities:      roots { listChanged }, extensions { io.mcp/ui }
can_ask_the_host:  false
can_elicit:        false
```

No `sampling`, no `elicitation`. So Film Engine cannot ask the attached model
anything, and the queue design in item 26 is the one that can be built. The
measurement is of THIS connection — a different host may declare differently,
and the report now says which it saw rather than guessing.

### 30. Footage had no version history

`lib/provider-media.js` → `archivePreviousTake`

The board has kept every attempt since it was written: `archiveExistingFrame`
copies the outgoing picture into `versions/` before a regeneration overwrites
it, on the principle `shot_frames` states outright —

> generation is a coin flip you already paid for, so an earlier attempt is often
> the one you wanted

**Video had no equivalent.** A leg re-shot to the same filename overwrote the
previous take on disk and UPDATEd its asset row in place, so the earlier clip
ceased to exist locally. That is the same coin flip at forty times the price: a
board costs cents, a 1080p leg costs $4.25.

It happened on this project. Re-shooting 1A→1B destroyed a take that then
existed only on the provider's CDN — recovered here only because the director
happened to have uploaded a copy.

The outgoing file is now copied to `takes/<name>.vN.<ext>` first, numbered from
what is already on disk rather than from a database read: the archive has to be
correct even when the row it belongs to is the thing being rewritten. Installed
in `persistProviderMedia` — the one funnel every saved clip passes through, the
same place the audio strip lives — and **before** the write, because `saveFile`
overwrites and archiving afterwards would copy the new take while still losing
the old one. A test pins that ordering, with comments stripped first: the first
`saveFile` in that function is inside the comment explaining the rule, and a
test that matches prose instead of code is a green test that means nothing.

Never throws. Failing to keep a copy must not stop the new take being saved —
losing the old one is bad, losing both is worse.

**Still open:** the archive is on disk only. `shot_frames` lists board versions
and can restore one; footage has no equivalent listing or restore tool yet, so
recovering an old take means finding it in `takes/` by hand.

### 31. The music brief was reaching the generator at 13% of its length

`lib/music-prompt.js` → `fitMusicPrompt`, `buildMusicPrompt`

`MUSIC_PROMPT_LIMIT` is 600 characters, and `scene-score` states plainly where
the number came from: **ElevenLabs documents no character limit for `/music`,
so it is ours** — chosen because a prompt DERIVED from `film_scenes.description`
came out over three thousand characters of camera blocking with the musical
words at the very end.

That reasoning is right about a derivation and wrong about a brief. A cue a
director wrote is already about the music; every sentence of it *is* the
direction. Capping it at 600 cuts exactly the part that matters.

Caught on this project's ident fanfare — a 1,562-character brief that reached
the generator as:

> …the moment before a film begins at a drive-in, when the engines are off, the
> light is**, in D major, 60 bpm, orchestral…**

Cut mid-clause at "the light is". Lost: the harp and celeste opening, the horn
MELODY on rising fourths and fifths, the earned resolution, the decay to one
vibraphone note, and the guards saying *never static, never ambient, never a
pad*.

**And that explains an earlier mystery on this project.** The first take of this
cue came back FLAT. The brief was rewritten specifically to fix flatness —
adding a real melody, harmonic movement, a rising line, rhythmic snap — and
almost none of the rewrite was ever sent. The diagnosis was right and the fix
never reached the model.

A written description now gets its own allowance (4,000, still ours and still
stated); a derivation keeps 600, because the argument for it there is sound.
`prompt_source` reports which applied.

### Also: music has the same overwrite problem video had

A generated cue's filename is `<scene>_<type>_<cue-id-8>.<ext>` — keyed to the
cue. Regenerating a cue at a new length therefore **overwrites the master** the
same way a re-shot leg did before item 30. The 20-second version here was
deliberately made as a NEW cue rather than a longer render of the old one, so
the approved 15-second master survives beside it.

Item 30's `archivePreviousTake` currently guards `subdir === 'video'` only.
Extending it to `music` and `audio` is a one-word change and should be made
before anyone regenerates an approved cue in place.

### 32. The engine asked for WAV and got 128 kbps MP3

`lib/providers/elevenlabs.js` → `normalizeOutputFormat`, `wrapPcmAsWav`
`lib/music-prompt.js` → `sample_rate`

`music-prompt` has built every audio payload with `output_format: 'wav'` since
it was written. The adapter's normaliser accepted only ElevenLabs' own
vocabulary:

```js
if (requested.startsWith('mp3_') || requested.startsWith('pcm_')) return requested;
return DEFAULT_OUTPUT_FORMAT;          // 'mp3_44100_128'
```

`'wav'` matches neither. So **every score, ambient bed and effect this engine
has ever generated came back as 128 kbps MP3 at 44.1 kHz** — the lowest tier the
API offers — while the code that asked for it said WAV. Nothing failed and
nothing warned; the request was simply not in a language the function spoke.

Confirmed on disk: all three cues on this project are `mp3, 44100, 2, 128000`.

Two consequences for a spot:

- **Lossy at the source.** It is compressed before the mix, the loudness pass
  and the delivery encode, so generation loss compounds through every stage.
- **Wrong rate.** 44.1 kHz is the CD rate; video and broadcast run at 48 kHz, so
  every cue needed a sample-rate conversion into the timeline that nobody asked
  for.

Fixed: `'wav'`/`'pcm'` plus the requested `sample_rate` now translate to the
matching `pcm_*` tier, snapped to the nearest documented rate **at or above** the
ask — never quietly below it, which is the whole point of asking. Payloads now
request 48 kHz.

**And the trap that makes this more than a one-line fix.** ElevenLabs' `pcm_*`
returns raw samples with **no container**. Saved as `.wav` those bytes open in
nothing, and nothing in this codebase writes a RIFF header — `media-imports`
only ever reads one. So the adapter now writes the 44-byte header itself, and
**infers the channel count from the byte count** rather than assuming it:
`/music` returns stereo and `/text-to-speech` returns mono, and a wrong guess
plays at half or double speed. A byte count that fits neither returns null, the
raw bytes are kept, and `meta.pcm_wrapped_as_wav: false` says so — a file
labelled honestly as raw beats one that plays at the wrong pitch.

**Not yet verified against a live response.** The header maths is tested; the
channel inference is a model of what the API returns and wants one cheap
generation to confirm.

### 33. …and item 32 only covered one endpoint in three

`lib/providers/elevenlabs.js` → `soundGenerationUrl`, `buildSfxRequest`, `buildAmbientRequest`

Item 32 fixed `normalizeOutputFormat`, which serves `/music` and
`/text-to-speech`. Ambient beds and effects go to **`/sound-generation`**, and
those two builders never consulted it. They did not fall back to MP3 — they
**declared** it:

```js
mimeType: 'audio/mpeg',
format: 'mp3',
```

hardcoded, with no `output_format` on the request at all. So the first ambient
generated *after* the format fix still came back `mp3, 44100, 2, 128000`.

A fix that covers one of three endpoints looks done and is not, which is why
this gets its own number rather than a silent edit. `/sound-generation` takes
`output_format` as a query parameter exactly as `/music` does; both builders now
send it, carry `durationSeconds` so a raw-PCM response can have its channels
inferred, and set their mime type from the format rather than asserting it.

Asking for nothing still behaves exactly as before.

### Confirmed working: the ambient derivation fix (item 20)

The same generation proves item 20. The prompt that went out was the written
brief and nothing else — no `ambient sounds of DRIVE-IN THEATRE - LOT, outdoor,
nighttime atmosphere` tail arguing with a cue that explicitly excluded traffic
and people.

### 34. Milestones had routes but no tool

`lib/mcp-tools.js` → `milestone_list`, `milestone_update`

`film_milestones` has existed since migration 014, `routes/dashboard.js` serves
GET/POST/PUT for it, and the nine standard phases are seeded on first read. None
of it was reachable from the tool surface — the same shape as `agent_presence`
(item 26) and `spend_record` (item 28): a capability with working plumbing and
no control.

Both tools added. `milestone_update` deliberately moves ONE milestone: setting
the last one complete does not backfill the ones before it. A timeline whose
final box is ticked while the middle ones are not is a real state a production
can be in, and inferring otherwise would rewrite history the director did not.

`milestone_update` carries a `body` mapping — the guard from item 29 covers it,
so a POST/PUT tool that silently posts `{}` cannot be added here again.
