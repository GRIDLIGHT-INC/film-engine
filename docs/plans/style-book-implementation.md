# The Style Book — implementation plan

Follows [`style-book-research.md`](style-book-research.md). That document decided *what* and
*why*; this one decides *where*, *what the interfaces are*, and *in what order*.

**Not yet built.** This is the plan the tests will be written against.

---

## 1. The integration surface, derived from the suite

A new subsystem here does not merely add files. Six existing tests derive their denominator
from a directory scan or a registry, so a style book joins their set the moment the files
land — each imposing a contract. A plan that has not read them describes work that fails on
the day it arrives.

| Test | Derives from | Contract it imposes |
|---|---|---|
| `docs-drift.test.js` | `readdirSync(lib)`, `readdirSync(tests)` | every new `lib/` module and every new test file must appear in **CLAUDE.md** |
| `mcp-no-server-llm.test.js` | `ENTITY_ROUTES` (8 entries) + the route file's own dispatch | a 9th entry, and a tool for every HTTP verb the module handles |
| `nav-chrome.test.js` | `var RAIL` | the new **RAIL** button must resolve to a page or an explicit handler |
| `nav-flow.test.js` | `PROJECT_PHASES` (9) + `ALWAYS_AVAILABLE` (3) | every page in exactly one phase — or in **ALWAYS_AVAILABLE** |
| `test-isolation.test.js` | `readdirSync(tests)` | the new test must set **FILM_DATA_DIR**; it may not open the real database |
| `manual-edit.test.js` | `readdirSync(routes)` | every text field the update route accepts needs a control, or a named exemption |

Two more are example-based and must be extended by hand rather than automatically:
`project-delete.test.js` (walks 9 child tables) and `card-overflow.test.js` (if the page
uses `entity-card`).

**`nav-flow` deserves its own line of reasoning.** The style book is *cross-project* — it is
not a stage of making a film, so it belongs in `ALWAYS_AVAILABLE` alongside `dashboard`,
`settings` and `jobsqueue`, not in one of the nine `PROJECT_PHASES`. Putting it in a phase
would place a library that outlives every project inside the workflow of one.

---

## 2. Files

### New

| Path | Responsibility |
|---|---|
| `backend/db/migrations/085_style_book.sql` | the two tables |
| `backend/lib/style-book.js` | pure: validation, the card merge. No I/O. |
| `backend/routes/style-book.js` | HTTP dispatch, DB reads/writes |
| `backend/tests/style-book.test.js` | set-based over the camera facets and the scopes |

`085` is the real next number — the tree is at `084_clip_coverage.sql`.

**Why `lib/` and `routes/` split.** The same split `pipeline-engine.js` / `routes/pipeline.js`
and `flow-graph.js` / `routes/flows.js` already use, and for the same reason: the merge onto
a scene card is pure algebra over two objects and is worth testing without a database. It is
also what lets `applyEntryToShot` be called from the MCP tool, the page and (later) previs
without three code paths.

### Edited

| Path | Edit |
|---|---|
| `backend/server.js` | dispatch `/film/style-book*` and `/film/projects/:id/style-book` |
| `backend/lib/mcp-tools.js` | six entries in `PRODUCTION_TOOLS` |
| `backend/lib/nav-flow.js` | `ALWAYS_AVAILABLE` gains `stylebook` |
| `src/index.html` | `var RAIL` 7th entry; a `page-stylebook` div; the page id list; the renderer |
| `CLAUDE.md` | the tree (both new files) and the test-run list |
| `backend/tests/mcp-no-server-llm.test.js` | `ENTITY_ROUTES` 9th entry |
| `backend/tests/project-delete.test.js` | `film_style_book` in the child-table walk |

---

## 3. Schema — `085_style_book.sql`

```sql
CREATE TABLE film_style_book (
    id            TEXT PRIMARY KEY,
    -- NULL = the director's library, visible from every project. A project id
    -- makes it specific to one film.
    --
    -- ON DELETE SET NULL, never CASCADE. A library entry authored while a
    -- project was open must outlive that project; cascading would delete the
    -- director's own library as a side effect of tidying up a film. This is
    -- the film_refsheet_jobs trap from migration 067, which made DELETE
    -- /projects/:id return 500 on any project that had generated a ref sheet.
    project_id    TEXT REFERENCES film_projects(id) ON DELETE SET NULL,
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    camera_json   TEXT NOT NULL DEFAULT '{}',
    tags          TEXT NOT NULL DEFAULT '',
    sort_order    INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_style_book_scope ON film_style_book(project_id, sort_order);

CREATE TABLE film_style_book_media (
    id            TEXT PRIMARY KEY,
    entry_id      TEXT NOT NULL REFERENCES film_style_book(id) ON DELETE CASCADE,
    media_kind    TEXT NOT NULL DEFAULT 'image',
    asset_id      TEXT REFERENCES film_assets(id) ON DELETE SET NULL,
    file_path     TEXT NOT NULL DEFAULT '',
    note          TEXT NOT NULL DEFAULT '',
    sort_order    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_style_book_media_entry ON film_style_book_media(entry_id, sort_order);
```

