/**
 * A cue's notes, played through instruments on this machine.
 *
 * GRD-3995. The render is judged the way the conform is: the file is READ BACK,
 * its length is measured against the cue and its level against silence. That
 * last one is not a formality — FluidSynth renders silence and exits 0 when its
 * SoundFont will not load, and a check that asks only "is there audio" passes a
 * silent render forever.
 *
 * The SoundFont is built here, a few kilobytes of sine wave, so the render test
 * needs FluidSynth and nothing downloaded. Where FluidSynth is absent the render
 * tests SKIP with the reason rather than passing over nothing.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-instruments-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const render = require('../lib/instrument-render');
const midi = require('../lib/midi');
const providers = require('../lib/providers');
const pricing = require('../lib/provider-pricing');
const { handleMusicMidi } = require('../routes/music-midi');

const FRAME = 1000 / 24;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-sf2-'));
const HAVE_FLUIDSYNTH = render.resolveFluidsynth().available;
const NO_FLUIDSYNTH = HAVE_FLUIDSYNTH ? false : 'FluidSynth is not installed here (brew install fluid-synth)';

/**
 * A minimal SoundFont 2: one preset (bank 0, program 0) → one instrument → one
 * looped sine sample at 441Hz, exactly 100 samples a period at 44.1kHz so the
 * loop points fall on whole periods.
 */
