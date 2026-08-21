# Screenplay: making Film Engine the only tool you need to write in

**Status:** draft 1 · confer 766495b7 · driver = film-engine agent · writers-tool cells owned by the writers-tool agent
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
| `missing-primitive` | genuinely absent; nothing in the format or schema solves it | build |
| `bug` | present and wrong | fix |

---

## Set 1 — the 13 Fountain element types, across 5 surfaces

Derived from `lib/fountain-parser.js` (the registry), not from this description. Every cell verified against code.

| # | element | parser | renderer | editor | FDX export | gap | phase |
|---|---|---|---|---|---|---|---|
| 1 | `scene_heading` | ✓ | ✓ | ✓ | ✓ Scene Heading | `none` | — |
| 2 | `action` | ✓ | ✓ | ✓ | ✓ Action | `none` | — |
| 3 | `character` | ✓ | ✓ | ✓ | ✓ Character | `none` | — |
| 4 | `dialogue` | ✓ | ✓ | ✓ | ✓ Dialogue | `none` | — |
| 5 | `parenthetical` | ✓ | ✓ | ✓ | ✓ Parenthetical | `none` | — |
| 6 | `transition` | ✓ | ✓ | ✓ | ✓ Transition | `none` | — |
| 7 | `centered` | ✓ | ✓ | ✓ | ⚠ as `Action` | `bug` (lossy) | 3 |
| 8 | `lyrics` | ✓ | ✓ | ✓ | ⚠ as `Action` | `bug` (lossy) | 3 |
| 9 | `note` | ✓ | ✓ | ✓ | ✗ **as `Action`** | `bug` (**wrong**) | 2 |
| 10 | `section` | ✓ depth | ✓ | ✗ | ✗ dropped | `surface-UI` + `bug` | 2 |
| 11 | `synopsis` | ✓ | ✓ | ✗ | ✗ dropped | `surface-UI` + `bug` | 2 |
| 12 | `boneyard` | ✓ | ✓ | ✗ | ✗ dropped | `none` — correct | — |
| 13 | `page_break` | ✓ | ✓ | ✗ | ✗ dropped | `bug` | 3 |

**Coverage: parser 13/13 · renderer 13/13 · editor 9/13 · FDX 9/13 (3 of those 9 lossy or wrong).**

### The FDX defects are three different bugs, not one

- **Dropped** (`section`, `synopsis`, `page_break`): structure a script in Film Engine, export to Final Draft, and the act structure vanishes. Silent.
- **Wrongly promoted** (`note`): `FDX_TYPE_MAP.note = 'Action'`. A Fountain note — `[[check the tide tables]]` — is a production note, *not script text*. Exporting it as Action puts your private note into the screenplay body. **This is worse than dropping it**, and it is the only one of the three that changes what the script says.
- **Lossy** (`centered`, `lyrics`): flattened to Action. The words survive; the formatting does not.

`boneyard` is correctly dropped — it is deleted text, and exporting it would resurrect cuts.

---

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
| 1 | `scene_append` — add a scene at the end | absent | `missing-primitive` | **1** |
| 2 | `scene_insert_after` — add after scene N | absent | `missing-primitive` | **1** |
| 3 | `outline_get` — sections + synopses as a tree | absent | `surface-MCP` | 2 |
| 4 | `outline_write` — author sections/synopses | absent | `surface-MCP` | 2 |
| 5 | `script_stats` — words, pages, scene count, dialogue % | HTTP only | `surface-MCP` | 3 |

---

## Set 3 — writers-tool features

> **Owned by the writers-tool agent.** Every cell below is `UNVERIFIED` until they fill it. The driver will not invent them — a plan whose cells are remembered rather than checked is worthless, and this repo has already been bitten once today by the difference between "wired" and "merely exists".

| # | writers-tool feature | behaviour | reachable over MCP? | film-engine today | gap | phase |
|---|---|---|---|---|---|---|
| — | *awaiting inventory* | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | — |

### Recorded as `film-engine-ahead` (from the writers-tool agent, milestone 1)

No work. Listed so nobody re-implements them:

- dual dialogue · centered · lyrics · notes · revision colours · changed-page tracking · scene reconciliation

---

## Phases

Cut by **dependency**, not by feature count.

### Phase 1 — unblock *From the Mist* (the acceptance criterion)
- `scene_append`, `scene_insert_after` — route + MCP tool
- The chapter-by-chapter loop working end to end from Claude Desktop

**Done when:** a chapter can be added without re-sending the screenplay, and adding chapter N does not alter scenes 1..N-1 byte-for-byte.

### Phase 2 — structure you can author and keep
- Editor: author `section` and `synopsis`
- FDX: stop dropping `section`/`synopsis`; stop exporting `note` as script text
- MCP: `outline_get` / `outline_write`

**Done when:** an outline written in Film Engine survives a round trip to Final Draft.

### Phase 3 — parity polish
- FDX `centered` / `lyrics` / `page_break` fidelity
- `script_stats` over MCP
- Whatever Set 3 turns up that is not already covered

---

## Open questions

1. **`film_acts` vs Fountain `#` sections.** Two ways to say what act a scene is in. Sections have never been written to, so `film_acts` is presumably what the UI uses. Per commitment 2 the Fountain section should be the source and `film_acts` a projection — but if acts carry *state* in writers-tool (status, target length, notes), the table stays authoritative for those fields. **Needs the writers-tool agent's read.**
2. **Is `synopsis` authored as document text, or as side-panel metadata?** Storage is solved either way; this is a UI decision.

## Deferred

- Nothing yet. Anything not done gets named here with a reason.
