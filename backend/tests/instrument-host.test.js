/**
 * Scoring inside Film Engine: a part's notes played by the director's own plugins.
 *
 * "I want to use those libraries INSIDE Film Engine without having Ableton Live
 * open... I generate a MIDI melody with AI, apply it to a library sound and can
 * hear the result in its own track."
 *
 * Node cannot host a VST3/AU plugin, so a sidecar does — third-party code loaded
 * into a process, which is why the boundary matters as much as the audio: a
 * loopback URL, a token, an operation allowlist, and a plugin path that must be
 * where macOS installs plugins.
 *
 * The audio path is tested against a FAKE sidecar serving real WAV bytes, so it
 * runs anywhere; the real-plugin test runs only where a plugin is installed and
 * SKIPS with its reason otherwise — the shape the FluidSynth tests already use.
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
    || path.join(os.tmpdir(), 'film-engine-insthost-' + crypto.randomUUID().slice(0, 8));

const host = require('../lib/instrument-host');
const midi = require('../lib/midi');
const { resolveFfmpeg, inspectMedia } = require('../lib/ffmpeg');
const { measureLevels } = require('../lib/instrument-render');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-insthost-'));
const TOKEN = 'x'.repeat(24);
const FRAME = 1000 / 24;
const FF = resolveFfmpeg();
const KONTAKT = ['/Library/Audio/Plug-Ins/VST3/Kontakt 8.vst3', '/Library/Audio/Plug-Ins/VST3/Kontakt 7.vst3']
    .find(p => fs.existsSync(p));

/** A real WAV: a tone, or silence, whichever the case under test needs. */
function wav(file, { seconds = 5, tone = true } = {}) {
    const source = tone ? `sine=frequency=440:duration=${seconds}` : `anullsrc=r=48000:cl=stereo:d=${seconds}`;
    execFileSync(FF.bin, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', source, '-ac', '2', '-ar', '48000', file], { stdio: 'pipe' });
    return fs.readFileSync(file);
}

/** A sidecar that answers however a test needs it to, on loopback. */
async function fakeSidecar(handler) {
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => handler(req, res, body ? JSON.parse(body) : {}));
    });
    await new Promise(ok => server.listen(0, '127.0.0.1', ok));
    const url = `http://127.0.0.1:${server.address().port}`;
    return { url, config: { configured: true, url, token: TOKEN }, close: () => server.close() };
}

const audioReply = (res, bytes, meta = {}) => {
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': bytes.length, 'X-Render': JSON.stringify(meta) });
    res.end(bytes);
};
const jsonReply = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
};

function twoNotes(lengthMs = 3000) {
    const checked = midi.validateScore({
        plan: { tempo_bpm: 120, meter: '4/4', length_ms: lengthMs },
        parts: [{ name: 'melody', program: 40, notes: [
            { start_ms: 0, duration_ms: 900, pitch: 69, velocity: 110 },
            { start_ms: 1200, duration_ms: 900, pitch: 76, velocity: 110 },
        ] }],
    }, { length_ms: lengthMs, frame_ms: FRAME });
    assert.ok(checked.ok, checked.errors.join('; '));
    return midi.writeSmf(checked.score);
}

// ── the boundary ─────────────────────────────────────────────────────────

test('the host is reached only on this machine, only with a token', () => {
    const CASES = [
        [{}, /INSTRUMENT_SIDECAR_TOKEN/],
        [{ INSTRUMENT_SIDECAR_TOKEN: TOKEN, INSTRUMENT_SIDECAR_URL: 'http://192.168.4.40:3191' }, /only ever talks to one on this machine|127\.0\.0\.1/],
        [{ INSTRUMENT_SIDECAR_TOKEN: TOKEN, INSTRUMENT_SIDECAR_URL: 'not a url' }, /not a URL/],
    ];
    for (const [env, expect] of CASES) {
        const cfg = host.hostConfig(env);
        assert.strictEqual(cfg.configured, false, `${JSON.stringify(env)} was accepted`);
        assert.match(cfg.reason, expect);
    }
    const ok = host.hostConfig({ INSTRUMENT_SIDECAR_TOKEN: TOKEN, INSTRUMENT_SIDECAR_URL: 'http://127.0.0.1:3191' });
    assert.strictEqual(ok.configured, true);
    assert.strictEqual(ok.url, 'http://127.0.0.1:3191');
});

