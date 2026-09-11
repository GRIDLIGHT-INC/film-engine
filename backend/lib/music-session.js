/**
 * The music-domain contracts: what a session, a track, a clip, a tempo map,
 * an emotion range, an automation curve and an operation ARE — and the ONE
 * read model every consumer receives.
 *
 * `film_music_cues` models one cue. A soundtrack is a session over an ordered
 * picture sequence with tracks, clips over immutable assets, an emotional arc,
 * markers, automation and a lineage of operations. Migration 105 stores it;
 * this module says what is legal to store and what a reader gets back.
 *
 * Provider-neutral on purpose: nothing here knows ElevenLabs, Ableton or
 * ffmpeg. The vocabulary below is the SAME set of values migration 105
 * declares as CHECK constraints, and tests/music-session-contracts.test.js
 * holds the two equal in both directions — a value the validator accepts and
 * the database refuses is a 500 on save; one the database accepts and the
 * validator refuses is a row nobody can write through the API.
 *
 * `readScoreSession` is the canonical read model. HTTP, MCP, the page, the
 * bounce, bundles and DAW adapters all receive this shape and no other — two
 * shapes of one thing is how the board and the viewer came to disagree about
 * their own markup tools.
 */

// ── Vocabulary: the schema's lifecycle values, keyed table.column ───────────

const VOCABULARY = {
    'film_music_sessions.status': ['draft', 'arranging', 'review', 'approved', 'archived'],
    'film_music_sessions.sample_rate': [44100, 48000, 96000],
    'film_music_tracks.role_kind': ['instrument', 'family', 'bus', 'reference', 'picture'],
    'film_music_tracks.muted': [0, 1],
    'film_music_tracks.soloed': [0, 1],
    'film_music_clips.source_kind': ['generated', 'native_part', 'separated', 'rendered', 'imported'],
    'film_music_clips.loop_policy': ['none', 'loop', 'fill'],
    'film_music_clips.warp_policy': ['none', 'preserve_pitch', 'repitch'],
    'film_music_clips.take_status': ['candidate', 'selected', 'rejected'],
    'film_music_emotion_ranges.source': ['director', 'ai_proposal', 'imported'],
    'film_music_emotion_ranges.status': ['proposed', 'accepted', 'rejected'],
    'film_music_markers.kind': ['shot', 'hit', 'section', 'sync', 'cue_in', 'cue_out', 'note'],
    'film_music_automation.parameter': ['gain', 'pan', 'mute', 'send', 'filter'],
    'film_music_automation.interpolation': ['linear', 'hold', 'curve'],
    'film_music_operations.kind': ['generate', 'separate', 'bounce', 'import', 'edit', 'push', 'pull', 'rebase', 'approve'],
    'film_music_operations.status': ['planned', 'running', 'complete', 'failed', 'cancelled'],
};

/** The schema's numeric bounds, keyed table.column. */
const RANGES = {
    'film_music_tracks.pan': { min: -1, max: 1 },
    'film_music_emotion_ranges.valence': { min: -1, max: 1 },
    'film_music_emotion_ranges.arousal': { min: 0, max: 1 },
    'film_music_emotion_ranges.intensity': { min: 0, max: 1 },
    'film_music_emotion_ranges.confidence': { min: 0, max: 1 },
};

/**
 * What an automation curve's value may be, per parameter. Not in the schema
 * — points travel as JSON — so this is the only place the bound is stated.
 */
const AUTOMATION_RANGES = {
    gain: { min: -96, max: 24 },     // dB
    pan: { min: -1, max: 1 },
    mute: { min: 0, max: 1 },
    send: { min: 0, max: 1 },
    filter: { min: 0, max: 1 },      // normalised cutoff; a renderer maps it to Hz
};

/**
 * Lifecycle transitions. A state absent from a table is a state you cannot
 * leave, which is what a finished operation is and what a session must never
 * be: approval can be reopened, because a lock nobody can get past is a lock
 * nobody sets.
 */
const TRANSITIONS = {
    'film_music_sessions.status': {
        draft: ['arranging', 'archived'],
        arranging: ['review', 'archived'],
        review: ['approved', 'arranging', 'archived'],
        approved: ['arranging', 'archived'],
        archived: ['arranging'],
    },
    'film_music_operations.status': {
        planned: ['running', 'cancelled'],
        running: ['complete', 'failed', 'cancelled'],
        complete: [],
        failed: [],
        cancelled: [],
    },
    'film_music_emotion_ranges.status': {
        proposed: ['accepted', 'rejected'],
        accepted: ['rejected'],
        rejected: ['accepted'],
    },
    'film_music_clips.take_status': {
        candidate: ['selected', 'rejected'],
        selected: ['candidate', 'rejected'],
        rejected: ['candidate'],
    },
};

