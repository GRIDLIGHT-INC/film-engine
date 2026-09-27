/**
 * A warning must be clearable by the button it offers.
 *
 * "I clicked twice on 'This is all still current'" — and both banners stayed.
 * The storyboard shows two warnings: the screenplay moved on without some
 * shots (drift), and generated work is behind its inputs (impact). The only
 * button accepted ARTEFACT staleness, while the impact report's top stage —
 * the scene card — is rooted in the drift, which that button never touched
 * and which nothing on the page could answer except editing every card. So a
 * director who read the new scene and decided the cards still hold had no way
 * to say so, and the warning could not be cleared by doing what it asked.
 *
 * Set-based over WARNINGS: every banner the storyboard can show, the report it
 * is drawn from, and the action its own button sends. Each action must leave
 * its report empty; the "all still current" action must leave EVERY report
 * empty, because that is what it says.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-warnings-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();
const { callTool } = require('../lib/mcp-tools');
const { stampScene, stampShot } = require('../lib/screenplay-drift');

const PAGE = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

/** The storyboard's warnings: what each is drawn from, and what its button sends. */
const WARNINGS = Object.freeze({
    drift: {
        report: async pid => (await callTool('screenplay_drift', { project_id: pid })).body.shots_behind,
        // The notice text, not the old headline. This was a full-width card of
        // prose and is now one line in a shared strip — the director's word
        // for the old one was "intrusive", which is the right word for a
        // paragraph you are shown every time you open the board.
        banner: "title: 'Screenplay changed'",
        button: 'acceptScreenplayDrift',
        route: '/screenplay-drift/accept',
    },
    impact: {
        report: async pid => { const r = (await callTool('impact_report', { project_id: pid })).body; return r.redo_now + r.waiting; },
        banner: "title: 'Generated work behind its inputs'",
        button: 'acceptAllStale',
        route: '/staleness/accept',
    },
});

/** A scene with shots whose cards were written, frames made, then the scene rewritten. */
function driftedFilm(nScenes) {
    const pid = generateId();
    db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Glassy')").run(pid);
    const scenes = [];
    for (let n = 1; n <= nScenes; n++) {
        const sid = generateId();
        db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, int_ext, location, time_of_day, description) VALUES (?, ?, ?, 'INT', 'DINER', 'NIGHT', 'Rain on glass.')").run(sid, pid, n);
        stampScene(sid);
        const shots = [];
        for (const code of ['A', 'B']) {
            const id = generateId();
            db.prepare("INSERT INTO film_shots (id, scene_id, shot_code, sort_order, scene_card_yaml) VALUES (?, ?, ?, 0, ?)")
                .run(id, sid, `${n}${code}`, JSON.stringify({ shot_code: `${n}${code}`, description: 'Ray waits.' }));
            stampShot(id, sid);
            const f = path.join(process.env.FILM_DATA_DIR, `${n}${code}.png`);
            fs.writeFileSync(f, 'x');
            db.prepare("INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_name, file_path, input_fingerprint, artefact_kind, fingerprinted_at) VALUES (?, ?, ?, 'keyframe', ?, ?, 'old', 'keyframe', datetime('now'))")
                .run(generateId(), pid, id, `${n}${code}.png`, f);
            shots.push(id);
        }
        // The rewrite: the scene's text changes after the cards were written.
        db.prepare("UPDATE film_scenes SET description = 'Rain on glass. Ray has already left.' WHERE id = ?").run(sid);
        stampScene(sid);
        scenes.push({ sid, shots });
    }
    return { pid, scenes };
}

test('the fixture reproduces the report: both warnings are up', async () => {
    const f = driftedFilm(2);
    for (const [name, w] of Object.entries(WARNINGS)) {
        assert.ok(await w.report(f.pid) > 0, `${name} is not raised by the fixture — the test below would pass over nothing`);
    }
});

