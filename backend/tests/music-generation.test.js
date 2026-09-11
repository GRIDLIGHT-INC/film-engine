const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

/**
 * FIVE WAYS TO MAKE MUSIC, ONE RULE FOR ALL OF THEM: A TAKE IS ADDED, NEVER
 * SWAPPED IN.
 *
 * MUS-012. Whole-cue composition, provider-native parts, reference (audio or
 * melody) conditioning, picture conditioning and selected-range inpainting,
 * over one score session. Set-based over the generating workflows the
 * capability registry declares (every workflow but separation, which is
 * MUS-011's), because a path that composes correctly and labels a native part
 * as a separated stem is exactly the partial failure an example cannot see.
 *
 * What each must hold:
 *   - the provider's own contract decides: an unsupported workflow is refused
 *     with the provider's reason, never attempted;
 *   - nothing is generated from an emotional arc nobody accepted — a proposal
 *     does not reach the request, and an unaccepted arc refuses unless the
 *     caller says to go without one;
 *   - the plan is free, writes nothing, and names the provider, the model, the
 *     length, the outputs and their kind, the cost and the take behaviour;
 *   - the request carries the session's tempo and key and the accepted arc;
 *   - every output is a NEW asset and a NEW clip — a candidate take beside
 *     what was there, which is left exactly as it was;
 *   - a native part is a native part and a separated stem is a separated stem;
 *   - a failure leaves a failed operation, no assets, no clips, no files.
 *
 * The provider is a fake with a full contract: every workflow but compose is
 * unsupported by every provider registered today, which is itself asserted.
 */

delete process.env.ELEVENLABS_API_KEY;
process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-gen-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const gen = require('../lib/music-generation');
const caps = require('../lib/music-capabilities');
const route = require('../routes/music-sessions');
const providers = require('../lib/providers');
const { readScoreSession } = require('../lib/music-session');
const { resolveFfmpeg } = require('../lib/ffmpeg');
const { DATA_DIR } = require('../lib/file-storage');
const { PRODUCTION_TOOLS } = require('../lib/mcp-tools');

const bin = () => resolveFfmpeg().bin;
const tmp = ext => path.join(os.tmpdir(), `gen_${generateId().slice(0, 8)}.${ext}`);

