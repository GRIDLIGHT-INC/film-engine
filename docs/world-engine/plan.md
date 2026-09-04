# Implementation plan — World Engine / Spatial Previs

Step 2 of the spec's order. Builds on [`audit.md`](audit.md) (what the spec
collides with) and [`feasibility.md`](feasibility.md) (can Marble do this).

**This plan is written against the code, not the spec's own data model.** Where
the two disagree, §2 states which wins and why. The spec was written for a
greenfield app; this one has 3,072 lines of previs backend, 105 `previs*`
functions and 284 tests already gating the surface it lands on.

---

## 1. Scope

**One line:** turn a location's plates into a persistent, versioned, navigable
world, and let a director design shots inside it — with every AI judgement made
by the connected MCP model, never a server-side one.

### The complete set, enumerated from code

| Set | Count | Derived from |
|---|---|---|
| New tables | **4** | `film_worlds`, `film_world_versions`, `film_world_assets`, `film_world_sources` |
| Columns added to existing tables | **2** | `film_previs_blocking.world_version_id`, `.world_pinned_at` |
| New modules | **7** | §4 — 6 in `lib/`, 1 in `routes/` |
| New HTTP routes | **17** | §5 |
| New MCP tools | **12** | §6 |
| Marble asset types to ingest | **6** | live payload: collider, pano, thumbnail, splat ×3 |
| Marble prompt types to support | **4** | API vocabulary: `text`, `image`, `multi-image`, `video` |
| Marble models to expose | **4** | API vocabulary: draft, 1.0, 1.1, 1.1-plus |
| Reference kinds after the plate lands | **6** | `KIND_RANK` + `plate` |
| Feature flags | **6** | spec §66 |
| Composition overlays | **11** | design handoff overlay table |
| Director intent presets | **7** | design handoff + spec §35 |
| Explore Shot candidates | **6** | spec §33 |
| Existing registries that must stay in lockstep | **5** | `KIND_RANK`/`KIND_SOURCE`, `MEDIA_KINDS`, `SETTINGS`, `NAV_FLOW`, `film_assets.asset_type` |

**The test that will prove it done** (next step writes it):
`backend/tests/world-engine-plan.test.js` — set-based, deriving its denominator
from those registries rather than a typed list, on the precedent of
`previs-plan.test.js` and `style-book-plan.test.js`. Per phase, the phase's own
set-based test named in §7.

---

## 2. Architectural decisions

Nine decisions. Each names what it rejects and why, because a plan that only
states its choices cannot be argued with.

### D1 — A SpatialShot is `film_previs_blocking` + a world pin, not new tables

**Rejected:** spec §52's `spatial_shots` + `cinema_cameras` pair.

`film_previs_blocking` already holds `camera_json`, `subjects_json`,
`moves_json`, `camera_keys_json`, `director_json`, and both application
fingerprints, under `shot_id UNIQUE`. Adding a second camera store creates two
answers to *where is the camera for this shot* — the exact failure this codebase
has recorded three times (the plate pointer, the frame pointer,
`effectiveCamera`). It would also strand 284 existing tests.

**Two columns, not two tables:**
```sql
ALTER TABLE film_previs_blocking ADD COLUMN world_version_id TEXT
    REFERENCES film_world_versions(id) ON DELETE SET NULL;
ALTER TABLE film_previs_blocking ADD COLUMN world_pinned_at TEXT DEFAULT NULL;
```
`ON DELETE SET NULL`, never CASCADE: deleting a world must not delete the
blocking a director authored inside it — the `film_refsheet_jobs` trap of
migration 067, and the same reasoning `film_assets.shot_id` follows.

### D2 — No `world_generation_jobs` table

**Rejected:** spec §51's separate job table.

`film_generation_jobs` (migration 101) already stores provider, capability,
`request_id`, status, and the project/shot/scene attribution, and the worldlabs
adapter already writes the operation id through `onHandle` **before** polling.
`capability='world'` is already priced in the rate book and resolves to
`worldlabs`. A second job table would be a second answer to *what is running*.

