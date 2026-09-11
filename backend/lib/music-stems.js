/**
 * ALIGNED USER STEM IMPORT (MUS-006).
 *
 * A composer hands over instrument stems: several equal-length files that
 * share one start. The single thing an importer must never do is HELP. It
 * must not trim the head (the leading silence IS the alignment), it must not
 * re-encode the file it was given (the original is the only copy that can be
 * trusted later), and it must not guess what the file is from its name (a
 * `.wav` that is an MP3 decodes as noise, and a file called `take.bin` may be
 * a perfectly good BWF).
 *
 * So, in order:
 *
 *   1. THE BYTES DECIDE. `STEM_FORMATS` sniffs every format the epic names —
 *      WAV/BWF, AIFF, FLAC, MP3, M4A — by its own magic, and the stored
 *      extension follows the bytes. The declared name and MIME are recorded
 *      and trusted for nothing.
 *   2. THE ORIGINAL IS SACRED. Stored byte-for-byte, hashed (sha256), under
 *      a unique name so nothing ever overwrites it. Every technical fact —
 *      duration, channels, sample rate, bit depth, codec, bitrate — is read
 *      from the file by the encoder, never from the row or the name.
 *   3. THE WORKING COPY IS OPTIONAL AND RECORDED. `normalize_48k` writes a
 *      48 kHz / 24-bit PCM derivative BESIDE the original, with the
 *      resampling written into its metadata and `derived_from` naming the
 *      original. A file already at 48 kHz and lossless gets none: resampling
 *      a file to itself is a copy with a lie attached. The clip plays the
 *      working copy when there is one, so the session runs at one rate.
 *   4. THE PLACEMENT IS ALIGNED. One track and one clip per file, every clip
 *      at the SAME `start_ms` with `source_offset_ms` 0 and the measured
 *      length — leading silence survives because nothing touched the bytes.
 *   5. RIGHTS ARE RECORDED, NEVER ASSUMED. A `film_rights` row per original
 *      (entity_type 'music', rights_type 'music_license'); no declaration is
 *      written down as `unknown`, and a status the register does not know is
 *      refused rather than stored as prose.
 *   6. ONE OPERATION, ONE TRANSACTION. A batch is one `import` operation and
 *      every row lands in one transaction; a refusal — one unreadable file,
 *      one illegal rights status — writes NOTHING and leaves NO FILES: the
 *      failure names the file, and the composer sends the batch again whole.
 *
 * BPM and key are HINTS, from tags first and the filename second, and they
 * are stored as hints — a `120bpm` in a name is what somebody once typed,
 * not a measurement — so nothing paid can rest on them without a person
 * reading them first.
 *
 * DELIBERATELY NOT ON A SCENE. `film_assets.scene_id` is what the sound sheet
 * and the timeline read to lay a scene's bed, and a stem is not a bed: a
 * stem with a scene id would be picked up as the scene's newest music and
 * PLAYED under the cut. A stem belongs to its session, through the clip that
 * places it and `metadata.session_id`, and reaches the film only through a
 * bounce.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const { generateId } = require('../db/database');
const { saveFile, getFileUrl } = require('./file-storage');
const { resolveFfmpeg } = require('./ffmpeg');
const { parseProbe } = require('./audio-features');
const { MEDIA_KINDS } = require('./media-kinds');
const contracts = require('./music-session');

const { VALIDATORS, toRow } = contracts;

const ascii = (b, from, len) => b.toString('latin1', from, from + len);

/**
 * Every format the importer accepts, sniffed by its own bytes.
 *
 * `lossless` is a FACT about the container that decides two things: whether a
 * bit depth is a meaningful number (a lossy codec has none — its samples are
 * reconstructed, not stored), and whether a 48 kHz file may skip the working
 * copy (a lossy 48 kHz file still benefits from a PCM working copy, since
 * every later edit would otherwise decode it again).
 */
