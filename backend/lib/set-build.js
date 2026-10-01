/**
 * A location's set, built in Blender from its own plates.
 *
 * "The Blender build, done automatically: we might remove the Marble process
 * since Blender is free to do."
 *
 * The work splits exactly where this engine always splits it. Reading a
 * photograph of a diner and saying "the counter runs down the left, eleven
 * metres, stools every seventy centimetres" is judgement, and the connected
 * agent IS the model (no tool here calls a server-side LLM). Everything after
 * that judgement is mechanical and belongs to the engine:
 *
 *   brief    the plates, the location's own words, the layout vocabulary and
 *            the conventions: everything the agent needs, for nothing
 *   render   the layout validated, built headless in Blender and rendered from
 *            every plate camera, each beside its plate and blended over it, so
 *            the agent LOOKS at where it is wrong rather than guessing
 *   finish   the set built again with every surface camera-projected from the
 *            plate that sees it, exported as a GLB, made the next version of
 *            the location's world (created if it has none), and registered as
 *            a 3D model asset
 *
 * Every step is free: Blender runs on this machine and bills nothing. An
 * attempt is a row that is never overwritten, because the second layout is
 * written from what the first got wrong.
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

function db() { return require('../db/database').db; }

// ── Blender, probed and never bundled ───────────────────────────────────────

const BLENDER_CANDIDATES = [
    '/Applications/Blender.app/Contents/MacOS/Blender',
    '/usr/bin/blender', '/usr/local/bin/blender', '/opt/homebrew/bin/blender', '/snap/bin/blender',
];
let BLENDER_CACHE = null;

/**
 * Where Blender is, or why it is not. Cached on the AVAILABLE answer only, on
 * the rule resolveFfmpeg follows: an operator who installs Blender mid-session
 * should not be told for the life of the process that there is none.
 */
function resolveBlender() {
    if (BLENDER_CACHE) return BLENDER_CACHE;
    const tried = [process.env.BLENDER_PATH, ...BLENDER_CANDIDATES].filter(Boolean);
    for (const bin of tried) {
        try {
            if (!fs.existsSync(bin)) continue;
            const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
            const m = /Blender\s+(\d+\.\d+(?:\.\d+)?)/.exec(r.stdout || '');
            if (r.status === 0 && m) {
                BLENDER_CACHE = { available: true, bin, version: m[1],
                    source: bin === process.env.BLENDER_PATH ? 'BLENDER_PATH' : 'installed' };
                return BLENDER_CACHE;
            }
        } catch (_) { /* next candidate */ }
    }
    return { available: false, bin: null,
        reason: `Blender was not found (looked at ${tried.join(', ')}). Install it from blender.org, or set BLENDER_PATH.` };
}

const SCRIPT = path.join(__dirname, '..', 'blender-set.py');

// ── the layout vocabulary ───────────────────────────────────────────────────

const SHAPES = Object.freeze(['box', 'cylinder', 'sphere', 'asset']);
// How a finished set looks. 'clean' is the previz default: every surface one
// flat colour, SAMPLED from the plates where a plate sees it, so the set reads
// as that place from every angle without the smear a projection leaves on any
// angle the photographs did not take. 'painted' projects the plates on.
const STYLES = Object.freeze(['clean', 'painted']);
const TIMES_OF_DAY = Object.freeze(['morning', 'midday', 'afternoon', 'evening', 'night']);
const WALL_SIDES = Object.freeze(['north', 'south', 'east', 'west']);
const OPENING_KINDS = Object.freeze(['window', 'door', 'gap']);
// The parts of a layout that make up the BUILDING. A single room is one; a
// house with split levels is walls anywhere, floors at every level and the
// stairs between them. At least one must be present.
const STRUCTURE = Object.freeze(['room', 'walls', 'slabs', 'stairs']);
const LIMITS = Object.freeze({ room_m: [1, 200], height_m: [1.5, 40], objects: 3000, lens_mm: [8, 300] });

/**
 * The schema the brief hands over, and the validator reads. One statement, so
 * the vocabulary the agent is told and the vocabulary the engine accepts
 * cannot drift apart.
 */
