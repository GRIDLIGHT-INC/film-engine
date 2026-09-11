/**
 * STEM SEPARATION: A DERIVATIVE OF A RECORDING, NEVER A NEW PERFORMANCE.
 *
 * MUS-011. A clip on a score session is split into two or six stems by the
 * project's music provider (ElevenLabs today: `two_stems_v1` / `six_stems_v1`,
 * probed live). Four rules carry it.
 *
 * THE SOURCE IS KEPT. Nothing here writes to the recording that was separated
 * — not its file, not its asset row, not its clip. A separation adds tracks
 * beside it; deleting them is a choice somebody makes afterwards.
 *
 * EVERY STEM LANDS ALIGNED. One asset, one track and one clip per returned
 * stem, and each clip takes the SOURCE CLIP'S placement — the same start, the
 * same offset into the file, the same length — because a separation of a
 * recording is sample-aligned with it, and a stem placed anywhere else is the
 * recording moved.
 *
 * A ZIP IS UNTRUSTED BYTES. The provider answers with an archive, and the
 * archive is read here by its own central directory: a name that escapes or is
 * absolute is refused (we never write under an entry's name, but a provider
 * sending one is a broken or hostile archive, and a stem out of one is not
 * something to register), an entry past the inflation cap is refused before it
 * is inflated, an inflated length that disagrees with the header or a CRC that
 * does not match is refused, and every entry's BYTES decide what it is. A
 * non-audio entry (a README) is ignored and named; an entry that claims to be
 * audio and is not refuses the batch, naming it. A compression RATIO is
 * deliberately not a refusal: a silent stem compresses a thousand to one, and
 * a bomb check that fires on silence fires on every separated vocal with rests.
 *
 * ALL OR NOTHING, AND RETRYABLE. A separation is one `separate` operation. A
 * provider error, a bad archive, a stem the encoder cannot read or a failed
 * registration leaves the operation FAILED with the reason, no asset rows, no
 * tracks and no files. A retry is a NEW operation whose `parent_id` names the
 * one it retries — the failed attempt stays in the lineage — and only a failed
 * separation can be retried.
 *
 * The plan is FREE: it names the provider, the variation, the stems it expects
 * back and a cost hint from the rate book, and writes nothing.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const { generateId } = require('../db/database');
const { saveFile, getFileUrl } = require('./file-storage');
const { resolveStored } = require('./data-paths');
const { MEDIA_KINDS } = require('./media-kinds');
const { providerConfigOf } = require('./provider-config');
const providers = require('./providers');
const pricing = require('./provider-pricing');
const caps = require('./music-capabilities');
const { VALIDATORS, toRow, fromRow } = require('./music-session');
const { STEM_FORMATS, detectFormat, inspectStem, roleFromName } = require('./music-stems');
const jobs = require('./music-jobs');

/**
 * The variations the provider accepts, each with the stems it is expected to
 * return. The two-stem price is documented as half a generation of the same
 * length; the six-stem price is NOT published, so it is held at the full rate
 * and marked inferred — an estimate that says so rather than a number that
 * looks checked.
 */
const VARIATIONS = Object.freeze({
    2: Object.freeze({ id: 'two_stems_v1', stems: Object.freeze(['vocals', 'instrumental']), cost_multiplier: 0.5, inferred: false,
        source: 'https://elevenlabs.io/docs/api-reference/music/separate-stems' }),
    6: Object.freeze({ id: 'six_stems_v1', stems: Object.freeze(['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']), cost_multiplier: 1, inferred: true,
        source: 'https://elevenlabs.io/docs/api-reference/music/separate-stems' }),
});

/** The track role a separated stem lands on. `instrumental` and `other` are families, not one instrument. */
const STEM_ROLES = Object.freeze({
    vocals: 'vocals', instrumental: 'instrumental', drums: 'drums', bass: 'bass', guitar: 'guitar', piano: 'piano', other: 'other',
});
const FAMILY_STEMS = new Set(['instrumental', 'other']);

/** Limits on what an archive may make us inflate. Per entry, per archive, and how many entries. */
const ZIP_LIMITS = Object.freeze({
    max_inflated_bytes: 256 * 1024 * 1024,
    max_total_bytes: 1024 * 1024 * 1024,
    max_entries: 32,
});

