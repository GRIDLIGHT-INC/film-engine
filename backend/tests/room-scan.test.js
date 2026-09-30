/**
 * A RoomPlan scan becomes a Previs set: one room, or a house over two storeys.
 *
 * The fixture is written in Apple's own Codable shape — surfaces and objects
 * with `category` as an enum-with-payload, `dimensions` [x, y, z] and a
 * `transform` of four columns — in ARKit's axes (y up, -z forward). A two-storey
 * house: downstairs a 5 x 4 m room with a door, a window, a table, a sofa, a
 * chair and a staircase; upstairs a room 2.8 m higher with a bed.
 *
 *   - walls become segments in plan, doors and windows are cut into the wall
 *     they belong to at the right distance along it;
 *   - the lowest floor is z = 0 and the upper storey keeps its height;
 *   - furniture becomes the Previs library model for its category, at its
 *     measured size; stairs become stairs; anything unreadable is named;
 *   - the layout passes the set-build validator as a MEASURED layout (no plate
 *     cameras), and the route answers a dry run for free;
 *   - with Blender here, it is built into the location's world and a 3D asset.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-roomscan-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();
const { scanToLayout, columnsOf, categoryOf } = require('../lib/room-scan');
const setBuild = require('../lib/set-build');
const { handleSetBuilds } = require('../routes/set-builds');

/** A transform: yaw about y (degrees) and a centre, as four nested columns. */
function T(yawDeg, centre) {
    const a = yawDeg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    return [[c, 0, -s, 0], [0, 1, 0, 0], [s, 0, c, 0], [centre[0], centre[1], centre[2], 1]];
}
/** A floor: its local X/Y plane laid flat (x east, local y along -z). */
function Tfloor(centre) { return [[1, 0, 0, 0], [0, 0, -1, 0], [0, 1, 0, 0], [centre[0], centre[1], centre[2], 1]]; }
const surf = (id, cat, dims, t, extra = {}) => Object.assign({ identifier: id, category: cat, dimensions: dims, transform: t, confidence: { high: {} } }, extra);

function house() {
    // Ground floor: x 0..5, z 0..-4 (4 m "north"), walls 2.6 m high, floor at y 0.
    const g = 0, h = 2.6, up = 2.8;
    const walls = [
        surf('W1', { wall: {} }, [5, h, 0], T(0, [2.5, g + h / 2, 0]), { story: 0 }),         // south wall along x
        surf('W2', { wall: {} }, [5, h, 0], T(0, [2.5, g + h / 2, -4]), { story: 0 }),        // north wall
        surf('W3', { wall: {} }, [4, h, 0], T(90, [0, g + h / 2, -2]), { story: 0 }),         // west wall along -z
        surf('W4', { wall: {} }, [4, h, 0], T(90, [5, g + h / 2, -2]), { story: 0 }),         // east wall
        // Upstairs, same footprint, 2.8 m up.
        surf('U1', { wall: {} }, [5, h, 0], T(0, [2.5, up + h / 2, 0]), { story: 1 }),
        surf('U2', { wall: {} }, [5, h, 0], T(0, [2.5, up + h / 2, -4]), { story: 1 }),
        surf('U3', { wall: {} }, [4, h, 0], T(90, [0, up + h / 2, -2]), { story: 1 }),
        surf('U4', { wall: {} }, [4, h, 0], T(90, [5, up + h / 2, -2]), { story: 1 }),
    ];
    return {
        version: 2,
        rooms: [{ identifier: 'ground', story: 0 }, { identifier: 'upstairs', story: 1 }],
        walls,
        // A door 1.2 m along the south wall (centre at 1.65), 0.9 wide, 2.05 high.
        doors: [surf('D1', { door: { isOpen: true } }, [0.9, 2.05, 0], T(0, [1.65, 2.05 / 2, 0]), { parentIdentifier: 'W1' })],
        // A window in the north wall with no parent named: found by the wall it sits on.
        windows: [surf('N1', { window: {} }, [1.2, 1.1, 0], T(0, [3.0, 0.9 + 0.55, -4]))],
        openings: [],
        floors: [surf('F1', { floor: {} }, [5, 4, 0], Tfloor([2.5, 0, -2])), surf('F2', { floor: {} }, [5, 4, 0], Tfloor([2.5, up, -2]))],
        objects: [
            surf('O1', { table: {} }, [1.6, 0.75, 0.9], T(0, [2.5, 0.375, -2])),
            surf('O2', { sofa: {} }, [2.0, 0.85, 0.9], T(180, [2.5, 0.425, -3.4])),
            surf('O3', { chair: {} }, [0.45, 0.9, 0.45], T(0, [1.5, 0.45, -1.2])),
            surf('O4', { stairs: {} }, [1.0, 2.8, 3.5], T(90, [4.4, 1.4, -2])),
            surf('O5', { bed: {} }, [1.6, 0.6, 2.1], T(0, [2.5, up + 0.3, -2.5])),
            surf('O6', { fireplace: {} }, [1.4, 1.1, 0.4], T(0, [0.8, 0.55, -3.7])),
            { identifier: 'O7', category: { table: {} } },          // unreadable: no transform
        ],
    };
}

