const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * A DELIVERABLE IS ONE PROJECT-LEVEL ARTEFACT, NOT A COUNT OF SHOT PIECES.
 *
 * SHIP-004. The broadcast QC's `video_master` used to pass by counting
 * per-shot `video_final` rows — green on shot 1 of N — and was corrected to
 * read the conformed film. `audio_master` was left counting: any dialogue
 * line, any cue, any per-shot mix made it pass, so a project with one line of
 * generated speech reported an audio deliverable registered.
 *
 * And the CONFORM read the mix the same loose way: `planConform` took any
 * `audio_mix` on the project, and every mix the engine writes today carries a
 * shot_id — it is ONE SHOT's mix. Laid under the whole film it plays that
 * shot's sound over every other shot, and nothing errors.
 *
 * So the rule is stated once and read twice: the project mix is an
 * `audio_mix` with NO shot, the project master is a `video_final` marked
 * `kind: project_master`, and both the QC and the conform find them through
 * the same functions. Set-based over the deliverables registry — fixing one
 * of two and leaving the other counting is exactly the shape this arrived in.
 */

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-qa-master-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const qa = require('../routes/qa');
const conform = require('../lib/conform');

const QA_SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'qa.js'), 'utf8');
const CONFORM_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'conform.js'), 'utf8');

function makeFilm(shotCount) {
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Deliverables');
    const sceneId = generateId();
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, '1', 'STREET')")
        .run(sceneId, projectId);
    const shots = [];
    for (let i = 0; i < shotCount; i++) {
        const id = generateId();
        db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms, sort_order)
                    VALUES (?, ?, ?, '{}', 2000, ?)`).run(id, sceneId, `1${String.fromCharCode(65 + i)}`, i);
        shots.push(id);
    }
    return { projectId, sceneId, shots };
}

/** A per-shot piece of the same asset type — what must NOT count. */
function decoy(spec, projectId, shotId, n) {
    db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, metadata)
                VALUES (?, ?, ?, ?, ?, ?, '{}')`)
        .run(generateId(), projectId, shotId, spec.asset_type, `/tmp/piece_${n}.bin`, `piece_${n}.bin`);
}