/** Which stored column holds JSON, and what the parsed field is called. */
const JSON_COLUMNS = {
    film_music_sessions: { tempo_map_json: 'tempo_map' },
    film_music_automation: { points_json: 'points' },
    film_music_operations: { params_json: 'params' },
};

/** Columns stored as 0/1 and read as booleans. */
const BOOLEAN_COLUMNS = {
    film_music_tracks: ['muted', 'soloed'],
};

/** The read model's top-level keys, in the order a reader receives them. */
const SCORE_SESSION_SHAPE = [
    'session', 'picture', 'tracks', 'emotion_ranges', 'markers', 'operations',
    'duration_ms', 'vocabulary', 'warnings',
];

const TABLES = [
    'film_music_sessions', 'film_music_tracks', 'film_music_clips', 'film_music_emotion_ranges',
    'film_music_markers', 'film_music_automation', 'film_music_operations',
];

// ── Field-level checks ─────────────────────────────────────────────────────

function isInt(v) { return Number.isInteger(v); }

function check(errors, field, ok, message) {
    if (!ok) errors.push({ field, message });
    return ok;
}

function enumField(errors, table, column, value, fallback) {
    const vocab = VOCABULARY[`${table}.${column}`];
    if (value === undefined || value === null) return fallback;
    check(errors, column, vocab.includes(value), `${column} must be one of ${vocab.join(', ')}; got '${value}'`);
    return value;
}

function rangeField(errors, table, column, value, fallback) {
    const r = RANGES[`${table}.${column}`];
    if (value === undefined || value === null) return fallback;
    const n = Number(value);
    check(errors, column, Number.isFinite(n) && n >= r.min && n <= r.max, `${column} must be between ${r.min} and ${r.max}; got ${value}`);
    return n;
}

function msField(errors, column, value, fallback, opts) {
    const o = opts || {};
    if (value === undefined || value === null) return fallback;
    const n = Number(value);
    check(errors, column, isInt(n) && n >= (o.min === undefined ? 0 : o.min),
        `${column} must be a whole number of milliseconds${o.min === undefined ? ' ≥ 0' : ` ≥ ${o.min}`}; got ${value}`);
    if (o.positive) check(errors, column, n > 0, `${column} must be greater than 0; got ${value}`);
    return n;
}

function text(value, fallback) {
    return value === undefined || value === null ? fallback : String(value);
}

function result(errors, value) {
    return { ok: errors.length === 0, errors, value };
}

// ── Tempo map ──────────────────────────────────────────────────────────────

const DENOMINATORS = [1, 2, 4, 8, 16, 32];

/**
 * A tempo map is a list of changes, sorted by time, starting at zero. Empty
 * is legal (constant tempo not yet stated); a map that starts later than 0
 * leaves the opening unmeasured, and two changes at one instant contradict.
 */
function validateTempoMap(map) {
    const errors = [];
    if (map === undefined || map === null) return result(errors, []);
    if (!Array.isArray(map)) {
        errors.push({ field: 'tempo_map', message: 'tempo_map must be a list of { at_ms, bpm, numerator, denominator }' });
        return result(errors, []);
    }
    const out = [];
    let last = -1;
    map.forEach((entry, i) => {
        const e = entry && typeof entry === 'object' ? entry : {};
        const at = Number(e.at_ms), bpm = Number(e.bpm);
        const num = e.numerator === undefined ? 4 : Number(e.numerator);
        const den = e.denominator === undefined ? 4 : Number(e.denominator);
        check(errors, 'tempo_map', isInt(at) && at >= 0, `tempo_map[${i}].at_ms must be a whole number of milliseconds ≥ 0`);
        if (i === 0) check(errors, 'tempo_map', at === 0, 'tempo_map must start at 0 ms, or the opening has no tempo');
        check(errors, 'tempo_map', at > last, `tempo_map[${i}] at ${at} ms is not after the change before it`);
        check(errors, 'tempo_map', Number.isFinite(bpm) && bpm >= 20 && bpm <= 400, `tempo_map[${i}].bpm must be between 20 and 400`);
        check(errors, 'tempo_map', isInt(num) && num >= 1 && num <= 32, `tempo_map[${i}].numerator must be a whole number from 1 to 32`);
        check(errors, 'tempo_map', DENOMINATORS.includes(den), `tempo_map[${i}].denominator must be one of ${DENOMINATORS.join(', ')}`);
        last = at;
        out.push({ at_ms: at, bpm, numerator: num, denominator: den });
    });
    return result(errors, out);
}

