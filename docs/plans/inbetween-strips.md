# In-Between Strips: a shot as a strip of stations, not a still

Date: 2026-08-29
Status: W0 built and passing. W1–W5 not started.
Related: `docs/plans/consistency-system.md`, `lib/video-sequence.js`, `lib/shot-motion.js`

---

## The problem, in one paragraph

`lib/video-sequence.js` already travels between pictures a director approved: N
shots become N-1 segments, each pinned to a first and a last frame. But the unit
is the SHOT. A five second push-in reaches the provider as ONE picture and a
sentence, so seconds two, three and four are the model's opinion — and the
model's opinion is what drifts. We want a frame per second of film, derived from
the shot's own camera blocking, reviewable and fixable BEFORE any video is
bought.

## The insight that shapes the whole build

**Do not build a second pipeline.** `planSequence(shots, opts)` is pure and
operates on an *ordered list*; it does not know or care that the entries are
shots. Feed it a denser list and everything downstream works unchanged —
`buildSegment` still pairs neighbours, the segment loop in `generateSequence`
still generates, `sequence_stitch` still joins. A shot with no move that reads
still yields one station, which is exactly today's behaviour.

**Do not invent the in-between poses.** `lib/shot-motion.js` already samples the
camera across a shot from the film's own optics (`motionTrack`, TRACK_FRAMES=24)
and `transformAt(track, t)` returns the pose at any moment in it. Sampling that
at each station makes an in-between a fact about the blocking rather than a
guess about the action.

---

## Decisions already taken — do not relitigate

1. **Chained refine off the previous frame.** Each station is generated from the
   one before it through the existing refine path (picture in, no scene card, one
   instruction), not independently from the shot's keyframe. Maximum continuity;
   serial by construction; drift is bounded by W4's approval gate.
2. **Target Seedance 2.5.** 30 images, and `video-reference.js` records that its
   images are free while video is billed per second. Build against that contract.
3. **`maxKeyframes` and `maxImages` are different slots.** Keyframes are
   positional (first/last); reference images are not. Both paths are viable and
   W5 makes them A/B-able. Do not conflate them.

---

## What already exists — read before writing anything

| File | What it gives you |
|---|---|
| `backend/lib/video-sequence.js` | `planSequence(shots, opts)` → `{segments}`; `buildSegment` pairs neighbours. Pure. Degrades with `degraded: true` when `maxKeyframes < 2`. |
| `backend/lib/shot-motion.js` | `motionTrack(input)`, `transformAt(track, t)`, `loadShotMotion(shotId)`. `perceptible: false` = will not read. `carried: false` = a still cannot show it honestly. |
| `backend/lib/video-reference.js` | `ROLES`, `ROLE_RANK`, `CONTRACTS` (`hailuo3` 9 images @2cr, `seedance2_5` 30 images free), `contractFor()`, `selectReferences()`. |
| `backend/routes/sequences.js` | `shotsOf(row)` ~L78, `keyframeCeiling()` ~L120, `planRoute()` ~L191, `generateSequence()` ~L265. |
| `backend/routes/storyboard.js` | `POST /film/shots/:id/storyboard/refine` (L659 → `refineShot`), `GET .../refine-preview` (L654). **Assets already persist `metadata.refined_from` and `metadata.instruction`** (L478, L1557). |
| `backend/lib/artefact-fingerprint.js` | `fingerprintFor(kind, ids)`, `isStale()`, `stampAsset()`, `acceptAsCurrent()`. The `409 STALE` contract `previs_approve` uses. |
| `backend/lib/mcp-tools.js` | MCP tool registration; `sequence_plan` ~L542. |
| `backend/db/migrations/` | Latest is `095_sheet_structure.sql`. New migration is `096_`. |

---

## W0 — BUILT AND PASSING. Do not rewrite.

`backend/lib/inbetweens.js` (249 lines, pure, no DB) and
`backend/tests/inbetweens.test.js` (24 tests, all passing).

### Exported contract

