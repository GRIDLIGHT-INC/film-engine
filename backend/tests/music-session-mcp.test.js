const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/**
 * THE SCORE SESSION OVER MCP: EVERY KIND, EVERY VERB, THE SAME VOCABULARY.
 *
 * MUS-005. The agent host is the model here, so a score session an agent
 * cannot reach is one that must be built by hand. Every child kind the HTTP
 * route exposes gets list / create / update / delete, the session gets its
 * nine operations, and every one dispatches THROUGH handleMusicSessions by
 * the in-process shim — nothing is reimplemented beside the route.
 *
 * The schemas are not typed twice either: every enum a table constrains
 * appears on the create and update tools with `enum` equal to the contract's
 * VOCABULARY, and every range with its bounds, so the model is told what the
 * database will accept before it tries.
 *
 * Reads and briefs say they are free; mutations say what they write.
 */

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-music-mcp-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const { PRODUCTION_TOOLS, listTools, callTool, isFailure, presentResult } = require('../lib/mcp-tools');
const { CHILD_KINDS, handleMusicSessions } = require('../routes/music-sessions');
const contracts = require('../lib/music-session');

const SINGULAR = { tracks: 'track', clips: 'clip', markers: 'marker', 'emotion-ranges': 'emotion', automation: 'automation' };
const VERBS = { list: 'GET', create: 'POST', update: 'PUT', delete: 'DELETE' };
const SESSION_TOOLS = {
    music_session_list: 'GET', music_session_create: 'POST', music_session_get: 'GET', music_session_brief: 'GET',
    music_session_drift: 'GET', music_session_update: 'PUT', music_session_delete: 'DELETE',
    music_session_rebase: 'POST', music_session_batch: 'POST',
};
const tool = name => PRODUCTION_TOOLS.find(t => t.name === name);
const SAMPLE = { project_id: 'P', session_id: 'S', track_id: 'T', clip_id: 'C', marker_id: 'M', emotion_id: 'E', automation_id: 'A' };

// ── Registry ───────────────────────────────────────────────────────────────

test('every child kind has list, create, update and delete tools that reach the route', () => {
    const listed = new Set(listTools().map(t => t.name));
    for (const [kind, spec] of Object.entries(CHILD_KINDS)) {
        assert.ok(SINGULAR[kind], `this suite has no singular for ${kind}`);
        for (const [verb, method] of Object.entries(VERBS)) {
            const name = `music_${SINGULAR[kind]}_${verb}`;
            const t = tool(name);
            assert.ok(t, `no ${name}`);
            assert.ok(listed.has(name), `${name} is registered and not served`);
            assert.strictEqual(t.method, method, `${name} uses ${t.method}`);
            assert.strictEqual(t.handler, handleMusicSessions, `${name} does not dispatch through the session route`);
            const p = t.path(SAMPLE);
            const want = verb === 'update' || verb === 'delete'
                ? `/film/music-sessions/S/${kind}/${SAMPLE[`${SINGULAR[kind]}_id`]}`
                : `/film/music-sessions/S/${kind}`;
            assert.strictEqual(p.split('?')[0], want, `${name} reaches ${p}`);
            assert.ok(t.description && t.description.length > 40, `${name}: description too thin`);
            if (method === 'GET') assert.match(t.description, /free/i, `${name} does not say it is free`);
            else assert.match(t.description, /\b(writes|creates|adds|changes|updates|deletes|removes|moves)\b/i, `${name} does not say what it writes`);
        }
        assert.ok(spec.table, `${kind} has no table`);
    }
});

test('every session tool exists with its method, and says whether it is free', () => {
    for (const [name, method] of Object.entries(SESSION_TOOLS)) {
        const t = tool(name);
        assert.ok(t, `no ${name}`);
        assert.strictEqual(t.method, method, `${name} uses ${t.method}`);
        assert.strictEqual(t.handler, handleMusicSessions);
        const p = t.path(SAMPLE);
        assert.match(p, /^\/film\/(projects\/P\/music-sessions|music-sessions\/S)/, `${name} reaches ${p}`);
        if (method === 'GET') assert.match(t.description, /free/i, `${name} does not say it is free`);
        else assert.match(t.description, /\b(writes|creates|changes|deletes|removes|rebases|applies|stamps)\b/i, `${name} does not say what it writes`);
    }
    assert.match(tool('music_session_brief').description, /spends nothing|free/i);
    assert.match(tool('music_session_drift').description, /writes nothing|never writes|does not (write|change)/i, 'drift must promise it changes nothing');
    assert.match(tool('music_session_rebase').description, /explicit|rebase/i);
});

