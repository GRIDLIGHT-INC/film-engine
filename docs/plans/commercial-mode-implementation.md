# Commercial mode — implementation plan

Film Engine makes films. A commercial is not a short film: it is a **fan-out**. One brief
resolves to fourteen to twenty-two files — a broadcast master, three or four cut-downs, three
or four aspect ratios, burned and sidecar captions, a textless version, stems and end-frame
stills. The engine's data model cannot represent that today, because a project carries exactly
one `aspect_ratio`, one resolution, one delivery preset, and no notion of a cut-down.

**Not yet built.** This is the plan the tests will be written against.

Finishing always happens in **Premiere Pro**. That is a constraint, not an aside — it decides
roughly half of what follows, because it takes a large amount of work off this plan.

---

## 1. The boundary — read this before writing any code

> **Film Engine owns every decision that cannot be undone once the pixels exist.**
> **Premiere owns everything that is a timeline operation on footage that already exists.**
> **Everything else is ops, and belongs in neither.**

That single rule resolves almost every case. Vertical framing is unrecoverable after
generation, so it is the engine's. A cut-down is a timeline operation, so it is Premiere's. A
revision counter is neither.

### Explicitly NOT in this plan

Do not build these. Each looks like an engine feature and is not:

| Not built | Why | Where it actually happens |
|---|---|---|
| A graphics/text layer — endcard, lower third, CTA, price, legal super | Premiere's Essential Graphics does this properly | one `.mogrt` per brand |
| Loudness measurement / `loudnorm` / `ebur128` | Media Encoder normalises on export; measuring here would double-process | Media Encoder export preset |
| Caption styling and burn-in | Premiere burns captions on export | Premiere caption track |
| Rendering the delivery files — every ratio, every codec | Media Encoder preset group | Premiere |
| The textless version | a timeline operation | Premiere |
| Revision-round counting, SLA clock, client review link, CRM | not software this repo should own | a spreadsheet until ~40 jobs/month |
| QC of the finished exported file | the engine never sees it | a checklist, or twenty lines of `ffprobe` |

The engine's obligation for each of the first five is narrower and is in this plan: **carry the
data and the target into the handoff**, and let the edit apply it.

### The number that justifies the whole plan

A 9:16 centre crop keeps only **32%** of a 16:9 frame's width. 1:1 keeps 56%; 4:5 keeps 45%.
Premiere's Auto Reframe follows a subject inside available pixels — it cannot invent the
two-thirds that were never generated. **Vertical hero and product shots are generated
vertical, or they are lost.** Every "per-shot aspect" decision below exists for this reason.

---

## 2. The integration surface, derived from the suite

A new subsystem here does not merely add files. Several existing tests derive their
denominator from a directory scan or a registry, so this work joins their set the moment the
files land — each imposing a contract. A plan that has not read them describes work that
fails on the day it arrives.

| Test | Derives from | Contract it imposes |
|---|---|---|
| `docs-drift.test.js` | `readdirSync(lib)`, `readdirSync(routes)`, `readdirSync(tests)` | every new `lib/`, `routes/` and test file must be named in **CLAUDE.md**, and the migration count updated |
| `mcp-no-server-llm.test.js` | `ENTITY_ROUTES` (9 entries today) | two more entries — deliverable, brand — each with a tool for every HTTP verb its route handles |
| `nav-flow.test.js` | every `data-page="…"` in `src/index.html` + `NAV_FLOW` + `ALWAYS_AVAILABLE` | both new pages in **exactly one** group, none appearing twice, none orphaned |
| `nav-chrome.test.js` | `var RAIL` in `src/index.html` | any RAIL entry added must resolve to a page or an explicit handler |
| `manual-edit.test.js` | the routes' own field lists | **every text field the new update routes accept needs a control in `src/index.html`**, or a named exemption. This is the one most likely to be missed. |
| `test-isolation.test.js` | `readdirSync(tests)` | every new test sets `FILM_DATA_DIR`; none opens the real database |
| `project-delete.test.js` | its `CHILD_TABLES` walk | `film_deliverables` and `film_claims` join the walk. `film_brands` does **not** — it is library-level and must survive a project delete. |
| `aspect-consistency.test.js` | `ASPECT_RATIOS` from `lib/project-presets.js` | **adding `4:5` enrols it automatically.** Board and footage must produce the same shape at 4:5, or this test fails the moment the ratio is added. |
| `card-overflow.test.js` | pages using `entity-card` | applies if the Deliverables or Brand page uses `entity-card` |
| `conform.test.js` | existing | the duration check must not break the existing refuse-on-missing behaviour |

