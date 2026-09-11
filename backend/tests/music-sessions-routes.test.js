const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/**
 * THE SESSION HTTP API: EVERY KIND, EVERY VERB, INSIDE ITS OWN PROJECT.
 *
 * MUS-004. `routes/music-sessions.js` is the first consumer of the contracts
 * (MUS-002) and the brief (MUS-003), and it must add nothing of its own: a
 * write is a validator's verdict, a read is `readScoreSession`, drift is
 * `sessionDrift`, and the rebase is `stampSessionContext`. A route that
 * re-derives any of those is the second shape this epic exists to prevent.
 *
 * Set-based over the route's CHILD_KINDS registry, which is held equal to the
 * schema's child tables: for every kind, create, read back through the one
 * read model, update, refuse a value the schema refuses, delete, and refuse a
 * row that belongs to another session. Then the batch, which is ORDERED and
 * ATOMIC — a failing third op leaves the first two unwritten.
 */

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-music-routes-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const route = require('../routes/music-sessions');
const contracts = require('../lib/music-session');

const FOUNTAIN = ['INT. DINER - NIGHT', '', 'RAY sits.', '', 'RAY', 'Where were you?', '', 'EXT. STREET - DAWN', '', 'June walks.', ''].join('\n');

function film() {
    const f = { project: generateId() };
    db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'R')").run(f.project);
    f.script = generateId();
    db.prepare("INSERT INTO film_scripts (id, project_id, version, content, fountain_content, format) VALUES (?, ?, 1, ?, ?, 'fountain')").run(f.script, f.project, FOUNTAIN, FOUNTAIN);
    f.scene = generateId();
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, int_ext, location, time_of_day, description) VALUES (?, ?, '1', 'INT', 'DINER', 'NIGHT', 'RAY sits.')").run(f.scene, f.project);
    f.shot = generateId();
    db.prepare("INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms, sort_order) VALUES (?, ?, '1A', '{\"characters\":[\"RAY\"]}', 2000, 0)").run(f.shot, f.scene);
    f.sequence = generateId();
    db.prepare("INSERT INTO film_sequences (id, project_id, name, shot_ids) VALUES (?, ?, 'Opening', ?)").run(f.sequence, f.project, JSON.stringify([f.shot]));
    return f;
}

function call(method, url, body, query) {
    return new Promise((resolve, reject) => {
        const res = {
            statusCode: 200,
            writeHead(c) { this.statusCode = c; return this; },
            end(p) { resolve({ status: this.statusCode, body: JSON.parse(p || '{}') }); },
        };
        Promise.resolve(route.handleMusicSessions({ method, url, body: body || {} }, res, url.split('?')[0].split('/').filter(Boolean), query || {}))
            .then(r => { if (r === false) resolve({ status: 404, body: { unrouted: true } }); })
            .catch(reject);
    });
}

async function session(f, extra) {
    const r = await call('POST', `/film/projects/${f.project}/music-sessions`, { name: 'S', sequence_id: f.sequence, ...(extra || {}) });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    return r.body.session.id;
}

/** The smallest valid body per kind; `$track` is filled with a track of the session. */
const MINIMAL = {
    tracks: { name: 'cello' },
    clips: { track_id: '$track', start_ms: 0, duration_ms: 1000 },
    markers: { position_ms: 500 },
    'emotion-ranges': { start_ms: 0, end_ms: 1000 },
    automation: { track_id: '$track', parameter: 'gain' },
};
/** One legal change per kind, and the field to read it back from. */
const CHANGE = {
    tracks: { name: 'viola' }, clips: { start_ms: 250 }, markers: { label: 'hit' },
    'emotion-ranges': { label: 'dread' }, automation: { interpolation: 'hold' },
};

async function track(sid) {
    const r = await call('POST', `/film/music-sessions/${sid}/tracks`, { name: 't' });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    return r.body.id;
}
function fill(body, trackId) {
    return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, v === '$track' ? trackId : v]));
}
/** Where a kind's rows appear in the read model. */
function locate(model, kind, id) {
    if (kind === 'tracks') return model.tracks.find(t => t.id === id);
    if (kind === 'clips') return model.tracks.flatMap(t => t.clips).find(c => c.id === id);
    if (kind === 'automation') return model.tracks.flatMap(t => t.automation).find(a => a.id === id);
    if (kind === 'markers') return model.markers.find(m => m.id === id);
    if (kind === 'emotion-ranges') return model.emotion_ranges.find(e => e.id === id);
    throw new Error(`no locator for ${kind}`);
}

