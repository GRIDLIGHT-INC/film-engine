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

const SHAPES = Object.freeze(['box', 'cylinder', 'sphere']);
const WALL_SIDES = Object.freeze(['north', 'south', 'east', 'west']);
const OPENING_KINDS = Object.freeze(['window', 'door', 'gap']);
const LIMITS = Object.freeze({ room_m: [1, 200], height_m: [1.5, 40], objects: 3000, lens_mm: [8, 300] });

/**
 * The schema the brief hands over, and the validator reads. One statement, so
 * the vocabulary the agent is told and the vocabulary the engine accepts
 * cannot drift apart.
 */
const LAYOUT_SCHEMA = Object.freeze({
    units: 'metres. Blender axes: x east, y north, z up. The floor is z = 0.',
    room: '{ x0, x1, y0, y1, height, wall_color, ceiling_color, ceiling (bool, default true), open_walls: [side], '
        + "floor: { pattern: 'plain'|'checker', colors: ['#hex', '#hex'], tile } }",
    openings: `[{ wall: ${WALL_SIDES.join('|')}, kind: ${OPENING_KINDS.join('|')}, from, to (along the wall, `
        + 'in that axis\'s own coordinate: x for north/south, y for east/west), sill, top, mullions, frame_color, glass_color }]',
    objects: `[{ name, shape: ${SHAPES.join('|')}, at: [x, y, z] (the BASE centre: z is where it stands), `
        + 'size: [width_x, depth_y, height_z] for a box, radius + height for a cylinder, radius for a sphere, '
        + "yaw (box only, degrees), color: '#hex', rough, metal, repeat: { count, step: [dx, dy, dz] } }]",
    cameras: '[{ plate: the plate view it stands for, position: [x, y, z], yaw (degrees; 0 looks north, '
        + '90 looks west, 180 south, -90 east), pitch (degrees, negative looks down), roll, lens (mm on a 36mm-wide sensor) }]',
});

const HEX = /^#[0-9a-f]{6}$/i;
const num = v => typeof v === 'number' && Number.isFinite(v);

/**
 * Refuse a layout Blender would build wrongly, naming the field. Returns the
 * errors; an empty list means it may be built. `plateViews` is the set of
 * plates this location has, because a camera for a plate that does not exist
 * is a render with nothing to hold it against.
 */
