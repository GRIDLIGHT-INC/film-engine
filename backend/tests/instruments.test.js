/**
 * The director's own instruments, and a part played by one.
 *
 * "I have 248 libraries that I paid for over the years... my issue is trying to
 * save time composing each track." An instrument here is one SOUND: a plugin
 * plus the state that recalls the patch. Two ways one arrives — captured from
 * the plugin's editor, or read out of an NKS preset, whose PCHK chunk is that
 * same state — and this holds both, plus the render that turns a part's notes
 * into that part's audio.
 *
 * The preset is built here rather than shipped: nobody's library is in the
 * repository, and a parser tested only against files it cannot see is a parser
 * nobody has tested. The render runs against a fake sidecar serving real WAV
 * bytes, so the audio path is proven without a plugin installed.
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
    || path.join(os.tmpdir(), 'film-engine-instruments-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const instruments = require('../lib/instruments');
const presets = require('../lib/instrument-presets');
const midi = require('../lib/midi');
const { handleInstruments } = require('../routes/instruments');
const { handleMusicMidi } = require('../routes/music-midi');
const { resolveFfmpeg } = require('../lib/ffmpeg');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-instr-'));
const FF = resolveFfmpeg();
const TOKEN = 'y'.repeat(24);
const FRAME = 1000 / 24;

/** A plugin that exists as far as the registry is concerned. */
function fakePlugin(name = 'Sampler.vst3') {
    const p = path.join(TMP, name);
    fs.mkdirSync(p, { recursive: true });
    return p;
}

// ── a preset, built byte by byte ─────────────────────────────────────────

const mp = {
    str(s) {
        const b = Buffer.from(s, 'utf8');
        if (b.length < 32) return Buffer.concat([Buffer.from([0xa0 | b.length]), b]);
        return Buffer.concat([Buffer.from([0xd9, b.length]), b]);
    },
    arr(items) {
        return Buffer.concat([Buffer.from([0x90 | items.length]), ...items]);
    },
    map(pairs) {
        const parts = [Buffer.from([0x80 | pairs.length])];
        for (const [k, v] of pairs) parts.push(mp.str(k), v);
        return Buffer.concat(parts);
    },
};