test('every warning is cleared by the action its own button sends', async () => {
    for (const [name, w] of Object.entries(WARNINGS)) {
        const f = driftedFilm(1);
        // The drift must be answered before the impact can be: the card is the
        // root. So each banner is tested in the state the page shows it in.
        if (name === 'impact') await callTool('screenplay_drift_accept', { project_id: f.pid });
        const tool = name === 'drift' ? 'screenplay_drift_accept' : 'staleness_accept';
        const r = await callTool(tool, { project_id: f.pid });
        assert.ok(r._status < 300, `${tool}: ${JSON.stringify(r.body)}`);
        assert.strictEqual(await w.report(f.pid), 0, `${name}: its own button left it up`);
    }
});

test('"This is all still current" clears EVERY warning in one act', async () => {
    const f = driftedFilm(2);
    // What the page's button sends, in the order it sends it.
    const body = PAGE.slice(PAGE.indexOf('async function acceptAllStale('), PAGE.indexOf('\n    }\n', PAGE.indexOf('async function acceptAllStale(')));
    const order = Object.values(WARNINGS).map(w => ({ w, at: body.indexOf(w.route) }));
    for (const { w, at } of order) assert.ok(at > 0, `the "all still current" button never sends ${w.route}`);
    assert.ok(order[0].at < order[1].at, 'the drift must be answered before the staleness, or the cards stay the root of the report');
    await callTool('screenplay_drift_accept', { project_id: f.pid });
    await callTool('staleness_accept', { project_id: f.pid });
    for (const [name, w] of Object.entries(WARNINGS)) assert.strictEqual(await w.report(f.pid), 0, `${name} is still up`);
});

test('accepting one scene leaves another scene\'s warning alone', async () => {
    const f = driftedFilm(2);
    const r = await callTool('screenplay_drift_accept', { project_id: f.pid, scene_id: f.scenes[0].sid });
    assert.strictEqual(r.body.shots_accepted, 2);
    const left = (await callTool('screenplay_drift', { project_id: f.pid })).body;
    assert.deepStrictEqual(left.scenes.map(s => s.scene_id), [f.scenes[1].sid]);
});

test('accepting says it is a claim, and changes nothing but the record', async () => {
    const f = driftedFilm(1);
    const card = db.prepare('SELECT scene_card_yaml FROM film_shots WHERE id = ?').get(f.scenes[0].shots[0]).scene_card_yaml;
    const r = await callTool('screenplay_drift_accept', { project_id: f.pid });
    assert.match(r.body.note, /still/i);
    assert.strictEqual(db.prepare('SELECT scene_card_yaml FROM film_shots WHERE id = ?').get(f.scenes[0].shots[0]).scene_card_yaml, card, 'a card was rewritten');
    // A later revision warns again: accepting is not switching the feature off.
    db.prepare("UPDATE film_scenes SET description = 'Different again.' WHERE id = ?").run(f.scenes[0].sid);
    stampScene(f.scenes[0].sid);
    assert.strictEqual((await callTool('screenplay_drift', { project_id: f.pid })).body.shots_behind, 2);
});

test('the page offers each warning its own button, and names what it answers', () => {
    for (const [name, w] of Object.entries(WARNINGS)) {
        const at = PAGE.indexOf(w.banner);
        assert.ok(at > 0, `${name}: the notice is gone`);
        // To the end of the notice object, which is where its actions live.
        const region = PAGE.slice(at, at + 2600);
        assert.match(region, new RegExp(`onclick="${w.button}\\(`), `${name}: its notice offers no button that answers it`);
        assert.match(PAGE, new RegExp(`async function ${w.button}\\(`), `${w.button} is not defined`);
    }
});

test('a warning offers a way to FIX it before a way to dismiss it', () => {
    /*
     * The ordering is the product decision, not decoration. Every notice on
     * this board used to end in a single button that meant "ignore me", and a
     * notice whose only affordance is dismissal teaches the reader to dismiss
     * it — after which the warning that matters is dismissed along with the
     * rest. Drift can now be RESYNCED, and the resync is offered first.
     */
    const at = PAGE.indexOf("title: 'Screenplay changed'");
    assert.ok(at > 0, 'the drift notice is gone');
    const region = PAGE.slice(at, at + 2600);
    assert.ok(/previewResync\(\)/.test(region), 'drift can still only be dismissed, never fixed');
    assert.ok(region.indexOf('previewResync') < region.indexOf('acceptScreenplayDrift'),
        'dismissal is offered before the fix');
});