/** Extensions that CLAIM to be audio; an entry carrying one must sniff as audio or the batch is refused. */
const AUDIO_EXTS = new Set(['wav', 'wave', 'bwf', 'aif', 'aiff', 'aifc', 'flac', 'mp3', 'm4a', 'aac', 'ogg', 'opus']);

const OUTPUT_FORMATS = /^mp3_\d+_\d+$/;

// ── The archive ────────────────────────────────────────────────────────────

/**
 * Read a ZIP by its central directory. Returns `{ ok, entries: [{ name, bytes }] }`
 * or `{ ok: false, error }` naming what was wrong. Stored and deflated entries
 * only; ZIP64 and encryption are refused by name.
 */
function readZip(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 22) return { ok: false, error: 'the provider did not return a ZIP archive (too short to hold one)' };
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xFFFF); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return { ok: false, error: 'the provider did not return a ZIP archive (no end-of-central-directory record)' };
    const count = buf.readUInt16LE(eocd + 10);
    const cdSize = buf.readUInt32LE(eocd + 12);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    if (count === 0xFFFF || cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF) return { ok: false, error: 'the ZIP is a ZIP64 archive, which is not read here' };
    if (count > ZIP_LIMITS.max_entries) return { ok: false, error: `the ZIP holds ${count} entries, more than the ${ZIP_LIMITS.max_entries} a separation can return` };
    if (cdOffset + cdSize > buf.length) return { ok: false, error: 'the ZIP is truncated: its central directory runs past the end of the file' };

    const entries = [];
    let total = 0;
    let p = cdOffset;
    for (let n = 0; n < count; n++) {
        if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return { ok: false, error: 'the ZIP central directory is corrupt' };
        const flags = buf.readUInt16LE(p + 8);
        const method = buf.readUInt16LE(p + 10);
        const crc = buf.readUInt32LE(p + 16);
        const csize = buf.readUInt32LE(p + 20);
        const usize = buf.readUInt32LE(p + 24);
        const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
        const local = buf.readUInt32LE(p + 42);
        const rawName = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
        p += 46 + nlen + xlen + clen;

        const name = rawName.replace(/\\/g, '/');
        if (name.endsWith('/')) continue; // a directory entry carries nothing
        if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return { ok: false, error: `the ZIP names an absolute path (${rawName}); an archive whose entries escape is not unpacked` };
        if (name.split('/').includes('..')) return { ok: false, error: `the ZIP entry ${rawName} escapes its folder with '..' (path traversal); an archive like that is not unpacked` };
        if (flags & 0x1) return { ok: false, error: `the ZIP entry ${name} is encrypted` };
        if (method !== 0 && method !== 8) return { ok: false, error: `the ZIP entry ${name} uses compression method ${method}; only stored and deflated entries are read` };
        if (usize > ZIP_LIMITS.max_inflated_bytes) return { ok: false, error: `the ZIP entry ${name} would inflate to ${usize} bytes, larger than the ${ZIP_LIMITS.max_inflated_bytes}-byte cap for one stem` };
        total += usize;
        if (total > ZIP_LIMITS.max_total_bytes) return { ok: false, error: `the ZIP would inflate to more than the ${ZIP_LIMITS.max_total_bytes}-byte cap for one separation` };

        if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) return { ok: false, error: `the ZIP entry ${name} has no local header where the directory says` };
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        if (start + csize > buf.length) return { ok: false, error: `the ZIP entry ${name} is truncated` };
        const packed = buf.slice(start, start + csize);
        let bytes;
        try {
            // Inflated with a ceiling one byte past the declared size, so a
            // header that lies about the size cannot make us inflate past it.
            bytes = method === 0 ? Buffer.from(packed) : zlib.inflateRawSync(packed, { maxOutputLength: Math.max(1, usize + 1) });
        } catch (e) {
            return { ok: false, error: `the ZIP entry ${name} would not inflate within its declared ${usize} bytes (${e.code || e.message})` };
        }
        if (bytes.length !== usize) return { ok: false, error: `the ZIP entry ${name} inflated to ${bytes.length} bytes where its header says ${usize}` };
        if (typeof zlib.crc32 === 'function' && (zlib.crc32(bytes) >>> 0) !== crc) return { ok: false, error: `the ZIP entry ${name} fails its checksum` };
        entries.push({ name, bytes });
    }
    return { ok: true, entries };
}

