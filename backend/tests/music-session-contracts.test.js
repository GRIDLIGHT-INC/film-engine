const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/**
 * THE MUSIC-DOMAIN CONTRACTS, HELD TO THE SCHEMA THEY DESCRIBE.
 *
 * MUS-002. One provider-neutral module says what a session, a track, a clip,
 * a tempo map, an emotion range, an automation curve and an operation ARE —
 * and one read model, `ScoreSession`, is what every consumer (HTTP, MCP, the
 * page, the bounce, bundles, DAW adapters) receives. Two shapes of the same
 * thing is how the board and the viewer came to disagree about their own
 * markup; this exists so that cannot happen to the score.
 *
 * The vocabulary is NOT typed twice. Migration 105 declares every lifecycle
 * value as a CHECK and every bound as a range CHECK; this suite reads those
 * out of the migration file and holds the library's tables equal to them in
 * BOTH directions — a value the validator accepts and the database refuses is
 * a 500 on save, and one the database accepts and the validator refuses is a
 * row nobody can write through the API.
 */

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-music-contracts-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');
const MIGRATION = fs.readFileSync(path.join(MIGRATIONS,
    fs.readdirSync(MIGRATIONS).find(f => /music_workstation\.sql$/.test(f))), 'utf8');

/** Every enum and range CHECK in the migration, keyed `table.column`. */
function schemaEnums() {
    const out = {};
    for (const m of MIGRATION.matchAll(/CREATE TABLE IF NOT EXISTS (film_music_\w+)\s*\(([\s\S]*?)\n\);/g)) {
        for (const c of m[2].matchAll(/CHECK \((\w+) IN \(([^)]+)\)\)/g)) {
            out[`${m[1]}.${c[1]}`] = c[2].split(',').map(v => v.trim()).map(v => /^'.*'$/.test(v) ? v.slice(1, -1) : Number(v));
        }
    }
    return out;
}
function schemaRanges() {
    const out = {};
    for (const m of MIGRATION.matchAll(/CREATE TABLE IF NOT EXISTS (film_music_\w+)\s*\(([\s\S]*?)\n\);/g)) {
        for (const c of m[2].matchAll(/CHECK \((\w+) >= (-?[\d.]+) AND \1 <= (-?[\d.]+)\)/g)) {
            out[`${m[1]}.${c[1]}`] = { min: Number(c[2]), max: Number(c[3]) };
        }
    }
    return out;
}

const lib = require('../lib/music-session');

/** The smallest input each validator accepts, keyed by table. */
const MINIMAL = {
    film_music_sessions: { name: 's' },
    film_music_tracks: { name: 't' },
    film_music_clips: { start_ms: 0, duration_ms: 1000 },
    film_music_emotion_ranges: { start_ms: 0, end_ms: 1000 },
    film_music_markers: { position_ms: 0 },
    film_music_automation: { parameter: 'gain' },
    film_music_operations: { kind: 'edit' },
};

// ── Vocabulary: the schema's, exactly ──────────────────────────────────────

test('every lifecycle vocabulary the schema constrains is declared by the library, and nothing more', () => {
    const schema = schemaEnums();
    assert.ok(Object.keys(schema).length >= 10);
    for (const [key, values] of Object.entries(schema)) {
        assert.deepStrictEqual(lib.VOCABULARY[key], values, `${key}: the library's vocabulary differs from the CHECK`);
    }
    for (const key of Object.keys(lib.VOCABULARY)) {
        assert.ok(schema[key], `library declares a vocabulary for ${key}, which the schema does not constrain`);
    }
});

test('every numeric range the schema constrains is declared by the library, and nothing more', () => {
    const schema = schemaRanges();
    assert.ok(Object.keys(schema).length >= 4);
    assert.deepStrictEqual(lib.RANGES, schema, 'the library\'s ranges differ from the schema\'s');
});

test('every table has a validator, and every validator belongs to a table', () => {
    const tables = [...MIGRATION.matchAll(/CREATE TABLE IF NOT EXISTS (film_music_\w+)/g)].map(m => m[1]);
    for (const t of tables) assert.strictEqual(typeof lib.VALIDATORS[t], 'function', `no validator for ${t}`);
    for (const t of Object.keys(lib.VALIDATORS)) assert.ok(tables.includes(t), `validator for ${t}, which is not a table`);
    for (const t of tables) assert.ok(MINIMAL[t], `this suite has no minimal input for ${t}`);
});