function nksf({ name = 'Soft Solo Cello', vendor = 'Spitfire', bank = 'Chamber Strings',
    types = [['Strings', 'Cello']], state = Buffer.from('KONTAKT-STATE-BYTES'), chunks } = {}) {
    const chunk = (id, payload) => {
        const head = Buffer.alloc(8);
        head.write(id, 0, 'ascii');
        head.writeUInt32LE(payload.length, 4);
        return Buffer.concat([head, payload, payload.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
    };
    const version = Buffer.from([1, 0, 0, 0]);
    const nisi = Buffer.concat([version, mp.map([
        ['name', mp.str(name)], ['vendor', mp.str(vendor)], ['bankchain', mp.str(bank)],
        ['types', mp.arr(types.map(t => mp.arr(t.map(mp.str))))], ['comment', mp.str('captured for the diner scene')],
    ])]);
    const body = [Buffer.from('NIKS', 'ascii')];
    const use = chunks || ['NISI', 'NICA', 'PLID', 'PCHK'];
    for (const id of use) {
        if (id === 'NISI') body.push(chunk('NISI', nisi));
        if (id === 'NICA') body.push(chunk('NICA', Buffer.concat([version, mp.map([])])));
        if (id === 'PLID') body.push(chunk('PLID', Buffer.concat([version, mp.map([['VST3PluginUID', mp.str('kontakt')]])])));
        if (id === 'PCHK') body.push(chunk('PCHK', Buffer.concat([version, state])));
    }
    const payload = Buffer.concat(body);
    const head = Buffer.alloc(8);
    head.write('RIFF', 0, 'ascii');
    head.writeUInt32LE(payload.length, 4);
    return Buffer.concat([head, payload]);
}

test('an NKS preset is read for what it is, and its PCHK chunk is the patch', () => {
    const file = path.join(TMP, 'cello.nksf');
    fs.writeFileSync(file, nksf());
    const read = presets.readPreset(file);
    assert.strictEqual(read.name, 'Soft Solo Cello');
    assert.strictEqual(read.vendor, 'Spitfire');
    assert.strictEqual(read.library, 'Chamber Strings');
    assert.deepStrictEqual(read.tags, ['Strings', 'Cello']);
    assert.deepStrictEqual(read.chunks.sort(), ['NICA', 'NISI', 'PCHK', 'PLID']);

    const state = presets.presetState(file);
    assert.ok(state.ok, state.reason);
    // The four-byte version envelope is NKS's, not the plugin's.
    assert.strictEqual(state.state.toString(), 'KONTAKT-STATE-BYTES');
    assert.strictEqual(read.state_bytes, 'KONTAKT-STATE-BYTES'.length);
});

test('a preset that cannot be read is refused by name, never half-read', () => {
    const CASES = [
        ['not RIFF', Buffer.from('this is not a preset at all'), /not a RIFF/],
        ['no patch in it', nksf({ chunks: ['NISI', 'NICA', 'PLID'] }), /no plugin state|PCHK/],
        // RIFF(4) size(4) form(4), then the first chunk: id at 12, its size at 16.
        ['a chunk past the end', (() => { const b = nksf(); b.writeUInt32LE(9999, 16); return b; })(), /runs past the end/],
    ];
    for (const [label, bytes, expect] of CASES) {
        const file = path.join(TMP, `bad-${label.replace(/\W+/g, '-')}.nksf`);
        fs.writeFileSync(file, bytes);
        assert.throws(() => presets.readPreset(file), expect, `${label}: accepted`);
        const state = presets.presetState(file);
        assert.strictEqual(state.ok, false, `${label}: state read anyway`);
    }
});

test('metadata this reader does not understand costs the sound its name, never the sound', () => {
    // Somebody else's metadata: unreadable NISI must not lose the preset.
    const file = path.join(TMP, 'weird.nksf');
    const bytes = nksf();
    const at = bytes.indexOf(Buffer.from('NISI', 'ascii'));
    bytes[at + 8 + 4] = 0xc1;                   // a MessagePack type that is never valid
    fs.writeFileSync(file, bytes);
    const read = presets.readPreset(file);
    assert.strictEqual(read.name, 'weird', 'the file name is the fallback');
    assert.ok(presets.presetState(file).ok, 'the patch was lost with the metadata');
});

// ── the library ──────────────────────────────────────────────────────────

test('a captured patch is kept, found, renamed and forgotten', () => {
    const plugin = fakePlugin();
    const kept = instruments.createCaptured({
        name: 'Soft Solo Cello', plugin, state: Buffer.from('STATE').toString('base64'),
        library: 'Chamber Strings', vendor: 'Spitfire', tags: ['strings', 'solo'],
    });
    assert.strictEqual(kept.source, 'captured');
    assert.strictEqual(kept.available, true);
    assert.ok(fs.existsSync(instruments.statePath(kept.id)), 'the patch was not written anywhere');
    assert.ok(path.resolve(instruments.statePath(kept.id)).startsWith(path.resolve(instruments.root())),
        'a patch was written outside the instrument store');

    assert.deepStrictEqual(instruments.listInstruments({ q: 'cello' }).map(i => i.id), [kept.id]);
    assert.deepStrictEqual(instruments.listInstruments({ q: 'strings' }).map(i => i.id), [kept.id], 'a tag does not find it');
    assert.strictEqual(instruments.stateOf(kept.id).state.toString(), 'STATE');

    const renamed = instruments.updateInstrument(kept.id, { name: 'Cello, soft' });
    assert.strictEqual(renamed.name, 'Cello, soft');
    assert.deepStrictEqual(renamed.tags, ['strings', 'solo'], 'renaming cleared the tags');

    const gone = instruments.deleteInstrument(kept.id);
    assert.strictEqual(gone.deleted, kept.id);
    assert.ok(!fs.existsSync(instruments.statePath(kept.id)), 'the captured patch outlived its instrument');
});

test('an instrument whose plugin is gone says so rather than failing at render time', () => {
    const plugin = fakePlugin('Vanishing.vst3');
    const kept = instruments.createCaptured({ name: 'Gone', plugin, state: Buffer.from('S').toString('base64') });
    assert.strictEqual(instruments.getInstrument(kept.id).available, true);
    fs.rmSync(plugin, { recursive: true, force: true });
    assert.strictEqual(instruments.getInstrument(kept.id).available, false);
});

test('a patch with nothing in it is refused, and so is a plugin that is not one', () => {
    const plugin = fakePlugin('Ok.vst3');
    assert.throws(() => instruments.createCaptured({ name: 'x', plugin, state: '' }), /needs the state/);
    assert.throws(() => instruments.createCaptured({ name: '', plugin, state: Buffer.from('S').toString('base64') }), /needs a name/);
    assert.throws(() => instruments.createCaptured({ name: 'x', plugin: path.join(TMP, 'notes.txt'), state: Buffer.from('S').toString('base64') }), /not a plugin/);
});

// ── the routes ───────────────────────────────────────────────────────────

function call(handler, method, parts, body, query) {
    return new Promise(resolve => {
        const res = { writeHead(s) { this._s = s; }, end(p) { resolve({ status: this._s, body: p ? JSON.parse(p) : null }); } };
        Promise.resolve(handler({ method, body }, res, parts, query || {}));
    });
}

test('browsing presets stores nothing: a patch joins the library when it is played', async () => {
    const libraryDir = path.join(TMP, 'library');
    fs.mkdirSync(path.join(libraryDir, 'Chamber Strings'), { recursive: true });
    fs.writeFileSync(path.join(libraryDir, 'Chamber Strings', 'cello.nksf'), nksf({ name: 'Cello Soft' }));
    fs.writeFileSync(path.join(libraryDir, 'Chamber Strings', 'viola.nksf'), nksf({ name: 'Viola Con Sord' }));
    fs.writeFileSync(path.join(libraryDir, 'Chamber Strings', 'broken.nksf'), Buffer.from('nope'));
    const plugin = fakePlugin('Scanner.vst3');

    const before = db.prepare('SELECT COUNT(*) AS n FROM film_instruments').get().n;
    const first = await call(handleInstruments, 'POST', ['film', 'instruments', 'scan'], { roots: [libraryDir], plugin });
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    assert.strictEqual(first.body.found, 2, 'the readable presets were not listed');
    assert.strictEqual(first.body.unreadable_count, 1, 'a broken preset was not reported');
    assert.match(first.body.spends, /nothing/);
    assert.deepStrictEqual(first.body.presets.map(p => p.name).sort(), ['Cello Soft', 'Viola Con Sord']);
    /*
     * The rule the director asked for: "maybe we add the patch when we use it."
     * A machine with a hundred thousand presets must not put a hundred thousand
     * rows in this database for having been looked at.
     */
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM film_instruments').get().n, before,
        'browsing presets wrote rows into the library');

    // A scan where nothing is installed says so rather than reporting success.
    const nowhere = await call(handleInstruments, 'POST', ['film', 'instruments', 'scan'], { roots: [path.join(TMP, 'nothing-here')], plugin });
    assert.strictEqual(nowhere.body.found, 0);
    assert.strictEqual(nowhere.body.stored_here, 0);
});

test('capture needs the sidecar, and says how to get one', async () => {
    const saved = process.env.INSTRUMENT_SIDECAR_TOKEN;
    delete process.env.INSTRUMENT_SIDECAR_TOKEN;
    try {
        const r = await call(handleInstruments, 'POST', ['film', 'instruments', 'capture'],
            { plugin: fakePlugin('Cap.vst3'), name: 'Something' });
        assert.strictEqual(r.status, 503);
        assert.match(r.body.guide, /instrument-sidecar/);
    } finally {
        if (saved) process.env.INSTRUMENT_SIDECAR_TOKEN = saved;
    }
});

// ── a part, played ───────────────────────────────────────────────────────

function tone(file, seconds, silent = false) {
    const source = silent ? `anullsrc=r=48000:cl=stereo:d=${seconds}` : `sine=frequency=330:duration=${seconds}`;
    execFileSync(FF.bin, ['-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', source, '-ac', '2', '-ar', '48000', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    return fs.readFileSync(file);
}

async function sidecarServing(bytes) {
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
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

function seedCue() {
    const projectId = generateId(), sceneId = generateId(), cueId = generateId();
    db.prepare('INSERT INTO film_projects (id, title, target_fps) VALUES (?, ?, 24)').run(projectId, 'Score');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, ?)').run(sceneId, projectId, '1');
    db.prepare(`INSERT INTO film_music_cues (id, project_id, scene_id, cue_type, title, duration_ms)
                VALUES (?, ?, ?, 'score', 'Diner', 4000)`).run(cueId, projectId, sceneId);
    return { projectId, sceneId, cueId };
}

const score = () => ({
    plan: { tempo_bpm: 90, meter: '4/4', length_ms: 4000 },
    parts: [
        { name: 'cello', instrument: 'Cello', program: 42, notes: [{ start_ms: 0, duration_ms: 1500, pitch: 50, velocity: 90 }] },
        { name: 'pad', instrument: 'Strings', program: 48, notes: [{ start_ms: 0, duration_ms: 3800, pitch: 62, velocity: 60 }] },
    ],
});

test('a part is played by a chosen instrument and becomes that part’s audio', async () => {
    const { cueId, projectId } = seedCue();
    await call(handleMusicMidi, 'PUT', ['film', 'music-cues', cueId, 'midi'], score());
    const plugin = fakePlugin('Player.vst3');
    const inst = instruments.createCaptured({ name: 'Chamber Cello', plugin, state: Buffer.from('PATCH').toString('base64'), library: 'Chamber Strings' });
    const server = await sidecarServing(tone(path.join(TMP, 'cello-take.wav'), 6));
    try {
        const r = await call(handleMusicMidi, 'POST', ['film', 'music-cues', cueId, 'midi', 'parts', 'cello', 'render'], { instrument_id: inst.id });
        assert.strictEqual(r.status, 201, JSON.stringify(r.body));
        assert.strictEqual(r.body.part, 'cello');
        assert.strictEqual(r.body.instrument, 'Chamber Cello');

        const asset = db.prepare('SELECT * FROM film_assets WHERE id = ?').get(r.body.asset_id);
        assert.strictEqual(asset.asset_type, 'audio_music');
        const meta = JSON.parse(asset.metadata);
        assert.strictEqual(meta.kind, 'instrument_render');
        assert.strictEqual(meta.part, 'cello');
        assert.strictEqual(meta.instrument_id, inst.id);
        assert.strictEqual(meta.library, 'Chamber Strings', 'the render does not say which library played it');
        // Cut to the cue, whatever the plugin returned.
        assert.ok(Math.abs(asset.duration_ms - 4000) <= FRAME, `kept ${asset.duration_ms}ms for a 4000ms cue`);

        // And the cue now says what each part has been played by.
        const back = await call(handleMusicMidi, 'GET', ['film', 'music-cues', cueId, 'midi']);
        assert.strictEqual(back.body.renders.cello.instrument, 'Chamber Cello');
        assert.ok(back.body.renders.cello.url.includes(projectId));
        assert.strictEqual(back.body.renders.pad, undefined, 'a part nobody played reported a take');

        // Rendering it again replaces that part rather than piling takes up.
        const twice = await call(handleMusicMidi, 'POST', ['film', 'music-cues', cueId, 'midi', 'parts', 'cello', 'render'], { instrument_id: inst.id });
        assert.strictEqual(twice.status, 201);
        const rows = db.prepare(`SELECT COUNT(*) AS n FROM film_assets WHERE project_id = ? AND asset_type = 'audio_music'`).get(projectId).n;
        assert.strictEqual(rows, 1);
    } finally { server.close(); }
});

test('every way a part cannot be played is refused, naming what to do', async () => {
    const { cueId } = seedCue();
    await call(handleMusicMidi, 'PUT', ['film', 'music-cues', cueId, 'midi'], score());
    const plugin = fakePlugin('Refuser.vst3');
    const inst = instruments.createCaptured({ name: 'Temporary', plugin, state: Buffer.from('PATCH').toString('base64') });

    const noInstrument = await call(handleMusicMidi, 'POST', ['film', 'music-cues', cueId, 'midi', 'parts', 'cello', 'render'], {});
    assert.strictEqual(noInstrument.status, 400);
    assert.match(noInstrument.body.error, /instrument_list/);

    const noPart = await call(handleMusicMidi, 'POST', ['film', 'music-cues', cueId, 'midi', 'parts', 'tuba', 'render'], { instrument_id: inst.id });
    assert.strictEqual(noPart.status, 404);
    assert.deepStrictEqual(noPart.body.parts, ['cello', 'pad'], 'a wrong part name does not say what the parts are');

    const silent = await sidecarServing(tone(path.join(TMP, 'nothing.wav'), 6, true));
    try {
        const r = await call(handleMusicMidi, 'POST', ['film', 'music-cues', cueId, 'midi', 'parts', 'pad', 'render'], { instrument_id: inst.id });
        assert.strictEqual(r.status, 422, JSON.stringify(r.body));
        assert.strictEqual(r.body.stage, 'silence');
    } finally { silent.close(); }

    fs.rmSync(plugin, { recursive: true, force: true });
    const unavailable = await call(handleMusicMidi, 'POST', ['film', 'music-cues', cueId, 'midi', 'parts', 'cello', 'render'], { instrument_id: inst.id });
    assert.strictEqual(unavailable.status, 409);
    assert.match(unavailable.body.error, /plugin or its patch is missing/);
});

test('a cue with no notes cannot be played, and says what to write first', async () => {
    const { cueId } = seedCue();
    const plugin = fakePlugin('Empty.vst3');
    const inst = instruments.createCaptured({ name: 'Unused', plugin, state: Buffer.from('P').toString('base64') });
    const r = await call(handleMusicMidi, 'POST', ['film', 'music-cues', cueId, 'midi', 'parts', 'cello', 'render'], { instrument_id: inst.id });
    assert.strictEqual(r.status, 412);
    assert.match(r.body.fix, /music_midi_write/);
});

test('an agent can find an instrument and play a part with it', () => {
    const names = new Set(require('../lib/mcp-tools').listTools().map(t => t.name));
    for (const t of ['instrument_list', 'instrument_get', 'instrument_scan', 'instrument_update', 'instrument_delete', 'music_midi_render_part']) {
        assert.ok(names.has(t), `${t} is not on the MCP surface`);
    }
});

// ── the catalogue: the director's own sounds, read live ──────────────────

/** A Kontakt index, built here: nobody's library is in the repository. */
function kontaktCatalogue(sounds) {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fe-kontakt-')), 'komplete.db3');
    const db2 = require('better-sqlite3')(file);
    db2.exec(`CREATE TABLE k_sound_info (id INTEGER PRIMARY KEY, name TEXT, vendor TEXT, comment TEXT,
                                         file_name TEXT, file_ext TEXT);
              CREATE TABLE v_sound_info (id INTEGER PRIMARY KEY, name TEXT, product TEXT, brand TEXT, bank TEXT,
                                         type TEXT, character TEXT, author TEXT, comment TEXT, file_ext TEXT);`);
    const a = db2.prepare('INSERT INTO k_sound_info VALUES (?,?,?,?,?,?)');
    const b = db2.prepare('INSERT INTO v_sound_info VALUES (?,?,?,?,?,?,?,?,?,?)');
    sounds.forEach((s2, i) => {
        a.run(i + 1, s2.name, s2.vendor || 'NI', s2.comment || '', s2.file, s2.ext || 'nksn');
        b.run(i + 1, s2.name, s2.product, s2.product, s2.bank || '', s2.type || '', s2.character || '', s2.vendor || 'NI', s2.comment || '', s2.ext || 'nksn');
    });
    db2.close();
    return file;
}

async function withCatalogue(file, fn) {
    // AWAITED, not returned: a `finally` around a promise restores the
    // environment before the awaits inside have run, and the test then reads
    // the real Kontakt index instead of the one it built.
    const saved = process.env.KONTAKT_DB;
    process.env.KONTAKT_DB = file;
    try { return await fn(); } finally {
        if (saved == null) delete process.env.KONTAKT_DB; else process.env.KONTAKT_DB = saved;
    }
}

test('the catalogue is read live from Kontakt and stores nothing here', async () => {
    const real = path.join(TMP, 'Vortex Bells.nksn');
    fs.writeFileSync(real, nksf({ name: 'Vortex Bells' }));
    const file = kontaktCatalogue([
        { name: 'Vortex Bells', product: 'Ethereal Earth', bank: 'Ethereal Earth 2.0', type: 'Percussion, Bell', character: 'Metallic', file: real },
        { name: 'Martial 8th Notes', product: 'Action Strings', type: 'Strings', file: path.join(TMP, 'gone.nksn') },
    ]);
    await withCatalogue(file, async () => {
        const before = db.prepare('SELECT COUNT(*) AS n FROM film_instruments').get().n;
        const all = await call(handleInstruments, 'GET', ['film', 'instruments', 'catalogue'], null, {});
        assert.strictEqual(all.status, 200, JSON.stringify(all.body));
        assert.strictEqual(all.body.sounds.length, 2);
        assert.strictEqual(all.body.stored_here, 0);
        assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM film_instruments').get().n, before,
            'reading the catalogue wrote rows into the library');

        const one = all.body.sounds.find(s2 => s2.name === 'Vortex Bells');
        assert.strictEqual(one.library, 'Ethereal Earth');
        assert.deepStrictEqual(one.tags, ['Percussion', 'Bell', 'Metallic']);
        assert.strictEqual(one.available, true);
        assert.strictEqual(all.body.sounds.find(s2 => s2.name === 'Martial 8th Notes').available, false,
            'a sound whose file is gone was offered as playable');

        // Searchable by name, by library and by tag — that is what makes 844 usable.
        for (const [q, expect] of [['vortex', 'Vortex Bells'], ['Action Strings', 'Martial 8th Notes'], ['metallic', 'Vortex Bells']]) {
            const found = await call(handleInstruments, 'GET', ['film', 'instruments', 'catalogue'], null, { q });
            assert.deepStrictEqual(found.body.sounds.map(s2 => s2.name), [expect], `searching ${q}`);
        }
    });
});

test('a capture names itself from the catalogue, and records where the sound came from', async () => {
    const real = path.join(TMP, 'Maya.nksn');
    fs.writeFileSync(real, nksf({ name: 'Maya' }));
    const file = kontaktCatalogue([{ name: 'Maya', product: 'Ethereal Earth', bank: 'Metallic', type: 'Pad', vendor: 'Native Instruments', file: real }]);
    const plugin = fakePlugin('Named.vst3');

    // A sidecar that answers a capture with a state.
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ state_b64: Buffer.from('PATCH-BYTES').toString('base64'), bytes: 11 }));
        });
    });
    await new Promise(ok => server.listen(0, '127.0.0.1', ok));
    const saved = { url: process.env.INSTRUMENT_SIDECAR_URL, token: process.env.INSTRUMENT_SIDECAR_TOKEN };
    process.env.INSTRUMENT_SIDECAR_URL = `http://127.0.0.1:${server.address().port}`;
    process.env.INSTRUMENT_SIDECAR_TOKEN = TOKEN;
    try {
        await withCatalogue(file, async () => {
            const r = await call(handleInstruments, 'POST', ['film', 'instruments', 'capture'],
                { plugin, sound_id: 'kontakt:1' });
            assert.strictEqual(r.status, 201, JSON.stringify(r.body));
            const kept = r.body.instrument;
            assert.strictEqual(kept.name, 'Maya', 'the capture was not named from the catalogue');
            assert.strictEqual(kept.library, 'Ethereal Earth');
            assert.strictEqual(kept.vendor, 'Native Instruments');
            assert.strictEqual(kept.source_ref, 'kontakt:1', 'the sound it came from was not recorded');
            assert.strictEqual(kept.source_file, real, 'the file it came from was not recorded');
            assert.match(r.body.note, /Ethereal Earth/);

            // A sound that is not in the catalogue is refused rather than invented.
            const wrong = await call(handleInstruments, 'POST', ['film', 'instruments', 'capture'],
                { plugin, sound_id: 'kontakt:999' });
            assert.strictEqual(wrong.status, 404);
            assert.match(wrong.body.find, /catalogue/);
        });
    } finally {
        server.close();
        for (const [k, v] of [['INSTRUMENT_SIDECAR_URL', saved.url], ['INSTRUMENT_SIDECAR_TOKEN', saved.token]]) {
            if (v == null) delete process.env[k]; else process.env[k] = v;
        }
    }
});

