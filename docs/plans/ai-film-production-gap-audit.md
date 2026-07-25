# AI Film Production — Professional Tool Gap Audit

Date: 2026-07-25
Authors: Claude + Codex (NeonCore confer)

Question: for a film that is **fully digital and AI-generated** — no actors, no sets, no locations, no physical props — does Film Engine cover what a professional production actually needs? What is missing?

## Scope Note

This is not the same question as [`e2e-short-film-readiness.md`](e2e-short-film-readiness.md), which asks *"does the existing pipeline run end to end?"* That doc audits whether the plumbing works. This one asks *"do we have the tools a professional production needs at all?"* — a capability question, not a wiring question. Read both; they answer different things.

Written against the actual route files and UI, not `CLAUDE.md`. That matters: `CLAUDE.md` omits four shipped route files (`consistency.js`, `providers.js`, `budget-estimate.js`, `demo-project.js`), so an audit written from the README under-reports what already exists. Current state: 45 migrations, 40+ route files, 35 test files.

## Short Answer

**Coverage is better than expected, and the gaps are concentrated in three places.**

Film Engine already replicates most of the traditional production-management stack — script, breakdown, shot lists, boards, asset registry, review, scheduling, budget, continuity, delivery — and in two areas (render provenance, identity locking) it does things traditional tools have no equivalent for, because the problems are AI-native.

What is missing clusters into:

1. **The generation-native layer** — the screens that exist because production is now compute. A unified job queue is the biggest single hole.
2. **The review layer** — you cannot watch your film in the app, and notes cannot be attached to a moment in time.
3. **The compliance layer** — no AI provenance or disclosure metadata, with a regulatory deadline **eight days away**.

Everything else is refinement.

## Part 1 — What Traditional Tools Do, and Whether We Do It

Benchmarked against the tools a professional production would otherwise use: StudioBinder and Yamdu (production management), Movie Magic (scheduling/budgeting), Final Draft and Celtx (script), Autodesk Flow Production Tracking (formerly ShotGrid) and ftrack (pipeline/asset tracking), Frame.io (review), DaVinci Resolve (color/finishing), Deadline (render management).

| Professional capability | Standard tool | Film Engine | Verdict |
|---|---|---|---|
| Screenplay writing/formatting | Final Draft, Celtx | `scripts.js`, Fountain parser/renderer, FDX in+out, AI assistant, revisions, comments | **Covered** |
| Script breakdown | StudioBinder, Movie Magic | `breakdown.js` (AI, SSE), `scenes.js`, element extraction | **Covered** |
| Shot list | StudioBinder | `shots.js`, scene cards, ordering, transitions | **Covered** |
| Storyboards / previs | Storyboard Pro, Boords | `storyboard.js`, style presets, style lock, per-shot regen | **Covered — exceeds** (generated, not drawn) |
| Story structure | Save the Cat, Celtx | `acts.js` | **Covered** |
| Character/costume bibles | Yamdu | `characters.js`, `film_costumes`, ref sheets | **Covered** |
| Asset tracking | ftrack, Flow | `assets.js`, 22 asset types | **Covered** |
| Review & approval | Frame.io, ftrack | `notes.js` — direction/revision/approval per shot | **Partial** — not timecoded |
| Version history / compare | Flow, ftrack | `film_shot_versions`, A/B compare with param diff | **Covered** |
| Continuity | Script supervisor | `continuity.js` board + QA continuity checks | **Covered** |
| Scheduling | Movie Magic Scheduling | `milestones`, `scheduling-engine.js` (GPU residency) | **Reframed** — see §3 |
| Budgeting | Movie Magic Budgeting | `budget.js`, `budget-estimate.js`, ledger, forecast, limits | **Covered** |
| Call sheets | StudioBinder | `call-sheets.js` | **Vestigial** — see §3 |
| Sound/music | Composer, sound design | `music-gen.js`, cue sheets, mix, ducking, LUFS, stems, M&E | **Covered** |
| Color | Resolve | `post-production.js`, LUTs, color match | **Partial** — no ACES/CDL round trip |
| Editorial / timeline | Premiere, Resolve | `nle-export.js` — FCPXML, EDL, Premiere XML | **Handoff only** — no in-app edit |
| Deliverables & QC | Baton, Aurora | `qa.js` (11 checks), acceptance rubric, `audio-deliverables.js` | **Partial** |
| Subtitles/localization | Subtitle Edit | `subtitles.js`, SRT/VTT | **Partial** — no dubbing |
| Marketing/credits | — | `marketing.js`, `credits.js`, title cards | **Covered** |
| Rights/licensing | Music supervision | `film_music_rights` | **Partial** — music only |
| Backup/archive | LTO, MAM | `backups.js`, `project-bundle.js` | **Covered** |
| Render management | Deadline, Tractor | per-type job tables, `pipeline.js` | **Gap** — no unified queue |
| Multi-user collaboration | All of them | none | **Absent** — known, documented |