function toneBytes(hz, seconds) {
    const p = tmp('wav');
    execFileSync(bin(), ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${seconds}:sample_rate=44100`, '-ac', '2', '-c:a', 'pcm_s16le', p], { stdio: 'pipe', timeout: 120000 });
    const b = fs.readFileSync(p); fs.unlinkSync(p); return b;
}
function clipBytes() {
    const p = tmp('mp4');
    execFileSync(bin(), ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=24:duration=1', '-pix_fmt', 'yuv420p', p], { stdio: 'pipe', timeout: 120000 });
    const b = fs.readFileSync(p); fs.unlinkSync(p); return b;
}

// ── The fake provider ─────────────────────────────────────────────────────

const FULL = {
    music_compose: { status: 'available', models: ['m1'], limits: { min_ms: 3000, max_ms: 600000, models: ['m1'], section_min_ms: 3000, section_max_ms: 120000 }, source: 'test' },
    music_parts: { status: 'available', limits: { max_parts: 4, part_roles: ['strings', 'drums', 'bass', 'piano'] }, source: 'test' },
    music_separate: { status: 'unsupported', reason: 'this fake provider does not separate recordings' },
    music_reference: { status: 'available', limits: { reference_kinds: ['audio', 'melody'], max_reference_ms: 60000 }, source: 'test' },
    music_video: { status: 'available', limits: { max_video_ms: 600000, video_formats: ['mp4', 'mov'] }, source: 'test' },
    music_inpaint: { status: 'available', limits: { max_range_ms: 30000, context_ms: 5000 }, source: 'test' },
};
function fake(opts) {
    const o = opts || {};
    const calls = [];
    return {
        id: 'fakemusic', capabilities: ['music'], music: o.contract || FULL, calls,
        async generate(capability, payload) {
            const shallow = {};
            for (const [k, v] of Object.entries(payload)) shallow[k] = Buffer.isBuffer(v && v.bytes) ? { name: v.name, mime: v.mime, bytes: v.bytes.length } : v;
            calls.push({ capability, payload: shallow });
            if (o.fail) return { ok: false, status: 500, error: 'fakemusic 500: the composer is out' };
            if (o.garbage) {
                const junk = Buffer.from('not audio, just words pretending to be a cue');
                // Parts come back as parts, so the not-audio check is exercised per part too.
                if (payload.workflow === 'music_parts') return { ok: true, provider_model: 'm1', parts: payload.parts.map(p => ({ role: p, data: junk })) };
                return { ok: true, data: junk, provider_model: 'm1' };
            }
            if (payload.workflow === 'music_parts') {
                return { ok: true, provider_model: 'm1', parts: payload.parts.map((p, i) => ({ role: typeof p === 'string' ? p : p.role, data: toneBytes(220 + i * 110, 3) })) };
            }
            const seconds = payload.workflow === 'music_inpaint' ? (payload.range.end_ms - payload.range.start_ms) / 1000 : 3;
            return { ok: true, data: toneBytes(330, seconds), provider_model: 'm1', provider_job_id: 'job-' + calls.length };
        },
    };
}

// ── Fixtures ───────────────────────────────────────────────────────────────

function film(opts) {
    const o = opts || {};
    const projectId = generateId();
    db.prepare("INSERT INTO film_projects (id, title, provider_config) VALUES (?, 'Gen', ?)").run(projectId, JSON.stringify({ music: 'elevenlabs' }));
    const sceneId = generateId();
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, '1', 'X')").run(sceneId, projectId);
    const sessionId = generateId();
    db.prepare("INSERT INTO film_music_sessions (id, project_id, scene_id, name, tempo_map_json) VALUES (?, ?, ?, 'S', ?)")
        .run(sessionId, projectId, sceneId, JSON.stringify([{ at_ms: 0, bpm: 92, numerator: 4, denominator: 4 }]));
    if (o.arc !== false) {
        db.prepare("INSERT INTO film_music_emotion_ranges (id, session_id, start_ms, end_ms, label, valence, arousal, intensity, source, status) VALUES (?, ?, 0, 6000, 'dread', -0.6, 0.4, 0.5, 'director', 'accepted')").run(generateId(), sessionId);
        db.prepare("INSERT INTO film_music_emotion_ranges (id, session_id, start_ms, end_ms, label, valence, arousal, intensity, source, status) VALUES (?, ?, 6000, 12000, 'release', 0.5, 0.7, 0.8, 'director', 'accepted')").run(generateId(), sessionId);
    }
    // A proposal nobody accepted, with a label that must never reach a request.
    db.prepare("INSERT INTO film_music_emotion_ranges (id, session_id, start_ms, end_ms, label, valence, arousal, intensity, source, status) VALUES (?, ?, 0, 3000, 'UNREVIEWED-GUESS', 0, 0.1, 0.1, 'ai_proposal', 'proposed')").run(generateId(), sessionId);

    const dir = path.join(DATA_DIR, 'music', projectId); fs.mkdirSync(dir, { recursive: true });
    const cueBytes = toneBytes(440, 10);
    const cueFile = path.join(dir, `cue_${generateId().slice(0, 6)}.wav`); fs.writeFileSync(cueFile, cueBytes);
    const cueAsset = generateId();
    db.prepare("INSERT INTO film_assets (id, project_id, asset_type, file_path, file_name, format, mime_type, duration_ms, metadata) VALUES (?, ?, 'audio_music', ?, ?, 'wav', 'audio/wav', 10000, '{}')").run(cueAsset, projectId, cueFile, path.basename(cueFile));
    const trackId = generateId();
    db.prepare("INSERT INTO film_music_tracks (id, session_id, name, role) VALUES (?, ?, 'score', 'score')").run(trackId, sessionId);
    const clipId = generateId();
    db.prepare("INSERT INTO film_music_clips (id, track_id, asset_id, name, source_kind, start_ms, duration_ms, source_offset_ms, take_status) VALUES (?, ?, ?, 'first take', 'generated', 1000, 8000, 500, 'selected')").run(clipId, trackId, cueAsset);

    const videoFile = path.join(DATA_DIR, 'music', projectId, `pic_${generateId().slice(0, 6)}.mp4`); fs.writeFileSync(videoFile, clipBytes());
    const videoAsset = generateId();
    db.prepare("INSERT INTO film_assets (id, project_id, asset_type, file_path, file_name, format, mime_type, duration_ms, metadata) VALUES (?, ?, 'video_raw', ?, ?, 'mp4', 'video/mp4', 1000, '{}')").run(videoAsset, projectId, videoFile, path.basename(videoFile));
    return { projectId, sceneId, sessionId, trackId, clipId, cueAsset, cueFile, cueBytes, videoAsset };
}

/** A valid request for each workflow, against a fixture. */
const INPUT = {
    music_compose: f => ({ prompt: 'low strings under the argument, opening out', duration_ms: 12000, key: 'D minor' }),
    music_parts: f => ({ prompt: 'the same cue as separate parts', parts: ['strings', 'drums', 'bass'], duration_ms: 12000 }),
    music_reference: f => ({ prompt: 'in the manner of this', reference_asset_id: f.cueAsset, reference_kind: 'melody', duration_ms: 12000 }),
    music_video: f => ({ prompt: 'follow the cut', video_asset_id: f.videoAsset, duration_ms: 12000 }),
    music_inpaint: f => ({ clip_id: f.clipId, range: { start_ms: 2000, end_ms: 5000 }, prompt: 'make the rise land later' }),
};
const counts = pid => ({
    assets: db.prepare('SELECT COUNT(*) n FROM film_assets WHERE project_id = ?').get(pid).n,
    files: fs.readdirSync(path.join(DATA_DIR, 'music', pid)).length,
});

// ── The registry ───────────────────────────────────────────────────────────

test('the generating workflows are every registry workflow except separation, each with its output kind, and the input table covers them', () => {
    assert.deepStrictEqual(gen.GENERATE_WORKFLOWS.slice().sort(), Object.keys(caps.WORKFLOWS).filter(w => w !== 'music_separate').sort());
    for (const wf of gen.GENERATE_WORKFLOWS) {
        assert.ok(INPUT[wf], `${wf}: the test has no input for it`);
        assert.ok(caps.OUTPUT_KINDS[caps.WORKFLOWS[wf].output_kind], `${wf}: no output kind`);
    }
    assert.ok(caps.MUSIC_CALL_SITES.some(c => c.file === 'lib/music-generation.js'), 'the generation call site is not in the registry');
});

test('against every registered provider, each workflow is planned exactly when its own contract says available, and refused with its own reason otherwise', () => {
    const f = film();
    for (const adapter of providers.list().filter(a => caps.contractOf(a))) {
        db.prepare('UPDATE film_projects SET provider_config = ? WHERE id = ?').run(JSON.stringify({ music: adapter.id }), f.projectId);
        for (const wf of gen.GENERATE_WORKFLOWS) {
            const decl = adapter.music[wf];
            const plan = gen.planGeneration(db, f.sessionId, wf, INPUT[wf](f));
            if (decl.status === 'available') assert.strictEqual(plan.ok, true, `${adapter.id}/${wf}: ${plan.error}`);
            else {
                assert.strictEqual(plan.ok, false, `${adapter.id}/${wf} planned while ${decl.status}`);
                assert.strictEqual(plan.code, 'UNSUPPORTED');
                assert.ok(plan.error.includes(decl.reason), `${adapter.id}/${wf}: the refusal does not carry the provider's reason`);
            }
        }
    }
});

