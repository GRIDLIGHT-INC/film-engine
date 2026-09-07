#!/usr/bin/env node
/**
 * SPIKE — is a Marble world usable as a previs stage?
 *
 * Three unknowns decide the whole World Engine overhaul, and reading the
 * documentation cannot settle any of them:
 *
 *   1. EXTENT. Is a reverse angle reachable, or is a world a bubble around the
 *      viewpoint it was generated from? World Labs documents no dimensions; its
 *      own post says "room-sized worlds". If a camera cannot turn round inside
 *      one, this is a prettier backdrop rather than a continuity system.
 *
 *   2. GEOMETRY. Is the free collider mesh real geometry or a crude hull? It is
 *      what makes v1 possible without Spark, splats or a second three.js.
 *
 *   3. INPUT. Do GENERATED plates work, or does Marble want photographs? Every
 *      location plate in this engine is generated.
 *
 * It spends about $0.20 of draft credits and writes nothing to the database.
 * Answers, not opinions.
 *
 *   node backend/spike-world.js --location <id>     # from a location's plates
 *   node backend/spike-world.js --image <path>      # from any image
 *   node backend/spike-world.js --dry-run --image <path>   # print the request, spend nothing
 */

const fs = require('fs');
const path = require('path');

const API = process.env.WORLDLABS_BASE_URL || 'https://api.worldlabs.ai';
const MODEL = process.env.WORLDLABS_MODEL || 'marble-1.0-draft';

/* Film Engine names its location sides by compass; Marble takes an azimuth,
 * documented as 0/90/180/270 for front/right/back/left. North is the plate the
 * others turn from, so it is front. */
/*
 * The compass mapping and the image ceiling come from the ADAPTER, never from a
 * copy here. Both were written twice — once in each file — which is how the
 * spike and the thing that ships come to disagree about which way north faces,
 * and the disagreement is invisible: every world still generates, facing wrong.
 */
const { AZIMUTH, MAX_INPUT_IMAGES } = require('./lib/providers/worldlabs');

/*
 * A spike that cannot ask for a panorama cannot spike the input Marble calls
 * the most accurate. `--pano` / `--no-pano`; saying nothing still means auto.
 */
const panoArg = process.argv.includes('--pano') ? true
    : process.argv.includes('--no-pano') ? false
    : 'auto';

function arg(name, fallback) {
    const i = process.argv.indexOf('--' + name);
    return i === -1 ? fallback : (process.argv[i + 1] || true);
}
const DRY = process.argv.includes('--dry-run');

function key() {
    if (process.env.WORLDLABS_API_KEY) return process.env.WORLDLABS_API_KEY;
    try {
        const { getCredential } = require('./lib/providers/credentials');
        const c = getCredential('worldlabs');
        return (c && (c.apiKey || c)) || null;
    } catch (_) { return null; }
}

/** Base64 is a documented media source, so the spike needs no upload step. */
function imageRef(file) {
    const ext = path.extname(file).replace('.', '').toLowerCase() || 'png';
    return { source: 'data_base64', data_base64: fs.readFileSync(file).toString('base64'), extension: ext };
}

/** The plates of one location, newest per view, as direction-tagged inputs. */
function platesFor(locationId) {
    const { db } = require('./db/database');
    const { getFilePath } = require('./lib/file-storage');
    const rows = db.prepare(
        `SELECT file_name, project_id, metadata FROM film_assets
          WHERE location_id = ? AND asset_type = 'reference_image'
          ORDER BY created_at DESC`).all(locationId);
    const seen = new Set(); const out = [];
    for (const r of rows) {
        let view = '';
        try { view = (JSON.parse(r.metadata || '{}').view || '').toLowerCase(); } catch (_) { view = ''; }
        if (seen.has(view)) continue;
        seen.add(view);
        let p = null;
        try { p = getFilePath(r.project_id, 'refsheets', r.file_name); } catch (_) { p = null; }
        if (p && fs.existsSync(p)) out.push({ view, file: p });
    }
    // Direction Control takes at most four.
    return out.slice(0, MAX_INPUT_IMAGES);
}

async function call(pathname, init) {
    const res = await fetch(API + pathname, {
        ...init,
        headers: { 'Content-Type': 'application/json', 'WLT-Api-Key': key(), ...(init && init.headers) },
    });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch (_) { body = text; }
    if (!res.ok) throw new Error(`${res.status} ${typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`);
    return body;
}