const STEM_FORMATS = Object.freeze({
    wav: {
        ext: 'wav', mime: 'audio/wav', lossless: true, label: 'WAV/BWF',
        // RIFF....WAVE, or RF64....WAVE for a Broadcast Wave past 4GB.
        sniff: b => b.length > 12 && ['RIFF', 'RF64'].includes(ascii(b, 0, 4)) && ascii(b, 8, 4) === 'WAVE',
    },
    aiff: {
        ext: 'aiff', mime: 'audio/aiff', lossless: true, label: 'AIFF',
        sniff: b => b.length > 12 && ascii(b, 0, 4) === 'FORM' && ['AIFF', 'AIFC'].includes(ascii(b, 8, 4)),
    },
    flac: {
        ext: 'flac', mime: 'audio/flac', lossless: true, label: 'FLAC',
        sniff: b => b.length > 4 && ascii(b, 0, 4) === 'fLaC',
    },
    mp3: {
        ext: 'mp3', mime: 'audio/mpeg', lossless: false, label: 'MP3',
        // An ID3v2 header, or a bare MPEG frame sync (11 set bits) for a file
        // written without tags.
        sniff: b => b.length > 4 && (ascii(b, 0, 3) === 'ID3' || (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0)),
    },
    m4a: {
        ext: 'm4a', mime: 'audio/mp4', lossless: false, label: 'M4A',
        // An ISO base-media file whose brand says audio. `isom`/`mp42` brands
        // are also what a VIDEO carries, so those are only accepted when the
        // compatible-brand list names M4A — a silent video file is not a stem.
        sniff: b => {
            if (b.length < 16 || ascii(b, 4, 4) !== 'ftyp') return false;
            const size = b.readUInt32BE(0);
            const box = ascii(b, 8, Math.min(size, b.length) - 8);
            return /M4A |M4B |M4P /.test(box);
        },
    },
});

/** Which format these bytes are, or null when none of the five claims them. */
function detectFormat(bytes) {
    const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
    for (const [id, spec] of Object.entries(STEM_FORMATS)) if (spec.sniff(b)) return id;
    return null;
}

/** The register's own vocabulary. `unknown` is a recorded answer, not an absence. */
const RIGHTS_STATUSES = Object.freeze(['unknown', 'cleared', 'restricted', 'expired', 'blocked']);

/**
 * Words in a filename that name what a stem IS. A hint list, deliberately
 * short: a role read from a name is a starting point for the person naming
 * the track, and a wrong guess presented as a fact is worse than an empty
 * field. An explicit `role` on the file always wins.
 */
const ROLE_WORDS = Object.freeze({
    drums: 'drums', drum: 'drums', kit: 'drums', perc: 'percussion', percussion: 'percussion',
    bass: 'bass', keys: 'keys', piano: 'piano', rhodes: 'keys', organ: 'organ', synth: 'synth', pad: 'pad', pads: 'pad',
    lead: 'lead', gtr: 'guitar', guitar: 'guitar', guitars: 'guitar', vox: 'vocals', vocal: 'vocals', vocals: 'vocals',
    choir: 'choir', strings: 'strings', string: 'strings', violin: 'violin', viola: 'viola', cello: 'cello',
    brass: 'brass', horns: 'brass', horn: 'horn', trumpet: 'trumpet', woodwind: 'woodwind', woodwinds: 'woodwind',
    flute: 'flute', clarinet: 'clarinet', oboe: 'oboe', harp: 'harp', fx: 'fx', sfx: 'fx', amb: 'ambience',
    ambience: 'ambience', click: 'click', ref: 'reference', reference: 'reference', mix: 'mix', master: 'mix',
});

const NORMALIZE_RATE = 48000;

// ── Reading a file ─────────────────────────────────────────────────────────

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

