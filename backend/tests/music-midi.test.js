/**
 * A cue's notes: parts over a harmonic plan, written by the agent or played by the director.
 *
 * GRD-3994. "Realistic instruments that I could play... I dig into melodies
 * myself with AI providing instruments." So a note list is not a curiosity the
 * agent produces once: it is a file a director opens in a DAW, plays a part
 * into, and brings back — and every one of those crossings has to keep the
 * notes and the length the cut depends on.
 *
 * Set-based where the failure is partial: over the validation rules (a rule
 * that refuses a bad pitch and waves through a note past the cue looks
 * complete), over the parts of a written file (one track per part, each with
 * its own program and channel), and over the way a DAW writes MIDI rather than
 * the way this module does.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-midi-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const midi = require('../lib/midi');
const { handleMusicMidi } = require('../routes/music-midi');
const { serveFile } = require('../lib/file-storage');

const FRAME = 1000 / 24;

function call(method, parts, body) {
    return new Promise(resolve => {
        const res = {
            writeHead(s) { this._s = s; },
            end(p) { resolve({ status: this._s, body: p ? JSON.parse(p) : null }); },
        };
        handleMusicMidi({ method, body }, res, ['film', 'music-cues', ...parts]);
    });
}

function seedCue({ duration_ms = 30000 } = {}) {
    const projectId = generateId(), sceneId = generateId(), cueId = generateId();
    db.prepare('INSERT INTO film_projects (id, title, target_fps) VALUES (?, ?, 24)').run(projectId, 'Notes');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, ?)').run(sceneId, projectId, '1');
    db.prepare(`INSERT INTO film_music_cues (id, project_id, scene_id, cue_type, title, duration_ms)
                VALUES (?, ?, ?, 'score', 'Diner', ?)`).run(cueId, projectId, sceneId, duration_ms);
    return { projectId, sceneId, cueId };
}

/** A small, real score: a pad on the changes, a bass, a melody and a kick — thirty seconds at 90bpm. */
function sampleScore(length = 30000) {
    const beat = 60000 / 90;
    const chords = ['Dm', 'Bb', 'F', 'C'];
    const pad = [], bass = [], melody = [], kick = [];
    const ROOT = { Dm: 50, Bb: 46, F: 41, C: 48 };
    for (let bar = 0; bar * 4 * beat + 4 * beat <= length; bar++) {
        const at = bar * 4 * beat, chord = chords[bar % 4], root = ROOT[chord];
        for (const iv of [0, 3, 7]) pad.push({ start_ms: at, duration_ms: 4 * beat - 20, pitch: root + 12 + iv, velocity: 60 });
        bass.push({ start_ms: at, duration_ms: 2 * beat, pitch: root - 12, velocity: 80 });
        melody.push({ start_ms: at + beat, duration_ms: beat, pitch: root + 24, velocity: 90 });
        for (let b = 0; b < 4; b++) kick.push({ start_ms: at + b * beat, duration_ms: 100, pitch: 36, velocity: 100 });
    }
    return {
        plan: {
            tempo_bpm: 90, meter: '4/4', key: 'D minor', length_ms: length,
            chords: chords.map((symbol, i) => ({ start_ms: Math.round(i * 4 * beat), symbol })),
            sections: [{ name: 'under the talk', start_ms: 0, end_ms: 16000 }, { name: 'she stands', start_ms: 16000, end_ms: length }],
        },
        parts: [
            { name: 'pad', instrument: 'String Ensemble 1', program: 48, notes: pad },
            { name: 'bass', instrument: 'Contrabass', program: 43, notes: bass },
            { name: 'melody', instrument: 'Cello', program: 42, notes: melody },
            { name: 'kick', drums: true, notes: kick },
        ],
    };
}

/**
 * A .mid the way a DAW writes one, not the way lib/midi.js does: format 0, 96
 * ticks per beat, one track, RUNNING STATUS, and a note-on at velocity 0 as the
 * release. Four quarter notes at 120bpm, starting at beat 0, on channel 0.
 */
