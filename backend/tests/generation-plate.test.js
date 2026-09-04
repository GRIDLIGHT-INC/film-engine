/**
 * World Engine — Phase 5 (MVP 5): the generation bridge.
 *
 * Implements test-spec §7, WE-5.1 through WE-5.10.
 *
 * A GENERATION PLATE IS A REFERENCE, NOT A NEW MECHANISM. `KIND_RANK` already
 * ranks the anchor first and the prompt already names it "the first reference
 * image"; a plate is the same semantic role with a different source — previs
 * geometry instead of a previous frame. So it is inserted at rank 0 and
 * everything downstream works unchanged.
 *
 * The two failures this file exists to catch:
 *
 *   1. A plate gathered, stored, billed for and never SENT. That is the
 *      `image_urls` failure MuAPI already cost — the frame comes back plausible
 *      and conditioned on nothing, indistinguishable from weak conditioning.
 *   2. Inserting a kind at rank 0 quietly reordering the five that exist, so
 *      every project WITHOUT a plate silently changes what it sends.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const os = require('os');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-plate-' + crypto.randomUUID().slice(0, 8));

const ROOT = path.join(__dirname, '..', '..');
const plate = require('../lib/generation-plate');
const ri = require('../lib/reference-images');

// ══ WE-5.3 / D7 · the rank ══════════════════════════════════════════════════

test('WE-5.3 the plate ranks first, and the five existing kinds keep their order', () => {
    assert.strictEqual(ri.KIND_RANK.plate, 0, 'the plate does not lead the references');
    const kinds = Object.keys(ri.KIND_RANK);
    assert.strictEqual(kinds.length, 6, `there are ${kinds.length} reference kinds, not 6`);

    /*
     * The property that makes this safe: a project with no plate must select
     * exactly what it selected before. Relative order among the five is the
     * whole guarantee.
     */
    const existing = ['anchor', 'character', 'location', 'prop', 'style'];
    const ordered = [...existing].sort((a, b) => ri.KIND_RANK[a] - ri.KIND_RANK[b]);
    assert.deepStrictEqual(ordered, existing,
        `inserting the plate reordered the existing kinds to ${ordered.join(',')}`);
    for (const k of existing) {
        assert.ok(ri.KIND_RANK[k] > ri.KIND_RANK.plate, `${k} outranks the plate`);
    }
});

test('WE-D7.2 the plate declares where it comes from, and it is not an entity', () => {
    assert.strictEqual(ri.KIND_SOURCE.plate, 'previs',
        'the plate has no declared source, so a test deriving "every subject kind" from '
        + 'KIND_RANK will demand a table and a plate generator for a previs render');
    for (const k of Object.keys(ri.KIND_RANK)) {
        assert.ok(ri.KIND_SOURCE[k], `${k} has no KIND_SOURCE`);
    }
});

// ══ WE-5.1 · every entry point ══════════════════════════════════════════════