const LAYOUT_SCHEMA = Object.freeze({
    units: 'metres. Blender axes: x east, y north, z up. The floor is z = 0.',
    room: 'OPTIONAL, one box-shaped room: { x0, x1, y0, y1, height, wall_color, ceiling_color, ceiling (bool, default true), '
        + "open_walls: [side], floor: { pattern: 'plain'|'checker', colors: ['#hex', '#hex'], tile } }",
    walls: '[{ name, from: [x, y], to: [x, y], z0 (the floor it stands on, default 0), height, thickness (default 0.12), '
        + 'color, openings: [{ kind: window|door|gap, at (metres from `from` to the opening\'s near edge), width, sill, top, mullions }] }] '
        + '(for anything that is not one box-shaped room: interior walls, split levels, L-shaped plans)',
    slabs: '[{ name, x0, x1, y0, y1, z (the TOP of the floor), thickness (default 0.2), color, '
        + "pattern: 'plain'|'checker', colors, tile }] (a floor or ceiling at any level; leave a gap where a stair comes up)",
    light: `{ time_of_day: ${TIMES_OF_DAY.join('|')}, sun_from: north|south|east|west (the side the sun comes in from) }`,
    assets: 'An object with shape: asset is a model placed at real size: `asset` names an entry of the Previs library '
        + '(GET /film/previs-library: 140 low-poly furniture pieces and four people) or `asset_id` names one of this '
        + 'project\'s 3D models. `at` is where its base centre stands, `yaw` which way it faces (0 north), and `size` '
        + '[width, depth, height] fits it to what you measured (default: its library size).',
    stairs: '[{ name, at: [x, y, z] (the bottom of the first step, centre of its front edge), yaw (the direction you '
        + 'climb: 0 north, 90 west, 180 south, -90 east), width, rise (total height), run (total length), steps, color }]',
    openings: `[{ wall: ${WALL_SIDES.join('|')}, kind: ${OPENING_KINDS.join('|')}, from, to (along the wall, `
        + 'in that axis\'s own coordinate: x for north/south, y for east/west), sill, top, mullions, frame_color, glass_color }]',
    objects: `[{ name, shape: ${SHAPES.join('|')}, at: [x, y, z] (the BASE centre: z is where it stands), `
        + 'size: [width_x, depth_y, height_z] for a box, radius + height for a cylinder, radius for a sphere, '
        + "yaw (box only, degrees), color: '#hex', rough, metal, repeat: { count, step: [dx, dy, dz] } }]",
    cameras: '[{ plate: the plate view it stands for, position: [x, y, z], yaw (degrees; 0 looks north, '
        + '90 looks west, 180 south, -90 east), pitch (degrees, negative looks down), roll, lens (mm on a 36mm-wide sensor), '
        + 'rotation (optional 3x3 camera-to-world matrix, rows, Blender camera axes: it replaces yaw/pitch/roll when a '
        + 'camera was solved from video rather than placed by eye) }]',
});

const HEX = /^#[0-9a-f]{6}$/i;
const PT2 = v => Array.isArray(v) && v.length === 2 && v.every(n => typeof n === 'number' && Number.isFinite(n));
const num = v => typeof v === 'number' && Number.isFinite(v);

/**
 * Refuse a layout Blender would build wrongly, naming the field. Returns the
 * errors; an empty list means it may be built. `plateViews` is the set of
 * plates this location has, because a camera for a plate that does not exist
 * is a render with nothing to hold it against.
 */
