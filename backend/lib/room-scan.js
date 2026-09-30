/**
 * A LiDAR room scan (Apple RoomPlan) turned into a set the engine can build.
 *
 * "Build our own app to do the appropriate scanning… scan with LiDAR in our own
 * app… and then what if I want to do the entire house with multiple levels?"
 *
 * The Film Engine iOS app scans with RoomPlan and posts the CapturedStructure
 * (or a single CapturedRoom) as JSON — Apple's own Codable encoding — with the
 * USDZ beside it. This module reads that JSON into the set-build layout
 * vocabulary (lib/set-build.js LAYOUT_SCHEMA): walls as segments with their
 * doors and windows measured along them, floors as slabs, stairs, and every
 * piece of furniture as a Previs library model at its measured size. Blender
 * then builds it exactly as it builds a layout written from plates, and it
 * becomes the next version of the location's world. Free: nothing leaves the
 * Mac.
 *
 * WHY THE JSON AND NOT THE USDZ. The USDZ is a mesh with no meaning: a wall and
 * a table are both triangles. The JSON says what each thing IS, how big, and
 * which wall a door is in — which is what lets a chair become the library's
 * chair and a door become a hole the camera can see through.
 *
 * MULTI-LEVEL. Every room scanned in one continuous session shares ARKit's
 * world coordinates, vertical included, so a room upstairs is already above
 * the room downstairs. The lowest floor is set to z = 0 and the rest keep
 * their measured heights; RoomPlan's own `story` number is recorded per wall.
 *
 * AXES. ARKit is y-up with -z forward at the start of the session (metres);
 * the layout is Blender's: x east, y north, z up. So (x, y, z) -> (x, -z, y):
 * "north" is simply the way the phone faced when the scan began.
 *
 * DEFENSIVE BY DESIGN. Apple's encoding of an enum with associated values is
 * `{ "door": { "isOpen": true } }`, of a matrix either nested columns or a flat
 * array; both are read. Anything unreadable is skipped and NAMED in `skipped`,
 * never silently dropped.
 */

/** RoomPlan object categories -> a Previs library model (checked at run time). */
const CATEGORY_ASSET = Object.freeze({
    table: 'table', sofa: 'loungeSofa', chair: 'chair', bed: 'bedDouble',
    refrigerator: 'kitchenFridge', stove: 'kitchenStove', oven: 'kitchenStove',
    sink: 'kitchenSink', toilet: 'toilet', bathtub: 'bathtub', washerDryer: 'washer',
    dishwasher: 'kitchenCabinet', storage: 'bookcaseClosed', television: 'televisionModern',
    fireplace: null,
});
const CATEGORY_COLOUR = Object.freeze({
    fireplace: '#6b5a50', storage: '#8a7760', table: '#8f7355', default: '#9a9690',
});
const WALL_COLOUR = '#d8d4cc';
const FLOOR_COLOUR = '#8c7f70';

/** 'wall' from "wall", { wall: {} } or { door: { isOpen } }. */
function categoryOf(v) {
    if (!v) return null;
    if (typeof v === 'string') return v;
    if (typeof v === 'object') { const k = Object.keys(v)[0]; return k || null; }
    return null;
}

/** Four columns [x, y, z, w] from nested columns or a flat column-major array. */
function columnsOf(t) {
    if (!Array.isArray(t)) return null;
    if (t.length === 4 && t.every(c => Array.isArray(c) && c.length >= 3)) return t.map(c => c.slice(0, 4).map(Number));
    if (t.length === 16 && t.every(n => typeof n === 'number')) return [0, 1, 2, 3].map(i => t.slice(i * 4, i * 4 + 4));
    return null;
}
const ok3 = v => Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every(n => Number.isFinite(Number(n)));
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
/** ARKit (x, y-up, z) -> layout plan (x east, y north). */
const plan = p => [p[0], -p[2]];
const r3 = n => (Math.round(n * 1000) / 1000) + 0;   // + 0 turns -0 into 0