`aspect-consistency` and `manual-edit` are the two that will bite unexpectedly. Read both
before starting.

---

## 3. Files

### New

| Path | Responsibility |
|---|---|
| `backend/db/migrations/098_deliverables.sql` | `film_deliverables`, `film_projects.target_duration_ms`, `film_shots.aspect_ratio` |
| `backend/db/migrations/099_brands.sql` | `film_brands`, `film_claims`, `film_projects.brand_id / client / campaign` |
| `backend/lib/deliverables.js` | pure: profiles, planning, frame counts, which ratios must be native. No I/O. |
| `backend/lib/brand-kit.js` | pure: validation, prompt context, payload application, handoff folder manifest |
| `backend/lib/compliance.js` | pure: the pre-generation checks. Takes rows, returns findings, never throws. |
| `backend/lib/spot-package.js` | pure: plans the Premiere handoff folder. Returns a manifest; writes nothing. |
| `backend/routes/deliverables.js` | HTTP dispatch, DB reads/writes |
| `backend/routes/brands.js` | HTTP dispatch, DB reads/writes |
| `backend/tests/deliverables.test.js` | set-based over `DELIVERY_PROFILES` |
| `backend/tests/brand-kit.test.js` | set-based over the brand fields |
| `backend/tests/compliance.test.js` | set-based over `CHECKS` |
| `backend/tests/spot-package.test.js` | manifest completeness and relative-path containment |
| `backend/tests/spot-duration.test.js` | the conform duration lock, per frame rate |

**Why the `lib/` + `routes/` split.** The same split `pipeline-engine.js` / `routes/pipeline.js`
and `conform.js` / `routes/production-reports.js` already use, for the same reason: planning a
deliverable set, checking copy, and laying out a package are pure algebra over objects and are
worth testing without a database. It is also what lets each be called from the MCP tool, the
page and the orchestrator without three code paths.

### Edited

| Path | Edit |
|---|---|
| `backend/lib/project-presets.js` | `ASPECT_RATIOS` gains `4:5`; `DELIVERY_PRESETS` gains three spot presets |
| `backend/lib/nle-export.js` | delete `const FPS = 24`; one sequence per deliverable; relative paths in `toFileUrl`; markers |
| `backend/lib/video-prompt.js` | `buildVideoFrame(proj, override)` — the fitting maths is untouched |
| `backend/lib/capability-payloads.js` | apply brand beside consistency; register the narration voice sub-type; carry the per-shot aspect |
| `backend/lib/dialogue-builder.js` | `buildNarrationPayload()` beside the per-line builder |
| `backend/lib/conform.js` | duration lock in `planConform()` |
| `backend/lib/run-plan.js` | refuse on a blocking compliance finding |
| `backend/lib/dry-run.js` | report findings alongside the payloads |
| `backend/lib/qa-checker.js` | `spot_duration_exact`, `spot_native_vertical`, `spot_rights_cleared` |
| `backend/lib/nav-flow.js` | `plan` gains `deliverables` (first); `ALWAYS_AVAILABLE` gains `brand` |
| `backend/lib/provider-config.js` | `tag()` carries client and campaign |
| `backend/lib/mcp-tools.js` | the new tool entries (§6) |
| `backend/server.js` | dispatch `/film/projects/:id/deliverables*`, `/film/deliverables/*`, `/film/brands*` |
| `src/index.html` | `var RAIL`; `page-deliverables`; `page-brand`; the New Project modal; controls listed in §7 |
| `CLAUDE.md` | the tree (six new modules, five new tests), the migration count (94 → 96), the test-run list |
| `backend/tests/mcp-no-server-llm.test.js` | `ENTITY_ROUTES` 10th and 11th entries |
| `backend/tests/project-delete.test.js` | `film_deliverables`, `film_claims` in the child-table walk |

`098` is the real next number — the tree is at `097_station_index_guard.sql`.

---

## 4. Schema

### `098_deliverables.sql`

