# Film Engine API Reference

Base URL: `http://localhost:3100`

All film routes are prefixed with `/film`. Responses are JSON unless otherwise noted.

---

## Health Check

```
GET /api/health
```

**Response** `200`
```json
{ "status": "ok", "service": "film-engine" }
```

---

## Projects

### List Projects

```
GET /film/projects?page=1&limit=20&status=concept
```

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `page` | int | 1 | Page number |
| `limit` | int | 20 | Items per page (max 100) |
| `status` | string | — | Filter by status |

**Response** `200`
```json
{
  "projects": [
    {
      "id": "uuid",
      "title": "My Film",
      "logline": "A story about...",
      "genre": "drama",
      "status": "concept",
      "style_preset": "",
      "created_at": "2026-02-01T00:00:00.000Z",
      "updated_at": "2026-02-01T00:00:00.000Z"
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20
}
```

**Valid statuses:** `concept`, `script`, `pre-production`, `storyboard`, `production`, `post-production`, `review`, `export`, `complete`

### Get Project

```
GET /film/projects/:id
```

**Response** `200` — Project object with `scene_count` and `shot_count`.

### Create Project

```
POST /film/projects
```

**Body**
```json
{
  "title": "My Film",
  "logline": "A story about...",
  "genre": "drama",
  "style_preset": "cinematic"
}
```

**Response** `201` — Created project object.

### Update Project

```
PUT /film/projects/:id
```

**Body** — Any subset of: `title`, `logline`, `genre`, `status`, `style_preset`.

**Response** `200` — Updated project object.

### Delete Project

```
DELETE /film/projects/:id
```

**Response** `200`
```json
{ "deleted": true }
```

---

## Scripts

### Upload Screenplay

```
POST /film/projects/:id/script
```

**Body**
```json
{
  "content": "FADE IN:\n\nINT. OFFICE - DAY\n...",
  "format": "fountain"
}
```

Parses the screenplay, extracts scenes, computes statistics. Format can be `fountain` or `plain`.

**Response** `201` — Script object with `version`, `scene_count`, `page_count`, `dialogue_percentage`.

### List Script Versions

```
GET /film/projects/:id/scripts
```

**Response** `200`
```json
{ "scripts": [{ "id": "uuid", "version": 1, "created_at": "..." }] }
```

### Get Script Version

```
GET /film/projects/:id/scripts/:version
```

**Response** `200` — Full script object with `content`, `fountain_content`, statistics.

### Get Latest Fountain Content

```
GET /film/projects/:id/script/latest/fountain
```

**Response** `200` — Latest script with Fountain content and parsed elements.

### Save (Auto-save)

```
PUT /film/projects/:id/script/:version
```

**Body**
```json
{ "fountain_content": "..." }
```

**Response** `200` — Updated script.

---

## Scenes

### List Scenes

```
GET /film/projects/:id/scenes
```

**Response** `200`
```json
{
  "scenes": [
    {
      "id": "uuid",
      "project_id": "uuid",
      "scene_number": 1,
      "int_ext": "INT",
      "location": "OFFICE",
      "time_of_day": "DAY",
      "description": "...",
      "characters_present": "[\"JOHN\", \"SARAH\"]",
      "estimated_duration": 120,
      "status": "written"
    }
  ]
}
```

### Get Scene with Shots

```
GET /film/scenes/:id
```

**Response** `200` — Scene object with `shots` array.

**Valid scene statuses:** `written`, `broken_down`, `storyboarded`, `cast`, `voices_recorded`, `shots_generated`, `post_processed`, `approved`

---

## Shots

### Create Shots from Scene Cards

```
POST /film/shots
```

**Body**
```json
{
  "scene_id": "uuid",
  "cards": [
    {
      "shot_code": "SC01_SH01",
      "camera": { "shot_type": "wide", "movement": "static" },
      "lighting": { "style": "natural" },
      "characters": ["JOHN"],
      "action": "John enters the office."
    }
  ]
}
```

Cards are validated against the scene card schema.

**Response** `201`
```json
{ "shots": [{ "id": "uuid", "shot_code": "SC01_SH01", "status": "pending" }] }
```

### Get Shot List

```
GET /film/projects/:id/shotlist?page=1&limit=50
```

**Response** `200` — Paginated list of shots joined with scene data.

---

## Characters

### List Characters

```
GET /film/projects/:id/characters
```

**Response** `200`
```json
{ "characters": [{ "id": "uuid", "name": "JOHN", "description": "...", ... }] }
```

### Create Character

```
POST /film/projects/:id/characters
```

**Body**
```json
{
  "name": "JOHN",
  "description": "A middle-aged detective",
  "appearance_prompt": "tall man, gray hair, trench coat",
  "lora_id": "",
  "ti_token": "",
  "voice_id": ""
}
```

**Response** `201` — Created character.

### Get / Update / Delete Character

```
GET    /film/characters/:id
PUT    /film/characters/:id
DELETE /film/characters/:id
```

### Voice Profile

```
POST /film/characters/:id/voice
```

**Body**
```json
{ "speaker_embedding": "base64...", "language": "en", "style": "neutral" }
```

### Costumes

```
GET  /film/characters/:id/costumes
POST /film/characters/:id/costumes
```

---

## Locations

### List / Create Locations

