/**
 * A SHOT'S OWN NEGATIVE PROMPT CAN BE WRITTEN, AND IT REACHES THE PROMPT.
 *
 * buildStoryboardPrompt has always appended card.generation.negative_prompt
 * to the defaults — for the frame and, through video-prompt, for the clip —
 * but the shot edit route accepted a fixed field list without `generation`,
 * so nothing could ever set it. Found writing "never a morph, never a
 * dissolve" onto the Drive-In Outreach rebuild shots: the edit reported
 * success and silently dropped the field.
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-negative-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();
const { handleShots } = require('../routes/shots');
const { buildStoryboardPrompt } = require('../lib/storyboard-prompt');

function put(shotId, body) {
    return new Promise(resolve => {
        const chunks = [];
        const res = new Writable({ write(c, _e, n) { chunks.push(c); n(); } });
        res.statusCode = 200;
        res.writeHead = function (code) { this.statusCode = code; return this; };
        res.setHeader = function () {};
        res.on('finish', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }));
        Promise.resolve(handleShots({ method: 'PUT', body, headers: {} }, res, ['film', 'shots', shotId], {}))
            .catch(err => resolve({ status: 500, body: { error: err.message } }));
    });
}

function makeShot() {
    const p = generateId(), s = generateId(), id = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(p, 'Neg');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, ?)').run(s, p, '1');
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)')
        .run(id, s, '1B', JSON.stringify({ shot_code: '1B', description: 'The bottle rebuilds into the watch.',
            generation: { generation_hint: 'kept' } }));
    return id;
}
const card = id => JSON.parse(db.prepare('SELECT scene_card_yaml FROM film_shots WHERE id = ?').get(id).scene_card_yaml);

test('the edit route stores generation.negative_prompt and merges the block', async () => {
    const id = makeShot();
    const r = await put(id, { generation: { negative_prompt: 'morph, dissolve' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(card(id).generation.negative_prompt, 'morph, dissolve');
    assert.strictEqual(card(id).generation.generation_hint, 'kept', 'writing one key erased its siblings');
});

test('a malformed block is refused and writes nothing', async () => {
    const id = makeShot();
    const r = await put(id, { generation: { negative_prompt: ['morph'] } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(card(id).generation.negative_prompt, undefined);
});

test('the stored negative reaches the assembled negative prompt', async () => {
    const id = makeShot();
    await put(id, { generation: { negative_prompt: 'morph, dissolve' } });
    const out = buildStoryboardPrompt(card(id), [], null, '', {});
    assert.match(out.negative_prompt, /morph, dissolve/);
});

test('the MCP tool exposes the field, so an agent is not silently dropped', () => {
    const src = require('fs').readFileSync(path.join(__dirname, '..', 'lib', 'mcp-tools.js'), 'utf8');
    const at = src.indexOf("name: 'shot_update'");
    assert.match(src.slice(at, at + 6000), /generation: \{ type: 'object'/);
});
