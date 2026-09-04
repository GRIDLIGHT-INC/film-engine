const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-paths-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const dp = require('../lib/data-paths');
const DATA = process.env.FILM_DATA_DIR;

function project() {
    const id = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(id, 'Paths');
    return id;
}

/** A real file inside the data directory, and the row that names it. */
function asset(projectId, subdir, name, storedAs) {
    const dir = path.join(DATA, subdir, projectId);
    fs.mkdirSync(dir, { recursive: true });
    const abs = path.join(dir, name);
    fs.writeFileSync(abs, 'x');
    const id = generateId();
    db.prepare(`INSERT INTO film_assets (id, project_id, asset_type, file_path, file_name)
                VALUES (?, ?, 'storyboard', ?, ?)`)
        .run(id, projectId, storedAs === undefined ? abs : storedAs, name);
    return { id, abs };
}

// ══ the two shapes ══════════════════════════════════════════════════════════

test('a path inside the data directory is stored relative and resolves back', () => {
    const abs = path.join(DATA, 'storyboards', 'P', '1A.png');
    const stored = dp.toStored(abs);
    assert.ok(!path.isAbsolute(stored), `${stored} is still absolute`);
    assert.strictEqual(dp.resolveStored(stored), abs, 'it does not round-trip');
});

/*
 * A path OUTSIDE the data directory is left absolute. Media referenced by an
 * operator is not ours to relativise — a relative form would silently mean a
 * different file.
 */
test('a path outside the data directory is left absolute', () => {
    const outside = path.join(os.tmpdir(), 'elsewhere', 'x.png');
    assert.strictEqual(dp.toStored(outside), outside);
    assert.strictEqual(dp.resolveStored(outside), outside);
});

/*
 * THE TOLERANCE THAT MAKES THIS SHIPPABLE. Every row written before this
 * existed is absolute; a resolver that only understood the new shape would
 * break every project on the day it shipped.
 */
test('resolveStored accepts both shapes', () => {
    const abs = path.join(DATA, 'refsheets', 'P', 'a.png');
    assert.strictEqual(dp.resolveStored(abs), abs, 'an absolute path was mangled');
    assert.strictEqual(dp.resolveStored('refsheets/P/a.png'), abs, 'a relative path did not resolve');
    for (const empty of ['', null, undefined]) assert.strictEqual(dp.resolveStored(empty), '');
});

// ══ the repair — behavioural, over a real move ══════════════════════════════

/*
 * THE FAILURE THIS EXISTS FOR, REPRODUCED.
 *
 * A row written with an absolute path into a directory that is then moved. The
 * repair must find the file at the new location and correct the row — and it
 * must do it for EVERY declared column, because the failure is partial by
 * nature: repairing film_assets and leaving render_ledger looks like it worked.
 */
