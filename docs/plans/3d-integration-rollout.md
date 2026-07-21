# Film Engine 3D Integration — Rollout & Completion Plan

**Status:** Complete — Milestones A (tests), B (frontend), C (docs), D (LOW fix) all landed. Full suite 533 pass / 0 fail. Frontend slice needs manual in-app verification (backend is API-only).
**Branch:** `fix/sse-client-disconnect-hardening` (2 commits: `d81ff97` SSE hardening, `e490e15` 3D pipeline)
**Companion doc:** `docs/plans/3d-integration.md` (architecture/design)

This plan consolidates what has shipped, records test/security results, and lays out the remaining milestones with dependencies, acceptance criteria, and manual-testing instructions to bring the 3D feature to done.

---

## 1. What Has Been Implemented (landed in `e490e15`)

| Area | File | Change |
|------|------|--------|
| Migration | `backend/db/migrations/042_threed_generation.sql` | `film_3d_jobs` table (typed source of truth) + 6 indexes |
| Payload logic | `backend/lib/threed-prompt.js` | Pure builders: `normalizeSubject`, `build3DPayload`, `buildFromImagePayload`, `buildRigPayload`, `buildRetexturePayload`, `buildAnimatePayload` + format/quality validation |
| Route | `backend/routes/threed.js` | `handleThreeD` router — generate / from-image / rig / retexture / animate / batch / list / job-status / file-serve; sync + SSE paths; async job-handoff (202 + poll); graceful 503; SSE client-disconnect guard |
| Client | `backend/lib/gridlight-client.js` | `THREED_ENDPOINTS` map + export |
| Wiring | `backend/server.js` | Route dispatch for `/characters\|props/:id/model/*`, `/projects/:id/models[/batch]`, `/models/:assetId/*`, `/models/job/:id`, `/3d/:pid/:file`; 3D verbs added to `GENERATION_ROUTES` rate-limit bucket |
| Docs | `CLAUDE.md` | API rows, `film_3d_jobs` Core Table entry, "3D Asset Generation" concept blurb |

**Also landed in `d81ff97` (prerequisite hardening, reused by 3D SSE handlers):** client-disconnect guards (`clientGone` flag + `res.writableEnded` guard on `sendEvent` + loop break) across `gridlight-client.js`, `breakdown.js`, `screenplay-ai.js`, `storyboard.js`, `voice.js`, `video-gen.js`, `lipsync.js`, `music-gen.js`, `post-production.js`, `pipeline.js`, and a headers-sent guard in `server.js`.

### Key design decision (recorded)
`film_assets.asset_type` CHECK could **not** be widened in place: SQLite cannot `ALTER` a CHECK, and the migration runner (`db/schema.js`) wraps every file in a transaction where `PRAGMA foreign_keys=OFF` is a no-op — so the SQLite-safe table-rebuild would null `film_video_jobs.keyframe_asset_id` via `ON DELETE SET NULL`. 3D outputs are therefore registered as `asset_type='other'` with a `metadata.kind` discriminator (`model_3d`/`model_rigged`/`model_animated`), matching the existing reference-sheet convention. `film_3d_jobs` is the typed query surface.

---

## 2. Test & Security Results To Date

- **Migration:** applies clean; `film_3d_jobs` + 6 indexes confirmed present.
- **Unit smoke:** all `threed-prompt` builders produce expected payloads (verified via node one-liner).
- **Full suite:** `node --test backend/tests/*.test.js` → **494 pass / 0 fail / 0 skipped** (no regressions; no new 3D tests yet — see Milestone A).
- **Live e2e (server on :3100, Gridlight offline):**
  - invalid subject id → `400`; unknown character → `404`; unknown job → `404`; unknown-project model list → `200` empty.
  - path-traversal on `/film/3d/:pid/:file` (encoded `../`, absolute) → `400/404`.
  - real character generate with Gridlight down → `503`, job row recorded `failed` with error message.
  - batch stream emits `status` → `subject_start` → `subject_failed` SSE events (disconnect-guarded).
- **Security gate:** **PASS** — 0 CRITICAL/HIGH; `npm audit --audit-level=high` → 0 vulnerabilities. Findings all LOW/informational (see Milestone D).

---

## 3. Remaining Milestones

### Milestone A — 3D Test Coverage *(highest priority; unblocks confidence)*
**Depends on:** landed backend (done).
**Deliverables:**
- `backend/tests/threed-prompt.test.js` (pure unit) — assert:
  - `build3DPayload` defaults (`format=glb`, `model=hunyuan3d`, `seed=-1`, `target_polycount=30000`, `texture_resolution=1024`).
  - format/quality clamping (invalid → whitelist default).
  - `symmetry` rule: `true` for characters, `false` for props (unless overridden).
  - `normalizeSubject` character (joins appearance/build/hair/distinguishing/ethnicity) vs prop (visual_prompt + description) vs empty-row fallbacks.
  - `buildFromImagePayload` / `buildRigPayload` / `buildRetexturePayload` / `buildAnimatePayload` field shapes + defaults.
- Integration additions (mock Gridlight gateway, in the style of `backend/tests/integration.test.js`):
  - **sync generate** → inline buffer response → `film_assets` row (`asset_type='other'`, `metadata.kind='model_3d'`) + `film_3d_jobs` `complete` + `output_asset_id` linked.
  - **async handoff** → `{job_id}` response → `202` + `poll` URL + job `upstream_job_id` set, status `generating`.
  - **SSE stream** → `status`/`complete`/`done` events; client-disconnect aborts the loop (no further calls).
  - **offline 503** → job `failed`.
  - **serve route** → traversal/UUID validation (`400`), missing file (`404`), valid `.glb` (`200`, `model/gltf-binary`).
  - **batch** → mixed complete/failed accounting.
