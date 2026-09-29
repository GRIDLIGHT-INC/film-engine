/**
 * THE SCORE IS WHERE THIS HAPPENS.
 *
 * "First of all the score should be where this all happens." A cue's MIDI panel
 * can play a part; it cannot build a composition. The score session is the place
 * with the lanes, the ruler, the mixer and the takes — so a track carries its
 * OWN notes and its OWN instrument, and playing it lands the audio as a take in
 * that track's lane.
 *
 * The failure is partial by nature: a lane with no notes, a lane with no
 * instrument, an instrument whose plugin has been uninstalled and a render that
 * came back silent are four different problems that each look like "the button
 * does nothing", so each is held to refusing by NAME. The audio path runs
 * against a fake sidecar serving real WAV bytes, so nobody's library has to be
 * installed for this to be tested.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-score-instr-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const instruments = require('../lib/instruments');
const { handleMusicSessions } = require('../routes/music-sessions');
const { listTools } = require('../lib/mcp-tools');
const { resolveFfmpeg } = require('../lib/ffmpeg');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-score-instr-'));
const FF = resolveFfmpeg();
const TOKEN = 'z'.repeat(24);

function call(method, parts, body, query) {
    return new Promise(resolve => {
        const res = { writeHead(s) { this._s = s; }, end(p) { resolve({ status: this._s, body: p ? JSON.parse(p) : null }); } };
        Promise.resolve(handleMusicSessions({ method, body }, res, parts, query || {}));
    });
}
const render = (sessionId, trackId) => call('POST', ['film', 'music-sessions', sessionId, 'tracks', trackId, 'render'], {});

function fakePlugin(name = 'Sampler.vst3') {
    const p = path.join(TMP, name);
    fs.mkdirSync(p, { recursive: true });
    return p;
}

function tone(file, seconds, silent = false) {
    const source = silent ? `anullsrc=r=48000:cl=stereo:d=${seconds}` : `sine=frequency=330:duration=${seconds}`;
    execFileSync(FF.bin, ['-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', source, '-ac', '2', '-ar', '48000', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    return fs.readFileSync(file);
}

/** A sidecar that hands back the same bytes however it is asked. */
async function sidecarServing(bytes) {
    const server = http.createServer((req, res) => {
        req.on('data', () => {});
        req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': bytes.length, 'X-Render': '{"render_seconds":0.2}' });
            res.end(bytes);
        });
    });
    await new Promise(ok => server.listen(0, '127.0.0.1', ok));
    process.env.INSTRUMENT_SIDECAR_URL = `http://127.0.0.1:${server.address().port}`;
    process.env.INSTRUMENT_SIDECAR_TOKEN = TOKEN;
    return server;
}

/** A project with a score session over a scene, and one empty lane on it. */
async function seedSession() {
    const projectId = generateId(), sceneId = generateId();
    db.prepare('INSERT INTO film_projects (id, title, target_fps) VALUES (?, ?, 24)').run(projectId, 'Scored');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number, estimated_duration) VALUES (?, ?, ?, 30)')
        .run(sceneId, projectId, '1');
    const made = await call('POST', ['film', 'projects', projectId, 'music-sessions'], { name: 'Score', scene_id: sceneId });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    const session = made.body.session || made.body;
    const track = await call('POST', ['film', 'music-sessions', session.id, 'tracks'], { name: 'Melody', role_kind: 'instrument', role: 'lead' });
    assert.strictEqual(track.status, 201, JSON.stringify(track.body));
    return { projectId, sceneId, sessionId: session.id, trackId: track.body.id };
}

const PART = {
    program: 42,
    notes: [
        { start_ms: 0, duration_ms: 900, pitch: 60, velocity: 100 },
        { start_ms: 1000, duration_ms: 900, pitch: 64, velocity: 100 },
    ],
};