// ── Validators: each value in, each stranger out ───────────────────────────

test('every validator accepts each constrained value and refuses one the schema would refuse', () => {
    for (const [key, values] of Object.entries(schemaEnums())) {
        const [table, column] = key.split('.');
        const validate = lib.VALIDATORS[table];
        for (const v of values) {
            const r = validate({ ...MINIMAL[table], [column]: v });
            assert.strictEqual(r.ok, true, `${key}: refused its own value '${v}': ${JSON.stringify(r.errors)}`);
            assert.strictEqual(r.value[column], v, `${key}: value '${v}' did not survive normalisation`);
        }
        const bad = validate({ ...MINIMAL[table], [column]: 'not-a-real-value' });
        assert.strictEqual(bad.ok, false, `${key}: accepted a value the CHECK does not list`);
        assert.ok(bad.errors.some(e => e.field === column), `${key}: the refusal does not name the field`);
    }
});

test('every range is accepted at both ends and refused one past each, by the validator', () => {
    for (const [key, { min, max }] of Object.entries(schemaRanges())) {
        const [table, column] = key.split('.');
        const validate = lib.VALIDATORS[table];
        assert.strictEqual(validate({ ...MINIMAL[table], [column]: min }).ok, true, `${key} refuses ${min}`);
        assert.strictEqual(validate({ ...MINIMAL[table], [column]: max }).ok, true, `${key} refuses ${max}`);
        assert.strictEqual(validate({ ...MINIMAL[table], [column]: max + 0.01 }).ok, false, `${key} accepts ${max + 0.01}`);
        assert.strictEqual(validate({ ...MINIMAL[table], [column]: min - 0.01 }).ok, false, `${key} accepts ${min - 0.01}`);
    }
});

test('a validator fills defaults, so an empty edit is a valid row and not a row of nulls', () => {
    for (const [table, minimal] of Object.entries(MINIMAL)) {
        const r = lib.VALIDATORS[table](minimal);
        assert.strictEqual(r.ok, true, `${table}: ${JSON.stringify(r.errors)}`);
        for (const [key, values] of Object.entries(schemaEnums())) {
            const [t, column] = key.split('.');
            if (t !== table) continue;
            assert.ok(values.includes(r.value[column]), `${table}.${column} defaulted to '${r.value[column]}', outside the vocabulary`);
        }
    }
});

// ── Lifecycle transitions ──────────────────────────────────────────────────

test('every status vocabulary with a lifecycle has a complete transition table, and self-moves are refused', () => {
    const lifecycles = Object.keys(lib.TRANSITIONS);
    for (const key of ['film_music_sessions.status', 'film_music_operations.status',
        'film_music_emotion_ranges.status', 'film_music_clips.take_status']) {
        assert.ok(lifecycles.includes(key), `no transition table for ${key}`);
    }
    for (const key of lifecycles) {
        const vocab = lib.VOCABULARY[key];
        assert.ok(vocab, `${key} has transitions but no vocabulary`);
        const table = lib.TRANSITIONS[key];
        for (const state of vocab) {
            assert.ok(Array.isArray(table[state]), `${key}: state '${state}' has no transition entry (a state you cannot leave OR a state that was forgotten)`);
            for (const to of table[state]) assert.ok(vocab.includes(to), `${key}: '${state}' → '${to}', which is not a state`);
            assert.ok(!table[state].includes(state), `${key}: '${state}' → itself is listed`);
            const self = lib.canTransition(key, state, state);
            assert.strictEqual(self.ok, false, `${key}: '${state}' → '${state}' allowed`);
            for (const to of vocab) {
                const r = lib.canTransition(key, state, to);
                assert.strictEqual(r.ok, table[state].includes(to), `${key}: '${state}' → '${to}' disagrees with the table`);
                if (!r.ok) assert.match(r.error, new RegExp(`${state}.*${to}|${to}.*${state}`), `${key}: refusal names neither state`);
            }
        }
        for (const state of Object.keys(table)) assert.ok(vocab.includes(state), `${key}: transition table names '${state}', not a state`);
    }
    // A session is signed off from review, never straight from a draft, and
    // approval can be reopened — a lock you cannot get past is one nobody sets.
    assert.strictEqual(lib.canTransition('film_music_sessions.status', 'draft', 'approved').ok, false);
    assert.strictEqual(lib.canTransition('film_music_sessions.status', 'review', 'approved').ok, true);
    assert.strictEqual(lib.canTransition('film_music_sessions.status', 'approved', 'arranging').ok, true);
    // An operation that finished cannot be restarted; a new one is a new row.
    for (const done of ['complete', 'failed', 'cancelled']) {
        assert.deepStrictEqual(lib.TRANSITIONS['film_music_operations.status'][done], [], `${done} is not terminal`);
    }
});

