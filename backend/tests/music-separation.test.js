const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

/**
 * STEM SEPARATION: A DERIVATIVE OF A RECORDING, NEVER A NEW PERFORMANCE,
 * AND THE RECORDING IS KEPT.
 *
 * MUS-011. ElevenLabs separates a file into two or six stems and answers
 * with a ZIP (probed live: `stem_variation_id` is `two_stems_v1` or
 * `six_stems_v1`, nothing else). Every returned stem becomes one asset with
 * its lineage, one track with a role, and one clip placed EXACTLY where the
 * source clip sits — same start, same offset, same length — so the
 * separation lands aligned under the recording it came from. The source is
 * untouched. A ZIP is untrusted bytes: entry names are refused when they
 * escape, sizes are capped, and every entry's bytes decide what it is.
 *
 * Set-based over VARIATIONS (2 and 6), because a path that lands two stems
 * and mislabels six is the partial failure a single example cannot see;
 * and over the failure set — a bad ZIP, a provider error, a half-registered
 * batch — because each must leave a FAILED operation, no assets and no
 * files, and be retryable.
 *
 * The provider is a fake here: nothing is bought to prove a ZIP is unpacked.
 * The adapter's own request builder and its retry are tested against a
 * stubbed fetch, with the real endpoint contract.
 */

// Never spend: a key in the shell would make the route test a real, paid call.
delete process.env.ELEVENLABS_API_KEY;

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-sep-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const sep = require('../lib/music-separation');
const caps = require('../lib/music-capabilities');
const route = require('../routes/music-sessions');
const providers = require('../lib/providers');
const pricing = require('../lib/provider-pricing');
const { readScoreSession } = require('../lib/music-session');
const { resolveFfmpeg } = require('../lib/ffmpeg');
const { DATA_DIR } = require('../lib/file-storage');
const { PRODUCTION_TOOLS } = require('../lib/mcp-tools');
const elevenlabs = require('../lib/providers/elevenlabs');

const bin = () => resolveFfmpeg().bin;

// ── Fixtures ───────────────────────────────────────────────────────────────

