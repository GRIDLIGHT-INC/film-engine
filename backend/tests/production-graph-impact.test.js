/**
 * PGN-004 — every node on the Production graph carries its out-of-date state,
 * and that state comes from lib/impact.js and nowhere else.
 *
 *   current   — made, and made from what is there now
 *   redo      — out of date, and everything it is built from is current: do it now
 *   waiting   — out of date only because something above it is: do not touch yet
 *   never     — nothing has been made
 *   untracked — made outside the workflow (no input fingerprint), so whether it
 *               is behind cannot be known; said, never passed off as current
 *
 * Set-based over the node types the graph draws (read from the source) and the
 * states; then the real walk, with real fingerprints, through buildGraph.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-pgi-' + crypto.randomUUID().slice(0, 8));
require('../db/schema').ensureSchema();
const { db, generateId } = require('../db/database');
const pg = require('../lib/production-graph');
const impact = require('../lib/impact');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'production-graph.js'), 'utf8');
const NODE_TYPES = [...new Set([...SRC.matchAll(/type: '([a-z]+)'/g)].map(m => m[1]))];

test('the states are declared once and every node type has a rule', () => {
    assert.deepEqual([...pg.IMPACT_STATES].sort(), ['current', 'never', 'redo', 'untracked', 'waiting']);
    assert.ok(NODE_TYPES.length >= 6, `found ${NODE_TYPES.length} node types`);
    for (const t of NODE_TYPES) assert.equal(typeof pg.NODE_IMPACT[t], 'function', `no impact rule for node type ${t}`);
});

/** A context where the named stages of shot S have the given states. */
function ctx(over = {}) {
    return Object.assign({
        shots: { S: { scene_card: 'current', keyframe: 'current', video: 'current', voice: 'absent', lipsync: 'absent', sfx: 'absent', post: 'absent' } },
        scenes: { SC: { music: 'current', ambient: 'current' } },
        assets: {},
        why: {},
    }, over);
}
const shotNode = (frames = 1) => ({ type: 'shot', id: 'S', scene_id: 'SC', frames: Array.from({ length: frames }, (_, i) => ({ asset_id: 'F' + i, selected: i === frames - 1 })) });

test('shot: never / current / redo / waiting / untracked, and the card outranks the frame', () => {
    const f = pg.NODE_IMPACT.shot;
    assert.equal(f(shotNode(0), ctx()).state, 'never');
    assert.equal(f(shotNode(), ctx()).state, 'current');
    assert.equal(f(shotNode(), ctx({ shots: { S: { scene_card: 'current', keyframe: 'redo' } } })).state, 'redo');
    assert.equal(f(shotNode(), ctx({ shots: { S: { scene_card: 'current', keyframe: 'waiting' } } })).state, 'waiting');
    assert.equal(f(shotNode(), ctx({ shots: { S: { scene_card: 'current', keyframe: 'absent' } } })).state, 'untracked');
    const card = f(shotNode(), ctx({ shots: { S: { scene_card: 'redo', keyframe: 'waiting' } } }));
    assert.equal(card.state, 'redo');
    assert.match(card.why, /screenplay|card/i);
});

test('shot: voice, lip-sync, sfx and post roll up as badges, never as the node\'s own state', () => {
    const r = pg.NODE_IMPACT.shot(shotNode(), ctx({ shots: { S: { scene_card: 'current', keyframe: 'current', voice: 'redo', lipsync: 'waiting', sfx: 'current', post: 'absent' } } }));
    assert.equal(r.state, 'current');
    const got = (r.badges || []).map(b => `${b.stage}:${b.state}`).sort();
    assert.deepEqual(got, ['lipsync:waiting', 'voice:redo']);
});

test('video and audio versions take their own asset\'s state; unstamped ones are untracked', () => {
    const c = ctx({ assets: { A1: 'redo', A2: 'waiting', A3: 'current' } });
    for (const t of ['video', 'audio']) {
        const f = pg.NODE_IMPACT[t];
        assert.equal(f({ type: t, asset_id: 'A1' }, c).state, 'redo');
        assert.equal(f({ type: t, asset_id: 'A2' }, c).state, 'waiting');
        assert.equal(f({ type: t, asset_id: 'A3' }, c).state, 'current');
        assert.equal(f({ type: t, asset_id: 'ZZ' }, c).state, 'untracked');
    }
});