// ── The free plan ──────────────────────────────────────────────────────────

test('every workflow plans for free: provider, model, length, outputs and their kind, context, cost and take behaviour, and nothing written', () => {
    const f = film();
    const before = { ...counts(f.projectId), ops: db.prepare('SELECT COUNT(*) n FROM film_music_operations').get().n, clips: db.prepare('SELECT COUNT(*) n FROM film_music_clips').get().n };
    for (const wf of gen.GENERATE_WORKFLOWS) {
        const plan = gen.planGeneration(db, f.sessionId, wf, INPUT[wf](f), { adapter: fake() });
        assert.strictEqual(plan.ok, true, `${wf}: ${plan.error}`);
        assert.strictEqual(plan.free, true);
        assert.strictEqual(plan.provider.id, 'fakemusic');
        assert.ok(plan.duration_ms > 0, `${wf}: no length`);
        const kind = caps.WORKFLOWS[wf].output_kind;
        assert.strictEqual(plan.outputs.kind, kind);
        assert.strictEqual(plan.outputs.source_kind, caps.OUTPUT_KINDS[kind].source_kind);
        assert.strictEqual(plan.outputs.count, wf === 'music_parts' ? 3 : 1);
        assert.strictEqual(plan.context.tempo_bpm, 92, `${wf}: the session's tempo is not carried`);
        assert.deepStrictEqual(plan.context.emotion.map(r => r.label), ['dread', 'release'], `${wf}: the accepted arc is not the context`);
        assert.ok(!JSON.stringify(plan).includes('UNREVIEWED-GUESS'), `${wf}: a proposal reached the plan`);
        assert.match(plan.takes, /new take|candidate/i);
        assert.match(plan.takes, /never replace|not replaced|untouched|kept/i);
        assert.ok('cost_hint' in plan);
    }
    assert.deepStrictEqual({ ...counts(f.projectId), ops: db.prepare('SELECT COUNT(*) n FROM film_music_operations').get().n, clips: db.prepare('SELECT COUNT(*) n FROM film_music_clips').get().n }, before, 'planning wrote something');

    // Refusals name the field: a bad input per workflow.
    const bad = {
        music_compose: { prompt: 'x', duration_ms: 1000 },
        music_parts: { prompt: 'x', parts: ['strings', 'tuba'], duration_ms: 12000 },
        music_reference: { prompt: 'x', reference_asset_id: f.cueAsset, reference_kind: 'hum', duration_ms: 12000 },
        music_video: { prompt: 'x', video_asset_id: f.cueAsset, duration_ms: 12000 },
        music_inpaint: { clip_id: f.clipId, range: { start_ms: 6000, end_ms: 9500 }, prompt: 'x' },
    };
    const field = { music_compose: /duration_ms/, music_parts: /tuba/, music_reference: /reference_kind/, music_video: /not a picture|video/i, music_inpaint: /range|inside|clip/i };
    for (const wf of gen.GENERATE_WORKFLOWS) {
        const r = gen.planGeneration(db, f.sessionId, wf, bad[wf], { adapter: fake() });
        assert.strictEqual(r.ok, false, `${wf}: a bad input planned`);
        assert.match(r.error, field[wf], `${wf}: the refusal does not name what was wrong: ${r.error}`);
    }
    assert.strictEqual(gen.planGeneration(db, f.sessionId, 'music_separate', {}, { adapter: fake() }).ok, false, 'separation is planned here instead of by its own module');
});

