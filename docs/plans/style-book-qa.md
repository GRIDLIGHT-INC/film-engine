# Style Book — QA Specification and Coverage Audit

The style book is **already built** (`lib/style-book.js`, `routes/style-book.js`,
migrations 085/086, six `stylebook_*` MCP tools, a page on the rail). So this is
not a plan for unwritten work: it is the complete case set derived from the code,
with each case marked **COVERED** by a shipped test or **GAP**.

The denominator is derived from the code, never from the feature description —
the route dispatch table, the library's own exports, the MCP registry, the facet
lists and the link classifier. A case set written from a description is complete
the day it is written and silently short one route the next.
`backend/tests/style-book-qa.test.js` enforces that derivation.

## The surface — 53 items

| Registry | Source of truth | Count |
|---|---|---|
| Route operations | `handleStyleBook` dispatch | 11 |
| Library exports | `require('lib/style-book')` | 8 |
| MCP tools | `lib/mcp-tools` `stylebook_*` | 6 |
| Camera facets | `mergeableFacets()` + `POSE_FACETS` | 10 |
| Fields never written | `NEVER_WRITES` | 4 |
| Link classifications | `classifyLink` + refusal | 6 |
| Integration contracts | the implementation plan | 8 |

## Acceptance criteria

The subsystem is accepted when **all of the following hold**:

1. Every one of the 11 route operations has at least one passing case for its
   happy path **and** its principal error path.
2. A director's decision survives a round trip: an entry applied to a shot
   changes what `buildStoryboardPrompt` and `buildVideoPrompt` would send.
3. Nothing an entry carries can write a **delivery** spec (`NEVER_WRITES`).
4. A merge never destroys what it was not asked about — for the card
   (`applyEntryToShot`) and for the entry itself (`PUT`).
5. A library entry outlives the deletion of any project.
6. Every verb reachable from the page is reachable from an agent.
7. No case depends on execution order or on wall-clock time.

Determinism rules for every case below: fixtures create their own project and
shot, ids are read back rather than assumed, and no case reads the live
database (`FILM_DATA_DIR` is redirected — the `test-isolation` contract).

---

## A. Validation — `validateEntry`

#### SB-VAL-01 — an entry is validated by the card's own vocabulary
**Scenario** An entry names `shot_type: "low-angle"`, a value `validateSceneCard` accepts.
**Inputs** `validateEntry({ name: 'Hero low', camera: { shot_type: 'low-angle' } })`.
**Expected** `{ valid: true }`. `validateEntry` **delegates** to `validateSceneCard`.
**Failure means** the entry keeps a private copy of the vocabulary, so it will accept a value the card later refuses — the failure surfaces at apply time, on a shot the director cares about. **COVERED** (`style-book.test.js`).

#### SB-VAL-02 — a shot type the card refuses is refused here
**Scenario** An entry names `shot_type: "worm-cam"`.
**Inputs** `validateEntry({ name: 'x', camera: { shot_type: 'worm-cam' } })`.
**Expected** `valid: false`, errors naming the legal set.
**Failure means** an unusable entry is stored and fails only when applied. **COVERED**.

#### SB-VAL-03 — an entry may carry only what it knows
**Scenario** An entry states a lens and nothing else.
**Inputs** `{ name: 'The 85', camera: { lens: '85mm' } }`.
**Expected** valid; absent facets are absent, never defaulted.
**Failure means** an invented default is indistinguishable from a deliberate choice and would override a card. **COVERED**.

#### SB-VAL-04 — a nameless entry is refused
**Scenario** Create with no `name`.
**Inputs** `validateEntry({ camera: { lens: '85mm' } })`.
**Expected** `valid: false`. A book of unnamed entries cannot be searched.
**Failure means** entries accumulate that a director cannot identify. **GAP**.

#### SB-VAL-05 — `NAME_MAX` truncates rather than rejecting
**Scenario** A 500-character name against `NAME_MAX` (200).
**Inputs** `POST /film/style-book` with the long name.
**Expected** stored at exactly 200 characters; 201 request succeeds.
**Failure means** either a silent 500 from the column, or a rejection for something the app could simply trim. **GAP** — `NAME_MAX` appears in no test.