test('WE-5.1 the plate is gathered by the ONE gatherer, so all four paths get it', () => {
    /*
     * Derived from the call sites rather than asserted at one of them. Three
     * paths conditioning on geometry and one silently not is the divergence
     * shot-references.js was created to end — and it is invisible, because the
     * prompt still reads perfectly.
     */
    const files = ['lib/shot-references.js', 'routes/storyboard.js'];
    const sites = [];
    for (const rel of files) {
        const src = fs.readFileSync(path.join(ROOT, 'backend', rel), 'utf8');
        for (const m of src.matchAll(/gatherShotReferences\(/g)) {
            // Skip the declaration itself and prose mentions.
            const before = src.slice(Math.max(0, m.index - 12), m.index);
            if (/function\s+$/.test(before) || /\*\s*$/.test(before)) continue;
            sites.push({ rel, index: m.index, src });
        }
    }
    assert.ok(sites.length >= 4, `found ${sites.length} call sites — the scan is broken`);

    /*
     * The plate is looked up INSIDE the gatherer, from the shot. So every call
     * site has to hand over which shot it is gathering for — a caller that does
     * not is a path that silently sends no plate.
     */
    const missing = sites.filter(s => {
        const call = s.src.slice(s.index, s.index + 600);
        return !/shotId/.test(call);
    }).map(s => s.rel);
    assert.deepStrictEqual(missing, [],
        `these call sites gather without naming the shot, so they can never attach a plate: ${missing.join(', ')}`);

    const gather = fs.readFileSync(path.join(ROOT, 'backend', 'lib', 'shot-references.js'), 'utf8');
    assert.match(gather, /plateReferenceFor|kind: 'plate'/,
        'the gatherer never looks for a plate — no path can attach one');
});

test('WE-5.1b the gatherer actually RETURNS the plate — not merely defines a lookup', () => {
    /*
     * BEHAVIOURAL, because the source check above is not enough and a mutation
     * proved it: replacing the call with `const plateRef = null` left every
     * assertion green. A lookup that exists and is never called is
     * indistinguishable from one that works, which is the failure this whole
     * file is about, pointed at the test instead of the code.
     */
    const { db, generateId } = require('../db/database');
    require('../db/schema').ensureSchema();
    const { gatherShotReferences } = require('../lib/shot-references');

    const projectId = generateId(), sceneId = generateId(), shotId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Plate Test');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, ?)').run(sceneId, projectId, '1');
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code) VALUES (?, ?, ?)').run(shotId, sceneId, '1A');

    // Before: no plate, so nothing of that kind travels.
    assert.ok(!gatherShotReferences(projectId, [], null, [], null, { shotId })
        .some(r => r && r.kind === 'plate'), 'a plate appeared before one was rendered');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-plate-db-'));
    const file = path.join(dir, 'plate.png');
    fs.writeFileSync(file, Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154'
        + '789c63000100000500010d0a2db40000000049454e44ae426082', 'hex'));
    db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, metadata)
                VALUES (?, ?, ?, 'other', ?, 'plate.png', ?)`)
        .run(generateId(), projectId, shotId, file, JSON.stringify({ kind: 'plate_image' }));

    const after = gatherShotReferences(projectId, [], null, [], null, { shotId });
    const got = after.find(r => r && r.kind === 'plate');
    assert.ok(got, 'a plate exists for this shot and the gatherer did not return it');
    /*
     * Bound to the BYTES, not the path. The gatherer inlines each reference as
     * a data URI, and that is the thing that actually reaches the provider —
     * asserting a path would pass while the picture was serialised, sent and
     * thrown away, which is precisely the MuAPI failure this file names.
     */
    assert.match(String(got.uri), /^data:image\/png;base64,iVBORw0KGgo/,
        'the plate did not travel as image bytes — it was gathered and dropped');
    assert.strictEqual(got.name, 'PLATE');

    // And a shot that does not name itself gets nothing, which is what makes
    // the "every call site passes shotId" check above load-bearing.
    assert.ok(!gatherShotReferences(projectId, [], null, [], null, {})
        .some(r => r && r.kind === 'plate'), 'a plate travelled without the shot being named');
});

// ══ WE-5.2 · it actually travels ════════════════════════════════════════════

test('WE-5.2 attaching a plate changes what the provider receives, and it leads', () => {
    /*
     * DIFFERENTIAL, and behavioural. A source check that the gatherer "handles"
     * a plate passes just as happily when the result never reaches the request
     * — the MuAPI `image_urls` failure, where every reference was serialised,
     * sent, billed for and thrown away.
     */
    // Real files: selectReferences inlines the bytes, so a synthetic uri is
    // dropped and the comparison would pass over two empty lists.
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-plate-'));
    const png = Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154'
        + '789c6300010000050001' + '0d0a2db4' + '0000000049454e44ae426082', 'hex');
    const at = (n) => { const f = path.join(dir, n + '.png'); fs.writeFileSync(f, png); return f; };

    const cands = [
        { name: 'MAYA', kind: 'character', file_path: at('maya') },
        { name: 'STREET', kind: 'location', file_path: at('street') },
    ];
    const without = ri.selectReferences(cands, { limit: 3 });
    assert.ok(without.length > 0, 'the fixture produced no references at all — the test proves nothing');
    const with_ = ri.selectReferences(
        cands.concat([{ name: 'PLATE', kind: 'plate', file_path: at('plate') }]), { limit: 3 });

    assert.notDeepStrictEqual(with_, without, 'a plate changed nothing about what is sent');
    assert.strictEqual(with_[0].kind, 'plate',
        `the plate is not first — it arrived at position ${with_.findIndex(r => r.kind === 'plate')}`);
    // And it did not evict identity: with room for three, all three travel.
    assert.strictEqual(with_.length, 3);
});

// ══ WE-5.4 · the prompt names it ════════════════════════════════════════════

test('WE-5.4 the prompt names the plate unambiguously', () => {
    const line = plate.platePromptLead({ tag: null });
    assert.match(line, /first reference image/i,
        'on a provider that cannot read tags the model is handed pictures with no way to '
        + 'tell which one fixes the geometry');
    assert.match(line, /camera|framing|geometr/i, 'the lead does not say what the plate is FOR');

    // Where tags survive, it is named rather than positioned.
    const tagged = plate.platePromptLead({ tag: 'plate' });
    assert.match(tagged, /@plate/, 'a taggable provider is not told the plate by name');
});

// ══ WE-5.5 · the shape ══════════════════════════════════════════════════════

test('WE-5.5 a plate is rendered at the shot\'s own shape, never cropped later', () => {
    const { buildVideoFrame } = require('../lib/video-prompt');
    const project = { aspect_ratio: '2.39:1', target_resolution: '1920x1080' };
    const size = plate.plateSizeFor(project, null);
    const frame = buildVideoFrame(project, null);
    assert.deepStrictEqual([size.width, size.height], [frame.width, frame.height],
        'the plate is not the shape the shot delivers at — it would be cropped afterwards, '
        + 'and a 9:16 centre crop of a landscape frame keeps 32% of its width');

    // A vertical override is rendered vertical, not fitted inside the landscape frame.
    const vertical = plate.plateSizeFor(project, '9:16');
    assert.ok(vertical.height > vertical.width, `a 9:16 plate came back ${vertical.width}x${vertical.height}`);
});

// ══ WE-5.6 / 5.7 · what a plate carries ═════════════════════════════════════

test('WE-5.6 every declared output is produced and registered', () => {
    assert.ok(plate.PLATE_OUTPUTS.length >= 3,
        `a plate declares ${plate.PLATE_OUTPUTS.length} outputs — the bridge promises image, depth and masks`);
    for (const o of plate.PLATE_OUTPUTS) {
        assert.ok(o.id && o.assetKind && o.why, `an output is missing id/assetKind/why: ${JSON.stringify(o)}`);
        assert.match(o.assetKind, /^plate_/, `${o.id} does not register under a plate_* kind`);
    }
});

test('WE-5.7 a plate records the geometry it came from', () => {
    const rec = plate.buildPlateRecord({
        shotId: 's1', worldVersionId: 'v3',
        camera: { position: [0, 0.42, 8], rotation: [0, 17, 0], focalMm: 21 },
        subjects: [{ name: 'MAYA', position: [0, 0, 0] }],
        project: { aspect_ratio: '16:9', target_resolution: '1920x1080' },
    });
    assert.strictEqual(rec.world_version_id, 'v3');
    assert.ok(rec.blocking_snapshot, 'the plate does not record the blocking it was rendered from');
    assert.strictEqual(rec.blocking_snapshot.subjects.length, 1);
    assert.deepStrictEqual(rec.camera.position, [0, 0.42, 8]);
    assert.ok(rec.created_at, 'the plate has no timestamp');

    // A plate whose world version is gone is DETACHED, not stale: you cannot
    // regenerate against geometry that no longer exists.
    assert.strictEqual(plate.plateState({ world_version_id: 'v3' }, { exists: false }), 'detached');
    assert.strictEqual(plate.plateState({ world_version_id: 'v3' }, { exists: true }), 'current');
    assert.strictEqual(plate.plateState({ world_version_id: null }, { exists: false }), 'current',
        'a plate that never named a world was reported as detached from one');
});

// ══ WE-5.8 · the video side ═════════════════════════════════════════════════

test('WE-5.8 the camera move travels to video as prose', () => {
    const prose = plate.moveProse({
        movement: 'dolly-out', amountM: 2.4, durationMs: 4000,
        rotate: { tiltDeg: 13 },
    });
    assert.match(prose, /2\.4/, 'the distance is not stated');
    assert.match(prose, /4|four/i, 'the duration is not stated');
    assert.match(prose, /13/, 'the tilt is not stated');
    assert.match(prose, /back|out|away/i, 'the direction of travel is not stated');

    // A static shot says nothing rather than inventing a move.
    assert.strictEqual(plate.moveProse({ movement: 'static' }), '',
        'a locked-off shot was described as moving');
});

// ══ WE-5.9 / 5.10 · what a plate is NOT ═════════════════════════════════════

test('WE-5.9 a plate is not fingerprinted as a keyframe', () => {
    const { ARTEFACT_KINDS } = require('../lib/artefact-fingerprint');
    assert.ok(!Object.keys(ARTEFACT_KINDS || {}).includes('generation_plate'),
        'a plate is fingerprinted as a generated artefact, so rendering one would tell the '
        + 'director every frame built from that card is now out of date');
    assert.match(plate.WHY_NOT_FINGERPRINTED, /keyframe|stale|payload/i,
        'the exemption is not stated, so it reads as an omission rather than a decision');
});

test('WE-5.10 rendering a plate spends nothing', () => {
    const src = fs.readFileSync(path.join(ROOT, 'backend', 'lib', 'generation-plate.js'), 'utf8');
    for (const forbidden of ['providers', 'resolveGenerator', 'meterAdapter', 'llm-client']) {
        assert.ok(!new RegExp(`require\\(['"][^'"]*${forbidden}`).test(src),
            `generation-plate requires ${forbidden} — the free step before every paid one has become billable`);
    }
    assert.strictEqual(plate.SPENDS, false, 'the module does not declare itself free');
});