/** Which stem an entry is: the expected name it contains as a word, else its own sanitised base name. */
function stemNameOf(entryName, expected) {
    const base = path.posix.basename(entryName).replace(/\.[^.]+$/, '');
    const words = base.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const hit = expected.find(s => words.includes(s));
    if (hit) return { stem: hit, expected: true };
    const clean = words.join('_').slice(0, 60) || 'stem';
    return { stem: clean, expected: false };
}

// ── The plan ───────────────────────────────────────────────────────────────

function projectOf(db, session) {
    return db.prepare('SELECT id, provider_config FROM film_projects WHERE id = ?').get(session.project_id);
}

function clipInSession(db, sessionId, clipId) {
    return db.prepare(`SELECT c.*, t.session_id FROM film_music_clips c JOIN film_music_tracks t ON t.id = c.track_id
                       WHERE c.id = ? AND t.session_id = ?`).get(clipId, sessionId);
}

/**
 * What a separation would do, for free. Refusals carry an HTTP `status` and
 * the reason; a plan carries the provider, the variation, the stems expected
 * back, the source, the placement every stem will take and a cost hint.
 */
function planSeparation(db, sessionId, input) {
    const i = input || {};
    const session = db.prepare('SELECT * FROM film_music_sessions WHERE id = ?').get(sessionId);
    if (!session) return { ok: false, status: 404, error: 'Score session not found' };
    const project = projectOf(db, session);
    const config = providerConfigOf(project);

    const refusal = caps.unsupported('music_separate', config);
    if (refusal) return { ...refusal, status: refusal.http_status || 409 };
    const discovered = caps.discoverMusicCapabilities(config);
    const decl = discovered.workflows.find(w => w.workflow === 'music_separate');
    const providerId = discovered.provider.id;

    if (!i.clip_id) return { ok: false, status: 400, error: 'clip_id is required: the clip whose recording is separated' };
    const clip = clipInSession(db, sessionId, String(i.clip_id));
    if (!clip) return { ok: false, status: 404, error: 'Clip not found in this session' };
    if (!clip.asset_id) return { ok: false, status: 409, error: `the clip '${clip.name || clip.id}' has no audio to separate — it is a placement with no file behind it` };
    const asset = db.prepare('SELECT * FROM film_assets WHERE id = ?').get(clip.asset_id);
    if (!asset) return { ok: false, status: 409, error: `the clip '${clip.name || clip.id}' has no audio to separate — its asset was deleted` };
    const filePath = resolveStored(asset.file_path);
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, status: 409, error: `the recording for '${clip.name || clip.id}' is not on disk (${asset.file_name || asset.file_path}); it is missing, so there is nothing to send` };

    const stems = Number(i.stems);
    const v = caps.validatePlan('music_separate', { session_id: sessionId, asset_id: asset.id, stems: i.stems }, decl);
    if (!v.ok) return { ok: false, status: 400, error: v.errors.map(e => e.message).join('; '), errors: v.errors };
    const variation = VARIATIONS[stems];
    if (!variation) return { ok: false, status: 400, error: `stems must be one of ${Object.keys(VARIATIONS).join(', ')}` };

    let durationMs = Number(asset.duration_ms) || 0;
    if (!(durationMs > 0)) {
        const fmt = detectFormat(fs.readFileSync(filePath));
        const seen = fmt ? inspectStem(filePath, STEM_FORMATS[fmt]) : { ok: false };
        durationMs = seen.ok ? seen.tech.duration_ms : 0;
    }
    if (!(durationMs > 0)) return { ok: false, status: 409, error: `the recording for '${clip.name || clip.id}' could not be measured, so it cannot be priced or sent` };
    const maxIn = decl.limits && decl.limits.max_input_ms;
    if (maxIn && durationMs > maxIn) return { ok: false, status: 400, error: `the recording runs ${durationMs} ms, over ${providerId}'s max_input_ms ${maxIn}` };

    const outputFormat = OUTPUT_FORMATS.test(String(i.output_format || '')) ? i.output_format : 'mp3_44100_128';
    const seconds = durationMs / 1000;
    let rate = null;
    try { rate = pricing.rateFor(providerId, 'music'); } catch (_) { rate = null; }
    const cost_hint = rate && rate.usd_per_unit > 0
        ? { usd: seconds * rate.usd_per_unit * variation.cost_multiplier, seconds, usd_per_second: rate.usd_per_unit, multiplier: variation.cost_multiplier,
            inferred: !!(variation.inferred || rate.inferred), source: rate.source,
            note: variation.inferred ? `${variation.id} is not separately priced by the provider; held at the full music rate` : 'documented: half the cost of generating the same length' }
        : { usd: null, note: `no per-second music rate in the book for ${providerId}` };

    return {
        ok: true, free: true, writes_nothing: true,
        provider: { id: providerId, model: variation.id, resolved: discovered.provider.resolved, note: discovered.provider.note },
        variation: { id: variation.id, stems: variation.stems.length, cost_multiplier: variation.cost_multiplier, inferred: variation.inferred, source: variation.source },
        expected_stems: [...variation.stems],
        source: { clip_id: clip.id, asset_id: asset.id, file_name: asset.file_name, duration_ms: durationMs, mime_type: asset.mime_type || null },
        placement: { start_ms: clip.start_ms, source_offset_ms: clip.source_offset_ms, duration_ms: clip.duration_ms },
        output_format: outputFormat,
        cost_hint,
        limits: decl.limits,
        writes: `one '${'separate'}' operation; on success ${variation.stems.length} assets, ${variation.stems.length} tracks and ${variation.stems.length} clips, aligned under the source clip; the source is not touched`,
    };
}