function validateLayout(layout, plateViews, opts = {}) {
    const errors = [];
    const L = layout || {};
    if (!STRUCTURE.some(k => k === 'room' ? L.room : (Array.isArray(L[k]) && L[k].length))) {
        return [`a layout needs a building: at least one of ${STRUCTURE.join(', ')}`];
    }
    const R = L.room || null;
    if (R) for (const k of ['x0', 'x1', 'y0', 'y1', 'height']) if (!num(R[k])) errors.push(`room.${k} must be a number`);
    if (R && !errors.length) {
        const w = R.x1 - R.x0, d = R.y1 - R.y0;
        if (w < LIMITS.room_m[0] || w > LIMITS.room_m[1]) errors.push(`room width (x1 - x0 = ${w}) must be ${LIMITS.room_m.join('–')} m`);
        if (d < LIMITS.room_m[0] || d > LIMITS.room_m[1]) errors.push(`room depth (y1 - y0 = ${d}) must be ${LIMITS.room_m.join('–')} m`);
        if (R.height < LIMITS.height_m[0] || R.height > LIMITS.height_m[1]) errors.push(`room.height must be ${LIMITS.height_m.join('–')} m`);
    }
    if (R) for (const k of ['wall_color', 'ceiling_color']) if (R[k] != null && !HEX.test(R[k])) errors.push(`room.${k} must be #rrggbb`);
    if (R && R.floor) {
        const cols = R.floor.colors || (R.floor.color ? [R.floor.color] : []);
        cols.forEach((c, i) => { if (!HEX.test(c)) errors.push(`room.floor.colors[${i}] must be #rrggbb`); });
        if (R.floor.pattern && !['plain', 'checker'].includes(R.floor.pattern)) errors.push("room.floor.pattern must be 'plain' or 'checker'");
        if (R.floor.pattern === 'checker' && !(num(R.floor.tile) && R.floor.tile >= 0.05)) errors.push('a checker floor needs room.floor.tile of at least 0.05 m');
    }
    ((R && R.open_walls) || []).forEach(s => { if (!WALL_SIDES.includes(s)) errors.push(`room.open_walls: '${s}' is not a wall`); });

    (L.openings || []).forEach((o, i) => {
        const at = `openings[${i}]`;
        if (!WALL_SIDES.includes(o.wall)) errors.push(`${at}.wall must be one of ${WALL_SIDES.join(', ')}`);
        if (!OPENING_KINDS.includes(o.kind)) errors.push(`${at}.kind must be one of ${OPENING_KINDS.join(', ')}`);
        if (!num(o.from) || !num(o.to) || o.to <= o.from) errors.push(`${at} needs from < to`);
        if (o.sill != null && !num(o.sill)) errors.push(`${at}.sill must be a number`);
        if (o.top != null && !num(o.top)) errors.push(`${at}.top must be a number`);
        if (num(o.sill) && num(o.top) && o.top <= o.sill) errors.push(`${at}.top must be above its sill`);
    });

    if ((L.openings || []).length && !R) errors.push('openings belong to a room; with walls, put each opening on its wall');

    (L.walls || []).forEach((w, i) => {
        const at = `walls[${i}]${w && w.name ? ` (${w.name})` : ''}`;
        if (!PT2(w.from) || !PT2(w.to)) { errors.push(`${at} needs from and to as [x, y]`); return; }
        const len = Math.hypot(w.to[0] - w.from[0], w.to[1] - w.from[1]);
        if (len < 0.05) errors.push(`${at} is shorter than 5 cm`);
        if (!(num(w.height) && w.height > 0 && w.height <= LIMITS.height_m[1])) errors.push(`${at}.height must be above 0`);
        if (w.z0 != null && !num(w.z0)) errors.push(`${at}.z0 must be a number`);
        if (w.thickness != null && !(num(w.thickness) && w.thickness > 0 && w.thickness < 2)) errors.push(`${at}.thickness must be 0–2 m`);
        if (w.color != null && !HEX.test(w.color)) errors.push(`${at}.color must be #rrggbb`);
        (w.openings || []).forEach((o, j) => {
            const oa = `${at}.openings[${j}]`;
            if (!OPENING_KINDS.includes(o.kind)) errors.push(`${oa}.kind must be one of ${OPENING_KINDS.join(', ')}`);
            if (!(num(o.at) && o.at >= 0 && num(o.width) && o.width > 0 && o.at + o.width <= len + 1e-6)) {
                errors.push(`${oa} must sit inside the wall: 0 ≤ at, at + width ≤ ${len.toFixed(2)} m`);
            }
            if (num(o.sill) && num(o.top) && o.top <= o.sill) errors.push(`${oa}.top must be above its sill`);
            if (num(o.top) && o.top > w.height + 1e-6) errors.push(`${oa}.top is above the wall`);
        });
    });
    (L.slabs || []).forEach((sl, i) => {
        const at = `slabs[${i}]${sl && sl.name ? ` (${sl.name})` : ''}`;
        for (const k of ['x0', 'x1', 'y0', 'y1', 'z']) if (!num(sl[k])) errors.push(`${at}.${k} must be a number`);
        if (num(sl.x0) && num(sl.x1) && sl.x1 <= sl.x0) errors.push(`${at} needs x0 < x1`);
        if (num(sl.y0) && num(sl.y1) && sl.y1 <= sl.y0) errors.push(`${at} needs y0 < y1`);
        if (sl.color != null && !HEX.test(sl.color)) errors.push(`${at}.color must be #rrggbb`);
        (sl.colors || []).forEach((c, j) => { if (!HEX.test(c)) errors.push(`${at}.colors[${j}] must be #rrggbb`); });
        if (sl.pattern === 'checker' && !(num(sl.tile) && sl.tile >= 0.05)) errors.push(`${at}: a checker slab needs tile of at least 0.05 m`);
    });
    (L.stairs || []).forEach((st, i) => {
        const at = `stairs[${i}]${st && st.name ? ` (${st.name})` : ''}`;
        if (!Array.isArray(st.at) || st.at.length !== 3 || !st.at.every(num)) errors.push(`${at}.at must be [x, y, z]`);
        for (const k of ['width', 'rise', 'run']) if (!(num(st[k]) && st[k] > 0)) errors.push(`${at}.${k} must be above 0`);
        if (!(Number.isInteger(st.steps) && st.steps >= 1 && st.steps <= 60)) errors.push(`${at}.steps must be a whole number 1–60`);
        if (st.yaw != null && !num(st.yaw)) errors.push(`${at}.yaw must be degrees`);
        if (st.color != null && !HEX.test(st.color)) errors.push(`${at}.color must be #rrggbb`);
    });

    let expanded = 0;
    (L.objects || []).forEach((o, i) => {
        const at = `objects[${i}]${o && o.name ? ` (${o.name})` : ''}`;
        if (!o || !o.name) errors.push(`objects[${i}] needs a name`);
        if (!SHAPES.includes(o && o.shape)) errors.push(`${at}.shape must be one of ${SHAPES.join(', ')}`);
        if (!Array.isArray(o.at) || o.at.length !== 3 || !o.at.every(num)) errors.push(`${at}.at must be [x, y, z]`);
        if (o.shape === 'box' && !(Array.isArray(o.size) && o.size.length === 3 && o.size.every(v => num(v) && v > 0))) {
            errors.push(`${at}.size must be [width, depth, height], each above 0`);
        }
        if (o.shape === 'asset') {
            if (!o.asset && !o.asset_id) errors.push(`${at} needs asset (a library id) or asset_id (a project 3D model)`);
            else if (o.asset && !require('./previs-library').get(o.asset)) errors.push(`${at}.asset '${o.asset}' is not in the Previs library`);
            if (o.size != null && !(Array.isArray(o.size) && o.size.length === 3 && o.size.every(v => num(v) && v > 0))) {
                errors.push(`${at}.size must be [width, depth, height], each above 0`);
            }
            if (o.yaw != null && !num(o.yaw)) errors.push(`${at}.yaw must be degrees`);
        }
        if (o.shape === 'cylinder' && !(num(o.radius) && o.radius > 0 && num(o.height) && o.height > 0)) errors.push(`${at} needs radius and height above 0`);
        if (o.shape === 'sphere' && !(num(o.radius) && o.radius > 0)) errors.push(`${at} needs a radius above 0`);
        if (o.color != null && !HEX.test(o.color)) errors.push(`${at}.color must be #rrggbb`);
        const count = o.repeat ? o.repeat.count : 1;
        if (o.repeat && !(Number.isInteger(count) && count >= 1 && Array.isArray(o.repeat.step) && o.repeat.step.length === 3 && o.repeat.step.every(num))) {
            errors.push(`${at}.repeat needs an integer count and step [dx, dy, dz]`);
        }
        expanded += Number.isInteger(count) ? count : 1;
    });
    if (expanded > LIMITS.objects) errors.push(`${expanded} objects after repeats; the ceiling is ${LIMITS.objects}`);

    if (L.light != null) {
        if (L.light.time_of_day != null && !TIMES_OF_DAY.includes(L.light.time_of_day)) errors.push(`light.time_of_day must be one of ${TIMES_OF_DAY.join(', ')}`);
        if (L.light.sun_from != null && !WALL_SIDES.includes(L.light.sun_from)) errors.push(`light.sun_from must be one of ${WALL_SIDES.join(', ')}`);
    }
    const cams = L.cameras || [];
    // A MEASURED layout (a LiDAR scan) has no plate to be held against: its
    // geometry is the measurement. Only a layout written from photographs
    // needs a camera per plate.
    if (!cams.length && !opts.measured) errors.push('cameras: at least one plate camera is required, or nothing can be held against a plate');
    const seen = new Set();
    cams.forEach((c, i) => {
        const at = `cameras[${i}]`;
        if (plateViews && !plateViews.includes(c.plate)) errors.push(`${at}.plate '${c.plate}' is not one of this location's plates (${plateViews.join(', ')})`);
        if (seen.has(c.plate)) errors.push(`${at}: plate '${c.plate}' already has a camera`);
        seen.add(c.plate);
        if (!Array.isArray(c.position) || c.position.length !== 3 || !c.position.every(num)) errors.push(`${at}.position must be [x, y, z]`);
        if (c.rotation != null && !(Array.isArray(c.rotation) && c.rotation.length === 3
            && c.rotation.every(r => Array.isArray(r) && r.length === 3 && r.every(num)))) {
            errors.push(`${at}.rotation must be a 3x3 matrix (rows), camera-to-world, Blender camera axes`);
        }
        for (const k of ['yaw', 'pitch', 'roll']) if (c[k] != null && !num(c[k])) errors.push(`${at}.${k} must be degrees`);
        if (c.lens != null && !(num(c.lens) && c.lens >= LIMITS.lens_mm[0] && c.lens <= LIMITS.lens_mm[1])) errors.push(`${at}.lens must be ${LIMITS.lens_mm.join('–')} mm`);
    });
    return errors;
}

