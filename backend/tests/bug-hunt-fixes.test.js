/**
 * The bug hunt's fix plan, held to the code.
 *
 * Static analysis, a dead-code scan and a bug-pattern hunt found 24 issues.
 * The worst was reproduced: one POST to /refsheet/orbit with a made-up id
 * killed the whole API, because an async route's rejection escaped the
 * request handler's try/catch (the dispatch was `return handleX(...)`, not
 * `return await`) and nothing handled it at process level.
 *
 * Every assertion here is set-based where there is a set — every dispatch
 * call, every file stream, every empty catch in the orchestrator — because a
 * fix applied to 96 of 97 call sites is indistinguishable from a working one
 * until the 97th route throws.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-bughunt-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const BACKEND = path.join(__dirname, '..');
const ROOT = path.join(BACKEND, '..');
const read = rel => fs.readFileSync(path.join(BACKEND, rel), 'utf8');
const codeOnly = src => src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

function callRoute(handler, method, urlPath, body) {
    return new Promise(resolve => {
        const parts = urlPath.split('?')[0].split('/').filter(Boolean);
        const chunks = [];
        const res = new Writable({ write(c, _e, n) { chunks.push(c); n(); } });
        res.statusCode = 200;
        res.writeHead = function (code) { this.statusCode = code; this.headersSent = true; return this; };
        res.setHeader = function () {};
        res.on('finish', () => {
            let parsed = Buffer.concat(chunks).toString();
            try { parsed = JSON.parse(parsed); } catch (_) { /* not json */ }
            resolve({ status: res.statusCode, body: parsed });
        });
        Promise.resolve(handler({ method, body: body || {}, headers: {} }, res, parts, {}))
            .catch(err => resolve({ status: 'threw', body: { error: err.message } }));
    });
}

// ── P0 ─────────────────────────────────────────────────────────────────────