// ── The run ────────────────────────────────────────────────────────────────

/** The one place the music capability is resolved for separation (MUSIC_CALL_SITES). */
function resolveSeparator(config) {
    return providers.resolve('music', config);
}

function dropFiles(paths) {
    for (const p of paths) { try { fs.unlinkSync(p); } catch (_) { /* already gone */ } }
}

/**
 * Start a separation. Returns at once with a RUNNING operation (and a `done`
 * promise for callers in-process), or — with `wait` — once it has finished.
 * `opts.adapter` replaces the resolved provider; `opts.parent_id` records a retry.
 */
async function startSeparation(db, sessionId, input, opts) {
    const o = opts || {};
    const plan = planSeparation(db, sessionId, input);
    if (!plan.ok) return plan;
    const session = db.prepare('SELECT * FROM film_music_sessions WHERE id = ?').get(sessionId);
    const project = projectOf(db, session);
    const adapter = o.adapter || resolveSeparator(providerConfigOf(project));

    // One parent (MUS-013); a child per stem is added when the stems are
    // registered. `expected` is null: the provider decides what comes back,
    // and a stem it did not return is a warning, not a failed child.
    const srcAsset = db.prepare('SELECT file_path FROM film_assets WHERE id = ?').get(plan.source.asset_id);
    let sourceFingerprint = '';
    try { sourceFingerprint = crypto.createHash('sha256').update(fs.readFileSync(resolveStored(srcAsset.file_path))).digest('hex'); } catch (_) { sourceFingerprint = ''; }
    const operationId = jobs.openJob(db, sessionId, {
        kind: 'separate', parent_id: o.parent_id || null, attempt: o.attempt || 1, source_asset_id: plan.source.asset_id, live: true, expected: null,
        provider: plan.provider.id || (adapter && adapter.id) || '', model: plan.variation.id, source_fingerprint: sourceFingerprint,
        params: { clip_id: plan.source.clip_id, stems: plan.variation.stems, variation: plan.variation.id, expected_stems: plan.expected_stems,
            placement: plan.placement, output_format: plan.output_format, cost_hint: plan.cost_hint, outputs: [], warnings: [] },
    });

    const done = runSeparation(db, session, plan, adapter, operationId).catch(e => {
        try { jobs.failJob(db, operationId, `separation failed: ${e.message}`); } catch (_) { /* the row is gone with its session */ }
        return { ok: false, status: 'failed', operation_id: operationId, error: `separation failed: ${e.message}` };
    }).finally(() => jobs.release(operationId));
    if (o.wait) return done;
    return { ok: true, status: 'running', operation_id: operationId, plan, done };
}

