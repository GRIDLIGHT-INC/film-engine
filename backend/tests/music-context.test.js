const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/**
 * THE SCORE BRIEF: EVERYTHING THE ENGINE KNOWS ABOUT A PICTURE UNIT, ONCE.
 *
 * MUS-003. `music_brief` is scene-scoped and reads a handful of facts. A
 * score session is attached to an ORDERED SEQUENCE and is written against
 * the exact screenplay version, the shots in play order with their real
 * timings and cameras, the cast and how much they talk, the film's look, the
 * cues already written and the themes already made. `lib/music-context.js`
 * compiles all of that into one neutral ScoreBrief, with a fingerprint per
 * field and one over the whole, and says where every field came from.
 *
 * The fingerprint is what makes drift SAYABLE: change any input and the
 * brief a session was written against no longer matches, and the session
 * reports it — without touching the music. Rebasing is an explicit act.
 *
 * Set-based over the library's own BRIEF_FIELDS registry: every field has a
 * source, every drift-bearing field has a mutation here that must move the
 * fingerprint and be named by the comparison, and a set of NON-inputs must
 * not move it — a proposal nobody accepted is the one that matters most.
 */

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-music-context-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const ctx = require('../lib/music-context');
const { allowedSpecValues } = require('../lib/look-development');

const FOUNTAIN = [
    'INT. DINER - NIGHT', '', 'RAY sits alone at the counter.', '', 'RAY', 'Where were you?', '',
    'EXT. STREET - DAWN', '', 'June walks the length of the block.', '',
].join('\n');

function card(o) { return JSON.stringify({ camera: { shot_type: 'medium', lens: '50mm' }, characters: [], dialogue: [], ...o }); }

/** A film: one script, two scenes, three shots, a sequence in NOT code order, a cue, a session. */
function film(opts) {
    const o = opts || {};
    const f = { project: generateId() };
    db.prepare("INSERT INTO film_projects (id, title, genre, style_preset) VALUES (?, 'Ctx', 'Drama', 'noir, 35mm grain')").run(f.project);
    if (o.script !== false) {
        f.script = generateId();
        db.prepare("INSERT INTO film_scripts (id, project_id, version, content, fountain_content, format) VALUES (?, ?, 1, ?, ?, 'fountain')")
            .run(f.script, f.project, FOUNTAIN, FOUNTAIN);
    }
    f.scene1 = generateId(); f.scene2 = generateId();
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, int_ext, location, time_of_day, description) VALUES (?, ?, '1', 'INT', 'DINER', 'NIGHT', 'RAY sits alone at the counter.')").run(f.scene1, f.project);
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, int_ext, location, time_of_day, description) VALUES (?, ?, '2', 'EXT', 'STREET', 'DAWN', 'June walks the length of the block.')").run(f.scene2, f.project);
    f.s1A = generateId(); f.s1B = generateId(); f.s2A = generateId();
    const shot = (id, scene, code, sort, ms, c) => db.prepare(
        'INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms, sort_order) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, scene, code, c, ms, sort);
    shot(f.s1A, f.scene1, '1A', 0, 2000, card({ description: 'Ray, alone.', characters: ['RAY'], dialogue: [{ character: 'RAY', line: 'Where were you?' }] }));
    shot(f.s1B, f.scene1, '1B', 1, 2000, card({ description: 'The door.', characters: ['RAY'] }));
    shot(f.s2A, f.scene2, '2A', 0, 0, card({ description: 'June walks.', characters: ['JUNE'], camera: { shot_type: 'wide', lens: '24mm' } }));
    // 1A has measured footage of 3000ms; 1B has only its card; 2A has neither.
    f.asset1A = generateId();
    db.prepare("INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, duration_ms) VALUES (?, ?, ?, 'video_raw', '/tmp/1A.mp4', '1A.mp4', 3000)")
        .run(f.asset1A, f.project, f.s1A);
    f.sequence = generateId();
    db.prepare("INSERT INTO film_sequences (id, project_id, name, shot_ids) VALUES (?, ?, 'Opening', ?)")
        .run(f.sequence, f.project, JSON.stringify([f.s1B, f.s1A, f.s2A]));
    f.cue = generateId();
    db.prepare("INSERT INTO film_music_cues (id, project_id, scene_id, cue_type, title, description, mood, sections_json) VALUES (?, ?, ?, 'score', 'Theme A', 'sparse piano under the argument', 'dread', ?)")
        .run(f.cue, f.project, f.scene1, JSON.stringify([{ name: 'open', duration_ms: 4000, positive: 'sparse', negative: '' }]));
    f.session = generateId();
    db.prepare("INSERT INTO film_music_sessions (id, project_id, sequence_id, name) VALUES (?, ?, ?, 'S')").run(f.session, f.project, f.sequence);
    return f;
}

