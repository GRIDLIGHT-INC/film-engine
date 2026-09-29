/**
 * Which work a screenplay revision has left behind.
 *
 * This happens constantly in production: a scene is rewritten, and the shot
 * cards, boards, blocking and generated frames for that scene are all suddenly
 * about the previous version of the story. The engine had artefact staleness,
 * which answers a different question — does this frame still match its card —
 * and is structurally blind to a rewrite, because rewriting the screenplay does
 * not touch the card. That is the whole problem: the cards stay valid,
 * correctly fingerprinted, and quietly about a different film.
 *
 * Set-based over the ways a shot can come into existence, because the warning
 * only works if EVERY creation path records which draft it was written from.
 * One unstamped path is a class of shots that can never be flagged, and the
 * gap is invisible — the report simply says nothing is wrong.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-drift-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const { sceneFingerprint, stampScene, stampShot, drift, adoptBaseline } = require('../lib/screenplay-drift');
const fs = require('fs');

function seed() {
    const projectId = generateId(), sceneId = generateId(), shotId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Drift Test');
    db.prepare(`INSERT INTO film_scenes (id, project_id, scene_number, int_ext, location, time_of_day, description)
                VALUES (?, ?, '3', 'EXT', 'SUBURBAN STREET', 'DUSK', 'The dragon attacks the house opposite.')`)
        .run(sceneId, projectId);
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)')
        .run(shotId, sceneId, '3A', JSON.stringify({ shot_code: '3A', description: 'x', camera: {} }));
    stampScene(sceneId);
    stampShot(shotId, sceneId);
    return { projectId, sceneId, shotId };
}

function rewrite(sceneId, text) {
    db.prepare('UPDATE film_scenes SET description = ? WHERE id = ?').run(text, sceneId);
    stampScene(sceneId);
}

test('rewriting a scene flags the shots written from the old draft', () => {
    const s = seed();
    assert.deepStrictEqual(drift(s.projectId), [], 'a scene nobody touched is reported as behind');

    rewrite(s.sceneId, 'The dragon turns and comes for her. She runs for the sewer plate.');
    const report = drift(s.projectId);
    assert.strictEqual(report.length, 1, 'the rewritten scene is not reported');
    assert.strictEqual(report[0].scene_number, '3');
    assert.deepStrictEqual(report[0].shots_behind.map(x => x.shot_code), ['3A']);
    assert.ok(report[0].next.length, 'the report says what is wrong and not what to do about it');
});

test('an edit that changes nothing a card is built from does not cry wolf', () => {
    // A warning that fires on work nobody needs to redo is one people learn to
    // dismiss, and then it is worth less than nothing.
    const s = seed();
    const before = sceneFingerprint(db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(s.sceneId));
    db.prepare('UPDATE film_scenes SET status = ? WHERE id = ?').run('broken_down', s.sceneId);
    stampScene(s.sceneId);
    const after = sceneFingerprint(db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(s.sceneId));
    assert.strictEqual(before, after, 'a status change moved the fingerprint');
    assert.deepStrictEqual(drift(s.projectId), []);
});

test('fixing the card clears the warning', () => {
    // A warning that cannot be cleared by doing the work it asks for is noise
    // within a day.
    const s = seed();
    rewrite(s.sceneId, 'She runs for the sewer plate.');
    assert.strictEqual(drift(s.projectId).length, 1);

    stampShot(s.shotId, s.sceneId);           // what shot_update does after a save
    assert.deepStrictEqual(drift(s.projectId), [], 'the warning survived the fix');
});

test('a shot with no draft recorded is unknown, never stale', () => {
    // NULL means "outside this workflow". Treating it as behind would make the
    // feature's debut a wall of false alarms on every existing project.
    const s = seed();
    db.prepare('UPDATE film_shots SET scene_fingerprint = NULL WHERE id = ?').run(s.shotId);
    rewrite(s.sceneId, 'Something else entirely.');
    const report = drift(s.projectId);
    assert.deepStrictEqual(report, [], 'an unstamped shot was reported as behind');
});

test('adopting a baseline makes existing work trackable, and only that', () => {
    const s = seed();
    db.prepare('UPDATE film_shots SET scene_fingerprint = NULL WHERE id = ?').run(s.shotId);
    const result = adoptBaseline(s.projectId);
    assert.strictEqual(result.shots_stamped, 1);
    assert.deepStrictEqual(drift(s.projectId), [], 'adopting a baseline immediately flagged the work it adopted');

    rewrite(s.sceneId, 'And now the story changes.');
    assert.strictEqual(drift(s.projectId).length, 1, 'a baselined shot never warns, which is the point of baselining');
});

test('a baseline never silences a shot already known to be behind', () => {
    // Erasing a warning is not answering it.
    const s = seed();
    rewrite(s.sceneId, 'A different scene.');
    assert.strictEqual(drift(s.projectId).length, 1);
    adoptBaseline(s.projectId);
    assert.strictEqual(drift(s.projectId).length, 1,
        'adopting a baseline cleared a real warning instead of leaving it alone');
});

test('the report says what was built on the old words', () => {
    // "3 shots are stale" sends a director to the database. Naming what was
    // generated is the difference between a note and an instruction.
    const s = seed();
    db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_name)
                VALUES (?, ?, ?, 'storyboard', '3A.png')`).run(generateId(), s.projectId, s.shotId);
    db.prepare(`INSERT INTO film_previs_blocking (id, shot_id, camera_json, subject_json, stage_json)
                VALUES (?, ?, '{}', '{}', '{}')`).run(generateId(), s.shotId);
    rewrite(s.sceneId, 'Rewritten.');

    const made = drift(s.projectId)[0].shots_behind[0].generated;
    assert.ok(made.includes('storyboard'), 'the generated frame is not named');
    assert.ok(made.includes('previs blocking'), 'the blocking built on the old words is not named');
});

/**
 * Every way a shot can be created must record its draft.
 *
 * Derived from the INSERT sites rather than a wish list: one unstamped path is
 * a whole class of shots that can never be flagged, and it shows up as the
 * report saying nothing is wrong.
 */