```sql
-- One row per FILE that leaves the job.
--
-- A film has one shape. A commercial has fourteen to twenty-two, and the set is
-- decided before anything is generated because it is what says which shots must
-- be shot vertical rather than cropped later. Premiere renders these; the engine
-- plans them and emits one sequence per row.
CREATE TABLE IF NOT EXISTS film_deliverables (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    key             TEXT NOT NULL DEFAULT '',        -- '30_16x9', '15_9x16' — the sequence name
    label           TEXT NOT NULL DEFAULT '',
    profile_id      TEXT NOT NULL DEFAULT '',        -- a DELIVERY_PROFILES id, or '' for hand-built
    aspect_ratio    TEXT NOT NULL DEFAULT '16:9',
    width           INTEGER NOT NULL DEFAULT 1920,
    height          INTEGER NOT NULL DEFAULT 1080,
    fps             REAL    NOT NULL DEFAULT 29.97,
    duration_ms     INTEGER NOT NULL DEFAULT 30000,
    platform        TEXT NOT NULL DEFAULT ''
                    CHECK (platform IN ('', 'broadcast', 'ctv', 'youtube', 'meta',
                                        'tiktok', 'shorts', 'web', 'still')),
    loudness_target TEXT NOT NULL DEFAULT '',        -- '-24 LKFS', '-23 LUFS', '-14 LUFS'
    caption_mode    TEXT NOT NULL DEFAULT 'sidecar'
                    CHECK (caption_mode IN ('none', 'sidecar', 'burned')),
    native          INTEGER NOT NULL DEFAULT 0,      -- 1 = must be GENERATED at this ratio
    sort_order      INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'planned'
                    CHECK (status IN ('planned', 'ready', 'delivered', 'dropped')),
    notes           TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_film_deliverables_project
    ON film_deliverables(project_id, sort_order);

-- The runtime the spot must hit, exactly.
-- 0 means "no target", which is every film ever made in this tool and must stay
-- the behaviour of a project that never sets one.
ALTER TABLE film_projects ADD COLUMN target_duration_ms INTEGER NOT NULL DEFAULT 0;

-- A shot's own ratio. Empty inherits the project's, which is what every existing
-- shot does and must keep doing.
ALTER TABLE film_shots ADD COLUMN aspect_ratio TEXT NOT NULL DEFAULT '';
```

### `099_brands.sql`

```sql
-- A brand OUTLIVES a project, for the same reason the style book does: one
-- client buys many spots, and a kit that dies with the project is one that is
-- re-uploaded every time that client comes back. NO project_id, and it must
-- survive a project delete — see tests/project-delete.test.js.
CREATE TABLE IF NOT EXISTS film_brands (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL DEFAULT '',
    logo_asset_id     TEXT NOT NULL DEFAULT '',      -- film_assets row, kind 'logo'
    logo_clear_space  TEXT NOT NULL DEFAULT '',      -- '0.5x cap height', free text
    palette           TEXT NOT NULL DEFAULT '',      -- JSON array of hex strings
    fonts             TEXT NOT NULL DEFAULT '',      -- JSON array of {role, family, weight}
    cta               TEXT NOT NULL DEFAULT '',
    cta_url           TEXT NOT NULL DEFAULT '',
    legal_line        TEXT NOT NULL DEFAULT '',
    banned_phrases    TEXT NOT NULL DEFAULT '',      -- JSON array of strings
    tone              TEXT NOT NULL DEFAULT '',      -- reaches the prompt
    approval_contact  TEXT NOT NULL DEFAULT '',
    notes             TEXT NOT NULL DEFAULT '',
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A claim and the evidence for it.
-- FTC, the Competition Act, the CAP Code and the ACCC all require objective
-- claims to be substantiated. An automated pipeline can put "#1", "clinically
-- proven" or "saves 50%" into a paid advertisement in seconds, which is exactly
-- why the substantiation has to be a row somebody signed rather than a memory.
CREATE TABLE IF NOT EXISTS film_claims (
    id             TEXT PRIMARY KEY,
    project_id     TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    claim          TEXT NOT NULL DEFAULT '',
    substantiation TEXT NOT NULL DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'unsubstantiated'
                   CHECK (status IN ('unsubstantiated', 'substantiated', 'withdrawn')),
    approved_by    TEXT NOT NULL DEFAULT '',
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_film_claims_project ON film_claims(project_id, status);

ALTER TABLE film_projects ADD COLUMN brand_id TEXT NOT NULL DEFAULT '';
ALTER TABLE film_projects ADD COLUMN client   TEXT NOT NULL DEFAULT '';
ALTER TABLE film_projects ADD COLUMN campaign TEXT NOT NULL DEFAULT '';
```

