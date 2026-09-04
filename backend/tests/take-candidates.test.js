const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-takes-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const envelope = require('../lib/approval-envelope');
const { handleApprovals } = require('../routes/approvals');
const { callRoute } = require('../lib/mcp-tools');

const DATA = process.env.FILM_DATA_DIR;
const get = (url) => callRoute('GET', url, {}, handleApprovals);

function makeShot() {
    const projectId = generateId(), sceneId = generateId(), shotId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Takes');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, ?, ?)')
        .run(sceneId, projectId, '1', 'A DINER - DAY');
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)')
        .run(shotId, sceneId, '1A', JSON.stringify({ description: 'x', camera: {} }));
    return { projectId, sceneId, shotId };
}

/** Archived attempts, the way regeneration actually writes them. */
function attempt(ctx, version, meta) {
    const dir = path.join(DATA, 'storyboards', ctx.projectId, 'versions');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${ctx.shotId}_v${version}.png`);
    fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'));
    db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path,
                                         file_name, version, metadata)
                VALUES (?, ?, ?, 'storyboard', ?, ?, ?, ?)`)
        .run(generateId(), ctx.projectId, ctx.shotId, file,
             path.basename(file), version, JSON.stringify(meta || {}));
    return file;
}

test('candidates are newest-first and mark the current version', async () => {
    const ctx = makeShot();
    attempt(ctx, 1, {});
    attempt(ctx, 2, {});
    attempt(ctx, 3, {});
    db.prepare('UPDATE film_shots SET current_frame_version = ? WHERE id = ?').run(2, ctx.shotId);

    const r = await get(`/film/shots/${ctx.shotId}/take-candidates`);
    assert.strictEqual(r._status, 200, JSON.stringify(r.body).slice(0, 200));
    const e = r.body;
    assert.strictEqual(e.kind, 'take_selection');
    assert.strictEqual(e.free, true);

    const versions = e.candidates.map(c => c.version);
    assert.deepStrictEqual(versions, [3, 2, 1], 'candidates are not newest-first');
    assert.strictEqual(e.current_version, 2);
    const current = e.candidates.filter(c => c.is_current).map(c => c.version);
    assert.deepStrictEqual(current, [2], 'the current version is not marked exactly once');
});

/*
 * WHY an attempt exists is most of what separates two near-identical frames.
 * A version number alone tells a person nothing about which one to pick.
 */
test('a refined candidate carries its instruction and what it was refined from', async () => {
    const ctx = makeShot();
    attempt(ctx, 1, {});
    attempt(ctx, 2, { refined_from: 1, instruction: 'move the car to the kerb' });

    const r = await get(`/film/shots/${ctx.shotId}/take-candidates`);
    const v2 = r.body.candidates.find(c => c.version === 2);
    assert.strictEqual(v2.refined_from, 1, 'a refined candidate does not say what it came from');
    assert.strictEqual(v2.instruction, 'move the car to the kerb',
        'a refined candidate does not carry the instruction that produced it');
    assert.ok(v2.source, 'a candidate does not say how it came to exist');
});

test('a shot with one frame returns one candidate, not an error', async () => {
    const ctx = makeShot();
    attempt(ctx, 1, {});
    const r = await get(`/film/shots/${ctx.shotId}/take-candidates`);
    assert.strictEqual(r._status, 200);
    assert.strictEqual(r.body.candidates.length, 1);
});

test('a shot with no frames returns an empty list, not an error', async () => {
    const ctx = makeShot();
    const r = await get(`/film/shots/${ctx.shotId}/take-candidates`);
    assert.strictEqual(r._status, 200);
    assert.deepStrictEqual(r.body.candidates, []);
});

test('limit is honoured and bounded', async () => {
    const ctx = makeShot();
    for (let v = 1; v <= 9; v++) attempt(ctx, v, {});
    const r = await get(`/film/shots/${ctx.shotId}/take-candidates?limit=3`);
    assert.strictEqual(r.body.candidates.length, 3);
    assert.deepStrictEqual(r.body.candidates.map(c => c.version), [9, 8, 7],
        'limit did not take the newest');
});