#### SB-VAL-06 — `DESCRIPTION_MAX` and `TAGS_MAX` behave the same way
**Scenario** Over-long description (2000) and tags (500).
**Inputs** strings of 3000 and 900 characters.
**Expected** truncated to `DESCRIPTION_MAX` / `TAGS_MAX`, entry created.
**Failure means** an inconsistent limit policy — one field trims, another rejects — which is impossible to explain in a UI. **GAP**.

---

## B. Applying to a shot — `applyEntryToShot`

#### SB-APPLY-01 — every mergeable facet is carried
**Scenario** An entry setting all eight of `shot_type`, `movement`, `note`, `lens`, `sensor`, `aperture`, `focus_distance_m`, `height_m`.
**Inputs** a card with none of them.
**Expected** all eight appear in `applied`; the card carries all eight.
**Failure means** a facet silently does not travel, so a favourite angle applies partially and the director cannot see which half. **COVERED**.

#### SB-APPLY-02 — a stage pose is skipped and says so
**Scenario** An entry carrying `position` and `rotation` (`POSE_FACETS`).
**Inputs** `applyEntryToShot(entry, card)`.
**Expected** both in `skipped`; neither written to the card.
**Failure means** six degrees of freedom from one stage's coordinate space put the camera somewhere else entirely in another scene — and an omission that is silent is a bug, where one that is stated is a decision. **COVERED**.

#### SB-APPLY-03 — merging never replaces the camera block
**Scenario** Card has `lens: '35mm'` and `movement: 'push-in'`; entry states only `shot_type`.
**Inputs** apply.
**Expected** `shot_type` written; `lens` and `movement` untouched.
**Failure means** the `previsFacets` bug repeats — applying an entry makes a shot *vaguer* than leaving it alone. **COVERED**.

#### SB-APPLY-04 — an entry that carries nothing this shot can use reports it
**Scenario** Entry states only pose facets.
**Inputs** apply to any card.
**Expected** `applied: []`, `skipped` non-empty.
**Failure means** "I applied my low-angle" and "it carried nothing" are indistinguishable. **COVERED**.

#### SB-APPLY-05 — a delivery spec is never written
**Scenario** An entry whose stored camera JSON contains `aspect_ratio`, `resolution`, `frame_rate`, `color_space` (`NEVER_WRITES`).
**Inputs** apply to a card.
**Expected** none of the four reach the card; each is reported skipped.
**Failure means** look development leaks into one shot: a single shot silently delivered at a different aspect or frame rate than the film, which surfaces as drift in the cut long after it was paid for. **GAP** — `NEVER_WRITES` appears in no shipped test.

#### SB-APPLY-06 — applying reaches the generator, not just the row
**Scenario** Apply an entry naming an 85mm, then build the image and video payloads.
**Inputs** `buildStoryboardPrompt` / `buildVideoPrompt` for that shot, before and after.
**Expected** the payloads differ, and name the entry's lens.
**Failure means** the book is a notes field — the value is the apply, not the notes. **COVERED** (route-level).

#### SB-APPLY-07 — precedence is unchanged
**Scenario** A shot with saved previs blocking, then an entry applied.
**Inputs** `effectiveCamera` for that shot.
**Expected** the entry writes **onto the card**; it does not become a fourth precedence level.
**Failure means** a thing consulted at generation time becomes a display that eventually disagrees with the generator. **GAP**.

#### SB-APPLY-08 — `POST /film/shots/:id/style-book/:entryId` on an unknown entry
**Scenario** Apply a non-existent entry id (`applyToShot`).
**Inputs** valid shot, `entryId` that does not exist.
**Expected** 404, card unchanged.
**Failure means** a typo silently no-ops and reads as "the style book does nothing". **GAP**.