```
GET  /film/projects/:id/locations
POST /film/projects/:id/locations
```

**Body** (POST)
```json
{
  "name": "Office Building",
  "description": "Modern glass office, 30th floor",
  "lighting_default": "fluorescent"
}
```

### Get / Update / Delete Location

```
GET    /film/locations/:id
PUT    /film/locations/:id
DELETE /film/locations/:id
```

---

## Props

### List / Create Props

```
GET  /film/projects/:id/props
POST /film/projects/:id/props
```

### Get / Update / Delete Prop

```
GET    /film/props/:id
PUT    /film/props/:id
DELETE /film/props/:id
```

---

## Shot Notes

### List / Create Notes

```
GET  /film/shots/:id/notes
POST /film/shots/:id/notes
```

**Body** (POST)
```json
{
  "note_type": "direction",
  "content": "Tighten framing on the close-up"
}
```

**Note types:** `direction`, `revision`, `approval`, `rejection`, `general`

### Update / Delete Note

```
PUT    /film/notes/:id
DELETE /film/notes/:id
```

### Shot Review

```
POST /film/shots/:id/review
```

**Body**
```json
{ "approved": true, "notes": "Looks good" }
```

---

## Assets

### List / Create Assets

```
GET  /film/projects/:id/assets?type=keyframe&shot_id=uuid
POST /film/projects/:id/assets
```

**Asset types:** `keyframe`, `storyboard`, `video_raw`, `video_synced`, `video_final`, `audio_dialogue`, `audio_music`, `audio_sfx`, `audio_ambient`, `audio_mix`, `thumbnail`, `reference_image`, `character_sheet`, `lora_weights`, `voice_sample`, `subtitle`, `export_package`, `fcpxml`, `edl`, `premiere_xml`, `lut`, `other`

### Get / Delete Asset

```
GET    /film/assets/:id
DELETE /film/assets/:id
```

---

## Music Cues

```
GET  /film/projects/:id/music-cues
POST /film/projects/:id/music-cues
```

---

## Color Presets

```
GET  /film/projects/:id/color-presets
POST /film/projects/:id/color-presets
```

---

## Dashboard

### Production Dashboard

```
GET /film/projects/:id/dashboard
```

Returns aggregated project statistics: scene counts by status, shot counts by status, character count, asset counts.

### Status Board

```
GET /film/projects/:id/status-board
```

Returns scenes with their shots and current statuses for the Kanban-style status board view.

---

## Milestones

### List / Create Milestones

```
GET  /film/projects/:id/milestones
POST /film/projects/:id/milestones
```

**Body** (POST)
```json
{
  "title": "Script Lock",
  "target_date": "2026-03-01",
  "description": "Final screenplay approved"
}
```

### Update Milestone

```
PUT /film/projects/:id/milestones/:mid
```

---

## Render Ledger

### Log Render

```
POST /film/shots/:id/render
```

**Body**
```json
{
  "seed": 42,
  "sampler": "euler_a",
  "steps": 30,
  "guidance": 7.5,
  "model_hashes": { "sdxl": "abc123" },
  "lora_ids": ["character_john"],
  "camera_params": { "shot_type": "wide" },
  "lighting_params": { "style": "natural" },
  "mode": "creative",
  "duration_ms": 3500
}
```

Full parameter capture for reproducibility.

### Render History

```
GET /film/shots/:id/renders
```

### Shot Versions

```
GET /film/shots/:id/versions
```

### Re-render

```
POST /film/shots/:id/re-render
```

Re-render a shot from a previous ledger entry's parameters.

---

## Production Status

### Advance Status

```
POST /film/projects/:id/advance-status
```

Evaluates current project state and advances the production status if criteria are met.

---

## Call Sheets

### Scene Call Sheet

```
GET /film/scenes/:id/call-sheet
```

### Project Call Sheet

```
GET /film/projects/:id/call-sheet
```

Returns formatted call sheet with scenes, characters needed, locations, and scheduling info.

---

## AI Screenplay Breakdown

### Generate Breakdown

```
POST /film/projects/:id/breakdown
```

**Body**
```json
{ "screenplay": "FADE IN:\n\nINT. OFFICE - DAY\n..." }
```

Uses AI (`/chat/intelligent`) to analyze screenplay and generate scene cards with camera, lighting, and character details.

### Stream Breakdown

```
POST /film/projects/:id/breakdown/stream
```

Same as above but returns Server-Sent Events (SSE) for real-time progress.

**SSE format:**
```
data: {"type":"progress","scene":1,"total":5}

data: {"type":"scene_card","scene_number":1,"card":{...}}

data: {"type":"complete","total_scenes":5}
```

---

## Screenplay AI

### AI Writing Assistant

```
POST /film/projects/:id/screenplay-ai
```

**Body**
```json
{
  "mode": "brainstorm",
  "prompt": "Help me develop the opening scene",
  "context": { "genre": "thriller", "characters": ["JOHN"] }
}
```

**Modes:** `brainstorm`, `write_scene`, `rewrite`, `convert`

### Stream AI Response

```
POST /film/projects/:id/screenplay-ai/stream
```

SSE streaming version.

---

## Text-to-Screenplay Conversion

### Convert Text

```
POST /film/projects/:id/text-to-screenplay
```

