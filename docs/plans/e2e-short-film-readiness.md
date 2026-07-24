# E2E Short-Film Readiness

Date: 2026-07-24

Question: could a creator start today with a novel scene, convert it into a screenplay in Film Engine, generate storyboards, generate video with dialogue, create music/SFX, and send the result to Premiere for editing?

## Short Answer

**No, not end to end today with the user's own material.**

The user can convert a scene to a screenplay and extract scenes offline. With the Gridlight gateway running, they can likely generate shots and storyboards. But the video/audio generation routes do not download documented Gridlight URL responses into Film Engine storage, so generated videos, music, and likely voice audio do not become reliable local assets. Without Gridlight, there is no path from their screenplay to shots in the UI, though they **can** load the bundled demo project and exercise the downstream pipeline against prebuilt scenes/shots.

But the full creator promise fails at both ends:

1. **Front of pipeline:** without Gridlight, there is no manual shot-creation UI for the user's own screenplay. The user can get a screenplay and scenes, but cannot create shots from that story in the app.
2. **Back of pipeline:** for documented Gridlight responses, video/audio routes store remote URLs or filename-only paths instead of local files. In-app playback links can 404, project bundles have no generated media to copy, and Premiere/FCPXML writes invalid or absent media references.
3. **Status layer:** `/film/providers` reports Gridlight as `connected:true` even when the gateway is down, so the app tells the user they are ready when the workflow cannot run.

So the honest answer is: **yes for evaluating the engine with the bundled demo or a supervised Gridlight-backed run; no for reliably making a same-day short film from the user's own novel scene and finishing it in Premiere.** Storyboards are the one generated asset class verified to land correctly because `storyboard.js` fetches the returned image URL and saves the bytes.

## Evidence Base

Claude performed a live run on a scratch database with `backend/server.js` at `PORT=3199`, no Gridlight gateway, and no provider keys. Failures in the story-to-picture half are backed by actual HTTP responses. Claims about what would work once Gridlight is running are code-path inference plus route/UI evidence.

Codex audited the picture-to-Premiere half and ran the focused backend test slice:

```text
node --test tests/video-gen.test.js tests/providers-elevenlabs.test.js tests/music-gen.test.js tests/nle-export.test.js tests/pipeline-engine.test.js tests/pipeline-e2e.test.js tests/project-bundle.test.js tests/audio-mixer.test.js tests/subtitle-generator.test.js tests/qa-checker.test.js
224 passing, 0 failing
```

Claude then live-tested Codex's central Premiere-path finding against the scratch project and reproduced it. After Manny clarified that Gridlight is local and easy to run, Claude also tested Film Engine against a mock gateway shaped like `GRIDLIGHT_API_REFERENCE.md`: generation endpoints returned JSON URLs, not binary. That stronger test showed video and music return success while writing no local media files; voice follows the same code path but was not measured because the demo shot used in that run had no dialogue.

## Readiness Matrix

| Stage | API reachable? | UI affordance exists? | Provider wiring | Auto-flow to next stage? | Verdict |
| --- | --- | --- | --- | --- | --- |
| Novel prose -> screenplay | Route exists; needs Gridlight `/chat/intelligent` | Yes: Convert UI is strong | Gridlight-only; no LLM provider capability | Yes, once converted | NEEDS-SERVICE |
| Bring-your-own Fountain | Yes | Yes: Import/editor | No provider needed | Yes: scenes extracted | WORKS |
| Screenplay -> scenes | Yes | Yes | No provider needed | Yes | WORKS |
| Scenes -> shots | API exists | No manual Add Shot UI for the user's own script; only AI breakdown UI | Gridlight-only for user content | Yes if breakdown works | BLOCKED in UI without Gridlight |
| Character/location registry | Yes | Yes, manual | Image refs can use provider registry | Not auto-populated from script | WORKS-WITH-MANUAL-STEPS |
| Storyboards | Route exists | Yes | Gridlight-only; bypasses image provider registry | Yes to video stage if shots exist | NEEDS-SERVICE |
| Video clips | Route returns success with Gridlight JSON URL responses | Yes: Video Shots page | Provider registry via `resolve('video')` | Broken locally: URL response is not downloaded; app can return `/film/video/...` links that 404 | BLOCKED for reliable local asset |
| Dialogue voice | Route exists; same JSON URL storage pattern as video/music | Partial project-level UX | Provider registry via `resolve('voice')` | Likely broken locally for Gridlight URL responses; not live-measured in final mock run because demo shot had no dialogue | NEEDS-VERIFY / LIKELY BLOCKED |
| Lip-sync | Yes | Per-shot action | Provider registry via `resolve('lipsync')` | Partial: post/export can find synced video | WORKS-WITH-MANUAL-STEPS |
| Music score / ambient | Route returns success with Gridlight JSON URL responses | Yes for score+ambient | Provider registry via `resolve('music')` / ambient | Broken locally: URL response is not downloaded; scene-level audio also not placed in NLE timeline | BLOCKED for reliable local asset |
| SFX | Yes | No clear main UI pass | Provider registry via `resolve('sfx')` | Partial: per-shot only | WORKS-WITH-MANUAL-STEPS |
| Post/upscale/color | Yes | Partial: per-shot Upscale | Provider registry via `resolve('post')` | Partial | WORKS-WITH-MANUAL-STEPS |
| Pipeline runner | Yes | Yes: "Run scene -> final" | Provider registry, but generic payloads | No: assembly is only a marker | PARTIAL / RISKY |
| QA | Yes | Not surfaced as a hard gate | Local | Manual | WORKS-WITH-MANUAL-STEPS |
| Premiere XML / FCPXML | Routes return 200 | Yes | Local XML generation | Manual, no media package; invalid or absent media refs | BLOCKED for reliable handoff |
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

