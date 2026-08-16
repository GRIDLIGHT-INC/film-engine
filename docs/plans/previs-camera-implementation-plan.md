# Implementation Plan: 3D Previs Camera

**Status:** Design — for review, not for implementation
**Date:** 2026-08-15
**Depends on:** [`previs-camera-research.md`](./previs-camera-research.md)
**Machine-readable interfaces:** [`previs-camera-taxonomy.json`](./previs-camera-taxonomy.json) — conformance enforced by `backend/tests/previs-plan.test.js`

---

## 1. What this covers

A 3D stage where you place a ground plane for the scene, place the subject the camera is on, place the camera, move it freely, simulate any lens and aperture, and see through it — before a frame is sent to video generation.

**The set this touches, derived from code:**

| Set | Count | Source |
|---|---|---|
| Camera movements needing a 3D path | 18 | `lib/scene-card-schema.js` `VALID_CAMERA_MOVES` |
| Shot types needing a previs meaning | 18 | `lib/scene-card-schema.js` `VALID_SHOT_TYPES` |
| `camera_control` entries to round-trip to | 18 | `lib/video-prompt.js` `CAMERA_CONTROL_MAP` |
| Aspect ratios the viewport must frame | 12 | `lib/project-presets.js` `ASPECT_RATIO_IDS` |
| Scene-card camera fields today | 3 | `shot_type`, `movement`, `lens` |
| New modules | 5 | this plan |
| Modified modules | 4 | this plan |
| New migrations | 1 | this plan |
| New routes | 6 | this plan |

The 48 registry entries (18 + 18 + 12) are the coverage obligation. A previs tool that handles 15 of 18 moves is not 83% done — it silently cannot express three shots someone has already written into a scene card.

---

## 2. Two findings from reading the vocabulary

Neither is a bug. Both change the design.

### `VALID_SHOT_TYPES` is three lists wearing one coat

The 18 shot types mix three independent axes:

- **framing** (8) — `wide`, `medium`, `close-up`, `extreme-close-up`, `two-shot`, `over-the-shoulder`, `establishing`, `insert`
- **angle** (5) — `low-angle`, `high-angle`, `dutch-angle`, `aerial`, `pov`
- **rig** (5) — `tracking`, `dolly`, `steadicam`, `handheld`, `crane`

For a prompt this is harmless: they are all just tokens appended to a string, and SDXL does something reasonable with each. For a 3D tool it is load-bearing, because the three are computed from different quantities. Framing comes from lens and distance. Angle comes from camera height and pitch. Rig comes from the motion path and constrains what moves are even possible. `crane` and `crane-up` currently live in different enums meaning nearly the same thing, and nothing reconciles them.

The taxonomy assigns every one of the 18 to exactly one axis, and the test asserts that mapping is total. **The enum does not change** — scene cards in the database keep working, and the frontend picker keeps its list. The decomposition is a layer above it.

### Six of the eighteen movements are the same transform

`dolly-in`, `tracking-forward` and `push-in` all translate camera-local −Z. `dolly-out`, `tracking-back` and `pull-out` all translate +Z. They differ in magnitude and rig intent, not direction. The vocabulary has **twelve distinct transforms, not eighteen**.

This is invisible at the prompt layer — three different tokens read as three different shots — and unavoidable in 3D, where they render identically unless magnitude and rig make them differ. Recorded in the taxonomy as `distinctTransforms` so the viewer can say "this is a push-in: a slow dolly-in on a slider" instead of pretending it is a separate primitive.

---

## 3. The central decision: what renders it

`gridlight.json` pins `build.target: single-html` against a 17,659-line SPA with no bundler. The Flows canvas hit this and hand-rolled SVG rather than take React Flow, because the dependency would have meant introducing a build system to ship one page. Previs faces the same wall with higher stakes, since 3D is where "just add a library" is most tempting.

The work splits at exactly the right place:

**Phases 0–3 need no 3D library.** A ground plane grid, boxes or billboards for subjects, a camera frustum, and the camera's own view are a 4×4 matrix pipeline and a polygon painter — a few hundred lines of **canvas 2D**. The camera view is not a second renderer: it is the same projection evaluated from the camera's transform instead of the orbit view's. The hard part is the optics, and those are provider-, renderer- and framework-independent pure functions.

**Phase 4 needs one.** Loading the actual generated `.glb` means glTF parsing, a scene graph and PBR shading. That is **Three.js**, ~150 KB gzipped inlined, and it deserves its own ADR rather than arriving as an implementation detail. Deferring it is not a compromise: grey-box previs at correct scale under a correct lens is what the category is *for*, and FrameForge's own pitch is "photo-accurate scaled sets", where the accuracy is dimensional, not pictorial.

Rejected: doing phase 4 first because the `.glb` files already exist. Tempting, and it inverts the risk — the dependency lands before anything has proven the optics are right.

---

## 4. Module architecture

```
backend/
├── lib/
│   ├── previs-camera.js       NEW  ph0  optics: FOV, framing distance, DOF, hyperfocal
│   └── previs-blocking.js     NEW  ph1  blocking as data; movement paths sampled to keyframes
├── routes/
│   └── previs.js              NEW  ph2  handlePrevis(req, res, parts, query)
├── db/migrations/
│   └── 058_previs_blocking.sql NEW ph2  film_previs_blocking
├── lib/scene-card-schema.js   MOD  ph1  camera gains sensor, aperture, focus_distance_m, height_m
├── lib/video-prompt.js        MOD  ph3  camera_control carries the sampled path when blocked
└── server.js                  MOD  ph2  dispatch the previs namespace

src/index.html                 MOD  ph2  stage view + camera view + inspector
```