function dawMidi({ bpm = 120, pitches = [60, 62, 64, 65], program = 73 } = {}) {
    const vl = n => { const b = [n & 0x7F]; while ((n >>= 7)) b.unshift((n & 0x7F) | 0x80); return b; };
    const uspq = Math.round(60e6 / bpm);
    const ev = [0x00, 0xFF, 0x51, 0x03, (uspq >> 16) & 0xFF, (uspq >> 8) & 0xFF, uspq & 0xFF,
        0x00, 0xFF, 0x58, 0x04, 3, 2, 24, 8,
        0x00, 0xFF, 0x03, 0x04, ...Buffer.from('Take'),
        0x00, 0xC0, program];
    pitches.forEach((p, i) => {
        if (i === 0) ev.push(0x00, 0x90, p, 100); else ev.push(0x00, p, 100);   // running status
        ev.push(...vl(96), p, 0);                                                // velocity-0 release, still running
    });
    ev.push(0x00, 0xFF, 0x2F, 0x00);
    const head = Buffer.from([0x4D, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96]);
    const trk = Buffer.concat([Buffer.from('MTrk'), Buffer.from([0, 0, (ev.length >> 8) & 0xFF, ev.length & 0xFF]), Buffer.from(ev)]);
    return Buffer.concat([head, trk]);
}

const dataUri = bytes => `data:audio/midi;base64,${bytes.toString('base64')}`;

// ── the file ─────────────────────────────────────────────────────────────

test('a note list survives the file: every part, its program and channel, every note within one frame', () => {
    const checked = midi.validateScore(sampleScore(), { length_ms: 30000, frame_ms: FRAME });
    assert.ok(checked.ok, checked.errors.join('; '));
    const back = midi.parseSmf(midi.writeSmf(checked.score));

    assert.strictEqual(back.format, 1);
    assert.strictEqual(back.tempo_bpm, 90);
    assert.strictEqual(back.time_signature, '4/4');
    assert.ok(Math.abs(back.length_ms - 30000) <= FRAME, `file is ${back.length_ms}ms against a 30000ms cue`);
    assert.deepStrictEqual(back.markers.filter(m => m.kind === 'marker').map(m => m.text), ['under the talk', 'she stands']);
    assert.deepStrictEqual(back.markers.filter(m => m.kind === 'text').map(m => m.text), ['chord Dm', 'chord Bb', 'chord F', 'chord C']);
    assert.deepStrictEqual(back.key, { sf: -1, minor: true }, 'D minor is one flat');

    const trackFor = name => back.tracks.find(t => t.name === name);
    for (const part of checked.score.parts) {
        const t = trackFor(part.name);
        assert.ok(t, `${part.name}: no track of its own, so a DAW cannot open it as an instrument`);
        assert.strictEqual(t.drums, part.drums, `${part.name}: drums on the wrong channel`);
        if (!part.drums) assert.strictEqual(t.program, part.program, `${part.name}: program lost`);
        assert.strictEqual(t.notes.length, part.notes.length, `${part.name}: note count changed`);
        part.notes.forEach((n, i) => {
            const m = t.notes[i];
            assert.strictEqual(m.pitch, n.pitch, `${part.name} note ${i}: pitch`);
            assert.strictEqual(m.velocity, n.velocity, `${part.name} note ${i}: velocity`);
            assert.ok(Math.abs(m.start_ms - n.start_ms) <= FRAME, `${part.name} note ${i}: start moved`);
            assert.ok(Math.abs(m.duration_ms - n.duration_ms) <= FRAME, `${part.name} note ${i}: length moved`);
        });
    }
    const channels = back.tracks.filter(t => t.notes.length && !t.drums).map(t => t.channel);
    assert.strictEqual(new Set(channels).size, channels.length, 'two melodic parts share a channel');
    assert.ok(!channels.includes(midi.DRUM_CHANNEL), 'a melodic part landed on the percussion channel');
});