test('the Codable shapes are read either way Apple writes them', () => {
    assert.equal(categoryOf({ door: { isOpen: false } }), 'door');
    assert.equal(categoryOf('wall'), 'wall');
    const nested = T(30, [1, 2, 3]);
    const flat = nested.flat();
    assert.deepEqual(columnsOf(nested), columnsOf(flat));
    assert.equal(columnsOf([1, 2]), null);
});

test('a two-storey house becomes walls, openings, floors, stairs and library furniture', () => {
    const { layout, report } = scanToLayout(house());
    assert.equal(layout.walls.length, 8);
    assert.deepEqual(report.stories, [0, 1]);
    // South wall: from x 0 to 5 at plan y 0; the door starts 1.2 m along it.
    const south = layout.walls.find(w => w.name.startsWith('wall 1'));
    assert.deepEqual([south.from, south.to], [[0, 0], [5, 0]]);
    const door = south.openings.find(o => o.kind === 'door');
    assert.ok(door && Math.abs(door.at - 1.2) < 1e-6 && door.sill === 0 && Math.abs(door.width - 0.9) < 1e-6, JSON.stringify(south.openings));
    // The window found its wall with no parent named; north is plan y +4.
    const north = layout.walls.find(w => w.name.startsWith('wall 2'));
    assert.deepEqual(north.from.map(Math.round), [0, 4]);
    const win = north.openings.find(o => o.kind === 'window');
    assert.ok(win && Math.abs(win.at - 2.4) < 1e-6 && Math.abs(win.sill - 0.9) < 1e-6, JSON.stringify(north.openings));
    // Storeys keep their heights; the lowest floor is 0.
    assert.equal(layout.walls[0].z0, 0);
    assert.equal(layout.walls.find(w => w.name.startsWith('wall 5')).z0, 2.8);
    assert.deepEqual(layout.slabs.map(s => s.z).sort(), [0, 2.8]);
    // Furniture from the library at its measured size; stairs as stairs; a fireplace as a box.
    const table = layout.objects.find(o => o.asset === 'table');
    assert.deepEqual(table.size, [1.6, 0.9, 0.75]);
    assert.deepEqual(table.at, [2.5, 2, 0]);
    assert.ok(layout.objects.some(o => o.asset === 'loungeSofa') && layout.objects.some(o => o.asset === 'chair'));
    assert.equal(layout.objects.find(o => o.asset === 'bedDouble').at[2], 2.8, 'the bed is not upstairs');
    assert.equal(layout.objects.find(o => /fireplace/.test(o.name)).shape, 'box');
    assert.equal(layout.stairs.length, 1);
    assert.ok(Math.abs(layout.stairs[0].rise - 2.8) < 1e-6);
    // An object faces its local +z. Unturned, that is ARKit +z: south, yaw 180; the sofa
    // turned 180° faces north, yaw 0. (Confirmed against the first real scan.)
    assert.ok(Math.abs(Math.abs(table.yaw) - 180) < 1e-6, `table yaw ${table.yaw}`);
    assert.ok(Math.abs(layout.objects.find(o => o.asset === 'loungeSofa').yaw % 360) < 1e-6);
    assert.ok(report.skipped.some(s => /objects\[6\]/.test(s)), 'the unreadable object was not named');
    // And the set builder accepts it as a measured layout.
    assert.deepEqual(setBuild.validateLayout(layout, [], { measured: true }), []);
    assert.ok(setBuild.validateLayout(layout, []).length > 0, 'a plate layout still needs its cameras');
});

