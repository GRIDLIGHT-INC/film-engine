/**
 * Scouting a location in Previs, before there is a shot.
 *
 * A phone scan of The Lodgers' office reached the server, was built into a
 * set, and could be seen nowhere but the 3D assets: Previs belongs to shots,
 * and the project had none. Scouting opens a location's newest set version
 * with a free camera; "Make a shot from this camera" turns a view into a shot.
 *
 *   - where the scout stands is EXECUTED over an L-shaped room: inside it,
 *     never out in the empty corner of the L, facing the longest clear view;
 *   - which worlds can be walked, which scene a shot lands in, and its code;
 *   - the page: opened when there is no shot, the mouse moves it, the right
 *     panel follows the walk, and making the shot writes the shot, its world
 *     pin and its camera, or says which scene heading is missing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

function fnSrc(name) {
    const i = HTML.indexOf(`function ${name}(`);
    assert.ok(i > 0, `${name} missing`);
    let j = HTML.indexOf(')', i); j = HTML.indexOf('{', j);
    for (let d = 0, k = j; k < HTML.length; k++) {
        if (HTML[k] === '{') d++;
        else if (HTML[k] === '}' && --d === 0) return HTML.slice(i, k + 1);
    }
    return '';
}

function load(...names) {
    const ctx = { Math, Number, Array, Infinity, Map, String };
    vm.createContext(ctx);
    vm.runInContext(names.map(fnSrc).join('\n'), ctx);
    return ctx;
}

/** An L-shaped room as wall quads, the shape a collider carries. */
function lRoom() {
    const outline = [[0, 0], [6, 0], [6, 3], [3, 3], [3, 6], [0, 6]];
    const vertices = [], triangles = [];
    outline.forEach((a, i) => {
        const c = outline[(i + 1) % outline.length];
        const n = vertices.length;
        vertices.push([a[0], 0, a[1]], [c[0], 0, c[1]], [c[0], 2.5, c[1]], [a[0], 2.5, a[1]]);
        triangles.push([n, n + 1, n + 2], [n, n + 2, n + 3]);
    });
    return { vertices, triangles, bounds: { min: [0, 0, 0], max: [6, 2.5, 6] }, scale_state: 'SCALE CALIBRATED' };
}

test('the scout stands inside the room, in its open part, at eye height, facing the longest view', () => {
    const { scoutStartCamera } = load('scoutStartCamera');
    const c = scoutStartCamera(lRoom());
    assert.ok(c, 'no start was found in a closed room');
    const [x, y, z] = c.position;
    assert.equal(y, 1.6, 'not at eye height above the floor');
    // Inside the L: the empty corner is x > 3 and z > 3.
    assert.ok(x > 0 && x < 6 && z > 0 && z < 6, 'outside the room');
    assert.ok(!(x > 3 && z > 3), `stood in the empty corner of the L at ${x.toFixed(2)}, ${z.toFixed(2)}`);
    assert.ok(c.clear > 0.8, `stood ${c.clear.toFixed(2)} m from a wall: the frame would be one slab`);
    assert.ok(c.view > 3, `faced a wall ${c.view.toFixed(2)} m away when the room runs 6 m`);
    assert.ok(Number.isFinite(c.rotation[0]) && c.rotation[1] < 0, 'no heading, or not looking slightly down');
});

test('with nothing to slice, the scout start says so rather than inventing a place', () => {
    const { scoutStartCamera } = load('scoutStartCamera');
    assert.equal(scoutStartCamera(null), null);
    assert.equal(scoutStartCamera({ bounds: { min: [0, 0, 0], max: [1, 1, 1] }, vertices: [], triangles: [] }), null);
    // An open floor with no walls is not inside anything.
    const open = { vertices: [[0, 0, 0], [5, 0, 0], [5, 0, 5]], triangles: [[0, 1, 2]], bounds: { min: [0, 0, 0], max: [5, 2.5, 5] } };
    assert.equal(scoutStartCamera(open), null);
});

test('only worlds with a version can be walked, newest version first, named for their location', () => {
    const { scoutableWorlds } = load('scoutableWorlds');
    const names = new Map([['loc-1', 'Office']]);
    const out = scoutableWorlds([
        { id: 'w1', name: 'Office world', location_id: 'loc-1', versions: [{ id: 'v1', version: 1 }, { id: 'v2', version: 2 }] },
        { id: 'w2', name: 'Empty', versions: [] },
        { id: 'w3', name: 'Street', versions: [{ id: 'v9', version: 1 }] },
    ], names);
    assert.deepEqual(out.map(o => [o.world.id, o.version.id, o.name]), [['w1', 'v2', 'Office'], ['w3', 'v9', 'Street']]);
});

test('a scouted shot lands in a scene at that location, under the next free code', () => {
    const { scoutSceneFor, scoutShotCode } = load('scoutSceneFor', 'scoutShotCode');
    const scenes = [
        { id: 's1', scene_number: 1, location: 'KITCHEN' },
        { id: 's2', scene_number: 2, location: 'OFFICE', status: 'removed' },
        { id: 's3', scene_number: 3, location: 'Office' },
    ];
    assert.equal(scoutSceneFor(scenes, 'office').id, 's3', 'a removed scene took the shot');
    assert.equal(scoutSceneFor(scenes, 'Garage'), null);
    assert.equal(scoutShotCode(3, []), '3A');
    assert.equal(scoutShotCode(3, ['3A', '3b']), '3C');
});

test('the page: opened with no shot, moved by the mouse, the panel follows, and a shot is made from the view', () => {
    const page = fnSrc('loadPrevisPage');
    assert.ok(/worldLoadScoutable\(/.test(page), 'Previs never looks for sets to walk');
    assert.ok(/else if \(\(WORLD\.scoutable[\s\S]*worldScoutSelect\(/.test(page), 'with no shot, the set is not opened');
    assert.ok(/!!WORLD\.shotId \|\| !!WORLD\.scout/.test(fnSrc('worldGestureView')), 'the mouse cannot move a scouting camera');
    assert.ok(/worldOperateRefreshValues\(\)/.test(fnSrc('worldWalkRepaint')), 'Camera Operate does not follow the walk');
    assert.ok(/WORLD\.scout[\s\S]*worldScoutMakeShot\(\)/.test(fnSrc('worldWalkBarHtml')), 'no way to keep a scouted view');
    assert.ok(/scoutStartCamera\(WORLD\.geometry\)/.test(fnSrc('worldScoutSelect')), 'the scout opens wherever the bounding box says');
    const make = fnSrc('worldScoutMakeShot');
    assert.ok(/api\('\/shots', \{ method: 'POST'/.test(make), 'no shot is created');
    assert.ok(/\/shots\/\$\{shot\.id\}\/world`, \{ method: 'POST'/.test(make), 'the shot is not pinned to the set it was chosen in');
    assert.ok(/\/shots\/\$\{shot\.id\}\/previs`, \{ method: 'PUT'[\s\S]*camera:/.test(make), 'the walked camera is not saved on the shot');
    assert.ok(/No scene is set at[\s\S]*INT\./.test(make), 'with no scene, the refusal does not say what heading to write');
    assert.ok(/WORLD\.scout = null/.test(fnSrc('worldRailSelect')), 'choosing a shot does not leave scouting');
});

test('the work light on the camera steps back for a lighting rig', () => {
    assert.ok(/MESHLOOK\.work = new T\.PointLight/.test(HTML), 'no light travels with the camera');
    assert.ok(/MESHLOOK\.work\.visible = !MESHLOOK\.rig/.test(fnSrc('worldMeshRenderOnce')), 'the work light fights the shot\'s own rig');
});