test('a track carries its own notes and its own instrument, validated as a part', async () => {
    const { sessionId, trackId } = await seedSession();
    const ok = await call('PUT', ['film', 'music-sessions', sessionId, 'tracks', trackId], { notes: PART });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(ok.body.notes.notes.length, 2);
    assert.strictEqual(ok.body.notes.program, 42, 'the instrument number was lost');

    // The part is held to the same rules a cue's MIDI is: milliseconds, and a
    // pitch a keyboard has. A refusal names the field, as every other write here does.
    const bad = await call('PUT', ['film', 'music-sessions', sessionId, 'tracks', trackId],
        { notes: { notes: [{ start_ms: 0, duration_ms: 100, pitch: 999, velocity: 100 }] } });
    assert.strictEqual(bad.status, 400);
    assert.match(String(bad.body.error), /pitch 999/, JSON.stringify(bad.body));

    // And the good part survived the refusal.
    const back = await call('GET', ['film', 'music-sessions', sessionId, 'tracks'], null);
    assert.strictEqual(back.body.items.find(t => t.id === trackId).notes.notes.length, 2);
});

test('every way a lane cannot play yet is refused by name, never silently', async () => {
    const { sessionId, trackId } = await seedSession();

    const noNotes = await render(sessionId, trackId);
    assert.strictEqual(noNotes.status, 412, JSON.stringify(noNotes.body));
    assert.match(noNotes.body.error, /no notes/i);
    assert.match(noNotes.body.fix, /music_track_update/, 'the refusal does not say how to write a part');

    await call('PUT', ['film', 'music-sessions', sessionId, 'tracks', trackId], { notes: PART });
    const noInstrument = await render(sessionId, trackId);
    assert.strictEqual(noInstrument.status, 400, JSON.stringify(noInstrument.body));
    assert.match(noInstrument.body.error, /no instrument/i);
    assert.ok(Array.isArray(noInstrument.body.instruments), 'it refuses without offering what is in the library');
    assert.match(noInstrument.body.find, /catalogue/, 'it does not say where to find a sound');

    // An instrument whose plugin has been uninstalled: the row is fine and the
    // sound cannot be made, which is a different sentence from "no instrument".
    const plugin = fakePlugin('Vanishing.vst3');
    const gone = instruments.createCaptured({ name: 'Gone', plugin, state: Buffer.from('PATCH').toString('base64') });
    fs.rmSync(plugin, { recursive: true, force: true });
    await call('PUT', ['film', 'music-sessions', sessionId, 'tracks', trackId], { instrument_id: gone.id });
    const missing = await render(sessionId, trackId);
    assert.strictEqual(missing.status, 409, JSON.stringify(missing.body));
    assert.match(missing.body.error, /Gone/, 'the refusal does not name the instrument');

    // A track in another session is not found, never another session's lane.
    const other = await seedSession();
    const across = await render(other.sessionId, trackId);
    assert.strictEqual(across.status, 404, JSON.stringify(across.body));
});

test('a part played by an instrument lands as a take in its own lane, and says where the sound came from', async () => {
    const { sessionId, trackId, projectId } = await seedSession();
    await call('PUT', ['film', 'music-sessions', sessionId, 'tracks', trackId], { notes: PART });

    const plugin = fakePlugin('Player.vst3');
    const inst = instruments.createCaptured({
        name: 'Vortex Bells', plugin, state: Buffer.from('PATCH').toString('base64'),
        library: 'Ethereal Earth', source_ref: 'kontakt:1423', source_file: '/Users/x/Vortex Bells.nki',
    });
    await call('PUT', ['film', 'music-sessions', sessionId, 'tracks', trackId], { instrument_id: inst.id });

    const server = await sidecarServing(tone(path.join(TMP, 'take.wav'), 6));
    try {
        const first = await render(sessionId, trackId);
        assert.strictEqual(first.status, 201, JSON.stringify(first.body));
        assert.match(first.body.spends, /nothing/, 'a render on this machine must not read as a purchase');
        assert.strictEqual(first.body.instrument, 'Vortex Bells');
        assert.strictEqual(first.body.library, 'Ethereal Earth');
        assert.ok(first.body.levels.max_db > -60, `the take is silent: ${JSON.stringify(first.body.levels)}`);

        // It is a clip on THAT lane, and the first one is what plays.
        const model = await call('GET', ['film', 'music-sessions', sessionId], null);
        const lane = model.body.tracks.find(t => t.id === trackId);
        assert.strictEqual(lane.clips.length, 1);
        assert.strictEqual(lane.clips[0].take_status, 'selected');
        assert.strictEqual(lane.clips[0].source_kind, 'generated');

        // Where the sound came from, recorded on the file rather than in a name.
        const asset = db.prepare('SELECT * FROM film_assets WHERE id = ?').get(first.body.asset_id);
        assert.strictEqual(asset.project_id, projectId);
        const meta = JSON.parse(asset.metadata);
        assert.strictEqual(meta.kind, 'instrument_render');
        assert.strictEqual(meta.track_id, trackId);
        assert.strictEqual(meta.library, 'Ethereal Earth');
        assert.strictEqual(meta.source_ref, 'kontakt:1423', 'the catalogue row it came from was not kept');
        assert.ok(fs.existsSync(asset.file_path), 'the audio was registered and never written');

        /*
         * PLAYING IT AGAIN IS A TAKE, NOT A REPLACEMENT. What is playing keeps
         * playing until somebody selects the new one — the rule every other
         * generated output on a score session follows.
         */
        const second = await render(sessionId, trackId);
        assert.strictEqual(second.status, 201, JSON.stringify(second.body));
        const after = await call('GET', ['film', 'music-sessions', sessionId], null);
        const clips = after.body.tracks.find(t => t.id === trackId).clips;
        assert.strictEqual(clips.length, 2, 'the second play replaced the first instead of joining it');
        assert.strictEqual(clips.filter(c => c.take_status === 'selected').length, 1, 'two takes are playing at once');
        assert.strictEqual(clips.find(c => c.id === second.body.clip.id).take_status, 'candidate');
        assert.match(second.body.note, /still plays/, 'the take semantics are not said where they are chosen');
    } finally { server.close(); }
});

