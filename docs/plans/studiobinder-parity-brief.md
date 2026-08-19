# Research Brief: StudioBinder Parity for AI Film Production

**Source:** [`studiobinder-parity-research.md`](studiobinder-parity-research.md) · 42 features scored
against a probe of 43 route modules and 64 tables.

---

## Executive Summary

Film Engine already matches or beats StudioBinder on everything creative — screenwriting, script
breakdown, shot lists, storyboards and blocking — and has an entire axis StudioBinder does not
have at all: media generation, 3D previs with real optics, provider routing, render
reproducibility, cost gating and an agent surface. The parity gap is almost entirely
**production-management connective tissue**: 27 of 42 features missing, 7 partial, with
*scheduling missing 5 of 5* and *collaboration missing 4 of 5*.

The single most valuable feature is not on any StudioBinder feature list by name. StudioBinder's
real claim is **propagation** — editing a scene updates the breakdown, schedule and call sheets.
Our equivalent is stronger, entirely absent, and already caused a shipped defect: a clip-art
character plate survived its own fix by fourteen hours and silently poisoned every frame that
referenced it. Staleness propagation is simultaneously the parity feature and the correctness fix.

**A correction to the research it came from:** that document claimed DOOD and sides were "nearly
free because the data already exists in `film_scene_characters`". That is wrong. `film_scene_characters`
and `film_scene_props` are **dead tables — nothing writes to them** (`grep "INSERT INTO
film_scene_characters"` → no hits, table count 0). Character presence actually lives in
`film_scenes.characters_present`, and it is **dialogue-only**: on Wingfall it reads
`["MAYA"], [], ["MAYA"]`, so the DRAGON — the title creature — appears in no scene. That is the
same root cause as the entity-detection bug fixed earlier (presence keyed on dialogue cues), one
layer down. Sides and DOOD are still cheap, but they are blocked on a presence fix, not free.

---

## Key Themes

- **The gap is plumbing, not craft.** Nothing missing is a creative capability; it is schedule,
  tasks, reports, contacts, sharing and identity.
- **Propagation is the load-bearing idea.** Every StudioBinder module is downstream of the script;
  their value claim is that the graph updates. Ours does not update at all.
- **Scheduling translates but the axis rotates.** A stripboard minimises travel and cast idle time.
  A *run plan* minimises model swaps, plate re-generation and spend. `lib/scheduling-engine.js`
  already optimises GPU model residency — it lacks the shoot-day abstraction above it.
- **Identity is a keystone, not a feature.** Roles, share links, frame comments, activity feed and
  client approval — 8 items — all sit on a user table that does not exist.
- **Two features should be reinterpreted, not copied.** Call-sheet SMS and weather/hospital lookup
  have no AI-production meaning; the useful version is run-completion notification.
- **Presence data is quietly broken**, and several parity reports depend on it.

---

## Top Ideas & Opportunities

1. **Staleness propagation (the dependency graph)**
   *What:* every derived artefact — scene card, plate, keyframe, clip — records a fingerprint of
   its inputs; editing an input marks descendants stale rather than silently leaving them valid.
   *Why:* it is StudioBinder's core claim, it is the correctness fix for the plate defect we
   shipped, and it is the only feature here that prevents money being spent on wrong output.
   *How:* generalise the approval fingerprint already built (migration 062: sha256 over camera +
   card, `approved`/`stale` distinguished) from previs to every derived artefact.

2. **Run plan (stripboard, rotated)**
   *What:* order shots into generation batches; show projected cost and wall-clock per batch;
   support alternate plans under a budget ceiling.
   *Why:* the entire scheduling category is 5/5 missing, and this is where AI production actually
   has a scheduling problem worth solving.
   *How:* a shoot-day/strip abstraction over `scheduling-engine.js`'s `MODEL_PROFILES`, costed by
   `lib/flow-cost.js`, refused by the existing HTTP 402 budget gate.

3. **Mood board / look development**
   *What:* a surface where references are gathered and a style is decided *before* generating.
   *Why:* its absence is why `style_preset` ended up carrying the subject noun "anatomical beast",
   putting a creature in an establishing shot the card describes as "Empty, ordinary, still."
   *How:* extends `film_continuity_refs` and the plate system; the board's output is the style
   preset and the plate set, so it feeds generation rather than sitting beside it.

4. **Shot Tagger (script line → shot)**
   *What:* select a line of action or dialogue and a shot is created from it.
   *Why:* the fastest known path from screenplay to shot list; today shots are created by hand or
   by agent. It is also the natural place to fix presence, since tagging a line knows who is in it.
   *How:* `film_script_elements` already stores element-level script data; `shot_create` exists.