test('nothing is generated from an arc nobody accepted: every workflow refuses EMOTION_NOT_ACCEPTED, and going without the arc is said, not assumed', () => {
    const f = film({ arc: false });
    for (const wf of gen.GENERATE_WORKFLOWS) {
        const r = gen.planGeneration(db, f.sessionId, wf, INPUT[wf](f), { adapter: fake() });
        assert.strictEqual(r.ok, false, `${wf}: planned against an unaccepted arc`);
        assert.strictEqual(r.code, 'EMOTION_NOT_ACCEPTED');
        assert.match(r.error, /proposed|accept/i);
        const without = gen.planGeneration(db, f.sessionId, wf, { ...INPUT[wf](f), ignore_emotion: true }, { adapter: fake() });
        assert.strictEqual(without.ok, true, `${wf}: ${without.error}`);
        assert.deepStrictEqual(without.context.emotion, []);
        assert.match(without.warnings.join(' '), /without.*arc|no accepted/i);
    }
});

// ── Generating ─────────────────────────────────────────────────────────────

test('every workflow generates NEW assets and clips as candidate takes, with the session context in the request, and leaves what was there untouched', async () => {
    for (const wf of gen.GENERATE_WORKFLOWS) {
        const f = film();
        const adapter = fake();
        const sourceClip = db.prepare('SELECT * FROM film_music_clips WHERE id = ?').get(f.clipId);
        const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(f.cueFile)).digest('hex');
        const out = await gen.generate(db, f.sessionId, wf, INPUT[wf](f), { adapter });
        assert.strictEqual(out.ok, true, `${wf}: ${out.error}`);

        // The request carried the session's context and only the accepted arc.
        assert.strictEqual(adapter.calls.length, 1);
        const sent = adapter.calls[0].payload;
        assert.strictEqual(sent.workflow, wf);
        assert.strictEqual(sent.tempo_bpm, 92, `${wf}: tempo not sent`);
        assert.ok(!JSON.stringify(sent).includes('UNREVIEWED-GUESS'), `${wf}: a proposal reached the provider`);
        assert.match(JSON.stringify(sent), /dread/, `${wf}: the accepted arc did not reach the provider`);
        if (wf === 'music_compose') {
            assert.strictEqual(sent.key, 'D minor');
            const plan = sent.composition_plan;
            assert.ok(plan && plan.sections.length === 2, 'the accepted arc did not become the sections');
            assert.strictEqual(plan.sections.reduce((s, x) => s + x.duration_ms, 0), 12000, 'the sections do not cover the length');
        }
        if (wf === 'music_reference') { assert.strictEqual(sent.reference_kind, 'melody'); assert.ok(sent.reference && sent.reference.bytes > 0, 'the reference was not sent'); }
        if (wf === 'music_video') assert.ok(sent.video && sent.video.bytes > 0, 'the picture was not sent');
        if (wf === 'music_inpaint') { assert.ok(sent.source && sent.source.bytes > 0, 'the cue being inpainted was not sent'); assert.deepStrictEqual(sent.range, { start_ms: 2500, end_ms: 5500 }, 'the range was not translated into the source file'); assert.ok(sent.context_ms === 5000); }

        // New assets, new clips, candidate takes, labelled by kind.
        const kind = caps.WORKFLOWS[wf].output_kind;
        const model = readScoreSession(db, f.sessionId);
        const all = model.tracks.flatMap(t => t.clips.map(c => ({ ...c, track: t })));
        assert.strictEqual(out.outputs.length, wf === 'music_parts' ? 3 : 1);
        for (const o of out.outputs) {
            const clip = all.find(c => c.id === o.clip_id);
            assert.ok(clip, `${wf}: no clip`);
            assert.notStrictEqual(clip.asset_id, f.cueAsset, `${wf}: a clip was pointed at an existing file`);
            assert.strictEqual(clip.source_kind, caps.OUTPUT_KINDS[kind].source_kind, `${wf}: labelled ${clip.source_kind}`);
            assert.strictEqual(clip.source_operation_id, out.operation_id);
            const asset = db.prepare('SELECT * FROM film_assets WHERE id = ?').get(o.asset_id);
            assert.ok(asset && fs.existsSync(asset.file_path), `${wf}: no file`);
            const meta = JSON.parse(asset.metadata);
            assert.strictEqual(meta.kind, kind);
            assert.notStrictEqual(meta.kind, 'separated_stem');
            assert.strictEqual(meta.operation_id, out.operation_id);
            assert.strictEqual(meta.workflow, wf);
            assert.ok(meta.context && meta.context.tempo_bpm === 92);
            if (wf === 'music_inpaint') {
                assert.strictEqual(clip.track.id, f.trackId, 'the inpainted range is not on the source track');
                assert.deepStrictEqual([clip.start_ms, clip.duration_ms, clip.take_status], [3000, 3000, 'candidate'], 'the inpainted range is not placed over the range it replaces');
                assert.strictEqual(meta.derived_from, f.cueAsset);
                assert.ok(clip.take_group && clip.take_group === all.find(c => c.id === f.clipId).take_group, 'the inpainted take is not grouped with the take it is an alternative to');
            }
        }
        if (wf === 'music_parts') {
            const starts = new Set(out.outputs.map(o => all.find(c => c.id === o.clip_id).start_ms));
            assert.strictEqual(starts.size, 1, 'native parts do not share one start');
            assert.deepStrictEqual(out.outputs.map(o => all.find(c => c.id === o.clip_id).track.role).sort(), ['bass', 'drums', 'strings']);
        }
        // What was there is exactly as it was.
        const after = db.prepare('SELECT * FROM film_music_clips WHERE id = ?').get(f.clipId);
        assert.deepStrictEqual([after.asset_id, after.start_ms, after.duration_ms, after.source_offset_ms, after.take_status], [sourceClip.asset_id, sourceClip.start_ms, sourceClip.duration_ms, sourceClip.source_offset_ms, 'selected']);
        assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(f.cueFile)).digest('hex'), sourceHash);
        const op = db.prepare('SELECT * FROM film_music_operations WHERE id = ?').get(out.operation_id);
        assert.deepStrictEqual([op.kind, op.status, op.provider], ['generate', 'complete', 'fakemusic']);
        assert.strictEqual(JSON.parse(op.params_json).workflow, wf);
    }
});