**Body**
```json
{
  "text": "Chapter 1: John walked into the dimly lit office...",
  "instructions": "Convert to screenplay format"
}
```

### Preview Conversion

```
POST /film/projects/:id/text-to-screenplay/preview
```

Returns a preview without saving.

---

## NLE Export

### List Export Formats

```
GET /film/projects/:id/export
```

**Response** `200`
```json
{
  "project_id": "uuid",
  "project_title": "My Film",
  "shot_count": 42,
  "formats": [
    { "id": "fcpxml", "name": "Final Cut Pro XML", "extension": ".fcpxml", "content_type": "application/xml" },
    { "id": "edl", "name": "CMX 3600 EDL", "extension": ".edl", "content_type": "text/plain" },
    { "id": "premiere", "name": "Premiere Pro XML", "extension": ".xml", "content_type": "application/xml" }
  ]
}
```

### Export FCPXML (Final Cut Pro)

```
GET /film/projects/:id/export/fcpxml
```

Returns FCPXML 1.11 with `Content-Type: application/xml` and `Content-Disposition: attachment`.

```bash
curl -o timeline.fcpxml http://localhost:3100/film/projects/{id}/export/fcpxml
```

### Export EDL (CMX 3600)

```
GET /film/projects/:id/export/edl
```

Returns CMX 3600 EDL at 24fps with `Content-Type: text/plain`.

```bash
curl -o timeline.edl http://localhost:3100/film/projects/{id}/export/edl
```

### Export Premiere Pro XML

```
GET /film/projects/:id/export/premiere
```

Returns FCP 7 XML (xmeml v5) compatible with Premiere Pro, DaVinci Resolve, and other NLEs.

```bash
curl -o timeline.xml http://localhost:3100/film/projects/{id}/export/premiere
```

---

## Storyboard Generation

### Generate Storyboard

```
POST /film/projects/:id/storyboard/generate
```

**Body** (optional)
```json
{
  "seed": 42,
  "consistency_weight": 0.7,
  "ip_adapter_image": null
}
```

Generates storyboard keyframes for all shots in the project. Calls ImageGen API sequentially per shot (avoids VRAM contention). Updates shot statuses to `complete` and scene statuses to `storyboarded`.

**Response** `200`
```json
{
  "project_id": "uuid",
  "shots_completed": 12,
  "shots_failed": 0,
  "frames": [
    {
      "shot_id": "uuid",
      "shot_code": "1A",
      "scene_number": 1,
      "status": "complete",
      "image_url": "/film/storyboards/{project_id}/1A.png"
    }
  ]
}
```

### Stream Storyboard Generation

```
POST /film/projects/:id/storyboard/generate/stream
```

Same as above but returns Server-Sent Events (SSE) for real-time progress.

**SSE format:**
```
data: {"type":"status","phase":"starting","total_shots":12}

data: {"type":"scene","scene_number":1,"scene_id":"uuid"}

data: {"type":"progress","shot_index":0,"total_shots":12,"shot_code":"1A","phase":"generating"}

data: {"type":"progress","shot_index":0,"total_shots":12,"shot_code":"1A","phase":"complete","image_url":"/film/storyboards/..."}

data: {"type":"scene_complete","scene_number":1,"scene_id":"uuid"}

data: {"type":"result","project_id":"uuid","shots_completed":12,"shots_failed":0}

data: {"type":"done"}
```

### View Storyboard

```
GET /film/projects/:id/storyboard
```

**Response** `200`
```json
{
  "project_id": "uuid",
  "project_title": "My Film",
  "frame_count": 12,
  "total_duration_ms": 48000,
  "frames": [
    {
      "shot_id": "uuid",
      "shot_code": "1A",
      "scene_number": 1,
      "scene_id": "uuid",
      "description": "John enters the office",
      "duration_ms": 4000,
      "image_url": "/film/storyboards/{project_id}/1A.png",
      "dialogue": [{"character": "JOHN", "line": "Hello"}],
      "camera": {"shot_type": "medium", "movement": "dolly-in"},
      "lighting": {"type": "low-key"},
      "status": "complete",
      "asset_version": 1
    }
  ]
}
```

### Regenerate Single Shot

```
POST /film/shots/:id/storyboard/regenerate
```

**Body**
```json
{
  "prompt_override": "A tall man in a trench coat, wide shot, dramatic lighting",
  "seed": 42,
  "style_override": "noir"
}
```

All fields optional. If `prompt_override` is provided, it replaces the auto-generated prompt.

**Response** `200`
```json
{
  "shot_id": "uuid",
  "shot_code": "1A",
  "status": "complete",
  "image_url": "/film/storyboards/{project_id}/1A.png",
  "seed": 42,
  "prompt": "the prompt used for generation"
}
```

### Serve Storyboard Image

```
GET /film/storyboards/:projectId/:filename
```

Returns the storyboard PNG image with `Content-Type: image/png`.

```bash
curl http://localhost:3100/film/storyboards/{project_id}/1A.png -o storyboard.png
```

---

## Error Codes

| Code | Meaning |
|------|---------|
| 400 | Invalid request (bad UUID, missing fields, invalid scene card) |
| 404 | Resource not found (project, scene, shot, character) |
| 405 | Method not allowed |
| 429 | Agent busy (generation endpoints) |
| 500 | Internal server error |

