/**
 * Phase 3 — marking up a generated frame.
 *
 * A director's fastest notation is not a sentence, it is an arrow. "Move her
 * left, push in past the mailbox" takes three strokes and a word, and we had no
 * way to put any of it on a frame: the board was pictures you could regenerate
 * and nothing you could draw on.
 *
 * StudioBinder's version instructs a human artist. Ours does not have to stop
 * there — the markup could eventually feed the next generation — but that is
 * deliberately NOT this task (PAR-026, gated on an open question). What ships
 * here is the notation itself: store it, show it, keep it with the frame.
 *
 * Set-based over the shape kinds, because a markup tool that supports arrows
 * and silently drops the text label is worse than no markup tool: the director
 * believes the note was recorded.
 *
 * Geometry is stored NORMALISED (0..1 of frame width/height), never in pixels.
 * A frame regenerated at a different resolution, or a board viewed on a phone,
 * would otherwise move every arrow off the thing it points at.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-annot-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const { handleAnnotations, ANNOTATION_KINDS } = require('../routes/annotations');
const INDEX_HTML = path.join(__dirname, '..', '..', 'src', 'index.html');

function call(method, urlPath, body) {
    return new Promise(resolve => {
        const parts = urlPath.split('?')[0].split('/').filter(Boolean);
        const chunks = [];
        const res = new Writable({ write(c, _e, n) { chunks.push(c); n(); } });
        res.statusCode = 200;
        res.writeHead = function (code) { this.statusCode = code; return this; };
        res.setHeader = function () {};
        res.on('finish', () => {
            let parsed = Buffer.concat(chunks).toString();
            try { parsed = JSON.parse(parsed); } catch (_) { /* not json */ }
            resolve({ status: res.statusCode, body: parsed });
        });
        Promise.resolve(handleAnnotations({ method, body: body || {} }, res, parts, {}))
            .catch(err => resolve({ status: 500, body: { error: err.message } }));
    });
}

function makeShot() {
    const projectId = generateId(), sceneId = generateId(), shotId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Annot Test');
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, '1', 'STREET')")
        .run(sceneId, projectId);
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)')
        .run(shotId, sceneId, '1A', JSON.stringify({ shot_code: '1A', description: 'x', camera: {} }));
    return { projectId, sceneId, shotId };
}

/** One example per shape kind, in normalised coordinates. */
const SAMPLES = {
    arrow:    { points: [[0.2, 0.5], [0.7, 0.5]] },
    line:     { points: [[0.1, 0.1], [0.9, 0.9]] },
    rect:     { points: [[0.2, 0.2], [0.6, 0.7]] },
    ellipse:  { points: [[0.3, 0.3], [0.6, 0.6]] },
    freehand: { points: [[0.1, 0.1], [0.2, 0.3], [0.35, 0.4]] },
    text:     { points: [[0.4, 0.8]] },
};

test('the sample set covers every kind the route accepts', () => {
    const missing = ANNOTATION_KINDS.filter(k => !SAMPLES[k]);
    assert.deepStrictEqual(missing, [], `kinds with no test coverage: ${missing.join(', ')}`);
    const extra = Object.keys(SAMPLES).filter(k => !ANNOTATION_KINDS.includes(k));
    assert.deepStrictEqual(extra, [], `samples for kinds the route rejects: ${extra.join(', ')}`);
});

test('every shape kind round-trips with its geometry intact', async () => {
    const { shotId } = makeShot();
    const broken = [];
    for (const kind of ANNOTATION_KINDS) {
        const payload = { kind, ...SAMPLES[kind], text: kind === 'text' ? 'push in past the mailbox' : '' };
        const add = await call('POST', `/film/shots/${shotId}/annotations`, payload);
        if (add.status >= 400) { broken.push(`${kind}: refused — ${JSON.stringify(add.body)}`); continue; }
        const list = await call('GET', `/film/shots/${shotId}/annotations`);
        const found = (list.body.annotations || []).find(a => a.kind === kind);
        if (!found) { broken.push(`${kind}: saved but not returned`); continue; }
        if (JSON.stringify(found.points) !== JSON.stringify(SAMPLES[kind].points)) {
            broken.push(`${kind}: geometry changed — sent ${JSON.stringify(SAMPLES[kind].points)}, got ${JSON.stringify(found.points)}`);
        }
        if (kind === 'text' && found.text !== 'push in past the mailbox') {
            broken.push('text: the note itself was dropped, which is the whole annotation');
        }
    }
    assert.deepStrictEqual(broken, [], `\n  ${broken.join('\n  ')}`);
});

test('coordinates outside the frame are refused', async () => {
    // Normalised means 0..1. A pixel coordinate sent by mistake would land at
    // 640 and be silently stored, then draw nowhere.
    const { shotId } = makeShot();
    const r = await call('POST', `/film/shots/${shotId}/annotations`,
        { kind: 'arrow', points: [[0.2, 0.5], [640, 480]] });
    assert.ok(r.status >= 400, 'pixel coordinates were accepted as normalised ones');
});

test('an unknown shape kind is refused rather than stored as nothing', async () => {
    const { shotId } = makeShot();
    const r = await call('POST', `/film/shots/${shotId}/annotations`, { kind: 'lasso', points: [[0.1, 0.1]] });
    assert.ok(r.status >= 400, `an unsupported kind was accepted: ${JSON.stringify(r.body)}`);
});

test('annotations survive the frame being regenerated', async () => {
    // The note is about the SHOT, not about one PNG. Regenerating a keyframe
    // must not silently erase the direction that asked for the regeneration.
    const { projectId, shotId } = makeShot();
    await call('POST', `/film/shots/${shotId}/annotations`, { kind: 'arrow', points: [[0.2, 0.5], [0.7, 0.5]] });

    const assetId = generateId();
    db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, version)
                VALUES (?, ?, ?, 'storyboard', '/tmp/new.png', 'new.png', 2)`)
        .run(assetId, projectId, shotId);

    const list = await call('GET', `/film/shots/${shotId}/annotations`);
    assert.strictEqual((list.body.annotations || []).length, 1,
        'regenerating the frame lost the note that asked for it');
});

test('an annotation can be deleted', async () => {
    const { shotId } = makeShot();
    const add = await call('POST', `/film/shots/${shotId}/annotations`, { kind: 'rect', points: [[0.1, 0.1], [0.5, 0.5]] });
    const del = await call('DELETE', `/film/annotations/${add.body.annotation.id}`);
    assert.ok(del.status < 400, JSON.stringify(del.body));
    const list = await call('GET', `/film/shots/${shotId}/annotations`);
    assert.strictEqual((list.body.annotations || []).length, 0);
});

test('the board can draw and clear markup, in one file with no build step', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    for (const fn of ['storyboardAnnotate', 'storyboardDrawAnnotations']) {
        assert.ok(new RegExp(`function\\s+${fn}\\s*\\(`).test(html), `the board has no ${fn}`);
    }
    assert.ok(/annotations/.test(html), 'the board never fetches annotations');
    const external = html.match(/<script[^>]+src=["'](?!data:)[^"']+["']/g) || [];
    assert.deepStrictEqual(external, [], `external scripts reintroduce a build step: ${external.join(', ')}`);
});
