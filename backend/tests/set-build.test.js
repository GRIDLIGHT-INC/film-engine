/**
 * A location's set, built in Blender from its own plates.
 *
 * "The Blender build, done automatically: we might remove the Marble process
 * since Blender is free to do."
 *
 *   - the layout vocabulary the brief TELLS the agent is the vocabulary the
 *     validator ACCEPTS and the Blender script BUILDS: every shape, wall and
 *     opening kind, in all three;
 *   - a layout is refused by field, before Blender runs, and writes nothing;
 *     a camera may only stand for a plate the location has;
 *   - the brief carries the plates (as images for an agent), the location's
 *     own words and Blender's presence, and costs nothing;
 *   - where Blender is installed: an attempt is built headless and rendered
 *     from every plate camera into a comparison sheet, kept as a row; finishing
 *     it makes a world (created for the location) with a calibrated version,
 *     and a 3D model asset; finishing twice is refused;
 *   - an agent reaches all of it through tools that dispatch through the route;
 *   - the server routes it before the /film/locations/:id catch-all;
 *   - Previs offers it, and the page says what to ask rather than guessing a room.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-setbuild-' + crypto.randomUUID().slice(0, 8));
const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();
const setBuild = require('../lib/set-build');
const { handleSetBuilds, LOCATION_TAILS } = require('../routes/set-builds');
const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'backend', 'blender-set.py'), 'utf8');
const SPA = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'backend', 'server.js'), 'utf8');

function call(method, urlPath, body) {
    return new Promise(resolve => {
        const [p, qs] = urlPath.split('?');
        const parts = p.split('/').filter(Boolean);
        const chunks = [];
        const res = {
            statusCode: 200, headers: {},
            writeHead(s, h) { this.statusCode = s; Object.assign(this.headers, h || {}); },
            setHeader() {}, write(c) { chunks.push(c); },
            end(c) {
                if (c) chunks.push(c);
                const raw = Buffer.concat(chunks.map(x => Buffer.isBuffer(x) ? x : Buffer.from(String(x))));
                let data; try { data = JSON.parse(raw.toString('utf8')); } catch { data = raw; }
                resolve({ status: this.statusCode, headers: this.headers, data });
            },
        };
        Promise.resolve(handleSetBuilds({ method, body: body || {} }, res, parts, Object.fromEntries(new URLSearchParams(qs || ''))))
            .catch(err => resolve({ status: 500, data: { error: err.message } }));
    });
}

/** A real PNG at a real size, so the plate is read by its header like any other. */
function png(file, w, h, color) {
    const { resolveFfmpeg } = require('../lib/ffmpeg');
    const ff = resolveFfmpeg();
    const r = spawnSync(ff.bin, ['-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${w}x${h}`,
        '-frames:v', '1', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(r.status, 0, String(r.stderr));
}

function fixture() {
    const projectId = generateId();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-setbuild-'));
    db.prepare('INSERT INTO film_projects (id, title, assets_dir) VALUES (?, ?, ?)').run(projectId, 'Set build', dir);
    const locationId = generateId();
    db.prepare('INSERT INTO film_locations (id, project_id, name, description) VALUES (?, ?, ?, ?)')
        .run(locationId, projectId, 'THE DINER', 'A long room. Counter down the west side.');
    const plates = {};
    for (const [view, color] of [['', 'gray'], ['south', 'brown']]) {
        const file = path.join(dir, `plate_${view || 'default'}.png`);
        png(file, 320, 180, color);
        const id = generateId();
        db.prepare(`INSERT INTO film_assets (id, project_id, location_id, asset_type, file_path, file_name, format, metadata)
                    VALUES (?, ?, ?, 'reference_image', ?, ?, 'png', ?)`)
            .run(id, projectId, locationId, file, path.basename(file), JSON.stringify(view ? { view } : {}));
        plates[view || 'default'] = id;
    }
    return { projectId, locationId, dir, plates };
}

function layout(over = {}) {
    return Object.assign({
        room: { x0: -2, x1: 2, y0: 0, y1: 6, height: 3, wall_color: '#c9b590',
            floor: { pattern: 'checker', colors: ['#eeeeee', '#111111'], tile: 0.5 } },
        openings: [
            { wall: 'north', kind: 'window', from: -1, to: 1, sill: 1, top: 2.4, mullions: 2 },
            { wall: 'south', kind: 'door', from: -0.5, to: 0.4, top: 2.1 },
            { wall: 'east', kind: 'gap', from: 2, to: 3, sill: 0, top: 2.2 },
        ],
        objects: [
            { name: 'Counter', shape: 'box', at: [-1.2, 3, 0], size: [0.7, 4, 1], color: '#b8b8bc', metal: 0.8 },
            { name: 'Stool', shape: 'cylinder', at: [-0.6, 1.5, 0], radius: 0.2, height: 0.75, color: '#8c0a0a',
                repeat: { count: 4, step: [0, 0.9, 0] } },
            { name: 'Pendant', shape: 'sphere', at: [0, 3, 2.5], radius: 0.15, color: '#efe6cf' },
        ],
        cameras: [
            { plate: 'default', position: [0, 0.5, 1.5], yaw: 0, pitch: -2, lens: 24 },
            { plate: 'south', position: [0, 5.5, 1.6], yaw: 180, lens: 24 },
        ],
    }, over);
}

test('the vocabulary the brief tells, the validator accepts and the script builds is one vocabulary', () => {
    const told = JSON.stringify(setBuild.LAYOUT_SCHEMA);
    for (const shape of setBuild.SHAPES) {
        assert.ok(told.includes(shape), `the brief does not tell the agent about the ${shape} shape`);
        assert.ok(SCRIPT.includes(`ob['shape'] == '${shape}'`), `the Blender script cannot build a ${shape}`);
        const one = layout({ objects: [shape === 'box' ? { name: 'x', shape, at: [0, 3, 0], size: [1, 1, 1] }
            : shape === 'asset' ? { name: 'x', shape, asset: 'chair', at: [0, 3, 0] }
                : { name: 'x', shape, at: [0, 3, 0], radius: 0.3, height: 1 }] });
        assert.deepEqual(setBuild.validateLayout(one, ['default', 'south']), [], `a valid ${shape} is refused`);
    }
    for (const side of setBuild.WALL_SIDES) {
        assert.ok(told.includes(side), `the brief does not name the ${side} wall`);
        assert.ok(SCRIPT.includes(`'${side}': dict(`), `the Blender script has no ${side} wall`);
    }
    for (const kind of setBuild.OPENING_KINDS) {
        assert.ok(told.includes(kind), `the brief does not tell the agent about a ${kind}`);
        const one = layout({ openings: [{ wall: 'north', kind, from: -1, to: 1, sill: 0.5, top: 2 }] });
        assert.deepEqual(setBuild.validateLayout(one, ['default', 'south']), [], `a valid ${kind} is refused`);
    }
    // window and door are drawn differently; a gap is a hole with nothing in it.
    assert.match(SCRIPT, /o\['kind'\] == 'window'/);
    assert.match(SCRIPT, /o\['kind'\] == 'door'/);
});

test('a house is walls, slabs and stairs: told, accepted and built, with room optional', () => {
    const told = JSON.stringify(setBuild.LAYOUT_SCHEMA);
    for (const part of setBuild.STRUCTURE) assert.ok(told.includes(part), `the brief does not tell the agent about ${part}`);
    for (const part of ['walls', 'slabs', 'stairs']) {
        assert.ok(SCRIPT.includes(`L.get('${part}', [])`), `the Blender script does not build ${part}`);
    }
    const house = {
        walls: [{ name: 'Hall', from: [0, 0], to: [5, 0], z0: 1.4, height: 2.5,
            openings: [{ kind: 'door', at: 1, width: 0.9, top: 2.1 }, { kind: 'window', at: 3, width: 1.2, sill: 0.9, top: 2.2 }] }],
        slabs: [{ name: 'Upper floor', x0: 0, x1: 5, y0: 0, y1: 4, z: 1.4 }],
        stairs: [{ name: 'Half flight', at: [1, -2, 0], yaw: 0, width: 0.9, rise: 1.4, run: 2.2, steps: 8 }],
        cameras: [{ plate: 'default', position: [2, 2, 3], rotation: [[1, 0, 0], [0, 0, -1], [0, 1, 0]] }],
    };
    assert.deepEqual(setBuild.validateLayout(house, ['default']), [], 'a split-level house with no room is refused');
    const bad = (over, want) => {
        const errs = setBuild.validateLayout(Object.assign({}, house, over), ['default']);
        assert.ok(errs.some(e => want.test(e)), `expected ${want}; got ${JSON.stringify(errs)}`);
    };
    bad({ walls: [{ from: [0, 0], to: [2, 0], height: 2.5, openings: [{ kind: 'door', at: 1.5, width: 0.9 }] }] }, /must sit inside the wall/);
    bad({ walls: [{ from: [0, 0], height: 2.5 }] }, /needs from and to/);
    bad({ slabs: [{ x0: 2, x1: 1, y0: 0, y1: 1, z: 0 }] }, /x0 < x1/);
    bad({ stairs: [{ at: [0, 0, 0], width: 0.9, rise: 1, run: 2, steps: 0 }] }, /steps must be/);
    bad({ cameras: [{ plate: 'default', position: [0, 0, 1], rotation: [[1, 0], [0, 1]] }] }, /3x3 matrix/);
    assert.ok(setBuild.validateLayout({ cameras: house.cameras }, ['default'])[0].includes('needs a building'));
    assert.match(SCRIPT, /c\.get\('rotation'\)/, 'a camera solved from video must be placed by its own rotation');
});

test('a layout is refused by field before Blender runs', () => {
    const views = ['default', 'south'];
    assert.deepEqual(setBuild.validateLayout(layout(), views), []);
    const refusals = [
        [{ room: undefined }, /needs a building/],
        [{ room: { x0: 0, x1: 0.2, y0: 0, y1: 5, height: 3 } }, /room width/],
        [{ room: { x0: 0, x1: 4, y0: 0, y1: 5, height: 3, wall_color: 'red' } }, /wall_color must be #rrggbb/],
        [{ openings: [{ wall: 'up', kind: 'window', from: 0, to: 1 }] }, /openings\[0\]\.wall/],
        [{ openings: [{ wall: 'north', kind: 'arch', from: 0, to: 1 }] }, /openings\[0\]\.kind/],
        [{ openings: [{ wall: 'north', kind: 'door', from: 2, to: 1 }] }, /from < to/],
        [{ objects: [{ name: 'x', shape: 'cone', at: [0, 0, 0] }] }, /shape must be one of/],
        [{ objects: [{ name: 'x', shape: 'box', at: [0, 0, 0], size: [1, 0, 1] }] }, /size must be/],
        [{ objects: [{ name: 'x', shape: 'box', at: [0, 0], size: [1, 1, 1] }] }, /at must be/],
        [{ objects: [{ name: 'x', shape: 'sphere', at: [0, 0, 0], radius: 0.2, repeat: { count: 5000, step: [0, 0, 0] } }] }, /ceiling is/],
        [{ cameras: [] }, /at least one plate camera/],
        [{ cameras: [{ plate: 'north', position: [0, 0, 1.5] }] }, /is not one of this location's plates/],
        [{ cameras: [{ plate: 'south', position: [0, 0, 1.5] }, { plate: 'south', position: [0, 1, 1.5] }] }, /already has a camera/],
        [{ cameras: [{ plate: 'south', position: [0, 0, 1.5], lens: 2 }] }, /lens must be/],
    ];
    for (const [over, want] of refusals) {
        const errs = setBuild.validateLayout(layout(over), views);
        assert.ok(errs.some(e => want.test(e)), `expected ${want} for ${JSON.stringify(over)}; got ${JSON.stringify(errs)}`);
    }
});

test('the brief carries the plates, the location\'s words and Blender\'s presence, for nothing', async () => {
    const f = fixture();
    const r = await call('GET', `/film/locations/${f.locationId}/set-build/brief?images=1`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.plates.map(p => p.view).sort(), ['default', 'south']);
    assert.ok(r.data.plates.every(p => p.width === 320 && p.height === 180));
    assert.equal(r.data.images.length, 2, 'an agent must be able to LOOK at the plates');
    assert.ok(r.data.images.every(i => /^data:image\/png;base64,/.test(i.data_uri)));
    assert.match(r.data.location.description, /Counter down the west side/);
    assert.equal(typeof r.data.blender.available, 'boolean');
    assert.match(r.data.cost, /Free/);
    assert.ok(r.data.instructions.length >= 3);
    assert.equal((await call('GET', '/film/locations/nope/set-build/brief')).status, 404);
});

test('a refused layout writes nothing and names the field', async () => {
    const f = fixture();
    const r = await call('POST', `/film/locations/${f.locationId}/set-builds`,
        { layout: layout({ cameras: [{ plate: 'north', position: [0, 0, 1] }] }) });
    assert.equal(r.status, 400);
    assert.ok(r.data.errors.some(e => /not one of this location's plates/.test(e)));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM film_set_builds WHERE location_id = ?').get(f.locationId).n, 0);
});

const blender = setBuild.resolveBlender();
test('an attempt is built headless, compared against its plates, and finished into a world and a 3D asset',
    { skip: blender.available ? false : `Blender is not installed here: ${blender.reason}`, timeout: 300000 }, async () => {
        const f = fixture();
        const r = await call('POST', `/film/locations/${f.locationId}/set-builds`, { layout: layout(), note: 'first', with_images: true });
        assert.equal(r.status, 201, JSON.stringify(r.data).slice(0, 800));
        assert.equal(r.data.status, 'rendered');
        assert.equal(r.data.attempt, 1);
        assert.deepEqual(r.data.sheets.map(s => s.view).sort(), ['default', 'south'], 'one sheet per plate camera');
        assert.equal(r.data.images.length, 2);
        const sheet = await call('GET', r.data.sheets[0].url);
        assert.equal(sheet.status, 200);
        assert.equal(sheet.headers['Content-Type'], 'image/png');
        assert.ok(Buffer.isBuffer(sheet.data) && sheet.data.slice(1, 4).toString() === 'PNG');
        assert.equal((await call('GET', `/film/set-builds/${r.data.id}/files/..%2Fjob_render.json`)).status, 400,
            'only comparison sheets are served');

        const second = await call('POST', `/film/locations/${f.locationId}/set-builds`, { layout: layout(), note: 'second' });
        assert.equal(second.data.attempt, 2, 'attempts are kept, never overwritten');

        const done = await call('POST', `/film/set-builds/${r.data.id}/finish`);
        assert.equal(done.status, 200, JSON.stringify(done.data).slice(0, 800));
        assert.equal(done.data.status, 'finished');
        const world = db.prepare('SELECT * FROM film_worlds WHERE id = ?').get(done.data.world.id);
        assert.equal(world.location_id, f.locationId, 'the world is created FOR the location');
        const v = db.prepare('SELECT * FROM film_world_versions WHERE id = ?').get(done.data.world_version_id);
        assert.equal(v.provider, 'blender');
        assert.equal(v.scale_factor, 1, 'a Blender set arrives calibrated in metres');
        assert.equal(world.active_version_id, v.id);
        const asset = db.prepare('SELECT * FROM film_assets WHERE id = ?').get(done.data.asset_id);
        assert.equal(JSON.parse(asset.metadata).kind, 'model_3d', 'the set is kept as a 3D model asset');
        assert.ok(fs.existsSync(asset.file_path));
        assert.equal(done.data.faces.style, 'clean', 'the clean previz look is the default');
        assert.ok(done.data.faces.palette_objects > 0, 'clean surfaces take their colour from what the plates show');

        const again = await call('POST', `/film/set-builds/${r.data.id}/finish`);
        assert.equal(again.status, 409, 'finishing twice would put the same set into the world twice');

        // A second finished attempt is the NEXT version of the same world.
        assert.equal((await call('POST', `/film/set-builds/${second.data.id}/finish`, { style: 'glossy' })).status, 400);
        const next = await call('POST', `/film/set-builds/${second.data.id}/finish`, { style: 'painted' });
        assert.ok(next.data.faces.default > 0 && next.data.faces.south > 0, 'painted: both plates are projected onto the set');
        assert.equal(next.data.world.id, world.id);
        assert.equal(next.data.version.version, 2);
    });

test('an agent reaches it through tools that dispatch through the route, and none calls a model', () => {
    const tools = require('../lib/mcp-tools');
    const list = tools.listTools();
    const names = list.map(t => t.name);
    for (const n of ['set_build_brief', 'set_build_render', 'set_build_list', 'set_build_get', 'set_build_finish']) {
        assert.ok(names.includes(n), `${n} is not an agent tool`);
    }
    assert.match(fs.readFileSync(path.join(ROOT, 'backend', 'lib', 'mcp-tools.js'), 'utf8'),
        /name: 'set_build_render',\s*handler: handleSetBuilds/);
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'backend', 'lib', 'set-build.js'), 'utf8'), /llm-client/,
        'reading the plates is the connected agent\'s job, never a server-side model');
});

test('the server routes it ahead of the /film/locations/:id catch-all', () => {
    const at = SERVER.indexOf('handleSetBuilds(req, res, parts, query)');
    const catchAll = SERVER.indexOf("if (parts[1] === 'locations') {");
    assert.ok(at > 0 && catchAll > 0 && at < catchAll, 'set-build routes must be dispatched before the location handler');
    assert.deepEqual([...LOCATION_TAILS].sort(), ['room-scan', 'set-build', 'set-builds']);
});

test('Previs offers it, and the page says what to ask instead of guessing a room', () => {
    assert.match(SPA, /onclick="setBuildOpen\(\)"[^>]*><b>Build or rebuild the set</);
    assert.match(SPA, /set_build_brief, then set_build_render/);
    assert.match(SPA, /\/set-builds\/\$\{buildId\}\/finish/);
    assert.match(SPA, /function setBuildHtml/);
});

test('a box turned by yaw turns about its own centre, not the world origin (built in Blender)',
    { skip: blender.available ? false : `Blender is not installed here: ${blender.reason}`, timeout: 300000 }, () => {
    // A whiteboard on a diagonal wall 2 m from the origin landed 1.5 m away,
    // across a door: the turn was set on the object, whose origin was (0, 0, 0).
    const fs = require('fs'), os = require('os'), { spawnSync } = require('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaw-'));
    const job = { mode: 'none', out_dir: dir, plates: [], assets: {}, layout: {
        walls: [{ name: 'w', from: [0, 0], to: [4, 0], height: 2.5, openings: [] }],
        objects: [{ name: 'board', shape: 'box', at: [2, -1, 1], size: [1, 0.02, 0.6], yaw: 41.2 }],
        cameras: [] } };
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(job));
    fs.writeFileSync(path.join(dir, 'probe.py'), [
        'import bpy, runpy',
        `runpy.run_path(${JSON.stringify(path.join(__dirname, '..', 'blender-set.py'))}, run_name='__main__')`,
        'o = bpy.data.objects["board"]',
        'vs = [o.matrix_world @ v.co for v in o.data.vertices]',
        'print("BOUNDS", min(v.x for v in vs), max(v.x for v in vs), min(v.y for v in vs), max(v.y for v in vs))',
    ].join('\n'));
    const r = spawnSync(blender.bin, ['-b', '--factory-startup', '--python', path.join(dir, 'probe.py'), '--', path.join(dir, 'job.json')], { encoding: 'utf8' });
    const m = (r.stdout || '').match(/BOUNDS (\S+) (\S+) (\S+) (\S+)/);
    assert.ok(m, r.stdout + r.stderr);
    const [x0, x1, y0, y1] = m.slice(1).map(Number);
    assert.ok(Math.abs((x0 + x1) / 2 - 2) < 0.02 && Math.abs((y0 + y1) / 2 + 1) < 0.02, `centre moved to ${(x0 + x1) / 2}, ${(y0 + y1) / 2}`);
    // Turned 41.2°: one metre wide along (cos, sin), so about 0.75 by 0.66 in plan.
    assert.ok(Math.abs((x1 - x0) - 0.765) < 0.03 && Math.abs((y1 - y0) - 0.674) < 0.03, `extent ${x1 - x0} x ${y1 - y0}`);
});