test('an operation the sidecar does not perform is refused here, before any request', async () => {
    let reached = false;
    const fake = await fakeSidecar((req, res) => { reached = true; jsonReply(res, 200, {}); });
    try {
        const r = await host.callSidecar('load_arbitrary_code', {}, { config: fake.config });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.stage, 'op');
        assert.strictEqual(reached, false, 'an unknown operation was sent to the sidecar anyway');
    } finally { fake.close(); }
});

test('capture needs a person: it opens a window', async () => {
    const r = await host.capture({ plugin: KONTAKT || '/Library/Audio/Plug-Ins/VST3/X.vst3' }, {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.stage, 'supervised');
});

test('a sidecar that is not running says so, with how to start it', async () => {
    const r = await host.renderPart({
        plugin: '/Library/Audio/Plug-Ins/VST3/Kontakt 8.vst3', midi: twoNotes(), lengthMs: 3000,
        outPath: path.join(TMP, 'never.wav'),
    }, { config: { configured: true, url: 'http://127.0.0.1:1', token: TOKEN } });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.stage, 'unreachable');
    assert.match(r.fix, /instrument-sidecar\.py/);
});

test('the sidecar carries the token, and a refusal from it is reported with its reason', async () => {
    let seen = null;
    const fake = await fakeSidecar((req, res) => {
        seen = req.headers.authorization;
        jsonReply(res, 403, { error: 'that plugin is outside the folders macOS installs plugins into' });
    });
    try {
        const r = await host.instruments({ config: fake.config });
        assert.strictEqual(seen, `Bearer ${TOKEN}`);
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.stage, 'sidecar');
        assert.match(r.reason, /outside the folders/);
    } finally { fake.close(); }
});

// ── the audio ────────────────────────────────────────────────────────────

test('a rendered part is cut to the part’s length and kept only if it sounds', async () => {
    const tone = wav(path.join(TMP, 'tone.wav'), { seconds: 5 });
    const fake = await fakeSidecar((req, res, body) => {
        assert.strictEqual(body.op, 'render');
        assert.strictEqual(body.args.length_ms, 3000);
        assert.ok(Buffer.from(body.args.midi_b64, 'base64').subarray(0, 4).toString('ascii') === 'MThd', 'the notes did not travel');
        audioReply(res, tone, { render_seconds: 0.4 });
    });
    try {
        const out = path.join(TMP, 'part.wav');
        const r = await host.renderPart({ plugin: 'x.vst3', midi: twoNotes(), lengthMs: 3000, outPath: out }, { config: fake.config });
        assert.ok(r.ok, `${r.stage}: ${r.reason}`);
        // The sidecar returned five seconds; the part is three.
        const seen = inspectMedia(out);
        assert.ok(Math.abs(seen.durationSeconds * 1000 - 3000) <= FRAME, `kept ${seen.durationSeconds}s for a 3s part`);
        assert.ok(measureLevels(out).max_db > -40, 'a part that plays was measured as silence');
        assert.strictEqual(r.renderer, 'plugin');
        assert.strictEqual(r.render_seconds, 0.4);
    } finally { fake.close(); }
});

test('a plugin holding no patch renders silence, and silence is refused with what to do', async () => {
    const silent = wav(path.join(TMP, 'silent.wav'), { seconds: 5, tone: false });
    const fake = await fakeSidecar((req, res) => audioReply(res, silent));
    try {
        const out = path.join(TMP, 'silent-part.wav');
        const r = await host.renderPart({ plugin: 'x.vst3', midi: twoNotes(), lengthMs: 3000, outPath: out }, { config: fake.config });
        assert.strictEqual(r.ok, false, 'a silent render was kept as a take');
        assert.strictEqual(r.stage, 'silence');
        assert.match(r.reason, /capture one|choose a preset/);
    } finally { fake.close(); }
});

