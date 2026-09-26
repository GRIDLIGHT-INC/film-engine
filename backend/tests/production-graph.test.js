/**
 * THE PRODUCTION GRAPH — layout, joins, linked frames, versions and playback.
 *
 * design_handoff_production_graph/FE-Handoff "Done when", held here:
 *
 *   - A sequence with a continuous join generates one clip per leg; a cut
 *     generates nothing.
 *   - A linked frame resolves to the selected version and flags staleness when
 *     it changes.
 *   - Playback plays the selected versions in order, with stills and slates
 *     filling the gaps.
 *   - Positions survive reload; Tidy layout leaves pinned nodes alone.
 *
 * Driven through a SPAWNED server, because the dispatch order is part of what
 * can break: /shots/:id/video/select and /music-cues/:id/select sit beside
 * handlers that match on their first segments and would swallow them. A test
 * that called the route module directly would pass while the real server
 * answered 404. Fixtures go straight into the same database.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Isolation BEFORE any local require, so nothing can open the real database.
const TEST_DIR = path.join(os.tmpdir(), 'film-engine-pgraph-' + crypto.randomUUID().slice(0, 8));
fs.mkdirSync(TEST_DIR, { recursive: true });
process.env.FILM_DATA_DIR = TEST_DIR;
const { testApi } = require('./helpers');
const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();
// A video provider that takes a first AND last keyframe, as a real install has.
// With none, the planner degrades to one still per shot and joins cannot apply.
db.prepare(`INSERT OR REPLACE INTO film_provider_credentials (provider, api_key, meta) VALUES ('runway', 'test-key-not-real', '{}')`).run();

const PORT = 24200 + Math.floor(Math.random() * 400);
const api = testApi(`http://localhost:${PORT}`);
let server;

test.before(async () => {
    server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: { ...process.env, PORT: String(PORT), FILM_DATA_DIR: TEST_DIR }, stdio: 'pipe',
    });
    server.stdout.on('data', () => {}); server.stderr.on('data', () => {});
    for (let i = 0; i < 100; i++) {
        try { const r = await api('/api/health'); if (r.status === 200) return; } catch (_) { /* booting */ }
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('server did not start');
});
test.after(() => { if (server) server.kill('SIGTERM'); try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (_) {} });

