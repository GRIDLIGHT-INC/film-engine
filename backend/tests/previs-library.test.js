/**
 * The Previs library: free low-poly furniture and people, at real size.
 *
 *   - every model in the library parses, and the furniture's licence (CC0) is
 *     in the repo beside it;
 *   - sizes are real: a person is their stated height, a door is a door, a
 *     table is table height, measured from the files rather than trusted;
 *   - a person FACES north (+Y, Film Engine's yaw 0): their nose is the
 *     furthest-forward thing at head height, because facing is the one thing
 *     blocking needs from a figure beyond its size;
 *   - a child is proportioned as a child (a bigger head for their height);
 *   - the library is served with its categories and files, and a set build
 *     refuses an asset the library does not have.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const lib = require('../lib/previs-library');
const { parseGlb } = require('../lib/glb-parser');
const { handlePrevisLibrary } = require('../routes/previs-library');

function call(urlPath) {
    return new Promise(resolve => {
        const [p, qs] = urlPath.split('?');
        const chunks = [];
        const res = {
            statusCode: 200, headers: {},
            writeHead(s, h) { this.statusCode = s; Object.assign(this.headers, h || {}); },
            end(c) {
                if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
                const raw = Buffer.concat(chunks);
                let data; try { data = JSON.parse(raw.toString('utf8')); } catch { data = raw; }
                resolve({ status: this.statusCode, headers: this.headers, data });
            },
        };
        handlePrevisLibrary({ method: 'GET' }, res, p.split('/').filter(Boolean), Object.fromEntries(new URLSearchParams(qs || '')));
    });
}

test('every library model parses, and the furniture carries its CC0 licence', () => {
    const all = lib.list();
    assert.ok(all.length >= 144, `expected the whole kit and four people, got ${all.length}`);
    assert.equal(new Set(all.map(e => e.id)).size, all.length, 'ids are unique');
    for (const e of all) {
        assert.ok(lib.CATEGORIES.includes(e.category), `${e.id} is in no known category`);
        const g = parseGlb(fs.readFileSync(lib.get(e.id).file));
        assert.ok(g.triangles.length > 0, `${e.id} has no triangles`);
        assert.ok(e.size_m.every(v => v > 0), `${e.id} has no size`);
    }
    const licence = fs.readFileSync(path.join(lib.ROOT, 'furniture', 'LICENSE-kenney-furniture-kit.txt'), 'utf8');
    assert.match(licence, /Creative Commons Zero, CC0/);
    assert.ok(all.filter(e => e.category !== 'people').every(e => /CC0/.test(e.licence)));
});

test('sizes are real, read from the files', () => {
    const h = id => lib.get(id).size_m[2];
    for (const [id, height] of Object.entries({ man: 1.78, woman: 1.65, boy: 1.28, girl: 1.26 })) {
        assert.ok(Math.abs(h(id) - height) < 0.05, `${id} is ${h(id)} m, not ${height} m`);
    }
    assert.ok(h('doorway') > 1.9 && h('doorway') < 2.2, 'a door is about two metres');
    assert.ok(h('table') > 0.6 && h('table') < 0.85, 'a table is table height');
    assert.ok(h('kitchenFridge') > 1.6 && h('kitchenFridge') < 2.0, 'a fridge is about 1.8 m');
    assert.ok(h('chair') > 0.8 && h('chair') < 1.05, 'a chair back is under a metre');
    assert.equal(lib.KENNEY_TO_METRES, 2.0);
});

test('a person faces north, and a child has a child\'s proportions', () => {
    const headRatio = {};
    for (const id of Object.keys(lib.PEOPLE)) {
        const g = parseGlb(fs.readFileSync(lib.get(id).file));
        // glTF is Y-up with -Z forward; forward (north) is the most negative z.
        const top = g.bounds.max[1];
        const headBand = g.vertices.filter(v => v[1] > top * 0.86);
        const frontmost = Math.min(...headBand.map(v => v[2]));
        const backmost = Math.max(...headBand.map(v => v[2]));
        assert.ok(-frontmost > backmost * 0.9, `${id}: the face should be the furthest-forward part of the head`);
        const headW = Math.max(...headBand.map(v => v[0])) - Math.min(...headBand.map(v => v[0]));
        headRatio[id] = headW / top;
    }
    assert.ok(headRatio.boy > headRatio.man * 1.15, 'a boy\'s head is larger for his height than a man\'s');
    assert.ok(headRatio.girl > headRatio.woman * 1.15, 'a girl\'s head is larger for her height than a woman\'s');
});

test('the library is served, and a set build refuses what it does not have', async () => {
    const r = await call('/film/previs-library?category=people');
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.entries.map(e => e.id).sort(), ['boy', 'girl', 'man', 'woman']);
    assert.ok(r.data.entries.every(e => e.url === `/film/previs-library/${e.id}/file` && !e.file), 'no server path leaks');
    const f = await call('/film/previs-library/stoolBar/file');
    assert.equal(f.status, 200);
    assert.equal(f.headers['Content-Type'], 'model/gltf-binary');
    assert.equal(f.data.toString('ascii', 0, 4), 'glTF');
    assert.equal((await call('/film/previs-library/unicorn')).status, 404);
    assert.equal((await call('/film/previs-library?category=spaceships')).status, 400);
    const errs = require('../lib/set-build').validateLayout({ room: { x0: 0, x1: 4, y0: 0, y1: 4, height: 3 },
        objects: [{ name: 'x', shape: 'asset', asset: 'unicorn', at: [1, 1, 0] }],
        cameras: [{ plate: 'default', position: [0, 0, 1.5] }] }, ['default']);
    assert.ok(errs.some(e => /not in the Previs library/.test(e)));
});

test('the people are made by a script in the repo, not downloaded', () => {
    const script = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'make-previs-people.py'), 'utf8');
    for (const id of Object.keys(lib.PEOPLE)) assert.ok(script.includes(`'${id}':`), `the generator does not make ${id}`);
    assert.match(script, /SKIN/, 'a body grown over a skeleton, not stacked boxes');
});