// ── the plates ──────────────────────────────────────────────────────────────

/** The location's approved plates, one per view. The default view is called 'default'. */
function platesFor(locationId) {
    const d = db();
    const loc = d.prepare('SELECT * FROM film_locations WHERE id = ?').get(locationId);
    if (!loc) return null;
    const { sendableSql } = require('./subject-gallery');
    const rows = d.prepare(`SELECT id, file_path, file_name, metadata, created_at FROM film_assets
        WHERE location_id = ? AND asset_type = 'reference_image' AND ${sendableSql()}
        ORDER BY created_at DESC`).all(locationId);
    const byView = new Map();
    const { readDimensions } = require('./image-raster');
    for (const r of rows) {
        let meta = {};
        try { meta = JSON.parse(r.metadata || '{}'); } catch (_) { meta = {}; }
        const view = String(meta.view || '').trim() || 'default';
        if (byView.has(view) || !r.file_path || !fs.existsSync(r.file_path)) continue;
        let dims = null;
        try { dims = readDimensions(r.file_path); } catch (_) { dims = null; }
        if (!dims || !dims.width) continue;
        let url = null;
        try {
            const fsx = require('./file-storage');
            const where = fsx.locate(r.file_path);
            if (where) url = fsx.getFileUrl(where.subdir, loc.project_id, r.file_name, r.created_at);
        } catch (_) { url = null; }
        byView.set(view, { view, asset_id: r.id, path: r.file_path, width: dims.width, height: dims.height, url });
    }
    return { location: loc, plates: [...byView.values()] };
}

