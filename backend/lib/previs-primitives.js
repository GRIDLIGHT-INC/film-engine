/**
 * Stage primitives — what stands in the previs scene.
 *
 * A featureless box tells you nothing about a complex move: you cannot see
 * which way a subject faces, whether the camera clears a foreground object, or
 * how much of the frame a person actually occupies as you orbit. A standing
 * figure and a few placeable shapes are the smallest set that fixes that.
 *
 * Deliberately NOT a modelling tool. Everything here is a box, a sphere, or a
 * figure assembled from boxes, positioned and scaled. Set building, materials
 * and animation stay out — they are how a previs tool turns into a worse
 * version of Blender.
 *
 * Geometry is produced here rather than in the viewer so it is testable without
 * a browser, and so the viewer draws exactly the figure the server measured.
 * The proportions are served through GET /film/previs/taxonomy, so the SPA
 * renders from this spec instead of keeping a second copy of it.
 */

/**
 * Human proportions as fractions of total height.
 *
 * Roughly the 7.5-head figure used in life drawing: it is not anatomy, it is
 * the smallest set of blocks that reads as a person from across a room and
 * silhouettes correctly at any angle. Every part is expressed as a fraction so
 * a 1.5m child and a 2m adult are the same figure scaled.
 *
 * Fractions are of HEIGHT for y, and of height for x/z too, so the figure keeps
 * its proportions rather than stretching when a width is given.
 */
const HUMAN_PARTS = [
    { name: 'head', size: [0.115, 0.133, 0.125], centre: [0, 0.9335, 0] },   // top lands on 1.0 exactly
    { name: 'neck', size: [0.055, 0.040, 0.055], centre: [0, 0.847, 0] },
    { name: 'torso', size: [0.215, 0.265, 0.125], centre: [0, 0.695, 0] },
    { name: 'hips', size: [0.190, 0.100, 0.120], centre: [0, 0.512, 0] },
    { name: 'arm-left', size: [0.062, 0.310, 0.062], centre: [-0.138, 0.680, 0] },
    { name: 'arm-right', size: [0.062, 0.310, 0.062], centre: [0.138, 0.680, 0] },
    { name: 'leg-left', size: [0.080, 0.462, 0.080], centre: [-0.052, 0.231, 0] },
    { name: 'leg-right', size: [0.080, 0.462, 0.080], centre: [0.052, 0.231, 0] },
];

const PRIMITIVES = {
    human: {
        id: 'human', label: 'Standing figure', defaultSizeM: [0.5, 1.7, 0.3],
        note: 'Eyeline sits just below the top of the head; framing solves against total height.',
    },
    cube: { id: 'cube', label: 'Box', defaultSizeM: [1, 1, 1], note: 'A table, a car, a doorway — whatever has to be in the way.' },
    sphere: { id: 'sphere', label: 'Sphere', defaultSizeM: [1, 1, 1], segments: 12, note: 'Sized by its bounding box, so a sphere and a cube of the same size match.' },

    /**
     * A generated image standing in the scene as a card — cutout previs, the
     * oldest trick in the discipline. Worth more here than in most tools
     * because the images already exist: storyboard keyframes, character
     * reference sheets and reference images all come off the pipeline, so the
     * person in the previs can be the person in the render.
     *
     * FIXED in world space, not a billboard. A card that always turns to face
     * the camera stays readable from every angle, which is exactly what makes
     * it lie about a 360 move — it never goes edge-on, so a flat stand-in reads
     * as a solid subject. Foreshortening is the honest behaviour.
     */
    imageplane: {
        id: 'imageplane', label: 'Image card', defaultSizeM: [1.0, 1.7, 0.02],
        acceptsImage: true,
        note: 'A generated image as a standing card. Flat on purpose: it goes edge-on as you orbit, which is the truth about a cutout.',
    },

    /**
     * A generated .glb, staged as real geometry.
     *
     * The card above is a cutout and goes edge-on; this is the thing itself, so
     * a director can orbit a character and see the silhouette change. Drawn as
     * a wireframe by the same projection everything else uses — previs is
     * grey-box, and what is being judged is where the subject stands and how it
     * reads in frame, which a silhouette answers completely. Materials and
     * textures are deliberately not loaded: they would change how it looks and
     * not what it tells you.
     *
     * defaultSizeM is a placeholder; a loaded mesh is scaled to its own bounds
     * so a two-metre dragon stages as two metres.
     */
    mesh: {
        id: 'mesh', label: '3D model', defaultSizeM: [1.0, 1.8, 1.0],
        acceptsModel: true,
        note: 'A generated .glb staged as geometry. Wireframe, no textures: previs judges placement and silhouette, not surface.',
    },
};

const D2R = Math.PI / 180;

/**
 * Rotate an offset by [yaw, pitch, roll] degrees.
 *
 * Roll first, then pitch, then yaw — so roll acts in the object's own plane.
 * That ordering is what makes rolling an image card ninety degrees turn a
 * portrait into a widescreen rather than tipping it over sideways: the card
 * spins in the plane it faces, exactly as a photograph does in a frame.
 *
 * Applied to offsets from the object's own base, never to world coordinates, so
 * turning a dial cannot fling a distant object across the stage.
 */
function rotateOffset([x, y, z], rotationDeg) {
    if (!rotationDeg) return [x, y, z];
    const [yaw = 0, pitch = 0, roll = 0] = rotationDeg;
    if (!yaw && !pitch && !roll) return [x, y, z];

    let p = [x, y, z];
    if (roll) {
        const c = Math.cos(roll * D2R);
        const s = Math.sin(roll * D2R);
        p = [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]];
    }
    if (pitch) {
        const c = Math.cos(pitch * D2R);
        const s = Math.sin(pitch * D2R);
        p = [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c];
    }
    if (yaw) {
        const c = Math.cos(yaw * D2R);
        const s = Math.sin(yaw * D2R);
        p = [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c];
    }
    return p;
}

