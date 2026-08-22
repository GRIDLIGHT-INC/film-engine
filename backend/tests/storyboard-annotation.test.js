/**
 * Phase 3 — marking up a generated frame.
 *
 * A director's fastest notation is not a sentence, it is an arrow. "Move her
 * left, push in past the mailbox" takes three strokes and a word, and we had no
 * way to put any of it on a frame: the board was pictures you could regenerate
 * and nothing you could draw on.
 *
 * StudioBinder's version instructs a human artist. Ours does not stop there —
 * markup can feed the next generation — but that is a separate feature, off by
 * default, and tested separately in annotation-feedback.test.js (PAR-026). What
 * this file covers is the notation itself: store it, show it, keep it with the
 * frame, whether or not anything downstream reads it.
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

/** The same shim, for any route handler. */
function callRoute(handler, method, urlPath, body) {
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
        Promise.resolve(handler({ method, body: body || {} }, res, parts, {}))
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
    for (const fn of ['markupArm', 'markupDraw', 'markupCommit', 'storyboardDrawAnnotations']) {
        assert.ok(new RegExp(`function\\s+${fn}\\s*\\(`).test(html), `the board has no ${fn}`);
    }
    assert.ok(/annotations/.test(html), 'the board never fetches annotations');
    const external = html.match(/<script[^>]+src=["'](?!data:)[^"']+["']/g) || [];
    assert.deepStrictEqual(external, [], `external scripts reintroduce a build step: ${external.join(', ')}`);
});

/**
 * Both surfaces, every shape.
 *
 * The grid card had four of the six kinds and the full-screen viewer had none —
 * so the surface where a frame is actually judged, at size, was the one you
 * could not draw on. And the two toolbars were separate literals, which is how
 * they came to disagree in the first place: markupToolbar() is now the only
 * place a shape button is written, and this asserts both surfaces call it.
 */
