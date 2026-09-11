const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/**
 * THE SCORE-SESSION SCHEMA, HELD TO ITSELF.
 *
 * MUS-001. A session is attached to an ordered picture sequence (or a scene
 * as the fallback) and owns tracks, clips, emotion ranges, markers,
 * automation and an operation lineage. Every lifecycle value is a CHECK, and
 * every relationship declares what happens on delete — the film_refsheet_jobs
 * trap of migration 067 was a foreign key with NO action, which turned a
 * project delete into a 500 the first time the project had real work in it.
 *
 * Set-based over the MIGRATION FILE, not over a list typed here: every table
 * it creates, every `CHECK (col IN (...))`, every range CHECK, every foreign
 * key and its declared rule. A column added to the migration later is in the
 * denominator with nothing to remember.
 *
 * What the migration must NOT do is also asserted: touch film_assets. Its
 * asset_type CHECK cannot be widened in place, and typed stem meaning lives in
 * these tables and in metadata instead (the 3D precedent).
 */

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-music-schema-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');
const MIGRATION = fs.readdirSync(MIGRATIONS).find(f => /music_workstation\.sql$/.test(f));

function source() {
    assert.ok(MIGRATION, 'no *_music_workstation.sql migration exists');
    return fs.readFileSync(path.join(MIGRATIONS, MIGRATION), 'utf8');
}

/** Tables the migration creates, in the order it creates them. */
function tables() {
    return [...source().matchAll(/CREATE TABLE IF NOT EXISTS (film_music_\w+)/g)].map(m => m[1]);
}

/** Every `CHECK (col IN ('a', 'b'))`, keyed by the table it sits in. */
function enums() {
    const out = [];
    const src = source();
    for (const m of src.matchAll(/CREATE TABLE IF NOT EXISTS (film_music_\w+)\s*\(([\s\S]*?)\n\);/g)) {
        const [, table, body] = m;
        for (const c of body.matchAll(/CHECK \((\w+) IN \(([^)]+)\)\)/g)) {
            // Quoted values are strings; bare ones are numbers (sample rates, flags).
            const values = c[2].split(',').map(v => v.trim()).map(v =>
                /^'.*'$/.test(v) ? v.slice(1, -1) : Number(v));
            out.push({ table, column: c[1], values });
        }
    }
    return out;
}

/** Every `CHECK (col >= a AND col <= b)`. */
function ranges() {
    const out = [];
    for (const m of source().matchAll(/CREATE TABLE IF NOT EXISTS (film_music_\w+)\s*\(([\s\S]*?)\n\);/g)) {
        const [, table, body] = m;
        for (const c of body.matchAll(/CHECK \((\w+) >= (-?[\d.]+) AND \1 <= (-?[\d.]+)\)/g)) {
            out.push({ table, column: c[1], min: Number(c[2]), max: Number(c[3]) });
        }
    }
    return out;
}

/** Every `CHECK (a > b)` or `CHECK (a >= b)` between two columns. */
function orderings() {
    const out = [];
    for (const m of source().matchAll(/CREATE TABLE IF NOT EXISTS (film_music_\w+)\s*\(([\s\S]*?)\n\);/g)) {
        const [, table, body] = m;
        for (const c of body.matchAll(/CHECK \((\w+) (>=?) (\w+)\)/g)) {
            out.push({ table, greater: c[1], op: c[2], lesser: c[3] });
        }
    }
    return out;
}

