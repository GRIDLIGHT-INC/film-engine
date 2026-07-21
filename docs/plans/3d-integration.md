# Film Engine — 3D Asset Generation Integration (Implementation Plan)

**Author:** Architecture design step (NeonCore workflow)
**Status:** Design — review before tests are written
**Scope:** Add a first-class 3D asset domain to Film Engine that proxies Gridlight's `/3d` endpoints, following the established proxy/BFF pattern (`gridlight-client` → per-domain route → `film_*_jobs` table → `film_assets` registry → SPA slice).

---

## 1. Context & Grounding

### 1.1 What already exists (verified)
- **Proxy layer** — `backend/lib/gridlight-client.js` exposes `callGridlight(endpoint, payload, opts)`, `relayGridlightSSE(endpoint, payload, res, callbacks)`, `checkEndpointHealth`, `serviceUnavailableError`, plus a per-endpoint semaphore queue (`MAX_CONCURRENT=2`), 429 retry, and (new) client-disconnect hardening. Env: `GRIDLIGHT_URL` / `GRIDLIGHT_API_KEY`.
- **Per-domain route convention** — each domain (`video-gen.js`, `voice.js`, `music-gen.js`, …) exports one `handleXxx(req, res, urlParts, query)` router that: validates UUIDs via a local `UUID_RE`, branches on `urlParts`, and offers `generate` / `generate/stream` / `batch` / `batch/stream` / `GET status` / file-serve sub-routes.
- **File storage** — `backend/lib/file-storage.js` `serveFile(res, projectId, subdir, filename)` already sanitizes filenames + enforces path containment, and its MIME map **already includes** `.glb`, `.gltf`, `.fbx`, `.obj`, `.usdz`. The `'3d'` subdir is already named in its doc comment. No change needed to serve 3D files.
- **Job-table convention** — e.g. `film_video_jobs` (migration 021): `id, project_id, shot_id, status CHECK(...), model, seed, output_path, error_message, params, created_at` + indexes.
- **Asset registry** — `film_assets` (migration 015) with FKs `shot_id`, `character_id`, `location_id`, a `metadata` JSON column, and a **restrictive `asset_type` CHECK** that currently lists NO 3D types.

### 1.2 Two facts the plan must correct
1. **Stale docs.** `GRIDLIGHT_API_REFERENCE.md` §7 marks `/3d/*` as *"planned, not yet implemented."* The Research step confirms Gridlight **dev** now serves `/3d` generate / from-image / batch / job / job-stream / assets, plus `rig` / `retexture` / `animate` / `animations` / `queue`. Treat `/3d` as live; refresh the doc.
2. **Stale env names.** `gridlight-client.js` still falls back to `GATEWAY_URL` / `IMAGEGEN_API_KEY`, and `CLAUDE.md` / route comments reference `IMAGEGEN_URL`. Canonicalize on `GRIDLIGHT_URL` / `GRIDLIGHT_API_KEY` (keep old names as deprecated fallbacks for one release).

---

## 2. Component Breakdown

| # | Component | New/Changed | File |
|---|-----------|-------------|------|
| C1 | 3D endpoint constants + (optional) health probe | changed | `backend/lib/gridlight-client.js` |
| C2 | 3D prompt/payload builder (pure fn, unit-testable) | **new** | `backend/lib/threed-prompt.js` |
| C3 | 3D route handler (proxy + jobs + asset registration) | **new** | `backend/routes/threed.js` |
| C4 | DB migration: `film_3d_jobs` + extend `film_assets.asset_type` | **new** | `backend/db/migrations/042_threed_generation.sql` |
| C5 | Server route wiring | changed | `backend/server.js` |
| C6 | Frontend "3D Assets" slice | changed | `src/index.html` |
| C7 | Docs + env canonicalization | changed | `GRIDLIGHT_API_REFERENCE.md`, `CLAUDE.md`, `docs/api-film.md` |
| C8 | Tests (next step — not this step) | new | `backend/tests/threed-prompt.test.js`, integration additions |

---

## 3. Interfaces

### 3.1 C1 — `gridlight-client.js` (additive, non-breaking)
No signature changes. Add exported endpoint constants for discoverability and to keep route files free of string literals:

```js
// Gridlight 3D endpoints (dev branch feature/3d-generation)
const THREED_ENDPOINTS = {
  generate:    '/3d/generate',
  fromImage:   '/3d/from-image',
  batch:       '/3d/batch',
  job:         (jobId) => `/3d/job/${jobId}`,
  jobStream:   (jobId) => `/3d/job/${jobId}/stream`,
  assets:      '/3d/assets',
  asset:       (assetId) => `/3d/assets/${assetId}`,
  rig:         '/3d/rig',
  retexture:   '/3d/retexture',
  animate:     '/3d/animate',
  animations:  '/3d/animations',
  queue:       '/3d/queue',
};
module.exports = { ...existing, THREED_ENDPOINTS };
```
Rationale: mirrors how `VIDEO_ENDPOINT`/`STITCH_ENDPOINT` live as constants, but centralizes the 3D family because it has more members. Env canonicalization (drop stale fallbacks) is a one-line change here.