function fileDataUri(p) {
    const ext = path.extname(p).toLowerCase();
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
    return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
}

// ── the brief ───────────────────────────────────────────────────────────────

const INSTRUCTIONS = [
    'Read every plate and the location\'s own words. Decide the room\'s size in metres from things of known size '
        + '(a door is about 2.1 m tall, a counter about 1.05 m, a stool seat about 0.75 m, a person about 1.7 m).',
    'If the brief carries a scan_base, START FROM IT: its walls, openings, slabs, stairs and cameras were measured '
        + 'by LiDAR and the phone, so keep them exactly and do not move a camera. Your job is everything the scan '
        + 'reduced to a box or missed: add it to the scan_base\'s objects (replace a scanned box with its proper '
        + 'pieces where you can see them).',
    'INVENTORY FIRST. Before writing any layout, list for every plate each thing a camera could frame against: '
        + 'furniture, fixtures, counters, shelves and what stands on them, lamps and pendant lights, signs, menus, '
        + 'pictures and posters, window frames and blinds, appliances, plants, bins, coat hooks, rails, radiators, '
        + 'ceiling beams and vents, anything on the floor. A previz set that holds only the big furniture is the '
        + 'failure this step exists to prevent: aim to represent all, or nearly all, of what is in the photographs.',
    'Build each thing from its parts, not one block: a booth is a seat, a back and its table; a counter is a base, a '
        + 'top and a foot rail; a shelf unit is its sides and each shelf; a stool is a seat on a post; a window has its '
        + 'frame and mullions. Use library models (shape: asset) where one fits at the measured size, and boxes, '
        + 'cylinders and spheres for the rest. Use repeat for rows (stools, lights, tiles of a sign).',
    'Shapes and flat colours only, never textures: give each object the colour it reads as in the plates. The '
        + 'point is that every object is THERE, at its size and place, so a shot can be blocked and framed against it.',
    'Write ONE layout: the building, its openings, every object from the inventory, and one camera per plate placed '
        + 'where that photograph was taken from (unless the scan_base already measured it). Every comparison is only '
        + 'as good as the camera it is rendered from.',
    'Call set_build_render. Look at each sheet: the plate, your render, and the two blended. Where an edge in your '
        + 'render does not sit on the same edge in the plate, fix the camera first (unless measured), then the '
        + 'geometry. Then go down your inventory against each sheet and add whatever is still missing. Render again; '
        + 'three or four attempts is normal for a detailed set.',
    'When the blends line up and the inventory is in, call set_build_finish with that attempt. It makes the set the '
        + 'next version of the location\'s world (clean: flat colours sampled from the plates) and keeps it as a 3D model.',
    'Leave out only what you genuinely cannot place from any plate; a surface nobody photographed keeps its plain colour.',
];

/** The newest attempt built from a LiDAR scan, as the base for a detail pass, or null. */
function scanBase(locationId) {
    const rows = db().prepare('SELECT id, attempt, layout_json, note FROM film_set_builds WHERE location_id = ? '
        + "AND status != 'failed' ORDER BY attempt DESC").all(locationId);
    for (const r of rows) {
        let L = null;
        try { L = JSON.parse(r.layout_json); } catch (_) { L = null; }
        if (L && L.source === 'lidar-scan') {
            return { attempt_id: r.id, attempt: r.attempt, note: r.note, layout: L,
                keep: 'walls, openings, slabs, stairs and cameras are measured: keep them exactly; add to objects' };
        }
    }
    return null;
}

function brief(locationId, opts = {}) {
    const found = platesFor(locationId);
    if (!found) return null;
    const { location, plates } = found;
    let sections = {};
    let orientation = {};
    try { sections = JSON.parse(location.description_sections || '{}'); } catch (_) { sections = {}; }
    try { orientation = JSON.parse(location.orientation_plan || '{}'); } catch (_) { orientation = {}; }
    const last = db().prepare('SELECT * FROM film_set_builds WHERE location_id = ? ORDER BY attempt DESC LIMIT 1').get(locationId);
    return {
        location: { id: location.id, name: location.name, description: location.description || '',
            sections, orientation_plan: orientation },
        plates: plates.map(p => ({ view: p.view, width: p.width, height: p.height, url: p.url })),
        blender: resolveBlender(),
        schema: LAYOUT_SCHEMA,
        limits: LIMITS,
        instructions: INSTRUCTIONS,
        // What can be placed as shape: asset, at its real size.
        library: require('./previs-library').list().map(e => ({ id: e.id, category: e.category, size_m: e.size_m })),
        last_attempt: last ? { id: last.id, attempt: last.attempt, status: last.status,
            layout: JSON.parse(last.layout_json) } : null,
        // The LiDAR scan, when there is one: measured walls, openings, floors,
        // stairs and photo cameras to build the details on.
        scan_base: scanBase(locationId),
        cost: 'Free. Blender runs on this machine.',
        warnings: plates.length ? [] : ['This location has no plates. Generate or upload one before building a set.'],
        // The pictures themselves, for an agent that has to LOOK at them.
        ...(opts.withImages ? { images: plates.map(p => ({ data_uri: fileDataUri(p.path), label: `plate: ${p.view}` })) } : {}),
    };
}

