# The Ableton sidecar

Film Engine keeps the score. Ableton Live is an editor it can talk to, through
a small process you run yourself beside Live: `backend/ableton-sidecar.js`. The
sidecar speaks [AbletonOSC](https://github.com/ideoforms/AbletonOSC) to Live
over UDP on this machine, and speaks HTTP to Film Engine on 127.0.0.1. It is
the transport under the `ableton` adapter of the DAW contract (MUS-016).

**Film Engine does not bundle AbletonOSC or any other Ableton component.** It
does not ship, vendor or download one, and nothing in this repository is a
Remote Script, a Max for Live device or a Live set. You install AbletonOSC yourself, from its own
repository, at the commit named below.

## What is supported

| | |
|---|---|
| AbletonOSC | commit `0ca6821` (2025-11-19), from https://github.com/ideoforms/AbletonOSC |
| Live | 12.4.5, the reviewed build |

AbletonOSC reports Live's **major and minor** version only. The sidecar can
therefore prove 12.4 and cannot prove the 12.4.5 bugfix. Check it yourself in
Live › About Live. A Live that reports any other version is connected and can
be read, and every change to it is refused (HTTP 409) until that version has
been reviewed.

## Installing AbletonOSC

1. Quit Live.
2. Clone AbletonOSC and check out the pinned commit:

   ```bash
   git clone https://github.com/ideoforms/AbletonOSC.git
   cd AbletonOSC && git checkout 0ca6821
   ```

3. Copy (or symlink) the `AbletonOSC` folder into Live's **Remote Scripts**
   folder, keeping the folder name `AbletonOSC`:
   - macOS: `~/Music/Ableton/User Library/Remote Scripts/`
   - Windows: `\Users\<you>\Documents\Ableton\User Library\Remote Scripts\`
4. Start Live. In Settings › Link, Tempo & MIDI, set a **Control Surface** slot
   to `AbletonOSC`. Live shows "AbletonOSC: Listening for OSC on port 11000".

AbletonOSC listens on UDP **11000** and replies on UDP **11001**, to the
address that asked.

## Running the sidecar

```bash
export ABLETON_SIDECAR_TOKEN=$(openssl rand -hex 24)
node backend/ableton-sidecar.js
```

| Variable | Default | |
|---|---|---|
| `ABLETON_SIDECAR_TOKEN` | *(required)* | 24 characters or more; every caller must present it |
| `ABLETON_SIDECAR_PORT` | `3190` | the sidecar's HTTP port, on 127.0.0.1 only |
| `ABLETON_OSC_HOST` | `127.0.0.1` | must be loopback: the sidecar talks only to a Live on this machine |
| `ABLETON_OSC_SEND_PORT` | `11000` | where AbletonOSC listens |
| `ABLETON_OSC_RECV_PORT` | `11001` | where AbletonOSC replies |

The sidecar is separately permissioned. The Film Engine server never starts it
and has no connection to Live of its own. The sidecar runs only while you run
it, listens on loopback only, refuses any caller without the token (401),
refuses a non-loopback OSC host at startup, and does only the typed operations
on its allowlist (`GET /ops` lists them). It has no generic OSC address, no
property setter and no delete.

`GET /health` shows whether Live is connected, its version, whether that
version is the reviewed one, the pinned commit, the last heartbeat, the round
trip, pending requests, reconnects and the last error.

## What a push does, and what it does not

A push creates one audio track per stem, at the end of the set. Each track's
name carries a marker such as `strings ⟨fe:3a9c01b2d4⟩`. Live has no stable
track id over OSC, so the marker is how Film Engine recognises its own tracks
the next time. A track without a marker is somebody else's, and the sidecar
never changes it. If you rename a Film Engine track in Live and keep the
marker, the next push reports a conflict rather than overwriting your name.
Delete the marker and Film Engine no longer considers the track its own.

The push also sets the song tempo to the first entry of the session's tempo
map. Tempo automation is not writable over OSC.

AbletonOSC cannot do two things, and the sidecar does not pretend otherwise:

- **It cannot place audio from a file.** Each push acknowledgement names the
  stem for every track. Drag each stem from the score package's `stems/` folder
  onto its Film Engine track at bar 1.1.1. Every stem is the same length and
  starts at zero, so one drop per track aligns the score.
- **It cannot export a render.** A pull from Ableton is always empty, with the
  reason. Export stems from Live (File › Export Audio) and bring them back
  through the score package import. That import validates them by hash and
  alignment and lands them as candidate takes.

Transport (play, stop, locate) is supervised: a person must ask for it. Locate
converts milliseconds to beats at Live's current tempo.

## Troubleshooting

Start with Film Engine's own health report: `GET /film/music-sessions/health`,
or the `music_health` tool. It tells you whether the adapter is configured and
why not. With `probe=true` it also asks the sidecar whether it answers. It never
shows the token. The sidecar answers with these status codes:

- **401**: the caller did not send the sidecar's token, or sent a different
  one. Film Engine's `ABLETON_SIDECAR_TOKEN` must be exactly the same as the
  sidecar's.
- **403**: the operation is not on the allowlist (`GET /ops` lists the ones
  that are), or it tried to change a track whose name does not carry Film
  Engine's `⟨fe:…⟩` marker. The sidecar changes no other track.
- **400**: the body is not JSON, or an operation's arguments are the wrong
  type or out of range. The message names the argument.
- **404**: the path is not one the sidecar serves. It serves only
  `GET /health`, `GET /ops` and `POST /op`.
- **413**: the body is over the limit. An operation is a name and a few
  arguments. Audio is never sent through the sidecar.
- **503**: the sidecar is running, but it has no connection to Live. The
  message gives the reason. When Film Engine answers 503 itself, its adapter
  is not configured: set `ABLETON_SIDECAR_TOKEN`, plus `ABLETON_SIDECAR_URL`
  if the sidecar is not on port 3190.
- **502**: Live answered, but its answer does not confirm the change. For
  example, the tempo, a track name or the transport reads differently
  afterwards. Read the set before trying again. The DAW contract records the
  outcome as failed.
- **"Live did not complete the handshake"**: Live is not running, AbletonOSC
  is not selected as a control surface, or something else holds port 11001
  (only one program can receive AbletonOSC's replies).
- **409 "not the reviewed version"**: Live reports a version other than 12.4.
  Reads still work, and changes wait for a review of that version.
- **504**: Live accepted the request and did not reply in time. It may be busy
  (a large set loading). The request fails on its own; nothing else does.
- **Reconnects in /health**: Live restarted or the heartbeat was lost. The
  sidecar handshakes again, because a relaunched Live may be a different
  version.

## How it is tested

`backend/tests/ableton-sidecar.test.js` runs over real UDP against
`backend/lib/daw/fake-live.js`, a harness that speaks the AbletonOSC subset
above. It covers out-of-order replies, lost replies, errors, silence, a
version mismatch and a restart. It proves the protocol, not Live. Before a
release, repeat the push against a real Live 12.4.5 with AbletonOSC at
`0ca6821`.
