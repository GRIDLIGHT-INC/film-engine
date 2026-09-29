/**
 * PGN-020 — coverage patterns.
 *
 * lib/graph-patterns.js holds patterns a director reaches for — shot / reverse
 * shot, insert then reaction, wide / medium / close. Each has a FREE preview of
 * the shots, the sequence and the joins it would create, and then creates them
 * with NO generation: shots inserted after the anchor the way a script
 * supervisor numbers inserts (2AA, 2AB, 2AC), in order, and one sequence of
 * them with its joins.
 *
 * Set-based over PATTERNS: every pattern's vocabulary is held to the scene-card
 * schema and the sequence join types, and every pattern's preview and creation
 * are checked for real.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-pat-' + crypto.randomUUID().slice(0, 8));
require('../db/schema').ensureSchema();
const { db, generateId } = require('../db/database');
const patterns = require('../lib/graph-patterns');
const { VALID_SHOT_TYPES, validateSceneCards } = require('../lib/scene-card-schema');
const { JOIN_TYPES } = require('../lib/video-sequence');
const { handleProductionGraph } = require('../routes/production-graph');

function project() {
    const P = generateId(), SC = generateId(), A = generateId(), B = generateId();
    db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Patterns')").run(P);
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, 2)").run(SC, P);
    const card = JSON.stringify({ description: 'MAYA and RAY argue across the counter.', characters: ['MAYA', 'RAY'], props: ['COUNTER'] });
    db.prepare("INSERT INTO film_shots (id, scene_id, shot_code, sort_order, scene_card_yaml) VALUES (?, ?, '2A', 0, ?)").run(A, SC, card);
    db.prepare("INSERT INTO film_shots (id, scene_id, shot_code, sort_order, scene_card_yaml) VALUES (?, ?, '2B', 1, '{}')").run(B, SC);
    return { P, SC, A, B };
}
const count = (t, where = '1=1', ...a) => db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${where}`).get(...a).n;

test('the three named patterns exist, and every pattern speaks the schema\'s own vocabulary', () => {
    const ids = patterns.PATTERNS.map(p => p.id);
    for (const need of ['shot_reverse', 'insert_reaction', 'wide_medium_close']) assert.ok(ids.includes(need), `${need} is missing`);
    for (const p of patterns.PATTERNS) {
        assert.ok(p.label && p.why && p.why.length > 20, `${p.id}: no label or reason`);
        assert.ok(p.shots.length >= 2, `${p.id}: a pattern of one shot is not a pattern`);
        assert.equal(p.joins.length, p.shots.length - 1, `${p.id}: one join per adjacent pair`);
        for (const s of p.shots) assert.ok(VALID_SHOT_TYPES.includes(s.shot_type), `${p.id}: ${s.shot_type} is not a shot type`);
        for (const j of p.joins) assert.ok(JOIN_TYPES.includes(j), `${p.id}: ${j} is not a join type`);
    }
});

for (const p of patterns.PATTERNS) {
    test(`${p.id}: the preview is free and writes nothing; creating makes exactly what it previewed, in order, with no generation`, () => {
        const { P, SC, A, B } = project();
        const before = { shots: count('film_shots'), seqs: count('film_sequences'), assets: count('film_assets'), jobs: count('film_generation_jobs') };
        const plan = patterns.planPattern(db, P, p.id, A);
        assert.ok(!plan.error, plan.error);
        assert.equal(plan.cost, 0); assert.equal(plan.generates, false);
        assert.deepEqual(plan.shots.map(s => s.code), p.shots.map((_, i) => '2A' + String.fromCharCode(65 + i)), 'the codes are not the insert codes');
        assert.deepEqual(plan.shots.map(s => s.shot_type), p.shots.map(s => s.shot_type));
        for (const s of plan.shots) {
            assert.ok(s.description && s.description.includes('2A'), 'a planned shot does not say where it comes from');
            assert.deepEqual(s.characters, ['MAYA', 'RAY'], 'the cast is not carried from the anchor');
        }
        assert.deepEqual(plan.joins.map(j => j.type), p.joins);
        assert.ok(plan.sequence && plan.sequence.name);
        assert.ok(validateSceneCards(plan.shots.map(s => s.card)).valid, 'a planned card would be refused');
        assert.deepEqual({ shots: count('film_shots'), seqs: count('film_sequences'), assets: count('film_assets'), jobs: count('film_generation_jobs') }, before, 'the preview wrote something');

        const out = patterns.createPattern(db, P, p.id, A);
        assert.ok(!out.error, out.error);
        assert.deepEqual(out.codes, plan.shots.map(s => s.code), 'created codes differ from the preview');
        const order = db.prepare('SELECT id, shot_code FROM film_shots WHERE scene_id = ? ORDER BY sort_order').all(SC).map(r => r.shot_code);
        assert.deepEqual(order, ['2A', ...out.codes, '2B'], 'the new shots are not right after the anchor, in order');
        const seq = db.prepare('SELECT * FROM film_sequences WHERE id = ?').get(out.sequence_id);
        assert.deepEqual(JSON.parse(seq.shot_ids), out.shot_ids, 'the sequence does not hold the new shots in order');
        assert.deepEqual(JSON.parse(seq.joins_json).map(j => j.type), p.joins);
        assert.equal(count('film_assets'), before.assets, 'something was generated');
        assert.equal(count('film_generation_jobs'), before.jobs, 'a generation job was opened');
        assert.equal(B && count('film_shots', 'id = ?', B), 1);
    });
}

test('a second pattern after the same shot walks the codes on, and never renames what exists', () => {
    const { P, A } = project();
    patterns.createPattern(db, P, 'insert_reaction', A);
    const plan = patterns.planPattern(db, P, 'shot_reverse', A);
    assert.deepEqual(plan.shots.map(s => s.code), ['2AC', '2AD']);
});

test('an unknown pattern, an unknown shot, or a shot of another project is refused, writing nothing', () => {
    const { P, A } = project();
    const other = project();
    const n = count('film_shots');
    assert.equal(patterns.planPattern(db, P, 'nope', A).status, 404);
    assert.equal(patterns.planPattern(db, P, 'shot_reverse', generateId()).status, 404);
    assert.equal(patterns.createPattern(db, P, 'shot_reverse', other.A).status, 404);
    assert.equal(count('film_shots'), n);
});

test('the insert route and the patterns write shots through ONE function', () => {
    const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'shots.js'), 'utf8');
    const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'graph-patterns.js'), 'utf8');
    assert.match(route, /insertShotsAfter\(/, 'the route keeps its own insert');
    assert.match(lib, /insertShotsAfter\(/, 'the patterns keep their own insert');
    assert.doesNotMatch(lib, /INSERT INTO film_shots/, 'a second copy of the insert');
});

async function call(method, P, parts, body, query) {
    let status = 0, out = null;
    const res = { setHeader() {}, writeHead(s) { status = s; }, end(b) { out = b ? JSON.parse(b) : null; } };
    await handleProductionGraph({ method, body }, res, ['film', 'projects', P, 'production-graph', ...parts], query || {});
    return { status, out };
}

test('routes: list, free preview, create — and the errors', async () => {
    const { P, A } = project();
    let r = await call('GET', P, ['patterns']);
    assert.equal(r.status, 200);
    assert.deepEqual(r.out.patterns.map(p => p.id).sort(), patterns.PATTERNS.map(p => p.id).sort());
    r = await call('GET', P, ['patterns', 'wide_medium_close', 'preview'], null, { after: A });
    assert.equal(r.status, 200); assert.equal(r.out.shots.length, 3);
    assert.equal((await call('GET', P, ['patterns', 'wide_medium_close', 'preview'], null, {})).status, 400, 'no anchor accepted');
    r = await call('POST', P, ['patterns', 'wide_medium_close'], { after_shot_id: A });
    assert.equal(r.status, 201, JSON.stringify(r.out));
    assert.equal(r.out.shot_ids.length, 3);
    assert.equal((await call('POST', P, ['patterns', 'nope'], { after_shot_id: A })).status, 404);
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
function constSource(name) {
    const m = new RegExp(`\\bconst\\s+${name}\\s*=`).exec(SPA);
    let depth = 0;
    for (let j = m.index; j < SPA.length; j++) { const ch = SPA[j]; if ('([{'.includes(ch)) depth++; else if (')]}'.includes(ch)) depth--; else if (ch === ';' && depth === 0) return SPA.slice(m.index, j + 1); }
}

test('the add palette offers every pattern after the nearest shot; Enter previews for free, a second Enter creates', async () => {
    const entries = new Function(`${constSource('PG_ADD_CUE_TYPES')} ${fnSource('pgNextInsertCode')} ${fnSource('pgNearestShot')} ${fnSource('pgAddEntries')}; return pgAddEntries;`)();
    const graph = { nodes: [{ key: 'shot:a', type: 'shot', id: 'a', shot_code: '2A', scene_id: 's', x: 0, y: 0 }], running_order: ['a'] };
    const list = patterns.PATTERNS.map(p => ({ id: p.id, label: p.label }));
    const es = entries(graph, { x: 0, y: 0 }, [], null, list).filter(e => e.kind === 'pattern');
    assert.deepEqual(es.map(e => e.pattern).sort(), list.map(p => p.id).sort());
    assert.ok(es.every(e => e.after === 'a' && /2A/.test(e.label)));
    assert.ok(!entries(graph, { x: 0, y: 0 }, [], null, []).some(e => e.kind === 'pattern'));
    const key = fnSource('pgAddKey');
    assert.match(key, /pattern/); assert.match(key, /pgPatternPreview\(/);
    assert.match(fnSource('pgPatternPreview'), /patterns\/.*preview\?after=/);
    const calls = [];
    const pick = new Function('api', 'state', 'PG', 'loadProductionGraph', 'setStatus',
        `${fnSource('pgCreateSequence')} ${fnSource('pgAddPick')}; return pgAddPick;`)(
        async (url, o) => { calls.push({ url, method: o && o.method, body: o && o.body ? JSON.parse(o.body) : null });
            return /patterns/.test(url) ? { sequence_id: 'q', shot_ids: ['n1', 'n2'] } : {}; },
        { currentProject: { id: 'p' } }, { picked: new Set() }, async () => {}, () => {});
    await pick({ kind: 'pattern', pattern: 'shot_reverse', after: 'a' }, { x: 5, y: 6 });
    assert.deepEqual(calls[0], { url: '/projects/p/production-graph/patterns/shot_reverse', method: 'POST', body: { after_shot_id: 'a' } });
    assert.deepEqual(calls.find(c => /layout/.test(c.url)).body.nodes[0], { key: 'seq:q', x: 5, y: 6 });
    assert.ok(fs.readFileSync(path.join(__dirname, '..', '..', 'ios', 'FilmEngine', 'Web', 'index.html'), 'utf8') === SPA);
});

test.after(() => { try { fs.rmSync(process.env.FILM_DATA_DIR, { recursive: true, force: true }); } catch (_) {} });