### 3.2 C2 — `lib/threed-prompt.js` (pure, no I/O — the unit-test seam)
```js
/**
 * Build a Gridlight /3d/generate payload from a character/prop/scene-card context.
 * Pure function: deterministic, no DB, no network — mirrors video-prompt.js.
 */
function build3DPayload(subject, opts) { /* → { prompt, negative_prompt, format, quality, seed, model, target_polycount, symmetry, texture_resolution } */ }

/** Build a /3d/from-image payload (single reference image → mesh). */
function buildFromImagePayload(imageUrlOrRef, opts) { /* → { init_image, format, remove_background, ... } */ }

/** Map an optional rig/animate request to Gridlight's rig/animate payloads. */
function buildRigPayload(assetRef, opts) { /* → { asset_id, skeleton, ... } */ }
function buildAnimatePayload(assetRef, clipName, opts) { /* → { asset_id, animation, loop, fps, ... } */ }

module.exports = { build3DPayload, buildFromImagePayload, buildRigPayload, buildAnimatePayload };
```
`subject` is a normalized `{ name, appearance_prompt, category: 'character'|'prop'|'set', style_preset }`. Defaults: `format='glb'`, `quality='standard'`, `seed=-1`.

Rationale: keeps all prompt logic pure and covered by fast unit tests (same split as `video-prompt.js` ↔ `video-gen.js`); the route file stays thin orchestration.

### 3.3 C3 — `routes/threed.js` → `handleThreeD(req, res, urlParts, query)`

Route surface (all under `/film`):

| Method | Path | Handler | Notes |
|--------|------|---------|-------|
| POST | `/film/characters/:id/model/generate[/stream]` | `generateForCharacter` | text→mesh from character appearance |
| POST | `/film/props/:id/model/generate[/stream]` | `generateForProp` | text→mesh from prop |
| POST | `/film/characters/:id/model/from-image[/stream]` | `generateFromImage` | uses existing `character_sheet`/`reference_image` asset as init |
| POST | `/film/models/:assetId/rig` | `rigModel` | proxy `/3d/rig` |
| POST | `/film/models/:assetId/retexture` | `retextureModel` | proxy `/3d/retexture` |
| POST | `/film/models/:assetId/animate` | `animateModel` | proxy `/3d/animate` |
| GET | `/film/models/:assetId/animations` | `listAnimations` | proxy `/3d/animations` |
| POST | `/film/projects/:id/models/batch[/stream]` | `batchGenerate` | all characters+props |
| GET | `/film/projects/:id/models` | `listModelJobs` | job list + assets |
| GET | `/film/models/job/:jobId` | `getJob` | local job row (+ optional upstream refresh) |
| GET | `/film/3d/:projectId/:filename` | `serveFile(res, pid, '3d', file)` | serve `.glb`/etc. |

Internal contract per generation handler (mirrors `generateVideoStream`):
1. Load + validate subject (`UUID_RE`, 404 if missing).
2. Insert `film_3d_jobs` row `status='generating'`.
3. **Streaming path** → `relayGridlightSSE(THREED_ENDPOINTS.generate, payload, res, { onComplete, onError })`; on `onComplete` write the `.glb` under `data/3d/{projectId}/`, register a `film_assets` row (`asset_type='model_3d'`), update job `complete`. Apply the same SSE client-disconnect guard already standardized (`clientGone` flag + `res.writableEnded` guard on `sendEvent` + loop break in `batch*`).
4. **Non-stream path** → `callGridlight(...)`, `saveFile(projectId, '3d', filename, buffer)`, register asset, return JSON.
5. On failure → job `failed` + structured error via `serviceUnavailableError` semantics.

Async long-jobs: if Gridlight returns a `job_id` rather than an inline binary (mesh gen is slow), the handler persists `upstream_job_id` and exposes `GET /film/models/job/:jobId` which polls `THREED_ENDPOINTS.job(id)` (or relays `THREED_ENDPOINTS.jobStream(id)`), rather than blocking the request.

SSE event contract (client-facing, consistent with other domains):
```
{ type:'status',   phase:'starting', subject_id, job_id }
{ type:'progress', phase:'meshing'|'texturing'|'rigging', pct }
{ type:'complete', asset_id, model_url, format }   // or type:'error', error
{ type:'done' }
```