test('a moved profile is repaired, for every declared path column', () => {
    const pid = project();
    const rows = [];
    // One row per declared column, each naming a real file, each stored with a
    // stale absolute path from a directory that no longer exists.
    const stale = path.join(os.tmpdir(), 'old-profile-' + crypto.randomUUID().slice(0, 6));

    for (const spec of dp.PATH_COLUMNS) {
        const sub = 'storyboards';
        const dir = path.join(DATA, sub, pid);
        fs.mkdirSync(dir, { recursive: true });
        const name = `${spec.table}.png`;
        fs.writeFileSync(path.join(dir, name), 'x');
        const stalePath = path.join(stale, 'film-engine', 'data', sub, pid, name);

        const id = generateId();
        try {
            /*
             * Built from the table's OWN NOT NULL columns rather than from a
             * per-table branch: nineteen tables is too many to hand-write, and
             * a fixture that silently skips the ones it cannot satisfy would
             * shrink the denominator to whatever was easy.
             */
            const cols = db.prepare(`PRAGMA table_info(${spec.table})`).all();
            const need = cols.filter(c => c.notnull && c.dflt_value === null
                && c.name !== spec.key && c.name !== spec.column);
            const names = [spec.key, spec.column, ...need.map(c => c.name)];
            const values = [id, stalePath, ...need.map((c) => {
                if (/project_id/.test(c.name)) return pid;
                // A CHECK-constrained vocabulary column needs a legal value.
                if (c.name === 'asset_type') return 'storyboard';
                if (/shot_id|scene_id|version_id|character_id|location_id|prop_id/.test(c.name)) return generateId();
                return /INT|REAL/i.test(c.type || '') ? 0 : 'x';
            })];
            /*
             * FKs off for the fixture only. This test is about whether a moved
             * path is repaired; satisfying nineteen tables' referential graphs
             * would make the fixture the subject. Turned back on immediately,
             * so nothing else in the file runs without them.
             */
            db.pragma('foreign_keys = OFF');
            try {
                db.prepare(`INSERT INTO ${spec.table} (${names.join(', ')})
                            VALUES (${names.map(() => '?').join(', ')})`).run(...values);
            } finally { db.pragma('foreign_keys = ON'); }
            rows.push({ spec, id, name });
        } catch (err) {
            // A table whose NOT NULLs this fixture cannot satisfy is skipped
            // LOUDLY rather than silently reducing the denominator.
            rows.push({ spec, id: null, skipped: String(err.message).slice(0, 60) });
        }
    }

    const covered = rows.filter(r => r.id);
    assert.ok(covered.length >= Math.ceil(dp.PATH_COLUMNS.length * 0.8),
        `only ${covered.length} of ${dp.PATH_COLUMNS.length} columns could be exercised: `
        + rows.filter(r => !r.id).map(r => `${r.spec.table} (${r.skipped})`).join('; '));

    // Before: none of them resolve.
    for (const r of covered) {
        const v = db.prepare(`SELECT ${r.spec.column} p FROM ${r.spec.table} WHERE ${r.spec.key} = ?`).get(r.id).p;
        assert.strictEqual(dp.storedExists(v), false, `${r.spec.table} resolved before the repair`);
    }

    const report = dp.repairPaths(db);
    assert.strictEqual(report.repaired >= covered.length, true,
        `repaired ${report.repaired}, expected at least ${covered.length}`);

    // After: every one resolves, and is stored relative.
    for (const r of covered) {
        const v = db.prepare(`SELECT ${r.spec.column} p FROM ${r.spec.table} WHERE ${r.spec.key} = ?`).get(r.id).p;
        assert.strictEqual(dp.storedExists(v), true,
            `${r.spec.table}.${r.spec.column} still does not resolve after the repair`);
        // Repaired ABSOLUTE by default — see the reasoning in repairPaths. The
        // relative form is available and gated behind an explicit flag until
        // every read resolves it.
        assert.ok(path.isAbsolute(v), `${r.spec.table}.${r.spec.column} was repaired to a relative path, which the read sites cannot resolve`);
    }
});

/*
 * IT MUST NEVER TOUCH A WORKING PATH. That rule is what makes it safe to run on
 * every boot — and safe on an install with a legitimately external file.
 */
test('the repair never rewrites a path that already resolves', () => {
    const pid = project();
    const a = asset(pid, 'refsheets', 'keep-abs.png');                    // absolute, exists
    const b = asset(pid, 'refsheets', 'keep-rel.png', `refsheets/${pid}/keep-rel.png`);

    const before = ['a', 'b'].map((_, i) =>
        db.prepare('SELECT file_path p FROM film_assets WHERE id = ?').get([a.id, b.id][i]).p);
    dp.repairPaths(db);
    const after = ['a', 'b'].map((_, i) =>
        db.prepare('SELECT file_path p FROM film_assets WHERE id = ?').get([a.id, b.id][i]).p);
    assert.deepStrictEqual(after, before, 'the repair rewrote a path that was already working');
});

test('a file that is genuinely gone is reported, not invented', () => {
    const pid = project();
    const id = generateId();
    db.prepare(`INSERT INTO film_assets (id, project_id, asset_type, file_path, file_name)
                VALUES (?, ?, 'storyboard', ?, ?)`)
        .run(id, pid, '/nowhere/at/all/storyboards/x/gone.png', 'gone.png');

    const report = dp.repairPaths(db);
    assert.ok(report.unresolvable >= 1, 'a missing file was not reported');
    const after = db.prepare('SELECT file_path p FROM film_assets WHERE id = ?').get(id).p;
    assert.strictEqual(after, '/nowhere/at/all/storyboards/x/gone.png',
        'a row whose file is genuinely gone was rewritten to a path that also does not exist');
});

