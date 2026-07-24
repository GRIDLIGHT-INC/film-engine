# E2E Short-Film Readiness

Date: 2026-07-24

Question: could a creator start today with a novel scene, convert it into a screenplay in Film Engine, generate storyboards, generate video with dialogue, create music/SFX, and send the result to Premiere for editing?

## Short Answer

**No, not end to end today with the user's own material.**

The user can convert a scene to a screenplay and extract scenes offline. With the Gridlight gateway running, they can likely generate shots, storyboards, video, dialogue audio, music, lip-sync outputs, and post-processed clips. A follow-up fix, `24adb67` ("Persist provider-generated media to local storage"), now downloads documented Gridlight URL responses into local Film Engine storage across timeline media routes and normalizes NLE file URLs. Without Gridlight, there is no path from their screenplay to shots in the UI, though they **can** load the bundled demo project and exercise the downstream pipeline against prebuilt scenes/shots.

But the full creator promise fails at both ends:

1. **Front of pipeline:** without Gridlight, there is no manual shot-creation UI for the user's own screenplay. The user can get a screenplay and scenes, but cannot create shots from that story in the app.
2. **Back of pipeline:** media persistence and file URL formatting were fixed in `24adb67`, but the app still lacks a reliable "Premiere package" flow that bundles XML plus copied media, preflights every referenced file, and places scene-level music/ambient on the NLE timeline.
3. **Status layer:** `/film/providers` reports Gridlight as `connected:true` even when the gateway is down, so the app tells the user they are ready when the workflow cannot run.

So the honest answer is: **yes for evaluating the engine with the bundled demo or a supervised Gridlight-backed run; close but still not turnkey for reliably making a same-day short film from the user's own novel scene and finishing it in Premiere.** Media now lands locally for the main timeline path, but assembly, packaging, export-button correctness, and workflow gating still need work before the engine can promise an end-to-end finish.

## Evidence Base

Claude performed a live run on a scratch database with `backend/server.js` at `PORT=3199`, no Gridlight gateway, and no provider keys. Failures in the story-to-picture half are backed by actual HTTP responses. Claims about what would work once Gridlight is running are code-path inference plus route/UI evidence.

Codex audited the picture-to-Premiere half and ran the focused backend test slice:

```text
node --test tests/video-gen.test.js tests/providers-elevenlabs.test.js tests/music-gen.test.js tests/nle-export.test.js tests/pipeline-engine.test.js tests/pipeline-e2e.test.js tests/project-bundle.test.js tests/audio-mixer.test.js tests/subtitle-generator.test.js tests/qa-checker.test.js
224 passing, 0 failing
```

Claude then live-tested Codex's central Premiere-path finding against the scratch project and reproduced it. After Manny clarified that Gridlight is local and easy to run, Claude also tested Film Engine against a mock gateway shaped like `GRIDLIGHT_API_REFERENCE.md`: generation endpoints returned JSON URLs, not binary. That stronger test showed video and music return success while writing no local media files; voice followed the same code path but was not measured because the demo shot used in that run had no dialogue.

Post-audit update: commit `24adb67` fixed that media persistence class across `video-gen`, `voice`, `music-gen`, `lipsync`, `post-production`, `characters`, and `locations`, added shared `backend/lib/provider-media.js`, normalized NLE file URLs in `backend/lib/nle-export.js`, and added regression coverage in `backend/tests/video-gen.test.js`. Claude verified the full chain against the documented-shape gateway: `video_raw`, `video_final`, `audio_music`, storyboards, character sheets, and reference images landed on disk with absolute paths; `/film/video/...` playback returned 200; Premiere XML `<pathurl>file:///private/.../SC01-SH01.mp4</pathurl>` resolved to an existing file. Full suite after the fix: 669 passing, 0 failing.

## Readiness Matrix