// ══ WE-5.12 · the pixels ════════════════════════════════════════════════════

test('WE-5.12 a rendered plate is stored, and the gatherer then finds it', async () => {
    /*
     * The round trip. Until this existed the route described a plate it had no
     * way to receive: the record, the size and the prompt lead were all correct
     * and no picture ever reached a request. A bridge that is documented and
     * unbuilt is the "capability with no control" failure, and it is invisible
     * because everything upstream reads perfectly.
     */
    const { db, generateId } = require('../db/database');
    require('../db/schema').ensureSchema();
    const { handleWorlds } = require('../routes/worlds');
    const { gatherShotReferences } = require('../lib/shot-references');

    const projectId = generateId(), sceneId = generateId(), shotId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Plate Store');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, ?)').run(sceneId, projectId, '1');
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code) VALUES (?, ?, ?)').run(shotId, sceneId, '1A');

    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'
        + 'AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    const call = (method, url, body) => new Promise(resolve => {
        const chunks = [];
        const res = {
            statusCode: 200,
            writeHead(s2) { this.statusCode = s2; },
            end(c) { if (c) chunks.push(c); let d; try { d = JSON.parse(chunks.join('')); } catch { d = chunks.join(''); }
                     resolve({ status: this.statusCode, data: d }); },
        };
        Promise.resolve(handleWorlds({ method, body: body || {} },
            res, url.split('/').filter(Boolean), {}))
            .catch(e => resolve({ status: 500, data: { error: e.message } }));
    });

    const stored = await call('POST', `/film/shots/${shotId}/generation-plate`, { image: PNG });
    assert.strictEqual(stored.status, 200, JSON.stringify(stored.data));
    assert.ok(stored.data.stored, 'the route accepted a rendered plate and stored nothing');
    assert.strictEqual(stored.data.free, true, 'storing a plate reported a cost');

    // The bytes are on disk and the gatherer picks them up with nothing else changed.
    const ref = gatherShotReferences(projectId, [], null, [], null, { shotId })
        .find(r => r && r.kind === 'plate');
    assert.ok(ref, 'a plate was stored and the gatherer does not see it');
    assert.match(String(ref.uri), /^data:image\/png;base64,iVBORw0KGgo/,
        'the stored plate did not come back as image bytes');

    // Re-rendering REPLACES rather than accumulating: two plates for one shot
    // means "the plate" is whichever row the query happens to return.
    await call('POST', `/film/shots/${shotId}/generation-plate`, { image: PNG });
    const n = db.prepare(`SELECT COUNT(*) n FROM film_assets
        WHERE shot_id = ? AND json_valid(metadata)
          AND json_extract(metadata, '$.kind') = 'plate_image'`).get(shotId).n;
    assert.strictEqual(n, 1, `${n} plate rows for one shot — re-rendering accumulated`);
});