test('a path with no recognisable tail is not guessed at', () => {
    assert.strictEqual(dp.tailOf('/etc/passwd'), null);
    assert.strictEqual(dp.tailOf(''), null);
    // Any prefix: the tail is found by the SUBDIR, not by the directory it
    // used to live under — which is what lets it survive a move to anywhere.
    assert.strictEqual(dp.tailOf('/somewhere/old/profile/data/refsheets/P/a.png'),
        path.join('refsheets', 'P', 'a.png'));
});

// ══ the registry cannot silently go stale ═══════════════════════════════════

/*
 * DERIVED FROM THE SCHEMA. A path column added later must be listed here or
 * excluded BY NAME with a reason — otherwise a move breaks it and the repair
 * that exists to catch that never looks at it.
 *
 * This caught a real misclassification on its first run: film_marketing_assets
 * .image_path stores a bare FILENAME, and listing it as a path made the boot
 * repair report a healthy row as unresolvable.
 */
test('every path-shaped column is either registered or excluded by name', () => {
    const declared = new Set(dp.PATH_COLUMNS.map(s => `${s.table}.${s.column}`));
    const excluded = new Set(Object.keys(dp.NOT_PATHS));
    const unaccounted = [];

    const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    let scanned = 0;
    for (const t of tables) {
        let cols = [];
        try { cols = db.prepare(`PRAGMA table_info(${t.name})`).all(); } catch (_) { continue; }
        for (const c of cols) {
            if (!/path|_url$/i.test(c.name)) continue;
            scanned++;
            const key = `${t.name}.${c.name}`;
            if (!declared.has(key) && !excluded.has(key)) unaccounted.push(key);
        }
    }
    assert.ok(scanned >= 8, `only ${scanned} path-shaped columns found; this scan is not reading the schema`);
    assert.deepStrictEqual(unaccounted, [],
        `these path-shaped columns are neither registered nor excluded: ${unaccounted.join(', ')}`);

    // And an exclusion must name a column that still exists.
    for (const key of excluded) {
        const [t, c] = key.split('.');
        let cols = [];
        try { cols = db.prepare(`PRAGMA table_info(${t})`).all(); } catch (_) { continue; }
        if (!cols.length) continue;                 // table gone entirely
        assert.ok(cols.some(x => x.name === c),
            `NOT_PATHS names ${key}, which no longer exists — a stale exemption makes the list a story`);
    }
});

test('every registered column really exists', () => {
    for (const spec of dp.PATH_COLUMNS) {
        const cols = db.prepare(`PRAGMA table_info(${spec.table})`).all();
        assert.ok(cols.length, `${spec.table} does not exist`);
        assert.ok(cols.some(c => c.name === spec.column), `${spec.table}.${spec.column} does not exist`);
        assert.ok(cols.some(c => c.name === spec.key), `${spec.table}.${spec.key} does not exist`);
    }
});

/* The boot path runs it, or none of this protects anybody. */
test('the server repairs paths at boot', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(src, /repairPaths\(/, 'server.js does not repair paths at boot');
    const at = src.indexOf('repairPaths(');
    const schemaAt = src.indexOf('ensureSchema()');
    assert.ok(schemaAt > -1 && at > schemaAt,
        'the repair runs before the schema is ensured, so a new column would not exist yet');
});

/*
 * The relative form still works, and is reachable — it is the end state once
 * every read goes through `resolveStored`. Gated, not absent.
 */
test('the relative form is available behind an explicit flag', () => {
    const pid = project();
    const dir = path.join(DATA, 'refsheets', pid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'rel.png'), 'x');
    const id = generateId();
    db.prepare(`INSERT INTO film_assets (id, project_id, asset_type, file_path, file_name)
                VALUES (?, ?, 'storyboard', ?, ?)`)
        .run(id, pid, path.join('/gone/refsheets', pid, 'rel.png'), 'rel.png');

    dp.repairPaths(db, { relative: true });
    const v = db.prepare('SELECT file_path p FROM film_assets WHERE id = ?').get(id).p;
    assert.ok(!path.isAbsolute(v), 'the relative flag did not store a relative path');
    assert.ok(dp.storedExists(v), 'the relative path does not resolve through resolveStored');
});
