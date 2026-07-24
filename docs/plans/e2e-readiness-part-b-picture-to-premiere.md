# E2E Readiness Part B: Picture To Premiere

Scope: Codex-owned half of the short-film readiness audit: video generation, dialogue audio, lipsync, music/SFX/ambient, post, pipeline orchestration, subtitles, QA, asset registry, project bundle, and NLE/Premiere export.

Date: 2026-07-24

## Executive Verdict

Today, this half is **not turnkey end-to-end** from picture to Premiere, but it is materially closer after the follow-up media persistence fix.

It is **partially usable** if generation providers are configured. In the original audit, documented Gridlight JSON URL responses exposed a deterministic media persistence bug: video, music, and likely voice registered URLs instead of downloading local media. Commit `24adb67` ("Persist provider-generated media to local storage") fixed that class across the timeline path and normalized NLE file URLs. The UI exposes video, music, pipeline, and export pages, but assembly, packaging, export-button correctness, and project-wide workflow guidance remain incomplete.

The main remaining blocker is the last-mile editorial handoff as a product workflow. Film Engine still does not create a Premiere package that contains XML plus copied media with a preflight guarantee, and the pipeline assembly step is still only a marker. Scene-level music/ambient now lands on disk, but XML export still groups audio by `shot_id`, so scene-scoped audio is not placed as timeline lanes.

## Stage Rubric

| Stage | API reachable? | UI affordance exists? | Provider wiring | Auto-flow to next stage? | Verdict |
| --- | --- | --- | --- | --- | --- |
| Video clips from storyboard/keyframes | Yes; JSON URL media persistence fixed in `24adb67` | Yes: Video Shots page, Generate Video, Generate All Videos | Real provider adapter via `resolve('video')`, Gridlight default | Partial: lipsync/post require later actions | WORKS-WITH-MANUAL-STEPS |
| Dialogue voice | Yes; JSON URL media persistence fixed in `24adb67` | Partial: per-shot voice is available elsewhere in shot UI, but not in Video Shots page’s main batch flow | Real provider adapter via `resolve('voice')`; ElevenLabs tests exist; Gridlight default | Partial: creates `audio_dialogue`; lipsync must be invoked after video+voice | WORKS-WITH-MANUAL-STEPS |
| Lip-sync | Yes; JSON URL media persistence fixed in `24adb67` | Yes: per-shot Lip-sync button appears after video is complete | Real provider adapter via `resolve('lipsync')`, Gridlight fallback | Partial: creates `video_synced`; post/export discover it | WORKS-WITH-MANUAL-STEPS |
| Music score | Yes; JSON URL media persistence fixed in `24adb67` | Yes: Music & Sound page, per-scene and batch buttons | Real provider adapter via `resolve('music')`, Gridlight fallback | Partial: scene-level audio lands locally but is not placed in NLE timeline | PARTIAL |
| SFX | Yes: `/film/shots/:id/sfx/generate` | No obvious dedicated UI in Music & Sound or Video Shots batch flow | Real provider adapter via `resolve('sfx')`, Gridlight fallback | Partial: creates `audio_sfx`; no project-wide SFX UI batch | WORKS-WITH-MANUAL-STEPS |
| Ambient | Yes: `/film/scenes/:id/ambient/generate`, batch stream | Yes: Music & Sound page | Real provider adapter via `resolve('ambient')`, Gridlight fallback | Partial: scene-level `audio_ambient`; export only includes shot-linked audio | NEEDS-CREDENTIALS / PARTIAL |
| Post/upscale/color | Yes; JSON URL media persistence fixed in `24adb67` | Partial: Video Shots has per-shot Upscale only | Real provider adapter via `resolve('post')`, Gridlight fallback | Partial: creates `video_final`; export prefers final/synced/raw | WORKS-WITH-MANUAL-STEPS |
| Pipeline runner | Yes: `/film/shots/:id/pipeline/run/stream`, scene/project run routes | Yes: Pipeline page says "Run scene -> final" | Uses provider adapters, but sends minimal generic payloads | No: assembly step is a local marker, not an actual export/package | PARTIAL / RISKY |
| Subtitles | Yes: CRUD plus SRT/VTT export; music route also exports dialogue-derived SRT | Export page has SRT download, but points to `/export/srt` which is not handled by NLE export route | Local generation/parsing, no provider needed | Manual export | PARTIAL |
| QA gate | Yes: project/scene/shot QA routes | No clear mainline UI surfaced in this half | Local checks, no provider needed | Manual | WORKS-WITH-MANUAL-STEPS |
| Premiere XML / FCPXML | Yes: `/film/projects/:id/export/premiere`, `/fcpxml`; file URL formatting fixed in `24adb67` | Yes: Export page and Send to Premiere button | Local XML generation | Manual download; no media package or full preflight | WORKS-WITH-MANUAL-STEPS / RISKY |
| EDL | Yes: `/film/projects/:id/export/edl` | Yes: Export page | Local text edit-list generation | Manual media conform in Premiere | WORKS-WITH-MANUAL-STEPS |
| FDX screenplay export | API route exists but live run returns 500 for every project | Export page advertises FDX | Local XML generation, then registry insert fails | No output reaches user | BLOCKED |
| Project bundle | Yes: `/film/projects/:id/bundle` | Yes: bundle download function exists | Local tar.gz export | Manual; separate from NLE exports | WORKS-WITH-MANUAL-STEPS |

