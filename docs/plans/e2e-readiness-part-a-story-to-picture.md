# E2E Short-Film Readiness — Part A: Story → Picture

**Scope:** stages 1–3 of the user journey (novel prose → screenplay → scenes/shots → storyboards), plus
cross-cutting provider/credential readiness.
**Author:** claude · **Peer:** codex owns Part B (picture → Premiere).
**Method:** live run, not code-reading alone. Booted `backend/server.js` on a scratch DB
(`FILM_DATA_DIR=<scratch>`, `PORT=3199`), created a real project, and walked the journey with a
two-scene novel excerpt.

**Evidence classes — read the verdicts with these in mind.** Every *failure* below is backed by an
actual HTTP response from that run. Every claim about what happens *once Gridlight is running* is
code-path inference plus route/UI evidence — no live Gridlight generation service was exercised, so
those are reasoned, not proven. Codex flagged this distinction in cross-review and it is worth being
strict about: this report proves what is broken, and argues what would work.
**Environment under test:** no Gridlight gateway running (`localhost:8080` → connection refused,
curl exit 7), no `GRIDLIGHT_*` / `OPENAI_*` / `ELEVENLABS_*` env vars set. This is a clean-machine
baseline — deliberately, because "could I do this today" depends on what a fresh install actually does.

**Vocabulary:** `NEEDS-SERVICE` is a sub-case of our agreed `NEEDS-CREDENTIALS` label — it means the
missing piece is a *running service* (the Gridlight gateway) rather than an API key. Both are
distinct from `BLOCKED`, which means no supported path exists at all. Keeping these apart is the
difference between "yes, start one service" and "no". For the merged report these collapse into the
agreed four labels with the service/key distinction as a note, per codex's cross-review.

---

## Verdict for Part A

**With the Gridlight gateway running: stages 1–3 should be achievable today** — the features are
real, the UI is purpose-built for exactly this use case, and the data flows stage to stage. Stated as
inference, not proof: no live gateway was available to test against, so this rests on route and UI
evidence rather than a completed generation.

**Without it: you can get a screenplay and scenes, but you cannot get shots or storyboards from your
own material — and the app will tell you it's connected while you can't.** ("From your own material"
is load-bearing: the bundled demo project inserts 14 shots offline with no AI, so the downstream
pipeline can still be evaluated today. See F4.)

Three findings below are not "missing features" but active traps: the app reports a green state that
isn't true (F1), silently discards a script format you asked for (F3), and silently drops lighting
data from generation prompts (F5). Those cost a filmmaker a day before they understand why.

---

## Readiness matrix

| Stage | (a) API | (b) UI affordance | (c) Provider | (d) Auto-flow to next | (e) Verdict |
|---|---|---|---|---|---|
| 1. Prose → screenplay (AI) | Exists; **unreachable offline** | Yes — purpose-built | **Gridlight only** | Yes → editor → scenes | **NEEDS-SERVICE** |
| 1b. Bring-your-own Fountain | Yes | Yes (Import) | None needed | Yes → scenes | **WORKS** (offline) |
| 2. Screenplay → scenes | Yes | Yes | None needed | Yes | **WORKS** (offline) |
| 2b. Scenes → shots | API only | **No manual path** | Gridlight only | Yes | **BLOCKED in UI** w/o gateway |
| 2c. Character/location registry | Yes | Yes (manual) | — | **No — not auto-populated** | **WORKS-WITH-MANUAL-STEPS** |
| 3. Storyboards | Yes, plumbing sound | Yes (SSE) | **Gridlight only** | Yes → video stage | **NEEDS-SERVICE** |
| X. Provider readiness | Yes | Yes | — | — | **MISREPORTS STATE** (F1) |

---

## Findings, most consequential first

### F1 — The Providers screen reports "connected" without ever checking *(highest impact)*

`GET /film/providers` returned, with the gateway definitively down:

```json
{"id":"gridlight", "requiresKey":false,
 "credentials":{"set":true,"last4":null,"fields":{},"connected":true}}
```

`backend/routes/providers.js:105` hardcodes it:

```js
credentials: needsSetup ? credStatus(a.id) : { set: true, last4: null, fields: {}, connected: true }
```

Gridlight has `requiresKey:false`, so `needsSetup` is false and it is **always** reported connected.
The adapter implements `health()` (`backend/lib/providers/gridlight-adapter.js:54`) — the list
endpoint never calls it.