/** The project-level artefact, built from the registry's own description of it. */
function deliverable(spec, projectId) {
    db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, metadata)
                VALUES (?, ?, NULL, ?, ?, ?, ?)`)
        .run(generateId(), projectId, spec.asset_type, `/tmp/${spec.key}.bin`, `${spec.key}.bin`,
            JSON.stringify(spec.metadata_kind ? { kind: spec.metadata_kind } : {}));
}

function checks(projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    return qa.buildBroadcastChecks(projectId, project);
}
const checkFor = (projectId, key) => checks(projectId).find(c => c.key === key);

// ── The registry ───────────────────────────────────────────────────────────

test('the deliverables registry names both masters, and each says what it is', () => {
    const reg = qa.PROJECT_DELIVERABLES;
    assert.ok(reg && typeof reg === 'object', 'routes/qa.js exports no PROJECT_DELIVERABLES');
    for (const key of ['video_master', 'audio_master']) {
        assert.ok(reg[key], `${key} is not a registered deliverable`);
    }
    for (const [key, spec] of Object.entries(reg)) {
        assert.strictEqual(spec.key, key);
        assert.ok(spec.asset_type, `${key} does not say which asset type it is`);
        assert.strictEqual(typeof spec.find, 'function', `${key} has no finder`);
        assert.ok(['fail', 'warning'].includes(spec.missing_status), `${key} has no verdict for absence`);
    }
    // Every registered deliverable is a broadcast check, and no check named
    // *_master is unregistered — a check outside the registry is one that
    // can go back to counting with nothing to catch it.
    const { projectId } = makeFilm(1);
    const keys = checks(projectId).map(c => c.key);
    for (const key of Object.keys(reg)) assert.ok(keys.includes(key), `${key} is registered and not checked`);
    for (const key of keys.filter(k => /_master$/.test(k))) assert.ok(reg[key], `${key} is checked outside the registry`);
});

// ── Absent, decoyed, present — for every deliverable ───────────────────────

test('no deliverable passes on nothing', () => {
    assert.ok(Object.keys(qa.PROJECT_DELIVERABLES).length);
    for (const spec of Object.values(qa.PROJECT_DELIVERABLES)) {
        const { projectId } = makeFilm(2);
        const c = checkFor(projectId, spec.key);
        assert.ok(c, `${spec.key} missing from the checks`);
        assert.strictEqual(c.status, spec.missing_status, `${spec.key}: ${c.status} on an empty project`);
    }
});

test('no deliverable passes on a count of per-shot pieces', () => {
    assert.ok(Object.keys(qa.PROJECT_DELIVERABLES).length);
    for (const spec of Object.values(qa.PROJECT_DELIVERABLES)) {
        const { projectId, shots } = makeFilm(3);
        shots.forEach((shotId, n) => decoy(spec, projectId, shotId, n));
        const c = checkFor(projectId, spec.key);
        assert.notStrictEqual(c.status, 'pass',
            `${spec.key} passed on three per-shot ${spec.asset_type} rows and no project-level one — green on shot 1 of N`);
        // And it says what it saw, so the reader is not sent to the database.
        assert.match(c.detail, /3/, `${spec.key}: the detail does not count the pieces it declined (${c.detail})`);
    }
});

test('every deliverable passes on its project-level artefact, and names it', () => {
    assert.ok(Object.keys(qa.PROJECT_DELIVERABLES).length);
    for (const spec of Object.values(qa.PROJECT_DELIVERABLES)) {
        const { projectId, shots } = makeFilm(2);
        shots.forEach((shotId, n) => decoy(spec, projectId, shotId, n));
        deliverable(spec, projectId);
        const c = checkFor(projectId, spec.key);
        assert.strictEqual(c.status, 'pass', `${spec.key}: ${c.status} with the artefact registered (${c.detail})`);
        assert.match(c.detail, new RegExp(`${spec.key}\\.bin`), `${spec.key}: the detail does not name the file`);
    }
});

// ── One finder per deliverable, read by the conform as well ────────────────

test('the conform reads the project mix through the same finder as the QC', () => {
    const spec = qa.PROJECT_DELIVERABLES.audio_master;
    assert.strictEqual(spec.find, conform.findProjectMix, 'the QC and the conform have different ideas of the project mix');
    assert.strictEqual(qa.PROJECT_DELIVERABLES.video_master.find, conform.findProjectMaster);
    // Called, not merely imported.
    assert.match(CONFORM_SRC.slice(CONFORM_SRC.indexOf('function planConform')), /findProjectMix\(/,
        'planConform does not use the finder');
    assert.match(QA_SRC, /PROJECT_DELIVERABLES\[|\.find\(/, 'the checks do not go through the registry');
});

test('a per-shot mix is not laid under the whole film; the project mix is', () => {
    const { projectId, shots } = makeFilm(2);
    for (const [n, shotId] of shots.entries()) {
        db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name)
                    VALUES (?, ?, ?, 'video_raw', ?, ?)`).run(generateId(), projectId, shotId, `/tmp/c${n}.mp4`, `c${n}.mp4`);
    }
    decoy(qa.PROJECT_DELIVERABLES.audio_master, projectId, shots[0], 0);
    let plan = conform.planConform(projectId);
    assert.strictEqual(plan.audio, null, `one shot's mix became the audio of the whole film: ${JSON.stringify(plan.audio)}`);
    assert.strictEqual(plan.keeps_clip_audio, true);

    deliverable(qa.PROJECT_DELIVERABLES.audio_master, projectId);
    plan = conform.planConform(projectId);
    assert.ok(plan.audio && /audio_master\.bin$/.test(plan.audio.file_path), 'the project mix was not chosen');
    assert.strictEqual(plan.keeps_clip_audio, false);
});