test('every shape the route accepts has a control on both surfaces', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');

    const toolbar = html.match(/function markupToolbar[\s\S]*?\n    }/);
    assert.ok(toolbar, 'there is no single markup toolbar');
    const kinds = html.match(/const MARKUP_KINDS = \[([^\]]+)\]/);
    assert.ok(kinds, 'the UI declares no shape list');
    const uiKinds = kinds[1].split(',').map(k => k.trim().replace(/['"]/g, '')).filter(Boolean);

    assert.deepStrictEqual(uiKinds.slice().sort(), ANNOTATION_KINDS.slice().sort(),
        'the toolbar and the route disagree about which shapes exist');

    // Both surfaces build their controls from that one function, with their own
    // canvas and their own image — the image matters because the viewer letterboxes
    // and the grid does not, and a mark normalised against the wrong rect lands
    // in the wrong place on exactly one of them.
    for (const [canvas, img] of [["'annot-' + f.shot_id", "'img-' + f.shot_id"],
                                 ["'frameViewerAnnot'", "'frameViewerImg'"]]) {
        const call = new RegExp(`markupToolbar\\([^)]*${canvas.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
        assert.ok(call.test(html), `no markup toolbar is built for ${canvas}`);
        assert.ok(html.includes(img), `${img} is never referenced, so marks cannot be placed against the picture`);
    }

    // Drag, not click-twice. The old gesture gave no feedback on the first
    // click, which is precisely why the buttons read as doing nothing.
    for (const handler of ['onpointerdown', 'onpointermove', 'onpointerup']) {
        assert.ok(html.includes(`canvas.${handler}`), `markup never handles ${handler}, so it cannot be dragged`);
    }
});

/**
 * A shot's card can be read as well as written.
 *
 * There was a PUT and no GET, so the editor could only ever show the fields the
 * storyboard panel happened to carry — and an agent had to list a whole project
 * to read the one row it was about to change.
 */
test('a shot card can be read back through its own route', async () => {
    const { handleShots } = require('../routes/shots');
    const { shotId } = makeShot();
    const res = await callRoute(handleShots, 'GET', `/film/shots/${shotId}`);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.id, shotId);
    assert.ok(res.body.card && typeof res.body.card === 'object', 'no card came back');
    assert.strictEqual(res.body.card.description, 'x', 'the card came back without its own words');
});

test('a missing shot is a 404, not an empty card', async () => {
    const { handleShots } = require('../routes/shots');
    const res = await callRoute(handleShots, 'GET', `/film/shots/${generateId()}`);
    assert.strictEqual(res.status, 404);
});

/**
 * A regenerated frame has to be visibly regenerated.
 *
 * The image path never changes when a frame is regenerated — the file is
 * overwritten at the same name — so the browser served the cached image and the
 * board looked byte-identical after a successful, paid-for regeneration. The
 * screen literally showed "nothing happened", and the honest response to that
 * is to press regenerate again and pay a second time.
 *
 * Keyed on asset_version, not on a timestamp: busting on every render would
 * re-download every image on the board each time the page refreshed, which on a
 * feature-length board is a lot of bytes spent hiding one bug.
 */
test('a frame URL is keyed to the version of the frame', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    assert.ok(/function frameSrc\(/.test(html), 'frames are still requested at a fixed path');
    const fn = html.slice(html.indexOf('function frameSrc('));
    const body = fn.slice(0, fn.indexOf('\n    }'));
    assert.ok(/asset_version/.test(body), 'the URL carries no version, so a regenerated frame stays cached');
    assert.ok(!/Date\.now\(\)/.test(body),
        'the URL busts on every render, re-downloading every unchanged frame on the board');

    // Both surfaces must use it, or the viewer shows a stale frame over a
    // fresh grid — which is worse than both being stale, because it looks
    // like the regeneration only half worked.
    for (const surface of ['img id="img-${f.shot_id}" src="${frameSrc(f)}"', "frameViewerImg').src = frameSrc(f)"]) {
        assert.ok(html.includes(surface), `a surface still builds its own frame URL: ${surface}`);
    }
});

test('a generating frame says so on the frame', () => {
    // "Regenerating..." went to the status bar at the bottom of the screen while
    // the card you clicked looked exactly as it had a moment before — for up to
    // a minute, since the provider chain may walk past a decline before one
    // accepts. A button that appears to do nothing gets pressed again.
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    assert.ok(/function frameBusy\(/.test(html), 'nothing marks the frame being generated');
    assert.ok(/frameBusy\(shotId/.test(html), 'the regenerate path never marks its frame');
    assert.ok(/\.frame-busy \{/.test(html), 'the busy overlay has no styling, so it renders as nothing');
    // The card's buttons are disabled while it works, because the one thing a
    // slow generation invites is a second click on a paid action.
    assert.ok(/b\.disabled = true/.test(html), 'the regenerate button stays clickable while it runs');
});

/**
 * Every attempt is kept, because every attempt cost money.
 *
 * Regeneration wrote to the same filename, so the asset ledger recorded six
 * versions of one frame and the disk held one picture. Five images that were
 * paid for were gone, and each row claiming them pointed at whichever file
 * happened to be there last — which is worse than not recording them at all,
 * since A/B compare and the version list both read those rows and would show
 * the newest frame six times over while calling it history.
 */
test('a superseded frame is archived before it is overwritten', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'storyboard.js'), 'utf8');
    assert.ok(/function archiveExistingFrame\(/.test(src), 'nothing archives a replaced frame');
    assert.ok(/storyboardVersionPath\(/.test(src), 'there is no per-version path');

    // Every write of a frame archives first. One path that does not is a shot
    // whose history silently stops.
    //
    // Counted by DESTINATION, not by call name or buffer name. Matching
    // `writeFileSync(imgPath, buffer)` missed refine when it arrived — hence
    // the earlier widening — and then missed restore, which puts an older
    // attempt back with copyFileSync and has a destination variable of its own.
    // A path that replaces the live frame is a path that must archive first,
    // however it does the writing.
    // Destination only: writeFileSync takes it first, copyFileSync second. The
    // archive's own `copyFileSync(current, dest)` reads FROM the live frame and
    // must not be counted as a write of it, or the archive would be required to
    // archive itself.
    // `live` joined imgPath/current when selecting a version became a pointer
    // move: it copies the chosen attempt onto the live frame without
    // registering anything, so it writes a frame under a third name.
    /*
     * Per FUNCTION, not by count.
     *
     * This compared two totals, which is a proxy: sending a frame to another
     * shot archives TWICE for one write — the target's outgoing picture, then
     * the arriving one, which is live and its own version at the same moment
     * and would otherwise be overwritten before anything kept a copy. Equal
     * totals said that was broken. What actually matters is that no function
     * writes the live frame without archiving, which is the thing a shot's
     * history depends on.
     *
     * Destination only: writeFileSync takes it first, copyFileSync second. The
     * archive's own copyFileSync(current, dest) reads FROM the live frame and
     * must not count as a write of it, or the archive would have to archive
     * itself.
     */
    const LIVE_FRAME = /fs\.writeFileSync\(\s*(?:imgPath|current|live)\b|fs\.copyFileSync\([^,)]+,\s*(?:imgPath|current|live)\b/;
    const writers = new Set(), archivers = new Set();
    let fn = null;
    for (const line of src.split('\n')) {
        const m = line.match(/^(?:async )?function (\w+)\(/);
        if (m) fn = m[1];
        if (!fn || fn === 'archiveExistingFrame') continue;
        if (LIVE_FRAME.test(line)) writers.add(fn);
        if (/archiveExistingFrame\(/.test(line)) archivers.add(fn);
    }
    assert.ok(writers.size > 0, 'no frame is written anywhere');
    const unarchived = [...writers].filter(f => !archivers.has(f));
    assert.deepStrictEqual(unarchived, [],
        `these replace the live frame without archiving it first, so a shot's history `
        + `silently stops there: ${unarchived.join(', ')}`);
});

test('the archived row points at the archived file', () => {
    // Otherwise the ledger still claims a version whose pixels were replaced,
    // which is the bug with an extra step.
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'storyboard.js'), 'utf8');
    const fn = src.slice(src.indexOf('function archiveExistingFrame('));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.ok(/UPDATE film_assets SET file_path = \?/.test(body),
        'the old row is left pointing at the current frame');
    assert.ok(/catch \(_\) \{ return null; \}/.test(body),
        'a failed archive can fail a generation that already succeeded');
});