/** Turn a finished geometry about the object's base point. */
function applyRotation(geo, position, rotationDeg) {
    if (!rotationDeg || rotationDeg.every(v => !v)) return geo;
    return {
        ...geo,
        vertices: geo.vertices.map(v => {
            const spun = rotateOffset([v[0] - position[0], v[1] - position[1], v[2] - position[2]], rotationDeg);
            return [spun[0] + position[0], spun[1] + position[1], spun[2] + position[2]];
        }),
    };
}

/** A box as 8 vertices and 12 edges, centred on `centre`. */
function boxGeometry(centre, size, offset) {
    const [cx, cy, cz] = centre;
    const [w, h, d] = size.map(v => v / 2);
    const o = offset || [0, 0, 0];

    const vertices = [
        [-w, -h, -d], [w, -h, -d], [w, -h, d], [-w, -h, d],
        [-w, h, -d], [w, h, -d], [w, h, d], [-w, h, d],
    ].map(([x, y, z]) => [x + cx + o[0], y + cy + o[1], z + cz + o[2]]);

    const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    return { vertices, edges };
}

/**
 * A sphere as latitude/longitude rings.
 *
 * Wireframe rather than shaded: previs is about where things are, and a solid
 * grey ball hides the ground plane behind it without adding information.
 */
function sphereGeometry(centre, radius, segments) {
    const rings = Math.max(3, Math.floor(segments / 2));
    const cols = Math.max(4, segments);
    const vertices = [];
    const edges = [];

    for (let i = 0; i <= rings; i++) {
        const phi = Math.PI * (i / rings) - Math.PI / 2;
        for (let j = 0; j < cols; j++) {
            const theta = 2 * Math.PI * (j / cols);
            vertices.push([
                centre[0] + radius * Math.cos(phi) * Math.cos(theta),
                centre[1] + radius * Math.sin(phi),
                centre[2] + radius * Math.cos(phi) * Math.sin(theta),
            ]);
        }
    }
    const at = (i, j) => i * cols + (j % cols);
    for (let i = 0; i <= rings; i++) {
        for (let j = 0; j < cols; j++) {
            edges.push([at(i, j), at(i, j + 1)]);
            if (i < rings) edges.push([at(i, j), at(i + 1, j)]);
        }
    }
    return { vertices, edges };
}

/** The figure's parts at a given height, in metres. */
function humanProxy(heightM) {
    const h = heightM > 0 ? heightM : PRIMITIVES.human.defaultSizeM[1];
    return HUMAN_PARTS.map(part => ({
        name: part.name,
        sizeM: part.size.map(v => v * h),
        centreM: part.centre.map(v => v * h),
    }));
}

/**
 * Geometry for one staged object.
 *
 * @param {object} object  { kind, position:[x,y,z], sizeM?:[w,h,d] }
 * @returns {{ vertices: number[][], edges: number[][], parts?: object[] }}
 */
function primitiveGeometry(object) {
    const kind = object && object.kind;
    const spec = PRIMITIVES[kind];
    if (!spec) {
        throw new Error(`previs: unknown primitive '${kind}' (known: ${Object.keys(PRIMITIVES).join(', ')})`);
    }

    const position = (object.position || [0, 0, 0]).slice();
    const size = (object.sizeM && object.sizeM.length === 3) ? object.sizeM : spec.defaultSizeM;

    if (kind === 'human') {
        // Assembled from its parts so the figure is one object to place and
        // several to draw. Its feet sit on `position`, not its centre: a person
        // stands on the floor, and centring would half-bury them.
        const parts = humanProxy(size[1]);
        const vertices = [];
        const edges = [];
        for (const part of parts) {
            const geo = boxGeometry(part.centreM, part.sizeM, position);
            const base = vertices.length;
            vertices.push(...geo.vertices);
            edges.push(...geo.edges.map(([a, b]) => [a + base, b + base]));
        }
        return applyRotation({ vertices, edges, parts }, position, object.rotationDeg);
    }

    if (kind === 'imageplane') {
        // Four corners, in a stated order — top-left, top-right, bottom-right,
        // bottom-left — because drawing the image means mapping it onto this
        // quad, and a texture map needs to know which corner is which.
        const halfW = size[0] / 2;
        const h = size[1];
        const [px, py, pz] = position;
        // Rotated about the card's own centre, so rolling it spins the picture
        // in place rather than swinging it around its feet.
        const centre = [px, py + h / 2, pz];
        return applyRotation({
            vertices: [
                [px - halfW, py + h, pz], [px + halfW, py + h, pz],
                [px + halfW, py, pz], [px - halfW, py, pz],
            ],
            edges: [[0, 1], [1, 2], [2, 3], [3, 0]],
        }, centre, object.rotationDeg);
    }

    if (kind === 'sphere') {
        const radius = size[1] / 2;
        // A sphere looks the same turned, but its geometry still rotates so a
        // pick box built from it agrees with what is drawn.
        return applyRotation(sphereGeometry([position[0], position[1] + radius, position[2]], radius, spec.segments || 12),
            position, object.rotationDeg);
    }

    // A box also sits ON the floor, for the same reason.
    return applyRotation(boxGeometry([0, size[1] / 2, 0], size, position), position, object.rotationDeg);
}

module.exports = { PRIMITIVES, HUMAN_PARTS, humanProxy, primitiveGeometry, boxGeometry, sphereGeometry, rotateOffset, applyRotation };