/*
 * A candidate whose picture is gone is LISTED AS UNSELECTABLE WITH THE REASON,
 * never omitted. It is real history — attempts predating per-version archiving
 * exist and cannot be chosen — and a short list with no explanation reads as
 * attempts having been lost.
 */
test('an attempt whose picture is gone is listed, not dropped, and says why', async () => {
    const ctx = makeShot();
    const kept = attempt(ctx, 1, {});
    const lost = attempt(ctx, 2, {});
    fs.unlinkSync(lost);

    const r = await get(`/film/shots/${ctx.shotId}/take-candidates`);
    assert.strictEqual(r.body.candidates.length, 2, 'a lost attempt was dropped from the list');
    const gone = r.body.candidates.find(c => c.version === 2);
    assert.strictEqual(gone.selectable, false, 'an attempt with no picture was offered as choosable');
    assert.ok(gone.reason, 'an unselectable candidate does not say why');
    assert.ok(fs.existsSync(kept));
});

test('media travels by path, and the packet says so', async () => {
    const ctx = makeShot();
    attempt(ctx, 1, {});
    const r = await get(`/film/shots/${ctx.shotId}/take-candidates`);
    assert.strictEqual(r.body.media.transport, envelope.MEDIA_TRANSPORT);
    for (const c of r.body.candidates.filter(x => x.path)) {
        assert.ok(path.isAbsolute(c.path), 'a candidate path is not absolute');
        assert.ok(fs.existsSync(c.path), 'a candidate names a path that does not exist');
        assert.ok(c.bytes > 0 && c.mime, 'a candidate carries no size or type');
    }
});

/*
 * Resolution goes back through the selection that already exists. A second
 * selection concept would be a second answer to "which is the take", and the
 * two would disagree the first time either was used.
 */
test('resolution points at the existing selection, not a new one', async () => {
    const ctx = makeShot();
    attempt(ctx, 1, {});
    const r = await get(`/film/shots/${ctx.shotId}/take-candidates`);
    assert.match(r.body.resolve_with, /\/select$/,
        'the packet does not name how a take is resolved');

    // And that route really exists.
    const takes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'takes.js'), 'utf8');
    assert.match(takes, /'select'/, 'routes/takes.js no longer handles a selection');
});

test('an unknown shot is a 404, not an empty packet', async () => {
    const r = await get(`/film/shots/${generateId()}/take-candidates`);
    assert.strictEqual(r._status, 404);
});

/*
 * Every tool that puts an option in the URL must have it arrive.
 *
 * The shim built `parts` from the path and passed an EMPTY query, so twelve
 * tools offered controls that reached nothing — the defaults came back and
 * nobody was told. Behavioural: the same route is driven with and without the
 * parameter and the answers must differ.
 */
test('a query string in a tool path reaches the handler', async () => {
    const ctx = makeShot();
    for (let v = 1; v <= 5; v++) attempt(ctx, v, {});

    const all = await get(`/film/shots/${ctx.shotId}/take-candidates`);
    const two = await get(`/film/shots/${ctx.shotId}/take-candidates?limit=2`);
    assert.notStrictEqual(all.body.candidates.length, two.body.candidates.length,
        'the query string did not reach the handler — every tool that carries one is getting defaults');
    assert.strictEqual(two.body.candidates.length, 2);
});

test('tools that build a query string still build one', () => {
    // The REGISTRY, not the presented list: `listTools()` returns the shape a
    // model sees (name, description, inputSchema) and drops `path` entirely,
    // so scanning it finds nothing and passes over an empty set.
    const { ALL_ROUTE_TOOLS } = require('../lib/mcp-tools');
    const withQuery = ALL_ROUTE_TOOLS.filter(t => typeof t.path === 'function').filter((t) => {
        try {
            // Every declared argument supplied, so any conditional segment fires.
            const args = {};
            for (const k of Object.keys(t.schema || {})) args[k] = 'x';
            return String(t.path(args)).includes('?');
        } catch (_) { return false; }
    });
    assert.ok(withQuery.length >= 10,
        `only ${withQuery.length} tools build a query string; this scan is not reading them`);
});
