/**
 * Reading a generated .glb well enough to block a shot against it.
 *
 * Previs stages a figure, a box, a sphere and a flat image card. A character
 * generated as a mesh could not be staged at all, so the one subject the film
 * is actually about had to be blocked against a cutout or a proxy cube.
 *
 * NOT Three.js. Previs is a 4×4 matrix and a polygon painter in canvas 2D, and
 * that is why the SPA is still one file with no bundler — build.target is
 * single-html. Pulling in a renderer would trade the whole architecture for a
 * feature that only needs one thing the codebase lacks: something that turns
 * GLB bytes into points and triangles. The projection to draw them with is
 * already here.
 *
 * The parser is pure — bytes in, geometry out, no I/O — so it can be tested
 * against a file this test builds itself rather than a binary fixture nobody
 * can read in a diff.
 */

const test = require('node:test');
const assert = require('node:assert');

const glb = require('../lib/glb-parser');

/**
 * Build a real GLB in memory: a unit cube as two chunks, the way an exporter
 * writes one.
 *
 * Constructing it here rather than committing a binary means every field the
 * parser depends on is visible in the test, and a spec detail we get wrong is
 * wrong in one place instead of two.
 */
function buildGlb({ scale = 1, withIndices = true, nodeMatrix = null, countOverride = null, cyclic = false } = {}) {
    const positions = new Float32Array([
        0, 0, 0,  1, 0, 0,  1, 1, 0,  0, 1, 0,
        0, 0, 1,  1, 0, 1,  1, 1, 1,  0, 1, 1,
    ].map(v => v * scale));
    const indices = new Uint16Array([
        0, 1, 2, 0, 2, 3,   4, 5, 6, 4, 6, 7,
        0, 1, 5, 0, 5, 4,   2, 3, 7, 2, 7, 6,
        0, 3, 7, 0, 7, 4,   1, 2, 6, 1, 6, 5,
    ]);

    const posBytes = Buffer.from(positions.buffer);
    const idxBytes = Buffer.from(indices.buffer);
    // The spec pads the JSON chunk with SPACES and the BIN chunk with zeros.
    // Getting that wrong here would test the parser against a file no exporter
    // writes.
    const padWith = (b, byte) => (b.length % 4 === 0 ? b
        : Buffer.concat([b, Buffer.alloc(4 - (b.length % 4), byte)]));
    const pad = b => padWith(b, 0x00);
    const bin = Buffer.concat([pad(posBytes), pad(idxBytes)]);

    const node = { mesh: 0 };
    if (nodeMatrix) node.matrix = nodeMatrix;
    if (cyclic) node.children = [0];

    const json = {
        asset: { version: '2.0' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [node],
        meshes: [{ primitives: [Object.assign({ attributes: { POSITION: 0 } }, withIndices ? { indices: 1 } : {})] }],
        accessors: [
            { bufferView: 0, componentType: 5126, count: countOverride === null ? 8 : countOverride, type: 'VEC3' },
            { bufferView: 1, componentType: 5123, count: indices.length, type: 'SCALAR' },
        ],
        bufferViews: [
            { buffer: 0, byteOffset: 0, byteLength: posBytes.length },
            { buffer: 0, byteOffset: pad(posBytes).length, byteLength: idxBytes.length },
        ],
        buffers: [{ byteLength: bin.length }],
    };

    const jsonBytes = padWith(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546C67, 0);            // 'glTF'
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + 8 + jsonBytes.length + 8 + bin.length, 8);

    const jsonHeader = Buffer.alloc(8);
    jsonHeader.writeUInt32LE(jsonBytes.length, 0);
    jsonHeader.writeUInt32LE(0x4E4F534A, 4);        // 'JSON'

    const binHeader = Buffer.alloc(8);
    binHeader.writeUInt32LE(bin.length, 0);
    binHeader.writeUInt32LE(0x004E4942, 4);         // 'BIN'

    return Buffer.concat([header, jsonHeader, jsonBytes, binHeader, bin]);
}