#### SB-APPLY-09 — `applyToShot` on an unknown shot
**Scenario** A valid entry is applied to a shot id that does not exist.
**Inputs** `POST /film/shots/00000000-0000-0000-0000-000000000000/style-book/:entryId`.
**Expected** 404; no row written anywhere.
**Failure means** an agent applying to a stale shot id gets a success it can act on. **GAP**.

---

## C. Entry CRUD — the routes

#### SB-CRUD-01 — `GET /film/style-book` lists the library (`listStyleBook`, project `null`)
**Scenario** Two library entries and one project-scoped entry exist; the library is listed with no project.
**Inputs** `GET /film/style-book`.
**Expected** exactly the two library entries, each labelled `scope: "library"`.
**Failure means** a project's private variants leak into every other film. **COVERED**.

#### SB-CRUD-02 — `GET /film/projects/:id/style-book` lists project **and** library
**Scenario** The same three entries, listed from inside the owning project.
**Inputs** `GET /film/projects/:projectId/style-book`.
**Expected** all three rows, each labelled `scope` as `project` or `library`.
**Failure means** a director's library is invisible from inside a film, which is the entire point of it being cross-project. **COVERED**.

#### SB-CRUD-03 — `POST /film/style-book` creates with no project open (`createEntry`, null)
**Scenario** An entry is added to the library before any film exists.
**Inputs** `POST /film/style-book` with `{ name: 'The 85 two-shot', camera: { lens: '85mm' } }`.
**Expected** 201; the stored row has `project_id` NULL.
**Failure means** the common case — add to my own library — becomes the awkward one, and requires opening an unrelated project. **COVERED**.

#### SB-CRUD-04 — `POST /film/projects/:id/style-book` creates project-scoped
**Scenario** A variant specific to one film is recorded from inside it.
**Inputs** `POST /film/projects/:projectId/style-book` with a valid entry.
**Expected** 201 with `project_id` set; the entry does not appear in another project's list.
**Failure means** scope is decorative and every entry is global. **COVERED**.

#### SB-CRUD-05 — `GET /film/style-book/:id` reads one entry (`getEntry`)
**Scenario** A single entry is read directly by id.
**Inputs** `GET /film/style-book/:entryId`.
**Expected** the entry, its camera facets, and its visuals array.
**Failure means** an agent has to list an entire library to read the one row it is about to change. **COVERED**.

#### SB-CRUD-06 — `getEntry` on an unknown id
**Scenario** An entry that was deleted, or an id with a typo, is read.
**Inputs** `GET /film/style-book/does-not-exist`.
**Expected** 404 with a message — never 200 carrying null.
**Failure means** a caller cannot distinguish "deleted" from "empty", and an agent proceeds on nothing. **GAP**.

#### SB-CRUD-07 — `PUT /film/style-book/:id` MERGES (`updateEntry`)
**Scenario** An entry carrying a name, a description and `camera.lens` is renamed and nothing else.
**Inputs** `PUT /film/style-book/:entryId` with `{ name: 'Renamed' }`.
**Expected** the name changes; the description and `camera.lens` are byte-identical afterwards.
**Failure means** renaming an entry clears the camera details that were the only reason to keep it — a whole-document replace where the tool description promises a merge. **GAP** — no shipped test issues a `PUT` at all.

#### SB-CRUD-08 — an explicit `null` facet CLEARS it
**Scenario** An entry carries `camera.lens`; the director removes just that facet.
**Inputs** `PUT` with `{ camera: { lens: null } }`.
**Expected** `lens` is absent from the stored camera; the other facets survive.
**Failure means** a facet can be added and never removed — the destructive-default problem in reverse, and the entry becomes unusable on any shot with a different lens. **GAP**.

#### SB-CRUD-09 — a merge that produces an invalid entry is refused whole
**Scenario** An update introduces a shot type the scene card refuses.
**Inputs** `PUT` with `{ camera: { shot_type: 'worm-cam' } }`.
**Expected** 400 with details; the stored row unchanged, not partially written.
**Failure means** the update route becomes the one way to get a broken entry into the book, and it fails later at apply time. **GAP**.