/** One surface or object: centre, its local axes, and its dimensions, or null. */
function frameOf(item) {
    const cols = columnsOf(item && item.transform);
    if (!cols || !ok3(item.dimensions)) return null;
    return {
        id: item.identifier || null,
        parent: item.parentIdentifier || null,
        category: categoryOf(item.category),
        story: Number.isFinite(item.story) ? item.story : null,
        centre: cols[3].slice(0, 3), ax: unit(cols[0].slice(0, 3)), ay: unit(cols[1].slice(0, 3)), az: unit(cols[2].slice(0, 3)),
        dims: item.dimensions.slice(0, 3).map(Number),
        isOpen: item.category && typeof item.category === 'object' && item.category.door ? !!item.category.door.isOpen : null,
    };
}

/** Every array of a kind, whether the scan is one room, a structure, or { rooms: [...] }. */
function gather(scan, key) {
    const out = [];
    const push = r => { if (r && Array.isArray(r[key])) out.push(...r[key]); };
    push(scan);
    if (Array.isArray(scan && scan.rooms)) scan.rooms.forEach(push);
    return out;
}

/**
 * The scan as a set-build layout. Returns { layout, report } — the report says
 * what was built, what became a library model and what was skipped and why.
 */
function scanToLayout(scan, opts = {}) {
    const library = opts.library || require('./previs-library');
    const report = { walls: 0, openings: 0, floors: 0, stairs: 0, objects: 0, library: {}, skipped: [], stories: [] };
    const walls = gather(scan, 'walls').map(frameOf);
    const floors = gather(scan, 'floors').map(frameOf);
    const holes = [
        ...gather(scan, 'doors').map(x => Object.assign(frameOf(x) || {}, { kind: 'door' })),
        ...gather(scan, 'windows').map(x => Object.assign(frameOf(x) || {}, { kind: 'window' })),
        ...gather(scan, 'openings').map(x => Object.assign(frameOf(x) || {}, { kind: 'gap' })),
    ];
    const objects = gather(scan, 'objects').map(frameOf);
    walls.forEach((w, i) => { if (!w) report.skipped.push(`walls[${i}]: no transform or dimensions`); });
    const W = walls.filter(Boolean);
    if (!W.length) {
        const e = new Error('The scan has no walls this engine can read.'); e.status = 400; e.report = report; throw e;
    }

    // The lowest floor is z = 0. Walls stand on their own measured base.
    const bases = W.map(w => w.centre[1] - w.dims[1] / 2);
    floors.filter(Boolean).forEach(f => bases.push(f.centre[1]));
    const ground = Math.min(...bases);
    const z = y => r3(y - ground);

    const layout = { walls: [], slabs: [], stairs: [], objects: [], cameras: [], light: { time_of_day: 'midday', sun_from: 'south' } };
    const wallGeom = new Map();
    W.forEach((w, i) => {
        const half = w.dims[0] / 2;
        const A = sub(w.centre, w.ax.map(n => n * half));
        const B = w.centre.map((c, k) => c + w.ax[k] * half);
        const base = w.centre[1] - w.dims[1] / 2;
        const entry = { name: `wall ${i + 1}${w.story != null ? ` (story ${w.story})` : ''}`, from: plan(A).map(r3), to: plan(B).map(r3),
            z0: z(base), height: r3(Math.max(0.3, w.dims[1])), thickness: 0.12, color: WALL_COLOUR, openings: [] };
        layout.walls.push(entry);
        wallGeom.set(w.id || `#${i}`, { w, A, base, entry });
        if (w.story != null && !report.stories.includes(w.story)) report.stories.push(w.story);
    });
    report.walls = layout.walls.length;

    // Doors, windows and openings, cut into the wall they are in.
    holes.forEach((h, i) => {
        if (!h || !h.centre) { report.skipped.push(`${h && h.kind || 'opening'} ${i}: no transform or dimensions`); return; }
        let host = h.parent && wallGeom.get(h.parent);
        if (!host) {
            // No parent named: the wall whose line it sits on, within 30 cm.
            let best = null;
            for (const g of wallGeom.values()) {
                const along = dot(sub(h.centre, g.A), g.w.ax);
                const off = sub(sub(h.centre, g.A), g.w.ax.map(n => n * along));
                const dist = Math.hypot(off[0], off[2]);
                if (along >= -0.1 && along <= g.w.dims[0] + 0.1 && dist < 0.3 && (!best || dist < best.d)) best = { g, d: dist };
            }
            host = best && best.g;
        }
        if (!host) { report.skipped.push(`${h.kind} ${i}: not in any wall`); return; }
        const width = h.dims[0], height = h.dims[1];
        const at = dot(sub(h.centre, host.A), host.w.ax) - width / 2;
        const sill = h.kind === 'door' ? 0 : Math.max(0, h.centre[1] - height / 2 - host.base);
        host.entry.openings.push({ kind: h.kind, at: r3(Math.max(0, at)), width: r3(width), sill: r3(sill),
            top: r3(Math.min(host.entry.height, sill + height)) });
        report.openings++;
    });

    // Floors: the scan's own, else one under every storey's walls.
    const F = floors.filter(Boolean);
    const slabFrom = (pts, top, name) => {
        const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
        return { name, x0: r3(Math.min(...xs)), x1: r3(Math.max(...xs)), y0: r3(Math.min(...ys)), y1: r3(Math.max(...ys)),
            z: r3(top), thickness: 0.15, color: FLOOR_COLOUR };
    };
    if (F.length) {
        F.forEach((f, i) => {
            const hx = f.dims[0] / 2, hy = f.dims[1] / 2;
            const corners = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]].map(([a, b]) =>
                plan(f.centre.map((c, k) => c + f.ax[k] * a + f.ay[k] * b)));
            layout.slabs.push(slabFrom(corners, z(f.centre[1]), `floor ${i + 1}`));
        });
    } else {
        const byLevel = new Map();
        for (const e of layout.walls) {
            const key = Math.round(e.z0 * 4) / 4;
            if (!byLevel.has(key)) byLevel.set(key, []);
            byLevel.get(key).push(e.from, e.to);
        }
        for (const [lvl, pts] of byLevel) layout.slabs.push(slabFrom(pts, lvl, `floor at ${lvl} m`));
    }
    report.floors = layout.slabs.length;

    // Furniture as library models at their measured size; stairs as stairs.
    objects.forEach((o, i) => {
        if (!o) { report.skipped.push(`objects[${i}]: no transform or dimensions`); return; }
        const [w, h, d] = o.dims;
        const baseZ = z(o.centre[1] - h / 2);
        // Which way it faces: its local +z, in plan; yaw 0 faces north, turning left is positive.
        const f = plan(o.az);
        const yaw = r3(Math.atan2(-f[0], f[1]) * 180 / Math.PI);
        const at = plan(o.centre).map(r3);
        if (o.category === 'stairs') {
            // The bottom front edge, climbing along its facing.
            const back = [o.centre[0] - o.az[0] * d / 2, o.centre[2] - o.az[2] * d / 2];
            layout.stairs.push({ name: `stairs ${i + 1}`, at: [r3(back[0]), r3(-back[1]), baseZ], yaw,
                width: r3(w), rise: r3(h), run: r3(d), steps: Math.max(3, Math.round(h / 0.18)) });
            report.stairs++;
            return;
        }
        const assetId = CATEGORY_ASSET[o.category];
        const name = `${o.category || 'object'} ${i + 1}`;
        if (assetId && library.get(assetId)) {
            layout.objects.push({ name, shape: 'asset', asset: assetId, at: [at[0], at[1], baseZ], yaw, size: [r3(w), r3(d), r3(h)] });
            report.library[o.category] = (report.library[o.category] || 0) + 1;
        } else {
            layout.objects.push({ name, shape: 'box', at: [at[0], at[1], baseZ], yaw, size: [r3(w), r3(d), r3(h)],
                color: CATEGORY_COLOUR[o.category] || CATEGORY_COLOUR.default });
        }
        report.objects++;
    });
    report.stories.sort((a, b) => a - b);
    return { layout, report };
}

module.exports = { scanToLayout, categoryOf, columnsOf, CATEGORY_ASSET };
