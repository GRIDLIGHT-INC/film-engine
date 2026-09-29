/**
 * FOG-006 (GRD-4587) — the templates shelf in the add palette.
 *
 * Double-click on the Production graph opens the add palette; next to the
 * coverage patterns it now lists EVERY ready-made flow template
 * (`listTemplates()`, never typed here). Picking one with a selection saves
 * the template as a flow and goes straight into FOG-003's apply: the free plan
 * in the one confirmation, then one run per shot. With nothing a flow can run
 * on selected, the entry says so instead of opening an empty plan.
 *
 * Set-based over the template registry twice: each template is on the shelf,
 * and each, planned against a real shot, either runs or is refused with a
 * reason naming what it cannot bind.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-fog006-' + crypto.randomUUID().slice(0, 8));
const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();
const { listTemplates, instantiate } = require('../lib/flow-templates');
const { writeGraph } = require('../routes/flows');
const apply = require('../lib/flow-apply');

const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
function fnSource(name) {
    const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(SPA);
    assert.ok(m, `no ${name} on the page`);
    let i = SPA.indexOf('(', m.index), d = 0;
    for (; i < SPA.length; i++) { if (SPA[i] === '(') d++; else if (SPA[i] === ')' && --d === 0) break; }
    i = SPA.indexOf('{', i); d = 0;
    for (let j = i; j < SPA.length; j++) { if (SPA[j] === '{') d++; else if (SPA[j] === '}' && --d === 0) return SPA.slice(m.index, j + 1); }
}
const constSource = name => {
    const m = new RegExp(`const ${name} = Object\\.freeze\\([\\s\\S]*?\\);`).exec(SPA);
    assert.ok(m, `no ${name} on the page`); return m[0];
};
const entriesFn = () => new Function(`${constSource('PG_ADD_CUE_TYPES')} ${constSource('PG_APPLY_TYPES')}
    ${fnSource('pgApplyTargets')} ${fnSource('pgNextInsertCode')} ${fnSource('pgNearestShot')} ${fnSource('pgAddEntries')}; return pgAddEntries;`)();

const TEMPLATES = listTemplates();
const shot = (id, code, x, y) => ({ key: 'shot:' + id, type: 'shot', id, shot_code: code, scene_id: 's1', x, y, w: 220, h: 170 });
const GRAPH = {
    nodes: [shot('a', '1A', 0, 0), shot('b', '1B', 0, 200),
        { key: 'seq:q', type: 'sequence', id: 'q', shot_ids: ['a', 'b'], x: 300, y: 0 },
        { key: 'ver:v', type: 'video', x: 600, y: 0 }],
    running_order: ['a', 'b'],
};

test('every template is on the shelf, next to the patterns, applying to the picks and the selection', () => {
    assert.ok(TEMPLATES.length >= 6, `read only ${TEMPLATES.length} templates`);
    const f = entriesFn();
    const es = f(GRAPH, { x: 10, y: 10 }, ['shot:b', 'seq:q', 'ver:v'], 'shot:a', [{ id: 'pat', label: 'Shot / reverse' }], TEMPLATES);
    const shelf = es.filter(e => e.kind === 'template');
    assert.deepEqual(shelf.map(e => e.template).sort(), TEMPLATES.map(t => t.id).sort(), 'a template is missing from the shelf');
    for (const t of TEMPLATES) {
        const e = shelf.find(x => x.template === t.id);
        assert.ok(e.label.includes(t.name), `${t.id}: the label does not name it`);
        assert.deepEqual([...e.targets], ['shot:b', 'seq:q', 'shot:a'], `${t.id}: not applied to the picks and the selection, applyable ones only`);
        assert.ok(!e.refused);
    }
    // Next to the patterns: the shelf follows the pattern entries.
    const lastPattern = es.map(e => e.kind).lastIndexOf('pattern');
    assert.ok(lastPattern >= 0 && es.findIndex(e => e.kind === 'template') === lastPattern + 1, 'the templates do not sit next to the patterns');
});

test('with nothing a flow can run on, every template entry says why instead of opening an empty plan', () => {
    const es = entriesFn()(GRAPH, { x: 10, y: 10 }, ['ver:v'], null, [], TEMPLATES);
    const shelf = es.filter(e => e.kind === 'template');
    assert.equal(shelf.length, TEMPLATES.length, 'the shelf disappears when nothing is selected — nobody learns it exists');
    for (const e of shelf) {
        assert.equal([...e.targets].length, 0);
        assert.match(e.refused || '', /shot|sequence/i, `${e.template}: refused without a reason`);
    }
    assert.equal(entriesFn()(GRAPH, { x: 0, y: 0 }, [], null, []).filter(e => e.kind === 'template').length, 0,
        'templates not yet read must not break the palette');
});

test('every template, applied to a real shot, runs or is refused with a reason naming what it cannot bind', () => {
    const P = generateId(), SC = generateId(), SH = generateId();
    db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Shelf')").run(P);
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, 1, 'SQUARE')").run(SC, P);
    db.prepare("INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, '1A', ?)")
        .run(SH, SC, JSON.stringify({ action: 'She crosses the square', characters: ['MAYA'] }));
    for (const t of TEMPLATES) {
        const id = generateId();
        db.prepare("INSERT INTO film_flows (id, project_id, name, is_builtin, version) VALUES (?, ?, ?, 0, 1)").run(id, P, t.name);
        writeGraph(id, instantiate(t.id, { projectId: P }));
        const plan = apply.planApply(db, { flowId: id, projectId: P, targets: [`shot:${SH}`] });
        assert.ok(!plan.error, `${t.id}: ${plan.error}`);
        const s = plan.shots[0];
        assert.ok(s, `${t.id}: the shot was not planned`);
        if (s.status === 'ok') assert.equal(plan.runs, 1, `${t.id}: ok but no run`);
        else assert.ok(s.reasons.length && s.reasons.every(r => r.length > 10), `${t.id}: refused without saying why`);
    }
});

test('picking a template saves it as a flow and goes into the FOG-003 apply; a refused entry spends and writes nothing', async () => {
    const calls = [];
    const statuses = [];
    const make = () => new Function('api', 'state', 'PG', 'loadProductionGraph', 'setStatus', 'pgApplyFlow', 'pgCreateSequence',
        `${fnSource('pgAddPick')}; return pgAddPick;`);
    const pick = make()(
        async (url, o) => { calls.push({ url, body: o && o.body }); return { id: 'flow-1' }; },
        { currentProject: { id: 'P1' } }, { picked: new Set(['shot:b']) }, async () => {}, m => statuses.push(m),
        async (flowId, targets) => calls.push({ apply: flowId, targets: [...targets] }), async () => ({}),
    );
    const t = TEMPLATES[0];
    await pick({ kind: 'template', template: t.id, targets: ['shot:b', 'seq:q'], label: t.name }, { x: 0, y: 0 });
    assert.equal(calls[0].url, '/projects/P1/flows/from-template');
    assert.equal(JSON.parse(calls[0].body).template_id, t.id);
    assert.deepEqual(calls[1], { apply: 'flow-1', targets: ['shot:b', 'seq:q'] }, 'the new flow did not go into the apply');
    assert.ok(!calls.some(c => /layout/.test(c.url || '')), 'a template is not a node to place on the canvas');

    calls.length = 0;
    await pick({ kind: 'template', template: t.id, targets: [], refused: 'Pick a shot or a sequence first.', label: t.name }, { x: 0, y: 0 });
    assert.equal(calls.length, 0, 'a refused template still created a flow');
    assert.match(statuses.pop(), /shot or a sequence/);
});

test('the palette reads the shelf when it opens, and the iOS copy carries it', () => {
    const open = fnSource('pgOpenAddPalette');
    assert.match(open, /\/flow-templates/, 'the palette never reads the templates');
    assert.match(open, /pgAddEntries\([^)]*PG\.templates\)/, 'the templates never reach the entries');
    assert.ok(fs.readFileSync(path.join(__dirname, '..', '..', 'ios', 'FilmEngine', 'Web', 'index.html'), 'utf8') === SPA, 'the iOS bundle was not re-synced');
});