Three choices, each following a pattern the codebase already uses:

1. **`lib/` holds the maths, `routes/` holds the HTTP** — same split as `pipeline-engine.js` ↔ `routes/pipeline.js`. The optics are testable with no server, no DB and no DOM, which is what makes phase 0's exit criterion checkable against published tables.
2. **One `handlePrevis(req, res, parts, query)` export**, dispatched by `parts[1]`, per [ADR-002](../adr/002-vanilla-http-no-framework.md).
3. **The scene card enum is extended, never rewritten.** `camera.lens` stays a string so every existing card still validates; the new fields are optional.

### Key interfaces

```js
// lib/previs-camera.js  (phase 0) — pure
fieldOfView(focalMm, sensor)            -> { hDeg, vDeg }
framingDistance(subjectHeightM, focalMm, sensor) -> metres
depthOfField(focalMm, fStop, focusM, sensor)     -> { nearM, farM, hyperfocalM, totalM }
frameCoverage(distanceM, focalMm, sensor)        -> { widthM, heightM }

// lib/previs-blocking.js  (phase 1)
solveShot(shotType, focalMm, sensor, subject)    -> { position, rotation, distanceM }
samplePath(movement, blocking, opts)             -> keyframe[]   // {t, position, rotation, focalMm}
rigCanPerform(rigId, movement)                   -> { ok, reason? }
toCameraControl(blocking, movement)              -> camera_control   // feeds video-prompt.js
```

`solveShot` is the function that makes this worth building. "Close-up on a 50" stops being two tokens and becomes a camera 1.2 m from the subject — and if the room is 3 m deep, previs says so before the shoot.

---

## 5. Schema

One table, `film_previs_blocking`, one row per shot:

- `shot_id` UNIQUE — blocking belongs to a shot, and a shot has one
- `camera_json` — position, rotation, focal, sensor id, f-stop, focus distance
- `subject_json` — placements: character or prop id, position, height
- `stage_json` — the ground plane and any walls
- `rig` — the mount, so affordance can be checked at save time
- `path_json` — the sampled keyframes, stored rather than recomputed

**Blocking is stored sampled, not parametric.** Same reasoning as `film_flow_runs.graph_snapshot`: a `camera_control` derived from a movement enum silently stops meaning anything the moment the enum's default intensity is retuned. Storing the keyframes makes "recreate this shot exactly" survive a change to the taxonomy.

`rig` is a column rather than a field inside `camera_json` because affordance is queried — "show me every shot in this scene that needs the crane" is the scheduling question previs makes answerable, and it should not require parsing JSON in every row.

---

## 6. Phasing

| Ph | Name | Exit criterion |
|---|---|---|
| 0 | Optics as pure functions | For every sensor and every lens in the kit, computed horizontal FOV matches the published value within 0.1°, and hyperfocal matches a reference table within 1%. |
| 1 | Blocking as data | All 18 movements sample to a path whose start and end transforms differ (except `static`), and every framing shot type solves to a distance putting its declared subject height exactly in frame. |
| 2 | The viewer | A shot can be blocked, saved, reloaded and played back in the SPA with no new build step, and `index.html` is still deployable as a single file. |
| 3 | Feed the generator | A blocked shot emits a `camera_control` whose `type` equals what `CAMERA_CONTROL_MAP` already sends for that movement, plus the sampled path. An unblocked shot emits byte-identical output to today. |
| 4 | Real subjects | A character with a generated `.glb` loads into the stage as its actual mesh, and the shot still renders when the model is absent. |

**Phase 3's exit criterion is the load-bearing one.** Previs that does not reach the generator is a drawing tool bolted to a film engine. Requiring byte-identical output for unblocked shots makes phases 0–2 provably additive: nothing that exists today changes behaviour until someone blocks a shot.

Phase 4 is genuinely optional. Phases 0–3 deliver the entire original ask.

---

## 7. Risks

1. **Scope creep into a 3D editor.** The stage is a plane, some boxes and a camera. Set modelling, lighting rigs and character animation are all adjacent and all out. Mitigation: phase 2's exit criterion is a *shot blocked and played back*, not a scene built.
2. **The enum decomposition drifting from the enum.** The taxonomy classifies all 18 shot types; if someone adds a nineteenth, the classification must follow. `previs-plan.test.js` iterates `VALID_SHOT_TYPES`, so it fails rather than silently under-covering.
3. **`index.html` size.** Already ~17.6k lines, and the Flows canvas added ~1.2k. Previs adds a similar amount. The zero-build choice needs a fresh ADR before the third feature of this size, not after.
4. **Optics that look right and are wrong.** A FOV that is 10% off still renders a plausible picture, and nobody notices until a shot does not match on set. Phase 0 checks against published tables rather than against itself.
5. **Rig affordances read as restrictions.** Telling a director the slider cannot do their 3 m track is useful; refusing to save it is not. Affordance violations warn, never block.

---

## 8. Open questions for review

1. **Should previs blocking be a flow node?** `in.previs` emitting a `camera` port would let a graph carry blocking into `gen.video`. Cheap to add later, and phase 3 does not need it.
2. **Does the stage plane need walls?** A room is where framing distance becomes a constraint rather than a suggestion. Plan says plane plus optional walls; full set modelling is out.
3. **One blocking per shot, or versions?** Plan assumes one, matching `UNIQUE(shot_id)`. `film_shot_versions` exists and could hold alternates, at the cost of every read becoming a "which one" question.
4. **Should `camera.lens` become structured?** It is a free string today (`"35mm"`). Parsing it is lossy; adding `focal_mm` alongside is redundant. Plan adds the new field and leaves the string as the human-facing one.