// ── The registry and the shape ─────────────────────────────────────────────

test('every brief field has a declared source, and the brief has exactly the declared fields', () => {
    const reg = ctx.BRIEF_FIELDS;
    assert.ok(reg && Object.keys(reg).length >= 8, 'BRIEF_FIELDS is missing or thin');
    for (const [field, spec] of Object.entries(reg)) {
        assert.ok(spec.from && spec.from.length, `${field} declares no source`);
        assert.strictEqual(typeof spec.drift, 'boolean', `${field} does not say whether it bears drift`);
        assert.ok(spec.what && spec.what.length > 20, `${field} has no explanation`);
    }
    const f = film();
    const out = ctx.compileScoreContext(db, { sessionId: f.session });
    assert.deepStrictEqual(Object.keys(out.brief).sort(), Object.keys(reg).sort(), 'the brief and the registry disagree about the fields');
    for (const field of Object.keys(reg)) {
        const p = out.provenance[field];
        assert.ok(p, `no provenance for ${field}`);
        assert.ok(p.from && p.from.length, `${field}: provenance names no source`);
        assert.ok(Array.isArray(p.ids), `${field}: provenance carries no ids list`);
        assert.strictEqual(typeof out.field_fingerprints[field], 'string', `${field}: no field fingerprint`);
    }
    assert.match(out.fingerprints.context, /^[0-9a-f]{32}$/);
    assert.match(out.fingerprints.script, /^[0-9a-f]{32}$/);
    assert.match(out.fingerprints.picture, /^[0-9a-f]{32}$/);
});

test('the brief is deterministic, and follows the sequence order, not the code order', () => {
    const f = film();
    const a = ctx.compileScoreContext(db, { sessionId: f.session });
    const b = ctx.compileScoreContext(db, { sessionId: f.session });
    assert.deepStrictEqual(a.fingerprints, b.fingerprints, 'two compiles of one unchanged film differ');
    assert.deepStrictEqual(a.brief, b.brief);
    assert.deepStrictEqual(a.brief.picture.shots.map(s => s.shot_code), ['1B', '1A', '2A'], 'the shots are not in the sequence\'s order');
    assert.strictEqual(a.brief.picture.kind, 'sequence');
    assert.strictEqual(a.brief.picture.id, f.sequence);
    // Timing: 1B from its card (2000), 1A measured (3000), 2A nothing.
    const [b1, a1, a2] = a.brief.picture.shots;
    assert.deepStrictEqual([b1.start_ms, b1.duration_ms, b1.duration_source], [0, 2000, 'card']);
    assert.deepStrictEqual([a1.start_ms, a1.duration_ms, a1.duration_source], [2000, 3000, 'measured']);
    assert.deepStrictEqual([a2.start_ms, a2.duration_ms, a2.duration_source], [5000, 0, 'none']);
    assert.strictEqual(a.brief.picture.total_ms, 5000);
    assert.strictEqual(a.brief.length.ms, 5000);
    assert.match(a.brief.length.source, /measured|card/, 'the length does not say where it came from');
    // The camera each shot is actually generated with, not only what was typed.
    assert.strictEqual(a2.camera.lens, '24mm');
    assert.strictEqual(a2.camera.shot_type, 'wide');
});

