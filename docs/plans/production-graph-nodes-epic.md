# Epic: Production Graph — Nodes That Show Their Work

*2026-09-28. From the comparison of ComfyUI's editor with Film Engine's Production screen (behind the `production_graph` setting). The ComfyUI provider epic GRD-4503 was closed and archived the same day, because Gridlight on AWS (GRD-4391) is the open-weight runtime. This epic takes only the editor ideas, and none of them needs ComfyUI. Held by `backend/tests/production-graph-nodes-epic.test.js`.*

## Overview
The Production screen puts every shot, sequence, sound and generated version on one canvas (`backend/lib/production-graph.js`, `backend/routes/production-graph.js`, the `pg*` functions in `src/index.html`). You can already run a node, run everything pending, switch versions, join shots into sequences, and play the cut underneath. Much of what the engine knows never reaches that canvas, though:
- what is running, and how far along it is;
- what is out of date;
- what a clip needs before it can be made;
- how a version was made.

This epic brings the eight things ComfyUI's editor does well onto the graph, built on data Film Engine already has. The impact report says what is behind. The generation-jobs table holds every paid job. The render ledger and fingerprints record how each version was made. The spend confirmation gates every run.

| Feature | Name | What it gives the director |
|---|---|---|
| F1 | Live progress on the node | Percentage, phase and elapsed time on the node that is running, or a plain statement that the provider reports no percentage |
| F2 | Out-of-date on the graph, and "Run what changed" | Every node and edge coloured current / redo / waiting, and one button that redoes only what is behind, in order |
| F3 | Run to here | Generate everything a clip or sequence still needs, frame first then clip, in one confirmation |
| F4 | Queue and history strip | Running, waiting, done today, and awaiting collection, under the canvas, with cancel and collect |
| F5 | How was this made | Provider, model, prompt, references and seed for any version; "make another like this"; A/B compare |
| F6 | Hold a node | Batch runs skip a held shot or sound, which still stays in the film |
| F7 | Collapse a group | A sequence or scene becomes one card with its length, progress and anything behind |
| F8 | Search to add, and patterns | Double-click to add by name; "shot / reverse shot" and similar patterns in one step |

## Business Goals
- **Trust the canvas**: a director can see at a glance what is running, what is out of date and what is waiting, without opening another page.
- **Spend only on what changed**: "Run what changed" and "Run to here" replace guessing which nodes to press, and every run still passes the single spend confirmation and the budget gate.
- **Never lose a paid result**: jobs that outlive an MCP call are visible and collectable from the canvas.
- **Iterate on a version, not from scratch**: see how a take was made and make another like it.
- **Build scenes faster**: add shots and common coverage patterns without menus.
- **Agent parity**: everything the page can do, Claude can do through MCP (plan free, then run).

## Current State
| Component | Current State |
|-----------|---------------|
| Running node | `pgBusy` draws an indeterminate bar and a label ("generating frame"). No percentage, phase or elapsed time. |
| Progress data | Gridlight streams phase and step events (`backend/lib/providers/gridlight-adapter.js`); Meshy reports a 0–100 percentage. Runway, MuAPI and Seedance report nothing the adapters read. The graph's generate calls are plain POSTs, not the stream routes. |
| Jobs from Claude | Run in the separate MCP process; the page learns of them only as "something changed" through `backend/routes/events.js`. |
| Out of date | `backend/lib/impact.js` classifies each stage per shot as current, redo or waiting, but the graph shows a "stale" pill only on a sequence whose borrowed frame changed. |
| Running many | "Run pending" fills in missing frames and sounds. Nothing redoes stale work or chains a frame into its clip. |
| Queue | Paid jobs are recorded in `film_generation_jobs` (`backend/lib/generation-jobs.js`). Pending ones are collected through a tool or route, not on the canvas. |
| Provenance | Settings are in `render_ledger`; prompts and references are fingerprinted; A/B compare exists at `/shots/:id/versions/compare` (`backend/routes/render-ledger.js`). None of it is on the canvas. |
| Hold | No way to exclude a node from batch runs. |
| Grouping | Sequences are drawn as groups; nothing collapses. Layout is pinned in `production_node_layout` (`backend/db/migrations/115_production_graph.sql`). |
| Adding | A menu adds one node at a time; inserting a shot uses `/shots/:id/insert-after` (`backend/routes/shots.js`) with codes like 2AA. |