**Error format:**
```json
{ "error": "descriptive message" }
```

---

## Scene Card YAML Schema

Scene cards define shot parameters for generation:

```yaml
shot_code: SC01_SH01
camera:
  shot_type: wide          # wide, medium, close-up, extreme-close-up, over-the-shoulder,
                           # two-shot, establishing, aerial, low-angle, high-angle,
                           # dutch-angle, pov, tracking, dolly, steadicam, handheld,
                           # crane, insert
  movement: dolly-in       # static, pan-left, pan-right, tilt-up, tilt-down,
                           # dolly-in, dolly-out, tracking, crane-up, crane-down,
                           # handheld, steadicam, zoom-in, zoom-out
  lens_mm: 35
  depth_of_field: shallow
lighting:
  style: natural           # natural, studio, dramatic, noir, high-key, low-key,
                           # golden-hour, blue-hour, neon, candlelight, moonlight
  key_direction: front-left
  color_temp: 5600
characters:
  - JOHN
  - SARAH
action: "John enters the dimly lit office and notices Sarah at the desk."
dialogue:
  character: JOHN
  line: "I didn't expect to find you here."
style:
  mood: tense
  color_palette: cool
  film_grain: light
generation:
  mode: creative           # creative or locked
  seed: null
  negative_prompt: "blurry, distorted"
```

---

## Voice & Dialogue (Phase 4)

### Generate Voice for Shot

```
POST /film/shots/:id/voice/generate
```

Extracts dialogue from the shot's scene card, matches characters to voice profiles, and generates audio via `POST /voice`.

**Response** `200`
```json
{
  "shot_id": "uuid",
  "shot_code": "1A",
  "dialogue_count": 2,
  "audio_files": [
    {
      "character": "JOHN",
      "line": "Hello there.",
      "status": "complete",
      "audio_url": "/film/audio/{pid}/1A_JOHN_0.wav",
      "duration_ms": 1200
    }
  ]
}
```

### Generate Voice (SSE Stream)

```
POST /film/shots/:id/voice/generate/stream
```

SSE events: `status`, `progress` (per line), `result`, `done`

### Batch Voice Generation

```
POST /film/projects/:id/voice/batch
POST /film/projects/:id/voice/batch/stream
```

### Voice Job Status

```
GET /film/shots/:id/voice
GET /film/projects/:id/voice?status=complete
```

### Serve Audio File

```
GET /film/audio/:projectId/:filename
```

---

## Video Generation (Phase 5)

### Generate Video for Shot

```
POST /film/shots/:id/video/generate
```

Uses storyboard keyframe as init_image, maps camera movements to camera_control.

**Response** `200`
```json
{
  "shot_id": "uuid",
  "shot_code": "1A",
  "job_id": "uuid",
  "status": "complete",
  "video_url": "/film/video/{pid}/1A.mp4",
  "duration_ms": 4000
}
```

### Generate Video (SSE Stream)

```
POST /film/shots/:id/video/generate/stream
```

### Batch Video Generation

```
POST /film/projects/:id/video/batch
POST /film/projects/:id/video/batch/stream
```

### Video Job Status

```
GET /film/shots/:id/video
GET /film/projects/:id/video?status=complete
```

### Serve Video File

```
GET /film/video/:projectId/:filename
```

---

## Lip-Sync (Phase 6)

### Generate Lip-Sync

```
POST /film/shots/:id/lipsync/generate
```

Requires both `video_raw` and `audio_dialogue` assets for the shot.

**Response** `200`
```json
{
  "shot_id": "uuid",
  "shot_code": "1A",
  "job_id": "uuid",
  "status": "complete",
  "video_url": "/film/video/{pid}/1A_synced.mp4"
}
```

### Generate Lip-Sync (SSE Stream)

```
POST /film/shots/:id/lipsync/generate/stream
```

### Batch Lip-Sync

```
POST /film/projects/:id/lipsync/batch
```

### Lip-Sync Status

```
GET /film/shots/:id/lipsync
GET /film/projects/:id/lipsync?status=complete
```

---

## Music & Sound Design (Phase 7)

### Generate Music Score

```
POST /film/scenes/:id/music/generate
```

| Param | Type | Description |
|-------|------|-------------|
| `mood` | string | Override mood (tense, joyful, epic, calm, etc.) |
| `genre` | string | Override genre |
| `description` | string | Custom music description |

**Response** `200`
```json
{
  "scene_id": "uuid",
  "job_id": "uuid",
  "status": "complete",
  "music_url": "/film/music/{pid}/1_score.wav",
  "duration_s": 30,
  "mood": "tense",
  "genre": "thriller"
}
```

### Generate Music (SSE Stream)

```
POST /film/scenes/:id/music/generate/stream
```

### Generate SFX

```
POST /film/shots/:id/sfx/generate
```

Extracts SFX cues from scene card's `sfx_cues` array.

### Generate Ambient Audio

```
POST /film/scenes/:id/ambient/generate
```

Auto-detects ambient sounds from location (office, street, forest, etc.) and time of day.

### Batch Music/SFX/Ambient

```
POST /film/projects/:id/music/batch
POST /film/projects/:id/music/batch/stream
```

### List Music Jobs

```
GET /film/projects/:id/music/jobs?type=score&status=complete
```