**Rights are already built.** `film_rights` (migration `051`) carries `commercial_use`,
`likeness`, `voice_clone`, `music_license`, `release`, with `territory`, `expires_on` and a
`status` of `unknown / cleared / restricted / expired / blocked`. The compliance gate reads
it; do not add a second rights table.

---

## 5. Interfaces

### `lib/deliverables.js` — pure

```js
/** The delivery matrix as data. Premiere renders these; the engine plans them. */
const DELIVERY_PROFILES = [
  // id                 label                    ratio   w     h     fps     ms      platform    loudness      captions   native
  { id: 'bcast_na_30',  label: 'NA broadcast :30',  aspect: '16:9',  width: 1920, height: 1080, fps: 29.97, duration_ms: 30000, platform: 'broadcast', loudness: '-24 LKFS', caption_mode: 'none',    native: false },
  { id: 'bcast_na_15',  label: 'NA broadcast :15',  aspect: '16:9',  width: 1920, height: 1080, fps: 29.97, duration_ms: 15000, platform: 'broadcast', loudness: '-24 LKFS', caption_mode: 'none',    native: false },
  { id: 'bcast_uk_30',  label: 'UK/AU broadcast :30', aspect: '16:9', width: 1920, height: 1080, fps: 25, duration_ms: 30000, platform: 'broadcast', loudness: '-23 LUFS', caption_mode: 'none',    native: false },
  { id: 'ctv_30',       label: 'CTV programmatic :30', aspect: '16:9', width: 1920, height: 1080, fps: 29.97, duration_ms: 30000, platform: 'ctv',    loudness: '-24 LKFS', caption_mode: 'none',    native: false },
  { id: 'yt_30',        label: 'YouTube :30',       aspect: '16:9',  width: 1920, height: 1080, fps: 29.97, duration_ms: 30000, platform: 'youtube',   loudness: '-14 LUFS', caption_mode: 'sidecar', native: false },
  { id: 'meta_feed_15', label: 'Meta feed :15',     aspect: '4:5',   width: 1080, height: 1350, fps: 30,    duration_ms: 15000, platform: 'meta',      loudness: '-14 LUFS', caption_mode: 'burned',  native: true  },
  { id: 'reels_15',     label: 'Reels/TikTok :15',  aspect: '9:16',  width: 1080, height: 1920, fps: 30,    duration_ms: 15000, platform: 'tiktok',    loudness: '-14 LUFS', caption_mode: 'burned',  native: true  },
  { id: 'reels_06',     label: 'Bumper :06',        aspect: '9:16',  width: 1080, height: 1920, fps: 30,    duration_ms:  6000, platform: 'shorts',    loudness: '-14 LUFS', caption_mode: 'burned',  native: true  },
  { id: 'square_15',    label: 'Square :15',        aspect: '1:1',   width: 1080, height: 1080, fps: 30,    duration_ms: 15000, platform: 'meta',      loudness: '-14 LUFS', caption_mode: 'burned',  native: false },
];

/** The three packages, so a $399 job is not scoped by hand every time. */
const PACKAGES = {
  rapid:    ['yt_30', 'reels_15', 'square_15'],
  campaign: ['yt_30', 'reels_15', 'reels_06', 'meta_feed_15', 'square_15', 'bcast_na_15'],
  broadcast:['bcast_na_30', 'bcast_na_15', 'yt_30', 'reels_15', 'reels_06', 'meta_feed_15'],
};

/** profileIds -> deliverable rows, ordered. Pure; the route persists them. */
function planDeliverables(packageId, overrides) { /* … */ }

/**
 * Which ratios must be GENERATED rather than cropped.
 *
 * The whole reason this module exists. A 9:16 centre crop of a 16:9 frame keeps
 * 32% of its width, so a vertical deliverable derived from a 16:9 master loses
 * the product and the CTA. Any profile with native:true puts its ratio here, and
 * the shot board uses the answer to decide which shots are shot twice.
 */
function nativeRatiosFor(deliverables) { /* -> ['9:16', '4:5'] */ }

/** Exact frames for a runtime at a rate. 30s @ 29.97 DF is 900, not 899. */
function frameCount(durationMs, fps) { /* … */ }

/** { valid, errors } — mirrors validateProjectSettings in project-presets.js */
function validateDeliverable(row) { /* … */ }

module.exports = { DELIVERY_PROFILES, PACKAGES, planDeliverables,
                   nativeRatiosFor, frameCount, validateDeliverable };
```