### 3.4 C4 — Migration `042_threed_generation.sql`
```sql
-- 3D generation job tracking
CREATE TABLE IF NOT EXISTS film_3d_jobs (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    character_id    TEXT REFERENCES film_characters(id) ON DELETE SET NULL,
    prop_id         TEXT,                         -- props have no FK table row constraint elsewhere
    subject_kind    TEXT NOT NULL DEFAULT 'character'
                    CHECK (subject_kind IN ('character','prop','set','shot')),
    gen_type        TEXT NOT NULL DEFAULT 'generate'
                    CHECK (gen_type IN ('generate','from_image','rig','retexture','animate')),
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','generating','complete','failed','cancelled')),
    upstream_job_id TEXT DEFAULT '',              -- Gridlight async job id, if any
    model           TEXT DEFAULT 'hunyuan3d',
    format          TEXT DEFAULT 'glb',
    seed            INTEGER DEFAULT -1,
    prompt          TEXT DEFAULT '',
    output_path     TEXT DEFAULT '',
    error_message   TEXT DEFAULT '',
    params          TEXT DEFAULT '{}',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_3d_jobs_project ON film_3d_jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_3d_jobs_character ON film_3d_jobs(character_id);
CREATE INDEX IF NOT EXISTS idx_3d_jobs_status ON film_3d_jobs(status);
```

**`film_assets.asset_type` extension (decision required — see §5.1).** SQLite cannot `ALTER` a `CHECK`, so the additive-migration options are:
- **(A) Table rebuild** in `042`: `CREATE film_assets_new` with the CHECK list extended by `'model_3d','model_rigged','model_animated','texture'`, `INSERT ... SELECT`, drop old, rename, recreate indexes. Clean data model; heavier, destructive-shaped migration.
- **(B) Discriminated `'other'`**: register 3D assets as `asset_type='other'` with `metadata.kind='model_3d'`. Zero-risk migration; pollutes `'other'` and complicates queries/exports.

**Recommendation: (A)** — a one-time rebuild keeps queries, NLE/bundle export, and QA scoping honest. Gate it behind `PRAGMA foreign_keys=OFF` within the migration transaction and re-verify FKs after (the schema runner runs each file in order; confirm it wraps in a transaction).

### 3.5 C5 — `server.js` wiring
- Import: `const { handleThreeD } = require('./routes/threed');`
- Add `'3d'` (and `'models'`) to the reserved top-level segment list (currently line ~156 lists `breakdown, storyboard, voice, video, …`) so `parts[1]` matching doesn't collide with `:id`.
- Add dispatch branches next to the other generation routes (~line 478–540 & 683–709):
  - `parts[1]==='characters' && parts[3]==='model'` → `handleThreeD`
  - `parts[1]==='props' && parts[3]==='model'` → `handleThreeD`
  - `parts[1]==='models'` → `handleThreeD`
  - `parts[1]==='projects' && parts[3]==='models'` → `handleThreeD`
  - `parts[1]==='3d' && parts[2] && parts[3]` → file-serve via `handleThreeD`
- Ordering: place the `3d`/`models` file-serve + reserved-segment checks **before** generic `:id` project/character routes, matching how `storyboards`/`refsheets` serve-routes sit at the top of the dispatch block.

### 3.6 C6 — Frontend slice (`src/index.html`)
- New left-nav entry **"3D Assets"** (pattern: existing Continuity/Budget panels).
- Per-character / per-prop **"Generate 3D"** button in the asset registry that opens an SSE progress modal (reuse the existing storyboard/video streaming-progress component + animated dots).
- **model-viewer** for preview: embed `<model-viewer>` (web component) for `.glb`. NOTE: this is the one new client dependency — must be vendored locally (no CDN) to match the offline-SPA constraint; if that's unacceptable, fall back to a thumbnail + download link (no inline 3D preview).
- Batch action on the project dashboard: "Generate all character/prop models" → `POST /film/projects/:id/models/batch/stream`.

### 3.7 C7 — Docs & env
- `GRIDLIGHT_API_REFERENCE.md` §7: remove "planned", document the live request/response + job-stream + rig/retexture/animate shapes actually observed.
- `CLAUDE.md`: add the 3D route row to the API table, add `film_3d_jobs` to Core Tables, add a "3D Asset Generation" concept blurb, and correct `IMAGEGEN_URL/IMAGEGEN_API_KEY` → `GRIDLIGHT_URL/GRIDLIGHT_API_KEY`.
- `docs/api-film.md`: full endpoint docs for the new routes.

---

## 4. Data & Control Flow