/** The name without its extension, safe for a filename and a track name. */
function stemOf(name) {
    const base = path.basename(String(name || 'stem')).replace(/\.[A-Za-z0-9]{1,5}$/, '');
    return base.replace(/[^A-Za-z0-9 _.\-#]+/g, '_').trim() || 'stem';
}

/** Bit depth from what the encoder printed; null for anything lossy. */
function bitDepthOf(spec, streamLine, tech) {
    if (!spec.lossless) return null;
    const explicit = /\((\d+) bit\)/.exec(streamLine || '');
    if (explicit) return Number(explicit[1]);
    const pcm = /pcm_(?:s|u|f)(\d+)/.exec(tech.codec || '');
    if (pcm) return Number(pcm[1]);
    const fmt = /^(?:s|u|f)(\d+)p?$/.exec(tech.sample_fmt || '');
    if (fmt) return Number(fmt[1]);
    return null;
}

/** BPM and key hints from the tag lines the encoder prints for a file. */
function hintsFromTags(text) {
    const out = { bpm: null, key: null };
    for (const m of String(text || '').matchAll(/^\s{2,}([A-Za-z_]+)\s*:\s*(.+?)\s*$/gm)) {
        const k = m[1].toLowerCase();
        const v = m[2].trim();
        if (['tbpm', 'bpm', 'tempo'].includes(k) && /^\d{2,3}(\.\d+)?$/.test(v)) out.bpm = Number(v);
        if (['tkey', 'initialkey', 'initial_key', 'key'].includes(k)) {
            const key = normaliseKey(v);
            if (key) out.key = key;
        }
    }
    return out;
}

/**
 * A key token is a note, an optional accidental and a MODE — `Am`, `F#`,
 * `Bbmaj`. A bare `C` is refused: `take_C` is take C, not C major, and a hint
 * that fires on every capital letter is a hint nobody trusts.
 */
function normaliseKey(token) {
    const m = /^([A-Ga-g])([#b♭♯]?)(m|min|minor|maj|major)?$/.exec(String(token || '').trim());
    if (!m) return null;
    if (!m[2] && !m[3]) return null;
    const note = m[1].toUpperCase();
    const acc = m[2] === '♭' ? 'b' : m[2] === '♯' ? '#' : m[2];
    const minor = /^(m|min|minor)$/.test(m[3] || '');
    return `${note}${acc}${minor ? 'm' : ''}`;
}

function hintsFromName(name) {
    const out = { bpm: null, key: null };
    const base = stemOf(name);
    const bpm = /(\d{2,3})\s*bpm/i.exec(base);
    if (bpm) out.bpm = Number(bpm[1]);
    for (const token of base.split(/[\s_\-.]+/)) {
        const key = normaliseKey(token);
        if (key) { out.key = key; break; }
    }
    return out;
}

/** Tags first, then the filename, then nothing — and `from` says which. */
function hintsFor(name, probeText) {
    const tags = hintsFromTags(probeText);
    const fromName = hintsFromName(name);
    const bpm = tags.bpm !== null ? tags.bpm : fromName.bpm;
    const key = tags.key !== null ? tags.key : fromName.key;
    const from = (tags.bpm !== null || tags.key !== null) ? 'tags'
        : (fromName.bpm !== null || fromName.key !== null) ? 'filename' : null;
    return { bpm, key, from };
}

function roleFromName(name) {
    for (const token of stemOf(name).toLowerCase().split(/[\s_\-.]+/)) {
        if (ROLE_WORDS[token]) return ROLE_WORDS[token];
    }
    return '';
}

function encoder() {
    const r = resolveFfmpeg();
    if (!r || !r.available) return { ok: false, error: `no encoder available to inspect audio: ${r && r.reason ? r.reason : 'ffmpeg not found'}` };
    return { ok: true, bin: r.bin };
}

/**
 * What a stem file actually IS, read from the file.
 *
 * `ffmpeg -i` with no output exits non-zero and still prints the whole
 * analysis to stderr, so stderr is read whatever the exit code — the rule
 * `inspectMedia` already follows.
 */
function inspectStem(filePath, spec) {
    const enc = encoder();
    if (!enc.ok) return enc;
    let text = '';
    try {
        execFileSync(enc.bin, ['-hide_banner', '-i', filePath], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
    } catch (e) {
        text = String((e && e.stderr) || '');
    }
    const line = /Stream #\d+:\d+[^\n]*: Audio: ([^\n]+)/.exec(text);
    if (!line) return { ok: false, error: 'the encoder found no audio stream in it' };
    const p = parseProbe(text);
    const channels = p.channels || (() => {
        const m = /(\d+)\s+channels/.exec(line[1]);
        return m ? Number(m[1]) : null;
    })();
    const tech = {
        duration_ms: p.duration_ms || 0,
        channels,
        channel_layout: p.channel_layout || (channels === 1 ? 'mono' : channels === 2 ? 'stereo' : (channels ? `${channels}ch` : null)),
        sample_rate: p.sample_rate || null,
        sample_fmt: p.sample_fmt || null,
        codec: p.codec || null,
        bitrate_kbps: p.bitrate_kbps || null,
        bit_depth: null,
    };
    tech.bit_depth = bitDepthOf(spec, line[1], tech);
    if (!(tech.duration_ms > 0)) return { ok: false, error: 'the encoder could not measure its length' };
    if (!tech.sample_rate) return { ok: false, error: 'the encoder could not read its sample rate' };
    return { ok: true, tech, text };
}

// ── The import ─────────────────────────────────────────────────────────────

function decodeFile(entry, index) {
    const e = entry || {};
    const name = String(e.name || `stem_${index + 1}`);
    let bytes;
    if (e.bytes) bytes = Buffer.isBuffer(e.bytes) ? e.bytes : Buffer.from(e.bytes);
    else if (typeof e.data === 'string') {
        const m = /^data:([^;,]*);base64,([A-Za-z0-9+/=\s]+)$/.exec(e.data);
        if (!m) return { ok: false, error: `${name}: data must be a base64 data URI` };
        bytes = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
    } else return { ok: false, error: `${name}: no bytes — send \`data\` (a data URI) or \`bytes\`` };
    if (!bytes || !bytes.length) return { ok: false, error: `${name}: the file is empty` };
    const format = detectFormat(bytes);
    if (!format) {
        const names = Object.values(STEM_FORMATS).map(s => s.label).join(', ');
        return { ok: false, error: `${name}: not ${names} (the bytes match none of them)` };
    }
    return { ok: true, name, bytes, format, role: e.role === undefined ? null : String(e.role || ''), declared_mime: e.mime ? String(e.mime) : null };
}

function validateRights(rights) {
    const decl = rights && typeof rights === 'object' ? rights : {};
    const status = decl.status === undefined || decl.status === null || decl.status === '' ? 'unknown' : String(decl.status);
    if (!RIGHTS_STATUSES.includes(status)) {
        return { ok: false, error: `rights.status '${status}' is not one the register knows; it must be one of ${RIGHTS_STATUSES.join(', ')}` };
    }
    const str = v => (v === undefined || v === null ? '' : String(v));
    // What the material IS, as the person importing it says (MUS-022). Never inferred.
    const origin = decl.origin === undefined || decl.origin === null || decl.origin === '' ? 'unknown' : String(decl.origin);
    const ORIGINS = require('./music-rights').ORIGINS;
    if (!ORIGINS.includes(origin)) return { ok: false, error: `rights.origin '${origin}' is not one of ${ORIGINS.join(', ')}` };
    return { ok: true, value: {
        status, origin, owner: str(decl.owner), source: str(decl.source), license_url: str(decl.license_url),
        territory: str(decl.territory) || 'worldwide', expires_on: str(decl.expires_on),
        restrictions: str(decl.restrictions), notes: str(decl.notes),
    } };
}

/** Remove what was written. Never throws: a file already gone is the state wanted. */
function dropFiles(paths) {
    for (const p of paths) { try { fs.unlinkSync(p); } catch (_) { /* already gone */ } }
}

/**
 * Import one or several stems into a session, aligned at `start_ms`.
 *
 * Returns `{ ok: true, operation_id, imported: [...], warnings }` or
 * `{ ok: false, error }`. On refusal NOTHING is written — no rows, no files.
 */
async function importStems(db, sessionId, input) {
    const opts = input || {};
    const session = db.prepare('SELECT * FROM film_music_sessions WHERE id = ?').get(sessionId);
    if (!session) return { ok: false, error: 'Score session not found', status: 404 };

    const list = Array.isArray(opts.files) ? opts.files : [];
    if (!list.length) return { ok: false, error: 'files must be a non-empty list of { name, data | bytes }' };

    const startMs = opts.start_ms === undefined || opts.start_ms === null ? 0 : Number(opts.start_ms);
    if (!Number.isInteger(startMs) || startMs < 0) return { ok: false, error: 'start_ms must be a whole, non-negative number of milliseconds' };
    const normalize = opts.normalize_48k === true || opts.normalize_48k === 1 || opts.normalize_48k === 'true';

    const rights = validateRights(opts.rights);
    if (!rights.ok) return rights;

    // Everything that can be refused without touching the disk is refused first.
    const decoded = [];
    for (let i = 0; i < list.length; i++) {
        const d = decodeFile(list[i], i);
        if (!d.ok) return d;
        decoded.push(d);
    }
    const enc = encoder();
    if (!enc.ok) return enc;

    const kind = MEDIA_KINDS.music;
    const written = [];
    const warnings = [];
    const staged = [];
    try {
        for (const d of decoded) {
            const spec = STEM_FORMATS[d.format];
            const assetId = generateId();
            const base = stemOf(d.name);
            const fileName = `${base}_${assetId.slice(0, 8)}.${spec.ext}`;
            const filePath = saveFile(session.project_id, kind.subdir, fileName, d.bytes);
            written.push(filePath);

            const seen = inspectStem(filePath, spec);
            if (!seen.ok) { dropFiles(written); return { ok: false, error: `${d.name}: ${seen.error}` }; }

            let working = null;
            let note = null;
            if (normalize) {
                if (spec.lossless && seen.tech.sample_rate === NORMALIZE_RATE) {
                    note = `already ${NORMALIZE_RATE / 1000} kHz and lossless: no working copy was made, the original is used as is`;
                } else {
                    const wid = generateId();
                    const wName = `${base}_${wid.slice(0, 8)}_48k.wav`;
                    const wPath = path.join(path.dirname(filePath), wName);
                    try {
                        execFileSync(enc.bin, ['-y', '-loglevel', 'error', '-i', filePath, '-ar', String(NORMALIZE_RATE), '-c:a', 'pcm_s24le', wPath],
                            { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10 * 60 * 1000 });
                    } catch (e) {
                        dropFiles(written);
                        return { ok: false, error: `${d.name}: the 48 kHz working copy could not be written: ${String((e && e.stderr) || e.message || e).trim().split('\n').pop()}` };
                    }
                    written.push(wPath);
                    const wSeen = inspectStem(wPath, STEM_FORMATS.wav);
                    if (!wSeen.ok) { dropFiles(written); return { ok: false, error: `${d.name}: the working copy could not be read back: ${wSeen.error}` }; }
                    working = { id: wid, fileName: wName, filePath: wPath, tech: wSeen.tech, size: fs.statSync(wPath).size };
                }
            }
            staged.push({
                d, spec, assetId, fileName, filePath, tech: seen.tech,
                hash: sha256(d.bytes), hints: hintsFor(d.name, seen.text),
                role: d.role === null ? roleFromName(d.name) : d.role,
                working, note,
            });
        }
    } catch (e) {
        dropFiles(written);
        return { ok: false, error: `import failed before anything was recorded: ${e.message}` };
    }

    const operationId = generateId();
    const imported = [];
    const write = db.transaction(() => {
        const nextOrder = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM film_music_tracks WHERE session_id = ?').get(sessionId).m) + 1;
        const op = VALIDATORS.film_music_operations({
            kind: 'import', status: 'complete',
            params: { files: decoded.map(x => ({ name: x.name, format: x.format })), start_ms: startMs, normalize_48k: normalize },
        });
        if (!op.ok) throw new Error(op.errors.map(e => e.message).join('; '));
        const opRow = toRow('film_music_operations', op.value);
        db.prepare(`INSERT INTO film_music_operations (id, session_id, kind, status, parent_id, source_asset_id, output_asset_id, provider, model, job_ref, params_json, cost_usd, error_message, started_at, completed_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`)
            .run(operationId, sessionId, opRow.kind, opRow.status, opRow.parent_id, opRow.source_asset_id, opRow.output_asset_id,
                opRow.provider, opRow.model, opRow.job_ref, opRow.params_json, opRow.cost_usd, opRow.error_message);

        const insertAsset = db.prepare(`INSERT INTO film_assets (id, project_id, asset_type, file_path, file_name, format, mime_type, size_bytes, duration_ms, metadata, license_source, license_status, rights_notes)
                                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'external', ?, ?)`);
        const insertRights = db.prepare(`INSERT INTO film_rights (id, project_id, entity_type, entity_id, subject, rights_type, status, owner, source, license_url, territory, expires_on, restrictions, notes, origin)
                                         VALUES (?, ?, 'music', ?, ?, 'music_license', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

        staged.forEach((s, i) => {
            const trackId = generateId();
            const clipId = generateId();
            const meta = {
                kind: 'stem_original', session_id: sessionId, operation_id: operationId, track_id: trackId, clip_id: clipId,
                format: s.d.format, lossless: s.spec.lossless, hash: s.hash, original_name: s.d.name,
                declared_mime: s.d.declared_mime, tech: s.tech, hints: s.hints,
            };
            insertAsset.run(s.assetId, session.project_id, kind.assetType, s.filePath, s.fileName, s.spec.ext, s.spec.mime,
                s.d.bytes.length, s.tech.duration_ms, JSON.stringify(meta), rights.value.status, rights.value.notes);
            const rightsId = generateId();
            insertRights.run(rightsId, session.project_id, s.assetId, s.d.name, rights.value.status, rights.value.owner, rights.value.source,
                rights.value.license_url, rights.value.territory, rights.value.expires_on, rights.value.restrictions, rights.value.notes, rights.value.origin);

            let workingId = null;
            if (s.working) {
                workingId = s.working.id;
                const wMeta = {
                    kind: 'stem_working', session_id: sessionId, operation_id: operationId, track_id: trackId, clip_id: clipId,
                    derived_from: s.assetId, resample: { from: s.tech.sample_rate, to: NORMALIZE_RATE },
                    format: 'wav', lossless: true, hash: sha256(fs.readFileSync(s.working.filePath)), tech: s.working.tech,
                };
                insertAsset.run(workingId, session.project_id, kind.assetType, s.working.filePath, s.working.fileName, 'wav', 'audio/wav',
                    s.working.size, s.working.tech.duration_ms, JSON.stringify(wMeta), rights.value.status, rights.value.notes);
            }

            const tv = VALIDATORS.film_music_tracks({ name: stemOf(s.d.name), role_kind: 'instrument', role: s.role, sort_order: nextOrder + i });
            if (!tv.ok) throw new Error(`${s.d.name}: ${tv.errors.map(e => e.message).join('; ')}`);
            const t = toRow('film_music_tracks', tv.value);
            db.prepare(`INSERT INTO film_music_tracks (id, session_id, name, role_kind, role, sort_order, color, gain_db, pan, muted, soloed, output_track_id)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(trackId, sessionId, t.name, t.role_kind, t.role, t.sort_order, t.color, t.gain_db, t.pan, t.muted, t.soloed, t.output_track_id);

            const cv = VALIDATORS.film_music_clips({
                name: stemOf(s.d.name), asset_id: workingId || s.assetId, source_operation_id: operationId, source_kind: 'imported',
                start_ms: startMs, duration_ms: s.tech.duration_ms, source_offset_ms: 0, take_status: 'selected',
            });
            if (!cv.ok) throw new Error(`${s.d.name}: ${cv.errors.map(e => e.message).join('; ')}`);
            const c = toRow('film_music_clips', cv.value);
            db.prepare(`INSERT INTO film_music_clips (id, track_id, asset_id, source_operation_id, name, source_kind, start_ms, duration_ms, source_offset_ms, gain_db, fade_in_ms, fade_out_ms, loop_policy, warp_policy, take_group, take_status)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(clipId, trackId, c.asset_id, c.source_operation_id, c.name, c.source_kind, c.start_ms, c.duration_ms, c.source_offset_ms,
                    c.gain_db, c.fade_in_ms, c.fade_out_ms, c.loop_policy, c.warp_policy, c.take_group, c.take_status);

            imported.push({
                name: s.d.name, format: s.d.format, lossless: s.spec.lossless,
                asset_id: s.assetId, working_asset_id: workingId, track_id: trackId, clip_id: clipId, rights_id: rightsId,
                url: getFileUrl(kind.serveDir, session.project_id, s.fileName),
                working_url: s.working ? getFileUrl(kind.serveDir, session.project_id, s.working.fileName) : null,
                hash: s.hash, tech: s.tech, hints: s.hints, role: s.role, start_ms: startMs,
                normalized_note: s.note,
            });
        });
    });
    try { write(); } catch (e) {
        dropFiles(written);
        return { ok: false, error: `nothing was recorded: ${e.message}` };
    }

    const lengths = new Set(staged.map(s => s.tech.duration_ms));
    if (lengths.size > 1) {
        const spread = Math.max(...lengths) - Math.min(...lengths);
        warnings.push(`the stems are not all the same length (they differ by ${spread} ms); aligned stems from one bounce normally are, so check that none was trimmed before export`);
    }
    return { ok: true, operation_id: operationId, session_id: sessionId, start_ms: startMs, imported, warnings };
}

module.exports = {
    STEM_FORMATS, RIGHTS_STATUSES, ROLE_WORDS, NORMALIZE_RATE,
    detectFormat, inspectStem, hintsFor, hintsFromName, normaliseKey, roleFromName, stemOf, importStems,
};
