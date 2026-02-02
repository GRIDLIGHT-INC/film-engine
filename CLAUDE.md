# Film Engine

AI film production pipeline for Gridlight. Transforms screenplays into editor-ready output through automated scene breakdown, storyboarding, and asset generation.

## Quick Start

```bash
cd backend
npm install
node server.js
```

Server runs on `http://localhost:3100`. Database auto-initializes on first run (SQLite at `data/film-engine.db`).

## Architecture

```
film-engine/
├── backend/
│   ├── server.js           # HTTP server + routing (port 3100)
│   ├── db/
│   │   ├── database.js     # SQLite connection (better-sqlite3)
│   │   ├── schema.js       # Auto-migration runner
│   │   └── migrations/     # SQL migration files (019 migrations)
│   ├── routes/
│   │   ├── projects.js     # Project CRUD
│   │   ├── scripts.js      # Screenplay upload/versioning + Fountain
│   │   ├── scenes.js       # Scene listing
│   │   ├── shots.js        # Shot creation + shot list
│   │   ├── breakdown.js    # AI screenplay breakdown (SSE streaming)
│   │   ├── screenplay-ai.js    # AI writing assistant
│   │   ├── text-convert.js     # Text-to-screenplay conversion
│   │   ├── characters.js   # Characters, voice profiles, costumes
│   │   ├── locations.js    # Locations + props
│   │   ├── notes.js        # Shot notes + review workflow
│   │   ├── assets.js       # Asset registry, music cues, color presets
│   │   ├── dashboard.js    # Dashboard, status board, milestones
│   │   ├── render-ledger.js    # Render logging + reproducibility
│   │   ├── production-status.js # Project status state machine
│   │   ├── call-sheets.js      # Scene/project call sheets
│   │   └── nle-export.js       # FCPXML, EDL, Premiere XML export
│   ├── lib/
│   │   ├── fountain-parser.js     # Fountain markup parser (AST)
│   │   ├── fountain-renderer.js   # Fountain → HTML renderer
│   │   ├── fdx-parser.js         # Final Draft XML parser
│   │   ├── nle-export.js         # NLE format generators (pure functions)
│   │   ├── screenplay-parser.js   # INT./EXT. scene heading parser
│   │   └── scene-card-schema.js   # Scene card YAML validator
│   └── tests/
│       └── nle-export.test.js     # NLE export unit tests
├── docs/
│   └── api-film.md         # Full API reference
├── src/
│   ├── index.html          # Frontend SPA
│   └── app.json            # App config
├── data/
│   └── film-engine.db      # SQLite database (auto-created)
└── gridlight.json          # App manifest
```

## API Routes

All routes prefixed with `/film`:

| Category | Endpoints |
|----------|-----------|
| Projects | `GET/POST /projects`, `GET/PUT/DELETE /projects/:id` |
| Scripts | `POST /projects/:id/script`, `GET /projects/:id/scripts[/:ver]`, `PUT /projects/:id/script/:ver` |
| Scenes | `GET /projects/:id/scenes`, `GET /scenes/:id` |
| Shots | `POST /shots`, `GET /projects/:id/shotlist` |
| Characters | `GET/POST /projects/:id/characters`, `GET/PUT/DELETE /characters/:id` |
| Locations | `GET/POST /projects/:id/locations`, `GET/PUT/DELETE /locations/:id` |
| Props | `GET/POST /projects/:id/props`, `GET/PUT/DELETE /props/:id` |
| Notes | `GET/POST /shots/:id/notes`, `PUT/DELETE /notes/:id`, `POST /shots/:id/review` |
| Assets | `GET/POST /projects/:id/assets`, `GET/DELETE /assets/:id` |
| Dashboard | `GET /projects/:id/dashboard`, `GET /projects/:id/status-board` |
| Milestones | `GET/POST /projects/:id/milestones`, `PUT /projects/:id/milestones/:mid` |
| Render | `POST /shots/:id/render`, `GET /shots/:id/renders`, `GET /shots/:id/versions` |
| Status | `POST /projects/:id/advance-status` |
| Call Sheets | `GET /scenes/:id/call-sheet`, `GET /projects/:id/call-sheet` |
| Breakdown | `POST /projects/:id/breakdown[/stream]` (SSE) |
| Screenplay AI | `POST /projects/:id/screenplay-ai[/stream]` |
| Text Convert | `POST /projects/:id/text-to-screenplay[/preview]` |
| Export | `GET /projects/:id/export[/fcpxml\|edl\|premiere]` |

Full API documentation: [`docs/api-film.md`](docs/api-film.md)

## Key Concepts

### Scene Cards
YAML-formatted shot descriptions containing camera, lighting, characters, and style parameters. Validated by `lib/scene-card-schema.js`.