test('every validation rule refuses, and names the part or the field', () => {
    const base = () => JSON.parse(JSON.stringify(sampleScore()));
    const CASES = [
        ['tempo out of range', s => { s.plan.tempo_bpm = 10; }, /tempo_bpm/],
        ['meter that is not a meter', s => { s.plan.meter = '5/3'; }, /meter/],
        ['a plan length a second off the cue', s => { s.plan.length_ms = 31000; }, /length_ms.*within one frame/],
        ['a chord outside the cue', s => { s.plan.chords.push({ start_ms: 40000, symbol: 'G' }); }, /chords\[4\].*outside/],
        ['a chord that is not a symbol', s => { s.plan.chords[0].symbol = 'happy'; }, /not a chord symbol/],
        ['overlapping sections', s => { s.plan.sections[1].start_ms = 10000; }, /overlap/],
        ['a section past the cue', s => { s.plan.sections[1].end_ms = 45000; }, /she stands.*not a range/],
        ['a part with no name', s => { s.parts[0].name = ''; }, /parts\[0\].*needs a name/],
        ['two parts with one name', s => { s.parts[1].name = 'pad'; }, /pad: two parts share/],
        ['a program that is not General MIDI', s => { s.parts[0].program = 128; }, /pad: program/],
        ['a pitch past 127', s => { s.parts[2].notes[0].pitch = 128; }, /melody: note 0 pitch/],
        ['a silent note', s => { s.parts[2].notes[0].velocity = 0; }, /melody: note 0 velocity/],
        ['a note past the cue', s => { s.parts[1].notes.push({ start_ms: 29900, duration_ms: 2000, pitch: 40, velocity: 80 }); }, /bass: note \d+ ends at 31900ms, past the cue at 30000ms/],
        ['a part with no notes', s => { s.parts[3].notes = []; }, /kick: a part with no notes/],
        ['seventeen parts', s => { for (let i = 0; i < 13; i++) s.parts.push({ name: 'x' + i, program: 0, notes: [{ start_ms: 0, duration_ms: 10, pitch: 60 }] }); }, /sixteen channels/],
        ['no parts at all', s => { s.parts = []; }, /at least one part/],
    ];
    assert.ok(midi.validateScore(base(), { length_ms: 30000, frame_ms: FRAME }).ok, 'the control case is refused');
    for (const [name, mutate, expect] of CASES) {
        const s = base();
        mutate(s);
        const r = midi.validateScore(s, { length_ms: 30000, frame_ms: FRAME });
        assert.ok(!r.ok, `${name}: accepted`);
        assert.ok(r.errors.some(e => expect.test(e)), `${name}: refused without naming it — ${r.errors.join(' | ')}`);
    }
});

test('a file written by a DAW reads correctly: format 0, running status, velocity-0 release, its own tempo', () => {
    const back = midi.parseSmf(dawMidi({ bpm: 120 }));
    assert.strictEqual(back.format, 0);
    assert.strictEqual(back.tempo_bpm, 120);
    assert.strictEqual(back.time_signature, '3/4');
    const t = back.tracks[0];
    assert.strictEqual(t.name, 'Take');
    assert.strictEqual(t.program, 73);
    assert.deepStrictEqual(t.notes.map(n => n.pitch), [60, 62, 64, 65]);
    // 96 ticks at 96 PPQ and 120bpm is a quarter note: 500ms each, back to back.
    assert.deepStrictEqual(t.notes.map(n => [n.start_ms, n.duration_ms]), [[0, 500], [500, 500], [1000, 500], [1500, 500]]);
});

test('what cannot be timed or read is refused, not guessed', () => {
    const smpte = dawMidi();
    smpte.writeUInt16BE(0xE728, 12);   // -25fps, 40 ticks per frame
    assert.throws(() => midi.parseSmf(smpte), /SMPTE/);
    assert.throws(() => midi.parseSmf(Buffer.from('RIFF....WAVEfmt ')), /not a MIDI file/);
    const cut = dawMidi().subarray(0, 30);
    assert.throws(() => midi.parseSmf(cut), /invalid MIDI/);
});

// ── the route ────────────────────────────────────────────────────────────

test('reading a cue’s notes is free and states the contract the agent writes against', async () => {
    const { cueId } = seedCue();
    const r = await call('GET', [cueId, 'midi']);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.length, { ms: 30000, seconds: 30, source: 'cue' });
    assert.strictEqual(r.body.gm_programs.length, 128);
    assert.match(r.body.contract.times, /milliseconds/);
    assert.strictEqual(r.body.notes, null);
    assert.strictEqual(r.body.spends, 'nothing');
});