// ── Clip timing ────────────────────────────────────────────────────────────

test('clip timing: whole non-negative milliseconds, a positive length, and fades that fit', () => {
    const v = lib.VALIDATORS.film_music_clips;
    const cases = [
        [{ start_ms: -1, duration_ms: 1000 }, 'start_ms', 'a clip before the film starts'],
        [{ start_ms: 0, duration_ms: 0 }, 'duration_ms', 'a zero-length clip'],
        [{ start_ms: 0, duration_ms: 1000, source_offset_ms: -5 }, 'source_offset_ms', 'a negative source offset'],
        [{ start_ms: 0.5, duration_ms: 1000 }, 'start_ms', 'a fractional millisecond'],
        [{ start_ms: 0, duration_ms: 1000, fade_in_ms: 600, fade_out_ms: 600 }, 'fade_out_ms', 'fades longer than the clip'],
        [{ start_ms: 0, duration_ms: 1000, fade_in_ms: -1 }, 'fade_in_ms', 'a negative fade'],
    ];
    for (const [input, field, why] of cases) {
        const r = v(input);
        assert.strictEqual(r.ok, false, `accepted ${why}`);
        assert.ok(r.errors.some(e => e.field === field), `${why}: refusal does not name ${field}: ${JSON.stringify(r.errors)}`);
    }
    const ok = v({ start_ms: 0, duration_ms: 1000, fade_in_ms: 500, fade_out_ms: 500 });
    assert.strictEqual(ok.ok, true, 'fades that exactly fill the clip were refused');
    assert.strictEqual(lib.clipEndMs(ok.value), 1000);
});

// ── Tempo maps ─────────────────────────────────────────────────────────────

test('a tempo map is a sorted list of changes starting at zero, in sane units', () => {
    const v = lib.validateTempoMap;
    assert.strictEqual(v([]).ok, true, 'an empty map (constant tempo unknown) is legal');
    assert.strictEqual(v([{ at_ms: 0, bpm: 120, numerator: 4, denominator: 4 }]).ok, true);
    assert.strictEqual(v([{ at_ms: 0, bpm: 120, numerator: 4, denominator: 4 }, { at_ms: 30000, bpm: 90, numerator: 3, denominator: 4 }]).ok, true);
    const bad = [
        [[{ at_ms: 500, bpm: 120, numerator: 4, denominator: 4 }], 'a map that does not start at 0'],
        [[{ at_ms: 0, bpm: 120, numerator: 4, denominator: 4 }, { at_ms: 0, bpm: 90, numerator: 4, denominator: 4 }], 'two changes at one moment'],
        [[{ at_ms: 0, bpm: 120, numerator: 4, denominator: 4 }, { at_ms: 30000, bpm: 90, numerator: 4, denominator: 4 }, { at_ms: 20000, bpm: 90, numerator: 4, denominator: 4 }], 'an unsorted map'],
        [[{ at_ms: 0, bpm: 0, numerator: 4, denominator: 4 }], 'zero bpm'],
        [[{ at_ms: 0, bpm: 120, numerator: 4, denominator: 3 }], 'a denominator that is not a power of two'],
        [[{ at_ms: 0, bpm: 120, numerator: 0, denominator: 4 }], 'a zero numerator'],
        ['[{"at_ms":0}]', 'a string where a list is expected'],
    ];
    for (const [input, why] of bad) {
        const r = v(input);
        assert.strictEqual(r.ok, false, `accepted ${why}`);
        assert.ok(r.errors.length && r.errors[0].message, `${why}: no message`);
    }
    // The session validator reads the map through the same rule.
    const s = lib.VALIDATORS.film_music_sessions({ name: 's', tempo_map: [{ at_ms: 5, bpm: 120, numerator: 4, denominator: 4 }] });
    assert.strictEqual(s.ok, false, 'the session validator does not validate its tempo map');
    assert.ok(s.errors.some(e => e.field === 'tempo_map'));
});

