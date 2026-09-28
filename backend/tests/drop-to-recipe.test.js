/**
 * PGN-015 — drop a file to find its recipe.
 *
 * A file dropped on the production canvas is hashed IN THE BROWSER and only the
 * hash and the size are sent: a two-gigabyte clip must not be uploaded to find
 * out it is already here. The server hashes the project's own files — sizes
 * first, so only a same-size file is ever read, and each hash cached against
 * its size and mtime so a file rewritten in place is read again.
 *
 * A match names the node it belongs to (and its parent, for a version the
 * graph does not draw) and carries its recipe. An unknown file is OFFERED as an
 * upload to the node it was dropped on, through the node's own upload route,
 * and only where that node takes that kind of file.
 *
 * Set-based over MATCH_RULES (every asset family the graph draws) and over the
 * page's DROP_TARGETS (every node type × media kind).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-drop-' + crypto.randomUUID().slice(0, 8));
require('../db/schema').ensureSchema();
const { db, generateId } = require('../db/database');
const match = require('../lib/asset-match');

const P = generateId(), OTHER = generateId(), SC = generateId(), SH = generateId(), SEQ = generateId(), CUE = generateId();
db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Drop')").run(P);
db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Other')").run(OTHER);
db.prepare("INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, 1)").run(SC, P);
db.prepare("INSERT INTO film_shots (id, scene_id, shot_code) VALUES (?, ?, '1A')").run(SH, SC);
db.prepare("INSERT INTO film_music_cues (id, project_id, scene_id, cue_type) VALUES (?, ?, ?, 'score')").run(CUE, P, SC);

const dir = path.join(process.env.FILM_DATA_DIR, 'files');
fs.mkdirSync(dir, { recursive: true });
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function asset(project, type, bytes, extra = {}) {
    const id = generateId();
    const p = path.join(dir, id + '.bin');
    fs.writeFileSync(p, bytes);
    db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, scene_id, asset_type, file_name, file_path, version, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(id, project, extra.shot_id || null, extra.scene_id || null, type,
        path.basename(p), p, JSON.stringify(extra.metadata || {}));
    return { id, bytes, path: p };
}

// One of each family the graph draws, each with the node it must land on.
const CASES = [
    { name: 'a frame', a: asset(P, 'storyboard', Buffer.from('frame-bytes-1'), { shot_id: SH, scene_id: SC }), node: `shot:${SH}`, kind: 'frame', parent: `shot:${SH}` },
    { name: "a shot's clip", a: asset(P, 'video_raw', Buffer.from('clip-bytes-12'), { shot_id: SH, scene_id: SC }), node: 'ver:', kind: 'video', parent: `shot:${SH}` },
    { name: "a sequence's clip", a: asset(P, 'video_final', Buffer.from('seq-clip-byte'), { metadata: { sequence_id: SEQ } }), node: 'ver:', kind: 'video', parent: `seq:${SEQ}` },
    { name: "a cue's sound", a: asset(P, 'audio_music', Buffer.from('cue-sound-byt'), { scene_id: SC, metadata: { cue_id: CUE } }), node: 'ver:', kind: 'audio', parent: `sound:${CUE}` },
];

test('every family the graph draws is matched by its bytes to its own node, with its recipe', () => {
    const families = new Set(match.MATCH_RULES.map(r => r.kind));
    for (const k of ['frame', 'video', 'audio']) assert.ok(families.has(k), `${k} has no match rule`);
    for (const c of CASES) {
        const r = match.matchFile(db, P, { sha256: sha(c.a.bytes), size: c.a.bytes.length });
        assert.equal(r.matched, true, `${c.name} was not matched`);
        assert.equal(r.asset.asset_id, c.a.id, `${c.name}: the wrong asset`);
        assert.equal(r.kind, c.kind, `${c.name}: kind`);
        assert.equal(r.node_key, c.node === 'ver:' ? `ver:${c.a.id}` : c.node, `${c.name}: node`);
        assert.equal(r.parent_key, c.parent, `${c.name}: parent`);
        assert.ok(r.recipe && r.recipe.asset_id === c.a.id, `${c.name}: no recipe`);
    }
});

test('same size, other bytes is not a match; another project\'s identical file is not a match; a missing file is skipped', () => {
    const f = CASES[0].a;
    const twin = Buffer.from('frame-bytes-2');
    assert.equal(twin.length, f.bytes.length);
    assert.equal(match.matchFile(db, P, { sha256: sha(twin), size: twin.length }).matched, false);
    const foreign = asset(OTHER, 'storyboard', Buffer.from('only-in-other'));
    assert.equal(match.matchFile(db, P, { sha256: sha(foreign.bytes), size: foreign.bytes.length }).matched, false, 'matched across projects');
    const gone = asset(P, 'storyboard', Buffer.from('deleted-bytes'), { shot_id: SH });
    fs.unlinkSync(gone.path);
    assert.equal(match.matchFile(db, P, { sha256: sha(gone.bytes), size: gone.bytes.length }).matched, false);
});

test('only same-size files are read, and a file rewritten in place is read again', () => {
    const before = match._stats().hashed;
    const c = CASES[1].a;
    match.matchFile(db, P, { sha256: sha(c.bytes), size: c.bytes.length });
    const read = match._stats().hashed - before;
    const sameSize = CASES.filter(x => x.a.bytes.length === c.bytes.length).length;
    assert.ok(read <= sameSize, `hashed ${read} files; only ${sameSize} share the size`);
    // Second time is cached.
    const mid = match._stats().hashed;
    match.matchFile(db, P, { sha256: sha(c.bytes), size: c.bytes.length });
    assert.equal(match._stats().hashed, mid, 'an unchanged file was hashed again');
    // Rewritten in place, same size, newer mtime: the new bytes are what matches.
    const next = Buffer.from('clip-bytes-99');
    fs.writeFileSync(c.path, next);
    const t = new Date(Date.now() + 5000); fs.utimesSync(c.path, t, t);
    assert.equal(match.matchFile(db, P, { sha256: sha(c.bytes), size: c.bytes.length }).matched, false, 'a stale hash matched');
    assert.equal(match.matchFile(db, P, { sha256: sha(next), size: next.length }).asset.asset_id, c.id);
});

test('a bad hash or size is refused by name', () => {
    assert.match(match.matchFile(db, P, { sha256: 'nope', size: 3 }).error, /sha256/);
    assert.match(match.matchFile(db, P, { sha256: 'a'.repeat(64), size: -1 }).error, /size/);
});

test('route: GET …/production-graph/match?sha256=&size= — 200 match, 200 no match, 400 bad hash, 404 unknown project', async () => {
    const { handleProductionGraph } = require('../routes/production-graph');
    const call = async (project, body) => { let status = 0, out = null;
        const res = { setHeader() {}, writeHead(s) { status = s; }, end(b) { out = JSON.parse(b); } };
        await handleProductionGraph({ method: 'GET' }, res, ['film', 'projects', project, 'production-graph', 'match'], body);
        return { status, out }; };
    const f = CASES[0].a;
    let r = await call(P, { sha256: sha(f.bytes), size: f.bytes.length });
    assert.equal(r.status, 200); assert.equal(r.out.matched, true); assert.equal(r.out.node_key, `shot:${SH}`);
    r = await call(P, { sha256: 'b'.repeat(64), size: 10 });
    assert.equal(r.status, 200); assert.equal(r.out.matched, false);
    assert.equal((await call(P, { sha256: 'x', size: 10 })).status, 400);
    assert.equal((await call(generateId(), { sha256: 'b'.repeat(64), size: 10 })).status, 404);
});

// ---- the page ----------------------------------------------------------------------
const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
function fnSource(name) {
    const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(SPA);
    if (!m) return null;
    let i = SPA.indexOf('(', m.index), parens = 0;
    for (; i < SPA.length; i++) { if (SPA[i] === '(') parens++; else if (SPA[i] === ')' && --parens === 0) { i++; break; } }
    let depth = 0;
    for (let j = SPA.indexOf('{', i); j < SPA.length; j++) { if (SPA[j] === '{') depth++; else if (SPA[j] === '}' && --depth === 0) return SPA.slice(m.index, j + 1); }
    return null;
}

test('an unknown file is offered only to a node that takes it, through that node\'s own upload route', () => {
    const src = fnSource('pgDropTarget');
    assert.ok(src, 'pgDropTarget is not defined');
    const f = new Function(`${src}; return pgDropTarget;`)();
    const want = {
        'shot image': { url: '/shots/S/storyboard/import', helper: 'image' },
        'shot video': { url: '/shots/S/media/video/import', helper: 'media' },
        'sequence video': { url: '/sequences/Q/import', helper: 'media' },
        'sound audio': { url: '/music-cues/C/audio', helper: 'media' },
    };
    const nodes = { shot: { type: 'shot', id: 'S' }, sequence: { type: 'sequence', id: 'Q' }, sound: { type: 'sound', id: 'C' }, link: { type: 'link', id: 'L' } };
    const mimes = { image: 'image/png', video: 'video/mp4', audio: 'audio/mpeg' };
    for (const [nt, node] of Object.entries(nodes)) for (const [mk, mime] of Object.entries(mimes)) {
        const t = f(node, mime);
        const exp = want[`${nt} ${mk}`];
        if (exp) { assert.ok(!t.refused, `${nt} × ${mk} refused: ${t.refused}`); assert.equal(t.url, exp.url); assert.equal(t.helper, exp.helper); }
        else assert.ok(t.refused && t.refused.length > 10, `${nt} × ${mk} was offered an upload it cannot take`);
    }
    assert.ok(f(null, 'image/png').refused, 'a drop on empty canvas offered an upload to nothing');
});

test('the canvas accepts dropped files, hashes them in the browser, asks /match, and opens the recipe or offers the upload', () => {
    const drop = fnSource('pgDropFile');
    assert.ok(drop, 'pgDropFile is not defined');
    assert.match(drop, /crypto\.subtle\.digest\(\s*'SHA-256'/, 'the file is not hashed in the browser');
    assert.match(drop, /production-graph\/match\?sha256=/, 'the lookup is not a GET carrying only the hash and size');
    assert.doesNotMatch(drop, /readAsDataURL/, 'the whole file is read into a data URL just to find a match');
    assert.match(drop, /pgLoadHowMade\(/, 'a match does not open its recipe');
    assert.match(drop, /pgDropTarget\(/, 'an unknown file is not offered as an upload');
    const up = fnSource('pgDropUpload');
    assert.match(up, /uploadReferenceImage\(/); assert.match(up, /uploadCapabilityMedia\(/);
    assert.match(fnSource('pgInitCanvas'), /pgDroppedFile\(ev\.dataTransfer\)[\s\S]*?pgDropFile\(/, 'the canvas drop handler ignores files');
    const picked = new Function(`${fnSource('pgDroppedFile')}; return pgDroppedFile;`)();
    const fake = { name: 'a.png' };
    assert.equal(picked({ files: { length: 1, item: i => (i === 0 ? fake : null) } }), fake);
    assert.equal(picked({ files: { length: 0, item: () => null } }), null, 'a drag from inside the page read as a file');
    assert.ok(fs.readFileSync(path.join(__dirname, '..', '..', 'ios', 'FilmEngine', 'Web', 'index.html'), 'utf8') === SPA);
});

test.after(() => { try { fs.rmSync(process.env.FILM_DATA_DIR, { recursive: true, force: true }); } catch (_) {} });