test('a render that comes back silent is refused rather than kept', async () => {
    const { sessionId, trackId } = await seedSession();
    await call('PUT', ['film', 'music-sessions', sessionId, 'tracks', trackId], { notes: PART });
    const inst = instruments.createCaptured({ name: 'Quiet', plugin: fakePlugin('Quiet.vst3'), state: Buffer.from('P').toString('base64') });
    await call('PUT', ['film', 'music-sessions', sessionId, 'tracks', trackId], { instrument_id: inst.id });

    const server = await sidecarServing(tone(path.join(TMP, 'silent.wav'), 6, true));
    try {
        const r = await render(sessionId, trackId);
        assert.strictEqual(r.status, 422, JSON.stringify(r.body));
        assert.strictEqual(r.body.stage, 'silence', 'the refusal does not name the stage it stopped at');
        const model = await call('GET', ['film', 'music-sessions', sessionId], null);
        assert.strictEqual(model.body.tracks.find(t => t.id === trackId).clips.length, 0,
            'a silent take was kept on the lane');
    } finally { server.close(); }
});

test('the sidecar being absent is a 503 that says how to start one, not a dead lane', async () => {
    const { sessionId, trackId } = await seedSession();
    await call('PUT', ['film', 'music-sessions', sessionId, 'tracks', trackId], { notes: PART });
    const inst = instruments.createCaptured({ name: 'Any', plugin: fakePlugin('Any.vst3'), state: Buffer.from('P').toString('base64') });
    await call('PUT', ['film', 'music-sessions', sessionId, 'tracks', trackId], { instrument_id: inst.id });

    const saved = process.env.INSTRUMENT_SIDECAR_TOKEN;
    delete process.env.INSTRUMENT_SIDECAR_TOKEN;
    try {
        const r = await render(sessionId, trackId);
        assert.strictEqual(r.status, 503, JSON.stringify(r.body));
        assert.match(r.body.guide, /instrument-sidecar/);
    } finally { if (saved) process.env.INSTRUMENT_SIDECAR_TOKEN = saved; }
});

test('an agent can compose a score: write a part, choose a sound, play the lane', () => {
    const tools = new Map(listTools().map(t => [t.name, t]));
    const play = tools.get('music_track_render');
    assert.ok(play, 'a track a person can play and an agent cannot is half the feature');
    assert.deepStrictEqual(play.inputSchema.required, ['session_id', 'track_id']);
    assert.match(play.description, /free/i, 'a free action that does not say so reads as a purchase');
    assert.match(play.description, /candidate/i, 'the take semantics are not stated where the agent reads them');
    assert.match(play.description, /instrument_list|instrument_/, 'it does not say where an instrument comes from');

    // And the two fields that make a lane playable are writable from there.
    const update = tools.get('music_track_update');
    assert.ok(update.inputSchema.properties.notes, 'music_track_update cannot write the part');
    assert.ok(update.inputSchema.properties.instrument_id, 'music_track_update cannot choose the sound');
});