// ── Emotion ranges and automation ──────────────────────────────────────────

test('an emotion range ends after it starts, and a proposal is not accepted by default', () => {
    const v = lib.VALIDATORS.film_music_emotion_ranges;
    assert.strictEqual(v({ start_ms: 1000, end_ms: 1000 }).ok, false, 'a zero-length range was accepted');
    assert.strictEqual(v({ start_ms: 2000, end_ms: 1000 }).ok, false, 'a backwards range was accepted');
    const proposal = v({ start_ms: 0, end_ms: 1000, source: 'ai_proposal' });
    assert.strictEqual(proposal.ok, true);
    assert.strictEqual(proposal.value.status, 'proposed', 'an AI proposal defaulted to accepted — nothing paid may rest on a proposal nobody reviewed');
    const authored = v({ start_ms: 0, end_ms: 1000, source: 'director' });
    assert.strictEqual(authored.value.status, 'accepted', 'what a director wrote is not a proposal');
});

test('automation points are sorted and inside the parameter\'s own range', () => {
    const v = lib.VALIDATORS.film_music_automation;
    for (const parameter of lib.VOCABULARY['film_music_automation.parameter']) {
        const range = lib.AUTOMATION_RANGES[parameter];
        assert.ok(range, `no value range for automation parameter '${parameter}'`);
        assert.strictEqual(v({ parameter, points: [{ at_ms: 0, value: range.min }, { at_ms: 1000, value: range.max }] }).ok, true, `${parameter}: its own bounds refused`);
        assert.strictEqual(v({ parameter, points: [{ at_ms: 0, value: range.max + 1 }] }).ok, false, `${parameter}: accepted ${range.max + 1}`);
        assert.strictEqual(v({ parameter, points: [{ at_ms: 1000, value: range.min }, { at_ms: 0, value: range.min }] }).ok, false, `${parameter}: accepted unsorted points`);
    }
    for (const parameter of Object.keys(lib.AUTOMATION_RANGES)) {
        assert.ok(lib.VOCABULARY['film_music_automation.parameter'].includes(parameter), `range for '${parameter}', which is not a parameter`);
    }
});

// ── The read model ─────────────────────────────────────────────────────────

function project() {
    const id = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(id, 'Contracts');
    return id;
}

