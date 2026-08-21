/**
 * Phase 3 — the last of the screenplay work that serves the goal.
 *
 * Scoped AFTER verifying the eight `BELIEVED` cells, which is why it is short:
 * live auto-classification and Tab cycling were believed absent and are present,
 * so two features that would have been rebuilt were already there.
 *
 * What is left divides into two kinds, and only one of them is polish:
 *
 *   - **Export fidelity.** `centered`, `lyrics` and `page_break` are still lost
 *     or flattened on the way to Final Draft. Since finishing happens in the
 *     NLE and the script goes with it, a form that does not survive the export
 *     is a form the film does not have.
 *   - **Revising with a model.** `scene_update` replaces a whole scene, so
 *     changing one line means re-sending every other line and trusting the model
 *     reproduced them. A surgical edit changes named phrases in place and is
 *     all-or-nothing per batch — which is the difference between "try it" and
 *     "commit and hope" when an agent is doing the typing.
 *
 * Set-based over the three export defects and over the ways a batch edit can go
 * wrong, because a partial application is the failure that matters: an edit
 * batch that writes two of three changes leaves a scene nobody wrote.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-polish-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

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
            .catch(err => resolve({ status: 500, body: { error: err.message, stack: err.stack } }));
    });
}

const SCRIPT = `Title: From the Mist

EXT. HARBOUR - DAWN

MAREK stands where the tide should be. The water is gone, and the mud is
already drying at the edges.

MAREK
Lowest since March.

EXT. SLUICE - MORNING

LEY wades out to the gate.
`;

async function project() {
    const { handleScripts } = require('../routes/scripts');
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Polish');
    await callRoute(handleScripts, 'POST', `/film/projects/${projectId}/script`, { fountain_content: SCRIPT });
    return projectId;
}
const scenes = pid => db.prepare(
    `SELECT * FROM film_scenes WHERE project_id = ? AND status != 'removed'
      ORDER BY CAST(scene_number AS INTEGER)`).all(pid);

// ── Export fidelity ─────────────────────────────────────────────────────

/**
 * The three that are still lost, each in its own way. Set-based because a
 * single "handle the rest as Action" satisfies a test for any one of them and
 * re-commits the flattening.
 */
const EXPORT_GAPS = [
    { type: 'centered',   line: '> THE END <',            expect: /Alignment="Center"/i,
      why: 'centring is a paragraph alignment in FDX, not a type' },
    { type: 'lyrics',     line: '~ and the water went out', expect: /Style="Italic"/i,
      why: 'FDX has no lyric type; italics is the honest nearest thing' },
    { type: 'page_break', line: '===',                    expect: /Type="Page Break"|PageBreak/i,
      why: 'a page break is a real FDX paragraph type and was simply dropped' },
];

test('every export gap is closed, and each in its own way', () => {
    const { parseFountain } = require('../lib/fountain-parser');
    const { generateFDX } = require('../lib/fdx-generator');

    const broken = [];
    for (const g of EXPORT_GAPS) {
        const src = `Title: T\n\nEXT. A - DAY\n\nSomething happens.\n\n${g.line}\n`;
        const xml = generateFDX(parseFountain(src), { Title: 'T' });
        if (!g.expect.test(xml)) broken.push(`${g.type}: ${g.why} — not in the export`);
    }
    assert.deepStrictEqual(broken, [], `\n  ${broken.join('\n  ')}`);
});

test('closing the gaps did not turn a note back into script text', () => {
    // The regression that matters. The note bug came FROM a blanket
    // "everything else is Action", so widening the map is exactly when it
    // returns.
    const map = fs.readFileSync(path.join(__dirname, '..', 'lib', 'fdx-generator.js'), 'utf8')
        .match(/FDX_TYPE_MAP\s*=\s*\{([\s\S]*?)\}/)[1];
    assert.ok(!/note:\s*'Action'/.test(map), 'a note is exported as Action again');
    assert.ok(!/\bboneyard\s*:/.test(map), 'boneyard is exported — that resurrects cut scenes');
});

// ── Stats over MCP ──────────────────────────────────────────────────────

