const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

/**
 * SCREENPLAY TO FINAL MOVIE, SCORED, WITH NO DAW AND THROUGH ABLETON.
 *
 * MUS-024. The 30-second fixture (fixtures/thirty-second.fountain, extended by
 * fixtures/thirty-second.score.json) is taken the whole way, and ONLY through
 * the MCP tools an agent host calls — the path this engine's reasoning takes:
 *
 *   screenplay written → shots cut from it → a picture sequence over them →
 *   footage on every shot → a score session over the sequence, whose brief
 *   names the screenplay version and passage → an emotional arc proposed and
 *   explicitly accepted → one generated cue and two uploaded stems → a
 *   rendered, measured bounce → an approval → the conformed final movie.
 *
 * Twice. Path A never touches a DAW: a project with no Ableton installation
 * finishes the film. Path B takes the same project through Ableton — a fake
 * Live speaking AbletonOSC over real UDP, behind the real sidecar, reached
 * through the registry's own configuration — plans and pushes, asks what can
 * be pulled (AbletonOSC exports nothing, and the plan says so), brings the
 * Live mix back as a stem import, and conforms again. Both masters are
 * MEASURED: the film is 30 seconds and the score is in it, and path B's master
 * carries the tone that came back from Live while path A's does not.
 *
 * Then the failure and recovery the operator meets — a provider that fails
 * once, reported by the health report and retried to a new take — and the
 * bundle round trip, where the scored project is carried to a clean project
 * and its approval, fingerprints and consumers survive.
 *
 * Nothing here spends: the music provider is a registered fake with a full
 * contract, and the render is local ffmpeg.
 */

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-e2e-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const providers = require('../lib/providers');
const mcp = require('../lib/mcp-tools');
const { resolveFfmpeg } = require('../lib/ffmpeg');
const { findProjectMaster } = require('../lib/conform');
const ableton = require('../lib/ableton-osc');
const { createFakeLive } = require('../lib/daw/fake-live');
const { createSidecar } = require('../ableton-sidecar');
const dawRegistry = require('../lib/daw-registry');
const bundle = require('../lib/project-bundle');

const FIXTURES = path.join(__dirname, 'fixtures');
const SCORE = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'thirty-second.score.json'), 'utf8'));
const SCREENPLAY = fs.readFileSync(path.join(FIXTURES, SCORE.screenplay), 'utf8');

const bin = () => resolveFfmpeg().bin;
const sh = args => execFileSync(bin(), ['-y', '-loglevel', 'error', ...args], { stdio: 'pipe', timeout: 180000 });
let TMP;
test.before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-e2e-')); });