test('generating twice is two takes: the second never replaces the first, and both stay on disk', async () => {
    const f = film();
    const a = await gen.generate(db, f.sessionId, 'music_compose', { ...INPUT.music_compose(f), track_id: f.trackId }, { adapter: fake() });
    const b = await gen.generate(db, f.sessionId, 'music_compose', { ...INPUT.music_compose(f), track_id: f.trackId }, { adapter: fake() });
    assert.ok(a.ok && b.ok);
    assert.notStrictEqual(a.outputs[0].asset_id, b.outputs[0].asset_id);
    for (const o of [...a.outputs, ...b.outputs]) {
        const asset = db.prepare('SELECT file_path FROM film_assets WHERE id = ?').get(o.asset_id);
        assert.ok(fs.existsSync(asset.file_path));
        assert.strictEqual(db.prepare('SELECT take_status FROM film_music_clips WHERE id = ?').get(o.clip_id).take_status, 'candidate');
    }
    // On an existing track the takes share a group with what the track already held.
    const groups = new Set(db.prepare('SELECT take_group FROM film_music_clips WHERE track_id = ?').all(f.trackId).map(r => r.take_group));
    assert.strictEqual(groups.size, 1, 'the takes on one track are not one group');
    assert.strictEqual(gen.listGenerations(db, f.sessionId).length, 2);
});