## Evidence

Pipeline orchestration exists and defines a 9-step order in `backend/lib/pipeline-engine.js`. The route runner in `backend/routes/pipeline.js` dispatches every step through provider adapters, but `executeStep()` handles assembly as `{ ok: true, message: 'Assembly step: use export endpoints to finalize' }` and sends a minimal payload: `{ shot_id, scene_id, project_id, step }`. That proves orchestration status can complete, but not that the rich generation payloads used by the standalone routes are exercised.

Standalone generation routes build richer payloads than the pipeline runner:

- `backend/routes/video-gen.js` builds a real video payload from the scene card, characters, location, style, keyframe, and consistency refs, then creates `video_raw` asset rows.
- `backend/routes/voice.js` extracts dialogue from the shot scene card, builds per-line voice payloads, and creates `audio_dialogue` asset rows.
- `backend/routes/lipsync.js` requires existing `video_raw` and `audio_dialogue` assets, then creates `video_synced`.
- `backend/routes/music-gen.js` creates scene-level `audio_music` and `audio_ambient`, shot-level `audio_sfx`, audio mixes, stem payloads, and dialogue-derived SRT.
- `backend/routes/post-production.js` prefers synced over raw video and creates `video_final`.
- `backend/routes/qa.js` and `backend/lib/qa-checker.js` check keyframe/video/dialogue/lipsync/music/ambient/timeline readiness.

The UI has a path, but it is not a one-click path:

- `src/index.html` has Video Shots with Generate All Videos, per-shot Lip-sync, per-shot Upscale, and Send to Premiere.
- `src/index.html` has Music & Sound with Generate All score plus ambient.
- `src/index.html` has Pipeline with live shot, scene, and project run controls.
- `src/index.html` has Export downloads for FCPXML, EDL, Premiere XML, SRT, and FDX, but SRT points at an unsupported `/export/srt` route and FDX 500s because of an asset-type constraint.

## Gridlight Media Persistence And Premiere Handoff Findings

Status: the media persistence and file URL formatting bugs in this section were fixed by `24adb67`. The section remains because it documents what the audit found and why the fix mattered. The remaining issue is that Film Engine still lacks a packaged, preflighted Premiere handoff.

`backend/lib/gridlight-client.js:199-206` returns a parsed object whenever the provider response `Content-Type` includes `application/json`, and returns a `Buffer` only for non-JSON responses. `GRIDLIGHT_API_REFERENCE.md` documents POST generation endpoints as JSON URL responses: `/image` returns `image_urls`, `/video` returns `video_url`, and `/music` returns `audio_url`. The binary responses in the API reference are the subsequent serving endpoints such as `GET /images/:filename`, not the POST generation calls.

Storyboard is the working exception. `backend/routes/storyboard.js:115-131` resolves the returned image URL, fetches it, converts the response to a Buffer, and saves that Buffer to Film Engine storage.

Video, music, and voice do not follow that pattern:

`backend/lib/nle-export.js` emits `<pathurl>file:///${videoAsset.file_path}</pathurl>` for Premiere XML and `src="${videoAsset.file_path}"` for FCPXML. It does not normalize missing paths, API URLs, remote provider URLs, or relative filenames.

Generation routes do not all populate `file_path` the same way:

- Sync single-shot routes save provider buffers to disk only when `Buffer.isBuffer(result.data)` is true.
- Against documented Gridlight JSON URL responses, single-shot video and music store remote URLs as `file_path`; voice has the same code path.
- Several stream/batch paths initialize `filePath = filename` or insert assets with `file_name` only unless a Buffer arrives.
- NLE export does not fall back to `getFilePath()` or `getFileUrl()` when `file_path` is empty.

Measured values from real Film Engine pointed at a mock gateway returning the documented Gridlight shapes:

```text
storyboards/  1 file   file_path=/<abs>/storyboards/<project>/SC01-SH01.png
video/        0 files  file_path=http://localhost:8080/videos/vid_abc123.mp4
music/        0 files  file_path=http://localhost:8080/music/audio_abc123.wav
audio/        0 files
```

`POST /shots/:id/video/generate` returned `{"status":"complete","video_url":"/film/video/<project>/SC01-SH01.mp4"}`, but `GET` on that same Film Engine URL returned HTTP 404 because no local file had been written. Voice was not measured in this run because the demo shot had no dialogue; it is called out from identical code at `backend/routes/voice.js:151-154`.

This was tested against the documented Gridlight contract, not Manny's exact local build. If a local Gridlight endpoint returns inline binary for a specific generation call, that endpoint would take the working Buffer branch; a quick run against the real service can settle which endpoints behave that way.

The Premiere XML export can therefore be structurally valid but editorially unusable. Live reproduction showed these failure shapes:

- No media assets, as in the demo project: clipitems are emitted with correct names and timing, but no `<file>` or `<pathurl>` elements at all.
- Batch video path, used by the primary **Generate All Videos** UI flow: `backend/routes/video-gen.js:335` sets `let filePath = filename`, only replacing it for inline buffers. Provider URL responses therefore become filename-only assets and export as `file:///1A.mp4`.
- Single-shot path: `backend/routes/video-gen.js:160-165` stores `result.data.video_url` directly when the provider returns a URL, and NLE export wraps that as `file:///https://...`.
- Single-shot music path: `backend/routes/music-gen.js:176-179` stores `result.data.audio_url` directly when the provider returns a URL; batch music at `:440-441` stays filename-only unless a Buffer arrives.
- Voice path, inferred from code: `backend/routes/voice.js:151-154` stores `result.data.audio_url` directly when present; batch voice at `:358-359` stays filename-only unless a Buffer arrives.
- Stitch path: `backend/routes/video-gen.js:497-499` can leave `filePath` empty when no buffer is returned, producing `file:///`.

The through-line before `24adb67` was that generation could return success while media was not local, and XML export emitted whatever was in `file_path`, or nothing when no asset existed. It was correct only by accident, when the asset happened to have been saved to a real absolute path, and it never failed loudly.

Commit `24adb67` added `backend/lib/provider-media.js` and routed provider-returned media through it across `video-gen`, `voice`, `music-gen`, `lipsync`, `post-production`, `characters`, and `locations`. It also fixed NLE URL formatting in `backend/lib/nle-export.js`, including the four-slash `file:////private/...` shape that surfaced once `file_path` became a real absolute POSIX path, and changed FCPXML from bare paths to file URLs.

Two additional bugs were found and fixed in that same commit:

- `locations.js` handled `image_url`, but documented Gridlight `/image` returns `image_urls`, so location/prop reference image paths could be stored empty.
- `characters.js` refsheet generation inserted a `render_ledger` row with unsupported `step='refsheet'` and a character id in `shot_id`, causing a CHECK/FK failure that could crash the server. The fix removed that duplicate ledger write and relies on `film_refsheet_jobs`.

The remaining known instance of this provider URL pattern is `threed.js` model URL handling, which was deliberately left for a separate pass because it has async job-handoff behavior.

Scene-level audio is also underrepresented in NLE exports. FCPXML/Premiere XML group assets by `shot_id`, but music and ambient generation stores those assets with `scene_id`; those scene-level score/ambient files are not placed as timeline audio lanes unless separately attached to shots.

Export packaging is separate. `backend/lib/project-bundle.js` includes `storyboards`, `audio`, `video`, `music`, and `refsheets`, and `24adb67` makes those folders more likely to contain the generated media. `/export/premiere` still only downloads XML. There is no "Premiere package" that writes XML plus media together with relative paths and preflighted relink guarantees.

FDX export is also broken live. `backend/routes/nle-export.js:168` calls `registerExportAsset(projectId, 'fdx', ...)`, but `fdx` is absent from the `film_assets.asset_type` CHECK constraint in `backend/db/migrations/015_film_assets.sql`. The XML is generated and then the registry insert throws `SQLITE_CONSTRAINT_CHECK`, so the user receives a 500 instead of a file. This likely needs the same style of workaround used by 3D assets: register a permitted type such as `other` or `export_package` with metadata, or safely widen the asset-type constraint.

## What Works Today

With providers configured, a user can generate individual or batched video clips, dialogue audio, lip-sync selected shots, generate scene score/ambient, run some post steps, download XML/EDL/FCPXML, and export a project bundle. After `24adb67`, documented Gridlight JSON URL responses land locally for the main timeline media path.