async function runSeparation(db, session, plan, adapter, operationId) {
    const fail = (error) => {
        jobs.failJob(db, operationId, error);
        return { ok: false, status: 'failed', operation_id: operationId, error };
    };
    if (!adapter || typeof adapter.generate !== 'function') return fail(`no music provider could be resolved for ${plan.provider.id || 'this project'}`);

    const asset = db.prepare('SELECT * FROM film_assets WHERE id = ?').get(plan.source.asset_id);
    const sourcePath = resolveStored(asset && asset.file_path);
    if (!asset || !sourcePath || !fs.existsSync(sourcePath)) return fail('the recording went missing before it could be sent');
    const bytes = fs.readFileSync(sourcePath);

    let result;
    try {
        result = await adapter.generate('music', {
            workflow: 'music_separate', stems: plan.variation.stems, stem_variation_id: plan.variation.id,
            file: { bytes, name: asset.file_name || path.basename(sourcePath), mime: asset.mime_type || 'application/octet-stream' },
            output_format: plan.output_format,
            // Metered as music seconds at the variation's multiplier, so the
            // spend report records what the provider bills rather than the
            // length of the recording.
            duration_s: (plan.source.duration_ms / 1000) * plan.variation.cost_multiplier,
        });
    } catch (e) {
        return fail(`${plan.provider.id}: ${e.message}`);
    }
    if (!result || !result.ok) return fail((result && result.error) || `${plan.provider.id} returned nothing`);
    const zip = Buffer.isBuffer(result.data) ? result.data : Buffer.from(result.data || []);

    const read = readZip(zip);
    if (!read.ok) return fail(read.error);

    const warnings = [];
    const audio = [];
    for (const e of read.entries) {
        const base = path.posix.basename(e.name);
        if (base.startsWith('.') || e.name.startsWith('__MACOSX/')) { warnings.push(`${e.name} ignored: archive metadata, not a stem`); continue; }
        const fmt = detectFormat(e.bytes);
        const ext = (base.split('.').pop() || '').toLowerCase();
        if (!fmt) {
            if (AUDIO_EXTS.has(ext)) return fail(`${e.name} is named as audio and is not audio (its bytes match no format a stem can be); nothing was registered`);
            warnings.push(`${e.name} ignored: not audio`);
            continue;
        }
        audio.push({ ...e, format: fmt });
    }
    if (!audio.length) return fail('the archive held no stems: no entry in it is audio');

    // Name the stems, and say which were not the ones asked for.
    const expected = plan.expected_stems;
    const named = audio.map(a => ({ ...a, ...stemNameOf(a.name, expected) }));
    const seenStems = new Set();
    for (const a of named) {
        if (seenStems.has(a.stem)) return fail(`the archive holds two entries for the stem '${a.stem}'; which one is the stem cannot be decided`);
        seenStems.add(a.stem);
        if (!a.expected) warnings.push(`${a.name}: '${a.stem}' is not a stem ${plan.variation.id} was expected to return; it is registered, and named here`);
    }
    for (const s of expected) if (!seenStems.has(s)) warnings.push(`${plan.variation.id} was expected to return '${s}' and did not`);

    // Write and inspect every stem before a single row is written.
    const kind = MEDIA_KINDS.music;
    const written = [];
    const staged = [];
    try {
        for (const a of named) {
            const spec = STEM_FORMATS[a.format];
            const assetId = generateId();
            const fileName = `sep_${a.stem}_${assetId.slice(0, 8)}.${spec.ext}`;
            const filePath = saveFile(session.project_id, kind.subdir, fileName, a.bytes);
            written.push(filePath);
            const seen = inspectStem(filePath, spec);
            if (!seen.ok) { dropFiles(written); return fail(`${a.name}: ${seen.error}; nothing was registered`); }
            staged.push({ ...a, spec, assetId, fileName, filePath, tech: seen.tech, hash: crypto.createHash('sha256').update(a.bytes).digest('hex') });
        }
    } catch (e) {
        dropFiles(written);
        return fail(`the stems could not be written: ${e.message}; nothing was registered`);
    }

    const placement = plan.placement;
    const sourceRights = db.prepare("SELECT * FROM film_rights WHERE entity_id = ? ORDER BY created_at LIMIT 1").get(asset.id);
    const outputs = [];
    const register = db.transaction(() => {
        const nextOrder = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM film_music_tracks WHERE session_id = ?').get(session.id).m) + 1;
        const insertAsset = db.prepare(`INSERT INTO film_assets (id, project_id, asset_type, file_path, file_name, format, mime_type, size_bytes, duration_ms, metadata, license_source, license_status, rights_notes)
                                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const insertRights = db.prepare(`INSERT INTO film_rights (id, project_id, entity_type, entity_id, subject, rights_type, status, owner, source, license_url, territory, expires_on, restrictions, notes)
                                         VALUES (?, ?, 'music', ?, ?, 'music_license', ?, ?, ?, ?, ?, ?, ?, ?)`);
        staged.forEach((s, i) => {
            const trackId = generateId();
            const clipId = generateId();
            const role = STEM_ROLES[s.stem] || roleFromName(s.stem) || 'other';
            const meta = {
                kind: 'separated_stem', stem: s.stem, derived_from: asset.id, session_id: session.id,
                lineage: { operation_id: operationId, variation: plan.variation.id, provider: plan.provider.id, source_clip_id: plan.source.clip_id, entry: s.name },
                track_id: trackId, clip_id: clipId, format: s.format, lossless: s.spec.lossless, hash: s.hash, tech: s.tech,
            };
            const note = `separated from ${asset.file_name || asset.id} (${plan.variation.id}); a derivative, so it carries the source's rights`;
            insertAsset.run(s.assetId, session.project_id, kind.assetType, s.filePath, s.fileName, s.spec.ext, s.spec.mime, s.bytes.length, s.tech.duration_ms,
                JSON.stringify(meta), asset.license_source || 'external', asset.license_status || 'unknown', note);
            const r = sourceRights || {};
            insertRights.run(generateId(), session.project_id, s.assetId, `${s.stem} — derived from ${asset.file_name || asset.id}`, r.status || 'unknown', r.owner || '', r.source || '',
                r.license_url || '', r.territory || 'worldwide', r.expires_on || '', r.restrictions || '',
                `derived: separated from asset ${asset.id} by operation ${operationId}${sourceRights ? '' : '; the source had no rights row, so this one is unknown'}${r.notes ? `. Source notes: ${r.notes}` : ''}`);

            const tv = VALIDATORS.film_music_tracks({ name: s.stem, role_kind: FAMILY_STEMS.has(s.stem) ? 'family' : 'instrument', role, sort_order: nextOrder + i });
            if (!tv.ok) throw new Error(`${s.stem}: ${tv.errors.map(e => e.message).join('; ')}`);
            const t = toRow('film_music_tracks', tv.value);
            db.prepare(`INSERT INTO film_music_tracks (id, session_id, name, role_kind, role, sort_order, color, gain_db, pan, muted, soloed, output_track_id)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(trackId, session.id, t.name, t.role_kind, t.role, t.sort_order, t.color, t.gain_db, t.pan, t.muted, t.soloed, t.output_track_id);

            // Aligned under the source: same start, same offset, same length —
            // shortened only if the stem is shorter than the placement needs.
            const room = Math.max(0, s.tech.duration_ms - placement.source_offset_ms);
            const length = Math.min(placement.duration_ms, room);
            if (length < placement.duration_ms) warnings.push(`${s.stem} is ${s.tech.duration_ms} ms, shorter than the source clip needs (${placement.source_offset_ms + placement.duration_ms} ms); its clip ends early`);
            const cv = VALIDATORS.film_music_clips({
                name: s.stem, asset_id: s.assetId, source_operation_id: operationId, source_kind: 'separated',
                start_ms: placement.start_ms, duration_ms: length, source_offset_ms: placement.source_offset_ms, take_status: 'selected',
            });
            if (!cv.ok) throw new Error(`${s.stem}: ${cv.errors.map(e => e.message).join('; ')}`);
            const c = toRow('film_music_clips', cv.value);
            db.prepare(`INSERT INTO film_music_clips (id, track_id, asset_id, source_operation_id, name, source_kind, start_ms, duration_ms, source_offset_ms, gain_db, fade_in_ms, fade_out_ms, loop_policy, warp_policy, take_group, take_status)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(clipId, trackId, c.asset_id, c.source_operation_id, c.name, c.source_kind, c.start_ms, c.duration_ms, c.source_offset_ms,
                    c.gain_db, c.fade_in_ms, c.fade_out_ms, c.loop_policy, c.warp_policy, c.take_group, c.take_status);
            // One child per stem, in the order the archive gave them; each is take 1 on its own new track.
            jobs.addChild(db, operationId, {
                seq: i, label: s.stem, status: 'complete', output_asset_id: s.assetId, output_clip_id: clipId, take_number: 1,
                job_ref: result.provider_job_id || '', model: result.provider_model || plan.variation.id,
                cost_usd: plan.cost_hint && plan.cost_hint.usd ? plan.cost_hint.usd / staged.length : 0,
            });
            outputs.push({ stem: s.stem, expected: s.expected, role, asset_id: s.assetId, track_id: trackId, clip_id: clipId,
                url: getFileUrl(kind.serveDir, session.project_id, s.fileName), format: s.format, hash: s.hash, duration_ms: s.tech.duration_ms });
        });
        jobs.rollup(db, operationId, { params: { outputs, warnings }, job_ref: result.provider_job_id || '' });
    });
    try { register(); } catch (e) {
        dropFiles(written);
        return fail(`the stems could not be registered: ${e.message}; nothing was recorded`);
    }
    return { ok: true, status: 'complete', operation_id: operationId, source_asset_id: asset.id, stems: outputs, warnings };
}