```js
stationCount(durationMs, motion, opts) -> { count, thinned?, wanted?, reason? }
deltaInstruction(fromTransform, toTransform) -> string | null
planStations(shot, motion, opts) -> {
  shot_id, shot_code, duration_ms, cadence_s, count,
  stations: [{ index, t, at_ms, transform:{scale,x,y,rotate},
               source:'keyframe'|'refine', refined_from, instruction }],
  generations, thinned?, wanted?, dropped_still?, reason
}
expandShots(shots, motionFor, opts) -> { strips, stations, images_needed, segments }
```

`opts`: `{ cadenceSeconds = 1, maxStations }`. `motionFor` is
`shot => motion`, so the module stays DB-free and testable.

### Behaviour it already guarantees (pinned by test)

- `perceptible: false` or no motion → **one station, zero generations.**
- `carried: false` → **more** stations, not fewer.
- Stations whose delta rounds to nothing are dropped, then re-indexed.
- Station 0 is the approved keyframe: `instruction: null`, `refined_from: null`.
- `generations === count - 1`; `segments === stations.length - 1`.
- Pan direction is asserted against `screenAt`'s `x = +dYaw/fov.hDeg`.

**Run it:** `cd backend && node --test tests/inbetweens.test.js` → 24 passing.

---

## W1 — Show the strip. Free. Do this first.

**Files:** `backend/routes/sequences.js`, `backend/lib/mcp-tools.js`

Add `?expand=inbetweens` (and `cadence_s`, default 1) to the plan route. When
set, call `expandShots(shotsOf(row), shot => loadShotMotion(shot.id), { cadenceSeconds, maxStations })`
and pass `out.stations` to `planSequence` instead of `shotsOf(row)`.
`maxStations` comes from `contractFor(model).maxImages`, never a literal.

The response must additionally carry `strips` (per shot: `count`, `generations`,
`thinned`, `wanted`, `reason`), `images_needed`, and `images_estimated_credits`.

**Do not send the station images in the plan body.** `planRoute` already maps
segments to `keyframes: s.keyframes.length` for exactly this reason.

Register `sequence_plan_inbetweens` in `mcp-tools.js` beside `sequence_plan`,
described as FREE.

**Tests** (`tests/inbetweens-plan.test.js`): expanding a 2-shot sequence with a
push-in yields more segments than without; `expand` absent reproduces today's
plan byte-for-byte; a 9-image contract and a 30-image contract produce different
`images_needed`; a shot with an imperceptible move contributes exactly one
station.

**Acceptance:** plan a Wingfall scene-1 sequence with `expand=inbetweens` and read
the strip without spending a credit.

---

## W2 — Generate the strip (the chain executor)

**Files:** new `backend/lib/inbetween-run.js`, `backend/routes/sequences.js`

`POST /film/sequences/:id/inbetweens` walks each strip **serially**, calling the
same internal path `refineShot` uses with `instruction = station.instruction` and
the previous station's image as the input picture. Station 0 is never generated —
it is the approved frame, and a frame generated from itself could only reproduce
itself (the rule `lib/shot-anchor.js` already states).

**Storage: no new table.** Persist each station as a `film_assets` row,
`asset_type = 'storyboard'`, reusing the metadata that already exists:

```json
{ "sequence_id": "...", "shot_id": "...", "station_index": 3,
  "t": 0.6, "at_ms": 3000, "instruction": "...", "refined_from": "<asset id>",
  "transform": { "scale": 1.18, "x": 0.04, "y": 0, "rotate": 0 } }
```

This inherits the `shot_frames` archive for free: a bad in-between becomes a
re-roll you keep rather than lose.

Migration `096_inbetween_stations.sql`: index on
`json_extract(metadata,'$.sequence_id')` and `json_extract(metadata,'$.station_index')`.

**Stop at the first provider refusal** and name what was not attempted —
`generateSequence` already sets this rule; do not buy the same failure N times.

**Tests** (`tests/inbetween-run.test.js`): a 4-station strip issues exactly 3
refines; each refine receives the PREVIOUS station's image, not the shot
keyframe; a mid-chain failure stops the walk and reports the remaining stations;
re-running skips stations that already have an asset.