test('a preset joins the library the moment it plays, and only once', async () => {
    const { cueId } = seedCue();
    await call(handleMusicMidi, 'PUT', ['film', 'music-cues', cueId, 'midi'], score());
    const preset = path.join(TMP, 'Played Once.nksf');
    fs.writeFileSync(preset, nksf({ name: 'Played Once', bank: 'Chamber Strings' }));
    const plugin = fakePlugin('OnUse.vst3');
    const server = await sidecarServing(tone(path.join(TMP, 'on-use.wav'), 6));
    try {
        const before = db.prepare('SELECT COUNT(*) AS n FROM film_instruments').get().n;
        const first = await call(handleMusicMidi, 'POST', ['film', 'music-cues', cueId, 'midi', 'parts', 'cello', 'render'],
            { preset_path: preset, plugin });
        assert.strictEqual(first.status, 201, JSON.stringify(first.body));
        assert.strictEqual(first.body.instrument, 'Played Once', 'the preset did not name the instrument');
        assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM film_instruments').get().n, before + 1,
            'playing a preset did not add exactly one instrument');

        const again = await call(handleMusicMidi, 'POST', ['film', 'music-cues', cueId, 'midi', 'parts', 'pad', 'render'],
            { preset_path: preset, plugin });
        assert.strictEqual(again.status, 201, JSON.stringify(again.body));
        assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM film_instruments').get().n, before + 1,
            'playing the same preset twice added it twice');
    } finally { server.close(); }
});

test('with no Kontakt on the machine the catalogue says so, rather than looking empty', async () => {
    await withCatalogue(path.join(TMP, 'no-such-komplete.db3'), async () => {
        const r = await call(handleInstruments, 'GET', ['film', 'instruments', 'catalogue'], null, {});
        assert.strictEqual(r.status, 503);
        assert.match(r.body.error, /Kontakt/);
        assert.strictEqual(r.body.sounds, 0);
    });
});