const CREATION_PATHS = [
    { id: 'breakdown auto-save', file: 'routes/breakdown.js' },
    { id: 'shot_create', file: 'routes/shots.js' },
    { id: 'shot tagger', file: 'routes/scripts.js' },
    // The one insert: the insert-after route and the graph's coverage patterns (PGN-020).
    { id: 'insert after / coverage pattern', file: 'lib/shot-insert-code.js' },
];

test('every path that creates a shot records the draft it was written from', () => {
    const missing = CREATION_PATHS.filter(p => {
        const src = fs.readFileSync(path.join(__dirname, '..', p.file), 'utf8');
        return !/stampShot\(/.test(src);
    }).map(p => p.id);
    assert.deepStrictEqual(missing, [],
        `these create shots that can never be flagged as behind: ${missing.join(', ')}`);
});

test('every INSERT INTO film_shots is accounted for by a creation path', () => {
    // The list above is only trustworthy if nothing creates shots outside it.
    const root = path.join(__dirname, '..');
    const files = ['routes', 'lib'].flatMap(dir =>
        fs.readdirSync(path.join(root, dir)).filter(f => f.endsWith('.js')).map(f => path.join(dir, f)));
    const inserting = files.filter(f =>
        /INSERT INTO film_shots/.test(fs.readFileSync(path.join(root, f), 'utf8')));
    const known = new Set([...CREATION_PATHS.map(p => p.file), 'routes/demo-project.js']);
    const unknown = inserting.filter(f => !known.has(f));
    assert.deepStrictEqual(unknown, [],
        `these create shots and are not in CREATION_PATHS: ${unknown.join(', ')}`);
});

test('the board warns where the frames are, not on a page of its own', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
    // Asserted on the BEHAVIOUR rather than on one function's name. The notice
    // was a full-width card of prose and is now a single line in a shared
    // strip; the thing worth pinning is that the board still says it, and
    // still marks the frames it is about.
    assert.ok(/function screenplayDriftNotice\(/.test(html), 'no drift notice on the board');
    assert.ok(/function noticeStrip\(/.test(html), 'the notices have no strip to live in');
    assert.ok(/function screenplayDriftTag\(/.test(html), 'no per-frame mark, so the notice points nowhere');
    assert.ok(/loadScreenplayDrift\(\)/.test(html), 'the board never asks which shots are behind');
});

test('the warning offers a way to FIX it, not only a way to dismiss it', () => {
    /*
     * The defect this guards is a product one and it is the reason the banner
     * was rewritten: the only button on it said, in effect, "ignore me". A
     * notice whose single affordance is dismissal teaches the reader to
     * dismiss it, and then the real warning goes with the rest.
     *
     * Resync must also be PREVIEWED. The last thing here that reconciled a
     * screenplay against a board did it with no preview and took sixteen
     * shots, their blocking and their annotations through a cascade.
     */
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
    assert.ok(/previewResync\(\)/.test(html), 'no way to resync from the board');
    assert.ok(/function applyResync\(/.test(html), 'the resync can be previewed and never applied');
    assert.ok(/runShotAudit\(\)/.test(html), 'no way to audit the cards from the board');

    const preview = html.slice(html.indexOf('async function previewResync'));
    assert.ok(/apply:\s*false/.test(preview.slice(0, 1200)),
        'the preview does not ask for a dry run, so opening it would write');

    const strip = html.slice(html.indexOf('function screenplayDriftNotice'),
        html.indexOf('function screenplayDriftNotice') + 2600);
    assert.ok(/Still matches/.test(strip), 'the dismiss affordance was lost in the rewrite');
    assert.ok(strip.indexOf('previewResync') < strip.indexOf('Still matches'),
        'dismiss is offered before the fix, which is how a warning trains people to ignore it');
});

test('a first stamp is a baseline, not a change', () => {
    // Setting the timestamp on the first stamp makes every scene in an existing
    // project claim it was rewritten at the moment tracking was switched on.
    // That is what it looked like in practice: three scenes stamped 14:27,
    // keyframes generated at 11:42, and a report correctly saying nothing was
    // behind — leaving the reader to decide which to believe. A timestamp that
    // has to be explained is worse than no timestamp.
    const s = seed();
    db.prepare('UPDATE film_scenes SET source_fingerprint = NULL, source_changed_at = NULL WHERE id = ?')
        .run(s.sceneId);

    stampScene(s.sceneId);
    const first = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(s.sceneId);
    assert.ok(first.source_fingerprint, 'the first stamp recorded no fingerprint');
    assert.strictEqual(first.source_changed_at, null,
        'starting to track a scene was reported as the scene having changed');

    rewrite(s.sceneId, 'Now it actually changes.');
    const second = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(s.sceneId);
    assert.ok(second.source_changed_at, 'a real change left no timestamp');
});

/**
 * The Scenes page is where "complete" is most misleading.
 *
 * A scene's status is a workflow state a person advanced, so it does not revert
 * when the screenplay changes — and should not, because reverting it would
 * overwrite a decision someone made. But left on its own it reads as done over
 * a scene whose shots are now about a different story, which is the one place
 * the board actively misleads rather than merely staying quiet.
 */
test('the scenes page shows drift beside the status, not instead of it', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
    assert.ok(/function sceneDriftBadge\(/.test(html), 'no per-scene mark on the scenes page');
    assert.ok(/function sceneDriftBanner\(/.test(html), 'nothing tells the reader what to do about it');

    const loader = html.slice(html.indexOf('async function loadScenes()'));
    assert.ok(/loadScreenplayDrift\(\)/.test(loader.slice(0, 2000)),
        'the scenes page never asks which scenes are behind');

    // The status badge must survive: overwriting it would erase the fact that
    // someone finished this scene, which is still true.
    assert.ok(/badge \$\{s\.status\}/.test(html), 'the workflow status was replaced rather than joined');
});

test('the page says what re-running the breakdown actually does', () => {
    // "Break it down again" sounds destructive and is not — breakdown SKIPS a
    // scene that already has shots. The destructive step is deleting the shots
    // first, and leaving that to be discovered is how someone loses frames they
    // paid for.
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
    const fn = html.slice(html.indexOf('function sceneDriftBanner('));
    const body = fn.slice(0, fn.indexOf('\n    }'));
    assert.ok(/skips any scene that already has shots/i.test(body),
        'the page does not say that re-running the breakdown is a no-op');
    assert.ok(/delete the\s+shots first/i.test(body.replace(/\s+/g, ' ')) || /delete the shots first/i.test(body.replace(/\s+/g, ' ')),
        'the page does not name the step that actually loses work');

    // And that claim has to be true of the code, not just of the page.
    const breakdown = fs.readFileSync(path.join(__dirname, '..', 'routes', 'breakdown.js'), 'utf8');
    assert.ok(/skipped: true/.test(breakdown) && /Delete them first/.test(breakdown),
        'the breakdown no longer skips scenes with shots, so the page is now lying');
});

// ── The comparator and the stamper must agree ───────────────────────────

/**
 * A shot stamped under the OLD fingerprint formula is not behind.
 *
 * Reported from use as two banners that could not be cleared: "the screenplay
 * moved on without 11 shots", and eleven items to regenerate. Every shot in the
 * project carried a fingerprint that matched its scene's STORED one, and the
 * report said they were all behind anyway.
 *
 * `sceneFingerprint` was widened to include dialogue — correctly, because
 * rewriting a character's lines used to change nothing the drift report could
 * see. Everything stamped before that carries the pre-dialogue hash.
 * `stampScene` already recognises that case and re-baselines the SCENE
 * silently, and two things were left behind: `drift()` compares against the new
 * formula while the shots still hold the old one, and `stampShot` writes the
 * scene's stored value — so re-stamping reproduces the mismatch and the warning
 * cannot be cleared by doing the work it asks for.
 *
 * That is the worst kind of warning: permanently on, pointing at work that is
 * fine. Acting on it means redoing eleven cards for nothing; learning to ignore
 * it means ignoring the real thing when it happens.
 */
test('a scene stamped under the pre-dialogue formula reports nothing behind', () => {
    const { sceneFingerprint, legacySceneFingerprint, stampShot, drift } = require('../lib/screenplay-drift');
    const s = seed();

    // Exactly the state a real project is in: scene and shots both carrying the
    // legacy hash, nothing actually rewritten.
    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(s.sceneId);
    const legacy = legacySceneFingerprint(scene);
    assert.notStrictEqual(legacy, sceneFingerprint(scene),
        'the two formulas agree on this fixture, so it cannot reproduce the bug');
    db.prepare('UPDATE film_scenes SET source_fingerprint = ? WHERE id = ?').run(legacy, s.sceneId);
    db.prepare('UPDATE film_shots SET scene_fingerprint = ? WHERE id = ?').run(legacy, s.shotId);

    assert.deepStrictEqual(drift(s.projectId), [],
        'a shot stamped under the old formula, on a scene nobody rewrote, is reported behind — '
        + 'and re-stamping writes the same old value, so the warning can never be cleared');
});

test('re-stamping a shot clears it, whatever formula it was on', () => {
    // A warning that cannot be cleared by doing the work it asks for is noise
    // within a day.
    const { legacySceneFingerprint, stampShot, drift } = require('../lib/screenplay-drift');
    const s = seed();
    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(s.sceneId);
    db.prepare('UPDATE film_shots SET scene_fingerprint = ? WHERE id = ?')
        .run(legacySceneFingerprint(scene), s.shotId);

    stampShot(s.shotId, s.sceneId);
    assert.deepStrictEqual(drift(s.projectId), [],
        're-stamping the shot did not clear it');
});

test('a genuine rewrite is still caught after the migration', () => {
    // The fix must not buy silence by accepting any old hash. A scene that
    // really changed still has to fire.
    const { legacySceneFingerprint, drift } = require('../lib/screenplay-drift');
    const s = seed();
    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(s.sceneId);
    const legacy = legacySceneFingerprint(scene);
    db.prepare('UPDATE film_scenes SET source_fingerprint = ? WHERE id = ?').run(legacy, s.sceneId);
    db.prepare('UPDATE film_shots SET scene_fingerprint = ? WHERE id = ?').run(legacy, s.shotId);

    rewrite(s.sceneId, 'She runs for the sewer plate as the roof comes down.');
    const report = drift(s.projectId);
    assert.strictEqual(report.length, 1, 'a real rewrite stopped being reported');
    assert.deepStrictEqual(report[0].shots_behind.map(x => x.shot_code), ['3A']);
});

test('every site resolving a scene fingerprint uses the same rule', () => {
    /*
     * Derived from the source, because the bug was two call sites answering
     * "what is this scene now" differently — and each looked correct alone.
     */
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'screenplay-drift.js'), 'utf8');
    const sites = [];
    let fn = null;
    for (const line of src.split('\n')) {
        const m = line.match(/^function (\w+)\(/);
        if (m) fn = m[1];
        // The resolvers themselves are the ones allowed to call it — the check
        // is about CONSUMERS asking the question a second way.
        if (!fn || ['sceneFingerprint', 'legacySceneFingerprint', 'stampScene', 'matchesScene'].includes(fn)) continue;
        if (/sceneFingerprint\(/.test(line)) sites.push({ fn, line: line.trim() });
    }
    // One is the healthy state: stampShot, which already prefers the stored
    // value. The guard is that no SECOND site answers the question its own way
    // — which is what drift() was doing.
    assert.ok(sites.length >= 1, `the detector found no resolution sites at all`);
    const bare = sites.filter(s => !/source_fingerprint|legacy|matchesScene/i.test(s.line));
    assert.deepStrictEqual([...new Set(bare.map(s => s.fn))], [],
        'these recompute the scene fingerprint live and ignore what was actually stamped, so they '
        + `disagree with stampShot: ${[...new Set(bare.map(s => s.fn))].join(', ')}`);
});
