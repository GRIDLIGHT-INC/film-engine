### The FDX defects were three different bugs — **TWO FIXED, ONE KNOWN**

Fixing them as one — *"send the rest as Action"* — is what produced the worst of
them in the first place.

- **Dropped → fixed.** `section` and `synopsis` now map to Final Draft's own
  `Section Heading` and `Summary`. An outline written here survives the trip.
- **Wrongly promoted → fixed.** `note` mapped to `Action`, putting a private
  production note into the **screenplay body** — the only one of the three that
  changed what the script *says*, and worse than dropping it. Notes now travel as
  a `ScriptNote`, kept in a separate `FDX_NOTE_TYPES` set so that adding an entry
  to the type map can never silently turn a note back into dialogue.
- **Lossy → known, not fixed.** `centered` and `lyrics` still map to `Action`.
  FDX has no lyric type and centring is a paragraph *alignment* rather than a
  type, so the words survive and the form does not. Recorded rather than
  invented, because a mapping Final Draft will not read back is worse than a
  documented loss. Phase 3.

`boneyard` stays absent deliberately: it is text that was cut, and exporting it
would resurrect the cuts.

# Screenplay: making Film Engine the only tool you need to write in

**Status:** draft 2 · confer 766495b7 · driver = film-engine agent · writers-tool cells owned by the writers-tool agent
**Conformance test:** `backend/tests/screenplay-port.test.js` — set-based over the element registry; fails if this plan claims a capability the code cannot demonstrate.

---

## The premise is wrong, and both sides proved it

The ask is *"port all the screenplay functions from writers-tool"*. Taken literally that is the wrong instruction, and we have evidence from both codebases:

- **writers-tool side:** Film Engine is already **ahead** on dual dialogue, centered text, lyrics, notes, revision colours, changed-page tracking and scene reconciliation. Porting "everything" would re-implement, worse, things that already exist.
- **film-engine side:** Film Engine has a **complete Fountain implementation with an incomplete surface**. Sections and synopses are parsed with depth, stored per element and styled for print — and have never once been authored, because the editor does not offer them, no MCP tool exposes them, and FDX export silently drops them.

Every element ever stored across the real projects:

```
action:25  scene_heading:17  dialogue:14  character:14  transition:5  parenthetical:1
```

Not one section. Not one synopsis. The capability has been sitting in the parser and the stylesheet the whole time with no way to put anything into it.

So this is **not a port**. It is a two-way gap closure whose goal is: *write a screenplay end to end in Film Engine, and drive it from Claude Desktop over MCP.*

## Agreed approach (converged, milestone 1)

1. **Goal:** Film Engine becomes the only screenplay tool. Two-way gap closure, not a port.
2. **The Fountain document is the single source of truth.** `film_scripts.fountain_content` is the screenplay; `film_scenes` is a projection reconciled from it. **Any row proposing a new table must argue why the format cannot hold it.**
3. **Conversion is the connected model's job.** No MCP tool may call a server-side LLM — the agent host *is* the model, and a tool that hands reasoning back asks the user for a second API key for a question the model has already read. `screenplay-ai.js` and `text-convert.js` stay HTTP-only and stay off the MCP surface. We ship **write primitives**, not a `convert` tool. *(This is also the goal's stated rabbit hole: use MCP for AI queries.)*
4. **Organising claim:** complete implementation, incomplete surface. Every row below says which it is.
5. **One artifact:** this file.
6. **Phases cut by dependency.** Phase 1 is whatever unblocks *From the Mist* chapter-by-chapter.
7. **Known non-parity bug:** FDX export loses structure. Data loss, not a gap.

### Gap vocabulary

| value | meaning | work |
|---|---|---|
| `none` | works today, verified | none |
| `film-engine-ahead` | Film Engine already does this, better | none — recorded so nobody re-implements it |
| `surface-UI` | capability exists in the engine; the editor cannot reach it | editor only |
| `surface-MCP` | capability exists; no tool exposes it | tool only |
| **stranded** | the editor knows the type, renders it, and offers no way in | editor only |
| `missing-primitive` | genuinely absent; nothing in the format or schema solves it | build |
| `bug` | present and wrong | fix |

---

## Set 1 — the 13 Fountain element types, across 5 surfaces

Derived from `lib/fountain-parser.js` (the registry), not from this description.

### "Authorable" had to be defined before anything could be counted

Draft 1 asserted **editor 9/13** as a fact. It is not a fact — it is one of four
different measures that exist in the code and disagree:

| measure | count |
|---|---|
| element-type strings present in `src/index.html` | 9 |
| explicit `detectedType = '…'` in the two classifiers | 5 |
| types the format-rule state machine knows (`AUTO_FORMAT_RULES.nextType`, `index.html:15225`) | 10 |
| types actually reachable by a writer | **7** |

The conformance test certified the first one, which is string presence — not
authoring capability. That is the "wired vs merely exists" error the test was
written to prevent, committed by the test itself.

So the plan now **defines** the term. A writer can produce an element three ways,
and they are separate registries:

- **typed** — a classifier writes the type from the line's own text, then Enter
  walks the `nextType` chain. This is graph reachability from the classifier's
  seeds, *not* set membership: `'lyrics': 'lyrics'` is a self-loop that keeps you
  in lyrics once you are there and is not a way in.
- **cycled** — Tab walks `AUTO_FORMAT_RULES.tabCycles`.
- **commanded** — an explicit command, e.g. `toggleDualDialogue()` (`index.html:17207`).

Authorable = the union. Everything else is a gap with a *name*.