test('script_stats reports what a writer actually asks', async () => {
    const { handleScripts } = require('../routes/scripts');
    const pid = await project();
    const r = await callRoute(handleScripts, 'GET', `/film/projects/${pid}/script/stats`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const missing = ['words', 'pages', 'scenes', 'dialogue_percentage', 'characters']
        .filter(k => r.body[k] === undefined);
    assert.deepStrictEqual(missing, [], `stats omit: ${missing.join(', ')}`);
    assert.ok(r.body.words > 0, 'a script with dialogue reports zero words');
    assert.ok(r.body.scenes === 2, `expected 2 scenes, got ${r.body.scenes}`);
});

// ── Surgical edit ───────────────────────────────────────────────────────

test('a named phrase is changed in place, leaving the rest byte-identical', async () => {
    const { handleScenes } = require('../routes/scenes');
    const pid = await project();
    const scene = scenes(pid)[0];
    const before = scene.description;

    const r = await callRoute(handleScenes, 'POST', `/film/scenes/${scene.id}/edit`, {
        edits: [{ find: 'Lowest since March.', replace: 'Lowest I have seen.' }],
    });
    assert.ok(r.status < 400, JSON.stringify(r.body));

    const { handleScripts } = require('../routes/scripts');
    const f = await callRoute(handleScripts, 'GET', `/film/projects/${pid}/script/latest/fountain`);
    assert.match(f.body.fountain_content, /Lowest I have seen\./);
    assert.ok(!/Lowest since March/.test(f.body.fountain_content), 'the old phrase survived');
    // Everything around it is untouched — the reason to have this at all.
    assert.match(f.body.fountain_content, /mud is\nalready drying at the edges/,
        'the surrounding action was reflowed by a one-phrase edit');
    void before;
});

test('a phrase that appears twice is refused, not guessed', async () => {
    // Ambiguity is the failure mode: silently changing the first occurrence is
    // how a model edits the wrong line and nobody notices for three scenes.
    const { handleScenes } = require('../routes/scenes');
    const pid = await project();
    const scene = scenes(pid)[0];
    const r = await callRoute(handleScenes, 'POST', `/film/scenes/${scene.id}/edit`, {
        edits: [{ find: 'the', replace: 'THE' }],
    });
    assert.ok(r.status >= 400, `an ambiguous find was applied: ${JSON.stringify(r.body)}`);
    assert.match(JSON.stringify(r.body), /occurrence|ambiguous|all/i,
        'the refusal does not say how to resolve it');
});

test('all: true applies every occurrence deliberately', async () => {
    const { handleScenes } = require('../routes/scenes');
    const pid = await project();
    const scene = scenes(pid)[0];
    const r = await callRoute(handleScenes, 'POST', `/film/scenes/${scene.id}/edit`, {
        edits: [{ find: 'the', replace: 'THE', all: true }],
    });
    assert.ok(r.status < 400, JSON.stringify(r.body));
    assert.ok(r.body.edits_applied >= 1);
});

test('a phrase that is not there is refused before anything is written', async () => {
    const { handleScenes } = require('../routes/scenes');
    const pid = await project();
    const scene = scenes(pid)[0];
    const versions = db.prepare('SELECT COUNT(*) n FROM film_scripts WHERE project_id = ?').get(pid).n;
    const r = await callRoute(handleScenes, 'POST', `/film/scenes/${scene.id}/edit`, {
        edits: [{ find: 'a line that was never written', replace: 'x' }],
    });
    assert.ok(r.status >= 400, 'a missing phrase was accepted');
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM film_scripts WHERE project_id = ?').get(pid).n,
        versions, 'a failed edit still wrote a version');
});

test('if any edit in a batch fails, NONE are written', async () => {
    // The property that makes a batch usable by a model. A batch that writes two
    // of three changes leaves a scene nobody wrote and nobody can reconstruct.
    const { handleScenes } = require('../routes/scenes');
    const { handleScripts } = require('../routes/scripts');
    const pid = await project();
    const scene = scenes(pid)[0];
    const before = (await callRoute(handleScripts, 'GET', `/film/projects/${pid}/script/latest/fountain`))
        .body.fountain_content;

    const r = await callRoute(handleScenes, 'POST', `/film/scenes/${scene.id}/edit`, {
        edits: [
            { find: 'Lowest since March.', replace: 'Lowest I have seen.' },   // valid
            { find: 'a line that was never written', replace: 'x' },           // invalid
        ],
    });
    assert.ok(r.status >= 400, 'a batch with a bad edit was applied');

    const after = (await callRoute(handleScripts, 'GET', `/film/projects/${pid}/script/latest/fountain`))
        .body.fountain_content;
    assert.strictEqual(after, before,
        'a failing batch applied its valid edits — the scene is now something nobody wrote');
    assert.match(JSON.stringify(r.body), /Lowest since March|1 of 2|none were applied|which/i,
        'the refusal does not say which edit failed');
});