### D3 — Collider + panorama now; splats behind a flag

**Rejected:** spec §9's `npm install three @sparkjsdev/spark`.

Established in `audit.md` §4 by measurement: Spark ships no UMD, peer-requires
three ≥ 0.180, and three ≥ 0.180 ships no UMD — while this page loads six
classic scripts with three r149 UMD inlined. The collider carries every
cinematographic quantity (proven: 28,717 verts / 53,841 tris / 39.6×9.0×47.9,
decimating to the stage's 20,000 budget) and the panorama is equirectangular
2304×1152 at exactly 2.00, sphere-mappable on r149 today.

Splats stay behind `WORLD_SPLATS` with two no-bundler routes named and costed:
`@spz-loader/core` (UMD) feeding a quad shader on r149, or
`@mkkellogg/gaussian-splats-3d` (UMD, three ≥ 0.160).

### D4 — The page id stays `previs`; the console is built behind a flag

**Rejected:** a new `world-engine` page, and a React island.

`NAV_FLOW` puts `previs` in the **Plan** group; the nav button, `PAGE_RELOAD`,
`previsOpenFromBoard`, `navigateTo('previs')` and a dozen tests all address that
id. The design handoff is explicitly *"a full redesign of the Previz screen"* —
so the screen is rebuilt in place, and `WORLD_ENGINE` decides which markup
renders. With the flag off the existing screen is byte-identical, which is what
makes this shippable in phases against a live install.

### D5 — Every AI judgement is an MCP brief/write pair. The engine never calls an LLM.

This is the goal's stated rabbit hole (*"use MCPs wherever we can for AI
queries"*) and it is enforced by `tests/mcp-no-server-llm.test.js`, which derives
its forbidden set from any route module that requires the LLM client.

**Rejected:** spec §31/§33 read as server-side inference.

The connected model **is** the model here. So:

```
engine computes FACTS  →  MCP brief tool  →  model reasons  →  MCP write tool
                                                              →  engine VALIDATES
                                                              →  engine applies
```

`cinematography_brief` hands over world bounds, blocking, current camera,
occupancy, the 180° axis, screen direction and continuity state — **and returns
no conclusion**. `camera_propose` takes the model's `CinematographyProposal`,
validates it against geometry, and stores it. Same shape as
`analysis_brief`/`analysis_write` and `music_brief`/`music_cue_create`, which
this codebase already runs.

**Consequence:** the six Explore Shot candidates are *proposed* by the model and
*rejected* by `lib/camera-validate.js` — a pure module — never generated by a
heuristic pretending to be judgement. §35's intent presets become the **bias
description handed to the model**, not a formula the server applies.

### D6 — Scale is stored on the version and applied on read, once

**Rejected:** baking the factor into stored geometry.

Marble promises no unit; the spike deliberately reported extent as
*uncalibrated*. `scale_factor` lives on `film_world_versions` and is applied in
exactly one place — `worldGeometry()` in `lib/worlds.js`, on the way out. Baking
it in means recalibrating requires re-downloading, and a mesh that has been
scaled twice is indistinguishable from one scaled once.

Until calibrated, `scale_factor IS NULL` and every surface reports
**APPROXIMATE SCALE**. A NULL factor is *not* 1.0: "nobody has measured this"
and "this measures 1:1" are different claims, and conflating them is how a
confident wrong distance reaches a lens calculation.

### D7 — A generation plate is a reference kind ranked 0

**Rejected:** a bespoke plate field on the image payload.

`init_image` exists on the **video** payload only; the image payload carries
references. `KIND_RANK` becomes:

```js
{ plate: 0, anchor: 1, character: 2, location: 3, prop: 4, style: 5 }
```

Relative order among the five existing kinds is **unchanged**, so a project with
no plate selects exactly the references it selected before — the property that
file already documents for the anchor. `KIND_SOURCE.plate = 'previs'`, a fourth
source class beside `entity`/`frame`/`project`; that map exists precisely so a
test does not demand a subject table for a non-entity kind.

The prompt names it the way the anchor is named — *"the first reference image is
a geometric plate: it fixes the camera, the framing and where each subject
stands"* — which is unambiguous on providers that cannot read tags because it
ranks first.

### D8 — World assets are `asset_type='other'` with `metadata.kind`, copied locally

`film_assets.asset_type` has a CHECK that could not be widened in place
(migration 057's trap), and the 3D pipeline already established
`asset_type='other'` + `metadata.kind`. World assets follow it:
`world_collider`, `world_panorama`, `world_thumbnail`, `world_splat_100k`,
`world_splat_500k`, `world_splat_full`.

**They are copied, not linked.** `GET /marble/v1/worlds` is **404** — there is no
list endpoint, so if our row is lost the world is unreachable. Collider,
panorama and thumbnail are copied on ingest (≈4.7 MB); splats are recorded by
URL and fetched only when `WORLD_SPLATS` is on, because full_res is 25 MB per
world.

### D9 — Feature flags live in `SETTINGS` (app-settings), not per project

`SETTINGS` is `{key: {description, default}}` with a served allow-list and an
unknown-key refusal. Six flags, all defaulting **off**:

`WORLD_ENGINE` · `MARBLE_GENERATION` · `CINEMATOGRAPHY_AI` · `REFERENCE_MATCH`
· `CAMERA_EXPLORE` · `WORLD_SPLATS`

Per machine rather than per project, because they gate *whether the feature
exists*, not how a film is made — the same reasoning that put `author` and the
subscription there.

---

## 3. Data model

Migration **102** (`102_world_engine.sql`). Next free number, verified.

```sql
CREATE TABLE film_worlds (
    id                TEXT PRIMARY KEY,
    project_id        TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    scene_id          TEXT REFERENCES film_scenes(id) ON DELETE SET NULL,
    location_id       TEXT REFERENCES film_locations(id) ON DELETE SET NULL,
    name              TEXT NOT NULL,
    description       TEXT NOT NULL DEFAULT '',
    active_version_id TEXT,              -- FK added after versions exists
    locked_at         TEXT DEFAULT NULL, -- §55 world lock
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE film_world_versions (
    id                 TEXT PRIMARY KEY,
    world_id           TEXT NOT NULL REFERENCES film_worlds(id) ON DELETE CASCADE,
    version            INTEGER NOT NULL,
    parent_version_id  TEXT REFERENCES film_world_versions(id) ON DELETE SET NULL,
    provider           TEXT NOT NULL DEFAULT 'worldlabs',
    provider_world_id  TEXT,
    model              TEXT,             -- marble-1.0-draft | 1.0 | 1.1 | 1.1-plus
    status             TEXT NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','approved','production','failed')),
    reason             TEXT NOT NULL DEFAULT '',
    -- NULL means UNCALIBRATED, never 1.0 (D6)
    scale_factor       REAL DEFAULT NULL,
    scale_source       TEXT DEFAULT NULL,
    scale_known_m      REAL DEFAULT NULL,
    scale_measured     REAL DEFAULT NULL,
    caption            TEXT,
    bounds_json        TEXT,             -- from the parsed collider
    job_id             TEXT REFERENCES film_generation_jobs(id) ON DELETE SET NULL,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (world_id, version)
);

CREATE TABLE film_world_assets (
    id               TEXT PRIMARY KEY,
    world_version_id TEXT NOT NULL REFERENCES film_world_versions(id) ON DELETE CASCADE,
    kind             TEXT NOT NULL
                     CHECK (kind IN ('collider','panorama','thumbnail',
                                     'splat_100k','splat_500k','splat_full')),
    remote_url       TEXT,
    asset_id         TEXT REFERENCES film_assets(id) ON DELETE SET NULL,
    bytes            INTEGER,
    metadata_json    TEXT NOT NULL DEFAULT '{}',
    UNIQUE (world_version_id, kind)
);

CREATE TABLE film_world_sources (
    id               TEXT PRIMARY KEY,
    world_version_id TEXT NOT NULL REFERENCES film_world_versions(id) ON DELETE CASCADE,
    source_asset_id  TEXT REFERENCES film_assets(id) ON DELETE SET NULL,
    source_type      TEXT NOT NULL
                     CHECK (source_type IN ('image','multi-image','video','text')),
    azimuth          REAL,
    ordinal          INTEGER NOT NULL DEFAULT 0,
    metadata_json    TEXT NOT NULL DEFAULT '{}'
);
```

Plus the two `film_previs_blocking` columns from D1.

**Why `UNIQUE (world_version_id, kind)`:** re-ingesting a world must replace a
row, not accumulate — the bug that once left six plate rows for three files.

---

## 4. Module map

### New

| File | Responsibility | Key exports |
|---|---|---|
| `backend/lib/worlds.js` | world/version CRUD, ingest, lock, pin, geometry read | `createWorld`, `newVersion`, `ingestWorld`, `worldGeometry`, `lockWorld`, `pinShot`, `versionsFor` |
| `backend/lib/world-scale.js` | calibration maths, pure | `CALIBRATION_SOURCES`, `calibrate`, `toMetres`, `describeScale` |
| `backend/lib/world-assets.js` | download, local copy, serve paths | `ingestAssets`, `assetPath`, `servedUrlFor` |
| `backend/lib/camera-validate.js` | §34 candidate checks, pure | `CHECKS`, `validateCamera`, `sideOfAxis`, `screenDirection` |
| `backend/lib/cinematography.js` | brief building + proposal schema + apply, **pure, no LLM** | `INTENTS`, `buildBrief`, `PROPOSAL_FIELDS`, `validateProposal`, `applyProposal` |
| `backend/lib/generation-plate.js` | plate contract, sizes, what a plate carries | `PLATE_OUTPUTS`, `PLATE_SIZES`, `buildPlateRecord` |
| `backend/routes/worlds.js` | the HTTP surface (§5) | `handleWorlds` |

### Modified

| File | Change | Why |
|---|---|---|
| `backend/lib/reference-images.js` | `plate` in `KIND_RANK`/`KIND_SOURCE` | D7 |
| `backend/lib/shot-references.js` | gather the shot's plate | one gatherer, four paths |
| `backend/lib/capability-payloads.js` | plate reaches the image payload | the one payload path |
| `backend/routes/previs.js` | world pin on get/put blocking | D1 |
| `backend/routes/app-settings.js` | six flags in `SETTINGS` | D9 |
| `backend/lib/mcp-tools.js` | 12 tools (§6) | D5 |
| `backend/server.js` | dispatch `/film/worlds…` **before** the project catch-alls | the `/film/locations/:id` trap |
| `src/index.html` | the console, behind `WORLD_ENGINE` | D4 |

### Interfaces

```js
// lib/world-scale.js — pure, no I/O
const CALIBRATION_SOURCES = ['character_height','door_height','car_length','distance','custom'];
calibrate({ source, knownMeters, measuredUnits }) -> { factor, source, knownMeters, measuredUnits }
toMetres(value, factor)  -> number | null      // null factor => null, never 1.0
describeScale(version)   -> 'APPROXIMATE SCALE' | 'SCALE CALIBRATED'

// lib/worlds.js
createWorld(db, { projectId, sceneId, locationId, name, description }) -> world
newVersion(db, worldId, { parentVersionId, reason, model, sources }) -> version   // never overwrites
ingestWorld(db, versionId, providerWorld) -> { assets, bounds, caption }
worldGeometry(db, versionId, { budget = 2500 }) -> { vertices, triangles, bounds, size, scale }
lockWorld(db, worldId, locked) -> world
pinShot(db, shotId, versionId) -> { pinned, previous }
versionsFor(db, worldId) -> version[]

// lib/camera-validate.js — pure
const CHECKS = ['inside_geometry','subject_behind_camera','clipping','focus_impossible','occluded','line_crossed'];
validateCamera(camera, world, blocking, opts) -> { ok, failures: [{ check, detail }] }
sideOfAxis(point, axis) -> 'A' | 'B' | 'ON_AXIS'
screenDirection(subject, camera) -> 'left' | 'right' | 'centre'

// lib/cinematography.js — pure, NO provider call, NO llm-client require
const INTENTS = ['heroic','vulnerable','oppressive','intimate','chaotic','isolated','cinematic_depth'];
buildBrief(ctx) -> { world, blocking, camera, occupancy, axis, screenDirection, continuity, intents, facts }
const PROPOSAL_FIELDS = ['focalLengthMm','cameraHeightM','dollyM','truckM','pedestalM',
                         'panDeg','tiltDeg','rollDeg','targetOccupancy','framingTarget','rig'];
validateProposal(proposal, brief) -> { ok, errors[] }
applyProposal(camera, proposal) -> camera'          // returns a NEW camera, never mutates
```

`lib/cinematography.js` **must not require `lib/llm-client.js`** — asserted by
the phase-3 test, deriving from the source the way
`mcp-no-server-llm.test.js` already does.

---

## 5. HTTP surface — 17 routes

Registered in `server.js` **before** the `/film/projects/:id/*` catch-alls.

```
POST   /film/projects/:id/worlds              create
GET    /film/projects/:id/worlds              list
GET    /film/worlds/:id                       read (+ active version)
PATCH  /film/worlds/:id                       rename / describe
DELETE /film/worlds/:id                       delete (versions cascade)
POST   /film/worlds/:id/lock                  §55
DELETE /film/worlds/:id/lock                  unlock

GET    /film/worlds/:id/versions              §38
POST   /film/worlds/:id/versions              §39 Improve World — new version, never mutate
GET    /film/world-versions/:vid              read
POST   /film/world-versions/:vid/calibrate    §12
GET    /film/world-versions/:vid/geometry     collider, decimated, scale applied
GET    /film/world-versions/:vid/plan         FREE — what a generation would cost
GET    /film/worlds/media/:pid/:file          serve local copies

POST   /film/shots/:id/world                  pin (§56)
DELETE /film/shots/:id/world                  unpin
POST   /film/shots/:id/generation-plate       §45
```

Generation itself reuses `POST /film/world-versions/:vid/generate` →
`providers.resolve('world')` → `film_generation_jobs`. `…/plan` is free and
priced through the same path the run uses, so the number in the confirmation is
the number charged.

---

## 6. MCP surface — 12 tools

Every one is how an agent drives this, per the goal's rabbit hole.

| Tool | Spends | Purpose |
|---|---|---|
| `world_create` | no | |
| `world_list` | no | |
| `world_get` | no | world + versions + pins |
| `world_generate` | **yes** | the only spending tool here |
| `world_plan` | no | projected credits before spending |
| `world_calibrate` | no | §12 |
| `world_lock` | no | §55 |
| `world_pin_shot` | no | §56 |
| `cinematography_brief` | no | **facts only, no conclusion** (D5) |
| `camera_propose` | no | the model writes its proposal back; engine validates |
| `camera_explore_brief` | no | six-candidate brief |
| `generation_plate` | no | render + register the plate |

`world_generate` must be named in the guide's *What costs money* section, or
`mcp-guide.test.js` fails — a derived check that already exists.

---

## 7. Phases

Each phase ends with a **set-based** test whose denominator is derived, and each
is shippable with the flag off.

### Phase 1 — MVP 1 · the world exists
Migration 102; `lib/worlds.js`, `world-scale.js`, `world-assets.js`;
`routes/worlds.js` + server dispatch; generation through the wired adapter
reusing `film_generation_jobs`; ingest all 6 asset kinds, copying 3; collider in
the existing canvas-2D stage and r149 pane; equirect panorama backdrop; scale
calibration; version pinning; world lock; flags in `SETTINGS`.

**Also in phase 1, while the code is open** — the two defects `audit.md` §2d/§2e
verified: the client `previsProject` missing its near-vertical up-reference
fallback (a TOP view preset walks straight into it), and `fromCard` discarding
its own azimuth solve at `routes/previs.js:1122`.

*Test:* `world-engine.test.js` — set-based over the 6 asset kinds, 4 prompt
types, 4 models, 5 calibration sources; a version is never overwritten; a NULL
factor never reads as 1.0; a deleted world leaves blocking intact.

### Phase 2 — MVP 2 · the console
The handoff screen behind `WORLD_ENGINE`: camera view hero, 11 overlays, lens /
operate / blocking panels, occupancy, measurements, Keep Position vs Maintain
Size.

*Test:* `world-console.test.js` — set-based over the 11 overlays and the 12
lens buttons; every control reaches a real value; flag off ⇒ old screen
byte-identical.

### Phase 3 — MVP 3 · directing
`lib/cinematography.js`, `lib/camera-validate.js`, the brief/propose tools,
Explore Shot ×6, 180° axis, screen direction, camera compare.

*Test:* `cinematography.test.js` — set-based over the 7 intents and the 6
validation checks; **and an assertion that no module in this feature requires
the LLM client**, derived from source.

### Phase 4 — MVP 4 · motion
Timeline UI over the **existing** legs/keys/easing model; camera path drawn in
the spatial pane. Mostly frontend — the model is already built.

*Test:* `world-timeline.test.js` — set-based over the 4 easings + `hold`.

### Phase 5 — MVP 5 · the bridge
`lib/generation-plate.js`; `plate` in `KIND_RANK`/`KIND_SOURCE`; the plate
reaches the image payload through the one path; depth + masks; video prompt
carries the camera move as prose.

*Test:* `generation-plate.test.js` — differential: with a plate attached, what
the provider receives must change; relative order of the 5 existing reference
kinds must not.

### Phase 6 — the rest
Match Reference (§30 **V1 manual-assist only** — user marks horizon and subject
box; no CV), shot complexity (§49), export (§50).

---

## 8. Deviations from the spec, stated

| Spec | Plan | Why |
|---|---|---|
| §9 Spark + npm | collider + pano on r149; splats flagged | audit §4 — Spark needs three ≥0.180, which ships no UMD |
| §52 `spatial_shots` + `cinema_cameras` | `film_previs_blocking` + 2 columns | D1 — a second camera store |
| §51 `world_generation_jobs` | `film_generation_jobs` | D2 — already built |
| §63–65 React components | vanilla, page id `previs` | D4 — ADR-002, no bundler |
| §31/§33 "Cinematography AI" | MCP brief/write pairs | D5 — the goal's rabbit hole |
| §67 MVP1 "Spark viewer" | collider + panorama | D3 — stated substitution |
| §46 plate sizes | project aspect × delivery raster | the engine already computes this |

---

## 9. Risks

1. **Scale is load-bearing and unsolved upstream.** Until §12 lands every
   distance and focal number is decorative. It is in phase 1 deliberately.
2. **Rebuilding `page-previs` touches 105 functions and 284 tests.** The flag is
   what makes this survivable; parity tests string-extract functions out of
   `index.html` by regex, so renames break tests in ways that read as
   regressions.
3. **A draft world has no hq mesh.** If collider fidelity is too coarse for
   framing, cost per world goes $0.20 → ~$1.28 and the iterate-cheaply argument
   weakens.
4. **`GET /worlds` is 404.** Ingestion must be durable before generation is
   exposed, or a lost row is an unreachable paid world.
5. **The page is 2.5 MB.** Every addition is parsed on every load.
