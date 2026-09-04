# Remote approvals: Film Engine's half

Date: 2026-09-04
Status: design. Pairs with `neoncore/docs/plans/discord-remote-control.md`.

---

## The rule this follows

**NeonCore owns approvals. Film Engine owns the facts.**

Film Engine does not grow an approval store, a notification channel or a Discord client. It
grows one thing: the ability to hand over a **decision packet** — everything a human needs to
say yes or no, including the pictures — as free, side-effect-free data. NeonCore's bot renders
it, takes the decision, and the worker acts on it.

Two stores of approvals would mean two answers to "did I approve that", and the fingerprint
work already in `lib/artefact-fingerprint.js` would be arguing with a second record.

## How media travels: by path, not by URL

NeonCore's server and Film Engine run on the same machine. The Discord bot reads the file off
disk and uploads it. There is no tunnel and no HTTP hop, which is the whole point of choosing
Discord — nothing is exposed.

The envelope therefore carries **absolute paths**, resolved through `lib/file-storage.js`
(`getFilePath`), never `getFileUrl` — a URL only resolves on the LAN, which is exactly where
the operator is not.

*If Film Engine is ever moved to a second machine this inverts:* the bot can no longer read the
path, and the envelope must carry bytes or a LAN URL the bot fetches before uploading. Note it
in the envelope with a `media_transport` field now (`"path"`), so the day it changes is a
one-line change and not a silent set of broken attachments.

---

## The two approval moments — they are NOT the same

### A. Pre-spend gate — "may I run this?"

No picture exists yet. What decides it is numbers and words: the prompt that will actually be
sent, which references are attached, `style_applied`, the tier, and the credit estimate. Film
Engine already computes every one of these for free — `dry_run`, `shot_prompt`,
`video_preview`, `sequence_plan*`, `previs_to_storyboard`.

### B. Post-generation review — "is this the take?"

The pictures exist and are the entire content of the decision. This is the one the current
plan omitted, and it is the one where being away actually costs you, because generation is a
coin flip you already paid for and the archive is sitting there unjudged.

Film Engine already has the mechanism: every attempt is archived (`shot_frames`), and
`routes/takes.js` selects one (`selectTake` / `deselectTake`, `current_frame_version`). What is
missing is a way to hand the candidates out as a packet and take a selection back.

---

## W1 — `approval_envelope` (new MCP tool, FREE)

```
approval_envelope(shot_id | sequence_id, action) -> {
  kind: "pre_spend",
  project: { id, title },
  subject: { shot_code, scene, location, time_of_day },
  action: { tool, tier, model, provider },
  prompt: { text, chars, ceiling, truncated_tail },   // from shot_prompt
  references: [{ role, subject_name, weight, path }],
  style_applied: "...",
  cost: { credits, usd, minimum_applies },
  warnings: [...],                                     // staleness, missing plate, scale gaps
  media: { transport: "path", items: [{ role, path, bytes, mime }] },
  fingerprint: "…",                                    // artefact-fingerprint over the inputs
  expires_hint_s: 3600
}
```

Assembled from the existing free tools; it introduces no new computation, only one shape. The
`warnings` array is what turns a yes/no into an informed one — a stale plate or a missing size
is exactly what you cannot see in a thumbnail.

**`fingerprint` is load-bearing.** It is what makes an approval given at 22:00 still mean
something at 22:40. See W4.

## W2 — `take_candidates` (new MCP tool, FREE)

```
take_candidates(shot_id, limit = 6) -> {
  kind: "take_selection",
  subject: { shot_code, ... },
  current_version: 3,
  candidates: [{ version, created_at, source, instruction, refined_from,
                 path, proxy_path, still_path, bytes, mime }],
  media: { transport: "path" }
}
```

Reads what `shot_frames` already archives. `source` and `instruction` come from the metadata
`routes/storyboard.js` already writes (`refined_from`, `instruction` at L478) — so a candidate
arrives labelled with *why it exists*, which is most of what separates two near-identical
frames.

Resolution goes back through the existing `POST /film/takes/:versionId/select`. No new
selection concept.

## W3 — Proxies, because footage will not fit

Discord's attachment ceiling is small (10MB on the free tier; more with Nitro or a boosted
server — verify the current number). A production clip will exceed it and a master always will.

Add `lib/review-proxy.js` using the ffmpeg already vendored (`ffmpeg-static`, `lib/ffmpeg.js`):

- `stillFor(videoPath)` — one representative frame, PNG, for the message thumbnail.
- `proxyFor(videoPath, { maxBytes })` — 720p, capped seconds, re-encoded to land under the cap;
  returns null rather than something oversized, so the bot posts the still and says why.
- Cache beside the asset, keyed on source mtime. A review packet requested twice must not
  re-encode twice.

**Never send the master.** Not for size, and not because an unreleased master should be on a
CDN behind an unauthenticated URL.

## W4 — Approvals must not outlive their inputs

An approval is a decision about a *specific* set of inputs. Between the tap and the execution,
a plate can be regenerated or a strip edited.

Before acting on any approval, re-derive the fingerprint and compare. On mismatch, refuse with
`409 STALE_APPROVAL` and re-raise a fresh envelope rather than proceeding — the same contract
`previs_approve` already carries, applied to remote approvals.

This is the single most important guardrail in this document. Without it "I approved that" and
"that is what ran" are two different claims.

## W5 — A hard per-run credit ceiling

The budget check refuses at 402 per request. That stops one runaway call, not a loop of them.
Accept a `max_credits` on any worker-initiated run and refuse the whole run when the projected
total exceeds it — checked against `run_plan`'s projection *before* the first generation.

---

## What Film Engine does NOT get

- No Discord client, no bot token, no webhook.
- No approval table. The pending decision lives in NeonCore.
- No notification scheduling. The Hermes worker asks; NeonCore delivers.

---

## Tests

`tests/approval-envelope.test.js`
- an envelope for a shot with no plate carries a warning naming the missing plate
- `cost` matches what `video_preview` reports for the same tier
- `prompt.truncated_tail` is non-empty when the composed prompt exceeds the ceiling
- every `media.items[].path` exists on disk and is inside the project's data dir
- the fingerprint changes when the shot's description changes, and not when unrelated rows do

`tests/take-candidates.test.js`
- candidates are newest-first and mark `current_version`
- a refined candidate carries its `instruction` and `refined_from`
- a shot with one frame returns one candidate, not an error

`tests/review-proxy.test.js`
- `proxyFor` returns null rather than a file over `maxBytes`
- a second call for an unchanged source does not re-encode
- `stillFor` produces a decodable PNG

```bash
cd backend && node --test tests/approval-envelope.test.js tests/take-candidates.test.js tests/review-proxy.test.js
```

Note: `better-sqlite3` in this checkout is built for macOS; DB-touching tests fail under a
Linux sandbox with `invalid ELF header`. Run on the Mac.

## Done when

A worker can hand NeonCore a complete decision packet — numbers, prompt, warnings and pictures
— for both "may I spend this" and "which of these is the take"; the decision comes back; and an
approval whose inputs changed in the meantime is refused rather than honoured.