/**
 * Every asset object resolved to a file and a size, for the job. A project 3D
 * model must belong to the project and exist on disk; its default size is its
 * own, read from the file, since a generated mesh has no library size.
 */
function resolveAssets(layout, projectId) {
    const lib = require('./previs-library');
    const out = {};
    const errors = [];
    (layout.objects || []).forEach((o, i) => {
        if (o.shape !== 'asset') return;
        const key = o.asset ? `lib:${o.asset}` : `model:${o.asset_id}`;
        if (out[key]) return;
        if (o.asset) {
            const e = lib.get(o.asset);
            out[key] = { path: e.file, size: e.size_m, y_up: true };
            return;
        }
        const row = db().prepare('SELECT * FROM film_assets WHERE id = ? AND project_id = ?').get(o.asset_id, projectId);
        let kind = null;
        try { kind = row && JSON.parse(row.metadata || '{}').kind; } catch (_) { kind = null; }
        if (!row || !/^model_/.test(kind || '') || !row.file_path || !fs.existsSync(row.file_path)) {
            errors.push(`objects[${i}].asset_id '${o.asset_id}' is not one of this project's 3D models on disk`);
            return;
        }
        let size = null;
        try {
            const g = require('./glb-parser').parseGlb(fs.readFileSync(row.file_path));
            size = [g.size[0], g.size[2], g.size[1]];
        } catch (err) { errors.push(`objects[${i}]: that 3D model cannot be read (${err.message})`); return; }
        out[key] = { path: row.file_path, size, y_up: true };
    });
    return { assets: out, errors };
}

// ── running Blender ─────────────────────────────────────────────────────────

function runBlender(job, timeoutMs) {
    const blender = resolveBlender();
    if (!blender.available) {
        const e = new Error(blender.reason);
        e.code = 'NO_BLENDER';
        return Promise.reject(e);
    }
    fs.mkdirSync(job.out_dir, { recursive: true });
    const jobPath = path.join(job.out_dir, `job_${job.mode}.json`);
    fs.writeFileSync(jobPath, JSON.stringify(job));
    return new Promise((resolve, reject) => {
        const child = spawn(blender.bin, ['-b', '--factory-startup', '--python', SCRIPT, '--', jobPath],
            { stdio: ['ignore', 'pipe', 'pipe'] });
        let log = '';
        child.stdout.on('data', b => { log += b; if (log.length > 400000) log = log.slice(-200000); });
        child.stderr.on('data', b => { log += b; });
        const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs || 240000);
        child.on('close', code => {
            clearTimeout(timer);
            const resultPath = path.join(job.out_dir, `result_${job.mode}.json`);
            // The answer is the file the script wrote, not the exit code: Blender
            // can finish the work and then crash unloading an add-on.
            if (/SET-BUILD-DONE/.test(log) && fs.existsSync(resultPath)) {
                return resolve(JSON.parse(fs.readFileSync(resultPath, 'utf8')));
            }
            const tail = log.split('\n').filter(l => /Error|Traceback|line \d+/.test(l)).slice(-8).join('\n');
            const e = new Error(`Blender did not finish the ${job.mode} (exit ${code}). ${tail || log.slice(-800)}`);
            e.code = 'BLENDER_FAILED';
            reject(e);
        });
    });
}