test('written notes land as one MIDI asset on the cue, served as MIDI, every note inside the cue', async () => {
    const { cueId, projectId, sceneId } = seedCue();
    const r = await call('PUT', [cueId, 'midi'], sampleScore());
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));

    const rows = db.prepare(`SELECT * FROM film_assets WHERE project_id = ? AND asset_type = 'other'`).all(projectId);
    assert.strictEqual(rows.length, 1, 'one cue, one note file');
    const asset = rows[0];
    const meta = JSON.parse(asset.metadata);
    assert.strictEqual(meta.kind, 'midi');
    assert.strictEqual(meta.cue_id, cueId);
    assert.strictEqual(asset.scene_id, sceneId);
    assert.strictEqual(asset.mime_type, 'audio/midi');

    const back = midi.parseSmf(fs.readFileSync(asset.file_path));
    assert.ok(Math.abs(back.length_ms - 30000) <= FRAME, `the file is ${back.length_ms}ms against a 30000ms cue`);
    for (const t of back.tracks) {
        for (const n of t.notes) assert.ok(n.start_ms + n.duration_ms <= 30000 + FRAME, `${t.name}: a note ends past the cue`);
    }

    // Served as MIDI through the ordinary music route, so the page's download is a .mid.
    const server = http.createServer((req, res) => serveFile(res, projectId, 'music', asset.file_name));
    await new Promise(ok => server.listen(0, ok));
    const got = await new Promise(ok => http.get(`http://127.0.0.1:${server.address().port}/`, res => {
        const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => ok({ type: res.headers['content-type'], body: Buffer.concat(chunks) }));
    }));
    server.close();
    assert.match(got.type, /audio\/midi/);
    assert.ok(midi.isMidi(got.body));

    // A rewrite updates the same asset rather than piling up files.
    const again = await call('PUT', [cueId, 'midi'], sampleScore());
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.body.notes.asset_id, asset.id);
    assert.strictEqual(again.body.notes.version, 2);
});

test('a refused note list writes nothing', async () => {
    const { cueId, projectId } = seedCue();
    await call('PUT', [cueId, 'midi'], sampleScore());
    const bad = sampleScore();
    bad.parts[1].notes.push({ start_ms: 29500, duration_ms: 3000, pitch: 40, velocity: 80 });
    const r = await call('PUT', [cueId, 'midi'], bad);
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /bass: note \d+ ends at 32500ms/);
    const row = db.prepare(`SELECT version FROM film_assets WHERE project_id = ? AND asset_type = 'other'`).get(projectId);
    assert.strictEqual(row.version, 1, 'a refused rewrite still changed the file');
});

test('a played part replaces only that part, is kept through a rewrite, and keeps its original file', async () => {
    const { cueId, projectId } = seedCue();
    await call('PUT', [cueId, 'midi'], sampleScore());

    const played = await call('POST', [cueId, 'midi', 'parts', 'melody', 'import'], { data: dataUri(dawMidi()), name: 'melody take 3.mid' });
    assert.strictEqual(played.status, 201, JSON.stringify(played.body));
    assert.strictEqual(played.body.replaced, true);

    const score = (await call('GET', [cueId, 'midi'])).body.score;
    const melody = score.parts.find(p => p.name === 'melody');
    assert.strictEqual(melody.source, 'performed');
    assert.deepStrictEqual(melody.notes.map(n => n.pitch), [60, 62, 64, 65], 'the melody is not what was played');
    assert.strictEqual(melody.program, 73, 'the played take’s own program was dropped');
    const original = sampleScore();
    for (const name of ['pad', 'bass', 'kick']) {
        assert.strictEqual(score.parts.find(p => p.name === name).notes.length,
            original.parts.find(p => p.name === name).notes.length, `${name} changed when only the melody was replaced`);
    }
    const kept = (await call('GET', [cueId, 'midi'])).body.notes.performed_originals;
    assert.strictEqual(kept.length, 1);
    const noteFile = db.prepare(`SELECT file_path FROM film_assets WHERE project_id = ? AND asset_type = 'other'`).get(projectId).file_path;
    assert.ok(fs.existsSync(path.join(path.dirname(noteFile), kept[0].file_name)), 'the original take is gone');

    // An agent rewrite keeps what was played...
    const rewrite = await call('PUT', [cueId, 'midi'], sampleScore());
    assert.deepStrictEqual(rewrite.body.kept_performed, ['melody']);
    const afterRewrite = (await call('GET', [cueId, 'midi'])).body.score.parts.find(p => p.name === 'melody');
    assert.strictEqual(afterRewrite.source, 'performed', 'a rewrite silently wrote over what the director played');

    // ...unless it is told it may write over it.
    const over = await call('PUT', [cueId, 'midi'], { ...sampleScore(), replace_performed: ['melody'] });
    assert.deepStrictEqual(over.body.kept_performed, []);
    const afterOver = (await call('GET', [cueId, 'midi'])).body.score.parts.find(p => p.name === 'melody');
    assert.strictEqual(afterOver.source, 'agent');
});