### Serve Music File

```
GET /film/music/:projectId/:filename
```

---

## Post-Production (Phase 9)

### Upscale Video

```
POST /film/shots/:id/post/upscale
```

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `model` | string | `realesrgan-video` | Upscaling model |
| `scale_factor` | number | `2` | Scale factor |

### Face Restoration

```
POST /film/shots/:id/post/face-restore
```

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `face_model` | string | `codeformer` | Face restoration model |
| `face_weight` | number | `0.7` | Restoration strength |

### Color Grading

```
POST /film/shots/:id/post/color-grade
```

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `lut_preset` | string | `cinematic_warm` | LUT preset name |
| `film_grain` | number | `0.15` | Film grain amount |
| `color_preset_id` | string | | Use a saved color preset |

### Full Composite (All Steps)

```
POST /film/shots/:id/post/composite
```

Runs upscale → face-restore → color-grade sequentially.

### Batch Post-Production

```
POST /film/projects/:id/post/batch
POST /film/projects/:id/post/batch/stream
```

### Post Job Status

```
GET /film/shots/:id/post
GET /film/projects/:id/post?type=upscale&status=complete
```

---

## Pipeline Orchestrator (Phase 12)

### Run Shot Pipeline

```
POST /film/shots/:id/pipeline/run
```

Runs the full 9-step pipeline for a single shot.

| Param | Type | Description |
|-------|------|-------------|
| `skip_steps` | string[] | Steps to skip (e.g., `["voice", "lipsync"]`) |
| `start_from` | string | Resume from this step |
| `only_steps` | string[] | Run only these steps |

**Pipeline steps:** `keyframe` → `video` → `voice` → `lipsync` → `music` → `sfx` → `ambient` → `post` → `assembly`

**Response** `200`
```json
{
  "run_id": "uuid",
  "shot_id": "uuid",
  "status": "complete",
  "steps_completed": ["keyframe", "video", "music", "sfx", "ambient", "post", "assembly"],
  "steps_failed": [],
  "total_steps": 7,
  "progress_pct": 100
}
```

### Run Shot Pipeline (SSE Stream)

```
POST /film/shots/:id/pipeline/run/stream
```

SSE events: `status`, `step_start`, `step_complete`, `step_retry`, `step_failed`, `result`, `done`

### Run Scene Pipeline

```
POST /film/scenes/:id/pipeline/run
```

Runs the pipeline for all shots in a scene. Returns `202 Accepted`.

### Run Project Pipeline

```
POST /film/projects/:id/pipeline/run
```

Runs the pipeline for all shots in the project. Returns `202 Accepted`.

### Pipeline Status

```
GET /film/pipeline/:id
```

### Pipeline Control

```
POST /film/pipeline/:id/pause
POST /film/pipeline/:id/resume
POST /film/pipeline/:id/cancel
```

### List Pipeline Runs

```
GET /film/projects/:id/pipeline?status=running
```

---

## Character Reference Sheets (FILM-014)

### Generate Reference Sheet

```
POST /film/characters/:id/refsheet/generate
```

Generates front, side, and back views of the character using their appearance prompt.

**Response** `200`
```json
{
  "character_id": "uuid",
  "character_name": "JOHN",
  "views": [
    { "view": "front", "status": "complete", "image_url": "/film/refsheets/{pid}/john_front.png" },
    { "view": "side", "status": "complete", "image_url": "/film/refsheets/{pid}/john_side.png" },
    { "view": "back", "status": "complete", "image_url": "/film/refsheets/{pid}/john_back.png" }
  ],
  "job_id": "uuid"
}
```

### Get Reference Sheet Status

```
GET /film/characters/:id/refsheet
```

---

## Viseme Tracks (FILM-027, FILM-039)

### Generate Viseme Track

```
POST /film/shots/:id/lipsync/viseme
```

Generates MPEG-4 viseme track from shot dialogue text.

**Response** `200`
```json
{
  "shot_id": "uuid",
  "tracks": [
    {
      "character": "JOHN",
      "line": "Hello there.",
      "duration_ms": 1200,
      "viseme_count": 8,
      "visemes": [
        { "viseme": "PP", "start_ms": 0, "end_ms": 100 },
        { "viseme": "EE", "start_ms": 100, "end_ms": 250 }
      ]
    }
  ]
}
```

### Get Viseme Tracks

```
GET /film/shots/:id/lipsync/viseme
```

### Viseme-Guided Sync

```
POST /film/shots/:id/lipsync/viseme-sync
```

Enhances lip-sync using pre-generated viseme tracks. Sends viseme guidance (blend shapes, timing, weight) alongside video and audio to the lipsync endpoint.

---

## Multi-Clip Stitching (FILM-033)

### Stitch Long Shot

```
POST /film/shots/:id/video/stitch
```

For shots exceeding 5 seconds, generates sub-clips and stitches them together with transitions.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `max_clip_ms` | number | `5000` | Maximum sub-clip duration |
| `transition` | string | `cross-dissolve` | Transition type |

**Transitions:** `cross-dissolve`, `cut`, `fade-through-black`, `dip-to-white`, `wipe-left`, `wipe-right`

