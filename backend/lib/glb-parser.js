/**
 * GLB bytes → points and triangles, for staging a generated model in previs.
 *
 * NOT a renderer, and deliberately not Three.js. Previs is a 4×4 matrix and a
 * polygon painter in canvas 2D — that is why the SPA is still one file with no
 * bundler, per build.target: single-html. Adding a rendering library would
 * trade the architecture for a feature that needs exactly one thing the
 * codebase lacks: something that turns a .glb into geometry. The projection to
 * draw it with already exists.
 *
 * So this reads the subset of glTF 2.0 that blocking a shot needs — positions,
 * indices, node transforms — and ignores everything that only affects how a
 * surface LOOKS. Materials, textures, normals, UVs, morph targets, skins and
 * animation are all skipped, because previs is grey-box: what a director is
 * judging is where the thing is and how big it reads in frame, and a silhouette
 * answers that completely.
 *
 * Pure. Bytes in, geometry out, no I/O.
 */

const GLB_MAGIC = 0x46546C67;   // 'glTF'
const CHUNK_JSON = 0x4E4F534A;  // 'JSON'
const CHUNK_BIN = 0x004E4942;   // 'BIN\0'

/** componentType → [TypedArray, bytes] */
const COMPONENT = {
    5120: [Int8Array, 1], 5121: [Uint8Array, 1],
    5122: [Int16Array, 2], 5123: [Uint16Array, 2],
    5125: [Uint32Array, 4], 5126: [Float32Array, 4],
};
const COMPONENTS_PER = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function toArrayBuffer(input) {
    if (input instanceof ArrayBuffer) return input;
    if (ArrayBuffer.isView(input)) return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
    throw new Error('glb: expected an ArrayBuffer or a typed array');
}

