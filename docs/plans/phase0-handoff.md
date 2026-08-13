# Phase 0 — Change Log, Test Results & Manual Verification

**Branch:** `phase0-shared-payload-builders` (4 commits, local only — not pushed, no PR)
**Base:** `main`
**Suite:** 897 tests, 897 passing, 0 failing

This documents everything the branch changes, how it was verified, and how to check it by hand. It is the handoff for whoever reviews or continues the work.

---

## 1. What this branch does

Phase 0 of the [Flows canvas plan](./flows-canvas-implementation-plan.md): give every provider capability **one payload-construction path**, shared by the per-domain routes and the pipeline orchestrator. Along the way it closes three functional defects and two HIGH security issues found during review.

It is deliberately scoped to ship alone. Phases 1–5 (graph as data, typed-port executor, fan-out, canvas UI, templates) are unstarted.

---

## 2. Commits

| Commit | Title | What it does |
|---|---|---|
| `2729fa2` | Specify and reproduce Phase 0 | Research, architecture, 60 red acceptance tests, and the conformance guards for both |
| `71f56a8` | Build one payload path per capability | The implementation — turns the 60 red tests green |
| `bdd7067` | Stop a test suite from opening the real database | Fixes the last failing suite (a test-isolation bug, not a code bug) |
| `e4244db` | Send the gateway key only to the gateway | Two HIGH security fixes from the security gate |

---

## 3. Defects closed

### D1 — The orchestrator generated from an empty prompt
`routes/pipeline.js:122` sent `{shot_id, scene_id, project_id, step}` to every generator. No prompt builder, no consistency context. Meanwhile `routes/storyboard.js:581` built a real prompt. **Every orchestrated run asked the model to produce a shot from four ids.**

### D2 — Storyboards ignored the configured provider
`routes/storyboard.js:97` called `fetch(\`${GRIDLIGHT_URL}/image\`)` directly. A project whose `provider_config` selected Runway or OpenAI for `image` still had every storyboard rendered by Gridlight — on the most visible path in the product. Both the sync and streaming paths now resolve through the registry.

### D3 — Lip-sync had no builder at all
`routes/lipsync.js:115` assembled its provider payload inline. It was the only orchestrated capability with no lib builder, so it was extracted rather than merely rewired.

### D4 (security, HIGH) — Gateway credential exfiltration
Credential forwarding was gated on `fetchUrl.startsWith(GRIDLIGHT_URL)`. A prefix is not an origin: `https://gw.example@evil.tld/`, `https://gw.example.evil.tld/` and `https://gw.example-evil.tld/` all pass while resolving elsewhere. The URL comes from a provider's response, so any malicious provider could harvest the key. Fixed with origin comparison (`isGatewayUrl`).

### D5 (security, HIGH) — Arbitrary file read → exfiltration
`POST /projects/:id/assets` stores `file_name` unsanitised and `getFilePath` was a bare `path.join`, so `../../../../etc/passwd` escaped the data directory — and `loadShotContext` base64s what it reads into `init_image` and sends it to an external provider. Containment now lives in `getFilePath`, which all six call sites already route through.

---

## 4. Files changed

**New (10 backend + 7 docs)**

| File | Purpose |
|---|---|
| `backend/lib/capability-payloads.js` | The one payload path; `CAPABILITY_BUILDERS`, `buildCapabilityPayload`, `loadShotContext` |
| `backend/lib/consistency-apply.js` | Pure consistency application, split out so shaping a payload needs no DB |
| `backend/tests/phase0-payload-parity.test.js` | 60 acceptance tests over the 8 orchestrated capabilities |
| `backend/tests/phase0-spec-coverage.test.js` | Proves the Phase 0 test matrix is rectangular |
| `backend/tests/gateway-credential-scope.test.js` | Credential never leaves the gateway origin |
| `backend/tests/asset-path-containment.test.js` | DB `file_name` cannot escape the project directory |
| `backend/tests/test-isolation.test.js` | No test may open the developer's real database |
| `backend/tests/docs-drift.test.js` | CLAUDE.md matches the tree on disk |
| `backend/tests/flows-canvas-plan.test.js` | Plan/manifest conformance against the tree |
| `backend/tests/flows-node-taxonomy.test.js` | Node palette covers every capability and step |