| # | element | parser | renderer | authorable | FDX export | gap | phase |
|---|---|---|---|---|---|---|---|
| 1 | `scene_heading` | ✓ | ✓ | typed, cycled | ✓ Scene Heading | `none` | — |
| 2 | `action` | ✓ | ✓ | typed, cycled | ✓ Action | `none` | — |
| 3 | `character` | ✓ | ✓ | typed, cycled | ✓ Character | `none` | — |
| 4 | `dialogue` | ✓ | ✓ | typed, cycled | ✓ Dialogue | `none` | — |
| 5 | `parenthetical` | ✓ | ✓ | typed, cycled | ✓ Parenthetical | `none` | — |
| 6 | `transition` | ✓ | ✓ | typed | ✓ Transition | `none` | — |
| 7 | `centered` | ✓ | ✓ | typed (`> x <`) | ✓ `Alignment="Center"` | `none` ✓ | — |
| 8 | `lyrics` | ✓ | ✓ | typed (`~`) | ✓ `Style="Italic"` | `none` ✓ | — |
| 9 | `note` | ✓ | ✓ | typed (`[[x]]`) | ✓ ScriptNote | `none` ✓ | — |
| 10 | `section` | ✓ depth | ✓ | typed (`#`) | ✓ Section Heading | `none` ✓ | — |
| 11 | `synopsis` | ✓ | ✓ | typed (`=`) | ✓ Summary | `none` ✓ | — |
| 12 | `boneyard` | ✓ | ✓ | ✗ unknown | ✗ dropped | `surface-UI` | 3 |
| 13 | `page_break` | ✓ | ✓ | ✗ unknown | ✓ Page Break | `none` ✓ | — |

**Scene numbers (`#3#`) are not an element type and need a row anyway.** The
parser already reads them (8 references in `lib/fountain-parser.js`), production
locks pages by them, and per the blocker above they may be the stable identity
that makes `scene_insert_after` safe. Verdict today: `none` — parsed and stored.
Recorded because the next reader will ask, and because phase 1's blocker turns on
them. *(writers-tool agent.)*

**Coverage: parser 13/13 · renderer 13/13 · authorable 11/13 · FDX 11/13.**

*Phase 2 moved authorable 6→11 and FDX 9→10; phase 3 took FDX to 11/13. The two
that remain unauthorable are `page_break` and `boneyard`. The two not in the type
map are `boneyard` (deliberately — it is cut text) and `note`, which travels as a
Final Draft ScriptNote rather than as script text and so is absent by design.*

Dual dialogue is deliberately **not a row**: it is a modifier on an element, not
an element type, and it is not in `ELEMENT_TYPES`. It is authorable by command.
Three statements about dual dialogue were made during this confer and no two
agreed — which is the argument for defining the vocabulary before counting.

### `stranded` was a distinct bug class — **CLEARED**

`centered`, `lyrics` and `note` were types the editor **knew**: the format rules
named them, `nextType` said what followed them, the stylesheet rendered them, and
there was no way to enter one. They appeared only in Fountain that arrived from
an import or over MCP.

Every one has a **forced marker in Fountain already** — `> x <`, `~`, `[[x]]` —
so the way in was the syntax the format defines rather than a toolbar, exactly as
`.` already forces a scene heading. A second convention would have been a second
thing to learn for a format that has one. `section` (`#`) and `synopsis` (`=`)
were added the same way, which is why two different classes of gap closed with
one change.

One ordering detail is load-bearing: **`centered` must be tested before
`forcedTransition`.** Both open with `>` and only the closing `<` separates them,
so testing the transition first swallows every centered line. Both classifiers
carry the same order, because two classifiers that disagree about what a line is
are worse than one that is wrong.

### The FDX defects are three different bugs

- **Dropped** (`section`, `synopsis`, `page_break`): structure a script here,
  export to Final Draft, and the act structure vanishes. Silent.
- **Wrongly promoted** (`note`): `FDX_TYPE_MAP.note = 'Action'`. A Fountain note
  is a *production* note, not script text — exporting it as Action puts a private
  note into the screenplay body. **Worse than dropping it**, and the only one of
  the three that changes what the script says. writers-tool has no `note` element
  at all, so this is not a shared bug and fixing it cannot break parity.
- **Lossy** (`centered`, `lyrics`): flattened to Action. Words survive, form does not.

`boneyard`'s FDX drop is correct, but draft 1's verdict of `none` was not.
Boneyard (`/* … */`) is not deleted text — it is text **kept in the document and
omitted from output**, the standard way to cut a scene without losing it. Being
unable to author one means **there is no way to cut a scene and keep it**, which
is an inconsistent verdict in a plan that elsewhere treats losing writing as data
loss. *(writers-tool agent.)*

## Set 2 — the MCP screenplay surface

What an agent can do to a screenplay today (7 tools, verified from `lib/mcp-tools.js`):

| tool | does | enough for the novel workflow? |
|---|---|---|
| `script_get` | read the whole Fountain source | yes |
| `script_versions` | list saved versions | yes |
| `script_write` | save a NEW version from whole Fountain | **no — rewrites everything** |
| `scene_list` | list projected scenes | yes |
| `scene_get` | read one scene | yes |
| `scene_update` | replace ONE scene by index (`spliceScene`) | yes, for revision |
| `scene_delete` | delete a scene + cascade | yes |

**The blocking gap.** There is no append and no insert. `spliceScene(fountain, index, text)` only *replaces*. So *From the Mist* chapter-by-chapter means re-sending the entire growing screenplay on every chapter — quadratic in tokens, and every resend risks reflowing scenes that did not change, which marks their shots stale and makes a director redo work nobody asked for.