test('every route dispatch in the server is awaited, so a failing route cannot escape the handler', () => {
    const src = codeOnly(read('server.js'));
    const all = src.match(/return\s+(await\s+)?handle[A-Za-z]*\(/g) || [];
    assert.ok(all.length > 90, `the dispatch scan found only ${all.length} calls — it is not reading the server`);
    const bare = all.filter(s => !/await/.test(s));
    assert.deepStrictEqual(bare, [], `${bare.length} of ${all.length} route calls are not awaited`);
});

test('both servers log an unhandled rejection instead of dying on it', () => {
    for (const f of ['server.js', 'mcp-server.js']) {
        assert.match(read(f), /process\.on\(\s*['"]unhandledRejection['"]/, `${f} has no unhandledRejection handler`);
    }
});

test('the orbit routes answer rather than throwing', async () => {
    const { handleCharacters } = require('../routes/characters');
    const fake = generateId();
    for (const [method, url] of [['GET', `/film/characters/${fake}/refsheet/orbit/preview`],
                                 ['POST', `/film/characters/${fake}/refsheet/orbit`]]) {
        const r = await callRoute(handleCharacters, method, url);
        assert.notStrictEqual(r.status, 'threw', `${method} ${url} threw: ${r.body.error}`);
        assert.strictEqual(r.status, 404, `${method} ${url} → ${r.status}`);
    }
});

test('deleting a character view keeps its picture under deleted/', async () => {
    const { handleCharacters } = require('../routes/characters');
    const projectId = generateId(), charId = generateId();
    db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Del')").run(projectId);
    db.prepare("INSERT INTO film_characters (id, project_id, name) VALUES (?, ?, 'ANN')").run(charId, projectId);
    const dir = path.join(process.env.FILM_DATA_DIR, 'refsheets', projectId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'ANN_back.png');
    fs.writeFileSync(file, 'png');
    db.prepare(`INSERT INTO film_assets (id, project_id, character_id, asset_type, file_name, file_path, metadata)
                VALUES (?, ?, ?, 'character_sheet', 'ANN_back.png', ?, '{"view":"back"}')`).run(generateId(), projectId, charId, file);
    const r = await callRoute(handleCharacters, 'DELETE', `/film/characters/${charId}/refsheet/views/back`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(!fs.existsSync(file), 'the file was left where it was');
    const kept = fs.readdirSync(path.join(dir, 'deleted'));
    assert.ok(kept.some(n => n.endsWith('_ANN_back.png')), `nothing under deleted/: ${kept}`);
});

test('no file is streamed to a response without an error handler', () => {
    const files = [...fs.readdirSync(path.join(BACKEND, 'lib')).map(f => 'lib/' + f),
                   ...fs.readdirSync(path.join(BACKEND, 'routes')).map(f => 'routes/' + f)].filter(f => f.endsWith('.js'));
    const raw = [];
    for (const f of files) {
        codeOnly(read(f)).split('\n').forEach((l, i) => {
            if (/createReadStream\(/.test(l) && !/function pipeFile/.test(l) && f !== 'lib/file-storage.js') raw.push(`${f}:${i + 1}`);
        });
    }
    assert.deepStrictEqual(raw, [], 'streams outside pipeFile: ' + raw.join(', '));
    const fsSrc = read('lib/file-storage.js');
    const streams = (fsSrc.match(/createReadStream\(/g) || []).length;
    assert.strictEqual(streams, 1, `file-storage opens ${streams} streams; only pipeFile may`);
    assert.match(fsSrc, /function pipeFile[\s\S]{0,600}\.on\(\s*'error'/, 'pipeFile does not handle a stream error');
});

test('a file that vanishes mid-serve closes the response instead of crashing', async () => {
    const { pipeFile } = require('../lib/file-storage');
    const done = await new Promise(resolve => {
        const res = new Writable({ write(c, _e, n) { n(); } });
        res.headersSent = true;
        res.destroy = () => resolve('destroyed');
        res.on('finish', () => resolve('finished'));
        pipeFile(path.join(os.tmpdir(), 'no-such-file-' + generateId()), res);
    });
    assert.strictEqual(done, 'destroyed');
});

test('a preset path outside the Native Instruments folders is refused without saying whether it exists', async () => {
    const { handleInstruments } = require('../routes/instruments');
    const a = await callRoute(handleInstruments, 'POST', '/film/instruments', { preset_path: '/etc/hosts', plugin: 'x' });
    const b = await callRoute(handleInstruments, 'POST', '/film/instruments', { preset_path: '/nope/secret.nksf', plugin: 'x' });
    assert.strictEqual(a.status, 400);
    assert.strictEqual(b.status, 400);
    assert.strictEqual(a.body.error, b.body.error, 'the refusal differs by whether the file exists — a file-existence oracle');
});

// ── P1 ─────────────────────────────────────────────────────────────────────

test('a streaming model call is aborted when the browser disconnects', () => {
    const src = read('lib/providers/anthropic.js');
    assert.match(src, /signal:\s*controller\.signal/, 'the Anthropic stream has no abort signal');
    assert.match(src, /res\.on\(\s*'close'/, 'nothing aborts the Anthropic stream when the response closes');
    for (const f of ['routes/breakdown.js', 'routes/screenplay-ai.js']) {
        const n = (codeOnly(read(f)).match(/\bclientGone\b/g) || []).length;
        assert.ok(n > 2, `${f}: clientGone is set and never read`);
    }
});

test('the page calls no function and reads no global it never defines', () => {
    const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
    for (const name of ['SCENE_SHOTS', 'confirmGen']) {
        const uses = (html.match(new RegExp('\\b' + name + '\\b(?!\\w)(?!Resolve|Arm|Edited|Modal|Body|Title|Prompt)', 'g')) || []).length;
        const defined = new RegExp('(function|const|let|var)\\s+' + name + '\\b').test(html);
        assert.ok(uses === 0 || defined, `${name} is used ${uses} time(s) and defined nowhere`);
    }
});

test('the instrument sidecar has no undefined name in its capture', () => {
    const src = read('instrument-sidecar.py');
    const capture = src.slice(src.indexOf('def op_capture'), src.indexOf('\ndef ', src.indexOf('def op_capture') + 5));
    assert.ok(!/'plugin':\s*plugin\b/.test(capture), "op_capture reads a 'plugin' variable it never defines");
});

test('a plate view reports the size and format measured from its file', async () => {
    const { handleLocations } = require('../routes/locations');
    const projectId = generateId(), locId = generateId();
    db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Sz')").run(projectId);
    db.prepare("INSERT INTO film_locations (id, project_id, name) VALUES (?, ?, 'DINER')").run(locId, projectId);
    const dir = path.join(process.env.FILM_DATA_DIR, 'refsheets', projectId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'location_DINER.png');
    fs.writeFileSync(file, Buffer.alloc(1234));
    db.prepare(`INSERT INTO film_assets (id, project_id, location_id, asset_type, file_name, file_path, metadata)
                VALUES (?, ?, ?, 'reference_image', 'location_DINER.png', ?, '{}')`).run(generateId(), projectId, locId, file);
    const r = await callRoute(handleLocations, 'GET', `/film/locations/${locId}/plate/views`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const v = r.body.views[0];
    assert.strictEqual(v.bytes, 1234, 'the measured size was overwritten by an empty column');
    assert.strictEqual(v.format, 'png');
});

test('every catch in the orchestrator says what it swallowed', () => {
    const empty = codeOnly(read('routes/pipeline.js')).match(/catch\s*(\([^)]*\))?\s*\{\s*\}/g) || [];
    assert.strictEqual(empty.length, 0, `${empty.length} empty catch block(s) in routes/pipeline.js`);
});

test('a prompt trimmed at a sentence end keeps its full stop', () => {
    const { trimToAllowance } = require('../lib/storyboard-prompt');
    assert.strictEqual(trimToAllowance('The dog ran home. Then it slept by the long warm fire all night.', 30), 'The dog ran home.');
});

// ── P2 ─────────────────────────────────────────────────────────────────────

test('no constant or undefined leftovers in the provider paths', () => {
    assert.ok(!/\|\|\s*true\)/.test(read('lib/providers/credentials.js')), 'credentials.js still has `|| true`');
    assert.ok(!/\|\|\s*provider\.id/.test(read('routes/storyboard.js')), 'storyboard.js still falls back to an undefined `provider`');
});

/*
 * Thirteen page functions are called by nothing on the page. Seven of them —
 * worldOccupancy, inspectEntity, ssBusy, generateLocationImage,
 * generatePropImage, applyStyleBookEntry, addScreenplayComment — are held to
 * existing behaviour by other test files, so they stay until those tests are
 * revisited; the six nothing depends on are gone.
 */
test('the page functions nothing calls and nothing tests are gone', () => {
    const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
    const DEAD = ['openAIGenerateModal', 'executeAIGenerate', 'ssPlates', 'toggleComments',
        'parseTripletInput', 'pgMoney'];
    const left = DEAD.filter(n => new RegExp('function\\s+' + n + '\\s*\\(').test(html));
    assert.deepStrictEqual(left, []);
});
