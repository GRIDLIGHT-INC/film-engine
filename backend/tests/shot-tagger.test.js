/**
 * Phase 3 — turning a line of screenplay into a shot.
 *
 * The fastest known path from a script to a shot list, and the one we did not
 * have: shots were created by hand or by an agent calling shot_create with a
 * card it had to compose itself. StudioBinder's version is a director selecting
 * a line of action and getting a shot; ours can do more, because the line also
 * says who is in it, and presence is the data three reports are built on.
 *
 * The tagger is therefore two things at once: a shot list builder, and the
 * place where "who is in this shot" is captured at the moment someone is
 * actually looking at the line. Deriving presence later, from the whole scene,
 * is what produced a DRAGON that appeared in no scene.
 *
 * Set-based over the element types that can legitimately become a shot, because
 * the interesting cases are the ones that must NOT: a transition is not a shot,
 * a scene heading is not a shot, and a tagger that turns every element into one
 * produces a shot list nobody can use.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-tagger-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const { handleScripts, handleComments } = require('../routes/scripts');

const SCREENPLAY = `EXT. SUBURBAN STREET - DUSK

Wet asphalt. A sprinkler ticking over a lawn.

MAYA (30s), grocery bag on her hip, looks up.

MAYA
Get inside. GET INSIDE!

The DRAGON drops out of the low cloud, wings cracking like sailcloth.

CUT TO:
`;

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
        // /film/scripts/:id/* is owned by handleComments, the same split the
        // server routes on; /film/projects/:id/* by handleScripts.
        const handler = parts[1] === 'scripts' ? handleComments : handleScripts;
        Promise.resolve(handler({ method, body: body || {} }, res, parts, {}))
            .catch(err => resolve({ status: 500, body: { error: err.message } }));
    });
}

async function projectWithScript() {
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Tagger Test');
    const r = await call('POST', `/film/projects/${projectId}/script`,
        { fountain_content: SCREENPLAY, format: 'fountain', title: 'Wingfall' });
    assert.ok(r.status < 400, `upload failed: ${JSON.stringify(r.body)}`);
    return projectId;
}

function elementsOf(projectId) {
    const script = db.prepare('SELECT id FROM film_scripts WHERE project_id = ? ORDER BY version DESC LIMIT 1').get(projectId);
    return db.prepare('SELECT * FROM film_script_elements WHERE script_id = ? ORDER BY element_index').all(script.id);
}

/**
 * What each element type should become. The refusals carry as much weight as
 * the acceptances: a tagger that makes a shot out of a transition produces a
 * list a director has to clean up, which is worse than typing it.
 */
const TAGGABLE = {
    action: true,
    dialogue: true,
    scene_heading: false,
    transition: false,
    character: false,
    parenthetical: false,
};

test('the taggable set is a subset of the element types the schema permits', () => {
    // Guards against tagging a type that cannot exist, which would silently
    // never fire.
    const fs = require('fs');
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '017_screenplay_fountain.sql'), 'utf8');
    const permitted = [...sql.matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
    const unknown = Object.keys(TAGGABLE).filter(t => !permitted.includes(t));
    assert.deepStrictEqual(unknown, [], `types that the schema does not permit: ${unknown.join(', ')}`);
});

test('every taggable element type produces a shot, and no other type does', async () => {
    const projectId = await projectWithScript();
    const elements = elementsOf(projectId);
    const wrong = [];

    for (const [type, shouldTag] of Object.entries(TAGGABLE)) {
        const el = elements.find(e => e.element_type === type);
        if (!el) continue;   // this screenplay may not contain one
        const r = await call('POST', `/film/scripts/${el.script_id}/tag`, { element_ids: [el.id] });
        const created = (r.body && r.body.created) || [];
        if (shouldTag && created.length !== 1) {
            wrong.push(`${type}: expected a shot, got ${created.length} (${JSON.stringify(r.body).slice(0, 90)})`);
        }
        if (!shouldTag && created.length !== 0) {
            wrong.push(`${type}: produced a shot it should have refused`);
        }
    }
    assert.deepStrictEqual(wrong, [], `\n  ${wrong.join('\n  ')}`);
});

