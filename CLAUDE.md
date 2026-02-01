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
│   │   └── migrations/     # SQL migration files
│   ├── routes/
│   │   ├── projects.js     # Project CRUD
│   │   ├── scripts.js      # Screenplay upload/versioning
│   │   ├── scenes.js       # Scene listing
│   │   ├── shots.js        # Shot creation + shot list
│   │   ├── breakdown.js    # AI screenplay breakdown
│   │   ├── characters.js   # Characters, voice profiles, costumes
│   │   ├── locations.js    # Locations + props
│   │   ├── notes.js        # Shot notes + review workflow
│   │   ├── assets.js       # Asset registry, music cues, color presets
│   │   ├── dashboard.js    # Dashboard, status board, milestones
│   │   ├── render-ledger.js    # Render logging + reproducibility
│   │   ├── production-status.js # Project status state machine
│   │   └── call-sheets.js      # Scene/project call sheets
│   └── lib/
│       ├── screenplay-parser.js    # INT./EXT. scene heading parser
│       └── scene-card-schema.js    # Scene card YAML validator
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
| Scripts | `POST /projects/:id/script`, `GET /projects/:id/scripts[/:ver]` |
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

## Key Concepts

### Scene Cards
YAML-formatted shot descriptions containing camera, lighting, characters, and style parameters. Validated by `lib/scene-card-schema.js`.

### Render Ledger
Full parameter capture for reproducibility: seed, sampler, steps, guidance, model hashes, LoRAs, controlnets. Supports locked (exact recreation) and creative (variation) modes.

### Production Status
State machine tracking project phases: `Concept` → `Script` → `PreProduction` → `Storyboard` → `Production` → `PostProduction` → `Review` → `Export` → `Complete`

## Database

SQLite via `better-sqlite3`. Schema auto-migrates on startup.

**Core Tables:**
- `film_projects` — Project metadata + status
- `film_scripts` — Screenplay versions
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
- `film_assets` — Asset registry (22 types)
- `film_music_cues` — Score/SFX cues
- `film_color_presets` — LUT/color grade presets

## Task Tracking

Tasks are in `.claude/tasks/TASK-FILM-*.md`. Current epic phases:

| Phase | Tasks | Description |
|-------|-------|-------------|
| 1A | FILM-001–010 | Project & Story Foundation |
| 1B | FILM-082–089 | Production Management |
| 2 | FILM-011–016 | Character & Asset Registry |
| 3 | FILM-017–021 | Storyboard Generation |
| Screenplay | FILM-094–131 | Screenplay Editor & Writing Tools (38 tasks) |

## Development Patterns

### Adding Routes
1. Create handler in `backend/routes/`
2. Import and register in `backend/server.js`
3. Add migration if new table needed in `backend/db/migrations/`

### Adding Migrations
Create numbered SQL file in `backend/db/migrations/` (e.g., `017_add_new_table.sql`). Migrations run automatically on startup via `schema.js`.

### Testing
```bash
# Health check
curl http://localhost:3100/api/health

# List projects
curl http://localhost:3100/film/projects
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