| # | operation | status | gap | phase |
|---|---|---|---|---|
| 0 | `script_write` — save a whole new version | present | rewrites everything; the quadratic path | — |
| 1 | `scene_append` — append a Fountain **fragment** (may hold several headings), one transaction, reconciled once | **BUILT** | — | **1 ✓** |
| 2 | `scene_insert_after` — add after scene N | **BUILT** | — | **1 ✓** (was blocked; unblocked at the reconciler) |
| 3 | `outline_get` — sections + synopses in document order | **BUILT** | — | **2 ✓** |
| 4 | `outline_write` — author sections/synopses | **BUILT** | — | **2 ✓** |
| 5 | `script_stats` — words, pages, scenes, dialogue %, cast, runtime | **BUILT** | — | **3 ✓** |
| 6 | `scene_card_write` — POV, conflict, outcome | **BUILT** | — | **2b ✓** |
| 7 | `scene_history` / `scene_restore` — per-scene, derived from script versions | **BUILT** | — | **2b ✓** |
| 8 | `beats_get` / `beats_apply` / `beat_link` — structure, and its holes | **BUILT** | — | **2b ✓** |
| 9 | `directives_get` / `directives_write` — house rules on the writing | **BUILT** | — | **2b ✓** |


### `scene_insert_after` corrupted the tail. Fixed at the reconciler — **SHIPPED**

*Found by the writers-tool agent; verified, then unblocked.*

`syncScenesWithScreenplay` matched **by `scene_number`, greedily**, and UPDATEd
the row it matched unconditionally — `moved()` only fed the report counters.
Insert a scene after scene 2 of a ten-scene script and the new Fountain numbers
1, 2, **NEW=3**, old-3→4, old-4→5 … so new #3 matched old #3 and took the NEW
text, new #4 matched old #4 and took old-3's text, and so on to the end. Pass 2
could rescue none of it; pass 1 had already consumed those rows by number.

**The fix is identity, not ordering.** A scene's identity is its CONTENT, not its
position, so reconciliation now matches on `sceneFingerprint` **before** it
matches on number. That is deliberately the same function that answers *"has this
scene changed"* — the two are one question asked from opposite directions, and
sharing the function is what stops the answers disagreeing. A scene whose text is
byte-identical **is** that scene, whatever number it now carries.

Three properties make it safe rather than merely different:

- **An edited scene still drifts.** It has no content match, falls through to the
  number pass, and is updated and restamped exactly as before. Matching by
  content must not make a rewrite invisible, and there is a test that fails if it
  does.
- **Position is written; content is not.** `film_scenes` is a projection, so the
  order must follow the document — but `sceneFingerprint` covers int_ext,
  location, time_of_day and description and *never* the number, so renumbering
  restamps nothing. Writing nothing at all here was the author's first attempt
  and it left the inserted scene and the scene it displaced both claiming the
  same number.
- **Pass 1 skips what pass 0 claimed.** Without that a content-matched scene
  would also match some other row by number and overwrite it — the same bug in a
  subtler costume.

**Naming.** The parameter was `after_scene_index`, which implies 0-based, and
that was enough to make the author write his own test off by one. It is
`after_scene`, counted the way `scene_list` reports scenes: 1 is the first,
0 inserts before it, and the scene count appends (and delegates to `appendScenes`
rather than reimplementing it).

### Chapter 1 already works. It is chapters 2..n that are quadratic

writers-tool's `send_to_film_engine` creates a project, posts Fountain via
`script_write`, writes bible sections and creates characters/locations/props with
`bible_section` provenance — live and tested end to end today. So *From the Mist*
chapter 1 lands right now. `scene_append` is the **incremental** case, not the
first one. *(Established by the writers-tool agent.)*

## The screenplay must reach a movie, not just a page

The goal this work belongs to is: *write a screenplay, then take it through every
stage of the pipeline until a final movie, all managed from Film Engine.* Draft 1
stopped at writing and never said how a screenplay becomes **shots** — the first
pipeline stage after it. That is not academic: `breakdown_run` is **absent** from
the MCP surface, removed deliberately under commitment (3), so the obvious route
does not exist.

The route that does exist, and that draft 1 failed to mention:

| operation | status | role |
|---|---|---|
| `shot_tag` | present | turns selected screenplay lines into shots, capturing who is present from the same selection |
| `shot_create` | present | the model composes a scene card directly |
| `entities_create` | present | characters/locations/props from the screenplay |
| `storyboard_generate` | present | frames from the cards |

As written, draft 1's phase 1 could have been declared done with a screenplay
that cannot become a movie — passing our plan and failing the goal.

## The rabbit hole: AI queries that do not go through MCP — **CLOSED, option (c)**

The goal names this trap explicitly, and it was half-honoured.
`tests/mcp-no-server-llm.test.js` forbids any MCP tool from calling a
server-side LLM — the agent host *is* the model, and handing the reasoning back
asks for a second API key for a question the connected model has already read.
That protected the MCP surface and said nothing about the UI, which is the
surface actually typed into.

Three route modules call `callProjectLLM` and the SPA uses all three:

| route | line | replaced over MCP by |
|---|---|---|
| `screenplay-ai.js` | `:9` | `script_get` + `scene_update` / `scene_edit` / `scene_append` |
| `text-convert.js` | `:11` | `scene_append` (or `script_write` for a whole draft) |
| `breakdown.js` | `:14` | `script_get` + `card_vocabulary` + `shot_create` / `shot_tag` |