test('notes are required, and a length is required', async () => {
    const fake = await fakeSidecar((req, res) => audioReply(res, Buffer.alloc(0)));
    try {
        const noNotes = await host.renderPart({ plugin: 'x.vst3', midi: Buffer.from('not midi'), lengthMs: 3000, outPath: path.join(TMP, 'a.wav') }, { config: fake.config });
        assert.strictEqual(noNotes.stage, 'notes');
        const noLength = await host.renderPart({ plugin: 'x.vst3', midi: twoNotes(), lengthMs: 0, outPath: path.join(TMP, 'b.wav') }, { config: fake.config });
        assert.strictEqual(noLength.stage, 'length');
    } finally { fake.close(); }
});

test('every renderer finishes its file the same way', () => {
    // One rule: cut to length, read back, refuse silence. Two copies is how one
    // of them keeps a fix the other does not.
    const render = fs.readFileSync(path.join(__dirname, '..', 'lib', 'instrument-render.js'), 'utf8');
    const hostSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'instrument-host.js'), 'utf8');
    assert.match(hostSrc, /finishRender\(/, 'the plugin host does not finish through the shared rule');
    assert.match(render, /finishRender\(\{ rawPath: raw/, 'the SoundFont renderer does not finish through the shared rule');
    assert.strictEqual((render.match(/volumedetect/g) || []).length, 1, 'the volume measurement exists more than once');
    assert.doesNotMatch(hostSrc, /volumedetect/, 'the plugin host measures volume its own way');
});

// ── the real thing ───────────────────────────────────────────────────────

/*
 * OPT-IN, like the real-Live smoke test, and for a sharper reason: this spawns
 * a process that loads Kontakt into itself. In a parallel full-suite run that
 * took the suite from 90 seconds to eleven minutes and left a host process
 * holding the port. The fake sidecar above covers the audio path on every run;
 * this proves the real one when somebody asks for it.
 */
test('the sidecar loads a real plugin and renders through it', {
    skip: process.env.FILM_PLUGIN_SMOKE === '1'
        ? (KONTAKT ? false : 'no plugin is installed here')
        : 'opt in with FILM_PLUGIN_SMOKE=1 — it loads a real plugin and is slow',
}, async () => {
    const venv = path.join(__dirname, '..', '.venv', 'bin', 'python');
    if (!fs.existsSync(venv)) return; // the venv is the operator's; nothing to prove without it
    const { spawn } = require('child_process');
    const port = 3190 + (process.pid % 500) + 7;
    const child = spawn(venv, [path.join(__dirname, '..', 'instrument-sidecar.py')], {
        env: { ...process.env, INSTRUMENT_SIDECAR_TOKEN: TOKEN, INSTRUMENT_SIDECAR_PORT: String(port) },
        stdio: 'pipe',
    });
    const config = { configured: true, url: `http://127.0.0.1:${port}`, token: TOKEN };
    try {
        // Wait for it to answer rather than sleeping a guess.
        let up = null;
        for (let i = 0; i < 40 && !up; i++) {
            const state = await host.health({ config, timeoutMs: 2000 });
            if (state.reachable) up = state;
            else await new Promise(ok => setTimeout(ok, 500));
        }
        assert.ok(up, 'the sidecar never answered');
        assert.ok(up.instruments_found > 0, 'the sidecar found no plugins on a machine that has one');
        assert.ok(up.kontakt, 'Kontakt is installed and the sidecar did not report it');

        const listed = await host.instruments({ config });
        assert.ok(listed.ok && listed.instruments.some(i => i.path === KONTAKT), 'Kontakt is not in the list');

        // A plugin outside the plugin folders is refused: this process loads code.
        const outside = await host.callSidecar('render', {
            plugin: path.join(TMP, 'evil.vst3'), midi_b64: twoNotes().toString('base64'), length_ms: 1000,
        }, { config });
        assert.strictEqual(outside.ok, false);
        assert.match(outside.reason, /outside the folders/);

        const out = path.join(TMP, 'kontakt.wav');
        const r = await host.renderPart({ plugin: KONTAKT, midi: twoNotes(), lengthMs: 3000, outPath: out }, { config });
        // With no library loaded Kontakt plays nothing, and that is the
        // documented refusal rather than a take of silence.
        if (r.ok) {
            assert.ok(measureLevels(out).max_db > -60, 'a kept take is silent');
        } else {
            assert.strictEqual(r.stage, 'silence', `${r.stage}: ${r.reason}`);
        }
    } finally {
        child.kill('SIGINT');
    }
});