// ── Automation points ──────────────────────────────────────────────────────

function validatePoints(parameter, points) {
    const errors = [];
    if (points === undefined || points === null) return result(errors, []);
    if (!Array.isArray(points)) {
        errors.push({ field: 'points', message: 'points must be a list of { at_ms, value }' });
        return result(errors, []);
    }
    const range = AUTOMATION_RANGES[parameter] || AUTOMATION_RANGES.gain;
    const out = [];
    let last = -1;
    points.forEach((p, i) => {
        const e = p && typeof p === 'object' ? p : {};
        const at = Number(e.at_ms), value = Number(e.value);
        check(errors, 'points', isInt(at) && at >= 0, `points[${i}].at_ms must be a whole number of milliseconds ≥ 0`);
        check(errors, 'points', at >= last, `points[${i}] at ${at} ms is before the point before it`);
        check(errors, 'points', Number.isFinite(value) && value >= range.min && value <= range.max,
            `points[${i}].value must be between ${range.min} and ${range.max} for ${parameter}`);
        last = at;
        out.push({ at_ms: at, value });
    });
    return result(errors, out);
}

// ── Validators, one per table ──────────────────────────────────────────────

function validateSession(input) {
    const i = input || {};
    const errors = [];
    const value = {
        name: text(i.name, ''),
        status: enumField(errors, 'film_music_sessions', 'status', i.status, 'draft'),
        sample_rate: enumField(errors, 'film_music_sessions', 'sample_rate', i.sample_rate, 48000),
        frame_rate: i.frame_rate === undefined || i.frame_rate === null ? 24 : Number(i.frame_rate),
        sequence_id: i.sequence_id || null,
        scene_id: i.scene_id || null,
        script_id: i.script_id || null,
        notes: text(i.notes, ''),
    };
    check(errors, 'frame_rate', Number.isFinite(value.frame_rate) && value.frame_rate > 0 && value.frame_rate <= 120,
        `frame_rate must be a positive rate up to 120; got ${i.frame_rate}`);
    const tempo = validateTempoMap(i.tempo_map);
    errors.push(...tempo.errors);
    value.tempo_map = tempo.value;
    return result(errors, value);
}

function validateTrack(input) {
    const i = input || {};
    const errors = [];
    const bool = (column, v) => {
        if (v === undefined || v === null) return 0;
        if (v === true || v === 1 || v === '1') return 1;
        if (v === false || v === 0 || v === '0') return 0;
        errors.push({ field: column, message: `${column} must be true or false` });
        return 0;
    };
    const value = {
        name: text(i.name, ''),
        role_kind: enumField(errors, 'film_music_tracks', 'role_kind', i.role_kind, 'instrument'),
        role: text(i.role, ''),
        sort_order: i.sort_order === undefined || i.sort_order === null ? 0 : Number(i.sort_order),
        color: text(i.color, ''),
        gain_db: i.gain_db === undefined || i.gain_db === null ? 0 : Number(i.gain_db),
        pan: rangeField(errors, 'film_music_tracks', 'pan', i.pan, 0),
        muted: bool('muted', i.muted),
        soloed: bool('soloed', i.soloed),
        output_track_id: i.output_track_id || null,
    };
    check(errors, 'sort_order', isInt(value.sort_order), 'sort_order must be a whole number');
    check(errors, 'gain_db', Number.isFinite(value.gain_db) && value.gain_db >= AUTOMATION_RANGES.gain.min && value.gain_db <= AUTOMATION_RANGES.gain.max,
        `gain_db must be between ${AUTOMATION_RANGES.gain.min} and ${AUTOMATION_RANGES.gain.max} dB`);
    return result(errors, value);
}

/**
 * A clip is a placement of an immutable asset. Every number is whole
 * milliseconds — the cut is in milliseconds, never beats — the length is
 * positive, and the fades fit inside it. Leading silence is preserved by
 * keeping source_offset_ms at 0 on import, never by trimming the file.
 */
