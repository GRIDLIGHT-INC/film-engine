/**
 * Acts live in the screenplay, not in a table beside it.
 *
 * `film_acts` and `film_scenes.act_id` were the last two-sources-of-truth
 * problem in the screenplay layer: two ways to say which act a scene is in,
 * with nothing to reconcile them. The plan's first commitment is that the
 * Fountain document is the single source of truth and anything wanting a table
 * must argue why the format cannot hold it — and acts could not make that
 * argument, because Fountain `#` sections say exactly this, with depth.
 *
 * The evidence that settled it: **both were empty.** `film_acts` had 0 rows
 * across every project and 0 scenes carried an `act_id`; 0 sections had ever
 * been written either, because until phase 2 the editor could not author one.
 * So there was nothing to migrate and the choice was purely which mechanism
 * survives. Sections win: they are authorable in the editor, they export to
 * Final Draft, and they travel with any copy of the script.
 *
 * The one field Fountain genuinely cannot express is writers-tool's
 * `includeInCompile` — "hold this act back from the cut" — and the user's answer
 * was that cutting an act means deleting or boneyarding its scenes rather than
 * flagging them. With that gone, the table had nothing left to hold.
 *
 * Set-based over the consumers rather than over the table, because a removal is
 * only finished when every reader is gone: a leftover import fails at runtime
 * on a path nobody tests, and a leftover UI page is a button that 404s.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-acts-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const ROOT = path.join(__dirname, '..', '..');
const BACKEND = path.join(__dirname, '..');

function callRoute(handler, method, urlPath, body) {
    return new Promise(resolve => {
        const parts = urlPath.split('?')[0].split('/').filter(Boolean);
        const chunks = [];
        const res = new Writable({ write(c, _e, n) { chunks.push(c); n(); } });
        res.statusCode = 200;
        res.writeHead = function (code) { this.statusCode = code; return this; };
        res.setHeader = function () {};
        res.on('finish', () => {
            let parsed = Buffer.concat(chunks).toString();
            try { parsed = JSON.parse(parsed); } catch (_) { /* not json */ }
            resolve({ status: res.statusCode, body: parsed });
        });
        Promise.resolve(handler({ method, body: body || {} }, res, parts, {}))
            .catch(err => resolve({ status: 500, body: { error: err.message, stack: err.stack } }));
    });
}

/**
 * Every file that referenced the table, derived by scanning rather than listed.
 *
 * A removal is finished when every reader is gone, and the ones that bite are
 * the ones nobody remembers: a backup manifest that names a dropped table, a
 * demo seeder that inserts into it.
 */
function referencesTo(pattern) {
    const roots = [path.join(BACKEND, 'routes'), path.join(BACKEND, 'lib'), path.join(ROOT, 'src')];
    const hits = [];
    const walk = dir => {
        for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
            if (f.isDirectory()) { if (f.name !== 'node_modules') walk(path.join(dir, f.name)); continue; }
            if (!/\.(js|html)$/.test(f.name)) continue;
            const p = path.join(dir, f.name);
            if (new RegExp(pattern).test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(ROOT, p));
        }
    };
    for (const r of roots) if (fs.existsSync(r)) walk(r);
    if (new RegExp(pattern).test(fs.readFileSync(path.join(BACKEND, 'server.js'), 'utf8'))) {
        hits.push('backend/server.js');
    }
    return hits.sort();
}

// ── The table is gone, and so is every reader ───────────────────────────

test('film_acts no longer exists', () => {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='film_acts'").get();
    assert.ok(!row, 'film_acts is still in the schema');
});

test('film_scenes no longer carries act_id', () => {
    const cols = db.prepare('PRAGMA table_info(film_scenes)').all().map(c => c.name);
    assert.ok(!cols.includes('act_id'),
        'film_scenes.act_id survives — a second way to say which act a scene is in');
});

test('nothing in the codebase reads the dropped table', () => {
    // The failure this catches is a leftover reader: an import that throws on a
    // path nobody tests, or a backup manifest naming a table that is not there.
    const left = referencesTo('film_acts|\\bact_id\\b');
    assert.deepStrictEqual(left, [],
        `these still reference the dropped table: ${left.join(', ')}`);
});