| Stage | API reachable? | UI affordance exists? | Provider wiring | Auto-flow to next stage? | Verdict |
| --- | --- | --- | --- | --- | --- |
| Novel prose -> screenplay | Route exists; needs Gridlight `/chat/intelligent` | Yes: Convert UI is strong | Gridlight-only; no LLM provider capability | Yes, once converted | NEEDS-SERVICE |
| Bring-your-own Fountain | Yes | Yes: Import/editor | No provider needed | Yes: scenes extracted | WORKS |
| Screenplay -> scenes | Yes | Yes | No provider needed | Yes | WORKS |
| Scenes -> shots | API exists | No manual Add Shot UI for the user's own script; only AI breakdown UI | Gridlight-only for user content | Yes if breakdown works | BLOCKED in UI without Gridlight |
| Character/location registry | Yes | Yes, manual | Image refs can use provider registry | Not auto-populated from script | WORKS-WITH-MANUAL-STEPS |
| Storyboards | Route exists | Yes | Gridlight-only; bypasses image provider registry | Yes to video stage if shots exist | NEEDS-SERVICE |
| Video clips | Yes; JSON URL media persistence fixed in `24adb67` | Yes: Video Shots page | Provider registry via `resolve('video')` | Partial: lipsync/post are manual | WORKS-WITH-MANUAL-STEPS |
| Dialogue voice | Yes; JSON URL media persistence fixed in `24adb67` | Partial project-level UX | Provider registry via `resolve('voice')` | Partial: lipsync must be invoked | WORKS-WITH-MANUAL-STEPS |
| Lip-sync | Yes; JSON URL media persistence fixed in `24adb67` | Per-shot action | Provider registry via `resolve('lipsync')` | Partial: post/export can find synced video | WORKS-WITH-MANUAL-STEPS |
| Music score / ambient | Yes; JSON URL media persistence fixed in `24adb67` | Yes for score+ambient | Provider registry via `resolve('music')` / ambient | Partial: media lands locally, but scene-level audio is not placed in NLE timeline | PARTIAL |
| SFX | Yes | No clear main UI pass | Provider registry via `resolve('sfx')` | Partial: per-shot only | WORKS-WITH-MANUAL-STEPS |
| Post/upscale/color | Yes; JSON URL media persistence fixed in `24adb67` | Partial: per-shot Upscale | Provider registry via `resolve('post')` | Partial | WORKS-WITH-MANUAL-STEPS |
| Pipeline runner | Yes | Yes: "Run scene -> final" | Provider registry, but generic payloads | No: assembly is only a marker | PARTIAL / RISKY |
| QA | Yes | Not surfaced as a hard gate | Local | Manual | WORKS-WITH-MANUAL-STEPS |
| Premiere XML / FCPXML | Routes return 200; file URL formatting fixed in `24adb67` | Yes | Local XML generation | Manual, no media package or full preflight | WORKS-WITH-MANUAL-STEPS / RISKY |
| EDL | Route returns 200 | Yes | Local text edit-list generation | Manual media conform in Premiere | WORKS-WITH-MANUAL-STEPS |
| FDX | Route exists but returns 500 | UI advertises it | Local XML generation then registry failure | No output | BLOCKED |
| SRT | Subtitle routes exist | Export page points to wrong route | Local | Manual | PARTIAL / UI BROKEN |
| Project bundle | Yes | Yes | Local tar.gz | Separate from NLE XML | WORKS-WITH-MANUAL-STEPS |

## Highest-Impact Findings

### F1: Provider Readiness Lies

`GET /film/providers` reports Gridlight as connected even when `localhost:8080` refuses connections. In `backend/routes/providers.js`, providers that do not require a key get:

```js
{ set: true, last4: null, fields: {}, connected: true }
```

The Gridlight adapter already has `health()`, but the catalog route does not call it. This is the first thing to fix because it hides every downstream failure.

### F2: No Manual Shot Creation UI

The UI has screenplay, scenes, shotboard, storyboard, and pipeline pages, but no manual "Add Shot" path for the user's own screenplay. Searches for `New Shot`, `Add Shot`, `addShot(`, and `createShot` in `src/index.html` found no manual creator. The only creator-facing path from a user's scenes to shots is AI breakdown through Gridlight `/chat/intelligent`.

That means a fresh install with no Gridlight can create projects, scripts, and scenes, but cannot produce the shots required by storyboards, video, voice, QA, or NLE export for that user's story. One offline exception matters: **Load Demo Project** (`src/index.html:4919` -> `POST /film/projects/demo` -> `backend/routes/demo-project.js:554`) inserts 14 shots directly with no AI, so the downstream pipeline can be exercised and evaluated offline. It just does not turn the user's novel excerpt into shots.

### F3: Gridlight Media Persistence Was Broken; Handoff Is Still Not Turnkey

Status: the media persistence and file URL formatting bugs below were fixed in `24adb67`. The remaining handoff gap is product/workflow reliability: no packaged Premiere export with XML plus copied media, no full export preflight, and scene-level music/ambient still are not placed as NLE timeline audio because export groups audio by `shot_id`.

`callGridlight()` parses `application/json` responses into objects and only returns a `Buffer` for non-JSON responses (`backend/lib/gridlight-client.js:199-206`). `GRIDLIGHT_API_REFERENCE.md` documents generation endpoints as JSON URL responses: `/image` returns `image_urls`, `/video` returns `video_url`, and `/music` returns `audio_url`; the binary endpoints are the later serving URLs.