// ── Registry and dispatch ──────────────────────────────────────────────────

test('every child table is a kind on the route, and server.js dispatches the route before the project catch-all', () => {
    const kinds = route.CHILD_KINDS;
    const tables = Object.values(kinds).map(k => k.table).sort();
    const expected = contracts.TABLES.filter(t => !['film_music_sessions', 'film_music_operations'].includes(t)).sort();
    assert.deepStrictEqual(tables, expected, 'CHILD_KINDS and the schema\'s child tables disagree');
    for (const [kind, spec] of Object.entries(kinds)) {
        assert.ok(['session', 'track'].includes(spec.owner), `${kind}: owner must be session or track`);
        assert.ok(MINIMAL[kind] && CHANGE[kind], `this suite has no minimal body or change for ${kind}`);
    }
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(server, /require\('\.\/routes\/music-sessions'\)/, 'server.js does not load the route');
    const at = server.indexOf("'music-sessions'");
    assert.ok(at > 0, 'server.js never dispatches music-sessions');
    const catchAll = server.indexOf('handleProjects(');
    assert.ok(catchAll > 0 && at < catchAll, 'music-sessions is dispatched after the project catch-all, which swallows it');
});

// ── Sessions ───────────────────────────────────────────────────────────────

test('a session is created inside its project, stamped, read as the one model, and deleted', async () => {
    const f = film();
    const other = film();
    // A picture unit of another project is refused as not found, never used.
    const foreign = await call('POST', `/film/projects/${f.project}/music-sessions`, { sequence_id: other.sequence });
    assert.strictEqual(foreign.status, 404, JSON.stringify(foreign.body));
    const nothing = await call('POST', `/film/projects/${f.project}/music-sessions`, { name: 'x' });
    assert.strictEqual(nothing.status, 400, 'a session attached to nothing was accepted');
    assert.match(nothing.body.error, /sequence|scene/i);

    const sid = await session(f);
    const row = db.prepare('SELECT * FROM film_music_sessions WHERE id = ?').get(sid);
    assert.ok(row.context_fingerprint, 'a created session was not stamped with what it was written against');
    assert.strictEqual(row.script_id, f.script);

    const list = await call('GET', `/film/projects/${f.project}/music-sessions`);
    assert.strictEqual(list.status, 200);
    assert.deepStrictEqual(list.body.sessions.map(s => s.id), [sid]);
    assert.strictEqual((await call('GET', `/film/projects/${other.project}/music-sessions`)).body.sessions.length, 0);

    const read = await call('GET', `/film/music-sessions/${sid}`);
    assert.strictEqual(read.status, 200);
    assert.deepStrictEqual(Object.keys(read.body), contracts.SCORE_SESSION_SHAPE, 'the route does not answer with the read model');
    assert.strictEqual((await call('GET', `/film/music-sessions/${sid}`, null, { project_id: other.project })).status, 404, 'read across projects');

    // Lifecycle through the contract: approval is not reachable from a draft.
    const jump = await call('PUT', `/film/music-sessions/${sid}`, { status: 'approved' });
    assert.strictEqual(jump.status, 409, JSON.stringify(jump.body));
    assert.match(jump.body.error, /draft.*approved|approved.*draft/);
    const step = await call('PUT', `/film/music-sessions/${sid}`, { status: 'arranging', name: 'Renamed' });
    assert.strictEqual(step.status, 200, JSON.stringify(step.body));
    assert.strictEqual(step.body.session.status, 'arranging');
    assert.strictEqual(step.body.session.name, 'Renamed');
    const bad = await call('PUT', `/film/music-sessions/${sid}`, { sample_rate: 12345 });
    assert.strictEqual(bad.status, 400);
    assert.ok(bad.body.errors.some(e => e.field === 'sample_rate'));
    assert.strictEqual(db.prepare('SELECT sample_rate FROM film_music_sessions WHERE id = ?').get(sid).sample_rate, 48000, 'a refused write changed the row');

    const gone = await call('DELETE', `/film/music-sessions/${sid}`);
    assert.strictEqual(gone.status, 200);
    assert.strictEqual((await call('GET', `/film/music-sessions/${sid}`)).status, 404);
});

