# The Style Book — research and recommendation

**Ask:** a personal, cross-project library of shots the director likes — a name, a
description, lens and camera details, and multiple visuals (stills *or* clips) — reachable
from a rail button before Terms, and usable from any section: the mood board, the
storyboard, the final footage.

This is a research document. Nothing here is built. It exists to establish what the
feature touches, what the codebase already does about each of those things, and which of
three storage shapes is right — before any of it is written.

---

## 1. The complete set, derived from code

Not from the request. The request names three consumption surfaces loosely ("any section,
moodboard or even when generating a shot"); the code says there are more, and a design
covering the three named ones is a half-done feature.

| Set | Count | Source of truth |
|---|---|---|
| Camera facets a shot carries | **10** | `card.camera.*` in `lib/scene-card-schema.js` |
| Mood-board spec kinds | **8** | `SPEC_KINDS` in `lib/look-development.js` |
| Media kinds a visual can be | **8** | `MEDIA_KINDS` in `lib/media-kinds.js` |
| Reference slot ranks | **5** | `KIND_RANK` in `lib/reference-images.js` |
| Rail entries | **6** | `var RAIL` in `src/index.html` |
| Prompt builders that consume camera | **2** | `buildStoryboardPrompt`, `buildVideoPrompt` |

The ten camera facets are `shot_type`, `movement`, `note`, `lens`, `sensor`, `aperture`,
`focus_distance_m`, `height_m`, `position`, `rotation`. A style-book entry that can name a
lens but not an aperture, a height or a sensor is a note, not something a shot can be
generated from — and `height_m` in particular is the facet that makes "a low-angle wide"
sayable at all, which the vocabulary otherwise cannot express (see *A Low-Angle Wide Was
Unsayable* in CLAUDE.md).

The eight board specs are `lens`, `sensor`, `aperture`, `aspect_ratio`, `resolution`,
`frame_rate`, `color_space`, `style_preset`. Three of them (`lens`/`sensor`/`aperture`)
are the same facets a style-book entry would carry — so the two systems overlap by
construction and the design has to say which wins.

---

## 2. Prior art

### Outside

**[ShotDeck](https://shotdeck.com/)** (Lawrence Sher, ASC) is the closest published
analogue: a searchable library of film stills, every image hand-tagged across 30+
categories — lens, framing, lighting style, colour palette, camera angle, movement, time
of day, even the emotion on the actor's face. Its lesson is not the size of the library
but the **shape of the tag set**: DPs search it the way they think — *"overcast exterior,
backlit, 85mm equivalent"* — which is a conjunction of the same facets a scene card
already carries. It is a lookup tool; it does not produce anything.
([CineD writeup](https://www.cined.com/shotdeck-collaborative-searchable-online-library-movie-images-lawrence-sher-asc/),
[Soundstripe on using it to recreate looks](https://www.soundstripe.com/blogs/recreating-film-looks-shotdeck))

**[StudioBinder](https://www.studiobinder.com/blog/film-lookbook-examples/)** treats the
lookbook as *"a resource you come back to when you are stuck… especially when creating a
shotlist or storyboard"* — the same moment this feature targets. Its shot lists are
**per-project documents that can be archived, duplicated and renamed**, which is a
workaround for the absence of a cross-project library: reuse happens by copying a
document, not by referencing a shared entry.
([shot list templates](https://www.studiobinder.com/templates/shot-list/))

**The gap both leave open**, and the reason this is worth building here rather than
subscribing to one of them: neither library is connected to a generator. ShotDeck ends at
inspiration; StudioBinder ends at a call sheet. This engine can take
*"my push-in on a 40mm at 0.9m"* and actually render it, which makes the entry a
**template**, not a bookmark.

### Inside

Four subsystems already collect references, and every one is **`project_id NOT NULL`**:

| Table | What it holds | Why it is not this |
|---|---|---|
| `film_mood_board` | kind, note, asset_id/image_path, spec_kind/spec_value | The look of **one film**. Composes into `style_preset`. |
| `film_continuity_refs` | ref_type, title, description, image, tags | *"Did this match what we already shot"* — a question about the past. |
| `film_story_bible` | section, body, fingerprint | Prose. **No prose reaches an image model**; it is a source, not an input. |
| `film_marketing_assets` | type, title, prompt, image_path | Output, not reference. |

Exactly one thing in the codebase already solves *"save it once, reuse it across every
project"*: **`film_flows`**, where `project_id IS NULL` means a **library** flow, listed
alongside a project's own (`WHERE project_id = ? OR project_id IS NULL`) and reported with
`scope: 'project' | 'library'`. That is the precedent, and it is a good one — it needs no
second table, no sync, and no "copy into this project" step.

The only genuinely account-global tables today are `film_app_settings`,
`film_provider_credentials` and `film_provider_rates` — all key/value or credential stores,
none suited to rich content.

---

## 3. Storage: three shapes, and the trade-off

### Option A — extend `film_mood_board` with a `library` scope

*Cheapest.* The board already has `kind`, `note`, an image, and a spec channel.

**Against, and it is decisive:** the board's output is `style_preset`, a single composed
string appended to every image prompt in a production. A style book is a set of
**discrete, individually-applicable** entries; folding them into a composer that
concatenates everything would apply every shot idea to every frame at once. That is
precisely the failure documented in *Look Development* — a style preset naming a subject
put a creature in every frame. Rejected.

### Option B — a new project-scoped table, copied between projects

Matches the four existing collections, so it is the least surprising.

**Against:** the ask is explicitly *"my directing style"* — it accumulates across films.
Copying is what StudioBinder does and it is a workaround: the copy diverges, and a refined
entry improves only the project it was refined in. Rejected.

### Option C — a new table on the flows precedent: `project_id` nullable, NULL = library ✅

**Recommended.** One table, `film_style_book`, `project_id NULL` for the director's
standing library and a project id for a film-specific variant. A project lists both, the
way flows do. No copy step, no divergence, and a `scope` field the UI can filter on.

It also leaves the door open for the one case B is right about: *"this angle is a Wingfall
thing, not a me thing"* — which becomes a project-scoped row rather than a second concept.

**Cost, stated:** cross-project rows survive project deletion, so `project_id` must be
`ON DELETE SET NULL`, not `CASCADE` — otherwise deleting a film silently deletes library
entries that merely happened to be authored in it. That is the same trap
`film_refsheet_jobs` fell into (migration 067).

---

## 4. Schema

```sql
CREATE TABLE film_style_book (
    id            TEXT PRIMARY KEY,
    -- NULL = the director's standing library, visible from every project.
    -- ON DELETE SET NULL, never CASCADE: deleting a film must not delete an
    -- entry that outlives it.
    project_id    TEXT REFERENCES film_projects(id) ON DELETE SET NULL,

    name          TEXT NOT NULL,          -- "Ozu tatami low-angle"
    description   TEXT NOT NULL DEFAULT '',
    camera_json   TEXT NOT NULL DEFAULT '{}',   -- the 10 card.camera.* facets, all optional
    tags          TEXT NOT NULL DEFAULT '',     -- free text, the ShotDeck lesson
    sort_order    INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Multiple visuals per entry: a separate table, because "multiple" is the ask
-- and film_mood_board's one-image-per-row shape is what forces a board entry
-- to be duplicated to hold two pictures.
CREATE TABLE film_style_book_media (
    id            TEXT PRIMARY KEY,
    entry_id      TEXT NOT NULL REFERENCES film_style_book(id) ON DELETE CASCADE,
    media_kind    TEXT NOT NULL DEFAULT 'image',   -- from MEDIA_KINDS: image | video
    asset_id      TEXT REFERENCES film_assets(id) ON DELETE SET NULL,
    file_path     TEXT NOT NULL DEFAULT '',
    note          TEXT NOT NULL DEFAULT '',
    sort_order    INTEGER NOT NULL DEFAULT 0
);
```

`camera_json` rather than ten columns: the facets are already a validated object on the
scene card, and storing them in the same shape means applying an entry to a shot is a
merge rather than a translation. Every facet stays optional — *"85mm, that's all I know"*
is a legitimate entry, and requiring a sensor would stop it being written down.

**The 10 facets, and what an entry does with each:**

| Facet | In a style-book entry |
|---|---|
| `shot_type`, `movement` | validated against `VALID_SHOT_TYPES` / `VALID_CAMERA_MOVES` — the picker cannot offer what the card refuses |
| `lens` | free string, as on the card ("40mm anamorphic", "24-70 at 35") |
| `sensor`, `aperture` | validated; these are also board specs — see §5 |
| `height_m` | the facet that makes "low-angle wide" sayable; carried, because it is half of what a signature angle *is* |
| `focus_distance_m` | carried, optional |
| `note` | the director's own sentence, capped at 400 as on the card |
| `position`, `rotation` | **not** carried. They are a 6-DOF pose in one stage's coordinate space and mean nothing in another scene. Named here so the omission is a decision, not a gap. |

---

## 5. Reconciling with the mood board — the precedence question

Three facets exist in both: `lens`, `sensor`, `aperture`. The board also owns
`aspect_ratio`, `resolution`, `frame_rate` and `color_space`, which are **delivery**
decisions about a whole film and have no business in a per-shot template — a style-book
entry must not touch them, or two systems fight over the project's frame size.

The engine already has one precedence rule for camera, and it should be extended rather
than duplicated:

```
staged (previs)  →  written (scene card)  →  the production's specs (mood board)
```

A style book sits **between the card and the board**: it is more specific than *"what this
film shoots on"* and less specific than *"what this shot is"*. Applying an entry writes
onto the card, so the rule does not change at all — the entry is a **way of filling in the
card**, not a fifth precedence level. That is the single most important design constraint
here: anything that adds a level to `effectiveCamera()` is a display that will eventually
disagree with the generator (see *Previs Is Where You Experiment* in CLAUDE.md).

`style_preset` stays the board's, untouched. A style book is about **framing**, not grade.

---

## 6. How an entry reaches a generation

Three channels, in descending order of how well they work. The middle one is the finding
that matters.

**(a) Words — the camera facets. This is the real channel.**
`buildStoryboardPrompt` reads `shot_type`, `movement`, `lens`, `sensor`, `aperture`,
`height_m` and `note`; `buildVideoPrompt` reads `movement` and lighting. Applying an entry
to a shot's card puts all of it in front of both builders with **no new plumbing at all** —
the card is already the input. This is why `camera_json` mirrors the card's shape.

**(b) Pictures — and they will usually not be sent.**
`KIND_RANK` is `anchor: 0, character: 1, location: 2, prop: 3, style: 4`, and the
reference budget is **three on Runway, five on Meshy**, shared. A style reference already
ranks *last*; a style-book still would rank there too. On a real shot naming two
characters, a location and a prop, it is dropped before the request is built — which is
exactly how the SEDAN and grocery-bag plates were silently discarded (*How Many Plates Fit
Is the Provider's Answer*).

So: **the visuals are primarily for the director to look at.** They reach a model only on
a sparse shot, or when explicitly promoted for one generation. Designing as though a
reference still will condition the frame would be designing on a false premise, and the
UI must not imply it does.

**(c) Video visuals reach no generator at all.**
`MEDIA_KINDS` registers `video`, and every image path takes stills. A reference *clip* is
storable, playable and human-facing — genuinely useful for movement, which a still cannot
show — and it conditions nothing. Worth building, worth labelling honestly.

**Where the button appears, then, is on the shot** — "Apply a style-book entry" in the
Direct panel and in previs, merging `camera_json` into the card. Everything else follows
from the card.

---

## 7. Where it lives

`var RAIL` has six entries in order: `dashboard`, `jobsqueue`, `notes`, `guide`,
`settings`, then the glossary/terms entry. The ask is *"a button on the right before
terms"* — so a seventh entry inserted between `settings` and the glossary, id `stylebook`,
label **Style**.

`tests/nav-chrome.test.js` already asserts every rail button resolves to a page or an
explicit handler, so a button wired to nothing fails there rather than looking fine until
clicked. That test is the reason this is a two-line change rather than a risk.

The page itself is a filterable grid: name, thumbnail, the facets as tags. The ShotDeck
lesson applies directly — the tags a director searches by are the facets they already
think in, and those are the ten the card carries.

---

## 8. Agent reachability

The standing constraint is *use MCP wherever we can for AI queries*, and the sharper
version from `tests/mcp-no-server-llm.test.js` is that **the connected model IS the LLM
here**. A style book an agent cannot read is one that cannot reach a generation the agent
is composing — and composing shots is exactly what the agent does.

Minimum surface, on the pattern every other entity follows (**169 tools** today):
`stylebook_list`, `stylebook_get`, `stylebook_create`, `stylebook_update`,
`stylebook_delete`, `stylebook_apply` (entry → shot card merge).

`tests/mcp-no-server-llm.test.js` derives its expectations from the **routes**, so adding
the routes without the tools fails there. That is the guard that stops this shipping
UI-only — which is how `POST /film/projects` went months without a `project_create`.

---

## 9. What should NOT be built

- **A second `style_preset` composer.** The board owns the look. This owns framing.
- **A fifth precedence level.** An entry writes onto the card; it is not consulted at
  generation time. Anything else creates a display that disagrees with the generator.
- **Auto-application.** An entry that silently applies to new shots is the mood-board
  subject bug in a new costume: every frame gets something nobody asked for.
- **Tag validation.** Free text, per ShotDeck. A controlled vocabulary here would be
  wrong within a week and is the thing a director will most want to bend.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Reference stills rank last and are usually dropped | State it in the UI; treat visuals as human-facing by default |
| Entries drift from the card vocabulary as it grows | Validate `camera_json` through `validateSceneCard`, never a private copy |
| Library rows orphaned by project deletion | `ON DELETE SET NULL`; `tests/project-delete.test.js` is set-based and will cover it |
| Two systems claiming the film's optics | Entry never writes `aspect_ratio`/`resolution`/`frame_rate`/`color_space` |

## 11. Phasing

1. Table + CRUD + rail page + MCP tools. Storable, searchable, agent-readable.
2. `stylebook_apply` — merge into a shot card. This is where it starts paying.
3. Multiple visuals, including video, labelled as human-facing.
4. *Optional, measure first:* promote one still into the reference set for a single
   generation, accepting it displaces a plate.