test('a provider failure or bytes that are not audio leave a failed operation, no assets, no clips and no files', async () => {
    for (const opts of [{ fail: true }, { garbage: true }]) {
        for (const wf of gen.GENERATE_WORKFLOWS) {
            const f = film();
            const before = { ...counts(f.projectId), clips: db.prepare('SELECT COUNT(*) n FROM film_music_clips c JOIN film_music_tracks t ON t.id = c.track_id WHERE t.session_id = ?').get(f.sessionId).n };
            const out = await gen.generate(db, f.sessionId, wf, INPUT[wf](f), { adapter: fake(opts) });
            assert.strictEqual(out.ok, false, `${wf}: ${JSON.stringify(opts)} succeeded`);
            assert.match(out.error, opts.fail ? /composer is out/ : /not audio/i);
            const op = db.prepare('SELECT * FROM film_music_operations WHERE id = ?').get(out.operation_id);
            assert.ok(op && op.status === 'failed' && op.error_message, `${wf}: no failed operation`);
            assert.deepStrictEqual({ ...counts(f.projectId), clips: db.prepare('SELECT COUNT(*) n FROM film_music_clips c JOIN film_music_tracks t ON t.id = c.track_id WHERE t.session_id = ?').get(f.sessionId).n }, before, `${wf}: something was left behind`);
        }
    }
});