test('create and update schemas carry the contract\'s own vocabulary and bounds', () => {
    for (const [kind, spec] of Object.entries(CHILD_KINDS)) {
        for (const verb of ['create', 'update']) {
            const t = tool(`music_${SINGULAR[kind]}_${verb}`);
            for (const [key, values] of Object.entries(contracts.VOCABULARY)) {
                const [table, column] = key.split('.');
                if (table !== spec.table) continue;
                if (['muted', 'soloed'].includes(column)) {
                    assert.strictEqual(t.schema[column] && t.schema[column].type, 'boolean', `${t.name}.${column} is not a boolean`);
                    continue;
                }
                assert.ok(t.schema[column], `${t.name} does not offer ${column}`);
                assert.deepStrictEqual(t.schema[column].enum, values, `${t.name}.${column}: enum differs from the contract`);
            }
            for (const [key, { min, max }] of Object.entries(contracts.RANGES)) {
                const [table, column] = key.split('.');
                if (table !== spec.table) continue;
                assert.ok(t.schema[column], `${t.name} does not offer ${column}`);
                assert.deepStrictEqual([t.schema[column].minimum, t.schema[column].maximum], [min, max], `${t.name}.${column}: bounds differ`);
            }
        }
    }
    const sess = tool('music_session_create');
    assert.deepStrictEqual(sess.schema.status && sess.schema.status.enum, undefined, 'a session is created as a draft; status is not an argument on create');
    assert.deepStrictEqual(tool('music_session_update').schema.status.enum, contracts.VOCABULARY['film_music_sessions.status']);
    assert.deepStrictEqual(sess.schema.sample_rate.enum, contracts.VOCABULARY['film_music_sessions.sample_rate']);
});

// ── Round trip through the shim ────────────────────────────────────────────

function film() {
    const f = { project: generateId() };
    db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'M')").run(f.project);
    f.scene = generateId();
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, '1', 'X')").run(f.scene, f.project);
    f.shot = generateId();
    db.prepare("INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms, sort_order) VALUES (?, ?, '1A', '{}', 2000, 0)").run(f.shot, f.scene);
    f.sequence = generateId();
    db.prepare("INSERT INTO film_sequences (id, project_id, name, shot_ids) VALUES (?, ?, 'seq', ?)").run(f.sequence, f.project, JSON.stringify([f.shot]));
    return f;
}
const shown = r => presentResult(r);

test('an agent can build, read, correct and dismantle a session, through the route', async () => {
    const f = film();
    const created = await callTool('music_session_create', { project_id: f.project, sequence_id: f.sequence, name: 'Score' });
    assert.ok(!isFailure(created), JSON.stringify(created).slice(0, 200));
    const sid = shown(created).session.id;

    const list = shown(await callTool('music_session_list', { project_id: f.project }));
    assert.deepStrictEqual(list.sessions.map(s => s.id), [sid]);

    const trk = shown(await callTool('music_track_create', { session_id: sid, name: 'cello', role_kind: 'instrument', pan: -0.5 }));
    assert.ok(trk.id, JSON.stringify(trk));
    const clip = shown(await callTool('music_clip_create', { session_id: sid, track_id: trk.id, start_ms: 0, duration_ms: 1000, source_kind: 'imported' }));
    assert.ok(clip.id, JSON.stringify(clip));

    const model = shown(await callTool('music_session_get', { session_id: sid }));
    assert.deepStrictEqual(Object.keys(model), contracts.SCORE_SESSION_SHAPE, 'the tool does not hand over the one read model');
    assert.strictEqual(model.tracks[0].clips[0].id, clip.id);

    // A value the database refuses is refused with the field named, so the
    // agent corrects rather than retries.
    const bad = await callTool('music_clip_update', { session_id: sid, clip_id: clip.id, loop_policy: 'forever' });
    assert.ok(isFailure(bad), 'an illegal loop_policy was accepted');
    assert.match(JSON.stringify(bad), /loop_policy/);

    const moved = shown(await callTool('music_clip_update', { session_id: sid, clip_id: clip.id, start_ms: 750 }));
    assert.strictEqual(moved.start_ms, 750);

    const brief = shown(await callTool('music_session_brief', { session_id: sid }));
    assert.strictEqual(brief.brief.picture.shots.length, 1);
    const drift = shown(await callTool('music_session_drift', { session_id: sid }));
    assert.deepStrictEqual([drift.tracked, drift.drifted], [true, false]);

    const batch = shown(await callTool('music_session_batch', { session_id: sid, ops: [
        { op: 'create', kind: 'markers', data: { position_ms: 100, kind: 'hit' } },
        { op: 'create', kind: 'emotion-ranges', data: { start_ms: 0, end_ms: 1000, label: 'dread' } },
    ] }));
    assert.strictEqual(batch.applied, 2, JSON.stringify(batch));

    const lists = {
        marker: shown(await callTool('music_marker_list', { session_id: sid })).items.length,
        emotion: shown(await callTool('music_emotion_list', { session_id: sid })).items.length,
        automation: shown(await callTool('music_automation_list', { session_id: sid })).items.length,
    };
    assert.deepStrictEqual(lists, { marker: 1, emotion: 1, automation: 0 });

    const jump = await callTool('music_session_update', { session_id: sid, status: 'approved' });
    assert.ok(isFailure(jump), 'a draft was approved directly');
    assert.match(JSON.stringify(jump), /draft/);

    assert.ok(!isFailure(await callTool('music_clip_delete', { session_id: sid, clip_id: clip.id })));
    assert.ok(!isFailure(await callTool('music_session_rebase', { session_id: sid })));
    assert.ok(!isFailure(await callTool('music_session_delete', { session_id: sid })));
    assert.ok(isFailure(await callTool('music_session_get', { session_id: sid })), 'a deleted session still reads');
});