function validateClip(input) {
    const i = input || {};
    const errors = [];
    const value = {
        name: text(i.name, ''),
        asset_id: i.asset_id || null,
        source_operation_id: i.source_operation_id || null,
        source_kind: enumField(errors, 'film_music_clips', 'source_kind', i.source_kind, 'generated'),
        start_ms: msField(errors, 'start_ms', i.start_ms, 0),
        duration_ms: msField(errors, 'duration_ms', i.duration_ms, 0, { positive: true }),
        source_offset_ms: msField(errors, 'source_offset_ms', i.source_offset_ms, 0),
        gain_db: i.gain_db === undefined || i.gain_db === null ? 0 : Number(i.gain_db),
        fade_in_ms: msField(errors, 'fade_in_ms', i.fade_in_ms, 0),
        fade_out_ms: msField(errors, 'fade_out_ms', i.fade_out_ms, 0),
        loop_policy: enumField(errors, 'film_music_clips', 'loop_policy', i.loop_policy, 'none'),
        warp_policy: enumField(errors, 'film_music_clips', 'warp_policy', i.warp_policy, 'none'),
        take_group: text(i.take_group, ''),
        take_status: enumField(errors, 'film_music_clips', 'take_status', i.take_status, 'selected'),
    };
    if (i.duration_ms === undefined || i.duration_ms === null) {
        errors.push({ field: 'duration_ms', message: 'duration_ms is required: a clip has a length' });
    }
    check(errors, 'gain_db', Number.isFinite(value.gain_db) && value.gain_db >= AUTOMATION_RANGES.gain.min && value.gain_db <= AUTOMATION_RANGES.gain.max,
        `gain_db must be between ${AUTOMATION_RANGES.gain.min} and ${AUTOMATION_RANGES.gain.max} dB`);
    if (isInt(value.duration_ms) && isInt(value.fade_in_ms) && isInt(value.fade_out_ms)) {
        check(errors, 'fade_out_ms', value.fade_in_ms + value.fade_out_ms <= value.duration_ms,
            `fade_in_ms + fade_out_ms (${value.fade_in_ms + value.fade_out_ms}) is longer than the clip (${value.duration_ms})`);
    }
    return result(errors, value);
}

function validateEmotionRange(input) {
    const i = input || {};
    const errors = [];
    const source = enumField(errors, 'film_music_emotion_ranges', 'source', i.source, 'director');
    const value = {
        start_ms: msField(errors, 'start_ms', i.start_ms, 0),
        end_ms: msField(errors, 'end_ms', i.end_ms, 0),
        label: text(i.label, ''),
        valence: rangeField(errors, 'film_music_emotion_ranges', 'valence', i.valence, 0),
        arousal: rangeField(errors, 'film_music_emotion_ranges', 'arousal', i.arousal, 0),
        intensity: rangeField(errors, 'film_music_emotion_ranges', 'intensity', i.intensity, 0.5),
        source,
        // A proposal is not accepted by anyone's default: nothing paid may
        // rest on an emotion curve no person reviewed.
        status: enumField(errors, 'film_music_emotion_ranges', 'status', i.status, source === 'ai_proposal' ? 'proposed' : 'accepted'),
        confidence: rangeField(errors, 'film_music_emotion_ranges', 'confidence', i.confidence, 1),
        // Why this range (a proposal's argument, kept when it is accepted) and
        // which proposal it came from: lineage, not lifecycle (migration 106).
        rationale: text(i.rationale, ''),
        proposal_id: text(i.proposal_id, ''),
    };
    if (i.end_ms === undefined || i.end_ms === null) errors.push({ field: 'end_ms', message: 'end_ms is required' });
    if (isInt(value.start_ms) && isInt(value.end_ms)) {
        check(errors, 'end_ms', value.end_ms > value.start_ms, `end_ms (${value.end_ms}) must be after start_ms (${value.start_ms})`);
    }
    return result(errors, value);
}

function validateMarker(input) {
    const i = input || {};
    const errors = [];
    const value = {
        kind: enumField(errors, 'film_music_markers', 'kind', i.kind, 'note'),
        position_ms: msField(errors, 'position_ms', i.position_ms, 0),
        label: text(i.label, ''),
        shot_id: i.shot_id || null,
    };
    return result(errors, value);
}

