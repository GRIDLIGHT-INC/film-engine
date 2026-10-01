/**
 * An uploaded plate can be refined.
 *
 * A generated plate is stored as `<kind>_<name>.png`; an uploaded one keeps the
 * extension its bytes say, so a phone photo is a `.jpg`. Refine looked for the
 * `.png` name only and answered "There is no plate to refine yet" for every
 * uploaded plate, including every photo the iPhone scanner sends. It now finds
 * the plate under its own extension, sends that picture, and archives it, so the
 * refined picture is the one current plate of that view.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-refine-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();
const providers = require('../lib/providers');
const { resolveFfmpeg } = require('../lib/ffmpeg');
const { handleLocations } = require('../routes/locations');

const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const SENT = [];
providers.register({
    id: 'refine-capture', label: 'Capture (test)', capabilities: ['image'],
    supportsReferenceImages: true, maxReferenceImages: 5, maxImagePixels: 3840 * 2160, promptLimit: 4000,
    supports(cap) { return cap === 'image'; },
    async generate(capability, payload) { SENT.push(payload); return { ok: true, data: PNG, model: 'capture-1' }; },
});

function call(method, parts, body) {
    return new Promise(resolve => {
        const res = { statusCode: 200, writeHead(s) { this.statusCode = s; }, setHeader() {},
            end(c) { let d; try { d = JSON.parse(String(c)); } catch { d = c; } resolve({ status: this.statusCode, data: d }); } };
        handleLocations({ method, body: body || {}, headers: {} }, res, ['film', ...parts], {});
    });
}

const ff = resolveFfmpeg();
test('a JPEG uploaded as a location plate is refined, sent as itself, and archived',
    { skip: ff.available ? false : 'no ffmpeg to make a JPEG' }, async () => {
    const projectId = generateId(), locationId = generateId();
    db.prepare(`INSERT INTO film_projects (id, title, provider_config, aspect_ratio, target_resolution)
                VALUES (?, 'Refine', ?, '16:9', '1920x1080')`).run(projectId, JSON.stringify({ image: 'refine-capture' }));
    db.prepare('INSERT INTO film_locations (id, project_id, name) VALUES (?, ?, ?)').run(locationId, projectId, 'Office');
    const jpg = path.join(os.tmpdir(), `refine-${crypto.randomUUID()}.jpg`);
    spawnSync(ff.bin, ['-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=64x36', '-frames:v', '1', jpg],
        { stdio: ['ignore', 'pipe', 'pipe'] });
    const up = await call('POST', ['locations', locationId, 'plate', 'import'],
        { data: `data:image/jpeg;base64,${fs.readFileSync(jpg).toString('base64')}`, name: 'office.jpg' });
    assert.ok(up.status === 200 || up.status === 201, JSON.stringify(up.data));
    assert.match(up.data.file_name, /\.jpg$/, 'the upload was not kept as a JPEG');

    const r = await call('POST', ['locations', locationId, 'plate', 'refine'], { instruction: 'Make it night.' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const sent = SENT[SENT.length - 1];
    assert.ok(sent && sent.reference_images && /^data:image\/jpeg/.test(sent.reference_images[0].uri),
        'the uploaded picture was not the one sent');

    const rows = db.prepare(`SELECT file_name, metadata FROM film_assets WHERE location_id = ? AND asset_type = 'reference_image'`).all(locationId);
    const current = rows.filter(x => !/"plate_role":"superseded"/.test(x.metadata || ''));
    assert.deepEqual(current.map(x => path.extname(x.file_name)), ['.png'], `current plates: ${JSON.stringify(rows)}`);

    // The sheet lists the current plate only: the archived JPEG (moved to versions/)
    // drew as a broken tile on the location when it was listed as a view.
    const views = await call('GET', ['locations', locationId, 'plate', 'views']);
    assert.equal(views.status, 200, JSON.stringify(views.data));
    assert.deepEqual(views.data.views.map(v => path.extname(v.file_name)), ['.png'],
        `views: ${JSON.stringify(views.data.views.map(v => v.file_name))}`);
});