function validateLayout(layout, plateViews) {
    const errors = [];
    const L = layout || {};
    const R = L.room;
    if (!R || typeof R !== 'object') return ['room is required'];
    for (const k of ['x0', 'x1', 'y0', 'y1', 'height']) if (!num(R[k])) errors.push(`room.${k} must be a number`);
    if (!errors.length) {
        const w = R.x1 - R.x0, d = R.y1 - R.y0;
        if (w < LIMITS.room_m[0] || w > LIMITS.room_m[1]) errors.push(`room width (x1 - x0 = ${w}) must be ${LIMITS.room_m.join('–')} m`);
        if (d < LIMITS.room_m[0] || d > LIMITS.room_m[1]) errors.push(`room depth (y1 - y0 = ${d}) must be ${LIMITS.room_m.join('–')} m`);
        if (R.height < LIMITS.height_m[0] || R.height > LIMITS.height_m[1]) errors.push(`room.height must be ${LIMITS.height_m.join('–')} m`);
    }
    for (const k of ['wall_color', 'ceiling_color']) if (R[k] != null && !HEX.test(R[k])) errors.push(`room.${k} must be #rrggbb`);
    if (R.floor) {
        const cols = R.floor.colors || (R.floor.color ? [R.floor.color] : []);
        cols.forEach((c, i) => { if (!HEX.test(c)) errors.push(`room.floor.colors[${i}] must be #rrggbb`); });
        if (R.floor.pattern && !['plain', 'checker'].includes(R.floor.pattern)) errors.push("room.floor.pattern must be 'plain' or 'checker'");
        if (R.floor.pattern === 'checker' && !(num(R.floor.tile) && R.floor.tile >= 0.05)) errors.push('a checker floor needs room.floor.tile of at least 0.05 m');
    }
    (R.open_walls || []).forEach(s => { if (!WALL_SIDES.includes(s)) errors.push(`room.open_walls: '${s}' is not a wall`); });

    (L.openings || []).forEach((o, i) => {
        const at = `openings[${i}]`;
        if (!WALL_SIDES.includes(o.wall)) errors.push(`${at}.wall must be one of ${WALL_SIDES.join(', ')}`);
        if (!OPENING_KINDS.includes(o.kind)) errors.push(`${at}.kind must be one of ${OPENING_KINDS.join(', ')}`);
        if (!num(o.from) || !num(o.to) || o.to <= o.from) errors.push(`${at} needs from < to`);
        if (o.sill != null && !num(o.sill)) errors.push(`${at}.sill must be a number`);
        if (o.top != null && !num(o.top)) errors.push(`${at}.top must be a number`);
        if (num(o.sill) && num(o.top) && o.top <= o.sill) errors.push(`${at}.top must be above its sill`);
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

    const cams = L.cameras || [];
    if (!cams.length) errors.push('cameras: at least one plate camera is required, or nothing can be held against a plate');
    const seen = new Set();
    cams.forEach((c, i) => {
        const at = `cameras[${i}]`;
        if (plateViews && !plateViews.includes(c.plate)) errors.push(`${at}.plate '${c.plate}' is not one of this location's plates (${plateViews.join(', ')})`);
        if (seen.has(c.plate)) errors.push(`${at}: plate '${c.plate}' already has a camera`);
        seen.add(c.plate);
        if (!Array.isArray(c.position) || c.position.length !== 3 || !c.position.every(num)) errors.push(`${at}.position must be [x, y, z]`);
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
    'Write ONE layout: the room, its openings, every object that reads in the plates, and one camera per plate '
        + 'placed where that photograph was taken from. The cameras matter most: every comparison is only as '
        + 'good as the camera it is rendered from.',
    'Call set_build_render. Look at each sheet: the plate, your render, and the two blended. Where an edge in '
        + 'your render does not sit on the same edge in the plate, move the camera first (position, yaw, '
        + 'pitch, lens), then the geometry. Render again. Two or three attempts is normal.',
    'When the blends line up, call set_build_finish with that attempt. It projects the plates onto the set, '
        + 'makes it the next version of the location\'s world, and keeps it as a 3D model asset.',
    'Model only what a camera will see and a shot will be framed against. Anything you cannot place from the '
        + 'plates is better left out than guessed: a surface nobody photographed stays its plain colour.',
];

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
        last_attempt: last ? { id: last.id, attempt: last.attempt, status: last.status,
            layout: JSON.parse(last.layout_json) } : null,
        cost: 'Free. Blender runs on this machine.',
        warnings: plates.length ? [] : ['This location has no plates. Generate or upload one before building a set.'],
        // The pictures themselves, for an agent that has to LOOK at them.
        ...(opts.withImages ? { images: plates.map(p => ({ data_uri: fileDataUri(p.path), label: `plate: ${p.view}` })) } : {}),
    };
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
    d.prepare(`INSERT INTO film_set_builds (id, project_id, location_id, attempt, layout_json, note, status, out_dir)
               VALUES (?, ?, ?, ?, ?, ?, 'rendered', ?)`)
        .run(id, location.project_id, locationId, attempt, JSON.stringify(layout), opts.note || null, outDir);
    try {
        const result = await runBlender({ mode: 'render', layout, out_dir: outDir, plates: used });
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
async function finishAttempt(buildId) {
    const d = db();
    const row = d.prepare('SELECT * FROM film_set_builds WHERE id = ?').get(buildId);
    if (!row) { const e = new Error('Set build not found'); e.status = 404; throw e; }
    if (row.status === 'failed') { const e = new Error('This attempt failed to build; render a new layout first.'); e.status = 409; throw e; }
    if (row.status === 'finished') { const e = new Error('This attempt is already finished.'); e.status = 409; e.build = rowOut(row); throw e; }
    const found = platesFor(row.location_id);
    const layout = JSON.parse(row.layout_json);
    const used = found.plates.filter(p => layout.cameras.some(c => c.plate === p.view));
    const result = await runBlender({ mode: 'export', layout, out_dir: row.out_dir, plates: used });
    const glb = fs.readFileSync(result.glb);

    const world = worldForLocation(found.location);
    const worlds = require('./worlds');
    const version = worlds.importVersion(d, world.id, {
        glb, source: 'blender',
        reason: `Set build attempt ${row.attempt}: built in Blender from ${used.map(p => p.view).join(', ')} plates`,
        caption: row.note || null,
    });
    const asset = require('./media-imports').importMedia('three-d-model', {
        projectId: row.project_id,
        name: `${found.location.name} set (attempt ${row.attempt}).glb`,
        data: `data:model/gltf-binary;base64,${glb.toString('base64')}`,
        locationId: row.location_id,
    });
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
    resolveBlender, validateLayout, platesFor, brief, renderAttempt, finishAttempt, getBuild, listBuilds,
    LAYOUT_SCHEMA, SHAPES, WALL_SIDES, OPENING_KINDS, LIMITS, INSTRUCTIONS, SCRIPT,
};