test('WE-5.12b a plate that is not a PNG is refused', () => {
    /*
     * A plate exists to be geometrically exact. Accepting whatever arrives is
     * how a JPEG's compression artefacts end up in the one reference whose job
     * is to fix the framing — and a file called .png that is not one is a lie a
     * decoder eventually calls.
     */
    assert.strictEqual(plate.decodePlateImage('data:image/jpeg;base64,/9j/4AAQ').ok, false);
    assert.match(plate.decodePlateImage('data:image/jpeg;base64,/9j/4AAQ').error, /PNG/i);
    assert.strictEqual(plate.decodePlateImage('not a data uri').ok, false);

    const good = plate.decodePlateImage('data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==');
    assert.strictEqual(good.ok, true, good.error);
    assert.ok(Buffer.isBuffer(good.bytes), 'the decoded plate is not bytes');
});

test('WE-5.13 the console can render a plate, and does not bake the overlays in', () => {
    const UI = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
    const at = UI.indexOf('function worldRenderPlate(');
    assert.notStrictEqual(at, -1, 'there is no way to render a plate — the bridge is documented and unbuilt');
    let depth = 0, end = at;
    for (let i = UI.indexOf('{', at); i < UI.length; i++) {
        if (UI[i] === '{') depth++;
        else if (UI[i] === '}' && --depth === 0) { end = i + 1; break; }
    }
    const body = UI.slice(at, end);

    assert.match(body, /toDataURL\('image\/png'\)/, 'the plate is not rendered as a PNG');
    assert.match(body, /generation-plate/, 'the render is never posted anywhere');
    /*
     * Composition overlays are for a person reading the frame. Baked into a
     * plate they become marks an image model faithfully reproduces — thirds
     * lines drawn across the finished shot.
     */
    assert.match(body, /WORLD\.overlays\s*=/,
        'the overlays are not cleared before capture — they would be baked into the plate');

    // And the button exists, wired to it.
    assert.match(UI, /onclick="worldRenderPlate\(\)"/,
        'the renderer is defined and nothing calls it');
    assert.match(UI, /RENDER GENERATION PLATE/, 'the action has no label');
});

// ══ the surface ═════════════════════════════════════════════════════════════

test('WE-5.11 the plate is reachable from an agent, and named as free', () => {
    const { listTools } = require('../lib/mcp-tools');
    const t = listTools().find(x => x.name === 'generation_plate');
    assert.ok(t, 'generation_plate is not on the agent surface');
    assert.match(t.description, /free|spends nothing|costs nothing/i,
        'the tool does not say it is free, so a model will treat it as a purchase');

    const guide = fs.readFileSync(path.join(ROOT, 'docs', 'claude-desktop-guide.md'), 'utf8');
    const cost = guide.slice(guide.indexOf('## What costs money'));
    assert.ok(!cost.split('\n\n')[1].includes('generation_plate'),
        'generation_plate is listed as spending money');
});