test('the screenplay passage is the exact text of the scene in the exact version', () => {
    const f = film();
    const out = ctx.compileScoreContext(db, { sessionId: f.session });
    assert.strictEqual(out.brief.screenplay.script_id, f.script);
    assert.strictEqual(out.brief.screenplay.version, 1);
    const p1 = out.brief.screenplay.passages.find(p => p.scene_id === f.scene1);
    assert.ok(p1, 'scene 1 has no passage');
    assert.strictEqual(p1.heading, 'INT. DINER - NIGHT');
    assert.ok(p1.text.includes('Where were you?'), 'the passage lost the dialogue');
    assert.ok(!p1.text.includes('June walks'), 'the passage ran into the next scene');
    assert.deepStrictEqual(out.brief.screenplay.passages.map(p => p.scene_id), [f.scene1, f.scene2]);

    const bare = film({ script: false });
    const none = ctx.compileScoreContext(db, { sessionId: bare.session });
    assert.deepStrictEqual(none.brief.screenplay.passages, []);
    assert.strictEqual(none.brief.screenplay.script_id, null);
    assert.ok(none.warnings.some(w => /screenplay/i.test(w)), 'a project with no screenplay is not named');
});

test('the cast, the talking, the look, the cues and the motifs are compiled from the engine\'s own records', () => {
    const f = film();
    const out = ctx.compileScoreContext(db, { sessionId: f.session });
    assert.deepStrictEqual(out.brief.characters, ['JUNE', 'RAY']);
    assert.strictEqual(out.brief.dialogue.lines, 1);
    assert.ok(out.brief.dialogue.band, 'no dialogue band');
    assert.strictEqual(out.brief.look.style_preset, 'noir, 35mm grain');
    assert.strictEqual(out.brief.look.genre, 'Drama');
    assert.strictEqual(out.brief.cues.length, 1);
    assert.strictEqual(out.brief.cues[0].title, 'Theme A');
    assert.deepStrictEqual(out.brief.cues[0].sections.map(s => s.name), ['open'], 'cue sections were not parsed');
    assert.deepStrictEqual(out.brief.scenes.map(s => s.scene_number), ['1', '2']);
    assert.strictEqual(out.brief.scenes[0].time_of_day, 'NIGHT');
    // A motif is a theme already MADE somewhere in the project: a score cue
    // with a generated asset. This cue has none yet, so there is no motif.
    assert.deepStrictEqual(out.brief.motifs, []);
    const asset = generateId();
    db.prepare("INSERT INTO film_assets (id, project_id, scene_id, asset_type, file_path, file_name, duration_ms) VALUES (?, ?, ?, 'audio_music', '/tmp/t.mp3', 't.mp3', 4000)")
        .run(asset, f.project, f.scene1);
    db.prepare('UPDATE film_music_cues SET generated_asset_id = ? WHERE id = ?').run(asset, f.cue);
    const again = ctx.compileScoreContext(db, { sessionId: f.session });
    assert.strictEqual(again.brief.motifs.length, 1);
    assert.strictEqual(again.brief.motifs[0].asset_id, asset);
    assert.strictEqual(again.brief.motifs[0].title, 'Theme A');
});

// ── Drift: every input moves the fingerprint; every non-input does not ─────

/** One real change per drift-bearing field. */
const MUTATORS = {
    screenplay: f => {
        db.prepare("INSERT INTO film_scripts (id, project_id, version, content, fountain_content, format) VALUES (?, ?, 2, ?, ?, 'fountain')")
            .run(generateId(), f.project, FOUNTAIN.replace('Where were you?', 'Where have you been?'), FOUNTAIN.replace('Where were you?', 'Where have you been?'));
    },
    picture: f => {
        db.prepare('UPDATE film_sequences SET shot_ids = ? WHERE id = ?').run(JSON.stringify([f.s1A, f.s1B, f.s2A]), f.sequence);
    },
    scenes: f => { db.prepare("UPDATE film_scenes SET time_of_day = 'DAY' WHERE id = ?").run(f.scene1); },
    characters: f => {
        db.prepare('UPDATE film_shots SET scene_card_yaml = ? WHERE id = ?')
            .run(card({ description: 'The door.', characters: ['RAY', 'MARLA'] }), f.s1B);
    },
    dialogue: f => {
        db.prepare('UPDATE film_shots SET scene_card_yaml = ? WHERE id = ?')
            .run(card({ description: 'The door.', characters: ['RAY'], dialogue: [{ character: 'RAY', line: 'Sit down.' }] }), f.s1B);
    },
    look: f => { db.prepare("UPDATE film_projects SET style_preset = 'golden hour, soft' WHERE id = ?").run(f.project); },
    cues: f => { db.prepare("UPDATE film_music_cues SET description = 'brass, huge' WHERE id = ?").run(f.cue); },
    emotion: f => {
        db.prepare("INSERT INTO film_music_emotion_ranges (id, session_id, start_ms, end_ms, label, source, status) VALUES (?, ?, 0, 1000, 'dread', 'director', 'accepted')")
            .run(generateId(), f.session);
    },
};