### `lib/brand-kit.js` — pure

```js
/** { valid, errors }. palette/fonts/banned_phrases are JSON columns — parse defensively. */
function validateBrand(brand) { /* … */ }

/** The subset of a brand that belongs in a generation prompt: tone, palette, product. */
function brandPromptContext(brand) { /* … */ }

/**
 * Applied where consistency already is.
 *
 * Sits beside applyConsistencyToImagePayload in capability-payloads.js so the
 * routes, the orchestrator and the flow canvas all pick it up and none can
 * drift — which is the whole reason that module exists.
 */
function applyBrandToImagePayload(payload, brand) { /* … */ }

/** The /brand/ folder in the handoff: logo, fonts, palette.json, legal.txt, cta.txt */
function brandFolder(brand, assets) { /* -> [{ path, source }] */ }
```

### `lib/compliance.js` — pure

```js
/**
 * Checks that must run BEFORE spend, never after.
 *
 * After generation the money is gone, so this is enforced in the FREE plan
 * surfaces (run-plan, dry-run) rather than at the generator. Returns findings;
 * never throws, never writes, never opens a socket.
 */
const CHECKS = [
  { id: 'banned_phrase',      severity: 'error',   label: 'Copy contains a phrase the brand forbids' },
  { id: 'unsubstantiated',    severity: 'error',   label: 'Objective claim with no substantiated film_claims row' },
  { id: 'synthetic_customer', severity: 'error',   label: 'Generated person presented as a real satisfied customer' },
  { id: 'rights_uncleared',   severity: 'error',   label: 'A referenced asset is not cleared in film_rights' },
  { id: 'rights_expired',     severity: 'error',   label: 'A cleared right has passed expires_on' },
  { id: 'no_legal_line',      severity: 'warning', label: 'Brand carries a legal line and no deliverable places it' },
  { id: 'no_cta',             severity: 'warning', label: 'No CTA in the script or on any deliverable' },
];

/** Claim patterns worth flagging: superlatives, comparatives, numbers with % or x. */
const CLAIM_PATTERNS = [/\b#\s?1\b/i, /\bbest\b/i, /\bclinically\s+proven\b/i,
                        /\bguarantee/i, /\b\d+\s?%\s+(more|less|faster|cheaper)\b/i,
                        /\bno\.?\s?1\b/i, /\bfastest\b/i, /\bcheapest\b/i];

/** (text, brand, claims) -> findings[]. No DB. */
function checkCopy(text, brand, claims) { /* … */ }

/** (rightsRows, today) -> findings[]. No DB. */
function checkRights(rows, today) { /* … */ }

/** The one a caller uses: gathers both, sorts errors first. */
function findingsFor({ script, brand, claims, rights, deliverables }) { /* … */ }

/** true when any finding is severity 'error'. run-plan refuses on this. */
function blocks(findings) { /* … */ }
```

### `lib/spot-package.js` — pure

```js
/**
 * The Premiere handoff, planned but not written.
 *
 * On the planConform precedent: planning is pure and separate from executing,
 * because conforming needs a media tool this repo deliberately does not depend
 * on (ADR-002). Returns a manifest of what goes where; the route copies.
 *
 * Every path in the manifest is RELATIVE to the package root. An absolute path
 * relinks on exactly one machine, which is the machine it will never be opened on.
 */
function planPackage(project, deliverables, shots, assets, brand) {
  return {
    ok: true, errors: [],
    root: 'CLIENT_SPOT',            // slugged from client + title
    xml: 'CLIENT_SPOT.xml',         // FCP7 xmeml, relative pathurls
    sequences: [/* one per deliverable: { name, width, height, fps, duration_frames } */],
    markers: [/* { sequence, frame, name } — logo in, CTA in, legal in/out, last frame */],
    media: [/* { from: absolute, to: 'media/CLIENT_SPOT_SC01-SH04_v03.mov' } */],
    captions: [/* { to: 'captions/…srt' } */],
    stems: [/* { to: 'stems/vo.wav' } … */],
    brand: [/* from brandFolder() */],
    spec_sheet: 'spec.md',          // per-sequence fps, size, frame count, loudness target
  };
}
```