/** A stereo tone as WAV bytes at 44.1 kHz. */
function toneBytes(hz, seconds) {
    const p = path.join(os.tmpdir(), `sep_tone_${hz}_${generateId().slice(0, 6)}.wav`);
    execFileSync(bin(), ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${seconds}:sample_rate=44100`, '-ac', '2', '-c:a', 'pcm_s16le', p], { stdio: 'pipe', timeout: 120000 });
    const b = fs.readFileSync(p); fs.unlinkSync(p); return b;
}

/** A real ZIP: stored or deflated entries, a central directory, an EOCD. */
function zipOf(entries) {
    const locals = [], centrals = [];
    let offset = 0;
    for (const e of entries) {
        const name = Buffer.from(e.name, 'utf8');
        const deflated = e.deflate ? zlib.deflateRawSync(e.bytes) : e.bytes;
        const method = e.deflate ? 8 : 0;
        const crc = crc32(e.bytes);
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(method, 8);
        lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(deflated.length, 18); lh.writeUInt32LE(e.bytes.length, 22);
        lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
        const local = Buffer.concat([lh, name, deflated]);
        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(method, 10);
        ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(deflated.length, 20); ch.writeUInt32LE(e.bytes.length, 24);
        ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
        centrals.push(Buffer.concat([ch, name]));
        locals.push(local); offset += local.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
    return Buffer.concat([...locals, cd, eocd]);
}
function crc32(buf) {
    let c, crc = 0xFFFFFFFF;
    for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xFF; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1; crc = (crc >>> 8) ^ c; }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** A fake music adapter: answers a separation with the ZIP it was given, and records what it was asked. */
function fakeAdapter(zip, opts) {
    const o = opts || {};
    const calls = [];
    return {
        id: 'elevenlabs', calls,
        async generate(capability, payload) {
            calls.push({ capability, payload: { ...payload, file: payload.file && { name: payload.file.name, bytes: payload.file.bytes.length } } });
            if (o.fail) return { ok: false, status: o.fail, error: 'elevenlabs 500: the separation service fell over' };
            return { ok: true, data: typeof zip === 'function' ? zip(payload) : zip, mimeType: 'application/zip', provider_model: payload.stem_variation_id };
        },
    };
}

function film() {
    const projectId = generateId();
    db.prepare("INSERT INTO film_projects (id, title, provider_config) VALUES (?, 'Sep', ?)").run(projectId, JSON.stringify({ music: 'elevenlabs' }));
    const sceneId = generateId();
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, '1', 'X')").run(sceneId, projectId);
    const sessionId = generateId();
    db.prepare("INSERT INTO film_music_sessions (id, project_id, scene_id, name) VALUES (?, ?, ?, 'S')").run(sessionId, projectId, sceneId);
    // A recording on a track, placed off zero with an offset, so alignment is provable.
    const dir = path.join(DATA_DIR, 'music', projectId); fs.mkdirSync(dir, { recursive: true });
    const bytes = toneBytes(440, 3);
    const file = path.join(dir, `source_${generateId().slice(0, 6)}.wav`); fs.writeFileSync(file, bytes);
    const assetId = generateId();
    db.prepare(`INSERT INTO film_assets (id, project_id, asset_type, file_path, file_name, format, mime_type, duration_ms, metadata, license_source, license_status)
                VALUES (?, ?, 'audio_music', ?, ?, 'wav', 'audio/wav', 3000, ?, 'external', 'cleared')`).run(assetId, projectId, file, path.basename(file), JSON.stringify({ hash: crypto.createHash('sha256').update(bytes).digest('hex') }));
    db.prepare("INSERT INTO film_rights (id, project_id, entity_type, entity_id, subject, rights_type, status, owner, source) VALUES (?, ?, 'music', ?, 'source.wav', 'music_license', 'cleared', 'Composer', 'own recording')").run(generateId(), projectId, assetId);
    const trackId = generateId();
    db.prepare("INSERT INTO film_music_tracks (id, session_id, name, role) VALUES (?, ?, 'mix', 'mix')").run(trackId, sessionId);
    const clipId = generateId();
    db.prepare("INSERT INTO film_music_clips (id, track_id, asset_id, name, source_kind, start_ms, duration_ms, source_offset_ms) VALUES (?, ?, ?, 'the recording', 'imported', 1500, 2000, 500)").run(clipId, trackId, assetId);
    return { projectId, sceneId, sessionId, trackId, clipId, assetId, file, bytes };
}
const stemZip = (variation, tone) => zipOf(sep.VARIATIONS[variation].stems.map((name, i) => ({ name: `${name}.wav`, bytes: tone || toneBytes(440 + i * 110, 3), deflate: i % 2 === 1 })));
const opRow = id => db.prepare('SELECT * FROM film_music_operations WHERE id = ?').get(id);
const filesIn = pid => fs.readdirSync(path.join(DATA_DIR, 'music', pid)).length;

// ── The registry ───────────────────────────────────────────────────────────

test('the variations are exactly the two the live API accepts, each with its stems, and the ElevenLabs contract now says separation is available with those counts', () => {
    assert.deepStrictEqual(Object.keys(sep.VARIATIONS).map(Number).sort(), [2, 6]);
    assert.strictEqual(sep.VARIATIONS[2].id, 'two_stems_v1');
    assert.strictEqual(sep.VARIATIONS[6].id, 'six_stems_v1');
    for (const [n, v] of Object.entries(sep.VARIATIONS)) {
        assert.strictEqual(v.stems.length, Number(n), `${n} stems declares ${v.stems.length} names`);
        assert.ok(v.cost_multiplier > 0 && v.source, `${n}: no cost multiplier or source`);
        for (const s of v.stems) assert.ok(sep.STEM_ROLES[s], `${n}: stem '${s}' has no track role`);
    }
    const decl = providers.get('elevenlabs').music.music_separate;
    assert.strictEqual(decl.status, 'available', 'the contract still says separation is planned');
    assert.deepStrictEqual(decl.limits.stem_counts, [2, 6]);
    assert.deepStrictEqual(decl.models, ['two_stems_v1', 'six_stems_v1']);
    assert.match(decl.source, /elevenlabs\.io\/docs/);
    assert.ok(caps.MUSIC_CALL_SITES.some(c => c.file === 'lib/music-separation.js' && c.workflow === 'music_separate'), 'the separation call site is not in the registry');
});

// ── The free plan ──────────────────────────────────────────────────────────

test('the plan names the provider, the variation, the expected stems and a cost hint from the rate book, writes nothing, and refuses what cannot be separated', () => {
    const f = film();
    const before = db.prepare('SELECT COUNT(*) n FROM film_assets').get().n + db.prepare('SELECT COUNT(*) n FROM film_music_operations').get().n;
    const rate = pricing.rateFor('elevenlabs', 'music');
    for (const n of [2, 6]) {
        const plan = sep.planSeparation(db, f.sessionId, { clip_id: f.clipId, stems: n });
        assert.strictEqual(plan.ok, true, `${n}: ${plan.error}`);
        assert.strictEqual(plan.provider.id, 'elevenlabs');
        assert.strictEqual(plan.variation.id, sep.VARIATIONS[n].id);
        assert.deepStrictEqual(plan.expected_stems, sep.VARIATIONS[n].stems);
        assert.strictEqual(plan.source.asset_id, f.assetId);
        assert.strictEqual(plan.source.duration_ms, 3000, 'the plan does not measure the whole recording');
        assert.ok(Math.abs(plan.cost_hint.usd - 3 * rate.usd_per_unit * sep.VARIATIONS[n].cost_multiplier) < 1e-9, `${n}: the cost hint is not seconds × rate × multiplier`);
        assert.strictEqual(plan.cost_hint.source, rate.source);
        assert.deepStrictEqual(plan.placement, { start_ms: 1500, source_offset_ms: 500, duration_ms: 2000 }, 'the plan does not carry the source clip’s placement');
    }
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM film_assets').get().n + db.prepare('SELECT COUNT(*) n FROM film_music_operations').get().n, before, 'planning wrote something');

    const four = sep.planSeparation(db, f.sessionId, { clip_id: f.clipId, stems: 4 });
    assert.strictEqual(four.ok, false); assert.match(four.error, /2, 6/);
    assert.strictEqual(sep.planSeparation(db, f.sessionId, { clip_id: generateId(), stems: 2 }).status, 404);
    const noAudio = generateId();
    db.prepare("INSERT INTO film_music_clips (id, track_id, name, source_kind, start_ms, duration_ms) VALUES (?, ?, 'empty', 'generated', 0, 1000)").run(noAudio, f.trackId);
    const na = sep.planSeparation(db, f.sessionId, { clip_id: noAudio, stems: 2 });
    assert.strictEqual(na.ok, false); assert.match(na.error, /no audio/i);
    // A project whose provider cannot separate is the explicit refusal.
    db.prepare("UPDATE film_projects SET provider_config = ? WHERE id = ?").run(JSON.stringify({ music: 'gridlight' }), f.projectId);
    const un = sep.planSeparation(db, f.sessionId, { clip_id: f.clipId, stems: 2 });
    assert.strictEqual(un.ok, false); assert.strictEqual(un.code, 'UNSUPPORTED'); assert.match(un.error, /gridlight/);
    db.prepare("UPDATE film_projects SET provider_config = ? WHERE id = ?").run(JSON.stringify({ music: 'elevenlabs' }), f.projectId);
    fs.unlinkSync(f.file);
    const gone = sep.planSeparation(db, f.sessionId, { clip_id: f.clipId, stems: 2 });
    assert.strictEqual(gone.ok, false); assert.match(gone.error, /not on disk|missing/i);
});

// ── Every variation lands aligned, with lineage, and the source is kept ───

test('every stem becomes one asset with lineage, one track with a role, and one clip placed exactly where the source clip sits; rights follow; the source is untouched', async () => {
    for (const n of [2, 6]) {
        const f = film();
        const adapter = fakeAdapter(stemZip(n));
        const out = await sep.startSeparation(db, f.sessionId, { clip_id: f.clipId, stems: n }, { adapter, wait: true });
        assert.strictEqual(out.ok, true, `${n}: ${out.error}`);
        assert.strictEqual(out.status, 'complete');
        assert.strictEqual(out.stems.length, n);
        // What the provider was asked: the whole file, the right variation, metered as seconds × multiplier.
        assert.strictEqual(adapter.calls.length, 1);
        const asked = adapter.calls[0].payload;
        assert.strictEqual(asked.workflow, 'music_separate');
        assert.strictEqual(asked.stem_variation_id, sep.VARIATIONS[n].id);
        assert.strictEqual(asked.file.bytes, f.bytes.length, `${n}: the provider was not sent the whole recording`);
        assert.ok(Math.abs(asked.duration_s - 3 * sep.VARIATIONS[n].cost_multiplier) < 1e-9, `${n}: the metered quantity is not seconds × multiplier`);

        const model = readScoreSession(db, f.sessionId);
        const op = opRow(out.operation_id);
        assert.deepStrictEqual([op.kind, op.status, op.source_asset_id, op.provider, op.model], ['separate', 'complete', f.assetId, 'elevenlabs', sep.VARIATIONS[n].id]);
        const params = JSON.parse(op.params_json);
        assert.strictEqual(params.outputs.length, n);
        for (const [i, stem] of sep.VARIATIONS[n].stems.entries()) {
            const s = out.stems.find(x => x.stem === stem);
            assert.ok(s, `${n}: no output for ${stem}`);
            const asset = db.prepare('SELECT * FROM film_assets WHERE id = ?').get(s.asset_id);
            assert.ok(asset && fs.existsSync(asset.file_path), `${n}/${stem}: no file`);
            assert.strictEqual(asset.license_status, 'cleared', `${n}/${stem}: the source’s rights did not follow`);
            const meta = JSON.parse(asset.metadata);
            assert.strictEqual(meta.kind, 'separated_stem');
            assert.strictEqual(meta.derived_from, f.assetId);
            assert.strictEqual(meta.lineage.variation, sep.VARIATIONS[n].id);
            assert.strictEqual(meta.lineage.operation_id, out.operation_id);
            assert.strictEqual(meta.stem, stem);
            assert.ok(meta.hash && meta.tech && meta.tech.sample_rate, `${n}/${stem}: not inspected like an import`);
            const track = model.tracks.find(t => t.id === s.track_id);
            assert.ok(track, `${n}/${stem}: no track`);
            assert.strictEqual(track.role, sep.STEM_ROLES[stem]);
            assert.strictEqual(track.name, stem);
            const clip = track.clips.find(c => c.id === s.clip_id);
            assert.ok(clip, `${n}/${stem}: no clip`);
            assert.deepStrictEqual([clip.start_ms, clip.source_offset_ms, clip.duration_ms, clip.source_kind, clip.source_operation_id], [1500, 500, 2000, 'separated', out.operation_id], `${n}/${stem}: not aligned under the source clip`);
            const rights = db.prepare('SELECT * FROM film_rights WHERE entity_id = ?').get(s.asset_id);
            assert.ok(rights && rights.status === 'cleared' && rights.owner === 'Composer', `${n}/${stem}: no rights row derived from the source`);
            assert.match(rights.notes || '', /derived|separated/i);
            void i;
        }
        // The source clip and asset are exactly as they were.
        const src = db.prepare('SELECT * FROM film_assets WHERE id = ?').get(f.assetId);
        assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(src.file_path)).digest('hex'), crypto.createHash('sha256').update(f.bytes).digest('hex'));
        const srcClip = model.tracks.find(t => t.id === f.trackId).clips.find(c => c.id === f.clipId);
        assert.deepStrictEqual([srcClip.start_ms, srcClip.duration_ms, srcClip.source_offset_ms, srcClip.asset_id], [1500, 2000, 500, f.assetId]);
        assert.strictEqual(model.tracks.length, 1 + n);
    }
});

// ── A ZIP is untrusted ─────────────────────────────────────────────────────

test('a ZIP that escapes, inflates past the cap, or holds nothing audio leaves a failed operation, no assets and no files; a stray non-audio entry is ignored and named', async () => {
    const tone = toneBytes(440, 1);
    const cases = [
        { name: 'traversal', zip: zipOf([{ name: '../../evil.wav', bytes: tone }, { name: 'vocals.wav', bytes: tone }]), expect: /escap|traversal|\.\./i },
        { name: 'absolute', zip: zipOf([{ name: '/etc/vocals.wav', bytes: tone }, { name: 'instrumental.wav', bytes: tone }]), expect: /escap|absolute/i },
        { name: 'bomb', zip: zipOf([{ name: 'vocals.wav', bytes: Buffer.alloc(sep.ZIP_LIMITS.max_inflated_bytes + 1024, 0), deflate: true }]), expect: /inflat|larger|cap/i },
        { name: 'not audio', zip: zipOf([{ name: 'vocals.wav', bytes: Buffer.from('this is a text file pretending') }, { name: 'instrumental.wav', bytes: tone }]), expect: /vocals\.wav/ },
        { name: 'empty', zip: zipOf([]), expect: /no stems|no audio|empty/i },
        { name: 'not a zip', zip: Buffer.from('definitely not a zip archive at all, sorry'), expect: /zip/i },
    ];
    for (const c of cases) {
        const f = film();
        const before = { assets: db.prepare('SELECT COUNT(*) n FROM film_assets').get().n, files: filesIn(f.projectId), tracks: db.prepare('SELECT COUNT(*) n FROM film_music_tracks').get().n };
        const out = await sep.startSeparation(db, f.sessionId, { clip_id: f.clipId, stems: 2 }, { adapter: fakeAdapter(c.zip), wait: true });
        assert.strictEqual(out.ok, false, `${c.name}: accepted`);
        assert.match(out.error, c.expect, `${c.name}: the reason does not say what was wrong: ${out.error}`);
        const op = opRow(out.operation_id);
        assert.ok(op && op.status === 'failed' && op.error_message, `${c.name}: no failed operation recorded`);
        assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM film_assets').get().n, before.assets, `${c.name}: an asset was registered`);
        assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM film_music_tracks').get().n, before.tracks, `${c.name}: a track was created`);
        assert.strictEqual(filesIn(f.projectId), before.files, `${c.name}: files were left behind`);
    }
    // A README beside the stems is ignored, with a warning, and the stems still land.
    const f = film();
    const out = await sep.startSeparation(db, f.sessionId, { clip_id: f.clipId, stems: 2 }, { adapter: fakeAdapter(zipOf([{ name: 'README.txt', bytes: Buffer.from('made by elevenlabs') }, { name: 'vocals.wav', bytes: tone }, { name: 'instrumental.wav', bytes: tone }])), wait: true });
    assert.strictEqual(out.ok, true, out.error);
    assert.ok(out.warnings.some(w => /README\.txt/.test(w)), 'the ignored entry was not named');
    assert.strictEqual(out.stems.length, 2);
    // A stem the variation did not promise is still registered, named as unexpected.
    const g = film();
    const extra = await sep.startSeparation(db, g.sessionId, { clip_id: g.clipId, stems: 2 }, { adapter: fakeAdapter(zipOf([{ name: 'vocals.wav', bytes: tone }, { name: 'instrumental.wav', bytes: tone }, { name: 'drums.wav', bytes: tone }])), wait: true });
    assert.strictEqual(extra.ok, true);
    assert.strictEqual(extra.stems.length, 3);
    assert.ok(extra.warnings.some(w => /drums/.test(w) && /expect/i.test(w)));
});

// ── Provider failure, and the way back ─────────────────────────────────────

test('a provider failure is a failed operation with the reason and nothing registered; a retry is a new operation that names the one it retries, and only a failed one can be retried', async () => {
    const f = film();
    const before = filesIn(f.projectId);
    const bad = await sep.startSeparation(db, f.sessionId, { clip_id: f.clipId, stems: 2 }, { adapter: fakeAdapter(null, { fail: 500 }), wait: true });
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, /fell over/);
    const op = opRow(bad.operation_id);
    assert.strictEqual(op.status, 'failed'); assert.match(op.error_message, /fell over/);
    assert.strictEqual(filesIn(f.projectId), before);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM film_assets WHERE project_id = ?').get(f.projectId).n, 1);

    const again = await sep.retrySeparation(db, f.sessionId, bad.operation_id, { adapter: fakeAdapter(stemZip(2)), wait: true });
    assert.strictEqual(again.ok, true, again.error);
    assert.notStrictEqual(again.operation_id, bad.operation_id);
    assert.strictEqual(opRow(again.operation_id).parent_id, bad.operation_id, 'the retry does not name what it retries');
    assert.strictEqual(again.stems.length, 2);
    const twice = await sep.retrySeparation(db, f.sessionId, again.operation_id, { adapter: fakeAdapter(stemZip(2)), wait: true });
    assert.strictEqual(twice.ok, false); assert.match(twice.error, /complete|not failed/i);
    assert.strictEqual((await sep.retrySeparation(db, f.sessionId, generateId(), { wait: true })).status, 404);
});

test('starting without waiting answers at once with a running operation, and the status catches up', async () => {
    const f = film();
    let release; const gate = new Promise(r => { release = r; });
    const adapter = { id: 'elevenlabs', async generate(cap, payload) { await gate; return { ok: true, data: stemZip(2), mimeType: 'application/zip', provider_model: payload.stem_variation_id }; } };
    const started = await sep.startSeparation(db, f.sessionId, { clip_id: f.clipId, stems: 2 }, { adapter });
    assert.strictEqual(started.ok, true);
    assert.strictEqual(started.status, 'running');
    assert.strictEqual(sep.getSeparation(db, f.sessionId, started.operation_id).status, 'running');
    release();
    await started.done;
    const st = sep.getSeparation(db, f.sessionId, started.operation_id);
    assert.strictEqual(st.status, 'complete');
    assert.strictEqual(st.stems.length, 2);
    assert.ok(st.stems.every(s => s.url && s.asset_id && s.track_id && s.clip_id));
    assert.strictEqual(sep.listSeparations(db, f.sessionId).length, 1);
});

// ── The adapter against the real contract ──────────────────────────────────

test('the ElevenLabs request is the documented multipart call, retried once on a 5xx and not on a 4xx, and returns the ZIP bytes', async () => {
    const req = elevenlabs.buildStemSeparationRequest({ file: { bytes: Buffer.from('RIFFxxxxWAVE'), name: 'mix.wav', mime: 'audio/wav' }, stem_variation_id: 'six_stems_v1', output_format: 'mp3_44100_128' });
    assert.match(req.url, /\/v1\/music\/stem-separation\?output_format=mp3_44100_128$/);
    assert.strictEqual(req.multipart, true);
    assert.ok(req.form instanceof FormData);
    assert.strictEqual(req.form.get('stem_variation_id'), 'six_stems_v1');
    assert.ok(req.form.get('file') && req.form.get('file').name === 'mix.wav');
    assert.throws(() => elevenlabs.buildStemSeparationRequest({ file: { bytes: Buffer.from('x'), name: 'x.wav' }, stem_variation_id: 'four_stems_v1' }), /two_stems_v1|six_stems_v1/);

    const zip = zipOf([{ name: 'vocals.wav', bytes: Buffer.from('RIFF') }]);
    const seen = [];
    const realFetch = globalThis.fetch;
    let n = 0;
    globalThis.fetch = async (url, init) => {
        seen.push({ url, method: init.method, key: init.headers['xi-api-key'], hasForm: init.body instanceof FormData });
        n++;
        if (n === 1) return new Response('{"detail":"overloaded"}', { status: 503 });
        return new Response(zip, { status: 200, headers: { 'Content-Type': 'application/zip' } });
    };
    try {
        const out = await elevenlabs.callElevenLabsMultipart(req, 'KEY123', { retryDelayMs: 1 });
        assert.strictEqual(out.ok, true, out.error);
        assert.ok(Buffer.isBuffer(out.data) && out.data.equals(zip), 'the ZIP bytes did not come back whole');
        assert.strictEqual(out.mimeType, 'application/zip');
        assert.strictEqual(seen.length, 2, 'a 503 was not retried once');
        assert.ok(seen.every(s => s.method === 'POST' && s.key === 'KEY123' && s.hasForm && !('Content-Type' in (s.headers || {}))));
        n = 0; seen.length = 0;
        globalThis.fetch = async () => { seen.push(1); return new Response('{"detail":"bad"}', { status: 422 }); };
        const refused = await elevenlabs.callElevenLabsMultipart(req, 'KEY123', { retryDelayMs: 1 });
        assert.strictEqual(refused.ok, false); assert.strictEqual(refused.status, 422);
        assert.strictEqual(seen.length, 1, 'a 4xx was retried');
    } finally { globalThis.fetch = realFetch; }
    // The meter charges the separation as music seconds, at the multiplier the plan set.
    const m = providers.get('elevenlabs').meter('music', { workflow: 'music_separate', duration_s: 1.5, stem_variation_id: 'two_stems_v1' }, { provider_model: 'two_stems_v1' });
    assert.ok(m && m.unit === 'second' && Math.abs(m.quantity - 1.5) < 1e-9, JSON.stringify(m));
});

// ── Served, and reachable ──────────────────────────────────────────────────

function call(method, url, body) {
    return new Promise((resolve, reject) => {
        const res = { statusCode: 200, writeHead(c) { this.statusCode = c; return this; }, end(p) { resolve({ status: this.statusCode, body: JSON.parse(p || '{}') }); } };
        const query = Object.fromEntries(new URLSearchParams(url.split('?')[1] || ''));
        Promise.resolve(route.handleMusicSessions({ method, url, body: body || {} }, res, url.split('?')[0].split('/').filter(Boolean), query)).catch(reject);
    });
}

test('plan, start, status, list and retry are served, and the tools say what spends and what is free', async () => {
    const f = film();
    const plan = await call('GET', `/film/music-sessions/${f.sessionId}/separations/plan?clip_id=${f.clipId}&stems=2`);
    assert.strictEqual(plan.status, 200, JSON.stringify(plan.body).slice(0, 200));
    assert.strictEqual(plan.body.variation.id, 'two_stems_v1');
    assert.strictEqual((await call('GET', `/film/music-sessions/${f.sessionId}/separations/plan?clip_id=${f.clipId}&stems=4`)).status, 400);
    const list = await call('GET', `/film/music-sessions/${f.sessionId}/separations`);
    assert.strictEqual(list.status, 200); assert.deepStrictEqual(list.body.separations, []);
    assert.strictEqual((await call('GET', `/film/music-sessions/${f.sessionId}/separations/${generateId()}`)).status, 404);
    // Starting through the route resolves the real provider; with no key stored it is refused before anything is bought.
    const start = await call('POST', `/film/music-sessions/${f.sessionId}/separations`, { clip_id: f.clipId, stems: 2, wait: true });
    assert.ok([202, 201, 402, 409, 503].includes(start.status), `start answered ${start.status}: ${JSON.stringify(start.body).slice(0, 200)}`);
    if (start.body.operation_id) {
        const st = await call('GET', `/film/music-sessions/${f.sessionId}/separations/${start.body.operation_id}`);
        assert.strictEqual(st.status, 200);
        assert.ok(['failed', 'running', 'complete'].includes(st.body.status));
        if (st.body.status === 'failed') assert.match(st.body.error_message, /key|credential|elevenlabs/i, 'a refusal for want of a key does not say so');
    }

    const tools = Object.fromEntries(['music_separate_plan', 'music_separate', 'music_separation_status', 'music_separation_list', 'music_separation_retry'].map(n => [n, PRODUCTION_TOOLS.find(t => t.name === n)]));
    for (const [n, t] of Object.entries(tools)) assert.ok(t, `no ${n} tool`);
    assert.strictEqual(tools.music_separate_plan.method, 'GET'); assert.match(tools.music_separate_plan.description, /free|spends nothing/i);
    assert.strictEqual(tools.music_separate_plan.path({ session_id: 'S', clip_id: 'C', stems: 6 }), '/film/music-sessions/S/separations/plan?clip_id=C&stems=6');
    assert.strictEqual(tools.music_separate.method, 'POST');
    assert.match(tools.music_separate.description, /costs|spends|paid|money/i, 'the separating tool does not say it spends');
    assert.match(tools.music_separate.description, /two|six|2|6/);
    assert.match(tools.music_separate.description, /derivative|separated/i);
    assert.deepStrictEqual(tools.music_separate.schema.stems.enum, [2, 6]);
    assert.strictEqual(tools.music_separation_status.method, 'GET');
    assert.strictEqual(tools.music_separation_status.path({ session_id: 'S', operation_id: 'O' }), '/film/music-sessions/S/separations/O');
    assert.strictEqual(tools.music_separation_retry.method, 'POST');
    assert.strictEqual(tools.music_separation_retry.path({ session_id: 'S', operation_id: 'O' }), '/film/music-sessions/S/separations/O/retry');
});