test('regen is visible from every place it can be pressed', () => {
    // It marked only the board card. Pressed from the viewer the overlay went
    // behind the modal; pressed from the detail panel it marked nothing at all.
    // Both look exactly like a button that does nothing.
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const fn = html.slice(html.indexOf('function frameBusy(shotId, label)'));
    const body = fn.slice(0, fn.indexOf('\n    }'));
    for (const surface of ['img-', 'frameViewerImg', 'shotDetailPanel']) {
        assert.ok(body.includes(surface), `frameBusy does not mark ${surface}`);
    }
    assert.ok(/offsetParent/.test(body),
        'a surface that is not on screen is still marked, so the overlay lands where nobody can see it');
});


test('markup is visible in the stage you restage against', () => {
    // Markup reached the prompt and the previs payload previews; what it never
    // did was appear in the one place you go to restage the shot. Previs stands
    // the generated frame in the world so a new angle can be judged against it
    // — and the arrows drawn on that frame, which are the reason you are there,
    // were invisible.
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const missing = [];
    if (!/function previsDrawKeyframeMarkup/.test(html)) missing.push('nothing draws markup in the stage');
    if (!/previsDrawKeyframeMarkup\(ctx,/.test(html)) missing.push('the stage never calls it');
    if (!/markupLoad\(shotId\)\.then/.test(html)) missing.push('previs never loads the shot\u2019s markup');
    // It must reuse the board's renderer, or the same arrow is two shapes.
    const fn = html.slice(html.indexOf('function previsDrawKeyframeMarkup'),
        html.indexOf('function previsDrawKeyframeMarkup') + 1600);
    if (!/markupShape\(/.test(fn)) missing.push('the stage draws markup with its own renderer');
    assert.deepStrictEqual(missing, [], `\n  ${missing.join('\n  ')}`);
});

test('previs reads markup and does not act on it', () => {
    // An arrow is notation. The thing that moves a previs camera is the
    // blocking, and two systems claiming to set the same camera is exactly how
    // they come to disagree — the reason the storyboard and the board's facets
    // were unified onto one precedence rule.
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const fn = html.slice(html.indexOf('function previsDrawKeyframeMarkup'),
        html.indexOf('function previsDrawKeyframeMarkup') + 1600);
    for (const forbidden of ['PREVIS.camera =', 'previsSolve(', 'previsApply(']) {
        assert.ok(!fn.includes(forbidden),
            `the stage acts on markup (${forbidden}) instead of only showing it`);
    }
});