/** Changes that must NOT move the fingerprint. */
const NON_INPUTS = {
    'project title': f => db.prepare("UPDATE film_projects SET title = 'Renamed' WHERE id = ?").run(f.project),
    'scene status': f => db.prepare("UPDATE film_scenes SET status = 'approved' WHERE id = ?").run(f.scene1),
    'session name': f => db.prepare("UPDATE film_music_sessions SET name = 'Renamed' WHERE id = ?").run(f.session),
    'an emotion PROPOSAL nobody accepted': f => db.prepare(
        "INSERT INTO film_music_emotion_ranges (id, session_id, start_ms, end_ms, label, source, status) VALUES (?, ?, 0, 1000, 'joy', 'ai_proposal', 'proposed')")
        .run(generateId(), f.session),
};

test('every drift-bearing field has a mutation here, and every mutation moves the fingerprint and is named', () => {
    const driftFields = Object.entries(ctx.BRIEF_FIELDS).filter(([, s]) => s.drift).map(([k]) => k);
    assert.ok(driftFields.length >= 6);
    for (const field of driftFields) assert.ok(MUTATORS[field], `drift-bearing field '${field}' has no mutation in this suite`);
    for (const field of Object.keys(MUTATORS)) assert.ok(driftFields.includes(field), `mutation for '${field}', which the registry says bears no drift`);

    for (const field of driftFields) {
        const f = film();
        const before = ctx.compileScoreContext(db, { sessionId: f.session });
        MUTATORS[field](f);
        const after = ctx.compileScoreContext(db, { sessionId: f.session });
        assert.notStrictEqual(after.fingerprints.context, before.fingerprints.context, `${field}: changing it did not move the context fingerprint`);
        assert.notStrictEqual(after.field_fingerprints[field], before.field_fingerprints[field], `${field}: its own field fingerprint did not move`);
        const cmp = ctx.compareContext(before, after);
        assert.strictEqual(cmp.drifted, true, `${field}: compareContext says nothing drifted`);
        assert.ok(cmp.changed.some(c => c.field === field), `${field}: compareContext names ${JSON.stringify(cmp.changed.map(c => c.field))} instead`);
    }
});

test('a non-input does not move the fingerprint, and a proposal nobody accepted is a non-input', () => {
    for (const [what, mutate] of Object.entries(NON_INPUTS)) {
        const f = film();
        const before = ctx.compileScoreContext(db, { sessionId: f.session });
        mutate(f);
        const after = ctx.compileScoreContext(db, { sessionId: f.session });
        assert.strictEqual(after.fingerprints.context, before.fingerprints.context, `${what} moved the context fingerprint — a warning that fires on this is one people learn to dismiss`);
        assert.strictEqual(ctx.compareContext(before, after).drifted, false, `${what}: reported as drift`);
    }
});

