# Film Engine

AI film production pipeline for Gridlight. Manages the full lifecycle from screenplay to editor-ready output.

## Phases Implemented

### Phase 1A — Project & Story Foundation
- **FILM-001–010**: Project CRUD, script upload with auto scene extraction, scene/shot tables, scene card schema, batch shot creation, AI breakdown, aggregate shot list

### Phase 1B — Hollywood Production Backend
- **FILM-011**: Characters with appearance prompts, LoRA/TI tokens, voice profiles, costumes
- **FILM-012**: Locations with lighting/atmosphere defaults, reference images
- **FILM-013**: Props with categories and scene assignments
- **FILM-014**: Costumes per character with visual prompts and color palettes
- **FILM-015**: Voice profiles with speaker embeddings and TTS params
- **FILM-016**: Scene-character and scene-prop join tables
- **FILM-048–051**: Render ledger for full reproducibility (seed, sampler, steps, guidance, LoRAs, controlnets)
- **FILM-052**: Shot version history with approval states
- **FILM-084**: Production dashboard, status board, milestones timeline
- **FILM-085**: Shot notes, reviews, approval/rejection workflow
- **FILM-086**: Asset registry (22 asset types), music cues, color presets

## Setup

### Prerequisites
- Node.js 18+

No external database required — Film Engine uses SQLite (via `better-sqlite3`), which stores data locally in `data/film-engine.db`.

### Install & Run

```bash
cd apps/film-engine/backend
npm install
node server.js
```

The backend auto-runs migrations on startup. Frontend is served by the dev server at `/apps/film-engine`.

### API Endpoints

#### Projects & Scripts

| Method | Path | Description |
|--------|------|-------------|
| GET | /film/projects | List all projects |
| POST | /film/projects | Create project |
| GET | /film/projects/:id | Get project detail |
| PUT | /film/projects/:id | Update project |
| DELETE | /film/projects/:id | Delete project |
| POST | /film/projects/:id/script | Upload screenplay |
| GET | /film/projects/:id/scripts | List script versions |
| GET | /film/projects/:id/scripts/:ver | Get specific version |

#### Scenes & Shots

| Method | Path | Description |
|--------|------|-------------|
| GET | /film/projects/:id/scenes | List scenes |
| GET | /film/scenes/:id | Get scene with shots |
| POST | /film/shots | Create shots from scene cards |
| GET | /film/projects/:id/shotlist | Aggregate shot list |
| POST | /film/projects/:id/breakdown | AI screenplay breakdown |

#### Characters

| Method | Path | Description |
|--------|------|-------------|
| GET | /film/projects/:id/characters | List project characters |
| POST | /film/projects/:id/characters | Create character |
| GET | /film/characters/:id | Get character (with costumes, voice, scenes) |
| PUT | /film/characters/:id | Update character |
| DELETE | /film/characters/:id | Delete character |
| POST | /film/characters/:id/voice | Create/replace voice profile |
| GET | /film/characters/:id/voice | Get voice profile |
| GET | /film/characters/:id/costumes | List costumes |
| POST | /film/characters/:id/costumes | Create costume |

#### Locations & Props

| Method | Path | Description |
|--------|------|-------------|
| GET | /film/projects/:id/locations | List locations |
| POST | /film/projects/:id/locations | Create location |
| GET | /film/locations/:id | Get location (with scenes) |
| PUT | /film/locations/:id | Update location |
| DELETE | /film/locations/:id | Delete location |
| GET | /film/projects/:id/props | List props |
| POST | /film/projects/:id/props | Create prop |
| GET | /film/props/:id | Get prop (with scene appearances) |
| PUT | /film/props/:id | Update prop |
| DELETE | /film/props/:id | Delete prop |

#### Notes & Reviews

| Method | Path | Description |
|--------|------|-------------|
| GET | /film/shots/:id/notes | List shot notes (?type=, ?unresolved=true) |
| POST | /film/shots/:id/notes | Add note to shot |
| PUT | /film/notes/:id | Update/resolve note |
| DELETE | /film/notes/:id | Delete note |
| POST | /film/shots/:id/review | Approve or reject shot |

#### Assets, Music & Color

| Method | Path | Description |
|--------|------|-------------|
| GET | /film/projects/:id/assets | List assets (?type=, ?shot_id=) |
| POST | /film/projects/:id/assets | Register asset |
| GET | /film/assets/:id | Get asset |
| DELETE | /film/assets/:id | Delete asset |
| GET | /film/projects/:id/music-cues | List music cues (?scene_id=, ?cue_type=) |
| POST | /film/projects/:id/music-cues | Create music cue |
| GET | /film/projects/:id/color-presets | List color presets |
| POST | /film/projects/:id/color-presets | Create color preset |

#### Dashboard & Milestones

| Method | Path | Description |
|--------|------|-------------|
| GET | /film/projects/:id/dashboard | Production stats (scenes, shots, assets, duration) |
| GET | /film/projects/:id/status-board | Per-scene/shot status breakdown |
| GET | /film/projects/:id/milestones | List milestones (auto-creates defaults) |
| POST | /film/projects/:id/milestones | Create milestone |
| PUT | /film/projects/:id/milestones/:mid | Update milestone |

#### Render Ledger & Reproducibility

| Method | Path | Description |
|--------|------|-------------|
| POST | /film/shots/:id/render | Log render params |
| GET | /film/shots/:id/renders | Render history (?step=) |
| GET | /film/shots/:id/versions | Shot version history |
| POST | /film/shots/:id/re-render | Re-render from ledger entry |

## Architecture

```
apps/film-engine/
├── gridlight.json              # App manifest
├── data/
│   └── film-engine.db          # SQLite database (auto-created)
├── src/
│   ├── index.html              # Frontend SPA
│   ├── app.json                # App config
│   └── assets/icon.svg
├── backend/
│   ├── server.js               # HTTP server + routing
│   ├── package.json
│   ├── db/
│   │   ├── database.js         # SQLite connection (better-sqlite3)
│   │   ├── schema.js           # Auto-migration on startup
│   │   ├── migrate.js          # CLI migration runner
│   │   └── migrations/         # 16 SQL migration files
│   ├── routes/
│   │   ├── projects.js         # Project CRUD
│   │   ├── scripts.js          # Script upload + versioning
│   │   ├── scenes.js           # Scene listing
│   │   ├── shots.js            # Shot creation + shot list
│   │   ├── breakdown.js        # AI breakdown assistant
│   │   ├── characters.js       # Characters, voice profiles, costumes
│   │   ├── locations.js        # Locations + props
│   │   ├── notes.js            # Shot notes + review workflow
│   │   ├── assets.js           # Asset registry, music cues, color presets
│   │   ├── dashboard.js        # Dashboard, status board, milestones
│   │   └── render-ledger.js    # Render logging + reproducibility
│   └── lib/
│       ├── screenplay-parser.js    # INT./EXT. scene heading parser
│       └── scene-card-schema.js    # Scene card validator
└── README.md
```