5. **Storyboard annotation (arrows, text, shapes)**
   *What:* mark up a generated frame.
   *Why:* the fastest notation for "move her left, push in" — and unlike StudioBinder, our markup
   could *feed the next generation* rather than instruct a human artist. This is a parity feature
   that becomes a differentiator.
   *How:* canvas overlay in the existing single-file SPA, same hand-rolled approach as previs.

6. **Presence repair, then sides + DOOD**
   *What:* populate character/prop presence per scene from action as well as dialogue; then emit
   sides (per-character dialogue packet) and DOOD (who appears where).
   *Why:* sides drive voice-generation review; DOOD drives refsheet/voice needs and per-character
   spend. Both are reports, not systems.
   *How:* retire the dead `film_scene_characters`/`film_scene_props` tables or start writing them;
   reuse `actionIntroducedCharacters()` already built for entity detection.

7. **Identity (users, roles, share links)**
   *What:* Owner/Admin/Member, view-only links, comments on frames, activity feed.
   *Why:* unblocks 8 matrix items at once and is the only way "client review" means anything.
   *How:* one schema decision; the backend has no auth layer at all today, so this is greenfield —
   and it is the item most likely to be **out of scope** for a single-operator AI pipeline.

8. **Run notification (the reinterpreted call sheet)**
   *What:* tell the director a batch finished, what it cost, what failed.
   *Why:* replaces call-sheet distribution/analytics with the thing that actually matters here.
   *How:* the backend has one dependency and no mail/SMS capability; the honest delivery channel
   is the **agent host over MCP**, which is where the director already is.

---

## Technical Approaches

| Need | Reuse rather than build | Evidence |
|---|---|---|
| Staleness | Approval-fingerprint pattern | `062_previs_approval.sql`, `blockingFingerprint()` |
| Cost per plan | Existing projection + 402 gate | `lib/flow-cost.js` |
| Batch ordering | GPU residency scheduler | `MODEL_PROFILES` in `lib/scheduling-engine.js` |
| Agent reach for every new route | In-process route shim | `callRoute` in `lib/mcp-tools.js` (64 tools) |
| Boards/annotation UI | Hand-rolled canvas, no bundler | previs + flows canvas, `build.target: single-html` |
| Reports | Existing generators | `lib/nle-export.js`, call-sheet builders |
| Asset storage | Registry with 22 types | `film_assets` |

**Constraints that shape all of it:** one backend dependency (`better-sqlite3`), no bundler, no
auth layer, SQLite CHECK constraints cannot be widened in place (migration 042), and every new
route should be MCP-reachable by default — the rabbit-hole note, and the reason entity creation
was impossible for an agent until this week.

---

## Open Questions

1. **Is identity in scope at all?** Eight features depend on it, and a single-operator AI pipeline
   may not want a login. Deciding *no* removes ~19% of the matrix legitimately rather than
   leaving it as permanent debt.
2. **Does the run plan replace the pipeline orchestrator or sit above it?** `PIPELINE_STEPS` and
   the flows engine already sequence work; a stripboard could be a third sequencer, which would
   be one too many.
3. **What is a "shooting day" in AI production?** A budget window, a provider session, a
   wall-clock batch, or purely a grouping device for the director's own sanity?
4. **Should annotation drive re-generation or only inform it?** Feeding markup into the next
   prompt is the differentiating version and much harder than drawing on an image.
5. **Retire or populate the dead presence tables?** `film_scene_characters` and
   `film_scene_props` exist, are joined nowhere useful, and are empty. Two migrations point in
   opposite directions.
6. **Which of the 27 are deliberately out of scope?** Weather/hospitals is already agreed;
   contracts, SSO, whitelabel and mobile are candidates. Naming them beats scoring them missing
   forever.

---

## Recommended Direction

**Build the dependency graph first, then the run plan, then look development. Defer identity
until it is asked for.**

Rationale:

- **Propagation is the only item that is both parity and correctness.** Everything else adds
  surface; this one stops the pipeline producing confidently wrong output. We have already paid
  for its absence once, and at 8 shots. At feature length the same defect is unreviewable.
- **It is a prerequisite for honest scheduling.** A run plan that cannot tell which shots are
  stale will re-generate everything or nothing.
- **Look development is where the remaining creative defects come from.** The style preset carried
  a subject noun and no surface existed to catch it; the mood board is that surface.
- **Identity is the largest block of missing features and the least evidenced need.** Nothing in
  the acceptance criterion — screenplay to final movie, managed from Film Engine — requires a
  second user. Building it first would be scoring points against a competitor's checklist rather
  than against the goal.

Suggested phasing: **P1** staleness propagation + presence repair → **P2** run plan + sides/DOOD
reports → **P3** mood board + shot tagger + storyboard annotation → **P4** identity, sharing,
activity feed, *if* still wanted.

The acceptance criterion is still screenplay → final movie in one place. Note that none of the 42
parity features close the one genuinely remaining hole in it: `assembly` is a no-op and no route
concatenates shots into a film. Parity work should not preempt that.