## Target State
| Component | Target State |
|-----------|---------------|
| Progress | A job record carries percent, phase and heartbeat (`backend/lib/generation-progress.js`, migration `backend/db/migrations/117_generation_progress.sql`). Every async adapter reports what it can. The graph shows it on the running node, including jobs started by Claude. |
| Node states | Every node carries a state from the impact report (current / redo / waiting / never made / untracked, the last for a file made outside the workflow, which has no input fingerprint and so cannot honestly be called current), drawn on the node and its edges. The map covers all six node types: `shot`, `video`, `sequence`, `link`, `sound` and `audio`. |
| Run what changed | A free plan of the "redo now" items in dependency order with costs, one confirmation, then sequential runs that re-read the report after each step. |
| Run to here | A free plan per target node listing each missing step and its cost, run in order through one confirmation; stops at the first refusal and names what was not attempted. |
| Queue strip | Running, waiting, done today, awaiting collection and failed, under the canvas. Each item pans to its node; cancel and collect act in place. |
| How was this made | A provenance panel on every version, with "Make another like this" and an A/B wipe against the selected version. |
| Hold | `held_at` on shots, sequences and cues; every batch entry point skips held nodes and says so; conform and export never do. |
| Collapse | A sequence or scene collapses to one summary card, remembered per project. |
| Add | A double-click palette and a registry of coverage patterns (`backend/lib/graph-patterns.js`) that create shots, a sequence and joins, and spend nothing. |

### Stage to node
| Stage | Where it shows on the graph |
|---|---|
| `keyframe` | The `shot` node (its frame) and its frame versions |
| `video` | The shot's `video` versions, and the `sequence` node for a sequence clip |
| `voice` | Rolls up onto the `shot` node as a badge: the shot's dialogue is behind |
| `lipsync` | Rolls up onto the `shot` node as a badge; its synced clip shows as a `video` version |
| `music` | The scene's `sound` node for the score and its `audio` versions |
| `sfx` | The `sound` node for that effect cue and its `audio` versions |
| `ambient` | The `sound` node for the ambience cue and its `audio` versions |
| `post` | Rolls up onto the `shot` node as a badge; finished clips show as `video` versions |
| `assembly` | Not a node: project-scoped, shown in the graph header as "film master behind" with a link to Conform |

## Constraints
- **Behind the existing `production_graph` setting**: with it off, nothing on the eight production pages changes.
- **Nothing spends without the single confirmation**: every run (single, run what changed, run to here, re-run, make another) goes through `confirmPaidImage` and the budget gate. Plans are free.
- **One source of truth per question**: node state comes from `backend/lib/impact.js`, never a second staleness rule; progress lives on the job record; provenance reads the ledger and fingerprints.
- **Cross-process**: jobs started by Claude in `backend/mcp-server.js` must show progress on the page, so progress is written to the database and delivered through `backend/routes/events.js`, not held in memory.
- **No new dependency, SSE only** (ADR-002, ADR-003).
- **Honest progress**: a provider that reports no percentage shows elapsed time and "no percentage from this provider". A percentage is never invented.
- **Hold never removes a shot from the film**: conform and export still require it and still refuse when it is missing.
- **Cancel is honest**: where a provider cannot cancel a job, "stop waiting" is offered and the job is marked as possibly still billed.
- **Agent parity**: every new action has an MCP tool, with a free plan before any spend.

## Task Breakdown

### Phase 1: Live Progress
| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| PGN-001 | Progress on the job record | (F1) Migration 117 adds percent, phase, started_at, heartbeat_at and collectable to `film_generation_jobs`. `backend/lib/generation-progress.js` writes them at most once a second per job. Every generation gets a job row, including synchronous ones, so the page has one place to read what is running. | M | None |
| PGN-002 | Adapters report what they can | (F1) Pass an onProgress callback through the resolve() funnel in `backend/lib/providers/index.js` to every adapter. Map Gridlight phase and step events and Meshy percentages; read a percentage from Runway, MuAPI and Seedance task polls where their responses carry one. Each adapter declares `reportsProgress`; a set-based test iterates every async adapter. | M | PGN-001 |
| PGN-003 | Progress on the running node | (F1) The graph draws percent, phase and elapsed time on the running node, or elapsed time with "no percentage from this provider". Updates arrive through `backend/routes/events.js`, so jobs started by Claude show too. Replace the indeterminate bar only when a percentage exists. | M | PGN-002 |