// ── Every child kind ───────────────────────────────────────────────────────

test('every child kind: create, read back through the model, update, refuse, own, delete', async () => {
    for (const [kind, spec] of Object.entries(route.CHILD_KINDS)) {
        const f = film();
        const sid = await session(f);
        const otherSid = await session(f, { name: 'other' });
        const t = await track(sid);
        const otherTrack = await track(otherSid);

        const made = await call('POST', `/film/music-sessions/${sid}/${kind}`, fill(MINIMAL[kind], t));
        assert.strictEqual(made.status, 201, `${kind}: ${JSON.stringify(made.body)}`);
        const id = made.body.id;
        let model = (await call('GET', `/film/music-sessions/${sid}`)).body;
        assert.ok(locate(model, kind, id), `${kind}: created and not in the read model`);

        const changed = await call('PUT', `/film/music-sessions/${sid}/${kind}/${id}`, CHANGE[kind]);
        assert.strictEqual(changed.status, 200, `${kind}: ${JSON.stringify(changed.body)}`);
        model = (await call('GET', `/film/music-sessions/${sid}`)).body;
        const [field, value] = Object.entries(CHANGE[kind])[0];
        assert.strictEqual(locate(model, kind, id)[field], value, `${kind}: the update did not reach the read model`);

        // A value the schema refuses is refused by the validator, and the
        // row is untouched — derived from the vocabulary, not typed.
        const enumKey = Object.keys(contracts.VOCABULARY).find(k => k.startsWith(spec.table + '.') && typeof contracts.VOCABULARY[k][0] === 'string');
        const column = enumKey.split('.')[1];
        const refused = await call('PUT', `/film/music-sessions/${sid}/${kind}/${id}`, { [column]: 'not-a-real-value' });
        assert.strictEqual(refused.status, 400, `${kind}: accepted a ${column} the schema refuses`);
        assert.ok(refused.body.errors.some(e => e.field === column), `${kind}: refusal does not name ${column}`);
        assert.strictEqual(locate((await call('GET', `/film/music-sessions/${sid}`)).body, kind, id)[field], value, `${kind}: a refused write changed the row`);

        // Ownership: another session's URL cannot reach this row, and a
        // track-owned kind cannot be placed on another session's track.
        assert.strictEqual((await call('PUT', `/film/music-sessions/${otherSid}/${kind}/${id}`, CHANGE[kind])).status, 404, `${kind}: updated through another session`);
        assert.strictEqual((await call('DELETE', `/film/music-sessions/${otherSid}/${kind}/${id}`)).status, 404, `${kind}: deleted through another session`);
        if (spec.owner === 'track') {
            const stray = await call('POST', `/film/music-sessions/${sid}/${kind}`, fill(MINIMAL[kind], otherTrack));
            assert.strictEqual(stray.status, 404, `${kind}: placed on another session's track`);
        }

        const gone = await call('DELETE', `/film/music-sessions/${sid}/${kind}/${id}`);
        assert.strictEqual(gone.status, 200, `${kind}: ${JSON.stringify(gone.body)}`);
        assert.ok(!locate((await call('GET', `/film/music-sessions/${sid}`)).body, kind, id), `${kind}: deleted and still in the model`);
        assert.strictEqual((await call('DELETE', `/film/music-sessions/${sid}/${kind}/${id}`)).status, 404, `${kind}: deleting twice did not 404`);
    }
});

// ── Batch: ordered, atomic, with references ────────────────────────────────