**Acceptance criteria:** new tests pass; suite count increases above the 494 baseline; `node --test backend/tests/*.test.js` green.

### Milestone B — Frontend "3D Assets" slice
**Depends on:** Milestone A (contract locked by tests).
**Deliverables (in `src/index.html`):**
- Left-nav "3D Assets" panel (pattern: Continuity/Budget slices).
- Per-character/per-prop **"Generate 3D"** button opening an SSE progress modal (reuse storyboard/video streaming component + animated dots).
- Project dashboard **"Generate all models"** → `POST /film/projects/:id/models/batch/stream`.
- Preview: **vendored** `<model-viewer>` for `.glb` (no CDN — offline-SPA constraint), with a thumbnail + download-link fallback if bundle size is unacceptable.
**Acceptance criteria:** buttons trigger the endpoints; progress streams render; completed models list/preview via `GET /film/projects/:id/models` and `GET /film/3d/:pid/:file`.

### Milestone C — Docs & Env polish *(plan C7)*
**Depends on:** none (can run anytime).
**Deliverables:**
- `GRIDLIGHT_API_REFERENCE.md` §7: remove "planned"; document the live `/3d` request/response + job-stream + rig/retexture/animate shapes actually observed on dev.
- `docs/api-film.md`: full endpoint docs for the new routes.
- Confirm env canonicalization messaging (`GRIDLIGHT_URL`/`GRIDLIGHT_API_KEY`; deprecated `GATEWAY_URL`/`IMAGEGEN_*` fallbacks noted).
**Acceptance criteria:** no doc references 3D as "planned"; new routes documented.

### Milestone D — Security defense-in-depth *(optional, LOW)*
**Depends on:** none.
**Deliverable:** in `generateFromImage` (`routes/threed.js`), validate `refAsset.file_name` against `^[\w.-]+$` before `getFilePath`/`readFileSync` (belt-and-suspenders; content already only flows to trusted Gridlight, not the client).
**Acceptance criteria:** malformed `file_name` is rejected before disk read; existing from-image flow still works.

---

## 4. Open Dependency / Unknown
**Live Gridlight `/3d` contract** — the route already handles all three response shapes (inline binary, `{model_url}`, `{job_id}`), but the mock integration tests (Milestone A) should assert against whichever dev actually returns for `/3d/generate`, `/3d/from-image`, `/3d/rig|retexture|animate`, and `/3d/animations`. Confirm on the Gridlight dev branch before finalizing test fixtures. This is the only external unknown; it does not block Milestone A unit tests, only the integration fixtures.

---

## 5. Manual Testing Instructions

Prereqs: `cd backend && npm install`. Use an isolated DB so you don't touch real data:

```bash
export FILM_DATA_DIR="$(mktemp -d)/data"
node backend/server.js            # serves on http://localhost:3100
```

### 5.1 Health + fixtures
```bash
curl -s localhost:3100/api/health
PID=$(curl -s -X POST localhost:3100/film/projects -H 'Content-Type: application/json' \
      -d '{"title":"3D Test","logline":"x"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
CID=$(curl -s -X POST "localhost:3100/film/projects/$PID/characters" -H 'Content-Type: application/json' \
      -d '{"name":"Jax","appearance_prompt":"rugged bounty hunter"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
```

### 5.2 Validation & error paths (no Gridlight required)
```bash
# invalid subject id -> 400
curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:3100/film/characters/not-a-uuid/model/generate
# unknown character -> 404
curl -s -X POST localhost:3100/film/characters/11111111-1111-4111-8111-111111111111/model/generate
# path traversal on serve route -> 400/404
curl -s -o /dev/null -w "%{http_code}\n" "localhost:3100/film/3d/$PID/..%2f..%2f..%2fetc%2fpasswd"
# generate with Gridlight offline -> 503, job recorded failed
curl -s -o /dev/null -w "%{http_code}\n" -X POST "localhost:3100/film/characters/$CID/model/generate" \
     -H 'Content-Type: application/json' -d '{"format":"glb"}'
curl -s "localhost:3100/film/projects/$PID/models"   # jobs[0].status == "failed"
```

### 5.3 Happy path (requires Gridlight dev reachable at GRIDLIGHT_URL)
```bash
export GRIDLIGHT_URL=http://<gridlight-dev-host>:8080
export GRIDLIGHT_API_KEY=<token>
# restart the server with these set, then:
curl -s -X POST "localhost:3100/film/characters/$CID/model/generate" \
     -H 'Content-Type: application/json' -d '{"format":"glb","quality":"standard"}'
# -> {job_id, status:"complete", asset_id, model_url}  (or 202 + poll URL if async)
curl -s "localhost:3100/film/models/job/<jobId>"      # poll if async
curl -s -o model.glb "localhost:3100$model_url"       # download served mesh

# SSE streaming
curl -sN -X POST "localhost:3100/film/characters/$CID/model/generate/stream" \
     -H 'Content-Type: application/json' -d '{}'      # status -> complete -> done

# batch all characters+props
curl -sN -X POST "localhost:3100/film/projects/$PID/models/batch/stream" \
     -H 'Content-Type: application/json' -d '{}'
```

### 5.4 Regression check
```bash
node --test backend/tests/*.test.js   # expect all green (>= 494 + new 3D tests)
```

---

## 6. Suggested Execution Order
1. **Milestone A** (tests) — confirm live `/3d` contract first (§4), then unit → integration.
2. **Milestone D** (LOW fix) — trivial, fold in with A.
3. **Milestone C** (docs/env) — anytime, ideally with A.
4. **Milestone B** (frontend) — after A locks the contract.

Each milestone is independently landable; A + D are the natural next PR increment, keeping the current backend branch green and reviewable.