function validateAutomation(input) {
    const i = input || {};
    const errors = [];
    const parameter = enumField(errors, 'film_music_automation', 'parameter', i.parameter, 'gain');
    const value = {
        clip_id: i.clip_id || null,
        parameter,
        interpolation: enumField(errors, 'film_music_automation', 'interpolation', i.interpolation, 'linear'),
    };
    const points = validatePoints(parameter, i.points);
    errors.push(...points.errors);
    value.points = points.value;
    return result(errors, value);
}

function validateOperation(input) {
    const i = input || {};
    const errors = [];
    const value = {
        kind: enumField(errors, 'film_music_operations', 'kind', i.kind, 'edit'),
        status: enumField(errors, 'film_music_operations', 'status', i.status, 'planned'),
        parent_id: i.parent_id || null,
        source_asset_id: i.source_asset_id || null,
        output_asset_id: i.output_asset_id || null,
        provider: text(i.provider, ''),
        model: text(i.model, ''),
        job_ref: text(i.job_ref, ''),
        params: i.params && typeof i.params === 'object' ? i.params : {},
        cost_usd: i.cost_usd === undefined || i.cost_usd === null ? 0 : Number(i.cost_usd),
        error_message: text(i.error_message, ''),
    };
    check(errors, 'cost_usd', Number.isFinite(value.cost_usd) && value.cost_usd >= 0, 'cost_usd must be a non-negative number');
    if (i.params !== undefined && i.params !== null && (typeof i.params !== 'object' || Array.isArray(i.params))) {
        errors.push({ field: 'params', message: 'params must be an object' });
    }
    return result(errors, value);
}

const VALIDATORS = {
    film_music_sessions: validateSession,
    film_music_tracks: validateTrack,
    film_music_clips: validateClip,
    film_music_emotion_ranges: validateEmotionRange,
    film_music_markers: validateMarker,
    film_music_automation: validateAutomation,
    film_music_operations: validateOperation,
};

// ── Lifecycle ──────────────────────────────────────────────────────────────

/** May `from` become `to`? Refused with both states named. */
function canTransition(key, from, to) {
    const table = TRANSITIONS[key];
    if (!table) return { ok: false, error: `${key} has no lifecycle` };
    const vocab = VOCABULARY[key] || [];
    if (!vocab.includes(from)) return { ok: false, error: `'${from}' is not a ${key} state` };
    if (!vocab.includes(to)) return { ok: false, error: `'${to}' is not a ${key} state` };
    if (from === to) return { ok: false, error: `${key} is already '${from}'; '${from}' → '${to}' is not a change` };
    if (!(table[from] || []).includes(to)) {
        return { ok: false, error: `${key} cannot go from '${from}' to '${to}'; from '${from}' it may go to ${(table[from] || []).map(s => `'${s}'`).join(', ') || 'nothing (terminal)'}` };
    }
    return { ok: true };
}

// ── Serialisation: rows ↔ values ───────────────────────────────────────────

/** A validated value as the columns to write. JSON fields are stringified. */
function toRow(table, value) {
    const row = { ...value };
    for (const [column, field] of Object.entries(JSON_COLUMNS[table] || {})) {
        if (field in row) {
            row[column] = JSON.stringify(row[field]);
            delete row[field];
        }
    }
    for (const column of BOOLEAN_COLUMNS[table] || []) {
        if (column in row) row[column] = row[column] ? 1 : 0;
    }
    return row;
}

/**
 * A stored row as a value. A JSON column that will not parse reads as empty
 * and is NAMED in `warnings`, never thrown: a corrupt tempo map must not take
 * the whole session read down.
 */
function fromRow(table, row) {
    const out = { ...row };
    const warnings = [];
    for (const [column, field] of Object.entries(JSON_COLUMNS[table] || {})) {
        if (!(column in out)) continue;
        const raw = out[column];
        delete out[column];
        const empty = column === 'params_json' ? {} : [];
        if (raw === null || raw === undefined || raw === '') { out[field] = empty; continue; }
        try {
            const parsed = JSON.parse(raw);
            out[field] = parsed && typeof parsed === 'object' ? parsed : empty;
        } catch (_) {
            out[field] = empty;
            warnings.push(`${table}.${field} on ${row.id || '?'} is not valid JSON and was read as empty`);
        }
    }
    for (const column of BOOLEAN_COLUMNS[table] || []) {
        if (column in out) out[column] = !!out[column];
    }
    if (warnings.length) out.warnings = warnings;
    return out;
}