test('a built set\'s objects can be moved and turned, and the walls stay as measured (built in Blender)',
    { skip: blender.available ? false : `Blender is not installed here: ${blender.reason}`, timeout: 300000 }, async () => {
    const projectId = generateId(), locationId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Edit');
    db.prepare('INSERT INTO film_locations (id, project_id, name) VALUES (?, ?, ?)').run(locationId, projectId, 'ROOM');
    const layout = { walls: [
        { name: 'south', from: [0, 0], to: [4, 0], height: 2.5, openings: [] },
        { name: 'east', from: [4, 0], to: [4, 3], height: 2.5, openings: [] },
        { name: 'north', from: [4, 3], to: [0, 3], height: 2.5, openings: [] },
        { name: 'west', from: [0, 3], to: [0, 0], height: 2.5, openings: [] }],
        slabs: [{ name: 'floor', x0: 0, x1: 4, y0: 0, y1: 3, z: 0 }],
        objects: [{ name: 'chair', shape: 'box', at: [1, 1, 0], size: [0.6, 0.6, 0.9], yaw: 0 },
                  { name: 'table', shape: 'box', at: [3, 2, 0], size: [1.2, 0.8, 0.75] }] };
    const first = await setBuild.measuredAttempt(locationId, layout, { note: 'test room' });
    const vid = first.version.id;

    const found = await call('GET', `/film/set-builds?world_version_id=${vid}`);
    assert.equal(found.status, 200, JSON.stringify(found.data));
    assert.equal(found.data.id, first.id);
    assert.equal((await call('GET', '/film/set-builds?world_version_id=nope')).status, 404);

    const objects = found.data.layout.objects.map(o => o.name === 'chair' ? { ...o, at: [2, 1.5, 0], yaw: 180 } : o)
        .filter(o => o.name !== 'table');
    // A caller cannot reshape the measured room: walls sent with the edit are ignored.
    const r = await call('POST', `/film/set-builds/${first.id}/edit`, { objects, walls: [] });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.notEqual(r.data.version.id, vid, 'no new world version');
    assert.equal(r.data.version.version, first.version.version + 1);
    const L = r.data.layout;
    assert.deepEqual(L.walls, found.data.layout.walls, 'the walls changed');
    assert.deepEqual(L.slabs, found.data.layout.slabs);
    assert.deepEqual(L.objects.map(o => [o.name, o.at, o.yaw]), [['chair', [2, 1.5, 0], 180]]);
    assert.equal((await call('POST', `/film/set-builds/${first.id}/edit`, { objects: 'x' })).status, 400);
});

