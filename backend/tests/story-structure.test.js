/**
 * Phase 2b — the four features from writers-tool worth having.
 *
 * The writers-tool agent named five that justify the exercise; four are here
 * (the fifth, surgical `edit_document`, is a different shape of change and is
 * left for phase 3). Each was tested against commitment 1 — *the Fountain
 * document is the single source of truth, and any row proposing a new table must
 * argue why the format cannot hold it* — and they did not all answer the same
 * way. That is the interesting part:
 *
 *   - **Beat sheets** need a table. Fountain cannot say "this scene is the
 *     Midpoint" in any form you can query, and the whole value is the query:
 *     what is NOT linked is where the structure has a hole.
 *   - **Scene cards** need columns. Conflict and outcome are *about* a scene
 *     rather than in it, and a synopsis line is prose you cannot sort on.
 *   - **Format directives** need one column. How a film should be WRITTEN is not
 *     part of what is written.
 *   - **Per-scene history needs NOTHING.** Every version of every scene is
 *     already in `film_scripts` — one full Fountain per version — so history is
 *     a view over documents we keep anyway, and restore is a splice we already
 *     have. Adding a table would have been storing what we can derive.
 *
 * Set-based over the four frameworks and the four features, because a beat-sheet
 * implementation that handles Save the Cat and quietly breaks on Story Circle
 * passes any example test, and the frameworks differ in beat count and shape.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-story-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

function callRoute(handler, method, urlPath, body) {
    return new Promise(resolve => {
        const u = urlPath.split('?');
        const parts = u[0].split('/').filter(Boolean);
        const query = {};
        for (const kv of (u[1] || '').split('&').filter(Boolean)) {
            const [k, v] = kv.split('='); query[k] = decodeURIComponent(v === undefined ? '' : v);
        }
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
        Promise.resolve(handler({ method, body: body || {} }, res, parts, query))
            .catch(err => resolve({ status: 500, body: { error: err.message, stack: err.stack } }));
    });
}

const SCRIPT = `Title: From the Mist

EXT. HARBOUR - DAWN

The water is gone.

EXT. SLUICE - MORNING

Rust where water should be.

EXT. THE FLATS - LATER

Ground that was never ground.
`;

async function project() {
    const { handleScripts } = require('../routes/scripts');
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Story');
    await callRoute(handleScripts, 'POST', `/film/projects/${projectId}/script`, { fountain_content: SCRIPT });
    return projectId;
}
const scenes = pid => db.prepare(
    `SELECT * FROM film_scenes WHERE project_id = ? AND status != 'removed'
      ORDER BY CAST(scene_number AS INTEGER)`).all(pid);

// ── Beat sheets, over all four frameworks ───────────────────────────────

test('every framework is a real structure, not a stub', () => {
    // Set-based: an implementation that handles Save the Cat and breaks on Story
    // Circle passes any example test, and they differ in beat count and shape.
    const { FRAMEWORKS } = require('../lib/beat-sheets');
    const ids = Object.keys(FRAMEWORKS);
    assert.ok(ids.length >= 4, `expected 4+ frameworks, found ${ids.length}`);

    const broken = [];
    for (const id of ids) {
        const f = FRAMEWORKS[id];
        if (!f.label) broken.push(`${id}: no label`);
        if (!Array.isArray(f.beats) || f.beats.length < 5) {
            broken.push(`${id}: ${f.beats ? f.beats.length : 0} beats — not a structure`);
            continue;
        }
        for (const [i, b] of f.beats.entries()) {
            if (!b.name) broken.push(`${id}[${i}]: unnamed beat`);
            // Guidance is the point: a beat called "Midpoint" with no note is a
            // label, and a writer adapting a novel needs to know what it is FOR.
            if (!b.guidance) broken.push(`${id}[${i}] ${b.name}: no guidance`);
            if (!(b.at >= 0 && b.at <= 100)) broken.push(`${id}[${i}] ${b.name}: at=${b.at} is not a percentage`);
        }
        const ats = f.beats.map(b => b.at);
        const sorted = [...ats].sort((a, b) => a - b);
        if (JSON.stringify(ats) !== JSON.stringify(sorted)) {
            broken.push(`${id}: beats are not in story order`);
        }
    }
    assert.deepStrictEqual(broken, [], `\n  ${broken.join('\n  ')}`);
});

test('applying a framework creates its beats, unlinked', async () => {
    const { handleStoryStructure } = require('../routes/story-structure');
    const { FRAMEWORKS } = require('../lib/beat-sheets');
    const pid = await project();

    const failed = [];
    for (const id of Object.keys(FRAMEWORKS)) {
        const p2 = await project();
        const r = await callRoute(handleStoryStructure, 'POST', `/film/projects/${p2}/beats`, { framework: id });
        if (r.status >= 400) { failed.push(`${id}: ${JSON.stringify(r.body)}`); continue; }
        const got = db.prepare('SELECT COUNT(*) n FROM film_beats WHERE project_id = ?').get(p2).n;
        if (got !== FRAMEWORKS[id].beats.length) {
            failed.push(`${id}: created ${got} of ${FRAMEWORKS[id].beats.length} beats`);
        }
    }
    assert.deepStrictEqual(failed, [], `\n  ${failed.join('\n  ')}`);
    void pid;
});

test('what is NOT linked is reported as a hole', async () => {
    // The reason to have beat sheets at all. Adapting a 40-chapter novel, the
    // question is which beats have no scene yet — a list of what IS linked
    // answers the easy half.
    const { handleStoryStructure } = require('../routes/story-structure');
    const pid = await project();
    await callRoute(handleStoryStructure, 'POST', `/film/projects/${pid}/beats`, { framework: 'three-act' });

    const before = await callRoute(handleStoryStructure, 'GET', `/film/projects/${pid}/beats`);
    assert.strictEqual(before.status, 200, JSON.stringify(before.body));
    assert.ok(before.body.holes.length > 0, 'a fresh beat sheet reports no holes, but nothing is linked');
    assert.strictEqual(before.body.holes.length, before.body.beats.length);

    const beat = before.body.beats[0];
    const scene = scenes(pid)[0];
    const link = await callRoute(handleStoryStructure, 'PUT', `/film/beats/${beat.id}`, { scene_id: scene.id });
    assert.ok(link.status < 400, JSON.stringify(link.body));

    const after = await callRoute(handleStoryStructure, 'GET', `/film/projects/${pid}/beats`);
    assert.strictEqual(after.body.holes.length, before.body.holes.length - 1,
        'linking a scene did not close a hole');
    assert.ok(!after.body.holes.some(h => h.id === beat.id));
});

test('a beat survives a screenplay revision', async () => {
    // Beats link to scene ids, and scene ids now survive reconciliation because
    // it matches on content. If they did not, every rewrite would silently
    // unlink the whole structure.
    const { handleStoryStructure } = require('../routes/story-structure');
    const { handleScripts } = require('../routes/scripts');
    const pid = await project();
    await callRoute(handleStoryStructure, 'POST', `/film/projects/${pid}/beats`, { framework: 'three-act' });
    const beats = (await callRoute(handleStoryStructure, 'GET', `/film/projects/${pid}/beats`)).body.beats;
    const scene = scenes(pid)[2];
    await callRoute(handleStoryStructure, 'PUT', `/film/beats/${beats[0].id}`, { scene_id: scene.id });

    // Insert a scene ABOVE it: the linked scene renumbers.
    await callRoute(handleScripts, 'POST', `/film/projects/${pid}/script/insert`,
        { after_scene: 1, fountain: 'EXT. THE GATE - DAY\n\nSomething in the channel.\n' });

    const after = (await callRoute(handleStoryStructure, 'GET', `/film/projects/${pid}/beats`)).body;
    const linked = after.beats.find(b => b.id === beats[0].id);
    assert.strictEqual(linked.scene_id, scene.id, 'a revision unlinked the beat from its scene');
    assert.ok(linked.scene_heading, 'the beat cannot say which scene it points at');
});

// ── Scene cards ─────────────────────────────────────────────────────────

test('scene card fields survive a screenplay revision', async () => {
    // The real risk. film_scenes is a PROJECTION of the Fountain, and
    // reconciliation rewrites the fields it owns on every save. Authored fields
    // living in the same row must not be among them.
    const { handleScenes } = require('../routes/scenes');
    const { handleScripts } = require('../routes/scripts');
    const pid = await project();
    const scene = scenes(pid)[1];

    const w = await callRoute(handleScenes, 'PUT', `/film/scenes/${scene.id}/card`, {
        pov_character: 'LEY', conflict: 'The gate will not open.', outcome: 'She goes under it.',
    });
    assert.ok(w.status < 400, JSON.stringify(w.body));

    await callRoute(handleScripts, 'POST', `/film/projects/${pid}/script/append`,
        { fountain: 'EXT. THE TOWER - NIGHT\n\nA light that should not be lit.\n' });

    const row = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(scene.id);
    assert.strictEqual(row.pov_character, 'LEY', 'the POV character was wiped by reconciliation');
    assert.strictEqual(row.conflict, 'The gate will not open.', 'the conflict was wiped');
    assert.strictEqual(row.outcome, 'She goes under it.', 'the outcome was wiped');
});

test('a scene card does not fake a drift', async () => {
    // Authored metadata is not the screenplay. Writing it must not restamp the
    // scene, or every shot under it reports as behind for a note nobody read.
    const { handleScenes } = require('../routes/scenes');
    const pid = await project();
    const scene = scenes(pid)[0];
    const before = scene.source_fingerprint;
    await callRoute(handleScenes, 'PUT', `/film/scenes/${scene.id}/card`, { conflict: 'The water is gone.' });
    const after = db.prepare('SELECT source_fingerprint FROM film_scenes WHERE id = ?').get(scene.id);
    assert.strictEqual(after.source_fingerprint, before,
        'writing a scene card marked the scene as changed');
});

// ── Format directives ───────────────────────────────────────────────────

test('directives govern the writing, and say that they do not govern the image', async () => {
    const { handleStoryStructure } = require('../routes/story-structure');
    const pid = await project();
    const r = await callRoute(handleStoryStructure, 'PUT', `/film/projects/${pid}/directives`,
        { directives: 'Present tense. No camera directions in action. Dialogue under three lines.' });
    assert.ok(r.status < 400, JSON.stringify(r.body));

    const back = await callRoute(handleStoryStructure, 'GET', `/film/projects/${pid}/directives`);
    assert.match(back.body.directives, /Present tense/);
    // style_preset governs the IMAGE and this governs the PROSE. Conflating them
    // would put screenwriting instructions into every image prompt.
    assert.ok(/style_preset|image/i.test(JSON.stringify(back.body)),
        'nothing distinguishes writing directives from the image style preset');
    const proj = db.prepare('SELECT style_preset FROM film_projects WHERE id = ?').get(pid);
    assert.ok(!/Present tense/.test(proj.style_preset || ''),
        'writing directives leaked into style_preset and will reach every image prompt');
});

// ── Per-scene history, derived ──────────────────────────────────────────

test('per-scene history is derived, not stored', async () => {
    // Every version of every scene is already in film_scripts — one full
    // Fountain per version. A table would store what we can compute, and then
    // have to be kept in step with the documents it duplicates.
    const migrations = require('fs').readdirSync(path.join(__dirname, '..', 'db', 'migrations'))
        .map(f => require('fs').readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'))
        .join('\n');
    assert.ok(!/CREATE TABLE[^;]*film_scene_versions/i.test(migrations),
        'a scene-version table exists — history should be derived from film_scripts');
});

test('a scene’s history shows each version its text changed in', async () => {
    const { handleScenes } = require('../routes/scenes');
    const pid = await project();
    const scene = scenes(pid)[1];

    await callRoute(handleScenes, 'PUT', `/film/scenes/${scene.id}`,
        { fountain: 'EXT. SLUICE - MORNING\n\nRust, and a smell of iron.\n' });
    await callRoute(handleScenes, 'PUT', `/film/scenes/${scene.id}`,
        { fountain: 'EXT. SLUICE - MORNING\n\nRust, iron, and the gate half down.\n' });

    const h = await callRoute(handleScenes, 'GET', `/film/scenes/${scene.id}/history`);
    assert.strictEqual(h.status, 200, JSON.stringify(h.body));
    assert.ok(h.body.history.length >= 3, `expected 3+ versions, got ${h.body.history.length}`);
    const texts = h.body.history.map(v => v.text);
    assert.ok(texts.some(t => /water should be/.test(t)), 'the original text is missing from the history');
    assert.ok(texts.some(t => /smell of iron/.test(t)), 'the first revision is missing');
    assert.ok(texts.some(t => /gate half down/.test(t)), 'the current text is missing');
});

test('restoring a scene from history goes forward, never back', async () => {
    // The rule the frame-version work established: restore writes a NEW version
    // whose content is an old one. Rewinding would destroy everything since.
    const { handleScenes } = require('../routes/scenes');
    const pid = await project();
    const scene = scenes(pid)[1];
    await callRoute(handleScenes, 'PUT', `/film/scenes/${scene.id}`,
        { fountain: 'EXT. SLUICE - MORNING\n\nRust, and a smell of iron.\n' });

    const h = await callRoute(handleScenes, 'GET', `/film/scenes/${scene.id}/history`);
    const oldest = h.body.history[h.body.history.length - 1];
    const versionsBefore = db.prepare('SELECT COUNT(*) n FROM film_scripts WHERE project_id = ?').get(pid).n;

    const r = await callRoute(handleScenes, 'POST', `/film/scenes/${scene.id}/history/${oldest.version}/restore`);
    assert.ok(r.status < 400, JSON.stringify(r.body));

    const versionsAfter = db.prepare('SELECT COUNT(*) n FROM film_scripts WHERE project_id = ?').get(pid).n;
    assert.ok(versionsAfter > versionsBefore, 'restore rewound instead of moving forward');
    const now = db.prepare('SELECT description FROM film_scenes WHERE id = ?').get(scene.id);
    assert.match(now.description, /water should be/, 'the restored text is not what is in the scene');
});

// ── The surface ─────────────────────────────────────────────────────────

test('all four features are reachable over MCP and through the server', () => {
    const { listTools } = require('../lib/mcp-tools');
    const names = listTools().map(t => t.name);
    const missing = ['beats_get', 'beats_apply', 'beat_link', 'scene_card_write',
        'directives_get', 'directives_write', 'scene_history', 'scene_restore']
        .filter(n => !names.includes(n));
    assert.deepStrictEqual(missing, [], `missing MCP tools: ${missing.join(', ')}`);

    // And the server must route to them — the trap that has bitten four times.
    const server = require('fs').readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const unrouted = ['beats', 'directives'].filter(p => !new RegExp(`'${p}'`).test(server));
    assert.deepStrictEqual(unrouted, [], `handled but never routed: ${unrouted.join(', ')}`);
});