### Phase 2: Out-of-date and Run What Changed
| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| PGN-004 | Node states from the impact report | (F2) `buildGraph` in `backend/lib/production-graph.js` attaches current / redo / waiting / never-made to each node, from `backend/lib/impact.js`, following the Stage to node table (`shot`, `video`, `sequence`, `link`, `sound`, `audio`; the later `inbetween` node reads its own state: never made, frames still to make, or changed since its approval). The existing sequence link-stale rule folds into the same field. | M | None |
| PGN-005 | Draw states on nodes and edges | (F2) Border, pill and edge colour per state, a legend, the "why" and "action" text from the report in the node's tooltip and drawer, and a filter for "only what's behind". | M | PGN-004 |
| PGN-006 | Run what changed: plan | (F2) Free `GET /projects/:id/production-graph/run-changed/plan` lists the "redo now" items in dependency order, each with its own estimated cost and a total from the run-plan pricing in `backend/lib/run-plan.js`. It reports what it skips (held, waiting, locked board) and why. | M | PGN-004 |
| PGN-007 | Run what changed: run | (F2) One confirmation shows the plan; items run one at a time through the existing generate paths; the report is re-read after each, so a waiting item runs once what it waits on is done. It stops at the first refusal and names the rest. Budget, stale-input and board-lock gates apply. | L | PGN-006 |

### Phase 3: Run to Here
| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| PGN-008 | Run to here: plan | (F3) Free plan for a `video`, `sequence` or `sound` node: every missing or out-of-date step it depends on, frames before clips and borrowed frames resolved, each with its cost and the total. | M | PGN-004 |
| PGN-009 | Run to here: run and menu | (F3) "Run to here" in the node menu runs the plan in order through one confirmation, shows progress per step on each node, and stops at the first refusal naming what was not attempted. | M | PGN-008, PGN-003 |

### Phase 4: Queue and History
| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| PGN-010 | One queue read model | (F4) A free `GET /projects/:id/production-graph/queue` returns running (with progress), waiting (the rest of the current batch), done today, awaiting collection (pending handles in `backend/lib/generation-jobs.js`) and failed, each with its node key and a thumbnail. | M | PGN-001 |
| PGN-011 | Queue strip under the canvas | (F4) A collapsible strip: click an item to pan to its node, collect a pending job in place, re-run a failed one through the confirmation. | M | PGN-010 |
| PGN-012 | Cancel, stated honestly | (F4) Cancel stops a batch before its next step. For a running provider job, each adapter declares whether it can cancel. Where it cannot, "stop waiting" leaves the handle collectable and says the provider may still bill. | M | PGN-011 |

### Phase 5: How Was This Made
| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| PGN-013 | Provenance read model | (F5) Free `GET /assets/:id/provenance`: provider, model, prompt, negative, references with thumbnails, seed, size and tier, fingerprint and whether it is current, the render_ledger row (`backend/routes/render-ledger.js`, `backend/lib/provenance.js`), cost, and when. Anything unknown is reported as unknown. | M | None |
| PGN-014 | How-was-this-made panel and compare | (F5) A panel in the version drawer. "Make another like this" opens the confirmation pre-filled with that version's prompt, references and seed where the provider honours one. "Compare with selected" gives an A/B wipe for frames and clips. | M | PGN-013 |
| PGN-015 | Drop a file to find its recipe | (F5) Dropping a file onto the canvas matches it by content hash to a project asset and opens its provenance. An unknown file is offered as an upload to the node it was dropped on. | S | PGN-014 |