---

## 6. Routes and MCP tools

`server.js` dispatches on `urlParts`, no framework (ADR-002). Follow `routes/style-book.js`
for the shape.

```
GET|POST      /film/projects/:id/deliverables       list · create
POST          /film/projects/:id/deliverables/plan  apply a PACKAGES preset
GET|PUT|DELETE /film/deliverables/:id
GET           /film/projects/:id/deliverables/check  duration + native-ratio verdict, FREE

GET|POST      /film/brands                          library list · create
GET|PUT|DELETE /film/brands/:id
POST          /film/brands/:id/logo                  upload

GET|POST      /film/projects/:id/claims
GET|PUT|DELETE /film/claims/:id

GET           /film/projects/:id/compliance          findings, FREE, spends nothing
GET           /film/projects/:id/export/package      the handoff folder (tar.gz)
```

`mcp-no-server-llm.test.js` requires a tool per verb for every entity route. Add to
`lib/mcp-tools.js`:

| Tool | Verb it covers |
|---|---|
| `deliverable_plan` | POST `…/deliverables/plan` |
| `deliverable_create` / `deliverable_update` / `deliverable_delete` | POST / PUT / DELETE |
| `deliverable_list` | GET |
| `brand_create` / `brand_update` / `brand_delete` | POST / PUT / DELETE |
| `brand_list` / `brand_get` | GET |
| `claim_create` / `claim_update` / `claim_delete` | POST / PUT / DELETE |
| `compliance_check` | GET, free |
| `export_package` | GET |

And two new `ENTITY_ROUTES` entries in `backend/tests/mcp-no-server-llm.test.js`:

```js
{ kind: 'deliverable', file: 'deliverables.js',
  verbs: { POST: 'deliverable_create', PUT: 'deliverable_update', DELETE: 'deliverable_delete' } },
{ kind: 'brand', file: 'brands.js',
  verbs: { POST: 'brand_create', PUT: 'brand_update', DELETE: 'brand_delete' } },
```

---

## 7. The app — two new pages, twelve changed

The sidebar already carries ~25 pages in four groups, ordered the way a film is made. Six
more would make it unusable, and `nav-flow.js` requires every page to sit in exactly one
group. **Two new pages. Everything else is a panel or a control on a screen that exists.**

### New pages

**`page-deliverables`** — `NAV_FLOW.plan.pages`, **first**, before `storyboard`.
The output list: one row per file with ratio, size, fps, duration, platform, loudness target,
caption mode, and a **native** toggle. A package picker at the top applies a `PACKAGES` preset.
A verdict strip shows total runtime against target and which ratios must be shot native.
Same kind of object as Milestones — a planned list with status.

**`page-brand`** — `ALWAYS_AVAILABLE`, beside `stylebook`.
Not inside a project, for the reason `nav-flow.js` already gives about the style book: it
accumulates across films. Logo upload, clear-space note, palette swatches, fonts, CTA and URL,
legal line, banned phrases, tone, approval contact. Shaped like `page-characters`.

### Changed screens

| Screen | Change |
|---|---|
| **New Project modal** | a **type** choice: Film or Spot. Spot swaps genre/logline for client, brand picker, spot length and package preset — and seeds the deliverable rows. **The highest-leverage change in this plan**: it sets frame rate, aspect list, duration target and deliverables in one action, and every one of those is expensive to discover late. |
| `page-shotboard` | header carries the running total against target: `24.6s / 30.0s`. This is the screen where an overlong spot gets fixed. |
| `page-storyboard` | ratio toggle in the page header (16:9 / 9:16 / 4:5 / 1:1) drawing protect boxes over every tile; a per-shot **shoot native vertical** flag on the tile writing `film_shots.aspect_ratio` |
| `page-previs` | the same protect frame in the viewport — it is already the screen for seeing the frame before generating |
| `page-pipeline` | the run plan shows compliance findings as blocking rows; nothing generates until they clear |
| `page-notes` | each finding opens as a note — the app's existing approval surface, rather than a new one |
| `page-videoshots` | **Generate VO** beside Generate All Dialogue: one continuous read timed to the cut, per deliverable |
| `page-exportpage` | one wide **Premiere Package** card above the five format tiles. Lists the folder contents, shows the verdict (duration exact · no missing shots · rights cleared), and only then enables the download. Format tiles stay below. |
| `page-budget` | rollup per client and campaign |
| `page-settings` | the three spot delivery presets; `4:5` appears automatically from `ASPECT_RATIOS` |
| `page-dashboard` | open compliance findings in the "what needs me" list |
| `var RAIL` | if either new page earns a rail button, `nav-chrome.test.js` requires it to resolve |

