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

**EU AI Act Article 50 transparency obligations apply from 2 August 2026** — eight days from this audit. Article 50(2) of [Regulation (EU) 2024/1689](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=OJ%3AL_202401689) requires providers of AI systems generating synthetic audio, image, video, or text to mark outputs in a machine-readable format detectable as artificially generated or manipulated. The Commission's [Code of Practice on Transparency of AI-Generated Content](https://digital-strategy.ec.europa.eu/en/policies/code-practice-ai-generated-content) addresses implementation.

[C2PA Content Credentials](https://spec.c2pa.org/specifications/specifications/2.4/specs/C2PA_Specification.html) is the leading open mechanism — cryptographically signed manifests recording what produced an asset and what edited it.

**Separate the two kinds of claim below.** The effective date and the text of the obligation are matters of law, sourced above and verifiable directly. Everything that follows is an engineering read of what conformance would take, not legal advice — scope for a specific film should be confirmed with counsel.

Any film this engine outputs for EU distribution is plausibly in scope. Full C2PA conformance is a multi-month effort (signing pipeline, certificates, manifest handling, and likely watermarking alongside metadata, since metadata alone is strippable). The realistic near-term move is smaller and worth doing regardless: we already capture model, provider, prompt, seed, and timestamp in `render_ledger`, and none of it reaches the output file. Writing that provenance into embedded or sidecar metadata on every generated asset, plus a disclosure statement in the export package, is achievable now and is the foundation any later C2PA work would build on.

*Standards versions move quickly here — C2PA is at 2.4 as of this audit. Verify the current version and any ISO alignment against [spec.c2pa.org](https://spec.c2pa.org/) before implementing rather than trusting this document.*

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

Same numbering as Part 4, so the ranks agree wherever they appear — here, in Part 4, and in the app's readiness view.

1. **Unified job queue** — biggest daily-use gain per unit of effort.
2. **Provenance metadata on outputs** — deadline-driven; partial credit is worth a lot here, and most of the data already exists in `render_ledger`.
3. **In-app player** — the larger of the pair, and the one that unblocks the next item.
4. **Timecoded notes** — trivial on its own (a nullable `timecode_ms` on `film_shot_notes`) but near-worthless before item 3. Sequence them together; ship 3 first.
5. **Selects / circle takes** — small change, real workflow gain.
6. **General rights register** — extend music rights rather than building new.
7. **Smaller items** — including relabeling call sheets as generation run sheets, a cheap coherence fix. Multi-user collaboration sits here as correctly deferred, not as a ranked next step.

## Part 6 — Onboarding and the Always-Available Guide

The second half of the request: a guide on first project open, and a full guide available at all times.

Implemented this milestone as a single `SECTION_GUIDE` registry in `src/index.html`, keyed by the `data-page` values already on the 24 nav buttons. One registry is the source for four surfaces — the first-open tour, the persistent searchable guide, per-page contextual help, and the nav tooltips — so the copy cannot drift between them.

A fifth surface, generating `docs/user-guide.md` from the same registry, was designed but **not built**. The registry carries everything a generator would need; nothing consumes it that way yet. Treat it as available future work, not as shipped.

Design decisions worth recording:

- **The tour walks 12 sections, not 24.** A 24-step first-open tour gets dismissed. It follows the production spine — settings → screenplay → scenes → characters → consistency → shotboard → storyboard → videoshots → music → pipeline → budget → export — and the always-available guide covers the rest.
- **`settings` is first in the tour.** Frame rate and aspect ratio propagate into every downstream generation; changing them later means regenerating.
- **Each entry carries an optional `note`** — the "what people get wrong here" warning. Nine entries have one. These are rendered as callouts because they are the highest-value text in the registry: lock identity before batch generation, get the keyframe right before spending on video, the render ledger is your negative.
- **Each entry carries a `pro` field** naming the professional tool it stands in for, which lets the readiness view show coverage against this audit directly in the app.
- **Completeness is enforced, not assumed.** `auditSectionGuide()` checks that every `[data-page]` in the nav resolves to a registry entry and flags orphans, so a new page cannot ship undocumented.

## Sources

**Primary — regulatory and standards.** Every legal claim in §4.2 rests on these; verify against them rather than against this document.

- [Regulation (EU) 2024/1689 (the AI Act), consolidated text](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=OJ%3AL_202401689) — Article 50 is the operative transparency provision
- [Article 50, European Commission AI Act Service Desk](https://ai-act-service-desk.ec.europa.eu/en/ai-act/article-50)
- [Transparency obligations under Article 50 — Commission FAQ](https://digital-strategy.ec.europa.eu/en/faqs/transparency-obligations-under-article-50-ai-act)
- [Code of Practice on Transparency of AI-Generated Content — European Commission](https://digital-strategy.ec.europa.eu/en/policies/code-practice-ai-generated-content)
- [C2PA Technical Specification 2.4](https://spec.c2pa.org/specifications/specifications/2.4/specs/C2PA_Specification.html) and [C2PA specification index](https://spec.c2pa.org/)
- [Content Credentials white paper — C2PA](https://c2pa.org/wp-content/uploads/sites/33/2025/10/content_credentials_wp_0925.pdf)

**Secondary — market landscape.** Used only to confirm which tools are current in the production-management category (Part 1). No claim in this audit depends on them.

- [Film production management software roundup, 2026](https://wifitalents.com/best/film-production-management-software/)
- [Film management software roundup, 2026](https://gitnux.org/best/film-management-software/)
- [Video production management software roundup, 2026](https://zipdo.co/best/video-production-management-software/)

**Everything about Film Engine's own state** — route files, migrations, schema columns, endpoint counts — was verified directly against the repository at the commit this audit was written on, not taken from documentation.