function toneWav(hz, ms) {
    const p = path.join(TMP, `t_${hz}_${generateId().slice(0, 6)}.wav`);
    sh(['-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${ms / 1000}:sample_rate=48000`, '-ac', '2', '-c:a', 'pcm_s24le', p]);
    const b = fs.readFileSync(p); fs.unlinkSync(p); return b;
}
function clipMp4(ms, color) {
    const p = path.join(TMP, `c_${generateId().slice(0, 6)}.mp4`);
    sh(['-f', 'lavfi', '-i', `color=c=${color}:s=160x120:d=${ms / 1000}`, '-c:v', 'libx264', '-r', '24', '-pix_fmt', 'yuv420p', p]);
    const b = fs.readFileSync(p); fs.unlinkSync(p); return b;
}
const dataUri = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`;
function probeSeconds(file) {
    const r = spawnSync(bin(), ['-i', file], { encoding: 'utf8' });
    const m = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(String(r.stderr || ''));
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}
/** Mean level of one frequency band over a span: is that tone in the mix. */
function bandDb(file, hz, fromS, durS) {
    const r = spawnSync(bin(), ['-ss', String(fromS), '-t', String(durS), '-i', file, '-af', `bandpass=f=${hz}:width_type=h:w=30,volumedetect`, '-f', 'null', '-'], { encoding: 'utf8', timeout: 180000 });
    const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(String(r.stderr || ''));
    return m ? Number(m[1]) : null;
}

/** Call an MCP tool the way an agent host does, and fail with the refusal when it refuses. */
async function tool(name, args, opts) {
    assert.ok(mcp.hasTool(name), `there is no ${name} tool`);
    const raw = await mcp.callTool(name, args || {});
    const out = mcp.presentResult(raw);
    if (!(opts && opts.allowFailure)) assert.ok(!mcp.isFailure(raw), `${name} refused: ${JSON.stringify(out).slice(0, 600)}`);
    return out;
}

// ── The fake music provider: a full contract, and it can fail once on demand ──

const GENERATED_HZ = 330;
const composer = {
    id: 'e2e_composer', kind: 'generator', capabilities: ['music'], supports: c => c === 'music',
    music: {
        music_compose: { status: 'available', models: ['e2e-1'], limits: { min_ms: 1000, max_ms: 600000, models: ['e2e-1'], section_min_ms: 3000, section_max_ms: 120000 }, source: 'the e2e fixture' },
        music_parts: { status: 'unsupported', reason: 'the e2e composer makes one mixed cue and no native parts' },
        music_separate: { status: 'unsupported', reason: 'the e2e composer does not separate recordings' },
        music_reference: { status: 'unsupported', reason: 'the e2e composer takes no reference audio' },
        music_video: { status: 'unsupported', reason: 'the e2e composer takes no picture' },
        music_inpaint: { status: 'unsupported', reason: 'the e2e composer regenerates whole cues only' },
    },
    failNext: 0, calls: 0,
    async generate(cap, payload) {
        this.calls++;
        if (this.failNext > 0) { this.failNext--; return { ok: false, error: 'e2e composer 503: temporarily unavailable', status: 503 }; }
        const ms = Number(payload.duration_ms || payload.music_length_ms || SCORE.generate.duration_ms);
        return { ok: true, data: toneWav(GENERATED_HZ, ms), mimeType: 'audio/wav', provider_model: 'e2e-1', provider_job_id: 'e2e-' + this.calls };
    },
};
providers.register(composer);

// ── Path A: the whole film, no DAW ─────────────────────────────────────────

const RUN = {};

async function screenplayToPicture() {
    const created = await tool('project_create', { title: 'Last Call (scored)', aspect_ratio: '16:9' });
    const projectId = (created.project || created).id;
    assert.ok(projectId, 'project_create returned no id');
    await tool('project_update', { project_id: projectId, provider_config: { music: composer.id } });

    await tool('script_write', { project_id: projectId, fountain_content: SCREENPLAY });
    const scenes = (await tool('scene_list', { project_id: projectId })).scenes;
    assert.strictEqual(scenes.length, 1, `the screenplay has one scene and scene_list returned ${scenes.length}`);
    const sceneId = scenes[0].id;

    const cards = SCORE.shots.map(({ duration_ms, ...card }) => ({ ...card, duration_ms }));
    await tool('shot_create', { scene_id: sceneId, cards });
    const shots = (await tool('shot_list', { project_id: projectId })).shots
        || (await tool('shot_list', { project_id: projectId }));
    const byCode = Object.fromEntries((Array.isArray(shots) ? shots : shots.shots).map(s => [s.shot_code, s.id]));
    for (const s of SCORE.shots) assert.ok(byCode[s.shot_code], `shot ${s.shot_code} was not created`);

    for (const [i, s] of SCORE.shots.entries()) {
        await tool('media_upload', { capability: 'video', owner_id: byCode[s.shot_code], file: dataUri('video/mp4', clipMp4(s.duration_ms, ['navy', 'maroon', 'darkgreen'][i])) });
    }
    const seq = await tool('sequence_create', { project_id: projectId, shot_ids: SCORE.shots.map(s => byCode[s.shot_code]), name: 'The diner' });
    const sequenceId = (seq.sequence || seq).id;
    assert.ok(sequenceId, 'sequence_create returned no id');
    return { projectId, sceneId, byCode, sequenceId };
}

test('path A — screenplay → shots → picture sequence → score → approved bounce → final movie, all through MCP, no DAW', async () => {
    const film = await screenplayToPicture();
    Object.assign(RUN, film);

    // The session is written against the picture, and its brief names the exact screenplay it came from.
    const made = await tool('music_session_create', { project_id: film.projectId, sequence_id: film.sequenceId, name: 'Last Call score' });
    const sessionId = (made.session || made).id;
    assert.ok(sessionId, 'music_session_create returned no id');
    RUN.sessionId = sessionId;
    const brief = await tool('music_session_brief', { session_id: sessionId });
    const text = JSON.stringify(brief);
    const sp = (brief.brief || brief).screenplay;
    const script = db.prepare('SELECT id, version FROM film_scripts WHERE project_id = ? ORDER BY version DESC LIMIT 1').get(film.projectId);
    assert.ok(sp && sp.script_id === script.id && sp.version === script.version, `the brief does not name the exact screenplay version: ${JSON.stringify(sp).slice(0, 200)}`);
    assert.ok(sp.passages.some(p => String(p.text).includes(SCORE.passage_marker)), 'the brief does not carry the screenplay passage the session scores');
    for (const s of SCORE.shots) assert.ok(text.includes(s.shot_code), `the brief does not name shot ${s.shot_code}`);

    // Nothing is generated from an arc nobody accepted.
    const early = await tool('music_generate_plan', { session_id: sessionId, ...SCORE.generate }, { allowFailure: true });
    assert.strictEqual(early.code, 'EMOTION_NOT_ACCEPTED', `generation planned with no accepted arc: ${JSON.stringify(early).slice(0, 300)}`);

    // The agent proposes the arc; a person accepts it, range by range.
    const proposed = await tool('music_emotion_propose', { session_id: sessionId, ranges: SCORE.arc, model: 'the connected agent' });
    const proposalId = proposed.proposal_id || (proposed.proposal && proposed.proposal.id);
    assert.ok(proposalId, `no proposal id: ${JSON.stringify(proposed).slice(0, 300)}`);
    await tool('music_emotion_accept', { session_id: sessionId, proposal_id: proposalId });

    // A generated cue — the plan first, free, then the take.
    const plan = await tool('music_generate_plan', { session_id: sessionId, ...SCORE.generate });
    assert.strictEqual((plan.provider || {}).id, composer.id, 'the plan does not name the project\'s provider');
    const callsBefore = composer.calls;
    await tool('music_generate', { session_id: sessionId, ...SCORE.generate });
    assert.strictEqual(composer.calls, callsBefore + 1, 'the generation did not reach the provider exactly once');

    // Two uploaded stems, aligned, with the composer's rights declared.
    await tool('music_stem_import', { session_id: sessionId, start_ms: 0,
        files: SCORE.stems.map(s => ({ name: s.name, role: s.role, data: dataUri('audio/wav', toneWav(s.hz, 30000)) })),
        rights: SCORE.stems[0].rights });

    // Render it, approve it, and conform the film.
    const bounced = await tool('music_bounce', { session_id: sessionId });
    assert.ok(bounced.master || bounced.operation_id, `the bounce returned nothing: ${JSON.stringify(bounced).slice(0, 300)}`);
    await tool('music_session_update', { session_id: sessionId, status: 'arranging' });
    await tool('music_session_update', { session_id: sessionId, status: 'review' });
    const approved = await tool('music_session_approve', { session_id: sessionId });
    assert.ok(approved.ok !== false, JSON.stringify(approved).slice(0, 300));

    const report = await tool('music_score_report', { project_id: film.projectId });
    const consumed = report.consumed || report.scores || [];
    assert.ok(JSON.stringify(consumed).includes(sessionId), `the approved session is not consumed by the film: ${JSON.stringify(report).slice(0, 400)}`);

    const conformed = await tool('conform_run', { project_id: film.projectId });
    void conformed;
    const master = findProjectMaster(db, film.projectId);
    assert.ok(master && fs.existsSync(master.file_path), 'there is no final movie on disk');
    const secs = probeSeconds(master.file_path);
    assert.ok(Math.abs(secs - 30) < 0.5, `the final movie runs ${secs}s, not the 30 the picture does`);
    const scoreLevel = bandDb(master.file_path, GENERATED_HZ, 2, 20);
    assert.ok(scoreLevel !== null && scoreLevel > -45, `the generated cue is not in the final movie (${scoreLevel} dB at ${GENERATED_HZ} Hz)`);
    const stemLevel = bandDb(master.file_path, SCORE.stems[0].hz, 2, 20);
    assert.ok(stemLevel !== null && stemLevel > -45, `the uploaded stem is not in the final movie (${stemLevel} dB)`);
    RUN.masterA = path.join(TMP, 'master_a.mp4');
    fs.copyFileSync(master.file_path, RUN.masterA);
    RUN.liveBandA = bandDb(RUN.masterA, SCORE.live_return.hz, 2, 20);
});

// ── Path B: the same project through Ableton ───────────────────────────────

async function liveRig() {
    const client = ableton.createAbletonClient({ host: '127.0.0.1', sendPort: 0, recvPort: 0, timeoutMs: 600, heartbeatMs: 200 });
    await client.bind();
    const live = createFakeLive({ version: [12, 4], replyPort: client.recvPort, faults: {} });
    await live.start();
    client.setSendPort(live.port);
    await client.start();
    const sidecar = await createSidecar({ client, token: 'e2e-' + crypto.randomBytes(16).toString('hex'), port: 0 });
    return { live, sidecar, close: async () => { await sidecar.close(); await client.stop(); await live.stop(); } };
}

test('path B — the same film through Ableton: plan, push, ask what can be pulled, bring the Live mix back, re-approve, conform', async () => {
    assert.ok(RUN.sessionId, 'path A did not leave a scored project');
    const r = await liveRig();
    const saved = { url: process.env.ABLETON_SIDECAR_URL, token: process.env.ABLETON_SIDECAR_TOKEN };
    process.env.ABLETON_SIDECAR_URL = r.sidecar.url;
    process.env.ABLETON_SIDECAR_TOKEN = r.sidecar.token;
    try {
        r.live.setTracks(['Their reverb bus']);
        const status = await tool('ableton_status', {});
        assert.ok(status.connected && status.compatible, `Live is not connected and compatible through the registry: ${JSON.stringify(status).slice(0, 300)}`);

        await tool('music_session_unapprove', { session_id: RUN.sessionId });
        const plan = await tool('ableton_score_push_plan', { session_id: RUN.sessionId });
        assert.ok(plan.plan_fingerprint, 'the push plan has no fingerprint');
        assert.ok((plan.untouched || []).some(t => t.name === 'Their reverb bus'), 'the plan does not leave somebody else\'s track alone');
        const pushed = await tool('ableton_score_push', { session_id: RUN.sessionId, plan_fingerprint: plan.plan_fingerprint });
        assert.ok(pushed.ok !== false, JSON.stringify(pushed).slice(0, 300));
        const names = r.live.state().tracks.map(t => t.name);
        assert.strictEqual(names[0], 'Their reverb bus', 'the push changed a track Film Engine does not own');
        const tracks = db.prepare('SELECT COUNT(*) AS n FROM film_music_tracks WHERE session_id = ?').get(RUN.sessionId).n;
        assert.strictEqual(names.filter(n => /⟨fe:/.test(n)).length, tracks, 'Live does not hold one marked track per Film Engine track');

        // AbletonOSC exports no render: the pull plan says so instead of pretending.
        const pullPlan = await tool('ableton_mix_pull_plan', { session_id: RUN.sessionId });
        assert.deepStrictEqual(pullPlan.items || [], [], 'a pull plan offered a render AbletonOSC cannot export');
        assert.match(JSON.stringify(pullPlan), /cannot export|package|stem/i, 'the pull plan does not say how a Live render comes back');

        // The composer bounces the strings in Live; the render comes back as a stem, and replaces the generated cue in the mix.
        await tool('music_stem_import', { session_id: RUN.sessionId, start_ms: 0,
            files: [{ name: SCORE.live_return.name, role: SCORE.live_return.role, data: dataUri('audio/wav', toneWav(SCORE.live_return.hz, 30000)) }],
            rights: { origin: 'original', status: 'cleared', owner: 'the composer (Live render)' } });
        const cueTrack = db.prepare(`SELECT t.id FROM film_music_tracks t JOIN film_music_clips c ON c.track_id = t.id
                                     WHERE t.session_id = ? AND c.source_kind = 'generated' LIMIT 1`).get(RUN.sessionId);
        assert.ok(cueTrack, 'the generated cue has no track');
        await tool('music_track_update', { session_id: RUN.sessionId, track_id: cueTrack.id, muted: true });

        const audit = await tool('music_daw_audit', { session_id: RUN.sessionId });
        assert.ok(JSON.stringify(audit).includes('push'), 'the push left no audit record');

        await tool('music_bounce', { session_id: RUN.sessionId });
        await tool('music_session_approve', { session_id: RUN.sessionId });
        await tool('conform_run', { project_id: RUN.projectId });
        const master = findProjectMaster(db, RUN.projectId);
        const secs = probeSeconds(master.file_path);
        assert.ok(Math.abs(secs - 30) < 0.5, `the Ableton-path movie runs ${secs}s`);
        const liveB = bandDb(master.file_path, SCORE.live_return.hz, 2, 20);
        assert.ok(liveB !== null && liveB > -45, `the Live render is not in the final movie (${liveB} dB)`);
        assert.ok(RUN.liveBandA === null || liveB > RUN.liveBandA + 15, `the Live render is no louder in path B (${liveB} dB) than in path A (${RUN.liveBandA} dB)`);
        const cueB = bandDb(master.file_path, GENERATED_HZ, 2, 20);
        const cueA = bandDb(RUN.masterA, GENERATED_HZ, 2, 20);
        assert.ok(cueB < cueA - 15, `the muted generated cue still plays in path B (${cueB} dB vs ${cueA} dB)`);
    } finally {
        if (saved.url === undefined) delete process.env.ABLETON_SIDECAR_URL; else process.env.ABLETON_SIDECAR_URL = saved.url;
        if (saved.token === undefined) delete process.env.ABLETON_SIDECAR_TOKEN; else process.env.ABLETON_SIDECAR_TOKEN = saved.token;
        await r.close();
    }
});

// ── Failure and recovery ───────────────────────────────────────────────────

test('a provider that fails is a failed job the health report names once, and a retry lands a candidate take without touching the approved mix', async () => {
    assert.ok(RUN.sessionId);
    const approvedBefore = db.prepare('SELECT status, approved_mix_asset_id FROM film_music_sessions WHERE id = ?').get(RUN.sessionId);
    assert.strictEqual(approvedBefore.status, 'approved', 'path B did not leave the session approved');
    const cueTrack = db.prepare(`SELECT t.id FROM film_music_tracks t JOIN film_music_clips c ON c.track_id = t.id
                                 WHERE t.session_id = ? AND c.source_kind = 'generated' LIMIT 1`).get(RUN.sessionId).id;
    const takes = () => db.prepare('SELECT id, take_status FROM film_music_clips WHERE track_id = ? ORDER BY created_at, rowid').all(cueTrack);
    const before = takes();

    composer.failNext = 1;
    const failed = await tool('music_generate', { session_id: RUN.sessionId, ...SCORE.generate, track_id: cueTrack }, { allowFailure: true });
    assert.ok(failed.ok === false && failed.status === 'failed' && failed.http_status >= 500, `a provider failure was reported as success: ${JSON.stringify(failed).slice(0, 300)}`);
    assert.deepStrictEqual(takes(), before, 'a failed generation registered a take');
    const bad = (await tool('music_job_list', { session_id: RUN.sessionId })).jobs.find(j => j.status === 'failed');
    assert.ok(bad, 'the failure left no failed job');

    const health = await tool('music_health', { session_id: RUN.sessionId });
    assert.strictEqual(health.areas.generation.recent_failures.length, 1, 'one failed generation is reported as more than one failure');
    const named = health.areas.generation.recent_failures[0];
    assert.ok(named.id === bad.operation_id && /503/.test(named.error) && named.recovery, `the health report does not name the failed job with its recovery: ${JSON.stringify(named).slice(0, 500)}`);

    const retried = await tool('music_job_retry', { session_id: RUN.sessionId, operation_id: bad.operation_id });
    assert.ok(retried.ok !== false, JSON.stringify(retried).slice(0, 300));
    const after = takes();
    assert.strictEqual(after.length, before.length + 1, 'the retry did not land exactly one new take');
    assert.strictEqual(after[after.length - 1].take_status, 'candidate', 'a retried take replaced what was being heard instead of arriving as a candidate');
    for (const t of before) assert.strictEqual(after.find(x => x.id === t.id).take_status, t.take_status, 'a retry changed an existing take');

    const now = db.prepare('SELECT status, approved_mix_asset_id FROM film_music_sessions WHERE id = ?').get(RUN.sessionId);
    assert.deepStrictEqual(now, approvedBefore, 'a candidate take nobody selected changed the approval');
    const report = await tool('music_score_report', { project_id: RUN.projectId });
    assert.ok((report.scores || []).some(x => x.session_id === RUN.sessionId), 'the film stopped consuming the approved score after a candidate arrived');
});

// ── The bundle round trip ──────────────────────────────────────────────────

test('the scored project travels whole: exported, imported as a clean project, its score still approved, consumed, and unchanged', async () => {
    assert.ok(RUN.projectId);
    const { archivePath } = bundle.exportProject(RUN.projectId);
    const out = bundle.importProject(fs.readFileSync(archivePath));
    const newId = out.projectId || out.project_id || (out.project && out.project.id);
    assert.ok(newId && newId !== RUN.projectId, `the import did not make a new project: ${JSON.stringify(out).slice(0, 300)}`);

    const report = await tool('music_score_report', { project_id: newId });
    const consumed = report.consumed || report.scores || [];
    assert.strictEqual(consumed.length, 1, `the imported film consumes ${consumed.length} scores: ${JSON.stringify(report).slice(0, 400)}`);
    const newSession = db.prepare('SELECT id, status FROM film_music_sessions WHERE project_id = ?').get(newId);
    assert.strictEqual(newSession.status, 'approved');
    const again = await tool('music_bounce', { session_id: newSession.id }, { allowFailure: true });
    assert.strictEqual(again.code, 'UNCHANGED', `the imported session no longer matches its own bounce: ${JSON.stringify(again).slice(0, 300)}`);
    const kinds = id => new Set(db.prepare("SELECT json_extract(metadata, '$.kind') AS k FROM film_assets WHERE project_id = ? AND json_valid(metadata)").all(id).map(r => r.k).filter(Boolean));
    const before = kinds(RUN.projectId), after = kinds(newId);
    for (const k of before) assert.ok(after.has(k), `the bundle lost every asset of kind ${k}`);
});

// ── A real Live, opt in ────────────────────────────────────────────────────

/*
 * Against a real Ableton Live 12.4 running AbletonOSC behind a sidecar you
 * started (docs/ableton-sidecar.md). Off unless FILM_LIVE_SMOKE=1, because
 * Live is licensed GUI software and no CI machine has it; the fake-Live
 * contract above is the mandatory suite either way. It adds marked tracks to
 * the open set and deletes nothing — there is no delete operation — so run it
 * against a scratch set.
 */
test('real Live smoke (opt in: FILM_LIVE_SMOKE=1 with ABLETON_SIDECAR_URL and ABLETON_SIDECAR_TOKEN)', async t => {
    if (process.env.FILM_LIVE_SMOKE !== '1') return t.skip('FILM_LIVE_SMOKE is not 1 — no real Live was asked for; the fake-Live path above ran instead');
    const got = dawRegistry.adapterFor('ableton');
    assert.ok(got.ok, got.error);
    const status = await tool('ableton_status', {});
    assert.ok(status.connected, `Live is not connected: ${JSON.stringify(status)}`);
    assert.ok(status.compatible, `Live answered but is not the reviewed version: ${JSON.stringify(status)}`);
    const read = await tool('ableton_session_read', {});
    assert.ok(Array.isArray(read.tracks), 'the Live set could not be read');
    assert.ok(RUN.sessionId, 'the fixture session is needed for the smoke push');
    const plan = await tool('ableton_score_push_plan', { session_id: RUN.sessionId });
    const pushed = await tool('ableton_score_push', { session_id: RUN.sessionId, plan_fingerprint: plan.plan_fingerprint, idempotency_key: 'live-smoke-' + Date.now() });
    assert.ok(pushed.ok !== false, JSON.stringify(pushed));
    const after = await tool('ableton_session_read', {});
    assert.ok(after.tracks.some(tr => /⟨fe:/.test(tr.name || '')), 'no Film Engine track reached the real Live set');
});