test('the Previs Plan view edits the set: footprints out of the layout and back, then a rebuild that pins the shot', () => {
    const vm = require('vm');
    const fnSrc = name => {
        const i = SPA.indexOf(`function ${name}(`);
        assert.ok(i > 0, `${name} missing`);
        let j = SPA.indexOf(')', i); j = SPA.indexOf('{', j);
        for (let d = 0, k = j; k < SPA.length; k++) {
            if (SPA[k] === '{') d++; else if (SPA[k] === '}' && --d === 0) return SPA.slice(i, k + 1);
        }
        return '';
    };
    const ctx = { Math, JSON, SETEDIT: { build: null, items: [] } };
    vm.createContext(ctx);
    vm.runInContext(fnSrc('setEditItem') + fnSrc('setEditObjects'), ctx);
    const src = [{ name: 'chair', shape: 'asset', asset: 'loungeChair', at: [1.37, 1.75, 0], yaw: 132.9, size: [0.66, 0.87, 1.02] },
                 { name: 'bin', shape: 'cylinder', at: [0.5, 2, 0], radius: 0.13, height: 0.36 }];
    const J = x => JSON.parse(JSON.stringify(x));
    const items = src.map((o, i) => J(ctx.setEditItem(o, i)));
    // Layout (x, y) is world (x, -z); the size is drawn [w, h, d]; yaw is the same number.
    assert.deepEqual(items[0].position, [1.37, 0, -1.75]);
    assert.deepEqual(items[0].sizeM, [0.66, 1.02, 0.87]);
    assert.equal(items[0].rotationDeg[1], 132.9);
    assert.deepEqual(items[1].sizeM, [0.26, 0.36, 0.26]);
    items[0].rotationDeg = [0, 312.9, 0];
    items[0].position = [2, 0, -1];
    ctx.SETEDIT.build = { layout: { objects: src } };
    ctx.SETEDIT.items = items;
    const out = JSON.parse(JSON.stringify(ctx.setEditObjects()));
    assert.deepEqual(out[0], { ...src[0], at: [2, 1, 0], yaw: 312.9 });
    assert.deepEqual(out[1], src[1], 'an untouched cylinder changed');
    // Nothing is written until Rebuild; the rebuild posts to the edit route and pins the shot.
    const rebuild = fnSrc('setEditRebuild');
    assert.match(rebuild, /\/set-builds\/\$\{SETEDIT\.build\.id\}\/edit/);
    assert.match(rebuild, /\/shots\/\$\{WORLD\.shotId\}\/world`, \{ method: 'POST'/);
    assert.match(fnSrc('stageRenderBar'), /setEditStart\(\)/, 'no way into editing the set');
    for (const key of ['setEditTurn(180)', 'setEditRemove()', 'setEditRebuild()']) {
        assert.ok(fnSrc('setEditRenderBar').includes(key), key);
    }
});