**Option (c), chosen: MCP is the default path, HTTP is the fallback when no agent
host is attached.** Not (b) — removing them — because an editor that cannot write
a line without a second app attached is a worse tool even if it is a cheaper one.
Not (a) — leave it — because the whole point of the MCP surface is that the model
is already there.

### The presence signal is a tool call, not a handshake

`lib/agent-presence.js`. The evidence that a host is attached is **the MCP server
calling a tool**: a host that is connected calls tools, and one that is not
cannot fake it. No second protocol to keep in step.

It shares `film_app_settings` because the MCP server and the HTTP server are
separate processes over one SQLite file — the arrangement `GET /film/events`
already relies on, and the reason a heartbeat table would duplicate what the
database does. It **goes stale after 20 minutes**: a host that connected last
Tuesday is not attached now, and a signal that never expires routes every request
to a fallback that is not there. `markAgentSeen` never throws, because observing
must not break the thing observed.

### Every AI endpoint declares its own replacement

`MCP_ALTERNATIVE` is declared **in each route module**, not in a central list, so
a sixth AI feature cannot be added without answering the question — the
conformance test fails if a module that imports the LLM client declares nothing.
`GET /film/agent` assembles them.

`fallbackNotice()` is attached to every server-side-LLM response, **success and
failure**, and the failure case is where it matters most: a key with no credit
produces a 502 the reader cannot act on, and *"there is a free path and it is
already connected"* is the actionable half of that error. One helper rather than
three literals, or the three modules drift and only one ends up telling the truth.

### The page says which path it will take

The AI panel carries a badge, refreshed when it opens and before each send,
cached for a minute — presence changes on the scale of a session, not a
keystroke. Connected: *"Ask it to do the writing — it already has your screenplay
in context and costs nothing extra."* Not connected: *"This panel will use the
server-side model and spend this project's API key."*

Verified live in both states:

```
connected: false | preferred: http
  → 5 endpoints listed, each with its MCP alternative
connected: true  | client: claude-desktop | preferred: mcp
```

## Set 3 — writers-tool features

**Cells supplied by the writers-tool agent**, verified against writers-tool
source. Cells marked BELIEVED are their reading of *this* repo and are the
driver's to correct. Full rationale: `docs/plans/screenplay-port.SET3-from-writers-tool.md`.

| # | writers-tool feature | behaviour | reachable over MCP? | film-engine today | gap | phase |
|---|---|---|---|---|---|---|
| 1 | Six element types | slugline, action, character, parenthetical, dialogue, transition. No centered/lyrics/dual/note/section/synopsis. | via Fountain | 13 types parsed | `film-engine-ahead` | — |
| 2 | Live auto-classification | Re-types every block from its own text + what precedes it, on each keystroke (180ms debounce). Leading `.` forces slugline, `>` transition, `(…)` parenthetical, short ALL-CAPS with no terminal punctuation is a cue, anything after a cue is dialogue. | n/a (typing) | BELIEVED: editor has element types but I have not verified live re-typing | `surface-UI` if absent | 3 |
| 3 | Tab/Shift-Tab/Enter cycling | Final Draft's chains, not a menu. Enter: character→dialogue, dialogue→action, transition→slugline. Tab moves to the *alternative* element. Tab **pins** a block, but typing a real slugline or transition outranks the pin — else a block Tabbed once could never become a heading again. | n/a | BELIEVED absent | `surface-UI` | 3 |
| 4 | SmartType | 4 scene intros, 11 times of day, 8 transitions, plus character and location names drawn live from the project. | n/a | BELIEVED absent | `surface-UI` | 3 |
| 5 | Element indicator | Footer names the current block's type as the caret moves. | n/a | BELIEVED absent | `surface-UI` | 3 |
| 6 | Per-document **and** per-project mode | A document with no `docMode` follows the project. Switching the project **pins anything already written** to the mode it was written in — before today it swept written prose into screenplay mode, re-typed paragraphs as action and persisted it. | `set_project_mode`, `set_document_mode` | n/a — film-engine is screenplay-only | `none` | — |
| 7 | Fountain + FDX out | `htmlToFountain`/`fountainToHtml`; `buildFdx` maps the 6 types to FD Paragraph types. Prose documents export as Action rather than being dropped. | Fountain yes, FDX no | FDX in **and** out | `film-engine-ahead` | — |
| 8 | Three levels, mode-dependent vocabulary | Part/Chapter/Sub-chapter ↔ Act/Scene/Beat. Titles **display-swapped, never rewritten on disk**: "Chapter One: Low Tide" stored, "Scene One: Low Tide" shown, and only a leading word naming that document's actual level is swapped. | `list_documents` | `film_acts` + unexposed `#` sections | `surface-UI` + decision | 2 |
| 9 | Scene cards | `povId`→character, `locationId`→world element, `sceneTime`, `conflict`, `outcome`. Outliner and corkboard sort/filter on them. | `set_scene_card` | scenes have description + characters_present; BELIEVED no conflict/outcome | `missing-primitive` (partial) | 2 |
| 10 | Move / reorder | Re-parent or reposition with cycle protection. No text changes. | `move_document` | BELIEVED: scene order is Fountain order | `surface-MCP` | 2 |
| 11 | Split / merge / duplicate / convert-to-folder | Each snapshots first. | **no** | — | falls out of `scene_insert_after` | 3 |
| 12 | Scrivenings | Read **and edit** N documents as one flow, then harvest back to each. | read-only via `read_manuscript` scope | the script IS the flow | `film-engine-ahead` | — |
| 13 | Beat sheets, 4 frameworks | Save the Cat, Hero's Journey, Three Act, Story Circle. Beats carry guidance + `targetPercent`, link to a document; **what stays unlinked is where the structure has a hole**. `suggestBeatChapters()` matches by position, forward-only, so a late beat cannot claim an early scene. | `list_beats`, `upsert_beat` | nothing equivalent | `missing-primitive` | 2 |
| 14 | Story bible | Sections with kind (canon/voice/outline/character/notes), an `include` flag marking what an assistant treats as established, plus per-section notes, images, links. | `read_bible`, `upsert_bible_section`, `add_bible_note` | `film_story_bible` + `bible_drift` | `film-engine-ahead` (drift tracking) | — |
| 15 | Characters | name, aliases, title, role, classification, **physical**, background, relations, personality, appearsIn. `physical` maps to your `appearance_prompt`. | `list_characters`, `upsert_character` | characters + appearance_prompt + bible_section | `none` | — |
| 16 | World elements | Category (Location, Geography, Society/Culture, Laws/Customs, Political Divisions, Technology, Flora&Fauna, Terminology), description, notes. | `list_world`, `upsert_world_element` | locations + props | `none` | — |
| 17 | Groups and collections | Character/world groups; collections manual **and** saved-search. | `list_groups`, `upsert_group`, `upsert_collection` | BELIEVED absent | `surface-MCP` | 3 |
| 18 | Story points | Loose outline notes beside the manuscript, for an idea that is not a scene yet. | `list_story_points`, `add_story_point` | BELIEVED absent | `surface-MCP` | 3 |
| 19 | Per-document metadata | synopsis, notes, label, status, keywords, custom fields, word target, includeInCompile. | `set_document_meta`, `set_document_keywords`, `set_custom_field` | synopsis has a Fountain home (`=`), unexposed | `surface-UI`+`surface-MCP` | 2 |
| 20 | Project vocabularies | Statuses, labels, keywords, custom fields are user-defined per project, not fixed enums. | `list_vocabulary`, `create_vocabulary` | BELIEVED fixed | `missing-primitive` | 3 |
| 21 | Format directives | Standing house rules for how prose/screenplay/poetry should be **written**, read by the assistant before it starts. | `read_directives`, `set_directive` | `style_preset` governs the IMAGE; nothing governs the writing | `missing-primitive` | 2 |
| 22 | Per-document history | Every write versions **that document**; restore is itself undoable. Separately SQLite snapshots, **not in the session file, invisible to MCP**. | `document_history`, `restore_document` | script versions = whole document | `missing-primitive` | 2 |
| 23 | Compile | 4 presets, per-section-type layouts, `<$n>`/`<$type>`/`<$PROJECTTITLE>` placeholders, separators, title page. | **no** | own output path | do not port | — |
| 24 | Corkboard + outliner | Card and spreadsheet views, sorting on scene-card fields. | n/a | BELIEVED absent | do not port | — |
| 25 | Targets and writing history | Manuscript + daily word targets, per-day history, streak. | `set_book_metadata` | BELIEVED absent | `surface-MCP` | 3 |
| 26 | Annotations | Comments and footnotes per document. **SQLite only — not in the session file, invisible to MCP.** | **no** | `film_screenplay_comments` | `film-engine-ahead` | — |
| 27 | Import | DOCX/TXT/HTML with heading→level mapping; Scrivener import. | **no** | FDX import | do not port | — |

