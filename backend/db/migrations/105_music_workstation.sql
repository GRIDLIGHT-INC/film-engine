-- THE SCORE SESSION: a multitrack arrangement that belongs to a picture unit.
--
-- film_music_cues (016) models ONE cue: a type, a direction, a length, one
-- generated asset. It has no notion of a session over an ordered sequence, of
-- tracks and clips, of takes, of automation, or of the picture and script it
-- was written against. Everything a finished soundtrack needs beyond one cue
-- lives here.
--
-- Named 105 rather than the 103 the epic wrote down: 103 and 104 had landed
-- (pipeline steps_skipped, run failures) before this was started.
--
-- Three rules this file follows throughout, each already paid for elsewhere:
--
--   1. EVERY foreign key declares ON DELETE. A key with no action turned a
--      project delete into a 500 the first time the project had real work in
--      it (film_refsheet_jobs, migration 067). CASCADE where the child is
--      meaningless without the parent; SET NULL where the child is work that
--      cost money and must outlive a pointer.
--   2. EVERY lifecycle value is a CHECK. A free-text status is three spellings
--      of one state within a week.
--   3. film_assets is NOT touched. Its asset_type CHECK cannot be widened in
--      place (042), so what a clip's audio IS — a native part, a separated
--      stem, a rendered stem, an import — is typed on the clip and in asset
--      metadata, the way the 3D work types a mesh.

-- A session is attached to an ordered picture sequence, or to a scene when a
-- project has no sequence. Losing the picture unit must not lose the score:
-- both pointers SET NULL, and the session keeps the fingerprints it was
-- written against so drift can still be reported.
CREATE TABLE IF NOT EXISTS film_music_sessions (
    id                    TEXT PRIMARY KEY,
    project_id            TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    sequence_id           TEXT REFERENCES film_sequences(id) ON DELETE SET NULL,
    scene_id              TEXT REFERENCES film_scenes(id) ON DELETE SET NULL,
    -- The exact screenplay version the brief was compiled from.
    script_id             TEXT REFERENCES film_scripts(id) ON DELETE SET NULL,
    name                  TEXT NOT NULL DEFAULT '',
    status                TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'arranging', 'review', 'approved', 'archived')),
    -- The picture workflow is 48 kHz; anything else is a stated choice.
    sample_rate           INTEGER NOT NULL DEFAULT 48000
                          CHECK (sample_rate IN (44100, 48000, 96000)),
    frame_rate            REAL NOT NULL DEFAULT 24,
    -- Constant tempo is the v1 case; the map is a JSON list of
    -- { at_ms, bpm, numerator, denominator } so a change is a row, not a
    -- schema change (epic Open Question 5).
    tempo_map_json        TEXT NOT NULL DEFAULT '[]',
    -- What the session was compiled AGAINST. Each is a hash the context
    -- compiler (MUS-003) produces; a mismatch is drift, reported, never
    -- silently rebased.
    script_fingerprint    TEXT NOT NULL DEFAULT '',
    picture_fingerprint   TEXT NOT NULL DEFAULT '',
    context_fingerprint   TEXT NOT NULL DEFAULT '',
    -- The mix a director signed off. SET NULL: the master is an asset that
    -- cost money and is registered on its own.
    approved_mix_asset_id TEXT REFERENCES film_assets(id) ON DELETE SET NULL,
    approved_at           TEXT,
    notes                 TEXT NOT NULL DEFAULT '',
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_film_music_sessions_project ON film_music_sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_film_music_sessions_sequence ON film_music_sessions(sequence_id);
CREATE INDEX IF NOT EXISTS idx_film_music_sessions_scene ON film_music_sessions(scene_id);
CREATE INDEX IF NOT EXISTS idx_film_music_sessions_script ON film_music_sessions(script_id);
CREATE INDEX IF NOT EXISTS idx_film_music_sessions_mix ON film_music_sessions(approved_mix_asset_id);