#### SB-CRUD-10 — `scope` can be changed both ways
**Scenario** An entry authored inside a film is promoted to the library, then demoted again.
**Inputs** `PUT { scope: 'library' }`, then `PUT { scope: 'project', project_id: <id> }`.
**Expected** `project_id` becomes NULL, then is set again.
**Failure means** an entry written while a project happened to be open can never join the library, which is how the library stays empty. **GAP**.

#### SB-CRUD-11 — `sort_order` is honoured only when finite
**Scenario** An ordering is set, then a non-number is submitted for the same field.
**Inputs** `PUT { sort_order: 3 }`, then `PUT { sort_order: 'x' }`.
**Expected** 3 stored; the second is ignored and the order stays 3.
**Failure means** ordering silently resets, or a bad value writes NULL into an ordering column and the book reshuffles itself. **GAP** — `sort_order` appears in no test.

#### SB-CRUD-12 — `DELETE /film/style-book/:id` removes the entry (`deleteEntry`)
**Scenario** An entry the director no longer wants is removed.
**Inputs** `DELETE /film/style-book/:entryId`.
**Expected** 200; a subsequent `GET` is 404; other entries untouched.
**Failure means** a library that can only grow is not one you can curate — the same trap the location views had. **COVERED**.

#### SB-CRUD-13 — deleting an entry takes its media rows and files
**Scenario** An entry holding one upload and one link is deleted.
**Inputs** `DELETE /film/style-book/:entryId`, then inspect `film_style_book_media` and the disk.
**Expected** no rows for that entry; the uploaded file is gone.
**Failure means** orphan rows pointing at nothing, or disk nobody can find — the half-delete the plate views already paid for once. **GAP**.

---

## D. Visuals — media

#### SB-MEDIA-01 — every way of adding a visual works (`addMedia`)
**Scenario** A frame grab on this machine and a clip that lives on the web are both attached to one entry.
**Inputs** `POST /film/style-book/:id/media` once with file bytes, once with `{ source_url }`.
**Expected** both stored; both returned by `getEntry`.
**Failure means** a reference library with one way in — and the reference a director actually has is the one it refuses. **COVERED**.

#### SB-MEDIA-02 — an upload has bytes and a link does not get a fake path
**Scenario** The two storage shapes are compared directly.
**Inputs** the two rows created by SB-MEDIA-01.
**Expected** upload → `file_path` set and `source_url` NULL; link → `source_url` set and `file_path` NULL.
**Failure means** the serving route 404s on something that was never a file, which is why `source_url` is its own column (migration 086). **COVERED**.

#### SB-MEDIA-03 — an uploaded visual can actually be fetched (`serveMedia`)
**Scenario** The URL the page renders is requested the way a browser would.
**Inputs** `GET /film/style-book/media/:mediaId/file`.
**Expected** HTTP **200** and the bytes — resolved, not merely asserted non-null.
**Failure means** the `servedUrlFor` mistake repeats: a perfectly good string and a 404, which no string check can catch. **COVERED**.

#### SB-MEDIA-04 — `serveMedia` on a link-only visual
**Scenario** The file route is requested for a visual that is a link, not an upload.
**Inputs** `GET /film/style-book/media/:linkMediaId/file`.
**Expected** 404 with a reason; never a crash and never an empty 200.
**Failure means** a link renders as a broken image with no explanation of why. **COVERED** (partially).

#### SB-MEDIA-05 — a YouTube link is classified `youtube` with an embed
**Scenario** A director pastes a YouTube URL in each of the forms people actually paste.
**Inputs** `watch?v=ID`, `youtu.be/ID`, `m.youtube.com/watch?v=ID`.
**Expected** `link_kind: 'youtube'` and an `embed_url` pointing at `/embed/ID`.
**Failure means** the page has to guess what a URL is, and an agent reading the entry cannot tell either. **COVERED**.