test('ScoreSession is one shape: nested, ordered, parsed, with the vocabulary attached', () => {
    const p = project();
    const sid = generateId();
    db.prepare(`INSERT INTO film_music_sessions (id, project_id, name, tempo_map_json, status) VALUES (?, ?, 'S', ?, 'arranging')`)
        .run(sid, p, JSON.stringify([{ at_ms: 0, bpm: 100, numerator: 4, denominator: 4 }]));
    const t2 = generateId(), t1 = generateId();
    db.prepare(`INSERT INTO film_music_tracks (id, session_id, name, sort_order, muted) VALUES (?, ?, 'second', 1, 1)`).run(t2, sid);
    db.prepare(`INSERT INTO film_music_tracks (id, session_id, name, sort_order) VALUES (?, ?, 'first', 0)`).run(t1, sid);
    const later = generateId(), earlier = generateId();
    db.prepare(`INSERT INTO film_music_clips (id, track_id, start_ms, duration_ms) VALUES (?, ?, 5000, 1000)`).run(later, t1);
    db.prepare(`INSERT INTO film_music_clips (id, track_id, start_ms, duration_ms) VALUES (?, ?, 0, 1000)`).run(earlier, t1);
    db.prepare(`INSERT INTO film_music_automation (id, track_id, parameter, points_json) VALUES (?, ?, 'pan', ?)`)
        .run(generateId(), t1, JSON.stringify([{ at_ms: 0, value: -1 }, { at_ms: 1000, value: 1 }]));
    db.prepare(`INSERT INTO film_music_emotion_ranges (id, session_id, start_ms, end_ms, label) VALUES (?, ?, 0, 1000, 'dread')`).run(generateId(), sid);
    db.prepare(`INSERT INTO film_music_markers (id, session_id, kind, position_ms) VALUES (?, ?, 'hit', 750)`).run(generateId(), sid);
    db.prepare(`INSERT INTO film_music_operations (id, session_id, kind, status, params_json) VALUES (?, ?, 'generate', 'complete', '{"a":1}')`).run(generateId(), sid);

    const s = lib.readScoreSession(db, sid);
    assert.ok(s, 'no read model');
    assert.deepStrictEqual(Object.keys(s), lib.SCORE_SESSION_SHAPE, 'the read model does not have the declared shape, in the declared order');
    assert.strictEqual(s.session.id, sid);
    assert.deepStrictEqual(s.session.tempo_map, [{ at_ms: 0, bpm: 100, numerator: 4, denominator: 4 }], 'tempo_map_json was not parsed');
    assert.strictEqual('tempo_map_json' in s.session, false, 'the raw JSON column leaked into the read model');
    assert.deepStrictEqual(s.tracks.map(t => t.name), ['first', 'second'], 'tracks are not in sort order');
    assert.strictEqual(s.tracks[1].muted, true, 'muted is not a boolean');
    assert.strictEqual(s.tracks[0].muted, false);
    assert.deepStrictEqual(s.tracks[0].clips.map(c => c.start_ms), [0, 5000], 'clips are not in timeline order');
    assert.strictEqual(s.tracks[0].clips[0].end_ms, 1000, 'a clip does not carry its end');
    assert.deepStrictEqual(s.tracks[0].automation[0].points, [{ at_ms: 0, value: -1 }, { at_ms: 1000, value: 1 }]);
    assert.strictEqual(s.emotion_ranges[0].label, 'dread');
    assert.strictEqual(s.markers[0].kind, 'hit');
    assert.deepStrictEqual(s.operations[0].params, { a: 1 });
    assert.strictEqual(s.duration_ms, 6000, 'the session length is not the end of its last clip');
    assert.deepStrictEqual(s.vocabulary, lib.VOCABULARY, 'consumers would have to hardcode the vocabulary');
    assert.strictEqual(lib.readScoreSession(db, generateId()), null, 'an unknown session is not null');
});

test('a session is read only inside its own project when a project is named', () => {
    const p = project(), other = project();
    const sid = generateId();
    db.prepare(`INSERT INTO film_music_sessions (id, project_id, name) VALUES (?, ?, 'S')`).run(sid, p);
    assert.ok(lib.readScoreSession(db, sid, { projectId: p }));
    assert.strictEqual(lib.readScoreSession(db, sid, { projectId: other }), null, 'a session was read across projects');
});

test('every JSON column round-trips: what the serializer writes, the parser reads back', () => {
    // Derived from the migration: every *_json column.
    const cols = [];
    for (const m of MIGRATION.matchAll(/CREATE TABLE IF NOT EXISTS (film_music_\w+)\s*\(([\s\S]*?)\n\);/g)) {
        for (const c of m[2].matchAll(/^\s+(\w+_json)\s+TEXT/gm)) cols.push({ table: m[1], column: c[1] });
    }
    assert.ok(cols.length >= 3, `found only ${cols.length} JSON columns`);
    for (const { table, column } of cols) {
        const field = lib.JSON_COLUMNS[table] && lib.JSON_COLUMNS[table][column];
        assert.ok(field, `${table}.${column} has no parsed-field name in JSON_COLUMNS`);
        const value = column === 'params_json' ? { k: 'v' } : [{ at_ms: 0, value: 0, bpm: 120, numerator: 4, denominator: 4 }];
        const row = lib.toRow(table, { [field]: value });
        assert.strictEqual(row[column], JSON.stringify(value), `${table}.${column}: the serializer did not write the JSON column`);
        assert.strictEqual(field in row, false, `${table}.${column}: the parsed field leaked into the row`);
        const back = lib.fromRow(table, { ...row, id: 'x' });
        assert.deepStrictEqual(back[field], value, `${table}.${column}: round trip lost the value`);
        assert.strictEqual(column in back, false);
    }
    // A row whose JSON is broken reads as empty and says so, never throws:
    // a corrupt tempo map must not take the whole session read down.
    const back = lib.fromRow('film_music_sessions', { id: 'x', tempo_map_json: '{not json' });
    assert.deepStrictEqual(back.tempo_map, []);
    assert.ok(back.warnings && back.warnings.some(w => /tempo_map/.test(w)));
});