**Modified (10)** — `routes/pipeline.js`, `routes/storyboard.js`, `routes/lipsync.js`, `routes/video-gen.js`, `routes/threed.js`, `lib/consistency-context.js`, `lib/file-storage.js`, `lib/provider-media.js`, `backend/tests/providers-openai-image.test.js`, `CLAUDE.md`.

**Docs (7)** — research, implementation plan, interface manifest, node taxonomy, Phase 0 acceptance criteria, test matrix, and this file.

Totals: 17 added, 10 modified, 27 files touched versus `main`.

---

## 5. Test results

```
$ node --test backend/tests/*.test.js
# tests 897
# suites 177
# pass 897
# fail 0
# skipped 0
# todo 0
```

Baseline for comparison, measured by stashing the branch's work and re-running with the same dependencies installed: **784 tests, 778 passing, 6 failing**. The 6 were `openai-image adapter (mock server)`, since fixed. So the branch adds 113 tests, all passing, and removes the last pre-existing failure.

### Per-guard results

| Suite | Result | What it proves |
|---|---|---|
| `phase0-payload-parity` | 60/60 | Every orchestrated capability builds a real payload; cardinality, scope and error paths hold |
| `phase0-spec-coverage` | 11/11 | The acceptance matrix covers all 8 capabilities × 6 criteria with no holes |
| `gateway-credential-scope` | 4/4 | The key is withheld from every look-alike host, and no prefix gate survives |
| `asset-path-containment` | 3/3 | Traversal is refused; no DB `file_name` is joined outside `getFilePath` |
| `test-isolation` | 4/4 | No suite opens the real database |
| `docs-drift` | 6/6 | Every lib, route and test file is documented; migration count is accurate |
| `flows-canvas-plan` | 17/17 | The plan cites only files that exist; migrations are numbered correctly |
| `flows-node-taxonomy` | 8/8 | The node palette covers all 11 capabilities and 9 pipeline steps |

### Mutation checks

Every guard was mutation-tested rather than trusted. Each mutation was reverted afterwards.

| Mutation | Expected | Result |
|---|---|---|
| Drop the `gen.ambient` node from the taxonomy | Coverage fails | `not ok 2`, `not ok 4` |
| Cite a non-existent file as `existing` in the manifest | Plan check fails | `not ok 9` |
| Renumber a migration onto `047` | Collision detected | `not ok 13` |
| Drift `gen.video` ports from the taxonomy | Contract mismatch | `not ok 4` |
| Add a 9th entry to `STEP_CAPABILITY` in source | Spec must grow | `not ok 2` |
| Remove `FILM_DATA_DIR` isolation | Isolation guard fails | `not ok 2` |
| Set `FILM_DATA_DIR` *after* the require | Ordering caught | `not ok 2` |
| Make `database.js` read the env lazily | Mechanism guard fails | `not ok 4` |
| Restore the prefix credential gate | Scan catches it | `not ok 4` |
| Weaken `isGatewayUrl` to a prefix compare | Payload table fails | `not ok 1` |
| Bypass `getFilePath` with a raw join | Scan catches it | `not ok 3` |
| Remove containment from `getFilePath` | Traversal escapes | `not ok 1` |

Two of these caught bugs **in the guards themselves** — the `database.js` lazy-read mutation initially passed (the assertion checked only that a line was unindented), and the `getFilePath` scan first produced four false positives by keying on variable names rather than DB-sourced values. Both were tightened.

---

## 6. Manual verification

Prerequisites: `cd backend && npm install`, then `node server.js` (port 3100).

### 6.1 The orchestrator now sends a real prompt (D1)

The clearest check needs no gateway at all — compare what the builder produces against what the route produces:

```bash
node -e "
const { buildCapabilityPayload } = require('./backend/lib/capability-payloads');
const ctx = {
  project: { id:'p', style_preset:'cinematic' },
  scene:   { id:'s', project_id:'p', estimated_duration: 45000, time_of_day:'NIGHT' },
  shot:    { id:'sh' },
  sceneCard: { shot_type:'medium', lighting:'low key', characters:['RAY'],
               action:'Ray steps out of the dark.',
               dialogue:[{character:'RAY', line:'You should not have come here.'}] },
  characters: [{ id:'c', name:'RAY', appearance_prompt:'weathered man, grey coat' }],
  location:  { name:'WAREHOUSE' },
};
const img = buildCapabilityPayload('image', ctx).payload;
console.log('image prompt:', JSON.stringify(img.prompt));
console.log('keys:', Object.keys(img).sort().join(','));
"
```