test('a director can skip the agent: the first played part brings the plan from the file', async () => {
    const { cueId } = seedCue({ duration_ms: 10000 });
    const r = await call('POST', [cueId, 'midi', 'parts', 'melody', 'import'], { data: dataUri(dawMidi({ bpm: 96 })) });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const score = (await call('GET', [cueId, 'midi'])).body.score;
    assert.strictEqual(score.plan.tempo_bpm, 96);
    assert.strictEqual(score.plan.meter, '3/4');
    assert.strictEqual(score.plan.length_ms, 10000, 'the plan took the take’s length instead of the cue’s');
});

test('a take that is not MIDI, or runs past the cue, is refused and writes nothing', async () => {
    const { cueId, projectId } = seedCue({ duration_ms: 1200 });
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(24)]);
    const notMidi = await call('POST', [cueId, 'midi', 'parts', 'melody', 'import'], { data: `data:audio/wav;base64,${wav.toString('base64')}` });
    assert.strictEqual(notMidi.status, 400);
    assert.match(notMidi.body.error, /not a Standard MIDI File/);

    const long = await call('POST', [cueId, 'midi', 'parts', 'melody', 'import'], { data: dataUri(dawMidi()) });
    assert.strictEqual(long.status, 400);
    assert.match(long.body.error, /past the cue at 1200ms/);
    assert.match(long.body.hint, /offset_ms/);
    const n = db.prepare(`SELECT COUNT(*) AS n FROM film_assets WHERE project_id = ? AND asset_type = 'other'`).get(projectId).n;
    assert.strictEqual(n, 0);
});

test('a cue with no length is refused before anything is written', async () => {
    const projectId = generateId(), cueId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'No length');
    db.prepare(`INSERT INTO film_music_cues (id, project_id, cue_type, title) VALUES (?, ?, 'score', 'x')`).run(cueId, projectId);
    const r = await call('PUT', [cueId, 'midi'], sampleScore());
    assert.strictEqual(r.status, 409);
    assert.match(r.body.fix, /duration_ms/);
});

test('deleting the notes removes the file and keeps what was played', async () => {
    const { cueId, projectId } = seedCue();
    await call('PUT', [cueId, 'midi'], sampleScore());
    const played = await call('POST', [cueId, 'midi', 'parts', 'melody', 'import'], { data: dataUri(dawMidi()) });
    const originalName = played.body.notes.performed_originals[0].file_name;
    const asset = db.prepare(`SELECT * FROM film_assets WHERE project_id = ? AND asset_type = 'other'`).get(projectId);

    const r = await call('DELETE', [cueId, 'midi']);
    assert.strictEqual(r.status, 200);
    assert.ok(!fs.existsSync(asset.file_path), 'the note file is still on disk');
    assert.ok(fs.existsSync(path.join(path.dirname(asset.file_path), originalName)), 'deleting the notes deleted what the director played');
    assert.strictEqual((await call('GET', [cueId, 'midi'])).body.notes, null);
});

// ── the surfaces ─────────────────────────────────────────────────────────

test('an agent can write the notes, not only the direction', async () => {
    const { listTools, callTool } = require('../lib/mcp-tools');
    const names = new Set(listTools().map(t => t.name));
    for (const t of ['music_midi_get', 'music_midi_write', 'music_midi_import_part', 'music_midi_delete']) {
        assert.ok(names.has(t), `${t} is not on the MCP surface`);
    }
    const { cueId } = seedCue();
    const written = await callTool('music_midi_write', { cue_id: cueId, ...sampleScore() });
    assert.ok(!written.isError, JSON.stringify(written).slice(0, 300));
    const read = JSON.stringify(await callTool('music_midi_get', { cue_id: cueId }));
    assert.match(read, /"source":"agent"/);
});

test('the route that stores notes calls no model', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'music-midi.js'), 'utf8');
    assert.doesNotMatch(src, /llm-client|anthropic|resolve\(\s*['"]llm/, 'composing is the connected agent’s job');
});

test('every sound cue card offers the notes, and the panel’s handlers exist', () => {
    const page = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
    const start = page.indexOf('function soundCueCard(');
    const card = page.slice(start, page.indexOf('\n    }\n', start));
    assert.match(card, /onclick="openCueMidi\(/, 'a cue card has no way to its notes');
    for (const fn of ['openCueMidi', 'uploadCueMidiPart']) {
        assert.match(page, new RegExp(`async function ${fn}\\(`), `${fn} is called and never defined`);
    }
    assert.match(page, /uploadCueMidiPart\(event, /, 'no control sends a played part');
    assert.match(page, /\/midi\/parts\/' \+ encodeURIComponent\(part\) \+ '\/import'/, 'the panel posts somewhere the route does not listen');
});