function buildSf2() {
    const rate = 44100, n = rate;
    const smpl = Buffer.alloc((n + 46) * 2);
    for (let i = 0; i < n; i++) smpl.writeInt16LE(Math.round(Math.sin((2 * Math.PI * i) / 100) * 16000), i * 2);
    const u16 = v => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
    const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
    const name20 = s => { const b = Buffer.alloc(20); b.write(s, 0, 'ascii'); return b; };
    const zstr = s => { const b = Buffer.from(s + '\0', 'ascii'); return b.length % 2 ? Buffer.concat([b, Buffer.alloc(1)]) : b; };
    const ck = (id, body) => {
        const h = Buffer.alloc(8); h.write(id, 0, 'ascii'); h.writeUInt32LE(body.length, 4);
        return Buffer.concat([h, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
    };
    const list = (type, chunks) => ck('LIST', Buffer.concat([Buffer.from(type, 'ascii'), ...chunks]));

    const info = list('INFO', [ck('ifil', Buffer.concat([u16(2), u16(1)])), ck('isng', zstr('EMU8000')), ck('INAM', zstr('Film Engine test tone'))]);
    const sdta = list('sdta', [ck('smpl', smpl)]);
    const phdr = Buffer.concat([name20('Tone'), u16(0), u16(0), u16(0), u32(0), u32(0), u32(0),
        name20('EOP'), u16(0), u16(0), u16(1), u32(0), u32(0), u32(0)]);
    const pbag = Buffer.concat([u16(0), u16(0), u16(1), u16(0)]);
    const pgen = Buffer.concat([u16(41), u16(0), u16(0), u16(0)]);              // instrument 0, terminal
    // The terminal record's bag index is the COUNT of real bags (1), not the
    // total with the terminal (2): off by one, FluidSynth refuses the whole file.
    const inst = Buffer.concat([name20('Tone'), u16(0), name20('EOI'), u16(1)]);
    const ibag = Buffer.concat([u16(0), u16(0), u16(2), u16(0)]);
    const igen = Buffer.concat([u16(54), u16(1), u16(53), u16(0), u16(0), u16(0)]); // loop continuously, sample 0, terminal
    const shdr = Buffer.concat([name20('sine'), u32(0), u32(n), u32(1000), u32(41000), u32(rate), Buffer.from([69, 0]), u16(0), u16(1),
        name20('EOS'), u32(0), u32(0), u32(0), u32(0), u32(0), Buffer.from([0, 0]), u16(0), u16(0)]);
    const pdta = list('pdta', [ck('phdr', phdr), ck('pbag', pbag), ck('pmod', Buffer.alloc(10)), ck('pgen', pgen),
        ck('inst', inst), ck('ibag', ibag), ck('imod', Buffer.alloc(10)), ck('igen', igen), ck('shdr', shdr)]);
    const body = Buffer.concat([Buffer.from('sfbk', 'ascii'), info, sdta, pdta]);
    const h = Buffer.alloc(8); h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(body.length, 4);
    return Buffer.concat([h, body]);
}

const SF2 = path.join(TMP, 'test-tone.sf2');
fs.writeFileSync(SF2, buildSf2());

/** Two notes on program 0, three seconds, as the Phase 1 writer prints them. */
function twoNotes(lengthMs = 3000) {
    const checked = midi.validateScore({
        plan: { tempo_bpm: 120, meter: '4/4', length_ms: lengthMs },
        parts: [{ name: 'tone', program: 0, notes: [
            { start_ms: 0, duration_ms: 800, pitch: 69, velocity: 120 },
            { start_ms: 1200, duration_ms: 900, pitch: 76, velocity: 120 },
        ] }],
    }, { length_ms: lengthMs, frame_ms: FRAME });
    assert.ok(checked.ok, checked.errors.join('; '));
    return checked.score;
}

function withEnv(vars, fn) {
    const saved = {};
    for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
    try { return fn(); } finally {
        for (const k of Object.keys(vars)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; }
    }
}

function call(method, parts, body) {
    return new Promise(resolve => {
        const res = { writeHead(s) { this._s = s; }, end(p) { resolve({ status: this._s, body: p ? JSON.parse(p) : null }); } };
        Promise.resolve(handleMusicMidi({ method, body }, res, ['film', 'music-cues', ...parts]));
    });
}

// ── the executable and the library ───────────────────────────────────────

test('the renderer resolves in the shape every consumer reads, and a bad FLUIDSYNTH_PATH says so', () => {
    const found = render.resolveFluidsynth();
    for (const k of ['available', 'bin', 'source']) assert.ok(k in found, `the resolver returns no ${k}`);
    if (!found.available) assert.ok(found.reason, 'an absent renderer gives no reason');
    const bad = withEnv({ FLUIDSYNTH_PATH: '/nowhere/fluidsynth' }, () => render.resolveFluidsynthUncached());
    assert.strictEqual(bad.available, false);
    assert.match(bad.reason, /FLUIDSYNTH_PATH/);
});

test('a SoundFont is named with its library and licence, and one whose licence is unknown is refused', () => {
    withEnv({ FILM_SOUNDFONT: null, FILM_SOUNDFONT_LICENSE: null }, () => {
        const copy = name => { const p = path.join(TMP, name); fs.copyFileSync(SF2, p); return p; };
        const CASES = [
            [copy('FluidR3_GM.sf2'), {}, { available: true, license: 'mit', library: 'FluidR3 GM' }],
            [copy('VSCO-2-CE.sf2'), {}, { available: true, license: 'cc0', library: 'VSCO 2 Community Edition' }],
            [SF2, {}, { available: false, reason: /licence|FILM_SOUNDFONT_LICENSE/ }],
            [SF2, { license: 'cc0' }, { available: true, license: 'cc0', license_declared: true }],
            [SF2, { license: 'free' }, { available: false, reason: /must be one of/ }],
            [path.join(TMP, 'missing.sf2'), {}, { available: false, reason: /does not exist/ }],
            [(() => { const p = path.join(TMP, 'not-a-font.sf2'); fs.writeFileSync(p, 'RIFF0000WAVEfmt '); return p; })(), {}, { available: false, reason: /not a SoundFont/ }],
        ];
        for (const [file, extra, want] of CASES) {
            const got = render.resolveSoundfont({ soundfont: file, ...extra });
            for (const [k, v] of Object.entries(want)) {
                if (v instanceof RegExp) assert.match(String(got[k]), v, `${path.basename(file)}: ${k} = ${got[k]}`);
                else assert.strictEqual(got[k], v, `${path.basename(file)}: ${k}`);
            }
        }
        // Searching prefers a library it knows over one it does not.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-sfdir-'));
        fs.copyFileSync(SF2, path.join(dir, 'aaa-unknown.sf2'));
        fs.copyFileSync(SF2, path.join(dir, 'FluidR3_GM.sf2'));
        assert.strictEqual(render.resolveSoundfont({ searchDirs: [dir] }).library, 'FluidR3 GM');
        assert.strictEqual(render.resolveSoundfont({ searchDirs: [path.join(dir, 'none')] }).available, false);
    });
});

// ── rendering, judged by the file ────────────────────────────────────────

test('notes render to the cue’s exact length, and the file is not silent', { skip: NO_FLUIDSYNTH }, () => {
    const mid = path.join(TMP, 'two.mid');
    fs.writeFileSync(mid, midi.writeSmf(twoNotes()));
    const out = path.join(TMP, 'two.wav');
    const r = render.renderMidi({ midiPath: mid, outPath: out, lengthMs: 3000, soundfont: SF2 });
    assert.ok(r.ok, `${r.stage}: ${r.reason}`);
    const seen = require('../lib/ffmpeg').inspectMedia(out);
    assert.ok(seen.ok && seen.hasAudio);
    assert.ok(Math.abs(seen.durationSeconds * 1000 - 3000) <= FRAME, `rendered ${seen.durationSeconds}s for a 3s cue`);
    assert.ok(r.levels.max_db > -40, `the render peaks at ${r.levels.max_db} dB`);
});

test('a SoundFont that loads and plays nothing is caught on VOLUME, not on an exit code', { skip: NO_FLUIDSYNTH }, () => {
    /*
     * The case an exit code cannot see. This font holds program 0 and no
     * percussion bank, so a drum part LOADS, RENDERS and EXITS 0 — as a file of
     * silence. Only measuring the level refuses it.
     */
    const drums = midi.validateScore({
        plan: { tempo_bpm: 120, meter: '4/4', length_ms: 3000 },
        parts: [{ name: 'kit', drums: true, notes: [{ start_ms: 0, duration_ms: 400, pitch: 36, velocity: 120 }, { start_ms: 1000, duration_ms: 400, pitch: 38, velocity: 120 }] }],
    }, { length_ms: 3000, frame_ms: FRAME });
    const mid = path.join(TMP, 'drums.mid');
    fs.writeFileSync(mid, midi.writeSmf(drums.score));
    const r = render.renderMidi({ midiPath: mid, outPath: path.join(TMP, 'silent.wav'), lengthMs: 3000, soundfont: SF2 });
    assert.strictEqual(r.ok, false, 'a render with no instrument for its part was accepted');
    assert.strictEqual(r.stage, 'silence', `refused at ${r.stage} (${r.reason}), which is not where a silent render is caught`);
    assert.match(r.reason, /silence/);
});

test('a SoundFont that is not there is refused before anything is kept', { skip: NO_FLUIDSYNTH }, () => {
    const mid = path.join(TMP, 'two-b.mid');
    fs.writeFileSync(mid, midi.writeSmf(twoNotes()));
    const out = path.join(TMP, 'never.wav');
    const r = render.renderMidi({ midiPath: mid, outPath: out, lengthMs: 3000, soundfont: path.join(TMP, 'gone.sf2') });
    assert.strictEqual(r.ok, false);
    assert.ok(['renderer', 'silence'].includes(r.stage), `refused at ${r.stage}`);
    assert.ok(!fs.existsSync(out) || r.stage === 'silence', 'a failed render left a file that looks like a result');
});

// ── the adapter ──────────────────────────────────────────────────────────

test('the adapter composes nothing, says so for every workflow, and is never a default', () => {
    const a = providers.get('fluidsynth');
    assert.ok(a, 'the FluidSynth adapter is not registered');
    const caps = require('../lib/music-capabilities');
    const v = caps.validateContract('fluidsynth', a.music);
    assert.ok(v.ok, v.errors.join('; '));
    for (const [wf, decl] of Object.entries(a.music)) assert.strictEqual(decl.status, 'unsupported', `${wf} claims ${decl.status}`);
    assert.strictEqual(a.requiresKey, false);
    assert.match(a.connection.instructions, /archived/, 'the adapter does not say why sfz-render is not wired');
    assert.notStrictEqual(providers.defaultProviderConfig().music, 'fluidsynth', 'a renderer that composes nothing became the default');
});

test('with no notes the adapter answers PRECONDITION, so the orchestrator skips instead of retrying', async () => {
    const r = await providers.get('fluidsynth').generate('music', { prompt: 'strings', duration_ms: 30000 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'PRECONDITION');
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'pipeline.js'), 'utf8');
    const body = src.slice(src.indexOf('async function executeStep('), src.indexOf('\nasync function ', src.indexOf('async function executeStep(') + 1));
    assert.match(body, /result\.code === 'PRECONDITION'[\s\S]{0,120}skipped: true/, 'an adapter PRECONDITION is still retried as a failure');
});

test('a render is metered and priced at zero on purpose', () => {
    const a = providers.get('fluidsynth');
    const usage = a.meter('music', { length_ms: 30000 }, { ok: true });
    assert.deepStrictEqual({ unit: usage.unit, quantity: usage.quantity }, { unit: 'second', quantity: 30 });
    const priced = pricing.priceUsage({ provider: 'fluidsynth', capability: 'music', ...usage });
    assert.ok(priced.priced && priced.self_hosted, 'an unpriced render reads as free by accident');
    assert.strictEqual(priced.amount_usd, 0);
});

test('the renderer is ready only when what it runs on is present, and preflight names what is missing', async () => {
    const pre = require('../lib/e2e-preflight');
    withEnv({ FILM_SOUNDFONT: path.join(TMP, 'gone.sf2'), FILM_SOUNDFONT_LICENSE: null }, () => {
        assert.strictEqual(providers.isProviderConfigured('fluidsynth'), false, 'a renderer with no SoundFont reads as ready');
    });
    const blocked = await pre.checkCapability('music', { music: 'fluidsynth' }, {
        resolvers: { fluidsynth: () => ({ ok: false, reasons: ['No SoundFont is installed.'], fixes: ['set FILM_SOUNDFONT'] }) },
    });
    assert.strictEqual(blocked.verdict, 'blocked');
    assert.ok(blocked.reasons.some(r => /SoundFont/.test(r)), JSON.stringify(blocked.reasons));
    assert.ok(!blocked.reasons.some(r => /credential/.test(r)), 'a keyless renderer was reported as missing a key');
    const go = await pre.checkCapability('music', { music: 'fluidsynth' }, {
        resolvers: { fluidsynth: () => ({ ok: true, reasons: [], fixes: [], soundfont: { library: 'FluidR3 GM', license: 'mit' } }) },
    });
    assert.strictEqual(go.verdict, 'go', JSON.stringify(go.reasons));
    if (HAVE_FLUIDSYNTH) {
        withEnv({ FILM_SOUNDFONT: SF2, FILM_SOUNDFONT_LICENSE: 'cc0' }, () => {
            assert.strictEqual(providers.isProviderConfigured('fluidsynth'), true);
        });
    }
});

// ── the route ────────────────────────────────────────────────────────────

function seedCueWithNotes() {
    const projectId = generateId(), sceneId = generateId(), cueId = generateId();
    db.prepare('INSERT INTO film_projects (id, title, target_fps) VALUES (?, ?, 24)').run(projectId, 'Render');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, ?)').run(sceneId, projectId, '1');
    db.prepare(`INSERT INTO film_music_cues (id, project_id, scene_id, cue_type, title, duration_ms)
                VALUES (?, ?, ?, 'score', 'Tone', 3000)`).run(cueId, projectId, sceneId);
    return { projectId, sceneId, cueId };
}