const info = t => db.prepare(`PRAGMA table_info(${t})`).all();
const fks = t => db.prepare(`PRAGMA foreign_key_list(${t})`).all();
const count = (t, where, args) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}${where ? ' WHERE ' + where : ''}`).get(...(args || [])).n;

// ── Fixtures: the minimal valid row for every table, parents on demand ─────

function project() {
    const id = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(id, 'Score');
    return id;
}
function scene(projectId) {
    const id = generateId();
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, '1', 'X')").run(id, projectId);
    return id;
}
function shot(sceneId) {
    const id = generateId();
    db.prepare("INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms, sort_order) VALUES (?, ?, '1A', '{}', 0, 0)").run(id, sceneId);
    return id;
}
function sequence(projectId) {
    const id = generateId();
    db.prepare('INSERT INTO film_sequences (id, project_id, name) VALUES (?, ?, ?)').run(id, projectId, 'seq');
    return id;
}
function script(projectId) {
    const id = generateId();
    db.prepare("INSERT INTO film_scripts (id, project_id, version, content) VALUES (?, ?, 1, 'INT. X - DAY')").run(id, projectId);
    return id;
}
function asset(projectId) {
    const id = generateId();
    db.prepare(`INSERT INTO film_assets (id, project_id, asset_type, file_path, file_name) VALUES (?, ?, 'audio_music', '/tmp/a.wav', 'a.wav')`)
        .run(id, projectId);
    return id;
}

/**
 * One row in `table`, with every parent it needs created for it. Returns the
 * ids so a deletion test can find the parent again. `overrides` sets columns.
 */
function row(table, overrides) {
    const o = overrides || {};
    const ctx = {};
    ctx.project = o.project_id || project();
    const insert = (cols) => {
        const merged = { ...cols, ...o };
        // project_id is the session's column alone; on every other table it is
        // only the fixture's way of naming which project the parents belong to.
        if (table !== 'film_music_sessions') delete merged.project_id;
        const keys = Object.keys(merged);
        db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
            .run(...keys.map(k => merged[k]));
        return merged.id;
    };
    switch (table) {
        case 'film_music_sessions':
            ctx.id = insert({ id: generateId(), project_id: ctx.project, name: 'session' });
            return ctx;
        case 'film_music_tracks':
            ctx.session = o.session_id || row('film_music_sessions', { project_id: ctx.project }).id;
            ctx.id = insert({ id: generateId(), session_id: ctx.session, name: 'track' });
            return ctx;
        case 'film_music_clips':
            ctx.track = o.track_id || row('film_music_tracks', { project_id: ctx.project }).id;
            ctx.id = insert({ id: generateId(), track_id: ctx.track, start_ms: 0, duration_ms: 1000 });
            return ctx;
        case 'film_music_emotion_ranges':
            ctx.session = o.session_id || row('film_music_sessions', { project_id: ctx.project }).id;
            ctx.id = insert({ id: generateId(), session_id: ctx.session, start_ms: 0, end_ms: 1000 });
            return ctx;
        case 'film_music_markers':
            ctx.session = o.session_id || row('film_music_sessions', { project_id: ctx.project }).id;
            ctx.id = insert({ id: generateId(), session_id: ctx.session, position_ms: 0 });
            return ctx;
        case 'film_music_automation':
            ctx.track = o.track_id || row('film_music_tracks', { project_id: ctx.project }).id;
            ctx.id = insert({ id: generateId(), track_id: ctx.track });
            return ctx;
        case 'film_music_operations':
            ctx.session = o.session_id || row('film_music_sessions', { project_id: ctx.project }).id;
            ctx.id = insert({ id: generateId(), session_id: ctx.session });
            return ctx;
        default:
            throw new Error(`no fixture for ${table} — the migration created a table this suite cannot build a row for`);
    }
}

/** A valid parent id for a foreign key, by the table it points at. */
function parentFor(fk, projectId) {
    switch (fk.table) {
        case 'film_projects': return projectId;
        case 'film_sequences': return sequence(projectId);
        case 'film_scenes': return scene(projectId);
        case 'film_shots': return shot(scene(projectId));
        case 'film_scripts': return script(projectId);
        case 'film_assets': return asset(projectId);
        case 'film_music_sessions': return row('film_music_sessions', { project_id: projectId }).id;
        case 'film_music_tracks': return row('film_music_tracks', { project_id: projectId }).id;
        case 'film_music_clips': return row('film_music_clips', { project_id: projectId }).id;
        case 'film_music_operations': return row('film_music_operations', { project_id: projectId }).id;
        default: throw new Error(`no parent fixture for ${fk.table}`);
    }
}

// ── The migration and its tables ───────────────────────────────────────────

test('the migration exists, is applied, and creates the seven tables the epic names', () => {
    const src = source();
    assert.ok(db.prepare('SELECT 1 FROM _film_migrations WHERE name = ?').get(MIGRATION), `${MIGRATION} was not applied`);
    const created = tables();
    for (const want of ['sessions', 'tracks', 'clips', 'emotion_ranges', 'markers', 'automation', 'operations']) {
        assert.ok(created.includes(`film_music_${want}`), `no film_music_${want} table`);
    }
    for (const t of created) {
        assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t), `${t} is not in the database`);
        assert.ok(info(t).some(c => c.name === 'id' && c.pk), `${t} has no id primary key`);
    }
    // Stem typing lives here and in metadata; the asset CHECK is untouched.
    assert.ok(!/ALTER TABLE film_assets|CREATE TABLE.*film_assets|film_assets_new/.test(src),
        'the migration touches film_assets — its asset_type CHECK cannot be widened in place');
});

test('every foreign key column is indexed, so a session read is not a table scan', () => {
    for (const t of tables()) {
        const indexed = new Set();
        for (const ix of db.prepare(`PRAGMA index_list(${t})`).all()) {
            const cols = db.prepare(`PRAGMA index_info(${ix.name})`).all();
            if (cols.length) indexed.add(cols[0].name);
        }
        for (const fk of fks(t)) {
            assert.ok(indexed.has(fk.from), `${t}.${fk.from} references ${fk.table} and has no index`);
        }
    }
});

// ── Every enum: each value accepted, anything else refused ─────────────────

test('every constrained lifecycle value is accepted, and an unlisted one is refused', () => {
    const all = enums();
    assert.ok(all.length >= 10, `only ${all.length} enum CHECKs found — the schema lost its lifecycles`);
    const byTable = new Set(all.map(e => e.table));
    for (const t of ['film_music_sessions', 'film_music_clips', 'film_music_emotion_ranges', 'film_music_operations']) {
        assert.ok(byTable.has(t), `${t} has no constrained lifecycle`);
    }
    for (const e of all) {
        assert.ok(e.values.length >= 2, `${e.table}.${e.column} allows ${e.values.length} value(s)`);
        for (const v of e.values) {
            assert.doesNotThrow(() => row(e.table, { [e.column]: v }), `${e.table}.${e.column} refuses its own value '${v}'`);
        }
        assert.throws(() => row(e.table, { [e.column]: 'not-a-real-value' }), /CHECK/,
            `${e.table}.${e.column} accepted a value the CHECK does not list`);
    }
});

// ── Every range and ordering CHECK ─────────────────────────────────────────

test('every numeric range refuses a value outside it and accepts both ends', () => {
    const all = ranges();
    assert.ok(all.length >= 4, `only ${all.length} range CHECKs found — pan, valence, arousal and intensity should each have one`);
    for (const r of all) {
        assert.doesNotThrow(() => row(r.table, { [r.column]: r.min }), `${r.table}.${r.column} refuses its own minimum`);
        assert.doesNotThrow(() => row(r.table, { [r.column]: r.max }), `${r.table}.${r.column} refuses its own maximum`);
        assert.throws(() => row(r.table, { [r.column]: r.max + 1 }), /CHECK/, `${r.table}.${r.column} accepted ${r.max + 1}`);
        assert.throws(() => row(r.table, { [r.column]: r.min - 1 }), /CHECK/, `${r.table}.${r.column} accepted ${r.min - 1}`);
    }
});

test('a range with its end before its start is refused', () => {
    const all = orderings();
    assert.ok(all.some(o => o.table === 'film_music_emotion_ranges'), 'an emotion range can end before it starts');
    for (const o of all) {
        assert.throws(() => row(o.table, { [o.greater]: 10, [o.lesser]: 20 }), /CHECK/,
            `${o.table}: ${o.greater} ${o.op} ${o.lesser} is not enforced`);
        if (o.op === '>') {
            assert.throws(() => row(o.table, { [o.greater]: 10, [o.lesser]: 10 }), /CHECK/,
                `${o.table}: a zero-length range was accepted`);
        }
    }
});

// ── Every foreign key declares its deletion rule, and it holds ─────────────

test('every foreign key says what happens on delete, and does it', () => {
    let seen = 0;
    for (const t of tables()) {
        for (const fk of fks(t)) {
            seen++;
            assert.ok(['CASCADE', 'SET NULL'].includes(fk.on_delete),
                `${t}.${fk.from} → ${fk.table} declares ON DELETE ${fk.on_delete}: a delete of the parent would be refused with a 500 (the migration 067 trap)`);
            const col = info(t).find(c => c.name === fk.from);
            if (fk.on_delete === 'SET NULL') {
                assert.strictEqual(col.notnull, 0, `${t}.${fk.from} is SET NULL on delete and NOT NULL — the delete would fail`);
            }

            // Behaviourally: make the parent, make the child pointing at it,
            // delete the parent, and read what became of the child.
            const projectId = project();
            const parentId = parentFor(fk, projectId);
            const child = row(t, { project_id: projectId, [fk.from]: parentId });
            assert.strictEqual(count(t, 'id = ?', [child.id]), 1);
            db.prepare(`DELETE FROM ${fk.table} WHERE id = ?`).run(parentId);
            if (fk.on_delete === 'CASCADE') {
                assert.strictEqual(count(t, 'id = ?', [child.id]), 0, `${t}.${fk.from}: parent ${fk.table} deleted and the child survived`);
            } else {
                const after = db.prepare(`SELECT ${fk.from} AS v FROM ${t} WHERE id = ?`).get(child.id);
                assert.ok(after, `${t}.${fk.from}: SET NULL deleted the child`);
                assert.strictEqual(after.v, null, `${t}.${fk.from}: parent deleted and the child still points at it`);
            }
        }
    }
    assert.ok(seen >= 14, `only ${seen} foreign keys across the music tables`);
});

test('deleting a project takes every music table with it, and nothing else\'s rows', () => {
    const mine = project(), theirs = project();
    for (const t of tables()) { row(t, { project_id: mine }); row(t, { project_id: theirs }); }
    const before = Object.fromEntries(tables().map(t => [t, count(t)]));
    db.prepare('DELETE FROM film_projects WHERE id = ?').run(mine);
    for (const t of tables()) {
        // Half the rows belonged to the deleted project (each fixture builds
        // its own parents, so exactly the chain under `mine` goes).
        assert.ok(count(t) < before[t], `${t}: a project delete left its rows behind`);
    }
    assert.strictEqual(count('film_music_sessions', 'project_id = ?', [theirs]) > 0, true, 'the other project lost its session');
});

// ── The sequence is the picture unit; a scene is the fallback ──────────────

test('a session attaches to a sequence or to a scene, and losing either does not lose the score', () => {
    const cols = info('film_music_sessions').map(c => c.name);
    for (const need of ['sequence_id', 'scene_id', 'script_id', 'sample_rate', 'frame_rate', 'tempo_map_json',
        'context_fingerprint', 'status', 'approved_mix_asset_id']) {
        assert.ok(cols.includes(need), `film_music_sessions has no ${need}`);
    }
    const p = project();
    const seq = sequence(p);
    const s = row('film_music_sessions', { project_id: p, sequence_id: seq });
    db.prepare('DELETE FROM film_sequences WHERE id = ?').run(seq);
    const after = db.prepare('SELECT sequence_id FROM film_music_sessions WHERE id = ?').get(s.id);
    assert.ok(after, 'deleting the picture sequence deleted the score session — paid work, gone');
    assert.strictEqual(after.sequence_id, null);
    // 48 kHz is the picture workflow and the default; anything else must be said.
    const sr = info('film_music_sessions').find(c => c.name === 'sample_rate');
    assert.match(String(sr.dflt_value), /48000/, `sample_rate defaults to ${sr.dflt_value}, not 48000`);
});

test('a clip keeps its placement when its source asset is deleted, and says the source is gone', () => {
    const p = project();
    const a = asset(p);
    const c = row('film_music_clips', { project_id: p, asset_id: a });
    db.prepare('DELETE FROM film_assets WHERE id = ?').run(a);
    const after = db.prepare('SELECT asset_id, start_ms, duration_ms FROM film_music_clips WHERE id = ?').get(c.id);
    assert.ok(after, 'the clip went with the asset — the arrangement is the work, the file is replaceable');
    assert.strictEqual(after.asset_id, null);
    assert.strictEqual(after.duration_ms, 1000);
});