test('sequence: a changed borrowed frame is redo; a member behind makes it wait; no clip is never', () => {
    const f = pg.NODE_IMPACT.sequence;
    const seq = (extra) => Object.assign({ type: 'sequence', shot_ids: ['S'], videos: [{ asset_id: 'V' }], links: {} }, extra);
    assert.equal(f(seq({ links: { stale: true } }), ctx()).state, 'redo');
    assert.equal(f(seq(), ctx({ shots: { S: { scene_card: 'current', keyframe: 'redo' } } })).state, 'waiting');
    assert.equal(f(seq({ videos: [] }), ctx()).state, 'never');
    assert.equal(f(seq(), ctx()).state, 'current');
});

test('link and sound nodes', () => {
    assert.equal(pg.NODE_IMPACT.link({ type: 'link', stale: true }, ctx()).state, 'redo');
    assert.equal(pg.NODE_IMPACT.link({ type: 'link', stale: false, resolved: true }, ctx()).state, 'current');
    const s = pg.NODE_IMPACT.sound;
    assert.equal(s({ type: 'sound', cue_type: 'score', scene_id: 'SC', selected_asset_id: null }, ctx()).state, 'never');
    assert.equal(s({ type: 'sound', cue_type: 'score', scene_id: 'SC', selected_asset_id: 'M1' }, ctx({ assets: { M1: 'redo' } })).state, 'redo');
    assert.equal(s({ type: 'sound', cue_type: 'ambient', scene_id: 'SC', selected_asset_id: 'M2' },
        ctx({ scenes: { SC: { music: 'current', ambient: 'waiting' } } })).state, 'waiting');
    assert.equal(s({ type: 'sound', cue_type: 'sfx', scene_id: 'SC', selected_asset_id: 'M3' }, ctx()).state, 'untracked');
});

// ---- the real walk, through buildGraph -------------------------------------

const P = generateId(), SC = generateId(), SH = generateId(), SH2 = generateId();
db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Impact graph')").run(P);
db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, description) VALUES (?, ?, 1, 'A quiet street.')").run(SC, P);
const card = JSON.stringify({ description: 'A woman waits at a bus stop.', camera: { shot_type: 'wide' } });
db.prepare("INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, sort_order) VALUES (?, ?, '1A', ?, 0)").run(SH, SC, card);
db.prepare("INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, sort_order) VALUES (?, ?, '1B', ?, 1)").run(SH2, SC, card);
function asset(type, shotId, fp, kind) {
    const id = generateId();
    db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, scene_id, asset_type, file_name, file_path, version,
        input_fingerprint, artefact_kind) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
        .run(id, P, shotId, SC, type, id + '.png', '/tmp/' + id + '.png', fp, kind);
    return id;
}

test('through buildGraph: every node carries an impact state from the set', () => {
    asset('storyboard', SH, 'an-old-fingerprint', 'keyframe');   // behind
    asset('storyboard', SH2, null, null);                        // made outside the workflow
    const g = pg.buildGraph(db, P);
    const bad = g.nodes.filter(n => !n.impact || !pg.IMPACT_STATES.includes(n.impact.state)).map(n => n.key);
    assert.deepEqual(bad, []);
    const a = g.nodes.find(n => n.key === 'shot:' + SH), b = g.nodes.find(n => n.key === 'shot:' + SH2);
    assert.equal(a.impact.state, 'redo', 'a keyframe stamped from other inputs is behind');
    assert.equal(b.impact.state, 'untracked', 'an unstamped frame is untracked, not current');
    assert.equal(a.state, 'ok', 'the existing state field is untouched');
});

test('the graph agrees with the impact report it reads', () => {
    const report = impact.impact(P);
    const g = pg.buildGraph(db, P);
    assert.ok(report.shots.length >= 1, 'the report flags nothing, so agreeing with it proves nothing');
    for (const s of report.shots) {
        const kf = s.stages.find(r => r.stage === 'keyframe');
        if (!kf) continue;
        assert.equal(g.nodes.find(n => n.key === 'shot:' + s.shot_id).impact.state, kf.state);
    }
});

test.after(() => { try { fs.rmSync(process.env.FILM_DATA_DIR, { recursive: true, force: true }); } catch (_) {} });