**Response** `200`
```json
{
  "shot_id": "uuid",
  "shot_code": "1A",
  "job_id": "uuid",
  "status": "complete",
  "clip_count": 3,
  "video_url": "/film/video/{pid}/1A_stitched.mp4",
  "duration_ms": 12000
}
```

---

## Shot-to-Shot Color Matching (FILM-057)

### Color Match Shot

```
POST /film/shots/:id/post/color-match
```

Matches color grading to the previous shot in the scene for visual continuity.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `reference_shot_id` | string | auto | Reference shot (defaults to previous in scene) |
| `strength` | number | `0.7` | Match strength (0-1) |

### Batch Color Match

```
POST /film/projects/:id/post/color-match
```

Color-matches all shots in the project against their scene neighbors.

---

## ProRes/DNxHR Encoding (FILM-062)

### Encode Shot

```
POST /film/shots/:id/post/encode
```

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `codec` | string | `prores-422-lt` | Target codec |

**Supported codecs:** `prores-422-proxy`, `prores-422-lt`, `prores-422`, `prores-422-hq`, `dnxhr-lb`, `dnxhr-sq`, `dnxhr-hq`, `h264`, `h265`

### Batch Encode

```
POST /film/projects/:id/post/encode
```

---

## Audio Mix (FILM-093, FILM-063)

### Mix Shot Audio

```
POST /film/shots/:id/audio/mix
```

Mixes all audio tracks for a shot (dialogue, music, SFX, ambient) with auto-ducking.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `lufs_target` | number | `-14` | LUFS normalization target |
| `ducking` | boolean | `true` | Enable auto-ducking during dialogue |
| `output_format` | string | `wav` | Output format |

**Looping beds.** Ambient is generated as a short seamless loop (generators cap
around 30s while scenes run minutes), so each track in the mix payload sent to
the mix service carries:

| Field | Type | Description |
|-------|------|-------------|
| `loop` | boolean | Repeat this track to fill its slot. Only ever set when the track is shorter than the slot; never inferred from track type |
| `loop_until_ms` | number | Repeat until this offset — the shot duration, or the longest other track when the shot has none |
| `loop_crossfade_ms` | number | Crossfade between repeats so the seam is inaudible (ambient uses 5000) |

The mix service must honour these for a bed to reach the end of a shot; a
service that ignores `loop` will play the bed once and leave the remainder dry.

**Response** `200`
```json
{
  "shot_id": "uuid",
  "job_id": "uuid",
  "status": "complete",
  "track_count": 4,
  "audio_url": "/film/music/{pid}/1A_mix.wav",
  "lufs_target": -14
}
```

### Mix Project Audio

```
POST /film/projects/:id/music/mix
```

### Export Stems

```
GET /film/projects/:id/music/stems
```

Returns audio stems grouped by type (dialogue, music, SFX, ambient).

### Export SRT Subtitles

```
GET /film/projects/:id/music/srt
```

Generates SRT subtitles from all dialogue across the project.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `include_character` | string | `true` | Include character name prefix |

**Response** `200` (text/plain, SRT format)

---

## Smart Scheduling (FILM-072)

### Build Schedule

```
POST /film/projects/:id/pipeline/schedule
```

Builds an optimized execution schedule that groups pipeline steps by GPU model to minimize VRAM swapping.

**Response** `200`
```json
{
  "schedule_id": "uuid",
  "project_id": "uuid",
  "phases": [
    {
      "model": "sdxl",
      "vram_gb": 6.5,
      "load_time_s": 15,
      "tasks": [
        { "shot_id": "uuid", "shot_code": "1A", "step": "keyframe" },
        { "shot_id": "uuid", "shot_code": "1B", "step": "keyframe" }
      ]
    }
  ],
  "estimated_load_time_s": 120,
  "estimated_swaps": 6,
  "residency": {
    "resident": ["sdxl", "animatediff-sdxl"],
    "evict": ["musicgen-large"],
    "total_vram_gb": 19.5,
    "budget_gb": 24
  }
}
```

### Get Latest Schedule

```
GET /film/projects/:id/pipeline/schedule
```

---

## QA & Quality Gates (FILM-073–075)

### Run Project QA

```
POST /film/projects/:id/qa/run
```

Runs all QA checks across shots, scenes, and project scope.

**Response** `200`
```json
{
  "run_id": "uuid",
  "project_id": "uuid",
  "scope": "project",
  "total_checks": 45,
  "passed": 38,
  "failed": 7,
  "results": [
    {
      "check_id": "has_keyframe",
      "scope": "shot",
      "severity": "error",
      "label": "Shot has storyboard keyframe",
      "target_id": "uuid",
      "target_code": "1A",
      "passed": false,
      "detail": "Missing keyframe asset"
    }
  ],
  "summary": { "errors": 2, "warnings": 3, "info": 2 }
}
```

### Get QA History

```
GET /film/projects/:id/qa
```

### Get Latest QA Run

```
GET /film/projects/:id/qa/latest
```

### Continuity Check

```
GET /film/projects/:id/qa/continuity
```

Checks lighting consistency, character disappearances, and time-of-day changes across scenes.

### Acceptance Rubric

```
GET /film/projects/:id/qa/rubric
```

Returns the acceptance criteria with current compliance status.

### Run Scene QA

```
POST /film/scenes/:id/qa/run
```

### Run Shot QA

```
POST /film/shots/:id/qa/run
```