(async () => {
    const locationId = arg('location');
    const image = arg('image');

    let prompt, sources;
    if (locationId) {
        const plates = platesFor(locationId);
        if (!plates.length) { console.error('No plates on that location. Generate one first.'); process.exit(1); }
        sources = plates.map(p => `${p.view || '(default)'} ${path.basename(p.file)}`);
        prompt = plates.length > 1
            ? { type: 'multi-image',
                multi_image_prompt: plates.map(p => ({ azimuth: AZIMUTH[p.view] ?? 0, content: imageRef(p.file) })) }
            : { type: 'image', image_prompt: imageRef(plates[0].file), is_pano: panoArg };
    } else if (image) {
        sources = [path.basename(image)];
        prompt = { type: 'image', image_prompt: imageRef(image), is_pano: panoArg };
    } else {
        console.error('Give --location <id> or --image <path>.'); process.exit(1);
    }

    const body = { world_prompt: prompt, model: MODEL, display_name: 'Film Engine spike' };

    console.log('  model      :', MODEL);
    console.log('  prompt type:', prompt.type);
    console.log('  sources    :', sources.join(', '));
    const size = JSON.stringify(body).length;
    console.log('  request    :', (size / 1048576).toFixed(2), 'MB');

    if (DRY) {
        const redacted = JSON.parse(JSON.stringify(body, (k, v) =>
            k === 'data_base64' ? `<${String(v).length} base64 chars>` : v));
        console.log('\n  DRY RUN — nothing sent, nothing spent:\n');
        console.log(JSON.stringify(redacted, null, 2));
        return;
    }
    if (!key()) {
        console.error('\n  No World Labs key. Set WORLDLABS_API_KEY, or store one as provider "worldlabs".');
        console.error('  Get one at https://platform.worldlabs.ai — $5 minimum buys 6,250 credits,');
        console.error('  and this spike costs 150-250 of them.');
        process.exit(2);
    }

    const started = Date.now();
    let op = await call('/marble/v1/worlds:generate', { method: 'POST', body: JSON.stringify(body) });
    console.log('  operation  :', op.operation_id);

    while (!op.done) {
        const waited = (Date.now() - started) / 1000;
        if (waited > 900) throw new Error('gave up after 15 minutes');
        await new Promise(r => setTimeout(r, waited < 30 ? 3000 : waited < 120 ? 5000 : 10000));
        op = await call('/marble/v1/operations/' + op.operation_id);
        process.stdout.write(`\r  waiting    : ${waited.toFixed(0)}s`);
    }
    console.log('');
    if (op.error && op.error.message) throw new Error('generation failed: ' + op.error.message);

    const credits = op.cost && op.cost.total_credits;
    console.log('  cost       :', credits, 'credits ≈ $' + (credits / 1250).toFixed(2));
    console.log('  took       :', ((Date.now() - started) / 1000).toFixed(0), 'seconds');

    const world = op.response || {};
    const assets = world.assets || {};
    // Measured against a real response: it is nested under `mesh`.
    const collider = (assets.mesh && assets.mesh.collider_mesh_url)
        || assets.collider_mesh_url || assets.collider;
    console.log('  artefacts  :', Object.keys(assets).join(', ') || '(none named)');

    if (!collider) {
        console.log('\n  NO COLLIDER MESH in the response — unknown #2 answered NO.');
        console.log('  Full response for inspection:\n', JSON.stringify(world, null, 2).slice(0, 2000));
        return;
    }

    const buf = Buffer.from(await (await fetch(collider)).arrayBuffer());
    const out = path.join(require('os').tmpdir(), 'spike-world-collider.glb');
    fs.writeFileSync(out, buf);

    const { parseGlb, decimate } = require('./lib/glb-parser');
    const geo = parseGlb(buf);
    const drawn = decimate(geo, 20000);

    console.log('\n  ── THE THREE ANSWERS ──');
    console.log('  3. generated plate accepted :', 'YES (a world came back)');
    console.log('  2. collider mesh            :', geo.triangles.length, 'triangles,',
        geo.vertices.length, 'vertices,', geo.meshes, 'mesh(es)');
    console.log('     decimates to             :', drawn.triangles.length, 'triangles (stage budget 20k)');
    console.log('     parses with the existing glb-parser: YES');
    const [w, h, d] = geo.size;
    console.log('  1. EXTENT (world units)     :', w.toFixed(1), 'x', h.toFixed(1), 'x', d.toFixed(1));
    console.log('     bounds min               :', geo.bounds.min.map(n => n.toFixed(1)).join(', '));
    console.log('     bounds max               :', geo.bounds.max.map(n => n.toFixed(1)).join(', '));
    console.log('\n  Read the extent against the scene: if the long axis is a few units the world is a');
    console.log('  bubble and a reverse angle is not reachable. If it is tens of units, it is a set.');
    console.log('  Scale is uncalibrated — Marble does not promise metres.');
    console.log('\n  collider saved to', out);
})().catch(e => { console.error('\n  SPIKE FAILED:', e.message); process.exit(1); });