## Part 2 — What AI Film Needs That Traditional Tools Never Had

The interesting half. These have no Movie Magic equivalent because the problem did not exist before.

| AI-native need | Film Engine | Verdict |
|---|---|---|
| Reproducibility of a generated result | `render_ledger` — seed, sampler, steps, guidance, model hashes, LoRAs, controlnets; locked vs creative modes | **Strong** |
| Subject identity consistency across shots | `consistency.js` — profiles with canonical reference/seed/voice, lock/unlock, per-shot and per-project readiness audit | **Strong** |
| Prompt as production document | Scene cards (YAML, schema-validated), prompt builders per modality | **Strong** |
| Model/provider abstraction | `providers.js` — capability→provider map per project, server-side credentials | **Strong** |
| Compute cost as the budget | `budget-estimate.js` + ledger | **Strong** |
| Generation job orchestration | `pipeline.js`, retry/backoff, pause/resume/cancel | **Good** |
| **Unified generation queue** | per-type tables only | **GAP — highest impact** |
| **AI provenance / disclosure** | nothing | **GAP — deadline-driven** |
| Take/select management | `film_shot_versions` | **Thin** |
| Prompt versioning & diff | ledger stores params, no prompt-level history/diff UI | **Thin** |
| Model drift tracking | model hashes recorded, no alerting on change | **Thin** |
| Synthetic performer likeness rights | nothing | **Gap** |

## Part 3 — Explicitly Not Needed (and why the vestiges should be relabeled)

The user's framing removes physical production. These traditional modules are correctly absent, and where a vestige exists it should be **relabeled rather than deleted**, because the underlying need survives in altered form:

- **Casting / talent management** → replaced by `characters.js` + `consistency.js`. A character is a reusable locked identity, not a role to fill.
- **Location scouting, permits, insurance** → replaced by `locations.js` as look-development. Nothing is scouted; a location is a look being held stable.
- **Props sourcing / art department** → `props.js` is a continuity register, not a purchasing system.
- **Crew, day-rates, unions, timecards** → gone entirely. Budget line items are tokens, video-seconds, and GPU-minutes.
- **Stripboard / day-out-of-days scheduling** → correctly reframed as `scheduling-engine.js`, which optimizes GPU model residency to reduce VRAM swapping. That is the real scheduling problem now.
- **Call sheets** → `call-sheets.js` exists but has no one to call. **Recommendation:** either drop it or repurpose it as a per-scene "generation run sheet" listing what will be produced, with what models, at what estimated cost.

## Part 4 — The Gaps That Matter, Ranked

### 1. No unified generation queue — highest impact, moderate effort

Jobs are tracked in six separate tables (`film_video_jobs`, `film_voice_jobs`, `film_music_jobs`, `film_lipsync_jobs`, `film_post_jobs`, `film_3d_jobs`) plus `film_pipeline_runs`, and only one listing endpoint exists across all of them (`GET /film/projects/:id/music/jobs`). There is no answer to *"what is running right now, what failed, what is it costing me?"*

For a production where every asset is a long-running async job, this is the screen an operator lives in. Its absence is felt more than any missing traditional feature. Suggested shape: `GET /film/projects/:id/jobs` unioning the job tables with a common projection (type, subject, status, started, duration, cost, error), plus a queue page with retry/cancel.

### 2. No AI provenance or disclosure metadata — urgent, deadline-driven

Nothing in the codebase writes C2PA Content Credentials or any AI-disclosure metadata into generated media.

**EU AI Act Article 50 transparency obligations take effect 2 August 2026** — eight days from this audit. Providers of systems generating synthetic audio, image, or video must mark outputs in a machine-detectable way as artificially generated. C2PA 2.1 (ratified 2025, now ISO/IEC 22144) is the de facto mechanism; the Code of Practice recommends pairing metadata with imperceptible watermarking.

Any film this engine outputs for EU distribution is in scope. Full conformance is a multi-month effort (signing pipeline, X.509 certificates from a CA on the C2PA Trust List, manifest repository, watermarking), so the realistic near-term move is: record generation provenance we already have — model, provider, prompt, seed, timestamp — as embedded sidecar metadata on every output, and surface a disclosure statement in the export package. We already capture nearly all of it in `render_ledger`; it just never reaches the file.

### 3. No in-app playback or timeline — high impact, high effort