/** Column-major 4×4 (glTF order) applied to a point. */
function applyMatrix(m, p) {
    const [x, y, z] = p;
    const w = (m[3] * x + m[7] * y + m[11] * z + m[15]) || 1;
    return [
        (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
        (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
        (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
    ];
}

function multiply(a, b) {
    const out = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
            let sum = 0;
            for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
            out[c * 4 + r] = sum;
        }
    }
    return out;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** A node's local transform, from an explicit matrix or from TRS. */
function nodeMatrix(node) {
    if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix.slice();

    const t = node.translation || [0, 0, 0];
    const r = node.rotation || [0, 0, 0, 1];      // quaternion xyzw
    const s = node.scale || [1, 1, 1];
    const [x, y, z, w] = r;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;

    return [
        (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
        (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
        (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
        t[0], t[1], t[2], 1,
    ];
}

function readAccessor(json, bin, index) {
    const accessor = json.accessors && json.accessors[index];
    if (!accessor) throw new Error(`glb: accessor ${index} is missing`);
    const [Type, bytes] = COMPONENT[accessor.componentType] || [];
    if (!Type) throw new Error(`glb: unsupported componentType ${accessor.componentType}`);
    const per = COMPONENTS_PER[accessor.type];
    if (!per) throw new Error(`glb: unsupported accessor type ${accessor.type}`);

    const view = json.bufferViews[accessor.bufferView];
    if (!view) throw new Error('glb: accessor has no bufferView');
    if (!Number.isSafeInteger(accessor.count) || accessor.count < 0 || accessor.count * per > 5_000_000) {
        throw new Error('glb: accessor count is invalid or exceeds the previs geometry budget');
    }
    const start = (view.byteOffset || 0) + (accessor.byteOffset || 0);

    // A byteStride means the data is interleaved with other attributes, so it
    // has to be walked element by element rather than read as one block.
    const stride = view.byteStride || 0;
    const elementBytes = per * bytes;
    const requiredEnd = accessor.count
        ? start + (accessor.count - 1) * (stride || elementBytes) + elementBytes
        : start;
    if (!Number.isSafeInteger(start) || start < 0 || requiredEnd > bin.length) {
        throw new Error('glb: accessor runs past the binary chunk');
    }
    const out = new Array(accessor.count * per);
    if (!stride || stride === per * bytes) {
        const flat = new Type(bin.buffer, bin.byteOffset + start, accessor.count * per);
        for (let i = 0; i < flat.length; i++) out[i] = flat[i];
    } else {
        for (let i = 0; i < accessor.count; i++) {
            const el = new Type(bin.buffer, bin.byteOffset + start + i * stride, per);
            for (let c = 0; c < per; c++) out[i * per + c] = el[c];
        }
    }
    return out;
}

/**
 * Parse a .glb into world-space points and triangles.
 *
 * @returns {{ vertices: number[][], triangles: number[][], bounds: {min:number[],max:number[]}, size: number[], meshes: number }}
 */
function parseGlb(input) {
    const buf = Buffer.from(toArrayBuffer(input));
    if (buf.length < 20) throw new Error('glb: file is too short to be a glb');
    if (buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error('glb: not a glb (bad magic)');

    // Walk the chunks rather than assuming JSON-then-BIN: the spec allows other
    // chunk types, and an unknown one must be skipped rather than misread.
    let offset = 12, json = null, bin = null;
    while (offset + 8 <= buf.length) {
        const length = buf.readUInt32LE(offset);
        const type = buf.readUInt32LE(offset + 4);
        const start = offset + 8;
        if (start + length > buf.length) throw new Error('glb: chunk runs past the end of the file');
        if (type === CHUNK_JSON) {
            // Trailing padding is trimmed before parsing. The spec pads this
            // chunk with spaces, but files in the wild pad with nulls, and
            // JSON.parse rejects either — a real exporter's output would have
            // failed here with a byte offset rather than a reason.
            const text = buf.slice(start, start + length).toString('utf8').replace(/[\s\u0000]+$/, '');
            json = JSON.parse(text);
        }
        else if (type === CHUNK_BIN) bin = buf.slice(start, start + length);
        offset = start + length;
    }
    if (!json) throw new Error('glb: no JSON chunk');

    /*
     * A REQUIRED extension is a refusal, and it must say which one.
     *
     * glTF's contract is that extensionsRequired may not be ignored: a
     * Draco-compressed file keeps its POSITION accessor as a stub with no
     * bufferView, so reading on regardless died three functions later on
     * "accessor has no bufferView" — true, useless, and indistinguishable from
     * a corrupt file. A director export from Meshy with compression on then
     * looked like a broken importer.
     *
     * Named per extension with the remedy, because the remedy differs: Draco
     * and meshopt are export switches you turn off; anything else is a file
     * this parser genuinely cannot read.
     */
    const REQUIRED_EXTENSION_HELP = {
        KHR_draco_mesh_compression:
            'this model is Draco-compressed. Re-export it with mesh compression turned OFF '
            + '(in Meshy, choose GLB without Draco) and import it again',
        EXT_meshopt_compression:
            'this model uses meshopt compression. Re-export it uncompressed and import it again',
    };
    // Extensions that change how a model LOOKS, never where its triangles are:
    // lights, materials, texture transforms. Blender marks the lights extension
    // required when a set is exported with its sun, and refusing it would refuse
    // a set for carrying the light Previs is meant to plan with.
    const geometryNeutral = ext => ext === 'KHR_lights_punctual' || ext === 'KHR_texture_transform'
        || ext === 'KHR_materials_unlit' || /^KHR_materials_/.test(ext) || ext === 'EXT_texture_webp';
    for (const ext of (json.extensionsRequired || []).filter(e => !geometryNeutral(e))) {
        const help = REQUIRED_EXTENSION_HELP[ext];
        throw new Error(`glb: ${help || `this model requires the ${ext} extension, which previs cannot read. `
            + 'Re-export it as plain glTF 2.0 binary'}`);
    }
    if (!json.meshes || !json.meshes.length) throw new Error('glb: file contains no meshes');
    if (!bin) throw new Error('glb: no binary chunk (external .bin files are not supported)');

    const vertices = [];
    const triangles = [];

    const emitMesh = (meshIndex, matrix) => {
        const mesh = json.meshes[meshIndex];
        if (!mesh) return;
        for (const prim of (mesh.primitives || [])) {
            // Mode 4 is TRIANGLES and the only one previs draws; strips and fans
            // would need their own walk and generators do not emit them.
            if (prim.mode !== undefined && prim.mode !== 4) continue;
            const posIndex = prim.attributes && prim.attributes.POSITION;
            if (posIndex === undefined) continue;

            const flat = readAccessor(json, bin, posIndex);
            const base = vertices.length;
            for (let i = 0; i < flat.length; i += 3) {
                vertices.push(applyMatrix(matrix, [flat[i], flat[i + 1], flat[i + 2]]));
            }

            if (prim.indices !== undefined) {
                const idx = readAccessor(json, bin, prim.indices);
                for (let i = 0; i + 2 < idx.length; i += 3) {
                    triangles.push([base + idx[i], base + idx[i + 1], base + idx[i + 2]]);
                }
            } else {
                // Unindexed: every three consecutive points are a triangle.
                const count = flat.length / 3;
                for (let i = 0; i + 2 < count; i += 3) triangles.push([base + i, base + i + 1, base + i + 2]);
            }
        }
    };

    const visiting = new Set();
    let visitedNodes = 0;
    const walk = (nodeIndex, parent) => {
        if (!Number.isSafeInteger(nodeIndex) || nodeIndex < 0) throw new Error('glb: invalid node index');
        if (visiting.has(nodeIndex)) throw new Error('glb: cyclic node graph');
        if (++visitedNodes > 100_000) throw new Error('glb: scene graph exceeds the previs node budget');
        const node = json.nodes && json.nodes[nodeIndex];
        if (!node) return;
        visiting.add(nodeIndex);
        const matrix = multiply(parent, nodeMatrix(node));
        if (node.mesh !== undefined) emitMesh(node.mesh, matrix);
        for (const child of (node.children || [])) walk(child, matrix);
        visiting.delete(nodeIndex);
    };

    const scene = json.scenes && json.scenes[json.scene || 0];
    if (scene && Array.isArray(scene.nodes)) {
        for (const n of scene.nodes) walk(n, IDENTITY);
    } else {
        // No scene graph: draw every mesh at the origin rather than nothing.
        json.meshes.forEach((_, i) => emitMesh(i, IDENTITY));
    }

    if (!vertices.length) throw new Error('glb: no readable geometry (no POSITION accessor found)');
    return { vertices, triangles, meshes: json.meshes.length, ...boundsOf(vertices) };
}

function boundsOf(vertices) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const v of vertices) {
        for (let a = 0; a < 3; a++) {
            if (v[a] < min[a]) min[a] = v[a];
            if (v[a] > max[a]) max[a] = v[a];
        }
    }
    return { bounds: { min, max }, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/**
 * Reduce a mesh to something canvas 2D can repaint on every orbit tick.
 *
 * A generated character can be a hundred thousand triangles, and previs
 * repaints continuously while you drag. Sampling evenly rather than taking the
 * first N: the first N of an exported mesh is usually one limb, whereas an even
 * stride keeps the whole silhouette, which is the only thing previs is for.
 *
 * Vertices are kept whole so the bounds — and therefore where the model stands
 * and how big it reads — do not move when the budget changes.
 */
function decimate(geometry, maxTriangles) {
    const budget = Math.max(1, Number(maxTriangles) || 4000);
    const all = geometry.triangles || [];
    if (all.length <= budget) return { ...geometry, dropped: 0 };

    const stride = all.length / budget;
    const kept = [];
    for (let i = 0; kept.length < budget && Math.floor(i * stride) < all.length; i++) {
        kept.push(all[Math.floor(i * stride)]);
    }
    return { ...geometry, triangles: kept, dropped: all.length - kept.length };
}

module.exports = { parseGlb, decimate, boundsOf, nodeMatrix, applyMatrix, multiply };