test('the script and picture fingerprints move independently, so drift says WHICH side moved', () => {
    const f = film();
    const before = ctx.compileScoreContext(db, { sessionId: f.session });
    MUTATORS.screenplay(f);
    const script = ctx.compileScoreContext(db, { sessionId: f.session });
    assert.notStrictEqual(script.fingerprints.script, before.fingerprints.script);
    assert.strictEqual(script.fingerprints.picture, before.fingerprints.picture, 'a screenplay edit moved the picture fingerprint');
    MUTATORS.picture(f);
    const picture = ctx.compileScoreContext(db, { sessionId: f.session });
    assert.notStrictEqual(picture.fingerprints.picture, script.fingerprints.picture);
    assert.strictEqual(picture.fingerprints.script, script.fingerprints.script, 'a reorder moved the script fingerprint');
});

// ── Session drift: reported, never silently rebased ────────────────────────

test('a session reports drift against what it was stamped with, and stamping is explicit', () => {
    const f = film();
    const untracked = ctx.sessionDrift(db, f.session);
    assert.strictEqual(untracked.tracked, false, 'a session with no fingerprints reads as tracked');
    assert.strictEqual(untracked.drifted, false, 'an untracked session reads as drifted — that would fire on every session on day one');

    const stamped = ctx.stampSessionContext(db, f.session);
    assert.strictEqual(stamped.ok, true);
    const row = db.prepare('SELECT script_fingerprint, picture_fingerprint, context_fingerprint FROM film_music_sessions WHERE id = ?').get(f.session);
    assert.strictEqual(row.context_fingerprint, stamped.fingerprints.context);

    const fresh = ctx.sessionDrift(db, f.session);
    assert.deepStrictEqual([fresh.tracked, fresh.drifted], [true, false]);

    MUTATORS.screenplay(f);
    const drifted = ctx.sessionDrift(db, f.session);
    assert.strictEqual(drifted.drifted, true);
    assert.strictEqual(drifted.script.changed, true);
    assert.strictEqual(drifted.picture.changed, false);
    assert.ok(drifted.fields.includes('screenplay'), `fields: ${drifted.fields}`);
    // Reporting did not rebase: the stored fingerprints are what they were.
    const still = db.prepare('SELECT context_fingerprint FROM film_music_sessions WHERE id = ?').get(f.session);
    assert.strictEqual(still.context_fingerprint, row.context_fingerprint, 'sessionDrift silently rebased the session');
    // The rebase is the explicit act, and clears the drift.
    ctx.stampSessionContext(db, f.session);
    assert.strictEqual(ctx.sessionDrift(db, f.session).drifted, false);
});

// ── The scene fallback, and never throwing ─────────────────────────────────

test('a session on a scene, with no sequence, is briefed from that scene\'s shots in running order', () => {
    const f = film();
    const sid = generateId();
    db.prepare("INSERT INTO film_music_sessions (id, project_id, scene_id, name) VALUES (?, ?, ?, 'scene session')").run(sid, f.project, f.scene1);
    const out = ctx.compileScoreContext(db, { sessionId: sid });
    assert.strictEqual(out.brief.picture.kind, 'scene');
    assert.deepStrictEqual(out.brief.picture.shots.map(s => s.shot_code), ['1A', '1B']);
    assert.deepStrictEqual(out.brief.screenplay.passages.map(p => p.scene_id), [f.scene1]);
    assert.deepStrictEqual(out.brief.characters, ['RAY']);
    // And one attached to nothing is refused with a reason, not a throw.
    const orphan = generateId();
    db.prepare("INSERT INTO film_music_sessions (id, project_id, name) VALUES (?, ?, 'nothing')").run(orphan, f.project);
    const none = ctx.compileScoreContext(db, { sessionId: orphan });
    assert.strictEqual(none.ok, false);
    assert.match(none.error, /sequence|scene/i);
    assert.strictEqual(ctx.compileScoreContext(db, { sessionId: generateId() }).ok, false);
});

test('a broken scene card is named, and does not take the brief down', () => {
    const f = film();
    db.prepare("UPDATE film_shots SET scene_card_yaml = '{not json' WHERE id = ?").run(f.s1B);
    const out = ctx.compileScoreContext(db, { sessionId: f.session });
    assert.strictEqual(out.ok, true);
    assert.ok(out.warnings.some(w => /1B/.test(w)), 'the broken card is not named');
    assert.strictEqual(out.brief.picture.shots.length, 3);
});