You cannot watch your film inside the app. `film_shot_versions` stores thumbnails; there is no player, no scrubbing, no sequence playback. The only way to see the cut is to export to an NLE. For a tool whose entire output is moving pictures, the inability to watch them is a conspicuous hole — and it compounds gap 4.

### 4. Review is not timecoded — moderate impact, low effort

`film_shot_notes` has no timecode or frame column. Notes attach to a shot, not to a moment inside it. "The hand is wrong at 0:03" is the atomic unit of film feedback and Frame.io's core interaction; we cannot express it. Adding a nullable `timecode_ms` to notes is cheap; it only becomes useful once there is a player (gap 3), which is why these two should be planned together.

### 5. Take/select management is thin — moderate

Versions exist and can be A/B compared, but there is no "circle take" concept — no way to mark the chosen take, keep alternates, or assemble a selects reel. With generation, takes are effectively unlimited, which makes selection *more* important than in traditional production, not less.

### 6. Synthetic performer likeness rights — moderate, rising

`film_music_rights` covers music licensing. Nothing covers whether a generated character resembles a real person, whether a voice was cloned with consent, or what model licenses permit commercial use. As AI film moves toward distribution this becomes a standard deliverable question. Suggested shape: extend the rights concept from music-only to a general `film_rights` register covering characters, voices, and models.

### 7. Smaller items

- **Color:** no ACES/CDL round trip; LUT presets only.
- **Localization:** subtitles yes, dubbing/voice-cloned localization no — notable given we already have voice generation.
- **QC:** 11 checks and an acceptance rubric, but no broadcast-grade validation (loudness compliance report, colorspace conformance, dropped-frame detection).
- **Prompt history:** parameters are versioned; the prompt text itself has no diff view.
- **Multi-user collaboration:** absent and documented as such. Genuinely large (WebSocket + CRDT); correctly deferred.

## Part 5 — Recommended Order of Work

1. **Unified job queue** — biggest daily-use gain per unit of effort.
2. **Provenance metadata on outputs** — deadline-driven; partial credit is worth a lot here, and most of the data already exists in `render_ledger`.
3. **In-app player + timecoded notes** — plan together; the notes change is trivial and near-worthless without the player.
4. **Selects / circle takes** — small change, real workflow gain.
5. **General rights register** — extend music rights rather than building new.
6. **Relabel or repurpose call sheets** — cheap coherence fix.

## Part 6 — Onboarding and the Always-Available Guide

The second half of the request: a guide on first project open, and a full guide available at all times.

Implemented this milestone as a single `SECTION_GUIDE` registry in `src/index.html`, keyed by the `data-page` values already on the 24 nav buttons. One registry is the source for all five surfaces — first-open tour, persistent searchable guide, per-page contextual help, nav tooltips, and generated user documentation — so the copy cannot drift between them.

Design decisions worth recording:

- **The tour walks 12 sections, not 24.** A 24-step first-open tour gets dismissed. It follows the production spine — settings → screenplay → scenes → characters → consistency → shotboard → storyboard → videoshots → music → pipeline → budget → export — and the always-available guide covers the rest.
- **`settings` is first in the tour.** Frame rate and aspect ratio propagate into every downstream generation; changing them later means regenerating.
- **Each entry carries an optional `note`** — the "what people get wrong here" warning. Nine entries have one. These are rendered as callouts because they are the highest-value text in the registry: lock identity before batch generation, get the keyframe right before spending on video, the render ledger is your negative.
- **Each entry carries a `pro` field** naming the professional tool it stands in for, which lets the readiness view show coverage against this audit directly in the app.
- **Completeness is enforced, not assumed.** `auditSectionGuide()` checks that every `[data-page]` in the nav resolves to a registry entry and flags orphans, so a new page cannot ship undocumented.

## Sources

- [Top 10 Best Film Production Management Software of 2026](https://wifitalents.com/best/film-production-management-software/)
- [Top 10 Best Film Management Software of 2026](https://gitnux.org/best/film-management-software/)
- [Top 10 Best Video Production Management Software of 2026](https://zipdo.co/best/video-production-management-software/)
- [AI Content Provenance in Production: C2PA, Audit Trails, and the Compliance Deadline](https://tianpan.co/blog/2026-04-19-ai-content-provenance-c2pa)
- [AI Disclosure Compliance 2026: C2PA & EU AI Act Guide](https://aivideobootcamp.com/blog/ai-disclosure-compliance-2026-c2pa-eu-ai-act/)
- [C2PA Content Credentials: Cryptographic Provenance for AI-Generated Media in Production](https://www.systemshardening.com/articles/ai-landscape/c2pa-content-credentials/)
- [What is C2PA? Content Provenance Explained (2026)](https://c2paviewer.com/articles/what-is-c2pa)