Why it matters most: this is the one screen a user checks before committing to a shoot. It says
ready; the first generation then fails with `fetch failed`. Every downstream failure in this report
is misdiagnosed because of this one.

**Fix:** call `adapter.health()` in the list endpoint (it already exists) and report real state.

### F2 — Storyboard generation bypasses the provider registry: Gridlight-only

`backend/routes/storyboard.js:98` and `:173` call `fetch(\`${GRIDLIGHT_URL}/image\`)` directly,
importing `GRIDLIGHT_URL` at line 18. It never calls `resolve('image', …)`.

But `characters.js:440` and `locations.js:451,568` **do** use `resolve('image')`. So an OpenAI key
(the `openai` adapter declares `capabilities:['image']`, `requiresKey:true`) gets you character
reference sheets and location plates — **but not the storyboards themselves**. That inconsistency is
invisible to the user and defeats the point of having a provider layer.

**Fix:** route storyboard image calls through `resolveGenerator('image', projectConfig)` like its siblings.

### F3 — `POST /script` silently ignores `format` and downgrades to plaintext

Sent `{"content": "<fountain text>", "format": "fountain"}` → stored `format:"plaintext"`,
`fountain_content:""`, `scene_count:0`.

`backend/routes/scripts.js:422–453`: the branch keys off **`body.fountain_content`** only. `body.format`
is never read. Consequences of landing in the wrong branch: FDX export and the Fountain renderer both
refuse (`'Latest script is not in Fountain format'`, `scripts.js:790,879`), and page/scene/dialogue
stats stay zero.

Re-posting the same text as `fountain_content` gave the correct result — `format:"fountain"`,
`scene_count:2`, `page_count:1`, `dialogue_percentage:19`, 2 scenes extracted.

**Fix:** honor `format:'fountain'` on `content`, or reject the combination loudly. Silent downgrade is
the worst option.

### F4 — No manual way to create a shot anywhere in the UI

Grepped the entire 14,382-line SPA for `New Shot` / `Add Shot` / `addShot(` / `createShot` — **zero
hits.** The only paths to a shot are `breakdownScene()` and "Break Down All New Scenes"
(`src/index.html:3554,10175`), both of which POST to `/breakdown` → Gridlight `/chat/intelligent`.

Live: `POST /projects/:id/breakdown` → `{"error":"AI gateway unavailable"}`.

Since storyboards, video, voice and the NLE timeline all hang off shots, **gateway down = the journey
stops dead at stage 2 for the user's own story, with no workaround a non-developer can reach.** The
API path works — I created two shots by hand via `POST /film/shots` with a `cards[]` array — but that
requires curl and knowledge of the scene-card schema.

**One important qualification, found by re-checking my own claim.** There *is* an offline path to a
populated project: "Load Demo Project" (`src/index.html:4919` → `POST /film/projects/demo`) inserts
shots directly (`demo-project.js:554`) with no AI involved. I ran it live — it produced
`{"title":"Neon Requiem","scenes":7,"shots":14,"characters":4,"locations":4,"props":8,"acts":3}` on a
gateway-less machine.

This matters in both directions, so state it precisely:
- It does **not** rescue the user's use case. The demo is somebody else's story. There is still no way
  to get shots from *his novel scene* without the gateway.
- It **does** mean he can exercise and evaluate the entire downstream pipeline — storyboard, video,
  music, export — today, offline, before committing. That is genuinely useful and worth telling him.

So the accurate statement is "no path from *your own screenplay* to shots without the gateway," not
"no shots at all."

**Fix:** an "Add shot" button on the shotboard. Small surface, removes a hard single point of failure.

### F5 — Scene-card validator accepts unknown keys, then generation silently drops them

`{"lighting":{"style":"night"}}` passes validation and is stored. But
`backend/lib/scene-card-schema.js:79` only ever reads `lighting.type` — so `style` is accepted,
persisted, and **never reaches the prompt**. The user sees their lighting choice saved on the card
and absent from every generated frame, with no error.

(The validator is also stricter than it looks in a way that will bite: `lighting` must be an *object*;
`"lighting":"night"` is rejected outright with `lighting must be an object`.)

**Fix:** reject unknown keys in scene cards, or read them. Accept-and-discard is the trap.