function call(method, urlPath, body) {
    return new Promise(resolve => {
        const res = {
            statusCode: 200, writeHead(s) { this.statusCode = s; }, setHeader() {},
            end(c) { let d; try { d = JSON.parse(String(c)); } catch { d = c; } resolve({ status: this.statusCode, data: d }); },
        };
        handleSetBuilds({ method, body: body || {} }, res, urlPath.split('/').filter(Boolean), {});
    });
}

function location() {
    const projectId = generateId(), locationId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Scan');
    db.prepare('INSERT INTO film_locations (id, project_id, name) VALUES (?, ?, ?)').run(locationId, projectId, 'HOUSE');
    return { projectId, locationId };
}

test('the route answers a dry run for free, and refuses a scan with no walls', async () => {
    const { locationId } = location();
    const dry = await call('POST', `/film/locations/${locationId}/room-scan/import`, { structure: JSON.stringify(house()), dry_run: true });
    assert.equal(dry.status, 200, JSON.stringify(dry.data).slice(0, 400));
    assert.equal(dry.data.layout.walls.length, 8);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM film_set_builds WHERE location_id = ?').get(locationId).n, 0, 'a dry run built something');
    const none = await call('POST', `/film/locations/${locationId}/room-scan/import`, { structure: { walls: [] }, dry_run: true });
    assert.equal(none.status, 400);
    assert.equal((await call('POST', `/film/locations/${locationId}/room-scan/import`, {})).status, 400);
});

const blender = setBuild.resolveBlender();
test('with Blender here, the house is built into the location\'s world and a 3D asset',
    { skip: blender.available ? false : `Blender is not installed here: ${blender.reason}`, timeout: 300000 }, async () => {
        const { locationId } = location();
        const r = await call('POST', `/film/locations/${locationId}/room-scan/import`, { structure: house(), name: 'test house' });
        assert.equal(r.status, 201, JSON.stringify(r.data).slice(0, 800));
        assert.equal(r.data.status, 'finished');
        const v = db.prepare('SELECT * FROM film_world_versions WHERE id = ?').get(r.data.world_version_id);
        assert.equal(v.provider, 'blender');
        assert.equal(v.scale_factor, 1, 'a scan arrives in metres');
        const size = JSON.parse(v.size_m_json || v.size_m || 'null') || r.data.version.size_m;
        assert.ok(Array.isArray(size) && size.some(n => n > 5), `the set is not house-sized: ${JSON.stringify(size)}`);
        assert.ok(Math.max(...size) >= 5 && size.some(n => n >= 5.3), 'the second storey is not in the build');
    });

test('the iPhone app scans with RoomPlan and the page asks it under the same names', () => {
    const fs = require('fs');
    const root = path.join(__dirname, '..', '..');
    const swift = fs.readFileSync(path.join(root, 'ios', 'FilmEngine', 'RoomScan.swift'), 'utf8');
    const content = fs.readFileSync(path.join(root, 'ios', 'FilmEngine', 'ContentView.swift'), 'utf8');
    const pbx = fs.readFileSync(path.join(root, 'ios', 'FilmEngine.xcodeproj', 'project.pbxproj'), 'utf8');
    const page = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
    const name = swift.match(/static let name = "(\w+)"/)[1];
    const callback = swift.match(/static let callback = "(\w+)"/)[1];
    assert.ok(page.includes(`messageHandlers.${name}.postMessage`), `the page does not post to ${name}`);
    assert.ok(page.includes(`window.${callback} = function`), `the page does not answer ${callback}`);
    assert.ok(/add\(context\.coordinator, name: RoomScanBridge\.name\)/.test(content), 'the app does not listen for the scan');
    assert.ok(/RoomScan\.swift in Sources/.test(pbx), 'RoomScan.swift is not compiled into the app');
    // One continuous session across rooms, merged by Apple's builder, uploaded to the page's route.
    assert.ok(/stop\(pauseARSession: false\)/.test(swift), 'a finished room stops the AR session, so the next room loses its place');
    assert.ok(/StructureBuilder/.test(swift), 'rooms are not merged into one structure');
    assert.ok(/room-scan\/import/.test(page) && /"\/film" \+ request\.url/.test(swift), 'the upload does not go to the page\'s route');
});