## 3D Asset Generation

Proxies Gridlight `/3d` endpoints to turn characters and props into 3D models.
Jobs are tracked in `film_3d_jobs`; outputs are stored at
`data/3d/{project_id}/{name}.glb` and registered in `film_assets` as
`asset_type='other'` with `metadata.kind` (`model_3d` / `model_rigged` /
`model_animated`). Generation verbs are rate-limited in the `generation` bucket.

### Generate from Character / Prop (text → mesh)

```
POST /film/characters/:id/model/generate[/stream]
POST /film/props/:id/model/generate[/stream]
```

Body (all optional): `{ format, quality, model, seed, target_polycount, texture_resolution, symmetry, pbr }`.
Returns `{ job_id, status: "complete", asset_id, model_url, format }` — or `202`
`{ job_id, upstream_job_id, status: "generating", poll }` when the service
defers to an async job. The `/stream` variant emits SSE `status` → `complete`
→ `done` events (aborts if the client disconnects).

### Generate from Reference Image (image → mesh)

```
POST /film/characters/:id/model/from-image[/stream]
POST /film/props/:id/model/from-image[/stream]
```

Uses `init_image` from the body, else the subject's newest reference
image/sheet on disk. Returns `400` if no reference image is available.

### Mesh Operations

```
POST /film/models/:assetId/rig          # { skeleton, model }
POST /film/models/:assetId/retexture    # { prompt, texture_resolution, model }
POST /film/models/:assetId/animate      # { animation, loop, fps, model }
GET  /film/models/:assetId/animations   # → { animations: [...] }
```

### Batch, Status & Serving

```
POST /film/projects/:id/models/batch[/stream]   # all characters + props
GET  /film/projects/:id/models                  # jobs + registered models
GET  /film/models/job/:jobId                     # single job status (+ model_url)
GET  /film/3d/:projectId/:filename               # serve .glb/.gltf/.fbx/.obj/.usdz
```

---

## Score Sessions (Music Workstation)

A score session is a soundtrack written against a picture sequence (or a scene): tracks, clips, an emotional arc, markers, automation and an operation lineage, rendered by a deterministic bounce and, once approved, consumed by the timeline, playback, the audio mix, the pipeline, NLE exports and the conformed master. The workflow, the provider capability table, the rights policy, the Ableton sidecar and backup/restore are in [`music-workstation.md`](music-workstation.md).

**FREE** means the route reads, plans or renders locally and never reaches a paid provider. **SPENDS** means it does. Everything else writes to this engine's database only. Every route below also has an MCP tool (`music_*`, `ableton_*`); see [`claude-desktop-guide.md`](claude-desktop-guide.md).

