/**
 * PGN-019 — double-click to add.
 *
 * A palette at the pointer: type to add a shot (inserted after the nearest shot
 * with the next insert code — 2AA after 2A, 2AB after that), a sound cue of any
 * type the cue table allows, or a sequence from the picked shots. Keyboard
 * only: arrows move, Enter picks, Escape cancels.
 *
 * The code the palette PREVIEWS is the code the route WRITES: one rule in
 * lib/shot-insert-code.js, mirrored on the page and held equal over a case set.
 * The cue types are the route's own list. Set-based over both.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-add-' + crypto.randomUUID().slice(0, 8));
require('../db/schema').ensureSchema();
const { db, generateId } = require('../db/database');
const codes = require('../lib/shot-insert-code');

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
    if (!m) return null;
    let depth = 0;
    for (let j = m.index; j < SPA.length; j++) { const ch = SPA[j]; if ('([{'.includes(ch)) depth++; else if (')]}'.includes(ch)) depth--; else if (ch === ';' && depth === 0) return SPA.slice(m.index, j + 1); }
    return null;
}
const need = (...names) => { for (const n of names) assert.ok(fnSource(n) || constSource(n), `${n} is not defined on the page`); };

// ---- the code rule, once ------------------------------------------------------------
const CASES = [
    ['2A', [], '2AA'],
    ['2A', ['2AA'], '2AB'],
    ['2A', ['2aa', '2AB'], '2AC'],
    ['1B', ['1BA', '1BC'], '1BB'],
    ['3', [], '3A'],
    ['2A', Array.from({ length: 26 }, (_, i) => '2A' + String.fromCharCode(65 + i)), null],
];

test('the insert code: 2A → 2AA, walking the suffix past what is used, and null when all 26 are taken', () => {
    for (const [anchor, used, want] of CASES) assert.equal(codes.nextInsertCode(anchor, used), want, `${anchor} with ${used.length} used`);
});

test('the page previews with the same rule, over every case', () => {
    need('pgNextInsertCode');
    const page = new Function(`${fnSource('pgNextInsertCode')}; return pgNextInsertCode;`)();
    for (const [anchor, used] of CASES) assert.equal(page(anchor, used), codes.nextInsertCode(anchor, used), `${anchor}: the page and the route disagree`);
});

test('the route writes the code the rule gives, and refuses the 27th insert', async () => {
    const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'shots.js'), 'utf8');
    assert.match(route, /shot-insert-code'\)\.(insertShotsAfter|nextInsertCode)\(/, 'the route does not use the shared rule');
    assert.doesNotMatch(route, /String\.fromCharCode/, 'the route keeps its own copy of the suffix walk');
    const P = generateId(), SC = generateId(), A = generateId();
    db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Add')").run(P);
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, 2)").run(SC, P);
    db.prepare("INSERT INTO film_shots (id, scene_id, shot_code, sort_order, scene_card_yaml) VALUES (?, ?, '2A', 0, '{}')").run(A, SC);
    const { handleShots } = require('../routes/shots');
    const insert = async () => { let status = 0, out = null;
        const res = { setHeader() {}, writeHead(s) { status = s; }, end(b) { out = JSON.parse(b); } };
        await handleShots({ method: 'POST', body: { card: { description: 'A reaction.' } } }, res, ['film', 'shots', A, 'insert-after'], {});
        return { status, out }; };
    const first = await insert();
    assert.equal(first.status, 201, JSON.stringify(first.out));
    assert.equal(db.prepare("SELECT shot_code FROM film_shots WHERE scene_id = ? AND shot_code != '2A' ORDER BY created_at").get(SC).shot_code, '2AA');
    for (let i = 1; i < 26; i++) await insert();
    assert.equal((await insert()).status, 409);
});

// ---- the palette -------------------------------------------------------------------
const VALID_CUE_TYPES = ['score', 'source', 'sfx', 'ambient', 'transition'];

test('every cue type the route accepts can be added from the palette', () => {
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'routes', 'assets.js'), 'utf8'),
        new RegExp(`VALID_CUE_TYPES = \\[${VALID_CUE_TYPES.map(t => `'${t}'`).join(', ')}\\]`), 'the route list moved; update this test from it');
    need('PG_ADD_CUE_TYPES');
    const types = new Function(`${constSource('PG_ADD_CUE_TYPES')} return PG_ADD_CUE_TYPES;`)();
    assert.deepEqual(Object.keys(types).sort(), [...VALID_CUE_TYPES].sort());
    for (const t of VALID_CUE_TYPES) assert.ok(types[t] && types[t].length > 2, `${t} has no label`);
});

function entriesFn() {
    need('pgAddEntries', 'pgNearestShot', 'pgNextInsertCode', 'PG_ADD_CUE_TYPES');
    return new Function(`${constSource('PG_ADD_CUE_TYPES')} ${fnSource('pgNextInsertCode')} ${fnSource('pgNearestShot')} ${fnSource('pgAddEntries')}; return pgAddEntries;`)();
}
const shot = (id, code, x, y, scene = 's2') => ({ key: 'shot:' + id, type: 'shot', id, shot_code: code, scene_id: scene, x, y, w: 220, h: 170 });
const GRAPH = { nodes: [shot('a', '2A', 0, 0), shot('aa', '2AA', 0, 200), shot('b', '2B', 0, 400), shot('c', '3A', 800, 0, 's3')],
    running_order: ['a', 'aa', 'b', 'c'] };

test('the entries: a shot after the NEAREST shot with its preview code, every cue type, and a sequence from the picked shots in film order', () => {
    const f = entriesFn();
    let es = f(GRAPH, { x: 20, y: 30 }, [], null);
    const sh = es.filter(e => e.kind === 'shot');
    assert.equal(sh.length, 1);
    assert.equal(sh[0].after, 'a'); assert.equal(sh[0].code, '2AB', 'the preview ignores the codes already used');
    assert.match(sh[0].label, /2A/); assert.match(sh[0].label, /2AB/);
    es = f(GRAPH, { x: 810, y: 20 }, [], null);
    assert.equal(es.find(e => e.kind === 'shot').after, 'c', 'not the nearest shot');
    assert.equal(es.find(e => e.kind === 'sound' && e.cue_type === 'score').scene_id, 's3', 'a cue lands in the nearest shot\'s scene');
    assert.deepEqual(es.filter(e => e.kind === 'sound').map(e => e.cue_type).sort(), [...VALID_CUE_TYPES].sort());
    assert.ok(!es.some(e => e.kind === 'sequence'), 'a sequence from nothing is offered');
    es = f(GRAPH, { x: 20, y: 30 }, ['shot:b', 'shot:a'], null);
    const seq = es.find(e => e.kind === 'sequence');
    assert.deepEqual(seq.shot_ids, ['a', 'b'], 'the sequence is not in film order');
    assert.match(seq.label, /2A.*2B/);
    es = f(GRAPH, { x: 20, y: 30 }, [], 'shot:aa');
    assert.deepEqual(es.find(e => e.kind === 'sequence').shot_ids, ['aa'], 'the selected shot is not offered as a sequence');
    es = f({ nodes: [], running_order: [] }, { x: 0, y: 0 }, [], null);
    assert.ok(!es.some(e => e.kind === 'shot'), 'a shot is offered with nothing to insert after');
});

test('typing filters by any word of the label; nothing typed shows everything', () => {
    need('pgFilterEntries');
    const filter = new Function(`${fnSource('pgFilterEntries')}; return pgFilterEntries;`)();
    const es = entriesFn()(GRAPH, { x: 20, y: 30 }, ['shot:a'], null);
    assert.equal(filter(es, '').length, es.length);
    assert.ok(filter(es, 'amb').every(e => /amb/i.test(e.label)) && filter(es, 'amb').length === 1);
    assert.ok(filter(es, 'shot').some(e => e.kind === 'shot'));
    assert.equal(filter(es, 'zzzz').length, 0);
});

test('picking goes through the existing routes: insert-after with the description, a cue of that type, a sequence of those shots — then placed at the pointer', async () => {
    need('pgAddPick');
    const calls = [];
    const pick = new Function('api', 'state', 'PG', 'loadProductionGraph', 'setStatus',
        `${fnSource('pgCreateSequence')} ${fnSource('pgAddPick')}; return pgAddPick;`)(
        async (url, o) => { calls.push({ url, method: o && o.method, body: o && o.body ? JSON.parse(o.body) : null });
            if (/insert-after/.test(url)) return { shot_id: 'new-shot' };
            if (/music-cues/.test(url)) return { id: 'new-cue' };
            if (/sequences/.test(url)) return { sequence: { id: 'new-seq' } };
            return {}; },
        { currentProject: { id: 'p' } }, { picked: new Set(['shot:a']) }, async () => {}, () => {});
    const at = { x: 12, y: 34 };
    const expect = [
        [{ kind: 'shot', after: 'a', code: '2AB' }, 'A reaction', '/shots/a/insert-after', b => b.card.description === 'A reaction', 'shot:new-shot'],
        [{ kind: 'sound', cue_type: 'transition', scene_id: 's2', label: 'Transition' }, null, '/projects/p/music-cues', b => b.cue_type === 'transition' && b.scene_id === 's2', 'sound:new-cue'],
        [{ kind: 'sequence', shot_ids: ['a', 'b'], name: '2A–2B' }, null, '/projects/p/sequences', b => b.shot_ids.join() === 'a,b', 'seq:new-seq'],
    ];
    for (const [entry, text, url, bodyOk, key] of expect) {
        calls.length = 0;
        await pick(entry, at, text);
        assert.equal(calls[0].url, url, `${entry.kind}: wrong route`);
        assert.equal(calls[0].method, 'POST');
        assert.ok(bodyOk(calls[0].body), `${entry.kind}: wrong body ${JSON.stringify(calls[0].body)}`);
        const place = calls.find(c => /production-graph\/layout/.test(c.url));
        assert.ok(place, `${entry.kind}: not placed at the pointer`);
        assert.deepEqual(place.body.nodes[0], { key, x: 12, y: 34 });
    }
    calls.length = 0;
    await pick({ kind: 'shot', after: 'a', code: '2AB' }, at, '   ');
    assert.equal(calls.length, 0, 'a shot with no description was created');
});

test('keyboard only: arrows move, Enter picks, Escape cancels; a double-click on empty canvas opens it; Shift+click picks shots', () => {
    need('pgAddKey', 'pgOpenAddPalette', 'pgCloseAddPalette');
    const key = fnSource('pgAddKey');
    for (const k of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape']) assert.ok(key.includes(`'${k}'`), `${k} is not handled`);
    assert.match(key, /pgCloseAddPalette\(/);
    const init = fnSource('pgInitCanvas');
    assert.match(init, /addEventListener\('dblclick'[\s\S]*?pgOpenAddPalette\(/, 'double-click does not open the palette');
    assert.match(init, /shiftKey[\s\S]*?pgTogglePick\(/, 'Shift+click does not pick a shot');
    // Escape closes without adding anything, run for real.
    let closed = 0;
    const run = new Function('PG', 'pgCloseAddPalette', 'pgAddPick', 'pgRenderAddPalette',
        `${fnSource('pgAddKey')}; return pgAddKey;`)({ add: { entries: [{ kind: 'sound' }, { kind: 'sound' }], index: 0 } },
        () => { closed++; }, () => { throw new Error('picked on Escape'); }, () => {});
    const ev = k => ({ key: k, preventDefault() {}, stopPropagation() {} });
    run(ev('Escape'));
    assert.equal(closed, 1);
    assert.ok(fs.readFileSync(path.join(__dirname, '..', '..', 'ios', 'FilmEngine', 'Web', 'index.html'), 'utf8') === SPA);
});

test.after(() => { try { fs.rmSync(process.env.FILM_DATA_DIR, { recursive: true, force: true }); } catch (_) {} });
