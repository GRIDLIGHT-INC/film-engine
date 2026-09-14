# The instrument sidecar — your own libraries, inside Film Engine

Film Engine writes a cue's notes (parts over a harmonic plan). This plays them
through the instruments installed on this machine — Kontakt and the libraries
you own — and lands the audio on the track, without a DAW open and without
sending anything to a provider.

It runs as a **separate process you start**, exactly like the Ableton sidecar,
and for a stronger reason: it loads third-party plugin code into itself. So it
listens on 127.0.0.1 only, answers only a caller carrying its token, and loads
only plugins that live where macOS installs them.

## Install

```bash
cd backend
python3 -m venv .venv
./.venv/bin/pip install dawdreamer numpy
```

DawDreamer is the plugin host (JUCE underneath). It ships prebuilt wheels for
macOS on Intel and Apple Silicon, Python 3.11–3.14, and hosts VST3, VST and
AudioUnit.

## Run

```bash
INSTRUMENT_SIDECAR_TOKEN=$(openssl rand -hex 16) \
  backend/.venv/bin/python backend/instrument-sidecar.py
```

Give Film Engine the same token:

| Variable | Default | What it is |
|---|---|---|
| `INSTRUMENT_SIDECAR_TOKEN` | — | Required, 24+ characters. Every caller presents it; a short one is guessable. |
| `INSTRUMENT_SIDECAR_PORT` | `3191` | The sidecar's port. It binds 127.0.0.1 only. |
| `INSTRUMENT_SIDECAR_URL` | `http://127.0.0.1:3191` | Where Film Engine looks for it. A non-loopback host is refused. |

## What it does, and what it cannot

| Operation | What it does |
|---|---|
| `instruments` | Lists the plugins installed in the standard folders. |
| `capture` | Opens a plugin's own editor so you load a patch, then keeps the state that recalls it. Supervised: it puts a window in front of you. |
| `render` | Plays a part's MIDI through a plugin holding a state, and returns the audio. |

Two things no plugin host can do, stated so nothing is built toward them by
accident:

* **Pick a patch inside a library unaided.** A plugin exposes its *state*, not
  its browser — Kontakt has no API that loads an `.nki` by path. Either capture
  the state once through the editor, or read an NKS preset, whose `PCHK` chunk
  *is* that state.
* **Play live from the page.** This renders offline and returns a file. Live
  monitoring would need an audio server and a stream. Rendering is far faster
  than real time, and the result is heard in the Score page like any other clip.

## How a render is judged

The same rule as every other render here: the file is cut to the part's length,
read back, and **refused if it is silent**. Silence is the normal answer when a
plugin state holds no patch, so it is caught rather than kept as a take that
plays nothing.

## Measured on the development machine

Intel Mac Pro, macOS 15, Kontakt 8, 2026-09-14:

* Kontakt 8 VST3 loads headless in **0.9 s**, reporting 4145 parameters and 64
  outputs (the render takes the main stereo pair).
* `save_state` is **5344 bytes** for an empty Kontakt; `load_state` reads it back.
* Three seconds of audio rendered in **0.1 s**.

## Troubleshooting

| What you see | What it means |
|---|---|
| `INSTRUMENT_SIDECAR_TOKEN is not set` | Film Engine has no token. Set the same one you started the sidecar with. |
| `points at <host>` | The URL is not loopback. Film Engine only talks to a sidecar on this machine. |
| `the instrument sidecar is not answering` | It is not running, or it is on another port. |
| 401 | The tokens do not match. |
| 403 `not an operation` / `outside the folders` | The allowlist refused it: an unknown operation, or a plugin outside `/Library/Audio/Plug-Ins` and `~/Library/Audio/Plug-Ins`. |
| 503 `the plugin host library is not installed` | The venv has no `dawdreamer`. Install it as above. |
| `silence` | The render played nothing — the state holds no patch, or the library is not installed. |