| Method | Path | What it does |
|--------|------|--------------|
| GET | `/film/projects/:id/music-sessions` | list |
| POST | `/film/projects/:id/music-sessions` | create (stamped against the brief it was written to) |
| GET | `/film/music-sessions/vocabulary` | FREE: every enum, range and lifecycle table the validators enforce |
| GET | `/film/music-sessions/health` | FREE: every operation area by status, what is stalled or failed and how to recover, the encoder and each DAW — no secret, no path (MUS-023) |
| GET | `/film/music-sessions/:id` | the ScoreSession read model |
| PUT | `/film/music-sessions/:id` | update (lifecycle through the contract) |
| GET | `/film/music-sessions/:id/brief` | FREE: the compiled ScoreBrief with provenance and fingerprints |
| GET | `/film/music-sessions/:id/drift` | FREE: what moved since the session was stamped; writes nothing |
| POST | `/film/music-sessions/:id/rebase` | the explicit rebase |
| POST | `/film/music-sessions/:id/batch` | ordered, atomic ops over the child kinds |
| POST | `/film/music-sessions/:id/stems` | aligned stem import: one or several files, one operation, one transaction |
| GET | `/film/music-sessions/:id/bounce/plan` | FREE: what a bounce would render, what it would leave out and why, the version it would become |
| POST | `/film/music-sessions/:id/bounce` | the deterministic bounce: master + delivery stems at 48 kHz, registered; 409 when unchanged |
| GET | `/film/music-sessions/:id/bounces[/:opId]` | every bounce of the session with its outputs, newest version first |
| GET | `/film/music-sessions/:id/emotion/brief` | FREE: the brief, the accepted arc, the pending proposals, the schema, the rules — for the model to reason from |
| GET / POST | `/film/music-sessions/:id/emotion/proposals` | list proposals / store one (proposed, never accepted) |
| POST | `/film/music-sessions/:id/emotion/proposals/:pid/accept` | the explicit acceptance, per range, with edits |
| GET | `/film/music-sessions/:id/separations/plan` | FREE: provider, variation, expected stems, placement and cost hint for separating a clip |
| POST | `/film/music-sessions/:id/separations` | separate a clip into 2 or 6 stems (SPENDS); answers at once with a running operation |
| GET | `/film/music-sessions/:id/separations[/:opId]` | every separation of the session, or one, with its stems or its failure |
| POST | `/film/music-sessions/:id/separations/:opId/retry` | a failed separation again, as a new operation naming the one it retries |
| POST | `/film/music-sessions/:id/generate/plan` | FREE: compose, parts, reference, video or inpaint — provider, length, outputs, context, cost, take behaviour |
| POST | `/film/music-sessions/:id/generate` | generate (SPENDS): new assets and new clips as candidate takes, nothing replaced |
| GET | `/film/music-sessions/:id/generations[/:opId]` | every generation of the session, with its outputs or its failure |
| GET | `/film/music-sessions/:id/jobs[/:opId]` | FREE: every generation and separation as a parent with its ordered children |
| POST | `/film/music-sessions/:id/jobs/:opId/poll` | FREE: where a job has got to; one whose process is gone is reported interrupted |
| POST | `/film/music-sessions/:id/jobs/:opId/retry` | a failed job again as the next attempt (SPENDS) |
| POST | `/film/music-sessions/:id/package` | FREE (a local render at most): the portable score package — manifest, aligned BWF stems, master, picture |
| GET | `/film/music-sessions/:id/packages` | every package built from the session |
| POST | `/film/projects/:id/music-packages/import` | validate (validate_only) or import a package; into session_id as candidate takes, or a new session |
| POST | `/film/music-sessions/:id/approve` | select a bounce as the approved mix (refused when stale); POST …/unapprove takes it back (MUS-020) |
| GET | `/film/music-sessions/:id/lineage` | FREE: every clip and the mix walked to their sources — origin, status, owner, provider, hash — and every issue (MUS-022) |
| GET | `/film/projects/:id/music-score` | FREE: the approved mixes the film consumes, their offsets, and every session not consumed and why |
| GET | `/film/daw/:adapter/{status,session}` | FREE: is the DAW reachable and compatible; the DAW session as it is (MUS-018) |
| GET | `/film/music-sessions/:id/daw/:adapter/push/plan` | FREE: what a push would create, update, leave alone, and every conflict |
| POST | `/film/music-sessions/:id/daw/:adapter/push` | carry out a fingerprinted push plan (changes the DAW; idempotent) |
| GET | `/film/music-sessions/:id/daw/:adapter/pull/plan` | FREE: what the DAW has rendered that could come back |
| POST | `/film/music-sessions/:id/daw/:adapter/pull` | bring a render back, validated by hash and alignment, as candidate takes |
| POST | `/film/music-sessions/:id/daw/:adapter/transport` | play / stop / locate, only when a person asked (supervised) |
| GET | `/film/music-sessions/:id/daw/:adapter/audit` | FREE: every DAW push, pull and transport on the session, needing no connection (MUS-019) |
| GET / POST | `/film/music-sessions/:id/:kind` | list / create a child |
| PUT / DELETE | `/film/music-sessions/:id/:kind/:childId` | update / delete a child |
| GET | `/film/projects/:id/music/capabilities` | FREE: every music workflow the project's provider serves (compose, parts, separate, reference, video, inpaint) — status, limits, cost hint, and who else could do it |

`:kind` is one of `tracks`, `clips`, `markers`, `emotion-ranges`, `automation`. A row reached through another session's URL is **404**, never 403. The lifecycle goes through the contract: a draft cannot be approved (**409**), and `PUT` into `approved` is refused with `USE_APPROVE` — approval selects a bounce and is its own route.

### Refusals worth knowing

| Status | Code | When |
|--------|------|------|
| 409 | `UNCHANGED` | A bounce of a session whose fingerprint has not moved; `force: true` renders it anyway as a new version |
| 409 | `STALE_MIX` | Approving a bounce rendered before the session last changed; `ignore_stale` overrides |
| 409 | `RIGHTS_BLOCKED` | Approving a mix a source's rights block under the policy; `ignore_rights` overrides and is recorded |
| 409 | `EMOTION_NOT_ACCEPTED` | Generating from an arc nobody accepted; `ignore_emotion` goes without one |
| 409 | `CONFLICTS` / `STALE_PLAN` | A DAW push whose tracks were edited in the DAW, or whose plan the session or DAW has moved past |
| 503 | — | A DAW adapter that is not configured; the body names what to set and the guide |

### Health

```
GET /film/music-sessions/health?project_id=&session_id=&probe=true
```

Free. Every operation area — `render`, `generation`, `separation`, `package`, `daw`, `import`, `record` — with a count per status, what is running, what is **stalled** (a generation or separation no process owns, or anything else still running past 30 minutes), and the ten most recent failures, each with its session and how to recover. Also `encoder` (available, and where it came from) and `daw` (per adapter: configured, why not, and with `probe=true` whether it answers). Error text is kept with absolute paths cut to their file names; no token, key or local path appears in the report. MCP: `music_health`.

**Response** `200`
```json
{
  "ok": false, "attention": 2, "operations": 41, "stall_after_ms": 1800000,
  "encoder": { "available": true, "source": "bundled", "reason": null },
  "daw": { "ableton": { "configured": false, "reason": "the Ableton sidecar is not configured: …", "guide": "docs/ableton-sidecar.md", "status": null } },
  "areas": {
    "render": { "counts": { "planned": 0, "running": 0, "complete": 6, "failed": 1, "cancelled": 0 },
                "running": [], "stalled": [],
                "recent_failures": [{ "id": "…", "session_id": "…", "error": "the encoder failed (…/ffmpeg: 1): …/x_master.wav: No such file", "recovery": "Read GET …/bounce/plan …" }] }
  }
}
```