#### SB-MEDIA-06 — a Vimeo link is classified `vimeo`, numeric ids only
**Scenario** A Vimeo video and a Vimeo channel page are both pasted.
**Inputs** `vimeo.com/123456` and `vimeo.com/channels/staffpicks`.
**Expected** the first → `vimeo` with a player embed; the second → plain `link`.
**Failure means** a non-video page is embedded as a player and shows nothing. **COVERED**.

#### SB-MEDIA-07 — an image extension classifies `image`
**Scenario** A direct link to a still is attached.
**Inputs** URLs ending `.png .jpg .jpeg .gif .webp .avif`.
**Expected** `link_kind: 'image'`, `embed_url: null`.
**Failure means** a still is offered with a play button. **COVERED**.

#### SB-MEDIA-08 — a video extension classifies `video`
**Scenario** A direct link to a clip is attached.
**Inputs** URLs ending `.mp4 .webm .mov .m4v`.
**Expected** `link_kind: 'video'`.
**Failure means** a clip renders as a dead thumbnail, and the move it was kept for cannot be watched. **COVERED**.

#### SB-MEDIA-09 — anything else is a bare `link`
**Scenario** An article or a gallery page is attached.
**Inputs** `https://example.com/article`.
**Expected** `link_kind: 'link'`, no embed.
**Failure means** an arbitrary third-party page is embedded in an iframe inside the app. **COVERED**.

#### SB-MEDIA-10 — a non-http(s) URL is REFUSED
**Scenario** A hostile or malformed URL is submitted as a visual.
**Inputs** `javascript:alert(1)`, `data:text/html,<script>…`, `file:///etc/passwd`, `not a url`.
**Expected** `classifyLink` returns null, the route refuses, nothing is stored.
**Failure means** a script-injection path into something the page renders — with extra steps. **COVERED**.

#### SB-MEDIA-11 — rubbish bytes are refused rather than stored
**Scenario** A text file renamed to `.png` is uploaded.
**Inputs** a small non-image buffer with an image filename.
**Expected** refused; the bytes decide the type, never the name.
**Failure means** a visual that cannot be decoded later, discovered only when someone opens it. **COVERED**.

#### SB-MEDIA-12 — `DELETE /film/style-book/media/:id` (`deleteMedia`)
**Scenario** One visual is removed from an entry that has two.
**Inputs** `DELETE /film/style-book/media/:mediaId`.
**Expected** the row and its file go together; the entry and its other visual survive.
**Failure means** either a listed visual whose picture is gone, or a file nobody can find. **GAP**.

#### SB-MEDIA-13 — an oversize upload answers before it hangs up
**Scenario** A full-resolution frame grab beyond the media limit is uploaded.
**Inputs** a payload larger than the configured ceiling.
**Expected** HTTP 413 naming the limit, sent **before** the request is destroyed.
**Failure means** the browser reports a network error, which `api()` maps to "Backend offline" — indistinguishable from a dead server, on the one feature where large files are normal. **GAP**.

#### SB-MEDIA-14 — the reference-slot reality is stated where visuals are added
**Scenario** A director attaches five visuals to an entry.
**Inputs** the entry page with five visuals present.
**Expected** the page says plainly that visuals are **for a person**: `KIND_RANK` puts `style` last against 3 references on Runway and 5 on Meshy, so a style still is dropped before the request is built on any shot with a cast and a location, and a clip reaches no generator at all.
**Failure means** a director attaches five pictures believing the frame is conditioned on them — a reference library that is really a scrapbook. **COVERED** in the design documents; **GAP** at runtime.

---

## E. The agent surface — MCP

#### SB-MCP-01 — `stylebook_list` lists library and project scopes
**Scenario** An agent asks what is in the book, with and without a project.
**Inputs** `stylebook_list({})` and `stylebook_list({ project_id })`.
**Expected** the same rows the HTTP route returns, each labelled `scope`.
**Failure means** the agent and the page disagree about what exists, and the director trusts whichever they looked at last. **COVERED**.