### Their answers to the three open questions

**Scene-text format — the driver's reading was WRONG.** I read "better than
either of your options" as *writers-tool already stores Fountain*. It does not:

| layer | format |
|---|---|
| storage (`item.content`) | **typed HTML blocks** — six classes only |
| MCP wire format, both directions | **Fountain**, via `htmlToFountain` / `fountainToHtml` |

The conclusion survives — writers-tool → Film Engine needs no conversion — but it
survives **because of an adapter written today**, not because of the storage
format. Stated here as *"Fountain over MCP, HTML blocks at rest"* so nobody later
builds on the wrong premise. Only *From the Mist*'s prose needs converting, which
is Claude Desktop's job under commitment (3).

**Act/Part carries STATE — yes.** A container has the same shape as a document:
`synopsis`, `notes`, `labelId`, `statusId`, `keywordIds`, `customValues`,
`wordTarget`, `sectionType`, `includeInCompile`. The one with teeth is
**`includeInCompile: false`, which excludes a whole branch from output.** So `#`
sections alone cannot hold it.

Agreed resolution: **Fountain sections are authoritative for name, order and
nesting; `film_acts` is retained only for fields the format cannot express, keyed
off the section rather than duplicating it.** Two rows both claiming which act a
scene is in is the trap commitment (1) exists to prevent.

**Synopsis is AUTHORED** — five assignment sites, never computed. `=` lines are a
true home, no sidecar needed. **Word count is DERIVED** — computed at render,
stored nowhere. Only `wordTarget` is authored. Nothing to port.

### The five that justify the exercise

Not thirty cosmetic rows — the five the writers-tool agent would defend:

1. **Beat sheets with hole detection** (#13) — the only thing in either app that
   answers *where is the structure missing*. Adapting a 40-chapter novel, that is
   exactly the question.
2. **Surgical `edit_document`** — named phrases changed in place, each matching
   exactly once, and **if any edit in a batch fails none are written**. Our
   `scene_update` replaces a scene wholesale, which loses everything around a
   one-line change.
3. **`where_does_it_appear`** — every document a character or place is named in,
   aliases included, with the surrounding line. Continuity insurance.
4. **Per-document history** (#22) — per-scene undo rather than whole-script
   versions. In a workflow where a model rewrites scenes, that is the difference
   between "try it" and "commit and hope".
5. **Format directives** (#21) — house rules on the *writing*, read before it
   starts. We have exactly this idea for the image (`style_preset`) and nothing
   for the prose.

### Recorded as `film-engine-ahead` — do not re-implement

| capability | why Film Engine is ahead |
|---|---|
| dual dialogue | a real modifier with a toggle command; writers-tool has no dual dialogue at all |
| centered / lyrics | parsed, rendered and round-tripped; writers-tool has neither element |
| notes | `[[…]]` parsed and rendered as production notes; writers-tool has no note element |
| revision colours | coloured revision marks per draft; no writers-tool equivalent |
| changed-page tracking | which pages moved between drafts, stored per version |
| scene reconciliation | a rewrite matches scenes by number then location, so ids and the shots hanging off them survive |
| FDX **import and export** | writers-tool exports FDX only |
| inline comments | `film_screenplay_comments`; writers-tool's annotations are SQLite-only and invisible to MCP |
| story-bible drift | `bible_drift` reports which entities were written from a section that changed |

## What the conformance test got wrong, twice

Both of us shipped an assertion that passed on a document it should have
rejected, and both failures were the same shape: **a substring match cannot tell
a claim from prose about that claim.**

- **Driver's.** `doc.includes('editor 9/13')` passed on the sentence *"Draft 1
  asserted **editor 9/13** as a fact. It is not a fact"* — the plan repudiating
  the number satisfied the check meant to verify it claimed it. Fixed by
  anchoring to the single `**Coverage:**` line.
- **writers-tool agent's.** A regex for `UNVERIFIED` over the whole Set 3
  *section* passed because the surrounding prose explained the convention using
  the word. Fixed by asserting over the table **rows**, never the prose.

That check also required the `UNVERIFIED` placeholder to survive, so completing
Set 3 honestly turned the suite red and the cheapest route back to green was to
delete the content. **A test that punishes finishing the work is worse than no
test.** Replaced with the invariant it was reaching for: every row is either
still marked unverified, or carries a line naming who supplied it.

Both fixes were proven by falsification — change the number, watch it fail,
change it back — rather than by re-reading the assertion:

```
AssertionError: the plan claims a different authorable coverage than the 6/13
                the editor reaches: **Coverage: … authorable 9/13 …**
AssertionError: the editor strands these and the plan does not say so: centered
```

## Phases

Cut by **dependency**, not by feature count.

### Phase 1 — a chapter can be imported at all — **SHIPPED, including insert**

`lib/scene-splice.js:appendScenes` + `insertScenesAfter` ·
`POST /film/projects/:id/script/{append,insert}` · MCP `scene_append` +
`scene_insert_after` · `tests/scene-append.test.js` (11 invariants) +
`tests/scene-insert.test.js` (11 invariants).

Verified live, three chapters arriving one at a time:

```
ch1  seeded          scenes=1  chars=128
ch2  sent  144 chars  +2 scenes  updated=0  unchanged=1  prefix-intact=true
ch3  sent  136 chars  +2 scenes  updated=0  unchanged=3  prefix-intact=true
final: 5 scenes, 410 chars · shot on scene 1 survived · scenes drifted: 0
sent by appending 408 chars, vs 808 by re-sending — and that gap is quadratic
```

`updated=0` is the whole result: the reconciler touched no existing scene, so
nothing was restamped and nothing reports as behind.


- `scene_append` — route + MCP tool, taking a Fountain **fragment**
- The chapter-by-chapter loop working end to end from Claude Desktop
- `scene_insert_after` — **unblocked**: reconciliation now matches content before position

**Done when:** a chapter can be added without re-sending the screenplay, and
adding chapter N leaves scenes 1..N−1 byte-identical. The second clause matters
as much as the first — a resend that reflows untouched scenes marks their shots
stale and makes a director redo work nobody asked for.

**Not phase 1's to prove:** the path from an appended scene to a shot is
`shot_tag` / `shot_create`. It exists today. *(The driver initially folded the
shots handoff into phase 1; the writers-tool agent argued that coupling an
**import primitive** to a **production stage** makes phase 1 unshippable behind
failure modes that have nothing to do with `scene_append` — and From the Mist
cannot be imported at all today, which is the thing actually blocking. Agreed.
The goal's acceptance criterion is real, so the handoff is **phase 2**, ahead of
the FDX work — not folded into phase 1 and not dropped.)*

### Phase 2 — the screenplay reaches the pipeline, and structure survives — **SHIPPED**

`tests/screenplay-structure.test.js` (10 invariants). Done when: *an outline
written in Film Engine survives a round trip to Final Draft, and no element the
editor knows is unreachable.* Both hold.

- **Shots handoff, proven.** An appended chapter reaches shots over MCP via
  `shot_tag` / `shot_create`, asserted end to end — including that
  `breakdown_run` is still absent, so a future edit cannot quietly reintroduce a
  server-side LLM on this path.
- **Five elements made authorable** — `section` (`#`), `synopsis` (`=`),
  `centered` (`> x <`), `lyrics` (`~`), `note` (`[[x]]`). Authorable 6/13 → 11/13.
- **FDX round trip.** `section` → Section Heading, `synopsis` → Summary, `note` →
  ScriptNote. Two of three defects fixed, the lossy one recorded for phase 3.
- **`outline_get` / `outline_write`** on MCP, plus `GET|POST /projects/:id/outline`.
- **Editor styling** for sections and synopses, so structure reads as scaffolding
  rather than as script.

**Deferred out of phase 2, with reasons:**

- **`film_acts` reduction** — depends on open question 2 (does `includeInCompile`
  have a Film Engine meaning?), which needs Manny. Doing it on a guess would
  bake the wrong answer into a schema.
- **The rabbit hole (a/b/c)** — explicitly needs Manny. Recorded, recommended,
  not decided.
- **Set 3 rows #9 scene cards, #13 beat sheets, #21 format directives, #22
  per-scene history** — moved to phase 2b and **shipped**, below.

### Phase 2b — the four from writers-tool worth having — **SHIPPED**

`lib/beat-sheets.js` · `routes/story-structure.js` · migration 075 ·
`tests/story-structure.test.js` (11 invariants).

Each was tested against commitment 1 — *any row proposing a new table must argue
why the format cannot hold it* — and **they did not all answer the same way**,
which is the useful part:

| feature | storage | why |
|---|---|---|
| **Beat sheets** (#13) | a table | Fountain cannot say "this scene is the Midpoint" in any form you can query, and the query IS the feature |
| **Scene cards** (#9) | 3 columns on `film_scenes` | conflict and outcome are *about* a scene rather than in it; a synopsis line is prose you cannot sort on |
| **Format directives** (#21) | 1 column on `film_projects` | how a film should be WRITTEN is not part of what is written |
| **Per-scene history** (#22) | **nothing** | every version of every scene is already in `film_scripts`, one full Fountain per version — a table would store what we can derive and then have to be kept in step with the documents it duplicates |

**The holes are the output.** A list of beats you have covered answers the easy
half; the useful half is the beat with nothing against it. Each hole carries its
guidance, so *"you have no Midpoint"* arrives with *"the midpoint is where what
they believed turns out to be wrong"* — a diagnosis and something to act on.
Suggestions match unlinked beats to scenes by pacing alone and are forward-only,
so a late beat cannot claim an early scene; they are a guess and say so.

Three decisions worth keeping:

- **`film_beats.scene_id` is `ON DELETE SET NULL`, not CASCADE.** Deleting a
  scene must not delete the beat: the beat is the requirement and the scene was
  one attempt at it, so losing the scene should **reopen the hole** rather than
  pretend the structure never wanted that beat.
- **A scene card does not restamp the scene.** Authored metadata is not
  screenplay text, and restamping would report every shot in the scene as behind
  because somebody wrote down what the scene is about.
- **Directives are not `style_preset`.** That field is appended to every image
  prompt; putting *"present tense, no camera directions in action"* there would
  send screenwriting instructions to an image model on every frame. Two
  audiences, two fields, and the response says so.

Scene cards surviving a revision is the risk that had to be tested rather than
assumed: `film_scenes` is a **projection**, and reconciliation rewrites the
fields it owns on every save. It is safe only because those fields are exactly
int_ext/location/time_of_day/description/characters_present, and because scene
ids now survive a revision by content matching. Without the second, every
rewrite would have orphaned them.

Not ported from the writers-tool five: **surgical `edit_document`** — named
phrases changed in place, all-or-nothing per batch. A different shape of change
from anything here, and phase 3.

### The `BELIEVED` cells, verified

The writers-tool agent marked eight cells as their reading of *this* repo rather
than knowledge of it, and flagged them for the driver. Settling them before
scoping phase 3 was the point — **two were wrong, and phase 3 is smaller for it**:

| row | believed | verified |
|---|---|---|
| #2 live auto-classification | "not verified" | **present** — debounced re-typing on input (`index.html:15950`) |
| #3 Tab / Enter cycling | absent | **present** — Tab accepts a suggested type or cycles by context (`:16995`) |
| #4 SmartType | absent | **partial** — autocomplete for characters and locations; no scene-intro, time-of-day or transition vocabulary |
| #5 element indicator | absent | **absent**, confirmed |
| #10 move / reorder | "scene order is Fountain order" | **present in the editor** (drag-drop rebuilds the blocks), **absent over MCP** |
| #17 groups and collections | absent | **absent**, confirmed — the matches were board-grouping, a different feature |
| #18 story points | absent | **absent**, confirmed |
| #20 project vocabularies | "fixed" | **fixed**, confirmed — `card-vocabulary` serves the validator's own enums |
| #25 targets and writing history | absent | **absent**, confirmed |

Marking a cell BELIEVED rather than filling it in confidently is what made this
cheap to settle. Two features that would have been rebuilt were already there.

### Phase 3 — parity polish
- FDX `centered` / `lyrics` / `page_break` fidelity
- `script_stats` over MCP
- Set 3 rows marked phase 3: live auto-classification (#2), Tab chains (#3),
  SmartType (#4), element indicator (#5), move/reorder (#10), split/merge (#11),
  groups (#17), story points (#18), vocabularies (#20), targets (#25)

### Phase 3 — **SHIPPED**, and shorter than planned

`tests/screenplay-polish.test.js` (12 invariants). Scoped **after** verifying the
`BELIEVED` cells, which is why it is short: live auto-classification and Tab
cycling were believed absent and are present, so two features that would have
been rebuilt were already there.

**Export fidelity, closed at the paragraph rather than the type.** `centered` and
`lyrics` were flattened to `Action` because they have no FDX *type* — centring is
an ALIGNMENT and there is no lyric paragraph at all. Mapping them to a type was
always going to lose something. They now carry their form as paragraph
attributes (`Alignment="Center"`, `Style="Italic"`), which is what Final Draft
does itself, so it reads back. `page_break` had a real type and was simply
dropped. FDX 10/13 → 11/13.

**Surgical `scene_edit`** — the fifth writers-tool feature. `scene_update`
replaces a whole scene, so changing one line means re-sending every other line
and trusting the model reproduced them. Three rules make it usable by an agent: a
phrase must match **exactly once** unless `all` is set, a phrase that is not
there is a **failure** rather than a no-op, and **if any edit in a batch fails,
none are written** — a batch that applies two of three changes leaves a scene
nobody wrote and nobody can reconstruct. It *does* mark the scene changed,
because it is screenplay text.

**`script_stats`** over MCP: words, pages, scenes, dialogue percentage, speaking
parts, and runtime at a page a minute.

### A real bug the phase found: dialogue was invisible to drift

Writing the surgical-edit test surfaced it. `film_scenes.description` holds
**action only** — the parser never put dialogue in it — so `sceneFingerprint`
could not see a dialogue rewrite, and every shot in the scene went on reporting
as current.

It is the most consequential thing that function could have missed. Dialogue is
what gets rewritten most, and it is the **direct input to voice generation**: a
line changed after the voice was cut left an audio file saying something the
script no longer says, with nothing anywhere to notice.

Dialogue is in the fingerprint now, read from the shot cards (which is where the
parser puts it and what generation reads). Widening a fingerprint would normally
report every scene in every existing project as rewritten, so a scene whose
stored hash matches the **pre-dialogue formula** and is otherwise unchanged is
re-baselined silently — new hash, timestamp untouched. Without that, the first
save after this change would light up every board with drift for work nobody
touched, and a warning that fires on work nobody needs to redo is one people
learn to dismiss.

### Not ported, and why

`groups and collections` (#17), `story points` (#18), `project vocabularies`
(#20) and `targets and writing history` (#25) are writers-tool **project
management**. They do not serve *write a screenplay and take it through the
pipeline to a film*, and porting them would add surface nobody asked for to the
tool that is meant to replace two tools with one. Recorded as a decision rather
than left looking like an oversight.

## Open questions

All three of the original questions are now **answered** and folded into the
sections above. What remains open needs Manny, not us:

1. **The rabbit hole — (a), (b) or (c)?** Whether the UI's AI writing routes keep
   their server-side LLM. Recommendation is (c): MCP is the default path, HTTP is
   the fallback when no agent host is attached. Blocks phase 2.
2. ~~Does `includeInCompile` have a Film Engine meaning?~~ **ANSWERED: no.**
   Cutting an act means deleting or boneyarding its scenes, not flagging them —
   which left `film_acts` with nothing Fountain could not hold. See below.

### Settled during this confer

- **`film_acts` vs `#` sections** — **resolved further than the confer expected**:
  the table is gone entirely. See "Acts are sections" below.
- **Synopsis** — authored, not derived. `=` lines are its home. Word count is
  derived and needs nothing.
- **writers-tool scene format** — Fountain over MCP, typed HTML blocks at rest.
  The adapter is load-bearing.

## Acts are sections — `film_acts` dropped (migration 076)

The confer's resolution was *sections authoritative for name/order/nesting;
`film_acts` retained only for state Fountain cannot express*. Settling
`includeInCompile` emptied that second half: cutting an act means deleting or
boneyarding its scenes rather than flagging them, so there was nothing left for
the table to hold.

**The evidence that made it a clean removal rather than a migration.** Both
mechanisms were empty: `film_acts` had **0 rows across every project** and **0
scenes carried an `act_id`** — and 0 sections had ever been written either,
because until phase 2 the editor could not author one. Nothing to move in either
direction, so the only question was which mechanism survives.

Sections win on three counts the table cannot match: they are **authorable in the
editor** (phase 2), they **export to Final Draft** as Section Headings, and they
**travel with any copy of the document**. A table stays on the machine it was
written on.

Removed as a set rather than a file: the table, `film_scenes.act_id`,
`routes/acts.js`, its server dispatch, the backup manifest entry, the demo
seeder's inserts, and the SPA's page, modal, nav entry and five functions.
`tests/act-structure.test.js` scans `routes/`, `lib/` and `src/` for any
surviving reference, because a removal is only finished when every reader is
gone — a leftover import throws on a path nobody tests, and a backup manifest
naming a dropped table makes **every export** fail, which is the thing you reach
for when something else has already gone wrong.

Two things worth recording from doing it:

- **The demo already had act structure in its Fountain** — `# ACT ONE`,
  `# ACT TWO`, `# ACT THREE` with synopses — while separately inserting the same
  acts into the table. The two-sources-of-truth problem was sitting in the seed
  data, unnoticed, which is the most persuasive argument the removal could have
  had.
- **A brace-counting walk deleted the previs page.** Removing the acts page by
  matching `<div>`/`</div>` ran past the boundary and took 40,711 characters
  instead of 356. Caught by checking every other page still existed, reverted,
  and redone against the next sibling `<div class="page">`. Structural edits to
  HTML get bounded by siblings, not by counting.

If *"exclude this act from the film"* ever does become real, it is **one column
keyed off a section heading** — cheaper to add then than to keep a table on
speculation now.

## Deferred

- **`send_to_film_engine` parity in reverse** (Film Engine → writers-tool). Not
  needed: the goal is to stop using writers-tool for screenplays, so the path
  only has to run one way.
- **Compile (#23), corkboard/outliner (#24), DOCX/Scrivener import (#27)** —
  marked *do not port* by the writers-tool agent. Film Engine has its own output
  path, and its board is the corkboard.
- ~~The `BELIEVED` cells in Set 3 rows 2, 3, 9, 10, 17, 18, 20, 25~~ —
  **VERIFIED** before phase 3 was scoped. See below; two were wrong, and phase 3
  is smaller because of it.