test('the acts route is gone rather than left returning 500', () => {
    assert.ok(!fs.existsSync(path.join(BACKEND, 'routes', 'acts.js')),
        'routes/acts.js survives the table it queries');
    const server = fs.readFileSync(path.join(BACKEND, 'server.js'), 'utf8');
    assert.ok(!/handleActs/.test(server), 'server.js still dispatches to the acts route');
});

test('the backup manifest does not name a table that no longer exists', () => {
    // Backup enumerates tables by name. One that is gone makes every export
    // throw, and exports are the thing you reach for when something else has
    // already gone wrong.
    const src = fs.readFileSync(path.join(BACKEND, 'lib', 'backup.js'), 'utf8');
    assert.ok(!/film_acts/.test(src), 'the backup manifest still lists film_acts');
});

// ── Act structure still works, in the format ────────────────────────────

test('acts are sections, and the outline reports them with depth', async () => {
    const { handleScripts } = require('../routes/scripts');
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Acts');
    await callRoute(handleScripts, 'POST', `/film/projects/${projectId}/script`, {
        fountain_content: 'Title: T\n\n# ACT ONE\n\n## The Harbour\n\nEXT. HARBOUR - DAWN\n\nGone.\n\n'
            + '# ACT TWO\n\nEXT. SLUICE - MORNING\n\nRust.\n',
    });

    const r = await callRoute(handleScripts, 'GET', `/film/projects/${projectId}/outline`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const sections = r.body.outline.filter(n => n.type === 'section');
    assert.strictEqual(sections.length, 3, `expected 3 sections, got ${sections.length}`);
    assert.deepStrictEqual(sections.map(s => s.text), ['ACT ONE', 'The Harbour', 'ACT TWO']);
    assert.deepStrictEqual(sections.map(s => s.depth), [1, 2, 1],
        'nesting was lost — an act and a sequence beneath it read as the same level');
});

test('an act structure survives export to Final Draft', () => {
    // The argument for sections over a table, made concrete: structure in the
    // document travels with the document. A table would have stayed behind.
    const { parseFountain } = require('../lib/fountain-parser');
    const { generateFDX } = require('../lib/fdx-generator');
    const xml = generateFDX(parseFountain('Title: T\n\n# ACT ONE\n\nEXT. A - DAY\n\nx.\n'), { Title: 'T' });
    assert.match(xml, /ACT ONE/, 'the act vanished on the way to Final Draft');
    assert.match(xml, /Section Heading/, 'the act was exported as something other than a section');
});

test('a project bundle carries the act structure', () => {
    // It is in fountain_content, which the bundle already exports, so this is
    // free — but it is the property that made the removal safe and it should
    // fail loudly if the bundle ever stops carrying the screenplay.
    const src = fs.readFileSync(path.join(BACKEND, 'lib', 'backup.js'), 'utf8');
    assert.match(src, /film_scripts/, 'the backup no longer exports the screenplay itself');
});

// ── The way in ──────────────────────────────────────────────────────────

test('a writer can still author an act, and an agent can still write one', () => {
    const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
    // Sections became authorable in phase 2; that is what makes removing the
    // table honest rather than a feature deletion.
    assert.match(html, /section:\s*\/\^#/, 'the editor can no longer author a section');

    const { listTools } = require('../lib/mcp-tools');
    const names = listTools().map(t => t.name);
    for (const tool of ['outline_get', 'outline_write']) {
        assert.ok(names.includes(tool), `${tool} is missing — an agent cannot work with act structure`);
    }
});

test('the acts page is gone from the navigation, not left pointing at nothing', () => {
    // A nav entry whose page cannot load is worse than no entry: it looks like
    // a feature until clicked.
    const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
    assert.ok(!/loadActs/.test(html), 'the acts page loader survives');
    assert.ok(!/'acts'/.test(html), 'the navigation still lists an acts page');
});