### F3: Gridlight Media Persistence And Premiere Handoff Are Broken

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

The through-line: generation returns success while media is not local, and XML export emits whatever is in `file_path`, or nothing when no asset exists. It is correct only by accident, when the asset happens to have been saved to a real absolute path, and it never fails loudly.

The current NLE and generation tests do not catch this. NLE fixtures use absolute paths and only assert that `<pathurl>file:///` exists. `backend/tests/video-gen.test.js:72-73` mocks Gridlight as `Content-Type: video/mp4` binary and `FAKE-MP4-DATA`, then asserts the generated Film Engine file serves successfully. Real documented Gridlight generation returns JSON, so those tests validate the branch that does not run for the default provider shape.

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
- The backend has standalone routes for video, voice, lipsync, music, SFX, ambient, post, subtitles, QA, NLE export, and project bundles, but video/music/voice persistence is broken for documented Gridlight URL responses.
- Focused backend tests for the picture-to-Premiere half pass against mocks.
- FCPXML, EDL, and Premiere endpoints return 200 on a real project, but only EDL verified as usable because it carries edit structure without depending on broken media paths.
- The **EDL export is usable today** for edit structure. On the demo project it produced correct title, non-drop-frame mode, event timecodes, clip names, and scene comments. EDL does not carry media paths like XML, so it sidesteps the broken pathurl class and can be used to conform media manually in Premiere.

## What Is Missing To Make The Answer "Yes"

1. **Real provider health checks** in `/film/providers`, especially for Gridlight.
2. **Manual shot creation UI** so breakdown is not a hard dependency.
3. **LLM provider capability** for prose conversion, breakdown, and screenplay assistant, or clear Gridlight-only labeling.
4. **Storyboard provider routing** through the image provider registry.
5. **NLE export path normalization and preflight**: reject unresolved assets or derive real local paths from `DATA_DIR`, `projectId`, subdir, and `file_name`.
6. **Premiere package export**: XML plus copied media in one archive/folder with relative paths.
7. **Real assembly step** in the pipeline that creates a timeline/package asset.
8. **Scene-level audio timeline placement** so music and ambient generated by scene appear in NLE exports.
9. **Project-wide guided flow** for voice, lipsync, post, SFX, QA, and export preflight.
10. **FDX/SRT export fixes** so advertised delivery buttons actually work.
11. **Silent data-loss fixes** for script format handling and scene-card unknown keys.

## Practical Answer For Manny

If you start today on a clean machine and expect the Film Engine itself to carry you from your novel excerpt to a Premiere-ready edit package, **no**.

If you load the bundled demo project, you can inspect and exercise much of the downstream workflow today without Gridlight. If you start Gridlight, know which routes/UI steps to use, and accept manual intervention, you can produce screenplay structure and storyboards for your own story. But video/audio generation is not currently producing local Film Engine media files from documented Gridlight URL responses. The thing that would fail at the worst moment is not only the edit package: in-app playback and project bundle export can also fail because the media file was never written locally.

The practical same-day workaround is **EDL, not Premiere XML**. Use EDL to get the cut structure into Premiere, then conform/relink media manually. That is not the promised end-to-end workflow, but it is the one export path that verified cleanly today.

The shortest credible path to "yes" is not a new generation model. It is reliability work around asset persistence, orchestration, and handoff: download provider-returned media URLs into Film Engine storage, return URLs only for files that exist, add truthful provider status, manual shot creation, real pipeline assembly, and a Premiere package that proves every referenced file exists before download.

## Source Slice Reports

- Part A: `docs/plans/e2e-readiness-part-a-story-to-picture.md`
- Part B: `docs/plans/e2e-readiness-part-b-picture-to-premiere.md`