test('the render plan is free and names the library, the licence and what is missing', async () => {
    const { cueId } = seedCueWithNotes();
    const before = await withEnv({ FILM_SOUNDFONT: SF2, FILM_SOUNDFONT_LICENSE: 'cc0' }, () => call('GET', [cueId, 'midi', 'render', 'plan']));
    assert.strictEqual(before.status, 200);
    assert.strictEqual(before.body.can_render, false, 'a cue with no notes is offered a render');
    assert.ok(before.body.blockers.some(b => /no notes/.test(b)));
    assert.match(before.body.spends, /nothing/);
    assert.strictEqual(before.body.soundfont.license, 'cc0');
    const noNotes = await call('POST', [cueId, 'midi', 'render']);
    assert.strictEqual(noNotes.status, 412);
    assert.strictEqual(noNotes.body.code, 'PRECONDITION');
});

test('a rendered cue becomes the cue’s audio, with the library’s licence recorded, and is not silent', { skip: NO_FLUIDSYNTH }, async () => {
    const { cueId, projectId } = seedCueWithNotes();
    const written = await call('PUT', [cueId, 'midi'], twoNotes());
    assert.strictEqual(written.status, 200, JSON.stringify(written.body));

    const saved = { sf: process.env.FILM_SOUNDFONT, lic: process.env.FILM_SOUNDFONT_LICENSE };
    process.env.FILM_SOUNDFONT = SF2; process.env.FILM_SOUNDFONT_LICENSE = 'cc0';
    try {
        const r = await call('POST', [cueId, 'midi', 'render']);
        assert.strictEqual(r.status, 201, JSON.stringify(r.body));
        const asset = db.prepare('SELECT * FROM film_assets WHERE id = ?').get(r.body.asset_id);
        assert.strictEqual(asset.asset_type, 'audio_music');
        assert.strictEqual(asset.project_id, projectId);
        const meta = JSON.parse(asset.metadata);
        assert.strictEqual(meta.kind, 'instrument_render');
        assert.strictEqual(meta.library_license, 'cc0', 'the render does not say what its instruments are licensed under');
        assert.strictEqual(db.prepare('SELECT generated_asset_id FROM film_music_cues WHERE id = ?').get(cueId).generated_asset_id, asset.id);
        const levels = render.measureLevels(asset.file_path);
        assert.ok(levels.max_db > -40, `the cue’s audio peaks at ${levels.max_db} dB`);

        // Rendering again replaces the render rather than piling them up.
        const again = await call('POST', [cueId, 'midi', 'render']);
        assert.strictEqual(again.status, 201);
        const renders = db.prepare(`SELECT COUNT(*) AS n FROM film_assets WHERE project_id = ? AND asset_type = 'audio_music'`).get(projectId).n;
        assert.strictEqual(renders, 1);
    } finally {
        if (saved.sf == null) delete process.env.FILM_SOUNDFONT; else process.env.FILM_SOUNDFONT = saved.sf;
        if (saved.lic == null) delete process.env.FILM_SOUNDFONT_LICENSE; else process.env.FILM_SOUNDFONT_LICENSE = saved.lic;
    }
});

test('an agent can render, and the notes panel offers it', () => {
    const names = new Set(require('../lib/mcp-tools').listTools().map(t => t.name));
    for (const t of ['music_midi_render_plan', 'music_midi_render']) assert.ok(names.has(t), `${t} is not on the MCP surface`);
    const page = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
    assert.match(page, /onclick="renderCueInstruments\(/);
    assert.match(page, /async function renderCueInstruments\(/);
});
