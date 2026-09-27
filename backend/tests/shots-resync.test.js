/**
 * Resync: the verb the drift warning never had.
 *
 * The rules under test are all restraint. A reconciler that is willing to
 * rewrite prose or drop a shot is not a tool, it is a hazard — and this
 * codebase has already lost a full shot list to one.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-resync-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const { handleScripts } = require('../routes/scripts');
const { resyncShots } = require('../lib/shots-resync');

function call(handler, method, urlPath, body) {
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

const DRAFT = `INT. KITCHEN - DAY

Maya pours coffee. THE KETTLE sits on the hob.

MAYA
Morning.

MAYA
Sleep all right?
`;

async function seed() {
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Resync Test');
    db.prepare('INSERT INTO film_props (id, project_id, name, visual_prompt, height_m) VALUES (?, ?, ?, ?, ?)')
        .run(generateId(), projectId, 'THE KETTLE', 'a steel stovetop kettle', 0.25);
    const up = await call(handleScripts, 'POST', `/film/projects/${projectId}/script`,
        { fountain_content: DRAFT });
    assert.strictEqual(up.status, 201, JSON.stringify(up.body));

    const scene = db.prepare('SELECT * FROM film_scenes WHERE project_id = ? ORDER BY scene_number').all(projectId)[0];
    const shotId = generateId();
    // A card that knows less than the screenplay: no props, one line.
    db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, sort_order)
                VALUES (?, ?, '1A', ?, 0)`).run(shotId, scene.id, JSON.stringify({
        shot_code: '1A',
        description: 'Maya at the hob, seen from the doorway. THE KETTLE sits on the ring beside her.',
        camera: { lens: '40mm', movement: 'static', shot_type: 'medium' },
        direction: 'Hold it. Let her finish pouring before the cut.',
        characters: [], props: [],
        dialogue: [{ character: 'MAYA', line: 'Morning.' }],
    }));
    db.prepare(`INSERT INTO film_previs_blocking (id, shot_id, camera_json, subject_json, stage_json)
                VALUES (?, ?, '{}', '{}', '{}')`).run(generateId(), shotId);
    // Record which draft this card was written from, as breakdown and
    // shot_create both do. An UNSTAMPED shot is "no draft recorded", which
    // drift deliberately refuses to report as behind — so a fixture that
    // skips this is testing a state the application never produces.
    require('../lib/screenplay-drift').stampShot(shotId, scene.id);
    return { projectId, sceneId: scene.id, shotId };
}

test('a dry run writes absolutely nothing', async () => {
    const s = await seed();
    const before = db.prepare('SELECT scene_card_yaml FROM film_shots WHERE id = ?').get(s.shotId).scene_card_yaml;
    const plan = resyncShots(s.projectId, {});
    assert.strictEqual(plan.applied, false);
    assert.ok(plan.cards_changed > 0, 'nothing to do, so the test proves nothing');
    const after = db.prepare('SELECT scene_card_yaml FROM film_shots WHERE id = ?').get(s.shotId).scene_card_yaml;
    assert.strictEqual(after, before, 'a DRY RUN wrote to the card');
});

test('an apply fills in the subjects the screenplay names', async () => {
    const s = await seed();
    resyncShots(s.projectId, { apply: true });
    const card = JSON.parse(db.prepare('SELECT scene_card_yaml FROM film_shots WHERE id = ?').get(s.shotId).scene_card_yaml);
    assert.deepStrictEqual(card.props, ['THE KETTLE'],
        'the prop the action line names never reached the card');
});

test('the director’s own work is never touched', async () => {
    /*
     * The camera, the direction note and the description are judgements about
     * the film. A reconciler that edits them is editing somebody's work
     * without being asked, and the description especially: deciding what the
     * new coverage should be is a directing decision, not a merge.
     */
    const s = await seed();
    resyncShots(s.projectId, { apply: true });
    const card = JSON.parse(db.prepare('SELECT scene_card_yaml FROM film_shots WHERE id = ?').get(s.shotId).scene_card_yaml);
    assert.strictEqual(card.description,
        'Maya at the hob, seen from the doorway. THE KETTLE sits on the ring beside her.');
    assert.strictEqual(card.direction, 'Hold it. Let her finish pouring before the cut.');
    assert.strictEqual(card.camera.lens, '40mm');
    assert.strictEqual(card.shot_code, '1A');
});

test('no shot is ever deleted, and its children survive', async () => {
    // film_shots.scene_id is ON DELETE CASCADE. Losing a shot id takes the
    // blocking, the annotations and the frames with it.
    const s = await seed();
    resyncShots(s.projectId, { apply: true });
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM film_shots WHERE id = ?').get(s.shotId).c, 1);
    assert.strictEqual(
        db.prepare('SELECT COUNT(*) c FROM film_previs_blocking WHERE shot_id = ?').get(s.shotId).c, 1,
        'the blocking was swept away by a reconcile');
});

test('dialogue is matched exactly or reported — never reassigned', async () => {
    /*
     * The first version fell back to "the next unclaimed line by the same
     * speaker", which in a single-speaker film means "the next line". It
     * moved four of the director's lines between shots on its first dry run.
     * A line in the wrong shot reads perfectly on the board and is only
     * caught in the edit.
     */
    const s = await seed();
    const shotId = generateId();
    db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, sort_order)
                VALUES (?, ?, '1B', ?, 1)`).run(shotId, s.sceneId, JSON.stringify({
        shot_code: '1B',
        description: 'Reverse.',
        dialogue: [{ character: 'MAYA', line: 'A line she never says.' }],
    }));

    const plan = resyncShots(s.projectId, { apply: true });
    const card = JSON.parse(db.prepare('SELECT scene_card_yaml FROM film_shots WHERE id = ?').get(shotId).scene_card_yaml);
    assert.strictEqual(card.dialogue[0].line, 'A line she never says.',
        'an unmatched line was overwritten with somebody else’s');

    const asks = plan.plan.flatMap(sc => sc.needs_a_person);
    assert.ok(asks.some(a => a.kind === 'dialogue_changed_or_gone' && a.shot_code === '1B'),
        'a line that is no longer in the scene was not reported');
});

test('screenplay material no shot covers is reported, not invented', async () => {
    // Splitting a scene into shots is a coverage judgement. The reconciler
    // says what is uncovered and stops there.
    const s = await seed();
    const plan = resyncShots(s.projectId, {});
    const asks = plan.plan.flatMap(sc => sc.needs_a_person);
    assert.ok(asks.some(a => a.kind === 'no_shot_covers_this' && /Sleep all right/.test(a.line || '')),
        `the uncovered second line was not reported: ${JSON.stringify(asks)}`);
    const shots = db.prepare('SELECT COUNT(*) c FROM film_shots WHERE scene_id = ?').get(s.sceneId).c;
    assert.strictEqual(shots, 1, 'the reconciler invented a shot rather than asking for one');
});

test('applying clears the drift warning it was offered for', async () => {
    const s = await seed();
    const { drift, stampScene } = require('../lib/screenplay-drift');
    // Move the scene under the card, the way a rewrite does.
    db.prepare("UPDATE film_scenes SET description = 'She gives up on the coffee.' WHERE id = ?").run(s.sceneId);
    stampScene(s.sceneId);
    assert.ok(drift(s.projectId).length > 0, 'nothing was behind, so the test proves nothing');

    resyncShots(s.projectId, { apply: true });
    assert.strictEqual(drift(s.projectId).length, 0,
        'resync left the warning up, which is the state the button exists to end');
});