`media` CASCADEs from its entry and SET NULLs from the asset: deleting an entry should take
its attachments, and deleting a generated asset should not delete the row that records a
visual existed. No CHECK on `media_kind` — migration 042 recorded that a CHECK here cannot be
widened in place.

---

## 4. Interfaces

### `backend/lib/style-book.js` — pure

```js
/**
 * validateEntry(entry) → { valid: boolean, errors: string[] }
 *
 * Validates name, description, tags and camera_json. The camera object is
 * validated by DELEGATING to validateSceneCard({ shot_code: '_', camera }) —
 * never a private copy of the vocabulary. A style book that accepts a shot
 * type the card refuses produces an entry that cannot be applied, and the
 * failure surfaces at apply time on a shot the director cares about.
 */
function validateEntry(entry)

/**
 * applyEntryToShot(entry, card) → { card, applied: string[], skipped: string[] }
 *
 * MERGES the entry's camera facets onto a copy of the scene card and returns
 * the new card. Merge, never replace: a card carries dialogue, characters and
 * a description that an entry knows nothing about, and PUT /shots/:id merges
 * for exactly this reason.
 *
 * Reports `applied` and `skipped` rather than returning a card silently:
 * "I applied my low-angle" and "it had no height and changed nothing" look
 * identical from the outside otherwise.
 *
 * Pure. No database, no shot id — the caller reads and writes.
 */
function applyEntryToShot(entry, card)

/**
 * mergeableFacets() → string[]
 *
 * The facets an entry may carry, DERIVED from the scene-card schema source
 * rather than listed, minus POSE_FACETS. Derived so a facet added to the card
 * later is carried without anyone remembering.
 */
function mergeableFacets()

const POSE_FACETS = ['position', 'rotation'];   // see §5
```

### `backend/routes/style-book.js` — dispatch

```js
/**
 * handleStyleBook(req, res, urlParts, query)
 *
 *   GET    /film/style-book                      library entries (project_id IS NULL)
 *   GET    /film/projects/:id/style-book         this project's + the library
 *   POST   /film/projects/:id/style-book         create; body.scope = 'library' | 'project'
 *   GET    /film/style-book/:entryId
 *   PUT    /film/style-book/:entryId             merge, never replace
 *   DELETE /film/style-book/:entryId
 *   POST   /film/style-book/:entryId/media       attach a visual
 *   DELETE /film/style-book/media/:mediaId
 *   POST   /film/shots/:shotId/style-book/:entryId   apply to a shot's card
 */

/**
 * listStyleBook(res, projectId) → 200 { entries: [...], scopes: {...} }
 *
 * `WHERE project_id = ? OR project_id IS NULL`, ordered library-last so the
 * project's own variants read first. Each row reports scope: 'project' |
 * 'library' — the flows precedent, verbatim, so the two cannot mean different
 * things by the same word.
 */
function listStyleBook(res, projectId)
```

The dispatch shape mirrors `routes/mood-board.js`: one `handleX(req, res, urlParts, query)`
export, `urlParts[1]` switch, registered once in `server.js`.

### MCP — six tools in `PRODUCTION_TOOLS`

`stylebook_list`, `stylebook_get`, `stylebook_create`, `stylebook_update`,
`stylebook_delete`, `stylebook_apply`.

`ENTITY_ROUTES` gains `{ kind: 'style book', file: 'style-book.js', verbs: { POST:
'stylebook_create', PUT: 'stylebook_update', DELETE: 'stylebook_delete' } }`, which makes the
tool coverage derived rather than remembered. `stylebook_apply` is the one that matters — the
agent composing a shot is exactly who should be able to say *"use my tatami low-angle"*.

None of the six calls an LLM, so `mcp-no-server-llm.test.js` passes by construction.

---

## 5. What apply does with each of the 11 camera facets