Storyboard generation handles that correctly: `backend/routes/storyboard.js:111-131` fetches the returned image URL and saves the bytes. Video, music, and voice do not. They only call `saveFile()` when `Buffer.isBuffer(result.data)` is true, which is not the documented Gridlight generation shape.

Measured against a documented-shape mock Gridlight gateway:

```text
storyboards/  1 file on disk   file_path=/abs/path/SC01-SH01.png
video/        0 files          file_path=http://localhost:8080/videos/vid_abc123.mp4
music/        0 files          file_path=http://localhost:8080/music/audio_abc123.wav
```

`POST /shots/:id/video/generate` still returned `status:"complete"` and a Film Engine URL such as `/film/video/<project>/SC01-SH01.mp4`, but `GET` on that URL returned 404 because the file was never written.

Voice was not measured in that mock run because the demo shot had no dialogue, but `backend/routes/voice.js:151-154` has the identical JSON-URL storage pattern.

This was tested against the documented Gridlight contract, not Manny's exact local build. If a local Gridlight endpoint returns inline binary for a specific generation call, that endpoint would take the working Buffer branch; a quick run against the real service can settle which endpoints behave that way.

NLE export then emits raw `asset.file_path` into XML. Live reproduction produced:

```xml
<pathurl>file:///1A.mp4</pathurl>
<pathurl>file:///https://cdn.provider.com/gen/abc123.mp4</pathurl>
```

and FCPXML:

```xml
src="1A.mp4"
```

A demo-project export found a third failure shape: when shots have no media assets, Premiere XML still emits 14 correctly named and timed `clipitem` elements, but with **zero** `<file>` or `<pathurl>` elements. That gives the editor a cut structure but no media references at all.

The root causes are in generation and export:

- `backend/routes/video-gen.js:335` uses `let filePath = filename` in the batch path, which backs the primary **Generate All Videos** UI.
- `backend/routes/video-gen.js:160-165` stores remote `result.data.video_url` directly for single-shot generation.
- `backend/routes/music-gen.js:176-179` stores remote `result.data.audio_url` directly for single-scene music, and `:440-441` leaves batch music as filename-only unless a Buffer arrives.
- `backend/routes/voice.js:151-154` stores remote `result.data.audio_url` directly for single-shot voice, and `:358-359` leaves batch voice as filename-only unless a Buffer arrives.
- `backend/routes/video-gen.js:497-499` can leave stitched video `filePath` empty.
- `backend/lib/nle-export.js:342` and `:520` emit `file_path` raw with no fallback or validation.

The through-line before `24adb67`: generation returned success while media was not local, and XML export emitted whatever was in `file_path`, or nothing when no asset existed. It was correct only by accident, when the asset happened to have been saved to a real absolute path, and it never failed loudly.

The original NLE and generation tests did not catch this. NLE fixtures used absolute paths and only asserted that `<pathurl>file:///` exists. `backend/tests/video-gen.test.js:72-73` mocked Gridlight as `Content-Type: video/mp4` binary and `FAKE-MP4-DATA`, then asserted the generated Film Engine file served successfully. Real documented Gridlight generation returns JSON, so those tests validated the branch that did not run for the default provider shape. Commit `24adb67` added JSON URL mock coverage and asserts local file persistence plus non-404 playback.

The same fix also caught two consistency-reference issues. `locations.js` looked for `image_url`, but documented Gridlight `/image` returns `image_urls`, so location/prop reference image paths could be stored empty. `characters.js` refsheet generation inserted a `render_ledger` row with unsupported `step='refsheet'` and a character id in `shot_id`, causing CHECK/FK failures that could crash the server. Both were fixed in `24adb67`. This is the same schema-enum fragility family as the FDX `asset_type` failure.

### F4: Pipeline "Assembly" Is Not Assembly

`backend/routes/pipeline.js` defines a 9-step runner, but `executeStep()` sends generic payloads like `{ shot_id, scene_id, project_id, step }` rather than calling the rich standalone route payload builders. The `assembly` step returns a message telling the user to use export endpoints; it does not create a package, timeline, or editor-ready output.

### F5: Multi-Provider Story Is Incomplete

There is no `text` or `llm` capability in the provider layer, so prose conversion, screenplay AI, and breakdown are Gridlight-only. Storyboard generation also bypasses `resolve('image')` and calls `${GRIDLIGHT_URL}/image` directly, while character/location reference image routes do use the image provider registry. An OpenAI image key can help with references, but not storyboards.