test('a well-formed glb yields its points and triangles', () => {
    const geo = glb.parseGlb(buildGlb());
    assert.strictEqual(geo.vertices.length, 8, `expected 8 points, got ${geo.vertices.length}`);
    assert.strictEqual(geo.triangles.length, 12, `a cube is 12 triangles, got ${geo.triangles.length}`);
    for (const v of geo.vertices) {
        assert.strictEqual(v.length, 3);
        assert.ok(v.every(Number.isFinite), `non-finite point: ${JSON.stringify(v)}`);
    }
});

test('the bounding box is right, because previs sizes everything from it', () => {
    // A mesh is placed and scaled by its bounds. Get these wrong and a dragon
    // stages at the size of a mug.
    const geo = glb.parseGlb(buildGlb({ scale: 3 }));
    assert.deepStrictEqual(geo.bounds.min, [0, 0, 0]);
    assert.deepStrictEqual(geo.bounds.max, [3, 3, 3]);
    assert.deepStrictEqual(geo.size, [3, 3, 3]);
});

test('a node transform is applied, or the model stages in the wrong place', () => {
    // Exporters routinely put the model's scale and rotation on the node
    // rather than baking it into the vertices. Ignoring it is the classic
    // "my model is 100x too big or lying on its side" bug.
    const shifted = glb.parseGlb(buildGlb({
        nodeMatrix: [2, 0, 0, 0,  0, 2, 0, 0,  0, 0, 2, 0,  5, 0, 0, 1],   // scale 2, +5 on x
    }));
    assert.deepStrictEqual(shifted.bounds.min, [5, 0, 0]);
    assert.deepStrictEqual(shifted.bounds.max, [7, 2, 2]);
});

test('a mesh with no index buffer is read as sequential triangles', () => {
    // Legal glTF, and common from some exporters.
    const geo = glb.parseGlb(buildGlb({ withIndices: false }));
    assert.ok(geo.triangles.length > 0, 'an unindexed mesh produced no triangles');
});

test('a mesh is decimated to a budget, because previs draws it every frame', () => {
    // A generated character can be a hundred thousand triangles. Canvas 2D
    // repaints on every orbit tick, so drawing them all would make the stage
    // unusable — and previs is grey-box blocking, where a silhouette is the
    // whole point. The budget is honest about what it dropped.
    const geo = glb.parseGlb(buildGlb());
    const small = glb.decimate(geo, 4);
    assert.ok(small.triangles.length <= 4, `budget 4, got ${small.triangles.length}`);
    assert.strictEqual(small.dropped, geo.triangles.length - small.triangles.length);
    // Points survive so the bounds — and therefore the placement — do not move.
    assert.deepStrictEqual(small.bounds, geo.bounds);
});

test('decimation below the budget changes nothing', () => {
    const geo = glb.parseGlb(buildGlb());
    const same = glb.decimate(geo, 1000);
    assert.strictEqual(same.triangles.length, geo.triangles.length);
    assert.strictEqual(same.dropped, 0);
});

test('rubbish is refused with a reason, not a stack trace', () => {
    // The file comes off a generator and over a network. "Not a glb" is an
    // answer; a TypeError from deep in a byte offset is not.
    for (const bad of [Buffer.alloc(0), Buffer.from('hello world'), Buffer.alloc(64)]) {
        assert.throws(() => glb.parseGlb(bad), /glb/i, `accepted ${bad.length} bytes of nonsense`);
    }
});

test('an accessor cannot allocate beyond the uploaded binary data', () => {
    assert.throws(() => glb.parseGlb(buildGlb({ countOverride: 1_000_000_000 })), /accessor|budget/i);
});

test('a cyclic scene graph is rejected instead of recursing forever', () => {
    assert.throws(() => glb.parseGlb(buildGlb({ cyclic: true })), /cyclic/i);
});