**Expect** a populated prompt mentioning the shot and characters. **Regression** would be the four-key stub `project_id,scene_id,shot_id,step`.

Then, with the server running, `POST /film/shots/:id/pipeline/run` on a shot with a scene card and confirm the resulting `film_video_jobs` row has non-null `prompt`, `model`, `fps` and `num_frames` — those columns were previously written null.

### 6.2 Storyboards honour the configured provider (D2)

```bash
curl -s -X PUT http://localhost:3100/film/projects/<PROJECT_ID> \
  -H 'Content-Type: application/json' \
  -d '{"provider_config":"{\"image\":\"openai\"}"}'
```

Then generate a storyboard and check the registered asset's `provider` column is `openai`, not `gridlight`. Before this branch it was always `gridlight`. With no OpenAI credential configured the call fails — that failure is itself the proof the request went to OpenAI.

### 6.3 Voice fans out per dialogue line

Give a shot two dialogue lines and run the voice step. **Expect two** `film_voice_jobs` rows and two audio files. One row means the cardinality asymmetry has been flattened.

### 6.4 Ambient stays a loop, not a full render

For a 45-second scene, the ambient payload must have `duration_s <= 30`, `bed_duration_s == 45`, `loopable == true`. If `duration_s` grows to the full scene length, the mixer plays the bed once and the rest of the scene is dry — a regression that *sounds* plausible, which is why it is asserted by exact value.

### 6.5 Gateway credential scope (D4)

```bash
node -e "
const { isGatewayUrl } = require('./backend/lib/provider-media');
const gw = require('./backend/lib/gridlight-client').GRIDLIGHT_URL;
for (const u of [gw + '/images/a.png', gw + '@evil.example/steal', gw + '.evil.example/steal']) {
  console.log((isGatewayUrl(u) ? 'SEND KEY ' : 'withhold ') + u);
}
"
```

**Expect** `SEND KEY` only for the first. Any other `SEND KEY` is the vulnerability.

### 6.6 Asset path containment (D5)

```bash
curl -s -X POST http://localhost:3100/film/projects/<PROJECT_ID>/assets \
  -H 'Content-Type: application/json' \
  -d '{"asset_type":"keyframe","shot_id":"<SHOT_ID>","file_name":"../../../../etc/passwd"}'
```

Then run the video step for that shot. **Expect** generation to proceed with **no** `init_image` — the path is refused. **Regression** would be `/etc/passwd` base64'd into the outbound payload. Delete the planted row afterwards.

---

## 7. Known gaps carried forward

1. **The orchestrator persists nothing.** `executeStep` calls generators and discards the results, so an orchestrated pipeline produces no assets, and `lipsync`/`post` preconditions can never be met mid-run (they skip, with a reason recorded). Asset persistence belongs to Phase 2's node handlers and should be treated as a first-class requirement there, not a follow-up.
2. **SSRF by design (MEDIUM).** `persistProviderMedia` fetches provider-supplied absolute URLs, so a malicious provider can make the server request arbitrary hosts, including internal ones. Not fixed because the fetch is the feature — real providers return CDN URLs — and an allowlist needs per-provider origin data that does not exist yet. The credential no longer rides along.
3. **No auth, wildcard CORS (LOW).** No `/film` route authenticates and the server sets `Access-Control-Allow-Origin: *`. This is what made both HIGH findings remotely reachable. It is a deliberate single-user desktop choice, not introduced here, and changing it is a product decision.
4. **`providers-elevenlabs.test.js` hand-rolls its credentials table** instead of calling `ensureSchema()`, so its schema can drift from migration 044 (whose `updated_at` is `NOT NULL`). It passes today; left alone rather than widening a green test into a refactor.

---

## 8. Next step

Phase 1 — graph as data: migration `054_flow_graphs.sql` plus `lib/flow-graph.js`, `lib/flow-seed.js` and `routes/flows.js`. The exit criterion is that `buildStepPlan()` output for the seeded built-in flow is deep-equal to the output derived from `PIPELINE_STEPS`, which makes Phase 1 a provable no-op for existing behaviour rather than a rewrite anyone has to trust.

Phase 1 also introduces the first user-authored graphs, so node config becomes a new untrusted input surface worth reviewing as it lands.