**`manual-edit.test.js` will fail** unless every text field `routes/deliverables.js`,
`routes/brands.js` and the claims route accept has a control on these pages. That is ~15 fields
on the brand page alone. Build the form from the route's field list, not from memory.

---

## 8. Order of work

Five milestones. Each ends green — full suite, not just the new tests.

### M1 · Presets and the frame-rate bug — half a day
- `4:5` in `ASPECT_RATIOS`; three spot presets in `DELIVERY_PRESETS`
- delete `const FPS = 24` from `nle-export.js`; read `settings.target_fps`, which
  `DEFAULT_SETTINGS` already carries — the constant is shadowing it in every default parameter
- **Acceptance:** `aspect-consistency.test.js` passes at 4:5 with no other change. If it
  fails, the board/footage reconciliation is wrong and must be fixed before anything else.

### M2 · Deliverables — two days
- `098_deliverables.sql`, `lib/deliverables.js`, `routes/deliverables.js`, `page-deliverables`
- `nle-export.js` emits one sequence per row
- **Acceptance:** a project with the `campaign` package exports a Premiere XML containing six
  named sequences at the right size and rate, and `nav-flow.test.js` still passes.

### M3 · Duration lock — half a day
- `film_projects.target_duration_ms`; the check in `planConform()`, which already computes
  `total_duration_ms` at the end of the plan — the check is a comparison beside it with a
  one-frame tolerance
- `spot_duration_exact` in `QA_CHECKS`; the Shot Board readout
- **Acceptance:** a 31.4 s plan against a :30 target **refuses**, with the overage named. The
  file's own doctrine — *refuses rather than shortens* — extended to length.

### M4 · Per-shot aspect and the protect overlay — two days
- `film_shots.aspect_ratio`; `buildVideoFrame(proj, override)` — **the fitting maths is
  already correct and must not be touched**, only the source of the ratio changes
- the storyboard ratio toggle and the previs protect frame
- **Acceptance:** a shot flagged 9:16 generates 1080×1920 while its neighbours generate
  1920×1080, in the same project, and the board tiles show the crop that would be lost.

### M5 · Brand, compliance and the package — four days
- `099_brands.sql`, `lib/brand-kit.js`, `lib/compliance.js`, `lib/spot-package.js`
- `routes/brands.js`, `page-brand`, the gate in `run-plan.js` and `dry-run.js`
- the Export page's package card
- **Acceptance:** a project whose script says "clinically proven" with no substantiated
  `film_claims` row **cannot start a run**, and the finding names the phrase. A cleared project
  produces a folder that opens in Premiere with media relinked and no manual repair.

**Then stop.** Everything after this is Premiere configuration (a `.mogrt` per brand, a Media
Encoder preset group) or ops (a spreadsheet). Neither belongs in this repo.

---

## 9. House rules this plan inherits

- **ADR-002: no framework.** Routes dispatch on `urlParts` in `server.js`.
- **ADR-001: SQLite.** Migrations are numbered SQL files, applied on startup by `db/schema.js`.
- **Planning is pure and separate from executing** — `conform.js`, `run-plan.js`,
  `subject-gallery.js` all follow it. Every new `lib/` module here is pure.
- **A capability with no control does not exist.** See the header of `manual-edit.test.js`.
- **The free preview comes before the paid path.** `sequences/:id/plan`, `analysis/brief`,
  `run_plan`, `dry_run` all spend nothing. `compliance` and `deliverables/check` join that set.
- **Comments say why, not what.** Match the existing files — the reasoning that would
  otherwise be re-derived from a diff belongs in the source.
- **CLAUDE.md is not optional.** `docs-drift.test.js` fails the build if a new module, route
  or test file is missing from it, or if the migration count is stale. Update it in the same
  commit — the count appears twice (the tree, and the storage section).

---

## 10. Reference — the delivery matrix