/** A project with one scene, four framed shots, and a clip on 1A. */
function fixture() {
    const projectId = generateId(), sceneId = generateId();
    db.prepare('INSERT INTO film_projects (id, title, target_fps) VALUES (?, ?, 24)').run(projectId, 'Graph');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, ?, ?)').run(sceneId, projectId, 1, 'OFFICE');
    const dir = path.join(TEST_DIR, 'storyboards', projectId);
    const vdir = path.join(TEST_DIR, 'video', projectId);
    fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(vdir, { recursive: true });
    const shots = {};
    ['1A', '1B', '1C', '1D'].forEach((code, i) => {
        const id = generateId();
        shots[code] = id;
        db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, sort_order, duration_ms, scene_card_yaml)
                    VALUES (?, ?, ?, ?, 3000, ?)`).run(id, sceneId, code, i, JSON.stringify({ shot_code: code, description: `${code} happens.` }));
        if (code === '1D') return;   // 1D has no frame: it plays as a slate
        for (const v of [1, 2]) {
            const file = path.join(dir, v === 1 ? `${code}_v1.png` : `${code}.png`);
            fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'));
            db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, format, version)
                        VALUES (?, ?, ?, 'storyboard', ?, ?, 'png', ?)`).run(generateId(), projectId, id, file, path.basename(file), v);
        }
    });
    const clips = [1, 2].map(v => {
        const file = path.join(vdir, v === 1 ? '1A.mp4' : '1A_v2.mp4');
        fs.writeFileSync(file, Buffer.alloc(1024, v));
        const id = generateId();
        db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, format, version, duration_ms)
                    VALUES (?, ?, ?, 'video_raw', ?, ?, 'mp4', ?, 3000)`).run(id, projectId, shots['1A'], file, path.basename(file), v);
        return id;
    });
    return { projectId, sceneId, shots, clips };
}

const graphOf = async pid => (await api(`/film/projects/${pid}/production-graph`)).data;

// ── The graph reads what exists ─────────────────────────────────────────────

test('every shot is a node with its frames, and a clip is a version wired to it', async () => {
    const f = fixture();
    const g = await graphOf(f.projectId);
    const shots = g.nodes.filter(n => n.type === 'shot');
    assert.deepStrictEqual(shots.map(s => s.shot_code), ['1A', '1B', '1C', '1D'], 'nodes are not in running order');
    assert.strictEqual(shots[0].frames.length, 2);
    assert.strictEqual(shots[0].selected_frame.version, 2, 'with no pointer the newest frame is the one shown');
    const vids = g.nodes.filter(n => n.type === 'video');
    assert.strictEqual(vids.length, 2, 'each clip is its own version node');
    assert.ok(g.edges.some(e => e.from === `shot:${f.shots['1A']}` && e.to === `ver:${f.clips[0]}` && e.type === 'video'));
    assert.deepStrictEqual(g.pending.map(p => p.label), ['1D'], '"Run pending" must name exactly the shot with no frame');
});

// ── Versions: the selected one is what plays ────────────────────────────────

test('selecting a clip changes what playback plays, and unselecting falls back', async () => {
    const f = fixture();
    const plays = async () => {
        const t = (await api(`/film/projects/${f.projectId}/timeline`)).data;
        const e = t.entries.find(x => x.shot_id === f.shots['1A']);
        return e.video && path.basename(e.video.path);
    };
    const before = await plays();
    const other = before === '1A.mp4' ? f.clips[1] : f.clips[0];
    const r = await api(`/film/shots/${f.shots['1A']}/video/select`, { method: 'POST', body: { asset_id: other } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.notStrictEqual(await plays(), before, 'selecting a version changed nothing on screen');
    await api(`/film/shots/${f.shots['1A']}/video/select`, { method: 'DELETE' });
    assert.strictEqual(await plays(), before);
    const foreign = await api(`/film/shots/${f.shots['1B']}/video/select`, { method: 'POST', body: { asset_id: f.clips[0] } });
    assert.strictEqual(foreign.status, 400, 'a clip of another shot was accepted');
});

test('playback: video where there is a clip, the still where there is a frame, a slate where there is neither', async () => {
    const f = fixture();
    const t = (await api(`/film/projects/${f.projectId}/timeline`)).data;
    const kinds = Object.fromEntries(t.entries.map(e => [e.shot_code, e.kind]));
    assert.deepStrictEqual(kinds, { '1A': 'video', '1B': 'still', '1C': 'still', '1D': 'empty' });
    assert.deepStrictEqual(t.entries.map(e => e.shot_code), ['1A', '1B', '1C', '1D'], 'not in running order');
});

test('a selected sequence clip plays once across its members, and the conform follows it', async () => {
    const f = fixture();
    const seq = (await api(`/film/projects/${f.projectId}/sequences`, { method: 'POST',
        body: { name: 'Pitch', shot_ids: [f.shots['1A'], f.shots['1B'], f.shots['1C']] } })).data.sequence;
    const file = path.join(TEST_DIR, 'video', f.projectId, 'pitch.mp4');
    fs.writeFileSync(file, Buffer.alloc(1024, 9));
    const master = generateId();
    db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, format, version, duration_ms, metadata)
                VALUES (?, ?, ?, 'video_final', ?, 'pitch.mp4', 'mp4', 1, 9000, ?)`)
        .run(master, f.projectId, f.shots['1A'], file, JSON.stringify({ sequence_id: seq.id, kind: 'sequence_master' }));

    const g = await graphOf(f.projectId);
    const sn = g.nodes.find(n => n.key === `seq:${seq.id}`);
    assert.deepStrictEqual(sn.videos.map(v => v.asset_id), [master], 'the master is a version of the SEQUENCE');
    assert.ok(!g.nodes.find(n => n.key === `shot:${f.shots['1A']}`).videos.some(v => v.asset_id === master),
        'the same file is listed as a version of two things');

    const r = await api(`/film/sequences/${seq.id}/video/select`, { method: 'POST', body: { asset_id: master } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    const t = (await api(`/film/projects/${f.projectId}/timeline`)).data;
    assert.deepStrictEqual(t.entries.map(e => e.shot_code), ['1A', '1D'], '1B and 1C played again after the clip that contains them');
    assert.strictEqual(path.basename(t.entries[0].video.path), 'pitch.mp4');
    const { planConform } = require('../lib/conform');
    const plan = planConform(f.projectId);
    const first = (plan.clips || [])[0];
    assert.ok(first && /pitch\.mp4$/.test(first.file_path || ''), 'the master is not the cut playback shows');

    await api(`/film/sequences/${seq.id}/video/select`, { method: 'DELETE' });
    const after = (await api(`/film/projects/${f.projectId}/timeline`)).data;
    assert.deepStrictEqual(after.entries.map(e => e.shot_code), ['1A', '1B', '1C', '1D'], 'unselecting left the coverage behind');
});