// ── Served, and reachable ──────────────────────────────────────────────────

function call(method, url, body) {
    return new Promise((resolve, reject) => {
        const res = { statusCode: 200, writeHead(c) { this.statusCode = c; return this; }, end(p) { resolve({ status: this.statusCode, body: JSON.parse(p || '{}') }); } };
        const query = Object.fromEntries(new URLSearchParams(url.split('?')[1] || ''));
        Promise.resolve(route.handleMusicSessions({ method, url, body: body || {} }, res, url.split('?')[0].split('/').filter(Boolean), query)).catch(reject);
    });
}

test('plan, generate and the list are served, and the tools say what spends and what is free', async () => {
    const f = film();
    const plan = await call('POST', `/film/music-sessions/${f.sessionId}/generate/plan`, { workflow: 'music_compose', ...INPUT.music_compose(f) });
    assert.strictEqual(plan.status, 200, JSON.stringify(plan.body).slice(0, 300));
    assert.strictEqual(plan.body.provider.id, 'elevenlabs');
    const refused = await call('POST', `/film/music-sessions/${f.sessionId}/generate/plan`, { workflow: 'music_inpaint', ...INPUT.music_inpaint(f) });
    assert.strictEqual(refused.status, 409); assert.strictEqual(refused.body.code, 'UNSUPPORTED');
    assert.strictEqual((await call('POST', `/film/music-sessions/${f.sessionId}/generate/plan`, { workflow: 'music_banjo' })).status, 400);
    // No key in this database: the refusal is the provider's, and nothing is registered.
    const run = await call('POST', `/film/music-sessions/${f.sessionId}/generate`, { workflow: 'music_compose', ...INPUT.music_compose(f) });
    assert.ok([401, 402, 409, 502].includes(run.status), `generate answered ${run.status}`);
    assert.match(JSON.stringify(run.body), /key|elevenlabs/i);
    const list = await call('GET', `/film/music-sessions/${f.sessionId}/generations`);
    assert.strictEqual(list.status, 200);
    assert.ok(Array.isArray(list.body.generations));

    const byName = n => PRODUCTION_TOOLS.find(t => t.name === n);
    const planTool = byName('music_generate_plan'), genTool = byName('music_generate'), listTool = byName('music_generation_list');
    assert.ok(planTool && genTool && listTool, 'a generation tool is missing');
    assert.match(planTool.description, /free|spends nothing/i);
    assert.match(genTool.description, /costs money|spends/i);
    assert.match(genTool.description, /take/i);
    assert.deepStrictEqual(genTool.schema.workflow.enum.slice().sort(), gen.GENERATE_WORKFLOWS.slice().sort());
    assert.deepStrictEqual(planTool.schema.workflow.enum.slice().sort(), gen.GENERATE_WORKFLOWS.slice().sort());
    assert.strictEqual(listTool.method, 'GET');
});