### F6: Export Buttons Overpromise

FDX export 500s for every project because `backend/routes/nle-export.js:168` registers `asset_type='fdx'`, but the `film_assets` CHECK constraint allows `fcpxml`, `edl`, and `premiere_xml`, not `fdx`.

The Export page also points SRT download at `/export/srt`, but `backend/routes/nle-export.js` only supports `fcpxml`, `edl`, `premiere`, and `fdx`; SRT lives under subtitle/music routes.

### F7: Silent Data Traps

`POST /script` ignores `format:'fountain'` when the screenplay is sent in `content`; it only treats `body.fountain_content` as Fountain. A user can send Fountain text and get a stored plaintext script with empty `fountain_content`, zero scene stats, and broken downstream screenplay exports.

Scene-card validation accepts unknown keys such as `lighting.style`, but prompt builders read `lighting.type` and `lighting.notes`. The value is stored and then silently omitted from generated prompts.

Character/location names parsed from scripts are not promoted into the registries used by consistency and generation. The audit can still return `ready:true` with warnings, which is misleading for character consistency.

## What Works

The foundation is real:

- Project creation, script versioning, Fountain parsing, scene extraction, and screenplay statistics work offline.
- The prose conversion UI is purpose-built and supports chunking, context overlap, progress, and ETA.
- The built-in **Load Demo Project** path works offline and creates a populated project with 7 scenes, 14 shots, 4 characters, 4 locations, 8 props, 3 acts, and 5 milestones. This is the best current way to evaluate the downstream pipeline without Gridlight, but it is not a path from the user's own story to shots.
- The backend has standalone routes for video, voice, lipsync, music, SFX, ambient, post, subtitles, QA, NLE export, and project bundles. After `24adb67`, documented Gridlight URL responses persist locally for the main timeline media path.
- Focused backend tests for the picture-to-Premiere half pass against mocks.
- FCPXML, EDL, and Premiere endpoints return 200 on a real project, but only EDL verified as usable because it carries edit structure without depending on broken media paths.
- The **EDL export is usable today** for edit structure. On the demo project it produced correct title, non-drop-frame mode, event timecodes, clip names, and scene comments. EDL does not carry media paths like XML, so it sidesteps the broken pathurl class and can be used to conform media manually in Premiere.

## What Is Missing To Make The Answer "Yes"

1. **Real provider health checks** in `/film/providers`, especially for Gridlight.
2. **Manual shot creation UI** so breakdown is not a hard dependency.
3. **LLM provider capability** for prose conversion, breakdown, and screenplay assistant, or clear Gridlight-only labeling.
4. **Storyboard provider routing** through the image provider registry.
5. **NLE export preflight**: reject unresolved assets before download and report exactly which shots/audio lanes are missing.
6. **Premiere package export**: XML plus copied media in one archive/folder with relative paths.
7. **Real assembly step** in the pipeline that creates a timeline/package asset.
8. **Scene-level audio timeline placement** so music and ambient generated by scene appear in NLE exports.
9. **Project-wide guided flow** for voice, lipsync, post, SFX, QA, and export preflight.
10. **FDX/SRT export fixes** so advertised delivery buttons actually work.
11. **Silent data-loss fixes** for script format handling and scene-card unknown keys.
12. **Remaining provider URL audit** for `threed.js`, which still has model URL handling that was not changed in `24adb67`.

## Practical Answer For Manny

If you start today on a clean machine and expect the Film Engine itself to carry you from your novel excerpt to a Premiere-ready edit package, **no**.

If you load the bundled demo project, you can inspect and exercise much of the downstream workflow today without Gridlight. If you start Gridlight, know which routes/UI steps to use, and accept manual intervention, you can produce screenplay structure, shots, storyboards, timeline media, and local playback for your own story. After `24adb67`, the thing most likely to fail is no longer "the generated media was never written locally"; it is the lack of a true guided assembly/export package that proves every needed asset is present and hands Premiere XML plus media over together.

The practical same-day workaround is **EDL, not Premiere XML**. Use EDL to get the cut structure into Premiere, then conform/relink media manually. That is not the promised end-to-end workflow, but it is the one export path that verified cleanly today.

The shortest credible path to "yes" is not a new generation model. It is reliability work around orchestration and handoff: add truthful provider status, manual shot creation, real pipeline assembly, export preflight, scene-level audio placement, and a Premiere package that proves every referenced file exists before download.

## Source Slice Reports

- Part A: `docs/plans/e2e-readiness-part-a-story-to-picture.md`
- Part B: `docs/plans/e2e-readiness-part-b-picture-to-premiere.md`