-- A track is a lane with a role and mixer state. `role_kind` is the compact
-- vocabulary; `role` is the flexible name inside it ("cello", "strings",
-- "music bus") so orchestral families and production buses both fit without
-- a second table (epic Open Question 1 is answered by data, not schema).
CREATE TABLE IF NOT EXISTS film_music_tracks (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL REFERENCES film_music_sessions(id) ON DELETE CASCADE,
    name        TEXT NOT NULL DEFAULT '',
    role_kind   TEXT NOT NULL DEFAULT 'instrument'
                CHECK (role_kind IN ('instrument', 'family', 'bus', 'reference', 'picture')),
    role        TEXT NOT NULL DEFAULT '',
    sort_order  INTEGER NOT NULL DEFAULT 0,
    color       TEXT NOT NULL DEFAULT '',
    gain_db     REAL NOT NULL DEFAULT 0,
    pan         REAL NOT NULL DEFAULT 0
                CHECK (pan >= -1 AND pan <= 1),
    muted       INTEGER NOT NULL DEFAULT 0
                CHECK (muted IN (0, 1)),
    soloed      INTEGER NOT NULL DEFAULT 0
                CHECK (soloed IN (0, 1)),
    -- A bus a track feeds; NULL is the session master.
    output_track_id TEXT REFERENCES film_music_tracks(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_film_music_tracks_session ON film_music_tracks(session_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_film_music_tracks_output ON film_music_tracks(output_track_id);

-- A clip places an IMMUTABLE asset on a track. Every edit — trim, move, gain,
-- fades, loop, warp, which take — is metadata here; the file is never touched.
-- The asset pointer is SET NULL: the arrangement is the work and the file is
-- replaceable, and a clip that lost its source says so rather than vanishing
-- and taking the placement with it.
--
-- `source_kind` is the three stem meanings the epic requires to stay
-- explicit — a native generated part, a source-separated derivative, a
-- rendered delivery stem — plus a whole generated cue and a user import.
CREATE TABLE IF NOT EXISTS film_music_clips (
    id                  TEXT PRIMARY KEY,
    track_id            TEXT NOT NULL REFERENCES film_music_tracks(id) ON DELETE CASCADE,
    asset_id            TEXT REFERENCES film_assets(id) ON DELETE SET NULL,
    -- The operation that produced this clip's audio, for lineage.
    source_operation_id TEXT REFERENCES film_music_operations(id) ON DELETE SET NULL,
    name                TEXT NOT NULL DEFAULT '',
    source_kind         TEXT NOT NULL DEFAULT 'generated'
                        CHECK (source_kind IN ('generated', 'native_part', 'separated', 'rendered', 'imported')),
    -- Timeline placement, in the session's clock (milliseconds, never beats:
    -- the cut is in milliseconds).
    start_ms            INTEGER NOT NULL DEFAULT 0,
    duration_ms         INTEGER NOT NULL DEFAULT 0,
    -- Where in the source the clip begins; leading silence is preserved by
    -- keeping this at 0 on import, never by trimming the file.
    source_offset_ms    INTEGER NOT NULL DEFAULT 0,
    gain_db             REAL NOT NULL DEFAULT 0,
    fade_in_ms          INTEGER NOT NULL DEFAULT 0,
    fade_out_ms         INTEGER NOT NULL DEFAULT 0,
    loop_policy         TEXT NOT NULL DEFAULT 'none'
                        CHECK (loop_policy IN ('none', 'loop', 'fill')),
    -- Implicit warping is prohibited; a warp is a recorded choice.
    warp_policy         TEXT NOT NULL DEFAULT 'none'
                        CHECK (warp_policy IN ('none', 'preserve_pitch', 'repitch')),
    -- Alternate takes of one moment share a group; exactly the arrangement
    -- decides which is heard.
    take_group          TEXT NOT NULL DEFAULT '',
    take_status         TEXT NOT NULL DEFAULT 'selected'
                        CHECK (take_status IN ('candidate', 'selected', 'rejected')),
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_film_music_clips_track ON film_music_clips(track_id, start_ms);
CREATE INDEX IF NOT EXISTS idx_film_music_clips_asset ON film_music_clips(asset_id);
CREATE INDEX IF NOT EXISTS idx_film_music_clips_operation ON film_music_clips(source_operation_id);

-- The emotional arc as time ranges. Director-authored and AI-proposed ranges
-- share one table and differ by `source`; a proposal stays `proposed` until
-- a person accepts it, and nothing paid may be conditioned on a proposal.
CREATE TABLE IF NOT EXISTS film_music_emotion_ranges (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL REFERENCES film_music_sessions(id) ON DELETE CASCADE,
    start_ms    INTEGER NOT NULL DEFAULT 0,
    end_ms      INTEGER NOT NULL DEFAULT 0
                CHECK (end_ms > start_ms),
    label       TEXT NOT NULL DEFAULT '',
    valence     REAL NOT NULL DEFAULT 0
                CHECK (valence >= -1 AND valence <= 1),
    arousal     REAL NOT NULL DEFAULT 0
                CHECK (arousal >= 0 AND arousal <= 1),
    intensity   REAL NOT NULL DEFAULT 0.5
                CHECK (intensity >= 0 AND intensity <= 1),
    source      TEXT NOT NULL DEFAULT 'director'
                CHECK (source IN ('director', 'ai_proposal', 'imported')),
    status      TEXT NOT NULL DEFAULT 'accepted'
                CHECK (status IN ('proposed', 'accepted', 'rejected')),
    confidence  REAL NOT NULL DEFAULT 1
                CHECK (confidence >= 0 AND confidence <= 1),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_film_music_emotion_session ON film_music_emotion_ranges(session_id, start_ms);

-- Markers: shot boundaries, hit points, sections, sync points. A shot marker
-- keeps its shot pointer SET NULL, because a marker placed by hand at a
-- moment is still that moment after the shot is deleted.
CREATE TABLE IF NOT EXISTS film_music_markers (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL REFERENCES film_music_sessions(id) ON DELETE CASCADE,
    shot_id     TEXT REFERENCES film_shots(id) ON DELETE SET NULL,
    kind        TEXT NOT NULL DEFAULT 'note'
                CHECK (kind IN ('shot', 'hit', 'section', 'sync', 'cue_in', 'cue_out', 'note')),
    position_ms INTEGER NOT NULL DEFAULT 0,
    label       TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_film_music_markers_session ON film_music_markers(session_id, position_ms);
CREATE INDEX IF NOT EXISTS idx_film_music_markers_shot ON film_music_markers(shot_id);

-- Automation: a parameter's value over time on a track, or scoped to one
-- clip. Points are a JSON list of { at_ms, value } — a curve is read whole
-- and written whole, so a row per point would be a hundred writes per drag.
CREATE TABLE IF NOT EXISTS film_music_automation (
    id            TEXT PRIMARY KEY,
    track_id      TEXT NOT NULL REFERENCES film_music_tracks(id) ON DELETE CASCADE,
    clip_id       TEXT REFERENCES film_music_clips(id) ON DELETE CASCADE,
    parameter     TEXT NOT NULL DEFAULT 'gain'
                  CHECK (parameter IN ('gain', 'pan', 'mute', 'send', 'filter')),
    interpolation TEXT NOT NULL DEFAULT 'linear'
                  CHECK (interpolation IN ('linear', 'hold', 'curve')),
    points_json   TEXT NOT NULL DEFAULT '[]',
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_film_music_automation_track ON film_music_automation(track_id);
CREATE INDEX IF NOT EXISTS idx_film_music_automation_clip ON film_music_automation(clip_id);

-- Operation lineage: every generate, separate, bounce, import, DAW push or
-- pull, rebase and approval, with its status, provider, job and cost, so a
-- derivative can name its source and a stalled job can be found. Asset
-- pointers SET NULL: the record of what was attempted outlives the files.
CREATE TABLE IF NOT EXISTS film_music_operations (
    id               TEXT PRIMARY KEY,
    session_id       TEXT NOT NULL REFERENCES film_music_sessions(id) ON DELETE CASCADE,
    parent_id        TEXT REFERENCES film_music_operations(id) ON DELETE SET NULL,
    kind             TEXT NOT NULL DEFAULT 'edit'
                     CHECK (kind IN ('generate', 'separate', 'bounce', 'import', 'edit', 'push', 'pull', 'rebase', 'approve')),
    status           TEXT NOT NULL DEFAULT 'planned'
                     CHECK (status IN ('planned', 'running', 'complete', 'failed', 'cancelled')),
    source_asset_id  TEXT REFERENCES film_assets(id) ON DELETE SET NULL,
    output_asset_id  TEXT REFERENCES film_assets(id) ON DELETE SET NULL,
    provider         TEXT NOT NULL DEFAULT '',
    model            TEXT NOT NULL DEFAULT '',
    job_ref          TEXT NOT NULL DEFAULT '',
    params_json      TEXT NOT NULL DEFAULT '{}',
    cost_usd         REAL NOT NULL DEFAULT 0,
    error_message    TEXT NOT NULL DEFAULT '',
    started_at       TEXT,
    completed_at     TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_film_music_operations_session ON film_music_operations(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_film_music_operations_parent ON film_music_operations(parent_id);
CREATE INDEX IF NOT EXISTS idx_film_music_operations_source ON film_music_operations(source_asset_id);
CREATE INDEX IF NOT EXISTS idx_film_music_operations_output ON film_music_operations(output_asset_id);