test('rewriting DIALOGUE marks the scene as changed', async () => {
    // The bug this phase found. `film_scenes.description` holds ACTION only —
    // the parser never put dialogue in it — so `sceneFingerprint` could not see
    // a dialogue rewrite, and every shot in the scene went on reporting as
    // current. It is the most consequential thing it could have missed:
    // dialogue is what gets rewritten most and is the direct input to voice
    // generation, so a line changed after the voice was cut left an audio file
    // saying something the script no longer says.
    const { handleScenes } = require('../routes/scenes');
    const { handleShots } = require('../routes/shots');
    const pid = await project();
    const scene = scenes(pid)[0];

    // Dialogue lives on the shot card, which is what generation reads.
    await callRoute(handleShots, 'POST', '/film/shots', {
        scene_id: scene.id,
        cards: [{ shot_code: '1A', action: 'MAREK at the window.',
            dialogue: [{ character: 'MAREK', line: 'Lowest since March.' }] }],
    });
    const { stampScene, sceneFingerprint } = require('../lib/screenplay-drift');
    stampScene(scene.id);
    const before = db.prepare('SELECT source_fingerprint FROM film_scenes WHERE id = ?').get(scene.id).source_fingerprint;

    const shot = db.prepare('SELECT id, scene_card_yaml FROM film_shots WHERE scene_id = ?').get(scene.id);
    const card = JSON.parse(shot.scene_card_yaml);
    card.dialogue = [{ character: 'MAREK', line: 'Lowest I have ever seen.' }];
    db.prepare('UPDATE film_shots SET scene_card_yaml = ? WHERE id = ?').run(JSON.stringify(card), shot.id);

    const after = sceneFingerprint(db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(scene.id));
    assert.notStrictEqual(after, before,
        'a dialogue rewrite does not move the fingerprint — the scene reports as current');
});

test('widening the fingerprint does not report old work as behind', () => {
    // A scene stamped under the pre-dialogue formula and otherwise untouched is
    // a re-baseline, not a rewrite. Without this, the first save after the
    // change would light up every board with drift for work nobody touched —
    // and a warning that fires on work nobody needs to redo is one people learn
    // to dismiss.
    const { stampScene, legacySceneFingerprint } = require('../lib/screenplay-drift');
    const pid = generateId(), sid = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(pid, 'Legacy');
    db.prepare(`INSERT INTO film_scenes (id, project_id, scene_number, int_ext, location, description)
                VALUES (?, ?, '1', 'EXT', 'HARBOUR', 'The water is gone.')`).run(sid, pid);
    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(sid);

    // Stamp it the way the old formula would have, with a timestamp.
    db.prepare("UPDATE film_scenes SET source_fingerprint = ?, source_changed_at = '2020-01-01 00:00:00' WHERE id = ?")
        .run(legacySceneFingerprint(scene), sid);
    const at = db.prepare('SELECT source_changed_at FROM film_scenes WHERE id = ?').get(sid).source_changed_at;

    stampScene(sid);
    const after = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(sid);
    assert.notStrictEqual(after.source_fingerprint, legacySceneFingerprint(scene),
        'the scene was not re-baselined onto the new formula');
    assert.strictEqual(after.source_changed_at, at,
        're-baselining moved the timestamp — every existing scene now reports as rewritten');
});

test('a surgical edit to ACTION still marks the scene as changed', async () => {
    // It IS a rewrite of screenplay text, however small. Anything generated from
    // this scene is now behind, and staying quiet about it would be worse than
    // the false-drift problem it superficially resembles.
    const { handleScenes } = require('../routes/scenes');
    const pid = await project();
    const scene = scenes(pid)[0];
    const before = scene.source_fingerprint;
    await callRoute(handleScenes, 'POST', `/film/scenes/${scene.id}/edit`, {
        edits: [{ find: 'MAREK stands where the tide should be.', replace: 'MAREK stands in the mud.' }],
    });
    const after = db.prepare('SELECT source_fingerprint FROM film_scenes WHERE id = ?').get(scene.id);
    assert.notStrictEqual(after.source_fingerprint, before,
        'an edit to screenplay text did not mark the scene as changed');
});

// ── Surface ─────────────────────────────────────────────────────────────

test('the phase 3 surface is on MCP and routed by the server', () => {
    const { listTools } = require('../lib/mcp-tools');
    const names = listTools().map(t => t.name);
    const missing = ['scene_edit', 'script_stats'].filter(n => !names.includes(n));
    assert.deepStrictEqual(missing, [], `missing MCP tools: ${missing.join(', ')}`);

    const tool = listTools().find(t => t.name === 'scene_edit');
    assert.match(tool.description, /all-or-nothing|none are written|atomic/i,
        'scene_edit does not tell a model the batch is atomic — the property it needs most');
});
