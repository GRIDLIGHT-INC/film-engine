# Film Engine

AI film production pipeline for Gridlight. Transforms screenplays into editor-ready output through automated scene breakdown, storyboarding, and asset generation.

## Getting Started

### Prerequisites
- Node.js 18+

No external database required — Film Engine uses SQLite (via `better-sqlite3`), which stores data locally in `data/film-engine.db`.

### Install & Run

```bash
cd backend
npm install
node server.js
```

Server runs on `http://localhost:3100`. The database auto-initializes on first run with 28 migrations.

### Create Your First Project

1. Open `http://localhost:3100` in your browser (or open `src/index.html` directly)
2. Click **+ New Project** — enter a title, logline, genre, style preset, and target FPS
3. Navigate to **Screenplay** — paste or write your screenplay in Fountain format
4. The editor auto-detects scene headings (`INT.`/`EXT.`), characters, and dialogue
5. Go to **Scenes** and click **Break Down All New Scenes** to extract scene cards
6. Review shots in the **Shot Board** (Kanban view) or **Storyboard** (grid view)
7. Use **Export** to download FCPXML, EDL, Premiere XML, FDX, or SRT files

### Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PORT` | `3100` | Server port |
| `FILM_DATA_DIR` | `./data` | Database and asset storage directory |
| `IMAGEGEN_URL` | `http://localhost:8080` | ImageGen API for storyboard generation |
| `IMAGEGEN_API_KEY` | — | Bearer token for ImageGen |
| `VOICETTS_URL` | `http://localhost:8081` | Voice TTS API |
| `VIDEOGEN_URL` | `http://localhost:8082` | Video generation API |
| `MUSICGEN_URL` | `http://localhost:8083` | Music generation API |

## Screenplay Editor

The built-in screenplay editor supports the [Fountain](https://fountain.io/) markup format:

- **Auto-formatting**: Type scene headings (`INT.`/`EXT.`), character names (ALL CAPS), and dialogue with automatic element detection
- **Keyboard shortcuts**: Tab to cycle element types, Enter for smart continuation
- **Scene navigator**: Sidebar with drag-drop scene reordering
- **Title page editor**: Title, author, credit, date, contact, and draft date fields
- **Character autocomplete**: Suggests character names as you type in character cues
- **Statistics**: Real-time word count, page estimate, scene/dialogue breakdown
- **AI assistant**: Brainstorm, write scenes, rewrite dialogue, or convert prose to screenplay format
- **Inline comments**: Add comments to specific lines with toggle visibility
- **Revision tracking**: Color-coded revisions (white → blue → pink → yellow → green → goldenrod → buff → salmon → cherry)
- **Import/Export**: Import FDX (Final Draft), export to Fountain, plain text, PDF, and FDX

## Export Formats

| Format | Extension | Description |
|--------|-----------|-------------|
| FCPXML 1.11 | `.fcpxml` | Final Cut Pro native timeline with clips, markers, audio lanes |
| CMX 3600 EDL | `.edl` | Universal edit decision list (24fps non-drop frame) |
| Premiere XML | `.xml` | FCP 7 xmeml v5 format (works with Premiere, Resolve, etc.) |
| FDX | `.fdx` | Final Draft Version 5 XML screenplay |
| SRT | `.srt` | Subtitle file generated from dialogue |

## Production Pipeline

Film Engine orchestrates a 9-step per-shot pipeline:

1. **Keyframe** — Generate storyboard frame from scene card (SDXL)
2. **Video** — Animate keyframe to video clip (AnimateDiff)
3. **Voice** — Text-to-speech for dialogue lines (Qwen3-TTS)
4. **Lip-sync** — Sync character mouth movements to audio (Wav2Lip)
5. **Music** — Generate score and sound effects (MusicGen)
6. **SFX** — Generate sound effects from scene descriptions
7. **Ambient** — Generate ambient audio for locations
8. **Post** — Apply color grading, upscaling, encoding (RealESRGAN)
9. **Assembly** — Stitch clips, mix audio, generate final output

Steps are scheduled by the GPU memory-aware scheduling engine, which batches by model to minimize VRAM swaps.

## Testing

```bash
cd backend

# Run all unit tests (251 tests)
node --test tests/*.test.js

# Run specific test suites
node --test tests/fdx-generator.test.js
node --test tests/storyboard-prompt.test.js
node --test tests/nle-export.test.js
node --test tests/audio-mixer.test.js

# Run integration tests (starts server on random port)
node --test tests/integration.test.js

# Health check
curl http://localhost:3100/api/health
```

## Troubleshooting

### Server won't start
- Ensure `better-sqlite3` is installed: `cd backend && npm install`
- Check port availability: `lsof -i :3100`
- Verify Node.js version: `node --version` (requires 18+)

### ECONNREFUSED for ImageGen / Voice / Video
- These errors mean external AI services are not running. Film Engine works without them — storyboard generation, voice synthesis, and video generation will fail gracefully.
- Set the service URLs via environment variables (see Configuration above).

### Database issues
- Delete `data/film-engine.db` to reset the database. It will be recreated on next startup.
- The database auto-migrates on startup. If a migration fails, check the error message — it usually indicates a conflicting schema change.

### Frontend not loading
- Open `src/index.html` directly in a browser, or serve it via a static file server.
- Ensure the API URL in Settings matches your server address (`http://localhost:3100` by default).

## Architecture

See [CLAUDE.md](CLAUDE.md) for full architecture documentation, and [docs/adr/](docs/adr/) for architecture decision records.

## API Documentation

Full API reference: [docs/api-film.md](docs/api-film.md)