---

## W3 — Fine-tune before spending

**Files:** `backend/routes/sequences.js`

- `PUT /film/sequences/:id/stations/:shot_id/:index` — replace one station's
  instruction and re-run **only** that station and the ones after it, because a
  chain re-inherits from the frame that changed.
- `DELETE` the same path — drop a station; the neighbours become adjacent and
  the segment count falls by one.
- Re-selecting an archived version for a station uses the existing
  `current_frame_version` mechanism. Do not invent a parallel selector.

**Tests:** editing station 2 of 5 re-runs 2,3,4 and leaves 0,1 untouched;
deleting a station reduces `segments` by exactly one.

---

## W4 — The approval gate

**Files:** `backend/lib/inbetween-run.js`, `backend/routes/sequences.js`

`POST /film/sequences/:id/inbetweens/approve` fingerprints the whole strip via
`fingerprintFor('inbetween_strip', ...)` over the ordered station asset ids plus
their instructions. Video generation on a sequence with an approved strip must
refuse `409 STALE_APPROVAL` when the current fingerprint differs — the same
contract `previs_approve` carries, and the reason a director can trust the strip
they signed off is the strip that shot.

**Tests:** approve then regenerate one station → `409`; approve then generate →
proceeds; a sequence with no approved strip is unaffected.

---

## W5 — The Seedance reference path

**Files:** `backend/lib/video-reference.js`, `backend/lib/capability-payloads.js`

Add `'inbetween'` to `ROLES` and to `ROLE_RANK` **between `keyframe` (0) and
`character` (1)** — a temporal neighbour outranks identity within its own clip.
Add it to the `seedance2_5` contract's `roles`. Leave `hailuo3` and
`KEYFRAME_ONLY` alone: over-sending is a provider rejection that costs a
generation.

This gives two shapes to compare on the same strip, which is the point:

- **legs** — N stations → N-1 short first/last generations, stitched. Works on
  any adapter with `maxKeyframes >= 2`.
- **bundle** — one longer generation with the strip as `inbetween` references.
  Seedance only.

Expose as `?shape=legs|bundle` on plan and generate, defaulting to `legs`.

**Tests** (`tests/video-model-contracts.test.js`): every adapter still declares a
keyframe ceiling with a reason; `selectReferences` drops `inbetween` for
`hailuo3` with a stated reason and keeps it for `seedance2_5`; the 31st image is
dropped by name, never silently.

---

## Traps

- **Do not** let the cadence or the station cap be a literal anywhere outside
  `inbetweens.js` defaults. It comes from `contractFor()`.
- **Do not** skip a station with no keyframe when planning. `planSequence`
  refuses by name for a reason: joining through a moment nobody has seen looks
  like a success.
- **Do not** attach the scene card or style preset to a station refine. The
  picture carries them; repeating them in words pulls the result back toward a
  fresh generation (`storyboard_refine`'s own stated contract).
- **Do not** re-derive the pan/push sign convention. Import `transformAt`.
- **Do not** widen `x`/`y` wording into camera-direction claims without a test
  against `screenAt`.

## Non-goals

Parallax (a still holds none — stated limit in `shot-motion.js`), audio, the
editorial timeline, and per-station previs restaging.

---

## Verification

```bash
cd backend
node --test tests/inbetweens.test.js            # W0, already 24 passing
node --test tests/inbetween-plan.test.js        # W1
node --test tests/inbetween-run.test.js         # W2, W3, W4
node --test tests/video-model-contracts.test.js # W5
node --test tests/*.test.js                     # full suite, expect 666+ passing
```

**Environment note:** `better-sqlite3` in this checkout is built for macOS. Any
DB-touching test fails with `invalid ELF header` under a Linux sandbox. Run the
suite on the Mac, or `npm rebuild better-sqlite3`. `tests/inbetweens.test.js` is
pure and passes anywhere.

## Done when

A Wingfall scene-1 sequence can be planned with `expand=inbetweens` for free,
generated into a per-second strip, corrected one station at a time, approved, and
sent to video — with the strip that shot being provably the strip that was
signed off.