### Render Ledger
Full parameter capture for reproducibility: seed, sampler, steps, guidance, model hashes, LoRAs, controlnets. Supports locked (exact recreation) and creative (variation) modes.

### Production Status
State machine tracking project phases: `Concept` → `Script` → `PreProduction` → `Storyboard` → `Production` → `PostProduction` → `Review` → `Export` → `Complete`

### NLE Export
Export project timelines for professional video editors:
- **FCPXML 1.11** — Final Cut Pro native format with clips, markers, audio lanes
- **CMX 3600 EDL** — Universal edit decision list (24fps non-drop frame)
- **Premiere Pro XML** — FCP 7 xmeml v5 format (works with Premiere, Resolve, etc.)

Exports are registered in the asset registry (`film_assets` table) for tracking.

## Database

SQLite via `better-sqlite3`. Schema auto-migrates on startup (19 migrations).

**Core Tables:**
- `film_projects` — Project metadata + status
- `film_scripts` — Screenplay versions with Fountain content
- `film_scenes` — Extracted scenes with INT/EXT, location, time of day
- `film_shots` — Individual shots with scene card YAML
- `film_characters` — Characters with appearance prompts, LoRA/TI tokens
- `film_locations` — Locations with lighting defaults
- `film_props` — Props with scene assignments
- `film_costumes` — Per-character costumes
- `film_voice_profiles` — Speaker embeddings for TTS
- `render_ledger` — Full render parameter history
- `film_shot_versions` — Version history with thumbnails
- `film_shot_notes` — Direction, revision, approval notes
- `film_milestones` — Production timeline tracking
- `film_assets` — Asset registry (22 types including export formats)
- `film_music_cues` — Score/SFX cues
- `film_color_presets` — LUT/color grade presets
- `film_script_elements` — Fountain element-level queries

## Task Tracking

Tasks are in `.claude/tasks/TASK-FILM-*.md`. Current epic phases:

| Phase | Tasks | Description | Status |
|-------|-------|-------------|--------|
| 1A | FILM-001–010 | Project & Story Foundation | Backend built |
| 1B | FILM-082–089 | Production Management | Backend built |
| 2 | FILM-011–016 | Character & Asset Registry | Backend built |
| 3 | FILM-017–021 | Storyboard Generation | Blocked (needs ImageGen) |
| 4 | FILM-022–028 | Voice & Dialogue Pipeline | Blocked (needs Voice-TTS) |
| 5 | FILM-029–035 | Video Generation | Blocked (needs VideoGen) |
| 6 | FILM-036–040 | Lip-Sync & Performance | Blocked (needs Phase 4+5) |
| 7 | FILM-090–093 | Music & Sound Design | Blocked (needs Music Gen) |
| 8 | FILM-048–051 | Render Ledger & Reproducibility | Backend built |
| 9 | FILM-052–058 | Post-Production Pipeline | Blocked (needs Phase 5) |
| 10 | FILM-059–064 | NLE Export & Integration | In progress |
| 11 | FILM-065–069 | Desktop App Integration | Planned |
| 12 | FILM-070–072 | Shot Pipeline Orchestrator | Blocked (needs all agents) |
| 13 | FILM-073–075 | QA & Quality Gates | Blocked (needs Phase 12) |
| 14 | FILM-076–081 | Testing & Documentation | In progress |
| Screenplay | FILM-094–131 | Screenplay Editor & Writing Tools (38 tasks) | Scoped |

## Development Patterns

### Adding Routes
1. Create handler in `backend/routes/`
2. Import and register in `backend/server.js`
3. Add migration if new table needed in `backend/db/migrations/`

### Adding Migrations
Create numbered SQL file in `backend/db/migrations/` (e.g., `020_add_new_table.sql`). Migrations run automatically on startup via `schema.js`.

### Testing
```bash
# Run unit tests
node --test backend/tests/nle-export.test.js

# Health check
curl http://localhost:3100/api/health

# List projects
curl http://localhost:3100/film/projects

# Export EDL for a project
curl http://localhost:3100/film/projects/{id}/export/edl
```

## Screenplay Tasks (FILM-094 to FILM-131)

The screenplay epic adds a full-featured screenplay editor with:
- **Fountain Parser** (FILM-094): Parse Fountain markup to structured AST
- **Fountain Renderer** (FILM-095): HTML output with screenplay CSS
- **Screenplay Editor UI** (FILM-096–101): CodeMirror-based editing, auto-formatting
- **Writing Tools** (FILM-102–115): Character tracker, scene navigator, outline view
- **Statistics** (FILM-116–120): Word counts, page estimates, dialogue analysis
- **Import/Export** (FILM-121–125): PDF export, Final Draft import/export
- **Collaboration** (FILM-126–131): Comments, revisions, compare versions