#### SB-MCP-02 — `stylebook_get` reads one entry with its visuals
**Scenario** An agent reads the entry it is about to apply.
**Inputs** `stylebook_get({ entry_id })`.
**Expected** camera facets and visuals, matching `GET /film/style-book/:id`.
**Failure means** an agent must list everything to read one row, which on a large book is most of a context window. **COVERED**.

#### SB-MCP-03 — `stylebook_create` accepts the same facets a scene card does
**Scenario** An agent records a shot the director described in conversation.
**Inputs** `stylebook_create({ name, camera: { shot_type, lens, height_m } })`.
**Expected** created and valid; the tool schema names the same vocabulary the card validates.
**Failure means** an agent learns the legal set from a validation error, one value at a time. **COVERED**.

#### SB-MCP-04 — `stylebook_update` merges, never replaces
**Scenario** An agent renames an entry over MCP and changes nothing else.
**Inputs** `stylebook_update({ entry_id, name: 'Renamed' })`.
**Expected** camera facets survive — identical semantics to SB-CRUD-07.
**Failure means** the two write paths disagree and the agent path is the destructive one, which is the worse half since agents write more often. **GAP**.

#### SB-MCP-05 — `stylebook_delete` removes an entry and its visuals
**Scenario** An agent tidies the book.
**Inputs** `stylebook_delete({ entry_id })`.
**Expected** entry and its media gone; other entries untouched.
**Failure means** an agent deletes by guessing and leaves orphans behind it. **COVERED**.

#### SB-MCP-06 — `stylebook_apply` is the step that makes the book worth having
**Scenario** An agent applies a favourite angle to a shot.
**Inputs** `stylebook_apply({ shot_id, entry_id })`.
**Expected** returns `applied` and `skipped`, matching `applyEntryToShot` exactly.
**Failure means** an agent reports success for an entry that carried nothing this shot could use. **COVERED**.

#### SB-MCP-07 — no `stylebook_*` tool calls a server-side LLM
**Scenario** The six tools are checked against the route modules that require the LLM client.
**Inputs** the derived forbidden set from `mcp-no-server-llm`.
**Expected** none of the six dispatches to an LLM-requiring route.
**Failure means** the user is asked for a second API key for a question the connected model has already read — the connected model **is** the LLM here. **COVERED**.

---

## F. Scope, storage and integration contracts

#### SB-SCOPE-01 — deleting a project does NOT delete the library
**Scenario** A library entry is authored while a project happens to be open; that project is later deleted.
**Inputs** create with `scope: 'library'`, then `DELETE /film/projects/:id`.
**Expected** the entry survives with `project_id` NULL — `ON DELETE SET NULL`, never `CASCADE`.
**Failure means** the `film_refsheet_jobs` trap of migration 067 repeats: a director's own library deleted as a side effect of tidying up a film. **COVERED**.

#### SB-SCOPE-02 — deleting a project DOES remove its project-scoped entries and their media
**Scenario** A project with its own entries and uploaded visuals is deleted.
**Inputs** `DELETE /film/projects/:id`, then count rows in every child table.
**Expected** no orphan rows in `film_style_book` or `film_style_book_media`.
**Failure means** a slow leak that surfaces much later as assets nothing can reach. **GAP** — `project-delete` is example-based and must be extended by hand.

#### SB-INT-01 — `docs-drift`: both new files are named in CLAUDE.md
**Scenario** The documentation is checked against the tree on disk.
**Inputs** `node --test backend/tests/docs-drift.test.js`.
**Expected** `lib/style-book.js` and `routes/style-book.js` both appear in CLAUDE.md.
**Failure means** the tree and its documentation diverge silently, and the next reader trusts the stale half. **COVERED**.

#### SB-INT-02 — `mcp-no-server-llm`: a 9th `ENTITY_ROUTES` entry, a tool per verb
**Scenario** The verb coverage is derived from the router rather than listed by hand.
**Inputs** `node --test backend/tests/mcp-no-server-llm.test.js`.
**Expected** every method the style-book router dispatches has a covering tool.
**Failure means** a thing the app can do and an agent cannot — the hardest gap to notice, because there is no error to read. **COVERED**.