### F6 — No LLM provider abstraction at all

`CAPABILITIES` (`backend/lib/providers/base.js:35`) is
`['image','video','music','voice','sfx','ambient','lipsync','post','model3d','stock']` — **there is no
`text`/`llm` capability.** All three AI-writing routes hardcode Gridlight `/chat/intelligent`:
`text-convert.js:149`, `breakdown.js`, `screenplay-ai.js`.

So for the user's *specific* opening move — converting a novel scene — an OpenAI or Anthropic key is
worthless. Gridlight is the only option, for the prose conversion, the breakdown, and the writing
assistant alike.

### F7 — `GET /export/fdx` is broken for every project *(handed to codex — his file)*

```
fcpxml http=200 · edl http=200 · premiere http=200 · fdx http=500
```

`registerExportAsset(projectId, 'fdx', …)` at `backend/routes/nle-export.js:168` inserts
`asset_type='fdx'`, which is absent from the `film_assets` CHECK constraint (it permits `fcpxml`,
`edl`, `premiere_xml` — no `fdx`). Every call raises `SQLITE_CONSTRAINT_CHECK` and 500s **after** the
XML is generated, so the user gets nothing.

Reported to codex; the file is his. Note this is a screenplay-delivery path, so it belongs in the
Part A story even though the code is Part B's.

### F9 — Premiere XML points at nothing *(codex's finding; I reproduced it live — see Part B)*

Included here only because it closes the loop on the user's question. During cross-review I
registered assets the way the batch generation paths do and exported. Actual output:

```xml
<pathurl>file:///1A.mp4</pathurl>
<pathurl>file:///https://cdn.provider.com/gen/abc123.mp4</pathurl>
```

The first resolves to filesystem **root**; the second is a malformed file URL. Every clip imports
offline with nothing for Premiere's relink dialog to match. Full analysis and the three code paths
that produce it (`video-gen.js:335`, `:160-165`, `:497-499`) are in Part B.

### F8 — Character/location registries are not populated from the script

After a successful upload with `characters_present:["TOM","MARA"]` on the scene, `GET
/projects/:id/characters` returned `{"characters":[]}`. The names are parsed and stored on the scene
but never promoted into the registry that consistency and storyboarding actually read.

Consequence: `GET /consistency/audit` returns `ready:true` with only *warnings* —
`Character "MARA" is referenced by the shot but is not in the character registry.` A green readiness
gate on a project that cannot hold a character's face consistent between shots.

**Fix:** offer to create registry entries from detected names at script-save, or make the audit's
verdict reflect the warning.

---

## What actually worked, offline, with nothing running

Worth stating plainly — the foundation is genuinely solid:

- Project creation, script versioning (v1 → v2), Fountain parsing, page/scene/dialogue statistics.
- Scene extraction with INT/EXT, location, time-of-day, and character detection from cue lines.
- Shot creation with scene-card validation (via API).
- The consistency audit, and FCPXML/EDL/Premiere export returning 200.
- The prose-conversion **UI** is well-built for this exact job: chapter auto-detection, chunked
  conversion, context overlap carried between chunks, progress and ETA (`src/index.html:4439,12451`).
  It only lacks a backend it can reach.

One caveat on scene re-extraction: uploading a new script version replaced the scene rows with new
IDs, orphaning shot references created against the old ones. Not chased down — flagging it as a risk
for anyone who revises a script after breaking it down.

## Shortest path to "yes" for stages 1–3

1. Start the Gridlight gateway on `:8080` (unblocks F6/F4/F2 in one move — the single highest-value action).
2. Fix F1 so readiness stops lying — one call to the `health()` that already exists.
3. Fix F3 and F5 — both are silent data loss, both are small.
4. Add the "Add shot" button (F4) so the gateway isn't a single point of failure.
5. F2 and F6 are the real architectural gaps if multi-provider is meant to be a selling point.

## Correction to our own docs

`CLAUDE.md` states "All 164 planned tasks (FILM-001 to FILM-164) are complete — backend and frontend"
and marks every phase **Complete**. Feature-presence-wise that's defensible. As a readiness claim it
is misleading: F7 is a route that 500s on every call, and F1/F3/F5 are silent-failure paths. Flagging
per our agreement rather than editing during the audit.

---

*No code was modified in producing this report.*
