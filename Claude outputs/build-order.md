# Film Engine build order — decision packets

Date: 2026-09-04
Owns: `remote-approvals.md`, `inbetween-strips.md`

**No phase depends on another repository or on any particular application.** Nothing here needs
an orchestrator running, a chat platform, a scheduler, or any named consumer to exist. Film Engine produces facts about a
production; what displays them and who decides is not its concern.

---

## State

| | |
|---|---|
| In-between strips | **Shipped.** `lib/inbetweens.js`, `lib/inbetween-run.js`, 3 test files, `routes/sequences.js` wired, migrations at 102. |
| `approval_envelope` | Not started. |
| `take_candidates` | Not started. |
| `lib/review-proxy.js` | Not started. |
| Remote-approval staleness guard | Not started. |
| Per-run credit ceiling | Not started. |

`docs/plans/remote-approvals.md` is untracked — commit it first.

Run tests **on this Mac**: `better-sqlite3` here is a macOS build, and DB-touching tests fail
elsewhere with `invalid ELF header`.

---

## F0 — Confirm the base

```bash
cd backend && node --test tests/*.test.js     # expect 666+ passing
```

The in-between work landed after its spec was written; confirm green before building on it.

## F1 — `approval_envelope` · FREE tool

The pre-spend decision packet: what will run, the prompt actually sent, references and their
roles, `style_applied`, tier, model, credit estimate, warnings, media paths, fingerprint.

Assembled from tools that already exist and already cost nothing — `dry_run`, `shot_prompt`,
`video_preview`, `sequence_plan*`, `previs_to_storyboard`. No new computation, one new shape.

**`warnings` is what makes a decision informed.** A stale plate, a missing size, a prompt whose
tail is being truncated — none of that is visible in a picture.

**Media travels as absolute paths** (`lib/file-storage.js` `getFilePath`), never `getFileUrl`:
a LAN URL resolves nowhere useful outside the LAN. Carry `media_transport: "path"` so the day
this moves to another machine is a one-line change, not a silent set of broken attachments.

The envelope is useful on its own — in the CLI, in a dry run, in the web UI — before anything
external consumes it. Build it that way and test it that way.

## F2 — `take_candidates` · FREE tool

The post-generation decision: which archived attempt is the take. Reads what `shot_frames`
already stores; each candidate carries the `refined_from` and `instruction` metadata
`routes/storyboard.js` already writes at L478, so a candidate arrives labelled with *why it
exists* — most of what separates two near-identical frames.

Resolution goes back through the existing `POST /film/takes/:versionId/select`. Do not invent a
second selection concept.

## F3 — `lib/review-proxy.js`

A production clip will not survive most transports, and a master never should. Using the ffmpeg
already vendored (`ffmpeg-static`, `lib/ffmpeg.js`):

- `stillFor(videoPath)` — one representative frame, PNG.
- `proxyFor(videoPath, { maxBytes })` — 720p, capped seconds, **returns null rather than
  something oversized**, so the caller can say why instead of failing a transfer.
- Cache beside the asset keyed on source mtime. A packet requested twice must not re-encode.

`maxBytes` is an argument. Film Engine has no opinion about any particular platform's limit.

## F4 — The staleness guard · the most important item here

An approval is a decision about a *specific* set of inputs, and a plate can be regenerated
between the decision and the execution.

**Film Engine re-checks its own fingerprint** (`lib/artefact-fingerprint.js`) before acting on
any approval, whoever granted it, and refuses `409 STALE_APPROVAL` on mismatch — re-raising a
fresh envelope rather than proceeding. Same contract `previs_approve` already carries.

This must live here and nowhere else. Only this repo knows what its inputs are, so only this
repo can say whether they still match. An external approver that tried to validate this would
be guessing.

## F5 — Per-run credit ceiling

The budget check refuses at 402 per request — that stops one runaway call, not a loop of them.
Accept `max_credits` on any externally-initiated run and refuse the whole run when `run_plan`'s
projection exceeds it, **before** the first generation.

---

## Tests

```bash
cd backend && node --test \
  tests/approval-envelope.test.js tests/take-candidates.test.js tests/review-proxy.test.js
```

- an envelope for a shot with no plate warns, naming the missing plate
- `cost` matches `video_preview` for the same tier
- `prompt.truncated_tail` is non-empty when the composed prompt exceeds the ceiling
- every `media.items[].path` exists and is inside the project's data dir
- the fingerprint changes when the shot changes and not when unrelated rows do
- candidates are newest-first and mark `current_version`
- `proxyFor` returns null rather than a file over `maxBytes`; a second call does not re-encode
- an approval whose fingerprint no longer matches is refused

Every one of these runs with nothing else on the machine.

---

## Integration boundary

Film Engine emits decision packets over MCP. It does not know or care what renders them.

**No orchestrator, chat platform, scheduler or approval system is named in this codebase** —
not in code, not in config defaults, not in a tool description. Film Engine gets no chat client,
no bot token, no webhook, no approval table and no notification scheduling. Anything that maps an envelope onto some other system's fields is an adapter living
outside this repo — configuration on the machine, not code here.

What Film Engine keeps, always: the fingerprint check, the budget ceiling, and the rule that a
`*_plan` tool is free and side-effect-free. Those are this repo's rules and no external approval
overrides them.

## Do not

- Add a field shaped for one particular consumer. If it is not useful in the CLI and the web
  UI, it does not belong in the envelope.
- Move the staleness check outside this repo.
- Let a scheduler's convenience turn a free tool into one that writes.