#### SB-INT-03 — `nav-chrome`: the rail button resolves
**Scenario** Every rail button is followed to a page or an explicit handler.
**Inputs** `node --test backend/tests/nav-chrome.test.js`.
**Expected** the Style button resolves.
**Failure means** a button wired to nothing looks identical to a working one until it is clicked. **COVERED**.

#### SB-INT-04 — `nav-flow`: the page is in `ALWAYS_AVAILABLE`
**Scenario** Every page is placed in exactly one production phase, or declared always available.
**Inputs** `node --test backend/tests/nav-flow.test.js`.
**Expected** `stylebook` is in `ALWAYS_AVAILABLE`, not in any of the nine `PROJECT_PHASES`.
**Failure means** a library that outlives every project is buried inside the workflow of one. **COVERED**.

#### SB-INT-05 — `test-isolation`: no test opens the real database
**Scenario** The suite is run with the director's real library present.
**Inputs** `node --test backend/tests/test-isolation.test.js`.
**Expected** every style-book test redirects `FILM_DATA_DIR`.
**Failure means** running the suite mutates the director's actual library. **COVERED**.

#### SB-INT-06 — `manual-edit`: every accepted text field has a control
**Scenario** The route's accepted fields are compared against the page's controls.
**Inputs** `node --test backend/tests/manual-edit.test.js`.
**Expected** `name`, `description` and `tags` are all editable on the page.
**Failure means** a field the route accepts and the page cannot set is reachable only from an agent or curl. **COVERED**.

#### SB-INT-07 — `project-delete`: the child tables are enumerated
**Scenario** The list of tables a worked-on project accumulates is checked.
**Inputs** `node --test backend/tests/project-delete.test.js`.
**Expected** `film_style_book_media` is included.
**Failure means** the delete is only as safe as whoever remembered to extend the list. **GAP**.

#### SB-INT-08 — `card-overflow`: the entry card's action row wraps
**Scenario** An entry card is rendered at a narrow width with all its buttons.
**Inputs** `node --test backend/tests/card-overflow.test.js`.
**Expected** `.card-actions` inside the entry card wraps; no button painted outside its own card.
**Failure means** the Delete button leaks past the card border, exactly as it did on Characters. **GAP** — example-based, extend by hand.

---

## Coverage audit

**Covered by shipped tests** — `backend/tests/style-book.test.js` (16 cases) and
`backend/tests/style-book-media.test.js` (7), plus `style-book-plan.test.js` (8)
and `style-book-research.test.js` (8) which police the design documents rather
than the runtime.

## Gaps — what is NOT covered today

Named individually rather than counted, because a gap written down is work and a
gap silently excluded is one nobody finds again. Each was confirmed by searching
the shipped tests for the identifier, not by reading the test titles.

| Gap | Cases | Why it matters |
|---|---|---|
| `NEVER_WRITES` is enforced nowhere | SB-APPLY-05 | an entry could write a delivery spec onto one shot |
| No test issues a `PUT` | SB-CRUD-07/08/09/10, SB-MCP-04 | merge-not-replace is promised in the tool description and unproven |
| `NAME_MAX` / `DESCRIPTION_MAX` / `TAGS_MAX` | SB-VAL-05/06 | truncation policy is unverified in both directions |
| `sort_order` | SB-CRUD-11 | ordering can silently reset |
| Media and entry deletion | SB-CRUD-13, SB-MEDIA-12 | orphan rows or unreachable files |
| Error paths (404s) | SB-CRUD-06, SB-APPLY-08/09 | a typo no-ops and reads as "it does nothing" |
| Oversize upload | SB-MEDIA-13 | surfaces as "Backend offline" |
| Example-based contracts | SB-SCOPE-02, SB-INT-07, SB-INT-08 | must be extended by hand; they do not self-derive |

**Priority order for closing them**: SB-APPLY-05 (silent wrong output), then the
`PUT` group (a promised guarantee that is unproven), then deletion, then the
404s, then the example-based contracts.