| Facet | Disposition |
|---|---|
| `shot_type` | carried, validated against `VALID_SHOT_TYPES` |
| `framing` | carried, the shot size (EWS–ECU), validated against `lib/framing` — added 2026-10-01 |
| `movement` | carried, validated against `VALID_CAMERA_MOVES` |
| `lens` | carried, free string — "40mm anamorphic", "24-70 at 35" |
| `sensor` | carried, validated against `VALID_SENSORS` |
| `aperture` | carried, positive number |
| `height_m` | carried — the facet that makes a low-angle wide sayable at all |
| `focus_distance_m` | carried, positive number |
| `note` | carried, capped at 400 as the card caps it |
| `position` | **not carried** — see below |
| `rotation` | **not carried** — see below |

`position` and `rotation` are a 6-DOF pose in one previs stage's coordinate space. They mean
nothing in another scene: the same numbers put the camera in a different place relative to a
different set. They are listed in `POSE_FACETS` and skipped explicitly, and `applyEntryToShot`
reports them in `skipped` if an entry somehow carries them — an omission that is stated is a
decision; one that is silent is a gap.

**Precedence is unchanged.** Apply writes onto the card, so `effectiveCamera()` keeps its
three levels — staged → written → the production's specs. The style book is a way of *filling
in* the card, not a fourth level. Anything else creates a display that eventually disagrees
with the generator.

**The entry never writes** `aspect_ratio`, `resolution`, `frame_rate` or `color_space`. Those
are the mood board's delivery decisions about a whole film; a per-shot template touching them
is two systems fighting over the frame size.

---

## 6. The page

`var RAIL` gains a 7th entry, id `stylebook`, label **Style**, inserted between `settings` and
the glossary entry — *"on the right before terms"*. `nav-chrome.test.js` already asserts every
rail button resolves, so a button wired to nothing fails there rather than looking fine until
clicked.

`page-stylebook` renders a filterable grid: name, first visual as thumbnail, the camera facets
as tags, scope badge. The tag set is what ShotDeck taught — a director searches by the facets
they already think in, which are the ones the card carries.

**On the shot side**, an *Apply from style book* control in the Direct panel and in previs,
both calling `POST /film/shots/:id/style-book/:entryId`. One runner, because two separately
written appliers is how the board and the viewer came to disagree about their own markup
tools.

**`manual-edit.test.js` will demand controls** for `name`, `description` and `tags` — the text
fields `PUT /style-book/:id` accepts. `camera_json` is an object assembled from pickers, so it
is excluded by the machine-shape rule already in that test (`/^camera_json$/` joins the
existing shapes list, with the reason).

---

## 7. Visuals — and the honest limit

Attachments are stored and rendered for the director. They are **not** promised to reach a
generator, because `KIND_RANK` is `anchor 0, character 1, location 2, prop 3, style 4` against
a budget of three on Runway and five on Meshy: a style reference already ranks last and is
dropped before the request is built on any shot with a cast and a location.

The UI must say so rather than implying otherwise — the alternative is a director attaching
five stills and believing the frame is conditioned on them. `media_kind: 'video'` reaches no
generator at all and is labelled as reference-only.

---

## 8. Rationale for the three decisions most likely to be questioned

**Why a new table rather than extending the mood board.** The board's output is a single
composed `style_preset` string appended to every image prompt. Style-book entries are
discrete and individually applied; folding them into a concatenator would apply every shot
idea to every frame — the failure that put a creature in an establishing shot.

**Why pure `lib/` for a CRUD feature.** The merge is the only interesting logic and it has
three callers (page, MCP, previs). Testing it without a database is what makes the
facet-by-facet set-based test cheap enough to actually write.

**Why `stylebook_apply` is phase 2, not phase 1.** Phase 1 is storable and readable and
already useful to an agent; apply is where it changes a picture, and it should land with the
merge test rather than beside CRUD.

---

## 9. Phases

1. **Migration, `lib/style-book.js`, `routes/style-book.js`, dispatch, six MCP tools,
   `ENTITY_ROUTES`, CLAUDE.md.** Storable, listable, agent-readable.
2. **`applyEntryToShot` + the two shot-side controls.** Where it starts paying.
3. **The rail page and the grid**, plus `ALWAYS_AVAILABLE` and `project-delete`.
4. **Visuals** — attach, list, delete; labelled human-facing.

Phases 1–2 are backend-only and fully testable headless; 3 is the only one needing the
browser.