// ── Reading and retrying ───────────────────────────────────────────────────

function present(row) {
    const op = fromRow('film_music_operations', row);
    const params = op.params || {};
    return {
        operation_id: row.id, session_id: row.session_id, parent_id: row.parent_id, status: row.status,
        provider: row.provider, model: row.model, source_asset_id: row.source_asset_id,
        clip_id: params.clip_id || null, stems_requested: params.stems || null, expected_stems: params.expected_stems || [],
        stems: params.outputs || [], warnings: params.warnings || [], cost_hint: params.cost_hint || null, cost_usd: row.cost_usd,
        error_message: row.error_message, started_at: row.started_at, completed_at: row.completed_at, created_at: row.created_at,
    };
}

function getSeparation(db, sessionId, opId) {
    const row = db.prepare("SELECT * FROM film_music_operations WHERE id = ? AND session_id = ? AND kind = 'separate' AND group_id IS NULL").get(opId, sessionId);
    return row ? present(row) : null;
}

function listSeparations(db, sessionId) {
    return db.prepare("SELECT * FROM film_music_operations WHERE session_id = ? AND kind = 'separate' AND group_id IS NULL ORDER BY created_at DESC, rowid DESC").all(sessionId).map(present);
}

/** A failed separation, tried again as a new operation that names the one it retries. */
async function retrySeparation(db, sessionId, opId, opts) {
    const row = db.prepare("SELECT * FROM film_music_operations WHERE id = ? AND session_id = ? AND kind = 'separate' AND group_id IS NULL").get(opId, sessionId);
    if (!row) return { ok: false, status: 404, error: 'Separation not found in this session' };
    if (row.status !== 'failed') return { ok: false, status: 409, error: `that separation is ${row.status}, not failed; only a failed separation is retried` };
    const params = present(row);
    return startSeparation(db, sessionId, { clip_id: params.clip_id, stems: params.stems_requested }, { attempt: (row.attempt || 1) + 1, ...(opts || {}), parent_id: row.id });
}

module.exports = {
    VARIATIONS, STEM_ROLES, ZIP_LIMITS,
    readZip, stemNameOf, planSeparation, startSeparation, getSeparation, listSeparations, retrySeparation, resolveSeparator,
};