// ── Joins: a cut makes nothing ─────────────────────────────────────────────

test('a continuous join plans one clip per leg; a cut plans nothing; no joins plans as before', async () => {
    const f = fixture();
    const ids = [f.shots['1A'], f.shots['1B'], f.shots['1C']];
    const seq = (await api(`/film/projects/${f.projectId}/sequences`, { method: 'POST', body: { name: 'S', shot_ids: ids } })).data.sequence;
    const { planSequence } = require('../lib/video-sequence');
    const list = ['1A', '1B', '1C'].map(c => ({ id: c, shot_code: c, keyframe: `/k/${c}.png`, duration_ms: 4000 }));

    const none = planSequence(list, { maxKeyframes: 2, description: 'd' });
    const allContinuous = planSequence(list, { maxKeyframes: 2, description: 'd', joins: [{ type: 'continuous' }, { type: 'continuous' }] });
    assert.deepStrictEqual(allContinuous.segments.map(s => s.prompt), none.segments.map(s => s.prompt),
        'a continuous join with no words changed the request a sequence without joins sends');

    const r = await api(`/film/sequences/${seq.id}`, { method: 'PUT', body: { joins: [{ type: 'continuous', prompt: 'push in' }, { type: 'cut' }] } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    const plan = (await api(`/film/sequences/${seq.id}/plan`)).data;
    assert.strictEqual(plan.segments.length, 1, 'a cut was planned as a clip');
    assert.match(plan.segments[0].prompt, /push in/, 'the join\'s own words did not reach the request');
    assert.deepStrictEqual(plan.cuts.map(c => `${c.from}>${c.to}`), ['1B>1C']);

    const bad = await api(`/film/sequences/${seq.id}`, { method: 'PUT', body: { joins: [{ type: 'teleport' }] } });
    assert.strictEqual(bad.status, 400, 'an unknown join type was stored');
    const tooMany = await api(`/film/sequences/${seq.id}`, { method: 'PUT', body: { joins: [{}, {}, {}] } });
    assert.strictEqual(tooMany.status, 400, 'more joins than pairs was stored');

    // All cuts: nothing is bought, and it says so rather than failing.
    await api(`/film/sequences/${seq.id}`, { method: 'PUT', body: { joins: [{ type: 'cut' }, { type: 'cut' }] } });
    const gen = await api(`/film/sequences/${seq.id}/generate`, { method: 'POST', body: {} });
    assert.strictEqual(gen.status, 200, JSON.stringify(gen.data));
    assert.deepStrictEqual(gen.data.segments, []);
});

// ── A shot belongs to one sequence ─────────────────────────────────────────

test('a shot belongs to one sequence: a second claim is refused, and move moves it', async () => {
    const f = fixture();
    const a = (await api(`/film/projects/${f.projectId}/sequences`, { method: 'POST', body: { name: 'A', shot_ids: [f.shots['1A'], f.shots['1B']] } })).data.sequence;
    const b = (await api(`/film/projects/${f.projectId}/sequences`, { method: 'POST', body: { name: 'B', shot_ids: [], empty: true } })).data.sequence;
    const refused = await api(`/film/sequences/${b.id}`, { method: 'PUT', body: { shot_ids: [f.shots['1B']] } });
    assert.strictEqual(refused.status, 409);
    assert.strictEqual(refused.data.error, 'SHOT_IN_SEQUENCE');
    const moved = await api(`/film/sequences/${b.id}`, { method: 'PUT', body: { shot_ids: [f.shots['1B']], move: true } });
    assert.strictEqual(moved.status, 200, JSON.stringify(moved.data));
    const aNow = (await api(`/film/sequences/${a.id}`)).data.sequence;
    assert.deepStrictEqual(aNow.shot_ids, [f.shots['1A']], 'the move left the shot in both');
});

test('the boxes read in film order: loose shots, sequences and a new empty sequence last', async () => {
    // A sequence box used to be laid out before EVERY scene of loose shots, so
    // a new sequence jumped in front of shots that play before anything in it.
    const f = fixture();
    const scene2 = generateId();
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, 2, ?)').run(scene2, f.projectId, 'STREET');
    const s2 = ['2A', '2B'].map((code, i) => {
        const id = generateId();
        db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, sort_order, duration_ms, scene_card_yaml)
                    VALUES (?, ?, ?, ?, 3000, ?)`).run(id, scene2, code, i, JSON.stringify({ shot_code: code }));
        return id;
    });
    const seq = (await api(`/film/projects/${f.projectId}/sequences`, { method: 'POST', body: { name: 'Street', shot_ids: s2 } })).data.sequence;
    const empty1 = (await api(`/film/projects/${f.projectId}/sequences`, { method: 'POST', body: { name: 'Later', shot_ids: [], empty: true } })).data.sequence;
    const empty2 = (await api(`/film/projects/${f.projectId}/sequences`, { method: 'POST', body: { name: 'Later still', shot_ids: [], empty: true } })).data.sequence;
    const g = await graphOf(f.projectId);
    assert.deepStrictEqual(g.groups.map(x => x.key),
        [`scene:${f.sceneId}`, `seq:${seq.id}`, `seq:${empty1.id}`, `seq:${empty2.id}`],
        'the boxes are not in the order the film plays, with empty sequences last in the order they were made');
    const xs = g.groups.map(x => x.x);
    assert.deepStrictEqual(xs, [...xs].sort((a, b) => a - b), 'the boxes do not run left to right in that order');
});

// ── Linked frames ──────────────────────────────────────────────────────────

test('a linked frame resolves to the source\'s SELECTED version, and a change marks the receiver stale', async () => {
    const f = fixture();
    const src = (await api(`/film/projects/${f.projectId}/sequences`, { method: 'POST', body: { name: 'Pitch', shot_ids: [f.shots['1A'], f.shots['1B']] } })).data.sequence;
    const dst = (await api(`/film/projects/${f.projectId}/sequences`, { method: 'POST', body: { name: 'Reveal', shot_ids: [f.shots['1C']] } })).data.sequence;
    const put = await api(`/film/sequences/${dst.id}`, { method: 'PUT', body: { start_frame_ref: { sequence_id: src.id, mode: 'shot_image' } } });
    assert.strictEqual(put.status, 200, JSON.stringify(put.data));

    const pg = require('../lib/production-graph');
    const row = () => db.prepare('SELECT * FROM film_sequences WHERE id = ?').get(dst.id);
    let state = pg.linkState(db, row());
    assert.ok(state.start.ok, state.start.reason);
    assert.strictEqual(state.start.shot_code, '1B', 'a start link borrows the source\'s LAST shot');
    assert.strictEqual(state.start.version, 2, 'it did not follow the selected (newest) frame');
    assert.strictEqual(state.stale, false, 'never generated with a link is not stale');

    // Generated with it: record what it resolved to, as generateSequence does.
    db.prepare('UPDATE film_sequences SET link_fingerprint = ? WHERE id = ?').run(state.fingerprint, dst.id);
    // The director selects v1 of 1B.
    db.prepare('UPDATE film_shots SET current_frame_version = 1 WHERE id = ?').run(f.shots['1B']);
    state = pg.linkState(db, row());
    assert.strictEqual(state.start.version, 1, 'the link did not follow the new selection');
    assert.strictEqual(state.stale, true, 'a changed source version did not mark the receiver stale');
    const g = await graphOf(f.projectId);
    assert.ok(g.nodes.find(n => n.key === `seq:${dst.id}`).links.stale, 'the graph does not show it');
    assert.ok(g.nodes.some(n => n.key === `link:${dst.id}:start` && n.type === 'link'), 'no linked-frame node');

    // The borrowed frame travels as a KEYFRAME at the start of the plan, never as a member.
    const plan = (await api(`/film/sequences/${dst.id}/plan`)).data;
    assert.strictEqual(plan.segments.length, 1);
    assert.match(plan.segments[0].from, /1B · v1 \(linked\)/);
    assert.deepStrictEqual((await api(`/film/sequences/${dst.id}`)).data.sequence.shot_ids, [f.shots['1C']], 'the link became membership');

    for (const bad of [{ sequence_id: dst.id }, { sequence_id: src.id, mode: 'hologram' }, { sequence_id: generateId() }]) {
        const r = await api(`/film/sequences/${dst.id}`, { method: 'PUT', body: { start_frame_ref: bad } });
        assert.strictEqual(r.status, 400, `accepted ${JSON.stringify(bad)}`);
    }
});

// ── Layout ─────────────────────────────────────────────────────────────────

test('positions survive a reload, and Tidy re-places only what nobody moved', async () => {
    const f = fixture();
    const g0 = await graphOf(f.projectId);
    const k1 = `shot:${f.shots['1A']}`, k2 = `shot:${f.shots['1B']}`;
    const auto2 = g0.nodes.find(n => n.key === k2);
    const r = await api(`/film/projects/${f.projectId}/production-graph/layout`, { method: 'PUT', body: { nodes: [{ key: k1, x: 900, y: 700 }] } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    // An unpinned row, as an older client might have written.
    db.prepare(`INSERT INTO production_node_layout (project_id, node_key, x, y, pinned) VALUES (?, ?, 5, 5, 0)`).run(f.projectId, k2);

    const g1 = await graphOf(f.projectId);
    const n1 = g1.nodes.find(n => n.key === k1);
    assert.deepStrictEqual([n1.x, n1.y, n1.pinned], [900, 700, true], 'a dragged node did not stay put');

    const tidy = (await api(`/film/projects/${f.projectId}/production-graph/tidy`, { method: 'POST', body: {} })).data;
    const t1 = tidy.nodes.find(n => n.key === k1), t2 = tidy.nodes.find(n => n.key === k2);
    assert.deepStrictEqual([t1.x, t1.y], [900, 700], 'Tidy moved a pinned node');
    assert.deepStrictEqual([t2.x, t2.y], [auto2.x, auto2.y], 'Tidy left an unpinned node where it was');

    const bad = await api(`/film/projects/${f.projectId}/production-graph/layout`, { method: 'PUT', body: { nodes: [{ key: 'nonsense', x: 1, y: 2 }] } });
    assert.strictEqual(bad.status, 400);
});

// ── Sound nodes ────────────────────────────────────────────────────────────

test('a sound wires to a sequence or a shot, takes its scene, and selects among its own versions only', async () => {
    const f = fixture();
    const seq = (await api(`/film/projects/${f.projectId}/sequences`, { method: 'POST', body: { name: 'S', shot_ids: [f.shots['1B']] } })).data.sequence;
    const cue = (await api(`/film/projects/${f.projectId}/music-cues`, { method: 'POST', body: { cue_type: 'score', title: 'Cue' } })).data;
    const wired = await api(`/film/music-cues/${cue.id}`, { method: 'PUT', body: { sequence_id: seq.id } });
    assert.strictEqual(wired.status, 200, JSON.stringify(wired.data));
    assert.strictEqual(wired.data.sequence_id, seq.id);
    assert.strictEqual(wired.data.scene_id, f.sceneId, 'wiring did not give the sound its scene');
    const toShot = (await api(`/film/music-cues/${cue.id}`, { method: 'PUT', body: { shot_id: f.shots['1A'] } })).data;
    assert.deepStrictEqual([toShot.shot_id, toShot.sequence_id], [f.shots['1A'], null], 'a shot and a sequence both claim the sound');

    const file = path.join(TEST_DIR, 'cue.wav');
    fs.writeFileSync(file, Buffer.alloc(64));
    const mine = generateId(), theirs = generateId();
    db.prepare(`INSERT INTO film_assets (id, project_id, scene_id, asset_type, file_path, file_name, format, version, metadata)
                VALUES (?, ?, ?, 'audio_music', ?, 'cue.wav', 'wav', 1, ?)`).run(mine, f.projectId, f.sceneId, file, JSON.stringify({ cue_id: cue.id }));
    db.prepare(`INSERT INTO film_assets (id, project_id, scene_id, asset_type, file_path, file_name, format, version)
                VALUES (?, ?, ?, 'audio_music', ?, 'x.wav', 'wav', 1)`).run(theirs, f.projectId, f.sceneId, file);
    assert.strictEqual((await api(`/film/music-cues/${cue.id}/select`, { method: 'POST', body: { asset_id: mine } })).status, 200);
    assert.strictEqual((await api(`/film/music-cues/${cue.id}/select`, { method: 'POST', body: { asset_id: theirs } })).status, 400,
        'a sound another cue made was selected as this cue\'s');
    const g = await graphOf(f.projectId);
    const node = g.nodes.find(n => n.key === `sound:${cue.id}`);
    assert.strictEqual(node.selected_asset_id, mine);
    assert.ok(g.edges.some(e => e.from === `shot:${f.shots['1A']}` && e.to === node.key && e.type === 'scene'));
});

test('a cue\'s free preview is a GET that spends nothing and shows the text it would send', async () => {
    const f = fixture();
    const cue = (await api(`/film/projects/${f.projectId}/music-cues`, { method: 'POST',
        body: { cue_type: 'sfx', title: 'Door', description: 'a screen door two streets over', scene_id: f.sceneId } })).data;
    const before = db.prepare('SELECT COUNT(*) AS n FROM film_music_jobs').get().n;
    const r = await api(`/film/music-cues/${cue.id}/generate`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.match(r.data.prompt, /screen door/, 'the preview did not show the direction it would send');
    assert.strictEqual(r.data.spends, false);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM film_music_jobs').get().n, before, 'a preview created a job');
});

// ── The page ───────────────────────────────────────────────────────────────

test('the page exists behind the flag, and every drawer action names a route that dispatches', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
    assert.ok(/id="page-productiongraph"/.test(html), 'no production page');
    assert.ok(/data-page="productiongraph"/.test(html), 'no nav entry');
    const { SETTINGS } = require('../routes/app-settings');
    assert.strictEqual(SETTINGS.production_graph && SETTINGS.production_graph.default, false, 'the graph must default off');
    assert.ok(/productiongraph:\s*loadProductionGraph/.test(html), 'the page has no loader');
    // The flag GATES something: which set of pages the menu shows. A flag that
    // is stored and read by nothing is the shape this codebase keeps paying for.
    const apply = html.slice(html.indexOf('async function applyProductionFlag'), html.indexOf('async function saveProductionGraphFlag'));
    assert.match(apply, /production_graph/, 'the page never reads the setting');
    assert.match(apply, /p === 'productiongraph' && !PRODUCTION_GRAPH_ON/, 'the graph is not hidden when the flag is off');
    assert.match(apply, /PRODUCTION_GRAPH_ON && PG_OLD_PAGES\.includes\(p\)/, 'the old pages are not hidden when it is on');
    assert.match(html, /b\.dataset\.fePhase === id && !b\.dataset\.flagHidden/, 'the menu ignores the flag');
    // Every drawer — the five the design draws.
    for (const fn of ['pgDrawerShot', 'pgDrawerSequence', 'pgDrawerSound', 'pgDrawerVersion', 'pgDrawerLink']) {
        assert.ok(new RegExp(`function ${fn}\\(`).test(html), `${fn} is missing`);
    }
    // The routes the page calls, each of which this file proves dispatches.
    for (const route of ['/production-graph/layout', '/production-graph/tidy', '/video/select', '/select', "/frames/${version}/restore"]) {
        assert.ok(html.includes(route), `the page never calls ${route}`);
    }
});