test('a batch applies in order, resolves references to earlier results, and a failure writes nothing', async () => {
    const f = film();
    const sid = await session(f);
    const counts = () => ({
        tracks: db.prepare('SELECT COUNT(*) n FROM film_music_tracks WHERE session_id = ?').get(sid).n,
        markers: db.prepare('SELECT COUNT(*) n FROM film_music_markers WHERE session_id = ?').get(sid).n,
    });
    const before = counts();
    const broken = await call('POST', `/film/music-sessions/${sid}/batch`, { ops: [
        { op: 'create', kind: 'tracks', data: { name: 'strings' } },
        { op: 'create', kind: 'markers', data: { position_ms: 100, kind: 'hit' } },
        { op: 'create', kind: 'clips', data: { track_id: '$0', start_ms: 0, duration_ms: 0 } },
    ] });
    assert.strictEqual(broken.status, 400, JSON.stringify(broken.body));
    assert.strictEqual(broken.body.failed_at, 2, 'the failing op is not named by index');
    assert.ok(broken.body.errors.some(e => e.field === 'duration_ms'));
    assert.deepStrictEqual(counts(), before, 'a failed batch left earlier ops written');

    const ok = await call('POST', `/film/music-sessions/${sid}/batch`, { ops: [
        { op: 'create', kind: 'tracks', data: { name: 'strings' } },
        { op: 'create', kind: 'clips', data: { track_id: '$0', start_ms: 0, duration_ms: 1000 } },
        { op: 'update', kind: 'clips', id: '$1', data: { start_ms: 500 } },
        { op: 'create', kind: 'markers', data: { position_ms: 100, kind: 'hit' } },
        { op: 'delete', kind: 'markers', id: '$3' },
    ] });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(ok.body.results.length, 5);
    const model = (await call('GET', `/film/music-sessions/${sid}`)).body;
    const strings = model.tracks.find(t => t.name === 'strings');
    assert.ok(strings, 'the batch\'s track is missing');
    assert.strictEqual(strings.clips.length, 1);
    assert.strictEqual(strings.clips[0].start_ms, 500, 'the batch\'s update did not apply');
    assert.strictEqual(model.markers.length, 0, 'the batch\'s delete did not apply');
    // A reference to a result that does not exist is a bad batch, not a crash.
    const dangling = await call('POST', `/film/music-sessions/${sid}/batch`, { ops: [{ op: 'update', kind: 'tracks', id: '$9', data: { name: 'x' } }] });
    assert.strictEqual(dangling.status, 400);
    assert.strictEqual((await call('POST', `/film/music-sessions/${sid}/batch`, { ops: 'nope' })).status, 400);
});

// ── Brief, drift, rebase ───────────────────────────────────────────────────

test('the brief is free, drift is reported, and the rebase is explicit', async () => {
    const f = film();
    const sid = await session(f);
    const brief = await call('GET', `/film/music-sessions/${sid}/brief`);
    assert.strictEqual(brief.status, 200);
    assert.strictEqual(brief.body.brief.picture.shots.length, 1);
    assert.ok(brief.body.fingerprints.context);

    let drift = await call('GET', `/film/music-sessions/${sid}/drift`);
    assert.deepStrictEqual([drift.body.tracked, drift.body.drifted], [true, false]);

    db.prepare("INSERT INTO film_scripts (id, project_id, version, content, fountain_content, format) VALUES (?, ?, 2, ?, ?, 'fountain')")
        .run(generateId(), f.project, FOUNTAIN.replace('Where were you?', 'Where have you been?'), FOUNTAIN.replace('Where were you?', 'Where have you been?'));
    drift = await call('GET', `/film/music-sessions/${sid}/drift`);
    assert.strictEqual(drift.body.drifted, true);
    assert.strictEqual(drift.body.script.changed, true);
    // Reading did not rebase.
    assert.strictEqual((await call('GET', `/film/music-sessions/${sid}/drift`)).body.drifted, true);

    const rebase = await call('POST', `/film/music-sessions/${sid}/rebase`);
    assert.strictEqual(rebase.status, 200, JSON.stringify(rebase.body));
    assert.strictEqual((await call('GET', `/film/music-sessions/${sid}/drift`)).body.drifted, false);
    assert.strictEqual(db.prepare('SELECT script_id FROM film_music_sessions WHERE id = ?').get(sid).script_id !== f.script, true, 'the rebase did not move the session onto the new script version');
});
