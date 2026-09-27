# Film Engine

[![Version](https://img.shields.io/badge/version-1.0.1-blue)](https://github.com/GRIDLIGHT-INC/film-engine/releases/tag/v1.0.1)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933)](https://nodejs.org)

Film Engine takes a film from a screenplay to a finished movie in one app. You
write the screenplay, break it into scenes and shots, design the characters,
locations and props, generate storyboards and previs, generate video, voices,
music and sound, and assemble and export the cut to Premiere, Final Cut or
Resolve.

It runs **on your own machine**. There is a small Node.js API, a single-page web
app, and a SQLite database. AI generation goes to the providers you connect
with your own API keys. The reasoning (writing, breakdowns, scene cards) runs in
**Claude Desktop** (or another MCP host) over MCP, so no LLM API key is needed.

---

## Contents

1. [What you need](#what-you-need)
2. [Install](#install)
3. [Run it](#run-it)
4. [Connect AI providers](#connect-ai-providers)
5. [Connect Claude (MCP)](#connect-claude-mcp)
6. [Your first film](#your-first-film)
7. [Where your data lives](#where-your-data-lives)
8. [Optional extras](#optional-extras)
9. [Configuration reference](#configuration-reference)
10. [Tests](#tests)
11. [Troubleshooting](#troubleshooting)
12. [Project layout](#project-layout)

---

## What you need

| | Required? | Notes |
|---|---|---|
| **macOS, Linux or Windows** | yes | Developed on macOS. Everything except the optional music sidecars runs anywhere Node does. |
| **Node.js 20 or newer** | yes | Tested on Node 23. Check with `node -v`. Get it from [nodejs.org](https://nodejs.org) or `brew install node`. |
| **npm** | yes | Comes with Node. |
| **A C/C++ build toolchain** | usually not | `better-sqlite3` ships prebuilt binaries for common platforms. If `npm install` tries to compile it: macOS `xcode-select --install`, Ubuntu `sudo apt install build-essential python3`, Windows "Desktop development with C++" from the Visual Studio Build Tools. |
| **A modern browser** | yes | Chrome, Safari, Edge or Firefox. |
| **Claude Desktop** (or another MCP host) | recommended | This is how the AI writing and reasoning reach your projects. See [Connect Claude](#connect-claude-mcp). |
| **API keys** for the generators you want | for generation | You can write, break down, plan and export with no keys at all. See [Connect AI providers](#connect-ai-providers). |
| **ffmpeg** | no | A copy is bundled (`ffmpeg-static`). A system ffmpeg is used first if one is installed. |
| **FluidSynth**, **Python 3**, **Ableton Live** | no | Only for the optional music tools. See [Optional extras](#optional-extras). |

Disk space: the app itself is small. Generated media is not: plan on a few GB
per film if you generate video.

---

## Install

```bash
git clone https://github.com/GRIDLIGHT-INC/film-engine.git
cd film-engine/backend
npm install
```

That is the whole install. There is no database server to set up: SQLite runs
inside the API, and the database and every migration are created automatically
the first time the server starts.

---

## Run it

Film Engine is two small processes. Open two terminals.

**1. The API** (port 3100):

```bash
cd film-engine/backend
node server.js
```

You should see it listening on `http://localhost:3100`. Check it with:

```bash
curl http://localhost:3100/api/health
# {"status":"ok","service":"film-engine","version":"1.0.1"}
```

**2. The web app** (port 3200), from the repository root:

```bash
cd film-engine
node backend/dev-server.js
```

Then open **http://localhost:3200** in your browser.

The page server sends no cache headers, so a code change shows up on a normal
reload. It only listens on your own machine. To open the app from a phone or
another computer on your network, start it with `FILM_ENGINE_HOST=0.0.0.0 node
backend/dev-server.js`. Be aware that **there is no login**: anyone who can
reach the machine can read and change your projects.

---

## Connect AI providers

Open the app → **Setup** (top bar) → **Providers**, paste a key for each
service you want, and pick which provider each capability uses. Keys are
stored once for the whole machine, not per project. Alternatively, set them as
environment variables before starting the API: `<PROVIDER>_API_KEY`, e.g.
`export MUAPI_API_KEY=…`. An environment variable wins over a stored key.

| Provider | Env var | Used for |
|---|---|---|
| **MuAPI** (house provider) | `MUAPI_API_KEY` | Images (Nano Banana Pro), Seedance 2.5 video. The same MuAPI key also works as `SEEDANCE_API_KEY`. |
| Google (Gemini API) | `GOOGLE_API_KEY` | Nano Banana Pro images (fallback vendor) |
| Meshy | `MESHY_API_KEY` | Images (fallback), 3D models |
| Runway | `RUNWAY_API_KEY` (or `RUNWAYML_API_SECRET`) | Video (Gen-4.5, Gen-4 Turbo, Veo 3.1, Hailuo 3, Seedance), video-to-video |
| ElevenLabs | `ELEVENLABS_API_KEY` | Voices, dialogue, sound effects, ambience, music |
| World Labs (Marble) | `WORLDLABS_API_KEY` | 3D worlds from a location's plates, for previs |
| OpenAI | `OPENAI_API_KEY` | Images (optional) |
| Black Forest Labs | `BFL_API_KEY` | FLUX images (optional) |
| Anthropic | `ANTHROPIC_API_KEY` | Only if you want the few server-side AI features without Claude Desktop. Not needed otherwise. |

**Images always use Nano Banana Pro**, at the resolution set in each project's
**Settings → Technical** (2K by default, up to 4K). MuAPI is tried first, then
Google and Meshy, which sell the same model.

**Nothing spends without asking.** Every paid button shows the prompt, the
provider, the model and the cost first, and generates only after you confirm.

---

## Connect Claude (MCP)

Film Engine exposes about 370 tools over the Model Context Protocol. With
Claude Desktop connected you can say *"write scene 3 again, darker"*, *"break
the screenplay into shots"* or *"explore four angles on shot 2B"*, and Claude
does the work directly in your projects. Your Claude subscription does the
reasoning, so Film Engine needs no LLM key.

1. Find your data directory. By default it is `~/.gridlight/film-engine/data`
   (see [Where your data lives](#where-your-data-lives)).
2. Open Claude Desktop → **Settings → Developer → Edit Config**, and add
   Film Engine to `claude_desktop_config.json`, using **absolute paths**:

   ```json
   {
     "mcpServers": {
       "film-engine": {
         "command": "node",
         "args": ["/ABSOLUTE/PATH/TO/film-engine/backend/mcp-server.js"],
         "env": { "FILM_DATA_DIR": "/Users/YOU/.gridlight/film-engine/data" }
       }
     }
   }
   ```

   `FILM_DATA_DIR` must be the **same** directory the API uses. Otherwise Claude
   works on an empty set of projects while the app shows your films.
3. Quit and reopen Claude Desktop. **Film Engine** should appear in its tools
   list.

The API does not need to be running for MCP to work, since both read the same
database. Run it anyway to watch Claude's changes appear in the app live.
Claude Desktop loads the tool list once at launch, so restart it after pulling
new code.

Every tool, in the order the work is done: [`docs/claude-desktop-guide.md`](docs/claude-desktop-guide.md).

---

## Your first film

1. **New Project**: give it a title and choose the folder its files are saved
   in (default `~/Film Engine/<Title>`).
2. **Screenplay**: write or paste a screenplay in [Fountain](https://fountain.io)
   markup, or import a Final Draft (`.fdx`) or `.docx` file. Click the
   **Title page** card above the page to set the title, author and draft date.
3. **Break it down**: ask Claude to break the screenplay into shots, or select
   lines and tag them as shots. Characters, locations and props are created
   from the screenplay.
4. **Design**: give each character, location and prop a description, then
   generate or upload its reference plates.
5. **Look**: set the film's look on the Mood Board.
6. **Storyboard**: generate a frame for each shot, or use **4 angles** to
   explore four cameras and pick one. Refine, recompose, lock the board when
   it's final.
7. **Previs** (optional): block shots in 3D and approve camera moves.
8. **Production**: generate video for each shot, dialogue for each line, and
   the score and sound for each scene.
9. **Post**: play it back, assemble the master, and **Export** FCPXML, Premiere
   XML or EDL (with the media packaged) to finish in your editor. Print the
   screenplay as a PDF shooting script: scene numbers in both margins, page
   eighths under the right-hand number.

A 30-second test screenplay lives at
[`backend/tests/fixtures/thirty-second.fountain`](backend/tests/fixtures/thirty-second.fountain)
if you want to take something small all the way through cheaply.

To check what is and isn't ready for a project before spending anything:

```bash
cd backend
node preflight.js <project-id>   # readiness of every stage, exits 1 if something is blocked
node dry-run.js <project-id>     # exactly what every provider would be sent, nothing sent
```

---

## Where your data lives

| What | Where |
|---|---|
| Database | `~/.gridlight/film-engine/data/film-engine.db`, or `$FILM_DATA_DIR/film-engine.db` |
| A project's files | the folder you chose for it: `01 References`, `02 Storyboard`, `03 Previs`, `04 Video`, `05 Edit`, `06 Sound`, `07 Delivery` |
| Older projects | under the data directory, by kind |

The database runs in SQLite WAL mode. To back it up while the server is
running, **do not copy the file**. Take a consistent snapshot:

```bash
sqlite3 ~/.gridlight/film-engine/data/film-engine.db "VACUUM INTO '/path/to/backup.db'"
```

A whole project, files included, can also be exported as a bundle from the
project menu (`GET /film/projects/:id/bundle`) and imported on another machine.

---

## Optional extras

**FluidSynth** plays a cue's written notes through a SoundFont locally, for
free. `brew install fluid-synth` (macOS) or `sudo apt install fluidsynth`.
Point `FILM_SOUNDFONT` at a `.sf2` file whose licence you know. See
[`docs/music-workstation.md`](docs/music-workstation.md).

**Instrument sidecar**: play your own plugin instruments (Kontakt and the like)
from Film Engine without a DAW open. Needs Python 3 and `dawdreamer`. See
[`docs/instrument-sidecar.md`](docs/instrument-sidecar.md).

**Ableton Live sidecar**: push a score session into Ableton and pull the mix
back. Needs Live 12 and AbletonOSC. See
[`docs/ableton-sidecar.md`](docs/ableton-sidecar.md).

**iOS app**: the same web app in a native wrapper that talks to your Mac over
the local network. See [`ios/README.md`](ios/README.md).

---

## Configuration reference

All optional. Set them in the shell before starting `node server.js`, or in the
MCP config's `env` block for Claude.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3100` | API port |
| `FILM_DATA_DIR` | `~/.gridlight/film-engine/data` | Database and default media location. The API and MCP server must use the same one. |
| `FILM_PROJECTS_DIR` | `~/Film Engine` | Where new project folders are suggested |
| `FILM_ENGINE_HOST` | `127.0.0.1` | Set `0.0.0.0` to reach the web app from other devices (no login!) |
| `FILM_ENGINE_PUBLIC_URL` | — | A public URL for this server, used when a provider must fetch a frame from it |
| `CORS_ALLOWED_ORIGINS` | — | Extra origins allowed to call the API |
| `FFMPEG_PATH` | — | Use a specific ffmpeg instead of the system or bundled one |
| `<PROVIDER>_API_KEY` | — | Provider keys, see above |
| `FLUIDSYNTH_PATH`, `FILM_SOUNDFONT`, `FILM_SOUNDFONT_LICENSE` | — | Local instrument rendering |
| `GRIDLIGHT_ENABLED`, `GRIDLIGHT_URL`, `GRIDLIGHT_API_KEY` | off | An optional self-hosted generation gateway. Off unless switched on. |

The full API reference is in [`docs/api-film.md`](docs/api-film.md).

---

## Tests

```bash
cd backend
npm test
```

This runs about 4,600 tests against temporary databases. It never touches your
real data. The suite takes about three minutes. Keep `--test-concurrency=4`
(already in `npm test`): with one worker per CPU core, dozens of test servers
and ffmpeg processes start at once and the results become unreliable.

Run one file with `node --test tests/<name>.test.js`.

---

## Troubleshooting

**"Backend offline" in the app.** The API isn't running, or isn't on port 3100.
Start `node server.js` in `backend/` and check `curl http://localhost:3100/api/health`.

**The project list is empty but you have projects.** The API is using a
different data directory than before. Check `FILM_DATA_DIR`.

**Claude says a Film Engine tool doesn't exist.** Claude Desktop is still
running the tool list from when it started. Quit and reopen it after updating
Film Engine.

**Claude sees no projects, or different ones.** Its `FILM_DATA_DIR` doesn't
match the API's.

**`npm install` fails on `better-sqlite3`.** Install the build toolchain for
your OS (see [What you need](#what-you-need)) and use Node 20 or newer.

**A generation fails with 401 / invalid key.** Setup → Providers shows each key's
status. A key shorter than 8 characters is refused as a placeholder.

**A long generation "timed out" in Claude.** Claude stops waiting after about a
minute, but the provider usually finishes. Ask Claude to run
`generation_pending` and `generation_collect`, or see *Jobs* in the app. Nothing
paid for is lost.

**The PDF has a date or web address in the margins.** Update to the latest
version: the print now uses zero browser margins. If your browser still adds
them, untick *Headers and footers* in the print dialog.

---

## Project layout

```
film-engine/
├── backend/            Node.js API (server.js), MCP server (mcp-server.js), CLIs
│   ├── routes/         HTTP routes, one file per area
│   ├── lib/            the engine: prompts, providers, planning, media, export
│   ├── lib/providers/  one adapter per AI provider, auto-loaded
│   ├── db/migrations/  SQLite schema, applied automatically at start
│   └── tests/          node:test suite
├── src/index.html      the web app (a single file, no build step)
├── docs/               guides, API reference, design notes, ADRs
└── ios/                the iOS wrapper
```

The architecture, every subsystem and the reasons behind its design are
documented at length in [`CLAUDE.md`](CLAUDE.md).

---

## Licence

[MIT](LICENSE). Bundled third-party code and its licences are listed in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