One positive live finding: the EDL export is usable today for edit structure. On the demo project it produced correct title, non-drop-frame mode, event timecodes, clip names, and scene comments. EDL does not carry media paths like XML, so it sidesteps the pathurl bug and can be used to conform media manually in Premiere.

The automated tests for this slice passed during the original audit:

```text
node --test tests/video-gen.test.js tests/providers-elevenlabs.test.js tests/music-gen.test.js tests/nle-export.test.js tests/pipeline-engine.test.js tests/pipeline-e2e.test.js tests/project-bundle.test.js tests/audio-mixer.test.js tests/subtitle-generator.test.js tests/qa-checker.test.js
224 passing, 0 failing
```

The tests prove the backend plumbing works against mocks, including video/music generation, NLE XML generation, a mock 9-step pipeline, project bundle round trip, audio mixer, subtitles, QA checker, and ElevenLabs provider behavior.

Important original caveat: the NLE and generation tests did **not** prove editor-usable paths or production-shaped Gridlight persistence. `backend/tests/nle-export.test.js:38-42` used fixture assets with pre-valid absolute paths such as `/data/shot1.mov`, and the path assertion at `:322-324` only checked that the XML contained `<pathurl>file:///`. That passed for both `file:///1A.mp4` and `file:///https://...`. `backend/tests/video-gen.test.js:72-73` mocked Gridlight as `Content-Type: video/mp4` binary with `FAKE-MP4-DATA`, then asserted the generated Film Engine file served successfully. Documented Gridlight POST generation returns JSON, so that test validated a branch that did not run for the default provider contract.

Post-fix verification for `24adb67`: full suite 669 passing, 0 failing. The new video generation tests include documented JSON URL responses, assert that media lands on disk with an absolute `file_path`, assert that the returned `/film/video/...` URL serves without 404, and assert that unstorable media fails with 502 instead of reporting success.

## What Is Missing For "Do It Today End To End"

1. **Reliable Premiere package**: generate XML plus copied media in one folder/archive, with relative paths that Premiere can relink.
2. **Export preflight**: reject unresolved/missing assets before download and report exactly what is missing.
3. **Pipeline runner uses real route payloads**: today the live pipeline can mark steps complete via generic provider calls without producing the same assets as the standalone endpoints.
4. **Assembly step is not assembly**: it does not generate a timeline, package media, or trigger export. It only tells the user to use export endpoints.
5. **Scene-level audio timeline placement**: generated score and ambient are scene assets, but NLE export expects shot-linked audio assets.
6. **SFX UI/batch gap**: the backend can generate SFX per shot; the current main Music & Sound UI does not expose a clear SFX generation pass.
7. **Voice/lipsync/post UX gap**: available mostly as per-shot actions rather than a guided project-wide "dialogue -> lipsync -> final video" flow.
8. **Subtitle export mismatch**: Export page calls `/export/srt`, but `backend/routes/nle-export.js` supports `fcpxml`, `edl`, `premiere`, and `fdx`; SRT lives in subtitles/music routes.
9. **FDX export 500s**: the route registers unsupported `asset_type='fdx'` and trips the `film_assets` CHECK constraint.
10. **QA is not a hard gate**: QA exists but does not block export or warn at the Send to Premiere button.
11. **Remaining provider URL audit**: `threed.js` still has model URL handling that was not changed in `24adb67`.

## Shortest Path To Turn This Into A Real Same-Day Workflow

1. Add an export/package endpoint for Premiere: create a staging folder with XML, `video/`, `audio/`, `music/`, `storyboards/`, and a manifest; rewrite XML paths to relative `file://localhost/...` or plain package-relative paths compatible with Premiere relink.
2. Add an export preflight that verifies every XML media reference resolves to an existing local file before download.
3. Make the pipeline assembly step call the export/package logic or at least create an `export_package` asset.
4. Attach scene-level score/ambient to timeline ranges during export, instead of only shot-linked assets.
5. Expose SFX, project-wide voice, project-wide lipsync, project-wide post, QA, and export preflight in the UI as a guided checklist.

## Bottom Line For This Half

For picture-to-Premiere, the honest answer is: **you can exercise and generate most pieces today, but you should not trust it as a complete end-to-end short-film engine yet**. After `24adb67`, the main generated media path persists locally against the documented Gridlight contract. The automated pipeline and Premiere XML/FCPXML handoff still are not robust enough to promise a finished, editor-ready package. The practical same-day workaround remains EDL or XML plus manual conform/relink in Premiere, not a turnkey package.