test('a tagged action line becomes the shot description', async () => {
    const projectId = await projectWithScript();
    const el = elementsOf(projectId).find(e => e.element_type === 'action' && /DRAGON/.test(e.text));
    const r = await call('POST', `/film/scripts/${el.script_id}/tag`, { element_ids: [el.id] });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));

    const shotId = r.body.created[0].shot_id;
    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    const card = JSON.parse(shot.scene_card_yaml || '{}');
    assert.ok(/DRAGON/.test(card.description), `the line did not become the description: ${card.description}`);
    assert.ok(shot.shot_code, 'the shot has no code');
});

test('tagging captures who is in the line, including a non-speaker', async () => {
    // The reason this belongs to the tagger rather than to a later pass.
    // Someone is looking at the line; the line names the DRAGON.
    const projectId = await projectWithScript();
    const el = elementsOf(projectId).find(e => e.element_type === 'action' && /DRAGON/.test(e.text));
    const r = await call('POST', `/film/scripts/${el.script_id}/tag`, { element_ids: [el.id] });
    const card = JSON.parse(db.prepare('SELECT scene_card_yaml FROM film_shots WHERE id = ?')
        .get(r.body.created[0].shot_id).scene_card_yaml);
    const names = (card.characters || []).map(n => String(n).toUpperCase());
    assert.ok(names.includes('DRAGON'),
        `the creature in the line is not in the shot's characters: ${JSON.stringify(names)}`);
});

test('tagging dialogue carries the line and its speaker', async () => {
    const projectId = await projectWithScript();
    const el = elementsOf(projectId).find(e => e.element_type === 'dialogue');
    const r = await call('POST', `/film/scripts/${el.script_id}/tag`, { element_ids: [el.id] });
    const card = JSON.parse(db.prepare('SELECT scene_card_yaml FROM film_shots WHERE id = ?')
        .get(r.body.created[0].shot_id).scene_card_yaml);
    assert.ok(Array.isArray(card.dialogue) && card.dialogue.length, 'no dialogue on the card');
    assert.ok(/GET INSIDE/i.test(JSON.stringify(card.dialogue)), 'the line itself is missing');
    assert.ok(/MAYA/i.test(JSON.stringify(card.dialogue)), 'the speaker is missing');
});

test('shots land in the scene the line belongs to', async () => {
    const projectId = await projectWithScript();
    const el = elementsOf(projectId).find(e => e.element_type === 'action' && /sprinkler/i.test(e.text));
    const r = await call('POST', `/film/scripts/${el.script_id}/tag`, { element_ids: [el.id] });
    const shot = db.prepare('SELECT scene_id FROM film_shots WHERE id = ?').get(r.body.created[0].shot_id);
    const scene = db.prepare('SELECT project_id, location FROM film_scenes WHERE id = ?').get(shot.scene_id);
    assert.strictEqual(scene.project_id, projectId, 'the shot landed in another project');
    assert.ok(/SUBURBAN STREET/i.test(scene.location || ''), `wrong scene: ${scene.location}`);
});

test('tagging the same line twice does not make two shots', async () => {
    // A director clicking a line again means "did that work", not "make another".
    const projectId = await projectWithScript();
    const el = elementsOf(projectId).find(e => e.element_type === 'action');
    const first = await call('POST', `/film/scripts/${el.script_id}/tag`, { element_ids: [el.id] });
    const second = await call('POST', `/film/scripts/${el.script_id}/tag`, { element_ids: [el.id] });
    assert.strictEqual((first.body.created || []).length, 1);
    assert.strictEqual((second.body.created || []).length, 0, 'tagged the same line twice');
    assert.ok((second.body.skipped || []).length, 'the second call does not say why it did nothing');
});

test('several lines can be tagged in one pass, in script order', async () => {
    const projectId = await projectWithScript();
    const els = elementsOf(projectId).filter(e => e.element_type === 'action');
    const r = await call('POST', `/film/scripts/${els[0].script_id}/tag`,
        { element_ids: els.map(e => e.id) });
    assert.strictEqual(r.body.created.length, els.length, 'not every line became a shot');
    const codes = r.body.created.map(c => c.shot_code);
    assert.deepStrictEqual(codes, [...codes].sort(), `shots are not in script order: ${codes.join(', ')}`);
});