Not engine behaviour. This is what Premiere exports, and what `spec.md` in the package states.

### Broadcast and CTV

| Deliverable | Size / ratio | fps | Codec | Audio | Loudness | Also |
|---|---|---|---|---|---|---|
| NA broadcast :30 / :15 | 1920×1080 · 16:9 | 29.97 DF | ProRes 422 HQ | 1/2 mix · 3/4 M&E | −24 LKFS ±2, TP ≤ −2 dBTP | Ad-ID slate, textless, exactly 30;00 |
| UK/AU broadcast :30 / :15 | 1920×1080 · 16:9 | 25 | ProRes 422 HQ | stereo + M&E | −23 LUFS ±1, TP ≤ −1 dBTP | Clearcast clock number, textless |
| CTV programmatic | 1920×1080 · 16:9 | 29.97 / 30 | H.264 20–30 Mbps | AAC 320k | −24 LKFS or platform spec | no black head/tail, hard 15.00 / 30.00 s |
| Textless master | 1920×1080 · 16:9 | match | ProRes 422 HQ | M&E only | match | no supers, no endcard |

### Digital and social

| Placement | Size / ratio | Durations | Codec | Loudness | Captions / safe area |
|---|---|---|---|---|---|
| YouTube / site hero | 1920×1080 or 3840×2160 · 16:9 | :30 :15 :06 | H.264 high 20–40 Mbps · AAC 320k | −14 LUFS | SRT sidecar; title-safe 90% |
| Meta feed | 1080×1350 · 4:5 | :15 :30 | H.264 · AAC | −14 LUFS | burned; hook in first 2 s |
| Reels / TikTok / Shorts | 1080×1920 · 9:16 | :06 :10 :15 | H.264 · AAC | −14 LUFS | burned; clear top 14%, bottom 20% |
| Square / carousel | 1080×1080 · 1:1 | :15 | H.264 · AAC | −14 LUFS | burned |
| End-frame stills | 1200×628 · 1080×1080 · 1080×1920 | — | PNG | — | static companions |

### Exact frame counts — `frameCount()` must return these

| Runtime | @ 29.97 DF | @ 25 | @ 30 | Last frame (29.97 DF) |
|---|---|---|---|---|
| :30 | 900 | 750 | 900 | 00:00:29;29 |
| :15 | 450 | 375 | 450 | 00:00:14;29 |
| :10 | 300 | 250 | 300 | 00:00:09;29 |
| :06 | 180 | 150 | 180 | 00:00:05;29 |

### Frame rate is chosen at generation, never conformed

| Media plan | fps | Generate at |
|---|---|---|
| US / CA broadcast + CTV | 29.97 DF | 3840×2160 16:9 |
| UK / AU broadcast | 25 | 3840×2160 16:9 |
| Social-only campaign | 30 | 2160×3840 9:16 (vertical native; 16:9 derived) |
| Cinematic web film | 24 | 3840×2160 16:9 |

Conforming 24p generated footage to 29.97 for a CTV buy is the one mistake that cannot be
fixed in the grade.

### Crop budget

| Target from a 16:9 frame | Width kept |
|---|---|
| 1:1 | 56% |
| 4:5 | 45% |
| 9:16 | **32%** |

---

## 11. Loose ends worth naming

- **VO shape.** `dialogue-builder.js` builds one payload per dialogue line from Fountain. A
  spot's VO is one continuous read with alternate takes per cut-down and per market.
  `buildNarrationPayload()` registers as a voice sub-type — the precedent is in
  `capability-payloads.js`, where `post` carries four sub-types and defaults when none is named.
  Read direction has a home already: `film_scenes.delivery_direction`, migration `093`.
- **Gain staging, not loudness.** Generated stems arrive at wildly different levels. A rough
  match so the mix does not start with a −40 LUFS VO against a −8 LUFS bed is engine work;
  hitting −24 LKFS is not. Do not run `loudnorm` here.
- **Spend attribution** is one line in `provider-config.js` `tag()`, which already carries
  project, shot and scene. Adding client and campaign is what lets `spend_report` group by
  client — contribution margin per creative, which is the number the business turns on.
- **A spot project template** (`flow-templates.js` + `project-presets.js`) is worth building
  once M1–M5 are green. `routes/demo-project.js` is the working precedent for standing up a
  whole project shape in one call.