```
SPA (3D Assets slice)
  │  POST /film/characters/:id/model/generate/stream
  ▼
server.js dispatch ──► routes/threed.js:handleThreeD
  │                        │ 1. validate + load character
  │                        │ 2. build3DPayload()  (lib/threed-prompt.js)
  │                        │ 3. INSERT film_3d_jobs (generating)
  │                        ▼
  │                   gridlight-client.relayGridlightSSE('/3d/generate', …)
  │                        │  ── queue / 429 retry / disconnect-abort ──►  Gridlight /3d
  │                        │ onComplete:
  │                        │   saveFile(pid,'3d',`${name}.glb`)   (lib/file-storage.js)
  │                        │   INSERT film_assets (model_3d)
  │                        │   UPDATE film_3d_jobs (complete)
  ▼                        ▼
SSE events ◄──────────── sendEvent({type:'complete', model_url})
GET /film/3d/:pid/:file ─► serveFile(...,'3d',...)  → <model-viewer>
```

---

## 5. Key Decisions & Rationale

**5.1 New `film_3d_jobs` table + `asset_type` rebuild (not `'other'`).** Every generation domain owns a jobs table and registers typed assets; QA, NLE export, and project-bundle all query `asset_type`. Overloading `'other'` would silently exclude 3D from those subsystems. A one-time table rebuild is the honest cost. *(Reversible: down-path is another rebuild dropping the values.)*

**5.2 Keep Film Engine as orchestrator/BFF; do not call Gridlight from the SPA.** Preserves the ADR-004 proxy architecture — queueing, 429 retry, auth, and disconnect hardening only exist in `gridlight-client`. The SPA never holds `GRIDLIGHT_API_KEY`.

**5.3 Pure `threed-prompt.js` seam.** Isolates deterministic payload logic for fast unit tests and mirrors the existing `*-prompt.js` ↔ `*-gen.js` split; the route file stays thin and I/O-only.

**5.4 Async job model for slow mesh gen.** Mesh generation can exceed a single request's patience. Persist `upstream_job_id` and expose a poll/stream status route instead of blocking, so a dropped connection never loses a running GPU job (consistent with the SSE-disconnect fix already landed).

**5.5 Reuse `file-storage` unchanged.** MIME types and path-containment for `.glb/.gltf/.fbx/.obj/.usdz` already exist; only a new `'3d'` subdir string is used. Zero new attack surface in file serving.

**5.6 `<model-viewer>` vendored, with graceful fallback.** The offline-SPA/no-CDN constraint forbids remote scripts; vendoring is required, and a thumbnail+download fallback keeps the feature usable if 3D preview is deferred.

---

## 6. Risks & Open Questions
1. **Gridlight `/3d` contract is undocumented here** — exact request fields, whether generate returns inline binary vs `job_id`, and streamed progress event names must be confirmed against dev before finalizing `threed-prompt.js` and the SSE contract. *(Blocking for C2/C3 detail.)*
2. **`asset_type` rebuild vs. schema-runner transaction semantics** — verify `db/schema.js` runs each migration in a transaction and tolerates a table rebuild; if not, wrap explicitly.
3. **Props have no dedicated FK in `film_assets`** — `prop_id` is carried in `film_3d_jobs` and in `film_assets.metadata`, not as an FK. Acceptable, but confirm existing prop-asset code does the same.
4. **`<model-viewer>` bundle size** vs. the single-file SPA — may push toward the thumbnail-only fallback for v1.
5. **Which subjects get 3D?** Characters + props are clear; "set/scene" meshes are speculative — recommend scoping v1 to characters + props only.

---

## 7. Suggested Build Sequence (for the implementation step)
1. `042` migration (jobs table + asset_type rebuild) → run server, confirm migration applies clean.
2. `lib/threed-prompt.js` (pure) + `backend/tests/threed-prompt.test.js`.
3. `gridlight-client.js` endpoint constants + env canonicalization.
4. `routes/threed.js` — non-stream generate first (simplest round-trip), then stream, then batch, then rig/retexture/animate.
5. `server.js` wiring + reserved-segment update.
6. Integration tests: 3D proxy contract (mock Gridlight), job-status/SSE behavior, path-traversal + UUID validation on serve route.
7. Frontend slice.
8. Docs + env cleanup (C7).

---

## 8. Interface Summary (quick reference)
- `build3DPayload(subject, opts) → payload`
- `buildFromImagePayload(imageRef, opts) → payload`
- `buildRigPayload/ buildAnimatePayload(assetRef, …) → payload`
- `handleThreeD(req, res, urlParts, query)` — single domain router
- `film_3d_jobs(id, project_id, character_id, prop_id, subject_kind, gen_type, status, upstream_job_id, model, format, seed, prompt, output_path, error_message, params, created_at)`
- `film_assets.asset_type += {'model_3d','model_rigged','model_animated','texture'}`
- Serve: `GET /film/3d/:projectId/:filename`
- `THREED_ENDPOINTS` map in `gridlight-client.js`