### Phase 6: Hold
| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| PGN-016 | Hold on shots, sequences and cues | (F6) Migration 118 (`backend/db/migrations/118_graph_hold.sql`) adds held_at to `film_shots`, `film_sequences` and `film_music_cues`. Set and release it through the existing update routes and MCP update tools, with Ctrl+B and a menu item on the graph and a "held" badge. | S | PGN-001 |
| PGN-017 | Honour the hold in every batch run | (F6) Held nodes are skipped, and reported as skipped, by `pgRunPending()`, `buildRunPlan()`, `executeShots()`, `generateStoryboard()`, `generateStoryboardStream()`, `batchVideo()`, `batchVideoStream()`, `batchMusic()`, `batchMusicStream()`, `batchVoice()`, `batchVoiceStream()`, and by Run what changed and Run to here. Conform and export ignore the hold. A set-based test derives the batch entry points from the code. | M | PGN-016, PGN-007, PGN-009 |

### Phase 7: Collapse
| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| PGN-018 | Collapse a sequence or scene | (F7) A collapsed flag per group, stored beside the pinned layout. The collapsed card shows length, shots done / total, how many are behind, and anything running. Expand restores the layout exactly; Tidy respects collapsed groups. | M | PGN-005 |

### Phase 8: Search and Patterns
| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| PGN-019 | Double-click to add | (F8) A palette at the pointer: type to add a shot (inserted after the nearest shot with the next code, such as 2AA), a sound cue of any type, or a sequence from the selected shots. Keyboard only, Escape to cancel. | M | None |
| PGN-020 | Coverage patterns | (F8) `backend/lib/graph-patterns.js` holds patterns such as "shot / reverse shot", "insert then reaction" and "wide, medium, close". Each shows a free preview of the shots, sequence and joins it would create, then creates them with no generation. | M | PGN-019 |

### Phase 9: Agent Parity and Proof
| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| PGN-021 | MCP tools for every new action | (F2) (F3) (F4) (F5) (F6) Tools for run-what-changed plan and run, run-to-here plan and run, queue, provenance, hold and release, and patterns, each dispatched through the route. The existing derived test requires a tool for every route verb. | M | PGN-007, PGN-009, PGN-010, PGN-013, PGN-017, PGN-020 |
| PGN-022 | Production graph tests and browser check | (F1) (F2) (F3) (F4) (F5) (F6) (F7) (F8) Extend `backend/tests/production-graph.test.js` and add `backend/tests/production-graph-nodes.test.js`, set-based over node types, impact stages and batch entry points. Then run one real browser pass on a project with a running job, a stale frame, a held shot and a collapsed sequence. | M | PGN-021 |
| PGN-023 | CLAUDE.md and the agent guide | (F1) Record the design in CLAUDE.md, including where progress comes from and what cancel really does, and add the new tools to `docs/claude-desktop-guide.md`, so the docs-drift and MCP-guide tests hold it. | S | PGN-022 |

## Open Questions
Decided by the user on 2026-09-28:
1. **Sync jobs as rows**: yes. Every generation, including quick image calls, gets a `film_generation_jobs` row, so the queue is complete (PGN-001).
2. **Collapsed state**: per project, stored beside the pinned layout (PGN-018).
3. **Live previews**: not now. Percentage, phase and elapsed time are enough; image previews can be a later task.
4. **Hold and the budget**: a held node is excluded from the projected total and listed separately as held (PGN-017).

Still open:
5. **Which patterns ship first**: the three named, or a list from the director's own coverage habits (PGN-020)?

## Success Metrics
- `backend/tests/production-graph-nodes-epic.test.js`, `backend/tests/production-graph-nodes.test.js` and `backend/tests/production-graph.test.js` pass, and each new set-based test fails when one member of its set is removed.
- With `production_graph` off, the whole suite is unchanged.
- A Gridlight job shows a rising percentage on its node. A Runway job shows elapsed time and "no percentage from this provider". A job started by Claude shows on the page without a reload.
- After editing one scene card, the graph marks exactly the nodes the impact report marks, and "Run what changed" runs exactly its "redo now" list, in order, behind one confirmation.
- "Run to here" on a sequence with two missing frames runs three steps in one confirmation whose total matches the free plan.
- A held shot is skipped by every batch entry point and still appears in the conformed film.
- Every new action is reachable by Claude through MCP, with a free plan before any spend.