/** plate | render on top, the two blended beneath, at half size. */
function compareSheet(platePath, renderPath, outPath) {
    const { resolveFfmpeg } = require('./ffmpeg');
    const ff = resolveFfmpeg();
    if (!ff.available) return null;
    const r = spawnSync(ff.bin, ['-nostdin', '-loglevel', 'error', '-y', '-i', platePath, '-i', renderPath,
        '-filter_complex',
        '[0:v]scale=688:384,split[p1][p2];[1:v]scale=688:384,split[r1][r2];[p1][r1]hstack[top];'
        + "[p2][r2]blend=all_expr='A*0.5+B*0.5',pad=1376:384:344:0[bot];[top][bot]vstack",
        outPath], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
    return r.status === 0 && fs.existsSync(outPath) ? outPath : null;
}

function buildDir(projectId, buildId) {
    const dir = require('./file-storage').dirFor(projectId, 'worlds');
    return path.join(dir, 'set-builds', buildId);
}

function rowOut(r) {
    if (!r) return null;
    const renders = JSON.parse(r.renders_json || '{}');
    return {
        id: r.id, location_id: r.location_id, attempt: r.attempt, status: r.status, note: r.note,
        error: r.error, layout: JSON.parse(r.layout_json),
        sheets: Object.keys(renders).map(view => ({ view, url: `/film/set-builds/${r.id}/files/compare_${view}.png` })),
        faces: r.faces_json ? JSON.parse(r.faces_json) : null,
        world_version_id: r.world_version_id, asset_id: r.asset_id,
        created_at: r.created_at, finished_at: r.finished_at,
    };
}

function getBuild(id) { return rowOut(db().prepare('SELECT * FROM film_set_builds WHERE id = ?').get(id)); }
function listBuilds(locationId) {
    return db().prepare('SELECT * FROM film_set_builds WHERE location_id = ? ORDER BY attempt DESC').all(locationId).map(rowOut);
}

/**
 * One attempt: validate, build headless, render from every plate camera,
 * compare. A layout that is refused writes nothing; one Blender cannot build
 * is kept as a failed attempt with its reason, because the next layout is
 * written from it.
 */
async function renderAttempt(locationId, layout, opts = {}) {
    const found = platesFor(locationId);
    if (!found) { const e = new Error('Location not found'); e.status = 404; throw e; }
    const { location, plates } = found;
    if (!plates.length) { const e = new Error('This location has no plates to build from.'); e.status = 409; throw e; }
    const errors = validateLayout(layout, plates.map(p => p.view));
    if (errors.length) { const e = new Error(`Layout refused: ${errors[0]}`); e.status = 400; e.errors = errors; throw e; }

    const d = db();
    const { generateId } = require('../db/database');
    const id = generateId();
    const attempt = (d.prepare('SELECT MAX(attempt) a FROM film_set_builds WHERE location_id = ?').get(locationId).a || 0) + 1;
    const outDir = buildDir(location.project_id, id);
    const used = plates.filter(p => layout.cameras.some(c => c.plate === p.view));
    const resolved = resolveAssets(layout, location.project_id);
    if (resolved.errors.length) { const e = new Error(`Layout refused: ${resolved.errors[0]}`); e.status = 400; e.errors = resolved.errors; throw e; }
    d.prepare(`INSERT INTO film_set_builds (id, project_id, location_id, attempt, layout_json, note, status, out_dir)
               VALUES (?, ?, ?, ?, ?, ?, 'rendered', ?)`)
        .run(id, location.project_id, locationId, attempt, JSON.stringify(layout), opts.note || null, outDir);
    try {
        const result = await runBlender({ mode: 'render', layout, out_dir: outDir, plates: used, assets: resolved.assets });
        const renders = {};
        for (const p of used) {
            const r = result.renders[p.view];
            const sheet = r && compareSheet(p.path, r, path.join(outDir, `compare_${p.view}.png`));
            if (sheet) renders[p.view] = { render: r, sheet };
        }
        d.prepare('UPDATE film_set_builds SET renders_json = ? WHERE id = ?').run(JSON.stringify(renders), id);
    } catch (err) {
        d.prepare("UPDATE film_set_builds SET status = 'failed', error = ? WHERE id = ?").run(String(err.message).slice(0, 2000), id);
        const out = getBuild(id);
        out.refused = true;
        return out;
    }
    const out = getBuild(id);
    if (opts.withImages) {
        const renders = JSON.parse(d.prepare('SELECT renders_json FROM film_set_builds WHERE id = ?').get(id).renders_json);
        out.images = Object.entries(renders).map(([view, r]) => ({
            data_uri: fileDataUri(r.sheet), label: `${view}: plate | render, blended below`,
        }));
    }
    return out;
}

/*
 * A MEASURED attempt: a layout from a LiDAR scan rather than from plates. It is
 * validated the same way (bar the plate cameras), recorded as an attempt like
 * any other so it lists beside them, and finished at once — there is nothing
 * to compare a measurement against. Clean style: surfaces keep the layout's
 * colours, since no plate sees them.
 */
async function measuredAttempt(locationId, layout, opts = {}) {
    const d = db();
    const location = d.prepare('SELECT * FROM film_locations WHERE id = ?').get(locationId);
    if (!location) { const e = new Error('Location not found'); e.status = 404; throw e; }
    const L = Object.assign({ cameras: [] }, layout);
    const errors = validateLayout(L, null, { measured: true });
    if (errors.length) { const e = new Error(`Scan refused: ${errors[0]}`); e.status = 400; e.errors = errors; throw e; }
    const resolved = resolveAssets(L, location.project_id);
    if (resolved.errors.length) { const e = new Error(`Scan refused: ${resolved.errors[0]}`); e.status = 400; e.errors = resolved.errors; throw e; }
    const { generateId } = require('../db/database');
    const id = generateId();
    const attempt = (d.prepare('SELECT MAX(attempt) a FROM film_set_builds WHERE location_id = ?').get(locationId).a || 0) + 1;
    const outDir = buildDir(location.project_id, id);
    fs.mkdirSync(outDir, { recursive: true });
    for (const [name, bytes] of Object.entries(opts.files || {})) {
        try { fs.writeFileSync(path.join(outDir, name), bytes); } catch (_) { /* the source is a courtesy copy */ }
    }
    d.prepare(`INSERT INTO film_set_builds (id, project_id, location_id, attempt, layout_json, note, status, out_dir)
               VALUES (?, ?, ?, ?, ?, ?, 'rendered', ?)`)
        .run(id, location.project_id, locationId, attempt, JSON.stringify(L), opts.note || 'measured scan', outDir);
    try {
        // Photos taken in the scan's session are plates with measured cameras:
        // render the scan beside each, so the sheets show what the scan has
        // and the photos have that it does not, before it is finished.
        if (L.cameras.length) {
            const found = platesFor(locationId);
            const used = found.plates.filter(p => L.cameras.some(c => c.plate === p.view));
            if (used.length) {
                const result = await runBlender({ mode: 'render', layout: L, out_dir: outDir, plates: used, assets: resolved.assets });
                const renders = {};
                for (const p of used) {
                    const r = result.renders[p.view];
                    const sheet = r && compareSheet(p.path, r, path.join(outDir, `compare_${p.view}.png`));
                    if (sheet) renders[p.view] = { render: r, sheet };
                }
                d.prepare('UPDATE film_set_builds SET renders_json = ? WHERE id = ?').run(JSON.stringify(renders), id);
            }
        }
        return await finishAttempt(id, { style: 'clean' });
    } catch (err) {
        d.prepare("UPDATE film_set_builds SET status = 'failed', error = ? WHERE id = ?").run(String(err.message).slice(0, 2000), id);
        throw err;
    }
}

/** The world a location's set belongs to, made if it has none. */
function worldForLocation(location) {
    const worlds = require('./worlds');
    const d = db();
    const existing = d.prepare('SELECT * FROM film_worlds WHERE location_id = ? ORDER BY created_at LIMIT 1').get(location.id);
    if (existing) return existing;
    return worlds.createWorld(d, { projectId: location.project_id, locationId: location.id, name: location.name,
        description: 'Built in Blender from the location plates.' });
}

/**
 * Finish an attempt: project the plates onto it, export, and make it the next
 * version of the location's world and a 3D model asset. Only a rendered
 * attempt may finish; a failed one has nothing to project, and finishing twice
 * would put the same set into the world twice.
 */
async function finishAttempt(buildId, opts = {}) {
    const style = opts.style || 'clean';
    if (!STYLES.includes(style)) { const e = new Error(`style must be one of ${STYLES.join(', ')}`); e.status = 400; throw e; }
    const d = db();
    const row = d.prepare('SELECT * FROM film_set_builds WHERE id = ?').get(buildId);
    if (!row) { const e = new Error('Set build not found'); e.status = 404; throw e; }
    if (row.status === 'failed') { const e = new Error('This attempt failed to build; render a new layout first.'); e.status = 409; throw e; }
    if (row.status === 'finished') { const e = new Error('This attempt is already finished.'); e.status = 409; e.build = rowOut(row); throw e; }
    const found = platesFor(row.location_id);
    const layout = JSON.parse(row.layout_json);
    const used = found.plates.filter(p => layout.cameras.some(c => c.plate === p.view));
    const resolved = resolveAssets(layout, row.project_id);
    if (resolved.errors.length) { const e = new Error(resolved.errors[0]); e.status = 409; throw e; }
    const result = await runBlender({ mode: 'export', style, layout, out_dir: row.out_dir, plates: used, assets: resolved.assets });
    const glb = fs.readFileSync(result.glb);

    const world = worldForLocation(found.location);
    const worlds = require('./worlds');
    const version = worlds.importVersion(d, world.id, {
        glb, source: 'blender',
        reason: used.length
            ? `Set build attempt ${row.attempt} (${style}): built in Blender from ${used.map(p => p.view).join(', ')} plates`
            : `Set build attempt ${row.attempt} (${style}): built in Blender from a measured scan${row.note ? ` (${row.note})` : ''}`,
        caption: row.note || null,
    });
    const asset = require('./media-imports').importMedia('three-d-model', {
        projectId: row.project_id,
        name: `${found.location.name} set (attempt ${row.attempt}).glb`,
        data: `data:model/gltf-binary;base64,${glb.toString('base64')}`,
        locationId: row.location_id,
    });
    result.faces = Object.assign({ style }, result.faces || {}, result.palette ? { palette_objects: Object.keys(result.palette).length } : {});
    d.prepare(`UPDATE film_set_builds SET status = 'finished', faces_json = ?, world_version_id = ?, asset_id = ?,
               finished_at = datetime('now') WHERE id = ?`)
        .run(JSON.stringify(result.faces || {}), version.id, asset.asset_id, buildId);
    return Object.assign(getBuild(buildId), {
        world: { id: world.id, name: world.name }, version: { id: version.id, version: version.version,
            size_m: version.size_m, triangles: version.triangles },
        asset: { id: asset.asset_id, url: asset.url },
        next: 'Open Previs on a shot at this location and pin it to the new world version to walk it.',
    });
}

module.exports = {
    resolveBlender, validateLayout, platesFor, brief, renderAttempt, finishAttempt, measuredAttempt, getBuild, listBuilds,
    LAYOUT_SCHEMA, SHAPES, WALL_SIDES, OPENING_KINDS, STRUCTURE, STYLES, TIMES_OF_DAY, LIMITS, INSTRUCTIONS, SCRIPT, resolveAssets,
};
