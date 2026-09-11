# The music workstation

A score session is a soundtrack written against a picture sequence (or a single
scene when there is no sequence). It holds tracks, clips, an emotional arc,
markers and automation, and it records every operation on it. It is rendered by
a deterministic bounce. Once approved, the whole film uses it: the timeline,
playback, the audio mix, the pipeline, NLE exports and the conformed master.

This page explains how to run the workstation. Every route is listed in
[`api-film.md`](api-film.md#score-sessions-music-workstation), and every MCP tool
in [`claude-desktop-guide.md`](claude-desktop-guide.md). Installing and
troubleshooting Ableton is in [`ableton-sidecar.md`](ableton-sidecar.md).

## The production workflow

These are the steps from a screenplay passage to the film's soundtrack. The
steps marked **free** spend nothing. The steps marked **spends** reach a paid
provider, and each one has a free plan you can read first.

1. **Open a session** over a picture sequence (`music_session_create`, or the
   Score page). The session is stamped with the brief it was written
   against. The brief records the screenplay version and passage, the shots in
   order with their measured timings and cameras, the cast and how much each
   character talks, the look, the cues already written, and the accepted arc.
2. **Read the brief** (`music_session_brief`, free). Every field names the rows
   it came from.
3. **Decide the arc.** The connected agent proposes it from
   `music_emotion_brief` (free) and stores the proposal with
   `music_emotion_propose`. A person accepts it, range by range, with
   `music_emotion_accept` or the inspector. Until someone accepts it, a
   proposal does not reach any paid request.
4. **Bring in music**, in any mix of these ways:
   - Import a composer's stems (`music_stem_import`). The originals are stored
     byte for byte, and every stem is placed at one shared start.
   - Generate a cue (`music_generate_plan` is free; `music_generate` spends).
   - Separate a recording into two or six stems (`music_separate_plan` is
     free; `music_separate` spends).
   - Import a portable package that came back from a DAW
     (`music_package_import`).

   A new output is always added as a candidate take and never replaces
   anything.
5. **Arrange** on the Score page, or with the `music_track_*`, `music_clip_*`,
   `music_marker_*` and `music_automation_*` tools. Playback in the page is
   free.
6. **Bounce** (`music_bounce_plan` is free; `music_bounce` renders locally
   with ffmpeg). The bounce produces a 48 kHz master plus delivery stems, all
   the same length. Bouncing an unchanged session is refused as `UNCHANGED`.
7. **Approve** (`music_session_approve`). Approval selects one bounce as the
   mix. It is refused if the bounce is older than the session's last change,
   and if a source's rights block it under the policy described below.
8. **Check what the film uses** (`music_score_report`, free). It shows every
   approved mix, where it sits on the timeline, and every session that is not
   used, with the reason.
9. **Conform** the film. The master mixes the approved score over the film's
   audio at the right offset. A conform is refused while a source's rights
   block final export.

With Ableton, three steps are added between 5 and 7:
`ableton_score_push_plan` then `ableton_score_push` sends the session to Live;
you mix in Live; `ableton_mix_pull_plan` then `ableton_mix_pull` brings the
render back as candidate takes. Anything the DAW can do, the portable package
can also do, so the whole workflow also runs without Ableton.

## Configuration

| Variable | Read by | Default | What it does |
|---|---|---|---|
| `ABLETON_SIDECAR_TOKEN` | the sidecar and this server | none | Required by both processes, and the same value in each. The sidecar refuses to start with a token shorter than 24 characters. The server treats the Ableton adapter as not configured until the token is set. The health report never shows it. |
| `ABLETON_SIDECAR_URL` | this server | `http://127.0.0.1:3190` | Where the sidecar listens. It must be a loopback address. |
| `ABLETON_SIDECAR_PORT` | the sidecar | `3190` | The port the sidecar listens on, on 127.0.0.1 only. |
| `ABLETON_OSC_HOST` | the sidecar | `127.0.0.1` | The host where Live runs. It must be a loopback address; the sidecar refuses to start with any other host. |
| `ABLETON_OSC_SEND_PORT` | the sidecar | `11000` | The port AbletonOSC listens on. |
| `ABLETON_OSC_RECV_PORT` | the sidecar | `11001` | The port AbletonOSC replies to. Only one program can use it at a time. |
| `FFMPEG_PATH` | render, package, import, conform | none | Use this encoder build. If it is not set, the engine tries the system `PATH`, then the package-manager directories, then the bundled `ffmpeg-static`. |
| `MUSIC_WRITTEN_PROMPT_LIMIT` | cue prompts | `4000` | The ceiling on a prompt the director wrote. A derived prompt keeps 600. |
| `ELEVENLABS_API_KEY` | generation, separation | none | The music provider's key. You can also store it once, for the whole machine, in Provider Settings. |
| `FILM_DATA_DIR` | everything | `~/.gridlight/film-engine/data` | The database and every stored file. |

Setting:

| Setting | Where | What it does |
|---|---|---|
| `music_rights_policy` | `GET/PUT /film/settings` | Overrides the default warn/block policy (see below) for one gate and status at a time. It is validated before anything is written. |

## Provider capabilities

The music capability has six workflows. Every provider that serves `music`
reports a status for each workflow, and a "no" always comes with a reason. The
live answer for a project is `GET /film/projects/:id/music/capabilities`
(`music_capabilities`, free). This table shows the default contracts.

| Workflow | gridlight | elevenlabs | What it is |
|---|---|---|---|
| `music_compose` | available: 1 s to 10 min | available: 3 s to 10 min, `music_v1`/`music_v2`, sections of 3 to 120 s | a whole cue from a brief |
| `music_parts` | unsupported: no endpoint for native parts | unsupported: one mixed cue only | the native instrument parts of one cue |
| `music_separate` | unsupported: no separation endpoint | available: 2 or 6 stems; wav, aiff, flac, mp3, m4a in | a recording split into stems, kept beside its source |
| `music_reference` | unsupported | unsupported: prompt or plan only | a cue conditioned on reference audio or a melody |
| `music_video` | unsupported | unsupported: no picture input | a cue conditioned on the picture |
| `music_inpaint` | unsupported | unsupported: whole cues only | a range regenerated in context |

Each output is stored as one of six kinds, and the clip records which:
`whole_cue`, `native_part`, `separated_stem`, `inpainted_range`,
`rendered_stem` and `imported_file`. A native part, a separated stem and a
rendered delivery stem are three different kinds of file, and they stay
separate.

## Rights

Every file in a score has an origin and a rights status, and a derived file
takes its status from its sources:

- **Origins:** `original`, `generated`, `licensed`, `public_domain` and
  `unknown`, plus `derived` for the rows that separation, bounces and DAW
  returns write.
- **Statuses:** `cleared`, `unknown`, `restricted`, `expired` and `blocked`.

A derivative carries the most restrictive status among its sources, in the
order blocked > expired > restricted > unknown > cleared. The engine never
assumes a status. A generated file gets the origin `generated` and the status
`unknown`, never `cleared`.

The policy at each gate is:

| Status | approval | final_export |
|---|---|---|
| `cleared` | allow | allow |
| `unknown` | warn | warn |
| `restricted` | warn | warn |
| `expired` | warn | block |
| `blocked` | block | block |

`approval` refuses with `RIGHTS_BLOCKED`. `ignore_rights` overrides the refusal
and the override is recorded. `final_export` stops the conform (in the
`rights_blocked` state) and appears as `SCORE_RIGHTS` in the export preflight.
The default policy is a stated position on the epic's Open Question 3, and
`music_rights_policy` can change it. `music_score_lineage` (free) traces every
clip and mix back to its sources.

## What consumes an approved score

The approved mix is used exactly once by each of these: `timeline`, `playback`,
`audio_mix`, `pipeline`, `nle_export` and `conform`. The scene music under the
mix is dropped. `music_score_report` puts every session in one of these
states:

- `unapproved`
- `stale`: still used, but the session or the picture changed after approval
- `missing`: no mix, or the mix file is gone
- `unplaced`
- `overlapping`
- `shadowed`: a finished project mix replaces it

## Operations and health

`GET /film/music-sessions/health` (`music_health`, free) is the report to read
first when something looks stuck. It groups every operation into an area:

| Area | Covers | Recovery |
|---|---|---|
| `render` | bounces | Read the bounce plan, fix what it names, then bounce again (`force` if nothing changed). A failed render registers nothing. |
| `generation` | generation jobs | `music_job_poll` settles an interrupted job; `music_job_retry` runs it again (spends). |
| `separation` | separations | `music_separation_retry` (spends). A failed separation registers no stems. |
| `package` | package builds and package imports | Rebuild the package, or validate it before importing. A refused import writes nothing. |
| `daw` | DAW pushes and pulls | Check the adapter, read `music_daw_audit`, then plan again and push with the same idempotency key. |
| `import` | stem imports | Import the batch again. A refused batch writes nothing and names the file that caused the refusal. |
| `record` | edits, rebases, approvals, emotion records | Nothing runs here, so a record never stalls. |

What counts as stalled depends on the area:

- A generation or separation is **stalled** while it shows `running` but no
  process owns it. That happens when the server restarts mid-job.
- Any other operation is stalled when it is still `running` after 30 minutes,
  which is far longer than any of their time limits.

For each area the report gives the recent failures, each with its session and
how to recover. It also shows whether the encoder is available and where it
came from, and whether each DAW adapter is configured. Add `probe=true` to also
check whether each configured DAW responds. The report keeps error text but
shortens every absolute path to its file name. It never includes a token, a
key, or the path to the encoder.

## Backup and restore

- **Database snapshot.** Snapshot the whole install with SQLite's
  `VACUUM INTO`, never with `cp`, because the database runs in WAL mode and a
  copied file can be torn. Copy the asset folders beside it. On this install,
  `~/film-engine-backups/backup.sh` does both every six hours and verifies the
  result. To restore, stop the server, put the database file and its asset
  folders back, and start the server.
- **Project bundle.** `GET /film/projects/:id/bundle` exports one project,
  and `POST /film/projects/import` restores it on any machine with new ids.
  The bundle carries every score table: `film_music_cues`,
  `film_music_sessions`, `film_music_tracks`, `film_music_clips`,
  `film_music_emotion_ranges`, `film_music_markers`, `film_music_automation`,
  `film_music_operations` and `film_music_daw_links`.
  - The manifest holds a sha256 for every file, and all hashes are checked
    before anything is written.
  - Paths are rebuilt under the new machine's data directory.
  - The fingerprints of every bounce are updated for the new ids, so a
    session that was current before export can still be approved after import
    without a stale refusal.
  - A score row that points at nothing refuses the whole import.
- **JSON backup** (`/film/projects/:id/backups`). This is the older, lighter
  backup, and it does **not** include score sessions. Use a bundle or a
  database snapshot for those.
- **Portable score package.** This is for handing one session to a DAW or to
  a person, not for backup. It is byte-stable, and its import adds candidate
  takes rather than replacing anything.

## Migration notes

Every migration runs automatically on start. Back up the database before
starting a server that will apply a new migration to live data.

| Migration | What it adds | Notes |
|---|---|---|
| `105_music_workstation.sql` | the seven score tables | Every foreign key declares what happens on delete. Removing a sequence or asset sets its references to NULL, and the arrangement stays. |
| `106_emotion_proposals.sql` | `rationale`, `proposal_id` on emotion ranges | Existing ranges keep an empty rationale. |
| `107_music_job_children.sql` | `group_id`, `seq`, `attempt`, `take_number`, `output_clip_id`, fingerprints on operations | Existing operations become parents with no children. |
| `108_music_daw_links.sql` | `film_music_daw_links` | One DAW item per Film Engine key per adapter. |
| `109_rights_origin.sql` | `origin` on `film_rights` | Existing rows read `unknown`, a recorded answer rather than a guess. |