function clipEndMs(clip) {
    return Number(clip.start_ms || 0) + Number(clip.duration_ms || 0);
}

// ── The read model ─────────────────────────────────────────────────────────

/**
 * ScoreSession: the one shape every consumer receives.
 *
 * Tracks in sort order, each carrying its clips in timeline order and its
 * automation; emotion ranges and markers in time order; operations newest
 * first; the picture unit named; the session's length derived from its last
 * clip; the vocabulary attached so no consumer hardcodes a list. `projectId`
 * scopes the read — a session read across projects is a leak.
 */
function readScoreSession(db, sessionId, opts) {
    const o = opts || {};
    const raw = db.prepare('SELECT * FROM film_music_sessions WHERE id = ?').get(sessionId);
    if (!raw) return null;
    if (o.projectId && raw.project_id !== o.projectId) return null;

    const warnings = [];
    const take = (table, row) => {
        const v = fromRow(table, row);
        if (v.warnings) { warnings.push(...v.warnings); delete v.warnings; }
        return v;
    };

    const session = take('film_music_sessions', raw);
    const tracks = db.prepare('SELECT * FROM film_music_tracks WHERE session_id = ? ORDER BY sort_order, created_at, id').all(sessionId)
        .map(t => take('film_music_tracks', t));
    const clipRows = db.prepare(
        `SELECT c.* FROM film_music_clips c JOIN film_music_tracks t ON t.id = c.track_id
          WHERE t.session_id = ? ORDER BY c.start_ms, c.created_at, c.id`).all(sessionId);
    const autoRows = db.prepare(
        `SELECT a.* FROM film_music_automation a JOIN film_music_tracks t ON t.id = a.track_id
          WHERE t.session_id = ? ORDER BY a.created_at, a.id`).all(sessionId);
    let duration = 0;
    for (const t of tracks) {
        t.clips = clipRows.filter(c => c.track_id === t.id).map(c => {
            const v = take('film_music_clips', c);
            v.end_ms = clipEndMs(v);
            if (v.end_ms > duration) duration = v.end_ms;
            return v;
        });
        t.automation = autoRows.filter(a => a.track_id === t.id).map(a => take('film_music_automation', a));
    }

    const emotion = db.prepare('SELECT * FROM film_music_emotion_ranges WHERE session_id = ? ORDER BY start_ms, id').all(sessionId)
        .map(r => take('film_music_emotion_ranges', r));
    const markers = db.prepare('SELECT * FROM film_music_markers WHERE session_id = ? ORDER BY position_ms, id').all(sessionId)
        .map(r => take('film_music_markers', r));
    const operations = db.prepare('SELECT * FROM film_music_operations WHERE session_id = ? ORDER BY created_at DESC, id').all(sessionId)
        .map(r => take('film_music_operations', r));

    const picture = { kind: null, sequence: null, scene: null };
    if (session.sequence_id) {
        const seq = db.prepare('SELECT id, name, shot_ids, status FROM film_sequences WHERE id = ?').get(session.sequence_id);
        if (seq) {
            let shotIds = [];
            try { shotIds = JSON.parse(seq.shot_ids || '[]'); } catch (_) { shotIds = []; }
            picture.kind = 'sequence';
            picture.sequence = { id: seq.id, name: seq.name, status: seq.status, shot_ids: shotIds };
        } else {
            warnings.push('the session names a sequence that no longer exists');
        }
    } else if (session.scene_id) {
        const sc = db.prepare('SELECT id, scene_number, location, time_of_day FROM film_scenes WHERE id = ?').get(session.scene_id);
        if (sc) { picture.kind = 'scene'; picture.scene = sc; } else warnings.push('the session names a scene that no longer exists');
    }

    return {
        session, picture, tracks, emotion_ranges: emotion, markers, operations,
        duration_ms: duration, vocabulary: VOCABULARY, warnings,
    };
}

module.exports = {
    VOCABULARY, RANGES, AUTOMATION_RANGES, TRANSITIONS, JSON_COLUMNS, BOOLEAN_COLUMNS,
    SCORE_SESSION_SHAPE, TABLES, VALIDATORS,
    validateSession, validateTrack, validateClip, validateTempoMap, validateEmotionRange,
    validateMarker, validateAutomation, validateOperation, validatePoints,
    canTransition, toRow, fromRow, clipEndMs, readScoreSession,
};
